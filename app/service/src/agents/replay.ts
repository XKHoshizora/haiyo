import { createHash } from "node:crypto";
import { webCitesOf, webSourcesOf } from "../messages/lookups.ts";
import { cutToWeight, weight } from "../metering/tokens.ts";
import type { ReplayCall, ReplayResult } from "../models/gateway.ts";
import type { ReplayRound } from "./runtime/context.ts";
import { UNUSABLE } from "./runtime/loop.ts";
import type { ToolTrace } from "./runtime/port.ts";
import { cleanText } from "./runtime/prompt.ts";
import { CURRENT_TIME } from "./tools/clock.ts";
import { takeCites, type RunRefs } from "./tools/refs.ts";
import { BAD_DATE, QUERY_TOO_LONG, QUERY_TOO_SHORT, SEARCH_BUSY, SEARCH_MESSAGES, SEARCH_TIMEOUT } from "./tools/search-words.ts";
import {
  SEARCH_WEB,
  WEB_BUSY,
  WEB_LANE_BUDGET,
  WEB_NO_MONEY,
  WEB_NO_RESULTS,
  WEB_QUERY_LENGTH,
  WEB_QUERY_PRIVATE,
  WEB_REFUSED,
  WEB_REPLY_CAP,
  WEB_SITE_DAY,
  WEB_TIMEOUT,
  WEB_UNAVAILABLE,
} from "./tools/web/words.ts";

/**
 * An Agent's earlier tool use returned in its own conversation's history (docs/design/2026-11-24-agent-harness-design.md
 * §3, step 1; README "Agents and runs", Earlier tool use in history). A reply that ended as an answer after tool rounds
 * keeps, beside its text and in its own conversation only, the calls of exactly the rounds that answer was written with
 * (`storedToolCalls`, body key `toolCalls`: what each was, never what it found). A later reply of that conversation offered
 * those tools is shown it in the provider's own form (`replayOf`): each call as the call it was, its result a placeholder
 * built from stored facts only — the query, the date, the sites (hosts, never titles) — or, for a call that was refused, no
 * query at all and the tool's own sentence, scoped to that reply. One reader: the context of the same Agent's later
 * replies there (agents/context.ts `loadPage`); never the wire, search, a summary, a review, a group or a log. Pure, and
 * every module it imports is a leaf of the agents' code (the tools' names and sentences live in modules of their own): no
 * import cycle can leave a value here unset.
 */

/** The tools whose calls return (step 1): a reply that called any other returns as its text alone. */
export const REPLAY_TOOLS: readonly string[] = [SEARCH_WEB, SEARCH_MESSAGES, CURRENT_TIME];

/** A stored call's input, as JSON text, weighs at most this (metering/tokens.ts `weight`, escaping counted). */
export const INPUT_MAX_WEIGHT = 60;
/** Of a messages search's input, its `from` weighs at most this before the query is cut to what is left. */
const FROM_MAX_WEIGHT = 20;
/** A placeholder result, as JSON text, weighs at most this, by construction (checked by tests/replay.test.ts). */
export const RESULT_MAX_WEIGHT = 72;
/** The most sites a web search's placeholder names, and the longest a site is (whole labels from the right). */
export const SITES_MAX = 3;
export const SITE_MAX_CHARS = 30;
/**
 * The most calls a stored body may hold, whatever the caps: a sanity bound of what is read back. What one reply keeps is
 * bounded by its tools' per-reply caps (`storedToolCalls` `maxCalls`): 10 at the default caps.
 */
const CALLS_MAX = 24;
/** The most rounds, and the most pages and messages a stored call may name (sanity bounds of a stored body). */
const ROUNDS_MAX = 32;
const PAGES_MAX = 20;
const FOUND_MAX = 1000;

/**
 * The placeholders' fixed sentences: tool results, never the Agent's words, and nothing addressed to the owner. A search's
 * says that its results are not here — not that they held nothing — and what follows from that: a detail the answer did
 * not give needs a new search (measured live, fix round 1: the first wording was read as "that search did not have it",
 * and a fresh search was not made). A refused call's says that the refusal was that reply's alone: its own sentence speaks
 * of `这次回复`, which a later reply took for itself. Short enough that each result stays within `RESULT_MAX_WEIGHT`.
 */
export const WEB_NOTE = "那次的结果已不在这里，那次回答以外的细节要重新搜索";
export const MESSAGES_NOTE = "那次的结果已不在这里，那次回答以外的细节要重新查找";
export const TIME_NOTE = "当时给过你那时的时间。";
export const REFUSAL_NOTE = "只限那次回复";

/** What a reply keeps of one call (`toolCalls`): a call that ran, with its input and what it handed out; or one refused, with no input. */
export type StoredToolCall =
  | { name: string; round: number; outcome: "ok"; input: Record<string, string>; found?: number; pages?: number[] }
  | { name: string; round: number; outcome: "refused"; error: string };

/**
 * The sentences a refused call keeps (its `error`): the tools' own refusals — the web search's (web/words.ts) and the
 * messages search's — and `UNUSABLE`. A call the loop answered (`REPEATED`, `OVER_CAP`: notes about that reply's own
 * rounds, one of them an imperative), or found garbled, or that failed, is kept as `UNUSABLE`, neutral; so is any other
 * sentence. None can be query text.
 */
export const REFUSAL_SENTENCES: ReadonlySet<string> = new Set([
  WEB_QUERY_LENGTH,
  WEB_QUERY_PRIVATE,
  WEB_BUSY,
  WEB_SITE_DAY,
  WEB_NO_MONEY,
  WEB_REPLY_CAP,
  WEB_LANE_BUDGET,
  WEB_UNAVAILABLE,
  WEB_TIMEOUT,
  WEB_REFUSED,
  WEB_NO_RESULTS,
  SEARCH_TIMEOUT,
  SEARCH_BUSY,
  QUERY_TOO_SHORT,
  QUERY_TOO_LONG,
  BAD_DATE,
  UNUSABLE,
]);

/** The input keys each tool's stored input keeps, in order (string values only). */
const INPUT_KEYS: Readonly<Record<string, readonly string[]>> = { [SEARCH_WEB]: ["query"], [SEARCH_MESSAGES]: ["query", "from", "before", "after"], [CURRENT_TIME]: [] };
const inputKeys = (name: string): readonly string[] => (Object.hasOwn(INPUT_KEYS, name) ? INPUT_KEYS[name]! : []);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (n: unknown, max: number): n is number => Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= max;

/**
 * A call's input as it is kept: each string the tool takes cleaned as the tool cleans it (`cleanText`) and, for a reply
 * offered tools (`refs`), without its token-shaped strings (as stored search words are, refs.ts `takeCites`); then held to
 * `INPUT_MAX_WEIGHT` as JSON text — a messages search's `from` first to `FROM_MAX_WEIGHT`, then the query to what is left.
 */
function keptInput(name: string, input: unknown, refs: RunRefs | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of inputKeys(name)) {
    const value = isRecord(input) ? input[key] : undefined;
    if (typeof value !== "string") continue;
    const clean = cleanText(value);
    out[key] = refs ? takeCites(clean, refs, { cite: false }).text : clean;
  }
  if (weight(JSON.stringify(out)) <= INPUT_MAX_WEIGHT) return out;
  if (typeof out.from === "string") out.from = cutToWeight(out.from, FROM_MAX_WEIGHT).trimEnd();
  if (typeof out.query === "string") {
    const query = out.query;
    let fit = query;
    // Whole characters off the end until the JSON text (its escapes counted) fits.
    while (fit !== "" && weight(JSON.stringify({ ...out, query: fit })) > INPUT_MAX_WEIGHT) fit = cutToWeight(fit, Math.max(0, weight(fit) - 1));
    out.query = fit.trimEnd();
  }
  return out;
}

/**
 * What a reply keeps of the calls of its answering rounds (`toolCalls`; agents/conversation.ts `postAsAgent`, own
 * conversation only): null — nothing kept, the reply returns as its text — when there were none, any was to a tool that
 * does not return (`REPLAY_TOOLS`: a file read, a name the model made up), or there were more than `maxCalls`, the
 * step-1 tools' per-reply caps summed (`maxCallsOf`). That last keeps one reply's replay within the design's bound
 * (≤ 1 600 weight at the default caps) by construction: the calls the loop refuses past the caps count against no cap, so a
 * model that loops past them would be replayed at about three times that. All or nothing, never the first ones: the trace
 * is exact (design §9), and a prefix would show only some of the rounds the answer was written with. A call that ran keeps
 * its input (`keptInput`) and what it handed out (a messages search how many messages, a web search its pages' numbers);
 * one refused keeps the tool's own refusal when it is one (`REFUSAL_SENTENCES`), else `UNUSABLE` — and never an input.
 */
export function storedToolCalls(trace: readonly ToolTrace[], refs: RunRefs | null, maxCalls: number): StoredToolCall[] | null {
  if (trace.length === 0 || trace.length > Math.min(maxCalls, CALLS_MAX) || !trace.every((c) => REPLAY_TOOLS.includes(c.name))) return null;
  if (!trace.every((c, i) => Number.isSafeInteger(c.round) && c.round >= 1 && c.round <= ROUNDS_MAX && (i === 0 || c.round >= trace[i - 1]!.round))) return null;
  return trace.map((c): StoredToolCall => {
    if (c.outcome !== "ok") return { name: c.name, round: c.round, outcome: "refused", error: c.said !== undefined && REFUSAL_SENTENCES.has(c.said) ? c.said : UNUSABLE };
    const found = c.name === SEARCH_MESSAGES ? { found: isCount(c.found, FOUND_MAX) ? c.found : 0 } : {};
    const pages = c.name === SEARCH_WEB ? { pages: (c.pages ?? []).filter((n) => Number.isSafeInteger(n) && n >= 1).slice(0, PAGES_MAX) } : {};
    return { name: c.name, round: c.round, outcome: "ok", input: keptInput(c.name, c.input, refs), ...found, ...pages };
  });
}

/** One stored call read back, or null when it is not one `storedToolCalls` writes. */
function storedCall(v: unknown): StoredToolCall | null {
  if (!isRecord(v) || typeof v.name !== "string" || !REPLAY_TOOLS.includes(v.name) || !Number.isSafeInteger(v.round) || (v.round as number) < 1 || (v.round as number) > ROUNDS_MAX) return null;
  const { name, round } = v as { name: string; round: number };
  if (v.outcome === "refused") {
    if (Object.hasOwn(v, "input") || typeof v.error !== "string" || !REFUSAL_SENTENCES.has(v.error)) return null;
    return { name, round, outcome: "refused", error: v.error };
  }
  if (v.outcome !== "ok" || !isRecord(v.input)) return null;
  const keys = inputKeys(name);
  const input: Record<string, string> = {};
  for (const [key, value] of Object.entries(v.input)) {
    if (!keys.includes(key) || typeof value !== "string") return null;
    input[key] = value;
  }
  if ((name !== CURRENT_TIME && typeof input.query !== "string") || weight(JSON.stringify(input)) > INPUT_MAX_WEIGHT) return null;
  if (name === SEARCH_MESSAGES) return isCount(v.found, FOUND_MAX) ? { name, round, outcome: "ok", input, found: v.found } : null;
  if (name === SEARCH_WEB) {
    const pages = v.pages ?? [];
    if (!Array.isArray(pages) || pages.length > PAGES_MAX || !pages.every((n) => Number.isSafeInteger(n) && n >= 1)) return null;
    return { name, round, outcome: "ok", input, pages: pages as number[] };
  }
  return { name, round, outcome: "ok", input };
}

/** The most calls a reply keeps (`storedToolCalls`): the step-1 tools' per-reply caps, as configured, summed. */
export const maxCallsOf = (tools: { searchPerReply: number; timePerReply: number; web: { perReply: number } }): number => tools.web.perReply + tools.searchPerReply + tools.timePerReply;

/** The calls a stored body's `toolCalls` holds, as `storedToolCalls` wrote them, rounds in order; null when it is anything else. */
export function toolCallsOf(value: unknown): StoredToolCall[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > CALLS_MAX) return null;
  const calls: StoredToolCall[] = [];
  for (const v of value) {
    const c = storedCall(v);
    if (c === null || (calls.length > 0 && c.round < calls[calls.length - 1]!.round)) return null;
    calls.push(c);
  }
  return calls;
}

/**
 * A page's site as a placeholder names it: its host (as the address parses: ASCII, punycode for others), whole labels
 * kept from the right while it is at most `SITE_MAX_CHARS` — `www.tianqi.com`, `example.com` of a long host; null when even
 * its last label is longer, or the address does not parse.
 */
export function siteOf(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  let site = "";
  for (const label of host.split(".").reverse()) {
    if (label === "") continue;
    const next = site === "" ? label : `${label}.${site}`;
    if (next.length > SITE_MAX_CHARS) break;
    site = next;
  }
  return site === "" ? null : site;
}

/**
 * A replayed call's id: 22 hex digits made from the message and the call's place in it (`index`, across its rounds) —
 * the same every time that reply is replayed, never the same for two calls; the gateway writes it in the protocol's style
 * (`replayWireId`). Nothing of the message can be read from it.
 */
export const replayId = (messageId: string, index: number): string => createHash("sha256").update(`replay:${messageId}:${index}`).digest("hex").slice(0, 22);

/** What a reply's message holds beside its calls that its replay is built from: its id, its site day, its pages and citations as stored. */
export interface ReplayFacts {
  /** `messages.id`: what the calls' ids are made from (`replayId`). */
  messageId: string;
  /** The day it was posted, `YYYY-MM-DD` in the site's time zone. */
  day: string;
  /** The body's `webSources` and `webCites`, as stored (checked here: lookups.ts). */
  webSources: unknown;
  webCites: unknown;
}

/** A web search's sites: of its pages, those the reply cites first, then the rest, in order — each site once, at most `SITES_MAX`. */
function sitesOf(pages: readonly number[], facts: ReplayFacts): string[] {
  const sources = webSourcesOf(facts.webSources);
  const cited = new Set(webCitesOf(facts.webCites, sources).map((c) => c.n));
  const ordered = [...pages.filter((n) => cited.has(n)), ...pages.filter((n) => !cited.has(n))];
  const sites: string[] = [];
  for (const n of ordered) {
    const source = sources.find((s) => s.n === n);
    const site = source ? siteOf(source.url) : null;
    if (site !== null && !sites.includes(site)) sites.push(site);
    if (sites.length >= SITES_MAX) break;
  }
  return sites;
}

/** A stored call's placeholder result: stored facts only (harness design §3, Placeholders). */
function placeholder(c: StoredToolCall, facts: ReplayFacts): unknown {
  if (c.outcome === "refused") return { error: c.error, note: REFUSAL_NOTE, date: facts.day };
  if (c.name === SEARCH_WEB) return { note: WEB_NOTE, sites: sitesOf(c.pages ?? [], facts), date: facts.day };
  if (c.name === SEARCH_MESSAGES) return { note: MESSAGES_NOTE, found: c.found ?? 0, date: facts.day };
  return { note: TIME_NOTE, date: facts.day };
}

/**
 * A reply's stored calls (`toolCalls`, as stored) as they return in a later reply's history, round by round: each call as
 * it was made — a refused one with a redacted argument, `{"query":""}` (the clock's `{}`), which its tool's schema takes
 * and its length rule would refuse — and its placeholder result. Null, the reply returning as its text alone, when nothing
 * well formed is stored, more than `maxCalls` are (as `storedToolCalls` would keep none), or a call is to a tool
 * `offered` (this request's tools) does not hold.
 */
export function replayOf(toolCalls: unknown, facts: ReplayFacts, offered: ReadonlySet<string>, maxCalls: number): ReplayRound[] | null {
  const calls = toolCallsOf(toolCalls);
  if (calls === null || calls.length > maxCalls || !calls.every((c) => offered.has(c.name))) return null;
  const rounds: ReplayRound[] = [];
  let round = 0;
  for (const [index, c] of calls.entries()) {
    if (c.round !== round || rounds.length === 0) {
      rounds.push({ calls: [], results: [] });
      round = c.round;
    }
    const id = replayId(facts.messageId, index);
    const input = c.outcome === "ok" ? c.input : c.name === CURRENT_TIME ? {} : { query: "" };
    const call: ReplayCall = { type: "tool-call", id, name: c.name, input };
    const result: ReplayResult = { type: "tool-result", id, name: c.name, output: placeholder(c, facts) };
    rounds[rounds.length - 1]!.calls.push(call);
    rounds[rounds.length - 1]!.results.push(result);
  }
  return rounds;
}
