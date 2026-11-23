import { afterEach, describe, expect, it } from "vitest";
import { stoppedOf } from "../src/accounts/others-routes.ts";
import { perDayEstimate } from "../src/metering/others.ts";
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
      json: { limits: { answers: 50, points: "70" }, used: { answers: 0, points: "0" }, reached: false, byPerson: [], stopped: [], agents: [], notice: false },
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
    const put = await api(app, owner, "PUT", "/api/me/others-limits", { answers: 7, points: "4.5" });
    expect([put.status, put.json]).toEqual([200, { answers: 7, points: "4.5" }]);
    // Settled 4 plus held 0.5 is the number: reached (the same sum the cap is decided by).
    expect((await use(owner)).json).toMatchObject({ limits: { answers: 7, points: "4.5" }, used: { answers: 3, points: "4.5" }, reached: true });
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
    expect(byId.get(free.agentId)).toEqual({ agentId: free.agentId, answers: 1, points: "1.5", perDay: 50 });
    expect(byId.get(paid.agentId)).toEqual({ agentId: paid.agentId, answers: 0, points: "0", perDay: 1 });
    expect(byId.get(tiny.agentId)).toMatchObject({ perDay: 0 });
    expect(byId.get(limited.agentId)).toMatchObject({ perDay: 3 });
    expect(byId.get(provider.agentId)).toMatchObject({ perDay: 50 });
    // The owner's own lower numbers bind every Agent: 61.5 + nothing left on a paid model, 5 answers on the rest.
    await setOwnerNumbers(db, owner.id, { answers: 5, pointsMicro: 70n * POINT });
    const lowered = new Map(((await use(owner)).json.agents as Array<{ agentId: string; perDay: number }>).map((x) => [x.agentId, x.perDay]));
    expect([lowered.get(free.agentId), lowered.get(paid.agentId), lowered.get(limited.agentId), lowered.get(provider.agentId)]).toEqual([5, 1, 3, 5]);
  });

  it("notice: true while the owner has an Agent and has not seen it; POST seen ends it for good, even for an Agent made later", async () => {
    const owner = await newOwner();
    expect((await use(owner)).json.notice).toBe(false);
    const agent = await mustCreateAgent(app, owner, {});
    expect((await use(owner)).json.notice).toBe(true);
    expect(await api(app, owner, "POST", "/api/me/others-limits/seen")).toEqual({ status: 200, json: { ok: true } });
    expect((await use(owner)).json.notice).toBe(false);
    expect(await api(app, owner, "POST", "/api/me/others-limits/seen")).toEqual({ status: 200, json: { ok: true } });
    await mustCreateAgent(app, owner, {});
    expect((await use(owner)).json.notice).toBe(false);
    // An owner whose only Agent is deleted has nothing to be told about.
    const other = await newOwner();
    const only = await mustCreateAgent(app, other, {});
    await api(app, other, "DELETE", `/api/agents/${only.id}`);
    expect((await use(other)).json.notice).toBe(false);
    expect((await api(app, null, "POST", "/api/me/others-limits/seen")).status).toBe(401);
    void agent;
  });

  it("stopped is [] while the switch is off", async () => {
    const owner = await newOwner();
    expect((await use(owner)).json.stopped).toEqual([]);
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

describe("the stopped list (lane A's 075 is not in this branch: access_bars is made inside a rolled-back transaction)", () => {
  it("lists the bars this owner set with reason stopped that no block made, newest first, and nothing else", async () => {
    const owner = await newOwner();
    const [p1, p2, p3, p4, p5] = [await newOwner(), await newOwner(), await newOwner(), await newOwner(), await newOwner()];
    const client = await db.pool.connect();
    try {
      await client.query("begin");
      await client.query(`create table access_bars (
        lo_id uuid not null references principals (id) on delete cascade, hi_id uuid not null references principals (id) on delete cascade,
        reason text not null check (reason in ('stopped', 'unfriended')), set_by uuid not null references principals (id) on delete cascade,
        since timestamptz not null default now(), by_block boolean not null default false, primary key (lo_id, hi_id))`);
      const bar = async (x: Actor, y: Actor, o: { by: Actor; reason?: string; byBlock?: boolean; since: string }) => {
        const [lo, hi] = [x.id, y.id].sort();
        await client.query(`insert into access_bars (lo_id, hi_id, reason, set_by, since, by_block) values ($1, $2, $3, $4, $5, $6)`, [lo, hi, o.reason ?? "stopped", o.by.id, o.since, o.byBlock ?? false]);
      };
      await bar(owner, p1, { by: owner, since: "2026-03-01T01:00:00Z" });
      await bar(owner, p2, { by: owner, since: "2026-03-02T01:00:00Z" });
      await bar(owner, p3, { by: owner, since: "2026-03-03T01:00:00Z", byBlock: true }); // a block's bar: lifted by unblocking, not listed
      await bar(owner, p4, { by: p4, since: "2026-03-04T01:00:00Z" }); // the other person stopped it: not this owner's
      await bar(owner, p5, { by: owner, since: "2026-03-05T01:00:00Z", reason: "unfriended" });
      await bar(p1, p2, { by: p1, since: "2026-03-06T01:00:00Z" });
      expect(await stoppedOf(client, owner.id)).toEqual([
        { person: { id: p2.id, handle: p2.handle, displayName: expect.any(String), avatarVersion: expect.any(Number) }, since: "2026-03-02T01:00:00.000Z" },
        { person: { id: p1.id, handle: p1.handle, displayName: expect.any(String), avatarVersion: expect.any(Number) }, since: "2026-03-01T01:00:00.000Z" },
      ]);
    } finally {
      await client.query("rollback");
      client.release();
    }
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
