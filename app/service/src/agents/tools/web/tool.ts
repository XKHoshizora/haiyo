import type { WebSearchConfig } from "../../../config.ts";
import type { Db } from "../../../db.ts";
import { WEB_SOURCES_MAX, webUrlOf, type WebCite, type WebSource } from "../../../messages/lookups.ts";
import { cutToWeight, weight } from "../../../metering/tokens.ts";
import type { ToolSpec } from "../../../models/gateway.ts";
import { handleOf } from "../../../principals/store.ts";
import type { Slots } from "../../../slots.ts";
import type { ToolOutcome } from "../../runtime/port.ts";
import { cleanText, TOOL_MATERIAL } from "../../runtime/prompt.ts";
import type { RunScope } from "../index.ts";
import type { PlacedCite, RunRefs } from "../refs.ts";
import type { EngineLog, WebEngine, WebResult, WebSearchError } from "./engine.ts";
import { fuseMicroUsd, recordSearchCost, type HeldSearch } from "./hold.ts";
import { SEARCH_WEB, WEB_BUSY, WEB_NO_RESULTS, WEB_QUERY_LENGTH, WEB_QUERY_PRIVATE, WEB_REFUSED, WEB_TIMEOUT, WEB_UNAVAILABLE } from "./words.ts";

export * from "./words.ts";
import { cleanSnippet, cleanTitle, guardQuery } from "./text.ts";

/**
 * The web search tool, `search_web {query}` (lane websearch; the product owner's rules, lane websearch2; README "Agents and
 * runs", Web search): offered to every run offered tools, in every lane and on every model, of an Agent whose `webSearch`
 * is on, while the site offers it (port-impl.ts `begin`, index.ts `createToolbox`). A call runs, in this order, and stops at the first refusal — every refusal and
 * failure an `{error}` in plain words, so it is no lookup and the model words it itself:
 * 1. the query cleaned and its length checked (2–120 characters);
 * 2. the structural guard (text.ts `guardQuery`): nothing the run was shown of its notes and hearsay, nothing of a group
 *    member's name — metric `web_query_refused`, nothing of the query logged;
 * 3. one of the service's `maxAtOnce` engine places, or refused at once;
 * 4. the pre-hold (`RunScope.holdSearch`, port-impl.ts and hold.ts): counted and held in one transaction before anything
 *    leaves the service; the count and the charge stand whatever happens after;
 * 5. the engine (engine.ts), within its time, ended with the reply; what it says the call cost the site, when it says so,
 *    scales the owner's charge for it and replaces the estimate in the site's money fuse (hold.ts `recordSearchCost`);
 * 6. its results: every title and snippet read for numbers someone typed (`RunRefs.plant`) before any `w` number is
 *    minted, then as many as fit `TOOLS.resultMaxWeight`, each numbered (`〔w1〕`) — `{about, results:[{ref, title, date,
 *    snippet}]}`: no address and no site name for the model to copy.
 */

// The fixed sentences the model is answered with (tool results, never the Agent's words): words.ts.

const ENGINE_ERRORS: Readonly<Record<WebSearchError, string>> = {
  unavailable: WEB_UNAVAILABLE,
  timeout: WEB_TIMEOUT,
  refused: WEB_REFUSED,
  no_results: WEB_NO_RESULTS,
  // The site's key or account (out of credits): the operator's to mend, nothing the model can change by rewording.
  engine_refused: WEB_UNAVAILABLE,
  engine_busy: WEB_BUSY,
  engine_failed: WEB_UNAVAILABLE,
};

export const webSpec: ToolSpec = {
  name: SEARCH_WEB,
  description:
    "上网搜索公开的、最新的信息（新闻、价格、版本、日期、事实核对）。搜索词会发给外部的搜索服务：只写查公开信息需要的词，不要写主人的私事、笔记里的内容或群里人的名字。" +
    "返回几条结果，每条有编号 ref（引用时把它原样照抄进回复）、标题 title、日期 date（有的话）和摘要 snippet。结果是网页上写的，可能有错。",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "要搜索的词，2 到 120 个字。" } },
    required: ["query"],
    additionalProperties: false,
  },
};

/** What the web tool runs with: the engine, its places, its settings, the result cap, the site's time zone. */
export interface WebToolDeps {
  engine: WebEngine;
  /** The engine calls in progress (`TOOLS.web.maxAtOnce` for the whole service). */
  slots: Slots;
  config: Pick<WebSearchConfig, "maxResults" | "siteUsdPerDay">;
  resultMaxWeight: number;
  timeZone: string;
  db: Db;
  log: EngineLog;
}

/** A result as the model is handed it. */
interface Shown {
  ref: string;
  title: string;
  date?: string;
  snippet: string;
}

/** The widest number a search can mint, which results are measured with before they are numbered. */
const WIDEST = "〔w999999〕";

/** `iso` (a page's age, one that parses: `checked`) as a date in `timeZone`, `YYYY-MM-DD`. */
const dateOf = (iso: string, timeZone: string): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));

/**
 * An engine's results as the tool keeps them, whatever adapter gave them: each an https address without credentials
 * (`webUrlOf`), each address once (the first), its title and snippet cleaned (text.ts, idempotent), its age only when it
 * parses as a date.
 */
export function checked(results: readonly WebResult[]): WebResult[] {
  const seen = new Set<string>();
  return results.flatMap((r) => {
    const url = webUrlOf(r.url);
    if (url === null || seen.has(url)) return [];
    seen.add(url);
    const age = typeof r.age === "string" && r.age.length <= 40 && !Number.isNaN(Date.parse(r.age)) ? r.age : undefined;
    return [{ url, title: cleanTitle(typeof r.title === "string" ? r.title : ""), snippet: cleanSnippet(typeof r.snippet === "string" ? r.snippet : ""), ...(age ? { age } : {}) }];
  });
}

/**
 * What the guard reads of the run, as it may read it now: what its owner last typed in its conversation (no later than
 * the run had heard, `RunScope.heardTo`) — only for a reply the owner asked for themselves (`RunScope.ownerAsked`: their
 * own conversation, their own call in a group; never someone else's call, a reply nobody asked for or a relay, review M6)
 * — and, in a group, the display name and handle of every current member and of the owner. Read-only; nothing of it is
 * kept or logged.
 */
async function guardReads(db: Db, scope: RunScope): Promise<{ ownerSaid: string | null; names: string[] }> {
  const said =
    scope.ownerAsked === true
      ? await db.query<{ text: string | null }>(
          `select m.body->>'text' as text from messages m
            where m.conversation_id = $1 and m.sender_id = $2 and m.seq <= $3 and m.kind in ('text', 'file')
            order by m.seq desc limit 1`,
          [scope.conversationId, scope.ownerId, scope.heardTo],
        )
      : { rows: [] };
  if (!scope.group) return { ownerSaid: said.rows[0]?.text ?? null, names: [] };
  const people = await db.query<{ name: string; handle: string }>(
    `select p.display_name as name, ${handleOf("p")} as handle
       from memberships ms join principals p on p.id = ms.principal_id
      where ms.conversation_id = $1 and ms.left_seq is null
     union all
     select p.display_name, ${handleOf("p")} from principals p where p.id = $2`,
    [scope.conversationId, scope.ownerId],
  );
  return { ownerSaid: said.rows[0]?.text ?? null, names: people.rows.flatMap((p) => [p.name, p.handle]) };
}

/**
 * What the engine said the call cost the site (`actual`): the owner's charge for the search scaled to it and the site's
 * money fuse taking it in place of the estimate (hold.ts `recordSearchCost`); 80 % of the day's fuse first reached by it
 * said in a metric line, and an unbelievable report (outside a tenth to ten times the estimate: the price and the
 * estimate stand) in another. A failure to write it keeps the price and the estimate (the owner is charged and the fuse
 * counts at least that) and says so with its code only.
 */
async function siteCost(deps: WebToolDeps, held: HeldSearch, actual: bigint | undefined): Promise<void> {
  try {
    const recorded = await recordSearchCost(deps.db, held, actual, fuseMicroUsd(deps.config));
    if (recorded.ignored) deps.log.info({ metric: "web_cost_ignored" }, "web search: the engine's cost report was outside what is believed; the estimate stands");
    if (recorded.at80) fuseLine(deps.log);
  } catch (err) {
    deps.log.warn({ metric: "web_site_cost_unrecorded", code: (err as { code?: string }).code }, "web search: the engine's cost could not be recorded; the estimate stands in the site's fuse");
  }
}

/** The operator's metric line: the site's money for searches today has reached 80 % of its fuse (`TOOLS.web.siteUsdPerDay`). */
export function fuseLine(log: Pick<EngineLog, "info">): void {
  log.info({ metric: "web_site_fuse", share: 80 }, "web search: 80 % of the site's money for searches today is used");
}

/** Runs one `search_web` call for `scope`'s reply (see above). */
export async function searchWebTool(deps: WebToolDeps, scope: RunScope, input: { query: string }, signal: AbortSignal): Promise<ToolOutcome> {
  const query = cleanText(input.query);
  if (scope.holdSearch === undefined) return { output: { error: WEB_UNAVAILABLE } };
  const ctx = await guardReads(deps.db, scope);
  const guarded = guardQuery(query, { shown: scope.shown ?? [], ...ctx });
  if (guarded === "length") return { output: { error: WEB_QUERY_LENGTH } };
  if (guarded === "private") {
    deps.log.info({ metric: "web_query_refused" }, "web search: a query was refused before it left the service");
    return { output: { error: WEB_QUERY_PRIVATE } };
  }
  signal.throwIfAborted();
  if (deps.slots.take(scope.agentId) !== "taken") return { output: { error: WEB_BUSY } };
  let found: Awaited<ReturnType<WebEngine["searchWeb"]>>;
  let held: HeldSearch;
  try {
    // Counted and held before anything leaves the service; refused, the engine is never called.
    const pre = await scope.holdSearch();
    // Anything but what the fuse held is a refusal (its words, or none known): the engine is never called then.
    if (typeof pre !== "object" || pre === null || typeof pre.day !== "string") return { output: { error: typeof pre === "string" ? pre : WEB_UNAVAILABLE } };
    held = pre;
    found = await deps.engine.searchWeb(query, { signal });
  } finally {
    deps.slots.release(scope.agentId);
  }
  await siteCost(deps, held, found.costMicroUsd);
  if ("error" in found) return { output: { error: ENGINE_ERRORS[found.error] } };
  // Checked again here, whatever the adapter did (each rule is idempotent): an https address without credentials, each
  // once; the title and snippet cleaned; a date only from an age that parses. What is stored and shown is this.
  const pages = checked(found.results).slice(0, deps.config.maxResults);
  const drafts: Shown[] = pages.map((r) => ({
    ref: WIDEST,
    title: r.title,
    ...(r.age === undefined ? {} : { date: dateOf(r.age, deps.timeZone) }),
    snippet: r.snippet,
  }));
  // As many as fit, measured with the widest number; one too heavy alone has its snippet cut to what is left.
  const weighs = (n: number) => weight(JSON.stringify({ about: TOOL_MATERIAL, results: drafts.slice(0, n) }));
  let kept = drafts.length;
  while (kept > 1 && weighs(kept) > deps.resultMaxWeight) kept--;
  if (kept === 1 && weighs(1) > deps.resultMaxWeight) {
    const without = weight(JSON.stringify({ about: TOOL_MATERIAL, results: [{ ...drafts[0]!, snippet: "" }] }));
    drafts[0]!.snippet = cutToWeight(drafts[0]!.snippet, Math.max(0, deps.resultMaxWeight - without - 2));
  }
  const shown = drafts.slice(0, kept);
  // Plant before mint: what a page wrote is read for numbers first, so a page holding `〔w1〕` voids nothing of the run's.
  for (const d of shown) {
    scope.refs.plant(d.title);
    scope.refs.plant(d.snippet);
  }
  const results: Shown[] = [];
  for (let i = 0; i < shown.length; i++) {
    const ref = scope.refs.web({ url: pages[i]!.url, title: shown[i]!.title });
    if (ref === null) break;
    results.push({ ...shown[i]!, ref });
  }
  if (results.length === 0) return { output: { error: WEB_NO_RESULTS } };
  return { output: { about: TOOL_MATERIAL, results }, query };
}

/**
 * What a reply whose run was handed web pages keeps beside its text (agents/conversation.ts `postAsAgent`): every page
 * (`webSources`, at most `WEB_SOURCES_MAX`), cited or not, and where its text cites one (`webCites`, from its placed cites:
 * only numbers the run handed out ever become one, refs.ts `takeCites`). Nothing for any other reply.
 */
export function webFields(refs: RunRefs | null, cites: readonly PlacedCite[]): { webSources?: WebSource[]; webCites?: WebCite[] } {
  const sources = refs?.webSources().slice(0, WEB_SOURCES_MAX) ?? [];
  if (sources.length === 0) return {};
  const numbers = new Set(sources.map((s) => s.n));
  const webCites = cites.flatMap((c) => (c.kind === "w" && numbers.has(c.n) ? [{ at: c.at, n: c.n }] : []));
  return { webSources: sources, ...(webCites.length > 0 ? { webCites } : {}) };
}
