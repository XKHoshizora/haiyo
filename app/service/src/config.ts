import { isIP } from "node:net";
import path from "node:path";
import { z } from "zod";
import { normaliseBaseUrl } from "./providers/guard.ts";

/** Which X-Forwarded-For hops Fastify trusts: none, or those that come from these addresses / ranges. */
export type TrustProxy = false | string[];

/** An address, or an address with a prefix length in range for its family (`10.0.0.0/8`, `fd00::/8`). */
function isAddressOrRange(entry: string): boolean {
  const [address = "", prefix, ...rest] = entry.split("/");
  const family = isIP(address);
  if (family === 0 || rest.length > 0) return false;
  if (prefix === undefined) return true;
  return /^(0|[1-9][0-9]{0,2})$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128);
}

/**
 * `TRUST_PROXY`: unset, empty, `false` or `0` trust nothing; otherwise a comma-separated list of the proxies'
 * addresses / CIDR ranges, so X-Forwarded-For is only read when the connection comes from one of them (Fastify
 * then takes the right-most entry not from a listed proxy). Refused, with a message saying why: a bare `true`
 * (Fastify would take the left-most X-Forwarded-For entry, which the client writes) and a hop count (it cannot
 * tell the proxy from a client that connects directly; Fastify 5 ignores it and trusts nothing).
 */
function parseTrustProxy(raw: string | undefined): TrustProxy | string {
  if (raw === undefined || raw === "false" || raw === "0") return false;
  const instead =
    "set CLIENT_IP_HEADER to the header your proxy sets (e.g. x-real-ip), or TRUST_PROXY to the proxies' addresses/CIDRs";
  if (raw === "true") return `TRUST_PROXY=true would trust a client-supplied X-Forwarded-For and is not accepted; ${instead}`;
  if (/^[0-9]+$/.test(raw)) return `TRUST_PROXY=${raw}: a hop count cannot tell the proxy from a direct client and is not accepted; ${instead}`;
  const entries = raw.split(",").map((s) => s.trim());
  const bad = entries.filter((e) => !isAddressOrRange(e));
  if (bad.length > 0) {
    return `TRUST_PROXY must be a comma-separated list of addresses/CIDRs (not ${JSON.stringify(bad.join(","))})`;
  }
  return entries;
}

export const PROTOCOLS = ["openai_chat", "openai_responses", "anthropic", "gemini"] as const;
export type Protocol = (typeof PROTOCOLS)[number];
export const REASONING_LEVELS = ["none", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];
/** How readily an Agent answers unprompted (`agents.proactive_level`; the keys of `ProactiveConfig.base`). */
export const PROACTIVE_LEVELS = ["less", "normal", "more"] as const;
export type ProactiveLevel = (typeof PROACTIVE_LEVELS)[number];
/** The levels that think: every level but `none`. */
export type ThinkingLevel = Exclude<ReasoningLevel, "none">;
/**
 * Tokens of thinking a call at each level may use on top of its reply's own output limit (`REASONING_ALLOWANCE_TOKENS`;
 * how the sum is bounded: `outputLimit` in src/models/resolve.ts).
 */
export type ReasoningAllowance = Readonly<Record<ThinkingLevel, number>>;
export const DEFAULT_REASONING_ALLOWANCE: ReasoningAllowance = { low: 2000, medium: 6000, high: 12000, xhigh: 24000, max: 48000 };

/** The service's own secrets: a site model's `apiKeyEnv` may not name one (its value would be sent upstream as a key). */
export const SERVICE_SECRET_VARIABLES = ["DATABASE_URL", "AUTH_SECRET", "PROVIDER_KEY_SECRET", "S3_SECRET_ACCESS_KEY", "S3_ACCESS_KEY_ID", "RESEND_API_KEY"] as const;

/** A model the site itself offers. `apiKeyEnv` names the environment variable holding the upstream key. */
export interface SiteModel {
  id: string;
  label: string;
  tier: "free" | "paid";
  protocol: Protocol;
  baseUrl: string;
  apiKeyEnv: string;
  model: string;
  /** Micro-points per token. */
  inputMicroPerToken: number;
  outputMicroPerToken: number;
  maxOutputTokens: number;
  contextTokens: number;
  vision: boolean;
  pdf: boolean;
  reasoning: ReasoningLevel[];
  /**
   * Chat Completions only: the upstream thinks unless told not to, and takes the common switch for it (`thinking:
   * {type: "enabled" | "disabled"}`, src/models/gateway.ts). Absent: false, nothing of it is sent.
   */
  thinkingSwitch?: boolean;
  /**
   * Whether its replies may be offered tools (README "Agents and runs", Tools in a reply). Absent from the JSON: true —
   * every model is given them until it is known not to cope; `false` is the operator's word, for a model measured unable
   * (the acceptance run decides). The service never changes it: a site model that refuses tools is only logged.
   */
  tools: boolean;
}

/** What names the environment variable holding an upstream's key (`apiKeyEnv`). */
const keyVariable = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be an environment variable name");

const siteModelSchema = z.strictObject({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(100),
  tier: z.enum(["free", "paid"]),
  protocol: z.enum(PROTOCOLS),
  baseUrl: z.url(),
  apiKeyEnv: keyVariable,
  model: z.string().min(1),
  inputMicroPerToken: z.number().int().min(0),
  outputMicroPerToken: z.number().int().min(0),
  maxOutputTokens: z.number().int().positive(),
  contextTokens: z.number().int().positive(),
  vision: z.boolean(),
  pdf: z.boolean(),
  reasoning: z.array(z.enum(REASONING_LEVELS)),
  thinkingSwitch: z.boolean().optional(),
  tools: z.boolean().default(true),
});

/** The judgement model's configuration (`JUDGE`): where to ask, with which keys, and how long and how often. */
export interface JudgeConfig {
  model: string;
  /** One or two channels, tried in order; each `apiKeyEnv` names ANOTHER variable that holds its key. */
  channels: { url: string; apiKeyEnv: string }[];
  timeoutMs: number;
  /** Judgements the site makes a day, at most (counted by the proactive worker). */
  dailyLimit: number;
}

const judgeSchema = z.strictObject({
  model: z.string().min(1).max(200),
  channels: z
    .array(
      z.strictObject({
        url: z.url(),
        apiKeyEnv: keyVariable,
      }),
    )
    .min(1)
    .max(2),
  timeoutMs: z.number().int().min(500).max(30_000).default(4000),
  dailyLimit: z.number().int().min(1).max(10_000_000).default(20_000),
});

/** What the proactive replies are tuned by (`PROACTIVE`); every number is a site setting with this default. */
export interface ProactiveConfig {
  debounceMs: number;
  transcriptMessages: number;
  transcriptChars: number;
  base: { less: number; normal: number; more: number };
  surchargeStep: number;
  surchargeMax: number;
  surchargeHalfLifeS: number;
  surchargeHalfMessages: number;
  quietBig: { at: number; raise: number; halfLifeS: number };
  quietSmall: { at: number; raise: number; halfLifeS: number };
  cap: number;
  fuse: { perSeconds: number; perHour: number };
  /** Judgements asked for within an hour, at most, about one group and about the messages of one sender (scheduler.ts). */
  perGroupHour: number;
  perSenderHour: number;
}

const probability = (fallback: number) => z.number().min(0).max(1).default(fallback);
const positive = (fallback: number, max: number) => z.number().int().min(1).max(max).default(fallback);
/** An object whose every field is defaulted: nothing (or `{}`) gives all the defaults, a partial one keeps the rest. */
const defaulted = <T extends z.ZodRawShape>(shape: T) => z.strictObject(shape).prefault({} as never);

// The defaults are those calibrated on the real judgement model (batch 2D): the right Agent's pick probability was at
// least 0.74 where a reply was expected, the top Agent's at most 0.70 where none was.
const proactiveSchema = z.strictObject({
  debounceMs: positive(3000, 60_000),
  transcriptMessages: positive(15, 100),
  transcriptChars: positive(300, 5000),
  base: defaulted({ less: probability(0.8), normal: probability(0.65), more: probability(0.5) }),
  surchargeStep: probability(0.1),
  surchargeMax: probability(0.25),
  surchargeHalfLifeS: positive(120, 86_400),
  surchargeHalfMessages: positive(4, 1000),
  quietBig: defaulted({ at: probability(0.8), raise: probability(0.33), halfLifeS: positive(3600, 604_800) }),
  quietSmall: defaulted({ at: probability(0.3), raise: probability(0.15), halfLifeS: positive(600, 604_800) }),
  cap: probability(0.98),
  fuse: defaulted({ perSeconds: positive(10, 3600), perHour: positive(30, 100_000) }),
  perGroupHour: positive(600, 100_000),
  perSenderHour: positive(300, 100_000),
});

/**
 * What bounds a reply's tools (`TOOLS`; README "Agents and runs", Tools in a reply); every number is a site setting with
 * this default.
 */
export interface ToolsConfig {
  /** False: no reply is offered any tool (src/agents/port-impl.ts `begin`: `Prepared.tools` is always empty). */
  enabled: boolean;
  /** Rounds one reply may run tools in; then one last call answers, calling none (src/agents/runtime/worker.ts). */
  maxRounds: number;
  /**
   * Whole points one reply may spend before it must answer: no tool round after its first is started that could take it
   * past this (src/agents/port-impl.ts `extend`), so a reply costs at most the larger of this and its first round (which
   * admission alone bounds), and its one last call.
   */
  maxPoints: number;
  /**
   * Calls of the search tool, of the file tool and of the clock, one reply may run (src/agents/tools/index.ts, each tool's
   * own count in the loop); further ones are answered with a fixed note.
   */
  searchPerReply: number;
  filePerReply: number;
  timePerReply: number;
  /**
   * The most one tool result weighs (metering/tokens.ts `weight`) when it goes back to the model; more is cut, and marked
   * so. A reply offered tools keeps room for two in its context plan, at most a third of the conversation's
   * (src/agents/port-impl.ts `begin`).
   */
  resultMaxWeight: number;
  /**
   * How long a reply that offers tools may take in all, its rounds and its tools, in ms (each model call and each tool
   * also within `AGENT_RUN_TIMEOUT_MS`); a reply that offers none is held to `AGENT_RUN_TIMEOUT_MS` alone, as before.
   */
  runTimeoutMs: number;
  /** The web search (`search_web`, src/agents/tools/web/; `TOOLS.web`): off unless the operator turns it on. */
  web: WebSearchConfig;
}

/**
 * The web search's site settings (`TOOLS.web`; README "Agents and runs", Web search). Every field has a default, so a
 * `TOOLS` without `web` parses as before and the search stays off. The product owner's rules (2026-11-22): every lane,
 * every model; a search is part of the reply's cost, paid from the owner's points; no cap per owner — the points are the
 * bound; the site's own money fuse is the operator's cost insurance, not a rule for users.
 */
export interface WebSearchConfig {
  /** The site switch: false (the default), no reply is offered the web search and nothing anywhere changes. */
  enabled: boolean;
  /** Which adapter calls the engine (src/agents/tools/web/engine.ts): Exa's search (the default) or DeepSeek's. */
  engine: WebEngineName;
  /**
   * The engine's address (https; default by engine, `WEB_ENGINE_DEFAULTS`; another host only with `baseUrlProxy`, so that
   * a switch of engine never posts one vendor's key to the other) and the environment variable holding its key — fixed
   * by engine (`WEB_SEARCH_API_KEY` for Exa, `WEB_SEARCH_DEEPSEEK_API_KEY` for DeepSeek): `TOOLS.web.apiKeyEnv` may only
   * repeat it, so no setting sends another variable (a service secret, the database's address) to the engine or a proxy;
   * missing: not offered, a start-up line says so.
   */
  baseUrl: string;
  apiKeyEnv: string;
  /** DeepSeek's model (`deepseek_messages` only). */
  model: string;
  /** Exa's search type (`exa_search` only): `auto` (the default), `lite` or `fast`. */
  exaType: "auto" | "lite" | "fast";
  /**
   * What one search costs the owner, fixed, in micro-points: the ONE value to retune when the engine changes (the Agent
   * form's 每次约 n 点 and every charge are read from it; no metering of the engine: the site carries any difference,
   * bounded by its fuse). The product owner sets it; its default is by engine (`WEB_ENGINE_DEFAULTS`).
   */
  pointsMicroPerSearch: number;
  /** Searches one reply may run (default 3). */
  perReply: number;
  /**
   * The site's money fuse (operator's cost insurance, not a user rule): what one search is estimated to cost the site, in
   * micro-USD (default by engine), held against the day at call time and replaced by what the engine says the call cost
   * when it says so (Exa's `costDollars`), and the most the site spends on searches a site day, in USD (default 20):
   * a search that would pass it is refused with an error.
   */
  costMicroUsdPerSearch: number;
  siteUsdPerDay: number;
  /** Engine calls at once in the service. */
  maxAtOnce: number;
  /** How long one engine call may take, in ms. */
  timeoutMs: number;
  /** The most results one search hands the model (the first ones). */
  maxResults: number;
}

/** The web search's adapters (src/agents/tools/web/engine.ts). */
export type WebEngineName = "exa_search" | "deepseek_messages";

/**
 * What `TOOLS.web` defaults to by engine, where the engine decides it:
 * - `baseUrl`: the vendor's API.
 * - `costMicroUsdPerSearch`, the site's estimate of one call: Exa's pricing page of 2026-11-22 — Auto search $7 a 1 000
 *   requests, contents $1 a 1 000 pages, highlights of the 6 results asked for — 7 000 + 6 × 1 000 = 13 000; DeepSeek's,
 *   the first version's $0.002.
 * - `pointsMicroPerSearch`, what the owner is charged: that estimate at the site's own conversion — the product owner's
 *   ruling for the site's prices, "一点等于上游标价的 0.001 美元" (docs/acceptance/batch2a/rulings.md §二.1: one point is
 *   $0.001 of the upstream's list price, so one micro-USD is 1 000 micro-points; the code itself has no such constant,
 *   site model prices being configured in micro-points a token) — 13 000 × 1 000 = 13 000 000 (13 points) for Exa; for
 *   DeepSeek the first version's 770 350 (the measured 11 000 input tokens and one output token at the acceptance's fast
 *   model's 70 and 350 micro-points a token: the same conversion through that model's price). Placeholders the owner sets.
 */
export const WEB_ENGINE_DEFAULTS: Readonly<Record<WebEngineName, { baseUrl: string; apiKeyEnv: string; costMicroUsdPerSearch: number; pointsMicroPerSearch: number }>> = {
  exa_search: { baseUrl: "https://api.exa.ai", apiKeyEnv: "WEB_SEARCH_API_KEY", costMicroUsdPerSearch: 13_000, pointsMicroPerSearch: 13_000_000 },
  deepseek_messages: { baseUrl: "https://api.deepseek.com", apiKeyEnv: "WEB_SEARCH_DEEPSEEK_API_KEY", costMicroUsdPerSearch: 2_000, pointsMicroPerSearch: 770_350 },
};

/** A key of `TOOLS.web` that is gone: refused at start, saying so and why (strict, as every setting: an operator who set a limit must not believe it still holds). */
const removedKey = (key: string, why: string) =>
  z
    .unknown()
    .optional()
    .refine((v) => v === undefined, `${key} was removed (lane websearch2): ${why}; remove it from TOOLS`);

const webSearchSchema = z
  .strictObject({
    enabled: z.boolean().default(false),
    engine: z.enum(["exa_search", "deepseek_messages"]).default("exa_search"),
    baseUrl: z
      .url()
      .refine((u) => u.startsWith("https://"), "must be an https address")
      .optional(),
    baseUrlProxy: z.boolean().default(false),
    apiKeyEnv: keyVariable.optional(),
    model: z.string().min(1).max(200).default("deepseek-flash"),
    exaType: z.enum(["auto", "lite", "fast"]).default("auto"),
    pointsMicroPerSearch: z.number().int().min(0).max(1_000_000_000_000).optional(),
    perReply: positive(3, 20),
    costMicroUsdPerSearch: z.number().int().min(1).max(1_000_000_000).optional(),
    siteUsdPerDay: z.number().min(0).max(1_000_000).default(20),
    maxAtOnce: positive(4, 100),
    timeoutMs: z.number().int().min(1000).max(120_000).default(15_000),
    maxResults: positive(6, 20),
    perOwnerPerDay: removedKey("perOwnerPerDay", "there is no cap per owner any more, the points are the bound"),
    sitePerDay: removedKey("sitePerDay", "the site's cap is the money fuse siteUsdPerDay now"),
  })
  .superRefine((w, ctx) => {
    // Another host than the engine's own only when the operator says it is a proxy for it.
    if (w.baseUrl !== undefined && !w.baseUrlProxy && new URL(w.baseUrl).hostname !== new URL(WEB_ENGINE_DEFAULTS[w.engine].baseUrl).hostname) {
      ctx.addIssue({ code: "custom", path: ["baseUrl"], message: `is not ${w.engine}'s own host (${new URL(WEB_ENGINE_DEFAULTS[w.engine].baseUrl).hostname}); set baseUrlProxy: true for a proxy` });
    }
    // The key's variable is the engine's own, fixed: no setting can name another variable (the database's address, a
    // service secret, another vendor's key) and have it sent as the key — to the engine, or to a proxy. What was written
    // is not repeated (a key pasted here by mistake would be printed).
    const fixed = WEB_ENGINE_DEFAULTS[w.engine].apiKeyEnv;
    if (w.apiKeyEnv !== undefined && w.apiKeyEnv !== fixed) {
      ctx.addIssue({ code: "custom", path: ["apiKeyEnv"], message: `is fixed for ${w.engine}: its key is read from ${fixed} only; remove apiKeyEnv from TOOLS (or set it to ${fixed})` });
    }
  })
  .transform((w): WebSearchConfig => {
    const by = WEB_ENGINE_DEFAULTS[w.engine];
    return {
      enabled: w.enabled,
      engine: w.engine,
      baseUrl: w.baseUrl ?? by.baseUrl,
      apiKeyEnv: w.apiKeyEnv ?? by.apiKeyEnv,
      model: w.model,
      exaType: w.exaType,
      pointsMicroPerSearch: w.pointsMicroPerSearch ?? by.pointsMicroPerSearch,
      perReply: w.perReply,
      costMicroUsdPerSearch: w.costMicroUsdPerSearch ?? by.costMicroUsdPerSearch,
      siteUsdPerDay: w.siteUsdPerDay,
      maxAtOnce: w.maxAtOnce,
      timeoutMs: w.timeoutMs,
      maxResults: w.maxResults,
    };
  });

const toolsSchema = z.strictObject({
  enabled: z.boolean().default(true),
  maxRounds: positive(8, 50),
  maxPoints: positive(20, 100_000),
  searchPerReply: positive(6, 1000),
  filePerReply: positive(4, 1000),
  timePerReply: positive(1, 1000),
  resultMaxWeight: positive(3000, 100_000),
  runTimeoutMs: z.number().int().min(1000).max(3_600_000).default(300_000),
  web: webSearchSchema.prefault({} as never),
});

/** `TOOLS` unset: every default. */
export const DEFAULT_TOOLS: Readonly<ToolsConfig> = Object.freeze(toolsSchema.parse({}));

/** What the open holds of one payer may add up to (`HOLDS`; README "Metering", Admission). */
export interface HoldsConfig {
  /**
   * An admission rule: a reply starts beside the owner's other running calls on its source (today's free allowance, or
   * the balance) only when all their holds, its own included, add up to at most this share of what is left of it; else it
   * waits, queued, unless it would be the only one holding against that source (src/metering/admit.ts). A reply's later
   * rounds are held against all that is left, whatever the share. From 0.01 (below, the share would round to nothing) to
   * 1: a share above 1 would let replies starting together hold more than there is, and the debt bound would not hold.
   */
  maxOpenShare: number;
}

const holdsSchema = z.strictObject({
  maxOpenShare: z.number().min(0.01).max(1).default(1),
});

/** When the owner is reminded that the day's free allowance runs low (`ALLOWANCE`; src/metering/reminders.ts). */
export interface AllowanceConfig {
  /** The share of the day's free allowance used at which its owner is told, once a day. Above 0, below 1. */
  warnAt: number;
}

const allowanceSchema = z.strictObject({
  warnAt: z.number().gt(0).lt(1).default(0.8),
});

/** How long whispers stay open (`WHISPERS`; README "Whispers"). Other kinds stay open 7 days (src/whispers/store.ts). */
export interface WhispersConfig {
  /**
   * A `found_elsewhere` whisper ("not here, but I have it elsewhere") expires this many hours after it was made (the
   * periodic sweep, src/whispers/store.ts `expireWhispers`): what it found is about a question asked then. 1 to 168.
   */
  elsewhereTtlHours: number;
}

const whispersSchema = z.strictObject({
  elsewhereTtlHours: positive(24, 168),
});

/** How a reply that failed for a passing reason is tried again by the system (`AGENTS`; README "Agents and runs", Automatic retry). */
export interface AgentsConfig {
  /**
   * The waits before each automatic retry of one original call, in ms (src/agents/runs.ts `scheduleAutoRetry`): at most two
   * (so at most three attempts), each from 0 to 600 000 (never later than ten minutes after the original call anyway).
   * Default `[20000, 120000]`; an empty list turns automatic retries off.
   */
  autoRetryDelaysMs: number[];
}

const agentsSchema = z.strictObject({
  autoRetryDelaysMs: z.array(z.number().int().min(0).max(600_000)).max(2).default([20_000, 120_000]),
});

/** `WHISPERS` unset: every default. */
export const DEFAULT_WHISPERS: Readonly<WhispersConfig> = Object.freeze(whispersSchema.parse({}));

/**
 * What an Agent's memory is tuned by (`MEMORY`); every number is a site setting with this default (the plan's Numbers;
 * tuned and recorded in the last tasks). Sizes are in weight (memory/weight.ts: ceil(utf-8 bytes / 3), about a token), times in milliseconds.
 */
export interface MemoryConfig {
  /** The id of the site model the background memory calls use; null: the cheapest free-tier site model (`memoryModel`). */
  model: string | null;
  /** The most the notes of a room hold: about the owner, the Agent's own, and what it heard. */
  roomOwner: number;
  roomSelf: number;
  roomHearsay: number;
  /** The longest an entry a model wrote is (an entry the owner wrote may fill its room). */
  modelEntryMax: number;
  /** A review runs after this much quiet in the Agent's own conversation, or after `maxReplies` replies since the last. */
  quietMs: number;
  maxReplies: number;
  /** A group review runs after this much quiet, at most `groupMaxWaitMs` after the first flagged message. */
  groupQuietMs: number;
  groupMaxWaitMs: number;
  /** A review shows at most this many messages, each cut to `reviewMessageWeight`, and may answer at most `reviewMaxOutputTokens`. */
  reviewMessages: number;
  reviewMessageWeight: number;
  reviewMaxOutputTokens: number;
  /** Thresholds of the judgements: out of the vault, the same note, hearsay worth flagging, the owner's own remark worth flagging. */
  shareAt: number;
  sameAt: number;
  hearsayAt: number;
  ownAt: number;
  /** At most this many flagged messages are reviewed together, each with `flaggedContext` messages of context. */
  flaggedMax: number;
  flaggedContext: number;
  /** At most this many hearsay calls (the owner's memory allowance) per Agent and group in a rolling hour. */
  hearsayPerHour: number;
  /**
   * 也回顾一下 in a group (memory/catchup.ts): what an Agent switched on with catchUp catches up of what members said while its memory was
   * off — at most the most recent `catchUpLines` lines of each group, none older than `catchUpDays` days.
   */
  catchUpLines: number;
  catchUpDays: number;
  /**
   * Before a hearsay call the judgement model is asked whether the batch holds something new (below `hearsayNewAt`: no
   * call) and whether it looks like flooding or probing (`hearsayAbuseAt` or more: no call, and the speaker is not
   * listened to for `hearsayMuteMs`).
   */
  hearsayNewAt: number;
  hearsayAbuseAt: number;
  hearsayMuteMs: number;
  /**
   * What a flooding judgement does: "on" mutes a speaker who sent at least 3 of the batch's flagged messages and more than
   * half of them (and drops the batch as abuse); "observe" (default) mutes nobody and drops nothing, and logs when it would
   * have (`memory_mute_would`); "off" does not ask the abuse question at all.
   */
  hearsayMute: "off" | "observe" | "on";
  /**
   * Listening for memory (a judgement with no Agent to pick, only listeners) is skipped once the day's judgements have
   * reached this share of the judge's daily limit, so that it never uses up what unasked replies need.
   */
  listenShare: number;
  /**
   * 入梦: the sweep that looks for owners to consolidate comes every `dreamSweepMs`. An owner dreams after they have sent no
   * message anywhere for `dreamIdleMs`, with something new since their last dream, and not twice within `dreamEveryMs`.
   * A room left at `napAt` of its limit by a change is consolidated at once (a nap), at most once per `dreamEveryMs`.
   * A dream's merge, rewrite or split of entries is applied when the judgement model is `faithfulAt` sure the result adds nothing the
   * entries did not say and loses nothing they did.
   */
  dreamSweepMs: number;
  dreamIdleMs: number;
  dreamEveryMs: number;
  napAt: number;
  faithfulAt: number;
  /**
   * The site's judgement model is asked at most this many times a site day on behalf of one owner's memory (sorting, the duplicate
   * test, the faithful check, the hearsay pre-check, whether the owner asked): past it that owner's memory checks are skipped as "no answer", so one heavy
   * owner can never use up what everyone else's checks need. All owners' memory together stops earlier still, at `judgeShare` of the
   * site's daily limit.
   */
  judgePerOwnerDay: number;
  /**
   * Memory's judgement requests are held to this share of the site's daily judge limit (`judge.dailyLimit`): once the site's judgements
   * of the day have reached it, every memory check is skipped as "no answer" (each caller's own no-answer behaviour), so that memory never
   * uses up what unasked replies need. Each owner's `judgePerOwnerDay` stays besides.
   */
  judgeShare: number;
  /**
   * In the owner's own conversation a review's `remove` is applied at once only when the judgement model is at least this sure that the
   * owner's words in the review's window asked to forget or delete something; otherwise, or with no answer, it waits for the owner's
   * yes. (A `lock` is applied at once without asking.) Above 0, at most 1.
   */
  explicitAt: number;
  /**
   * What a review does with a `merge` op (the notes it names are one thing; ids only, memory/ops.ts) in the owner's own conversation:
   * "on" (default) joins the notes' own texts as they are (memory/clean.ts `joinNotes`) — nobody is asked — and applies the joined note
   * at once as one change (with 先问我再记: as a card); "off" ignores the op. A replace and removes are never read as a merge.
   */
  mergeAuto: "off" | "on";
  /** A room holds at most this many notes besides its size limit: an addition beyond it is dropped as a full room. */
  roomNotes: number;
  /**
   * The notes passage takes at most this share of the model's context (by the token estimate the context budget uses); over it
   * entries are left out (hearsay first, then the Agent's own notes, then those about the owner, the weakest and oldest first), so the
   * notes never crowd out the conversation.
   */
  passageShare: number;
  /**
   * What the site pays for one owner's memory calls on a site model each site day, in whole points (0: none, memory then works only
   * for owners who chose a model of their own provider). Its own allowance: never the owner's free allowance or balance.
   */
  freeDailyPoints: number;
  /**
   * How often the record of memory changes is swept (memory/sweep.ts: what is over is deleted, and a pending change discarded, 30 days
   * on), in ms; its own timer, apart from the attachment sweep's `SWEEP_INTERVAL_MINUTES`. 0: no timer (`attachments:sweep` still runs it);
   * otherwise at least a minute. Whispers (whispers/store.ts) are expired and cleaned on this same timer: 0 stops that too.
   */
  changesSweepMs: number;
  /**
   * The rolling summary (agents/summary/; README "The rolling summary"): after a reply whose context left out anything, a job
   * folds into the pair's summary — at most `summaryMaxWeight` weight as a reply is shown it — what has left the window, once
   * that weighs at least `summaryMinFoldWeight` as a reply would show it (half of `summaryMaxWeight` unless set). After a
   * summary is written the pair is not asked again for `summaryMinIntervalMs` (0: at once), whatever is posted meanwhile.
   */
  summaryMaxWeight: number;
  summaryMinFoldWeight: number;
  summaryMinIntervalMs: number;
}

/** `reviewMessageChars` was this setting's name before sizes were measured in weight: still read, when the new name is absent. */
const renamedReviewWeight = (v: unknown): unknown => {
  if (typeof v !== "object" || v === null || Array.isArray(v) || !Object.hasOwn(v, "reviewMessageChars")) return v;
  const { reviewMessageChars, ...rest } = v as Record<string, unknown>;
  return Object.hasOwn(rest, "reviewMessageWeight") ? rest : { ...rest, reviewMessageWeight: reviewMessageChars };
};

const memorySchema = z.preprocess(renamedReviewWeight, z.strictObject({
  model: z.string().min(1).max(200).nullable().default(null),
  // At most 3000: the database guards a note at 9000 characters (migration 039), 3 characters to a weight of the shortest kind; and a model's entry at 200 (hearsay: 600 characters).
  roomOwner: positive(2000, 3000),
  roomSelf: positive(3000, 3000),
  roomHearsay: positive(2000, 3000),
  modelEntryMax: positive(200, 200),
  quietMs: positive(600_000, 86_400_000),
  maxReplies: positive(8, 1000),
  groupQuietMs: positive(120_000, 86_400_000),
  groupMaxWaitMs: positive(900_000, 86_400_000),
  reviewMessages: positive(40, 500),
  reviewMessageWeight: positive(500, 20_000),
  reviewMaxOutputTokens: positive(2000, 100_000),
  shareAt: probability(0.6),
  sameAt: probability(0.8),
  hearsayAt: probability(0.65),
  ownAt: probability(0.6),
  flaggedMax: positive(20, 500),
  flaggedContext: z.number().int().min(0).max(50).default(3),
  hearsayPerHour: positive(4, 1000),
  catchUpLines: positive(200, 10_000),
  catchUpDays: positive(30, 365),
  hearsayNewAt: probability(0.7),
  hearsayAbuseAt: probability(0.6),
  hearsayMuteMs: positive(21_600_000, 31_536_000_000),
  hearsayMute: z.enum(["off", "observe", "on"]).default("observe"),
  listenShare: probability(0.5),
  dreamSweepMs: positive(900_000, 86_400_000),
  dreamIdleMs: positive(10_800_000, 604_800_000),
  dreamEveryMs: positive(72_000_000, 2_592_000_000),
  napAt: probability(0.8),
  faithfulAt: probability(0.6),
  judgePerOwnerDay: positive(300, 1_000_000),
  judgeShare: probability(0.5),
  // Above 0: at 0 every answer would be a yes. 0.7 as calibrated on the real judgement model (memory/sort.ts `ownerAsked`).
  explicitAt: probability(0.7).refine((p) => p > 0),
  // A review's merge op joins the notes verbatim (the product owner's decision of 2026-11-21): no model text, no judge question.
  mergeAuto: z.enum(["off", "on"]).default("on"),
  roomNotes: positive(150, 100_000),
  passageShare: z.number().gt(0).max(1).default(0.25),
  freeDailyPoints: z.number().int().min(0).max(1_000_000).default(20),
  // 0 (no timer) or at least a minute: anything between would sweep back to back.
  changesSweepMs: z.number().int().min(0).max(86_400_000).refine((ms) => ms === 0 || ms >= 60_000).default(3_600_000),
  // The cap at most 2000 weight: the database guards a summary's items at 256 KiB (migration 059).
  summaryMaxWeight: positive(1000, 2000),
  // Unset: half of summaryMaxWeight (below).
  summaryMinFoldWeight: z.number().int().min(1).max(100_000).optional(),
  // Ten minutes: a pair is summarised at most six times an hour, however much is posted. 0: no wait; at most a day.
  summaryMinIntervalMs: z.number().int().min(0).max(86_400_000).default(600_000),
}).transform((m) => ({ ...m, summaryMinFoldWeight: m.summaryMinFoldWeight ?? Math.floor(m.summaryMaxWeight / 2) })));

const allowanceTokens = z.number().int().min(0).max(200_000);
/** `REASONING_ALLOWANCE_TOKENS`: an object of levels (`low`..`max`), each 0–200 000; a level left out keeps its default. */
const reasoningAllowanceSchema = z
  .strictObject({
    low: allowanceTokens.optional(),
    medium: allowanceTokens.optional(),
    high: allowanceTokens.optional(),
    xhigh: allowanceTokens.optional(),
    max: allowanceTokens.optional(),
  })
  .transform(
    (v): ReasoningAllowance => ({
      low: v.low ?? DEFAULT_REASONING_ALLOWANCE.low,
      medium: v.medium ?? DEFAULT_REASONING_ALLOWANCE.medium,
      high: v.high ?? DEFAULT_REASONING_ALLOWANCE.high,
      xhigh: v.xhigh ?? DEFAULT_REASONING_ALLOWANCE.xhigh,
      max: v.max ?? DEFAULT_REASONING_ALLOWANCE.max,
    }),
  );

/**
 * The variable `apiKeyEnv` that `what` (a site model, a judgement channel, at `host`) reads its upstream key from: it is
 * sent upstream as a key, so never one of the service's own secrets, and a web search engine's key only toward that
 * engine's own host (compared ignoring case, as Windows does for variable names); and it must be set. Start-up refuses
 * otherwise, naming `what` and the variable.
 */
function checkKeyVariable(what: string, apiKeyEnv: string, host: string, env: Record<string, string | undefined>): void {
  if ((SERVICE_SECRET_VARIABLES as readonly string[]).includes(apiKeyEnv.toUpperCase())) {
    throw new Error(`Invalid configuration: ${what} names ${apiKeyEnv} as its apiKeyEnv, one of the service's own variables; put its key in a variable of its own`);
  }
  // A web search engine's key goes to that engine's own host only (review M4): Exa is no model vendor, so its key never;
  // DeepSeek's may be shared by a model on api.deepseek.com (one account, one key).
  for (const [engine, by] of Object.entries(WEB_ENGINE_DEFAULTS)) {
    const own = new URL(by.baseUrl).hostname;
    if (apiKeyEnv.toUpperCase() === by.apiKeyEnv && host !== own) {
      throw new Error(
        `Invalid configuration: ${what} names ${apiKeyEnv}, the web search's ${engine} key; only a model on ${own} may share it — put this key in a variable of its own`,
      );
    }
  }
  const key = env[apiKeyEnv];
  if (key === undefined || key === "") throw new Error(`Invalid configuration: ${what} needs the environment variable ${apiKeyEnv} (its apiKeyEnv), which is not set`);
}

/** Parses a JSON-valued variable; on failure adds one issue (the variable's name comes from the schema key). */
function jsonVariable<T extends z.ZodType>(schema: T, fallback: z.output<T>) {
  return optionalString.transform((v, ctx): z.output<T> => {
    if (v === undefined) return fallback;
    let json: unknown;
    try {
      json = JSON.parse(v);
    } catch {
      ctx.addIssue({ code: "custom", message: "must be valid JSON" });
      return z.NEVER;
    }
    const result = schema.safeParse(json);
    if (!result.success) {
      ctx.addIssue({ code: "custom", message: result.error.issues.map((i) => `${i.path.join(".") || "value"}: ${i.message}`).join(", ") });
      return z.NEVER;
    }
    return result.data;
  });
}

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v === "" ? undefined : v));

/** A whole number from `min` to `max` written in decimal digits; unset or empty: `fallback`. */
const wholeNumber = (fallback: number, min: number, max: number) => {
  const message = `must be a whole number from ${min} to ${max}`;
  return optionalString
    .transform((v) => (v === undefined ? String(fallback) : v))
    .pipe(z.string().regex(/^[0-9]{1,10}$/, message))
    .transform(Number)
    .pipe(z.number().min(min, message).max(max, message));
};

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  APP_ORIGIN: z.url(),
  AUTH_SECRET: z.string().min(32, "AUTH_SECRET must be at least 32 characters"),
  /** Encrypts providers' API keys at rest. Required: the service does not start without it. */
  PROVIDER_KEY_SECRET: z.string().min(32, "PROVIDER_KEY_SECRET must be at least 32 characters"),
  /** JSON array of the models the site offers (see SiteModel); default none. */
  SITE_MODELS: jsonVariable(z.array(siteModelSchema), []),
  /** The free daily allowance of site-model use, in whole points. */
  FREE_DAILY_POINTS: optionalString
    .transform((v) => (v === undefined ? "200" : v))
    .pipe(z.string().regex(/^[0-9]{1,12}$/, "FREE_DAILY_POINTS must be a whole number of points (0 or more)"))
    .transform((v) => BigInt(v) * 1_000_000n),
  /** The time zone whose midnight starts a new free-allowance day. */
  SITE_TIMEZONE: optionalString
    .transform((v) => (v === undefined ? "Asia/Shanghai" : v))
    .refine((v) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: v });
        return true;
      } catch {
        return false;
      }
    }, "SITE_TIMEZONE must be an IANA time zone name such as Asia/Shanghai"),
  /** JSON object: how many Agents each account tier may own. Must contain `free`. */
  AGENT_TIERS: jsonVariable(
    z.record(z.string().min(1), z.number().int().min(0)).refine((t) => Object.hasOwn(t, "free"), "must contain a \"free\" tier"),
    { free: 20 } as Record<string, number>,
  ),
  /** Replies one owner may have running at once; further ones wait queued. */
  AGENT_MAX_CONCURRENT_RUNS: wholeNumber(4, 1, 100),
  /** Of those, how many may be ones someone else called for (every lane but `own`); the rest of the places are the owner's own. */
  AGENT_MAX_CONCURRENT_OTHERS_RUNS: wholeNumber(3, 1, 100),
  /** Replies one owner may start per minute that they called for themselves (counted from the stored runs; not scaled by RATE_LIMIT_SCALE). */
  AGENT_RUNS_PER_MINUTE: wholeNumber(20, 1, 10_000),
  /** Replies one owner's Agents may start per minute that someone else called for, all of them together (counted apart from the owner's own). */
  AGENT_OTHERS_RUNS_PER_MINUTE: wholeNumber(20, 1, 10_000),
  /** Replies one person, themselves or through their Agents, may call for per minute on other people's Agents. */
  AGENT_CALLER_RUNS_PER_MINUTE: wholeNumber(5, 1, 10_000),
  /** A reply still running after this long is ended (and so is the reading of its attachments). */
  AGENT_RUN_TIMEOUT_MS: wholeNumber(120_000, 1_000, 3_600_000),
  /** A provider model's context window when its owner does not give one, in tokens. */
  PROVIDER_DEFAULT_CONTEXT_TOKENS: wholeNumber(16_000, 1_000, 2_000_000),
  /** The output limit every call to a provider model gets, in tokens. */
  PROVIDER_DEFAULT_MAX_OUTPUT_TOKENS: wholeNumber(2048, 1, 1_000_000),
  /** JSON object: the thinking allowance of each level, added to a call's output limit at that level. */
  REASONING_ALLOWANCE_TOKENS: jsonVariable(reasoningAllowanceSchema, DEFAULT_REASONING_ALLOWANCE),
  /** Calls to providers and site models in flight at once in the whole service (src/providers/guard.ts). */
  PROVIDER_MAX_CONCURRENT_CALLS: wholeNumber(64, 1, 1000),
  /** Replies the worker runs at once in the whole service (each holds its attachments in memory and an outbound call). */
  AGENT_MAX_RUNS_IN_FLIGHT: wholeNumber(16, 1, 64),
  /** After this many messages in a row from Agents in a group (notices aside), an Agent's message calls no other Agent. */
  AGENT_CHAIN_LIMIT: wholeNumber(30, 2, 500),
  /** Tokens of a group's history one reply there may show its model at most (the system text comes on top). */
  AGENT_GROUP_CONTEXT_TOKENS: wholeNumber(12_000, 2_000, 200_000),
  /** JSON object configuring the judgement model (see JudgeConfig); unset or empty: none, and no Agent replies unprompted. */
  JUDGE: jsonVariable(judgeSchema.nullable(), null),
  /** JSON object of the proactive-reply tunings (see ProactiveConfig); every field optional, unset or empty: all defaults. */
  PROACTIVE: jsonVariable(proactiveSchema, proactiveSchema.parse({})),
  /** JSON object of an Agent's memory tunings (see MemoryConfig); every field optional, unset or empty: all defaults. */
  MEMORY: jsonVariable(memorySchema, memorySchema.parse({})),
  /** JSON object of what bounds a reply's tools (see ToolsConfig); every field optional, unset or empty: all defaults. */
  TOOLS: jsonVariable(toolsSchema, toolsSchema.parse({})),
  /** JSON object of what one owner's open holds may add up to (see HoldsConfig); unset or empty: the default. */
  HOLDS: jsonVariable(holdsSchema, holdsSchema.parse({})),
  /** JSON object of when an owner is reminded of the day's free allowance (see AllowanceConfig); unset or empty: the default. */
  ALLOWANCE: jsonVariable(allowanceSchema, allowanceSchema.parse({})),
  /** JSON object of how long whispers stay open (see WhispersConfig); unset or empty: the default. */
  WHISPERS: jsonVariable(whispersSchema, whispersSchema.parse({})),
  /** JSON object of how failed replies are tried again by the system (see AgentsConfig); unset or empty: the default. */
  AGENTS: jsonVariable(agentsSchema, agentsSchema.parse({})),
  BLOB_DIR: z.string().min(1).default("./data/blobs"),
  /** Directory with the built web client (index.html and /assets); unset: the service serves no web files. */
  WEB_DIST: optionalString,
  /** Unset or empty: 3000 (an empty value is not port 0). */
  PORT: optionalString
    .transform((v) => v ?? "3000")
    .pipe(z.string().regex(/^[0-9]{1,5}$/, "must be a port number").transform(Number).pipe(z.number().int().min(0).max(65535))),
  /** The address the server binds: an IPv4/IPv6 address or `localhost`. Default `0.0.0.0` (every interface). */
  HOST: optionalString
    .transform((v) => (v === undefined ? "0.0.0.0" : v))
    .pipe(z.string().refine((v) => isIP(v) !== 0 || v === "localhost", "HOST must be an IP address or localhost")),
  S3_ENDPOINT: optionalString,
  S3_REGION: optionalString,
  S3_BUCKET: optionalString,
  S3_ACCESS_KEY_ID: optionalString,
  S3_SECRET_ACCESS_KEY: optionalString,
  REGISTRATION_MODE: z.enum(["invite", "open"]).default("invite"),
  /** `outbox`: mail is only written to `mail_outbox`. `resend`: it is also delivered through Resend's HTTP API (needs the three below). */
  MAIL_MODE: z.enum(["outbox", "resend"]).default("outbox"),
  /** A secret (one of `SERVICE_SECRET_VARIABLES`): never logged, never in a payload or an error. Needed by `resend`. */
  RESEND_API_KEY: optionalString,
  /** The sender of every mail, e.g. `Name <address@your-domain>`. Needed by `resend`; no address is built in. */
  MAIL_FROM: optionalString,
  /** Where a reply to a mail goes; unset: none is asked for. */
  MAIL_REPLY_TO: optionalString,
  /** Mails of one kind one address may be sent in an hour (the rest are written but never delivered); every request counts alike. */
  MAIL_PER_ADDRESS_HOUR: wholeNumber(5, 1, 1000),
  /** A header your proxy sets to the client's address, replacing any client value (Railway: `x-real-ip`). */
  CLIENT_IP_HEADER: optionalString.pipe(
    z
      .string()
      .regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/, "CLIENT_IP_HEADER must be a header name")
      .transform((v) => v.toLowerCase())
      .optional(),
  ),
  /** The proxies whose X-Forwarded-For is read: their addresses / CIDR ranges. Default: none. */
  TRUST_PROXY: optionalString.transform((v, ctx) => {
    const parsed = parseTrustProxy(v);
    if (typeof parsed === "string") {
      ctx.addIssue({ code: "custom", message: parsed });
      return z.NEVER;
    }
    return parsed;
  }),
  /** Multiplier applied to every rate limit; tests raise it. */
  RATE_LIMIT_SCALE: z.coerce.number().positive().default(1),
  /** Largest file one upload may carry, in bytes (1 MiB to 5 GiB; never more than the quota: checked below). */
  ATTACHMENT_MAX_BYTES: wholeNumber(1024 ** 3, 1024 ** 2, 5 * 1024 ** 3),
  /** Total attachment bytes one principal may store (sent or not). */
  ATTACHMENT_QUOTA_BYTES: z.coerce.number().int().positive().default(20 * 1024 ** 3),
  /** An upload whose client sends no body bytes for this long is cut off. */
  UPLOAD_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(45_000),
  /** An upload still receiving its body after this long is cut off. */
  UPLOAD_TOTAL_TIMEOUT_MS: z.coerce.number().int().positive().default(60 * 60_000),
  /** Server-wide: a connection with no traffic for this long is closed (WebSockets are exempt). */
  HTTP_CONNECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  /** Server-wide backstop for receiving a whole request; default: the upload deadline plus a minute. */
  HTTP_REQUEST_TIMEOUT_MS: optionalString.transform((v) => (v === undefined ? undefined : Number(v))).pipe(
    z.number().int().positive().optional(),
  ),
  /** Server-wide: an idle kept-alive connection is closed after this long. */
  HTTP_KEEP_ALIVE_TIMEOUT_MS: z.coerce.number().int().positive().default(72_000),
  /** A request must have arrived whole this long after its head, else its connection is closed (uploads let in excepted). */
  HTTP_BODY_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  /** Postgres cancels any statement on the app's pool that runs longer than this (503 busy). */
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  /** A request that gets no pool connection within this long is answered 503 busy. */
  DB_ACQUIRE_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  /** How often the server sweeps unsent uploads and abandoned blobs, in minutes; 0 turns it off; at most 1440 (a longer delay overflows Node's timers). */
  SWEEP_INTERVAL_MINUTES: optionalString
    .transform((v) => (v === undefined ? "15" : v))
    .pipe(z.string().regex(/^[0-9]{1,4}$/, "SWEEP_INTERVAL_MINUTES must be a whole number of minutes from 0 to 1440"))
    .transform(Number)
    .pipe(z.number().max(1440, "SWEEP_INTERVAL_MINUTES must be at most 1440 (one day)")),
  /** A search's statements are cancelled after this long (503 busy). */
  SEARCH_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(3_000),
});

export interface Config {
  databaseUrl: string;
  appOrigin: string;
  authSecret: string;
  /** Encrypts providers' API keys at rest (src/providers/crypto.ts only). */
  providerKeySecret: string;
  /** The models the site offers. Their upstream keys are read from the variables named by `apiKeyEnv`. */
  siteModels: SiteModel[];
  /** Free daily allowance of site-model use, in micro-points. */
  freeDailyMicro: bigint;
  /** IANA name of the time zone whose midnight ends a free-allowance day. */
  siteTimezone: string;
  /** Agents an account may own, by tier; always has `free`. */
  agentTiers: Record<string, number>;
  /** Replies one owner may have running at once; further ones wait queued. */
  agentMaxConcurrentRuns: number;
  /** Of those, how many may be replies anyone else called for (every lane but `own`; src/agents/port-impl.ts `claimNext`). */
  agentMaxConcurrentOthersRuns: number;
  /** Replies one owner may start per minute in their own lane: those they called for themselves (src/agents/runs.ts `Lane`). */
  agentRunsPerMinute: number;
  /** Replies one owner's Agents may start per minute that anyone else called for (every lane but `own`), counted together. */
  agentOthersRunsPerMinute: number;
  /**
   * Replies one person may call for per minute on other people's Agents, themselves or through an Agent's message they are
   * behind (src/agents/runs.ts `behindAgentMessage`).
   */
  agentCallerRunsPerMinute: number;
  /** A reply still running after this long is ended; also the most the reading of its attachments may take. */
  agentRunTimeoutMs: number;
  /** For a provider model that does not say: its context window and its maximum output, in tokens. */
  providerDefaultContextTokens: number;
  providerDefaultMaxOutputTokens: number;
  /**
   * Tokens of thinking a call at each level but `none` may use on top of its reply's output limit; what the call is
   * sent and held for (src/models/resolve.ts `outputLimit`).
   */
  reasoningAllowanceTokens: ReasoningAllowance;
  /** Calls through the address guard (to providers and site models) in flight at once in the whole service. */
  providerMaxConcurrentCalls: number;
  /** Replies the worker runs at once in the whole service (src/agents/runtime/worker.ts). */
  agentMaxRunsInFlight: number;
  /**
   * When the group's last this many messages that are not notices were all sent by Agents, an Agent's message calls no
   * other Agent until a person writes (src/agents/runs.ts `triggerFromAgent`).
   */
  agentChainLimit: number;
  /**
   * The most a reply in a group may show its model of the group's history, in tokens by the service's estimate, when
   * the model's context would hold more (src/agents/context.ts `loadContext`); the system text is not counted in it.
   */
  agentGroupContextTokens: number;
  /** The judgement model that decides whether an Agent replies unprompted; null: not configured, nobody does. */
  judge: JudgeConfig | null;
  /** The proactive replies' tunings. */
  proactive: ProactiveConfig;
  /** The memory tunings. */
  memory: MemoryConfig;
  /** What bounds a reply's tools. */
  tools: ToolsConfig;
  /** What one owner's open holds against a source may add up to. */
  holds: HoldsConfig;
  /** When an owner is reminded of the day's free allowance. */
  allowance: AllowanceConfig;
  /** How long whispers stay open. */
  whispers: WhispersConfig;
  /** How a reply that failed for a passing reason is tried again by the system. */
  agents: AgentsConfig;
  blobDir: string;
  /** Absolute path of the built web client to serve, or undefined to serve none. */
  webDist: string | undefined;
  port: number;
  /** The address `server.ts` listens on. */
  host: string;
  s3?: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
  };
  registrationMode: "invite" | "open";
  mailMode: "outbox" | "resend";
  /** What `resend` sends with; undefined in `outbox` mode. The key is a secret: never print this object. */
  mail: { apiKey: string; from: string; replyTo?: string } | undefined;
  /** `MAIL_PER_ADDRESS_HOUR`: mails of one kind to one address delivered in an hour. */
  mailPerAddressHour: number;
  rateLimitScale: number;
  /** Lower-case header name holding the client's address (src/limits.ts `clientIp`); unset: not consulted. */
  clientIpHeader: string | undefined;
  /** Fastify's `trustProxy`: which X-Forwarded-For hops `req.ip` may look through. */
  trustProxy: TrustProxy;
  /** Largest file one upload may carry (inclusive). */
  attachmentMaxBytes: number;
  attachmentQuotaBytes: number;
  /** Per-upload deadlines: no body bytes for `uploadIdleTimeoutMs`, or still receiving after `uploadTotalTimeoutMs`. */
  uploadIdleTimeoutMs: number;
  uploadTotalTimeoutMs: number;
  /** Fastify's `connectionTimeout` (socket idle), `requestTimeout` and `keepAliveTimeout`. */
  httpConnectionTimeoutMs: number;
  httpRequestTimeoutMs: number;
  httpKeepAliveTimeoutMs: number;
  /** How long a request may take to arrive whole, counted from its head, unless it is an upload let in (src/body-deadline.ts). */
  httpBodyTimeoutMs: number;
  /** `statement_timeout` of every pool connection (migrations use their own connection). */
  dbStatementTimeoutMs: number;
  /** How long a pool user waits for a connection (pg's `connectionTimeoutMillis`). */
  dbAcquireTimeoutMs: number;
  /** `statement_timeout` inside a search's transaction. */
  searchStatementTimeoutMs: number;
  /** Minutes between the in-process attachment sweeps; 0: none (run `attachments:sweep` by hand). */
  sweepIntervalMinutes: number;
}

/** How long before the server closes an idle connection a persona draft must have answered on it. */
export const DRAFT_SOCKET_MARGIN_MS = 10_000;
/** The least a persona draft is given; a connection timeout that leaves less fails start-up. */
export const MIN_DRAFT_DEADLINE_MS = 10_000;

/**
 * How long a persona draft's model call may take (`POST /api/agents/draft-persona`): `agentRunTimeoutMs`, but always
 * `DRAFT_SOCKET_MARGIN_MS` below the server's connection idle timeout — the request waits for the model with nothing
 * on the wire, and the server would close its connection before it could answer.
 */
export function draftDeadlineMs(config: Pick<Config, "agentRunTimeoutMs" | "httpConnectionTimeoutMs">): number {
  return Math.min(config.agentRunTimeoutMs, config.httpConnectionTimeoutMs - DRAFT_SOCKET_MARGIN_MS);
}

/** The delivery settings of `resend` mode (start-up fails naming the variable that is missing or unusable); none in `outbox` mode. */
function mailSettings(e: { MAIL_MODE: string; RESEND_API_KEY?: string | undefined; MAIL_FROM?: string | undefined; MAIL_REPLY_TO?: string | undefined }): Config["mail"] {
  if (e.MAIL_MODE !== "resend") return undefined;
  if (e.RESEND_API_KEY === undefined) throw new Error("Invalid configuration: MAIL_MODE is resend, so RESEND_API_KEY must be set");
  if (e.MAIL_FROM === undefined) throw new Error("Invalid configuration: MAIL_MODE is resend, so MAIL_FROM must be set (for example Name <address@your-domain>)");
  // Both go into the provider's JSON, never a raw header, but a line break in an address is never meant.
  for (const [name, value] of [["MAIL_FROM", e.MAIL_FROM], ["MAIL_REPLY_TO", e.MAIL_REPLY_TO]] as const) {
    if (value !== undefined && /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`Invalid configuration: ${name} must be one line`);
  }
  return { apiKey: e.RESEND_API_KEY, from: e.MAIL_FROM, ...(e.MAIL_REPLY_TO === undefined ? {} : { replyTo: e.MAIL_REPLY_TO }) };
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const e = parsed.data;
  const s3Fields = [e.S3_ENDPOINT, e.S3_REGION, e.S3_BUCKET, e.S3_ACCESS_KEY_ID, e.S3_SECRET_ACCESS_KEY];
  const anyS3 = s3Fields.some((v) => v !== undefined);
  if (anyS3 && s3Fields.some((v) => v === undefined)) {
    throw new Error(
      "Invalid configuration: S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set together",
    );
  }
  if (e.AGENT_MAX_CONCURRENT_OTHERS_RUNS > e.AGENT_MAX_CONCURRENT_RUNS) {
    throw new Error(
      `Invalid configuration: AGENT_MAX_CONCURRENT_OTHERS_RUNS (${e.AGENT_MAX_CONCURRENT_OTHERS_RUNS}) is more than AGENT_MAX_CONCURRENT_RUNS (${e.AGENT_MAX_CONCURRENT_RUNS})`,
    );
  }
  for (const m of e.SITE_MODELS) {
    // A provider's base URL rule (src/providers/guard.ts): https, no credentials, a plain host name or address; and
    // nothing after the path, which a provider's would silently lose. Stored as a provider's is (lower-case host, no
    // default port, no trailing slash). Whether its address may be called is decided at every call, as for providers.
    const normalised = /[?#]/.test(m.baseUrl) ? null : normaliseBaseUrl(m.baseUrl, false);
    if (normalised === null) {
      throw new Error(
        `Invalid configuration: SITE_MODELS: model "${m.id}" has a baseUrl that is not an https URL a provider could have (no credentials, query or fragment)`,
      );
    }
    m.baseUrl = normalised;
    if (m.contextTokens <= m.maxOutputTokens) {
      throw new Error(
        `Invalid configuration: SITE_MODELS: model "${m.id}" has contextTokens ${m.contextTokens}, not more than its maxOutputTokens ${m.maxOutputTokens}: nothing would be left for the conversation`,
      );
    }
  }
  for (const m of e.SITE_MODELS) checkKeyVariable(`SITE_MODELS: model "${m.id}"`, m.apiKeyEnv, new URL(m.baseUrl).hostname, env);
  for (const channel of e.JUDGE?.channels ?? []) {
    // A site model's address rule. The URL is the endpoint itself, not a base URL: kept exactly as given, its path too.
    if (/[?#]/.test(channel.url) || normaliseBaseUrl(channel.url, false) === null) {
      throw new Error("Invalid configuration: JUDGE: a channel has a url that is not an https URL (no credentials, query or fragment)");
    }
    checkKeyVariable("JUDGE: a channel", channel.apiKeyEnv, new URL(channel.url).hostname, env);
  }
  const duplicate = e.SITE_MODELS.find((m, i) => e.SITE_MODELS.findIndex((o) => o.id === m.id) !== i);
  if (duplicate) throw new Error(`Invalid configuration: SITE_MODELS: id "${duplicate.id}" appears more than once`);
  if (e.PROVIDER_DEFAULT_CONTEXT_TOKENS <= e.PROVIDER_DEFAULT_MAX_OUTPUT_TOKENS) {
    throw new Error(
      `Invalid configuration: PROVIDER_DEFAULT_CONTEXT_TOKENS (${e.PROVIDER_DEFAULT_CONTEXT_TOKENS}) must be more than PROVIDER_DEFAULT_MAX_OUTPUT_TOKENS (${e.PROVIDER_DEFAULT_MAX_OUTPUT_TOKENS}): nothing would be left for the conversation`,
    );
  }
  if (e.ATTACHMENT_MAX_BYTES > e.ATTACHMENT_QUOTA_BYTES) {
    throw new Error(
      `Invalid configuration: ATTACHMENT_MAX_BYTES (${e.ATTACHMENT_MAX_BYTES}) must not exceed ATTACHMENT_QUOTA_BYTES (${e.ATTACHMENT_QUOTA_BYTES}): no file could be stored`,
    );
  }
  // The per-upload deadlines govern uploads: the server-wide timeouts must never cut one off first.
  const httpRequestTimeoutMs = e.HTTP_REQUEST_TIMEOUT_MS ?? e.UPLOAD_TOTAL_TIMEOUT_MS + 60_000;
  if (e.HTTP_CONNECTION_TIMEOUT_MS <= e.UPLOAD_IDLE_TIMEOUT_MS) {
    throw new Error("Invalid configuration: HTTP_CONNECTION_TIMEOUT_MS must be greater than UPLOAD_IDLE_TIMEOUT_MS");
  }
  if (httpRequestTimeoutMs <= e.UPLOAD_TOTAL_TIMEOUT_MS) {
    throw new Error("Invalid configuration: HTTP_REQUEST_TIMEOUT_MS must be greater than UPLOAD_TOTAL_TIMEOUT_MS");
  }
  // A persona draft answers its request only when the model has: it must do so before the idle connection is closed.
  if (e.HTTP_CONNECTION_TIMEOUT_MS - DRAFT_SOCKET_MARGIN_MS < MIN_DRAFT_DEADLINE_MS) {
    throw new Error(
      `Invalid configuration: HTTP_CONNECTION_TIMEOUT_MS (${e.HTTP_CONNECTION_TIMEOUT_MS}) must be at least ${DRAFT_SOCKET_MARGIN_MS + MIN_DRAFT_DEADLINE_MS}: a persona draft must answer ${DRAFT_SOCKET_MARGIN_MS / 1000} s before the connection's idle timeout, which would leave it less than ${MIN_DRAFT_DEADLINE_MS / 1000} s`,
    );
  }
  return {
    databaseUrl: e.DATABASE_URL,
    appOrigin: e.APP_ORIGIN,
    authSecret: e.AUTH_SECRET,
    providerKeySecret: e.PROVIDER_KEY_SECRET,
    siteModels: e.SITE_MODELS,
    freeDailyMicro: e.FREE_DAILY_POINTS,
    siteTimezone: e.SITE_TIMEZONE,
    agentTiers: e.AGENT_TIERS,
    agentMaxConcurrentRuns: e.AGENT_MAX_CONCURRENT_RUNS,
    agentMaxConcurrentOthersRuns: e.AGENT_MAX_CONCURRENT_OTHERS_RUNS,
    agentRunsPerMinute: e.AGENT_RUNS_PER_MINUTE,
    agentOthersRunsPerMinute: e.AGENT_OTHERS_RUNS_PER_MINUTE,
    agentCallerRunsPerMinute: e.AGENT_CALLER_RUNS_PER_MINUTE,
    agentRunTimeoutMs: e.AGENT_RUN_TIMEOUT_MS,
    providerDefaultContextTokens: e.PROVIDER_DEFAULT_CONTEXT_TOKENS,
    providerDefaultMaxOutputTokens: e.PROVIDER_DEFAULT_MAX_OUTPUT_TOKENS,
    reasoningAllowanceTokens: e.REASONING_ALLOWANCE_TOKENS,
    providerMaxConcurrentCalls: e.PROVIDER_MAX_CONCURRENT_CALLS,
    agentMaxRunsInFlight: e.AGENT_MAX_RUNS_IN_FLIGHT,
    agentChainLimit: e.AGENT_CHAIN_LIMIT,
    agentGroupContextTokens: e.AGENT_GROUP_CONTEXT_TOKENS,
    judge: e.JUDGE,
    proactive: e.PROACTIVE,
    memory: e.MEMORY,
    tools: e.TOOLS,
    holds: e.HOLDS,
    allowance: e.ALLOWANCE,
    whispers: e.WHISPERS,
    agents: e.AGENTS,
    blobDir: e.BLOB_DIR,
    webDist: e.WEB_DIST === undefined ? undefined : path.resolve(e.WEB_DIST),
    port: e.PORT,
    host: e.HOST,
    ...(anyS3
      ? {
          s3: {
            endpoint: e.S3_ENDPOINT!,
            region: e.S3_REGION!,
            bucket: e.S3_BUCKET!,
            accessKeyId: e.S3_ACCESS_KEY_ID!,
            secretAccessKey: e.S3_SECRET_ACCESS_KEY!,
          },
        }
      : {}),
    registrationMode: e.REGISTRATION_MODE,
    mailMode: e.MAIL_MODE,
    mail: mailSettings(e),
    mailPerAddressHour: e.MAIL_PER_ADDRESS_HOUR,
    rateLimitScale: e.RATE_LIMIT_SCALE,
    clientIpHeader: e.CLIENT_IP_HEADER,
    trustProxy: e.TRUST_PROXY,
    attachmentMaxBytes: e.ATTACHMENT_MAX_BYTES,
    attachmentQuotaBytes: e.ATTACHMENT_QUOTA_BYTES,
    uploadIdleTimeoutMs: e.UPLOAD_IDLE_TIMEOUT_MS,
    uploadTotalTimeoutMs: e.UPLOAD_TOTAL_TIMEOUT_MS,
    httpConnectionTimeoutMs: e.HTTP_CONNECTION_TIMEOUT_MS,
    httpRequestTimeoutMs,
    httpKeepAliveTimeoutMs: e.HTTP_KEEP_ALIVE_TIMEOUT_MS,
    httpBodyTimeoutMs: e.HTTP_BODY_TIMEOUT_MS,
    dbStatementTimeoutMs: e.DB_STATEMENT_TIMEOUT_MS,
    dbAcquireTimeoutMs: e.DB_ACQUIRE_TIMEOUT_MS,
    searchStatementTimeoutMs: e.SEARCH_STATEMENT_TIMEOUT_MS,
    sweepIntervalMinutes: e.SWEEP_INTERVAL_MINUTES,
  };
}
