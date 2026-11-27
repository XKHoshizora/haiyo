import type { FastifyInstance } from "fastify";
import { describe, expect, test, vi } from "vitest";
import { buildApp } from "../src/app.ts";
import { onSessionEnded, runInTransaction, switchablePool } from "../src/auth/auth.ts";
import { createInvite, hashInviteCode } from "../src/auth/invites.ts";
import { api, cookieHeaderFrom, mailLink, signIn, signUp, TERMS } from "./helpers/actors.ts";
import { NO_ANSWER_FLOOR, useApp } from "./helpers/harness.ts";

const PASSWORD = "correct horse battery";

describe("accounts", () => {
  const { app, db } = useApp();

  async function register(body: Record<string, unknown>, target: FastifyInstance = app) {
    return api(target, null, "POST", "/api/register", {
      email: "new@example.test",
      password: PASSWORD,
      displayName: "New Person",
      handle: "new_person",
      ...TERMS,
      ...body,
    });
  }

  const invite = (ttlHours = 1) => createInvite(db, { ttlHours });
  const count = async (sql: string, params: unknown[] = []) =>
    Number((await db.query<{ n: string }>(sql, params)).rows[0]!.n);

  /** Same app wiring, different config; shares the test pool (so closing it leaves the pool open). */
  async function appWith(config: Partial<typeof app.deps.config>): Promise<FastifyInstance> {
    const built = await buildApp({ config: { ...app.deps.config, ...config }, db: app.deps.db }, { answerFloor: NO_ANSWER_FLOOR });
    await built.ready();
    return built;
  }

  test("register sends a verification mail, sign-in is refused until the link is followed, then /api/me works", async () => {
    const code = await invite();
    expect(await register({ inviteCode: code })).toEqual({ status: 201, json: { ok: true } });
    expect(
      await count("select count(*) n from mail_outbox where recipient = 'new@example.test' and kind = 'verify_email'"),
    ).toBe(1);

    const early = await signIn(app, "new@example.test", PASSWORD);
    expect(early.statusCode).toBe(403);
    expect(early.json()).toEqual({ error: "email_not_verified" });
    expect(early.headers["set-cookie"]).toBeUndefined();

    const verify = await app.inject({ method: "GET", url: await mailLink(app, "new@example.test", "verify_email") });
    expect(verify.statusCode).toBeLessThan(400);

    const ok = await signIn(app, "new@example.test", PASSWORD);
    expect(ok.statusCode).toBe(200);
    const me = await api(app, { cookie: cookieHeaderFrom(ok.headers["set-cookie"]) }, "GET", "/api/me");
    expect(me.status).toBe(200);
    expect(me.json).toMatchObject({ handle: "new_person", displayName: "New Person", email: "new@example.test" });
    expect(Object.keys(me.json).sort()).toEqual(["avatarVersion", "displayName", "dream", "email", "handle", "handleChangeAvailableAt", "id", "memoryLanguage", "memoryModel", "memoryModelUsable", "newNotes", "termsAccepted", "termsRequired"]);
    expect(me.json.handleChangeAvailableAt).toBeNull();
    // Registered with the documents in force accepted (tests/terms.test.ts): nothing more to ask.
    expect(me.json.termsAccepted).toBe(true);
  });

  test("the verification link lands on the client's /verify page: success plain, failure with ?error=CODE", async () => {
    await register({ inviteCode: await invite() });
    const link = await mailLink(app, "new@example.test", "verify_email");
    expect(new URL(link, "http://x").searchParams.get("callbackURL")).toBe("http://localhost:5173/verify");

    const bad = await app.inject({ method: "GET", url: link.replace(/token=[^&]+/, "token=garbage") });
    expect(bad.statusCode).toBe(302);
    expect(bad.headers.location).toBe("http://localhost:5173/verify?error=INVALID_TOKEN");

    const good = await app.inject({ method: "GET", url: link });
    expect(good.statusCode).toBe(302);
    expect(good.headers.location).toBe("http://localhost:5173/verify");
  });

  test("register without an invite code is refused", async () => {
    expect(await register({})).toEqual({ status: 400, json: { error: "invalid_invite" } });
  });

  test("register with an unknown invite code is refused", async () => {
    expect(await register({ inviteCode: "does-not-exist-00000" })).toEqual({
      status: 400,
      json: { error: "invalid_invite" },
    });
  });

  test("register with an expired invite code is refused", async () => {
    const code = await invite(-1);
    expect(await register({ inviteCode: code })).toEqual({ status: 400, json: { error: "invalid_invite" } });
  });

  test("register with a used invite code is refused", async () => {
    const code = await invite();
    expect((await register({ inviteCode: code })).status).toBe(201);
    // The use is taken when the account is verified, not at sign-up.
    const early = await register({ inviteCode: code, email: "early@example.test", handle: "early_person" });
    expect(early.status).toBe(201);
    await app.inject({ method: "GET", url: await mailLink(app, "new@example.test", "verify_email") });
    const second = await register({ inviteCode: code, email: "other@example.test", handle: "other_person" });
    expect(second).toEqual({ status: 400, json: { error: "invalid_invite" } });
    expect(await count("select count(*) n from principals")).toBe(2);
  });

  test("invite codes are 20 characters and only their SHA-256 is stored", async () => {
    const code = await invite();
    expect(code).toMatch(/^[A-Za-z0-9_-]{20}$/);
    const { rows } = await db.query("select code_hash from invites");
    expect(rows).toEqual([{ code_hash: hashInviteCode(code) }]);
  });

  test("with REGISTRATION_MODE=open no invite code is needed", async () => {
    const open = await appWith({ registrationMode: "open" });
    try {
      expect((await register({}, open)).status).toBe(201);
    } finally {
      await open.close();
    }
  });

  test("a handle that is already taken is refused with 409 and leaves nothing behind", async () => {
    await signUp(app, "taken_one");
    const code = await invite();
    const res = await register({ inviteCode: code, email: "late@example.test", handle: "taken_one" });
    expect(res).toEqual({ status: 409, json: { error: "handle_taken" } });
    expect(await count(`select count(*) n from "user" where email = 'late@example.test'`)).toBe(0);
    expect(await count("select count(*) n from invites where used_at is null")).toBe(1);
  });

  test("without a usable invite a taken handle is not revealed: invalid_invite either way", async () => {
    await signUp(app, "taken_two");
    for (const inviteCode of [undefined, "does-not-exist-00000"]) {
      for (const handle of ["taken_two", "free_handle"]) {
        expect(await register({ inviteCode, email: "probe@example.test", handle })).toEqual({ status: 400, json: { error: "invalid_invite" } });
      }
    }
  });

  test("a 9 character password is refused", async () => {
    const res = await register({ inviteCode: await invite(), password: "123456789" });
    expect(res).toEqual({ status: 400, json: { error: "invalid_request" } });
    expect(await count(`select count(*) n from "user"`)).toBe(0);
  });

  test("a malformed body is refused with 400 before any handler code runs", async () => {
    expect((await register({ handle: "Not Valid!", inviteCode: await invite() })).status).toBe(400);
    expect((await register({ email: "not-an-email", inviteCode: await invite() })).status).toBe(400);
    expect((await api(app, null, "POST", "/api/register", { handle: "x" })).status).toBe(400);
  });

  test("a taken e-mail gets the same 201 and creates nothing; the invite is untouched (more in registration.test.ts)", async () => {
    const first = await signUp(app, "first_owner");
    const code = await invite();
    const res = await register({ inviteCode: code, email: first.email, handle: "second_try" });
    expect(res).toEqual({ status: 201, json: { ok: true } });
    expect(await count("select count(*) n from principals")).toBe(1);
    expect(await count(`select count(*) n from "user"`)).toBe(1);
    expect(await count("select count(*) n from invites where used_at is null")).toBe(1);
    expect(await register({ inviteCode: code, email: "fresh@example.test", handle: "fresh_one" })).toEqual({ status: 201, json: { ok: true } });
  });

  test("registration is atomic: a failure after the principal is written leaves no user, account, principal, mail or pending note", async () => {
    await db.query(
      "create function test_fail_principal() returns trigger language plpgsql as 'begin raise exception ''boom''; end'",
    );
    // The last write of a registration (the note of the code), after the user, account and principal are in.
    await db.query(
      "create trigger test_fail before insert on pending_invites for each row execute function test_fail_principal()",
    );
    try {
      const code = await invite();
      const res = await register({ inviteCode: code });
      expect(res.status).toBe(500);
    } finally {
      await db.query("drop trigger test_fail on pending_invites");
      await db.query("drop function test_fail_principal()");
    }
    expect(await count(`select count(*) n from "user"`)).toBe(0);
    expect(await count(`select count(*) n from "account"`)).toBe(0);
    expect(await count("select count(*) n from mail_outbox")).toBe(0);
    expect(await count("select count(*) n from principals")).toBe(0);
    expect(await count("select count(*) n from pending_invites")).toBe(0);
    expect(await count("select count(*) n from invites where used_at is null and uses = 0")).toBe(1);
  });

  test("Better Auth's own sign-up endpoint is not reachable (it would bypass invites)", async () => {
    const res = await api(app, null, "POST", "/api/auth/sign-up/email", {
      name: "Sneaky",
      email: "sneaky@example.test",
      password: PASSWORD,
    });
    expect(res).toEqual({ status: 404, json: { error: "not_found" } });
    expect(await count(`select count(*) n from "user"`)).toBe(0);
  });

  test("password reset answers identically for a registered and an unregistered address, and mails only the registered one", async () => {
    const a = await signUp(app, "reset_known");
    const known = await api(app, null, "POST", "/api/auth/request-password-reset", { email: a.email });
    const unknown = await api(app, null, "POST", "/api/auth/request-password-reset", { email: "nobody@example.test" });
    expect(known.status).toBe(200);
    expect(unknown).toEqual(known);
    expect(
      await count("select count(*) n from mail_outbox where kind = 'reset_password' and recipient = $1", [a.email]),
    ).toBe(1);
    expect(await count("select count(*) n from mail_outbox where kind = 'reset_password'")).toBe(1);
  });

  async function resetToken(email: string): Promise<string> {
    const link = await mailLink(app, email, "reset_password");
    return new URLSearchParams(link.split("?")[1]).get("token")!;
  }

  test("a reset link works once, a second use is refused, and the old session is revoked", async () => {
    const a = await signUp(app, "reset_flow");
    expect((await api(app, a, "GET", "/api/me")).status).toBe(200);
    await api(app, null, "POST", "/api/auth/request-password-reset", { email: a.email });
    const token = await resetToken(a.email);

    const newPassword = "an entirely new password";
    const first = await api(app, null, "POST", "/api/auth/reset-password", { newPassword, token });
    expect(first.status).toBe(200);
    const second = await api(app, null, "POST", "/api/auth/reset-password", {
      newPassword: "yet another password",
      token,
    });
    expect(second).toEqual({ status: 400, json: { error: "invalid_token" } });

    expect((await api(app, a, "GET", "/api/me")).status).toBe(401);
    expect((await signIn(app, a.email, a.password)).statusCode).toBe(401);
    expect((await signIn(app, a.email, newPassword)).statusCode).toBe(200);
  });

  /** The tokens of every reset mail to `email`, oldest first. */
  async function resetTokens(email: string): Promise<string[]> {
    const { rows } = await db.query<{ body: string }>(
      "select body from mail_outbox where recipient = $1 and kind = 'reset_password' order by id",
      [email],
    );
    return rows.map((r) => new URL(/https?:\/\/\S+/.exec(r.body)![0]).searchParams.get("token")!);
  }

  test("a reset through one link ends every other link of that account, and no other account's", async () => {
    const a = await signUp(app, "two_links");
    const b = await signUp(app, "bystander");
    for (const email of [a.email, a.email, b.email]) await api(app, null, "POST", "/api/auth/request-password-reset", { email });
    const [first, second] = await resetTokens(a.email);
    const [others] = await resetTokens(b.email);

    expect(await api(app, null, "POST", "/api/auth/reset-password", { newPassword: "the first new password", token: first })).toEqual({
      status: 200,
      json: { status: true },
    });
    expect(await api(app, null, "POST", "/api/auth/reset-password", { newPassword: "a later new password", token: second })).toEqual({
      status: 400,
      json: { error: "invalid_token" },
    });
    expect((await signIn(app, a.email, "the first new password")).statusCode).toBe(200);
    expect(await count(`select count(*) n from verification where identifier like 'reset-password:%'`)).toBe(1);
    expect((await api(app, null, "POST", "/api/auth/reset-password", { newPassword: "bystander's new one", token: others })).status).toBe(200);
  });

  test("two links of one account used at once: exactly one reset happens", async () => {
    for (let round = 0; round < 4; round++) {
      const a = await signUp(app, `racing_links_${round}`);
      for (let i = 0; i < 3; i++) await api(app, null, "POST", "/api/auth/request-password-reset", { email: a.email });
      const tokens = await resetTokens(a.email);
      const results = await Promise.all(
        tokens.map((token, i) => api(app, null, "POST", "/api/auth/reset-password", { newPassword: `racing password ${i}`, token })),
      );
      const won = results.flatMap((r, i) => (r.status === 200 ? [i] : []));
      expect(won).toHaveLength(1);
      for (const [i, r] of results.entries()) if (i !== won[0]) expect(r).toEqual({ status: 400, json: { error: "invalid_token" } });
      expect((await signIn(app, a.email, `racing password ${won[0]}`)).statusCode).toBe(200);
    }
  });

  test("inputs Better Auth answered with a 500 are refused with 400 first; the app's own links still work", async () => {
    const a = await signUp(app, "bad_inputs");
    const post = (path: string, body: object) => api(app, null, "POST", `/api/auth/${path}`, body);
    const bad = { status: 400, json: { error: "invalid_request" } };
    // NUL cannot be stored or compared by Postgres (it was a 500).
    expect(await post("reset-password", { newPassword: "a new password 1", token: "a\u0000b" })).toEqual(bad);
    expect(await post("request-password-reset", { email: `${a.email}\u0000` })).toEqual(bad);
    // Redirect targets: a lone surrogate and a bare word were 500s; other hosts are never a target.
    const redirects = ["\ud800", "abc", "https://evil.example.test/x", "//evil.example.test", "/\\evil.example.test", "javascript:alert(1)", "/a\nb"];
    for (const redirectTo of redirects) {
      expect([redirectTo, await post("request-password-reset", { email: a.email, redirectTo })]).toEqual([redirectTo, bad]);
    }
    for (const callbackURL of ["%ED%A0%80", ...redirects.slice(1).map(encodeURIComponent)]) {
      const res = await api(app, null, "GET", `/api/auth/verify-email?token=abc&callbackURL=${callbackURL}`);
      expect([callbackURL, res]).toEqual([callbackURL, bad]);
    }
    // A query the endpoint does not declare is not forwarded silently.
    expect(await api(app, null, "POST", "/api/auth/sign-in/email?callbackURL=%2F", { email: a.email, password: a.password })).toEqual(bad);
    expect(await api(app, null, "GET", "/api/auth/verify-email?token=abc&extra=1")).toEqual(bad);

    // What the app itself uses still works: a path on the site, a URL on the app's origin.
    expect((await post("request-password-reset", { email: a.email, redirectTo: "/reset" })).status).toBe(200);
    expect((await post("request-password-reset", { email: a.email, redirectTo: "http://localhost:5173/reset" })).status).toBe(200);
    const invalidToken = await app.inject({ method: "GET", url: "/api/auth/verify-email?token=abc&callbackURL=%2Fdone" });
    expect(invalidToken.statusCode).toBe(302);
    expect(invalidToken.headers.location).toBe("/done?error=INVALID_TOKEN");
  });

  test("sign-out invalidates the session cookie", async () => {
    const a = await signUp(app, "signs_out");
    expect((await api(app, a, "GET", "/api/me")).status).toBe(200);
    expect((await api(app, a, "POST", "/api/auth/sign-out", {})).status).toBe(200);
    expect(await api(app, a, "GET", "/api/me")).toEqual({ status: 401, json: { error: "unauthenticated" } });
  });

  test("/api/me without a session is 401 unauthenticated", async () => {
    expect(await api(app, null, "GET", "/api/me")).toEqual({ status: 401, json: { error: "unauthenticated" } });
  });

  test("a session of a user whose e-mail is not verified is refused", async () => {
    const a = await signUp(app, "unverified_later");
    await db.query(`update "user" set "emailVerified" = false`);
    expect(await api(app, a, "GET", "/api/me")).toEqual({ status: 401, json: { error: "unauthenticated" } });
  });

  test("onSessionEnded fires on sign-out, and on password reset once for every session of the user", async () => {
    const a = await signUp(app, "notify_me");
    const ended: Array<[string, string]> = [];
    const off = onSessionEnded(app, (principalId, sessionId) => void ended.push([principalId, sessionId]));
    try {
      await api(app, a, "POST", "/api/auth/sign-out", {});
      expect(ended).toHaveLength(1);
      expect(ended[0]![0]).toBe(a.id);
      expect(ended[0]![1]).toBeTruthy();

      ended.length = 0;
      const s1 = cookieHeaderFrom((await signIn(app, a.email, a.password)).headers["set-cookie"]);
      const s2 = cookieHeaderFrom((await signIn(app, a.email, a.password)).headers["set-cookie"]);
      expect(s1).not.toBe(s2);
      await api(app, null, "POST", "/api/auth/request-password-reset", { email: a.email });
      const token = await resetToken(a.email);
      const reset = await api(app, null, "POST", "/api/auth/reset-password", { newPassword: "brand new password", token });
      expect(reset.status).toBe(200);
      expect(ended).toHaveLength(2);
      expect(ended.every(([p]) => p === a.id)).toBe(true);
      expect(new Set(ended.map(([, s]) => s)).size).toBe(2);
    } finally {
      off();
    }
  });

  test("a reset announces ended sessions only once it has committed, and not at all when it fails", async () => {
    const a = await signUp(app, "announce_after");
    const ended: string[] = [];
    const stillThere: Array<Promise<number>> = [];
    const off = onSessionEnded(app, (_p, sessionId) => {
      ended.push(sessionId);
      // What anyone else sees at the moment of the announcement: the session must already be gone.
      stillThere.push(count(`select count(*) n from "session" where id = $1`, [sessionId]));
    });
    try {
      // A reset that fails after Better Auth deleted the sessions: rolled back, nothing to announce.
      await api(app, null, "POST", "/api/auth/request-password-reset", { email: a.email });
      await db.query("create function test_fail_account() returns trigger language plpgsql as 'begin raise exception ''boom''; end'");
      await db.query(`create trigger test_fail before update on "account" for each row execute function test_fail_account()`);
      // Better Auth's router prints an unexpected failure to the console itself; kept out of the test output.
      const printed = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const failed = await api(app, null, "POST", "/api/auth/reset-password", { newPassword: "a failing new password", token: await resetToken(a.email) });
        expect(failed).toEqual({ status: 500, json: { error: "internal" } });
        expect(printed).toHaveBeenCalledWith("# SERVER_ERROR: ", expect.objectContaining({ message: "boom" }));
      } finally {
        printed.mockRestore();
        await db.query(`drop trigger test_fail on "account"`);
        await db.query("drop function test_fail_account()");
      }
      expect(ended).toEqual([]);
      expect((await api(app, a, "GET", "/api/me")).status).toBe(200);

      // The same link again, now succeeding, with a second link outstanding whose removal (the last step before
      // commit) is slowed down: the announcement must wait for the commit, so nobody sees the session any more.
      const token = await resetToken(a.email);
      await api(app, null, "POST", "/api/auth/request-password-reset", { email: a.email });
      await db.query("create function test_slow_delete() returns trigger language plpgsql as 'begin perform pg_sleep(0.4); return old; end'");
      await db.query(`create trigger test_slow before delete on verification for each row execute function test_slow_delete()`);
      try {
        expect((await api(app, null, "POST", "/api/auth/reset-password", { newPassword: "a working new password", token })).status).toBe(200);
      } finally {
        await db.query("drop trigger test_slow on verification");
        await db.query("drop function test_slow_delete()");
      }
      expect(ended).toHaveLength(1);
      expect(await Promise.all(stillThere)).toEqual([0]);
    } finally {
      off();
    }
  });

  test("session-ended listeners belong to one app; one that throws or rejects is logged and sign-out still works", async () => {
    const lines: string[] = [];
    const other = await buildApp({ config: app.deps.config, db: app.deps.db }, { logStream: { write: (l) => void lines.push(l) } });
    await other.ready();
    try {
      const a = await signUp(app, "per_app");
      const heardHere: string[] = [];
      const heardThere: string[] = [];
      const offs = [
        onSessionEnded(app, (_p, s) => void heardHere.push(s)),
        onSessionEnded(other, () => {
          throw new Error("listener threw");
        }),
        onSessionEnded(other, async () => {
          throw new Error("listener rejected");
        }),
        onSessionEnded(other, (_p, s) => void heardThere.push(s)),
      ];
      try {
        // Signed out through the other app: only its listeners hear of it, all of them despite the failures.
        expect(await api(other, a, "POST", "/api/auth/sign-out", {})).toEqual({ status: 200, json: { success: true } });
        expect(heardThere).toHaveLength(1);
        expect(heardHere).toEqual([]);
        await vi.waitFor(() => {
          const failures = lines.map((l) => JSON.parse(l)).filter((e) => e.msg === "session-ended listener failed");
          expect(failures.map((e) => e.err.message).sort()).toEqual(["listener rejected", "listener threw"]);
        });
        expect(await api(app, a, "GET", "/api/me")).toEqual({ status: 401, json: { error: "unauthenticated" } });
      } finally {
        for (const off of offs) off();
      }
    } finally {
      await other.close();
    }
  });

  test("what Better Auth holds of a registration transaction refuses to run once that transaction is over", async () => {
    const pool = switchablePool(db.pool);
    let kept: { query: (text: string) => Promise<unknown>; release: () => void } | undefined;
    await db.tx((client) =>
      runInTransaction(client, async () => {
        kept = (await pool.connect()) as typeof kept;
        await expect(kept!.query("select 1")).resolves.toBeTruthy();
        // Better Auth's own transaction control becomes a savepoint inside ours.
        await expect(kept!.query("begin")).resolves.toBeTruthy();
        await expect(kept!.query("commit")).resolves.toBeTruthy();
      }),
    );
    // The client is back in the pool (maybe serving someone else by now): no query may reach it.
    await expect(kept!.query("select 1")).rejects.toThrow(/after it ended/);

    await db.tx((client) =>
      runInTransaction(client, async () => {
        const released = await pool.connect();
        released.release();
        await expect(released.query("select 1")).rejects.toThrow(/after releasing it/);
        const fresh = await pool.connect();
        await expect(fresh.query("select 1")).resolves.toBeTruthy();
      }),
    );
    // Outside a registration it is an ordinary pool.
    const plain = await pool.connect();
    try {
      expect((await plain.query("select 1 as one")).rows).toEqual([{ one: 1 }]);
    } finally {
      plain.release();
    }
  });

  test("no response of an auth endpoint carries a session token in its body; the cookie does", async () => {
    const tokens = new Set<string>();
    const bodies: Array<[string, string]> = [];
    const collect = async () => {
      for (const r of (await db.query<{ token: string }>(`select token from "session"`)).rows) tokens.add(r.token);
    };
    const keep = (label: string, res: { body: string }) => void bodies.push([label, res.body]);

    // Registration and verification of a new account.
    const code = await invite();
    keep("register", await app.inject({ method: "POST", url: "/api/register", payload: { inviteCode: code, email: "tok@example.test", password: PASSWORD, displayName: "Tok", handle: "tok_en", ...TERMS } }));
    keep("verify-email", await app.inject({ method: "GET", url: await mailLink(app, "tok@example.test", "verify_email") }));
    // Sign-in, twice (two sessions), the second also with a remembered session.
    const first = await signIn(app, "tok@example.test", PASSWORD);
    keep("sign-in", first);
    expect(first.statusCode).toBe(200);
    expect(first.json()).not.toHaveProperty("token");
    expect(first.json().user.email).toBe("tok@example.test");
    const cookie = cookieHeaderFrom(first.headers["set-cookie"]);
    keep("sign-in remember", await app.inject({ method: "POST", url: "/api/auth/sign-in/email", payload: { email: "tok@example.test", password: PASSWORD, rememberMe: true } }));
    await collect();
    expect(tokens.size).toBe(2);
    // The cookie carries the session (as the signed token).
    expect([...tokens].some((t) => decodeURIComponent(cookie).includes(t))).toBe(true);
    keep("me", await app.inject({ method: "GET", url: "/api/me", headers: { cookie } }));
    keep("request-password-reset", await app.inject({ method: "POST", url: "/api/auth/request-password-reset", payload: { email: "tok@example.test" } }));
    keep("reset-password", await app.inject({ method: "POST", url: "/api/auth/reset-password", payload: { newPassword: "another good password", token: await resetToken("tok@example.test") } }));
    const again = await signIn(app, "tok@example.test", "another good password");
    keep("sign-in after reset", again);
    await collect();
    keep("sign-out", await app.inject({ method: "POST", url: "/api/auth/sign-out", headers: { cookie: cookieHeaderFrom(again.headers["set-cookie"]) }, payload: {} }));

    expect(tokens.size).toBe(3);
    for (const [label, body] of bodies) {
      for (const token of tokens) expect([label, body.includes(token)]).toEqual([label, false]);
    }
  });

  test("a failure inside Better Auth is a logged 500 internal, never its own code or a 4xx", async () => {
    const lines: string[] = [];
    const logged = await buildApp({ config: app.deps.config, db: app.deps.db }, { logStream: { write: (l) => void lines.push(l) } });
    await logged.ready();
    const a = await signUp(app, "fails_inside");
    await db.query("create function test_fail_session() returns trigger language plpgsql as 'begin raise exception ''boom''; end'");
    await db.query(`create trigger test_fail before insert on "session" for each row execute function test_fail_session()`);
    try {
      const res = await logged.inject({ method: "POST", url: "/api/auth/sign-in/email", payload: { email: a.email, password: a.password } });
      expect([res.statusCode, res.json()]).toEqual([500, { error: "internal" }]);
      const errors = lines.map((l) => JSON.parse(l)).filter((e) => e.level >= 50);
      expect(errors.length).toBeGreaterThan(0);
      expect(JSON.stringify(errors)).toContain("boom");
    } finally {
      await db.query(`drop trigger test_fail on "session"`);
      await db.query("drop function test_fail_session()");
      await logged.close();
    }
    expect((await signIn(app, a.email, a.password)).statusCode).toBe(200);
  });

  test("a wrong password is 401 with only our error shape, never Better Auth's message", async () => {
    const a = await signUp(app, "shape_check");
    const res = await signIn(app, a.email, "definitely the wrong one");
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "invalid_email_or_password" });
    const bad = await api(app, null, "POST", "/api/auth/reset-password", { newPassword: "short", token: "x" });
    expect(bad.status).toBe(400);
    expect(Object.keys(bad.json)).toEqual(["error"]);
  });

  test("an unverified account that signs in with the right password is refused but gets a fresh verification mail", async () => {
    const code = await invite();
    expect((await register({ inviteCode: code })).status).toBe(201);
    const mails = () =>
      count("select count(*) n from mail_outbox where recipient = 'new@example.test' and kind = 'verify_email'");
    expect(await mails()).toBe(1);
    const firstLink = await mailLink(app, "new@example.test", "verify_email");

    // a wrong password reveals nothing and sends nothing
    expect((await signIn(app, "new@example.test", "not the password")).statusCode).toBe(401);
    expect(await mails()).toBe(1);

    // the original mail is lost or expired: signing in again sends a new one
    const refused = await signIn(app, "new@example.test", PASSWORD);
    expect(refused.statusCode).toBe(403);
    expect(await mails()).toBe(2);
    const freshLink = await mailLink(app, "new@example.test", "verify_email");
    expect(freshLink).not.toBe(firstLink);

    expect((await app.inject({ method: "GET", url: freshLink })).statusCode).toBeLessThan(400);
    expect((await signIn(app, "new@example.test", PASSWORD)).statusCode).toBe(200);
  });

  const attempt = (target: FastifyInstance, remoteAddress: string, email: string, path = "/api/auth/sign-in/email") =>
    target.inject({
      method: "POST",
      url: path,
      remoteAddress,
      payload: path.includes("sign-in") ? { email, password: "whatever password" } : { email },
    });

  test("the 11th sign-in attempt for one account from one address is 429; other accounts and other addresses are unaffected", async () => {
    const strict = await appWith({ rateLimitScale: 1 });
    try {
      const a = await signUp(strict, "limit_a");
      const b = await signUp(strict, "limit_b");
      for (let i = 0; i < 10; i++) expect((await attempt(strict, "10.0.0.1", a.email)).statusCode).toBe(401);
      const blocked = await attempt(strict, "10.0.0.1", a.email);
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json()).toEqual({ error: "rate_limited" });
      // the e-mail is normalised, so case and spaces do not dodge the limit
      expect((await attempt(strict, "10.0.0.1", ` ${a.email.toUpperCase()} `)).statusCode).toBe(429);
      // a client-supplied X-Forwarded-For must not let the same address dodge it either
      const spoofed = await strict.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        remoteAddress: "10.0.0.1",
        headers: { "x-forwarded-for": "203.0.113.9" },
        payload: { email: a.email, password: "whatever password" },
      });
      expect(spoofed.statusCode).toBe(429);
      // account B from the same address still signs in; account A from another address too
      const ok = await strict.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        remoteAddress: "10.0.0.1",
        payload: { email: b.email, password: b.password },
      });
      expect(ok.statusCode).toBe(200);
      expect((await attempt(strict, "10.0.0.2", a.email)).statusCode).toBe(401);
    } finally {
      await strict.close();
    }
  });

  test("one address cycling through many e-mails hits the per-address cap of 60 per minute", async () => {
    const strict = await appWith({ rateLimitScale: 1 });
    try {
      const reset = (ip: string, email: string) => attempt(strict, ip, email, "/api/auth/request-password-reset");
      for (let i = 0; i < 60; i++) expect((await reset("10.0.1.1", `spray${i}@example.test`)).statusCode).toBe(200);
      const blocked = await reset("10.0.1.1", "spray-fresh@example.test");
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json()).toEqual({ error: "rate_limited" });
      expect((await reset("10.0.1.2", "spray-fresh@example.test")).statusCode).toBe(200);
    } finally {
      await strict.close();
    }
  });

  test("a missing or malformed e-mail in the body does not break rate limiting (falls back to the address)", async () => {
    const strict = await appWith({ rateLimitScale: 1 });
    try {
      const send = (payload: unknown) =>
        strict.inject({ method: "POST", url: "/api/auth/sign-in/email", remoteAddress: "10.0.2.1", payload: payload as object });
      for (const payload of [{}, { email: 42 }, { email: ["a"] }, { email: null }, { password: "x" }]) {
        expect((await send(payload)).statusCode).toBeLessThan(500);
      }
      for (let i = 0; i < 5; i++) await send({ email: 42 });
      expect((await send({})).statusCode).toBe(429);
    } finally {
      await strict.close();
    }
  });

  test("verification links are limited like sign-in: 10 per minute per client address and e-mail, 60 per address", async () => {
    const strict = await appWith({ rateLimitScale: 1 });
    try {
      // The e-mail is the one the link names; the limit is counted before the link is checked.
      const link = (email: string) => {
        const payload = Buffer.from(JSON.stringify({ email })).toString("base64url");
        return `/api/auth/verify-email?token=eyJhbGciOiJIUzI1NiJ9.${payload}.c2lnbmF0dXJl`;
      };
      const open = (email: string, remoteAddress = "10.0.3.1") => strict.inject({ method: "GET", url: link(email), remoteAddress });
      for (let i = 0; i < 10; i++) expect((await open("one@example.test")).statusCode).toBe(401);
      const blocked = await open("one@example.test");
      expect([blocked.statusCode, blocked.json()]).toEqual([429, { error: "rate_limited" }]);
      expect((await open("ONE@example.test")).statusCode).toBe(429);
      expect((await open("two@example.test")).statusCode).toBe(401);
      expect((await open("one@example.test", "10.0.3.2")).statusCode).toBe(401);
      for (let i = 0; i < 49; i++) await open(`spray${i}@example.test`);
      expect((await open("fresh@example.test")).statusCode).toBe(429);
    } finally {
      await strict.close();
    }
  });

  test("/api/register is limited to 10 per minute per address and the reset request to 10 per account", async () => {
    const strict = await appWith({ rateLimitScale: 1 });
    try {
      for (let i = 0; i < 10; i++) expect((await register({}, strict)).status).toBe(400);
      expect(await register({}, strict)).toEqual({ status: 429, json: { error: "rate_limited" } });
      const reset = () => api(strict, null, "POST", "/api/auth/request-password-reset", { email: "x@example.test" });
      for (let i = 0; i < 10; i++) expect((await reset()).status).toBe(200);
      expect((await reset()).status).toBe(429);
    } finally {
      await strict.close();
    }
  });

  test("a wrong password takes about as long for an existing as for a non-existing e-mail", async () => {
    const a = await signUp(app, "timing_known");
    const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)]!;
    const time = async (email: string) => {
      const t0 = performance.now();
      const res = await signIn(app, email, "definitely the wrong one");
      const dt = performance.now() - t0;
      expect(res.statusCode).toBe(401);
      return dt;
    };
    await time(a.email); // warm up both paths
    await time("ghost@example.test");
    const known: number[] = [];
    const unknown: number[] = [];
    for (let i = 0; i < 15; i++) {
      // interleaved so drift in machine load hits both samples alike
      known.push(await time(a.email));
      unknown.push(await time(`ghost${i}@example.test`));
    }
    const ratio = Math.max(median(known), median(unknown)) / Math.min(median(known), median(unknown));
    expect(ratio).toBeLessThan(3);
  });
});

describe("the account a request names (X-Account; T2 fix 3, S1)", () => {
  const { app } = useApp();
  type Who = { cookie: string; id: string };
  const as = (who: Who, named: string, method: "GET" | "PATCH" | "POST", url: string, body?: object) =>
    app.inject({ method, url, headers: { cookie: who.cookie, "x-account": named }, ...(body ? { payload: body } : {}) });

  test("a request naming another account than its session's gets nothing of this one's: 409 account_changed, nothing read or written; its own named, or none, is answered", async () => {
    const [ann, bo] = [await signUp(app, "acct_ann"), await signUp(app, "acct_bo")];
    // bo's cookie, a page that runs for ann: nothing is answered for bo, and nothing is done as bo.
    for (const [method, url, body] of [
      ["GET", "/api/me"],
      ["GET", "/api/sync"],
      ["POST", "/api/sync/catchup", { positions: {} }],
      ["POST", "/api/ws-ticket"],
      ["PATCH", "/api/me", { displayName: "不是我" }],
    ] as const) {
      const res = await as(bo, ann.id, method, url, body);
      expect([url, res.statusCode, res.json()]).toEqual([url, 409, { error: "account_changed" }]);
    }
    const mine = await api(app, bo, "GET", "/api/me");
    expect(mine.status).toBe(200);
    expect(mine.json.displayName).not.toBe("不是我");
    expect((await as(bo, bo.id, "GET", "/api/me")).statusCode).toBe(200);
  });
});
