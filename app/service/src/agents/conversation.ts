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
import { placeOf } from "../social/place.ts";
import { reach } from "../social/reach.ts";
import { shownNotesPass } from "../memory/shown.ts";
import type { ShownNote } from "../memory/passage.ts";
import { cleanModelText, hasVisibleText } from "../schemas.ts";
import { addressRanges, codeRanges, mentionsAtSend } from "./mentions.ts";
import { parseProposalBlock, storeProposal } from "./persona.ts";
import { maxCallsOf, storedToolCalls } from "./replay.ts";
import { RunNotRunning, type ToolTrace } from "./runtime/port.ts";
import { withoutMarkPlaced } from "./runtime/prompt.ts";
import {
  askersHandedDown,
  callerOf,
  noneTriggered,
  overLaneLimit,
  ownedAgentOf,
  queueRun,
  standingCalls,
  triggerFromAgent,
  type Announced,
  type Lane,
  type RunLimits,
  type Triggered,
} from "./runs.ts";
import { refusedInGroup } from "./refusal.ts";
import { forgetSummaries } from "./summary/store.ts";
import { askedOf } from "./tools/elsewhere.ts";
import { cutPlaced, takeCites, trimPlaced, withoutMarkFrom, withoutSpanPlaced, type Placed, type RunRefs } from "./tools/refs.ts";
import { webFields } from "./tools/web/tool.ts";
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

/** What `postAsAgent` returns for a reply it posted (or found already posted): the message, whether it was a repeat, and what the message called for. */
export type PostedReply = { message: StoredMessage; duplicate: boolean; triggered: Triggered };

/** The most of a reply's reasoning that is stored; the rest is cut (it is never shown to a model again). */
export const REASONING_MAX = 32_000;

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
  proactive: boolean;
  proactiveLevel: ProactiveLevel;
  memory: boolean;
  memoryAsk: boolean;
  sharedNotes: boolean;
  whisperElsewhere: boolean;
  /** 联网搜索 (lane websearch); absent: on, the column's default. */
  webSearch?: boolean;
  ownerAppellation: string | null;
  reasoning: ReasoningLevel;
  /** The levels of its replies for others and of its proactive replies (migration 076); absent: `none`. */
  othersReasoning?: ReasoningLevel;
  proactiveReasoning?: ReasoningLevel;
  model: AgentModel;
}

/**
 * Creates an Agent in one transaction: its principal (kind `agent`, owned by `ownerId`), the `agents` row, the
 * dedicated conversation (type `agent`, `agent_conversations`, owner and Agent as speakers from seq 0) and, when
 * there is no persona yet and it has a model (`greet`: the service's default; the test harness turns it off), its first
 * reply, queued: an ordinary reply of its owner's own lane (charged and admitted like any) that its run is told to make
 * a greeting of (`agent_runs.greets`, port-impl.ts `begin`) — never a fixed sentence posted as the Agent (principle P2).
 * Over the owner's own replies a minute it is not queued; nor is anything posted in its place: the empty conversation
 * shows its owner a hint of the client's. The owner's account lock (taken first: it also
 * serialises the count) decides the limit: 403 `agent_limit` at the tier's number of Agents that are not deleted
 * (a tier `config` no longer names gets the `free` number). 409 `handle_taken` when one of the owner's Agents that is
 * not deleted has the name part — decided under that same lock, the only place an Agent is made, so two creations take
 * turns (migration 048: no index sees `agents.deleted_at`); 400 for a model or reasoning level that does not fit.
 */
export async function createAgent(
  t: Tx,
  ownerId: string,
  input: NewAgent,
  config: Pick<Config, "agentTiers" | "siteModels" | "providerDefaultMaxOutputTokens"> & RunLimits,
  greet = true,
): Promise<{ agent: AgentRow; change: Change; greeting: Announced | null }> {
  const account = await lockAccount(t, ownerId);
  if ((await countLiveAgents(t, ownerId)) >= agentLimit(config, account.tier)) throw new AppError(403, "agent_limit");
  await assertModelChoice(t, ownerId, input.model, [{ level: input.reasoning }, { level: input.othersReasoning ?? "none" }, { level: input.proactiveReasoning ?? "none" }], config);

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
                         model_source, site_model_id, provider_id, provider_model, chain_budget_micro, owner_appellation,
                         proactive, proactive_level, memory, memory_ask, shared_notes, whisper_elsewhere, web_search,
                         others_reasoning, proactive_reasoning)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23) returning created_at`,
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
      input.ownerAppellation,
      input.proactive,
      input.proactiveLevel,
      input.memory,
      input.memoryAsk,
      input.sharedNotes,
      input.whisperElsewhere,
      input.webSearch ?? true,
      input.othersReasoning ?? "none",
      input.proactiveReasoning ?? "none",
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
  // Its first reply, which greets its owner (no persona yet: it then asks who it is to be), is its model's own: queued.
  const greeting =
    greet && input.persona === "" && input.model !== null && !(await overLaneLimit(t, ownerId, "own", config))
      ? await queueRun(t, { id, ownerId }, conversationId, 0, "human", callerOf(ownerId, ownerId), [ownerId], [])
      : null;
  if (greeting) await t.query("update agent_runs set greets = true, call_seqs = '{}' where id = $1", [greeting.run.id]);

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
    proactive: input.proactive,
    proactiveLevel: input.proactiveLevel,
    memory: input.memory,
    memoryAsk: input.memoryAsk,
    sharedNotes: input.sharedNotes,
    whisperElsewhere: input.whisperElsewhere,
    webSearch: input.webSearch ?? true,
    ownerAppellation: input.ownerAppellation,
    reasoning: input.reasoning,
    othersReasoning: input.othersReasoning ?? "none",
    proactiveReasoning: input.proactiveReasoning ?? "none",
    model: input.model,
    paused: false,
    deleted: false,
    operatorDisabled: false,
    conversationId,
    createdAt: created.rows[0]!.created_at,
  };
  return { agent, change: { messages: [], conversations: [{ conversationId, principalIds: [ownerId, id] }] }, greeting };
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
  /**
   * The calls of the rounds its answer was written with (runtime/port.ts `Reply.toolCalls`): kept beside it as
   * `toolCalls`, as agents/replay.ts `storedToolCalls` keeps them, in the Agent's own conversation only.
   */
  toolCalls?: readonly ToolTrace[];
}

/**
 * The one way an Agent's reply becomes a message: under `lockAgent` on the
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
 * cut ever holds one. An acknowledgement cites nothing. One exception, read from the text alone: a reply (not an
 * acknowledgement, no proposal) that would be left with no visible text once its token-shaped strings are out — it wrote
 * nothing else: a number someone typed, copied as they asked — keeps what it wrote, through the same steps but with its
 * tokens, as plain text citing nothing; else it would not be posted at all.
 *
 * In the Agent's own conversation: the text follows the rules of message text (`cleanModelText`: what a send would
 * refuse is removed); a persona proposal in it (`parseProposalBlock`: the reply's text only, never its reasoning) is
 * taken out — when nothing visible is left the message keeps no text at all (principle P2: no fixed sentence is put in
 * the Agent's mouth; its owner is shown the proposal's card alone) — and stored in this same
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
 * Null, storing nothing, when there is nothing to show: no visible text and, in its own conversation, no reasoning kept
 * and no proposal;
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
  config: RunLimits & Pick<Config, "agentChainLimit" | "tools">,
  as: "reply" | "ack" = "reply",
): Promise<PostedReply | null | { refused: "access_ended" | "notes_changed" }> {
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
  const run = await t.query<{ status: string; interrupted: string | null; lane: Lane; caller_id: string | null; covers: string; told: boolean; shown_notes: ShownNote[] | null }>(
    "select status, interrupted, lane, caller_id, covers_seq::text as covers, whisper_id is not null as told, shown_notes from agent_runs where id = $1 and agent_id = $2 and conversation_id = $3",
    [runId, agentId, conversationId],
  );
  if (run.rows[0]?.status !== "running") throw new RunNotRunning(runId, run.rows[0]?.status ?? null);
  const interrupted = run.rows[0].interrupted;
  if (interrupted) throw new AppError(409, interrupted);
  if (agent.deleted) throw new AppError(409, "agent_deleted");
  if (agent.paused) throw new AppError(409, "agent_paused");
  if (!own && !(await currentMembership(t, conversationId, agentId))) throw new AppError(409, "agent_removed");
  if (!own && mark === null) throw new Error("a reply in a group is posted only with the mark its run drew");
  // A social conversation: no acknowledgement (nothing the Agent says before a tool is posted there), and the reply is posted on the
  // access and the notes as they are NOW — the visitor may be refused (`reach`, with the switch), or a note it was shown no longer be
  // told them (`shownNotesPass`). Either marks the run interrupted in THIS transaction (the run row after the note rows, the lock order)
  // and is returned, not thrown: the mark commits, the run ends `cancelled` with that value, nothing is posted, and the visitor is told
  // nothing of why. A group's rule below (`standingCalls`) is not asked of it: a social run has one caller.
  const social = !own && (await placeOf(t, conversationId, agent)) === "social";
  if (social) {
    if (ack) return null;
    const refusal = await socialRefusal(t, agent, runId, run.rows[0].caller_id, run.rows[0].shown_notes ?? [], config);
    if (refusal !== null) return { refused: refusal };
  }
  // A person refused after `begin` dropped what it dropped (a block, a stop, a removal arriving while the reply was written): the
  // calls the run answers are asked again. None left: nothing is posted (409 `access_ended` is only the signal; the run ends cancelled, no error, settled once
  // through `finish`). Otherwise what goes on for the others quotes and mentions nobody refused (below). A told reply answers no call.
  const calls = !own && !social && !run.rows[0].told ? await standingCalls(t, runId) : null;
  if (calls?.none) throw new AppError(409, "access_ended");
  const refusedNow = calls?.refused ?? new Set<string>();

  // A reply offered tools: every token-shaped string goes first, from all it says — its text, its reasoning, its search
  // words — before anything reads it (a proposal, the block rule, the cut, the mark): those of its text of a number the
  // run gave become its citations (an acknowledgement cites nothing), carried as places through every step after (refs.ts
  // `Placed`).
  const refs = reply.refs ?? null;
  const here = (r: MessageRef): boolean => own || r.conversationId === conversationId;
  const said: Placed = refs ? takeCites(cleanModelText(reply.text), refs, { cite: !ack, keep: here }) : { text: cleanModelText(reply.text), cites: [] };
  let reasoning = refs ? takeCites(cleanModelText(reply.reasoning), refs, { cite: false }).text : cleanModelText(reply.reasoning);
  const searched = refs && Array.isArray(reply.queries) ? reply.queries.map((q) => (typeof q === "string" ? takeCites(q, refs, { cite: false }).text : q)) : reply.queries;
  // In a group nothing is a proposal, and no block of one is shown; nor in an acknowledgement.
  const proposal = own && !ack ? parseProposalBlock(said.text) : null;
  const proposalId = proposal ? randomUUID() : null;
  /**
   * What is kept of the text `p`, step by step: in a group and in an acknowledgement no block; its proposal's block taken
   * out; cut at `MESSAGE_TEXT_MAX` (which makes it `truncated`); a stopped or cut reply without its unfinished block; then,
   * in a group, the run's mark last, from no more than is kept — from the end of what was cut for length also what the
   * cut left of the mark or of a label — and, with `tokens` (a reply offered tools), every token shape in the same one
   * pass, so that neither taking out puts the other together (N-2, N-4); then a block that it put together.
   */
  const kept = (p: Placed, tokens: boolean): { placed: Placed; truncated: boolean } => {
    let out = !own || ack ? withoutUnfinishedBlockPlaced(p) : p;
    if (proposal) out = hasVisibleText(proposal.visible) ? withoutProposalPlaced(out, proposal.visible) : { text: "", cites: [] };
    let cut = reply.truncated;
    const characters = Array.from(out.text);
    if (characters.length > MESSAGE_TEXT_MAX) {
      out = trimPlaced(cutPlaced(out, characters.slice(0, MESSAGE_TEXT_MAX).join("").length));
      cut = true;
    }
    if (!proposal && (reply.stopped || cut)) out = withoutUnfinishedBlockPlaced(out);
    if (mark !== null) out = withoutUnfinishedBlockPlaced(trimPlaced(withoutMarkFrom(out, mark, cut, tokens, refs?.webOffered === true)));
    return { placed: out, truncated: cut };
  };
  let { placed, truncated } = kept(said, refs !== null);
  // A reply offered tools that wrote nothing but token-shaped strings — a number someone typed, copied as they asked; its
  // numbers alone — would be left with nothing to show, and nothing would be posted (lane prompt2: the third ask with no
  // reply). It keeps what it wrote instead, as plain text citing nothing. Whether it does is read from its text alone,
  // never from what the run handed out, so the text is still the same whatever it found.
  if (refs !== null && !ack && proposalId === null && !hasVisibleText(placed.text)) {
    const asWritten = kept(trimPlaced({ text: cleanModelText(reply.text), cites: [] }), false);
    if (hasVisibleText(asWritten.placed.text)) ({ placed, truncated } = asWritten);
  }
  // Kept as in its own conversation; in a group only its owner is ever sent it (messages/read.ts).
  const thought = Array.from(reasoning);
  if (thought.length > REASONING_MAX) reasoning = thought.slice(0, REASONING_MAX).join("").trimEnd();
  // In a group the run's mark goes from it too, as from the text (`kept`).
  const thoughtCut = reply.truncated || thought.length > REASONING_MAX;
  if (mark !== null) reasoning = withoutMarkPlaced(reasoning, mark, [], thoughtCut, refs !== null, refs?.webOffered === true).text.trim();
  const text = placed.text;
  // In a group a reply with no visible text shows its members nothing, whatever it thought: nothing is posted. In its own
  // conversation a proposal is something to show (its card), with no text.
  if (!hasVisibleText(text) && proposalId === null && (!own || !hasVisibleText(reasoning))) return null;

  const body: MessageBody = { text };
  if (reasoning !== "") body.reasoning = reasoning;
  if (reply.stopped) body.stopped = true;
  if (truncated) body.truncated = true;
  if (proposalId !== null) body.proposalId = proposalId;
  if (ack) {
    body.ack = true;
    // The reply has produced something (what recovery reads after a restart: runtime/port.ts `passingEnding`).
    await t.query("update agent_runs set progressed = true where id = $1", [runId]);
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
  // ... but never quoting a message of someone refused now.
  // ... nor a call of its refused now, whoever wrote it (a relay whose Agent's owner has a block since: T2 fix 1, F13).
  if (body.replyToSeq !== undefined && calls?.refusedSeqs.has(body.replyToSeq)) delete body.replyToSeq;
  if (body.replyToSeq !== undefined && refusedNow.size > 0) {
    const quoted = await t.query<{ sender_id: string }>("select sender_id from messages where conversation_id = $1 and seq = $2", [conversationId, body.replyToSeq]);
    if (quoted.rows[0] && refusedNow.has(quoted.rows[0].sender_id)) delete body.replyToSeq;
  }
  if (run.rows[0].told) {
    // A told reply: the question it tells about, quoted, when the Agent may still see it (VISIBLE_JOIN, as a person's quote).
    const whisper = await whisperOfRun(t, runId);
    const asked = whisper ? askedOf(whisper.body.detail) : null;
    const seen = asked !== null && (await t.query(`select 1 from messages m ${VISIBLE_JOIN} where m.conversation_id = $2 and m.seq = $3`, [agentId, conversationId, asked])).rowCount !== 0;
    // ... and not a message of someone refused now (the owner's press is no reason to answer them in the group).
    const askedRefused = seen && !own && (await t.query(`select 1 from messages m where m.conversation_id = $2 and m.seq = $3 and ${refusedInGroup("m.sender_id", "$1::uuid")}`, [agentId, conversationId, asked])).rowCount !== 0;
    if (seen && !askedRefused) body.replyToSeq = asked;
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
  // The calls of the rounds its answer was written with (harness design §3): in its own conversation only, where a later
  // reply offered those tools is shown them (agents/replay.ts), never in a group nor on an acknowledgement (which returned
  // above), and none when there were more than the tools' per-reply caps allow. A web call keeps, besides, an excerpt of
  // its first pages (title and snippet, cut: web text). Read by that context alone (`CONTEXT_ONLY_KEYS`): never
  // sent, searched, summarised or logged.
  const toolCalls = own && !ack && reply.toolCalls ? storedToolCalls(reply.toolCalls, refs, maxCallsOf(config.tools)) : null;
  if (toolCalls !== null) body.toolCalls = toolCalls;
  // Who its mentions mean, read once, now, from the text it stores (Task M: a model's text is typed text), and stored with
  // it: what it calls below, and everything after, reads that.
  // (A social reply reads none: nobody is called there but by their own message.)
  const mentioned = social ? { mentions: null, asksAgent: false } : await mentionsAtSend(t, { id: conversationId, type: own ? "agent" : "group" }, text);
  // Nobody refused now is mentioned (their `mentions` are not stored: they would be notified of a reply that is not for them).
  const unrefused = refusedNow.size === 0 ? null : (mentioned.mentions ?? []).filter((m) => !refusedNow.has(m.id));
  const read = unrefused === null ? mentioned : { ...mentioned, mentions: unrefused.length === 0 ? null : unrefused };
  // What its text cites, beside it, as `found` is kept: in a group only that group's messages (each reader is sent only
  // those they can see, messages/read.ts) — where a link can be drawn, in its plain and its rendered text alike.
  const drawn = drawnCites(text, placed.cites, read.mentions ?? []);
  const cites = drawn.filter((c): c is Cite => c.kind !== "w");
  if (cites.length > 0) body.cites = cites;
  // A reply whose run was handed web pages (tools/web): every one of them, cited or not, and where its text cites them.
  Object.assign(body, webFields(refs, drawn));
  const message = await insertMessage(t, conversationId, agentId, "text", body, runId, read);
  if (proposal && proposalId !== null) await storeProposal(t, agent, proposalId, message.id, proposal.proposal);
  // An Agent posts only in its own conversation and in groups it is a member of: elsewhere than its own is a group. Who
  // is behind its message there is decided by this run's caller and lane (read above; a run's never change); the calls it
  // makes carry this run's askers (Task 10b: the person whose message started the chain) and everyone who wrote while it ran,
  // before its message, whom the replies it calls will hear from (runs.ts `askersHandedDown`: read only, nothing written to
  // this run, and recorded only where a target accepts the call — limits redesign C-c; read only once its message may reach a
  // target, fix round 3).
  const postedBy = { id: run.rows[0].caller_id, lane: run.rows[0].lane };
  const covered = Number(run.rows[0].covers);
  const triggered = own || social
    ? noneTriggered()
    : await triggerFromAgent(t, conversationId, message, agent, postedBy, config, () => askersHandedDown(t, runId, covered, message.seq));
  return { message, duplicate: false, triggered };
}

/**
 * A social reply's last look before it is posted, under the conversation's and the Agent's row: the run's one caller must still reach
 * the Agent (`reach`, social) and every note it was shown (`shown`, the run's `shown_notes`) must still be one they may be told
 * (`shownNotesPass`). Otherwise the run is marked `interrupted` with that reason, in the caller's transaction, and the reason is
 * returned (what waits behind it is held to the visitor's access again when its end takes it: runs.ts `takeDeferred`). A caller who
 * is missing or is the Agent's owner is refused outright (`runAccess`'s rule).
 */
async function socialRefusal(
  t: Tx,
  agent: AgentRow,
  runId: string,
  callerId: string | null,
  shown: readonly ShownNote[],
  config: Pick<Config, "social">,
): Promise<"access_ended" | "notes_changed" | null> {
  let reason: "access_ended" | "notes_changed" | null = null;
  if (callerId === null || callerId === agent.ownerId || (await reach(t, callerId, agent.id, "social", config)) !== "ok") reason = "access_ended";
  else if (!(await shownNotesPass(t, agent, callerId, shown))) reason = "notes_changed";
  if (reason !== null) await t.query("update agent_runs set interrupted = $2 where id = $1", [runId, reason]);

  return reason;
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
function drawnCites<C extends { at: number }>(text: string, cites: readonly C[], mentions: ReadonlyArray<{ start: number; length: number }>): C[] {
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
 * An automatic retry (runs.ts `scheduleAutoRetry`) never needs more: it follows only a failure before the reply did
 * anything (runtime/port.ts `passingEnding`), and an acknowledgement posted is such a thing (its post sets `progressed` in
 * the same transaction), so no attempt of an automatic chain has one to stand for the next.
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
