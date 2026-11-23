import type { EndedRuns } from "../agents/group-leave.ts";
import { RUN_COLUMNS, toWireRun, type Announced, type RunRow } from "../agents/runs.ts";
import type { Config } from "../config.ts";
import { ensureSocial, lockConversation } from "../conversations/store.ts";
import type { Queryable, Tx } from "../db.ts";
import { lockOwnedAgent } from "../agents/store.ts";
import { AppError } from "../errors.ts";
import { handleOf } from "../principals/store.ts";
import { lockPair, lockPairs, orderedPair } from "./pair.ts";
import { discoverable, discoverableSql, reach } from "./reach.ts";
import { areFriends } from "./relations.ts";

// Who may reach an Agent, per Agent: rows in `agent_contacts`, the policy that makes them, and the one function that ends them.
// Lane A: A4 (add, approve, decline, remove, the lists), A5a (`endGrants`), A5b (the bars) and A5c (`applyPolicy`) are here.

export type ContactPolicy = "ask" | "contacts" | "none";
export type ContactState = "requested" | "live" | "ended";
export type ContactBasis = "approved" | "contacts";
export type EndReason = "declined" | "expired" | "left" | "narrowed" | "removed" | "barred";

/** What access to end: all of two people's (an Agent of either's included), or an Agent's for the listed subjects. */
export type GrantScope = { between: readonly [string, string] } | { agentId: string; subjectIds: readonly string[] };

/**
 * The only way access stops (design §1.2; plan A5a). In the caller's transaction, after its pair locks and any direct chat's
 * notice (`endGrants` takes no conversation row):
 *   1. the Agents' rows `for update`, in id order (`between`: every Agent of both people, deleted ones too);
 *   2. the rows in scope that are `live` or `requested` end with `reason` (`between [A, B]`: the rows on A's Agents whose person
 *      is B and on B's Agents whose person is A, an Agent of the other's included; `agentId`: that Agent's rows for the listed
 *      subjects);
 *   3. (the errands plan adds its one statement here);
 *   4. the queued reply runs of those Agents are `cancelled` with `access_ended` and the running ones are marked `interrupted`
 *      (`access_ended` unless one is marked already), what was noted on them dropped (`pending_seq` null): the runs in the pair's
 *      social conversations (the other end a listed subject, or a person of the other side) and the runs in groups whose
 *      `caller_id` is the person concerned (not `asker_ids`: attack M5).
 * The queued runs are taken before the running ones, each in a statement of its own: a run being claimed at that moment is
 * either seen queued (its claim waits on our row, finds it cancelled) or already running when the second statement looks.
 * The caller runs `announceEnded` after commit. Nothing here writes a bar.
 */
export function endGrants(t: Tx, scope: GrantScope, reason: "left" | "narrowed" | "removed" | "barred"): Promise<EndedRuns & { ended: number }> {
  return endGrantsIn(t, scope, reason, { groups: true });
}

/**
 * `endGrants`, with a choice for step 4's group runs. A person's block of a person (`setBar`'s origin `block`) leaves them to
 * the check that exists already: a group's reply meets a block as it begins, call by call, and a reply that answers several
 * calls keeps answering the others (agents-block-recheck.test.ts); ending the whole reply here would drop the owner's own call
 * folded into it. So that block ends the rows and the runs in the pair's social conversations only (`groups: false`).
 */
async function endGrantsIn(t: Tx, scope: GrantScope, reason: "left" | "narrowed" | "removed" | "barred", o: { groups: boolean }): Promise<EndedRuns & { ended: number }> {
  const agents =
    "between" in scope
      ? await t.query<{ id: string }>(
          `select a.principal_id as id from agents a join principals p on p.id = a.principal_id
            where p.owner_id = any($1::uuid[]) order by a.principal_id for update of a`,
          [[...scope.between]],
        )
      : await t.query<{ id: string }>("select principal_id as id from agents where principal_id = $1 for update", [scope.agentId]);
  if (agents.rows.length === 0) return { cancelled: [], running: [], ended: 0 };

  // The runs' scope, as SQL over `r` (agent_runs) and `ag` (the run's Agent as a principal).
  const inSocial = "exists (select 1 from social_pairs rsp where rsp.conversation_id = r.conversation_id and r.agent_id in (rsp.a_id, rsp.b_id)";
  const inGroup = "exists (select 1 from conversations rc where rc.id = r.conversation_id and rc.type = 'group')";
  let endRows: { sql: string; params: unknown[] };
  let runsIn: { sql: string; params: unknown[] };
  if ("between" in scope) {
    const [a, b] = scope.between;
    const concerned = "(case when ag.owner_id = $1::uuid then $2::uuid else $1::uuid end)";
    endRows = {
      sql: `update agent_contacts c set state = 'ended', end_reason = $3::text, basis = null, until = null
              from principals ag
             where ag.id = c.agent_id and c.state in ('live', 'requested')
               and ((ag.owner_id = $1::uuid and c.person_id = $2::uuid) or (ag.owner_id = $2::uuid and c.person_id = $1::uuid))`,
      params: [a, b, reason],
    };
    runsIn = {
      sql: `ag.owner_id in ($1::uuid, $2::uuid) and (
              (${inSocial} and exists (select 1 from principals ro where ro.id = case when rsp.a_id = r.agent_id then rsp.b_id else rsp.a_id end
                                         and coalesce(ro.owner_id, ro.id) = ${concerned})))
              ${o.groups ? `or (r.caller_id = ${concerned} and ${inGroup})` : ""})`,
      params: [a, b],
    };
  } else {
    const persons = await t.query<{ person: string }>("select distinct coalesce(owner_id, id) as person from principals where id = any($1::uuid[])", [[...scope.subjectIds]]);
    endRows = {
      sql: `update agent_contacts c set state = 'ended', end_reason = $3::text, basis = null, until = null
             where c.agent_id = $1::uuid and c.subject_id = any($2::uuid[]) and c.state in ('live', 'requested')`,
      params: [scope.agentId, [...scope.subjectIds], reason],
    };
    runsIn = {
      sql: `r.agent_id = $1::uuid and (
              (${inSocial} and (rsp.a_id = any($2::uuid[]) or rsp.b_id = any($2::uuid[]))))
              ${o.groups ? `or (r.caller_id = any($3::uuid[]) and ${inGroup})` : ""})`,
      params: o.groups ? [scope.agentId, [...scope.subjectIds], persons.rows.map((p) => p.person)] : [scope.agentId, [...scope.subjectIds]],
    };
  }
  const ended = await t.query(endRows.sql, endRows.params);

  const queued = await t.query<RunRow & { conversation_id: string; owner_id: string }>(
    `update agent_runs r set status = 'cancelled', error = 'access_ended', finished_at = now()
       from principals ag
      where ag.id = r.agent_id and r.purpose = 'reply' and r.status = 'queued' and ${runsIn.sql}
      returning ${RUN_COLUMNS}, r.conversation_id, r.owner_id`,
    runsIn.params,
  );
  const running = await t.query<{ id: string }>(
    `update agent_runs r set interrupted = coalesce(r.interrupted, 'access_ended'), pending_seq = null
       from principals ag
      where ag.id = r.agent_id and r.purpose = 'reply' and r.status = 'running' and ${runsIn.sql}
      returning r.id`,
    runsIn.params,
  );
  const cancelled: Announced[] = queued.rows.map((r) => ({ ownerId: r.owner_id, conversationId: r.conversation_id, run: toWireRun(r) }));
  return { cancelled, running: running.rows.map((r) => r.id), ended: ended.rowCount ?? 0 };
}

type BarRow = { reason: "stopped" | "unfriended"; set_by: string; by_block: boolean };
const readBar = async (t: Tx, a: string, b: string): Promise<BarRow | undefined> => {
  const [lo, hi] = orderedPair(a, b);
  return (await t.query<BarRow>("select reason, set_by, by_block from access_bars where lo_id = $1 and hi_id = $2 for update", [lo, hi])).rows[0];
};

/**
 * The ONE writer of bars (Controller ruling 2026-11-24, Q4; design §1.2): 停止往来, an unfriend that ended a row, and every
 * block of a person by a person (in the block's own transaction). `lockPair`, then one row per pair: the stricter reason is
 * kept (`stopped` over `unfriended`) and `since` is now on every write. A new row: `set_by` the setter, `by_block` only for a
 * block. An existing one written by a stop or an unfriend: `by_block` false (it stands for more than a block now) and `set_by`
 * the setter when the bar is `stopped` after the write; written by a block: `set_by` and `by_block` stay as they are. Then
 * `endGrants` ends every live or waiting row between the two sides, `barred` (a block: and the runs in their social conversations
 * only, see `endGrantsIn`). Lifting a bar brings no row back. Run it after
 * the pair's direct chat's notice (the lock order); the caller announces the ended runs after commit.
 */
export async function setBar(t: Tx, setterId: string, otherId: string, reason: "stopped" | "unfriended", origin: "stop" | "unfriend" | "block"): Promise<EndedRuns & { ended: number }> {
  await lockPair(t, setterId, otherId);
  const [lo, hi] = orderedPair(setterId, otherId);
  const cur = await readBar(t, setterId, otherId);
  if (!cur) {
    await t.query("insert into access_bars (lo_id, hi_id, reason, set_by, by_block) values ($1, $2, $3, $4, $5)", [lo, hi, reason, setterId, origin === "block"]);
  } else {
    const next = cur.reason === "stopped" || reason === "stopped" ? "stopped" : "unfriended";
    if (origin === "block") await t.query("update access_bars set reason = $3, since = now() where lo_id = $1 and hi_id = $2", [lo, hi, next]);
    else
      await t.query("update access_bars set reason = $3, by_block = false, set_by = case when $3 = 'stopped' then $4::uuid else set_by end, since = now() where lo_id = $1 and hi_id = $2", [lo, hi, next, setterId]);
  }
  return endGrantsIn(t, { between: [setterId, otherId] }, "barred", { groups: origin !== "block" });
}

/**
 * 恢复往来: deletes the bar `setterId` set when it does not stand for a block. False: none (no bar, someone else's, or a block's).
 * If a block between the two still stands under it (the setter's own, else the other's), the stop is lifted and the bar stays
 * for that block, handed to it: a block never stands without a bar.
 */
export async function liftBar(t: Tx, setterId: string, otherId: string): Promise<boolean> {
  await lockPair(t, setterId, otherId);
  const cur = await readBar(t, setterId, otherId);
  if (!cur || cur.set_by !== setterId || cur.by_block) return false;
  const [lo, hi] = orderedPair(setterId, otherId);
  const blockers = await t.query<{ blocker_id: string }>(
    "select blocker_id from blocks where (blocker_id = $1 and blocked_id = $2) or (blocker_id = $2 and blocked_id = $1) order by (blocker_id = $1) desc",
    [setterId, otherId],
  );
  if (blockers.rows[0]) {
    await t.query("update access_bars set reason = 'stopped', set_by = $3, by_block = true where lo_id = $1 and hi_id = $2", [lo, hi, blockers.rows[0].blocker_id]);
  } else {
    await t.query("delete from access_bars where lo_id = $1 and hi_id = $2", [lo, hi]);
  }
  return true;
}

/**
 * In the unblock's transaction, after the block row is deleted: lifts only the bar that block set (`set_by` the unblocker,
 * `by_block`); if the other person still blocks the unblocker, the bar passes to that block. False: this block set no bar.
 */
export async function liftBlockBar(t: Tx, unblockerId: string, otherId: string): Promise<boolean> {
  await lockPair(t, unblockerId, otherId);
  const cur = await readBar(t, unblockerId, otherId);
  if (!cur || cur.set_by !== unblockerId || !cur.by_block) return false;
  const [lo, hi] = orderedPair(unblockerId, otherId);
  const theirs = await t.query("select 1 from blocks where blocker_id = $2 and blocked_id = $1", [unblockerId, otherId]);
  if ((theirs.rowCount ?? 0) > 0) await t.query("update access_bars set set_by = $3 where lo_id = $1 and hi_id = $2", [lo, hi, otherId]);
  else await t.query("delete from access_bars where lo_id = $1 and hi_id = $2", [lo, hi]);
  return true;
}

export interface PolicyChange {
  policy: ContactPolicy;
  picked: boolean;
  picks: readonly string[];
}

/**
 * An owner's change of who may add an Agent (design §1.2; plan A5c), under `lockOwnedAgent` (404 for anyone else's): the rows
 * the new setting would not create end `narrowed`, and what their persons called on this Agent stops (`endGrants`):
 *   - to `none`: every live and waiting row;
 *   - to `ask`: the live rows of basis `contacts`;
 *   - to `contacts` with picks: the live rows of basis `contacts` whose person is not picked or no longer a friend.
 * Approved rows stay under `ask` and `contacts`; widening ends and creates nothing. `dryRun` counts and writes nothing;
 * otherwise the setting and its picks (replaced) are saved in the same transaction, so an add or an approval waiting on the
 * Agent's row meets the new setting. `subjects` are the subjects whose rows ended (for the caller's announcements). 400
 * `invalid_request` when a pick is no person, or is the owner.
 */
export async function applyPolicy(
  t: Tx,
  ownerId: string,
  agentId: string,
  next: PolicyChange,
  opts: { dryRun: boolean },
): Promise<{ ends: number; ended: EndedRuns; subjects: string[] }> {
  await lockOwnedAgent(t, ownerId, agentId);
  const picks = [...new Set(next.picks)];
  if (picks.length > 0) {
    const real = await t.query("select 1 from principals where id = any($1::uuid[]) and kind = 'human' and id <> $2", [picks, ownerId]);
    if ((real.rowCount ?? 0) !== picks.length) throw new AppError(400, "invalid_request");
  }
  const affected =
    next.policy === "none"
      ? await t.query<{ subject_id: string }>("select subject_id from agent_contacts where agent_id = $1 and state in ('live', 'requested') order by subject_id", [agentId])
      : next.policy === "ask"
        ? await t.query<{ subject_id: string }>("select subject_id from agent_contacts where agent_id = $1 and state = 'live' and basis = 'contacts' order by subject_id", [agentId])
        : next.picked
          ? await t.query<{ subject_id: string }>(
              `select c.subject_id from agent_contacts c
                where c.agent_id = $1 and c.state = 'live' and c.basis = 'contacts'
                  and (not (c.person_id = any($2::uuid[]))
                       or not exists (select 1 from friendships f where f.a_id = least(c.person_id, $3::uuid) and f.b_id = greatest(c.person_id, $3::uuid)))
                order by c.subject_id`,
              [agentId, picks, ownerId],
            )
          : { rows: [] as Array<{ subject_id: string }> };
  const subjects = affected.rows.map((r) => r.subject_id);
  if (opts.dryRun) return { ends: subjects.length, ended: { cancelled: [], running: [] }, subjects: [] };
  await t.query("update agents set contact_policy = $2, contact_picked = $3 where principal_id = $1", [agentId, next.policy, next.picked]);
  await t.query("delete from agent_contact_picks where agent_id = $1", [agentId]);
  if (picks.length > 0) await t.query("insert into agent_contact_picks (agent_id, person_id) select $1, unnest($2::uuid[])", [agentId, picks]);
  if (subjects.length === 0) return { ends: 0, ended: { cancelled: [], running: [] }, subjects: [] };
  const done = await endGrants(t, { agentId, subjectIds: subjects }, "narrowed");
  return { ends: done.ended, ended: { cancelled: done.cancelled, running: done.running }, subjects };
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
  /** The subject is an Agent that is deleted. */
  subjectDeleted: boolean;
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
  const found = await t.query<{ owner_id: string; subject_kind: "human" | "agent"; subject_owner: string | null; subject_deleted: boolean }>(
    `select a.owner_id, s.kind as subject_kind, s.owner_id as subject_owner,
            exists (select 1 from agents sa where sa.principal_id = s.id and sa.deleted_at is not null) as subject_deleted
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
  return { personId, ownerId: f.owner_id, subjectDeleted: f.subject_deleted, agent: { policy: agent.rows[0].contact_policy, picked: agent.rows[0].contact_picked }, row: row.rows[0] ?? null };
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
  // One statement, before any lock, tells an Agent nobody may find from one that is not there: both are answered after it, so
  // that neither costs the caller more than the other (an Agent that is hidden from the caller must not take longer to refuse).
  const socialOn = config.social.enabled ? "true" : "false";
  const pre = await t.query<{ own: boolean; disc: boolean; subject_deleted: boolean }>(
    `select (coalesce(s.owner_id, s.id) = a.owner_id) as own,
            ${discoverableSql({ agent: "a.id", viewer: "coalesce(s.owner_id, s.id)", socialOn })}
              and (s.kind = 'human' or ${discoverableSql({ agent: "a.id", viewer: "s.id", socialOn })}) as disc,
            exists (select 1 from agents sa where sa.principal_id = s.id and sa.deleted_at is not null) as subject_deleted
       from principals a, principals s where a.id = $1 and a.kind = 'agent' and s.id = $2`,
    [agentId, subjectId],
  );
  const seen = pre.rows[0];
  if (!seen || seen.subject_deleted || (!seen.own && !seen.disc)) return { refused: "not_found" };
  const locked = await lockRow(t, agentId, subjectId);
  if (!locked) return { refused: "not_found" };
  const { personId, ownerId, agent } = locked;
  if (personId === ownerId) return { refused: "is_yours" };
  // Read again under the locks: what the statement above saw may have changed.
  if (locked.subjectDeleted || !(await discoverable(t, agentId, personId, config)) || (subjectId !== personId && !(await discoverable(t, agentId, subjectId, config)))) {
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
  const closed = (r: { state: ContactState; end_reason: EndReason | null } | undefined | null): boolean =>
    r?.state === "ended" && (r.end_reason === "narrowed" || r.end_reason === "removed" || r.end_reason === "barred");
  // The person's own row on this Agent counts for their Agent as well (design §1.2: "an ended row of P on this Agent").
  const personRow = subjectId === personId ? row : (await t.query<Row>("select state, until, end_reason from agent_contacts where agent_id = $1 and subject_id = $2", [agentId, personId])).rows[0];
  const closedBefore = closed(row) || closed(personRow);
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
  if (locked.row?.state !== "requested" || locked.subjectDeleted) return { refused: "not_requested" };
  // A block made after the request, either way, or an Agent gone since, ends the wait (a bar does not: an approval passes it).
  const standing = await reach(t, subjectId, agentId, "social", { social: { enabled: true } });
  if (standing === "blocked" || standing === "gone") return { refused: "not_requested" };
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
 * Ends an access: by the Agent's owner the person's live row is `removed`, and so are the rows of the person's Agents on this
 * Agent, live or waiting (design §1.2); by the subject a live or waiting row is `left`, its own only. Null for anyone else and
 * for a row that is not there or is ended already, and for the owner a row that only waits (they decline it): one answer for
 * all, the route's 404. `endGrants` ends the rows and stops what the person called on this Agent.
 */
export async function removeContact(t: Tx, actorId: string, agentId: string, subjectId: string): Promise<(EndedRuns & { ended: number }) | null> {
  const byOwner = await isOwner(t, actorId, agentId);
  if (!byOwner && actorId !== subjectId) return null;
  const locked = await lockRow(t, agentId, subjectId);
  const state = locked?.row?.state;
  if (!locked || !(state === "live" || (state === "requested" && !byOwner))) return null;
  const subjectIds = byOwner
    ? (
        await t.query<{ subject_id: string }>(
          "select subject_id from agent_contacts where agent_id = $1 and person_id = $2 and state in ('live', 'requested') order by subject_id",
          [agentId, locked.personId],
        )
      ).rows.map((r) => r.subject_id)
    : [subjectId];
  return endGrants(t, { agentId, subjectIds }, byOwner ? "removed" : "left");
}

/** Whether `ownerId` owns the live Agent `agentId`: read before any lock (an Agent's owner is its owner for good). */
async function isOwner(q: Queryable, ownerId: string, agentId: string): Promise<boolean> {
  const { rowCount } = await q.query(
    "select 1 from principals p join agents a on a.principal_id = p.id where p.id = $1 and p.kind = 'agent' and p.owner_id = $2 and a.deleted_at is null",
    [agentId, ownerId],
  );
  return (rowCount ?? 0) > 0;
}

export interface AgentContactRow {
  subject: WaitingRow["subject"];
  state: ContactState;
  basis: ContactBasis | null;
  since: string;
  until: string | null;
  /** The real reason, for the owner: a request that ran out reads `expired`. */
  endReason: EndReason | null;
  conversationId: string | null;
}

/**
 * What an Agent's owner sees of who can reach it (plan A5c, `GET /api/agents/:id/contacts`): the setting, the picks, every
 * row (newest first; a late request reads ended `expired`), and the Agent's social conversations (「它和别人的对话」, newest
 * first, each with the other end). Null for anyone but the owner and for a deleted Agent.
 */
export async function contactsOfAgent(q: Queryable, ownerId: string, agentId: string): Promise<{
  policy: ContactPolicy;
  picked: boolean;
  picks: string[];
  rows: AgentContactRow[];
  conversations: Array<{ conversationId: string; subject: WaitingRow["subject"] }>;
} | null> {
  const a = await q.query<{ contact_policy: ContactPolicy; contact_picked: boolean }>(
    "select a.contact_policy, a.contact_picked from agents a join principals p on p.id = a.principal_id where a.principal_id = $1 and p.owner_id = $2 and a.deleted_at is null",
    [agentId, ownerId],
  );
  if (!a.rows[0]) return null;
  const picks = await q.query<{ person_id: string }>("select person_id from agent_contact_picks where agent_id = $1 order by person_id", [agentId]);
  type S = { id: string; handle: string; display_name: string; avatar_version: number; kind: "human" | "agent"; owner_id: string | null; owner_name: string | null };
  const subjectOf = (r: S): WaitingRow["subject"] => ({
    id: r.id,
    handle: r.handle,
    displayName: r.display_name,
    avatarVersion: r.avatar_version,
    kind: r.kind,
    ...(r.kind === "agent" ? { ownerId: r.owner_id!, ownerName: r.owner_name ?? "" } : {}),
  });
  const cols = `s.id, ${handleOf("s")} as handle, s.display_name, s.avatar_version, s.kind, s.owner_id, so.display_name as owner_name`;
  const rows = await q.query<S & { state: ContactState; basis: ContactBasis | null; end_reason: EndReason | null; since: Date; until: Date | null; conversation_id: string | null }>(
    `select ${cols},
            case when c.state = 'requested' and c.until <= now() then 'ended' else c.state end as state, c.basis,
            case when c.state = 'requested' and c.until <= now() then 'expired' else c.end_reason end as end_reason,
            c.since, c.until,
            (select sp.conversation_id from social_pairs sp where sp.a_id = least(c.subject_id, c.agent_id) and sp.b_id = greatest(c.subject_id, c.agent_id)) as conversation_id
       from agent_contacts c join principals s on s.id = c.subject_id left join principals so on so.id = s.owner_id
      where c.agent_id = $1
      order by c.since desc, c.subject_id`,
    [agentId],
  );
  const conversations = await q.query<S & { conversation_id: string }>(
    `select ${cols}, sp.conversation_id
       from social_pairs sp join conversations cv on cv.id = sp.conversation_id
       join principals s on s.id = case when sp.a_id = $1 then sp.b_id else sp.a_id end left join principals so on so.id = s.owner_id
      where $1 in (sp.a_id, sp.b_id)
      order by cv.created_at desc, sp.conversation_id`,
    [agentId],
  );
  return {
    policy: a.rows[0].contact_policy,
    picked: a.rows[0].contact_picked,
    picks: picks.rows.map((r) => r.person_id),
    rows: rows.rows.map((r) => ({
      subject: subjectOf(r),
      state: r.state,
      basis: r.state === "live" ? r.basis : null,
      since: r.since.toISOString(),
      until: r.until && r.state !== "live" ? r.until.toISOString() : null,
      endReason: r.state === "ended" ? r.end_reason : null,
      conversationId: r.conversation_id,
    })),
    conversations: conversations.rows.map((r) => ({ conversationId: r.conversation_id, subject: subjectOf(r) })),
  };
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
      where c.subject_id = $1 and c.person_id = $1
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
        and not exists (select 1 from agents sa where sa.principal_id = s.id and sa.deleted_at is not null)
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
