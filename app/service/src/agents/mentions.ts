import type { ConversationType } from "../conversations/store.ts";
import type { Queryable } from "../db.ts";
import { AppError } from "../errors.ts";
import type { Mention, MentionsRead } from "../messages/model.ts";
import { handleOf } from "../principals/store.ts";

/**
 * Who a mention means (Task M): decided once, when a message is sent — or, for an Agent's reply, posted — and stored
 * with it (`messages.mentions`, `Mention`: who, and the range of the stored text that names them). Nothing reads mention
 * text again to decide who was meant. A mention picked from the @ list comes with its id (`checkPicked`); an `@…` typed
 * and not picked is read here, once (`mentionsAtSend`, by the family-names reading, `namedIn`); every reader after that —
 * the triggers (runs.ts), the follow-up (by the calls its run recorded), the proactive judgement, the web — reads the
 * stored entries.
 */

/** The most mentions one message stores, picked and typed together (README "Mentions"). */
export const MENTION_LIMIT = 20;

/**
 * `@` not preceded by a word character, then the whole run of word characters after it and, when a `.` and another run
 * follow, that run too: `@owner.name` (family names, Task N). Nothing follows the second `+`, the first run cannot give
 * up a character to a `.` (it is no word character), and a global match resumes after what it took, so each character is
 * looked at a bounded number of times: linear in the text, whatever it holds (long runs of `@`, `.` or word characters
 * included).
 */
export const MENTION = /(?<![A-Za-z0-9_])@([A-Za-z0-9_]+)(?:\.([A-Za-z0-9_]+))?/g;

/** A typed `@…`: the handle it names, lower-cased, and the code units it takes in the text. */
export interface Token {
  handle: string;
  start: number;
  length: number;
}

/** `[start, end)` in code units of a text. */
export type Range = readonly [number, number];

/**
 * A fence line: after any quote markers, indentation and list markers (`- `, `* `, `+ `, `1. `, `1) `: a fence may open
 * a list item), ``` or ~~~ (three or more), then the rest of the line.
 */
const FENCE = /^[ \t>]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)*(`{3,}|~{3,})(.*)$/;
/** A list item's first line: after any quote markers and indentation, a list marker and a space (or nothing more). */
const LIST_ITEM = /^[ \t>]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;

/** How far a line is indented, in columns (a tab to the next multiple of 4). */
function indentOf(line: string): number {
  let columns = 0;
  for (const ch of line) {
    if (ch === " ") columns += 1;
    else if (ch === "\t") columns += 4 - (columns % 4);
    else break;
  }
  return columns;
}

/**
 * The parts of `text` Markdown shows as code, in which a typed `@…` names nobody (README "Mentions", the exact rule):
 * - a fenced block, from its opening fence line to the closing one (the same character, at least as many, nothing but
 *   spaces after them) or to the end of the text when none closes it; a fence may follow quote markers, indentation and
 *   list markers (`- ```js`); a backtick fence's info string holds no backtick;
 * - an indented code block: lines indented 4 columns or more (a tab to the next multiple of 4), the first of them at the
 *   start of the text or after a blank line, unless the text before that blank line is a list item (its own line or a
 *   line indented under it): there, indented lines are the item's text, as Markdown has it for an item's continuation;
 *   blank lines inside the block belong to it, those after its last line do not;
 * - outside those, a backtick span: a run of backticks up to the next run of exactly as many in the same paragraph (a
 *   blank line ends one); a backtick after an odd number of backslashes is text, and so is a run nothing closes.
 * In order, not overlapping; linear in the text. (The web renders with CommonMark; this follows it for these cases. A
 * block indented deeper than its list item's own text — code inside an item — is read as the item's text here.)
 */
export function codeRanges(text: string): Range[] {
  const out: Array<[number, number]> = [];
  const prose: Array<[number, number]> = [];
  let fence: { char: string; size: number; start: number } | null = null;
  let block: { start: number; end: number } | null = null;
  let proseStart = 0;
  let blankBefore = true;
  let inList = false;
  const endProse = (at: number) => {
    if (proseStart >= 0 && at > proseStart) prose.push([proseStart, at]);
    proseStart = -1;
  };
  for (let at = 0; ; ) {
    const newline = text.indexOf("\n", at);
    const end = newline === -1 ? text.length : newline;
    const line = text.slice(at, end);
    const blank = line.trim() === "";
    if (fence !== null) {
      const close = FENCE.exec(line);
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.size && close[2]!.trim() === "") {
        out.push([fence.start, end]);
        fence = null;
        proseStart = end;
      }
    } else if (block !== null && (blank || indentOf(line) >= 4)) {
      if (!blank) block.end = end;
    } else {
      if (block !== null) {
        out.push([block.start, block.end]);
        proseStart = block.end;
        block = null;
      }
      const open = FENCE.exec(line);
      if (open && !(open[1]![0] === "`" && open[2]!.includes("`"))) {
        endProse(at);
        fence = { char: open[1]![0]!, size: open[1]!.length, start: at };
      } else if (!blank && indentOf(line) >= 4 && blankBefore && !inList) {
        endProse(at);
        block = { start: at, end };
      } else {
        if (proseStart < 0) proseStart = at;
        if (!blank) inList = LIST_ITEM.test(line) || (inList && indentOf(line) > 0);
      }
    }
    blankBefore = blank;
    if (newline === -1) break;
    at = newline + 1;
  }
  if (fence !== null) out.push([fence.start, text.length]);
  else if (block !== null) {
    out.push([block.start, block.end]);
    if (block.end < text.length) prose.push([block.end, text.length]);
  } else if (proseStart >= 0 && proseStart < text.length) prose.push([proseStart, text.length]);

  // Each prose part's paragraphs (a blank line ends one), looked for in that part alone: a search from a part's start
  // never runs on past its end (it did, to the next blank line or the end of the text: quadratic in a text of many short
  // parts between fences; tidy round, m-1). No blank line crosses a part's end: a part ends where a fence or a block's
  // first line, never blank, begins.
  for (const [from, to] of prose) {
    let start = from;
    for (const gap of text.slice(from, to).matchAll(/\n[ \t]*\n/g)) {
      out.push(...backtickSpans(text, start, from + gap.index!));
      start = from + gap.index! + gap[0].length;
    }
    if (start < to) out.push(...backtickSpans(text, start, to));
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/**
 * The addresses of `text`, in which an `@name` is part of the address and names nobody (fix round 1, I-3: a name inside
 * an address is not someone being addressed): a URL — a scheme and `://`, or `www.`, then everything up to white space
 * or `<` `>` — and a Markdown link's target, `](` up to its `)` or white space. (An `@` right after `/` is an address
 * too, wherever it is: `inAddress`.) A scheme is tried only where a run of its characters begins (the lookbehind), so
 * a long run of letters is passed once: linear in the text (fix round 2, I-4; it was tried at every character of a run,
 * to the run's end each time). The web's copy (app/web/src/data/mentions.js) is this text exactly: both test suites
 * assert the shared table app/shared/address-cases.json (the pattern, and every case of `addressRanges` and
 * `inAddress`).
 */
export const ADDRESS_PATTERN = /(?:(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]*:\/\/|www\.)[^\s<>]*|\]\([^)\s]*/g;

/**
 * `text` with every character of `taken` (the picked tags' ranges) as `_`: a tag's own text is never read as an address
 * — a person named `www.anna` or `a://b` is picked like anyone, the tag is decided by its id (tidy round, m-6) — while an
 * address that runs into a tag still holds it (`_` is no scheme character, no white space, no `<` `>` `)`). Ranges are
 * clamped to the text.
 */
function withTagsHidden(text: string, taken: readonly Range[]): string {
  if (taken.length === 0) return text;
  let out = "";
  let at = 0;
  for (const [a, b] of [...taken].sort((x, y) => x[0] - y[0])) {
    const from = Math.max(a, at);
    const to = Math.min(b, text.length);
    if (to <= from) continue;
    out += text.slice(at, from) + "_".repeat(to - from);
    at = to;
  }
  return out + text.slice(at);
}

/** The addresses of `text` (`ADDRESS_PATTERN`), in order; the text of `taken` (picked tags) is never read as one. */
export function addressRanges(text: string, taken: readonly Range[] = []): Range[] {
  return [...withTagsHidden(text, taken).matchAll(ADDRESS_PATTERN)].map((m) => [m.index!, m.index! + m[0].length] as const);
}

/**
 * Whether `[start, start + length)` of `text` is part of an address: right after a `/` (`example.org/@anna`), or
 * overlapping one of `ranges` (the text's `addressRanges`, found once for all its mentions). The web's `inAddress` is
 * the same test (the shared table).
 */
export function inAddress(text: string, start: number, length: number, ranges: readonly Range[]): boolean {
  return text[start - 1] === "/" || ranges.some(([a, b]) => start < b && start + length > a);
}

/** The backtick spans of `text` in `[from, to)` (`codeRanges`): an opening run's next run of the same length closes it. */
function backtickSpans(text: string, from: number, to: number): Array<[number, number]> {
  const runs: Array<{ at: number; size: number }> = [];
  for (let i = from; i < to; ) {
    if (text[i] !== "`") {
      i += 1;
      continue;
    }
    let j = i;
    while (j < to && text[j] === "`") j += 1;
    runs.push({ at: i, size: j - i });
    i = j;
  }
  // The runs of each length, in order, and how far each list has been passed: every list is walked forward once.
  const bySize = new Map<number, number[]>();
  runs.forEach((run, k) => {
    const list = bySize.get(run.size);
    if (list) list.push(k);
    else bySize.set(run.size, [k]);
  });
  const passed = new Map<number, number>();
  const spans: Array<[number, number]> = [];
  for (let k = 0; k < runs.length; ) {
    const run = runs[k]!;
    let slashes = 0;
    for (let b = run.at - 1; b >= from && text[b] === "\\"; b -= 1) slashes += 1;
    // An escaped first backtick is text: the rest of the run may open a span (inside one, a backslash is text).
    const escaped = slashes % 2 === 1;
    const size = escaped ? run.size - 1 : run.size;
    const list = size > 0 ? bySize.get(size) : undefined;
    let p = passed.get(size) ?? 0;
    if (list) {
      while (p < list.length && list[p]! <= k) p += 1;
      passed.set(size, p);
    }
    if (!list || p >= list.length) {
      k += 1;
      continue;
    }
    const close = runs[list[p]!]!;
    spans.push([escaped ? run.at + 1 : run.at, close.at + close.size]);
    k = list[p]! + 1;
  }
  return spans;
}

/**
 * A test of whether `[start, start + length)` lies outside every one of `ranges` (any order, overlapping or not), for
 * starts that never go back (matches in the order of the text): each range is passed once, so a text of many spans and
 * many tokens stays linear.
 */
function outside(ranges: readonly Range[]): (start: number, length: number) => boolean {
  const merged: Array<[number, number]> = [];
  for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0])) {
    const last = merged.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  let p = 0;
  return (start, length) => {
    while (p < merged.length && merged[p]![1] <= start) p += 1;
    return !(p < merged.length && merged[p]![0] < start + length);
  };
}

/**
 * A test of whether a typed `@…` at `[start, start + length)` of `text` may be read: outside every one of `skip` (code,
 * addresses, what was picked or read already: `outside`) and not right after a `/` (an address too). The one test of
 * both readings at send: the handles (`mentionTokens`) and, in an Agent's own conversation, its name (`mentionsAtSend`).
 */
function readableIn(text: string, skip: readonly Range[]): (start: number, length: number) => boolean {
  const free = outside(skip);
  return (start, length) => text[start - 1] !== "/" && free(start, length);
}

/**
 * The parts of `text` a typed `@…` is never read in — code (`codeRanges`), addresses (`addressRanges`, the picked
 * tags' own text never one, or the `addresses` its caller has already found) and the picked ranges (`picked`) — and the
 * `@…` read outside them (`mentionTokens`): the whole reading at send but its lookups, linear in the text.
 */
export function typedReading(text: string, picked: readonly Range[] = [], addresses: readonly Range[] = addressRanges(text, picked)): { tokens: Token[]; skip: Range[] } {
  const skip = [...codeRanges(text), ...addresses, ...picked];
  return { tokens: mentionTokens(text, skip), skip };
}

/**
 * The `@…` of `text` the reading looks up, outside `skip` (code, addresses and the picked ranges) and not right after a
 * `/` (an address: `example.org/@anna`, fix round 1): `@owner.name` — an owner's
 * handle of 3 to 24 word characters, a dot, a name part of 2 to 24 — or a bare `@name` of 2 to 24 (a person's handle or
 * display name, or an Agent's name part: `namedIn` says whose). A `.` not followed by a word character is punctuation
 * (`ask @xiaolin.jarvis.` names `xiaolin.jarvis`), only one dot counts (`@abc.def.ghi` names `abc.def`), and a run
 * beyond those lengths on either side names nobody; `mail@anna` names nobody (an address). Every occurrence, in order,
 * lower-cased.
 */
export function mentionTokens(text: string, skip: readonly Range[] = []): Token[] {
  const found: Token[] = [];
  const readable = readableIn(text, skip);
  for (const match of text.matchAll(MENTION)) {
    const [whole, first, name] = match as unknown as [string, string, string | undefined];
    const fits = name === undefined ? first.length >= 2 && first.length <= 24 : first.length >= 3 && first.length <= 24 && name.length >= 2 && name.length <= 24;
    if (!fits || !readable(match.index!, whole.length)) continue;
    found.push({ handle: (name === undefined ? first : `${first}.${name}`).toLowerCase(), start: match.index!, length: whole.length });
  }
  return found;
}

/**
 * The handles `tokens` name (`mentionTokens`): distinct, in the order they first appear, at most the first MENTION_LIMIT
 * — what one message may look up. Pure: no lookup, so a text that names nobody costs no query.
 */
export function mentionedHandles(tokens: readonly Token[]): string[] {
  return [...new Set(tokens.map((t) => t.handle))].slice(0, MENTION_LIMIT);
}

/**
 * Whom each of `handles` names among the current members of conversation `conversationId` (an Agent not deleted), by the
 * family-names reading (Task N): `owner.name` the Agent with name part `name` of the person whose handle is `owner` now
 * (a handle they gave up names nobody); a bare `name` the person member with that handle, else the one person member
 * whose display name it is (trimmed, case ignored, the whole name: people first — two such people name nobody), else the
 * one Agent member with that name part. Two or more of one name part, or for a full handle two live Agents (only a write
 * that skipped the owner's account lock could make them), name nobody — and those are `shared`: a handle that asks an
 * Agent here without naming one (fix round 1, I-1). Handles that name nobody are absent from `named`. One query, none
 * when there is nothing to look up.
 */
async function namedIn(q: Queryable, conversationId: string, handles: readonly string[]): Promise<{ named: Map<string, string>; shared: Set<string> }> {
  const named = new Map<string, string>();
  const shared = new Set<string>();
  const wanted = [...new Set(handles)];
  if (wanted.length === 0) return { named, shared };
  const parts = [...new Set(wanted.map((h) => h.slice(h.indexOf(".") + 1)))];
  const bare = wanted.filter((h) => !h.includes("."));
  const { rows } = await q.query<{ id: string; kind: "human" | "agent"; handle: string; owner: string | null; name: string }>(
    `select p.id, p.kind, lower(p.handle::text) as handle, lower(o.handle::text) as owner, lower(btrim(p.display_name)) as name
       from memberships m
       join principals p on p.id = m.principal_id
       left join principals o on o.id = p.owner_id
      where m.conversation_id = $1 and m.left_seq is null
        and (p.handle = any($2::citext[]) or (p.kind = 'human' and lower(btrim(p.display_name)) = any($3::text[])))
        and not exists (select 1 from agents a where a.principal_id = p.id and a.deleted_at is not null)`,
    [conversationId, parts, bare],
  );
  const one = (ids: readonly string[]): string | null => (ids.length === 1 ? ids[0]! : null);
  for (const handle of wanted) {
    let agents: string[] = [];
    let id: string | null;
    if (handle.includes(".")) {
      agents = rows.filter((r) => r.kind === "agent" && `${r.owner}.${r.handle}` === handle).map((r) => r.id);
      id = one(agents);
    } else {
      const byHandle = rows.find((r) => r.kind === "human" && r.handle === handle);
      const byName = rows.filter((r) => r.kind === "human" && r.name === handle);
      if (!byHandle && byName.length === 0) agents = rows.filter((r) => r.kind === "agent" && r.handle === handle).map((r) => r.id);
      id = byHandle ? byHandle.id : byName.length > 0 ? one(byName.map((r) => r.id)) : one(agents);
    }
    if (id !== null) named.set(handle, id);
    else if (agents.length > 1) shared.add(handle);
  }
  return { named, shared };
}

/**
 * Whether any of `handles` (full ones, `owner.name`) is the full handle of an Agent anywhere, in this conversation or not,
 * deleted or not: one such typed `@` asks an Agent (fix round 1, I-1; the reading the proactive judgement had before Task
 * M). One query.
 */
async function anyAgentHandle(q: Queryable, handles: readonly string[]): Promise<boolean> {
  if (handles.length === 0) return false;
  const { rowCount } = await q.query(
    `select 1 from principals o join principals p on p.owner_id = o.id and p.kind = 'agent'
      where o.kind = 'human' and o.handle = any($1::citext[]) and lower(o.handle::text || '.' || p.handle::text) = any($2::text[])
      limit 1`,
    [handles.map((h) => h.slice(0, h.indexOf("."))), handles],
  );
  return rowCount !== 0;
}

/**
 * Whether `namePart` alone calls Agent `agentId` in conversation `conversationId` (`namedIn`): the system text then names
 * both ways it is called (port-impl.ts `begin`). It reads no message: it says how a typed `@name` would be read at send.
 */
export async function namePartCalls(q: Queryable, conversationId: string, namePart: string, agentId: string): Promise<boolean> {
  return (await namedIn(q, conversationId, [namePart.toLowerCase()])).named.get(namePart.toLowerCase()) === agentId;
}

const bad = (): AppError => new AppError(400, "bad_mentions");

/** Whether position `at` of `text` falls between the two halves of a surrogate pair (an emoji cut in two). */
const splitsPair = (text: string, at: number): boolean =>
  at > 0 && at < text.length && /[\uD800-\uDBFF]/.test(text[at - 1]!) && /[\uDC00-\uDFFF]/.test(text[at]!);

/** The longest name a mention can show, in characters: a full handle (24 + 1 + 24); a display name is at most 40. */
const NAME_MAX = 49;

/**
 * Whether `@name`, a picked range's text, is one mention (fix round 1, M-2): `@` and a name — not `@` alone, nothing but
 * spaces, a space at either end or a line break inside — of at most NAME_MAX characters.
 */
const oneMention = (range: string): boolean => {
  const name = range.slice(1);
  return name !== "" && !/^\s|\s$/.test(name) && !/[\n\r\u2028\u2029]/.test(name) && Array.from(name).length <= NAME_MAX;
};

/**
 * The mentions picked from the @ list, as sent with a message (`POST …/messages` `mentions`), checked against its text as
 * it is stored (`text`) and its conversation: at most MENTION_LIMIT; each range inside the text, not cutting a surrogate
 * pair, one `@name` (`oneMention`), not part of an address (`inAddress`: right after `/`, or inside a URL or a link's
 * target, `addressRanges` — a tag's own text is never one), in ascending order and not overlapping the one before; each
 * id a current member of the
 * conversation (a person, or an Agent that is not deleted — who can be called there is decided by the triggers, as for
 * any mention). The text in a range is otherwise free: it is the name as the sender saw it. Anything else: 400
 * `bad_mentions`, and nothing is stored. One query, none when nothing was picked.
 */
export async function checkPicked(
  q: Queryable,
  conversationId: string,
  text: string,
  picked: readonly Mention[],
  addresses: readonly Range[] = addressRanges(
    text,
    picked.map((m) => [m.start, m.start + m.length] as const),
  ),
): Promise<void> {
  if (picked.length === 0) return;
  if (picked.length > MENTION_LIMIT) throw bad();
  let end = 0;
  for (const { start, length } of picked) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < end || length < 1 || start + length > text.length) throw bad();
    if (text[start] !== "@" || splitsPair(text, start + length) || !oneMention(text.slice(start, start + length))) throw bad();
    if (inAddress(text, start, length, addresses)) throw bad();
    end = start + length;
  }
  const ids = [...new Set(picked.map((m) => m.id))];
  const { rows } = await q.query<{ id: string }>(
    `select p.id from memberships m join principals p on p.id = m.principal_id
      where m.conversation_id = $1 and m.left_seq is null and p.id = any($2::uuid[])
        and not exists (select 1 from agents a where a.principal_id = p.id and a.deleted_at is not null)`,
    [conversationId, ids],
  );
  if (rows.length !== ids.length) throw bad();
}

/**
 * The mentions a message stores (`messages.mentions`; null for none), decided now, once, in the transaction that stores
 * it — a person's send (after `checkPicked`) and an Agent's post alike: the picked ones (`picked`, as sent), and the
 * `@…` typed outside them and outside code (`codeRanges`) read once by the family-names reading (`mentionTokens`,
 * `namedIn`: at most the first MENTION_LIMIT distinct handles are looked up), each occurrence an entry with the range it
 * matched; what names nobody stores nothing. In an Agent's own conversation (`type` `agent`) the Agent is also named as
 * it always was there (spec 6.5): by its full handle or its name part as a whole mention, and by `@` and its name
 * anywhere (case ignored), outside code. At most MENTION_LIMIT in all, the picked ones first; in order of their ranges.
 * Nothing in an address is read (`addressRanges`, and an `@` right after `/`).
 * With them, read by the same reading at the same moment (fix round 1, I-1): `asksAgent`, whether a typed `@…` asked an
 * Agent it could not name — a bare name two or more Agent members share (and no person), or the full handle of an Agent
 * that is not one of the conversation's (or of two live ones): stored as `messages.asks_agent`, for the proactive
 * judgement alone (never on the wire).
 */
export async function mentionsAtSend(
  q: Queryable,
  conversation: { id: string; type: ConversationType },
  text: string,
  picked: readonly Mention[] = [],
  addresses?: readonly Range[],
): Promise<MentionsRead> {
  const kept = picked.map(({ id, start, length }) => ({ id, start, length }));
  // No `@` typed anywhere: only what was picked (and no query at all).
  if (!text.includes("@")) return { mentions: kept.length === 0 ? null : kept, asksAgent: false };
  const taken: Range[] = picked.map((m) => [m.start, m.start + m.length] as const);
  const { tokens, skip } = typedReading(text, taken, addresses);
  const typed: Mention[] = [];
  let asksAgent = false;
  const own = conversation.type === "agent" ? await ownAgent(q, conversation.id) : null;
  if (tokens.length > 0) {
    const handles = mentionedHandles(tokens);
    const ownHandle = (h: string) => own !== null && (h === own.handle || h === own.namePart);
    const { named, shared } = await namedIn(q, conversation.id, handles.filter((h) => !ownHandle(h)));
    for (const token of tokens) {
      const id = ownHandle(token.handle) && handles.includes(token.handle) ? own!.id : named.get(token.handle);
      if (id !== undefined) typed.push({ id, start: token.start, length: token.length });
    }
    asksAgent = shared.size > 0 || (await anyAgentHandle(q, handles.filter((h) => h.includes(".") && !ownHandle(h) && !named.has(h))));
  }
  if (own !== null && own.name !== "") {
    const byName = new RegExp(`@${own.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "giu");
    // (Read as the handles are: outside code, addresses and what was picked or read already, not after a `/`.)
    const readable = readableIn(text, [...skip, ...typed.map((m) => [m.start, m.start + m.length] as const)]);
    for (const match of text.matchAll(byName)) {
      if (readable(match.index!, match[0].length)) typed.push({ id: own.id, start: match.index!, length: match[0].length });
    }
  }
  const room = Math.max(0, MENTION_LIMIT - kept.length);
  const all = [...kept, ...typed.sort((a, b) => a.start - b.start).slice(0, room)];
  return { mentions: all.length === 0 ? null : all.sort((a, b) => a.start - b.start), asksAgent };
}

/** The Agent of its own conversation `conversationId`: its id, full handle and name part (lower-cased), and its name. */
async function ownAgent(q: Queryable, conversationId: string): Promise<{ id: string; handle: string; namePart: string; name: string } | null> {
  const { rows } = await q.query<{ id: string; handle: string; name_part: string; name: string }>(
    `select p.id, lower(${handleOf("p")}) as handle, lower(p.handle::text) as name_part, p.display_name as name
       from agent_conversations ac join principals p on p.id = ac.agent_id where ac.conversation_id = $1`,
    [conversationId],
  );
  const r = rows[0];
  return r ? { id: r.id, handle: r.handle, namePart: r.name_part, name: r.name } : null;
}
