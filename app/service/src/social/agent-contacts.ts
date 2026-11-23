import type { EndedRuns } from "../agents/group-leave.ts";
import type { Config } from "../config.ts";
import { ensureSocial, lockConversation } from "../conversations/store.ts";
import type { Queryable, Tx } from "../db.ts";
import { handleOf } from "../principals/store.ts";
import { lockPairs, orderedPair } from "./pair.ts";
import { discoverable } from "./reach.ts";
import { areFriends } from "./relations.ts";

// Who may reach an Agent, per Agent: rows in `agent_contacts`, the policy that makes them, and the one function that ends them.
// Lane A: A4 (add, approve, decline, remove, the lists) is here; `endGrants` (A5a) and `applyPolicy` (A5c) are still Step 0's throwing bodies.

export type ContactPolicy = "ask" | "contacts" | "none";
export type ContactState = "requested" | "live" | "ended";
export type ContactBasis = "approved" | "contacts";
export type EndReason = "declined" | "expired" | "left" | "narrowed" | "removed" | "barred";

/** What access to end: all of two people's (an Agent of either's included), or an Agent's for the listed subjects. */
export type GrantScope = { between: readonly [string, string] } | { agentId: string; subjectIds: readonly string[] };

const LANE_A = "ring 1: lane A";

/** The only way access stops; the caller runs `announceEnded` after commit. Lane A (A5a). */
export async function endGrants(_t: Tx, _scope: GrantScope, _reason: "left" | "narrowed" | "removed" | "barred"): Promise<EndedRuns & { ended: number }> {
  throw new Error(LANE_A);
}

export interface PolicyChange {
  policy: ContactPolicy;
  picked: boolean;
  picks: readonly string[];
}

/** An owner's change of who may add an Agent: how many rows it ends (`dryRun`: counted, not ended). Lane A (A5c). */
export async function applyPolicy(_t: Tx, _ownerId: string, _agentId: string, _next: PolicyChange, _opts: { dryRun: boolean }): Promise<{ ends: number; ended: EndedRuns }> {
  throw new Error(LANE_A);
}

export type AddOutcome =
  | { state: "live"; conversationId: string }
  | { state: "requested"; until: Date }
  | { refused: "not_found" | "is_yours" }
  | { refused: "cooldown"; availableAt: Date };

type Row = { state: ContactState; until: Date | null; end_reason: EndReason | null };

/** What a change of one (Agent, subject) pair reads once it holds the locks: who is who, the Agent's facts as they are now, and the row. */
interface Locked {
  /** The person behind the subject (the subject itself, or its owner) and the Agent's owner. */
  personId: string;
  ownerId: string;
  agent: { policy: ContactPolicy; picked: boolean };
  row: Row | null;
}

/**
 * Takes the locks of a change to one row, in the service's order (plan "Lock order", attack I5): the pair locks of (the person,
 * the Agent's owner) and (the subject, the Agent), the pair's social conversation if there is one, the Agent's row, the row.
 * Everything the change decides on is read after them, so a narrowing or a delete that committed meanwhile is seen. Null when
 * the Agent is no live Agent or the subject no principal. The owner and the kinds are read before the locks: neither changes.
 */
async function lockRow(t: Tx, agentId: string, subjectId: string): Promise<Locked | null> {
  const found = await t.query<{ owner_id: string; subject_kind: "human" | "agent"; subject_owner: string | null }>(
    `select a.owner_id, s.kind as subject_kind, s.owner_id as subject_owner
       from principals a join agents ag on ag.principal_id = a.id, principals s
      where a.id = $1 and a.kind = 'agent' and s.id = $2`,
    [agentId, subjectId],
  );
  const f = found.rows[0];
  if (!f) return null;
  const personId = f.subject_kind === "human" ? subjectId : f.subject_owner!;
  await lockPairs(t, [[personId, f.owner_id], [subjectId, agentId]]);
  const [lo, hi] = orderedPair(subjectId, agentId);
  const social = await t.query<{ conversation_id: string }>("select conversation_id from social_pairs where a_id = $1 and b_id = $2", [lo, hi]);
  if (social.rows[0]) await lockConversation(t, social.rows[0].conversation_id);
  const agent = await t.query<{ contact_policy: ContactPolicy; contact_picked: boolean; deleted: boolean }>(
    "select contact_policy, contact_picked, deleted_at is not null as deleted from agents where principal_id = $1 for update",
    [agentId],
  );
  if (!agent.rows[0] || agent.rows[0].deleted) return null;
  const row = await t.query<Row>("select state, until, end_reason from agent_contacts where agent_id = $1 and subject_id = $2 for update", [agentId, subjectId]);
  return { personId, ownerId: f.owner_id, agent: { policy: agent.rows[0].contact_policy, picked: agent.rows[0].contact_picked }, row: row.rows[0] ?? null };
}

/** A request past its end is rewritten `ended`/`expired` when it is read for a decision (no sweep); true when this did it. */
async function expireIfLate(t: Tx, agentId: string, subjectId: string, row: Row | null): Promise<boolean> {
  if (!row || row.state !== "requested" || row.until === null) return false;
  const { rowCount } = await t.query(
    "update agent_contacts set state = 'ended', end_reason = 'expired', basis = null where agent_id = $1 and subject_id = $2 and state = 'requested' and until <= now()",
    [agentId, subjectId],
  );
  return (rowCount ?? 0) > 0;
}

const upsertLive = (t: Tx, agentId: string, subjectId: string, personId: string, basis: ContactBasis) =>
  t.query(
    `insert into agent_contacts (agent_id, subject_id, person_id, state, basis) values ($1, $2, $3, 'live', $4)
     on conflict (agent_id, subject_id) do update
       set person_id = excluded.person_id, state = 'live', basis = excluded.basis, since = now(), until = null, end_reason = null`,
    [agentId, subjectId, personId, basis],
  );

/**
 * A subject (a person, or an Agent of one) asks to add an Agent: let in, or waiting for the owner, or refused (design §1.2; plan
 * A4). Locks first (`lockRow`), then in order:
 *   1. one of the owner's own -> `is_yours`;
 *   2. an Agent that is not discoverable to the person and to the subject (deleted, disabled, policy none, a block, the switch
 *      off) -> `not_found`, the answer of an Agent that does not exist;
 *   3. a row of the subject's that is live answers `live` again, one that waits answers `requested` again, one that waited too
 *      long is ended `expired` and the add goes on;
 *   4. the cooldown: the subject itself is the person the owner stopped (a bar the owner set by 停止往来, not a block's) in the
 *      last `cooldownDays`, or a row of any of this person's subjects on this Agent was declined and its `until` is ahead ->
 *      `cooldown` with when it ends (a stop never holds back the person's Agents: theirs becomes a request, by the bar);
 *   5. a bar between the person and the owner, or the subject's own row ended `narrowed`, `removed` or `barred` -> a request;
 *   6. `contacts`, the person a friend of the owner and (no picks, or the person is picked) -> `live`, basis `contacts`;
 *   7. otherwise a request, to wait `requestDays`.
 * Dates are the database's `now()`.
 */
export async function addContact(t: Tx, config: Pick<Config, "social" | "others">, subjectId: string, agentId: string): Promise<AddOutcome> {
  const locked = await lockRow(t, agentId, subjectId);
  if (!locked) return { refused: "not_found" };
  const { personId, ownerId, agent } = locked;
  if (personId === ownerId) return { refused: "is_yours" };
  if (!(await discoverable(t, agentId, personId, config)) || (subjectId !== personId && !(await discoverable(t, agentId, subjectId, config)))) {
    return { refused: "not_found" };
  }
  let row = locked.row;
  if (await expireIfLate(t, agentId, subjectId, row)) row = { state: "ended", until: null, end_reason: "expired" };
  if (row?.state === "live") return { state: "live", conversationId: (await ensureSocial(t, subjectId, agentId)).conversationId };
  if (row?.state === "requested") return { state: "requested", until: row.until! };

  const [lo, hi] = orderedPair(personId, ownerId);
  const days = config.others.cooldownDays;
  const stopped =
    subjectId === personId
      ? (
          await t.query<{ at: Date }>(
            `select since + make_interval(days => $3) as at from access_bars
              where lo_id = $1 and hi_id = $2 and reason = 'stopped' and set_by = $4 and not by_block and since + make_interval(days => $3) > now()`,
            [lo, hi, days, ownerId],
          )
        ).rows[0]?.at
      : undefined;
  const declined = (
    await t.query<{ at: Date | null }>(
      "select max(until) as at from agent_contacts where agent_id = $1 and person_id = $2 and state = 'ended' and end_reason = 'declined' and until > now()",
      [agentId, personId],
    )
  ).rows[0]?.at;
  const waitUntil = [stopped, declined].filter((d): d is Date => d instanceof Date).sort((x, y) => y.getTime() - x.getTime())[0];
  if (waitUntil) return { refused: "cooldown", availableAt: waitUntil };

  const barred = ((await t.query("select 1 from access_bars where lo_id = $1 and hi_id = $2", [lo, hi])).rowCount ?? 0) > 0;
  const closedBefore = row?.state === "ended" && (row.end_reason === "narrowed" || row.end_reason === "removed" || row.end_reason === "barred");
  if (!barred && !closedBefore && agent.policy === "contacts" && (await areFriends(t, personId, ownerId))) {
    const picked = !agent.picked || ((await t.query("select 1 from agent_contact_picks where agent_id = $1 and person_id = $2", [agentId, personId])).rowCount ?? 0) > 0;
    if (picked) {
      await upsertLive(t, agentId, subjectId, personId, "contacts");
      return { state: "live", conversationId: (await ensureSocial(t, subjectId, agentId)).conversationId };
    }
  }
  const asked = await t.query<{ until: Date }>(
    `insert into agent_contacts (agent_id, subject_id, person_id, state, until) values ($1, $2, $3, 'requested', now() + make_interval(days => $4))
     on conflict (agent_id, subject_id) do update
       set person_id = excluded.person_id, state = 'requested', basis = null, since = now(), until = excluded.until, end_reason = null
     returning until`,
    [agentId, subjectId, personId, config.others.requestDays],
  );
  return { state: "requested", until: asked.rows[0]!.until };
}

/**
 * The Agent's owner lets a requester in: the row becomes `live`, basis `approved`, since now. `not_found` when the Agent is not
 * the caller's (or is deleted): the answer of an Agent that does not exist; `not_requested` when nothing waits (no row, another
 * state, or a request that ran out, which is ended `expired` here). It never touches a bar.
 */
export async function approveContact(t: Tx, ownerId: string, agentId: string, subjectId: string): Promise<{ conversationId: string } | { refused: "not_found" | "not_requested" }> {
  if (!(await isOwner(t, ownerId, agentId))) return { refused: "not_found" };
  const locked = await lockRow(t, agentId, subjectId);
  if (!locked) return { refused: "not_requested" };
  if (await expireIfLate(t, agentId, subjectId, locked.row)) return { refused: "not_requested" };
  if (locked.row?.state !== "requested") return { refused: "not_requested" };
  await upsertLive(t, agentId, subjectId, locked.personId, "approved");
  return { conversationId: (await ensureSocial(t, subjectId, agentId)).conversationId };
}

/** The owner declines a request: ended `declined`, with `until` = now + `cooldownDays` (what a re-ask is held off until). */
export async function declineContact(t: Tx, ownerId: string, agentId: string, subjectId: string, config: Pick<Config, "others">): Promise<{ ok: true } | { refused: "not_found" | "not_requested" }> {
  if (!(await isOwner(t, ownerId, agentId))) return { refused: "not_found" };
  const locked = await lockRow(t, agentId, subjectId);
  if (!locked) return { refused: "not_requested" };
  if (await expireIfLate(t, agentId, subjectId, locked.row)) return { refused: "not_requested" };
  if (locked.row?.state !== "requested") return { refused: "not_requested" };
  await t.query(
    "update agent_contacts set state = 'ended', end_reason = 'declined', basis = null, until = now() + make_interval(days => $3) where agent_id = $1 and subject_id = $2",
    [agentId, subjectId, config.others.cooldownDays],
  );
  return { ok: true };
}

/**
 * Ends an access: by the Agent's owner a live row is `removed`; by the subject a live or waiting one is `left`. Null for anyone
 * else and for a row that is not there or is ended already (one answer for all: the route's 404). Ending a row here stops no run;
 * A5a's `endGrants` does that, and takes this over.
 */
export async function removeContact(t: Tx, actorId: string, agentId: string, subjectId: string): Promise<(EndedRuns & { ended: number }) | null> {
  const byOwner = await isOwner(t, actorId, agentId);
  if (!byOwner && actorId !== subjectId) return null;
  const locked = await lockRow(t, agentId, subjectId);
  const state = locked?.row?.state;
  if (!locked || !(state === "live" || (state === "requested" && !byOwner))) return null;
  await t.query("update agent_contacts set state = 'ended', end_reason = $3, basis = null, until = null where agent_id = $1 and subject_id = $2", [
    agentId,
    subjectId,
    byOwner ? "removed" : "left",
  ]);
  return { cancelled: [], running: [], ended: 1 };
}

/** Whether `ownerId` owns the live Agent `agentId`: read before any lock (an Agent's owner is its owner for good). */
async function isOwner(q: Queryable, ownerId: string, agentId: string): Promise<boolean> {
  const { rowCount } = await q.query(
    "select 1 from principals p join agents a on a.principal_id = p.id where p.id = $1 and p.kind = 'agent' and p.owner_id = $2 and a.deleted_at is null",
    [agentId, ownerId],
  );
  return (rowCount ?? 0) > 0;
}

export interface MineRow {
  agentId: string;
  state: ContactState;
  conversationId: string | null;
  since: string;
  until: string | null;
  /** Of an ended row only, and never why: `declined`, or `ended` for every other way. */
  ended: "declined" | "ended" | null;
}
export interface WaitingRow {
  agentId: string;
  subject: { id: string; handle: string; displayName: string; avatarVersion: number; kind: "human" | "agent"; ownerId?: string; ownerName?: string };
  since: string;
  until: string;
}

/**
 * The caller's rows as a subject (`mine`, newest first: a request that ran out reads as ended, as a decision would leave it, and
 * nothing says why a row ended) and the requests waiting on the Agents they own (`waiting`, newest first; the subject as a
 * person, or as an Agent with its owner). Every row, no page.
 */
export async function contactsOf(q: Queryable, me: string): Promise<{ mine: MineRow[]; waiting: WaitingRow[] }> {
  const mine = await q.query<{ agent_id: string; state: ContactState; end_reason: EndReason | null; conversation_id: string | null; since: Date; until: Date | null }>(
    `select c.agent_id, case when c.state = 'requested' and c.until <= now() then 'ended' else c.state end as state,
            case when c.state = 'requested' and c.until <= now() then 'expired' else c.end_reason end as end_reason,
            (select sp.conversation_id from social_pairs sp where sp.a_id = least(c.subject_id, c.agent_id) and sp.b_id = greatest(c.subject_id, c.agent_id)) as conversation_id,
            c.since, c.until
       from agent_contacts c join agents a on a.principal_id = c.agent_id and a.deleted_at is null
      where c.subject_id = $1
      order by c.since desc, c.agent_id`,
    [me],
  );
  const waiting = await q.query<{
    agent_id: string;
    since: Date;
    until: Date;
    id: string;
    handle: string;
    display_name: string;
    avatar_version: number;
    kind: "human" | "agent";
    owner_id: string | null;
    owner_name: string | null;
  }>(
    `select c.agent_id, c.since, c.until, s.id, ${handleOf("s")} as handle, s.display_name, s.avatar_version, s.kind, s.owner_id, so.display_name as owner_name
       from agent_contacts c
       join principals p on p.id = c.agent_id and p.owner_id = $1
       join agents a on a.principal_id = c.agent_id and a.deleted_at is null
       join principals s on s.id = c.subject_id
       left join principals so on so.id = s.owner_id
      where c.state = 'requested' and c.until > now()
      order by c.since desc, c.agent_id, c.subject_id`,
    [me],
  );
  return {
    mine: mine.rows.map((r) => ({
      agentId: r.agent_id,
      state: r.state,
      conversationId: r.conversation_id,
      since: r.since.toISOString(),
      until: r.state === "ended" && r.end_reason !== "declined" ? null : (r.until?.toISOString() ?? null),
      ended: r.state === "ended" ? (r.end_reason === "declined" ? "declined" : "ended") : null,
    })),
    waiting: waiting.rows.map((r) => ({
      agentId: r.agent_id,
      subject: {
        id: r.id,
        handle: r.handle,
        displayName: r.display_name,
        avatarVersion: r.avatar_version,
        kind: r.kind,
        ...(r.kind === "agent" ? { ownerId: r.owner_id!, ownerName: r.owner_name ?? "" } : {}),
      },
      since: r.since.toISOString(),
      until: r.until.toISOString(),
    })),
  };
}
