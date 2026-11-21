import { VISIBLE_JOIN, type ConversationType } from "../conversations/store.ts";
import type { Config } from "../config.ts";
import type { Db, Tx } from "../db.ts";
import { MESSAGE_COLUMNS, notAcknowledgement, toStored, type MessageRow, type StoredMessage, type WireMessage } from "../messages/model.ts";
import { mentionedIn, readPrincipals, type SyncPrincipal } from "../messages/principals.ts";
import { toWireFor, type ReadConfig } from "../messages/read.ts";
import { canDirectSendMany, type DirectRefusal } from "../social/relations.ts";
import { waitingSql, whispersFrom } from "../whispers/store.ts";
import { wireWhispers, type WireWhisper } from "../whispers/wire.ts";

/** How many of the newest visible messages per conversation `GET /api/sync` returns. */
export const SYNC_MESSAGES_PER_CONVERSATION = 30;
/** At most this many messages per catch-up response. */
export const CATCHUP_MAX_MESSAGES = 500;
/** At most this many conversations per catch-up request. */
export const CATCHUP_MAX_POSITIONS = 500;

type Role = "speaker" | "observer";

export interface SyncConversation {
  id: string;
  type: ConversationType;
  title: string | null;
  /** Groups only: a direct chat has no creator role (and `isCreator` is false for both of its members). */
  creatorId?: string;
  myRole: Role;
  closed: boolean;
  /** When the conversation was created (ISO 8601): `/api/sync`'s order, and a place for one without messages. */
  createdAt: string;
  /** Direct chats only: the other party, from the pair the conversation belongs to (as the send path). */
  peerId?: string;
  /** Agent conversations only: the Agent (its owner's dedicated conversation has no peer). */
  agentId?: string;
  /** Agent conversations only. */
  agent?: { paused: boolean; deleted: boolean };
  canSend: { ok: true } | { ok: false; reason: "blocked" | "not_friends" | "closed" | "agent_deleted" };
  members: Array<{ id: string; role: Role; isCreator: boolean }>;
  /** The conversation's last assigned seq (it reveals how much was said, also before the caller joined). */
  lastSeq: number;
  readSeq: number;
  /** Visible messages from others, not system notices, after `readSeq`. */
  unread: number;
  /** Direct chats: how far the other party has read; Agent conversations: how far the Agent has (it reads when it starts a reply). */
  peerReadSeq?: number;
  /**
   * How many of the caller's own whispers there wait for their answer (src/whispers/: open, and offering a button — one
   * that offers none only tells); only when there are any. Nobody else's are counted.
   */
  whispers?: number;
}

export type { SyncPrincipal };

export interface SyncView {
  conversations: SyncConversation[];
  /** Every principal the response mentions: members, the caller, and anyone named in a visible message. */
  principals: SyncPrincipal[];
  /** Per conversation (in `conversations` order) its newest visible messages, ascending by seq. */
  messages: WireMessage[];
  /**
   * The caller's own whispers (src/whispers/): every open one, and the answered or expired ones that follow a message
   * `messages` holds (all of a conversation whose messages are all there); only when there are any.
   */
  whispers?: WireWhisper[];
}

export interface CatchUp {
  /** Per conversation (in request order) the next visible messages after the position, ascending by seq. */
  messages: WireMessage[];
  /** Requested ids the caller is not a current member of — left, removed, never a member or unknown alike. */
  gone: string[];
  /** The 500-message cap cut the response short: ask again with the advanced positions. */
  more: boolean;
  /** The caller's own whispers in the conversations caught up: the open ones and those at or after the position; only when there are any. */
  whispers?: WireWhisper[];
}

/**
 * Runs `fn` in a read-only transaction on one snapshot, so every part of a response describes the same
 * moment: the membership that admits a message is the one that was current when it was read.
 */
function onSnapshot<T>(db: Db, fn: (t: Tx) => Promise<T>): Promise<T> {
  return db.tx(async (t) => {
    await t.query("set transaction isolation level repeatable read, read only");
    return fn(t);
  });
}

/**
 * The caller's entries for the conversations they are currently in (all of them, or only `onlyId`), in
 * `/api/sync` order: what both `GET /api/sync` and `GET /api/conversations/:id` answer.
 */
async function conversationEntries(t: Tx, me: string, onlyId: string | null = null): Promise<SyncConversation[]> {
  const conversations = await t.query<{
    id: string;
    type: ConversationType;
    title: string | null;
    creator_id: string;
    seq: string;
    closed: boolean;
    created_at: Date;
    role: Role;
    read_seq: string;
    peer_id: string | null;
    peer_read_seq: string | null;
    unread: string;
    agent_id: string | null;
    agent_paused: boolean | null;
    agent_deleted: boolean | null;
    agent_read_seq: string | null;
    whispers: string;
  }>(
    // A direct chat's other party comes from its pair (direct_pairs), the one source the send path uses;
    // only the peer's read marker is read from their membership.
    `select c.id, c.type, c.title, c.creator_id, c.seq, c.closed_at is not null as closed, c.created_at, me.role, me.read_seq,
            pair.peer_id, peer.read_seq as peer_read_seq,
            ac.agent_id, ag.paused as agent_paused, ag.deleted_at is not null as agent_deleted, agm.read_seq as agent_read_seq,
            (select count(*) from messages m ${VISIBLE_JOIN}
              where m.conversation_id = c.id and m.seq > me.read_seq and m.kind <> 'system' and m.sender_id <> $1 and ${notAcknowledgement("m")}) as unread,
            -- The caller's own whispers there that wait for an answer (open, offering a button; a found-elsewhere one neither
            -- told nor telling, with a hit left to read: whispers/store.ts), and nobody else's (owner_id is the reader).
            (select count(*) from whispers w
              where w.owner_id = $1 and w.conversation_id = c.id and ${waitingSql("w")}
                and w.after_seq >= me.joined_seq) as whispers
       from memberships me
       join conversations c on c.id = me.conversation_id
       left join lateral (
         select case when d.a_id = $1 then d.b_id else d.a_id end as peer_id
           from direct_pairs d where d.conversation_id = c.id
       ) pair on true
       left join memberships peer
         on peer.conversation_id = c.id and peer.principal_id = pair.peer_id and peer.left_seq is null
       left join agent_conversations ac on ac.conversation_id = c.id
       left join agents ag on ag.principal_id = ac.agent_id
       left join memberships agm
         on agm.conversation_id = c.id and agm.principal_id = ac.agent_id and agm.left_seq is null
      where me.principal_id = $1 and me.left_seq is null and ($2::uuid is null or me.conversation_id = $2::uuid)
      order by c.created_at, c.id`,
    [me, onlyId],
  );
  if (conversations.rows.length === 0) return [];

  const members = await t.query<{ conversation_id: string; principal_id: string; role: Role; is_creator: boolean }>(
    `select ms.conversation_id, ms.principal_id, ms.role, (c.type = 'group' and c.creator_id = ms.principal_id) as is_creator
       from memberships me
       join conversations c on c.id = me.conversation_id
       join memberships ms on ms.conversation_id = me.conversation_id and ms.left_seq is null
      where me.principal_id = $1 and me.left_seq is null and ($2::uuid is null or me.conversation_id = $2::uuid)
      order by ms.joined_seq, ms.id`,
    [me, onlyId],
  );
  const membersOf = new Map<string, SyncConversation["members"]>();
  for (const r of members.rows) {
    const list = membersOf.get(r.conversation_id) ?? [];
    list.push({ id: r.principal_id, role: r.role, isCreator: r.is_creator });
    membersOf.set(r.conversation_id, list);
  }

  const verdicts = await canDirectSendMany(
    t,
    me,
    conversations.rows.flatMap((c) => (c.peer_id ? [c.peer_id] : [])),
  );
  /** A direct chat without a verdict (cannot happen) shows as refused, never as allowed. */
  const directVerdict = (peerId: string | null): DirectRefusal | null => {
    const verdict = peerId ? verdicts.get(peerId) : undefined;
    return verdict === undefined ? "not_friends" : verdict;
  };
  return conversations.rows.map((c) => {
    const verdict = c.type === "direct" ? directVerdict(c.peer_id) : c.agent_deleted ? "agent_deleted" : null;
    return {
      id: c.id,
      type: c.type,
      title: c.title,
      ...(c.type === "group" ? { creatorId: c.creator_id } : {}),
      myRole: c.role,
      closed: c.closed,
      createdAt: c.created_at.toISOString(),
      ...(c.type === "direct" && c.peer_id ? { peerId: c.peer_id } : {}),
      ...(c.type === "agent" && c.agent_id
        ? { agentId: c.agent_id, agent: { paused: c.agent_paused === true, deleted: c.agent_deleted === true } }
        : {}),
      canSend: c.closed ? { ok: false, reason: "closed" } : verdict ? { ok: false, reason: verdict } : { ok: true },
      members: membersOf.get(c.id) ?? [],
      lastSeq: Number(c.seq),
      readSeq: Number(c.read_seq),
      unread: Number(c.unread),
      ...(c.type === "direct" && c.peer_read_seq !== null ? { peerReadSeq: Number(c.peer_read_seq) } : {}),
      ...(c.type === "agent" && c.agent_read_seq !== null ? { peerReadSeq: Number(c.agent_read_seq) } : {}),
      ...(Number(c.whispers) > 0 ? { whispers: Number(c.whispers) } : {}),
    };
  });
}

/**
 * One conversation as the caller's `/api/sync` shows it, or null unless they are a current member (never,
 * left, removed, unknown alike).
 */
export async function syncConversation(db: Db, me: string, conversationId: string): Promise<SyncConversation | null> {
  return onSnapshot(db, async (t) => (await conversationEntries(t, me, conversationId))[0] ?? null);
}

/** Everything the web client loads at start: the caller's current conversations and what they may read of them. */
export async function syncView(db: Db, me: string, config: ReadConfig & Pick<Config, "siteTimezone">): Promise<SyncView> {
  return onSnapshot(db, async (t) => {
    const out = await conversationEntries(t, me);

    const recent = await t.query<MessageRow>(
      `select ${MESSAGE_COLUMNS}
         from memberships me
         cross join lateral (
           select m.* from messages m ${VISIBLE_JOIN}
            where m.conversation_id = me.conversation_id
            order by m.seq desc limit ${SYNC_MESSAGES_PER_CONVERSATION}
         ) m
        where me.principal_id = $1 and me.left_seq is null`,
      [me],
    );
    const recentOf = new Map<string, StoredMessage[]>();
    for (const m of recent.rows.map(toStored)) {
      const list = recentOf.get(m.conversationId) ?? [];
      list.push(m);
      recentOf.set(m.conversationId, list);
    }
    const ordered = out.flatMap((c) => (recentOf.get(c.id) ?? []).sort((x, y) => x.seq - y.seq));
    const messages = await toWireFor(t, me, ordered, config);
    // The caller's whispers: open ones, and those that follow a message returned here (of a conversation whose visible
    // messages are all here, every one).
    const whispers = await whispersFrom(
      t,
      me,
      out.map((c) => {
        const held = recentOf.get(c.id) ?? [];
        return { conversationId: c.id, seq: held.length < SYNC_MESSAGES_PER_CONVERSATION ? 0 : Math.min(...held.map((m) => m.seq)) };
      }),
    );

    const mentioned = new Set<string>([me.toLowerCase()]);
    for (const c of out) for (const m of c.members) mentioned.add(m.id);
    for (const m of messages) for (const id of mentionedIn(m)) mentioned.add(id);
    const principals = await readPrincipals(t, mentioned);

    return {
      conversations: out,
      principals,
      messages,
      ...(whispers.length > 0 ? { whispers: await wireWhispers(t, whispers, config.siteTimezone) } : {}),
    };
  });
}

/**
 * Splits `budget` over the backlogs as evenly as they allow (a conversation with little to send leaves its
 * share to the others), so one busy conversation cannot starve the rest across repeated calls.
 */
function allot(backlogs: Array<{ id: string; missed: number }>, budget: number): Map<string, number> {
  const take = new Map(backlogs.map((b) => [b.id, 0]));
  let active = backlogs.filter((b) => b.missed > 0);
  while (budget > 0 && active.length > 0) {
    const share = Math.max(1, Math.floor(budget / active.length));
    for (const b of active) {
      const n = Math.min(share, b.missed - take.get(b.id)!, budget);
      take.set(b.id, take.get(b.id)! + n);
      budget -= n;
      if (budget === 0) break;
    }
    active = active.filter((b) => take.get(b.id)! < b.missed);
  }
  return take;
}

/**
 * The visible messages after each given position (conversation id, lower-case → last seq the client has),
 * at most 500 in total, each conversation's share a gapless prefix of what it missed. Ids the caller is
 * not a current member of are only listed in `gone`, whatever the reason; conversations the caller is in
 * but sent no position for are not looked at.
 */
export async function catchUp(db: Db, me: string, positions: ReadonlyMap<string, number>, config: ReadConfig & Pick<Config, "siteTimezone">): Promise<CatchUp> {
  if (positions.size === 0) return { messages: [], gone: [], more: false };
  const ids = [...positions.keys()];

  return onSnapshot(db, async (t) => {
    // First only which ids the caller is currently in (one index probe per id). Nothing more is looked
    // at for the others, so an id you are not in costs the same whether it exists, is busy, or not.
    const member = await t.query<{ id: string }>(
      `select p.id from unnest($2::uuid[]) as p (id)
         join memberships me on me.conversation_id = p.id and me.principal_id = $1 and me.left_seq is null`,
      [me, ids],
    );
    const memberOf = new Set(member.rows.map((r) => r.id));
    const gone = ids.filter((id) => !memberOf.has(id));
    const memberIds = ids.filter((id) => memberOf.has(id));
    if (memberIds.length === 0) return { messages: [], gone, more: false };
    // The caller's own whispers there: the open ones, and those at or after the position (made or answered meanwhile).
    const found = await whispersFrom(t, me, memberIds.map((id) => ({ conversationId: id, seq: positions.get(id)! })));
    const whispers = found.length > 0 ? { whispers: await wireWhispers(t, found, config.siteTimezone) } : {};

    // Per conversation the caller is in: how many visible messages follow the position (counted up to
    // one past the cap: enough to know whether more remain).
    const backlog = await t.query<{ id: string; missed: string }>(
      `select p.id,
              (select count(*) from (
                 select 1 from messages m ${VISIBLE_JOIN}
                  where m.conversation_id = p.id and m.seq > p.after
                  limit $4
              ) x) as missed
         from unnest($2::uuid[], $3::bigint[]) with ordinality as p (id, after, ord)
        order by p.ord`,
      [me, memberIds, memberIds.map((id) => positions.get(id)!), CATCHUP_MAX_MESSAGES + 1],
    );
    const mine = backlog.rows.map((r) => ({ id: r.id, missed: Number(r.missed) }));
    const take = allot(mine, CATCHUP_MAX_MESSAGES);
    const more = mine.some((b) => b.missed > take.get(b.id)!);
    const wanted = mine.filter((b) => take.get(b.id)! > 0);
    if (wanted.length === 0) return { messages: [], gone, more, ...whispers };

    const { rows } = await t.query<MessageRow>(
      `select ${MESSAGE_COLUMNS}
         from unnest($2::uuid[], $3::bigint[], $4::int[]) with ordinality as p (id, after, take, ord)
         cross join lateral (
           select m.* from messages m ${VISIBLE_JOIN}
            where m.conversation_id = p.id and m.seq > p.after
            order by m.seq limit p.take
         ) m
        order by p.ord, m.seq`,
      [me, wanted.map((b) => b.id), wanted.map((b) => positions.get(b.id)!), wanted.map((b) => take.get(b.id)!)],
    );
    return { messages: await toWireFor(t, me, rows.map(toStored), config), gone, more, ...whispers };
  });
}
