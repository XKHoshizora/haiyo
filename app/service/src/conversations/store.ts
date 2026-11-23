import type { Config } from "../config.ts";
import type { Queryable, Tx } from "../db.ts";
import { AppError, notFound } from "../errors.ts";
import type { PairEvent, StoredMessage } from "../messages/model.ts";
import { AGENT_PROFILE_COLUMNS, AGENT_PROFILE_JOIN, agentProfile, type AgentProfile, type AgentProfileRow } from "../messages/principals.ts";
import { handleOf } from "../principals/store.ts";
import { lockPair, orderedPair } from "../social/pair.ts";
import { reachSql, type Reach, type ReachWhere } from "../social/reach.ts";
import { canDirectSend } from "../social/relations.ts";
import { appendSystem } from "./system.ts";

/**
 * THE visibility rule, and the only place it is written down. Join it onto `messages m`. A message is
 * visible iff the reader has a CURRENT membership (`left_seq is null`) in its conversation that began
 * before it (`joined_seq < seq`). Nothing else grants read access: not an earlier stay, not having sent
 * the message, not quoting it.
 *
 * `reader` is the SQL expression holding the reader's principal id: the parameter `$1`, or the column
 * `r.reader_id` for many readers at once. It is spliced into SQL, so its type admits exactly these two
 * literals; anything else does not compile.
 */
export type VisibleReader = "$1" | "r.reader_id";

export function visibleJoin(reader: VisibleReader): string {
  return `join memberships vis on vis.conversation_id = m.conversation_id and vis.principal_id = ${reader} and vis.left_seq is null and vis.joined_seq < m.seq`;
}

/**
 * `visibleJoin` for one reader passed as `$1`:
 *
 *   select ... from messages m ${VISIBLE_JOIN} where m.conversation_id = $2 ...
 */
export const VISIBLE_JOIN = visibleJoin("$1");

export const MAX_GROUP_MEMBERS = 500;

export type ConversationType = "direct" | "group" | "agent" | "agent_social";

export interface ConversationRow {
  id: string;
  type: ConversationType;
  title: string | null;
  creatorId: string;
  /** The last assigned message seq. */
  seq: number;
  closedAt: Date | null;
}

export interface Membership {
  id: string;
  conversationId: string;
  principalId: string;
  role: "speaker" | "observer";
  joinedSeq: number;
  leftSeq: number | null;
  readSeq: number;
}

interface ConversationDbRow {
  id: string;
  type: ConversationType;
  title: string | null;
  creator_id: string;
  seq: string;
  closed_at: Date | null;
}

interface MembershipDbRow {
  id: string;
  conversation_id: string;
  principal_id: string;
  role: "speaker" | "observer";
  joined_seq: string;
  left_seq: string | null;
  read_seq: string;
}

const toConversation = (r: ConversationDbRow): ConversationRow => ({
  id: r.id,
  type: r.type,
  title: r.title,
  creatorId: r.creator_id,
  seq: Number(r.seq),
  closedAt: r.closed_at,
});

const toMembership = (r: MembershipDbRow): Membership => ({
  id: r.id,
  conversationId: r.conversation_id,
  principalId: r.principal_id,
  role: r.role,
  joinedSeq: Number(r.joined_seq),
  leftSeq: r.left_seq === null ? null : Number(r.left_seq),
  readSeq: Number(r.read_seq),
});

/**
 * The rows of conversations `ids` taken `for key share`, in id order, in one statement: the lock a foreign key to a conversation
 * takes when a row pointing at it is written (a note's origin, a hearsay entry's group, a review or group state row). Taken first,
 * before anything else in the transaction (agents/store.ts `lockAgent` says the order): a send holds its conversation `for update`
 * and then asks for an Agent's row or an account's, so a writer that held one of those and then waited for the conversation could
 * close a circle. `exceptOwnOf`: an Agent whose own conversation is left out — its transaction takes that row `for update` next
 * (`lockAgent`), and a shared lock of it taken first would leave two such transactions each waiting to strengthen theirs. `nowait`:
 * one held by anyone fails the statement at once (55P03 `lock_not_available`) instead of waiting — for a transaction that already
 * holds rows after them in the order. Returns the ids taken.
 */
export async function lockConversationKeys(t: Tx, ids: readonly string[], opts: { exceptOwnOf?: string; nowait?: boolean } = {}): Promise<string[]> {
  if (ids.length === 0) return [];
  const { rows } = await t.query<{ id: string }>(
    `select id from conversations
      where id = any($1::uuid[]) and id is distinct from (select conversation_id from agent_conversations where agent_id = $2::uuid)
      order by id
        for key share${opts.nowait === true ? " nowait" : ""}`,
    [[...new Set(ids)], opts.exceptOwnOf ?? null],
  );
  return rows.map((r) => r.id);
}

/** Locks the conversation row (`select … for update`) for the rest of the transaction. */
export async function lockConversation(t: Tx, conversationId: string): Promise<ConversationRow | null> {
  const { rows } = await t.query<ConversationDbRow>(
    "select id, type, title, creator_id, seq, closed_at from conversations where id = $1 for update",
    [conversationId],
  );
  return rows[0] ? toConversation(rows[0]) : null;
}

/** The principal's current membership (`left_seq is null`), or null. */
export async function currentMembership(q: Queryable, conversationId: string, principalId: string): Promise<Membership | null> {
  const { rows } = await q.query<MembershipDbRow>(
    `select id, conversation_id, principal_id, role, joined_seq, left_seq, read_seq
       from memberships where conversation_id = $1 and principal_id = $2 and left_seq is null`,
    [conversationId, principalId],
  );
  return rows[0] ? toMembership(rows[0]) : null;
}

export async function currentMemberIds(q: Queryable, conversationId: string): Promise<string[]> {
  const { rows } = await q.query<{ principal_id: string }>(
    "select principal_id from memberships where conversation_id = $1 and left_seq is null order by joined_seq, id",
    [conversationId],
  );
  return rows.map((r) => r.principal_id);
}

/** A current member as `removeMember` weighs them: who they are and whose Agent, in join order. */
export interface CurrentMember {
  membershipId: string;
  principalId: string;
  kind: "human" | "agent";
  /** The owner of an Agent; null for a person. */
  ownerId: string | null;
}

export async function currentMembers(q: Queryable, conversationId: string): Promise<CurrentMember[]> {
  const { rows } = await q.query<{ id: string; principal_id: string; kind: "human" | "agent"; owner_id: string | null }>(
    `select ms.id, ms.principal_id, p.kind, p.owner_id
       from memberships ms join principals p on p.id = ms.principal_id
      where ms.conversation_id = $1 and ms.left_seq is null
      order by ms.joined_seq, ms.id`,
    [conversationId],
  );
  return rows.map((r) => ({ membershipId: r.id, principalId: r.principal_id, kind: r.kind, ownerId: r.owner_id }));
}

/** Type and (for direct chats) the pair, without locking: neither ever changes after creation. */
export async function peekConversation(
  q: Queryable,
  conversationId: string,
): Promise<{ type: ConversationType; pair: [string, string] | null } | null> {
  const { rows } = await q.query<{ type: ConversationType; a_id: string | null; b_id: string | null }>(
    `select c.type, d.a_id, d.b_id from conversations c left join direct_pairs d on d.conversation_id = c.id
      where c.id = $1`,
    [conversationId],
  );
  const r = rows[0];
  if (!r) return null;
  return { type: r.type, pair: r.a_id && r.b_id ? [r.a_id, r.b_id] : null };
}

export interface WriteLock {
  conversation: ConversationRow;
  membership: Membership;
  /** The other party of a direct conversation; null in groups. */
  peerId: string | null;
}

/**
 * Takes the locks for a write by `principalId` in the global order — the pair lock first for a direct
 * conversation, then the conversation row — and returns the locked state. 404 `not_found` unless
 * `principalId` is a current member of the open conversation (the same answer as for a missing one).
 */
export async function lockForWrite(t: Tx, conversationId: string, principalId: string): Promise<WriteLock> {
  const peek = await peekConversation(t, conversationId);
  if (!peek) throw notFound();
  let peerId: string | null = null;
  if (peek.type === "direct") {
    if (!peek.pair) throw notFound();
    const [a, b] = peek.pair;
    if (principalId !== a && principalId !== b) throw notFound();
    peerId = principalId === a ? b : a;
    await lockPair(t, a, b);
  }
  const conversation = await lockConversation(t, conversationId);
  if (!conversation || conversation.closedAt) throw notFound();
  const membership = await currentMembership(t, conversationId, principalId);
  if (!membership) throw notFound();
  return { conversation, membership, peerId };
}

export type CanSend = { ok: true } | { ok: false; reason: "blocked" | "not_friends" | "agent_deleted" | "no_access" | "agent_unavailable" };

/**
 * `lock`: inside a write that holds the conversation row (`assertCanSend`): a social conversation's participating Agents' rows are
 * taken `for update`, in id order, so that a delete, a pause or a bar committing meanwhile is seen by the next write and not this
 * one. `config` carries the site's Agent social switch to `reach`.
 */
interface PermissionOptions {
  lock: boolean;
  config: Pick<Config, "social">;
}

async function permission(
  q: Queryable,
  type: ConversationType,
  conversationId: string,
  principalId: string,
  peerId: string | null,
  opts: PermissionOptions,
): Promise<CanSend> {
  if (type === "group") return { ok: true };
  if (type === "agent") {
    // The members are exactly the owner and the Agent; no friendship is consulted. The Agent's row is read
    // plainly: deleting takes the conversation row lock first (`lockAgent`), which every writer here holds.
    const { rows } = await q.query<{ deleted: boolean }>(
      `select a.deleted_at is not null as deleted
         from agent_conversations ac join agents a on a.principal_id = ac.agent_id where ac.conversation_id = $1`,
      [conversationId],
    );
    return rows[0]?.deleted === false ? { ok: true } : { ok: false, reason: "agent_deleted" };
  }
  if (type === "agent_social") return socialPermission(q, conversationId, opts);
  const reason = await canDirectSend(q, principalId, peerId!);
  return reason ? { ok: false, reason } : { ok: true };
}

/**
 * Who may write in a social conversation (design §2; plan A3a): whoever is let in to it, a participant or a supervising owner,
 * while its relation is open; the relation is the same for all of them (`socialCanSendMany`).
 */
async function socialPermission(q: Queryable, conversationId: string, opts: PermissionOptions): Promise<CanSend> {
  // The Agents' rows, in id order (`lockAgent`'s order), after the conversation row the write already holds.
  if (opts.lock) {
    await q.query(
      `select principal_id from agents
        where principal_id in (select p.id from social_pairs sp join principals p on p.id in (sp.a_id, sp.b_id) where sp.conversation_id = $1 and p.kind = 'agent')
        order by principal_id for update`,
      [conversationId],
    );
  }
  return (await socialCanSendMany(q, [conversationId], opts.config)).get(conversationId) ?? { ok: false, reason: "no_access" };
}

/**
 * THE write rule of social conversations, for many at once in ONE statement (the sync asks it for all of a person's): per
 * conversation, whether its relation is open. Person to Agent: `reach(the person, the Agent, 'social')` is `ok`. Agent to Agent:
 * the switch is on and `reach(X, Y, 'group')` and `reach(Y, X, 'group')` both. It is the same for a participant and for a supervising owner, so a
 * removal, a bar, a block or the switch shuts the owner's interjection as it shuts the person's own message. Refusals: `blocked`
 * stays `blocked`; `gone` is `agent_deleted` when the Agent asked is deleted, else `agent_unavailable`; `barred` and
 * `no_access` are `no_access`. A conversation that is no social conversation has no entry.
 */
export async function socialCanSendMany(q: Queryable, conversationIds: readonly string[], config: Pick<Config, "social">): Promise<Map<string, CanSend>> {
  const out = new Map<string, CanSend>();
  if (conversationIds.length === 0) return out;
  const socialOn = config.social.enabled ? "true" : "false";
  const rule = (subject: string, agent: string, where: ReachWhere): string => reachSql({ subject, agent, where, socialOn });
  // `who` asks, `asked` is the Agent asked: the person and their Agent, or the first Agent and the second (then the second asks
  // the first as well).
  const { rows } = await q.query<{ id: string; with_person: boolean; r1: Reach; d1: boolean; r2: Reach; d2: boolean }>(
    `select x.id, x.with_person,
            case when x.with_person then ${rule("x.who", "x.asked", "social")}
                 when not (${socialOn}) then 'gone'
                 else ${rule("x.who", "x.asked", "group")} end as r1,
            coalesce((select a.deleted_at is not null from agents a where a.principal_id = x.asked), true) as d1,
            case when x.with_person then 'ok' else ${rule("x.asked", "x.who", "group")} end as r2,
            coalesce((select a.deleted_at is not null from agents a where a.principal_id = x.who), true) as d2
       from (select sp.conversation_id as id, (pa.kind = 'human' or pb.kind = 'human') as with_person,
                    case when pb.kind = 'human' then sp.b_id else sp.a_id end as who,
                    case when pb.kind = 'human' then sp.a_id else sp.b_id end as asked
               from social_pairs sp join principals pa on pa.id = sp.a_id join principals pb on pb.id = sp.b_id
              where sp.conversation_id = any($1::uuid[])) x`,
    [conversationIds],
  );
  for (const r of rows) {
    // Agent to Agent with the switch off is `gone` from the first side whichever Agent is deleted.
    const [why, deleted] = r.r1 !== "ok" ? ([r.r1, r.d1 || (!r.with_person && r.d2)] as const) : ([r.r2, r.d2] as const);
    out.set(
      r.id,
      why === "ok"
        ? { ok: true }
        : why === "blocked"
          ? { ok: false, reason: "blocked" }
          : why === "gone"
            ? { ok: false, reason: deleted ? "agent_deleted" : "agent_unavailable" }
            : { ok: false, reason: "no_access" },
    );
  }
  return out;
}

/**
 * Whether `principalId` may send in the conversation right now: direct chats follow the pair's
 * friendship and blocks, groups let every current member send, an Agent's conversation lets its owner send
 * until the Agent is deleted, a social conversation follows `reach` (above). Null when not a current member of an
 * open conversation. Advisory outside a transaction: the upload route's pre-check uses it, and sends and
 * uploads re-check under the locks. `GET /api/sync` gives the same verdict for all its direct chats at
 * once (canDirectSendMany); every one of these takes the other party from `direct_pairs`.
 */
export async function canSend(q: Queryable, conversationId: string, principalId: string, config: Pick<Config, "social">): Promise<CanSend | null> {
  const { rows } = await q.query<{ type: ConversationType; a_id: string | null; b_id: string | null }>(
    `select c.type, d.a_id, d.b_id
       from conversations c
       join memberships ms on ms.conversation_id = c.id and ms.principal_id = $2 and ms.left_seq is null
       left join direct_pairs d on d.conversation_id = c.id
      where c.id = $1 and c.closed_at is null`,
    [conversationId, principalId],
  );
  const r = rows[0];
  if (!r) return null;
  const peerId = r.type === "direct" ? (r.a_id === principalId ? r.b_id : r.a_id) : null;
  return permission(q, r.type, conversationId, principalId, peerId, { lock: false, config });
}

/** Inside a write holding `lockForWrite`: 403 `cannot_send` with the reason, the same refusal a send gets. */
export async function assertCanSend(t: Tx, lock: WriteLock, config: Pick<Config, "social">): Promise<void> {
  const verdict = await permission(t, lock.conversation.type, lock.conversation.id, lock.membership.principalId, lock.peerId, { lock: true, config });
  if (!verdict.ok) throw new AppError(403, "cannot_send", { reason: verdict.reason });
}

export async function findDirect(q: Queryable, a: string, b: string): Promise<string | null> {
  const [lo, hi] = orderedPair(a, b);
  const { rows } = await q.query<{ conversation_id: string }>(
    "select conversation_id from direct_pairs where a_id = $1 and b_id = $2",
    [lo, hi],
  );
  return rows[0]?.conversation_id ?? null;
}

/**
 * The direct conversation for the unordered pair, created on first use. Idempotent and race-safe
 * (serialised on the pair lock). `creatorId` (the accepter, when called from accept) is recorded as
 * creator. Both parties are speakers from seq 0 and stay members for good, so re-befriending after
 * unfriending reuses the same conversation.
 */
export async function ensureDirect(t: Tx, a: string, b: string, creatorId: string = b): Promise<string> {
  await lockPair(t, a, b);
  const existing = await findDirect(t, a, b);
  if (existing) return existing;

  const [lo, hi] = orderedPair(a, b);
  const created = await t.query<{ id: string }>(
    "insert into conversations (type, creator_id) values ('direct', $1) returning id",
    [creatorId],
  );
  const id = created.rows[0]!.id;
  await t.query("insert into direct_pairs (conversation_id, a_id, b_id) values ($1, $2, $3)", [id, lo, hi]);
  await t.query(
    `insert into memberships (conversation_id, principal_id, role, joined_seq)
     values ($1, $2, 'speaker', 0), ($1, $3, 'speaker', 0)`,
    [id, lo, hi],
  );
  return id;
}

/**
 * The social conversation of a person (or Agent) `subjectId` with Agent `agentId`, created on first use together with its first
 * message, `social_opened` (the disclosure). The caller holds the pair locks (A4: `lockPairs` on the subject's person with the
 * Agent's owner, and the subject with the Agent), so two adds of one pair never both create it. One `social_pairs` row per
 * unordered pair. Members: both parties `speaker` from seq 0, and each party's owner `observer` from seq 0, once, never the
 * subject itself. `created` false (and no notice) when the pair has its conversation already.
 */
export async function ensureSocial(t: Tx, subjectId: string, agentId: string): Promise<{ conversationId: string; created: boolean; notice: StoredMessage | null }> {
  const [lo, hi] = orderedPair(subjectId, agentId);
  const existing = await t.query<{ conversation_id: string }>("select conversation_id from social_pairs where a_id = $1 and b_id = $2", [lo, hi]);
  if (existing.rows[0]) return { conversationId: existing.rows[0].conversation_id, created: false, notice: null };

  const parties = await t.query<{ id: string; kind: "human" | "agent"; owner_id: string | null }>("select id, kind, owner_id from principals where id = any($1::uuid[])", [[subjectId, agentId]]);
  const byId = new Map(parties.rows.map((r) => [r.id, r]));
  const subject = byId.get(subjectId);
  const agent = byId.get(agentId);
  if (!subject || !agent || agent.kind !== "agent" || !agent.owner_id) throw new Error("ensureSocial: the second party must be an Agent");
  const agentIds = subject.kind === "agent" ? [subjectId, agentId] : [agentId];
  const ownerIds = [...new Set([subject.owner_id, agent.owner_id].filter((o): o is string => o !== null && o !== subjectId))];

  const created = await t.query<{ id: string }>("insert into conversations (type, creator_id) values ('agent_social', $1) returning id", [subjectId]);
  const conversationId = created.rows[0]!.id;
  await t.query("insert into social_pairs (conversation_id, a_id, b_id) values ($1, $2, $3)", [conversationId, lo, hi]);
  await t.query(
    `insert into memberships (conversation_id, principal_id, role, joined_seq)
     select $1, p, case when p = any($2::uuid[]) then 'speaker' else 'observer' end, 0 from unnest($3::uuid[]) as p`,
    [conversationId, [subjectId, agentId], [subjectId, agentId, ...ownerIds]],
  );
  await lockConversation(t, conversationId);
  const notice = await appendSystem(t, conversationId, { event: "social_opened", actorId: agentId, agentIds, ownerIds });
  return { conversationId, created: true, notice };
}

/**
 * Appends a relationship notice to the pair's direct conversation, if they have one, in the caller's
 * transaction (which already holds the pair lock; taking it again is a no-op that pins the lock order).
 */
export async function appendDirectNotice(t: Tx, e: PairEvent): Promise<StoredMessage | null> {
  await lockPair(t, e.actorId, e.principalId);
  const id = await findDirect(t, e.actorId, e.principalId);
  if (!id) return null;
  await lockConversation(t, id);
  return appendSystem(t, id, e);
}

export interface MemberView extends Partial<AgentProfile> {
  id: string;
  handle: string;
  displayName: string;
  avatarVersion: number;
  kind: "human" | "agent";
  role: "speaker" | "observer";
  /** Only ever true in groups. */
  isCreator: boolean;
}

/**
 * The current members, as `readerId` may see them: null unless the reader is a current member. One
 * statement, so the membership check and the list come from the same snapshot (a member removed
 * concurrently never receives the list as it is after their removal). An Agent comes with its `AgentProfile` (its owner,
 * intro and field) and nothing else of it.
 */
export async function listMembers(q: Queryable, readerId: string, conversationId: string): Promise<MemberView[] | null> {
  const { rows } = await q.query<
    {
      id: string;
      handle: string;
      display_name: string;
      avatar_version: number;
      role: "speaker" | "observer";
      is_creator: boolean;
    } & AgentProfileRow
  >(
    `select p.id, ${handleOf("p")} as handle, p.display_name, p.avatar_version, p.kind, ms.role,
            (c.type = 'group' and c.creator_id = p.id) as is_creator, ${AGENT_PROFILE_COLUMNS}
       from memberships me
       join conversations c on c.id = me.conversation_id
       join memberships ms on ms.conversation_id = me.conversation_id and ms.left_seq is null
       join principals p on p.id = ms.principal_id
       ${AGENT_PROFILE_JOIN}
      where me.conversation_id = $1 and me.principal_id = $2 and me.left_seq is null
      order by ms.joined_seq, ms.id`,
    [conversationId, readerId],
  );
  // A current member always sees at least themselves, so no rows means "not a member".
  if (rows.length === 0) return null;
  return rows.map((r) => ({
    id: r.id,
    handle: r.handle,
    displayName: r.display_name,
    avatarVersion: r.avatar_version,
    kind: r.kind,
    role: r.role,
    isCreator: r.is_creator,
    ...agentProfile(r),
  }));
}
