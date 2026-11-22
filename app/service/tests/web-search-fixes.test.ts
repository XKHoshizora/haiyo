import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentPort, type DbAgentPort } from "../src/agents/port-impl.ts";
import { createAgentWorker, type AgentWorker } from "../src/agents/runtime/worker.ts";
import { createToolbox, SEARCH_WEB } from "../src/agents/tools/index.ts";
import type { WebEngine, WebResult, WebSearchError } from "../src/agents/tools/web/engine.ts";
import type { Config, WebSearchConfig } from "../src/config.ts";
import { api, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { grant, METER_ENV } from "./helpers/metering.ts";
import { scriptedGateway, type ScriptedGateway } from "./helpers/models.ts";
import { closeAllSockets } from "./helpers/ws.ts";

/**
 * Where two lanes meet (integration of lane websearch and lane fixes): the web search and the automatic retry / the greeting.
 * (1) A reply that already searched the web is never retried by the system — the completed tool round is progress — so a
 * search is never paid twice by a retry; (2) a greeting is offered no tools, `search_web` included, even for an Agent whose
 * web switch is on; the automatic retry of a reply that had made no search is still on (the control).
 */

const { app, db } = useApp({
  env: { ...METER_ENV, AGENTS: JSON.stringify({ autoRetryDelaysMs: [20_000, 120_000] }) },
  agentWorker: false,
  greeting: true,
});

afterEach(async () => {
  await closeAllSockets();
  vi.restoreAllMocks();
});

const PAID = { source: "site", id: "meter_paid" } as const;
const POINT = 1_000_000n;
const QUERY = "北京 天气 预报";
const RESULTS: WebResult[] = [1, 2, 3].map((i) => ({ url: `https://news${i}.example.com/a/${i}`, title: `新闻标题${i}`, snippet: `摘要内容${i}`, age: "2026-11-20T08:00:00Z" }));

function fakeEngine(answer: () => { results: WebResult[] } | { error: WebSearchError } = () => ({ results: RESULTS })): WebEngine & { queries: string[] } {
  const queries: string[] = [];
  return {
    name: "fake",
    queries,
    async searchWeb(query) {
      queries.push(query);
      return answer();
    },
  };
}

const webConfig = (web: Partial<WebSearchConfig> = {}): Config => ({ ...app.deps.config, tools: { ...app.deps.config.tools, web: { ...app.deps.config.tools.web, enabled: true, ...web } } });

function webWorker(gateway: ScriptedGateway, engine: WebEngine): { port: DbAgentPort; worker: AgentWorker } {
  const config = webConfig();
  const { db: pool, blobs, conversations, reads, searches } = app.deps;
  const toolbox = createToolbox({ db: pool, blobs, searches, config, log: app.log, webEngine: engine });
  const port = createAgentPort({ db: pool, config, blobs, realtime: app.realtime, conversations, reads, log: app.log, toolbox });
  const worker = createAgentWorker({ port, models: gateway, runTimeoutMs: config.agentRunTimeoutMs, maxRunsInFlight: 1, background: false, log: app.log, tools: config.tools });
  return { port, worker };
}

let txn = 0;
const say = async (who: Actor, conv: string, text: string): Promise<void> => {
  const sent = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `wf${++txn}` });
  if (sent.status !== 201) throw new Error(`say: ${sent.status} ${JSON.stringify(sent.json)}`);
};
const runsOf = async (conv: string) =>
  (
    await db.query<{ status: string; auto_attempt: number; web_searches: number; progressed: boolean; greets: boolean }>(
      "select status, auto_attempt, web_searches, progressed, greets from agent_runs where conversation_id = $1 order by created_at",
      [conv],
    )
  ).rows;

async function owned(name: string) {
  const owner = await signUp(app, name);
  const agent = await mustCreateAgent(app, owner, { handle: `${name}_bot`, name: "小助手", model: PAID, persona: "简短地回答。" });
  await grant(db, owner.id, 20n * POINT);
  return { owner, agent, own: agent.conversationId as string };
}

describe("web search x automatic retry", () => {
  it("a 503 after a web search: the failure is shown at once, nothing is queued, the engine was called once, the search is counted once", async () => {
    const gateway = scriptedGateway();
    const engine = fakeEngine();
    const { worker } = webWorker(gateway, engine);
    const { owner, own } = await owned("wfa");
    await say(owner, own, "北京今天天气怎么样？");
    gateway.callTools([{ name: SEARCH_WEB, input: { query: QUERY } }]).fail("provider_unavailable", { status: 503 });
    expect(await worker.runOnce()).toBe(true);
    expect(await runsOf(own)).toEqual([{ status: "failed", auto_attempt: 0, web_searches: 1, progressed: true, greets: false }]);
    expect(engine.queries).toEqual([QUERY]);
    expect(gateway.pending()).toBe(0);
  });

  it("control: the same 503 with no search before it IS retried (the retry is on in this file)", async () => {
    const gateway = scriptedGateway();
    const { worker } = webWorker(gateway, fakeEngine());
    const { owner, own } = await owned("wfb");
    await say(owner, own, "北京今天天气怎么样？");
    gateway.fail("provider_unavailable", { status: 503 });
    expect(await worker.runOnce()).toBe(true);
    const runs = await runsOf(own);
    expect(runs.map((r) => r.status)).toEqual(["failed", "queued"]);
    expect(runs[1]!.auto_attempt).toBe(1);
  });
});

describe("web search x greeting", () => {
  it("a greeting is offered no tools — not search_web either — for an Agent whose web switch is on; nothing is searched", async () => {
    const gateway = scriptedGateway();
    const engine = fakeEngine();
    const { worker } = webWorker(gateway, engine);
    const owner = await signUp(app, "wfc");
    const agent = await mustCreateAgent(app, owner, { handle: "wfc_bot", name: "小新", model: PAID, webSearch: true });
    await grant(db, owner.id, 20n * POINT);
    expect((await runsOf(agent.conversationId as string)).map((r) => r.greets)).toEqual([true]);
    gateway.reply("你好。");
    expect(await worker.runOnce()).toBe(true);
    expect(gateway.calls.at(-1)!.tools ?? []).toEqual([]);
    expect(gateway.calls.at(-1)!.system).not.toContain("search_web");
    expect(engine.queries).toEqual([]);
  });
});
