import { generateKeyPairSync, randomBytes } from "node:crypto";
import net from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { MESSAGE_COLUMNS, toStored, type MessageRow, type StoredMessage } from "../src/messages/model.ts";
import { createApnsClient, type ApnsClient } from "../src/push/apns.ts";
import { countsForPush, PRESENCE_PROBE_MS, PUSH_BODY } from "../src/push/notify.ts";
import { api, befriend, cookieHeaderFrom, group, signIn, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { fakeApns, type FakeApns } from "./helpers/apns.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { APP_ORIGIN, closeAllSockets, connect, issueTicket, listen, type TestSocket } from "./helpers/ws.ts";

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
const apns: ApnsClient = { send: (n) => real!.send(n), close: async (grace) => real?.close(grace) };
const lines: string[] = [];
const gateway = scriptedGateway();
const { app, db } = useApp({ env: SITE_ENV, models: gateway, agentWorker: false, apns, logStream: { write: (l) => void lines.push(l) } });

const PEM = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
/** A sender pointed at the fake (a test that pauses it swaps in its own: see `real`). */
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
/**
 * A WebSocket of `who`'s, upgraded by hand on a raw TCP connection that never answers anything (no pong, no close) and,
 * with `allowHalfOpen`, keeps its side open when the server ends its own: a suspended phone's socket.
 */
async function rawSocket(who: Actor): Promise<{ socket: net.Socket; received: () => Buffer }> {
  const { port } = await listen(app);
  const ticket = await issueTicket(app, who);
  const socket = net.connect({ port, host: "127.0.0.1", allowHalfOpen: true });
  socket.on("error", () => {});
  let buffer = Buffer.alloc(0);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () =>
      socket.write(
        [`GET /api/ws?ticket=${encodeURIComponent(ticket)} HTTP/1.1`, `Host: 127.0.0.1:${port}`, "Upgrade: websocket", "Connection: Upgrade",
          `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`, "Sec-WebSocket-Version: 13", `Origin: ${APP_ORIGIN}`, "", ""].join("\r\n"),
      ),
    );
    let upgraded = false;
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (upgraded) return;
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const head = buffer.subarray(0, end).toString();
      buffer = buffer.subarray(end + 4);
      if (!head.startsWith("HTTP/1.1 101")) return reject(new Error(head.split("\r\n")[0]));
      upgraded = true;
      resolve();
    });
  });
  raws.add(socket);
  return { socket, received: () => buffer };
}
/** The opcodes of the server's frames in `buf` (unmasked, as a server sends them): 0x1 text, 0x8 close, 0x9 ping. */
function frames(buf: Buffer): number[] {
  const ops: number[] = [];
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
    ops.push(buf[i]! & 0x0f);
    i += head + len;
  }
  return ops;
}
const raws = new Set<net.Socket>();
afterEach(() => {
  for (const s of raws) s.destroy();
  raws.clear();
});

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
    // Its socket was asked (a ping) and answered: present.
    expect(app.push.flush()).toMatchObject({ sent: 0, present: 1 });
    s.close();
  });

  test("a socket that is open but silent (the app suspended, its close never sent): asked, no answer within the window, pushed", async () => {
    const a = await signUp(app, "ghost_a");
    const b = await signUp(app, "ghost_b");
    const { conversationId } = await befriend(app, a, b);
    const token = await phone(b);
    const raw = await rawSocket(b);
    expect(app.realtime.hasSocketFor(await sessionIdOf(b))).toBe(true);
    const t0 = Date.now();
    await say(a, conversationId, "after the lock");
    expect(pushedTo()).toEqual([token]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(PRESENCE_PROBE_MS - 50);
    expect(frames(raw.received()).filter((f) => f === 0x9)).toHaveLength(1); // one ping
  });

  test("the socket closes while it is asked: pushed at once, not at the window's end", async () => {
    const a = await signUp(app, "drops_a");
    const b = await signUp(app, "drops_b");
    const { conversationId } = await befriend(app, a, b);
    const token = await phone(b);
    const raw = await rawSocket(b);
    const t0 = Date.now();
    expect((await api(app, a, "POST", `/api/conversations/${conversationId}/messages`, { text: "x", clientTxn: "drops1" })).status).toBe(201);
    for (let i = 0; i < 100 && !frames(raw.received()).includes(0x9); i++) await new Promise((r) => setTimeout(r, 5));
    raw.socket.destroy();
    await app.push.idle();
    expect(pushedTo()).toEqual([token]);
    expect(Date.now() - t0).toBeLessThan(PRESENCE_PROBE_MS - 500);
  });

  test("asked and silent, but meanwhile the message was read elsewhere, the phone signed out, or its token moved: no push", async () => {
    for (const meanwhile of ["read", "signed out", "moved"] as const) {
      requests().length = 0;
      app.push.flush();
      const a = await signUp(app, `mean_a_${meanwhile.replace(" ", "_")}`);
      const b = await signUp(app, `mean_b_${meanwhile.replace(" ", "_")}`);
      const other = await signUp(app, `mean_c_${meanwhile.replace(" ", "_")}`);
      const { conversationId } = await befriend(app, a, b);
      const token = await phone(b);
      const raw = await rawSocket(b);
      const sent = await api(app, a, "POST", `/api/conversations/${conversationId}/messages`, { text: "x", clientTxn: `mean-${meanwhile.replace(" ", "-")}` });
      expect(sent.status).toBe(201);
      for (let i = 0; i < 100 && !frames(raw.received()).includes(0x9); i++) await new Promise((r) => setTimeout(r, 5));
      // During the 3 s the phone's socket is asked:
      if (meanwhile === "read") expect((await api(app, b, "POST", `/api/conversations/${conversationId}/read`, { seq: sent.json.message.seq })).status).toBe(200);
      if (meanwhile === "signed out") expect((await api(app, b, "POST", "/api/auth/sign-out", {})).status).toBe(200);
      if (meanwhile === "moved") expect((await api(app, other, "POST", "/api/push/devices", { token, env: "production" })).status).toBe(200);
      await app.push.idle();
      expect([meanwhile, requests().length]).toEqual([meanwhile, 0]);
      expect([meanwhile, app.push.flush()]).toMatchObject([meanwhile, { sent: 0, stale: 1 }]);
    }
  });

  test("the first message read elsewhere during the ask, a newer one coalesced into it: the push still goes, for the newer one", async () => {
    const a = await signUp(app, "newer_a");
    const b = await signUp(app, "newer_b");
    const { conversationId } = await befriend(app, a, b);
    const token = await phone(b);
    const raw = await rawSocket(b);
    const first = await api(app, a, "POST", `/api/conversations/${conversationId}/messages`, { text: "one", clientTxn: "newer1" });
    expect(first.status).toBe(201);
    for (let i = 0; i < 100 && !frames(raw.received()).includes(0x9); i++) await new Promise((r) => setTimeout(r, 5));
    // On the desktop, b reads the first; then a newer message comes, coalesced into the push that is being decided.
    expect((await api(app, b, "POST", `/api/conversations/${conversationId}/read`, { seq: first.json.message.seq })).status).toBe(200);
    expect((await api(app, a, "POST", `/api/conversations/${conversationId}/messages`, { text: "two", clientTxn: "newer2" })).status).toBe(201);
    await app.push.idle();
    expect(pushedTo()).toEqual([token]);
    expect(app.push.flush()).toMatchObject({ sent: 1, coalesced: 1, stale: 0 });
  });

  test("many messages during one ask: one ping for the session, one push per conversation", async () => {
    const a = await signUp(app, "burst_a");
    const b = await signUp(app, "burst_b");
    const c = await signUp(app, "burst_c");
    const { conversationId: direct } = await befriend(app, a, b);
    const conv = await group(app, a, "g", [b, c]);
    const token = await phone(b);
    const raw = await rawSocket(b);
    requests().length = 0;
    for (const [where, n] of [[direct, 1], [conv, 1], [direct, 2], [direct, 3], [conv, 2]] as const) {
      expect((await api(app, a, "POST", `/api/conversations/${where}/messages`, { text: `m${n}`, clientTxn: `burst-${where}-${n}` })).status).toBe(201);
    }
    await app.push.idle();
    expect(pushedTo()).toEqual([token, token]);
    expect(requests().map((r) => r.headers["apns-collapse-id"]).sort()).toEqual([direct, conv].sort());
    expect(frames(raw.received()).filter((f) => f === 0x9)).toHaveLength(1);
    expect(app.push.flush()).toMatchObject({ sent: 2, present: 0, coalesced: 3 });
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

  test("a socket that is closing (its close frame in, its connection not yet closed) is not present: the push goes", async () => {
    const a = await signUp(app, "closing_a");
    const b = await signUp(app, "closing_b");
    const { conversationId } = await befriend(app, a, b);
    const token = await phone(b);
    const id = await sessionIdOf(b);
    const raw = await rawSocket(b);
    expect(app.realtime.hasSocketFor(id)).toBe(true);
    // A client close frame (masked, code 1000), and then nothing: the TCP connection stays open, as when iOS suspends the
    // app between its close frame and its FIN. The server's socket is CLOSING and delivers nothing from here on.
    raw.socket.write(Buffer.from([0x88, 0x82, 0, 0, 0, 0, 0x03, 0xe8]));
    for (let i = 0; i < 100 && raw.received().length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(raw.received()[0]).toBe(0x88); // the server answered the close: it is closing
    expect(app.realtime.hasSocketFor(id)).toBe(false);
    await say(a, conversationId, "while it closes");
    expect(pushedTo()).toEqual([token]);
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

  test("an Agent's message is held to its owner's blocks: a member who blocked the owner (or was blocked) gets nothing of it", async () => {
    const owner = await signUp(app, "blocked_owner");
    const b = await signUp(app, "blocks_owner");
    const c = await signUp(app, "blocked_by_owner");
    const d = await signUp(app, "bystander_d");
    const agent = await mustCreateAgent(app, owner, { model: { source: "site", id: "fast" }, persona: "你是一个说话简洁的助手。" });
    const conv = await group(app, owner, "g", [b, c, d]);
    expect((await api(app, owner, "POST", `/api/conversations/${conv}/members`, { principalId: agent.id })).status).toBe(201);
    await phone(b);
    await phone(c);
    const td = await phone(d);
    expect((await api(app, b, "PUT", `/api/blocks/${owner.id}`)).status).toBe(200);
    expect((await api(app, owner, "PUT", `/api/blocks/${c.id}`)).status).toBe(200);
    await app.push.idle();
    requests().length = 0;
    // The Agent's message, stored and announced as a posted reply is.
    const { rows } = await db.query<MessageRow>(
      `with next as (update conversations set seq = seq + 1 where id = $1 returning seq)
       insert into messages as m (conversation_id, seq, sender_id, kind, body) select $1, next.seq, $2, 'text', '{"text":"hi"}'::jsonb from next
       returning ${MESSAGE_COLUMNS}`,
      [conv, agent.id],
    );
    app.deps.conversations.publish({ messages: rows.map(toStored), conversations: [] }, app.log);
    await app.push.idle();
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
    expect(stats).toEqual({ sent: 0, removed: 1, present: 0, coalesced: 0, stale: 0, failed: {} });
    const pushLines = lines.filter((l) => l.includes('"metric":"push"'));
    expect(pushLines).toHaveLength(1);
    expect(JSON.parse(pushLines[0]!)).toMatchObject({ metric: "push", sent: 0, removed: 1, present: 0 });
    // Every line of the push's own (the request log names the conversation in a route's path, as it always has).
    const own = lines.filter((l) => /push|apns/i.test(String(JSON.parse(l).msg)) || String(JSON.parse(l).metric ?? "").startsWith("push"));
    expect(own.length).toBeGreaterThan(0);
    const all = own.join("\n");
    for (const secret of [token, conversationId, "CANARY", a.id, b.id]) expect([secret, all.includes(secret)]).toEqual([secret, false]);
  });

  test("a message while that phone's push for the same conversation is still out adds no second push (coalesced)", async () => {
    const a = await signUp(app, "out_a");
    const b = await signUp(app, "out_b");
    const { conversationId } = await befriend(app, a, b);
    await phone(b);
    let release!: (x: { status: number }) => void;
    fake.apns!.answer({ hold: new Promise((r) => (release = r)) });
    expect((await api(app, a, "POST", `/api/conversations/${conversationId}/messages`, { text: "one", clientTxn: "out1" })).status).toBe(201);
    await fake.apns!.waitFor(1);
    expect((await api(app, a, "POST", `/api/conversations/${conversationId}/messages`, { text: "two", clientTxn: "out2" })).status).toBe(201);
    await new Promise((r) => setTimeout(r, 50));
    release({ status: 200 });
    await app.push.idle();
    expect(requests()).toHaveLength(1);
    expect(app.push.flush()).toMatchObject({ sent: 1, coalesced: 1 });
    // Once it is over, the next message pushes again.
    await say(a, conversationId, "three");
    expect(requests()).toHaveLength(2);
  });

  test("APNs refusing the configuration: no phone is deleted, every push pauses, ONE warning names the class and nothing else", async () => {
    const a = await signUp(app, "conf_a");
    const b = await signUp(app, "conf_b");
    const c = await signUp(app, "conf_c");
    const { conversationId: withB } = await befriend(app, a, b);
    const { conversationId: withC } = await befriend(app, a, c);
    const tb = await phone(b);
    const tc = await phone(c);
    const shared = real;
    real = client();
    try {
      requests().length = 0;
      fake.apns!.answer({ status: 403, reason: "InvalidProviderToken" });
      await say(a, withB, "one");
      await say(a, withC, "two");
      await say(a, withB, "three");
      // The first push refused, every later one paused without being sent, whoever it is for.
      expect(requests()).toHaveLength(1);
      expect((await db.query("select token from push_devices where token = any($1) order by token", [[tb, tc]])).rows).toHaveLength(2);
      const warned = lines.filter((l) => l.includes('"metric":"push_config_refused"'));
      expect(warned).toHaveLength(1);
      const line = JSON.parse(warned[0]!);
      expect(line).toMatchObject({ level: 40, class: "auth" });
      for (const secret of [tb, tc, withB, withC]) expect(warned[0]!.includes(secret)).toBe(false);
      expect(app.push.flush()).toMatchObject({ sent: 0, removed: 0, failed: { auth: 1, paused: 2 } });
    } finally {
      await real.close();
      real = shared;
    }
  });

  test("a key limited to production: a person's sandbox phone pauses only sandbox; production phones are still pushed; one warning says how to make the key", async () => {
    const a = await signUp(app, "env_a");
    const b = await signUp(app, "env_b");
    const c = await signUp(app, "env_c");
    const { conversationId: withB } = await befriend(app, a, b);
    const { conversationId: withC } = await befriend(app, a, c);
    // b registers a phone for the sandbox host (their own choice, through the API); c's is a production phone.
    expect((await api(app, b, "POST", "/api/push/devices", { token: newToken(), env: "sandbox" })).status).toBe(200);
    const tc = await phone(c);
    const shared = real;
    real = client();
    try {
      fake.apns!.answer({ status: 403, reason: "BadEnvironmentKeyIdInToken" });
      await say(a, withB, "to the sandbox phone");
      await say(a, withC, "to the production phone");
      await say(a, withB, "sandbox again");
      expect(pushedTo().slice(1)).toEqual([tc]);
      expect(app.push.flush()).toMatchObject({ sent: 1, failed: { key_env: 1, paused: 1 } });
      const warned = lines.filter((l) => l.includes('"metric":"push_config_refused"'));
      expect(warned).toHaveLength(1);
      const line = JSON.parse(warned[0]!);
      expect(line).toMatchObject({ level: 40, class: "key_env", host: "sandbox" });
      expect(line.msg).toContain("Sandbox & Production");
    } finally {
      await real.close();
      real = shared;
    }
  });

  test("DeviceTokenNotForTopic (a phone of another app's build): kept, not deleted; one warning of class topic", async () => {
    const a = await signUp(app, "topic_a");
    const b = await signUp(app, "topic_b");
    const { conversationId } = await befriend(app, a, b);
    const token = await phone(b);
    const shared = real;
    real = client();
    try {
      fake.apns!.answer({ status: 400, reason: "DeviceTokenNotForTopic" });
      await say(a, conversationId, "x");
      expect((await db.query("select 1 from push_devices where token = $1", [token])).rowCount).toBe(1);
      expect(lines.filter((l) => l.includes('"metric":"push_config_refused"') && l.includes('"class":"topic"'))).toHaveLength(1);
    } finally {
      await real.close();
      real = shared;
    }
  });

  test("a phone that registers again while its push is out keeps its row, though APNs then says the token was dead", async () => {
    const a = await signUp(app, "again_a");
    const b = await signUp(app, "again_b");
    const { conversationId } = await befriend(app, a, b);
    const token = await phone(b);
    let release!: (x: { status: number; reason: string }) => void;
    fake.apns!.answer({ hold: new Promise((r) => (release = r)) });
    expect((await api(app, a, "POST", `/api/conversations/${conversationId}/messages`, { text: "x", clientTxn: "again1" })).status).toBe(201);
    await fake.apns!.waitFor(1);
    expect((await api(app, b, "POST", "/api/push/devices", { token, env: "production" })).status).toBe(200);
    release({ status: 410, reason: "Unregistered" });
    await app.push.idle();
    expect((await db.query("select 1 from push_devices where token = $1", [token])).rowCount).toBe(1);
    expect(app.push.flush()).toMatchObject({ sent: 0, removed: 0 });
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
    expect(app.push.flush()).toEqual({ sent: 1, removed: 0, present: 2, coalesced: 0, stale: 0, failed: { rejected: 1 } });
    lines.length = 0;
    expect(app.push.flush()).toEqual({ sent: 0, removed: 0, present: 0, coalesced: 0, stale: 0, failed: {} });
    expect(lines.filter((l) => l.includes('"metric":"push"'))).toEqual([]);
  });
});

describe("the stop", () => {
  let slow: ApnsClient | null = null;
  const forward: ApnsClient = { send: (n) => slow!.send(n), close: async (grace) => slow?.close(grace) };
  const { app: own } = useApp({ apns: forward });
  beforeAll(() => {
    slow = createApnsClient({ teamId: "ABCDE12345", keyId: "KEY1234567", keyPem: PEM, topic: "org.haiyo.app", origins: { production: fake.apns!.url, sandbox: fake.apns!.url }, retryDelaysMs: [60_000] });
  });

  test("a push waiting a minute for its retry does not hold the stop: the sender is closed first, the stop ends in seconds", async () => {
    const a = await signUp(own, "stop_a");
    const b = await signUp(own, "stop_b");
    const { conversationId } = await befriend(own, a, b);
    expect((await api(own, b, "POST", "/api/push/devices", { token: "ef".repeat(32), env: "production" })).status).toBe(200);
    fake.apns!.reset();
    fake.apns!.answer({ status: 503, reason: "ServiceUnavailable" });
    expect((await api(own, a, "POST", `/api/conversations/${conversationId}/messages`, { text: "x", clientTxn: "stop1" })).status).toBe(201);
    await fake.apns!.waitFor(1);
    await new Promise((r) => setTimeout(r, 20));
    const t0 = Date.now();
    await own.push.close();
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(own.push.flush()).toEqual({ sent: 0, removed: 0, present: 0, coalesced: 0, stale: 0, failed: {} }); // the stop wrote them
    expect(fake.apns!.requests).toHaveLength(1);
  });
});

describe("a malformed key", () => {
  const off: string[] = [];
  const KEY = "-----BEGIN PRIVATE KEY-----\nCANARYKEYMATERIAL\n-----END PRIVATE KEY-----";
  const { app: plain } = useApp({
    env: { APPLE_TEAM_ID: "ABCDE12345", APPLE_BUNDLE_ID: "org.haiyo.app", APNS_KEY_ID: "KEY1234567", APNS_KEY_P8: KEY },
    logStream: { write: (l) => void off.push(l) },
  });

  test("the service starts; one WARN line names APNS_KEY_P8 as malformed and repeats nothing of it; nothing is pushed", async () => {
    const lines = off.filter((l) => l.includes('"metric":"push_off"'));
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0]!);
    expect(line.level).toBe(40);
    // The Team and bundle ids are fine: the universal-links file is served.
    expect(line).toMatchObject({ missing: [], malformed: ["APNS_KEY_P8"], links: "on" });
    expect(off.join("\n")).not.toContain("CANARYKEYMATERIAL");
    expect(plain.deps.apns).toBeNull();
    expect((await api(plain, null, "GET", "/api/health")).status).toBe(200);
  });
});

describe("a malformed Team ID", () => {
  const off: string[] = [];
  const { app: plain } = useApp({
    env: { APPLE_TEAM_ID: "not-a-team", APPLE_BUNDLE_ID: "org.haiyo.app", APNS_KEY_ID: "KEY1234567", APNS_KEY_P8: PEM },
    logStream: { write: (l) => void off.push(l) },
  });

  test("the one WARN line says the universal links are off too, not only the pushes", async () => {
    const lines = off.filter((l) => l.includes('"metric":"push_off"'));
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0]!);
    expect(line).toMatchObject({ level: 40, malformed: ["APPLE_TEAM_ID"], links: "off" });
    expect(line.msg).toMatch(/universal links/);
    expect((await plain.inject({ method: "GET", url: "/.well-known/apple-app-site-association" })).statusCode).toBe(404);
  });
});

describe("push not configured", () => {
  const off: string[] = [];
  const { app: plain } = useApp({ env: { APPLE_TEAM_ID: "ABCDE12345", APPLE_BUNDLE_ID: "org.haiyo.app" }, logStream: { write: (l) => void off.push(l) } });

  test("one line at start names what is missing; messages are sent as ever, nothing is pushed", async () => {
    const line = off.find((l) => l.includes('"metric":"push_off"'));
    expect(line).toBeDefined();
    expect(JSON.parse(line!)).toMatchObject({ missing: ["APNS_KEY_ID", "APNS_KEY_P8"], malformed: [] });
    expect(plain.deps.apns).toBeNull();
    const a = await signUp(plain, "off_a");
    const b = await signUp(plain, "off_b");
    const { conversationId } = await befriend(plain, a, b);
    expect((await api(plain, b, "POST", "/api/push/devices", { token: "cd".repeat(32), env: "production" })).status).toBe(200);
    expect((await api(plain, a, "POST", `/api/conversations/${conversationId}/messages`, { text: "hi", clientTxn: "off1" })).status).toBe(201);
    await plain.push.idle();
    expect(plain.push.flush()).toEqual({ sent: 0, removed: 0, present: 0, coalesced: 0, stale: 0, failed: {} });
  });
});
