import type { LookupFields } from "../../messages/lookups.ts";
import type { ModelCall, ToolCall, ToolSpec } from "../../models/gateway.ts";

/**
 * `AgentPort`: the reply worker's whole view of the system (README "Agents and runs"). Everything under
 * `src/agents/runtime/` reaches the database only through it (`tests/agent-port-boundary.test.ts`); its implementation,
 * where the SQL is, lives outside (`src/agents/port-impl.ts`). It is the shape an external Agent's connection would
 * have: read what the Agent may see, post as the Agent, report how a reply ended.
 */

/** A reply run the worker has claimed (it is `running`). */
export interface RunTicket {
  readonly id: string;
  readonly agentId: string;
  readonly ownerId: string;
  /** The run's own conversation (`agent_runs.conversation_id`), not necessarily the Agent's dedicated one. */
  readonly conversationId: string;
}

/** A run ready for its model call: the call (everything but its abort signal), its input size, and the tools it offers. */
export interface Prepared {
  /** Holds a provider's key in plaintext: hand it to the gateway and nowhere else. Never carries `tools` itself. */
  readonly call: Omit<ModelCall, "signal">;
  /**
   * The call's input estimate: the system text and the turns in weight, corrected by the model's learned ratio, images
   * and PDFs at their constants (metering/tokens.ts) — what settlement counts when the upstream reports no usage (and
   * charges at most what admission held, the input's bound: `holdTokens`). A whole number of 0 or more. Without the
   * tools' definitions and the rounds: a reply that offers tools adds those per round (worker.ts).
   */
  readonly inputChars: number;
  /**
   * The tools the model is offered. Empty: none — the reply is exactly one call, as before tools existed, and `toolRun`
   * is null. Otherwise the reply runs the tool loop (worker.ts), bounded by `toolRun`; its context was planned with the
   * tools' definitions and room for their results reserved (port-impl.ts `begin`: with too little room left for the
   * conversation, none are offered).
   */
  readonly tools: readonly ToolSpec[];
  readonly toolRun: ToolRun | null;
}

/** What bounds a reply's tool rounds besides the site's `TOOLS` (the worker's `ToolLimits`): the run's own numbers. */
export interface ToolRun {
  /** At most how many calls of each tool, by name, one reply runs (loop.ts `LoopGuard`); a tool not named has only the round cap. */
  readonly perTool: Readonly<Record<string, number>>;
  /**
   * What each tool's work is, by name: what the reply's status says while it runs (`AgentPort.activity`) and what it is
   * counted under in what the reply looked up (`Reply.lookups`). A tool not named shows nothing and counts nothing.
   */
  readonly kinds: Readonly<Record<string, Activity>>;
  /**
   * An acknowledgement already stands for what the reply answers — an earlier attempt at the same question posted one and
   * never answered (a retry; agents/conversation.ts `standingAcknowledgement`) — so it posts none (worker.ts). Absent: false.
   */
  readonly acknowledged?: boolean;
  /** The model's context, in tokens. */
  readonly contextTokens: number;
  /** The images and PDFs the call shows, at their constants (metering/prices.ts): sent, and held, in every round. */
  readonly fixedTokens: number;
  /** The model's learned ratio: a round's added text is estimated at it when no usage is reported, as `inputChars` is. */
  readonly ratio: number;
  /**
   * The ratio the context was planned at (metering/tokens.ts `planRatio`) and the call's input as planned at it (its text
   * times that ratio, images and PDFs at their constants): what the rounds may add is what the plan's limit leaves.
   */
  readonly planRatio: number;
  readonly planned: number;
  /**
   * The most the plan lets one call's input take, at `planRatio` (port-impl.ts `begin`): the system text, what was
   * reserved beside it — the tools' definitions and what providers add around them, the last call's line, and room for
   * what the tools bring back — and what the conversation may take before a group's cap (`contextBudget`). What the
   * rounds may add is what it leaves beside `planned`, the definitions, the line and that framing: at least the room
   * kept for results, and whatever of its budget the conversation left unused.
   */
  readonly limit: number;
}

/** The status a tool's work shows while a reply runs tools. */
export type Activity = "search" | "file" | "time";

/**
 * What a tool call gave: its output (JSON-serialisable), for the model; and, for what the reply keeps of it
 * (messages/lookups.ts), the messages it found — conversation and seq, those it handed the model, in its order — and the
 * words it searched for. Neither is shown to the model, and each reader of the reply is sent only their part of them.
 */
export interface ToolOutcome {
  output: unknown;
  /** Its kind of work. Not read: the kind comes with the offer (`ToolRun.kinds`), known before the call runs. */
  activity?: Activity;
  found?: ReadonlyArray<{ conversationId: string; seq: number }>;
  query?: string;
}

/**
 * What calls are counted at when their upstream reports no usage: tokens by the weight estimate (input times the
 * model's learned ratio; metering/tokens.ts), whole numbers of 0 or more — what settlement falls back on (settle.ts
 * `fallback`); for a reply of several rounds, each round that reported its usage counts that instead (`finish`). The
 * field names are settlement's own.
 */
export interface Estimated {
  inputChars: number;
  outputChars: number;
}

/**
 * Why a reply failed, as the owner is told (`Run.error`). `busy`: the service's own trouble (the reply could not be
 * started or stored, or it had nothing to answer and no new topic explains why); such a run is charged nothing.
 * `context_too_small`: the model's context, less its output limit and the system text, cannot hold the owner's newest
 * message (or 200 tokens of it); no call is made. `rate_limited`: the owner had started their replies a minute in the
 * run's lane (`agentRunsPerMinute` for their own, `agentOthersRunsPerMinute` for everyone else's); the run was recorded
 * failed by the trigger (runs.ts), never by the worker, and nothing was called.
 * `thinking_exhausted`: the model stopped at its output limit having only thought, no answer (charged what the
 * upstream reported). `model_gone`: the Agent's model is not there to call any more — its provider model off the
 * provider's list, its provider gone, a site model no longer configured (models/resolve.ts `resolveModel` null); no
 * call is made, and only choosing another model helps.
 */
export type RunErrorCode =
  | "provider_rejected"
  | "provider_unavailable"
  | "address_not_allowed"
  | "no_quota"
  | "busy"
  | "context_too_small"
  | "rate_limited"
  | "thinking_exhausted"
  | "model_gone";

/**
 * How a run ends, as the worker saw it. `finish` records what is true under the Agent's lock: a reply that was posted
 * stands (`done`, or `stopped` by its owner), and a run its Agent's pause, delete or removal from the run's conversation
 * (`agent_removed`), or a group member's halt (`halted`: an Agent's message had called for it), interrupted is
 * `cancelled` with that reason — the worker cannot tell an owner's stop from a pause, and a refused post looks the
 * same. `cancelled` with no error from `begin`: everything the reply was to answer is before a new topic its owner
 * started, or (a reply someone else called for) the Agent's others' daily budget was spent by the time it was admitted.
 */
export type RunEnd =
  | { readonly status: "done" }
  | { readonly status: "stopped" }
  | { readonly status: "cancelled"; readonly error?: "agent_paused" | "agent_deleted" | "agent_removed" | "halted" }
  | { readonly status: "failed"; readonly error: RunErrorCode; readonly resetsAt?: string };

/**
 * The provider could not be reached or gave nothing usable (also how a run the previous process left running ends, and
 * how a persona draft fails then). Its literal type is kept: a draft's failure must stay a `ModelErrorCode`.
 */
export const UNAVAILABLE = { status: "failed", error: "provider_unavailable" } as const satisfies RunEnd;
/** The service's own trouble: the reply could not be started or stored, or had nothing to answer. Charged nothing. */
export const BUSY = { status: "failed", error: "busy" } as const satisfies RunEnd;
/** No tokens at all: what a run that never called a model, or one recovered at start-up, is settled on. */
export const NOTHING: Readonly<Estimated> = { inputChars: 0, outputChars: 0 };

/**
 * The run is no longer `running`: something else ended it meanwhile — another instance's recovery at its start (a
 * deploy where old and new instances overlap), or the stale-run sweep. `begin` and `post` refuse it so; nothing more of
 * it is called, posted or recorded, and it stays as that recovery recorded it.
 */
export class RunNotRunning extends Error {
  constructor(
    readonly runId: string,
    readonly status: string | null,
  ) {
    super(`run ${runId} is ${status ?? "gone"}, not running`);
    this.name = "RunNotRunning";
  }
}

/** A piece of the reply on its way to the owner's sockets. */
export interface Delta {
  text?: string;
  reasoning?: string;
}

/**
 * What the worker posts as the Agent's message; a reply whose tools ran also what they looked up (`LookupFields`: a key
 * only for what there is, so a reply that ran none is posted as one offered none).
 */
export interface Reply extends LookupFields {
  text: string;
  reasoning: string;
  stopped: boolean;
  truncated: boolean;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface AgentPort {
  /**
   * The oldest queued reply whose owner has fewer than `agentMaxConcurrentRuns` running, now `running`; null when none. A
   * reply held back at admission is passed over while every call it waits for runs, and, until it is admitted, so are its
   * owner's younger replies that would be paid from the same source (first come, first served per payer and source).
   */
  claimNext(): Promise<RunTicket | null>;
  /**
   * Resolves the model, builds what the model is shown (never no turn at all), admits the call and marks the Agent's
   * read position — or says why the run ends at once (a reply held back at admission, its run queued again to wait for
   * room, ends this attempt here too: `finish` given that end does nothing, a later attempt being the run's own); rejects
   * with `RunNotRunning` when the run was
   * ended elsewhere meanwhile. Reading the attachments stops between files once the run should
   * stop (it then ends as `shouldStop` says) and is bounded by the run's time limit (`failed`, `busy`). `closing`
   * aborts when the service is closing: before the call is admitted, `begin` then rejects with its reason and records
   * nothing — the run is still `running`, unadmitted, and the caller ends it (`release`).
   */
  begin(run: RunTicket, closing?: AbortSignal): Promise<Prepared | RunEnd>;
  /**
   * Pushes a piece of the reply to the owner's sockets; nothing is stored. Dropped once the Agent's pause, delete or
   * removal from the run's conversation interrupted the run — also a piece that was already waiting to be delivered,
   * whenever it is delivered.
   */
  emit(run: RunTicket, delta: Delta): void;
  /**
   * Posts the reply as the Agent's message: "refused" when the Agent is paused or deleted, or its pause, delete or
   * removal from the run's conversation, or a group member's halt, interrupted the run, or the run is no longer running (another instance's
   * recovery ended it; `finish` then leaves it as that recorded it); "empty", storing nothing, when nothing of it is
   * left to show (a reply stopped or cut inside a persona block it never finished, with nothing before it; in a group,
   * also one that was nothing but the mark `begin` drew for the run, which the port keeps and takes out, and labels).
   */
  post(run: RunTicket, out: Reply): Promise<"posted" | "refused" | "empty">;
  /**
   * Posts what a reply said before it calls a tool, at once, as a message of its own ("先应一声、再交付"): its
   * acknowledgement — at most one per reply (the worker's rule), the answer coming later as its reply (`post`). Its text
   * and reasoning are kept as a reply's are (in a group without the run's mark), it calls nobody (its mentions are not
   * read), and it ends nothing: the run goes on. "refused" and "empty" as `post` says them.
   */
  acknowledge(run: RunTicket, said: { text: string; reasoning: string }): Promise<"posted" | "refused" | "empty">;
  /**
   * Settles the call and records how the run ended (one transaction, one usage record), then queues the follow-up for
   * messages that came meanwhile. `usage` is what the upstream reported; with none, `fallback` is what settlement counts,
   * and the record says it was estimated. A reply of several rounds (one that offers tools) is settled once, on their
   * sums: `usage` is the rounds' summed usage, null when any round reported none; `fallback` is then, summed over the
   * rounds, each round's reported usage when it has one (its hidden reasoning included, as the upstream counts it) and
   * its estimate only when it has none.
   */
  finish(run: RunTicket, end: RunEnd, usage: Usage | null, fallback: Estimated): Promise<void>;
  /**
   * Runs one tool call of the reply: a call of a tool `begin` offered whose input fits the tool's schema (the worker
   * checks both, and runs each call at most once). Never rejects for a call it cannot answer: its output then says why
   * (`{ error: "…" }`). `signal` aborts when the owner stops the reply, its time is up, or the tool has taken
   * `AGENT_RUN_TIMEOUT_MS`; a tool still running then is abandoned (its outcome is not used).
   */
  tool(run: RunTicket, call: ToolCall, signal: AbortSignal): Promise<ToolOutcome>;
  /**
   * Before each call of a reply after its first (a reply that offers tools), in one transaction under the run's lock:
   * whether, and how, the reply may go on. What it has cost so far (`spent`, the rounds' summed usage, or with any round
   * unreported null and then `estimated`, counted as `finish`'s fallback is) and the most its next call can cost
   * (`nextInputTokens`, the bound of everything that call will send, and its whole output limit) are held for it — the
   * hold raised to that, never lowered. "ok": another round that may call tools (within `TOOLS.maxPoints`, no budget of
   * its lane reached, and what is left of its source covers the hold); "final": one last call, which calls none (else —
   * also when nothing is left: the hold may then pass what is left, even below zero; a reply that has started is never
   * refused for money); "stop": no further call, only for a run no longer running (ended elsewhere), the hold as it was —
   * the worker posts what the reply wrote. A provider's model holds nothing: "ok", or "final" once a budget of its lane
   * is reached.
   */
  extend(run: RunTicket, spent: Usage | null, estimated: Estimated, nextInputTokens: number): Promise<"ok" | "final" | "stop">;
  /**
   * What the reply's tools are doing, for its status line: as a tool starts, its kind (`ToolRun.kinds`; told again only
   * when it changes); null as soon as the model is called again, a tool with no kind starts, or the reply ends while one
   * was shown. Only the kind: never a tool's name, input or output. Nothing is stored.
   */
  activity(run: RunTicket, activity: Activity | null): void;
  /**
   * The reply's model cannot use the tools: its upstream refused them ("refused", in the first round), or it made two
   * calls that could not be run ("garbled"). The reply goes on without them either way.
   */
  toolsUnusable(run: RunTicket, why: "refused" | "garbled"): Promise<void>;
  /**
   * Ends a run that will not be finished here (the service is closing) exactly as recovery at start-up ends one: its
   * reply posted → `done` (`stopped` when its message says so); interrupted by its Agent's pause, delete or removal from
   * the run's conversation → `cancelled`; else `failed`, `provider_unavailable`, retryable — its hold released by a
   * settlement on no tokens, which
   * costs nothing, and the follow-up queued by the one rule. Its owner is told. Nothing when it had ended already.
   * Rejects when that cannot be written: the run then stays `running`, for the stale-run sweep or the next start.
   */
  release(run: RunTicket): Promise<void>;
  /** Whether the run should stop now: its owner asked, or the Agent was paused, deleted or taken out of the run's conversation. */
  shouldStop(run: RunTicket): boolean;
}

/** `begin`'s answer is a run end rather than a prepared call. */
export function isRunEnd(x: Prepared | RunEnd): x is RunEnd {
  return "status" in x;
}
