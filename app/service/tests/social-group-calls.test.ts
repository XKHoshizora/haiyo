import { describe, expect, it } from "vitest";
import { endGrants } from "../src/social/agent-contacts.ts";
import { api, befriend, signUp } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { SOCIAL_ON } from "./helpers/social.ts";

// ONE rule for every ending in groups (A-3 review I1; B-3 dispatch; integration). An ending never cancels a group reply as a whole: the
// replies are held to THE access decision as it stands after the ending (`refusedInGroup`, through runs.ts `dropRefusedCalls` and
// `standingCalls`, the functions `begin` and the post use). A refused caller's calls leave a reply that has not called its model; one left
// with no call is cancelled quietly, with NO error (`access_ended` is a social run's). A reply in flight is stopped when every call it
// ANSWERS is refused. A reply's caller never changes (limits redesign, Part 2): another person's call waits behind it (`deferred_calls`)
// and stays there, for a reply of its own once it ends; a refused person's call that waited goes. An ending that refuses nobody in a group
// (a visitor leaving an Agent) takes nothing out. A person's block of a person leaves a reply that has not begun, and the calls that wait,
// to their own recheck (`begin`'s, and as a call that waited is taken: agents-block-recheck.test.ts), and stops one that is in flight like
// any ending.
const { app, db } = useApp({ env: SITE_ENV, config: SOCIAL_ON, agentWorker: false });

interface MadeAgent {
  id: string;
  conversationId: string;
}
let n = 0;
async function world(prefix: string) {
  const owner = await signUp(app, `${prefix}owner`);
  const v = await signUp(app, `${prefix}v`);
  const s = await signUp(app, `${prefix}s`);
  const agent = (await mustCreateAgent(app, owner, { handle: `${prefix}bot`, model: { source: "site", id: "fast" } })) as MadeAgent;
  return { owner, v, s, agent };
}
async function newGroup(creator: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(`insert into conversations (type, creator_id, title) values ('group', $1, 'g') returning id`, [creator]);
  return rows[0]!.id;
}
const say = async (conversationId: string, senderId: string): Promise<number> =>
  Number(
    (await db.query<{ seq: string }>(
      `insert into messages (conversation_id, seq, sender_id, kind, body) select $1, coalesce(max(seq), 0) + 1, $2, 'text', '{"text":"hi"}'::jsonb from messages where conversation_id = $1 returning seq::text as seq`,
      [conversationId, senderId],
    )).rows[0]!.seq,
  );
interface RunSpec {
  agentId: string;
  group: string;
  status: "queued" | "running";
  /** Whose messages are the calls it answers, in order: one person's (a reply's caller never changes); the caller is the first. */
  calls: string[];
  admitted?: boolean;
  /** Persons whose calls, made after it, wait behind it (`deferred_calls`), each in its own lane: the owner's own, or others'. */
  waiting?: string[];
}
async function run(o: RunSpec): Promise<{ id: string; seqs: number[]; waiting: number[] }> {
  // The Agent is a member of the group (what waits behind its reply is answered only there).
  await db.query(
    `insert into memberships (conversation_id, principal_id, role, joined_seq)
     select $1, $2, 'speaker', 0 where not exists (select 1 from memberships where conversation_id = $1 and principal_id = $2)`,
    [o.group, o.agentId],
  );
  const seqs: number[] = [];
  for (const who of o.calls) seqs.push(await say(o.group, who));
  const { rows } = await db.query<{ id: string }>(
    `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, call_seqs, triggered_by, lane, caller_id, started_at, asker_ids, model, source)
     select 'reply', $1, $2, ag.owner_id, $3, $4, $5::bigint[], 'human', case when ag.owner_id = $6 then 'own' else 'others' end, $6,
            case when $3 = 'running' then now() end, array[$6]::uuid[], $7, case when $7::text is not null then 'provider' end
       from principals ag where ag.id = $2 returning id`,
    [o.group, o.agentId, o.status, seqs.at(-1), seqs, o.calls[0], o.admitted ? "fast" : null],
  );
  const waiting: number[] = [];
  for (const who of o.waiting ?? []) {
    const seq = await say(o.group, who);
    waiting.push(seq);
    await db.query(
      `insert into deferred_calls (agent_id, conversation_id, message_seq, owner_id, lane, caller_id, triggered_by, asker_ids)
       select $1, $2, $3, ag.owner_id, case when ag.owner_id = $4 then 'own' else 'others' end, $4, 'human', array[$4]::uuid[] from principals ag where ag.id = $1`,
      [o.agentId, o.group, seq, who],
    );
  }
  return { id: rows[0]!.id, seqs, waiting };
}
const view = async (id: string) =>
  (
    await db.query(
      `select status, error, interrupted, call_seqs::int[] as calls, covers_seq::int as covers, caller_id as caller, lane, asker_ids::text[] as askers,
              array(select d.message_seq::int from deferred_calls d where d.agent_id = r.agent_id and d.conversation_id = r.conversation_id order by d.message_seq) as waiting
         from agent_runs r where id = $1`,
      [id],
    )
  ).rows[0] as { status: string; error: string | null; interrupted: string | null; calls: number[]; covers: number; caller: string | null; lane: string; askers: string[]; waiting: number[] };
/** The Agent's reply queued in `group` now, if any. */
const queuedIn = async (agentId: string, group: string) =>
  (await db.query("select call_seqs::int[] as calls, caller_id as caller, lane from agent_runs where agent_id = $1 and conversation_id = $2 and status = 'queued'", [agentId, group])).rows;
/** V let in on the Agent. In a group only what STANDS refuses (reach; fix round 2, N2): a stop or a block, never a row that ended. */
const letIn = (agentId: string, v: string) =>
  db.query(`insert into agent_contacts (agent_id, subject_id, person_id, state, basis) values ($1, $2, $2, 'live', 'approved')`, [agentId, v]);
/** 停止往来 as `setBar` does it: the bar is written, then the rows between the two end `barred` and their runs are stopped. */
const between = (a: string, b: string) =>
  db.tx(async (t) => {
    await t.query("insert into access_bars (setter_id, other_id, kind) values ($1, $2, 'stop')", [a, b]);
    return endGrants(t, { between: [a, b] }, "barred");
  });

describe("an ending takes the refused person's calls out of a group reply", () => {
  it("queued: with no call left it is cancelled quietly, with no error; a third party's call or the owner's own that waited behind it stays, for a reply of its own; the refused person's goes", async () => {
    const { owner, v, s, agent } = await world("q");
    await letIn(agent.id, v.id);
    const g = await newGroup(owner.id);
    const third = await run({ agentId: agent.id, group: g, status: "queued", calls: [v.id], waiting: [s.id] });
    const g2 = await newGroup(owner.id);
    const theirs = await run({ agentId: agent.id, group: g2, status: "queued", calls: [v.id], waiting: [v.id] });
    const g3 = await newGroup(owner.id);
    const owners = await run({ agentId: agent.id, group: g3, status: "queued", calls: [v.id], waiting: [owner.id] });
    const forS = await run({ agentId: agent.id, group: await newGroup(owner.id), status: "queued", calls: [s.id], waiting: [v.id] });
    const result = await between(owner.id, v.id);
    expect(await view(third.id)).toMatchObject({ status: "cancelled", error: null, caller: v.id, lane: "others", waiting: third.waiting });
    expect(await view(theirs.id)).toMatchObject({ status: "cancelled", error: null, waiting: [] });
    expect(await view(owners.id)).toMatchObject({ status: "cancelled", error: null, waiting: owners.waiting });
    // A reply for someone not refused goes on, its caller's; the refused person's call behind it goes.
    expect(await view(forS.id)).toMatchObject({ status: "queued", error: null, calls: forS.seqs, caller: s.id, waiting: [] });
    expect(result.cancelled.map((c) => c.run.id).sort()).toEqual([third.id, theirs.id, owners.id].sort());
    expect(result.cancelled[0]!.run).not.toHaveProperty("error", "access_ended");
    // Taken once the ending commits (`announceEnded`, where a hub is): each call left gets its own reply, in its own lane.
    expect([...(result.idle ?? [])].map((p) => p.conversationId).sort()).toEqual([g, g2, g3].sort());
    await app.agentPort.consumeIdle(result.idle ?? []);
    expect(await queuedIn(agent.id, g)).toEqual([{ calls: third.waiting, caller: s.id, lane: "others" }]);
    expect(await queuedIn(agent.id, g2)).toEqual([]);
    expect(await queuedIn(agent.id, g3)).toEqual([{ calls: owners.waiting, caller: owner.id, lane: "own" }]);
  });

  it("running and admitted: stopped when every call it ANSWERS is refused, one for someone not refused goes on; a third party's call that waited behind it stays, the refused person's goes", async () => {
    const { owner, v, s, agent } = await world("ra");
    await letIn(agent.id, v.id);
    const only = await run({ agentId: agent.id, group: await newGroup(owner.id), status: "running", admitted: true, calls: [v.id] });
    const third = await run({ agentId: agent.id, group: await newGroup(owner.id), status: "running", admitted: true, calls: [v.id], waiting: [s.id] });
    const theirs = await run({ agentId: agent.id, group: await newGroup(owner.id), status: "running", admitted: true, calls: [v.id], waiting: [v.id] });
    const forS = await run({ agentId: agent.id, group: await newGroup(owner.id), status: "running", admitted: true, calls: [s.id], waiting: [v.id] });
    const result = await between(owner.id, v.id);
    expect(await view(only.id)).toMatchObject({ status: "running", interrupted: "access_ended" });
    expect(await view(third.id)).toMatchObject({ interrupted: "access_ended", waiting: third.waiting });
    expect(await view(theirs.id)).toMatchObject({ interrupted: "access_ended", waiting: [] });
    expect(await view(forS.id)).toMatchObject({ status: "running", interrupted: null, calls: forS.seqs, caller: s.id, waiting: [] });
    expect([...result.running].sort()).toEqual([only.id, third.id, theirs.id].sort());
  });

  it("running, not admitted yet (claimed, no model call): its calls are decided as a queued one's; with none left it is marked, for its `begin` to end before any call", async () => {
    const { owner, v, s, agent } = await world("ru");
    await letIn(agent.id, v.id);
    const forS = await run({ agentId: agent.id, group: await newGroup(owner.id), status: "running", calls: [s.id] });
    const only = await run({ agentId: agent.id, group: await newGroup(owner.id), status: "running", calls: [v.id], waiting: [s.id] });
    const result = await between(owner.id, v.id);
    expect(await view(forS.id)).toMatchObject({ status: "running", interrupted: null, calls: forS.seqs, caller: s.id });
    expect(await view(only.id)).toMatchObject({ status: "running", interrupted: "access_ended", waiting: only.waiting });
    expect(result.running).toEqual([only.id]);
  });

  it("an ending that refuses nobody in a group takes nothing out: a visitor who leaves the Agent may still @ it there", async () => {
    const { owner, v, agent } = await world("lf");
    await letIn(agent.id, v.id);
    const queued = await run({ agentId: agent.id, group: await newGroup(owner.id), status: "queued", calls: [v.id] });
    const inFlight = await run({ agentId: agent.id, group: await newGroup(owner.id), status: "running", admitted: true, calls: [v.id] });
    const result = await db.tx((t) => endGrants(t, { agentId: agent.id, subjectIds: [v.id] }, "left"));
    expect(result.ended).toBe(1);
    expect(await view(queued.id)).toMatchObject({ status: "queued", error: null, calls: queued.seqs, caller: v.id });
    expect(await view(inFlight.id)).toMatchObject({ status: "running", interrupted: null });
    expect([result.cancelled, result.running]).toEqual([[], []]);
  });

  it("a person's block of a person leaves a reply that has not begun, and a call that waits, to their own recheck, and stops one in flight", async () => {
    const { owner, v, s, agent } = await world("bl");
    const queued = await run({ agentId: agent.id, group: await newGroup(owner.id), status: "queued", calls: [v.id, v.id] });
    const unadmitted = await run({ agentId: agent.id, group: await newGroup(owner.id), status: "running", calls: [v.id] });
    const inFlight = await run({ agentId: agent.id, group: await newGroup(owner.id), status: "running", admitted: true, calls: [v.id] });
    const flightForS = await run({ agentId: agent.id, group: await newGroup(owner.id), status: "running", admitted: true, calls: [s.id], waiting: [v.id] });
    expect((await api(app, owner, "PUT", `/api/blocks/${v.id}`)).status).toBe(200);
    expect(await view(queued.id)).toMatchObject({ status: "queued", calls: queued.seqs });
    expect(await view(unadmitted.id)).toMatchObject({ status: "running", interrupted: null });
    expect(await view(inFlight.id)).toMatchObject({ interrupted: "access_ended" });
    expect(await view(flightForS.id)).toMatchObject({ interrupted: null, calls: flightForS.seqs, waiting: flightForS.waiting });
  });
});

describe("the same through the routes: a third party's call that waited survives every ending, and a reply left with no call ends with no error", () => {
  type Ending = (w: Awaited<ReturnType<typeof world>>) => Promise<void>;
  const endings: Record<string, Ending> = {
    "停止往来": async (w) => void expect((await api(app, w.owner, "PUT", `/api/bars/${w.v.id}`)).status).toBe(200),
    removal: async (w) => void expect((await api(app, w.owner, "DELETE", `/api/agent-contacts/${w.agent.id}/${w.v.id}`)).status).toBe(200),
    narrowing: async (w) => void expect((await api(app, w.owner, "PUT", `/api/agents/${w.agent.id}/contact-policy`, { policy: "ask", picked: false, picks: [] })).status).toBe(200),
    "a block of the Agent": async (w) => void expect((await api(app, w.v, "PUT", `/api/blocks/${w.agent.id}`)).status).toBe(200),
  };
  for (const [name, end] of Object.entries(endings)) {
    it(name, async () => {
      const w = await world(`rt${++n}`);
      await db.query(`insert into agent_contacts (agent_id, subject_id, person_id, state, basis) values ($1, $2, $2, 'live', 'contacts')`, [w.agent.id, w.v.id]);
      // The Agent is in a conversation the blocker shares with it (a block of an Agent needs to see it).
      await db.query(`update agents set contact_policy = 'contacts' where principal_id = $1`, [w.agent.id]);
      const g = await newGroup(w.owner.id);
      const third = await run({ agentId: w.agent.id, group: g, status: "queued", calls: [w.v.id], waiting: [w.s.id] });
      const only = await run({ agentId: w.agent.id, group: await newGroup(w.owner.id), status: "queued", calls: [w.v.id] });
      const forS = await run({ agentId: w.agent.id, group: await newGroup(w.owner.id), status: "queued", calls: [w.s.id], waiting: [w.v.id] });
      await end(w);
      // A removal and a narrowing end the row and the social conversation; in a group they refuse nobody (access there is membership:
      // fix round 2, N2), so the person's calls stay in the group's replies. A stop and a block stand, and take them out.
      const stands = name !== "removal" && name !== "narrowing";
      expect((await db.query<{ state: string }>("select state from agent_contacts where agent_id = $1 and subject_id = $2", [w.agent.id, w.v.id])).rows[0]!.state).toBe("ended");
      expect([name, await view(third.id)]).toEqual([name, expect.objectContaining(stands ? { status: "cancelled", error: null, waiting: [] } : { status: "queued", error: null, calls: third.seqs, waiting: third.waiting })]);
      // What waited behind it was taken as the route answered: the third party's own reply.
      if (stands) expect([name, await queuedIn(w.agent.id, g)]).toEqual([name, [{ calls: third.waiting, caller: w.s.id, lane: "others" }]]);
      expect([name, await view(only.id)]).toEqual([name, expect.objectContaining(stands ? { status: "cancelled", error: null } : { status: "queued", error: null, calls: only.seqs })]);
      expect([name, await view(forS.id)]).toEqual([name, expect.objectContaining({ status: "queued", calls: forS.seqs, waiting: stands ? [] : forS.waiting })]);

    });
  }
});
