import { generateKeyPairSync, randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { createApnsClient, type ApnsClient } from "../src/push/apns.ts";
import { PRESENCE_PROBE_MS, REQUEST_PUSH_BODY, REQUEST_QUIET_MS, REQUESTS_COLLAPSE_ID } from "../src/push/notify.ts";
import { api, befriend, cookieHeaderFrom, signIn, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { fakeApns, type FakeApns } from "./helpers/apns.ts";
import { useApp } from "./helpers/harness.ts";
import { SOCIAL_ON } from "./helpers/social.ts";
import { closeAllSockets, connect, issueTicket, rawUpgrade, type RawSocket } from "./helpers/ws.ts";

/**
 * A phone is told when someone newly waits for its person's answer (src/push/notify.ts `requestWaiting`; README "Push
 * notifications"): a friend request sent to them, an add of one of their Agents that waits for their decision. Nothing else of a
 * request is pushed — not an accept, a reject, a withdrawal, a decline or an expiry, not an add let in at once, not asking again
 * while it waits. The same discipline as a message's push: content-free, the recipient's lasting phones only, not while their own
 * session is present, re-checked after a probe without an answer, one at a time per phone, counters only in the log. And one
 * more rule of their own: after one was sent to a phone, none more goes to it for `REQUEST_QUIET_MS` (its quiet window), so that
 * nobody can ring a phone again and again (send, withdraw, send). The windows run on the harness's clock (`clock.advance`).
 */

const fake: { apns?: FakeApns } = {};
let real: ApnsClient | null = null;
// The app is built before the fake listens: the client it is given forwards to one made for the fake's address.
const apns: ApnsClient = { send: (n) => real!.send(n), close: async (grace) => real?.close(grace) };
const lines: string[] = [];
const { app, db, clock } = useApp({ env: SITE_ENV, config: SOCIAL_ON, agentWorker: false, apns, logStream: { write: (l) => void lines.push(l) } });
/** Every quiet window there is now is over (the clock moves past it). */
const windowOver = () => clock.advance(REQUEST_QUIET_MS);

const PEM = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const client = (): ApnsClient =>
  createApnsClient({ teamId: "ABCDE12345", keyId: "KEY1234567", keyPem: PEM, topic: "org.haiyo.app", origins: { production: fake.apns!.url, sandbox: fake.apns!.url }, retryDelaysMs: [5, 10] });
beforeAll(async () => {
  fake.apns = await fakeApns();
  real = client();
});
afterAll(async () => {
  await real?.close();
  await fake.apns?.close();
});
beforeEach(() => {
  fake.apns!.reset();
  app.push.flush();
  lines.length = 0;
});
const raws = new Set<RawSocket>();
afterEach(async () => {
  for (const r of raws) r.socket.destroy();
  raws.clear();
  await closeAllSockets();
});

const requests = () => fake.apns!.requests;
const pushedTo = () => requests().map((r) => r.path.replace("/3/device/", ""));
/** Registers a phone for `who`'s session; returns its token. */
const phone = async (who: Actor): Promise<string> => {
  const token = randomBytes(32).toString("hex");
  expect((await api(app, who, "POST", "/api/push/devices", { token, env: "production" })).status).toBe(200);
  return token;
};
/** `who` signs in once more: another session (another phone). */
const anotherSession = async (who: Actor): Promise<Actor> => ({ ...who, cookie: cookieHeaderFrom((await signIn(app, who.email, who.password)).headers["set-cookie"]) });
const sessionOf = async (token: string): Promise<string> => (await db.query<{ session_id: string }>("select session_id from push_devices where token = $1", [token])).rows[0]!.session_id;
const ask = (from: Actor, to: Actor) => api<{ id: string }>(app, from, "POST", "/api/friend-requests", { handle: to.handle });
const withdraw = (from: Actor, id: string) => api(app, from, "POST", `/api/friend-requests/${id}/withdraw`);
const add = (who: Actor, agentId: string) => api(app, who, "POST", "/api/agent-contacts", { agentId });
const agentOf = async (owner: Actor, handle: string): Promise<string> => ((await mustCreateAgent(app, owner, { handle })) as { id: string }).id;
/** What every push about a request carries, whoever it is for and whatever was asked. */
const PAYLOAD = { aps: { alert: { title: "Haiyo", body: REQUEST_PUSH_BODY }, sound: "default", "thread-id": REQUESTS_COLLAPSE_ID } };

/** A socket of `who`'s session that never answers (a raw connection: no pong, no close): a suspended phone's. */
async function silentSocket(who: Actor): Promise<RawSocket> {
  const raw = await rawUpgrade(app, await issueTicket(app, who));
  raws.add(raw);
  return raw;
}
/** Whether the server's frames in `buf` (unmasked, as a server sends them) include a ping (opcode 0x9): the probe has begun. */
function pinged(buf: Buffer): boolean {
  for (let i = 0; i + 2 <= buf.length; ) {
    let len = buf[i + 1]! & 0x7f;
    let head = 2;
    if (len === 126) {
      len = buf.readUInt16BE(i + 2);
      head = 4;
    } else if (len === 127) {
      len = Number(buf.readBigUInt64BE(i + 2));
      head = 10;
    }
    if ((buf[i]! & 0x0f) === 0x9) return true;
    i += head + len;
  }
  return false;
}
async function untilPinged(raw: RawSocket): Promise<void> {
  for (let i = 0; i < 400 && !pinged(raw.received()); i++) await new Promise((r) => setTimeout(r, 5));
  expect(pinged(raw.received())).toBe(true);
}

describe("what is pushed, to whom, and what it carries", () => {
  test("a friend request: one push to the recipient's phone, the fixed wording and no `c`, nothing of who asks; the sender's phone gets nothing", async () => {
    const a = await signUp(app, "CanaryAsker");
    const b = await signUp(app, "req_b");
    const ta = await phone(a);
    const tb = await phone(b);
    const sent = await ask(a, b);
    expect(sent.status).toBe(201);
    await app.push.idle();
    expect(pushedTo()).toEqual([tb]);
    expect(pushedTo()).not.toContain(ta);
    const r = requests()[0]!;
    expect(JSON.parse(r.body)).toEqual(PAYLOAD);
    expect(REQUEST_PUSH_BODY).toBe("你有新的申请");
    expect(r.headers["apns-collapse-id"]).toBe("requests");
    const everything = JSON.stringify({ body: r.body, headers: r.headers });
    for (const canary of ["CanaryAsker", a.handle, a.id, b.handle, b.id, sent.json.id]) expect([canary, everything.includes(canary)]).toEqual([canary, false]);
    expect(app.push.flush()).toMatchObject({ sent: 1, coalesced: 0, present: 0, stale: 0 });
    // The log: one counters line, and nothing of a token, a person or the request in any line of the push's own.
    const pushLines = lines.filter((l) => l.includes('"metric":"push"'));
    expect(pushLines).toHaveLength(1);
    const own = lines.filter((l) => /push|apns/i.test(String(JSON.parse(l).msg)) || String(JSON.parse(l).metric ?? "").startsWith("push"));
    const all = own.join("\n");
    for (const secret of [ta, tb, a.id, b.id, a.handle, b.handle, sent.json.id]) expect([secret, all.includes(secret)]).toEqual([secret, false]);
  });

  test("an add of an Agent that waits for its owner: the owner's phone is pushed, the asker's not; asking again while it waits pushes nothing", async () => {
    const owner = await signUp(app, "rqowner");
    const agentId = await agentOf(owner, "rqcanarybot");
    const visitor = await signUp(app, "rqvisitor");
    const tOwner = await phone(owner);
    const tVisitor = await phone(visitor);
    await app.push.idle();
    fake.apns!.reset();
    expect(await add(visitor, agentId)).toMatchObject({ status: 202, json: { state: "requested" } });
    await app.push.idle();
    expect(pushedTo()).toEqual([tOwner]);
    expect(pushedTo()).not.toContain(tVisitor);
    const r = requests()[0]!;
    expect(JSON.parse(r.body)).toEqual(PAYLOAD);
    expect(r.headers["apns-collapse-id"]).toBe("requests");
    const everything = JSON.stringify({ body: r.body, headers: r.headers });
    for (const canary of ["rqcanarybot", agentId, visitor.handle, visitor.id, owner.id]) expect([canary, everything.includes(canary)]).toEqual([canary, false]);
    // The same add again, while it waits: the same 202, and no push (nothing changed).
    expect(await add(visitor, agentId)).toMatchObject({ status: 202, json: { state: "requested" } });
    await app.push.idle();
    expect(requests()).toHaveLength(1);
  });

  test("an Agent whose setting lets the person in at once (a friend, under 我的好友可以直接添加): no push", async () => {
    const owner = await signUp(app, "rqatonce_owner");
    const agentId = await agentOf(owner, "rqatoncebot");
    const friend = await signUp(app, "rqatonce_friend");
    await db.query("update agents set contact_policy = 'contacts' where principal_id = $1", [agentId]);
    await befriend(app, owner, friend);
    await app.push.idle();
    await phone(owner);
    await phone(friend);
    fake.apns!.reset();
    expect(await add(friend, agentId)).toMatchObject({ status: 201, json: { state: "live" } });
    await app.push.idle();
    expect(requests()).toEqual([]);
  });

  test("nothing but a new request: asking back while one is pending (refused, no friendship at once), an accept, a reject, a withdrawal, a decline, an approval — no push", async () => {
    const a = await signUp(app, "rqnot_a");
    const b = await signUp(app, "rqnot_b");
    const c = await signUp(app, "rqnot_c");
    const owner = await signUp(app, "rqnot_owner");
    const agentId = await agentOf(owner, "rqnotbot");
    const ta = await phone(a);
    const tb = await phone(b);
    const tc = await phone(c);
    const tOwner = await phone(owner);
    await app.push.idle();
    fake.apns!.reset();
    /** What the step pushed (each step starts after the last one's quiet window and waits for its pushes: none is folded into another's). */
    const step = async (fn: () => Promise<void>): Promise<string[]> => {
      windowOver();
      const before = requests().length;
      await fn();
      await app.push.idle();
      return pushedTo().slice(before).sort();
    };
    let first = "";
    expect(
      await step(async () => {
        const r = await ask(a, b);
        expect(r.status).toBe(201);
        first = r.json.id;
      }),
    ).toEqual([tb]);
    // b asks a back while a's request waits: refused, and no friendship is made by it — nothing to push.
    expect(await step(async () => expect(await ask(b, a)).toMatchObject({ status: 409, json: { error: "request_pending" } }))).toEqual([]);
    expect((await api(app, a, "GET", "/api/social")).json.friends).toEqual([]);
    expect(await step(async () => expect((await api(app, b, "POST", `/api/friend-requests/${first}/accept`)).status).toBe(200))).toEqual([]);
    let toB = "";
    let toC = "";
    expect(
      await step(async () => {
        const r1 = await ask(c, b);
        const r2 = await ask(a, c);
        expect([r1.status, r2.status]).toEqual([201, 201]);
        [toB, toC] = [r1.json.id, r2.json.id];
      }),
    ).toEqual([tb, tc].sort());
    expect(await step(async () => expect((await api(app, b, "POST", `/api/friend-requests/${toB}/reject`)).status).toBe(200))).toEqual([]);
    expect(await step(async () => expect((await api(app, a, "POST", `/api/friend-requests/${toC}/withdraw`)).status).toBe(200))).toEqual([]);
    expect(await step(async () => expect((await add(a, agentId)).status).toBe(202))).toEqual([tOwner]);
    expect(await step(async () => expect((await add(c, agentId)).status).toBe(202))).toEqual([tOwner]);
    expect(await step(async () => expect((await api(app, owner, "POST", `/api/agent-contacts/${agentId}/${a.id}/decline`)).status).toBe(200))).toEqual([]);
    expect(await step(async () => expect((await api(app, owner, "POST", `/api/agent-contacts/${agentId}/${c.id}/approve`)).status).toBe(200))).toEqual([]);
    expect(pushedTo()).not.toContain(ta);
  });

  test("the push reads the request itself: one that is blocked either way, past its deadline, no longer pending, or of a deleted Agent is pushed to nobody", async () => {
    const a = await signUp(app, "rqread_a");
    const b = await signUp(app, "rqread_b");
    const owner = await signUp(app, "rqread_owner");
    const agentId = await agentOf(owner, "rqreadbot");
    const tb = await phone(b);
    const tOwner = await phone(owner);
    await app.push.idle();
    fake.apns!.reset();
    // Rows as no route can leave them (a block cancels a pending request and ends an Agent's rows): the push still says no.
    const friendRequest = async (status: string, expires: string) =>
      (await db.query<{ id: string }>(`insert into friend_requests (from_id, to_id, status, expires_at) values ($1, $2, $3, now() + $4::interval) returning id`, [a.id, b.id, status, expires])).rows[0]!.id;
    const block = (blocker: string, blocked: string) => db.query("insert into blocks (blocker_id, blocked_id) values ($1, $2)", [blocker, blocked]);
    const unblock = () => db.query("delete from blocks");
    const waiting = await friendRequest("pending", "1 day");
    for (const [blocker, blocked] of [[b.id, a.id], [a.id, b.id]] as const) {
      await block(blocker, blocked);
      app.push.requestWaiting({ friendRequestId: waiting });
      await app.push.idle();
      await unblock();
    }
    await db.query("update friend_requests set status = 'accepted', resolved_at = now() where id = $1", [waiting]);
    const lapsed = await friendRequest("pending", "-1 minute");
    app.push.requestWaiting({ friendRequestId: lapsed });
    app.push.requestWaiting({ friendRequestId: waiting });
    await app.push.idle();
    await db.query(`insert into agent_contacts (agent_id, subject_id, person_id, state, until) values ($1, $2, $2, 'requested', now() + interval '7 days')`, [agentId, a.id]);
    for (const [blocker, blocked] of [[owner.id, a.id], [a.id, owner.id], [a.id, agentId]] as const) {
      await block(blocker, blocked);
      app.push.requestWaiting({ agentId, subjectId: a.id });
      await app.push.idle();
      await unblock();
    }
    // An add past its `until` (not yet rewritten `expired`), and an add of an Agent deleted since.
    await db.query("update agent_contacts set until = now() - interval '1 minute' where agent_id = $1 and subject_id = $2", [agentId, a.id]);
    app.push.requestWaiting({ agentId, subjectId: a.id });
    await app.push.idle();
    await db.query("update agent_contacts set until = now() + interval '7 days' where agent_id = $1 and subject_id = $2", [agentId, a.id]);
    await db.query("update agents set deleted_at = now() where principal_id = $1", [agentId]);
    app.push.requestWaiting({ agentId, subjectId: a.id });
    await app.push.idle();
    await db.query("update agents set deleted_at = null where principal_id = $1", [agentId]);
    expect(requests()).toEqual([]);
    // Control: the same calls without a block, for requests that wait, push.
    await db.query("update friend_requests set status = 'expired', resolved_at = now() where id = $1", [lapsed]);
    app.push.requestWaiting({ friendRequestId: await friendRequest("pending", "1 day") });
    app.push.requestWaiting({ agentId, subjectId: a.id });
    await app.push.idle();
    expect(pushedTo().sort()).toEqual([tb, tOwner].sort());
  });
});

describe("one at a time, and not while the app is in front", () => {
  test("a second request while the first's push is out: folded into it, one push; once it was sent, the quiet window; after the window the next request pushes again", async () => {
    const b = await signUp(app, "rqout_b");
    const [a, c, d, e] = [await signUp(app, "rqout_a"), await signUp(app, "rqout_c"), await signUp(app, "rqout_d"), await signUp(app, "rqout_e")];
    const tb = await phone(b);
    let release!: (x: { status: number }) => void;
    fake.apns!.answer({ hold: new Promise((r) => (release = r)) });
    expect((await ask(a, b)).status).toBe(201);
    await fake.apns!.waitFor(1);
    expect((await ask(c, b)).status).toBe(201);
    await new Promise((r) => setTimeout(r, 50));
    release({ status: 200 });
    // The moment its push is over the window holds: the next one finds the one or the other, never neither.
    expect((await ask(d, b)).status).toBe(201);
    await app.push.idle();
    expect(pushedTo()).toEqual([tb]);
    expect(app.push.flush()).toMatchObject({ sent: 1, coalesced: 2 });
    windowOver();
    expect((await ask(e, b)).status).toBe(201);
    await app.push.idle();
    expect(pushedTo()).toEqual([tb, tb]);
  });

  test("a message's push and a request's are not one: a message while the request's push is out is pushed too, with its own collapse id", async () => {
    const a = await signUp(app, "rqmix_a");
    const b = await signUp(app, "rqmix_b");
    const c = await signUp(app, "rqmix_c");
    const { conversationId } = await befriend(app, a, b);
    await app.push.idle();
    await phone(b);
    fake.apns!.reset();
    let release!: (x: { status: number }) => void;
    fake.apns!.answer({ hold: new Promise((r) => (release = r)) });
    expect((await ask(c, b)).status).toBe(201);
    await fake.apns!.waitFor(1);
    expect((await api(app, a, "POST", `/api/conversations/${conversationId}/messages`, { text: "hi", clientTxn: "rqmix1" })).status).toBe(201);
    await fake.apns!.waitFor(2);
    release({ status: 200 });
    await app.push.idle();
    expect(requests().map((r) => r.headers["apns-collapse-id"])).toEqual(["requests", conversationId]);
    expect(app.push.flush()).toMatchObject({ sent: 2, coalesced: 0 });
  });

  test("the recipient's app in front (its own session's socket answers): not pushed, counted present", async () => {
    const a = await signUp(app, "rqfront_a");
    const b = await signUp(app, "rqfront_b");
    await phone(b);
    const s = await connect(app, b);
    expect((await ask(a, b)).status).toBe(201);
    await app.push.idle();
    expect(requests()).toEqual([]);
    expect(app.push.flush()).toMatchObject({ sent: 0, present: 1 });
    s.close();
  });

  test("asked and silent, the request still waiting: pushed once the probe ends", async () => {
    const a = await signUp(app, "rqghost_a");
    const b = await signUp(app, "rqghost_b");
    const tb = await phone(b);
    await silentSocket(b);
    const t0 = Date.now();
    expect((await ask(a, b)).status).toBe(201);
    await app.push.idle();
    expect(pushedTo()).toEqual([tb]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(PRESENCE_PROBE_MS - 50);
    expect(app.push.flush()).toMatchObject({ sent: 1, stale: 0 });
  });

  test("asked and silent, and meanwhile the friend request was withdrawn: no push, counted stale", async () => {
    const a = await signUp(app, "rqwd_a");
    const b = await signUp(app, "rqwd_b");
    await phone(b);
    const raw = await silentSocket(b);
    const sent = await ask(a, b);
    expect(sent.status).toBe(201);
    await untilPinged(raw);
    expect((await api(app, a, "POST", `/api/friend-requests/${sent.json.id}/withdraw`)).status).toBe(200);
    await app.push.idle();
    expect(requests()).toEqual([]);
    expect(app.push.flush()).toMatchObject({ sent: 0, stale: 1 });
  });

  test("asked and silent, and meanwhile the add was taken back by who asked: no push to the owner, counted stale", async () => {
    const owner = await signUp(app, "rqleft_owner");
    const agentId = await agentOf(owner, "rqleftbot");
    const v = await signUp(app, "rqleft_v");
    await phone(owner);
    const raw = await silentSocket(owner);
    await app.push.idle();
    fake.apns!.reset();
    app.push.flush();
    expect((await add(v, agentId)).status).toBe(202);
    await untilPinged(raw);
    expect((await api(app, v, "DELETE", `/api/agent-contacts/${agentId}/${v.id}`)).status).toBe(200);
    await app.push.idle();
    expect(requests()).toEqual([]);
    expect(app.push.flush()).toMatchObject({ sent: 0, stale: 1 });
  });

  test("asked and silent, a second request folded into the push: the first withdrawn meanwhile, the push still goes for the second; both withdrawn, stale", async () => {
    for (const gone of ["first", "both"] as const) {
      requests().length = 0;
      app.push.flush();
      const [a, b, c] = [await signUp(app, `rqfold_a_${gone}`), await signUp(app, `rqfold_b_${gone}`), await signUp(app, `rqfold_c_${gone}`)];
      const tb = await phone(b);
      const raw = await silentSocket(b);
      const first = await ask(a, b);
      expect(first.status).toBe(201);
      await untilPinged(raw);
      const second = await ask(c, b);
      expect(second.status).toBe(201);
      expect((await withdraw(a, first.json.id)).status).toBe(200);
      if (gone === "both") expect((await withdraw(c, second.json.id)).status).toBe(200);
      await app.push.idle();
      expect([gone, pushedTo()]).toEqual([gone, gone === "first" ? [tb] : []]);
      expect([gone, app.push.flush()]).toMatchObject([gone, gone === "first" ? { sent: 1, coalesced: 1, stale: 0 } : { sent: 0, coalesced: 1, stale: 1 }]);
    }
  }, 30_000);

  test("asked and silent, a friend request and an add of one of the person's Agents in one push: the friend request withdrawn, the push goes for the add", async () => {
    const b = await signUp(app, "rqmixfold_b");
    const agentId = await agentOf(b, "rqmixfoldbot");
    const a = await signUp(app, "rqmixfold_a");
    const v = await signUp(app, "rqmixfold_v");
    const tb = await phone(b);
    const raw = await silentSocket(b);
    await app.push.idle();
    fake.apns!.reset();
    app.push.flush();
    const sent = await ask(a, b);
    expect(sent.status).toBe(201);
    await untilPinged(raw);
    expect((await add(v, agentId)).status).toBe(202);
    expect((await withdraw(a, sent.json.id)).status).toBe(200);
    await app.push.idle();
    expect(pushedTo()).toEqual([tb]);
    expect(app.push.flush()).toMatchObject({ sent: 1, coalesced: 1, stale: 0 });
  });

  test("a phone whose session expired gets nothing", async () => {
    const a = await signUp(app, "rqexp_a");
    const b = await signUp(app, "rqexp_b");
    const tb = await phone(b);
    await db.query(`update "session" set "expiresAt" = now() - interval '1 minute' where id = (select session_id from push_devices where token = $1)`, [tb]);
    expect((await ask(a, b)).status).toBe(201);
    await app.push.idle();
    expect(requests()).toEqual([]);
  });
});

describe("the quiet window: after one was sent to a phone, no other for REQUEST_QUIET_MS", () => {
  test("send, withdraw, send again: one push, the second counted coalesced; an add of the person's Agent within the window: none either; after the window, pushed again", async () => {
    const a = await signUp(app, "rqq_a");
    const b = await signUp(app, "rqq_b");
    const agentId = await agentOf(b, "rqqbot");
    const v = await signUp(app, "rqq_v");
    const c = await signUp(app, "rqq_c");
    const tb = await phone(b);
    await app.push.idle();
    fake.apns!.reset();
    app.push.flush();
    const first = await ask(a, b);
    expect(first.status).toBe(201);
    await app.push.idle();
    expect(pushedTo()).toEqual([tb]);
    expect((await withdraw(a, first.json.id)).status).toBe(200);
    expect((await ask(a, b)).status).toBe(201);
    await app.push.idle();
    expect((await add(v, agentId)).status).toBe(202);
    await app.push.idle();
    expect(pushedTo()).toEqual([tb]);
    expect(app.push.flush()).toMatchObject({ sent: 1, coalesced: 2 });
    expect(REQUEST_QUIET_MS).toBe(10 * 60_000);
    // A minute short of the window: still quiet. At its end: pushed again.
    clock.advance(REQUEST_QUIET_MS - 60_000);
    const late = await ask(c, b);
    expect(late.status).toBe(201);
    await app.push.idle();
    expect(pushedTo()).toEqual([tb]);
    clock.advance(60_000);
    expect((await withdraw(c, late.json.id)).status).toBe(200);
    expect((await ask(c, b)).status).toBe(201);
    await app.push.idle();
    expect(pushedTo()).toEqual([tb, tb]);
  });

  test("a push that told the person nothing starts no window: present, or refused by APNs — the next request is pushed", async () => {
    const [a, b, c, d] = [await signUp(app, "rqqn_a"), await signUp(app, "rqqn_b"), await signUp(app, "rqqn_c"), await signUp(app, "rqqn_d")];
    const tb = await phone(b);
    const td = await phone(d);
    // b's app in front: present, no window; then in the background: pushed.
    const s = await connect(app, b);
    expect((await ask(a, b)).status).toBe(201);
    await app.push.idle();
    expect(app.push.flush()).toMatchObject({ sent: 0, present: 1 });
    s.close();
    await s.closed;
    const session = await sessionOf(tb);
    for (let i = 0; i < 200 && app.realtime.hasSocketFor(session); i++) await new Promise((r) => setTimeout(r, 5));
    expect((await ask(c, b)).status).toBe(201);
    await app.push.idle();
    expect(pushedTo()).toEqual([tb]);
    // d's push refused by APNs: no window; the next is sent.
    fake.apns!.answer({ status: 400, reason: "BadCollapseId" });
    expect((await ask(a, d)).status).toBe(201);
    await app.push.idle();
    expect((await ask(c, d)).status).toBe(201);
    await app.push.idle();
    expect(pushedTo()).toEqual([tb, td, td]);
    expect(app.push.flush()).toMatchObject({ sent: 2, coalesced: 0, failed: { rejected: 1 } });
  });

  test("the window is the phone's: the person's other phone and another person's phone are pushed, and a message's push inside the window goes as ever", async () => {
    const [a, b, c, d, e] = [await signUp(app, "rqqp_a"), await signUp(app, "rqqp_b"), await signUp(app, "rqqp_c"), await signUp(app, "rqqp_d"), await signUp(app, "rqqp_e")];
    const { conversationId } = await befriend(app, a, b);
    await app.push.idle();
    const p1 = await phone(b);
    fake.apns!.reset();
    expect((await ask(c, b)).status).toBe(201);
    await app.push.idle();
    expect(pushedTo()).toEqual([p1]);
    // b's second phone, registered within p1's window: pushed for the next request; p1 is not.
    const p2 = await phone(await anotherSession(b));
    expect((await ask(e, b)).status).toBe(201);
    await app.push.idle();
    expect(pushedTo()).toEqual([p1, p2]);
    const td = await phone(d);
    expect((await ask(c, d)).status).toBe(201);
    await app.push.idle();
    expect(pushedTo()).toEqual([p1, p2, td]);
    expect((await api(app, a, "POST", `/api/conversations/${conversationId}/messages`, { text: "hi", clientTxn: "rqqp1" })).status).toBe(201);
    await app.push.idle();
    expect(
      requests()
        .slice(3)
        .map((r) => [r.path.replace("/3/device/", ""), r.headers["apns-collapse-id"]])
        .sort(),
    ).toEqual([[p1, conversationId], [p2, conversationId]].sort());
    expect(app.push.flush()).toMatchObject({ sent: 5, coalesced: 1 });
  });

  test("the windows are forgotten once over: none is held after the window and the sweep", async () => {
    windowOver();
    await app.push.sweepExpired();
    expect(app.push.quietWindows).toBe(0);
    const a = await signUp(app, "rqqf_a");
    const b = await signUp(app, "rqqf_b");
    await phone(b);
    expect((await ask(a, b)).status).toBe(201);
    await app.push.idle();
    expect(app.push.quietWindows).toBe(1);
    await app.push.sweepExpired();
    expect(app.push.quietWindows).toBe(1);
    windowOver();
    await app.push.sweepExpired();
    expect(app.push.quietWindows).toBe(0);
  });
});

describe("the request never waits on the push", () => {
  test("APNs slow to answer: the request is answered first; APNs failing outright: the request is answered all the same", async () => {
    const a = await signUp(app, "rqslow_a");
    const b = await signUp(app, "rqslow_b");
    const owner = await signUp(app, "rqslow_owner");
    const agentId = await agentOf(owner, "rqslowbot");
    await phone(b);
    await phone(owner);
    await app.push.idle();
    fake.apns!.reset();
    let release!: (x: { status: number }) => void;
    fake.apns!.answer({ hold: new Promise((r) => (release = r)) });
    expect((await ask(a, b)).status).toBe(201);
    await fake.apns!.waitFor(1);
    // Answered while its push is still out at APNs.
    expect(app.push.flush()).toMatchObject({ sent: 0 });
    release({ status: 200 });
    await app.push.idle();
    expect(app.push.flush()).toMatchObject({ sent: 1 });
    // (b's phone was sent one: past its quiet window, so that the next is tried.)
    windowOver();
    const shared = real;
    real = { send: () => Promise.reject(Object.assign(new Error("CANARY-APNS-DOWN"), { code: "ECONNRESET" })), close: async () => {} };
    try {
      expect((await ask(owner, b)).status).toBe(201);
      expect((await add(a, agentId)).status).toBe(202);
      await app.push.idle();
      const failed = lines.filter((l) => l.includes('"metric":"push_failed"'));
      expect(failed).toHaveLength(2);
      for (const l of failed) expect(l).not.toMatch(/CANARY|rqslow/);
    } finally {
      real = shared;
    }
  });
});

describe("push not configured", () => {
  const { app: plain } = useApp({ env: { ...SITE_ENV, APPLE_TEAM_ID: "ABCDE12345", APPLE_BUNDLE_ID: "org.haiyo.app" }, config: SOCIAL_ON, agentWorker: false });

  test("requests are made as ever; nothing is read for a push, nothing is sent", async () => {
    expect(plain.deps.apns).toBeNull();
    const a = await signUp(plain, "rqoff_a");
    const b = await signUp(plain, "rqoff_b");
    const agentId = ((await mustCreateAgent(plain, b, { handle: "rqoffbot" })) as { id: string }).id;
    expect((await api(plain, b, "POST", "/api/push/devices", { token: "cd".repeat(32), env: "production" })).status).toBe(200);
    const query = vi.spyOn(plain.deps.db, "query");
    try {
      expect((await api(plain, a, "POST", "/api/friend-requests", { handle: b.handle })).status).toBe(201);
      expect((await api(plain, a, "POST", "/api/agent-contacts", { agentId })).status).toBe(202);
      await plain.push.idle();
      const texts = query.mock.calls.map((c) => String(typeof c[0] === "string" ? c[0] : (c[0] as { text?: string }).text));
      expect(texts.filter((t) => t.includes("push_devices"))).toEqual([]);
    } finally {
      query.mockRestore();
    }
    expect(plain.push.flush()).toEqual({ sent: 0, removed: 0, present: 0, coalesced: 0, stale: 0, failed: {} });
  });
});

describe("the social switch off", () => {
  // Its own forwarder: this app's stop must not close the sender the file's other app still uses.
  const forward: ApnsClient = { send: (n) => real!.send(n), close: async () => {} };
  const { app: off } = useApp({ env: SITE_ENV, agentWorker: false, apns: forward });

  test("a friend request is pushed as ever; an add of an Agent does not exist, nor does its push", async () => {
    const a = await signUp(off, "rqsw_a");
    const b = await signUp(off, "rqsw_b");
    const agentId = ((await mustCreateAgent(off, b, { handle: "rqswbot" })) as { id: string }).id;
    const token = randomBytes(32).toString("hex");
    expect((await api(off, b, "POST", "/api/push/devices", { token, env: "production" })).status).toBe(200);
    fake.apns!.reset();
    expect((await api(off, a, "POST", "/api/friend-requests", { handle: b.handle })).status).toBe(201);
    expect((await api(off, a, "POST", "/api/agent-contacts", { agentId })).status).toBe(404);
    await off.push.idle();
    expect(pushedTo()).toEqual([token]);
  });
});
