import { afterEach, describe, expect, it } from "vitest";
import { recoverRuns } from "../src/agents/port-impl.ts";
import { NOTHING } from "../src/agents/runtime/port.ts";
import { lockAgent } from "../src/agents/store.ts";
import { api, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { closeAllSockets, connect, type TestSocket } from "./helpers/ws.ts";

/**
 * A run belongs to one conversation (`agent_runs.conversation_id`), and every run helper acts on that one: it locks that
 * conversation's row (`lockAgent`'s conversation), looks for the reply there, folds, queues and follows up there, and
 * announces the run with it — never the Agent's dedicated conversation, unless that is the run's. Only dedicated
 * conversations get runs so far (an Agent cannot join a group yet), so each case makes a second conversation by hand,
 * with the owner and the Agent as members, and a run of the Agent in it. Where it matters, the dedicated conversation's
 * row is held locked by another transaction meanwhile: a helper that still reached for it would wait.
 */

const gateway = scriptedGateway();
// Runs are inserted and driven by hand here: no worker may pick them up.
const { app, db } = useApp({ env: SITE_ENV, models: gateway, agentWorker: false });

afterEach(async () => {
  await closeAllSockets();
  expect(gateway.pending()).toBe(0);
});

const FAST = { source: "site", id: "fast" } as const;

interface Setup {
  owner: Actor;
  agent: { id: string; conversationId: string; [k: string]: unknown };
  /** The Agent's dedicated conversation. */
  dedicated: string;
  /** Another conversation the owner and the Agent are members of, made by hand. */
  other: string;
}

async function setup(name: string): Promise<Setup> {
  const owner = await signUp(app, name);
  const agent = await mustCreateAgent(app, owner, { model: FAST, persona: "简短地回答。" });
  const other = (await db.query<{ id: string }>("insert into conversations (type, title, creator_id) values ('group', 'elsewhere', $1) returning id", [owner.id]))
    .rows[0]!.id;
  await db.query(
    `insert into memberships (conversation_id, principal_id, role, joined_seq) values ($1, $2, 'speaker', 0), ($1, $3, 'speaker', 0)`,
    [other, owner.id, agent.id],
  );
  return { owner, agent, dedicated: agent.conversationId, other };
}

/** A reply run of the Agent in `conversationId`, inserted by hand. */
async function insertRun(
  s: Setup,
  conversationId: string,
  status: "queued" | "running" | "done",
  { covers = 1, startedMinutesAgo = 0 }: { covers?: number; startedMinutesAgo?: number } = {},
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, started_at)
     values ('reply', $1, $2, $3, $4, $5, case when $4 = 'queued' then null else now() - make_interval(mins => $6) end) returning id`,
    [conversationId, s.agent.id, s.owner.id, status, covers, startedMinutesAgo],
  );
  return rows[0]!.id;
}

/** The Agent's reply to run `runId`, stored in `conversationId` as `postAsAgent` would store it (`client_txn` = the run). */
const postedIn = (s: Setup, conversationId: string, runId: string, seq = 1) =>
  db.query(`insert into messages (conversation_id, seq, sender_id, kind, body, client_txn) values ($1, $2, $3, 'text', '{"text":"回复"}', $4)`, [
    conversationId,
    seq,
    s.agent.id,
    runId,
  ]);

/**
 * The owner's message at `seq` of `conversationId`, stored by hand, and the call it makes waiting for the Agent's reply under way there
 * (`deferred_calls`: what a send while the reply runs writes), to be answered as that reply ends.
 */
async function waitBehind(s: Setup, conversationId: string, seq: number): Promise<void> {
  await db.query(`insert into messages (conversation_id, seq, sender_id, kind, body) values ($1, $2, $3, 'text', '{"text":"还有一件事"}')`, [conversationId, seq, s.owner.id]);
  await db.query("update conversations set seq = greatest(seq, $2) where id = $1", [conversationId, seq]);
  await db.query(
    `insert into deferred_calls (agent_id, conversation_id, message_seq, owner_id, lane, caller_id, triggered_by, asker_ids)
     values ($1, $2, $3, $4, 'own', $4, 'human', array[$4::uuid])`,
    [s.agent.id, conversationId, seq, s.owner.id],
  );
}

/** The runs in `conversationId`, oldest first. */
const runsIn = async (conversationId: string) =>
  (
    await db.query<{ status: string; error: string | null; covers: number }>(
      `select status, error, covers_seq::int as covers from agent_runs where conversation_id = $1 order by created_at, id`,
      [conversationId],
    )
  ).rows;

const runPushes = (socket: TestSocket) => socket.events.filter((e) => e.type === "run").map((e) => [e.conversationId, e.run.status, e.run.error ?? null]);

/** Holds conversation `id`'s row lock in a transaction of its own while `work` runs; `work` must settle within 3 s. */
async function whileLocked<T>(id: string, work: () => Promise<T>): Promise<T> {
  const client = await db.pool.connect();
  let pending: Promise<T> | undefined;
  try {
    await client.query("begin");
    await client.query("select 1 from conversations where id = $1 for update", [id]);
    pending = work();
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`waited for the lock of conversation ${id}`)), 3000);
    });
    try {
      return await Promise.race([pending, late]);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await client.query("rollback");
    client.release();
    await pending?.catch(() => {});
  }
}

/** Whether `work` waits for conversation `id`'s row lock: still unsettled 300 ms after it started with the row held. */
async function waitsFor(id: string, work: () => Promise<unknown>): Promise<boolean> {
  const client = await db.pool.connect();
  let settled = false;
  let pending: Promise<unknown> | undefined;
  try {
    await client.query("begin");
    await client.query("select 1 from conversations where id = $1 for update", [id]);
    pending = work().finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    return !settled;
  } finally {
    await client.query("rollback");
    client.release();
    await pending;
  }
}

describe("lockAgent", () => {
  it("locks the conversation it is given — by default the Agent's own — then the agents row; 404 for an id that is no Agent", async () => {
    const s = await setup("lena");
    const locked = await whileLocked(s.dedicated, () => db.tx((t) => lockAgent(t, s.agent.id, s.other)));
    // The Agent as it is: its dedicated conversation is still what it says.
    expect(locked).toMatchObject({ id: s.agent.id, ownerId: s.owner.id, conversationId: s.dedicated, groupMentions: "members" });
    expect(await waitsFor(s.other, () => db.tx((t) => lockAgent(t, s.agent.id, s.other)))).toBe(true);
    expect(await waitsFor(s.dedicated, () => db.tx((t) => lockAgent(t, s.agent.id)))).toBe(true);
    expect(await waitsFor(s.other, () => db.tx((t) => lockAgent(t, s.agent.id)))).toBe(false);
    for (const id of [s.owner.id, "3f1c2a4e-9b7d-4c1e-8a2f-5d6e7f809a1b"]) {
      await expect(db.tx((t) => lockAgent(t, id, s.other))).rejects.toMatchObject({ status: 404, code: "not_found" });
      await expect(db.tx((t) => lockAgent(t, id))).rejects.toMatchObject({ status: 404, code: "not_found" });
    }
  });
});

describe("the worker's side of a run in another conversation", () => {
  it("claim, begin and finish lock and announce the run's conversation; the reply for the call that waited is queued there", async () => {
    const s = await setup("wanda");
    const socket = await connect(app, s.owner);
    const runId = await insertRun(s, s.other, "queued");

    const ticket = await whileLocked(s.dedicated, async () => {
      const claimed = (await app.agentPort.claimNext())!;
      expect(claimed).toEqual({ id: runId, agentId: s.agent.id, ownerId: s.owner.id, conversationId: s.other });
      // The other conversation is a group (not the Agent's own), and the run, made by hand, records no call its Agent can
      // see there (no message at what it covers, no `call_seqs`): it ends quietly before the conversation is read, with
      // no call — `cancelled`, no error (port-impl.ts `begin`, `NOTHING_LEFT`; README "Whose joining it reaches back
      // to"). A reply with nothing to answer in the Agent's own conversation still fails `busy` (context.test.ts).
      expect(await app.agentPort.begin(claimed)).toEqual({ status: "cancelled" });
      return claimed;
    });
    // As if the reply had been posted there while the owner wrote more (seq 5), which waits.
    await postedIn(s, s.other, runId);
    await waitBehind(s, s.other, 5);
    await whileLocked(s.dedicated, () => app.agentPort.finish(ticket, { status: "done" }, null, NOTHING));

    expect(await runsIn(s.other)).toEqual([
      { status: "done", error: null, covers: 1 },
      { status: "queued", error: null, covers: 5 },
    ]);
    expect(await runsIn(s.dedicated)).toEqual([]);
    await socket.waitFor((e) => e.type === "run" && e.run.status === "queued");
    expect(runPushes(socket)).toEqual([
      [s.other, "running", null],
      [s.other, "done", null],
      [s.other, "queued", null],
    ]);
    expect(gateway.calls).toHaveLength(0);
  });
});

describe("recovery of a run in another conversation", () => {
  it("at start-up: its reply is looked for in its own conversation (done), and the reply for the call that waited is queued there", async () => {
    const s = await setup("rosa");
    const runId = await insertRun(s, s.other, "running", { covers: 1 });
    await postedIn(s, s.other, runId);
    await waitBehind(s, s.other, 3);

    expect(await whileLocked(s.dedicated, () => recoverRuns(db, app.deps.config, app.log))).toBe(1);
    expect(await runsIn(s.other)).toEqual([
      { status: "done", error: null, covers: 1 },
      { status: "queued", error: null, covers: 3 },
    ]);
    expect(await runsIn(s.dedicated)).toEqual([]);
    expect((await db.query("select outcome, cost_micro::int as cost from usage_records where run_id = $1", [runId])).rows).toEqual([{ outcome: "done", cost: 0 }]);
  });

  it("at start-up: a reply of the same run id in the dedicated conversation does not count; the run fails as one that posted nothing", async () => {
    const s = await setup("rudi");
    const runId = await insertRun(s, s.other, "running", { covers: 1 });
    // Only a reply in the run's own conversation is its reply.
    await postedIn(s, s.dedicated, runId);

    expect(await recoverRuns(db, app.deps.config, app.log)).toBe(1);
    expect(await runsIn(s.other)).toEqual([{ status: "failed", error: "provider_unavailable", covers: 1 }]);
    expect(await runsIn(s.dedicated)).toEqual([]);
  });

  it("by the stale-run sweep: released in its own conversation, its owner told there, the reply for the call that waited queued there", async () => {
    const s = await setup("sven");
    const runId = await insertRun(s, s.other, "running", { covers: 1, startedMinutesAgo: 42 });
    await postedIn(s, s.other, runId);
    await waitBehind(s, s.other, 2);
    const socket = await connect(app, s.owner);

    expect(await whileLocked(s.dedicated, () => app.staleRunSweep.run())).toBe(1);
    expect(await runsIn(s.other)).toEqual([
      { status: "done", error: null, covers: 1 },
      { status: "queued", error: null, covers: 2 },
    ]);

    expect(await runsIn(s.dedicated)).toEqual([]);
    await socket.waitFor((e) => e.type === "run" && e.run.status === "queued");
    expect(runPushes(socket)).toEqual([
      [s.other, "done", null],
      [s.other, "queued", null],
    ]);
  });
});

describe("the routes' side, with a run of the Agent in another conversation", () => {
  it("pausing announces each cancelled reply with its own conversation", async () => {
    const s = await setup("paula");
    await insertRun(s, s.dedicated, "queued");
    await insertRun(s, s.other, "queued");
    const socket = await connect(app, s.owner);

    expect((await api(app, s.owner, "POST", `/api/agents/${s.agent.id}/pause`)).status).toBe(200);
    expect(await runsIn(s.dedicated)).toEqual([{ status: "cancelled", error: "agent_paused", covers: 1 }]);
    expect(await runsIn(s.other)).toEqual([{ status: "cancelled", error: "agent_paused", covers: 1 }]);
    await socket.waitFor((e) => e.type === "run" && e.conversationId === s.dedicated);
    await socket.waitFor((e) => e.type === "run" && e.conversationId === s.other);
    expect(runPushes(socket).sort()).toEqual(
      [
        [s.dedicated, "cancelled", "agent_paused"],
        [s.other, "cancelled", "agent_paused"],
      ].sort(),
    );
  });

  it("an owner's message folds only into a reply of that conversation: one active elsewhere neither takes it nor stops a new one", async () => {
    const s = await setup("felix");
    await insertRun(s, s.other, "queued", { covers: 1 });
    const third = (await db.query<{ id: string }>("insert into conversations (type, creator_id) values ('group', $1) returning id", [s.owner.id])).rows[0]!.id;
    await insertRun(s, third, "running", { covers: 1 });
    const socket = await connect(app, s.owner);

    const sent = await api(app, s.owner, "POST", `/api/conversations/${s.dedicated}/messages`, { text: "你好", clientTxn: "fold1" });
    expect(sent.status).toBe(201);
    expect(await runsIn(s.dedicated)).toEqual([{ status: "queued", error: null, covers: sent.json.message.seq }]);
    expect(await runsIn(s.other)).toEqual([{ status: "queued", error: null, covers: 1 }]);
    expect(await runsIn(third)).toEqual([{ status: "running", error: null, covers: 1 }]);
    // A second message folds into the new one, still not elsewhere.
    const again = await api(app, s.owner, "POST", `/api/conversations/${s.dedicated}/messages`, { text: "还在吗", clientTxn: "fold2" });
    expect(await runsIn(s.dedicated)).toEqual([{ status: "queued", error: null, covers: again.json.message.seq }]);
    expect(await runsIn(s.other)).toEqual([{ status: "queued", error: null, covers: 1 }]);
    expect(await runsIn(third)).toEqual([{ status: "running", error: null, covers: 1 }]);
    await socket.waitFor((e) => e.type === "run");
    expect(runPushes(socket)).toEqual([[s.dedicated, "queued", null]]);
  });

  it("over the per-minute limit, the rate_limited run is recorded in the conversation written to, also while a reply is active elsewhere", async () => {
    const s = await setup("ralf");
    await insertRun(s, s.other, "queued", { covers: 1 });
    // With that one, 20 replies started within the minute.
    await db.query(
      `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, finished_at)
       select 'reply', $1, $2, $3, 'done', 1, now() from generate_series(1, 19)`,
      [s.other, s.agent.id, s.owner.id],
    );
    const socket = await connect(app, s.owner);

    const sent = await api(app, s.owner, "POST", `/api/conversations/${s.dedicated}/messages`, { text: "你好", clientTxn: "rl1" });
    expect(sent.status).toBe(201);
    expect(await runsIn(s.dedicated)).toEqual([{ status: "failed", error: "rate_limited", covers: sent.json.message.seq }]);
    expect((await runsIn(s.other)).filter((r) => r.status === "queued")).toEqual([{ status: "queued", error: null, covers: 1 }]);
    await socket.waitFor((e) => e.type === "run");
    expect(runPushes(socket)).toEqual([[s.dedicated, "failed", "rate_limited"]]);
  });
});
