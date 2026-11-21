import { VISIBLE_JOIN } from "../../conversations/store.ts";
import type { Queryable } from "../../db.ts";
import { notAcknowledgement, type AttachmentRef } from "../../messages/model.ts";
import { postingRun } from "../../messages/read.ts";
import { handleOf } from "../../principals/store.ts";
import { OWNER_WORD, personLabel, speakerRole } from "../runtime/prompt.ts";
import { withoutCitations } from "../tools/refs.ts";
import { GONE_PERSON, mapItems, SECTIONS, SHOWN_SELF, whoIn, type Item, type Person, type Sections } from "./prompt.ts";

/**
 * The rolling summary's rows (migrations 052, 059; README "The rolling summary"): one per conversation and Agent. What
 * reads it is the reply's context (agents/context.ts `loadContext`, which decides whether a reply may be shown it) and the
 * job that updates it (job.ts); what deletes it, a new topic and the end of the Agent's membership of a group. Nothing
 * else reads it: no route, no search, no tool, no memory review.
 *
 * Also the one reader of the messages a summary is made of (`readPlaced`, `countPlaced`): by their *place* — a message's
 * seq, and for an Agent's reply posted by a run the seq that run covered (messages/read.ts `postingRun`), as the reply's
 * context orders them (agents/context.ts `loadPage`'s `answers`) — so that a reply always falls on the side of the question it
 * answered: a boundary of what is summarised never splits an exchange. A tool call and its result are never among them: they
 * live in one reply's rounds (agents/runtime/loop.ts) and are never stored as messages. And of how a summary names the
 * accounts its items name (`peopleNow`).
 */

/**
 * Whose messages are read for Agent `agentId`'s summary of `conversationId` (`group`: a group's), with the Agent as reader
 * (`VISIBLE_JOIN`: nothing from before it joined): in its own conversation its owner's (`ownerId`) and its own, in a group
 * everyone's; text and file messages only, never a notice nor the fixed greeting.
 */
export interface PlacedReader {
  agentId: string;
  ownerId: string;
  conversationId: string;
  group: boolean;
}

/** `$1` the Agent, `$2` the conversation, `$3`/`$4` the places (after, up to and with), `$5` group, `$6` the owner. */
const PLACED_FROM = `from messages m ${VISIBLE_JOIN}
  left join agent_runs r on m.sender_id = $1 and ${postingRun("m", "r")}`;
const PLACED_WHERE = `where m.conversation_id = $2 and m.kind in ('text', 'file') and (m.body -> 'fixed') is distinct from 'true'::jsonb
    and ${notAcknowledgement("m")}
    and m.seq > $3 and coalesce(r.covers_seq, m.seq) > $3 and coalesce(r.covers_seq, m.seq) <= $4
    and ($5::boolean or m.sender_id in ($1, $6))`;

const placedParams = (r: PlacedReader, after: number, upto: number) => [r.agentId, r.conversationId, after, upto, r.group, r.ownerId];

/**
 * How many messages `r` reads whose place is after `after` and at most `upto` — of them, with `maxSeq`, only those stored at
 * or before seq `maxSeq` (a read bounded on both sides; agents/context.ts counts the rest from what it loaded).
 */
export async function countPlaced(q: Queryable, r: PlacedReader, after: number, upto: number, maxSeq?: number): Promise<number> {
  if (upto <= after) return 0;
  const { rows } = await q.query<{ n: number }>(`select count(*)::int as n ${PLACED_FROM} ${PLACED_WHERE} and ($7::bigint is null or m.seq <= $7::bigint)`, [
    ...placedParams(r, after, upto),
    maxSeq ?? null,
  ]);
  return rows[0]?.n ?? 0;
}

/** A message as a summary reads it: its place, who sent it (their account), its text and its attachment. */
export interface PlacedMessage {
  at: number;
  seq: number;
  senderId: string;
  text: string;
  attachment: AttachmentRef | null;
}

/** The first `limit` messages `r` reads whose place is after `after` and at most `upto`, by place and then seq. */
export async function readPlaced(q: Queryable, r: PlacedReader, after: number, upto: number, limit: number): Promise<PlacedMessage[]> {
  if (upto <= after) return [];
  const { rows } = await q.query<{ at: string; seq: string; sender_id: string; text: string | null; attachment: AttachmentRef | null }>(
    `select coalesce(r.covers_seq, m.seq)::text as at, m.seq::text as seq, m.sender_id, m.body ->> 'text' as text, m.body -> 'attachment' as attachment
       ${PLACED_FROM}
      ${PLACED_WHERE}
      order by coalesce(r.covers_seq, m.seq), m.seq
      limit $7`,
    [...placedParams(r, after, upto), limit],
  );
  return rows.map((row) => ({ at: Number(row.at), seq: Number(row.seq), senderId: row.sender_id, text: row.text ?? "", attachment: row.attachment }));
}

/**
 * Agent `agentId`'s current stay in `conversationId`, in one read: where its membership began (`joined`, the visibility rule's
 * `joined_seq`) and the latest new topic it can see there (`topic`, the seq of the latest `topic_reset` after it; 0 when none).
 * Null when it is not a member there now. What a reply's context starts after (agents/context.ts `loadContext`) and where
 * a summary may begin (`summaryBase`) are both read from it.
 */
export async function stayOf(q: Queryable, agentId: string, conversationId: string): Promise<{ joined: number; topic: number } | null> {
  const { rows } = await q.query<{ joined: string; topic: string }>(
    `select ms.joined_seq::text as joined,
            coalesce((select max(m.seq) from messages m
                       where m.conversation_id = ms.conversation_id and m.seq > ms.joined_seq
                         and m.kind = 'system' and m.body ->> 'event' = 'topic_reset'), 0)::text as topic
       from memberships ms
      where ms.conversation_id = $2 and ms.principal_id = $1 and ms.left_seq is null`,
    [agentId, conversationId],
  );
  return rows[0] ? { joined: Number(rows[0].joined), topic: Number(rows[0].topic) } : null;
}

/** Where a stay's summary may begin: after the later of its joining and its latest new topic (`stayOf`); null with no stay. */
export const baseOf = (stay: { joined: number; topic: number } | null): number | null => (stay === null ? null : Math.max(stay.joined, stay.topic));

/** `baseOf` the Agent's current stay, read now: a summary covers only what is after it. Null when the Agent is not a member there. */
export const summaryBase = async (q: Queryable, agentId: string, conversationId: string): Promise<number | null> => baseOf(await stayOf(q, agentId, conversationId));

/**
 * A pair's summary: `items` cover the messages its Agent could see whose place in the conversation (`position`: a message's
 * seq; an Agent's reply, the seq its run covered) is from `fromSeq` to `uptoSeq`, both included — each item's `who` the
 * account that said or settled it (null: nobody in particular). `items` is null for a row written before migration 059,
 * which holds text only: it is shown to no reply and no job builds on it (job.ts writes it anew from the messages).
 */
export interface Summary {
  fromSeq: number;
  uptoSeq: number;
  items: Sections | null;
}

/** An account id as `items` holds one (anything else is no account: such an item is not read). */
const ACCOUNT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A row's `items` as stored, in the sections' order; null when there are none (a row written before migration 059). */
function storedItems(raw: unknown): Sections | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const at = raw as Record<string, unknown>;
  const items = {} as Sections;
  for (const k of SECTIONS) {
    const list: unknown[] = Array.isArray(at[k]) ? at[k] : [];
    items[k] = list.flatMap((i): Item[] => {
      if (typeof i !== "object" || i === null) return [];
      const { who, text } = i as { who?: unknown; text?: unknown };
      if (typeof text !== "string" || !(who === null || (typeof who === "string" && ACCOUNT.test(who)))) return [];
      return [{ who, text }];
    });
  }
  return items;
}

/** The summary of Agent `agentId` in `conversationId`, or null. A plain read. */
export async function readSummary(q: Queryable, conversationId: string, agentId: string): Promise<Summary | null> {
  const { rows } = await q.query<{ from_seq: string; upto_seq: string; items: unknown }>(
    "select from_seq::text, upto_seq::text, items from conversation_summaries where conversation_id = $1 and agent_id = $2",
    [conversationId, agentId],
  );
  const row = rows[0];
  return row ? { fromSeq: Number(row.from_seq), uptoSeq: Number(row.upto_seq), items: storedItems(row.items) } : null;
}

/**
 * How the summary of `r`'s pair names each of `ids` (accounts) now, in one read of those accounts: the Agent itself
 * `self` (`SELF_WORD` to the call that writes it, `SHOWN_SELF` to a reply), role `助手`; its owner, by account only, role
 * `主人` — in a group by the roster's label (runtime/prompt.ts `personLabel`, `主人（名字（@账号））`), in its own
 * conversation `主人`; anyone else by the roster's label `名字（@账号）` (the name and handle of now, whether or not they are
 * in the group now), role `Agent` or `群成员` by account (`speakerRole`); an account that is no longer there
 * `GONE_PERSON`.
 */
export async function peopleNow(q: Queryable, r: PlacedReader, ids: readonly string[], self: string): Promise<Map<string, Person>> {
  const asked = ids.filter((id) => id !== r.agentId && (r.group || id !== r.ownerId));
  const { rows } =
    asked.length === 0
      ? { rows: [] }
      : await q.query<{ id: string; name: string; handle: string; kind: "human" | "agent" }>(
          `select p.id, p.display_name as name, ${handleOf("p")} as handle, p.kind from principals p where p.id = any($1::uuid[])`,
          [asked],
        );
  const found = new Map(rows.map((p) => [p.id, p]));
  return new Map(
    ids.map((id): [string, Person] => {
      if (id === r.agentId) return [id, { label: self, role: "助手" }];
      if (id === r.ownerId && !r.group) return [id, { label: OWNER_WORD, role: "主人" }];
      const p = found.get(id);
      if (p === undefined) return [id, { label: GONE_PERSON, role: "群成员" }];
      const role = speakerRole(p.id, p.kind, r.ownerId);
      return [id, { label: personLabel(withoutCitations(p.name), withoutCitations(p.handle), role === "你的主人"), role: role === "你的主人" ? "主人" : role }];
    }),
  );
}

/**
 * The pair's stored summary `s` as a reply is shown it (final review I-3; redesign B): each item's `who` the label its
 * account has now (`peopleNow`, the Agent itself `SHOWN_SELF`) — so a rename changes how an item is shown, never whose it
 * is — and its text without any citation (tools/refs.ts `withoutCitations`). One indexed read of the accounts it names
 * (none when it names nobody), nothing of the conversation's history. Null for a row written before migration 059 (text
 * only): no reply is shown it until a job has written it anew. Read only: the row is never written back.
 */
export async function shownSummary(q: Queryable, r: PlacedReader, s: Summary): Promise<Sections | null> {
  if (s.items === null) return null;
  const people = await peopleNow(q, r, whoIn(s.items), SHOWN_SELF);
  return mapItems(s.items, (id) => people.get(id)!.label, withoutCitations);
}

/**
 * Stores the pair's summary as `s` (inserted, or replacing the one there), in the caller's transaction: its items; a row
 * written before migration 059 that it replaces loses its text and its 056 `speakers` record (both unused).
 */
export async function writeSummary(q: Queryable, conversationId: string, agentId: string, s: Summary & { items: Sections }): Promise<void> {
  await q.query(
    `insert into conversation_summaries (conversation_id, agent_id, from_seq, upto_seq, items, text, speakers, updated_at)
     values ($1, $2, $3, $4, $5::jsonb, null, null, now())
     on conflict (conversation_id, agent_id) do update
       set from_seq = excluded.from_seq, upto_seq = excluded.upto_seq, items = excluded.items, text = null, speakers = null, updated_at = now()`,
    [conversationId, agentId, s.fromSeq, s.uptoSeq, JSON.stringify(s.items)],
  );
}

/**
 * Deletes the summaries of `conversationId` of whichever of `principalIds` are Agents, in the caller's transaction: a new
 * topic (its Agent), and the end of memberships of a group (everyone who left: only an Agent has one).
 */
export async function forgetSummaries(q: Queryable, conversationId: string, principalIds: readonly string[]): Promise<void> {
  if (principalIds.length === 0) return;
  await q.query("delete from conversation_summaries where conversation_id = $1 and agent_id = any($2::uuid[])", [conversationId, [...new Set(principalIds)]]);
}
