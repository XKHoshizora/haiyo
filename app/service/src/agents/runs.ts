import type { FastifyBaseLogger } from "fastify";
import { z } from "zod";
import { formatPoints, lockAccount, siteDayStart } from "../accounts/store.ts";
import type { Config } from "../config.ts";
import { currentMembership, lockForWrite, peekConversation, type ConversationType, type WriteLock } from "../conversations/store.ts";
import { appendSystem } from "../conversations/system.ts";
import type { Queryable, Tx } from "../db.ts";
import { AppError, notFound } from "../errors.ts";
import { notAcknowledgement, type StoredMessage, type SystemEvent } from "../messages/model.ts";
import { postingRun } from "../messages/read.ts";
import { othersLimitOf, othersReached } from "../metering/others.ts";
import { reach } from "../social/reach.ts";
import { refusedInGroup } from "./refusal.ts";
import { groupPlaceSql, placeOf, placeOfType, socialPlaceSql, type Place } from "../social/place.ts";
import { modelsUsable, modelUsable } from "../models/resolve.ts";
import type { RunEnd } from "./runtime/port.ts";
import { agentModelOf, lockAgent, type AgentRow } from "./store.ts";
import { mayTell, tellableRuns } from "../whispers/store.ts";

/**
 * Reply runs (`agent_runs` rows of purpose `reply`) as the routes and the send path see them: the trigger, retry, stop,
 * dismiss, the latest run of a conversation, and what a group's members may know of its Agents' replies (`groupRuns`,
 * `runAudience`: the owner the run, everyone else its state). The worker's side is `port-impl.ts`. A run belongs to
 * one conversation (`conversation_id`), and everything here acts on that one: an Agent has at most one queued or
 * running run per conversation (a "pair"), whose lane and caller are fixed as its row is made and never change; a call on a
 * pair with an active run waits in `deferred_calls` (migration 078) until that run ends (`acceptCall`, `takeDeferred`). In a group
 * a message calls the Agents its stored mentions mean (`messages.mentions`, decided once when it was sent:
 * mentions.ts; `triggerInGroup`, `triggerFromAgent`), under brakes on Agents calling Agents
 * (the chain limit, the halt, the chain budget) and, on what other people's calls spend of an owner's points, the
 * owner's one number for others' use (`refusedByOthersLimit`). Lock order everywhere: the run's conversation row → `agents` rows
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
 * the owner's one number for others' use and the site's time zone, whose day it is counted in (`refusedByOthersLimit`); and the
 * site's models, by which someone else's call on an Agent whose model is gone is refused as it is made (`reachAgents`).
 */
export type RunLimits = Pick<
  Config,
  "agentRunsPerMinute" | "agentOthersRunsPerMinute" | "agentCallerRunsPerMinute" | "siteTimezone" | "siteModels" | "others" | "social"
>;

/**
 * Of `agent_runs`: a reply started in the last minute — not one a limit refused (`rate_limited`), which started nothing
 * (`startedLastMinute`, `calledLastMinute`). Nor a reply the owner's interjection cancelled before it reached a model (`owner_spoke`,
 * never admitted): a visitor cannot make it, and it called nothing; one admitted first called the model and counts.
 */
const STARTED_LAST_MINUTE = "purpose = 'reply' and created_at > now() - interval '1 minute' and error is distinct from 'rate_limited' and (error is distinct from 'owner_spoke' or admitted_at is not null)";

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
 * not counted. Others' calls waiting for a reply under way (`deferred_calls`) count in the others' lane as they are accepted
 * (`accepted_at`); the owner's own waiting calls do not, as the owner's own calls folded into a reply never did.
 */
async function startedLastMinute(t: Tx, ownerId: string, own: boolean, waiting = true): Promise<number> {
  await lockAccount(t, ownerId);
  const { rows } = await t.query<{ n: number }>(
    `select (select count(*) from agent_runs where owner_id = $1 and (lane = 'own') = $2 and ${OWNER_STARTED_LAST_MINUTE})::int
          + (case when $2 or not $3 then 0 else (select count(*) from deferred_calls where owner_id = $1 and lane = 'others' and accepted_at > now() - interval '1 minute') end)::int as n`,
    [ownerId, own, waiting],
  );
  return rows[0]!.n;
}

/**
 * Whether `ownerId` has started their replies a minute in `lane` (`startedLastMinute`): over it, a reply is refused. A
 * reply nobody called for (`proactive`) is held to the others' minute, as a call by someone else is
 * (agents/proactive/decide.ts). `waiting` false: only the replies started count, not the calls that wait — what an automatic
 * retry is held to (`scheduleAutoRetry`), so the calls waiting behind it never cost it its slot (invariant 5; T2 fix 1, F5b).
 */
export async function overLaneLimit(t: Tx, ownerId: string, lane: Lane, config: RunLimits, { waiting = true }: { waiting?: boolean } = {}): Promise<boolean> {
  const own = lane === "own";
  return (await startedLastMinute(t, ownerId, own, waiting)) >= (own ? config.agentRunsPerMinute : config.agentOthersRunsPerMinute);
}

/**
 * Locks the `accounts` rows of `ids` — owners', callers' — in ascending id, each once: the one order every transaction that locks
 * more than one account keeps (the lock order's last step), so two of them never wait on each other. A row held already is a no-op.
 */
async function lockAccounts(t: Tx, ids: Iterable<string>): Promise<void> {
  for (const id of [...new Set(ids)].sort()) await lockAccount(t, id);
}

/**
 * Calls person `callerId` has made in the last minute on other people's Agents (`agentCallerRunsPerMinute`),
 * themselves or through an Agent's message they are behind (`behindAgentMessage`: their own Agents', or another's
 * relaying their call), whoever's Agents they were: the replies they are the caller of that are not
 * their owner's own (so a call on one of their own Agents never counts), and their calls waiting for a reply under way
 * (`deferred_calls`, each by its `accepted_at`: a call that waits is counted as it is accepted). A run an owner's limit refused
 * (`rate_limited`) started nothing and is not counted; nor is a mention folded into a reply not claimed yet, which starts
 * none. Counted under the caller's `accounts` row lock (`reachAgents` takes it with the owners', in id order), so two
 * calls the same person makes at once are counted one after the other.
 */
async function calledLastMinute(t: Tx, callerId: string): Promise<number> {
  await lockAccount(t, callerId);
  const { rows } = await t.query<{ n: number }>(
    `select (select count(*) from agent_runs where caller_id = $1 and lane <> 'own' and ${STARTED_LAST_MINUTE})::int
          + (select count(*) from deferred_calls where caller_id = $1 and lane = 'others' and accepted_at > now() - interval '1 minute')::int as n`,
    [callerId],
  );
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
 * A reply's identity (limits redesign, Part 2): its lane and who called for it (`agent_runs.lane`, `caller_id`), decided ONCE, as the
 * call that makes its row is accepted, and never changed by anything after — a call folded into it, a refusal, a retry, an ending
 * of access, a crash. `caller_id`: the person behind the call, an Agent's call being that of the person behind its message
 * (`behindAgentMessage`); nobody for what is relayed from a reply nobody called for, and for a reply nobody asked for
 * (`proactive`). The owner's own (`own`, the owner its caller): the owner's own message or an Agent's message the owner is behind,
 * every reply in the Agent's own conversation, a tell, a greeting, and the owner's 重试 — the one deliberate case of a member's
 * question answered on the owner's terms: the owner asked again. A call of another identity on a pair with a reply under way waits
 * (`deferred_calls`) and is answered by a reply of its own (`takeDeferred`), never folded into that one.
 */
export type Caller = { id: string | null; lane: Lane };

/**
 * The call person `personId` makes on an Agent of `ownerId`'s: the owner's own, or someone else's. Nobody (`null`: a
 * call relayed from a reply nobody called for) is someone else: `others`, with no caller.
 */
export function callerOf(ownerId: string, personId: string | null): Caller {
  return { id: personId, lane: personId === ownerId ? "own" : "others" };
}

/** Whether two identities are one (`Caller`): the same lane and the same caller (nobody being nobody). */
const sameIdentity = (a: Caller, b: Caller): boolean => a.lane === b.lane && a.id === b.id;

/**
 * The person behind an Agent's message — whose call it is on the Agents it names: the caller of the run that posted it
 * (`postedBy`, that run's caller and lane) when that run is not its owner's own — so a member's call relayed through the
 * owner's Agent stays the member's, and what a reply nobody called for relays is nobody's (`null`) — otherwise (the run
 * is its owner's own, or no run posted the message) the Agent's owner. `behindMessageSql` reads the same rule from the stored
 * messages (the posting run is the one the message's `client_txn` names). A block, either way, between that person and
 * a named Agent's owner keeps the call off that Agent (`triggerFromAgent`, `takeDeferred`), as between the two owners.
 */
export function behindAgentMessage(ownerId: string, postedBy: Caller | null): string | null {
  return postedBy !== null && postedBy.lane !== "own" ? postedBy.id : ownerId;
}

/**
 * `behindAgentMessage`'s twin in SQL, for a query that reads many messages at once (`callRowsSql`; a test holds the two to
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
 * even if the Agent is resumed before the worker notices — and every call waiting for the Agent (`deferred_calls`, every
 * conversation) is dropped: nothing written before the pause is answered. A call that waits from now on came after a resume
 * (nothing waits while the Agent is paused; what an Agent's message in a group writes for it as the pause commits, which this
 * cannot see, the resume drops: `endWhatPauseMissed`) and is answered as usual (`takeDeferred`). Returns the cancelled runs to
 * announce, each with its own conversation, and the running ones to stop.
 */
export async function interruptRuns(
  t: Tx,
  agent: AgentRow,
  reason: "agent_paused" | "agent_deleted",
): Promise<{ cancelled: Announced[]; running: string[] }> {
  // Nothing follows these: an Agent paused or deleted answers nothing.
  await lockActiveRuns(t, "r.agent_id = $1", [agent.id]);
  const queued = await t.query<RunRow & { conversation_id: string }>(
    `update agent_runs as r set status = 'cancelled', error = $2, finished_at = now()
      where r.agent_id = $1 and r.status = 'queued' returning ${RUN_COLUMNS}, r.conversation_id`,
    [agent.id, reason],
  );
  const running = await t.query<{ id: string }>("update agent_runs set interrupted = $2 where agent_id = $1 and status = 'running' returning id", [agent.id, reason]);
  await dropDeferred(t, { agentId: agent.id });
  return {
    cancelled: queued.rows.map((r) => ({ ownerId: agent.ownerId, conversationId: r.conversation_id, run: toWireRun(r) })),
    running: running.rows.map((r) => r.id),
  };
}

/**
 * In the resume's own transaction, which holds `lockAgent` and found the Agent paused: what the pause could not see
 * ends now, before the Agent can answer again. An Agent's message in a group reads the Agents it calls without locking
 * them (`triggerFromAgent`), so a pause that commits inside that message's transaction misses what it then writes — a
 * run it queues (none other can be queued while the Agent is paused: a person's mention, a retry, the next of the calls
 * waiting and recovery all refuse a paused Agent), and a call it leaves waiting behind a reply. So, in every
 * conversation: a queued run of the Agent is `cancelled` `agent_paused` (it never reached a model), and so is one the
 * worker claimed meanwhile (it does not look at the pause): every running run not marked yet is marked `interrupted`
 * `agent_paused`, as the pause marked the others, and every call waiting for the Agent is dropped (`dropDeferred`). Returns,
 * as `interruptRuns` does, the cancelled runs to announce and the newly marked ones to stop.
 */
export async function endWhatPauseMissed(t: Tx, agent: AgentRow): Promise<{ cancelled: Announced[]; running: string[] }> {
  await lockActiveRuns(t, "r.agent_id = $1", [agent.id]);
  const queued = await t.query<RunRow & { conversation_id: string }>(
    `update agent_runs as r set status = 'cancelled', error = 'agent_paused', finished_at = now()
      where r.agent_id = $1 and r.status = 'queued' returning ${RUN_COLUMNS}, r.conversation_id`,
    [agent.id],
  );
  const claimed = await t.query<{ id: string }>(
    "update agent_runs set interrupted = 'agent_paused' where agent_id = $1 and status = 'running' and interrupted is null returning id",
    [agent.id],
  );
  await dropDeferred(t, { agentId: agent.id });
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
 * What an Agent's message hands down as the askers of the calls it makes (Task 10b, fix rounds 2 and 3; limits redesign C-c): run
 * `runId`'s askers (`asker_ids`) and everyone who wrote in its group after seq `from` and up to `to` (`heardIn`: what came while it
 * ran, before its message — the reply it calls will be shown that stretch), each once; null (not known) when either is not known.
 * Read only: nothing is written to the posting run (its askers end with what it answered), and the calls that carry these record
 * them only where a target accepts the call (a run it queues, a call it leaves waiting: `reachAgents`).
 */
export async function askersHandedDown(q: Queryable, runId: string, from: number, to: number): Promise<Askers> {
  const { rows } = await q.query<{ askers: string[] | null }>(
    `select ${withAskers(null, heardIn("r.conversation_id", "$2::bigint", "$3::bigint"))} as askers from agent_runs r where r.id = $1`,
    [runId, from, to],
  );
  return rows[0]?.askers ?? null;
}

export { refusedInGroup };

/**
 * SQL: the calls run `$1` carries (`call_seqs`; its `covers_seq` when not known), one row each: `r` the run, `m` the call's message, `p`
 * its sender, `bh.caller_id` the person behind it (`behindMessageSql`: the sender, or for an Agent's message the caller of the run that
 * posted it). `columns` are spliced after `select`, `order` after the rows. THE reading of a run's calls: `dropRefusedCalls` and
 * `standingCalls` both ask it, and through them every ending of access in a group (social/agent-contacts.ts `endGroupCalls`).
 */
const callRowsSql = (columns: string, order = ""): string =>
  `select ${columns}
     from agent_runs r
     join messages m on m.conversation_id = r.conversation_id and m.seq = any(coalesce(r.call_seqs, array[r.covers_seq]))
     join principals p on p.id = m.sender_id
     left join agent_runs pr on p.kind = 'agent' and ${postingRun("m", "pr")}
     cross join lateral (select ${behindMessageSql("p", "pr")} as caller_id) bh
    where r.id = $1${order}`;

/** What is read of each call of a run (`callRowsSql` with `CALL_COLUMNS`), and of the run itself. */
interface CallRow {
  seq: string;
  kind: "human" | "agent";
  lane: Lane;
}
const CALL_COLUMNS = "m.seq::text as seq, p.kind, r.lane";

/**
 * SQL, true when the call of the message at seq `seq` (SQL) of run `run`'s conversation on its Agent has a refusal of a limit
 * recorded (`call_refusals`): such a call is in no assignment — no run, retry or 重试 answers it (limits redesign C-b).
 */
const limitRefusedSql = (run: string, seq: string): string =>
  `exists (select 1 from call_refusals cr where cr.conversation_id = ${run}.conversation_id and cr.seq = ${seq} and cr.agent_id = ${run}.agent_id)`;

/**
 * The calls of run `runId`'s assignment that are still to be answered: its `call_seqs` (its `covers_seq` when not known) less any a
 * limit refused (`limitRefusedSql`). What an automatic retry and the owner's 重试 of it answer (C-b).
 */
async function standingSeqs(q: Queryable, runId: string): Promise<number[] | null> {
  const { rows } = await q.query<{ seqs: string[] | null }>(
    `select case when r.call_seqs is null then null
                 else array(select s from unnest(r.call_seqs) as x (s) where not ${limitRefusedSql("r", "x.s")} order by s)::text[] end as seqs
       from agent_runs r where r.id = $1`,
    [runId],
  );
  const seqs = rows[0]?.seqs;
  return seqs === undefined || seqs === null ? null : seqs.map(Number);
}

/**
 * The rule a call meets when it is made (`triggerInGroup`, `triggerFromAgent`), met again by every call reply run `runId` answers
 * as it begins, before admission (reverse-paths audit A12; B5b): a call (`call_seqs`; its `covers_seq` when not known) whose person
 * `refusedInGroup` refuses now — the sender of a person's message; for an Agent's message that Agent as a subject and the person
 * behind it (`behindMessageSql`) — or whose call a limit refused since (`limitRefusedSql`, C-b) is dropped: it is no longer among
 * the calls the run answers, nobody refused is among its askers, and what the run covers ends at the latest call left (`covers_seq`).
 * A refusal removes a call from the assignment and NOTHING else: the run's lane and caller stay what they were made (limits
 * redesign, Part 2); whose message called (`triggered_by`) follows the calls left (a person's while one is left; a reply nobody
 * asked for keeps its own). Asked only of a reply not admitted yet: once a reply is admitted its calls are what it was made for
 * (port-impl.ts `begin`, step 3), and an ending of access in flight is `standingCalls`'. The owner's own call is never dropped
 * (`refusedInGroup` never refuses the owner). Returns what the run now covers and answers (empty when nothing was dropped: one query),
 * or null when no call is left: the run ends (`cancelled`, no error: see port-impl.ts `BLOCKED_SINCE`; `access_ended` is for social
 * runs).
 */
export async function dropRefusedCalls(t: Tx, runId: string): Promise<{ covers_seq?: string | null; call_seqs?: string[] | null } | null> {
  const { rows } = await t.query<CallRow & { refused: boolean }>(
    callRowsSql(
      `${CALL_COLUMNS},
            (${refusedInGroup("p.id", "r.agent_id")} or (bh.caller_id is not null and ${refusedInGroup("bh.caller_id", "r.agent_id")})
             or ${limitRefusedSql("r", "m.seq")}) as refused`,
      "\n      order by m.seq",
    ),
    [runId],
  );
  if (!rows.some((r) => r.refused)) return {};
  const left = rows.filter((r) => !r.refused);
  if (left.length === 0) return null;
  const { lane } = rows[0]!;
  const by: TriggeredBy | null = lane === "proactive" ? null : left.some((r) => r.kind === "human") ? "human" : "agent";
  const updated = await t.query<{ covers_seq: string | null; call_seqs: string[] | null }>(
    `update agent_runs set call_seqs = $2::bigint[], covers_seq = least(covers_seq, $3::bigint),
            asker_ids = case when asker_ids is null then null
                             else array(select x.a from unnest(asker_ids) as x (a) where not ${refusedInGroup("x.a", "agent_runs.agent_id")} order by x.a) end,
            triggered_by = coalesce($4::text, triggered_by)
      where id = $1 returning covers_seq::text as covers_seq, call_seqs::text[] as call_seqs`,
    [runId, left.map((r) => Number(r.seq)), Number(left.at(-1)!.seq), by],
  );
  return updated.rows[0]!;
}

/**
 * At post time (`postAsAgent`, under the run's conversation row and its Agent's): the same rule met once more by the calls the run
 * answers, for the window in which a person is refused after `begin` dropped what it dropped (an admitted run keeps its context; its
 * output can be filtered only now). `none`: it answers calls and every one is refused: nothing is to be posted. `refused`: the persons
 * refused now among all its calls' senders, the persons behind them and its askers: a reply that goes on for the others quotes none of
 * their messages and stores no mention of them (the text may still name them). Reads only. A run with no call of its own
 * (`告诉他们`'s) is never refused; the caller leaves those out.
 */
export async function standingCalls(t: Tx, runId: string): Promise<{ none: boolean; refused: ReadonlySet<string> }> {
  const { rows } = await t.query<{ sender: string; kind: "human" | "agent"; behind: string | null; sender_refused: boolean; behind_refused: boolean }>(
    callRowsSql(
      `p.id as sender, p.kind, bh.caller_id as behind,
            ${refusedInGroup("p.id", "r.agent_id")} as sender_refused,
            (bh.caller_id is not null and ${refusedInGroup("bh.caller_id", "r.agent_id")}) as behind_refused`,
    ),
    [runId],
  );
  const askers = await t.query<{ a: string }>(
    `select x.a from agent_runs r cross join lateral unnest(r.asker_ids) as x (a) where r.id = $1 and ${refusedInGroup("x.a", "r.agent_id")}`,
    [runId],
  );
  const refused = new Set<string>(askers.rows.map((r) => r.a));
  for (const r of rows) {
    if (r.sender_refused && r.kind === "human") refused.add(r.sender);
    if (r.behind_refused && r.behind !== null) refused.add(r.behind);
  }
  return { none: rows.length > 0 && rows.every((r) => r.sender_refused || r.behind_refused), refused };
}

/**
 * Whether a call run `runId` answers is one its Agent's owner WROTE: the run is the owner's own (`lane` `own`) and one of its calls is
 * a message the owner sent — not an Agent's message the owner was behind (a relay), and never a call of someone else's that the
 * owner's 重试 made the owner's own reply (its message is that person's). What lets the owner's typed words exempt a web query from
 * its guard (port-impl.ts `begin`, tools/web/tool.ts; review M6, review 5 item 7). Reads only.
 */
export async function ownerWroteACall(q: Queryable, runId: string): Promise<boolean> {
  const { rows } = await q.query<{ wrote: boolean }>(
    `select exists (
       select 1 from agent_runs r
         join messages m on m.conversation_id = r.conversation_id and m.seq = any(coalesce(r.call_seqs, array[r.covers_seq]))
        where r.id = $1 and r.lane = 'own' and m.seq <= r.covers_seq and m.sender_id = r.owner_id) as wrote`,
    [runId],
  );
  return rows[0]?.wrote === true;
}

/** The model of Agent `agentId` as its `agents` row says now (`agentModelOf`); null for none, or no such Agent. */
async function modelOfAgent(q: Queryable, agentId: string): Promise<AgentRow["model"]> {
  const { rows } = await q.query<Parameters<typeof agentModelOf>[0]>(
    "select model_source, site_model_id, provider_id, provider_model from agents where principal_id = $1",
    [agentId],
  );
  return rows[0] ? agentModelOf(rows[0]) : null;
}

/**
 * Queues a reply of the Agent in `conversationId` answering up to `coversSeq` (a seq of that conversation: the last call of its
 * assignment), called for by a person's message unless `triggeredBy` says an Agent's, with the identity `caller` (its lane and
 * caller, written here once and never again: `Caller`), answering `askers` (every caller says whose; null only where they cannot be
 * told) and the calls at `calls` (`call_seqs`: by default the one at `coversSeq`; an assignment of waiting calls names them all; a
 * tell and a greeting none; a reply nobody asked for the message it answers, which is no call of anyone's). Under that
 * conversation's row lock, which every writer of the Agent's runs there holds: the Agent has no active run there
 * (`agent_runs_one_active_per_agent_conversation` would refuse a second).
 */
export async function queueRun(
  t: Tx,
  agent: RunAgent,
  conversationId: string,
  coversSeq: number,
  triggeredBy: TriggeredBy,
  caller: Caller,
  askers: Askers,
  calls: readonly number[] = [coversSeq],
): Promise<Announced> {
  const { rows } = await t.query<RunRow>(
    `insert into agent_runs as r (purpose, conversation_id, agent_id, owner_id, status, covers_seq, triggered_by, caller_id, lane, asker_ids, call_seqs)
     values ('reply', $1, $2, $3, 'queued', $4, $5, $6, $7, $8, $9::bigint[]) returning ${RUN_COLUMNS}`,
    [conversationId, agent.id, agent.ownerId, coversSeq, triggeredBy, caller.id, caller.lane, askersParam(askers), [...calls]],
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
 * `recordRateLimited` in a group for the owner's own call (plan ruling 7): one such run per Agent there, not one per mention. When
 * the Agent's latest run in the group is a `rate_limited` failure of its owner's own (lane `own`, the owner its caller: the same
 * identity, the only one such a record is ever made for since limits T1) its owner has not dismissed, that run now covers `coversSeq`
 * too (and is announced again), answers `askers` and the call too (`withAskers`, `call_seqs`), and everyone who wrote in the stretch
 * it now covers besides (`heardIn`): its lane and caller stay. Otherwise a new one is recorded. So repeated mentions over the limit
 * show one line.
 */
async function rateLimitedInGroup(t: Tx, agent: RunAgent, conversationId: string, coversSeq: number, triggeredBy: TriggeredBy, caller: Caller, askers: Askers): Promise<Announced> {
  const latest = await t.query<{ id: string; reusable: boolean }>(
    `select id, (status = 'failed' and error is not distinct from 'rate_limited' and dismissed_at is null and lane = $3 and caller_id is not distinct from $4::uuid) as reusable
       from agent_runs where agent_id = $1 and conversation_id = $2 order by created_at desc, id desc limit 1`,
    [agent.id, conversationId, caller.lane, caller.id],
  );
  const row = latest.rows[0];
  if (caller.lane !== "own" || !row?.reusable) return recordRateLimited(t, agent, conversationId, coversSeq, triggeredBy, caller, askers, "rate_limited");
  const { rows } = await t.query<RunRow>(
    `update agent_runs as r
        set covers_seq = greatest(r.covers_seq, $2), finished_at = now(),
            triggered_by = case when $3 = 'human' then 'human' else r.triggered_by end,
            call_seqs = array(select distinct s from unnest(coalesce(r.call_seqs, array[r.covers_seq]) || $2::bigint) as x (s) order by s),
            asker_ids = ${withAskers("$4", heardIn("r.conversation_id", "r.covers_seq", "$2::bigint"))}
      where r.id = $1 returning ${RUN_COLUMNS}`,
    [row.id, coversSeq, triggeredBy, askersParam(askers)],
  );
  return { ownerId: agent.ownerId, conversationId, run: toWireRun(rows[0]!) };
}

/**
 * The most calls that may wait for one Agent in one conversation (`deferred_calls`): one more is refused, its sender told
 * `too_often` (internal, not a setting; limits redesign, Part 2).
 */
export const DEFERRED_PER_PAIR = 8;

/** A pair as `pairsOf` reads it: its active run, locked, and how many calls wait there. */
type Pair = { active: { id: string; foldable: boolean; caller: Caller } | null; waiting: number };

/**
 * Locks the active reply runs (queued or running) `where` names (`r`: `agent_runs`), `for update`, in ascending run id: THE order
 * every transaction keeps that locks more than one active run row at once (the lock order; T2 fix 1, F6) — a message calling several
 * Agents (`pairsOf`), a halt, a pause, a delete, a removal from a group, an interjection, an ending of access, the operator's disable —
 * so two of them never hold one each of two rows the other wants. Taken before such a transaction writes any of them.
 */
export async function lockActiveRuns(t: Tx, where: string, params: readonly unknown[]): Promise<void> {
  await t.query(`select 1 from agent_runs r where r.status in ('queued', 'running') and (${where}) order by r.id for update of r`, [...params]);
}

/**
 * The Agents' active runs in the conversation (queued or running; at most one each), locked (`for update`, after the conversation's
 * row, which the caller holds, and in ascending run id: `lockActiveRuns`' order), each with whether a call of its own identity may be
 * folded into it: a reply queued and never claimed (`held_back_by` none), that is no retry (an automatic one keeps its assignment;
 * the owner's 重试 is of one), no tell, no greeting and not a reply nobody asked for (each answers no call: zero-call runs, which a
 * call never joins). And how many calls wait for each Agent there (`deferred_calls`). The worker's claim skips a locked row, so what
 * this reads stays so until commit.
 */
async function pairsOf(t: Tx, agentIds: readonly string[], conversationId: string): Promise<Map<string, Pair>> {
  const { rows } = await t.query<{ id: string; agent_id: string; foldable: boolean; lane: Lane; caller_id: string | null }>(
    `select r.id, r.agent_id, r.lane, r.caller_id,
            (r.status = 'queued' and r.held_back_by is null and r.retry_of is null and not r.owner_retry and r.whisper_id is null and not r.greets
             and r.lane <> 'proactive') as foldable
       from agent_runs r where r.agent_id = any($1::uuid[]) and r.conversation_id = $2 and r.status in ('queued', 'running')
      order by r.id for update of r`,
    [[...agentIds], conversationId],
  );
  const waiting = await t.query<{ agent_id: string; n: number }>(
    "select agent_id, count(*)::int as n from deferred_calls where agent_id = any($1::uuid[]) and conversation_id = $2 group by agent_id",
    [[...agentIds], conversationId],
  );
  const pairs = new Map<string, Pair>();
  for (const id of agentIds) {
    const row = rows.find((r) => r.agent_id === id);
    pairs.set(id, { active: row ? { id: row.id, foldable: row.foldable, caller: { id: row.caller_id, lane: row.lane } } : null, waiting: waiting.rows.find((r) => r.agent_id === id)?.n ?? 0 });
  }
  return pairs;
}

/** `pairsOf` for one Agent. */
async function pairOf(t: Tx, agentId: string, conversationId: string): Promise<Pair> {
  return (await pairsOf(t, [agentId], conversationId)).get(agentId)!;
}

/**
 * A call at `seq` folded into the Agent's queued, never claimed run `runId` of its own identity (`pairOf`, nothing waiting there): it
 * now covers the call (`covers_seq`), answers it (`call_seqs`) and its askers, and everyone who wrote since what it covered up to the
 * call (`heardIn`); a person's message makes it a person's (`triggered_by`). Its lane and caller are those of the call already.
 * False when the run was claimed meanwhile (the caller then leaves the call waiting).
 */
async function foldInto(t: Tx, runId: string, seq: number, triggeredBy: TriggeredBy, askers: Askers): Promise<boolean> {
  const folded = await t.query(
    `update agent_runs as r
        set covers_seq = greatest(r.covers_seq, $2),
            call_seqs = array(select distinct s from unnest(coalesce(r.call_seqs, array[r.covers_seq]) || $2::bigint) as x (s) order by s),
            triggered_by = case when $3 = 'human' then 'human' else r.triggered_by end,
            asker_ids = ${withAskers("$4", heardIn("r.conversation_id", "r.covers_seq", "$2::bigint"))}
      where r.id = $1 and r.status = 'queued' and r.held_back_by is null`,
    [runId, seq, triggeredBy, askersParam(askers)],
  );
  return folded.rowCount === 1;
}

/**
 * The call at `seq` of `conversationId` on `agent` waits for the reply under way there (`deferred_calls`, accepted now): with its
 * identity (`by`, never `proactive`), whose message made it and whose questions it carries. Over `DEFERRED_PER_PAIR` calls waiting
 * it is refused instead (`too_often`, its sender told — for an Agent's relay, the person behind it: `recordRefusal`, into `told`):
 * false.
 */
async function deferCall(t: Tx, agent: RunAgent, conversationId: string, seq: number, triggeredBy: TriggeredBy, by: Caller, askers: Askers, waiting: number, told: Told): Promise<boolean> {
  if (waiting >= DEFERRED_PER_PAIR) {
    told.refused.push(...(await recordRefusal(t, conversationId, [seq], agent.id, "too_often", by.id)));
    return false;
  }
  await t.query(
    `insert into deferred_calls (agent_id, conversation_id, message_seq, owner_id, lane, caller_id, triggered_by, asker_ids)
     values ($1, $2, $3, $4, $5, $6, $7, $8::uuid[]) on conflict do nothing`,
    [agent.id, conversationId, seq, agent.ownerId, by.lane, by.id, triggeredBy, askersParam(askers)],
  );
  return true;
}

/**
 * Drops the calls waiting (`deferred_calls`) for Agent `agentId` (in every conversation), or for those Agents in `conversationId`
 * (`agentIds`, all of them when absent): its pause or delete, its leaving a group, the owner's interjection in a social
 * conversation. Nothing answers them; nobody is told (a refusal for access is quiet).
 */
export async function dropDeferred(t: Tx, scope: { agentId: string } | { conversationId: string; agentIds?: readonly string[] }): Promise<void> {
  if ("agentId" in scope) {
    await t.query("delete from deferred_calls where agent_id = $1", [scope.agentId]);
    return;
  }
  await t.query("delete from deferred_calls where conversation_id = $1 and ($2::uuid[] is null or agent_id = any($2::uuid[]))", [scope.conversationId, scope.agentIds ? [...scope.agentIds] : null]);
}

/**
 * A call on someone else's Agent refused by its caller's limit (`agentCallerRunsPerMinute`): it started nothing, and no run
 * records it; its sender is told on their own message (`recordRefusal`, `too_often`), and it is logged after commit
 * (`logCallerLimited`).
 */
export interface CallerLimited {
  callerId: string;
  agentId: string;
  conversationId: string;
}

/**
 * Why a LIMIT refused a call of a person's message on an Agent, as its sender alone is told on their copy of it (`call_refusals`,
 * migration 077; messages/read.ts `refused`): the owner's one number for others' use reached (`others_limit`), or too often — the
 * caller's calls a minute, the owner's others' replies a minute (`too_often`). A refusal for access (a block, a stop, removed,
 * owner-only, paused) is never one: it stays quiet.
 */
export type RefusalReason = "others_limit" | "too_often";

/** A message whose sender is told, after commit, that a limit refused a call of it: their copy is pushed to them again (`Hub.pushRefused`). */
export interface Refused {
  conversationId: string;
  seq: number;
  senderId: string;
}

/**
 * An owner whose one number for others' use refused a call on their Agent `agentId`: after commit they are told once a site day, in
 * that Agent's own conversation (`othersReachedNotice`, through `DbAgentPort.actOnTold`), of the number that refused it
 * (`pointsMicro`, read in the refusal's transaction). Only when a call was refused: none for a reply with no call left.
 */
export interface ReachedOwner {
  ownerId: string;
  agentId: string;
  pointsMicro: bigint;
}

/**
 * What a message called for, to act on after commit: runs to announce, calls their caller's limit refused, to log, the
 * notices it led to in its group, to publish after it, the senders a limit refused a call of (`refused`) and the owners whose
 * one number did (`reached`), to tell, and the running runs it ended, whose calls are abandoned.
 */
export interface Triggered {
  runs: Announced[];
  callerLimited: CallerLimited[];
  notices: StoredMessage[];
  refused: Refused[];
  reached: ReachedOwner[];
  /** Running runs the message ended (an owner's interjection in a social conversation, lane B's B6): their calls are abandoned after commit (`DbAgentPort.interruptRuns`). */
  stopped: readonly string[];
}

/** What a brake told when it refused a call: the notices it appended, to publish, the senders to push their message again, the owners to tell. */
export type Told = Pick<Triggered, "notices" | "refused" | "reached">;

/** Nothing told. */
export function noneTold(): Told {
  return { notices: [], refused: [], reached: [] };
}

/**
 * Records that a LIMIT refused the calls of the messages at `seqs` of `conversationId` on Agent `agentId` (`reason`), for the person
 * each is for alone (`call_refusals.sender_id`): a person's message's sender; for an Agent's message (a relay), the person behind it
 * (`behind`, the call's caller: limits redesign C-d) — none when nobody is, and then nothing is recorded for it. One row per (message,
 * Agent), the first refusal kept. Returns whom to push the message to again after commit (none for what was recorded already).
 */
export async function recordRefusal(t: Tx, conversationId: string, seqs: readonly number[], agentId: string, reason: RefusalReason, behind: string | null = null): Promise<Refused[]> {
  if (seqs.length === 0) return [];
  const { rows } = await t.query<{ seq: string; sender_id: string }>(
    `insert into call_refusals (conversation_id, seq, agent_id, sender_id, reason)
     select m.conversation_id, m.seq, $3, case when p.kind = 'human' then m.sender_id else $5::uuid end, $4
       from messages m join principals p on p.id = m.sender_id
      where m.conversation_id = $1 and m.seq = any($2::bigint[]) and m.kind <> 'system' and (p.kind = 'human' or $5::uuid is not null)
     on conflict do nothing
     returning seq::text, sender_id`,
    [conversationId, [...seqs], agentId, reason, behind],
  );
  return rows.map((r) => ({ conversationId, seq: Number(r.seq), senderId: r.sender_id }));
}

/**
 * The calls run `runId` answers (its assignment, `call_seqs`), refused at its admission by `reason`: recorded for the person each is
 * for (`recordRefusal`, the run's caller behind its relays), and so taken out of its assignment for good (C-b).
 */
export async function refuseRunCalls(t: Tx, runId: string, reason: RefusalReason): Promise<{ refused: Refused[]; calls: number }> {
  const { rows } = await t.query<{ conversation_id: string; agent_id: string; caller_id: string | null; seqs: string[] }>(
    `select conversation_id, agent_id, caller_id, coalesce(call_seqs, array[covers_seq])::text[] as seqs from agent_runs where id = $1`,
    [runId],
  );
  const run = rows[0];
  if (!run) return { refused: [], calls: 0 };
  return { refused: await recordRefusal(t, run.conversation_id, run.seqs.map(Number), run.agent_id, reason, run.caller_id), calls: run.seqs.length };
}

/**
 * The owner's notice that others' use of their Agents has reached their one number today (`others_limit_reached`), in the own
 * conversation of `agentId`, the Agent a call on was refused for it: appended unless one of the owner's Agents' conversations has one
 * of the site day already (once per owner and site day, whichever Agent it was), with the number that refused the call
 * (`pointsMicro`, read as it refused); null when it is not appended. Its own transaction, after the one that refused (`DbAgentPort.actOnTold`): an advisory lock of the owner's, which nothing
 * else takes, keeps two at once from both appending; then the Agent's own conversation and its row (`lockAgent`, the lock order).
 */
export async function othersReachedNotice(t: Tx, config: Pick<Config, "others" | "siteTimezone">, owner: ReachedOwner, now = new Date()): Promise<StoredMessage | null> {
  await t.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`others_reached:${owner.ownerId}`]);
  const told = await t.query(
    `select 1 from messages m join agent_conversations ac on ac.conversation_id = m.conversation_id
      where ac.owner_id = $1 and m.kind = 'system' and m.body ->> 'event' = 'others_limit_reached' and m.created_at >= $2 limit 1`,
    [owner.ownerId, siteDayStart(now, config.siteTimezone, 0)],
  );
  if (told.rowCount) return null;
  const agent = await lockAgent(t, owner.agentId);
  if (agent.deleted || agent.ownerId !== owner.ownerId) return null;
  return appendSystem(t, agent.conversationId, { event: "others_limit_reached", actorId: agent.id, agentId: agent.id, points: formatPoints(owner.pointsMicro) });
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

/**
 * After commit, what a message called for (`Triggered`) besides its notices, which are published with it: each run
 * announced (`DbAgentPort.announce`), each call its caller's limit refused logged, and the senders and owners a limit's refusal
 * tells (`tell`: `DbAgentPort.actOnTold`).
 */
export function actOnTriggered(
  triggered: Triggered,
  to: { announce(run: Announced): void; log: Pick<FastifyBaseLogger, "info">; interrupt(runIds: readonly string[]): void; tell(told: Told): void },
): void {
  for (const run of triggered.runs) to.announce(run);
  if (triggered.stopped.length > 0) to.interrupt(triggered.stopped);
  logCallerLimited(to.log, triggered.callerLimited);
  if (triggered.refused.length > 0 || triggered.reached.length > 0) to.tell({ notices: [], refused: triggered.refused, reached: triggered.reached });
}

/** A call on an Agent, who made it (`callerOf`) and whose questions it carries (`Askers`): what `reachAgents` acts on. */
interface Call {
  agent: RunAgent;
  by: Caller;
  askers: Askers;
}

/**
 * In a group, under its row lock: the message at `seq` reaches the Agent of each of `calls` (in id order; whether each may be called
 * is decided already, but for the owner's one number where it looks reached: the `doubtful` calls), called for by its `by` — the
 * call's identity, decided now and never again (`Caller`). ONE rule for every call, whatever stands on the Agent's pair there
 * (`pairOf`, its active run locked; the limits redesign, Part 2):
 * - The limits on someone else's call (any lane but `own`), met as it is accepted (`accepted_at`), whatever happens to it next
 *   (C-a): the owner's one number for a doubtful call (`refusedByOthersLimit`, under the accounts' locks); the caller's calls a
 *   minute (`calledLastMinute`; a call with no caller has none to meet: over it the call is returned in `callerLimited`, to log);
 *   the owner's others' replies a minute (`overLaneLimit`). Over a minute: nothing is queued, folded or left waiting, nothing is
 *   recorded for the owner or the other members: the person the call is for alone is told (`recordRefusal`, `too_often`: the
 *   sender of a person's message; for an Agent's relay, the person behind it, C-d).
 * - Nothing active there and nothing waiting: a reply is queued for the call (`queueRun`) — but someone else's call on an Agent whose
 *   model is not there to call is recorded failed `model_gone` at once (not held to the owner's minute: it would spend nothing of
 *   theirs), and the owner's own call over the owner's own minute is recorded on the reusable `rate_limited` run
 *   (`rateLimitedInGroup`). The owner's own call is never held to the others' numbers.
 * - A queued reply never claimed of the SAME identity, and nothing waiting: the call is folded into it (`foldInto`: what one person
 *   asking twice comes to). It starts no reply and is not counted.
 * - Otherwise (a reply under way, or one of another identity, a retry, a tell, a greeting, a reply nobody asked for, or calls waiting
 *   already: nothing passes the head): the call waits (`deferCall`, over `DEFERRED_PER_PAIR` refused `too_often`), to be answered
 *   when the active run ends (`takeDeferred`).
 * Whose questions a call carries is recorded only where it is accepted (a run, a fold, a waiting call: C-c). The run rows first (the
 * pairs, in id order), then the `accounts` rows of every call's owner and caller, all in ascending id (`lockAccounts`: the lock
 * order's last step), before any is counted. Returns what to announce and what to log after commit (it appends no notice), and the
 * Agents the owner's number refused (`refusedIds`, for `recordRefusedCalls`).
 */
async function reachAgents(
  t: Tx,
  conversationId: string,
  calls: readonly Call[],
  seq: number,
  triggeredBy: TriggeredBy,
  config: RunLimits,
  told: Told,
  doubtful: readonly Call[] = [],
): Promise<Pick<Triggered, "runs" | "callerLimited"> & { refusedIds: string[] }> {
  const all = [...calls.map((call) => ({ call, doubtful: false })), ...doubtful.map((call) => ({ call, doubtful: true }))].sort((a, b) => (a.call.agent.id < b.call.agent.id ? -1 : 1));
  const pairs = await pairsOf(t, [...new Set(all.map(({ call }) => call.agent.id))], conversationId);
  await lockAccounts(
    t,
    all.flatMap(({ call }) => (call.by.lane !== "own" && call.by.id !== null ? [call.agent.ownerId, call.by.id] : [call.agent.ownerId])),
  );
  const out: Pick<Triggered, "runs" | "callerLimited"> & { refusedIds: string[] } = { runs: [], callerLimited: [], refusedIds: [] };
  for (const { call, doubtful: looked } of all) {
    const { agent, by, askers } = call;
    const pair = pairs.get(agent.id)!;
    if (looked && (await refusedByOthersLimit(t, conversationId, [seq], agent, by.lane, told, config, by.id))) {
      out.refusedIds.push(agent.id);
      continue;
    }
    const idle = pair.active === null && pair.waiting === 0;
    if (by.lane !== "own") {
      if (by.id !== null && (await calledLastMinute(t, by.id)) >= config.agentCallerRunsPerMinute) {
        out.callerLimited.push({ callerId: by.id, agentId: agent.id, conversationId });
        told.refused.push(...(await recordRefusal(t, conversationId, [seq], agent.id, "too_often", by.id)));
        continue;
      }
      // Someone else's call on an Agent whose model is not there to call (models/resolve.ts `modelUsable`) queues no reply and is
      // not held to its owner's minute (it would spend nothing of theirs): recorded failed `model_gone` at once.
      if (idle && !(await modelUsable(t, config, { ownerId: agent.ownerId, model: await modelOfAgent(t, agent.id) }))) {
        out.runs.push(await recordRateLimited(t, agent, conversationId, seq, triggeredBy, by, askers, "model_gone"));
        continue;
      }
      if (await overLaneLimit(t, agent.ownerId, by.lane, config)) {
        told.refused.push(...(await recordRefusal(t, conversationId, [seq], agent.id, "too_often", by.id)));
        continue;
      }
    }
    if (idle) {
      // The owner's own call over their own minute: their `rate_limited` run, as ever.
      const over = by.lane === "own" && (await overLaneLimit(t, agent.ownerId, "own", config));
      out.runs.push(over ? await rateLimitedInGroup(t, agent, conversationId, seq, triggeredBy, by, askers) : await queueRun(t, agent, conversationId, seq, triggeredBy, by, askers));
      continue;
    }
    if (pair.active?.foldable && pair.waiting === 0 && sameIdentity(pair.active.caller, by) && (await foldInto(t, pair.active.id, seq, triggeredBy, askers))) continue;
    await deferCall(t, agent, conversationId, seq, triggeredBy, by, askers, pair.waiting, told);
  }
  return out;
}

/** When today began, in the site's time zone (`siteDayStart`). */
export const siteToday = (config: Pick<Config, "siteTimezone">): Date => siteDayStart(new Date(), config.siteTimezone, 0);

/**
 * Whether a call in `lane` on an Agent of `ownerId` looks refused by the owner's one number now: read without the account's lock,
 * so it decides nothing (`refusedByOthersLimit` decides, under it) — it only says whether the lock is worth taking.
 */
const looksReached = async (t: Tx, ownerId: string, lane: Lane, config: RunLimits): Promise<boolean> =>
  lane === "others" && (await othersReached(t, config, ownerId, new Date()));

/**
 * Whether the calls of the messages at `seqs` on `agent` in `lane` are refused by its owner's one number for others' use: only a
 * call someone other than its owner made (`others`) ever is, once others' use of the owner's Agents today has reached the number
 * (metering/others.ts `othersReached`, the measure admission decides by), read under the owner's account lock (`lockAccount`,
 * taken here unless the caller took it already: what it reads is then what a raise of the number has committed). Refused, each message's sender is told on their own copy (`recordRefusal`, `others_limit`; for an
 * Agent's relay the person behind it, `behind`: C-d), and the owner once a site day (`reached`): both go into `told`, to act on after
 * commit. Nothing is told the conversation.
 */
async function refusedByOthersLimit(
  t: Tx,
  conversationId: string,
  seqs: readonly number[],
  agent: Pick<AgentRow, "id" | "ownerId">,
  lane: Lane,
  told: Told,
  config: RunLimits,
  behind: string | null = null,
): Promise<boolean> {
  if (!(await looksReached(t, agent.ownerId, lane, config))) return false;
  // Decided under the owner's account lock (taken already where the caller's lock order needs it earlier: a no-op then).
  await lockAccount(t, agent.ownerId);
  if (!(await othersReached(t, config, agent.ownerId, new Date()))) return false;
  told.refused.push(...(await recordRefusal(t, conversationId, seqs, agent.id, "others_limit", behind)));
  // The owner is told only of a refused call, of the number that refused it.
  if (seqs.length > 0) told.reached.push({ ownerId: agent.ownerId, agentId: agent.id, pointsMicro: await othersLimitOf(t, config, agent.ownerId) });
  return true;
}

/**
 * At admission (`DbAgentPort.begin`, in the transaction that admits the call, under the run's conversation row, its
 * Agent's and its own): whether `agent`'s run in `lane` is refused after all, by what its lane is held to that may have
 * changed while it waited queued: a reply nobody asked for (`proactive`) finds its owner has turned proactive replies off
 * since. Nobody is told — a notice about a reply nobody asked for would be noise. The owner's one number for others' use is
 * decided at admission itself, under the account lock (metering/others.ts `othersAdmissible`), not here. Null when it is not
 * refused; else what the refusal told: nothing.
 */
export function refusedAtAdmission(agent: Pick<AgentRow, "proactive">, lane: Lane): Told | null {
  return lane === "proactive" && !agent.proactive ? noneTold() : null;
}

/**
 * Between two rounds of a reply that offers tools (`DbAgentPort.extend`, under the run's conversation row, its Agent's
 * and its own), and at a web search's pre-hold: whether what the reply has cost so far (`extra`, not settled yet) reaches
 * the Agent's chain budget — a reply in a group that covers messages after the group's latest from a person (one in an
 * Agents' chain, counted toward the chain budget: `chargedSince`) — then no further round may call tools. The owner's one
 * number for others' use is not here: it is decided at admission (metering/others.ts `othersAdmissible`), and at a web search
 * of a reply others caused (tools/web/hold.ts). Only where `placeOf`
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
 * message. `replyMode` plays no part in a group. Someone else's message is then held to the owner's one number for others'
 * use (`refusedByOthersLimit`, decided in `reachAgents` under the accounts' locks for each call whose number looks reached):
 * once it is reached the Agent is not called — not even folded into a reply of its, nor left waiting —
 * the sender is told on their message and the owner once a day (into what is returned, to act on after commit); the refusal is
 * recorded with the message (`recordRefusedCalls`). Its owner's message never is. Then `reachAgents`, each called for by the
 * sender (`callerOf`).
 */
async function triggerInGroup(t: Tx, conversationId: string, message: StoredMessage, config: RunLimits): Promise<Triggered> {
  const called = mentionedIds(message);
  if (called.length === 0) return noneTriggered();
  const { rows } = await t.query<{ id: string }>(
    `select p.id from memberships m
       join principals p on p.id = m.principal_id
       join agents a on a.principal_id = p.id
      where m.conversation_id = $1 and m.left_seq is null and p.kind = 'agent' and p.id = any($2::uuid[])
        and not ${refusedInGroup("$3::uuid", "p.id")}
      order by p.id`,
    [conversationId, called, message.senderId],
  );
  const told = noneTold();
  const calls: Call[] = [];
  // The calls whose owner's number looks reached: decided in `reachAgents`, under the accounts' locks.
  const doubtful: Call[] = [];
  for (const { id } of rows) {
    const agent = await lockAgent(t, id, conversationId);
    if (agent.deleted || agent.paused || agent.model === null) continue;
    if (agent.groupMentions === "owner" && message.senderId !== agent.ownerId) continue;
    const by = callerOf(agent.ownerId, message.senderId);
    // The sender asks (Task 10b): what the reply is shown starts no earlier than their joining.
    ((await looksReached(t, agent.ownerId, by.lane, config)) ? doubtful : calls).push({ agent, by, askers: [message.senderId] });
  }
  const { refusedIds, ...reached } = await reachAgents(t, conversationId, calls, message.seq, "human", config, told, doubtful);
  await recordRefusedCalls(t, conversationId, message.seq, refusedIds);
  return { ...reached, stopped: [], ...told };
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
 * (after that message: a person's latest, for the chain's notices) or a time (since then: `agent_quieted` once an hour,
 * proactive/decide.ts). What keeps each notice to once a period.
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
 * calling each other from two groups at once would deadlock. What becomes of each call (`reachAgents`) needs no target's row: the
 * group's row, which this transaction holds, orders it with every other trigger, retry, run's end and halt in this group (the
 * one-active-run index backs that). A pause or delete that commits meanwhile takes the target's row, not the group's, and cannot see
 * the run this inserts or the call it leaves waiting (no predicate lock): a deleted Agent's run is ended by the worker without
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
 * - the owner's one number for others' use, per Agent the call is not its owner's own on (see below): once it is reached
 *   (`refusedByOthersLimit`) → it is not called, and its owner is told once a day (returned, to act on after commit; an
 *   Agent's message has no sender to tell).
 * Each Agent refused so, or for a block, is recorded with the message (`recordRefusedCalls`): no run of it answers it and no
 * call of it waits. One the query does not find at all (paused, deleted, without a model, only its owner's to call, not a member)
 * is not recorded: nothing of it is there either.
 * The rest are reached as a person's message reaches them (`reachAgents`), as an Agent's (`triggered_by` `agent`),
 * called for by the person behind the message (`behindAgentMessage`, from `postedBy`, the caller and lane of the run that
 * posted it; null when no run did): the caller of that run when it is not its owner's own, else the poster's owner —
 * `callerOf`, the target's owner's own when they are that person. So a member's call relayed through the owner's Agent
 * stays the member's — held to the target's owner's one number, the member's caller limit and the others' lane — and a
 * call on someone else's Agent counts toward the caller limit of the person behind it, as their own call would; what a
 * reply nobody called for relays is others', with no caller (no caller limit; the budget and the others' lane hold).
 * Each call it makes carries `askers`, those of the run that posted the message (Task 10b: the person whose message
 * started the chain; null, not known, when no run posted it or that run's are not known) — every caller says whose; a
 * function (`postAsAgent`'s: runs.ts `askersHandedDown`, which writes nothing) is called only once the message may reach a
 * target, never for one that calls nobody, and what it returns is recorded only where a target accepts the call (C-c).
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
  // The access decision (`refusedInGroup`) refuses the target for the poster Agent (a block, a bar, an ended row between its owner
  // and the target's owner, or against the target) or for the person behind the message (none to match when nobody is: `$4` null).
  const { rows } = await t.query<{ id: string; owner_id: string; budget: string; blocked: boolean }>(
    `select p.id, p.owner_id, a.chain_budget_micro::text as budget,
            (${refusedInGroup("$3::uuid", "p.id")} or ($4::uuid is not null and ${refusedInGroup("$4::uuid", "p.id")})) as blocked
       from memberships m
       join principals p on p.id = m.principal_id
       join agents a on a.principal_id = p.id
      where m.conversation_id = $1 and m.left_seq is null and p.kind = 'agent' and p.id = any($2::uuid[]) and p.id <> $3
        and a.deleted_at is null and not a.paused and a.model_source is not null and a.group_mentions = 'members'
      order by p.id`,
    [conversationId, called, poster.id, behind],
  );
  // The targets refused below (a block, the halt, the chain limit, a chain budget, the owner's one number), recorded with
  // the message as this returns (`recordRefusedCalls`).
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

  const told = noneTold();
  const reached: Array<Omit<Call, "askers">> = [];
  // Those whose owner's number looks reached: decided in `reachAgents`, under the accounts' locks.
  const doubtful: Array<Omit<Call, "askers">> = [];
  for (const target of targets) {
    const spent = await chainBudgetSpent(t, conversationId, target.id, BigInt(target.budget), human);
    if (spent?.notice) told.notices.push(spent.notice);
    const agent = { id: target.id, ownerId: target.owner_id };
    const by = callerOf(agent.ownerId, behind);
    if (spent) {
      refused.push(target.id);
      continue;
    }
    ((await looksReached(t, agent.ownerId, by.lane, config)) ? doubtful : reached).push({ agent, by });
  }
  // Whose questions the calls carry, read only now that the message may reach a run (fix round 3, M-10).
  const carried = reached.length + doubtful.length === 0 ? null : typeof askers === "function" ? await askers() : askers;
  const calls: Call[] = reached.map((c) => ({ ...c, askers: carried }));
  const { refusedIds, ...out } = await reachAgents(t, conversationId, calls, message.seq, "agent", config, told, doubtful.map((c) => ({ ...c, askers: carried })));
  refused.push(...refusedIds);
  return recorded({ ...out, stopped: [], ...told });
}

/**
 * That the message at `seq` called each of `agentIds` and was refused for it when it was posted (`refused_agent_calls`,
 * migrations 022 and 023; `triggerFromAgent`, and `triggerInGroup` for the owner's one number): no run of theirs answers it and no
 * call of it waits for them. The row refers to each Agent's principal, never its `agents` row, so writing it locks no
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

/** What a run's end calls for in its conversation, to act on after commit (`takeDeferred`). */
export interface Next extends Told {
  /** The reply queued for the next assignment of the calls that waited, to announce after the end of the run before it. */
  run: Announced | null;
}

/** The next `run` (null: none), and what deciding it `told` (nothing unless given). */
export function nextOf(run: Announced | null, told: Told = noneTold()): Next {
  return { run, ...told };
}

/** A call taken out of `deferred_calls` for an assignment (`takeHead`). */
interface Waited {
  seq: number;
  lane: "own" | "others";
  caller_id: string | null;
  triggered_by: TriggeredBy;
  asker_ids: string[] | null;
}

/**
 * The head of the calls waiting for `agentId` in `conversationId` — the oldest (by seq: the order they were accepted in, each under
 * the conversation's row) — and every call right after it of the same identity (lane and caller), up to the first of another:
 * ONE assignment, taken out of `deferred_calls` (deleted) and returned oldest first. Empty when nothing waits.
 */
async function takeHead(t: Tx, agentId: string, conversationId: string): Promise<Waited[]> {
  const { rows } = await t.query<Omit<Waited, "seq"> & { seq: string }>(
    `with head as (
       select lane, caller_id from deferred_calls where agent_id = $1 and conversation_id = $2 order by message_seq limit 1
     ), stop as (
       select min(d.message_seq) as seq from deferred_calls d cross join head h
        where d.agent_id = $1 and d.conversation_id = $2 and (d.lane is distinct from h.lane or d.caller_id is distinct from h.caller_id)
     )
     delete from deferred_calls d using head h, stop s
      where d.agent_id = $1 and d.conversation_id = $2 and d.lane = h.lane and d.caller_id is not distinct from h.caller_id
        and (s.seq is null or d.message_seq < s.seq)
     returning d.message_seq::text as seq, d.lane, d.caller_id, d.triggered_by, d.asker_ids`,
    [agentId, conversationId],
  );
  return rows.map((r) => ({ ...r, seq: Number(r.seq) })).sort((a, b) => a.seq - b.seq);
}

/**
 * THE consumption of the calls that wait (limits redesign, Part 2), in the transaction that ended the pair's active run — `finish`
 * and recovery (port-impl.ts `recordIn`, `recoverRun`: an answer, a failure that is not tried again, a stop, a run lost), the owner's
 * stop of a queued run (`stopRun`) and a halt (`haltAgents`) — or, for an ending made outside the conversation's lock order (an ending
 * of access, the operator's disable), the transaction right after it (`consumeIdle`). Under the conversation's row and the Agent's
 * (`lockAgent`), with nothing active on the pair: an automatic retry of the run that ended took the slot first (`scheduleAutoRetry`),
 * and then nothing is taken. The oldest call waiting and the calls right after it of its identity are ONE assignment (`takeHead`),
 * answered by ONE reply queued now in that identity — never another's, never the owner's for a member's call nor the other way — its
 * context, its tools' reach and what it hands down ending at the assignment's last call (`covers_seq`). Before it is queued each call
 * is held again to what may have changed while it waited, and a call refused so leaves the assignment and changes nothing else:
 * - in a group: the access decision (`refusedInGroup`: its sender, the person behind it), and the Agent's `groupMentions` (only its
 *   owner's own message calls one only its owner may call); then each relayed call (an Agent's message) on its own, whatever else the
 *   assignment holds: the halt (`haltedSince` that call: what an Agent asked before a halt is not answered after it) and the Agent's
 *   chain budget (`chainBudgetSpent`, settled by now: the notice into `told`) — a person's call beside it is answered all the same;
 *   in a social conversation the visitor's access (`reach`);
 * - someone else's (lane `others`): the owner's one number for others' use (`refusedByOthersLimit`: the people the calls are for told,
 *   the owner once a day). The minutes are not met again: they were met as each call was accepted (`accepted_at`).
 * An assignment with no call left is dropped and the next is taken. The owner's replies a minute play no part here (a reply waits;
 * it is not refused later for a minute that was free when it was asked). Whose questions it answers: each call's (a person's message,
 * its sender; a relay, the askers it carried) and everyone who wrote after `after` (what the run that just ended covered) up to its
 * last call (`heardIn`), or not known (null) when one of those is not. An Agent that cannot answer (paused, deleted, no model) answers
 * none of them: they are dropped. Returns the reply queued, to announce after the run that ended, and what deciding it told.
 */
export async function takeDeferred(t: Tx, agent: AgentRow, conversationId: string, after: number, config: RunLimits): Promise<Next> {
  const active = await t.query("select 1 from agent_runs where agent_id = $1 and conversation_id = $2 and status in ('queued', 'running') limit 1", [agent.id, conversationId]);
  if (active.rowCount !== 0) return nextOf(null);
  if (agent.paused || agent.deleted || agent.model === null) {
    await dropDeferred(t, { conversationId, agentIds: [agent.id] });
    return nextOf(null);
  }
  const place: Place = conversationId === agent.conversationId ? "own" : await placeOf(t, conversationId, agent);
  // An Agent that is no longer there answers nothing there.
  if (place !== "own" && !(await currentMembership(t, conversationId, agent.id))) {
    await dropDeferred(t, { conversationId, agentIds: [agent.id] });
    return nextOf(null);
  }
  const told = noneTold();
  for (;;) {
    const taken = await takeHead(t, agent.id, conversationId);
    if (taken.length === 0) return nextOf(null, told);
    const run = await answerAssignment(t, agent, conversationId, place, taken, after, config, told);
    if (run !== null) return nextOf(run, told);
  }
}

/** One assignment of `takeDeferred`: the reply queued for it, or null when no call of it is left to answer. */
async function answerAssignment(
  t: Tx,
  agent: AgentRow,
  conversationId: string,
  place: Place,
  taken: readonly Waited[],
  after: number,
  config: RunLimits,
  told: Told,
): Promise<Announced | null> {
  const identity: Caller = { id: taken[0]!.caller_id, lane: taken[0]!.lane };
  // In its own conversation every call is its owner's, and nobody else can be refused there.
  if (place === "own") {
    const seqs = taken.map((c) => c.seq);
    return queueRun(t, agent, conversationId, seqs.at(-1)!, "human", identity, [agent.ownerId], seqs);
  }
  if (place === "social") {
    // A social conversation's one visitor (`triggerInSocial`): still one who may reach the Agent.
    if (identity.lane !== "others" || identity.id === null || identity.id === agent.ownerId) return null;
    if ((await reach(t, identity.id, agent.id, "social", config)) !== "ok") return null;
    const seqs = taken.map((c) => c.seq);
    if (await refusedByOthersLimit(t, conversationId, seqs, agent, identity.lane, told, config, identity.id)) return null;
    return queueRun(t, agent, conversationId, seqs.at(-1)!, "human", identity, [identity.id], seqs);
  }
  // In a group: each call held to the access decision as it stands now — its sender, and the person behind it (the call's caller).
  const { rows } = await t.query<{ seq: string; kind: "human" | "agent"; sender_id: string; refused: boolean }>(
    `select m.seq::text as seq, p.kind, m.sender_id,
            (${refusedInGroup("p.id", "$3::uuid")} or ($4::uuid is not null and ${refusedInGroup("$4::uuid", "$3::uuid")})) as refused
       from messages m join principals p on p.id = m.sender_id
      where m.conversation_id = $1 and m.seq = any($2::bigint[])
      order by m.seq`,
    [conversationId, taken.map((c) => c.seq), agent.id, identity.id],
  );
  const kept = new Set(
    rows.filter((r) => !r.refused && (agent.groupMentions === "members" || (r.kind === "human" && r.sender_id === agent.ownerId))).map((r) => Number(r.seq)),
  );
  // Each relayed call (an Agent's message) on its own, whatever else the assignment holds (T2 fix 1, F9): what an Agent asked before
  // a halt is not answered after it, and none once the Agent's chain budget is spent (the reply that just ended is settled by now: it
  // may have spent it) — a person's call in the same assignment is answered all the same.
  let calls = taken.filter((c) => kept.has(c.seq));
  const relays = calls.filter((c) => c.triggered_by === "agent");
  if (relays.length > 0) {
    const dropped = new Set<number>();
    for (const c of relays) if (await haltedSince(t, conversationId, c.seq)) dropped.add(c.seq);
    if (relays.some((c) => !dropped.has(c.seq))) {
      const spent = await chainBudgetSpent(t, conversationId, agent.id, agent.chainBudgetMicro, await latestHumanSeq(t, conversationId));
      if (spent?.notice) told.notices.push(spent.notice);
      if (spent) for (const c of relays) dropped.add(c.seq);
    }
    calls = calls.filter((c) => !dropped.has(c.seq));
  }
  if (calls.length === 0) return null;
  const last = calls.at(-1)!.seq;
  const asked = calls.some((c) => c.triggered_by === "human");
  const seqs = calls.map((c) => c.seq);

  if (await refusedByOthersLimit(t, conversationId, seqs, agent, identity.lane, told, config, identity.id)) return null;
  const heard = (await t.query<{ ids: string[] | null }>(`select ${heardIn("$1::uuid", "$2::bigint", "$3::bigint")} as ids`, [conversationId, after, last])).rows[0]!.ids;
  const askers: Askers = calls.some((c) => c.asker_ids === null) || heard === null ? null : [...new Set([...calls.flatMap((c) => c.asker_ids!), ...heard])];
  return queueRun(t, agent, conversationId, last, asked ? "human" : "agent", identity, askers, seqs);
}

/**
 * The calls waiting for `agentId` in `conversationId` with nothing active there — left so by an ending made outside the conversation's
 * lock order (social/agent-contacts.ts: an ending of access in a group, the operator's disable; announced after it commits,
 * group-leave.ts `announceEnded`), or by a process that died between such an ending and this — taken now, in a transaction of their
 * own under the conversation's row and the Agent's (`lockAgent`, the lock order), by THE consumption (`takeDeferred`), as if the run
 * that ended had ended here. Its `after` is what the pair's latest reply covered. Null when the Agent is gone.
 */
export async function consumeIdle(t: Tx, agentId: string, conversationId: string, config: RunLimits): Promise<Next | null> {
  let agent: AgentRow;
  try {
    agent = await lockAgent(t, agentId, conversationId);
  } catch (err) {
    if (err instanceof AppError && err.status === 404) return null;
    throw err;
  }
  const latest = await t.query<{ covers: string | null }>(
    "select covers_seq::text as covers from agent_runs where agent_id = $1 and conversation_id = $2 and purpose = 'reply' order by created_at desc, id desc limit 1",
    [agentId, conversationId],
  );
  return takeDeferred(t, agent, conversationId, Number(latest.rows[0]?.covers ?? 0), config);
}

/** The pairs that have calls waiting and nothing active (`consumeIdle`'s): what start-up recovery and the stale-run sweep take. */
export async function idlePairs(q: Queryable): Promise<Array<{ agentId: string; conversationId: string }>> {
  const { rows } = await q.query<{ agent_id: string; conversation_id: string }>(
    `select distinct d.agent_id, d.conversation_id from deferred_calls d
      where not exists (select 1 from agent_runs r where r.agent_id = d.agent_id and r.conversation_id = d.conversation_id and r.status in ('queued', 'running'))
      order by d.agent_id, d.conversation_id`,
  );
  return rows.map((r) => ({ agentId: r.agent_id, conversationId: r.conversation_id }));
}

/** What a halt did, to act on after it commits. */
export interface Halted {
  /** The `agents_halted` notice, or null when the group was halted already. */
  notice: StoredMessage | null;
  /** Queued runs it cancelled, each to announce to its owner — and the replies queued for the calls that waited behind them. */
  cancelled: Announced[];
  /** What deciding those replies appended and whom it tells (`takeDeferred`'s notices, senders and owners), to act on after commit. */
  next: Told;
  /** Running runs it interrupted, whose calls this process abandons (`DbAgentPort.interruptRuns`). */
  running: string[];
}

/**
 * `POST /api/conversations/:id/agents/halt` (ruling 11), by `actorId`: unless the conversation is a group, 404 before
 * any lock; then under the group's row (`lockForWrite`: 404 unless a current member of an open conversation)
 * `agents_halted_seq` becomes the group's current seq, so Agents' messages call nobody until a person writes again (and,
 * batch 2D, no Agent replies unasked to a message before it). The runs Agents' messages called for end, and so do the
 * replies nobody called for (lane `proactive`): a queued one is `cancelled`, `halted` (it never reached a model); a running one
 * is marked `interrupted` `halted` — never posted, it ends `cancelled` with that reason and is settled as any. What waited behind
 * a queued one is taken now, by THE consumption (`takeDeferred`: what a person asked is answered; what only Agents asked before
 * the halt is not); behind a running one, when it ends. Runs a person called for are left alone, and so are the calls that wait
 * behind them (held to the halt when they are taken). The `agents_halted` notice is appended unless the group was halted already
 * (no person has written since the last halt): then nothing changes. Lock order: the group's row, the `agents` rows of the queued
 * runs with calls waiting behind them (in id order), then run rows, then the `accounts` rows of their owners, in id order, before
 * any is taken.
 */
export async function haltAgents(t: Tx, conversationId: string, actorId: string, config: RunLimits): Promise<Halted> {
  if ((await peekConversation(t, conversationId))?.type !== "group") throw notFound();
  const lock = await lockForWrite(t, conversationId, actorId);
  const already = await isHalted(t, conversationId, await latestHumanSeq(t, conversationId));
  await t.query("update conversations set agents_halted_seq = greatest(coalesce(agents_halted_seq, 0), $2) where id = $1", [conversationId, lock.conversation.seq]);
  // The Agents of the queued runs it ends that have calls waiting behind them, before any run row (nothing changes that while the
  // group's row is held).
  const waiting = await t.query<{ agent_id: string }>(
    `select distinct r.agent_id from agent_runs r
      where r.conversation_id = $1 and r.status = 'queued' and (r.triggered_by = 'agent' or r.lane = 'proactive')
        and exists (select 1 from deferred_calls d where d.agent_id = r.agent_id and d.conversation_id = r.conversation_id)
      order by r.agent_id`,
    [conversationId],
  );
  const agents = new Map<string, AgentRow>();
  for (const { agent_id } of waiting.rows) agents.set(agent_id, await lockAgent(t, agent_id, conversationId));
  await lockActiveRuns(t, "r.conversation_id = $1 and (r.triggered_by = 'agent' or r.lane = 'proactive')", [conversationId]);
  const queued = await t.query<RunRow & { owner_id: string; agent_id: string; covers: string | null }>(
    `update agent_runs as r set status = 'cancelled', error = 'halted', finished_at = now()
      where r.conversation_id = $1 and r.status = 'queued' and (r.triggered_by = 'agent' or r.lane = 'proactive')
      returning ${RUN_COLUMNS}, r.owner_id, r.agent_id, r.covers_seq::text as covers`,
    [conversationId],
  );
  const running = await t.query<{ id: string }>(
    `update agent_runs set interrupted = 'halted'
      where conversation_id = $1 and status = 'running' and (triggered_by = 'agent' or lane = 'proactive') and interrupted is null returning id`,
    [conversationId],
  );
  const notice = already ? null : await appendSystem(t, conversationId, { event: "agents_halted", actorId });
  // Then what waited, after the notice (what an Agent asked before it is not answered after it). Their owners' accounts first, all
  // of them in ascending id (`lockAccounts`), whatever order the runs came back in.
  const cancelled: Announced[] = [];
  const next = noneTold();
  await lockAccounts(t, queued.rows.filter((r) => agents.has(r.agent_id)).map((r) => r.owner_id));
  for (const r of queued.rows) {
    cancelled.push({ ownerId: r.owner_id, conversationId, run: toWireRun(r) });
    const agent = agents.get(r.agent_id);
    if (agent === undefined) continue;
    const { run, ...told } = await takeDeferred(t, agent, conversationId, Number(r.covers ?? 0), config);
    if (run) cancelled.push(run);
    next.notices.push(...told.notices);
    next.refused.push(...told.refused);
    next.reached.push(...told.reached);
  }
  return { notice, cancelled, next, running: running.rows.map((r) => r.id) };
}

/**
 * The trigger (spec 6.5): in the send transaction, after a person's `message` was stored (not a repeat), under the
 * send's locks. In a group: `triggerInGroup`, the Agent members its stored mentions mean. In an Agent conversation
 * only a message from the owner counts, and nothing happens when the Agent is paused, deleted or has no model, or
 * answers only when called (`replyMode` `mention`) and its stored mentions do not mean it (picked, or typed as its full
 * handle, its name part or `@` and its name: mentions.ts `mentionsAtSend`). Every reply here is its owner's own. With nothing
 * active and nothing waiting, a reply is queued — unless the owner has started their own `agentRunsPerMinute` in the last minute
 * (`overLaneLimit`): then a `failed` run, `rate_limited`, is recorded instead (`recordRateLimited`; the message stays sent). With a
 * reply queued and never claimed and nothing waiting, the message is folded into it (`foldInto`); otherwise it waits for the reply
 * under way (`deferCall`: over `DEFERRED_PER_PAIR` refused `too_often`, the owner told on their message), and is answered when that
 * reply ends (`takeDeferred`, with the owner's other messages right after it as one reply). A new Agent's greeting still queued gives
 * way (cancelled) to the owner's message; a reply active in another conversation is not touched. Returns the runs to announce and,
 * in a group, the calls their caller's limit refused, to log, the notices to publish after the message, and whom a limit's
 * refusal tells — its senders, the owners whose one number refused — after commit (nothing in a direct chat).
 */
export async function maybeTrigger(t: Tx, lock: WriteLock, message: StoredMessage, config: RunLimits): Promise<Triggered> {
  if (message.kind === "system") return noneTriggered();
  if (lock.conversation.type === "group") return triggerInGroup(t, lock.conversation.id, message, config);
  if (lock.conversation.type === "agent_social") return triggerInSocial(t, lock, message, config);
  if (lock.conversation.type !== "agent") return noneTriggered();
  const conversationId = lock.conversation.id;
  const found = await t.query<{ agent_id: string }>("select agent_id from agent_conversations where conversation_id = $1", [conversationId]);
  if (!found.rows[0]) return noneTriggered();
  const agent = await lockAgent(t, found.rows[0].agent_id, conversationId);
  if (message.senderId !== agent.ownerId || agent.paused || agent.deleted || agent.model === null) return noneTriggered();
  if (agent.replyMode === "mention" && !mentionedIds(message).includes(agent.id)) return noneTriggered();
  // Its owner's message: every reply here is the owner's own.
  const caller = callerOf(agent.ownerId, message.senderId);
  const askers = [message.senderId];
  // A new Agent's greeting still queued gives way: it answers no message, so the owner's gets an ordinary reply (whose
  // failure is shown, with 重试) — never folded into a greeting that ends quietly.
  const greeting = await t.query<RunRow>(
    `update agent_runs as r set status = 'cancelled', finished_at = now()
      where r.agent_id = $1 and r.conversation_id = $2 and r.status = 'queued' and r.greets returning ${RUN_COLUMNS}`,
    [agent.id, conversationId],
  );
  const gaveWay: Announced[] = greeting.rows.map((r) => ({ ownerId: agent.ownerId, conversationId, run: toWireRun(r) }));
  const pair = await pairOf(t, agent.id, conversationId);
  if (pair.active !== null || pair.waiting > 0) {
    if (pair.active?.foldable && pair.waiting === 0 && sameIdentity(pair.active.caller, caller) && (await foldInto(t, pair.active.id, message.seq, "human", askers))) {
      return { ...noneTriggered(), runs: gaveWay };
    }
    const told = noneTold();
    await deferCall(t, agent, conversationId, message.seq, "human", caller, askers, pair.waiting, told);
    return { ...noneTriggered(), runs: gaveWay, ...told };
  }
  const over = await overLaneLimit(t, agent.ownerId, caller.lane, config);
  const run = over
    ? await recordRateLimited(t, agent, conversationId, message.seq, "human", caller, askers)
    : await queueRun(t, agent, conversationId, message.seq, "human", caller, askers);
  return { ...noneTriggered(), runs: [...gaveWay, run] };
}

/**
 * A message in a social conversation (`agent_social`), in the send's transaction, which holds the conversation's row and (the write
 * rule, `permission`) its participating Agents' rows. Two cases, told apart by who wrote it:
 * 1. A supervisor's (an observer who owns a participating Agent; nobody else, whatever their name: RF5) is an interjection: that
 *    Agent's queued reply here is `cancelled` (`owner_spoke`, announced to its owner); a running one is marked `interrupted`
 *    (`owner_spoke`) and its id returned in `stopped`, whose calls the route abandons after commit, and what it posts is refused
 *    (`postAsAgent`); the calls waiting for it here are dropped; nothing is triggered.
 * 2. A person participant's (the visitor V): `reach(V, Agent, 'social')` again; a paused or deleted Agent, or one with no model,
 *    does nothing; else, the accounts locked in id order (the lock order's last step), the limits as the call is accepted (C-a): the
 *    owner's one number reached (`refusedByOthersLimit`: V told on the message, the owner once a day) → nothing; over V's minute
 *    (`calledLastMinute`) or the owner's others' minute (`overLaneLimit`) → no run, V alone is told on the message (`too_often`).
 *    Then, as in a group (`reachAgents`): nothing active and nothing waiting → an Agent whose model is gone records `model_gone`
 *    (before the owner's minute, which it is not held to), else `queueRun`, caller V, lane `others`, triggered by `human`, askers
 *    [V]; a reply of V's queued and never claimed, nothing waiting → folded into it; otherwise the message waits (`deferCall`).
 * Agent-to-Agent conversations trigger nothing but interjections in ring 1.
 */
export async function triggerInSocial(t: Tx, lock: WriteLock, message: StoredMessage, config: RunLimits): Promise<Triggered> {
  const conversationId = lock.conversation.id;
  const { rows: parts } = await t.query<{ id: string; kind: "human" | "agent"; owner_id: string | null }>(
    `select p.id, p.kind, p.owner_id from social_pairs sp join principals p on p.id in (sp.a_id, sp.b_id) where sp.conversation_id = $1 order by p.id`,
    [conversationId],
  );
  const agents = parts.filter((p) => p.kind === "agent");
  const sender = message.senderId;
  // A supervisor: the owner of a participating Agent, in the conversation as its observer.
  const owned = agents.filter((a) => a.owner_id === sender);
  if (owned.length > 0 && lock.membership.role === "observer") return interjection(t, conversationId, owned.map((a) => a.id));
  // The visitor's: a person participant of a person-to-Agent conversation.
  const visitor = parts.find((p) => p.kind === "human" && p.id === sender);
  if (!visitor || agents.length !== 1) return noneTriggered();
  const agent = await lockAgent(t, agents[0]!.id, conversationId);
  if ((await reach(t, sender, agent.id, "social", config)) !== "ok") return noneTriggered();
  if (agent.deleted || agent.paused || agent.model === null) return noneTriggered();
  const pair = await pairOf(t, agent.id, conversationId);
  const caller = callerOf(agent.ownerId, sender);
  const told = noneTold();
  // The accounts in id order, last (the lock order), before the owner's number is decided under its lock.
  await lockAccounts(t, [agent.ownerId, sender]);
  if (await refusedByOthersLimit(t, conversationId, [message.seq], agent, caller.lane, told, config)) return { ...noneTriggered(), ...told };
  const askers = [sender];
  // Over a minute: the visitor's line is the one outward result (no run of it for the owner).
  const limited = async () => {
    told.refused.push(...(await recordRefusal(t, conversationId, [message.seq], agent.id, "too_often")));
    return { ...noneTriggered(), ...told };
  };
  // The order of `reachAgents`: the visitor's own minute first (a `model_gone` row counts in it, so a visitor cannot write one
  // row a message without end), then an Agent whose model is gone (recorded failed `model_gone` at once, never held to the owner's
  // minute), then the owner's others' minute.
  if ((await calledLastMinute(t, sender)) >= config.agentCallerRunsPerMinute) return limited();
  const idle = pair.active === null && pair.waiting === 0;
  if (idle && !(await modelUsable(t, config, { ownerId: agent.ownerId, model: agent.model }))) {
    return { ...noneTriggered(), runs: [await recordRateLimited(t, agent, conversationId, message.seq, "human", caller, askers, "model_gone")], ...told };
  }
  if (await overLaneLimit(t, agent.ownerId, caller.lane, config)) return limited();
  if (idle) return { ...noneTriggered(), runs: [await queueRun(t, agent, conversationId, message.seq, "human", caller, askers)], ...told };
  if (pair.active?.foldable && pair.waiting === 0 && sameIdentity(pair.active.caller, caller) && (await foldInto(t, pair.active.id, message.seq, "human", askers))) {
    return { ...noneTriggered(), ...told };
  }
  await deferCall(t, agent, conversationId, message.seq, "human", caller, askers, pair.waiting, told);
  return { ...noneTriggered(), ...told };
}

/**
 * The owner's interjection (`triggerInSocial`, case 1) for the Agents `agentIds` (the owner's, participating there): their queued
 * replies in the conversation are cancelled (`owner_spoke`), their running ones interrupted (`coalesce`: a mark already there
 * stays), and returned for the caller to abandon; the calls waiting for them there are dropped (`dropDeferred`). The queued ones
 * before the running ones: a run claimed in between is seen as one or the other (as `endGrants` orders them).
 */
async function interjection(t: Tx, conversationId: string, agentIds: readonly string[]): Promise<Triggered> {
  await lockActiveRuns(t, "r.conversation_id = $1 and r.agent_id = any($2::uuid[]) and r.purpose = 'reply'", [conversationId, [...agentIds]]);
  const queued = await t.query<RunRow & { owner_id: string }>(

    `update agent_runs r set status = 'cancelled', error = 'owner_spoke', finished_at = now()
      where r.conversation_id = $1 and r.agent_id = any($2::uuid[]) and r.purpose = 'reply' and r.status = 'queued'
      returning ${RUN_COLUMNS}, r.owner_id`,
    [conversationId, [...agentIds]],
  );
  const running = await t.query<{ id: string }>(
    `update agent_runs r set interrupted = coalesce(r.interrupted, 'owner_spoke')
      where r.conversation_id = $1 and r.agent_id = any($2::uuid[]) and r.purpose = 'reply' and r.status = 'running'
      returning r.id`,
    [conversationId, [...agentIds]],
  );
  await dropDeferred(t, { conversationId, agentIds });
  return {
    ...noneTriggered(),
    runs: queued.rows.map((r) => ({ ownerId: r.owner_id, conversationId, run: toWireRun(r) })),
    stopped: running.rows.map((r) => r.id),
  };
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

/** The latest an automatic retry may start after its original call was made (README "Agents and runs", Automatic retry). */
export const AUTO_RETRY_WINDOW_MS = 600_000;

/**
 * Whether a run that ended `end` failed for a reason that clears by itself: tagged so by THE classifier
 * (runtime/port.ts `passingEnding`, through `failedEnd`) — only an explicit signal (the upstream's 5xx, 408, 429; a call
 * error or a cut stream before anything was said; the service losing the run mid-call; never `took_too_long`). The system
 * may then try it again by itself (`scheduleAutoRetry`).
 */
export const transientFailure = (end: { status: string; transient?: true }): boolean => end.status === "failed" && end.transient === true;

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
 * (the lock order) — BEFORE any call waiting there is taken (`takeDeferred`): the retry takes the slot, and the calls wait a bounded
 * time more (its attempts are bounded). Not for (README "Replies", Automatic retry, the table): a reply nobody asked for (lane
 * `proactive`: the moment for an unasked remark has passed); a told reply (`告诉他们`: its owner has just pressed it, and its whisper's
 * own rule offers 重试); a new Agent's greeting; the owner's own 重试 (`owner_retry`: the owner is there); an Agent paused, deleted or
 * without a model; none at all while `AGENTS.autoRetryDelaysMs` is empty. Each original call is tried again at most once per wait in
 * that list (`auto_attempt`, carried on the chain, `retry_of`), the n-th retry `delays[n-1]` after this end (by the port's clock,
 * `now`), and never one scheduled to start more than `AUTO_RETRY_WINDOW_MS` after the original call was made (nor started later:
 * port-impl.ts `begin`); the owner's replies a minute in the retry's lane are met as for any reply queued (`overLaneLimit`). The
 * retry is an ordinary queued reply that is not claimed before its `not_before` (port-impl.ts `claimNext`) and is admitted as any
 * (`begin`: pause, membership, blocks, budgets, money) — and it keeps the failed run's ASSIGNMENT: what it covered, its calls (less
 * any a limit refused since: C-b), askers and whose message called, and its identity — its lane and caller, never decided again
 * (limits redesign, Part 2). Being queued, it holds the Agent's one active run there: whatever calls it meanwhile waits behind it,
 * and the owner's 重试 is `busy_run`.
 */
export async function scheduleAutoRetry(
  t: Tx,
  runId: string,
  agent: AgentRow,
  conversationId: string,
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
    covers: string | null;
    whisper_id: string | null;
    greets: boolean;
    owner_retry: boolean;
    auto_attempt: number;
    original: string;
    original_at: Date;
  }>(
    `select r.purpose, r.lane, r.caller_id, r.triggered_by, r.asker_ids, r.covers_seq::text as covers, r.whisper_id, r.greets, r.owner_retry, r.auto_attempt,
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
  // Something else holds the Agent's one active run there already: nothing is queued beside it.
  const active = await t.query("select 1 from agent_runs where agent_id = $1 and conversation_id = $2 and status in ('queued', 'running') limit 1", [agent.id, conversationId]);
  if (active.rowCount !== 0) return null;
  if (await overLaneLimit(t, agent.ownerId, run.lane, config, { waiting: false })) return { gaveUp: "rate_limited" };
  const calls = await standingSeqs(t, runId);
  const queued = await t.query<RunRow>(
    `insert into agent_runs as r (purpose, conversation_id, agent_id, owner_id, status, covers_seq, triggered_by, caller_id, lane,
                                  asker_ids, call_seqs, whisper_id, greets, retry_of, auto_attempt, not_before)
     values ('reply', $1, $2, $3, 'queued', $4, $5, $6, $7, $8, $9::bigint[], null, false, $10, $11, $12) returning ${RUN_COLUMNS}`,
    [conversationId, agent.id, agent.ownerId, Number(run.covers ?? 0), run.triggered_by, run.caller_id, run.lane, run.asker_ids, calls, run.original, attempt, notBefore],
  );
  return { retry: { ownerId: agent.ownerId, conversationId, run: toWireRun(queued.rows[0]!) }, attempt };
}

/**
 * `告诉他们` on a `found_elsewhere` whisper (Task 8; whispers/routes.ts `ANSWER_HOOKS`), in the answer's transaction — the
 * group's row, the Agent's (for update) and the whisper's held, its state found open (nothing is written to it: this run is
 * what makes it telling, and its posted reply what makes it told — Redesign D): ONE reply of the Agent in the group,
 * queued as its owner's own (`triggered_by` human, lane `own`, the owner its caller and the one it answers), covering the
 * group's latest message but answering no call (`call_seqs` empty: a zero-call run; a call meanwhile waits behind it,
 * `reachAgents`), that is shown the whisper's hits (`agent_runs.whisper_id`, read in port-impl.ts `begin`) and
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
  const queued = await queueRun(t, agent, whisper.conversationId, Number(latest.rows[0]!.seq), "human", owner, [whisper.ownerId], []);
  await t.query("update agent_runs set whisper_id = $2 where id = $1", [queued.run.id, whisper.id]);
  return queued;
}

/** The failed run a 重试 names (`retryRun`), read under its pair's locks. */
interface FailedRun {
  id: string;
  status: RunStatus;
  covers: string | null;
  triggered_by: TriggeredBy;
  asker_ids: string[] | null;
  whisper_id: string | null;
  /** A later run of the pair took it on since — answered one of its calls, or (a told reply) told its whisper: retried already. */
  taken: boolean;
}

/**
 * `POST …/runs/retry` `{runId}`: the failure the owner was shown, named by its id (design Part 2, Retries: a 重试 targets the failed
 * assignment by id, never "the latest" — a later assignment may have failed meanwhile, and answering that one would leave the failure
 * shown unanswered). A new queued reply answers that assignment again: the calls it answered less any a limit refused since (C-b),
 * covering the last of those (nothing written after it is read), its askers (the retry asks nothing new) and whose message called for
 * it (`triggered_by`: what an Agent's message called for is still an Agent's, so a member's halt still ends it) — and it is its owner's
 * own (`lane` `own`, `owner_retry`) whoever's the failure was: the owner asked again, the one deliberate exception to "a member's
 * question never runs on the owner's terms". A told reply (告诉他们) tells its whisper again: covering what it covered and answering no
 * call. Under the conversation's row (a group's, `lockForWrite`) and the Agent's, in that order, then the run rows and the owner's
 * `accounts` row. 404 unless the run is a reply of the caller's Agent in this conversation (their Agent conversation, or a group they
 * are a current member of with that Agent of theirs in it; a social conversation's run is retried by no one: the visitor asks again by
 * writing again); 409 `agent_deleted` / `agent_paused`; 409 `busy_run` while the Agent has a reply queued or running there; 400
 * `invalid_request` when the run did not fail, a later run took it on since, it is from before the Agent's current stay in the group,
 * no call of it is left, or the Agent has no model; 409 `model_gone` while its model is not there to call (`retryable`'s rule); 409
 * `stale_whisper` for a told reply whose whisper reads open no more; 429 over the owner's own `agentRunsPerMinute`.
 */
export async function retryRun(
  t: Tx,
  ownerId: string,
  conversationId: string,
  runId: string,
  config: RunLimits & Pick<Config, "siteModels" | "whispers">,
): Promise<Announced> {
  const place = await runSitePlace(t, conversationId);
  if (place === "social") throw notFound();
  // Whose reply it is, read before any lock (the Agent's row is locked after the conversation's), then read again under them.
  const of = await t.query<{ agent_id: string }>("select agent_id from agent_runs where id = $1 and conversation_id = $2 and purpose = 'reply'", [
    runId,
    conversationId,
  ]);
  const agentId = of.rows[0]?.agent_id;
  let joinedSeq: number | null = null;
  if (place === "group") {
    if (agentId === undefined) {
      await lockForWrite(t, conversationId, ownerId);
      throw notFound();
    }
    joinedSeq = (await ownAgentInGroup(t, ownerId, conversationId, agentId)).joinedSeq;
  } else if (agentId === undefined || (await ownedAgentOf(t, ownerId, conversationId)) !== agentId) {
    throw notFound();
  }
  const agent = await lockAgent(t, agentId, conversationId);
  if (agent.deleted) throw new AppError(409, "agent_deleted");
  if (agent.paused) throw new AppError(409, "agent_paused");
  const active = await t.query("select 1 from agent_runs where agent_id = $1 and conversation_id = $2 and status in ('queued', 'running') limit 1", [
    agent.id,
    conversationId,
  ]);
  if (active.rowCount !== 0) throw new AppError(409, "busy_run");
  const failed = await failedRunOf(t, runId);
  const covers = failed?.covers == null ? null : Number(failed.covers);
  if (!failed || failed.status !== "failed" || failed.taken || agent.model === null || covers === null) throw new AppError(400, "invalid_request");
  if (place === "group" && (joinedSeq === null || covers <= joinedSeq)) throw new AppError(400, "invalid_request");
  // What it answered, less what a limit refused since (C-b); with nothing left there is nothing to answer again.
  const calls = failed.whisper_id !== null ? [] : ((await standingSeqs(t, failed.id)) ?? [covers]);
  if (failed.whisper_id === null && calls.length === 0) throw new AppError(400, "invalid_request");
  if (!(await modelUsable(t, config, agent))) throw new AppError(409, "model_gone");
  // A told reply tells again only a whisper that reads open (whispers/store.ts `mayTell`, the one rule a press and a told
  // reply's beginning keep too): declined and expired are final. Under the conversation's row and the Agent's, held.
  if (failed.whisper_id !== null && !(await mayTell(t, { id: failed.whisper_id, ownerId }, { ttlHours: config.whispers.elsewhereTtlHours })).may) {
    throw new AppError(409, "stale_whisper");
  }
  if (await overLaneLimit(t, ownerId, "own", config)) throw new AppError(429, "rate_limited");
  const queued = await queueRun(t, agent, conversationId, failed.whisper_id !== null ? covers : calls.at(-1)!, failed.triggered_by, callerOf(ownerId, ownerId), failed.asker_ids, calls);
  // That it is its owner's own 重试 (`owner_retry`): the owner is there, so the system never tries it again by itself
  // (`scheduleAutoRetry`) — what bounds the attempts of one call across a manual 重试; and a told reply's whisper, told again.
  await t.query("update agent_runs set owner_retry = true, whisper_id = $2 where id = $1", [queued.run.id, failed.whisper_id]);
  return queued;
}

/** Run `runId` as a 重试 reads it (`retryRun`), locked; null when there is none. */
async function failedRunOf(t: Tx, runId: string): Promise<FailedRun | null> {
  const { rows } = await t.query<FailedRun>(
    `select r.id, r.status, r.covers_seq::text as covers, r.triggered_by, r.asker_ids, r.whisper_id,
            exists (select 1 from agent_runs x
                     where x.agent_id = r.agent_id and x.conversation_id = r.conversation_id and x.purpose = 'reply' and x.id <> r.id
                       and (x.created_at, x.id) > (r.created_at, r.id)
                       and (r.call_seqs is null or x.call_seqs is null or x.call_seqs && r.call_seqs
                            or (r.whisper_id is not null and x.whisper_id = r.whisper_id))) as taken
       from agent_runs r where r.id = $1 for update of r`,
    [runId],
  );
  return rows[0] ?? null;
}


/**
 * `POST …/runs/:runId/stop`: a queued run is stopped at once (it never reached a model: nothing to settle), and what waited behind
 * it is taken in the same transaction (`takeDeferred`); a running one is reported, so the caller can flag it for the worker working
 * on it, or release it when nobody here is (its end takes what waited); a finished one is left as it is. 404 unless the run is of the
 * caller's Agent conversation — or, in a group the caller is a current member of (whose row is locked first, `lockForWrite`, as
 * every writer of runs there does), one of the caller's Agents' runs there: another member's Agent's run is the 404 of a run that
 * does not exist.
 */
export async function stopRun(
  t: Tx,
  ownerId: string,
  conversationId: string,
  runId: string,
  config: RunLimits,
): Promise<{ stopped: Announced | null; running: boolean; next: Next }> {
  // A group or a social conversation: the owner is a current member there (an observer in a social one), under its row.
  if ((await runSitePlace(t, conversationId)) !== "own") await lockForWrite(t, conversationId, ownerId);
  else if (!(await ownedAgentOf(t, ownerId, conversationId))) throw notFound();
  // The run's Agent row before the run's (the lock order): the stop of a queued run may take what waited behind it.
  const peek = (await t.query<{ agent_id: string }>("select agent_id from agent_runs where id = $1 and conversation_id = $2 and owner_id = $3 and purpose = 'reply'", [runId, conversationId, ownerId])).rows[0];
  if (!peek) throw notFound();
  const agent = await lockAgent(t, peek.agent_id, conversationId);
  const { rows } = await t.query<{ status: RunStatus; covers: string | null }>(
    "select status, covers_seq::text as covers from agent_runs where id = $1 and conversation_id = $2 and owner_id = $3 and purpose = 'reply' for update",
    [runId, conversationId, ownerId],
  );
  const status = rows[0]?.status;
  if (status === undefined) throw notFound();
  if (status === "running") {
    // Kept in the row (`stop_asked`): an attempt that begins after this — the same, or the next after its admission held
    // it back — ends stopped (port-impl.ts `halted`), whatever this process's flags say.
    await t.query("update agent_runs set stop_asked = true where id = $1", [runId]);
    return { stopped: null, running: true, next: nextOf(null) };
  }
  if (status !== "queued") return { stopped: null, running: false, next: nextOf(null) };
  const stopped = await t.query<RunRow>(`update agent_runs as r set status = 'stopped', finished_at = now() where r.id = $1 returning ${RUN_COLUMNS}`, [runId]);
  const ended = { ownerId, conversationId, run: toWireRun(stopped.rows[0]!) };
  return { stopped: ended, running: false, next: await takeDeferred(t, agent, conversationId, Number(rows[0]!.covers ?? 0), config) };
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
