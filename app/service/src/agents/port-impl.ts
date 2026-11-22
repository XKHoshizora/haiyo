import type { FastifyBaseLogger } from "fastify";
import { MICRO_PER_POINT, siteDay } from "../accounts/store.ts";
import type { BlobStore } from "../attachments/blob.ts";
import type { Config } from "../config.ts";
import type { ConversationEvents } from "../conversations/events.ts";
import { currentMembership } from "../conversations/store.ts";
import type { Db, Tx } from "../db.ts";
import { AppError } from "../errors.ts";
import { admitRun, anySourceSql, chosenSourceSql, HeldBack, raiseHold, type ChargeTo } from "../metering/admit.ts";
import { assertCount, costMicro, isCount, maxCostMicro, type Price } from "../metering/prices.ts";
import { deliverReminder, remindInSettlement } from "../metering/reminders.ts";
import { settle } from "../metering/settle.ts";
import { correctedEstimate, estimateTokens, holdTokens, planRatio, ratioKey, readRatio, TOOL_PREAMBLE_TOKENS, TOOL_TEXT_FACTOR } from "../metering/tokens.ts";
import { loadNotes } from "../memory/passage.ts";
import { markRead, type ReadEvents } from "../messages/read.ts";
import type { ToolCall, ToolSpec } from "../models/gateway.ts";
import { resolveModel, type Resolved } from "../models/resolve.ts";
import { toldHits, toldPassage } from "./tools/elsewhere.ts";
import { RunRefs } from "./tools/refs.ts";
import type { RunScope } from "./tools/index.ts";
import { KeyUnreadableError } from "../providers/crypto.ts";
import { markToolsOff } from "../providers/store.ts";
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
  withRoster,
  type BuiltContext,
  type LeftOut,
  type LoadedContext,
  type Speaker,
} from "./context.ts";
import { contextBudget, holdsNewest } from "./runtime/context.ts";
import { FINAL_LINE } from "./runtime/loop.ts";
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
import { fitNotes, GREETING_LINE, GREETING_TURN, groupSystemText, NO_NOTES, passageBudget, systemText, systemTokens, type PromptNotes, type SystemText, type ToolsPrompt, type WebPrompt } from "./runtime/prompt.ts";
import { holdSearch as preHoldSearch, SearchRefused, type HeldSearch } from "./tools/web/hold.ts";
import { fuseLine, WEB_NO_MONEY, WEB_SITE_DAY, WEB_UNAVAILABLE } from "./tools/web/tool.ts";
import {
  actOnTriggered,
  budgetReachedWith,
  droppedOnEnd,
  dropBlockedCalls,
  followUp,
  followUpOf,
  followUpOnEnd,
  hearFrom,
  noneTold,
  pushBudgetReached,
  refusedAtAdmission,
  AUTO_RETRY_WINDOW_MS,
  RUN_COLUMNS,
  scheduleAutoRetry,
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
    where: { group: boolean; web?: boolean },
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

/** The model a run's call went to, kept from `begin` in this process (`RunFlags.model`): what `toolsUnusable` marks. */
type RunModel = { source: "site"; id: string } | { source: "provider"; providerId: string; name: string };

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
const roomGrowth = (k: number, resultMaxWeight: number, maxOutputTokens: number): number => k * (3 * resultMaxWeight + 200) + 6 * maxOutputTokens + 300;

/** Everything the reply was to answer is before a new topic its owner started: nothing failed, nothing to retry. */
const STARTED_OVER: RunEnd = { status: "cancelled" };
/**
 * In a group, none of the messages that called for the reply is one its Agent can see and show (context.ts `callsSeen`):
 * nothing is left to answer — nothing failed, nothing to retry.
 */
const NOTHING_LEFT: RunEnd = { status: "cancelled" };
/**
 * Every call the reply answers (a told reply answers none: never so) was made by someone who has had a block with the Agent's owner, either way, since: each
 * would be refused now (runs.ts `dropBlockedCalls`), so with none left the reply ends before any call — nothing held or
 * charged, no message, nothing to retry.
 */
const BLOCKED_SINCE: RunEnd = { status: "cancelled" };
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

/** Why `postAsAgent` refuses a run's reply (409): the Agent's state, or what interrupted the run. */
const REFUSED: ReadonlySet<string> = new Set(["agent_paused", "agent_deleted", "agent_removed", "halted"]);

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
  /** It was held back at an earlier attempt and is not admitted yet (`held_back_by`). */
  marked: boolean;
  /** Its owner asked it to stop while it ran (runs.ts `stopRun`). */
  stop_asked: boolean;
  /**
   * A reply `告诉他们` queued (`whisper_id`): it answers nobody's call — what it covers is merely the group's latest message
   * when it was queued, anyone's — so `begin` holds none of it to the block rule; the calls noted on it are its follow-up's,
   * held to that rule there (runs.ts `followUp`).
   */
  told: boolean;
  /** A new Agent's first reply (`agent_runs.greets`, conversation.ts `createAgent`): told to greet its owner. */
  greets: boolean;
  /** An automatic retry (runs.ts `scheduleAutoRetry`): the run of its original call; null for an original. */
  retry_of: string | null;
  /** How many automatic attempts came before it (0: none, an original or the owner's own 重试). */
  auto_attempt: number;
  /** An automatic retry: when its original call was made (the start bound, `AUTO_RETRY_WINDOW_MS`); else null. */
  original_at: Date | null;
  /** The reply had produced something before it was lost: its acknowledgement posted, or a tool round completed. */
  progressed: boolean;
}
const RUN_STATE =
  "status, covers_seq::text, pending_seq::text, interrupted, lane, call_seqs::text[] as call_seqs, held_back_by is not null as marked, stop_asked, whisper_id is not null as told, greets, retry_of, auto_attempt, progressed, " +
  "case when auto_attempt > 0 then (select o.created_at from agent_runs o where o.id = agent_runs.retry_of) end as original_at";

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
  /** Its owner asked it to stop, or its Agent's pause, delete or leaving the run's group interrupted it. */
  stop: boolean;
  /** Its Agent's pause, delete or leaving the run's group interrupted it: nothing more of it is pushed. */
  silenced: boolean;
  /**
   * Its conversation is a group (decided at `begin`, from the run's conversation and its Agent's own): none of it is
   * streamed (plan ruling 2) — its reply arrives whole, with its message.
   */
  group: boolean;
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
   * A reply offered tools, from `begin` once the call is admitted: the numbers it gave the model (refs.ts — its context's
   * file labels, then what its tools hand over) and how far its conversation had come when it began (`RunScope.heardTo`).
   * Null for one offered none. Forgotten with the run's flags: no number outlives its reply. A reply offered the web
   * search also keeps the texts of the notes and hearsay it was shown (`shown`: its query guard's, never stored or logged).
   */
  tools: { refs: RunRefs; heardTo: number; shown?: readonly string[]; shownFrom: number | null } | null;
}

/**
 * How a run is recorded, from what is true under `lockAgent` rather than what the worker could tell (an owner's stop
 * and a pause look alike to it): a reply that was posted stands — `done`, or `stopped` by its owner — whatever happened
 * to the Agent after; a run its Agent's pause, delete or leaving the run's group (`agent_removed`) interrupted, and that
 * posted nothing, is `cancelled` with that
 * reason (also when the Agent was resumed meanwhile); a refused post is `cancelled` for the Agent's state — deleted,
 * paused, or no longer a member of the run's group (`removed`).
 */
function recorded(end: RunEnd, s: { posted: boolean; interrupted: Interruption | null; agent: AgentRow; removed: boolean }): RunEnd {
  if (s.posted) return end.status === "stopped" ? end : { status: "done" };
  if (s.interrupted) return { status: "cancelled", error: s.interrupted };
  if (end.status === "cancelled" && end.error === undefined) {
    if (s.agent.deleted) return { status: "cancelled", error: "agent_deleted" };
    if (s.agent.paused) return { status: "cancelled", error: "agent_paused" };
    if (s.removed) return REMOVED;
  }
  return end;
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

  /**
   * `AgentPort.claimNext`. A reply held back at admission (`HELD_BACK`; its mark `held_back_by`, `held_back_on`, kept until
   * it is admitted) waits while every call it was held back behind is still running. Until it is admitted — queued, or
   * claimed again and not admitted yet — the owner's younger replies that would be paid from the same source (either, for
   * a mark of `any`) wait behind it (first come, first served per payer and source, so a reply with a large hold is not
   * passed for ever by smaller ones); a reply on the owner's own provider key, or one the other source would pay, does
   * not, nor does the owner's own reply (lane `own`) behind one someone else called for, which the others' lanes may keep
   * queued. Which source a queued reply would be paid from is admission's own rule (metering/admit.ts) on what its owner
   * has now, read here. Each claim starts the
   * run's flags afresh. A first claim is announced (`announce`) and its wait logged (`run_wait_ms`, once per reply); a
   * reply claimed again after it was held back is told to its owner alone — the other members of a group, who were told it
   * is replying, are told nothing more.
   */
  async claimNext(): Promise<RunTicket | null> {
    const { config } = this.deps;
    const waiting = (r: string) =>
      `(${r}.held_back_by is not null
        and (select count(*) from agent_runs b where b.id = any(${r}.held_back_by) and b.status = 'running') = cardinality(${r}.held_back_by))`;
    // The source the queued reply q would be paid from now: admission's own rule (metering/admit.ts `chosenSourceSql`, the
    // one definition, else `anySourceSql` when the holds leave it nothing): null on a provider's model, on a model the
    // site no longer offers, or with nothing left (it will be refused).
    const cols = { freeTier: "qa.site_model_id = any($4::text[])", freeLeft: "$5::bigint - m.used", balance: "m.balance", balanceHeld: "m.balance_held" };
    const sourceOfQ = `(
      select case
               when qa.model_source is distinct from 'site' or not (qa.site_model_id = any($3::text[])) then null
               else coalesce(${chosenSourceSql(cols)}, ${anySourceSql(cols)})
             end
        from agents qa,
             (select coalesce((select u.used_micro from free_usage u where u.owner_id = q.owner_id and u.day = $6::date), 0) as used,
                     coalesce((select a.balance_micro from accounts a where a.principal_id = q.owner_id), 0) as balance,
                     coalesce((select sum(h.hold_micro) from agent_runs h where h.owner_id = q.owner_id and h.status = 'running' and h.charge_to = 'balance'), 0) as balance_held) m
       where qa.principal_id = q.agent_id)`;
    const { rows } = await this.deps.db.query<RunRow & { agent_id: string; owner_id: string; conversation_id: string; lane: string; wait_ms: number; again: boolean; auto_attempt: number }>(
      `with next as (
         select q.id from agent_runs q
          where q.status = 'queued' and q.purpose = 'reply'
            and (q.not_before is null or q.not_before <= $7::timestamptz)
            and (select count(*) from agent_runs x where x.owner_id = q.owner_id and x.status = 'running') < $1
            and (q.lane = 'own'
              or (select count(*) from agent_runs x where x.owner_id = q.owner_id and x.status = 'running' and x.lane <> 'own') < $2)
            and not ${waiting("q")}
            and not exists (select 1 from agent_runs o
                             where o.owner_id = q.owner_id and o.purpose = 'reply' and o.held_back_on is not null
                               and (o.status = 'queued' or (o.status = 'running' and o.source is null))
                               and (o.created_at, o.id) < (q.created_at, q.id)
                               and (q.lane <> 'own' or o.lane = 'own')
                               and (o.held_back_on = ${sourceOfQ} or (o.held_back_on = 'any' and ${sourceOfQ} is not null)))
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
      ],
    );
    const row = rows[0];
    if (!row) return null;
    const run: RunTicket = { id: row.id, agentId: row.agent_id, ownerId: row.owner_id, conversationId: row.conversation_id };
    this.flags.set(run.id, freshFlags());
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
    if (state.interrupted) return { status: "cancelled", error: state.interrupted };
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
    const { db, config, blobs, log } = this.deps;
    const now = new Date();
    // This attempt's flags (`claimNext` started them): a later attempt of the same run has flags of its own.
    const mine = this.flagsOf(run.id);
    const first = await db.tx(async (t): Promise<
      | { end: RunEnd }
      | {
          resolved: Resolved;
          loaded: LoadedContext;
          covers: number;
          coveredBefore: number;
          key: string;
          ratio: number;
          offer: Offer | null;
          reserved: number;
          withoutTools: string | null;
          tools: { refs: RunRefs; heardTo: number; shown?: readonly string[] } | null;
          told: boolean;
        }
    > => {
      const { agent, state } = await this.lockRun(t, run);
      // Anywhere but the Agent's own conversation is a group: nothing of the reply is streamed (`emit`).
      const group = run.conversationId !== agent.conversationId;
      if (group) this.flagsOf(run.id).group = true;
      const halted = this.halted(run, agent, state);
      if (halted) return { end: halted };
      // In a group: the Agent must still be a member there (nothing else may have marked the run yet).
      const scene = group ? await loadGroupScene(t, agent, run.conversationId) : null;
      if (group && scene === null) return { end: REMOVED };
      // A block made since a call, either way, between the Agent's owner and whoever made it: that call is dropped, as it
      // would be refused now (runs.ts `dropBlockedCalls`, every lane, every group run: one of the owner's own may carry a
      // call relayed by someone else's Agent); with no call left the reply ends quietly. Not asked (no query) in the
      // Agent's own conversation, where every call is its owner's and nobody has a block with themselves — nor for a reply
      // `告诉他们` queued (`told`): it is its owner's own tell and answers nobody's call (what it covers is merely the
      // group's latest message then, anyone's); what was noted on it is held to the block rule by its follow-up.
      if (group && !state.told) {
        const kept = await dropBlockedCalls(t, run.id, agent.ownerId);
        if (kept === null) return { end: BLOCKED_SINCE };
        Object.assign(state, kept);
      }
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
      const notes =
        !group && agent.persona === ""
          ? NO_NOTES
          : fitNotes(
              await loadNotes(t, agent, { conversationId: run.conversationId, group }),
              group,
              config.siteTimezone,
              displayName,
              passageBudget(resolved.contextTokens, resolved.call.maxOutputTokens, config.memory.passageShare),
              planned,
            ).notes;
      // What the web search's offer says of the reply (the product owner's rules, lane websearch2): a reply of an Agent
      // whose `webSearch` is on may have it, in every lane and on every model (a provider model's searches are paid from
      // its owner's points, tools/web/hold.ts); the toolbox adds it only while the site offers it, to a reply offered tools
      // at all (below: never a greeting, a told reply, a model that cannot use them), and `web` is what its system text
      // says of it then.
      const mayWeb = agent.webSearch;
      let web: WebPrompt | undefined;
      // A run still proactive when it starts (its stored lane: a mention that took it over changed it) is told nobody called it.
      // The system text with the run's mark and, in a group, its roster of who is there with those who spoke: a group's
      // carries both; the Agent's own conversation has neither (it says what to call the owner, if they set that). A reply
      // offered tools (`tools`) is not told it has none; one offered none is, as always.
      const system =
        (offered: boolean) =>
        (mark: string, speakers: readonly Speaker[]): SystemText => {
          const tools: ToolsPrompt = offered && web !== undefined ? { web } : offered;
          const text = scene
            ? groupSystemText({ ...agent, bare }, { displayName }, withRoster(scene, speakers), now, config.siteTimezone, mark, state.lane === "proactive", notes, told === null ? tools : "told")
            : systemText(agent, { displayName }, now, agent.persona === "" ? "onboarding" : "normal", config.siteTimezone, notes, tools);
          // A new Agent's first reply greets its owner in its own words (`greets`): the fixed instruction last.
          if (state.greets && !group) return { text: `${text.text}\n\n${GREETING_LINE}`, rest: `${text.rest}\n\n${GREETING_LINE}`, passage: text.passage };
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
      const line = group ? await askerLine(t, run.id) : 0;
      const calls = group ? await callsSeen(t, agent.id, run.id, line) : [];
      if (group && calls.length === 0 && told === null) return { end: NOTHING_LEFT };
      const cap = group ? { maxTokens: config.agentGroupContextTokens, maxMessages: GROUP_CONTEXT_MESSAGES, after: line, calls } : null;
      // The pair's summary and what of it may be shown, read once for every plan below (round 2, N-4: two indexed reads at
      // most, nothing of the conversation's history), here, under the row its job writes it under.
      const summary = await readPairSummary(t, { agentId: agent.id, ownerId: agent.ownerId, conversationId: run.conversationId, group }, config.memory.summaryMaxWeight);
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
      let offer: Offer | null =
        told === null && !state.greets && config.tools.enabled && resolved.tools && this.deps.toolbox ? this.deps.toolbox.offer(run, mayWeb ? { group, web: true } : { group }) : null;
      if (offer !== null && offer.tools.length === 0) offer = null;
      web = offer?.web;
      // A reply offered tools numbers the files its context labels (`[文件 〔f1〕：name]`), so that its file tool can name
      // them and its text cite them (tools/refs.ts) — afresh for each plan, and in a plan only those of the messages it can
      // show (context.ts `loadContext`), past any number someone typed in what it is shown; one offered none is shown them
      // as always. One offered the web search reads `〔w1〕` too (its numbers' letter, refs.ts).
      /** One plan: offered tools (`numbered`), with numbers made afresh; else with none. */
      const planOf = async (numbered: boolean, reserved: number): Promise<{ loaded: LoadedContext; refs: RunRefs | null }> => {
        const refs = numbered ? new RunRefs({}, web === "offered") : null;
        return { loaded: await loadContext(t, { ...plan, reserved, ...(refs ? { refs } : {}) }, resolved, system(refs !== null), this.deps.drawMark), refs };
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
      // A new Agent's greeting before its owner has written: the one turn it is shown is what is so (`GREETING_TURN`).
      if (state.greets && !group && !hasOwnerTurn(loaded)) loaded.entries.push({ role: "user", text: GREETING_TURN, attachment: null });
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
      const shown = offer?.web === "offered" ? { shown: shownTexts(notes) } : {};
      const tools = heard === null || refs === null ? null : { refs, heardTo: Number(heard.rows[0]?.seq ?? 0), ...shown };
      return { resolved, loaded, covers, coveredBefore, key, ratio, offer, reserved, withoutTools, tools, told: told !== null };
    });
    if ("end" in first) return first.end;

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
    ): Promise<{ end: RunEnd; told?: Told; queued?: Announced } | { prepared: Prepared; read: number | null; money: RunMoney; wasMarked: boolean }> => {
      const { agent, state } = await this.lockRun(t, run);
      const halted = this.halted(run, agent, state);
      if (halted) return { end: halted };
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
      const told = await refusedAtAdmission(t, run.conversationId, agent, state.lane, config);
      if (told) {
        if (first.covers > first.coveredBefore) await this.handBack(t, run.id, first.coveredBefore, first.covers);
        return { end: ENDED_QUIETLY, told };
      }
      const { resolved, loaded, covers, key, ratio, offer, reserved, withoutTools } = first;
      // The tools the reply is offered (step 1).
      const tools = offer?.tools ?? [];
      // What admission holds for the input: the most it can cost — its text at its utf-8 bytes, at most what the context
      // leaves beside the output limit (`holdTokens`), images and PDFs at their constants — whatever the model's ratio.
      // Offered tools go with the call too: their definitions are held at their bytes as well, and what providers add
      // around them.
      const texts = [loaded.system.text, ...context.messages.flatMap((m) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])))];
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
      const growthTokens =
        offer === null
          ? 0
          : offer.tools.every((tool) => Object.hasOwn(offer.perTool, tool.name))
            ? roomGrowth(Object.values(offer.perTool).reduce((sum, n) => sum + n, 0), config.tools.resultMaxWeight, resolved.call.maxOutputTokens)
            : roomCapTokens;
      const lastCall = tools.length === 0 ? 0n : maxCostMicro(resolved, Math.min(held + growthTokens, roomCapTokens));
      let admission;
      try {
        admission = await admitRun(t, config, run.id, run.ownerId, resolved, held, now, lastCall);
      } catch (err) {
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
          return { end: HELD_BACK, queued: { ownerId: run.ownerId, conversationId: run.conversationId, run: toWireRun(queued.rows[0]!) } };
        }
        if (!(err instanceof AppError) || err.code !== "no_quota") throw err;
        const resetsAt = err.details.resetsAt;
        return { end: { status: "failed", error: "no_quota", ...(typeof resetsAt === "string" ? { resetsAt } : {}) } };
      }
      // What settlement learns the ratio from: the estimate at ratio 1 of a call that showed text only (an image's or a
      // PDF's real tokens are not text's), and the ratio's key. A reply that offers tools teaches nothing: its rounds send
      // the tools and the steps, which the estimate does not count, and settle on their summed usage.
      await t.query("update agent_runs set input_estimate = $2, ratio_key = $3 where id = $1", [
        run.id,
        context.fixedTokens === 0 && tools.length === 0 ? context.inputTokensEstimate : null,
        key,
      ]);
      // An automatic retry is counted as run once it is admitted: its call is made now (not at its claim).
      if (state.auto_attempt > 0) log.info({ metric: "auto_retry_ran", attempt: state.auto_attempt }, "agent run: an automatic retry was admitted");
      const marked = await markRead(t, agent.id, run.conversationId, covers);
      const reasoning = resolved.reasoning;
      const planned = planRatio(ratio);
      // An acknowledgement already stands for what it answers (an earlier attempt's: a retry): it posts none.
      const acknowledged = tools.length > 0 && (await standingAcknowledgement(t, run.conversationId, run.agentId, run.id)) !== null;
      return {
        prepared: {
          call: {
            ...resolved.call,
            system: loaded.system.text,
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
    if ("end" in result) {
      // Held back: its owner is told it is queued again (the other members of a group, told it is replying, nothing more);
      // this attempt's flags go, unless a later attempt has flags of its own already; it is counted.
      if (result.end === HELD_BACK && result.queued) {
        this.deps.realtime.pushRunToOwner(run.conversationId, result.queued.run);
        if (this.flags.get(run.id) === mine) this.flags.delete(run.id);
        log.info({ metric: "run_held_back" }, "agent run: held back until a call of its owner ends");
        return HELD_BACK;
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
    const { resolved } = first;
    flags.model = resolved.source === "site" ? { source: "site", id: resolved.name } : { source: "provider", providerId: resolved.providerId!, name: resolved.name };
    // In its own conversation, where what its call shows begins (`RunScope.shownFrom`): known once its context is built.
    flags.tools = result.prepared.tools.length > 0 && first.tools !== null ? { ...first.tools, shownFrom: flags.group ? null : context.shownFrom } : null;
    return result.prepared;
  }

  emit(run: RunTicket, delta: Delta): void {
    // Checked now and again when the hub delivers it, against the flags it was emitted under: once the pause, delete or
    // removal from the run's group has answered, no delta goes out, however late it is delivered. A run that has
    // finished emits nothing, and a run in a group never does (to nobody, its owner included).
    const flags = this.flags.get(run.id);
    if (!flags || flags.silenced || flags.group) return;
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
    const { shown } = flags.tools;
    // A reply offered the web search: what it was shown (its query guard) and its pre-hold (`holdSearch`).
    const web = shown === undefined ? {} : { shown, holdSearch: () => this.holdSearch(run) };
    const scope: RunScope = { ...run, group: flags.group, refs: flags.tools.refs, heardTo: flags.tools.heardTo, mark: flags.mark, shownFrom: flags.tools.shownFrom, ...web };
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
        // The site's money fuse refusing a search: the operator's metric (a count, nothing of the search).
        if (err.why === WEB_SITE_DAY) this.deps.log.info({ metric: "web_site_fuse_refused" }, "web search: refused by the site's money fuse for today");
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
   * 2. so far and the next call's most within `TOOLS.maxPoints` and within what is left of the run's source, its own hold
   *    added back (admit.ts `raiseHold`), and step 1 not reached: the hold raised to that — "ok";
   * 3. else the hold raised to so far and the next call's most, past what is left if it must, also below zero — "final":
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
          await t.query<{ charge_to: ChargeTo | null; hold: string; web: string }>("select charge_to, hold_micro::text as hold, web_micro::text as web from agent_runs where id = $1", [run.id])
        ).rows[0]!;
        // A provider's model costs nothing but the searches its tool held (tools/web/hold.ts): those count with its lane.
        if (money.price === null || row.charge_to === null) return (await budgetReachedWith(t, lane, agent, BigInt(row.web), config)) ? "final" : "ok";
        const reported = spent !== null && isCount(spent.inputTokens) && isCount(spent.outputTokens);
        const cost = costMicro(money.price, reported ? spent.inputTokens : estimated.inputChars, reported ? spent.outputTokens : estimated.outputChars);
        const held = BigInt(row.hold);
        // The web searches its tool held, at their fixed price (tools/web/hold.ts): part of the hold, outside the model's
        // clip below, and counted with so far wherever so far is (0 for a reply that made none: every number as before).
        const searched = BigInt(row.web);
        // The room kept for a last call on the free allowance (`RunMoney.reserveMicro`): this call is within it.
        const reserve = row.charge_to === "free" ? money.reserveMicro : 0n;
        // So far is at most what the reply held for its calls: each was held at its most before it was made, so a round
        // reported above that is the upstream's error — forgiven at settlement, never held for.
        const modelHeld = held - reserve - searched > 0n ? held - reserve - searched : 0n;
        const sofar = cost < modelHeld ? cost : modelHeld;
        const next = costMicro(money.price, nextInputTokens, money.maxOutputTokens);
        // Another round must keep room for a last call after it: renewed from the next call's input bound and what one
        // round can add, at most the whole of a call (`roomGrowth`); short of it on the free allowance, the next call is
        // the last.
        const renewed =
          reserve === 0n ? 0n : costMicro(money.price, Math.min(nextInputTokens + money.growthTokens, money.roomCapTokens), money.maxOutputTokens);
        const tools =
          sofar + searched + next <= BigInt(config.tools.maxPoints) * MICRO_PER_POINT && !(await budgetReachedWith(t, lane, agent, sofar + searched, config));
        const answer = await raiseHold(
          t,
          config,
          { id: run.id, ownerId: run.ownerId, chargeTo: row.charge_to, holdMicro: held },
          { ok: sofar + searched + next + renewed, final: sofar + searched + next },
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
   * nothing: every token of its run is taken out (tools/refs.ts `takeCites`). Refused, or empty, as `post`.
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
    const mark = flags?.mark ?? null;
    const reply: AgentReply = { ...said, refs: flags?.tools?.refs ?? null };
    try {
      const posted = await this.deps.db.tx((t) => postAsAgent(t, run.agentId, run.conversationId, run.id, reply, mark, this.deps.config, as));
      if (!posted) return "empty";
      const { message, duplicate, triggered } = posted;
      // In a group, the notices the Agent's message led to follow it; the runs it called for go to their owners, the
      // calls over its owner's limit on other people's Agents are only logged, and the owners of Agents whose others'
      // daily budget it found spent are pushed them.
      if (!duplicate) this.deps.conversations.publish({ messages: [message, ...triggered.notices], conversations: [] }, this.deps.log);
      if (!duplicate && typeof message.body.proposalId === "string") this.deps.realtime.pushAgentChanged(run.ownerId, run.agentId);
      actOnTriggered(triggered, { announce: (called) => this.announce(called), log: this.deps.log, realtime: this.deps.realtime });
      // The group moved on: a judgement waiting there for a person's message is dropped (the decision would refuse that
      // message now). Nothing ever waits in the Agent's own conversation.
      if (!duplicate) this.deps.proactive?.cancelled(run.conversationId);
      return "posted";
    } catch (err) {
      if (err instanceof AppError && REFUSED.has(err.code)) return "refused";
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
    if (result.reply !== null) {
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
      const removed = refused && run.conversationId !== agent.conversationId && !(await currentMembership(t, run.conversationId, agent.id));
      const final = recorded(end, { posted: reply !== undefined, interrupted: state.rows[0].interrupted, agent, removed });
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
        next === null ? followUpOf(null) : await followUp(t, agent, run.conversationId, Number(state.rows[0].covers_seq ?? 0), next, state.rows[0].call_seqs, config);
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

/** A run's flags as an attempt starts. */
const freshFlags = (): RunFlags => ({ stop: false, silenced: false, group: false, mark: null, money: null, model: null, leftOut: null, tools: null });

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
      ? { status: "cancelled", error: state.interrupted }
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
    next === null ? followUpOf(null) : await followUp(t, agent, conversationId, Number(state.covers_seq ?? 0), next, state.call_seqs, config);
  return {
    runs: followed ? [ended, followed] : [ended],
    told,
    charged: posted ? { conversationId, ownerId: agent.ownerId, seq: Number(posted.seq) } : null,
    retried,
  };
}

/**
 * How long a run must have been `running` before the stale-run sweep may release it: twice the longer of a call's time
 * limit (`AGENT_RUN_TIMEOUT_MS`) and a reply's with tools (`TOOLS.runTimeoutMs`) — the reading of its attachments, then
 * its call or its rounds — and a minute for posting and recording. With the defaults 2 × max(120 s, 300 s) + 60 s: 11
 * minutes.
 */
export const staleAfterMs = (config: { agentRunTimeoutMs: number; tools: Pick<Config["tools"], "runTimeoutMs"> }): number =>
  2 * Math.max(config.agentRunTimeoutMs, config.tools.runTimeoutMs) + 60_000;

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
