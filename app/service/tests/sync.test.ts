import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, befriend, cookieHeaderFrom, group, mailLink, signIn, signUp, type Actor } from "./helpers/actors.ts";
import { PNG } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { closeAllSockets, connect, issueTicket, listen, rawUpgrade, tryConnect, type Push } from "./helpers/ws.ts";

const { app, db } = useApp();
afterEach(closeAllSockets);

const INVALID = { error: "invalid_request" };
const RANDOM_ID = "00000000-0000-4000-8000-000000000000";

let txn = 0;
const say = (who: Actor, conv: string, text: string, extra: object = {}) =>
  api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `s${++txn}`, ...extra });
const one = (who: Actor, conv: string, seq: number) => api(app, who, "GET", `/api/conversations/${conv}/messages/${seq}`);
const history = (who: Actor, conv: string) => api(app, who, "GET", `/api/conversations/${conv}/messages?limit=100`);
const add = (who: Actor, conv: string, target: Actor) =>
  api(app, who, "POST", `/api/conversations/${conv}/members`, { principalId: target.id });
const remove = (who: Actor, conv: string, target: Actor) =>
  api(app, who, "DELETE", `/api/conversations/${conv}/members/${target.id}`);
const rename = (who: Actor, conv: string, title: string) => api(app, who, "PATCH", `/api/conversations/${conv}`, { title });
const markRead = (who: Actor, conv: string, seq: number) => api(app, who, "POST", `/api/conversations/${conv}/read`, { seq });
const sync = (who: Actor) => api(app, who, "GET", "/api/sync");
const catchup = (who: Actor, positions: unknown) => api(app, who, "POST", "/api/sync/catchup", { positions });

async function people<const N extends string[]>(...names: N): Promise<{ [K in keyof N]: Actor }> {
  const out: Actor[] = [];
  for (const n of names) out.push(await signUp(app, n));
  return out as { [K in keyof N]: Actor };
}

/** A second, independent session of the same account. */
async function secondSession(who: Actor): Promise<Actor> {
  const res = await signIn(app, who.email, who.password);
  return { ...who, cookie: cookieHeaderFrom(res.headers["set-cookie"]) };
}

async function resetPassword(who: Actor): Promise<void> {
  await api(app, null, "POST", "/api/auth/request-password-reset", { email: who.email });
  const link = await mailLink(app, who.email, "reset_password");
  const token = new URLSearchParams(link.split("?")[1]).get("token")!;
  const res = await api(app, null, "POST", "/api/auth/reset-password", { newPassword: "a brand new password", token });
  expect(res.status).toBe(200);
}

const isMessage = (conv: string, seq?: number) => (e: Push) =>
  e.type === "message" && e.message.conversationId === conv && (seq === undefined || e.message.seq === seq);
/** Any push that concerns conversation `conv`. */
const about = (conv: string) => (e: Push) =>
  (e.type === "message" && e.message.conversationId === conv) || e.id === conv || e.conversationId === conv;
const lastSeq = async (conv: string) =>
  Number((await db.query<{ seq: string }>("select seq from conversations where id = $1", [conv])).rows[0]!.seq);

/** Appends `n` text messages by `sender` straight into the table (fast; fires no events). */
async function bulk(conv: string, sender: string, n: number): Promise<void> {
  await db.query(
    `with c as (update conversations set seq = seq + $3 where id = $1 returning seq - $3 as base)
     insert into messages (conversation_id, seq, sender_id, kind, body)
     select $1, c.base + s, $2, 'text', jsonb_build_object('text', 'bulk ' || (c.base + s)) from c, generate_series(1, $3::int) s`,
    [conv, sender, n],
  );
}

const WIRE_KEYS = new Set(["conversationId", "seq", "senderId", "kind", "text", "attachment", "replyTo", "system", "createdAt"]);

describe("GET /api/sync", () => {
  it("initial sync contains only my conversations and never a pre-join message", async () => {
    const [a, b, c, d, e] = await people("alice", "bob", "carol", "dave", "erin");
    const { conversationId: ab } = await befriend(app, a, b);
    await say(a, ab, "a to b");
    const g = await group(app, a, "team", [b, c]);
    await say(a, g, "before dave");
    const h = await group(app, b, "secret", [a, c]);
    await say(b, h, "hidden from dave");
    const { conversationId: ad } = await befriend(app, a, d);
    await befriend(app, a, e);
    expect((await add(a, g, d)).status).toBe(201);
    await say(a, g, "after dave");

    const s = await sync(d);
    expect(s.status).toBe(200);
    expect(s.json.me).toEqual({ id: d.id, handle: d.handle, displayName: "dave", avatarVersion: 0, email: d.email });
    expect(s.json.conversations.map((x: any) => x.id).sort()).toEqual([ad, g].sort());

    const byId = (x: { id: string }, y: { id: string }) => x.id.localeCompare(y.id);
    const team = s.json.conversations.find((x: any) => x.id === g);
    expect(team.members.at(-1).id).toBe(d.id); // by join order; the founders share joined_seq 0
    expect({ ...team, members: [...team.members].sort(byId) }).toEqual({
      id: g,
      type: "group",
      title: "team",
      creatorId: a.id,
      myRole: "speaker",
      closed: false,
      createdAt: expect.any(String),
      canSend: { ok: true },
      members: [
        { id: a.id, role: "speaker", isCreator: true },
        { id: b.id, role: "speaker", isCreator: false },
        { id: c.id, role: "speaker", isCreator: false },
        { id: d.id, role: "speaker", isCreator: false },
      ].sort(byId),
      lastSeq: await lastSeq(g),
      readSeq: 0,
      unread: 1, // "after dave"; the join notice is a system message
    });
    const direct = s.json.conversations.find((x: any) => x.id === ad);
    expect(direct).toEqual({
      id: ad,
      type: "direct",
      title: null,
      myRole: "speaker",
      closed: false,
      createdAt: expect.any(String),
      peerId: a.id,
      canSend: { ok: true },
      members: [
        { id: expect.any(String), role: "speaker", isCreator: false },
        { id: expect.any(String), role: "speaker", isCreator: false },
      ],
      lastSeq: 0,
      readSeq: 0,
      unread: 0,
      peerReadSeq: 0,
    });
    expect(direct.members.map((m: any) => m.id).sort()).toEqual([a.id, d.id].sort());

    // Only what dave can see: the join notice and what came after, exactly as the history route shows it.
    const texts = s.json.messages.map((m: any) => m.text);
    expect(texts).toContain("after dave");
    for (const hidden of ["a to b", "before dave", "hidden from dave"]) expect(JSON.stringify(s.json)).not.toContain(hidden);
    expect(s.json.messages.filter((m: any) => m.conversationId === g)).toEqual((await history(d, g)).json.messages);
    expect(s.json.messages.every((m: any) => [g, ad].includes(m.conversationId))).toBe(true);
    for (const m of s.json.messages) for (const k of Object.keys(m)) expect(WIRE_KEYS.has(k)).toBe(true);

    // Everyone referenced, nobody else (erin is alice's friend but nowhere in dave's view).
    expect(s.json.principals.map((p: any) => p.id).sort()).toEqual([a.id, b.id, c.id, d.id].sort());
    expect(s.json.principals.find((p: any) => p.id === b.id)).toEqual({ id: b.id, handle: b.handle, displayName: "bob", avatarVersion: 0, kind: "human" });
  });

  it("is empty and well-formed for a brand-new user", async () => {
    const [n] = await people("newbie");
    expect(await sync(n)).toEqual({
      status: 200,
      json: {
        me: { id: n.id, handle: n.handle, displayName: "newbie", avatarVersion: 0, email: n.email },
        conversations: [],
        principals: [{ id: n.id, handle: n.handle, displayName: "newbie", avatarVersion: 0, kind: "human" }],
        messages: [],
      },
    });
  });

  it("lists senders who have since left, but only to readers who can see their messages", async () => {
    const [a, b, c, d] = await people("alice", "bob", "carol", "dave");
    const g = await group(app, a, "team", [b, c]);
    await say(c, g, "from carol");
    expect((await remove(c, g, c)).status).toBe(200);

    const sa = (await sync(a)).json;
    expect(sa.principals.map((p: any) => p.id)).toContain(c.id);
    expect(sa.conversations.find((x: any) => x.id === g).members.map((m: any) => m.id)).not.toContain(c.id);
    expect(sa.messages.some((m: any) => m.senderId === c.id && m.text === "from carol")).toBe(true);

    await befriend(app, a, d);
    expect((await add(a, g, d)).status).toBe(201);
    const sd = (await sync(d)).json;
    expect(sd.principals.map((p: any) => p.id).sort()).toEqual([a.id, b.id, d.id].sort());
    expect(JSON.stringify(sd)).not.toContain(c.id);
  });

  it("a direct chat's peer and canSend come from its pair, as for a send, and it has no creator; a group's creator is consistent", async () => {
    const [a, b, c] = await people("alice", "bob", "carol");
    const { conversationId: dm } = await befriend(app, a, b);
    const g = await group(app, a, "team", [b, c]);
    const view = async () => (await sync(a)).json.conversations as any[];

    const direct = (await view()).find((x) => x.id === dm);
    expect(direct).not.toHaveProperty("creatorId");
    expect(direct.peerId).toBe(b.id);
    expect(direct.members.map((m: any) => m.isCreator)).toEqual([false, false]);
    const team = (await view()).find((x) => x.id === g);
    expect(team.creatorId).toBe(a.id);
    expect(team.members.filter((m: any) => m.isCreator).map((m: any) => m.id)).toEqual([a.id]);

    // The peer's membership row is not what decides: with it ended (direct chats are never left, so only a
    // broken row could do this) sync still names the peer and agrees with the send path.
    await db.query("update memberships set left_seq = 0 where conversation_id = $1 and principal_id = $2", [dm, b.id]);
    const after = (await view()).find((x) => x.id === dm);
    expect(after).toMatchObject({ peerId: b.id, canSend: { ok: true } });
    expect(after).not.toHaveProperty("peerReadSeq");
    expect((await say(a, dm, "still allowed")).status).toBe(201);
    await api(app, a, "PUT", `/api/blocks/${b.id}`);
    expect((await view()).find((x) => x.id === dm).canSend).toEqual({ ok: false, reason: "blocked" });
    expect(await say(a, dm, "refused")).toMatchObject({ status: 403, json: { error: "cannot_send", reason: "blocked" } });
  });

  it("counts unread visible messages from others, shows the peer's read position and canSend in direct chats", async () => {
    const [a, b] = await people("alice", "bob");
    const { conversationId: dm } = await befriend(app, a, b);
    for (const t of ["1", "2", "3"]) await say(a, dm, t);
    await say(b, dm, "mine");

    const conv = async (who: Actor) => (await sync(who)).json.conversations.find((x: any) => x.id === dm);
    expect(await conv(b)).toMatchObject({ unread: 3, readSeq: 0, lastSeq: 4, peerReadSeq: 0 });
    expect((await markRead(b, dm, 2)).status).toBe(200);
    expect(await conv(b)).toMatchObject({ unread: 1, readSeq: 2 });
    expect(await conv(a)).toMatchObject({ unread: 1, readSeq: 0, peerReadSeq: 2 });

    // Notices are not unread messages; canSend follows blocks and the friendship.
    expect((await api(app, a, "PUT", `/api/blocks/${b.id}`)).status).toBe(200);
    expect(await conv(b)).toMatchObject({ unread: 1, canSend: { ok: false, reason: "blocked" } });
    expect(await conv(a)).toMatchObject({ canSend: { ok: false, reason: "blocked" } });
    expect((await api(app, a, "DELETE", `/api/blocks/${b.id}`)).status).toBe(200);
    expect(await conv(b)).toMatchObject({ canSend: { ok: true } });
    expect((await api(app, a, "DELETE", `/api/friends/${b.id}`)).status).toBe(200);
    expect(await conv(b)).toMatchObject({ unread: 1, canSend: { ok: false, reason: "not_friends" } });
  });

  it("each conversation carries its createdAt, so one without any messages can be placed too", async () => {
    const [a, b, c] = await people("alice", "bob", "carol");
    const { conversationId: ab } = await befriend(app, a, b); // a new direct chat has no messages at all
    const { conversationId: ac } = await befriend(app, a, c);
    const g = await group(app, a, "team", [b, c]);
    const created = new Map(
      (await db.query<{ id: string; created_at: Date }>("select id, created_at from conversations")).rows.map((r) => [r.id, r.created_at.toISOString()]),
    );
    const s = (await sync(a)).json;
    expect(s.messages.filter((m: any) => m.conversationId !== g)).toEqual([]);
    expect(s.conversations.map((x: any) => [x.id, x.createdAt])).toEqual([
      [ab, created.get(ab)],
      [ac, created.get(ac)],
      [g, created.get(g)],
    ]);
  });

  it("returns the last 30 visible messages per conversation, ascending", async () => {
    const [a, b] = await people("alice", "bob");
    const { conversationId: dm } = await befriend(app, a, b);
    await bulk(dm, a.id, 35);
    const s = (await sync(b)).json;
    expect(s.messages.map((m: any) => m.seq)).toEqual(Array.from({ length: 30 }, (_, i) => i + 6));
    expect(s.conversations[0]).toMatchObject({ lastSeq: 35, unread: 35 });
  });
});

describe("GET /api/conversations/:id", () => {
  const getOne = (who: Actor, conv: string) => api(app, who, "GET", `/api/conversations/${conv}`);
  /** The caller's entry for `conv` in a full sync. */
  const entry = async (who: Actor, conv: string) => (await sync(who)).json.conversations.find((x: any) => x.id === conv);

  it("is the caller's /api/sync entry for that one conversation, direct or group, as it changes", async () => {
    const [a, b, c, d] = await people("alice", "bob", "carol", "dave");
    const { conversationId: dm } = await befriend(app, a, b);
    const g = await group(app, a, "team", [b, c]);
    await say(a, dm, "hi");
    await say(b, g, "hello team");
    await markRead(b, dm, 1);

    for (const who of [a, b]) {
      for (const conv of [dm, g]) {
        const res = await getOne(who, conv);
        expect(res.status).toBe(200);
        expect(res.json).toEqual(await entry(who, conv));
      }
    }
    expect((await getOne(c, g)).json).toEqual(await entry(c, g));
    expect((await getOne(a, g.toUpperCase())).json).toEqual(await entry(a, g));

    // After a `conversation` push this is what a client fetches: it shows the change.
    await befriend(app, a, d);
    expect((await rename(a, g, "renamed")).status).toBe(200);
    expect((await add(a, g, d)).status).toBe(201);
    await api(app, a, "PUT", `/api/blocks/${b.id}`);
    const team = (await getOne(c, g)).json;
    expect(team).toMatchObject({ title: "renamed" });
    expect(team.members.map((m: any) => m.id)).toContain(d.id);
    expect(team).toEqual(await entry(c, g));
    const blocked = (await getOne(b, dm)).json;
    expect(blocked.canSend).toEqual({ ok: false, reason: "blocked" });
    expect(blocked).toEqual(await entry(b, dm));
    expect((await getOne(d, g)).json).toEqual(await entry(d, g));
  });

  it("is 404 not_found for a conversation you are not in now, like an id that does not exist", async () => {
    const [a, b, c] = await people("alice", "bob", "carol");
    const g = await group(app, a, "team", [b, c]);
    const { conversationId: bc } = await befriend(app, b, c);
    const NOT_FOUND = { status: 404, json: { error: "not_found" } };
    expect(await getOne(a, bc)).toEqual(NOT_FOUND); // never in it
    expect((await remove(c, g, c)).status).toBe(200);
    expect(await getOne(c, g)).toEqual(NOT_FOUND); // left
    expect((await remove(a, g, b)).status).toBe(200);
    expect(await getOne(b, g)).toEqual(NOT_FOUND); // removed
    expect(await getOne(a, RANDOM_ID)).toEqual(NOT_FOUND);
    expect(await api(app, null, "GET", `/api/conversations/${g}`)).toEqual({ status: 401, json: { error: "unauthenticated" } });
    expect((await getOne(a, "not-a-uuid")).status).toBe(400);
  });
});

describe("POST /api/sync/catchup", () => {
  it("catchup returns exactly the missed messages in order, lists conversations I left, and never returns invisible ones even when I send positions for conversations I am not in", async () => {
    const [a, b, c, d] = await people("alice", "bob", "carol", "dave");
    const { conversationId: dm } = await befriend(app, a, b);
    const g1 = await group(app, a, "mine", [b, c]);
    const g2 = await group(app, b, "left", [a, c]);
    const g3 = await group(app, b, "never", [c, d]);
    await say(a, dm, "d1");
    await say(b, dm, "d2");
    await say(b, dm, "d3");
    await say(b, g1, "g1 first");
    await say(c, g1, "g1 second");
    await say(b, g2, "before I left");
    expect((await remove(a, g2, a)).status).toBe(200);
    await say(b, g2, "after I left");
    await say(b, g3, "never mine");

    const res = await catchup(a, { [dm]: 1, [g1]: 1, [g2]: 0, [g3]: 0, [RANDOM_ID]: 0 });
    expect(res.status).toBe(200);
    expect(res.json.messages.map((m: any) => [m.conversationId, m.seq, m.text])).toEqual([
      [dm, 2, "d2"],
      [dm, 3, "d3"],
      [g1, 2, "g1 first"],
      [g1, 3, "g1 second"],
    ]);
    for (const m of res.json.messages) expect(m).toEqual((await one(a, m.conversationId, m.seq)).json.message);
    expect(res.json.gone).toEqual([g2, g3, RANDOM_ID]);
    expect(res.json.more).toBe(false);
    for (const hidden of ["before I left", "after I left", "never mine"]) expect(JSON.stringify(res.json)).not.toContain(hidden);

    // Up to date, or a conversation I am in but sent no position for: nothing.
    expect((await catchup(a, { [dm]: 3 })).json).toEqual({ messages: [], gone: [], more: false });
    expect((await catchup(a, { [g1]: 3 })).json).toEqual({ messages: [], gone: [], more: false });
  });

  it("treats a conversation I left, one I was never in and a random id identically: only `gone`", async () => {
    const [a, b, c, d] = await people("alice", "bob", "carol", "dave");
    const left = await group(app, b, "left", [a, c]);
    const never = await group(app, b, "never", [c, d]);
    await say(b, left, "x");
    await say(b, never, "y");
    expect((await remove(a, left, a)).status).toBe(200);

    for (const id of [left, never, RANDOM_ID]) {
      expect(await catchup(a, { [id]: 0 })).toEqual({ status: 200, json: { messages: [], gone: [id], more: false } });
      expect(await catchup(a, { [id.toUpperCase()]: 5 })).toEqual({ status: 200, json: { messages: [], gone: [id], more: false } });
    }
  });

  it("caps a response at 500 messages, says more, and continues without skipping or repeating", async () => {
    const [a, b, c] = await people("alice", "bob", "carol");
    const { conversationId: dm } = await befriend(app, a, b);
    const g = await group(app, a, "busy", [b, c]);
    await bulk(dm, b.id, 400);
    await bulk(g, c.id, 300); // seq 2..301 (1 is the creation notice)

    const positions: Record<string, number> = { [dm]: 0, [g]: 1 };
    const seen: Array<[string, number]> = [];
    let more = true;
    let calls = 0;
    while (more) {
      const res = await catchup(a, positions);
      expect(res.status).toBe(200);
      calls++;
      if (calls === 1) expect(res.json.messages).toHaveLength(500);
      for (const m of res.json.messages) {
        // per conversation strictly the next seq: safe to advance the position message by message
        expect(m.seq).toBe(positions[m.conversationId]! + 1);
        positions[m.conversationId] = m.seq;
        seen.push([m.conversationId, m.seq]);
      }
      more = res.json.more;
      expect(calls).toBeLessThan(5);
    }
    expect(calls).toBe(2);
    expect(seen).toHaveLength(700);
    expect(positions).toEqual({ [dm]: 400, [g]: 301 });
  });

  it("validates positions: at most 500 uuid keys, non-negative safe integers, no case duplicates", async () => {
    const [a, b] = await people("alice", "bob");
    const { conversationId: dm } = await befriend(app, a, b);
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`);
    expect((await catchup(a, Object.fromEntries(ids(500).map((id) => [id, 0])))).status).toBe(200);
    expect(await catchup(a, Object.fromEntries(ids(501).map((id) => [id, 0])))).toEqual({ status: 400, json: INVALID });
    for (const bad of [-1, 1.5, "3", 2 ** 53, null, true]) {
      expect([bad, await catchup(a, { [dm]: bad })]).toEqual([bad, { status: 400, json: INVALID }]);
    }
    for (const bad of [{ "not-a-uuid": 0 }, { [dm]: 0, [dm.toUpperCase()]: 0 }, [], "x", null]) {
      expect([bad, await catchup(a, bad)]).toEqual([bad, { status: 400, json: INVALID }]);
    }
    expect(await api(app, a, "POST", "/api/sync/catchup", {})).toEqual({ status: 400, json: INVALID });
    expect(await api(app, null, "POST", "/api/sync/catchup", { positions: {} })).toEqual({
      status: 401,
      json: { error: "unauthenticated" },
    });
  });
});

describe("websocket pushes", () => {
  it("a new message is pushed to every current member's socket and to nobody else", async () => {
    const [a, b, c, o] = await people("alice", "bob", "carol", "outsider");
    const g = await group(app, a, "team", [b, c]);
    await befriend(app, a, o);
    const sockets = new Map<Actor, Awaited<ReturnType<typeof connect>>>();
    for (const who of [a, b, c, o]) sockets.set(who, await connect(app, who));

    const sent = await say(b, g, "hello team");
    const seq = sent.json.message.seq as number;
    for (const who of [a, b, c]) {
      const event = await sockets.get(who)!.next(isMessage(g, seq));
      expect(event).toEqual({ type: "message", message: (await one(who, g, seq)).json.message });
    }

    // Sentinel: adding the outsider is ordered after the message in this conversation's stream.
    expect((await add(a, g, o)).status).toBe(201);
    const so = sockets.get(o)!;
    const joined = await so.waitFor(isMessage(g));
    expect(so.events[joined]!.message).toMatchObject({ seq: seq + 1, kind: "system", system: { event: "member_joined" } });
    expect(so.events.slice(0, joined).filter(about(g))).toEqual([]);
    expect(JSON.stringify(so.events)).not.toContain("hello team");
  });

  it("a socket that was open when its owner was removed receives a gone event and then nothing more from that conversation", async () => {
    const [a, b, c] = await people("alice", "bob", "carol");
    const g = await group(app, a, "team", [b, c]);
    const sb = await connect(app, b);
    const sc = await connect(app, c);
    const first = await say(a, g, "while carol is here");
    await sc.next(isMessage(g, first.json.message.seq));

    expect((await remove(a, g, c)).status).toBe(200);
    const goneAt = await sc.waitFor((e) => e.type === "gone" && e.id === g);
    expect(sc.events[goneAt]).toEqual({ type: "gone", id: g });
    await sb.next((e) => e.type === "message" && e.message.system?.event === "member_removed");
    await sb.next((e) => e.type === "conversation" && e.id === g);

    // The conversation stays busy: messages, a rename, read markers.
    for (let i = 0; i < 5; i++) await say(i % 2 ? a : b, g, `after removal ${i}`);
    expect((await rename(a, g, "renamed")).status).toBe(200);
    expect((await markRead(b, g, await lastSeq(g))).status).toBe(200);
    await sb.next((e) => e.type === "message" && e.message.system?.event === "group_renamed");

    // Sentinel: re-adding carol is ordered after all of that in the conversation's stream.
    expect((await add(a, g, c)).status).toBe(201);
    const back = await sc.waitFor(isMessage(g), { from: goneAt + 1 });
    expect(sc.events[back]!.message).toMatchObject({ seq: await lastSeq(g), system: { event: "member_joined", principalId: c.id } });
    expect(sc.events.slice(goneAt + 1, back).filter(about(g))).toEqual([]);
    expect(sc.events.slice(0, goneAt).some((e) => e.type === "message" && e.message.system?.event === "member_removed")).toBe(false);
    const log = JSON.stringify(sc.events);
    expect(log).not.toContain("after removal");
    expect(log).not.toContain("renamed");
  });

  it("a socket opened before joining receives no pre-join pushes; after joining it does", async () => {
    const [a, b, c, d] = await people("alice", "bob", "carol", "dave");
    const g = await group(app, a, "team", [b, c]);
    await befriend(app, a, d);
    const sd = await connect(app, d);
    await say(a, g, "pre-join one");
    await say(b, g, "pre-join two");

    expect((await add(a, g, d)).status).toBe(201);
    const joined = await sd.waitFor(isMessage(g));
    expect(sd.events[joined]!.message.system.event).toBe("member_joined");
    expect(sd.events.slice(0, joined).filter(about(g))).toEqual([]);
    await sd.next((e) => e.type === "conversation" && e.id === g, { from: joined });

    const welcome = await say(b, g, "welcome dave");
    expect((await sd.next(isMessage(g, welcome.json.message.seq))).message.text).toBe("welcome dave");
    expect(JSON.stringify(sd.events)).not.toContain("pre-join");
  });

  it("fans out a quote of a pre-join message with replyTo.visible=false to the late joiner only", async () => {
    const [a, b, c, d] = await people("alice", "bob", "carol", "dave");
    await befriend(app, a, d);
    const g = await group(app, a, "team", [b, c]);
    const secret = await say(b, g, "the secret plan");
    expect((await add(a, g, d)).status).toBe(201);
    const sb = await connect(app, b);
    const sd = await connect(app, d);

    const reply = await say(a, g, "about that", { replyToSeq: secret.json.message.seq });
    const seq = reply.json.message.seq;
    const forDave = await sd.next(isMessage(g, seq));
    expect(forDave.message.replyTo).toEqual({ seq: secret.json.message.seq, visible: false });
    expect(JSON.stringify(sd.events)).not.toContain("the secret plan");
    const forBob = await sb.next(isMessage(g, seq));
    expect(forBob.message.replyTo).toEqual({ seq: secret.json.message.seq, visible: true, senderId: b.id, text: "the secret plan", kind: "text" });
  });

  it("delivers to every socket of a principal", async () => {
    const [a, b] = await people("alice", "bob");
    const { conversationId: dm } = await befriend(app, a, b);
    const one1 = await connect(app, a);
    const one2 = await connect(app, await secondSession(a));
    const sent = await say(b, dm, "to both tabs");
    for (const s of [one1, one2]) expect((await s.next(isMessage(dm, sent.json.message.seq))).message.text).toBe("to both tabs");
  });

  it("closes the oldest socket when a principal opens a sixth", async () => {
    const [a, b] = await people("alice", "bob");
    const { conversationId: dm } = await befriend(app, a, b);
    const sockets = [];
    for (let i = 0; i < 6; i++) sockets.push(await connect(app, a));
    expect(await sockets[0]!.closed).toEqual({ code: 4002, reason: "replaced" });

    const sent = await say(b, dm, "still five");
    for (const s of sockets.slice(1)) await s.next(isMessage(dm, sent.json.message.seq));
    expect(sockets.slice(1).every((s) => !s.isClosed)).toBe(true);
  });

  it("pushes system notices and conversation events to current members", async () => {
    const [a, b, c] = await people("alice", "bob", "carol");
    const g = await group(app, a, "team", [b, c]);
    const sb = await connect(app, b);
    const sc = await connect(app, c);

    expect((await rename(a, g, "new name")).status).toBe(200);
    for (const s of [sb, sc]) {
      const notice = await s.next((e) => e.type === "message" && e.message.conversationId === g);
      expect(notice.message).toMatchObject({ kind: "system", senderId: null, system: { event: "group_renamed", title: "new name" } });
      await s.next((e) => e.type === "conversation" && e.id === g);
    }

    // The creator leaving hands over the role: a membership and creator change for everyone left.
    const from = sb.events.length;
    expect((await remove(a, g, a)).status).toBe(200);
    const left = await sb.next((e) => isMessage(g)(e) && e.message.system?.event === "member_left", { from });
    expect([b.id, c.id]).toContain(left.message.system.newCreatorId); // founders tie on joined_seq
    await sb.next((e) => e.type === "conversation" && e.id === g, { from });

    // The last members leaving closes it; the leaver's own sockets get `gone`.
    expect((await remove(c, g, c)).status).toBe(200);
    await sc.next((e) => e.type === "gone" && e.id === g);
    expect((await remove(b, g, b)).status).toBe(200);
    await sb.next((e) => e.type === "gone" && e.id === g);
  });

  it("social events reach both parties; a block also flips the direct chat with a conversation event", async () => {
    const [a, b] = await people("alice", "bob");
    const sa = await connect(app, a);
    const sb = await connect(app, b);

    const req = await api(app, a, "POST", "/api/friend-requests", { handle: b.handle });
    expect(req.status).toBe(201);
    await sa.next((e) => e.type === "social");
    await sb.next((e) => e.type === "social");

    const mark = [sa.events.length, sb.events.length] as const;
    const accepted = await api(app, b, "POST", `/api/friend-requests/${req.json.id}/accept`);
    const dm = accepted.json.conversationId as string;
    for (const [s, from] of [[sa, mark[0]], [sb, mark[1]]] as const) {
      await s.next((e) => e.type === "social", { from });
      await s.next((e) => e.type === "conversation" && e.id === dm, { from });
    }

    const mark2 = [sa.events.length, sb.events.length] as const;
    expect((await api(app, a, "PUT", `/api/blocks/${b.id}`)).status).toBe(200);
    for (const [s, from] of [[sa, mark2[0]], [sb, mark2[1]]] as const) {
      await s.next((e) => e.type === "social", { from });
      await s.next((e) => isMessage(dm)(e) && e.message.system?.event === "blocked", { from });
      await s.next((e) => e.type === "conversation" && e.id === dm, { from });
    }
  });

  it("peer read position is pushed in a direct chat and not exposed in groups", async () => {
    const [a, b, c] = await people("alice", "bob", "carol");
    const { conversationId: dm } = await befriend(app, a, b);
    const g = await group(app, a, "team", [b, c]);
    await say(a, dm, "one");
    await say(a, dm, "two");
    const sa = await connect(app, a);
    const sc = await connect(app, c);

    expect((await markRead(b, dm, 2)).status).toBe(200);
    expect(await sa.next((e) => e.type === "read")).toEqual({ type: "read", conversationId: dm, principalId: b.id, seq: 2 });
    // A marker that does not move is not announced again; the next real move is (and is the sentinel).
    expect((await markRead(b, dm, 2)).json).toEqual({ readSeq: 2 });
    expect((await markRead(b, dm, 1)).json).toEqual({ readSeq: 2 });
    await say(a, dm, "three");
    expect((await markRead(b, dm, 3)).status).toBe(200);
    await sa.next((e) => e.type === "read" && e.seq === 3);
    expect(sa.events.filter((e) => e.type === "read").map((e) => e.seq)).toEqual([2, 3]);

    await say(b, g, "group message");
    expect((await markRead(a, g, await lastSeq(g))).status).toBe(200);
    expect((await markRead(b, g, await lastSeq(g))).status).toBe(200);
    const sentinel = await say(b, g, "sentinel");
    const at = await sc.waitFor(isMessage(g, sentinel.json.message.seq));
    expect(sc.events.slice(0, at).filter((e) => e.type === "read")).toEqual([]);
    const syncC = (await sync(c)).json.conversations.find((x: any) => x.id === g);
    expect(syncC).not.toHaveProperty("peerReadSeq");
  });

  it("answers an application ping with a pong and ignores every other inbound message", async () => {
    const [a] = await people("alice");
    const s = await connect(app, a);
    s.send(JSON.stringify({ type: "subscribe", conversationId: RANDOM_ID }));
    s.send("not json at all");
    s.send(JSON.stringify({ type: "ping" }));
    expect(await s.next(() => true)).toEqual({ type: "pong" });
    expect(s.isClosed).toBe(false);
  });
});

describe("websocket authentication", () => {
  it("ticket is single-use and expires; a ticket from another session is useless; the long-lived session cookie alone cannot open the socket", async () => {
    const [a] = await people("alice");
    expect(await api(app, null, "POST", "/api/ws-ticket")).toEqual({ status: 401, json: { error: "unauthenticated" } });

    const ticket = await issueTicket(app, a);
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // A plain GET is not an upgrade: 404, and the ticket is not spent.
    const plain = await app.inject({ method: "GET", url: `/api/ws?ticket=${ticket}`, headers: { origin: "http://localhost:5173" } });
    expect([plain.statusCode, plain.json()]).toEqual([404, { error: "not_found" }]);
    expect("socket" in (await tryConnect(app, { ticket }))).toBe(true);
    expect(await tryConnect(app, { ticket })).toEqual({ status: 401 });

    const stale = await issueTicket(app, a);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 31_000);
      expect(await tryConnect(app, { ticket: stale })).toEqual({ status: 401 });
    } finally {
      vi.useRealTimers();
    }
    const fresh = await issueTicket(app, a);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 25_000);
      expect("socket" in (await tryConnect(app, { ticket: fresh }))).toBe(true);
    } finally {
      vi.useRealTimers();
    }

    // Bound to the session it was issued for: once that session ends, its tickets are dead.
    const other = await secondSession(a);
    const fromFirst = await issueTicket(app, a);
    expect((await api(app, a, "POST", "/api/auth/sign-out", {})).status).toBe(200);
    expect(await tryConnect(app, { ticket: fromFirst })).toEqual({ status: 401 });
    expect("socket" in (await tryConnect(app, { ticket: await issueTicket(app, other) }))).toBe(true);

    // The cookie alone opens nothing.
    expect(await tryConnect(app, { ticket: null, headers: { cookie: other.cookie } })).toEqual({ status: 400 });
    expect(await tryConnect(app, { ticket: "x".repeat(43), headers: { cookie: other.cookie } })).toEqual({ status: 401 });
  });

  it("refuses cross-origin upgrades and upgrades without an Origin", async () => {
    const [a] = await people("alice");
    const ticket = await issueTicket(app, a);
    for (const origin of ["http://evil.test", "http://localhost:5173.evil.test", "https://localhost:5173", null]) {
      expect([origin, await tryConnect(app, { ticket, origin })]).toEqual([origin, { status: 403 }]);
    }
  });

  it("an upgrade request to any other route is refused with 404 before that route's handler runs", async () => {
    const [a, b] = await people("alice", "bob");
    const { conversationId: dm } = await befriend(app, a, b);
    await say(a, dm, "not for a socket");
    const { port } = await listen(app);
    /** A WebSocket handshake for `path`, with the session cookie and the app's Origin; the raw answer. */
    const upgrade = (path: string) =>
      new Promise<string>((resolve) => {
        const socket = net.connect({ port, host: "127.0.0.1" });
        let got = "";
        socket.on("data", (c) => (got += c.toString("utf8")));
        socket.on("error", () => {});
        socket.on("close", () => resolve(got));
        socket.setTimeout(3000, () => socket.destroy());
        socket.write(
          [
            `GET ${path} HTTP/1.1`,
            `Host: 127.0.0.1:${port}`,
            "Upgrade: websocket",
            "Connection: Upgrade",
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
            "Sec-WebSocket-Version: 13",
            "Origin: http://localhost:5173",
            `Cookie: ${a.cookie}`,
            "",
            "",
          ].join("\r\n"),
        );
      });
    // /api/sync was registered before the WebSocket plugin: it used to answer with the caller's sync data.
    for (const path of ["/api/sync", "/api/me", "/api/health", `/api/conversations/${dm}/messages`, "/api/ws-ticket", "/api/nope"]) {
      const answer = await upgrade(path);
      expect([path, answer.split("\r\n")[0]]).toEqual([path, "HTTP/1.1 404 Not Found"]);
      expect(answer.endsWith('{"error":"not_found"}')).toBe(true);
      expect(answer).not.toContain("not for a socket");
      expect(answer).not.toContain(a.handle);
    }
    // The WebSocket route itself still upgrades.
    const socket = await connect(app, a);
    socket.send(JSON.stringify({ type: "ping" }));
    await socket.next((e) => e.type === "pong");
  });

  it("sign-out and password reset close that session's sockets", async () => {
    const [a, b] = await people("alice", "bob");
    const { conversationId: dm } = await befriend(app, a, b);
    const other = await secondSession(a);
    const w1 = await connect(app, a);
    const w2 = await connect(app, other);

    expect((await api(app, a, "POST", "/api/auth/sign-out", {})).status).toBe(200);
    expect(await w1.closed).toEqual({ code: 4001, reason: "session_ended" });
    const sent = await say(b, dm, "still there?");
    await w2.next(isMessage(dm, sent.json.message.seq));
    expect(w2.isClosed).toBe(false);

    const w3 = await connect(app, await secondSession(a));
    await resetPassword(a);
    expect(await w2.closed).toEqual({ code: 4001, reason: "session_ended" });
    expect(await w3.closed).toEqual({ code: 4001, reason: "session_ended" });
  });

  it("an unmasked or oversized frame closes the socket and the server keeps serving", async () => {
    const [a] = await people("alice");

    // The prototype crashed on exactly this: an unmasked client frame on an upgraded socket.
    const raw = await rawUpgrade(app, await issueTicket(app, a));
    raw.socket.write(Buffer.from([0x81, 0x01, 0x41]));
    await raw.ended;
    const frame = raw.received();
    expect(frame[0]).toBe(0x88); // close
    expect(frame.readUInt16BE(2)).toBe(1002); // protocol error

    const big = await connect(app, a);
    big.send("x".repeat(4097));
    expect((await big.closed).code).toBe(1009);

    const binary = await connect(app, a);
    binary.send(Buffer.from([1, 2, 3]), { binary: true });
    expect((await binary.closed).code).toBe(1003);

    const { http } = await listen(app);
    const health = await fetch(`${http}/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });

    const fine = await connect(app, a);
    fine.send(JSON.stringify({ type: "ping" }));
    await fine.next((e) => e.type === "pong");
    // exactly 4 KB is still accepted
    const fourKb = JSON.stringify({ type: "x", pad: "y".repeat(4096 - 21) });
    expect(Buffer.byteLength(fourKb)).toBe(4096);
    fine.send(fourKb);
    fine.send(JSON.stringify({ type: "ping" }));
    await fine.next((e) => e.type === "pong", { from: 1 });
    expect(fine.isClosed).toBe(false);
  });

  it("a heartbeat drops peers that stop answering pings and sockets whose session expired", async () => {
    const [a, b] = await people("alice", "bob");
    const live = await connect(app, b);
    const expiring = await connect(app, a);
    await db.query(
      `update "session" set "expiresAt" = now() - interval '1 second'
        where "userId" = (select auth_user_id from principals where id = $1)`,
      [a.id],
    );
    const dead = await rawUpgrade(app, await issueTicket(app, b)); // never answers a ping

    const pinged = new Promise((resolve) => live.ws.once("ping", resolve));
    await app.realtime.tick();
    expect(await expiring.closed).toEqual({ code: 4001, reason: "session_ended" });
    // The client library answers the ping before this text frame, so once the pong for it comes
    // back the server has seen the live socket's answer.
    await pinged;
    const from = live.events.length;
    live.send(JSON.stringify({ type: "ping" }));
    await live.next((e) => e.type === "pong", { from });

    await app.realtime.tick();
    await dead.ended;
    expect(live.isClosed).toBe(false);
  });
});

describe("avatar changes are announced with a version", () => {
  const putMine = (who: Actor, payload: Buffer = PNG) =>
    app.inject({ method: "PUT", url: "/api/me/avatar", headers: { cookie: who.cookie, "content-type": "image/png" }, payload });
  const isPrincipal = (id: string) => (e: Push) => e.type === "principal" && e.id === id;

  it("reaches the uploader, friends and people who share a conversation, and nobody else; every wire principal carries the version", async () => {
    const [a, b, c, d, e, f] = await people("alice", "bob", "carol", "dave", "erin", "fay");
    const g = await group(app, b, "team", [a, f]); // alice and fay are no friends: they only share this group
    await befriend(app, a, e);
    const sockets = new Map<Actor, Awaited<ReturnType<typeof connect>>>();
    for (const who of [a, b, c, d, e, f]) sockets.set(who, await connect(app, who));

    expect(((await sync(b)).json.principals as any[]).find((p) => p.id === a.id)).toMatchObject({ avatarVersion: 0 });
    expect((await putMine(a)).statusCode).toBe(200);
    for (const who of [a, b, e, f]) {
      expect(await sockets.get(who)!.next(isPrincipal(a.id))).toEqual({ type: "principal", id: a.id, avatarVersion: 1, handle: a.handle });
    }
    // A sentinel for the ones that must hear nothing: they receive something later, and by then the push would have come.
    await api(app, c, "POST", "/api/friend-requests", { handle: d.handle });
    await sockets.get(c)!.next((ev) => ev.type === "social");
    await sockets.get(d)!.next((ev) => ev.type === "social");
    for (const who of [c, d]) expect(sockets.get(who)!.events.filter((ev) => ev.type === "principal")).toEqual([]);

    const seen = (await sync(b)).json;
    expect(seen.principals.find((p: any) => p.id === a.id)).toMatchObject({ avatarVersion: 1 });
    expect(seen.me).toMatchObject({ avatarVersion: 0 });
    expect((await sync(a)).json.me).toMatchObject({ avatarVersion: 1 });
    expect((await api(app, a, "GET", "/api/me")).json).toMatchObject({ avatarVersion: 1 });
    expect((await api(app, b, "GET", `/api/conversations/${g}/members`)).json.members.find((m: any) => m.id === a.id)).toMatchObject({ avatarVersion: 1 });
    expect((await api(app, b, "GET", "/api/social")).json.friends.find((f: any) => f.id === a.id)).toMatchObject({ avatarVersion: 1 });
    expect((await api(app, c, "GET", `/api/principals/lookup?handle=${a.handle}`)).json).toMatchObject({ id: a.id, avatarVersion: 1 });
    const sent = await say(a, g, "hi");
    const msgs = await api(app, b, "GET", `/api/conversations/${g}/messages?limit=10`);
    expect(msgs.json.principals[a.id]).toMatchObject({ avatarVersion: 1 });
    expect(sent.status).toBe(201);
    // The avatar route still ignores ?v= and is cached for a minute.
    const got = await app.inject({ method: "GET", url: `/api/principals/${a.id}/avatar?v=7`, headers: { cookie: b.cookie } });
    expect([got.statusCode, got.headers["cache-control"]]).toEqual([200, "private, max-age=60"]);
  });

  it("a peer who shared only a group with the uploader, and has left it, hears nothing of a later change", async () => {
    const [a, b, f, c] = await people("alice", "bob", "fay", "carl");
    const g = await group(app, b, "team", [a, f]); // alice and fay are no friends: they only share this group
    const sf = await connect(app, f);
    expect((await putMine(a)).statusCode).toBe(200);
    await sf.next(isPrincipal(a.id)); // while in the group, fay hears of it
    expect((await remove(f, g, f)).status).toBe(200);
    await sf.next((e) => e.type === "gone" && e.id === g);

    expect((await putMine(a)).statusCode).toBe(200);
    // A sentinel: fay receives something sent after the change, and by then its push would have come.
    expect((await api(app, c, "POST", "/api/friend-requests", { handle: f.handle })).status).toBe(201);
    await sf.next((e) => e.type === "social");
    expect(sf.events.filter(isPrincipal(a.id))).toEqual([{ type: "principal", id: a.id, avatarVersion: 1, handle: a.handle }]);
  });

  it("a refused upload announces nothing", async () => {
    const [a, b] = await people("alice", "bob");
    await befriend(app, a, b);
    const sb = await connect(app, b);
    expect((await putMine(a, Buffer.from("<svg/>"))).statusCode).toBe(400);
    await api(app, a, "PATCH", "/api/me", { displayName: "Alice B" }); // no push of its own; sentinel below instead
    expect((await putMine(a)).statusCode).toBe(200);
    await sb.next(isPrincipal(a.id));
    expect(sb.events.filter(isPrincipal(a.id))).toEqual([{ type: "principal", id: a.id, avatarVersion: 1, handle: a.handle }]);
  });
});
