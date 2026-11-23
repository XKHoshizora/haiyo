import { describe, expect, it, vi } from "vitest";
import { applyPolicy, addContact } from "../src/social/agent-contacts.ts";
import { api, befriend, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { someoneWaits } from "./helpers/locks.ts";
import { SOCIAL_ON, seedSocial } from "./helpers/social.ts";

// Plan A5c (design §1.2, §5): narrowing who may add an Agent: the rows the new setting would not create end `narrowed`, and what
// their persons called on the Agent stops; widening creates nothing; `dryRun` counts and writes nothing.
const { app, db } = useApp({ env: SITE_ENV, config: SOCIAL_ON, agentWorker: false });

interface MadeAgent {
  id: string;
  conversationId: string;
}
let n = 0;
async function person(): Promise<Actor> {
  const h = `pl${++n}_${Math.random().toString(36).slice(2, 6)}`;
  await db.query(`insert into "user" (id, name, email, "emailVerified") values ($1::text, $1::text, $1::text || '@example.test', true)`, [`auth-${h}`]);
  const { rows } = await db.query<{ id: string }>(`insert into principals (kind, handle, display_name, auth_user_id) values ('human', $1::citext, $1::text, 'auth-' || $1::text) returning id`, [h]);
  return { id: rows[0]!.id, handle: h } as Actor;
}
async function world(prefix: string) {
  const owner = await signUp(app, `${prefix}owner`);
  const agent = (await mustCreateAgent(app, owner, { handle: `${prefix}bot` })) as MadeAgent;
  return { owner, agent };
}
const row = (agentId: string, subjectId: string, state: "live" | "requested", basis: "approved" | "contacts" | null = state === "live" ? "approved" : null, personId: string = subjectId) =>
  state === "live"
    ? db.query(`insert into agent_contacts (agent_id, subject_id, person_id, state, basis) values ($1, $2, $3, 'live', $4)`, [agentId, subjectId, personId, basis])
    : db.query(`insert into agent_contacts (agent_id, subject_id, person_id, state, until) values ($1, $2, $3, 'requested', now() + interval '2 days')`, [agentId, subjectId, personId]);
const rowOf = async (agentId: string, subjectId: string) =>
  (await db.query(`select state, basis, end_reason from agent_contacts where agent_id = $1 and subject_id = $2`, [agentId, subjectId])).rows[0] as { state: string; basis: string | null; end_reason: string | null };
const agentState = async (agentId: string) => (await db.query(`select contact_policy, contact_picked from agents where principal_id = $1`, [agentId])).rows[0] as { contact_policy: string; contact_picked: boolean };
const picksOf = async (agentId: string) => (await db.query<{ person_id: string }>(`select person_id from agent_contact_picks where agent_id = $1 order by person_id`, [agentId])).rows.map((r) => r.person_id);
const put = (owner: Actor, agentId: string, body: Record<string, unknown>) => api(app, owner, "PUT", `/api/agents/${agentId}/contact-policy`, body);
const set = (agentId: string, policy: string, picked = false) => db.query(`update agents set contact_policy = $2, contact_picked = $3 where principal_id = $1`, [agentId, policy, picked]);
async function newGroup(creator: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(`insert into conversations (type, creator_id, title) values ('group', $1, 'g') returning id`, [creator]);
  return rows[0]!.id;
}
async function runIn(agentId: string, conversationId: string, callerId: string | null, status: "queued" | "running", askers: string[] | null = null, author: string | null = callerId): Promise<string> {
  const group = (await db.query<{ type: string }>(`select type from conversations where id = $1`, [conversationId])).rows[0]!.type === "group";
  let call = 0;
  if (group) {
    call = Number(
      (await db.query<{ seq: string }>(
        `insert into messages (conversation_id, seq, sender_id, kind, body) select $1, coalesce(max(seq), 0) + 1, $2, 'text', '{"text":"hi"}'::jsonb from messages where conversation_id = $1 returning seq::text as seq`,
        [conversationId, author],
      )).rows[0]!.seq,
    );
  }
  const { rows } = await db.query<{ id: string }>(
    `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, call_seqs, pending_seq, triggered_by, lane, caller_id, started_at, asker_ids)
     values ('reply', $1, $2, (select owner_id from principals where id = $2), $4, $6, case when $7::boolean then array[$6::bigint] end, 5 + $6, 'human', 'others', $3, case when $4 = 'running' then now() end, $5) returning id`,
    [conversationId, agentId, callerId, status, askers, call, group],
  );
  return rows[0]!.id;
}
const runOf = async (id: string) => (await db.query(`select status, error, interrupted, pending_seq from agent_runs where id = $1`, [id])).rows[0] as { status: string; error: string | null; interrupted: string | null; pending_seq: string | null };

describe("narrowing", () => {
  it("dryRun counts and writes nothing: 12 contacts-basis rows, then 105; approved rows and others are not counted", async () => {
    for (const count of [12, 105]) {
      const { owner, agent } = await world(`dry${count}`);
      await set(agent.id, "contacts");
      for (let i = 0; i < count; i++) await row(agent.id, (await person()).id, "live", "contacts");
      for (let i = 0; i < 3; i++) await row(agent.id, (await person()).id, "live", "approved");
      await row(agent.id, (await person()).id, "requested");
      expect(await put(owner, agent.id, { policy: "ask", picked: false, picks: [], dryRun: true })).toMatchObject({ status: 200, json: { ends: count } });
      expect(await agentState(agent.id)).toEqual({ contact_policy: "contacts", contact_picked: false });
      expect((await db.query(`select count(*)::int n from agent_contacts where agent_id = $1 and state = 'live'`, [agent.id])).rows[0]!.n).toBe(count + 3);
      // Narrowing to none counts everything live and waiting.
      expect(await put(owner, agent.id, { policy: "none", picked: false, picks: [], dryRun: true })).toMatchObject({ json: { ends: count + 4 } });
      expect((await db.query(`select count(*)::int n from agent_contacts where agent_id = $1 and state = 'ended'`, [agent.id])).rows[0]!.n).toBe(0);
    }
  });

  it("to ask ends exactly the contacts-basis rows and stops their runs; approved rows stay; the policy is saved", async () => {
    const { owner, agent } = await world("ask");
    await set(agent.id, "contacts");
    const friend = await signUp(app, "askfriend");
    const approved = await signUp(app, "askapproved");
    await befriend(app, owner, friend);
    const s = (await seedSocial(app, { owner, agentId: agent.id, visitor: friend, basis: "contacts" })).conversationId;
    await seedSocial(app, { owner, agentId: agent.id, visitor: approved });
    const g = await newGroup(friend.id);
    const running = await runIn(agent.id, s, friend.id, "running");
    const queued = await runIn(agent.id, g, friend.id, "queued");
    const res = await put(owner, agent.id, { policy: "ask", picked: false, picks: [] });
    expect(res).toMatchObject({ status: 200, json: { ends: 1 } });
    expect(await rowOf(agent.id, friend.id)).toMatchObject({ state: "ended", end_reason: "narrowed", basis: null });
    expect(await rowOf(agent.id, approved.id)).toMatchObject({ state: "live", basis: "approved" });
    expect(await agentState(agent.id)).toEqual({ contact_policy: "ask", contact_picked: false });
    expect(await runOf(running)).toMatchObject({ status: "running", interrupted: "access_ended", pending_seq: null });
    expect(await runOf(queued)).toMatchObject({ status: "cancelled", error: "access_ended" });
    // The friend is refused now, and may ask again as a request (the row closed is `narrowed`).
    expect((await api(app, friend, "POST", `/api/conversations/${s}/messages`, { text: "x", clientTxn: "pl1" })).status).toBe(403);
    expect(await api(app, friend, "POST", "/api/agent-contacts", { agentId: agent.id })).toMatchObject({ status: 202 });
  });

  it("to none ends every live and waiting row, approved ones too", async () => {
    const { owner, agent } = await world("none");
    const a = await person();
    const b = await person();
    const c = await person();
    await row(agent.id, a.id, "live", "approved");
    await row(agent.id, b.id, "live", "contacts");
    await row(agent.id, c.id, "requested");
    expect(await put(owner, agent.id, { policy: "none", picked: false, picks: [] })).toMatchObject({ status: 200, json: { ends: 3 } });
    for (const p of [a, b, c]) expect(await rowOf(agent.id, p.id)).toMatchObject({ state: "ended", end_reason: "narrowed" });
    expect(await agentState(agent.id)).toEqual({ contact_policy: "none", contact_picked: false });
  });

  it("to contacts with picks ends the rows of people not picked or no longer friends; the picks are replaced", async () => {
    const { owner, agent } = await world("pick");
    const kept = await signUp(app, "pickkept");
    const unpicked = await signUp(app, "pickunpicked");
    const notFriend = await signUp(app, "picknotfriend");
    const approved = await signUp(app, "pickapproved");
    for (const f of [kept, unpicked]) await befriend(app, owner, f);
    await row(agent.id, kept.id, "live", "contacts");
    await row(agent.id, unpicked.id, "live", "contacts");
    await row(agent.id, notFriend.id, "live", "contacts");
    await row(agent.id, approved.id, "live", "approved");
    const res = await put(owner, agent.id, { policy: "contacts", picked: true, picks: [kept.id, notFriend.id] });
    expect(res).toMatchObject({ status: 200, json: { ends: 2 } });
    expect(await rowOf(agent.id, kept.id)).toMatchObject({ state: "live" });
    expect(await rowOf(agent.id, unpicked.id)).toMatchObject({ state: "ended", end_reason: "narrowed" });
    expect(await rowOf(agent.id, notFriend.id)).toMatchObject({ state: "ended", end_reason: "narrowed" });
    expect(await rowOf(agent.id, approved.id)).toMatchObject({ state: "live" });
    expect(await agentState(agent.id)).toEqual({ contact_policy: "contacts", contact_picked: true });
    expect(await picksOf(agent.id)).toEqual([kept.id, notFriend.id].sort());
    // Replaced, not added to.
    await put(owner, agent.id, { policy: "contacts", picked: true, picks: [unpicked.id] });
    expect(await picksOf(agent.id)).toEqual([unpicked.id]);
  });

  it("widening creates and ends nothing", async () => {
    const { owner, agent } = await world("wide");
    await set(agent.id, "none");
    const a = await person();
    await row(agent.id, a.id, "live", "approved");
    await row(agent.id, (await person()).id, "requested");
    expect(await put(owner, agent.id, { policy: "ask", picked: false, picks: [] })).toMatchObject({ json: { ends: 0 } });
    expect(await put(owner, agent.id, { policy: "contacts", picked: false, picks: [] })).toMatchObject({ json: { ends: 0 } });
    expect((await db.query(`select state, count(*)::int n from agent_contacts where agent_id = $1 group by state order by state`, [agent.id])).rows).toEqual([
      { state: "live", n: 1 },
      { state: "requested", n: 1 },
    ]);
    expect((await db.query(`select count(*)::int n from social_pairs`)).rows[0]!.n).toBe(0);
  });

  it("refuses what is no owner's or no list: a stranger's 404, more than 500 picks, an id that is no person, the owner among them", async () => {
    const { owner, agent } = await world("bad");
    const stranger = await signUp(app, "badstranger");
    expect(await put(stranger, agent.id, { policy: "none", picked: false, picks: [] })).toMatchObject({ status: 404 });
    expect((await api(app, stranger, "GET", `/api/agents/${agent.id}/contacts`)).status).toBe(404);
    const ids = Array.from({ length: 501 }, () => "00000000-0000-4000-8000-000000000000");
    expect((await put(owner, agent.id, { policy: "contacts", picked: true, picks: ids })).status).toBe(400);
    expect((await put(owner, agent.id, { policy: "contacts", picked: true, picks: ["00000000-0000-4000-8000-000000000000"] })).status).toBe(400);
    expect((await put(owner, agent.id, { policy: "contacts", picked: true, picks: [owner.id] })).status).toBe(400);
    expect((await put(owner, agent.id, { policy: "sometimes", picked: false, picks: [] })).status).toBe(400);
    expect(await agentState(agent.id)).toEqual({ contact_policy: "ask", contact_picked: false });
  });

  it("an add that waits behind the narrowing is refused by it; an approval too", async () => {
    const { owner, agent } = await world("race");
    const v = await signUp(app, "racev");
    const w = await signUp(app, "racew");
    await app.deps.db.tx(async (t) => addContact(t, app.deps.config, w.id, agent.id));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const isStarted = new Promise<void>((r) => (started = r));
    const narrowing = db.tx(async (t) => {
      await applyPolicy(t, owner.id, agent.id, { policy: "none", picked: false, picks: [] }, { dryRun: false });
      started();
      await gate;
    });
    await isStarted;
    const adding = api(app, v, "POST", "/api/agent-contacts", { agentId: agent.id });
    const approving = api(app, owner, "POST", `/api/agent-contacts/${agent.id}/${w.id}/approve`);
    await someoneWaits(db, ["%agents%for update%"], 2);
    release();
    await narrowing;
    expect((await adding).status).toBe(404);
    expect(await approving).toMatchObject({ status: 409, json: { error: "not_requested" } });
    expect((await db.query(`select count(*)::int n from agent_contacts where agent_id = $1 and state = 'live'`, [agent.id])).rows[0]!.n).toBe(0);
  });
});

describe("announcing a narrowing, and a deleted Agent (A-3 review m6, m7)", () => {
  it("105 ended rows are announced with one statement for the conversations, not one each", async () => {
    const { owner, agent } = await world("ann");
    await set(agent.id, "contacts");
    const people: Actor[] = [];
    for (let i = 0; i < 105; i++) {
      const p = await person();
      people.push(p);
      await row(agent.id, p.id, "live", "contacts");
    }
    const told: string[][] = [];
    const off = app.deps.social.on((ids) => void told.push([...ids]));
    const spy = vi.spyOn(app.deps.db, "query");
    try {
      expect(await put(owner, agent.id, { policy: "ask", picked: false, picks: [] })).toMatchObject({ status: 200, json: { ends: 105 } });
      expect(spy.mock.calls.filter((c) => typeof c[0] === "string" && c[0].includes("social_pairs")).length).toBe(1);
    } finally {
      spy.mockRestore();
      off();
    }
    // Everyone whose row ended refetches, and the owner.
    const heard = new Set(told.flat());
    expect(heard.has(owner.id)).toBe(true);
    for (const p of people) expect(heard.has(p.id)).toBe(true);
  });

  it("the policy of one's own deleted Agent is refused as any Agent that is not there, and writes nothing", async () => {
    const { owner, agent } = await world("del");
    expect((await api(app, owner, "DELETE", `/api/agents/${agent.id}`)).status).toBe(200);
    const gone = await put(owner, agent.id, { policy: "none", picked: false, picks: [] });
    const unknown = await put(owner, "00000000-0000-4000-8000-000000000000", { policy: "none", picked: false, picks: [] });
    expect([gone.status, gone.json]).toEqual([unknown.status, unknown.json]);
    expect(await agentState(agent.id)).toEqual({ contact_policy: "ask", contact_picked: false });
  });
});

describe("GET /api/agents/:id/contacts", () => {
  it("is the owner's view: the policy, the picks, every row with its real end reason, and the Agent's social conversations; 105 rows", async () => {
    const { owner, agent } = await world("get");
    await set(agent.id, "contacts", true);
    const picked = await person();
    await db.query(`insert into agent_contact_picks (agent_id, person_id) values ($1, $2)`, [agent.id, picked.id]);
    const t0 = Date.parse("2026-03-01T00:00:00Z");
    const people: Actor[] = [];
    for (let i = 0; i < 105; i++) {
      const p = await person();
      people.push(p);
      await db.query(`insert into agent_contacts (agent_id, subject_id, person_id, state, basis, since) values ($1, $2, $2, 'live', 'approved', $3)`, [agent.id, p.id, new Date(t0 + i * 1000)]);
    }
    await db.query(`update agent_contacts set state = 'ended', basis = null, end_reason = 'removed' where agent_id = $1 and subject_id = $2`, [agent.id, people[3]!.id]);
    const late = await person();
    await db.query(`insert into agent_contacts (agent_id, subject_id, person_id, state, until, since) values ($1, $2, $2, 'requested', now() - interval '1 hour', $3)`, [agent.id, late.id, new Date(t0 + 500_000)]);
    const visitor = await signUp(app, "getvisitor");
    const { conversationId } = await seedSocial(app, { owner, agentId: agent.id, visitor });
    const res = await api(app, owner, "GET", `/api/agents/${agent.id}/contacts`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ policy: "contacts", picked: true, picks: [picked.id] });
    expect(res.json.rows).toHaveLength(107);
    // Newest first.
    const since = (res.json.rows as Array<{ since: string }>).map((r) => Date.parse(r.since));
    expect(since).toEqual([...since].sort((a, b) => b - a));
    const removed = res.json.rows.find((r: { subject: { id: string } }) => r.subject.id === people[3]!.id);
    expect(removed).toMatchObject({ state: "ended", basis: null, endReason: "removed", conversationId: null });
    expect(res.json.rows.find((r: { subject: { id: string } }) => r.subject.id === late.id)).toMatchObject({ state: "ended", endReason: "expired" });
    expect(Object.keys(res.json.rows[0]).sort()).toEqual(["basis", "conversationId", "endReason", "since", "state", "subject", "until"]);
    expect(Object.keys(res.json.rows[0].subject).sort()).toEqual(["avatarVersion", "displayName", "handle", "id", "kind"]);
    expect(res.json.rows.find((r: { subject: { id: string } }) => r.subject.id === visitor.id)).toMatchObject({ state: "live", conversationId });
    expect(res.json.conversations).toEqual([{ conversationId, subject: expect.objectContaining({ id: visitor.id, kind: "human" }) }]);
  });
});
