import { describe, expect, test } from "vitest";
import { signJWT } from "better-auth/crypto";
import { lockAccountEmail } from "../src/auth/accounts.ts";
import { createInvite, hashInviteCode } from "../src/auth/invites.ts";
import { api, mailLink, signIn, signUp, TERMS } from "./helpers/actors.ts";
import { useApp } from "./helpers/harness.ts";

const PASSWORD = "correct horse battery";
const CREATED = { status: 201, json: { ok: true } };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("registering an e-mail that already has an account", () => {
  const { app, db } = useApp();

  const invite = () => createInvite(db, { ttlHours: 1 });
  const register = (body: Record<string, unknown>) =>
    api(app, null, "POST", "/api/register", { password: PASSWORD, displayName: "Probe", ...TERMS, ...body });
  const count = async (sql: string, params: unknown[] = []) => Number((await db.query<{ n: string }>(sql, params)).rows[0]!.n);
  /** `used`: consumed; `usedBy`: the principal it made, if one exists. */
  const inviteState = async (code: string) =>
    (
      await db.query<{ usedBy: string | null; used: boolean }>(
        `select used_by as "usedBy", used_at is not null as used from invites where code_hash = $1`,
        [hashInviteCode(code)],
      )
    ).rows[0];
  /** The account of an e-mail: its auth user and principal. */
  const accountOf = async (email: string) =>
    (
      await db.query<{ userId: string; verified: boolean; principalId: string; handle: string; displayName: string }>(
        `select u.id as "userId", u."emailVerified" as verified, p.id as "principalId", p.handle::text as handle, p.display_name as "displayName"
           from "user" u join principals p on p.auth_user_id = u.id where u.email = $1`,
        [email.toLowerCase()],
      )
    ).rows;
  /** Registers `email` without following the verification link: an unverified account. */
  async function pending(email: string, handle: string, extra: Record<string, unknown> = {}) {
    expect(await register({ inviteCode: await invite(), email, handle, ...extra })).toEqual(CREATED);
    return (await accountOf(email))[0]!;
  }
  const notices = async (email: string) =>
    (await db.query<{ subject: string; body: string; html: string | null }>("select subject, body, html from mail_outbox where kind = 'registration_attempt' and recipient = $1", [email])).rows;

  test("an invite holder learns nothing: whatever the e-mail, the invite is untouched and every answer is the same", async () => {
    const verified = await signUp(app, "has_account");
    await pending("pending@example.test", "pending_one");
    const seen = [];
    for (const [i, email] of [verified.email, "pending@example.test", "nobody@example.test"].entries()) {
      const code = await invite();
      const probe = await register({ inviteCode: code, email, handle: `probe_${i}` });
      // The adversarial review's check: the same invite again, with a taken handle. A sign-up takes no use, so it
      // is still usable whatever the first e-mail was: the answer says nothing about that e-mail.
      const check = await register({ inviteCode: code, email: `check${i}@example.test`, handle: verified.handle });
      seen.push({ probe, check, used: (await inviteState(code))!.used });
    }
    expect(seen[0]).toEqual({ probe: CREATED, check: { status: 409, json: { error: "handle_taken" } }, used: false });
    expect(seen[1]).toEqual(seen[0]);
    expect(seen[2]).toEqual(seen[0]);
  });

  test("a verified account is left as it is; its owner gets at most one notice an hour; the invite is untouched", async () => {
    const owner = await signUp(app, "the_owner");
    const snapshot = () =>
      db.query(
        `select u.*, a.password, p.id as pid, p.handle::text, p.display_name
           from "user" u join account a on a."userId" = u.id join principals p on p.auth_user_id = u.id order by u.id`,
      );
    const before = (await snapshot()).rows;

    const code = await invite();
    expect(await register({ inviteCode: code, email: owner.email.toUpperCase(), handle: "squatter" })).toEqual(CREATED);
    expect((await snapshot()).rows).toEqual(before);
    expect(await count("select count(*) n from principals")).toBe(1);
    expect(await inviteState(code)).toEqual({ usedBy: null, used: false });
    const [notice, ...more] = await notices(owner.email);
    expect(more).toEqual([]);
    expect(notice!.subject).toBe("有人尝试用你的邮箱注册 Haiyo");
    expect(notice!.html).toContain("有人尝试用你的邮箱注册");
    expect(notice!.body.split("\n")).toEqual(expect.arrayContaining(["http://localhost:5173/signin", "http://localhost:5173/forgot"]));
    // No verification mail: nothing was created.
    expect(await count("select count(*) n from mail_outbox where kind = 'verify_email' and recipient = $1", [owner.email])).toBe(1);

    // More attempts within the hour: still answered, and their invites still untouched, but no more mail.
    for (const handle of ["squatter_2", "squatter_3"]) {
      const next = await invite();
      expect(await register({ inviteCode: next, email: owner.email, handle })).toEqual(CREATED);
      expect((await inviteState(next))!.used).toBe(false);
    }
    expect(await notices(owner.email)).toHaveLength(1);
    // An hour after the last notice there may be another.
    await db.query("update mail_outbox set created_at = now() - interval '61 minutes' where kind = 'registration_attempt'");
    expect(await register({ inviteCode: await invite(), email: owner.email, handle: "squatter_4" })).toEqual(CREATED);
    expect(await notices(owner.email)).toHaveLength(2);

    expect((await snapshot()).rows).toEqual(before);
    expect((await signIn(app, owner.email, owner.password)).statusCode).toBe(200);
  });

  test("an unverified account is replaced: the new password, handle and name apply, the old handle is free, old links are dead", async () => {
    const firstCode = await invite();
    expect(
      await register({ inviteCode: firstCode, email: "claim@example.test", password: "the squatter's password", displayName: "Squatter", handle: "squat_handle" }),
    ).toEqual(CREATED);
    const old = (await accountOf("claim@example.test"))[0]!;
    const staleLink = await mailLink(app, "claim@example.test", "verify_email");
    expect((await api(app, null, "POST", "/api/auth/request-password-reset", { email: "claim@example.test" })).status).toBe(200);
    const staleReset = new URLSearchParams((await mailLink(app, "claim@example.test", "reset_password")).split("?")[1]).get("token")!;

    const code = await invite();
    expect(
      await register({ inviteCode: code, email: "Claim@Example.test", password: "the owner's own password", displayName: "Owner", handle: "real_owner" }),
    ).toEqual(CREATED);

    const [now, ...others] = await accountOf("claim@example.test");
    expect(others).toEqual([]);
    expect(now).toMatchObject({ verified: false, handle: "real_owner", displayName: "Owner" });
    expect(now!.userId).not.toBe(old.userId);
    expect(now!.principalId).not.toBe(old.principalId);
    expect(await count("select count(*) n from principals where id = $1", [old.principalId])).toBe(0);
    for (const table of [`"user" where id`, `"account" where "userId"`, `"session" where "userId"`, `"verification" where value`]) {
      expect([table, await count(`select count(*) n from ${table} = $1`, [old.userId])]).toEqual([table, 0]);
    }
    // Replacing costs the code nothing and leaves one note: the old account's note went with it.
    expect(await inviteState(firstCode)).toEqual({ usedBy: null, used: false });
    expect(await inviteState(code)).toEqual({ usedBy: null, used: false });
    expect(await count("select count(*) n from pending_invites where principal_id = $1", [now!.principalId])).toBe(1);
    expect(await count("select count(*) n from pending_invites where code_hash = $1", [hashInviteCode(firstCode)])).toBe(0);

    // The replaced account's verification and reset links do nothing.
    const stale = await app.inject({ method: "GET", url: staleLink });
    expect(stale.headers.location).toBe("http://localhost:5173/verify?error=INVALID_TOKEN");
    expect(await api(app, null, "POST", "/api/auth/reset-password", { newPassword: "a takeover password", token: staleReset })).toEqual({
      status: 400,
      json: { error: "invalid_token" },
    });
    expect((await accountOf("claim@example.test"))[0]!.verified).toBe(false);

    // The fresh mail's link verifies the new account, which signs in with the new password only.
    const freshLink = await mailLink(app, "claim@example.test", "verify_email");
    expect(freshLink).not.toBe(staleLink);
    expect((await app.inject({ method: "GET", url: freshLink })).headers.location).toBe("http://localhost:5173/verify");
    expect((await signIn(app, "claim@example.test", "the squatter's password")).statusCode).toBe(401);
    expect((await signIn(app, "claim@example.test", "the owner's own password")).statusCode).toBe(200);

    // Nobody holds the old handle any more.
    expect(await register({ inviteCode: await invite(), email: "someone@example.test", handle: "squat_handle" })).toEqual(CREATED);
  });

  test("a replaced account's handle is not the new registration's to reuse: 409 handle_taken, as for any taken handle", async () => {
    await pending("again@example.test", "same_handle");
    const code = await invite();
    expect(await register({ inviteCode: code, email: "again@example.test", handle: "same_handle" })).toEqual({ status: 409, json: { error: "handle_taken" } });
    expect((await inviteState(code))!.used).toBe(false);
    expect(await accountOf("again@example.test")).toHaveLength(1);
  });

  test("friend requests to and blocks of a replaced account go with it, and the people who made them are told", async () => {
    const old = await pending("wanted@example.test", "wanted_one");
    const asker = await signUp(app, "asker");
    const blocker = await signUp(app, "blocker");
    expect((await api(app, asker, "POST", "/api/friend-requests", { handle: "wanted_one" })).status).toBe(201);
    expect((await api(app, blocker, "PUT", `/api/blocks/${old.principalId}`)).status).toBe(200);

    const told: string[][] = [];
    const off = app.deps.social.on((ids) => void told.push(ids));
    try {
      expect(await register({ inviteCode: await invite(), email: "wanted@example.test", handle: "wanted_two" })).toEqual(CREATED);
    } finally {
      off();
    }
    expect(told.flat().sort()).toEqual([asker.id, blocker.id].sort());
    expect((await api(app, asker, "GET", "/api/social")).json.outgoing).toEqual([]);
    expect((await api(app, blocker, "GET", "/api/social")).json.blocked).toEqual([]);
    expect(await count("select count(*) n from friend_requests")).toBe(0);
  });

  test("an unverified account that holds anything only a signed-in person can make is never replaced", async () => {
    const friend = await signUp(app, "a_friend");
    const traces: Array<[string, (pid: string) => Promise<unknown>]> = [
      ["friendship", (pid) => db.query("insert into friendships (a_id, b_id) values (least($1::uuid, $2::uuid), greatest($1::uuid, $2::uuid))", [pid, friend.id])],
      ["block it made", (pid) => db.query("insert into blocks (blocker_id, blocked_id) values ($1, $2)", [pid, friend.id])],
      ["friend request it sent", (pid) => db.query("insert into friend_requests (from_id, to_id, expires_at) values ($1, $2, now() + interval '1 day')", [pid, friend.id])],
    ];
    for (const [i, [what, make]] of traces.entries()) {
      const email = `traced${i}@example.test`;
      const old = await pending(email, `traced_${i}`);
      await make(old.principalId);
      const code = await invite();
      const res = await register({ inviteCode: code, email, handle: `retry_${i}` });
      expect([what, res]).toEqual([what, { status: 500, json: { error: "internal" } }]);
      expect([what, await accountOf(email)]).toEqual([what, [old]]);
      expect([what, (await inviteState(code))!.used]).toEqual([what, false]);
      // Nothing of the refused registration is left: the old account keeps its note, the new code has none.
      expect([what, await count("select count(*) n from pending_invites where principal_id = $1", [old.principalId])]).toEqual([what, 1]);
      expect([what, await count("select count(*) n from pending_invites where code_hash = $1", [hashInviteCode(code)])]).toEqual([what, 0]);
    }
  });

  test("eight registrations racing on one invite all answer 201 and none takes it; each new address gets one account", async () => {
    const owner = await signUp(app, "race_owner");
    await pending("race_pending@example.test", "race_pending");
    for (let round = 0; round < 4; round++) {
      const code = await createInvite(db, { ttlHours: 1, uses: 8 });
      const emails = [owner.email, "race_pending@example.test", ...Array.from({ length: 6 }, (_, i) => `race${round}_${i}@example.test`)];
      const handles = emails.map((_, i) => `race${round}_${i}`);
      const results = await Promise.all(emails.map((email, i) => register({ inviteCode: code, email, handle: handles[i] })));
      expect(results).toEqual(emails.map(() => CREATED));
      expect((await inviteState(code))!.used).toBe(false);
      // The verified owner's address makes nothing; every other one makes exactly one account.
      const made = await count("select count(*) n from principals where handle = any($1::text[])", [handles]);
      expect(made).toBe(emails.length - 1);
    }
    expect(await accountOf(owner.email)).toMatchObject([{ verified: true, handle: owner.handle }]);
    expect(await accountOf("race_pending@example.test")).toHaveLength(1);
  });

  test("two registrations of one e-mail at once both answer 201 and leave exactly one account", async () => {
    for (let round = 0; round < 4; round++) {
      const email = `twin${round}@example.test`;
      const codes = [await invite(), await invite()];
      const handles = [`twin_a${round}`, `twin_b${round}`];
      const results = await Promise.all(codes.map((inviteCode, i) => register({ inviteCode, email, handle: handles[i] })));
      expect(results).toEqual([CREATED, CREATED]);
      const accounts = await accountOf(email);
      expect(accounts).toHaveLength(1);
      expect(handles).toContain(accounts[0]!.handle);
      expect(await count("select count(*) n from principals where handle = any($1::text[])", [handles])).toBe(1);
      for (const code of codes) expect((await inviteState(code))!.used).toBe(false);
      expect(await count("select count(*) n from pending_invites where code_hash = any($1::text[])", [codes.map(hashInviteCode)])).toBe(1);
    }
  });

  test("a forged or expired verification link is answered at once: no transaction, no wait for the address's lock", async () => {
    await pending("forged@example.test", "forged_one");
    const realLink = await mailLink(app, "forged@example.test", "verify_email");
    const realToken = new URL(realLink, "http://x").searchParams.get("token")!;
    const [head, , signature] = realToken.split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ email: "forged@example.test", userId: "someone" })).toString("base64url");
    const forged = `${head}.${forgedPayload}.${signature}`;
    const expired = await signJWT({ email: "forged@example.test" }, app.deps.config.authSecret, -60);
    const holder = await db.pool.connect();
    try {
      await holder.query("begin");
      await lockAccountEmail(holder, "forged@example.test");
      for (const [label, token, error] of [["forged", forged, "INVALID_TOKEN"], ["expired", expired, "TOKEN_EXPIRED"]] as const) {
        const url = `/api/auth/verify-email?token=${encodeURIComponent(token)}&callbackURL=${encodeURIComponent("http://localhost:5173/verify")}`;
        const answer = app.inject({ method: "GET", url });
        const inTime = await Promise.race([answer.then(() => true), sleep(1000).then(() => false)]);
        expect([label, inTime]).toEqual([label, true]);
        expect([label, (await answer).headers.location]).toEqual([label, `http://localhost:5173/verify?error=${error}`]);
      }
    } finally {
      await holder.query("rollback");
      holder.release();
    }
    expect((await accountOf("forged@example.test"))[0]!.verified).toBe(false);
  });

  test("a verification link waits while a registration of the same e-mail is deciding", async () => {
    await pending("wait@example.test", "wait_one");
    const link = await mailLink(app, "wait@example.test", "verify_email");
    const holder = await db.pool.connect();
    try {
      await holder.query("begin");
      await lockAccountEmail(holder, "WAIT@example.test");
      let answered = false;
      const verifying = app.inject({ method: "GET", url: link }).then((res) => {
        answered = true;
        return res;
      });
      await sleep(300);
      expect(answered).toBe(false);
      await holder.query("commit");
      expect((await verifying).headers.location).toBe("http://localhost:5173/verify");
    } finally {
      holder.release();
    }
    expect((await accountOf("wait@example.test"))[0]!.verified).toBe(true);
  });
});
