import { webUrlOf } from "../../../messages/lookups.ts";
import { cleanSnippet, cleanTitle } from "./text.ts";

/**
 * The web search's engine (lane websearch; README "Agents and runs", Web search): one interface, `searchWeb`, behind
 * which a vendor's search runs; the tool (tool.ts) calls it only after its pre-hold has counted and held the search. It
 * never throws for anything the vendor does: every failure is one of a few kinds (`WebSearchError`). It is injected
 * (`ToolDeps.web`, app.ts `Deps.webEngine`): tests use a fake, and no test calls a real one. Two adapters: `exa_search`
 * (Exa's search API, the default since lane websearch2: its result list measured clearly better for another model to read,
 * docs/research/2026-11-22-search-bakeoff.md, addendum) and `deepseek_messages` (DeepSeek's messages endpoint used as a
 * pure search call), chosen by `TOOLS.web.engine`.
 */

/** One result as the engine hands it over: an https address (`webUrlOf`), the cleaned title and snippet, the page's age when known. */
export interface WebResult {
  url: string;
  title: string;
  snippet: string;
  /** When the page says it is from, as the vendor gave it (an ISO date-time). */
  age?: string;
}

/**
 * Why a search brought nothing back: the vendor could not be reached or answered with nothing usable (`unavailable`: the
 * network, a bad or too large body), took longer than its time (`timeout`), refused this query (`refused`), or found
 * nothing — also when it answered without searching (`no_results`); or it answered with an error status
 * (`statusError`): it refused the site's key or account — 401, 402 (out of credits or past its spending budget), 403 —
 * (`engine_refused`), it is overloaded — 429, 503 — (`engine_busy`), any other (`engine_failed`).
 */
export type WebSearchError = "unavailable" | "timeout" | "refused" | "no_results" | "engine_refused" | "engine_busy" | "engine_failed";

/** What one engine call answered, and what it says the call cost the site in micro-USD when it says so (Exa's `costDollars`). */
export type WebSearchAnswer = ({ results: WebResult[] } | { error: WebSearchError }) & { costMicroUsd?: bigint };

export interface WebEngine {
  /** The adapter's name (`TOOLS.web.engine`): the one thing of a search its log line names. */
  readonly name: string;
  searchWeb(query: string, opts: { signal: AbortSignal }): Promise<WebSearchAnswer>;
}

/** Where an engine says how a call went: counts, classes and status codes only. */
export interface EngineLog {
  info(details: Record<string, unknown>, msg: string): void;
  warn(details: Record<string, unknown>, msg: string): void;
}

/** The most of a response body that is read; past it the call has failed (`unavailable`). */
export const RESPONSE_MAX_BYTES = 1_000_000;

/** The kind of an error status (anything but 200; `WebSearchError`). */
export function statusError(status: number): WebSearchError {
  if (status === 401 || status === 402 || status === 403) return "engine_refused";
  if (status === 429 || status === 503) return "engine_busy";
  return "engine_failed";
}

/** The most often the engine's refusal of the site's key or account is warned about: once an hour. */
export const REFUSED_WARN_EVERY_MS = 3_600_000;

/**
 * What an adapter says when its vendor refused the site's key or account (`engine_refused`: 402 is the operator's account
 * out of credits): a metric line every time and one WARN line an hour at most, each naming the status code only — never a
 * body, a key or a query. The hour is this engine's, from `now`.
 */
function refusedWarner(name: string, log: EngineLog, now: () => number) {
  let last = Number.NEGATIVE_INFINITY;
  return (status: number) => {
    log.info({ metric: "web_engine_refused", engine: name, http: status }, "web search: the engine refused the site's key or account");
    const at = now();
    if (at - last < REFUSED_WARN_EVERY_MS) return;
    last = at;
    log.warn({ metric: "web_engine_refused", engine: name, http: status }, "web search: the engine refused the site's key or account (check the key, the credits and the spending limit); said at most once an hour");
  };
}

/** The site's date, `YYYY-MM-DD`, in `timeZone`: what the engine is told today is (measured: without it, it answered with a stale year). */
const dateIn = (now: Date, timeZone: string): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);

/** `res`'s body as text, or null once more than `max` bytes have come (the rest is not read). */
async function cappedText(res: Response, max: number): Promise<string | null> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(all);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** An age the vendor gave, when it is one: a string of at most 40 characters that parses as a date. */
const ageOf = (v: unknown): string | undefined => (typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v)) ? v : undefined);

/** What both adapters are built with (app.ts, from `TOOLS.web` and the key its `apiKeyEnv` names). */
interface EngineOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  maxResults: number;
  log: EngineLog;
  /** The clock of the refusal warning's hour (default the wall clock). Tests fix it. */
  clock?: () => number;
  fetch?: typeof globalThis.fetch;
}

/**
 * One call of an adapter: a POST of `body` to `url` with `headers`, within `timeoutMs`, ended by the run's signal too,
 * reading at most `RESPONSE_MAX_BYTES`, never following a redirect; a 200's body parsed and read by `read`. One log line:
 * the engine, the status class (or `timeout`, `network`, `aborted`, `too_large`, `bad_json`, the error kind of a status),
 * the time and how many results — never the query, an address, a title, a snippet, the key or an upstream body.
 */
async function postSearch(
  name: string,
  o: EngineOptions,
  warnRefused: (status: number) => void,
  call: { url: string; headers: Record<string, string>; body: unknown; signal: AbortSignal; read: (body: unknown) => WebSearchAnswer },
): Promise<WebSearchAnswer> {
  const fetch = o.fetch ?? globalThis.fetch;
  const started = performance.now();
  const timeout = AbortSignal.timeout(o.timeoutMs);
  let status = "network";
  let found: WebSearchAnswer = { error: "unavailable" };
  try {
    const res = await fetch(call.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...call.headers },
      body: JSON.stringify(call.body),
      signal: AbortSignal.any([call.signal, timeout]),
      redirect: "error",
    });
    status = `${Math.floor(res.status / 100)}xx`;
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      found = { error: statusError(res.status) };
      if (found.error === "engine_refused") warnRefused(res.status);
    } else {
      const text = await cappedText(res, RESPONSE_MAX_BYTES);
      if (text === null) {
        status = "too_large";
      } else {
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          status = "bad_json";
        }
        if (status !== "bad_json") found = call.read(body);
      }
    }
  } catch {
    if (timeout.aborted && !call.signal.aborted) {
      status = "timeout";
      found = { error: "timeout" };
    } else {
      status = call.signal.aborted ? "aborted" : "network";
      found = { error: "unavailable" };
    }
  }
  const results = "results" in found ? found.results.length : 0;
  o.log.info({ metric: "web_search", engine: name, status, ms: Math.round(performance.now() - started), results }, "web search: the engine answered");
  return found;
}

/**
 * The results of a DeepSeek messages answer (as measured on 2026-11-22: a `server_tool_use` block, then a
 * `web_search_tool_result` whose `content` lists `web_search_result`s): `refused` for a refusal; `no_results` without a
 * result block (it answered without searching), or with none usable; else the first `maxResults` usable ones — an https
 * address without credentials (`webUrlOf`), the title and snippet cleaned (text.ts), the page's age when it parses — in
 * the vendor's order. The vendor's own rewritten queries, site names, icons and encrypted content are never read.
 */
export function deepseekResults(body: unknown, maxResults: number): WebSearchAnswer {
  if (!isRecord(body)) return { error: "unavailable" };
  if (body.stop_reason === "refusal") return { error: "refused" };
  const content = Array.isArray(body.content) ? body.content : [];
  const block = content.find((b) => isRecord(b) && b.type === "web_search_tool_result");
  if (!isRecord(block)) return { error: "no_results" };
  if (!Array.isArray(block.content)) return { error: "unavailable" };
  const results: WebResult[] = [];
  const seen = new Set<string>();
  for (const r of block.content) {
    if (results.length >= maxResults) break;
    if (!isRecord(r) || r.type !== "web_search_result") continue;
    // Each address once (its parsed form: a host's case is no new page), the first of it kept.
    const url = webUrlOf(r.url);
    if (url === null || seen.has(url)) continue;
    seen.add(url);
    const title = typeof r.title === "string" ? cleanTitle(r.title) : "";
    const snippet = typeof r.snippet === "string" ? cleanSnippet(r.snippet) : "";
    const age = ageOf(r.page_age);
    results.push({ url, title, snippet, ...(age === undefined ? {} : { age }) });
  }
  return results.length === 0 ? { error: "no_results" } : { results };
}

/** What the DeepSeek adapter is built with. */
export interface DeepseekOptions extends EngineOptions {
  model: string;
  timeZone: string;
  now?: () => Date;
}

/**
 * The `deepseek_messages` adapter: `POST {baseUrl}/anthropic/v1/messages` with `max_tokens: 1` — measured: the vendor
 * then runs one search round and returns its result block with no answer text (about 1.7 s, 7.6k–11k input tokens) —,
 * thinking off, a system line with the site's date, its own `deepseek_web_search` tool (never `tool_choice`: refused with
 * a 400), and `safety_check` high. A raw `fetch` (not the SDK, which drops this tool), as `postSearch` makes it. It says
 * nothing of what a call cost (the site's estimate stands for it, `TOOLS.web.costMicroUsdPerSearch`).
 */
export function deepseekEngine(o: DeepseekOptions): WebEngine {
  const name = "deepseek_messages";
  const url = `${o.baseUrl.replace(/\/+$/, "")}/anthropic/v1/messages`;
  const warnRefused = refusedWarner(name, o.log, o.clock ?? Date.now);
  return {
    name,
    searchWeb: (query, { signal }) =>
      postSearch(name, o, warnRefused, {
        url,
        headers: { "x-api-key": o.apiKey, "anthropic-version": "2023-06-01" },
        body: {
          model: o.model,
          max_tokens: 1,
          thinking: { type: "disabled" },
          system: `Today is ${dateIn(o.now?.() ?? new Date(), o.timeZone)}.`,
          tools: [{ type: "deepseek_web_search", name: "deepseek_web_search" }],
          safety_check: { level: "high" },
          messages: [{ role: "user", content: query }],
        },
        signal,
        read: (body) => deepseekResults(body, o.maxResults),
      }),
  };
}

/**
 * What Exa says one call cost (`costDollars`: a number, or an object with a `total` number), in micro-USD rounded up (what
 * the owner's charge is scaled by: never below what was said); null when it does not say. A figure within a millionth of
 * a micro-USD of a whole one is that one (binary fractions: 0.007 × 10⁶ is not exactly 7 000).
 */
export function exaCostOf(costDollars: unknown): bigint | null {
  const total = typeof costDollars === "number" ? costDollars : isRecord(costDollars) && typeof costDollars.total === "number" ? costDollars.total : null;
  if (total === null || !Number.isFinite(total) || total < 0 || total > 1000) return null;
  const micro = total * 1_000_000;
  const whole = Math.round(micro);
  return BigInt(Math.abs(micro - whole) < 1e-6 ? whole : Math.ceil(micro));
}

/** The most of Exa's `results` that is looked at, however many it sent. */
export const EXA_RESULTS_READ = 100;
/** The longest highlight asked for, in characters (`contents.highlights.maxCharacters`). */
export const EXA_HIGHLIGHT_CHARS = 400;

/** Whether `url`'s host is Exa's own (exa.ai or under it): a result pointing back at the engine is no page found. */
const exaOwn = (url: string): boolean => {
  const host = new URL(url).hostname;
  return host === "exa.ai" || host.endsWith(".exa.ai");
};

/**
 * The results of an Exa search answer (`{requestId, results: [{id, title, url, publishedDate?, author, text?,
 * highlights?: string[]}], costDollars}`, its docs of 2026-11-22): of at most the first `EXA_RESULTS_READ` entries, the
 * first `maxResults` usable ones — an https address without credentials (`webUrlOf`), not Exa's own, each address once;
 * the title cleaned; the snippet the highlights joined with " … ", cleaned and cut (text.ts `cleanSnippet`, 300); the
 * page's age its `publishedDate` when it parses — in Exa's order; `no_results` with none; and what Exa says the call cost.
 * Everything read defensively: a missing or wrong-typed field is skipped, never a throw. Author and text are never read.
 */
export function exaResults(body: unknown, maxResults: number): WebSearchAnswer {
  if (!isRecord(body)) return { error: "unavailable" };
  const cost = exaCostOf(body.costDollars);
  const withCost = (a: WebSearchAnswer): WebSearchAnswer => (cost === null ? a : { ...a, costMicroUsd: cost });
  if (!Array.isArray(body.results)) return withCost({ error: "unavailable" });
  const results: WebResult[] = [];
  const seen = new Set<string>();
  for (const r of body.results.slice(0, EXA_RESULTS_READ)) {
    if (results.length >= maxResults) break;
    if (!isRecord(r)) continue;
    const url = webUrlOf(r.url);
    if (url === null || seen.has(url) || exaOwn(url)) continue;
    seen.add(url);
    const highlights = Array.isArray(r.highlights) ? r.highlights.filter((h): h is string => typeof h === "string").slice(0, 10) : [];
    const title = typeof r.title === "string" ? cleanTitle(r.title) : "";
    const snippet = cleanSnippet(highlights.join(" … "));
    const age = ageOf(r.publishedDate);
    results.push({ url, title, snippet, ...(age === undefined ? {} : { age }) });
  }
  return withCost(results.length === 0 ? { error: "no_results" } : { results });
}

/** What the Exa adapter is built with: its search `type` (`TOOLS.web.exaType`) besides the rest. */
export interface ExaOptions extends EngineOptions {
  type: "auto" | "lite" | "fast";
}

/**
 * The `exa_search` adapter: `POST {baseUrl}/search` with the key in `x-api-key` and `{query, type, numResults, contents:
 * {highlights: {maxCharacters: 400}}, moderation: true}` — nothing else Exa takes (domains, dates, the user's location,
 * page text, summaries) — as `postSearch` makes it. Its answer carries what Exa says the call cost (`costDollars`), which
 * the site's money fuse counts in place of the estimate (tool.ts).
 */
export function exaEngine(o: ExaOptions): WebEngine {
  const name = "exa_search";
  const url = `${o.baseUrl.replace(/\/+$/, "")}/search`;
  const warnRefused = refusedWarner(name, o.log, o.clock ?? Date.now);
  return {
    name,
    searchWeb: (query, { signal }) =>
      postSearch(name, o, warnRefused, {
        url,
        headers: { "x-api-key": o.apiKey },
        body: { query, type: o.type, numResults: o.maxResults, contents: { highlights: { maxCharacters: EXA_HIGHLIGHT_CHARS } }, moderation: true },
        signal,
        read: (body) => exaResults(body, o.maxResults),
      }),
  };
}

/**
 * Whether the site offers web search now: an engine (`TOOLS.web.enabled` and its key, app.ts `webEngineOf`) while replies
 * may be offered tools at all (`TOOLS.enabled`). What `GET /api/models` (`webSearchAvailable`) and an Agent's view
 * (`webSearch`) go by.
 */
export const siteOffersWebSearch = (config: { tools: { enabled: boolean } }, engine: WebEngine | null): boolean => engine !== null && config.tools.enabled;
