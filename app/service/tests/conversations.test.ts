import { describe, expect, it } from "vitest";
import { onMembershipChanged, onMessages } from "../src/conversations/events.ts";
import { canSend, listMembers, visibleJoin } from "../src/conversations/store.ts";
import type { StoredMessage } from "../src/messages/model.ts";
import { api, befriend, group, signUp, type Actor } from "./helpers/actors.ts";
import { useApp } from "./helpers/harness.ts";

const { app, db } = useApp();

const NOT_FOUND = { error: "not_found" };
const FORBIDDEN = { error: "forbidden" };
const RANDOM_ID = "00000000-0000-4000-8000-000000000000";

let txn = 0;
const idOf = (t: Actor | string) => (typeof t === "string" ? t : t.id);
const say = (who: Actor, conv: string, text: string) =>
  api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `c${++txn}` });
const history = (who: Actor, conv: string) => api(app, who, "GET", `/api/conversations/${conv}/messages`);
const members = (who: Actor, conv: string) => api(app, who, "GET", `/api/conversations/${conv}/members`);
const add = (who: Actor, conv: string, target: Actor | string) =>
  api(app, who, "POST", `/api/conversations/${conv}/members`, { principalId: idOf(target) });
const remove = (who: Actor, conv: string, target: Actor | string) =>
  api(app, who, "DELETE", `/api/conversations/${conv}/members/${idOf(target)}`);
const rename = (who: Actor, conv: string, title: string) =>
  api(app, who, "PATCH", `/api/conversations/${conv}`, { title });
const create = (who: Actor, title: string, memberIds: string[]) =>
  api(app, who, "POST", "/api/conversations", { title, memberIds });
const memberIds = async (who: Actor, conv: string): Promise<string[]> =>
  (await members(who, conv)).json.members.map((m: { id: string }) => m.id).sort();
const count = async (sql: string, params: unknown[] = []) =>
  Number((await db.query<{ n: string }>(sql, params)).rows[0]!.n);
const events = async (who: Actor, conv: string): Promise<string[]> =>
  (await history(who, conv)).json.messages.filter((m: any) => m.kind === "system").map((m: any) => m.system.event);
const creatorOf = async (conv: string) =>
  (await db.query<{ creator_id: string }>("select creator_id from conversations where id = $1", [conv])).rows[0]!.creator_id;

async function people<const N extends string[]>(...names: N): Promise<{ [K in keyof N]: Actor }> {
  const out: Actor[] = [];
  for (const n of names) out.push(await signUp(app, n));
  return out as { [K in keyof N]: Actor };
}

describe("group creation", () => {
  it("creates a group of the creator and two friends; everyone sees the creation notice and the member list", async () => {
    const [a, b, c] = await people("alice", "bob", "carol");
    await befriend(app, a, b);
    await befriend(app, a, c);
    const res = await create(a, "  周末出游  ", [b.id, c.id]);
    expect(res.status).toBe(201);
    const id = res.json.id as string;

    const list = await members(b, id);
    expect(list.status).toBe(200);
    expect(list.json.members).toHaveLength(3);
    const byId = new Map(list.json.members.map((m: any) => [m.id, m]));
    expect(byId.get(a.id)).toEqual({ id: a.id, handle: a.handle, displayName: "alice", avatarVersion: 0, kind: "human", role: "speaker", isCreator: true });
    expect(byId.get(b.id)).toMatchObject({ handle: b.handle, displayName: "bob", kind: "human", role: "speaker", isCreator: false });
    expect(byId.get(c.id)).toMatchObject({ isCreator: false });

    for (const who of [a, b, c]) {
      const h = await history(who, id);
      expect(h.status).toBe(200);
      expect(h.json.messages).toHaveLength(1);
      const notice = h.json.messages[0];
      expect(notice).toMatchObject({ conversationId: id, seq: 1, senderId: null, kind: "system" });
      expect(notice.system).toMatchObject({ event: "group_created", actorId: a.id, title: "周末出游" });
      expect(notice.text).toContain("alice");
      expect(notice.text).toContain("周末出游");
    }
    const row = await db.query("select type, title, creator_id, seq from conversations where id = $1", [id]);
    expect(row.rows[0]).toMatchObject({ type: "group", title: "周末出游", creator_id: a.id });
  });

  it("refuses fewer than two members, the creator itself, duplicates and bad titles with 400, and non-friends or blocked friends with 403", async () => {
    const [a, b, c, d] = await people("alice", "bob", "carol", "dave");
    await befriend(app, a, b);
    await befriend(app, a, c);

    expect((await create(a, "x", [b.id])).json).toEqual({ error: "invalid_request" });
    expect((await create(a, "x", [b.id, b.id.toUpperCase()])).status).toBe(400);
    expect((await create(a, "x", [a.id, b.id])).status).toBe(400);
    expect((await create(a, "x", [])).status).toBe(400);
    for (const title of ["", "   ", "x".repeat(61), "a\nb", "a\u0000b", "\ud800"]) {
      expect((await create(a, title, [b.id, c.id])).status).toBe(400);
    }
    expect((await create(a, "x".repeat(60), [b.id, c.id])).status).toBe(201);

    expect(await create(a, "x", [b.id, d.id])).toMatchObject({ status: 403, json: FORBIDDEN }); // d is no friend
    expect(await create(a, "x", [b.id, RANDOM_ID])).toMatchObject({ status: 403, json: FORBIDDEN });
    await api(app, c, "PUT", `/api/blocks/${a.id}`); // still friends, but c blocked a
    expect(await create(a, "x", [b.id, c.id])).toMatchObject({ status: 403, json: FORBIDDEN });

    expect(await count("select count(*) n from conversations where type = 'group'")).toBe(1);
  });
});

describe("membership rules", () => {
  it("non-friend cannot be added to a group; blocked pair cannot add each other; 501st member is refused", async () => {
    const [a, b, c, d] = await people("alice", "bob", "carol", "dave");
    const g = await group(app, a, "g", [b, c]);

    // d is nobody's friend yet.
    expect(await add(a, g, d)).toMatchObject({ status: 403, json: FORBIDDEN });
    expect(await add(a, g, RANDOM_ID)).toMatchObject({ status: 403, json: FORBIDDEN });

    // b and d are friends, but d blocked b: neither can add the other anywhere.
    await befriend(app, b, d);
    await api(app, d, "PUT", `/api/blocks/${b.id}`);
    expect(await add(b, g, d)).toMatchObject({ status: 403, json: FORBIDDEN });
    const [e, f] = await people("erin", "frank");
    const g2 = await group(app, d, "g2", [e, f]);
    expect(await add(d, g2, b)).toMatchObject({ status: 403, json: FORBIDDEN });
    expect(await memberIds(a, g)).toEqual([a.id, b.id, c.id].sort());
    expect(await memberIds(d, g2)).toEqual([d.id, e.id, f.id].sort());

    // Fill g up to 499 current members with agents, directly in the database.
    await db.query(
      `insert into principals (kind, handle, display_name, owner_id)
       select 'agent', 'bot_' || g, 'Bot ' || g, $1 from generate_series(1, 496) g`,
      [a.id],
    );
    await db.query(
      `insert into memberships (conversation_id, principal_id, role, joined_seq)
       select $1, p.id, 'speaker', c.seq from principals p, conversations c where p.kind = 'agent' and c.id = $1`,
      [g],
    );
    const [h, i] = await people("henry", "ivy");
    await befriend(app, a, h);
    await befriend(app, a, i);
    expect((await add(a, g, h)).status).toBe(201); // the 500th
    expect(await add(a, g, i)).toMatchObject({ status: 403, json: FORBIDDEN }); // the 501st
    expect(await count("select count(*) n from memberships where conversation_id = $1 and left_seq is null", [g])).toBe(500);
  });

  it("any member can add their own friend; only the creator can remove or rename; creator leaving hands over to the earliest member; last leaver closes it", async () => {
    const [a, b, c, d, e] = await people("alice", "bob", "carol", "dave", "erin");
    const g = await group(app, a, "start", [b, c]);

    await befriend(app, b, d);
    expect(await add(b, g, d)).toMatchObject({ status: 201, json: { ok: true } }); // a plain member adds a friend
    await befriend(app, c, e);
    expect((await add(c, g, e)).status).toBe(201);
    expect(await memberIds(a, g)).toEqual([a.id, b.id, c.id, d.id, e.id].sort());
    expect(await add(a, g, b)).toMatchObject({ status: 409, json: { error: "already_member" } });

    // Only the creator removes others and renames.
    expect(await remove(b, g, c)).toMatchObject({ status: 403, json: FORBIDDEN });
    expect(await rename(b, g, "mine")).toMatchObject({ status: 403, json: FORBIDDEN });
    expect(await rename(a, g, "  新名字 ")).toMatchObject({ status: 200, json: { id: g, title: "新名字" } });
    expect(await remove(a, g, e)).toMatchObject({ status: 200, json: { ok: true } });
    expect(await remove(a, g, e)).toMatchObject({ status: 404, json: NOT_FOUND }); // no longer a member
    expect(await memberIds(a, g)).toEqual([a.id, b.id, c.id, d.id].sort());

    // b leaves on their own; a and c remain from the start, d joined later.
    expect(await remove(b, g, b)).toMatchObject({ status: 200, json: { ok: true } });
    // a (creator) leaves: c is the earliest remaining member.
    expect((await remove(a, g, a)).status).toBe(200);
    expect(await creatorOf(g)).toBe(c.id);
    expect((await members(c, g)).json.members.find((m: any) => m.id === c.id).isCreator).toBe(true);
    expect((await rename(c, g, "c's now")).status).toBe(200);
    expect(await rename(d, g, "no")).toMatchObject({ status: 403, json: FORBIDDEN });

    expect((await remove(c, g, c)).status).toBe(200);
    expect(await creatorOf(g)).toBe(d.id);
    expect((await remove(d, g, d)).status).toBe(200);
    const closed = await db.query("select closed_at from conversations where id = $1", [g]);
    expect(closed.rows[0]!.closed_at).toBeInstanceOf(Date);
    for (const who of [a, b, c, d, e]) expect(await history(who, g)).toMatchObject({ status: 404, json: NOT_FOUND });

    const kinds = (await db.query<{ event: string }>(
      "select body->>'event' as event from messages where conversation_id = $1 order by seq",
      [g],
    )).rows.map((r) => r.event);
    expect(kinds).toEqual([
      "group_created",
      "member_joined",
      "member_joined",
      "group_renamed",
      "member_removed",
      "member_left",
      "member_left",
      "group_renamed",
      "member_left",
      "member_left",
    ]);
  });

  it("creator leaving hands over to the earliest current member, skipping people who already left, ties by membership id", async () => {
    const [a, b, c, d] = await people("alice", "bob", "carol", "dave");
    const g = await group(app, a, "g", [b, c]);
    await befriend(app, a, d);
    expect((await add(a, g, d)).status).toBe(201);

    const { rows } = await db.query<{ principal_id: string }>(
      `select principal_id from memberships where conversation_id = $1 and principal_id = any($2) order by id`,
      [g, [b.id, c.id]],
    );
    const [first, second] = rows.map((r) => r.principal_id);
    const [firstActor, secondActor] = first === b.id ? [b, c] : [c, b];

    // The tie-winner leaves first, so the hand-over must go to the other early member, not to d.
    expect((await remove(firstActor, g, firstActor)).status).toBe(200);
    expect((await remove(a, g, a)).status).toBe(200);
    expect(await creatorOf(g)).toBe(second);
    const left = (await history(secondActor, g)).json.messages.at(-1);
    expect(left.system).toMatchObject({ event: "member_left", principalId: a.id, newCreatorId: second });
  });

  it("closed conversation refuses sends and adds", async () => {
    const [a, b, c, d] = await people("alice", "bob", "carol", "dave");
    const g = await group(app, a, "g", [b, c]);
    await befriend(app, a, d);
    await db.query("update conversations set closed_at = now() where id = $1", [g]);
    const seq = await count("select seq n from conversations where id = $1", [g]);

    expect(await say(a, g, "hello?")).toMatchObject({ status: 404, json: NOT_FOUND });
    expect(await add(a, g, d)).toMatchObject({ status: 404, json: NOT_FOUND });
    expect(await rename(a, g, "x")).toMatchObject({ status: 404, json: NOT_FOUND });
    expect(await count("select seq n from conversations where id = $1", [g])).toBe(seq);
    expect(await count("select count(*) n from memberships where conversation_id = $1 and principal_id = $2", [g, d.id])).toBe(0);
  });

  it("direct conversations cannot be left, renamed, or have members added or removed", async () => {
    const [a, b, c] = await people("alice", "bob", "carol");
    const { conversationId: dm } = await befriend(app, a, b);
    await befriend(app, a, c);

    expect(await remove(a, dm, a)).toMatchObject({ status: 404, json: NOT_FOUND });
    expect(await remove(a, dm, b)).toMatchObject({ status: 404, json: NOT_FOUND });
    expect(await rename(a, dm, "ours")).toMatchObject({ status: 404, json: NOT_FOUND });
    expect(await add(a, dm, c)).toMatchObject({ status: 404, json: NOT_FOUND });
    expect(await memberIds(b, dm)).toEqual([a.id, b.id].sort());
    expect(await count("select count(*) n from memberships where conversation_id = $1 and left_seq is null", [dm])).toBe(2);
    expect(await count("select seq n from conversations where id = $1", [dm])).toBe(0);
  });

  it("concurrent add of the same person yields one membership and one system message", async () => {
    const [a, b, c, d] = await people("alice", "bob", "carol", "dave");
    const g = await group(app, a, "g", [b, c]);
    await befriend(app, b, d);
    await befriend(app, c, d);
    await befriend(app, a, d);
    const adders = [a, b, c, a, b, c, a, b, c, a];
    const results = await Promise.all(adders.map((who) => add(who, g, d.id.toUpperCase())));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409).every((r) => r.json.error === "already_member")).toBe(true);
    expect(results.filter((r) => r.status === 409)).toHaveLength(9);
    expect(await count("select count(*) n from memberships where conversation_id = $1 and principal_id = $2", [g, d.id])).toBe(1);
    expect(
      await count(
        "select count(*) n from messages where conversation_id = $1 and body->>'event' = 'member_joined' and body->>'principalId' = $2",
        [g, d.id],
      ),
    ).toBe(1);
  });
});

describe("access", () => {
  it("outsider gets the same 404 body for a real and a random conversation id on every route", async () => {
    const [a, b, c, o, f] = await people("alice", "bob", "carol", "oscar", "frank");
    const { conversationId: dm } = await befriend(app, a, b);
    const g = await group(app, a, "g", [b, c]);
    await befriend(app, o, f);
    await say(a, g, "secret");
    await say(a, dm, "secret");

    const routes: Array<[string, (id: string) => string, unknown?]> = [
      ["GET", (id) => `/api/conversations/${id}/messages`],
      ["GET", (id) => `/api/conversations/${id}/messages?before=2&limit=5`],
      ["GET", (id) => `/api/conversations/${id}/messages/1`],
      ["GET", (id) => `/api/conversations/${id}/members`],
      ["POST", (id) => `/api/conversations/${id}/messages`, { text: "hi", clientTxn: "outsider-1" }],
      ["POST", (id) => `/api/conversations/${id}/read`, { seq: 1 }],
      ["POST", (id) => `/api/conversations/${id}/members`, { principalId: f.id }],
      ["DELETE", (id) => `/api/conversations/${id}/members/${o.id}`],
      ["DELETE", (id) => `/api/conversations/${id}/members/${a.id}`],
      ["PATCH", (id) => `/api/conversations/${id}`, { title: "mine" }],
    ];
    for (const [method, url, body] of routes) {
      const bodies = new Set<string>();
      for (const id of [g, dm, RANDOM_ID, g.toUpperCase()]) {
        const res = await app.inject({
          method: method as "GET",
          url: url(id),
          headers: { cookie: o.cookie },
          ...(body === undefined ? {} : { payload: body as object }),
        });
        expect([method, url(id), res.statusCode]).toEqual([method, url(id), 404]);
        bodies.add(res.body);
      }
      expect([...bodies]).toEqual([JSON.stringify(NOT_FOUND)]);
    }
    expect(await count("select count(*) n from messages where sender_id = $1", [o.id])).toBe(0);
    // o is still only in the direct chat with f; f was added nowhere.
    expect(await count("select count(*) n from memberships where principal_id = $1", [o.id])).toBe(1);
    expect(await count("select count(*) n from memberships where principal_id = $1", [f.id])).toBe(1);
  });

  it("uppercase conversation and principal ids behave identically", async () => {
    const [a, b, c, d] = await people("alice", "bob", "carol", "dave");
    const g = await group(app, a, "g", [b, c]);
    const G = g.toUpperCase();
    await befriend(app, a, d);

    const sent = await say(a, G, "hello");
    expect(sent.status).toBe(201);
    expect(sent.json.message.conversationId).toBe(g);
    expect((await history(b, G)).json.messages.map((m: any) => m.text)).toEqual((await history(b, g)).json.messages.map((m: any) => m.text));
    expect((await api(app, b, "GET", `/api/conversations/${G}/messages/${sent.json.message.seq}`)).json.message.text).toBe("hello");
    expect((await api(app, b, "POST", `/api/conversations/${G}/read`, { seq: 99 })).json).toEqual({ readSeq: sent.json.message.seq });
    expect(await memberIds(b, G)).toEqual(await memberIds(b, g));
    expect((await add(a, G, d.id.toUpperCase())).status).toBe(201);
    expect(await add(a, g, d.id)).toMatchObject({ status: 409, json: { error: "already_member" } });
    expect((await remove(a, G, d.id.toUpperCase())).status).toBe(200);
    expect((await rename(a, G, "upper")).json).toEqual({ id: g, title: "upper" });
    expect((await remove(b, G, b.id.toUpperCase())).status).toBe(200);
    expect(await memberIds(a, g)).toEqual([a.id, c.id].sort());
  });
});

describe("the visibility join", () => {
  it("accepts only the two reader expressions it is spliced with (enforced by tsc, which checks this file)", () => {
    expect(visibleJoin("$1")).toContain("vis.principal_id = $1 ");
    expect(visibleJoin("r.reader_id")).toContain("vis.principal_id = r.reader_id ");
    // @ts-expect-error any other SQL text does not compile
    visibleJoin("$2");
    // @ts-expect-error nor does a string computed at run time
    visibleJoin(String("r.reader_id"));
  });
});

describe("canSend and change events", () => {
  it("listMembers answers only a current member, from the same statement that checks membership", async () => {
    const [a, b, c, o] = await people("alice", "bob", "carol", "oscar");
    const g = await group(app, a, "g", [b, c]);
    expect(await listMembers(db, o.id, g)).toBeNull();
    expect(await listMembers(db, b.id, RANDOM_ID)).toBeNull();
    expect((await listMembers(db, b.id, g))!.map((m) => m.id).sort()).toEqual([a.id, b.id, c.id].sort());
    expect((await remove(a, g, b)).status).toBe(200);
    expect(await listMembers(db, b.id, g)).toBeNull();
    expect((await listMembers(db, c.id, g))!.map((m) => m.id).sort()).toEqual([a.id, c.id].sort());
  });

  it("canSend reflects the pair's relationship in direct chats and membership in groups", async () => {
    const [a, b, c, o] = await people("alice", "bob", "carol", "oscar");
    const { conversationId: dm } = await befriend(app, a, b);
    const g = await group(app, a, "g", [b, c]);

    expect(await canSend(db, dm, a.id, app.deps.config)).toEqual({ ok: true });
    expect(await canSend(db, g, c.id, app.deps.config)).toEqual({ ok: true });
    expect(await canSend(db, g, o.id, app.deps.config)).toBeNull();
    expect(await canSend(db, dm, c.id, app.deps.config)).toBeNull();
    await api(app, a, "DELETE", `/api/friends/${b.id}`);
    expect(await canSend(db, dm, b.id, app.deps.config)).toEqual({ ok: false, reason: "not_friends" });
    await api(app, b, "PUT", `/api/blocks/${a.id}`);
    expect(await canSend(db, dm, a.id, app.deps.config)).toEqual({ ok: false, reason: "blocked" });
    expect(await canSend(db, g, a.id, app.deps.config)).toEqual({ ok: true }); // a block does not touch the group
  });

  it("messages and membership changes are announced after commit; failing listeners are contained", async () => {
    const [a, b, c, d] = await people("alice", "bob", "carol", "dave");
    const { conversationId: dm } = await befriend(app, a, b);
    await befriend(app, a, c);
    await befriend(app, a, d);

    const seen: StoredMessage[] = [];
    const changes: Array<[string, string[]]> = [];
    const committed: Array<[number, number]> = [];
    const offs = [
      onMessages(app, async (msgs) => {
        seen.push(...msgs);
        // After commit: the rows are visible from another connection.
        const n = await count("select count(*) n from messages where id = any($1::bigint[])", [msgs.map((m) => m.id)]);
        committed.push([msgs.length, n]);
      }),
      onMembershipChanged(app, (id, ids) => void changes.push([id, [...ids].sort()])),
      onMessages(app, () => {
        throw new Error("boom");
      }),
      onMembershipChanged(app, async () => {
        throw new Error("async boom");
      }),
    ];
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    let g: string;
    try {
      g = await group(app, a, "g", [b, c]);
      await say(a, g, "hi all");
      expect((await add(a, g, d)).status).toBe(201);
      expect((await remove(a, g, c)).status).toBe(200);
      expect((await rename(a, g, "renamed")).status).toBe(200);
      await api(app, b, "PUT", `/api/blocks/${a.id}`); // direct chat: canSend flips
      await say(a, g, "still allowed"); // groups are unaffected by blocks
      expect((await add(a, g, "not-a-uuid")).status).toBe(400); // nothing announced for refusals
      expect((await add(a, g, d)).status).toBe(409);
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      process.off("unhandledRejection", onUnhandled);
      for (const off of offs) off();
    }

    expect(unhandled).toEqual([]);
    expect(committed).toHaveLength(7);
    expect(committed.every(([sent, stored]) => sent === stored)).toBe(true);
    expect(seen.map((m) => [m.conversationId, m.kind, m.kind === "system" ? (m.body as any).event : (m.body as any).text])).toEqual([
      [g!, "system", "group_created"],
      [g!, "text", "hi all"],
      [g!, "system", "member_joined"],
      [g!, "system", "member_removed"],
      [g!, "system", "group_renamed"],
      [dm, "system", "blocked"],
      [g!, "text", "still allowed"],
    ]);
    const sorted = (...xs: Actor[]) => xs.map((x) => x.id).sort();
    expect(changes).toEqual([
      [g!, sorted(a, b, c)],
      [g!, sorted(a, b, c, d)],
      [g!, sorted(a, b, c, d)],
      [g!, sorted(a, b, d)],
      [dm, sorted(a, b)],
    ]);
  });
});
