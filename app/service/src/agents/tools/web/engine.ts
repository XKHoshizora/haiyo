import { webUrlOf } from "../../../messages/lookups.ts";
import { cleanSnippet, cleanTitle } from "./text.ts";

/**
 * The web search's engine (lane websearch; README "Agents and runs", Web search): one interface, `searchWeb`, behind
 * which a vendor's search runs; the tool (tool.ts) calls it only after its pre-hold has counted and held the search. It
 * never throws for anything the vendor does: every failure is one of a few kinds (`WebSearchError`). It is injected
 * (`ToolDeps.web`, app.ts `Deps.webEngine`): tests use a fake, and no test calls a real one.
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
 * Why a search brought nothing back: the vendor could not be reached or answered with nothing usable (`unavailable`),
 * refused for its load (`busy`, a 429), took longer than its time (`timeout`), refused the query (`refused`), or found
 * nothing — also when it answered without searching (`no_results`).
 */
export type WebSearchError = "unavailable" | "busy" | "timeout" | "refused" | "no_results";

export interface WebEngine {
  /** The adapter's name (`TOOLS.web.engine`): the one thing of a search its log line names. */
  readonly name: string;
  searchWeb(query: string, opts: { signal: AbortSignal }): Promise<{ results: WebResult[] } | { error: WebSearchError }>;
}

/** Where an engine says how a call went: counts and classes only. */
export interface EngineLog {
  info(details: Record<string, unknown>, msg: string): void;
}

/** The most of a response body that is read; past it the call has failed (`unavailable`). */
export const RESPONSE_MAX_BYTES = 1_000_000;

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

/**
 * The results of a DeepSeek messages answer (as measured on 2026-11-22: a `server_tool_use` block, then a
 * `web_search_tool_result` whose `content` lists `web_search_result`s): `refused` for a refusal; `no_results` without a
 * result block (it answered without searching), or with none usable; else the first `maxResults` usable ones — an https
 * address without credentials (`webUrlOf`), the title and snippet cleaned (text.ts), the page's age when it parses — in
 * the vendor's order. The vendor's own rewritten queries, site names, icons and encrypted content are never read.
 */
export function deepseekResults(body: unknown, maxResults: number): { results: WebResult[] } | { error: WebSearchError } {
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
    const age = typeof r.page_age === "string" && r.page_age.length <= 40 && !Number.isNaN(Date.parse(r.page_age)) ? r.page_age : undefined;
    results.push({ url, title, snippet, ...(age === undefined ? {} : { age }) });
  }
  return results.length === 0 ? { error: "no_results" } : { results };
}

/** What the DeepSeek adapter is built with (app.ts, from `TOOLS.web` and the key its `apiKeyEnv` names). */
export interface DeepseekOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxResults: number;
  timeZone: string;
  log: EngineLog;
  now?: () => Date;
  fetch?: typeof globalThis.fetch;
}

/**
 * The `deepseek_messages` adapter: `POST {baseUrl}/anthropic/v1/messages` with `max_tokens: 1` — measured: the vendor
 * then runs one search round and returns its result block with no answer text (about 1.7 s, 7.6k–11k input tokens) —,
 * thinking off, a system line with the site's date, its own `deepseek_web_search` tool (never `tool_choice`: refused with
 * a 400), and `safety_check` high. A raw `fetch` (not the SDK, which drops this tool), within `timeoutMs`, ended by the
 * run's signal too, reading at most `RESPONSE_MAX_BYTES`. One log line per call: the engine, the status class, the time
 * and how many results — never the query, an address, a title, a snippet, the key or an upstream body.
 */
export function deepseekEngine(o: DeepseekOptions): WebEngine {
  const url = `${o.baseUrl.replace(/\/+$/, "")}/anthropic/v1/messages`;
  const call = o.fetch ?? globalThis.fetch;
  const name = "deepseek_messages";
  return {
    name,
    async searchWeb(query, { signal }) {
      const started = performance.now();
      const timeout = AbortSignal.timeout(o.timeoutMs);
      let status = "network";
      let found: { results: WebResult[] } | { error: WebSearchError } = { error: "unavailable" };
      try {
        const res = await call(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": o.apiKey, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({
            model: o.model,
            max_tokens: 1,
            thinking: { type: "disabled" },
            system: `Today is ${dateIn(o.now?.() ?? new Date(), o.timeZone)}.`,
            tools: [{ type: "deepseek_web_search", name: "deepseek_web_search" }],
            safety_check: { level: "high" },
            messages: [{ role: "user", content: query }],
          }),
          signal: AbortSignal.any([signal, timeout]),
          redirect: "error",
        });
        status = `${Math.floor(res.status / 100)}xx`;
        if (res.status !== 200) {
          await res.body?.cancel().catch(() => {});
          found = { error: res.status === 429 ? "busy" : "unavailable" };
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
            if (status !== "bad_json") found = deepseekResults(body, o.maxResults);
          }
        }
      } catch {
        if (timeout.aborted && !signal.aborted) {
          status = "timeout";
          found = { error: "timeout" };
        } else {
          status = signal.aborted ? "aborted" : "network";
          found = { error: "unavailable" };
        }
      }
      const results = "results" in found ? found.results.length : 0;
      o.log.info({ metric: "web_search", engine: name, status, ms: Math.round(performance.now() - started), results }, "web search: the engine answered");
      return found;
    },
  };
}
