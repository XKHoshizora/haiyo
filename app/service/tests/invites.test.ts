import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { createInvite, hashInviteCode, listInvites, revokeInvite, sweepExpiredSignups } from "../src/auth/invites.ts";
import { api, mailLink, signUp } from "./helpers/actors.ts";
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

  /** Follows the newest verification mail of `n`'s e-mail; the answer's status and where it redirects. */
  const verify = async (n: string | number) => {
    const res = await app.inject({ method: "GET", url: await mailLink(app, `iv${n}@example.test`, "verify_email") });
    return { status: res.statusCode, to: String(res.headers.location ?? "") };
  };
  const OK = (to: string) => !to.includes("error=");
  const verified = async (n: string | number) =>
    (await db.query<{ v: boolean }>(`select "emailVerified" v from "user" where email = $1`, [`iv${n}@example.test`])).rows[0]?.v;
  const pendingCount = async (code: string) =>
    Number((await db.query<{ n: string }>("select count(*) n from pending_invites where code_hash = $1", [hashInviteCode(code)])).rows[0]!.n);
  /** Signs up and verifies one person; returns the verification answer. */
  const join = async (code: string, n: string | number) => {
    expect(await register(code, n)).toEqual(CREATED);
    return verify(n);
  };

  test("a single-use code (no --uses) works as before: one account, then refused", async () => {
    const code = await createInvite(db, { ttlHours: 1 });
    expect(OK((await join(code, 1)).to)).toBe(true);
    expect(await register(code, 2)).toEqual(REFUSED);
    const r = await row(code);
    expect(r).toMatchObject({ uses: 1, maxUses: 1 });
    expect(r.usedBy).not.toBeNull();
    expect(r.usedAt).not.toBeNull();
    expect(await accounts(2)).toBe(0);
  });

  test("a code for N sign-ups admits exactly N (N crosses 10), records each account, then refuses", async () => {
    const code = await createInvite(db, { ttlHours: 1, uses: 12 });
    for (let i = 1; i <= 12; i++) expect(OK((await join(code, `a${i}`)).to)).toBe(true);
    expect(await register(code, "a13")).toEqual(REFUSED);
    expect(await register(code, "a14")).toEqual(REFUSED);
    expect(await row(code)).toMatchObject({ uses: 12, maxUses: 12 });
    const ids = await principals(code);
    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(12);
    expect(ids.every((id) => id !== null)).toBe(true);
    expect(await accounts("a13")).toBe(0);
    expect(await pendingCount(code)).toBe(0);
  });

  test("uses outside 1..1000 (or not whole) are refused when creating; the bounds themselves are fine", async () => {
    for (const uses of [0, -1, 1001, 1.5, Number.NaN]) {
      await expect(createInvite(db, { ttlHours: 1, uses })).rejects.toThrow(/uses/);
    }
    await createInvite(db, { ttlHours: 1, uses: 1 });
    const code = await createInvite(db, { ttlHours: 1, uses: 1000 });
    expect((await row(code)).maxUses).toBe(1000);
  });

  test("a sign-up takes nothing and holds nothing: only a pending note; the use is taken at verification", async () => {
    const code = await createInvite(db, { ttlHours: 1, uses: 2 });
    expect(await register(code, "p1")).toEqual(CREATED);
    expect(await row(code)).toMatchObject({ uses: 0, usedBy: null, usedAt: null });
    expect(await principals(code)).toEqual([]);
    expect(await pendingCount(code)).toBe(1);
    expect(OK((await verify("p1")).to)).toBe(true);
    expect(await row(code)).toMatchObject({ uses: 1 });
    expect(await principals(code)).toHaveLength(1);
    expect(await pendingCount(code)).toBe(0);
  });

  test("two verifications racing for the last use: exactly one account becomes real, the other is refused and stays unverified", async () => {
    for (let round = 0; round < 3; round++) {
      const code = await createInvite(db, { ttlHours: 1, uses: 3 });
      for (const k of [0, 1, 2, 3]) expect(await register(code, `r${round}_${k}`)).toEqual(CREATED);
      expect(OK((await verify(`r${round}_0`)).to)).toBe(true);
      expect(OK((await verify(`r${round}_1`)).to)).toBe(true);
      const results = await Promise.all([verify(`r${round}_2`), verify(`r${round}_3`)]);
      expect(results.filter((r) => OK(r.to))).toHaveLength(1);
      const loser = results.findIndex((r) => !OK(r.to));
      expect(results[loser]!.to).toContain("error=INVITE_USED_UP");
      expect(await row(code)).toMatchObject({ uses: 3, maxUses: 3 });
      expect(await principals(code)).toHaveLength(3);
      expect(await verified(`r${round}_${2 + loser}`)).toBe(false);
      expect(await pendingCount(code)).toBe(1);
    }
  });

  test("a burst of 20 verifications on a pool of 10 connections for a code with 5 uses: exactly 5 succeed, all answer, none times out", async () => {
    // Twenty sign-ups would not fit under the cap of a 5-use code: made on a 20-use one, narrowed to 5 before the links.
    const code = await createInvite(db, { ttlHours: 1, uses: 20 });
    for (let i = 0; i < 20; i++) expect(await register(code, `b${i}`)).toEqual(CREATED);
    await db.query("update invites set max_uses = 5 where code_hash = $1", [hashInviteCode(code)]);
    const started = Date.now();
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => verify(`b${i}`)));
    expect(results.map((r) => r.status)).toEqual(Array(20).fill(302));
    expect(results.filter((r) => OK(r.to))).toHaveLength(5);
    expect(results.filter((r) => r.to.includes("error=INVITE_USED_UP"))).toHaveLength(15);
    expect(Date.now() - started).toBeLessThan(25_000);
    expect(await row(code)).toMatchObject({ uses: 5 });
    expect(await principals(code)).toHaveLength(5);
  }, 120_000);

  test("a sign-up that fails creates nothing and notes nothing: a taken handle, a short password, a malformed handle", async () => {
    const owner = await signUp(app, "iv_owner");
    const code = await createInvite(db, { ttlHours: 1, uses: 2 });
    expect(await register(code, "f1", { handle: owner.handle })).toEqual({ status: 409, json: { error: "handle_taken" } });
    expect((await register(code, "f2", { password: "x" })).status).toBe(400);
    expect((await register(code, "f3", { handle: "!!" })).status).toBe(400);
    expect(await row(code)).toMatchObject({ uses: 0, usedBy: null, usedAt: null });
    expect(await pendingCount(code)).toBe(0);
    expect(OK((await join(code, "g1")).to)).toBe(true);
    expect(OK((await join(code, "g2")).to)).toBe(true);
    expect(await register(code, "g3")).toEqual(REFUSED);
  });

  test("a sign-up on an already verified e-mail takes nothing, notes nothing, and answers as ever", async () => {
    const owner = await signUp(app, "iv_dup");
    const code = await createInvite(db, { ttlHours: 1, uses: 3 });
    for (let i = 0; i < 4; i++) {
      const body = { inviteCode: code, email: owner.email, password: PASSWORD, displayName: "X", handle: `dup_${i}` };
      expect(await api(app, null, "POST", "/api/register", body)).toEqual(CREATED);
    }
    expect(await row(code)).toMatchObject({ uses: 0, usedBy: null });
    expect(await pendingCount(code)).toBe(0);
    // The code is whole: three others still come in.
    for (let i = 0; i < 3; i++) expect(OK((await join(code, `d${i}`)).to)).toBe(true);
    expect(await register(code, "d3")).toEqual(REFUSED);
  });

  test("an abandoned sign-up takes nothing; a re-registration of the same unverified e-mail takes nothing more", async () => {
    const code = await createInvite(db, { ttlHours: 1, uses: 1 });
    expect(await register(code, "x1")).toEqual(CREATED);
    expect(await row(code)).toMatchObject({ uses: 0 });
    // The same address again (a typo fixed, a new handle): the old account is replaced; one note remains.
    expect(await register(code, "x1", { handle: "iv_x1_again" })).toEqual(CREATED);
    expect(await pendingCount(code)).toBe(1);
    expect(await row(code)).toMatchObject({ uses: 0 });
    expect(await register(code, "x2")).toEqual(CREATED);
    expect(OK((await verify("x1")).to)).toBe(true);
    expect(await row(code)).toMatchObject({ uses: 1 });
    // The single use is gone: the other pending sign-up is refused at verification, and stays unverified.
    expect((await verify("x2")).to).toContain("error=INVITE_USED_UP");
    expect(await verified("x2")).toBe(false);
  });

  test("a code revoked between sign-up and verification refuses the verification; accounts made stay", async () => {
    const code = await createInvite(db, { ttlHours: 1, uses: 5 });
    expect(OK((await join(code, "v1")).to)).toBe(true);
    expect(await register(code, "v2")).toEqual(CREATED);
    expect(await revokeInvite(db, hashInviteCode(code).slice(0, 8))).toMatchObject({ ok: true });
    expect((await verify("v2")).to).toContain("error=INVITE_USED_UP");
    expect(await verified("v2")).toBe(false);
    expect(await verified("v1")).toBe(true);
    expect(await register(code, "v3")).toEqual(REFUSED);
    expect((await row(code)).uses).toBe(1);
    expect((await listInvites(db)).find((i) => hashInviteCode(code).startsWith(i.hashPrefix))).toMatchObject({
      uses: 1, maxUses: 5, revoked: true,
    });
  });

  test("an expired code is refused at sign-up as a whole; one that expires after sign-up still verifies", async () => {
    const code = await createInvite(db, { ttlHours: 1, uses: 5 });
    expect(await register(code, "e0")).toEqual(CREATED);
    await db.query("update invites set expires_at = now() - interval '1 second' where code_hash = $1", [hashInviteCode(code)]);
    expect(await register(code, "e1")).toEqual(REFUSED);
    expect(OK((await verify("e0")).to)).toBe(true);
    expect((await row(code)).uses).toBe(1);
  });

  test("a code from before the migration still works: an unused one admits one, a used-up one stays used up", async () => {
    const fresh = await createInvite(db, { ttlHours: 1 });
    expect(OK((await join(fresh, "o1")).to)).toBe(true);
    expect(await register(fresh, "o2")).toEqual(REFUSED);
    const person = await signUp(app, "iv_old");
    const old = await createInvite(db, { ttlHours: 1 });
    await db.query(
      "update invites set used_by = (select id from principals where handle = $2), used_at = now(), uses = 1 where code_hash = $1",
      [hashInviteCode(old), person.handle],
    );
    expect(await register(old, "o3")).toEqual(REFUSED);
  });

  test("the migration backfill: a row used before it counts one use, and running it again changes nothing", async () => {
    const code = await createInvite(db, { ttlHours: 3, uses: 1 });
    await db.query("update invites set used_at = now(), uses = 0 where code_hash = $1", [hashInviteCode(code)]);
    const backfill = "update invites set uses = 1 where used_at is not null and uses = 0";
    await db.query(backfill);
    expect((await row(code)).uses).toBe(1);
    await db.query(backfill);
    expect((await row(code)).uses).toBe(1);
    expect(await register(code, "b1x")).toEqual(REFUSED);
  });

  test("deleting an account keeps its use counted; the identity goes with it (no restrict blocks the deletion)", async () => {
    const code = await createInvite(db, { ttlHours: 1, uses: 2 });
    expect(OK((await join(code, "k1")).to)).toBe(true);
    expect(OK((await join(code, "k2")).to)).toBe(true);
    const ids = await principals(code);
    await db.query("delete from principals where id = $1", [ids[0]]);
    await db.query("delete from principals where id = $1", [ids[1]]);
    expect(await row(code)).toMatchObject({ uses: 2, usedBy: null });
    expect(await principals(code)).toEqual([null, null]);
    expect(await register(code, "k3")).toEqual(REFUSED);
  });


  /** How many sign-ups of this code are waiting for their link. */
  const waiting = async (code: string) =>
    Number((await db.query<{ n: string }>("select count(*) n from pending_invites where code_hash = $1", [hashInviteCode(code)])).rows[0]!.n);

  test("pending sign-ups per code are capped at 2 x the uses left + 5: a single-use code takes 7, the 8th gets the usual refusal", async () => {
    const code = await createInvite(db, { ttlHours: 1 });
    for (let i = 0; i < 7; i++) expect(await register(code, `c${i}`)).toEqual(CREATED);
    expect(await register(code, "c7")).toEqual(REFUSED);
    expect(await accounts("c7")).toBe(0);
    expect(await waiting(code)).toBe(7);
    expect((await db.query("select 1 from mail_outbox where recipient = $1", ["iv" + "c7@example.test"])).rowCount).toBe(0);
  });

  test("the cap follows the uses left: a verification shrinks it", async () => {
    const code = await createInvite(db, { ttlHours: 1, uses: 2 });
    for (let i = 0; i < 9; i++) expect(await register(code, `s${i}`)).toEqual(CREATED);
    expect(await register(code, "s9")).toEqual(REFUSED);
    expect(OK((await verify("s0")).to)).toBe(true);
    // One use left: the cap is 2 x 1 + 5 = 7, and 8 are waiting.
    expect(await waiting(code)).toBe(8);
    expect(await register(code, "s10")).toEqual(REFUSED);
    // Verifications and removals bring the waiting below the cap again.
    expect(await db.query("delete from pending_invites where principal_id in (select principal_id from pending_invites where code_hash = $1 limit 2)", [hashInviteCode(code)])).toBeTruthy();
    expect(await register(code, "s11")).toEqual(CREATED);
  });

  test("a sign-up whose link has expired no longer holds a slot; the cap is not a second lifetime", async () => {
    const code = await createInvite(db, { ttlHours: 1 });
    for (let i = 0; i < 7; i++) expect(await register(code, `x${i}`)).toEqual(CREATED);
    expect(await register(code, "x7")).toEqual(REFUSED);
    await db.query("update pending_invites set created_at = now() - interval '25 hours' where principal_id in (select principal_id from pending_invites where code_hash = $1 limit 3)", [hashInviteCode(code)]);
    expect(await register(code, "x8")).toEqual(CREATED);
    expect(await register(code, "x9")).toEqual(CREATED);
    expect(await register(code, "x10")).toEqual(CREATED);
    expect(await register(code, "x11")).toEqual(REFUSED);
  });

  test("a verified sign-up on an address with an account takes no slot and mails at most one notice an hour", async () => {
    const owner = await signUp(app, "iv_slot");
    const code = await createInvite(db, { ttlHours: 1 });
    for (let i = 0; i < 12; i++) {
      const body = { inviteCode: code, email: owner.email, password: PASSWORD, displayName: "X", handle: `slot_${i}` };
      expect(await api(app, null, "POST", "/api/register", body)).toEqual(CREATED);
    }
    expect(await waiting(code)).toBe(0);
    const notices = await db.query("select 1 from mail_outbox where kind = 'registration_attempt' and recipient = $1", [owner.email]);
    expect(notices.rowCount).toBe(1);
  });

  test("the sweep removes unverified accounts whose link has expired, with their notes, and nothing else", async () => {
    const code = await createInvite(db, { ttlHours: 1, uses: 20 });
    // Old and unverified, with a note: removed.  Young and unverified: kept.  Verified: kept.
    // Unverified with no note (made before this feature): kept.  Old but with something a signed-in person makes: kept.
    for (const n of ["w_old1", "w_old2", "w_young", "w_traced"]) expect(await register(code, n)).toEqual(CREATED);
    expect(OK((await join(code, "w_verified")).to)).toBe(true);
    const keeper = await signUp(app, "iv_sweep_friend");
    const idOf = async (n: string) =>
      (await db.query<{ id: string }>(`select p.id from principals p join "user" u on u.id = p.auth_user_id where u.email = $1`, [`iv${n}@example.test`])).rows[0]!.id;
    expect(await register(code, "w_nonote")).toEqual(CREATED);
    await db.query("delete from pending_invites where principal_id = $1", [await idOf("w_nonote")]);
    await db.query("insert into friendships (a_id, b_id) values (least($1::uuid, $2::uuid), greatest($1::uuid, $2::uuid))", [await idOf("w_traced"), keeper.id]);
    for (const n of ["w_old1", "w_old2", "w_traced", "w_nonote", "w_verified"]) {
      // An old note; the verified account has none left, so this does nothing to it (nor must the sweep).
      await db.query("update pending_invites set created_at = now() - interval '25 hours' where principal_id = $1", [await idOf(n)]);
    }
    await db.query(`update "user" set "createdAt" = now() - interval '25 hours' where email = $1`, ["iv" + "w_nonote@example.test"]);
    const removed = await sweepExpiredSignups(db, { limit: 100 });
    expect(removed).toBe(2);
    expect(await accounts("w_old1")).toBe(0);
    expect(await accounts("w_old2")).toBe(0);
    for (const n of ["w_young", "w_traced", "w_nonote", "w_verified"]) expect([n, await accounts(n)]).toEqual([n, 1]);
    expect(await verified("w_verified")).toBe(true);
    // Their handles are free again, and the code's notes of the removed are gone.
    expect(await register(code, "w_new", { handle: "iv_w_old1" })).toEqual(CREATED);
    expect(await waiting(code)).toBe(3);
    // Nothing more to remove; a bound stops a run early.
    expect(await sweepExpiredSignups(db, { limit: 100 })).toBe(0);
  });

  test("the sweep is bounded per run", async () => {
    const code = await createInvite(db, { ttlHours: 1, uses: 20 });
    for (let i = 0; i < 5; i++) expect(await register(code, `z${i}`)).toEqual(CREATED);
    await db.query("update pending_invites set created_at = now() - interval '25 hours'");
    expect(await sweepExpiredSignups(db, { limit: 2 })).toBe(2);
    expect(await waiting(code)).toBe(3);
    expect(await sweepExpiredSignups(db, { limit: 2 })).toBe(2);
    expect(await sweepExpiredSignups(db, { limit: 2 })).toBe(1);
    expect(await waiting(code)).toBe(0);
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
