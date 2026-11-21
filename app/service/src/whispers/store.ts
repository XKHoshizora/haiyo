import type { FastifyBaseLogger } from "fastify";
import { cleanText } from "../agents/runtime/prompt.ts";
import { DEFAULT_WHISPERS } from "../config.ts";
import { lockConversation, visibleJoin } from "../conversations/store.ts";
import type { Queryable, Tx } from "../db.ts";
import { weight } from "../metering/tokens.ts";

/**
 * Whispers (悄悄话, design rules 16 and 19): a small note in a conversation that only the owner of one of its Agents ever
 * sees, with the buttons it offers (`告诉他们` → accepted, `不用` → declined). It is never a message: it takes no seq —
 * message seqs are gapless, and every other member would see a gap — and sits after the message that was the
 * conversation's last when it was made (`afterSeq`). So nothing that reads messages (history, sync's messages, catch-up's
 * messages, search, unread, `lastSeq`, the Agent's model context) can ever meet one; the owner alone reads them, through
 * the functions here, by their own id (`owner_id = <reader>` in every statement), and only those of their current stay in
 * the conversation (`after_seq >= joined_seq` of their current membership, the seq the message visibility rule starts at).
 *
 * A whisper is open until its owner answers it (`resolveWhisper`, once), it is 7 days old (`expireWhispers`, the periodic
 * sweep; a `found_elsewhere` one a day, `WHISPERS.elsewhereTtlHours`), its owner or its Agent leaves the conversation
 * (`expireOnLeave`), or its Agent is deleted (`expireOfAgent`); it goes with the conversation's, the owner's or the Agent's
 * row, and an answered or expired one is deleted 30 days after it was made (`removeOldWhispers`, the same sweep). Nothing
 * here reads, logs or returns a whisper's text to anyone but its owner.
 *
 * A `found_elsewhere` whisper (Redesign D) stores `open`, `declined` or `expired` only — never `accepted` (migration 061):
 * what its owner reads of it is derived from its told replies (`agent_runs.whisper_id`). It is told only because a posted
 * message of a told reply of it exists (the message whose `client_txn` is that run's id); telling while a told reply of it
 * is queued or running; otherwise open — with `lastTellFailed` once one ended without posting — unless none of the messages
 * it found (its references, agents/tools/elsewhere.ts) can be read by its owner now: then it reads expired. Nothing about a
 * tell is ever written to the whisper, so a tell that posts nothing leaves nothing to repair: it simply reads open again.
 *
 * Lock order, one rule for everything here and for whatever calls it: the conversation's row → the Agent's `agents` row
 * (`createWhisper` takes it for share, `resolveWhisper` for update) → run rows → `accounts` rows (runs.ts's order) → whisper
 * rows, always last. `createWhisper` and `resolveWhisper` take the conversation's row and the Agent's before they insert or
 * lock a whisper; the delete (agents/routes.ts) and leaving (conversations/groups.ts, agents/group-leave.ts) expire whisper
 * rows after everything else they lock; the sweep never waits for a row (`skip locked`) and takes what it can in id order.
 * An answer's hook (whispers/routes.ts) runs with its whisper's row held and may then lock the Agent's row (already its
 * answer's, for update), run rows and accounts: the Agent's row, which `resolveWhisper` holds before the whisper's, keeps out
 * the one transaction that takes those and then this whisper's row (the Agent's delete), and any other answer about the
 * same Agent; other conversations' leavings take other whisper rows.
 */

export const WHISPER_KINDS = ["found_elsewhere", "tools_off", "memory", "allowance"] as const;
export type WhisperKind = (typeof WHISPER_KINDS)[number];
/** What a whisper's row stores (a `found_elsewhere` one never `accepted`: migration 061). */
export const WHISPER_STATUSES = ["open", "accepted", "declined", "expired"] as const;
export type WhisperStatus = (typeof WHISPER_STATUSES)[number];
/** What its owner reads (whispers/wire.ts): the stored status, or for a `found_elsewhere` one its derived state. */
export const WIRE_STATUSES = ["open", "telling", "told", "accepted", "declined", "expired"] as const;
export type WireStatus = (typeof WIRE_STATUSES)[number];
/**
 * The buttons a whisper may offer: `tell` (告诉他们) answers it `accepted` — a `found_elsewhere` one stores nothing for it, its
 * told reply is queued instead (whispers/routes.ts) —, `dismiss` (不用) `declined`.
 */
export const WHISPER_ACTIONS = ["tell", "dismiss"] as const;
export type WhisperAction = (typeof WHISPER_ACTIONS)[number];
export type WhisperAnswer = "accepted" | "declined";
const BUTTON_OF: Record<WhisperAnswer, WhisperAction> = { accepted: "tell", declined: "dismiss" };

/** The longest whisper text, in weight (metering/tokens.ts `weight`), once cleaned. */
export const WHISPER_TEXT_MAX = 2000;
/**
 * The largest `detail`, in bytes of its JSON text (utf-8): it goes out whole in every push, sync, catch-up and list page
 * that carries its whisper.
 */
export const WHISPER_DETAIL_MAX = 8192;
/** How deep a `detail` may nest (it counts 1), and how many values it may hold in all (itself included). */
const DETAIL_DEPTH_MAX = 6;
const DETAIL_VALUES_MAX = 200;
/** An open whisper this many days old is expired by the sweep (a `found_elsewhere` one: `WHISPERS.elsewhereTtlHours`). */
export const WHISPER_OPEN_DAYS = 7;
/** An answered or expired whisper this many days old (from when it was made) is deleted by the sweep. */
export const WHISPER_KEEP_DAYS = 30;
/** A sweep works through at most `WHISPER_SWEEP_BATCHES` batches of `WHISPER_SWEEP_BATCH` rows (for each of its two jobs); what is left waits for the next run. */
export const WHISPER_SWEEP_BATCH = 500;
export const WHISPER_SWEEP_BATCHES = 20;
/** At most this many whispers go with one sync or catch-up answer: every live one first, then the newest others. */
export const WHISPERS_PER_ANSWER = 500;
/** A page of the list route adds at most this many whispers of the place its last one sits at (the rest of that place). */
export const WHISPERS_PER_PLACE = 100;

/** What a whisper says: its text, its buttons and what a later task keeps with it (`detail`). */
export interface WhisperBody {
  text: string;
  actions: WhisperAction[];
  detail?: unknown;
}

export interface Whisper {
  id: string;
  conversationId: string;
  ownerId: string;
  agentId: string;
  /** The conversation's last seq when it was made: it shows after that message. */
  afterSeq: number;
  kind: WhisperKind;
  body: WhisperBody;
  /** As stored (a `found_elsewhere` one's state is derived when it is read: whispers/wire.ts `wireWhispers`). */
  status: WhisperStatus;
  createdAt: Date;
  resolvedAt: Date | null;
}

interface WhisperRow {
  id: string;
  conversation_id: string;
  owner_id: string;
  agent_id: string;
  after_seq: string;
  kind: WhisperKind;
  body: WhisperBody;
  status: WhisperStatus;
  created_at: Date;
  resolved_at: Date | null;
}

const columns = (alias: string): string =>
  ["id", "conversation_id", "owner_id", "agent_id", "after_seq", "kind", "body", "status", "created_at", "resolved_at"].map((c) => `${alias}.${c}`).join(", ");
const COLUMNS = columns("whispers");

const toWhisper = (r: WhisperRow): Whisper => ({
  id: r.id,
  conversationId: r.conversation_id,
  ownerId: r.owner_id,
  agentId: r.agent_id,
  afterSeq: Number(r.after_seq),
  kind: r.kind,
  body: r.body,
  status: r.status,
  createdAt: r.created_at,
  resolvedAt: r.resolved_at,
});

// ───────── what a `found_elsewhere` whisper's state is derived from (Redesign D)

/** SQL: a told reply of whisper `w` (an alias) has posted its reply — the whisper is told. */
const toldSql = (w: string): string =>
  `exists (select 1 from agent_runs tr join messages tm on tm.conversation_id = tr.conversation_id and tm.sender_id = tr.agent_id and tm.client_txn = tr.id::text
            where tr.whisper_id = ${w}.id and tr.owner_id = ${w}.owner_id)`;
/** SQL: a told reply of whisper `w` is queued or running — the whisper is telling (an Agent has one such run there at most). */
const tellingSql = (w: string): string =>
  `exists (select 1 from agent_runs tr where tr.whisper_id = ${w}.id and tr.owner_id = ${w}.owner_id and tr.status in ('queued', 'running'))`;
const UUID_SHAPE = `'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'`;
/**
 * SQL: one of the messages whisper `w` found (its `detail.hits`, each `{conversationId, seq}`: agents/tools/elsewhere.ts) is
 * one its owner can read now — a current member there, the message after their joining (`visibleJoin`: the rule every read
 * of a message keeps, and the one `readHits` reads them by). A reference of another shape points at nothing.
 */
const readableHitSql = (w: string): string =>
  `exists (select 1 from jsonb_array_elements(case when jsonb_typeof(${w}.body -> 'detail' -> 'hits') = 'array' then ${w}.body -> 'detail' -> 'hits' else '[]'::jsonb end) as h (ref)
             cross join lateral (select ${w}.owner_id as reader_id) as r
             join messages m on m.conversation_id = case when jsonb_typeof(h.ref -> 'conversationId') = 'string' and (h.ref ->> 'conversationId') ~ ${UUID_SHAPE} then (h.ref ->> 'conversationId')::uuid end
                            and m.seq = case when jsonb_typeof(h.ref -> 'seq') = 'number' and (h.ref ->> 'seq') ~ '^[1-9][0-9]{0,15}$' then (h.ref ->> 'seq')::bigint end
             ${visibleJoin("r.reader_id")}
            where m.kind in ('text', 'file'))`;
/**
 * SQL: whisper `w` is still live for its owner — open; a `found_elsewhere` one open or telling. What sync and catch-up
 * always carry, and what that kind's cap counts.
 */
const liveSql = (w: string): string =>
  `(${w}.status = 'open' and (${w}.kind <> 'found_elsewhere' or (not ${toldSql(w)} and (${tellingSql(w)} or ${readableHitSql(w)}))))`;
/**
 * SQL: whisper `w` waits for its owner's answer — open and offering a button; a `found_elsewhere` one neither told nor
 * telling, with a hit its owner can read. The conversation entry's `whispers: n` (sync/read.ts).
 */
export const waitingSql = (w: string): string =>
  `(${w}.status = 'open' and jsonb_array_length(${w}.body -> 'actions') > 0
    and (${w}.kind <> 'found_elsewhere' or (not ${toldSql(w)} and not ${tellingSql(w)} and ${readableHitSql(w)})))`;
/** SQL: whisper `w` is not a told `found_elsewhere` one (told is final: nothing expires it). */
const notTold = (w: string): string => `(${w}.kind <> 'found_elsewhere' or not ${toldSql(w)})`;

/** What the told replies of a `found_elsewhere` whisper say of it now. */
export interface TellState {
  /** How many told replies it has had. */
  runs: number;
  /** One of them is queued or running. */
  telling: boolean;
  /** One of them posted its reply. */
  told: boolean;
}
export const NO_TELL: Readonly<TellState> = Object.freeze({ runs: 0, telling: false, told: false });

/** The told replies of each of `whispers` (their owner's runs only), as they are now, by whisper id: one statement. */
export async function tellStates(q: Queryable, whispers: ReadonlyArray<Pick<Whisper, "id" | "ownerId">>): Promise<Map<string, TellState>> {
  const out = new Map<string, TellState>();
  if (whispers.length === 0) return out;
  const { rows } = await q.query<{ id: string; runs: number; telling: boolean; told: boolean }>(
    `select w.id, count(r.id)::int as runs, coalesce(bool_or(r.status in ('queued', 'running')), false) as telling,
            coalesce(bool_or(exists (select 1 from messages m where m.conversation_id = r.conversation_id and m.sender_id = r.agent_id and m.client_txn = r.id::text)), false) as told
       from unnest($1::uuid[], $2::uuid[]) as w (id, owner_id)
       left join agent_runs r on r.whisper_id = w.id and r.owner_id = w.owner_id
      group by w.id`,
    [whispers.map((w) => w.id), whispers.map((w) => w.ownerId)],
  );
  for (const r of rows) out.set(r.id, { runs: r.runs, telling: r.telling, told: r.told });
  return out;
}

/** `ownerId`'s whispers among `ids`, as stored (the hub reads the one it pushes when it delivers it). */
export async function readWhispers(q: Queryable, ownerId: string, ids: readonly string[]): Promise<Whisper[]> {
  if (ids.length === 0) return [];
  const { rows } = await q.query<WhisperRow>(`select ${COLUMNS} from whispers where owner_id = $1 and id = any($2::uuid[])`, [ownerId, ids]);
  return rows.map(toWhisper);
}

/** Why a body that is one in shape cannot be kept (content-free: what a refusal's warning says). */
type Refusal = "text_too_long" | "detail_too_large" | "detail_too_deep" | "unstorable";

/** A lone surrogate: a high one not followed by a low one, or a low one not after a high one (UTF-16 code units). */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
/** A string Postgres can keep in `jsonb`: no U+0000, no lone surrogate. */
const storable = (s: string): boolean => !s.includes("\u0000") && !LONE_SURROGATE.test(s);

/**
 * Why `value` (parsed JSON, at `depth`; the detail itself is 1) cannot be kept, or null: deeper than `DETAIL_DEPTH_MAX`, more
 * than `DETAIL_VALUES_MAX` values in all (`seen` counts them), a string (a key too) that is not storable. Stops at the first.
 */
function detailRefusal(value: unknown, depth: number, seen: { values: number }): Refusal | null {
  if (depth > DETAIL_DEPTH_MAX) return "detail_too_deep";
  if (++seen.values > DETAIL_VALUES_MAX) return "detail_too_large";
  if (typeof value === "string") return storable(value) ? null : "unstorable";
  const entries: Array<[string | null, unknown]> = Array.isArray(value)
    ? value.map((v) => [null, v])
    : value !== null && typeof value === "object"
      ? Object.entries(value)
      : [];
  for (const [key, v] of entries) {
    if (key !== null && !storable(key)) return "unstorable";
    const refused = detailRefusal(v, depth + 1, seen);
    if (refused) return refused;
  }
  return null;
}

/**
 * The body as it is stored, a refusal (a body that is one in shape but cannot be kept), or null when it is no body at all:
 * not an object, a text that is no string or empty once cleaned, buttons that are not a subset of `tell` and `dismiss`, each once.
 */
function checkBody(raw: unknown): { body: WhisperBody } | { refused: Refusal } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { text, actions, detail } = raw as Record<string, unknown>;
  if (typeof text !== "string" || !Array.isArray(actions)) return null;
  if (!actions.every((a): a is WhisperAction => (WHISPER_ACTIONS as readonly unknown[]).includes(a)) || new Set(actions).size !== actions.length) return null;
  if (!storable(text)) return { refused: "unstorable" };
  const clean = cleanText(text);
  if (clean === "") return null;
  if (weight(clean) > WHISPER_TEXT_MAX) return { refused: "text_too_long" };
  if (detail === undefined) return { body: { text: clean, actions: [...actions] } };
  let json: string | undefined;
  try {
    json = JSON.stringify(detail);
  } catch {
    return { refused: "unstorable" }; // a cycle, a bigint: not JSON
  }
  if (json === undefined) return { body: { text: clean, actions: [...actions] } };
  if (Buffer.byteLength(json, "utf8") > WHISPER_DETAIL_MAX) return { refused: "detail_too_large" };
  const parsed = JSON.parse(json) as unknown;
  const refused = detailRefusal(parsed, 1, { values: 0 });
  if (refused) return { refused };
  return { body: { text: clean, actions: [...actions], detail: parsed } };
}

/**
 * A whisper's body as it is stored, or null when it is none or cannot be kept: the text cleaned as notices and notes are
 * (`cleanText`: one line, no invisible format or control characters, trimmed), not empty and at most `WHISPER_TEXT_MAX`
 * weight; the buttons a subset of `tell` and `dismiss`, each once; `detail` kept as its JSON says it (absent when it has
 * none), at most `WHISPER_DETAIL_MAX` bytes of JSON, nested at most 6 deep, at most 200 values. No string in the text or
 * the detail (keys too) may hold U+0000 or a lone surrogate (Postgres would refuse it). Nothing else of what is given is kept.
 */
export function whisperBody(raw: unknown): WhisperBody | null {
  const checked = checkBody(raw);
  return checked && "body" in checked ? checked.body : null;
}

/**
 * A new open whisper of `ownerId` about their Agent `agentId` in `conversationId`, after the conversation's last seq —
 * under the conversation's row (taken here, `lockConversation`) and then the Agent's (`for share`, so a delete in flight is
 * waited for and then seen), so no message, leaving, delete or answer comes between that seq, the checks and the insert.
 * Null, and nothing stored, unless the conversation exists, `ownerId` is a current member of it, and `agentId` is their
 * Agent (not deleted) and a current member of it too. Null too — before anything is read or written, so the caller's
 * transaction goes on — for a body that cannot be kept (too long a text, too large or deep a detail, a string Postgres
 * would refuse: `whisperBody`), with one warning on `log` that names the kind and nothing of the body. A body that is no
 * body at all (`whisperBody`'s shape) or an unknown kind is the caller's mistake: it throws. The caller pushes it to the
 * owner once committed (`Hub.pushWhisper`).
 */
export async function createWhisper(
  t: Tx,
  w: { conversationId: string; ownerId: string; agentId: string; kind: WhisperKind; body: WhisperBody },
  log?: Pick<FastifyBaseLogger, "warn">,
): Promise<Whisper | null> {
  if (!(WHISPER_KINDS as readonly string[]).includes(w.kind)) throw new Error("createWhisper: not a whisper kind");
  const checked = checkBody(w.body);
  if (!checked) throw new Error("createWhisper: the whisper body is not one (a text that is not empty once cleaned, buttons among tell and dismiss, each once)");
  if ("refused" in checked) {
    log?.warn({ kind: w.kind, reason: checked.refused }, "a whisper was not made: its body cannot be kept");
    return null;
  }
  const { body } = checked;
  const conversation = await lockConversation(t, w.conversationId);
  if (!conversation) return null;
  // The Agent's row next (the lock order): a delete in flight is waited for, and the insert's checks then see it.
  await t.query("select 1 from agents where principal_id = $1 for share", [w.agentId]);
  const { rows } = await t.query<WhisperRow>(
    `insert into whispers (conversation_id, owner_id, agent_id, after_seq, kind, body)
     select $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::text, $6::jsonb
      where exists (select 1 from memberships me where me.conversation_id = $1 and me.principal_id = $2 and me.left_seq is null)
        and exists (
          select 1 from memberships am
            join agents a on a.principal_id = am.principal_id
            join principals p on p.id = am.principal_id
           where am.conversation_id = $1 and am.principal_id = $3 and am.left_seq is null and a.deleted_at is null and p.owner_id = $2)
     returning ${COLUMNS}`,
    [conversation.id, w.ownerId, w.agentId, conversation.seq, w.kind, JSON.stringify(body)],
  );
  return rows[0] ? toWhisper(rows[0]) : null;
}

/**
 * Whether one more `found_elsewhere` whisper of `ownerId` may be made in `conversationId` for Agent `agentId`'s reply run
 * `runId` (Task 8, agents/tools/elsewhere.ts): not when that reply has made one already (a `found_elsewhere` whisper of the
 * Agent there made since the run began: an Agent has one reply under way there at most), nor while the owner has `openMax`
 * there whose state is open or telling (`liveSql`: a told one, or one with no hit left to read, takes no room). Read once
 * before the lookup's query (so a lookup with no room costs none), and again in the whisper's transaction, under the
 * Agent's row it has locked (so two of one reply are one after the other); it locks nothing itself.
 */
export async function roomForFoundElsewhere(
  t: Queryable,
  w: { ownerId: string; conversationId: string; agentId: string; runId: string },
  openMax: number,
): Promise<boolean> {
  const { rows } = await t.query<{ mine: boolean; open: number }>(
    `select exists (select 1 from whispers w join agent_runs r on r.id = $4
                     where w.owner_id = $1 and w.conversation_id = $2 and w.agent_id = $3 and w.kind = 'found_elsewhere'
                       and w.created_at >= coalesce(r.started_at, r.created_at)) as mine,
            (select count(*)::int from whispers w
              where w.owner_id = $1 and w.conversation_id = $2 and w.kind = 'found_elsewhere' and ${liveSql("w")}) as open`,
    [w.ownerId, w.conversationId, w.agentId, w.runId],
  );
  return rows[0]?.mine === false && (rows[0]?.open ?? 0) < openMax;
}

/**
 * The whisper reply run `runId` was queued to tell (`agent_runs.whisper_id`, Task 8's `告诉他们`), read as the run's owner
 * (`owner_id = r.owner_id`): undefined when the run was queued for none; null when its whisper is gone (deleted 30 days
 * after it was made). What its told reply is shown and quotes is read from it (agents/tools/elsewhere.ts `toldHits`,
 * agents/conversation.ts `postAsAgent`).
 */
export async function whisperOfRun(q: Queryable, runId: string): Promise<Whisper | null | undefined> {
  const { rows } = await q.query<{ told_id: string | null } & { [K in keyof WhisperRow]: WhisperRow[K] | null }>(
    `select r.whisper_id as told_id, ${columns("w")}
       from agent_runs r left join whispers w on w.id = r.whisper_id and w.owner_id = r.owner_id
      where r.id = $1`,
    [runId],
  );
  const row = rows[0];
  if (!row || row.told_id === null) return undefined;
  return row.id === null ? null : toWhisper(row as WhisperRow);
}

/**
 * The owner's answer to their whisper `id`: `accepted` (its `tell` button) or `declined` (its `dismiss`). Changes its status
 * and nothing else (what an answer does for a kind is the caller's, whispers/routes.ts `ANSWER_HOOKS`). "gone" when there is
 * no whisper `id` of `ownerId`'s — anyone else's and none are found by the same single read —, and as well when its Agent
 * is deleted or it or its owner is no longer a current member of the conversation (whatever expired it or not); "stale"
 * when it is not open any more, or does not offer that answer's button. A `found_elsewhere` one is answered only while its
 * derived state is open: "busy" while it is telling (a told reply of it queued or running), "stale" once it is told or
 * when none of what it found can be read by its owner now (it reads expired); and `accepted` stores nothing — the told
 * reply its hook queues is what makes it telling (Redesign D), so a tell that posts nothing leaves it open, to answer again.
 * Takes, in the lock order, the conversation's row, the Agent's (`for update`: what an answer's hook will lock next, held
 * from here, so a delete in flight is waited for before the whisper's row is taken, and two answers about one Agent never
 * both hold it and then wait to strengthen it), then the whisper's. A told reply posts under the conversation's row, held
 * here from the first read: whether it has posted cannot change before this answer commits.
 */
export async function resolveWhisper(t: Tx, ownerId: string, id: string, to: WhisperAnswer): Promise<Whisper | "gone" | "stale" | "busy"> {
  const found = await t.query<{ conversation_id: string; agent_id: string }>("select conversation_id, agent_id from whispers where id = $1 and owner_id = $2", [id, ownerId]);
  if (!found.rows[0]) return "gone";
  const { conversation_id: conversationId, agent_id: agentId } = found.rows[0];
  await lockConversation(t, conversationId);
  const agent = await t.query<{ deleted: boolean }>("select deleted_at is not null as deleted from agents where principal_id = $1 for update", [agentId]);
  const { rows } = await t.query<WhisperRow>(`select ${COLUMNS} from whispers where id = $1 and owner_id = $2 for update`, [id, ownerId]);
  const row = rows[0];
  if (!row || agent.rows[0]?.deleted !== false) return "gone";
  // Both still where it was made (under the conversation's row, which every leaving takes).
  const present = await t.query<{ n: number }>(
    "select count(*)::int as n from memberships where conversation_id = $1 and principal_id = any($2::uuid[]) and left_seq is null",
    [conversationId, [ownerId, agentId]],
  );
  if (present.rows[0]?.n !== 2) return "gone";
  if (row.status !== "open" || !Array.isArray(row.body.actions) || !row.body.actions.includes(BUTTON_OF[to])) return "stale";
  if (row.kind === "found_elsewhere") {
    const now = await t.query<{ told: boolean; telling: boolean; readable: boolean }>(
      `select ${toldSql("w")} as told, ${tellingSql("w")} as telling, ${readableHitSql("w")} as readable from whispers w where w.id = $1`,
      [id],
    );
    const { told, telling, readable } = now.rows[0]!;
    if (told) return "stale";
    if (telling) return "busy";
    if (!readable) return "stale";
    // 告诉他们 stores nothing: the told reply its hook queues is what the whisper's state is read from.
    if (to === "accepted") return toWhisper(row);
  }
  const updated = await t.query<WhisperRow>(`update whispers set status = $2, resolved_at = now() where id = $1 returning ${COLUMNS}`, [id, to]);
  return toWhisper(updated.rows[0]!);
}

export interface WhisperPage {
  /** Newest first: by `afterSeq`, then `createdAt`. */
  whispers: Whisper[];
  /** The `before` of the next page (an `afterSeq`), or null when none is older. */
  nextBefore: number | null;
}

/**
 * A page of `ownerId`'s whispers in `conversationId`, every status, below `before` (an `afterSeq`; none: from the newest):
 * the newest `limit`, and with them the rest of the whispers at the same place as the last of them, at most
 * `WHISPERS_PER_PLACE` more (a page never splits one place, so `nextBefore` is that place). Only those of the owner's
 * current stay (`after_seq >= joined_seq`). Null — the route's 404, the same as for a conversation that is none — unless
 * `ownerId` is a current member of it and owns an Agent that is one too, or has a whisper of this stay there: decided in one
 * statement, which for anyone not in the conversation stops at the membership, as for an id that is none.
 */
export async function listWhispers(
  q: Queryable,
  ownerId: string,
  conversationId: string,
  { before, limit }: { before?: number | undefined; limit: number },
): Promise<WhisperPage | null> {
  const allowed = await q.query<{ joined_seq: string }>(
    `select me.joined_seq from memberships me
      where me.conversation_id = $1 and me.principal_id = $2 and me.left_seq is null
        and (exists (select 1 from memberships am join principals p on p.id = am.principal_id
                      where am.conversation_id = $1 and am.left_seq is null and p.owner_id = $2)
             or exists (select 1 from whispers w where w.owner_id = $2 and w.conversation_id = $1 and w.after_seq >= me.joined_seq))`,
    [conversationId, ownerId],
  );
  const since = allowed.rows[0]?.joined_seq;
  if (since === undefined) return null;
  const page = await q.query<WhisperRow>(
    `select ${COLUMNS} from whispers
      where owner_id = $1 and conversation_id = $2 and after_seq >= $5 and ($3::bigint is null or after_seq < $3::bigint)
      order by after_seq desc, created_at desc, id desc limit $4`,
    [ownerId, conversationId, before ?? null, limit, since],
  );
  if (page.rows.length < limit) return { whispers: page.rows.map(toWhisper), nextBefore: null };
  const place = page.rows.at(-1)!.after_seq;
  const rest = await q.query<WhisperRow>(
    `select ${COLUMNS} from whispers where owner_id = $1 and conversation_id = $2 and after_seq = $3 order by created_at desc, id desc limit $4`,
    [ownerId, conversationId, place, WHISPERS_PER_PLACE],
  );
  const older = await q.query<{ more: boolean }>(
    "select exists (select 1 from whispers where owner_id = $1 and conversation_id = $2 and after_seq < $3 and after_seq >= $4) as more",
    [ownerId, conversationId, place, since],
  );
  const rows = [...page.rows.filter((r) => r.after_seq !== place), ...rest.rows];
  return { whispers: rows.map(toWhisper), nextBefore: older.rows[0]?.more ? Number(place) : null };
}

/**
 * `ownerId`'s whispers in each conversation of `from` they are a current member of: the live ones (open; a `found_elsewhere`
 * one open or telling: `liveSql`), and those at or after the seq given for it (sync: the oldest message it returns of that
 * conversation, 0 when it returns all; catch-up: the position), of their current stay there (`after_seq >= joined_seq`) —
 * ascending by `afterSeq`, then `createdAt`, conversations in the order of `from`. At most `WHISPERS_PER_ANSWER`: every live
 * one first, then the newest others. What `GET /api/sync` and catch-up carry for the owner alone (whispers/wire.ts).
 */
export async function whispersFrom(q: Queryable, ownerId: string, from: ReadonlyArray<{ conversationId: string; seq: number }>): Promise<Whisper[]> {
  if (from.length === 0) return [];
  const { rows } = await q.query<WhisperRow & { ord: string }>(
    `select x.* from (
       select ${columns("w")}, f.ord
         from unnest($2::uuid[], $3::bigint[]) with ordinality as f (id, from_seq, ord)
         join memberships me on me.conversation_id = f.id and me.principal_id = $1 and me.left_seq is null
         join whispers w on w.owner_id = $1 and w.conversation_id = f.id and w.after_seq >= me.joined_seq
                        and (${liveSql("w")} or w.after_seq >= f.from_seq)
        order by ${liveSql("w")} desc, w.created_at desc, w.id desc limit $4
     ) x order by x.ord, x.after_seq, x.created_at, x.id`,
    [ownerId, from.map((f) => f.conversationId), from.map((f) => f.seq), WHISPERS_PER_ANSWER],
  );
  return rows.map(toWhisper);
}

/**
 * In the transaction that takes `leaving` (people and Agents) out of `conversationId`, under its row: the open whispers
 * there whose owner or Agent is among them are expired (a told one stays told). Returns them, for their owners' sockets
 * once committed.
 */
export async function expireOnLeave(t: Tx, conversationId: string, leaving: readonly string[]): Promise<Whisper[]> {
  if (leaving.length === 0) return [];
  // Its rows taken in id order, as the Agent's delete takes its own (`expireOfAgent`): two of them never wait on each other.
  const { rows } = await t.query<WhisperRow>(
    `with batch as materialized (
       select w.id from whispers w
        where w.conversation_id = $1 and w.status = 'open'
          and w.owner_id in (select coalesce(p.owner_id, p.id) from principals p where p.id = any($2::uuid[]))
          and (w.owner_id = any($2::uuid[]) or w.agent_id = any($2::uuid[]))
          and ${notTold("w")}
        order by w.id for update of w)
     update whispers set status = 'expired', resolved_at = now()
      where id in (select id from batch)
      returning ${COLUMNS}`,
    [conversationId, leaving],
  );
  return rows.map(toWhisper);
}

/** In the transaction that deletes Agent `agentId`: its open whispers, everywhere, are expired (a told one stays told). Returns them, for its owner's sockets. */
export async function expireOfAgent(t: Tx, agentId: string): Promise<Whisper[]> {
  // In id order, as a leaving takes its own (`expireOnLeave`).
  const { rows } = await t.query<WhisperRow>(
    `with batch as materialized (
       select w.id from whispers w
        where w.owner_id = (select owner_id from principals where id = $1) and w.agent_id = $1 and w.status = 'open' and ${notTold("w")}
        order by w.id for update of w)
     update whispers set status = 'expired', resolved_at = now()
      where id in (select id from batch)
      returning ${COLUMNS}`,
    [agentId],
  );
  return rows.map(toWhisper);
}

/**
 * The periodic sweep (app.ts runs it with the memory changes' clean-up, on that timer; `attachments:sweep` by hand): an
 * open whisper `WHISPER_OPEN_DAYS` days old (`now` is the clock) is expired — a `found_elsewhere` one `elsewhereTtlHours`
 * hours old (`WHISPERS.elsewhereTtlHours`, default 24), unless it is told (told is final) or telling (it is its told
 * reply's: once that has ended without posting, a later run expires it). Bounded work: at most `batches` batches of `batch`
 * rows (by default `WHISPER_SWEEP_BATCHES` × `WHISPER_SWEEP_BATCH`), found by the index `(status, created_at)`, taken in id
 * order and never waited for: a row another transaction holds (an answer, a leaving, a delete) is skipped (`skip locked`),
 * and is that transaction's or the next run's. The status is asked again in the update itself, so an answer that got there
 * first stands. Returns what it expired, for the owners' sockets. Never logs a whisper.
 */
export async function expireWhispers(
  q: Queryable,
  now: Date = new Date(),
  limits: { batch?: number; batches?: number; elsewhereTtlHours?: number } = {},
): Promise<Whisper[]> {
  const batch = limits.batch ?? WHISPER_SWEEP_BATCH;
  const batches = limits.batches ?? WHISPER_SWEEP_BATCHES;
  const elsewhereHours = limits.elsewhereTtlHours ?? DEFAULT_WHISPERS.elsewhereTtlHours;
  const expired: Whisper[] = [];
  for (let i = 0; i < batches; i++) {
    const { rows } = await q.query<WhisperRow>(
      // The batch is taken once (a CTE that is never folded into the update: a subquery inside `in (…)` may be run again,
      // and so take more than `batch` rows past what it skipped). The index finds the open ones older than the shorter of
      // the two ages; each kind's own is asked of each.
      `with batch as materialized (
         select w.id from whispers w
          where w.status = 'open' and w.created_at < $1::timestamptz - least($2::int * interval '1 day', $4::int * interval '1 hour')
            and w.created_at < $1::timestamptz - case when w.kind = 'found_elsewhere' then $4::int * interval '1 hour' else $2::int * interval '1 day' end
            and (w.kind <> 'found_elsewhere' or not (${toldSql("w")} or ${tellingSql("w")}))
          order by w.id limit $3 for update of w skip locked)
       update whispers set status = 'expired', resolved_at = $1::timestamptz
        where id in (select id from batch) and status = 'open'
        returning ${COLUMNS}`,
      [now, WHISPER_OPEN_DAYS, batch, elsewhereHours],
    );
    expired.push(...rows.map(toWhisper));
    if (rows.length < batch) break;
  }
  return expired;
}

/**
 * The same sweep's other job: an answered or expired whisper made `WHISPER_KEEP_DAYS` days ago (`now` is the clock) is
 * deleted — its owner's list no longer has it —, and so is a `found_elsewhere` one made that long ago whatever it stores (a
 * told one is stored open: its state is derived). Bounded as the expiry is (at most `batches` × `batch` rows, by default
 * `WHISPER_SWEEP_BATCHES` × `WHISPER_SWEEP_BATCH`, the index `(status, created_at)`, id order, `skip locked`). An open one of
 * another kind is never deleted here (the expiry comes first). Returns how many went. Never reads or logs a whisper's body.
 */
export async function removeOldWhispers(q: Queryable, now: Date = new Date(), limits: { batch?: number; batches?: number } = {}): Promise<number> {
  const batch = limits.batch ?? WHISPER_SWEEP_BATCH;
  const batches = limits.batches ?? WHISPER_SWEEP_BATCHES;
  let removed = 0;
  for (let i = 0; i < batches; i++) {
    const gone = await q.query(
      `with batch as materialized (
         select id from whispers
          where (status in ('accepted', 'declined', 'expired') or kind = 'found_elsewhere') and created_at < $1::timestamptz - $2::int * interval '1 day'
          order by id limit $3 for update skip locked)
       delete from whispers where id in (select id from batch)`,
      [now, WHISPER_KEEP_DAYS, batch],
    );
    removed += gone.rowCount ?? 0;
    if ((gone.rowCount ?? 0) < batch) break;
  }
  return removed;
}
