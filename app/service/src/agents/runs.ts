import type { FastifyBaseLogger } from "fastify";
import { z } from "zod";
import { lockAccount, siteDayStart } from "../accounts/store.ts";
import type { Config } from "../config.ts";
import { currentMembership, lockForWrite, peekConversation, type ConversationType, type WriteLock } from "../conversations/store.ts";
import { appendSystem } from "../conversations/system.ts";
import type { Queryable, Tx } from "../db.ts";
import { AppError, notFound } from "../errors.ts";
import { notAcknowledgement, type StoredMessage, type SystemEvent } from "../messages/model.ts";
import { postingRun } from "../messages/read.ts";
import { othersReached } from "../metering/others.ts";
import { reach } from "../social/reach.ts";
import { groupPlaceSql, placeOf, placeOfType, socialPlaceSql, type Place } from "../social/place.ts";
import { blockedEitherWay } from "../social/relations.ts";
import type { Hub } from "../sync/hub.ts";
import { modelsUsable, modelUsable } from "../models/resolve.ts";
import type { RunEnd } from "./runtime/port.ts";
import { agentModelOf, lockAgent, type AgentRow } from "./store.ts";
import { mayTell, tellableRuns } from "../whispers/store.ts";

/**
 * Reply runs (`agent_runs` rows of purpose `reply`) as the routes and the send path see them: the trigger, retry, stop,
 * dismiss, the latest run of a conversation, and what a group's members may know of its Agents' replies (`groupRuns`,
 * `runAudience`: the owner the run, everyone else its state). The worker's side is `port-impl.ts`. A run belongs to
 * one conversation (`conversation_id`), and everything here acts on that one: an Agent has at most one queued or
 * running run per conversation, and a message is folded only into the active run of its own conversation. In a group
 * a message calls the Agents its stored mentions mean (`messages.mentions`, decided once when it was sent:
 * mentions.ts; `triggerInGroup`, `triggerFromAgent`), under brakes on Agents calling Agents
 * (the chain limit, the halt, the chain budget) and, on what other people's calls spend of an owner's points, the
 * Agent's others' daily budget (`othersBudgetSpent`). Lock order everywhere: the run's conversation row → `agents` rows
 * (`lockAgent`; several in id order) → run rows → `accounts` rows (several in id order).
 */

export const RUN_STATUSES = ["queued", "running", "done", "failed", "stopped", "cancelled"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/**
 * Errors after which trying again unchanged does not help (the key, the address, the Agent itself, a context too small
 * for the persona: the owner must change something first). A model that is gone (`model_gone`) is `retryable`'s own
 * case: it follows the Agent's model as it is now.
 */
const NOT_RETRYABLE: ReadonlySet<string> = new Set(["provider_rejected", "address_not_allowed", "agent_deleted", "context_too_small"]);

/**
 * The one rule of `retryable` (README "Run"): the run failed, trying it again as it is may work (not after an error of
 * `NOT_RETRYABLE`), and the Agent's model is there to call (`modelUsable`, models/resolve.ts `modelsUsable`) — while it is
 * not, a retry is refused (409 `model_gone`, `retryRun`), and a run that failed `model_gone` is retryable again once it
 * is. `modelUsable` as the reader knows it now (`GET …/run`, `GET …/runs`); else as it was when the run ended — usable,
 * unless it ended `model_gone`.
 */
export const retryable = (r: Pick<RunRow, "status" | "error">, modelUsable = r.error !== "model_gone"): boolean =>
  r.status === "failed" && modelUsable && !NOT_RETRYABLE.has(r.error ?? "");

/**
 * Each failed one of `rows` that is a told reply gets `tellable` and `tellable_until` (whispers/store.ts `tellableRuns`,
 * THE rule), in place: so its owner's wire offers 重试 only while its whisper may be told again, and says until when. One
 * statement; others are left as they are.
 */
export async function withTellable<R extends RunRow>(q: Queryable, rows: readonly R[], ttlHours: number): Promise<readonly R[]> {
  const failed = rows.filter((r) => r.status === "failed");
  if (failed.length === 0) return rows;
  const tellable = await tellableRuns(q, failed.map((r) => r.id), ttlHours);
  for (const r of failed) {
    const t = tellable.get(r.id);
    if (!t) continue;
    r.tellable = t.may;
    r.tellable_until = t.until;
  }
  return rows;
}

/**
 * The run slot its owner holds of whisper `w`'s told reply, when that is the Agent's latest reply there and it failed: as
 * it reads now (`tellable` by THE rule), with its group and Agent — what its owner is pushed once the whisper stops
 * reading open (sync/hub.ts, the whisper's own delivery: one place, whatever ended it), so 重试 is no longer offered on
 * her screen. Null when there is no such slot.
 */
export async function toldSlotOf(
  q: Queryable,
  w: { id: string; ownerId: string },
  ttlHours: number,
): Promise<{ conversationId: string; agentId: string; run: WireRun } | null> {
  const { rows } = await q.query<RunRow & { conversation_id: string; agent_id: string }>(
    `select ${RUN_COLUMNS}, r.conversation_id, r.agent_id from agent_runs r
      where r.whisper_id = $1 and r.owner_id = $2 and r.status = 'failed'
        and r.id = (select l.id from agent_runs l where l.agent_id = r.agent_id and l.conversation_id = r.conversation_id and l.purpose = 'reply'
                     order by l.created_at desc, l.id desc limit 1)`,
    [w.id, w.ownerId],
  );
  const row = rows[0];
  if (!row) return null;
  await withTellable(q, [row], ttlHours);
  return { conversationId: row.conversation_id, agentId: row.agent_id, run: toWireRun(row) };
}

/** A run on the wire (README "Wire shapes"). */
export const wireRunSchema = z.object({
  id: z.string(),
  status: z.enum(RUN_STATUSES),
  error: z.string().optional(),
  retryable: z.boolean(),
  retryableUntil: z.string().optional(),
  resetsAt: z.string().optional(),
});
export type WireRun = z.infer<typeof wireRunSchema>;

export interface RunRow {
  id: string;
  status: RunStatus;
  error: string | null;
  resets_at: Date | null;
  dismissed_at: Date | null;
  /**
   * A told reply (`告诉他们`): whether its whisper may be told again (whispers/store.ts `tellableRuns`, THE rule), read where
   * its owner is told of it failed (`withTellable`); false keeps it from being offered 重试. Absent: not asked (any other run).
   */
  tellable?: boolean | null;
  /** With `tellable` true: the moment it stops (its whisper is a day old), for the wire's `retryableUntil`. */
  tellable_until?: Date | null;
}

/** Columns of `agent_runs r` in the shape of `RunRow`. */
export const RUN_COLUMNS = "r.id, r.status, r.error, r.resets_at, r.dismissed_at";

/**
 * `retryable`: by its one rule (`retryable`, with the Agent's model as `modelUsable` says, where known), never for a run
 * that did not fail — nor for a told reply whose whisper may not be told again (`tellable` false: declined, expired, a day
 * old, told; its retry would be refused `stale_whisper`); `retryableUntil`, for a told reply offered it, the moment that
 * stops (its whisper is a day old: fix round 3), so its owner's screen stops offering it then on its own. `resetsAt` only
 * for `no_quota` on a free-tier model.
 */
export function toWireRun(r: RunRow, modelUsable?: boolean): WireRun {
  const offered = retryable(r, modelUsable) && r.tellable !== false;
  return {
    id: r.id,
    status: r.status,
    ...(r.error === null ? {} : { error: r.error }),
    retryable: offered,
    ...(offered && r.tellable === true && r.tellable_until ? { retryableUntil: r.tellable_until.toISOString() } : {}),
    ...(r.error === "no_quota" && r.resets_at ? { resetsAt: r.resets_at.toISOString() } : {}),
  };
}

/**
 * What a member of a group who does not own the Agent is told of its reply there (wire contract "Run state"): replying
 * while its run is queued or running, unavailable while it failed (and someone had asked for it, `groupRunState`) and its
 * owner has not dismissed it, else nothing.
 */
export type GroupRunState = "replying" | "unavailable" | null;

/**
 * The state of an Agent's reply in a group `to` its owner or to any other member (`GroupRunState`). A reply nobody had
 * asked for (lane `proactive`) that failed shows the others nothing — nobody asked them anything of it — while its owner
 * is told it failed. While it is queued or running the others see `replying`, the same as for any reply.
 */
export function groupRunState(r: (Pick<RunRow, "status" | "dismissed_at"> & { lane: Lane }) | null | undefined, to: "owner" | "member"): GroupRunState {
  if (!r) return null;
  if (r.status === "queued" || r.status === "running") return "replying";
  if (r.status !== "failed" || r.dismissed_at !== null) return null;
  return to === "owner" || r.lane !== "proactive" ? "unavailable" : null;
}

/**
 * The place of a conversation at a run site that names no Agent yet (a route's `:id`): `placeOf`'s rule (`placeOfType`) with the
 * conversation standing for the Agent's own where it is an Agent's conversation. 404 for a conversation that does not exist or is
 * a direct chat (an Agent is in none). `own` is then any Agent's own conversation: the caller's ownership is the site's to check.
 */
export async function runSitePlace(q: Queryable, conversationId: string): Promise<Place> {
  const peek = await peekConversation(q, conversationId);
  if (!peek || peek.type === "direct") throw notFound();
  return placeOfType(peek.type, conversationId, { conversationId });
}

/**
 * The run that decides what a group shows of an Agent member: the latest reply run of the member `m` (a `memberships`
 * alias, spliced into SQL: only these literals) in its conversation during that stay — one covering a message after it
 * joined, so a run from before it last left and came back is not it. A `lateral` subquery in the shape of `RunRow`, and
 * its `lane`.
 */
type StayAlias = "m" | "am";
const latestInStay = (m: StayAlias): string =>
  `lateral (select x.id, x.status, x.error, x.resets_at, x.dismissed_at, x.lane from agent_runs x
             where x.agent_id = ${m}.principal_id and x.conversation_id = ${m}.conversation_id and x.purpose = 'reply'
               and x.covers_seq > ${m}.joined_seq
             order by x.created_at desc, x.id desc limit 1)`;

/** One Agent's line in `GET /api/conversations/:id/runs`. */
export interface GroupRunEntry {
  agentId: string;
  state: Exclude<GroupRunState, null>;
  /** Only for the Agent's owner. */
  run?: WireRun;
}

/**
 * `GET /api/conversations/:id/runs` for `readerId` (wire contract "Run state"): 404, as for a conversation that does not
 * exist, unless it is a group or a social conversation (`placeOf`) the reader is a current member of (a visitor, a supervising owner). One entry per current Agent member whose latest run
 * there in its current stay (`latestInStay`) has a state for the reader (`groupRunState`), in `agentId` order; the run
 * itself on the reader's own Agents' entries only, `retryable` by the Agent's model as it is now (`retryable`).
 */
export async function groupRuns(q: Queryable, readerId: string, conversationId: string, config: Pick<Config, "siteModels" | "whispers">): Promise<GroupRunEntry[]> {
  if ((await runSitePlace(q, conversationId)) === "own" || !(await currentMembership(q, conversationId, readerId))) throw notFound();
  const { rows } = await q.query<RunRow & Parameters<typeof agentModelOf>[0] & { agent_id: string; owner_id: string; lane: Lane }>(
    `select m.principal_id as agent_id, p.owner_id, ${RUN_COLUMNS}, r.lane, a.model_source, a.site_model_id, a.provider_id, a.provider_model
       from memberships m
       join principals p on p.id = m.principal_id and p.kind = 'agent'
       join agents a on a.principal_id = p.id
       join ${latestInStay("m")} r on true
      where m.conversation_id = $1 and m.left_seq is null
      order by m.principal_id`,
    [conversationId],
  );
  const mine = rows.filter((row) => row.owner_id === readerId);
  const usable = new Map(mine.map((row, i) => [row.agent_id, i]));
  const now = await modelsUsable(q, config, readerId, mine.map(agentModelOf));
  // The reader's own failed told replies: offered 重试 only while their whispers may be told again (THE rule).
  await withTellable(q, mine.filter((row) => row.status === "failed"), config.whispers.elsewhereTtlHours);
  const entries: GroupRunEntry[] = [];
  for (const row of rows) {
    const owns = row.owner_id === readerId;
    const state = groupRunState(row, owns ? "owner" : "member");
    if (state !== null) entries.push({ agentId: row.agent_id, state, ...(owns ? { run: toWireRun(row, now[usable.get(row.agent_id)!]) } : {}) });
  }
  return entries;
}

/** Who is told what of a run, read when its push is delivered (`Hub.pushRun`). */
export interface RunAudience {
  /** `own` (the Agent's conversation with its owner), `group` or `social` (`placeOf`). */
  place: Place;
  agentId: string;
  /** The run's owner (`agent_runs.owner_id`): the one principal ever pushed the run itself. */
  ownerId: string;
  /** A group's or a social conversation's current members, people and Agents; empty in the Agent's own conversation. */
  memberIds: string[];
  /** In a group or a social conversation, what its members other than the run's owner are told: the Agent's state there now. */
  state: GroupRunState;
  /** The whisper the run tells (`告诉他们`'s told reply, `agent_runs.whisper_id`), its owner's: pushed to them after the run. */
  whisperId: string | null;
}

/**
 * One statement for one delivery of run `runId` of `conversationId`, however many members the conversation has: its
 * type, the run's Agent and owner, and in a group its current members and the Agent's state there now as they are told
 * it (`groupRunState`) — that of its latest run in its current stay (`latestInStay`), null once it is not a member.
 * Null when there is no such run.
 */
export async function runAudience(q: Queryable, conversationId: string, runId: string): Promise<RunAudience | null> {
  const { rows } = await q.query<{
    type: ConversationType;
    own_conversation: string | null;
    agent_id: string;
    owner_id: string;
    members: string[] | null;
    status: RunStatus | null;
    dismissed_at: Date | null;
    lane: Lane | null;
    whisper_id: string | null;
  }>(
    `select c.type, a.agent_id, a.owner_id, a.whisper_id,
            case when ${groupPlaceSql("c")} or ${socialPlaceSql("c")}
                 then array(select ms.principal_id from memberships ms where ms.conversation_id = c.id and ms.left_seq is null) end as members,
            r.status, r.dismissed_at, r.lane,
            (select ac.conversation_id from agent_conversations ac where ac.agent_id = a.agent_id) as own_conversation
       from agent_runs a
       join conversations c on c.id = a.conversation_id
       left join memberships am on (${groupPlaceSql("c")} or ${socialPlaceSql("c")}) and am.conversation_id = c.id and am.principal_id = a.agent_id and am.left_seq is null
       left join ${latestInStay("am")} r on true
      where a.id = $1 and a.conversation_id = $2`,
    [runId, conversationId],
  );
  const row = rows[0];
  if (!row) return null;
  const latest = row.status === null || row.lane === null ? null : { status: row.status, dismissed_at: row.dismissed_at, lane: row.lane };
  return { place: placeOfType(row.type, conversationId, { conversationId: row.own_conversation ?? "" }), agentId: row.agent_id, ownerId: row.owner_id, memberIds: row.members ?? [], state: groupRunState(latest, "member"), whisperId: row.whisper_id };
}

/** A run to push to its owner after the transaction that changed it commits. */
export interface Announced {
  ownerId: string;
  /** The run's own conversation. */
  conversationId: string;
  run: WireRun;
}

/**
 * The principals `message`'s stored mentions mean (`messages.mentions`, decided once when it was sent: mentions.ts
 * `mentionsAtSend`), each once, in the order they are first named; none for a message that names nobody, and for every
 * message from before mentions were stored. Its text is never read for it.
 */
export function mentionedIds(message: Pick<StoredMessage, "mentions">): string[] {
  return [...new Set((message.mentions ?? []).map((m) => m.id))];
}

/** The Agent of `conversationId` when it is an Agent conversation of `ownerId`'s, else null. */
export async function ownedAgentOf(q: Queryable, ownerId: string, conversationId: string): Promise<string | null> {
  const { rows } = await q.query<{ agent_id: string }>(
    "select agent_id from agent_conversations where conversation_id = $1 and owner_id = $2",
    [conversationId, ownerId],
  );
  return rows[0]?.agent_id ?? null;
}

/** The conversation's newest run (there is at most one active, and it is the newest). */
export async function latestRun(q: Queryable, conversationId: string): Promise<RunRow | null> {
  const { rows } = await q.query<RunRow>(
    `select ${RUN_COLUMNS} from agent_runs r where r.conversation_id = $1 order by r.created_at desc, r.id desc limit 1`,
    [conversationId],
  );
  return rows[0] ?? null;
}

/**
 * The limits on replies started a minute — an owner's own lane, the others' (every other lane together), one caller's —
 * and the site's time zone, whose day the others' daily budget is counted in (`othersBudgetSpent`); and the site's models,
 * by which someone else's call on an Agent whose model is gone is refused as it is made (`reachAgents`).
 */
export type RunLimits = Pick<Config, "agentRunsPerMinute" | "agentOthersRunsPerMinute" | "agentCallerRunsPerMinute" | "siteTimezone" | "siteModels" | "others" | "social">;

/**
 * Of `agent_runs`: a reply started in the last minute — not one a limit refused (`rate_limited`), which started nothing
 * (`startedLastMinute`, `calledLastMinute`).
 */
const STARTED_LAST_MINUTE = "purpose = 'reply' and created_at > now() - interval '1 minute' and error is distinct from 'rate_limited'";

/**
 * `STARTED_LAST_MINUTE` as an owner's minute counts it (`startedLastMinute`): not a reply whose model was not there to
 * call either (`model_gone`) — it called nothing and spent nothing of the owner's, so calls on an Agent whose model is gone
 * cannot crowd out calls on the owner's other Agents. A caller's own minute counts it (`calledLastMinute`).
 */
const OWNER_STARTED_LAST_MINUTE = `${STARTED_LAST_MINUTE} and error is distinct from 'model_gone'`;

/**
 * Replies `ownerId` has started in the last minute in one lane: their own (`own`, `agentRunsPerMinute`), or else
 * every other together — what others called for, and what nobody did (`agentOthersRunsPerMinute`) — so neither uses up
 * the other. Counted under the owner's `accounts` row lock — the last lock of the order, taken here before counting and
 * held until the caller's transaction (which inserts the run) ends — so that two replies started at once, to two of the
 * owner's Agents, are counted one after the other. A run refused by this limit (`rate_limited`) started nothing and is
 * not counted.
 */
async function startedLastMinute(t: Tx, ownerId: string, own: boolean): Promise<number> {
  await lockAccount(t, ownerId);
  const { rows } = await t.query<{ n: number }>(`select count(*)::int as n from agent_runs where owner_id = $1 and (lane = 'own') = $2 and ${OWNER_STARTED_LAST_MINUTE}`, [
    ownerId,
    own,
  ]);
  return rows[0]!.n;
}

/**
 * Whether `ownerId` has started their replies a minute in `lane` (`startedLastMinute`): over it, a reply is refused. A
 * reply nobody called for (`proactive`) is held to the others' minute, as a call by someone else is
 * (agents/proactive/decide.ts).
 */
export async function overLaneLimit(t: Tx, ownerId: string, lane: Lane, config: RunLimits): Promise<boolean> {
  const own = lane === "own";
  return (await startedLastMinute(t, ownerId, own)) >= (own ? config.agentRunsPerMinute : config.agentOthersRunsPerMinute);
}

/**
 * Calls person `callerId` has made in the last minute on other people's Agents (`agentCallerRunsPerMinute`),
 * themselves or through an Agent's message they are behind (`behindAgentMessage`: their own Agents', or another's
 * relaying their call), whoever's Agents they were: the replies they are the caller of that are not
 * their owner's own (so a call on one of their own Agents never counts). A run an owner's limit refused
 * (`rate_limited`) started nothing and is not counted; nor is a mention folded into a reply under way, which starts
 * none. Counted under the caller's `accounts` row lock (`reachAgents` takes it with the owners', in id order), so two
 * calls the same person makes at once are counted one after the other.
 */
async function calledLastMinute(t: Tx, callerId: string): Promise<number> {
  await lockAccount(t, callerId);
  const { rows } = await t.query<{ n: number }>(`select count(*)::int as n from agent_runs where caller_id = $1 and lane <> 'own' and ${STARTED_LAST_MINUTE}`, [callerId]);
  return rows[0]!.n;
}

/**
 * Why an Agent's running reply was cut short (`agent_runs.interrupted`): by the Agent's pause or delete, because the
 * Agent left the run's conversation (`agent_removed`), or because a member of the group halted Agents calling each
 * other and an Agent's message had called for it (`halted`, `haltAgents`). Agent social adds four: the owner wrote in the
 * social conversation the reply was for (`owner_spoke`), the access the reply was for ended (`access_ended`), a note the reply
 * was shown changed (`notes_changed`), and an errand it served ended (`errand_ended`; the errands plan's).
 */
export type Interruption = "agent_paused" | "agent_deleted" | "agent_removed" | "halted" | "owner_spoke" | "access_ended" | "notes_changed" | "errand_ended";

/** Whose message called for a run (`agent_runs.triggered_by`): a person's, or an Agent's in a group. */
export type TriggeredBy = "human" | "agent";

/**
 * A run's lane (`agent_runs.lane`), which the limits read: `own` when the Agent's owner called for it — themselves, or
 * through an Agent's message they are behind (`behindAgentMessage`); so is every reply in the Agent's own conversation, a
 * retry and a persona draft — `others` when someone else did, `proactive` when nobody did (batch 2D: the judgement
 * model picked the Agent, agents/proactive/decide.ts; no caller).
 */
export type Lane = "own" | "others" | "proactive";

/**
 * Who called for a run (`agent_runs.caller_id`: the person behind it, an Agent's call being that of the person behind
 * its message, `behindAgentMessage`; nobody for a follow-up in a group none of whose callers it can see any more,
 * `followUp`, and for what is relayed from a reply nobody called for), and its lane.
 */
export type Caller = { id: string | null; lane: Lane };

/**
 * The call person `personId` makes on an Agent of `ownerId`'s: the owner's own, or someone else's. Nobody (`null`: a
 * call relayed from a reply nobody called for) is someone else: `others`, with no caller.
 */
export function callerOf(ownerId: string, personId: string | null): Caller {
  return { id: personId, lane: personId === ownerId ? "own" : "others" };
}

/**
 * The person behind an Agent's message — whose call it is on the Agents it names: the caller of the run that posted it
 * (`postedBy`, that run's caller and lane) when that run is not its owner's own — so a member's call relayed through the
 * owner's Agent stays the member's, and what a reply nobody called for relays is nobody's (`null`) — otherwise (the run
 * is its owner's own, or no run posted the message) the Agent's owner. `followUp` reads the same rule from the stored
 * messages (the posting run is the one the message's `client_txn` names). A block, either way, between that person and
 * a named Agent's owner keeps the call off that Agent (`triggerFromAgent`, `followUp`), as between the two owners.
 */
export function behindAgentMessage(ownerId: string, postedBy: Caller | null): string | null {
  return postedBy !== null && postedBy.lane !== "own" ? postedBy.id : ownerId;
}

/**
 * `behindAgentMessage`'s twin in SQL, for a query that reads many messages at once (`followUp`; a test holds the two to
 * the same answers): the person behind a message from `sender` (a `principals` alias) that run `run` posted (an
 * `agent_runs` alias joined by `postingRun`, all null when no run did) — that run's caller when its lane is not `own`,
 * else the sender's owner; for a person's message (no run), that person. Only aliases are spliced in.
 */
export const behindMessageSql = (sender: string, run: string): string =>
  `case when ${run}.lane <> 'own' then ${run}.caller_id else coalesce(${sender}.owner_id, ${sender}.id) end`;

/**
 * In the pause's (or delete's) own transaction, which holds `lockAgent`: the Agent's active replies, in every
 * conversation, end for good. A queued one is cancelled at once (it never reached a model: nothing to settle). A
 * running one is marked `interrupted`: `postAsAgent` refuses it and `finish` records it `cancelled` with that reason —
 * even if the Agent is resumed before the worker notices — and what was noted on it (`pending_seq`) is dropped: nothing
 * written before the pause gets a follow-up. Whatever is noted on it from now on came after a resume (nothing is noted
 * while the Agent is paused; what an Agent's message in a group writes for it as the pause commits, which this cannot
 * see, the resume ends: `endWhatPauseMissed`) and is followed up as usual (`finish`). Returns the cancelled runs to
 * announce, each with its own conversation, and the running ones to stop.
 */
export async function interruptRuns(
  t: Tx,
  agent: AgentRow,
  reason: "agent_paused" | "agent_deleted",
): Promise<{ cancelled: Announced[]; running: string[] }> {
  // No follow-up for these (`followUpOnEnd`): an Agent paused or deleted answers nothing, and what was noted on them —
  // handed back by an admission that held one back — is dropped, as on its running runs below.
  const queued = await t.query<RunRow & { conversation_id: string }>(
    `update agent_runs as r set status = 'cancelled', error = $2, finished_at = now()
      where r.agent_id = $1 and r.status = 'queued' returning ${RUN_COLUMNS}, r.conversation_id`,
    [agent.id, reason],
  );
  const running = await t.query<{ id: string }>(
    "update agent_runs set interrupted = $2, pending_seq = null where agent_id = $1 and status = 'running' returning id",
    [agent.id, reason],
  );
  return {
    cancelled: queued.rows.map((r) => ({ ownerId: agent.ownerId, conversationId: r.conversation_id, run: toWireRun(r) })),
    running: running.rows.map((r) => r.id),
  };
}

/**
 * In the resume's own transaction, which holds `lockAgent` and found the Agent paused: what the pause could not see
 * ends now, before the Agent can answer again. An Agent's message in a group reads the Agents it calls without locking
 * them (`triggerFromAgent`), so a pause that commits inside that message's transaction misses what it then writes — a
 * run it queues (none other can be queued while the Agent is paused: a person's mention, a retry, a follow-up and
 * recovery all refuse a paused Agent), and a mention its fold notes on a reply the pause interrupted. So, in every
 * conversation: a queued run of the Agent is `cancelled` `agent_paused` (it never reached a model), and so is one the
 * worker claimed meanwhile (it does not look at the pause): every running run not marked yet is marked `interrupted`
 * `agent_paused`, as the pause marked the others, and nothing noted on a running one is followed up. Returns, as
 * `interruptRuns` does, the cancelled runs to announce and the newly marked ones to stop.
 */
export async function endWhatPauseMissed(t: Tx, agent: AgentRow): Promise<{ cancelled: Announced[]; running: string[] }> {
  // None of these queued ones has started (a start finds the pause and ends it), so nothing was noted on one: no
  // follow-up (`followUpOnEnd`).
  const queued = await t.query<RunRow & { conversation_id: string }>(
    `update agent_runs as r set status = 'cancelled', error = 'agent_paused', finished_at = now()
      where r.agent_id = $1 and r.status = 'queued' returning ${RUN_COLUMNS}, r.conversation_id`,
    [agent.id],
  );
  const claimed = await t.query<{ id: string }>(
    "update agent_runs set interrupted = 'agent_paused' where agent_id = $1 and status = 'running' and interrupted is null returning id",
    [agent.id],
  );
  await t.query("update agent_runs set pending_seq = null where agent_id = $1 and status = 'running' and pending_seq is not null", [agent.id]);
  return {
    cancelled: queued.rows.map((r) => ({ ownerId: agent.ownerId, conversationId: r.conversation_id, run: toWireRun(r) })),
    running: claimed.rows.map((r) => r.id),
  };
}

/** The Agent as a run row names it. */
type RunAgent = Pick<AgentRow, "id" | "ownerId">;

/**
 * Whose questions a reply answers (`agent_runs.asker_ids`, migration 045; Task 10b): the people whose messages called for
 * it — a mention's sender; the sender of the message a reply nobody asked for answers (agents/proactive/decide.ts); for
 * a call by an Agent's message, the askers of the run that posted it, so the person whose message started the chain —
 * each once. Null when not known (a run recorded before askers were, a chain whose first person cannot be told): the
 * safe side, read by context.ts `askerLine`. Never on the wire.
 */
export type Askers = readonly string[] | null;

/** `askers` as a query parameter (`uuid[]`, or null). */
const askersParam = (askers: Askers): string[] | null => (askers === null ? null : [...askers]);

/**
 * SQL, a `uuid[]` or null: everyone a reply hears from in a stretch of its group (Task 10b, fix rounds 2 and 3) — for each
 * text or file message (what a reply is shown) in conversation `conversation` with a seq after `from` and, unless `to`
 * is null, up to `to`: a person's sender, and for an Agent's message the askers of the run that posted it (`postingRun`:
 * whoever asked it, whose question it may be relaying; another member's Agent answering an older member counts that
 * member). Null — not known — when one of those Agent's messages has no posting run whose askers are known. Only parameter
 * positions and the written row's own columns are spliced in (its own aliases `h…` shadow none of theirs).
 */
const heardIn = (conversation: string, from: string, to: string | null): string =>
  `(select case when bool_or(hp.kind = 'agent' and hr.asker_ids is null) then null
               else coalesce(array_agg(distinct hx.id) filter (where hx.id is not null), '{}'::uuid[]) end
      from messages hm
      join principals hp on hp.id = hm.sender_id
      left join agent_runs hr on hp.kind = 'agent' and ${postingRun("hm", "hr")}
      left join lateral unnest(case when hp.kind = 'human' then array[hm.sender_id] else hr.asker_ids end) as hx (id) on true
     where hm.conversation_id = ${conversation} and hm.seq > ${from}${to === null ? "" : ` and hm.seq <= ${to}`}
       and hm.kind in ('text', 'file'))`;

/**
 * SQL: a run's `asker_ids` with `param` (a parameter position holding `Askers`; null: no call's) and those `heard`
 * (`heardIn`) taken on — every one of them, each once — or null (not known) when the run's, the call's or those heard
 * are not known. (`||` would drop a null array silently, so each is tested; `heard` is evaluated once.)
 */
const withAskers = (param: string | null, heard: string | null = null): string => {
  const unknown = `asker_ids is null${param === null ? "" : ` or ${param}::uuid[] is null`}`;
  const union = (more: string): string =>
    `array(select distinct a from unnest(asker_ids${param === null ? "" : ` || ${param}::uuid[]`}${more}) as x (a) order by a)`;
  return heard === null
    ? `case when ${unknown} then null else ${union("")} end`
    : `case when ${unknown} then null
            else (select case when h.ids is null then null else ${union(" || h.ids")} end from (select ${heard} as ids) h) end`;
};

/**
 * The one way whoever a reply hears from is recorded (Task 10b, fix round 2): everyone who wrote in its group after
 * seq `from` and up to `to` (null: to the end, `heardIn`) is taken on among run `runId`'s askers (`asker_ids`, each once;
 * left not known when they are not), so its line (context.ts `askerLine`) and what it hands down (`triggerFromAgent`)
 * count them. Called wherever what a run covers moves forward, or a stretch it did not answer is handed down with it:
 * `begin` (DbAgentPort, before it reads the line: what came since what it covered, the calls it takes on included) and
 * `postAsAgent` (the reply's message hands down what came while it ran); the folds and follow-ups below use `heardIn`
 * itself. Returns the run's askers as they now are. Under the group's row, as every writer of its runs.
 */
export async function hearFrom(t: Tx, runId: string, from: number, to: number | null): Promise<Askers> {
  const { rows } = await t.query<{ askers: string[] | null }>(
    `update agent_runs set asker_ids = ${withAskers(null, heardIn("agent_runs.conversation_id", "$2::bigint", to === null ? null : "$3::bigint"))}
      where id = $1 returning asker_ids as askers`,
    to === null ? [runId, from] : [runId, from, to],
  );
  return rows[0]?.askers ?? null;
}

/**
 * The block rule a call meets when it is made, met again by every call reply run `runId` of an Agent of `ownerId`
 * answers as it begins (reverse-paths audit A12; Task R fix round 1), whatever the run's lane: a call (`call_seqs`; its
 * `covers_seq` when not known) whose person has a block with the owner, either way — the sender of a person's message;
 * for an Agent's message that Agent's owner and the person behind it (`behindMessageSql`), as `followUp` reads them — would
 * be refused were it made now (`triggerInGroup`, `triggerFromAgent`), and is dropped: it is no longer among the calls the
 * run answers and nobody the owner has a block with is among its askers; what the run covers ends at the latest call
 * left (`covers_seq`, or `pending_seq` when that call was noted after its claim), so what came after that call is heard
 * by the usual rule as the run begins (`hearFrom`: someone blocked who wrote there is heard, as anyone is, and counts
 * toward its line, never as a call). A run whose caller is dropped becomes the remaining calls' by `followUp`'s rule —
 * its owner's own when the owner is behind one of them, else the earliest one's — and a person's while a person's call
 * is left (a reply nobody asked for keeps its lane, caller and trigger). The owner's own call is never dropped (nobody has
 * a block with themselves): `begin` asks this of every group run (none in the Agent's own conversation) but a reply
 * `告诉他们` queued, which answers nobody's call (its follow-up holds what was noted on it to the rule). Returns what the run now covers, has noted and its lane now (the caller takes them all: what a reply is bounded to is decided by the lane it has here; empty when nothing was dropped: one query),
 * or null when no call is left — then only its `pending_seq` is cleared, so no follow-up answers a dropped call.
 */
export async function dropBlockedCalls(t: Tx, runId: string, ownerId: string): Promise<{ covers_seq?: string | null; pending_seq?: string | null; lane?: Lane } | null> {
  const { rows } = await t.query<{ seq: string; kind: "human" | "agent"; behind: string | null; blocked: boolean; lane: Lane; caller_blocked: boolean }>(
    `select m.seq::text as seq, p.kind, bh.caller_id as behind, ${blockedEitherWay("$2::uuid", "coalesce(p.owner_id, p.id), bh.caller_id")} as blocked,
            r.lane, ${blockedEitherWay("$2::uuid", "r.caller_id")} as caller_blocked
       from agent_runs r
       join messages m on m.conversation_id = r.conversation_id and m.seq = any(coalesce(r.call_seqs, array[r.covers_seq]))
       join principals p on p.id = m.sender_id
       left join agent_runs pr on p.kind = 'agent' and ${postingRun("m", "pr")}
       cross join lateral (select ${behindMessageSql("p", "pr")} as caller_id) bh
      where r.id = $1
      order by m.seq`,
    [runId, ownerId],
  );
  if (!rows.some((r) => r.blocked)) return {};
  const left = rows.filter((r) => !r.blocked);
  if (left.length === 0) {
    await t.query("update agent_runs set pending_seq = null where id = $1", [runId]);
    return null;
  }
  const { lane } = rows[0]!;
  const caller: Caller | null =
    lane === "proactive" || !rows[0]!.caller_blocked
      ? null
      : left.some((r) => r.behind === ownerId)
        ? callerOf(ownerId, ownerId)
        : callerOf(ownerId, left.find((r) => r.behind !== null)?.behind ?? null);
  const by: TriggeredBy | null = lane === "proactive" ? null : left.some((r) => r.kind === "human") ? "human" : "agent";
  const updated = await t.query<{ covers_seq: string | null; pending_seq: string | null; lane: Lane }>(
    `update agent_runs set call_seqs = $2::bigint[], covers_seq = least(covers_seq, $3::bigint),
            pending_seq = case when $3::bigint > covers_seq then $3::bigint end,
            asker_ids = case when asker_ids is null then null
                             else array(select x.a from unnest(asker_ids) as x (a) where not ${blockedEitherWay("$4::uuid", "x.a")} order by x.a) end,
            caller_id = case when $5::boolean then $6::uuid else caller_id end, lane = case when $5::boolean then $7::text else lane end,
            triggered_by = coalesce($8::text, triggered_by)
      where id = $1 returning covers_seq::text as covers_seq, pending_seq::text as pending_seq, lane`,
    [runId, left.map((r) => Number(r.seq)), Number(left.at(-1)!.seq), ownerId, caller !== null, caller?.id ?? null, caller?.lane ?? null, by],
  );
  return updated.rows[0]!;
}

/** The model of Agent `agentId` as its `agents` row says now (`agentModelOf`); null for none, or no such Agent. */
async function modelOfAgent(q: Queryable, agentId: string): Promise<AgentRow["model"]> {
  const { rows } = await q.query<Parameters<typeof agentModelOf>[0]>(
    "select model_source, site_model_id, provider_id, provider_model from agents where principal_id = $1",
    [agentId],
  );
  return rows[0] ? agentModelOf(rows[0]) : null;
}

/** That run `runId` answers the calls at `seqs` too (`call_seqs`, migration 046), besides those it has. */
async function answersCalls(t: Tx, runId: string, seqs: readonly number[]): Promise<void> {
  if (seqs.length === 0) return;
  await t.query("update agent_runs set call_seqs = array(select distinct s from unnest(coalesce(call_seqs, array[covers_seq]) || $2::bigint[]) as x (s) order by s) where id = $1", [
    runId,
    seqs,
  ]);
}

/**
 * Queues a reply of the Agent in `conversationId` answering up to `coversSeq` (a seq of that conversation), called for
 * by a person's message unless `triggeredBy` says an Agent's, by `caller` and in its lane, answering `askers` (every
 * caller says whose; null only where they cannot be told) and the call at `coversSeq` (`call_seqs`; a follow-up or a
 * retry adds the others it answers, `answersCalls`). Under that conversation's row lock, which every writer of the
 * Agent's runs there holds: the Agent has no active run there (`agent_runs_one_active_per_agent_conversation` would
 * refuse a second).
 */
export async function queueRun(
  t: Tx,
  agent: RunAgent,
  conversationId: string,
  coversSeq: number,
  triggeredBy: TriggeredBy,
  caller: Caller,
  askers: Askers,
): Promise<Announced> {
  const { rows } = await t.query<RunRow>(
    `insert into agent_runs as r (purpose, conversation_id, agent_id, owner_id, status, covers_seq, triggered_by, caller_id, lane, asker_ids, call_seqs)
     values ('reply', $1, $2, $3, 'queued', $4, $5, $6, $7, $8, array[$4::bigint]) returning ${RUN_COLUMNS}`,
    [conversationId, agent.id, agent.ownerId, coversSeq, triggeredBy, caller.id, caller.lane, askersParam(askers)],
  );
  return { ownerId: agent.ownerId, conversationId, run: toWireRun(rows[0]!) };
}

/**
 * A reply in `conversationId` the owner's replies a minute in its lane refused (`overLaneLimit`): recorded `failed`,
 * `rate_limited` (retryable), covering `coversSeq`, with whose message and which `caller` called for it and whose
 * questions it answers (`askers`), so the owner sees it and can retry. It never reached a model: no hold, no usage
 * record, and it is not active (it takes no concurrency slot, and the Agent's one active run there stays free). With
 * `error` `model_gone`: someone else's call on an Agent whose model is not there to call, refused as it is made
 * (`reachAgents`), recorded the same way so the group shows its one line and the caller's own limit counts it.
 */
async function recordRateLimited(
  t: Tx,
  agent: RunAgent,
  conversationId: string,
  coversSeq: number,
  triggeredBy: TriggeredBy,
  caller: Caller,
  askers: Askers,
  error: "rate_limited" | "model_gone" = "rate_limited",
): Promise<Announced> {
  const { rows } = await t.query<RunRow>(
    `insert into agent_runs as r (purpose, conversation_id, agent_id, owner_id, status, error, covers_seq, finished_at, triggered_by, caller_id, lane, asker_ids, call_seqs)
     values ('reply', $1, $2, $3, 'failed', $9, $4, now(), $5, $6, $7, $8, array[$4::bigint]) returning ${RUN_COLUMNS}`,
    [conversationId, agent.id, agent.ownerId, coversSeq, triggeredBy, caller.id, caller.lane, askersParam(askers), error],
  );
  return { ownerId: agent.ownerId, conversationId, run: toWireRun(rows[0]!) };
}

/**
 * SQL `set` items: what a run takes on of a call recorded on it (folded in, or covered by a reused `rate_limited` run),
 * when `when` (SQL) holds: whose message called (`triggeredBy`, a parameter position) — a person's makes it a person's —
 * and who (`lane`, `caller`) — an `own` call makes it its owner's own, that caller its caller —, else it keeps them. So a
 * member's call relayed through one of the owner's Agents does not make it the owner's. But any call makes a reply
 * nobody had called for (`proactive`) wholly that call's: whose message called, its lane and its caller (it is no longer
 * unasked: not held to the proactive budget or the fuse; a halt ends it only when an Agent's message called for it, as
 * any such reply). `lane` on the right of each item is the run's lane before this update — SQL reads every right-hand
 * side from the row as it was — so the three items agree on whether it was a proactive reply.
 */
const takesOnCall = (when: string, triggeredBy: string, lane: string, caller: string): string =>
  `triggered_by = case when ${when} and (${triggeredBy} = 'human' or lane = 'proactive') then ${triggeredBy}::text else triggered_by end,
   lane = case when ${when} and (${lane} = 'own' or lane = 'proactive') then ${lane}::text else lane end,
   caller_id = case when ${when} and (${lane} = 'own' or lane = 'proactive') then ${caller}::uuid else caller_id end`;

/**
 * `recordRateLimited` in a group (plan ruling 7): one such run per Agent there, not one per mention. When the Agent's
 * latest run in the group is a `rate_limited` failure its owner has not dismissed, that run now covers `coversSeq` too
 * (and is announced again) — a person's once a person's message is recorded on it, its owner's own once its owner's
 * call is (else it keeps its caller and lane, `takesOnCall`) and answers `askers` and the call too (`withAskers`,
 * `call_seqs`), and everyone who wrote in the stretch it now covers besides (`heardIn`); otherwise a new one is recorded.
 * So repeated mentions over the limit show one line.
 */
async function rateLimitedInGroup(
  t: Tx,
  agent: RunAgent,
  conversationId: string,
  coversSeq: number,
  triggeredBy: TriggeredBy,
  caller: Caller,
  askers: Askers,
): Promise<Announced> {
  const latest = await t.query<{ id: string; reusable: boolean }>(
    `select id, (status = 'failed' and error is not distinct from 'rate_limited' and dismissed_at is null) as reusable
       from agent_runs where agent_id = $1 and conversation_id = $2 order by created_at desc, id desc limit 1`,
    [agent.id, conversationId],
  );
  const row = latest.rows[0];
  if (!row?.reusable) return recordRateLimited(t, agent, conversationId, coversSeq, triggeredBy, caller, askers);
  const { rows } = await t.query<RunRow>(
    `update agent_runs as r
        set covers_seq = greatest(r.covers_seq, $2), finished_at = now(), ${takesOnCall("true", "$3", "$4", "$5")},
            asker_ids = ${withAskers("$6", heardIn("r.conversation_id", "r.covers_seq", "$2::bigint"))},
            call_seqs = array(select distinct s from unnest(coalesce(r.call_seqs, array[r.covers_seq]) || $2::bigint) as x (s) order by s)
      where r.id = $1 returning ${RUN_COLUMNS}`,
    [row.id, coversSeq, triggeredBy, caller.lane, caller.id, askersParam(askers)],
  );
  return { ownerId: agent.ownerId, conversationId, run: toWireRun(rows[0]!) };
}

/**
 * A call on someone else's Agent refused by its caller's limit (`agentCallerRunsPerMinute`): it started nothing and
 * nothing of it is recorded — no run, no `rate_limited` line, no notice; it is only logged, after commit
 * (`logCallerLimited`).
 */
export interface CallerLimited {
  callerId: string;
  agentId: string;
  conversationId: string;
}

/**
 * An Agent whose others' daily budget refused a call and told the group so (`othersBudgetSpent` appended its notice):
 * after commit its owner is pushed the Agent again (`Hub.pushAgentChanged`), so the spend their view shows is current.
 */
export interface BudgetReached {
  ownerId: string;
  agentId: string;
}

/**
 * What a message called for, to act on after commit: runs to announce, calls their caller's limit refused, to log, the
 * notices it led to in its group, to publish after it, the Agents whose others' daily budget it found spent and told
 * the group of, whose owners are pushed the Agent again, and the running runs it ended, whose calls are abandoned.
 */
export interface Triggered {
  runs: Announced[];
  callerLimited: CallerLimited[];
  notices: StoredMessage[];
  budgetReached: BudgetReached[];
  /** Running runs the message ended (an owner's interjection in a social conversation, lane B's B6): their calls are abandoned after commit (`DbAgentPort.interruptRuns`). */
  stopped: readonly string[];
}

/** What a brake told when it refused a call: the notices it appended, to publish, and the Agents to push their owners. */
export type Told = Pick<Triggered, "notices" | "budgetReached">;

/** Nothing told. */
export function noneTold(): Told {
  return { notices: [], budgetReached: [] };
}

/** A message that called for nothing. */
export function noneTriggered(): Triggered {
  return { runs: [], callerLimited: [], stopped: [], ...noneTold() };
}

/** One line per call its caller's limit refused (`caller_rate_limited`): how often the limit holds someone back. */
function logCallerLimited(log: Pick<FastifyBaseLogger, "info">, limited: readonly CallerLimited[]): void {
  for (const { callerId, agentId, conversationId } of limited) {
    log.info({ metric: "caller_rate_limited", callerId, agentId, conversationId }, "a call on someone else's Agent over its caller's replies a minute started nothing");
  }
}

/** After commit: each Agent whose others' daily budget a call found spent, and told the group of, to its owner. */
export function pushBudgetReached(realtime: Pick<Hub, "pushAgentChanged">, reached: readonly BudgetReached[]): void {
  for (const { ownerId, agentId } of reached) realtime.pushAgentChanged(ownerId, agentId);
}

/**
 * After commit, what a message called for (`Triggered`) besides its notices, which are published with it: each run
 * announced (`DbAgentPort.announce`), each call its caller's limit refused logged, each Agent whose others' daily budget
 * it found spent pushed to its owner.
 */
export function actOnTriggered(
  triggered: Triggered,
  to: { announce(run: Announced): void; log: Pick<FastifyBaseLogger, "info">; realtime: Pick<Hub, "pushAgentChanged">; interrupt(runIds: readonly string[]): void },
): void {
  for (const run of triggered.runs) to.announce(run);
  if (triggered.stopped.length > 0) to.interrupt(triggered.stopped);
  logCallerLimited(to.log, triggered.callerLimited);
  pushBudgetReached(to.realtime, triggered.budgetReached);
}

/** A call on an Agent, who made it (`callerOf`) and whose questions it carries (`Askers`): what `reachAgents` acts on. */
interface Call {
  agent: RunAgent;
  by: Caller;
  askers: Askers;
}

/**
 * In a group, under its row lock: the message at `seq` reaches the Agent of each of `calls` (in id order; whether each
 * may be called is decided already, the others' daily budget included), called for by its `by`. It is folded into the
 * Agent's active run in the group — a queued one now covers it, becomes a person's when a person's message is folded
 * in, and its owner's own (`lane` `own`, the owner its caller) when the call is its owner's own (the owner's message, or
 * an Agent's message the owner is behind, `behindAgentMessage`), else keeps its caller and lane — so a member's call
 * relayed through one of the owner's Agents does not make it the owner's — unless nobody had called for it (lane
 * `proactive`): then it is this call's, in its lane (`takesOnCall`); a running one notes it (`pending_seq`), and
 * stays as it is: its follow-up answers what was noted, in a lane of its own (`followUp`). A told reply (`whisper_id`:
 * 告诉他们 queued it, Task 8), queued or running, takes on no call: it only notes it, as a running reply does — the seq
 * in `pending_seq`, the call in `call_seqs`, which for it hold nothing else (`tellFromWhisper`) — and takes on nothing
 * else of it: its follow-up answers the call as an ordinary reply, with tools, in the caller's lane. Every call records
 * the call (`call_seqs`: what a follow-up answers of what was noted is exactly those); any but a told reply also takes
 * on the call's askers (`withAskers`), and everyone who wrote since what it covers, up to the call
 * (`heardIn`: a queued one now covers that stretch; a running one takes it on in `begin`, or hands it down): a running
 * one may take on what was noted before its `begin` reads what it is shown, and what it relays carries its askers on
 * (`triggerFromAgent`). A mention folded so is never
 * refused by the limits below (a spent others' daily budget refused it before it came here). Failing that, a call on
 * someone else's Agent (any lane but `own`) first meets its caller's limit (`calledLastMinute`; a call with no caller
 * has none to meet): over it, nothing at all — the call is returned in `callerLimited`, to log.
 * Then the owner's replies a minute in the call's lane decide (`overLaneLimit`): a reply is queued, or the reusable
 * `rate_limited` run records it (`rateLimitedInGroup`). The owners' `accounts` rows, and the caller's when they call
 * someone else's Agent, are locked once the run rows are done with, all of them in id order, before any is counted
 * (the lock order's last step). Returns what to announce and what to log after commit (it appends no notice).
 */
async function reachAgents(
  t: Tx,
  conversationId: string,
  calls: readonly Call[],
  seq: number,
  triggeredBy: TriggeredBy,
  config: RunLimits,
): Promise<Pick<Triggered, "runs" | "callerLimited">> {
  // Each call not folded into a reply under way, with its caller's id when it is a call on someone else's Agent (any
  // lane but `own`): that call is counted for its caller.
  const unfolded: Array<Call & { othersCaller: string | null }> = [];
  for (const { agent, by, askers } of calls) {
    const folded = await t.query(
      `update agent_runs
          set covers_seq = case when status = 'queued' and whisper_id is null then greatest(covers_seq, $3) else covers_seq end,
              pending_seq = case when status = 'running' or whisper_id is not null then greatest(pending_seq, $3) else pending_seq end,
              ${takesOnCall("status = 'queued' and whisper_id is null", "$4", "$5", "$6")},
              asker_ids = case when whisper_id is null then ${withAskers("$7", heardIn("$2::uuid", "agent_runs.covers_seq", "$3::bigint"))} else asker_ids end,
              call_seqs = array(select distinct s from unnest(coalesce(call_seqs, array[covers_seq]) || $3::bigint) as x (s) order by s)
        where agent_id = $1 and conversation_id = $2 and status in ('queued', 'running')`,
      [agent.id, conversationId, seq, triggeredBy, by.lane, by.id, askersParam(askers)],
    );
    if (!folded.rowCount) unfolded.push({ agent, by, askers, othersCaller: by.lane === "own" ? null : by.id });
  }
  const accounts = unfolded.flatMap(({ agent, othersCaller }) => (othersCaller === null ? [agent.ownerId] : [agent.ownerId, othersCaller]));
  for (const id of [...new Set(accounts)].sort()) await lockAccount(t, id);
  const reached: Pick<Triggered, "runs" | "callerLimited"> = { runs: [], callerLimited: [] };
  for (const { agent, by, askers, othersCaller } of unfolded) {
    if (othersCaller !== null && (await calledLastMinute(t, othersCaller)) >= config.agentCallerRunsPerMinute) {
      reached.callerLimited.push({ callerId: othersCaller, agentId: agent.id, conversationId });
      continue;
    }
    // Someone else's call on an Agent whose model is not there to call (models/resolve.ts `modelUsable`) queues no reply
    // and is not held to its owner's minute (it would spend nothing of theirs): recorded failed `model_gone` at once.
    // Its owner's own call is queued as any (it ends `model_gone` as it begins, with 换一个模型 for them).
    if (by.lane !== "own" && !(await modelUsable(t, config, { ownerId: agent.ownerId, model: await modelOfAgent(t, agent.id) }))) {
      reached.runs.push(await recordRateLimited(t, agent, conversationId, seq, triggeredBy, by, askers, "model_gone"));
      continue;
    }
    const over = await overLaneLimit(t, agent.ownerId, by.lane, config);
    reached.runs.push(
      over
        ? await rateLimitedInGroup(t, agent, conversationId, seq, triggeredBy, by, askers)
        : await queueRun(t, agent, conversationId, seq, triggeredBy, by, askers),
    );
  }
  return reached;
}

/**
 * Whether the numbers an others' call is held to are reached for a call on `agent` in `conversationId` by someone other
 * than its owner (lane `others`; the caller checks the lane): `othersReached`, the advisory twin of `othersFits` — the
 * owner's answers and points, the Agent's own, settled today plus what running replies hold; on a provider's own model
 * the points are left out, as admission leaves them (it costs nothing: only the answers refuse it).
 * Once reached, the conversation is told by an `agent_daily_budget_reached` notice about the Agent,
 * appended now unless one about it was today already (once a site day per conversation and Agent): `notice` is the one
 * appended, else null. The caller holds the conversation's row lock (`appendSystem`).
 */
export async function othersBudgetSpent(
  t: Tx,
  conversationId: string,
  agent: Pick<AgentRow, "id" | "ownerId" | "model">,
  dayStart: Date,
  config: Pick<Config, "others" | "siteTimezone">,
): Promise<{ spent: boolean; notice: StoredMessage | null }> {
  if (!(await othersReached(t, config, agent.ownerId, agent.id, "others", new Date(), { points: agent.model?.source !== "provider" }))) return { spent: false, notice: null };
  return { spent: true, notice: await limitNotice(t, conversationId, agent.id, dayStart) };
}

/**
 * The `agent_daily_budget_reached` notice about `agentId` in `conversationId`, appended now unless one about it was today
 * already (once a site day per conversation and Agent), else null: what a refused call, or a reply ended at admission by
 * an others' number (metering/others.ts `othersFits`), tells the conversation. The caller holds the conversation's row lock.
 */
export async function limitNotice(t: Tx, conversationId: string, agentId: string, dayStart: Date): Promise<StoredMessage | null> {
  if (await toldSince(t, conversationId, dayStart, "agent_daily_budget_reached", agentId)) return null;
  return appendSystem(t, conversationId, { event: "agent_daily_budget_reached", actorId: agentId, agentId });
}

/** When today began, for the others' daily budget and what its owner is shown of it: the site day's start (`siteDayStart`). */
export const siteToday = (config: Pick<Config, "siteTimezone">): Date => siteDayStart(new Date(), config.siteTimezone, 0);

/**
 * Whether a call on `agent` in `lane` is refused by its others' daily budget (`othersBudgetSpent`): only one someone
 * other than its owner made (`others`) ever is. The notice that appended, if any, goes into `told`, with the Agent's
 * owner to push it to.
 */
async function refusedByOthersBudget(
  t: Tx,
  conversationId: string,
  agent: Pick<AgentRow, "id" | "ownerId" | "model">,
  lane: Lane,
  dayStart: Date,
  told: Told,
  config: Pick<Config, "others" | "siteTimezone">,
): Promise<boolean> {
  if (lane !== "others") return false;
  const { spent, notice } = await othersBudgetSpent(t, conversationId, agent, dayStart, config);
  if (notice) {
    told.notices.push(notice);
    told.budgetReached.push({ ownerId: agent.ownerId, agentId: agent.id });
  }
  return spent;
}

/**
 * At admission (`DbAgentPort.begin`, in the transaction that admits the call, under the run's conversation row, its
 * Agent's and its own): whether `agent`'s run in `lane` is refused after all, by what its lane is held to that may have
 * changed while it waited queued: a reply nobody asked for (`proactive`) finds its owner has turned proactive replies off
 * since. Nobody is told — a notice about a reply nobody asked for would be noise. The numbers an others' reply is held to
 * (the owner's two daily numbers, the Agent's own, its proactive budget) are decided at admission itself, with the hold,
 * under the account lock (metering/others.ts `othersFits`; B1), not here. Null when it is not refused; else what the
 * refusal told: nothing.
 */
export function refusedAtAdmission(agent: Pick<AgentRow, "proactive">, lane: Lane): Told | null {
  return lane === "proactive" && !agent.proactive ? noneTold() : null;
}

/**
 * Between two rounds of a reply that offers tools (`DbAgentPort.extend`, under the run's conversation row, its Agent's
 * and its own), and at a web search's pre-hold: whether what the reply has cost so far (`extra`, not settled yet) reaches
 * the Agent's chain budget — a reply in a group that covers messages after the group's latest from a person (one in an
 * Agents' chain, counted toward the chain budget: `chargedSince`) — then no further round may call tools. The numbers an
 * others' reply is held to (the owner's, the Agent's own, its proactive budget) are not here: `othersFits` decides them
 * (metering/others.ts), under the account lock, at admission, at a search and at a round (B1 to B3). Only where `placeOf`
 * is a group; an Agent has one active run in a conversation (agent_runs_one_active_per_agent_conversation), so the chain
 * budget needs no count of other replies.
 */
export async function budgetReachedWith(
  t: Tx,
  run: { conversationId: string; lane: Lane; coversSeq: number },
  agent: Pick<AgentRow, "id" | "conversationId" | "chainBudgetMicro">,
  extra: bigint,
): Promise<boolean> {
  if (run.conversationId === agent.conversationId) return false;
  if ((await placeOf(t, run.conversationId, agent)) !== "group") return false;
  const human = await latestHumanSeq(t, run.conversationId);
  return run.coversSeq > human && (await chargedSince(t, agent.id, run.conversationId, human)) + extra >= agent.chainBudgetMicro;
}

/**
 * A person's message in a group (plan rulings 6–8; Task M): no stored mention (`mentionedIds`; a file's caption is its
 * text, read at send) → nothing, not even a query. Otherwise one query finds, among those it means, the group's current
 * Agent members whose owner and the sender have no block between them, in either direction (`blocks`, read as a send reads it and
 * as a direct chat reads it: neither of the two calls the other's Agents, nor spends the other's points); each, in id order, is locked (`lockAgent` on the group, whose row the send already holds) and called unless it is
 * deleted, paused or has no model, or only its owner may call it (`groupMentions` `owner`) and this is someone else's
 * message. `replyMode` plays no part in a group. Someone else's message is then held to the Agent's others' daily
 * numbers, read under the Agent's row lock (`othersBudgetSpent`, settled plus held): once they are reached the Agent is not called — not even
 * folded into a reply of its under way — and the group is told once a day (the notice returned, to publish, and the
 * Agent's owner to push it to); the refusal is recorded with the message (`recordRefusedCalls`), so should it lie among
 * what a later follow-up of the Agent answers, it is no call of it (`followUp`). Its owner's message never is. Then
 * `reachAgents`, each called for by the sender (`callerOf`).
 */
async function triggerInGroup(t: Tx, conversationId: string, message: StoredMessage, config: RunLimits): Promise<Triggered> {
  const called = mentionedIds(message);
  if (called.length === 0) return noneTriggered();
  const { rows } = await t.query<{ id: string }>(
    `select p.id from memberships m
       join principals p on p.id = m.principal_id
       join agents a on a.principal_id = p.id
      where m.conversation_id = $1 and m.left_seq is null and p.kind = 'agent' and p.id = any($2::uuid[])
        and not ${blockedEitherWay("p.owner_id", "$3::uuid")}
      order by p.id`,
    [conversationId, called, message.senderId],
  );
  const dayStart = siteToday(config);
  const told = noneTold();
  const calls: Call[] = [];
  const refused: string[] = [];
  for (const { id } of rows) {
    const agent = await lockAgent(t, id, conversationId);
    if (agent.deleted || agent.paused || agent.model === null) continue;
    if (agent.groupMentions === "owner" && message.senderId !== agent.ownerId) continue;
    const by = callerOf(agent.ownerId, message.senderId);
    if (await refusedByOthersBudget(t, conversationId, agent, by.lane, dayStart, told, config)) {
      refused.push(agent.id);
      continue;
    }
    // The sender asks (Task 10b): what the reply is shown starts no earlier than their joining.
    calls.push({ agent, by, askers: [message.senderId] });
  }
  await recordRefusedCalls(t, conversationId, message.seq, refused);
  return { ...(await reachAgents(t, conversationId, calls, message.seq, "human", config)), stopped: [], ...told };
}

/** The seq of the group's latest message from a person (a notice is nobody's message), 0 when there is none. */
async function latestHumanSeq(t: Tx, conversationId: string): Promise<number> {
  const { rows } = await t.query<{ seq: string }>(
    `select m.seq::text as seq from messages m join principals p on p.id = m.sender_id
      where m.conversation_id = $1 and m.kind <> 'system' and p.kind = 'human'
      order by m.seq desc limit 1`,
    [conversationId],
  );
  return rows[0] ? Number(rows[0].seq) : 0;
}

/** Whether Agents are halted in the group (ruling 11): its latest message from a person is at or before the halt. */
async function isHalted(t: Tx, conversationId: string, latestHuman: number): Promise<boolean> {
  const { rows } = await t.query<{ halted: string | null }>("select agents_halted_seq::text as halted from conversations where id = $1", [conversationId]);
  const halted = rows[0]?.halted ?? null;
  return halted !== null && latestHuman <= Number(halted);
}

/**
 * Whether the group was halted at or after seq `seq` (`agents_halted_seq` ≥ it): a message up to it came before the
 * latest halt, whether or not a person has written since and so lifted it for what comes next.
 */
async function haltedSince(t: Tx, conversationId: string, seq: number): Promise<boolean> {
  const { rows } = await t.query<{ halted: string | null }>("select agents_halted_seq::text as halted from conversations where id = $1", [conversationId]);
  const halted = rows[0]?.halted ?? null;
  return halted !== null && seq <= Number(halted);
}

/**
 * Whether a notice of `event` (about Agent `agentId`, when given) was appended to the conversation after `after`: a seq
 * (after that message: a person's latest, for the chain's notices) or a time (since then: the others' daily budget's
 * notice once a site day, `agent_quieted` once an hour, proactive/decide.ts). What keeps each notice to once a period.
 * Those counted by time are appended by their Agent (`actorId` = `agentId`: the message's sender), so they are also
 * looked for by sender, which the sender's index finds without reading the group's history.
 */
export async function toldSince(q: Queryable, conversationId: string, after: number | Date, event: SystemEvent["event"], agentId: string | null = null): Promise<boolean> {
  const bySender = typeof after !== "number" && agentId !== null;
  const { rowCount } = await q.query(
    `select 1 from messages
      where conversation_id = $1 and ${typeof after === "number" ? "seq > $2" : "created_at >= $2"} and kind = 'system' and body ->> 'event' = $3
        and ($4::text is null or body ->> 'agentId' = $4)${bySender ? " and sender_id = $5" : ""}
      limit 1`,
    [conversationId, after, event, agentId, ...(bySender ? [agentId] : [])],
  );
  return rowCount !== 0;
}

/** What Agent `agentId`'s owner was charged for its replies in the group covering messages after seq `since`. */
async function chargedSince(t: Tx, agentId: string, conversationId: string, since: number): Promise<bigint> {
  const { rows } = await t.query<{ charged: string }>(
    `select coalesce(sum(u.free_micro + u.balance_micro), 0)::text as charged
       from agent_runs r join usage_records u on u.run_id = r.id
      where r.agent_id = $1 and r.conversation_id = $2 and r.purpose = 'reply' and r.covers_seq > $3`,
    [agentId, conversationId, since],
  );
  return BigInt(rows[0]!.charged);
}

/**
 * The chain budget (ruling 12) of Agent `agentId` in the group whose latest message from a person is at seq `human`:
 * null while what its owner was charged for its replies there covering messages after it is under `budgetMicro`; once
 * it has reached it, the `agent_budget_reached` notice about the Agent — appended now, unless one was since that
 * message: then null in its place.
 */
async function chainBudgetSpent(
  t: Tx,
  conversationId: string,
  agentId: string,
  budgetMicro: bigint,
  human: number,
): Promise<{ notice: StoredMessage | null } | null> {
  if ((await chargedSince(t, agentId, conversationId, human)) < budgetMicro) return null;
  if (await toldSince(t, conversationId, human, "agent_budget_reached", agentId)) return { notice: null };
  return { notice: await appendSystem(t, conversationId, { event: "agent_budget_reached", actorId: agentId, agentId }) };
}

/**
 * An Agent's own message in a group (plan rulings 10–12), in `postAsAgent`'s transaction, which holds the group's row
 * and the poster's `agents` row. Those its stored mentions mean (`mentionedIds`: read once at its post, Task M), less
 * itself (an Agent never calls itself); none → nothing.
 * One query finds, among them, the group's current Agent members that an Agent may call: not deleted, not
 * paused, with a model, `groupMentions` `members`, and of an owner with no block, in either direction, between them and
 * the poster's owner, nor between them and the person behind the message (`behindAgentMessage`; none when nobody is) —
 * neither of two people calls the other's Agents, through their own Agent or someone else's no more than themselves: a
 * member's call relayed through the owner's Agent to an Agent whose owner and the member have a block between them
 * reaches nothing, as the member's own mention would. Their `agents` rows are read, not locked — not even key-shared
 * by what this writes: a run refers to its Agent's principal, and so does a recorded refusal (migration 023) — since the
 * poster's is held already, and locking another's after it could take two Agents' rows out of id order — two Agents
 * calling each other from two groups at once would deadlock. The fold-or-insert decision needs no target's row: the group's row, which
 * this transaction holds, orders it with every other trigger, retry, follow-up and halt in this group (the one-active-run
 * index backs that). A pause or delete that commits meanwhile takes the target's row, not the group's, and cannot see
 * the run this inserts or the mention it notes (no predicate lock): a deleted Agent's run is ended by the worker without
 * a call (`begin`), and a paused one's by the resume, before the Agent answers again (`endWhatPauseMissed`; the worker's
 * `begin` too while it is still paused) — unless both the pause and the resume commit inside this transaction's few
 * queries: then the resume cannot see it either. With nobody to call, nothing more.
 * Then, in turn:
 * - halted (ruling 11): the group's latest message from a person is at or before `agents_halted_seq` → nothing;
 * - the chain limit (ruling 10): the group's last `agentChainLimit` messages that are not notices were all Agents' (this
 *   one among them) → nobody is called, and an `agent_chain_paused` notice is appended unless one was since a person
 *   last wrote;
 * - the chain budget (ruling 12), per Agent: what its owner was charged for its replies in this group covering
 *   messages after a person's latest has reached its `chainBudget` → it is not called, and an `agent_budget_reached`
 *   notice about it is appended unless one was since a person last wrote;
 * - the others' daily budget, per Agent the call is not its owner's own on (see below): once it is spent
 *   (`othersBudgetSpent`, read from the row read above, not locked: settled plus held) → it is not called, and an
 *   `agent_daily_budget_reached` notice about it is appended unless one was today (its owner is returned, to push the
 *   Agent to).
 * Each Agent refused so, or for a block, is recorded with the message (`recordRefusedCalls`): nothing was noted for it,
 * and should the message lie among what a later follow-up of that Agent answers, it is no call of it (`followUp`). One
 * the query does not find at all (paused, deleted, without a model, only its owner's to call, not a member) is not
 * recorded: nothing was noted for it, so it is no call of a follow-up either (`call_seqs`).
 * The rest are reached as a person's message reaches them (`reachAgents`), as an Agent's (`triggered_by` `agent`),
 * called for by the person behind the message (`behindAgentMessage`, from `postedBy`, the caller and lane of the run that
 * posted it; null when no run did): the caller of that run when it is not its owner's own, else the poster's owner —
 * `callerOf`, the target's owner's own when they are that person. So a member's call relayed through the owner's Agent
 * stays the member's — held to the target's others' daily budget, the member's caller limit and the others' lane — and a
 * call on someone else's Agent counts toward the caller limit of the person behind it, as their own call would; what a
 * reply nobody called for relays is others', with no caller (no caller limit; the budget and the others' lane hold).
 * Each run it reaches answers `askers`, those of the run that posted the message (Task 10b: the person whose message
 * started the chain; null, not known, when no run posted it or that run's are not known) — every caller says whose; a
 * function (`postAsAgent`'s, which first records what the posting run heard, runs.ts `hearFrom`) is called only once the
 * message reaches a run, never for one that calls nobody.
 */
export async function triggerFromAgent(
  t: Tx,
  conversationId: string,
  message: StoredMessage,
  poster: AgentRow,
  postedBy: Caller | null,
  config: RunLimits & Pick<Config, "agentChainLimit">,
  askers: Askers | (() => Promise<Askers>),
): Promise<Triggered> {
  const called = mentionedIds(message).filter((id) => id !== poster.id);
  if (called.length === 0) return noneTriggered();
  const behind = behindAgentMessage(poster.ownerId, postedBy);
  // A block, either way, between a target's owner and the poster's owner or the person behind the message (none to
  // match when nobody is: `$5` null) refuses the target.
  const { rows } = await t.query<{ id: string; owner_id: string; budget: string; others_budget: string | null; blocked: boolean }>(
    `select p.id, p.owner_id, a.chain_budget_micro::text as budget, a.others_budget_micro::text as others_budget,
            ${blockedEitherWay("p.owner_id", "$4::uuid, $5::uuid")} as blocked
       from memberships m
       join principals p on p.id = m.principal_id
       join agents a on a.principal_id = p.id
      where m.conversation_id = $1 and m.left_seq is null and p.kind = 'agent' and p.id = any($2::uuid[]) and p.id <> $3
        and a.deleted_at is null and not a.paused and a.model_source is not null and a.group_mentions = 'members'
      order by p.id`,
    [conversationId, called, poster.id, poster.ownerId, behind],
  );
  // The targets refused below (a block, the halt, the chain limit, a chain budget, an others' daily budget), recorded with
  // the message as this returns, so that none of them counts it as a call later (`followUp`).
  const refused = rows.filter((r) => r.blocked).map((r) => r.id);
  const targets = rows.filter((r) => !r.blocked);
  const recorded = async (triggered: Triggered): Promise<Triggered> => {
    await recordRefusedCalls(t, conversationId, message.seq, refused);
    return triggered;
  };
  if (targets.length === 0) return recorded(noneTriggered());

  const human = await latestHumanSeq(t, conversationId);
  const all = targets.map((target) => target.id);
  if (await isHalted(t, conversationId, human)) {
    refused.push(...all);
    return recorded(noneTriggered());
  }
  const limit = config.agentChainLimit;
  // Every message after a person's latest that is not a notice is an Agent's; an acknowledgement is no Agent's turn.
  const inARow = await t.query<{ n: number }>(
    `select count(*)::int as n from (select 1 from messages m where m.conversation_id = $1 and m.seq > $2 and m.kind <> 'system' and ${notAcknowledgement("m")} limit $3) x`,
    [conversationId, human, limit],
  );
  if (inARow.rows[0]!.n >= limit) {
    refused.push(...all);
    if (await toldSince(t, conversationId, human, "agent_chain_paused")) return recorded(noneTriggered());
    return recorded({ ...noneTriggered(), notices: [await appendSystem(t, conversationId, { event: "agent_chain_paused", actorId: poster.id, limit })] });
  }

  const dayStart = siteToday(config);
  const told = noneTold();
  const reached: Array<Omit<Call, "askers">> = [];
  for (const target of targets) {
    const spent = await chainBudgetSpent(t, conversationId, target.id, BigInt(target.budget), human);
    if (spent?.notice) told.notices.push(spent.notice);
    const agent = { id: target.id, ownerId: target.owner_id, othersBudgetMicro: target.others_budget === null ? null : BigInt(target.others_budget), model: await modelOfAgent(t, target.id) };
    const by = callerOf(agent.ownerId, behind);
    if (spent || (await refusedByOthersBudget(t, conversationId, agent, by.lane, dayStart, told, config))) {
      refused.push(target.id);
      continue;
    }
    reached.push({ agent, by });
  }
  // Whose questions the calls carry, read only now that the message reaches a run (fix round 3, M-10).
  const carried = reached.length === 0 ? null : typeof askers === "function" ? await askers() : askers;
  const calls: Call[] = reached.map((c) => ({ ...c, askers: carried }));
  return recorded({ ...(await reachAgents(t, conversationId, calls, message.seq, "agent", config)), stopped: [], ...told });
}

/**
 * That the message at `seq` called each of `agentIds` and was refused for it when it was posted (`refused_agent_calls`,
 * migrations 022 and 023; `triggerFromAgent`, and `triggerInGroup` for the others' daily budget): `followUp` does not
 * count it as a call of theirs. The row refers to each Agent's principal, never its `agents` row, so writing it locks no
 * `agents` row (an Agent's post holds none but its own). Never on the wire.
 */
async function recordRefusedCalls(t: Tx, conversationId: string, seq: number, agentIds: readonly string[]): Promise<void> {
  if (agentIds.length === 0) return;
  await t.query("insert into refused_agent_calls (conversation_id, seq, agent_id) select $1, $2, unnest($3::uuid[]) on conflict do nothing", [
    conversationId,
    seq,
    agentIds,
  ]);
}

/** What a run's end calls for in its conversation, to act on after commit (`followUp`). */
export interface FollowUp extends Told {
  /** The follow-up queued — or, over the owner's replies a minute, the Agent's reusable `rate_limited` run — to announce. */
  run: Announced | null;
}

/** The follow-up `run` (null: none), and what deciding it `told` (nothing unless given). */
export function followUpOf(run: Announced | null, told: Told = noneTold()): FollowUp {
  return { run, ...told };
}

/**
 * The follow-up of a run of `agent` in `conversationId` that ended having noted messages up to `pending` beyond what it
 * covered (`covers`), under that conversation's row and the Agent's (`finish`, recovery): a queued reply answering up
 * to `pending`. A message there "calls" it only when the run noted it as a call when it was sent (`callSeqs`, the run's
 * `call_seqs`; none when null), whatever its text would name now. In the Agent's own conversation it is its owner's, as always, and is queued whatever the owner's
 * replies a minute (it answers what its owner wrote meanwhile; README "Replies started"). In a group it is a person's
 * when a person's message in (covers, pending] calls the Agent (one its `groupMentions` lets call it, from a person with no block between them and its owner, in either direction); otherwise only
 * Agents' messages called for it: it is an Agent's, and is not queued at all when the latest of them (`pending`) came
 * at or before the group's latest halt (`agents_halted_seq`, ruling 11), even if a person has written since: what
 * Agents asked before a halt is not answered after it (what a person asked is); nor once the Agent's chain budget is
 * spent (ruling 12, the same rule and notice as for an Agent's mention, `chainBudgetSpent`) — checked again here
 * because the reply that just ended was settled after it was called, so a chain overshoots its budget by at most the
 * one reply that was under way. A follow-up in lane `others` (see below) is not queued either once the Agent's others'
 * numbers are reached — the same rule and notice as for someone else's mention (`othersBudgetSpent`; the reply that
 * just ended is settled by now) — and the Agent's owner is returned, to push it to; its owner's own is never held to
 * it. A group's follow-up, a person's or an Agent's, is a reply started like any other, so
 * the owner's replies a minute in its lane decide as for a mention (`overLaneLimit`; its caller's limit does not: what
 * it answers was folded into a reply under way, never refused): counted under the owner's `accounts` row (the lock
 * order's last step; the caller holds the group's row, the Agent's and the run's), and over it the Agent's reusable
 * `rate_limited` run in the group records it instead (`rateLimitedInGroup`), so a member who keeps mentioning an Agent
 * while it replies cannot keep it replying past its owner's limit. Its lane and caller come from what it
 * answers, not from the run that ended: the messages in (covers, pending] that call the Agent — a person's, as above,
 * or another Agent's while its `groupMentions` lets members call it (with no block, either way, between the Agent's
 * owner and that Agent's owner, nor the person behind that message), which is the call of the person behind it by the rule of
 * `behindAgentMessage` (the caller of the run that posted it — the run its `client_txn` names — when that run is not its
 * owner's own, else that Agent's owner) — make it its owner's own when the owner is behind one of them, else the
 * earliest caller's (a message nobody is behind, relayed from a reply nobody called for, names no one: the earliest that
 * names someone). When none of them is left (a block since, or the Agent no longer lets members call it) it is others',
 * with no caller: a call its owner no longer allows does not ride the owner's own lane. A mention of it that was refused
 * when it was posted — an Agent's for the group's halt, the chain limit, its chain budget, its others' daily budget or a
 * block (`triggerFromAgent`), a person's for its others' daily budget (`triggerInGroup`) — is no call at all
 * (`refused_agent_calls`): nothing was noted for it, though it may lie among what the follow-up answers. One refused
 * because the Agent was paused, had no model or let only its owner call it is not recorded: nothing was noted for it,
 * so it is no call of the follow-up either (`call_seqs`). Whose questions it answers (`Askers`, Task 10b) comes from the same calls: each
 * person's sender, and the askers of the run that posted each Agent's — not known (null) when one of those is not (or
 * no run posted it), or when no call is left — and everyone who wrote in (covers, pending] besides (fix round 2,
 * `heardIn`); it answers those calls (`call_seqs`). In the Agent's own conversation, its owner.
 */
export async function followUp(
  t: Tx,
  agent: AgentRow,
  conversationId: string,
  covers: number,
  pending: number,
  callSeqs: readonly (number | string)[] | null,
  config: RunLimits,
): Promise<FollowUp> {
  const owners = callerOf(agent.ownerId, agent.ownerId);
  if (conversationId === agent.conversationId) return followUpOf(await queueRun(t, agent, conversationId, pending, "human", owners, [agent.ownerId]));
  if ((await placeOf(t, conversationId, agent)) === "social") return followUpInSocial(t, agent, conversationId, covers, pending, config);
  // The person behind each message (`behindMessageSql`): its sender; for an Agent's message, the caller of the run that
  // posted it (`postingRun`) unless that run is its owner's own (or there is none: the owner). A message does not count
  // when it was refused for this Agent when it was posted (`refused_agent_calls`), nor when there is a block, either way,
  // between the Agent's owner and the sender or the sending Agent's owner, or the person behind it (nobody behind it
  // matches no block), nor when it is an Agent's acknowledgement: it calls nobody (`notAcknowledgement`; whom the
  // follow-up hears from, `heardIn` below, still counts it).
  const { rows } = await t.query<{ seq: string; kind: "human" | "agent"; sender_id: string; caller_id: string | null; askers: string[] | null }>(
    `select m.seq::text as seq, p.kind, m.sender_id, bh.caller_id, r.asker_ids as askers
       from messages m
       join principals p on p.id = m.sender_id
       left join agent_runs r on p.kind = 'agent' and ${postingRun("m", "r")}
       cross join lateral (select ${behindMessageSql("p", "r")} as caller_id) bh
      where m.conversation_id = $1 and m.seq > $2 and m.seq <= $3 and m.kind <> 'system' and m.sender_id <> $5 and ${notAcknowledgement("m")}
        and not exists (select 1 from refused_agent_calls x where x.conversation_id = m.conversation_id and x.seq = m.seq and x.agent_id = $5)
        and not ${blockedEitherWay("$4::uuid", "coalesce(p.owner_id, p.id), bh.caller_id")}
      order by m.seq`,
    [conversationId, covers, pending, agent.ownerId, agent.id],
  );
  // The calls the run noted (`callSeqs`, its `call_seqs`: each recorded as it was accepted when it was sent), never read
  // again from the text, which a rename or a member joining or leaving since would read otherwise (fix round 1, I1) — nor
  // from the messages' stored mentions, which also name the Agent where its call was refused as it was sent. A told reply
  // (`告诉他们`) is followed up so too: its `call_seqs` hold the calls noted on it and nothing else (`reachAgents`).
  const noted = new Set((callSeqs ?? []).map(Number));
  // An Agent's message calls no Agent only its owner may call (`triggerFromAgent`).
  const calls = rows.filter(
    (r) => (agent.groupMentions === "members" || (r.kind === "human" && r.sender_id === agent.ownerId)) && noted.has(Number(r.seq)),
  );
  const asked = calls.some((r) => r.kind === "human");
  // None of them (or none that names someone): others', with no caller.
  const caller: Caller = calls.some((r) => r.caller_id === agent.ownerId)
    ? owners
    : callerOf(agent.ownerId, calls.find((r) => r.caller_id !== null)?.caller_id ?? null);
  // And everyone who wrote in what it now covers (fix round 2: whoever it hears from, `heardIn`).
  const heard = (await t.query<{ ids: string[] | null }>(`select ${heardIn("$1::uuid", "$2::bigint", "$3::bigint")} as ids`, [conversationId, covers, pending]))
    .rows[0]!.ids;
  const askers: Askers =
    calls.length === 0 || calls.some((r) => r.kind === "agent" && r.askers === null) || heard === null
      ? null
      : [...new Set([...calls.flatMap((r) => (r.kind === "human" ? [r.sender_id] : r.askers!)), ...heard])];
  const told = noneTold();
  if (!asked) {
    if (await haltedSince(t, conversationId, pending)) return followUpOf(null);
    // The chain budget again, now that the reply that just ended is settled: it may have spent it.
    const spent = await chainBudgetSpent(t, conversationId, agent.id, agent.chainBudgetMicro, await latestHumanSeq(t, conversationId));
    if (spent?.notice) told.notices.push(spent.notice);
    if (spent) return followUpOf(null, told);
  }
  if (await refusedByOthersBudget(t, conversationId, agent, caller.lane, siteToday(config), told, config)) return followUpOf(null, told);
  const by: TriggeredBy = asked ? "human" : "agent";
  const over = await overLaneLimit(t, agent.ownerId, caller.lane, config);
  const run = over ? await rateLimitedInGroup(t, agent, conversationId, pending, by, caller, askers) : await queueRun(t, agent, conversationId, pending, by, caller, askers);
  await answersCalls(t, run.run.id, calls.map((r) => Number(r.seq)));
  return followUpOf(run);
}

/**
 * `followUp` in a social conversation (B5a): the run that ended was one visitor's (its `caller_id`), and what the visitor wrote
 * meanwhile (`covers`, `pending`] is that same call again, in lane `others` with the visitor as caller (`callerOf`), answering
 * the visitor alone. No mention is read: everything a participant writes there calls the Agent. Nothing is queued when there is
 * no caller or no message of the visitor's in that stretch, when `reach` refuses the visitor now (an ending since: the same rule
 * as at the trigger), or when the owner's others' numbers are reached (the notice of once a site day: `limitNotice`); over the owner's
 * minute in the lane the run is recorded `rate_limited`, as a trigger records it. The caller holds the conversation's row and the
 * Agent's.
 */
async function followUpInSocial(t: Tx, agent: AgentRow, conversationId: string, covers: number, pending: number, config: RunLimits): Promise<FollowUp> {
  const ended = await t.query<{ caller_id: string | null }>(
    "select caller_id from agent_runs where agent_id = $1 and conversation_id = $2 and purpose = 'reply' order by created_at desc, id desc limit 1",
    [agent.id, conversationId],
  );
  const callerId = ended.rows[0]?.caller_id ?? null;
  if (callerId === null || callerId === agent.ownerId) return followUpOf(null);
  if ((await reach(t, callerId, agent.id, "social", config)) !== "ok") return followUpOf(null);
  const { rows } = await t.query<{ seq: string }>(
    "select seq::text as seq from messages where conversation_id = $1 and seq > $2 and seq <= $3 and kind <> 'system' and sender_id = $4 order by seq",
    [conversationId, covers, pending, callerId],
  );
  if (rows.length === 0) return followUpOf(null);
  const caller = callerOf(agent.ownerId, callerId);
  const told = noneTold();
  if (await refusedByOthersBudget(t, conversationId, agent, caller.lane, siteToday(config), told, config)) return followUpOf(null, told);
  const over = await overLaneLimit(t, agent.ownerId, caller.lane, config);
  const run = over
    ? await recordRateLimited(t, agent, conversationId, pending, "human", caller, [callerId])
    : await queueRun(t, agent, conversationId, pending, "human", caller, [callerId]);
  await answersCalls(t, run.run.id, rows.map((r) => Number(r.seq)));
  return followUpOf(run, told);
}

/** What a halt did, to act on after it commits. */
export interface Halted {
  /** The `agents_halted` notice, or null when the group was halted already. */
  notice: StoredMessage | null;
  /** Queued runs it cancelled, each to announce to its owner — and the follow-ups queued for what was noted on them. */
  cancelled: Announced[];
  /** What those follow-ups appended and whom to push (`followUp`'s notices and budget-reached owners), to act on after commit. */
  followed: Told;
  /** Running runs it interrupted, whose calls this process abandons (`DbAgentPort.interruptRuns`). */
  running: string[];
}

/**
 * `POST /api/conversations/:id/agents/halt` (ruling 11), by `actorId`: unless the conversation is a group, 404 before
 * any lock; then under the group's row (`lockForWrite`: 404 unless a current member of an open conversation)
 * `agents_halted_seq` becomes the group's current seq, so Agents' messages call nobody until a person writes again (and,
 * batch 2D, no Agent replies unasked to a message before it). The runs Agents' messages called for end, and so do the
 * replies nobody called for (lane `proactive`; one a call was folded into is that call's, `takesOnCall`): a queued one is
 * `cancelled`, `halted` (it never reached a model); a running one is marked `interrupted` `halted` — never posted, it
 * ends `cancelled` with that reason and is settled as any; what a person asked of it meanwhile still gets its follow-up
 * (`followUp`) — of a running one when it ends (port-impl.ts `finish`), of a queued one here, by the same rule
 * (`followUpOnEnd`: what an admission that held it back handed back to it; round 3 S-4). Runs a person called for are
 * left alone. The `agents_halted` notice is appended unless the group was halted already (no person has written since
 * the last halt): then nothing changes. Lock order: the group's row, the `agents` rows of the queued runs with something
 * noted (in id order), then run rows, then (`followUp`) their owners' `accounts` rows.
 */
export async function haltAgents(t: Tx, conversationId: string, actorId: string, config: RunLimits): Promise<Halted> {
  if ((await peekConversation(t, conversationId))?.type !== "group") throw notFound();
  const lock = await lockForWrite(t, conversationId, actorId);
  const already = await isHalted(t, conversationId, await latestHumanSeq(t, conversationId));
  await t.query("update conversations set agents_halted_seq = greatest(coalesce(agents_halted_seq, 0), $2) where id = $1", [conversationId, lock.conversation.seq]);
  // The Agents of the queued runs it ends that hold something noted, before any run row (nothing changes that while the
  // group's row is held: an admission takes it first).
  const noting = await t.query<{ agent_id: string }>(
    `select distinct agent_id from agent_runs
      where conversation_id = $1 and status = 'queued' and (triggered_by = 'agent' or lane = 'proactive') and pending_seq > covers_seq
      order by agent_id`,
    [conversationId],
  );
  const agents = new Map<string, AgentRow>();
  for (const { agent_id } of noting.rows) agents.set(agent_id, await lockAgent(t, agent_id, conversationId));
  const queued = await t.query<RunRow & { owner_id: string; agent_id: string; covers: string | null; pending: string | null; calls: string[] | null; told: boolean; greets: boolean }>(
    `update agent_runs as r set status = 'cancelled', error = 'halted', finished_at = now()
      from (select id, covers_seq::text as covers, pending_seq::text as pending, call_seqs::text[] as calls from agent_runs
             where conversation_id = $1 and status = 'queued' and (triggered_by = 'agent' or lane = 'proactive')) before
      where r.id = before.id
      returning ${RUN_COLUMNS}, r.owner_id, r.agent_id, before.covers, before.pending, before.calls, r.whisper_id is not null as told, r.greets`,
    [conversationId],
  );
  const running = await t.query<{ id: string }>(
    `update agent_runs set interrupted = 'halted'
      where conversation_id = $1 and status = 'running' and (triggered_by = 'agent' or lane = 'proactive') and interrupted is null returning id`,
    [conversationId],
  );
  const notice = already ? null : await appendSystem(t, conversationId, { event: "agents_halted", actorId });
  // Then the follow-ups, after the notice (what an Agent asked before it is not answered after it: `followUp`).
  const cancelled: Announced[] = [];
  const followed = noneTold();
  for (const r of queued.rows) {
    cancelled.push({ ownerId: r.owner_id, conversationId, run: toWireRun(r) });
    const agent = agents.get(r.agent_id);
    const next = agent ? followUpOnEnd({ covers_seq: r.covers, pending_seq: r.pending, told: r.told, greets: r.greets }, agent, { status: "cancelled", error: "halted" }, { recovered: false, retried: false }) : null;
    if (agent === undefined || next === null) continue;
    const { run, ...told } = await followUp(t, agent, conversationId, Number(r.covers ?? 0), next, r.calls, config);
    if (run) cancelled.push(run);
    followed.notices.push(...told.notices);
    followed.budgetReached.push(...told.budgetReached);
  }
  return {
    notice,
    cancelled,
    followed,
    running: running.rows.map((r) => r.id),
  };
}

/**
 * The trigger (spec 6.5): in the send transaction, after a person's `message` was stored (not a repeat), under the
 * send's locks. In a group: `triggerInGroup`, the Agent members its stored mentions mean. In an Agent conversation
 * only a message from the owner counts, and nothing happens when the Agent is paused, deleted or has no model, or
 * answers only when called (`replyMode` `mention`) and its stored mentions do not mean it (picked, or typed as its full
 * handle, its name part or `@` and its name: mentions.ts `mentionsAtSend`). With a
 * reply of the Agent already active in this conversation the message is folded into it: a queued one now covers it, a
 * running one notes it in `pending_seq` (one follow-up answers everything that came meanwhile); a reply active in
 * another conversation is not touched. Otherwise a reply is queued here — unless the owner has started their own
 * `agentRunsPerMinute` in the last minute (every reply here is their own: `overLaneLimit`): then a `failed` run,
 * `rate_limited`, is recorded instead (`recordRateLimited`; the message stays sent). Returns the runs to announce and,
 * in a group, the calls their caller's limit refused, to log, and what the others' daily budget appended — the notices
 * to publish after the message, the owners to push their Agents to — after commit (nothing in a direct chat).
 */
export async function maybeTrigger(t: Tx, lock: WriteLock, message: StoredMessage, config: RunLimits): Promise<Triggered> {
  if (message.kind === "system") return noneTriggered();
  if (lock.conversation.type === "group") return triggerInGroup(t, lock.conversation.id, message, config);
  if (lock.conversation.type !== "agent") return noneTriggered();
  const conversationId = lock.conversation.id;
  const found = await t.query<{ agent_id: string }>("select agent_id from agent_conversations where conversation_id = $1", [conversationId]);
  if (!found.rows[0]) return noneTriggered();
  const agent = await lockAgent(t, found.rows[0].agent_id, conversationId);
  if (message.senderId !== agent.ownerId || agent.paused || agent.deleted || agent.model === null) return noneTriggered();
  if (agent.replyMode === "mention" && !mentionedIds(message).includes(agent.id)) return noneTriggered();
  // Its owner's message: every reply here is the owner's own.
  const caller = callerOf(agent.ownerId, message.senderId);
  // A new Agent's greeting still queued gives way: it answers no message, so the owner's gets an ordinary reply (whose
  // failure is shown, with 重试) — never folded into a greeting that ends quietly. Whatever was noted on it needs no
  // follow-up of its own (`followUpOnEnd`): the reply queued below covers this message, so all written before it too.
  const greeting = await t.query<RunRow>(
    `update agent_runs as r set status = 'cancelled', finished_at = now()
      where r.agent_id = $1 and r.conversation_id = $2 and r.status = 'queued' and r.greets returning ${RUN_COLUMNS}`,
    [agent.id, conversationId],
  );
  const gaveWay: Announced[] = greeting.rows.map((r) => ({ ownerId: agent.ownerId, conversationId, run: toWireRun(r) }));

  const folded = await t.query(
    `update agent_runs
        set covers_seq = case when status = 'queued' then greatest(covers_seq, $3) else covers_seq end,
            pending_seq = case when status = 'running' then greatest(pending_seq, $3) else pending_seq end
      where agent_id = $1 and conversation_id = $2 and status in ('queued', 'running')`,
    [agent.id, conversationId, message.seq],
  );
  if (folded.rowCount) return noneTriggered();
  const over = await overLaneLimit(t, agent.ownerId, caller.lane, config);
  const askers = [message.senderId];
  const run = over
    ? await recordRateLimited(t, agent, conversationId, message.seq, "human", caller, askers)
    : await queueRun(t, agent, conversationId, message.seq, "human", caller, askers);
  return { ...noneTriggered(), runs: [...gaveWay, run] };
}

/**
 * In a group, under its row (`lockForWrite`: 404 unless `ownerId` is a current member of it): the Agent `agentId` names,
 * when it is `ownerId`'s — 400 without `agentId` (it is required in a group), 404 as for an Agent that does not exist
 * for anyone else's, a person's or an unknown id — and the seq it joined the group at in its current stay, or null when
 * it is not in the group now.
 */
async function ownAgentInGroup(
  t: Tx,
  ownerId: string,
  conversationId: string,
  agentId: string | undefined,
): Promise<{ agentId: string; joinedSeq: number | null }> {
  await lockForWrite(t, conversationId, ownerId);
  if (agentId === undefined) throw new AppError(400, "invalid_request");
  const { rows } = await t.query<{ joined: string | null }>(
    `select (select m.joined_seq::text from memberships m where m.conversation_id = $3 and m.principal_id = p.id and m.left_seq is null) as joined
       from principals p join agents a on a.principal_id = p.id
      where p.id = $2 and p.kind = 'agent' and p.owner_id = $1`,
    [ownerId, agentId, conversationId],
  );
  if (!rows[0]) throw notFound();
  return { agentId, joinedSeq: rows[0].joined === null ? null : Number(rows[0].joined) };
}

/**
 * The Agent's latest reply run in the conversation (whatever its stay): what it covered (`covers`), that and what was
 * noted on it besides (`answers`: the greater of `covers_seq` and `pending_seq`), whose message called for it, whose
 * questions it answered (`asker_ids`), and which calls (`call_seqs`: null when not known).
 */
async function latestRunOf(
  q: Queryable,
  agentId: string,
  conversationId: string,
): Promise<
  (RunRow & { covers: string | null; answers: string | null; triggered_by: TriggeredBy; asker_ids: string[] | null; calls: string[] | null; whisper_id: string | null }) | null
> {
  const { rows } = await q.query<
    RunRow & { covers: string | null; answers: string | null; triggered_by: TriggeredBy; asker_ids: string[] | null; calls: string[] | null; whisper_id: string | null }
  >(
    `select ${RUN_COLUMNS}, r.covers_seq::text as covers, greatest(r.covers_seq, coalesce(r.pending_seq, 0))::text as answers, r.triggered_by, r.asker_ids,
            r.call_seqs::text[] as calls, r.whisper_id
       from agent_runs r
      where r.agent_id = $1 and r.conversation_id = $2 and r.purpose = 'reply' order by r.created_at desc, r.id desc limit 1`,
    [agentId, conversationId],
  );
  return rows[0] ?? null;
}

/**
 * The one rule for a follow-up (README "Agents and runs", Coalescing): a run that has ended is followed by a reply to
 * what its owner wrote meanwhile when something was noted on it (`pending_seq` beyond what it covered) and its Agent
 * can still answer (not paused, not deleted, has a model) — however the run itself ended. A pause or delete drops what
 * was noted (`interruptRuns`), and so does the Agent's leaving the run's group (group-leave.ts `endRunsInGroup`);
 * nothing is noted while the Agent is paused or out of that group, so what is noted on an interrupted run came after the
 * resume, and is answered. A run that ended `agent_removed` (its Agent is no longer a member of the run's group, however
 * that was found) is followed by nothing: what was noted on it is dropped (`droppedOnEnd`). Whether it is queued, as
 * whose, and how it meets the owner's replies a minute is `followUp`'s.
 */
function followUpSeq(state: EndingRun, agent: AgentRow, end: RunEnd): number | null {
  if (droppedOnEnd(end)) return null;
  const covers = Number(state.covers_seq ?? 0);
  const pending = Number(state.pending_seq ?? 0);
  return pending > covers && !agent.paused && !agent.deleted && agent.model !== null ? pending : null;
}

/** What `followUpOnEnd` reads of a run that ends, as its row was before it was rewritten. */
export interface EndingRun {
  covers_seq: string | null;
  pending_seq: string | null;
  /** A reply `告诉他们` queued (`whisper_id` set). */
  told: boolean;
  greets: boolean;
}

/**
 * THE one place that decides, for every way a run ends, whether a follow-up answers what was noted on it — a running run:
 * `finish` (an answer, a failure, a stop) and `recoverRun` (start-up recovery, the release at a stop or shutdown, the
 * stale-run sweep), both port-impl.ts; a queued one: its owner's stop (`stopRun`) and a halt (`haltAgents`). A queued run
 * holds something noted only when an admission held it back (port-impl.ts `HELD_BACK`: what it took on at its start is
 * handed back as noted, and what was noted while it ran stays so) or when it is a told reply. The queued run's other
 * endings need no follow-up: a pause or delete (`interruptRuns`) drops what was noted, as on its running runs, for an
 * Agent that can answer nothing; what the resume ends (`endWhatPauseMissed`) never ran, so nothing was noted on it; a
 * greeting that gives way (`maybeTrigger`) gives way to the owner's newer message, whose own run covers everything noted
 * on it; leaving a group (group-leave.ts) drops it (`droppedOnEnd`). Never when the system scheduled its automatic
 * retry (that covers what was noted: `retried`); a failed run the service lost (`recovered`) is not followed up, its
 * owner's 重试 answers everything (spec 6.5) — except a told reply and a new Agent's greeting, which answer no message of
 * the owner's, so what was noted on them always gets its own reply (a greeting's quiet end never hides a question;
 * README "Replies", Automatic retry, table 2); otherwise the one rule, `followUpSeq`.
 */
export function followUpOnEnd(state: EndingRun, agent: AgentRow, end: RunEnd, how: { recovered: boolean; retried: boolean }): number | null {
  if (how.retried) return null;
  if (how.recovered && end.status === "failed" && !state.told && !state.greets) return null;
  return followUpSeq(state, agent, end);
}

/** A run that ends so is followed by nothing, and what was noted on it (`pending_seq`) is cleared as it ends. */
export const droppedOnEnd = (end: RunEnd): boolean => end.status === "cancelled" && end.error === "agent_removed";

/** The latest an automatic retry may start after its original call was made (README "Agents and runs", Automatic retry). */
export const AUTO_RETRY_WINDOW_MS = 600_000;

/**
 * Whether a run that ended `end` failed for a reason that clears by itself: tagged so by THE classifier
 * (runtime/port.ts `passingEnding`, through `failedEnd`) — only an explicit signal (the upstream's 5xx, 408, 429; a call
 * error, a cut stream or the reply's time out before anything was said; the service losing the run mid-call). The system
 * may then try it again by itself (`scheduleAutoRetry`).
 */
export const transientFailure = (end: { status: string; transient?: true }): boolean => end.status === "failed" && end.transient === true;

/** What a run that just ended had covered and had noted, read before its own row was rewritten: what its retry answers. */
export interface EndedRun {
  covers_seq: string | null;
  pending_seq: string | null;
  call_seqs: string[] | null;
}

/**
 * What `scheduleAutoRetry` did: queued the retry (to push to its owner alone); found it could not because the original call
 * has had its attempts, the retry would start more than `AUTO_RETRY_WINDOW_MS` after it, or the owner's replies a minute
 * in its lane are spent (`gaveUp`, counted); or (null) found the run is not one the system tries again.
 */
export type AutoRetry = { retry: Announced; attempt: number } | { gaveUp: "attempts" | "window" | "rate_limited" } | null;

/**
 * The automatic retry of reply run `runId` of `agent` in `conversationId`, which has just failed for a reason that clears
 * by itself (`transientFailure`; the caller checks it), in the transaction that recorded that — `finish` or recovery
 * (port-impl.ts), holding the run's conversation row, the Agent's and the run's, its owner's `accounts` row taken last
 * (the lock order). Not for (README "Replies", Automatic retry, the table): a reply nobody asked for (lane `proactive`:
 * the moment for an unasked remark has passed); a told reply (`告诉他们`: its owner has just pressed it, and its whisper's
 * own rule offers 重试 — what was noted on it goes to its ordinary follow-up at once, round 2 N-3); a new Agent's greeting;
 * the owner's own 重试 (`owner_retry`: the owner is there); an Agent paused, deleted or without a model; none at all while
 * `AGENTS.autoRetryDelaysMs` is empty. Each original call is tried again at most once per wait in that list
 * (`auto_attempt`, carried on the chain, `retry_of`), the n-th retry `delays[n-1]` after this end (by the port's clock,
 * `now`), and never one scheduled to start more than `AUTO_RETRY_WINDOW_MS` after the original call was made (nor started
 * later: port-impl.ts `begin`); the owner's replies a minute in the run's lane are met as for any reply queued
 * (`overLaneLimit`). The retry is an ordinary queued reply that is not claimed before its `not_before` (port-impl.ts
 * `claimNext`) and is admitted as any (`begin`: pause, membership, blocks, budgets, money) — and it answers the same calls:
 * what the failed run covered and what was noted on it (the greater of the two), its calls, askers, whose message called
 * and in which lane by whom (a member's call stays the member's). Being queued, it holds the Agent's one active run there:
 * whatever calls it meanwhile is folded into it, and the owner's 重试 is `busy_run`.
 */
export async function scheduleAutoRetry(
  t: Tx,
  runId: string,
  agent: AgentRow,
  conversationId: string,
  ended: EndedRun,
  now: Date,
  config: RunLimits & Pick<Config, "agents" | "whispers">,
): Promise<AutoRetry> {
  const delays = config.agents.autoRetryDelaysMs;
  if (delays.length === 0 || agent.deleted || agent.paused || agent.model === null) return null;
  const { rows } = await t.query<{
    purpose: string;
    lane: Lane;
    caller_id: string | null;
    triggered_by: TriggeredBy;
    asker_ids: string[] | null;
    whisper_id: string | null;
    greets: boolean;
    owner_retry: boolean;
    auto_attempt: number;
    original: string;
    original_at: Date;
  }>(
    `select r.purpose, r.lane, r.caller_id, r.triggered_by, r.asker_ids, r.whisper_id, r.greets, r.owner_retry, r.auto_attempt,
            coalesce(r.retry_of, r.id) as original, coalesce(o.created_at, r.created_at) as original_at
       from agent_runs r left join agent_runs o on o.id = r.retry_of
      where r.id = $1 and r.agent_id = $2 and r.conversation_id = $3`,
    [runId, agent.id, conversationId],
  );
  const run = rows[0];
  if (!run || run.purpose !== "reply" || run.lane === "proactive" || run.whisper_id !== null || run.greets || run.owner_retry) return null;
  const attempt = run.auto_attempt + 1;
  if (attempt > delays.length) return { gaveUp: "attempts" };
  const notBefore = new Date(now.getTime() + delays[attempt - 1]!);
  if (notBefore.getTime() - run.original_at.getTime() > AUTO_RETRY_WINDOW_MS) return { gaveUp: "window" };
  // Something else holds the Agent's one active run there already: it answers whatever comes; nothing is queued beside it.
  const active = await t.query("select 1 from agent_runs where agent_id = $1 and conversation_id = $2 and status in ('queued', 'running') limit 1", [agent.id, conversationId]);
  if (active.rowCount !== 0) return null;
  if (await overLaneLimit(t, agent.ownerId, run.lane, config)) return { gaveUp: "rate_limited" };
  const covers = Number(ended.covers_seq ?? 0);
  const pending = Number(ended.pending_seq ?? 0);
  const queued = await t.query<RunRow>(
    `insert into agent_runs as r (purpose, conversation_id, agent_id, owner_id, status, covers_seq, pending_seq, triggered_by, caller_id, lane,
                                  asker_ids, call_seqs, whisper_id, greets, retry_of, auto_attempt, not_before)
     values ('reply', $1, $2, $3, 'queued', $4, null, $5, $6, $7, $8, $9::bigint[], null, false, $10, $11, $12) returning ${RUN_COLUMNS}`,
    [
      conversationId,
      agent.id,
      agent.ownerId,
      Math.max(covers, pending),
      run.triggered_by,
      run.caller_id,
      run.lane,
      run.asker_ids,
      ended.call_seqs === null ? null : ended.call_seqs.map(Number),
      run.original,
      attempt,
      notBefore,
    ],
  );
  return { retry: { ownerId: agent.ownerId, conversationId, run: toWireRun(queued.rows[0]!) }, attempt };
}

/**
 * `告诉他们` on a `found_elsewhere` whisper (Task 8; whispers/routes.ts `ANSWER_HOOKS`), in the answer's transaction — the
 * group's row, the Agent's (for update) and the whisper's held, its state found open (nothing is written to it: this run is
 * what makes it telling, and its posted reply what makes it told — Redesign D): ONE reply of the Agent in the group,
 * queued as its owner's own (`triggered_by` human, lane `own`, the owner its caller and the one it answers), covering the
 * group's latest message but answering no call (`call_seqs` empty: they will hold the calls noted on it, `reachAgents`),
 * that is shown the whisper's hits (`agent_runs.whisper_id`, read in port-impl.ts `begin`) and
 * offered no tools — none when the whisper holds no hits (nothing to tell: null). Held to what a retry by its owner is
 * held to (`retryInGroup`): 409 `agent_paused`, 400
 * `invalid_request` when it has no model, 409 `busy_run` while it has a reply queued or running there, 429 `rate_limited`
 * over the owner's own replies a minute — each thrown, so the answer is rolled back and the whisper is open as before, to
 * answer again. (Its group gone, or the owner or the Agent no longer in it, or the Agent deleted: the answer is 404 before this,
 * whispers/store.ts `resolveWhisper`.) Lock order: the group's row and the Agent's (already held) → run rows → the owner's
 * `accounts` row.
 */
export async function tellFromWhisper(
  t: Tx,
  whisper: { id: string; conversationId: string; ownerId: string; agentId: string; body: { detail?: unknown } },
  config: RunLimits,
): Promise<Announced | null> {
  const hits = (whisper.body.detail as { hits?: unknown } | null | undefined)?.hits;
  if (!Array.isArray(hits) || hits.length === 0) return null;
  const agent = await lockAgent(t, whisper.agentId, whisper.conversationId);
  if (agent.paused) throw new AppError(409, "agent_paused");
  if (agent.model === null) throw new AppError(400, "invalid_request");
  const active = await t.query("select 1 from agent_runs where agent_id = $1 and conversation_id = $2 and status in ('queued', 'running') limit 1", [
    agent.id,
    whisper.conversationId,
  ]);
  if (active.rowCount !== 0) throw new AppError(409, "busy_run");
  if (await overLaneLimit(t, whisper.ownerId, "own", config)) throw new AppError(429, "rate_limited");
  const latest = await t.query<{ seq: string }>("select seq::text from conversations where id = $1", [whisper.conversationId]);
  const owner = callerOf(whisper.ownerId, whisper.ownerId);
  const queued = await queueRun(t, agent, whisper.conversationId, Number(latest.rows[0]!.seq), "human", owner, [whisper.ownerId]);
  // It answers no call: what it covers is no call of it, and its `call_seqs` will hold the calls noted on it, nothing else.
  await t.query("update agent_runs set whisper_id = $2, call_seqs = '{}' where id = $1", [queued.run.id, whisper.id]);
  return queued;
}

/**
 * `POST …/runs/retry`: a new queued reply answering up to the owner's last message, only when the conversation's
 * latest run failed. 404 unless it is the caller's Agent conversation; 409 `agent_deleted` / `agent_paused`; 409
 * `busy_run` while a reply is queued or running; 400 when the latest run did not fail (or there is none) or the Agent
 * has no model; 409 `model_gone` while its model is not there to call (`retryable`'s rule); 429 over the owner's own
 * `agentRunsPerMinute`. In a group, for the Agent `agentId` names
 * (`retryInGroup`); elsewhere `agentId` plays no part. A retry is its owner's call: the owner's own (`lane` `own`),
 * wherever it is, held to their own lane's limit.
 */
export async function retryRun(
  t: Tx,
  ownerId: string,
  conversationId: string,
  agentId: string | undefined,
  config: RunLimits & Pick<Config, "siteModels" | "whispers">,
): Promise<Announced> {
  const place = await runSitePlace(t, conversationId);
  // A social conversation's run is retried by no one: the visitor asks again by writing again.
  if (place === "social") throw notFound();
  if (place === "group") return retryInGroup(t, ownerId, conversationId, agentId, config);
  const ownAgentId = await ownedAgentOf(t, ownerId, conversationId);
  if (!ownAgentId) throw notFound();
  const agent = await lockAgent(t, ownAgentId, conversationId);
  if (agent.deleted) throw new AppError(409, "agent_deleted");
  if (agent.paused) throw new AppError(409, "agent_paused");
  const latest = await latestRun(t, conversationId);
  if (latest?.status === "queued" || latest?.status === "running") throw new AppError(409, "busy_run");
  if (latest?.status !== "failed" || agent.model === null) throw new AppError(400, "invalid_request");
  if (!(await modelUsable(t, config, agent))) throw new AppError(409, "model_gone");
  if (await overLaneLimit(t, ownerId, "own", config)) throw new AppError(429, "rate_limited");
  const last = await t.query<{ seq: string | null }>(
    "select max(seq)::text as seq from messages where conversation_id = $1 and sender_id = $2 and kind <> 'system'",
    [conversationId, ownerId],
  );
  if (last.rows[0]?.seq == null) throw new AppError(400, "invalid_request");
  const queued = await queueRun(t, agent, conversationId, Number(last.rows[0].seq), "human", callerOf(ownerId, ownerId), [ownerId]);
  await ownersRetry(t, queued.run.id);
  return queued;
}

/**
 * Retry in a group (wire contract "Run state"): the owner's Agent's latest run there, when it failed in the Agent's
 * current stay, is answered again — a new queued run covering what it covered and what was noted on it (the greater of
 * its `covers_seq` and `pending_seq`: a run recovery or a release failed is not followed up), called for by whoever
 * called the failed one (`triggered_by` kept: one an Agent's message called for is still an Agent's, so a member's
 * halt still ends it), and its owner's own whoever's the failed one was (its owner asked again) — answering the same
 * questions as the failed one, so whose they were is kept too (`asker_ids`: the retry asks nothing new), and so are the
 * calls (`call_seqs`), and a told reply's whisper (`whisper_id`: it tells again what it covered only; what was noted on it
 * was followed up as it ended). Not for an Agent that
 * is not in the group now, nor for a run from before it last joined; a run a halt or the Agent's leaving cancelled
 * (`halted`, `agent_removed`) did not fail: 400 like any other; 409 `model_gone` as `retryRun`; 429 over the owner's own
 * `agentRunsPerMinute`. Lock order: the group's row → the Agent's → run rows → the owner's `accounts` row.
 */
async function retryInGroup(
  t: Tx,
  ownerId: string,
  conversationId: string,
  agentId: string | undefined,
  config: RunLimits & Pick<Config, "siteModels" | "whispers">,
): Promise<Announced> {
  const own = await ownAgentInGroup(t, ownerId, conversationId, agentId);
  const joinedSeq = own.joinedSeq;
  const agent = await lockAgent(t, own.agentId, conversationId);
  if (agent.deleted) throw new AppError(409, "agent_deleted");
  if (agent.paused) throw new AppError(409, "agent_paused");
  const latest = await latestRunOf(t, agent.id, conversationId);
  if (latest?.status === "queued" || latest?.status === "running") throw new AppError(409, "busy_run");
  const covers = latest?.covers == null ? null : Number(latest.covers);
  if (latest?.status !== "failed" || agent.model === null || joinedSeq === null || covers === null || covers <= joinedSeq) {
    throw new AppError(400, "invalid_request");
  }
  if (!(await modelUsable(t, config, agent))) throw new AppError(409, "model_gone");
  // A told reply tells again only a whisper that reads open (whispers/store.ts `mayTell`, the one rule a press and a told
  // reply's beginning keep too): declined and expired are final. Under the group's row and the Agent's, held.
  if (latest.whisper_id !== null && !(await mayTell(t, { id: latest.whisper_id, ownerId }, { ttlHours: config.whispers.elsewhereTtlHours })).may) {
    throw new AppError(409, "stale_whisper");
  }
  if (await overLaneLimit(t, ownerId, "own", config)) throw new AppError(429, "rate_limited");
  if (latest.whisper_id === null) {
    const queued = await queueRun(t, agent, conversationId, Number(latest.answers), latest.triggered_by, callerOf(ownerId, ownerId), latest.asker_ids);
    await answersCalls(t, queued.run.id, (latest.calls ?? [latest.covers]).map(Number));
    await ownersRetry(t, queued.run.id);
    return queued;
  }
  // A told reply (`告诉他们`, Task 8) is told again: the retry keeps its whisper, so it is shown the hits and offered no tools,
  // covers what it covered and answers no call. What was noted on it went to a follow-up as it ended (port-impl.ts
  // `keepsNothingNoted`, round 2 N-3), so it carries nothing noted — but for a row that ended before that, whose noted calls
  // (up to its `pending_seq`, in its `call_seqs`) stay noted, for the retry's follow-up to answer.
  const queued = await queueRun(t, agent, conversationId, covers, latest.triggered_by, callerOf(ownerId, ownerId), latest.asker_ids);
  const answers = Number(latest.answers);
  await t.query("update agent_runs set whisper_id = $2, call_seqs = $3::bigint[], pending_seq = $4, owner_retry = true where id = $1", [
    queued.run.id,
    latest.whisper_id,
    (latest.calls ?? []).map(Number),
    answers > covers ? answers : null,
  ]);
  return queued;
}

/**
 * That run `runId` is its owner's own 重试 (`owner_retry`): the owner is there, so the system never tries it again by
 * itself (`scheduleAutoRetry`) — what bounds the attempts of one call across a manual 重试.
 */
async function ownersRetry(t: Tx, runId: string): Promise<void> {
  await t.query("update agent_runs set owner_retry = true where id = $1", [runId]);
}

/**
 * `POST …/runs/:runId/stop`: a queued run is stopped at once (it never reached a model: nothing to settle); a running
 * one is reported, so the caller can flag it for the worker working on it, or release it when nobody here is; a
 * finished one is left as it is. 404 unless the run is of the caller's Agent conversation — or, in a group the caller is
 * a current member of (whose row is locked first, `lockForWrite`, as every writer of runs there does), one of the
 * caller's Agents' runs there: another member's Agent's run is the 404 of a run that does not exist.
 */
export async function stopRun(
  t: Tx,
  ownerId: string,
  conversationId: string,
  runId: string,
  config: RunLimits,
): Promise<{ stopped: Announced | null; running: boolean; followed: FollowUp }> {
  // A group or a social conversation: the owner is a current member there (an observer in a social one), under its row.
  if ((await runSitePlace(t, conversationId)) !== "own") await lockForWrite(t, conversationId, ownerId);
  else if (!(await ownedAgentOf(t, ownerId, conversationId))) throw notFound();
  // The run's Agent row before the run's (the lock order): the stop of a queued run may follow up what was noted on it.
  const peek = (await t.query<{ agent_id: string }>("select agent_id from agent_runs where id = $1 and conversation_id = $2 and owner_id = $3 and purpose = 'reply'", [runId, conversationId, ownerId])).rows[0];
  if (!peek) throw notFound();
  const agent = await lockAgent(t, peek.agent_id, conversationId);
  const { rows } = await t.query<{ status: RunStatus; covers: string | null; pending: string | null; calls: string[] | null; told: boolean; greets: boolean }>(
    "select status, covers_seq::text as covers, pending_seq::text as pending, call_seqs::text[] as calls, whisper_id is not null as told, greets from agent_runs where id = $1 and conversation_id = $2 and owner_id = $3 and purpose = 'reply' for update",
    [runId, conversationId, ownerId],
  );
  const status = rows[0]?.status;
  if (status === undefined) throw notFound();
  if (status === "running") {
    // Kept in the row (`stop_asked`): an attempt that begins after this — the same, or the next after its admission held
    // it back — ends stopped (port-impl.ts `halted`), whatever this process's flags say.
    await t.query("update agent_runs set stop_asked = true where id = $1", [runId]);
    return { stopped: null, running: true, followed: followUpOf(null) };
  }
  if (status !== "queued") return { stopped: null, running: false, followed: followUpOf(null) };
  const stopped = await t.query<RunRow>(
    `update agent_runs as r set status = 'stopped', finished_at = now(),
            pending_seq = case when r.whisper_id is null then r.pending_seq end, call_seqs = case when r.whisper_id is null then r.call_seqs else '{}' end
      where r.id = $1 returning ${RUN_COLUMNS}`,
    [runId],
  );
  const ended = { ownerId, conversationId, run: toWireRun(stopped.rows[0]!) };
  // What was noted on it gets its follow-up by the one rule, as for a run stopped while it ran (`followUpOnEnd`): what
  // an admission that held it back handed back to it (round 3 S-4) — or, for a told reply (`告诉他们`), the members'
  // questions noted on it: the stop ends the tell — its whisper reads open again, nothing written to it
  // (whispers/store.ts) — but not those, which get their ordinary follow-up at once (port-impl.ts `keepsNothingNoted`).
  const row = rows[0]!;
  const next = followUpOnEnd({ covers_seq: row.covers, pending_seq: row.pending, told: row.told, greets: row.greets }, agent, { status: "stopped" }, { recovered: false, retried: false });
  const followed = next === null ? followUpOf(null) : await followUp(t, agent, conversationId, Number(row.covers ?? 0), next, row.calls, config);
  return { stopped: ended, running: false, followed };
}

/** A failure its owner dismissed in a group: the others are told its Agent's state again (`Hub.pushRunState`). */
export interface Dismissed {
  conversationId: string;
  runId: string;
}

/**
 * `POST …/runs/dismiss`: the latest run, if it failed, is no longer shown by `GET …/run`. 404 unless the caller's. In a
 * group (`agentId` required; `ownAgentInGroup`): the latest run of that Agent there, also when the Agent has left the
 * group since; returns it when this dismissed it, so the other members can be told. Elsewhere `agentId` plays no part.
 */
export async function dismissRun(t: Tx, ownerId: string, conversationId: string, agentId: string | undefined): Promise<Dismissed | null> {
  if ((await runSitePlace(t, conversationId)) !== "own") {
    const own = await ownAgentInGroup(t, ownerId, conversationId, agentId);
    const { rows } = await t.query<{ id: string }>(
      `update agent_runs set dismissed_at = now()
        where id = (select id from agent_runs where agent_id = $1 and conversation_id = $2 and purpose = 'reply' order by created_at desc, id desc limit 1)
          and status = 'failed' and dismissed_at is null
        returning id`,
      [own.agentId, conversationId],
    );
    return rows[0] ? { conversationId, runId: rows[0].id } : null;
  }
  if (!(await ownedAgentOf(t, ownerId, conversationId))) throw notFound();
  await t.query(
    `update agent_runs set dismissed_at = now()
      where id = (select id from agent_runs where conversation_id = $1 order by created_at desc, id desc limit 1)
        and status = 'failed' and dismissed_at is null`,
    [conversationId],
  );
  return null;
}
