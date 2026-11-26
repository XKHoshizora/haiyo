import type { EndedRuns } from "../agents/group-leave.ts";
import { appendDirectNotice, ensureDirect } from "../conversations/store.ts";
import type { Queryable, Tx } from "../db.ts";
import type { StoredMessage } from "../messages/model.ts";
import { handleOf, type PublicPrincipal } from "../principals/store.ts";
import { endGrants } from "./agent-contacts.ts";
import { lockPair, orderedPair } from "./pair.ts";
import { areFriends, blockBetween } from "./relations.ts";

export const REQUEST_TTL_HOURS = 24;

export type RequestStatus = "pending" | "accepted" | "rejected" | "withdrawn" | "expired";

export interface FriendRequestRow {
  id: string;
  fromId: string;
  toId: string;
  status: RequestStatus;
  createdAt: Date;
  expiresAt: Date;
}

interface RawRequest {
  id: string;
  from_id: string;
  to_id: string;
  status: RequestStatus;
  created_at: Date;
  expires_at: Date;
  expired_now: boolean;
}

const REQUEST_COLUMNS =
  "id, from_id, to_id, status, created_at, expires_at, (status = 'pending' and expires_at < now()) as expired_now";

const SAME_PAIR =
  "least(from_id, to_id) = least($1::uuid, $2::uuid) and greatest(from_id, to_id) = greatest($1::uuid, $2::uuid)";

/** A pending request past its deadline reads as expired even before anything persists that. */
function toRow(r: RawRequest): FriendRequestRow {
  return {
    id: r.id,
    fromId: r.from_id,
    toId: r.to_id,
    status: r.expired_now ? "expired" : r.status,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  };
}

/** Refusals are values, not throws, so an expiry write can commit alongside the refusal. */
export type Refusal =
  | "not_found"
  | "blocked"
  | "already_friends"
  | "request_pending"
  | "request_expired"
  | "request_not_pending";

export type Outcome<T> = ({ ok: true } & T) | { ok: false; code: Refusal };

export async function sendRequest(t: Tx, fromId: string, toId: string): Promise<Outcome<{ id: string }>> {
  await lockPair(t, fromId, toId);
  if (await blockBetween(t, fromId, toId)) return { ok: false, code: "blocked" };
  if (await areFriends(t, fromId, toId)) return { ok: false, code: "already_friends" };
  // Lapsed pending requests are persisted as expired so they free the one-pending-per-pair slot.
  await t.query(
    `update friend_requests set status = 'expired', resolved_at = now()
      where status = 'pending' and expires_at < now() and ${SAME_PAIR}`,
    [fromId, toId],
  );
  const pending = await t.query(`select 1 from friend_requests where status = 'pending' and ${SAME_PAIR}`, [fromId, toId]);
  if ((pending.rowCount ?? 0) > 0) return { ok: false, code: "request_pending" };
  const { rows } = await t.query<{ id: string }>(
    `insert into friend_requests (from_id, to_id, expires_at)
     values ($1, $2, now() + make_interval(hours => $3)) returning id`,
    [fromId, toId, REQUEST_TTL_HOURS],
  );
  return { ok: true, id: rows[0]!.id };
}

export type Decision = "accept" | "reject" | "withdraw";

/**
 * Resolves a pending request as `actor`. Only the recipient may accept/reject, only the sender may
 * withdraw; anyone else, or an unknown id, is `not_found`. `accept` also creates the friendship and
 * ensures the direct conversation, returning its id; when the pair already had one (re-befriending),
 * a "friendship restored" notice is appended to it.
 */
export async function decideRequest(
  t: Tx,
  actor: string,
  requestId: string,
  decision: Decision,
): Promise<Outcome<{ fromId: string; toId: string; conversationId: string | null; notices: StoredMessage[] }>> {
  const peek = await t.query<{ from_id: string; to_id: string }>(
    "select from_id, to_id from friend_requests where id = $1",
    [requestId],
  );
  const first = peek.rows[0];
  if (!first || (actor !== first.from_id && actor !== first.to_id)) return { ok: false, code: "not_found" };
  await lockPair(t, first.from_id, first.to_id);

  const { rows } = await t.query<RawRequest>(
    `select ${REQUEST_COLUMNS} from friend_requests where id = $1 for update`,
    [requestId],
  );
  const req = rows[0]!;
  const allowed = decision === "withdraw" ? actor === req.from_id : actor === req.to_id;
  if (!allowed) return { ok: false, code: "not_found" };

  if (req.status !== "pending") return { ok: false, code: "request_not_pending" };
  if (req.expired_now) {
    await t.query("update friend_requests set status = 'expired', resolved_at = now() where id = $1", [requestId]);
    return { ok: false, code: "request_expired" };
  }

  // A block created after the request was sent (block cancels pending ones, but be strict under the lock).
  if (decision === "accept" && (await blockBetween(t, req.from_id, req.to_id))) return { ok: false, code: "blocked" };

  const status = decision === "accept" ? "accepted" : decision === "reject" ? "rejected" : "withdrawn";
  await t.query("update friend_requests set status = $2, resolved_at = now() where id = $1", [requestId, status]);

  let conversationId: string | null = null;
  const notices: StoredMessage[] = [];
  if (decision === "accept") {
    const [lo, hi] = orderedPair(req.from_id, req.to_id);
    await t.query("insert into friendships (a_id, b_id) values ($1, $2) on conflict do nothing", [lo, hi]);
    // Only an existing conversation gets the notice; a new one starts empty.
    const restored = await appendDirectNotice(t, { event: "friendship_restored", actorId: actor, principalId: req.from_id });
    if (restored) notices.push(restored);
    conversationId = await ensureDirect(t, req.from_id, req.to_id, actor);
  }
  return { ok: true, fromId: req.from_id, toId: req.to_id, conversationId, notices };
}

/** Participant-only view of one request; `null` for unknown ids and for everyone else. */
export async function readRequest(db: Queryable, actor: string, requestId: string): Promise<FriendRequestRow | null> {
  const { rows } = await db.query<RawRequest>(
    `select ${REQUEST_COLUMNS} from friend_requests where id = $1 and (from_id = $2 or to_id = $2)`,
    [requestId, actor],
  );
  return rows[0] ? toRow(rows[0]) : null;
}

/**
 * Removes the friendship; the direct conversation and its history stay, and get a "friendship ended"
 * notice. `not_found` if not friends.
 */
export async function unfriend(
  t: Tx,
  actor: string,
  other: string,
): Promise<Outcome<{ conversationId: string | null; notices: StoredMessage[]; ended: EndedRuns }>> {
  await lockPair(t, actor, other);
  const [lo, hi] = orderedPair(actor, other);
  const del = await t.query("delete from friendships where a_id = $1 and b_id = $2", [lo, hi]);
  if ((del.rowCount ?? 0) === 0) return { ok: false, code: "not_found" };
  const notice = await appendDirectNotice(t, { event: "friendship_ended", actorId: actor, principalId: other });
  // Unfriending is just unfriending (Owner decision 2026-11-25): no bar, no cooldown, nothing in anyone's stopped list. What follows from
  // the friendship being gone: the rows admitted BECAUSE of it (basis `contacts`) between the two sides' Agents and people end, as an
  // ordinary ending (`left`: the pair may be admitted again by the same policy once they are friends again); a row the owner approved
  // one by one is not touched. After the notice (the lock order); ONE ending for all of them, which locks every Agent's row before any
  // of their runs (T2 fix 2, R3), never one Agent's runs before the next Agent's row.
  const friendRows = await t.query<{ agent_id: string; subject_id: string }>(
    `select c.agent_id, c.subject_id from agent_contacts c join principals ag on ag.id = c.agent_id
      where c.state = 'live' and c.basis = 'contacts'
        and ((ag.owner_id = $1 and c.person_id = $2) or (ag.owner_id = $2 and c.person_id = $1))
      order by c.agent_id, c.subject_id`,
    [actor, other],
  );
  const byAgent = new Map<string, string[]>();
  for (const r of friendRows.rows) byAgent.set(r.agent_id, [...(byAgent.get(r.agent_id) ?? []), r.subject_id]);
  const grants = [...byAgent].map(([agentId, subjectIds]) => ({ agentId, subjectIds }));
  // No group run is touched (A-5 review m8).
  const done = grants.length === 0 ? null : await endGrants(t, { grants }, "left", { groups: false });
  const ended: EndedRuns = { cancelled: done?.cancelled ?? [], running: done?.running ?? [] };
  return { ok: true, conversationId: notice?.conversationId ?? null, notices: notice ? [notice] : [], ended };
}

export interface RequestEntry {
  id: string;
  principal: PublicPrincipal;
  createdAt: string;
  expiresAt: string;
}

export interface SocialView {
  friends: PublicPrincipal[];
  incoming: RequestEntry[];
  outgoing: RequestEntry[];
  /** Whom the caller blocked: a person or an Agent (`kind`; an Agent by its full handle), never an Agent that is deleted. */
  blocked: Array<PublicPrincipal & { kind: "human" | "agent" }>;
  blockedBy: PublicPrincipal[];
}

type PRow = { id: string; handle: string; display_name: string; avatar_version: number };
type RRow = PRow & { rid: string; created_at: Date; expires_at: Date };

const pub = (r: PRow): PublicPrincipal => ({ id: r.id, handle: r.handle, displayName: r.display_name, avatarVersion: r.avatar_version });
const entry = (r: RRow): RequestEntry => ({
  id: r.rid,
  principal: pub(r),
  createdAt: r.created_at.toISOString(),
  expiresAt: r.expires_at.toISOString(),
});

/** The caller's own friends, live pending requests, and block lists; nothing about anyone else's. */
export async function socialView(db: Queryable, me: string): Promise<SocialView> {
  const friends = await db.query<PRow>(
    `select p.id, p.handle::text as handle, p.display_name, p.avatar_version
       from friendships f join principals p on p.id = case when f.a_id = $1 then f.b_id else f.a_id end
      where f.a_id = $1 or f.b_id = $1 order by p.handle`,
    [me],
  );
  const requests = (mine: "r.to_id" | "r.from_id", theirs: "r.from_id" | "r.to_id") =>
    db.query<RRow>(
      `select r.id as rid, r.created_at, r.expires_at, p.id, p.handle::text as handle, p.display_name, p.avatar_version
         from friend_requests r join principals p on p.id = ${theirs}
        where ${mine} = $1 and r.status = 'pending' and r.expires_at >= now()
        order by r.created_at desc`,
      [me],
    );
  const incoming = await requests("r.to_id", "r.from_id");
  const outgoing = await requests("r.from_id", "r.to_id");
  // A deleted Agent is left out: its handle is free to name another Agent (048), and a row under it would point at the wrong one.
  const blocked = await db.query<PRow & { kind: "human" | "agent" }>(
    `select p.id, ${handleOf("p")} as handle, p.display_name, p.avatar_version, p.kind from blocks b join principals p on p.id = b.blocked_id
      where b.blocker_id = $1 and not exists (select 1 from agents ag where ag.principal_id = p.id and ag.deleted_at is not null) order by p.handle`,
    [me],
  );
  const blockedBy = await db.query<PRow>(
    `select p.id, p.handle::text as handle, p.display_name, p.avatar_version from blocks b join principals p on p.id = b.blocker_id
      where b.blocked_id = $1 order by p.handle`,
    [me],
  );
  return {
    friends: friends.rows.map(pub),
    incoming: incoming.rows.map(entry),
    outgoing: outgoing.rows.map(entry),
    blocked: blocked.rows.map((r) => ({ ...pub(r), kind: r.kind })),
    blockedBy: blockedBy.rows.map(pub),
  };
}
