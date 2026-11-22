import type { Activity } from "../agents/runtime/port.ts";
import { cutToWeight } from "../metering/tokens.ts";
import { cleanModelText, hasVisibleText } from "../schemas.ts";

/**
 * What an Agent's reply looked up with its tools (README "Wire shapes", WireMessage `lookups`, `found`, `queries`; Agents
 * and runs, Tools in a reply): their shapes and limits, and the one check of each — for the worker that collects them
 * (`LookedUp`), the post that stores them (agents/conversation.ts `postAsAgent`) and the read that sends each reader
 * their part (messages/read.ts `toWireForReaders`). None of it is text: no search matches it, no model is shown it.
 */

/** The kinds of a tool's work, as a reply's status line says them and its lookups count them (`web`: only a run offered the web tool has any). */
export const LOOKUP_KINDS: readonly Activity[] = ["search", "file", "time", "web"];

/** How many tool calls of each kind ran for a reply: only kinds above 0. */
export type Lookups = Partial<Record<Activity, number>>;

/** A message a reply's tools found: its conversation and seq. */
export interface MessageRef {
  conversationId: string;
  seq: number;
}

/** What a reply's message keeps of what it looked up; a key only when there is something under it. */
export interface LookupFields {
  lookups?: Lookups;
  /** In the order the tools gave them, each once, at most `FOUND_MAX`. */
  found?: MessageRef[];
  /** The words its searches were for, at most `QUERIES_MAX`, each at most `QUERY_MAX_WEIGHT`: kept only in the Agent's own conversation. */
  queries?: string[];
}

/** The most messages a reply keeps of what its tools found: the first ones. */
export const FOUND_MAX = 20;
/** The most search words a reply keeps: the first ones. */
export const QUERIES_MAX = 6;
/** The most a search word weighs as it is kept (metering/tokens.ts `weight`): longer ones are cut. */
export const QUERY_MAX_WEIGHT = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Whether `x` names a message: a conversation id (lower-case, as the database writes it) and a seq of 1 or more. */
export const isMessageRef = (x: unknown): x is MessageRef =>
  typeof x === "object" &&
  x !== null &&
  typeof (x as MessageRef).conversationId === "string" &&
  UUID.test((x as MessageRef).conversationId) &&
  Number.isSafeInteger((x as MessageRef).seq) &&
  (x as MessageRef).seq >= 1;

/** The counts of `value` (a stored body's `lookups`) that are whole numbers above 0, of a known kind; null when none is. */
export function lookupsOf(value: unknown): Lookups | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const out: Lookups = {};
  for (const kind of LOOKUP_KINDS) {
    const n = Object.hasOwn(value, kind) ? (value as Record<string, unknown>)[kind] : undefined;
    if (typeof n === "number" && Number.isSafeInteger(n) && n > 0) out[kind] = n;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Adds to `into` the messages `value` names that it does not hold yet (`seen`: theirs, by key), in order, up to `FOUND_MAX`. */
function addFound(into: MessageRef[], seen: Set<string>, value: unknown): void {
  if (!Array.isArray(value)) return;
  for (const r of value) {
    if (into.length >= FOUND_MAX) return;
    if (!isMessageRef(r)) continue;
    const key = `${r.conversationId}|${r.seq}`;
    if (seen.has(key)) continue;
    seen.add(key);
    into.push({ conversationId: r.conversationId, seq: r.seq });
  }
}

/** The messages `value` names (a stored body's `found`), each once, in order, at most `FOUND_MAX`. */
export function foundOf(value: unknown): MessageRef[] {
  const out: MessageRef[] = [];
  addFound(out, new Set(), value);
  return out;
}

/**
 * A citation of a reply, stored beside its text as a mention is (README "Agents and runs", Citations; agents/tools/refs.ts
 * `takeCites`): where it stands in the stored text (`at`, UTF-16 code units: a link is drawn there), whether it cites a
 * message or a file (`kind`), and the message it points to — for a file, the message the file was sent in. The text
 * itself never holds a citation (a reply of nothing but token-shaped strings keeps them as text, citing nothing:
 * agents/conversation.ts `postAsAgent`).
 */
export interface Cite {
  at: number;
  kind: "m" | "f";
  ref: MessageRef;
}

/** The most citations a reply keeps: the first ones (of messages and files; web citations count apart, `WebCite`). */
export const CITES_MAX = 20;

/**
 * A web page a reply's run was handed by its web search (agents/tools/web/tool.ts; lane websearch): the number its model
 * was shown (`〔w2〕` is 2), the page's address (https, no credentials, at most `WEB_URL_MAX`) and its title as cleaned.
 * Stored beside the reply as `webSources`, every one the run was handed, cited or not; no snippet is kept.
 */
export interface WebSource {
  n: number;
  url: string;
  title: string;
}

/** Where a reply's text cites a web page of its `webSources` (`n`), as `Cite.at` says where (`webCites`). */
export interface WebCite {
  at: number;
  n: number;
}

/** The most web pages a reply keeps (`webSources`), and the most of its web citations: the first ones. */
export const WEB_SOURCES_MAX = 20;
export const WEB_CITES_MAX = 20;
/** The longest address a web source may have. */
export const WEB_URL_MAX = 2048;
/** The longest title a web source keeps (characters, an ellipsis after a cut counted among them). */
export const WEB_TITLE_MAX = 200;

/**
 * `text` at most `max` characters (code points: a surrogate pair is never split), an ellipsis among them when it is cut:
 * the one length rule of a web title and snippet, where they are written (agents/tools/web/text.ts) and where they are
 * read (`webTitleOf`). Cutting what it already cut changes nothing.
 */
export function cutChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, Math.max(0, max - 1)).join("").trimEnd()}…`;
}

/** A web source's title as stored and sent (`cutChars` at `WEB_TITLE_MAX`): a longer one is cut, never dropped. */
export const webTitleOf = (title: string): string => cutChars(title, WEB_TITLE_MAX);

/**
 * A web page's address as it may be stored and shown (the existing `safeHref` rule, stricter): no white space or control
 * character anywhere, `https://` and a host right after it, a real parse with a host and no user name or password, at most
 * `WEB_URL_MAX` before and after the parse. The parsed form (`URL.href`: its host in ASCII, a punycode host as `xn--…`);
 * null for anything else.
 */
export function webUrlOf(value: unknown): string | null {
  if (typeof value !== "string" || value.length > WEB_URL_MAX || /[\s\p{Cc}]/u.test(value) || !/^https:\/\/[^/?#]/i.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname === "" || url.username !== "" || url.password !== "") return null;
  return url.href.length <= WEB_URL_MAX ? url.href : null;
}

/**
 * The web sources `value` holds (a stored body's `webSources`): well-formed ones — a number, a safe address, a title (cut
 * to `WEB_TITLE_MAX` by the write rule, `webTitleOf`, never dropped for its length) —, each number once, at most
 * `WEB_SOURCES_MAX`.
 */
export function webSourcesOf(value: unknown): WebSource[] {
  if (!Array.isArray(value)) return [];
  const out: WebSource[] = [];
  const seen = new Set<number>();
  for (const s of value) {
    if (out.length >= WEB_SOURCES_MAX) break;
    const { n, url, title } = (typeof s === "object" && s !== null ? s : {}) as Partial<WebSource>;
    const href = webUrlOf(url);
    if (!Number.isSafeInteger(n) || n! < 1 || seen.has(n!) || href === null || typeof title !== "string") continue;
    seen.add(n!);
    out.push({ n: n!, url: href, title: webTitleOf(title) });
  }
  return out;
}

/**
 * Whether a stored body says its run was handed web pages (`webSources`, as stored: any entry, before any of them is
 * checked) — the fact a reader's links-as-plain-text rule goes by (`plainLinks` on the wire), so that no page's own data
 * can turn it off.
 */
export const handedWebPages = (value: unknown): boolean => Array.isArray(value) && value.length > 0;

/**
 * The web citations `value` holds (a stored body's `webCites`): the first `WEB_CITES_MAX`, each a place no further than
 * `length` (the text's) and no earlier than the one before, of a number among `sources`.
 */
export function webCitesOf(value: unknown, sources: readonly WebSource[], length = Number.POSITIVE_INFINITY): WebCite[] {
  if (!Array.isArray(value)) return [];
  const numbers = new Set(sources.map((s) => s.n));
  const out: WebCite[] = [];
  let last = 0;
  for (const c of value.slice(0, WEB_CITES_MAX)) {
    const { at, n } = (typeof c === "object" && c !== null ? c : {}) as Partial<WebCite>;
    if (!Number.isSafeInteger(at) || at! < last || at! > length || !Number.isSafeInteger(n) || !numbers.has(n!)) continue;
    last = at!;
    out.push({ at: at!, n: n! });
  }
  return out;
}

/**
 * The citations `value` holds (a stored body's `cites`): the first `CITES_MAX` of its entries, in order, those well formed
 * — a place no further than `length` (the text's) and no earlier than the one before, a kind, a message — and then of
 * those the ones `keep` (default all) lets a reader be pointed at. Anything else (a body from before citations were kept
 * beside the text holds an object here) is none.
 */
export function citesOf(value: unknown, keep: (r: MessageRef) => boolean = () => true, length = Number.POSITIVE_INFINITY): Cite[] {
  if (!Array.isArray(value)) return [];
  const out: Cite[] = [];
  let last = 0;
  for (const c of value.slice(0, CITES_MAX)) {
    const { at, kind, ref } = (typeof c === "object" && c !== null ? c : {}) as Partial<Cite>;
    if (!Number.isSafeInteger(at) || at! < last || at! > length || (kind !== "m" && kind !== "f") || !isMessageRef(ref)) continue;
    last = at!;
    if (keep(ref)) out.push({ at: at!, kind, ref: { conversationId: ref.conversationId, seq: ref.seq } });
  }
  return out;
}

/** A search word as it is kept: what message text would keep of it (`cleanModelText`), cut to `QUERY_MAX_WEIGHT`; null when it shows nothing. */
export function queryOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = cutToWeight(cleanModelText(value), QUERY_MAX_WEIGHT).trimEnd();
  return hasVisibleText(text) ? text : null;
}

/** Adds `value` to `into` as a search word is kept (`queryOf`), unless it is there already or `into` holds `QUERIES_MAX`. */
function addQuery(into: string[], value: unknown): void {
  if (into.length >= QUERIES_MAX) return;
  const q = queryOf(value);
  if (q !== null && !into.includes(q)) into.push(q);
}

/** The search words `value` holds (a stored body's `queries`), each once, at most `QUERIES_MAX`. */
export function queriesOf(value: unknown): string[] {
  const out: string[] = [];
  if (Array.isArray(value)) for (const v of value) addQuery(out, v);
  return out;
}

/**
 * What the tools of one reply looked up, as they ran (agents/runtime/worker.ts `toolReply`): a call that ran — its tool
 * answered with something usable — counts under its tool's kind, and what it found and the word it searched for are kept
 * by the rules above, in the order the calls ran. A tool with no kind counts nothing and keeps nothing (nothing would
 * show it). A call answered with a note or an error — the loop's own, or the tool's (`{ error }`) — is never `ran`.
 */
export class LookedUp {
  private readonly counts: Lookups = {};
  private readonly found: MessageRef[] = [];
  private readonly seen = new Set<string>();
  private readonly words: string[] = [];

  ran(kind: Activity | undefined, outcome: { found?: unknown; query?: unknown }): void {
    if (kind === undefined) return;
    this.counts[kind] = (this.counts[kind] ?? 0) + 1;
    addFound(this.found, this.seen, outcome.found);
    addQuery(this.words, outcome.query);
  }

  /** As the reply's message carries it: a key only for what there is (a reply whose tools ran none carries none). */
  fields(): LookupFields {
    const lookups = lookupsOf(this.counts);
    return {
      ...(lookups ? { lookups } : {}),
      ...(this.found.length > 0 ? { found: [...this.found] } : {}),
      ...(this.words.length > 0 ? { queries: [...this.words] } : {}),
    };
  }
}
