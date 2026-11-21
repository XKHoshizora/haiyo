import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentPort, recoverRuns, type DbAgentPort } from "../src/agents/port-impl.ts";
import { AUTO_RETRY_WINDOW_MS, transientFailure } from "../src/agents/runs.ts";
import { createAgentWorker, type AgentWorker } from "../src/agents/runtime/worker.ts";
import type { Config } from "../src/config.ts";
import { api, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { closeAllSockets, connect, type Push } from "./helpers/ws.ts";

/**
 * A reply that failed for a passing reason is tried again by the system (README "Agents and runs", Automatic retry;
 * principle P1: nobody waits for the owner): at most twice per original call, 20 s and then 2 min after the failure
 * (`AGENTS.autoRetryDelaysMs`), never later than 10 min after the original call; an ordinary queued run through ordinary
 * admission, found from stored state (`not_before`) by the worker's own claim, so it survives a restart and is claimed
 * once. While it is pending its owner's slot reads queued — never an error that then goes — and the other members of a
 * group see the same frames as for an answer at the first try.
 */

const gateway = scriptedGateway();
const lines: string[] = [];
const { app, db } = useApp({
  env: { ...SITE_ENV, AGENTS: JSON.stringify({ autoRetryDelaysMs: [20_000, 120_000] }) },
  models: gateway,
  agentWorker: false,
  logStream: { write: (line) => void lines.push(line) },
});
const FAST = { source: "site", id: "fast" } as const;

/** The fake clock the ports here schedule and claim retries by. */
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

/** A port and a worker of this "process" (a restart, or another instance, is another pair). */
function instance(config: Config = app.deps.config): { port: DbAgentPort; worker: AgentWorker } {
  const { db: pool, blobs, conversations, reads } = app.deps;
  const port = createAgentPort({ db: pool, config, blobs, realtime: app.realtime, conversations, reads, log: app.log, now });
  const worker = createAgentWorker({ port, models: gateway, runTimeoutMs: config.agentRunTimeoutMs, maxRunsInFlight: 1, background: false, log: app.log });
  return { port, worker };
}
const metrics = (name: string) => lines.filter((l) => l.includes(`"metric":"${name}"`)).length;
let txn = 0;
const say = async (who: Actor, conv: string, text: string) => {
  const r = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `ar${++txn}` });
  expect(r.status).toBe(201);
  return r.json.message.seq as number;
};
const runsOf = async (conv: string) =>
  (
    await db.query<{ id: string; status: string; error: string | null; auto_attempt: number; retry_of: string | null; lane: string; covers: string; calls: string[] | null }>(
      "select id, status, error, auto_attempt, retry_of, lane, covers_seq::text as covers, call_seqs::text[] as calls from agent_runs where conversation_id = $1 order by created_at, id",
      [conv],
    )
  ).rows;
const slot = async (owner: Actor, conv: string) => (await api(app, owner, "GET", `/api/conversations/${conv}/run`)).json.run;
async function own(name: string) {
  const owner = await signUp(app, name);
  const agent = await mustCreateAgent(app, owner, { model: FAST, persona: "简短地回答。" });
  return { owner, agent, conv: agent.conversationId as string };
}

describe("which failures are passing", () => {
  it("the model service unavailable — its 5xx, 408, 429, no status (a network failure, a timeout, a lost process) — and nothing else", () => {
    for (const s of [500, 502, 503, 504, 408, 429, undefined]) expect([s, transientFailure({ status: "failed", error: "provider_unavailable", ...(s ? { upstreamStatus: s } : {}) })]).toEqual([s, true]);
    for (const s of [400, 401, 403, 404, 405, 413, 422]) expect([s, transientFailure({ status: "failed", error: "provider_unavailable", upstreamStatus: s })]).toEqual([s, false]);
    for (const error of ["provider_rejected", "address_not_allowed", "no_quota", "busy", "context_too_small", "rate_limited", "thinking_exhausted", "model_gone"]) {
      expect([error, transientFailure({ status: "failed", error })]).toEqual([error, false]);
    }
    expect(transientFailure({ status: "stopped" })).toBe(false);
    expect(transientFailure({ status: "cancelled", error: "agent_paused" })).toBe(false);
  });
});

describe("in the Agent's own conversation", () => {
  it("a 503: no failure is shown; the retry, queued, is claimed only once its 20 s are up (fake clock), answers, and each attempt is charged", async () => {
    const { owner, conv } = await own("ar_own");
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
    // Its owner was never pushed the failure: running, then the queued retry.
    expect(s.events.filter((e: Push) => e.type === "run" && e.run.status === "failed")).toEqual([]);
    expect(metrics("auto_retry_scheduled")).toBe(1);

    advance(19_000);
    expect(await worker.runOnce()).toBe(false);
    advance(1_000);
    gateway.reply("晴，二十度。");
    expect(await worker.runOnce()).toBe(true);
    expect((await runsOf(conv)).map((r) => r.status)).toEqual(["failed", "done"]);
    expect(metrics("auto_retry_ran")).toBe(1);
    const said = (await api(app, owner, "GET", `/api/conversations/${conv}/messages`)).json.messages.map((m: { text: string }) => m.text);
    expect(said).toEqual(["今天天气怎么样？", "晴，二十度。"]);
    expect((await db.query("select 1 from usage_records u join agent_runs r on r.id = u.run_id where r.conversation_id = $1", [conv])).rowCount).toBe(2);
  });

  it("three passing failures: two retries (20 s, then 2 min), then the failure is shown with 重试, counted as given up; 重试 then works", async () => {
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
    expect([metrics("auto_retry_scheduled"), metrics("auto_retry_ran"), metrics("auto_retry_gave_up")]).toEqual([2, 2, 1]);
    expect((await api(app, owner, "POST", `/api/conversations/${conv}/runs/retry`)).status).toBe(201);
    gateway.reply("在。");
    expect(await worker.runOnce()).toBe(true);
    expect((await runsOf(conv)).at(-1)).toMatchObject({ status: "done", auto_attempt: 0 });
  });

  it("never later than 10 minutes after the original call: a retry that would start past it is not made", async () => {
    const { owner, conv } = await own("ar_window");
    const config = { ...app.deps.config, agents: { autoRetryDelaysMs: [20_000, AUTO_RETRY_WINDOW_MS] } };
    const { worker } = instance(config);
    await say(owner, conv, "在吗");
    gateway.fail("provider_unavailable", { status: 500 });
    expect(await worker.runOnce()).toBe(true);
    advance(20_000);
    gateway.fail("provider_unavailable", { status: 500 });
    expect(await worker.runOnce()).toBe(true);
    expect((await runsOf(conv)).map((r) => r.status)).toEqual(["failed", "failed"]);
    expect(lines.filter((l) => l.includes('"metric":"auto_retry_gave_up"') && l.includes('"why":"window"'))).toHaveLength(1);
  });

  it("not for what does not clear by itself: a refused key, a refused request, a model gone, no money — each shown at once, with nothing queued", async () => {
    const { owner, conv } = await own("ar_kinds");
    const { worker } = instance();
    const cases: Array<[string, () => void]> = [
      ["provider_rejected", () => void gateway.fail("provider_rejected", { status: 401 })],
      ["provider_unavailable", () => void gateway.fail("provider_unavailable", { status: 400 })],
      ["provider_unavailable", () => void gateway.fail("provider_unavailable", { status: 404 })],
      ["thinking_exhausted", () => void gateway.fail("thinking_exhausted", { usage: { inputTokens: 5, outputTokens: 5 } })],
      ["address_not_allowed", () => void gateway.fail("address_not_allowed")],
    ];
    for (const [error, script] of cases) {
      await say(owner, conv, `再问一次 ${error}`);
      script();
      expect(await worker.runOnce()).toBe(true);
      expect([error, (await runsOf(conv)).at(-1)!.status, (await runsOf(conv)).at(-1)!.error]).toEqual([error, "failed", error]);
      expect(await worker.runOnce()).toBe(false);
    }
    // No money: the free allowance of a site whose daily allowance is nothing.
    const poor = instance({ ...app.deps.config, freeDailyMicro: 0n });
    await say(owner, conv, "没钱了吗");
    expect(await poor.worker.runOnce()).toBe(true);
    expect((await runsOf(conv)).at(-1)).toMatchObject({ status: "failed", error: "no_quota" });
    // Its model gone (the site no longer offers it).
    const gone = instance({ ...app.deps.config, siteModels: app.deps.config.siteModels.filter((m) => m.id !== "fast") });
    await say(owner, conv, "模型呢");
    expect(await gone.worker.runOnce()).toBe(true);
    expect((await runsOf(conv)).at(-1)).toMatchObject({ status: "failed", error: "model_gone" });
    expect(await worker.runOnce()).toBe(false);
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
    // Another run's reply (its row, a message naming it): written as another instance would have.
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
    const retry = (await runsOf(conv)).find((r) => r.auto_attempt === 1)!;
    expect(retry).toMatchObject({ status: "cancelled", error: null });
  });
});

describe("it survives a restart, and is made and claimed once", () => {
  it("a retry scheduled before a restart is claimed by the next process once due; a run the service lost mid-call is tried again too", async () => {
    const { owner, conv } = await own("ar_restart");
    const before = instance();
    await say(owner, conv, "在吗");
    gateway.fail("provider_unavailable", { status: 503 });
    expect(await before.worker.runOnce()).toBe(true);
    // A new process: its own port and worker, nothing in memory from the last one.
    const after = instance();
    advance(20_000);
    gateway.reply("在。");
    expect(await after.worker.runOnce()).toBe(true);
    expect((await runsOf(conv)).map((r) => r.status)).toEqual(["failed", "done"]);

    // A run left running when the process died: start-up recovery records it failed and queues its retry.
    await say(owner, conv, "还在吗");
    const lost = await after.port.claimNext();
    expect(lost).not.toBeNull();
    expect(await recoverRuns(db, app.deps.config, app.log, now)).toBe(1);
    const runs = await runsOf(conv);
    expect(runs.slice(2).map((r) => [r.status, r.error, r.auto_attempt])).toEqual([
      ["failed", "provider_unavailable", 0],
      ["queued", null, 1],
    ]);
    expect(await slot(owner, conv)).toMatchObject({ status: "queued", retryable: false });
    advance(20_000);
    gateway.reply("还在。");
    expect(await instance().worker.runOnce()).toBe(true);
    expect((await runsOf(conv)).at(-1)).toMatchObject({ status: "done", auto_attempt: 1 });
  });

  it("two processes: the failed run is released once (one retry row), and the due retry is claimed by one of them only", async () => {
    const { owner, conv } = await own("ar_two");
    const [a, b] = [instance(), instance()];
    await say(owner, conv, "在吗");
    const lost = await a.port.claimNext();
    expect(lost).not.toBeNull();
    const released = await Promise.all([a.port.releaseRun(lost!.id), b.port.releaseRun(lost!.id)]);
    expect(released.filter(Boolean)).toHaveLength(1);
    expect((await runsOf(conv)).map((r) => [r.status, r.auto_attempt])).toEqual([
      ["failed", 0],
      ["queued", 1],
    ]);
    advance(20_000);
    const claimed = await Promise.all([a.port.claimNext(), b.port.claimNext()]);
    expect(claimed.filter((c) => c !== null)).toHaveLength(1);
    const mine = claimed.find((c) => c !== null)!;
    await (claimed[0] ? a : b).port.releaseRun(mine.id);
    // (Released again as lost: its second retry is queued — the chain goes on by the same rule.)
    expect((await runsOf(conv)).map((r) => r.auto_attempt)).toEqual([0, 1, 2]);
    await db.query("update agent_runs set status = 'cancelled' where conversation_id = $1 and status = 'queued'", [conv]);
  });
});

describe("in a group", () => {
  /** What member `who`'s socket was told of the Agent's reply in `g`, shapes only: no ids, no timing. */
  const shapes = (events: Push[], g: string, agentId: string) =>
    events
      .filter((e) => e.conversationId === g || e.message?.conversationId === g)
      .flatMap((e) => (e.type === "run" ? [`run:${e.state ?? "-"}${e.activity === undefined ? "" : `:${e.activity}`}`] : e.type === "message" ? [`message:${e.message.senderId === agentId ? "agent" : "person"}`] : []));

  async function scene(name: string) {
    const owner = await signUp(app, name);
    const mia = await signUp(app, `${name}_m`);
    const agent = await mustCreateAgent(app, owner, { handle: `${name}_bot`, model: FAST, persona: "简短。" });
    const g = await group(app, owner, "打印机群", [mia, await signUp(app, `${name}_n`)]);
    expect((await api(app, owner, "POST", `/api/conversations/${g}/members`, { principalId: agent.id })).status).toBe(201);
    return { owner, mia, agent, g };
  }

  it("a member's frames are the same in number and order as for an answer at the first try; the retry keeps the member's lane and call", async () => {
    const first = await scene("ar_ga");
    const s1 = await connect(app, first.mia);
    const w1 = instance();
    await say(first.mia, first.g, `@${first.owner.handle}.ar_ga_bot 打印机的维修电话？`);
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
    const asked = await say(second.mia, second.g, `@${second.owner.handle}.ar_gb_bot 打印机的维修电话？`);
    gateway.fail("provider_unavailable", { status: 503 });
    expect(await w2.worker.runOnce()).toBe(true);
    const [failed, retry] = await runsOf(second.g);
    expect(retry).toMatchObject({ status: "queued", lane: "others", auto_attempt: 1, calls: [String(asked)] });
    expect(failed!.lane).toBe("others");
    // Members see it replying while the retry waits; its owner is told it is queued, never that it failed.
    expect((await api(app, second.mia, "GET", `/api/conversations/${second.g}/runs`)).json.runs).toEqual([{ agentId: second.agent.id, state: "replying" }]);
    advance(20_000);
    gateway.reply("12345。");
    expect(await w2.worker.runOnce()).toBe(true);
    await app.realtime.idle();
    expect(shapes(s2.events, second.g, second.agent.id)).toEqual(atOnce);
    expect(o2.events.filter((e: Push) => e.type === "run" && e.run?.status === "failed")).toEqual([]);
  });
});
