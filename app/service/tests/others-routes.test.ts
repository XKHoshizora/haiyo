import { afterEach, describe, expect, it } from "vitest";
import { stoppedOf, stoppedShape } from "../src/accounts/others-routes.ts";
import { NO_RUN, othersCheck, othersFloorHold, othersPlainCeiling, othersPlainFloor, othersUsedByAgents, othersUsedToday, perDayEstimate } from "../src/metering/others.ts";
import { NOTES_SECRET_CLAUSE, notesPassage } from "../src/agents/runtime/prompt.ts";
import { readOwnedAgent } from "../src/agents/store.ts";
import { notesFor } from "../src/memory/store.ts";
import { api, signUp, type Actor } from "./helpers/actors.ts";
import { createAgent, mustCreateAgent } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { paidReply } from "./helpers/metering.ts";
import { agentsOf, FREE_MODEL, OTHERS_ENV, PAID_MODEL, POINT, providerAgent, seedRun, setOwnerNumbers } from "./helpers/others.ts";
import { SOCIAL_ON } from "./helpers/social.ts";
import { closeAllSockets } from "./helpers/ws.ts";

/**
 * Lane B, B4: the numbers on the wire (an Agent's own `othersLimit` and `othersUsedToday`, the old three fields gone), the use routes
 * `GET /api/me/others-use`, `PUT /api/me/others-limits`, `POST /api/me/others-limits/seen`, and what they say of the owner's day. The
 * design's sites: 140 / 280 micro-points a token on the free tier, 3 000 / 15 000 on the paid, 800 output tokens, so a plain reply holds
 * 2.534 points (free) or 61.5 (paid). Limits are per owner: 50 answers and 70 points unless the owner says otherwise.
 */

const env = { ...OTHERS_ENV, AGENT_TIERS: JSON.stringify({ free: 25, plus: 30 }) };
const { app, db } = useApp({ env, agentWorker: false });
afterEach(async () => {
  await closeAllSockets();
});

let n = 0;
const newOwner = (): Promise<Actor> => signUp(app, `or${++n}x${Math.floor(Math.random() * 1e6)}`);
const use = (who: Actor) => api(app, who, "GET", "/api/me/others-use");

/**
 * A finished reply of `agent` in its own lane `lane`, `micro` charged today to the owner, admitted now (one answer) and called by `caller`
 * (null: nobody, as a proactive reply). `at` moves the day of both.
 */
async function reply(o: { agent: { agentId: string; conversationId: string }; ownerId: string; lane: "own" | "others" | "proactive"; micro: bigint; caller?: string | null; at?: Date }): Promise<string> {
  const id = await paidReply(db, { agentId: o.agent.agentId, ownerId: o.ownerId, conversationId: o.agent.conversationId, lane: o.lane, micro: o.micro, at: o.at ?? null });
  await db.query("update agent_runs set admitted_at = $2, caller_id = $3 where id = $1", [id, o.at ?? new Date(), o.caller ?? null]);
  return id;
}

describe("an Agent's wire", () => {
  it("has othersLimit and othersUsedToday; othersBudget, othersSpentToday and proactiveSpentToday are gone, proactiveBudget stays", async () => {
    const owner = await newOwner();
    const made = await mustCreateAgent(app, owner, {});
    for (const gone of ["othersBudget", "othersSpentToday", "proactiveSpentToday"]) expect(Object.keys(made)).not.toContain(gone);
    // A new Agent has no number of its own (the owner's 70 points and 50 answers apply), a proactive budget of 70 (074), and used nothing.
    expect(made).toMatchObject({ othersLimit: { answers: null, points: null }, othersUsedToday: { answers: 0, points: "0" }, proactiveBudget: "70" });
    expect((await api(app, owner, "GET", `/api/agents/${made.id}`)).json).toEqual(made);
    expect((await api(app, owner, "GET", "/api/agents")).json.agents).toEqual([made]);
  });

  it("creates with othersLimit or the one-release alias othersBudget; both in one body is a 400", async () => {
    const owner = await newOwner();
    expect(await mustCreateAgent(app, owner, { othersLimit: { answers: 4, points: "9.5" } })).toMatchObject({ othersLimit: { answers: 4, points: "9.5" } });
    expect(await mustCreateAgent(app, owner, { othersLimit: { answers: null, points: "3" } })).toMatchObject({ othersLimit: { answers: null, points: "3" } });
    expect(await mustCreateAgent(app, owner, { othersLimit: null })).toMatchObject({ othersLimit: { answers: null, points: null } });
    expect(await mustCreateAgent(app, owner, { othersBudget: "6" })).toMatchObject({ othersLimit: { answers: null, points: "6" } });
    expect(await mustCreateAgent(app, owner, { othersBudget: null })).toMatchObject({ othersLimit: { answers: null, points: null } });
    expect((await createAgent(app, owner, { othersLimit: null, othersBudget: "6" })).status).toBe(400);
    expect((await createAgent(app, owner, { othersLimit: { answers: 4, points: "9" }, othersBudget: "6" })).status).toBe(400);
  });

  it("PATCH othersLimit round-trips; null clears both; the alias sets the points and leaves the answers; bad numbers are 400", async () => {
    const owner = await newOwner();
    const agent = await mustCreateAgent(app, owner, {});
    const patch = (body: unknown) => api(app, owner, "PATCH", `/api/agents/${agent.id}`, body);
    const set = await patch({ othersLimit: { answers: 5, points: "12.5" } });
    expect([set.status, set.json.othersLimit]).toEqual([200, { answers: 5, points: "12.5" }]);
    expect((await api(app, owner, "GET", `/api/agents/${agent.id}`)).json.othersLimit).toEqual({ answers: 5, points: "12.5" });
    expect((await db.query(`select others_answers n, others_budget_micro::text p from agents where principal_id = $1`, [agent.id])).rows).toEqual([{ n: 5, p: "12500000" }]);
    expect((await patch({ othersBudget: "7" })).json.othersLimit).toEqual({ answers: 5, points: "7" });
    expect((await patch({ othersBudget: null })).json.othersLimit).toEqual({ answers: 5, points: null });
    expect((await patch({ othersLimit: { answers: null, points: "1" } })).json.othersLimit).toEqual({ answers: null, points: "1" });
    expect((await patch({ intro: "简介" })).json.othersLimit).toEqual({ answers: null, points: "1" });
    expect((await patch({ othersLimit: null })).json.othersLimit).toEqual({ answers: null, points: null });
    for (const bad of [
      { othersLimit: { answers: 0, points: "1" } },
      { othersLimit: { answers: 1001, points: "1" } },
      { othersLimit: { answers: 1.5, points: "1" } },
      { othersLimit: { answers: "5", points: "1" } },
      { othersLimit: { answers: 5, points: "0.5" } },
      { othersLimit: { answers: 5, points: "100001" } },
      { othersLimit: { answers: 5, points: 7 } },
      { othersLimit: { answers: 5 } },
      { othersLimit: { points: "1" } },
      { othersLimit: { answers: 5, points: "1", extra: 1 } },
      { othersLimit: [] },
      { othersLimit: "1" },
      { othersLimit: null, othersBudget: "5" },
    ]) {
      expect([bad, (await patch(bad)).status]).toEqual([bad, 400]);
    }
    const stranger = await newOwner();
    expect(await api(app, stranger, "PATCH", `/api/agents/${agent.id}`, { othersLimit: null })).toEqual({ status: 404, json: { error: "not_found" } });
  });

  it("othersUsedToday is what others' use of the Agent has taken today against its own numbers: answers of both lanes, points of lane others (settled plus held); the owner's own replies and yesterday's are not in it", async () => {
    const owner = await newOwner();
    const [a, b] = await agentsOf(app, db, owner, 2);
    const caller = (await newOwner()).id;
    await reply({ agent: a!, ownerId: owner.id, lane: "others", micro: 2_500_000n, caller });
    await reply({ agent: a!, ownerId: owner.id, lane: "proactive", micro: 1_000_000n });
    await reply({ agent: a!, ownerId: owner.id, lane: "own", micro: 9_000_000n, caller: owner.id });
    await reply({ agent: a!, ownerId: owner.id, lane: "others", micro: 8_000_000n, caller, at: new Date(Date.now() - 36 * 3600_000) });
    await seedRun(db, { ownerId: owner.id, agent: a!, lane: "others", hold: 500_000n, admittedAt: new Date() });
    const view = (id: string) => api(app, owner, "GET", `/api/agents/${id}`).then((r) => r.json);
    expect((await view(a!.agentId)).othersUsedToday).toEqual({ answers: 3, points: "3" });
    expect((await view(b!.agentId)).othersUsedToday).toEqual({ answers: 0, points: "0" });
    const listed = (await api(app, owner, "GET", "/api/agents")).json.agents as Array<{ id: string; othersUsedToday: unknown }>;
    expect(listed.map((x) => [x.id, x.othersUsedToday]).sort()).toEqual(
      [
        [a!.agentId, { answers: 3, points: "3" }],
        [b!.agentId, { answers: 0, points: "0" }],
      ].sort(),
    );
  });
});

describe("perDayEstimate", () => {
  const config = () => app.deps.config;
  const owner = (answers: number, points: bigint) => ({ owner: { answers, pointsMicro: points * POINT }, agent: { answers: null, pointsMicro: null as bigint | null } });
  it("is 50 on the free tier at 70 and 1 on the paid, the answers number on a provider's model, 0 for no model and a number that cannot cover one plain hold", () => {
    expect(perDayEstimate(config(), FREE_MODEL, owner(50, 70n))).toBe(50);
    expect(perDayEstimate(config(), PAID_MODEL, owner(50, 70n))).toBe(1);
    expect(perDayEstimate(config(), { source: "provider", providerId: "p", model: "m" }, owner(40, 1n))).toBe(40);
    expect(perDayEstimate(config(), null, owner(50, 70n))).toBe(0);
    expect(perDayEstimate(config(), { source: "site", id: "gone" }, owner(50, 70n))).toBe(0);
    // The Agent's own lower numbers bind: points below one plain hold (61.5) answer nobody; answers below the estimate cap it.
    expect(perDayEstimate(config(), PAID_MODEL, { ...owner(50, 70n), agent: { answers: null, pointsMicro: 10n * POINT } })).toBe(0);
    expect(perDayEstimate(config(), FREE_MODEL, { ...owner(50, 70n), agent: { answers: 3, pointsMicro: null } })).toBe(3);
    // 1 + ⌊(points - plain hold) / plain cost⌋: free tier, hold 2.534, cost 0.84 per reply: 2.534 -> 1, 3.373 -> 1, 3.374 -> 2, 10 -> 9.
    expect(perDayEstimate(config(), FREE_MODEL, owner(50, 2n))).toBe(0);
    expect(perDayEstimate(config(), FREE_MODEL, { owner: { answers: 50, pointsMicro: 2_534_000n }, agent: { answers: null, pointsMicro: null } })).toBe(1);
    expect(perDayEstimate(config(), FREE_MODEL, { owner: { answers: 50, pointsMicro: 3_373_999n }, agent: { answers: null, pointsMicro: null } })).toBe(1);
    expect(perDayEstimate(config(), FREE_MODEL, { owner: { answers: 50, pointsMicro: 3_374_000n }, agent: { answers: null, pointsMicro: null } })).toBe(2);
    expect(perDayEstimate(config(), FREE_MODEL, owner(50, 10n))).toBe(9);
    // Paid: hold 61.5, cost 22.5 per reply.
    expect(perDayEstimate(config(), PAID_MODEL, { owner: { answers: 50, pointsMicro: 61_499_999n }, agent: { answers: null, pointsMicro: null } })).toBe(0);
    expect(perDayEstimate(config(), PAID_MODEL, { owner: { answers: 50, pointsMicro: 84_000_000n }, agent: { answers: null, pointsMicro: null } })).toBe(2);
  });
});

describe("GET /api/me/others-use", () => {
  it("answers 401 signed out; for an owner with nothing: the config's numbers, nothing used, no callers, no stopped, no Agents, no notice", async () => {
    expect((await api(app, null, "GET", "/api/me/others-use")).status).toBe(401);
    const owner = await newOwner();
    expect(await use(owner)).toEqual({
      status: 200,
      json: { limits: { answers: 50, points: "70" }, used: { answers: 0, points: "0" }, reached: false, tight: false, byPerson: [], stopped: [], agents: [], notice: false },
    });
  });

  it("limits are the owner's own when set (PUT), else the config's; used is the day's answers and settled plus held points; reached says a number is", async () => {
    const owner = await newOwner();
    const [a] = await agentsOf(app, db, owner, 1);
    const caller = (await newOwner()).id;
    await reply({ agent: a!, ownerId: owner.id, lane: "others", micro: 3_000_000n, caller });
    await reply({ agent: a!, ownerId: owner.id, lane: "proactive", micro: 1_000_000n });
    await reply({ agent: a!, ownerId: owner.id, lane: "own", micro: 50_000_000n, caller: owner.id });
    await seedRun(db, { ownerId: owner.id, agent: a!, lane: "others", hold: 500_000n, admittedAt: new Date() });
    expect((await use(owner)).json).toMatchObject({ limits: { answers: 50, points: "70" }, used: { answers: 3, points: "4.5" }, reached: false });
    const put = await api(app, owner, "PUT", "/api/me/others-limits", { answers: 7, points: "4.2" });
    expect([put.status, put.json]).toEqual([200, { answers: 7, points: "4.2" }]);
    // Settled 4 plus held 0.5 is over the number, but the Agent's reply holds some of it: another reply would wait behind it, not be refused.
    expect((await use(owner)).json).toMatchObject({ limits: { answers: 7, points: "4.2" }, used: { answers: 3, points: "4.5" }, reached: false });
    // The hold ends: 4 settled leaves 0.2, under the least a reply holds (its output alone is 0.224): reached.
    await db.query("update agent_runs set status = 'done', hold_micro = 0, finished_at = now() where owner_id = $1 and status = 'running'", [owner.id]);
    expect((await use(owner)).json).toMatchObject({ used: { answers: 3, points: "4" }, reached: true, tight: true });
    expect((await api(app, owner, "PUT", "/api/me/others-limits", { answers: 3, points: "70" })).status).toBe(200);
    expect((await use(owner)).json).toMatchObject({ limits: { answers: 3, points: "70" }, reached: true });
    expect((await db.query(`select others_answers n, others_points_micro::text p from accounts where principal_id = $1`, [owner.id])).rows).toEqual([{ n: 3, p: "70000000" }]);
  });

  it("byPerson: today's callers of the owner's others' runs (settled plus held), by points, then answers, then id, 12 people with points crossing 10 and 100", async () => {
    const owner = await newOwner();
    const [a] = await agentsOf(app, db, owner, 1);
    // [settled micro per reply, replies] and an optional held amount.
    const spec: Array<{ points: bigint[]; held?: bigint }> = [
      { points: [101_000_000n] },
      { points: [50_000_000n, 50_000_000n] },
      { points: [100_000_000n] },
      { points: [100_000_000n] },
      { points: [99_999_999n] },
      { points: [99_000_000n] },
      { points: [11_000_000n], held: 5_000_000n },
      { points: [4_000_000n, 3_000_000n, 3_000_000n] },
      { points: [10_000_000n] },
      { points: [9_500_000n] },
      { points: [1_000_000n] },
      { points: [1n] },
    ];
    const people: Actor[] = [];
    for (let i = 0; i < spec.length; i++) people.push(await newOwner());
    for (const [i, s] of spec.entries()) {
      for (const micro of s.points) await reply({ agent: a!, ownerId: owner.id, lane: "others", micro, caller: people[i]!.id });
      if (s.held) {
        const id = await seedRun(db, { ownerId: owner.id, agent: a!, lane: "others", hold: s.held, admittedAt: new Date() });
        await db.query("update agent_runs set caller_id = $2 where id = $1", [id, people[i]!.id]);
      }
    }
    // Not callers' rows: yesterday's, the owner's own reply, a proactive reply (nobody called for it).
    await reply({ agent: a!, ownerId: owner.id, lane: "others", micro: 900_000_000n, caller: people[11]!.id, at: new Date(Date.now() - 36 * 3600_000) });
    await reply({ agent: a!, ownerId: owner.id, lane: "own", micro: 900_000_000n, caller: owner.id });
    await reply({ agent: a!, ownerId: owner.id, lane: "proactive", micro: 2_000_000n });

    const got = (await use(owner)).json;
    const total = (v: bigint[]) => v.reduce((x, y) => x + y, 0n);
    const sums = spec.map((s) => total(s.points) + (s.held ?? 0n));
    const answers = spec.map((s) => s.points.length + (s.held ? 1 : 0));
    const order = people
      .map((p, i) => ({ id: p.id, points: sums[i]!, answers: answers[i]! }))
      .sort((x, y) => (x.points === y.points ? (x.answers === y.answers ? (x.id < y.id ? -1 : 1) : y.answers - x.answers) : x.points > y.points ? -1 : 1));
    expect(got.byPerson.map((r: { person: { id: string } }) => r.person.id)).toEqual(order.map((r) => r.id));
    expect(got.byPerson.map((r: { answers: number; points: string }) => [r.answers, r.points])).toEqual(order.map((r) => [r.answers, pointsText(r.points)]));
    expect(Object.keys(got.byPerson[0].person).sort()).toEqual(["avatarVersion", "displayName", "handle", "id"]);
    // Ties are really in it: two callers at exactly 100 points with one answer each.
    expect(order.filter((r) => r.points === 100_000_000n && r.answers === 1)).toHaveLength(2);
    // The owner's own total counts the proactive reply too, which no row names.
    expect(got.used).toEqual({ answers: answers.reduce((x, y) => x + y, 0) + 1, points: pointsText(sums.reduce((x, y) => x + y, 0n) + 2_000_000n) });
  });

  it("agents: each live Agent's day and its perDay (50 free tier, 1 paid, the answers number on a provider's model, 0 for a number below one plain hold); a deleted Agent is not listed", async () => {
    const owner = await newOwner();
    const [free, paid, tiny, limited] = [
      (await agentsOf(app, db, owner, 1, FREE_MODEL))[0]!,
      (await agentsOf(app, db, owner, 1, PAID_MODEL))[0]!,
      (await agentsOf(app, db, owner, 1, PAID_MODEL))[0]!,
      (await agentsOf(app, db, owner, 1, FREE_MODEL))[0]!,
    ];
    const provider = await providerAgent(app, db, owner);
    const doomed = (await agentsOf(app, db, owner, 1))[0]!;
    await db.query("update agents set others_budget_micro = 10000000 where principal_id = $1", [tiny.agentId]); // M-V2: 10 points on the paid tier
    await db.query("update agents set others_answers = 3 where principal_id = $1", [limited.agentId]);
    expect((await api(app, owner, "DELETE", `/api/agents/${doomed.agentId}`)).status).toBe(200);
    await reply({ agent: free, ownerId: owner.id, lane: "others", micro: 1_500_000n });
    const got = (await use(owner)).json.agents as Array<{ agentId: string; answers: number; points: string; perDay: number }>;
    const byId = new Map(got.map((x) => [x.agentId, x]));
    expect(got).toHaveLength(5);
    expect(byId.has(doomed.agentId)).toBe(false);
    expect(byId.get(free.agentId)).toEqual({ agentId: free.agentId, answers: 1, points: "1.5", perDay: 50, reached: false, tight: false });
    expect(byId.get(paid.agentId)).toEqual({ agentId: paid.agentId, answers: 0, points: "0", perDay: 1, reached: false, tight: true });
    expect(byId.get(tiny.agentId)).toMatchObject({ perDay: 0 });
    expect(byId.get(limited.agentId)).toMatchObject({ perDay: 3 });
    expect(byId.get(provider.agentId)).toMatchObject({ perDay: 50 });
    // The owner's own lower numbers bind every Agent: 61.5 + nothing left on a paid model, 5 answers on the rest.
    await setOwnerNumbers(db, owner.id, { answers: 5, pointsMicro: 70n * POINT });
    const lowered = new Map(((await use(owner)).json.agents as Array<{ agentId: string; perDay: number }>).map((x) => [x.agentId, x.perDay]));
    expect([lowered.get(free.agentId), lowered.get(paid.agentId), lowered.get(limited.agentId), lowered.get(provider.agentId)]).toEqual([5, 1, 3, 5]);
  });

  it("notice: true while the owner has an Agent, has not seen it and the account is older than 074; POST seen ends it for good, even for an Agent made later; a new owner is told nothing", async () => {
    const old = async (who: Actor) => void (await db.query("update accounts set created_at = '2000-01-01T00:00:00Z' where principal_id = $1", [who.id]));
    const owner = await newOwner();
    expect((await use(owner)).json.notice).toBe(false);
    await mustCreateAgent(app, owner, {});
    await old(owner); // (an Agent's creation makes the account row)
    expect((await use(owner)).json.notice).toBe(true);
    expect(await api(app, owner, "POST", "/api/me/others-limits/seen")).toEqual({ status: 200, json: { ok: true } });
    expect((await use(owner)).json.notice).toBe(false);
    expect(await api(app, owner, "POST", "/api/me/others-limits/seen")).toEqual({ status: 200, json: { ok: true } });
    await mustCreateAgent(app, owner, {});
    expect((await use(owner)).json.notice).toBe(false);
    // An owner whose only Agent is deleted has nothing to be told about.
    const other = await newOwner();
    const only = await mustCreateAgent(app, other, {});
    await old(other);
    await api(app, other, "DELETE", `/api/agents/${only.id}`);
    expect((await use(other)).json.notice).toBe(false);
    // An owner who joined after the change (their account is newer than 074) is told nothing about a change they never had.
    const fresh = await newOwner();
    await mustCreateAgent(app, fresh, {});
    expect((await use(fresh)).json.notice).toBe(false);
    expect((await api(app, null, "POST", "/api/me/others-limits/seen")).status).toBe(401);
  });

  it("stopped is [] while the switch is off", async () => {
    const owner = await newOwner();
    expect((await use(owner)).json.stopped).toEqual([]);
  });
});

describe("reached and tight: two one-sided facts, each by the function admission asks", () => {
  const config = () => app.deps.config;
  const POINTS_70 = 70n * POINT;
  const room = async (id: string) => {
    const json = (await use(await ownerOf(id))).json;
    return json;
  };
  const owners = new Map<string, Actor>();
  const ownerOf = async (id: string) => owners.get(id)!;
  /** An owner with one Agent on `model` and `settled` points taken today, so that `left` is what remains of 70. */
  async function world(model: typeof FREE_MODEL | typeof PAID_MODEL, left: (floor: bigint, ceiling: bigint) => bigint) {
    const owner = await newOwner();
    owners.set(owner.id, owner);
    const [agent] = await agentsOf(app, db, owner, 1, model);
    const row = (await readOwnedAgent(db, owner.id, agent!.agentId))!;
    const floor = await othersPlainFloor(db, config(), row, null, new Date(), "others");
    const ceiling = await othersPlainCeiling(db, config(), row, new Date());
    const settled = POINTS_70 - left(floor, ceiling);
    if (settled > 0n) await reply({ agent: agent!, ownerId: owner.id, lane: "others", micro: settled, caller: (await newOwner()).id });
    return { owner, agent: agent!, row, floor, ceiling };
  }
  const states = async (owner: Actor) => {
    const got = (await use(owner)).json;
    return { owner: [got.reached, got.tight], agents: got.agents.map((a: { reached: boolean; tight: boolean }) => [a.reached, a.tight]) };
  };

  it("the numbers: the floor is the system text and the 800-token output, the ceiling adds the fullest scene, the summary and 3 x the context cap", async () => {
    const free = await world(FREE_MODEL, () => POINTS_70);
    expect(free.floor).toBeGreaterThan(224_000n);
    expect(free.floor).toBeLessThan(2_534_000n);
    expect(free.ceiling).toBeGreaterThan(free.floor);
    // 12 000 tokens of conversation are 36 000 bytes at most; the fullest scene and the summary add to that: under 12 points on the free tier.
    expect(free.ceiling).toBeLessThan(12_000_000n);
    expect(free.ceiling).toBeGreaterThan(36_000n * 140n);
    // The paid tier's plain hold at 3 000 µpt an input byte: 36 000 bytes of conversation alone are 108 points, over the owner's 70: the real
    // bound makes "fits for every reply" impossible there, so a paid-tier Agent reads tight from the start, and not reached.
    const paid = await world(PAID_MODEL, () => POINTS_70);
    expect(paid.ceiling).toBeGreaterThan(70_000_000n);
    expect(paid.floor).toBeLessThan(70_000_000n);
    expect(await states(paid.owner)).toEqual({ owner: [false, true], agents: [[false, true]] });
  });

  it("a free-tier Agent with an ordinary persona at 70 points and nothing used is neither tight nor reached", async () => {
    const w = await world(FREE_MODEL, () => POINTS_70);
    expect(await states(w.owner)).toEqual({ owner: [false, false], agents: [[false, false]] });
  });

  it("notes the Agent holds raise its ceiling (a group is shown a subset of them); a memory-off Agent's do not count", async () => {
    const noted = await world(FREE_MODEL, () => POINTS_70);
    const of0 = async () => othersPlainCeiling(db, config(), (await readOwnedAgent(db, noted.owner.id, noted.agent.agentId))!, new Date());
    const base = await of0();
    for (let i = 0; i < 40; i++) await db.query("insert into agent_notes (agent_id, text, vault) values ($1, $2, false)", [noted.agent.agentId, `笔记${i}`.repeat(30)]);
    expect(await of0()).toBeGreaterThan(base + 40n * 140n * 100n);
    await db.query("update agents set memory = false where principal_id = $1", [noted.agent.agentId]);
    expect(await of0()).toBe(base);
  });

  it("R2-M1: the floor is built by lane: an others' reply's own text (the called sentence) is shorter than the proactive text, so its floor is lower", async () => {
    const w = await world(FREE_MODEL, () => POINTS_70);
    const others = await othersPlainFloor(db, config(), w.row, null, new Date(), "others");
    const proactive = await othersPlainFloor(db, config(), w.row, null, new Date(), "proactive");
    // The unasked passage is 69 to 113 bytes longer; at 140 µpt a byte that is at least 9 660.
    expect(proactive - others).toBeGreaterThanOrEqual(69n * 140n);
    expect(proactive - others).toBeLessThanOrEqual(113n * 140n);
  });

  it("R2-M2: the attachments' constants are added after the clamp: min(text, context - output) + the cap", async () => {
    const small = { ...config(), siteModels: config().siteModels.map((m) => (m.id === FREE_MODEL.id ? { ...m, contextTokens: 20_000 } : m)) };
    const site = small.siteModels.find((m) => m.id === FREE_MODEL.id)!;
    const out = Math.min(site.maxOutputTokens, small.others.outputTokens);
    const cap = Math.max(small.agentGroupContextTokens, small.others.contextWeight);
    // The helper: the text clamps, the constants do not.
    expect(othersFloorHold(small, FREE_MODEL, 10_000_000, 1_500)).toBe(othersFloorHold(small, FREE_MODEL, 20_000 - out) + 1_500n * BigInt(site.inputMicroPerToken));
    expect(othersFloorHold(small, FREE_MODEL, 1_000, 1_500)).toBe(othersFloorHold(small, FREE_MODEL, 1_000) + 1_500n * BigInt(site.inputMicroPerToken));
    // The ceiling: a model whose context the text bound reaches holds the clamp plus the most constants a plan can hold.
    const w = await world(FREE_MODEL, () => POINTS_70);
    expect(await othersPlainCeiling(db, small, w.row, new Date())).toBe(othersFloorHold(small, FREE_MODEL, 10_000_000, cap));
  });

  it("R2-M3: the notes clause of the secrets sentence is counted: with notes the ceiling grows by the passage, its two separators and the clause", async () => {
    const w = await world(FREE_MODEL, () => POINTS_70);
    const of0 = async () => othersPlainCeiling(db, config(), (await readOwnedAgent(db, w.owner.id, w.agent.agentId))!, new Date());
    const base = await of0();
    await db.query("insert into agent_notes (agent_id, text, vault) values ($1, $2, false)", [w.agent.agentId, "一条笔记"]);
    const row = (await readOwnedAgent(db, w.owner.id, w.agent.agentId))!;
    const all = await notesFor(db, row, { conversationId: "", group: false });
    const passage = notesPassage({ owner: all.owner, self: all.self, hearsay: [] }, "group", config().siteTimezone, "");
    const delta = (await of0()) - base;
    const bytes = Buffer.byteLength(passage, "utf8");
    expect(bytes).toBeGreaterThan(0);
    // 140 µpt a byte, no clamp: the passage, its two separator bytes, and the clause.
    expect(delta).toBe(BigInt(bytes + 2 + Buffer.byteLength(NOTES_SECRET_CLAUSE, "utf8")) * 140n);
  });

  it("one micro-point below the floor: reached (and tight); at the floor: not reached, tight", async () => {
    const below = await world(FREE_MODEL, (f) => f - 1n);
    expect(await states(below.owner)).toEqual({ owner: [true, true], agents: [[true, true]] });
    expect(await othersCheck(db, config(), { id: NO_RUN, ownerId: below.owner.id, agentId: below.agent.agentId, lane: "others" }, below.floor, "admission", new Date())).toEqual({ ok: false, limit: "points" });
    const at = await world(FREE_MODEL, (f) => f);
    expect(await states(at.owner)).toEqual({ owner: [false, true], agents: [[false, true]] });
    expect(await othersCheck(db, config(), { id: NO_RUN, ownerId: at.owner.id, agentId: at.agent.agentId, lane: "others" }, at.floor, "admission", new Date())).toEqual({ ok: true });
  });

  it("between the floor and the ceiling: tight only; at the ceiling and above: neither", async () => {
    const between = await world(FREE_MODEL, (f, c) => (f + c) / 2n);
    expect(await states(between.owner)).toEqual({ owner: [false, true], agents: [[false, true]] });
    const justBelow = await world(FREE_MODEL, (_f, c) => c - 1n);
    expect((await states(justBelow.owner)).agents).toEqual([[false, true]]);
    const atCeiling = await world(FREE_MODEL, (_f, c) => c);
    expect(await states(atCeiling.owner)).toEqual({ owner: [false, false], agents: [[false, false]] });
    const plenty = await world(FREE_MODEL, () => POINTS_70);
    expect(await states(plenty.owner)).toEqual({ owner: [false, false], agents: [[false, false]] });
  });

  it("the review's examples are tight, not reached: a short reply fits (free tier 2.5 left, paid tier 47.5 left)", async () => {
    const free = await world(FREE_MODEL, () => 2_500_000n);
    expect(await states(free.owner)).toEqual({ owner: [false, true], agents: [[false, true]] });
    expect(await othersCheck(db, config(), { id: NO_RUN, ownerId: free.owner.id, agentId: free.agent.agentId, lane: "others" }, 1_000_000n, "admission", new Date())).toEqual({ ok: true });
    const paid = await world(PAID_MODEL, () => 47_500_000n);
    expect(await states(paid.owner)).toEqual({ owner: [false, true], agents: [[false, true]] });
    expect(await othersCheck(db, config(), { id: NO_RUN, ownerId: paid.owner.id, agentId: paid.agent.agentId, lane: "others" }, paid.floor, "admission", new Date())).toEqual({ ok: true });
  });

  it("a long-persona Agent whose floor exceeds what is left is reached, where the same room still serves a short persona", async () => {
    const short = await world(FREE_MODEL, () => 5_000_000n);
    expect((await states(short.owner)).agents).toEqual([[false, true]]);
    const long = await world(FREE_MODEL, () => 5_000_000n);
    await db.query("update agents set persona = $2 where principal_id = $1", [long.agent.agentId, "汉".repeat(20_000)]);
    const row = (await readOwnedAgent(db, long.owner.id, long.agent.agentId))!;
    expect(await othersPlainFloor(db, config(), row, null, new Date(), "others")).toBeGreaterThan(5_000_000n);
    expect(await states(long.owner)).toEqual({ owner: [true, true], agents: [[true, true]] });
  });

  it("an Agent on its owner's own provider key holds nothing: only the answers reach it", async () => {
    const owner = await newOwner();
    const byok = await providerAgent(app, db, owner);
    const [free] = await agentsOf(app, db, owner, 1, FREE_MODEL);
    await reply({ agent: free!, ownerId: owner.id, lane: "others", micro: 80_000_000n, caller: (await newOwner()).id });
    const got = (await use(owner)).json;
    const row = (id: string) => got.agents.find((a: { agentId: string }) => a.agentId === id);
    expect([row(byok.agentId).reached, row(byok.agentId).tight, row(free!.agentId).reached, got.reached, got.tight]).toEqual([false, false, true, false, true]);
    await setOwnerNumbers(db, owner.id, { answers: 1, pointsMicro: POINTS_70 });
    const capped = (await use(owner)).json;
    expect([capped.agents.every((a: { reached: boolean }) => a.reached), capped.reached]).toEqual([true, true]);
  });

  it("an Agent whose own sub-limit binds is reached alone: the owner is not, while another Agent can still answer", async () => {
    const owner = await newOwner();
    const [a, b] = await agentsOf(app, db, owner, 2, FREE_MODEL);
    await db.query("update agents set others_budget_micro = 1000000 where principal_id = $1", [a!.agentId]);
    await db.query("update agents set persona = $2 where principal_id = $1", [a!.agentId, "汉".repeat(12_000)]); // its floor is over its 1 point
    const got = (await use(owner)).json;
    const row = (id: string) => got.agents.find((x: { agentId: string }) => x.agentId === id);
    expect([row(a!.agentId).reached, row(b!.agentId).reached, got.reached, got.tight]).toEqual([true, false, false, true]);
  });

  it("the answers cap alone makes reached true, with points to spare", async () => {
    const owner = await newOwner();
    const [a, b] = await agentsOf(app, db, owner, 2, FREE_MODEL);
    await setOwnerNumbers(db, owner.id, { answers: 2, pointsMicro: POINTS_70 });
    const caller = (await newOwner()).id;
    await reply({ agent: a!, ownerId: owner.id, lane: "others", micro: 1n, caller });
    expect((await use(owner)).json.reached).toBe(false);
    await reply({ agent: b!, ownerId: owner.id, lane: "others", micro: 1n, caller });
    const got = (await use(owner)).json;
    expect([got.used, got.reached, got.tight, got.agents.map((x: { reached: boolean }) => x.reached)]).toEqual([{ answers: 2, points: "0.000002" }, true, true, [true, true]]);
  });

  it("an Agent with no model answers nobody: its row is not reached, not tight, perDay 0, and it does not stop the owner's reached", async () => {
    const owner = await newOwner();
    const [free] = await agentsOf(app, db, owner, 1, FREE_MODEL);
    const bare = await mustCreateAgent(app, owner, {}); // a new Agent's model is null
    const settled = POINTS_70 - 100_000n; // under any floor
    await reply({ agent: free!, ownerId: owner.id, lane: "others", micro: settled, caller: (await newOwner()).id });
    const got = (await use(owner)).json;
    const row = (id: string) => got.agents.find((x: { agentId: string }) => x.agentId === id);
    expect(row(bare.id)).toMatchObject({ reached: false, tight: false, perDay: 0 });
    expect(row(free!.agentId)).toMatchObject({ reached: true, tight: true });
    expect([got.reached, got.tight]).toEqual([true, true]);
  });

  it("waiting behind others' holds is not reached", async () => {
    const owner = await newOwner();
    const [a, b] = await agentsOf(app, db, owner, 2, FREE_MODEL);
    await setOwnerNumbers(db, owner.id, { answers: 50, pointsMicro: 5n * POINT });
    await seedRun(db, { ownerId: owner.id, agent: b!, lane: "others", hold: 4_900_000n, admittedAt: new Date() });
    expect(await othersCheck(db, config(), { id: NO_RUN, ownerId: owner.id, agentId: a!.agentId, lane: "others" }, 2_534_000n, "admission", new Date())).toMatchObject({ ok: false, heldBackBy: expect.any(Array) });
    const got = (await use(owner)).json;
    expect([got.reached, got.agents.map((x: { reached: boolean }) => x.reached)]).toEqual([false, [false, false]]);
  });
});

describe("one definition of used", () => {
  it("per Agent the page's figures are what enforcement counts (othersUsedToday), and the callers' rows add up to the lane's total", async () => {
    const owner = await newOwner();
    const [a, b] = await agentsOf(app, db, owner, 2, FREE_MODEL);
    const people = [await newOwner(), await newOwner(), await newOwner()];
    for (let i = 0; i < 12; i++) await reply({ agent: i % 2 ? a! : b!, ownerId: owner.id, lane: i % 5 === 0 ? "proactive" : "others", micro: BigInt((i + 1) * 1_100_000), caller: i % 5 === 0 ? null : people[i % 3]!.id });
    await seedRun(db, { ownerId: owner.id, agent: a!, lane: "others", hold: 2_000_000n, admittedAt: new Date() });
    const now = new Date();
    const by = await othersUsedByAgents(db, app.deps.config, owner.id, [a!.agentId, b!.agentId], now);
    for (const agent of [a!, b!]) {
      const answers = (await othersUsedToday(db, app.deps.config, owner.id, now, { agentId: agent.agentId })).answers;
      const pts = await othersUsedToday(db, app.deps.config, owner.id, now, { agentId: agent.agentId, lane: "others" });
      expect(by.get(agent.agentId)).toEqual({ answers, pointsMicro: pts.settledMicro + pts.heldMicro });
    }
    const lane = await othersUsedToday(db, app.deps.config, owner.id, now, { lane: "others" });
    const rows = (await use(owner)).json.byPerson as Array<{ points: string }>;
    const sum = rows.reduce((t, r) => t + BigInt(Math.round(Number(r.points) * 1_000_000)), 0n);
    expect(sum).toBe(lane.settledMicro + lane.heldMicro - 2_000_000n); // the seeded hold has no caller
  });
});

describe("PUT /api/me/others-limits", () => {
  it("takes both numbers, answers 1 to 1000 and points 1 to 100 000 as a decimal string, and nothing else", async () => {
    const owner = await newOwner();
    const put = (body: unknown) => api(app, owner, "PUT", "/api/me/others-limits", body);
    expect(await put({ answers: 1000, points: "100000" })).toEqual({ status: 200, json: { answers: 1000, points: "100000" } });
    expect(await put({ answers: 1, points: "1" })).toEqual({ status: 200, json: { answers: 1, points: "1" } });
    expect(await put({ answers: 20, points: "12.345678" })).toEqual({ status: 200, json: { answers: 20, points: "12.345678" } });
    for (const bad of [{}, { answers: 20 }, { points: "5" }, { answers: 0, points: "5" }, { answers: 1001, points: "5" }, { answers: 1.5, points: "5" }, { answers: "20", points: "5" }, { answers: null, points: "5" }, { answers: 20, points: "0.999999" }, { answers: 20, points: "100000.000001" }, { answers: 20, points: 5 }, { answers: 20, points: "1e3" }, { answers: 20, points: "-5" }, { answers: 20, points: "5", note: 1 }, [], null]) {
      expect([bad, (await put(bad)).status]).toEqual([bad, 400]);
    }
    expect((await use(owner)).json.limits).toEqual({ answers: 20, points: "12.345678" });
    expect((await api(app, null, "PUT", "/api/me/others-limits", { answers: 20, points: "5" })).status).toBe(401);
  });

  it("is one owner's: another owner's day and numbers are untouched", async () => {
    const [a, b] = [await newOwner(), await newOwner()];
    await api(app, a, "PUT", "/api/me/others-limits", { answers: 2, points: "3" });
    expect((await use(b)).json.limits).toEqual({ answers: 50, points: "70" });
  });
});

/** What the use route shows of points: whole points when there is no fraction, as `formatPoints`. */
function pointsText(micro: bigint): string {
  const whole = micro / POINT;
  const frac = (micro % POINT).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

describe("the stopped list's output shape (independent of the table: lane I swaps the one query)", () => {
  it("is [{person: {id, handle, displayName, avatarVersion}, since: ISO string}], in the order given, and nothing else", () => {
    const row = (id: string, since: string) => ({ id, handle: `h${id}`, name: `n${id}`, avatar_version: 3, since: new Date(since) });
    expect(stoppedShape([row("a", "2026-03-02T01:00:00Z"), row("b", "2026-03-01T01:00:00Z")])).toEqual([
      { person: { id: "a", handle: "ha", displayName: "na", avatarVersion: 3 }, since: "2026-03-02T01:00:00.000Z" },
      { person: { id: "b", handle: "hb", displayName: "nb", avatarVersion: 3 }, since: "2026-03-01T01:00:00.000Z" },
    ]);
    expect(stoppedShape([])).toEqual([]);
  });

  it("reads the caller's own stop rows of lane A's ruled table (setter_id, other_id, kind, since), newest first, and nothing else (rolled-back transaction)", async () => {
    const owner = await newOwner();
    const [p1, p2, p3, p4, p5] = [await newOwner(), await newOwner(), await newOwner(), await newOwner(), await newOwner()];
    const client = await db.pool.connect();
    try {
      await client.query("begin");
      await client.query(`create table access_bars (
        setter_id uuid not null references principals (id) on delete cascade, other_id uuid not null references principals (id) on delete cascade,
        kind text not null check (kind in ('stop', 'block')), since timestamptz not null default now(), primary key (setter_id, other_id, kind))`);
      const bar = (setter: Actor, other: Actor, kind: string, since: string) =>
        client.query("insert into access_bars (setter_id, other_id, kind, since) values ($1, $2, $3, $4)", [setter.id, other.id, kind, since]);
      await bar(owner, p1, "stop", "2026-03-01T01:00:00Z");
      await bar(owner, p2, "stop", "2026-03-02T01:00:00Z");
      await bar(owner, p2, "block", "2026-03-02T02:00:00Z"); // a block's row: not a stop
      await bar(owner, p3, "block", "2026-03-03T01:00:00Z");
      await bar(p4, owner, "stop", "2026-03-04T01:00:00Z"); // somebody else stopped it
      await bar(p5, owner, "block", "2026-03-05T01:00:00Z");
      await bar(p1, p2, "stop", "2026-03-06T01:00:00Z");
      expect((await stoppedOf(client, owner.id)).map((r) => [r.person.id, r.since])).toEqual([
        [p2.id, "2026-03-02T01:00:00.000Z"],
        [p1.id, "2026-03-01T01:00:00.000Z"],
      ]);
      expect((await stoppedOf(client, owner.id))[0]!.person).toEqual({ id: p2.id, handle: p2.handle, displayName: expect.any(String), avatarVersion: expect.any(Number) });
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("is [] where no table of bars exists (the guard)", async () => {
    const owner = await newOwner();
    expect(await stoppedOf(db, owner.id)).toEqual([]);
  });
});

describe("the stopped list with the switch on and no access_bars table yet", () => {
  // Lane B's branch has no 075: the route reads the table only where it exists, so it never names a table this branch lacks.
  const social = useApp({ env, agentWorker: false, config: SOCIAL_ON });
  it("answers [] (and 200) when the switch is on and the table is not there", async () => {
    const owner = await signUp(social.app, `sw${++n}x${Math.floor(Math.random() * 1e6)}`);
    const res = await api(social.app, owner, "GET", "/api/me/others-use");
    expect([res.status, res.json.stopped]).toEqual([200, []]);
  });
});
