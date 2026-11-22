import { DEFAULT_TOOLS, type ToolsConfig } from "../../config.ts";
import { LookedUp, type LookupFields } from "../../messages/lookups.ts";
import { isCount } from "../../metering/prices.ts";
import { estimateTokens, holdTokens, TOOL_PREAMBLE_TOKENS, TOOL_TEXT_FACTOR, weightWithin } from "../../metering/tokens.ts";
import { ModelError, type ModelCall, type ModelGateway, type ToolCall, type ToolResult } from "../../models/gateway.ts";
import { cleanModelText, hasVisibleText } from "../../schemas.ts";
import { cutResult, FINAL_LINE, fitsSchema, isRefusal, LoopGuard, OVER_CAP, REPEATED, UNUSABLE, withFinalLine } from "./loop.ts";
import {
  BUSY,
  failedEnd,
  isRunEnd,
  NOTHING,
  RunNotRunning,
  UNAVAILABLE,
  type Activity,
  type AgentPort,
  type Estimated,
  type Prepared,
  type Reply,
  type RunEnd,
  type RunErrorCode,
  type RunTicket,
  type ToolOutcome,
  type ToolRun,
  type ToolTrace,
  type Usage,
} from "./port.ts";
import { partText } from "./context.ts";
import { ReplyStream } from "./stream.ts";
import { fileNumber } from "../tools/refs.ts";
import { CLOSE, OPEN, tokenRef } from "../tools/tokens.ts";
import { queryForm } from "../tools/web/text.ts";

/**
 * The reply worker (README "Agents and runs"): claims queued replies, calls the model, streams the reply to the owner
 * and posts it, all through `AgentPort`. A reply that offers tools calls the model round by round, runs the calls it
 * makes through the port between them, and ends its tool phase with one last call that may call none (`toolReply`). It
 * runs in the service's process; it never holds a database transaction open across a model call (begin, post, extend
 * and finish are each their own).
 */

/** How often the worker looks for queued replies besides being woken by a trigger. */
export const POLL_MS = 2_000;
/** How often a reply in flight checks whether it should stop (owner's stop, pause, delete). */
export const STOP_CHECK_MS = 50;
/**
 * How long the service's stop gives the runs it was working on to end (their calls abandoned, each ended as recovery
 * would end it, `AgentPort.release`), and the persona drafts under way likewise; what has not ended by then is left
 * `running`, for the stale-run sweep or the next start.
 */
export const SHUTDOWN_GRACE_MS = 5_000;

/** Whether `promise` settled within `ms` (it is not stopped when it did not). */
export async function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([promise.then(() => true, () => true), late]);
  } finally {
    clearTimeout(timer);
  }
}

export interface WorkerLog {
  info(details: Record<string, unknown>, msg: string): void;
  error(details: Record<string, unknown>, msg: string): void;
  warn(details: Record<string, unknown>, msg: string): void;
}

export interface WorkerOptions {
  port: AgentPort;
  models: Pick<ModelGateway, "stream">;
  /** A reply still streaming after this long is ended: posted as truncated if it said something, else failed. */
  runTimeoutMs: number;
  /**
   * Replies the background loop runs at once in the whole service (`AGENT_MAX_RUNS_IN_FLIGHT`): each holds its
   * attachments in memory and an outbound call (see the guard's own cap). `runOnce` is not counted against it.
   */
  maxRunsInFlight: number;
  /** False: no background loop; replies run only through `runOnce` / `drain` (tests drive the worker by hand). */
  background: boolean;
  log: WorkerLog;
  /** What bounds a reply that offers tools (`TOOLS`); default the configuration's defaults. */
  tools?: ToolLimits;
}

/**
 * The site's bounds of a reply's tool rounds: at most `maxRounds` rounds that call tools, each result cut to
 * `resultMaxWeight`, the whole reply within `runTimeoutMs` (each model call and each tool also within `runTimeoutMs` of
 * `WorkerOptions`, `AGENT_RUN_TIMEOUT_MS`).
 */
export type ToolLimits = Pick<ToolsConfig, "maxRounds" | "resultMaxWeight" | "runTimeoutMs">;

export interface AgentWorker {
  /** Starts the background loop (when there is one). */
  start(): void;
  /** Looks for queued replies now: a trigger's post-commit signal. */
  wake(): void;
  /** Claims the oldest queued reply and runs it to its end; false when none was queued. */
  runOnce(): Promise<boolean>;
  /** Whether this worker is working on the run now (from its claim until its `finish` has returned). */
  isWorking(runId: string): boolean;
  /** `runOnce` until nothing is queued (follow-ups included); how many ran. */
  drain(): Promise<number>;
  /** Resolves once no claim is under way and no run is in flight (for tests: what a finished test leaves running). */
  idle(): Promise<void>;
  /**
   * Holds the background loop (for tests: the harness between two tests, tests/helpers/harness.ts): from now on no claim
   * starts by itself — neither the poll nor a wake-up; one asked for meanwhile is made once released — and a pump under way
   * claims nothing more (`idle()` waits for it). `runOnce` and `drain` still claim. Returns the release (once; holds nest).
   */
  hold(): () => void;
  /**
   * Stops (once; later calls wait for the same stop): no more claims; calls in flight, and replies still reading their
   * attachments, are abandoned without posting or admitting, and each such run is ended here as recovery would end it
   * (`AgentPort.release`); replies already being posted finish. Resolves once nothing runs any more, or after
   * `SHUTDOWN_GRACE_MS` at most: a run whose end could not be written by then (or at all) stays `running`, for the
   * stale-run sweep or the next start.
   */
  stop(): Promise<void>;
}

type Interruption = "stop" | "timeout" | "shutdown";

/** How a model round finished: its usage, whether it was cut at its limit, the tools it called and its assistant turn. */
interface Finished {
  usage: Usage | null;
  truncated: boolean;
  toolCalls: ToolCall[];
  assistant: unknown;
  toolsRefused: boolean;
}

/** One model round as the worker saw it end. */
interface Round {
  /** Its finish — or, for a failure the upstream reported usage for (`thinking_exhausted`), that usage, as cut; else null. */
  finished: Finished | null;
  failure: RunErrorCode | null;
  /** A failure's upstream HTTP status, when the upstream answered with one. */
  status?: number;
  why: Interruption | null;
  /** Whether the model was called at all: a stop, pause or close before it means no call was made. */
  opened: boolean;
  /** Whether any text or thinking came in this round (what decides whether a failure without a status is passing). */
  said: boolean;
}

/** A reply that can make no further call: what it wrote stands, as cut. */
const CUT_SHORT: Finished = { usage: null, truncated: true, toolCalls: [], assistant: [], toolsRefused: false };

/**
 * `extend` said "stop": the run is no longer running here (ended elsewhere meanwhile), and it wrote nothing; `finish`
 * finds it so and leaves it as that recorded it. Money never stops a reply that has started: short of it, the next call is
 * its last ("final").
 */
const ENDED_ELSEWHERE: RunEnd = { status: "cancelled" };

/**
 * What a reply's rounds used, for its one settlement (and for `extend`, which counts it the same way): each round's
 * reported usage and its estimate (`Estimated`). `usage` is the rounds' sum, or null when there is no round or any round
 * reported none — settlement then counts `estimated`, and the record says it was estimated: per round its reported
 * usage when it has one (hidden reasoning included, as the upstream counts it), its estimate only when it has none.
 */
class Meter {
  private readonly rounds: Array<{ usage: Usage | null; input: number; output: number }> = [];

  add(usage: Usage | null, input: number, output: number): void {
    this.rounds.push({ usage, input, output });
  }

  usage(): Usage | null {
    let inputTokens = 0;
    let outputTokens = 0;
    for (const { usage } of this.rounds) {
      if (usage === null) return null;
      inputTokens += usage.inputTokens;
      outputTokens += usage.outputTokens;
    }
    return this.rounds.length === 0 ? null : { inputTokens, outputTokens };
  }

  estimated(): Estimated {
    let inputChars = 0;
    let outputChars = 0;
    for (const { usage, input, output } of this.rounds) {
      const reported = usage !== null && isCount(usage.inputTokens) && isCount(usage.outputTokens);
      inputChars += reported ? usage.inputTokens : input;
      outputChars += reported ? usage.outputTokens : output;
    }
    return { inputChars, outputChars };
  }
}

/** `promise`, or `signal`'s reason as soon as it aborts (a rejection of `promise` after that is nobody's). */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  promise.catch(() => {});
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => (signal.removeEventListener("abort", onAbort), resolve(v)),
      (e: unknown) => (signal.removeEventListener("abort", onAbort), reject(e)),
    );
  });
}

/**
 * The numbers of the web pages a web search's output handed out (`〔w3〕` is 3), in order: what its trace keeps
 * (`ToolTrace.pages`), read from the results' `ref`s (tools/web/tool.ts), before the output is cut for the model.
 */
function pagesOf(output: unknown): number[] {
  const results = typeof output === "object" && output !== null ? (output as { results?: unknown }).results : undefined;
  if (!Array.isArray(results)) return [];
  return results.flatMap((r): number[] => {
    const ref = typeof r === "object" && r !== null ? (r as { ref?: unknown }).ref : undefined;
    if (typeof ref !== "string" || !ref.startsWith(OPEN) || !ref.endsWith(CLOSE)) return [];
    const n = tokenRef(ref.slice(OPEN.length, -CLOSE.length), true);
    return n !== null && n.startsWith("w") ? [Number(n.slice(1))] : [];
  });
}

/** What a call the loop or its tool did not run was answered with: the sentence of its `{error}` or `{note}`, else `UNUSABLE`. */
function sentenceOf(output: unknown): string {
  const o = typeof output === "object" && output !== null ? (output as { error?: unknown; note?: unknown }) : {};
  return typeof o.error === "string" ? o.error : typeof o.note === "string" ? o.note : UNUSABLE;
}

/** What goes between two rounds' text (or reasoning) in a reply: a paragraph break after visible text, none at its start. */
function gapAfter(so: string): string {
  if (!hasVisibleText(so) || so.endsWith("\n\n")) return "";
  return so.endsWith("\n") ? "\n" : "\n\n";
}

export function createAgentWorker(opts: WorkerOptions): AgentWorker {
  const { port, models, log, maxRunsInFlight } = opts;
  const inFlight = new Set<Promise<void>>();
  /** Per run being worked on: aborts when the service closes. */
  const shutdowns = new Map<string, AbortController>();
  let started = false;
  let closing = false;
  let pumping: Promise<void> | null = null;
  let stopping: Promise<void> | null = null;
  let again = false;
  let timer: NodeJS.Timeout | null = null;
  /** How many `hold()`s are not yet released, and whether a wake-up came meanwhile (answered at the last release). */
  let holds = 0;
  let wokenWhileHeld = false;

  async function finish(run: RunTicket, end: RunEnd, usage: Usage | null, fallback: Estimated): Promise<void> {
    try {
      await port.finish(run, end, usage, fallback);
    } catch (err) {
      log.error({ err, runId: run.id }, "agent run: could not record how it ended; it stays running until the stale-run sweep or the next start releases it");
    }
  }

  /**
   * The service is closing: the run is ended here, as recovery would end it, instead of being left for the next start —
   * with what is known here of its reply (`progress`: it had produced something; `AgentPort.release`).
   */
  async function release(run: RunTicket, progress = false): Promise<void> {
    try {
      await port.release(run, progress);
    } catch (err) {
      log.error({ err, runId: run.id }, "agent run: could not be ended as the service closed; it stays running until the stale-run sweep or the next start releases it");
    }
  }

  /** The replies (this attempt's ticket) whose run has been told they produced something. */
  const producing = new WeakSet<RunTicket>();
  /**
   * The reply has produced something — its first piece of text or thinking, in any round: told the port once per reply,
   * for its run to record (`AgentPort.progressed`), so that the run lost after it is no passing failure either. A failure
   * to record it is logged and the reply goes on (only a crash after it would then be taken as passing).
   */
  async function produced(run: RunTicket): Promise<void> {
    if (producing.has(run)) return;
    producing.add(run);
    try {
      await port.progressed(run);
    } catch (err) {
      log.warn({ err, runId: run.id }, "agent run: could not record that its reply had produced something");
    }
  }

  async function post(run: RunTicket, reply: Reply): Promise<"posted" | "refused" | "empty" | "failed"> {
    try {
      return await port.post(run, reply);
    } catch (err) {
      log.error({ err, runId: run.id }, "agent run: could not post the reply");
      return "failed";
    }
  }

  /** The end of a run whose reply was offered to `post`; a reply that could not be stored is our failure, not the provider's. */
  const ended = (posted: "posted" | "refused" | "failed", ok: RunEnd): RunEnd =>
    posted === "posted" ? ok : posted === "refused" ? { status: "cancelled" } : BUSY;

  /**
   * One model call (`request` and an abort signal of its own), what the model says going to `say` as it comes: how it
   * ended. It is abandoned at once when the owner stops the reply, after `timeoutMs`, and when the service closes.
   */
  async function call(
    run: RunTicket,
    request: Omit<ModelCall, "signal">,
    say: (kind: "text" | "reasoning", delta: string) => void,
    shutdown: AbortSignal,
    timeoutMs: number,
  ): Promise<Round> {
    const controller = new AbortController();
    let why: Interruption | null = null;
    const interrupt = (reason: Interruption): void => {
      if (why !== null) return;
      why = reason;
      controller.abort(new Error(`agent run interrupted: ${reason}`));
    };
    const onShutdown = () => interrupt("shutdown");
    const stopCheck = setInterval(() => port.shouldStop(run) && interrupt("stop"), STOP_CHECK_MS);
    const deadline = setTimeout(() => interrupt("timeout"), timeoutMs);
    stopCheck.unref();
    deadline.unref();
    shutdown.addEventListener("abort", onShutdown, { once: true });
    if (shutdown.aborted) interrupt("shutdown");
    if (port.shouldStop(run)) interrupt("stop");

    let finished: Finished | null = null;
    let failure: RunErrorCode | null = null;
    let status: number | undefined;
    let opened = false;
    let spoke = false;
    try {
      if (why === null) {
        opened = true;
        for await (const event of models.stream({ ...request, signal: controller.signal })) {
          if (event.type === "finish") {
            const { usage, truncated, toolCalls, assistant } = event;
            finished = { usage, truncated, toolCalls, assistant, toolsRefused: event.toolsRefused === true };
            break;
          }
          // Acted on at the finish, which alone says whether the round was cut (a call offering no tools gets none).
          if (event.type === "tool_call") continue;
          // The upstream refused the request carrying an earlier reply's tool use; it was made again with that lowered
          // (gateway.ts `replay_lowered`). Counted only, by protocol: a broken builder shows as a rising count.
          if (event.type === "replay_lowered") {
            log.info({ metric: "replay_lowered", protocol: request.protocol }, "agent run: a request carrying earlier tool calls was refused; it was made again without them");
            continue;
          }
          if (event.delta !== "") spoke = true;
          say(event.type, event.delta);
          // The reply's first piece: its run records that it has produced something (once per reply, before more is read).
          if (spoke && !producing.has(run)) await produced(run);
          if (port.shouldStop(run)) {
            interrupt("stop");
            break;
          }
        }
      }
    } catch (err) {
      if (why === null) {
        failure = err instanceof ModelError ? err.code : "provider_unavailable";
        // A failure the upstream reported usage for (`thinking_exhausted`: the model did finish) is charged that usage.
        if (err instanceof ModelError && err.usage) finished = { usage: err.usage, truncated: true, toolCalls: [], assistant: [], toolsRefused: false };
        if (!(err instanceof ModelError)) log.error({ err, runId: run.id }, "agent run: the model call failed unexpectedly");
        // An upstream that refused (429) or failed (5xx) is counted: an operator reads how often from the log.
        status = err instanceof ModelError ? err.upstreamStatus : undefined;
        if (status !== undefined && (status === 429 || status >= 500)) log.info({ metric: "upstream_refused", status }, "agent run: the upstream refused the call");
      }
    } finally {
      clearInterval(stopCheck);
      clearTimeout(deadline);
      shutdown.removeEventListener("abort", onShutdown);
    }
    return { finished, failure, ...(status === undefined ? {} : { status }), why: why as Interruption | null, opened, said: spoke };
  }

  /**
   * One tool call through the port. Its signal aborts when the owner stops the reply, the service closes, the reply's
   * time is up (`deadline`), or the tool has taken `runTimeoutMs` (`AGENT_RUN_TIMEOUT_MS`); a tool that ignores it is
   * not waited for. `outcome` null: it failed or took too long (the call is answered `UNUSABLE`); `interrupted`: the
   * reply itself ends. A failure is logged by its kind only, never its message.
   */
  async function runTool(
    run: RunTicket,
    toolCall: ToolCall,
    shutdown: AbortSignal,
    deadline: number,
  ): Promise<{ outcome: ToolOutcome | null; interrupted: Interruption | null }> {
    const controller = new AbortController();
    let why: Interruption | "slow" | null = null;
    const abort = (reason: Interruption | "slow"): void => {
      if (why !== null) return;
      why = reason;
      controller.abort(new Error(`agent tool interrupted: ${reason}`));
    };
    const onShutdown = () => abort("shutdown");
    const stopCheck = setInterval(() => port.shouldStop(run) && abort("stop"), STOP_CHECK_MS);
    const slow = setTimeout(() => abort("slow"), opts.runTimeoutMs);
    const late = setTimeout(() => abort("timeout"), Math.max(0, deadline - Date.now()));
    stopCheck.unref();
    slow.unref();
    late.unref();
    shutdown.addEventListener("abort", onShutdown, { once: true });
    if (shutdown.aborted) abort("shutdown");
    try {
      return { outcome: await untilAborted(port.tool(run, toolCall, controller.signal), controller.signal), interrupted: null };
    } catch (err) {
      const reason = why as Interruption | "slow" | null;
      if (reason === null) log.error({ runId: run.id, tool: toolCall.name, failure: err instanceof Error ? err.name : typeof err }, "agent run: a tool failed");
      if (reason === "slow") log.warn({ runId: run.id, tool: toolCall.name, metric: "tool_timeout" }, "agent run: a tool took too long and was abandoned");
      return { outcome: null, interrupted: reason === null || reason === "slow" ? null : reason };
    } finally {
      clearInterval(stopCheck);
      clearTimeout(slow);
      clearTimeout(late);
      shutdown.removeEventListener("abort", onShutdown);
    }
  }

  /**
   * What `out` has said so far, posted as the reply's acknowledgement (`AgentPort.acknowledge`), what is pending of it
   * pushed first so the owner's stream is in order with the message. Once it is posted, or found to show nothing, the
   * reply starts again (its text and reasoning are that message's, or nothing); refused, or failing (only the log hears
   * of a failure), what it said stays the reply's. Whether it was posted.
   */
  async function acknowledge(run: RunTicket, out: ReplyStream): Promise<boolean> {
    out.flushNow();
    try {
      const posted = await port.acknowledge(run, { text: cleanModelText(out.text), reasoning: cleanModelText(out.reasoning) });
      if (posted !== "refused") out.restart();
      return posted === "posted";
    } catch (err) {
      log.error({ err, runId: run.id }, "agent run: could not post its acknowledgement; what it said stays with the reply");
      return false;
    }
  }

  /** `AgentPort.toolsUnusable`, whose failure only the log hears of: the reply goes on without the tools either way. */
  async function toolsUnusable(run: RunTicket, why: "refused" | "garbled"): Promise<void> {
    try {
      await port.toolsUnusable(run, why);
    } catch (err) {
      log.error({ err, runId: run.id, why }, "agent run: could not record that its model cannot use the tools");
    }
  }

  /**
   * The end of a reply once its model has stopped — after its one call, or the last round of several (`last`): what it
   * said is posted, with what its tools looked up (`looked`; nothing for a reply offered none), or the run fails, and it
   * is settled on `usage`, else `fallback` (`failedFallback` when the run fails). `noAnswer`: how a reply that said
   * nothing fails when it did not fail otherwise. `trace`: the calls of the rounds its answer was written with
   * (`Reply.toolCalls`), handed over only with an answer — never with what a stop or a time-out left.
   */
  async function conclude(
    run: RunTicket,
    out: ReplyStream,
    last: Pick<Round, "finished" | "failure" | "why" | "status"> & { progress?: boolean },
    usage: Usage | null,
    fallback: Estimated,
    failedFallback: Estimated,
    noAnswer: RunEnd = UNAVAILABLE,
    looked: LookupFields = {},
    trace: readonly ToolTrace[] = [],
  ): Promise<void> {
    const { finished, failure, why } = last;
    // The service is closing: nothing is posted, and the run is ended here as recovery would end it (no charge).
    if (finished === null && why === "shutdown") {
      out.discard();
      return release(run, last.progress === true);
    }
    out.end();
    const failed = (end: RunEnd) => finish(run, end, usage, failedFallback);
    // Tagged passing or not by THE classifier (port.ts `passingEnding`), with the upstream's status when it answered one.
    if (failure !== null) {
      const ending = { kind: "upstream" as const, code: failure, ...(last.status === undefined ? {} : { status: last.status }), progress: last.progress === true };
      return failed(failedEnd(failure, ending, last.status === undefined ? {} : { upstreamStatus: last.status }));
    }
    // The upstream ended the stream without its finish (cut off midway).
    if (finished === null && why === null) return failed(failedEnd("provider_unavailable", { kind: "cut", progress: last.progress === true }));

    const text = cleanModelText(out.text);
    const reasoning = cleanModelText(out.reasoning);
    const said = hasVisibleText(text) || hasVisibleText(reasoning);
    // In a group `post` takes the run's mark out of what is kept of the reply (the port keeps the mark from `begin`), and
    // a reply that was nothing but the mark and labels is then "empty". Nothing of a group's reply was streamed
    // (`AgentPort.emit`).
    if (finished === null && why === "stop") {
      // Stopped by its owner (or by a pause or delete, which `post` and `finish` find out): what was said so far.
      if (!said) return finish(run, { status: "stopped" }, usage, fallback);
      const posted = await post(run, { text, reasoning, stopped: true, truncated: false, ...looked });
      // All it said was inside a persona block it never finished (in a group, also: it only thought, or said only the
      // mark and labels): as a stop with nothing said.
      if (posted === "empty") return finish(run, { status: "stopped" }, usage, fallback);
      return finish(run, ended(posted, { status: "stopped" }), usage, fallback);
    }
    // A complete answer, or one cut off by the time limit (posted as truncated). Nothing said: failed — passing only when the
    // reply's time ran out before anything came; an answer that finished with nothing in it is the provider's answer.
    if (!said) return failed(noAnswer === UNAVAILABLE ? failedEnd("provider_unavailable", finished === null ? { kind: "timeout", progress: last.progress === true } : { kind: "nothing" }) : noAnswer);
    const toolCalls = finished !== null && trace.length > 0 ? { toolCalls: trace } : {};
    const posted = await post(run, { text, reasoning, stopped: false, truncated: finished === null || finished.truncated, ...looked, ...toolCalls });
    // All it said was inside a persona block that a limit cut off (in a group, also: it only thought, or said only the
    // mark and labels): as an answer that said nothing.
    if (posted === "empty") return failed(noAnswer);
    return finish(run, ended(posted, { status: "done" }), usage, fallback);
  }

  async function execute(run: RunTicket): Promise<void> {
    const shutdown = new AbortController();
    shutdowns.set(run.id, shutdown);
    if (closing) shutdown.abort(new Error("the service is closing"));
    try {
      await work(run, shutdown.signal);
    } finally {
      // Only this attempt's: a run held back and claimed again by this worker meanwhile has its own.
      if (shutdowns.get(run.id) === shutdown) shutdowns.delete(run.id);
    }
  }

  async function work(run: RunTicket, shutdown: AbortSignal): Promise<void> {
    let prepared: Prepared | RunEnd;
    try {
      prepared = await port.begin(run, shutdown);
    } catch (err) {
      // The service is closing before the call was admitted (nothing was): the run is ended here.
      if (shutdown.aborted) return release(run);
      // Ended elsewhere meanwhile (another instance's recovery, or the stale-run sweep): expected, not an error; `finish`
      // then finds it ended and changes nothing.
      if (err instanceof RunNotRunning) log.warn({ runId: run.id, status: err.status }, "agent run: ended elsewhere before it could start; nothing is called");
      else log.error({ err, runId: run.id }, "agent run: could not start");
      return finish(run, BUSY, null, NOTHING);
    }
    if (isRunEnd(prepared)) return finish(run, prepared, null, NOTHING);
    if (prepared.tools.length > 0 && prepared.toolRun !== null) return toolReply(run, prepared, prepared.toolRun, shutdown);

    // A reply that offers no tools: one call, as before tools existed.
    const out = new ReplyStream((delta) => port.emit(run, delta));
    const round = await call(run, prepared.call, (kind, delta) => out.add(kind, delta), shutdown, opts.runTimeoutMs);
    const usage = round.finished?.usage ?? null;
    // A call never made (a stop or pause landed between `begin` and it) costs nothing, not even its input.
    const fallback = round.opened ? { inputChars: prepared.inputChars, outputChars: out.outputChars() } : NOTHING;
    // A failed call is charged only what the upstream reported: what it said is discarded and not counted. Whether the reply
    // had produced anything (port.ts `passingEnding`): what its one call streamed.
    return conclude(run, out, { ...round, progress: round.said }, usage, fallback, { ...fallback, outputChars: 0 });
  }

  /**
   * A reply that offers tools (README "Agents and runs", Tools in a reply). Round by round, the model is called with the
   * tools and, after the first round, every round so far (`steps`); a round that calls none is the answer. Each call of
   * a round that called tools is answered, in order, by its place in the round (never by its id), with its own id and
   * name as it came:
   * - garbled — a tool not offered, an input null or one the tool's schema refuses (`fitsSchema`), or any call of a round
   *   cut at its limit (its input may be cut) — is not run: `UNUSABLE`; the reply's second marks the tools unusable;
   * - a repeat (`LoopGuard`) is answered `REPEATED`, a call over its tool's count `OVER_CAP`, neither run;
   * - anything else runs through the port (`runTool`), its output cut (`cutResult`) to `resultMaxWeight` and to what the
   *   model's context has left for the rounds (`room`: what the plan's limit, `ToolRun.limit`, leaves beside the planned
   *   input, the tools' definitions and the last call's line, at the plan's ratio — the tools' text, definitions, steps and
   *   results alike, times `TOOL_TEXT_FACTOR` — and what providers add around the definitions — at least the room the
   *   plan kept for results).
   * While a tool runs the reply's status says its kind (`AgentPort.activity`, from `ToolRun.kinds`, once per change), and
   * nothing as soon as the model is called again; the counts, the messages found and the search words of the calls that
   * ran and answered go with the posted reply (messages/lookups.ts `LookedUp`).
   * Then the port holds what the next call can cost (`extend`; its bound: the call's text, the tools and every step at
   * their bytes, as admission holds a call, and what providers add around tool definitions, `TOOL_PREAMBLE_TOKENS`). The
   * tool phase ends — the next call is the last: the same tools and steps,
   * `toolChoice` `none`, the system text with `FINAL_LINE` — after `maxRounds` such rounds, a call made a third time, the
   * second garbled call, once the steps have filled the room, or when `extend` says "final"; a tool call that comes in
   * the last round is not run, and no call follows. An upstream that refused the tools (the first round): they are marked
   * unusable, and that round's text is the answer. A later round the upstream refuses (400 or 422: something in the
   * rounds it will not take) is followed, once, by the ordinary call — no tools, no rounds, its cost held first — whose
   * answer is the reply's. `extend` saying "stop" — the run no longer running here; money never says it — ends the reply
   * with what it wrote, as cut (nothing written: `ENDED_ELSEWHERE`). A stop, the reply's time (`runTimeoutMs` in all; each call and tool also within
   * `AGENT_RUN_TIMEOUT_MS`) and the service closing are honoured between events, between tool calls and between rounds,
   * and end it as they end a reply of one call. Text and reasoning stream as they come, a later round's after a
   * paragraph break. What a round that calls tools has said by then, when it shows anything, is posted at once — before
   * its tools run — as the reply's acknowledgement (`acknowledge`; one per reply, the first; none when an earlier
   * attempt's stands, `ToolRun.acknowledged`), and the answer is what the
   * reply says after it; a later round's text before its calls is part of the answer. One settlement: the rounds' summed usage, or with any round unreported the sum, per round, of its
   * reported usage, or of its estimate when it reported none (the conversation's, plus the tools and the steps it carried,
   * at the model's ratio — no tools for a round whose upstream refused them; what it wrote, its calls included); a round
   * that failed counts only the usage its upstream reported. Only counts and outcome classes are logged.
   */
  async function toolReply(run: RunTicket, prepared: Prepared, bounds: ToolRun, shutdown: AbortSignal): Promise<void> {
    const limits = opts.tools ?? DEFAULT_TOOLS;
    const deadline = Date.now() + limits.runTimeoutMs;
    const tools = [...prepared.tools];
    // The ordinary call, made once after a later round its upstream refused: no tools, so the text for going without
    // them (`ModelCall.systemWithoutTools`) when the call has one.
    const { systemWithoutTools, ...withTools } = prepared.call;
    const ordinary: Omit<ModelCall, "signal"> = systemWithoutTools === undefined ? withTools : { ...withTools, system: systemWithoutTools };
    const offered = new Map(tools.map((t) => [t.name, t]));
    const toolsText = JSON.stringify(tools);
    // Every text the call sends, an earlier reply's replayed calls and results included, as the plan weighs them
    // (`partText`): what each hold below counts at its bytes.
    const texts = prepared.call.messages.flatMap((m) => m.parts.flatMap((p) => partText(p) ?? []));
    /** What the tools' text — definitions, steps, results — is planned at: the plan's ratio times `TOOL_TEXT_FACTOR`. */
    const toolRatio = bounds.planRatio * TOOL_TEXT_FACTOR;
    const room = bounds.limit - bounds.planned - estimateTokens(toolsText, toolRatio) - estimateTokens(`\n\n${FINAL_LINE}`, bounds.planRatio) - TOOL_PREAMBLE_TOKENS;
    // A file call is the same call whatever form of its file's number it gives (refs.ts `fileNumber`): `f1`, `〔f1〕`; a web
    // search the same whatever spacing, width or case its query has (tools/web/text.ts `queryForm`).
    const same = (c: ToolCall): unknown => {
      const input = c.input as Record<string, unknown> | null;
      const kind = Object.hasOwn(bounds.kinds, c.name) ? bounds.kinds[c.name] : undefined;
      if (kind === "web" && input !== null && typeof input === "object" && typeof input.query === "string") return { ...input, query: queryForm(input.query) };
      return kind === "file" && input !== null && typeof input === "object" && typeof input.file === "string" ? { ...input, file: fileNumber(input.file) } : c.input;
    };
    const guard = new LoopGuard({ maxRounds: limits.maxRounds, perTool: bounds.perTool, same });
    // No token-shaped string is streamed, as the stored reply keeps none (its citations are beside its text); a reply
    // offered the web search holds its `〔w1〕` too.
    const web = Object.values(bounds.kinds).includes("web");
    const out = new ReplyStream((delta) => port.emit(run, delta), undefined, web ? "web" : true);
    const meter = new Meter();
    const steps: Array<{ assistant: unknown; results: ToolResult[] }> = [];
    /** Each step's calls as they were answered (`ToolTrace`), step for step. */
    const traces: ToolTrace[][] = [];
    /** The calls of the steps the request that wrote the answer carried: set only when that round finished. */
    let trace: readonly ToolTrace[] = [];
    let stepsTokens = 0;
    const tally = { rounds: 0, calls: 0, ran: 0, repeats: 0, over: 0, garbled: 0, failed: 0, plain: false };
    let final = false;
    /** The upstream refused a later round: the reply is asked for once more as one without tools (`prepared.call`). */
    let plain = false;
    let unusable = false;
    /** The reply's acknowledgement was posted, or an earlier attempt's stands (`ToolRun.acknowledged`): no later round's text is. */
    let acknowledged = bounds.acknowledged === true;
    /** What the tools that ran looked up, for the reply's message. */
    const looked = new LookedUp();
    /** What the reply's status says now: the kind of the tool that is running, or nothing. */
    let shown: Activity | null = null;
    const quiet = (): void => {
      if (shown === null) return;
      shown = null;
      port.activity(run, null);
    };
    /** What ends the reply now, between two rounds or two tool calls. */
    const interrupted = (): Interruption | null =>
      shutdown.aborted ? "shutdown" : port.shouldStop(run) ? "stop" : Date.now() >= deadline ? "timeout" : null;
    /** The port's word on the next call, whose input is held at `nextInput`; failing to get it is our trouble (`BUSY`). */
    const extend = async (nextInput: number): Promise<"ok" | "final" | "stop" | "busy"> => {
      try {
        return await port.extend(run, meter.usage(), meter.estimated(), nextInput + bounds.fixedTokens);
      } catch (err) {
        log.error({ err, runId: run.id }, "agent run: could not hold what its next call can cost; it ends with what it wrote");
        return "busy";
      }
    };
    let ending: { last: Pick<Round, "finished" | "failure" | "why" | "status">; noAnswer?: RunEnd };
    /**
     * ONE fact about the reply as a whole, set once and never reset (port.ts `passingEnding`): it has produced something —
     * text or thinking received in any round, its acknowledgement posted, a tool round completed.
     */
    let progress = false;

    for (;;) {
      const now = interrupted();
      if (now !== null) {
        ending = { last: { finished: null, failure: null, why: now } };
        break;
      }
      // The model is called again: no tool is running.
      quiet();
      const request: Omit<ModelCall, "signal"> = plain
        ? ordinary
        : {
            ...prepared.call,
            ...(final ? { system: withFinalLine(prepared.call.system), toolChoice: "none" as const } : {}),
            tools,
            ...(steps.length > 0 ? { steps: [...steps] } : {}),
          };
      // How many steps this request carries: the plain call none.
      const carried = plain ? 0 : steps.length;
      const said = { text: "", reasoning: "" };
      const gap = { text: gapAfter(out.text), reasoning: gapAfter(out.reasoning) };
      const round = await call(
        run,
        request,
        (kind, delta) => {
          if (gap[kind] !== "") out.add(kind, gap[kind]);
          gap[kind] = "";
          said[kind] += delta;
          out.add(kind, delta);
        },
        shutdown,
        Math.max(0, Math.min(opts.runTimeoutMs, deadline - Date.now())),
      );
      const { finished } = round;
      if (round.said) progress = true;
      const input = plain
        ? prepared.inputChars
        : prepared.inputChars + estimateTokens(toolsText + (steps.length > 0 ? JSON.stringify(steps) : "") + (final ? `\n\n${FINAL_LINE}` : ""), bounds.ratio);
      if (round.failure !== null) {
        // A failed round counts only what its upstream reported.
        if (finished?.usage) meter.add(finished.usage, input, 0);
        // A later round the upstream refused (400, 422: something in the rounds it will not take, which nothing of ours can
        // mend): once, the reply is asked for as one that offers no tools, from the conversation alone, its cost held first.
        if (steps.length > 0 && !plain && (round.status === 400 || round.status === 422)) {
          const next = await extend(holdTokens([ordinary.system, ...texts], bounds.contextTokens, prepared.call.maxOutputTokens));
          if (next === "stop" || next === "busy") {
            ending = { last: { finished: CUT_SHORT, failure: null, why: null }, noAnswer: next === "stop" ? ENDED_ELSEWHERE : BUSY };
            break;
          }
          plain = true;
          tally.plain = true;
          continue;
        }
        ending = { last: round };
        break;
      }
      if (finished === null) {
        // Interrupted (stop, time, close: what it wrote counts), or cut off by the upstream (failed: nothing does).
        if (round.why !== null && round.opened) meter.add(null, input, estimateTokens(said.text) + estimateTokens(said.reasoning));
        ending = { last: round };
        break;
      }
      const calls = finished.toolCalls.length > 0 ? estimateTokens(JSON.stringify(finished.toolCalls)) : 0;
      // A round whose upstream refused the tools was answered without them: its input is the conversation's alone.
      const refused = finished.toolsRefused && !final;
      meter.add(finished.usage, refused ? prepared.inputChars : input, estimateTokens(said.text) + estimateTokens(said.reasoning) + calls);
      if (refused) {
        // Its upstream refused the tools: this round's text is the answer, and nothing more is called.
        await toolsUnusable(run, "refused");
        ending = { last: round };
        break;
      }
      // An answer; or the last round, whose tool calls are not run. Its request carried `carried` steps: their calls are
      // what the answer was written with (harness design §3).
      if (final || plain || finished.toolCalls.length === 0) {
        ending = { last: round };
        trace = traces.slice(0, carried).flat();
        break;
      }
      // Work follows: what the reply said before it, when it shows anything, is posted at once as its acknowledgement —
      // one per reply — and the answer is what it says after it.
      if (!acknowledged && hasVisibleText(cleanModelText(out.text))) acknowledged = await acknowledge(run, out);
      if (acknowledged) progress = true;

      guard.roundDone();
      tally.rounds++;
      const results: ToolResult[] = [];
      const roundTrace: ToolTrace[] = [];
      let left = room - stepsTokens - estimateTokens(JSON.stringify({ assistant: finished.assistant, results: [] }), toolRatio);
      let cut: Interruption | null = null;
      for (const toolCall of finished.toolCalls) {
        cut = interrupted();
        if (cut !== null) break;
        tally.calls++;
        const spec = toolCall.input === null ? undefined : offered.get(toolCall.name);
        let output: unknown;
        /** The call as its trace keeps it when it ran and answered with something usable; else it was refused. */
        let traced: ToolTrace | null = null;
        if (finished.truncated || spec === undefined || !fitsSchema(toolCall.input, spec.parameters)) {
          tally.garbled++;
          output = { error: UNUSABLE };
        } else {
          const admitted = guard.admit(toolCall);
          if (admitted === "repeat") {
            tally.repeats++;
            output = { note: REPEATED };
          } else if (admitted === "over") {
            tally.over++;
            output = { note: OVER_CAP };
          } else {
            // The status says what this tool does while it runs (its kind from the offer), once per change; a tool with
            // no kind shows nothing.
            const kind = Object.hasOwn(bounds.kinds, toolCall.name) ? bounds.kinds[toolCall.name] : undefined;
            if (kind === undefined) quiet();
            else if (kind !== shown) {
              shown = kind;
              port.activity(run, kind);
            }
            const ran = await runTool(run, toolCall, shutdown, deadline);
            if (ran.interrupted !== null) {
              cut = ran.interrupted;
              break;
            }
            if (ran.outcome === null) {
              tally.failed++;
              output = { error: UNUSABLE };
            } else {
              tally.ran++;
              const framing = estimateTokens(JSON.stringify({ id: toolCall.id, name: toolCall.name, output: "" }), toolRatio);
              try {
                output = cutResult(ran.outcome.output, Math.min(limits.resultMaxWeight, weightWithin(Math.max(0, left - framing), toolRatio)));
                // It ran and answered with something usable: what it looked up is the reply's. Its own refusal is not.
                if (!isRefusal(ran.outcome.output)) {
                  looked.ran(kind, ran.outcome);
                  traced = {
                    name: toolCall.name,
                    round: tally.rounds,
                    outcome: "ok",
                    input: toolCall.input,
                    ...(kind === "search" ? { found: ran.outcome.found?.length ?? 0 } : {}),
                    ...(kind === "web" ? { pages: pagesOf(ran.outcome.output) } : {}),
                  };
                }
              } catch {
                // Not JSON (a port's bug): nothing of it goes to the model.
                tally.failed++;
                output = { error: UNUSABLE };
              }
            }
          }
        }
        const result: ToolResult = { id: toolCall.id, name: toolCall.name, output };
        results.push(result);
        // Refused (the tool's refusal, the loop's note, garbled, failed): the sentence it got, never its input.
        roundTrace.push(traced ?? { name: toolCall.name, round: tally.rounds, outcome: "refused", said: sentenceOf(output) });
        left -= estimateTokens(JSON.stringify(result), toolRatio);
      }
      if (cut !== null) {
        ending = { last: { finished: null, failure: null, why: cut } };
        break;
      }
      const step = { assistant: finished.assistant, results };
      steps.push(step);
      traces.push(roundTrace);
      // A tool round has completed: the reply has done something.
      progress = true;
      stepsTokens += estimateTokens(JSON.stringify(step), toolRatio);
      if (tally.garbled >= 2 && !unusable) {
        unusable = true;
        await toolsUnusable(run, "garbled");
      }

      // What the next call can cost, held before it is made: its text, the tools and every step at their bytes, what
      // providers add around tool definitions, its images and PDFs at their constants, and its whole output. The last
      // call's line is in it whichever call is next: the port may answer "ok" and the call still be the last (the caps
      // and the room below), so one bound is held, the last call's. When no further call can be made, what the reply
      // wrote stands, as cut.
      const next = await extend(
        holdTokens([withFinalLine(prepared.call.system), ...texts, toolsText, JSON.stringify(steps)], bounds.contextTokens, prepared.call.maxOutputTokens) +
          TOOL_PREAMBLE_TOKENS,
      );
      if (next === "stop" || next === "busy") {
        ending = { last: { finished: CUT_SHORT, failure: null, why: null }, noAnswer: next === "stop" ? ENDED_ELSEWHERE : BUSY };
        break;
      }
      final = next === "final" || guard.exhausted() || guard.mustEnd() || unusable || stepsTokens >= room;
    }

    quiet();
    log.info({ metric: "tool_rounds", runId: run.id, ...tally, final }, "agent run: its tool rounds");
    const estimate = meter.estimated();
    return conclude(run, out, { ...ending.last, progress }, meter.usage(), estimate, estimate, ending.noAnswer, looked.fields(), trace);
  }

  function track(run: RunTicket): Promise<void> {
    const running = execute(run).catch((err: unknown) => log.error({ err, runId: run.id }, "agent run failed"));
    inFlight.add(running);
    void running.then(() => {
      inFlight.delete(running);
      wake(); // its follow-up, or a reply that waited for a free place
    });
    return running;
  }

  function wake(): void {
    if (!opts.background || !started || closing) return;
    if (holds > 0) {
      wokenWhileHeld = true;
      return;
    }
    if (pumping) {
      again = true;
      return;
    }
    const pump = (async () => {
      try {
        do {
          again = false;
          while (!closing && holds === 0 && inFlight.size < maxRunsInFlight) {
            const run = await port.claimNext();
            if (!run) break;
            void track(run);
          }
        } while (again && !closing);
      } catch (err) {
        log.error({ err }, "agent worker: could not claim a reply; trying again shortly");
      }
    })();
    // Cleared once the pump has ended, never before it is set: a pump with every place taken ends without awaiting
    // anything, and a `finally` inside it would run before this assignment and leave the worker stuck for good. A
    // wake-up that came after the pump's last look is answered by a new one.
    pumping = pump.finally(() => {
      pumping = null;
      if (again) wake();
    });
  }

  return {
    start() {
      if (started || closing) return;
      started = true;
      if (!opts.background) return;
      timer = setInterval(wake, POLL_MS);
      timer.unref();
      wake();
    },
    wake,
    isWorking: (runId) => shutdowns.has(runId),
    async runOnce() {
      if (closing) return false;
      const run = await port.claimNext();
      if (!run) return false;
      await track(run);
      return true;
    },
    async drain() {
      let n = 0;
      while (await this.runOnce()) n++;
      return n;
    },
    async idle() {
      while (pumping || inFlight.size > 0) await Promise.allSettled([pumping, ...inFlight]);
    },
    hold() {
      holds++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holds--;
        if (holds === 0 && wokenWhileHeld) {
          wokenWhileHeld = false;
          wake();
        }
      };
    },
    stop() {
      stopping ??= (async () => {
        closing = true;
        if (timer) clearInterval(timer);
        for (const shutdown of shutdowns.values()) shutdown.abort(new Error("the service is closing"));
        const ended = (async () => {
          await pumping;
          await Promise.all([...inFlight]);
        })();
        if (!(await within(ended, SHUTDOWN_GRACE_MS))) {
          log.warn(
            { runIds: [...shutdowns.keys()] },
            `agent worker: replies not ended within ${SHUTDOWN_GRACE_MS} ms of the stop; they stay running until the stale-run sweep or the next start releases them`,
          );
        }
      })();
      return stopping;
    },
  };
}
