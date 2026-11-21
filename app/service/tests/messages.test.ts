import { describe, expect, it } from "vitest";
import { onMessages } from "../src/conversations/events.ts";
import type { Queryable } from "../src/db.ts";
import { MESSAGE_COLUMNS, toStored, type MessageRow } from "../src/messages/model.ts";
import { toWireForReaders } from "../src/messages/read.ts";
import { api, befriend, group, signUp, type Actor } from "./helpers/actors.ts";
import { useApp } from "./helpers/harness.ts";

const { app, db } = useApp();

const NOT_FOUND = { error: "not_found" };
const INVALID = { error: "invalid_request" };
const RANDOM_ID = "00000000-0000-4000-8000-000000000000";

let txn = 0;
const nextTxn = () => `m${++txn}`;
const post = (who: Actor, conv: string, body: unknown) => api(app, who, "POST", `/api/conversations/${conv}/messages`, body);
const say = (who: Actor, conv: string, text: string, extra: object = {}) =>
  post(who, conv, { text, clientTxn: nextTxn(), ...extra });
const history = (who: Actor, conv: string, query = "") => api(app, who, "GET", `/api/conversations/${conv}/messages${query}`);
const one = (who: Actor, conv: string, seq: number | string) =>
  api(app, who, "GET", `/api/conversations/${conv}/messages/${seq}`);
const markRead = (who: Actor, conv: string, seq: unknown) =>
  api(app, who, "POST", `/api/conversations/${conv}/read`, { seq });
const add = (who: Actor, conv: string, target: Actor) =>
  api(app, who, "POST", `/api/conversations/${conv}/members`, { principalId: target.id });
const remove = (who: Actor, conv: string, target: Actor) =>
  api(app, who, "DELETE", `/api/conversations/${conv}/members/${target.id}`);
const seqs = async (who: Actor, conv: string, query = ""): Promise<number[]> =>
  (await history(who, conv, query)).json.messages.map((m: { seq: number }) => m.seq);
const texts = async (who: Actor, conv: string): Promise<string[]> =>
  (await history(who, conv)).json.messages.map((m: { text: string }) => m.text);
const systemEvents = async (who: Actor, conv: string): Promise<string[]> =>
  (await history(who, conv)).json.messages.filter((m: any) => m.kind === "system").map((m: any) => m.system.event);
const count = async (sql: string, params: unknown[] = []) =>
  Number((await db.query<{ n: string }>(sql, params)).rows[0]!.n);

async function people<const N extends string[]>(...names: N): Promise<{ [K in keyof N]: Actor }> {
  const out: Actor[] = [];
  for (const n of names) out.push(await signUp(app, n));
  return out as { [K in keyof N]: Actor };
}

describe("sending and reading", () => {
  it("direct chat exists after befriending and both can send and read", async () => {
    const [a, b] = await people("alice", "bob");
    const { conversationId: dm } = await befriend(app, a, b);

    const s1 = await say(a, dm, "你好 bob");
    expect(s1.status).toBe(201);
    expect(s1.json.duplicate).toBe(false);
    expect(s1.json.message).toEqual({
      conversationId: dm,
      seq: 1,
      senderId: a.id,
      kind: "text",
      text: "你好 bob",
      createdAt: expect.any(String),
    });
    const s2 = await say(b, dm, "hi alice");
    expect(s2.json.message).toMatchObject({ seq: 2, senderId: b.id, text: "hi alice" });

    for (const who of [a, b]) {
      const h = await history(who, dm);
      expect(h.status).toBe(200);
      expect(h.json.nextBefore).toBeNull();
      expect(h.json.messages.map((m: any) => [m.seq, m.senderId, m.text])).toEqual([
        [1, a.id, "你好 bob"],
        [2, b.id, "hi alice"],
      ]);
    }
    expect((await one(b, dm, 1)).json).toMatchObject({ message: s1.json.message });
    expect(await one(b, dm, 3)).toMatchObject({ status: 404, json: NOT_FOUND });
  });

  it("text is trimmed and limited to 8000 characters; empty, NUL, lone surrogates, attachments and bad clientTxn are 400", async () => {
    const [a, b] = await people("alice", "bob");
    const { conversationId: dm } = await befriend(app, a, b);

    const bad: unknown[] = [
      {},
      { text: "hi" },
      { clientTxn: "only-txn" },
      { text: "", clientTxn: nextTxn() },
      { text: "   \n\t  ", clientTxn: nextTxn() },
      { text: "a\u0000b", clientTxn: nextTxn() },
      { text: "lone \ud800 surrogate", clientTxn: nextTxn() },
      { text: "x".repeat(8001), clientTxn: nextTxn() },
      { text: 5, clientTxn: nextTxn() },
      { text: ["hi"], clientTxn: nextTxn() },
      { text: "hi", clientTxn: "" },
      { text: "hi", clientTxn: "x".repeat(65) },
      { text: "hi", clientTxn: "has space" },
      { text: "hi", clientTxn: "é" },
      { text: "hi", clientTxn: 12 },
      { text: "hi", clientTxn: nextTxn(), attachmentId: RANDOM_ID }, // no such upload
      { text: "hi", clientTxn: nextTxn(), attachmentId: "not-a-uuid" },
      { text: "hi", clientTxn: nextTxn(), replyToSeq: 0 },
      { text: "hi", clientTxn: nextTxn(), replyToSeq: -1 },
      { text: "hi", clientTxn: nextTxn(), replyToSeq: 1.5 },
      { text: "hi", clientTxn: nextTxn(), replyToSeq: "1" },
      { text: "hi", clientTxn: nextTxn(), replyToSeq: 2 ** 53 },
      { text: "hi", clientTxn: nextTxn(), replyToSeq: 99 }, // does not exist
      null,
      [],
    ];
    for (const body of bad) {
      const res = await post(a, dm, body);
      expect([JSON.stringify(body)?.slice(0, 60), res.status, res.json]).toEqual([JSON.stringify(body)?.slice(0, 60), 400, INVALID]);
    }
    expect(await count("select count(*) n from messages")).toBe(0);

    expect((await say(a, dm, "x".repeat(8000))).status).toBe(201);
    expect((await say(a, dm, "😀".repeat(8000))).status).toBe(201); // 8000 characters, 16000 UTF-16 units
    expect((await say(a, dm, "  padded \n")).json.message.text).toBe("padded");
    expect((await say(a, dm, "line one\nline two")).json.message.text).toBe("line one\nline two");
  });

  it("sender fields in the body are ignored; message is attributed to the session principal", async () => {
    const [a, b] = await people("alice", "bob");
    const { conversationId: dm } = await befriend(app, a, b);
    const res = await post(a, dm, {
      text: "mine",
      clientTxn: nextTxn(),
      senderId: b.id,
      sender_id: b.id,
      sender: b.id,
      actorId: b.id,
      from: b.id,
      kind: "system",
      seq: 999,
      conversationId: RANDOM_ID,
    });
    expect(res.status).toBe(201);
    expect(res.json.message).toMatchObject({ conversationId: dm, seq: 1, senderId: a.id, kind: "text", text: "mine" });
    const row = await db.query("select sender_id, kind, seq from messages where conversation_id = $1", [dm]);
    expect(row.rows).toEqual([{ sender_id: a.id, kind: "text", seq: "1" }]);
  });

  it("pagination with before walks back through history without gaps or repeats", async () => {
    const [a, b] = await people("alice", "bob");
    const { conversationId: dm } = await befriend(app, a, b);
    for (let i = 1; i <= 25; i++) await say(i % 2 ? a : b, dm, `n${i}`);

    const page1 = await history(a, dm, "?limit=10");
    expect(page1.json.messages.map((m: any) => m.seq)).toEqual([16, 17, 18, 19, 20, 21, 22, 23, 24, 25]);
    expect(page1.json.nextBefore).toBe(16);
    const page2 = await history(a, dm, "?limit=10&before=16");
    expect(page2.json.messages.map((m: any) => m.seq)).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(page2.json.nextBefore).toBe(6);
    const page3 = await history(a, dm, "?limit=10&before=6");
    expect(page3.json.messages.map((m: any) => m.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(page3.json.nextBefore).toBeNull();
    expect(await seqs(a, dm)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1)); // default limit 50
    expect(await seqs(a, dm, "?limit=100&before=9007199254740991")).toHaveLength(25);
  });

  it("seq, before and limit must be bounded positive integers", async () => {
    const [a, b] = await people("alice", "bob");
    const { conversationId: dm } = await befriend(app, a, b);
    await say(a, dm, "one");
    for (const v of ["0", "-1", "1.5", "abc", "9007199254740992", "99999999999999999999999", "1e3", "0x10", "%20", "NaN"]) {
      expect([v, (await one(a, dm, v)).status]).toEqual([v, 400]);
      expect([v, (await history(a, dm, `?before=${v}`)).status]).toEqual([v, 400]);
      expect([v, (await history(a, dm, `?limit=${v}`)).status]).toEqual([v, 400]);
    }
    expect((await history(a, dm, "?limit=101")).json).toEqual(INVALID);
    expect((await history(a, dm, "?before=1&before=2")).status).toBe(400);
    expect((await history(a, dm, "?limit=100")).status).toBe(200);
    expect((await history(a, dm, "?limit=1")).json.messages).toHaveLength(1);
    expect(await one(a, dm, "9007199254740991")).toMatchObject({ status: 404, json: NOT_FOUND });
    for (const v of [0, -1, 1.5, "1", null, 2 ** 53, 1e400]) {
      expect([v, (await markRead(a, dm, v)).status]).toEqual([v, 400]);
    }
  });
});

describe("visibility", () => {
  it("late joiner sees nothing before joining via list, before=, single-message and reply-to; sees messages after", async () => {
    const [a, b, c, d] = await people("alice", "bob", "carol", "dave");
    const g = await group(app, a, "g", [b, c]); // seq 1: created
    for (let i = 1; i <= 3; i++) await say(a, g, `before ${i}`); // seq 2..4
    await befriend(app, a, d);
    expect((await add(a, g, d)).status).toBe(201); // seq 5: d joined

    const h = await history(d, g);
    expect(h.json.messages.map((m: any) => m.seq)).toEqual([5]);
    expect(h.json.messages[0].system).toMatchObject({ event: "member_joined", actorId: a.id, principalId: d.id });
    expect(h.json.nextBefore).toBeNull();
    expect(JSON.stringify(h.json)).not.toContain("before ");
    expect((await history(d, g, "?before=5")).json).toEqual({ messages: [], nextBefore: null, principals: {} });
    expect((await history(d, g, "?before=4&limit=100")).json).toEqual({ messages: [], nextBefore: null, principals: {} });
    expect((await history(d, g, "?limit=1")).json.nextBefore).toBeNull(); // no hint that older messages exist
    for (const seq of [1, 2, 3, 4]) expect(await one(d, g, seq)).toMatchObject({ status: 404, json: NOT_FOUND });
    expect(await say(d, g, "re", { replyToSeq: 2 })).toMatchObject({ status: 400, json: INVALID });
    expect(await say(d, g, "re", { replyToSeq: 1 })).toMatchObject({ status: 400, json: INVALID });

    const after = await say(a, g, "after"); // seq 6
    expect(await seqs(d, g)).toEqual([5, 6]);
    expect((await one(d, g, 6)).json.message.text).toBe("after");
    const reply = await say(d, g, "re after", { replyToSeq: 6 });
    expect(reply.status).toBe(201);
    expect(reply.json.message.replyTo).toEqual({ seq: 6, visible: true, senderId: a.id, text: "after", kind: "text" });
    const replyToNotice = await say(d, g, "re notice", { replyToSeq: 5 });
    expect(replyToNotice.json.message.replyTo).toMatchObject({ seq: 5, visible: true, senderId: null });
    expect(after.json.message.seq).toBe(6);

    // Earlier members keep their full view.
    expect(await seqs(b, g)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("a message quoting a pre-join message reaches the late joiner with replyTo.visible=false and no text or senderId", async () => {
    const [a, b, c, d] = await people("alice", "bob", "carol", "dave");
    const g = await group(app, a, "g", [b, c]);
    const long = "😀长".repeat(150); // 300 characters
    const quoted = await say(a, g, long); // seq 2
    const quoting = await say(b, g, "quoting", { replyToSeq: quoted.json.message.seq }); // seq 3
    expect(quoting.json.message.replyTo).toEqual({ seq: 2, visible: true, senderId: a.id, text: "😀长".repeat(100), kind: "text" });

    await befriend(app, a, d);
    await add(a, g, d);
    const forD = (await history(d, g)).json;
    expect(forD.messages.map((m: any) => m.seq)).toEqual([4]); // d joined after the quote was sent
    await say(c, g, "quoting again", { replyToSeq: 2 }); // seq 5, sent after d joined
    const later = (await history(d, g)).json.messages;
    expect(later.map((m: any) => m.seq)).toEqual([4, 5]);
    expect(later[1].replyTo).toEqual({ seq: 2, visible: false });
    expect((await one(d, g, 5)).json.message.replyTo).toEqual({ seq: 2, visible: false });
    expect(JSON.stringify(later)).not.toContain("长");
    expect(JSON.stringify(later[1])).not.toContain(a.id); // the quoted author stays hidden too
    // Members who can see the original get the quote.
    expect((await one(b, g, 5)).json.message.replyTo).toMatchObject({ visible: true, senderId: a.id });
  });

  it("removed member gets 404 on every read and write; re-added member sees only messages after re-joining — not the first stay, not the gap", async () => {
    const [a, b, c] = await people("alice", "bob", "carol");
    const g = await group(app, a, "g", [b, c]); // seq 1
    await say(a, g, "first stay"); // seq 2
    expect(await texts(b, g)).toContain("first stay");
    expect((await remove(a, g, b)).status).toBe(200); // seq 3
    await say(a, g, "gap"); // seq 4

    const attempts = [
      () => history(b, g),
      () => history(b, g, "?before=3"),
      () => one(b, g, 1),
      () => one(b, g, 2),
      () => one(b, g, 3),
      () => say(b, g, "still here?"),
      () => markRead(b, g, 1),
      () => api(app, b, "GET", `/api/conversations/${g}/members`),
      () => add(b, g, a),
      () => remove(b, g, b),
      () => api(app, b, "PATCH", `/api/conversations/${g}`, { title: "x" }),
    ];
    for (const attempt of attempts) expect(await attempt()).toMatchObject({ status: 404, json: NOT_FOUND });

    expect((await add(a, g, b)).status).toBe(201); // seq 5
    const back = await history(b, g);
    expect(back.json.messages.map((m: any) => m.seq)).toEqual([5]);
    expect(JSON.stringify(back.json)).not.toContain("first stay");
    expect(JSON.stringify(back.json)).not.toContain("gap");
    for (const seq of [1, 2, 3, 4]) expect(await one(b, g, seq)).toMatchObject({ status: 404, json: NOT_FOUND });
    expect(await say(b, g, "re", { replyToSeq: 2 })).toMatchObject({ status: 400, json: INVALID });
    await say(a, g, "after"); // seq 6
    expect(await texts(b, g)).toEqual([expect.stringContaining("bob"), "after"]);
    expect((await say(b, g, "back")).status).toBe(201);
    expect(await count("select count(*) n from memberships where conversation_id = $1 and principal_id = $2", [g, b.id])).toBe(2);
  });
});

describe("direct chat permissions", () => {
  it("unfriend stops direct sends with reason not_friends; block stops both directions with reason blocked; unblock/re-friend restores; history stays readable throughout", async () => {
    const [a, b] = await people("alice", "bob");
    const { conversationId: dm } = await befriend(app, a, b);
    expect((await say(a, dm, "before")).status).toBe(201);

    expect((await api(app, a, "DELETE", `/api/friends/${b.id}`)).status).toBe(200);
    for (const who of [a, b]) {
      const res = await say(who, dm, "x");
      expect(res.status).toBe(403);
      expect(res.json).toEqual({ error: "cannot_send", reason: "not_friends" });
      expect(await texts(who, dm)).toContain("before");
    }
    const ended = (await history(b, dm)).json.messages.at(-1);
    expect(ended).toMatchObject({ kind: "system", senderId: null, system: { event: "friendship_ended", actorId: a.id, principalId: b.id } });
    expect(ended.text).toContain("alice");

    expect((await befriend(app, b, a)).conversationId).toBe(dm);
    expect((await say(a, dm, "again")).status).toBe(201);
    expect((await say(b, dm, "yes")).status).toBe(201);

    expect((await api(app, b, "PUT", `/api/blocks/${a.id}`)).status).toBe(200);
    for (const who of [a, b]) {
      expect(await say(who, dm, "x")).toMatchObject({ status: 403, json: { error: "cannot_send", reason: "blocked" } });
    }
    const blocked = (await history(a, dm)).json.messages.at(-1);
    expect(blocked.system).toMatchObject({ event: "blocked", actorId: b.id, principalId: a.id });
    expect(blocked.text).toContain("bob拉黑了alice，只能由对方解除");
    // A block wins over a missing friendship.
    await api(app, a, "DELETE", `/api/friends/${b.id}`);
    expect(await say(a, dm, "x")).toMatchObject({ status: 403, json: { error: "cannot_send", reason: "blocked" } });

    expect((await api(app, b, "DELETE", `/api/blocks/${a.id}`)).status).toBe(200);
    expect(await say(a, dm, "x")).toMatchObject({ status: 403, json: { error: "cannot_send", reason: "not_friends" } });
    await befriend(app, a, b);
    expect((await say(b, dm, "restored")).status).toBe(201);

    for (const who of [a, b]) {
      expect(await texts(who, dm)).toEqual(expect.arrayContaining(["before", "again", "yes", "restored"]));
      expect(await systemEvents(who, dm)).toEqual([
        "friendship_ended",
        "friendship_restored",
        "blocked",
        "friendship_ended",
        "unblocked",
        "friendship_restored",
      ]);
    }
    // Repeating a block or unblock that changes nothing adds no notice.
    await api(app, b, "DELETE", `/api/blocks/${a.id}`);
    await api(app, b, "PUT", `/api/blocks/${a.id}`);
    await api(app, b, "PUT", `/api/blocks/${a.id}`);
    expect((await systemEvents(a, dm)).filter((e) => e === "blocked")).toHaveLength(2);
  });

  it("block between two members of a group does not stop either from sending there", async () => {
    const [a, b, c] = await people("alice", "bob", "carol");
    const g = await group(app, a, "g", [b, c]);
    await befriend(app, b, c);
    expect((await api(app, b, "PUT", `/api/blocks/${c.id}`)).status).toBe(200);
    expect((await say(b, g, "from bob")).status).toBe(201);
    expect((await say(c, g, "from carol")).status).toBe(201);
    for (const who of [a, b, c]) expect(await texts(who, g)).toEqual(expect.arrayContaining(["from bob", "from carol"]));
    expect(await systemEvents(b, g)).toEqual(["group_created"]); // the notice goes to their direct chat only
  });
});

describe("idempotency", () => {
  it("same clientTxn twice in one conversation stores one message; the same clientTxn in a second conversation stores a new message there", async () => {
    const [a, b, c] = await people("alice", "bob", "carol");
    const { conversationId: dm } = await befriend(app, a, b);
    const g = await group(app, a, "g", [b, c]);
    const announced: number[] = [];
    const off = onMessages(app, (msgs) => void announced.push(...msgs.map((m) => m.seq)));
    try {
      const first = await post(a, dm, { text: "once", clientTxn: "retry-1" });
      expect(first.status).toBe(201);
      expect(first.json.duplicate).toBe(false);
      const again = await post(a, dm, { text: "changed", clientTxn: "retry-1" });
      expect(again.status).toBe(200);
      expect(again.json).toEqual({ duplicate: true, message: first.json.message });
      await new Promise((r) => setTimeout(r, 50));
      expect(announced).toEqual([first.json.message.seq]); // the repeat announces nothing
    } finally {
      off();
    }
    expect(await count("select count(*) n from messages where conversation_id = $1", [dm])).toBe(1);
    expect(await count("select seq n from conversations where id = $1", [dm])).toBe(1);

    const elsewhere = await post(a, g, { text: "elsewhere", clientTxn: "retry-1" });
    expect(elsewhere.status).toBe(201);
    expect(elsewhere.json).toMatchObject({ duplicate: false, message: { conversationId: g, text: "elsewhere" } });
    const byB = await post(b, dm, { text: "b's own", clientTxn: "retry-1" });
    expect(byB.status).toBe(201);
    expect(await count("select count(*) n from messages where client_txn = 'retry-1'")).toBe(3);

    // A retry still returns the stored message after the pair can no longer send; a new message is refused.
    await api(app, a, "DELETE", `/api/friends/${b.id}`);
    expect(await post(a, dm, { text: "once", clientTxn: "retry-1" })).toMatchObject({ status: 200, json: { duplicate: true } });
    expect((await post(a, dm, { text: "new", clientTxn: "retry-2" })).status).toBe(403);

    // After leaving and being re-added, an old clientTxn does not reveal the message from the earlier stay.
    expect((await post(c, g, { text: "first stay", clientTxn: "g-1" })).status).toBe(201);
    await remove(a, g, c);
    await add(a, g, c);
    const reused = await post(c, g, { text: "first stay", clientTxn: "g-1" });
    expect(reused).toMatchObject({ status: 409, json: { error: "client_txn_reused" } });
    expect(JSON.stringify(reused.json)).not.toContain("first stay");
    expect(await count("select count(*) n from messages where client_txn = 'g-1'")).toBe(1);
  });
});

describe("fan-out rendering", () => {
  const stored = async (conv: string, seq: number) =>
    toStored(
      (await db.query<MessageRow>(`select ${MESSAGE_COLUMNS} from messages m where m.conversation_id = $1 and m.seq = $2`, [conv, seq]))
        .rows[0]!,
    );

  it("each reader gets only what they may see: the original member sees the quote, the late joiner gets visible=false, a non-member gets nothing", async () => {
    const [a, b, c, d, o] = await people("alice", "bob", "carol", "dave", "oscar");
    const g = await group(app, a, "g", [b, c]); // seq 1
    await say(a, g, "secret before dave"); // seq 2
    await befriend(app, a, d);
    await add(a, g, d); // seq 3
    await say(c, g, "quoting", { replyToSeq: 2 }); // seq 4
    const [pre, quotingMsg] = [await stored(g, 2), await stored(g, 4)];

    let queries = 0;
    const counted: Queryable = {
      query: ((...args: Parameters<Queryable["query"]>) => {
        queries++;
        return (db.query as (...a: unknown[]) => unknown)(...args);
      }) as Queryable["query"],
    };
    const out = await toWireForReaders(counted, [b.id, d.id, o.id, a.id.toUpperCase()], [pre, quotingMsg], app.deps.config);
    expect(queries).toBeLessThanOrEqual(2); // bounded, however many readers and messages

    expect([...out.keys()].sort()).toEqual([a.id, b.id, d.id, o.id].sort());
    expect(out.get(b.id)!.map((m) => m.seq)).toEqual([2, 4]);
    expect(out.get(b.id)![1]!.replyTo).toEqual({ seq: 2, visible: true, senderId: a.id, text: "secret before dave", kind: "text" });
    expect(out.get(a.id)!.map((m) => m.seq)).toEqual([2, 4]);
    // The late joiner does not get the pre-join message, and the quote of it is hidden.
    expect(out.get(d.id)!.map((m) => m.seq)).toEqual([4]);
    expect(out.get(d.id)![0]!.replyTo).toEqual({ seq: 2, visible: false });
    expect(JSON.stringify(out.get(d.id))).not.toContain("secret");
    expect(out.get(o.id)).toEqual([]);
    // Identical to what the routes return to each of them.
    expect((await one(d, g, 4)).json.message).toEqual(out.get(d.id)![0]);
    expect((await one(b, g, 4)).json.message).toEqual(out.get(b.id)![1]);
  });

  it("a removed member gets nothing; once re-added they get only new messages, with a quote from their first stay hidden", async () => {
    const [a, b, c] = await people("alice", "bob", "carol");
    const g = await group(app, a, "g", [b, c]); // seq 1
    await say(a, g, "first stay"); // seq 2
    await remove(a, g, b); // seq 3
    await say(a, g, "while out", { replyToSeq: 2 }); // seq 4
    const whileOut = await stored(g, 4);

    let out = await toWireForReaders(db, [b.id, c.id], [whileOut], app.deps.config);
    expect(out.get(b.id)).toEqual([]);
    expect(out.get(c.id)![0]!.replyTo).toMatchObject({ seq: 2, visible: true, text: "first stay" });

    await add(a, g, b); // seq 5
    await say(a, g, "after", { replyToSeq: 2 }); // seq 6
    out = await toWireForReaders(db, [b.id, c.id], [whileOut, await stored(g, 6)], app.deps.config);
    expect(out.get(b.id)!.map((m) => m.seq)).toEqual([6]);
    expect(out.get(b.id)![0]!.replyTo).toEqual({ seq: 2, visible: false });
    expect(JSON.stringify(out.get(b.id))).not.toContain("first stay");
    expect(out.get(c.id)!.map((m) => m.seq)).toEqual([4, 6]);
  });
});

describe("read markers", () => {
  it("read marker cannot exceed conversations.seq, cannot move backwards, cannot be set by a non-member", async () => {
    const [a, b, o] = await people("alice", "bob", "oscar");
    const { conversationId: dm } = await befriend(app, a, b);
    for (const t of ["1", "2", "3"]) await say(a, dm, t);
    const readSeq = async (who: Actor) =>
      count("select read_seq n from memberships where conversation_id = $1 and principal_id = $2", [dm, who.id]);

    expect(await markRead(b, dm, 2)).toMatchObject({ status: 200, json: { readSeq: 2 } });
    expect(await markRead(b, dm, 1)).toMatchObject({ status: 200, json: { readSeq: 2 } });
    expect(await markRead(b, dm, 1000)).toMatchObject({ status: 200, json: { readSeq: 3 } });
    expect(await readSeq(b)).toBe(3);
    expect(await readSeq(a)).toBe(0);
    expect(await markRead(o, dm, 1)).toMatchObject({ status: 404, json: NOT_FOUND });
    expect(await markRead(b, RANDOM_ID, 1)).toMatchObject({ status: 404, json: NOT_FOUND });
    expect(await count("select count(*) n from memberships where principal_id = $1", [o.id])).toBe(0);
  });
});

describe("concurrency", () => {
  it("two members sending concurrently get gapless, unique sequence numbers", async () => {
    const [a, b] = await people("alice", "bob");
    const { conversationId: dm } = await befriend(app, a, b);
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => say(i % 2 ? a : b, dm, `c${i}`)));
    expect(results.every((r) => r.status === 201)).toBe(true);
    const got = results.map((r) => r.json.message.seq as number).sort((x, y) => x - y);
    expect(got).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    expect(await count("select count(distinct seq) n from messages where conversation_id = $1", [dm])).toBe(40);
    expect(await count("select seq n from conversations where id = $1", [dm])).toBe(40);
  });

  for (const change of ["unfriend", "block"] as const) {
    it(`a send racing ${change === "unfriend" ? "an unfriend" : "a block"}: accepted equals stored, nothing is accepted after it, and a later send is refused`, async () => {
      const [a, b] = await people("alice", "bob");
      const { conversationId: dm } = await befriend(app, a, b);
      const act = () =>
        change === "unfriend"
          ? api(app, a, "DELETE", `/api/friends/${b.id}`)
          : api(app, b, "PUT", `/api/blocks/${a.id}`);
      const reason = change === "unfriend" ? "not_friends" : "blocked";

      const sends = (from: number) => Array.from({ length: 15 }, (_, i) => say((from + i) % 2 ? a : b, dm, `r${from + i}`));
      const [first, [changed], second] = await Promise.all([
        Promise.all(sends(0)),
        Promise.all([act()]),
        Promise.all(sends(15)),
      ]);
      expect(changed!.status).toBe(200);
      const results = [...first, ...second];
      const accepted = results.filter((r) => r.status === 201);
      const refused = results.filter((r) => r.status === 403);
      expect(accepted.length + refused.length).toBe(30);
      expect(refused.every((r) => r.json.error === "cannot_send" && r.json.reason === reason)).toBe(true);
      expect(await count("select count(*) n from messages where conversation_id = $1 and kind = 'text'", [dm])).toBe(accepted.length);

      // Every accepted message precedes the notice; nothing was stored after the change took effect.
      const notice = await count(
        "select seq n from messages where conversation_id = $1 and kind = 'system' order by seq desc limit 1",
        [dm],
      );
      expect(accepted.every((r) => r.json.message.seq < notice)).toBe(true);
      expect(await count("select seq n from conversations where id = $1", [dm])).toBe(notice);

      for (const who of [a, b]) {
        expect(await say(who, dm, "late")).toMatchObject({ status: 403, json: { error: "cannot_send", reason } });
      }
    });
  }
});
