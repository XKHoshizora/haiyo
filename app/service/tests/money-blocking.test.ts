import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentPort, type DbAgentPort, type Toolbox } from "../src/agents/port-impl.ts";
import { isRunEnd, NOTHING, type RunEnd, type ToolOutcome } from "../src/agents/runtime/port.ts";
import { createAgentWorker, type AgentWorker } from "../src/agents/runtime/worker.ts";
import type { Config } from "../src/config.ts";
import { AppError } from "../src/errors.ts";
import { admitRun, HeldBack, raiseHold } from "../src/metering/admit.ts";
import { stopRun } from "../src/agents/runs.ts";
import type { ModelCall, ModelEvent, ModelGateway, ToolCall, ToolSpec } from "../src/models/gateway.ts";
import { api, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { ESTIMATE, grant, MAX_COST, METER_ENV, meteredAgent, paidReply, runningRun } from "./helpers/metering.ts";
import { scriptedGateway, type ScriptedGateway } from "./helpers/models.ts";
import { providerBody } from "./helpers/providers.ts";
import { closeAllSockets, connect } from "./helpers/ws.ts";
import { holdTokens, TOOL_PREAMBLE_TOKENS } from "../src/metering/tokens.ts";

/**
 * Money that does not block (Task H; README "Metering", Admission, Extension, The debt bound): a reply starts while
 * something is left of its source, however large its hold; what the owner's other running calls hold only makes it wait
 * (queued, then claimed once one of them has ended), unless it would be the only call holding against that source; a
 * reply that has started is never refused for money — short of it, its next call is its last; so what one owner's calls
 * can take below zero is one call that started alone, and one last call (or a draft) for each other call open beside it.
 * On the real port and database, the meter models (METER_ENV: 100 micro-points an input token, 1 000 an output token, at
 * most 1 000 output tokens; 3 free points a day) and `hold5`, a paid model whose every call holds a little over 5 points
 * (5 000 output tokens at 1 000 each, its input at 1 a token).
 */

const HOLD5 = {
  id: "hold5",
  label: "Hold five",
  tier: "paid",
  protocol: "openai_chat",
  baseUrl: "https://api.example.test/v1",
  apiKeyEnv: "METER_UPSTREAM_KEY",
  model: "hold5-1",
  inputMicroPerToken: 1,
  outputMicroPerToken: 1000,
  maxOutputTokens: 5000,
  contextTokens: 100000,
  vision: false,
  pdf: false,
  reasoning: [],
};
/** The acceptance's large-context free model (review of fix round 1, Part 2): 200 000 tokens, 4 096 out, 70 / 350 µ a token. */
const LUNA = { ...HOLD5, id: "luna", label: "Luna", tier: "free", model: "luna-1", inputMicroPerToken: 70, outputMicroPerToken: 350, maxOutputTokens: 4096, contextTokens: 200000 };
const ENV = {
  ...METER_ENV,
  SITE_MODELS: JSON.stringify([...JSON.parse(METER_ENV.SITE_MODELS), HOLD5, LUNA]),
  AGENT_MAX_CONCURRENT_RUNS: "8",
  AGENT_MAX_CONCURRENT_OTHERS_RUNS: "8",
};

const lines: string[] = [];
const { app, db } = useApp({ env: ENV, agentWorker: false, logStream: { write: (line) => void lines.push(line) } });
/** The metric lines named `name` logged since the test began (`lines` is emptied before each). */
const metric = (name: string) => lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((e) => e.metric === name);

afterEach(async () => {
  await closeAllSockets();
  lines.length = 0;
});

const POINT = 1_000_000n;
const FIVE = { source: "site", id: "hold5" } as const;
const PAID = { source: "site", id: "meter_paid" } as const;
const FREE = { source: "site", id: "meter_free" } as const;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The most one call can cost on a meter model: its whole context (less its output) and its whole output, and what providers add around tool definitions. */
const FULL_CALL = (100_000n - 1000n + 400n) * 100n + 1000n * 1000n;
const U = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens });

const SEARCH: ToolSpec = {
  name: "search",
  description: "Search this conversation's messages.",
  parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
};
/** A toolbox that offers the search tool, which finds nothing at once. */
const toolbox = (): Toolbox => ({
  offer: () => ({ tools: [SEARCH], perTool: { search: 1000 }, kinds: { search: "search" } }),
  run: async (): Promise<ToolOutcome> => ({ output: { hits: [] }, activity: "search" }),
});

/** A port of its own (with `box`) and a worker on it; by hand unless `background`. */
function workerWith(gateway: ModelGateway, { box = null, config = app.deps.config, background = false }: { box?: Toolbox | null; config?: Config; background?: boolean } = {}) {
  const { db: pool, blobs, conversations, reads } = app.deps;
  const port: DbAgentPort = createAgentPort({ db: pool, config, blobs, realtime: app.realtime, conversations, reads, log: app.log, toolbox: box });
  const worker: AgentWorker = createAgentWorker({ port, models: gateway, runTimeoutMs: config.agentRunTimeoutMs, maxRunsInFlight: 16, background, log: app.log, tools: config.tools });
  if (background) port.onQueued(() => worker.wake());
  return { port, worker };
}

const withTools = (over: Partial<Config["tools"]>): Config => ({ ...app.deps.config, tools: { ...app.deps.config.tools, ...over } });

/**
 * A model that calls the search tool — a new query each time, saying a few words first — until it is made to answer (the
 * last call: `toolChoice` `none`), every call reporting `usage`. Stateless: any number of replies may use it at once.
 */
function searcher(usage: { inputTokens: number; outputTokens: number }): ModelGateway & { calls: ModelCall[] } {
  let n = 0;
  const calls: ModelCall[] = [];
  return {
    calls,
    async *stream(call): AsyncGenerator<ModelEvent> {
      calls.push(call);
      if (call.toolChoice === "none" || !call.tools || call.tools.length === 0) {
        yield { type: "text", delta: "就这些。" };
        yield { type: "finish", usage, truncated: false, toolCalls: [], assistant: { text: "就这些。" } };
        return;
      }
      const toolCall: ToolCall = { id: `s${++n}`, name: "search", input: { query: `第${n}次` } };
      yield { type: "text", delta: "查一下。" };
      yield { type: "tool_call", call: toolCall };
      yield { type: "finish", usage, truncated: false, toolCalls: [toolCall], assistant: { text: "查一下。", calls: [toolCall] } };
    },
    async listModels() {
      return [];
    },
  };
}

let txn = 0;
const say = async (who: Actor, conv: string, text: string) => {
  const sent = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `mb${++txn}` });
  expect(sent.status).toBe(201);
};

async function agentOf(owner: Actor, model: typeof FIVE | typeof PAID | typeof FREE | { source: "provider"; providerId: string; model: string }, name: string) {
  const agent = await mustCreateAgent(app, owner, { model, name, persona: `简短地回答。${name}` });
  return { id: agent.id as string, conv: agent.conversationId as string };
}

type RunRow = { id: string; status: string; error: string | null; hold: string; held_back_by: string[] | null; held_back_on: string | null; charge_to: string | null; source: string | null };
const runIn = async (conv: string): Promise<RunRow> =>
  (
    await db.query<RunRow>(
      "select id, status, error, hold_micro::text as hold, held_back_by, held_back_on, charge_to, source from agent_runs where conversation_id = $1 and purpose = 'reply' order by created_at desc limit 1",
      [conv],
    )
  ).rows[0]!;
/** Routes each call to the gateway of the Agent whose name its system text carries (each Agent's persona names it). */
function router(routes: Map<string, ModelGateway>): ModelGateway {
  return {
    stream(call) {
      for (const [name, gateway] of routes) if (call.system.includes(`简短地回答。${name}`)) return gateway.stream(call);
      throw new Error("router: no gateway for this call");
    },
    async listModels() {
      return [];
    },
  };
}
/**
 * The most of the owner's replies admitted at once: over their admitted runs (a model recorded), from the claim they were
 * admitted at to their end.
 */
async function mostAtOnce(ownerId: string): Promise<number> {
  const { rows } = await db.query<{ s: Date; f: Date }>(
    "select started_at as s, finished_at as f from agent_runs where owner_id = $1 and purpose = 'reply' and source is not null",
    [ownerId],
  );
  const events = rows.flatMap((r) => [
    { at: r.s.getTime(), d: 1 },
    { at: r.f.getTime(), d: -1 },
  ]);
  events.sort((a, b) => a.at - b.at || a.d - b.d);
  let open = 0;
  let most = 0;
  for (const e of events) {
    open += e.d;
    most = Math.max(most, open);
  }
  return most;
}
const holdOf = async (runId: string) => BigInt((await db.query<{ hold: string }>("select hold_micro::text as hold from agent_runs where id = $1", [runId])).rows[0]!.hold);
const balanceOf = async (ownerId: string) =>
  BigInt((await db.query<{ b: string }>("select balance_micro::text as b from accounts where principal_id = $1", [ownerId])).rows[0]!.b);
const recordOf = async (runId: string) =>
  (
    await db.query<{ cost: string; balance: string; free: string; forgiven: string }>(
      "select cost_micro::text as cost, balance_micro::text as balance, free_micro::text as free, forgiven_micro::text as forgiven from usage_records where run_id = $1",
      [runId],
    )
  ).rows;
/** Every balance equals its ledger, no hold is left, nothing is left queued or running. */
async function expectSettledBooks(ownerId: string): Promise<void> {
  const ledger = await db.query<{ sum: string }>("select coalesce(sum(delta_micro), 0)::text as sum from balance_ledger where owner_id = $1", [ownerId]);
  expect(BigInt(ledger.rows[0]!.sum)).toBe(await balanceOf(ownerId));
  expect((await db.query("select id from agent_runs where owner_id = $1 and (hold_micro > 0 or status in ('queued', 'running'))", [ownerId])).rows).toEqual([]);
}

describe("a reply starts while something is left, however large its hold, and ends charged what it cost", () => {
  it("balance 3, a reply that holds 5: it starts and finishes, charged what it cost; at 4 the balance ends at −1 and the next reply is refused; a grant of 10 leaves 9", async () => {
    const gateway = scriptedGateway();
    const call = gateway.hang();
    const { worker } = workerWith(gateway);
    const owner = await signUp(app, "three");
    const a = await agentOf(owner, FIVE, "Tri");
    await grant(db, owner.id, 3n * POINT);
    await say(owner, a.conv, "你好");
    const running = worker.runOnce();
    await call.reached;
    const run = await runIn(a.conv);
    expect(run).toMatchObject({ status: "running", charge_to: "balance" });
    expect(BigInt(run.hold)).toBeGreaterThan(5n * POINT);
    call.release("好。", { usage: U(0, 4000) });
    await running;
    expect(await runIn(a.conv)).toMatchObject({ status: "done", hold: "0" });
    expect(await recordOf(run.id)).toEqual([{ cost: "4000000", balance: "4000000", free: "0", forgiven: "0" }]);
    expect(await balanceOf(owner.id)).toBe(-1n * POINT);

    await say(owner, a.conv, "再说一句");
    await worker.runOnce();
    expect(await runIn(a.conv)).toMatchObject({ status: "failed", error: "no_quota" });
    await grant(db, owner.id, 10n * POINT);
    expect(await balanceOf(owner.id)).toBe(9n * POINT);
    expect(gateway.pending()).toBe(0);
    await expectSettledBooks(owner.id);
  });
});

describe("the holds of one owner's replies are capped together by queueing, not refusing", () => {
  it("two Agents called at once, 6 points left and a hold of 5 each: the second waits, queued, not refused, and starts when the first has ended; with 20 both run at once", async () => {
    const gateway = scriptedGateway();
    const first = gateway.hang();
    gateway.reply("二。", { usage: U(0, 1000) });
    const { worker } = workerWith(gateway);
    const owner = await signUp(app, "sixer");
    const [a, b] = [await agentOf(owner, FIVE, "Ann"), await agentOf(owner, FIVE, "Bob")];
    await grant(db, owner.id, 6n * POINT);
    await say(owner, a.conv, "你好");
    await say(owner, b.conv, "你好");

    const running = worker.runOnce();
    await first.reached;
    const runA = await runIn(a.conv);
    // The second is claimed, read, then held back at admission: back to queued, nothing held, behind the first.
    expect(await worker.runOnce()).toBe(true);
    const held = await runIn(b.conv);
    expect(held).toMatchObject({ status: "queued", error: null, hold: "0", charge_to: null, held_back_by: [runA.id] });
    // Its owner is told it is queued, as any queued reply: not failed, not `no_quota`.
    expect((await api(app, owner, "GET", `/api/conversations/${b.conv}/run`)).json.run).toMatchObject({ id: held.id, status: "queued" });
    expect(gateway.calls).toHaveLength(1);
    // Nothing more is claimed while the first runs.
    expect(await worker.runOnce()).toBe(false);

    first.release("一。", { usage: U(0, 1000) });
    await running;
    expect(await worker.runOnce()).toBe(true);
    expect(await runIn(b.conv)).toMatchObject({ id: held.id, status: "done", held_back_by: null });
    expect(gateway.calls).toHaveLength(2);
    expect(await balanceOf(owner.id)).toBe(4n * POINT);
    await expectSettledBooks(owner.id);

    // 20 points: both holds fit, both run at once.
    const both = scriptedGateway();
    const [one, two] = [both.hang(), both.hang()];
    const second = workerWith(both);
    const rich = await signUp(app, "twenty");
    const [c, d] = [await agentOf(rich, FIVE, "Cid"), await agentOf(rich, FIVE, "Dee")];
    await grant(db, rich.id, 20n * POINT);
    await say(rich, c.conv, "你好");
    await say(rich, d.conv, "你好");
    const runs = [second.worker.runOnce(), second.worker.runOnce()];
    await Promise.all([one.reached, two.reached]);
    expect([(await runIn(c.conv)).status, (await runIn(d.conv)).status]).toEqual(["running", "running"]);
    one.release("一。", { usage: U(0, 1000) });
    two.release("二。", { usage: U(0, 1000) });
    await Promise.all(runs);
    expect(await balanceOf(rich.id)).toBe(18n * POINT);
    await expectSettledBooks(rich.id);
  });

  it("a held-back reply is woken by the end of the reply it waited for, not by the worker's poll (twice: a poll every 2 s could pass once by chance)", async () => {
    for (const round of [1, 2]) {
    const gateway = scriptedGateway();
    const first = gateway.hang();
    gateway.reply("二。", { usage: U(0, 1000) });
    const { worker } = workerWith(gateway, { background: true });
    const owner = await signUp(app, `woken${round}`);
    const [a, b] = [await agentOf(owner, FIVE, "Ann"), await agentOf(owner, FIVE, "Bob")];
    await grant(db, owner.id, 6n * POINT);
    await say(owner, a.conv, "你好");
    worker.start();
    try {
      // Ann's reply admitted and at its call before Bob's is sent: two replies claimed in one go are admitted in whichever
      // order their transactions reach the owner's account (nothing promises the older one first; the mark orders them
      // only once one was held back), so the order this test is about is made, not hoped for.
      await first.reached;
      await say(owner, b.conv, "你好");
      worker.wake();
      await vi.waitFor(async () => expect(await runIn(b.conv)).toMatchObject({ status: "queued", held_back_by: [(await runIn(a.conv)).id] }), { timeout: 5_000 });
      first.release("一。", { usage: U(0, 1000) });
      await vi.waitFor(async () => expect(await runIn(b.conv)).toMatchObject({ status: "done" }), { timeout: 5_000 });
      const { rows } = await db.query<{ gap: number }>(
        `select (extract(epoch from (b.started_at - a.finished_at)) * 1000)::int as gap
           from agent_runs a, agent_runs b where a.id = $1 and b.id = $2`,
        [(await runIn(a.conv)).id, (await runIn(b.conv)).id],
      );
      // The worker polls every 2 s; the end of the first wakes it at once.
      expect(rows[0]!.gap).toBeLessThan(200);
    } finally {
      await worker.stop();
    }
    }
  });

  it("first come, first served per owner: a younger reply of the same owner waits behind a held-back one; another owner's does not", async () => {
    const gateway = scriptedGateway();
    const first = gateway.hang();
    gateway.reply("别人的。", { usage: U(0, 1000) }).reply("二。", { usage: U(0, 1000) }).reply("三。", { usage: U(0, 1000) });
    const { worker } = workerWith(gateway);
    const owner = await signUp(app, "fifo");
    const [a, b, c] = [await agentOf(owner, FIVE, "Ann"), await agentOf(owner, FIVE, "Bob"), await agentOf(owner, PAID, "Cal")];
    const other = await signUp(app, "fifoother");
    const o = await agentOf(other, FIVE, "Oz");
    // 7 points: two holds of 5 do not fit, Ann's and Cal's (about one point) do.
    await grant(db, owner.id, 7n * POINT);
    await grant(db, other.id, 6n * POINT);
    await say(owner, a.conv, "你好");
    await say(owner, b.conv, "你好");
    const running = worker.runOnce();
    await first.reached;
    expect(await worker.runOnce()).toBe(true);
    expect(await runIn(b.conv)).toMatchObject({ status: "queued" });
    // Cal's hold (about a point) would fit beside Ann's; it still waits behind Bob. Oz, another owner's, does not.
    await say(owner, c.conv, "你好");
    await say(other, o.conv, "你好");
    expect(await worker.runOnce()).toBe(true);
    expect(await runIn(o.conv)).toMatchObject({ status: "done" });
    expect(await runIn(c.conv)).toMatchObject({ status: "queued", held_back_by: null });
    expect(await worker.runOnce()).toBe(false);

    first.release("一。", { usage: U(0, 1000) });
    await running;
    expect(await worker.runOnce()).toBe(true);
    expect(await runIn(b.conv)).toMatchObject({ status: "done" });
    expect(await worker.runOnce()).toBe(true);
    expect(await runIn(c.conv)).toMatchObject({ status: "done" });
    expect(gateway.pending()).toBe(0);
  });

  it("a held-back reply is an ordinary queued one: its owner's stop ends it at once, a pause cancels it; neither leaves anything held", async () => {
    const gateway = scriptedGateway();
    const first = gateway.hang();
    const { worker } = workerWith(gateway);
    const owner = await signUp(app, "heldstop");
    const [a, b, c] = [await agentOf(owner, FIVE, "Ann"), await agentOf(owner, FIVE, "Bob"), await agentOf(owner, FIVE, "Cy")];
    await grant(db, owner.id, 6n * POINT);
    await say(owner, a.conv, "你好");
    await say(owner, b.conv, "你好");
    await say(owner, c.conv, "你好");
    const running = worker.runOnce();
    await first.reached;
    expect(await worker.runOnce()).toBe(true);
    const held = await runIn(b.conv);
    expect(held).toMatchObject({ status: "queued" });
    expect((await api(app, owner, "POST", `/api/conversations/${b.conv}/runs/${held.id}/stop`)).status).toBe(200);
    expect(await runIn(b.conv)).toMatchObject({ status: "stopped", hold: "0" });
    // Cy's is held back now too; its Agent's pause cancels it as any queued reply.
    expect(await worker.runOnce()).toBe(true);
    expect(await runIn(c.conv)).toMatchObject({ status: "queued", held_back_by: [(await runIn(a.conv)).id] });
    expect((await api(app, owner, "POST", `/api/agents/${c.id}/pause`)).status).toBe(200);
    expect(await runIn(c.conv)).toMatchObject({ status: "cancelled", error: "agent_paused", hold: "0" });

    first.release("一。", { usage: U(0, 1000) });
    await running;
    expect(await worker.runOnce()).toBe(false);
    await expectSettledBooks(owner.id);
  });

  it("decided under the account lock: whether the reply it waits for settles just before or just after, a held-back reply is never left waiting for a reply that has ended", async () => {
    for (const order of ["settle first", "admit first"] as const) {
      const gateway = scriptedGateway();
      const first = gateway.hang();
      gateway.reply("二。", { usage: U(0, 1000) });
      const { worker } = workerWith(gateway);
      const owner = await signUp(app, order === "settle first" ? "racesettle" : "raceadmit");
      const [a, b] = [await agentOf(owner, FIVE, "Ann"), await agentOf(owner, FIVE, "Bob")];
      await grant(db, owner.id, 6n * POINT);
      await say(owner, a.conv, "你好");
      await say(owner, b.conv, "你好");
      const runningA = worker.runOnce();
      await first.reached;

      // Both the first's settlement and the second's admission wait on the owner's account row; which goes first is
      // the order they were queued in behind it.
      const holder = await db.pool.connect();
      let runningB: Promise<boolean>;
      try {
        await holder.query("begin");
        await holder.query("select 1 from accounts where principal_id = $1 for update", [owner.id]);
        const waiting = (n: number) =>
          vi.waitFor(
            async () =>
              expect(
                (await db.query<{ n: number }>("select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%from accounts where principal_id = $1 for update%'"))
                  .rows[0]!.n,
              ).toBe(n),
            { timeout: 5_000 },
          );
        if (order === "settle first") {
          first.release("一。", { usage: U(0, 1000) });
          await waiting(1);
          runningB = worker.runOnce();
        } else {
          runningB = worker.runOnce();
          await waiting(1);
          first.release("一。", { usage: U(0, 1000) });
        }
        await waiting(2);
        await holder.query("commit");
      } finally {
        await holder.query("rollback").catch(() => {});
        holder.release();
      }
      await runningA;
      await runningB;
      // Held back behind a reply that has ended, or never held back: either way it is answered.
      if ((await runIn(b.conv)).status === "queued") expect(await worker.runOnce()).toBe(true);
      expect(await runIn(b.conv)).toMatchObject({ status: "done" });
      expect(await worker.runOnce()).toBe(false);
      expect(gateway.pending()).toBe(0);
      await expectSettledBooks(owner.id);
    }
  });

  it("a persona draft never waits: it starts while something is left, whatever the replies hold, and its hold counts against the next reply", async () => {
    const owner = await signUp(app, "drafter");
    const paid = await meteredAgent(app, db, owner, PAID);
    await grant(db, owner.id, 1n * POINT);
    const reply = await runningRun(db, owner.id, paid);
    // Alone on a balance of 1: 1 promised, 1 over.
    expect(await db.tx((t) => admitRun(t, app.deps.config, reply, owner.id, paid.resolved, ESTIMATE, new Date()))).toEqual({
      chargeTo: "balance",
      holdMicro: MAX_COST,
      overMicro: POINT,
    });
    // 1 point left, all of it promised: a draft starts all the same, all of its hold over.
    const draft = await runningRun(db, owner.id);
    expect(await db.tx((t) => admitRun(t, app.deps.config, draft, owner.id, paid.resolved, ESTIMATE, new Date()))).toEqual({
      chargeTo: "balance",
      holdMicro: MAX_COST,
      overMicro: MAX_COST,
    });
    // A reply now waits behind both.
    const other = await meteredAgent(app, db, owner, PAID);
    const next = await runningRun(db, owner.id, other);
    const waited = await db.tx((t) => admitRun(t, app.deps.config, next, owner.id, other.resolved, ESTIMATE, new Date())).catch((e: unknown) => e);
    expect(waited).toBeInstanceOf(HeldBack);
    expect([...(waited as HeldBack).behind].sort()).toEqual([reply, draft].sort());
    // Nothing left: a reply and a draft are refused, as always.
    await grant(db, owner.id, -1n * POINT);
    const lastDraft = await runningRun(db, owner.id);
    for (const run of [next, lastDraft]) {
      const refused = await db.tx((t) => admitRun(t, app.deps.config, run, owner.id, other.resolved, ESTIMATE, new Date())).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(AppError);
      expect(refused).toMatchObject({ code: "no_quota", details: { reason: "balance" } });
    }
  });

  it("in a group, a held-back reply looks to the other members exactly as any queued one: replying", async () => {
    const gateway = scriptedGateway();
    const first = gateway.hang();
    const { worker } = workerWith(gateway);
    const owner = await signUp(app, "groupheld");
    const mia = await signUp(app, "groupmia");
    const ned = await signUp(app, "groupned");
    const a = await mustCreateAgent(app, owner, { model: FIVE, handle: "held_ann", name: "Ann", persona: "简短地回答。" });
    const b = await mustCreateAgent(app, owner, { model: FIVE, handle: "held_bob", name: "Bob", persona: "简短地回答。" });
    await grant(db, owner.id, 6n * POINT);
    const g = await group(app, owner, "team", [mia, ned]);
    for (const agent of [a, b]) expect((await api(app, owner, "POST", `/api/conversations/${g}/members`, { principalId: agent.id })).status).toBe(201);
    const [miaSocket, ownerSocket] = [await connect(app, mia), await connect(app, owner)];
    await say(owner, a.conversationId, "你好");
    const running = worker.runOnce();
    await first.reached;
    await say(mia, g, "@held_bob 你好");
    await miaSocket.waitFor((e) => e.type === "run" && e.agentId === b.id && e.state === "replying");
    const before = (await api(app, mia, "GET", `/api/conversations/${g}/runs`)).json;
    const seen = miaSocket.events.length;
    expect(await worker.runOnce()).toBe(true);
    expect(await runIn(g)).toMatchObject({ status: "queued", held_back_by: [(await runIn(a.conversationId)).id] });
    // Its owner is told it is queued again; mia is told nothing: not even the same state once more.
    await ownerSocket.waitFor((e) => e.type === "run" && e.agentId === b.id && e.run.status === "queued", { from: ownerSocket.events.findIndex((e) => e.type === "run" && e.agentId === b.id && e.run.status === "running") });
    // What mia reads of the group's replies is what she read while it was queued the first time.
    expect((await api(app, mia, "GET", `/api/conversations/${g}/runs`)).json).toEqual(before);
    expect(JSON.stringify(before)).not.toMatch(/held_back|hold|balance|quota/);
    expect(before.runs).toMatchObject([{ agentId: b.id, state: "replying" }]);
    first.release("一。", { usage: U(0, 1000) });
    gateway.reply("二。", { usage: U(0, 1000) });
    await running;
    // Claimed again and answered: mia saw its first claim (as any reply's) and its end — nothing of its going back and
    // forth.
    expect(await worker.runOnce()).toBe(true);
    await miaSocket.waitFor((e) => e.type === "run" && e.agentId === b.id && e.state === null);
    expect(miaSocket.events.slice(seen).filter((e) => e.type === "run").map((e) => e.state)).toEqual(["replying", null]);
    // The wait is logged once per reply, however often it is claimed; each time it is held back is counted.
    expect(metric("run_wait_ms")).toHaveLength(2);
    expect(metric("run_held_back")).toHaveLength(1);
  });
});

describe("a reply that has started is never refused for money", () => {
  it("a tool reply whose rounds outgrow what is left still answers: the next call is its last, made below zero, and it is charged what it cost, within TOOLS.maxPoints", async () => {
    const gateway = scriptedGateway()
      .callTools([{ name: "search", input: { query: "a" } }], { usage: U(1000, 500), text: "我先查一下。" })
      .reply("就这样。", { usage: U(2000, 300) });
    const { worker } = workerWith(gateway, { box: toolbox() });
    const owner = await signUp(app, "outgrow");
    const a = await agentOf(owner, PAID, "Tess");
    // Half a point: the first round alone costs 0.6.
    await grant(db, owner.id, POINT / 2n);
    await say(owner, a.conv, "查一查");
    expect(await worker.runOnce()).toBe(true);
    expect(gateway.calls).toHaveLength(2);
    expect(gateway.calls[1]!.toolChoice).toBe("none");
    const run = await runIn(a.conv);
    expect(run).toMatchObject({ status: "done", hold: "0" });
    const replies = (await api(app, owner, "GET", `/api/conversations/${a.conv}/messages`)).json.messages.filter((m: { senderId: string }) => m.senderId === a.id);
    // What it wrote before its tool call was its acknowledgement, posted then; the answer follows it, whole.
    expect(replies).toHaveLength(2);
    expect(replies[0]).toMatchObject({ text: "我先查一下。", ack: true });
    expect(replies[1].text).toContain("就这样。");
    expect(replies[1].truncated ?? false).toBe(false);
    const cost = 1000n * 100n + 500n * 1000n + 2000n * 100n + 300n * 1000n;
    expect(await recordOf(run.id)).toEqual([{ cost: cost.toString(), balance: cost.toString(), free: "0", forgiven: "0" }]);
    expect(cost).toBeLessThanOrEqual(BigInt(app.deps.config.tools.maxPoints) * POINT);
    expect(await balanceOf(owner.id)).toBe(POINT / 2n - cost);
    expect(gateway.pending()).toBe(0);
  });
});

describe("the debt bound: one reply that started alone, and one call more for each other call open beside it", () => {
  /** Each call of `searcher` here: 1 000 input and 300 output tokens on a meter model, 0.4 points. */
  const CALL = U(1000, 300);
  const CALL_COST = 1000n * 100n + 300n * 1000n;

  async function contend(name: string, n: number, balance: bigint, config: Config, model: typeof PAID | typeof FREE = PAID) {
    const gateway = searcher(CALL);
    const { worker } = workerWith(gateway, { box: toolbox(), config });
    const owner = await signUp(app, name);
    const agents = [];
    for (let i = 0; i < n; i++) agents.push(await agentOf(owner, model, `A${i}`));
    await grant(db, owner.id, balance);
    for (const a of agents) await say(owner, a.conv, "查一查附近的店");
    // All at once, each on its own connection, then whatever was held back as the others end.
    await Promise.all(agents.map(() => worker.runOnce()));
    while (await worker.runOnce());
    const rows = (
      await db.query<{ cost: string; forgiven: string }>(
        "select cost_micro::text as cost, forgiven_micro::text as forgiven from usage_records where owner_id = $1 and purpose = 'reply'",
        [owner.id],
      )
    ).rows;
    const records = rows.map((r) => BigInt(r.cost));
    const forgiven = rows.reduce((sum, r) => sum + BigInt(r.forgiven), 0n);
    const statuses = (await db.query<{ status: string; error: string | null }>("select status, error from agent_runs where owner_id = $1 and purpose = 'reply'", [owner.id])).rows;
    await expectSettledBooks(owner.id);
    return { owner, records, forgiven, statuses, end: await balanceOf(owner.id), calls: gateway.calls.length, atOnce: await mostAtOnce(owner.id) };
  }

  it("six tool replies of one owner called at once on 3 points of balance: every reply ends — answered, or refused once nothing is left —, no lock waits for ever, and the balance ends no lower than one reply's cost and one last call for each other reply that was open beside it (were extension blind to money, two at once would end near −4.2, below that)", { timeout: 120_000 }, async () => {
    const { records, statuses, end, atOnce, forgiven } = await contend("sixcalls", 6, 3n * POINT, app.deps.config);
    expect(statuses).toHaveLength(6);
    for (const s of statuses) expect([["done", null], ["failed", "no_quota"]]).toContainEqual([s.status, s.error]);
    expect(statuses.filter((s) => s.status === "done").length).toBeGreaterThanOrEqual(1);
    const largest = records.reduce((a, b) => (a > b ? a : b), 0n);
    expect(atOnce).toBeGreaterThanOrEqual(1);
    expect(end).toBeGreaterThanOrEqual(-(largest + BigInt(atOnce - 1) * CALL_COST));
    // On the balance nothing is forgiven: the debt is the owner's, repaid by the next grant.
    expect(forgiven).toBe(0n);
  });

  it("the free allowance: a reply offered tools holds room for its last call beside its first, so six at once on the day's 3 points run one at a time, and the overrun the site forgives is at most one reply", { timeout: 120_000 }, async () => {
    const { owner, records, statuses, forgiven, atOnce } = await contend("freesix", 6, 0n, app.deps.config, FREE);
    expect(statuses).toHaveLength(6);
    for (const s of statuses) expect([["done", null], ["failed", "no_quota"]]).toContainEqual([s.status, s.error]);
    expect(atOnce).toBe(1);
    const largest = records.reduce((a, b) => (a > b ? a : b), 0n);
    expect(forgiven).toBeLessThanOrEqual(largest);
    expect(await balanceOf(owner.id)).toBe(0n);
    const used = (await db.query<{ used: string }>("select coalesce(sum(used_micro), 0)::text as used from free_usage where owner_id = $1", [owner.id])).rows[0]!.used;
    expect(BigInt(used)).toBe(3n * POINT);
  });

  it("the case that broke the first draft of these rules: 6 points, two tool replies that would each run to TOOLS.maxPoints (20) — they end within one reply and one last call, not near −34", { timeout: 120_000 }, async () => {
    const { records, statuses, end } = await contend("counter", 2, 6n * POINT, withTools({ maxRounds: 50 }));
    expect(statuses).toEqual([
      { status: "done", error: null },
      { status: "done", error: null },
    ]);
    const largest = records.reduce((a, b) => (a > b ? a : b), 0n);
    expect(end).toBeGreaterThanOrEqual(-(largest + CALL_COST));
    expect(end).toBeGreaterThan(-4n * POINT);
    // Neither ran anywhere near its cap.
    for (const r of records) expect(r).toBeLessThan(10n * POINT);
  });
});

describe("fix round 1: spend clamped to what was held, a requeued attempt that cannot touch the next, first come first served per source", () => {
  it("an upstream that over-reports a round cannot take the balance past what was held: the last call is held at the first call's hold and its own most, the reply is charged at most that, the rest is forgiven", async () => {
    const gateway = scriptedGateway().callTools([{ name: "search", input: { query: "a" } }], { usage: U(1_000_000, 0), text: "我先查一下。" });
    const last = gateway.hang();
    const { worker } = workerWith(gateway, { box: toolbox() });
    const owner = await signUp(app, "overreport");
    const a = await agentOf(owner, PAID, "Over");
    await grant(db, owner.id, 3n * POINT);
    await say(owner, a.conv, "查一查");
    const running = worker.runOnce();
    await last.reached;
    const run = await runIn(a.conv);
    const held = BigInt(run.hold);
    // Not the 100 points the round reported: what the first call held, and the last call's own most.
    expect(held).toBeLessThan(2n * FULL_CALL);
    last.release("就这样。", { usage: U(1000, 100) });
    await running;
    const [record] = await recordOf(run.id);
    expect(BigInt(record!.balance)).toBe(held);
    expect(BigInt(record!.forgiven)).toBe(BigInt(record!.cost) - held);
    expect(await balanceOf(owner.id)).toBe(3n * POINT - held);
    expect(gateway.pending()).toBe(0);
  });

  it("a requeued attempt's own late end cannot touch the reply's next attempt — claimed meanwhile by another worker, or by the same one", async () => {
    for (const again of ["another", "same"] as const) {
      const owner = await signUp(app, `stale${again}`);
      const [a, b] = [await agentOf(owner, FIVE, "Ann"), await agentOf(owner, FIVE, "Bob")];
      await grant(db, owner.id, 6n * POINT);
      await say(owner, a.conv, "你好");
      await say(owner, b.conv, "你好");
      const one = workerWith(scriptedGateway()).port;
      const two = again === "same" ? one : workerWith(scriptedGateway()).port;
      const ann = (await one.claimNext())!;
      expect(isRunEnd(await one.begin(ann))).toBe(false);
      const first = (await one.claimNext())!;
      const heldBack = (await one.begin(first)) as RunEnd;
      expect(await runIn(b.conv)).toMatchObject({ status: "queued" });
      // Ann's reply ends: Bob's may be claimed again — and is, before its first attempt's end has been recorded.
      await one.finish(ann, { status: "failed", error: "busy" }, null, NOTHING);
      const second = (await two.claimNext())!;
      expect(second.id).toBe(first.id);
      expect(isRunEnd(await two.begin(second))).toBe(false);
      await one.finish(first, heldBack, null, NOTHING);
      // The second attempt stands: running, admitted, unsettled, its flags its own.
      expect(await runIn(b.conv)).toMatchObject({ status: "running", error: null, charge_to: "balance" });
      expect(await recordOf(second.id)).toEqual([]);
      expect(await two.extend(second, null, { inputChars: 0, outputChars: 0 }, 100)).not.toBe("stop");
      await two.finish(second, { status: "failed", error: "busy" }, null, NOTHING);
      expect(await runIn(b.conv)).toMatchObject({ status: "failed", error: "busy", hold: "0" });
      await expectSettledBooks(owner.id);
    }
  });

  it("a stop asked while the reply was running, landing after it was held back and claimed again: its next attempt ends stopped, also on a port that never saw the stop — the stop is kept in its row", async () => {
    const owner = await signUp(app, "stopwindow");
    const [a, b] = [await agentOf(owner, FIVE, "Ann"), await agentOf(owner, FIVE, "Bob")];
    await grant(db, owner.id, 6n * POINT);
    await say(owner, a.conv, "你好");
    await say(owner, b.conv, "你好");
    const { port } = workerWith(scriptedGateway());
    const { port: two } = workerWith(scriptedGateway());
    const ann = (await port.claimNext())!;
    expect(isRunEnd(await port.begin(ann))).toBe(false);
    const bob = (await port.claimNext())!;
    // Its admission holds it back…
    await port.finish(bob, (await port.begin(bob)) as RunEnd, null, NOTHING);
    expect(await runIn(b.conv)).toMatchObject({ status: "queued" });
    await port.finish(ann, { status: "failed", error: "busy" }, null, NOTHING);
    // …it is claimed again, here by another port…
    const again = (await two.claimNext())!;
    expect(again.id).toBe(bob.id);
    // …the stop's transaction sees it running, and the route tells a port that is not working on it…
    expect(await db.tx((t) => stopRun(t, owner.id, b.conv, bob.id, app.deps.config))).toMatchObject({ stopped: null, running: true });
    port.stopAsked(bob.id);
    expect(await runIn(b.conv)).toMatchObject({ status: "running" });
    // …and the attempt ends stopped all the same: never admitted, never left to run later.
    expect(await two.begin(again)).toEqual({ status: "stopped" });
    await two.finish(again, { status: "stopped" }, null, NOTHING);
    expect(await runIn(b.conv)).toMatchObject({ status: "stopped", hold: "0", charge_to: null });
    expect(await port.claimNext()).toBeNull();
  });

  it("a held-back reply keeps the owner's own mention it took on: refused at its next attempt by the others' daily budget, the owner's call is still answered", async () => {
    const owner = await signUp(app, "keepmention");
    const [mia, ned] = [await signUp(app, "keepmia"), await signUp(app, "keepned")];
    const x = await mustCreateAgent(app, owner, { model: FIVE, handle: "keep_x", name: "Xia", persona: "简短地回答。Xia", othersBudget: "6" });
    const y = await agentOf(owner, FIVE, "Yan");
    await grant(db, owner.id, 6n * POINT);
    const g = await group(app, owner, "team", [mia, ned]);
    expect((await api(app, owner, "POST", `/api/conversations/${g}/members`, { principalId: x.id })).status).toBe(201);
    const { port } = workerWith(scriptedGateway());
    await say(owner, y.conv, "你好");
    const yan = (await port.claimNext())!;
    expect(isRunEnd(await port.begin(yan))).toBe(false);
    await say(mia, g, "@keep_x 你好");
    const r = (await port.claimNext())!;
    expect(r.conversationId).toBe(g);
    // The owner's own mention, noted on the reply someone else called for while it was claimed.
    await say(owner, g, "@keep_x 也帮我看看");
    const ownersSeq = Number((await db.query("select seq from conversations where id = $1", [g])).rows[0].seq);
    await port.finish(r, (await port.begin(r)) as RunEnd, null, NOTHING);
    expect(await runIn(g)).toMatchObject({ status: "queued" });
    // Replies settled while it waited spend the Agent's others' daily budget.
    await paidReply(db, { agentId: x.id, ownerId: owner.id, conversationId: g, lane: "others", micro: 6n * POINT });
    await port.finish(yan, { status: "failed", error: "busy" }, null, NOTHING);
    const again = (await port.claimNext())!;
    expect(again.id).toBe(r.id);
    await port.finish(again, (await port.begin(again)) as RunEnd, null, NOTHING);
    expect((await db.query("select status, error from agent_runs where id = $1", [r.id])).rows[0]).toEqual({ status: "cancelled", error: null });
    // Its owner's mention is queued as theirs.
    const followed = (await db.query("select status, lane, covers_seq::int as covers from agent_runs where agent_id = $1 and conversation_id = $2 and id <> $3 and status = 'queued'", [x.id, g, r.id])).rows;
    expect(followed).toEqual([{ status: "queued", lane: "own", covers: ownersSeq }]);
  });

  it("first come, first served while the worker runs on its own: a large reply held back behind a small one is the next admitted, ahead of the stream of small ones that came after it", { timeout: 60_000 }, async () => {
    const routes = new Map<string, ModelGateway>();
    const bigGateway = scriptedGateway();
    const bigCall = bigGateway.hang();
    const firstGateway = scriptedGateway();
    const firstCall = firstGateway.hang();
    routes.set("Lars", bigGateway);
    routes.set("S0", firstGateway);
    const { worker } = workerWith(router(routes), { background: true });
    const owner = await signUp(app, "fifostream");
    const s0 = await agentOf(owner, PAID, "S0");
    const lars = await agentOf(owner, FIVE, "Lars");
    const smalls: Array<{ id: string; conv: string }> = [];
    for (let i = 1; i <= 5; i++) {
      const agent = await agentOf(owner, PAID, `S${i}`);
      routes.set(`S${i}`, scriptedGateway().reply("好。", { usage: U(0, 100) }));
      smalls.push(agent);
    }
    await grant(db, owner.id, 6n * POINT);
    worker.start();
    try {
      await say(owner, s0.conv, "你好");
      worker.wake();
      await firstCall.reached;
      await say(owner, lars.conv, "你好");
      worker.wake();
      await vi.waitFor(async () => expect((await runIn(lars.conv)).held_back_by).not.toBeNull(), { timeout: 10_000 });
      expect(await runIn(lars.conv)).toMatchObject({ status: "queued" });
      for (const small of smalls) {
        await say(owner, small.conv, "你好");
        worker.wake();
      }
      await sleep(300);
      for (const small of smalls) expect(await runIn(small.conv)).toMatchObject({ status: "queued", source: null });
      firstCall.release("一。", { usage: U(0, 100) });
      await bigCall.reached;
      // Lars is calling its model: it was admitted, and no small reply that came after it was admitted before it.
      for (const small of smalls) expect((await runIn(small.conv)).source).toBeNull();
      bigCall.release("大。", { usage: U(0, 100) });
      await vi.waitFor(async () => {
        for (const small of smalls) expect(await runIn(small.conv)).toMatchObject({ status: "done" });
      }, { timeout: 30_000 });
      expect(await runIn(lars.conv)).toMatchObject({ status: "done" });
    } finally {
      await worker.stop();
    }
  });

  it("the mark stays until admission: a held-back reply claimed again keeps the owner's younger replies on its source unclaimed until it is admitted — else a quicker small one would win the account's lock and hold the large one back again, for ever", async () => {
    const owner = await signUp(app, "markstays");
    const s0 = await agentOf(owner, PAID, "S0");
    const lars = await agentOf(owner, FIVE, "Lars");
    const s1 = await agentOf(owner, PAID, "S1");
    await grant(db, owner.id, 6n * POINT);
    const { port } = workerWith(scriptedGateway());
    await say(owner, s0.conv, "你好");
    const small = (await port.claimNext())!;
    expect(isRunEnd(await port.begin(small))).toBe(false);
    await say(owner, lars.conv, "你好");
    const large = (await port.claimNext())!;
    await port.finish(large, (await port.begin(large)) as RunEnd, null, NOTHING);
    expect(await runIn(lars.conv)).toMatchObject({ status: "queued", held_back_by: [small.id] });
    await say(owner, s1.conv, "你好");
    await port.finish(small, { status: "failed", error: "busy" }, null, NOTHING);
    const again = (await port.claimNext())!;
    expect(again.id).toBe(large.id);
    // Claimed but not admitted yet: the small reply after it is not claimed.
    expect(await port.claimNext()).toBeNull();
    expect(isRunEnd(await port.begin(again))).toBe(false);
    expect(await runIn(lars.conv)).toMatchObject({ status: "running", held_back_by: null, held_back_on: null, charge_to: "balance" });
    // Admitted: now the small one is claimed, and waits behind it.
    const next = (await port.claimNext())!;
    expect(next.conversationId).toBe(s1.conv);
    await port.finish(next, (await port.begin(next)) as RunEnd, null, NOTHING);
    expect(await runIn(s1.conv)).toMatchObject({ status: "queued", held_back_by: [large.id], held_back_on: "balance" });
  });

  it("only replies that compete for the same money wait behind a held-back one: a reply on the owner's own provider key, or a free-tier one whose hold fits the free allowance while the held-back one waits on the balance, goes ahead (review I1)", async () => {
    const owner = await signUp(app, "samesource");
    const provider = (await api(app, owner, "POST", "/api/providers", providerBody({ models: [{ name: "mine" }] }))).json;
    const [a, b] = [await agentOf(owner, FIVE, "Ann"), await agentOf(owner, FIVE, "Bob")];
    const free = await agentOf(owner, FREE, "Fay");
    const own = await agentOf(owner, { source: "provider", providerId: provider.id as string, model: "mine" }, "Ole");
    await grant(db, owner.id, 6n * POINT);
    const gateway = scriptedGateway();
    const annCall = gateway.hang();
    gateway.reply("免费的。", { usage: U(0, 100) }).reply("自己的。", { usage: U(0, 100) });
    const { worker } = workerWith(gateway);
    for (const agent of [a, b, free, own]) await say(owner, agent.conv, "你好");
    const running = worker.runOnce();
    await annCall.reached;
    expect(await worker.runOnce()).toBe(true);
    expect(await runIn(b.conv)).toMatchObject({ status: "queued", held_back_on: "balance" });
    // Fay's hold fits the day's free allowance, which nobody else needs: she goes ahead, the balance left to Bob.
    expect(await worker.runOnce()).toBe(true);
    expect(await runIn(free.conv)).toMatchObject({ status: "done", charge_to: "free" });
    expect((await db.query("select balance_micro::text as b from usage_records u join agent_runs r on r.id = u.run_id where r.conversation_id = $1", [free.conv])).rows[0]).toEqual({
      b: "0",
    });
    expect(await worker.runOnce()).toBe(true);
    expect(await runIn(own.conv)).toMatchObject({ status: "done", charge_to: null });
    expect(await runIn(b.conv)).toMatchObject({ status: "queued", held_back_on: "balance" });
    annCall.release("一。", { usage: U(0, 100) });
    await running;
    gateway.reply("二。", { usage: U(0, 100) });
    expect(await worker.runOnce()).toBe(true);
    expect(await runIn(b.conv)).toMatchObject({ status: "done", held_back_by: null, held_back_on: null });
    expect(gateway.pending()).toBe(0);
  });

  it("HOLDS.maxOpenShare is an admission rule: at 0.5 a second reply whose hold would fit in the whole balance beside the first waits", async () => {
    const owner = await signUp(app, "halfshare");
    const [first, second] = [await meteredAgent(app, db, owner, PAID), await meteredAgent(app, db, owner, PAID)];
    await grant(db, owner.id, 5n * POINT);
    const half: Config = { ...app.deps.config, holds: { maxOpenShare: 0.5 } };
    const r1 = await runningRun(db, owner.id, first);
    expect(await db.tx((t) => admitRun(t, half, r1, owner.id, first.resolved, ESTIMATE, new Date()))).toEqual({ chargeTo: "balance", holdMicro: MAX_COST });
    const r2 = await runningRun(db, owner.id, second);
    // 2 + 2 of 5: within the whole balance, past half of it.
    await expect(db.tx((t) => admitRun(t, half, r2, owner.id, second.resolved, ESTIMATE, new Date()))).rejects.toBeInstanceOf(HeldBack);
    expect(await db.tx((t) => admitRun(t, app.deps.config, r2, owner.id, second.resolved, ESTIMATE, new Date()))).toEqual({ chargeTo: "balance", holdMicro: MAX_COST });
  });

  it("extension is a reply's alone: a memory call (one call, the site's memory allowance) is never extended", async () => {
    const owner = await signUp(app, "memoryextend");
    await expect(
      db.tx((t) => raiseHold(t, app.deps.config, { id: "00000000-0000-0000-0000-000000000000", ownerId: owner.id, chargeTo: "memory" }, { ok: 2n, final: 2n }, true, new Date())),
    ).rejects.toThrow(/memory/);
  });
});

describe("fix round 2: the free allowance's room for the last call, renewed a round at a time; a stop kept in the row; the queue's marks", () => {
  const FINAL_LINE = "你已经不能再查了，请用上面查到的内容直接回答。";
  const withLine = (system: string) => (system.endsWith(`\n\n${FINAL_LINE}`) ? system : `${system}\n\n${FINAL_LINE}`);
  const textsOf = (call: Pick<ModelCall, "messages">) => call.messages.flatMap((m) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])));
  /** What the call after `call`'s rounds can take as input, as the worker bounds it (tool-loop-money.test.ts `nextInput`). */
  const nextInput = (call: ModelCall, context: number, maxOut: number) =>
    holdTokens([withLine(call.system), ...textsOf(call), JSON.stringify(call.tools), JSON.stringify(call.steps ?? [])], context, maxOut) + TOOL_PREAMBLE_TOKENS;
  /** A toolbox offering search, at most 6 calls a reply, whose every call waits on `gate` and returns `output`. */
  const searching = (output: unknown, gate: () => Promise<void> = async () => {}): Toolbox => ({
    offer: () => ({ tools: [SEARCH], perTool: { search: OFFERED_CAP }, kinds: { search: "search" } }),
    run: async (): Promise<ToolOutcome> => {
      await gate();
      return { output, activity: "search" };
    },
  });
  /**
   * The room a reply offered tools keeps on the free allowance for its last call (README "Metering", The free allowance's
   * room): the cost of a call on `input` — the next call's input bound — and what one more round can add (`k` results of
   * at most 3 × `resultMaxWeight` bytes each and 200 of framing, an assistant turn and notes of 6 bytes an output token,
   * and 300), never more than the whole context and what providers add around tool definitions, with the whole output.
   */
  // The calls one reply may run in all, each as the offered toolbox's own caps summed (`k`: a toolbox offering search 6, file 4 and
  // a clock 1 has 11): the tests below offer one tool whose cap is read from the offer, never a number apart from it.
  const OFFERED_CAP = 6;
  const OFFERED_CAP_2 = 2;
  const room = (input: number, k: number, model: { context: number; out: number; inPrice: bigint; outPrice: bigint }) => {
    const growth = k * (3 * app.deps.config.tools.resultMaxWeight + 200) + 6 * model.out + 300;
    const capped = Math.min(input + growth, model.context - model.out + TOOL_PREAMBLE_TOKENS);
    return BigInt(capped) * model.inPrice + BigInt(model.out) * model.outPrice;
  };
  const METER = { context: 100_000, out: 1000, inPrice: 100n, outPrice: 1000n };
  const cost = (u: { inputTokens: number; outputTokens: number }) => BigInt(u.inputTokens) * 100n + BigInt(u.outputTokens) * 1000n;
  /** A day's free allowance of `points` (the meter models' 3 otherwise). */
  const withFree = (points: number): Config => ({ ...app.deps.config, freeDailyMicro: BigInt(points) * POINT });
  const setFreeUsed = (ownerId: string, micro: bigint) =>
    db.query(
      `insert into free_usage (owner_id, day, used_micro) values ($1, (now() at time zone 'Asia/Shanghai')::date, $2)
       on conflict (owner_id, day) do update set used_micro = $2`,
      [ownerId, micro.toString()],
    );

  it("the room is renewed a round at a time: at admission and after each round the hold is what the reply has spent, the most of its next call, and the room for a last call after one more round", async () => {
    const holds: bigint[] = [];
    const gateway = scriptedGateway()
      .callTools([{ name: "search", input: { query: "a" } }], { usage: U(1000, 50) })
      .callTools([{ name: "search", input: { query: "b" } }], { usage: U(1500, 60) });
    const last = gateway.hang();
    const box = searching({ hits: ["川菜馆"] }, async () => {
      holds.push(BigInt((await runIn(conv)).hold));
    });
    const { worker } = workerWith(gateway, { box, config: withFree(100) });
    const owner = await signUp(app, "rollroom");
    const conv = (await agentOf(owner, FREE, "Rolf")).conv;
    await setFreeUsed(owner.id, 50n * POINT);
    await say(owner, conv, "附近有什么好吃的？");
    const running = worker.runOnce();
    const third = await last.reached;
    const [c1, c2] = gateway.calls as [ModelCall, ModelCall];
    const first = holdTokens([c1.system, ...textsOf(c1), JSON.stringify(c1.tools)], METER.context, METER.out) + TOOL_PREAMBLE_TOKENS;
    const callMax = (input: number) => BigInt(input) * 100n + 1000n * 1000n;
    // At admission (seen by round 1's tool): the first call's most and the room after one round.
    expect(holds[0]).toBe(callMax(first) + room(first, OFFERED_CAP, METER));
    // After round 1 (seen by round 2's tool): spent, the second call's most, the room after one more round.
    expect(holds[1]).toBe(cost(U(1000, 50)) + callMax(nextInput(c2, METER.context, METER.out)) + room(nextInput(c2, METER.context, METER.out), OFFERED_CAP, METER));
    // After round 2, before the third call.
    expect(await runIn(conv).then((r) => BigInt(r.hold))).toBe(
      cost(U(2500, 110)) + callMax(nextInput(third, METER.context, METER.out)) + room(nextInput(third, METER.context, METER.out), OFFERED_CAP, METER),
    );
    // Not the whole context any more: far below it.
    expect(holds[0]).toBeLessThan(callMax(first) + room(1_000_000, OFFERED_CAP, METER));
    expect(third.toolChoice).toBeUndefined();
    last.release("去吃川菜。", { usage: U(2000, 70) });
    await running;
    expect(await runIn(conv)).toMatchObject({ status: "done", hold: "0", charge_to: "free" });
  });

  it("the room kept is the one renewed: a reply whose upstream over-reports, two rounds, the second's renewal not fitting — so far is clamped beside the renewed room and the last call is made within it, the hold unchanged", async () => {
    // Two calls of search at most (k = 2), each bringing back nearly a whole result, each asked for with a long query: the
    // two rounds together add more than one round can (`G`), so a last call held against the room kept at admission would
    // pass it; the room renewed after round 1 covers it.
    const holds: bigint[] = [];
    let runs = 0;
    const box: Toolbox = {
      offer: () => ({ tools: [SEARCH], perTool: { search: OFFERED_CAP_2 }, kinds: { search: "search" } }),
      run: async (): Promise<ToolOutcome> => {
        const hold = BigInt((await runIn(conv)).hold);
        holds.push(hold);
        // Before round 2's extend: what is left of the free allowance beside the reply is its own hold, so another round
        // (its room renewed again) does not fit and the next call is the last.
        if (++runs === 2) await setFreeUsed(owner.id, 100n * POINT - hold);
        return { output: { text: "a".repeat(8900) }, activity: "search" };
      },
    };
    const gateway = scriptedGateway()
      .callTools([{ name: "search", input: { query: `a${"查".repeat(1700)}` } }], { usage: U(1_000_000, 50) })
      .callTools([{ name: "search", input: { query: `b${"查".repeat(1700)}` } }], { usage: U(1_000_000, 50) });
    const last = gateway.hang();
    const { worker } = workerWith(gateway, { box, config: withFree(100) });
    const owner = await signUp(app, "renewedroom");
    const conv = (await agentOf(owner, FREE, "Remy")).conv;
    await say(owner, conv, "附近有什么好吃的？");
    const running = worker.runOnce();
    const third = await last.reached;
    const [c1] = gateway.calls as [ModelCall];
    const first = holdTokens([c1.system, ...textsOf(c1), JSON.stringify(c1.tools)], METER.context, METER.out) + TOOL_PREAMBLE_TOKENS;
    const callMax = (input: number) => BigInt(input) * 100n + 1000n * 1000n;
    // The last call could not be made within the room kept at admission…
    expect(callMax(nextInput(third, METER.context, METER.out))).toBeGreaterThan(room(first, OFFERED_CAP_2, METER));
    // …it is the last (no further round fitted), and its hold is the one after round 1: not raised.
    expect(third.toolChoice).toBe("none");
    expect(holds).toHaveLength(2);
    expect(BigInt((await runIn(conv)).hold)).toBe(holds[1]);
    last.release("去吃川菜。", { usage: U(2000, 70) });
    await running;
    expect(await runIn(conv)).toMatchObject({ status: "done", hold: "0", charge_to: "free" });
  });

  it("the acceptance's free model at half of a 100-point day: four one-search replies all start at once, and each keeps its round (its next call is not made the last)", { timeout: 60_000 }, async () => {
    const routes = new Map<string, ModelGateway>();
    let arrived = 0;
    let open!: () => void;
    const all = new Promise<void>((resolve) => (open = resolve));
    const gate = async () => {
      if (++arrived === 4) open();
      await Promise.race([all, sleep(10_000)]);
    };
    const { worker } = workerWith(router(routes), { box: searching({ hits: ["川菜馆"] }, gate), config: withFree(100) });
    const owner = await signUp(app, "lunahalf");
    const convs: string[] = [];
    for (const name of ["L1", "L2", "L3", "L4"]) {
      const agent = await mustCreateAgent(app, owner, { model: { source: "site", id: "luna" }, name, persona: `简短地回答。${name}` });
      routes.set(name, scriptedGateway().callTools([{ name: "search", input: { query: name } }], { usage: U(2500, 300) }).reply("去吃川菜。", { usage: U(3000, 400) }));
      convs.push(agent.conversationId as string);
    }
    await setFreeUsed(owner.id, 50n * POINT);
    for (const conv of convs) await say(owner, conv, "附近有什么好吃的？");
    await Promise.all(convs.map(() => worker.runOnce()));
    expect(arrived).toBe(4);
    for (const conv of convs) expect(await runIn(conv)).toMatchObject({ status: "done", held_back_by: null, charge_to: "free" });
    for (const g of routes.values()) {
      const calls = (g as ScriptedGateway).calls;
      expect(calls).toHaveLength(2);
      expect(calls[1]!.toolChoice).toBeUndefined();
    }
  });

  it("a stop asked while the reply ran is kept in its row: an attempt that begins after it — the same, or the next after a hold-back — ends stopped, whatever the in-process flags say", async () => {
    const owner = await signUp(app, "stoprow");
    const [a, b] = [await agentOf(owner, FIVE, "Ann"), await agentOf(owner, FIVE, "Bob")];
    await grant(db, owner.id, 6n * POINT);
    await say(owner, a.conv, "你好");
    await say(owner, b.conv, "你好");
    const { port } = workerWith(scriptedGateway());
    const ann = (await port.claimNext())!;
    expect(isRunEnd(await port.begin(ann))).toBe(false);
    const bob = (await port.claimNext())!;
    // The stop's transaction sees it running; the route has not told the port yet.
    expect(await db.tx((t) => stopRun(t, owner.id, b.conv, bob.id, app.deps.config))).toMatchObject({ stopped: null, running: true });
    expect(await port.begin(bob)).toEqual({ status: "stopped" });
    await port.finish(bob, { status: "stopped" }, null, NOTHING);
    expect(await runIn(b.conv)).toMatchObject({ status: "stopped", hold: "0", held_back_by: null });
    await port.finish(ann, { status: "failed", error: "busy" }, null, NOTHING);
    expect(await port.claimNext()).toBeNull();
  });

  it("a reply someone else called for, held back, does not keep its owner's own replies waiting while the others' lanes are full", async () => {
    const owner = await signUp(app, "lanemark");
    const [mia, ned] = [await signUp(app, "lanemia"), await signUp(app, "lanened")];
    const x = await mustCreateAgent(app, owner, { model: FIVE, handle: "lane_x", name: "Xia", persona: "简短地回答。Xia" });
    const y = await agentOf(owner, FIVE, "Yan");
    const z = await agentOf(owner, PAID, "Zed");
    const w = await agentOf(owner, PAID, "Wen");
    await grant(db, owner.id, 6n * POINT);
    const g = await group(app, owner, "team", [mia, ned]);
    expect((await api(app, owner, "POST", `/api/conversations/${g}/members`, { principalId: x.id })).status).toBe(201);
    const { port } = workerWith(scriptedGateway(), { config: { ...app.deps.config, agentMaxConcurrentOthersRuns: 1 } });
    await say(owner, y.conv, "你好");
    const yan = (await port.claimNext())!;
    expect(isRunEnd(await port.begin(yan))).toBe(false);
    await say(mia, g, "@lane_x 你好");
    const others = (await port.claimNext())!;
    await port.finish(others, (await port.begin(others)) as RunEnd, null, NOTHING);
    expect(await runIn(g)).toMatchObject({ status: "queued", held_back_on: "balance" });
    await port.finish(yan, { status: "failed", error: "busy" }, null, NOTHING);
    // Another reply someone else called for runs (on no money): the others' one place is taken, so it cannot be claimed.
    await db.query("insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, lane, started_at) values ('reply', $1, $2, $3, 'running', 0, 'others', now())", [
      w.conv,
      w.id,
      owner.id,
    ]);
    await say(owner, z.conv, "你好");
    const next = (await port.claimNext())!;
    expect(next.conversationId).toBe(z.conv);
  });

  it("a free-tier reply whose allowance is all held by an older reply, the balance funded, runs on the two pots together (Q1): it is not held back", async () => {
    const owner = await signUp(app, "freewaits");
    const [a, c] = [await agentOf(owner, FREE, "Ann"), await agentOf(owner, FREE, "Cy")];
    // Half a point of the day's allowance left, five points of balance: Ann's hold passes the allowance.
    await setFreeUsed(owner.id, (5n * POINT) / 2n);
    await grant(db, owner.id, 5n * POINT);
    const { port } = workerWith(scriptedGateway());
    await say(owner, a.conv, "你好");
    const ann = (await port.claimNext())!;
    expect(isRunEnd(await port.begin(ann))).toBe(false);
    expect((await runIn(a.conv)).charge_to).toBe("free");
    // Cy's hold fits what the allowance and the balance leave together beside Ann's: admitted, not held back.
    await say(owner, c.conv, "你好");
    const cy = (await port.claimNext())!;
    expect(isRunEnd(await port.begin(cy))).toBe(false);
    expect(await runIn(c.conv)).toMatchObject({ status: "running", charge_to: "free", held_back_on: null });
    await port.finish(ann, { status: "failed", error: "busy" }, null, NOTHING);
    await port.finish(cy, { status: "failed", error: "busy" }, null, NOTHING);
  });

  it("a free-tier reply held back with the allowance used up and nothing left of the balance after the holds waits on both: a younger reply the balance would pay waits behind it too", async () => {
    const owner = await signUp(app, "bothsources");
    const [a, c, d] = [await agentOf(owner, FREE, "Ann"), await agentOf(owner, FREE, "Cy"), await agentOf(owner, PAID, "Dee")];
    // The day's allowance used up (so the balance pays), one point of balance: one running reply holds more than it.
    await setFreeUsed(owner.id, 3n * POINT);
    await grant(db, owner.id, POINT);
    const { port } = workerWith(scriptedGateway());
    await say(owner, a.conv, "你好");
    const ann = (await port.claimNext())!;
    expect(isRunEnd(await port.begin(ann))).toBe(false);
    // Its class is the free tier's whichever pot pays (wallet v3: `charge_to` names the class).
    expect((await runIn(a.conv)).charge_to).toBe("free");
    await say(owner, c.conv, "你好");
    const cy = (await port.claimNext())!;
    await port.finish(cy, (await port.begin(cy)) as RunEnd, null, NOTHING);
    expect(await runIn(c.conv)).toMatchObject({ status: "queued", held_back_on: "any" });
    await say(owner, d.conv, "你好");
    expect(await port.claimNext()).toBeNull();
  });
});
