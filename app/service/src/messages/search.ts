import { VISIBLE_JOIN } from "../conversations/store.ts";
import type { Db, Queryable, Tx } from "../db.ts";
import { MESSAGE_COLUMNS, toStored, type MessageRow, type WireMessage } from "./model.ts";
import { principalsOf, type SyncPrincipal } from "./principals.ts";
import { toWireFor, type ReadConfig } from "./read.ts";
import { handleOf } from "../principals/store.ts";

/** Searches one principal may have running at once, both routes together; one more is 429 `rate_limited`. */
export const MAX_CONCURRENT_SEARCHES = 2;
/**
 * Searches everyone together may have running at once (each holds one of the pool's 10 connections for up to
 * the search timeout); one more is 503 `busy`, unless its caller is at their own cap (then 429).
 */
export const MAX_SEARCHES_IN_FLIGHT = 4;

/**
 * Runs one search in a read-only transaction of its own whose statements Postgres cancels after
 * `timeoutMs` (`statement_timeout`, local to the transaction): a 1–2 character or CJK term can make the
 * trigram index useless and scan a lot of history. The cancellation is answered 503 `busy` (errors.ts).
 */
export function inSearchBudget<T>(db: Db, timeoutMs: number, search: (t: Tx) => Promise<T>): Promise<T> {
  return db.tx(async (t) => {
    await t.query("set transaction read only");
    await t.query("select set_config('statement_timeout', $1, true)", [String(timeoutMs)]);
    return search(t);
  });
}

/**
 * What is searched: the message text (captions included) and a file message's attachment name; system
 * notices never. These expressions are the ones indexed by migrations/007_search.sql.
 */
export const matchOn = (param: number): string =>
  `(m.kind in ('text', 'file') and ((m.body ->> 'text') ilike $${param} escape '\\' or ((m.body -> 'attachment') ->> 'name') ilike $${param} escape '\\'))`;

/** `%q%` for ILIKE with `%`, `_` and the escape character itself taken literally. */
export function containsPattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, "\\$&")}%`;
}

export interface SearchOptions {
  q: string;
  limit: number;
}

export interface ConversationSearchPage {
  /** Newest first. */
  messages: WireMessage[];
  /** Pass as `before` for the next older page; null when no older hit exists. */
  nextBefore: number | null;
  /** Everyone the hits name (authors, visible quotes), by id. */
  principals: Record<string, SyncPrincipal>;
}

/**
 * Hits in one conversation, newest first. Null when the reader is not currently in it (never, left,
 * removed, no such conversation). Membership, VISIBLE_JOIN and the match are one statement; rendering
 * re-checks visibility per reader, so quotes of messages they cannot see stay hidden.
 */
export async function searchConversation(
  q: Queryable,
  readerId: string,
  conversationId: string,
  { q: term, before, limit }: SearchOptions & { before?: number },
  config: ReadConfig,
): Promise<ConversationSearchPage | null> {
  const { rows } = await q.query<MessageRow | { [K in keyof MessageRow]: null }>(
    `select ${MESSAGE_COLUMNS}
       from memberships me
       left join lateral (
         select m.* from messages m ${VISIBLE_JOIN}
          where m.conversation_id = me.conversation_id
            and ($3::bigint is null or m.seq < $3::bigint)
            and ${matchOn(4)}
          order by m.seq desc limit $5
       ) m on true
      where me.conversation_id = $2 and me.principal_id = $1 and me.left_seq is null
      order by m.seq desc`,
    [readerId, conversationId, before ?? null, containsPattern(term), limit + 1],
  );
  if (rows.length === 0) return null; // not a current member
  const found = rows.filter((r): r is MessageRow => r.id !== null);
  const page = found.slice(0, limit).map(toStored);
  const messages = await toWireFor(q, readerId, page, config);
  return {
    messages,
    nextBefore: found.length > limit ? page[page.length - 1]!.seq : null,
    principals: await principalsOf(q, messages),
  };
}

// --- an Agent's search (agents/tools/search.ts) ------------------------------------------------------

/** What `searchRows` looks through: the conversations, the words and the filters, and in a group reply its window. */
export interface SearchRowsOptions {
  /** The conversations searched, and no other: the reader must also see each message (VISIBLE_JOIN). */
  conversationIds: readonly string[];
  /** The words, matched as the routes match them (`matchOn`: a substring of the text or the file's name, any case). */
  term: string;
  /** Only the sender this names (`senderNamed`); null: anyone. */
  from: string | null;
  /** Only messages sent before the start of this day (`YYYY-MM-DD`), or after its end, in `timeZone`; null: no bound. */
  before: string | null;
  after: string | null;
  timeZone: string;
  /**
   * In `conversationId` only what a group reply may be shown (agents/context.ts `askerLine`): messages after `after` and
   * at most `upTo` (what the reply had heard when it began), and the calls it answers (`calls`, whatever their seq) — one
   * at or before `after` by its text only, never by its file's name (the reply is shown such a call as its text only).
   * Null: the whole of every conversation searched.
   */
  window: { conversationId: string; after: number; upTo: number; calls: readonly number[] } | null;
  /**
   * Besides the reader, only what this principal can read now too (a current member, the message after their joining:
   * the visibility rule with them as reader) — the owner shown what an Agent found elsewhere (agents/tools/elsewhere.ts).
   * Absent or null: the reader alone decides.
   */
  alsoVisibleTo?: string | null;
  /**
   * A reply's own search (agents/tools/search.ts): never the messages reply run `runId` answers in `conversationId` — the
   * calls it answers (`call_seqs`; its `covers_seq` when not known) and the latest message it covers (`covers_seq`) —
   * which its model is shown already (item E: a question would otherwise match itself, and nothing would ever be "not
   * found" there). Read in this same statement, so `limit` (and the paging flag made of it) counts what is left. Absent
   * or null: nothing is left out.
   */
  answering?: { runId: string; conversationId: string } | null;
  limit: number;
}

/** A message `searchRows` found: what a result is made of. Its text and its file's name only — never anything else of its body. */
export interface SearchRow {
  conversation_id: string;
  seq: string;
  created_at: Date;
  sender_id: string;
  text: string | null;
  /** A file message's attachment. */
  attachment: { id: string; name: string } | null;
  sender_name: string;
  /** As everyone is shown it (`handleOf`: an Agent's is `owner.name`). */
  sender_handle: string;
  sender_kind: "human" | "agent";
  /** The conversation's title (a group's; null when it has none). */
  title: string | null;
  conversation_type: string;
}

/** SQL, inside `senderNamed`: whether principal `p` (an alias) is a current member of conversation `c` that is no deleted Agent. */
const memberNow = (p: string, c: string): string =>
  `exists (select 1 from memberships fm where fm.conversation_id = ${c} and fm.principal_id = ${p}.id and fm.left_seq is null)
   and not exists (select 1 from agents fd where fd.principal_id = ${p}.id and fd.deleted_at is not null)`;

/**
 * SQL: whether the sender `sp` (a `principals` alias) of message `m` (a `messages` alias) is whom `from` names (a parameter
 * position: the model's `from`, cleaned) — the one rule for an Agent's search and for the hook that looks elsewhere with
 * its filters (final review m-1): a handle as everyone is shown it, any case (`handleOf`: a person's own, an Agent's
 * `owner.name`); a display name, exactly; or an Agent's name part alone where a typed `@name` would call it in the
 * message's conversation (agents/mentions.ts `namedIn`): the Agent is a current member there, and no other current member
 * is named so first — no person by that handle or display name (trimmed, any case), no other Agent by that name part.
 */
export const senderNamed = (sp: string, m: string, from: string): string =>
  `(lower(${handleOf(sp)}) = lower(${from}) or ${sp}.display_name = ${from}
    or (${sp}.kind = 'agent' and lower(${sp}.handle::text) = lower(${from}) and ${memberNow(sp, `${m}.conversation_id`)}
        and not exists (select 1 from memberships fo join principals fp on fp.id = fo.principal_id
                         where fo.conversation_id = ${m}.conversation_id and fo.left_seq is null and fp.id <> ${sp}.id
                           and case when fp.kind = 'human' then lower(fp.handle::text) = lower(${from}) or lower(btrim(fp.display_name)) = lower(${from})
                                    else lower(fp.handle::text) = lower(${from}) and not exists (select 1 from agents fx where fx.principal_id = fp.id and fx.deleted_at is not null) end)))`;

/**
 * The messages that match among `conversationIds` (and only those: the list is a parameter of the one statement) as
 * `readerId` sees them now (VISIBLE_JOIN: current members only, nothing from before they joined), text and file messages
 * but the fixed greeting, by the filters and the window, the newest first (by when they were sent), at most `limit`.
 * Rows, not wire messages: what an Agent's search tool turns into its results. Run it inside `inSearchBudget`.
 */
export async function searchRows(q: Queryable, readerId: string, o: SearchRowsOptions): Promise<SearchRow[]> {
  const { rows } = await q.query<SearchRow>(
    `select m.conversation_id, m.seq::text as seq, m.created_at, m.sender_id, m.body ->> 'text' as text,
            case when m.kind = 'file' then m.body -> 'attachment' end as attachment,
            sp.display_name as sender_name, ${handleOf("sp")} as sender_handle, sp.kind as sender_kind,
            c.title, c.type as conversation_type
       from messages m ${VISIBLE_JOIN}
       join principals sp on sp.id = m.sender_id
       join conversations c on c.id = m.conversation_id
      where m.conversation_id = any($2::uuid[])
        and ${matchOn(3)}
        and (m.body -> 'fixed') is distinct from 'true'::jsonb
        and ($4::text is null or ${senderNamed("sp", "m", "$4::text")})
        and ($5::date is null or m.created_at < ($5::date)::timestamp at time zone $7::text)
        and ($6::date is null or m.created_at >= ($6::date + 1)::timestamp at time zone $7::text)
        and ($8::uuid is null or m.conversation_id <> $8::uuid or (m.seq > $9::bigint and m.seq <= $10::bigint)
             or (m.seq = any($11::bigint[]) and (m.seq > $9::bigint or (m.body ->> 'text') ilike $3 escape '\\')))
        and ($13::uuid is null or exists (select 1 from memberships ov
                                           where ov.conversation_id = m.conversation_id and ov.principal_id = $13::uuid
                                             and ov.left_seq is null and ov.joined_seq < m.seq))
        and ($14::uuid is null or m.conversation_id <> $15::uuid
             or not exists (select 1 from agent_runs ar
                             where ar.id = $14::uuid
                               and (m.seq = ar.covers_seq or m.seq = any(coalesce(ar.call_seqs, array[ar.covers_seq])))))
      order by m.created_at desc, m.conversation_id desc, m.seq desc
      limit $12`,
    [
      readerId,
      o.conversationIds,
      containsPattern(o.term),
      o.from,
      o.before,
      o.after,
      o.timeZone,
      o.window?.conversationId ?? null,
      o.window?.after ?? 0,
      o.window?.upTo ?? 0,
      o.window?.calls ?? [],
      o.limit,
      o.alsoVisibleTo ?? null,
      o.answering?.runId ?? null,
      o.answering?.conversationId ?? null,
    ],
  );
  return rows;
}

// --- global search -----------------------------------------------------------------------------

/** created_at at microsecond precision (a JS Date would lose it, and the cursor must resume exactly). */
const CREATED_AT_TEXT = `to_char(m.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const CURSOR_SHAPE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\|([1-9][0-9]{0,15})$/;
const CURSOR_TEXT = /^[A-Za-z0-9_-]{1,200}$/;

export interface SearchCursor {
  createdAt: string;
  conversationId: string;
  seq: number;
}

/** Opaque to clients: base64url of `createdAt|conversationId|seq`. Names a position, not a counter. */
export function encodeSearchCursor(c: SearchCursor): string {
  return Buffer.from(`${c.createdAt}|${c.conversationId}|${c.seq}`, "utf8").toString("base64url");
}

/** Strict: null for anything this module could not have minted (including non-canonical spellings). */
export function decodeSearchCursor(text: string): SearchCursor | null {
  if (!CURSOR_TEXT.test(text)) return null;
  const m = CURSOR_SHAPE.exec(Buffer.from(text, "base64url").toString("utf8"));
  if (!m) return null;
  const c: SearchCursor = { createdAt: m[1]!, conversationId: m[2]!, seq: Number(m[3]) };
  if (!Number.isSafeInteger(c.seq) || encodeSearchCursor(c) !== text) return null;
  // A real calendar date Postgres can hold (a Date round trip of the millisecond part rejects 02-31 etc.).
  const ms = c.createdAt.slice(0, 23) + "Z";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime()) || d.toISOString() !== ms || d.getUTCFullYear() < 1970) return null;
  return c;
}

export interface GlobalSearchPage {
  /** Newest first by created_at (ties: conversation id, then seq, both descending). */
  messages: WireMessage[];
  /** Opaque; pass as `before`. Null when no older hit exists. */
  nextBefore: string | null;
  /** Everyone the hits name (authors, visible quotes), by id. */
  principals: Record<string, SyncPrincipal>;
}

/**
 * Hits across every conversation the reader is currently in. VISIBLE_JOIN is applied in the same
 * statement as the match, so a cursor can only ever narrow what a reader sees, never widen it.
 */
export async function searchAll(
  q: Queryable,
  readerId: string,
  { q: term, before, limit }: SearchOptions & { before?: SearchCursor },
  config: ReadConfig,
): Promise<GlobalSearchPage> {
  const { rows } = await q.query<MessageRow & { created_at_text: string }>(
    `select ${MESSAGE_COLUMNS}, ${CREATED_AT_TEXT} as created_at_text
       from messages m ${VISIBLE_JOIN}
      where ${matchOn(2)}
        and ($3::timestamptz is null or (m.created_at, m.conversation_id, m.seq) < ($3::timestamptz, $4::uuid, $5::bigint))
      order by m.created_at desc, m.conversation_id desc, m.seq desc
      limit $6`,
    [readerId, containsPattern(term), before?.createdAt ?? null, before?.conversationId ?? null, before?.seq ?? null, limit + 1],
  );
  const pageRows = rows.slice(0, limit);
  const last = pageRows[pageRows.length - 1];
  const messages = await toWireFor(q, readerId, pageRows.map(toStored), config);
  return {
    messages,
    nextBefore:
      rows.length > limit && last
        ? encodeSearchCursor({ createdAt: last.created_at_text, conversationId: last.conversation_id, seq: Number(last.seq) })
        : null,
    principals: await principalsOf(q, messages),
  };
}
