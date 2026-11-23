import type { FastifyBaseLogger } from "fastify";
import { listenersFor } from "../agents/proactive/listeners.ts";
import { liveAgent, lockAgent, type AgentRow } from "../agents/store.ts";
import type { Config } from "../config.ts";
import type { ConversationEvents } from "../conversations/events.ts";
import { lockConversationKeys } from "../conversations/store.ts";
import { appendSystem } from "../conversations/system.ts";
import { groupPlaceSql } from "../social/place.ts";
import type { Db, Queryable, Tx } from "../db.ts";
import type { Judge } from "../judge/client.ts";
import type { StoredMessage } from "../messages/model.ts";
import type { ModelGateway } from "../models/gateway.ts";
import { applyDream, applyOps, discardPendingOf, proposeUnlocks, vaultKey, type AppliedOp, type DreamOp, type StoredOp } from "./apply.ts";
import { memoryCall, type MemoryCallReport } from "./call.ts";
import { joinedNote, joinNotes, modelNote } from "./clean.ts";
import { lookedAt, parseAnswer, parseOps, refusedInPlace, sameKey, type Op } from "./ops.ts";
import { linesOf, readReview, type RefNote, type ReviewInput } from "./review.ts";
import { duplicateOf, ownerAsked, sortNote, type KnownNote, type SortDeps } from "./sort.ts";
import { count, countNoteOps } from "./stats.ts";
import { getMemoryLanguage, getNewNotes, listAgentNotes, listOwnerNotes, roomOf, type NoteKind } from "./store.ts";
import { bumpNotes, stampsOf } from "./write.ts";

/**
 * One review, start to finish (the scheduler, reviewer.ts, decides when): the input (`reviewInput`), one metered call
 * (`memoryCall`), the answer as safe operations (`parseOps`), the duplicate test and the vault sorting for what they add
 * (outside any transaction), then one transaction that applies them (`applyOps`), moves `reviewed_seq` and writes the
 * owner's notice, and the notice's announcement after commit.
 *
 * Fail closed: a call that could not be made, failed or was abandoned changes nothing and leaves `reviewed_seq`, and so does one whose
 * Agent had memory switched off meanwhile, also when it is on again by the time the call answers (`memorySwitched`); an answer
 * that cannot be used (garbage, cut, empty) changes nothing but is reviewed (`reviewed_seq` moves, as it does when there
 * was no owner message to look at). In a group only additions are applied: forgetting and locking by speech are the
 * owner's, in their own conversation. What this owner has pending already counts as known. In the owner's own conversation memory asks
 * as little as it can (`runReview`): a lock and (with `MEMORY.mergeAuto` "on", the default) a merge, its notes joined in their own words,
 * apply at once, a remove only when the owner asked for it.
 */

export interface PipelineDeps {
  db: Db;
  config: Config;
  models: Pick<ModelGateway, "stream">;
  judge: Judge | null;
  log: Pick<FastifyBaseLogger, "error" | "warn" | "info" | "debug">;
  /** The memory calls this process is working on, by run id (the stale-run sweep leaves them alone). */
  inFlight: Set<string>;
  conversations: Pick<ConversationEvents, "publish">;
  now: () => number;
}

export interface ReviewJob {
  kind: "review";
  agentId: string;
  conversationId: string;
  /** The one retry of a review whose call met the owner's cap of calls running (`ReviewContext.retry`): not retried again. */
  retried?: boolean;
}

export interface ReviewContext {
  /** The service is stopping: a call under way is abandoned, and nothing is applied. */
  closing: AbortSignal;
  /** Called with the newest seq a review looked at, as soon as it is known (before its call). */
  attempted(seq: number): void;
  /** After commit: a change was applied to the notes of this Agent's owner; the scheduler may nap the rooms it left nearly full. */
  changed?(agentId: string): void;
  /** After commit: the review left owner lines of a later topic for the next review (`ReviewInput.more`); the scheduler runs it after this one. */
  more?(): void;
  /** The review's call could not start because the owner had as many calls running as they may: the scheduler runs it once more a minute later. */
  retry?(): void;
}

/** What may be logged of an error: never its message or detail, which can carry the text of a note. */
export const errInfo = (err: unknown): { code?: string; name?: string } => ({
  ...(typeof (err as { code?: unknown })?.code === "string" ? { code: (err as { code: string }).code } : {}),
  ...(err instanceof Error ? { name: err.name } : {}),
});

/** The Agent when it keeps notes and may be reviewed for (memory on, not paused, not deleted); else null. */
export async function reviewableAgent(db: Db, agentId: string): Promise<AgentRow | null> {
  const agent = await liveAgent(db, agentId);
  return agent && agent.memory ? agent : null;
}

/**
 * Whether `conversationId` is a social conversation (an Agent and another party, the owner watching). Memory never works in one
 * (plan A9): nothing in it is reviewed, flagged, caught up, summarised or given positions, so that nothing the other party says
 * can reach a note, and nothing the owner says there is taken for what they said to their own Agent. Every entry point of memory
 * that names a conversation asks this first.
 */
export async function inSocial(q: Queryable, conversationId: string): Promise<boolean> {
  const { rowCount } = await q.query("select 1 from conversations c where c.id = $1 and c.type = 'agent_social'", [conversationId]);
  return (rowCount ?? 0) > 0;
}

export async function reviewedSeq(db: Queryable, agentId: string, conversationId: string): Promise<number> {
  const { rows } = await db.query<{ s: string }>("select reviewed_seq::text as s from memory_review_state where agent_id = $1 and conversation_id = $2", [agentId, conversationId]);
  return Number(rows[0]?.s ?? 0);
}

const moveReviewed = `insert into memory_review_state (agent_id, conversation_id, reviewed_seq) values ($1, $2, $3)
  on conflict (agent_id, conversation_id) do update set reviewed_seq = greatest(memory_review_state.reviewed_seq, excluded.reviewed_seq)`;

/** Moves `reviewed_seq` (never back), and with it deletes the owner's-own-remark flags it has now passed. */
async function markReviewed(q: Queryable, agentId: string, conversationId: string, seq: number): Promise<void> {
  await q.query(moveReviewed, [agentId, conversationId, seq]);
  await q.query(
    `delete from memory_flags where agent_id = $1 and conversation_id = $2 and kind = 'own'
        and seq <= (select reviewed_seq from memory_review_state where agent_id = $1 and conversation_id = $2)`,
    [agentId, conversationId],
  );
}

/**
 * In the transaction that turns an Agent's `memory` off or on (agents/routes.ts, `PATCH /api/agents/:id`; the Agent's row locked). Off:
 * its waiting cards are discarded (as when it is deleted), its flags not yet acted on (hearsay, the owner's own remarks) dropped, and
 * its positions moved to now (below): what was said before it was switched off and not yet reviewed is never learned — the owner
 * switched it off, that is the point; its notes stay. On: the positions are moved to now again and any flag is dropped, so nothing said
 * while memory was off is ever reviewed, nor heard in a group; unless the owner asked it to look back (`catchUp`): then the
 * positions stay where switching off put them, the next review reads exactly what was said while it was off within its usual
 * window (`reviewMessages`, the topic, in a group what came after it joined), and in every group it is in a catch-up is queued
 * (`memory_catchups`, memory/catchup.ts: what members said there while it was off, judged for it alone). Any other switch drops the
 * Agent's catch-ups (one under way does nothing more). The positions: every review position of the Agent — its
 * own conversation, every conversation it is a member of, any it was reviewed in — and, in every group it is in, where it hears from
 * (`agent_group_state.heard_from_seq`: a line there raises a flag for it only above this, listeners.ts), each the conversation's
 * current seq, never moved back. They are this Agent's alone: the group's judgement keeps its own position (`judged_seq`, what is
 * new to judge, read across the group's Agents) and the switch leaves it, so no other Agent there hears any less or more.
 * The caller has taken the rows of the groups written here first (`lockSwitchGroups`), before the Agent's: `locked` says which, and
 * whether this is its last try (`wait`). The groups are read again here, under the Agent's row: one the Agent joined since (a join
 * between the two reads) is taken `for key share nowait` — free, it is held from now on; held by anyone (a send there, which will ask
 * for this Agent next), `SwitchAgain` is thrown, the transaction rolls back and the caller runs it again, whose first statement then
 * takes that group with the others, in order, holding nothing. Nothing ever waits for a group while the Agent is held, except on the
 * last try (`wait`), as any lock is waited for.
 */
export async function memorySwitched(
  t: Tx,
  agent: Pick<AgentRow, "id" | "ownerId" | "conversationId">,
  on: boolean,
  catchUp: boolean,
  locked: { groups: readonly string[]; wait: boolean },
): Promise<void> {
  // Only the groups taken: one the Agent joins after this (while the owner's account below is waited for, say) gets no row here, and
  // its positions stay where a join puts them (from the join), which is right whichever way memory is switched.
  const held = await lockJoinedSince(t, agent, locked);
  if (on && catchUp) {
    // The positions stay. One catch-up per group it is in: after its heard position (where switching off left it; never before its join)
    // up to the group's latest now. A catch-up left from an earlier switch is replaced (a new `token`: one under way stops).
    await t.query(
      `insert into memory_catchups (agent_id, conversation_id, from_seq, to_seq, next_seq)
         select $1, c.id, f.from_seq, c.seq, f.from_seq + 1
           from memberships m join conversations c on c.id = m.conversation_id
          cross join lateral (select greatest(m.joined_seq, coalesce((select s.heard_from_seq from agent_group_state s where s.agent_id = $1 and s.conversation_id = c.id), 0)) as from_seq) f
          where m.principal_id = $1 and m.left_seq is null and c.id <> $2 and c.id = any($3::uuid[]) and ${groupPlaceSql("c")} and c.seq > f.from_seq
       on conflict (agent_id, conversation_id) do update
         set from_seq = excluded.from_seq, to_seq = excluded.to_seq, next_seq = excluded.next_seq, token = gen_random_uuid(), created_at = now()`,
      [agent.id, agent.conversationId, held],
    );
    return;
  }
  await t.query("delete from memory_catchups where agent_id = $1", [agent.id]);
  await t.query("delete from memory_flags where agent_id = $1", [agent.id]);
  if (!on) await discardPendingOf(t, agent.ownerId, agent.id);
  await t.query(
    `insert into memory_review_state (agent_id, conversation_id, reviewed_seq)
       select $1, c.id, c.seq from conversations c
        where c.id = $2
           or (c.id = any($3::uuid[]) and ${groupPlaceSql("c")}
               and (c.id in (select conversation_id from memberships where principal_id = $1 and left_seq is null)
                    or c.id in (select conversation_id from memory_review_state where agent_id = $1)))
     on conflict (agent_id, conversation_id) do update set reviewed_seq = greatest(memory_review_state.reviewed_seq, excluded.reviewed_seq)`,
    [agent.id, agent.conversationId, held],
  );
  await t.query(
    `insert into agent_group_state (agent_id, conversation_id, heard_from_seq)
       select $1, c.id, c.seq from memberships m join conversations c on c.id = m.conversation_id
        where m.principal_id = $1 and m.left_seq is null and c.id <> $2 and c.id = any($3::uuid[]) and ${groupPlaceSql("c")}
     on conflict (agent_id, conversation_id) do update set heard_from_seq = greatest(agent_group_state.heard_from_seq, excluded.heard_from_seq)`,
    [agent.id, agent.conversationId, held],
  );
}

/**
 * SQL, `$1` the Agent: the conversations the memory switch writes state rows in — every group it is a current member of, or has a
 * review position or a group state row (`agent_group_state`) in — and its own conversation.
 */
const SWITCH_CONVERSATIONS = `select m.conversation_id from memberships m join conversations sc on sc.id = m.conversation_id
                      where m.principal_id = $1 and m.left_seq is null and (${groupPlaceSql("sc")} or sc.type = 'agent')
                     union select s.conversation_id from memory_review_state s where s.agent_id = $1
                     union select g.conversation_id from agent_group_state g where g.agent_id = $1`;

/** The switch's transaction ran into a group the Agent joined after its groups were taken (`memorySwitched`): run it again. */
export class SwitchAgain extends Error {
  override name = "SwitchAgain";
}

/**
 * Before the switch's transaction takes the Agent's row (agents/routes.ts, before `lockOwnedAgent`, when the update switches `memory`):
 * the rows of the groups `memorySwitched` writes state rows for (`SWITCH_CONVERSATIONS`) `for key share` (the lock those rows'
 * foreign keys take), in id order (conversations/store.ts `lockConversationKeys`, which leaves the Agent's own conversation out:
 * `lockAgent` takes it `for update` next); their ids are returned. A send in a group takes the group's row and then the Agent's
 * (agents/store.ts's lock order): taken first, while nothing else is held, no switch ever holds the Agent while it waits for a group.
 * Nothing is taken for anyone else's Agent.
 */
export async function lockSwitchGroups(t: Tx, ownerId: string, agentId: string): Promise<string[]> {
  const { rows } = await t.query<{ id: string }>(
    `select c.id from conversations c where c.id in (${SWITCH_CONVERSATIONS}) and exists (select 1 from principals p where p.id = $1 and p.owner_id = $2)`,
    [agentId, ownerId],
  );
  return lockConversationKeys(t, rows.map((r) => r.id), { exceptOwnOf: agentId });
}

/**
 * Under the Agent's row: the switch's groups read again, any not among `locked.groups` taken as `memorySwitched` says (`nowait` but on
 * the last try); every group taken is returned.
 */
async function lockJoinedSince(t: Tx, agent: Pick<AgentRow, "id" | "conversationId">, locked: { groups: readonly string[]; wait: boolean }): Promise<string[]> {
  const { rows } = await t.query<{ id: string }>(`select c.id from conversations c where c.id in (${SWITCH_CONVERSATIONS})`, [agent.id]);
  const joined = rows.map((r) => r.id).filter((id) => id !== agent.conversationId && !locked.groups.includes(id));
  try {
    return [...locked.groups, ...(await lockConversationKeys(t, joined, { exceptOwnOf: agent.id, nowait: !locked.wait }))];
  } catch (err) {
    // 55P03 lock_not_available: someone holds it.
    if ((err as { code?: unknown }).code === "55P03") throw new SwitchAgain();
    throw err;
  }
}

/**
 * The transaction prologue of everything that writes an Agent's memory: the Agent's conversation and row locked (the order
 * every writer uses), then `work` — unless the Agent was deleted, paused or turned memory off meanwhile: then nothing
 * happens and null comes back. `groups`: the conversations `work` writes rows that point at (a group review's position and notes,
 * hearsay entries, a dream's split parts that keep a group's origin), taken `for key share` first, in id order, before the Agent's
 * (a send there takes the group, then the Agent; conversations/store.ts `lockConversationKeys`, which leaves the Agent's own out).
 */
export async function inLockedAgent<T>(db: Db, agentId: string, work: (t: Tx, locked: AgentRow) => Promise<T>, groups?: string | readonly string[]): Promise<T | null> {
  return db.tx(async (t) => {
    if (groups !== undefined) await lockConversationKeys(t, typeof groups === "string" ? [groups] : groups, { exceptOwnOf: agentId });
    const locked = await lockAgent(t, agentId);
    if (locked.deleted || locked.paused || !locked.memory) return null;
    return work(t, locked);
  });
}

/** After commit: the notices go out to the owner (never to anyone else). A failure to announce is logged (ids, no text): they are stored. */
export function announce(deps: Pick<PipelineDeps, "conversations" | "log">, notices: readonly StoredMessage[] | null, agentId: string): void {
  if (notices === null || notices.length === 0) return;
  try {
    deps.conversations.publish({ messages: [...notices], conversations: [] }, deps.log);
  } catch (err) {
    deps.log.error({ ...errInfo(err), agentId }, "a memory notice could not be announced after it was stored; it is there when the owner next opens the conversation");
  }
}

/**
 * What this owner has waiting for their yes: texts of added, replaced, merged or split entries, the notes asked to be unlocked, and
 * every note a pending change touches (whatever it does to it), by `noteKey`.
 */
async function pendingOf(db: Db, agent: AgentRow): Promise<{ texts: Array<{ kind: NoteKind; text: string }>; unlocks: Set<string>; touched: Set<string> }> {
  const { rows } = await db.query<{ agent_id: string; ops: StoredOp[] }>("select agent_id, ops from memory_changes where owner_id = $1 and status = 'pending'", [agent.ownerId]);
  const texts: Array<{ kind: NoteKind; text: string }> = [];
  const unlocks = new Set<string>();
  const touched = new Set<string>();
  for (const row of rows) {
    for (const s of row.ops) {
      if (s.noteId) touched.add(noteKey(s.kind, s.noteId));
      for (const r of s.removed ?? []) if (r.noteId) touched.add(noteKey(s.kind, r.noteId));
      // The owner's room is shared by all their Agents; an Agent's own room is its own.
      if (s.kind === "self" && row.agent_id !== agent.id) continue;
      if ((s.op === "add" || s.op === "replace" || s.op === "merge") && s.after) texts.push({ kind: s.kind, text: s.after });
      if (s.op === "split") for (const part of s.parts ?? []) texts.push({ kind: s.kind, text: part.text });
      if (s.op === "unlock" && s.noteId) unlocks.add(s.noteId);
    }
  }
  return { texts, unlocks, touched };
}

/** A note, as `pendingOf` keeps the notes pending changes touch. */
const noteKey = (kind: NoteKind, noteId: string): string => `${kind}|${noteId}`;

/** An op that changes a note in place: what depends on the other such ops of its answer, and what a pending change may already ask about. */
const inPlace = (op: Op): op is Extract<Op, { op: "replace" | "remove" | "lock" }> => op.op === "replace" || op.op === "remove" || op.op === "lock";

/** The kinds a review of `conversationId` may change; in a group the owner's room only for the owner's reviewing Agent there. */
export async function kindsFor(db: Db, agent: AgentRow, conversationId: string, group: boolean): Promise<ReadonlySet<NoteKind>> {
  if (!agent.sharedNotes) return new Set<NoteKind>(["self"]);
  if (!group) return new Set<NoteKind>(["owner", "self"]);
  const seq = await db.query<{ seq: string }>("select seq::text from conversations where id = $1", [conversationId]);
  const listeners = await listenersFor(db, conversationId, Number(seq.rows[0]?.seq ?? 0) + 1);
  const mine = listeners.find((l) => l.ownerId === agent.ownerId);
  return new Set<NoteKind>(mine?.reviewerId === agent.id ? ["owner", "self"] : ["self"]);
}

/**
 * The notice of a change, in the Agent's own conversation with its owner (the Agent is locked, in the transaction): the lines
 * `linesOf` makes of what the change recorded, its status and fullness as stored. A room too full to take anything is only told,
 * never asked about: a pending change with no ops is applied, no card with no lines.
 */
export async function memoryNotice(
  t: Tx,
  locked: AgentRow,
  changeId: string,
  how: { unlock: boolean; phase: "rest" | "dream"; linesOf: (ops: StoredOp[], pending: boolean) => { lines: string[]; vaultLines: boolean[]; sourceLines?: boolean[] } },
): Promise<StoredMessage> {
  const row = (await t.query<{ ops: StoredOp[]; full: boolean; status: "applied" | "pending" }>(`select ops, "full", status from memory_changes where id = $1`, [changeId])).rows[0]!;
  let status = row.status;
  if (status === "pending" && row.ops.length === 0) {
    await t.query("update memory_changes set status = 'applied', resolved_at = now() where id = $1", [changeId]);
    status = "applied";
  }
  const { lines, vaultLines, sourceLines } = how.linesOf(row.ops, status === "pending");
  return appendSystem(t, locked.conversationId, {
    event: "memory_changed",
    actorId: locked.id,
    changeId,
    lines,
    vaultLines,
    ...(sourceLines ? { sourceLines } : {}),
    pending: status === "pending",
    unlock: how.unlock,
    full: row.full,
    status,
    phase: how.phase,
    count: lines.length,
  });
}

/**
 * A review; "refused" when its call was not made because the owner's memory allowance is spent (no failure: it waits for the next site day).
 *
 * What of an answer applies at once, in the owner's own conversation without 先问我再记: its adds; its locks (a lock only makes a note more
 * private, and is undone in one tap: never asked about; never of a note the owner took out of the vault, apply.ts `plan`); with
 * `MEMORY.mergeAuto` "on" (the default), each `merge` op — the answer saying which notes are one thing, ids only (ops.ts) — as the notes'
 * own texts joined (`joinedMerges`; nobody is asked), applied as a dream's merge, ONE change of its own; and the replaces and removes only
 * when none of them needs the owner's word (`needsWords`: a remove needs the owner to have asked, `askedFor`), else they wait together in
 * ONE card. A replace and removes are never read as a merge: they are what they say. The ops that change a note in place stand or fall
 * together; a merge stands apart from them. With "off" a `merge` op is ignored. With 先问我再记 everything waits: a merge as a card of its
 * own; a group only adds.
 */
export async function runReview(deps: PipelineDeps, job: ReviewJob, ctx: ReviewContext): Promise<"refused" | undefined> {
  const { db, config, log } = deps;
  const { agentId, conversationId } = job;
  const agent = await reviewableAgent(db, agentId);
  if (agent === null || ctx.closing.aborted) return;
  if (await inSocial(db, conversationId)) return;
  const group = conversationId !== agent.conversationId;
  const kinds = await kindsFor(db, agent, conversationId, group);
  const { input, seen } = await readReview(db, agent, conversationId, await reviewedSeq(db, agentId, conversationId), { kinds, config, now: new Date(deps.now()) });
  if (input === null) {
    count(db, "review_skipped_no_owner_words");
    // Nothing the owner said to look at: what the read saw is not looked at again, and nothing newer than what it saw is
    // marked (an owner message committed after the read is still to be reviewed).
    if (seen !== null) await markReviewed(db, agentId, conversationId, seen);
    return;
  }
  ctx.attempted(input.upToSeq);
  const pending = await pendingOf(db, agent);

  const report: MemoryCallReport = { answered: false };
  count(db, "review_run");
  let answer = await memoryCall(
    { db, models: deps.models, config, log, inFlight: deps.inFlight },
    agent.ownerId,
    { system: input.system, user: input.user, maxOutputTokens: config.memory.reviewMaxOutputTokens },
    ctx.closing,
    report,
  );
  // Charged for an answer that cannot be used: reviewed all the same (nothing is asked again for the same words).
  if (answer === null && report.answered) answer = "";
  // No answer at all: no model or allowance to call on, the call failed, or the service is stopping (that one is no failure).
  if (answer === null && !ctx.closing.aborted && report.refused !== true) count(db, "review_failed");
  // The owner's calls running were at their cap: a moment later there is room again (once; then it waits for their next words).
  if (answer === null && !ctx.closing.aborted && report.capped === true) ctx.retry?.();
  if (answer === null && !ctx.closing.aborted && report.refused === true) return "refused";
  if (answer === null || ctx.closing.aborted) return;

  const answered = parseOps(answer, new Set(input.refs.keys()), [...input.existing, ...pending.texts.map((p) => p.text)]).filter((op) => allowed(op, kinds, group, input.refs));
  // The ops that change a note in place depend on one another (the room check of one counts on the space another frees), so they are decided as one group,
  // before anything else: when any of them names a note a pending change of this owner already touches (the waiting card already asks
  // about it), or the cleaning refused the text or the shape of one of them (it is gone from `answered`: the others would be half of it), ALL of them
  // are dropped (adds and `seen` still go on). One whose note changed since it was read drops them all too, decided where they are
  // applied (apply.ts `plan`).
  const waits =
    refusedInPlace(answer, new Set(input.refs.keys())) ||
    answered.some((op) => {
      const note = inPlace(op) ? input.refs.get(op.ref) : undefined;
      return note !== undefined && pending.touched.has(noteKey(note.kind, note.id));
    });
  // A merge (`merge` op: which notes are one thing, ids only) is applied on its own, apart from everything else; one naming a note a
  // pending change of this owner touches is dropped (the waiting card already asks about it).
  const merges = answered.filter(
    (op): op is MergeOp =>
      op.op === "merge" &&
      !op.refs.some((ref) => {
        const note = input.refs.get(ref)!;
        return pending.touched.has(noteKey(note.kind, note.id));
      }),
  );
  const ops = (waits ? answered.filter((op) => !inPlace(op)) : answered).filter((op) => op.op !== "merge");
  // With MEMORY.mergeAuto "on" (the default) a merge's notes are joined in their own words, oldest first (`joinedMerges`), nobody is asked.
  // One whose notes say one same thing is no merge, and one whose joined note cannot be written is skipped: either way nothing happens to
  // its notes. With "off" a merge is ignored. The joined notes are not sorted (no judge): their vault state follows their notes'.
  const { joins, skipped } =
    deps.config.memory.mergeAuto === "on" && merges.length > 0 ? joinedMerges(merges, input.refs, await getMemoryLanguage(db, agent.ownerId)) : { joins: [], skipped: 0 };
  const sorted = await sortOps(deps, agent, ops, input.refs, group ? [] : pending.texts, ctx.closing);
  if (ctx.closing.aborted) return;
  // The vault only fills inwards, across notes too: an answer that removes a note in the vault may carry its content into another note,
  // of either room (the Agent's own notes are read in groups too), by a replace's new text or an add (a combine written as replace +
  // remove). Which text took what cannot be told, so every such text of the answer goes into the vault, whatever the sorting and the
  // owner's setting say. It is recorded with the op, applied at once or on a card alike, and a confirmed card applies it as recorded.
  vaultBesideVaultRemoves(ops, input.refs, sorted.vaults);
  // What the owner said again: the notes the answer's adds repeat, by the judgement or word for word, are one stronger (below).
  const mentioned = ops.flatMap((o) => {
    const n = o.op === "seen" ? input.refs.get(o.ref) : undefined;
    return n ? [{ kind: n.kind, id: n.id }] : [];
  });
  const repeats = [...sorted.repeats, ...mentioned, ...(await exactRepeats(deps, agent, kinds, answer, ops))];
  // A `seen` only says the owner mentioned a note again (above): there is nothing in it to apply, record or tell.
  const changing = ops.filter((o) => o.op !== "seen");
  // Judged outside any transaction: for the replaces and removes, whether the owner asked to forget (one request for the answer, when it
  // can matter). A lock needs nothing.
  const asked = await askedFor(deps, agent, inPlaceLeft(changing, true), input, group, ctx.closing);
  if (ctx.closing.aborted) return;

  // What took effect, counted once the transaction has committed (`stats.ts`).
  const made: AppliedOp[] = [];
  let strengthened = 0;
  let mergedNow = 0;
  let joinSkipped = skipped;
  const shown: CardReason[] = [];
  const notices = await inLockedAgent(db, agentId, async (t, locked): Promise<StoredMessage[] | null> => {
    // Memory was switched off and on again while the call was under way (`memorySwitched` moved the position past what it read): what it
    // read was said before memory was switched off, and is never learned.
    if ((await reviewedSeq(t, agentId, conversationId)) >= input.upToSeq) return null;
    const ids = { ownerId: locked.ownerId, agentId };
    // Why each change, if it is a card (pending), waits for the owner (`card_shown_<reason>`); null: never a card.
    const written: Array<{ changeId: string; unlock: boolean; reason: CardReason | null }> = [];
    // Strength is no change anybody is told of: no change row, no notice, `updated_at` untouched (so no undo goes stale).
    const bumped = new Set<string>();
    for (const kind of ["owner", "self"] as const) {
      const ids = [...new Set(repeats.filter((r) => r.kind === kind).map((r) => r.id))].filter((id) => !bumped.has(id));
      for (const id of ids) bumped.add(id);
      await bumpNotes(t, kind === "owner" ? { kind, ownerId: locked.ownerId } : { kind, agentId }, ids);
    }
    strengthened = bumped.size;
    // In the owner's own conversation, without 先问我再记 (`auto`), memory asks as little as it can. A lock is applied at once. So is a merge
    // whose notes are joined (`joins`), as a dream's merge, one change of its own (with 先问我再记 it is a card of its own). The replaces and
    // removes need the owner's words (`needsWords`, `asked`), and they depend on one another (the room check of the one counts on the space
    // the other frees): when ANY of them is held ALL of them are, together in one pending change, the card 先问我再记 produces. Adds apply at
    // once. With 先问我再记 on everything waits anyway; a group review has nothing but adds.
    const auto = !group && !locked.memoryAsk;
    const left = inPlaceLeft(changing, auto);
    const held: Op[] = auto && left.some((op) => needsWords(op, input, asked)) ? left : [];
    const direct = changing.filter((op) => !held.includes(op));
    if (joins.length > 0) {
      // First: what it frees in a room is there for the adds below.
      const notes = joins.flatMap((j) => j.notes);
      const result = await applyDream(t, { ...ids, sharedNotes: locked.sharedNotes, kinds }, joins.map(joinedOp), refsOf(input.refs), {
        conversationId: locked.conversationId,
        status: locked.memoryAsk ? "pending" : "applied",
        phase: "rest",
        // A joined note with a note of it in the vault is in the vault (apply.ts `planDream`); else it stays out, as its notes were.
        vaults: new Map(joins.map((j) => [vaultKey(j.notes[0]!.kind, j.text), { vault: false, unsure: false }])),
        checked: new Set(joins.keys()),
        read: await asReviewed(t, ids, notes),
        resorted: new Map(),
        rooms: roomOf(config),
        // What the review read: the joined note keeps an origin only when that conversation is its notes' origin too.
        heardIn: conversationId,
        // A join its room cannot hold is counted, never told (below): the notice of the others says nothing of it.
        tellFull: false,
      });
      if (result?.changeId) {
        if (!locked.memoryAsk) mergedNow = result.applied.filter((o) => o.op === "merge").length;
        written.push({ changeId: result.changeId, unlock: false, reason: locked.memoryAsk ? "ask_first" : null });
      }
      // A room that cannot take a joined note: nothing happens to its notes, nobody is told.
      joinSkipped += result?.noRoom ?? 0;
    }
    const apply = (list: Op[], status: "applied" | "pending") =>
      applyOps(t, { ...ids, sharedNotes: locked.sharedNotes, kinds }, list, input.refs, {
        conversationId: locked.conversationId,
        originConversationId: conversationId,
        status,
        vaults: sorted.vaults,
        duplicates: sorted.duplicates,
        rooms: roomOf(config),
      });
    if (direct.length > 0) {
      const result = await apply(direct, locked.memoryAsk ? "pending" : "applied");
      if (result && !locked.memoryAsk) made.push(...result.applied);
      if (result?.changeId) written.push({ changeId: result.changeId, unlock: false, reason: locked.memoryAsk ? "ask_first" : null });
      if (result && result.unlocks.length > 0) {
        const targets = result.unlocks.flatMap((ref) => {
          const n = input.refs.get(ref);
          return n && !pending.unlocks.has(n.id) ? [{ kind: n.kind, id: n.id }] : [];
        });
        const unlockId = targets.length > 0 ? await proposeUnlocks(t, ids, locked.conversationId, targets) : null;
        if (unlockId) written.push({ changeId: unlockId, unlock: true, reason: "other" });
      }
    }
    if (held.length > 0) {
      const result = await apply(held, "pending");
      if (result?.changeId) written.push({ changeId: result.changeId, unlock: false, reason: heldFor(held) });
    }
    await markReviewed(t, agentId, conversationId, input.upToSeq);
    const stored: StoredMessage[] = [];
    for (const w of written) {
      const notice = await memoryNotice(t, locked, w.changeId, { unlock: w.unlock, phase: "rest", linesOf });
      if (notice.body.pending === true && w.reason !== null) shown.push(w.reason);
      stored.push(notice);
    }
    return stored;
    // In a group, its position and the notes it adds point at the group's row: taken first (`inLockedAgent`).
  }, group ? conversationId : undefined);
  announce(deps, notices, agentId);
  if (notices !== null) {
    countNoteOps(db, made);
    count(db, "strength_bump", strengthened);
    // Every lock a review applies is one nobody was asked about.
    count(db, "lock_auto", made.filter((o) => o.op === "lock").length);
    count(db, "merge_joined", mergedNow);
    // A merge whose joined note could not be written (too long, or its room full): its notes stay as they were.
    count(db, "merge_join_skipped", joinSkipped);
    for (const reason of shown) count(db, `card_shown_${reason}`);
  }
  // A change that was applied may have left a room nearly full: that room is tidied now rather than at night.
  if (notices?.some((n) => n.body.status === "applied" && n.body.unlock !== true && Array.isArray(n.body.lines) && n.body.lines.length > 0)) ctx.changed?.(agentId);
  // A new topic's words were left for a review of their own: it follows this one.
  if (notices !== null && input.more) ctx.more?.();
  log.info({ metric: "memory_review", agentId, conversationId, ops: ops.length, notices: notices?.length ?? 0 }, "a memory review ended");
}

/**
 * Whether a replace or remove of the owner's own conversation lacks the owner's word and so waits for their yes: a `remove` unless the
 * owner asked, in the review's window, to forget or delete something (`asked`, the judgement's answer); a `replace` unless the window
 * holds an owner line at all and one of them came after the note was last changed. An `add`, a `lock` (always applied at once) or an
 * `unlock` (which is only ever a request) never waits for it.
 */
function needsWords(op: Op, input: Pick<ReviewInput, "ownerAt" | "refs">, asked: boolean): boolean {
  if (op.op === "remove") return !asked;
  if (op.op !== "replace") return false;
  const note = input.refs.get(op.ref);
  return note === undefined || input.ownerAt.length === 0 || !input.ownerAt.some((at) => at > note.updatedAt);
}

/**
 * Whether the owner asked to forget, for the removes among `left` (the answer's replaces and removes once its merges are taken
 * out): the judgement's answer (`ownerAsked`), ONE request for the whole answer, made whatever words the owner used, but only when it can
 * change what is applied at once — in the owner's own conversation (a group review only adds), without 先问我再记 (everything waits then),
 * when `left` holds a remove, not when a replace of `left` waits whatever the answer (no owner line after its note's last change: the ops
 * left stand or fall together), and not once the service is closing (a request under way ends with it). Otherwise nothing is asked: not
 * asked for.
 */
async function askedFor(deps: PipelineDeps, agent: AgentRow, left: Op[], input: ReviewInput, group: boolean, closing: AbortSignal): Promise<boolean> {
  if (group || agent.memoryAsk || closing.aborted || !left.some((op) => op.op === "remove")) return false;
  if (left.some((op) => op.op === "replace" && needsWords(op, input, false))) return false;
  return ownerAsked({ db: deps.db, judge: deps.judge, ownerId: agent.ownerId, config: deps.config, log: deps.log }, input.said, closing);
}

/** Why a card waits for the owner (`card_shown_<reason>`): a remove not asked for, 先问我再记, or anything else (a replace before the owner's word, a request to unlock). */
type CardReason = "remove" | "ask_first" | "other";

/** Why the replaces and removes `held` wait: one is a remove the owner did not ask for, else a replace waits for the owner's word. */
const heldFor = (held: readonly Op[]): CardReason => (held.some((op) => op.op === "remove") ? "remove" : "other");

/** A review's `merge` op: the notes it names are one thing (ops.ts). */
type MergeOp = Extract<Op, { op: "merge" }>;

/** A merge to apply as its notes' own texts joined (`joinNotes`): its notes oldest first (the oldest is the one written into), and the text. */
interface Join {
  refs: string[];
  notes: RefNote[];
  text: string;
}

/**
 * What becomes of an answer's `merge` ops (MEMORY.mergeAuto "on"): each one's notes joined in their own words, oldest first (`createdAt`),
 * in the notebook's language's way (`language`, clean.ts `joinNotes`). A merge whose notes all say the same (after trimming) is no merge,
 * and one whose joined note cannot be written (clean.ts `joinedNote`: longer than an entry may be) is skipped — nothing happens to the
 * notes of either; `skipped` counts the second kind.
 */
function joinedMerges(merges: readonly MergeOp[], refs: ReadonlyMap<string, RefNote>, language: string | null): { joins: Join[]; skipped: number } {
  const joins: Join[] = [];
  let skipped = 0;
  for (const merge of merges) {
    const named = merge.refs.map((ref) => ({ ref, note: refs.get(ref)! })).sort((a, b) => a.note.createdAt.getTime() - b.note.createdAt.getTime());
    const texts = named.map((n) => n.note.text);
    const one = new Set(texts.map((t) => t.trim())).size < 2;
    const text = one ? null : joinedNote(joinNotes(texts, language));
    if (text !== null) joins.push({ refs: named.map((n) => n.ref), notes: named.map((n) => n.note), text });
    else if (!one) skipped++;
  }
  return { joins, skipped };
}

/** An answer's ops in place that are left to the hold rule: not a lock when locks apply at once (`auto`). */
function inPlaceLeft(changing: readonly Op[], auto: boolean): Op[] {
  return changing.filter((op) => inPlace(op) && !(auto && op.op === "lock"));
}

/** A joined merge as the dream's op that applies it (apply.ts `applyDream`): written into the oldest note, its text the notes' own, taken as it is. */
const joinedOp = (j: Join): DreamOp => ({ op: "merge", into: j.refs[0]!, from: j.refs.slice(1), text: j.text, joined: true });

/** The notes a review's refs name, as `applyDream` takes them. */
const refsOf = (refs: ReadonlyMap<string, RefNote>): Map<string, { kind: NoteKind; id: string }> => new Map([...refs].map(([ref, n]) => [ref, { kind: n.kind, id: n.id }]));

/**
 * The exact `updated_at` (write.ts `exactTs`) of each of `notes` now, kept only while it is still the one the review read (`RefNote`'s, to
 * the millisecond a date holds): what a merge's notes are checked against where it is applied (apply.ts `planDream`'s `read`), so that a
 * note changed or gone since the review read it drops the merge, as it drops any op in place (apply.ts `plan`).
 */
async function asReviewed(q: Queryable, ids: { ownerId: string; agentId: string }, notes: ReadonlyArray<RefNote>): Promise<Map<string, string>> {
  const read = new Map<string, string>();
  for (const kind of ["owner", "self"] as const) {
    const mine = notes.filter((n) => n.kind === kind);
    const now = await stampsOf(q, kind === "owner" ? { kind, ownerId: ids.ownerId } : { kind, agentId: ids.agentId }, mine.map((n) => n.id));
    for (const n of mine) {
      const at = now.get(n.id)?.updatedAt;
      if (at !== undefined && Date.parse(at) === n.updatedAt.getTime()) read.set(n.id, at);
    }
  }
  return read;
}

/**
 * Whether an op may be applied here: in a group only an addition (or a note's `seen`); only to a room this review may change; a `merge`
 * only of notes of one room, never in a group.
 */
function allowed(op: Op, kinds: ReadonlySet<NoteKind>, group: boolean, refs: Map<string, RefNote>): boolean {
  if (op.op === "add") return kinds.has(op.kind);
  if (op.op === "merge") {
    if (group) return false;
    const notes = op.refs.map((ref) => refs.get(ref));
    return notes.every((n) => n !== undefined && n.kind === notes[0]!.kind && kinds.has(n.kind));
  }
  // That the owner mentioned a note again is no change to it: also in a group.
  if (group && op.op !== "seen") return false;
  const target = refs.get(op.ref);
  return target !== undefined && kinds.has(target.kind);
}

/**
 * When `ops` remove a note in the vault, each `replace`'s new text and each `add`'s text among them, of either room, is put in the vault
 * (`vaults`, by `vaultKey`, `unsure` false), whatever its sorting said. A text that carries a vault note's content while the answer does
 * not remove that note cannot be told: the sorting alone decides it.
 */
function vaultBesideVaultRemoves(ops: readonly Op[], refs: ReadonlyMap<string, RefNote>, vaults: Map<string, { vault: boolean; unsure: boolean }>): void {
  if (!ops.some((op) => op.op === "remove" && refs.get(op.ref)?.vault === true)) return;
  for (const op of ops) {
    const kind = op.op === "replace" ? refs.get(op.ref)?.kind : op.op === "add" ? op.kind : undefined;
    if ((op.op === "replace" || op.op === "add") && kind !== undefined) vaults.set(vaultKey(kind, op.text), { vault: true, unsure: false });
  }
}

/** The duplicate test and the vault sorting for what the ops add or replace, outside any transaction. */
async function sortOps(
  deps: PipelineDeps,
  agent: AgentRow,
  ops: Op[],
  refs: Map<string, RefNote>,
  pending: ReadonlyArray<{ kind: NoteKind; text: string }>,
  closing: AbortSignal,
): Promise<{ vaults: Map<string, { vault: boolean; unsure: boolean }>; duplicates: Set<string>; repeats: Array<{ kind: NoteKind; id: string }> }> {
  const vaults = new Map<string, { vault: boolean; unsure: boolean }>();
  const duplicates = new Set<string>();
  const repeats: Array<{ kind: NoteKind; id: string }> = [];
  if (ops.every((o) => o.op !== "add" && o.op !== "replace")) return { vaults, duplicates, repeats };
  const { db, config, log } = deps;
  const sortDeps: SortDeps = { db, judge: deps.judge, ownerId: agent.ownerId, config, log };
  const setting = await getNewNotes(db, agent.ownerId);
  // Newest first: what a new note most likely repeats; what waits for the owner's yes counts as known.
  const known = (kind: NoteKind): KnownNote[] => [
    ...pending.flatMap((p, i) => (p.kind === kind ? [{ id: `pending-${i}`, text: p.text }] : [])).reverse(),
    ...[...refs.values()].filter((n) => n.kind === kind).reverse(),
  ];
  for (const op of ops) {
    if (closing.aborted) break;
    if (op.op === "add") {
      const same = await duplicateOf(sortDeps, op.text, known(op.kind));
      if (same !== null) {
        duplicates.add(op.text);
        // A repeat of a note (not of what only waits for the owner's yes) makes that note stronger.
        const note = [...refs.values()].find((n) => n.id === same);
        if (note) repeats.push({ kind: note.kind, id: note.id });
      } else vaults.set(vaultKey(op.kind, op.text), await sortNote(sortDeps, op.text, op.kind, setting));
    } else if (op.op === "replace") {
      const target = refs.get(op.ref);
      // A note inside the vault stays inside whatever the new text says: nothing to ask.
      if (target && !target.vault) vaults.set(vaultKey(target.kind, op.text), await sortNote(sortDeps, op.text, target.kind, setting));
    }
  }
  return { vaults, duplicates, repeats };
}

/**
 * The notes the answer's `add`s repeat word for word (case, whitespace and punctuation aside): `parseOps` drops such an add
 * (it is not new), and what the owner said again is what makes the note stronger. Only notes of the rooms this review may
 * change, whether or not it was shown them (in a group the vault is not shown, but is repeated all the same).
 */
async function exactRepeats(deps: PipelineDeps, agent: AgentRow, kinds: ReadonlySet<NoteKind>, answer: string, kept: Op[]): Promise<Array<{ kind: NoteKind; id: string }>> {
  const parsed = parseAnswer(answer);
  const list = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as { ops?: unknown }).ops : undefined;
  if (!Array.isArray(list)) return [];
  const keptKeys = new Set(kept.flatMap((o) => (o.op === "add" ? [sameKey(o.text)] : [])));
  const said = new Set<string>();
  for (const raw of lookedAt(list)) {
    if (typeof raw !== "object" || raw === null) continue;
    const { op, kind, text } = raw as { op?: unknown; kind?: unknown; text?: unknown };
    if (op !== "add" || (kind !== "owner" && kind !== "self") || !kinds.has(kind) || typeof text !== "string") continue;
    const clean = modelNote(text);
    if (clean !== null && !keptKeys.has(sameKey(clean))) said.add(sameKey(clean));
  }
  if (said.size === 0) return [];
  const rooms: Array<[NoteKind, Array<{ id: string; text: string }>]> = [
    ["owner", kinds.has("owner") && agent.sharedNotes ? await listOwnerNotes(deps.db, agent.ownerId) : []],
    ["self", kinds.has("self") ? await listAgentNotes(deps.db, agent.id) : []],
  ];
  return rooms.flatMap(([kind, notes]) => notes.filter((n) => said.has(sameKey(n.text))).map((n) => ({ kind, id: n.id })));
}
