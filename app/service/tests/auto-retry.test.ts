import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentPort, recoverRuns, type DbAgentPort } from "../src/agents/port-impl.ts";
import { AUTO_RETRY_WINDOW_MS, queueRun, transientFailure } from "../src/agents/runs.ts";
import { failedEnd, passingEnding, type Ending } from "../src/agents/runtime/port.ts";
import { createAgentWorker, type AgentWorker } from "../src/agents/runtime/worker.ts";
import { createToolbox, SEARCH_MESSAGES } from "../src/agents/tools/index.ts";
import type { Config } from "../src/config.ts";
import { api, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useProbeBlobs } from "./helpers/blobs.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { closeAllSockets, connect, type Push } from "./helpers/ws.ts";

/**
 * A reply that failed for a passing reason is tried again by the system (README "Replies", Automatic retry; principle P1:
 * nobody waits for the owner): only after an explicit passing signal (`passingEnding`), at most twice per original call,
 * 20 s and then 2 min after the failure (`AGENTS.autoRetryDelaysMs`), and only if it can START within 10 min of the
 * original call; never a proactive reply, a told reply, a greeting or the owner's own 重试. An ordinary queued run through
 * ordinary admission, found from stored state (`not_before`) by the worker's own claim, so it survives a restart and is
 * claimed once. While it is pending its owner's slot reads queued — never an error that then goes — and the other members
 * of a group see the same frames as for an answer at the first try.
 */

const gateway = scriptedGateway();
const lines: string[] = [];
const { blobs } = useProbeBlobs("af-auto-retry-");
const { app, db } = useApp({
  env: { ...SITE_ENV, AGENTS: JSON.stringify({ autoRetryDelaysMs: [20_000, 120_000] }) },
  models: gateway,
  blobs,
  agentWorker: false,
  logStream: { write: (line) => void lines.push(line) },
});
const FAST = { source: "site", id: "fast" } as const;

/** The fake clock the ports here schedule, claim and start retries by. */
let offset = 0;
const now = (): Date => new Date(Date.now() + offset);
const advance = (ms: number): void => void (offset += ms);
beforeEach(() => {
  offset = 0;
  lines.length = 0;
});
afterEach(async () => {
  await closeAllSockets();
  expect(gateway.pending()).toBe(0);
});

/** A port and a worker of this "process" (a restart, or another instance, is another pair); `tools`: replies are offered them. */
function instance(config: Config = app.deps.config, tools = false): { port: DbAgentPort; worker: AgentWorker } {
  const { db: pool, conversations, reads, searches } = app.deps;
  const toolbox = tools ? createToolbox({ db: pool, blobs, searches, config, log: app.log }) : null;
  const port = createAgentPort({ db: pool, config, blobs, realtime: app.realtime, conversations, reads, log: app.log, now, toolbox });
  const worker = createAgentWorker({ port, models: gateway, runTimeoutMs: config.agentRunTimeoutMs, maxRunsInFlight: 1, background: false, log: app.log, tools: config.tools });
  return { port, worker };
}
const metrics = (name: string, also = "") => lines.filter((l) => l.includes(`"metric":"${name}"`) && l.includes(also)).length;
let txn = 0;
const say = async (who: Actor, conv: string, text: string) => {
  const r = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `ar${++txn}` });
  expect(r.status).toBe(201);
  return r.json.message.seq as number;
};
const runsOf = async (conv: string) =>
  (
    await db.query<{ id: string; status: string; error: string | null; auto_attempt: number; retry_of: string | null; lane: string; covers: string; calls: string[] | null; owner_retry: boolean; greets: boolean }>(
      "select id, status, error, auto_attempt, retry_of, lane, covers_seq::text as covers, call_seqs::text[] as calls, owner_retry, greets from agent_runs where conversation_id = $1 order by created_at, id",
      [conv],
    )
  ).rows;
const slot = async (owner: Actor, conv: string) => (await api(app, owner, "GET", `/api/conversations/${conv}/run`)).json.run;
const agentSaid = async (owner: Actor, conv: string, agentId: string) =>
  (await api(app, owner, "GET", `/api/conversations/${conv}/messages`)).json.messages.filter((m: { senderId: string }) => m.senderId === agentId).map((m: { text: string }) => m.text);
async function own(name: string) {
  const owner = await signUp(app, name);
  const agent = await mustCreateAgent(app, owner, { model: FAST, persona: "简短地回答。" });
  return { owner, agent, conv: agent.conversationId as string };
}
/** olive's Agent in a group with two members. */
async function scene(name: string) {
  const owner = await signUp(app, name);
  const mia = await signUp(app, `${name}_m`);
  const agent = await mustCreateAgent(app, owner, { handle: `${name}_bot`, model: FAST, persona: "简短。" });
  const g = await group(app, owner, "打印机群", [mia, await signUp(app, `${name}_n`)]);
  expect((await api(app, owner, "POST", `/api/conversations/${g}/members`, { principalId: agent.id })).status).toBe(201);
  return { owner, mia, agent, g, call: `@${name}_bot` };
}

describe("THE classifier of passing endings (one table over every ending kind the worker and recovery produce)", () => {
  const table: Array<[string, Ending, boolean]> = [
    ["upstream 500", { kind: "upstream", code: "provider_unavailable", status: 500, said: false }, true],
    ["upstream 503 after text", { kind: "upstream", code: "provider_unavailable", status: 503, said: true }, true],
    ["upstream 408", { kind: "upstream", code: "provider_unavailable", status: 408, said: false }, true],
    ["upstream 429", { kind: "upstream", code: "provider_unavailable", status: 429, said: false }, true],
    ["upstream 400", { kind: "upstream", code: "provider_unavailable", status: 400, said: false }, false],
    ["upstream 404", { kind: "upstream", code: "provider_unavailable", status: 404, said: false }, false],
    ["upstream 422", { kind: "upstream", code: "provider_unavailable", status: 422, said: false }, false],
    ["network error, nothing said", { kind: "upstream", code: "provider_unavailable", said: false }, true],
    ["network error after text", { kind: "upstream", code: "provider_unavailable", said: true }, false],
    ["key refused 401", { kind: "upstream", code: "provider_rejected", status: 401, said: false }, false],
    ["address refused", { kind: "upstream", code: "address_not_allowed", said: false }, false],
    ["thinking exhausted", { kind: "upstream", code: "thinking_exhausted", said: true }, false],
    ["stream cut, nothing said", { kind: "cut", said: false }, true],
    ["stream cut after text", { kind: "cut", said: true }, false],
    ["the reply's time out, nothing said", { kind: "timeout", said: false }, true],
    ["the reply's time out after text", { kind: "timeout", said: true }, false],
    ["finished with nothing in it (refused, thought only, cut block)", { kind: "nothing" }, false],
    ["lost mid-call (restart, release, sweep)", { kind: "lost" }, true],
  ];
  it.each(table)("%s → %s", (_name, ending, passing) => {
    expect(passingEnding(ending)).toBe(passing);
    expect(transientFailure(failedEnd("provider_unavailable", ending))).toBe(passing);
  });
  it("nothing that is not a failure tagged passing is ever transient", () => {
    for (const end of [{ status: "failed" }, { status: "done" }, { status: "stopped" }, { status: "cancelled" }]) expect(transientFailure(end)).toBe(false);
  });
});

describe("in the Agent's own conversation", () => {
  it("a 503: no failure is shown; the retry, queued, is claimed only once its 20 s are up (fake clock), answers, and each attempt is charged", async () => {
    const { owner, agent, conv } = await own("ar_own");
    const s = await connect(app, owner);
    const { worker } = instance();
    await say(owner, conv, "今天天气怎么样？");
    gateway.fail("provider_unavailable", { status: 503 });
    expect(await worker.runOnce()).toBe(true);
    const [first, retry] = await runsOf(conv);
    expect(first).toMatchObject({ status: "failed", error: "provider_unavailable", auto_attempt: 0 });
    expect(retry).toMatchObject({ status: "queued", auto_attempt: 1, retry_of: first!.id, lane: "own", covers: first!.covers });
    expect(await slot(owner, conv)).toEqual({ id: retry!.id, status: "queued", retryable: false });
    await app.realtime.idle();
    expect(s.events.filter((e: Push) => e.type === "run" && e.run.status === "failed")).toEqual([]);
    expect(metrics("auto_retry_scheduled")).toBe(1);

    advance(19_000);
    expect(await worker.runOnce()).toBe(false);
    advance(1_000);
    gateway.reply("晴，二十度。");
    expect(await worker.runOnce()).toBe(true);
    expect((await runsOf(conv)).map((r) => r.status)).toEqual(["failed", "done"]);
    expect(metrics("auto_retry_ran")).toBe(1);
    expect(await agentSaid(owner, conv, agent.id)).toEqual(["晴，二十度。"]);
    expect((await db.query("select 1 from usage_records u join agent_runs r on r.id = u.run_id where r.conversation_id = $1", [conv])).rowCount).toBe(2);
  });

  it("three passing failures: two retries (20 s, then 2 min), then the failure is shown with 重试, counted as given up", async () => {
    const { owner, conv } = await own("ar_three");
    const { worker } = instance();
    await say(owner, conv, "在吗");
    gateway.fail("provider_unavailable", { status: 502 });
    expect(await worker.runOnce()).toBe(true);
    advance(20_000);
    gateway.fail("provider_unavailable");
    expect(await worker.runOnce()).toBe(true);
    advance(119_000);
    expect(await worker.runOnce()).toBe(false);
    advance(1_000);
    gateway.fail("provider_unavailable", { status: 429 });
    expect(await worker.runOnce()).toBe(true);
    const runs = await runsOf(conv);
    expect(runs.map((r) => [r.status, r.auto_attempt, r.retry_of])).toEqual([
      ["failed", 0, null],
      ["failed", 1, runs[0]!.id],
      ["failed", 2, runs[0]!.id],
    ]);
    expect(await slot(owner, conv)).toEqual({ id: runs[2]!.id, status: "failed", error: "provider_unavailable", retryable: true });
    expect([metrics("auto_retry_scheduled"), metrics("auto_retry_ran"), metrics("auto_retry_gave_up", '"why":"attempts"')]).toEqual([2, 2, 1]);
  });

  it("the owner's 重试 starts no new automatic chain: its own passing failure is shown at once (the owner is there)", async () => {
    const { owner, conv } = await own("ar_press_chain");
    const { worker } = instance();
    await say(owner, conv, "在吗");
    gateway.fail("provider_unavailable", { status: 503 });
    expect(await worker.runOnce()).toBe(true);
    advance(20_000);
    gateway.fail("provider_unavailable", { status: 503 });
    expect(await worker.runOnce()).toBe(true);
    advance(120_000);
    gateway.fail("provider_unavailable", { status: 503 });
    expect(await worker.runOnce()).toBe(true);
    expect((await api(app, owner, "POST", `/api/conversations/${conv}/runs/retry`)).status).toBe(201);
    gateway.fail("provider_unavailable", { status: 503 });
    expect(await worker.runOnce()).toBe(true);
    advance(600_000);
    expect(await worker.runOnce()).toBe(false);
    const runs = await runsOf(conv);
    expect(runs.map((r) => [r.status, r.auto_attempt, r.owner_retry])).toEqual([
      ["failed", 0, false],
      ["failed", 1, false],
      ["failed", 2, false],
      ["failed", 0, true],
    ]);
    expect(await slot(owner, conv)).toMatchObject({ status: "failed", retryable: true });
  });

  it("never scheduled to start past 10 minutes after the original call", async () => {
    const { owner, conv } = await own("ar_window");
    const { worker } = instance({ ...app.deps.config, agents: { autoRetryDelaysMs: [20_000, AUTO_RETRY_WINDOW_MS] } });
    await say(owner, conv, "在吗");
    gateway.fail("provider_unavailable", { status: 500 });
    expect(await worker.runOnce()).toBe(true);
    advance(20_000);
    gateway.fail("provider_unavailable", { status: 500 });
    expect(await worker.runOnce()).toBe(true);
    expect((await runsOf(conv)).map((r) => r.status)).toEqual(["failed", "failed"]);
    expect(metrics("auto_retry_gave_up", '"why":"window"')).toBe(1);
  });

  it("never STARTED past 10 minutes either: a retry queued before an outage (claimed 11 min on) ends as the failure, with no call", async () => {
    const { owner, conv } = await own("ar_outage");
    const before = instance();
    await say(owner, conv, "在吗");
    gateway.fail("provider_unavailable", { status: 503 });
    expect(await before.worker.runOnce()).toBe(true);
    // The service is down for eleven minutes; a new process claims the retry when it is back.
    advance(11 * 60_000);
    const calls = gateway.calls.length;
    expect(await instance().worker.runOnce()).toBe(true);
    expect(gateway.calls.length).toBe(calls);
    expect((await runsOf(conv)).map((r) => [r.status, r.error, r.auto_attempt])).toEqual([
      ["failed", "provider_unavailable", 0],
      ["failed", "provider_unavailable", 1],
    ]);
    expect(await slot(owner, conv)).toMatchObject({ status: "failed", retryable: true });
    expect(metrics("auto_retry_gave_up", '"why":"window"')).toBe(1);
    expect(await instance().worker.runOnce()).toBe(false);
  });

  it("nor when kept waiting past 10 minutes by its owner's other running reply (one place at a time)", async () => {
    const { owner, conv } = await own("ar_kept");
    const other = await mustCreateAgent(app, owner, { model: FAST, persona: "简短。" });
    const one = { ...app.deps.config, agentMaxConcurrentRuns: 1 };
    const { port, worker } = instance(one);
    await say(owner, conv, "在吗");
    gateway.fail("provider_unavailable", { status: 503 });
    expect(await worker.runOnce()).toBe(true);
    // Another reply of the owner's is running (claimed here, its call not made) when the retry comes due.
    await say(owner, other.conversationId, "你也在吗");
    const busy = await port.claimNext();
    expect(busy?.conversationId).toBe(other.conversationId);
    advance(20_000);
    expect(await port.claimNext()).toBeNull();
    advance(10 * 60_000);
    await port.releaseRun(busy!.id);
    await db.query("update agent_runs set status = 'cancelled' where conversation_id = $1 and status = 'queued'", [other.conversationId]);
    const calls = gateway.calls.length;
    expect(await worker.runOnce()).toBe(true);
    expect(gateway.calls.length).toBe(calls);
    expect((await runsOf(conv)).at(-1)).toMatchObject({ status: "failed", error: "provider_unavailable", auto_attempt: 1 });
  });

  it("not for what does not clear by itself: a refused key or request, a model gone, no money, an answer with nothing in it, a persona block cut at the limit", async () => {
    const { owner, conv } = await own("ar_kinds");
    const { worker } = instance();
    const cases: Array<[string, () => void]> = [
      ["provider_rejected", () => void gateway.fail("provider_rejected", { status: 401 })],
      ["provider_unavailable", () => void gateway.fail("provider_unavailable", { status: 400 })],
      ["provider_unavailable", () => void gateway.fail("provider_unavailable", { status: 404 })],
      ["provider_unavailable", () => void gateway.fail("provider_unavailable", { afterText: "我想想" })],
      ["thinking_exhausted", () => void gateway.fail("thinking_exhausted", { usage: { inputTokens: 5, outputTokens: 5 } })],
      ["address_not_allowed", () => void gateway.fail("address_not_allowed")],
      ["provider_unavailable", () => void gateway.empty()],
      ["provider_unavailable", () => void gateway.reply("<af-persona>你是一个被截断的设定", { truncated: true })],
    ];
    for (const [error, script] of cases) {
      await say(owner, conv, `再问一次 ${error}`);
      script();
      expect(await worker.runOnce()).toBe(true);
      expect([error, (await runsOf(conv)).at(-1)!.status, (await runsOf(conv)).at(-1)!.error]).toEqual([error, "failed", error]);
      // Nothing queued to try it again (read from the rows: the fake clock is not moved, so no window can hide one).
      expect([error, (await runsOf(conv)).filter((r) => r.status === "queued")]).toEqual([error, []]);
    }
    // A group reply that only thought: the provider answered, with nothing for the group — not passing either.
    const w = await scene("ar_kinds_g");
    await say(w.mia, w.g, `${w.call} 想想看`);
    gateway.reply("", { reasoning: "我想想……" });
    expect(await worker.runOnce()).toBe(true);
    expect((await runsOf(w.g)).map((r) => [r.status, r.error])).toEqual([["failed", "provider_unavailable"]]);
    const poor = instance({ ...app.deps.config, freeDailyMicro: 0n });
    await say(owner, conv, "没钱了吗");
    expect(await poor.worker.runOnce()).toBe(true);
    expect((await runsOf(conv)).at(-1)).toMatchObject({ status: "failed", error: "no_quota" });
    const gone = instance({ ...app.deps.config, siteModels: app.deps.config.siteModels.filter((m) => m.id !== "fast") });
    await say(owner, conv, "模型呢");
    expect(await gone.worker.runOnce()).toBe(true);
    expect((await runsOf(conv)).at(-1)).toMatchObject({ status: "failed", error: "model_gone" });
    expect((await runsOf(conv)).filter((r) => r.status === "queued")).toEqual([]);
    expect(metrics("auto_retry_scheduled")).toBe(0);
  });

  it("paused, or stopped by its owner, while the retry waits: it ends, and nothing more is tried", async () => {
    const { owner, agent, conv } = await own("ar_pause");
    const { worker } = instance();
    await say(owner, conv, "在吗");
    gateway.fail("provider_unavailable", { status: 503 });
    expect(await worker.runOnce()).toBe(true);
    const retry = (await runsOf(conv))[1]!;
    expect((await api(app, owner, "POST", `/api/conversations/${conv}/runs/${retry.id}/stop`)).status).toBe(200);
    advance(200_000);
    expect(await worker.runOnce()).toBe(false);
    expect((await runsOf(conv)).map((r) => r.status)).toEqual(["failed", "stopped"]);

    await say(owner, conv, "再试");
    gateway.fail("provider_unavailable", { status: 503 });
    expect(await worker.runOnce()).toBe(true);
    expect((await api(app, owner, "POST", `/api/agents/${agent.id}/pause`)).status).toBe(200);
    advance(200_000);
    expect(await worker.runOnce()).toBe(false);
    expect((await runsOf(conv)).slice(2).map((r) => [r.status, r.error])).toEqual([
      ["failed", "provider_unavailable"],
      ["cancelled", "agent_paused"],
    ]);
  });

  it("a run its owner stops that nobody here works on is released as lost — and not tried again", async () => {
    const { owner, conv } = await own("ar_stopped");
    const elsewhere = instance();
    await say(owner, conv, "在吗");
    const lost = await elsewhere.port.claimNext();
    expect((await api(app, owner, "POST", `/api/conversations/${conv}/runs/${lost!.id}/stop`)).status).toBe(200);
    expect((await runsOf(conv)).map((r) => r.status)).toEqual(["failed"]);
    advance(200_000);
    expect(await elsewhere.worker.runOnce()).toBe(false);
    expect(metrics("auto_retry_scheduled")).toBe(0);
  });

  it("its owner's 重试 while a retry waits creates no second run (busy_run)", async () => {
    const { owner, conv } = await own("ar_press");
    const { worker } = instance();
    await say(owner, conv, "在吗");
    gateway.fail("provider_unavailable", { status: 503 });
    expect(await worker.runOnce()).toBe(true);
    expect(await api(app, owner, "POST", `/api/conversations/${conv}/runs/retry`)).toEqual({ status: 409, json: { error: "busy_run" } });
    expect((await runsOf(conv)).map((r) => r.status)).toEqual(["failed", "queued"]);
    advance(20_000);
    gateway.reply("在。");
    expect(await worker.runOnce()).toBe(true);
    expect((await runsOf(conv)).map((r) => r.status)).toEqual(["failed", "done"]);
  });

  it("answered meanwhile (a reply of the Agent's there from another run, after the original call): the retry ends quietly, with no call", async () => {
    const { owner, agent, conv } = await own("ar_answered");
    const { worker } = instance();
    await say(owner, conv, "在吗");
    gateway.fail("provider_unavailable", { status: 503 });
    expect(await worker.runOnce()).toBe(true);
    const other = await db.query<{ id: string }>(
      "insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, lane, caller_id, triggered_by) values ('reply', $1, $2, $3, 'done', 1, 'own', $3, 'human') returning id",
      [conv, agent.id, owner.id],
    );
    await db.query(
      `with c as (update conversations set seq = seq + 1 where id = $1 returning seq)
       insert into messages (conversation_id, seq, sender_id, kind, body, client_txn) select $1, c.seq, $2, 'text', '{"text":"在的。"}'::jsonb, $3 from c`,
      [conv, agent.id, other.rows[0]!.id],
    );
    advance(20_000);
    const calls = gateway.calls.length;
    expect(await worker.runOnce()).toBe(true);
    expect(gateway.calls.length).toBe(calls);
    expect((await runsOf(conv)).find((r) => r.auto_attempt === 1)).toMatchObject({ status: "cancelled", error: null });
  });
});

describe("it survives a restart, and is made and claimed once", () => {
  it("a retry scheduled before a restart is claimed by the next process once due; a run the service lost mid-call is tried again too", async () => {
    const { owner, conv } = await own("ar_restart");
    const before = instance();
    await say(owner, conv, "在吗");
    gateway.fail("provider_unavailable", { status: 503 });
    expect(await before.worker.runOnce()).toBe(true);
    const after = instance();
    advance(20_000);
    gateway.reply("在。");
    expect(await after.worker.runOnce()).toBe(true);
    expect((await runsOf(conv)).map((r) => r.status)).toEqual(["failed", "done"]);

    await say(owner, conv, "还在吗");
    expect(await after.port.claimNext()).not.toBeNull();
    expect(await recoverRuns(db, app.deps.config, app.log, now)).toBe(1);
    expect((await runsOf(conv)).slice(2).map((r) => [r.status, r.error, r.auto_attempt])).toEqual([
      ["failed", "provider_unavailable", 0],
      ["queued", null, 1],
    ]);
    expect(await slot(owner, conv)).toMatchObject({ status: "queued", retryable: false });
    advance(20_000);
    gateway.reply("还在。");
    expect(await instance().worker.runOnce()).toBe(true);
    expect((await runsOf(conv)).at(-1)).toMatchObject({ status: "done", auto_attempt: 1 });
  });

  it("the bound holds across restarts: a chain lost mid-call at its second retry gets no third", async () => {
    const { owner, conv } = await own("ar_lost2");
    await say(owner, conv, "在吗");
    for (let attempt = 0; attempt <= 2; attempt++) {
      const p = instance();
      advance(attempt === 0 ? 0 : attempt === 1 ? 20_000 : 120_000);
      expect(await p.port.claimNext()).not.toBeNull();
      expect(await recoverRuns(db, app.deps.config, app.log, now)).toBe(1);
    }
    advance(600_000);
    expect(await instance().worker.runOnce()).toBe(false);
    expect((await runsOf(conv)).map((r) => [r.status, r.auto_attempt])).toEqual([
      ["failed", 0],
      ["failed", 1],
      ["failed", 2],
    ]);
  });

  it("two processes: the failed run is released once (one retry row), and the due retry is claimed by one of them only", async () => {
    const { owner, conv } = await own("ar_two");
    const [a, b] = [instance(), instance()];
    await say(owner, conv, "在吗");
    const lost = await a.port.claimNext();
    const released = await Promise.all([a.port.releaseRun(lost!.id), b.port.releaseRun(lost!.id)]);
    expect(released.filter(Boolean)).toHaveLength(1);
    expect((await runsOf(conv)).map((r) => [r.status, r.auto_attempt])).toEqual([
      ["failed", 0],
      ["queued", 1],
    ]);
    advance(20_000);
    const claimed = await Promise.all([a.port.claimNext(), b.port.claimNext()]);
    expect(claimed.filter((c) => c !== null)).toHaveLength(1);
    await db.query("update agent_runs set status = 'cancelled' where conversation_id = $1 and status in ('queued', 'running')", [conv]);
  });
});

describe("runs the system never retries", () => {
  it("a reply nobody asked for (proactive): its passing failure stays its failure, nothing queued", async () => {
    const { owner, mia, agent, g } = await scene("ar_pro");
    await db.query("update agents set proactive = true where principal_id = $1", [agent.id]);
    const seq = await say(mia, g, "有人知道打印机的维修电话吗");
    await db.tx((t) => queueRun(t, { id: agent.id, ownerId: owner.id }, g, seq, "human", { id: null, lane: "proactive" }, [mia.id]));
    const { worker } = instance();
    gateway.fail("provider_unavailable", { status: 503 });
    expect(await worker.runOnce()).toBe(true);
    advance(200_000);
    expect(await worker.runOnce()).toBe(false);
    expect((await runsOf(g)).map((r) => [r.status, r.lane])).toEqual([["failed", "proactive"]]);
  });

  it("a new Agent's greeting: its passing failure is quiet and never retried", async () => {
    const owner = await signUp(app, "ar_greet");
    const agent = await mustCreateAgent(app, owner, { model: FAST });
    // (The harness queues no greeting: queued here as creation queues it.)
    await db.tx(async (t) => {
      const q = await queueRun(t, { id: agent.id, ownerId: owner.id }, agent.conversationId, 0, "human", { id: owner.id, lane: "own" }, [owner.id]);
      await t.query("update agent_runs set greets = true, call_seqs = '{}' where id = $1", [q.run.id]);
    });
    const { worker } = instance();
    gateway.fail("provider_unavailable", { status: 503 });
    expect(await worker.runOnce()).toBe(true);
    advance(200_000);
    expect(await worker.runOnce()).toBe(false);
    expect((await runsOf(agent.conversationId)).map((r) => [r.status, r.error, r.greets])).toEqual([["cancelled", null, true]]);
  });

  it("a greeting still queued gives way to its owner's message: that message gets an ordinary reply, whose passing failure is retried and shown as any", async () => {
    const owner = await signUp(app, "ar_greet2");
    const agent = await mustCreateAgent(app, owner, { model: FAST });
    const conv = agent.conversationId as string;
    await db.tx(async (t) => {
      const q = await queueRun(t, { id: agent.id, ownerId: owner.id }, conv, 0, "human", { id: owner.id, lane: "own" }, [owner.id]);
      await t.query("update agent_runs set greets = true, call_seqs = '{}' where id = $1", [q.run.id]);
    });
    await say(owner, conv, "你好");
    expect((await runsOf(conv)).map((r) => [r.status, r.greets])).toEqual([
      ["cancelled", true],
      ["queued", false],
    ]);
    const { worker } = instance();
    for (const _ of [0, 1, 2]) {
      gateway.fail("provider_unavailable", { status: 503 });
      expect(await worker.runOnce()).toBe(true);
      advance(130_000);
    }
    expect(await slot(owner, conv)).toMatchObject({ status: "failed", error: "provider_unavailable", retryable: true });
    expect((await runsOf(conv)).slice(1).map((r) => r.auto_attempt)).toEqual([0, 1, 2]);
  });
});

describe("in a group", () => {
  /** What member `who`'s socket was told of the Agent's reply in `g`, shapes only: no ids, no timing. */
  const shapes = (events: Push[], g: string, agentId: string) =>
    events
      .filter((e) => e.conversationId === g || e.message?.conversationId === g)
      .flatMap((e) => (e.type === "run" ? [`run:${e.state ?? "-"}${e.activity === undefined ? "" : `:${e.activity}`}`] : e.type === "message" ? [`message:${e.message.senderId === agentId ? "agent" : "person"}`] : []));

  it("a member's frames are the same in number and order as for an answer at the first try; the retry keeps the member's lane and call", async () => {
    const first = await scene("ar_ga");
    const s1 = await connect(app, first.mia);
    const w1 = instance();
    await say(first.mia, first.g, `${first.call} 打印机的维修电话？`);
    gateway.reply("12345。");
    expect(await w1.worker.runOnce()).toBe(true);
    await app.realtime.idle();
    const atOnce = shapes(s1.events, first.g, first.agent.id);
    expect(atOnce).toContain("message:agent");
    expect(atOnce).toContain("run:replying");

    const second = await scene("ar_gb");
    const s2 = await connect(app, second.mia);
    const o2 = await connect(app, second.owner);
    const w2 = instance();
    const asked = await say(second.mia, second.g, `${second.call} 打印机的维修电话？`);
    gateway.fail("provider_unavailable", { status: 503 });
    expect(await w2.worker.runOnce()).toBe(true);
    const [failed, retry] = await runsOf(second.g);
    expect(retry).toMatchObject({ status: "queued", lane: "others", auto_attempt: 1, calls: [String(asked)] });
    expect(failed!.lane).toBe("others");
    expect((await api(app, second.mia, "GET", `/api/conversations/${second.g}/runs`)).json.runs).toEqual([{ agentId: second.agent.id, state: "replying" }]);
    advance(20_000);
    gateway.reply("12345。");
    expect(await w2.worker.runOnce()).toBe(true);
    await app.realtime.idle();
    expect(shapes(s2.events, second.g, second.agent.id)).toEqual(atOnce);
    expect(o2.events.filter((e: Push) => e.type === "run" && e.run?.status === "failed")).toEqual([]);
  });

  it("a retry after an acknowledgement and a tool round posts no second acknowledgement, and answers once", async () => {
    const w = await scene("ar_ack");
    const { worker } = instance(app.deps.config, true);
    await say(w.mia, w.g, `${w.call} 打印机的维修电话？`);
    gateway.callTools([{ name: SEARCH_MESSAGES, input: { query: "维修电话" } }], { text: "我查一下。" }).fail("provider_unavailable", { status: 503 });
    expect(await worker.runOnce()).toBe(true);
    expect((await runsOf(w.g)).map((r) => [r.status, r.auto_attempt])).toEqual([
      ["failed", 0],
      ["queued", 1],
    ]);
    advance(20_000);
    gateway.callTools([{ name: SEARCH_MESSAGES, input: { query: "维修电话" } }], { text: "我再查一下。" }).reply("群里没人说过。");
    expect(await worker.runOnce()).toBe(true);
    // The retry's own words before its search are not posted as a second acknowledgement: they stay its answer's.
    expect(await agentSaid(w.owner, w.g, w.agent.id)).toEqual(["我查一下。", "我再查一下。\n\n群里没人说过。"]);
    const acks = await db.query("select 1 from messages where conversation_id = $1 and sender_id = $2 and client_txn like 'ack:%'", [w.g, w.agent.id]);
    expect(acks.rowCount).toBe(1);
  });
});
