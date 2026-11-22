import { afterEach, describe, expect, it, vi } from "vitest";
import { aboutPoints } from "../src/accounts/store.ts";
import { mentionsAtSend } from "../src/agents/mentions.ts";
import { createAgentPort, type DbAgentPort } from "../src/agents/port-impl.ts";
import { FINAL_LINE } from "../src/agents/runtime/loop.ts";
import { NO_WEB_HERE, WEB_RULES } from "../src/agents/runtime/prompt.ts";
import { createAgentWorker, type AgentWorker } from "../src/agents/runtime/worker.ts";
import { budgetReachedWith, spentTodayOf, siteToday, triggerFromAgent } from "../src/agents/runs.ts";
import { lockAgent, type AgentRow } from "../src/agents/store.ts";
import { createToolbox, SEARCH_WEB } from "../src/agents/tools/index.ts";
import type { WebEngine, WebResult, WebSearchError } from "../src/agents/tools/web/engine.ts";
import { holdSearch, SearchRefused, SITE_SCOPE } from "../src/agents/tools/web/hold.ts";
import { WEB_LANE_BUDGET, WEB_NO_MONEY, WEB_QUERY_PRIVATE, WEB_REPLY_CAP, WEB_SITE_DAY } from "../src/agents/tools/web/tool.ts";
import type { Config, WebSearchConfig } from "../src/config.ts";
import { admitRun } from "../src/metering/admit.ts";
import { settle } from "../src/metering/settle.ts";
import { webEngineOf } from "../src/app.ts";
import { RunRefs } from "../src/agents/tools/refs.ts";
import { searchWebTool } from "../src/agents/tools/web/tool.ts";
import { createSlots } from "../src/slots.ts";
import type { ModelCall } from "../src/models/gateway.ts";
import { insertMessage } from "../src/messages/model.ts";
import { api, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { costOf, grant, METER_ENV, meteredAgent, paidReply } from "./helpers/metering.ts";
import { scriptedGateway, type ScriptedGateway } from "./helpers/models.ts";
import { providerBody } from "./helpers/providers.ts";
import { closeAllSockets } from "./helpers/ws.ts";

/**
 * The web search under the product owner's rules of 2026-11-22 (lane websearch2; README "Agents and runs", Web search, and
 * "Metering", A web search's price), on the real port, toolbox, worker and database, with a fake engine (never a real
 * call) and the scripted model: offered in every lane, on site and provider models alike; a search is part of the reply's
 * cost, paid from the owner's points (a provider model's reply too: the free allowance first, then the balance), seen by
 * every budget of its lane before it is spent and after; no cap per owner — the points are the bound; three a reply; the
 * site's money fuse; the guard's exemption only for what the owner typed; a relay's search in its chain budget.
 */

const lines: string[] = [];
// 26 replies of one owner in a few seconds: past the site's 20 a minute (a rule apart from the web search's).
const { app, db } = useApp({ env: { ...METER_ENV, AGENT_RUNS_PER_MINUTE: "100" }, agentWorker: false, logStream: { write: (line) => void lines.push(line) } });

afterEach(async () => {
  await closeAllSockets();
  vi.restoreAllMocks();
  lines.length = 0;
});

const PAID = { source: "site", id: "meter_paid" } as const;
const POINT = 1_000_000n;
const PRICE = 770_350n;
const FREE_DAY = 3n * POINT;

const QUERY = "北京 天气 预报";
const RESULTS: WebResult[] = [1, 2, 3].map((i) => ({ url: `https://news${i}.example.com/a/${i}`, title: `新闻标题${i}`, snippet: `摘要内容${i}`, age: "2026-11-20T08:00:00Z" }));

/** A fake engine answering `answer` (default: the three results), recording every query. */
function fakeEngine(answer: (query: string, signal: AbortSignal) => Promise<{ results: WebResult[] } | { error: WebSearchError }> | { results: WebResult[] } | { error: WebSearchError } = () => ({ results: RESULTS })) {
  const queries: string[] = [];
  const engine: WebEngine & { queries: string[] } = {
    name: "fake",
    queries,
    async searchWeb(query, { signal }) {
      queries.push(query);
      return answer(query, signal);
    },
  };
  return engine;
}

/**
 * The app's configuration with the web search on (and `web`, `tools` over it): its default engine (Exa, faked here) at a
 * price the meter models' 3 free points a day hold three of (the first version's 0.77035 points).
 */
const webConfig = (web: Partial<WebSearchConfig> = {}, tools: Partial<Config["tools"]> = {}): Config => ({
  ...app.deps.config,
  tools: { ...app.deps.config.tools, ...tools, web: { ...app.deps.config.tools.web, enabled: true, pointsMicroPerSearch: Number(PRICE), ...web } },
});

function webWorker(gateway: ScriptedGateway, engine: WebEngine | null, config: Config = webConfig()): { port: DbAgentPort; worker: AgentWorker } {
  const { db: pool, blobs, conversations, reads, searches } = app.deps;
  const toolbox = createToolbox({ db: pool, blobs, searches, config, log: app.log, webEngine: engine });
  const port = createAgentPort({ db: pool, config, blobs, realtime: app.realtime, conversations, reads, log: app.log, toolbox });
  const worker = createAgentWorker({ port, models: gateway, runTimeoutMs: config.agentRunTimeoutMs, maxRunsInFlight: 1, background: false, log: app.log, tools: config.tools });
  return { port, worker };
}

let txn = 0;
const say = async (who: Actor, conv: string, text: string): Promise<number> => {
  const sent = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `wr${++txn}` });
  if (sent.status !== 201) throw new Error(`say: ${sent.status} ${JSON.stringify(sent.json)}`);
  return sent.json.message.seq as number;
};

type Kind = "site" | "provider";

/** A new owner with 20 points and an Agent `${name}_bot` on a site model or on their own provider's model. */
async function owned(name: string, kind: Kind = "site", balance = 20n * POINT) {
  const owner = await signUp(app, name);
  let model: unknown = PAID;
  if (kind === "provider") {
    const provider = (await api(app, owner, "POST", "/api/providers", providerBody({ models: [{ name: "own-1", contextTokens: 32000 }] }))).json;
    model = { source: "provider", providerId: provider.id, model: "own-1" };
  }
  const agent = await mustCreateAgent(app, owner, { handle: `${name}_bot`, name: `${name}助手`, model, persona: "简短地回答。" });
  if (balance > 0n) await grant(db, owner.id, balance);
  return { owner, agent: agent as { id: string; conversationId: string; handle: string }, own: agent.conversationId as string };
}

/** A group of `owner` with two more people, the Agent `agentId` put in it by its owner. */
async function groupWith(owner: Actor, name: string, agentIds: string[]) {
  const mia = await signUp(app, `${name}_mia`);
  const g = await group(app, owner, `${name}群`, [mia, await signUp(app, `${name}_ned`)]);
  for (const id of agentIds) expect((await api(app, owner, "POST", `/api/conversations/${g}/members`, { principalId: id })).status).toBe(201);
  return { g, mia };
}

/** A reply nobody asked for, queued as the proactive judgement queues one (its owner's switch on). */
async function proactiveRun(agentId: string, ownerId: string, g: string, by: Actor): Promise<void> {
  const seq = await say(by, g, "今天好冷");
  await db.query("update agents set proactive = true where principal_id = $1", [agentId]);
  await db.query(
    `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, triggered_by, caller_id, lane, asker_ids, call_seqs)
     values ('reply', $1, $2, $3, 'queued', $4, 'human', null, 'proactive', array[$5::uuid], array[$4::bigint])`,
    [g, agentId, ownerId, seq, by.id],
  );
}

/** Agent `agentId` posts `text` in group `conv`, calling those it mentions as an Agent's message does (a relay). */
const agentSays = (agentId: string, conv: string, text: string) =>
  db.tx(async (t) => {
    const poster = await lockAgent(t, agentId, conv);
    const message = await insertMessage(t, conv, agentId, "text", { text }, null, await mentionsAtSend(t, { id: conv, type: "group" }, text));
    return triggerFromAgent(t, conv, message, poster, null, app.deps.config, null);
  });

const outputs = (call: ModelCall): any[] => (call.steps ?? []).flatMap((s) => s.results.map((r) => r.output));
const names = (call: ModelCall) => (call.tools ?? []).map((t) => t.name);

/** The queued reply's first round searches the web for `query` (each of `queries`), then it answers `answer`. */
async function searchRun(worker: AgentWorker, gateway: ScriptedGateway, queries: string[] = [QUERY], answer = "好。") {
  gateway.callTools(queries.map((query) => ({ name: SEARCH_WEB, input: { query } })), { usage: { inputTokens: 1000, outputTokens: 20 } }).reply(answer, { usage: { inputTokens: 1500, outputTokens: 30 } });
  expect(await worker.runOnce()).toBe(true);
  return outputs(gateway.calls.at(-1)!);
}

const lastRun = async (agentId: string) =>
  (
    await db.query<{ id: string; status: string; lane: string; triggered_by: string; charge_to: string | null; source: string; hold: string; web_searches: number; web_micro: string }>(
      `select id, status, lane, triggered_by, charge_to, source, hold_micro::text as hold, web_searches, web_micro::text as web_micro
         from agent_runs where agent_id = $1 and purpose = 'reply' order by created_at desc limit 1`,
      [agentId],
    )
  ).rows[0]!;
const recordOf = async (runId: string) =>
  (
    await db.query<{ cost: string; balance: string; free: string; forgiven: string; web_searches: number; web_micro: string; source: string }>(
      `select cost_micro::text as cost, balance_micro::text as balance, free_micro::text as free, forgiven_micro::text as forgiven, web_searches,
              web_micro::text as web_micro, source from usage_records where run_id = $1`,
      [runId],
    )
  ).rows[0]!;
const balanceOf = async (ownerId: string) => BigInt((await db.query<{ b: string }>("select balance_micro::text as b from accounts where principal_id = $1", [ownerId])).rows[0]!.b);
const freeUsed = async (ownerId: string) =>
  BigInt((await db.query<{ u: string | null }>("select (select used_micro::text from free_usage where owner_id = $1 and day = (now() at time zone 'Asia/Shanghai')::date) as u", [ownerId])).rows[0]!.u ?? "0");
const setFreeUsed = (ownerId: string, micro: bigint) =>
  db.query(
    `insert into free_usage (owner_id, day, used_micro) values ($1, (now() at time zone 'Asia/Shanghai')::date, $2)
     on conflict (owner_id, day) do update set used_micro = $2`,
    [ownerId, micro.toString()],
  );
const siteCount = async () =>
  (await db.query<{ n: number | null }>("select (select searches from web_search_days where scope = $1 and day = (now() at time zone 'Asia/Shanghai')::date) as n", [SITE_SCOPE])).rows[0]!.n ?? 0;
/** Today's fuse at `n` searches of `cost` micro-USD each. */
const setSiteCount = (n: number, cost = 2000) =>
  db.query(
    `insert into web_search_days (scope, day, searches, spent_micro_usd) values ($1, (now() at time zone 'Asia/Shanghai')::date, $2, $3)
     on conflict (scope, day) do update set searches = $2, spent_micro_usd = $3`,
    [SITE_SCOPE, n, (BigInt(n) * BigInt(cost)).toString()],
  );
const siteSpent = async () =>
  BigInt((await db.query<{ s: string | null }>("select (select spent_micro_usd::text from web_search_days where scope = $1 and day = (now() at time zone 'Asia/Shanghai')::date) as s", [SITE_SCOPE])).rows[0]!.s ?? "0");
const metricLines = (metric: string) => lines.filter((l) => l.includes(`"metric":"${metric}"`)).map((l) => JSON.parse(l) as Record<string, unknown>);

/** What a reply on the meter models costs in this file's two rounds. */
const MODEL_COST = costOf({ inputTokens: 2500, outputTokens: 50 });

/** What `kind`'s reply with one search is charged: a site model's both; a provider's only the search (here: the free allowance first). */
const chargedOf = (kind: Kind) => (kind === "site" ? MODEL_COST + PRICE : PRICE);

describe("offered in every lane, on every model", () => {
  /** One reply of each lane, made ready to run (queued), for an Agent of `kind`; what the first call is offered. */
  const lanes: Array<{ lane: string; ready: (name: string, kind: Kind) => Promise<{ agentId: string; ownerId: string; lane: string; by: string }> }> = [
    {
      lane: "the owner's own conversation",
      ready: async (name, kind) => {
        const { owner, agent, own } = await owned(name, kind);
        await say(owner, own, "北京今天天气怎么样？");
        return { agentId: agent.id, ownerId: owner.id, lane: "own", by: "human" };
      },
    },
    {
      lane: "the owner's call in a group",
      ready: async (name, kind) => {
        const { owner, agent } = await owned(name, kind);
        const { g } = await groupWith(owner, name, [agent.id]);
        await say(owner, g, `@${agent.handle} 北京明天天气？`);
        return { agentId: agent.id, ownerId: owner.id, lane: "own", by: "human" };
      },
    },
    {
      lane: "another member's call",
      ready: async (name, kind) => {
        const { owner, agent } = await owned(name, kind);
        const { g, mia } = await groupWith(owner, name, [agent.id]);
        await say(mia, g, `@${agent.handle} 北京明天天气？`);
        return { agentId: agent.id, ownerId: owner.id, lane: "others", by: "human" };
      },
    },
    {
      lane: "a reply nobody asked for",
      ready: async (name, kind) => {
        const { owner, agent } = await owned(name, kind);
        const { g, mia } = await groupWith(owner, name, [agent.id]);
        await proactiveRun(agent.id, owner.id, g, mia);
        return { agentId: agent.id, ownerId: owner.id, lane: "proactive", by: "human" };
      },
    },
    {
      lane: "an Agent-to-Agent relay",
      ready: async (name, kind) => {
        const { owner, agent } = await owned(name, kind);
        const other = await mustCreateAgent(app, owner, { handle: `${name}_two`, name: "另一个", model: PAID, persona: "简短。" });
        const { g, mia } = await groupWith(owner, name, [agent.id, other.id]);
        await say(mia, g, "大家好");
        await agentSays(other.id, g, `@${agent.handle} 你查一下北京天气`);
        return { agentId: agent.id, ownerId: owner.id, lane: "own", by: "agent" };
      },
    },
  ];

  for (const kind of ["site", "provider"] as const) {
    for (const [i, { lane, ready }] of lanes.entries()) {
      it(`${lane}, on a ${kind} model: offered search_web; the search runs and is charged to the owner's points`, async () => {
        const gateway = scriptedGateway();
        const engine = fakeEngine();
        const { worker } = webWorker(gateway, engine);
        const r = await ready(`ln${kind[0]}${i}`, kind);
        const [out] = await searchRun(worker, gateway);
        expect(names(gateway.calls[0]!)).toContain(SEARCH_WEB);
        // Its system text has the web's rules, in its own conversation and in a group alike.
        for (const rule of WEB_RULES) expect(gateway.calls[0]!.system).toContain(rule);
        expect(gateway.calls[0]!.system).not.toContain(NO_WEB_HERE);
        expect(engine.queries).toEqual([QUERY]);
        expect(out).toMatchObject({ results: expect.any(Array) });
        const run = await lastRun(r.agentId);
        expect([run.lane, run.triggered_by, run.source, run.web_searches, run.web_micro]).toEqual([r.lane, r.by, kind, 1, PRICE.toString()]);
        const record = await recordOf(run.id);
        expect(BigInt(record.free) + BigInt(record.balance)).toBe(chargedOf(kind));
        expect(record).toMatchObject({ web_searches: 1, web_micro: PRICE.toString(), forgiven: "0" });
      });
    }
  }

  // (A greeting is offered no tools, search_web included: web-search-fixes.test.ts "web search x greeting".)
  for (const [i, { lane, ready }] of lanes.entries()) {
    it(`${lane}: the Agent's own switch off keeps it away — the three tools, and the one line that it cannot go online`, async () => {
      const gateway = scriptedGateway();
      const engine = fakeEngine();
      const { worker } = webWorker(gateway, engine);
      const r = await ready(`lnoff${i}`, "provider");
      await db.query("update agents set web_search = false where principal_id = $1", [r.agentId]);
      gateway.reply("不知道。");
      expect(await worker.runOnce()).toBe(true);
      expect(names(gateway.calls[0]!)).not.toContain(SEARCH_WEB);
      expect(gateway.calls[0]!.system).toContain(NO_WEB_HERE);
      expect(engine.queries).toEqual([]);
    });
  }
});

describe("a provider model's reply pays for its searches from the owner's points", () => {
  it("the free allowance first: charged there, the model's own cost none; the usage page shows the search apart", async () => {
    const gateway = scriptedGateway();
    const { worker } = webWorker(gateway, fakeEngine());
    const { owner, agent, own } = await owned("pva", "provider", 0n);
    await say(owner, own, "天气？");
    await searchRun(worker, gateway);
    const run = await lastRun(agent.id);
    expect([run.charge_to, run.hold]).toEqual(["free", "0"]);
    expect(await recordOf(run.id)).toMatchObject({ source: "provider", cost: PRICE.toString(), free: PRICE.toString(), balance: "0", forgiven: "0" });
    expect(await freeUsed(owner.id)).toBe(PRICE);
    const usage = (await api(app, owner, "GET", "/api/usage")).json;
    expect(usage.recent).toEqual([{ agentId: agent.id, purpose: "reply", model: "own-1", source: "provider", points: "0", replies: 1 }]);
    expect(usage.recentWeb).toEqual([{ agentId: agent.id, searches: 1, points: "0.77035" }]);
    // The reply's via says what it cost: the search.
    const wire = (await api(app, owner, "GET", `/api/conversations/${own}/messages`)).json.messages.at(-1);
    expect(wire.via).toMatchObject({ points: "0.77035", webSearches: 1 });
  });

  it("then the balance, when what is left of the allowance cannot cover the price; three searches in one reply on one source", async () => {
    const gateway = scriptedGateway();
    const { worker } = webWorker(gateway, fakeEngine());
    const { owner, agent, own } = await owned("pvb", "provider", 10n * POINT);
    await setFreeUsed(owner.id, FREE_DAY - PRICE + 1n);
    await say(owner, own, "天气？");
    const outs = await searchRun(worker, gateway, ["北京 天气", "上海 天气", "广州 天气"]);
    expect(outs.map((o) => "results" in o)).toEqual([true, true, true]);
    const run = await lastRun(agent.id);
    expect([run.charge_to, run.web_searches]).toEqual(["balance", 3]);
    expect(await recordOf(run.id)).toMatchObject({ balance: (3n * PRICE).toString(), free: "0", web_micro: (3n * PRICE).toString() });
    expect(await balanceOf(owner.id)).toBe(10n * POINT - 3n * PRICE);
  });

  it("neither: refused before the engine (an error the model words); the reply goes on and costs nothing", async () => {
    const gateway = scriptedGateway();
    const engine = fakeEngine();
    const { worker } = webWorker(gateway, engine);
    const { owner, agent, own } = await owned("pvc", "provider", PRICE - 1n);
    await setFreeUsed(owner.id, FREE_DAY - PRICE + 1n);
    await say(owner, own, "天气？");
    expect(await searchRun(worker, gateway, [QUERY], "查不了。")).toEqual([{ error: WEB_NO_MONEY }]);
    expect(engine.queries).toEqual([]);
    // Counted by its bound: the owner's points (lane websearch2, fix round 1: which bound bites shows in the log).
    expect(metricLines("web_refused_no_points")).toHaveLength(1);
    expect([metricLines("web_refused_reply_cap"), metricLines("web_refused_lane_budget")]).toEqual([[], []]);
    const run = await lastRun(agent.id);
    expect([run.status, run.charge_to, run.web_searches]).toEqual(["done", null, 0]);
    expect(await recordOf(run.id)).toMatchObject({ cost: "0", free: "0", balance: "0", web_searches: 0 });
    expect(await siteCount()).toBe(0);
  });

  it("the count and the charge stand: the engine failing, the reply stopped while the engine runs", async () => {
    {
      const gateway = scriptedGateway();
      const { worker } = webWorker(gateway, fakeEngine(() => ({ error: "unavailable" })));
      const { owner, agent, own } = await owned("pvd", "provider");
      await say(owner, own, "天气？");
      await searchRun(worker, gateway);
      expect(await recordOf((await lastRun(agent.id)).id)).toMatchObject({ web_searches: 1, free: PRICE.toString() });
    }
    {
      const gateway = scriptedGateway();
      let reached!: () => void;
      const atEngine = new Promise<void>((r) => (reached = r));
      const engine = fakeEngine(
        (_q, signal) =>
          new Promise((resolve) => {
            reached();
            signal.addEventListener("abort", () => resolve({ error: "unavailable" }), { once: true });
          }),
      );
      const { port, worker } = webWorker(gateway, engine);
      const { owner, agent, own } = await owned("pve", "provider");
      await say(owner, own, "天气？");
      gateway.callTools([{ name: SEARCH_WEB, input: { query: QUERY } }]);
      const running = worker.runOnce();
      await atEngine;
      port.requestStop((await lastRun(agent.id)).id);
      await running;
      const run = await lastRun(agent.id);
      expect(run.status).toBe("stopped");
      expect(await recordOf(run.id)).toMatchObject({ web_searches: 1, free: PRICE.toString(), cost: PRICE.toString() });
    }
  });
});

describe("no cap per owner: the points are the bound", () => {
  it("25 searches of one owner in a day all run while points last (crossing 10); the 26th, with nothing left to pay it, is refused", { timeout: 120_000 }, async () => {
    const gateway = scriptedGateway();
    const engine = fakeEngine();
    const { worker } = webWorker(gateway, engine);
    // The free allowance pays 3 (3 × 0.77035 of 3 points), the balance the other 22 (16.9477 of 17).
    const { owner, agent, own } = await owned("capd", "provider", 17n * POINT);
    for (let n = 1; n <= 25; n++) {
      await say(owner, own, `第${n}次`);
      expect((await searchRun(worker, gateway))[0], `search ${n}`).toMatchObject({ results: expect.any(Array) });
    }
    expect(engine.queries).toHaveLength(25);
    await say(owner, own, "再查一次");
    expect(await searchRun(worker, gateway)).toEqual([{ error: WEB_NO_MONEY }]);
    expect(engine.queries).toHaveLength(25);
    expect(await freeUsed(owner.id)).toBe(3n * PRICE);
    expect(await balanceOf(owner.id)).toBe(17n * POINT - 22n * PRICE);
    // Nothing is counted for the owner: only the site's fuse has a row.
    expect((await db.query("select 1 from web_search_days where scope = $1", [owner.id])).rowCount).toBe(0);
    expect((await api(app, owner, "GET", "/api/usage")).json.recentWeb).toEqual([{ agentId: agent.id, searches: 25, points: "19.25875" }]);
  });

  it("three a reply: the 4th is answered with the cap's note, never searched", async () => {
    const gateway = scriptedGateway();
    const engine = fakeEngine();
    const { worker } = webWorker(gateway, engine);
    const { owner, agent, own } = await owned("capr");
    await say(owner, own, "天气？");
    const outs = await searchRun(worker, gateway, ["北京 天气", "上海 天气", "广州 天气", "深圳 天气"]);
    expect(engine.queries).toEqual(["北京 天气", "上海 天气", "广州 天气"]);
    expect(outs.slice(0, 3).every((o) => "results" in o)).toBe(true);
    expect(outs[3]).toEqual({ note: "这类查询这次回复里不能再用了。" });
    expect((await lastRun(agent.id)).web_searches).toBe(3);
  });
});

describe("each lane's own budget sees the search: before it is spent, and after", () => {
  it("someone else's calls: the others' daily budget (a provider model's searches count now); refused at the pre-hold, the reply goes on", async () => {
    const gateway = scriptedGateway();
    const engine = fakeEngine();
    const { worker } = webWorker(gateway, engine);
    const { owner, agent } = await owned("bgo", "provider");
    expect((await api(app, owner, "PATCH", `/api/agents/${agent.id}`, { othersBudget: "1" })).status).toBe(200);
    const { g, mia } = await groupWith(owner, "bgo", [agent.id]);
    await say(mia, g, `@${agent.handle} 北京天气？`);
    await searchRun(worker, gateway);
    // After: the budget counts what the search was charged.
    expect((await spentTodayOf(db, [agent.id], siteToday(app.deps.config))).get(agent.id)).toEqual({ others: PRICE, proactive: 0n });
    expect((await api(app, owner, "GET", `/api/agents/${agent.id}`)).json.othersSpentToday).toBe("0.77035");
    // Before: 0.77035 settled + 0.77035 ≥ 1 — the second search is refused before the engine; the reply is still posted.
    await say(mia, g, `@${agent.handle} 上海呢？`);
    expect(await searchRun(worker, gateway, ["上海 天气"], "查不了了。")).toEqual([{ error: WEB_LANE_BUDGET }]);
    expect(engine.queries).toEqual([QUERY]);
    expect(metricLines("web_refused_lane_budget")).toHaveLength(1);
    expect([metricLines("web_refused_reply_cap"), metricLines("web_refused_no_points")]).toEqual([[], []]);
    expect((await lastRun(agent.id)).status).toBe("done");
  });

  it("a reply nobody asked for: the proactive daily budget, the same way", async () => {
    const gateway = scriptedGateway();
    const engine = fakeEngine();
    const { worker } = webWorker(gateway, engine);
    const { owner, agent } = await owned("bgp", "provider");
    expect((await api(app, owner, "PATCH", `/api/agents/${agent.id}`, { proactiveBudget: "1" })).status).toBe(200);
    const { g, mia } = await groupWith(owner, "bgp", [agent.id]);
    await proactiveRun(agent.id, owner.id, g, mia);
    await searchRun(worker, gateway);
    expect((await spentTodayOf(db, [agent.id], siteToday(app.deps.config))).get(agent.id)).toEqual({ others: 0n, proactive: PRICE });
    await proactiveRun(agent.id, owner.id, g, mia);
    expect(await searchRun(worker, gateway, ["上海 天气"])).toEqual([{ error: WEB_LANE_BUDGET }]);
    expect(engine.queries).toEqual([QUERY]);
  });

  it("a relay: its search counts in the chain budget (refused there when reached); page text adds no mention to the chain", async () => {
    const gateway = scriptedGateway();
    const mentioning = [{ url: "https://x.example.com/1", title: "@lnrel_two 快来看", snippet: "联系 @lnrel_two 或 lnrel_two@example.com 了解", age: "2026-11-20T08:00:00Z" }];
    const engine = fakeEngine(() => ({ results: mentioning }));
    const { worker } = webWorker(gateway, engine);
    const { owner, agent } = await owned("lnrel", "provider");
    expect((await api(app, owner, "PATCH", `/api/agents/${agent.id}`, { chainBudget: "1" })).status).toBe(200);
    const other = await mustCreateAgent(app, owner, { handle: "lnrel_two", name: "另一个", model: PAID, persona: "简短。" });
    const { g, mia } = await groupWith(owner, "lnrel", [agent.id, other.id]);
    const human = await say(mia, g, "大家好");
    await agentSays(other.id, g, `@${agent.handle} 查一下北京天气`);
    const [out] = await searchRun(worker, gateway);
    expect((await lastRun(agent.id)).triggered_by).toBe("agent");
    // The page's mention and address never reach the model; the reply mentions nobody, so nothing more is called.
    expect(JSON.stringify(out)).not.toMatch(/@|example\.com/);
    expect((await db.query("select 1 from agent_runs where agent_id = $1", [other.id])).rowCount).toBe(0);
    // After: the chain budget counts what the search was charged.
    const locked = await db.tx((t) => lockAgent(t, agent.id, g));
    const lane = { conversationId: g, lane: "own" as const, coversSeq: human + 1 };
    expect(await db.tx((t) => budgetReachedWith(t, lane, { ...locked, chainBudgetMicro: PRICE }, 0n, app.deps.config))).toBe(true);
    expect(await db.tx((t) => budgetReachedWith(t, lane, { ...locked, chainBudgetMicro: PRICE + 1n }, 0n, app.deps.config))).toBe(false);
    // Before: the next relay's search, 0.77035 charged + 0.77035 ≥ 1, is refused at the pre-hold.
    await agentSays(other.id, g, `@${agent.handle} 再查一下上海`);
    expect(await searchRun(worker, gateway, ["上海 天气"])).toEqual([{ error: WEB_LANE_BUDGET }]);
    expect(engine.queries).toEqual([QUERY]);
  });

  it("TOOLS.maxPoints: a provider model's searches count toward it too", async () => {
    const gateway = scriptedGateway();
    const engine = fakeEngine();
    const { worker } = webWorker(gateway, engine, webConfig({}, { maxPoints: 1 }));
    const { owner, own } = await owned("bgm", "provider");
    await say(owner, own, "天气？");
    const outs = await searchRun(worker, gateway, ["北京 天气", "上海 天气"]);
    expect(outs[0]).toMatchObject({ results: expect.any(Array) });
    expect(outs[1]).toEqual({ error: WEB_REPLY_CAP });
    expect(engine.queries).toEqual(["北京 天气"]);
    expect(metricLines("web_refused_reply_cap")).toHaveLength(1);
    expect([metricLines("web_refused_lane_budget"), metricLines("web_refused_no_points")]).toEqual([[], []]);
  });

  it("between rounds a provider model's reply counts its searches with its lane's budget: reached, the next call is its last", async () => {
    const gateway = scriptedGateway();
    const { owner, agent } = await owned("bge", "provider");
    expect((await api(app, owner, "PATCH", `/api/agents/${agent.id}`, { othersBudget: "1" })).status).toBe(200);
    const { g, mia } = await groupWith(owner, "bge", [agent.id]);
    // While the engine runs, another of its replies for someone else settles 0.3 points: 0.3 + 0.77035 ≥ 1.
    const engine = fakeEngine(async () => {
      await paidReply(db, { agentId: agent.id, ownerId: owner.id, conversationId: agent.conversationId, lane: "others", micro: 300_000n });
      return { results: RESULTS };
    });
    const { worker } = webWorker(gateway, engine);
    await say(mia, g, `@${agent.handle} 北京天气？`);
    await searchRun(worker, gateway);
    expect(gateway.calls[1]!.toolChoice).toBe("none");
    expect(gateway.calls[1]!.system.endsWith(FINAL_LINE)).toBe(true);
  });
});

describe("the pre-hold under the lane budgets, two connections", () => {
  /** A running reply of `agent` in `conversationId`, lane `lane`, admitted on its model (a provider's: no source yet). */
  async function admittedIn(ownerId: string, agent: Awaited<ReturnType<typeof meteredAgent>>, conversationId: string, lane: "own" | "others" | "proactive") {
    const { rows } = await db.query<{ id: string }>(
      `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, started_at, lane) values ('reply', $1, $2, $3, 'running', now(), $4) returning id`,
      [conversationId, agent.agentId, ownerId, lane],
    );
    await db.tx((t) => admitRun(t, webConfig(), rows[0]!.id, ownerId, agent.resolved, 10_000, new Date()));
    return rows[0]!.id;
  }
  /** `holdSearch` of run `runId` as port-impl.ts calls it, under `lockRun`'s locks; `gate`: waited for before commit. */
  const preHold = (r: { runId: string; ownerId: string; agentId: string; conversationId: string; lane: "own" | "others" | "proactive" }, over: Partial<Pick<AgentRow, "othersBudgetMicro" | "proactiveBudgetMicro">>, config: Config, gate?: { held: () => void; wait: Promise<void> }) =>
    db.tx(async (t) => {
      const locked = await lockAgent(t, r.agentId, r.conversationId);
      await t.query("select 1 from agent_runs where id = $1 for update", [r.runId]);
      const done = await holdSearch(t, config, { run: { id: r.runId, ownerId: r.ownerId, conversationId: r.conversationId }, agent: { ...locked, ...over }, lane: { lane: r.lane, coversSeq: 0 }, reserveMicro: 0n }, new Date());
      if (gate) {
        gate.held();
        await gate.wait;
      }
      return done;
    });
  const webOf = async (id: string) => (await db.query<{ n: number; m: string; c: string | null }>("select web_searches as n, web_micro::text as m, charge_to as c from agent_runs where id = $1", [id])).rows[0]!;

  for (const lane of ["others", "proactive"] as const) {
    it(`two replies of one Agent in two groups (lane ${lane}) racing for the last points of its daily budget: one gets them`, async () => {
      const owner = await signUp(app, `race${lane.slice(0, 3)}`);
      await grant(db, owner.id, 10n * POINT);
      const provider = (await api(app, owner, "POST", "/api/providers", providerBody({ models: [{ name: "own-1", contextTokens: 32000 }] }))).json;
      const agent = await meteredAgent(app, db, owner, { source: "provider", providerId: provider.id, model: "own-1" });
      const g1 = await group(app, owner, "一", [await signUp(app, `race${lane.slice(0, 3)}_a`), await signUp(app, `race${lane.slice(0, 3)}_c`)]);
      const g2 = await group(app, owner, "二", [await signUp(app, `race${lane.slice(0, 3)}_b`), await signUp(app, `race${lane.slice(0, 3)}_d`)]);
      const budget = lane === "others" ? { othersBudgetMicro: POINT } : { proactiveBudgetMicro: POINT };
      const a = { runId: await admittedIn(owner.id, agent, g1, lane), ownerId: owner.id, agentId: agent.agentId, conversationId: g1, lane };
      const b = { runId: await admittedIn(owner.id, agent, g2, lane), ownerId: owner.id, agentId: agent.agentId, conversationId: g2, lane };
      let held!: () => void;
      const heldNow = new Promise<void>((r) => (held = r));
      let release!: () => void;
      const wait = new Promise<void>((r) => (release = r));
      const first = preHold(a, budget, webConfig(), { held, wait });
      await heldNow;
      // B waits on the Agent's row A holds; once A has committed, B counts A's search (held, not settled yet).
      const second = preHold(b, budget, webConfig()).then(
        () => "held",
        (err: unknown) => (err instanceof SearchRefused ? err.why : String(err)),
      );
      await new Promise((r) => setTimeout(r, 100));
      release();
      await first;
      expect(await second).toBe(WEB_LANE_BUDGET);
      expect([await webOf(a.runId), await webOf(b.runId)]).toEqual([
        { n: 1, m: PRICE.toString(), c: "free" },
        { n: 0, m: "0", c: null },
      ]);
    });
  }

  it("a site model's reply nobody asked for: its proactive budget with the search at the pre-hold", async () => {
    const owner = await signUp(app, "bgsp");
    await grant(db, owner.id, 10n * POINT);
    const agent = await meteredAgent(app, db, owner, PAID);
    const g = await group(app, owner, "三", [await signUp(app, "bgsp_a"), await signUp(app, "bgsp_b")]);
    const r = { runId: await admittedIn(owner.id, agent, g, "proactive"), ownerId: owner.id, agentId: agent.agentId, conversationId: g, lane: "proactive" as const };
    // Its first call held 2 points: 2 + 0.77035 ≥ 2.5 — refused; ≥ 3 is not reached — held.
    await expect(preHold(r, { proactiveBudgetMicro: 2_500_000n }, webConfig())).rejects.toMatchObject({ by: "lane_budget" });
    await preHold(r, { proactiveBudgetMicro: 3n * POINT }, webConfig());
    expect((await webOf(r.runId)).n).toBe(1);
  });

  it("a provider model's reply: refused (unavailable) only when it is not admitted; its source kept for its next search", async () => {
    const owner = await signUp(app, "pvsrc");
    await grant(db, owner.id, 10n * POINT);
    const provider = (await api(app, owner, "POST", "/api/providers", providerBody({ models: [{ name: "own-1", contextTokens: 32000 }] }))).json;
    const agent = await meteredAgent(app, db, owner, { source: "provider", providerId: provider.id, model: "own-1" });
    const r = { runId: await admittedIn(owner.id, agent, agent.conversationId, "own"), ownerId: owner.id, agentId: agent.agentId, conversationId: agent.conversationId, lane: "own" as const };
    await preHold(r, {}, webConfig());
    expect(await webOf(r.runId)).toEqual({ n: 1, m: PRICE.toString(), c: "free" });
    // The allowance now used up beside its hold: the next search stays on its source and is refused (not moved to the balance).
    await setFreeUsed(owner.id, FREE_DAY - 2n * PRICE + 1n);
    await expect(preHold(r, {}, webConfig())).rejects.toMatchObject({ by: "no_points" });
    expect(await webOf(r.runId)).toEqual({ n: 1, m: PRICE.toString(), c: "free" });
    // A run not admitted yet has no model to pay beside: unavailable.
    const { rows } = await db.query<{ id: string }>(
      `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, started_at) values ('reply', $1, $2, $3, 'running', now()) returning id`,
      [await group(app, owner, "四", [await signUp(app, "pvsrc_a"), await signUp(app, "pvsrc_b")]), agent.agentId, owner.id],
    );
    const lone = { ...r, runId: rows[0]!.id };
    await expect(db.tx(async (t) => holdSearch(t, webConfig(), { run: { id: lone.runId, ownerId: owner.id, conversationId: agent.conversationId }, agent: await lockAgent(t, agent.agentId, agent.conversationId), lane: { lane: "own", coversSeq: 0 }, reserveMicro: 0n }, new Date()))).rejects.toMatchObject({ by: "unavailable" });
  });
});

describe("the site's money fuse (the operator's cost insurance)", () => {
  // $0.024 a day at $0.002 a search: 12 searches.
  const fused = (over: Partial<WebSearchConfig> = {}) => webConfig({ siteUsdPerDay: 0.024, costMicroUsdPerSearch: 2000, ...over });

  it("past the day's money (crossing 10): refused before the engine, nothing charged; one line at 80 %", async () => {
    const gateway = scriptedGateway();
    const engine = fakeEngine();
    const { worker } = webWorker(gateway, engine, fused());
    await setSiteCount(8);
    const a = await owned("fza");
    for (let n = 9; n <= 12; n++) {
      await say(a.owner, a.own, `第${n}次`);
      expect((await searchRun(worker, gateway))[0]).toMatchObject({ results: expect.any(Array) });
      expect(await siteCount()).toBe(n);
      // 80 %: 10 × $0.002 ≥ 0.8 × $0.024 at the 10th, and only then.
      expect(metricLines("web_site_fuse").map((l) => l.share)).toEqual(n < 10 ? [] : [80]);
    }
    const b = await owned("fzb");
    await say(b.owner, b.own, "天气？");
    expect(await searchRun(worker, gateway)).toEqual([{ error: WEB_SITE_DAY }]);
    expect(engine.queries).toHaveLength(4);
    expect(await siteCount()).toBe(12);
    const run = await lastRun(b.agent.id);
    expect([run.web_searches, (await recordOf(run.id)).web_micro]).toEqual([0, "0"]);
    expect(metricLines("web_site_fuse")).toHaveLength(1);
    // Each search the fuse refuses: a count for the operator.
    expect(metricLines("web_site_fuse_refused")).toHaveLength(1);
  });

  it("fed by what the engine says a call cost (Exa's costDollars): the estimate held at call time, replaced by the actual; absent, the estimate stands", async () => {
    // At Exa's default estimate of $0.013 only one search fits $0.024 — but each really costs $0.0081, so two do, and then
    // a third does not (0.0162 + 0.013 > 0.024).
    const gateway = scriptedGateway();
    let cost: bigint | undefined = 8100n;
    const engine: WebEngine & { queries: string[] } = {
      name: "fake",
      queries: [],
      async searchWeb(query) {
        engine.queries.push(query);
        return cost === undefined ? { results: RESULTS } : { results: RESULTS, costMicroUsd: cost };
      },
    };
    const { worker } = webWorker(gateway, engine, webConfig({ siteUsdPerDay: 0.024, costMicroUsdPerSearch: 13_000 }));
    const a = await owned("fzr");
    for (const [n, spent] of [
      [1, 8100n],
      [2, 16_200n],
    ] as const) {
      await say(a.owner, a.own, `第${n}次`);
      expect((await searchRun(worker, gateway))[0]).toMatchObject({ results: expect.any(Array) });
      expect(await siteSpent()).toBe(spent);
    }
    await say(a.owner, a.own, "第3次");
    expect(await searchRun(worker, gateway)).toEqual([{ error: WEB_SITE_DAY }]);
    expect(engine.queries).toHaveLength(2);
    // The engine saying nothing of its cost: the estimate stays in the day's money.
    // As a new day would start: nothing spent, the 80 % line not said yet.
    await db.query("update web_search_days set spent_micro_usd = 0, searches = 0, warned_80 = false where scope = $1", [SITE_SCOPE]);
    cost = undefined;
    await say(a.owner, a.own, "第4次");
    await searchRun(worker, gateway);
    expect(await siteSpent()).toBe(13_000n);
    // An actual above the estimate raises it, and says 80 % when that crosses it.
    // As a new day would start: nothing spent, the 80 % line not said yet.
    await db.query("update web_search_days set spent_micro_usd = 0, searches = 0, warned_80 = false where scope = $1", [SITE_SCOPE]);
    cost = 20_000n;
    lines.length = 0;
    await say(a.owner, a.own, "第5次");
    await searchRun(worker, gateway);
    expect(await siteSpent()).toBe(20_000n);
    expect(metricLines("web_site_fuse").map((l) => l.share)).toEqual([80]);
  });

  it("two owners racing for the fuse's last search: one gets it, the other's hold is given back", async () => {
    const first = await owned("fzc");
    const second = await owned("fzd");
    const run = async (o: Awaited<ReturnType<typeof owned>>) => {
      const agent = await meteredAgent(app, db, o.owner, PAID);
      const { rows } = await db.query<{ id: string }>(
        `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, started_at) values ('reply', $1, $2, $3, 'running', now()) returning id`,
        [agent.conversationId, agent.agentId, o.owner.id],
      );
      await db.tx((t) => admitRun(t, fused(), rows[0]!.id, o.owner.id, agent.resolved, 10_000, new Date()));
      return { runId: rows[0]!.id, ownerId: o.owner.id, agentId: agent.agentId, conversationId: agent.conversationId };
    };
    const ra = await run(first);
    const rb = await run(second);
    await setSiteCount(11);
    const pre = (r: typeof ra, gate?: { held: () => void; wait: Promise<void> }) =>
      db.tx(async (t) => {
        const locked = await lockAgent(t, r.agentId, r.conversationId);
        await t.query("select 1 from agent_runs where id = $1 for update", [r.runId]);
        const done = await holdSearch(t, fused(), { run: { id: r.runId, ownerId: r.ownerId, conversationId: r.conversationId }, agent: locked, lane: { lane: "own", coversSeq: 0 }, reserveMicro: 0n }, new Date());
        if (gate) {
          gate.held();
          await gate.wait;
        }
        return done;
      });
    let held!: () => void;
    const heldNow = new Promise<void>((r) => (held = r));
    let release!: () => void;
    const wait = new Promise<void>((r) => (release = r));
    const a = pre(ra, { held, wait });
    await heldNow;
    const b = pre(rb).then(
      () => "held",
      (err: unknown) => (err instanceof SearchRefused ? err.why : String(err)),
    );
    await new Promise((r) => setTimeout(r, 100));
    release();
    // 22 000 of 24 000 already (the row set so): this is the day's first search past 80 %, which marks it.
    expect(await a).toMatchObject({ at80: true, estimateMicroUsd: 2000n });
    expect(await b).toBe(WEB_SITE_DAY);
    expect(await siteCount()).toBe(12);
    const holds = await db.query<{ id: string; hold: string; n: number }>("select id, hold_micro::text as hold, web_searches as n from agent_runs where id = any($1::uuid[])", [[ra.runId, rb.runId]]);
    const byId = new Map(holds.rows.map((h) => [h.id, h]));
    expect([byId.get(ra.runId)!.n, byId.get(rb.runId)!.n]).toEqual([1, 0]);
    expect(BigInt(byId.get(ra.runId)!.hold) - BigInt(byId.get(rb.runId)!.hold)).toBe(PRICE);
  });
});

describe("the guard in every lane: the owner's own words, and only theirs", () => {
  it("someone else's call carrying the owner's note is refused — their words are not the owner's —, the owner's own call with them is not; a reply nobody asked for and a relay are guarded too", async () => {
    const gateway = scriptedGateway();
    const engine = fakeEngine();
    const { worker } = webWorker(gateway, engine);
    const { owner, agent } = await owned("gde");
    await db.query("insert into agent_notes (agent_id, text, vault) values ($1, $2, false)", [agent.id, "主人住在北京市海淀区中关村南大街五号"]);
    const other = await mustCreateAgent(app, owner, { handle: "gde_two", name: "另一个", model: PAID, persona: "简短。" });
    const { g, mia } = await groupWith(owner, "gde", [agent.id, other.id]);
    const query = "海淀区中关村南大街 美食";
    await say(mia, g, `@${agent.handle} 海淀区中关村南大街附近有什么好吃的？`);
    expect(await searchRun(worker, gateway, [query])).toEqual([{ error: WEB_QUERY_PRIVATE }]);
    expect((await lastRun(agent.id)).lane).toBe("others");
    await proactiveRun(agent.id, owner.id, g, mia);
    expect(await searchRun(worker, gateway, [query])).toEqual([{ error: WEB_QUERY_PRIVATE }]);
    await agentSays(other.id, g, `@${agent.handle} 海淀区中关村南大街附近有什么好吃的？`);
    expect(await searchRun(worker, gateway, [query])).toEqual([{ error: WEB_QUERY_PRIVATE }]);
    expect((await lastRun(agent.id)).triggered_by).toBe("agent");
    expect(engine.queries).toEqual([]);
    await say(owner, g, `@${agent.handle} 海淀区中关村南大街附近有什么好吃的？`);
    expect((await searchRun(worker, gateway, [query]))[0]).toMatchObject({ results: expect.any(Array) });
    expect(engine.queries).toEqual([query]);
  });
});

describe("what people see of the price", () => {
  it("the words a lane budget's refusal hands the model say nothing of the owner or of a cap (re-review N1); its own metric stays", () => {
    expect(WEB_LANE_BUDGET).toBe("这次回复不能再联网搜索了。");
    expect(WEB_LANE_BUDGET).not.toMatch(/主人|上限|点数/);
  });

  it("about the price: one decimal at most, no trailing zero; at least 0.1 for a price above 0", () => {
    expect([770_350n, 1_000_000n, 1_250_000n, 1_240_000n, 50_000n, 40_000n, 1n, 0n, 12_000_000n].map(aboutPoints)).toEqual(["0.8", "1", "1.3", "1.2", "0.1", "0.1", "0.1", "0", "12"]);
  });
});

describe("fix round 1 (review websearch2-review.md)", () => {
  /** The app's own configuration with the web search on and nothing else changed: what ships (Exa, 13 points a search). */
  const shipped = (): Config => ({ ...app.deps.config, tools: { ...app.deps.config.tools, web: { ...app.deps.config.tools.web, enabled: true } } });
  /** A running reply of `agent` in `conversationId`, lane `lane`, admitted on its model. */
  async function running(ownerId: string, agent: Awaited<ReturnType<typeof meteredAgent>>, conversationId: string, lane: "own" | "others" | "proactive", config: Config) {
    const { rows } = await db.query<{ id: string }>(
      `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, started_at, lane) values ('reply', $1, $2, $3, 'running', now(), $4) returning id`,
      [conversationId, agent.agentId, ownerId, lane],
    );
    await db.tx((t) => admitRun(t, config, rows[0]!.id, ownerId, agent.resolved, 10_000, new Date()));
    return { runId: rows[0]!.id, ownerId, agentId: agent.agentId, conversationId, lane };
  }
  type Running = Awaited<ReturnType<typeof running>>;
  /** `holdSearch` of `r` under `lockRun`'s locks, with the Agent's own budgets as stored; `gate`: waited for before commit. */
  const pre = (r: Running, config: Config, gate?: { held: () => void; wait: Promise<void> }) =>
    db.tx(async (t) => {
      const locked = await lockAgent(t, r.agentId, r.conversationId);
      await t.query("select 1 from agent_runs where id = $1 for update", [r.runId]);
      const held = await holdSearch(t, config, { run: { id: r.runId, ownerId: r.ownerId, conversationId: r.conversationId }, agent: locked, lane: { lane: r.lane, coversSeq: 0 }, reserveMicro: 0n }, new Date());
      if (gate) {
        gate.held();
        await gate.wait;
      }
      return held;
    });
  /** `r` settled as done and ended, as `finish` would. */
  const ended = async (r: Running, config: Config) => {
    await db.tx((t) => settle(t, config, r.runId, null, { inputChars: 0, outputChars: 0 }, "done", new Date(), { log: app.log }));
    await db.query("update agent_runs set status = 'done', finished_at = now() where id = $1", [r.runId]);
  };
  /** A new Agent of `owner` on their provider's model (the provider added at the first call for that owner). */
  const providers = new Map<string, string>();
  const providerOf = async (owner: Actor) => {
    if (!providers.has(owner.id)) providers.set(owner.id, (await api(app, owner, "POST", "/api/providers", providerBody({ models: [{ name: "own-1", contextTokens: 32000 }] }))).json.id);
    return meteredAgent(app, db, owner, { source: "provider", providerId: providers.get(owner.id)!, model: "own-1" });
  };
  const gated = () => {
    let held!: () => void;
    const heldNow = new Promise<void>((r) => (held = r));
    let release!: () => void;
    const wait = new Promise<void>((r) => (release = r));
    return { gate: { held, wait }, heldNow, release };
  };

  it("at the shipped defaults (13 points a search, TOOLS.maxPoints 20, others' and proactive budgets 20): one search a reply, one a day in each of those lanes (review I1: a change of any of the numbers shows here)", async () => {
    const config = shipped();
    expect([config.tools.web.pointsMicroPerSearch, config.tools.maxPoints, config.tools.web.perReply]).toEqual([13_000_000, 20, 3]);
    const owner = await signUp(app, "dflta");
    await grant(db, owner.id, 200n * POINT);
    const agent = await providerOf(owner);
    const view = (await api(app, owner, "GET", `/api/agents/${agent.agentId}`)).json;
    expect([view.othersBudget, view.proactiveBudget, view.chainBudget]).toEqual(["20", "20", "50"]);
    // A provider model's reply: 13 ≤ 20, then 26 > 20 — its own bound, though perReply is 3.
    const own = await running(owner.id, agent, agent.conversationId, "own", config);
    await pre(own, config);
    await expect(pre(own, config)).rejects.toMatchObject({ by: "reply_cap" });
    // A site model's reply holding 2 points for its first call: 15, then 28 > 20.
    const site = await meteredAgent(app, db, owner, PAID);
    const siteRun = await running(owner.id, site, site.conversationId, "own", config);
    await pre(siteRun, config);
    await expect(pre(siteRun, config)).rejects.toMatchObject({ by: "reply_cap" });
    // Someone else's calls, and replies nobody asked for, a day: the first search settled (13 of 20), the next one's 26 ≥ 20.
    for (const lane of ["others", "proactive"] as const) {
      const g1 = await group(app, owner, `${lane}一`, [await signUp(app, `dflt${lane.slice(0, 2)}a`), await signUp(app, `dflt${lane.slice(0, 2)}b`)]);
      const g2 = await group(app, owner, `${lane}二`, [await signUp(app, `dflt${lane.slice(0, 2)}c`), await signUp(app, `dflt${lane.slice(0, 2)}d`)]);
      const first = await running(owner.id, agent, g1, lane, config);
      await pre(first, config);
      await ended(first, config);
      await expect(pre(await running(owner.id, agent, g2, lane, config), config)).rejects.toMatchObject({ by: "lane_budget" });
    }
  });

  it("two provider-model replies of one owner racing for the last of the free allowance at their first search: one takes it, the other finds the balance or nothing", async () => {
    const owner = await signUp(app, "pvrace");
    const a = await providerOf(owner);
    const b = await providerOf(owner);
    await setFreeUsed(owner.id, FREE_DAY - (3n * PRICE) / 2n);
    const config = webConfig();
    const ra = await running(owner.id, a, a.conversationId, "own", config);
    const rb = await running(owner.id, b, b.conversationId, "own", config);
    const { gate, heldNow, release } = gated();
    const first = pre(ra, config, gate);
    await heldNow;
    const second = pre(rb, config).then(
      () => "held",
      (err: unknown) => (err instanceof SearchRefused ? err.by : String(err)),
    );
    await new Promise((r) => setTimeout(r, 100));
    release();
    await first;
    // B waited on the owner's account; it then saw A's hold on what was left of the allowance, and there is no balance.
    expect(await second).toBe("no_points");
    const of = async (id: string) => (await db.query<{ c: string | null; n: number }>("select charge_to as c, web_searches as n from agent_runs where id = $1", [id])).rows[0]!;
    expect([await of(ra.runId), await of(rb.runId)]).toEqual([
      { c: "free", n: 1 },
      { c: null, n: 0 },
    ]);
    await grant(db, owner.id, POINT);
    await pre(rb, config);
    expect(await of(rb.runId)).toEqual({ c: "balance", n: 1 });
  });

  it("a price of 0: a provider model's search runs (its source kept with no charge); a fuse of 0: web search is not offered at all (review M1)", async () => {
    const gateway = scriptedGateway();
    const engine = fakeEngine();
    const { worker } = webWorker(gateway, engine, webConfig({ pointsMicroPerSearch: 0 }));
    const { owner, agent, own } = await owned("zeroa", "provider", 0n);
    await say(owner, own, "天气？");
    expect((await searchRun(worker, gateway))[0]).toMatchObject({ results: expect.any(Array) });
    const run = await lastRun(agent.id);
    expect([run.status, run.charge_to, run.web_searches, run.web_micro]).toEqual(["done", "free", 1, "0"]);
    expect(await recordOf(run.id)).toMatchObject({ web_searches: 1, free: "0", balance: "0", cost: "0" });
    const said: string[] = [];
    const log = { info: (d: object) => said.push(JSON.stringify(d)), warn: (d: object) => said.push(JSON.stringify(d)) };
    process.env.WEB_SEARCH_API_KEY_ZERO_FUSE = "not-a-real-key";
    try {
      expect(webEngineOf(webConfig({ siteUsdPerDay: 0, apiKeyEnv: "WEB_SEARCH_API_KEY_ZERO_FUSE" }), log)).toBeNull();
      expect(said).toEqual([JSON.stringify({ metric: "web_search_off", siteUsdPerDay: 0 })]);
      expect(webEngineOf(webConfig({ siteUsdPerDay: 0.01, apiKeyEnv: "WEB_SEARCH_API_KEY_ZERO_FUSE" }), log)?.name).toBe("exa_search");
    } finally {
      delete process.env.WEB_SEARCH_API_KEY_ZERO_FUSE;
    }
  });

  it("an engine's cost report from a tenth to ten times the estimate is believed; beyond, the estimate stands and a metric says so (review M2)", async () => {
    const gateway = scriptedGateway();
    let cost = 100n;
    const engine: WebEngine & { queries: string[] } = {
      name: "fake",
      queries: [],
      async searchWeb(query) {
        engine.queries.push(query);
        return { results: RESULTS, costMicroUsd: cost };
      },
    };
    const { worker } = webWorker(gateway, engine, webConfig({ costMicroUsdPerSearch: 13_000 }));
    const a = await owned("trusta");
    for (const [n, report, spent, ignored] of [
      [1, 100n, 13_000n, 1],
      [2, 200_000n, 26_000n, 2],
      [3, 1300n, 27_300n, 2],
      [4, 130_000n, 157_300n, 2],
    ] as const) {
      cost = report;
      await say(a.owner, a.own, `第${n}次`);
      await searchRun(worker, gateway);
      expect([n, await siteSpent(), metricLines("web_cost_ignored").length]).toEqual([n, spent, ignored]);
    }
  });

  it("the 80 % line comes once a site day, whatever corrections come after (review M3)", async () => {
    // A fuse of $0.05 (80 %: $0.04) at an estimate of $0.013: 0 → 30 000; then 43 000 (crossed: said), corrected down to
    // 35 000; then 48 000 (crossed again: not said again).
    const gateway = scriptedGateway();
    let cost = 30_000n;
    const engine: WebEngine & { queries: string[] } = {
      name: "fake",
      queries: [],
      async searchWeb(query) {
        engine.queries.push(query);
        return { results: RESULTS, costMicroUsd: cost };
      },
    };
    const { worker } = webWorker(gateway, engine, webConfig({ costMicroUsdPerSearch: 13_000, siteUsdPerDay: 0.05 }));
    const a = await owned("onceb");
    for (const [n, report, spent, said] of [
      [1, 30_000n, 30_000n, 0],
      [2, 5_000n, 35_000n, 1],
      [3, 13_000n, 48_000n, 1],
    ] as const) {
      cost = report;
      await say(a.owner, a.own, `第${n}次`);
      await searchRun(worker, gateway);
      expect([n, await siteSpent(), metricLines("web_site_fuse").length]).toEqual([n, spent, said]);
    }
  });

  it("in a group the owner's own earlier line exempts nothing of someone else's call: only the owner's own call is theirs to search (review M6)", async () => {
    const gateway = scriptedGateway();
    const engine = fakeEngine();
    const { worker } = webWorker(gateway, engine);
    const { owner, agent } = await owned("gdf");
    await db.query("insert into agent_notes (agent_id, text, vault) values ($1, $2, false)", [agent.id, "主人住在北京市海淀区中关村南大街五号"]);
    const { g, mia } = await groupWith(owner, "gdf", [agent.id]);
    const query = "海淀区中关村南大街 美食";
    await say(owner, g, "我就住海淀区中关村南大街那边");
    await say(mia, g, `@${agent.handle} 那附近有什么好吃的？`);
    expect(await searchRun(worker, gateway, [query])).toEqual([{ error: WEB_QUERY_PRIVATE }]);
    expect(engine.queries).toEqual([]);
    await say(owner, g, `@${agent.handle} 海淀区中关村南大街附近有什么好吃的？`);
    expect((await searchRun(worker, gateway, [query]))[0]).toMatchObject({ results: expect.any(Array) });
    expect(engine.queries).toEqual([query]);
  });

  it("a pre-hold that answers anything but what the fuse held is a refusal: the engine is never called", async () => {
    const engine = fakeEngine();
    const { owner, agent, own } = await owned("notheld");
    const deps = { engine, slots: createSlots(4, 4), config: { maxResults: 6, siteUsdPerDay: 20 }, resultMaxWeight: 3000, timeZone: "Asia/Shanghai", db, log: { info: () => {}, warn: () => {} } };
    const scope = (answer: unknown) => ({ id: "run-y", agentId: agent.id, ownerId: owner.id, conversationId: own, group: false, refs: new RunRefs({}, true), heardTo: 0, mark: null, shown: [], ownerAsked: true, holdSearch: async () => answer as never });
    for (const answer of [undefined, null, 0, {}, { day: 1 }]) {
      expect((await searchWebTool(deps, scope(answer), { query: QUERY }, new AbortController().signal)).output).toEqual({ error: "联网搜索暂时用不了。" });
    }
    expect((await searchWebTool(deps, scope("点数不够。"), { query: QUERY }, new AbortController().signal)).output).toEqual({ error: "点数不够。" });
    expect(engine.queries).toEqual([]);
  });

  it("the engine's cost that cannot be written keeps the estimate in the fuse and says so with its code only (review M10)", async () => {
    const said: string[] = [];
    const log = { info: (d: object, m: string) => said.push(JSON.stringify({ d, m })), warn: (d: object, m: string) => said.push(JSON.stringify({ d, m })), error: () => {} };
    const failing = { query: db.query.bind(db), tx: async () => Promise.reject(Object.assign(new Error("the database went away"), { code: "08006" })) } as unknown as typeof db;
    const { owner, agent, own } = await owned("costfail");
    const engine = fakeEngine(() => ({ results: RESULTS, costMicroUsd: 5000n }) as never);
    const out = await searchWebTool(
      { engine, slots: createSlots(4, 4), config: { maxResults: 6, siteUsdPerDay: 20 }, resultMaxWeight: 3000, timeZone: "Asia/Shanghai", db: failing, log },
      { id: "run-x", agentId: agent.id, ownerId: owner.id, conversationId: own, group: false, refs: new RunRefs({}, true), heardTo: 0, mark: null, shown: [], ownerAsked: true, holdSearch: async () => ({ day: "2026-11-22", estimateMicroUsd: 13_000n, at80: false }) },
      { query: QUERY },
      new AbortController().signal,
    );
    expect(out.output).toMatchObject({ results: expect.any(Array) });
    const line = said.find((l) => l.includes("web_site_cost_unrecorded"));
    expect(line && JSON.parse(line).d).toEqual({ metric: "web_site_cost_unrecorded", code: "08006" });
    expect(said.join("")).not.toMatch(/went away|北京|example\.com/);
  });
});