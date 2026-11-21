import type { FastifyBaseLogger } from "fastify";
import type { Readable } from "node:stream";
import { isMissingBlob, type BlobStore } from "../attachments/blob.ts";
import { findDownloadable, type Downloadable } from "../attachments/store.ts";
import { currentMembership, VISIBLE_JOIN } from "../conversations/store.ts";
import type { Queryable } from "../db.ts";
import { IMAGE_TOKENS, pdfTokens } from "../metering/prices.ts";
import { notAcknowledgement, type AttachmentRef } from "../messages/model.ts";
import { postingRun } from "../messages/read.ts";
import type { ModelCall } from "../models/gateway.ts";
import type { Resolved } from "../models/resolve.ts";
import { handleOf } from "../principals/store.ts";
import { renderProposalBlock } from "./persona.ts";
import { withoutCitations } from "./tools/refs.ts";
import {
  GROUP_AGENTS_NAMED,
  GROUP_PEOPLE_NAMED,
  labelName,
  newMark,
  shownAppellation,
  speakerLabel,
  speakerRole,
  systemTokens,
  withoutMark,
  withSummary,
  type GroupPerson,
  type GroupScene,
  type ShownSummary,
  type SystemText,
} from "./runtime/prompt.ts";
import type { AgentRow } from "./store.ts";
import { baseOf, countPlaced, readSummary, shownSummary, stayOf, type PlacedReader, type Summary } from "./summary/store.ts";
import {
  attachmentLabel,
  ContextPlan,
  contextBudget,
  entryText,
  FILE_MAX_CHARS,
  fileText,
  IMAGE_MAX_BYTES,
  minimalTokens,
  MODEL_IMAGE_MIMES,
  pastBudget,
  PDF_MAX_BYTES,
  startsLikeText,
  UTF8_MAX_BYTES_PER_CHAR,
  type ContextAttachment,
  type ContextEntry,
} from "./runtime/context.ts";

/**
 * The database and blob side of what the model is shown (README "Agents and runs"), in two steps that `begin` keeps
 * apart: `loadContext` reads the messages and the attachments' records (SQL only, inside `begin`'s first short
 * transaction); `buildContext` reads the attachments' bytes and assembles the call with no transaction open, so no
 * write to the conversation ever waits for a file. The choosing is the pure plan in `runtime/context.ts`.
 */

/** In the Agent's own conversation, messages read per query, newest first, until the budget is passed. */
const PAGE = 200;
/** In a group, the most of its latest messages a reply is shown (with `AGENT_GROUP_CONTEXT_TOKENS`, `ContextRun.group`). */
export const GROUP_CONTEXT_MESSAGES = 80;
/** The first bytes of a file looked at before the rest is read as text (`startsLikeText`). */
const PROBE_BYTES = 4096;
/** A blob that has not been read after this long is given up on: it is shown by its name, like one that failed. */
export const BLOB_READ_TIMEOUT_MS = 15_000;

/**
 * The blob store failed on two attachments of a reply and has served none of them: it is down, and the reply fails as
 * the service's trouble (`busy`).
 */
export class BlobStoreDown extends Error {
  constructor(cause: unknown) {
    super("the blob store failed on two attachments and served none", { cause });
    this.name = "BlobStoreDown";
  }
}

/**
 * The run a context is built for: it answers up to `coversSeq` — its owner, in the Agent's own conversation, or, in a
 * group (`group`), whoever called it there.
 */
export interface ContextRun {
  agentId: string;
  /** The Agent's owner: in a group, the one account whose messages are labelled as its owner's (`speakerRole`). */
  ownerId: string;
  conversationId: string;
  coversSeq: number;
  /**
   * The run's conversation is a group, not the Agent's own conversation with its owner (null): the most of the group's
   * history its model is shown — `maxTokens` tokens, counted as the plan counts them (text in weight, attachments at their
   * estimate; the system text is not in it), when the model's context would hold more, and of the group's latest `maxMessages`
   * messages only — and nothing at or before seq `after`, the run's asker's line (`askerLine`): no message, no quote of
   * one, no attachment of one — but the calls it answers, at `calls` (`callsSeen`): one after the line whole, one at or
   * before it as its text only (neither its own attachment nor its quote, fix round 3). The Agent's own conversation is
   * limited by the model's context alone.
   */
  group: { maxTokens: number; maxMessages: number; after: number; calls: readonly number[] } | null;
  /**
   * The ratio the context is planned at (metering/tokens.ts `planRatio` of the model's learned ratio, read once by the
   * run): every text of the plan — the system text, the messages, the cut of the newest — counts its weight times this.
   */
  planRatio: number;
  /**
   * Tokens the call sends besides the system text and the conversation, at `planRatio`, kept out of the budget as the
   * system text is (`contextBudget`): a reply's tool definitions and what providers add around them (port-impl.ts
   * `begin`). None when absent.
   */
  reserved?: number;
  /**
   * A reply offered tools: the number of each attachment it is shown (agents/tools/refs.ts `RunRefs.file`), which its
   * label carries — the message's own and a quoted one's alike. Absent: labels carry none.
   */
  fileRef?: (attachmentId: string) => string;
  /** Nothing after this seq is shown (a told reply: what was noted on it since is its follow-up's). Absent: no bound. */
  upTo?: number;
  /**
   * The pair's summary and what of it may be shown (`readPairSummary`, held to `MEMORY.summaryMaxWeight` as shown), read
   * once for the run however many times its context is planned (port-impl.ts `begin`, round 2 N-4).
   */
  summary: PairSummary;
}

/** The pair's stored summary (null: none), and the summary as a reply may be shown it (`shownSummary`; null: shown nothing). */
export interface PairSummary {
  stored: Summary | null;
  shown: ShownSummary | null;
}

/**
 * `PairSummary` of `run`'s pair, what it shows held to `maxWeight` as shown (`MEMORY.summaryMaxWeight`): one read of the row
 * and, when its items name anyone, one indexed read of those accounts.
 */
export async function readPairSummary(
  q: Queryable,
  run: Pick<ContextRun, "agentId" | "ownerId" | "conversationId"> & { group: boolean },
  maxWeight: number,
): Promise<PairSummary> {
  const stored = await readSummary(q, run.conversationId, run.agentId);
  const reader: PlacedReader = { agentId: run.agentId, ownerId: run.ownerId, conversationId: run.conversationId, group: run.group };
  return { stored, shown: stored === null ? null : await shownSummary(q, reader, stored, maxWeight) };
}

/** What `loadContext` read: everything `buildContext` needs but the attachments' bytes. */
export interface LoadedContext {
  /** The run's system text, with its notes passage known apart (what the budget and the estimate measure). */
  system: SystemText;
  /** Who spoke in what was read and is in the group now (`speakersOf`), as `system`'s roster lists them; none in the Agent's own conversation. */
  speakers: Speaker[];
  /**
   * In a group, the run's mark (`newMark`), which `system` and the labels of `entries` carry and nothing else they show
   * does; null in the Agent's own conversation.
   */
  mark: string | null;
  /** Tokens the conversation may take (`contextBudget`; in a group at most its `maxTokens`), at `planRatio`. */
  budget: number;
  /** The ratio the context is planned at (`ContextRun.planRatio`): `buildContext` plans with it too. */
  planRatio: number;
  /** The messages that may be shown, in the order they were answered, oldest first. */
  entries: ContextEntry[];
  /** The records of the attachments that may be shown, by id, as the download's permission gave them to the Agent. */
  attachments: Map<string, Downloadable>;
  /** The seq of the latest `topic_reset` notice the Agent can see; 0 when there is none. */
  topicStart: number;
  /**
   * What the conversation part left out (README "The rolling summary"): `messages`, how many messages the Agent could see are
   * placed (agents/summary/store.ts: a message's seq, an Agent's reply the seq its run covered) up to and with `to` — after
   * where the part starts (the topic start; in a group the asker's line too) and past what the pair's summary covers (shown to
   * this run or not), and before the oldest message the plan shows (by name: `ContextPlan.shownAt`; in the Agent's own
   * conversation, at the last reply of the Agent's before it: `leftOutTo`) — in its own conversation because they did not fit,
   * in a group also because they fell before the latest `maxMessages`. What `finish` acts on: anything left out queues a
   * job, `to` what it is to cover up to (the job weighs it before it makes a call). Null when none was left out.
   */
  leftOut: LeftOut | null;
  /** The pair's summary as the system text carries it (`withSummary`); null when it carries none. */
  summary: Summary | null;
}

/** What a conversation part left out (`LoadedContext.leftOut`). */
export interface LeftOut {
  to: number;
  messages: number;
}

export interface BuiltContext {
  /** Never empty when `loadContext` found an owner's message (`hasOwnerTurn`). */
  messages: ModelCall["messages"];
  /**
   * Tokens of the system text and the turns — text in weight, images and PDFs at their constants — at ratio 1: what the
   * budget was planned in. Settlement falls back on it corrected by the model's learned ratio (`correctedEstimate`) when
   * no usage is reported, and a reply of text only teaches the ratio from it (metering/tokens.ts). Admission holds the
   * texts' bound instead (`holdTokens`).
   */
  inputTokensEstimate: number;
  /** Of `inputTokensEstimate`, what images and PDFs are counted as: their constants, never corrected by a ratio. */
  fixedTokens: number;
}

/**
 * At most `max` bytes of a blob, read as a stream and stopped there (`complete`: the blob had no more), or null when
 * the blob is missing. With `probe`, the first `PROBE_BYTES` are shown to it and the read stops when it says no.
 * Rejects when the blob has not been read within `timeoutMs`, with `signal`'s reason as soon as it aborts (the read is
 * abandoned), and for any other failure of the store.
 */
export async function readPrefix(
  blobs: BlobStore,
  key: string,
  max: number,
  {
    probe,
    timeoutMs = BLOB_READ_TIMEOUT_MS,
    signal,
  }: { probe?: (head: Uint8Array) => boolean; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ data: Buffer; complete: boolean } | null> {
  const held: { stream?: Readable; late?: boolean } = {};
  const reading = (async (): Promise<{ data: Buffer; complete: boolean } | null> => {
    let stream: Readable;
    try {
      stream = await blobs.get(key);
    } catch (err) {
      if (isMissingBlob(err)) return null;
      throw err;
    }
    held.stream = stream;
    if (held.late) {
      stream.destroy();
      return null;
    }
    const chunks: Buffer[] = [];
    let n = 0;
    let probed = probe === undefined;
    // One byte past `max` says whether there is more; leaving the loop early destroys the stream.
    for await (const chunk of stream) {
      const piece = (chunk as Buffer).subarray(0, max + 1 - n);
      chunks.push(piece);
      n += piece.length;
      if (!probed && n >= PROBE_BYTES) {
        probed = true;
        const head = Buffer.concat(chunks);
        if (!probe!(head)) return { data: head, complete: false };
      }
      if (n > max) break;
    }
    const data = Buffer.concat(chunks);
    return n > max ? { data: data.subarray(0, max), complete: false } : { data, complete: true };
  })();
  reading.catch(() => {}); // it may fail after the deadline has answered
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the blob ${key} did not arrive within ${timeoutMs} ms`)), timeoutMs);
    if (!signal) return;
    onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([reading, deadline]);
  } catch (err) {
    held.late = true;
    held.stream?.destroy();
    throw err;
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * The asker's line of reply run `runId` in a group (Task 10b, the product rule of 2026-11-20): the seq at and before which
 * nothing of the group is shown to its model but the calls it answers (`callsSeen`) — the latest current-stay start
 * (`joined_seq`, the visibility rule's) among its askers (`agent_runs.asker_ids`, runs.ts `Askers`): the people whose
 * questions it answers and everyone it hears from, recorded as it goes (fix round 2: runs.ts `hearFrom`, wherever what it
 * covers moves forward — so a question that slipped in while the reply waited is not answered from before its sender's
 * joining, and an older member's does not move the line). Where an asker cannot be told — the run's askers are not
 * known (a run recorded before they were, a chain whose first person cannot be told), or one is not in the group now
 * (left since, or never in it) — the latest joining among the group's people now counts as well (the safe side). 0 when
 * nothing bounds it (no such run; no person in the group now). The Agent's own joining needs no line here: the
 * visibility rule with the Agent as reader (`VISIBLE_JOIN`) bounds everything it is shown already, so a reply is shown
 * nothing before the later of the two. Everything that shows a reply's model what was said in its group — this context
 * (`loadContext`), and any tool that reads the group's history or a summary of it for the reply — keeps to the same
 * line, and records whoever it shows the reply beyond what the reply has heard (`hearFrom`) before it reads the line.
 */
export async function askerLine(q: Queryable, runId: string): Promise<number> {
  const { rows } = await q.query<{ line: string }>(
    `select greatest(
              coalesce(max(j.joined), 0),
              case when bool_or(j.joined is null) is not false
                   then (select coalesce(max(ms.joined_seq), 0) from memberships ms join principals p on p.id = ms.principal_id
                          where ms.conversation_id = r.conversation_id and ms.left_seq is null and p.kind = 'human')
                   else 0 end)::text as line
       from agent_runs r
       left join lateral (select (select ms.joined_seq from memberships ms
                                   where ms.conversation_id = r.conversation_id and ms.principal_id = a.id and ms.left_seq is null) as joined
                            from unnest(r.asker_ids) as a (id)) j on true
      where r.id = $1
      group by r.id, r.conversation_id`,
    [runId],
  );
  return Number(rows[0]?.line ?? 0);
}

/**
 * The calls reply run `runId` of Agent `agentId` answers that the Agent can see and show, by seq, oldest first: of the
 * messages that called for it (`agent_runs.call_seqs`, which holds the latest it covers too as it is written — but a told
 * reply's, which hold only the calls noted on it, all after what it covers and shown to it as nothing, `upTo`; its
 * `covers_seq` alone when not known — a call `runs.ts dropBlockedCalls` dropped is in neither), those that are text or
 * file messages the Agent can see (`VISIBLE_JOIN`) — one at or before the run's line
 * `line` (`askerLine`) only when it has text: it is shown even there, but as its text only (fix round 3: not its file).
 * What it was asked is answered, whoever spoke since. None: nothing is left to answer.
 */
export async function callsSeen(q: Queryable, agentId: string, runId: string, line: number): Promise<number[]> {
  const { rows } = await q.query<{ seq: string }>(
    `select m.seq::text as seq
       from agent_runs r
       join messages m on m.conversation_id = r.conversation_id and m.seq = any(coalesce(r.call_seqs, array[r.covers_seq]))
       ${VISIBLE_JOIN}
      where r.id = $2 and m.kind in ('text', 'file') and (m.body -> 'fixed') is distinct from 'true'::jsonb
        and (m.seq > $3 or coalesce(m.body ->> 'text', '') <> '')
      order by m.seq`,
    [agentId, runId, line],
  );
  return rows.map((r) => Number(r.seq));
}

/**
 * Someone in a group now as its roster may list them (`withRoster`): their account, and the person the roster shows
 * (`GroupPerson`: name, handle, who they are to the Agent, `speakerRole`, and what its owner wants them called).
 */
export type Member = GroupPerson & { id: string };

/**
 * Someone who said something in a group: a `Member` but for what they are called, which only the group's read knows
 * (`withRoster`).
 */
export type Speaker = Omit<Member, "appellation">;

/** A message as loaded: its entry, its seq, and where it belongs (`answers`). */
interface Loaded {
  entry: ContextEntry;
  seq: number;
  /** The owner's message: its seq. The Agent's reply: the seq its run had covered when it began. */
  answers: number;
  /** An Agent's reply posted by a run (it goes after the owner's message it answers). */
  reply: boolean;
  /**
   * It is a message a summary is made of (`notAcknowledgement`, the one rule summary/store.ts `countPlaced` counts by): an
   * Agent's acknowledgement is not, so what is left out counts none (`late`).
   */
  placed: boolean;
  /**
   * In a group, a message of someone else's: who said it, whether they are in the group now (`inGroupNow`: the roster
   * lists only those), and whether its text starts with a quote. `entry` is without the label, which goes before it once
   * the run's mark is drawn (`shown`).
   */
  speaker: (Speaker & { present: boolean; quoted: boolean }) | null;
}

interface MessageRow {
  seq: string;
  sender_id: string;
  /**
   * The sender's display name, handle and kind (`principals`), for the speaker's label in a group, and whether they
   * are in the group now (`inGroupNow`; only read in a group).
   */
  sender_name: string;
  sender_handle: string;
  sender_kind: "human" | "agent";
  sender_present: boolean;
  text: string | null;
  attachment: AttachmentRef | null;
  reply_to: unknown;
  answers: string | null;
  /** Not an acknowledgement (`notAcknowledgement`): a message a summary is made of. */
  placed: boolean;
  /** The persona proposal the Agent's reply made, if any (`persona_proposals` by `message_id`). */
  proposal_persona: string | null;
  proposal_intro: string | null;
  proposal_field: string | null;
}

/** An attachment as the context shows it; with `fileRef` (a reply offered tools), with its number. */
export const toAttachment = (a: AttachmentRef, fileRef?: (attachmentId: string) => string): ContextAttachment => ({
  id: a.id,
  name: withoutCitations(a.name),
  image: a.inline === true,
  ...(fileRef ? { ref: fileRef(a.id) } : {}),
});


/**
 * SQL: membership `ms` (an alias) is of someone in its group now, as a group's system text counts them (its other
 * Agents, its roster): current (no `left_seq`), and not of an Agent that was deleted (it is leaving).
 */
const inGroupNow = (ms: string): string =>
  `${ms}.left_seq is null and not exists (select 1 from agents gone where gone.principal_id = ${ms}.principal_id and gone.deleted_at is not null)`;

/**
 * Up to `limit` messages the Agent can see with seq before `before`, newest first: text and file messages (not notices,
 * not the fixed greeting) that belong after the topic start `from` — in its own conversation the owner's, in a group
 * everyone's but its own — and the Agent's replies to what is covered up to `coversSeq`. A reply belongs where it was
 * answered: right after the message its run covered when it began (the run that posted it, named by the message's
 * `client_txn`: messages/read.ts `postingRun`). Only the text, the attachment and the quote are read of a message — never its stored reasoning. A quote
 * shows what the Agent can see of the quoted message: its text, or its attachment's name. In its own conversation the
 * owner's messages are `user` and anyone else's are left out (there is nobody else); in a group every message of
 * someone else's is `user`, and who said it is kept for its label and the roster (`Loaded.speaker`: their current name,
 * who they are by account, `speakerRole`, and whether they are in the group now, `inGroupNow`). A reply of the Agent's
 * that proposed a persona is its text followed by the proposal as the block it was written in (`renderProposalBlock`):
 * the Agent's own output, so it can revise what it proposed; it counts toward the budget like any text and is never
 * read for a block again. (A reply in a group never proposes: nothing is looked up there.) In a group a quote of a
 * message at or before the asker's line (`ContextRun.group.after`) is left out as one the Agent cannot see is: the
 * quoting message's own text only; and the calls the run answers (`ContextRun.group.calls`) belong whatever `from` is,
 * one at or before `from` as its text only (no attachment: it is not read). No citation (`〔m3〕`) is shown, in a text, a
 * quote or a file's name (tools/refs.ts `withoutCitations`): a number means something only in the run that gave it.
 * `more`: as many as `limit` (there may be older ones).
 */
async function loadPage(
  q: Queryable,
  run: ContextRun,
  from: number,
  before: number | null,
  limit: number,
): Promise<{ loaded: Loaded[]; oldest: number | null; more: boolean }> {
  const group = run.group !== null;
  const { rows } = await q.query<MessageRow>(
    `select m.seq::text as seq, m.sender_id, sp.display_name as sender_name, ${handleOf("sp")} as sender_handle, sp.kind as sender_kind,
            $8::boolean and exists (select 1 from memberships sm
                                     where sm.conversation_id = m.conversation_id and sm.principal_id = m.sender_id and ${inGroupNow("sm")}) as sender_present,
            m.body ->> 'text' as text, case when m.seq > $3 then m.body -> 'attachment' end as attachment,
            m.body -> 'replyToSeq' as reply_to, r.covers_seq::text as answers, ${notAcknowledgement("m")} as placed,
            pp.persona as proposal_persona, pp.intro as proposal_intro, pp.field as proposal_field
       from messages m ${VISIBLE_JOIN}
       join principals sp on sp.id = m.sender_id
       left join agent_runs r on m.sender_id = $1 and ${postingRun("m", "r")}
       left join persona_proposals pp on pp.message_id = m.id and pp.agent_id = $1 and m.sender_id = $1 and not $8::boolean
      where m.conversation_id = $2 and ($4::bigint is null or m.seq < $4::bigint)
        and m.kind in ('text', 'file') and (m.body -> 'fixed') is distinct from 'true'::jsonb
        and ((m.seq > $3 and coalesce(r.covers_seq, m.seq) > $3) or m.seq = any($9::bigint[]))
        and (m.sender_id = $6 or ($8::boolean and m.sender_id <> $1) or coalesce(r.covers_seq, m.seq) <= $5)
        and ($10::bigint is null or m.seq <= $10::bigint)
      order by m.seq desc
      limit $7`,
    [run.agentId, run.conversationId, from, before, run.coversSeq, run.ownerId, limit, group, run.group?.calls ?? [], run.upTo ?? null],
  );
  const quotedSeqs = [...new Set(rows.flatMap((r) => (typeof r.reply_to === "number" && Number.isSafeInteger(r.reply_to) ? [r.reply_to] : [])))];
  const quotes = new Map<number, string>();
  if (quotedSeqs.length > 0) {
    const quoted = await q.query<{ seq: string; text: string | null; attachment: AttachmentRef | null }>(
      `select m.seq::text as seq, m.body ->> 'text' as text, m.body -> 'attachment' as attachment
         from messages m ${VISIBLE_JOIN}
        where m.conversation_id = $2 and m.seq = any($3::bigint[]) and m.seq > $4`,
      [run.agentId, run.conversationId, quotedSeqs, run.group?.after ?? 0],
    );
    for (const r of quoted.rows) {
      const shown = r.text ? withoutCitations(r.text) : r.attachment ? attachmentLabel(toAttachment(r.attachment, run.fileRef)) : "";
      if (shown !== "") quotes.set(Number(r.seq), shown);
    }
  }
  const loaded = rows.flatMap((r): Loaded[] => {
    const role = r.sender_id === run.agentId ? "assistant" : group || r.sender_id === run.ownerId ? "user" : null;
    if (role === null) return [];
    const quoted = typeof r.reply_to === "number" ? (quotes.get(r.reply_to) ?? null) : null;
    const seq = Number(r.seq);
    let text = entryText(withoutCitations(r.text ?? ""), quoted);
    if (role === "assistant" && r.proposal_persona !== null) {
      const block = renderProposalBlock({ persona: r.proposal_persona, intro: r.proposal_intro, field: r.proposal_field });
      text = text === "" ? block : `${text}\n\n${block}`;
    }
    const entry: ContextEntry = { role, text, attachment: r.attachment ? toAttachment(r.attachment, run.fileRef) : null };
    const speaker =
      group && role === "user"
        ? {
            id: r.sender_id,
            name: r.sender_name,
            handle: r.sender_handle,
            role: speakerRole(r.sender_id, r.sender_kind, run.ownerId),
            present: r.sender_present,
            quoted: quoted !== null,
          }
        : null;
    return [{ entry, seq, answers: r.answers === null ? seq : Number(r.answers), reply: r.answers !== null, placed: r.placed, speaker }];
  });
  return { loaded, oldest: rows.length > 0 ? Number(rows[rows.length - 1]!.seq) : null, more: rows.length === limit };
}

/**
 * A message as a reply's model is shown it: in a group, one of someone else's (`speaker`) starts with its label carrying
 * the run's `mark` (`speakerLabel`; a quote goes on the next line); with no speaker or no mark, `entry` as it is. The one
 * rule of it: what a reply is shown (`shown`) and what the rolling summary weighs a message it replaces as
 * (agents/summary/job.ts) are both this.
 */
export function labelledEntry(entry: ContextEntry, speaker: Pick<Speaker, "name" | "handle" | "role"> & { quoted: boolean } | null, mark: string | null): ContextEntry {
  if (speaker === null || mark === null) return entry;
  const { name, handle, role, quoted } = speaker;
  return { ...entry, text: `${speakerLabel(mark, labelName(name, handle), role)}${quoted ? "\n" : ""}${entry.text}` };
}

/** A loaded message as the model is shown it (`labelledEntry`, with the run's `mark`; with no mark, as loaded). */
const shown = (l: Loaded, mark: string | null): ContextEntry => labelledEntry(l.entry, l.speaker, mark);

/** Whether `mark` occurs in anything of a loaded message the model is shown: its text, its attachment's name, who said it. */
const shows = (l: Loaded, mark: string): boolean =>
  [l.entry.text, l.entry.attachment?.name ?? "", l.speaker === null ? "" : labelName(l.speaker.name, l.speaker.handle)].some((s) => s.includes(mark));

/**
 * Who said what is loaded and is in the group now (`Loaded.speaker.present`), the latest to speak first, each once: the
 * speakers the roster lists after its owner and appellation holders (`withRoster`). None in the Agent's own
 * conversation.
 */
function speakersOf(list: readonly Loaded[]): Speaker[] {
  const found = new Map<string, Speaker>();
  for (const { speaker } of [...list].sort((a, b) => b.seq - a.seq)) {
    if (speaker?.present && !found.has(speaker.id)) found.set(speaker.id, { id: speaker.id, name: speaker.name, handle: speaker.handle, role: speaker.role });
  }
  return [...found.values()];
}

/** In the order things were answered: by `answers`, a reply after the owner's message it answers, then by seq. */
const inAnsweredOrder = (list: readonly Loaded[]): Loaded[] => [...list].sort((a, b) => a.answers - b.answers || Number(a.reply) - Number(b.reply) || a.seq - b.seq);

/** `inAnsweredOrder`, each as `shown` with `mark` (none: without labels). */
const answeredOrder = (list: readonly Loaded[], mark: string | null = null): ContextEntry[] => inAnsweredOrder(list).map((l) => shown(l, mark));

/**
 * Step one of what the model is shown for `run` (spec 6.5 "发给模型的内容"; README "Agents and runs"), database only:
 * the messages after the latest new topic — in a group, and after the asker's line (`ContextRun.group.after`), the later
 * of the two, and the calls the run answers wherever they are (`ContextRun.group.calls`) — in the order they were
 * answered, read newest first until they are more than
 * the budget (the model's context less its output limit, `system` and `run.reserved`; in a group at most `run.group.maxTokens`) can
 * hold — in a group, its latest `run.group.maxMessages` messages at most, as if what is older were left unread — and the
 * records of the attachments the plan could show — looked up only through `findDownloadable` with the Agent as reader
 * (the download's own permission); an image is not looked up when the model cannot see images. Everything that uses
 * the budget after this (`pastBudget` here, the plans here and in `buildContext`, `holdsNewest` in `begin`, and so
 * admission, which holds for what `buildContext` built) uses the capped one.
 *
 * `system(mark, speakers)` is the run's system text carrying `mark`, with a group's roster listing `speakers` (who
 * spoke in what is loaded and is in the group now, the latest first: `speakersOf`); the Agent's own conversation's
 * carries neither and ignores both. In a group the run's mark is drawn here, once what is shown is known (`newMark`,
 * with `draw`): one that occurs in no message, quote, name or file name loaded and nowhere in `system("", speakers)` —
 * the system text with the mark left out, its roster included — so that only the labels (`shown`) and the system text
 * carry it. What is read is chosen before that, by the budget `system("", [])` leaves and with no label counted: in the
 * Agent's own conversation that is the budget the system text leaves; a group's latest `maxMessages` are read as one
 * page, whatever the budget, so no budget cuts its reading short. Either way nothing that could be shown is
 * left unread; the budget used after reading (`budget`) is the one the final system text leaves.
 *
 * The pair's rolling summary (agents/summary/; README "The rolling summary"), when it may be shown — everything it covers
 * after the topic start and, in a group, after the asker's line, and something left to answer — is the system text's last
 * passage (`withSummary`, so in every `system(…)` above, the mark's drawing included), and the conversation part then starts
 * after what it covers; dropped first (the part still starting there) when, with it, the newest message would not fit
 * whole. What the plan left out — by place, after where the part starts and before the oldest message it shows by name —
 * is reported as `leftOut` (one count of what the Agent can see there), for `begin` to keep and `finish` to act on.
 */
export async function loadContext(
  q: Queryable,
  run: ContextRun,
  resolved: Pick<Resolved, "contextTokens" | "vision" | "call">,
  system: (mark: string, speakers: readonly Speaker[]) => SystemText,
  draw?: () => string,
): Promise<LoadedContext> {
  const ratio = run.planRatio;
  const budgetWith = (text: SystemText): number => {
    const whole = contextBudget(resolved.contextTokens, resolved.call.maxOutputTokens, text, ratio, run.reserved ?? 0);
    return run.group === null ? whole : Math.min(whole, run.group.maxTokens);
  };
  // The Agent's current stay, read once: the latest new topic it can see there (0: none, also when it is not a member) and,
  // with its joining, where a summary of its may begin (`baseOf`).
  const stay = await stayOf(q, run.agentId, run.conversationId);
  const start = stay?.topic ?? 0;
  const line = run.group?.after ?? 0;
  // The pair's rolling summary. It belongs to the pair only when everything it covers is after where the Agent may be shown
  // the conversation from now — its current stay and the latest new topic (`summaryBase`); one of an earlier stay or topic is
  // no summary (the write side checks the same, job.ts). It is shown only when, besides, everything it covers is after the
  // asker's line (it is text about those messages: a reply is shown nothing derived from what is at or before its line), and
  // it leaves the run something to answer. Not shown, the conversation part is read as if there were none.
  // Read once for the run (`ContextRun.summary`); shown as summary/store.ts `shownSummary` has it — each item said by whom
  // its account is now, without citations, held to the cap as shown — and a row from before migration 059 (text only) not
  // at all.
  const pair = run.summary;
  const stored = pair.stored;
  const base = baseOf(stay);
  const owned = stored !== null && base !== null && stored.fromSeq > base ? stored : null;
  const summary = owned !== null && pair.shown !== null && owned.fromSeq > line && owned.uptoSeq < run.coversSeq ? owned : null;
  const reader: PlacedReader = { agentId: run.agentId, ownerId: run.ownerId, conversationId: run.conversationId, group: run.group !== null };
  const carrying = (shown: ShownSummary | null) => (mark: string, speakers: readonly Speaker[]): SystemText => withSummary(system(mark, speakers), shown);
  const withPassage = carrying(summary === null ? null : pair.shown);
  const reading = budgetWith(withPassage("", []));
  // In a group, nothing at or before the asker's line either (`askerLine`): what is read starts after the later of the two;
  // with a summary shown, after what it covers.
  const from = Math.max(start, line, summary?.uptoSeq ?? 0);
  const loaded: Loaded[] = [];
  // Read by seq, but shown in answered order: everything that belongs at or after the oldest seq read is known, and
  // only that is used while more is left unread (a reply may belong before messages not read yet).
  let oldest = Number.POSITIVE_INFINITY;
  let more = true;
  let before: number | null = null;
  while (more) {
    // A group's latest `maxMessages` are one page, read whatever the budget; what is older is not read: it counts as
    // more left unread.
    const page = await loadPage(q, run, from, before, run.group === null ? PAGE : run.group.maxMessages);
    loaded.push(...page.loaded);
    more = page.more;
    if (page.oldest !== null) oldest = page.oldest;
    if (more && (run.group !== null || pastBudget(answeredOrder(loaded.filter((l) => l.answers >= oldest)).reverse(), reading, ratio))) break;
    before = page.oldest;
  }
  const kept = more ? loaded.filter((l) => l.answers >= oldest) : loaded;
  const speakers = speakersOf(kept);
  const unmarked = withPassage("", speakers);
  const mark = run.group === null ? null : newMark((m) => unmarked.text.includes(m) || kept.some((l) => shows(l, m)), draw);
  let text = mark === null ? unmarked : withPassage(mark, speakers);
  let budget = budgetWith(text);
  const ordered = inAnsweredOrder(kept);
  const entries = ordered.map((l) => shown(l, mark));
  // The summary's passage goes first when, with it, the newest message would not fit whole (the mark, drawn with it there,
  // is in no part of what is left).
  let carried = summary;
  const newest = [...entries].reverse().find((e) => e.role === "user");
  if (summary !== null && newest !== undefined && minimalTokens(newest, ratio) > budget) {
    carried = null;
    text = carrying(null)(mark ?? "", speakers);
    budget = budgetWith(text);
  }

  // The attachments of every message the plan could keep (those it keeps with no attachment contents at all).
  const could = new ContextPlan(entries, budget, ratio);
  could.keepOlder();
  // What it left out, by place: from where the conversation part starts — or, past it, what the pair's summary covers
  // already, shown to this run or not — to the oldest message it shows (after `from`).
  const after = Math.max(from, owned?.uptoSeq ?? 0);
  const to = leftOutTo(ordered, could.shownAt(), from, run.group === null);
  let leftOut: LeftOut | null = null;
  if (to !== null && to > after) {
    // Counted in two parts, so that no read reaches past `to`: what is stored at or before it, and what was loaded after it
    // (every message after it is among those loaded) whose place is not — of what a summary is made of only (`placed`).
    const late = loaded.filter((l) => l.placed && l.seq > to && l.answers > after && l.answers <= to).length;
    const messages = (await countPlaced(q, reader, after, to, to)) + late;
    if (messages > 0) leftOut = { to, messages };
  }
  const attachments = new Map<string, Downloadable>();
  for (const [, a] of [...could.attachments(false), ...could.attachments(true)]) {
    if (a.image && !resolved.vision) continue;
    const found = await findDownloadable(q, run.agentId, a.id);
    if (found) attachments.set(a.id, found);
  }
  return { system: text, speakers, mark, budget, planRatio: ratio, entries, attachments, topicStart: start, leftOut, summary: carried };
}

/**
 * The last place a conversation part left out (`LoadedContext.leftOut`), given what was loaded in answered order (`ordered`),
 * where the plan's shown messages are in it (`ContextPlan.shownAt`) and where the part starts (`from`): one below the place of
 * the oldest shown message after `from` — in the Agent's own conversation (`own`), the place of the last reply of the
 * Agent's before it instead, so that a turn of several lines of the owner's is never split from the reply that answered it
 * (a run covers the last line of its turn: what of a turn is not shown waits, unsummarised, until its reply is left out
 * too). Null when nothing is left out (or, in its own conversation, no reply of the Agent's is loaded before it).
 */
function leftOutTo(ordered: readonly Loaded[], shownAt: readonly number[], from: number, own: boolean): number | null {
  const first = shownAt.find((at) => ordered[at]!.answers > from);
  if (first === undefined) return null;
  if (!own) return ordered[first]!.answers - 1;
  for (let i = first - 1; i >= 0; i--) if (ordered[i]!.entry.role === "assistant") return ordered[i]!.answers;
  return null;
}

/** Whether there is anything to answer: an owner's message among what may be shown (in a group, anyone else's). */
export const hasOwnerTurn = (loaded: LoadedContext): boolean => loaded.entries.some((e) => e.role === "user");

/**
 * What `loadGroupScene` read of a group: its scene but for the roster, which waits for who spoke (`withRoster`), and
 * whom the roster can be made of.
 */
export interface LoadedScene extends Omit<GroupScene, "people" | "morePeople"> {
  /**
   * Of those in the group now besides the Agent (`inGroupNow`), in the order they joined: its owner, everyone its owner
   * gave an appellation, and the first `GROUP_PEOPLE_NAMED` of the others — enough to fill the roster whoever spoke.
   */
  members: Member[];
  /** How many are in the group now besides the Agent (more than `members` when not all were read). */
  inGroup: number;
}

/**
 * The group a run of `agent` answers in, for its system text (`groupSystemPrompt`): its title; the other Agents in it
 * now (`inGroupNow`: current members, not deleted — a deleted one is leaving), in the order they joined, at most
 * `GROUP_AGENTS_NAMED` named; and whom its roster can list (`LoadedScene.members`), each with who they are to the Agent
 * by account and what its owner wants them called — its owner `agents.owner_appellation`, anyone else their
 * `agent_appellations` row's — read in one query, bounded however large the group. Null when the Agent itself is not
 * a current member there. Plain reads, under the caller's lock on the group's row (which every membership change takes).
 */
export async function loadGroupScene(
  q: Queryable,
  agent: Pick<AgentRow, "id" | "ownerId" | "ownerAppellation">,
  conversationId: string,
): Promise<LoadedScene | null> {
  if (!(await currentMembership(q, conversationId, agent.id))) return null;
  const title = await q.query<{ title: string | null }>("select title from conversations where id = $1", [conversationId]);
  const { rows } = await q.query<{ name: string; handle: string; intro: string }>(
    `select p.display_name as name, ${handleOf("p")} as handle, a.intro
       from memberships m
       join principals p on p.id = m.principal_id
       join agents a on a.principal_id = p.id
      where m.conversation_id = $1 and ${inGroupNow("m")} and p.kind = 'agent' and p.id <> $2
      order by m.joined_seq, p.id
      limit $3`,
    [conversationId, agent.id, GROUP_AGENTS_NAMED + 1],
  );
  // Everyone in the group now but the Agent is counted and numbered; its owner and those with an appellation (`always`)
  // are all read, of the others the first by join order.
  const people = await q.query<{ id: string; name: string; handle: string; kind: "human" | "agent"; appellation: string | null; in_group: number }>(
    `select id, name, handle, kind, appellation, in_group
       from (select p.id, p.display_name as name, ${handleOf("p")} as handle, p.kind, aa.appellation, m.joined_seq, k.always,
                    (count(*) over ())::int as in_group,
                    row_number() over (partition by k.always order by m.joined_seq, p.id) as nth
               from memberships m
               join principals p on p.id = m.principal_id
               left join agent_appellations aa on aa.agent_id = $2 and aa.principal_id = p.id
               cross join lateral (values (p.id = $3 or aa.appellation is not null)) k(always)
              where m.conversation_id = $1 and ${inGroupNow("m")} and p.id <> $2) r
      where always or nth <= $4
      order by joined_seq, id`,
    [conversationId, agent.id, agent.ownerId, GROUP_PEOPLE_NAMED],
  );
  return {
    title: title.rows[0]?.title ?? null,
    agents: rows.slice(0, GROUP_AGENTS_NAMED),
    more: rows.length > GROUP_AGENTS_NAMED,
    members: people.rows.map((r) => ({
      id: r.id,
      name: r.name,
      handle: r.handle,
      role: speakerRole(r.id, r.kind, agent.ownerId),
      appellation: r.id === agent.ownerId ? agent.ownerAppellation : r.appellation,
    })),
    inGroup: people.rows[0]?.in_group ?? 0,
  };
}

/**
 * `scene` with its roster (owner-marker design rule 8, and the plan's ruling on its order): of those in the group now
 * besides the Agent, each once and at most `GROUP_PEOPLE_NAMED`, in this order — its owner; whoever its owner gave an
 * appellation that shows (`shownAppellation`), in the order they joined; whoever spoke in what the run is shown
 * (`speakers`, the latest first); then everyone else in the order they joined — and whether more are there. Someone
 * read with the group is listed as read there (so with their appellation); a speaker who was not has none.
 */
export function withRoster(scene: LoadedScene, speakers: readonly Speaker[]): GroupScene {
  const { members, inGroup, ...rest } = scene;
  const read = new Map(members.map((m) => [m.id, m]));
  const listed = new Map<string, Member>();
  const list = (m: Member): void => {
    if (!listed.has(m.id)) listed.set(m.id, m);
  };
  for (const m of members) if (m.role === "你的主人") list(m);
  for (const m of members) if (shownAppellation(m.appellation) !== null) list(m);
  for (const s of speakers) list(read.get(s.id) ?? { ...s, appellation: null });
  for (const m of members) list(m);
  const people = [...listed.values()].slice(0, GROUP_PEOPLE_NAMED);
  return { ...rest, people, morePeople: inGroup > people.length };
}

/**
 * Step two, with no transaction open: the call's turns, chosen by `ContextPlan` from `loaded`, with the contents of
 * attachments when the model can take them and they fit — checked on their stored size before a byte is read: a PNG,
 * JPEG or WebP image (a GIF is named) up to 5 MB when the model sees images; a PDF up to 10 MB when it reads PDFs; any
 * other file as text when its bytes are text (`fileText`), read at most 4 bytes per character it may still show; never
 * more than the call's `bytesLeft`. In a group a file's text loses the run's mark (`withoutMark`): files are read after
 * the mark is drawn, so this is how a file filled with guessed labels can never carry the real one. An image's or a
 * PDF's bytes go to the model as they are and cannot be cleaned so. A missing blob is shown by name (and logged). So is
 * one whose read fails or takes longer than `BLOB_READ_TIMEOUT_MS` (logged once) — unless no read of this build has
 * succeeded and this is the second that failed: then the store is down (`BlobStoreDown` is thrown). Once one read has
 * succeeded (a missing blob counts: the store answered), every later failure is shown by its name. Once `stop()` says
 * so, no further blob is read (what is left is shown by name, and the caller ends the run). When `signal` aborts, the
 * read under way is abandoned and its reason thrown.
 */
export async function buildContext(
  blobs: BlobStore,
  loaded: LoadedContext,
  resolved: Pick<Resolved, "vision" | "pdf">,
  log: Pick<FastifyBaseLogger, "error">,
  { signal, stop = () => false, closing }: { signal?: AbortSignal; stop?: () => boolean; closing?: string } = {},
): Promise<BuiltContext> {
  const plan = new ContextPlan(loaded.entries, loaded.budget, loaded.planRatio);
  /** Whether a read of this build has succeeded (the store answered), and how many have failed. */
  let served = false;
  let failed = 0;

  async function read(attachment: ContextAttachment, key: string, max: number, probe?: (head: Uint8Array) => boolean) {
    let got: { data: Buffer; complete: boolean } | null;
    try {
      got = await readPrefix(blobs, key, max, { ...(probe ? { probe } : {}), ...(signal ? { signal } : {}) });
    } catch (err) {
      if (signal?.aborted) throw signal.reason;
      failed++;
      if (!served && failed >= 2) throw new BlobStoreDown(err);
      log.error({ err, attachmentId: attachment.id }, "a sent attachment could not be read: it is shown by its name");
      return null;
    }
    served = true;
    if (!got) log.error({ attachmentId: attachment.id }, "the blob of a sent attachment is missing");
    return got;
  }
  async function show(slot: number, attachment: ContextAttachment): Promise<void> {
    if (stop()) return;
    const room = plan.room(slot);
    // Nothing could take its name's place: the budget is used up.
    if (room <= plan.textTokens(attachmentLabel(attachment))) return;
    const found = loaded.attachments.get(attachment.id);
    if (!found) return;
    if (found.inline) {
      if (!MODEL_IMAGE_MIMES.has(found.mime) || !resolved.vision || !plan.canShowImage()) return;
      if (found.size > Math.min(IMAGE_MAX_BYTES, plan.bytesLeft) || room < IMAGE_TOKENS) return;
      const got = await read(attachment, found.blobKey, found.size);
      if (got?.complete) plan.offer(slot, { type: "image", mime: found.mime, data: got.data });
    } else if (found.mime === "application/pdf") {
      if (!resolved.pdf || found.size > Math.min(PDF_MAX_BYTES, plan.bytesLeft) || room < pdfTokens(found.size)) return;
      const got = await read(attachment, found.blobKey, found.size);
      if (got?.complete) plan.offer(slot, { type: "pdf", data: got.data });
    } else {
      const maxChars = Math.min(FILE_MAX_CHARS, plan.fileCharsLeft);
      // A text costs at least its name, a line break and one character.
      if (maxChars === 0 || plan.bytesLeft === 0 || room < plan.textTokens(attachmentLabel(attachment)) + 2) return;
      const max = Math.min(found.size, maxChars * UTF8_MAX_BYTES_PER_CHAR, plan.bytesLeft);
      const got = await read(attachment, found.blobKey, max, startsLikeText);
      const text = got ? fileText(got.data, got.complete, maxChars) : null;
      if (text) plan.offer(slot, { type: "text", text: withoutCitations(withoutMark(text.text, loaded.mark)), chars: text.chars });
    }
  }

  for (const [slot, attachment] of plan.attachments(false)) await show(slot, attachment);
  plan.keepOlder();
  for (const [slot, attachment] of plan.attachments(true)) await show(slot, attachment);
  // A call that would end with the Agent's own turn ends with `closing` (default `CONTINUE_TURN`, `ContextPlan.build`).
  const { messages, tokens, fixed } = plan.build(closing);
  return { messages, inputTokensEstimate: systemTokens(loaded.system) + tokens, fixedTokens: fixed };
}
