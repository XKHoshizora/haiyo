import { randomUUID } from "node:crypto";
import { lockAccount } from "../accounts/store.ts";
import type { Config } from "../config.ts";
import type { Change } from "../conversations/events.ts";
import { currentMembership, VISIBLE_JOIN } from "../conversations/store.ts";
import { appendSystem } from "../conversations/system.ts";
import type { Queryable, Tx } from "../db.ts";
import { AppError, notFound } from "../errors.ts";
import { foundOf, lookupsOf, queriesOf, type Cite, type LookupFields, type MessageRef } from "../messages/lookups.ts";
import { acknowledgementTxn, postingRun } from "../messages/read.ts";
import { insertMessage, MESSAGE_COLUMNS, toStored, type MessageBody, type MessageRow, type StoredMessage } from "../messages/model.ts";
import { MESSAGE_TEXT_MAX } from "../messages/send.ts";
import { cleanModelText, hasVisibleText } from "../schemas.ts";
import { addressRanges, codeRanges, mentionsAtSend } from "./mentions.ts";
import { parseProposalBlock, PROPOSAL_PLACEHOLDER, storeProposal } from "./persona.ts";
import { RunNotRunning } from "./runtime/port.ts";
import { withoutMarkPlaced } from "./runtime/prompt.ts";
import { hearFrom, noneTriggered, ownedAgentOf, triggerFromAgent, type Lane, type RunLimits, type Triggered } from "./runs.ts";
import { forgetSummaries } from "./summary/store.ts";
import { askedOf } from "./tools/elsewhere.ts";
import { cutPlaced, takeCites, trimPlaced, withoutMarkFrom, withoutSpanPlaced, type Placed, type RunRefs } from "./tools/refs.ts";
import { whisperOfRun } from "../whispers/store.ts";
import {
  agentLimit,
  assertModelChoice,
  countLiveAgents,
  lockAgent,
  modelParams,
  type AgentModel,
  type AgentRow,
  type GroupMentions,
  type ReplyMode,
} from "./store.ts";
import type { ProactiveLevel, ReasoningLevel } from "../config.ts";

/** The most of a reply's reasoning that is stored; the rest is cut (it is never shown to a model again). */
export const REASONING_MAX = 32_000;

export const greetingText = (name: string): string =>
  `你好，我是「${name}」，你刚刚创建的 Agent。我现在还没有设定。你希望我是谁、主要帮你做什么、用什么语气说话？直接告诉我就行，说完我会整理成一份设定给你确认。`;

export interface NewAgent {
  /** Its name part: its handle is `<owner's handle>.<name part>` (family names). */
  namePart: string;
  name: string;
  intro: string;
  field: string;
  persona: string;
  replyMode: ReplyMode;
  groupMentions: GroupMentions;
  chainBudgetMicro: bigint;
  othersBudgetMicro: bigint | null;
  proactive: boolean;
  proactiveLevel: ProactiveLevel;
  proactiveBudgetMicro: bigint;
  memory: boolean;
  memoryAsk: boolean;
  sharedNotes: boolean;
  whisperElsewhere: boolean;
  ownerAppellation: string | null;
  reasoning: ReasoningLevel;
  model: AgentModel;
}

/**
 * Creates an Agent in one transaction: its principal (kind `agent`, owned by `ownerId`), the `agents` row, the
 * dedicated conversation (type `agent`, `agent_conversations`, owner and Agent as speakers from seq 0) and, when
 * there is no persona yet, the fixed greeting from the Agent. The owner's account lock (taken first: it also
 * serialises the count) decides the limit: 403 `agent_limit` at the tier's number of Agents that are not deleted
 * (a tier `config` no longer names gets the `free` number). 409 `handle_taken` when one of the owner's Agents that is
 * not deleted has the name part — decided under that same lock, the only place an Agent is made, so two creations take
 * turns (migration 048: no index sees `agents.deleted_at`); 400 for a model or reasoning level that does not fit.
 */
export async function createAgent(
  t: Tx,
  ownerId: string,
  input: NewAgent,
  config: Pick<Config, "agentTiers" | "siteModels" | "providerDefaultMaxOutputTokens">,
): Promise<{ agent: AgentRow; change: Change }> {
  const account = await lockAccount(t, ownerId);
  if ((await countLiveAgents(t, ownerId)) >= agentLimit(config, account.tier)) throw new AppError(403, "agent_limit");
  await assertModelChoice(t, ownerId, input.model, input.reasoning, config);

  const named = await t.query<{ owner_handle: string; taken: boolean }>(
    `select o.handle::text as owner_handle,
            exists (select 1 from principals p join agents a on a.principal_id = p.id
                     where p.owner_id = o.id and p.kind = 'agent' and p.handle = $2 and a.deleted_at is null) as taken
       from principals o where o.id = $1`,
    [ownerId, input.namePart],
  );
  if (named.rows[0]!.taken) throw new AppError(409, "handle_taken");
  const { rows } = await t.query<{ id: string }>(
    "insert into principals (kind, handle, display_name, owner_id) values ('agent', $1, $2, $3) returning id",
    [input.namePart, input.name, ownerId],
  );
  const id = rows[0]!.id;
  const personaVersion = input.persona === "" ? 0 : 1;
  const created = await t.query<{ created_at: Date }>(
    `insert into agents (principal_id, intro, field, persona, persona_version, reply_mode, group_mentions, reasoning,
                         model_source, site_model_id, provider_id, provider_model, chain_budget_micro, others_budget_micro, owner_appellation,
                         proactive, proactive_level, proactive_budget_micro, memory, memory_ask, shared_notes, whisper_elsewhere)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22) returning created_at`,
    [
      id,
      input.intro,
      input.field,
      input.persona,
      personaVersion,
      input.replyMode,
      input.groupMentions,
      input.reasoning,
      ...modelParams(input.model),
      input.chainBudgetMicro.toString(),
      input.othersBudgetMicro === null ? null : input.othersBudgetMicro.toString(),
      input.ownerAppellation,
      input.proactive,
      input.proactiveLevel,
      input.proactiveBudgetMicro.toString(),
      input.memory,
      input.memoryAsk,
      input.sharedNotes,
      input.whisperElsewhere,
    ],
  );
  const conversation = await t.query<{ id: string }>("insert into conversations (type, creator_id) values ('agent', $1) returning id", [ownerId]);
  const conversationId = conversation.rows[0]!.id;
  await t.query("insert into agent_conversations (conversation_id, agent_id, owner_id) values ($1, $2, $3)", [conversationId, id, ownerId]);
  await t.query(
    `insert into memberships (conversation_id, principal_id, role, joined_seq)
     values ($1, $2, 'speaker', 0), ($1, $3, 'speaker', 0)`,
    [conversationId, ownerId, id],
  );
  // The one message an Agent gets without a reply run: it counts as unread for the owner like any other.
  const greeting =
    input.persona === ""
      ? [await insertMessage(t, conversationId, id, "text", { text: greetingText(input.name), fixed: true }, null)]
      : [];

  const agent: AgentRow = {
    id,
    ownerId,
    handle: `${named.rows[0]!.owner_handle}.${input.namePart}`,
    namePart: input.namePart,
    name: input.name,
    avatarVersion: 0,
    intro: input.intro,
    field: input.field,
    persona: input.persona,
    personaVersion,
    replyMode: input.replyMode,
    groupMentions: input.groupMentions,
    chainBudgetMicro: input.chainBudgetMicro,
    othersBudgetMicro: input.othersBudgetMicro,
    proactive: input.proactive,
    proactiveLevel: input.proactiveLevel,
    proactiveBudgetMicro: input.proactiveBudgetMicro,
    memory: input.memory,
    memoryAsk: input.memoryAsk,
    sharedNotes: input.sharedNotes,
    whisperElsewhere: input.whisperElsewhere,
    ownerAppellation: input.ownerAppellation,
    reasoning: input.reasoning,
    model: input.model,
    paused: false,
    deleted: false,
    conversationId,
    createdAt: created.rows[0]!.created_at,
  };
  return { agent, change: { messages: greeting, conversations: [{ conversationId, principalIds: [ownerId, id] }] } };
}

/** An Agent's reply as the worker hands it over, with what its tools looked up when they ran (messages/lookups.ts). */
export interface AgentReply extends LookupFields {
  text: string;
  reasoning: string;
  stopped: boolean;
  truncated: boolean;
  /**
   * A reply offered tools: the numbers its run gave (agents/tools/refs.ts). Its text, reasoning and search words lose every
   * token-shaped string as they are stored, those of its text of a number the run gave kept beside it as its citations
   * (`takeCites`). Absent: none was offered, and what it says is stored as written.
   */
  refs?: RunRefs | null;
}

/**
 * The one way an Agent's reply becomes a message (besides the fixed greeting at creation): under `lockAgent` on the
 * run's conversation — its row, then the `agents` row, which pause and delete lock too — so once a pause or delete has
 * committed, nothing more is posted: 409 `agent_paused` / `agent_deleted`, also for a run that pause or delete marked
 * `interrupted` after the Agent was resumed (and so for the other marks: `agent_removed`, `halted`). Nor is a run posted
 * that is no longer `running`, or is not a run of this Agent in this conversation (`RunNotRunning`: another instance's
 * recovery ended it, read under the same locks recovery takes). The message is the Agent's, kind `text`, with
 * `client_txn` = the run's id, so posting a run's reply again returns the stored message (`duplicate`) and stores
 * nothing; by it, too, its owner's copy of the message names the run's model, level and charge (`via`, messages/read.ts).
 *
 * First of all, a reply offered tools (`refs`, the numbers its run gave) loses every token-shaped string from all it says
 * — its text, its reasoning and its search words, once each follows the rules of message text (`cleanModelText`) —
 * before anything reads it (agents/tools/refs.ts `takeCites`), whatever the run handed out, so the text is the same
 * whatever it found: those of its text of a number the run gave become its citations, places in its text carried through
 * every step below (refs.ts `Placed`: a cut takes the ones past it, a block the ones in it), so that no proposal, block or
 * cut ever holds one. An acknowledgement cites nothing.
 *
 * In the Agent's own conversation: the text follows the rules of message text (`cleanModelText`: what a send would
 * refuse is removed); a persona proposal in it (`parseProposalBlock`: the reply's text only, never its reasoning) is
 * taken out — the fixed `PROPOSAL_PLACEHOLDER` stands in when nothing visible is left — and stored in this same
 * transaction (`storeProposal`, against the persona version read under this lock), the message's body naming it
 * (`proposalId`). The text is then cut at 8 000 characters, which marks it `truncated`. Without a proposal, a reply that
 * was stopped or cut (`truncated`) loses everything from its first `<af-` on (`withoutUnfinishedBlock`: it ended inside
 * a block it never finished); a complete reply with a malformed block keeps it as written. `reasoning` follows the rules
 * of message text, is cut at 32 000 characters (no mark) and is stored only when there is some. What its tools looked up
 * (messages/lookups.ts) is kept as checked there — the counts and the messages found wherever it posts, the search words
 * only in its own conversation —, each only when there is some.
 *
 * Anywhere else — a group (plan Task 5) — the Agent must be a current member of that conversation, read under its row's
 * lock, which every membership change takes: else 409 `agent_removed`. Its reply is never read for a proposal: whatever
 * follows its first `<af-` is dropped (`withoutUnfinishedBlock`, as for a stopped reply), so no block, whole or not,
 * reaches the group, and nothing of the Agent changes. Its reasoning is kept as in its own conversation (the product
 * owner's decision of 2026-11-18, replacing plan ruling 2): every member reads the message, but its reasoning is sent
 * only to the owner of the Agent that sent it (messages/read.ts `toWireForReaders`), since a model's thinking often
 * restates its persona. Then the text is cut at 8 000 characters as above. Only then do the text and the reasoning lose
 * the run's `mark` (runtime/prompt.ts `withoutMarkPlaced`, the citations' places moved with the text), so no more is
 * cleaned than a message stores — what the model writes may be shaped against the cleaner, and whoever runs the model's
 * endpoint reads the mark in the system text.
 * `mark` is the one the run drew, as the port kept it from `begin` (port-impl.ts `RunFlags.mark`): only a run begun in
 * this process is posted, so in a group it is always there, and a reply there without one is thrown, never posted
 * uncleaned. What was cut for length — the text when it is `truncated`, the reasoning when it was cut here or the reply
 * was — also loses what the cut left at its very end of the mark or of a label (`withoutMarkAtCut`); `truncated` says
 * what it always said. The text then loses again any block that taking the mark out put together; a reply that was
 * nothing but the mark and labels is left with no visible text (null, below). Who its mentions mean is read once from that
 * text and stored with it (mentions.ts `mentionsAtSend`, Task M); of its citations those a link is drawn at are kept with
 * it (`drawnCites`). The message may then call other Agents there — those
 * its stored mentions mean —
 * in this same transaction (runs.ts `triggerFromAgent`, which locks no further `agents` row, not even by a foreign key of
 * what it writes), as the call of the person
 * behind it (`behindAgentMessage`): this run's caller when the run is not its owner's own — a member's call relayed
 * through the Agent stays the member's — else the Agent's owner. `triggered` is what to announce and publish after
 * commit (nothing for a repeat, or in the Agent's own conversation).
 *
 * Null, storing nothing, when there is nothing to show: no visible text and, in its own conversation, no reasoning kept;
 * in a group no visible text (its members would be shown an empty message), whatever reasoning there is.
 *
 * `as` "ack": what the reply said before it called a tool, posted at once as its acknowledgement ("先应一声、再交付"),
 * under the same locks and checks and cleaned the same way, but never read for a proposal (whatever follows its first
 * `<af-` is dropped, as in a group), with `client_txn` `ack:<run id>` (messages/read.ts `acknowledgementTxn`: one per run,
 * posting it again returns it), a body `{text, reasoning?, ack: true}` and nothing of what tools looked up; it calls
 * nobody (its mentions are not read). The reply posted after it (`as` "reply", the default) quotes the question it
 * answers (`replyToSeq`: the seq the run covers) when anyone but the Agent wrote a text or file message in the
 * conversation after the acknowledgement that stands for it (`standingAcknowledgement`: its own, or the one an earlier
 * attempt at the same question left, a retry's); otherwise it is posted as ever. A reply `告诉他们` queued (a told reply,
 * `agent_runs.whisper_id`) always quotes the message that asked what its whisper found (the whisper's `askedSeq`), so it
 * makes sense however long after it comes — unless the Agent can no longer see that message (the rule a person's quote is
 * held to as it is sent, messages/send.ts): then without a quote.
 */
export async function postAsAgent(
  t: Tx,
  agentId: string,
  conversationId: string,
  runId: string,
  reply: AgentReply,
  mark: string | null,
  config: RunLimits & Pick<Config, "agentChainLimit">,
  as: "reply" | "ack" = "reply",
): Promise<{ message: StoredMessage; duplicate: boolean; triggered: Triggered } | null> {
  const agent = await lockAgent(t, agentId, conversationId);
  const own = conversationId === agent.conversationId;
  const ack = as === "ack";
  const txn = ack ? acknowledgementTxn(runId) : runId;
  const prior = await t.query<MessageRow>(
    `select ${MESSAGE_COLUMNS} from messages m where m.conversation_id = $1 and m.sender_id = $2 and m.client_txn = $3`,
    [conversationId, agentId, txn],
  );
  if (prior.rows[0]) return { message: toStored(prior.rows[0]), duplicate: true, triggered: noneTriggered() };
  // A run that has ended — another instance's recovery ended it while this one was still answering — is never posted;
  // nor is one its Agent's pause or delete interrupted, even once the Agent is resumed (runs.ts); nor a run of another
  // conversation's, here.
  const run = await t.query<{ status: string; interrupted: string | null; lane: Lane; caller_id: string | null; covers: string; told: boolean }>(
    "select status, interrupted, lane, caller_id, covers_seq::text as covers, whisper_id is not null as told from agent_runs where id = $1 and agent_id = $2 and conversation_id = $3",
    [runId, agentId, conversationId],
  );
  if (run.rows[0]?.status !== "running") throw new RunNotRunning(runId, run.rows[0]?.status ?? null);
  const interrupted = run.rows[0].interrupted;
  if (interrupted) throw new AppError(409, interrupted);
  if (agent.deleted) throw new AppError(409, "agent_deleted");
  if (agent.paused) throw new AppError(409, "agent_paused");
  if (!own && !(await currentMembership(t, conversationId, agentId))) throw new AppError(409, "agent_removed");
  if (!own && mark === null) throw new Error("a reply in a group is posted only with the mark its run drew");

  // A reply offered tools: every token-shaped string goes first, from all it says — its text, its reasoning, its search
  // words — before anything reads it (a proposal, the block rule, the cut, the mark): those of its text of a number the
  // run gave become its citations (an acknowledgement cites nothing), carried as places through every step after (refs.ts
  // `Placed`).
  const refs = reply.refs ?? null;
  const here = (r: MessageRef): boolean => own || r.conversationId === conversationId;
  let placed: Placed = refs ? takeCites(cleanModelText(reply.text), refs, { cite: !ack, keep: here }) : { text: cleanModelText(reply.text), cites: [] };
  let reasoning = refs ? takeCites(cleanModelText(reply.reasoning), refs, { cite: false }).text : cleanModelText(reply.reasoning);
  const searched = refs && Array.isArray(reply.queries) ? reply.queries.map((q) => (typeof q === "string" ? takeCites(q, refs, { cite: false }).text : q)) : reply.queries;
  // In a group nothing is a proposal, and no block of one is shown; nor in an acknowledgement.
  const proposal = own && !ack ? parseProposalBlock(placed.text) : null;
  if (!own || ack) placed = withoutUnfinishedBlockPlaced(placed);
  const proposalId = proposal ? randomUUID() : null;
  if (proposal) placed = hasVisibleText(proposal.visible) ? withoutProposalPlaced(placed, proposal.visible) : { text: PROPOSAL_PLACEHOLDER, cites: [] };
  let truncated = reply.truncated;
  const characters = Array.from(placed.text);
  if (characters.length > MESSAGE_TEXT_MAX) {
    placed = trimPlaced(cutPlaced(placed, characters.slice(0, MESSAGE_TEXT_MAX).join("").length));
    truncated = true;
  }
  if (!proposal && (reply.stopped || truncated)) placed = withoutUnfinishedBlockPlaced(placed);
  // Kept as in its own conversation; in a group only its owner is ever sent it (messages/read.ts).
  const thought = Array.from(reasoning);
  if (thought.length > REASONING_MAX) reasoning = thought.slice(0, REASONING_MAX).join("").trimEnd();
  // In a group the run's mark goes last, from no more than is kept — from the end of what was cut for length also what
  // the cut left of the mark or of a label — and, from a reply offered tools, every token shape in the same one pass, so
  // that neither taking out puts the other together (N-2, N-4); then a block that it put together.
  const thoughtCut = reply.truncated || thought.length > REASONING_MAX;
  if (mark !== null) {
    placed = trimPlaced(withoutMarkFrom(placed, mark, truncated, refs !== null));
    placed = withoutUnfinishedBlockPlaced(placed);
    reasoning = withoutMarkPlaced(reasoning, mark, [], thoughtCut, refs !== null).text.trim();
  }
  const text = placed.text;
  // In a group a reply with no visible text shows its members nothing, whatever it thought: nothing is posted.
  if (!hasVisibleText(text) && (!own || !hasVisibleText(reasoning))) return null;

  const body: MessageBody = { text };
  if (reasoning !== "") body.reasoning = reasoning;
  if (reply.stopped) body.stopped = true;
  if (truncated) body.truncated = true;
  if (proposalId !== null) body.proposalId = proposalId;
  if (ack) {
    body.ack = true;
    return { message: await insertMessage(t, conversationId, agentId, "text", body, txn), duplicate: false, triggered: noneTriggered() };
  }
  // Someone else wrote after the acknowledgement that stands for it (its own, or an earlier attempt's: a retry's): the
  // answer says which question it answers.
  const standing = await standingAcknowledgement(t, conversationId, agentId, runId);
  const overtaken =
    standing !== null &&
    (
      await t.query("select 1 from messages m where m.conversation_id = $1 and m.seq > $2 and m.sender_id <> $3 and m.kind in ('text', 'file') limit 1", [
        conversationId,
        standing,
        agentId,
      ])
    ).rowCount !== 0;
  if (overtaken) body.replyToSeq = Number(run.rows[0].covers);
  if (run.rows[0].told) {
    // A told reply: the question it tells about, quoted, when the Agent may still see it (VISIBLE_JOIN, as a person's quote).
    const whisper = await whisperOfRun(t, runId);
    const asked = whisper ? askedOf(whisper.body.detail) : null;
    const seen = asked !== null && (await t.query(`select 1 from messages m ${VISIBLE_JOIN} where m.conversation_id = $2 and m.seq = $3`, [agentId, conversationId, asked])).rowCount !== 0;
    if (seen) body.replyToSeq = asked;
    else delete body.replyToSeq;
  }
  // What its tools looked up: the counts, and the messages found (each reader is sent only those they can see,
  // messages/read.ts) — in a group only that group's own, the only ones a reply there may find; the search words only in
  // its own conversation, its owner's to read — in a group they are not kept.
  const lookups = lookupsOf(reply.lookups);
  if (lookups) body.lookups = lookups;
  const found = foundOf(reply.found).filter(here);
  if (found.length > 0) body.found = found;
  const queries = own ? queriesOf(searched) : [];
  if (queries.length > 0) body.queries = queries;
  // Who its mentions mean, read once, now, from the text it stores (Task M: a model's text is typed text), and stored with
  // it: what it calls below, and everything after, reads that.
  const read = await mentionsAtSend(t, { id: conversationId, type: own ? "agent" : "group" }, text);
  // What its text cites, beside it, as `found` is kept: in a group only that group's messages (each reader is sent only
  // those they can see, messages/read.ts) — where a link can be drawn, in its plain and its rendered text alike.
  const cites = drawnCites(text, placed.cites, read.mentions ?? []);
  if (cites.length > 0) body.cites = cites;
  const message = await insertMessage(t, conversationId, agentId, "text", body, runId, read);
  if (proposal && proposalId !== null) await storeProposal(t, agent, proposalId, message.id, proposal.proposal);
  // An Agent posts only in its own conversation and in groups it is a member of: elsewhere than its own is a group. Who
  // is behind its message there is decided by this run's caller and lane (read above; a running run's never change); the
  // runs it calls answer this run's askers (Task 10b: the person whose message started the chain) — with everyone who
  // wrote while it ran, before its message, whom they will hear from (fix round 2: recorded on this run, `hearFrom` —
  // only once its message reaches a run, fix round 3).
  const postedBy = { id: run.rows[0].caller_id, lane: run.rows[0].lane };
  const covered = Number(run.rows[0].covers);
  const triggered = own
    ? noneTriggered()
    : await triggerFromAgent(t, conversationId, message, agent, postedBy, config, () => hearFrom(t, runId, covered, message.seq));
  return { message, duplicate: false, triggered };
}

/** `p` as `withoutUnfinishedBlock` leaves its text: cut at its first `<af-` (the cites after it gone), its end trimmed. */
function withoutUnfinishedBlockPlaced(p: Placed): Placed {
  const at = p.text.indexOf("<af-");
  return at < 0 ? p : trimPlaced(cutPlaced(p, at));
}

/**
 * `p` without its proposal's block, as `parseProposalBlock` leaves it (`visible`): the block — from its first `<af-` to
 * the end of its last `</af-…>`, every one of them the block's own — taken out, with the cites in it, and trimmed.
 */
function withoutProposalPlaced(p: Placed, visible: string): Placed {
  const start = p.text.indexOf("<af-");
  const end = p.text.indexOf(">", p.text.lastIndexOf("</af-")) + 1;
  const done = trimPlaced(withoutSpanPlaced(p, start, end));
  return done.text === visible ? done : { text: visible, cites: [] };
}

/** A Markdown link's text, `[…]` before `(`, as `[from, to)` (the `]` at `to`). */
const LINK_TEXT = /\[[^[\]\n]*\]\(/g;

/**
 * Of `cites` (places in `text`, a reply's as stored), those a link is drawn at — in its plain text and its rendered
 * Markdown alike, as its mentions are (mentions.ts): none inside code (`codeRanges`), inside an address or at either end of
 * one (`addressRanges`: its mark would land in the link, or keep it from being one), or inside a link's text — and one
 * inside a mention (`mentions`, of the same text) at its end.
 */
function drawnCites(text: string, cites: readonly Cite[], mentions: ReadonlyArray<{ start: number; length: number }>): Cite[] {
  if (cites.length === 0) return [];
  const code = codeRanges(text);
  const addresses = addressRanges(text);
  const links = [...text.matchAll(LINK_TEXT)].map((m) => [m.index, m.index + m[0].length - 2] as const);
  return cites
    .filter(({ at }) => !code.some(([a, b]) => at > a && at < b) && !addresses.some(([a, b]) => at >= a && at <= b) && !links.some(([a, b]) => at > a && at <= b))
    .map((c) => {
      const inside = mentions.find((m) => c.at > m.start && c.at < m.start + m.length);
      return inside ? { ...c, at: inside.start + inside.length } : c;
    });
}

/**
 * The seq of the acknowledgement that stands for what run `runId` of Agent `agentId` answers in `conversationId`, or null:
 * its own (`ack:<run id>`); else one an earlier run of that Agent there posted for the same question and never answered
 * (no reply of that run's own) — the question an earlier run answered, its `covers_seq`, is this run's or one of the
 * calls this run answers (`call_seqs`: a retry in a group answers the failed run's) — so that a retry of a reply that
 * failed after acknowledging posts no second acknowledgement (Task 6 fix 1, m7). The latest when there are several.
 */
export async function standingAcknowledgement(q: Queryable, conversationId: string, agentId: string, runId: string): Promise<number | null> {
  // Bounded by the question, not by the Agent's run history: only the Agent's acknowledgements after the earliest seq this
  // run answers are read (an earlier attempt's came after the question it answered), each joined to the run it names.
  const { rows } = await q.query<{ seq: string }>(
    `select a.seq::text as seq
       from agent_runs me
       join messages a on a.conversation_id = me.conversation_id and a.sender_id = me.agent_id
                      and a.seq > least(me.covers_seq, coalesce((select min(s) from unnest(me.call_seqs) as c (s)), me.covers_seq))
                      and a.client_txn like 'ack:%'
       join agent_runs r on ${postingRun("a", "r")}
      where me.id = $3 and me.agent_id = $2 and me.conversation_id = $1
        and (r.id = me.id
             or ((r.covers_seq = me.covers_seq or r.covers_seq = any(coalesce(me.call_seqs, '{}')))
                 and not exists (select 1 from messages x where x.conversation_id = r.conversation_id and x.sender_id = r.agent_id and x.client_txn = r.id::text)))
      order by a.seq desc
      limit 1`,
    [conversationId, agentId, runId],
  );
  return rows[0] ? Number(rows[0].seq) : null;
}

/**
 * `POST /api/conversations/:id/topic` (spec 6.2 "新话题"): appends a `topic_reset` notice from the owner to their
 * Agent's conversation (answered with the notice and the Agent's id, for the route to tell the reviewer after commit), under `lockAgent` (the conversation row, then the `agents` row) like every write there. What the
 * model is shown starts after the latest one (`buildContext`); history and search keep everything. 404 unless it is
 * `ownerId`'s Agent conversation; 403 `cannot_send` (`agent_deleted`) once the Agent is deleted, as a send; allowed
 * while it is paused. It neither starts a reply nor ends one under way (which was given the old topic). The Agent's rolling
 * summary of the conversation (agents/summary/) is deleted with it: it was of the old topic.
 */
export async function resetTopic(t: Tx, ownerId: string, conversationId: string): Promise<{ notice: StoredMessage; agentId: string }> {
  const agentId = await ownedAgentOf(t, ownerId, conversationId);
  if (!agentId) throw notFound();
  const agent = await lockAgent(t, agentId, conversationId);
  if (agent.deleted) throw new AppError(403, "cannot_send", { reason: "agent_deleted" });
  const notice = await appendSystem(t, conversationId, { event: "topic_reset", actorId: ownerId });
  await forgetSummaries(t, conversationId, [agentId]);
  return { notice, agentId };
}
