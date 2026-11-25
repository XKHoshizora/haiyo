import { describe, expect, it } from "vitest";
import { endGrants } from "../src/social/agent-contacts.ts";
import { api, befriend, signUp } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { SOCIAL_ON } from "./helpers/social.ts";

// ONE rule for every ending in groups (A-3 review I1; B-3 dispatch; integration). An ending never cancels a group reply as a whole: the
// replies are held to THE access decision as it stands after the ending (`refusedInGroup`, through runs.ts `dropRefusedCalls` and
// `standingCalls`, the functions `begin` and the post use). A refused caller's calls leave a reply that has not called its model; one left
// with no call is cancelled quietly, with NO error (`access_ended` is a social run's). A reply in flight goes on for the others, and is
// stopped when every call it ANSWERS is refused; what a person not refused noted on it (a call) stays for its follow-up. An ending that
// refuses nobody in a group (a visitor leaving an Agent) takes nothing out. A person's block of a person leaves a reply that has not begun
// to `begin`'s own recheck (agents-block-recheck.test.ts), and stops one that is in flight like any ending.
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
  const agent = (await mustCreateAgent(app, owner, { handle: `${prefix}bot` })) as MadeAgent;
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
  /** Whose messages are the calls it answers, in order; the caller is the first unless said. */
  calls: string[];
  caller?: string | null;
  askers?: string[];
  admitted?: boolean;
  /** A message of this person noted on it after the calls (`pending_seq`): a call (it joins `call_seqs`, as the fold writes it) unless `notedIsCall` is false. */
  noted?: string;
  notedIsCall?: boolean;
}
async function run(o: RunSpec): Promise<{ id: string; seqs: number[] }> {
  const seqs: number[] = [];
  for (const who of o.calls) seqs.push(await say(o.group, who));
  const noted = o.noted ? await say(o.group, o.noted) : null;
  const { rows } = await db.query<{ id: string }>(
    // (`owner_call_seqs`: the calls among them that the Agent's owner wrote, as the trigger records an owner's own call when it is made.)
    `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, call_seqs, pending_seq, triggered_by, lane, caller_id, started_at, asker_ids, model, source, owner_call_seqs)
     values ('reply', $1, $2, (select owner_id from principals where id = $2), $3, $4, $5::bigint[], $6, 'human', 'others', $7, case when $3 = 'running' then now() end, $8::uuid[], $9, case when $9::text is not null then 'provider' end,
             (select coalesce(array_agg(m.seq order by m.seq), '{}') from messages m where m.conversation_id = $1 and m.seq = any($5::bigint[]) and m.sender_id = (select owner_id from principals where id = $2))) returning id`,
    [o.group, o.agentId, o.status, seqs.at(-1), noted !== null && o.notedIsCall !== false ? [...seqs, noted] : seqs, noted, o.caller === undefined ? o.calls[0] : o.caller, o.askers ?? [...new Set(o.calls)], o.admitted ? "fast" : null],
  );
  return { id: rows[0]!.id, seqs };
}
const view = async (id: string) =>
  (
    await db.query(
      `select status, error, interrupted, pending_seq::int as pending, call_seqs::int[] as calls, covers_seq::int as covers, caller_id as caller, lane, asker_ids::text[] as askers from agent_runs where id = $1`,
      [id],
    )
  ).rows[0] as { status: string; error: string | null; interrupted: string | null; pending: number | null; calls: number[]; covers: number; caller: string | null; lane: string; askers: string[] };
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
  it("queued: a folded third party's call survives, the reply becomes theirs; with no call left it is cancelled quietly, with no error", async () => {
    const { owner, v, s, agent } = await world("q");
    await letIn(agent.id, v.id);
    const g = await newGroup(owner.id);
    const shared = await run({ agentId: agent.id, group: g, status: "queued", calls: [v.id, s.id] });
    const g2 = await newGroup(owner.id);
    const only = await run({ agentId: agent.id, group: g2, status: "queued", calls: [v.id] });
    const g3 = await newGroup(owner.id);
    const withOwner = await run({ agentId: agent.id, group: g3, status: "queued", calls: [v.id, owner.id] });
    const result = await between(owner.id, v.id);
    expect(await view(shared.id)).toMatchObject({ status: "queued", error: null, interrupted: null, calls: [shared.seqs[1]], covers: shared.seqs[1], caller: s.id, lane: "others", askers: [s.id] });
    expect(await view(only.id)).toMatchObject({ status: "cancelled", error: null, pending: null });
    // The owner's own call takes the reply over, as `dropRefusedCalls` does it at `begin`.
    expect(await view(withOwner.id)).toMatchObject({ status: "queued", calls: [withOwner.seqs[1]], caller: owner.id, lane: "own" });
    expect(result.cancelled.map((c) => c.run.id)).toEqual([only.id]);
    expect(result.cancelled[0]!.run).not.toHaveProperty("error", "access_ended");
  });

  it("running and admitted: it goes on for the others, and is stopped when every call it ANSWERS is refused; a call someone else noted on it stays", async () => {
    const { owner, v, s, agent } = await world("ra");
    await letIn(agent.id, v.id);
    const shared = await run({ agentId: agent.id, group: await newGroup(owner.id), status: "running", admitted: true, calls: [v.id, s.id] });
    const only = await run({ agentId: agent.id, group: await newGroup(owner.id), status: "running", admitted: true, calls: [v.id] });
    // A third person's CALL noted on it stays noted (its follow-up answers it); the refused person's own does not, and neither does a
    // message that is no call (a follow-up answers calls only).
    const notedOther = await run({ agentId: agent.id, group: await newGroup(owner.id), status: "running", admitted: true, calls: [v.id], noted: s.id });
    const notedOwn = await run({ agentId: agent.id, group: await newGroup(owner.id), status: "running", admitted: true, calls: [v.id], noted: v.id });
    const notedChat = await run({ agentId: agent.id, group: await newGroup(owner.id), status: "running", admitted: true, calls: [v.id], noted: s.id, notedIsCall: false });
    const result = await between(owner.id, v.id);
    expect(await view(shared.id)).toMatchObject({ status: "running", interrupted: null, calls: shared.seqs, caller: v.id });
    expect(await view(only.id)).toMatchObject({ status: "running", interrupted: "access_ended", pending: null });
    expect(await view(notedOther.id)).toMatchObject({ interrupted: "access_ended", pending: notedOther.seqs[0]! + 1 });
    expect(await view(notedOwn.id)).toMatchObject({ interrupted: "access_ended", pending: null });
    expect(await view(notedChat.id)).toMatchObject({ interrupted: "access_ended", pending: null });
    expect([...result.running].sort()).toEqual([only.id, notedOther.id, notedOwn.id, notedChat.id].sort());
  });

  it("running, not admitted yet (claimed, no model call): its calls are decided as a queued one's; with none left it is marked, for its `begin` to end before any call", async () => {
    const { owner, v, s, agent } = await world("ru");
    await letIn(agent.id, v.id);
    const shared = await run({ agentId: agent.id, group: await newGroup(owner.id), status: "running", calls: [v.id, s.id] });
    const only = await run({ agentId: agent.id, group: await newGroup(owner.id), status: "running", calls: [v.id] });
    const result = await between(owner.id, v.id);
    expect(await view(shared.id)).toMatchObject({ status: "running", interrupted: null, calls: [shared.seqs[1]], caller: s.id });
    expect(await view(only.id)).toMatchObject({ status: "running", interrupted: "access_ended", pending: null });
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

  it("a person's block of a person leaves a reply that has not begun to `begin`, and stops one in flight", async () => {
    const { owner, v, s, agent } = await world("bl");
    const queued = await run({ agentId: agent.id, group: await newGroup(owner.id), status: "queued", calls: [v.id, s.id] });
    const unadmitted = await run({ agentId: agent.id, group: await newGroup(owner.id), status: "running", calls: [v.id] });
    const inFlight = await run({ agentId: agent.id, group: await newGroup(owner.id), status: "running", admitted: true, calls: [v.id] });
    const flightShared = await run({ agentId: agent.id, group: await newGroup(owner.id), status: "running", admitted: true, calls: [v.id, s.id] });
    expect((await api(app, owner, "PUT", `/api/blocks/${v.id}`)).status).toBe(200);
    expect(await view(queued.id)).toMatchObject({ status: "queued", calls: queued.seqs });
    expect(await view(unadmitted.id)).toMatchObject({ status: "running", interrupted: null });
    expect(await view(inFlight.id)).toMatchObject({ interrupted: "access_ended" });
    expect(await view(flightShared.id)).toMatchObject({ interrupted: null, calls: flightShared.seqs });
  });
});

describe("the same through the routes: a third party's folded call survives every ending, and a reply left with no call ends with no error", () => {
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
      const shared = await run({ agentId: w.agent.id, group: await newGroup(w.owner.id), status: "queued", calls: [w.v.id, w.s.id] });
      const only = await run({ agentId: w.agent.id, group: await newGroup(w.owner.id), status: "queued", calls: [w.v.id] });
      const others = await run({ agentId: w.agent.id, group: await newGroup(w.owner.id), status: "queued", calls: [w.s.id] });
      await end(w);
      // A removal and a narrowing end the row and the social conversation; in a group they refuse nobody (access there is membership:
      // fix round 2, N2), so the person's calls stay in the group's replies. A stop and a block stand, and take them out.
      const stands = name !== "removal" && name !== "narrowing";
      expect((await db.query<{ state: string }>("select state from agent_contacts where agent_id = $1 and subject_id = $2", [w.agent.id, w.v.id])).rows[0]!.state).toBe("ended");
      expect([name, await view(shared.id)]).toEqual([name, expect.objectContaining(stands ? { status: "queued", error: null, calls: [shared.seqs[1]], caller: w.s.id } : { status: "queued", error: null, calls: shared.seqs, caller: w.v.id })]);
      expect([name, await view(only.id)]).toEqual([name, expect.objectContaining(stands ? { status: "cancelled", error: null } : { status: "queued", error: null, calls: only.seqs })]);
      expect([name, await view(others.id)]).toEqual([name, expect.objectContaining({ status: "queued", calls: others.seqs })]);
    });
  }
});
