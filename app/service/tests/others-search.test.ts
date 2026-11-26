import { afterEach, describe, expect, it } from "vitest";
import { createToolbox, SEARCH_WEB } from "../src/agents/tools/index.ts";
import type { WebEngine, WebResult } from "../src/agents/tools/web/engine.ts";
import { holdSearch, SearchRefused } from "../src/agents/tools/web/hold.ts";
import { WEB_LANE_BUDGET } from "../src/agents/tools/web/tool.ts";
import { lockAgent } from "../src/agents/store.ts";
import type { Config } from "../src/config.ts";
import type { ModelCall, ModelGateway } from "../src/models/gateway.ts";
import { api, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent } from "./helpers/agents.ts";
import { providerBody } from "./helpers/providers.ts";
import { useApp } from "./helpers/harness.ts";
import { grant, paidReply, type MeteredAgent } from "./helpers/metering.ts";
import { agentsOf, NOON, OTHERS_ENV, POINT, seedRun, setOwnerLimit } from "./helpers/others.ts";
import { othersKitchen } from "./helpers/others-kitchen.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { closeAllSockets } from "./helpers/ws.ts";

/**
 * Lane B, B3 (plan): an owner's others' points counted at the web search's pre-hold, the run's own hold included (D19: the
 * model part of the reply is counted before the lane's number, as `tools/web/hold.ts` counts it today), under the account lock;
 * the round raises nothing; the triggers' early check counts what is held too. The price of a search is 0.77 points here.
 */

const lines: string[] = [];
const { app, db } = useApp({ env: { ...OTHERS_ENV, AGENT_RUNS_PER_MINUTE: "100" }, agentWorker: false, logStream: { write: (line) => void lines.push(line) } });
afterEach(async () => {
  await closeAllSockets();
  lines.length = 0;
});
const metric = (name: string) => lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((e) => e.metric === name);

const PRICE = 770_000n;
const webConfig = (): Config => ({
  ...app.deps.config,
  tools: { ...app.deps.config.tools, web: { ...app.deps.config.tools.web, enabled: true, pointsMicroPerSearch: Number(PRICE) } },
});

let n = 0;
const newOwner = async (): Promise<Actor> => {
  const owner = await signUp(app, `os${++n}x${Math.floor(Math.random() * 1e6)}`);
  await grant(db, owner.id, 10_000n * POINT);
  return owner;
};

/** `holdSearch` of `run` as port-impl.ts calls it, under `lockRun`'s locks; `gate`: waited for before commit. */
const preHold = (r: { runId: string; ownerId: string; agent: MeteredAgent; lane: "others" | "proactive" }, gate?: { held: () => void; wait: Promise<void> }) =>
  db.tx(async (t) => {
    const locked = await lockAgent(t, r.agent.agentId, r.agent.conversationId);
    await t.query("select 1 from agent_runs where id = $1 for update", [r.runId]);
    const done = await holdSearch(
      t,
      webConfig(),
      { run: { id: r.runId, ownerId: r.ownerId, conversationId: r.agent.conversationId }, agent: locked, lane: { lane: r.lane, coversSeq: 0 }, reserveMicro: 0n },
      NOON,
    );
    if (gate) {
      gate.held();
      await gate.wait;
    }
    return done;
  });
const webOf = async (id: string) => (await db.query<{ n: number }>("select web_searches as n from agent_runs where id = $1", [id])).rows[0]!;
const refusal = (p: Promise<unknown>) =>
  p.then(
    () => "held",
    (err: unknown) => (err instanceof SearchRefused ? err.by : String(err)),
  );

describe("the pre-hold under the owner's number", () => {
  for (const lane of ["others", "proactive"] as const) {
    it(`only what is used counts (lane ${lane}): 19.9 settled, with the run's own hold of 8.387 and the search's 0.77 beside it, is held below 20; at 20 settled it is refused`, async () => {
      for (const [settled, expected] of [
        [19_900_000n, "held"],
        [20_000_000n, "lane_budget"],
      ] as const) {
        const owner = await newOwner();
        const [a, b] = await agentsOf(app, db, owner, 2);
        await setOwnerLimit(db, owner.id, 20n * POINT);
        await paidReply(db, { agentId: b!.agentId, ownerId: owner.id, conversationId: b!.conversationId, lane: "others", micro: settled, at: NOON });
        const run = await seedRun(db, { ownerId: owner.id, agent: a!, lane, hold: 8_387_000n, admittedAt: NOON });
        expect([settled, await refusal(preHold({ runId: run, ownerId: owner.id, agent: a!, lane }))]).toEqual([settled, expected]);
        expect((await webOf(run)).n).toBe(expected === "held" ? 1 : 0);
      }
    });
  }

  it("another running reply's hold does not count either, a proactive one beside an others' one", async () => {
    const owner = await newOwner();
    const [a, b] = await agentsOf(app, db, owner, 2);
    await setOwnerLimit(db, owner.id, 20n * POINT);
    const mine = await seedRun(db, { ownerId: owner.id, agent: a!, lane: "others", hold: 8_387_000n, admittedAt: NOON });
    await seedRun(db, { ownerId: owner.id, agent: b!, lane: "proactive", hold: 10_900_000n, admittedAt: NOON });
    // 8.387 + 10.9 held, and a search of 0.77: 20.057, but nothing of it is used yet.
    expect(await refusal(preHold({ runId: mine, ownerId: owner.id, agent: a!, lane: "others" }))).toBe("held");
  });
});

/** A fake web engine: three results, every query recorded. */
function fakeEngine() {
  const queries: string[] = [];
  const results: WebResult[] = [1, 2, 3].map((i) => ({ url: `https://news${i}.example.com/a/${i}`, title: `新闻标题${i}`, snippet: `摘要内容${i}`, age: "2026-11-20T08:00:00Z" }));
  const engine: WebEngine & { queries: string[] } = {
    name: "fake",
    queries,
    async searchWeb(query) {
      queries.push(query);
      return { results };
    },
  };
  return engine;
}

describe("a reply whose search is refused by its owner's number", () => {
  it("goes on without the search and posts: the engine is not called, the model is told, the last call follows", async () => {
    const engine = fakeEngine();
    const config = webConfig();
    const { db: pool, blobs, searches } = app.deps;
    const box = createToolbox({ db: pool, blobs, searches, config, log: app.log, webEngine: engine });
    const inner = scriptedGateway().callTools([{ name: SEARCH_WEB, input: { query: "上海 天气" } }], { usage: { inputTokens: 900, outputTokens: 40 } }).reply("查不了，凭印象说。", { usage: { inputTokens: 1200, outputTokens: 20 } });
    let conv = "";
    const ctx = { owner: "", agent: "", own: "" };
    let first = true;
    // On its first request, others' use of the owner's Agents is brought to the owner's number: its search is refused.
    const gateway = Object.create(inner) as ModelGateway & typeof inner;
    gateway.stream = ((call: ModelCall) => {
      const events = inner.stream(call);
      return (async function* () {
        if (first) {
          first = false;
          const hold = BigInt((await db.query<{ h: string }>("select hold_micro::text as h from agent_runs where conversation_id = $1 order by created_at desc limit 1", [conv])).rows[0]!.h);
          expect(hold).toBeGreaterThan(0n);
          await paidReply(db, { agentId: ctx.agent, ownerId: ctx.owner, conversationId: ctx.own, lane: "others", micro: 300n * POINT });
        }
        yield* events;
      })();
    }) as ModelGateway["stream"];
    const k = await othersKitchen(app, db, { box, config, gateway, onGroup: (g) => void (conv = g) });
    Object.assign(ctx, { owner: k.owner.id, agent: k.agent.id, own: k.agent.conversationId as string });
    await k.ask("@chef 上海天气怎么样？");
    expect(await k.worker.runOnce()).toBe(true);
    expect(engine.queries).toEqual([]);
    const second = inner.calls[1]!;
    expect(second.steps?.flatMap((s) => s.results.map((r) => r.output))).toEqual([{ error: WEB_LANE_BUDGET }]);
    expect(await k.posted()).toEqual(["查不了，凭印象说。"]);
    expect(await k.lastRun()).toMatchObject({ status: "done", hold: "0" });
    expect(metric("web_refused_lane_budget")).toHaveLength(1);
  });
});

describe("the triggers' early check", () => {
  it("an Agent on its owner's own provider key is refused at the trigger as the site-model Agent beside it is: one number for all the owner's Agents", async () => {
    const k = await othersKitchen(app, db, { box: undefined });
    await setOwnerLimit(db, k.owner.id, 5n * POINT);
    await paidReply(db, { agentId: k.agent.id, ownerId: k.owner.id, conversationId: k.g, lane: "others", micro: 9n * POINT });
    const provider = (await api(app, k.owner, "POST", "/api/providers", providerBody({ models: [{ name: "mine" }] }))).json;
    const byok = await mustCreateAgent(app, k.owner, { handle: "byok", name: "byok", model: { source: "provider", providerId: provider.id as string, model: "mine" }, persona: "简短。" });
    await db.query("insert into memberships (conversation_id, principal_id, role, joined_seq) select $1, $2, 'speaker', seq from conversations where id = $1", [k.g, byok.id]);
    const queued = async () => (await db.query("select 1 from agent_runs where conversation_id = $1 and status = 'queued'", [k.g])).rowCount;
    await k.ask("@byok 你好");
    expect(await queued()).toBe(0);
    await k.ask("@chef 你好");
    expect(await queued()).toBe(0);
    // The owner is told once.
    await expect.poll(() => k.notices()).toBe(1);
  });

  it("a member's call after others' use has reached the owner's number is not called; what running replies hold does not count; the owner is told once that site day; the owner's own call is never refused", async () => {
    const k = await othersKitchen(app, db, { box: undefined });
    await setOwnerLimit(db, k.owner.id, 20n * POINT);
    // 12 points settled and 8 held by a running reply of another Agent: not reached (a hold is not used).
    await paidReply(db, { agentId: k.agent.id, ownerId: k.owner.id, conversationId: k.g, lane: "others", micro: 12n * POINT });
    const other = (await agentsOf(app, db, k.owner, 1))[0]!;
    await seedRun(db, { ownerId: k.owner.id, agent: other, lane: "others", hold: 8n * POINT, admittedAt: new Date() });
    await k.ask();
    expect((await db.query("select 1 from agent_runs where conversation_id = $1 and status = 'queued'", [k.g])).rowCount).toBe(1);
    await db.query("update agent_runs set status = 'done', hold_micro = 0, finished_at = now() where owner_id = $1 and status in ('queued', 'running')", [k.owner.id]);
    // Now 20 are used: that reply has ended, and what it held is settled.
    await paidReply(db, { agentId: k.agent.id, ownerId: k.owner.id, conversationId: k.g, lane: "others", micro: 8n * POINT });
    await k.ask("@chef 还在吗");
    expect((await db.query("select 1 from agent_runs where conversation_id = $1 and status = 'queued'", [k.g])).rowCount).toBe(0);
    await expect.poll(() => k.notices()).toBe(1);
    await k.ask("@chef 再问一次");
    expect((await db.query("select 1 from agent_runs where conversation_id = $1 and status = 'queued'", [k.g])).rowCount).toBe(0);
    expect(await k.notices()).toBe(1);
    await k.askAsOwner();
    expect((await k.lastRun()).lane).toBe("own");
  });
});
