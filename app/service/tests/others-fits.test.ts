import { afterEach, describe, expect, it } from "vitest";
import { createAgentPort, type Toolbox } from "../src/agents/port-impl.ts";
import { createAgentWorker } from "../src/agents/runtime/worker.ts";
import type { ToolSpec } from "../src/models/gateway.ts";
import { admitRun, HeldBack, type Admission } from "../src/metering/admit.ts";
import { othersFits, othersHold, othersNumbers, othersUsedToday, OthersLimit, type OthersLane } from "../src/metering/others.ts";
import { maxCostMicro } from "../src/metering/prices.ts";
import { settle } from "../src/metering/settle.ts";
import { api, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { closeAllSockets } from "./helpers/ws.ts";
import { grant, paidReply, type MeteredAgent } from "./helpers/metering.ts";
import {
  agentsOf,
  committedMicro,
  FREE_MODEL,
  HELD_PLAIN,
  HELD_WITH_TOOLS,
  NOON,
  OTHERS_ENV,
  PAID_MODEL,
  POINT,
  providerAgent,
  ROOM,
  seeded,
  seedRun,
  setOwnerNumbers,
} from "./helpers/others.ts";

/**
 * Lane B, B1 (plan; design §8 test 2): an owner's two numbers for others' use, a site day's answers and points, decided in ONE
 * place, `othersFits`, under the account lock — at admission, counting the run's own hold (still 0 there) and every other
 * running others' reply's. The admission rule is one money invariant: with tools if the with-tools hold fits what is left,
 * else plain if the one-call hold fits, else the reply waits (`HeldBack`) or ends (`OthersLimit`). On the design's sites: 140 / 280
 * micro-points a token on the free tier, 3 000 / 15 000 on the paid, 800 output tokens. Real Postgres, parallel connections;
 * every instant is noon in Shanghai (`NOON`) unless a test names another.
 */

const lines: string[] = [];
const { app, db } = useApp({ env: OTHERS_ENV, agentWorker: false, logStream: { write: (line) => void lines.push(line) } });
const config = () => app.deps.config;
/** The metric lines named `name` logged since the test began. */
const metric = (name: string) => lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((e) => e.metric === name);
afterEach(async () => {
  await closeAllSockets();
  lines.length = 0;
});
let n = 0;
const newOwner = async (): Promise<Actor> => {
  const owner = await signUp(app, `oo${++n}x${Math.floor(Math.random() * 1e6)}`);
  await grant(db, owner.id, 10_000n * POINT);
  return owner;
};

/** Admits `runId` of `agent` as `begin` does: a reply offered tools (call 1, its last call, and the one-call hold to fall back on), or one that is not. */
function admitAs(ownerId: string, agent: MeteredAgent, runId: string, o: { tools?: boolean; at?: Date } = {}): Promise<Admission> {
  const tools = o.tools ?? true;
  const held = tools ? HELD_WITH_TOOLS : HELD_PLAIN;
  const last = tools ? maxCostMicro(agent.resolved, Math.min(held + ROOM.growthTokens, ROOM.roomCapTokens)) : 0n;
  const plain = tools ? othersHold(agent.resolved, HELD_PLAIN, null) : null;
  return db.tx((t) => admitRun(t, config(), runId, ownerId, agent.resolved, held, o.at ?? NOON, last, plain));
}

const settleCheap = (runId: string) =>
  db.tx((t) => settle(t, config(), runId, { inputTokens: 5000, outputTokens: 300 }, { inputChars: 0, outputChars: 0 }, "done", NOON, { log: { warn: () => undefined } }));

/** `count` finished chains of `agent` admitted at `at`: the answers a site day has had. */
async function chains(ownerId: string, agent: MeteredAgent, count: number, at = NOON, lane: OthersLane = "others"): Promise<void> {
  for (let i = 0; i < count; i++) await seedRun(db, { ownerId, agent, lane, status: "done", admittedAt: at });
}

describe("the holds (design §8 test 2)", () => {
  it("one call, or call 1 and the last call, on the design's sites", async () => {
    const owner = await newOwner();
    const [free, paid] = [(await agentsOf(app, db, owner, 1, FREE_MODEL))[0]!, (await agentsOf(app, db, owner, 1, PAID_MODEL))[0]!];
    expect(othersHold(free.resolved, 16_500, null)).toBe(2_534_000n);
    expect(othersHold(paid.resolved, 16_500, null)).toBe(61_500_000n);
    expect(othersHold(free.resolved, 20_900, ROOM)).toBe(8_387_260n);
    expect(othersHold(paid.resolved, 20_900, ROOM)).toBe(194_127_000n);
    // The last call never passes what one call of the model can carry.
    expect(othersHold(free.resolved, 20_900, { growthTokens: 14_909, roomCapTokens: 21_000 })).toBe(maxCostMicro(free.resolved, 20_900) + maxCostMicro(free.resolved, 21_000));
  });

  it("the owner's numbers: the account's own, else the config's; an Agent's own are sub-limits", async () => {
    const owner = await newOwner();
    const [a] = await agentsOf(app, db, owner, 1);
    expect(await othersNumbers(db, config(), owner.id, a!.agentId)).toEqual({
      owner: { answers: 50, pointsMicro: 70n * POINT },
      agent: { answers: null, pointsMicro: 20n * POINT },
      proactiveMicro: 20n * POINT,
    });
    await setOwnerNumbers(db, owner.id, { answers: 7, pointsMicro: 30n * POINT });
    await db.query("update agents set others_answers = 3, others_budget_micro = null where principal_id = $1", [a!.agentId]);
    expect(await othersNumbers(db, config(), owner.id, a!.agentId)).toEqual({
      owner: { answers: 7, pointsMicro: 30n * POINT },
      agent: { answers: 3, pointsMicro: null },
      proactiveMicro: 20n * POINT,
    });
  });
});

describe("the answers", () => {
  it("49 answers today and two visitors at the last one on two connections: exactly one is admitted, the other is refused by the answers", async () => {
    const owner = await newOwner();
    const [a, b] = await agentsOf(app, db, owner, 2);
    await chains(owner.id, a!, 49);
    const [r1, r2] = [await seedRun(db, { ownerId: owner.id, agent: a!, lane: "others" }), await seedRun(db, { ownerId: owner.id, agent: b!, lane: "others" })];
    const settled = await Promise.allSettled([admitAs(owner.id, a!, r1), admitAs(owner.id, b!, r2)]);
    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.flatMap((r) => (r.status === "rejected" ? [r.reason as unknown] : []));
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toBeInstanceOf(OthersLimit);
    expect((rejected[0] as OthersLimit).limit).toBe("answers");
    expect((await othersUsedToday(db, config(), owner.id, NOON)).answers).toBe(50);
  });

  it("a chain counts once: a retry of an answer already counted today is admitted at the number, and a chain from yesterday retried today counts one today", async () => {
    const owner = await newOwner();
    const [a, b, c] = await agentsOf(app, db, owner, 3);
    await chains(owner.id, b!, 49);
    const first = await seedRun(db, { ownerId: owner.id, agent: a!, lane: "others", status: "done", admittedAt: NOON });
    // 50 chains today. Its retry belongs to the first chain: admitted, though a new chain would not be.
    const retry = await seedRun(db, { ownerId: owner.id, agent: a!, lane: "others", retryOf: first });
    expect(await admitAs(owner.id, a!, retry)).toMatchObject({ chargeTo: "free" });
    expect((await othersUsedToday(db, config(), owner.id, NOON)).answers).toBe(50);
    const fresh = await seedRun(db, { ownerId: owner.id, agent: c!, lane: "others" });
    await expect(admitAs(owner.id, c!, fresh)).rejects.toMatchObject({ limit: "answers" });

    // A chain begun yesterday, retried today: one answer today (RF4).
    const owner2 = await newOwner();
    const [d] = await agentsOf(app, db, owner2, 1);
    const yesterday = new Date(NOON.getTime() - 24 * 3600_000);
    const original = await seedRun(db, { ownerId: owner2.id, agent: d!, lane: "others", status: "done", admittedAt: yesterday });
    const again = await seedRun(db, { ownerId: owner2.id, agent: d!, lane: "others", retryOf: original });
    await admitAs(owner2.id, d!, again);
    expect((await othersUsedToday(db, config(), owner2.id, NOON)).answers).toBe(1);
    expect((await othersUsedToday(db, config(), owner2.id, yesterday)).answers).toBe(1);
  });

  it("the site day's edge: claimed at 23:59:58 and admitted at 00:00:01 counts on the new day, and still there when read later; held back across midnight, on the day it is admitted", async () => {
    const owner = await newOwner();
    const [a] = await agentsOf(app, db, owner, 1);
    const before = new Date("2026-03-02T15:59:58Z"); // 23:59:58 in Shanghai on 2 March
    const after = new Date("2026-03-02T16:00:01Z"); // 00:00:01 on 3 March
    const run = await seedRun(db, { ownerId: owner.id, agent: a!, lane: "others" });
    await db.query("update agent_runs set started_at = $2 where id = $1", [run, before]);
    await admitAs(owner.id, a!, run, { at: after });
    expect((await othersUsedToday(db, config(), owner.id, after)).answers).toBe(1);
    expect((await othersUsedToday(db, config(), owner.id, new Date("2026-03-03T10:00:00Z"))).answers).toBe(1);
    expect((await othersUsedToday(db, config(), owner.id, before)).answers).toBe(0);

    // Held back at 23:59:58: nothing is counted that day; admitted after midnight, it counts on the new day.
    const owner2 = await newOwner();
    const [b, c] = await agentsOf(app, db, owner2, 2);
    await setOwnerNumbers(db, owner2.id, { pointsMicro: 30n * POINT });
    const holder = await seedRun(db, { ownerId: owner2.id, agent: b!, lane: "others", hold: 28n * POINT, admittedAt: before });
    const waiting = await seedRun(db, { ownerId: owner2.id, agent: c!, lane: "others" });
    await expect(admitAs(owner2.id, c!, waiting, { at: before })).rejects.toBeInstanceOf(HeldBack);
    expect((await othersUsedToday(db, config(), owner2.id, before)).answers).toBe(1);
    await db.query("update agent_runs set hold_micro = 0, status = 'done' where id = $1", [holder]);
    await admitAs(owner2.id, c!, waiting, { at: after });
    expect((await othersUsedToday(db, config(), owner2.id, after)).answers).toBe(1);
    expect((await othersUsedToday(db, config(), owner2.id, before)).answers).toBe(1);
  });

  it("an Agent's own answers number binds inside the owner's", async () => {
    const owner = await newOwner();
    const [a, b] = await agentsOf(app, db, owner, 2);
    await db.query("update agents set others_answers = 2 where principal_id = $1", [a!.agentId]);
    await chains(owner.id, a!, 2);
    const refused = await seedRun(db, { ownerId: owner.id, agent: a!, lane: "others" });
    await expect(admitAs(owner.id, a!, refused)).rejects.toMatchObject({ limit: "answers" });
    const other = await seedRun(db, { ownerId: owner.id, agent: b!, lane: "others" });
    expect(await admitAs(owner.id, b!, other)).toMatchObject({ chargeTo: "free" });
  });
});

describe("the points", () => {
  it("the rule's order, each from scratch under a number of 30: plain when only the one-call hold fits, with tools when it all fits, waiting when nothing fits beside the holds, ending when nothing is held", async () => {
    const fresh = async (): Promise<{ owner: Actor; agents: MeteredAgent[] }> => {
      const owner = await newOwner();
      await setOwnerNumbers(db, owner.id, { pointsMicro: 30n * POINT });
      return { owner, agents: await agentsOf(app, db, owner, 2) };
    };
    // 25.16 held by another reply (4.84 left): the with-tools hold of 8.387 does not fit, the one-call hold of 2.534 does.
    let w = await fresh();
    await seedRun(db, { ownerId: w.owner.id, agent: w.agents[0]!, lane: "others", hold: 25_160_000n, admittedAt: NOON });
    let run = await seedRun(db, { ownerId: w.owner.id, agent: w.agents[1]!, lane: "others" });
    const plain = await admitAs(w.owner.id, w.agents[1]!, run);
    expect(plain).toMatchObject({ chargeTo: "free", holdMicro: 2_534_000n, plain: true });
    expect(plain.reserveMicro).toBeUndefined();
    expect(await committedMicro(db, w.owner.id)).toBe(25_160_000n + 2_534_000n);

    // 1 held by another (29 left): with tools.
    w = await fresh();
    await seedRun(db, { ownerId: w.owner.id, agent: w.agents[0]!, lane: "others", hold: 1n * POINT, admittedAt: NOON });
    run = await seedRun(db, { ownerId: w.owner.id, agent: w.agents[1]!, lane: "others" });
    const full = await admitAs(w.owner.id, w.agents[1]!, run);
    expect(full).toMatchObject({ holdMicro: 8_387_260n, reserveMicro: 5_237_260n });
    expect(full.plain).toBeUndefined();

    // 28 held by another (2 left): not even the one-call hold fits, and another reply holds: it waits for it, on "any".
    w = await fresh();
    const holder = await seedRun(db, { ownerId: w.owner.id, agent: w.agents[0]!, lane: "others", hold: 28n * POINT, admittedAt: NOON });
    run = await seedRun(db, { ownerId: w.owner.id, agent: w.agents[1]!, lane: "others" });
    const waited = await admitAs(w.owner.id, w.agents[1]!, run).catch((e: unknown) => e);
    expect(waited).toBeInstanceOf(HeldBack);
    expect((waited as HeldBack).behind).toEqual([holder]);
    expect((waited as HeldBack).on).toBe("any");

    // Nothing held, 28 settled: nothing fits and nothing will free: it ends.
    w = await fresh();
    await paidReply(db, { agentId: w.agents[0]!.agentId, ownerId: w.owner.id, conversationId: w.agents[0]!.conversationId, lane: "others", micro: 28n * POINT, at: NOON });
    run = await seedRun(db, { ownerId: w.owner.id, agent: w.agents[1]!, lane: "others" });
    await expect(admitAs(w.owner.id, w.agents[1]!, run)).rejects.toMatchObject({ limit: "points" });

    // The plain admission is the same whether the with-tools refusal waited or ended: 26 settled, nothing held (4 left) → plain.
    w = await fresh();
    await paidReply(db, { agentId: w.agents[0]!.agentId, ownerId: w.owner.id, conversationId: w.agents[0]!.conversationId, lane: "others", micro: 26n * POINT, at: NOON });
    run = await seedRun(db, { ownerId: w.owner.id, agent: w.agents[1]!, lane: "others" });
    expect(await admitAs(w.owner.id, w.agents[1]!, run)).toMatchObject({ holdMicro: 2_534_000n, plain: true });
  });

  it("five replies offered tools at once on five connections, in the orders of a seeded shuffle: settled plus every hold never passes 30, after every admission and every settlement; each ends admitted, waiting or ended", async () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const rand = seeded(seed);
      const owner = await newOwner();
      await setOwnerNumbers(db, owner.id, { pointsMicro: 30n * POINT });
      const agents = await agentsOf(app, db, owner, 5);
      const runs = await Promise.all(agents.map((a) => seedRun(db, { ownerId: owner.id, agent: a, lane: "others" })));
      const order = agents.map((_, i) => i).sort(() => rand() - 0.5);
      const peaks: bigint[] = [];
      const check = async () => {
        const committed = await committedMicro(db, owner.id);
        peaks.push(committed);
        expect(committed).toBeLessThanOrEqual(30n * POINT);
      };
      const outcomes = await Promise.all(
        order.map(async (i) => {
          await new Promise((r) => setTimeout(r, Math.floor(rand() * 15)));
          try {
            const admission = await admitAs(owner.id, agents[i]!, runs[i]!);
            await check();
            await new Promise((r) => setTimeout(r, Math.floor(rand() * 10)));
            await settleCheap(runs[i]!);
            await check();
            return admission.plain ? "plain" : "tools";
          } catch (err) {
            await check();
            if (err instanceof HeldBack) return "waits";
            if (err instanceof OthersLimit) return "ends";
            throw err;
          }
        }),
      );
      expect(outcomes.every((o) => ["tools", "plain", "waits", "ends"].includes(o))).toBe(true);
      expect(peaks.length).toBeGreaterThanOrEqual(5);
      await check();
    }
  });

  it("an Agent's own lower number binds first; a proactive reply meets its proactive budget as a hard sub-cap", async () => {
    const owner = await newOwner();
    const [a, b, c] = await agentsOf(app, db, owner, 3);
    // 5 points: the with-tools hold (8.387) does not fit, the one-call hold (2.534) does.
    await db.query("update agents set others_budget_micro = $2 where principal_id = $1", [a!.agentId, (5n * POINT).toString()]);
    const run1 = await seedRun(db, { ownerId: owner.id, agent: a!, lane: "others" });
    expect(await admitAs(owner.id, a!, run1)).toMatchObject({ plain: true, holdMicro: 2_534_000n });
    // Another Agent's holds do not count against it: b holds 20 points of the owner's 70.
    await seedRun(db, { ownerId: owner.id, agent: b!, lane: "others", hold: 20n * POINT, admittedAt: NOON });
    await db.query("update agents set others_budget_micro = $2 where principal_id = $1", [c!.agentId, (10n * POINT).toString()]);
    const run2 = await seedRun(db, { ownerId: owner.id, agent: c!, lane: "others" });
    expect(await admitAs(owner.id, c!, run2)).toMatchObject({ holdMicro: 8_387_260n });
    // 2 points: not even the one-call hold fits.
    const owner2 = await newOwner();
    const [d] = await agentsOf(app, db, owner2, 1);
    await db.query("update agents set others_budget_micro = $2 where principal_id = $1", [d!.agentId, (2n * POINT).toString()]);
    const run3 = await seedRun(db, { ownerId: owner2.id, agent: d!, lane: "others" });
    await expect(admitAs(owner2.id, d!, run3)).rejects.toMatchObject({ limit: "points" });
    // Proactive: its own budget of 2 points.
    await db.query("update agents set proactive_budget_micro = $2 where principal_id = $1", [d!.agentId, (2n * POINT).toString()]);
    await db.query("update agent_runs set status = 'done' where id = $1", [run3]);
    const run4 = await seedRun(db, { ownerId: owner2.id, agent: d!, lane: "proactive" });
    await expect(admitAs(owner2.id, d!, run4)).rejects.toMatchObject({ limit: "proactive" });
  });

  it("a provider's reply holds nothing and is refused only by the answers; the owner's own replies are never refused or held back by these", async () => {
    const owner = await newOwner();
    await setOwnerNumbers(db, owner.id, { pointsMicro: 1n * POINT });
    const byok = await providerAgent(app, db, owner);
    const [site] = await agentsOf(app, db, owner, 1);
    await paidReply(db, { agentId: site!.agentId, ownerId: owner.id, conversationId: site!.conversationId, lane: "others", micro: 5n * POINT, at: NOON });
    const run = await seedRun(db, { ownerId: owner.id, agent: byok, lane: "others" });
    expect(await admitAs(owner.id, byok, run)).toEqual({ chargeTo: null, holdMicro: 0n });
    await db.query("update agent_runs set status = 'done' where id = $1", [run]);
    // The answers: 50 chains today refuse it.
    await chains(owner.id, site!, 49);
    const run2 = await seedRun(db, { ownerId: owner.id, agent: byok, lane: "others" });
    await expect(admitAs(owner.id, byok, run2)).rejects.toMatchObject({ limit: "answers" });
    // The owner's own reply: admitted at the same numbers, on the same Agent.
    const own = await seedRun(db, { ownerId: owner.id, agent: site!, lane: "own" });
    expect(await admitAs(owner.id, site!, own)).toMatchObject({ chargeTo: "free" });
  });

  it("othersFits at a search and at a round counts the asking run's own hold (D19); at the round with x = 0 nothing is refused for points", async () => {
    const owner = await newOwner();
    await setOwnerNumbers(db, owner.id, { pointsMicro: 20n * POINT });
    const [a, b] = await agentsOf(app, db, owner, 2);
    await paidReply(db, { agentId: b!.agentId, ownerId: owner.id, conversationId: b!.conversationId, lane: "others", micro: 10n * POINT, at: NOON });
    const mine = await seedRun(db, { ownerId: owner.id, agent: a!, lane: "others", hold: 8_387_000n, admittedAt: NOON });
    const run = { id: mine, ownerId: owner.id, agentId: a!.agentId, lane: "others" as const };
    // 10 settled + this run's own 8.387 + a search of 0.77 = 19.157 ≤ 20; at 11 settled it is 20.157 > 20.
    expect(await db.tx((t) => othersFits(t, config(), run, 770_000n, "search", NOON))).toEqual({ ok: true });
    await paidReply(db, { agentId: b!.agentId, ownerId: owner.id, conversationId: b!.conversationId, lane: "others", micro: 1n * POINT, at: NOON });
    expect(await db.tx((t) => othersFits(t, config(), run, 770_000n, "search", NOON))).toEqual({ ok: false, limit: "points" });
    expect(await db.tx((t) => othersFits(t, config(), run, 0n, "round", NOON))).toEqual({ ok: true });
  });
});

const SEARCH: ToolSpec = {
  name: "search",
  description: "Search this conversation's messages.",
  parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
};
const BOX: Toolbox = { offer: () => ({ tools: [SEARCH], perTool: { search: 6 }, kinds: { search: "search" } }), run: async () => ({ output: { hits: [] }, activity: "search" }) };

/** A group of the owner, a member and a third, with the owner's Agent `chef` in it; a member's @ call makes a reply in lane `others`. */
async function kitchen(over: Record<string, unknown> = {}) {
  const owner = await newOwner();
  const member = await signUp(app, `mm${++n}x${Math.floor(Math.random() * 1e6)}`);
  const third = await signUp(app, `tt${++n}x${Math.floor(Math.random() * 1e6)}`);
  const g = await group(app, owner, "饭搭子", [member, third]);
  const agent = await mustCreateAgent(app, owner, { handle: "chef", name: "chef", model: FREE_MODEL, persona: "简短地回答。", ...over });
  await db.query("insert into memberships (conversation_id, principal_id, role, joined_seq) select $1, $2, 'speaker', seq from conversations where id = $1", [g, agent.id]);
  const gateway = scriptedGateway();
  const { db: pool, blobs, conversations, reads } = app.deps;
  const port = createAgentPort({ db: pool, config: config(), blobs, realtime: app.realtime, conversations, reads, log: app.log, toolbox: BOX });
  const worker = createAgentWorker({ port, models: gateway, runTimeoutMs: config().agentRunTimeoutMs, maxRunsInFlight: 1, background: false, log: app.log, tools: config().tools });
  const ask = async () => {
    const sent = await api(app, member, "POST", `/api/conversations/${g}/messages`, { text: "@chef 附近有什么好吃的？", clientTxn: `kt${++n}` });
    expect(sent.status).toBe(201);
  };
  const lastRun = async () =>
    (await db.query<{ id: string; status: string; hold: string; held_back_by: string[] | null }>("select id, status, hold_micro::text as hold, held_back_by from agent_runs where conversation_id = $1 order by created_at desc limit 1", [g])).rows[0]!;
  const notices = async () => (await db.query("select 1 from messages where conversation_id = $1 and body ->> 'event' = 'agent_daily_budget_reached'", [g])).rowCount;
  return { owner, agent, g, gateway, worker, ask, lastRun, notices };
}

describe("a reply someone else called for, as `begin` admits it", () => {
  it("whose with-tools hold does not fit the Agent's number but whose one call does is made without tools, and says so", async () => {
    const k = await kitchen({ othersBudget: "1" });
    k.gateway.reply("川菜。", { usage: { inputTokens: 900, outputTokens: 20 } });
    await k.ask();
    expect(await k.worker.runOnce()).toBe(true);
    expect(k.gateway.calls).toHaveLength(1);
    expect(k.gateway.calls[0]!.tools ?? []).toEqual([]);
    expect(await k.lastRun()).toMatchObject({ status: "done", hold: "0" });
    expect(metric("others_plain_fallback")).toHaveLength(1);
  });

  it("with the same number and room for the tools it is offered them", async () => {
    const k = await kitchen({ othersBudget: "20" });
    k.gateway.reply("川菜。", { usage: { inputTokens: 900, outputTokens: 20 } });
    await k.ask();
    expect(await k.worker.runOnce()).toBe(true);
    expect(k.gateway.calls[0]!.tools).toEqual([SEARCH]);
    expect(metric("others_plain_fallback")).toHaveLength(0);
  });

  it("whose owner's number is reached and nothing is held to wait for ends quietly at once: no call, nothing held, one notice, counted", async () => {
    const k = await kitchen({ othersBudget: "1" });
    await paidReply(db, { agentId: k.agent.id, ownerId: k.owner.id, conversationId: k.g, lane: "others", micro: 900_000n });
    await k.ask();
    expect(await k.worker.runOnce()).toBe(true);
    expect(k.gateway.calls).toHaveLength(0);
    expect(await k.lastRun()).toMatchObject({ status: "cancelled", hold: "0" });
    expect(await k.notices()).toBe(1);
    expect(metric("others_limit_refused")).toEqual([expect.objectContaining({ limit: "points" })]);
  });

  it("which would pass the owner's number beside another reply's hold waits for it: queued behind it, counted", async () => {
    const k = await kitchen();
    const other = await mustCreateAgent(app, k.owner, { handle: "other", name: "other", model: FREE_MODEL, persona: "简短地回答。" });
    const holder = await seedRun(db, { ownerId: k.owner.id, agent: { agentId: other.id, conversationId: other.conversationId }, lane: "others", hold: 69_900_000n, admittedAt: NOON });
    await k.ask();
    expect(await k.worker.runOnce()).toBe(true);
    expect(k.gateway.calls).toHaveLength(0);
    expect(await k.lastRun()).toMatchObject({ status: "queued", held_back_by: [holder] });
    expect(metric("others_held_back")).toHaveLength(1);
  });
});
