import type { FastifyBaseLogger } from "fastify";
import { MICRO_PER_POINT, siteDay } from "../accounts/store.ts";
import type { BlobStore } from "../attachments/blob.ts";
import type { Config } from "../config.ts";
import type { ConversationEvents } from "../conversations/events.ts";
import { currentMembership } from "../conversations/store.ts";
import type { Db, Tx } from "../db.ts";
import { AppError } from "../errors.ts";
import { admitRun, classSql, HeldBack, olderMarkSql, raiseHold, type ChargeTo } from "../metering/admit.ts";
import { placeOf, type Place } from "../social/place.ts";
import { reach } from "../social/reach.ts";
import { agentRoom, boundedForOthers, keepsRoom, othersFits, othersHold, OthersLimit, othersRoomAdvisory, othersWanted, type OthersLane } from "../metering/others.ts";
import { assertCount, costMicro, isCount, maxCostMicro, type Price } from "../metering/prices.ts";
import { deliverReminder, remindInSettlement } from "../metering/reminders.ts";
import { settle } from "../metering/settle.ts";
import { classOf } from "../metering/wallet.ts";
import { correctedEstimate, cutToWeight, estimateTokens, holdTokens, planRatio, ratioKey, readRatio, TOOL_PREAMBLE_TOKENS, TOOL_TEXT_FACTOR, weight, weightWithin } from "../metering/tokens.ts";
import { loadNotes, type ShownNote } from "../memory/passage.ts";
import { markRead, type ReadEvents } from "../messages/read.ts";
import type { ToolCall, ToolSpec } from "../models/gateway.ts";
import { resolveModel, type Resolved } from "../models/resolve.ts";
import { toldHits, toldPassage } from "./tools/elsewhere.ts";
import { RunRefs } from "./tools/refs.ts";
import type { RunScope } from "./tools/index.ts";
import { KeyUnreadableError } from "../providers/crypto.ts";
import { markToolsOff, markToolsOn } from "../providers/store.ts";
import type { Hub } from "../sync/hub.ts";
import { createWhisper, type WhisperBody } from "../whispers/store.ts";
import {
  askerLine,
  BlobStoreDown,
  buildContext,
  callsSeen,
  readPairSummary,
  GROUP_CONTEXT_MESSAGES,
  hasOwnerTurn,
  loadContext,
  loadGroupScene,
  loadSocialScene,
  withRoster,
  type BuiltContext,
  type LeftOut,
  type LoadedContext,
  type Speaker,
} from "./context.ts";
import { maxCallsOf } from "./replay.ts";
import { contextBudget, holdsNewest, partText } from "./runtime/context.ts";
import { FINAL_LINE, longestToolName, noteBytes, RESULT_FRAMING_BYTES } from "./runtime/loop.ts";
import { postAsAgent, standingAcknowledgement, type AgentReply } from "./conversation.ts";
import { namePartCalls } from "./mentions.ts";
import type { Reviewer } from "../memory/reviewer.ts";
import type { ProactiveScheduler } from "./proactive/scheduler.ts";
import {
  BUSY,
  failedEnd,
  NOTHING,
  RunNotRunning,
  UNAVAILABLE,
  type Activity,
  type AgentPort,
  type Delta,
  type Estimated,
  type Prepared,
  type Reply,
  type RunEnd,
  type RunTicket,
  type ToolOutcome,
  type Usage,
} from "./runtime/port.ts";
import { detectLanguage, type ReplyLanguage } from "./runtime/language.ts";
import { fitNotes, GREETING_LINE, GREETING_TURN, groupSystemText, NO_NOTES, passageBudget, socialSystemText, systemText, systemTokens, type PromptNotes, type SystemText, type ToolsPrompt, type WebPrompt } from "./runtime/prompt.ts";
import { holdSearch as preHoldSearch, SearchRefused, type HeldSearch, type RefusedBy } from "./tools/web/hold.ts";
import { fuseLine, WEB_NO_MONEY, WEB_UNAVAILABLE } from "./tools/web/tool.ts";
import {
  actOnTriggered,
  budgetReachedWith,
  droppedOnEnd,
  dropRefusedCalls,
  followUp,
  followUpOf,
  followUpOnEnd,
  hearFrom,
  limitNotice,
  noneTold,
  ownerWroteACall,
  pushBudgetReached,
  refusedAtAdmission,
  AUTO_RETRY_WINDOW_MS,
  RUN_COLUMNS,
  scheduleAutoRetry,
  settleLane,
  siteToday,
  transientFailure,
  type AutoRetry,
  withTellable,
  toWireRun,
  type Announced,
  type FollowUp,
  type Interruption,
  type Lane,
  type RunRow,
  type Told,
} from "./runs.ts";
import { lockAgent, type AgentRow } from "./store.ts";

export interface AgentPortDeps {
  db: Db;
  config: Config;
  /** Where attachments are read from for what the model is shown (`buildContext`). */
  blobs: BlobStore;
  realtime: Pick<Hub, "pushRun" | "pushRunToOwner" | "pushDelta" | "pushActivity" | "pushAgentChanged" | "pushChargedReply" | "pushWhisper">;
  conversations: ConversationEvents;
  reads: ReadEvents;
  log: Pick<FastifyBaseLogger, "error" | "warn" | "info">;
  /** How a candidate for a group run's mark is drawn (`loadContext`, `newMark`); default prompt.ts `drawMark`. Tests fix it. */
  drawMark?: () => string;
  /** The proactive scheduler (proactive/scheduler.ts), when there is one: an Agent's post drops the judgement waiting there. */
  proactive?: Pick<ProactiveScheduler, "cancelled"> | null;
  /**
   * The reviewer (memory/reviewer.ts), when there is one: told after a reply was posted, so it can look at the conversation once
   * it is quiet, and — when the reply's context left out anything — asked for the pair's rolling summary to take it in
   * (`summarise`; the job weighs what waits before it makes a call).
   */
  memory?: Pick<Reviewer, "noted" | "summarise"> | null;
  /** The tools a reply may be offered and how they run; none (the default): no reply is offered any. */
  toolbox?: Toolbox | null;
  /**
   * The clock automatic retries are scheduled and claimed by (`not_before`: runs.ts `scheduleAutoRetry`, `claimNext`);
   * default the wall clock. Tests fake it.
   */
  now?: () => Date;
}

/**
 * Where a reply's tools come from (`AgentPortDeps.toolbox`): what a run is offered, with at most how many calls of each
 * tool one reply may run (`ToolRun.perTool`) and what each tool's work is (`ToolRun.kinds`: the status while it runs,
 * what it is counted under), and how a call runs (`AgentPort.tool`: never rejecting for a call it cannot answer, its
 * signal honoured; what it found and searched for in its outcome, `ToolOutcome`) — for the run's scope as `begin` set it
 * (`RunScope`: whether it is in a group, the numbers it gave the model, how far its conversation had come, its mark).
 * Nothing is offered while `TOOLS.enabled` is false. `offer` is asked once per run, in `begin`'s first step (inside its
 * transaction, under the run's locks), before the context is planned; `where.group`: the run is not in its Agent's own
 * conversation. The service's toolbox is agents/tools/index.ts `createToolbox`.
 */
export interface Toolbox {
  /**
   * `where.web`: the run may have the web search (its Agent's `webSearch` is on: in every lane — its owner's own
   * conversation and call, someone else's call, a reply nobody asked for, an Agent's relay — and on every model, the
   * product owner's rules, lane websearch2); the toolbox adds it only when the site offers it. `web` in the answer: what
   * the system text says of it (prompt.ts `WebPrompt`); absent when the site offers none.
   */
  offer(
    run: RunTicket,
    where: { place: Place; web?: boolean },
  ): { tools: ToolSpec[]; perTool: Record<string, number>; kinds: Record<string, Activity>; web?: WebPrompt };
  run(scope: RunScope, call: ToolCall, signal: AbortSignal): Promise<ToolOutcome>;
}

/** What a toolbox offers a run. */
type Offer = ReturnType<Toolbox["offer"]>;

/**
 * Tokens a reply offered tools keeps in its context plan for what they bring back (`begin`): two results of
 * `resultMaxWeight` at the plan's `ratio`, as tools' text is planned (`TOOL_TEXT_FACTOR`), but at most a third of
 * `conversation`, what the plan gives the conversation beside the system text and the tools' definitions. Planned only:
 * nothing is held or charged for it.
 */
const resultReserve = (resultMaxWeight: number, ratio: number, conversation: number): number =>
  Math.min(Math.ceil(2 * resultMaxWeight * ratio * TOOL_TEXT_FACTOR), Math.floor(conversation / 3));

/**
 * What a provider model's owner is told, once, when a reply finds it cannot use tools (`toolsUnusable`): a whisper in
 * that reply's conversation, offering no button (nothing to answer).
 */
export const TOOLS_OFF: WhisperBody = { text: "这个模型不支持查东西，已改为普通聊天。可以在模型设置里重新打开再试。", actions: [] };

/**
 * The model a run's call went to, kept from `begin` in this process (`RunFlags.model`): what `toolsUnusable` and
 * `toolsWorked` mark. `toolsUnknown`: its entry said nothing of tools when the reply began (`Resolved.toolsUnknown`).
 */
type RunModel = { source: "site"; id: string } | { source: "provider"; providerId: string; name: string; toolsUnknown: boolean };

/** What `extend` prices a reply's later calls by, kept from `begin` in this process (`RunFlags.money`). */
interface RunMoney {
  /** The site model's price; null for a provider's model, which costs nothing. */
  price: Price | null;
  /** The call's output limit, which every call of the reply is held for whole. */
  maxOutputTokens: number;
  /**
   * The room the reply holds on the free allowance for a last call after its next round (admission's `reserveMicro`, then
   * renewed by each "ok" of `extend`; 0 on the balance): every round before the last keeps it, so the last call is made
   * within the hold (README "Metering", The free allowance's room).
   */
  reserveMicro: bigint;
  /** The most input one call of the reply can carry, in tokens: its model's context less its output limit, what providers add around tool definitions, its images and PDFs. */
  roomCapTokens: number;
  /** The most one more tool round can add to the next call's input, in tokens (`roomGrowth`). */
  growthTokens: number;
}

/**
 * The most one more tool round can add to the next call's input, in the unit holds are counted in (a token a byte):
 * `k` results — the calls one reply may run in all, each result at most 3 × `resultMaxWeight` bytes (weight is
 * ⌈bytes / 3⌉, and results are cut by weight) and 200 of framing (its id, its name, its JSON) — and the round's own turn
 * with the notes answering calls not run, allowed 6 bytes an output token of `maxOutputTokens`, and 300 — a bound in real
 * tokens that a round can pass in bytes (README "Metering", the free allowance's room). What the room for the last call is
 * renewed by (`begin`, `extend`).
 */
const roomGrowth = (k: number, resultMaxWeight: number, maxOutputTokens: number): number => k * (3 * resultMaxWeight + RESULT_FRAMING_BYTES) + 6 * maxOutputTokens + 300;

/** Everything the reply was to answer is before a new topic its owner started: nothing failed, nothing to retry. */
const STARTED_OVER: RunEnd = { status: "cancelled" };
/**
 * In a group, none of the messages that called for the reply is one its Agent can see and show (context.ts `callsSeen`):
 * nothing is left to answer — nothing failed, nothing to retry.
 */
const NOTHING_LEFT: RunEnd = { status: "cancelled" };
/**
 * Every call the reply answers (a told reply answers none: never so) was made by someone who has had a block with the Agent's owner, either way, since: each
 * would be refused now (runs.ts `dropRefusedCalls`), so with none left the reply ends before any call — nothing held or
 * charged, no message, nothing to retry.
 */
const BLOCKED_SINCE: RunEnd = { status: "cancelled" };
/**
 * A social run whose access is not there at its start (`runAccess`: the caller is refused now, or is not the one person a social run
 * answers): ended before any call, nothing held or charged, `access_ended` as an ended access is for a social run (a group run left
 * with no call ends quietly with no error: `BLOCKED_SINCE`). The visitor is never told why: the run's state is all they see.
 */
const ACCESS_ENDED: RunEnd = { status: "cancelled", error: "access_ended" };
/** The model's context cannot hold the owner's newest message (`holdsNewest`): no call is made. */
const TOO_SMALL: RunEnd = { status: "failed", error: "context_too_small" };
/** The provider's saved key cannot be opened (`KeyUnreadableError`): as a refused key, its owner must save it again. */
const KEY_UNREADABLE: RunEnd = { status: "failed", error: "provider_rejected" };
/** The Agent's model does not resolve (`resolveModel` null: off its provider's list, no longer configured): not retryable. */
const MODEL_GONE: RunEnd = { status: "failed", error: "model_gone" };
/** The Agent is no longer a member of the run's group: nothing is called or posted there. */
const REMOVED: RunEnd = { status: "cancelled", error: "agent_removed" };
/**
 * Ended quietly before any call: refused as it was admitted (runs.ts `refusedAtAdmission`: someone else's call found the
 * Agent's others' daily budget spent, or a reply nobody asked for found its owner's switch off or its proactive budget
 * spent), or a reply nobody asked for that someone called after its claim (`begin`'s first step). No call, nothing held
 * or charged — nothing failed and there is nothing to retry, as for such a call refused when it was made (of which
 * nothing is recorded); the group is told only by the others' budget's notice.
 */
const ENDED_QUIETLY: RunEnd = { status: "cancelled" };
/**
 * Held back at admission (metering/admit.ts `HeldBack`): the run went back to `queued` in that transaction, to wait for one
 * of its owner's calls running then to end (`claimNext`); `begin` told its owner so. This attempt is over: `finish`, given
 * this very value, does nothing at all — the run may already be claimed again, its next attempt under way, which nothing
 * of this one may touch (its row, its settlement, its flags). Compared by identity, never by its shape.
 */
const HELD_BACK: RunEnd = Object.freeze({ status: "cancelled" });

/**
 * What of a reply's one budget of text (`RunFlags.othersText`) the acknowledgement that stands for it took — its own, or an earlier
 * attempt's at the same question (conversation.ts `standingAcknowledgement`) — by the text STORED; 0 when none stands (none was
 * posted, its write failed, or it is a social reply, which posts none: its preface is in its one message).
 */
async function acknowledgedWeight(t: Tx, run: RunTicket): Promise<number> {
  const seq = await standingAcknowledgement(t, run.conversationId, run.agentId, run.id);
  if (seq === null) return 0;
  const { rows } = await t.query<{ text: string | null }>("select body ->> 'text' as text from messages where conversation_id = $1 and seq = $2", [run.conversationId, seq]);
  return weight(rows[0]?.text ?? "");
}

/** `beginOnce`: the plan it made is not for the reply the row is at admission; nothing of it was sent or held (`begin` plans again). */
const STALE_PLAN = Symbol("stale plan");

/** What a plan of `begin` was made for: whose reply the run was (its lane and caller) and the calls it answers (those it covers). */
interface PlanBasis {
  lane: Lane;
  caller: string | null;
  calls: string;
}
const basisOf = (state: Pick<RunState, "lane" | "caller_id" | "call_seqs">, covers: number): PlanBasis => ({
  lane: state.lane,
  caller: state.caller_id,
  // (A call noted on it since — after what it covers — is its follow-up's: no part of the plan.)
  calls: (state.call_seqs ?? []).map(Number).filter((seq) => seq <= covers).sort((a, b) => a - b).join(","),
});
const sameBasis = (a: PlanBasis, b: PlanBasis): boolean => a.lane === b.lane && a.caller === b.caller && a.calls === b.calls;

/** Why `postAsAgent` refuses a run's reply (409): the Agent's state, or what interrupted the run. */
const REFUSED: ReadonlySet<string> = new Set(["agent_paused", "agent_deleted", "agent_removed", "halted", "owner_spoke", "access_ended", "notes_changed", "errand_ended"]);

/** What `begin`, `finish` and recovery read of the run, under its row lock. */
interface RunState {
  status: string;
  covers_seq: string | null;
  pending_seq: string | null;
  interrupted: Interruption | null;
  lane: Lane;
  /**
   * The calls it answers and those noted on it, as each was accepted when it was sent (`call_seqs`): what its follow-up
   * answers of what was noted. A told reply's hold the calls noted on it only.
   */
  call_seqs: string[] | null;
  /** Those of them accepted as its owner's own, each as it was made (`owner_call_seqs`): what makes a reply, or its follow-up, the owner's own. */
  owner_call_seqs: string[];
  /** It was held back at an earlier attempt and is not admitted yet (`held_back_by`). */
  marked: boolean;
  /** Its owner asked it to stop while it ran (runs.ts `stopRun`). */
  stop_asked: boolean;
  /** Whose message called for it: a person's, or an Agent's (`agent_runs.triggered_by`; the web search's guard reads it). */
  triggered_by: "human" | "agent";
  /**
   * A reply `告诉他们` queued (`whisper_id`): it answers nobody's call — what it covers is merely the group's latest message
   * when it was queued, anyone's — so `begin` holds none of it to the block rule; the calls noted on it are its follow-up's,
   * held to that rule there (runs.ts `followUp`).
   */
  told: boolean;
  /** A new Agent's first reply (`agent_runs.greets`, conversation.ts `createAgent`): told to greet its owner. */
  greets: boolean;
  /** Whose call it answers (`agent_runs.caller_id`): a social run's one visitor; null when not known. */
  caller_id: string | null;
  /** An automatic retry (runs.ts `scheduleAutoRetry`): the run of its original call; null for an original. */
  retry_of: string | null;
  /** How many automatic attempts came before it (0: none, an original or the owner's own 重试). */
  auto_attempt: number;
  /** An automatic retry: when its original call was made (the start bound, `AUTO_RETRY_WINDOW_MS`); else null. */
  original_at: Date | null;
  /** The reply had produced something before it was lost: its acknowledgement posted, or a tool round completed. */
  progressed: boolean;
  /** The run is in a social conversation (`agent_social`): how an ended access is recorded (`interruptionEnd`). */
  social: boolean;
}
const RUN_STATE =
  "status, covers_seq::text, pending_seq::text, interrupted, lane, call_seqs::text[] as call_seqs, owner_call_seqs::text[] as owner_call_seqs, held_back_by is not null as marked, stop_asked, whisper_id is not null as told, triggered_by, caller_id, greets, retry_of, auto_attempt, progressed, " +
  "case when auto_attempt > 0 then (select o.created_at from agent_runs o where o.id = agent_runs.retry_of) end as original_at, " +
  "coalesce((select sc.type = 'agent_social' from conversations sc where sc.id = agent_runs.conversation_id), false) as social";

/**
 * How a run its mark `interrupted` ended is recorded: `cancelled` with the mark as its reason. One exception (Controller ruling
 * 2026-11-24 (B-3 dispatch); integration): a GROUP run whose access ended (`access_ended`: the ending found no call it answers left,
 * social/agent-contacts.ts `endGroupCalls`, or the operator disabled its Agent) ends quietly, with no error, as a group run left with
 * no call does at `begin` (`BLOCKED_SINCE`) and at its post. `access_ended` as a recorded reason is a social run's.
 */
const interruptionEnd = (state: Pick<RunState, "interrupted" | "social">): RunEnd =>
  state.interrupted === "access_ended" && !state.social ? { status: "cancelled" } : { status: "cancelled", error: state.interrupted! };

/**
 * An automatic retry that would START more than `AUTO_RETRY_WINDOW_MS` after its original call was made (held back by
 * admission, or queued while the service was down): it is not started — it ends as the ordinary failure, which the owner
 * may retry and the members see as 暂时无法回复; never passing, so nothing tries it again.
 */
const RETRY_TOO_LATE: RunEnd = UNAVAILABLE;

/** One line per automatic retry made, run, or given up (README "Metrics in the log"): counts only, never what was said. */
function countRetry(log: Partial<Pick<FastifyBaseLogger, "info">>, retried: AutoRetry): void {
  if (retried === null) return;
  if ("retry" in retried) log.info?.({ metric: "auto_retry_scheduled", attempt: retried.attempt }, "agent run: failed for a passing reason; the system tries it again");
  else log.info?.({ metric: "auto_retry_gave_up", why: retried.gaveUp }, "agent run: failed for a passing reason; not tried again");
}

/**
 * How a run that ended `end` is recorded: as it ended — but a new Agent's greeting (`greets`) that failed is `cancelled`
 * with no error, so no failure and no 重试 is shown in a conversation where nothing was said yet: there is simply no Agent
 * message, and the client's hint invites its owner to write (principle P2: never a fixed line in its place). Settlement
 * reads the end as it was.
 */
const quietGreeting = (end: RunEnd, state: Pick<RunState, "greets">): RunEnd => (state.greets && end.status === "failed" ? { status: "cancelled" } : end);


/*
 * `keepsNothingNoted` (round 2, N-3): the members' calls noted on a told reply (`告诉他们`) are never held to its owner. However
 * it ends — posted or not; failed as it ran (`finish`), or ended by recovery at start-up, a release or the stale-run sweep
 * (`recoverRun`, which follows no other failed run) — they go to an ordinary follow-up at once by the one rule
 * (`followUpSeq`: unless the Agent's pause, delete, leaving or missing model dropped them, as for any run), and the told
 * run keeps none of them (`pending_seq` cleared, `call_seqs` empty): a retry of it tells with nothing noted.
 */

/**
 * A run's in-process flags, from its claim until it has finished. A delta waiting to be delivered keeps the flags it
 * was emitted under, so once `silenced` it stays dropped, however late the hub gets to it — also after `finish` has
 * forgotten the run.
 */
interface RunFlags {
  /**
   * The lane this attempt has met the owner's replies at a time for (`claimNext`'s check, or `begin`'s own when the lane changed
   * since): a reply that is no longer the owner's own as it begins meets the others' limit before anything is prepared.
   */
  lane?: Lane;
  /** Its owner asked it to stop, or its Agent's pause, delete or leaving the run's group interrupted it. */
  stop: boolean;
  /** Its Agent's pause, delete or leaving the run's group interrupted it: nothing more of it is pushed. */
  silenced: boolean;
  /**
   * Where it is (`placeOf`, decided at `begin`, once per attempt): anywhere but the Agent's own conversation — a group or a social
   * conversation — none of it is streamed (plan ruling 2): its reply arrives whole, with its message.
   */
  place: Place;
  /**
   * In a group, the run's mark (prompt.ts `newMark`), kept from the moment `begin` hands over the call that carries it:
   * `post` takes this copy, never one the worker could hand it, out of the reply. Null until then, and in the Agent's own
   * conversation. A run this process did not begin has none — after a restart, every run the previous process left
   * running is ended by recovery before the worker starts, its model's output gone with that process, so no such run
   * is ever posted. Never stored, pushed or logged.
   */
  mark: string | null;
  /** What `extend` prices the reply's later calls by, from `begin` once the call is admitted; null until then. */
  money: RunMoney | null;
  /** The model the reply calls, from `begin` once the call is admitted (with `money`); null until then. */
  model: RunModel | null;
  /** What its context left out (context.ts `LoadedContext.leftOut`), from `begin` once the call is admitted; null until then, or none. */
  leftOut: LeftOut | null;
  /**
   * A reply for others: the ONE budget for every text of it the conversation reads (fix round 4, F3; review 5, item 8) — `most`, the
   * others' output limit in the weight its model's tokens are estimated by. Its acknowledgement (the text it wrote before a tool call,
   * posted at once as a message of its own) is held to half of it, so the answer always has room; its final post to what is left of it
   * once the acknowledgement that stands for it is taken out — read at the post from what is STORED (`acknowledgedWeight`), never
   * from what the worker could tell or a counter a failed write would leave behind — at every level (`none` too: a text that holds
   * two rounds, an acknowledgement that could not be posted or a social reply's preface, is more than one call's limit). Null for the
   * owner's own reply.
   */
  othersText?: { most: number } | null;
  /**
   * A reply offered tools, from `begin` once the call is admitted: the numbers it gave the model (refs.ts — its context's
   * file labels, then what its tools hand over) and how far its conversation had come when it began (`RunScope.heardTo`).
   * Null for one offered none. Forgotten with the run's flags: no number outlives its reply. A reply offered the web
   * search also keeps the texts of the notes and hearsay it was shown (`shown`: its query guard's, never stored or logged).
   */
  tools: { refs: RunRefs; heardTo: number; shown?: readonly string[]; ownerAsked?: boolean; shownFrom: number | null } | null;
}

/**
 * How a run is recorded, from what is true under `lockAgent` rather than what the worker could tell (an owner's stop
 * and a pause look alike to it): a reply that was posted stands — `done`, or `stopped` by its owner — whatever happened
 * to the Agent after; a run its Agent's pause, delete or leaving the run's group (`agent_removed`) interrupted, and that
 * posted nothing, is `cancelled` with that
 * reason (also when the Agent was resumed meanwhile); a refused post is `cancelled` for the Agent's state — deleted,
 * paused, or no longer a member of the run's group (`removed`).
 */
function recorded(end: RunEnd, s: { posted: boolean; interrupted: Interruption | null; social: boolean; agent: AgentRow; removed: boolean }): RunEnd {
  if (s.posted) return end.status === "stopped" ? end : { status: "done" };
  if (s.interrupted) return interruptionEnd(s);
  if (end.status === "cancelled" && end.error === undefined) {
    if (s.agent.deleted) return { status: "cancelled", error: "agent_deleted" };
    if (s.agent.paused) return { status: "cancelled", error: "agent_paused" };
    if (s.removed) return REMOVED;
  }
  return end;
}

/**
 * Whether a social run's one caller may still reach its Agent (plan B7a; the errands plan extends it with the errand a run serves):
 * `reach(caller, Agent, 'social')`, and no other caller than a visitor: a social run is always lane `others`, its caller a person
 * who is not the Agent's owner (the owner's message interjects, it never calls: `triggerInSocial`). A run with no caller, the
 * owner as caller or another lane is refused outright (`no_access`), so no social run can carry the owner's authority or run
 * unbounded. Anything but `ok` ends the run `access_ended` before any call.
 */
async function runAccess(t: Tx, agent: AgentRow, state: Pick<RunState, "caller_id" | "lane">, config: Pick<Config, "social">): Promise<"ok" | "no_access" | "gone" | "blocked" | "barred"> {
  if (state.caller_id === null || state.caller_id === agent.ownerId || state.lane !== "others") return "no_access";
  return reach(t, state.caller_id, agent.id, "social", config);
}

/**
 * `AgentPort` over the database, the hub and the event registries: the one place the reply worker's work turns into
 * SQL. Besides the port it offers the routes what they need to reach a run in flight: `announce`, `requestStop`,
 * `interruptRuns` (called after their transactions commit, before they answer).
 */
export class DbAgentPort implements AgentPort {
  /**
   * The flags of the runs this process is working on, by id: made when a run is claimed (or first flagged), forgotten
   * once it has finished. They live in this process only, like the worker: a new start begins with none, and a run left
   * `running` by the previous one is recovered (`recoverRuns`) before anything could flag it.
   */
  private readonly flags = new Map<string, RunFlags>();
  private wakeWorker: () => void = () => {};

  constructor(private readonly deps: AgentPortDeps) {}

  /** The clock of automatic retries (`AgentPortDeps.now`). */
  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private flagsOf(runId: string): RunFlags {
    let flags = this.flags.get(runId);
    if (!flags) {
      flags = freshFlags();
      this.flags.set(runId, flags);
    }
    return flags;
  }

  /** What to call when a run is queued: the worker's wake-up. */
  onQueued(fn: () => void): void {
    this.wakeWorker = fn;
  }

  /**
   * After the transaction that changed it committed: the run goes to its owner's sockets (the hub reads who that is
   * from the run's row, `Hub.pushRun`); a queued one wakes the worker.
   */
  announce(a: Announced): void {
    this.deps.realtime.pushRun(a.conversationId, a.run);
    if (a.run.status === "queued") this.wakeWorker();
  }

  /** The owner asked a running run to stop: the attempt this process works on, if any (no flags are made for another). */
  requestStop(runId: string): void {
    const flags = this.flags.get(runId);
    if (flags) flags.stop = true;
  }

  /**
   * The stop route's step after its transaction found the run `running` and kept the stop in its row (runs.ts `stopRun`,
   * `stop_asked`): the attempt this process works on stops within 50 ms (`requestStop`). Any later attempt — after its
   * admission held it back, say — ends stopped at its `begin` (`halted` reads the row under the run's lock, which `stopRun`
   * wrote it under, so a run the stop saw running can no longer go back to `queued`).
   */
  stopAsked(runId: string): void {
    this.requestStop(runId);
  }

  /**
   * Runs the Agent's pause or delete (runs.ts `interruptRuns`), or its leaving the run's group (group-leave.ts
   * `endRunsInGroup`), has just marked `interrupted`: their calls are abandoned
   * and, from now on, none of their deltas reaches the owner — not even one already waiting in the hub's queue, also
   * when the hub delivers it after the run has finished.
   */
  interruptRuns(runIds: readonly string[]): void {
    for (const id of runIds) {
      const flags = this.flagsOf(id);
      flags.silenced = true;
      flags.stop = true;
    }
  }

  shouldStop(run: RunTicket): boolean {
    return this.flags.get(run.id)?.stop === true;
  }

  /** Ends every queued reply in a social conversation `cancelled`, `access_ended` (the switch is off), and tells each one's owner. */
  private async endQueuedSocial(): Promise<void> {
    const { rows } = await this.deps.db.query<RunRow & { owner_id: string; conversation_id: string }>(
      `update agent_runs r set status = 'cancelled', error = 'access_ended', finished_at = now(), pending_seq = null
         from conversations c
        where c.id = r.conversation_id and c.type = 'agent_social' and r.status = 'queued' and r.purpose = 'reply'
        returning ${RUN_COLUMNS}, r.owner_id, r.conversation_id`,
    );
    for (const row of rows) this.announce({ ownerId: row.owner_id, conversationId: row.conversation_id, run: toWireRun(row) });
  }

  /**
   * `AgentPort.claimNext`. A reply held back at admission (`HELD_BACK`; its mark `held_back_by`, `held_back_on`, kept until
   * it is admitted) waits while every call it was held back behind is still running. Until it is admitted — queued, or
   * claimed again and not admitted yet — the owner's younger replies whose class shares a pot with its class wait behind
   * it (first come, first served per payer and pot, so a reply with a large hold is not passed for ever by smaller ones):
   * every site reply behind a free-tier one; a paid one behind a paid one, while a free-tier one goes on to admission,
   * which starts it only on the allowance alone (review I1); a free-tier one behind an old code's mark on the allowance;
   * a reply on the owner's own provider key does not, nor does the owner's own reply (lane `own`)
   * behind one someone else called for, which the others' lanes may keep queued. A queued reply's class is admission's own
   * rule (metering/admit.ts `classSql`) on what its owner has now, read here. Each claim starts the
   * run's flags afresh. A first claim is announced (`announce`) and its wait logged (`run_wait_ms`, once per reply); a
   * reply claimed again after it was held back is told to its owner alone — the other members of a group, who were told it
   * is replying, are told nothing more.
   */
  async claimNext(): Promise<RunTicket | null> {
    const { config } = this.deps;
    // The site's Agent social switch is off: a queued run in a social conversation is not claimed (the claim's own filter, `$8`, holds
    // even for one queued after this statement); it ends `access_ended`, announced to its owner, and nothing answers an old message
    // when the switch comes back on (M5, M18).
    if (!config.social.enabled) await this.endQueuedSocial();
    const waiting = (r: string) =>
      `(${r}.held_back_by is not null
        and (select count(*) from agent_runs b where b.id = any(${r}.held_back_by) and b.status = 'running') = cardinality(${r}.held_back_by))`;
    // The class the queued reply q would be admitted on now: admission's own rule (metering/admit.ts `classSql`, the one
    // definition) — `free` (the allowance, then the balance) or `balance` — null on a provider's model, on a model the
    // site no longer offers, or with nothing left (it will be refused).
    const cols = { freeTier: "qa.site_model_id = any($4::text[])", freeLeft: "$5::bigint - m.used", balance: "m.balance" };
    const classOfQ = `(
      select case
               when qa.model_source is distinct from 'site' or not (qa.site_model_id = any($3::text[])) then null
               else ${classSql(cols)}
             end
        from agents qa,
             (select coalesce((select u.used_micro from free_usage u where u.owner_id = q.owner_id and u.day = $6::date), 0) as used,
                     coalesce((select a.balance_micro from accounts a where a.principal_id = q.owner_id), 0) as balance) m
       where qa.principal_id = q.agent_id)`;
    // Whose turn q waits for (review I1): a free-tier reply's mark (`any`, both pots) holds back every site reply; a paid
    // one's (`balance`) holds back paid replies only — a free-tier reply goes on to admission, which starts it only on the
    // allowance alone, so the balance stays the waiting paid reply's (metering/admit.ts); an old code's `free` mark holds
    // back free-tier replies only.
    const sharesWithQ = `(o.held_back_on = ${classOfQ} or (o.held_back_on = 'any' and ${classOfQ} is not null))`;
    const { rows } = await this.deps.db.query<RunRow & { agent_id: string; owner_id: string; conversation_id: string; lane: string; wait_ms: number; again: boolean; auto_attempt: number }>(
      `with next as (
         select q.id from agent_runs q
          where q.status = 'queued' and q.purpose = 'reply'
            and (q.not_before is null or q.not_before <= $7::timestamptz)
            and ($8::boolean or not exists (select 1 from conversations sc where sc.id = q.conversation_id and sc.type = 'agent_social'))
            and (select count(*) from agent_runs x where x.owner_id = q.owner_id and x.status = 'running') < $1
            and (q.lane = 'own'
              or (select count(*) from agent_runs x where x.owner_id = q.owner_id and x.status = 'running' and x.lane <> 'own') < $2)
            and not ${waiting("q")}
            and not exists (select 1 from agent_runs o where ${olderMarkSql("o", "q")} and ${sharesWithQ})
          order by q.created_at, q.id
          limit 1
          for update of q skip locked
       )
       update agent_runs as r set status = 'running', started_at = now() from next where r.id = next.id
       returning ${RUN_COLUMNS}, r.agent_id, r.owner_id, r.conversation_id, r.lane, r.held_back_by is not null as again, r.auto_attempt,
                 (extract(epoch from (r.started_at - r.created_at)) * 1000)::int as wait_ms`,
      [
        config.agentMaxConcurrentRuns,
        config.agentMaxConcurrentOthersRuns,
        config.siteModels.map((m) => m.id),
        config.siteModels.filter((m) => m.tier === "free").map((m) => m.id),
        config.freeDailyMicro.toString(),
        siteDay(new Date(), config.siteTimezone),
        this.now(),
        config.social.enabled,
      ],
    );
    const row = rows[0];
    if (!row) return null;
    const run: RunTicket = { id: row.id, agentId: row.agent_id, ownerId: row.owner_id, conversationId: row.conversation_id };
    this.flags.set(run.id, { ...freshFlags(), lane: row.lane as Lane });
    if (row.again) {
      this.deps.realtime.pushRunToOwner(run.conversationId, toWireRun(row));
    } else if (row.auto_attempt > 0) {
      // An automatic retry (runs.ts `scheduleAutoRetry`) is told to its owner alone: the other members of a group, told the
      // Agent is replying, are told nothing more until its answer (the same frames as an answer at the first try).
      this.deps.realtime.pushRunToOwner(run.conversationId, toWireRun(row));
    } else {
      this.deps.log.info({ metric: "run_wait_ms", lane: row.lane, ms: row.wait_ms }, "agent run: claimed");
      this.announce({ ownerId: run.ownerId, conversationId: run.conversationId, run: toWireRun(row) });
    }
    return run;
  }

  /** Locks the run's conversation row, then the Agent's `agents` row (`lockAgent`), then the run's row, and reads them. */
  private async lockRun(t: Tx, run: RunTicket): Promise<{ agent: AgentRow; state: RunState }> {
    const agent = await lockAgent(t, run.agentId, run.conversationId);
    const state = await t.query<RunState>(`select ${RUN_STATE} from agent_runs where id = $1 for update`, [run.id]);
    // Ended elsewhere meanwhile (another instance's recovery, or the stale-run sweep): nothing more of it is done here.
    if (state.rows[0]?.status !== "running") throw new RunNotRunning(run.id, state.rows[0]?.status ?? null);
    return { agent, state: state.rows[0] };
  }

  /**
   * Under `lockRun`: how the run ends instead of calling its model — interrupted by its Agent's pause or delete (even if
   * resumed since) or by its leaving the run's group (even if back since), the Agent paused or deleted, or a stop asked
   * for — or null when it may go on.
   */
  private halted(run: RunTicket, agent: AgentRow, state: RunState): RunEnd | null {
    if (state.interrupted) return interruptionEnd(state);
    if (agent.deleted) return { status: "cancelled", error: "agent_deleted" };
    if (agent.paused) return { status: "cancelled", error: "agent_paused" };
    if (state.stop_asked || this.shouldStop(run)) return { status: "stopped" };
    return null;
  }

  /** What step 1 of `begin` took on, handed back as noted (`covers_seq` back to what it covered, `pending_seq` at least it). */
  private async handBack(t: Tx, runId: string, coveredBefore: number, covers: number): Promise<void> {
    await t.query("update agent_runs set covers_seq = $2, pending_seq = greatest(coalesce(pending_seq, 0), $3) where id = $1", [runId, coveredBefore, covers]);
  }

  /** Whether `state` is an automatic retry past its start bound (`RETRY_TOO_LATE`); counted once it is found so. */
  private tooLate(state: RunState): boolean {
    if (state.auto_attempt === 0 || state.original_at === null) return false;
    if (this.now().getTime() - state.original_at.getTime() <= AUTO_RETRY_WINDOW_MS) return false;
    this.deps.log.info({ metric: "auto_retry_gave_up", why: "window" }, "agent run: an automatic retry came too late to start; it ends as the failure");
    return true;
  }

  /**
   * Three steps, so that no transaction is open while attachments are read:
   *
   * 1. A short transaction under `lockRun`: a run that is `halted` ends here, and so does one in a group its Agent is no
   *    longer a member of (`cancelled`, `agent_removed`) and one whose model does not resolve (`failed`,
   *    `model_gone`). A run in a group is flagged so that none of it is streamed (`emit`). A reply nobody asked
   *    for (lane `proactive`) that a mention was noted on since its claim ends here quietly (`ENDED_QUIETLY`): the moment
   *    for an unasked remark has passed, and its follow-up answers the mention, noted still, in the caller's lane.
   *    Otherwise the run takes on what came meanwhile (`covers_seq` = max(covers, pending)), and what the model may be
   *    shown is read: the
   *    system text — its own conversation's (`systemPrompt`, with what the Agent calls its owner), or the group's
   *    (`groupSystemPrompt`, with the group's title, other Agents and roster, `loadGroupScene`; the roster's speakers
   *    are those of what `loadContext` read, `withRoster`; and, last, the pair's rolling summary when it may be shown,
   *    context.ts `loadContext`) — and the conversation (`loadContext`, SQL only; in a group at
   *    most `agentGroupContextTokens` tokens of its latest `GROUP_CONTEXT_MESSAGES` messages, nothing at or before the
   *    run's asker's line (context.ts `askerLine`: the latest joining of its askers — those whose questions it answers,
   *    and everyone who wrote since what it covered before, recorded first, runs.ts `hearFrom`) but the calls it answers
   *    (context.ts `callsSeen`), each of someone else's
   *    labelled with the run's mark, which `loadContext` draws with `deps.drawMark` and the roster carries too; the
   *    port keeps it for `post` once the call is handed over, `RunFlags.mark`). In a group, a run none of whose calls its
   *    Agent can see ends there, before the conversation is read: `cancelled` with no error (`NOTHING_LEFT`). With no owner's message in it (in a group: nobody else's) the run ends without a call:
   *    `cancelled` with no error when everything it was to answer is before a new topic (its owner started over), else
   *    `failed` `busy`; and so does one whose model's context cannot hold the newest such message, or 200 tokens of it,
   *    beside the system text, roster and all (`failed`, `context_too_small`). Everything here is planned at the model's
   *    learned ratio when it is above 1 (metering/tokens.ts `planRatio`; read once, here, for the whole run), with a tenth
   *    of the room kept free (`contextBudget`). The tools the reply is offered are decided here, before the plan: its
   *    toolbox's (`AgentPortDeps.toolbox`; none while `TOOLS.enabled` is false, none for a model that cannot use them —
   *    `Resolved.tools` —, none without a toolbox; a reply offered none is told so in its system text, one offered some
   *    is not), their definitions
   *    (at the plan's ratio) and what providers add around them (`TOOL_PREAMBLE_TOKENS`) reserved in the plan as the
   *    system text is — and, from what that plan gives the conversation, room for what the tools bring back
   *    (`resultReserve`) and the last call's line (`FINAL_LINE`), reserved with them, so that the conversation is planned
   *    once more; when, with that reservation, the conversation would not get the room a call needs at least (the
   *    `context_too_small` rule), none are offered and the run is planned, and goes on, as one that offers none. The
   *    reservation is a plan only: nothing is held or charged for it (step 3 holds what is sent).
   * 2. No transaction: the attachments' bytes are read and the call's turns assembled (`buildContext`). A send to the
   *    conversation, a pause or a delete meanwhile does not wait for it. No further file is read once the run should
   *    stop (step 3 then ends it); a file that cannot be read is shown by its name; the store failing on two files
   *    before it has served one, or the step taking longer than `agentRunTimeoutMs`, ends the run `failed`, `busy`. When `closing`
   *    aborts (the service is closing) the read is abandoned and `begin` rejects with its reason before step 3: the run
   *    is still `running`, unadmitted, and its caller ends it (the worker: `release`).
   * 3. A short transaction under `lockRun` again: a run `halted` meanwhile ends as in step 1, with no call; when
   *    `closing` has aborted by the time the locks are held, the transaction rolls back and `begin` rejects with its
   *    reason, admitting nothing (as in step 2). Then what its lane is held to is read again (runs.ts
   *    `refusedAtAdmission`; replies settled while it waited queued may have spent a budget since): a run someone else
   *    called for (lane `others`) meets the Agent's others' daily budget, and a reply nobody asked for (`proactive`) its
   *    owner's switch and its proactive budget. Refused, it ends `cancelled` with no error (`ENDED_QUIETLY`) — no
   *    call, nothing held or charged — and the others' budget's notice, if this appended it, is published to the group
   *    after commit, the Agent pushed to its owner (a reply nobody asked for tells nobody). What step 1 took on (noted on
   *    the run after its claim) is handed back as noted — `covers_seq` back to what it covered before, `pending_seq` at
   *    least what it took on — so `finish`'s follow-up answers it as any: the owner's own mention is queued as theirs (the
   *    owner's calls are never refused by these), someone else's meets the others' budget again and is not queued once
   *    it is spent.
   *    Otherwise
   *    the call is admitted holding the most its input can cost: its text at its utf-8 bytes, at most what the model's
   *    context leaves beside the output limit, images and PDFs at their constants (metering/tokens.ts `holdTokens`; no
   *    ratio in it; 402 `no_quota` ends the run failed; a reply whose hold does not fit beside its owner's other running
   *    calls' goes back to `queued`, nothing held, `HELD_BACK`); the estimate itself (a call of text only) and the ratio's key are recorded on
   *    the run for settlement to learn from, and the Agent's read marker moves to what the run covers (announced after
   *    commit). What settlement falls back on when no usage is reported is the estimate with its text corrected by the
   *    model's learned ratio (the one step 1 read). The reasoning level is the Agent's when the model allows it, else `none`.
   *    A reply offered tools (step 1) has their definitions held at their bytes too, and what providers add around them
   *    (`TOOL_PREAMBLE_TOKENS`); no estimate is recorded (such a reply teaches the ratio nothing), and what its later
   *    calls are priced by is kept for `extend` (`RunFlags.money`).
   */
  async begin(run: RunTicket, closing?: AbortSignal): Promise<Prepared | RunEnd> {
    // A plan that the row no longer agrees with at admission (step 3: whose reply it is changed while its attachments were read) is
    // thrown away whole — no call was made, nothing held — and made again from the row as it is. Changes are few (each takes a call
    // out of the reply): after three plans it goes back to the queue instead, to be claimed and begun afresh.
    for (let plan = 0; plan < 3; plan += 1) {
      const begun = await this.beginOnce(run, closing);
      if (begun !== STALE_PLAN) return begun;
    }
    const queued = await this.deps.db.tx(async (t) => {
      await this.lockRun(t, run);
      return this.backToQueue(t, run);
    });
    return this.heldBack(run, queued, this.flagsOf(run.id));
  }

  /** The run back to `queued`, unadmitted and holding nothing, to be claimed again (the claim meets the limits of the lane it has now). */
  private async backToQueue(t: Tx, run: RunTicket): Promise<Announced> {
    const queued = await t.query<RunRow>(`update agent_runs as r set status = 'queued', started_at = null where r.id = $1 returning ${RUN_COLUMNS}`, [run.id]);
    return { ownerId: run.ownerId, conversationId: run.conversationId, run: toWireRun(queued.rows[0]!) };
  }

  /** This attempt put its run back to `queued` (`HELD_BACK`): its owner is told; its flags go, unless a later attempt has its own already. */
  private heldBack(run: RunTicket, queued: Announced, mine: RunFlags): RunEnd {
    this.deps.realtime.pushRunToOwner(run.conversationId, queued.run);
    if (this.flags.get(run.id) === mine) this.flags.delete(run.id);
    this.wakeWorker();
    return HELD_BACK;
  }

  private async beginOnce(run: RunTicket, closing?: AbortSignal): Promise<Prepared | RunEnd | typeof STALE_PLAN> {
    const { db, config, blobs, log } = this.deps;
    const now = new Date();
    // This attempt's flags (`claimNext` started them): a later attempt of the same run has flags of its own.
    const mine = this.flagsOf(run.id);
    const first = await db.tx(async (t): Promise<
      | { end: RunEnd; queued?: Announced }
      | {
          /** Whose reply the plan was made for (the row after step 1): step 3 admits it only for the same. */
          basis: PlanBasis;
          resolved: Resolved;
          loaded: LoadedContext;
          covers: number;
          coveredBefore: number;
          key: string;
          ratio: number;
          offer: Offer | null;
          reserved: number;
          withoutTools: string | null;
          tools: { refs: RunRefs; heardTo: number; shown?: readonly string[]; ownerAsked?: boolean } | null;
          told: boolean;
          /** Bounded as another person's reply is (`boundedForOthers`, one real tool call, the two-part hold, the others' numbers). */
          bounded: boolean;
          /** A social run: the notes it was shown and the ones left out, to be written to the run with its admission (B7c). */
          social: { shown: readonly ShownNote[]; withheld: readonly ShownNote[] } | null;
        }
    > => {
      const { agent, state } = await this.lockRun(t, run);
      const halted = this.halted(run, agent, state);
      if (halted) return { end: halted };
      // Where the run is, read once for this attempt: the Agent's own conversation (no query), a group, or a social conversation. Not
      // own: nothing of the reply is streamed (`emit`), and it has a mark and labels. Every arm below that is not for the own
      // conversation names its place: nothing a place does not name is done for it (a social run never takes a group arm).
      const place: Place = run.conversationId === agent.conversationId ? "own" : await placeOf(t, run.conversationId, agent);
      const group = place === "group";
      const social = place === "social";
      const away = place !== "own";
      if (away) this.flagsOf(run.id).place = place;
      // A social run: its one visitor may still reach the Agent (`runAccess`); anything else ends it before any call, unread.
      if (social && (await runAccess(t, agent, state, this.deps.config)) !== "ok") return { end: ACCESS_ENDED };
      // In a group: the Agent must still be a member there (nothing else may have marked the run yet); the same in a social conversation.
      const scene = group ? await loadGroupScene(t, agent, run.conversationId) : null;
      if (group && scene === null) return { end: REMOVED };
      const socialScene = social ? await loadSocialScene(t, agent, run.conversationId) : null;
      if (social && socialScene === null) return { end: REMOVED };
      // A block made since a call, either way, between the Agent's owner and whoever made it: that call is dropped, as it
      // would be refused now (runs.ts `dropRefusedCalls`, every lane, every group run: one of the owner's own may carry a
      // call relayed by someone else's Agent); with no call left the reply ends quietly. Not asked (no query) in the
      // Agent's own conversation, where every call is its owner's and nobody has a block with themselves — nor for a reply
      // `告诉他们` queued (`told`): it is its owner's own tell and answers nobody's call (what it covers is merely the
      // group's latest message then, anyone's); what was noted on it is held to the block rule by its follow-up.
      if (group && !state.told) {
        const kept = await dropRefusedCalls(t, run.id, agent.ownerId);
        if (kept === null) return { end: BLOCKED_SINCE };
        Object.assign(state, kept);
        // The calls noted on it since its claim are taken on below (`covers`): whose reply it is, is decided over every call it will
        // answer, as for calls folded into it while it was queued (runs.ts `settleLane`; fix round 5) — a member's call taken on so
        // makes the owner's own reply a reply for others; the owner's taken on by a member's reply leaves it the member's.
        if (Number(state.pending_seq ?? 0) > Number(state.covers_seq ?? 0)) {
          const settled = await settleLane(t, run.id, agent.ownerId, false);
          if (settled !== null) Object.assign(state, { lane: settled.lane, caller_id: settled.id });
        }
      }
      // The lane it has now is not the one its claim met the owner's replies at a time for (a call was taken out since — just now, or
      // by an ending of access — or one noted on it is taken on now): a reply that is no longer the owner's own meets the others' limit
      // here, before anything is prepared (fix round 4, R3). Over it, it goes back to the queue, where the claim holds it to that limit.
      if (mine.lane !== undefined && mine.lane !== state.lane) {
        if (state.lane !== "own") {
          const others = await t.query<{ n: number }>("select count(*)::int as n from agent_runs where owner_id = $1 and status = 'running' and lane <> 'own' and id <> $2", [run.ownerId, run.id]);
          if (others.rows[0]!.n >= config.agentMaxConcurrentOthersRuns) return { end: HELD_BACK, queued: await this.backToQueue(t, run) };
        }
        mine.lane = state.lane;
      }
      // Bounded as another person's reply is: every social run (its caller is never the owner: `runAccess`), and any other run not
      // in lane `own`. Decided here by the place, so no social run can be unbounded whatever its row says; and AFTER the calls
      // refused since were dropped, by the lane the reply has now (the calls left decide it: runs.ts `dropRefusedCalls`).
      const bounded = social || state.lane !== "own";
      // A reply `告诉他们` queued (Task 8): what its whisper found elsewhere, read now as its owner may read it now
      // (Redesign D: a hit she can no longer read is left out), shown to it as material in its system text
      // (tools/elsewhere.ts `toldPassage`); it answers no call, and is offered no tools. Its whisper gone (deleted 30 days
      // after it was made), no longer one it may tell (declined, expired: whispers/store.ts `mayTell`) or no hit left to
      // read: there is nothing to tell.
      const told = group ? await toldHits(t, run.id, { timeZone: config.siteTimezone, elsewhereTtlHours: config.whispers.elsewhereTtlHours }) : null;
      if (told !== null && told.length === 0) return { end: NOTHING_LEFT };
      // A reply nobody asked for that someone has called since its claim: no unasked remark now. What was noted on it
      // stays noted, so its follow-up answers the call in the caller's lane.
      if (state.lane === "proactive" && Number(state.pending_seq ?? 0) > Number(state.covers_seq ?? 0)) return { end: ENDED_QUIETLY };
      // An automatic retry whose question was answered meanwhile — a reply of this Agent's there from another run, posted
      // after the original call was made — has nothing left to answer: it ends quietly, with no call.
      if (state.retry_of !== null && (await answeredSince(t, run, state.retry_of))) return { end: ENDED_QUIETLY };
      // An automatic retry starts within ten minutes of its original call, or not at all (the bound is on starting).
      if (this.tooLate(state)) return { end: RETRY_TOO_LATE };

      let resolved;
      try {
        resolved = await resolveModel(t, config, agent);
      } catch (err) {
        if (!(err instanceof KeyUnreadableError)) throw err;
        // As a key the provider refused: its owner must save it again. Not retryable as it is.
        log.error({ err, runId: run.id }, "agent run: the provider's saved key cannot be opened (PROVIDER_KEY_SECRET changed, or the value was moved or damaged)");
        return { end: KEY_UNREADABLE };
      }
      if (!resolved) return { end: MODEL_GONE };
      // A reply somebody other than its owner called for: its own output at most `OTHERS.outputTokens`, at the effective level of the
      // owner's setting for such replies (`othersReasoning`; a reply nobody asked for: `proactiveReasoning`), the hold priced at it.
      if (bounded) resolved = boundedForOthers(resolved, config, othersWanted(agent, state.lane));
      // Whether its name part alone, typed, calls it there (mentions.ts `namePartCalls`: how a send would read it — no
      // message is read): then the system text names both ways it is called. Not for a reply nobody asked for, whose text
      // says nobody called it.
      const bare = group && state.lane !== "proactive" && (await namePartCalls(t, run.conversationId, agent.namePart, agent.id)) ? agent.namePart : null;
      // The model's learned ratio, read once for the run: the context is planned at it when it is above 1 (`planRatio`),
      // and step 3 corrects by it the input estimate settlement falls back on (never the hold).
      const key = ratioKey(resolved);
      const ratio = await readRatio(t, key);
      const planned = planRatio(ratio);

      // What it covered before taking on what was noted on it since its claim (kept: step 3 may hand that back). A told
      // reply takes on nothing noted on it: that stays noted, for its follow-up to answer as an ordinary reply.
      const coveredBefore = Number(state.covers_seq ?? 0);
      // Nor does a new Agent's greeting: it answers no message of its owner's — one written meanwhile is answered by the
      // ordinary follow-up after it (so a greeting's quiet end never hides a question).
      const keepsNoted = told !== null || state.greets;
      const covers = keepsNoted ? coveredBefore : Math.max(coveredBefore, Number(state.pending_seq ?? 0));
      if (!keepsNoted) await t.query("update agent_runs set covers_seq = $2, pending_seq = null where id = $1", [run.id, covers]);
      const owner = await t.query<{ display_name: string }>("select display_name from principals where id = $1", [agent.ownerId]);
      const displayName = owner.rows[0]!.display_name;
      // What its Agent may be shown of its memory here (`notesFor`'s rules), read once with the rest, under the same locks.
      // An onboarding run (its own conversation, no persona yet) is shown none (`systemPrompt`), so none is read.
      // At most `MEMORY.passageShare` of the model's context goes to it: over that entries are left out (`fitNotes`).
      // A social run reads its place's notes (`loadNotes`, social: in ring 1a none at all, whatever the owner wrote; ring 1b decides what
      // this one person may be shown), never a group's.
      const found =
        place === "own" && agent.persona === ""
          ? null
          : await loadNotes(
              t,
              agent,
              place === "own" ? { place: "own" } : group ? { place: "group", conversationId: run.conversationId } : { place: "social", conversationId: run.conversationId, audienceId: state.caller_id! },
              config,
            );
      const notes = found === null ? NO_NOTES : fitNotes(found.notes, place, config.siteTimezone, displayName, passageBudget(resolved.contextTokens, resolved.call.maxOutputTokens, config.memory.passageShare), planned).notes;
      // A social run records what it was shown: the refs of the notes `fitNotes` kept (each note a visitor may be shown carries its ref),
      // and what was left out for want of a yes (`withheld`); written with the admission (step 3). Ring 1a: both always empty.
      const socialNotes = social && found !== null ? { shown: [...notes.owner, ...notes.self].flatMap((n) => ("ref" in n ? [(n as { ref: ShownNote }).ref] : [])), withheld: found.withheld } : null;
      // What the web search's offer says of the reply (the product owner's rules, lane websearch2): a reply of an Agent
      // whose `webSearch` is on may have it, in every lane and on every model (a provider model's searches are paid from
      // its owner's points, tools/web/hold.ts); the toolbox adds it only while the site offers it, to a reply offered tools
      // at all (below: never a greeting, a told reply, a model that cannot use them), and `web` is what its system text
      // says of it then.
      const mayWeb = agent.webSearch;
      let web: WebPrompt | undefined;
      // The language the message being answered is written in (lane lang), decided once here from that message and handed to
      // the system text as its code only: set below, for a reply offered tools that answers a call.
      let replyLanguage: ReplyLanguage | undefined;
      // A run still proactive when it starts (its stored lane: a mention that took it over changed it) is told nobody called it.
      // The system text with the run's mark and, in a group, its roster of who is there with those who spoke: a group's
      // carries both; the Agent's own conversation has neither (it says what to call the owner, if they set that). A reply
      // offered tools (`tools`) is not told it has none; one offered none is, as always.
      const system =
        (offered: boolean) =>
        (mark: string, speakers: readonly Speaker[]): SystemText => {
          const tools: ToolsPrompt = offered && web !== undefined ? { web } : offered;
          const text = scene
            ? groupSystemText({ ...agent, bare }, { displayName }, withRoster(scene, speakers), now, config.siteTimezone, mark, state.lane === "proactive", notes, told === null ? tools : "told", replyLanguage)
            : socialScene
              ? socialSystemText(agent, socialScene.owners, socialScene.other, now, config.siteTimezone, mark, notes, tools, replyLanguage)
              : systemText(agent, { displayName }, now, agent.persona === "" ? "onboarding" : "normal", config.siteTimezone, notes, tools, replyLanguage);
          // A new Agent's first reply greets its owner in its own words (`greets`): the fixed instruction last.
          if (state.greets && place === "own") return { text: `${text.text}\n\n${GREETING_LINE}`, rest: `${text.rest}\n\n${GREETING_LINE}`, passage: text.passage };
          // What a reply `告诉他们` queued is to tell, after the rest (measured with it: `rest`).
          if (told === null) return text;
          const passage = toldPassage(told);
          return { text: `${text.text}\n\n${passage}`, rest: `${text.rest}\n\n${passage}`, passage: text.passage };
        };
      // In a group, at most `AGENT_GROUP_CONTEXT_TOKENS` of its latest `GROUP_CONTEXT_MESSAGES` messages are shown, and
      // nothing at or before its asker's line (`askerLine`, Task 10b) but the calls it answers (`callsSeen`), read once,
      // here, for the whole run. First, whoever it will hear from beyond what it was asked — everyone who wrote since
      // what it covered before taking on what was noted above, those calls included — is recorded among its askers
      // (runs.ts `hearFrom`, fix round 2), so the line counts them, and so does whatever it hands down.
      // (A told reply hears nobody beyond what it covers: it is shown nothing later, `upTo` below.)
      if (group && told === null) await hearFrom(t, run.id, coveredBefore, null);
      // A social run has no asker's line: the Agent is shown the whole conversation it can see (`after` 0), up to the weight a social
      // reply is shown (`OTHERS.contextWeight`), and the calls it answers.
      const line = group ? await askerLine(t, run.id) : 0;
      const calls = away ? await callsSeen(t, agent.id, run.id, line) : [];
      if (away && calls.length === 0 && told === null) return { end: NOTHING_LEFT };
      const cap = group
        ? { maxTokens: config.agentGroupContextTokens, maxMessages: GROUP_CONTEXT_MESSAGES, after: line, calls }
        : social
          ? { maxTokens: config.others.contextWeight, maxMessages: GROUP_CONTEXT_MESSAGES, after: 0, calls, place: "social" as const }
          : null;
      // The pair's summary and what of it may be shown, read once for every plan below (round 2, N-4: two indexed reads at
      // most, nothing of the conversation's history), here, under the row its job writes it under.
      // No summary in a social conversation (none is made there: summary/job.ts): nothing of one is shown.
      const summary = social ? { stored: null, shown: null } : await readPairSummary(t, { agentId: agent.id, ownerId: agent.ownerId, conversationId: run.conversationId, group }, config.memory.summaryMaxWeight);
      const plan = {
        agentId: agent.id,
        ownerId: agent.ownerId,
        conversationId: run.conversationId,
        coversSeq: covers,
        group: cap,
        planRatio: planned,
        summary,
        // A told reply is shown the group up to what it covers: a call noted on it since is its follow-up's.
        ...(keepsNoted ? { upTo: covers } : {}),
      };
      // The tools the reply is offered, decided in this order: none for a reply `告诉他们` queued (`told`); none while
      // `TOOLS.enabled` is false; none for a model that
      // cannot use them (`Resolved.tools`: its configuration, or its owner's list); none without a toolbox, or when it
      // offers none; then what they take of the context — their definitions at the plan's ratio, as tools' text is planned
      // (`TOOL_TEXT_FACTOR`), and what providers add around them, reserved as the system text is — and room for what they
      // bring back (below).
      // (A social run is offered the tools scoped to its conversation alone: `RunScope.place`.)
      let offer: Offer | null =
        told === null && !state.greets && config.tools.enabled && resolved.tools && this.deps.toolbox ? this.deps.toolbox.offer(run, mayWeb ? { place, web: true } : { place }) : null;
      if (offer !== null && offer.tools.length === 0) offer = null;
      web = offer?.web;
      // Only a reply offered tools says its language (`REPLY_LANGUAGE`), and not one nobody called for. The message answered: in
      // the Agent's own conversation its owner's latest at or before what the run covers; in a group the latest call it answers.
      if (offer !== null && state.lane !== "proactive") {
        const answered = await t.query<{ text: string | null }>(
          away
            ? "select body ->> 'text' as text from messages where conversation_id = $1 and seq = $2"
            : "select body ->> 'text' as text from messages where conversation_id = $1 and sender_id = $3 and kind in ('text', 'file') and (body -> 'fixed') is distinct from 'true'::jsonb and seq <= $2 order by seq desc limit 1",
          away ? [run.conversationId, calls[calls.length - 1] ?? 0] : [run.conversationId, covers, agent.ownerId],
        );
        replyLanguage = detectLanguage(answered.rows[0]?.text ?? "") ?? undefined;
      }
      // A reply offered tools numbers the files its context labels (`[文件 〔f1〕：name]`), so that its file tool can name
      // them and its text cite them (tools/refs.ts) — afresh for each plan, and in a plan only those of the messages it can
      // show (context.ts `loadContext`), past any number someone typed in what it is shown; one offered none is shown them
      // as always. One offered the web search reads `〔w1〕` too (its numbers' letter, refs.ts).
      /**
       * One plan: offered tools (`numbered`), with numbers made afresh — and, in the Agent's own conversation, its earlier
       * replies' calls to a tool this reply is offered returning with them (`ContextRun.replay`; harness design §3) —; else
       * with none.
       */
      const planOf = async (numbered: boolean, reserved: number): Promise<{ loaded: LoadedContext; refs: RunRefs | null }> => {
        const refs = numbered ? new RunRefs({}, web === "offered") : null;
        const replay = refs !== null && place === "own" && offer !== null ? { replay: { tools: new Set(offer.tools.map((tool) => tool.name)), timeZone: config.siteTimezone, maxCalls: maxCallsOf(config.tools) } } : {};
        return { loaded: await loadContext(t, { ...plan, reserved, ...(refs ? { refs } : {}), ...replay }, resolved, system(refs !== null), this.deps.drawMark), refs };
      };
      const definitions = offer === null ? 0 : estimateTokens(JSON.stringify(offer.tools), planned * TOOL_TEXT_FACTOR) + TOOL_PREAMBLE_TOKENS;
      let reserved = definitions;
      let { loaded, refs } = await planOf(offer !== null, reserved);
      if (refs !== null && holdsNewest(loaded.entries, loaded.budget, loaded.planRatio)) {
        // And room for what the tools bring back, from what that plan gives the conversation (`resultReserve`), with
        // the last call's line: reserved as the definitions are.
        reserved = definitions + estimateTokens(`\n\n${FINAL_LINE}`, planned) + resultReserve(config.tools.resultMaxWeight, planned, loaded.budget);
        ({ loaded, refs } = await planOf(true, reserved));
      }
      if (refs !== null && !holdsNewest(loaded.entries, loaded.budget, loaded.planRatio)) {
        // With the tools reserved the conversation would not get the room a call needs at least: none are offered, and
        // the reply is planned, and made, as one that offers none (its system text saying so).
        offer = null;
        reserved = 0;
        ({ loaded, refs } = await planOf(false, 0));
      }
      // An others' reply is offered tools only when the room its owner's numbers leave covers the hold with them (plan B7c, D11): the
      // plan's own texts and the tools' definitions through `othersHold` with B2b's room, read without a lock — step 3 decides exactly. Else
      // it is planned, and made, as one that offers none (one call).
      if (offer !== null && bounded && resolved.price !== undefined && resolved.price !== null) {
        const texts = [loaded.system.text, ...loaded.entries.map((e) => e.text), JSON.stringify(offer.tools)];
        const heldTokens = holdTokens(texts, resolved.contextTokens, resolved.call.maxOutputTokens) + TOOL_PREAMBLE_TOKENS;
        const roomCap = Math.max(0, resolved.contextTokens - resolved.call.maxOutputTokens) + TOOL_PREAMBLE_TOKENS;
        const growth = roomGrowth(config.others.toolCalls, config.tools.resultMaxWeight, resolved.call.maxOutputTokens) + config.others.overCapNotes * noteBytes(longestToolName(offer.tools));
        const needed = othersHold(resolved, heldTokens, { growthTokens: growth, roomCapTokens: roomCap });
        if ((await othersRoomAdvisory(t, config, run.ownerId, agent.id, state.lane as OthersLane, now)) < needed) {
          log.info({ metric: "others_plain_fallback", from: "advisory" }, "agent run: an others' reply made without tools: the room its owner's number leaves does not cover the hold with them");
          offer = null;
          reserved = 0;
          ({ loaded, refs } = await planOf(false, 0));
        }
      }
      // A new Agent's greeting before its owner has written: the one turn it is shown is what is so (`GREETING_TURN`).
      if (state.greets && place === "own" && !hasOwnerTurn(loaded)) loaded.entries.push({ role: "user", text: GREETING_TURN, attachment: null });
      if (!hasOwnerTurn(loaded)) return { end: loaded.topicStart > 0 && covers <= loaded.topicStart ? STARTED_OVER : BUSY };
      if (!holdsNewest(loaded.entries, loaded.budget, loaded.planRatio)) return { end: TOO_SMALL };
      // A reply offered tools also carries the text a reply offered none is sent (the same mark and roster), for whenever
      // its tools are not sent: an upstream that refuses them, or the ordinary call after a later round it refused
      // (`ModelCall.systemWithoutTools`). Its plan holds it: the tools' definitions it leaves out are larger.
      const withoutTools = offer === null ? null : system(false)(loaded.mark ?? "", loaded.speakers).text;
      // How far its conversation has come, read under its row's lock: everyone who wrote up to here is heard (`hearFrom`
      // above), and its tools show it nothing later (`RunScope.heardTo`).
      const heard = offer === null ? null : await t.query<{ seq: string }>("select seq::text from conversations where id = $1", [run.conversationId]);
      // A reply offered the web search keeps what it was shown of its notes and hearsay for its query guard (tools/web).
      // And whether a call it answers is one its owner WROTE (review M6; review 5, item 7): only then do the owner's typed words exempt a
      // query — never for a reply that is the owner's own only by their 重试 of someone else's call, nor for a relay. In the Agent's own
      // conversation every reply answers what its owner wrote.
      const ownerWrote = offer?.web !== "offered" ? false : place === "own" ? state.lane === "own" && state.triggered_by === "human" : await ownerWroteACall(t, run.id);
      const shown = offer?.web === "offered" ? { shown: shownTexts(notes), ownerAsked: ownerWrote } : {};
      const tools = heard === null || refs === null ? null : { refs, heardTo: Number(heard.rows[0]?.seq ?? 0), ...shown };
      return { basis: basisOf(state, covers), resolved, loaded, covers, coveredBefore, key, ratio, offer, reserved, withoutTools, tools, told: told !== null, bounded, social: socialNotes };
    });
    if ("end" in first) return first.end === HELD_BACK && first.queued ? this.heldBack(run, first.queued, mine) : first.end;

    const deadline = AbortSignal.timeout(config.agentRunTimeoutMs);
    let context: BuiltContext;
    try {
      context = await buildContext(blobs, first.loaded, first.resolved, log, {
        signal: closing ? AbortSignal.any([closing, deadline]) : deadline,
        stop: () => this.shouldStop(run),
      });
    } catch (err) {
      if (closing?.aborted) throw closing.reason;
      if (!deadline.aborted && !(err instanceof BlobStoreDown)) throw err;
      log.error({ err, runId: run.id }, "agent run: its attachments could not be read");
      return BUSY;
    }
    if (closing?.aborted) throw closing.reason;

    const result = await db.tx(async (
      t,
    ): Promise<{ end: RunEnd; told?: Told; queued?: Announced } | { stale: true } | { prepared: Prepared; read: number | null; money: RunMoney; wasMarked: boolean }> => {
      const { agent, state } = await this.lockRun(t, run);
      const halted = this.halted(run, agent, state);
      if (halted) return { end: halted };
      // ADMISSION (fix round 4, R3). The terms a reply is made on — its model and level, its output limit, its tool caps, the hold
      // and the numbers it is counted against — are decided ONCE, here, from the row as it is NOW, under its locks (the
      // conversation's, the Agent's and the run's: `lockRun`; every writer of a run's calls holds the Agent's row) and, in
      // `admitRun`, its owner's account lock. Step 1 prepared a plan for whoever the reply was then; the attachments were read with
      // no lock. So first the calls are held to the access decision once more (`dropRefusedCalls`: a block since), and then the row
      // is compared with what the plan was made for (`basisOf`: its lane, its caller, the calls it answers). Any difference: the
      // plan is STALE — nothing of it is sent, nothing is held — and `begin` makes a new one from the row (`STALE_PLAN`).
      // BOUNDARY: once `admitRun` below has written the hold, the run's lane, caller and money terms are FROZEN. A later ending of
      // access never rewrites them and never requeues the reply (its calls would be made, and charged, twice): it is ended as a
      // whole when no call it answers is left (social/agent-contacts.ts `endGroupCalls`, `standingCalls`), else it goes on, and
      // its post leaves out whoever is refused by then (`postAsAgent`).
      if (this.flags.get(run.id)?.place === "group" && !first.told) {
        const kept = await dropRefusedCalls(t, run.id, agent.ownerId);
        if (kept === null) return { end: BLOCKED_SINCE };
        Object.assign(state, kept);
      }
      if (!sameBasis(first.basis, basisOf(state, first.covers))) {
        if (first.covers > first.coveredBefore) await this.handBack(t, run.id, first.coveredBefore, first.covers);
        log.info({ metric: "stale_plan" }, "agent run: whose reply it is changed while it was prepared; its plan is made again");
        return { stale: true };
      }
      // A social run: its visitor may still reach the Agent now, after the attachments were read outside any transaction (B-4 review m1).
      if (this.flags.get(run.id)?.place === "social" && (await runAccess(t, agent, state, this.deps.config)) !== "ok") return { end: ACCESS_ENDED };
      // Too late to start (it crossed the bound while its attachments were read): what step 1 took on is handed back as
      // noted, as a refusal hands it back, so its follow-up rule answers it.
      if (this.tooLate(state)) {
        if (first.covers > first.coveredBefore) await this.handBack(t, run.id, first.coveredBefore, first.covers);
        return { end: RETRY_TOO_LATE };
      }
      // The service may have started closing while this waited for the locks: then nothing is admitted (thrown, so the
      // transaction rolls back) and the run is left running, unadmitted, for the caller to end (the worker: `release`).
      if (closing?.aborted) throw closing.reason;
      // What its lane is held to, once more: replies settled while it waited count now, and its owner may have turned a
      // reply nobody asked for off. Refused, what step 1 took on (noted on it after its claim — its owner's mention, say)
      // is handed back as noted, so `finish`'s follow-up answers it by the usual rule: its owner's own is queued; someone
      // else's meets the others' budget again and is simply not queued (no second notice that day), so nothing loops.
      const told = refusedAtAdmission(agent, state.lane);
      if (told) {
        if (first.covers > first.coveredBefore) await this.handBack(t, run.id, first.coveredBefore, first.covers);
        return { end: ENDED_QUIETLY, told };
      }
      const { resolved, loaded, covers, key, ratio, offer, reserved, withoutTools, bounded } = first;
      // The tools the reply is offered (step 1); none after a plain admission (below).
      let tools = offer?.tools ?? [];
      // What admission holds for the input: the most it can cost — its text at its utf-8 bytes, at most what the context
      // leaves beside the output limit (`holdTokens`), images and PDFs at their constants — whatever the model's ratio.
      // Offered tools go with the call too: their definitions are held at their bytes as well, and what providers add
      // around them. Every part is held at the bytes of the text the plan weighed it as (`partText`): an earlier reply's
      // replayed calls and results with the rest, once, and never among the images' and PDFs' constants.
      const messageTexts = context.messages.flatMap((m) => m.parts.flatMap((p) => partText(p) ?? []));
      const texts = [loaded.system.text, ...messageTexts];
      const held =
        tools.length === 0
          ? holdTokens(texts, resolved.contextTokens, resolved.call.maxOutputTokens) + context.fixedTokens
          : holdTokens([...texts, JSON.stringify(tools)], resolved.contextTokens, resolved.call.maxOutputTokens) + TOOL_PREAMBLE_TOKENS + context.fixedTokens;
      // The input as the model is expected to count it: its text times the model's learned ratio (1 until it has learned;
      // read in step 1), images and PDFs at their constants. What settlement falls back on when no usage is reported.
      const input = correctedEstimate(context.inputTokensEstimate, context.fixedTokens, ratio);
      // On the free allowance a reply offered tools holds room for its last call too (admit.ts): what a last call after one
      // more round can cost — this call's input bound and what one round can add (`roomGrowth`), never more than one call
      // of its model can carry (its context beside its output limit, what providers add around tool definitions, its images
      // and PDFs) — and its whole output. Renewed a round at a time (`extend`).
      const roomCapTokens = Math.max(0, resolved.contextTokens - resolved.call.maxOutputTokens) + TOOL_PREAMBLE_TOKENS + context.fixedTokens;
      // (A tool offered with no cap of its own has only the round cap: what one round brings back is not bounded below the
      // whole of a call, so the room is that.)
      // An others' reply (plan B2b) has one real call and at most `OTHERS.overCapNotes` notes, in one tool round: what its last call
      // can add to the next input is one result and those notes, each at the longest answer a call past the first can get
      // (`noteBytes`). It replaces the per-tool caps' sum, and nothing is raised after admission (`extend`).
      const growthTokens =
        offer === null
          ? 0
          : bounded
            ? roomGrowth(config.others.toolCalls, config.tools.resultMaxWeight, resolved.call.maxOutputTokens) +
              config.others.overCapNotes * noteBytes(longestToolName(offer.tools))
            : offer.tools.every((tool) => Object.hasOwn(offer.perTool, tool.name))
              ? roomGrowth(Object.values(offer.perTool).reduce((sum, n) => sum + n, 0), config.tools.resultMaxWeight, resolved.call.maxOutputTokens)
              : roomCapTokens;
      // An others' reply's hold is `othersHold` (call 1 and its last call), the one definition; what `admit` is given as the last-call
      // part is what it adds to call 1's.
      const lastCall =
        tools.length === 0
          ? 0n
          : bounded
            ? othersHold(resolved, held, { growthTokens, roomCapTokens }) - maxCostMicro(resolved, held)
            : maxCostMicro(resolved, Math.min(held + growthTokens, roomCapTokens));
      // What an others' reply offered tools holds if its with-tools hold does not fit its owner's number (`admit`, N3): the one
      // call it then makes without them — the text for going without them and the same messages — at its most.
      const plainMicro =
        tools.length === 0 || withoutTools === null || !bounded
          ? null
          : maxCostMicro(resolved, holdTokens([withoutTools, ...messageTexts], resolved.contextTokens, resolved.call.maxOutputTokens) + context.fixedTokens);
      let admission;
      try {
        // (The day its owner's numbers are read for is the day it is under the account lock, not the day `begin` started on.)
        admission = await admitRun(t, config, run.id, run.ownerId, resolved, held, () => new Date(), lastCall, plainMicro);
      } catch (err) {
        if (err instanceof OthersLimit) {
          // Its owner's number is reached (answers or points) with nothing running to wait for: no call, nothing held or charged.
          // What step 1 took on is handed back as noted (as above); the conversation is told once a site day (`limitNotice`),
          // the Agent pushed to its owner; a reply nobody asked for tells nobody.
          if (first.covers > first.coveredBefore) await this.handBack(t, run.id, first.coveredBefore, first.covers);
          const told = noneTold();
          // The group is told 「今天只回复它的主人」 only when that is true: every reply for others would be refused (`agentRoom`'s `reached`,
          // the fact the owner's page shows), not because this one call, at its size and level, did not fit.
          if (state.lane === "others" && (await agentRoom(t, config, agent, new Date())).reached) {
            const notice = await limitNotice(t, run.conversationId, agent.id, siteToday(config));
            if (notice) {
              told.notices.push(notice);
              told.budgetReached.push({ ownerId: agent.ownerId, agentId: agent.id });
            }
          }
          log.info({ metric: "others_limit_refused", limit: err.limit }, "agent run: an owner's number for others' use is reached; it ends quietly");
          return { end: ENDED_QUIETLY, told };
        }
        if (err instanceof HeldBack) {
          // Back to `queued`, under the account lock admission still holds, so none of the calls it waits for can have
          // ended unseen (each leaves `running` in a transaction that takes that lock): `claimNext` passes it over until
          // one of them has, and the owner's younger replies on the same source behind it. What step 1 took on (noted on it
          // after its claim — its owner's mention, say) is handed back as noted, as a refusal hands it back: its next
          // `begin` takes it on again, and should that attempt be refused its owner's call is still followed up.
          await t.query(
            `update agent_runs set status = 'queued', started_at = null, held_back_by = $2::uuid[], held_back_on = $3,
                    covers_seq = case when $5::bigint > $4::bigint then $4::bigint else covers_seq end,
                    pending_seq = case when $5::bigint > $4::bigint then greatest(coalesce(pending_seq, 0), $5::bigint) else pending_seq end
              where id = $1`,
            [run.id, err.behind, err.on, first.coveredBefore, first.covers],
          );
          const queued = await t.query<RunRow>(`select ${RUN_COLUMNS} from agent_runs r where r.id = $1`, [run.id]);
          if (bounded) log.info({ metric: "others_held_back" }, "agent run: an others' reply waits for its owner's other replies to end");
          return { end: HELD_BACK, queued: { ownerId: run.ownerId, conversationId: run.conversationId, run: toWireRun(queued.rows[0]!) } };
        }
        if (!(err instanceof AppError) || err.code !== "no_quota") throw err;
        const resetsAt = err.details.resetsAt;
        return { end: { status: "failed", error: "no_quota", ...(typeof resetsAt === "string" ? { resetsAt } : {}) } };
      }
      // Admitted plain (N3): its with-tools hold did not fit, its one-call hold did — it makes one call without the tools it was
      // offered, as a reply whose tools the upstream refused does (`others_plain_fallback`).
      if (admission.plain) {
        log.info({ metric: "others_plain_fallback", from: "admission" }, "agent run: an others' reply made without tools: only its one-call hold fit its owner's number");
        tools = [];
      }
      // What a social reply was shown of its owner's notes, and what was left out for want of a yes: written with the admission, in this
      // transaction (null when empty, also over an earlier attempt's). Ring 1a: both always empty.
      if (first.social !== null) {
        await t.query("update agent_runs set shown_notes = $2::jsonb, withheld_notes = $3::jsonb where id = $1", [
          run.id,
          first.social.shown.length > 0 ? JSON.stringify(first.social.shown) : null,
          first.social.withheld.length > 0 ? JSON.stringify(first.social.withheld) : null,
        ]);
      }
      // What settlement learns the ratio from: the estimate at ratio 1 of a call that showed text only (an image's or a
      // PDF's real tokens are not text's), and the ratio's key. A reply that offers tools teaches nothing: its rounds send
      // the tools and the steps, which the estimate does not count, and settle on their summed usage.
      await t.query("update agent_runs set input_estimate = $2, ratio_key = $3 where id = $1", [
        run.id,
        context.fixedTokens === 0 && tools.length === 0 && !admission.plain ? context.inputTokensEstimate : null,
        key,
      ]);
      // An automatic retry is counted as run once it is admitted: its call is made now (not at its claim).
      if (state.auto_attempt > 0) log.info({ metric: "auto_retry_ran", attempt: state.auto_attempt }, "agent run: an automatic retry was admitted");
      const marked = await markRead(t, agent.id, run.conversationId, covers);
      const reasoning = resolved.reasoning;
      const planned = planRatio(ratio);
      // An acknowledgement already stands for what it answers (an earlier attempt's: a retry): it posts none. (A reply for others: what
      // it took of the one budget of text is read at the post, `RunFlags.othersText`.)
      const standing = tools.length > 0 ? await standingAcknowledgement(t, run.conversationId, run.agentId, run.id) : null;
      const acknowledged = standing !== null;
      return {
        prepared: {
          call: {
            ...resolved.call,
            system: admission.plain && withoutTools !== null ? withoutTools : loaded.system.text,
            ...(tools.length > 0 && withoutTools !== null ? { systemWithoutTools: withoutTools } : {}),
            messages: context.messages,
            reasoning,
          },
          inputChars: input,
          tools,
          toolRun:
            offer === null || tools.length === 0
              ? null
              : {
                  perTool: offer.perTool,
                  // An others' reply: one real call, three notes, one tool round (plan B2a).
                  ...(bounded ? { callsCap: config.others.toolCalls, overCapNotes: config.others.overCapNotes } : {}),
                  kinds: offer.kinds,
                  acknowledged,
                  contextTokens: resolved.contextTokens,
                  fixedTokens: context.fixedTokens,
                  ratio,
                  planRatio: planned,
                  planned: correctedEstimate(context.inputTokensEstimate, context.fixedTokens, planned),
                  // The plan's limit: the system text, the reservation (step 1) and the conversation's budget before a
                  // group's cap — what the rounds may fill is what is left of it.
                  limit:
                    systemTokens(loaded.system, planned) +
                    reserved +
                    contextBudget(resolved.contextTokens, resolved.call.maxOutputTokens, loaded.system, planned, reserved),
                },
        },
        read: marked && marked.readSeq > marked.previous ? marked.readSeq : null,
        money: { price: resolved.price ?? null, maxOutputTokens: resolved.call.maxOutputTokens, reserveMicro: admission.reserveMicro ?? 0n, roomCapTokens, growthTokens },
        wasMarked: state.marked,
      };
    });
    if ("stale" in result) return STALE_PLAN;
    if ("end" in result) {
      // Held back: its owner is told it is queued again (the other members of a group, told it is replying, nothing more);
      // this attempt's flags go, unless a later attempt has flags of its own already; it is counted.
      if (result.end === HELD_BACK && result.queued) {
        log.info({ metric: "run_held_back" }, "agent run: held back until a call of its owner ends");
        return this.heldBack(run, result.queued, mine);
      }
      // The others' daily budget's notice, if the admission's refusal appended it, goes to the group; the Agent to its owner.
      if (result.told) this.tell(result.told);
      return result.end;
    }
    // Admitted after it was held back: the owner's younger replies its mark kept waiting may be claimed now.
    if (result.wasMarked) this.wakeWorker();
    if (result.read !== null) this.deps.reads.publish({ conversationId: run.conversationId, principalId: run.agentId, seq: result.read }, log);
    // The mark the call carries is the one `post` takes out of the reply.
    const flags = this.flagsOf(run.id);
    flags.mark = first.loaded.mark;
    flags.money = result.money;
    flags.leftOut = first.loaded.leftOut;
    flags.othersText = first.bounded ? { most: weightWithin(config.others.outputTokens, first.ratio) } : null;
    const { resolved } = first;
    flags.model = resolved.source === "site" ? { source: "site", id: resolved.name } : { source: "provider", providerId: resolved.providerId!, name: resolved.name, toolsUnknown: resolved.toolsUnknown === true };
    // In its own conversation, where what its call shows begins (`RunScope.shownFrom`): known once its context is built.
    flags.tools = result.prepared.tools.length > 0 && first.tools !== null ? { ...first.tools, shownFrom: flags.place !== "own" ? null : context.shownFrom } : null;
    return result.prepared;
  }

  emit(run: RunTicket, delta: Delta): void {
    // Checked now and again when the hub delivers it, against the flags it was emitted under: once the pause, delete or
    // removal from the run's group has answered, no delta goes out, however late it is delivered. A run that has
    // finished emits nothing, and a run in a group never does (to nobody, its owner included).
    const flags = this.flags.get(run.id);
    if (!flags || flags.silenced || flags.place !== "own") return;
    this.deps.realtime.pushDelta(run.ownerId, run.conversationId, run.id, delta, () => !flags.silenced);
  }

  /**
   * `AgentPort.tool`: through the toolbox that offered the tool (`begin`), for the run's scope as `begin` set it; with no
   * toolbox, or for a run this process did not begin with tools, nothing was offered and nothing runs.
   */
  tool(run: RunTicket, call: ToolCall, signal: AbortSignal): Promise<ToolOutcome> {
    const box = this.deps.toolbox;
    const flags = this.flags.get(run.id);
    if (!box || !flags?.tools) return Promise.reject(new Error("no tool is offered to this run"));
    const { shown, ownerAsked } = flags.tools;
    // A reply offered the web search: what it was shown and whose call it answers (its query guard), its pre-hold (`holdSearch`).
    const web = shown === undefined ? {} : { shown, ownerAsked: ownerAsked === true, holdSearch: () => this.holdSearch(run) };
    const scope: RunScope = { ...run, place: flags.place, refs: flags.tools.refs, heardTo: flags.tools.heardTo, mark: flags.mark, shownFrom: flags.tools.shownFrom, ...web };
    return box.run(scope, call, signal);
  }

  /**
   * The web search's pre-hold (lane websearch; tools/web/hold.ts `holdSearch`), in one transaction under `lockRun` (the
   * run's conversation row, its Agent's, its own), then the account and the site's money fuse: what the fuse held when the
   * search is counted, its price held and recorded on the run — before the engine is called, so it stands whatever happens
   * after — else why not, in plain words (the transaction rolled back, nothing counted). 80 % of the site's fuse crossed
   * by it is said once it has committed (`fuseLine`). A run this process did not admit, or one no longer running, is refused.
   */
  private async holdSearch(run: RunTicket): Promise<string | HeldSearch> {
    const money = this.flags.get(run.id)?.money;
    if (!money) return WEB_NO_MONEY;
    const { db, config } = this.deps;
    try {
      const held = await db.tx(async (t) => {
        const { agent, state } = await this.lockRun(t, run);
        return preHoldSearch(t, config, { run, agent, lane: { lane: state.lane, coversSeq: Number(state.covers_seq ?? 0) }, reserveMicro: money.reserveMicro }, new Date());
      });
      if (held.at80) fuseLine(this.deps.log);
      return held;
    } catch (err) {
      if (err instanceof SearchRefused) {
        // Which bound refused it: the operator's metric (a count, nothing of the search), so what bites shows in the log.
        const metric = REFUSED_METRIC[err.by];
        if (metric !== null) this.deps.log.info({ metric }, "web search: refused before the engine was called");
        return err.why;
      }
      if (err instanceof RunNotRunning) return WEB_UNAVAILABLE;
      throw err;
    }
  }

  /**
   * `AgentPort.extend`, in one transaction under `lockRun` (the run's conversation row and its Agent's, then the run's;
   * the account's after, as admission takes them): a run no longer running answers "stop". At the site model's price as
   * `begin` resolved it (`RunMoney`), what the reply has cost so far is `spent` when it is two counts, else `estimated` —
   * what settlement would charge now, before its cap — and the most the next call can cost is `nextInputTokens` (the
   * worker's bound of everything that call sends — the last call's line, every step and the tools' definitions included —
   * whichever call it is: tool round or last) and the whole output limit. In this order:
   * 1. a budget of the run's lane reached by what it has cost so far (runs.ts `budgetReachedWith`: the others' daily,
   *    the proactive daily, the chain budget) makes the answer at most "final";
   * 2. so far and the next call's most within `TOOLS.maxPoints` (its searches at what they are charged), step 1 not
   *    reached, the raise fitting beside every promise on the owner's pots and the reply holding nothing over (admit.ts
   *    `raiseHold`, the pool): the model's part of the hold raised to that — "ok";
   * 3. else that part raised to so far and the next call's most, past what is left if it must, also below zero — "final":
   *    a reply that has started is never refused for money (Task H); short of it, it only stops calling tools.
   * "stop" only for a run no longer running, or one this process did not begin. A hold is never lowered. A provider's model costs nothing: nothing is held, and the answer is "ok", or "final" once a
   * budget of its lane is reached with the web searches it held (its rounds and its context bound it otherwise, in the worker).
   */
  async extend(run: RunTicket, spent: Usage | null, estimated: Estimated, nextInputTokens: number): Promise<"ok" | "final" | "stop"> {
    assertCount("extend: estimated.inputChars", estimated.inputChars);
    assertCount("extend: estimated.outputChars", estimated.outputChars);
    assertCount("extend: nextInputTokens", nextInputTokens);
    const money = this.flags.get(run.id)?.money;
    // A run this process did not begin: nothing more is called for it.
    if (!money) return "stop";
    const { db, config } = this.deps;
    try {
      return await db.tx(async (t) => {
        const { agent, state } = await this.lockRun(t, run);
        // Between two rounds: a tool round has completed — the reply has done something (recovery reads it, `progressed`).
        await t.query("update agent_runs set progressed = true where id = $1 and not progressed", [run.id]);
        const lane = { conversationId: run.conversationId, lane: state.lane, coversSeq: Number(state.covers_seq ?? 0) };
        const row = (
          await t.query<{ charge_to: ChargeTo | null; hold: string; web: string; web_charge: string }>(
            "select charge_to, hold_micro::text as hold, web_micro::text as web, web_charge_micro::text as web_charge from agent_runs where id = $1",
            [run.id],
          )
        ).rows[0]!;
        // What its searches are charged so far (tools/web/hold.ts: their actual once the engine said it, else their price).
        const searchedCharge = BigInt(row.web_charge);
        // A provider's model costs nothing but the searches its tool held: those count with its lane. An others' reply has had its
        // one tool round: the next call is its last, whatever the money says (plan B2a).
        if (money.price === null || row.charge_to === null) return state.lane !== "own" ? "final" : (await budgetReachedWith(t, lane, agent, searchedCharge)) ? "final" : "ok";
        const reported = spent !== null && isCount(spent.inputTokens) && isCount(spent.outputTokens);
        const cost = costMicro(money.price, reported ? spent.inputTokens : estimated.inputChars, reported ? spent.outputTokens : estimated.outputChars);
        const held = BigInt(row.hold);
        // The web searches its tool held, at their price (tools/web/hold.ts): a part of the hold of their own, apart from the
        // model's, which is what is raised here (0 for a reply that made none: every number as before).
        const searched = BigInt(row.web);
        // The room kept for a last call on `AB` (`RunMoney.reserveMicro`): this call is within it.
        const reserve = row.charge_to !== "memory" && keepsRoom(classOf(row.charge_to), state.lane) ? money.reserveMicro : 0n;
        // So far is at most what the reply held for its calls: each was held at its most before it was made, so a round
        // reported above that is the upstream's error — forgiven at settlement, never held for.
        const modelHeld = held - reserve - searched > 0n ? held - reserve - searched : 0n;
        const sofar = cost < modelHeld ? cost : modelHeld;
        const next = costMicro(money.price, nextInputTokens, money.maxOutputTokens);
        // An others' reply: its hold, taken whole at admission — its first call and its last, the latter at the most a one-round
        // reply can add to its input (`othersGrowth`, `begin`) — covers every request it can make, the tool-less finish after
        // a discard or a refused round included. Nothing is raised here; the tool phase has ended, so the answer is "final". What
        // the next call can cost beside what the reply has cost so far passing what is held would be a bug, and is counted.
        if (state.lane !== "own") {
          // What the hold covers of the model: call 1 and the last call (`held` less the searches' part).
          const covered = held - searched > 0n ? held - searched : 0n;
          const raise = sofar + next > covered ? sofar + next - covered : 0n;
          if (raise > 0n) this.deps.log.warn({ metric: "others_round_raise" }, "agent run: an others' reply's next call could cost more than its hold; the hold is not raised");
          // The number the raise would have to fit (0: what the hold covers is what the two calls can cost): asked all the same, under the account lock; the answer stays "final".
          await othersFits(t, config, { id: run.id, ownerId: run.ownerId, agentId: agent.id, lane: state.lane }, raise, "round", new Date());
          return "final";
        }
        // Another round must keep room for a last call after it: renewed from the next call's input bound and what one
        // round can add, at most the whole of a call (`roomGrowth`); short of it on `AB`, the next call is the last.
        const renewed =
          reserve === 0n ? 0n : costMicro(money.price, Math.min(nextInputTokens + money.growthTokens, money.roomCapTokens), money.maxOutputTokens);
        const tools =
          sofar + searchedCharge + next <= BigInt(config.tools.maxPoints) * MICRO_PER_POINT &&
          !(await budgetReachedWith(t, lane, agent, sofar + searchedCharge));
        const answer = await raiseHold(
          t,
          config,
          { id: run.id, ownerId: run.ownerId, chargeTo: row.charge_to },
          { ok: sofar + next + renewed, final: sofar + next },
          tools,
          new Date(),
        );
        if (answer === "ok") money.reserveMicro = renewed;
        return answer;
      });
    } catch (err) {
      if (err instanceof RunNotRunning) return "stop";
      throw err;
    }
  }

  /**
   * `AgentPort.activity`: the kind, or null, to the run's owner with the run, and in a group to every other current member
   * with the Agent's state (`Hub.pushActivity`) — in its own conversation and in a group alike, though nothing of a group's
   * reply streams. Dropped like a delta once the Agent's pause, delete or removal has silenced the run, also one still
   * waiting in the hub's queue; nothing for a run this process is not working on.
   */
  activity(run: RunTicket, activity: Activity | null): void {
    const flags = this.flags.get(run.id);
    if (!flags || flags.silenced) return;
    this.deps.realtime.pushActivity(run.conversationId, run.id, activity, () => !flags.silenced);
  }

  /**
   * `AgentPort.toolsUnusable`: the reply found its model unable to use tools (its upstream refused them, or it called them
   * garbled twice). A site model's configuration is the operator's and is never changed: one metric line names the model,
   * and nothing else is done. A provider's model is marked, in one transaction: `tools: false` on its owner's entry
   * (`markToolsOff`, the provider's row first: see there why it may come first), only when the entry does not say so
   * already — and only then a whisper (`TOOLS_OFF`, kind `tools_off`, no button) to its owner in the reply's
   * conversation (`createWhisper`, taking the conversation's row and then the Agent's for share, the whisper's row last),
   * pushed to them after commit; so its owner is told once per model, however many replies find it out at the same
   * moment. Where the whisper cannot be made (its owner or the Agent is no longer a member there, the Agent deleted) the
   * model is still marked, and nobody is told. Nothing for a run this process did not begin. Whatever turns tools off, the
   * next reply is offered none (`begin`), and is the reply it always was.
   */
  async toolsUnusable(run: RunTicket, _why: "refused" | "garbled"): Promise<void> {
    const model = this.flags.get(run.id)?.model;
    if (!model) return;
    const { db, log, realtime } = this.deps;
    if (model.source === "site") {
      log.info({ metric: "tools_refused_site", model: model.id }, "agent run: a site model could not use the tools");
      return;
    }
    const told = await db.tx(async (t) => {
      if (!(await markToolsOff(t, run.ownerId, model.providerId, model.name))) return null;
      return createWhisper(t, { conversationId: run.conversationId, ownerId: run.ownerId, agentId: run.agentId, kind: "tools_off", body: TOOLS_OFF }, log);
    });
    if (told) realtime.pushWhisper(told);
  }

  /**
   * `AgentPort.toolsWorked`: a tool call of the reply ran. Only for a provider's model whose entry said nothing of tools
   * when the reply began is anything done — then, once per reply, `tools: true` is stored on it (`markToolsOn`: only over
   * nothing, so its owner's word and a failure found meanwhile stay). Every other reply — a site model's, a model whose
   * entry says either — reads and writes nothing here. Nobody is told: its owner sees it on the model. Nothing of the
   * call is logged.
   */
  async toolsWorked(run: RunTicket): Promise<void> {
    const model = this.flags.get(run.id)?.model;
    if (!model || model.source !== "provider" || !model.toolsUnknown) return;
    model.toolsUnknown = false;
    await this.deps.db.tx((t) => markToolsOn(t, run.ownerId, model.providerId, model.name));
  }

  /**
   * `postAsAgent` in its own transaction, announced after commit; a reply that proposed a persona (and so superseded
   * the Agent's earlier open proposals) also tells the owner's sockets to look at the Agent's proposals again (`agent`;
   * never in a group, where nothing proposes). In a group the reply loses the run's mark — the port's own copy, kept from
   * `begin` (`RunFlags.mark`) — and, once posted, drops the proactive judgement waiting there (`deps.proactive`).
   * "refused" for the Agent's state or a mark on the run — paused, deleted,
   * out of the run's group (`agent_removed`), halted — and also when the run is no longer `running` (`RunNotRunning`:
   * another instance's recovery ended it while this one answered); `finish` then finds it ended and leaves it as that
   * recovery recorded it.
   */
  async post(run: RunTicket, out: Reply): Promise<"posted" | "refused" | "empty"> {
    return this.posting(run, out, "reply");
  }

  /**
   * `AgentPort.acknowledge`: what the reply said before it called a tool, posted at once as its acknowledgement
   * (`postAsAgent` "ack", in its own transaction), published after commit as any message of the Agent's — it calls
   * nobody — and, in a group, dropping the proactive judgement waiting there as the Agent's reply would. It cites
   * nothing: every token of its run is taken out (tools/refs.ts `takeCites`). Refused, or empty, as `post`. In a social conversation
   * nothing is posted and the answer is "refused": the text stays with the reply (see `posting`).
   */
  acknowledge(run: RunTicket, said: { text: string; reasoning: string }): Promise<"posted" | "refused" | "empty"> {
    return this.posting(run, { ...said, stopped: false, truncated: false }, "ack");
  }

  /**
   * `post` and `acknowledge`: `postAsAgent` with the run's mark and, for a reply offered tools, its numbers — the port's
   * own copies, kept from `begin` (`RunFlags`), never what the worker could hand it: its text and reasoning lose their
   * run's tokens, its text's kept beside it as citations — announced after commit, its refusals told apart.
   */
  private async posting(run: RunTicket, said: Reply, as: "reply" | "ack"): Promise<"posted" | "refused" | "empty"> {
    const flags = this.flags.get(run.id);
    // A social conversation has no acknowledgement MESSAGE. What the reply says before it calls a tool is kept as the beginning of the
    // one reply that is posted: "refused" is the answer that leaves the worker's stream alone (it restarts it on anything else) and sets
    // no stop flag (only the catch below does). If nothing follows the tool round, that text is the reply.
    if (as === "ack" && flags?.place === "social") return "refused";
    const mark = flags?.mark ?? null;
    // A reply for others: what the conversation reads of it is held to the others' output limit as ONE budget (`RunFlags.othersText`)
    // — its acknowledgement to half of it, its final post to what the acknowledgement that stands for it left, as STORED (read here, in
    // the post's own transaction) — each cut as a reply over its length is cut (marked `truncated`), at every level.
    const budget = flags?.othersText ?? null;
    try {
      const posted = await this.deps.db.tx(async (t) => {
        const most = budget === null ? null : as === "ack" ? Math.floor(budget.most / 2) : Math.max(0, budget.most - (await acknowledgedWeight(t, run)));
        const over = most !== null && weight(said.text) > most;
        const reply: AgentReply = { ...said, ...(over ? { text: cutToWeight(said.text, most), truncated: true } : {}), refs: flags?.tools?.refs ?? null };
        return postAsAgent(t, run.agentId, run.conversationId, run.id, reply, mark, this.deps.config, as);
      });
      // The access or a note it was shown ended meanwhile (a social reply): the run was marked in that transaction, which committed.
      if (posted !== null && "refused" in posted) {
        this.deps.log.info({ metric: "social_post_refused", reason: posted.refused }, "agent run: a social reply was not posted (its access, or a note it was shown, ended before the post)");
        return "refused";
      }
      if (!posted) return "empty";
      const { message, duplicate, triggered } = posted;
      // In a group, the notices the Agent's message led to follow it; the runs it called for go to their owners, the
      // calls over its owner's limit on other people's Agents are only logged, and the owners of Agents whose others'
      // daily budget it found spent are pushed them.
      if (!duplicate) this.deps.conversations.publish({ messages: [message, ...triggered.notices], conversations: [] }, this.deps.log);
      if (!duplicate && typeof message.body.proposalId === "string") this.deps.realtime.pushAgentChanged(run.ownerId, run.agentId);
      actOnTriggered(triggered, { announce: (called) => this.announce(called), log: this.deps.log, realtime: this.deps.realtime, interrupt: (ids) => this.interruptRuns(ids) });
      // The group moved on: a judgement waiting there for a person's message is dropped (the decision would refuse that
      // message now). Nothing ever waits in the Agent's own conversation.
      if (!duplicate) this.deps.proactive?.cancelled(run.conversationId);
      return "posted";
    } catch (err) {
      if (err instanceof AppError && REFUSED.has(err.code)) {
        // A refused acknowledgement means the reply itself would be refused: stop it now (the worker's next poll), not after more rounds.
        if (as === "ack") this.flagsOf(run.id).stop = true;
        return "refused";
      }
      if (err instanceof RunNotRunning) {
        this.deps.log.warn({ runId: run.id, status: err.status }, "agent run: ended elsewhere while it was answered (another instance's recovery); its reply is not posted");
        return "refused";
      }
      throw err;
    }
  }

  /**
   * After commit, what a refusal told (runs.ts `Told`): the notices it appended go to their group, and each Agent whose
   * others' daily budget it found spent to its owner (`pushBudgetReached`).
   */
  private tell(told: Told): void {
    if (told.notices.length > 0) this.deps.conversations.publish({ messages: told.notices, conversations: [] }, this.deps.log);
    pushBudgetReached(this.deps.realtime, told.budgetReached);
  }

  /**
   * One transaction under `lockAgent` on the run's conversation: settles the call (it leaves `running` in the same
   * transaction, so its hold never stops counting before its cost lands) — at no charge when it failed on our side
   * (`busy`: the reply could not be stored) — records how the run ended (`recorded`), and follows it up by
   * `followUpSeq`, in the run's conversation (runs.ts `followUp`: in a group, under the owner's replies a minute, the
   * halt, the chain budget and the others' daily budget). Announced after commit, and the notices the follow-up appended
   * are published after the run's end (the owner of an Agent whose others' daily budget refused it is pushed it). A run
   * ended elsewhere meanwhile (another instance's recovery, the stale-run sweep, a stop of a run this
   * process was not seen working on) is left as that recorded it, and its owner is told how it stands now, so no
   * "replying" stays shown. A run whose reply was posted is pushed that reply once more, to its owner only, before its
   * end (`Hub.pushChargedReply`): now that the run is charged, the reply carries its `via`. A reply that was posted is
   * told to the reviewer (`noted`), and when its context left out anything (context.ts `leftOut`, kept from `begin` in
   * `RunFlags.leftOut`) the pair's rolling summary is asked to take it in (`summarise`; the job weighs it first).
   * The run's flags are forgotten in any case, also when this throws (a delta still waiting keeps its own).
   */
  async finish(run: RunTicket, end: RunEnd, usage: Usage | null, fallback: Estimated): Promise<void> {
    // An attempt held back at admission ended in `begin`, which told its owner: the run may already be under way again.
    if (end === HELD_BACK) return;
    const leftOut = this.flags.get(run.id)?.leftOut ?? null;
    // A social conversation is never reviewed or summarised (memory is the owner's own, and what a stranger said never becomes a note).
    const social = this.flags.get(run.id)?.place === "social";
    let result: Recorded | null | undefined;
    try {
      result = await this.record(run, end, usage, fallback, this.now());
    } finally {
      // An interrupted run is silenced here too, whether or not the pause's (or removal's) own call (`interruptRuns`)
      // came first.
      const flags = this.flags.get(run.id);
      if (flags && result?.interrupted) flags.silenced = true;
      this.flags.delete(run.id);
    }
    if (!result) return;
    if (result.reply !== null) this.deps.realtime.pushChargedReply(run.conversationId, run.ownerId, result.reply);
    countRetry(this.deps.log, result.retried);
    // Tried again by the system: the failure is announced to nobody — its owner is told of the queued retry alone (its slot
    // reads queued, never an error that then goes), and the other members of a group, told it is replying, nothing.
    if (result.retried !== null && "retry" in result.retried) this.deps.realtime.pushRunToOwner(run.conversationId, result.retried.retry.run);
    else this.announce(result.ended);
    // A reply stands: the conversation may have something to remember (the reviewer never throws and reads for itself), and
    // what its context left out may be folded into the pair's rolling summary. An acknowledgement alone is nothing to
    // remember (memory/review.ts `UNSPOKEN`).
    if (result.reply !== null && !social) {
      this.deps.memory?.noted(run.agentId, run.conversationId);
      if (leftOut !== null) this.deps.memory?.summarise(run.agentId, run.conversationId, leftOut.to);
    }
    if (result.followed.run) this.announce(result.followed.run);
    // A notice its follow-up appended (a chain budget or the others' daily budget spent): the group is told after the
    // run's end.
    this.tell(result.followed);
    // A reminder about money its settlement found due (metering/reminders.ts): its whisper made now, after commit, with
    // the whisper's own locks; should this fail, the periodic sweep makes it.
    if (result.reminder !== null) {
      try {
        const reminded = await deliverReminder(this.deps.db, this.deps.config, result.reminder);
        if (reminded) {
          this.deps.log.info({ metric: reminded.metric }, "a reminder about money was made for its owner");
          if (reminded.whisper) this.deps.realtime.pushWhisper(reminded.whisper);
        }
      } catch (err) {
        this.deps.log.error({ err, runId: run.id }, "agent run: its owner's reminder about money could not be made now; the periodic sweep makes it");
      }
    }
  }

  /** `finish`'s transaction: what to announce once it has committed, or null for a run that no longer exists. */
  private record(run: RunTicket, end: RunEnd, usage: Usage | null, fallback: Estimated, now: Date) {
    const { db, config } = this.deps;
    return db.tx(async (t): Promise<Recorded | null> => {
      const agent = await lockAgent(t, run.agentId, run.conversationId);
      const state = await t.query<RunState>(`select ${RUN_STATE} from agent_runs where id = $1 for update`, [run.id]);
      if (state.rows[0]?.status !== "running") {
        const current = await t.query<RunRow>(`select ${RUN_COLUMNS} from agent_runs r where r.id = $1`, [run.id]);
        if (!current.rows[0]) return null;
        await withTellable(t, current.rows, config.whispers.elsewhereTtlHours);
        const ended: Announced = { ownerId: run.ownerId, conversationId: run.conversationId, run: toWireRun(current.rows[0]) };
        return { ended, followed: followUpOf(null), interrupted: false, reply: null, reminder: null, retried: null };
      }
      // Its reply (its acknowledgement, if it posted one, is not: `ack:<run id>`).
      const said = await t.query<{ seq: string }>("select seq::text from messages where conversation_id = $1 and sender_id = $2 and client_txn = $3", [
        run.conversationId,
        run.agentId,
        run.id,
      ]);
      const reply = said.rows[0];
      // A refused post of a run in a group whose Agent is no longer a member there ends `agent_removed` (looked up only
      // for a refusal nothing else explains).
      const refused = reply === undefined && state.rows[0].interrupted === null && end.status === "cancelled" && end.error === undefined;
      // (Never in a social conversation: its refusals are the run's own marks, `access_ended` and the rest.)
      const removed = refused && run.conversationId !== agent.conversationId && this.flags.get(run.id)?.place !== "social" && !(await currentMembership(t, run.conversationId, agent.id));
      const final = recorded(end, { posted: reply !== undefined, interrupted: state.rows[0].interrupted, social: state.rows[0].social, agent, removed });
      const ours = final.status === "failed" && final.error === "busy";
      const settled = await settle(t, config, run.id, usage, fallback, final.status, now, { forgiveAll: ours, log: this.deps.log });
      // In the same transaction, under the account lock settlement took: the reminder about money it calls for, if any,
      // recorded (its whisper is made after commit, `finish`) — for the Agent's own conversation, or, its Agent deleted,
      // the conversation of the Agent its owner used last.
      const reminder = await remindInSettlement(t, config, run.ownerId, settled, now, agent.deleted ? null : agent.id);
      // A new Agent's greeting that could not be made is no failure its owner is shown (`quietGreeting`).
      const kept = quietGreeting(final, state.rows[0]);
      const error = kept.status === "failed" || kept.status === "cancelled" ? (kept.error ?? null) : null;
      const resetsAt = kept.status === "failed" && kept.resetsAt !== undefined ? kept.resetsAt : null;
      // A told reply keeps nothing noted once its end has decided its follow-up (`keepsNothingNoted`).
      const updated = await t.query<RunRow>(
        `update agent_runs as r set status = $2, error = $3, resets_at = $4, finished_at = now(),
                pending_seq = case when $5::boolean or $6::boolean then null else r.pending_seq end,
                call_seqs = case when $6::boolean then '{}' else r.call_seqs end
          where r.id = $1 returning ${RUN_COLUMNS}`,
        [run.id, kept.status, error, resetsAt, droppedOnEnd(final), state.rows[0].told],
      );
      await withTellable(t, updated.rows, config.whispers.elsewhereTtlHours);
      const ended: Announced = { ownerId: run.ownerId, conversationId: run.conversationId, run: toWireRun(updated.rows[0]!) };
      // Failed for a passing reason: the system tries it again by itself (runs.ts `scheduleAutoRetry`); the retry answers
      // what this run covered and what was noted on it, so nothing follows this run up.
      // (Never one its owner asked to stop.)
      const retried = transientFailure(final) && !state.rows[0].stop_asked ? await scheduleAutoRetry(t, run.id, agent, run.conversationId, state.rows[0], now, config) : null;
      const next = followUpOnEnd(state.rows[0], agent, final, { recovered: false, retried: retried !== null && "retry" in retried });
      const followed =
        next === null ? followUpOf(null) : await followUp(t, agent, run.conversationId, Number(state.rows[0].covers_seq ?? 0), next, state.rows[0].call_seqs, state.rows[0].owner_call_seqs, config);
      return {
        ended,
        followed,
        interrupted: state.rows[0].interrupted !== null,
        reply: reply ? Number(reply.seq) : null,
        retried,
        reminder,
      };
    });
  }

  /** `AgentPort.release`: the worker's run, ended as recovery ends one (`releaseRun`), with what the worker knew. */
  async release(run: RunTicket, progress = false): Promise<void> {
    await this.releaseRun(run.id, progress);
  }

  /** `AgentPort.progressed`: one write of the run's row alone (no lock beyond it), only while it is running. */
  async progressed(run: RunTicket): Promise<void> {
    await this.deps.db.query("update agent_runs set progressed = true where id = $1 and status = 'running' and not progressed", [run.id]);
  }

  /**
   * Ends run `runId` (a reply, or a persona draft) that will not be finished where it was begun — this process is
   * closing, or nobody is working on it — exactly as recovery at start-up ends one (`recoverRun`, in a transaction of
   * its own under the locks `finish` takes, on the run's own conversation), then tells its owner (and a follow-up queued
   * by the one rule wakes the worker), publishes the notices its follow-up appended (pushing the Agent to its owner when
   * its others' daily budget refused the follow-up), and forgets its flags; a run whose
   * reply had been posted pushes that reply once more to its owner, first (`Hub.pushChargedReply`, as `finish` does).
   * False when it was no longer running. Rejects, changing nothing, when it cannot be written. `progress`: the worker
   * knew its reply had produced something (`AgentPort.release`); then it is no passing failure, whatever its row says.
   */
  async releaseRun(runId: string, progress = false): Promise<boolean> {
    const { db, config, log } = this.deps;
    let recovered: Recovered | null;
    try {
      recovered = await db.tx((t) => recoverRun(t, config, runId, log, this.now(), progress));
    } finally {
      this.flags.delete(runId);
    }
    if (recovered === null) return false;
    // A reply held back behind this run may be claimed now (`claimNext`).
    this.wakeWorker();
    const { charged, retried } = recovered;
    if (charged !== null) this.deps.realtime.pushChargedReply(charged.conversationId, charged.ownerId, charged.seq);
    countRetry(log, retried);
    // Tried again by the system: its owner alone is told of the queued retry (as `finish` tells it); nothing else.
    if (retried !== null && "retry" in retried) this.deps.realtime.pushRunToOwner(retried.retry.conversationId, retried.retry.run);
    else for (const a of recovered.runs) this.announce(a);
    this.tell(recovered.told);
    return true;
  }
}

/** What `finish`'s transaction leaves to do once it has committed. */
interface Recorded {
  ended: Announced;
  /** Its follow-up (runs.ts `followUp`), and what deciding it told: notices to publish, Agents to push their owners. */
  followed: FollowUp;
  interrupted: boolean;
  /** The seq of the reply the run posted, to push again to its owner now that it is charged; null when none. */
  reply: number | null;
  /** The reminder about money its settlement recorded (metering/reminders.ts), its whisper to make once committed; null when none. */
  reminder: string | null;
  /** What the system did about trying it again by itself (runs.ts `scheduleAutoRetry`); null: nothing to try again. */
  retried: AutoRetry;
}

/**
 * What `recoverRun` leaves to do once it has committed: runs to announce, what its follow-up told (notices to publish,
 * the Agent to push to its owner when its others' daily budget refused the follow-up), a charged reply to push.
 */
interface Recovered {
  runs: Announced[];
  told: Told;
  /** The reply the run had posted, now charged (`Hub.pushChargedReply`); null when it posted none. */
  charged: { conversationId: string; ownerId: string; seq: number } | null;
  /** What the system did about trying it again by itself: a run the service lost mid-call failed for a passing reason. */
  retried: AutoRetry;
}

/**
 * Whether Agent `run.agentId` has posted a reply in `run.conversationId` since original run `original` was made, from a run
 * that is neither it nor one of its automatic retries (an acknowledgement is no reply).
 */
async function answeredSince(t: Tx, run: RunTicket, original: string): Promise<boolean> {
  const { rowCount } = await t.query(
    `select 1 from messages m join agent_runs o on o.id = $3
      where m.conversation_id = $1 and m.sender_id = $2 and m.kind = 'text' and m.created_at > o.created_at
        and m.client_txn is not null and m.client_txn not like 'ack:%'
        and m.client_txn not in (select x.id::text from agent_runs x where x.id = $3 or x.retry_of = $3)
      limit 1`,
    [run.conversationId, run.agentId, original],
  );
  return rowCount !== 0;
}

/** The texts of the notes and hearsay a run was shown (what its web search's query guard compares a query with). */
const shownTexts = (notes: PromptNotes): string[] => [...notes.owner, ...notes.self, ...notes.hearsay].map((n) => n.text);

/** The metric of each bound that refuses a web search at its pre-hold (README "Metrics in the log"); none for a run no search can be held for. */
const REFUSED_METRIC: Readonly<Record<RefusedBy, string | null>> = {
  reply_cap: "web_refused_reply_cap",
  lane_budget: "web_refused_lane_budget",
  no_points: "web_refused_no_points",
  site_fuse: "web_site_fuse_refused",
  unavailable: null,
};

/** A run's flags as an attempt starts. */
const freshFlags = (): RunFlags => ({ stop: false, silenced: false, place: "own", mark: null, money: null, model: null, leftOut: null, tools: null });

export function createAgentPort(deps: AgentPortDeps): DbAgentPort {
  return new DbAgentPort(deps);
}

/**
 * Recovery at start-up, before the worker starts (README "Agents and runs"; spec 6.4, 6.5): every run the previous
 * process left `running` — its call, if it had one, died with it — is ended without a model call, each in a
 * transaction of its own under the locks `finish` takes (the run's own conversation row and the Agent's `agents` row,
 * then the run's, then the account's; a persona draft has no Agent: its run row, then the account). A draft has no
 * message either, so it always ends as the last case:
 * - its reply had been posted in its conversation (the stop fell between post and finish): `done`, or `stopped` when
 *   the message says so;
 * - else, its Agent's pause, delete or leaving the run's group had interrupted it: `cancelled` with that reason;
 * - else `failed`, `provider_unavailable`, retryable.
 * In the same transaction its hold is released by a settlement that costs nothing (whatever the upstream reported died
 * with the process: no tokens, all forgiven) — unless it already has its usage record: it is never settled twice. A
 * posted or cancelled run is followed up by the one rule (`followUpSeq`: queued, for the worker about to start); a
 * failed one is not, so nothing is called again on its own (spec 6.5) and a retry answers everything — but a told reply's
 * noted calls, which are followed up whatever it ended as (`keepsNothingNoted`). Queued runs are
 * left as they are. Nothing is pushed (no socket can be open yet): a client learns the state from `GET …/run`. A run
 * that cannot be recovered is logged and left for the stale-run sweep or the next start. Returns how many were
 * recovered. The same ending, while the service runs, is `DbAgentPort.releaseRun` (one transaction of `recoverRun`).
 */
export async function recoverRuns(
  db: Db,
  config: Config,
  log: Pick<FastifyBaseLogger, "error" | "warn"> & Partial<Pick<FastifyBaseLogger, "info">>,
  now: () => Date = () => new Date(),
): Promise<number> {
  const { rows } = await db.query<{ id: string }>("select id from agent_runs where status = 'running' order by started_at, id");
  let recovered = 0;
  for (const run of rows) {
    try {
      // Nothing is announced: no socket can be open yet, and the worker starts after this.
      const done = await db.tx((t) => recoverRun(t, config, run.id, log, now()));
      if (done === null) continue;
      recovered++;
      countRetry(log, done.retried);
    } catch (err) {
      log.error({ err, runId: run.id }, "agent run: could not be recovered at start-up; it stays running until the stale-run sweep or the next start releases it");
    }
  }
  return recovered;
}

/**
 * One run of `recoverRuns` (and of `sweepStaleRuns`, `releaseRun`): null when it was no longer running (or does not
 * exist), else what to tell its owner — the run as it ended and its follow-up (queued, or in a group over the owner's
 * replies a minute the reusable `rate_limited` run), if any, both in the run's own conversation (a draft has no
 * conversation: nothing) — and the notices the follow-up appended there. The run's Agent and conversation are read from
 * its row first (they never change), so that the locks are taken in their order: that conversation's row and the
 * `agents` row, then the run's, then (`settle`, the follow-up) the owner's `accounts` row. `progress`: a release's
 * knowledge that the reply had produced something, beside its row's `progressed` (a lost run is passing only without both).
 */
async function recoverRun(t: Tx, config: Config, runId: string, log: Pick<FastifyBaseLogger, "warn">, now: Date, progress = false): Promise<Recovered | null> {
  const of = (
    await t.query<{ agent_id: string | null; conversation_id: string | null }>("select agent_id, conversation_id from agent_runs where id = $1", [runId])
  ).rows[0];
  if (!of) return null;
  // A reply has its Agent and conversation; a persona draft has neither.
  const reply =
    of.agent_id !== null && of.conversation_id !== null
      ? { agent: await lockAgent(t, of.agent_id, of.conversation_id), conversationId: of.conversation_id }
      : null;
  const state = (await t.query<RunState>(`select ${RUN_STATE} from agent_runs where id = $1 for update`, [runId])).rows[0];
  if (state?.status !== "running") return null;
  const posted =
    reply === null
      ? null
      : (
          await t.query<{ stopped: boolean | null; seq: string }>(
            "select (body ->> 'stopped') = 'true' as stopped, seq::text from messages where conversation_id = $1 and sender_id = $2 and client_txn = $3",
            [reply.conversationId, reply.agent.id, runId],
          )
        ).rows[0];
  const end: RunEnd = posted
    ? { status: posted.stopped === true ? "stopped" : "done" }
    : state.interrupted
      ? interruptionEnd(state)
      : failedEnd("provider_unavailable", { kind: "lost", progress: state.progressed || progress });
  // A run settled already had its hold released with its record.
  const settled = (await t.query("select 1 from usage_records where run_id = $1", [runId])).rowCount !== 0;
  if (!settled) await settle(t, config, runId, null, NOTHING, end.status, new Date(), { forgiveAll: true, log });
  const kept = quietGreeting(end, state);
  const error = kept.status === "failed" || kept.status === "cancelled" ? (kept.error ?? null) : null;
  const updated = await t.query<RunRow>(
    `update agent_runs as r set status = $2, error = $3, finished_at = now(),
            pending_seq = case when $4::boolean or $5::boolean then null else r.pending_seq end,
            call_seqs = case when $5::boolean then '{}' else r.call_seqs end
      where r.id = $1 returning ${RUN_COLUMNS}`,
    [runId, kept.status, error, droppedOnEnd(end), state.told],
  );
  if (reply === null) return { runs: [], told: noneTold(), charged: null, retried: null };
  const { agent, conversationId } = reply;
  await withTellable(t, updated.rows, config.whispers.elsewhereTtlHours);
  const ended: Announced = { ownerId: agent.ownerId, conversationId, run: toWireRun(updated.rows[0]!) };
  // A run the service lost mid-call failed for a passing reason: the system tries it again by itself (runs.ts
  // `scheduleAutoRetry`), the retry answering all it covered and noted (a told reply's noted calls stay noted on it).
  // (Never one its owner asked to stop: a stop of a run nobody here works on releases it so.)
  const retried = transientFailure(end) && !state.stop_asked ? await scheduleAutoRetry(t, runId, agent, conversationId, state, now, config) : null;
  // Else a failed run is followed by nothing on its own (its owner's retry answers everything) — but a told reply's noted
  // calls, which were never part of what failed, are followed up at once (`keepsNothingNoted`).
  const next = followUpOnEnd(state, agent, end, { recovered: true, retried: retried !== null && "retry" in retried });
  const { run: followed, ...told } =
    next === null ? followUpOf(null) : await followUp(t, agent, conversationId, Number(state.covers_seq ?? 0), next, state.call_seqs, state.owner_call_seqs, config);
  return {
    runs: followed ? [ended, followed] : [ended],
    told,
    charged: posted ? { conversationId, ownerId: agent.ownerId, seq: Number(posted.seq) } : null,
    retried,
  };
}

/**
 * How long a run must have been `running` before the stale-run sweep may release it: longer than any live run can be —
 * twice the longer of a call's time limit (`AGENT_RUN_TIMEOUT_MS`) and a reply's tools' (`TOOLS.runTimeoutMs`: the
 * reading of its attachments, then its call or its tools), the far ceiling of a reply whose model may think
 * (`MODEL_CALL_CEILING_MS`: no clock but that one cuts its calls), and a minute for posting and recording. With the
 * defaults 2 × max(120 s, 300 s) + 30 min + 60 s: 41 minutes. (Only a run of ANOTHER process waits for it: this
 * process's own are never swept, and a process that starts recovers what the one before it left at once.)
 */
export const staleAfterMs = (config: { agentRunTimeoutMs: number; tools: Pick<Config["tools"], "runTimeoutMs">; modelCallCeilingMs: number }): number =>
  2 * Math.max(config.agentRunTimeoutMs, config.tools.runTimeoutMs) + config.modelCallCeilingMs + 60_000;

/**
 * The stale-run sweep (README "Agents and runs", Recovery): every run — reply or draft — that is `running`, has been
 * since longer than `staleAfterMs`, and is not one this process is working on (`held`: its worker's runs and its drafts
 * in flight) is released exactly as start-up recovery releases one (`port.releaseRun`: `recoverRun`, each in a
 * transaction of its own under the same locks, on the run's own conversation; its owner is told, a follow-up wakes the
 * worker, and its flags are forgotten). Such a run's process died mid-call while another instance kept running (a
 * deploy where two overlap), its stop could not write its end, or its `finish` failed. Every run is bounded well within
 * `staleAfterMs`, so one that is still being worked on elsewhere is past its time: `post` then refuses it
 * (`RunNotRunning`) and nothing is recorded twice. A run that cannot be released is logged and tried again by the next
 * sweep. Returns how many were released.
 */
export async function sweepStaleRuns(
  port: Pick<DbAgentPort, "releaseRun">,
  db: Db,
  config: Config,
  log: Pick<FastifyBaseLogger, "error" | "warn">,
  held: (runId: string) => boolean,
): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `select id from agent_runs
      where status = 'running' and started_at < now() - ($1::bigint * interval '1 millisecond')
      order by started_at, id`,
    [staleAfterMs(config)],
  );
  let released = 0;
  for (const run of rows) {
    if (held(run.id)) continue;
    try {
      if (!(await port.releaseRun(run.id))) continue;
      released++;
      log.warn({ runId: run.id }, "agent run: released by the stale-run sweep (left running by a process that is gone)");
    } catch (err) {
      log.error({ err, runId: run.id }, "agent run: the stale-run sweep could not release it; the next sweep tries again");
    }
  }
  return released;
}

/**
 * Runs `sweep` once after `initialDelayMs` (default a minute), then every `intervalMs` (default a minute); never two at
 * once. `stop` cancels the timers and waits for a sweep under way.
 */
export function startStaleRunSweep(
  sweep: () => Promise<unknown>,
  log: Pick<FastifyBaseLogger, "error">,
  { initialDelayMs = 60_000, intervalMs = 60_000 }: { initialDelayMs?: number; intervalMs?: number } = {},
): { stop(): Promise<void> } {
  let stopped = false;
  let inFlight: Promise<void> | undefined;
  let every: NodeJS.Timeout | undefined;
  const tick = (): void => {
    if (stopped || inFlight) return;
    inFlight = sweep()
      .then(
        () => undefined,
        (err: unknown) => log.error({ err }, "the stale-run sweep failed; it runs again shortly"),
      )
      .finally(() => {
        inFlight = undefined;
      });
  };
  const first = setTimeout(() => {
    tick();
    if (stopped) return;
    every = setInterval(tick, intervalMs);
    every.unref();
  }, initialDelayMs);
  first.unref();
  return {
    async stop() {
      stopped = true;
      clearTimeout(first);
      if (every) clearInterval(every);
      await inFlight;
    },
  };
}
