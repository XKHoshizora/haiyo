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
import { agentsOf, NOON, OTHERS_ENV, POINT, seedRun, setOwnerNumbers } from "./helpers/others.ts";
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

/** The owner's number `points`, and no Agent's own number in the way. */
async function numberOf(owner: Actor, points: bigint, agents: MeteredAgent[]): Promise<void> {
  await setOwnerNumbers(db, owner.id, { pointsMicro: points * POINT });
  for (const a of agents) await db.query("update agents set others_budget_micro = null where principal_id = $1", [a.agentId]);
}

describe("the pre-hold under the owner's number", () => {
  it("the run's own hold counts: 10 settled + its own 8.387 + a search of 0.77 = 19.157 is held within 20; at 11 settled it is 20.157, refused", async () => {
    for (const [settled, expected] of [
      [10n, "held"],
      [11n, "lane_budget"],
    ] as const) {
      const owner = await newOwner();
      const [a, b] = await agentsOf(app, db, owner, 2);
      await numberOf(owner, 20n, [a!, b!]);
      await paidReply(db, { agentId: b!.agentId, ownerId: owner.id, conversationId: b!.conversationId, lane: "others", micro: settled * POINT, at: NOON });
      const run = await seedRun(db, { ownerId: owner.id, agent: a!, lane: "others", hold: 8_387_000n, admittedAt: NOON });
      expect(await refusal(preHold({ runId: run, ownerId: owner.id, agent: a!, lane: "others" }))).toBe(expected);
      expect((await webOf(run)).n).toBe(expected === "held" ? 1 : 0);
    }
  });

  it("another running reply's hold counts too, a proactive one beside an others' one", async () => {
    const owner = await newOwner();
    const [a, b] = await agentsOf(app, db, owner, 2);
    await numberOf(owner, 20n, [a!, b!]);
    const mine = await seedRun(db, { ownerId: owner.id, agent: a!, lane: "others", hold: 8_387_000n, admittedAt: NOON });
    await seedRun(db, { ownerId: owner.id, agent: b!, lane: "proactive", hold: 10_900_000n, admittedAt: NOON });
    // 8.387 + 10.9 = 19.287; a search of 0.77 makes 20.057.
    expect(await refusal(preHold({ runId: mine, ownerId: owner.id, agent: a!, lane: "others" }))).toBe("lane_budget");
  });

  for (const lane of ["others", "proactive"] as const) {
    it(`two Agents of one owner (lane ${lane}) racing at their searches for the last 0.77, on two connections: exactly one is held`, async () => {
      const owner = await newOwner();
      const [a, b] = await agentsOf(app, db, owner, 2);
      await numberOf(owner, 20n, [a!, b!]);
      await db.query("update agents set proactive_budget_micro = 100000000000 where principal_id = any($1::uuid[])", [[a!.agentId, b!.agentId]]);
      // Their holds come to 18.9: one search of 0.77 fits (19.67), the second would make 20.44.
      const ra = await seedRun(db, { ownerId: owner.id, agent: a!, lane, hold: 9_200_000n, admittedAt: NOON });
      const rb = await seedRun(db, { ownerId: owner.id, agent: b!, lane, hold: 9_700_000n, admittedAt: NOON });
      let held!: () => void;
      const heldNow = new Promise<void>((r) => (held = r));
      let release!: () => void;
      const wait = new Promise<void>((r) => (release = r));
      const first = preHold({ runId: ra, ownerId: owner.id, agent: a!, lane }, { held, wait });
      await heldNow;
      // The second waits for the account's lock the first holds; once the first has committed it counts the first's search.
      const second = refusal(preHold({ runId: rb, ownerId: owner.id, agent: b!, lane }));
      await new Promise((r) => setTimeout(r, 100));
      release();
      await first;
      expect(await second).toBe("lane_budget");
      expect([(await webOf(ra)).n, (await webOf(rb)).n]).toEqual([1, 0]);
    });
  }

  it("an Agent's own lower number binds at the search first", async () => {
    const owner = await newOwner();
    const [a] = await agentsOf(app, db, owner, 1);
    await db.query("update agents set others_budget_micro = 9000000 where principal_id = $1", [a!.agentId]);
    const run = await seedRun(db, { ownerId: owner.id, agent: a!, lane: "others", hold: 8_387_000n, admittedAt: NOON });
    // 8.387 + 0.77 = 9.157 > 9.
    expect(await refusal(preHold({ runId: run, ownerId: owner.id, agent: a!, lane: "others" }))).toBe("lane_budget");
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
    // On its first request, with its hold written, the owner's others' points are brought to within 0.4 of the number: its search cannot be held.
    const gateway = Object.create(inner) as ModelGateway & typeof inner;
    gateway.stream = ((call: ModelCall) => {
      const events = inner.stream(call);
      return (async function* () {
        if (first) {
          first = false;
          const hold = BigInt((await db.query<{ h: string }>("select hold_micro::text as h from agent_runs where conversation_id = $1 order by created_at desc limit 1", [conv])).rows[0]!.h);
          await paidReply(db, { agentId: ctx.agent, ownerId: ctx.owner, conversationId: ctx.own, lane: "others", micro: 300n * POINT - hold - 400_000n });
        }
        yield* events;
      })();
    }) as ModelGateway["stream"];
    const k = await othersKitchen(app, db, { box, config, gateway, onGroup: (g) => void (conv = g), agent: { othersBudget: null } });
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
  it("an Agent on its owner's own provider key is not refused at the trigger by the points, as admission lets it through; its answers still count", async () => {
    const k = await othersKitchen(app, db, { box: undefined, agent: { othersBudget: null } });
    await setOwnerNumbers(db, k.owner.id, { pointsMicro: 5n * POINT });
    await paidReply(db, { agentId: k.agent.id, ownerId: k.owner.id, conversationId: k.g, lane: "others", micro: 9n * POINT });
    const provider = (await api(app, k.owner, "POST", "/api/providers", providerBody({ models: [{ name: "mine" }] }))).json;
    const byok = await mustCreateAgent(app, k.owner, { handle: "byok", name: "byok", model: { source: "provider", providerId: provider.id as string, model: "mine" }, persona: "简短。" });
    await db.query("insert into memberships (conversation_id, principal_id, role, joined_seq) select $1, $2, 'speaker', seq from conversations where id = $1", [k.g, byok.id]);
    await k.ask("@byok 你好");
    expect((await k.lastRun()).status).toBe("queued");
    expect(await k.notices()).toBe(0);
    // The site-model Agent beside it is refused by the same points.
    await k.ask("@chef 你好");
    expect(await k.notices()).toBe(1);
  });

  it("a member's call after the owner's points are reached is not called (what is held counts); the group gets its one notice that site day once the points are USED, not while only a hold is in the way", async () => {
    const k = await othersKitchen(app, db, { box: undefined, agent: { othersBudget: null } });
    await setOwnerNumbers(db, k.owner.id, { pointsMicro: 20n * POINT });
    // 12 points settled and 8 held by a running reply of another Agent: 20 reached.
    await paidReply(db, { agentId: k.agent.id, ownerId: k.owner.id, conversationId: k.g, lane: "others", micro: 12n * POINT });
    const other = (await agentsOf(app, db, k.owner, 1))[0]!;
    await seedRun(db, { ownerId: k.owner.id, agent: other, lane: "others", hold: 8n * POINT, admittedAt: new Date() });
    await k.ask();
    expect((await db.query("select 1 from agent_runs where conversation_id = $1 and status = 'queued'", [k.g])).rowCount).toBe(0);
    // Refused, and the group is told nothing yet: 8 of the 20 are only HELD, and come back when that reply ends (fix round 4, F5:
    // 「明天恢复」 is said only when it is so, by the decision the owner's page shows).
    expect(await k.notices()).toBe(0);
    // Now they are used: that reply has ended, and what it held is settled.
    await db.query("update agent_runs set status = 'done', hold_micro = 0, finished_at = now() where owner_id = $1 and status = 'running'", [k.owner.id]);
    await paidReply(db, { agentId: k.agent.id, ownerId: k.owner.id, conversationId: k.g, lane: "others", micro: 8n * POINT });
    await k.ask("@chef 还在吗");
    expect((await db.query("select 1 from agent_runs where conversation_id = $1 and status = 'queued'", [k.g])).rowCount).toBe(0);
    expect(await k.notices()).toBe(1);
    await k.ask("@chef 再问一次");
    expect((await db.query("select 1 from agent_runs where conversation_id = $1 and status = 'queued'", [k.g])).rowCount).toBe(0);
    expect(await k.notices()).toBe(1);
    // The owner's own call is never refused by it.
    await k.askAsOwner();
    expect((await k.lastRun()).lane).toBe("own");
  });
});
