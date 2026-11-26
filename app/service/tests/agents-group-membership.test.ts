import { afterEach, describe, expect, it, vi } from "vitest";
import { leaveGroupsOfDeleted } from "../src/agents/group-leave.ts";
import { isRunEnd, type RunTicket } from "../src/agents/runtime/port.ts";
import { buildApp } from "../src/app.ts";
import { VISIBLE_JOIN } from "../src/conversations/store.ts";
import { api, befriend, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { NO_ANSWER_FLOOR, useApp } from "./helpers/harness.ts";
import { CANNED_USAGE, scriptedGateway } from "./helpers/models.ts";
import { closeAllSockets, connect, listen } from "./helpers/ws.ts";

/**
 * An owner's own Agent as a member of a group (design rules 1–5, plan Task 2, rulings 4 and 9): only its owner adds it,
 * and only to a group the owner is in; the group's creator or its owner takes it out; an owner leaving or removed takes
 * their Agents along, in the same transaction; the creator's role passes to a person, never to an Agent; deleting an
 * Agent takes it out of every group. Leaving ends the Agent's replies in that group (`agent_removed`). Runs are inserted
 * and driven by hand (the trigger in groups is another task's): no worker picks them up.
 */

const gateway = scriptedGateway();
const { app, db } = useApp({ env: SITE_ENV, models: gateway, agentWorker: false });

afterEach(async () => {
  await closeAllSockets();
  expect(gateway.pending()).toBe(0);
});

const FAST = { source: "site", id: "fast" } as const;
const RANDOM = "5b8f2d0c-7a1e-4c3b-9d6f-2e4a8c0b1d3f";
const FORBIDDEN = '{"error":"forbidden"}';
const NOT_FOUND = '{"error":"not_found"}';

type Agent = { id: string; handle: string; name: string; conversationId: string };

let txn = 0;
const say = async (who: Actor, conv: string, text: string): Promise<number> => {
  const sent = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `gm${++txn}` });
  if (sent.status !== 201) throw new Error(`say: ${sent.status} ${JSON.stringify(sent.json)}`);
  return sent.json.message.seq as number;
};
const add = (who: Actor, conv: string, id: string) => api(app, who, "POST", `/api/conversations/${conv}/members`, { principalId: id });
const remove = (who: Actor, conv: string, id: string) => api(app, who, "DELETE", `/api/conversations/${conv}/members/${id}`);

/** What a request answers with, byte for byte: status, content type and body. */
async function observe(who: Actor, method: "POST" | "DELETE", url: string, body?: unknown) {
  const res = await app.inject({ method, url, headers: { cookie: who.cookie }, ...(body === undefined ? {} : { payload: body as object }) });
  return { status: res.statusCode, type: res.headers["content-type"], body: res.body };
}
const tryAdd = (who: Actor, conv: string, id: string) => observe(who, "POST", `/api/conversations/${conv}/members`, { principalId: id });
const tryRemove = (who: Actor, conv: string, id: string) => observe(who, "DELETE", `/api/conversations/${conv}/members/${id}`);

async function agentOf(owner: Actor, over: Record<string, unknown> = {}): Promise<Agent> {
  return (await mustCreateAgent(app, owner, { model: FAST, persona: "简短地回答。", ...over })) as Agent;
}
async function addOwn(owner: Actor, conv: string, agent: Agent): Promise<void> {
  const res = await add(owner, conv, agent.id);
  if (res.status !== 201) throw new Error(`addOwn: ${res.status} ${JSON.stringify(res.json)}`);
}

const seqOf = async (conv: string) => Number((await db.query<{ seq: string }>("select seq from conversations where id = $1", [conv])).rows[0]!.seq);
/** Current memberships of `principalId` in `conv` (0 or 1). */
const isIn = async (conv: string, principalId: string) =>
  (await db.query<{ n: number }>("select count(*)::int as n from memberships where conversation_id = $1 and principal_id = $2 and left_seq is null", [conv, principalId]))
    .rows[0]!.n;
const memberships = async (conv: string, principalId: string) =>
  (
    await db.query<{ joined: number; left: number | null }>(
      "select joined_seq::int as joined, left_seq::int as left from memberships where conversation_id = $1 and principal_id = $2 order by joined_seq",
      [conv, principalId],
    )
  ).rows;
/** The system notices of `conv` after `since`, as [event, actorId, principalId, newCreatorId?]. */
const notices = async (conv: string, since = 0) =>
  (
    await db.query<{ seq: number; event: string; actor: string; principal: string | null; new_creator: string | null }>(
      `select seq::int as seq, body->>'event' as event, body->>'actorId' as actor, body->>'principalId' as principal, body->>'newCreatorId' as new_creator
         from messages where conversation_id = $1 and kind = 'system' and seq > $2 order by seq`,
      [conv, since],
    )
  ).rows;
/** The seqs of `conv` that `readerId` may read: the one read rule (`VISIBLE_JOIN`), the Agent as reader as context.ts reads. */
const visibleTo = async (readerId: string, conv: string) =>
  (await db.query<{ seq: number }>(`select m.seq::int as seq from messages m ${VISIBLE_JOIN} where m.conversation_id = $2 order by m.seq`, [readerId, conv])).rows.map(
    (r) => r.seq,
  );
const creatorOf = async (conv: string) =>
  (await db.query<{ creator_id: string; closed: boolean }>("select creator_id, closed_at is not null as closed from conversations where id = $1", [conv])).rows[0]!;

/**
 * A reply run of `agent` in `conv`, inserted by hand (the trigger in groups is another task's); with `waiting`, the owner's call
 * on the conversation's latest message waits behind it (`deferred_calls`).
 */
async function insertRun(agent: Agent, owner: Actor, conv: string, status: "queued" | "running", { covers = 1, waiting = false } = {}) {
  const { rows } = await db.query<{ id: string }>(
    `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, started_at)
     values ('reply', $1, $2, $3, $4, $5, case when $4 = 'running' then now() end) returning id`,
    [conv, agent.id, owner.id, status, covers],
  );
  if (waiting)
    await db.query(
      `insert into deferred_calls (agent_id, conversation_id, message_seq, owner_id, lane, caller_id, triggered_by)
       select $1, $2, max(seq), $3, 'own', $3, 'human' from messages where conversation_id = $2`,
      [agent.id, conv, owner.id],
    );
  return rows[0]!.id;
}
/** The run, and how many calls wait for its Agent in its conversation (`deferred_calls`). */
const runOf = async (runId: string) =>
  (
    await db.query<{ status: string; error: string | null; interrupted: string | null; waiting: number }>(
      `select status, error, interrupted,
              (select count(*)::int from deferred_calls d where d.agent_id = r.agent_id and d.conversation_id = r.conversation_id) as waiting
         from agent_runs r where id = $1`,
      [runId],
    )
  ).rows[0]!;
const ticketOf = (runId: string, agent: Agent, owner: Actor, conv: string): RunTicket => ({ id: runId, agentId: agent.id, ownerId: owner.id, conversationId: conv });
const fromAgent = async (agent: Agent, conv: string) =>
  (await db.query("select seq from messages where conversation_id = $1 and sender_id = $2", [conv, agent.id])).rows;

/** `promise`, or a rejection naming `label` after `ms`: a wait that never ends (a deadlock) fails instead of hanging. */
async function bounded<T>(label: string, promise: Promise<T>, ms = 10_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: not done within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The server process (pid) waiting for a lock that `holderPid` holds, once there is one. */
async function blockedBy(holderPid: number): Promise<number> {
  let pid = 0;
  await vi.waitFor(
    async () => {
      const { rows } = await db.query<{ pid: number }>("select pid from pg_stat_activity where $1 = any(pg_blocking_pids(pid))", [holderPid]);
      expect(rows).toHaveLength(1);
      pid = rows[0]!.pid;
    },
    { timeout: 5_000, interval: 20 },
  );
  return pid;
}

describe("adding an Agent to a group", () => {
  it("its owner adds it to a group they are in: a member listed with its owner, a member_joined notice everyone sees, and it reads from then on", async () => {
    const [mia, owner, ned] = [await signUp(app, "mia"), await signUp(app, "owen"), await signUp(app, "ned")];
    // The owner is a plain member here, not the creator.
    const g = await group(app, mia, "team", [owner, ned]);
    await say(mia, g, "before the Agent");
    const agent = await agentOf(owner, { name: "小助手", intro: "帮大家整理", field: "写作" });
    const watching = await connect(app, ned);
    const seq = await seqOf(g);

    expect(await add(owner, g, agent.id)).toEqual({ status: 201, json: { ok: true } });

    const listed = (await api(app, ned, "GET", `/api/conversations/${g}/members`)).json.members;
    expect(listed.map((m: { id: string }) => m.id).slice(0, 3).sort()).toEqual([mia.id, owner.id, ned.id].sort());
    expect(listed).toHaveLength(4);
    expect(listed[3]).toEqual({
      id: agent.id,
      handle: agent.handle,
      displayName: "小助手",
      avatarVersion: 0,
      kind: "agent",
      role: "speaker",
      isCreator: false,
      ownerId: owner.id,
      intro: "帮大家整理",
      field: "写作",
    });
    expect(await memberships(g, agent.id)).toEqual([{ joined: seq, left: null }]);
    expect(await notices(g, seq)).toEqual([{ seq: seq + 1, event: "member_joined", actor: owner.id, principal: agent.id, new_creator: null }]);
    for (const who of [mia, ned, owner]) {
      const last = (await api(app, who, "GET", `/api/conversations/${g}/messages`)).json.messages.at(-1);
      expect([who.handle, last.kind, last.text, last.system]).toEqual([
        who.handle,
        "system",
        "owen邀请小助手加入了群聊",
        { event: "member_joined", actorId: owner.id, principalId: agent.id },
      ]);
    }
    await watching.waitFor((e) => e.type === "conversation" && e.id === g);

    // As anyone who joins: the notice and what follows, nothing before it.
    const after = await say(ned, g, "after the Agent");
    expect(await visibleTo(agent.id, g)).toEqual([seq + 1, after]);
    // Again: it is a member already.
    expect(await add(owner, g, agent.id)).toEqual({ status: 409, json: { error: "already_member" } });
  });

  it("a paused Agent may be added; an Agent counts toward the 500 members, and the 500th may be one", async () => {
    const [owner, mia, ned, outsider] = [await signUp(app, "owner"), await signUp(app, "mia"), await signUp(app, "ned"), await signUp(app, "outsider")];
    const g = await group(app, owner, "big", [mia, ned]);
    const paused = await agentOf(owner);
    expect((await api(app, owner, "POST", `/api/agents/${paused.id}/pause`)).status).toBe(200);
    expect((await add(owner, g, paused.id)).status).toBe(201);

    // 495 more, bare Agent principals of someone outside the group, seated directly: 499 members.
    await db.query(
      `insert into principals (kind, handle, display_name, owner_id) select 'agent', 'fill_' || n, 'Fill ' || n, $1 from generate_series(1, 495) n`,
      [outsider.id],
    );
    await db.query(
      `insert into memberships (conversation_id, principal_id, role, joined_seq)
       select $1, p.id, 'speaker', c.seq from principals p, conversations c where p.owner_id = $2 and c.id = $1`,
      [g, outsider.id],
    );
    expect(await db.query("select 1 from memberships where conversation_id = $1 and left_seq is null", [g])).toHaveProperty("rowCount", 499);

    const last = await agentOf(owner);
    expect((await add(owner, g, last.id)).status).toBe(201); // the 500th
    const extra = await agentOf(owner);
    const refused = await tryAdd(owner, g, extra.id);
    expect(refused).toEqual(await tryAdd(owner, g, RANDOM));
    expect([refused.status, refused.body]).toEqual([403, FORBIDDEN]);
    await befriend(app, owner, outsider);
    expect((await tryAdd(owner, g, outsider.id)).body).toBe(FORBIDDEN); // nor a person
    expect(await db.query("select 1 from memberships where conversation_id = $1 and left_seq is null", [g])).toHaveProperty("rowCount", 500);
  });

  it("nobody else may add it — a member who does not know its owner, its owner's friend, the group's creator — and its owner not to a group they are not in: each answered byte for byte as a random id", async () => {
    const [creator, owner, friend, stranger] = [await signUp(app, "cara"), await signUp(app, "owen"), await signUp(app, "fred"), await signUp(app, "sam")];
    const g = await group(app, creator, "all four", [owner, friend, stranger]);
    const elsewhere = await group(app, creator, "without the owner", [friend, stranger]);
    await befriend(app, owner, friend);
    const agent = await agentOf(owner);

    for (const who of [stranger, friend, creator]) {
      const tried = await tryAdd(who, g, agent.id);
      expect([who.handle, tried]).toEqual([who.handle, await tryAdd(who, g, RANDOM)]);
      expect([tried.status, tried.body]).toEqual([403, FORBIDDEN]);
    }
    // The owner, in a group they are not in: what any add there gets.
    const outside = await tryAdd(owner, elsewhere, agent.id);
    expect(outside).toEqual(await tryAdd(owner, elsewhere, RANDOM));
    expect([outside.status, outside.body]).toEqual([404, NOT_FOUND]);
    // Nor into its own conversation with its owner, which is no group.
    expect(await tryAdd(owner, agent.conversationId, agent.id)).toEqual(await tryAdd(owner, agent.conversationId, RANDOM));

    // Nothing changed: it is in its own conversation only, and no notice names it.
    expect((await db.query("select conversation_id from memberships where principal_id = $1", [agent.id])).rows).toEqual([{ conversation_id: agent.conversationId }]);
    expect((await db.query("select 1 from messages where body->>'principalId' = $1", [agent.id])).rowCount).toBe(0);
  });

  it("a deleted Agent cannot be added, by its owner either: the 403 a random id gets", async () => {
    const [owner, mia, ned] = [await signUp(app, "owner"), await signUp(app, "mia"), await signUp(app, "ned")];
    const g = await group(app, owner, "g", [mia, ned]);
    const agent = await agentOf(owner);
    expect((await api(app, owner, "DELETE", `/api/agents/${agent.id}`)).status).toBe(200);
    const refused = await tryAdd(owner, g, agent.id);
    expect(refused).toEqual(await tryAdd(owner, g, RANDOM));
    expect([refused.status, refused.body]).toEqual([403, FORBIDDEN]);
    expect(await isIn(g, agent.id)).toBe(0);
  });

  it("an Agent added, taken out and added again has a new membership from that moment: nothing from before reaches it", async () => {
    const { creator, owner, mia, g } = await world();
    const agent = await agentOf(owner);
    await addOwn(owner, g, agent);
    const first = await say(mia, g, "while it was in");
    expect((await remove(owner, g, agent.id)).status).toBe(200);
    const away = await say(mia, g, "while it was out");
    const rejoined = await seqOf(g);
    await addOwn(owner, g, agent);
    const back = await say(creator, g, "after it came back");

    const rows = await memberships(g, agent.id);
    expect(rows).toEqual([
      { joined: first - 2, left: first + 1 },
      { joined: rejoined, left: null },
    ]);
    expect(await visibleTo(agent.id, g)).toEqual([rejoined + 1, back]);
    expect(await visibleTo(agent.id, g)).not.toContain(away);
    expect(await visibleTo(agent.id, g)).not.toContain(first);
  });
});

interface World {
  creator: Actor;
  owner: Actor;
  mia: Actor;
  /** A group of the three, made by `creator`. */
  g: string;
}

async function world(): Promise<World> {
  const [creator, owner, mia] = [await signUp(app, "cleo"), await signUp(app, "owen"), await signUp(app, "mia")];
  return { creator, owner, mia, g: await group(app, creator, "team", [owner, mia]) };
}

describe("taking an Agent out of a group", () => {
  it("the group's creator or the Agent's owner takes it out (member_removed); any other member gets what removing anybody gets", async () => {
    const { creator, owner, mia, g } = await world();
    const [x, y] = [await agentOf(owner), await agentOf(owner)];
    await addOwn(owner, g, x);
    await addOwn(owner, g, y);

    const refused = await tryRemove(mia, g, x.id);
    expect(refused).toEqual(await tryRemove(mia, g, RANDOM));
    expect(refused).toEqual(await tryRemove(mia, g, creator.id));
    expect([refused.status, refused.body]).toEqual([403, FORBIDDEN]);
    expect(await isIn(g, x.id)).toBe(1);

    let seq = await seqOf(g);
    expect(await remove(creator, g, x.id)).toEqual({ status: 200, json: { ok: true } });
    expect(await notices(g, seq)).toEqual([{ seq: seq + 1, event: "member_removed", actor: creator.id, principal: x.id, new_creator: null }]);
    expect(await memberships(g, x.id)).toEqual([{ joined: expect.any(Number), left: seq + 1 }]);

    seq = await seqOf(g);
    expect(await remove(owner, g, y.id)).toEqual({ status: 200, json: { ok: true } });
    expect(await notices(g, seq)).toEqual([{ seq: seq + 1, event: "member_removed", actor: owner.id, principal: y.id, new_creator: null }]);
    const last = (await api(app, mia, "GET", `/api/conversations/${g}/messages`)).json.messages.at(-1);
    expect(last.text).toBe(`owen将${y.name}移出了群聊`);

    // Once out, taking it out again is the 404 of anyone who is not a member.
    expect(await tryRemove(creator, g, x.id)).toEqual(await tryRemove(creator, g, RANDOM));
    expect((await tryRemove(owner, g, y.id)).body).toBe(NOT_FOUND);
    const left = (await api(app, mia, "GET", `/api/conversations/${g}/members`)).json.members.map((m: { id: string }) => m.id).sort();
    expect(left).toEqual([creator.id, owner.id, mia.id].sort());
  });

  it("its replies in that group end — a queued one cancelled, a running one interrupted — with agent_removed; its replies elsewhere go on", async () => {
    const { creator, owner, g } = await world();
    const [x, y] = [await agentOf(owner), await agentOf(owner)];
    await addOwn(owner, g, x);
    await addOwn(owner, g, y);
    const queued = await insertRun(x, owner, g, "queued");
    const ownChat = await insertRun(x, owner, x.conversationId, "queued");
    const running = await insertRun(y, owner, g, "running", { covers: 1, waiting: true });
    const socket = await connect(app, owner);

    expect((await remove(creator, g, x.id)).status).toBe(200);
    expect(await runOf(queued)).toEqual({ status: "cancelled", error: "agent_removed", interrupted: null, waiting: 0 });
    expect(await runOf(ownChat)).toEqual({ status: "queued", error: null, interrupted: null, waiting: 0 });
    const pushed = await socket.next((e) => e.type === "run" && e.run.id === queued);
    expect(pushed).toMatchObject({ conversationId: g, run: { id: queued, status: "cancelled", error: "agent_removed", retryable: false } });

    const ticket = ticketOf(running, y, owner, g);
    expect(app.agentPort.shouldStop(ticket)).toBe(false);
    expect((await remove(owner, g, y.id)).status).toBe(200);
    // Still running until its worker ends it, but marked: it stops now, posts nothing and ends cancelled; the call that waited
    // behind it is dropped, so nothing answers it in a group the Agent is no longer in.
    expect(await runOf(running)).toEqual({ status: "running", error: null, interrupted: "agent_removed", waiting: 0 });
    expect(app.agentPort.shouldStop(ticket)).toBe(true);
    await app.agentPort.finish(ticket, { status: "stopped" }, null, { inputChars: 0, outputChars: 0 });
    expect(await runOf(running)).toEqual({ status: "cancelled", error: "agent_removed", interrupted: "agent_removed", waiting: 0 });
    expect((await db.query("select 1 from agent_runs where agent_id = $1 and status in ('queued', 'running')", [y.id])).rowCount).toBe(0);
    expect(await runOf(ownChat)).toEqual({ status: "queued", error: null, interrupted: null, waiting: 0 });
  });

  it("a fellow member's socket gets only the Agent's state for the cancelled runs (null): nothing of their details", async () => {
    const { creator, owner, mia, g } = await world();
    const x = await agentOf(owner);
    await addOwn(owner, g, x);
    const queued = await insertRun(x, owner, g, "queued");
    const [ownerSocket, miaSocket] = [await connect(app, owner), await connect(app, mia)];

    expect((await remove(creator, g, x.id)).status).toBe(200);
    // The owner is told the run (the control: the push does happen); mia only that the Agent shows nothing now (wire
    // contract "Run state": a member who does not own the Agent gets its state, never its run).
    await ownerSocket.next((e) => e.type === "run" && e.run?.id === queued);
    await miaSocket.next((e) => e.type === "conversation" && e.id === g);
    await miaSocket.next((e) => e.type === "run" && e.conversationId === g);
    const frames = miaSocket.events.map((e) => JSON.stringify(e));
    expect(miaSocket.events.filter((e) => e.type === "run")).toEqual([{ type: "run", conversationId: g, agentId: x.id, state: null }]);
    expect(frames.filter((f) => f.includes(queued) || f.includes("retryable") || f.includes("agent_removed") || f.includes('"error"'))).toEqual([]);
  });
});

describe("an owner leaving takes their Agents along", () => {
  it("leaving: each of their Agents in the group leaves first, in the same transaction, with a member_left of its own (actor: the owner); their replies there end; nothing else moves", async () => {
    const { creator, owner, mia, g } = await world();
    const [x, y] = [await agentOf(owner), await agentOf(owner)];
    const z = await agentOf(mia); // somebody else's
    await addOwn(owner, g, x);
    await addOwn(owner, g, y);
    await addOwn(mia, g, z);
    const g2 = await group(app, owner, "another", [creator, mia]);
    await addOwn(owner, g2, x);
    const xQueued = await insertRun(x, owner, g, "queued");
    const yRunning = await insertRun(y, owner, g, "running", { waiting: true });
    const xElsewhere = await insertRun(x, owner, g2, "queued");
    const zQueued = await insertRun(z, mia, g, "queued");
    const [ownerSocket, miaSocket] = [await connect(app, owner), await connect(app, mia)];
    const seq = await seqOf(g);

    expect(await remove(owner, g, owner.id)).toEqual({ status: 200, json: { ok: true } });

    expect(await notices(g, seq)).toEqual([
      { seq: seq + 1, event: "member_left", actor: owner.id, principal: x.id, new_creator: null },
      { seq: seq + 2, event: "member_left", actor: owner.id, principal: y.id, new_creator: null },
      { seq: seq + 3, event: "member_left", actor: owner.id, principal: owner.id, new_creator: null },
    ]);
    expect([(await memberships(g, x.id)).at(-1)!.left, (await memberships(g, y.id)).at(-1)!.left, (await memberships(g, owner.id)).at(-1)!.left]).toEqual([
      seq + 1,
      seq + 2,
      seq + 3,
    ]);
    const texts = (await api(app, mia, "GET", `/api/conversations/${g}/messages`)).json.messages.slice(-3).map((m: { text: string }) => m.text);
    expect(texts).toEqual([`${x.name}退出了群聊`, `${y.name}退出了群聊`, "owen退出了群聊"]);
    const members = (await api(app, mia, "GET", `/api/conversations/${g}/members`)).json.members.map((m: { id: string }) => m.id).sort();
    expect(members).toEqual([creator.id, mia.id, z.id].sort());

    expect(await runOf(xQueued)).toMatchObject({ status: "cancelled", error: "agent_removed" });
    expect(await runOf(yRunning)).toEqual({ status: "running", error: null, interrupted: "agent_removed", waiting: 0 });
    expect(app.agentPort.shouldStop(ticketOf(yRunning, y, owner, g))).toBe(true);
    // Its other group, and the other owner's Agent, are untouched.
    expect(await isIn(g2, x.id)).toBe(1);
    expect(await runOf(xElsewhere)).toMatchObject({ status: "queued", error: null });
    expect(await runOf(zQueued)).toMatchObject({ status: "queued", error: null });

    await ownerSocket.next((e) => e.type === "run" && e.run.id === xQueued && e.run.error === "agent_removed");
    await ownerSocket.next((e) => e.type === "gone" && e.id === g);
    await miaSocket.next((e) => e.type === "conversation" && e.id === g);
    await app.agentPort.finish(ticketOf(yRunning, y, owner, g), { status: "stopped" }, null, { inputChars: 0, outputChars: 0 });
  });

  it("removal: when the creator removes the owner, their Agents leave first the same way, then member_removed", async () => {
    const { creator, owner, mia, g } = await world();
    const x = await agentOf(owner);
    await addOwn(owner, g, x);
    const queued = await insertRun(x, owner, g, "queued");
    const seq = await seqOf(g);

    expect((await remove(creator, g, owner.id)).status).toBe(200);
    expect(await notices(g, seq)).toEqual([
      { seq: seq + 1, event: "member_left", actor: owner.id, principal: x.id, new_creator: null },
      { seq: seq + 2, event: "member_removed", actor: creator.id, principal: owner.id, new_creator: null },
    ]);
    expect([await isIn(g, x.id), await isIn(g, owner.id), await isIn(g, mia.id)]).toEqual([0, 0, 1]);
    expect(await runOf(queued)).toMatchObject({ status: "cancelled", error: "agent_removed" });
  });

  it("removal: the creator removing an owner whose Agent has a queued run cancels it, agent_removed, together with the removal (answered 200 only once both are there)", async () => {
    const { creator, owner, g } = await world();
    const x = await agentOf(owner);
    await addOwn(owner, g, x);
    const queued = await insertRun(x, owner, g, "queued");
    const ownerSocket = await connect(app, owner);
    const seq = await seqOf(g);

    expect((await remove(creator, g, owner.id)).status).toBe(200);
    expect(await notices(g, seq)).toHaveLength(2);
    expect(await runOf(queued)).toEqual({ status: "cancelled", error: "agent_removed", interrupted: null, waiting: 0 });
    await ownerSocket.next((e) => e.type === "run" && e.run.id === queued && e.run.error === "agent_removed");
  });

  it("the creator's role passes to the earliest remaining person, never to an Agent", async () => {
    const { creator, owner, mia, g } = await world();
    const x = await agentOf(owner);
    await addOwn(owner, g, x);
    // Through the API an Agent always joins after its owner, so the earliest remaining member is a person anyway. The join
    // order is rearranged here so that the Agent comes first among those who stay: the rule must not rely on that.
    const joined = (await memberships(g, x.id))[0]!.joined;
    await db.query("update memberships set joined_seq = $3 where conversation_id = $1 and principal_id = $2", [g, owner.id, joined + 1]);
    await db.query("update memberships set joined_seq = $3 where conversation_id = $1 and principal_id = $2", [g, mia.id, joined + 2]);
    const seq = await seqOf(g);

    expect((await remove(creator, g, creator.id)).status).toBe(200);
    expect(await notices(g, seq)).toEqual([{ seq: seq + 1, event: "member_left", actor: creator.id, principal: creator.id, new_creator: owner.id }]);
    expect(await creatorOf(g)).toEqual({ creator_id: owner.id, closed: false });
    const members = (await api(app, mia, "GET", `/api/conversations/${g}/members`)).json.members;
    expect(members.map((m: { id: string; isCreator: boolean }) => [m.id, m.isCreator])).toEqual([
      [x.id, false],
      [owner.id, true],
      [mia.id, false],
    ]);
  });

  it("a group whose last person leaves closes, that person's Agents leaving just before them", async () => {
    const { creator, owner, mia, g } = await world();
    const x = await agentOf(owner);
    await addOwn(owner, g, x);
    expect((await remove(mia, g, mia.id)).status).toBe(200);
    expect((await remove(creator, g, creator.id)).status).toBe(200);
    expect(await creatorOf(g)).toEqual({ creator_id: owner.id, closed: false }); // a person, though the Agent is still in
    const seq = await seqOf(g);

    expect((await remove(owner, g, owner.id)).status).toBe(200);
    expect(await notices(g, seq)).toEqual([
      { seq: seq + 1, event: "member_left", actor: owner.id, principal: x.id, new_creator: null },
      { seq: seq + 2, event: "member_left", actor: owner.id, principal: owner.id, new_creator: null },
    ]);
    expect(await creatorOf(g)).toEqual({ creator_id: owner.id, closed: true });
    expect((await db.query("select 1 from memberships where conversation_id = $1 and left_seq is null", [g])).rowCount).toBe(0);
    for (const who of [creator, owner, mia]) expect((await api(app, who, "GET", `/api/conversations/${g}/messages`)).status).toBe(404);
  });
});

describe("deleting an Agent", () => {
  it("it leaves every group it is in once the delete has committed, a member_left in each (actor: its owner), pushed to the members; its messages and its own conversation stay", async () => {
    const { creator, owner, mia, g } = await world();
    const g2 = await group(app, owner, "second", [creator, mia]);
    const x = await agentOf(owner);
    await addOwn(owner, g, x);
    await addOwn(owner, g2, x);
    // Something it said in the group before (written as its reply would be).
    const said = await db.query<{ seq: string }>(
      `with next as (update conversations set seq = seq + 1 where id = $1 returning seq)
       insert into messages (conversation_id, seq, sender_id, kind, body)
       select $1, next.seq, $2, 'text', jsonb_build_object('text', '我说过的话'::text) from next returning seq`,
      [g, x.id],
    );
    const socket = await connect(app, mia);
    const [seq, seq2] = [await seqOf(g), await seqOf(g2)];

    expect((await api(app, owner, "DELETE", `/api/agents/${x.id}`)).status).toBe(200);

    expect(await notices(g, seq)).toEqual([{ seq: seq + 1, event: "member_left", actor: owner.id, principal: x.id, new_creator: null }]);
    expect(await notices(g2, seq2)).toEqual([{ seq: seq2 + 1, event: "member_left", actor: owner.id, principal: x.id, new_creator: null }]);
    expect([(await memberships(g, x.id)).at(-1)!.left, (await memberships(g2, x.id)).at(-1)!.left]).toEqual([seq + 1, seq2 + 1]);
    expect(await isIn(x.conversationId, x.id)).toBe(1);
    await socket.waitFor((e) => e.type === "conversation" && e.id === g);
    await socket.waitFor((e) => e.type === "conversation" && e.id === g2);
    const history = (await api(app, mia, "GET", `/api/conversations/${g}/messages`)).json.messages;
    expect(history.find((m: { seq: number }) => m.seq === Number(said.rows[0]!.seq))).toMatchObject({ senderId: x.id, text: "我说过的话" });
    expect(history.at(-1).text).toBe(`${x.name}退出了群聊`);

    // Deleting again changes nothing.
    expect((await api(app, owner, "DELETE", `/api/agents/${x.id}`)).status).toBe(200);
    expect(await seqOf(g)).toBe(seq + 1);
  });

  it("a delete whose leaving never happened (the process died in between) is finished by the start-up sweep", async () => {
    const { creator, owner, mia, g } = await world();
    const g2 = await group(app, owner, "second", [creator, mia]);
    const [x, live, idle] = [await agentOf(owner), await agentOf(owner), await agentOf(owner)];
    await addOwn(owner, g, x);
    await addOwn(owner, g2, x);
    await addOwn(owner, g, live);
    // The delete committed and nothing after it ran: the Agent is deleted and still in both groups.
    await db.query("update agents set deleted_at = now() where principal_id = any($1::uuid[])", [[x.id, idle.id]]);
    const [seq, seq2] = [await seqOf(g), await seqOf(g2)];

    expect(await leaveGroupsOfDeleted({ db, conversations: app.deps.conversations, log: app.log })).toBe(2);
    expect(await notices(g, seq)).toEqual([{ seq: seq + 1, event: "member_left", actor: owner.id, principal: x.id, new_creator: null }]);
    expect(await notices(g2, seq2)).toEqual([{ seq: seq2 + 1, event: "member_left", actor: owner.id, principal: x.id, new_creator: null }]);
    expect([await isIn(g, x.id), await isIn(g2, x.id), await isIn(g, live.id), await isIn(x.conversationId, x.id)]).toEqual([0, 0, 1, 1]);
    // Nothing left to do: a second sweep changes nothing.
    expect(await leaveGroupsOfDeleted({ db, conversations: app.deps.conversations, log: app.log })).toBe(0);
    expect(await seqOf(g)).toBe(seq + 1);

    // A service that starts runs the sweep before it answers anything.
    await db.query("update agents set deleted_at = now() where principal_id = $1", [live.id]);
    const restarted = await buildApp(
      { config: app.deps.config, db, models: gateway, blobs: app.deps.blobs },
      { agentWorker: false, answerFloor: NO_ANSWER_FLOOR, staleRunSweep: false },
    );
    try {
      await restarted.ready();
      expect(await isIn(g, live.id)).toBe(0);
      expect((await notices(g, seq + 1)).map((n) => [n.event, n.actor, n.principal])).toEqual([["member_left", owner.id, live.id]]);
    } finally {
      await restarted.close();
    }
  });

  it("when the leaving's first query fails after the delete committed, the delete still answers 200, the Agent is deleted, and the sweep takes it out of the group", async () => {
    const { owner, g } = await world();
    const x = await agentOf(owner);
    await addOwn(owner, g, x);
    const real = app.deps.db; // the harness's `db` forwards to this; the routes call it
    const query = real.query.bind(real);
    const fault = vi.spyOn(real, "query").mockImplementation(((sql: unknown, ...rest: unknown[]) =>
      typeof sql === "string" && sql.includes("join agents a on a.principal_id = ms.principal_id")
        ? Promise.reject(new Error("injected: the leave-groups query fails"))
        : (query as (...a: unknown[]) => unknown)(sql, ...rest)) as typeof real.query);
    let res;
    try {
      res = await api(app, owner, "DELETE", `/api/agents/${x.id}`);
      expect(fault).toHaveBeenCalled();
    } finally {
      fault.mockRestore();
    }
    expect(res.status).toBe(200);
    expect((await db.query("select 1 from agents where principal_id = $1 and deleted_at is not null", [x.id])).rowCount).toBe(1);
    expect(await isIn(g, x.id)).toBe(1);

    expect(await leaveGroupsOfDeleted({ db, conversations: app.deps.conversations, log: app.log })).toBe(1);
    expect(await isIn(g, x.id)).toBe(0);
  });

  it("while a deleted Agent is still listed in a group (between the delete and its leaving), it never replies there", async () => {
    const { owner, g } = await world();
    const x = await agentOf(owner);
    await addOwn(owner, g, x);
    const calls = gateway.calls.length;
    const asked = await say(owner, g, "在吗");
    const runId = await insertRun(x, owner, g, "queued", { covers: asked });
    const ticket = (await app.agentPort.claimNext())!;
    expect(ticket).toEqual(ticketOf(runId, x, owner, g));
    expect(isRunEnd(await app.agentPort.begin(ticket))).toBe(false);
    // The delete has committed (as it would, without the interruption its own transaction makes) and its leaving has not
    // happened yet: the Agent is deleted and still a member.
    await db.query("update agents set deleted_at = now() where principal_id = $1", [x.id]);

    expect(await app.agentPort.post(ticket, { text: "在的", reasoning: "", stopped: false, truncated: false })).toBe("refused");
    await app.agentPort.finish(ticket, { status: "cancelled" }, CANNED_USAGE, { inputChars: 10, outputChars: 2 });
    expect(await runOf(runId)).toMatchObject({ status: "cancelled", error: "agent_deleted" });
    // A reply queued for it there meanwhile ends before any call.
    const next = await insertRun(x, owner, g, "queued", { covers: asked });
    const again = (await app.agentPort.claimNext())!;
    expect(again.id).toBe(next);
    expect(await app.agentPort.begin(again)).toEqual({ status: "cancelled", error: "agent_deleted" });
    await app.agentPort.finish(again, { status: "cancelled", error: "agent_deleted" }, null, { inputChars: 0, outputChars: 0 });
    expect(await fromAgent(x, g)).toEqual([]);
    expect(gateway.calls).toHaveLength(calls);
    expect(await isIn(g, x.id)).toBe(1);
  });
});

describe("races", () => {
  /** One real HTTP request over its own connection, as concurrency.test.ts makes them. */
  async function call(who: Actor, method: "POST" | "DELETE", path: string, body?: unknown) {
    const { http } = await listen(app);
    const res = await fetch(http + path, {
      method,
      headers: { cookie: who.cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("the owner leaving (or removed) while adding their Agent in another request: the add came first and the Agent left with them, or it was refused; never an Agent without its owner", { timeout: 60_000 }, async () => {
    const { creator, owner, g } = await world();
    const x = await agentOf(owner);
    for (let round = 0; round < 12; round++) {
      const leaving = round % 2 === 0;
      const before = await seqOf(g);
      const lead = [0, 1, 2, 4][Math.floor(round / 2) % 4]!;
      const adding = () => call(owner, "POST", `/api/conversations/${g}/members`, { principalId: x.id });
      const out = () => (leaving ? call(owner, "DELETE", `/api/conversations/${g}/members/${owner.id}`) : call(creator, "DELETE", `/api/conversations/${g}/members/${owner.id}`));
      const [added, left] = await bounded(
        `round ${round}`,
        Promise.all(round % 4 < 2 ? [adding(), sleep(lead).then(out)] : [sleep(lead).then(adding), out()]),
      );

      expect([round, left.status]).toEqual([round, 200]);
      const ownerOut = leaving ? ["member_left", owner.id, owner.id] : ["member_removed", creator.id, owner.id];
      const events = (await notices(g, before)).map((n) => [n.event, n.actor, n.principal]);
      if (added.status === 201) {
        expect([round, events]).toEqual([round, [["member_joined", owner.id, x.id], ["member_left", owner.id, x.id], ownerOut]]);
      } else {
        // The leave came first: the owner was no longer a member to add anything.
        expect([round, added]).toEqual([round, { status: 404, json: { error: "not_found" } }]);
        expect([round, events]).toEqual([round, [ownerOut]]);
      }
      expect([round, await isIn(g, x.id), await isIn(g, owner.id)]).toEqual([round, 0, 0]);
      const seqs = (await db.query<{ seq: number }>("select seq::int as seq from messages where conversation_id = $1 order by seq", [g])).rows.map((r) => r.seq);
      expect(seqs).toEqual(Array.from({ length: await seqOf(g) }, (_, i) => i + 1));
      expect((await add(creator, g, owner.id)).status).toBe(201);
    }
  });

  it("taking an Agent out while its reply is being posted: the post waits for the removal and is refused, nothing is posted, and the run ends cancelled agent_removed, charged what the upstream reported", { timeout: 30_000 }, async () => {
    const { owner, mia, g } = await world();
    const x = await agentOf(owner);
    await addOwn(owner, g, x);
    const asked = await say(owner, g, "帮我总结一下");
    const runId = await insertRun(x, owner, g, "queued", { covers: asked });
    const ticket = (await app.agentPort.claimNext())!;
    const prepared = await app.agentPort.begin(ticket);
    if (isRunEnd(prepared)) throw new Error(`begin ended the run: ${JSON.stringify(prepared)}`);
    const held = (await db.query<{ hold: string }>("select hold_micro::text as hold from agent_runs where id = $1", [runId])).rows[0]!.hold;
    expect(BigInt(held)).toBeGreaterThan(0n);
    const socket = await connect(app, owner);

    // The removal takes the group's row and then waits on the run's row (held here); the post, meanwhile, waits on the
    // group's row. Then the run's row is let go: the removal commits first, and the post finds the run interrupted.
    const holder = await db.pool.connect();
    let removal: Promise<{ status: number }> | undefined;
    let posting: Promise<"posted" | "refused" | "empty"> | undefined;
    try {
      await holder.query("begin");
      await holder.query("select 1 from agent_runs where id = $1 for update", [runId]);
      const holderPid = (await holder.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
      removal = remove(owner, g, x.id);
      const removalPid = await blockedBy(holderPid);
      posting = app.agentPort.post(ticket, { text: "总结如下：……", reasoning: "", stopped: false, truncated: false });
      await blockedBy(removalPid);
      await holder.query("rollback");
    } finally {
      holder.release();
    }
    expect((await bounded("the removal", removal!)).status).toBe(200);
    expect(await bounded("the post", posting!)).toBe("refused");
    expect(app.agentPort.shouldStop(ticket)).toBe(true);
    // As the worker ends a reply whose post was refused, with the upstream's usage.
    await bounded("finish", app.agentPort.finish(ticket, { status: "cancelled" }, CANNED_USAGE, { inputChars: prepared.inputChars, outputChars: 7 }));

    expect(await fromAgent(x, g)).toEqual([]);
    expect(await runOf(runId)).toEqual({ status: "cancelled", error: "agent_removed", interrupted: "agent_removed", waiting: 0 });
    const record = await db.query(
      `select outcome, input_tokens::int as input_tokens, output_tokens::int as output_tokens, estimated, cost_micro::int as cost,
              (free_micro + balance_micro)::int as charged, forgiven_micro::int as forgiven
         from usage_records where run_id = $1`,
      [runId],
    );
    // fast: 1 micro-point per input token, 2 per output token: 11 + 2 × 7.
    expect(record.rows).toEqual([{ outcome: "cancelled", input_tokens: 11, output_tokens: 7, estimated: false, cost: 25, charged: 25, forgiven: 0 }]);
    expect((await db.query<{ hold: string }>("select hold_micro::text as hold from agent_runs where id = $1", [runId])).rows[0]!.hold).toBe("0");
    await socket.next((e) => e.type === "run" && e.run.id === runId && e.run.status === "cancelled" && e.run.error === "agent_removed");
    expect(await app.agentWorker.runOnce()).toBe(false);
    expect(await isIn(g, mia.id)).toBe(1);
  });
});
