import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.ts";
import { api, signUp, type Actor } from "./helpers/actors.ts";
import { latestRunId, mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { NO_ANSWER_FLOOR, useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { closeAllSockets, connect } from "./helpers/ws.ts";

/**
 * The limits on replies (spec 6.4 "保护性上限", README "Agents and runs"): an owner starts at most
 * `AGENT_RUNS_PER_MINUTE` (20) replies a minute — counted exactly, also when two of their Agents are written to at the
 * same instant — and has at most `AGENT_MAX_CONCURRENT_RUNS` running at once (the default is 4, at most 3 of them for
 * others' calls; this file sets 2 and 2 explicitly, below); further ones wait queued.
 */

const gateway = scriptedGateway();
// The old limit of 2 running at once is set here: the tests of it below are about the limit, not the default.
const { app, db } = useApp({ env: { ...SITE_ENV, AGENT_MAX_CONCURRENT_RUNS: "2", AGENT_MAX_CONCURRENT_OTHERS_RUNS: "2" }, models: gateway, agentWorker: false });

afterEach(async () => {
  await closeAllSockets();
  expect(gateway.pending()).toBe(0);
});

const FAST = { source: "site", id: "fast" } as const;
const PERSONA = "简短地回答。";

let txn = 0;
const say = (owner: Actor, conv: string, text: string) =>
  api(app, owner, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `rl${++txn}` });
const latestRun = async (owner: Actor, conv: string) => (await api(app, owner, "GET", `/api/conversations/${conv}/run`)).json.run;
const runCount = async (ownerId: string) =>
  (await db.query<{ n: number }>("select count(*)::int as n from agent_runs where owner_id = $1", [ownerId])).rows[0]!.n;

/** `n` replies of `agent` that ended within the last minute, as if they had been answered. */
const answeredMinuteAgo = (ownerId: string, agent: { id: string; conversationId: string }, n: number) =>
  db.query(
    `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, created_at, started_at, finished_at)
     select 'reply', $1, $2, $3, 'done', 0, now() - interval '30 seconds', now() - interval '30 seconds', now() - interval '29 seconds'
       from generate_series(1, $4)`,
    [agent.conversationId, agent.id, ownerId, n],
  );

describe("replies started a minute", () => {
  it("the 21st trigger within a minute records a failed run, rate_limited and retryable — no call, no hold, no usage record; the message is stored", async () => {
    const owner = await signUp(app, "twenty");
    const agent = await mustCreateAgent(app, owner, { model: FAST, persona: PERSONA });
    const conv = agent.conversationId as string;
    expect(app.deps.config.agentRunsPerMinute).toBe(20);
    for (let i = 1; i <= 20; i++) {
      expect((await say(owner, conv, `第 ${i} 句`)).status).toBe(201);
      gateway.reply(`回复 ${i}`);
      expect(await app.agentWorker.runOnce()).toBe(true);
    }
    expect(await runCount(owner.id)).toBe(20);

    const s = await connect(app, owner);
    const calls = gateway.calls.length;
    const sent = await say(owner, conv, "第 21 句");
    expect(sent.status).toBe(201);
    const limited = await latestRun(owner, conv);
    expect(limited).toEqual({ id: limited.id, status: "failed", error: "rate_limited", retryable: true });
    // The owner is told, as of any run.
    expect((await s.next((e) => e.type === "run" && e.run.id === limited.id)).run).toEqual(limited);
    expect(await app.agentWorker.runOnce()).toBe(false);
    expect(gateway.calls.length).toBe(calls);
    expect(await runCount(owner.id)).toBe(21);
    expect((await db.query("select hold_micro::text as hold, source from agent_runs where id = $1", [limited.id])).rows).toEqual([{ hold: "0", source: null }]);
    expect((await db.query("select 1 from usage_records where run_id = $1", [limited.id])).rowCount).toBe(0);
    const history = (await api(app, owner, "GET", `/api/conversations/${conv}/messages`)).json.messages;
    expect(history.at(-1)).toMatchObject({ seq: sent.json.message.seq, senderId: owner.id, text: "第 21 句" });

    // Retrying counts too: still over the limit, 429, and nothing more is recorded.
    expect(await api(app, owner, "POST", `/api/conversations/${conv}/runs/retry`, { runId: await latestRunId(db, conv) })).toEqual({ status: 429, json: { error: "rate_limited" } });
    expect(await runCount(owner.id)).toBe(21);
    // Once the minute has passed, the retry answers everything up to the last message.
    await db.query("update agent_runs set created_at = created_at - interval '2 minutes' where owner_id = $1 and status = 'done'", [owner.id]);
    const retried = await api(app, owner, "POST", `/api/conversations/${conv}/runs/retry`, { runId: await latestRunId(db, conv) });
    expect(retried).toMatchObject({ status: 201, json: { run: { status: "queued" } } });
    gateway.reply("现在回复。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(await latestRun(owner, conv)).toMatchObject({ id: retried.json.run.id, status: "done" });
  });

  it("a rate-limited run started nothing: it does not count toward the replies started a minute", async () => {
    const owner = await signUp(app, "limited");
    const agent = await mustCreateAgent(app, owner, { model: FAST, persona: PERSONA });
    await db.query(
      `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, error, covers_seq, created_at, finished_at)
       select 'reply', $1, $2, $3, 'failed', 'rate_limited', 0, now() - interval '30 seconds', now() - interval '30 seconds'
         from generate_series(1, 25)`,
      [agent.conversationId, agent.id, owner.id],
    );
    await say(owner, agent.conversationId, "现在可以了吗");
    expect(await latestRun(owner, agent.conversationId)).toMatchObject({ status: "queued" });
    gateway.reply("可以。");
    expect(await app.agentWorker.runOnce()).toBe(true);
  });

  it("over the limit while a reply is already running: the message is noted on it as usual, and no failed run is recorded", async () => {
    const owner = await signUp(app, "foldin");
    const agent = await mustCreateAgent(app, owner, { model: FAST, persona: PERSONA });
    const conv = agent.conversationId as string;
    await answeredMinuteAgo(owner.id, agent, 19);
    const hold = gateway.hang();
    await say(owner, conv, "第二十句");
    const running = app.agentWorker.runOnce();
    await hold.reached;
    await say(owner, conv, "又一句");
    expect(await runCount(owner.id)).toBe(20);
    expect((await db.query("select 1 from agent_runs where owner_id = $1 and status = 'failed'", [owner.id])).rowCount).toBe(0);
    hold.release("回第二十句。");
    await running;
    // The follow-up answering what was noted (a follow-up is not a new start).
    gateway.reply("回又一句。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect((await db.query("select status from agent_runs where owner_id = $1 and created_at > now() - interval '10 seconds' order by created_at", [owner.id])).rows).toEqual([
      { status: "done" },
      { status: "done" },
    ]);
  });

  it("exact under concurrency: at 19, two messages to two Agents at the same instant start exactly one reply", { timeout: 60_000 }, async () => {
    for (let round = 0; round < 8; round++) {
      const owner = await signUp(app, `pair${round}`);
      const [a, b] = [await mustCreateAgent(app, owner, { model: FAST, persona: PERSONA }), await mustCreateAgent(app, owner, { model: FAST, persona: PERSONA })];
      await answeredMinuteAgo(owner.id, a, 19);
      const [ra, rb] = await Promise.all([say(owner, a.conversationId, "同时一"), say(owner, b.conversationId, "同时二")]);
      expect([round, ra.status, rb.status]).toEqual([round, 201, 201]);
      const queued = await db.query("select agent_id from agent_runs where owner_id = $1 and status = 'queued'", [owner.id]);
      const limited = await db.query("select agent_id from agent_runs where owner_id = $1 and error = 'rate_limited'", [owner.id]);
      // Exactly one started; the other is the refusal the owner sees, on the other Agent.
      expect([round, queued.rows.length, limited.rows.length, await runCount(owner.id)]).toEqual([round, 1, 1, 21]);
      expect(limited.rows[0]!.agent_id).not.toBe(queued.rows[0]!.agent_id);
      // Leave nothing queued for the next round's owner.
      await db.query("update agent_runs set status = 'cancelled' where owner_id = $1 and status = 'queued'", [owner.id]);
    }
  });
});

describe("replies in flight in the whole service", () => {
  it("AGENT_MAX_RUNS_IN_FLIGHT caps what the worker runs at once: with 1, a second owner's reply waits queued until the first ends", async () => {
    const own = scriptedGateway();
    const capped = await buildApp(
      { config: { ...app.deps.config, agentMaxRunsInFlight: 1 }, db, models: own },
      { answerFloor: NO_ANSWER_FLOOR, staleRunSweep: false }, // the worker's background loop runs
    );
    try {
      await capped.ready();
      const [a, b] = [await signUp(capped, "inflight_a"), await signUp(capped, "inflight_b")];
      const [agentA, agentB] = [await mustCreateAgent(capped, a, { model: FAST, persona: PERSONA }), await mustCreateAgent(capped, b, { model: FAST, persona: PERSONA })];
      const [first, second] = [own.hang(), own.hang()];
      await api(capped, a, "POST", `/api/conversations/${agentA.conversationId}/messages`, { text: "一", clientTxn: "if1" });
      await first.reached;
      await api(capped, b, "POST", `/api/conversations/${agentB.conversationId}/messages`, { text: "二", clientTxn: "if2" });
      await new Promise((resolve) => setTimeout(resolve, 300)); // the worker was woken by the send: it claims nothing more
      expect(own.calls).toHaveLength(1);
      expect((await api(capped, b, "GET", `/api/conversations/${agentB.conversationId}/run`)).json.run).toMatchObject({ status: "queued" });

      first.release("回一");
      await second.reached;
      expect(own.calls).toHaveLength(2);
      second.release("回二");
      await vi.waitFor(async () => expect((await api(capped, b, "GET", `/api/conversations/${agentB.conversationId}/run`)).json.run).toMatchObject({ status: "done" }));
    } finally {
      await capped.close();
    }
  });
});

describe("replies running at once", () => {
  it("a third reply of one owner stays queued until one of the two running finishes; another owner's is not held up", async () => {
    const owner = await signUp(app, "three");
    expect(app.deps.config.agentMaxConcurrentRuns).toBe(2);
    const agents = [];
    for (let i = 0; i < 3; i++) agents.push(await mustCreateAgent(app, owner, { model: FAST, persona: PERSONA }));
    const [one, two] = [gateway.hang(), gateway.hang()];
    for (const [i, agent] of agents.entries()) expect((await say(owner, agent.conversationId, `给第 ${i + 1} 个`)).status).toBe(201);

    const first = app.agentWorker.runOnce();
    await one.reached;
    const second = app.agentWorker.runOnce();
    await two.reached;
    expect(await app.agentWorker.runOnce()).toBe(false);
    expect(await latestRun(owner, agents[2]!.conversationId)).toMatchObject({ status: "queued" });

    // Another owner's reply runs meanwhile.
    const other = await signUp(app, "other");
    const theirs = await mustCreateAgent(app, other, { model: FAST, persona: PERSONA });
    await say(other, theirs.conversationId, "我的");
    gateway.reply("你的回复");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(await latestRun(other, theirs.conversationId)).toMatchObject({ status: "done" });
    expect(await app.agentWorker.runOnce()).toBe(false);

    one.release("第一个回复");
    await first;
    gateway.reply("第三个回复");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(await latestRun(owner, agents[2]!.conversationId)).toMatchObject({ status: "done" });
    two.release("第二个回复");
    await second;
    expect((await db.query("select status from agent_runs where owner_id = $1", [owner.id])).rows.map((r) => r.status)).toEqual(["done", "done", "done"]);
  });
});
