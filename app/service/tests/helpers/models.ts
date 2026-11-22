import http from "node:http";
import type net from "node:net";
import { isDeepStrictEqual } from "node:util";
import type { Protocol } from "../../src/config.ts";
import { ModelError, type ModelCall, type ModelErrorCode, type ModelEvent, type ModelGateway, type ToolCall, type ToolResult } from "../../src/models/gateway.ts";

// --- a scripted gateway: what rule tests inject as `Deps.models` -----------------------------------------------------

export interface ReplyOptions {
  /** Streamed as `reasoning` deltas before the text. */
  reasoning?: string;
  /** The `finish` usage; default null (the upstream reported none). */
  usage?: { inputTokens: number; outputTokens: number } | null;
  /** A pause before every delta (the signal still ends it at once). */
  delayMsPerChunk?: number;
  /** The `finish` says the model stopped for length. */
  truncated?: boolean;
  /** Deltas of at most this many code points (default 8). */
  chunkSize?: number;
}

/** A call held by `hang()`. */
export interface Hold {
  /** Resolves with the call once it has started and is hanging. */
  readonly reached: Promise<ModelCall>;
  /** Lets the call go on: as `reply(text, options)` when there is text, else as `empty()`. */
  release(text?: string, options?: ReplyOptions): void;
}

/** How a call that streams ends up answering (`toolsRefused`: its finish says the tools were refused). */
type Answer = { kind: "reply"; text: string; options: ReplyOptions; toolsRefused?: true } | { kind: "empty" };
/** What `callTools` takes besides the calls. */
export interface CallToolsOptions {
  /** Streamed as `text` deltas before the calls. */
  text?: string;
  /** Streamed as `reasoning` deltas before the text. */
  reasoning?: string;
  /** The `finish` usage; default null (the upstream reported none). */
  usage?: { inputTokens: number; outputTokens: number } | null;
  /** The `finish` says the round was cut at its output limit. */
  truncated?: boolean;
}

type Step =
  | Answer
  | { kind: "tools"; calls: Array<{ name: string; input: unknown }>; options: CallToolsOptions }
  | { kind: "fail"; code: ModelErrorCode; afterText: string; afterReasoning: string; status?: number; usage?: { inputTokens: number; outputTokens: number } }
  | { kind: "cut"; text: string; reasoning: string }
  | { kind: "hang"; before: string; gate: Promise<Answer>; reached: (call: ModelCall) => void };

export interface ScriptedGateway extends ModelGateway {
  /**
   * Every call received, in order, as given (the signal included: `calls[i].signal.aborted`) — except that a call's
   * `tools` and `steps` are copied as they were when it was made, so a caller that goes on adding to its own list of
   * steps does not change what an earlier call is recorded with.
   */
  readonly calls: ModelCall[];
  /** What `listModels` answers. */
  models: string[];
  /** The next call streams `text` (and `options.reasoning` first), then `finish`. */
  reply(text: string, options?: ReplyOptions): ScriptedGateway;
  /**
   * The next call is a round that ends in tool calls: it streams `options.reasoning`, then `options.text` (if any), then
   * one `tool_call` per call (each with an id no other call of this gateway has; `input: null` for a name the call did
   * not offer), then a finish naming them, with `options.usage` (default null), `options.truncated`, and an opaque
   * assistant turn that survives a JSON round trip, as the real gateway's does. The call must offer tools (it throws
   * otherwise), and the call after it must answer this round (see the header).
   */
  callTools(calls: Array<{ name: string; input: unknown }>, options?: CallToolsOptions): ScriptedGateway;
  /**
   * The next call is one whose upstream refused the tools: it answers as `reply(text, options)` does and, when the call
   * offered tools, its finish reports `toolsRefused`.
   */
  refuseTools(text?: string, options?: ReplyOptions): ScriptedGateway;
  /**
   * The next call throws `ModelError(code)` (with `usage`, as `thinking_exhausted` has it, and the upstream's HTTP `status`
   * when given), after streaming `afterText` if given.
   */
  fail(code: ModelErrorCode, options?: { afterText?: string; afterReasoning?: string; status?: number; usage?: { inputTokens: number; outputTokens: number } }): ScriptedGateway;
  /** The next call streams `text`, then simply ends: no `finish`, no error (an upstream that cut the stream short). */
  cut(text: string, reasoning?: string): ScriptedGateway;
  /** The next call hangs until released (or until its signal aborts). */
  hang(): Hold;
  /**
   * The next call streams `text`, then hangs until released (or until its signal aborts). `reached` resolves once the
   * caller has taken all of `text` and asked for more; `release(rest, options)` then streams `rest` and finishes.
   */
  hangAfter(text: string): Hold;
  /** The next call finishes at once with no text and no usage. */
  empty(): ScriptedGateway;
  /** Steps queued and not yet taken by a call. */
  pending(): number;
}

/** Chunks of at most `size` code points (a surrogate pair is never split). */
function chunks(text: string, size = 8): string[] {
  const points = Array.from(text);
  const out: string[] = [];
  for (let i = 0; i < points.length; i += size) out.push(points.slice(i, i + size).join(""));
  return out;
}

/** `promise`, or the signal's reason as soon as it aborts. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
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

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** The scripted round's assistant turn, shaped as the SDK's: its text, then its tool calls (nothing said: no turn). */
function scriptedTurn(text: string, toolCalls: ToolCall[]): unknown {
  const content = [
    ...(text === "" ? [] : [{ type: "text", text }]),
    ...toolCalls.map((c) => ({ type: "tool-call", toolCallId: c.id, toolName: c.name, input: c.input })),
  ];
  return content.length === 0 ? [] : [{ role: "assistant", content }];
}

/** The finish of a scripted round. */
function finished(
  usage: { inputTokens: number; outputTokens: number } | null,
  truncated: boolean,
  text: string,
  toolCalls: ToolCall[] = [],
): Extract<ModelEvent, { type: "finish" }> {
  return { type: "finish", usage, truncated, toolCalls, assistant: scriptedTurn(text, toolCalls) };
}

/** `value` as it comes back from a JSON round trip (how a caller may hold an opaque turn). */
const throughJson = (value: unknown): unknown => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/** Why `results` do not answer exactly `calls` (one result each, same id and name), or null when they do. */
function unanswered(calls: readonly ToolCall[], results: readonly ToolResult[]): string | null {
  if (results.length !== calls.length) return `${results.length} result(s) for ${calls.length} call(s)`;
  for (const c of calls) {
    const answers = results.filter((r) => r.id === c.id);
    if (answers.length !== 1) return `call ${c.id} answered ${answers.length} time(s)`;
    if (answers[0]!.name !== c.name) return `call ${c.id} (${c.name}) answered as ${answers[0]!.name}`;
  }
  return null;
}

/**
 * A `ModelGateway` that answers from a script, in the order the steps were queued, and records every call. It behaves
 * like the real one where rule tests can tell: events come as `text` / `reasoning` deltas and `tool_call`s then one
 * `finish`; a failure is a thrown `ModelError`; when the call's signal aborts the iterator stops at once by throwing the
 * signal's reason. A call with nothing scripted throws a plain Error naming it.
 *
 * Tool rounds are checked as every real upstream checks them. The gateway keeps its own copy of each `callTools` round
 * it gave in the current run (one answer: the rounds since the last call without steps). A call with `steps` must pass
 * back exactly those rounds, all of them, in the order given — each turn deep-equal, after a JSON round trip, to the
 * gateway's copy (so a turn changed in place is caught), its results answering exactly that round's calls (one result
 * each, same id and name). A call without steps starts a new run, except that a call offering tools right after an
 * unanswered `callTools` round is one that left its steps out. A call with neither tools nor steps always passes (a new
 * conversation, or a last call with the rounds flattened into text): the round before it can no longer be answered. A
 * call that breaks this throws a plain Error naming it, as an unscripted call does, leaves its scripted answer queued
 * and changes nothing (the next call is held to the same rounds). Two answers interleaved on one gateway are not
 * modelled: give each its own gateway.
 *
 * Where it still differs from the real gateway (tests must not rely on these):
 * - Ids are `scripted-call-N`, unique for the gateway's whole life; real ids are unique only within a round, and only
 *   on Chat Completions and Gemini (Responses and Anthropic pass on what the upstream sent: possibly empty, possibly
 *   repeated).
 * - `usage` defaults to null; real rounds usually report usage, so a sum over rounds is null unless every scripted
 *   round passes one.
 * - `refuseTools` is one round only; the real gateway, once an upstream refused tools, leaves them out of that
 *   upstream's calls without `steps` for `TOOLS_REFUSAL_TTL_MS`, reporting `toolsRefused` each time. Nothing here
 *   remembers it: a later `callTools` is honoured.
 * - Events come in a fixed order — reasoning, text, then the calls; real streams interleave as the upstream sends them
 *   (Chat Completions gives its calls at the end, Anthropic block by block).
 * - The assistant turn holds the text and the calls only: no reasoning, no provider metadata.
 * - A `callTools` round never fails after its calls (`fail` can only follow text), `hang` releases only into a reply,
 *   and a truncated `callTools` round whose inputs are all null finishes truncated where the real one is
 *   `thinking_exhausted` after reasoning.
 * - `calls[n].steps` is a copy of the array, but the step objects in it are the caller's.
 * - `toolChoice` is recorded (`calls[n].toolChoice`), never enforced: a `callTools` round on a call with `toolChoice:
 *   "none"` is honoured, as a model that calls a tool anyway; the real upstream is told it may call none. The step
 *   checks hold for such a call as for any other.
 */
export function scriptedGateway(): ScriptedGateway {
  const queue: Step[] = [];
  const calls: ModelCall[] = [];
  /** Tool calls made so far: each gets the next id. */
  let toolCallsMade = 0;
  /** The `callTools` rounds of the current run, in order: the gateway's own copies of each turn and its calls. */
  let rounds: Array<{ assistant: unknown; calls: ToolCall[] }> = [];
  /** The last of `rounds` has not been answered yet. */
  let awaiting = false;

  /**
   * Why the call's steps are not ones a real upstream would take after this run's rounds, or null — in which case the
   * call is the run's next (and a call without steps, unless it left them out, a new run's first).
   */
  function stepsProblem(call: ModelCall): string | null {
    const steps = call.steps ?? [];
    if (steps.length === 0) {
      if (awaiting && (call.tools?.length ?? 0) > 0) return "offers tools but does not answer the tool calls of the round before it";
      rounds = [];
      awaiting = false;
      return null;
    }
    if (steps.length !== rounds.length) return `passes back ${steps.length} round(s); this answer has had ${rounds.length}, all to be passed back in order`;
    for (const [i, step] of steps.entries()) {
      if (!isDeepStrictEqual(throughJson(step.assistant), rounds[i]!.assistant)) return `step ${i + 1} is not round ${i + 1} as this gateway gave it`;
      const problem = unanswered(rounds[i]!.calls, step.results);
      if (problem !== null) return `step ${i + 1}: ${problem}`;
    }
    awaiting = false;
    return null;
  }

  async function* run(call: ModelCall, scripted: Step | undefined, n: number, problem: string | null): AsyncGenerator<ModelEvent> {
    const { signal } = call;
    if (problem !== null) throw new Error(`scriptedGateway: call #${n} ${problem}`);
    if (!scripted) throw new Error(`scriptedGateway: call #${n} was not scripted`);
    signal.throwIfAborted();
    let delay = 0;
    let size = 8;
    const emit = async function* (type: "text" | "reasoning", text: string): AsyncGenerator<ModelEvent> {
      for (const delta of chunks(text, size)) {
        if (delay > 0) await abortable(sleep(delay), signal);
        signal.throwIfAborted();
        yield { type, delta };
      }
    };
    if (scripted.kind === "cut") {
      yield* emit("reasoning", scripted.reasoning);
      yield* emit("text", scripted.text);
      return;
    }
    let step: Exclude<Step, { kind: "hang" } | { kind: "cut" }>;
    if (scripted.kind === "hang") {
      yield* emit("text", scripted.before);
      scripted.reached(call);
      step = await abortable(scripted.gate, signal);
    } else {
      step = scripted;
    }
    if (step.kind === "empty") {
      yield finished(null, false, "");
      return;
    }
    delay = step.kind === "reply" ? (step.options.delayMsPerChunk ?? 0) : 0;
    size = step.kind === "reply" ? (step.options.chunkSize ?? 8) : 8;
    if (step.kind === "fail") {
      yield* emit("reasoning", step.afterReasoning);
      yield* emit("text", step.afterText);
      throw new ModelError(step.code, step.status, step.usage);
    }
    const offered = new Set((call.tools ?? []).map((t) => t.name));
    if (step.kind === "tools") {
      if (offered.size === 0) throw new Error(`scriptedGateway: call #${n} is scripted to call tools but offered no tools`);
      const text = step.options.text ?? "";
      yield* emit("reasoning", step.options.reasoning ?? "");
      yield* emit("text", text);
      const made: ToolCall[] = [];
      for (const { name, input } of step.calls) {
        signal.throwIfAborted();
        const toolCall = { id: `scripted-call-${++toolCallsMade}`, name, input: offered.has(name) ? input : null };
        made.push(toolCall);
        yield { type: "tool_call", call: toolCall };
      }
      signal.throwIfAborted();
      const finish = finished(step.options.usage ?? null, step.options.truncated ?? false, text, made);
      // Its own copies: the caller may change what it was handed, and what it passes back is checked against these.
      rounds.push({ assistant: throughJson(finish.assistant), calls: structuredClone(made) });
      awaiting = true;
      yield finish;
      return;
    }
    yield* emit("reasoning", step.options.reasoning ?? "");
    yield* emit("text", step.text);
    signal.throwIfAborted();
    const finish = finished(step.options.usage ?? null, step.options.truncated ?? false, step.text);
    yield step.toolsRefused && offered.size > 0 ? { ...finish, toolsRefused: true } : finish;
  }

  const gateway: ScriptedGateway = {
    calls,
    models: [],
    stream(call) {
      const recorded = call.tools || call.steps ? { ...call, ...(call.tools ? { tools: [...call.tools] } : {}), ...(call.steps ? { steps: [...call.steps] } : {}) } : call;
      calls.push(recorded);
      const problem = stepsProblem(recorded);
      return run(recorded, problem === null ? queue.shift() : undefined, calls.length, problem);
    },
    async listModels() {
      return [...gateway.models];
    },
    reply(text, options = {}) {
      queue.push({ kind: "reply", text, options });
      return gateway;
    },
    callTools(toolCalls, options = {}) {
      queue.push({ kind: "tools", calls: toolCalls, options });
      return gateway;
    },
    refuseTools(text = "Answered without tools.", options = {}) {
      queue.push({ kind: "reply", text, options, toolsRefused: true });
      return gateway;
    },
    fail(code, options = {}) {
      queue.push({ kind: "fail", code, afterText: options.afterText ?? "", afterReasoning: options.afterReasoning ?? "", ...(options.status ? { status: options.status } : {}), ...(options.usage ? { usage: options.usage } : {}) });
      return gateway;
    },
    cut(text, reasoning = "") {
      queue.push({ kind: "cut", text, reasoning });
      return gateway;
    },
    hang() {
      return gateway.hangAfter("");
    },
    hangAfter(before) {
      let open!: (answer: Answer) => void;
      let reached!: (call: ModelCall) => void;
      const gate = new Promise<Answer>((resolve) => (open = resolve));
      const reachedPromise = new Promise<ModelCall>((resolve) => (reached = resolve));
      queue.push({ kind: "hang", before, gate, reached });
      return {
        reached: reachedPromise,
        release(text, options = {}) {
          open(text === undefined ? { kind: "empty" } : { kind: "reply", text, options });
        },
      };
    },
    empty() {
      queue.push({ kind: "empty" });
      return gateway;
    },
    pending: () => queue.length,
  };
  return gateway;
}

// --- a local stand-in for the four protocols' streaming endpoints ---------------------------------------------------

/** The model name protocol tests call (no SDK recognises it, so it applies no model-specific rules). */
export const STUB_MODEL = "stub-model";

/** The canned answer, as the deltas every protocol streams it in. */
export const CANNED_TEXT_DELTAS = ["Hello", ", world", "! 你好。"] as const;
export const CANNED_TEXT = CANNED_TEXT_DELTAS.join("");
export const CANNED_REASONING_DELTAS = ["Let me think", " it over."] as const;
export const CANNED_REASONING = CANNED_REASONING_DELTAS.join("");
/** The usage every canned answer reports; with reasoning, 12 reasoning tokens are part of the 19 output tokens. */
export const CANNED_USAGE = { inputTokens: 11, outputTokens: 7 } as const;
export const CANNED_REASONING_USAGE = { inputTokens: 11, outputTokens: 19 } as const;

/**
 * What a canned stream is: a plain answer, one that reasons first, one that stops for length; or a round that ends in
 * tool calls — one (`CANNED_TOOL`, no text), plainly or after reasoning (signed or encrypted where the protocol does
 * that); the canned text, then that call; or two calls (`CANNED_TOOL`, then `CANNED_SECOND_TOOL`), no text.
 */
export type CannedKind = "text" | "reasoning" | "length" | "tool" | "reasoning_tool" | "text_tool" | "two_tools";

/** The tool call every canned tool stream makes, and its input's JSON as the protocols that stream it send it. */
export const CANNED_TOOL = { name: "search_messages", input: { query: "川菜", limit: 3 } } as const;
export const CANNED_TOOL_ARGS = ['{"query":"川菜",', '"limit":3}'] as const;
/** The call's id, where the protocol gives one (Gemini gives none: the SDK makes one up). */
export const CANNED_TOOL_CALL_ID = "call_stub_1";
/** The second call of a `two_tools` round. */
export const CANNED_SECOND_TOOL = { name: "read_file", input: { id: "f1" } } as const;
export const CANNED_SECOND_TOOL_ARGS = ['{"id":', '"f1"}'] as const;
export const CANNED_SECOND_TOOL_CALL_ID = "call_stub_2";
/** What a canned round's reasoning comes with that the next round must send back: Anthropic's signature, OpenAI's encrypted reasoning, Gemini's thought signature. */
export const CANNED_SIGNATURE = "c2lnbmF0dXJl";
export const CANNED_ENCRYPTED_REASONING = "enc-stub-reasoning";
export const CANNED_THOUGHT_SIGNATURE = "dGhvdWdodA==";

export interface CannedOptions {
  /** The first tool call's input JSON, in the pieces it streams (default `CANNED_TOOL_ARGS`); Gemini sends it whole, parsed. */
  toolArgs?: readonly string[];
}

/** A tool call of a canned round: its id, its Responses item id, its name, and its input JSON as streamed. */
interface CannedCall {
  id: string;
  itemId: string;
  name: string;
  args: readonly string[];
}

/** What a canned round says: whether it reasons, whether it has the canned text, and its tool calls. */
function cannedRound(kind: CannedKind, toolArgs: readonly string[]): { reasoning: boolean; text: boolean; calls: CannedCall[] } {
  const first: CannedCall = { id: CANNED_TOOL_CALL_ID, itemId: "fc_stub", name: CANNED_TOOL.name, args: toolArgs };
  const second: CannedCall = { id: CANNED_SECOND_TOOL_CALL_ID, itemId: "fc_stub_2", name: CANNED_SECOND_TOOL.name, args: CANNED_SECOND_TOOL_ARGS };
  const calls = kind === "two_tools" ? [first, second] : kind === "tool" || kind === "reasoning_tool" || kind === "text_tool" ? [first] : [];
  return { reasoning: kind === "reasoning" || kind === "reasoning_tool", text: calls.length === 0 || kind === "text_tool", calls };
}

/** One server-sent event per entry: an `event:` line when named, then the JSON (or a literal) as `data:`. */
function sse(events: Array<{ event?: string; data: unknown }>): string {
  return events.map((e) => `${e.event ? `event: ${e.event}\n` : ""}data: ${typeof e.data === "string" ? e.data : JSON.stringify(e.data)}\n\n`).join("");
}

function openaiChatStream(kind: CannedKind, toolArgs: readonly string[]): string {
  const chunk = (delta: object, finish: string | null = null) => ({
    data: { id: "chatcmpl-stub", object: "chat.completion.chunk", created: 1_700_000_000, model: STUB_MODEL, choices: [{ index: 0, delta, finish_reason: finish }] },
  });
  const { reasoning, text, calls } = cannedRound(kind, toolArgs);
  return sse([
    chunk({ role: "assistant", content: text ? "" : null }),
    // The OpenAI-compatible way some servers stream reasoning: the SDK's Chat Completions model does not read it, the
    // gateway does (src/models/chat-reasoning.ts).
    ...(reasoning ? CANNED_REASONING_DELTAS.map((d) => chunk({ reasoning_content: d })) : []),
    ...(text ? CANNED_TEXT_DELTAS.map((d) => chunk({ content: d })) : []),
    ...calls.flatMap((c, index) => [
      chunk({ tool_calls: [{ index, id: c.id, type: "function", function: { name: c.name, arguments: "" } }] }),
      ...c.args.map((piece) => chunk({ tool_calls: [{ index, function: { arguments: piece } }] })),
    ]),
    chunk({}, kind === "length" ? "length" : calls.length > 0 ? "tool_calls" : "stop"),
    {
      data: {
        id: "chatcmpl-stub",
        object: "chat.completion.chunk",
        created: 1_700_000_000,
        model: STUB_MODEL,
        choices: [],
        usage: reasoning
          ? { prompt_tokens: 11, completion_tokens: 19, total_tokens: 30, completion_tokens_details: { reasoning_tokens: 12 } }
          : { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
      },
    },
    { data: "[DONE]" },
  ]);
}

function openaiResponsesStream(kind: CannedKind, toolArgs: readonly string[]): string {
  let seq = 0;
  const ev = (type: string, fields: object) => ({ event: type, data: { type, sequence_number: seq++, ...fields } });
  const { reasoning, text, calls } = cannedRound(kind, toolArgs);
  const tool = calls.length > 0;
  const msgIndex = reasoning ? 1 : 0;
  const callIndex = msgIndex + (text ? 1 : 0);
  const message = (status: string, text: string | null) => ({
    type: "message",
    id: "msg_stub",
    status,
    role: "assistant",
    content: text === null ? [] : [{ type: "output_text", text, annotations: [] }],
  });
  // A round that ends in a tool call carries its reasoning encrypted (asked for with `store: false`): sent back next round.
  const reasoningItem = (summary: string | null) => ({
    type: "reasoning",
    id: "rs_stub",
    summary: summary === null ? [] : [{ type: "summary_text", text: summary }],
    ...(tool ? { encrypted_content: CANNED_ENCRYPTED_REASONING } : {}),
  });
  const functionCall = (c: CannedCall, status: string, args: string) => ({
    type: "function_call",
    id: c.itemId,
    call_id: c.id,
    name: c.name,
    arguments: args,
    status,
  });
  const head = { id: "resp_stub", object: "response", created_at: 1_700_000_000, model: STUB_MODEL };
  const usage = reasoning
    ? { input_tokens: 11, input_tokens_details: { cached_tokens: 0 }, output_tokens: 19, output_tokens_details: { reasoning_tokens: 12 }, total_tokens: 30 }
    : { input_tokens: 11, input_tokens_details: { cached_tokens: 0 }, output_tokens: 7, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 18 };
  return sse([
    ev("response.created", { response: { ...head, status: "in_progress", output: [] } }),
    ev("response.in_progress", { response: { ...head, status: "in_progress", output: [] } }),
    ...(reasoning
      ? [
          ev("response.output_item.added", { output_index: 0, item: reasoningItem(null) }),
          ev("response.reasoning_summary_part.added", { item_id: "rs_stub", output_index: 0, summary_index: 0, part: { type: "summary_text", text: "" } }),
          ...CANNED_REASONING_DELTAS.map((delta) =>
            ev("response.reasoning_summary_text.delta", { item_id: "rs_stub", output_index: 0, summary_index: 0, delta }),
          ),
          ev("response.reasoning_summary_text.done", { item_id: "rs_stub", output_index: 0, summary_index: 0, text: CANNED_REASONING }),
          ev("response.reasoning_summary_part.done", {
            item_id: "rs_stub",
            output_index: 0,
            summary_index: 0,
            part: { type: "summary_text", text: CANNED_REASONING },
          }),
          ev("response.output_item.done", { output_index: 0, item: reasoningItem(CANNED_REASONING) }),
        ]
      : []),
    ...(text
      ? [
          ev("response.output_item.added", { output_index: msgIndex, item: message("in_progress", null) }),
          ev("response.content_part.added", { item_id: "msg_stub", output_index: msgIndex, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }),
          ...CANNED_TEXT_DELTAS.map((delta) =>
            ev("response.output_text.delta", { item_id: "msg_stub", output_index: msgIndex, content_index: 0, delta, logprobs: [] }),
          ),
          ev("response.output_text.done", { item_id: "msg_stub", output_index: msgIndex, content_index: 0, text: CANNED_TEXT }),
          ev("response.output_item.done", { output_index: msgIndex, item: message("completed", CANNED_TEXT) }),
        ]
      : []),
    ...calls.flatMap((c, i) => [
      ev("response.output_item.added", { output_index: callIndex + i, item: functionCall(c, "in_progress", "") }),
      ...c.args.map((delta) => ev("response.function_call_arguments.delta", { item_id: c.itemId, output_index: callIndex + i, delta })),
      ev("response.function_call_arguments.done", { item_id: c.itemId, output_index: callIndex + i, arguments: c.args.join("") }),
      ev("response.output_item.done", { output_index: callIndex + i, item: functionCall(c, "completed", c.args.join("")) }),
    ]),
    kind === "length"
      ? ev("response.incomplete", { response: { ...head, status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage } })
      : ev("response.completed", { response: { ...head, status: "completed", usage } }),
  ]);
}

function anthropicStream(kind: CannedKind, toolArgs: readonly string[]): string {
  const { reasoning, text, calls } = cannedRound(kind, toolArgs);
  const textIndex = reasoning ? 1 : 0;
  /** The answer's blocks after any thinking: the text's deltas or a call's input pieces (a ping after the first block's start). */
  const blocks: Array<{ start: object; deltas: object[] }> = [
    ...(text ? [{ start: { type: "text", text: "" }, deltas: CANNED_TEXT_DELTAS.map((t) => ({ type: "text_delta", text: t })) }] : []),
    ...calls.map((c) => ({
      start: { type: "tool_use", id: c.id, name: c.name, input: {} },
      deltas: c.args.map((partial_json) => ({ type: "input_json_delta", partial_json })),
    })),
  ];
  const ev = (type: string, fields: object = {}) => ({ event: type, data: { type, ...fields } });
  return sse([
    ev("message_start", {
      message: {
        id: "msg_stub",
        type: "message",
        role: "assistant",
        model: STUB_MODEL,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 11, output_tokens: 1 },
      },
    }),
    ...(reasoning
      ? [
          ev("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }),
          ...CANNED_REASONING_DELTAS.map((thinking) => ev("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking } })),
          ev("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: CANNED_SIGNATURE } }),
          ev("content_block_stop", { index: 0 }),
        ]
      : []),
    ...blocks.flatMap((b, i) => [
      ev("content_block_start", { index: textIndex + i, content_block: b.start }),
      ...(i === 0 ? [ev("ping")] : []),
      ...b.deltas.map((delta) => ev("content_block_delta", { index: textIndex + i, delta })),
      ev("content_block_stop", { index: textIndex + i }),
    ]),
    ev("message_delta", {
      delta: { stop_reason: kind === "length" ? "max_tokens" : calls.length > 0 ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: reasoning ? 19 : 7 },
    }),
    ev("message_stop"),
  ]);
}

function geminiStream(kind: CannedKind, toolArgs: readonly string[]): string {
  const { reasoning, text, calls } = cannedRound(kind, toolArgs);
  const chunk = (parts: object[], extra: object = {}) => ({
    data: { candidates: [{ content: { parts, role: "model" }, index: 0, ...extra }], modelVersion: STUB_MODEL },
  });
  const usageMetadata = reasoning
    ? { promptTokenCount: 11, candidatesTokenCount: 7, thoughtsTokenCount: 12, totalTokenCount: 30 }
    : { promptTokenCount: 11, candidatesTokenCount: 7, totalTokenCount: 18 };
  const thoughts = reasoning ? CANNED_REASONING_DELTAS.map((t) => chunk([{ text: t, thought: true }])) : [];
  if (calls.length > 0) {
    // Function calls come whole, in the last chunk, their arguments parsed; after reasoning the first carries the
    // thought signature.
    const functionCalls = calls.map((c, i) => ({
      functionCall: { name: c.name, args: JSON.parse(c.args.join("")) },
      ...(reasoning && i === 0 ? { thoughtSignature: CANNED_THOUGHT_SIGNATURE } : {}),
    }));
    const texts = text ? CANNED_TEXT_DELTAS.map((t) => chunk([{ text: t }])) : [];
    return sse([...thoughts, ...texts, { data: { ...chunk(functionCalls, { finishReason: "STOP" }).data, usageMetadata } }]);
  }
  const last = CANNED_TEXT_DELTAS.length - 1;
  return sse([
    ...thoughts,
    ...CANNED_TEXT_DELTAS.map((t, i) =>
      i < last ? chunk([{ text: t }]) : { data: { ...chunk([{ text: t }], { finishReason: kind === "length" ? "MAX_TOKENS" : "STOP" }).data, usageMetadata } },
    ),
  ]);
}

/** The canned event stream a protocol's streaming endpoint answers with. */
export function cannedStream(protocol: Protocol, kind: CannedKind, options: CannedOptions = {}): string {
  const toolArgs = options.toolArgs ?? CANNED_TOOL_ARGS;
  switch (protocol) {
    case "openai_chat":
      return openaiChatStream(kind, toolArgs);
    case "openai_responses":
      return openaiResponsesStream(kind, toolArgs);
    case "anthropic":
      return anthropicStream(kind, toolArgs);
    case "gemini":
      return geminiStream(kind, toolArgs);
  }
}

/** The protocol's own "your key is wrong" answer, echoing the key as some upstreams do. */
export function cannedKeyError(protocol: Protocol, key: string): { status: number; body: string } {
  switch (protocol) {
    case "openai_chat":
    case "openai_responses":
      return {
        status: 401,
        body: JSON.stringify({ error: { message: `Incorrect API key provided: ${key}.`, type: "invalid_request_error", param: null, code: "invalid_api_key" } }),
      };
    case "anthropic":
      return { status: 401, body: JSON.stringify({ type: "error", error: { type: "authentication_error", message: `invalid x-api-key ${key}` } }) };
    case "gemini":
      return { status: 403, body: JSON.stringify({ error: { code: 403, message: `API key ${key} is not allowed to call this method.`, status: "PERMISSION_DENIED" } }) };
  }
}

/** Which protocol's streaming endpoint `path` (below the stub's `/v1`) is, or null. */
export function protocolOfPath(path: string): Protocol | null {
  const p = path.split("?")[0]!;
  if (p.endsWith("/chat/completions")) return "openai_chat";
  if (p.endsWith("/responses")) return "openai_responses";
  if (p.endsWith("/messages")) return "anthropic";
  if (p.endsWith(":streamGenerateContent")) return "gemini";
  return null;
}

/** Writes the canned stream of the protocol `path` belongs to as an SSE response. */
export function answerCanned(req: StubRequest, res: http.ServerResponse, kind: CannedKind = "text"): void {
  const protocol = protocolOfPath(req.path);
  if (!protocol) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end('{"error":"no such endpoint"}');
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  res.end(cannedStream(protocol, kind));
}

export interface StubRequest {
  method: string;
  /** Path and query, as sent (`/v1/chat/completions`). */
  path: string;
  headers: http.IncomingHttpHeaders;
  /** The JSON body, parsed (null when there was none). */
  body: any;
  /** The body exactly as it arrived (UTF-8). */
  raw: string;
}

export type StubHandler = (req: StubRequest, res: http.ServerResponse) => void;

export interface ProtocolStub {
  /** `http://127.0.0.1:<port>/v1`: what a ModelCall's baseUrl is (reach it through a guard with `allowInsecureLocal`). */
  readonly baseUrl: string;
  /** Every request, in order: path, headers and parsed JSON body. */
  readonly requests: StubRequest[];
  /** Answers every request from now on with `handler` (default: `answerCanned`, the protocol's plain text stream). */
  answer(handler: StubHandler): void;
  /** Forgets the requests and goes back to the default answer. */
  reset(): void;
  close(): Promise<void>;
}

/**
 * A local HTTP server (127.0.0.1, plain HTTP) standing in for the four protocols' streaming endpoints. Each request is
 * read whole, recorded, then answered by the current handler.
 */
export async function protocolStub(): Promise<ProtocolStub> {
  const requests: StubRequest[] = [];
  let handler: StubHandler = (req, res) => answerCanned(req, res);
  const server = http.createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(parts).toString("utf8");
      let body: unknown = null;
      try {
        body = raw === "" ? null : JSON.parse(raw);
      } catch {
        body = raw;
      }
      const seen: StubRequest = { method: req.method ?? "", path: req.url ?? "", headers: req.headers, body, raw };
      requests.push(seen);
      handler(seen, res);
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as net.AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    answer(h) {
      handler = h;
    },
    reset() {
      requests.length = 0;
      handler = (req, res) => answerCanned(req, res);
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}
