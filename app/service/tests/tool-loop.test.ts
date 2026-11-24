import { describe, expect, it } from "vitest";
import { LoopGuard } from "../src/agents/runtime/loop.ts";
import type { Activity, AgentPort, Delta, Estimated, Prepared, Reply, RunEnd, RunTicket, ToolOutcome, ToolRun, Usage } from "../src/agents/runtime/port.ts";
import { createAgentWorker, type ToolLimits, type WorkerLog } from "../src/agents/runtime/worker.ts";
import { partText } from "../src/agents/runtime/context.ts";
import { CONTEXT_HEADROOM, estimateTokens, holdTokens, TOOL_PREAMBLE_TOKENS, TOOL_TEXT_FACTOR, weight } from "../src/metering/tokens.ts";
import type { ModelCall, ModelEvent, ModelGateway, ToolCall, ToolSpec } from "../src/models/gateway.ts";
import { scriptedGateway, type ScriptedGateway } from "./helpers/models.ts";

/**
 * The tool loop of a reply (agents/runtime/worker.ts, loop.ts): the worker calls the model with the tools it is offered,
 * runs the calls the model makes through the port, hands their results back in the next round, and ends the tool phase
 * — by its caps, a repeat, garbled calls, a full context, or the port's word on money — with one last call that may call
 * no tool. Here against a port in memory (no database) and the scripted gateway.
 */

// The fixed sentences, as the product says them.
const REPEATED = "这个已经查过了，结果和上次一样。请用已经查到的内容回答。";
const OVER_CAP = "这类查询这次回复里不能再用了。";
const UNUSABLE = "这个请求无法执行。";
const FINAL_LINE = "你已经不能再查了，请用上面查到的内容直接回答。";
const CUT_MARK = "…（结果太长，后面的省略了）";

const SEARCH: ToolSpec = {
  name: "search",
  description: "Search this conversation's messages.",
  parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer" } }, required: ["query"], additionalProperties: false },
};
const READ: ToolSpec = {
  name: "read_file",
  description: "Read a file shared here.",
  parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
};
const TOOLS = [SEARCH, READ];
const SYSTEM = "你是一个助手。";
const LIMITS: ToolLimits = { maxRounds: 8, resultMaxWeight: 3000, runTimeoutMs: 300_000 };

const U = (inputTokens: number, outputTokens: number): Usage => ({ inputTokens, outputTokens });

interface Fake {
  port: AgentPort;
  prepared: Prepared;
  ticket: RunTicket;
  deltas: Delta[];
  posted: Reply[];
  /** What was posted as the reply's acknowledgement (`AgentPort.acknowledge`). */
  acks: Array<{ text: string; reasoning: string }>;
  /** What the worker did, in order: an acknowledgement, a tool call, a post. */
  order: string[];
  finished: Array<{ end: RunEnd; usage: Usage | null; fallback: Estimated }>;
  tools: ToolCall[];
  extends: Array<{ spent: Usage | null; estimated: Estimated; next: number }>;
  activities: Array<Activity | null>;
  unusable: Array<"refused" | "garbled">;
  /** How many times the worker said the reply's tools worked (`AgentPort.toolsWorked`). */
  worked: number;
  released: number;
  /** What each release said the worker knew: whether the reply had produced anything (`AgentPort.release`). */
  releasedWith: boolean[];
  /** How often the worker told the port the reply had produced something (`AgentPort.progressed`). */
  progressed: number;
  stop(): void;
}

interface FakeOptions {
  tools?: ToolSpec[];
  perTool?: Record<string, number>;
  toolRun?: Partial<ToolRun>;
  inputChars?: number;
  call?: Partial<Omit<ModelCall, "signal">>;
  /** How a tool call runs (default: its input echoed back as the search's hits). */
  tool?: (call: ToolCall, signal: AbortSignal, fake: Fake) => Promise<ToolOutcome>;
  /** What `extend` answers (default "ok"). */
  extend?: (n: number, fake: Fake) => Promise<"ok" | "final" | "stop"> | "ok" | "final" | "stop";
  /** How an acknowledgement is answered (default "posted"). */
  acknowledge?: (said: { text: string; reasoning: string }) => Promise<"posted" | "refused" | "empty">;
}

/** A port in memory: one run, prepared with `options`, recording everything the worker does with it. */
function fakePort(options: FakeOptions = {}): Fake {
  const ticket: RunTicket = { id: "run-1", agentId: "agent-1", ownerId: "owner-1", conversationId: "conv-1" };
  const tools = options.tools ?? TOOLS;
  const contextTokens = options.toolRun?.contextTokens ?? 100_000;
  const maxOutputTokens = options.call?.maxOutputTokens ?? 1000;
  const prepared: Prepared = {
    call: {
      protocol: "openai_chat",
      baseUrl: "https://api.example.test/v1",
      apiKey: "not-a-real-key",
      model: "m-1",
      system: SYSTEM,
      messages: [{ role: "user", parts: [{ type: "text", text: "附近有什么好吃的？" }] }],
      reasoning: "none",
      maxOutputTokens,
      ...options.call,
    },
    inputChars: options.inputChars ?? 120,
    tools,
    toolRun:
      tools.length === 0
        ? null
        : {
            perTool: options.perTool ?? {},
            // What each tool's work shows while it runs, as an offer names it.
            kinds: { search: "search", read_file: "file" },
            contextTokens,
            fixedTokens: 0,
            ratio: 1,
            planRatio: 1,
            planned: 120,
            // A plan with nothing reserved: all the context leaves beside the output limit, less its headroom.
            limit: Math.floor((contextTokens - maxOutputTokens) * (1 - CONTEXT_HEADROOM)),
            ...options.toolRun,
          },
  };
  let claimed = false;
  let stopped = false;
  const fake: Fake = {
    ticket,
    prepared,
    deltas: [],
    posted: [],
    acks: [],
    order: [],
    finished: [],
    tools: [],
    extends: [],
    activities: [],
    unusable: [],
    worked: 0,
    released: 0,
    releasedWith: [],
    progressed: 0,
    stop: () => void (stopped = true),
    port: {
      claimNext: async () => (claimed ? null : ((claimed = true), ticket)),
      begin: async () => prepared,
      emit: (_run, delta) => void fake.deltas.push(delta),
      acknowledge: async (_run, said) => {
        fake.order.push("ack");
        const answer = options.acknowledge ? await options.acknowledge(said) : "posted";
        if (answer === "posted") fake.acks.push(said);
        return answer;
      },
      post: async (_run, reply) => {
        fake.order.push("post");
        fake.posted.push(reply);
        return "posted";
      },
      finish: async (_run, end, usage, fallback) => void fake.finished.push({ end, usage, fallback }),
      release: async (_run, progress) => {
        fake.released++;
        fake.releasedWith.push(progress === true);
      },
      progressed: async () => void fake.progressed++,
      shouldStop: () => stopped,
      tool: async (_run, call, signal) => {
        fake.order.push("tool");
        fake.tools.push(call);
        return options.tool ? options.tool(call, signal, fake) : { output: { hits: [call.input] }, activity: call.name === READ.name ? "file" : "search" };
      },
      extend: async (_run, spent, estimated, next) => {
        fake.extends.push({ spent, estimated, next });
        return options.extend ? options.extend(fake.extends.length, fake) : "ok";
      },
      activity: (_run, activity) => void fake.activities.push(activity),
      toolsUnusable: async (_run, why) => void fake.unusable.push(why),
      toolsWorked: async () => void fake.worked++,
    },
  };
  return fake;
}

/** What the worker logged. */
function recordingLog(): WorkerLog & { lines: unknown[] } {
  const lines: unknown[] = [];
  const at = (level: string) => (details: Record<string, unknown>, msg: string) => void lines.push({ level, details, msg });
  return { lines, info: at("info"), warn: at("warn"), error: at("error") };
}

/** Runs the fake's one run to its end on `gateway`. */
async function runOn(fake: Fake, gateway: Pick<ModelGateway, "stream">, over: { runTimeoutMs?: number; tools?: Partial<ToolLimits>; log?: WorkerLog } = {}) {
  const worker = createAgentWorker({
    port: fake.port,
    models: gateway,
    runTimeoutMs: over.runTimeoutMs ?? 120_000,
    maxRunsInFlight: 1,
    background: false,
    log: over.log ?? recordingLog(),
    tools: { ...LIMITS, ...over.tools },
  });
  expect(await worker.runOnce()).toBe(true);
}

const stepsOf = (call: ModelCall) => call.steps ?? [];
const resultsOf = (call: ModelCall, step: number) => stepsOf(call)[step]!.results;
const outputsOf = (call: ModelCall, step: number) => resultsOf(call, step).map((r) => r.output);
const isFinal = (call: ModelCall) => call.toolChoice === "none" && call.system === `${SYSTEM}\n\n${FINAL_LINE}`;
const finishedAs = (fake: Fake) => fake.finished.map((f) => f.end);

describe("LoopGuard", () => {
  const call = (name: string, input: unknown, id = "x"): ToolCall => ({ id, name, input });

  it("runs a call the first time; the same name and input again is a repeat, the third time ends the tool phase", () => {
    const guard = new LoopGuard({ maxRounds: 8, perTool: {} });
    expect(guard.admit(call("search", { query: "川菜", limit: 3 }))).toBe("run");
    expect(guard.mustEnd()).toBe(false);
    // The same input in another key order, under another id: the same call.
    expect(guard.admit(call("search", { limit: 3, query: "川菜" }, "y"))).toBe("repeat");
    expect(guard.mustEnd()).toBe(false);
    expect(guard.admit(call("search", { query: "川菜", limit: 3 }))).toBe("repeat");
    expect(guard.mustEnd()).toBe(true);
    // Another input, or another tool with the same input, is another call.
    expect(guard.admit(call("search", { query: "湘菜", limit: 3 }))).toBe("run");
    expect(guard.admit(call("read_file", { query: "川菜", limit: 3 }))).toBe("run");
    // Nested objects are compared by their contents too.
    expect(guard.admit(call("search", { query: "x", where: { a: 1, b: [1, { c: 2, d: 3 }] } }))).toBe("run");
    expect(guard.admit(call("search", { where: { b: [1, { d: 3, c: 2 }], a: 1 }, query: "x" }))).toBe("repeat");
  });

  it("over a tool's own count a new call is refused; a repeat stays a repeat; a tool with no count of its own has only the round cap", () => {
    const guard = new LoopGuard({ maxRounds: 8, perTool: { search: 2 } });
    expect(guard.admit(call("search", { query: "a" }))).toBe("run");
    expect(guard.admit(call("search", { query: "b" }))).toBe("run");
    expect(guard.admit(call("search", { query: "c" }))).toBe("over");
    expect(guard.admit(call("search", { query: "a" }))).toBe("repeat");
    for (let i = 0; i < 20; i++) expect(guard.admit(call("read_file", { name: `f${i}` }))).toBe("run");
    // A count is looked up as the tool's own: a name that is a property of every object has none.
    const plain = new LoopGuard({ maxRounds: 8, perTool: {} });
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) expect(plain.admit(call(name, { query: "a" }))).toBe("run");
  });

  it("is exhausted once maxRounds rounds are done", () => {
    const guard = new LoopGuard({ maxRounds: 3, perTool: {} });
    for (let i = 0; i < 3; i++) {
      expect(guard.exhausted()).toBe(false);
      guard.roundDone();
    }
    expect(guard.exhausted()).toBe(true);
  });

  it("M-7: given `same`, a call is known by what it makes of the call: two forms of one input are one call", () => {
    const guard = new LoopGuard({ maxRounds: 8, perTool: {}, same: (c) => (c.name === "read_file" ? { file: String((c.input as { file: string }).file).replace(/[〔〕]/g, "") } : c.input) });
    expect(guard.admit(call("read_file", { file: "f1" }))).toBe("run");
    expect(guard.admit(call("read_file", { file: "〔f1〕" }))).toBe("repeat");
    expect(guard.mustEnd()).toBe(false);
    expect(guard.admit(call("read_file", { file: "f1" }))).toBe("repeat");
    expect(guard.mustEnd()).toBe(true);
    expect(guard.admit(call("read_file", { file: "f2" }))).toBe("run");
    expect(guard.admit(call("search", { query: "f2" }))).toBe("run");
  });

  it("the same input in another Unicode form (composed or not) is the same call, in its values and its keys", () => {
    const guard = new LoopGuard({ maxRounds: 8, perTool: {} });
    expect(guard.admit(call("search", { query: "Café" }))).toBe("run");
    expect(guard.admit(call("search", { query: "Café" }))).toBe("repeat");
    expect(guard.admit(call("search", { ["clé"]: "a" }))).toBe("run");
    expect(guard.admit(call("search", { ["clé"]: "a" }))).toBe("repeat");
  });
});

describe("a reply that offers tools", () => {
  it("answers after one tool round: the call runs once through the port, its result goes back with the call's own id and name, and the reply is posted", async () => {
    const gateway = scriptedGateway().callTools([{ name: "search", input: { query: "川菜" } }], { usage: U(300, 20) }).reply("去吃川菜吧。", { usage: U(400, 30) });
    const fake = fakePort();
    await runOn(fake, gateway);

    expect(gateway.calls).toHaveLength(2);
    const [first, second] = gateway.calls as [ModelCall, ModelCall];
    expect(first.tools).toEqual(TOOLS);
    expect(first).not.toHaveProperty("steps");
    expect(first).not.toHaveProperty("toolChoice");
    expect(first.system).toBe(SYSTEM);
    expect(first.messages).toEqual(fake.prepared.call.messages);
    expect(fake.tools).toEqual([{ id: expect.any(String), name: "search", input: { query: "川菜" } }]);
    expect(second.tools).toEqual(TOOLS);
    expect(second).not.toHaveProperty("toolChoice");
    expect(resultsOf(second, 0)).toEqual([{ id: fake.tools[0]!.id, name: "search", output: { hits: [{ query: "川菜" }] } }]);
    // With its trace: the call of the round its answer was written with (harness design §3).
    expect(fake.posted).toEqual([{ text: "去吃川菜吧。", reasoning: "", stopped: false, truncated: false, lookups: { search: 1 }, toolCalls: [{ name: "search", round: 1, outcome: "ok", input: { query: "川菜" }, found: 0 }] }]);
    // One settlement, on the rounds' summed usage.
    expect(fake.finished).toEqual([{ end: { status: "done" }, usage: U(700, 50), fallback: expect.any(Object) }]);
    // The port was asked about money once, between the rounds, with what the first round cost.
    expect(fake.extends).toHaveLength(1);
    expect(fake.extends[0]!.spent).toEqual(U(300, 20));
    // What the tool did, then the end of the tool phase.
    expect(fake.activities).toEqual(["search", null]);
    expect(fake.unusable).toEqual([]);
    // Its tool call ran: the port is told the model can use them.
    expect(fake.worked).toBe(1);
  });

  it("the port is told the tools worked once a reply, after the first round in which a call ran — never for a reply that called none, and its failure only reaches the log", async () => {
    const three = fakePort();
    await runOn(
      three,
      scriptedGateway()
        .callTools([{ name: "search", input: { query: "一" } }, { name: "search", input: { query: "二" } }])
        .callTools([{ name: "search", input: { query: "三" } }])
        .reply("好。"),
    );
    expect(three.tools).toHaveLength(3);
    expect(three.worked).toBe(1);

    const none = fakePort();
    await runOn(none, scriptedGateway().reply("不用查。"));
    expect(none.worked).toBe(0);

    const failing = fakePort();
    failing.port.toolsWorked = async () => {
      throw new Error("no database");
    };
    const log = recordingLog();
    await runOn(failing, scriptedGateway().callTools([{ name: "search", input: { query: "川菜-canary" } }]).reply("去吃川菜吧。"), { log });
    expect(failing.posted.map((p) => p.text)).toEqual(["去吃川菜吧。"]);
    expect(failing.finished.map((f) => f.end)).toEqual([{ status: "done" }]);
    const said = log.lines.filter((l) => JSON.stringify(l).includes("can use the tools"));
    expect(said).toHaveLength(1);
    // Never a tool's input or output.
    expect(JSON.stringify(log.lines)).not.toContain("canary");
  });

  it("text written before a tool call is posted at once as the reply's acknowledgement, with its reasoning, before the tool runs; the answer is what comes after it; both streamed as they came", async () => {
    const gateway = scriptedGateway()
      .callTools([{ name: "search", input: { query: "川菜" } }], { text: "我先查一下。", reasoning: "要查记录。" })
      .reply("查到了：去吃川菜。", { reasoning: "找到了。" });
    const fake = fakePort();
    await runOn(fake, gateway);
    expect(fake.order).toEqual(["ack", "tool", "post"]);
    expect(fake.acks).toEqual([{ text: "我先查一下。", reasoning: "要查记录。" }]);
    expect(fake.posted).toEqual([{ text: "查到了：去吃川菜。", reasoning: "找到了。", stopped: false, truncated: false, lookups: { search: 1 }, toolCalls: [{ name: "search", round: 1, outcome: "ok", input: { query: "川菜" }, found: 0 }] }]);
    // The stream: what the acknowledgement said, then the answer, with no paragraph break carried over.
    expect(fake.deltas.map((d) => d.text ?? "").join("")).toBe("我先查一下。查到了：去吃川菜。");
    expect(finishedAs(fake)).toEqual([{ status: "done" }]);
  });

  it("no acknowledgement without a tool call, nor for text that shows nothing; at most one per reply, a later round's text before its call being part of the answer", async () => {
    const plain = scriptedGateway().reply("直接回答。");
    const none = fakePort();
    await runOn(none, plain);
    expect([none.acks, none.posted.map((p) => p.text)]).toEqual([[], ["直接回答。"]]);

    const blank = scriptedGateway().callTools([{ name: "search", input: { query: "a" } }], { text: " \n " }).reply("好。");
    const quiet = fakePort();
    await runOn(quiet, blank);
    expect([quiet.acks, quiet.posted.map((p) => p.text)]).toEqual([[], ["好。"]]);

    const twice = scriptedGateway()
      .callTools([{ name: "search", input: { query: "a" } }], { text: "我先查一下。" })
      .callTools([{ name: "search", input: { query: "b" } }], { text: "再看看。" })
      .reply("都有了。");
    const once = fakePort();
    await runOn(once, twice);
    expect(once.acks.map((a) => a.text)).toEqual(["我先查一下。"]);
    expect(once.posted.map((p) => p.text)).toEqual(["再看看。\n\n都有了。"]);
    expect(once.order).toEqual(["ack", "tool", "tool", "post"]);
  });

  it("an acknowledgement that could not be posted (the port failed, or nothing of it showed) leaves the reply as it was: what was said stays with the answer, and a later round may still acknowledge", async () => {
    const gateway = scriptedGateway()
      .callTools([{ name: "search", input: { query: "a" } }], { text: "我先查一下。" })
      .reply("查到了。");
    const failing = fakePort({ acknowledge: () => Promise.reject(new Error("the database is gone")) });
    const log = recordingLog();
    await runOn(failing, gateway, { log });
    expect(failing.posted.map((p) => p.text)).toEqual(["我先查一下。\n\n查到了。"]);
    expect(log.lines).toContainEqual(expect.objectContaining({ level: "error", msg: expect.stringContaining("acknowledgement") }));

    const empty = scriptedGateway()
      .callTools([{ name: "search", input: { query: "a" } }], { text: "〔只有暗记〕" })
      .callTools([{ name: "search", input: { query: "b" } }], { text: "再查一个。" })
      .reply("好。");
    let n = 0;
    const second = fakePort({ acknowledge: async () => (++n === 1 ? "empty" : "posted") });
    await runOn(second, empty);
    expect(second.acks.map((a) => a.text)).toEqual(["再查一个。"]);
    expect(second.posted.map((p) => p.text)).toEqual(["好。"]);
  });

  it("8 rounds of distinct calls: a 9th call that may call no tool, with the same tools, every step and the fixed line, and its reply is posted", async () => {
    const gateway = scriptedGateway();
    for (let i = 0; i < 8; i++) gateway.callTools([{ name: "search", input: { query: `第${i}次` } }], { usage: U(100, 10) });
    gateway.reply("查了很多，结论是川菜。", { usage: U(100, 10) });
    const fake = fakePort();
    await runOn(fake, gateway);

    expect(gateway.calls).toHaveLength(9);
    expect(gateway.calls.slice(0, 8).every((c) => !isFinal(c) && c.system === SYSTEM)).toBe(true);
    const last = gateway.calls[8]!;
    expect(isFinal(last)).toBe(true);
    expect(last.tools).toEqual(TOOLS);
    expect(stepsOf(last)).toHaveLength(8);
    expect(fake.tools).toHaveLength(8);
    expect(fake.posted.map((p) => p.text)).toEqual(["查了很多，结论是川菜。"]);
    expect(fake.finished).toEqual([{ end: { status: "done" }, usage: U(900, 90), fallback: expect.any(Object) }]);
    expect(fake.extends).toHaveLength(8);
    // Each round: the search while it ran, none as soon as the model was called again.
    expect(fake.activities).toEqual(Array.from({ length: 8 }, () => ["search", null]).flat());
  });

  it("the same call three times: run once, the second answered with the fixed note, the third ends the tool phase", async () => {
    const same = { name: "search", input: { query: "川菜" } };
    const gateway = scriptedGateway().callTools([same]).callTools([same]).callTools([same]).reply("就是川菜。");
    const fake = fakePort();
    await runOn(fake, gateway);
    expect(gateway.calls).toHaveLength(4);
    expect(fake.tools).toHaveLength(1);
    expect(outputsOf(gateway.calls[3]!, 1)).toEqual([{ note: REPEATED }]);
    expect(outputsOf(gateway.calls[3]!, 2)).toEqual([{ note: REPEATED }]);
    expect(gateway.calls.slice(0, 3).some(isFinal)).toBe(false);
    expect(isFinal(gateway.calls[3]!)).toBe(true);
    expect(fake.posted.map((p) => p.text)).toEqual(["就是川菜。"]);

    // Three of them in one round: the same.
    const once = scriptedGateway().callTools([same, same, same]).reply("就是川菜。");
    const again = fakePort();
    await runOn(again, once);
    expect(again.tools).toHaveLength(1);
    expect(outputsOf(once.calls[1]!, 0)).toEqual([{ hits: [{ query: "川菜" }] }, { note: REPEATED }, { note: REPEATED }]);
    expect(isFinal(once.calls[1]!)).toBe(true);
  });

  it("a tool over its count for the reply is answered with the fixed note, and the loop goes on", async () => {
    const gateway = scriptedGateway()
      .callTools([
        { name: "search", input: { query: "a" } },
        { name: "search", input: { query: "b" } },
        { name: "search", input: { query: "c" } },
        { name: "read_file", input: { name: "菜单.txt" } },
      ])
      .callTools([{ name: "search", input: { query: "d" } }])
      .reply("好了。");
    const fake = fakePort({ perTool: { search: 2 } });
    await runOn(fake, gateway);
    expect(fake.tools.map((c) => c.input)).toEqual([{ query: "a" }, { query: "b" }, { name: "菜单.txt" }]);
    expect(outputsOf(gateway.calls[1]!, 0)).toEqual([{ hits: [{ query: "a" }] }, { hits: [{ query: "b" }] }, { note: OVER_CAP }, { hits: [{ name: "菜单.txt" }] }]);
    expect(outputsOf(gateway.calls[2]!, 1)).toEqual([{ note: OVER_CAP }]);
    expect(isFinal(gateway.calls[2]!)).toBe(false);
    expect(fake.posted.map((p) => p.text)).toEqual(["好了。"]);
    // What was looked up counts the calls that ran, never one answered with the note.
    expect(fake.posted[0]!.lookups).toEqual({ search: 2, file: 1 });
  });

  it("a tool whose answer cannot be handed to the model (not JSON) counts as failed, not as run: the model is not called able for it", async () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    const fake = fakePort({ tool: async () => ({ output: loop }) });
    const log = recordingLog();
    const gateway = scriptedGateway().callTools([{ name: "search", input: { query: "川菜" } }]).reply("好。");
    await runOn(fake, gateway, { log });
    expect(fake.tools).toHaveLength(1);
    expect(outputsOf(gateway.calls[1]!, 0)).toEqual([{ error: UNUSABLE }]);
    const tally = log.lines.map((l) => (l as { details: Record<string, unknown> }).details).find((d) => d.metric === "tool_rounds")!;
    expect([tally.ran, tally.failed]).toEqual([0, 1]);
    expect(fake.worked).toBe(0);
  });

  it("two garbled calls (an unknown tool, an input its schema refuses) are never run: the fixed error each, the tools marked unusable, then the last call", async () => {
    const gateway = scriptedGateway()
      .callTools([{ name: "web_search", input: { query: "川菜" } }])
      .callTools([{ name: "search", input: { limit: 3 } }])
      .reply("不用工具也能回答。");
    const fake = fakePort();
    await runOn(fake, gateway);
    expect(fake.tools).toEqual([]);
    expect(outputsOf(gateway.calls[2]!, 0)).toEqual([{ error: UNUSABLE }]);
    expect(outputsOf(gateway.calls[2]!, 1)).toEqual([{ error: UNUSABLE }]);
    // Answered with the call's own id and name, the unknown one's too.
    expect(resultsOf(gateway.calls[2]!, 0)[0]!.name).toBe("web_search");
    expect(fake.unusable).toEqual(["garbled"]);
    expect(fake.worked).toBe(0);
    expect(isFinal(gateway.calls[1]!)).toBe(false);
    expect(isFinal(gateway.calls[2]!)).toBe(true);
    expect(fake.posted.map((p) => p.text)).toEqual(["不用工具也能回答。"]);
  });

  it("an input of the wrong kind is garbled as well: a string for a string, an integer for an integer, nothing besides what the schema names", async () => {
    const gateway = scriptedGateway()
      .callTools([
        { name: "search", input: { query: 5 } },
        { name: "search", input: { query: "a", limit: 1.5 } },
        { name: "search", input: { query: "a", extra: true } },
        { name: "search", input: ["a"] },
        { name: "search", input: "a" },
        { name: "search", input: { query: "ok", limit: 2 } },
      ])
      .reply("好。");
    const fake = fakePort();
    await runOn(fake, gateway);
    expect(fake.tools.map((c) => c.input)).toEqual([{ query: "ok", limit: 2 }]);
    expect(outputsOf(gateway.calls[1]!, 0).slice(0, 5)).toEqual(Array(5).fill({ error: UNUSABLE }));
    expect(fake.unusable).toEqual(["garbled"]);
    // Found unable in the very round one call ran: it is not also called able.
    expect(fake.worked).toBe(0);
    expect(isFinal(gateway.calls[1]!)).toBe(true);
  });

  it("every call of a round cut at its limit is garbled and none is run (its input may be cut)", async () => {
    const gateway = scriptedGateway()
      .callTools(
        [
          { name: "search", input: { query: "a" } },
          { name: "search", input: {} },
        ],
        { truncated: true },
      )
      .reply("好。");
    const fake = fakePort();
    await runOn(fake, gateway);
    expect(fake.tools).toEqual([]);
    expect(outputsOf(gateway.calls[1]!, 0)).toEqual([{ error: UNUSABLE }, { error: UNUSABLE }]);
    expect(fake.unusable).toEqual(["garbled"]);
    expect(isFinal(gateway.calls[1]!)).toBe(true);
  });

  it("an upstream that refused the tools: they are marked unusable, the reply is that round's text, and no other call is made", async () => {
    const gateway = scriptedGateway().refuseTools("没有工具也能回答。", { usage: U(200, 10) });
    const fake = fakePort();
    await runOn(fake, gateway);
    expect(gateway.calls).toHaveLength(1);
    expect(fake.unusable).toEqual(["refused"]);
    expect(fake.posted.map((p) => p.text)).toEqual(["没有工具也能回答。"]);
    expect(fake.finished).toEqual([{ end: { status: "done" }, usage: U(200, 10), fallback: expect.any(Object) }]);
    expect(fake.extends).toEqual([]);
  });

  it("an upstream that refused the tools was sent none: with no usage reported, that round's estimate counts no tool definitions", async () => {
    const gateway = scriptedGateway().refuseTools("没有工具也能回答。");
    const fake = fakePort({ inputChars: 120 });
    await runOn(fake, gateway);
    expect(fake.finished).toEqual([{ end: { status: "done" }, usage: null, fallback: { inputChars: 120, outputChars: estimateTokens("没有工具也能回答。") } }]);
  });

  it("a tool call in the last round is not run, and no call follows: its text is the reply; with no text, the run fails as an empty answer", async () => {
    const gateway = scriptedGateway()
      .callTools([{ name: "search", input: { query: "a" } }])
      .callTools([{ name: "search", input: { query: "b" } }], { text: "就这些了。" });
    const fake = fakePort();
    await runOn(fake, gateway, { tools: { maxRounds: 1 } });
    expect(gateway.calls).toHaveLength(2);
    expect(isFinal(gateway.calls[1]!)).toBe(true);
    expect(fake.tools.map((c) => c.input)).toEqual([{ query: "a" }]);
    expect(fake.posted.map((p) => p.text)).toEqual(["就这些了。"]);
    expect(finishedAs(fake)).toEqual([{ status: "done" }]);

    const silent = scriptedGateway()
      .callTools([{ name: "search", input: { query: "a" } }])
      .callTools([{ name: "search", input: { query: "b" } }]);
    const quiet = fakePort();
    await runOn(quiet, silent, { tools: { maxRounds: 1 } });
    expect(silent.calls).toHaveLength(2);
    expect(quiet.posted).toEqual([]);
    expect(finishedAs(quiet)).toEqual([{ status: "failed", error: "provider_unavailable" }]);
  });

  it("a later round the upstream refuses (400 or 422): once, the reply is asked for as one without tools, from the conversation alone; another failure fails it", async () => {
    const gateway = scriptedGateway()
      .callTools([{ name: "search", input: { query: "a" } }], { text: "我先查一下。", usage: U(100, 10) })
      .fail("provider_unavailable", { status: 400 })
      .reply("不查也能说：川菜。", { usage: U(80, 8) });
    const fake = fakePort();
    await runOn(fake, gateway);
    expect(gateway.calls).toHaveLength(3);
    const { signal: _signal, ...plain } = gateway.calls[2]!;
    expect(plain).toStrictEqual(fake.prepared.call); // no tools, no steps, no choice: the ordinary call
    expect(fake.acks.map((a) => a.text)).toEqual(["我先查一下。"]);
    expect(fake.posted.map((p) => p.text)).toEqual(["不查也能说：川菜。"]);
    expect(fake.finished).toEqual([{ end: { status: "done" }, usage: U(180, 18), fallback: expect.any(Object) }]);
    // Its cost was held first, at an ordinary call's bound.
    expect(fake.extends).toHaveLength(2);
    expect(fake.unusable).toEqual([]);

    // A 422 likewise; an upstream that failed otherwise (5xx, unreachable) is the reply's failure, as for one call.
    const failing = scriptedGateway()
      .callTools([{ name: "search", input: { query: "a" } }])
      .fail("provider_unavailable", { status: 502 });
    const failed = fakePort();
    await runOn(failed, failing);
    expect(failing.calls).toHaveLength(2);
    // (With the upstream's status: whether the system tries it again by itself reads it — runs.ts `transientFailure`.)
    // (After a tool round: the reply had done something, so not passing — runtime/port.ts `passingEnding`.)
    expect(finishedAs(failed)).toEqual([{ status: "failed", error: "provider_unavailable", upstreamStatus: 502 }]);

    // The ordinary call refused as well: failed.
    const twice = scriptedGateway()
      .callTools([{ name: "search", input: { query: "a" } }])
      .fail("provider_unavailable", { status: 422 })
      .fail("provider_unavailable", { status: 400 });
    const again = fakePort();
    await runOn(again, twice);
    expect(twice.calls).toHaveLength(3);
    expect(finishedAs(again)).toEqual([{ status: "failed", error: "provider_unavailable", upstreamStatus: 400 }]);
  });

  it("the ordinary call after a later round refused is told it has no tools: the prepared text for going without them, when the call has one, and nothing else changes", async () => {
    const PLAIN = "你是一个助手。你没有任何工具。";
    const gateway = scriptedGateway()
      .callTools([{ name: "search", input: { query: "a" } }], { usage: U(100, 10) })
      .fail("provider_unavailable", { status: 400 })
      .reply("不查也能说：川菜。", { usage: U(80, 8) });
    const fake = fakePort({ call: { systemWithoutTools: PLAIN } });
    await runOn(fake, gateway);
    expect(gateway.calls).toHaveLength(3);
    // The rounds that send the tools carry both texts (the gateway sends the second only if the tools are not sent).
    expect([gateway.calls[0]!.system, gateway.calls[0]!.systemWithoutTools]).toEqual([SYSTEM, PLAIN]);
    const { signal: _signal, ...plain } = gateway.calls[2]!;
    const { systemWithoutTools: _without, ...ordinary } = fake.prepared.call;
    expect(plain).toStrictEqual({ ...ordinary, system: PLAIN });
    // Its cost was held at its own text's bound.
    expect(fake.extends[1]!.next).toBe(Buffer.byteLength(PLAIN) + Buffer.byteLength("附近有什么好吃的？"));
  });

  it("a later round refused (400) when the port says stop (the run ended elsewhere): the ordinary call is not made, and the reply ends with what it wrote", async () => {
    const said = scriptedGateway()
      .callTools([{ name: "search", input: { query: "a" } }], { text: "我先查一下。", usage: U(100, 10) })
      .fail("provider_unavailable", { status: 400 });
    const withText = fakePort({ extend: (n) => (n === 1 ? "ok" : "stop") });
    await runOn(withText, said);
    expect(said.calls).toHaveLength(2);
    expect(withText.extends).toHaveLength(2);
    // What it said before its tool call was its acknowledgement, posted then; after it, it wrote nothing, and the run
    // ended elsewhere (the port's "stop" never means money now): `cancelled`, the acknowledgement standing.
    expect(withText.acks.map((a) => a.text)).toEqual(["我先查一下。"]);
    expect(withText.posted).toEqual([]);
    expect(finishedAs(withText)).toEqual([{ status: "cancelled" }]);
    // Had the acknowledgement not been posted, what it said would stand, as cut.
    const kept = fakePort({ extend: (n) => (n === 1 ? "ok" : "stop"), acknowledge: async () => "refused" });
    await runOn(
      kept,
      scriptedGateway()
        .callTools([{ name: "search", input: { query: "a" } }], { text: "我先查一下。", usage: U(100, 10) })
        .fail("provider_unavailable", { status: 400 }),
    );
    expect(kept.posted).toEqual([{ text: "我先查一下。", reasoning: "", stopped: false, truncated: true, lookups: { search: 1 } }]);
    expect(finishedAs(kept)).toEqual([{ status: "done" }]);

    const mute = scriptedGateway()
      .callTools([{ name: "search", input: { query: "a" } }], { usage: U(100, 10) })
      .fail("provider_unavailable", { status: 422 });
    const silent = fakePort({ extend: (n) => (n === 1 ? "ok" : "stop") });
    await runOn(silent, mute);
    expect(mute.calls).toHaveLength(2);
    expect(silent.posted).toEqual([]);
    expect(finishedAs(silent)).toEqual([{ status: "cancelled" }]);
  });

  it("the owner's stop between rounds, or between two tool calls: the acknowledgement stays, nothing more is called, run or posted, and the run ends stopped", async () => {
    const gateway = scriptedGateway().callTools([{ name: "search", input: { query: "a" } }], { text: "我先查一下。" });
    const between = fakePort({
      extend: (_n, fake) => {
        fake.stop();
        return "ok";
      },
    });
    await runOn(between, gateway);
    expect(gateway.calls).toHaveLength(1);
    expect(between.acks.map((a) => a.text)).toEqual(["我先查一下。"]);
    expect(between.posted).toEqual([]);
    expect(finishedAs(between)).toEqual([{ status: "stopped" }]);
    // What was written after the acknowledgement, when there is some, is posted as stopped.
    const after = scriptedGateway().callTools([{ name: "search", input: { query: "a" } }], { text: "我先查一下。" });
    const withText = fakePort({
      acknowledge: async () => "refused",
      extend: (_n, fake) => {
        fake.stop();
        return "ok";
      },
    });
    await runOn(withText, after);
    expect(withText.posted).toEqual([{ text: "我先查一下。", reasoning: "", stopped: true, truncated: false, lookups: { search: 1 } }]);
    expect(finishedAs(withText)).toEqual([{ status: "stopped" }]);

    const two = scriptedGateway().callTools(
      [
        { name: "search", input: { query: "a" } },
        { name: "search", input: { query: "b" } },
      ],
      { text: "我查两样。" },
    );
    const inTools = fakePort({
      tool: async (call, _signal, fake) => {
        fake.stop();
        return { output: { hits: [call.input] }, activity: "search" };
      },
    });
    await runOn(inTools, two);
    expect(two.calls).toHaveLength(1);
    expect(inTools.tools.map((c) => c.input)).toEqual([{ query: "a" }]);
    expect(inTools.extends).toEqual([]);
    expect(inTools.acks.map((a) => a.text)).toEqual(["我查两样。"]);
    expect(inTools.posted).toEqual([]);
    expect(finishedAs(inTools)).toEqual([{ status: "stopped" }]);
    expect(inTools.activities.at(-1)).toBe(null);
  });

  it("a tool still running after the call timeout is aborted through its signal, and its result is the fixed error", async () => {
    const gateway = scriptedGateway().callTools([{ name: "search", input: { query: "慢" } }]).reply("没查到。");
    let aborted: boolean | null = null;
    const fake = fakePort({
      tool: (_call, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted = signal.aborted;
            reject(signal.reason);
          });
        }),
    });
    const began = Date.now();
    await runOn(fake, gateway, { runTimeoutMs: 300 });
    expect(aborted).toBe(true);
    expect(Date.now() - began).toBeLessThan(5_000);
    expect(outputsOf(gateway.calls[1]!, 0)).toEqual([{ error: UNUSABLE }]);
    expect(fake.posted.map((p) => p.text)).toEqual(["没查到。"]);
    expect(finishedAs(fake)).toEqual([{ status: "done" }]);
  });

  it("a tool that ignores its signal does not hold the reply up past the call timeout", async () => {
    const gateway = scriptedGateway().callTools([{ name: "search", input: { query: "慢" } }]).reply("没查到。");
    const fake = fakePort({ tool: () => new Promise(() => {}) });
    const began = Date.now();
    await runOn(fake, gateway, { runTimeoutMs: 300 });
    expect(Date.now() - began).toBeLessThan(5_000);
    expect(outputsOf(gateway.calls[1]!, 0)).toEqual([{ error: UNUSABLE }]);
  });

  it("the reply's own time limit ends it between rounds or inside a tool: what was written is posted as cut, nothing more is called", async () => {
    // (Its acknowledgement not posted here: what it wrote before the tool is the reply's.)
    const gateway = scriptedGateway().callTools([{ name: "search", input: { query: "a" } }], { text: "我先查一下。" });
    const fake = fakePort({ acknowledge: async () => "refused", tool: () => new Promise((resolve) => setTimeout(() => resolve({ output: "晚了", activity: "search" }), 3_000)) });
    const began = Date.now();
    await runOn(fake, gateway, { tools: { runTimeoutMs: 1_000 } });
    expect(Date.now() - began).toBeLessThan(2_500);
    expect(gateway.calls).toHaveLength(1);
    expect(fake.posted).toEqual([{ text: "我先查一下。", reasoning: "", stopped: false, truncated: true }]);
    expect(finishedAs(fake)).toEqual([{ status: "done" }]);
    // Acknowledged, it wrote nothing after: failed, as a reply that timed out having said nothing.
    const acked = fakePort({ tool: () => new Promise((resolve) => setTimeout(() => resolve({ output: "晚了", activity: "search" }), 3_000)) });
    await runOn(acked, scriptedGateway().callTools([{ name: "search", input: { query: "a" } }], { text: "我先查一下。" }), { tools: { runTimeoutMs: 1_000 } });
    // (Its acknowledgement was posted: the reply had produced something, so its time out is not passing.)
    expect([acked.acks.map((a) => a.text), acked.posted, finishedAs(acked)]).toEqual([["我先查一下。"], [], [{ status: "failed", error: "provider_unavailable" }]]);

    // Past it between two rounds (the port took long to answer about money): no next call.
    const later = scriptedGateway().callTools([{ name: "search", input: { query: "a" } }], { text: "我先查一下。" });
    const slow = fakePort({ acknowledge: async () => "refused", extend: () => new Promise((resolve) => setTimeout(() => resolve("ok"), 1_200)) });
    await runOn(slow, later, { tools: { runTimeoutMs: 1_000 } });
    expect(later.calls).toHaveLength(1);
    expect(slow.posted).toEqual([{ text: "我先查一下。", reasoning: "", stopped: false, truncated: true, lookups: { search: 1 } }]);

    // And with nothing written: failed, as a reply that timed out having said nothing.
    const mute = scriptedGateway().callTools([{ name: "search", input: { query: "a" } }]);
    const silent = fakePort({ extend: () => new Promise((resolve) => setTimeout(() => resolve("ok"), 1_200)) });
    await runOn(silent, mute, { tools: { runTimeoutMs: 1_000 } });
    expect(silent.posted).toEqual([]);
    // (A tool round had completed: the reply had done something, so its time out is not passing.)
    expect(finishedAs(silent)).toEqual([{ status: "failed", error: "provider_unavailable" }]);
  });

  it("a long result is cut to resultMaxWeight with the fixed mark; any other value is cut as its JSON text and sent as a string", async () => {
    const long = "川菜".repeat(200);
    const gateway = scriptedGateway()
      .callTools([
        { name: "search", input: { query: "a" } },
        { name: "search", input: { query: "b" } },
        { name: "search", input: { query: "c" } },
      ])
      .reply("好。");
    const outputs: Record<string, unknown> = { a: long, b: { hits: Array.from({ length: 50 }, (_, i) => ({ seq: i, text: "川菜很好吃" })) }, c: { hits: [] } };
    const fake = fakePort({ tool: async (call) => ({ output: outputs[(call.input as { query: string }).query], activity: "search" }) });
    await runOn(fake, gateway, { tools: { resultMaxWeight: 40 } });
    const [a, b, c] = outputsOf(gateway.calls[1]!, 0) as [string, string, unknown];
    expect(typeof a).toBe("string");
    expect(a.endsWith(CUT_MARK)).toBe(true);
    expect(long.startsWith(a.slice(0, -CUT_MARK.length))).toBe(true);
    expect(weight(a)).toBeLessThanOrEqual(40);
    expect(weight(a)).toBeGreaterThan(30);
    expect(typeof b).toBe("string");
    expect(b.endsWith(CUT_MARK)).toBe(true);
    expect(JSON.stringify(outputs.b).startsWith(b.slice(0, -CUT_MARK.length))).toBe(true);
    expect(weight(b)).toBeLessThanOrEqual(40);
    expect(c).toEqual({ hits: [] }); // short enough: as it was
  });

  it("results that would overflow the model's context are cut to what is left of it, and the next call is the last: nothing sent is over the context", async () => {
    const gateway = scriptedGateway().callTools([
      { name: "search", input: { query: "a" } },
      { name: "search", input: { query: "b" } },
    ]);
    gateway.reply("够了。");
    const contextTokens = 3_000;
    const planned = 400;
    const fake = fakePort({ toolRun: { contextTokens, planned }, tool: async () => ({ output: "很长的结果。".repeat(500), activity: "search" }) });
    await runOn(fake, gateway);
    expect(gateway.calls).toHaveLength(2);
    const last = gateway.calls[1]!;
    expect(isFinal(last)).toBe(true);
    // What the last call carries, by the same estimate the plan uses, beside what the plan had: within the plan's limit.
    const limit = Math.floor((contextTokens - 1000) * (1 - CONTEXT_HEADROOM));
    const sent = planned + estimateTokens(JSON.stringify(TOOLS) + JSON.stringify(last.steps) + `\n\n${FINAL_LINE}`);
    expect(sent).toBeLessThanOrEqual(limit + 50);
    expect(sent).toBeLessThan(contextTokens - 1000);
    const [first, second] = outputsOf(last, 0) as [string, string];
    expect(first.endsWith(CUT_MARK)).toBe(true);
    expect(second).toBe(CUT_MARK);
    expect(fake.posted.map((p) => p.text)).toEqual(["够了。"]);
  });

  it("the room the rounds may fill is what the plan's limit leaves (ToolRun.limit) beside the planned input, the tools, the last call's line and their framing, however large the model's context; the tools' text — definitions, steps, results — counted at TOOL_TEXT_FACTOR times its weight", async () => {
    const gateway = scriptedGateway().callTools([
      { name: "search", input: { query: "a" } },
      { name: "search", input: { query: "b" } },
    ]);
    gateway.reply("够了。");
    const room = 300;
    // The definitions at the factor, the line as prose.
    expect(TOOL_TEXT_FACTOR).toBe(1.5);
    const limit = 120 + estimateTokens(JSON.stringify(TOOLS), TOOL_TEXT_FACTOR) + estimateTokens(`\n\n${FINAL_LINE}`) + 400 + room;
    const fake = fakePort({ toolRun: { limit }, tool: async () => ({ output: "很长的结果。".repeat(500), activity: "search" }) });
    await runOn(fake, gateway);
    expect(gateway.calls).toHaveLength(2);
    const last = gateway.calls[1]!;
    expect(isFinal(last)).toBe(true);
    const [first, second] = outputsOf(last, 0) as [string, string];
    // Cut by the room (beside the round's own call and the framing), not by `resultMaxWeight` (3 000): a result of
    // weight w takes 1.5 w of it.
    expect(first.endsWith(CUT_MARK)).toBe(true);
    expect(weight(first)).toBeGreaterThan(room / 3 / TOOL_TEXT_FACTOR);
    expect(weight(first)).toBeLessThanOrEqual(room / TOOL_TEXT_FACTOR);
    expect(second).toBe(CUT_MARK);
    expect(fake.posted.map((p) => p.text)).toEqual(["够了。"]);
  });

  it("the port's word: final makes the next call the last; stop (the run ended elsewhere — money never stops a reply) ends the reply with what it wrote, or with nothing when it wrote nothing", async () => {
    const finalGateway = scriptedGateway().callTools([{ name: "search", input: { query: "a" } }]).reply("就这样。");
    const final = fakePort({ extend: () => "final" });
    await runOn(final, finalGateway);
    expect(isFinal(finalGateway.calls[1]!)).toBe(true);
    expect(final.posted.map((p) => p.text)).toEqual(["就这样。"]);

    // (Its acknowledgement not posted here: what it wrote before the tool is the reply's.)
    const said = scriptedGateway().callTools([{ name: "search", input: { query: "a" } }], { text: "我先查一下。", usage: U(100, 10) });
    const stopWithText = fakePort({ extend: () => "stop", acknowledge: async () => "refused" });
    await runOn(stopWithText, said);
    expect(said.calls).toHaveLength(1);
    expect(stopWithText.posted).toEqual([{ text: "我先查一下。", reasoning: "", stopped: false, truncated: true, lookups: { search: 1 } }]);
    expect(stopWithText.finished).toEqual([{ end: { status: "done" }, usage: U(100, 10), fallback: expect.any(Object) }]);

    const nothing = scriptedGateway().callTools([{ name: "search", input: { query: "a" } }], { usage: U(100, 10) });
    const stopSilent = fakePort({ extend: () => "stop" });
    await runOn(stopSilent, nothing);
    expect(stopSilent.posted).toEqual([]);
    expect(stopSilent.finished).toEqual([{ end: { status: "cancelled" }, usage: U(100, 10), fallback: expect.any(Object) }]);
  });

  it("the port failing to answer about money ends the reply with what it wrote, as cut; with nothing written it fails busy, our own trouble", async () => {
    // (Its acknowledgement not posted here: what it wrote before the tool is the reply's.)
    const said = scriptedGateway().callTools([{ name: "search", input: { query: "a" } }], { text: "我先查一下。", usage: U(100, 10) });
    const withText = fakePort({ extend: () => Promise.reject(new Error("the database is gone")), acknowledge: async () => "refused" });
    await runOn(withText, said);
    expect(said.calls).toHaveLength(1);
    expect(withText.posted).toEqual([{ text: "我先查一下。", reasoning: "", stopped: false, truncated: true, lookups: { search: 1 } }]);
    expect(finishedAs(withText)).toEqual([{ status: "done" }]);

    const mute = scriptedGateway().callTools([{ name: "search", input: { query: "a" } }], { usage: U(100, 10) });
    const silent = fakePort({ extend: () => Promise.reject(new Error("the database is gone")) });
    await runOn(silent, mute);
    expect(silent.posted).toEqual([]);
    expect(finishedAs(silent)).toEqual([{ status: "failed", error: "busy" }]);
  });

  it("settles once on the summed usage, or, when a round reported none, on each round's reported usage and the estimates of the rounds that reported none", async () => {
    const gateway = scriptedGateway()
      .callTools([{ name: "search", input: { query: "a" } }], { usage: U(100, 10), text: "查" })
      .callTools([{ name: "search", input: { query: "b" } }])
      .reply("好的", { usage: U(300, 30) });
    const fake = fakePort({ inputChars: 120 });
    await runOn(fake, gateway);
    expect(fake.finished).toHaveLength(1);
    const { usage, fallback } = fake.finished[0]!;
    // One round reported nothing: no usage in all, so the record says it was estimated.
    expect(usage).toBe(null);
    // Round 2's estimate: the conversation's, the tools and the step it carried in weight; what it wrote — its calls.
    const roundInput = (c: ModelCall) => 120 + estimateTokens(JSON.stringify(TOOLS) + (c.steps ? JSON.stringify(c.steps) : ""));
    const id = resultsOf(gateway.calls[2]!, 1)[0]!.id;
    const roundOutput = estimateTokens(JSON.stringify([{ id, name: "search", input: { query: "b" } }]));
    // Rounds 1 and 3 count what they reported.
    expect(fallback).toEqual({ inputChars: 100 + roundInput(gateway.calls[1]!) + 300, outputChars: 10 + roundOutput + 30 });
    // The money asked between the rounds: what was spent so far, counted the same way.
    expect(fake.extends.map((e) => e.spent)).toEqual([U(100, 10), null]);
    expect(fake.extends.map((e) => e.estimated)).toEqual([
      { inputChars: 100, outputChars: 10 },
      { inputChars: 100 + roundInput(gateway.calls[1]!), outputChars: 10 + roundOutput },
    ]);
  });

  it("ids that repeat or are empty within a round: each call is answered in its place, with its own id and name as received", async () => {
    let second: ModelCall | null = null;
    const calls: ToolCall[] = [
      { id: "", name: "search", input: { query: "a" } },
      { id: "", name: "search", input: { query: "b" } },
    ];
    const gateway: Pick<ModelGateway, "stream"> = {
      async *stream(call: ModelCall): AsyncGenerator<ModelEvent> {
        if (!call.steps) {
          for (const c of calls) yield { type: "tool_call", call: c };
          yield { type: "finish", usage: null, truncated: false, toolCalls: calls, assistant: [{ role: "assistant", content: [] }] };
          return;
        }
        second = call;
        yield { type: "text", delta: "好。" };
        yield { type: "finish", usage: null, truncated: false, toolCalls: [], assistant: [] };
      },
    };
    const fake = fakePort();
    await runOn(fake, gateway);
    expect(fake.tools.map((c) => c.input)).toEqual([{ query: "a" }, { query: "b" }]);
    expect(second!.steps![0]!.results).toEqual([
      { id: "", name: "search", output: { hits: [{ query: "a" }] } },
      { id: "", name: "search", output: { hits: [{ query: "b" }] } },
    ]);
  });

  it("logs counts and outcome classes only: no tool input, tool output, message text or model output", async () => {
    const log = recordingLog();
    const gateway = scriptedGateway()
      .callTools([{ name: "search", input: { query: "CANARY-INPUT" } }, { name: "CANARY-NAME", input: {} }], { text: "CANARY-TEXT" })
      .reply("CANARY-ANSWER");
    const fake = fakePort({ tool: async () => ({ output: "CANARY-OUTPUT", activity: "search" }) });
    await runOn(fake, gateway, { log });
    expect(log.lines.length).toBeGreaterThan(0);
    expect(JSON.stringify(log.lines)).not.toMatch(/CANARY|附近有什么好吃的|你是一个助手/);
  });
});

describe("what a reply's tools are doing, and what it looked up", () => {
  /** A tool that, as it runs, notes the status the port was last told (what is shown while it runs). */
  const watching = (shown: Array<Activity | null>, outcome: (call: ToolCall) => ToolOutcome = (call) => ({ output: { hits: [call.input] } })) =>
    async (call: ToolCall, _signal: AbortSignal, fake: Fake) => {
      shown.push(fake.activities.at(-1) ?? null);
      return outcome(call);
    };

  it("the status is the kind of the tool that is running, from the offer, said as it starts and once per change; none as soon as the model is called again", async () => {
    const gateway = scriptedGateway()
      .callTools([
        { name: "search", input: { query: "a" } },
        { name: "search", input: { query: "b" } },
        { name: "read_file", input: { name: "菜单.txt" } },
      ])
      .callTools([{ name: "search", input: { query: "c" } }])
      .reply("好了。");
    const shown: Array<Activity | null> = [];
    const fake = fakePort({ tool: watching(shown) });
    await runOn(fake, gateway);
    // While each ran, its own kind was shown; the second search of the round said nothing new.
    expect(shown).toEqual(["search", "search", "file", "search"]);
    expect(fake.activities).toEqual(["search", "file", null, "search", null]);
    expect(fake.posted.map((p) => p.text)).toEqual(["好了。"]);
  });

  it("a tool the offer names no kind for shows no status and is not counted: nothing it found or searched for is kept either", async () => {
    const gateway = scriptedGateway()
      .callTools([
        { name: "search", input: { query: "a" } },
        { name: "read_file", input: { name: "菜单.txt" } },
      ])
      .reply("好了。");
    const A = "00000000-0000-4000-8000-00000000000a";
    const fake = fakePort({
      toolRun: { kinds: { search: "search" } },
      // The kindless tool says it found a message and searched for a word: neither is the reply's.
      tool: async (call) => (call.name === "read_file" ? { output: "菜单", found: [{ conversationId: A, seq: 3 }], query: "菜单" } : { output: { hits: [] } }),
    });
    await runOn(fake, gateway);
    expect(fake.tools).toHaveLength(2);
    expect(fake.activities).toEqual(["search", null]);
    // Its trace keeps both calls as they ran (what returns is the store's to decide, agents/replay.ts).
    expect(fake.posted).toStrictEqual([
      { text: "好了。", reasoning: "", stopped: false, truncated: false, lookups: { search: 1 }, toolCalls: [{ name: "search", round: 1, outcome: "ok", input: { query: "a" }, found: 0 }, { name: "read_file", round: 1, outcome: "ok", input: { name: "菜单.txt" } }] },
    ]);
  });

  it("a tool's own refusal (its output an `{ error }`: it timed out, the query was too short, the file cannot be read) is not counted, and nothing it found or searched for is kept", async () => {
    const gateway = scriptedGateway()
      .callTools([
        { name: "search", input: { query: "x" } },
        { name: "read_file", input: { name: "图.pdf" } },
      ])
      .reply("没查成。");
    const A = "00000000-0000-4000-8000-00000000000a";
    const fake = fakePort({
      tool: async (call) =>
        call.name === "search"
          ? { output: { error: "这次查找超时了。" }, found: [{ conversationId: A, seq: 1 }], query: "x" }
          : { output: { error: "这种文件不是文本，读不了内容。" } },
    });
    await runOn(fake, gateway);
    // The model is sent each refusal as it is.
    expect(outputsOf(gateway.calls[1]!, 0)).toEqual([{ error: "这次查找超时了。" }, { error: "这种文件不是文本，读不了内容。" }]);
    // The reply looked nothing up: no key about it, as a reply whose tools ran none. Its trace says each was refused, with
    // the sentence it got and nothing of its input.
    expect(fake.posted).toStrictEqual([
      {
        text: "没查成。",
        reasoning: "",
        stopped: false,
        truncated: false,
        toolCalls: [
          { name: "search", round: 1, outcome: "refused", said: "这次查找超时了。" },
          { name: "read_file", round: 1, outcome: "refused", said: "这种文件不是文本，读不了内容。" },
        ],
      },
    ]);
  });

  it("the reply carries what was looked up: per kind the tools that ran; what they found, in order, without repeats, the first 20; the first 6 search words, each cut to 60 weight", async () => {
    const long = "川".repeat(100);
    const gateway = scriptedGateway()
      .callTools([
        { name: "search", input: { query: "q1" } },
        // A repeat (answered with the note), a garbled call, a tool that fails: none of them counts.
        { name: "search", input: { query: "q1" } },
        { name: "search", input: { limit: 3 } },
        { name: "read_file", input: { name: "菜单.txt" } },
        { name: "search", input: { query: "fails" } },
      ])
      .callTools(["q2", "q3", long, "q5", "q6", "q7"].map((query) => ({ name: "search", input: { query } })))
      .reply("好了。");
    const ref = (conversationId: string, seq: number) => ({ conversationId, seq });
    const A = "00000000-0000-4000-8000-00000000000a";
    const B = "00000000-0000-4000-8000-00000000000b";
    const range = (conversationId: string, from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => ref(conversationId, from + i));
    const fake = fakePort({
      tool: async (call) => {
        const input = call.input as { query?: string; name?: string };
        if (input.query === "fails") throw new Error("the store is gone");
        if (call.name === "read_file") return { output: "菜单", found: [ref(A, 11), ref(A, 12), ...range(B, 1, 12)] };
        if (input.query === "q1") return { output: { hits: 12 }, found: range(A, 1, 12), query: "q1" };
        // What is not a message reference or a search word is not kept.
        return {
          output: { hits: 1 },
          found: [ref(A, 1), { conversationId: 5, seq: 1 }, ref(B, 0), ref(B, -1), ref(B, 1.5), ref(B, 2 ** 53), ref("", 1), ref("not-a-conversation", 1), null] as never,
          query: input.query,
        };
      },
    });
    await runOn(fake, gateway);
    const [posted] = fake.posted;
    expect(posted!.lookups).toEqual({ search: 7, file: 1 });
    expect(posted!.found).toEqual([...range(A, 1, 12), ...range(B, 1, 8)]);
    expect(posted!.queries).toEqual(["q1", "q2", "q3", "川".repeat(60), "q5", "q6"]);
    // A word that shows nothing is no word.
    const blank = scriptedGateway().callTools([{ name: "search", input: { query: "  " } }]).reply("好。");
    const quiet = fakePort({ tool: async (call) => ({ output: {}, query: (call.input as { query: string }).query }) });
    await runOn(quiet, blank);
    expect(quiet.posted).toEqual([{ text: "好。", reasoning: "", stopped: false, truncated: false, lookups: { search: 1 }, toolCalls: [{ name: "search", round: 1, outcome: "ok", input: { query: "  " }, found: 0 }] }]);
  });

  it("a reply whose tools ran none posts exactly what a reply offered none posts: no key about lookups (only its trace, each call refused)", async () => {
    const gateway = scriptedGateway()
      .callTools([{ name: "web_search", input: { query: "川菜" } }])
      .callTools([{ name: "search", input: { limit: 3 } }])
      .reply("不用工具也能回答。");
    const fake = fakePort();
    await runOn(fake, gateway);
    expect(fake.tools).toEqual([]);
    expect(fake.posted).toEqual([
      {
        text: "不用工具也能回答。",
        reasoning: "",
        stopped: false,
        truncated: false,
        toolCalls: [
          { name: "web_search", round: 1, outcome: "refused", said: UNUSABLE },
          { name: "search", round: 2, outcome: "refused", said: UNUSABLE },
        ],
      },
    ]);
    expect(fake.activities).toEqual([]);
  });

  it("a tool cut off by the reply's stop: its status was shown while it ran and goes once the reply ends; it is not counted", async () => {
    const gateway = scriptedGateway().callTools([{ name: "search", input: { query: "慢" } }], { text: "我先查一下。" });
    const fake = fakePort({
      acknowledge: async () => "refused",
      tool: (_call, signal, f) =>
        new Promise((_resolve, reject) => {
          f.stop();
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
    });
    await runOn(fake, gateway);
    expect(fake.activities).toEqual(["search", null]);
    // (Its acknowledgement not posted here: what it wrote is the reply's, posted as stopped and counting nothing.)
    expect(fake.posted).toEqual([{ text: "我先查一下。", reasoning: "", stopped: true, truncated: false }]);
  });
});

describe("a reply that offers no tools", () => {
  it("makes exactly one call, as before tools existed: the prepared call as it is, nothing about tools in it, and the port is asked nothing about tools", async () => {
    const gateway: ScriptedGateway = scriptedGateway().reply("你好！", { usage: U(50, 5), reasoning: "想一想" });
    const fake = fakePort({ tools: [] });
    await runOn(fake, gateway);
    expect(gateway.calls).toHaveLength(1);
    const { signal, ...sent } = gateway.calls[0]!;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(sent).toStrictEqual(fake.prepared.call);
    expect(fake.posted).toEqual([{ text: "你好！", reasoning: "想一想", stopped: false, truncated: false }]);
    expect(fake.finished).toEqual([
      { end: { status: "done" }, usage: U(50, 5), fallback: { inputChars: 120, outputChars: estimateTokens("你好！") + estimateTokens("想一想") } },
    ]);
    expect([fake.tools, fake.extends, fake.activities, fake.unusable]).toEqual([[], [], [], []]);
  });
});

describe("whether a failed reply is passing is decided by the reply as a whole (runtime/port.ts `passingEnding`, round 2 R-2)", () => {
  type State = "nothing yet" | "thought only" | "acknowledged" | "one tool round done" | "text streamed";
  type Kind = "503" | "network" | "cut" | "timeout";
  const SLOW_TOOL = () => new Promise<never>(() => {});
  /** The script, the port and the reply's time for one cell. */
  function cell(kind: Kind, state: State): { gateway: ReturnType<typeof scriptedGateway>; fake: Fake; ms: number } {
    const g = scriptedGateway();
    const end = (gw: ReturnType<typeof scriptedGateway>, reasoning = "", text = ""): void => {
      if (kind === "503") gw.fail("provider_unavailable", { status: 503, afterReasoning: reasoning, afterText: text });
      else if (kind === "network") gw.fail("provider_unavailable", { afterReasoning: reasoning, afterText: text });
      else if (kind === "cut") gw.cut(text, reasoning);
      // Its time runs out (300 ms) after the first piece (200 ms) and before the next (400 ms).
      else if (text !== "" || reasoning !== "") gw.reply(text || "后面的话", { reasoning, delayMsPerChunk: 200 });
      else gw.hang();
    };
    if (state === "nothing yet") end(g);
    else if (state === "thought only") end(g, "我想想……");
    else if (state === "text streamed") end(g, "", "说到一半");
    else {
      g.callTools([{ name: "search", input: { query: "a" } }], state === "acknowledged" ? { text: "我先查一下。" } : {});
      // The time out of a tool reply comes while its tool still runs (acknowledged) or as its next round hangs.
      if (kind === "timeout" && state === "acknowledged") return { gateway: g, fake: fakePort({ tool: SLOW_TOOL }), ms: 300 };
      end(g);
    }
    return { gateway: g, fake: fakePort(), ms: 300 };
  }
  const kinds: Kind[] = ["503", "network", "cut", "timeout"];
  const states: State[] = ["nothing yet", "thought only", "acknowledged", "one tool round done", "text streamed"];
  const cells = kinds.flatMap((kind) => states.map((state) => [kind, state] as const));
  it.each(cells)("%s, %s", async (kind, state) => {
    const { gateway, fake, ms } = cell(kind, state);
    await runOn(fake, gateway, { tools: { runTimeoutMs: ms } });
    const [end] = finishedAs(fake);
    const passing = (end as { transient?: true }).transient === true;
    expect([kind, state, passing]).toEqual([kind, state, state === "nothing yet"]);
    if (state === "nothing yet") expect(end).toMatchObject({ status: "failed", error: "provider_unavailable" });
    expect(gateway.pending()).toBe(0);
  });

  it("a reply offered no tools: the same by its one call", async () => {
    for (const kind of kinds) {
      for (const state of ["nothing yet", "thought only", "text streamed"] as const) {
        const { gateway } = cell(kind, state);
        const fake = fakePort({ tools: [] });
        await runOn(fake, gateway, { tools: { runTimeoutMs: 300 }, runTimeoutMs: 300 });
        const passing = (finishedAs(fake)[0] as { transient?: true }).transient === true;
        expect([kind, state, passing]).toEqual([kind, state, state === "nothing yet"]);
      }
    }
  });
});

describe("the service closing mid-call: the release passes on whether the reply had produced anything (round 3 S-1)", () => {
  type State = "nothing yet" | "thought only" | "text streamed" | "acknowledged" | "one tool round done";
  const states: State[] = ["nothing yet", "thought only", "text streamed", "acknowledged", "one tool round done"];
  it.each(states)("%s", async (state) => {
    const gateway = scriptedGateway();
    if (state === "acknowledged") gateway.callTools([{ name: "search", input: { query: "a" } }], { text: "我先查一下。" });
    if (state === "one tool round done") gateway.callTools([{ name: "search", input: { query: "a" } }]);
    // Streamed in pieces of at most 8 (two here); an acknowledged reply streams again in its next round before it hangs:
    // two rounds that streamed, one reply.
    const hold =
      state === "thought only"
        ? gateway.hangAfter("", "我想想……再想一想……")
        : state === "text streamed" || state === "acknowledged"
          ? gateway.hangAfter("说到一半，后面还有很多")
          : gateway.hang();
    const fake = fakePort();
    const worker = createAgentWorker({ port: fake.port, models: gateway, runTimeoutMs: 120_000, maxRunsInFlight: 1, background: false, log: recordingLog(), tools: LIMITS });
    const running = worker.runOnce();
    await hold.reached;
    await worker.stop();
    expect(await running).toBe(true);
    expect([state, fake.releasedWith, fake.finished]).toEqual([state, [state !== "nothing yet"], []]);
    // That the reply produced something is told the port at its first piece (for the run to record): once per reply, not
    // per piece and not per round.
    expect([state, fake.progressed]).toEqual([state, state === "thought only" || state === "text streamed" || state === "acknowledged" ? 1 : 0]);
    expect(gateway.pending()).toBe(0);
  });
});

describe("what a reply that ends as an answer hands over of its rounds (Reply.toolCalls; harness design §3)", () => {
  const WEB: ToolSpec = { name: "search_web", description: "Search the web.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } };
  const WEB_KINDS = { search: "search" as const, read_file: "file" as const, search_web: "web" as const };
  const toolCallsOf = (fake: Fake) => fake.posted.map((p) => p.toolCalls);

  it("an answer after rounds: every call of the rounds its request carried, in order, each as it was answered — ran with its input and what it handed out, or refused with the sentence it got and no input", async () => {
    const gateway = scriptedGateway()
      .callTools(
        [
          { name: "search", input: { query: "川菜" } },
          { name: "search", input: { query: "川菜" } },
          { name: "search_web", input: { query: "成都 川菜 推荐" } },
        ],
        { text: "我查一下。" },
      )
      .callTools([
        { name: "search", input: { query: "短" } },
        { name: "search", input: { query: "boom" } },
        { name: "search", input: { query: "第三次" } },
        { name: "nope", input: { query: "私事" } },
      ])
      .reply("好了。");
    const fake = fakePort({
      tools: [SEARCH, READ, WEB],
      perTool: { search: 3 },
      toolRun: { kinds: WEB_KINDS },
      tool: async (call) => {
        const q = (call.input as { query: string }).query;
        if (call.name === "search_web") return { output: { about: "资料", results: [{ ref: "〔w1〕", title: "a", snippet: "甲" }, { ref: "〔w2〕", title: "b" }] }, query: q };
        if (q === "短") return { output: { error: "要查的词至少要两个字。" } };
        if (q === "boom") throw new Error("the database is down");
        return { output: { hits: [call.input] }, found: [{ conversationId: "c", seq: 1 }, { conversationId: "c", seq: 2 }], query: q };
      },
    });
    await runOn(fake, gateway);
    expect(toolCallsOf(fake)).toEqual([
      [
        { name: "search", round: 1, outcome: "ok", input: { query: "川菜" }, found: 2 },
        { name: "search", round: 1, outcome: "refused", said: REPEATED },
        { name: "search_web", round: 1, outcome: "ok", input: { query: "成都 川菜 推荐" }, pages: [1, 2], excerpts: [{ title: "a", snippet: "甲" }, { title: "b", snippet: "" }] },
        { name: "search", round: 2, outcome: "refused", said: "要查的词至少要两个字。" },
        { name: "search", round: 2, outcome: "refused", said: UNUSABLE },
        { name: "search", round: 2, outcome: "refused", said: OVER_CAP },
        { name: "nope", round: 2, outcome: "refused", said: UNUSABLE },
      ],
    ]);
    expect(JSON.stringify(fake.posted)).not.toContain("私事");
  });

  it("the last round's calls are not run and are not in it; an answer cut at its output limit keeps the rounds (its round finished)", async () => {
    const final = scriptedGateway()
      .callTools([{ name: "search", input: { query: "a" } }])
      .callTools([{ name: "search", input: { query: "b" } }], { text: "就这样。" });
    const last = fakePort();
    await runOn(last, final, { tools: { maxRounds: 1 } });
    expect(toolCallsOf(last)).toEqual([[{ name: "search", round: 1, outcome: "ok", input: { query: "a" }, found: 0 }]]);
    const cut = scriptedGateway().callTools([{ name: "search", input: { query: "a" } }]).reply("说到一半", { truncated: true });
    const atLimit = fakePort();
    await runOn(atLimit, cut);
    expect(atLimit.posted.map((p) => [p.truncated, p.toolCalls?.length])).toEqual([[true, 1]]);
  });

  it("none: no round, tools refused, the plain call after a later round's 400, the owner's stop, the reply's time, extend's stop or busy — what was written is posted with no trace", async () => {
    const cases: Array<[string, ScriptedGateway, FakeOptions, { tools?: Partial<ToolLimits> }]> = [
      ["no round", scriptedGateway().reply("直接回答。"), {}, {}],
      ["tools refused", scriptedGateway().refuseTools("没有工具也能回答。"), {}, {}],
      ["plain", scriptedGateway().callTools([{ name: "search", input: { query: "a" } }]).fail("provider_unavailable", { status: 400 }).reply("不查也能说。"), {}, {}],
      ["stop", scriptedGateway().callTools([{ name: "search", input: { query: "a" } }], { text: "我先查一下。" }), { acknowledge: async () => "refused", extend: (_n, f) => (f.stop(), "ok") }, {}],
      [
        "time",
        scriptedGateway().callTools([{ name: "search", input: { query: "a" } }], { text: "我先查一下。" }),
        { acknowledge: async () => "refused", extend: () => new Promise((resolve) => setTimeout(() => resolve("ok"), 1_200)) },
        { tools: { runTimeoutMs: 1_000 } },
      ],
      ["extend stop", scriptedGateway().callTools([{ name: "search", input: { query: "a" } }], { text: "我先查一下。" }), { acknowledge: async () => "refused", extend: () => "stop" }, {}],
      [
        "extend busy",
        scriptedGateway().callTools([{ name: "search", input: { query: "a" } }], { text: "我先查一下。" }),
        { acknowledge: async () => "refused", extend: () => Promise.reject(new Error("the database is down")) },
        {},
      ],
    ];
    for (const [label, gateway, options, over] of cases) {
      const fake = fakePort(options);
      await runOn(fake, gateway, over);
      expect([label, fake.posted.length, fake.posted.map((p) => p.toolCalls)]).toEqual([label, 1, [undefined]]);
    }
  });

  it("an upstream that refused a request carrying earlier tool use (replay_lowered): counted by protocol and a site model's id (never a provider's), nothing else logged of it, the reply goes on", async () => {
    for (const [upstreamId, details] of [
      [undefined, { metric: "replay_lowered", protocol: "openai_chat" }],
      ["site:meter_paid", { metric: "replay_lowered", protocol: "openai_chat", model: "meter_paid" }],
      ["provider:3f9a@https://relay.example.com/v1", { metric: "replay_lowered", protocol: "openai_chat" }],
    ] as const) {
      const inner = scriptedGateway().reply("好。");
      const gateway: Pick<ModelGateway, "stream"> = {
        stream: (call) =>
          (async function* (): AsyncGenerator<ModelEvent> {
            yield { type: "replay_lowered" };
            yield* inner.stream(call);
          })(),
      };
      const fake = fakePort(upstreamId === undefined ? {} : { call: { upstreamId } });
      const log = recordingLog();
      await runOn(fake, gateway, { log });
      expect(log.lines.filter((l) => (l as { details: { metric?: string } }).details.metric === "replay_lowered")).toEqual([{ level: "info", details, msg: expect.any(String) }]);
      expect(JSON.stringify(log.lines)).not.toContain("relay.example.com");
      expect([fake.posted.map((p) => p.text), finishedAs(fake), fake.unusable]).toEqual([["好。"], [{ status: "done" }], []]);
    }
  });

  it("the holds count an earlier reply's replayed calls and results as the plan does (partText): the next round's, and the plain call's after a later round's 400 (review I2)", async () => {
    const id = "0123456789abcdef012345";
    const messages: ModelCall["messages"] = [
      { role: "user", parts: [{ type: "text", text: "北京今天天气怎么样？" }] },
      { role: "assistant", parts: [{ type: "text", text: "我查一下。" }, { type: "tool-call", id, name: "search_web", input: { query: "北京 天气 预报" } }] },
      { role: "tool", parts: [{ type: "tool-result", id, name: "search_web", output: { note: "那次的结果已不在这里", sites: ["news1.example.com", "news2.example.com"], date: "2026-11-22" } }] },
      { role: "assistant", parts: [{ type: "text", text: "今天晴。" }] },
      { role: "user", parts: [{ type: "text", text: "附近有什么好吃的？" }] },
    ];
    const texts = messages.flatMap((m) => m.parts.map((p) => partText(p)!));
    const replayBytes = texts.slice(2, 4).reduce((n, t) => n + Buffer.byteLength(t), 0);
    expect(replayBytes).toBeGreaterThan(150);
    // The next round's hold: the last call's text, every part at its partText's bytes, the tools and the steps, and the preamble.
    const next = scriptedGateway().callTools([{ name: "search", input: { query: "川菜" } }]).reply("去吃川菜吧。");
    const round = fakePort({ call: { messages } });
    await runOn(round, next);
    expect(round.extends[0]!.next).toBe(holdTokens([`${SYSTEM}\n\n${FINAL_LINE}`, ...texts, JSON.stringify(TOOLS), JSON.stringify(next.calls[1]!.steps)], 100_000, 1000) + TOOL_PREAMBLE_TOKENS);
    // The plain call's: its text and every part, as it is sent lowered (no tools: the gateway's lowering, which only shrinks it).
    const PLAIN = "你是一个助手。你没有任何工具。";
    const refused = scriptedGateway().callTools([{ name: "search", input: { query: "川菜" } }]).fail("provider_unavailable", { status: 400 }).reply("不查也能说：川菜。");
    const plain = fakePort({ call: { messages, systemWithoutTools: PLAIN } });
    await runOn(plain, refused);
    expect(plain.extends[1]!.next).toBe(texts.reduce((n, t) => n + Buffer.byteLength(t), Buffer.byteLength(PLAIN)));
  });
});
