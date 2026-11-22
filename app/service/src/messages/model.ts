import { z } from "zod";
import { REASONING_LEVELS } from "../config.ts";
import type { Tx } from "../db.ts";

export type MessageKind = "text" | "file" | "system";

/** Machine-readable system notices. `actorId` is whoever caused it; it is also stored as `sender_id`. */
export type SystemEvent =
  | { event: "group_created"; actorId: string; title: string; memberIds: string[] }
  | { event: "member_joined"; actorId: string; principalId: string }
  | { event: "member_left"; actorId: string; principalId: string; newCreatorId: string | null }
  | { event: "member_removed"; actorId: string; principalId: string }
  | { event: "group_renamed"; actorId: string; title: string }
  /** In an Agent's conversation: its owner started a new topic; nothing before it is shown to the model again. */
  | { event: "topic_reset"; actorId: string }
  /** In a group: a member stopped Agents calling each other (`POST …/agents/halt`) until a person writes again. */
  | { event: "agents_halted"; actorId: string }
  /**
   * In a group: the last `limit` messages that are not notices were all Agents', so the message of Agent `actorId` called
   * no other Agent; nor will any Agent's until a person writes.
   */
  | { event: "agent_chain_paused"; actorId: string; limit: number }
  /**
   * In a group: Agent `agentId` (also `actorId`) has cost its owner its `chainBudget` in replies other Agents called for
   * since a person last wrote; Agents' messages do not call it until a person writes again.
   */
  | { event: "agent_budget_reached"; actorId: string; agentId: string }
  /**
   * In a group: Agent `agentId` (also `actorId`) has spent today's others' daily budget (`othersBudget`) on replies people
   * other than its owner called for; their calls do not reach it until its owner raises it or the site's day ends. Once a
   * site day per group and Agent.
   */
  | { event: "agent_daily_budget_reached"; actorId: string; agentId: string }
  /**
   * In a group: someone's message asked Agent `agentId` (also `actorId`) to be quiet, and the judgement model was sure of
   * it, so it will hardly reply there unasked for a while; a mention still calls it. At most once an hour per group and
   * Agent.
   */
  | { event: "agent_quieted"; actorId: string; agentId: string }
  /**
   * In an Agent's own conversation, for its owner only: a review of what they said changed (or, when `pending`, proposes to
   * change) the Agent's notes. `changeId` is the `memory_changes` row; `lines` tell what changed, `vaultLines` (the same
   * length) whether each line's note is in the vault afterwards. `unlock`: a request to take notes out of the vault.
   * `full`: a room was too full to take an entry. `status` is stored as it was written; a reader is sent the change's
   * current one (messages/read.ts), or `expired` (with the lines it was stored with) once the record of the change has been swept: the
   * notice stays, and offers nothing to decide. No other reader is sent the notice at all.
   */
  | {
      event: "memory_changed";
      actorId: string;
      changeId: string;
      lines: string[];
      vaultLines: boolean[];
      /** Only when a merge was applied: one per line, true for each `原来：…` line (a note the merge above it joined), never told by its text. */
      sourceLines?: boolean[];
      pending: boolean;
      unlock: boolean;
      full: boolean;
      status: "applied" | "undone" | "pending" | "discarded" | "expired";
      /** Which tier of memory wrote it: after a conversation went quiet (`rest`, the default, and what every notice stored before was) or a consolidation of the notes alone (`dream`). */
      phase?: "rest" | "dream";
      /** The number of lines (`lines.length`); added when it is stored. */
      count?: number;
    }
  | PairEvent;

/** Notices in a pair's direct conversation: `actorId` acted on `principalId`. */
export type PairEvent = {
  event: "friendship_ended" | "friendship_restored" | "blocked" | "unblocked";
  actorId: string;
  principalId: string;
};

/** A file message's attachment as stored in its body and shown on the wire (`attachments` row, frozen at send). */
export interface AttachmentRef {
  id: string;
  /** The sanitised display name; search matches it via `messages.body->'attachment'->>'name'`. */
  name: string;
  size: number;
  /** The server's sniffing verdict: safe to show in the browser (PNG, JPEG, WebP, GIF). */
  inline: boolean;
  /** The content type the server decided from the bytes (`Content-Type` of the download); absent on a message sent before it was kept. */
  mime?: string;
}

/**
 * `messages.body`. Text messages carry `text` (and `replyToSeq` when quoting); file messages carry
 * `attachment` and an optional caption in `text`; system notices carry a `SystemEvent` plus the rendered
 * `text`. An Agent's reply (`postAsAgent`) may add `reasoning` (non-empty), `stopped: true`, `truncated: true` and
 * `proposalId` (the `persona_proposals` row it made), what its tools looked up (messages/lookups.ts: `lookups`,
 * `found`, and in its own conversation `queries` — never sent as stored: messages/read.ts) and its citations, beside its
 * text (`cites`, messages/lookups.ts `Cite`: its text holds none); its greeting `fixed: true`.
 * Later kinds (task cards...) add fields, so readers must not assume more than this.
 */
export type MessageBody = {
  text?: string;
  replyToSeq?: number;
  attachment?: AttachmentRef;
  event?: string;
  [field: string]: unknown;
};

/**
 * Body keys only the context of the same Agent's later replies may read (agents/context.ts `loadPage`; harness design
 * §3, attack R3-m1): never rendered (`toWire` picks its keys one by one), searched, summarised or reviewed, and any new
 * reader of raw bodies — an export, an admin view — must leave them out. `toolCalls`: an Agent's reply's calls in its own
 * conversation (agents/replay.ts).
 */
export const CONTEXT_ONLY_KEYS: readonly string[] = ["toolCalls"];

/**
 * One mention of a message (`messages.mentions`, migration 049; Task M): who it means — a member of the conversation when
 * the message was sent — and the range of the message's text that names it, `start` and `length` in UTF-16 code units of
 * the stored text. Decided once, when the message was sent (agents/mentions.ts `mentionsAtSend`); never read again from
 * the text.
 */
export interface Mention {
  id: string;
  start: number;
  length: number;
}

/**
 * What the reading at send decides of a message (agents/mentions.ts `mentionsAtSend`): its mentions, and whether a typed
 * `@…` asked an Agent it could not name (`messages.asks_agent`, fix round 1).
 */
export interface MentionsRead {
  mentions: Mention[] | null;
  asksAgent: boolean;
}

export interface StoredMessage {
  /** `messages.id`, a bigint, as a string. Never exposed on the wire. */
  id: string;
  conversationId: string;
  seq: number;
  /** The author; for system notices, the principal whose action produced it (shown as `null` on the wire). */
  senderId: string;
  kind: MessageKind;
  body: MessageBody;
  clientTxn: string | null;
  createdAt: Date;
  /** Who its mentions mean, in order of their ranges (`Mention`); null when it names nobody, and for every message from before. */
  mentions: Mention[] | null;
  /**
   * Whether, when it was sent, it asked an Agent it could not name (`messages.asks_agent`): for the proactive judgement
   * alone, never on the wire (messages/read.ts `toWire` does not read it).
   */
  asksAgent: boolean;
}

/** Columns of `messages m` in the shape `toStored` reads. */
export const MESSAGE_COLUMNS = "m.id, m.conversation_id, m.seq, m.sender_id, m.kind, m.body, m.client_txn, m.created_at, m.mentions, m.asks_agent";

/**
 * SQL: message `m` (a `messages` alias, spliced in) is not an Agent's acknowledgement (`body.ack`, "先应一声、再交付"). An
 * acknowledgement is the Agent's message for whom its run heard from and the late-joiner line, but it calls nobody, is
 * no Agent's turn in a chain, adds nothing to unread and is nothing to remember (the controller's rulings, Task 6 fix 1):
 * every reader of those leaves it out with this.
 */
export const notAcknowledgement = (m: string): string => `(${m}.body -> 'ack') is distinct from 'true'::jsonb`;

export interface MessageRow {
  id: string;
  conversation_id: string;
  seq: string;
  sender_id: string;
  kind: MessageKind;
  body: MessageBody;
  client_txn: string | null;
  created_at: Date;
  mentions?: Mention[] | null;
  asks_agent?: boolean;
}

export function toStored(r: MessageRow): StoredMessage {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    seq: Number(r.seq),
    senderId: r.sender_id,
    kind: r.kind,
    body: r.body,
    clientTxn: r.client_txn,
    createdAt: r.created_at,
    mentions: r.mentions ?? null,
    asksAgent: r.asks_agent ?? false,
  };
}

/**
 * Appends a message with the next sequence number (`conversations.seq + 1`, gapless and unique). The
 * caller must already hold the conversation row lock and have checked permission in the same transaction. `read`: who
 * its mentions mean and whether it asked an Agent it could not name, decided by the caller now (agents/mentions.ts
 * `mentionsAtSend`; null: nobody, as for a notice).
 */
export async function insertMessage(
  t: Tx,
  conversationId: string,
  senderId: string,
  kind: MessageKind,
  body: MessageBody,
  clientTxn: string | null,
  read: MentionsRead | null = null,
): Promise<StoredMessage> {
  const mentions = read?.mentions ?? null;
  const { rows } = await t.query<MessageRow>(
    `with next as (update conversations set seq = seq + 1 where id = $1 returning seq)
     insert into messages as m (conversation_id, seq, sender_id, kind, body, client_txn, mentions, asks_agent)
     select $1, next.seq, $2, $3, $4::jsonb, $5, $6::jsonb, $7 from next
     returning ${MESSAGE_COLUMNS}`,
    [conversationId, senderId, kind, JSON.stringify(body), clientTxn, mentions === null || mentions.length === 0 ? null : JSON.stringify(mentions), read?.asksAgent ?? false],
  );
  if (!rows[0]) throw new Error(`insertMessage: conversation ${conversationId} does not exist`);
  return toStored(rows[0]);
}

/**
 * A persona proposal's status as its owner sees it. `stale`: stored so once a confirmation ran into it, and shown so
 * already while it is `open` but the Agent's persona has moved past the version it was made against.
 */
export const PROPOSAL_STATUSES = ["open", "confirmed", "discarded", "superseded", "stale"] as const;

/** A message as one reader receives it. Build it with `toWireFor` (src/messages/read.ts). */
export const wireMessageSchema = z.object({
  conversationId: z.string(),
  seq: z.number(),
  /** `null` for system notices. */
  senderId: z.string().nullable(),
  kind: z.enum(["text", "file", "system"]),
  /** Message text; for system notices the server-rendered sentence. */
  text: z.string(),
  attachment: z.object({ id: z.string(), name: z.string(), size: z.number(), inline: z.boolean(), mime: z.string().optional() }).optional(),
  /** Present when quoting. Text and sender only when this reader can see the quoted message. */
  replyTo: z
    .union([
      z.object({
        seq: z.number(),
        visible: z.literal(true),
        senderId: z.string().nullable(),
        text: z.string(),
        /** What was quoted: a file message may have no caption, so `text` alone cannot say. */
        kind: z.enum(["text", "file"]),
        /** For a quoted file message: its file name. */
        attachmentName: z.string().optional(),
        /** The quoted message's mentions (as `mentions` below), those still inside the preview `text` (cut at 200 characters); absent when none. */
        mentions: z.array(z.object({ id: z.string(), start: z.number(), length: z.number() })).optional(),
      }),
      z.object({ seq: z.number(), visible: z.literal(false) }),
    ])
    .optional(),
  /** For system notices: the `SystemEvent` (without `text`), so a client can re-render it. */
  system: z.looseObject({ event: z.string() }).optional(),
  /**
   * Who its mentions mean, as stored when it was sent (`Mention`: ranges of `text`, UTF-16 code units): to every reader of
   * the message, ids of members only. Absent when it names nobody (and on every message from before mentions were stored).
   */
  mentions: z.array(z.object({ id: z.string(), start: z.number(), length: z.number() })).optional(),
  /**
   * An Agent's reply: the model's reasoning, when it gave any — in its own conversation; in a group only to the Agent's
   * owner, absent for everyone else (never in previews, quotes, search or a later model call).
   */
  reasoning: z.string().optional(),
  /** An Agent's reply its owner stopped: the text is what had been generated by then. */
  stopped: z.literal(true).optional(),
  /**
   * An Agent's acknowledgement: what its reply said before it looked something up, posted at once as a message of its
   * own; the answer comes later as another message of the same reply. Never the reply itself.
   */
  ack: z.literal(true).optional(),
  /** An Agent's reply that was cut: by the model's output limit, the reply time limit, or at 8 000 characters. */
  truncated: z.literal(true).optional(),
  /** An Agent's reply that proposed a persona (agents/persona.ts): shown to the Agent's owner only. */
  proposal: z
    .object({
      id: z.string(),
      status: z.enum(PROPOSAL_STATUSES),
      persona: z.string(),
      intro: z.string().optional(),
      field: z.string().optional(),
    })
    .optional(),
  /**
   * An Agent's reply, to the Agent's owner only (absent for everyone else): what the run that posted it used — the
   * model (a site model's id and its label now, the id when it is no longer configured; a provider model's name), the
   * reasoning level it was sent — and what the owner was charged for it (points: free allowance plus balance, `"0"` on a
   * provider). Absent when the reply has no run (the greeting) or the run's records are not all there.
   */
  via: z
    .object({
      model: z.union([
        z.object({ source: z.literal("site"), id: z.string(), label: z.string() }),
        z.object({ source: z.literal("provider"), model: z.string() }),
      ]),
      reasoning: z.enum(REASONING_LEVELS),
      points: z.string(),
      /** Present (true) only when nobody called the Agent: the reply came from a proactive run. Never false. */
      proactive: z.literal(true).optional(),
      /** Present only when its run searched the web (agents/tools/web): how many searches its `points` include. */
      webSearches: z.number().optional(),
    })
    .optional(),
  /**
   * An Agent's reply whose tools ran: how many calls of each kind (only kinds above 0), to whoever reads the reply. A
   * count of lookups, not of what they found. `web`: web searches that brought results back (a run offered the web tool).
   */
  lookups: z.object({ search: z.number().optional(), file: z.number().optional(), time: z.number().optional(), web: z.number().optional() }).optional(),
  /**
   * An Agent's reply whose run searched the web (agents/tools/web; lane websearch): every page its run was handed, cited
   * or not — its number, address (https) and title — to every reader of the reply alike (public pages). Absent otherwise.
   */
  webSources: z.array(z.object({ n: z.number(), url: z.string(), title: z.string() })).optional(),
  /**
   * Present (true) whenever its run was handed web pages, decided from what is stored (even if none of them is sent): a
   * client shows its own links and bare addresses as plain text, so that only its sources open anything.
   */
  plainLinks: z.literal(true).optional(),
  /** Where its text cites one of `webSources` (`at` as a cite's, ascending; `n` its number). Absent when none. */
  webCites: z.array(z.object({ at: z.number(), n: z.number() })).optional(),
  /** Of the messages its tools found, those this reader can see now (VISIBLE_JOIN), in order; absent when none is. */
  found: z.array(z.object({ conversationId: z.string(), seq: z.number() })).optional(),
  /** The words its searches were for: to the Agent's owner, in the Agent's own conversation only. */
  queries: z.array(z.string()).optional(),
  /**
   * An Agent's reply: its citations, kept beside its text (messages/lookups.ts `Cite`; the text holds none) — where each
   * stands in `text` (UTF-16 code units, ascending), whether it cites a message or a file, and the message it points to
   * (for a file, the message it was sent in): of those, the ones whose message this reader can see now (VISIBLE_JOIN);
   * absent when none is.
   */
  cites: z
    .array(z.object({ at: z.number(), kind: z.enum(["m", "f"]), ref: z.object({ conversationId: z.string(), seq: z.number() }) }))
    .optional(),
  createdAt: z.string(),
});

export type WireMessage = z.infer<typeof wireMessageSchema>;
