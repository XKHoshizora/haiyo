import { describe, expect, it, vi } from "vitest";
import { endGrants, type GrantScope } from "../src/social/agent-contacts.ts";
import { api, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { holdThen, someoneWaits } from "./helpers/locks.ts";
import { SOCIAL_ON, seedSocial } from "./helpers/social.ts";

// Plan A5a (design §1.2, §8 test 1, lane A's half): `endGrants`, the only way access stops: the rows end, the queued replies are
// cancelled, the running ones interrupted (`access_ended`, `pending_seq` null), in the pair's social conversations and in groups
// the person concerned called; and what takes it over (`removeContact`, a person's block of an Agent).
const { app, db } = useApp({ env: SITE_ENV, config: SOCIAL_ON, agentWorker: false });

interface MadeAgent {
  id: string;
  conversationId: string;
}
let n = 0;
async function person(): Promise<Actor> {
  const h = `rv${++n}_${Math.random().toString(36).slice(2, 6)}`;
  await db.query(`insert into "user" (id, name, email, "emailVerified") values ($1::text, $1::text, $1::text || '@example.test', true)`, [`auth-${h}`]);
  const { rows } = await db.query<{ id: string }>(`insert into principals (kind, handle, display_name, auth_user_id) values ('human', $1::citext, $1::text, 'auth-' || $1::text) returning id`, [h]);
  return { id: rows[0]!.id, handle: h } as Actor;
}
async function agentOf(owner: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(`insert into principals (kind, handle, display_name, owner_id) values ('agent', $1::citext, $1::text, $2) returning id`, [`rg${++n}_${Math.random().toString(36).slice(2, 6)}`, owner]);
  await db.query(`insert into agents (principal_id) values ($1)`, [rows[0]!.id]);
  return rows[0]!.id;
}
async function world(prefix: string) {
  const owner = await signUp(app, `${prefix}owner`);
  const agent = (await mustCreateAgent(app, owner, { handle: `${prefix}bot` })) as MadeAgent;
  const v = await signUp(app, `${prefix}visitor`);
  return { owner, agent, v };
}
/** A group the person created (a conversation of type group is all a run row needs). */
async function newGroup(creator: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(`insert into conversations (type, creator_id, title) values ('group', $1, 'g') returning id`, [creator]);
  return rows[0]!.id;
}
/** An active reply of `agentId` in `conversationId` called by `callerId`; `pending_seq` is set so that dropping it can be seen. */
async function runIn(agentId: string, conversationId: string, callerId: string | null, status: "queued" | "running", askers: string[] | null = null): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, pending_seq, triggered_by, lane, caller_id, started_at, asker_ids)
     values ('reply', $1, $2, (select owner_id from principals where id = $2), $4, 0, 5, 'human', 'others', $3, case when $4 = 'running' then now() end, $5) returning id`,
    [conversationId, agentId, callerId, status, askers],
  );
  return rows[0]!.id;
}
const runOf = async (id: string) => (await db.query(`select status, error, interrupted, pending_seq from agent_runs where id = $1`, [id])).rows[0] as { status: string; error: string | null; interrupted: string | null; pending_seq: string | null };
const untouched = { error: null, interrupted: null, pending_seq: "5" };
const ended = { interrupted: "access_ended", pending_seq: null };
const rowOf = async (agentId: string, subjectId: string) =>
  (await db.query(`select state, basis, end_reason, until from agent_contacts where agent_id = $1 and subject_id = $2`, [agentId, subjectId])).rows[0] as { state: string; basis: string | null; end_reason: string | null; until: Date | null } | undefined;
const live = (agentId: string, subjectId: string, personId: string = subjectId) =>
  db.query(`insert into agent_contacts (agent_id, subject_id, person_id, state, basis) values ($1, $2, $3, 'live', 'approved')`, [agentId, subjectId, personId]);
const requested = (agentId: string, subjectId: string, personId: string = subjectId) =>
  db.query(`insert into agent_contacts (agent_id, subject_id, person_id, state, until) values ($1, $2, $3, 'requested', now() + interval '3 days')`, [agentId, subjectId, personId]);
const grants = (scope: GrantScope, reason: "left" | "narrowed" | "removed" | "barred") => db.tx((t) => endGrants(t, scope, reason));
let txn = 0;
const send = (who: Actor, conv: string, text: string) => api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `rv${++txn}` });

describe("endGrants: what it ends", () => {
  it("an Agent's rows for the listed subjects end, live and waiting, with the reason; the others stay; and nothing is a bar", async () => {
    const { owner, agent, v } = await world("sc");
    const w = await signUp(app, "scw");
    const x = await signUp(app, "scx");
    const y = await signUp(app, "scy");
    const vAgent = await agentOf(v.id);
    await live(agent.id, v.id);
    await live(agent.id, w.id);
    await requested(agent.id, x.id);
    await live(agent.id, vAgent, v.id);
    await db.query(`insert into agent_contacts (agent_id, subject_id, person_id, state, end_reason) values ($1, $2, $2, 'ended', 'declined')`, [agent.id, y.id]);
    expect(await grants({ agentId: agent.id, subjectIds: [v.id, x.id, y.id] }, "narrowed")).toMatchObject({ ended: 2, cancelled: [], running: [] });
    expect(await rowOf(agent.id, v.id)).toMatchObject({ state: "ended", end_reason: "narrowed", basis: null, until: null });
    expect(await rowOf(agent.id, x.id)).toMatchObject({ state: "ended", end_reason: "narrowed" });
    // Not listed: stays; an ended row is not ended again; V's Agent has a row of its own.
    expect(await rowOf(agent.id, w.id)).toMatchObject({ state: "live" });
    expect(await rowOf(agent.id, vAgent)).toMatchObject({ state: "live" });
    expect(await rowOf(agent.id, y.id)).toMatchObject({ state: "ended", end_reason: "declined" });
    expect((await db.query(`select count(*)::int n from access_bars`)).rows[0]!.n).toBe(0);
    expect(owner.id).toBeTruthy();
    // Again: nothing to end.
    expect(await grants({ agentId: agent.id, subjectIds: [v.id] }, "narrowed")).toEqual({ ended: 0, cancelled: [], running: [] });
  });

  it("between two people: rows on the Agents of each whose person is the other, an Agent of the other's included; no one else's", async () => {
    const a = await signUp(app, "bta");
    const b = await signUp(app, "btb");
    const c = await signUp(app, "btc");
    const ya1 = await agentOf(a.id);
    const ya2 = await agentOf(a.id);
    const yb = await agentOf(b.id);
    const bAgent = await agentOf(b.id);
    const cAgent = await agentOf(c.id);
    await live(ya1, b.id);
    await requested(ya2, b.id);
    await live(ya1, bAgent, b.id);
    await live(yb, a.id);
    await live(ya1, c.id);
    await live(yb, cAgent, c.id);
    expect(await grants({ between: [b.id, a.id] }, "barred")).toMatchObject({ ended: 4 });
    for (const [agent, subject] of [[ya1, b.id], [ya2, b.id], [ya1, bAgent], [yb, a.id]] as const) {
      expect([agent, subject, await rowOf(agent, subject)]).toEqual([agent, subject, expect.objectContaining({ state: "ended", end_reason: "barred" })]);
    }
    expect(await rowOf(ya1, c.id)).toMatchObject({ state: "live" });
    expect(await rowOf(yb, cAgent)).toMatchObject({ state: "live" });
  });
});

describe("endGrants: what it stops", () => {
  it("the queued reply is cancelled and the running one interrupted, in the pair's conversation and in groups the person called; not a group someone else called", async () => {
    const { owner, agent, v } = await world("st");
    const w = await signUp(app, "stw");
    const s = (await seedSocial(app, { owner, agentId: agent.id, visitor: v })).conversationId;
    const sw = (await seedSocial(app, { owner, agentId: agent.id, visitor: w })).conversationId;
    const g1 = await newGroup(v.id);
    const g2 = await newGroup(w.id);
    const g3 = await newGroup(w.id);
    const running = await runIn(agent.id, s, v.id, "running");
    const queued = await runIn(agent.id, g1, v.id, "queued");
    const callerElse = await runIn(agent.id, g2, w.id, "running", [v.id, w.id]);
    const otherSocial = await runIn(agent.id, sw, w.id, "queued");
    const nobody = await runIn(agent.id, g3, null, "queued", [v.id]);
    const result = await grants({ agentId: agent.id, subjectIds: [v.id] }, "removed");
    expect(result.ended).toBe(1);
    expect(result.running).toEqual([running]);
    expect(result.cancelled).toHaveLength(1);
    expect(result.cancelled[0]).toMatchObject({ ownerId: owner.id, conversationId: g1, run: { id: queued, status: "cancelled" } });
    expect(await runOf(running)).toMatchObject({ status: "running", ...ended });
    expect(await runOf(queued)).toMatchObject({ status: "cancelled", error: "access_ended" });
    expect((await db.query(`select finished_at from agent_runs where id = $1`, [queued])).rows[0]!.finished_at).not.toBeNull();
    // A group run someone else called, V only among its askers (the design says the caller, attack M5), stays; so does everything of W's.
    expect(await runOf(callerElse)).toMatchObject({ status: "running", ...untouched });
    expect(await runOf(otherSocial)).toMatchObject({ status: "queued", ...untouched });
    expect(await runOf(nobody)).toMatchObject({ status: "queued", ...untouched });
  });

  it("between two people it stops both sides' replies, and an Agent-to-Agent conversation of theirs", async () => {
    const a = await signUp(app, "bsa");
    const b = await signUp(app, "bsb");
    const c = await signUp(app, "bsc");
    const ya = await agentOf(a.id);
    const yb = await agentOf(b.id);
    const yc = await agentOf(c.id);
    const aVisitsB = (await seedSocial(app, { owner: b, agentId: yb, visitor: a })).conversationId;
    const bVisitsA = (await seedSocial(app, { owner: a, agentId: ya, visitor: b })).conversationId;
    const cVisitsA = (await seedSocial(app, { owner: a, agentId: ya, visitor: c })).conversationId;
    const gAB = await newGroup(a.id);
    const gAB2 = await newGroup(b.id);
    const gC = await newGroup(c.id);
    const r1 = await runIn(yb, aVisitsB, a.id, "running");
    const r2 = await runIn(ya, bVisitsA, b.id, "queued");
    const r3 = await runIn(ya, gAB, b.id, "running");
    const r4 = await runIn(yb, gAB2, a.id, "queued");
    const keep1 = await runIn(ya, cVisitsA, c.id, "running");
    const keep2 = await runIn(ya, gC, c.id, "queued");
    const keep3 = await runIn(ya, gAB2, a.id, "running"); // the owner's own call on their own Agent
    const result = await grants({ between: [a.id, b.id] }, "barred");
    expect([...result.running].sort()).toEqual([r1, r3].sort());
    expect(result.cancelled.map((x) => x.run.id).sort()).toEqual([r2, r4].sort());
    for (const id of [r1, r3]) expect(await runOf(id)).toMatchObject({ status: "running", ...ended });
    for (const id of [r2, r4]) expect(await runOf(id)).toMatchObject({ status: "cancelled", error: "access_ended" });
    for (const id of [keep1, keep3]) expect(await runOf(id)).toMatchObject({ status: "running", ...untouched });
    expect(await runOf(keep2)).toMatchObject({ status: "queued", ...untouched });
    expect(yc).toBeTruthy();
  });

  it("an Agent-to-Agent conversation between their Agents is the pair's too", async () => {
    const a = await signUp(app, "aga");
    const b = await signUp(app, "agb");
    const ya = await agentOf(a.id);
    const yb = await agentOf(b.id);
    const { seedSocialAgents } = await import("./helpers/social.ts");
    const { conversationId } = await seedSocialAgents(app, { x: ya, y: yb });
    const r = await runIn(yb, conversationId, a.id, "running");
    const r2 = await runIn(ya, conversationId, b.id, "queued");
    const result = await grants({ between: [a.id, b.id] }, "barred");
    expect(result.running).toEqual([r]);
    expect(result.cancelled.map((x) => x.run.id)).toEqual([r2]);
  });

  it("over a hundred: 105 subjects' rows and replies end at once, and five others' stay", async () => {
    const { owner, agent } = await world("big");
    const subjects: Actor[] = [];
    const runs: string[] = [];
    for (let i = 0; i < 105; i++) {
      const p = await person();
      subjects.push(p);
      const conv = (await seedSocial(app, { owner, agentId: agent.id, visitor: p })).conversationId;
      runs.push(await runIn(agent.id, conv, p.id, i % 2 === 0 ? "running" : "queued"));
    }
    const others: string[] = [];
    for (let i = 0; i < 5; i++) {
      const p = await person();
      const conv = (await seedSocial(app, { owner, agentId: agent.id, visitor: p })).conversationId;
      others.push(await runIn(agent.id, conv, p.id, "running"));
    }
    const result = await grants({ agentId: agent.id, subjectIds: subjects.map((p) => p.id) }, "narrowed");
    expect(result.ended).toBe(105);
    expect(result.running).toHaveLength(53);
    expect(result.cancelled).toHaveLength(52);
    expect(new Set([...result.running, ...result.cancelled.map((c) => c.run.id)])).toEqual(new Set(runs));
    const states = await db.query<{ status: string; interrupted: string | null }>(`select status, interrupted from agent_runs where id = any($1::uuid[])`, [runs]);
    expect(states.rows.filter((r) => r.status === "cancelled")).toHaveLength(52);
    expect(states.rows.filter((r) => r.interrupted === "access_ended")).toHaveLength(53);
    for (const id of others) expect(await runOf(id)).toMatchObject({ status: "running", ...untouched });
    expect((await db.query(`select count(*)::int n from agent_contacts where agent_id = $1 and state = 'live'`, [agent.id])).rows[0]!.n).toBe(5);
  });

  it("12 Agents on each side, between: every Agent's rows and replies, 24 in all", async () => {
    const a = await signUp(app, "m12a");
    const b = await signUp(app, "m12b");
    const runIds: string[] = [];
    for (let i = 0; i < 12; i++) {
      const ya = await agentOf(a.id);
      const yb = await agentOf(b.id);
      await live(ya, b.id);
      await live(yb, a.id);
      const g1 = await newGroup(b.id);
      const g2 = await newGroup(a.id);
      runIds.push(await runIn(ya, g1, b.id, "running"), await runIn(yb, g2, a.id, "queued"));
    }
    const result = await grants({ between: [a.id, b.id] }, "barred");
    expect(result.ended).toBe(24);
    expect(result.running).toHaveLength(12);
    expect(result.cancelled).toHaveLength(12);
  });
});

describe("what takes it over", () => {
  it("the owner's removal ends the person's row and their Agents' on that Agent, and stops what the person called", async () => {
    const { owner, agent, v } = await world("rm");
    const w = await signUp(app, "rmw");
    const vAgent = await agentOf(v.id);
    const wAgent = await agentOf(w.id);
    await live(agent.id, vAgent, v.id);
    await requested(agent.id, wAgent, w.id);
    await live(agent.id, w.id);
    const s = (await seedSocial(app, { owner, agentId: agent.id, visitor: v })).conversationId;
    const g = await newGroup(v.id);
    const running = await runIn(agent.id, s, v.id, "running");
    const queued = await runIn(agent.id, g, v.id, "queued");
    const interrupt = vi.spyOn(app.agentPort, "interruptRuns");
    try {
      expect((await api(app, owner, "DELETE", `/api/agent-contacts/${agent.id}/${v.id}`)).status).toBe(200);
      expect(interrupt).toHaveBeenCalledWith([running]);
    } finally {
      interrupt.mockRestore();
    }
    expect(await rowOf(agent.id, v.id)).toMatchObject({ state: "ended", end_reason: "removed" });
    expect(await rowOf(agent.id, vAgent)).toMatchObject({ state: "ended", end_reason: "removed" });
    expect(await rowOf(agent.id, w.id)).toMatchObject({ state: "live" });
    expect(await rowOf(agent.id, wAgent)).toMatchObject({ state: "requested" });
    expect(await runOf(running)).toMatchObject({ status: "running", ...ended });
    expect(await runOf(queued)).toMatchObject({ status: "cancelled", error: "access_ended" });
    // A waiting request is not removed by the owner (decline it): as before.
    expect((await api(app, owner, "DELETE", `/api/agent-contacts/${agent.id}/${wAgent}`)).status).toBe(404);
    expect(await rowOf(agent.id, wAgent)).toMatchObject({ state: "requested" });
  });

  it("the visitor's leaving ends their own row only, and stops what they called", async () => {
    const { owner, agent, v } = await world("lv");
    const vAgent = await agentOf(v.id);
    await live(agent.id, vAgent, v.id);
    const s = (await seedSocial(app, { owner, agentId: agent.id, visitor: v })).conversationId;
    const running = await runIn(agent.id, s, v.id, "running");
    expect((await api(app, v, "DELETE", `/api/agent-contacts/${agent.id}/${v.id}`)).status).toBe(200);
    expect(await rowOf(agent.id, v.id)).toMatchObject({ state: "ended", end_reason: "left" });
    expect(await rowOf(agent.id, vAgent)).toMatchObject({ state: "live" });
    expect(await runOf(running)).toMatchObject({ status: "running", ...ended });
  });

  it("a person's block of an Agent ends their row (also a waiting one) as left, stops what they called, and writes no bar", async () => {
    const { owner, agent, v } = await world("bk");
    const other = (await mustCreateAgent(app, owner, { handle: "bkother" })) as MadeAgent;
    await requested(other.id, v.id);
    const s = (await seedSocial(app, { owner, agentId: agent.id, visitor: v })).conversationId;
    const g = await newGroup(v.id);
    const running = await runIn(agent.id, s, v.id, "running");
    const queued = await runIn(agent.id, g, v.id, "queued");
    const otherQueued = await runIn(other.id, g, v.id, "queued");
    const interrupt = vi.spyOn(app.agentPort, "interruptRuns");
    try {
      expect((await api(app, v, "PUT", `/api/blocks/${agent.id}`)).status).toBe(200);
      expect(interrupt).toHaveBeenCalledWith([running]);
    } finally {
      interrupt.mockRestore();
    }
    expect(await rowOf(agent.id, v.id)).toMatchObject({ state: "ended", end_reason: "left" });
    expect(await runOf(running)).toMatchObject({ status: "running", ...ended });
    expect(await runOf(queued)).toMatchObject({ status: "cancelled", error: "access_ended" });
    // The other Agent of the owner is not the one blocked.
    expect(await rowOf(other.id, v.id)).toMatchObject({ state: "requested" });
    expect(await runOf(otherQueued)).toMatchObject({ status: "queued", ...untouched });
    expect((await db.query(`select count(*)::int n from access_bars`)).rows[0]!.n).toBe(0);
    // A second block is the same answer and changes nothing.
    expect((await api(app, v, "PUT", `/api/blocks/${agent.id}`)).status).toBe(200);
    // A waiting request to the blocked Agent ends too.
    const w = await signUp(app, "bkw");
    await requested(agent.id, w.id);
    expect((await api(app, w, "PUT", `/api/blocks/${agent.id}`)).status).toBe(200);
    expect(await rowOf(agent.id, w.id)).toMatchObject({ state: "ended", end_reason: "left" });
  });
});

describe("races", () => {
  for (const how of ["the owner removes the person", "the person blocks the Agent"] as const) {
    it(`a send that waits behind the action (${how}) is refused no_access once it commits`, async () => {
      const { owner, agent, v } = await world(how === "the owner removes the person" ? "rsa" : "rsb");
      const { conversationId: conv } = await seedSocial(app, { owner, agentId: agent.id, visitor: v });
      expect((await send(v, conv, "before")).status).toBe(201);
      // The action, in a transaction of its own that stays open after its work: the send meets its locks.
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let started!: () => void;
      const isStarted = new Promise<void>((r) => (started = r));
      const { removeContact } = await import("../src/social/agent-contacts.ts");
      const { blockPrincipal } = await import("../src/social/blocks.ts");
      const acting = db.tx(async (t) => {
        if (how === "the owner removes the person") await removeContact(t, owner.id, agent.id, v.id);
        else await blockPrincipal(t, v.id, agent.id);
        started();
        await gate;
      });
      await isStarted;
      const sending = send(v, conv, "during");
      await someoneWaits(db, ["%for update%"]);
      release();
      await acting;
      const res = await sending;
      expect(res.status).toBe(403);
      // After a block the refusal says so; after a removal it is no_access. Either way never why a bar or a row ended.
      expect(res.json.reason).toBe(how === "the owner removes the person" ? "no_access" : "blocked");
    });
  }

  it("a reply that is being claimed as the access ends is interrupted, not left running: whichever commits first", async () => {
    const { owner, agent, v } = await world("clm");
    const { conversationId: conv } = await seedSocial(app, { owner, agentId: agent.id, visitor: v });
    const queued = await runIn(agent.id, conv, v.id, "queued");
    // The claim (as `claimNext` does it) holds the run row, then commits as a running reply.
    const claiming = holdThen(db, ["update agent_runs set status = 'running', started_at = now() where id = $1", [queued]], ["select 1", []]);
    await claiming.locked;
    const ending = grants({ agentId: agent.id, subjectIds: [v.id] }, "removed");
    await someoneWaits(db, ["%update agent_runs%"]);
    claiming.release();
    await claiming.done;
    const result = await ending;
    expect(result.running).toEqual([queued]);
    expect(result.cancelled).toEqual([]);
    expect(await runOf(queued)).toMatchObject({ status: "running", ...ended });
  });

  it("two endings of opposite directions at once do not deadlock", async () => {
    const a = await signUp(app, "dla");
    const b = await signUp(app, "dlb");
    const ya = await agentOf(a.id);
    const yb = await agentOf(b.id);
    await live(ya, b.id);
    await live(yb, a.id);
    const results = await Promise.all([grants({ between: [a.id, b.id] }, "barred"), grants({ between: [b.id, a.id] }, "barred")]);
    expect(results.map((r) => r.ended).sort()).toEqual([0, 2]);
  });
});
