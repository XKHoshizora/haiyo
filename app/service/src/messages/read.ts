import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { formatPoints } from "../accounts/store.ts";
import type { Config, ReasoningLevel } from "../config.ts";
import { VISIBLE_JOIN, visibleJoin, type ConversationType } from "../conversations/store.ts";
import type { Queryable } from "../db.ts";
import type { StoredOp } from "../memory/apply.ts";
import { dreamLines, linesOf } from "../memory/lines.ts";
import { citesOf, foundOf, handedWebPages, lookupsOf, queriesOf, webCitesOf, webSourcesOf, type Cite, type MessageRef } from "./lookups.ts";
import { MESSAGE_COLUMNS, toStored, type MessageRow, type StoredMessage, type WireMessage } from "./model.ts";
import { principalsOf, type SyncPrincipal } from "./principals.ts";

/**
 * What rendering a message needs of the configuration: the site models, whose labels `via` names them by when a message
 * is read (README "Wire shapes").
 */
export type ReadConfig = Pick<Config, "siteModels">;

export const QUOTE_MAX_CHARS = 200;

function truncate(text: string, max: number): string {
  let out = "";
  let n = 0;
  for (const ch of text) {
    if (n++ === max) break;
    out += ch;
  }
  return out;
}

const wireText = (m: StoredMessage): string => (typeof m.body.text === "string" ? m.body.text : "");

type WireProposal = NonNullable<WireMessage["proposal"]>;

/** A persona proposal as `toWireForReaders` reads it: whose Agent's it is decides who is shown it. */
interface ProposalRow {
  id: string;
  message_id: string;
  owner_id: string;
  status: WireProposal["status"];
  persona: string;
  intro: string | null;
  field: string | null;
  /** Open, but the Agent's persona has moved past the version it was made against. */
  stale: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The proposal a message's body names (`postAsAgent` writes `proposalId`; nobody can send one), or null. */
const proposalIdOf = (m: StoredMessage): string | null =>
  m.kind === "text" && typeof m.body.proposalId === "string" && UUID.test(m.body.proposalId) ? m.body.proposalId : null;

/**
 * The proposals `msgs` name, by id, in one query: each with its Agent's owner and whether it is stale now (open, but
 * the persona version moved: computed at read time, the stored status changes only when a confirmation hits it).
 */
async function proposalsOf(q: Queryable, msgs: StoredMessage[]): Promise<Map<string, ProposalRow>> {
  const ids = [...new Set(msgs.map(proposalIdOf).filter((id): id is string => id !== null))];
  if (ids.length === 0) return new Map();
  const { rows } = await q.query<ProposalRow>(
    `select pp.id, pp.message_id::text, p.owner_id, pp.status, pp.persona, pp.intro, pp.field,
            (pp.status = 'open' and pp.base_persona_version <> a.persona_version) as stale
       from persona_proposals pp
       join agents a on a.principal_id = pp.agent_id
       join principals p on p.id = pp.agent_id
      where pp.id = any($1::uuid[])`,
    [ids],
  );
  return new Map(rows.map((r) => [r.id, r]));
}

function toWireProposal(r: ProposalRow): WireProposal {
  return {
    id: r.id,
    status: r.stale ? "stale" : r.status,
    persona: r.persona,
    ...(r.intro === null ? {} : { intro: r.intro }),
    ...(r.field === null ? {} : { field: r.field }),
  };
}

type WireVia = NonNullable<WireMessage["via"]>;

/**
 * What the visibility query of `toWireForReaders` reads of the run that posted a message, for the reader who owns the
 * Agent that sent it (every column null for anyone else, and when any of the run's records is missing).
 */
interface ViaRow {
  via_source: "site" | "provider" | null;
  via_model: string | null;
  via_reasoning: ReasoningLevel | null;
  /** Micro-points charged for the run (free allowance plus balance), as text. */
  via_points: string | null;
  /** Whether the run was a proactive one (nobody called its Agent) as stored on the run row: a run a mention took over is not. */
  via_proactive: boolean | null;
  /** The web searches its points include (usage record `web_searches`, migration 064). */
  via_web: number | null;
}

/**
 * `via` from what the query read: a site model by its id and its configured label now (its id when it is no longer
 * configured; never its upstream name, address, key variable or prices), a provider model by the name its owner saved;
 * `webSearches` only when its run searched the web.
 */
function toWireVia(r: ViaRow, config: ReadConfig): WireVia | null {
  if (r.via_source === null || r.via_model === null || r.via_reasoning === null || r.via_points === null) return null;
  const id = r.via_model;
  const model: WireVia["model"] =
    r.via_source === "site" ? { source: "site", id, label: config.siteModels.find((m) => m.id === id)?.label ?? id } : { source: "provider", model: id };
  return {
    model,
    reasoning: r.via_reasoning,
    points: formatPoints(BigInt(r.via_points)),
    ...(r.via_proactive === true ? { proactive: true as const } : {}),
    ...(r.via_web !== null && r.via_web > 0 ? { webSearches: r.via_web } : {}),
  };
}

/**
 * A run id as a message's `client_txn` names it: `postAsAgent` writes the run's id there for its reply, and `ack:` and the
 * run's id for its acknowledgement (`acknowledgementTxn`); a person's is any string.
 */
const RUN_TXN_TEXT = "^(ack:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

/** The `client_txn` of run `runId`'s acknowledgement (agents/conversation.ts `postAsAgent`, "先应一声、再交付"). */
export const acknowledgementTxn = (runId: string): string => `ack:${runId}`;

/**
 * SQL: run `run` (an `agent_runs` alias) posted message `message` (a `messages` alias, spliced in: only aliases) — a
 * reply run of its sender in its conversation whose id the message's `client_txn` names (`postAsAgent`): its reply, or
 * its acknowledgement. A person's message names no run. Who is behind an Agent's message (agents/runs.ts `behindMessageSql`),
 * whom it heard from (`heardIn`), where it belongs in a later reply's context (agents/context.ts), and the `via` of a
 * reply here (its reply only).
 */
export const postingRun = (message: string, run: string): string =>
  `${run}.id = case when ${message}.client_txn ~ '${RUN_TXN_TEXT}' then right(${message}.client_txn, 36)::uuid end
   and ${run}.agent_id = ${message}.sender_id and ${run}.conversation_id = ${message}.conversation_id and ${run}.purpose = 'reply'`;

/** A memory-change notice (`memory_changed`, written by the reviewer): for its owner alone. */
const isMemoryNotice = (m: StoredMessage): boolean => m.kind === "system" && m.body.event === "memory_changed";

/** A persona-aid card (`persona_fact`, memory/persona-aid.ts): a sentence of the persona that looks like a fact; for its Agent's owner alone. */
const isPersonaCard = (m: StoredMessage): boolean => m.kind === "system" && m.body.event === "persona_fact";

/** How each persona card stands, and whose each is: the owners of the Agents the cards speak for, by Agent id, and the answers, by message id. */
async function personaCardsOf(q: Queryable, msgs: StoredMessage[]): Promise<{ owners: Map<string, string>; answers: Map<string, string> }> {
  const cards = msgs.filter(isPersonaCard);
  if (cards.length === 0) return { owners: new Map(), answers: new Map() };
  const agents = [...new Set(cards.map((m) => m.body.agentId).filter((id): id is string => typeof id === "string" && UUID.test(id)))];
  const owned = agents.length === 0 ? [] : (await q.query<{ id: string; owner_id: string }>("select id, owner_id from principals where id = any($1::uuid[]) and owner_id is not null", [agents])).rows;
  const answered = await q.query<{ message_id: string; answer: string }>("select message_id::text, answer from social_card_answers where message_id = any($1::bigint[])", [cards.map((m) => m.id)]);
  return { owners: new Map(owned.map((r) => [r.id, r.owner_id])), answers: new Map(answered.rows.map((r) => [r.message_id, r.answer])) };
}

interface ChangeRow {
  id: string;
  owner_id: string;
  status: "applied" | "undone" | "pending" | "discarded";
  full: boolean;
  /** What the change recorded: only for a notice that asked first and was decided since, whose lines are written again (never sent as they are). */
  ops: Array<StoredOp | { op: "hearsay_add" | "hearsay_drop" }>;
}

/**
 * The changes the memory notices in `msgs` name, by id: whose they are and how they stand now; and the owners of the Agents the notices
 * speak for (`owners`, by Agent id), which says whose a notice is once its change has been swept away.
 */
async function memoryChangesOf(q: Queryable, msgs: StoredMessage[]): Promise<{ changes: Map<string, ChangeRow>; owners: Map<string, string> }> {
  const notices = msgs.filter(isMemoryNotice);
  const ids = [...new Set(notices.map((m) => m.body.changeId).filter((id): id is string => typeof id === "string" && UUID.test(id)))];
  const actors = [...new Set(notices.map((m) => m.body.actorId).filter((id): id is string => typeof id === "string" && UUID.test(id)))];
  if (ids.length === 0) return { changes: new Map(), owners: new Map() };
  const { rows } = await q.query<ChangeRow>(`select id, owner_id, status, "full", ops from memory_changes where id = any($1::uuid[])`, [ids]);
  const owned = actors.length === 0 ? [] : (await q.query<{ id: string; owner_id: string }>("select id, owner_id from principals where id = any($1::uuid[]) and owner_id is not null", [actors])).rows;
  return { changes: new Map(rows.map((r) => [r.id, r])), owners: new Map(owned.map((r) => [r.id, r.owner_id])) };
}

/** Whether `op` is a note's own operation (a change holds only one kind: a hearsay change has none of these). */
const isNoteOp = (op: ChangeRow["ops"][number]): op is StoredOp => op.op !== "hearsay_add" && op.op !== "hearsay_drop";

/**
 * What this reader is sent of what a reply's tools looked up besides its counts: the messages found they can see, the
 * words when they are for them, and of its text's citations those whose message they can see.
 */
interface Looked {
  found: MessageRef[];
  queries: string[];
  cites: Cite[];
}
const NOTHING_LOOKED: Looked = { found: [], queries: [], cites: [] };

/**
 * Module-private on purpose: it renders whatever quote, proposal, `via` and `looked` it is handed, and the reasoning when
 * told to. Every exported path decides per reader, through VISIBLE_JOIN, both whether `msg` is shown at all and whether
 * `visibleQuote` is — and each message its tools found (`looked.found`); shows a proposal and `via` to the Agent's owner
 * only, the search words (`looked.queries`) to that owner in the Agent's own conversation only; and `withReasoning`
 * only when this reader may read the reasoning (`toWireForReaders`): otherwise each field is absent, so the message is
 * exactly as one stored without any. A reply's `lookups` — counts only — go to whoever is shown it.
 */
function toWire(
  msg: StoredMessage,
  visibleQuote: StoredMessage | null,
  proposal: ProposalRow | null,
  withReasoning: boolean,
  via: WireVia | null,
  looked: Looked = NOTHING_LOOKED,
): WireMessage {
  const wire: WireMessage = {
    conversationId: msg.conversationId,
    seq: msg.seq,
    senderId: msg.kind === "system" ? null : msg.senderId,
    kind: msg.kind,
    text: wireText(msg),
    createdAt: msg.createdAt.toISOString(),
  };
  const attachment = msg.body.attachment;
  if (msg.kind === "file" && attachment) {
    wire.attachment = { id: attachment.id, name: attachment.name, size: attachment.size, inline: attachment.inline, ...(attachment.mime ? { mime: attachment.mime } : {}) };
  }
  const replyToSeq = msg.body.replyToSeq;
  if (typeof replyToSeq === "number") {
    const q = visibleQuote;
    if (q && q.conversationId === msg.conversationId && q.seq === replyToSeq) {
      const quote: Extract<NonNullable<WireMessage["replyTo"]>, { visible: true }> = {
        seq: replyToSeq,
        visible: true,
        senderId: q.kind === "system" ? null : q.senderId,
        text: truncate(wireText(q), QUOTE_MAX_CHARS),
        kind: q.kind === "file" ? "file" : "text",
      };
      if (q.kind === "file" && q.body.attachment) quote.attachmentName = q.body.attachment.name;
      // Its mentions as the quoted message stored them, kept where they still lie inside the (cut) preview: to the same reader the preview is for.
      const inQuote = q.kind === "system" || q.mentions === null ? [] : q.mentions.filter((m) => m.start + m.length <= quote.text.length);
      if (inQuote.length > 0) quote.mentions = inQuote.map(({ id, start, length }) => ({ id, start, length }));
      wire.replyTo = quote;
    } else {
      wire.replyTo = { seq: replyToSeq, visible: false };
    }
  }
  // Who its mentions mean, as stored when it was sent (ids of members then): to every reader of the message alike.
  if (msg.kind !== "system" && msg.mentions !== null && msg.mentions.length > 0) {
    wire.mentions = msg.mentions.map(({ id, start, length }) => ({ id, start, length }));
  }
  if (msg.kind === "system" && typeof msg.body.event === "string") {
    const { text: _text, ...event } = msg.body;
    wire.system = { ...event, event: msg.body.event };
  }
  if (msg.kind === "text") {
    // Only an Agent's reply carries these (postAsAgent); nobody can send them. Its reasoning only to whom it is for.
    if (withReasoning && typeof msg.body.reasoning === "string" && msg.body.reasoning !== "") wire.reasoning = msg.body.reasoning;
    if (msg.body.stopped === true) wire.stopped = true;
    if (msg.body.ack === true) wire.ack = true;
    if (msg.body.truncated === true) wire.truncated = true;
    if (proposal) wire.proposal = toWireProposal(proposal);
    if (via) wire.via = via;
    const lookups = lookupsOf(msg.body.lookups);
    if (lookups) wire.lookups = lookups;
    if (looked.found.length > 0) wire.found = looked.found;
    if (looked.queries.length > 0) wire.queries = looked.queries;
    if (looked.cites.length > 0) wire.cites = looked.cites;
    // The web pages its run was handed (agents/tools/web) and where its text cites them: public pages, to every reader.
    // That it was handed any is said apart (`plainLinks`: its links show as plain text), from the stored list as it is,
    // whatever of it the checks below keep.
    if (handedWebPages(msg.body.webSources)) wire.plainLinks = true;
    const sources = webSourcesOf(msg.body.webSources);
    if (sources.length > 0) {
      wire.webSources = sources;
      const webCites = webCitesOf(msg.body.webCites, sources, wireText(msg).length);
      if (webCites.length > 0) wire.webCites = webCites;
    }
  }
  return wire;
}

/**
 * For fan-out: what each reader may see of `msgs`. Per reader (keyed by lower-case id; every reader is a
 * key) the messages that reader can see now, in the given order, each with its quote resolved for that
 * reader — `{visible: true, senderId, text}` only if the quoted message is visible to them, else
 * `{seq, visible: false}` — and, on an Agent's reply that proposed a persona, its `proposal` when the reader is that
 * Agent's owner. An Agent's reasoning, per reader in the same query that decides visibility: in an Agent's own
 * conversation to whoever may see the message (its owner); in a group only when the reader owns the Agent that sent it
 * (the sender principal's `owner_id` as it is when the message is read); nowhere else (a direct chat has no Agent). For
 * every other reader the field is absent (`toWire`). The same reader, and only they, gets `via` on an Agent's reply in
 * either place: what the run that posted it (`client_txn` = the run's id, a run of that Agent in that conversation) was
 * admitted on — source, model, reasoning level — and charged (its usage record), read in that same query by one more
 * join, which looks only when the reader owns the sender; absent when the reply has no run, or a record of it is gone.
 * What an Agent's reply looked up with its tools (messages/lookups.ts): its counts (`lookups`) to every reader of it; of
 * the messages its tools found (`found`), each reader only those they can see now, by VISIBLE_JOIN as the reply itself —
 * the others dropped without a trace, the key absent when none is left; its search words (`queries`) only to the owner
 * of the Agent that sent it, in the Agent's own conversation (in the same query that decides visibility), never in a
 * group, whatever the stored body holds. A message carries, for the one person a refusal is for alone, the Agents a LIMIT kept a
 * call of it from and why (`refused`: `call_refusals`, migration 077, its `sender_id`): a person's message for its sender, an
 * Agent's relay for the person behind it (limits redesign C-d) — in the order they were recorded, read in the same query by one
 * more join; nobody else is sent the key.
 * Every visibility decision goes through VISIBLE_JOIN, so an owner who left the group reads nothing of it; a fixed number
 * of queries however many readers and messages there are. `config`: the site models' labels, read now.
 */
export async function toWireForReaders(
  q: Queryable,
  readerIds: string[],
  msgs: StoredMessage[],
  config: ReadConfig,
): Promise<Map<string, WireMessage[]>> {
  const readers = [...new Set(readerIds.map((id) => id.toLowerCase()))];
  const out = new Map<string, WireMessage[]>(readers.map((r) => [r, []]));
  if (readers.length === 0 || msgs.length === 0) return out;

  const shown = await q.query<{ reader_id: string; id: string; with_reasoning: boolean; with_queries: boolean; refused: WireMessage["refused"] | null } & ViaRow>(
    `select r.reader_id, m.id,
            coalesce(c.type = 'agent' or (c.type in ('group', 'agent_social') and sender.owner_id = r.reader_id), false) as with_reasoning,
            coalesce(c.type = 'agent' and sender.owner_id = r.reader_id, false) as with_queries,
            via.source as via_source, via.model as via_model, via.reasoning as via_reasoning, via.points as via_points,
            via.proactive as via_proactive, via.web as via_web, refusal.refused
       from unnest($1::uuid[]) as r (reader_id)
       cross join messages m ${visibleJoin("r.reader_id")}
       join conversations c on c.id = m.conversation_id
       left join principals sender on sender.id = m.sender_id
       left join lateral (
         select run.source, run.model, run.reasoning, (u.free_micro + u.balance_micro)::text as points, run.lane = 'proactive' as proactive, u.web_searches as web
           from agent_runs run
           join usage_records u on u.run_id = run.id
          where sender.owner_id = r.reader_id and m.kind = 'text' and ${postingRun("m", "run")} and m.client_txn = run.id::text
            and run.source is not null and run.model is not null and run.reasoning is not null
       ) via on true
       left join lateral (
         select json_agg(json_build_object('agentId', cr.agent_id, 'reason', cr.reason) order by cr.created_at, cr.agent_id) as refused
           from call_refusals cr
          where cr.sender_id = r.reader_id and m.kind <> 'system' and cr.conversation_id = m.conversation_id and cr.seq = m.seq
       ) refusal on true
      where m.id = any($2::bigint[])`,
    [readers, msgs.map((m) => m.id)],
  );
  const visible = new Set(shown.rows.map((r) => `${r.reader_id}|${r.id}`));
  const shownToAnyone = new Set(shown.rows.map((r) => r.id));
  /** reader|message pairs whose reasoning this reader is sent. */
  const reasoningFor = new Set(shown.rows.filter((r) => r.with_reasoning === true).map((r) => `${r.reader_id}|${r.id}`));
  /** reader|message pairs whose search words this reader is sent: the Agent's owner, in its own conversation. */
  const queriesFor = new Set(shown.rows.filter((r) => r.with_queries === true).map((r) => `${r.reader_id}|${r.id}`));
  /** reader|message → what the run that posted it used, for the owner of the Agent that sent it. */
  const viaFor = new Map<string, WireVia>();
  /** reader|message → what a limit refused of its calls, for its sender. */
  const refusedFor = new Map<string, NonNullable<WireMessage["refused"]>>();
  for (const r of shown.rows) {
    const via = toWireVia(r, config);
    if (via) viaFor.set(`${r.reader_id}|${r.id}`, via);
    if (r.refused && r.refused.length > 0) refusedFor.set(`${r.reader_id}|${r.id}`, r.refused);
  }

  const quoting = msgs.filter((m) => typeof m.body.replyToSeq === "number" && shownToAnyone.has(m.id));
  const quotes = new Map<string, StoredMessage>();
  if (quoting.length > 0) {
    const { rows } = await q.query<MessageRow & { reader_id: string }>(
      `select r.reader_id, ${MESSAGE_COLUMNS}
         from unnest($1::uuid[]) as r (reader_id)
         cross join unnest($2::uuid[], $3::bigint[]) as wanted (conversation_id, seq)
         join messages m on m.conversation_id = wanted.conversation_id and m.seq = wanted.seq
         ${visibleJoin("r.reader_id")}`,
      [readers, quoting.map((m) => m.conversationId), quoting.map((m) => m.body.replyToSeq)],
    );
    for (const r of rows) quotes.set(`${r.reader_id}|${r.conversation_id}|${r.seq}`, toStored(r));
  }

  // What a reply's tools found, and what its text's citations point at: each message by the same rule as the reply itself (VISIBLE_JOIN,
  // the reader's own), so a reader is pointed only at what they can open — not at a message from before they joined, of
  // a conversation they are not in, or that is not there. One query for every reader and reply, both together.
  const replies = msgs.filter((m) => m.kind === "text" && shownToAnyone.has(m.id));
  const foundIn = new Map(replies.map((m) => [m.id, foundOf(m.body.found)]));
  const citesOfReply = new Map(replies.map((m) => [m.id, citesOf(m.body.cites, undefined, wireText(m).length)]));
  const refs = new Map<string, MessageRef>();
  for (const list of foundIn.values()) for (const r of list) refs.set(`${r.conversationId}|${r.seq}`, r);
  for (const cited of citesOfReply.values()) for (const { ref: r } of cited) refs.set(`${r.conversationId}|${r.seq}`, r);
  /** reader|conversation|seq of the messages found that this reader can see. */
  const foundSeen = new Set<string>();
  if (refs.size > 0) {
    const wanted = [...refs.values()];
    const { rows } = await q.query<{ reader_id: string; conversation_id: string; seq: string }>(
      `select r.reader_id, m.conversation_id, m.seq::text
         from unnest($1::uuid[]) as r (reader_id)
         cross join unnest($2::uuid[], $3::bigint[]) as wanted (conversation_id, seq)
         join messages m on m.conversation_id = wanted.conversation_id and m.seq = wanted.seq
         ${visibleJoin("r.reader_id")}
        where m.kind in ('text', 'file')`,
      [readers, wanted.map((r) => r.conversationId), wanted.map((r) => r.seq)],
    );
    for (const r of rows) foundSeen.add(`${r.reader_id}|${r.conversation_id}|${r.seq}`);
  }
  /** What `reader` is sent of what `m`'s tools looked up besides the counts (`key`: reader|message). */
  const seen = (reader: string) => (r: MessageRef): boolean => foundSeen.has(`${reader}|${r.conversationId}|${r.seq}`);
  const lookedFor = (reader: string, m: StoredMessage, key: string): Looked => ({
    found: (foundIn.get(m.id) ?? []).filter(seen(reader)),
    queries: queriesFor.has(key) ? queriesOf(m.body.queries) : [],
    cites: (citesOfReply.get(m.id) ?? []).filter((c) => seen(reader)(c.ref)),
  });

  const proposals = await proposalsOf(q, msgs.filter((m) => shownToAnyone.has(m.id)));
  /** The proposal `m` made, when `reader` owns the Agent that made it. */
  const proposalFor = (reader: string, m: StoredMessage): ProposalRow | null => {
    const id = proposalIdOf(m);
    const p = id === null ? undefined : proposals.get(id);
    return p && p.message_id === m.id && p.owner_id === reader ? p : null;
  };

  const { changes, owners } = await memoryChangesOf(q, msgs.filter((m) => shownToAnyone.has(m.id)));
  const personaCards = await personaCardsOf(q, msgs.filter((m) => shownToAnyone.has(m.id)));

  for (const reader of readers) {
    const list = out.get(reader)!;
    for (const m of msgs) {
      if (!visible.has(`${reader}|${m.id}`)) continue;
      const key = `${reader}|${m.id}`;
      if (isMemoryNotice(m)) {
        // Only the owner whose change it is is sent it (with the change's state now); no one else, whatever their access.
        const change = changes.get(String(m.body.changeId));
        // The change's record is swept 30 days after it is over: the notice stays then, as its own owner's (the Agent's), with the lines it was
        // stored with and nothing to decide (`expired`).
        if (change ? change.owner_id !== reader : owners.get(String(m.body.actorId)) !== reader) continue;
        const wire = toWire(m, null, null, false, null);
        // A notice stored before 入梦 existed has neither phase nor count: it is a `rest` one.
        const lines = Array.isArray(m.body.lines) ? m.body.lines.length : 0;
        const phase = m.body.phase === "dream" ? "dream" : "rest";
        wire.system = {
          ...wire.system!,
          phase,
          count: typeof m.body.count === "number" ? m.body.count : lines,
          status: change ? change.status : "expired",
          pending: change?.status === "pending",
          full: change ? change.full : m.body.full === true,
        };
        // A card that asked first (stored in the future tense) reads in the past once its change was done: written again from what the change recorded
        // (only what was applied: a confirmation may have left out in-place ops that went stale), its count with it.
        if (change && m.body.pending === true && m.body.unlock !== true && (change.status === "applied" || change.status === "undone")) {
          const done = change.ops.filter(isNoteOp);
          if (done.length > 0) {
            const told = (phase === "dream" ? dreamLines : linesOf)(done, false);
            Object.assign(wire.system, told, { count: told.lines.length });
          }
        }
        list.push(wire);
        continue;
      }
      if (isPersonaCard(m)) {
        // Only the owner of the Agent the card is about is sent it, with how it stands; no one else, whatever their access.
        if (personaCards.owners.get(String(m.body.agentId)) !== reader) continue;
        const wire = toWire(m, null, null, false, null);
        const expires = typeof m.body.expiresAt === "string" ? Date.parse(m.body.expiresAt) : Number.NaN;
        wire.system = { ...wire.system!, card: { answer: personaCards.answers.get(m.id) ?? null, expired: !(expires > Date.now()), sentence: String(m.body.sentence ?? "") } };
        list.push(wire);
        continue;
      }
      const quote = quotes.get(`${reader}|${m.conversationId}|${m.body.replyToSeq}`) ?? null;
      const wire = toWire(m, quote, proposalFor(reader, m), reasoningFor.has(key), viaFor.get(key) ?? null, lookedFor(reader, m, key));
      // Its sender's alone: what a limit refused of its calls.
      const refused = refusedFor.get(key);
      if (refused) wire.refused = refused;
      list.push(wire);
    }
  }
  return out;
}

/** `toWireForReaders` for one reader: the subset of `msgs` they can see, quotes resolved for them. */
export async function toWireFor(q: Queryable, readerId: string, msgs: StoredMessage[], config: ReadConfig): Promise<WireMessage[]> {
  return (await toWireForReaders(q, [readerId], msgs, config)).get(readerId.toLowerCase())!;
}

export interface MessagePage {
  /** Ascending by seq. */
  messages: WireMessage[];
  /** Pass as `before` for the next older page; null when no older visible message exists. */
  nextBefore: number | null;
  /** Everyone these messages name (senders, visible quotes, notices), by id. */
  principals: Record<string, SyncPrincipal>;
}

/**
 * Up to `limit` visible messages with seq < `before`, newest page first. Null when not a current member.
 * Membership and messages come from one statement; rendering re-checks visibility, so a concurrent
 * removal can only hide messages, never reveal them.
 */
export async function listMessages(
  q: Queryable,
  readerId: string,
  conversationId: string,
  { before, limit }: { before?: number; limit: number },
  config: ReadConfig,
): Promise<MessagePage | null> {
  const { rows } = await q.query<MessageRow | { [K in keyof MessageRow]: null }>(
    `select ${MESSAGE_COLUMNS}
       from memberships me
       left join lateral (
         select m.* from messages m ${VISIBLE_JOIN}
          where m.conversation_id = me.conversation_id and ($3::bigint is null or m.seq < $3::bigint)
          order by m.seq desc limit $4
       ) m on true
      where me.conversation_id = $2 and me.principal_id = $1 and me.left_seq is null
      order by m.seq desc`,
    [readerId, conversationId, before ?? null, limit + 1],
  );
  if (rows.length === 0) return null; // not a current member
  const found = rows.filter((r): r is MessageRow => r.id !== null);
  const page = found.slice(0, limit).reverse().map(toStored);
  const messages = await toWireFor(q, readerId, page, config);
  return {
    messages,
    nextBefore: found.length > limit ? page[0]!.seq : null,
    principals: await principalsOf(q, messages),
  };
}

/** One visible message, or null (not a member, not visible, or not there — indistinguishable). */
export async function getMessage(q: Queryable, readerId: string, conversationId: string, seq: number, config: ReadConfig): Promise<WireMessage | null> {
  const { rows } = await q.query<MessageRow>(
    `select ${MESSAGE_COLUMNS} from messages m ${VISIBLE_JOIN} where m.conversation_id = $2 and m.seq = $3`,
    [readerId, conversationId, seq],
  );
  if (!rows[0]) return null;
  const [wire] = await toWireFor(q, readerId, [toStored(rows[0])], config);
  return wire ?? null;
}

export interface ReadResult {
  readSeq: number;
  /** The marker before this call; equal to `readSeq` when nothing moved. */
  previous: number;
  type: ConversationType;
}

/**
 * Moves the reader's read marker to `seq`, clamped to [current read_seq, conversations.seq]: never
 * backwards, never beyond the last message. It is only a number and proves nothing about visibility.
 * Null when not a current member. The row is locked first, so `previous` is exact under concurrency.
 */
export async function markRead(q: Queryable, readerId: string, conversationId: string, seq: number): Promise<ReadResult | null> {
  const { rows } = await q.query<{ read_seq: string; previous: string; type: ConversationType }>(
    `with prev as (
       select ms.id, ms.read_seq from memberships ms
        where ms.conversation_id = $1 and ms.principal_id = $2 and ms.left_seq is null
        for update
     )
     update memberships ms set read_seq = greatest(prev.read_seq, least($3::bigint, c.seq))
       from prev, conversations c
      where ms.id = prev.id and c.id = ms.conversation_id
      returning ms.read_seq, prev.read_seq as previous, c.type`,
    [conversationId, readerId, seq],
  );
  const r = rows[0];
  return r ? { readSeq: Number(r.read_seq), previous: Number(r.previous), type: r.type } : null;
}

// --- read-marker events ---------------------------------------------------------------------

/** A principal's read marker moved forward to `seq`: someone's in a direct conversation, or an Agent's in its conversation. */
export interface ReadMarker {
  conversationId: string;
  principalId: string;
  seq: number;
}

export type ReadListener = (marker: ReadMarker) => void | Promise<void>;

/** Per-app registry (on `Deps`) of read-marker listeners, in the style of `ConversationEvents`. */
export interface ReadEvents {
  onRead(fn: ReadListener): () => void;
  /** Call only after the marker was stored (a direct chat's, or an Agent's in its conversation). Never throws; failures are logged. */
  publish(marker: ReadMarker, log: Pick<FastifyBaseLogger, "error">): void;
}

export function createReadEvents(): ReadEvents {
  const listeners = new Set<ReadListener>();
  return {
    onRead(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    publish(marker, log) {
      for (const fn of [...listeners]) {
        try {
          Promise.resolve(fn({ ...marker })).catch((err) => log.error({ err }, "read listener failed"));
        } catch (err) {
          log.error({ err }, "read listener failed");
        }
      }
    },
  };
}

/** Subscribe to read-marker moves (direct chats; an Agent's in its conversation). Returns unsubscribe. */
export function onRead(app: FastifyInstance, fn: ReadListener): () => void {
  return app.deps.reads.onRead(fn);
}
