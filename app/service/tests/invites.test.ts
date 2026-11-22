import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { createInvite, hashInviteCode, listInvites, revokeInvite } from "../src/auth/invites.ts";
import { api, signUp } from "./helpers/actors.ts";
import { testDatabaseUrl } from "./helpers/env.ts";
import { useApp } from "./helpers/harness.ts";

const PASSWORD = "correct horse battery";
const CREATED = { status: 201, json: { ok: true } };
const REFUSED = { status: 400, json: { error: "invalid_invite" } };

const tsx = createRequire(import.meta.url).resolve("tsx/cli");
const cwd = fileURLToPath(new URL("..", import.meta.url));
/** Runs the CLI as a process; resolves with its exit code and output instead of rejecting. */
async function cli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = {
    ...process.env,
    DATABASE_URL: testDatabaseUrl(),
    APP_ORIGIN: "http://localhost:5173",
    AUTH_SECRET: "test-secret-test-secret-test-secret-0000",
    PROVIDER_KEY_SECRET: "test-provider-key-secret-0000000000",
    AGENT_TIERS: JSON.stringify({ free: 20, plus: 50 }),
  };
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [tsx, "src/cli.ts", ...args], { cwd, env });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

describe("invite codes good for several sign-ups", () => {
  const { app, db } = useApp();

  const register = (inviteCode: string, n: number | string, extra: Record<string, unknown> = {}) =>
    api(app, null, "POST", "/api/register", {
      inviteCode, email: `iv${n}@example.test`, password: PASSWORD, displayName: "Guest", handle: `iv_${n}`, ...extra,
    });
  const row = async (code: string) =>
    (
      await db.query<{ uses: number; maxUses: number; usedBy: string | null; usedAt: Date | null; revokedAt: Date | null }>(
        `select uses, max_uses as "maxUses", used_by as "usedBy", used_at as "usedAt", revoked_at as "revokedAt" from invites where code_hash = $1`,
        [hashInviteCode(code)],
      )
    ).rows[0]!;
  const principals = async (code: string) =>
    (
      await db.query<{ id: string | null }>("select principal_id as id from invite_uses where code_hash = $1 order by id", [
        hashInviteCode(code),
      ])
    ).rows.map((r) => r.id);
  const accounts = async (n: string | number) =>
    Number((await db.query<{ n: string }>(`select count(*) n from "user" where email = $1`, [`iv${n}@example.test`])).rows[0]!.n);

  test("a single-use code (no --uses) works as before: one account, then refused", async () => {
    const code = await createInvite(db, { ttlHours: 1 });
    expect(await register(code, 1)).toEqual(CREATED);
    expect(await register(code, 2)).toEqual(REFUSED);
    const r = await row(code);
    expect(r).toMatchObject({ uses: 1, maxUses: 1 });
    expect(r.usedBy).not.toBeNull();
    expect(r.usedAt).not.toBeNull();
    expect(await accounts(2)).toBe(0);
  });

  test("a code for N sign-ups admits exactly N (N crosses 10), records each account, then refuses", async () => {
    const code = await createInvite(db, { ttlHours: 1, uses: 12 });
    for (let i = 1; i <= 12; i++) expect(await register(code, `a${i}`)).toEqual(CREATED);
    expect(await register(code, "a13")).toEqual(REFUSED);
    expect(await register(code, "a14")).toEqual(REFUSED);
    expect(await row(code)).toMatchObject({ uses: 12, maxUses: 12 });
    const ids = await principals(code);
    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(12);
    expect(ids.every((id) => id !== null)).toBe(true);
    expect(await accounts("a13")).toBe(0);
  });

  test("uses outside 1..1000 (or not whole) are refused when creating; the bounds themselves are fine", async () => {
    for (const uses of [0, -1, 1001, 1.5, Number.NaN]) {
      await expect(createInvite(db, { ttlHours: 1, uses })).rejects.toThrow(/uses/);
    }
    await createInvite(db, { ttlHours: 1, uses: 1 });
    const code = await createInvite(db, { ttlHours: 1, uses: 1000 });
    expect((await row(code)).maxUses).toBe(1000);
  });

  test("two sign-ups racing for the last use: exactly one account, the other gets the used-up refusal", async () => {
    for (let round = 0; round < 4; round++) {
      const code = await createInvite(db, { ttlHours: 1, uses: 3 });
      expect(await register(code, `r${round}_0`)).toEqual(CREATED);
      expect(await register(code, `r${round}_1`)).toEqual(CREATED);
      const results = await Promise.all([register(code, `r${round}_2`), register(code, `r${round}_3`)]);
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 400)).toEqual([REFUSED]);
      expect(await row(code)).toMatchObject({ uses: 3, maxUses: 3 });
      expect(await principals(code)).toHaveLength(3);
    }
  });

  test("many racing for a many-use code never admit more than its uses", async () => {
    const code = await createInvite(db, { ttlHours: 1, uses: 4 });
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => register(code, `m${i}`)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(4);
    for (const r of results) expect([201, 400]).toContain(r.status);
    expect((await row(code)).uses).toBe(4);
    expect(await principals(code)).toHaveLength(4);
  });

  test("a sign-up that fails consumes nothing: a taken handle, a short password, a malformed handle", async () => {
    const owner = await signUp(app, "iv_owner");
    const code = await createInvite(db, { ttlHours: 1, uses: 2 });
    expect(await register(code, "f1", { handle: owner.handle })).toEqual({ status: 409, json: { error: "handle_taken" } });
    expect((await register(code, "f2", { password: "x" })).status).toBe(400);
    expect((await register(code, "f3", { handle: "!!" })).status).toBe(400);
    expect(await row(code)).toMatchObject({ uses: 0, usedBy: null, usedAt: null });
    expect(await principals(code)).toEqual([]);
    expect(await register(code, "g1")).toEqual(CREATED);
    expect(await register(code, "g2")).toEqual(CREATED);
    expect(await register(code, "g3")).toEqual(REFUSED);
  });

  test("an expired code is refused as a whole, even with uses left", async () => {
    const code = await createInvite(db, { ttlHours: 1, uses: 5 });
    await db.query("update invites set expires_at = now() - interval '1 second' where code_hash = $1", [hashInviteCode(code)]);
    expect(await register(code, "e1")).toEqual(REFUSED);
    expect((await row(code)).uses).toBe(0);
  });

  test("a code from before the migration still works: an unused one admits one, a used-up one stays used up", async () => {
    // Rows as the old schema left them (the migration gave them uses 0/1 by used_at, one use at most).
    const fresh = await createInvite(db, { ttlHours: 1 });
    expect(await register(fresh, "o1")).toEqual(CREATED);
    expect(await register(fresh, "o2")).toEqual(REFUSED);
    const person = await signUp(app, "iv_old");
    const old = await createInvite(db, { ttlHours: 1 });
    await db.query(
      "update invites set used_by = (select id from principals where handle = $2), used_at = now(), uses = 1 where code_hash = $1",
      [hashInviteCode(old), person.handle],
    );
    expect(await register(old, "o3")).toEqual(REFUSED);
  });

  test("the migration backfill: a row used before it counts one use", async () => {
    const { rows } = await db.query<{ n: string }>("select count(*) n from invites where used_at is not null and uses = 0");
    expect(Number(rows[0]!.n)).toBe(0);
    // And the migration's own statement, on a row shaped like an old used one.
    const code = await createInvite(db, { ttlHours: 1 });
    await db.query("update invites set used_at = now(), uses = 0 where code_hash = $1", [hashInviteCode(code)]);
    await db.query("update invites set uses = 1 where used_at is not null and uses = 0");
    expect((await row(code)).uses).toBe(1);
    expect(await register(code, "b1")).toEqual(REFUSED);
  });

  test("revoke: no further sign-ups; accounts already made stay; list shows it", async () => {
    const code = await createInvite(db, { ttlHours: 1, uses: 5 });
    expect(await register(code, "v1")).toEqual(CREATED);
    const prefix = hashInviteCode(code).slice(0, 8);
    expect(await revokeInvite(db, prefix)).toEqual({ ok: true, hashPrefix: prefix });
    expect(await register(code, "v2")).toEqual(REFUSED);
    expect(await accounts("v1")).toBe(1);
    expect(await accounts("v2")).toBe(0);
    expect((await row(code)).revokedAt).not.toBeNull();
    expect((await row(code)).uses).toBe(1);
    expect((await listInvites(db)).find((i) => hashInviteCode(code).startsWith(i.hashPrefix))).toMatchObject({
      uses: 1, maxUses: 5, revoked: true,
    });
  });

  test("revoke refuses an ambiguous, an unknown and a too-short prefix, and touches nothing", async () => {
    const a = await createInvite(db, { ttlHours: 1 });
    const b = await createInvite(db, { ttlHours: 1 });
    await db.query("update invites set code_hash = 'abcdef0123' || substr(code_hash, 11) where code_hash = $1", [hashInviteCode(a)]);
    await db.query("update invites set code_hash = 'abcdef0124' || substr(code_hash, 11) where code_hash = $1", [hashInviteCode(b)]);
    expect(await revokeInvite(db, "abcdef012")).toEqual({ ok: false, reason: "ambiguous" });
    expect(await revokeInvite(db, "ffffffffff")).toEqual({ ok: false, reason: "not_found" });
    expect(await revokeInvite(db, "abc")).toEqual({ ok: false, reason: "bad_prefix" });
    expect(await revokeInvite(db, "xyz-not-hex")).toEqual({ ok: false, reason: "bad_prefix" });
    expect((await db.query("select 1 from invites where revoked_at is not null")).rowCount).toBe(0);
    expect(await revokeInvite(db, "abcdef0124")).toMatchObject({ ok: true });
  });

  test("list never holds a code: rows carry a hash prefix, counts, expiry and creation only", async () => {
    const code = await createInvite(db, { ttlHours: 1, uses: 100 });
    const rows = await listInvites(db);
    const mine = rows.find((r) => hashInviteCode(code).startsWith(r.hashPrefix))!;
    expect(mine).toMatchObject({ uses: 0, maxUses: 100, revoked: false });
    expect(mine.hashPrefix.length).toBeLessThan(hashInviteCode(code).length);
    expect(Object.keys(mine).sort()).toEqual(["createdAt", "expiresAt", "hashPrefix", "maxUses", "revoked", "uses"]);
    expect(JSON.stringify(rows)).not.toContain(code);
    expect(JSON.stringify(rows)).not.toContain(hashInviteCode(code));
  });

  test("the commands: create --uses prints the code once; list and revoke by prefix; bad input refused", async () => {
    const made = await cli("invite:create", "--uses", "100", "--ttl-hours", "5");
    expect(made.stderr.slice(0, 400)).toBe("");
    expect(made.code).toBe(0);
    const code = made.stdout.trim();
    expect(code).toMatch(/^[A-Za-z0-9_-]{20}$/);
    expect((await row(code)).maxUses).toBe(100);

    const list = await cli("invite:list");
    expect(list.code).toBe(0);
    expect(list.stdout).toContain(hashInviteCode(code).slice(0, 8));
    expect(list.stdout).toContain("0/100");
    expect(list.stdout).not.toContain(code);
    expect(list.stdout).not.toContain(hashInviteCode(code));

    for (const bad of ["0", "1001", "abc", "2.5"]) {
      const r = await cli("invite:create", "--uses", bad);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("--uses");
    }

    const revoked = await cli("invite:revoke", "--prefix", hashInviteCode(code).slice(0, 8));
    expect(revoked.code).toBe(0);
    expect(revoked.stdout + revoked.stderr).not.toContain(code);
    expect((await row(code)).revokedAt).not.toBeNull();
    const missing = await cli("invite:revoke", "--prefix", "ffffffffff");
    expect(missing.code).not.toBe(0);
    expect((await cli("invite:revoke")).code).not.toBe(0);
  }, 120_000);
});
