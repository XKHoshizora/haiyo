import { afterEach, describe, expect, it } from "vitest";
import { createAgentPort, type DbAgentPort } from "../src/agents/port-impl.ts";
import { createAgentWorker, type AgentWorker } from "../src/agents/runtime/worker.ts";
import { createToolbox, SEARCH_WEB } from "../src/agents/tools/index.ts";
import type { WebEngine, WebResult } from "../src/agents/tools/web/engine.ts";
import { WEB_LANE_BUDGET } from "../src/agents/tools/web/tool.ts";
import type { Config } from "../src/config.ts";
import type { ModelCall, ModelGateway } from "../src/models/gateway.ts";
import { outputLimit } from "../src/models/resolve.ts";
import { othersReplyCeilingMicro } from "../src/metering/others.ts";
import { api, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { grant, paidReply } from "./helpers/metering.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { providerBody } from "./helpers/providers.ts";
import { BIG_MODEL, FREE_MODEL, OTHERS_ENV, POINT } from "./helpers/others.ts";
import { SOCIAL_ON, seedSocial } from "./helpers/social.ts";
import { closeAllSockets, connect } from "./helpers/ws.ts";

/**
 * Fix round 1, I6 (review `integ1a-review.md`): web search by a VISITOR, through a social conversation, on the real port, toolbox,
 * worker and database with a fake engine. The one money path of a social run beside the reply itself: the search's price is held
 * before the engine is called, against the OWNER's shared numbers (the visitor pays nothing), the search runs once, the reply is
 * posted, and the points are the owner's "used by others", in the visitor's row. And the refusal: when the owner's numbers cannot
 * take the search, no search is made and the reply goes on without it.
 */
const lines: string[] = [];
const { app, db } = useApp({ env: { ...OTHERS_ENV, AGENT_RUNS_PER_MINUTE: "100" }, agentWorker: false, config: SOCIAL_ON, logStream: { write: (line) => void lines.push(line) }, providerProbe: { test: async () => {}, listModels: async () => ["pm", "pm2"] } });
afterEach(async () => {
  await closeAllSockets();
  lines.length = 0;
});
const metric = (name: string) => lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((e) => e.metric === name);

const PRICE = 770_000n;
const QUERY = "上海 天气";
const webConfig = (): Config => ({
  ...app.deps.config,
  tools: { ...app.deps.config.tools, web: { ...app.deps.config.tools.web, enabled: true, pointsMicroPerSearch: Number(PRICE) } },
});
/** A fake web engine: three results, every query recorded; `during` runs while the search is out. */
function fakeEngine(during: () => Promise<void> = async () => {}) {
  const queries: string[] = [];
  const results: WebResult[] = [1, 2, 3].map((i) => ({ url: `https://news${i}.example.com/a/${i}`, title: `新闻标题${i}`, snippet: `摘要内容${i}`, age: "2026-11-20T08:00:00Z" }));
  const engine: WebEngine & { queries: string[] } = {
    name: "fake",
    queries,
    async searchWeb(query) {
      queries.push(query);
      await during();
      return { results };
    },
  };
  return engine;
}

let n = 0;
/** An owner with points and an Agent, a visitor let in, and a port and worker of their own with the web search offered. */
async function world(engine: WebEngine, gateway: Pick<ModelGateway, "stream">, modelOf: (owner: Actor) => Promise<unknown> = async () => FREE_MODEL, over: Record<string, unknown> = {}) {
  const tag = `${++n}x${Math.floor(Math.random() * 1e6)}`;
  const [owner, visitor] = [await signUp(app, `wso${tag}`), await signUp(app, `wsv${tag}`)];
  await grant(db, owner.id, 10_000n * POINT);
  const agent = (await mustCreateAgent(app, owner, { handle: `wsy${tag}`, name: "wsy", model: await modelOf(owner), persona: "简短地回答。", ...over })) as { id: string; conversationId: string };
  const { conversationId: conv } = await seedSocial(app, { owner, agentId: agent.id, visitor });
  const config = webConfig();
  const { db: pool, blobs, searches, conversations, reads } = app.deps;
  const box = createToolbox({ db: pool, blobs, searches, config, log: app.log, webEngine: engine });
  const port: DbAgentPort = createAgentPort({ db: pool, config, blobs, realtime: app.realtime, conversations, reads, log: app.log, toolbox: box });
  const worker: AgentWorker = createAgentWorker({ port, models: gateway as ModelGateway, runTimeoutMs: config.agentRunTimeoutMs, maxRunsInFlight: 1, background: false, log: app.log, tools: config.tools });
  const say = async (who: Actor, text: string) => expect((await api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `ws${++n}` })).status).toBe(201);
  const run = async () =>
    (
      await db.query<{ id: string; status: string; error: string | null; lane: string; caller: string | null; hold: string; searches: number; web: string }>(
        "select id, status, error, lane, caller_id as caller, hold_micro::text as hold, web_searches as searches, web_micro::text as web from agent_runs where conversation_id = $1 order by created_at desc, id desc limit 1",
        [conv],
      )
    ).rows[0]!;
  const posted = async () =>
    (await db.query<{ text: string }>("select body ->> 'text' as text from messages where conversation_id = $1 and sender_id = $2 and kind = 'text' order by seq", [conv, agent.id])).rows.map((r) => r.text);
  return { owner, visitor, agent, conv, worker, say, run, posted };
}

describe("a visitor's reply searches the web on the owner's numbers", () => {
  it("the price is held before the engine is called; one search; the reply is posted; the points are the owner's, counted in others' use, in the visitor's row", async () => {
    const seen: { before: bigint; during: bigint } = { before: -1n, during: -1n };
    const holdOf = async (conv: string) => BigInt((await db.query<{ h: string }>("select hold_micro::text as h from agent_runs where conversation_id = $1 order by created_at desc limit 1", [conv])).rows[0]!.h);
    const ctx = { conv: "", owner: "" };
    const engine = fakeEngine(async () => {
      seen.during = await holdOf(ctx.conv);
    });
    const inner = scriptedGateway().callTools([{ name: SEARCH_WEB, input: { query: QUERY } }], { usage: { inputTokens: 900, outputTokens: 40 } }).reply("今天多云。", { usage: { inputTokens: 1200, outputTokens: 20 } });
    let first = true;
    const gateway = Object.create(inner) as ModelGateway & typeof inner;
    gateway.stream = ((call: ModelCall) => {
      const events = inner.stream(call);
      return (async function* () {
        if (first) {
          first = false;
          seen.before = await holdOf(ctx.conv);
        }
        yield* events;
      })();
    }) as ModelGateway["stream"];
    const w = await world(engine, gateway);
    Object.assign(ctx, { conv: w.conv, owner: w.owner.id });
    await w.say(w.visitor, "上海今天天气怎么样？");
    expect(await w.worker.runOnce()).toBe(true);

    // The web search was among the tools a visitor's reply is offered, and it ran once.
    expect(inner.calls[0]!.tools?.map((t) => t.name)).toContain(SEARCH_WEB);
    expect(engine.queries).toEqual([QUERY]);
    // Held before the engine was called: the run's hold had grown by exactly the price.
    expect(seen.before > 0n).toBe(true);
    expect(seen.during - seen.before).toBe(PRICE);
    expect(await w.posted()).toEqual(["今天多云。"]);
    const run = await w.run();
    expect(run).toMatchObject({ status: "done", error: null, lane: "others", caller: w.visitor.id, hold: "0", searches: 1, web: PRICE.toString() });
    // Charged to the owner (the search outside the model's part), nothing to the visitor.
    const records = (await db.query<{ owner_id: string; web: string; total: string }>("select owner_id, web_micro::text as web, (free_micro + balance_micro)::text as total from usage_records where run_id = $1", [run.id])).rows;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ owner_id: w.owner.id, web: PRICE.toString() });
    expect(BigInt(records[0]!.total) >= PRICE).toBe(true);
    expect((await db.query("select 1 from usage_records where owner_id = $1", [w.visitor.id])).rowCount).toBe(0);
    // The owner's use page: what the reply was charged, the search in it, in the visitor's row.
    const use = (await api(app, w.owner, "GET", "/api/me/others-use")).json;
    expect(Number(use.used)).toBeGreaterThanOrEqual(0.77);
    expect(use.byPerson.map((r: { person: { id: string }; points: string }) => [r.person.id, r.points])).toEqual([[w.visitor.id, use.used]]);
    // The visitor is sent the reply and never the search words; nothing of the query is logged.
    const read = (await api(app, w.visitor, "GET", `/api/conversations/${w.conv}/messages`)).json.messages as Array<Record<string, unknown>>;
    const reply = read.find((m) => m.senderId === w.agent.id)!;
    expect(reply.text).toBe("今天多云。");
    expect(reply).not.toHaveProperty("queries");
    // The pages it read are part of the reply for everyone who reads it; the search words are the owner's in the Agent's OWN conversation
    // only (plan, Global Constraints), so the owner watching this conversation as its observer is not sent them either.
    const watched = ((await api(app, w.owner, "GET", `/api/conversations/${w.conv}/messages`)).json.messages as Array<Record<string, unknown>>).find((m) => m.senderId === w.agent.id)!;
    expect(watched).not.toHaveProperty("queries");
    expect(JSON.stringify(watched)).not.toContain(QUERY);
    expect(Array.isArray(reply.webSources) && (reply.webSources as unknown[]).length).toBe(3);
    expect(watched.webSources).toEqual(reply.webSources);
    expect(lines.join(" ")).not.toContain("天气");
  });

  it("the owner's numbers cannot take the search: no search is made, the model is told, the reply goes on without it and is posted; counted once", async () => {
    const engine = fakeEngine();
    const inner = scriptedGateway().callTools([{ name: SEARCH_WEB, input: { query: QUERY } }], { usage: { inputTokens: 900, outputTokens: 40 } }).reply("查不了，凭印象说。", { usage: { inputTokens: 1200, outputTokens: 20 } });
    const ctx = { conv: "", owner: "", agent: "", own: "" };
    let first = true;
    // On its first request, with its hold written, others' use of the owner's Agents is brought to the owner's number: its search is refused.
    const gateway = Object.create(inner) as ModelGateway & typeof inner;
    gateway.stream = ((call: ModelCall) => {
      const events = inner.stream(call);
      return (async function* () {
        if (first) {
          first = false;
          const hold = BigInt((await db.query<{ h: string }>("select hold_micro::text as h from agent_runs where conversation_id = $1 order by created_at desc limit 1", [ctx.conv])).rows[0]!.h);
          expect(hold).toBeGreaterThan(0n);
          await paidReply(db, { agentId: ctx.agent, ownerId: ctx.owner, conversationId: ctx.own, lane: "others", micro: 300n * POINT });
        }
        yield* events;
      })();
    }) as ModelGateway["stream"];
    const w = await world(engine, gateway);
    Object.assign(ctx, { conv: w.conv, owner: w.owner.id, agent: w.agent.id, own: w.agent.conversationId });
    await w.say(w.visitor, "上海今天天气怎么样？");
    expect(await w.worker.runOnce()).toBe(true);
    expect(engine.queries).toEqual([]);
    expect(inner.calls[1]!.steps?.flatMap((s) => s.results.map((r) => r.output))).toEqual([{ error: WEB_LANE_BUDGET }]);
    expect(await w.posted()).toEqual(["查不了，凭印象说。"]);
    expect(await w.run()).toMatchObject({ status: "done", hold: "0", searches: 0, web: "0" });
    expect(metric("web_refused_lane_budget")).toHaveLength(1);
    // The visitor is told nothing of why (the reply answered: no call was refused).
    const read = (await api(app, w.visitor, "GET", `/api/conversations/${w.conv}/messages`)).json;
    expect(JSON.stringify(read)).not.toContain("lane_budget");
  });
});

/**
 * The merge with the working branch (learned success, `AgentPort.toolsWorked`): a provider's model whose entry says nothing of tools is
 * stored `tools: true` after a reply whose tool call ran. A VISITOR's turn may teach the owner's model that one fact and nothing else.
 */
describe("a visitor's turn on the owner's provider model whose entry says nothing of tools", () => {
  it("its tool call ran: `tools: true` is stored on that model alone, on the owner's own row; nothing of the visitor or of the call is stored, told or logged, and the visitor reads no provider", async () => {
    const CANARY = "暗号-canary-5528";
    const engine = fakeEngine();
    const gateway = scriptedGateway().callTools([{ name: SEARCH_WEB, input: { query: CANARY } }], { usage: { inputTokens: 900, outputTokens: 40 } }).reply("查到了。", { usage: { inputTokens: 1200, outputTokens: 20 } });
    const made = { providerId: "" };
    const w = await world(engine, gateway, async (owner) => {
      const res = await api(app, owner, "POST", "/api/providers", providerBody({ models: [{ name: "pm" }, { name: "pm2" }] }));
      expect(res.status).toBe(201);
      made.providerId = res.json.id as string;
      return { source: "provider", providerId: made.providerId, model: "pm" };
    });
    const stored = async () => (await db.query<{ models: Array<Record<string, unknown>> }>("select models from providers where id = $1", [made.providerId])).rows[0]!.models;
    const before = await stored();
    expect(before.map((m) => [m.name, m.tools])).toEqual([["pm", undefined], ["pm2", undefined]]);
    const whispers = async () => Number((await db.query<{ n: string }>("select count(*) n from whispers")).rows[0]!.n);
    const whispersBefore = await whispers();
    await w.say(w.visitor, "帮我查一下。");
    expect(await w.worker.runOnce()).toBe(true);
    expect(engine.queries).toEqual([CANARY]);
    expect(await w.posted()).toEqual(["查到了。"]);
    expect(await w.run()).toMatchObject({ status: "done", lane: "others", caller: w.visitor.id });
    // The whole change of the provider's row: the one fact, on the model that ran.
    const after = await stored();
    expect(after.map((m) => [m.name, m.tools])).toEqual([["pm", true], ["pm2", undefined]]);
    const rest = (models: Array<Record<string, unknown>>) => models.map(({ tools: _tools, ...other }) => other);
    expect(rest(after)).toEqual(rest(before));
    const row = JSON.stringify((await db.query("select * from providers where id = $1", [made.providerId])).rows[0]);
    expect(row).not.toContain(w.visitor.id);
    expect(row).not.toContain("canary");
    // Nobody is told, and the visitor has no provider to read it on.
    expect(await whispers()).toBe(whispersBefore);
    expect((await api(app, w.visitor, "GET", "/api/providers")).json.providers).toEqual([]);
    expect(JSON.stringify((await api(app, w.visitor, "GET", `/api/conversations/${w.conv}/messages`)).json)).not.toContain("canary");
    // Nothing of the call is logged.
    expect(lines.join(" ")).not.toContain("canary");
    // The visitor pays nothing for it.
    expect((await db.query("select 1 from usage_records where owner_id = $1", [w.visitor.id])).rowCount).toBe(0);
  });
});

/**
 * Fix round 3, point 10: the level an owner sets for replies to others is also a VISITOR's reply's level, in the conversation with the
 * Agent. Through the hold, the call, the settlement and what the visitor is sent.
 */
describe("a visitor's reply at the level the owner set for others", () => {
  it("held for the level before the call, sent at it, settled on the owner within the hold; the owner reads the level and the thinking, the visitor neither (read, sync and socket)", async () => {
    const THOUGHT = "THINKING-canary-7719";
    const allowance = app.deps.config.reasoningAllowanceTokens.medium;
    const inner = scriptedGateway().reply("周三下午可以。", { reasoning: THOUGHT, usage: { inputTokens: 900, outputTokens: 2500 } });
    const ctx = { conv: "" };
    let held = -1n;
    const gateway = Object.create(inner) as ModelGateway & typeof inner;
    gateway.stream = ((call: ModelCall) => {
      const events = inner.stream(call);
      return (async function* () {
        held = BigInt((await db.query<{ h: string }>("select hold_micro::text as h from agent_runs where conversation_id = $1 order by created_at desc limit 1", [ctx.conv])).rows[0]!.h);
        yield* events;
      })();
    }) as ModelGateway["stream"];
    const w = await world(fakeEngine(), gateway, async () => BIG_MODEL, { othersReasoning: "medium", reasoning: "low" });
    ctx.conv = w.conv;
    const socket = await connect(app, w.visitor);
    await w.say(w.visitor, "周三有空吗？");
    expect(await w.worker.runOnce()).toBe(true);
    // The call: the others' level (not the Agent's own low), made as the owner's own reply at that level is: the model's own output
    // limit with the level's allowance on top.
    const big = app.deps.config.siteModels.find((m) => m.id === BIG_MODEL.id)!;
    const out = outputLimit(big.maxOutputTokens, big.contextTokens, "medium", app.deps.config.reasoningAllowanceTokens);
    expect(out).toBe(big.maxOutputTokens + allowance);
    expect(inner.calls[0]).toMatchObject({ reasoning: "medium", maxOutputTokens: out });
    // Held before the call for exactly that output (280 micro-points a token on this model) and its input.
    expect(held >= BigInt(out) * 280n).toBe(true);
    // (Offered tools, it may hold for its last call too: never more than the most one such reply can cost, the ceiling the owner's
    // page shows under the level, searches aside.)
    expect(held <= othersReplyCeilingMicro(app.deps.config, big, "medium", null)).toBe(true);
    const run = await w.run();
    expect(run).toMatchObject({ status: "done", lane: "others", caller: w.visitor.id, hold: "0" });
    expect((await db.query<{ reasoning: string }>("select reasoning from agent_runs where id = $1", [run.id])).rows[0]!.reasoning).toBe("medium");
    // Settled on the owner, once, within what was held; nothing for the visitor.
    const records = (await db.query<{ owner_id: string; total: string }>("select owner_id, (free_micro + balance_micro)::text as total from usage_records where run_id = $1", [run.id])).rows;
    expect(records).toHaveLength(1);
    expect(records[0]!.owner_id).toBe(w.owner.id);
    expect(BigInt(records[0]!.total) > 0n && BigInt(records[0]!.total) <= held).toBe(true);
    expect((await db.query("select 1 from usage_records where owner_id = $1", [w.visitor.id])).rowCount).toBe(0);
    // The owner, watching, reads the level under the reply and the thinking; the visitor is sent neither, anywhere.
    const of = async (who: Actor) => ((await api(app, who, "GET", `/api/conversations/${w.conv}/messages`)).json.messages as Array<Record<string, unknown>>).find((m) => m.senderId === w.agent.id)!;
    const owners = await of(w.owner);
    expect(owners.via).toMatchObject({ reasoning: "medium" });
    expect(owners.reasoning).toBe(THOUGHT);
    const visitors = await of(w.visitor);
    expect(visitors.text).toBe("周三下午可以。");
    expect(visitors).not.toHaveProperty("via");
    expect(visitors).not.toHaveProperty("reasoning");
    const sync = JSON.stringify((await api(app, w.visitor, "GET", "/api/sync")).json);
    const frames = JSON.stringify(socket.events);
    for (const text of [sync, frames]) {
      expect(text).not.toContain(THOUGHT);
      expect(text).not.toContain("othersReasoning");
      expect(text).not.toContain('"via"');
    }
    expect(frames).toContain("周三下午可以。");
  });
});
