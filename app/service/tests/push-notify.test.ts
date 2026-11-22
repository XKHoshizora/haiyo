import { generateKeyPairSync } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { StoredMessage } from "../src/messages/model.ts";
import { createApnsClient, type ApnsClient } from "../src/push/apns.ts";
import { countsForPush, PUSH_BODY } from "../src/push/notify.ts";
import { api, befriend, cookieHeaderFrom, group, signIn, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { fakeApns, type FakeApns } from "./helpers/apns.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { closeAllSockets, connect, type TestSocket } from "./helpers/ws.ts";

/**
 * When a push goes, to whom, and what it carries (src/push/notify.ts; README "Push notifications").
 *
 * The rule as built: a message that counts as unread (not a system notice, not an Agent's acknowledgement) is pushed to
 * each phone (`push_devices` row) of each current member who can see it (THE visibility rule), but not the sender, nor
 * anyone with a block either way between them and the sender; a phone whose session has ended or expired is never pushed
 * to; and a phone is skipped while ITS OWN session has a socket registered at the hub (src/sync/hub.ts `bySession`) —
 * the shell's page closes its socket when the app goes to the background (`haiyo:pause`), so a phone in the background,
 * or one whose socket died, gets the push even while the same person has the web open elsewhere.
 *
 * Every push is content-free: the fixed system wording, the conversation's id (to open it), and a collapse id.
 */

const fake: { apns?: FakeApns } = {};
let real: ApnsClient | null = null;
// The app is built before the fake listens: the client it is given forwards to one made for the fake's address.
const apns: ApnsClient = { send: (n) => real!.send(n), close: async () => {} };
const lines: string[] = [];
const gateway = scriptedGateway();
const { app, db } = useApp({ env: SITE_ENV, models: gateway, agentWorker: false, apns, logStream: { write: (l) => void lines.push(l) } });

beforeAll(async () => {
  fake.apns = await fakeApns();
  const pem = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  real = createApnsClient({ teamId: "ABCDE12345", keyId: "KEY1234567", keyPem: pem, topic: "org.haiyo.app", origins: { production: fake.apns.url, sandbox: fake.apns.url }, retryDelaysMs: [5, 10] });
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
afterEach(async () => {
  await closeAllSockets();
  expect(gateway.pending()).toBe(0);
});

const requests = () => fake.apns!.requests;
let tokens = 0;
/** A fresh token (hex, 32 bytes) for a phone. */
const newToken = () => (++tokens).toString(16).padStart(4, "0").repeat(16);
let txn = 0;
const say = async (who: Actor, conv: string, text: string) => {
  const r = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `p${++txn}` });
  expect(r.status).toBe(201);
  await app.push.idle();
  return r.json.message;
};
/** `who` signs in once more: another session (another phone, or the web on a desktop). */
const anotherSession = async (who: Actor): Promise<Actor> => ({ ...who, cookie: cookieHeaderFrom((await signIn(app, who.email, who.password)).headers["set-cookie"]) });
/** Registers a phone for `who`'s session; returns its token. */
const phone = async (who: Actor): Promise<string> => {
  const token = newToken();
  expect((await api(app, who, "POST", "/api/push/devices", { token, env: "production" })).status).toBe(200);
  return token;
};
const pushedTo = () => requests().map((r) => r.path.replace("/3/device/", ""));
async function sessionIdOf(who: Actor): Promise<string> {
  const token = decodeURIComponent(who.cookie.split("=")[1]!.split(";")[0]!).split(".")[0]!;
  return (await db.query<{ id: string }>(`select id from "session" where token = $1`, [token])).rows[0]!.id;
}
/** Waits until the hub no longer holds a socket of `who`'s session (its close has been seen). */
async function untilGone(who: Actor): Promise<void> {
  const id = await sessionIdOf(who);
  for (let i = 0; i < 200 && app.realtime.hasSocketFor(id); i++) await new Promise((r) => setTimeout(r, 5));
  expect(app.realtime.hasSocketFor(id)).toBe(false);
}

describe("what a push carries", () => {
  test("a direct message: one push to the other person's phone, with nothing of the message, its sender or its conversation's name", async () => {
    const a = await signUp(app, "CanarySender");
    const b = await signUp(app, "reader_b");
    const { conversationId } = await befriend(app, a, b);
    const token = await phone(b);
    const text = "CANARY-MESSAGE-TEXT 晚上见";
    await say(a, conversationId, text);
    expect(pushedTo()).toEqual([token]);
    const r = requests()[0]!;
    expect(JSON.parse(r.body)).toEqual({ aps: { alert: { title: "Haiyo", body: PUSH_BODY }, sound: "default", "thread-id": conversationId }, c: conversationId });
    expect(PUSH_BODY).toBe("你有新消息");
    expect(r.headers["apns-collapse-id"]).toBe(conversationId);
    const everything = JSON.stringify({ body: r.body, headers: r.headers });
    for (const canary of ["CANARY", "晚上见", "CanarySender", a.handle, a.id]) expect([canary, everything.includes(canary)]).toEqual([canary, false]);
  });

  test("a group message: one push to each other member's phone, none to the sender's, nothing of the group's name", async () => {
    const a = await signUp(app, "group_sender");
    const b = await signUp(app, "group_b");
    const c = await signUp(app, "group_c");
    const conv = await group(app, a, "CANARY-GROUP-TITLE", [b, c]);
    await phone(a);
    const tb = await phone(b);
    const tc = await phone(c);
    requests().length = 0;
    await say(a, conv, "CANARY-IN-GROUP");
    expect(pushedTo().sort()).toEqual([tb, tc].sort());
    for (const r of requests()) {
      expect(JSON.parse(r.body).c).toBe(conv);
      expect(JSON.stringify({ body: r.body, headers: r.headers })).not.toMatch(/CANARY|group_sender/);
    }
  });

  test("collapse per conversation: two conversations, two collapse ids; the same one twice, the same id", async () => {
    const a = await signUp(app, "two_convs_a");
    const b = await signUp(app, "two_convs_b");
    const c = await signUp(app, "two_convs_c");
    const { conversationId: direct } = await befriend(app, a, b);
    const conv = await group(app, a, "g", [b, c]);
    await phone(b);
    requests().length = 0;
    await say(a, direct, "one");
    await say(a, conv, "two");
    await say(a, direct, "three");
    expect(requests().map((r) => r.headers["apns-collapse-id"])).toEqual([direct, conv, direct]);
  });
});

describe("present: the phone's own session has a socket", () => {
  test("the page open in the app (its socket on the phone's session): no push", async () => {
    const a = await signUp(app, "present_a");
    const b = await signUp(app, "present_b");
    const { conversationId } = await befriend(app, a, b);
    await phone(b);
    const s = await connect(app, b);
    await say(a, conversationId, "you see this live");
    expect(requests()).toEqual([]);
    s.close();
  });

  test("paused (the page closed its socket): the next message is pushed at once", async () => {
    const a = await signUp(app, "paused_a");
    const b = await signUp(app, "paused_b");
    const { conversationId } = await befriend(app, a, b);
    const token = await phone(b);
    const s = await connect(app, b);
    s.close();
    await s.closed;
    await untilGone(b);
    await say(a, conversationId, "in the background");
    expect(pushedTo()).toEqual([token]);
  });

  test("the web open on a desktop (another session's socket) does not keep the phone from its push", async () => {
    const a = await signUp(app, "desk_a");
    const b = await signUp(app, "desk_b");
    const { conversationId } = await befriend(app, a, b);
    const token = await phone(b);
    const desktop = await anotherSession(b);
    const s: TestSocket = await connect(app, desktop);
    await say(a, conversationId, "while at the desk");
    expect(pushedTo()).toEqual([token]);
    s.close();
  });

  test("two phones: the one in front (socket open) gets nothing, the one in the background gets the push", async () => {
    const a = await signUp(app, "phones_a");
    const b = await signUp(app, "phones_b");
    const { conversationId } = await befriend(app, a, b);
    const front = await phone(b);
    const second = await anotherSession(b);
    const back = await phone(second);
    expect(front).not.toBe(back);
    const s = await connect(app, b);
    await say(a, conversationId, "hello");
    expect(pushedTo()).toEqual([back]);
    s.close();
  });

  test("the hub's answer is by session: registered while a socket of it is attached, not once it is gone", async () => {
    const b = await signUp(app, "hub_b");
    const id = await sessionIdOf(b);
    expect(app.realtime.hasSocketFor(id)).toBe(false);
    const s = await connect(app, b);
    expect(app.realtime.hasSocketFor(id)).toBe(true);
    s.close();
    await untilGone(b);
  });
});

describe("what is pushed and to whom", () => {
  test("an Agent's reply in its owner's own conversation is pushed to the owner; the owner's own message is not", async () => {
    const owner = await signUp(app, "agent_owner");
    const agent = await mustCreateAgent(app, owner, { model: { source: "site", id: "fast" }, persona: "你是一个说话简洁的助手。" });
    const token = await phone(owner);
    await say(owner, agent.conversationId, "CANARY-QUESTION");
    expect(requests()).toEqual([]);
    gateway.reply("CANARY-AGENT-REPLY");
    expect(await app.agentWorker.runOnce()).toBe(true);
    await app.push.idle();
    expect(pushedTo()).toEqual([token]);
    expect(JSON.parse(requests()[0]!.body)).toEqual({ aps: { alert: { title: "Haiyo", body: PUSH_BODY }, sound: "default", "thread-id": agent.conversationId }, c: agent.conversationId });
    expect(JSON.stringify(requests()[0])).not.toContain("CANARY");
  });

  test("system notices are not pushed (a group renamed, a member added)", async () => {
    const a = await signUp(app, "notice_a");
    const b = await signUp(app, "notice_b");
    const c = await signUp(app, "notice_c");
    const d = await signUp(app, "notice_d");
    const conv = await group(app, a, "before", [b, c]);
    await phone(b);
    await befriend(app, a, d);
    requests().length = 0;
    expect((await api(app, a, "PATCH", `/api/conversations/${conv}`, { title: "after" })).status).toBe(200);
    expect((await api(app, a, "POST", `/api/conversations/${conv}/members`, { principalId: d.id })).status).toBe(201);
    await app.push.idle();
    expect(requests()).toEqual([]);
  });

  test("countsForPush: what counts as unread does — not a system notice, not an Agent's acknowledgement", () => {
    const m = (over: Partial<StoredMessage>): StoredMessage => ({ id: "1", conversationId: "c", seq: 1, senderId: "s", kind: "text", body: { text: "x" }, clientTxn: null, createdAt: new Date(), mentions: null, asksAgent: false, ...over });
    expect(countsForPush(m({}))).toBe(true);
    expect(countsForPush(m({ kind: "file", body: { attachment: { id: "a", name: "n", size: 1, inline: false } } }))).toBe(true);
    expect(countsForPush(m({ kind: "system", body: { event: "group_renamed", text: "x" } }))).toBe(false);
    expect(countsForPush(m({ body: { text: "收到", ack: true } }))).toBe(false);
  });

  test("a block either way between the sender and a member: that member's phone gets nothing; the others' do", async () => {
    const a = await signUp(app, "block_a");
    const b = await signUp(app, "block_b");
    const c = await signUp(app, "block_c");
    const d = await signUp(app, "block_d");
    const conv = await group(app, a, "g", [b, c, d]);
    await phone(b);
    await phone(c);
    const td = await phone(d);
    expect((await api(app, b, "PUT", `/api/blocks/${a.id}`)).status).toBe(200);
    expect((await api(app, a, "PUT", `/api/blocks/${c.id}`)).status).toBe(200);
    requests().length = 0;
    await say(a, conv, "hi");
    expect(pushedTo()).toEqual([td]);
  });

  test("a member who left, and a phone whose session expired, get nothing", async () => {
    const a = await signUp(app, "gone_a");
    const b = await signUp(app, "gone_b");
    const c = await signUp(app, "gone_c");
    const conv = await group(app, a, "g", [b, c]);
    await phone(b);
    await phone(c);
    expect((await api(app, c, "DELETE", `/api/conversations/${conv}/members/${c.id}`)).status).toBeLessThan(300);
    await db.query(`update "session" set "expiresAt" = now() - interval '1 minute' where id = $1`, [await sessionIdOf(b)]);
    requests().length = 0;
    await say(a, conv, "anyone?");
    expect(requests()).toEqual([]);
  });
});

describe("what APNs answers, and what is logged", () => {
  test("410: the device is deleted; the counters count it; the log has counters only — no token, conversation id or text", async () => {
    const a = await signUp(app, "dead_a");
    const b = await signUp(app, "dead_b");
    const { conversationId } = await befriend(app, a, b);
    const token = await phone(b);
    fake.apns!.answer({ status: 410, reason: "Unregistered" });
    await say(a, conversationId, "CANARY-LOGGED-TEXT");
    expect((await db.query("select 1 from push_devices where token = $1", [token])).rowCount).toBe(0);
    await say(a, conversationId, "again");
    expect(requests()).toHaveLength(1);
    const stats = app.push.flush();
    expect(stats).toEqual({ sent: 0, removed: 1, present: 0, failed: {} });
    const pushLines = lines.filter((l) => l.includes('"metric":"push"'));
    expect(pushLines).toHaveLength(1);
    expect(JSON.parse(pushLines[0]!)).toMatchObject({ metric: "push", sent: 0, removed: 1, present: 0 });
    // Every line of the push's own (the request log names the conversation in a route's path, as it always has).
    const own = lines.filter((l) => /push|apns/i.test(String(JSON.parse(l).msg)) || String(JSON.parse(l).metric ?? "").startsWith("push"));
    expect(own.length).toBeGreaterThan(0);
    const all = own.join("\n");
    for (const secret of [token, conversationId, "CANARY", a.id, b.id]) expect([secret, all.includes(secret)]).toEqual([secret, false]);
  });

  test("sent, skipped as present and failed by class are counted; a counter line only when something happened", async () => {
    const a = await signUp(app, "count_a");
    const b = await signUp(app, "count_b");
    const c = await signUp(app, "count_c");
    const conv = await group(app, a, "g", [b, c]);
    await phone(b);
    await phone(c);
    const s = await connect(app, c);
    fake.apns!.answer({ status: 400, reason: "BadCollapseId" });
    await say(a, conv, "one");
    await say(a, conv, "two");
    s.close();
    expect(app.push.flush()).toEqual({ sent: 1, removed: 0, present: 2, failed: { rejected: 1 } });
    lines.length = 0;
    expect(app.push.flush()).toEqual({ sent: 0, removed: 0, present: 0, failed: {} });
    expect(lines.filter((l) => l.includes('"metric":"push"'))).toEqual([]);
  });
});

describe("push not configured", () => {
  const off: string[] = [];
  const { app: plain } = useApp({ env: { APPLE_TEAM_ID: "ABCDE12345", APPLE_BUNDLE_ID: "org.haiyo.app" }, logStream: { write: (l) => void off.push(l) } });

  test("one line at start names what is missing; messages are sent as ever, nothing is pushed", async () => {
    const line = off.find((l) => l.includes('"metric":"push_off"'));
    expect(line).toBeDefined();
    expect(JSON.parse(line!).missing).toEqual(["APNS_KEY_ID", "APNS_KEY_P8"]);
    expect(plain.deps.apns).toBeNull();
    const a = await signUp(plain, "off_a");
    const b = await signUp(plain, "off_b");
    const { conversationId } = await befriend(plain, a, b);
    expect((await api(plain, b, "POST", "/api/push/devices", { token: "cd".repeat(32), env: "production" })).status).toBe(200);
    expect((await api(plain, a, "POST", `/api/conversations/${conversationId}/messages`, { text: "hi", clientTxn: "off1" })).status).toBe(201);
    await plain.push.idle();
    expect(plain.push.flush()).toEqual({ sent: 0, removed: 0, present: 0, failed: {} });
  });
});
