import { cutChars, WEB_TITLE_MAX } from "../../../messages/lookups.ts";
import { cleanText } from "../../runtime/prompt.ts";

/**
 * What the web search (tool.ts; lane websearch) lets out and lets in, as text: the query's one normal form (`queryForm`)
 * and the structural guard on it (`guardQuery`), run before anything leaves the service; and what of a result's title and
 * snippet the Agent's model is shown (`cleanTitle`, `cleanSnippet`: no address, no mention). Pure: no database, nothing
 * logged.
 */

/** The shortest and the longest query, in characters once cleaned. */
export const QUERY_MIN = 2;
export const QUERY_MAX = 120;
/** The longest title and snippet the model is shown, in characters, an ellipsis after a cut counted among them. */
export const TITLE_MAX = WEB_TITLE_MAX;
export const SNIPPET_MAX = 300;

/** Every run of white space and separators of every kind (no-break and wide spaces, line ends). */
const SPACES = /[\s\p{Z}]+/gu;

/**
 * The query as it is sent and as the loop's repeat rule reads it (runtime/loop.ts `LoopGuard`, worker.ts `same`): cleaned
 * as stored text is (`cleanText`: invisible format characters and controls gone), NFKC (full-width letters and digits are
 * the plain ones), case-folded, every run of white space one space, trimmed. `"x"` and `"x "` are one query.
 */
export function queryForm(query: string): string {
  return cleanText(query).normalize("NFKC").toLowerCase().replace(SPACES, " ").trim();
}

/**
 * What the guard's comparison drops, from the query and from everything it is compared with (notes, hearsay, the owner's
 * words, names, handles) alike: white space and separators, punctuation and symbols, and every format character (zero-width
 * characters and joiners, bidi controls) — so that `李 雷`, `李，雷`, `guardb mia` and a note with `，、·` between its
 * characters read as what they spell.
 */
const IGNORED = /[\s\p{Z}\p{P}\p{S}\p{Cf}]+/gu;

/** The one comparison form of every rule but the Latin words': `queryForm`, then `IGNORED` taken out. */
const compared = (text: string): string => queryForm(text).replace(IGNORED, "");

/**
 * A CJK character, by Script_Extensions (so the katakana long vowel `ー`, Script=Common, counts as kana): Han, kana,
 * Hangul. Their punctuation (`、。「」`, also in these extensions) is gone from the comparison form already.
 */
const CJK = "\\p{scx=Han}\\p{scx=Hiragana}\\p{scx=Katakana}\\p{scx=Hangul}";
const CJK_RUN = new RegExp(`[${CJK}]+`, "gu");
/** A Latin word: Latin letters and digits (on `queryForm`, its words apart). */
const LATIN_WORD = /[\p{Script=Latin}0-9]+/gu;
/** A run of digits (on the comparison form: whatever separated them is gone). */
const DIGIT_RUN = /[0-9]+/g;

/** How many CJK characters in a row, Latin words in a row and digits in a row a query may share with what the run was shown. */
export const CJK_RUN_MIN = 6;
export const LATIN_RUN_MIN = 3;
export const DIGIT_RUN_MIN = 7;
/** The shortest name or handle the group rule looks for, in characters of the comparison form. */
export const NAME_MIN = 2;

/** Every `size`-character window of every run `pattern` matches in `form`. */
function windows(form: string, pattern: RegExp, size: number): string[] {
  const out: string[] = [];
  for (const run of form.match(pattern) ?? []) {
    const chars = Array.from(run);
    for (let i = 0; i + size <= chars.length; i++) out.push(chars.slice(i, i + size).join(""));
  }
  return out;
}

/** Every `size` Latin words in a row of `form` (a `queryForm`), each joined by one space. */
function latinRuns(form: string, size: number): string[] {
  const words = form.match(LATIN_WORD) ?? [];
  const out: string[] = [];
  for (let i = 0; i + size <= words.length; i++) out.push(words.slice(i, i + size).join(" "));
  return out;
}

/** What the guard is given of a run: what it was shown, what its owner last typed in its conversation, who is in its group. */
export interface GuardContext {
  /** The texts of the notes and hearsay this run was shown (port-impl.ts `begin`, `RunScope.shown`). */
  shown: readonly string[];
  /** The text of the owner's latest message in this conversation (null: none). */
  ownerSaid: string | null;
  /** In a group: the display names and handles of every current member and of the owner; elsewhere none. */
  names: readonly string[];
}

/**
 * The structural guard on a web query (attack C2; fix round 1), every rule on one comparison form (`compared`: no white
 * space, punctuation, symbol or format character), but the Latin words' (on `queryForm`, where words stay apart):
 * - "length": not 2 to 120 characters (`queryForm`);
 * - "private": it shares 6 CJK characters in a row, 7 digits in a row (a phone, an ID, a card number), or 3 Latin words in a
 *   row with any note or hearsay text the run was shown — unless that same run also occurs in what the owner last typed in
 *   this conversation (theirs to search) — or, in a group, it holds the display name or handle (2 characters or more) of a
 *   current member or of the owner;
 * - "ok": otherwise.
 * Nothing of it is logged. A guard, not a proof: what it refuses is refused before the engine is called.
 */
export function guardQuery(query: string, ctx: GuardContext): "ok" | "length" | "private" {
  const form = queryForm(query);
  const length = Array.from(form).length;
  if (length < QUERY_MIN || length > QUERY_MAX) return "length";
  const q = compared(query);
  const shown = ctx.shown.map(compared).filter((s) => s !== "");
  const owner = ctx.ownerSaid === null ? "" : compared(ctx.ownerSaid);
  if (shown.length > 0) {
    const shared = (w: string) => shown.some((s) => s.includes(w)) && !owner.includes(w);
    for (const w of windows(q, CJK_RUN, CJK_RUN_MIN)) if (shared(w)) return "private";
    for (const w of windows(q, DIGIT_RUN, DIGIT_RUN_MIN)) if (shared(w)) return "private";
    const runsOf = (s: string) => new Set(latinRuns(s, LATIN_RUN_MIN));
    const shownRuns = ctx.shown.map((s) => runsOf(queryForm(s)));
    const ownerRuns = runsOf(ctx.ownerSaid === null ? "" : queryForm(ctx.ownerSaid));
    for (const r of latinRuns(form, LATIN_RUN_MIN)) if (shownRuns.some((s) => s.has(r)) && !ownerRuns.has(r)) return "private";
  }
  for (const name of ctx.names) {
    const n = compared(name);
    if (Array.from(n).length >= NAME_MIN && q.includes(n)) return "private";
  }
  return "ok";
}

/** What may stand in an address, unescaped. */
const URL_CHARS = "[A-Za-z0-9\\-._~:/?#\\[\\]@!$&'()*+,;=%]";
/** A dot between two labels of a host: `.`, the ideographic `。`, or the defanged `[.]`. */
const DOT = "(?:\\.|。|\\[\\.\\])";
/** The top-level domains a bare host is read as an address with (Node.js, 3.5 and their kind stay). */
const TLDS =
  "com|net|org|cn|io|ai|dev|app|co|me|info|biz|xyz|top|site|online|tech|gov|edu|mil|int|jp|uk|de|fr|ru|kr|tw|hk|mo|sg|us|ca|au|in|tv|cc|ly|gl|gd|to|so|sh|link|club|shop|vip|wang|ink|pro|news|blog|page|cloud|live|example|test|click|lol|icu|buzz|work|life|fun|space|store|art|best|run|website|today|world|one|xin|ltd|cyou|sbs|cfd|bond|monster|rest|bar|win|loan|download|zip|mov";
const HOST = `(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?${DOT})+`;
const ADDRESSES = [
  // A URL of any scheme.
  new RegExp(`[A-Za-z][A-Za-z0-9+.-]{0,20}:\\/\\/${URL_CHARS}*`, "g"),
  // An e-mail address.
  new RegExp(`[A-Za-z0-9._%+-]+[@﹫]${HOST}[A-Za-z]{2,24}`, "g"),
  // www.…
  new RegExp(`www${DOT}${HOST}[A-Za-z]{2,24}${URL_CHARS}*`, "gi"),
  // A host with a path.
  new RegExp(`(?<![A-Za-z0-9@.-])${HOST}[A-Za-z]{2,24}\\/${URL_CHARS}*`, "g"),
  // A bare host on a known top-level domain.
  new RegExp(`(?<![A-Za-z0-9@.-])${HOST}(?:${TLDS})(?![A-Za-z0-9-])(?::[0-9]{1,5})?`, "gi"),
];
/** An `@` (or its look-alike) and the handle after it: a mention. */
const MENTION = /[@﹫][A-Za-z0-9._-]*/g;

/**
 * `text`, NFKC first (a full-width `ｅｖｉｌ．ｃｏｍ` or `https：//` is the plain one), without anything that looks like an
 * address — a URL of any scheme, an e-mail address, `www.…`, a host with a path, a bare host on a known top-level domain,
 * a host's dots also written `。` or `[.]` — and without any `@` mention, every run of white space then one space: what a
 * page wrote can hand the model no address to copy and no one to call. (The plain-text links of a web reply remain the
 * real guard: web/src/ui/Markdown.jsx.)
 */
export function withoutAddresses(text: string): string {
  let out = text.normalize("NFKC");
  for (const pattern of ADDRESSES) out = out.replace(pattern, " ");
  return out.replace(MENTION, " ").replace(SPACES, " ").trim();
}

/**
 * A result's title as the model is shown it and its reply keeps it: cleaned as stored text is (`cleanText`: one line,
 * no invisible format character — bidi controls included — and no control character), without addresses and mentions
 * (`withoutAddresses`), at most `TITLE_MAX` characters (lookups.ts `cutChars`, the read path's rule too). Idempotent.
 */
export const cleanTitle = (title: string): string => cutChars(withoutAddresses(cleanText(title)), TITLE_MAX);

/** A result's snippet as the model is shown it (never stored): as a title, at most `SNIPPET_MAX` characters. */
export const cleanSnippet = (snippet: string): string => cutChars(withoutAddresses(cleanText(snippet)), SNIPPET_MAX);
