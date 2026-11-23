import { describe, expect, it } from "vitest";
import { endGrants } from "../src/social/agent-contacts.ts";
import { api, befriend, signUp } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { SOCIAL_ON } from "./helpers/social.ts";

// A-3 review I1: ONE rule for every ending in groups. An ending never cancels a group reply as a whole: it takes THAT person's calls
// out of it. A queued reply left with no call is cancelled quietly; a running one is stopped as a social one when no call of
// anyone else is left, and goes on for the others. A person's block of a person leaves a reply that has not begun to `begin`'s own
// recheck (agents-block-recheck.test.ts), and stops one that is in flight like any ending.
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
  /** A message of this person noted on it after the calls (`pending_seq`). */
  noted?: string;
}
async function run(o: RunSpec): Promise<{ id: string; seqs: number[] }> {
  const seqs: number[] = [];
  for (const who of o.calls) seqs.push(await say(o.group, who));
  const noted = o.noted ? await say(o.group, o.noted) : null;
  const { rows } = await db.query<{ id: string }>(
    `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, call_seqs, pending_seq, triggered_by, lane, caller_id, started_at, asker_ids, model, source)
     values ('reply', $1, $2, (select owner_id from principals where id = $2), $3, $4, $5::bigint[], $6, 'human', 'others', $7, case when $3 = 'running' then now() end, $8::uuid[], $9, case when $9::text is not null then 'provider' end) returning id`,
    [o.group, o.agentId, o.status, seqs.at(-1), seqs, noted, o.caller === undefined ? o.calls[0] : o.caller, o.askers ?? [...new Set(o.calls)], o.admitted ? "fast" : null],
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
const between = (a: string, b: string) => db.tx((t) => endGrants(t, { between: [a, b] }, "barred"));

describe("an ending takes the ended person's calls out of a group reply", () => {
  it("queued: a folded third party's call survives, the reply becomes theirs; with no call left it is cancelled quietly", async () => {
    const { owner, v, s, agent } = await world("q");
    const g = await newGroup(owner.id);
    const shared = await run({ agentId: agent.id, group: g, status: "queued", calls: [v.id, s.id] });
    const g2 = await newGroup(owner.id);
    const only = await run({ agentId: agent.id, group: g2, status: "queued", calls: [v.id] });
    const g3 = await newGroup(owner.id);
    const withOwner = await run({ agentId: agent.id, group: g3, status: "queued", calls: [v.id, owner.id] });
    const result = await between(owner.id, v.id);
    expect(await view(shared.id)).toMatchObject({ status: "queued", error: null, interrupted: null, calls: [shared.seqs[1]], covers: shared.seqs[1], caller: s.id, lane: "others", askers: [s.id] });
    expect(await view(only.id)).toMatchObject({ status: "cancelled", error: "access_ended" });
    // The owner's own call takes the reply over, as `dropBlockedCalls` does it.
    expect(await view(withOwner.id)).toMatchObject({ status: "queued", calls: [withOwner.seqs[1]], caller: owner.id, lane: "own" });
    expect(result.cancelled.map((c) => c.run.id)).toEqual([only.id]);
  });

  it("running and admitted: it goes on for the others, and is stopped as a social reply when the ended person is its only caller", async () => {
    const { owner, v, s, agent } = await world("ra");
    const shared = await run({ agentId: agent.id, group: await newGroup(owner.id), status: "running", admitted: true, calls: [v.id, s.id] });
    const only = await run({ agentId: agent.id, group: await newGroup(owner.id), status: "running", admitted: true, calls: [v.id] });
    // Something of a third person noted on it stays noted (it is no call of the ended person's); with nothing noted, nothing is.
    const notedOther = await run({ agentId: agent.id, group: await newGroup(owner.id), status: "running", admitted: true, calls: [v.id], noted: s.id });
    const notedOwn = await run({ agentId: agent.id, group: await newGroup(owner.id), status: "running", admitted: true, calls: [v.id], noted: v.id });
    const result = await between(owner.id, v.id);
    expect(await view(shared.id)).toMatchObject({ status: "running", interrupted: null, calls: shared.seqs, caller: v.id });
    expect(await view(only.id)).toMatchObject({ status: "running", interrupted: "access_ended", pending: null });
    expect(await view(notedOther.id)).toMatchObject({ interrupted: "access_ended", pending: notedOther.seqs[0]! + 1 });
    expect(await view(notedOwn.id)).toMatchObject({ interrupted: "access_ended", pending: null });
    expect([...result.running].sort()).toEqual([only.id, notedOther.id, notedOwn.id].sort());
  });

  it("running, not admitted yet (claimed, no model call): decided as a queued one", async () => {
    const { owner, v, s, agent } = await world("ru");
    const shared = await run({ agentId: agent.id, group: await newGroup(owner.id), status: "running", calls: [v.id, s.id] });
    const only = await run({ agentId: agent.id, group: await newGroup(owner.id), status: "running", calls: [v.id] });
    await between(owner.id, v.id);
    expect(await view(shared.id)).toMatchObject({ status: "running", interrupted: null, calls: [shared.seqs[1]], caller: s.id });
    expect(await view(only.id)).toMatchObject({ status: "running", interrupted: "access_ended" });
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

describe("the same through the routes: a third party's folded call survives every ending", () => {
  type Ending = (w: Awaited<ReturnType<typeof world>>) => Promise<void>;
  const endings: Record<string, Ending> = {
    "停止往来": async (w) => void expect((await api(app, w.owner, "PUT", `/api/bars/${w.v.id}`)).status).toBe(200),
    unfriend: async (w) => {
      await befriend(app, w.owner, w.v);
      expect((await api(app, w.owner, "DELETE", `/api/friends/${w.v.id}`)).status).toBe(200);
    },
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
      expect([name, await view(shared.id)]).toEqual([name, expect.objectContaining({ status: "queued", error: null, calls: [shared.seqs[1]], caller: w.s.id })]);
      expect([name, await view(only.id)]).toEqual([name, expect.objectContaining({ status: "cancelled", error: "access_ended" })]);
      expect([name, await view(others.id)]).toEqual([name, expect.objectContaining({ status: "queued", calls: others.seqs })]);
    });
  }
});
