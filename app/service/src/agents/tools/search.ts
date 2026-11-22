import type { Tx } from "../../db.ts";
import type { MessageRef } from "../../messages/lookups.ts";
import { inSearchBudget, searchRows, type SearchRow } from "../../messages/search.ts";
import { cutToWeight, lastToWeight, weight } from "../../metering/tokens.ts";
import type { ToolSpec } from "../../models/gateway.ts";
import { askerLine } from "../context.ts";
import type { ToolOutcome } from "../runtime/port.ts";
import { cleanText, labelName, NO_GROUP_TITLE, oneLine, speakerRole, TOOL_MATERIAL, withoutMark } from "../runtime/prompt.ts";
import { siteDateTime, siteWeekday } from "./clock.ts";
import type { ElsewhereAsk, RunScope, ToolDeps } from "./index.ts";

/**
 * The search tool (README "Agents and runs", Tools in a reply; design rules 1–4): the messages a reply's Agent can find
 * by words, as the Agent sees them. Where it looks is decided here and never by the model, whatever it passes: in a group
 * exactly that group — and there only what the reply may see (after its asker's line, and no later than what it had heard
 * when it began, `RunScope.heardTo`; the calls it answers whatever their seq, those at or before the line as their text
 * only); in the Agent's own conversation every conversation the Agent is a current member of. The reader is always the
 * Agent's own principal (VISIBLE_JOIN): nothing from before it joined, nothing of a conversation it has left. Its text and
 * its file's name are all that is read of a message — never its reasoning, never what an earlier reply looked up.
 */

export const SEARCH_MESSAGES = "search_messages";

/** At most this many results come back, the newest. */
export const SEARCH_RESULTS_MAX = 8;
/** A result's text is at most this heavy (metering/tokens.ts `weight`): a cut around what matched. */
export const EXCERPT_MAX_WEIGHT = 200;
/** Of a cut excerpt, at most this much comes before what matched. */
const EXCERPT_BEFORE_WEIGHT = 60;
/** The words searched for weigh at most this much, once cleaned. */
export const QUERY_MAX_WEIGHT = 60;
/** What marks where an excerpt was cut. */
const ELLIPSIS = "…";

// The fixed sentences the model is answered with.
export const SEARCH_TIMEOUT = "这次查找超时了。";
export const SEARCH_BUSY = "现在查找的人太多了，过一会儿再查。";
export const QUERY_TOO_SHORT = "要查的词至少要两个字。";
export const QUERY_TOO_LONG = "要查的词太长了，换几个关键的字再查。";
export const BAD_DATE = "日期要写成 YYYY-MM-DD，比如 2026-11-20。";
export const NOT_FOUND = "没找到。";
export const NOT_FOUND_IN_GROUP = "这个群的记录里没找到。";
/**
 * What nothing found in a group adds when only the Agent's owner asked (rule 3): never another place's name. A plain
 * description of the situation, so the model words it itself (no sentence in its first person to repeat).
 */
export const ASK_ME_AT_HOME = "只有在你和主人的专属会话里才能查所有地方。";
/** Who wrote a result that the Agent itself wrote. */
export const BY_YOU = "你自己";

export function searchSpec(group: boolean): ToolSpec {
  return {
    name: SEARCH_MESSAGES,
    description: group
      ? "在这个群的聊天记录里按原文查找消息：找包含这些字的消息，不是按意思找。返回最新的几条，每条有编号 ref（引用时把它原样照抄进回复）、谁说的 who、什么时候 when、原文片段 text；文件消息还有 file（文件编号和文件名，可以用 read_file 读）。more 为 true 时还有更早的，可以换词或加日期再查。"
      : "在我们的对话和你所在的群里按原文查找消息：找包含这些字的消息，不是按意思找。返回最新的几条，每条有编号 ref（引用时把它原样照抄进回复）、谁说的 who、什么时候 when、原文片段 text；在群里说的有 where（群名），没有 where 的就是我们之间说的；文件消息还有 file（文件编号和文件名，可以用 read_file 读）。more 为 true 时还有更早的，可以换词或加日期再查。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "要找的字或词，原文里连着出现的，至少两个字。" },
        from: { type: "string", description: "只看这个人说的：写对话里显示的名字，或他的账号名。" },
        before: { type: "string", description: "只看这一天之前的（不含这一天），格式 YYYY-MM-DD。" },
        after: { type: "string", description: "只看这一天之后的（不含这一天），格式 YYYY-MM-DD。" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  };
}

/** What the search's input is, once its schema let it through (agents/runtime/loop.ts `fitsSchema`). */
interface SearchInput {
  query: string;
  from?: string;
  before?: string;
  after?: string;
}

/** A day as `YYYY-MM-DD` that is a real date; null otherwise. */
function day(text: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const at = new Date(Date.UTC(y, mo - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === mo - 1 && at.getUTCDate() === d && y >= 1970 ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/**
 * Whom `from` names, as the model may write it: cleaned, without a leading `@`, and without what follows a `｜` (a
 * result's `who` is `name｜role`); null when nothing is left.
 */
function sender(from: string | undefined): string | null {
  if (from === undefined) return null;
  const name = cleanText(from).replace(/^@+/, "").split(/[｜|]/)[0]!.trim();
  return name === "" ? null : name;
}

/** Where `term` first is in `text`, case ignored (on `text` itself: a lower-cased copy may differ in length); -1 when nowhere. */
function findIn(text: string, term: string): number {
  return text.search(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu"));
}

/** `text` as a result shows it: on one line, and when heavier than `EXCERPT_MAX_WEIGHT` cut around where `term` is in it. */
export function excerpt(text: string, term: string): string {
  return excerptAt(text, matchAt(text, term));
}

/** Where `term` is in `text` once on one line (as a result shows it, `excerptAt`), case ignored; -1 when nowhere. */
export function matchAt(text: string, term: string): number {
  return findIn(oneLine(text), term);
}

/**
 * `text` on one line, and when heavier than `EXCERPT_MAX_WEIGHT` cut around `at` — where the words are in that line
 * (`matchAt`; at most 0, or past its end: from its start). What a whisper keeps of a hit is that place, not the words
 * (agents/tools/elsewhere.ts): its excerpt is cut so again when it is read.
 */
export function excerptAt(text: string, at: number): string {
  const line = oneLine(text);
  if (weight(line) <= EXCERPT_MAX_WEIGHT) return line;
  if (at <= 0 || at >= line.length) return cutToWeight(line, EXCERPT_MAX_WEIGHT - weight(ELLIPSIS)) + ELLIPSIS;
  const before = lastToWeight(line.slice(0, at), EXCERPT_BEFORE_WEIGHT);
  const head = before.length < at ? ELLIPSIS + before : before;
  const rest = cutToWeight(line.slice(at), EXCERPT_MAX_WEIGHT - weight(head) - weight(ELLIPSIS));
  return head + rest + (at + rest.length < line.length ? ELLIPSIS : "");
}

/** A result as the model is handed it. */
interface Result {
  ref: string;
  where?: string;
  who: string;
  when: string;
  text: string;
  file?: { ref: string; name: string };
}

/** What the search read in its transaction. */
interface Found {
  rows: SearchRow[];
  /** In a group: whether everyone the reply answers is the Agent's owner (rule 3's hint). */
  ownerAsked: boolean;
}

/** Whether `err` is Postgres cancelling a statement past its time (`statement_timeout`). */
const timedOut = (err: unknown): boolean => (err as { code?: unknown } | null)?.code === "57014";

/**
 * Runs one search for `scope`'s reply: refuses words too short or too heavy and dates not written as days without
 * touching the database; then, holding one of the Agent's search slots (as a person's search holds theirs: two at once,
 * four in the whole service; none free: `SEARCH_BUSY`), one read-only transaction under the search timeout
 * (`inSearchBudget`; past it: `SEARCH_TIMEOUT`). It never finds the messages the run answers (`answering`, item E: the
 * question is in the model's context already, and would otherwise match itself), so "nothing found" — and the elsewhere
 * hook with it — is decided without them. The output is `{about, more, results}` — `TOOL_MATERIAL`, then the
 * paging flag before the results (so a cut of the result, runtime/loop.ts, keeps it), the newest `SEARCH_RESULTS_MAX`
 * at most, as many as fit `TOOLS.resultMaxWeight` — or, with nothing found, `{results: [], note}`. In a group nothing
 * found also starts the elsewhere hook (`ToolDeps.elsewhere`, Task 8) on its own, never awaited (`lookElsewhere`): what
 * it does or how long it takes changes nothing the model is told, nor when. A result's numbers are minted for what is
 * handed over only; what it found (`found`) and the words (`query`) go with the outcome.
 */
export async function searchMessages(deps: ToolDeps, scope: RunScope, input: SearchInput, signal: AbortSignal): Promise<ToolOutcome> {
  const term = cleanText(input.query);
  if (Array.from(term).length < 2) return { output: { error: QUERY_TOO_SHORT } };
  if (weight(term) > QUERY_MAX_WEIGHT) return { output: { error: QUERY_TOO_LONG } };
  const before = input.before === undefined ? null : day(input.before);
  const after = input.after === undefined ? null : day(input.after);
  if ((input.before !== undefined && before === null) || (input.after !== undefined && after === null)) return { output: { error: BAD_DATE } };
  const from = sender(input.from);

  const taken = deps.searches.take(scope.agentId);
  if (taken !== "taken") return { output: { error: SEARCH_BUSY } };
  let found: Found;
  try {
    signal.throwIfAborted();
    found = await inSearchBudget(deps.db, deps.config.searchStatementTimeoutMs, (t) => look(t, deps, scope, { term, from, before, after }));
  } catch (err) {
    if (timedOut(err)) return { output: { error: SEARCH_TIMEOUT } };
    throw err;
  } finally {
    deps.searches.release(scope.agentId);
  }

  if (found.rows.length === 0) {
    if (scope.group) lookElsewhere(deps, scope, { term, from, before, after });
    const note = scope.group ? NOT_FOUND_IN_GROUP + (found.ownerAsked ? ASK_ME_AT_HOME : "") : NOT_FOUND;
    return { output: { results: [], note }, query: term };
  }
  const { results, refs, more } = fit(found, deps, scope, term);
  return { output: { about: TOOL_MATERIAL, more, results }, found: refs, query: term };
}

/**
 * The elsewhere hook (`ToolDeps.elsewhere`), started after the search has answered and never awaited: it cannot change
 * or delay what the model is told. Whatever it throws, or the promise it returns rejects with, is logged by its kind only
 * (never the words or anything found).
 */
function lookElsewhere(deps: ToolDeps, scope: RunScope, ask: ElsewhereAsk): void {
  const hook = deps.elsewhere;
  if (hook === undefined) return;
  void Promise.resolve()
    .then(() => hook(scope, ask))
    .catch((err: unknown) => deps.log.warn({ runId: scope.id, kind: (err as { name?: unknown } | null)?.name ?? typeof err }, "agent tool: the elsewhere hook failed"));
}

/** The search's one transaction: where it may look, then the rows; in a group with nothing found, who asked. */
async function look(t: Tx, deps: ToolDeps, scope: RunScope, o: { term: string; from: string | null; before: string | null; after: string | null }): Promise<Found> {
  let conversationIds: string[];
  let window = null;
  let line = 0;
  if (scope.group) {
    conversationIds = [scope.conversationId];
    line = await askerLine(t, scope.id);
    window = { conversationId: scope.conversationId, after: line, upTo: scope.heardTo };
  } else {
    const { rows } = await t.query<{ id: string }>("select conversation_id as id from memberships where principal_id = $1 and left_seq is null order by conversation_id", [scope.agentId]);
    conversationIds = rows.map((r) => r.id);
  }
  // Never what this run answers and is shown (in a group its calls and the latest message it covers; in its own
  // conversation the owner's messages its call shows, from `shownFrom`): its model has them already, and a question would
  // match itself (item E). Left out in the same statement, so the page and `more` count what is left.
  const answering = { runId: scope.id, conversationId: scope.conversationId, shownFrom: scope.shownFrom ?? null };
  const rows = await searchRows(t, scope.agentId, { conversationIds, ...o, timeZone: deps.config.siteTimezone, window, answering, limit: SEARCH_RESULTS_MAX + 1 });
  let ownerAsked = false;
  if (scope.group && rows.length === 0) {
    const asked = await t.query<{ only: boolean | null }>("select coalesce(asker_ids, '{}') = array[$2::uuid] as only from agent_runs where id = $1", [scope.id, scope.ownerId]);
    ownerAsked = asked.rows[0]?.only === true;
  }
  return { rows, ownerAsked };
}

/** The longest numbers a reply's search can mint (`refs.ts`: six digits), whose tokens results are measured with. */
const WIDEST_MESSAGE = "m999999";
const WIDEST_FILE = "f999999";

/**
 * The results handed over: the newest first, at most `SEARCH_RESULTS_MAX`, then as many as fit `TOOLS.resultMaxWeight`
 * whole (measured with the widest numbers, then numbered); `more` when any found were left out. Who wrote each (`name｜
 * role`, as a group's labels name people: by account, never by what anyone wrote; `你自己` for the Agent), when (the
 * site's time, `YYYY-MM-DD HH:mm 周X`), what (`excerpt`), where (in the Agent's own conversation, a group's title for
 * what was said there), and a file's number and name (a call the run answers, which its model is shown as its text only
 * when it is at or before a group reply's line, is never among them: item E). In a group the run's mark is taken out of whatever someone else wrote; the rest is shown as it is
 * stored (no stored text holds a citation: what looks like one is what someone wrote). Each message and file is named
 * by its number as the model is shown it, `〔m1〕` (`ref`, refs.ts): the only numbers it can cite.
 */
function fit(found: Found, deps: ToolDeps, scope: RunScope, term: string): { results: Result[]; refs: MessageRef[]; more: boolean } {
  const clean = (s: string): string => withoutMark(s, scope.group ? scope.mark : null);
  const drafts = found.rows.slice(0, SEARCH_RESULTS_MAX).map((row) => {
    const seq = Number(row.seq);
    // Who they are to the Agent by account, as a group's labels say it (`speakerRole`); the Agent itself is `你自己`.
    const role = row.sender_id === scope.agentId ? null : speakerRole(row.sender_id, row.sender_kind, scope.ownerId);
    const { date, time } = siteDateTime(row.created_at, deps.config.siteTimezone);
    const elsewhere = !scope.group && row.conversation_id !== scope.conversationId;
    const file = row.attachment ? { id: row.attachment.id, name: clean(row.attachment.name) } : null;
    const result: Result = {
      ref: scope.refs.token(WIDEST_MESSAGE),
      ...(elsewhere ? { where: oneLine(clean(cleanText(row.title ?? ""))) || NO_GROUP_TITLE } : {}),
      who: role === null ? BY_YOU : `${clean(labelName(row.sender_name, row.sender_handle))}｜${role}`,
      when: `${date} ${time} ${siteWeekday(row.created_at, deps.config.siteTimezone)}`,
      text: excerpt(clean(row.text ?? ""), term),
      ...(file ? { file: { ref: scope.refs.token(WIDEST_FILE), name: file.name } } : {}),
    };
    return { result, at: { conversationId: row.conversation_id, seq }, attachmentId: file?.id ?? null };
  });
  let kept = drafts.length;
  let more = found.rows.length > SEARCH_RESULTS_MAX;
  const max = deps.config.tools.resultMaxWeight;
  const weighs = (n: number, m: boolean) => weight(JSON.stringify({ about: TOOL_MATERIAL, more: m, results: drafts.slice(0, n).map((d) => d.result) }));
  while (kept > 1 && weighs(kept, true) > max) {
    kept--;
    more = true;
  }
  const shown = drafts.slice(0, kept);
  // One result too heavy alone (a very small `resultMaxWeight`): its text cut to what is left.
  if (kept === 1 && weighs(1, more) > max) {
    const first = shown[0]!.result;
    const without = weight(JSON.stringify({ about: TOOL_MATERIAL, more, results: [{ ...first, text: "" }] }));
    first.text = cutToWeight(first.text, Math.max(0, max - without - 2));
  }
  // What anyone wrote of what is shown is read for numbers they typed before any is minted (refs.ts `RunRefs.plant`): the
  // results' numbers skip them, and one minted earlier in the run that someone typed here is never cited.
  for (const { result } of shown) for (const said of [result.text, result.who, result.where ?? "", result.file?.name ?? ""]) scope.refs.plant(said);
  // Past the largest number a token holds none is handed out (refs.ts `MAX_NUMBER`): the results stop there, `more`
  // saying some were left out, and a file past it is shown with no number of its own.
  const results: Result[] = [];
  for (const { result, at, attachmentId } of shown) {
    const ref = scope.refs.message(at.conversationId, at.seq);
    if (ref === null) {
      more = true;
      break;
    }
    const fileRef = result.file && attachmentId !== null ? scope.refs.file(attachmentId, at) : null;
    const { file: _file, ...rest } = result;
    results.push({ ...rest, ref, ...(result.file && fileRef !== null ? { file: { ref: fileRef, name: result.file.name } } : {}) });
  }
  return { results, refs: shown.slice(0, results.length).map((d) => d.at), more };
}
