import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createAgentPort } from "../src/agents/port-impl.ts";
import { D_NOTE, H2_WEB_NOTE, REAL_REPLIES, replayId, WEB_NOTE } from "../src/agents/replay.ts";
import { createAgentWorker, type AgentWorker } from "../src/agents/runtime/worker.ts";
import { TOOL_MATERIAL } from "../src/agents/runtime/prompt.ts";
import { siteDateTime } from "../src/agents/tools/clock.ts";
import { createToolbox, SEARCH_WEB } from "../src/agents/tools/index.ts";
import type { WebEngine, WebResult } from "../src/agents/tools/web/engine.ts";
import { PROTOCOLS, type Config, type WebSearchConfig } from "../src/config.ts";
import { CONTEXT_ONLY_KEYS } from "../src/messages/model.ts";
import { createModelGateway, type ModelCall } from "../src/models/gateway.ts";
import { createSlots } from "../src/slots.ts";
import { api, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { grant, METER_ENV } from "./helpers/metering.ts";
import { protocolStub, scriptedGateway, STUB_MODEL, type ProtocolStub, type ScriptedGateway } from "./helpers/models.ts";
import { closeAllSockets } from "./helpers/ws.ts";

/**
 * The replay's forms end to end (fix round 2; \`TOOLS.replayForm\`, docs/design/2026-11-24-agent-harness-design.md §3): what
 * a later reply in the Agent's own conversation is shown in each — the request the gateway receives, and the wire per
 * protocol where the shape differs — and, for D, that the web excerpt it stores has the trace's one reader.
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
const result = (turn: number, i: number): WebResult => ({ url: `https://site${turn}${i}.example.com/a/${i}`, title: `第${turn}次的标题${i}`, snippet: `第${turn}次的摘要${i} 原文片段`, age: "2026-11-20T08:00:00Z" });
let searches = 0;
function fakeEngine(): WebEngine {
  return { name: "fake", searchWeb: async () => ({ results: [1, 2, 3].map((i) => result(searches + 1, i)) }) };
}
const config = (replayForm: Config["tools"]["replayForm"], web: Partial<WebSearchConfig> = {}): Config => ({
  ...app.deps.config,
  tools: { ...app.deps.config.tools, replayForm, web: { ...app.deps.config.tools.web, enabled: true, pointsMicroPerSearch: 770_350, costMicroUsdPerSearch: 2000, ...web } },
});
function webWorker(gateway: ScriptedGateway, c: Config): AgentWorker {
  const { db: pool, blobs, conversations, reads, searches: slots } = app.deps;
  const toolbox = createToolbox({ db: pool, blobs, searches: slots, config: c, log: app.log, webEngine: fakeEngine() });
  const port = createAgentPort({ db: pool, config: c, blobs, realtime: app.realtime, conversations, reads, log: app.log, toolbox });
  return createAgentWorker({ port, models: gateway, runTimeoutMs: c.agentRunTimeoutMs, maxRunsInFlight: 1, background: false, log: app.log, tools: c.tools });
}

let txn = 0;
const say = async (who: Actor, conv: string, text: string) => {
  const sent = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `rf${++txn}` });
  if (sent.status !== 201) throw new Error(`say: ${sent.status}`);
};
async function owned(name: string) {
  const owner = await signUp(app, name);
  const agent = await mustCreateAgent(app, owner, { handle: `${name}_bot`, name: "小助手", model: PAID, persona: "简短地回答。" });
  await grant(db, owner.id, 20_000_000n);
  return { owner, agent, own: agent.conversationId as string };
}
const replies = async (conv: string, agentId: string) =>
  (await db.query<{ id: string; body: Record<string, any>; created_at: Date }>("select id::text, body, created_at from messages where conversation_id = $1 and sender_id = $2 order by seq", [conv, agentId])).rows;
const dayOf = (at: Date) => siteDateTime(at, app.deps.config.siteTimezone).date;
const shape = (call: Pick<ModelCall, "messages">) =>
  call.messages.map((m) => [m.role, m.parts.map((p) => (p.type === "text" ? p.text : p.type === "tool-call" ? `call ${p.name}` : p.type === "tool-result" ? p.output : p.type))]);

/** `n` searched replies (each acknowledged, each one web search answered), then one more question, all in `form`. */
async function searched(name: string, form: Config["tools"]["replayForm"], n = 1) {
  const gateway = scriptedGateway();
  const worker = webWorker(gateway, config(form));
  const { owner, agent, own } = await owned(name);
  searches = 0;
  for (let i = 1; i <= n; i++) {
    await say(owner, own, `第${i}个问题`);
    gateway.callTools([{ name: SEARCH_WEB, input: { query: `天气 第${i}次` } }], { text: `我查一下第${i}个。` }).reply(`第${i}个回答〔w1〕。`);
    expect(await worker.runOnce()).toBe(true);
    searches++;
  }
  await say(owner, own, "最后的问题");
  gateway.reply("好。");
  expect(await worker.runOnce()).toBe(true);
  const answers = (await replies(own, agent.id)).filter((r) => /个回答/.test(r.body.text ?? ""));
  return { owner, agent, own, answers, later: gateway.calls.at(-1)! };
}

describe("the switch, read in config.ts alone", () => {
  it("the service's default is H: a later reply is shown step 1's placeholder", async () => {
    expect(app.deps.config.tools.replayForm).toBe("H");
    const { answers, later } = await searched("rfa", app.deps.config.tools.replayForm);
    expect(shape(later)[2]).toEqual(["tool", [{ note: WEB_NOTE, sites: ["site11.example.com", "site12.example.com", "site13.example.com"], date: dayOf(answers[0]!.created_at) }]]);
    expect(answers[0]!.body.toolCalls[0]).not.toHaveProperty("excerpts");
  });
});

describe("H2: the placeholder says what the search returned then", () => {
  it("a later reply is shown how many results there were, that their text is not kept here, and that the answer was written from them", async () => {
    const { answers, later } = await searched("rfb", "H2");
    expect(shape(later)).toEqual([
      ["user", ["第1个问题"]],
      ["assistant", ["我查一下第1个。", `call ${SEARCH_WEB}`]],
      ["tool", [{ results_returned_then: 3, text_kept_here: false, note: H2_WEB_NOTE, sites: ["site11.example.com", "site12.example.com", "site13.example.com"], date: dayOf(answers[0]!.created_at) }]],
      ["assistant", ["第1个回答。"]],
      ["user", ["最后的问题"]],
    ]);
    expect(answers[0]!.body.toolCalls[0]).not.toHaveProperty("excerpts");
  });
});

describe("H3: the acknowledgement after the results, heading the answer", () => {
  it("[call] > [result] > [acknowledgement, answer] — and per protocol natively, and lowered to the request made before step 1", async () => {
    const { later } = await searched("rfc", "H3");
    const s = shape(later);
    expect([s[1], s[3]]).toEqual([
      ["assistant", [`call ${SEARCH_WEB}`]],
      ["assistant", ["我查一下第1个。", "第1个回答。"]],
    ]);
    const gateway = createModelGateway({ calls: createSlots(8), allowInsecureLocal: true });
    const { signal: _signal, ...recorded } = later;
    const today: ModelCall["messages"] = [
      { role: "user", parts: [{ type: "text", text: "第1个问题" }] },
      { role: "assistant", parts: [{ type: "text", text: "我查一下第1个。" }, { type: "text", text: "第1个回答。" }] },
      { role: "user", parts: [{ type: "text", text: "最后的问题" }] },
    ];
    const send = async (c: Omit<ModelCall, "signal">) => {
      stub.reset();
      for await (const _ of gateway.stream({ ...c, signal: AbortSignal.timeout(10_000) })) void _;
      return stub.requests[0]!;
    };
    for (const protocol of PROTOCOLS) {
      const at = { ...recorded, protocol, baseUrl: stub.baseUrl, apiKey: "sk-stub", model: STUB_MODEL };
      const native = (await send(at)).body;
      const turns: any[] = native.messages ?? native.input ?? native.contents;
      const flat = turns.map((t) => JSON.stringify(t));
      // The acknowledgement comes after the result, heading the answer (its turn; the Responses API's next item, each text
      // part being an item of its own there): never in a turn with the call.
      const ackAt = flat.findIndex((t) => t.includes("我查一下第1个。"));
      const resultAt = flat.findIndex((t) => t.includes(H2_WEB_NOTE));
      const answerAt = flat.findIndex((t) => t.includes("第1个回答。"));
      expect([protocol, ackAt > resultAt, answerAt - ackAt, flat.some((t) => t.includes("我查一下第1个。") && t.includes(SEARCH_WEB))]).toEqual([protocol, true, protocol === "openai_responses" ? 1 : 0, false]);
      expect([protocol, (await send({ ...at, tools: [] })).raw]).toEqual([protocol, (await send({ ...at, tools: [], messages: today })).raw]);
    }
  });
});

describe("D: the most recent replies' web results as a stored excerpt", () => {
  it(`the ${REAL_REPLIES} most recent show their excerpt under the material sentence, an older one H3's placeholder; per protocol inside a tool result`, async () => {
    const { answers, later } = await searched("rfd", "D", REAL_REPLIES + 1);
    expect(answers).toHaveLength(3);
    // Stored: the excerpt, page for page, beside the call.
    expect(answers[2]!.body.toolCalls[0].excerpts).toEqual([1, 2, 3].map((i) => ({ title: expect.stringContaining(`的标题${i}`), snippet: expect.stringContaining(`的摘要${i}`) })));
    const results = later.messages.flatMap((m) => m.parts.flatMap((p) => (p.type === "tool-result" ? [p.output as Record<string, unknown>] : [])));
    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({ results_returned_then: 3, text_kept_here: false, note: H2_WEB_NOTE });
    for (const [k, r] of [results[1]!, results[2]!].entries()) {
      const turn = k + 2;
      expect(r).toEqual({
        about: TOOL_MATERIAL,
        results_returned_then: 3,
        excerpts: [1, 2, 3].map((i) => ({ site: `site${turn}${i}.example.com`, title: `第${turn}次的标题${i}`, snippet: `第${turn}次的摘要${i} 原文片段` })),
        note: D_NOTE,
        date: dayOf(answers[k + 1]!.created_at),
      });
    }
    // The ack after the results, as H3.
    expect(shape(later)[3]).toEqual(["assistant", ["我查一下第1个。", "第1个回答。"]]);
    const ids = later.messages.flatMap((m) => m.parts.flatMap((p) => (p.type === "tool-call" ? [p.id] : [])));
    expect(ids).toEqual(answers.map((a) => replayId(a.id, 0)));
    // On every protocol the excerpt travels inside the tool result, under the material sentence.
    const gateway = createModelGateway({ calls: createSlots(8), allowInsecureLocal: true });
    const { signal: _signal, ...recorded } = later;
    for (const protocol of PROTOCOLS) {
      stub.reset();
      for await (const _ of gateway.stream({ ...recorded, protocol, baseUrl: stub.baseUrl, apiKey: "sk-stub", model: STUB_MODEL, signal: AbortSignal.timeout(10_000) })) void _;
      const body = stub.requests[0]!.body;
      const turns: any[] = body.messages ?? body.input ?? body.contents;
      const holding = turns.map((t) => JSON.stringify(t)).filter((t) => t.includes("的摘要1"));
      const asResult = (t: string) => ['"role":"tool"', '"function_call_output"', '"tool_result"', '"functionResponse"'].some((k) => t.includes(k));
      expect([protocol, holding.length, holding.every(asResult)]).toEqual([protocol, 2, true]);
    }
  });

  it("the excerpt has the trace's one reader: never stored in a group, nor under another form; never on the wire, in search, or in a log line", async () => {
    logLines.length = 0;
    const { owner, agent, own } = await searched("rfe", "D", 1);
    const reads = [`/api/conversations/${own}/messages`, "/api/sync"];
    for (const url of reads) {
      const read = await api(app, owner, "GET", url);
      const text = JSON.stringify(read.json);
      expect([url, text.includes("的摘要"), CONTEXT_ONLY_KEYS.some((k) => text.includes(`"${k}"`))]).toEqual([url, false, false]);
    }
    for (const url of [`/api/conversations/${own}/search?q=${encodeURIComponent("原文片段")}`, `/api/search?q=${encodeURIComponent("原文片段")}`]) {
      const found = await api(app, owner, "GET", url);
      expect([url, found.status, found.json.messages.length]).toEqual([url, 200, 0]);
    }
    expect(logLines.join("\n")).not.toContain("原文片段");
    // In a group, under D: nothing stored.
    const gateway = scriptedGateway();
    const worker = webWorker(gateway, config("D"));
    const mia = await signUp(app, "rfe_mia");
    const g = await group(app, owner, "资讯", [mia, await signUp(app, "rfe_ned")]);
    expect((await api(app, owner, "POST", `/api/conversations/${g}/members`, { principalId: agent.id })).status).toBe(201);
    await say(mia, g, "@rfe_bot 天气？");
    gateway.callTools([{ name: SEARCH_WEB, input: { query: "天气 群里" } }]).reply("晴〔w1〕。");
    expect(await worker.runOnce()).toBe(true);
    expect((await replies(g, agent.id)).map((r) => Object.hasOwn(r.body, "toolCalls"))).toEqual([false]);
  });
});
