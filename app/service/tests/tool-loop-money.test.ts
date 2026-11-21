import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentPort, staleAfterMs, type DbAgentPort, type Toolbox } from "../src/agents/port-impl.ts";
import { contextBudget } from "../src/agents/runtime/context.ts";
import { isRunEnd, type Prepared, type ToolOutcome } from "../src/agents/runtime/port.ts";
import { NO_TOOLS, toolsPassage } from "../src/agents/runtime/prompt.ts";
import { createAgentWorker, type AgentWorker } from "../src/agents/runtime/worker.ts";
import type { Config } from "../src/config.ts";
import { CONTEXT_HEADROOM, estimateTokens, holdTokens, TOOL_PREAMBLE_TOKENS, TOOL_TEXT_FACTOR } from "../src/metering/tokens.ts";
import type { ModelCall, ToolCall, ToolSpec } from "../src/models/gateway.ts";
import { api, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { costOf, grant, METER_ENV, paidReply } from "./helpers/metering.ts";
import { scriptedGateway, type ScriptedGateway } from "./helpers/models.ts";
import { providerBody } from "./helpers/providers.ts";
import { closeAllSockets } from "./helpers/ws.ts";

/**
 * The money of a reply that offers tools (agents/runtime/worker.ts, port-impl.ts `extend`, metering/admit.ts
 * `raiseHold`): one admission, its tools' definitions reserved in the context plan with room for what they bring back,
 * and held; before every later call
 * the hold raised — never lowered — to what the reply has cost so far and the most that call can cost (every step it
 * carries), within `TOOLS.maxPoints` and its lane's budgets for another tool round, else for one last call while
 * something is left after what the reply has spent; and one settlement on the rounds' summed usage, each round's
 * reported usage counted where it has one. On the real port and database, the meter models (METER_ENV: 100
 * micro-points an input token, 1 000 an output token, at most 1 000 output tokens, a context of 100 000; 3 free points a
 * day) and a dear one (`pricey`: 1 000 a token either way, at most 4 096 output tokens), with tools offered through a
 * toolbox the test gives the port.
 */

const PRICEY = {
  id: "pricey",
  label: "Pricey",
  tier: "paid",
  protocol: "openai_chat",
  baseUrl: "https://api.example.test/v1",
  apiKeyEnv: "METER_UPSTREAM_KEY",
  model: "pricey-1",
  inputMicroPerToken: 1000,
  outputMicroPerToken: 1000,
  maxOutputTokens: 4096,
  contextTokens: 100000,
  vision: false,
  pdf: false,
  reasoning: [],
};
const ENV = { ...METER_ENV, SITE_MODELS: JSON.stringify([...JSON.parse(METER_ENV.SITE_MODELS), PRICEY]) };

const { app, db } = useApp({ env: ENV, agentWorker: false });

afterEach(async () => {
  await closeAllSockets();
});

const FINAL_LINE = "你已经不能再查了，请用上面查到的内容直接回答。";
const FREE = { source: "site", id: "meter_free" } as const;
const PAID = { source: "site", id: "meter_paid" } as const;
const DEAR = { source: "site", id: "pricey" } as const;
const POINT = 1_000_000n;
/** The meter models' output limit and context. */
const MAX_OUT = 1000;
const CONTEXT = 100_000;

const SEARCH: ToolSpec = {
  name: "search",
  description: "Search this conversation's messages.",
  parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
};
const READ: ToolSpec = {
  name: "read_file",
  description: "Read a file shared here.",
  parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
};
const TOOLS = [SEARCH];
/** A search tool whose definition weighs about 600 (its description in Chinese). */
const BIG: ToolSpec = { ...SEARCH, description: "搜".repeat(560) };

const U = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens });
const plus = (...us: Array<{ inputTokens: number; outputTokens: number }>) =>
  us.reduce((a, b) => U(a.inputTokens + b.inputTokens, a.outputTokens + b.outputTokens), U(0, 0));

/** A toolbox that offers the search tool and runs it with `run` (default: an empty result at once). */
function toolbox(run: (call: ToolCall) => Promise<ToolOutcome> | ToolOutcome = () => ({ output: { hits: [] }, activity: "search" })): Toolbox {
  return { offer: () => ({ tools: TOOLS, perTool: { search: 6 }, kinds: { search: "search" } }), run: async (_run, call) => run(call) };
}

/** The app's own port, but with `box`, and a worker on it run by hand. */
function toolWorker(gateway: ScriptedGateway, box: Toolbox | null = toolbox(), config: Config = app.deps.config): { port: DbAgentPort; worker: AgentWorker } {
  const { db: pool, blobs, conversations, reads } = app.deps;
  const port = createAgentPort({ db: pool, config, blobs, realtime: app.realtime, conversations, reads, log: app.log, toolbox: box });
  const worker = createAgentWorker({ port, models: gateway, runTimeoutMs: config.agentRunTimeoutMs, maxRunsInFlight: 1, background: false, log: app.log, tools: config.tools });
  return { port, worker };
}

const withTools = (over: Partial<Config["tools"]>): Config => ({ ...app.deps.config, tools: { ...app.deps.config.tools, ...over } });

let txn = 0;
const say = async (who: Actor, conv: string, text: string) => {
  const sent = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `tm${++txn}` });
  expect(sent.status).toBe(201);
};

async function owned(
  name: string,
  model: typeof FREE | typeof PAID | typeof DEAR | { source: "provider"; providerId: string; model: string } = FREE,
  over: Record<string, unknown> = {},
) {
  const owner = await signUp(app, name);
  const agent = await mustCreateAgent(app, owner, { model, persona: "简短地回答。", ...over });
  return { owner, agent, conv: agent.conversationId as string };
}

/** A provider of `owner`'s with one model, `small8k`: a context of 8 192 tokens (its calls get the default 2 048 output). */
async function smallModel(owner: Actor) {
  const provider = (await api(app, owner, "POST", "/api/providers", providerBody({ models: [{ name: "small8k", contextTokens: 8192 }] }))).json;
  return { source: "provider", providerId: provider.id as string, model: "small8k" } as const;
}

const runOf = async (ownerId: string) =>
  (
    await db.query<{ id: string; status: string; error: string | null; hold: string; input_estimate: number | null }>(
      "select id, status, error, hold_micro::text as hold, input_estimate from agent_runs where owner_id = $1 and purpose = 'reply' order by created_at desc limit 1",
      [ownerId],
    )
  ).rows[0]!;
const holdOf = async (runId: string) => BigInt((await db.query<{ hold: string }>("select hold_micro::text as hold from agent_runs where id = $1", [runId])).rows[0]!.hold);
const recordsOf = async (runId: string) =>
  (
    await db.query(
      `select input_tokens::int as input, output_tokens::int as output, estimated, source, outcome, cost_micro::text as cost, free_micro::text as free,
              balance_micro::text as balance, forgiven_micro::text as forgiven
         from usage_records where run_id = $1`,
      [runId],
    )
  ).rows;
const freeUsed = async (ownerId: string) =>
  (await db.query<{ used: string }>("select coalesce(sum(used_micro), 0)::text as used from free_usage where owner_id = $1", [ownerId])).rows[0]!.used;
const balanceOf = async (ownerId: string) =>
  BigInt((await db.query<{ b: string }>("select balance_micro::text as b from accounts where principal_id = $1", [ownerId])).rows[0]!.b);
/** Someone else's spending: the owner's free allowance used today, set to `micro`. */
const setFreeUsed = (ownerId: string, micro: bigint) =>
  db.query(
    `insert into free_usage (owner_id, day, used_micro) values ($1, (now() at time zone 'Asia/Shanghai')::date, $2)
     on conflict (owner_id, day) do update set used_micro = $2`,
    [ownerId, micro.toString()],
  );

/** The text parts a call sends. */
const textsOf = (call: Pick<ModelCall, "messages">) => call.messages.flatMap((m) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])));
const isFinal = (call: ModelCall) => call.toolChoice === "none" && call.system.endsWith(`\n\n${FINAL_LINE}`);
/** A system text with the last call's line (once). */
const withLine = (system: string) => (system.endsWith(`\n\n${FINAL_LINE}`) ? system : `${system}\n\n${FINAL_LINE}`);
/**
 * The most the call after `call`'s rounds can take as input, as the hold counts it: what `call` sends — the last call's
 * line too, the tools' definitions and every step at their bytes — and what providers add around tool definitions.
 */
const nextInput = (call: ModelCall, context = CONTEXT, maxOut = MAX_OUT) =>
  holdTokens([withLine(call.system), ...textsOf(call), JSON.stringify(call.tools), JSON.stringify(call.steps ?? [])], context, maxOut) + TOOL_PREAMBLE_TOKENS;
/** The most one call of `inputTokens` can cost on a meter model. */
const callMax = (inputTokens: number) => BigInt(inputTokens) * 100n + BigInt(MAX_OUT) * 1000n;
/** The same on `pricey`. */
const dearMax = (inputTokens: number) => BigInt(inputTokens) * 1000n + 4096n * 1000n;

describe("the money of a reply that offers tools", () => {
  it("three rounds are admitted once and settled once: one usage record, its tokens the rounds' sums, charged once; the run teaches the ratio nothing", async () => {
    const gateway = scriptedGateway()
      .callTools([{ name: "search", input: { query: "a" } }], { usage: U(1000, 50) })
      .callTools([{ name: "search", input: { query: "b" } }], { usage: U(1500, 60) })
      .reply("去吃川菜。", { usage: U(2000, 70) });
    const { worker } = toolWorker(gateway);
    // On the balance: on the day's 3 free points a reply offered tools holds room for a whole-context last call (about 11
    // points on this model) and gets one round only (money-blocking.test.ts).
    const { owner, conv } = await owned("sumup", PAID);
    await grant(db, owner.id, 20n * POINT);
    await say(owner, conv, "附近有什么好吃的？");
    expect(await worker.runOnce()).toBe(true);

    expect(gateway.calls).toHaveLength(3);
    expect(gateway.calls[0]!.tools).toEqual(TOOLS);
    const run = await runOf(owner.id);
    expect(run).toMatchObject({ status: "done", hold: "0", input_estimate: null });
    const total = plus(U(1000, 50), U(1500, 60), U(2000, 70));
    const cost = costOf(total).toString();
    expect(await recordsOf(run.id)).toEqual([{ input: total.inputTokens, output: total.outputTokens, estimated: false, source: "site", outcome: "done", cost, free: "0", balance: cost, forgiven: "0" }]);
    expect(await balanceOf(owner.id)).toBe(20n * POINT - BigInt(cost));
    expect((await db.query("select count(*)::int as n from token_ratios")).rows[0].n).toBe(0);
  });

  it("the hold for the next round is what the reply has cost so far and the most that round can cost", async () => {
    const gateway = scriptedGateway()
      .callTools([{ name: "search", input: { query: "a" } }], { usage: U(1000, 50) })
      .callTools([{ name: "search", input: { query: "b" } }], { usage: U(1500, 60) });
    const third = gateway.hang();
    const { worker } = toolWorker(gateway);
    const { owner, conv } = await owned("holder", PAID);
    await grant(db, owner.id, 20n * POINT);
    await say(owner, conv, "附近有什么好吃的？");
    const running = worker.runOnce();
    const call = await third.reached;
    const run = await runOf(owner.id);
    // The text of the call the hold is for — the conversation, the tools and both rounds — at its bytes, and what
    // providers add around tool definitions.
    expect(await holdOf(run.id)).toBe(costOf(plus(U(1000, 50), U(1500, 60))) + callMax(nextInput(call)));
    third.release("好。", { usage: U(2000, 70) });
    await running;
    expect(await holdOf(run.id)).toBe(0n);
  });

  it("maxPoints: once the reply has spent it, or its next round could take it past it, the next call is the last; it is charged at most maxPoints and that one call", async () => {
    // Spent: the first round alone costs a point (1 000 × 100 + 900 × 1 000), the cap.
    const spent = scriptedGateway().callTools([{ name: "search", input: { query: "a" } }], { usage: U(1000, 900) }).reply("就这样。", { usage: U(1000, 100) });
    const { worker } = toolWorker(spent, toolbox(), withTools({ maxPoints: 1 }));
    const a = await owned("capped", PAID);
    await grant(db, a.owner.id, 20n * POINT);
    await say(a.owner, a.conv, "查一查");
    await worker.runOnce();
    expect(spent.calls).toHaveLength(2);
    expect(isFinal(spent.calls[1]!)).toBe(true);
    expect(await recordsOf((await runOf(a.owner.id)).id)).toMatchObject([{ cost: costOf(U(2000, 1000)).toString(), outcome: "done" }]);

    // Could pass it: one point spent of two, and the next round could cost more than the point left — a round is
    // never started that could take the reply past the cap.
    const could = scriptedGateway().callTools([{ name: "search", input: { query: "a" } }], { usage: U(1000, 900) }).reply("就这样。", { usage: U(1000, 50) });
    const second = toolWorker(could, toolbox(), withTools({ maxPoints: 2 }));
    const b = await owned("capped2", PAID);
    await grant(db, b.owner.id, 20n * POINT);
    await say(b.owner, b.conv, "查一查");
    await second.worker.runOnce();
    expect(could.calls).toHaveLength(2);
    expect(isFinal(could.calls[1]!)).toBe(true);
    const [record] = await recordsOf((await runOf(b.owner.id)).id);
    expect(BigInt(record.balance)).toBeLessThanOrEqual(2n * POINT + callMax(nextInput(could.calls[1]!)));
    expect(record.balance).toBe(costOf(U(2000, 950)).toString());
  });

  it("the review's case: 6 points of balance, six searches of 3 000 weight each — the last call is held at its own most, every step it carries, above what is left; the reply is charged in full, nothing forgiven", async () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ name: "search", input: { query: `第${i}家` } }));
    const gateway = scriptedGateway().callTools(six, { usage: U(1200, 100) });
    const last = gateway.hang();
    const { worker } = toolWorker(gateway, toolbox(() => ({ output: "川".repeat(3000), activity: "search" })));
    const { owner, conv } = await owned("sixpoints", PAID);
    await grant(db, owner.id, 6n * POINT);
    await say(owner, conv, "附近有什么好吃的？");
    const running = worker.runOnce();
    const call = await last.reached;
    expect(isFinal(call)).toBe(true);
    const run = await runOf(owner.id);
    const spent = costOf(U(1200, 100));
    const ordinary = callMax(holdTokens([gateway.calls[0]!.system, ...textsOf(call)], CONTEXT, MAX_OUT));
    const most = callMax(nextInput(call));
    // An ordinary call's most would fit what is left; the last call's own most does not — it is held all the same.
    expect(spent + ordinary).toBeLessThan(6n * POINT);
    expect(spent + most).toBeGreaterThan(6n * POINT);
    expect(await holdOf(run.id)).toBe(spent + most);
    last.release("川菜馆有六家。", { usage: U(19_500, 300) });
    await running;
    const total = plus(U(1200, 100), U(19_500, 300));
    const cost = costOf(total);
    expect(cost).toBe(2_470_000n);
    expect(await recordsOf(run.id)).toEqual([
      { input: total.inputTokens, output: total.outputTokens, estimated: false, source: "site", outcome: "done", cost: cost.toString(), free: "0", balance: cost.toString(), forgiven: "0" },
    ]);
    expect(await balanceOf(owner.id)).toBe(6n * POINT - cost);
    expect(await holdOf(run.id)).toBe(0n);
  });

  it("the dearest model, at the default limits: six searches and four file reads of 3 000 weight, then the last call held at its own most; reported, nothing is forgiven; unreported, at most what its output estimate passes its output limit by", async () => {
    const box: Toolbox = {
      offer: () => ({ tools: [SEARCH, READ], perTool: { search: 6, read_file: 4 }, kinds: { search: "search", read_file: "file" } }),
      run: async (_run, call) => ({ output: "川".repeat(3000), activity: call.name === "read_file" ? "file" : "search" }),
    };
    const ten = [
      ...Array.from({ length: 6 }, (_, i) => ({ name: "search", input: { query: `第${i}家` } })),
      ...Array.from({ length: 4 }, (_, i) => ({ name: "read_file", input: { name: `菜单${i}.txt` } })),
    ];

    // Every round reported: the last call's real cost (32 000 tokens in, its whole output) is within its hold.
    const reported = scriptedGateway().callTools(ten, { usage: U(2000, 300) });
    const last = reported.hang();
    const a = await owned("dearreported", DEAR);
    await grant(db, a.owner.id, 60n * POINT);
    await say(a.owner, a.conv, "附近有什么好吃的？");
    const running = toolWorker(reported, box).worker.runOnce();
    const call = await last.reached;
    expect(isFinal(call)).toBe(true);
    const run = await runOf(a.owner.id);
    const spent = 2000n * 1000n + 300n * 1000n;
    expect(await holdOf(run.id)).toBe(spent + dearMax(nextInput(call, 100_000, 4096)));
    last.release("答案。", { usage: U(32_000, 4096) });
    await running;
    const cost = ((2000n + 32_000n) * 1000n + (300n + 4096n) * 1000n).toString();
    expect(await recordsOf(run.id)).toMatchObject([{ estimated: false, cost, balance: cost, forgiven: "0" }]);

    // The last call reported nothing: it is settled on its estimate. Its input's estimate is at most its bytes, which
    // the hold counts; only its output's (`weight`, not tokens) can pass what is held for it, its output limit — by
    // 904 000 here, which the input's estimate, about 62 000 tokens under its bytes, more than makes up: nothing is
    // forgiven.
    const text = "答".repeat(5000);
    const unreported = scriptedGateway().callTools(ten, { usage: U(2000, 300) }).reply(text, { usage: null });
    const b = await owned("dearestimated", DEAR);
    await grant(db, b.owner.id, 60n * POINT);
    await say(b.owner, b.conv, "附近有什么好吃的？");
    expect(await toolWorker(unreported, box).worker.runOnce()).toBe(true);
    const [record] = await recordsOf((await runOf(b.owner.id)).id);
    expect(record).toMatchObject({ estimated: true });
    expect(BigInt(Math.max(0, estimateTokens(text) - 4096)) * 1000n).toBe(904_000n);
    expect(record.forgiven).toBe("0");
  });

  it("the dearest model, a later call that reported nothing and wrote far past its output limit (a long Latin answer, a small input): what its estimate passes its hold by — its output's estimate over the limit, less what its input's estimate is under its bytes — is forgiven, exactly", async () => {
    const gateway = scriptedGateway().callTools([{ name: "search", input: { query: "a" } }], { usage: U(2000, 300) });
    const last = gateway.hang();
    const { owner, conv } = await owned("dearlatin", DEAR);
    await grant(db, owner.id, 60n * POINT);
    await say(owner, conv, "附近有什么好吃的？");
    const running = toolWorker(gateway).worker.runOnce();
    const call = await last.reached;
    expect(isFinal(call)).toBe(false);
    const run = await runOf(owner.id);
    // Held for it: what the first round cost, and the most this call can send at its bytes and its whole output.
    const hold = (2000n + 300n) * 1000n + dearMax(nextInput(call, 100_000, 4096));
    expect(await holdOf(run.id)).toBe(hold);
    const text = "a".repeat(20_000);
    last.release(text, { usage: null });
    await running;

    const [record] = await recordsOf(run.id);
    expect(record).toMatchObject({ estimated: true, source: "site" });
    // Settled on the first round's report and this call's estimate: its input (the conversation, the tools and the
    // step it carried, in weight) and what it wrote — 6 667 tokens by weight, 2 571 past its output limit.
    const input = estimateTokens(call.system) + textsOf(call).reduce((n, t) => n + estimateTokens(t), 0) + estimateTokens(JSON.stringify(call.tools) + JSON.stringify(call.steps));
    expect([record.input, record.output]).toEqual([2000 + input, 300 + estimateTokens(text)]);
    const cost = BigInt(record.input + record.output) * 1000n;
    expect(record.cost).toBe(cost.toString());
    // Charged up to the hold; what passes it is forgiven, and it is less than the output's overshoot alone.
    const forgiven = cost - hold;
    expect(forgiven).toBeGreaterThan(0n);
    expect(forgiven).toBeLessThan(BigInt(estimateTokens(text) - 4096) * 1000n);
    expect(record).toMatchObject({ balance: hold.toString(), forgiven: forgiven.toString() });
    expect(await holdOf(run.id)).toBe(0n);
  });

  it("a hold is never lowered: whatever extend answers — another round or the last call — the run holds at least what it held before", async () => {
    const { port } = toolWorker(scriptedGateway());
    const { owner, conv } = await owned("neverlower", PAID);
    await grant(db, owner.id, 10n * POINT);
    await say(owner, conv, "你好");
    const ticket = (await port.claimNext())!;
    const prepared = (await port.begin(ticket)) as Prepared;
    expect(isRunEnd(prepared)).toBe(false);
    // Admission holds the call's text and the tools' definitions at their bytes, and what providers add around them.
    const admitted = callMax(holdTokens([prepared.call.system, ...textsOf(prepared.call), JSON.stringify(TOOLS)], CONTEXT, MAX_OUT) + TOOL_PREAMBLE_TOKENS);
    expect(await holdOf(ticket.id)).toBe(admitted);

    const none = { inputChars: 0, outputChars: 0 };
    // What is left of the balance, the run's own hold added back, stays 10 points throughout (nothing else runs).
    const steps: Array<{ spent: ReturnType<typeof U>; next: number; answer: "ok" | "final" | "stop"; hold: (before: bigint) => bigint }> = [
      // A next call cheaper than the hold: another round, the hold kept as it is (not lowered to what was asked).
      { spent: U(100, 10), next: 100, answer: "ok", hold: (before) => before },
      // Within what is left: raised.
      { spent: U(100, 10), next: 60_000, answer: "ok", hold: () => costOf(U(100, 10)) + callMax(60_000) },
      // Cheap again: kept.
      { spent: U(100, 10), next: 100, answer: "ok", hold: (before) => before },
      // Past what is left, while something is left after what was spent: the last call, held at its own most, above it.
      { spent: U(1000, 100), next: 95_000, answer: "final", hold: () => costOf(U(1000, 100)) + callMax(95_000) },
      // Spent exactly what is left: the last call all the same — a reply that has started is never refused for money —,
      // held at what was spent and its most, past what is left.
      { spent: U(0, 10_000), next: 100, answer: "final", hold: () => costOf(U(0, 10_000)) + callMax(100) },
      // Spent a hundred micro-points less: the last call; what it asks is below the hold, which is kept.
      { spent: U(9, 9_999), next: 100, answer: "final", hold: (before) => before },
      // And cheap again after it: kept.
      { spent: U(9, 9_999), next: 100, answer: "final", hold: (before) => before },
    ];
    for (const [i, step] of steps.entries()) {
      const before = await holdOf(ticket.id);
      const answer = await port.extend(ticket, step.spent, none, step.next);
      const after = await holdOf(ticket.id);
      expect({ i, answer, after }).toEqual({ i, answer: step.answer, after: step.hold(before) });
      expect(after).toBeGreaterThanOrEqual(before);
    }
  });

  it("two replies of one owner extending at the same moment cannot both take the same headroom: the account's lock lets one through, and the other gets the last call", async () => {
    const owner = await signUp(app, "twins");
    const first = await mustCreateAgent(app, owner, { model: PAID, persona: "简短地回答。" });
    const second = await mustCreateAgent(app, owner, { model: PAID, persona: "简短地回答。" });
    await grant(db, owner.id, 8n * POINT);
    await say(owner, first.conversationId, "你好");
    await say(owner, second.conversationId, "你好");
    const { port } = toolWorker(scriptedGateway());
    const tickets = [(await port.claimNext())!, (await port.claimNext())!];
    for (const t of tickets) expect(isRunEnd(await port.begin(t))).toBe(false);
    const holds = await Promise.all(tickets.map((t) => holdOf(t.id)));
    // Each asks for 5.2 points: what is left after both admissions holds one such raise, not two.
    const spent = U(1000, 100);
    const wanted = costOf(spent) + callMax(40_000);
    expect(wanted).toBe(5_200_000n);
    expect(wanted).toBeLessThanOrEqual(8n * POINT - holds[1]!);
    expect(wanted).toBeLessThanOrEqual(8n * POINT - holds[0]!);
    expect(2n * wanted).toBeGreaterThan(8n * POINT);

    // Both wait on the owner's account row (the second behind the first), so both have read nothing yet when the first
    // goes on.
    const holder = await db.pool.connect();
    let answers: string[];
    try {
      await holder.query("begin");
      await holder.query("select 1 from accounts where principal_id = $1 for update", [owner.id]);
      const extending = Promise.all(tickets.map((t) => port.extend(t, spent, { inputChars: 0, outputChars: 0 }, 40_000)));
      await vi.waitFor(
        async () =>
          expect(
            (
              await db.query<{ n: number }>(
                "select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%from accounts where principal_id = $1 for update%'",
              )
            ).rows[0]!.n,
          ).toBe(2),
        { timeout: 5_000 },
      );
      await holder.query("commit");
      answers = await extending;
    } finally {
      await holder.query("rollback").catch(() => {});
      holder.release();
    }
    expect([...answers].sort()).toEqual(["final", "ok"]);
    // Both are held at what they asked: the second above what was left for it, as a last call may be.
    expect(await Promise.all(tickets.map((t) => holdOf(t.id)))).toEqual([wanted, wanted]);
  });

  it("the free allowance, what is left between an ordinary call's most and the last call's own most: the last call, made within the room the reply kept for it from its admission (its hold is not raised); with nothing left after what was spent, the last call all the same — and the free allowance is never overdrawn (what passes it is forgiven), nor the balance touched", async () => {
    const hits = "川".repeat(3000);
    const two = [
      { name: "search", input: { query: "a" } },
      { name: "search", input: { query: "b" } },
    ];
    // Someone else's spending leaves `left` of the day's 3 free points while the first round's tools run; the reply's
    // hold then (its admission's) is kept in `held`.
    const held: bigint[] = [];
    const leaving = (ownerId: string, left: bigint) => async (): Promise<ToolOutcome> => {
      await setFreeUsed(ownerId, 3n * POINT - left);
      held.push(await holdOf((await runOf(ownerId)).id));
      return { output: hits, activity: "search" };
    };

    // 2 points left: an ordinary call's most would fit, the last call's own most (its two steps) does not.
    const leave = 2n * POINT;
    const w = await owned("headwindow");
    const windowGateway = scriptedGateway().callTools(two, { usage: U(1000, 50) });
    const last = windowGateway.hang();
    await say(w.owner, w.conv, "查一查");
    const running = toolWorker(windowGateway, toolbox(leaving(w.owner.id, leave))).worker.runOnce();
    const call = await last.reached;
    expect(isFinal(call)).toBe(true);
    const run = await runOf(w.owner.id);
    const spent = costOf(U(1000, 50));
    const ordinary = callMax(holdTokens([windowGateway.calls[0]!.system, ...textsOf(call)], CONTEXT, MAX_OUT));
    const most = callMax(nextInput(call));
    expect(spent + ordinary).toBeLessThanOrEqual(leave);
    expect(spent + most).toBeGreaterThan(leave);
    // Its admission held its first call and room for a last call after one more round (README "Metering", The free
    // allowance's room: the first call's input and what one round can bring back — 6 searches of at most 3 × 3 000 bytes
    // and 200 of framing, 6 bytes an output token, 300 — at most the whole context): the last call fits in it.
    const firstInput = holdTokens([windowGateway.calls[0]!.system, ...textsOf(windowGateway.calls[0]!), JSON.stringify(TOOLS)], CONTEXT, MAX_OUT) + TOOL_PREAMBLE_TOKENS;
    const firstCall = callMax(firstInput);
    const growth = 6 * (3 * app.deps.config.tools.resultMaxWeight + 200) + 6 * MAX_OUT + 300;
    const lastCallRoom = callMax(Math.min(firstInput + growth, CONTEXT - MAX_OUT + TOOL_PREAMBLE_TOKENS));
    expect([...new Set(held)]).toEqual([firstCall + lastCallRoom]);
    expect(spent + most).toBeLessThanOrEqual(held[0]!);
    expect(await holdOf(run.id)).toBe(held[0]);
    last.release("就这两家。", { usage: U(3000, 100) });
    await running;
    const cost = costOf(plus(U(1000, 50), U(3000, 100)));
    expect(await recordsOf(run.id)).toMatchObject([{ cost: cost.toString(), free: cost.toString(), balance: "0", forgiven: "0" }]);
    expect(await freeUsed(w.owner.id)).toBe((3n * POINT - leave + cost).toString());

    // Nothing left: what the reply has spent is not covered — the last call all the same (a reply that has started is
    // never refused for money), and it answers. What it wrote before its tool was its acknowledgement, posted then; the
    // answer follows it. On the allowance, what passes what is left of it is forgiven; the balance it also has is never
    // moved to.
    const dear = await owned("headstop");
    await grant(db, dear.owner.id, 20n * POINT);
    const stopGateway = scriptedGateway()
      .callTools([{ name: "search", input: { query: "a" } }], { usage: U(1000, 500), text: "我先查一下。" })
      .reply("就这样。", { usage: U(500, 100) });
    await say(dear.owner, dear.conv, "查一查");
    expect(await toolWorker(stopGateway, toolbox(leaving(dear.owner.id, 0n))).worker.runOnce()).toBe(true);
    expect(stopGateway.calls).toHaveLength(2);
    expect(isFinal(stopGateway.calls[1]!)).toBe(true);
    const dearRun = await runOf(dear.owner.id);
    expect(dearRun).toMatchObject({ status: "done", hold: "0" });
    const replies = (await api(app, dear.owner, "GET", `/api/conversations/${dear.conv}/messages`)).json.messages.filter((m: any) => m.senderId === dear.agent.id);
    expect(replies).toHaveLength(2);
    expect(replies[0]).toMatchObject({ text: "我先查一下。", ack: true });
    expect(replies[1]).toMatchObject({ text: "就这样。" });
    expect(replies[1].truncated ?? false).toBe(false);
    const dearCost = (costOf(U(1000, 500)) + costOf(U(500, 100))).toString();
    expect(await recordsOf(dearRun.id)).toMatchObject([{ cost: dearCost, free: "0", balance: "0", forgiven: dearCost }]);
    expect(await freeUsed(dear.owner.id)).toBe("3000000");
    expect(await balanceOf(dear.owner.id)).toBe(20n * POINT);

    // A cheap first round, nothing written: the last call answers all the same.
    const mute = await owned("headmute");
    const muteGateway = scriptedGateway().callTools([{ name: "search", input: { query: "a" } }], { usage: U(10, 1) }).reply("好。", { usage: U(10, 1) });
    await say(mute.owner, mute.conv, "查一查");
    expect(await toolWorker(muteGateway, toolbox(leaving(mute.owner.id, 0n))).worker.runOnce()).toBe(true);
    expect(muteGateway.calls).toHaveLength(2);
    expect(await runOf(mute.owner.id)).toMatchObject({ status: "done", error: null, hold: "0" });
    expect(await freeUsed(mute.owner.id)).toBe("3000000");
  });

  it("a later round the upstream refuses (400): the ordinary call that follows is held at its own most on top of what was spent, and the hold is not lowered for it", async () => {
    const gateway = scriptedGateway()
      .callTools([{ name: "search", input: { query: "a" } }], { usage: U(1000, 50) })
      .fail("provider_unavailable", { status: 400 });
    const plain = gateway.hang();
    const { worker } = toolWorker(gateway, toolbox(() => ({ output: "川".repeat(3000), activity: "search" })));
    const { owner, conv } = await owned("plainhold", PAID);
    await grant(db, owner.id, 20n * POINT);
    await say(owner, conv, "查一查");
    const running = worker.runOnce();
    const call = await plain.reached;
    expect(call).not.toHaveProperty("tools");
    expect(call).not.toHaveProperty("steps");
    const run = await runOf(owner.id);
    const spent = costOf(U(1000, 50));
    // Held for the second round (its step of 3 000 weight): more than the ordinary call's most, and kept.
    const second = gateway.calls[1]!;
    const ordinary = callMax(holdTokens([call.system, ...textsOf(call)], CONTEXT, MAX_OUT));
    expect(spent + callMax(nextInput(second))).toBeGreaterThan(spent + ordinary);
    expect(await holdOf(run.id)).toBe(spent + callMax(nextInput(second)));
    plain.release("不查也能说：川菜。", { usage: U(800, 20) });
    await running;
    const cost = costOf(plus(U(1000, 50), U(800, 20))).toString();
    expect(await recordsOf(run.id)).toMatchObject([{ estimated: false, cost, balance: cost, forgiven: "0" }]);
  });

  it("the Agent's others' daily budget reached mid-run by what the reply has cost: the next call is the last", async () => {
    const owner = await signUp(app, "budgetowner");
    const member = await signUp(app, "budgetmember");
    const g = await group(app, owner, "饭搭子", [member, await signUp(app, "budgetthird")]);
    // A paid model and a balance of 20 points: nothing but the budget stops a round.
    const agent = await mustCreateAgent(app, owner, { handle: "chef", name: "chef", model: PAID, persona: "简短地回答。", othersBudget: "1" });
    await grant(db, owner.id, 20n * POINT);
    await db.query("insert into memberships (conversation_id, principal_id, role, joined_seq) select $1, $2, 'speaker', seq from conversations where id = $1", [g, agent.id]);
    // A point: the budget, reached by the first round alone.
    const gateway = scriptedGateway().callTools([{ name: "search", input: { query: "a" } }], { usage: U(1000, 900) }).reply("就这样。", { usage: U(100, 10) });
    const { worker } = toolWorker(gateway);
    await say(member, g, "@chef 附近有什么好吃的？");
    expect(await worker.runOnce()).toBe(true);
    expect(gateway.calls).toHaveLength(2);
    expect(isFinal(gateway.calls[1]!)).toBe(true);
    expect(await runOf(owner.id)).toMatchObject({ status: "done", hold: "0" });
  });

  it("stopped during its third round, which reported nothing: the first two rounds' reported tokens, their hidden reasoning in them, are charged; the third's estimate is added; the raised hold is released", async () => {
    const gateway = scriptedGateway()
      .callTools([{ name: "search", input: { query: "a" } }], { usage: U(1000, 900), reasoning: "想".repeat(50) })
      .callTools([{ name: "search", input: { query: "b" } }], { usage: U(1500, 950), reasoning: "再想".repeat(30) });
    const third = gateway.hangAfter("我查到了一些，");
    const { port, worker } = toolWorker(gateway);
    const { owner, conv } = await owned("stopthird", PAID);
    await grant(db, owner.id, 20n * POINT);
    await say(owner, conv, "附近有什么好吃的？");
    const running = worker.runOnce();
    const call = await third.reached;
    expect(isFinal(call)).toBe(false);
    const run = await runOf(owner.id);
    expect(await holdOf(run.id)).toBe(costOf(plus(U(1000, 900), U(1500, 950))) + callMax(nextInput(call)));
    port.requestStop(run.id);
    await running;

    // Round 3's estimate: the conversation, the tools and both steps it carried; what it wrote before the stop.
    const thirdInput = estimateTokens(call.system) + textsOf(call).reduce((n, t) => n + estimateTokens(t), 0) + estimateTokens(JSON.stringify(TOOLS) + JSON.stringify(call.steps));
    const tokens = { input: 1000 + 1500 + thirdInput, output: 900 + 950 + estimateTokens("我查到了一些，") };
    const cost = costOf(U(tokens.input, tokens.output)).toString();
    expect(await recordsOf(run.id)).toEqual([{ ...tokens, estimated: true, source: "site", outcome: "stopped", cost, free: "0", balance: cost, forgiven: "0" }]);
    expect(await runOf(owner.id)).toMatchObject({ status: "stopped", hold: "0" });
  });

  it("a raised hold is released by every other ending of the tool phase too: a later round's failure, the reply's time running out, the service closing", async () => {
    // A later round fails (502): settled on the round that completed, failed.
    const failing = scriptedGateway()
      .callTools([{ name: "search", input: { query: "a" } }], { usage: U(1000, 50) })
      .fail("provider_unavailable", { status: 502 });
    const a = await owned("endfailed", PAID);
    await grant(db, a.owner.id, 20n * POINT);
    await say(a.owner, a.conv, "查一查");
    expect(await toolWorker(failing, toolbox()).worker.runOnce()).toBe(true);
    const failedRun = await runOf(a.owner.id);
    expect(failedRun).toMatchObject({ status: "failed", error: "provider_unavailable", hold: "0" });
    const failedCost = costOf(U(1000, 50)).toString();
    expect(await recordsOf(failedRun.id)).toMatchObject([{ input: 1000, output: 50, estimated: false, outcome: "failed", cost: failedCost, balance: failedCost }]);

    // The reply's time (TOOLS.runTimeoutMs) runs out in its second round: what it wrote before its tool was its
    // acknowledgement, posted then, and it wrote nothing after it — failed as a reply that timed out having said nothing;
    // settled on the first round's usage and the second's estimate.
    const slow = scriptedGateway().callTools([{ name: "search", input: { query: "a" } }], { usage: U(1000, 50), text: "我先查一下。" });
    const hung = slow.hang();
    const b = await owned("endtimeout", PAID);
    await grant(db, b.owner.id, 20n * POINT);
    await say(b.owner, b.conv, "查一查");
    const timing = toolWorker(slow, toolbox(), withTools({ runTimeoutMs: 1_000 })).worker.runOnce();
    await hung.reached;
    const raised = await holdOf((await runOf(b.owner.id)).id);
    expect(raised).toBeGreaterThan(costOf(U(1000, 50)));
    await timing;
    const timedOut = await runOf(b.owner.id);
    expect(timedOut).toMatchObject({ status: "failed", error: "provider_unavailable", hold: "0" });
    const said = (await api(app, b.owner, "GET", `/api/conversations/${b.conv}/messages`)).json.messages.filter((m: any) => m.senderId === b.agent.id);
    expect(said).toMatchObject([{ text: "我先查一下。", ack: true }]);
    const [timedRecord] = await recordsOf(timedOut.id);
    expect(timedRecord).toMatchObject({ estimated: true, outcome: "failed", forgiven: "0" });
    expect(timedRecord.input).toBeGreaterThan(1000);
    expect(timedRecord.output).toBe(50);

    // The service closes during the second round: the run is released as recovery releases one — nothing charged.
    const closing = scriptedGateway().callTools([{ name: "search", input: { query: "a" } }], { usage: U(1000, 50) });
    const open = closing.hang();
    const c = await owned("endclosing", PAID);
    await grant(db, c.owner.id, 20n * POINT);
    await say(c.owner, c.conv, "查一查");
    const { worker } = toolWorker(closing, toolbox());
    const closed = worker.runOnce();
    await open.reached;
    const closingRun = await runOf(c.owner.id);
    expect(await holdOf(closingRun.id)).toBeGreaterThan(costOf(U(1000, 50)));
    await worker.stop();
    await closed;
    expect(await runOf(c.owner.id)).toMatchObject({ status: "failed", error: "provider_unavailable", hold: "0" });
    expect(await recordsOf(closingRun.id)).toMatchObject([{ cost: "0", balance: "0" }]);
    expect(await balanceOf(c.owner.id)).toBe(20n * POINT);
  });

  it("a crashed run with a raised hold is swept after 2 × max(AGENT_RUN_TIMEOUT_MS, TOOLS.runTimeoutMs) + 1 minute, and its hold released", async () => {
    // 2 × max(120 000, 300 000) + 60 000 = 660 000 ms: 11 minutes.
    expect(staleAfterMs(app.deps.config)).toBe(660_000);
    expect(staleAfterMs({ agentRunTimeoutMs: 600_000, tools: { runTimeoutMs: 300_000 } })).toBe(2 * 600_000 + 60_000);

    const { port } = toolWorker(scriptedGateway());
    const { owner, conv } = await owned("crashed", PAID);
    await grant(db, owner.id, 20n * POINT);
    await say(owner, conv, "你好");
    const ticket = (await port.claimNext())!;
    const prepared = await port.begin(ticket);
    expect(isRunEnd(prepared)).toBe(false);
    expect((prepared as Prepared).tools).toEqual(TOOLS);
    const admitted = await holdOf(ticket.id);
    // Raised as a reply between its rounds raises it: what one round cost and the most the next can cost.
    expect(await port.extend(ticket, U(1000, 100), { inputChars: 0, outputChars: 0 }, 5000)).toBe("ok");
    expect(await holdOf(ticket.id)).toBe(costOf(U(1000, 100)) + callMax(5000));
    expect(await holdOf(ticket.id)).not.toBe(admitted);

    const age = (minutes: number) => db.query("update agent_runs set started_at = now() - make_interval(mins => $2) where id = $1", [ticket.id, minutes]);
    await age(10);
    expect(await app.staleRunSweep.run()).toBe(0);
    await age(12);
    expect(await app.staleRunSweep.run()).toBe(1);
    expect(await runOf(owner.id)).toMatchObject({ status: "failed", error: "provider_unavailable", hold: "0" });
    expect(await recordsOf(ticket.id)).toMatchObject([{ cost: "0", free: "0", balance: "0" }]);
    expect(await freeUsed(owner.id)).toBe("0");
  });

  it("a provider's model: nothing held, nothing charged, and the loop still bounded by its rounds", async () => {
    const owner = await signUp(app, "ownmodel");
    const provider = (await api(app, owner, "POST", "/api/providers", providerBody({ models: [{ name: "mine" }] }))).json;
    const agent = await mustCreateAgent(app, owner, { model: { source: "provider", providerId: provider.id, model: "mine" }, persona: "简短地回答。" });
    const gateway = scriptedGateway();
    for (let i = 0; i < 8; i++) gateway.callTools([{ name: "search", input: { query: `第${i}次` } }], { usage: U(100_000, 1000) });
    const last = gateway.hang();
    const { worker } = toolWorker(gateway);
    await say(owner, agent.conversationId, "查到底");
    const running = worker.runOnce();
    const call = await last.reached;
    expect(isFinal(call)).toBe(true);
    const run = await runOf(owner.id);
    expect(await holdOf(run.id)).toBe(0n);
    last.release("够了。", { usage: U(100_000, 1000) });
    await running;
    expect(gateway.calls).toHaveLength(9);
    expect(await recordsOf(run.id)).toMatchObject([{ source: "provider", cost: "0", free: "0", balance: "0", input: 900_000, output: 9000 }]);
  });

  it("a provider's model in a lane with a daily budget: extend answers ok while the budget is not reached, and final once what is settled reaches it — nothing held either way, its owner's account never waited on", async () => {
    const owner = await signUp(app, "ownbudget");
    const member = await signUp(app, "ownbudgetmember");
    const g = await group(app, owner, "饭搭子", [member, await signUp(app, "ownbudgetthird")]);
    const provider = (await api(app, owner, "POST", "/api/providers", providerBody({ models: [{ name: "mine" }] }))).json;
    const model = { source: "provider", providerId: provider.id as string, model: "mine" } as const;
    // Someone else's call, in the others' lane; its daily budget a point.
    const agent = await mustCreateAgent(app, owner, { handle: "ownchef", name: "ownchef", model, persona: "简短地回答。", othersBudget: "1" });
    await db.query("insert into memberships (conversation_id, principal_id, role, joined_seq) select $1, $2, 'speaker', seq from conversations where id = $1", [g, agent.id]);
    await grant(db, owner.id, 20n * POINT);
    await say(member, g, "@ownchef 附近有什么好吃的？");
    const { port } = toolWorker(scriptedGateway());
    const ticket = (await port.claimNext())!;
    expect(isRunEnd(await port.begin(ticket))).toBe(false);
    const none = { inputChars: 0, outputChars: 0 };
    // However much the reply has used and its next call could send: it costs nothing.
    const extend = async () => {
      // Someone holds the owner's account row: nothing here waits on it.
      const holder = await db.pool.connect();
      try {
        await holder.query("begin");
        await holder.query("select 1 from accounts where principal_id = $1 for update", [owner.id]);
        return await Promise.race([
          port.extend(ticket, U(100_000, 1000), none, 99_000),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("extend waited on the owner's account")), 3_000)),
        ]);
      } finally {
        await holder.query("rollback").catch(() => {});
        holder.release();
      }
    };

    // The budget not reached: another round.
    expect(await extend()).toBe("ok");
    expect(await holdOf(ticket.id)).toBe(0n);
    // An earlier reply of the Agent's to someone else, on a site model, settled today at a point: the budget is reached,
    // and the next call is the last.
    await paidReply(db, { agentId: agent.id, ownerId: owner.id, conversationId: g, lane: "others", micro: POINT });
    expect(await extend()).toBe("final");
    expect(await holdOf(ticket.id)).toBe(0n);
  });

  it("TOOLS.enabled false: no reply is offered tools, whatever the port could offer; the reply is one call, as before, and teaches the ratio", async () => {
    const gateway = scriptedGateway().reply("你好。", { usage: U(300, 10) });
    const { worker } = toolWorker(gateway, toolbox(), withTools({ enabled: false }));
    const { owner, conv } = await owned("notools");
    await say(owner, conv, "你好");
    await worker.runOnce();
    expect(gateway.calls).toHaveLength(1);
    expect(gateway.calls[0]).not.toHaveProperty("tools");
    expect(gateway.calls[0]).not.toHaveProperty("toolChoice");
    expect((await runOf(owner.id)).input_estimate).not.toBe(null);
  });
});

describe("the tools' definitions, and room for what they bring back, in the context plan", () => {
  /**
   * The system text's line saying the reply has no tools, with the line break before it: a reply offered tools is told
   * the tools' passage in its place (agents/runtime/prompt.ts `toolsPassage`), so its plan is made with that text.
   */
  const NO_TOOLS_LINE = `\n${NO_TOOLS}`;
  const PASSAGE_LINES = `\n${toolsPassage(false)}`;
  /** `system` as a reply offered tools would have it. */
  const offered = (system: string) => {
    expect(system).toContain(NO_TOOLS_LINE);
    return system.replace(NO_TOOLS_LINE, PASSAGE_LINES);
  };
  /** A toolbox offering `BIG`. */
  const big: Toolbox = { offer: () => ({ tools: [BIG], perTool: { search: 6 }, kinds: { search: "search" } }), run: async () => ({ output: { hits: [] }, activity: "search" }) };

  it("a small model whose system text leaves the conversation a few hundred tokens, too few beside 600 of tool definitions: no tools are offered, and the reply is one call, as one without tools", async () => {
    const owner = await signUp(app, "smallplan");
    const model = await smallModel(owner);
    // A persona that leaves the conversation about 465 tokens of the 8 192 − 2 048 (as the review's case: 10 % of what
    // the system text leaves is about that much).
    const agent = await mustCreateAgent(app, owner, { name: "小", model, persona: "简".repeat(5120) });
    const gateway = scriptedGateway().reply("去吃川菜。", { usage: U(6000, 10) });
    await say(owner, agent.conversationId, "附近有什么好吃的？");
    expect(await toolWorker(gateway, big).worker.runOnce()).toBe(true);

    expect(gateway.calls).toHaveLength(1);
    const call = gateway.calls[0]!;
    expect(call).not.toHaveProperty("tools");
    expect(call).not.toHaveProperty("toolChoice");
    expect(textsOf(call)).toEqual(["附近有什么好吃的？"]);
    // What the system text leaves the conversation, and what the tools would leave of it.
    const definitions = estimateTokens(JSON.stringify([BIG]), TOOL_TEXT_FACTOR);
    // About 600 weight of JSON, planned at 1.5 tokens a weight.
    expect(definitions).toBeGreaterThan(840);
    expect(definitions).toBeLessThan(960);
    const room = contextBudget(8192, call.maxOutputTokens, { rest: call.system, passage: "" });
    expect(room).toBeGreaterThan(400);
    expect(room).toBeLessThan(530);
    // With the tools offered the system text would have the tools' passage in place of its line saying there are none.
    expect(contextBudget(8192, call.maxOutputTokens, { rest: offered(call.system), passage: "" }, 1, definitions + TOOL_PREAMBLE_TOKENS)).toBeLessThan(
      estimateTokens("附近有什么好吃的？"),
    );
    // Exactly a reply without tools: answered, and its estimate recorded for the ratio.
    expect(await runOf(owner.id)).toMatchObject({ status: "done" });
    expect((await runOf(owner.id)).input_estimate).not.toBe(null);
  });

  it("a model with room: the tools are offered and their reservation is taken from the conversation's plan — fewer older messages are shown than to the same conversation without tools; on a model this small the room for what the tools bring back is a third of what the conversation would get", async () => {
    const owner = await signUp(app, "roomyplan");
    const model = await smallModel(owner);
    const tooled = await mustCreateAgent(app, owner, { name: "甲", model, persona: "简短地回答。" });
    const plain = await mustCreateAgent(app, owner, { name: "乙", model, persona: "简短地回答。" });
    // 24 older messages of 310 weight each, then the question: more than either plan holds.
    const older = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, "0")}${"字".repeat(309)}`);
    for (const agent of [tooled, plain]) {
      for (const text of older) await say(owner, agent.conversationId, text);
      await say(owner, agent.conversationId, "附近有什么好吃的？");
    }
    const withBox = scriptedGateway().reply("好。");
    expect(await toolWorker(withBox, big).worker.runOnce()).toBe(true);
    const without = scriptedGateway().reply("好。");
    expect(await toolWorker(without, null).worker.runOnce()).toBe(true);
    const [a, b] = [withBox.calls[0]!, without.calls[0]!];
    expect(a.tools).toEqual([BIG]);
    expect(b).not.toHaveProperty("tools");
    expect(a.system).not.toBe(b.system);
    // The same weight but for the line saying there are no tools, which only the reply offered none is told.
    expect(a.system).not.toContain(NO_TOOLS_LINE);
    expect(estimateTokens(a.system)).toBe(estimateTokens(offered(b.system)));

    // The newest message, then older ones, newest first, while they fit what the plan leaves them. Reserved: the
    // definitions and what providers add around them; the last call's line; and room for what the tools bring back —
    // two results of `resultMaxWeight`, but at most a third of what the plan would give the conversation beside the
    // definitions (about 3 750 tokens here, its system text with the tools' passage: 1 249 are kept).
    const definitions = estimateTokens(JSON.stringify([BIG]), TOOL_TEXT_FACTOR) + TOOL_PREAMBLE_TOKENS;
    const conversation = contextBudget(8192, a.maxOutputTokens, { rest: a.system, passage: "" }, 1, definitions);
    const results = Math.min(Math.ceil(2 * app.deps.config.tools.resultMaxWeight * TOOL_TEXT_FACTOR), Math.floor(conversation / 3));
    expect(results).toBe(1249);
    const reserved = definitions + estimateTokens(`\n\n${FINAL_LINE}`) + results;
    const shown = (budget: number) => 1 + Math.min(older.length, Math.floor((budget - estimateTokens("附近有什么好吃的？")) / 310));
    const plans = [contextBudget(8192, b.maxOutputTokens, { rest: b.system, passage: "" }), contextBudget(8192, a.maxOutputTokens, { rest: a.system, passage: "" }, 1, reserved)];
    expect([textsOf(b).length, textsOf(a).length]).toEqual(plans.map(shown));
    // 16 older messages and 8: the definitions and the results' room are planned at 1.5 tokens a weight.
    expect([textsOf(b).length, textsOf(a).length]).toEqual([17, 9]);
    expect(textsOf(a).at(-1)).toBe("附近有什么好吃的？");
    expect(textsOf(a)).toEqual(textsOf(b).slice(8));
  });

  it("a long conversation that fills its plan, on the meter model: room is kept for what the tools bring back — fewer older messages are shown, a result of 3 000 weight goes back whole, and one result does not end the tool phase", async () => {
    // A system text of about 5 000 tokens, the search tool's definition, a context of 100 000; older messages of 3 000
    // weight fill what the definitions alone left the conversation to within about 200 tokens (the review's case: the
    // conversation filling its plan).
    const { owner, conv } = await owned("fullplan", PAID, { persona: "简".repeat(4480) });
    await grant(db, owner.id, 100n * POINT);
    // 32 older messages of 3 000 weight each, then the question: more than either plan holds.
    const older = Array.from({ length: 32 }, (_, i) => `${String(i).padStart(2, "0")}${"字".repeat(2999)}`);
    for (const text of older) await say(owner, conv, text);
    const question = "附近有什么好吃的？";
    await say(owner, conv, question);
    const hits = "川".repeat(3000);
    const gateway = scriptedGateway()
      .callTools([{ name: "search", input: { query: "川菜" } }], { usage: U(1000, 50) })
      .reply("川菜馆有一家。", { usage: U(1000, 20) });
    expect(await toolWorker(gateway, toolbox(() => ({ output: hits, activity: "search" }))).worker.runOnce()).toBe(true);

    expect(gateway.calls).toHaveLength(2);
    const [first, second] = gateway.calls as [ModelCall, ModelCall];
    expect(first.tools).toEqual(TOOLS);
    const system = { rest: first.system, passage: "" };
    const definitions = estimateTokens(JSON.stringify(TOOLS), TOOL_TEXT_FACTOR) + TOOL_PREAMBLE_TOKENS;
    const conversation = contextBudget(CONTEXT, MAX_OUT, system, 1, definitions);
    const results = Math.min(Math.ceil(2 * app.deps.config.tools.resultMaxWeight * TOOL_TEXT_FACTOR), Math.floor(conversation / 3));
    expect(results).toBe(9000);
    const reserved = definitions + estimateTokens(`\n\n${FINAL_LINE}`) + results;
    const shown = (budget: number) => 1 + Math.min(older.length, Math.floor((budget - estimateTokens(question)) / 3000));
    const planned = (texts: number) => estimateTokens(first.system) + estimateTokens(question) + (texts - 1) * 3000;
    const framing = estimateTokens(JSON.stringify(TOOLS), TOOL_TEXT_FACTOR) + estimateTokens(`\n\n${FINAL_LINE}`) + TOOL_PREAMBLE_TOKENS;
    // Before: the definitions alone reserved, 28 older messages shown, and the rounds left what the context leaves
    // beside the output limit, less its headroom, that input, the definitions, the line and the 400 — less than nothing:
    // the result went back as the mark alone, and the next call was the last.
    const before = shown(conversation);
    expect(Math.floor((CONTEXT - MAX_OUT) * (1 - CONTEXT_HEADROOM)) - planned(before) - framing).toBeLessThan(0);
    // Now: the line and two results' worth are kept out of the conversation's plan too, and the rounds have what the
    // plan's limit (the system text, the reservation, the conversation's budget) leaves: at least those two results.
    const budget = contextBudget(CONTEXT, MAX_OUT, system, 1, reserved);
    const after = shown(budget);
    expect([before, after]).toEqual([29, 26]);
    expect(estimateTokens(first.system) + reserved + budget - planned(after) - framing).toBeGreaterThanOrEqual(results);
    expect(textsOf(first)).toHaveLength(after);
    expect(textsOf(first).at(-1)).toBe(question);
    // The result went back whole, and the second call was another round, not the last.
    expect(isFinal(second)).toBe(false);
    expect(second.tools).toEqual(TOOLS);
    expect(second.steps?.map((s) => s.results.map((r) => r.output))).toEqual([[hits]]);
    expect(await runOf(owner.id)).toMatchObject({ status: "done", hold: "0" });
  });

  it("the plan's limit the rounds fill (ToolRun.limit): the system text, the reservation, and what the conversation may take before a group's cap — so the rounds get the room kept for results and what the conversation left unused; in a group, where a third of the cap is kept, the context beyond the cap too", async () => {
    const { port } = toolWorker(scriptedGateway());
    const lineTokens = estimateTokens(`\n\n${FINAL_LINE}`);
    const definitions = estimateTokens(JSON.stringify(TOOLS), TOOL_TEXT_FACTOR) + TOOL_PREAMBLE_TOKENS;
    /** What `prepared` was planned with, with the conversation's room capped at `cap` (a group's). */
    const planOf = (prepared: Prepared, cap: number | null) => {
      const system = { rest: prepared.call.system, passage: "" };
      const capped = (n: number) => (cap === null ? n : Math.min(n, cap));
      const results = Math.min(Math.ceil(2 * app.deps.config.tools.resultMaxWeight * TOOL_TEXT_FACTOR), Math.floor(capped(contextBudget(CONTEXT, MAX_OUT, system, 1, definitions)) / 3));
      const reserved = definitions + lineTokens + results;
      const whole = contextBudget(CONTEXT, MAX_OUT, system, 1, reserved);
      const toolRun = prepared.toolRun!;
      expect(toolRun.limit).toBe(estimateTokens(prepared.call.system) + reserved + whole);
      // The rounds' room: the results' share, and what the conversation (the planned input less the system text) left
      // unused of what it may take — give or take the token the line and the definitions round to apart.
      const room = toolRun.limit - toolRun.planned - estimateTokens(JSON.stringify(TOOLS), TOOL_TEXT_FACTOR) - lineTokens - TOOL_PREAMBLE_TOKENS;
      const unused = whole - (toolRun.planned - estimateTokens(prepared.call.system));
      expect(room - (results + unused)).toBeGreaterThanOrEqual(0);
      expect(room - (results + unused)).toBeLessThanOrEqual(1);
      return { results, whole };
    };

    // Its own conversation: two results' worth.
    const a = await owned("limitown", PAID);
    await grant(db, a.owner.id, 20n * POINT);
    await say(a.owner, a.conv, "附近有什么好吃的？");
    const own = (await port.begin((await port.claimNext())!)) as Prepared;
    expect(isRunEnd(own)).toBe(false);
    expect(planOf(own, null).results).toBe(9000);

    // In a group: a third of its cap (12 000) is kept, and the rounds may go past the cap, as far as the context allows.
    const owner = await signUp(app, "limitgroup");
    const member = await signUp(app, "limitmember");
    const g = await group(app, owner, "饭搭子", [member, await signUp(app, "limitthird")]);
    const agent = await mustCreateAgent(app, owner, { handle: "limitchef", name: "limitchef", model: PAID, persona: "简短地回答。" });
    await grant(db, owner.id, 20n * POINT);
    await db.query("insert into memberships (conversation_id, principal_id, role, joined_seq) select $1, $2, 'speaker', seq from conversations where id = $1", [g, agent.id]);
    await say(member, g, "@limitchef 附近有什么好吃的？");
    const inGroup = (await port.begin((await port.claimNext())!)) as Prepared;
    expect(isRunEnd(inGroup)).toBe(false);
    const cap = app.deps.config.agentGroupContextTokens;
    expect(cap).toBe(12_000);
    const plan = planOf(inGroup, cap);
    expect(plan.results).toBe(4000);
    expect(plan.whole).toBeGreaterThan(cap);
  });

  it("a model too small for the definitions and the room for what the tools bring back, though it has room for the definitions alone: no tools are offered, and the reply is one call, as one without tools", async () => {
    const owner = await signUp(app, "smallresults");
    const model = await smallModel(owner);
    // A persona that leaves the conversation about 260 tokens beside the search tool's definitions: enough for the
    // newest message's 200 alone, not once the line and a third of it for results are kept too. (Planned with the
    // system text a reply offered tools has: the tools' passage in place of its line saying there are none.)
    const agent = await mustCreateAgent(app, owner, { name: "小", model, persona: "简".repeat(4892 + estimateTokens(NO_TOOLS_LINE) - estimateTokens(PASSAGE_LINES)) });
    const question = `附近有什么好吃的？${"我想吃辣的。".repeat(40)}`;
    const gateway = scriptedGateway().reply("去吃川菜。", { usage: U(6000, 10) });
    await say(owner, agent.conversationId, question);
    expect(await toolWorker(gateway).worker.runOnce()).toBe(true);

    expect(gateway.calls).toHaveLength(1);
    const call = gateway.calls[0]!;
    expect(call).not.toHaveProperty("tools");
    expect(call).not.toHaveProperty("toolChoice");
    expect(textsOf(call)).toEqual([question]);
    // What the conversation would get beside the definitions (enough: at least the 200 a call needs), and beside the
    // definitions, the line and the room for results (not enough).
    expect(estimateTokens(question)).toBeGreaterThan(200);
    const system = { rest: offered(call.system), passage: "" };
    const definitions = estimateTokens(JSON.stringify(TOOLS), TOOL_TEXT_FACTOR) + TOOL_PREAMBLE_TOKENS;
    const conversation = contextBudget(8192, call.maxOutputTokens, system, 1, definitions);
    expect(conversation).toBeGreaterThanOrEqual(200);
    const results = Math.min(Math.ceil(2 * app.deps.config.tools.resultMaxWeight * TOOL_TEXT_FACTOR), Math.floor(conversation / 3));
    expect(contextBudget(8192, call.maxOutputTokens, system, 1, definitions + estimateTokens(`\n\n${FINAL_LINE}`) + results)).toBeLessThan(200);
    // Exactly a reply without tools: answered, and its estimate recorded for the ratio.
    expect(await runOf(owner.id)).toMatchObject({ status: "done" });
    expect((await runOf(owner.id)).input_estimate).not.toBe(null);
  });
});
