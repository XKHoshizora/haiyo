import { afterEach, describe, expect, it } from "vitest";
import { createAgentPort } from "../src/agents/port-impl.ts";
import { REPLY_LANGUAGE, REPLY_LANGUAGE_FOR, NO_TOOLS } from "../src/agents/runtime/prompt.ts";
import { createAgentWorker, type AgentWorker } from "../src/agents/runtime/worker.ts";
import { createToolbox, SEARCH_WEB } from "../src/agents/tools/index.ts";
import type { WebEngine, WebResult } from "../src/agents/tools/web/engine.ts";
import type { Config } from "../src/config.ts";
import { api, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { grant, METER_ENV } from "./helpers/metering.ts";
import { scriptedGateway, type ScriptedGateway } from "./helpers/models.ts";
import { closeAllSockets } from "./helpers/ws.ts";

/**
 * Through the port (lane lang): which message a run answers decides the language its system text names, and what the model
 * is sent says it — the request the gateway receives, never the model's behaviour (measured live and on two models, see
 * reply-language.test.ts).
 */

const { app, db } = useApp({ env: METER_ENV, agentWorker: false });

afterEach(async () => {
  await closeAllSockets();
});

const PAID = { source: "site", id: "meter_paid" } as const;
const RESULTS: WebResult[] = [1, 2].map((i) => ({ url: `https://news${i}.example.com/a/${i}`, title: `新闻标题${i}`, snippet: `摘要内容${i}`, age: "2026-11-20T08:00:00Z" }));
const engine: WebEngine = { name: "fake", searchWeb: async () => ({ results: RESULTS }) };

const config = (tools: Partial<Config["tools"]> = {}): Config => ({
  ...app.deps.config,
  tools: { ...app.deps.config.tools, ...tools, web: { ...app.deps.config.tools.web, enabled: true, pointsMicroPerSearch: 770_350, costMicroUsdPerSearch: 2000 } },
});

function workerOf(gateway: ScriptedGateway, cfg: Config = config()): AgentWorker {
  const { db: pool, blobs, conversations, reads, searches } = app.deps;
  const toolbox = createToolbox({ db: pool, blobs, searches, config: cfg, log: app.log, webEngine: engine });
  const port = createAgentPort({ db: pool, config: cfg, blobs, realtime: app.realtime, conversations, reads, log: app.log, toolbox });
  return createAgentWorker({ port, models: gateway, runTimeoutMs: cfg.agentRunTimeoutMs, maxRunsInFlight: 1, background: false, log: app.log, tools: cfg.tools });
}

let txn = 0;
const say = async (who: Actor, conv: string, text: string): Promise<number> => {
  const sent = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `rl${++txn}` });
  if (sent.status !== 201) throw new Error(`say: ${sent.status} ${JSON.stringify(sent.json)}`);
  return sent.json.message.seq as number;
};

async function owned(name: string) {
  const owner = await signUp(app, name);
  const agent = await mustCreateAgent(app, owner, { handle: `${name}_bot`, name: "小助手", model: PAID, persona: "简短地回答。" });
  await grant(db, owner.id, 20_000_000n);
  return { owner, agent, own: agent.conversationId as string };
}

/** Which of the language lines a system text holds: [abstract, zh, ja, en]. */
const held = (system: string) => [system.includes(REPLY_LANGUAGE), ...(["zh", "ja", "en"] as const).map((l) => system.includes(REPLY_LANGUAGE_FOR[l]))];
const ABSTRACT = [true, false, false, false];
const NONE = [false, false, false, false];
const ZH = [false, true, false, false];
const JA = [false, false, true, false];
const EN = [false, false, false, true];

describe("the Agent's own conversation: the line follows the owner's message that triggered the run", () => {
  for (const [lang, text, want] of [
    ["ja", "今日の大阪の天気は？", JA],
    ["en", "What is the weather in London today?", EN],
    ["zh", "北京今天天气怎么样？", ZH],
  ] as const) {
    it(`${lang}: ${text}`, async () => {
      const gateway = scriptedGateway();
      const { owner, own } = await owned(`rl_own_${lang}`);
      await say(owner, own, text);
      gateway.reply("好。");
      expect(await workerOf(gateway).runOnce()).toBe(true);
      const call = gateway.calls.at(-1)!;
      expect((call.tools ?? []).length).toBeGreaterThan(0);
      expect(held(call.system)).toEqual(want);
    });
  }

  it("a message that says nothing of a language (an emoji) keeps today's abstract line, byte for byte", async () => {
    const gateway = scriptedGateway();
    const { owner, own } = await owned("rl_own_null");
    await say(owner, own, "👍");
    gateway.reply("好。");
    expect(await workerOf(gateway).runOnce()).toBe(true);
    const call = gateway.calls.at(-1)!;
    expect(held(call.system)).toEqual(ABSTRACT);
    expect(call.system).toContain(`\n${REPLY_LANGUAGE}\n`);
  });

  it("a Chinese history and a Japanese triggering message: the line says Japanese (the message, never the history)", async () => {
    const gateway = scriptedGateway();
    const { owner, own } = await owned("rl_hist");
    await say(owner, own, "北京今天天气怎么样？");
    gateway.reply("晴。");
    expect(await workerOf(gateway).runOnce()).toBe(true);
    expect(held(gateway.calls.at(-1)!.system)).toEqual(ZH);
    await say(owner, own, "続けて");
    gateway.reply("はい。");
    expect(await workerOf(gateway).runOnce()).toBe(true);
    expect(held(gateway.calls.at(-1)!.system)).toEqual(JA);
    // And an English message after Japanese and Chinese ones.
    await say(owner, own, "Please go on");
    gateway.reply("Sure.");
    expect(await workerOf(gateway).runOnce()).toBe(true);
    expect(held(gateway.calls.at(-1)!.system)).toEqual(EN);
  });

  it("every round of one run says what the first said; the text for a call without tools says no language at all, as it does today", async () => {
    const gateway = scriptedGateway();
    const { owner, own } = await owned("rl_rounds");
    await say(owner, own, "今日の大阪の天気は？");
    gateway.callTools([{ name: SEARCH_WEB, input: { query: "大阪 天気" } }], { text: "調べます。" }).reply("晴れです。");
    expect(await workerOf(gateway).runOnce()).toBe(true);
    const [first, second] = gateway.calls.slice(-2) as unknown as [{ system: string; systemWithoutTools?: string }, { system: string }];
    expect(held(first.system)).toEqual(JA);
    expect(second.system).toBe(first.system);
    // `systemWithoutTools` (what a call whose tools the upstream refuses falls back to) is the text of a reply offered none,
    // as it is today: neither the abstract nor the concrete line.
    expect(first.systemWithoutTools).toBeDefined();
    expect(held(first.systemWithoutTools!)).toEqual(NONE);
    expect(first.systemWithoutTools).toContain(NO_TOOLS);
  });

  it("a reply offered no tools (tools off): no language line, whatever the message", async () => {
    const gateway = scriptedGateway();
    const { owner, own } = await owned("rl_off");
    await say(owner, own, "今日の大阪の天気は？");
    gateway.reply("晴れです。");
    expect(await workerOf(gateway, config({ enabled: false })).runOnce()).toBe(true);
    expect(held(gateway.calls.at(-1)!.system)).toEqual(NONE);
  });
});

describe("a group: the line follows the mention that called the Agent", () => {
  async function inGroup(name: string) {
    const { owner, agent } = await owned(name);
    const mia = await signUp(app, `${name}_mia`);
    const g = await group(app, owner, "资讯", [mia, await signUp(app, `${name}_ned`)]);
    expect((await api(app, owner, "POST", `/api/conversations/${g}/members`, { principalId: agent.id })).status).toBe(201);
    return { owner, mia, g, handle: `${name}_bot` };
  }

  for (const [lang, text, want] of [
    ["en", "What is the weather in London today?", EN],
    ["ja", "今日の大阪の天気は？", JA],
    ["zh", "北京今天天气怎么样？", ZH],
  ] as const) {
    it(`${lang}, after earlier talk in another language`, async () => {
      const gateway = scriptedGateway();
      const { mia, g, handle } = await inGroup(`rl_g_${lang}`);
      await say(mia, g, lang === "zh" ? "Hello everyone, what shall we talk about today?" : "大家好，今天聊点什么？");
      await say(mia, g, `@${handle} ${text}`);
      gateway.reply("好。");
      expect(await workerOf(gateway).runOnce()).toBe(true);
      expect(held(gateway.calls.at(-1)!.system)).toEqual(want);
    });
  }

  it("a mention with nothing of a language in it keeps today's abstract line", async () => {
    const gateway = scriptedGateway();
    const { mia, g, handle } = await inGroup("rl_g_null");
    await say(mia, g, `@${handle} 👍`);
    gateway.reply("好。");
    expect(await workerOf(gateway).runOnce()).toBe(true);
    expect(held(gateway.calls.at(-1)!.system)).toEqual(ABSTRACT);
  });

  it("only the language code crosses: none of the message's own words is in the system text", async () => {
    const gateway = scriptedGateway();
    const { mia, g, handle } = await inGroup("rl_g_code");
    await say(mia, g, `@${handle} 大阪タワーの高さは？`);
    gateway.reply("好。");
    expect(await workerOf(gateway).runOnce()).toBe(true);
    const system = gateway.calls.at(-1)!.system;
    expect(system).not.toContain("大阪タワー");
    expect(held(system)).toEqual(JA);
  });
});
