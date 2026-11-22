import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createAgentPort } from "../src/agents/port-impl.ts";
import { EXCERPT_NOTE, MESSAGES_NOTE, REFUSAL_NOTE, replayId, TIME_NOTE } from "../src/agents/replay.ts";
import { partText } from "../src/agents/runtime/context.ts";
import { isRunEnd, type AgentPort, type Prepared } from "../src/agents/runtime/port.ts";
import { TOOL_MATERIAL } from "../src/agents/runtime/prompt.ts";
import { createAgentWorker, type AgentWorker } from "../src/agents/runtime/worker.ts";
import { siteDateTime } from "../src/agents/tools/clock.ts";
import { createToolbox, CURRENT_TIME, READ_FILE, SEARCH_MESSAGES, SEARCH_WEB } from "../src/agents/tools/index.ts";
import type { WebEngine, WebResult, WebSearchError } from "../src/agents/tools/web/engine.ts";
import { WEB_QUERY_PRIVATE } from "../src/agents/tools/web/tool.ts";
import { PROTOCOLS, type Config, type WebSearchConfig } from "../src/config.ts";
import { CONTEXT_ONLY_KEYS } from "../src/messages/model.ts";
import { holdTokens, TOOL_PREAMBLE_TOKENS } from "../src/metering/tokens.ts";
import { createModelGateway, type ModelCall } from "../src/models/gateway.ts";
import { createSlots } from "../src/slots.ts";
import { api, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { grant, METER_ENV } from "./helpers/metering.ts";
import { protocolStub, scriptedGateway, STUB_MODEL, type ProtocolStub, type ScriptedGateway } from "./helpers/models.ts";
import { providerBody } from "./helpers/providers.ts";
import { closeAllSockets } from "./helpers/ws.ts";

/**
 * Step 1 of the harness design (docs/design/2026-11-24-agent-harness-design.md §3, §7; README "Agents and runs", Earlier
 * tool use in history), end to end on the real port and database: a reply in the Agent's own conversation that answered
 * after tool rounds keeps the calls of exactly those rounds (`toolCalls`, a web search's excerpt of its first pages
 * included), and a later reply there that is offered those tools is shown them in the provider's own form — what the
 * request the gateway receives says (the scripted gateway's record, then the real gateway's wire per protocol): as one of
 * the two most recent, the excerpt it kept (tests/reply-replay-recent.test.ts: older ones, and replies from before
 * excerpts were kept, show the placeholder), the acknowledgement after the results. Everything else is as it was:
 * groups, tool-less requests, calls to a tool not offered now; and the facts have one reader.
 */

const logLines: string[] = [];
const { app, db } = useApp({ env: METER_ENV, agentWorker: false, logStream: { write: (line) => void logLines.push(line) } });

let stub: ProtocolStub;
beforeAll(async () => {
  stub = await protocolStub();
});
afterAll(async () => {
  await stub.close();
});
afterEach(async () => {
  await closeAllSockets();
});

const PAID = { source: "site", id: "meter_paid" } as const;
const QUERY = "北京 天气 预报";
const RESULTS: WebResult[] = [1, 2, 3].map((i) => ({ url: `https://news${i}.example.com/a/${i}`, title: `新闻标题${i}`, snippet: `摘要内容${i}`, age: "2026-11-20T08:00:00Z" }));
const SITES = ["news1.example.com", "news2.example.com", "news3.example.com"];
/** What a web search keeps of the fake engine's results, and how a recent reply shows them (each page's site first). */
const EXCERPTS = RESULTS.map((r) => ({ title: r.title, snippet: r.snippet }));
const SHOWN = RESULTS.map((r, i) => ({ site: SITES[i]!, title: r.title, snippet: r.snippet }));

function fakeEngine(answer: () => { results: WebResult[] } | { error: WebSearchError } = () => ({ results: RESULTS })): WebEngine {
  return { name: "fake", searchWeb: async () => answer() };
}

const webConfig = (web: Partial<WebSearchConfig> = {}, tools: Partial<Config["tools"]> = {}): Config => ({
  ...app.deps.config,
  tools: { ...app.deps.config.tools, ...tools, web: { ...app.deps.config.tools.web, enabled: true, pointsMicroPerSearch: 770_350, costMicroUsdPerSearch: 2000, ...web } },
});

/** The app's port and a worker on it run by hand, with a toolbox on `engine` (null: no web search); `wrap` may stand in front of the port. */
function webWorker(gateway: ScriptedGateway, engine: WebEngine | null, config: Config = webConfig(), wrap: (port: AgentPort) => AgentPort = (p) => p): { worker: AgentWorker; port: AgentPort } {
  const { db: pool, blobs, conversations, reads, searches } = app.deps;
  const toolbox = createToolbox({ db: pool, blobs, searches, config, log: app.log, webEngine: engine });
  const port = createAgentPort({ db: pool, config, blobs, realtime: app.realtime, conversations, reads, log: app.log, toolbox });
  const worker = createAgentWorker({ port: wrap(port), models: gateway, runTimeoutMs: config.agentRunTimeoutMs, maxRunsInFlight: 1, background: false, log: app.log, tools: config.tools });
  return { worker, port };
}

let txn = 0;
const say = async (who: Actor, conv: string, text: string): Promise<number> => {
  const sent = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `rp${++txn}` });
  if (sent.status !== 201) throw new Error(`say: ${sent.status} ${JSON.stringify(sent.json)}`);
  return sent.json.message.seq as number;
};

async function owned(name: string) {
  const owner = await signUp(app, name);
  const agent = await mustCreateAgent(app, owner, { handle: `${name}_bot`, name: "小助手", model: PAID, persona: "简短地回答。" });
  await grant(db, owner.id, 20_000_000n);
  return { owner, agent, own: agent.conversationId as string };
}

/** The Agent's messages in `conv`, oldest first: id, body and when, as stored. */
const replies = async (conv: string, agentId: string) =>
  (
    await db.query<{ id: string; seq: number; body: Record<string, any>; created_at: Date }>(
      "select id::text, seq::int, body, created_at from messages where conversation_id = $1 and sender_id = $2 order by seq",
      [conv, agentId],
    )
  ).rows;
const dayOf = (at: Date): string => siteDateTime(at, app.deps.config.siteTimezone).date;

/** A call's turns as the model is shown them: each part its text, or what a replayed call and result are. */
const shape = (call: Pick<ModelCall, "messages">) =>
  call.messages.map((m) => [
    m.role,
    m.parts.map((p) =>
      p.type === "text" ? p.text : p.type === "tool-call" ? { call: p.name, id: p.id, input: p.input } : p.type === "tool-result" ? { result: p.name, id: p.id, output: p.output } : p.type,
    ),
  ]);
const toolParts = (call: Pick<ModelCall, "messages">) => call.messages.flatMap((m) => m.parts.filter((p) => p.type === "tool-call" || p.type === "tool-result"));

/** A reply that searched the web (acknowledged, then an answer citing its second page), then the owner's next question, answered. */
async function searchedThenAsked(name: string, gateway = scriptedGateway(), engine: WebEngine | null = fakeEngine(), next = webWorker(gateway, engine)) {
  const first = webWorker(gateway, fakeEngine());
  const { owner, agent, own } = await owned(name);
  await say(owner, own, "北京今天天气怎么样？");
  gateway.callTools([{ name: SEARCH_WEB, input: { query: QUERY } }], { text: "我查一下。" }).reply("根据搜索结果，今天晴〔w2〕，有风。");
  expect(await first.worker.runOnce()).toBe(true);
  await say(owner, own, "那明天呢？");
  gateway.reply("明天也晴。");
  expect(await next.worker.runOnce()).toBe(true);
  const answer = (await replies(own, agent.id)).find((r) => r.body.text === "根据搜索结果，今天晴，有风。")!;
  return { owner, agent, own, answer, later: gateway.calls.at(-1)!, gateway };
}

/** The turns of the conversation as they were sent before step 1. */
const TODAY: ModelCall["messages"] = [
  { role: "user", parts: [{ type: "text", text: "北京今天天气怎么样？" }] },
  { role: "assistant", parts: [{ type: "text", text: "我查一下。" }, { type: "text", text: "根据搜索结果，今天晴，有风。" }] },
  { role: "user", parts: [{ type: "text", text: "那明天呢？" }] },
];

describe("in the Agent's own conversation, a reply that searched returns in the provider's own form (step 1)", () => {
  it("[call] > [the excerpt it kept, under the material sentence: each page's site, title and snippet, the day] > [acknowledgement, answer]; the reply keeps the call and the excerpt, never on the wire", async () => {
    const { owner, agent, own, answer, later } = await searchedThenAsked("rpa");
    expect(answer.body.toolCalls).toEqual([{ name: SEARCH_WEB, round: 1, outcome: "ok", input: { query: QUERY }, pages: [1, 2, 3], excerpts: EXCERPTS }]);
    const id = replayId(answer.id, 0);
    expect(shape(later)).toEqual([
      ["user", ["北京今天天气怎么样？"]],
      ["assistant", [{ call: SEARCH_WEB, id, input: { query: QUERY } }]],
      ["tool", [{ result: SEARCH_WEB, id, output: { about: TOOL_MATERIAL, results_returned_then: 3, excerpts: SHOWN, note: EXCERPT_NOTE, date: dayOf(answer.created_at) } }]],
      ["assistant", ["我查一下。", "根据搜索结果，今天晴，有风。"]],
      ["user", ["那明天呢？"]],
    ]);
    // Never an address: a page is its site.
    for (const r of RESULTS) expect(JSON.stringify(later.messages)).not.toContain(r.url);
    // The reply that was shown it keeps nothing of it (it called no tool); the wire never carries the key.
    const later2 = (await replies(own, agent.id)).at(-1)!;
    expect(later2.body).not.toHaveProperty("toolCalls");
    for (const url of [`/api/conversations/${own}/messages`, `/api/conversations/${own}/messages/${answer.seq}`, "/api/sync"]) {
      const read = await api(app, owner, "GET", url);
      expect([url, read.status]).toEqual([url, 200]);
      for (const key of CONTEXT_ONLY_KEYS) expect([url, JSON.stringify(read.json).includes(`"${key}"`)]).toEqual([url, false]);
    }
  });

  it("per wire format: that request goes in the protocol's own form when the tools go with it, and is the request made before step 1 when they do not", async () => {
    const { later } = await searchedThenAsked("rpb");
    const gateway = createModelGateway({ calls: createSlots(8), allowInsecureLocal: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const send = async (c: Omit<ModelCall, "signal">): Promise<{ raw: string; body: any }> => {
      stub.reset();
      for await (const _ of gateway.stream({ ...c, signal: AbortSignal.timeout(10_000) })) void _;
      return { raw: stub.requests[0]!.raw, body: stub.requests[0]!.body };
    };
    const { signal: _signal, ...recorded } = later;
    for (const protocol of PROTOCOLS) {
      const at = { ...recorded, protocol, baseUrl: stub.baseUrl, apiKey: "sk-stub", model: STUB_MODEL };
      const native = await send(at);
      const flat = JSON.stringify(native.body);
      // The call (its input as the protocol writes it: an object, or its JSON text) and the excerpt in a tool result.
      expect([protocol, flat.includes(SEARCH_WEB), flat.includes(EXCERPT_NOTE), flat.includes("摘要内容2"), flat.includes(QUERY)]).toEqual([protocol, true, true, true, true]);
      const turns: unknown[] = native.body.messages ?? native.body.input ?? native.body.contents;
      const items = turns.map((t) => JSON.stringify(t));
      const indexOf = (s: string) => items.findIndex((t) => t.includes(s));
      const asResult = (t: string) => ['"role":"tool"', '"function_call_output"', '"tool_result"', '"functionResponse"'].some((k) => t.includes(k));
      // The excerpt only inside the tool result; the acknowledgement after it, heading the answer (its turn; the Responses
      // API's item before it, each text part being one there), never in a turn with the call.
      expect([protocol, items.filter((t) => t.includes("摘要内容2")).every(asResult), indexOf("我查一下。") > indexOf(EXCERPT_NOTE), indexOf("根据搜索结果") - indexOf("我查一下。"), items.some((t) => t.includes("我查一下。") && t.includes(SEARCH_WEB))]).toEqual([
        protocol,
        true,
        true,
        protocol === "openai_responses" ? 1 : 0,
        false,
      ]);
      const without = await send({ ...at, tools: [] });
      expect([protocol, without.raw]).toEqual([protocol, (await send({ ...at, tools: [], messages: TODAY })).raw]);
    }
  });

  it("two rounds, three tools: one turn per round holding its calls, then their results — the excerpt, the clock's day, how many messages a search found — and the acknowledgement and the answer after the last", async () => {
    const gateway = scriptedGateway();
    const { worker } = webWorker(gateway, fakeEngine());
    const { owner, agent, own } = await owned("rpc");
    await say(owner, own, "北京今天天气怎么样？");
    gateway
      .callTools(
        [
          { name: SEARCH_WEB, input: { query: QUERY } },
          { name: CURRENT_TIME, input: {} },
        ],
        { text: "我查一下。" },
      )
      .callTools([{ name: SEARCH_MESSAGES, input: { query: "从没说过的词" } }])
      .reply("今天晴〔w1〕。");
    expect(await worker.runOnce()).toBe(true);
    await say(owner, own, "好");
    gateway.reply("嗯。");
    expect(await worker.runOnce()).toBe(true);
    const answer = (await replies(own, agent.id)).find((r) => r.body.text === "今天晴。")!;
    const day = dayOf(answer.created_at);
    const [a, b, c] = [0, 1, 2].map((i) => replayId(answer.id, i));
    expect(shape(gateway.calls.at(-1)!)).toEqual([
      ["user", ["北京今天天气怎么样？"]],
      [
        "assistant",
        [
          { call: SEARCH_WEB, id: a, input: { query: QUERY } },
          { call: CURRENT_TIME, id: b, input: {} },
        ],
      ],
      [
        "tool",
        [
          { result: SEARCH_WEB, id: a, output: { about: TOOL_MATERIAL, results_returned_then: 3, excerpts: SHOWN, note: EXCERPT_NOTE, date: day } },
          { result: CURRENT_TIME, id: b, output: { note: TIME_NOTE, date: day } },
        ],
      ],
      ["assistant", [{ call: SEARCH_MESSAGES, id: c, input: { query: "从没说过的词" } }]],
      ["tool", [{ result: SEARCH_MESSAGES, id: c, output: { messages_found_then: 0, text_kept_here: false, note: MESSAGES_NOTE, date: day } }]],
      ["assistant", ["我查一下。", "今天晴。"]],
      ["user", ["好"]],
    ]);
  });

  it("a search the guard refused returns as a call with an empty query and the tool's own sentence: the query is kept nowhere, and the note it held is in no later request once deleted", async () => {
    const NOTE = "主人住在北京市海淀区中关村南大街五号";
    const PRIVATE = "海淀区中关村南大街 美食";
    const gateway = scriptedGateway();
    const { worker } = webWorker(gateway, fakeEngine());
    const { owner, agent, own } = await owned("rpd");
    await db.query("insert into agent_notes (agent_id, text, vault) values ($1, $2, true)", [agent.id, NOTE]);
    await say(owner, own, "附近有什么好吃的？");
    gateway.callTools([{ name: SEARCH_WEB, input: { query: PRIVATE } }], { text: "我查一下。" }).reply("这个不能拿去搜。");
    expect(await worker.runOnce()).toBe(true);
    expect(JSON.stringify(gateway.calls.at(-1)!.steps)).toContain(WEB_QUERY_PRIVATE);
    const answer = (await replies(own, agent.id)).find((r) => r.body.text === "这个不能拿去搜。")!;
    expect(answer.body.toolCalls).toEqual([{ name: SEARCH_WEB, round: 1, outcome: "refused", error: WEB_QUERY_PRIVATE }]);
    expect(JSON.stringify(answer.body)).not.toContain("中关村");
    const id = replayId(answer.id, 0);
    const expected = [
      ["user", ["附近有什么好吃的？"]],
      ["assistant", [{ call: SEARCH_WEB, id, input: { query: "" } }]],
      ["tool", [{ result: SEARCH_WEB, id, output: { error: WEB_QUERY_PRIVATE, note: REFUSAL_NOTE, date: dayOf(answer.created_at) } }]],
      ["assistant", ["我查一下。", "这个不能拿去搜。"]],
    ];
    // A vaulted note is shown in its own conversation's notes, as always — and nowhere in the turns.
    await say(owner, own, "那算了");
    gateway.reply("好。");
    expect(await worker.runOnce()).toBe(true);
    expect(shape(gateway.calls.at(-1)!).slice(0, 4)).toEqual(expected);
    expect(JSON.stringify(gateway.calls.at(-1)!.messages)).not.toContain("中关村");
    // Deleted: in no part of any later request.
    await db.query("delete from agent_notes where agent_id = $1", [agent.id]);
    await say(owner, own, "还有别的吗");
    gateway.reply("没有了。");
    expect(await worker.runOnce()).toBe(true);
    const last = gateway.calls.at(-1)!;
    expect(shape(last).slice(0, 4)).toEqual(expected);
    expect(JSON.stringify({ system: last.system, without: last.systemWithoutTools, messages: last.messages })).not.toContain("中关村");
  });

  it("the plain call after a later round's 400 keeps nothing: the reply returns as its text", async () => {
    const gateway = scriptedGateway();
    const { worker } = webWorker(gateway, fakeEngine());
    const { owner, agent, own } = await owned("rpe");
    await say(owner, own, "北京今天天气怎么样？");
    gateway.callTools([{ name: SEARCH_WEB, input: { query: QUERY } }], { text: "我查一下。" }).fail("provider_unavailable", { status: 400 }).reply("根据搜索结果，今天晴，有风。");
    expect(await worker.runOnce()).toBe(true);
    expect((await replies(own, agent.id)).map((r) => r.body.toolCalls)).toEqual([undefined, undefined]);
    await say(owner, own, "那明天呢？");
    gateway.reply("明天也晴。");
    expect(await worker.runOnce()).toBe(true);
    expect(shape(gateway.calls.at(-1)!)).toEqual(shape({ messages: TODAY }));
  });
});

describe("everything else is as it was", () => {
  it("a tool not offered now — the web search off — returns the reply as its text; a reply that read a file keeps nothing", async () => {
    const offline = scriptedGateway();
    const { answer, later } = await searchedThenAsked("rpf", offline, null, webWorker(offline, null));
    expect(answer.body.toolCalls).toHaveLength(1);
    expect(later.tools!.map((t) => t.name)).not.toContain(SEARCH_WEB);
    expect(shape(later)).toEqual(shape({ messages: TODAY }));

    const gateway = scriptedGateway();
    const { worker } = webWorker(gateway, fakeEngine());
    const { owner, agent, own } = await owned("rpg");
    await say(owner, own, "看看文件");
    gateway.callTools([{ name: READ_FILE, input: { file: "f1" } }], { text: "我看看。" }).reply("没有这个文件。");
    expect(await worker.runOnce()).toBe(true);
    expect((await replies(own, agent.id)).map((r) => r.body.toolCalls)).toEqual([undefined, undefined]);
    await say(owner, own, "好");
    gateway.reply("嗯。");
    expect(await worker.runOnce()).toBe(true);
    expect(toolParts(gateway.calls.at(-1)!)).toEqual([]);
  });

  it("a reply offered no tools is shown the history exactly as before step 1", async () => {
    const gateway = scriptedGateway();
    const { answer, later } = await searchedThenAsked("rph", gateway, null, webWorker(gateway, null, webConfig({}, { enabled: false })));
    expect(answer.body.toolCalls).toHaveLength(1);
    expect(later.tools ?? []).toEqual([]);
    expect(later.messages).toEqual(TODAY);
  });

  it("in a group: nothing is kept and nothing returns — the request is as it was", async () => {
    const gateway = scriptedGateway();
    const { worker } = webWorker(gateway, fakeEngine());
    const { owner, agent } = await owned("rpi");
    const mia = await signUp(app, "rpi_mia");
    const g = await group(app, owner, "资讯", [mia, await signUp(app, "rpi_ned")]);
    expect((await api(app, owner, "POST", `/api/conversations/${g}/members`, { principalId: agent.id })).status).toBe(201);
    await say(mia, g, "@rpi_bot 北京天气？");
    gateway.callTools([{ name: SEARCH_WEB, input: { query: QUERY } }]).reply("晴〔w1〕。");
    expect(await worker.runOnce()).toBe(true);
    expect((await replies(g, agent.id)).map((r) => Object.hasOwn(r.body, "toolCalls"))).toEqual([false]);
    await say(mia, g, "@rpi_bot 谢谢");
    gateway.reply("不客气。");
    expect(await worker.runOnce()).toBe(true);
    const later = gateway.calls.at(-1)!;
    expect(toolParts(later)).toEqual([]);
    expect(later.messages.map((m) => m.role)).not.toContain("tool");
  });
});

describe("a reply that looped past its tools' caps (review I1)", () => {
  it("24 calls in its rounds: nothing is kept, so on a model of 8 192 tokens a later reply is still shown the older turns, the reply as its text", async () => {
    const gateway = scriptedGateway();
    const { worker } = webWorker(gateway, fakeEngine());
    const owner = await signUp(app, "rpl");
    const provider = (await api(app, owner, "POST", "/api/providers", providerBody({ models: [{ name: "small8k", contextTokens: 8192 }] }))).json;
    const agent = await mustCreateAgent(app, owner, { handle: "rpl_bot", name: "小助手", model: { source: "provider", providerId: provider.id, model: "small8k" }, persona: "简短地回答。" });
    await grant(db, owner.id, 20_000_000n);
    const own = agent.conversationId as string;
    await say(owner, own, "最早的问题：你好。");
    gateway.reply("最早的回答：你好。");
    expect(await worker.runOnce()).toBe(true);
    await say(owner, own, "北京今天天气怎么样？");
    // One round of 24 searches, each its own query: the first 3 run (the web search's cap), 21 are refused past it.
    gateway.callTools(Array.from({ length: 24 }, (_, i) => ({ name: SEARCH_WEB, input: { query: `北京 天气 预报 第${i + 1}次 ${"详细".repeat(10)}` } })), { text: "我查一下。" }).reply("查到了：今天晴。");
    expect(await worker.runOnce()).toBe(true);
    expect(JSON.stringify(gateway.calls.at(-1)!.steps)).toContain('"note":"这类查询这次回复里不能再用了。"');
    const looped = (await replies(own, agent.id)).find((r) => r.body.text === "查到了：今天晴。")!;
    expect(looped.body).not.toHaveProperty("toolCalls");
    await say(owner, own, "那明天呢？");
    gateway.reply("明天也晴。");
    expect(await worker.runOnce()).toBe(true);
    const later = gateway.calls.at(-1)!;
    expect((later.tools ?? []).length).toBeGreaterThan(0);
    expect(shape(later)).toEqual([
      ["user", ["最早的问题：你好。"]],
      ["assistant", ["最早的回答：你好。"]],
      ["user", ["北京今天天气怎么样？"]],
      ["assistant", ["我查一下。", "查到了：今天晴。"]],
      ["user", ["那明天呢？"]],
    ]);
  });
});

describe("the money: a replay is weighed once, as the plan weighs it (partText), and held for at least what the wire carries", () => {
  /** The UTF-8 bytes of every string a request body carries (texts, ids, names, arguments, results, the tools' words): what any tokenizer reads of it. */
  const contentBytes = (value: unknown): number =>
    typeof value === "string" ? Buffer.byteLength(value, "utf8") : Array.isArray(value) ? value.reduce((n: number, v) => n + contentBytes(v), 0) : value !== null && typeof value === "object" ? Object.values(value).reduce((n: number, v) => n + contentBytes(v), 0) : 0;

  it("ten replayed replies: admission holds every part at its partText's bytes; the hold is at least every byte the request carries, on every protocol", async () => {
    const gateway = scriptedGateway();
    const { worker, port } = webWorker(gateway, fakeEngine());
    const { owner, own } = await owned("rpj");
    // Crossing 10: eleven questions, ten searched answers (a query of its own each, so none is a repeat).
    for (let i = 1; i <= 10; i++) {
      await say(owner, own, `第${i}个问题：北京今天天气怎么样？`);
      gateway.callTools([{ name: SEARCH_WEB, input: { query: `${QUERY} ${i}` } }], { text: `我查一下第${i}个。` }).reply(`第${i}个：今天晴〔w2〕。`);
      expect(await worker.runOnce()).toBe(true);
    }
    await say(owner, own, "第11个问题：那明天呢？");
    const ticket = (await (port as AgentPort).claimNext())!;
    const prepared = (await port.begin(ticket)) as Prepared;
    expect(isRunEnd(prepared)).toBe(false);
    expect(prepared.call.messages.filter((m) => m.role === "tool")).toHaveLength(10);
    const texts = prepared.call.messages.flatMap((m) => m.parts.flatMap((p) => partText(p) ?? []));
    const heldTokens = holdTokens([prepared.call.system, ...texts, JSON.stringify(prepared.tools)], 100_000, 1000) + TOOL_PREAMBLE_TOKENS;
    const hold = BigInt((await db.query<{ hold: string }>("select hold_micro::text as hold from agent_runs where id = $1", [ticket.id])).rows[0]!.hold);
    expect(hold).toBe(BigInt(heldTokens) * 100n + 1000n * 1000n);
    // What a hold of the text parts alone would miss: the replay's bytes.
    const textOnly = holdTokens([prepared.call.system, ...prepared.call.messages.flatMap((m) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : []))), JSON.stringify(prepared.tools)], 100_000, 1000);
    expect(heldTokens - TOOL_PREAMBLE_TOKENS - textOnly).toBeGreaterThan(10 * 150);
    const real = createModelGateway({ calls: createSlots(8), allowInsecureLocal: true });
    for (const protocol of PROTOCOLS) {
      stub.reset();
      for await (const _ of real.stream({ ...prepared.call, tools: [...prepared.tools], protocol, baseUrl: stub.baseUrl, apiKey: "sk-stub", model: STUB_MODEL, signal: AbortSignal.timeout(10_000) })) void _;
      const carried = contentBytes(stub.requests[0]!.body);
      expect([protocol, heldTokens >= carried]).toEqual([protocol, true]);
    }
    await port.finish(ticket, { status: "done" }, { inputTokens: 0, outputTokens: 0 }, { inputChars: 0, outputChars: 0 });
  });
});

describe("the facts have one reader", () => {
  it("only the context reads a stored reply's toolCalls (the one SQL that names it), the summary and the memory review only named keys of a body; search never finds its words, the excerpt's included; no log line holds them", async () => {
    // Every SQL text of the service that reads the key is the context's (agents/context.ts `loadPage`).
    const SRC = fileURLToPath(new URL("../src/", import.meta.url));
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []));
    const named = (pattern: RegExp) => files(SRC).filter((f) => pattern.test(readFileSync(f, "utf8"))).map((f) => path.relative(SRC, f).split(path.sep).join("/")).sort();
    expect(named(/->>?\s*'toolCalls'/)).toEqual(["agents/context.ts"]);
    // And in code: the key named as a string, or a body's member, only where it is read for the context, written by the
    // post, and listed as a context-only key (review M5).
    expect(named(/["']toolCalls["']|body\??\.\s*toolCalls|body\??\[\s*["'`]toolCalls/)).toEqual(["agents/context.ts", "agents/conversation.ts", "messages/model.ts"]);
    expect(CONTEXT_ONLY_KEYS).toContain("toolCalls");
    // The rolling summary and the memory review read a message's text (and attachment, event) by name, never its whole body:
    // no `m.body` that is not followed by a key, and not the columns the wire's reader takes (`MESSAGE_COLUMNS`).
    const under = (dir: string) => files(path.join(SRC, dir)).map((f) => [path.relative(SRC, f).split(path.sep).join("/"), readFileSync(f, "utf8")] as const);
    const whole = [...under("agents/summary"), ...under("memory")].filter(([, text]) => /\bm\.body\b(?!\s*->)|MESSAGE_COLUMNS/.test(text)).map(([f]) => f);
    expect(whole).toEqual([]);

    logLines.length = 0;
    const { owner, own } = await searchedThenAsked("rpk");
    // "预报" is only in the query, "摘要内容" only in the excerpt: no message holds either.
    for (const q of ["预报", "摘要内容"])
      for (const url of [`/api/conversations/${own}/search?q=${encodeURIComponent(q)}`, `/api/search?q=${encodeURIComponent(q)}`]) {
        const found = await api(app, owner, "GET", url);
        expect([url, found.status, found.json.messages.length]).toEqual([url, 200, 0]);
      }
    const logged = logLines.join("\n");
    for (const s of [QUERY, EXCERPT_NOTE, "news2.example.com", "摘要内容", "新闻标题"]) expect([s, logged.includes(s)]).toEqual([s, false]);
  });
});
