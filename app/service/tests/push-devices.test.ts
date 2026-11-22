import type { FastifyBaseLogger } from "fastify";
import { describe, expect, test } from "vitest";
import { createConversationEvents } from "../src/conversations/events.ts";
import { registerDevice } from "../src/push/devices.ts";
import { createNotifier } from "../src/push/notify.ts";
import { api, cookieHeaderFrom, mailLink, signIn, signUp, type Actor } from "./helpers/actors.ts";
import { useApp } from "./helpers/harness.ts";

/**
 * The device registry (src/push/devices.ts, src/push/routes.ts): `POST /api/push/devices` binds the phone's APNs token to
 * the caller's session, `DELETE /api/push/devices/current` unbinds it. A row belongs to its session (sign-out and a
 * revoked session take it away) and the token names the phone, not the person (another account's registration moves it).
 */

const { app, db } = useApp();

const TOKEN_A = "a1".repeat(32);
const TOKEN_B = "b2".repeat(32);

async function sessionOf(actor: Actor, cookie = actor.cookie): Promise<string> {
  // The caller's session id, as the service resolves it (the ticket route hands out tickets bound to it).
  const { rows } = await db.query<{ id: string }>(
    `select s.id from "session" s join principals p on p.auth_user_id = s."userId" where p.id = $1 order by s."createdAt" desc`,
    [actor.id],
  );
  if (rows.length === 1) return rows[0]!.id;
  // Several sessions: the one whose token the cookie carries.
  const token = decodeURIComponent(cookie.split("=")[1]!.split(";")[0]!).split(".")[0]!;
  const { rows: one } = await db.query<{ id: string }>(`select id from "session" where token = $1`, [token]);
  return one[0]!.id;
}

const devices = async () =>
  (await db.query<{ principal_id: string; session_id: string; token: string; env: string; app_version: string | null }>("select principal_id, session_id, token, env, app_version from push_devices order by token")).rows;

describe("POST /api/push/devices", () => {
  test("binds the token to the caller's session: 200, one row with the person, the session, the token, env and version", async () => {
    const a = await signUp(app, "phone_owner");
    const r = await api(app, a, "POST", "/api/push/devices", { token: TOKEN_A, env: "production", appVersion: "1.0 (7)" });
    expect(r).toEqual({ status: 200, json: { ok: true } });
    expect(await devices()).toEqual([{ principal_id: a.id, session_id: await sessionOf(a), token: TOKEN_A, env: "production", app_version: "1.0 (7)" }]);
  });

  test("without a session: 401, nothing stored", async () => {
    expect(await api(app, null, "POST", "/api/push/devices", { token: TOKEN_A, env: "production" })).toEqual({ status: 401, json: { error: "unauthenticated" } });
    expect(await devices()).toEqual([]);
  });

  test("a token in capitals is stored in lower case; appVersion may be left out", async () => {
    const a = await signUp(app, "caps");
    expect((await api(app, a, "POST", "/api/push/devices", { token: TOKEN_A.toUpperCase(), env: "sandbox" })).status).toBe(200);
    expect(await devices()).toEqual([expect.objectContaining({ token: TOKEN_A, env: "sandbox", app_version: null })]);
  });

  test("malformed bodies are 400 invalid_request and store nothing", async () => {
    const a = await signUp(app, "malformed");
    for (const body of [
      {},
      { token: TOKEN_A },
      { token: TOKEN_A, env: "development" },
      { token: "zz".repeat(32), env: "production" },
      { token: "a".repeat(63), env: "production" },
      { token: "a1".repeat(31), env: "production" },
      { token: "a1".repeat(101), env: "production" },
      { token: TOKEN_A, env: "production", appVersion: "" },
      { token: TOKEN_A, env: "production", appVersion: "1".repeat(33) },
      { token: TOKEN_A, env: "production", appVersion: "1.0\n2" },
      { token: 5, env: "production" },
    ]) {
      const r = await api(app, a, "POST", "/api/push/devices", body);
      expect([body, r]).toEqual([body, { status: 400, json: { error: "invalid_request" } }]);
    }
    expect(await devices()).toEqual([]);
  });

  test("the same session registering again keeps one row: a new token replaces the old one", async () => {
    const a = await signUp(app, "rotates");
    await api(app, a, "POST", "/api/push/devices", { token: TOKEN_A, env: "production", appVersion: "1.0" });
    await api(app, a, "POST", "/api/push/devices", { token: TOKEN_A, env: "production", appVersion: "1.1" });
    expect(await devices()).toEqual([expect.objectContaining({ token: TOKEN_A, app_version: "1.1" })]);
    await api(app, a, "POST", "/api/push/devices", { token: TOKEN_B, env: "production", appVersion: "1.1" });
    expect(await devices()).toEqual([expect.objectContaining({ principal_id: a.id, token: TOKEN_B })]);
  });

  test("the token names the phone: registered from another account, the row moves to that account and its session", async () => {
    const a = await signUp(app, "first_user");
    const b = await signUp(app, "second_user");
    await api(app, a, "POST", "/api/push/devices", { token: TOKEN_A, env: "production" });
    await api(app, b, "POST", "/api/push/devices", { token: TOKEN_A, env: "sandbox" });
    expect(await devices()).toEqual([{ principal_id: b.id, session_id: await sessionOf(b), token: TOKEN_A, env: "sandbox", app_version: null }]);
  });

  test("two sessions of one person (two phones) keep a row each", async () => {
    const a = await signUp(app, "two_phones");
    const second = { ...a, cookie: cookieHeaderFrom((await signIn(app, a.email, a.password)).headers["set-cookie"]) };
    await api(app, a, "POST", "/api/push/devices", { token: TOKEN_A, env: "production" });
    await api(app, second, "POST", "/api/push/devices", { token: TOKEN_B, env: "production" });
    const rows = await devices();
    expect(rows.map((r) => [r.principal_id, r.token])).toEqual([
      [a.id, TOKEN_A],
      [a.id, TOKEN_B],
    ]);
    expect(new Set(rows.map((r) => r.session_id)).size).toBe(2);
  });
});

describe("registerDevice's failures", () => {
  test("a database refusal is rethrown with its code only: nothing of the row (the token) can reach the error log", async () => {
    const a = await signUp(app, "refused_row");
    const token = "CANARYTOKEN";
    let caught: unknown;
    try {
      // Past the route's schema on purpose: the table's own check refuses it, and Postgres's `detail` would quote the row.
      await registerDevice(db, { principalId: a.id, sessionId: await sessionOf(a), token, env: "production", appVersion: null });
    } catch (err) {
      caught = err;
    }
    expect((caught as { code?: string }).code).toBe("23514");
    expect((caught as { detail?: string }).detail).toBeUndefined();
    expect(JSON.stringify(caught, Object.getOwnPropertyNames(caught))).not.toContain(token);
  });
});

describe("DELETE /api/push/devices/current", () => {
  test("removes the caller's session's row only, and again is the same 200", async () => {
    const a = await signUp(app, "unbinds");
    const second = { ...a, cookie: cookieHeaderFrom((await signIn(app, a.email, a.password)).headers["set-cookie"]) };
    await api(app, a, "POST", "/api/push/devices", { token: TOKEN_A, env: "production" });
    await api(app, second, "POST", "/api/push/devices", { token: TOKEN_B, env: "production" });
    expect(await api(app, a, "DELETE", "/api/push/devices/current")).toEqual({ status: 200, json: { ok: true } });
    expect((await devices()).map((r) => r.token)).toEqual([TOKEN_B]);
    expect(await api(app, a, "DELETE", "/api/push/devices/current")).toEqual({ status: 200, json: { ok: true } });
  });

  test("without a session: 401", async () => {
    expect(await api(app, null, "DELETE", "/api/push/devices/current")).toEqual({ status: 401, json: { error: "unauthenticated" } });
  });
});

describe("a device belongs to its session", () => {
  test("signing out removes it", async () => {
    const a = await signUp(app, "signs_out");
    await api(app, a, "POST", "/api/push/devices", { token: TOKEN_A, env: "production" });
    expect((await api(app, a, "POST", "/api/auth/sign-out", {})).status).toBe(200);
    expect(await devices()).toEqual([]);
  });

  test("a password reset (which revokes every session) removes them all", async () => {
    const a = await signUp(app, "resets");
    const second = { ...a, cookie: cookieHeaderFrom((await signIn(app, a.email, a.password)).headers["set-cookie"]) };
    await api(app, a, "POST", "/api/push/devices", { token: TOKEN_A, env: "production" });
    await api(app, second, "POST", "/api/push/devices", { token: TOKEN_B, env: "production" });
    await api(app, null, "POST", "/api/auth/request-password-reset", { email: a.email });
    const token = new URLSearchParams((await mailLink(app, a.email, "reset_password")).split("?")[1]).get("token")!;
    expect((await api(app, null, "POST", "/api/auth/reset-password", { newPassword: "a brand new password", token })).status).toBe(200);
    expect(await devices()).toEqual([]);
  });

  test("an expired session's phone is deleted on the push's own timer — whatever MEMORY.changesSweepMs says — a live one's kept; the log has a count only", async () => {
    // The harness turns the memory changes' sweep off (changesSweepMs 0): the push sweep must not depend on it.
    expect(app.deps.config.memory.changesSweepMs).toBe(0);
    const a = await signUp(app, "expired_phone");
    const b = await signUp(app, "live_phone");
    await api(app, a, "POST", "/api/push/devices", { token: TOKEN_A, env: "production" });
    await api(app, b, "POST", "/api/push/devices", { token: TOKEN_B, env: "production" });
    await db.query(`update "session" set "expiresAt" = now() - interval '1 second' where id = $1`, [await sessionOf(a)]);
    const lines: Array<Record<string, unknown>> = [];
    const log = { info: (o: Record<string, unknown>) => void lines.push(o), warn: (o: Record<string, unknown>) => void lines.push(o) } as unknown as FastifyBaseLogger;
    // A notifier of its own, its timer shortened (tests only): no APNs, as on a site without the key — phones are still swept.
    const notifier = createNotifier({
      db,
      apns: null,
      presence: { hasSocketFor: () => false, probe: async () => false },
      conversations: createConversationEvents(),
      log,
      missing: [],
      malformed: [],
      links: false,
      everyMs: 50,
    });
    try {
      for (let i = 0; i < 100 && (await devices()).length > 1; i++) await new Promise((r) => setTimeout(r, 20));
      await notifier.idle();
      expect((await devices()).map((r) => r.token)).toEqual([TOKEN_B]);
      expect(lines.filter((l) => l.metric === "push_devices_expired")).toEqual([{ metric: "push_devices_expired", removed: 1 }]);
      expect(JSON.stringify(lines)).not.toContain(TOKEN_A);
    } finally {
      await notifier.close();
    }
  });

  test("both references cascade: the session's end and the person's deletion take the row with them", async () => {
    const { rows } = await db.query<{ column: string; target: string; action: string }>(
      `select a.attname as column, c.confrelid::regclass::text as target, c.confdeltype as action
         from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
        where c.conrelid = 'push_devices'::regclass and c.contype = 'f' order by a.attname`,
    );
    expect(rows).toEqual([
      { column: "principal_id", target: "principals", action: "c" },
      { column: "session_id", target: "session", action: "c" },
    ]);
  });
});
