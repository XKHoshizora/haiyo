import { afterEach, describe, expect, it } from "vitest";
import { stoppedOf, stoppedShape } from "../src/accounts/others-routes.ts";
import { othersUseToday } from "../src/metering/others.ts";
import { api, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { paidReply } from "./helpers/metering.ts";
import { agentsOf, OTHERS_ENV, POINT, seedRun } from "./helpers/others.ts";
import { SOCIAL_ON } from "./helpers/social.ts";
import { closeAllSockets } from "./helpers/ws.ts";

/**
 * The use routes of the owner's one number for others' use (the limits redesign, Part 1): `GET /api/me/others-use`,
 * `PUT /api/me/others-limits`, `POST /api/me/others-limits/seen`, and what they say of the owner's day — by the one measure admission
 * decides by (metering/others.ts `othersUseToday`). One number per owner, 300 points unless the owner says otherwise.
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

describe("GET /api/me/others-use", () => {
  it("answers 401 signed out; for an owner with nothing: the config's number, nothing used, no callers, no stopped, no notice", async () => {
    expect((await api(app, null, "GET", "/api/me/others-use")).status).toBe(401);
    const owner = await newOwner();
    expect(await use(owner)).toEqual({
      status: 200,
      json: { limit: "300", used: "0", proactive: "0", ownKeyPoints: "6", reached: false, byPerson: [], stopped: [], notice: false },
    });
  });

  it("the limit is the owner's own when set (PUT), else the config's; used is the day's settled charges of both lanes, never what running replies hold; reached says used is at the number", async () => {
    const owner = await newOwner();
    const [a] = await agentsOf(app, db, owner, 1);
    const caller = (await newOwner()).id;
    await reply({ agent: a!, ownerId: owner.id, lane: "others", micro: 3_000_000n, caller });
    await reply({ agent: a!, ownerId: owner.id, lane: "proactive", micro: 1_000_000n });
    await reply({ agent: a!, ownerId: owner.id, lane: "own", micro: 50_000_000n, caller: owner.id });
    await seedRun(db, { ownerId: owner.id, agent: a!, lane: "others", hold: 500_000n, admittedAt: new Date() });
    expect((await use(owner)).json).toMatchObject({ limit: "300", used: "4", proactive: "1", reached: false });
    const put = await api(app, owner, "PUT", "/api/me/others-limits", { points: "4.2" });
    expect([put.status, put.json]).toEqual([200, { points: "4.2" }]);
    // The running reply's hold is no use: 4 settled is under 4.2.
    expect((await use(owner)).json).toMatchObject({ limit: "4.2", used: "4", reached: false });
    expect((await api(app, owner, "PUT", "/api/me/others-limits", { points: "4" })).status).toBe(200);
    expect((await use(owner)).json).toMatchObject({ limit: "4", used: "4", reached: true });
    expect((await db.query(`select others_points_micro::text p from accounts where principal_id = $1`, [owner.id])).rows).toEqual([{ p: "4000000" }]);
  });

  it("byPerson: today's callers of the owner's others' replies, by what their replies used (settled), then id, 12 people with points crossing 10 and 100", async () => {
    const owner = await newOwner();
    const [a] = await agentsOf(app, db, owner, 1);
    // Settled micro per reply, and an optional held amount (a reply under way: it is no use until it settles).
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
    const sums = spec.map((s) => total(s.points));
    const order = people.map((p, i) => ({ id: p.id, points: sums[i]! })).sort((x, y) => (x.points === y.points ? (x.id < y.id ? -1 : 1) : x.points > y.points ? -1 : 1));
    expect(got.byPerson.map((r: { person: { id: string } }) => r.person.id)).toEqual(order.map((r) => r.id));
    expect(got.byPerson.map((r: { points: string }) => r.points)).toEqual(order.map((r) => pointsText(r.points)));
    expect(Object.keys(got.byPerson[0]).sort()).toEqual(["person", "points"]);
    expect(Object.keys(got.byPerson[0].person).sort()).toEqual(["avatarVersion", "displayName", "handle", "id"]);
    // Ties are really in it: two callers at exactly 100 points, and two at 100 with replies of 50 and one of 100.
    expect(order.filter((r) => r.points === 100_000_000n)).toHaveLength(3);
    // The owner's own total counts the proactive reply too, which no row names; and it is the measure admission reads.
    expect([got.used, got.proactive]).toEqual([pointsText(sums.reduce((x, y) => x + y, 0n) + 2_000_000n), "2"]);
    expect(got.used).toBe(pointsText(await othersUseToday(db, app.deps.config, owner.id, new Date())));
  });

  it("notice: true while the owner has an Agent, has not seen it and the account is older than 074; POST seen ends it for good, even for an Agent made later; a new owner is told nothing", async () => {
    const old = async (who: Actor) => void (await db.query("update accounts set created_at = '2000-01-01T00:00:00Z' where principal_id = $1", [who.id]));
    /** The Agent, too, is one from before 074. */
    const oldAgent = async (id: string) => void (await db.query("update agents set created_at = '2000-01-02T00:00:00Z' where principal_id = $1", [id]));
    const owner = await newOwner();
    expect((await use(owner)).json.notice).toBe(false);
    const first = await mustCreateAgent(app, owner, {});
    await old(owner); // (an Agent's creation makes the account row)
    // m2 (fix round 1): an account older than the change (a grant made its row) whose first Agent was made AFTER it is told nothing.
    expect((await use(owner)).json.notice).toBe(false);
    await oldAgent(first.id);
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
    await oldAgent(only.id);
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

describe("PUT /api/me/others-limits", () => {
  it("takes the one number, points 1 to 100 000 as a decimal string, and nothing else (the old answers number is no key any more)", async () => {
    const owner = await newOwner();
    const put = (body: unknown) => api(app, owner, "PUT", "/api/me/others-limits", body);
    expect(await put({ points: "100000" })).toEqual({ status: 200, json: { points: "100000" } });
    expect(await put({ points: "1" })).toEqual({ status: 200, json: { points: "1" } });
    expect(await put({ points: "12.345678" })).toEqual({ status: 200, json: { points: "12.345678" } });
    for (const bad of [{}, { answers: 20 }, { answers: 20, points: "5" }, { points: "0.999999" }, { points: "100000.000001" }, { points: 5 }, { points: "1e3" }, { points: "-5" }, { points: "5", note: 1 }, [], null]) {
      expect([bad, (await put(bad)).status]).toEqual([bad, 400]);
    }
    expect((await use(owner)).json.limit).toBe("12.345678");
    expect((await api(app, null, "PUT", "/api/me/others-limits", { points: "5" })).status).toBe(401);
  });

  it("is one owner's: another owner's day and number are untouched", async () => {
    const [a, b] = [await newOwner(), await newOwner()];
    await api(app, a, "PUT", "/api/me/others-limits", { points: "3" });
    expect((await use(b)).json.limit).toBe("300");
  });
});

/** What the use route shows of points: whole points when there is no fraction, as `formatPoints`. */
function pointsText(micro: bigint): string {
  const whole = micro / POINT;
  const frac = (micro % POINT).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

describe("the stopped list: its output shape and its one query over migration 075's access_bars", () => {
  it("is [{person: {id, handle, displayName, avatarVersion}, since: ISO string}], in the order given, and nothing else", () => {
    const row = (id: string, since: string) => ({ id, handle: `h${id}`, name: `n${id}`, avatar_version: 3, since: new Date(since) });
    expect(stoppedShape([row("a", "2026-03-02T01:00:00Z"), row("b", "2026-03-01T01:00:00Z")])).toEqual([
      { person: { id: "a", handle: "ha", displayName: "na", avatarVersion: 3 }, since: "2026-03-02T01:00:00.000Z" },
      { person: { id: "b", handle: "hb", displayName: "nb", avatarVersion: 3 }, since: "2026-03-01T01:00:00.000Z" },
    ]);
    expect(stoppedShape([])).toEqual([]);
  });

  it("reads the caller's own stop rows of access_bars (setter_id, other_id, kind, since), newest first, and nothing else (rolled-back transaction)", async () => {
    const owner = await newOwner();
    const [p1, p2, p3, p4, p5] = [await newOwner(), await newOwner(), await newOwner(), await newOwner(), await newOwner()];
    const client = await db.pool.connect();
    try {
      await client.query("begin");
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

  it("is [] for someone who stopped nobody", async () => {
    const owner = await newOwner();
    expect(await stoppedOf(db, owner.id)).toEqual([]);
  });
});

describe("the stopped list on the route is the caller's own, whatever the site's switch says", () => {
  const social = useApp({ env, agentWorker: false, config: SOCIAL_ON });
  it("the route lists the caller's own stop with the switch on AND off (what a person set they can always see and lift: fix round 1, I4); nobody else's", async () => {
    const tag = `sw${++n}x${Math.floor(Math.random() * 1e6)}`;
    const [owner, other] = [await signUp(social.app, `${tag}a`), await signUp(social.app, `${tag}b`)];
    await social.db.query("insert into access_bars (setter_id, other_id, kind) values ($1, $2, 'stop')", [owner.id, other.id]);
    const on = await api(social.app, owner, "GET", "/api/me/others-use");
    expect([on.status, on.json.stopped.map((r: { person: { id: string } }) => r.person.id)]).toEqual([200, [other.id]]);
    // Nobody is shown that another person stopped them.
    expect((await api(social.app, other, "GET", "/api/me/others-use")).json.stopped).toEqual([]);
    const config = social.app.deps.config as { social: { enabled: boolean } };
    const before = config.social;
    config.social = { enabled: false };
    try {
      expect((await api(social.app, owner, "GET", "/api/me/others-use")).json.stopped.map((r: { person: { id: string } }) => r.person.id)).toEqual([other.id]);
      expect((await api(social.app, other, "GET", "/api/me/others-use")).json.stopped).toEqual([]);
    } finally {
      config.social = before;
    }
  });
});
