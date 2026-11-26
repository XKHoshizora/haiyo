import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentPort } from "../src/agents/port-impl.ts";
import { createAgentWorker, type AgentWorker } from "../src/agents/runtime/worker.ts";
import { createToolbox, SEARCH_WEB } from "../src/agents/tools/index.ts";
import type { WebEngine, WebResult } from "../src/agents/tools/web/engine.ts";
import { WEB_QUERY_PRIVATE } from "../src/agents/tools/web/tool.ts";
import type { Config } from "../src/config.ts";
import type { ModelCall } from "../src/models/gateway.ts";
import { api, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { grant } from "./helpers/metering.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { FREE_MODEL, OTHERS_ENV, POINT, setOwnerLimit } from "./helpers/others.ts";
import { SOCIAL_ON, seedSocial } from "./helpers/social.ts";
import { closeAllSockets } from "./helpers/ws.ts";

/**
 * Lane B, B-4 review m3: the web search in a SOCIAL run, on the real port, toolbox and worker with a fake engine (never a real call):
 * it is offered to a visitor's reply when the Agent has it; the owner pays for it inside the others' numbers (the run's lane is
 * `others`); its words are stored nowhere for a social reply and reach the visitor nowhere; the guard reads the names of the
 * participants (the visitor's and the owner's), so a query carrying a name is refused and the engine is not asked.
 */
const gateway = scriptedGateway();
const { app, db } = useApp({ env: OTHERS_ENV, models: gateway, agentWorker: false, tools: true, config: SOCIAL_ON });
afterEach(async () => {
  vi.restoreAllMocks();
  await closeAllSockets();
  expect(gateway.pending()).toBe(0);
});

const RESULTS: WebResult[] = [1, 2].map((i) => ({ url: `https://news${i}.example.com/a/${i}`, title: `新闻标题${i}`, snippet: `摘要内容${i}`, age: "2026-11-20T08:00:00Z" }));
function fakeEngine() {
  const queries: string[] = [];
  const engine: WebEngine & { queries: string[] } = {
    name: "fake",
    queries,
    async searchWeb(query) {
      queries.push(query);
      return { results: RESULTS };
    },
  };
  return engine;
}
const webConfig = (): Config => ({ ...app.deps.config, tools: { ...app.deps.config.tools, web: { ...app.deps.config.tools.web, enabled: true, pointsMicroPerSearch: 770_350 } } });
function webWorker(engine: WebEngine): AgentWorker {
  const config = webConfig();
  const { db: pool, blobs, conversations, reads, searches } = app.deps;
  const toolbox = createToolbox({ db: pool, blobs, searches, config, log: app.log, webEngine: engine });
  const port = createAgentPort({ db: pool, config, blobs, realtime: app.realtime, conversations, reads, log: app.log, toolbox });
  return createAgentWorker({ port, models: gateway, runTimeoutMs: config.agentRunTimeoutMs, maxRunsInFlight: 1, background: false, log: app.log, tools: config.tools });
}
const outputs = (call: ModelCall): any[] => (call.steps ?? []).flatMap((s) => s.results.map((r) => r.output));

let txn = 0;
const say = async (who: Actor, conv: string, text: string): Promise<void> => {
  const sent = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `sw${++txn}` });
  if (sent.status !== 201) throw new Error(`say: ${sent.status} ${JSON.stringify(sent.json)}`);
};
async function world(tag: string, webSearch = true) {
  const [owner, v] = [await signUp(app, `sw_o_${tag}`), await signUp(app, `sw_v_${tag}`)];
  const agent = (await mustCreateAgent(app, owner, { handle: `sw_bot_${tag}`, name: "sw", model: FREE_MODEL, persona: "简短地回答。", webSearch })) as { id: string; conversationId: string };
  await grant(db, owner.id, 20n * POINT);
  await setOwnerLimit(db, owner.id, 70n * POINT);
  const seeded = await seedSocial(app, { owner, agentId: agent.id, visitor: v });
  return { owner, v, agent, conv: seeded.conversationId };
}
const lastRun = async (w: { agent: { id: string }; conv: string }) =>
  (
    await db.query<{ id: string; status: string; lane: string; web_searches: number; web_micro: string }>(
      "select id, status, lane, web_searches, web_micro::text as web_micro from agent_runs where agent_id = $1 and conversation_id = $2 and purpose = 'reply' order by created_at desc limit 1",
      [w.agent.id, w.conv],
    )
  ).rows[0]!;

describe("the web search in a social run", () => {
  it("is offered to the visitor's reply, runs once, is paid by the owner as an others' reply, and its words are kept nowhere", async () => {
    const engine = fakeEngine();
    const worker = webWorker(engine);
    const w = await world("on");
    await say(w.v, w.conv, "明天北京天气怎么样");
    const query = "北京 明天 天气预报 WEBWORDS";
    gateway.callTools([{ name: SEARCH_WEB, input: { query } }]).reply("明天晴。");
    expect(await worker.runOnce()).toBe(true);
    const first = gateway.calls.at(-2)!;
    expect((first.tools ?? []).map((t) => t.name)).toContain(SEARCH_WEB);
    expect(engine.queries).toEqual([query]);
    expect(outputs(gateway.calls.at(-1)!)[0]).toMatchObject({ results: expect.any(Array) });
    const run = await lastRun(w);
    expect(run).toMatchObject({ status: "done", lane: "others", web_searches: 1, web_micro: "770350" });
    // The search words are in no message of the conversation, and not in what the visitor reads of it.
    const stored = await db.query<{ body: unknown }>("select body from messages where conversation_id = $1", [w.conv]);
    expect(JSON.stringify(stored.rows)).not.toContain("WEBWORDS");
    const read = await api(app, w.v, "GET", `/api/conversations/${w.conv}/messages`);
    expect(JSON.stringify(read.json)).not.toContain("WEBWORDS");
    // The owner is charged, inside the others' numbers.
    const record = (await db.query<{ owner_id: string; web_micro: string }>("select owner_id, web_micro::text as web_micro from usage_records where run_id = $1", [run.id])).rows[0]!;
    expect(record).toMatchObject({ owner_id: w.owner.id, web_micro: "770350" });
  });

  it("an Agent with the web search off is offered none", async () => {
    const engine = fakeEngine();
    const worker = webWorker(engine);
    const w = await world("off", false);
    await say(w.v, w.conv, "明天北京天气怎么样");
    gateway.reply("不知道。");
    expect(await worker.runOnce()).toBe(true);
    expect((gateway.calls.at(-1)!.tools ?? []).map((t) => t.name)).not.toContain(SEARCH_WEB);
    expect(engine.queries).toEqual([]);
  });

  it("the guard reads the names of the visitor and of the owner: a query carrying either is refused and the engine is never asked", async () => {
    for (const who of ["visitor", "owner"] as const) {
      const engine = fakeEngine();
      const worker = webWorker(engine);
      const w = await world(`guard_${who}`);
      await say(w.v, w.conv, "帮我查一下");
      const named = (await db.query<{ n: string }>("select display_name as n from principals where id = $1", [who === "owner" ? w.owner.id : w.v.id])).rows[0]!.n;
      gateway.callTools([{ name: SEARCH_WEB, input: { query: `${named} 住址` } }]).reply("查不到。");
      expect(await worker.runOnce()).toBe(true);
      expect(outputs(gateway.calls.at(-1)!), who).toEqual([{ error: WEB_QUERY_PRIVATE }]);
      expect(engine.queries, who).toEqual([]);
      expect(await lastRun(w), who).toMatchObject({ status: "done", web_searches: 0 });
    }
  });
});
