import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createAgentPort } from "../src/agents/port-impl.ts";
import { EXCERPT_NOTE, REAL_REPLIES, replayId, WEB_NOTE } from "../src/agents/replay.ts";
import { createAgentWorker, type AgentWorker } from "../src/agents/runtime/worker.ts";
import { TOOL_MATERIAL } from "../src/agents/runtime/prompt.ts";
import { siteDateTime } from "../src/agents/tools/clock.ts";
import { createToolbox, SEARCH_WEB } from "../src/agents/tools/index.ts";
import type { WebEngine, WebResult } from "../src/agents/tools/web/engine.ts";
import { PROTOCOLS, type Config } from "../src/config.ts";
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
 * The most recent replies' web results end to end (docs/design/2026-11-24-agent-harness-design.md §3, What was built): of
 * the replies in the Agent's own conversation that kept a web excerpt, the `REAL_REPLIES` newest show it to a later reply
 * — inside the tool result, on every protocol — and the older ones the placeholder; a reply posted before excerpts were
 * kept has none, and shows the placeholder however recent it is. And the excerpt has the trace's one reader.
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
/** The app's configuration with the web search on (read inside a test: the app exists only there). */
const webConfig = (): Config => ({
  ...app.deps.config,
  tools: { ...app.deps.config.tools, web: { ...app.deps.config.tools.web, enabled: true, pointsMicroPerSearch: 770_350, costMicroUsdPerSearch: 2000 } },
});
function webWorker(gateway: ScriptedGateway): AgentWorker {
  const config = webConfig();
  const { db: pool, blobs, conversations, reads, searches: slots } = app.deps;
  const toolbox = createToolbox({ db: pool, blobs, searches: slots, config, log: app.log, webEngine: fakeEngine() });
  const port = createAgentPort({ db: pool, config, blobs, realtime: app.realtime, conversations, reads, log: app.log, toolbox });
  return createAgentWorker({ port, models: gateway, runTimeoutMs: config.agentRunTimeoutMs, maxRunsInFlight: 1, background: false, log: app.log, tools: config.tools });
}

let txn = 0;
const say = async (who: Actor, conv: string, text: string) => {
  const sent = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `rr${++txn}` });
  if (sent.status !== 201) throw new Error(`say: ${sent.status}`);
};
async function owned(name: string) {
  const owner = await signUp(app, name);
  const agent = await mustCreateAgent(app, owner, { handle: `${name}_bot`, name: "小助手", model: PAID, persona: "简短地回答。" });
  await grant(db, owner.id, 20_000_000n);
  return { owner, agent, own: agent.conversationId as string };
}
const replies = async (conv: string, agentId: string) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (await db.query<{ id: string; body: Record<string, any>; created_at: Date }>("select id::text, body, created_at from messages where conversation_id = $1 and sender_id = $2 order by seq", [conv, agentId])).rows;
const dayOf = (at: Date) => siteDateTime(at, app.deps.config.siteTimezone).date;
const shape = (call: Pick<ModelCall, "messages">) =>
  call.messages.map((m) => [m.role, m.parts.map((p) => (p.type === "text" ? p.text : p.type === "tool-call" ? `call ${p.name}` : p.type === "tool-result" ? p.output : p.type))]);
const resultsOf = (call: Pick<ModelCall, "messages">) => call.messages.flatMap((m) => m.parts.flatMap((p) => (p.type === "tool-result" ? [p.output as Record<string, unknown>] : [])));
/** What reply `turn` of `searched` shows as one of the recent ones. */
const real = (turn: number, at: Date) => ({
  about: TOOL_MATERIAL,
  results_returned_then: 3,
  excerpts: [1, 2, 3].map((i) => ({ site: `site${turn}${i}.example.com`, title: `第${turn}次的标题${i}`, snippet: `第${turn}次的摘要${i} 原文片段` })),
  note: EXCERPT_NOTE,
  date: dayOf(at),
});
/** What reply `turn` of `searched` shows as an older one (or one without an excerpt). */
const placeholder = (turn: number, at: Date) => ({ results_returned_then: 3, text_kept_here: false, note: WEB_NOTE, sites: [1, 2, 3].map((i) => `site${turn}${i}.example.com`), date: dayOf(at) });

/** `n` searched replies (each acknowledged, each one web search answered), then — after `meanwhile` — one more question. */
async function searched(name: string, n: number, meanwhile: (answers: Awaited<ReturnType<typeof replies>>) => Promise<void> = async () => {}) {
  const gateway = scriptedGateway();
  const worker = webWorker(gateway);
  const { owner, agent, own } = await owned(name);
  searches = 0;
  for (let i = 1; i <= n; i++) {
    await say(owner, own, `第${i}个问题`);
    gateway.callTools([{ name: SEARCH_WEB, input: { query: `天气 第${i}次` } }], { text: `我查一下第${i}个。` }).reply(`第${i}个回答〔w1〕。`);
    expect(await worker.runOnce()).toBe(true);
    searches++;
  }
  const answers = () => replies(own, agent.id).then((rows) => rows.filter((r) => /个回答/.test(r.body.text ?? "")));
  await meanwhile(await answers());
  await say(owner, own, "最后的问题");
  gateway.reply("好。");
  expect(await worker.runOnce()).toBe(true);
  return { owner, agent, own, answers: await answers(), later: gateway.calls.at(-1)! };
}

describe("the recent replies show what their searches found; the older ones the placeholder", () => {
  it(`the ${REAL_REPLIES} newest show the excerpt they kept, an older one the placeholder; on every protocol inside a tool result`, async () => {
    const { answers, later } = await searched("rra", REAL_REPLIES + 1);
    expect(answers).toHaveLength(3);
    // Stored at post time, page for page, beside the call — by every reply.
    for (const [k, a] of answers.entries()) expect(a.body.toolCalls[0].excerpts).toEqual([1, 2, 3].map((i) => ({ title: `第${k + 1}次的标题${i}`, snippet: `第${k + 1}次的摘要${i} 原文片段` })));
    expect(resultsOf(later)).toEqual([placeholder(1, answers[0]!.created_at), real(2, answers[1]!.created_at), real(3, answers[2]!.created_at)]);
    // Every acknowledgement after its results, heading its answer.
    expect(shape(later).filter(([role]) => role === "assistant")).toEqual([1, 2, 3].flatMap((k) => [["assistant", [`call ${SEARCH_WEB}`]], ["assistant", [`我查一下第${k}个。`, `第${k}个回答。`]]]));
    expect(later.messages.flatMap((m) => m.parts.flatMap((p) => (p.type === "tool-call" ? [p.id] : [])))).toEqual(answers.map((a) => replayId(a.id, 0)));
    const gateway = createModelGateway({ calls: createSlots(8), allowInsecureLocal: true });
    const { signal: _signal, ...recorded } = later;
    for (const protocol of PROTOCOLS) {
      stub.reset();
      for await (const _ of gateway.stream({ ...recorded, protocol, baseUrl: stub.baseUrl, apiKey: "sk-stub", model: STUB_MODEL, signal: AbortSignal.timeout(10_000) })) void _;
      const body = stub.requests[0]!.body;
      const turns: unknown[] = body.messages ?? body.input ?? body.contents;
      const holding = turns.map((t) => JSON.stringify(t)).filter((t) => t.includes("的摘要1"));
      const asResult = (t: string) => ['"role":"tool"', '"function_call_output"', '"tool_result"', '"functionResponse"'].some((k) => t.includes(k));
      expect([protocol, holding.length, holding.every(asResult), JSON.stringify(body).includes("第1次的摘要")]).toEqual([protocol, 2, true, false]);
    }
  });

  it("a reply posted before excerpts were kept (none in its body) shows the placeholder however recent it is, and takes neither place", async () => {
    const { answers, later } = await searched("rrb", 3, async (rows) => {
      // The newest as a reply stored before this change has it: its calls without an excerpt.
      const newest = rows.at(-1)!;
      const calls = (newest.body.toolCalls as Array<Record<string, unknown>>).map(({ excerpts: _excerpts, ...c }) => c);
      await db.query("update messages set body = jsonb_set(body, '{toolCalls}', $2::jsonb) where id = $1", [newest.id, JSON.stringify(calls)]);
    });
    expect(answers[2]!.body.toolCalls[0]).not.toHaveProperty("excerpts");
    expect(resultsOf(later)).toEqual([real(1, answers[0]!.created_at), real(2, answers[1]!.created_at), placeholder(3, answers[2]!.created_at)]);
  });
});

describe("the excerpt has the trace's one reader", () => {
  it("never on the wire or in sync, in either search, in a log line; never stored in a group", async () => {
    // The snippets are the excerpt alone (a page's title is the reply's source as well, `webSources`, shown with it as before).
    logLines.length = 0;
    const { owner, agent, own } = await searched("rrc", 1);
    for (const url of [`/api/conversations/${own}/messages`, "/api/sync"]) {
      const read = await api(app, owner, "GET", url);
      const text = JSON.stringify(read.json);
      expect([url, read.status, text.includes("的摘要"), text.includes("原文片段"), CONTEXT_ONLY_KEYS.some((k) => text.includes(`"${k}"`))]).toEqual([url, 200, false, false, false]);
    }
    for (const q of ["原文片段", "的摘要"])
      for (const url of [`/api/conversations/${own}/search?q=${encodeURIComponent(q)}`, `/api/search?q=${encodeURIComponent(q)}`]) {
        const found = await api(app, owner, "GET", url);
        expect([url, found.status, found.json.messages.length]).toEqual([url, 200, 0]);
      }
    for (const s of ["原文片段", "的摘要1", EXCERPT_NOTE]) expect([s, logLines.join("\n").includes(s)]).toEqual([s, false]);
    // In a group: nothing stored, so nothing returns.
    const gateway = scriptedGateway();
    const worker = webWorker(gateway);
    const mia = await signUp(app, "rrc_mia");
    const g = await group(app, owner, "资讯", [mia, await signUp(app, "rrc_ned")]);
    expect((await api(app, owner, "POST", `/api/conversations/${g}/members`, { principalId: agent.id })).status).toBe(201);
    await say(mia, g, "@rrc_bot 天气？");
    gateway.callTools([{ name: SEARCH_WEB, input: { query: "天气 群里" } }]).reply("晴〔w1〕。");
    expect(await worker.runOnce()).toBe(true);
    expect((await replies(g, agent.id)).map((r) => Object.hasOwn(r.body, "toolCalls"))).toEqual([false]);
  });
});
