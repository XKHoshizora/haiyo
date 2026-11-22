import { readdirSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "vitest";
import { buildApp } from "../src/app.ts";
import { createInvite, hashInviteCode } from "../src/auth/invites.ts";
import { LEGAL_VERSIONS } from "../src/legal.ts";
import { api, cookieHeaderFrom, mailLink, signIn, signUp } from "./helpers/actors.ts";
import { NO_ANSWER_FLOOR, useApp } from "./helpers/harness.ts";
import { closeAllSockets, connect } from "./helpers/ws.ts";

/**
 * The terms, the privacy policy and the 18+ declaration (README "Accounts and sessions", Terms; migration 071): the service
 * refuses a registration that does not carry them, records which versions each account accepted and when, and asks again
 * (`termsAccepted: false` in `GET /api/me`) once either document has a new version — all of it while the site requires it
 * (`LEGAL={"required":true}`, `config.legal`); with the switch off (the default, while the texts are drafts) nothing of it is
 * asked or enforced (the last describe).
 */

const { app, db } = useApp({ env: { LEGAL: JSON.stringify({ required: true }) } });

const ACCEPTED = { termsVersion: LEGAL_VERSIONS.terms, privacyVersion: LEGAL_VERSIONS.privacy, adult: true };

const registerBody = async (over: Record<string, unknown> = {}) => ({
  inviteCode: await createInvite(db, { ttlHours: 1 }),
  email: `t${Math.random().toString(36).slice(2, 10)}@example.test`,
  password: "a good long password",
  displayName: "Terms",
  handle: `t_${Math.random().toString(36).slice(2, 10)}`,
  ...ACCEPTED,
  ...over,
});

const inviteUsed = async (code: string) =>
  (await db.query<{ used: boolean }>("select used_at is not null as used from invites where code_hash = $1", [hashInviteCode(code)])).rows[0]!.used;
const users = async () => Number((await db.query<{ n: string }>(`select count(*) n from "user"`)).rows[0]!.n);
const acceptances = async (principalId: string) =>
  (
    await db.query<{ terms: string; privacy: string; acceptedAt: Date; adultAt: Date }>(
      `select terms_version as terms, privacy_version as privacy, accepted_at as "acceptedAt", adult_declared_at as "adultAt"
         from terms_acceptances where principal_id = $1 order by accepted_at, terms_version`,
      [principalId],
    )
  ).rows;

/** Verifies and signs in an account registered with `body`; returns its cookie and principal id. */
async function verifiedSignIn(body: { email: string; password: string }) {
  const verify = await app.inject({ method: "GET", url: await mailLink(app, body.email, "verify_email") });
  expect(verify.statusCode).toBeLessThan(400);
  const res = await signIn(app, body.email, body.password);
  expect(res.statusCode).toBe(200);
  const cookie = cookieHeaderFrom(res.headers["set-cookie"]);
  const me = await api<{ id: string; termsAccepted: boolean }>(app, { cookie }, "GET", "/api/me");
  return { cookie, id: me.json.id, me: me.json };
}

describe("registration needs the terms, the privacy policy and the 18+ declaration", () => {
  test.each([
    ["nothing of it", { termsVersion: undefined, privacyVersion: undefined, adult: undefined }],
    ["no 18+ declaration", { adult: undefined }],
    ["18+ declared false", { adult: false }],
    ["18+ as a string", { adult: "true" }],
    ["no terms version", { termsVersion: undefined }],
    ["no privacy version", { privacyVersion: undefined }],
  ])("refused with %s: 400, nothing made, the invite still usable", async (_label, over) => {
    const body = await registerBody(over);
    for (const key of Object.keys(over)) if ((over as Record<string, unknown>)[key] === undefined) delete (body as Record<string, unknown>)[key];
    expect(await api(app, null, "POST", "/api/register", body)).toEqual({ status: 400, json: { error: "invalid_request" } });
    expect(await users()).toBe(0);
    expect(await inviteUsed(body.inviteCode)).toBe(false);
  });

  test("a version that is not the current one is 409 terms_outdated: nothing made, the invite still usable", async () => {
    for (const over of [{ termsVersion: "2000-01-01" }, { privacyVersion: "2000-01-01" }]) {
      const body = await registerBody(over);
      expect(await api(app, null, "POST", "/api/register", body)).toEqual({ status: 409, json: { error: "terms_outdated" } });
      expect(await inviteUsed(body.inviteCode)).toBe(false);
    }
    expect(await users()).toBe(0);
  });

  test("an accepted registration records the versions and when, for the new account", async () => {
    const before = new Date();
    const body = await registerBody();
    expect(await api(app, null, "POST", "/api/register", body)).toEqual({ status: 201, json: { ok: true } });
    const { id, me } = await verifiedSignIn(body);
    expect(me.termsAccepted).toBe(true);
    const [row, ...more] = await acceptances(id);
    expect(more).toEqual([]);
    expect(row).toMatchObject({ terms: LEGAL_VERSIONS.terms, privacy: LEGAL_VERSIONS.privacy });
    expect(row!.acceptedAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(row!.adultAt.getTime()).toBe(row!.acceptedAt.getTime());
  });

  test("an unverified account replaced by a new registration takes its record with it", async () => {
    const first = await registerBody({ email: "again@example.test" });
    expect((await api(app, null, "POST", "/api/register", first)).status).toBe(201);
    const old = (await db.query<{ id: string }>("select id from principals where handle = $1", [first.handle])).rows[0]!.id;
    expect(await acceptances(old)).toHaveLength(1);
    const second = await registerBody({ email: "again@example.test" });
    expect((await api(app, null, "POST", "/api/register", second)).status).toBe(201);
    expect(await acceptances(old)).toEqual([]);
    const now = (await db.query<{ id: string }>("select id from principals where handle = $1", [second.handle])).rows[0]!.id;
    expect(await acceptances(now)).toHaveLength(1);
  });

  test("a registration of an address with a verified account records nothing for anyone", async () => {
    const owner = await signUp(app, "has_one");
    const before = await acceptances(owner.id);
    expect((await api(app, null, "POST", "/api/register", await registerBody({ email: owner.email }))).status).toBe(201);
    expect(await acceptances(owner.id)).toEqual(before);
    expect(Number((await db.query<{ n: string }>("select count(*) n from terms_acceptances")).rows[0]!.n)).toBe(1);
  });
});

describe("an account asked again (GET /api/me termsAccepted, POST /api/me/terms)", () => {
  test("an account with no record (made before the terms) is asked, accepts once, and is not asked again", async () => {
    const a = await signUp(app, "older");
    await db.query("delete from terms_acceptances where principal_id = $1", [a.id]);
    expect((await api(app, a, "GET", "/api/me")).json.termsAccepted).toBe(false);
    expect(await api(app, a, "POST", "/api/me/terms", ACCEPTED)).toEqual({ status: 200, json: { termsAccepted: true } });
    expect((await api(app, a, "GET", "/api/me")).json.termsAccepted).toBe(true);
    // Again: the same answer, still one row.
    expect(await api(app, a, "POST", "/api/me/terms", ACCEPTED)).toEqual({ status: 200, json: { termsAccepted: true } });
    expect(await acceptances(a.id)).toHaveLength(1);
  });

  test("a new version of either document asks again; the earlier acceptance is kept beside the new one", async () => {
    const a = await signUp(app, "updated");
    for (const column of ["terms_version", "privacy_version"]) {
      await db.query(`update terms_acceptances set ${column} = '2000-01-01', accepted_at = accepted_at - interval '1 day' where principal_id = $1`, [a.id]);
      expect([column, (await api(app, a, "GET", "/api/me")).json.termsAccepted]).toEqual([column, false]);
      expect((await api(app, a, "POST", "/api/me/terms", ACCEPTED)).status).toBe(200);
      expect([column, (await api(app, a, "GET", "/api/me")).json.termsAccepted]).toEqual([column, true]);
      await db.query("delete from terms_acceptances where principal_id = $1 and (terms_version = '2000-01-01' or privacy_version = '2000-01-01')", [a.id]);
    }
    await db.query("update terms_acceptances set terms_version = '2000-01-01', accepted_at = accepted_at - interval '1 day' where principal_id = $1", [a.id]);
    expect((await api(app, a, "POST", "/api/me/terms", ACCEPTED)).status).toBe(200);
    expect((await acceptances(a.id)).map((r) => r.terms)).toEqual(["2000-01-01", LEGAL_VERSIONS.terms]);
  });

  test("the acceptance has a budget of its own: 10 a minute (times the scale) per person", async () => {
    // (Rows cannot grow, `on conflict do nothing`; a budget like every other write.)
    const a = await signUp(app, "budget");
    // The same wiring with the real scale (the harness raises every limit); it shares the test pool.
    const strict = await buildApp({ config: { ...app.deps.config, rateLimitScale: 1 }, db: app.deps.db }, { answerFloor: NO_ANSWER_FLOOR });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 11; i++) statuses.push((await api(strict, a, "POST", "/api/me/terms", ACCEPTED)).status);
      expect(statuses).toEqual([...Array(10).fill(200), 429]);
    } finally {
      await strict.close();
    }
  });

  test("the acceptance is refused without the 18+ declaration, with an old version, and without a session", async () => {
    const a = await signUp(app, "refused");
    await db.query("delete from terms_acceptances where principal_id = $1", [a.id]);
    expect(await api(app, a, "POST", "/api/me/terms", { ...ACCEPTED, adult: false })).toEqual({ status: 400, json: { error: "invalid_request" } });
    expect(await api(app, a, "POST", "/api/me/terms", { termsVersion: LEGAL_VERSIONS.terms, privacyVersion: LEGAL_VERSIONS.privacy })).toEqual({
      status: 400,
      json: { error: "invalid_request" },
    });
    expect(await api(app, a, "POST", "/api/me/terms", { ...ACCEPTED, termsVersion: "2000-01-01" })).toEqual({ status: 409, json: { error: "terms_outdated" } });
    expect(await api(app, null, "POST", "/api/me/terms", ACCEPTED)).toEqual({ status: 401, json: { error: "unauthenticated" } });
    expect(await acceptances(a.id)).toEqual([]);
    expect((await api(app, a, "GET", "/api/me")).json.termsAccepted).toBe(false);
  });
});

describe("the service refuses every signed-in call until the documents in force are accepted (403 terms_required)", () => {
  afterEach(() => closeAllSockets());
  const REQUIRED = { status: 403, json: { error: "terms_required" } };
  /** An account whose acceptance is of an older version: as every account is the moment a new version is in force. */
  async function behind(name: string) {
    const a = await signUp(app, name);
    await db.query("update terms_acceptances set terms_version = '2000-01-01' where principal_id = $1", [a.id]);
    return a;
  }

  test("reads, writes and the socket's ticket are refused; GET /api/me and POST /api/me/terms are not; after accepting, all answer", async () => {
    const a = await behind("behind");
    const b = await signUp(app, "friend");
    const calls: Array<[string, "GET" | "POST" | "PATCH" | "PUT", string, unknown?]> = [
      ["sync", "GET", "/api/sync"],
      ["social", "GET", "/api/social"],
      ["agents", "GET", "/api/agents"],
      ["providers", "GET", "/api/providers"],
      ["usage", "GET", "/api/usage"],
      ["socket ticket", "POST", "/api/ws-ticket"],
      ["rename", "PATCH", "/api/me", { displayName: "Renamed" }],
      ["friend request", "POST", "/api/friend-requests", { handle: b.handle }],
      ["lookup", "GET", `/api/principals/lookup?handle=${b.handle}`],
    ];
    for (const [what, method, url, body] of calls) expect([what, await api(app, a, method, url, body)]).toEqual([what, REQUIRED]);
    // Nothing was done: the name and the friend requests are as they were.
    expect((await db.query("select display_name from principals where id = $1", [a.id])).rows[0]).toEqual({ display_name: "behind" });
    expect(Number((await db.query<{ n: string }>("select count(*) n from friend_requests")).rows[0]!.n)).toBe(0);

    // What the question itself needs.
    expect((await api(app, a, "GET", "/api/me")).json).toMatchObject({ id: a.id, termsAccepted: false });
    expect(await api(app, a, "POST", "/api/me/terms", ACCEPTED)).toEqual({ status: 200, json: { termsAccepted: true } });
    for (const [what, method, url, body] of calls) expect([what, (await api(app, a, method, url, body)).status]).not.toEqual([what, 403]);
  });

  test("signing out needs no acceptance", async () => {
    const a = await behind("leaving");
    const out = await app.inject({ method: "POST", url: "/api/auth/sign-out", headers: { cookie: a.cookie } });
    expect(out.statusCode).toBe(200);
    expect((await api(app, a, "GET", "/api/me")).status).toBe(401);
  });

  test("a socket opened before a new version is in force cannot be opened again until the person accepts", async () => {
    const a = await signUp(app, "socketed");
    const socket = await connect(app, a);
    // A new version comes with a new build: the restart closes every socket, and the client asks for a new ticket.
    await db.query("update terms_acceptances set terms_version = '2000-01-01' where principal_id = $1", [a.id]);
    socket.close();
    await socket.closed;
    expect(await api(app, a, "POST", "/api/ws-ticket")).toEqual(REQUIRED);
    expect(await api(app, a, "GET", "/api/sync")).toEqual(REQUIRED);
    expect((await api(app, a, "POST", "/api/me/terms", ACCEPTED)).status).toBe(200);
    const again = await connect(app, a);
    expect(again.isClosed).toBe(false);
  });

  test("only GET /api/me and POST /api/me/terms are let through without the acceptance (src/session.ts, nowhere else)", () => {
    const files = (dir: string): string[] =>
      readdirSync(new URL(dir, import.meta.url), { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? files(`${dir}${e.name}/`) : e.name.endsWith(".ts") ? [`${dir}${e.name}`] : [],
      );
    const exempt = files("../src/").flatMap((f) => [...readFileSync(new URL(f, import.meta.url), "utf8").matchAll(/requirePrincipal\(req, \{ beforeTerms: true \}\)/g)].map(() => f));
    expect(exempt).toEqual(["../src/session.ts", "../src/session.ts"]);
  });
});
describe("with LEGAL.required off (the default while the texts are drafts): nothing is asked, recorded or refused", () => {
  /** The same wiring with the switch off; it shares the test pool. */
  async function withSwitchOff<T>(work: (off: typeof app) => Promise<T>): Promise<T> {
    const off = await buildApp({ config: { ...app.deps.config, legal: { required: false } }, db: app.deps.db }, { answerFloor: NO_ANSWER_FLOOR });
    try {
      return await work(off);
    } finally {
      await off.close();
    }
  }

  test("sign-up without the fields succeeds and records nothing; fields sent (even an old version) are ignored", async () => {
    await withSwitchOff(async (off) => {
      const bare = await registerBody({ termsVersion: undefined, privacyVersion: undefined, adult: undefined });
      for (const key of ["termsVersion", "privacyVersion", "adult"]) delete (bare as Record<string, unknown>)[key];
      expect(await api(off, null, "POST", "/api/register", bare)).toEqual({ status: 201, json: { ok: true } });
      expect(await api(off, null, "POST", "/api/register", await registerBody({ termsVersion: "2000-01-01" }))).toEqual({ status: 201, json: { ok: true } });
      expect(await api(off, null, "POST", "/api/register", await registerBody())).toEqual({ status: 201, json: { ok: true } });
      expect(await users()).toBe(3);
      expect(Number((await db.query<{ n: string }>("select count(*) n from terms_acceptances")).rows[0]!.n)).toBe(0);
      const { cookie } = await verifiedSignIn(bare);
      expect((await api(off, { cookie }, "GET", "/api/me")).json).toMatchObject({ termsRequired: false, termsAccepted: false });
    });
  });

  test("an account with no acceptance is served everywhere, the socket's ticket included; accepting still works", async () => {
    const a = await signUp(app, "unasked");
    await db.query("delete from terms_acceptances where principal_id = $1", [a.id]);
    await withSwitchOff(async (off) => {
      for (const [method, url] of [["GET", "/api/sync"], ["GET", "/api/social"], ["GET", "/api/agents"], ["POST", "/api/ws-ticket"]] as const) {
        expect([url, (await api(off, a, method, url)).status]).toEqual([url, 200]);
      }
      expect((await api(off, a, "GET", "/api/me")).json).toMatchObject({ termsRequired: false, termsAccepted: false });
      expect(await api(off, a, "POST", "/api/me/terms", ACCEPTED)).toEqual({ status: 200, json: { termsAccepted: true } });
      expect((await api(off, a, "GET", "/api/me")).json).toMatchObject({ termsRequired: false, termsAccepted: true });
    });
    // On, the same account (accepted now) is served; one that has not accepted is refused, as above.
    expect((await api(app, a, "GET", "/api/me")).json).toMatchObject({ termsRequired: true, termsAccepted: true });
  });

  test("GET /api/site says whether the site requires them, before anyone signs in", async () => {
    expect((await api(app, null, "GET", "/api/site")).json).toMatchObject({ termsRequired: true });
    await withSwitchOff(async (off) => expect((await api(off, null, "GET", "/api/site")).json).toMatchObject({ termsRequired: false }));
  });
});