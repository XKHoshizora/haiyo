import type { FastifyBaseLogger } from "fastify";
import type { Config } from "../../config.ts";
import type { Db, Queryable, Tx } from "../../db.ts";
import { inSearchBudget, searchRows, type SearchRow } from "../../messages/search.ts";
import type { Hub } from "../../sync/hub.ts";
import { createWhisper, foundElsewhereAbout, mayTell, readableHits, roomForFoundElsewhere, whisperOfRun, type HitRow, type Whisper } from "../../whispers/store.ts";
import { QUOTE_MAX_CHARS } from "../runtime/context.ts";
import { cleanText, foldVertical, labelName, NO_GROUP_TITLE, TOOL_MATERIAL } from "../runtime/prompt.ts";
import type { Mention } from "../../messages/model.ts";
import { lockAgent } from "../store.ts";
import { siteDateTime } from "./clock.ts";
import type { ElsewhereAsk, RunScope } from "./index.ts";
import { ELLIPSIS, excerptWindow, matchAt, shownOf } from "./search.ts";

/**
 * "Not in this group, but I have it elsewhere" (Task 8; design rules 17, 18, decision 9). A search of a reply in a group
 * that found nothing there starts this (`ToolDeps.elsewhere`, never awaited: tools/search.ts `lookElsewhere`), so nothing
 * here can change or delay what the reply's model is told — it is told the group's plain not-found, whatever is found here.
 * When the Agent's `whisperElsewhere` is on, the same words are looked for once more in the Agent's other conversations —
 * each one it is a current member of but this group, as the Agent sees it (VISIBLE_JOIN), and only what its owner can read
 * there now (a current member, a message after their joining): the owner is the one shown the hits; the late-joiner line of
 * another group's replies has nothing to do with it. At most `ELSEWHERE_HITS_MAX` hits, the newest. Hits become ONE
 * whisper to the owner in the group (`found_elsewhere`, `告诉他们` / `不用`) — at most one a reply, and none while the owner
 * has `ELSEWHERE_OPEN_MAX` there whose state is open or telling. The whisper keeps REFERENCES, never what was said (Redesign
 * D): for each hit the conversation and the message it points at, and where in it the words are (`HitRef`), and which
 * message of the group asked (`askedSeq`: the told reply quotes it). Whenever it is shown to its owner, and when its told
 * reply begins, each is read again under her access then (whispers/store.ts `readableHits`, `hitOf`): a hit she can no longer read is left out; with none
 * left it reads expired. Under the Agent's row (`lockAgent`, which takes the group's row first: the whisper lock order)
 * before `createWhisper`; a whisper `createWhisper` does not make (the Agent or its owner gone from the group, a body it
 * cannot keep) is none, and nothing is said of it. Pushed to the owner alone, once committed. Nothing found, or the switch
 * off: nothing — with the switch off, not even the query; nor with no room for a whisper (read before the query), nor while
 * `atOnce` lookups already run. The same words and filters the model gave the group's search (`ElsewhereAsk`). A failure is
 * logged by its kind only, never the words or anything found.
 */

/** The whisper's text: the system's words to the owner, never the Agent's first person (principle P2). */
export const FOUND_ELSEWHERE = "在别处查到了相关内容，要告诉他们吗？";
/** What the run `告诉他们` queues is told to do with the hits (port-impl.ts `begin`). */
export const TELL_THEM = "主人让你把下面查到的内容告诉大家，用你自己的话简短地说。";
/** And what not to say: where it was found, who said it (it is not given either: `toldPassage`). */
export const TELL_HOW = "不要说是在哪里看到的，也不要说是谁说的。";
/** At most this many second queries run at once in the whole service (one hook per service); more are skipped. */
export const ELSEWHERE_AT_ONCE = 2;
/** Where a hit said in the Agent's own conversation was said, as the hit names it. */
export const OWN_PLACE = "你和它的专属会话";
/** At most this many hits. */
export const ELSEWHERE_HITS_MAX = 5;
/** No new `found_elsewhere` whisper while its owner has this many there whose state is open or telling. */
export const ELSEWHERE_OPEN_MAX = 3;

/** One hit as its owner is shown it (read now: `hitOf`), and as the run `告诉他们` queues is shown it (`toldPassage`). */
export interface ElsewhereHit {
  where: string;
  who: string;
  when: string;
  text: string;
  /**
   * The message's mentions (as `WireMessage.mentions`: ranges of `text`, UTF-16 code units, ids of accounts), those that lie whole inside
   * the cut `text`; the owner's web draws the current display name for each. To its owner only, like the hit itself; never in the told
   * passage (`toldPassage` reads `when` and `text`). `[]` when none.
   */
  mentions: Mention[];
}

/**
 * What a whisper keeps of a hit: the message it points at (its conversation, its seq) and where the words are in its text
 * on one line (`at`, an index: what its excerpt is cut around when read). Never its text, a name or a title.
 */
export interface HitRef {
  conversationId: string;
  seq: number;
  at: number;
}

export interface ElsewhereDeps {
  db: Db;
  config: Pick<Config, "siteTimezone" | "searchStatementTimeoutMs" | "whispers">;
  realtime: Pick<Hub, "pushWhisper">;
  log: Pick<FastifyBaseLogger, "warn" | "error" | "info">;
}

/** The hook, and what tests wait on: every lookup it has started, settled. */
export type ElsewhereHook = ((scope: RunScope, ask: ElsewhereAsk) => Promise<void>) & { idle(): Promise<void> };

/**
 * The hook (`ToolDeps.elsewhere`). At most `atOnce` lookups at a time (default `ELSEWHERE_AT_ONCE`; a bound of its own,
 * apart from the search slots, which are the model's): one more while they run is skipped — nobody is told either way;
 * it is counted (`elsewhere_skipped`, one log line, nothing of what was asked).
 */
export function createElsewhere(deps: ElsewhereDeps, { atOnce = ELSEWHERE_AT_ONCE }: { atOnce?: number } = {}): ElsewhereHook {
  const running = new Set<Promise<void>>();
  const hook = (scope: RunScope, ask: ElsewhereAsk): Promise<void> => {
    if (running.size >= atOnce) {
      // One counter line (no words, nothing found): how often the bound holds a lookup back.
      deps.log.info({ metric: "elsewhere_skipped", runId: scope.id }, "found elsewhere: a lookup was skipped, as many as may run at once already were");
      return Promise.resolve();
    }
    const done = lookFor(deps, scope, ask).catch((err: unknown) =>
      deps.log.warn({ runId: scope.id, kind: (err as { name?: unknown } | null)?.name ?? typeof err }, "found elsewhere: the lookup failed"),
    );
    running.add(done);
    void done.finally(() => running.delete(done));
    return done;
  };
  return Object.assign(hook, {
    async idle(): Promise<void> {
      while (running.size > 0) await Promise.all([...running]);
    },
  });
}

/**
 * The whole of one lookup: the switch; the caps (read first, so a reply that whispered already, or an owner with 3 open
 * there, costs no query — and read again under the lock); the query, with the words and the filters the model gave the
 * group's search; then the whisper, keeping where each hit is.
 */
async function lookFor(deps: ElsewhereDeps, scope: RunScope, ask: ElsewhereAsk): Promise<void> {
  const { db, config } = deps;
  const on = await db.query<{ on: boolean }>("select whisper_elsewhere as on from agents where principal_id = $1", [scope.agentId]);
  if (on.rows[0]?.on !== true) return;
  const room = { ownerId: scope.ownerId, conversationId: scope.conversationId, agentId: scope.agentId, runId: scope.id };
  const ttlHours = config.whispers.elsewhereTtlHours;
  if (!(await roomForFoundElsewhere(db, room, ELSEWHERE_OPEN_MAX, ttlHours))) return;
  const rows = await inSearchBudget(db, config.searchStatementTimeoutMs, async (t) => {
    const { rows: places } = await t.query<{ id: string }>(
      `select am.conversation_id as id from memberships am
        where am.principal_id = $1 and am.left_seq is null and am.conversation_id <> $2
          and exists (select 1 from memberships om where om.conversation_id = am.conversation_id and om.principal_id = $3 and om.left_seq is null)
        order by am.conversation_id`,
      [scope.agentId, scope.conversationId, scope.ownerId],
    );
    if (places.length === 0) return [];
    return searchRows(t, scope.agentId, {
      conversationIds: places.map((p) => p.id),
      term: ask.term,
      from: ask.from,
      before: ask.before,
      after: ask.after,
      timeZone: config.siteTimezone,
      window: null,
      alsoVisibleTo: scope.ownerId,
      limit: ELSEWHERE_HITS_MAX,
    });
  });
  if (rows.length === 0) return;
  const made = await db.tx((t) => whisperHits(t, scope, rows.map((row) => refOf(row, ask.term)), ttlHours, deps.log));
  if (made) deps.realtime.pushWhisper(made);
}

/**
 * A hit's text as it is cut and shown: the one place both where the words are (`refOf`, when the whisper is made) and the
 * cut around them (`hitOf`, whenever it is read) start from — so whatever is changed in it changes both alike and a kept
 * `at` stays where the words are. It is the stored text as it is: a message's text never holds a citation (its cites are
 * stored beside it, agents/tools/refs.ts; a reply of nothing but token-shaped strings keeps them as text, citing nothing:
 * conversation.ts `postAsAgent`), so nothing is taken out of it.
 */
const hitLine = (text: string | null): string => text ?? "";

/** What the whisper keeps of a row: where it points, and where in its text (as a hit shows it) the words are. */
function refOf(row: SearchRow, term: string): HitRef {
  return { conversationId: row.conversation_id, seq: Number(row.seq), at: Math.max(0, matchAt(hitLine(row.text), term)) };
}

/**
 * The whisper, in the group's transaction: the Agent's row first (`lockAgent`: the group's row, then the Agent's, for
 * update — before `createWhisper` takes them again), then the two caps: none when this reply already whispered (a
 * `found_elsewhere` whisper of the Agent there made since the run began: the Agent has one active reply there at most)
 * or when the owner has `ELSEWHERE_OPEN_MAX` open or telling there; nor when a whisper of the Agent there keeps the same
 * message as the one that asked (a retry of the reply — the system's, after a failure — asks no second time about one
 * question). It keeps the references and the message that asked: the latest of the calls the run answers (those up to
 * what it covers), else what it covers. Null: none made.
 */
async function whisperHits(t: Tx, scope: RunScope, hits: HitRef[], ttlHours: number, log: Pick<FastifyBaseLogger, "warn">): Promise<Whisper | null> {
  await lockAgent(t, scope.agentId, scope.conversationId);
  const room = await roomForFoundElsewhere(t, { ownerId: scope.ownerId, conversationId: scope.conversationId, agentId: scope.agentId, runId: scope.id }, ELSEWHERE_OPEN_MAX, ttlHours);
  if (!room) return null;
  const asked = await t.query<{ seq: string | null }>(
    "select coalesce((select max(c.s) from unnest(r.call_seqs) as c (s) where c.s <= r.covers_seq), r.covers_seq)::text as seq from agent_runs r where r.id = $1",
    [scope.id],
  );
  const askedSeq = asked.rows[0]?.seq == null ? null : Number(asked.rows[0].seq);
  if (askedSeq !== null && (await foundElsewhereAbout(t, { ownerId: scope.ownerId, conversationId: scope.conversationId, agentId: scope.agentId }, askedSeq))) return null;
  return createWhisper(
    t,
    {
      conversationId: scope.conversationId,
      ownerId: scope.ownerId,
      agentId: scope.agentId,
      kind: "found_elsewhere",
      body: { text: FOUND_ELSEWHERE, actions: ["tell", "dismiss"], detail: { hits, ...(askedSeq === null ? {} : { askedSeq }) } },
    },
    log,
  );
}

/** The message that asked, as a whisper's `detail` keeps it (`askedSeq`); null when it keeps none. */
export function askedOf(detail: unknown): number | null {
  const seq = (detail as { askedSeq?: unknown } | null | undefined)?.askedSeq;
  return Number.isSafeInteger(seq) && (seq as number) > 0 ? (seq as number) : null;
}

/**
 * A hit as its owner is shown it, from what whispers/store.ts `readableHits` read of its message (under her access now,
 * the one rule): where (a group's title, `某个群` when it has none; `你和它的专属会话` for the Agent's own), who (the sender's name
 * as a label shows it), when (in `timeZone`, the site's), and what — on one line, cut around the words as the search cut
 * it (`excerptAt` at the kept `at`, from the same `hitLine` the place was found in), at most `QUOTE_MAX_CHARS` characters
 * (a file message without text: its name).
 */
export function hitOf(row: HitRow, timeZone: string): ElsewhereHit {
  const { date, time } = siteDateTime(row.createdAt, timeZone);
  const source = hitLine(row.text);
  const window = excerptWindow(source, row.at);
  const said = Array.from(shownOf(window)).slice(0, QUOTE_MAX_CHARS).join("");
  return {
    where: row.conversationType === "agent" ? OWN_PLACE : cleanText(row.title ?? "") || NO_GROUP_TITLE,
    who: labelName(row.senderName, row.senderHandle),
    when: `${date} ${time}`,
    text: said !== "" ? said : row.attachmentName ? cleanText(row.attachmentName) : "",
    mentions: said === "" ? [] : mentionsInHit(source, window, said, row.mentions),
  };
}

/**
 * The mentions of a hit's message that lie whole inside what the hit shows, moved to where they are in its `said`: through the one-line
 * folding (a run of vertical space is one space, the ends trimmed), the window the excerpt cut (`excerptWindow`: the same numbers the
 * text was cut by) and the ellipsis before it, then clipped to the characters kept (`QUOTE_MAX_CHARS`). A range cut by any of them is left out
 * (that name shows as typed, as a mention of someone who cannot be named does).
 */
function mentionsInHit(source: string, window: { line: string; start: number; end: number; head: boolean }, said: string, mentions: Mention[] | null): Mention[] {
  if (!mentions || mentions.length === 0) return [];
  const folded = foldVertical(source);
  const lead = folded.length - folded.trimStart().length;
  const offset = window.head ? ELLIPSIS.length : 0;
  const out: Mention[] = [];
  for (const m of mentions) {
    if (!Number.isSafeInteger(m.start) || !Number.isSafeInteger(m.length) || m.start < 0 || m.length < 1 || m.start + m.length > source.length) continue;
    const from = foldVertical(source.slice(0, m.start)).length - lead;
    const length = foldVertical(source.slice(m.start, m.start + m.length)).length;
    if (from < window.start || from + length > window.end) continue;
    const start = from - window.start + offset;
    if (start + length > said.length) continue;
    out.push({ id: m.id, start, length });
  }
  return out;
}

/** `text` with no `@` that would call someone (agents/mentions.ts's rule): `@mia_bot` → `mia_bot`. */
const uncalled = (text: string): string => text.replace(/(?<![A-Za-z0-9_])@(?=[A-Za-z0-9_])/g, "");

/**
 * What the run `告诉他们` queued is told in its system text: what to do, what not to say, that the hits are material, and
 * the hits — each its time and its text only (Task 8 fix 1, I-1): never where it was said or who said it (the whisper
 * shows those to the owner alone), so the group cannot learn another group's name, the owner's private chat, or a
 * stranger's name; and no `@` in a text, so telling it calls nobody here.
 */
export function toldPassage(hits: readonly ElsewhereHit[]): string {
  return [TELL_THEM, TELL_HOW, TOOL_MATERIAL, JSON.stringify({ hits: hits.map(({ when, text }) => ({ when, text: uncalled(text) })) })].join("\n");
}

/**
 * The hits reply run `runId` is to tell, when `告诉他们` queued it (`agent_runs.whisper_id`): its whisper's references read
 * now, as its owner may read them now — those she can no longer read left out; [] when the whisper is gone, when it is one
 * no told reply may tell (whispers/store.ts `mayTell`, the one rule: declined, expired, told — with this run its own
 * telling, a day may have passed), or none is left; null for any other reply.
 */
export async function toldHits(q: Queryable, runId: string, { timeZone, elsewhereTtlHours }: { timeZone: string; elsewhereTtlHours: number }): Promise<ElsewhereHit[] | null> {
  const whisper = await whisperOfRun(q, runId);
  if (whisper === undefined) return null;
  if (whisper === null) return [];
  if (!(await mayTell(q, whisper, { ttlHours: elsewhereTtlHours, ownRunId: runId })).may) return [];
  return (await readableHits(q, [whisper.id])).map((row) => hitOf(row, timeZone));
}
