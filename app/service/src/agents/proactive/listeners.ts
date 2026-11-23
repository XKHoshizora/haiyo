import type { Queryable } from "../../db.ts";
import { socialPlaceSql } from "../../social/place.ts";
import { labelName } from "../runtime/prompt.ts";

/**
 * The Agents that listen in a group for what is said about their owner (the memory plan, Task 8): the judgement that
 * decides who replies unasked is also asked, on their behalf, whether someone else just said something lasting about the
 * owner (`hearsay`) and whether the owner just said something lasting about themselves (`own`). A listener is one owner:
 * all that owner's Agents in the group share the questions. What the answers raise are rows of `memory_flags`, read later
 * by the reviewer; nothing here writes a note.
 */

/** The most owners one judgement listens for: two questions each, and a judgement holds only so many. */
export const MAX_LISTENERS = 20;

/** One owner whose Agents listen in the group. */
export interface Listener {
  /** `h1`, `h2`, … in owner id order; the hearsay question's key (the owner's own question is `{key}o`). */
  key: string;
  ownerId: string;
  /** The owner's name as a label shows it (`labelName`). */
  ownerName: string;
  /** The owner's Agents in the group that listen (memory on), in id order. */
  agentIds: string[];
  /** The latest seq any of them joined at: nothing from before it may be shown. */
  joinedSeq: number;
  /** The Agent that reviews the owner's own remarks here: memory on, shared notes on, the lowest id; null: none. */
  reviewerId: string | null;
  /**
   * Where each of `agentIds` hears from in the group, by Agent id (`agent_group_state.heard_from_seq`, 0 without a row): a line is
   * heard for an Agent — flagged for it — only when its seq is above this, besides being new to the judgement. The memory switch
   * moves it for the switching Agent alone (memory/pipeline.ts `memorySwitched`), so that no owner's switch changes what another
   * owner's Agents hear. While the Agent has a catch-up there (`memory_catchups`, memory/catchup.ts), the group's judgement hears for
   * it only after the catch-up's end: the lines up to it are the catch-up's.
   */
  heardFrom: Record<string, number>;
}

/** Where Agent `agentId` of listener `l` hears from (0: no row, from its joining). */
export const heardFromOf = (l: Pick<Listener, "heardFrom">, agentId: string): number => l.heardFrom[agentId] ?? 0;

/** A flagged message, as `memory_flags` stores it. */
export interface MemoryFlag {
  agentId: string;
  conversationId: string;
  seq: number;
  kind: "hearsay" | "own";
}

/**
 * The owners whose Agents listen to the group at message `seq`: current Agent members that joined before it, with memory
 * on, not paused or deleted, whose owner is a current member too — one listener per owner, at most `MAX_LISTENERS` (those judged here least recently, never
 * first: `agent_group_state.judged_at`), keyed and returned in owner id order. `only.ownerId`: that owner's listener alone (a catch-up).
 */
export async function listenersFor(q: Queryable, conversationId: string, seq: number, only: { ownerId?: string } = {}): Promise<Listener[]> {
  const { rows } = await q.query<{ owner_id: string; name: string; handle: string; agent_ids: string[]; joined_seq: string; reviewer_id: string | null; heard_from: string[] }>(
    `select x.* from (
       select o.id as owner_id, o.display_name as name, o.handle::text as handle,
              array_agg(p.id order by p.id) as agent_ids, max(m.joined_seq)::text as joined_seq,
              (array_agg(p.id order by p.id) filter (where a.shared_notes))[1] as reviewer_id,
              array_agg(greatest(coalesce(s.heard_from_seq, 0), coalesce(cu.to_seq, 0))::text order by p.id) as heard_from
         from memberships m
         join principals p on p.id = m.principal_id
         join agents a on a.principal_id = p.id
         join principals o on o.id = p.owner_id
         left join agent_group_state s on s.agent_id = p.id and s.conversation_id = m.conversation_id
         left join memory_catchups cu on cu.agent_id = p.id and cu.conversation_id = m.conversation_id
        where m.conversation_id = $1 and m.left_seq is null and m.joined_seq < $2 and p.kind = 'agent'
          and a.memory and not a.paused and a.deleted_at is null and ($4::uuid is null or p.owner_id = $4)
          and exists (select 1 from memberships om where om.conversation_id = m.conversation_id and om.principal_id = p.owner_id and om.left_seq is null)
        group by o.id, o.display_name, o.handle
        order by min(coalesce(s.judged_at, '-infinity'::timestamptz)), o.id
        limit $3) x
      order by x.owner_id`,
    [conversationId, seq, MAX_LISTENERS, only.ownerId ?? null],
  );
  return rows.map((r, i) => ({
    key: `h${i + 1}`,
    ownerId: r.owner_id,
    ownerName: labelName(r.name, r.handle),
    agentIds: r.agent_ids,
    joinedSeq: Number(r.joined_seq),
    reviewerId: r.reviewer_id,
    heardFrom: Object.fromEntries(r.agent_ids.map((id, j) => [id, Number(r.heard_from[j] ?? 0)])),
  }));
}

/**
 * Writes `flags` (rows already there are left as they are) and returns those it wrote. A flag for an Agent that no longer
 * listens (left, memory off, deleted) or a conversation that is gone is not written: the flag would be read by nobody. Nor is
 * a hearsay flag of a message whose sender the Agent's owner has muted (`hearsay_mutes`, memory/hearsay.ts) for now, nor a flag
 * of a line at or before where the Agent hears from (`heard_from_seq`, read here as it is now: a switch of its memory between the
 * judgement's question and this write counts), nor — from the group's judgement — of a line at or before the end of a catch-up the
 * Agent has there (`memory_catchups`: those lines are the catch-up's, so none is flagged twice). `catchUp`: the catch-up's own flags.
 */
export async function writeFlags(q: Queryable, flags: readonly MemoryFlag[], opts: { catchUp?: boolean } = {}): Promise<MemoryFlag[]> {
  if (flags.length === 0) return [];
  const { rows } = await q.query<{ agent_id: string; conversation_id: string; seq: string; kind: "hearsay" | "own" }>(
    `insert into memory_flags (agent_id, conversation_id, seq, kind)
     select f.agent_id, f.conversation_id, f.seq, f.kind
       from unnest($1::uuid[], $2::uuid[], $3::bigint[], $4::text[]) as f (agent_id, conversation_id, seq, kind)
       join agents a on a.principal_id = f.agent_id and a.memory and a.deleted_at is null
       join memberships m on m.principal_id = f.agent_id and m.conversation_id = f.conversation_id and m.left_seq is null
       -- no social conversation holds a flag, whoever writes (A-4 review m10): scope is enforced by the query
       join conversations fc on fc.id = f.conversation_id and not ${socialPlaceSql("fc")}
       left join agent_group_state s on s.agent_id = f.agent_id and s.conversation_id = f.conversation_id
       left join memory_catchups cu on cu.agent_id = f.agent_id and cu.conversation_id = f.conversation_id
      where f.seq > greatest(coalesce(s.heard_from_seq, 0), case when $5::boolean then 0 else coalesce(cu.to_seq, 0) end)
        and not (f.kind = 'hearsay' and exists (
              select 1 from messages x
                join principals ap on ap.id = f.agent_id
                join hearsay_mutes hm on hm.owner_id = ap.owner_id and hm.speaker_id = x.sender_id and hm.until > now()
               where x.conversation_id = f.conversation_id and x.seq = f.seq))
     on conflict do nothing
     returning agent_id, conversation_id, seq::text as seq, kind`,
    [flags.map((f) => f.agentId), flags.map((f) => f.conversationId), flags.map((f) => f.seq), flags.map((f) => f.kind), opts.catchUp === true],
  );
  return rows
    .map((r) => ({ agentId: r.agent_id, conversationId: r.conversation_id, seq: Number(r.seq), kind: r.kind }))
    .sort((a, b) => a.seq - b.seq || a.kind.localeCompare(b.kind) || a.agentId.localeCompare(b.agentId));
}
