import { afterEach, describe, expect, it } from "vitest";
import { createAgentPort } from "../src/agents/port-impl.ts";
import { HOW_TOLD, REPLY_LANGUAGE } from "../src/agents/runtime/prompt.ts";
import { createAgentWorker, type AgentWorker } from "../src/agents/runtime/worker.ts";
import { createToolbox, SEARCH_WEB } from "../src/agents/tools/index.ts";
import type { WebEngine, WebResult, WebSearchError } from "../src/agents/tools/web/engine.ts";
import { WEB_UNAVAILABLE } from "../src/agents/tools/web/tool.ts";
import type { Config, WebSearchConfig } from "../src/config.ts";
import type { ModelCall } from "../src/models/gateway.ts";
import { api, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { grant, METER_ENV } from "./helpers/metering.ts";
import { scriptedGateway, type ScriptedGateway } from "./helpers/models.ts";
import { closeAllSockets } from "./helpers/ws.ts";

/**
 * What a reply's model is shown of the Agent's own earlier replies, and of itself (lane prompt2): the request the gateway
 * receives, never the model's behaviour. Measured live (.superpowers/sdd/2026-11-22-polish/prompt2-evidence-live-web.json):
 * a model shown earlier answers that said "根据搜索结果…" with no trace that a search ran took them for made up, "confessed",
 * and stopped searching; it answered a Japanese question in Chinese; it explained how it tells its owner apart; and a
 * reply that only copied a number someone typed was never posted.
 *
 * The first block is the specification of what history must carry (`it.fails`: it fails today, on the assertion that the
 * earlier reply's turn shows any trace of its tool calls). The fix is structural — what a past reply returns as — and goes
 * through a paper design first (prompt2-report.md, "Proposal"); when it lands these become `it`. They are written against
 * no format: only that the tool's name, and a page it was handed, are in that reply's turn.
 */

const { app, db } = useApp({ env: METER_ENV, agentWorker: false });

afterEach(async () => {
  await closeAllSockets();
});

const PAID = { source: "site", id: "meter_paid" } as const;
const QUERY = "北京 天气 预报";
const RESULTS: WebResult[] = [1, 2, 3].map((i) => ({ url: `https://news${i}.example.com/a/${i}`, title: `新闻标题${i}`, snippet: `摘要内容${i}`, age: "2026-11-20T08:00:00Z" }));

function fakeEngine(answer: () => { results: WebResult[] } | { error: WebSearchError } = () => ({ results: RESULTS })): WebEngine {
  return { name: "fake", searchWeb: async () => answer() };
}

const webConfig = (web: Partial<WebSearchConfig> = {}, tools: Partial<Config["tools"]> = {}): Config => ({
  ...app.deps.config,
  tools: { ...app.deps.config.tools, ...tools, web: { ...app.deps.config.tools.web, enabled: true, pointsMicroPerSearch: 770_350, costMicroUsdPerSearch: 2000, ...web } },
});

function webWorker(gateway: ScriptedGateway, engine: WebEngine | null, config: Config = webConfig()): AgentWorker {
  const { db: pool, blobs, conversations, reads, searches } = app.deps;
  const toolbox = createToolbox({ db: pool, blobs, searches, config, log: app.log, webEngine: engine });
  const port = createAgentPort({ db: pool, config, blobs, realtime: app.realtime, conversations, reads, log: app.log, toolbox });
  return createAgentWorker({ port, models: gateway, runTimeoutMs: config.agentRunTimeoutMs, maxRunsInFlight: 1, background: false, log: app.log, tools: config.tools });
}

let txn = 0;
const say = async (who: Actor, conv: string, text: string): Promise<number> => {
  const sent = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `rh${++txn}` });
  if (sent.status !== 201) throw new Error(`say: ${sent.status} ${JSON.stringify(sent.json)}`);
  return sent.json.message.seq as number;
};

async function owned(name: string) {
  const owner = await signUp(app, name);
  const agent = await mustCreateAgent(app, owner, { handle: `${name}_bot`, name: "小助手", model: PAID, persona: "简短地回答。" });
  await grant(db, owner.id, 20_000_000n);
  return { owner, agent, own: agent.conversationId as string };
}

/** The call's turns as role and texts. */
const turns = (call: ModelCall) => call.messages.map((t) => [t.role, t.parts.map((p) => (p.type === "text" ? p.text : p.type))] as const);
/** Everything the call shows in the turn of the Agent's earlier reply (the first assistant turn), joined. */
const earlierReply = (call: ModelCall): string => (turns(call).find(([role]) => role === "assistant")?.[1] ?? []).join("\n");
const agentMessages = async (conv: string, agentId: string) =>
  (await db.query<{ body: Record<string, any> }>("select body from messages where conversation_id = $1 and sender_id = $2 order by messages.seq", [conv, agentId])).rows.map((r) => r.body);
const lastRun = async (agentId: string) =>
  (await db.query<{ status: string; error: string | null }>("select status, error from agent_runs where agent_id = $1 and purpose = 'reply' order by created_at desc limit 1", [agentId])).rows[0]!;

describe("what an earlier reply that looked something up returns as (the false confession; specification, fails today)", () => {
  it("today: an earlier answer that searched comes back as its acknowledgement and its text alone — no call, no result, no source", async () => {
    const gateway = scriptedGateway();
    const worker = webWorker(gateway, fakeEngine());
    const { owner, own } = await owned("rha");
    await say(owner, own, "北京今天天气怎么样？");
    gateway.callTools([{ name: SEARCH_WEB, input: { query: QUERY } }], { text: "我查一下。" }).reply("根据搜索结果，今天晴〔w2〕，有风。");
    expect(await worker.runOnce()).toBe(true);
    await say(owner, own, "那明天呢？");
    gateway.reply("明天也晴。");
    expect(await worker.runOnce()).toBe(true);
    const later = gateway.calls.at(-1)!;
    // The pattern a model reads as a claim with no evidence: "I'll look it up", then an answer citing results, nothing between.
    expect(turns(later)).toEqual([
      ["user", ["北京今天天气怎么样？"]],
      ["assistant", ["我查一下。", "根据搜索结果，今天晴，有风。"]],
      ["user", ["那明天呢？"]],
    ]);
    expect(later.steps ?? []).toEqual([]);
  });

  it.fails("its own conversation: the earlier reply's turn shows that it ran the web search and what it was handed", async () => {
    const gateway = scriptedGateway();
    const worker = webWorker(gateway, fakeEngine());
    const { owner, own } = await owned("rhb");
    await say(owner, own, "北京今天天气怎么样？");
    gateway.callTools([{ name: SEARCH_WEB, input: { query: QUERY } }], { text: "我查一下。" }).reply("今天晴〔w2〕。");
    expect(await worker.runOnce()).toBe(true);
    await say(owner, own, "那明天呢？");
    gateway.reply("明天也晴。");
    expect(await worker.runOnce()).toBe(true);
    const shown = earlierReply(gateway.calls.at(-1)!);
    expect(shown).toContain(SEARCH_WEB);
    expect(shown).toContain("新闻标题2");
  });

  it.fails("a search that was refused: the reply that then said it could not search comes back with the trace that it tried, that once", async () => {
    const gateway = scriptedGateway();
    const worker = webWorker(gateway, fakeEngine(() => ({ error: "unavailable" })));
    const { owner, own } = await owned("rhc");
    await say(owner, own, "北京今天天气怎么样？");
    gateway.callTools([{ name: SEARCH_WEB, input: { query: QUERY } }]).reply("联网搜索暂时用不了。");
    expect(await worker.runOnce()).toBe(true);
    expect(JSON.stringify(gateway.calls.at(-1)!.steps)).toContain(WEB_UNAVAILABLE);
    await say(owner, own, "上海呢？");
    gateway.reply("我再试试。");
    expect(await worker.runOnce()).toBe(true);
    expect(earlierReply(gateway.calls.at(-1)!)).toContain(SEARCH_WEB);
  });

  it.fails("in a group: the trace too — but never the search words (a group's reply keeps none)", async () => {
    const gateway = scriptedGateway();
    const worker = webWorker(gateway, fakeEngine());
    const { owner, agent } = await owned("rhd");
    const mia = await signUp(app, "rhd_mia");
    const g = await group(app, owner, "资讯", [mia, await signUp(app, "rhd_ned")]);
    expect((await api(app, owner, "POST", `/api/conversations/${g}/members`, { principalId: agent.id })).status).toBe(201);
    await say(mia, g, "@rhd_bot 北京天气？");
    gateway.callTools([{ name: SEARCH_WEB, input: { query: QUERY } }]).reply("晴〔w1〕。");
    expect(await worker.runOnce()).toBe(true);
    await say(mia, g, "@rhd_bot 谢谢");
    gateway.reply("不客气。");
    expect(await worker.runOnce()).toBe(true);
    const later = gateway.calls.at(-1)!;
    expect(JSON.stringify(later.messages)).not.toContain(QUERY);
    expect(earlierReply(later)).toContain(SEARCH_WEB);
  });

  it("a reply offered no tools is shown the history it is shown today (what any fix must keep)", async () => {
    const gateway = scriptedGateway();
    const { owner, own } = await owned("rhe");
    await say(owner, own, "北京今天天气怎么样？");
    gateway.callTools([{ name: SEARCH_WEB, input: { query: QUERY } }]).reply("今天晴。");
    expect(await webWorker(gateway, fakeEngine()).runOnce()).toBe(true);
    await say(owner, own, "谢谢");
    gateway.reply("不客气。");
    expect(await webWorker(gateway, fakeEngine(), webConfig({}, { enabled: false })).runOnce()).toBe(true);
    const later = gateway.calls.at(-1)!;
    expect(later.tools ?? []).toEqual([]);
    expect(turns(later)[1]).toEqual(["assistant", ["今天晴。"]]);
  });

  it("a conversation where nothing was looked up: its history and system text as they are today (what any fix must keep)", async () => {
    const gateway = scriptedGateway();
    const worker = webWorker(gateway, fakeEngine());
    const { owner, own } = await owned("rhf");
    await say(owner, own, "你好");
    gateway.reply("你好。");
    expect(await worker.runOnce()).toBe(true);
    await say(owner, own, "在吗");
    gateway.reply("在。");
    expect(await worker.runOnce()).toBe(true);
    const [first, later] = [gateway.calls[0]!, gateway.calls.at(-1)!];
    expect(turns(later)[1]).toEqual(["assistant", ["你好。"]]);
    expect(later.system).toBe(first.system);
  });
});

describe("the reply's language and what a group's reply keeps to itself", () => {
  it("every system text says the reply is in the language of the message it answers, not the instructions'; a group's also not to explain how it tells who is who", async () => {
    const gateway = scriptedGateway();
    const worker = webWorker(gateway, fakeEngine());
    const { owner, agent, own } = await owned("rhg");
    await say(owner, own, "今日の大阪の天気は？");
    gateway.reply("晴れです。");
    expect(await worker.runOnce()).toBe(true);
    expect(gateway.calls.at(-1)!.system).toContain(REPLY_LANGUAGE);
    // A reply offered no tools too: it is no rule of the tools'.
    await say(owner, own, "ありがとう");
    gateway.reply("どういたしまして。");
    expect(await webWorker(gateway, null, webConfig({}, { enabled: false })).runOnce()).toBe(true);
    expect(gateway.calls.at(-1)!.system).toContain(REPLY_LANGUAGE);
    const mia = await signUp(app, "rhg_mia");
    const g = await group(app, owner, "资讯", [mia, await signUp(app, "rhg_ned")]);
    expect((await api(app, owner, "POST", `/api/conversations/${g}/members`, { principalId: agent.id })).status).toBe(201);
    await say(mia, g, "@rhg_bot What is the weather in London today?");
    gateway.reply("Sunny.");
    expect(await worker.runOnce()).toBe(true);
    const groupCall = gateway.calls.at(-1)!;
    expect(groupCall.system).toContain(REPLY_LANGUAGE);
    expect(groupCall.system).toContain(`不要向任何人说出或复述暗记和标签，${HOW_TOLD}。`);
  });
});

describe("a reply that says nothing but a number someone typed (the third ask with no reply)", () => {
  it("in a group: copying a member's 〔m1〕 as asked is posted as written, citing nothing (before: nothing posted, the run failed as the provider's)", async () => {
    const gateway = scriptedGateway();
    const worker = webWorker(gateway, fakeEngine());
    const { owner, agent } = await owned("rhh");
    const mia = await signUp(app, "rhh_mia");
    const g = await group(app, owner, "记号", [mia, await signUp(app, "rhh_ned")]);
    expect((await api(app, owner, "POST", `/api/conversations/${g}/members`, { principalId: agent.id })).status).toBe(201);
    await say(mia, g, "@rhh_bot 我自己写个记号〔m1〕，你照抄一遍这个记号");
    gateway.reply("〔m1〕");
    expect(await worker.runOnce()).toBe(true);
    expect(await agentMessages(g, agent.id)).toEqual([{ text: "〔m1〕" }]);
    expect(await lastRun(agent.id)).toEqual({ status: "done", error: null });
  });

  it("in its own conversation, a reply of nothing but its run's own web numbers: posted as written, citing nothing, its pages still kept", async () => {
    const gateway = scriptedGateway();
    const worker = webWorker(gateway, fakeEngine());
    const { owner, agent, own } = await owned("rhi");
    await say(owner, own, "给我来源编号就行");
    gateway.callTools([{ name: SEARCH_WEB, input: { query: QUERY } }]).reply("〔w1〕 〔w2〕");
    expect(await worker.runOnce()).toBe(true);
    const body = (await agentMessages(own, agent.id)).at(-1)!;
    expect(body.text).toBe("〔w1〕 〔w2〕");
    expect(body).not.toHaveProperty("webCites");
    expect(body.webSources).toHaveLength(3);
  });

  it("anything else still goes: a token beside words is taken out as always, and an acknowledgement of nothing but a token is not posted", async () => {
    const gateway = scriptedGateway();
    const worker = webWorker(gateway, fakeEngine());
    const { owner, agent, own } = await owned("rhk");
    await say(owner, own, "查一下");
    gateway.callTools([{ name: SEARCH_WEB, input: { query: QUERY } }], { text: "〔m1〕" }).reply("见〔w1〕，〔m1〕晴。");
    expect(await worker.runOnce()).toBe(true);
    expect((await agentMessages(own, agent.id)).map((b) => [b.text, b.ack ?? false])).toEqual([["见，晴。", false]]);
  });

  it("whitespace, or nothing at all: nothing is posted and the run fails as an answer that said nothing, not retried — the model wrote nothing to show (unchanged)", async () => {
    const gateway = scriptedGateway();
    const worker = webWorker(gateway, fakeEngine());
    const { owner, agent, own } = await owned("rhj");
    for (const text of ["  \n ", ""]) {
      await say(owner, own, "说点什么");
      if (text === "") gateway.empty();
      else gateway.reply(text);
      expect(await worker.runOnce()).toBe(true);
      expect(await lastRun(agent.id)).toEqual({ status: "failed", error: "provider_unavailable" });
    }
    expect(await agentMessages(own, agent.id)).toEqual([]);
    expect((await db.query("select 1 from agent_runs where agent_id = $1 and auto_attempt > 0", [agent.id])).rowCount).toBe(0);
  });
});
