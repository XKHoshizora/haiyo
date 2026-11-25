import { createAnthropic, type AnthropicLanguageModelOptions } from "@ai-sdk/anthropic";
import { createGoogle, type GoogleLanguageModelOptions } from "@ai-sdk/google";
import { createOpenAI, type OpenAILanguageModelChatOptions, type OpenAILanguageModelResponsesOptions } from "@ai-sdk/openai";
import {
  APICallError,
  jsonSchema,
  streamText,
  tool,
  type AssistantModelMessage,
  type FilePart,
  type JSONSchema7,
  type JSONValue,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type TextPart,
  type TextStreamPart,
  type ToolResultPart,
  type ToolSet,
} from "ai";
import type { Protocol, ReasoningLevel } from "../config.ts";
import { AppError } from "../errors.ts";
import { hasVisibleText } from "../schemas.ts";
import { guardedFetch } from "../providers/guard.ts";
import { createProviderProbe, keyRefused, PROBE_GUARD, ProviderCallError, type ProviderCallCode } from "../providers/probe.ts";
import type { Slots } from "../slots.ts";
import { ChatReasoningTap, ThinkTags } from "./chat-reasoning.ts";

/**
 * The model gateway: the one place the service talks to a language model. Every call goes out through the address
 * guard (`guardedFetch`), whoever's model it is (a site model or a person's provider), over one of four protocols,
 * through the Vercel AI SDK's provider packages (`streamText`; no hosted gateway, no telemetry).
 */

export type { ReasoningLevel } from "../config.ts";

export type Part =
  | { type: "text"; text: string }
  | { type: "image"; mime: string; data: Uint8Array }
  | { type: "file"; mime: "application/pdf"; name: string; data: Uint8Array };

/**
 * A tool call an earlier reply of this conversation made, returned in its history (README "Agents and runs", Earlier tool
 * use in history): never one of this answer's rounds (those are `steps`). `id`: what pairs it with its result, 22 hex
 * digits; on the wire it is in the protocol's style (`call_…`, `toolu_01…`: `replayWireId`). Only in an assistant turn.
 */
export interface ReplayCall {
  type: "tool-call";
  id: string;
  name: string;
  input: unknown;
}

/** What stands for that call's result (its placeholder, JSON): only in a `tool` turn, right after its call's turn. */
export interface ReplayResult {
  type: "tool-result";
  id: string;
  name: string;
  output: unknown;
}

/** One part of a turn: a user's or an assistant's (`Part`), an earlier call (assistant turns), its result (`tool` turns). */
export type TurnPart = Part | ReplayCall | ReplayResult;

/** A tool the model may call: its name, what it is for, and its input as a JSON Schema (an object's). */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * A tool call the model made. What the gateway guarantees, and nothing more:
 * - `name` is one of the tools the call offered when `input` is not null; otherwise it is arbitrary — a tool not
 *   offered, possibly empty.
 * - `input` is the call's arguments parsed as JSON and never checked against the tool's schema: `{}` for empty
 *   arguments; null when they were not JSON, when the name is not an offered tool, or when they were JSON `null`.
 * - `id` is the protocol's (Gemini's own when it sends one, else made up by the SDK); on Responses and Anthropic it is
 *   as the upstream sent it, so it may be empty or repeat within a round; on no protocol is it unique across rounds.
 * - Only `finish.truncated` says a round was cut: a call cut short may have `input` null, or `{}` when it was cut before
 *   its first argument.
 * - The gateway bounds no sizes: not a call's name, id or input, nor how many calls a round makes (only the 8 MiB a
 *   stream may have), nor what a call sends (`tools`, `steps`, results).
 */
export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

/** What a tool call gave, for the next round: the call's id and name, and its output (JSON-serialisable). */
export interface ToolResult {
  id: string;
  name: string;
  output: unknown;
}

export interface ModelCall {
  protocol: Protocol;
  /** Used as the SDK provider's `baseURL` as it is: each protocol appends its own path (README, "Calling a model"). */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Empty: no system text is sent. */
  system: string;
  /**
   * With `tools`: the system text to send in place of `system` whenever they are not sent — an upstream that refused
   * them is asked again without them, or left without them as one that refused before — so that an answer written with
   * no tools is never told it has some. Absent: `system` either way. Without tools it changes nothing.
   */
  systemWithoutTools?: string;
  /**
   * The conversation, oldest first. An earlier reply's tool use may return in it (the replay: `ReplayCall` parts in an
   * assistant turn, then a `tool` turn of their `ReplayResult`s, then the reply's text in the next assistant turn). The
   * replay is sent in the protocol's own form only when the tools are sent and offer every tool it calls; otherwise it
   * is lowered — its calls and results left out and the assistant turns they split joined again — which is exactly the
   * request the same conversation made without a replay. A call with no replay is sent as it always was.
   */
  messages: Array<{ role: "user" | "assistant" | "tool"; parts: TurnPart[] }>;
  reasoning: ReasoningLevel;
  /** Sent as it is: the reply's limit and, at a level, its thinking allowance (src/models/resolve.ts `outputLimit`). */
  maxOutputTokens: number;
  /**
   * Chat Completions only: the upstream thinks unless told not to and takes the common switch for it, `thinking:
   * {type: "disabled"}` at `none`, `{type: "enabled"}` at any other level. Absent or false: not sent.
   */
  thinkingSwitch?: boolean;
  /**
   * The model is marked as one that may think (models/resolve.ts: a provider model's `reasoning`, a site model that
   * lists a level or takes the switch). Such a model may think whatever level it is asked for — some cannot switch it
   * off — so its calls may be silent for long at every level (`silenceAllowed`). Absent or false: not marked.
   */
  thinks?: boolean;
  /**
   * Who the upstream is (`site:<id>`, `provider:<id>@<baseUrl>`: a provider whose address changed is another): an
   * optional field it refused is remembered under it, in this process, and left out of its later calls. Absent:
   * nothing is remembered.
   */
  upstreamId?: string;
  /**
   * The tools the model may call in this round (none is run here: the caller runs them and sends their results in the
   * next call's `steps`). Absent or empty: the request is exactly a call's without tools. On a call without `steps`, an
   * upstream that refuses them is asked once more without them, and its later calls without `steps` leave them out for
   * `TOOLS_REFUSAL_TTL_MS` (`OptionalField` `tools`); a call with `steps` always sends them.
   */
  tools?: ToolSpec[];
  /**
   * With `tools`: whether the model may call one (`auto`) or must answer without (`none`: the tools are still sent, in
   * the protocol's way of saying none may be called — a last round, whose `steps` an upstream may refuse without the
   * tools' definitions). Absent: as `auto`, the request exactly as without this field. Without tools: nothing is sent.
   */
  toolChoice?: "auto" | "none";
  /**
   * The rounds of this answer so far, oldest first, sent after `messages`: each round's assistant turn as its finish
   * gave it (`assistant`, passed back untouched), then its tool calls' results.
   */
  steps?: Array<{ assistant: unknown; results: ToolResult[] }>;
  /** Bounds the call: aborting it ends the stream at once and closes the upstream connection. */
  signal: AbortSignal;
}

export type ModelEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool_call"; call: ToolCall }
  /**
   * The upstream refused (400 or 422, before anything came back) a request that sent an earlier reply's tool use in its
   * own form: it is asked once more with that replay lowered (`ModelCall.messages`), and that request gets every handling
   * a call gets. Only counted (the worker's metric `replay_lowered`); nothing is remembered of it.
   */
  | { type: "replay_lowered" }
  | {
      type: "finish";
      usage: { inputTokens: number; outputTokens: number } | null;
      truncated: boolean;
      /** The round's tool calls, in order: [] when the model answered. */
      toolCalls: ToolCall[];
      /**
       * The round's assistant turn, for the next call's `steps`: opaque to the caller, JSON (it survives a JSON round
       * trip). What it carries is what the protocol needs back (thinking signatures, encrypted reasoning, Chat
       * Completions' `reasoning_content`).
       */
      assistant: unknown;
      /**
       * The call offered tools and they were not sent: the upstream refused them — this round was asked once more
       * without them, or they were left out because that upstream refused them before.
       */
      toolsRefused?: true;
    };

export interface ModelGateway {
  /**
   * One round of the answer: `text` / `reasoning` deltas and a `tool_call` for each tool call the model makes, then
   * exactly one `finish` (reasoning tokens are part of `outputTokens`; `usage` is null when the upstream reported none,
   * and is this round's alone; `truncated` when the model stopped for length; `toolCalls` and `assistant` for the next
   * round). A failure is a thrown `ModelError` — also an answer cut off at the output limit before any text or tool
   * call, having only thought (`thinking_exhausted`, carrying the reported usage). When `call.signal` aborts, the
   * iterator stops at once by throwing `call.signal.reason`.
   */
  stream(call: ModelCall): AsyncIterable<ModelEvent>;
  /** The provider's model list (the provider probe's `GET {baseUrl}/models`); a failure is a thrown `ModelError`. */
  listModels(p: Pick<ModelCall, "protocol" | "baseUrl" | "apiKey">): Promise<string[]>;
}

/**
 * The codes a model call fails with: those of a provider call (the address guard's, the provider's refusal, the rest),
 * and `thinking_exhausted`: the model stopped at its output limit having only thought — no answer, though reasoning
 * came or reasoning tokens were reported.
 */
export type ModelErrorCode = ProviderCallCode | "thinking_exhausted";

/**
 * THE rule of a model call that failed for a reason that clears by itself (a transient failure): the provider could not
 * be reached or did not answer properly (`provider_unavailable`) with its 5xx, 408 (timeout) or 429 (too many requests) —
 * the statuses the standard retry policies retry — or with no status at all (a network failure, a timeout, a stream cut
 * short). Any other 4xx (a request it refuses, a model or address gone), a refused key, a refused address and a model
 * that thought its whole limit away are not. Read by the rolling summary's backoff (agents/summary/job.ts `isTransient`)
 * and by the automatic retry of a reply (agents/runs.ts `transientFailure`).
 */
export function passingFailure(code: string, upstreamStatus: number | undefined): boolean {
  if (code !== "provider_unavailable") return false;
  const s = upstreamStatus;
  return s === undefined || s >= 500 || s === 408 || s === 429;
}

/** One fixed sentence per code: nothing the upstream said is ever kept. */
const MESSAGES: Readonly<Record<ModelErrorCode, string>> = {
  provider_rejected: "The model provider refused the API key.",
  provider_unavailable: "The model provider could not be reached or did not answer properly.",
  address_not_allowed: "The model provider's address is not allowed.",
  thinking_exhausted: "The model used its whole output limit thinking and gave no answer.",
};

/**
 * A failed model call: the code, for the log only the upstream's HTTP status (when it answered with an error status),
 * and the usage the upstream reported for it, when it did (`thinking_exhausted`: what the call is charged). It never
 * carries the upstream's body, headers or a cause. As an `AppError` it answers 502 (400 for `address_not_allowed`) if it
 * reaches a route.
 */
export class ModelError extends AppError {
  declare readonly code: ModelErrorCode;

  constructor(
    code: ModelErrorCode,
    readonly upstreamStatus?: number,
    readonly usage?: { inputTokens: number; outputTokens: number },
  ) {
    super(code === "address_not_allowed" ? 400 : 502, code);
    this.name = "ModelError";
    this.message = MESSAGES[code];
  }
}

type ProviderOptions = NonNullable<Parameters<typeof streamText>[0]["providerOptions"]>;
type StreamPart = TextStreamPart<ToolSet>;

const openaiChat = (effort: "low" | "medium" | "high" | "xhigh") => ({
  openai: { reasoningEffort: effort, forceReasoning: true } satisfies OpenAILanguageModelChatOptions,
});
const openaiResponses = (effort: "low" | "medium" | "high" | "xhigh" | "max") => ({
  openai: { reasoningEffort: effort, reasoningSummary: "auto", forceReasoning: true } satisfies OpenAILanguageModelResponsesOptions,
});
const anthropicEffort = (effort: "low" | "medium" | "high" | "xhigh" | "max") => ({
  anthropic: { thinking: { type: "adaptive", display: "summarized" }, effort } satisfies AnthropicLanguageModelOptions,
});
const geminiLevel = (thinkingLevel: "low" | "medium" | "high" | "xhigh") => ({
  google: { thinkingConfig: { thinkingLevel, includeThoughts: true } } satisfies GoogleLanguageModelOptions,
});

/**
 * How each reasoning level is asked for, per protocol: the SDK provider options sent with the call (on the wire:
 * README, "Calling a model"). A level a protocol cannot express is its nearest lower one (Chat Completions has no
 * `max` effort, Gemini no `max` thinking level: both `xhigh`). `none` switches thinking off where the protocol can
 * (Anthropic `thinking: disabled`) and is left out otherwise: Gemini's levels cannot switch it off, and OpenAI refuses
 * `reasoning_effort` from models that do not reason, which are exactly the ones sent `none`. The OpenAI levels also
 * mark the model as one that reasons (`forceReasoning`), so the effort is sent whatever the model is called.
 */
export const REASONING_PARAMS: Readonly<Record<Protocol, Readonly<Record<ReasoningLevel, ProviderOptions>>>> = {
  openai_chat: {
    none: {},
    low: openaiChat("low"),
    medium: openaiChat("medium"),
    high: openaiChat("high"),
    xhigh: openaiChat("xhigh"),
    max: openaiChat("xhigh"),
  },
  openai_responses: {
    none: {},
    low: openaiResponses("low"),
    medium: openaiResponses("medium"),
    high: openaiResponses("high"),
    xhigh: openaiResponses("xhigh"),
    max: openaiResponses("max"),
  },
  anthropic: {
    none: { anthropic: { thinking: { type: "disabled" } } satisfies AnthropicLanguageModelOptions },
    low: anthropicEffort("low"),
    medium: anthropicEffort("medium"),
    high: anthropicEffort("high"),
    xhigh: anthropicEffort("xhigh"),
    max: anthropicEffort("max"),
  },
  gemini: {
    none: {},
    low: geminiLevel("low"),
    medium: geminiLevel("medium"),
    high: geminiLevel("high"),
    xhigh: geminiLevel("xhigh"),
    max: geminiLevel("xhigh"),
  },
};

/**
 * Provider options every call of a protocol carries besides its reasoning: a Responses call asks OpenAI not to keep
 * the response (`store: false`; nothing here ever refers to an earlier response).
 */
const PROTOCOL_OPTIONS: Readonly<Record<Protocol, ProviderOptions>> = {
  openai_chat: {},
  openai_responses: { openai: { store: false } satisfies OpenAILanguageModelResponsesOptions },
  anthropic: {},
  gemini: {},
};

/**
 * What a call may send that an upstream may not know, besides `REASONING_PARAMS`: `thinking`, the thinking switch of
 * a Chat Completions call with `thinkingSwitch` (body field `thinking: {type: "disabled"}` at `none`, `{type:
 * "enabled"}` at any other level, next to the level's `reasoning_effort`); `summary`, the reasoning summary a
 * Responses call asks for at any level but `none` (`reasoning.summary: "auto"`); `tools`, the tool definitions of a
 * call with `tools` (and the protocol's choice field the SDK sends with them). An upstream that refuses one — a 400 or
 * 422 whose body names it — is asked once more without it, and once that is answered its later calls leave it out
 * (`Refusals`). Tools are never taken for refused on a call with `steps` (an earlier round of the same answer was sent
 * them: such a call always sends them, and a 400 to it is the call's failure), nor by a body that speaks of the
 * request's length (leaving the tools out may only have made it fit); a remembered refusal of them is forgotten after
 * `TOOLS_REFUSAL_TTL_MS`.
 */
export type OptionalField = "thinking" | "summary" | "tools";
/**
 * How a refusal names each field: what a 400's or 422's body is looked through for (its first `REFUSAL_CHARS`). Tools
 * are named as such ("tools", "tool_choice", "tool_use", "tool_calls") by most, "function calling" by some (Gemini),
 * by the request's field alone by Gemini-compatible proxies (`toolConfig`, `functionDeclarations`), in Chinese by
 * relays ("工具", "函数调用", "函數調用").
 */
const NAMES: Readonly<Record<OptionalField, RegExp>> = {
  thinking: /thinking/i,
  summary: /summary/i,
  tools: /\btools?\b|tool_(?:use|choice|calls?)|function.?call|tool_?config|function_?declarations|工具|函数调用|函數調用/i,
};
/**
 * A body that speaks of the request's length: never a refusal of tools, whatever else it names. Only the context's
 * length, window, limit or size counts: a refusal that merely says "context" (a relay echoing the request) is one.
 */
const TOO_LONG = /context.{0,20}(?:length|window|limit|size)|too long|maximum.{0,40}tokens|token limit|上下文|超出.{0,10}长度/i;
const REFUSAL_CHARS = 4096;
/** Upstreams whose refusals are remembered at most; the one used longest ago is forgotten first. */
export const MAX_REMEMBERED_UPSTREAMS = 1000;
/** How long a refusal of tools is remembered: then the upstream is offered them again (6 hours). */
export const TOOLS_REFUSAL_TTL_MS = 6 * 60 * 60 * 1000;

/** The optional fields the call sends, given what its upstream refused (`left`: left out). */
function optionalFields(call: ModelCall, left: ReadonlySet<OptionalField>): OptionalField[] {
  const fields: OptionalField[] = [];
  if (call.protocol === "openai_chat" && call.thinkingSwitch === true && !left.has("thinking")) fields.push("thinking");
  if (call.protocol === "openai_responses" && call.reasoning !== "none" && !left.has("summary")) fields.push("summary");
  if (offersTools(call) && (laterRound(call) || !left.has("tools"))) fields.push("tools");
  return fields;
}

const offersTools = (call: ModelCall): boolean => (call.tools?.length ?? 0) > 0;
/** A call with `steps`: a later round of an answer whose earlier rounds this upstream was sent the tools for. */
const laterRound = (call: ModelCall): boolean => (call.steps?.length ?? 0) > 0;

/**
 * What upstreams refused, by `ModelCall.upstreamId`, in this process: at most `MAX_REMEMBERED_UPSTREAMS` of them, each
 * field with when it was refused; a refusal of tools is forgotten `TOOLS_REFUSAL_TTL_MS` after it (`now`: the clock).
 */
export class Refusals {
  private readonly byUpstream = new Map<string, Map<OptionalField, number>>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  of(upstreamId: string | undefined): Set<OptionalField> {
    const refused = upstreamId === undefined ? undefined : this.byUpstream.get(upstreamId);
    if (upstreamId === undefined || refused === undefined) return new Set();
    const tools = refused.get("tools");
    if (tools !== undefined && this.now() - tools >= TOOLS_REFUSAL_TTL_MS) refused.delete("tools");
    this.byUpstream.delete(upstreamId);
    if (refused.size > 0) this.byUpstream.set(upstreamId, refused); // used now: forgotten last
    return new Set(refused.keys());
  }

  add(upstreamId: string | undefined, field: OptionalField): void {
    if (upstreamId === undefined) return;
    const refused = this.byUpstream.get(upstreamId) ?? new Map<OptionalField, number>();
    refused.set(field, this.now());
    this.byUpstream.delete(upstreamId);
    this.byUpstream.set(upstreamId, refused);
    if (this.byUpstream.size > MAX_REMEMBERED_UPSTREAMS) this.byUpstream.delete(this.byUpstream.keys().next().value!);
  }
}

/**
 * Whether `err` is the upstream refusing `field`: a 400 or 422 whose body names it — for tools, and does not speak of
 * the request's length (`TOO_LONG`). Only read here; never kept.
 */
function refuses(err: unknown, field: OptionalField): boolean {
  const seen = new Set<unknown>();
  for (let e: unknown = err; e != null && !seen.has(e); e = (e as { cause?: unknown }).cause) {
    seen.add(e);
    if (APICallError.isInstance(e)) {
      const body = (e.responseBody ?? "").slice(0, REFUSAL_CHARS);
      return (e.statusCode === 400 || e.statusCode === 422) && NAMES[field].test(body) && (field !== "tools" || !TOO_LONG.test(body));
    }
  }
  return false;
}

/**
 * The call's provider options: the protocol's own, with the reasoning level's merged in, per provider namespace; a
 * Responses call whose upstream refused the summary asks for none (`reasoningSummary: null`: left out, where the SDK
 * would otherwise ask for one). An Anthropic call that sends tools asks for their input whole (`toolStreaming: false`:
 * no `eager_input_streaming` on each tool, a field compatible upstreams may not know; nothing here reads an input
 * before it is complete).
 */
function providerOptionsFor(call: ModelCall, left: ReadonlySet<OptionalField>): ProviderOptions {
  const base = PROTOCOL_OPTIONS[call.protocol];
  const reasoning = REASONING_PARAMS[call.protocol][call.reasoning];
  const merged: ProviderOptions = {};
  for (const name of new Set([...Object.keys(base), ...Object.keys(reasoning)])) merged[name] = { ...base[name], ...reasoning[name] };
  if (call.protocol === "openai_responses" && call.reasoning !== "none" && left.has("summary")) {
    merged.openai = { ...merged.openai, reasoningSummary: null } satisfies OpenAILanguageModelResponsesOptions;
  }
  if (call.protocol === "anthropic" && optionalFields(call, left).includes("tools")) {
    merged.anthropic = { ...merged.anthropic, toolStreaming: false } satisfies AnthropicLanguageModelOptions;
  }
  return merged;
}

/** A model's answer may be long: the guard's size limit for one model stream. */
const MODEL_STREAM_MAX_BYTES = 8 * 1024 * 1024;
/**
 * How long a model stream may be silent (before its headers, or between its bytes) before it is given up on — THE rule
 * (`silenceAllowed`): a call that cannot be thinking — `reasoning` `none`, to a model not marked as one that may think
 * (`ModelCall.thinks`) — 60 s; a call that may be — any other level, or a model so marked at any level — for as long as
 * a reply may take (`GatewayOptions.thinkingIdleTimeoutMs`), because an upstream that does not stream its thinking sends
 * nothing at all until it has thought, and what bounds such a call is its caller's signal (a reply's own time, a
 * memory call's or a draft's deadline, the provider test's 15 s). Whichever it is, an address that cannot be found or
 * connected to is given up on after the 60 s.
 */
const MODEL_IDLE_TIMEOUT_MS = 60_000;
/** The silence a thinking call is allowed when the gateway is not told how long a reply may take: 5 minutes. */
const MODEL_THINKING_IDLE_TIMEOUT_MS = 300_000;

export interface GatewayOptions {
  /** Where its calls are counted: the app's one count of calls through the guard (`GuardOptions.calls`). */
  calls: Slots;
  /** Tests only (`BuildOptions`): models may be reached at loopback addresses, over `http:` there. */
  allowInsecureLocal?: boolean;
  /** Default 60 s; tests shorten it. */
  idleTimeoutMs?: number;
  /**
   * How long a call that thinks may be silent: the longest a reply may take (the app: the longer of
   * `AGENT_RUN_TIMEOUT_MS` and `TOOLS.runTimeoutMs`), never less than `idleTimeoutMs`. Default 5 minutes.
   */
  thinkingIdleTimeoutMs?: number;
}

/**
 * The gateway over the AI SDK. Its calls are counted with every other call through the guard (`options.calls`: at
 * most `PROVIDER_MAX_CONCURRENT_CALLS` in flight in the whole service).
 */
export function createModelGateway(options: GatewayOptions): ModelGateway {
  // The SDK reports settings a model ignores through `process.emitWarning`, outside the service's log: not wanted.
  globalThis.AI_SDK_LOG_WARNINGS = false;
  const guard = { calls: options.calls, ...(options.allowInsecureLocal === true ? { allowInsecureLocal: true } : {}) };
  const idleMs = options.idleTimeoutMs ?? MODEL_IDLE_TIMEOUT_MS;
  const sized = { ...guard, maxResponseBytes: MODEL_STREAM_MAX_BYTES };
  const fetch = guardedFetch({ ...sized, timeoutMs: idleMs });
  const patient = guardedFetch({ ...sized, timeoutMs: Math.max(idleMs, options.thinkingIdleTimeoutMs ?? MODEL_THINKING_IDLE_TIMEOUT_MS), connectTimeoutMs: idleMs });
  /** THE rule of how long a call may be silent (`MODEL_IDLE_TIMEOUT_MS`): by whether it may be thinking. */
  const silenceAllowed = (call: ModelCall): typeof globalThis.fetch => (call.reasoning !== "none" || call.thinks === true ? patient : fetch);
  const probe = createProviderProbe(guardedFetch({ ...guard, ...PROBE_GUARD }));
  const refusals = new Refusals();
  return {
    stream: (call) => streamCall(call, silenceAllowed(call), refusals),
    async listModels(p) {
      try {
        return await probe.listModels(p);
      } catch (err) {
        throw toModelError(err);
      }
    },
  };
}

/** The SDK's model for the call's protocol, at `baseUrl` as it is, with the key, every request through the guard. */
function languageModel(call: ModelCall, fetch: typeof globalThis.fetch): LanguageModel {
  const settings = { baseURL: call.baseUrl, apiKey: call.apiKey, fetch };
  switch (call.protocol) {
    case "openai_chat":
      return createOpenAI(settings).chat(call.model);
    case "openai_responses":
      return createOpenAI(settings).responses(call.model);
    case "anthropic":
      return createAnthropic(settings).messages(call.model);
    case "gemini":
      return createGoogle(settings).languageModel(call.model);
  }
}

/** Whether the call's turns hold an earlier reply's tool use (a replay: `ReplayCall` / `ReplayResult` parts, a `tool` turn). */
export const carriesReplay = (messages: ModelCall["messages"]): boolean =>
  messages.some((m) => m.role === "tool" || m.parts.some((p) => p.type === "tool-call" || p.type === "tool-result"));

/** Whether every tool an earlier reply's replayed call names is among the call's tools. */
const offersReplayed = (call: ModelCall): boolean => {
  const offered = new Set((call.tools ?? []).map((t) => t.name));
  return call.messages.every((m) => m.parts.every((p) => (p.type !== "tool-call" && p.type !== "tool-result") || offered.has(p.name)));
};

/** A replayed call's id as the protocol writes its own (`ReplayCall.id`, 22 hex digits): `toolu_01…` on Anthropic, `call_…` elsewhere. */
export const replayWireId = (protocol: Protocol, id: string): string => (protocol === "anthropic" ? `toolu_01${id}` : `call_${id}`);

/** A text or attachment part of an assistant turn, as the protocols take it from the model's side: text only. */
const assistantText = (p: Part): { type: "text"; text: string } => ({ type: "text", text: p.type === "text" ? p.text : p.type === "file" ? `[文件：${p.name}]` : "[图片]" });

/** A tool's result as the SDK takes it: a string output as it is, anything else as JSON (the one form steps and replays share). */
const resultPart = (toolCallId: string, toolName: string, output: unknown): ToolResultPart => ({
  type: "tool-result",
  toolCallId,
  toolName,
  output: typeof output === "string" ? { type: "text", value: output } : { type: "json", value: (output ?? null) as JSONValue },
});

/**
 * The call's turns as SDK messages. A user turn keeps every part: images as image files, PDFs as files with their
 * name. An assistant turn is text only (the protocols take no files from the model's side): a file in one is sent as
 * `[文件：{name}]`, an image as `[图片]`. An earlier reply's tool use (`ModelCall.messages`): with `native` (the protocol of a
 * request that sends the tools, which offer every tool it calls) its calls go in their assistant turn and each `tool`
 * turn as the protocol's tool results, ids in the protocol's style (`replayWireId`) — what `stepMessages` builds for a
 * round; without, it is lowered: calls and `tool` turns left out, an assistant turn left with nothing dropped, and an
 * assistant turn after a `tool` turn joined to the one before it — the turns as they were before any replay. A call
 * whose turns hold no replay is converted exactly as it always was.
 */
function toModelMessages(messages: ModelCall["messages"], native: Protocol | null = null): ModelMessage[] {
  const userTurn = (parts: TurnPart[]): ModelMessage => ({
    role: "user",
    content: parts.flatMap((p): Array<TextPart | FilePart> =>
      p.type === "text"
        ? [{ type: "text" as const, text: p.text }]
        : p.type === "image"
          ? [{ type: "file" as const, mediaType: p.mime, data: p.data }]
          : p.type === "file"
            ? [{ type: "file" as const, mediaType: p.mime, data: p.data, filename: p.name }]
            : [],
    ),
  });
  if (!carriesReplay(messages)) {
    return messages.map((m): ModelMessage => (m.role === "assistant" ? { role: "assistant", content: m.parts.flatMap((p) => (p.type === "tool-call" || p.type === "tool-result" ? [] : [assistantText(p)])) } : userTurn(m.parts)));
  }
  const out: ModelMessage[] = [];
  /** Lowering: a `tool` turn was just left out, so the next assistant turn goes on the one before it. */
  let joined = false;
  for (const m of messages) {
    if (m.role === "tool") {
      if (native !== null) out.push({ role: "tool", content: m.parts.flatMap((p) => (p.type === "tool-result" ? [resultPart(replayWireId(native, p.id), p.name, p.output)] : [])) });
      else joined = true;
      continue;
    }
    if (m.role === "user") {
      joined = false;
      out.push(userTurn(m.parts));
      continue;
    }
    const content: AssistantContent = m.parts.flatMap((p): AssistantContent =>
      p.type === "tool-call"
        ? native === null
          ? []
          : [{ type: "tool-call", toolCallId: replayWireId(native, p.id), toolName: p.name, input: p.input }]
        : p.type === "tool-result"
          ? []
          : [assistantText(p)],
    );
    const last = out[out.length - 1];
    if (native === null && joined && last?.role === "assistant" && Array.isArray(last.content)) last.content.push(...content);
    else if (native !== null || content.length > 0 || !m.parts.some((p) => p.type === "tool-call")) out.push({ role: "assistant", content });
    joined = false;
  }
  return out;
}

/** An SDK assistant message's parts (text and tool calls: all a replay or a conversation's turn holds). */
type AssistantContent = Array<Extract<AssistantModelMessage["content"], unknown[]>[number]>;

/** The tools as the SDK takes them: a description and an input schema each, and no `execute` (the caller runs them). */
function toolSet(specs: ToolSpec[]): ToolSet {
  return Object.fromEntries(specs.map((s) => [s.name, tool({ description: s.description, inputSchema: jsonSchema(s.parameters as JSONSchema7) })]));
}

/** A step's assistant turn: what an earlier finish gave as `assistant` (`assistantTurn`). */
const turnOf = (step: { assistant: unknown }): ModelMessage[] => step.assistant as ModelMessage[];

/**
 * The rounds so far as SDK messages, after the conversation: each round's assistant turn as its finish gave it, then
 * one tool message with its results (none: no tool message). A string output is sent as it is, anything else as JSON.
 */
function stepMessages(steps: NonNullable<ModelCall["steps"]>): ModelMessage[] {
  return steps.flatMap((step): ModelMessage[] => [
    ...turnOf(step),
    ...(step.results.length === 0 ? [] : [{ role: "tool" as const, content: step.results.map((r) => resultPart(r.id, r.name, r.output)) }]),
  ]);
}

/**
 * The round's assistant turn, as `steps` takes it back: the SDK's response messages for the round, its assistant
 * message only — text, reasoning with what the provider attached to it (Anthropic's signature, OpenAI's encrypted
 * reasoning), tool calls with theirs (Gemini's thought signature). The tool message the SDK adds for a call it found
 * invalid is left out: the caller answers every call. On Chat Completions, whose reasoning the SDK neither reads nor
 * sends, the reasoning read off the stream goes in as a reasoning part (`chatReasoning`; `chatFetch` sends it back).
 * Plain JSON: strings, numbers and objects only.
 */
function assistantTurn(messages: readonly ModelMessage[] | undefined, chatReasoning: string): AssistantModelMessage[] {
  const turn = (messages ?? []).filter((m): m is AssistantModelMessage => m.role === "assistant");
  const [first, ...rest] = turn;
  if (chatReasoning === "" || first === undefined) return turn;
  const content = typeof first.content === "string" ? [{ type: "text" as const, text: first.content }] : first.content;
  return [{ ...first, content: [{ type: "reasoning", text: chatReasoning }, ...content] }, ...rest];
}

/** Chat Completions: an earlier round's assistant message that called tools — its first call's id and the reasoning it read. */
interface ChatRound {
  firstCall: string;
  reasoning: string;
}

/**
 * Chat Completions: the reasoning each earlier round read off the stream (`assistantTurn`), round by round — one entry
 * for each assistant message of the steps that calls tools, in order, as the request's own assistant messages with
 * `tool_calls` come (the conversation's are text only). What upstreams that think while calling tools (DeepSeek, Kimi
 * and others) need back with it.
 */
function chatRounds(steps: ModelCall["steps"]): ChatRound[] {
  const rounds: ChatRound[] = [];
  for (const message of (steps ?? []).flatMap(turnOf)) {
    if (message.role !== "assistant" || typeof message.content === "string") continue;
    const call = message.content.find((p) => p.type === "tool-call");
    if (call === undefined) continue;
    rounds.push({ firstCall: call.toolCallId, reasoning: message.content.flatMap((p) => (p.type === "reasoning" ? [p.text] : [])).join("") });
  }
  return rounds;
}

/** The reported usage, or null unless the upstream reported both counts. */
function usageOf(usage: LanguageModelUsage): { inputTokens: number; outputTokens: number } | null {
  const { inputTokens, outputTokens } = usage;
  return typeof inputTokens === "number" && typeof outputTokens === "number" ? { inputTokens, outputTokens } : null;
}

/**
 * Any failure as a `ModelError`, looking through causes: the guard's refusal is `address_not_allowed`; an upstream
 * error status is `provider_rejected` for 401/403 and `provider_unavailable` otherwise; everything else (network,
 * timeout, size, a redirect, a stream that is malformed or cut short) is `provider_unavailable`.
 */
function toModelError(err: unknown): ModelError {
  const seen = new Set<unknown>();
  for (let e: unknown = err; e != null && !seen.has(e); e = (e as { cause?: unknown }).cause) {
    seen.add(e);
    if (e instanceof ModelError) return e;
    if (e instanceof ProviderCallError) return new ModelError(e.code as ModelErrorCode, e.upstreamStatus);
    if (e instanceof AppError && e.code === "address_not_allowed") return new ModelError("address_not_allowed");
    if (APICallError.isInstance(e) && e.statusCode !== undefined && e.statusCode >= 300) {
      return new ModelError(keyRefused(e.statusCode) ? "provider_rejected" : "provider_unavailable", e.statusCode);
    }
  }
  return new ModelError("provider_unavailable");
}

/**
 * The `fetch` of a Chat Completions call: the request's JSON body gets the thinking switch when it is sent
 * (`thinking`) and, on the assistant message of each earlier round that read reasoning (`rounds`), that reasoning as
 * `reasoning_content`; and every successful response's body is read by `tap` on its way to the SDK, `tool_calls` and
 * all, unchanged. A body that gets neither is sent as the SDK wrote it. The key stays in the headers the SDK set;
 * nothing here reads them.
 */
function chatFetch(
  fetch: typeof globalThis.fetch,
  tap: ChatReasoningTap,
  thinking: { type: "enabled" | "disabled" } | null,
  rounds: readonly ChatRound[],
  replayed: ReadonlySet<string>,
): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const res = await fetch(input, withChatFields(init, thinking, rounds, replayed));
    if (!res.ok || res.body === null) return res;
    return new Response(res.body.pipeThrough(tap.transform()), { status: res.status, statusText: res.statusText, headers: res.headers });
  }) as typeof globalThis.fetch;
}

/**
 * `chatFetch`'s request: the thinking switch and the earlier rounds' reasoning added to its body, or as it was. The
 * body's assistant messages with `tool_calls` are the rounds, in order — but those of an earlier reply returned in the
 * history (their first call's id among `replayed`, the wire ids of the call's `ReplayCall`s), which are none of this
 * answer's and read no reasoning: the n-th of the rest gets the n-th round's reasoning when there is some and its first
 * call's id is that round's (ids alone may repeat from round to round).
 */
function withChatFields(
  init: RequestInit | undefined,
  thinking: { type: "enabled" | "disabled" } | null,
  rounds: readonly ChatRound[],
  replayed: ReadonlySet<string> = new Set(),
): RequestInit | undefined {
  if ((thinking === null && !rounds.some((r) => r.reasoning !== "")) || typeof init?.body !== "string") return init;
  const body = JSON.parse(init.body) as { messages?: unknown; thinking?: unknown };
  let changed = false;
  let n = 0;
  for (const message of Array.isArray(body.messages) ? (body.messages as Array<Record<string, unknown>>) : []) {
    const calls = message?.role === "assistant" && Array.isArray(message.tool_calls) ? (message.tool_calls as Array<{ id?: unknown }>) : [];
    if (calls.length === 0) continue;
    if (typeof calls[0]?.id === "string" && replayed.has(calls[0].id)) continue;
    const round = rounds[n++];
    if (round === undefined || round.reasoning === "" || calls[0]?.id !== round.firstCall) continue;
    message.reasoning_content = round.reasoning;
    changed = true;
  }
  if (thinking !== null) {
    body.thinking = thinking;
    changed = true;
  }
  return changed ? { ...init, body: JSON.stringify(body) } : init;
}

/** `attempt`'s events: its finish also says how many reasoning tokens the upstream reported (0: none). */
type AttemptEvent =
  | Exclude<ModelEvent, { type: "finish" } | { type: "replay_lowered" }>
  | (Omit<Extract<ModelEvent, { type: "finish" }>, "toolsRefused"> & { reasoningTokens: number });

/** Whether `err` is the upstream answering 400 or 422 (looking through causes): a request it will not take as it is. */
function rejected(err: unknown): boolean {
  const seen = new Set<unknown>();
  for (let e: unknown = err; e != null && !seen.has(e); e = (e as { cause?: unknown }).cause) {
    seen.add(e);
    if (APICallError.isInstance(e)) return e.statusCode === 400 || e.statusCode === 422;
  }
  return false;
}

/**
 * Whether a request of `call` that sends `sent` sends an earlier reply's tool use in the protocol's own form: it carries a
 * replay, sends the tools, they offer every tool it calls, and it was not lowered already.
 */
const sendsReplay = (call: ModelCall, sent: readonly OptionalField[], lowered: boolean): boolean =>
  !lowered && sent.includes("tools") && carriesReplay(call.messages) && offersReplayed(call);

/**
 * The call as events: one attempt (`attempt`), and when the upstream refused an optional field it sent
 * (`OptionalField`) before anything came back, one more without it — the refusal remembered for the call's upstream
 * once that one shows leaving it out helped (its first event came), so a refusal for some other reason, which fails
 * the retry too, is not. Tools are never left out of a call with `steps`. A call that offered tools and did not send
 * them finishes `toolsRefused`. A model that stopped for length with no answer (no text that shows anything, no tool
 * call with an input), having reasoned — reasoning came, or the upstream reported reasoning tokens — ends
 * `thinking_exhausted`, with the usage it reported, instead of finishing.
 *
 * First of all, a request that sent an earlier reply's tool use in its own form (`sendsReplay`) and was answered 400 or
 * 422 before anything came back is made once more with that replay lowered (`replay_lowered`, counted by the caller):
 * that is the request the conversation makes with no replay, and it gets all of the above as any call does — its own
 * refusal of a field included. Nothing is remembered of the first one, nor is any field taken for refused by it.
 */
async function* streamCall(call: ModelCall, fetch: typeof globalThis.fetch, refusals: Refusals): AsyncGenerator<ModelEvent> {
  try {
    call.signal.throwIfAborted();
    const left = refusals.of(call.upstreamId);
    /** The fields that may be left out on a refusal: all but the tools of a later round. */
    const droppable = (field: OptionalField) => field !== "tools" || !laterRound(call);
    /** The field the first attempt was refused, left out of the retry. */
    let refused: OptionalField | undefined;
    /** The replay was lowered after the upstream refused the request carrying it. */
    let lowered = false;
    let retry = false;
    for (;;) {
      const sent = optionalFields(call, left);
      const toolsRefused = offersTools(call) && !sent.includes("tools");
      const native = sendsReplay(call, sent, lowered);
      let started = false;
      let answered = false;
      let thought = false;
      try {
        for await (const event of attempt(call, fetch, left, native)) {
          if (!started && refused !== undefined) refusals.add(call.upstreamId, refused);
          started = true;
          if (event.type === "finish") {
            const { usage, truncated, reasoningTokens, toolCalls, assistant } = event;
            if (truncated && !answered && (thought || reasoningTokens > 0)) throw new ModelError("thinking_exhausted", undefined, usage ?? undefined);
            yield { type: "finish", usage, truncated, toolCalls, assistant, ...(toolsRefused ? { toolsRefused: true as const } : {}) };
            return;
          }
          if (event.type === "text") answered ||= hasVisibleText(event.delta);
          else if (event.type === "tool_call") answered ||= event.call.input !== null; // a call cut short is no answer
          else thought = true;
          yield event;
        }
        return;
      } catch (err) {
        if (native && !started && !call.signal.aborted && rejected(err)) {
          lowered = true;
          yield { type: "replay_lowered" };
          continue;
        }
        refused = started || retry || call.signal.aborted ? undefined : sent.find((field) => droppable(field) && refuses(err, field));
        if (refused === undefined) throw err;
        left.add(refused);
        retry = true;
      }
    }
  } catch (err) {
    call.signal.throwIfAborted();
    throw toModelError(err);
  }
}

/**
 * One request of the call, as events; a failure is thrown as it came (`streamCall` makes it a `ModelError`). On Chat
 * Completions (where the SDK reads no reasoning) a delta's own reasoning field is read off the stream
 * (`ChatReasoningTap`) and comes out in its place among the text, as soon as it arrives; an answer that streamed none
 * of it before its first text and opens with `<think>` has that block taken out as reasoning (`ThinkTags`). Reasoning
 * never becomes text. One round only (the SDK's default: one step): a tool call is reported (`tool_call`; its input
 * null when the SDK found it invalid — not JSON, or a tool the call did not offer) and never run; the finish names the
 * calls and carries the round's assistant turn (`assistantTurn`), which the SDK hands over (`onStepEnd`) before it
 * gives the finish. `native`: an earlier reply's tool use goes in the protocol's own form (`sendsReplay`); else lowered.
 */
async function* attempt(call: ModelCall, fetch: typeof globalThis.fetch, left: ReadonlySet<OptionalField>, native = false): AsyncGenerator<AttemptEvent> {
  // Ends the upstream request however this iterator ends: finished, failed, stopped, or left early by its reader.
  const own = new AbortController();
  const tap = call.protocol === "openai_chat" ? new ChatReasoningTap() : null;
  const sent = optionalFields(call, left);
  const thinking = sent.includes("thinking") ? { type: call.reasoning === "none" ? ("disabled" as const) : ("enabled" as const) } : null;
  const tools = sent.includes("tools") ? toolSet(call.tools ?? []) : undefined;
  // Tools it offers that are not sent: the text for going without them, when the call gives one.
  const system = offersTools(call) && tools === undefined ? (call.systemWithoutTools ?? call.system) : call.system;
  /** Chat Completions: undecided until the first text, then whether the answer is looked at for `<think>`. */
  let tags: ThinkTags | null | undefined = tap ? undefined : null;
  /** Reasoning arrived in the protocol's own field. */
  let structured = false;
  /** Chat Completions: the reasoning read off the stream so far, for the round's assistant turn. */
  const tapped: string[] = [];
  /** Reasoning the tap gives, due now: the protocol's own (`structured`), and kept (`tapped`). */
  const fromTap = (deltas: string[]): string[] => {
    if (deltas.length > 0) structured = true;
    tapped.push(...deltas);
    return deltas;
  };
  const toolCalls: ToolCall[] = [];
  /** The SDK's response messages for the round, once it has them. */
  let responded: ModelMessage[] | undefined;
  let parts: AsyncIterator<StreamPart> | undefined;
  try {
    // An earlier reply's calls, as the wire names them: none of this answer's rounds (`withChatFields`).
    const replayed = new Set(native ? call.messages.flatMap((m) => m.parts.flatMap((p) => (p.type === "tool-call" ? [replayWireId(call.protocol, p.id)] : []))) : []);
    const result = streamText({
      model: languageModel(call, tap ? chatFetch(fetch, tap, thinking, chatRounds(call.steps), replayed) : fetch),
      ...(system === "" ? {} : { instructions: system }),
      messages: [...toModelMessages(call.messages, native && tools !== undefined ? call.protocol : null), ...stepMessages(call.steps ?? [])],
      // A choice only with tools, and `none` only: `auto` is what the SDK sends when none is given.
      ...(tools === undefined ? {} : { tools, ...(call.toolChoice === "none" ? { toolChoice: "none" as const } : {}) }),
      maxOutputTokens: call.maxOutputTokens,
      providerOptions: providerOptionsFor(call, left),
      abortSignal: AbortSignal.any([call.signal, own.signal]),
      maxRetries: 0,
      telemetry: { isEnabled: false },
      // Failures arrive below as `error` parts; the default handler would print them, upstream text and all.
      onError: () => {},
      onStepEnd: (step) => {
        responded = step.response.messages;
      },
    });
    parts = result.stream[Symbol.asyncIterator]();
    let next: Promise<IteratorResult<StreamPart>> | null = null;
    while (true) {
      if (tap) {
        // Reasoning ahead of every text still to come is due now, whatever the SDK is waiting for.
        const due = fromTap(tap.leading());
        for (const delta of due) yield { type: "reasoning", delta };
        if (due.length > 0) continue;
      }
      next ??= parts.next();
      const got = tap ? await Promise.race([next, tap.changed().then(() => null)]) : await next;
      call.signal.throwIfAborted();
      if (got === null) continue;
      next = null;
      if (got.done) break;
      const part = got.value;
      switch (part.type) {
        case "text-delta":
          if (part.text === "") break;
          for (const delta of fromTap(tap?.beforeText() ?? [])) yield { type: "reasoning", delta };
          if (tags === undefined) tags = structured ? null : new ThinkTags();
          if (tags) for (const split of tags.push(part.text)) yield split;
          else yield { type: "text", delta: part.text };
          break;
        case "reasoning-delta":
          if (part.text !== "") yield { type: "reasoning", delta: part.text };
          break;
        case "tool-call": {
          // A call the provider ran itself (a server tool of its own, `web_search` say) is none of ours: never handed to
          // the loop, where it would be run again or counted as garbled (lane websearch, attack I7).
          if (part.providerExecuted === true) break;
          // The reasoning the tap read before the call comes out before it.
          for (const delta of fromTap(tap?.leading() ?? [])) yield { type: "reasoning", delta };
          const made: ToolCall = { id: part.toolCallId, name: part.toolName, input: part.invalid === true ? null : part.input };
          toolCalls.push(made);
          yield { type: "tool_call", call: made };
          break;
        }
        case "error":
          throw part.error;
        case "abort":
          throw new ModelError("provider_unavailable");
        case "finish":
          for (const delta of fromTap(tap?.rest() ?? [])) yield { type: "reasoning", delta };
          if (tags) for (const split of tags.end()) yield split;
          // "interrupted": the stream ended without the protocol's completion; "error": the upstream reported one.
          if (part.finishReason === "interrupted" || part.finishReason === "error") throw new ModelError("provider_unavailable");
          yield {
            type: "finish",
            usage: usageOf(part.totalUsage),
            truncated: part.finishReason === "length",
            reasoningTokens: part.totalUsage.outputTokenDetails?.reasoningTokens ?? 0,
            toolCalls,
            assistant: assistantTurn(responded, tapped.join("")),
          };
          return;
      }
    }
    throw new ModelError("provider_unavailable");
  } finally {
    own.abort();
    // Not awaited: a read still pending ends with the abort.
    void parts?.return?.()?.catch(() => {});
  }
}
