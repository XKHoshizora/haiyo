import type { FastifyBaseLogger } from "fastify";
import type { Config } from "../../config.ts";
import { visibleJoin } from "../../conversations/store.ts";
import type { Db, Queryable, Tx } from "../../db.ts";
import { inSearchBudget, searchRows, type SearchRow } from "../../messages/search.ts";
import { handleOf } from "../../principals/store.ts";
import type { Hub } from "../../sync/hub.ts";
import { createWhisper, roomForFoundElsewhere, whisperOfRun, type Whisper } from "../../whispers/store.ts";
import { QUOTE_MAX_CHARS } from "../runtime/context.ts";
import { cleanText, labelName, NO_GROUP_TITLE, TOOL_MATERIAL } from "../runtime/prompt.ts";
import { lockAgent } from "../store.ts";
import { siteDateTime } from "./clock.ts";
import type { ElsewhereAsk, RunScope } from "./index.ts";
import { withoutCitations } from "./refs.ts";
import { excerptAt, matchAt } from "./search.ts";

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
 * reply begins, each is read again under her access then (`readHits`): a hit she can no longer read is left out; with none
 * left it reads expired. Under the Agent's row (`lockAgent`, which takes the group's row first: the whisper lock order)
 * before `createWhisper`; a whisper `createWhisper` does not make (the Agent or its owner gone from the group, a body it
 * cannot keep) is none, and nothing is said of it. Pushed to the owner alone, once committed. Nothing found, or the switch
 * off: nothing — with the switch off, not even the query; nor with no room for a whisper (read before the query), nor while
 * `atOnce` lookups already run. The same words and filters the model gave the group's search (`ElsewhereAsk`). A failure is
 * logged by its kind only, never the words or anything found.
 */

/** The whisper's text (the brief's words). */
export const FOUND_ELSEWHERE = "群里有人问到的事，这个群里没有，但我在别处查到了。要告诉他们吗？";
/** What the run `告诉他们` queues is told to do with the hits (port-impl.ts `begin`). */
export const TELL_THEM = "主人让你把下面查到的内容告诉大家，用你自己的话简短地说。";
/** And what not to say: where it was found, who said it (it is not given either: `toldPassage`). */
export const TELL_HOW = "不要说是在哪里看到的，也不要说是谁说的。";
/** The person's turn its call ends with when the group shown ends with the Agent's own message (`ContextPlan.build`). */
export const TOLD_TURN = "（主人让你把上面资料里查到的内容告诉大家。）";
/** At most this many second queries run at once in the whole service (one hook per service); more are skipped. */
export const ELSEWHERE_AT_ONCE = 2;
/** Where a hit said in the Agent's own conversation was said, as the hit names it. */
export const OWN_PLACE = "我们的专属会话";
/** At most this many hits. */
export const ELSEWHERE_HITS_MAX = 5;
/** No new `found_elsewhere` whisper while its owner has this many there whose state is open or telling. */
export const ELSEWHERE_OPEN_MAX = 3;

/** One hit as its owner is shown it (read now: `readHits`), and as the run `告诉他们` queues is shown it (`toldPassage`). */
export interface ElsewhereHit {
  where: string;
  who: string;
  when: string;
  text: string;
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
  config: Pick<Config, "siteTimezone" | "searchStatementTimeoutMs">;
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
  if (!(await roomForFoundElsewhere(db, room, ELSEWHERE_OPEN_MAX))) return;
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
  const made = await db.tx((t) => whisperHits(t, scope, rows.map((row) => refOf(row, ask.term)), deps.log));
  if (made) deps.realtime.pushWhisper(made);
}

/** What the whisper keeps of a row: where it points, and where in its text (as a hit shows it) the words are. */
function refOf(row: SearchRow, term: string): HitRef {
  return { conversationId: row.conversation_id, seq: Number(row.seq), at: Math.max(0, matchAt(withoutCitations(row.text ?? ""), term)) };
}

/**
 * The whisper, in the group's transaction: the Agent's row first (`lockAgent`: the group's row, then the Agent's, for
 * update — before `createWhisper` takes them again), then the two caps: none when this reply already whispered (a
 * `found_elsewhere` whisper of the Agent there made since the run began: the Agent has one active reply there at most)
 * or when the owner has `ELSEWHERE_OPEN_MAX` open or telling there. It keeps the references and the message that asked:
 * the latest of the calls the run answers (those up to what it covers), else what it covers. Null: none made.
 */
async function whisperHits(t: Tx, scope: RunScope, hits: HitRef[], log: Pick<FastifyBaseLogger, "warn">): Promise<Whisper | null> {
  await lockAgent(t, scope.agentId, scope.conversationId);
  const room = await roomForFoundElsewhere(t, { ownerId: scope.ownerId, conversationId: scope.conversationId, agentId: scope.agentId, runId: scope.id }, ELSEWHERE_OPEN_MAX);
  if (!room) return null;
  const asked = await t.query<{ seq: string | null }>(
    "select coalesce((select max(c.s) from unnest(r.call_seqs) as c (s) where c.s <= r.covers_seq), r.covers_seq)::text as seq from agent_runs r where r.id = $1",
    [scope.id],
  );
  const askedSeq = asked.rows[0]?.seq == null ? null : Number(asked.rows[0].seq);
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

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Whether `h` is a reference as `refOf` keeps it (a reference of any other shape points at nothing). */
const isRef = (h: unknown): h is HitRef => {
  if (typeof h !== "object" || h === null) return false;
  const { conversationId, seq, at } = h as Record<string, unknown>;
  return typeof conversationId === "string" && UUID_SHAPE.test(conversationId) && Number.isSafeInteger(seq) && (seq as number) > 0 && Number.isSafeInteger(at) && (at as number) >= 0;
};

/** The references a `found_elsewhere` whisper's `detail` keeps (`{hits}`), in order; none when it keeps no list of them. */
export function refsOf(detail: unknown): HitRef[] {
  const hits = (detail as { hits?: unknown } | null | undefined)?.hits;
  return Array.isArray(hits) ? hits.filter(isRef).map(({ conversationId, seq, at }) => ({ conversationId, seq, at })) : [];
}

/** The message that asked, as a whisper's `detail` keeps it (`askedSeq`); null when it keeps none. */
export function askedOf(detail: unknown): number | null {
  const seq = (detail as { askedSeq?: unknown } | null | undefined)?.askedSeq;
  return Number.isSafeInteger(seq) && (seq as number) > 0 ? (seq as number) : null;
}

/**
 * Each wanted reference read as `readerId` may read it now — a current member of its conversation, the message after their
 * joining (`visibleJoin`, the rule every read of a message keeps), a text or file message — as a hit: where (a group's
 * title, `某个群` when it has none; `我们的专属会话` for the Agent's own), who (the sender's name as a label shows it), when
 * (in `timeZone`, the site's), and what — on one line, cut around the words as the search cut it (`excerptAt`), without any
 * citation, at most `QUOTE_MAX_CHARS` characters (a file message without text: its name). Null where it cannot be read.
 * One statement, whatever their number; in the order given.
 */
export async function readHits(q: Queryable, wanted: ReadonlyArray<{ readerId: string; ref: HitRef }>, timeZone: string): Promise<Array<ElsewhereHit | null>> {
  if (wanted.length === 0) return [];
  const { rows } = await q.query<{
    ord: string;
    created_at: Date;
    text: string | null;
    attachment: { name: string } | null;
    sender_name: string;
    sender_handle: string;
    title: string | null;
    conversation_type: string;
  }>(
    `select r.ord, m.created_at, m.body ->> 'text' as text, case when m.kind = 'file' then m.body -> 'attachment' end as attachment,
            sp.display_name as sender_name, ${handleOf("sp")} as sender_handle, c.title, c.type as conversation_type
       from unnest($1::uuid[], $2::uuid[], $3::bigint[]) with ordinality as r (reader_id, conversation_id, seq, ord)
       join messages m on m.conversation_id = r.conversation_id and m.seq = r.seq
       ${visibleJoin("r.reader_id")}
       join principals sp on sp.id = m.sender_id
       join conversations c on c.id = m.conversation_id
      where m.kind in ('text', 'file')`,
    [wanted.map((w) => w.readerId), wanted.map((w) => w.ref.conversationId), wanted.map((w) => w.ref.seq)],
  );
  const out: Array<ElsewhereHit | null> = wanted.map(() => null);
  for (const row of rows) {
    const i = Number(row.ord) - 1;
    const { date, time } = siteDateTime(row.created_at, timeZone);
    const said = Array.from(excerptAt(withoutCitations(row.text ?? ""), wanted[i]!.ref.at)).slice(0, QUOTE_MAX_CHARS).join("");
    out[i] = {
      where: row.conversation_type === "agent" ? OWN_PLACE : cleanText(withoutCitations(row.title ?? "")) || NO_GROUP_TITLE,
      who: labelName(row.sender_name, row.sender_handle),
      when: `${date} ${time}`,
      text: said !== "" ? said : row.attachment ? cleanText(row.attachment.name) : "",
    };
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
 * now, as its owner may read them now (`readHits`; times in `timeZone`) — those she can no longer read left out; [] when the
 * whisper is gone or none is left; null for any other reply.
 */
export async function toldHits(q: Queryable, runId: string, timeZone: string): Promise<ElsewhereHit[] | null> {
  const whisper = await whisperOfRun(q, runId);
  if (whisper === undefined) return null;
  if (whisper === null) return [];
  const read = await readHits(q, refsOf(whisper.body.detail).map((ref) => ({ readerId: whisper.ownerId, ref })), timeZone);
  return read.filter((h): h is ElsewhereHit => h !== null);
}
