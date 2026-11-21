import { endRunsInGroup, type EndedRuns } from "../agents/group-leave.ts";
import type { Queryable, Tx } from "../db.ts";
import { AppError, notFound } from "../errors.ts";
import type { StoredMessage } from "../messages/model.ts";
import { lockPair, lockPairs } from "../social/pair.ts";
import { areFriends, blockBetween } from "../social/relations.ts";
import type { Change } from "./events.ts";
import {
  MAX_GROUP_MEMBERS,
  currentMemberIds,
  currentMembers,
  currentMembership,
  lockConversation,
  peekConversation,
  type ConversationRow,
  type Membership,
} from "./store.ts";
import { appendSystem } from "./system.ts";
import { expireOnLeave, type Whisper } from "../whispers/store.ts";
import { forgetSummaries } from "../agents/summary/store.ts";
import { holdBlob } from "../attachments/pending.ts";

const forbidden = () => new AppError(403, "forbidden");

/** Only friends without a block in either direction may put each other into a group. Caller holds the pair lock. */
async function mayAdd(t: Tx, actorId: string, targetId: string): Promise<boolean> {
  return (await areFriends(t, actorId, targetId)) && !(await blockBetween(t, actorId, targetId));
}

/**
 * Locks an open group for a change by `actorId`: the pair lock with `pairWith` first (when the change
 * checks their relationship), then the row. 404 for direct chats, closed or missing groups and non-members.
 */
async function lockGroup(
  t: Tx,
  conversationId: string,
  actorId: string,
  pairWith?: string,
): Promise<{ conversation: ConversationRow; membership: Membership }> {
  const peek = await peekConversation(t, conversationId);
  if (peek?.type !== "group") throw notFound();
  if (pairWith !== undefined && pairWith !== actorId) await lockPair(t, actorId, pairWith);
  const conversation = await lockConversation(t, conversationId);
  if (!conversation || conversation.closedAt) throw notFound();
  const membership = await currentMembership(t, conversationId, actorId);
  if (!membership) throw notFound();
  return { conversation, membership };
}

/**
 * A group of the creator and at least two of the creator's friends (distinct, not the creator), all
 * speakers from seq 0; nobody needs to confirm. 403 `forbidden` if any is not a friend, a block exists
 * either way, or the group would exceed 500.
 */
export async function createGroup(
  t: Tx,
  creatorId: string,
  title: string,
  memberIds: string[],
): Promise<{ conversationId: string; change: Change }> {
  if (new Set(memberIds).size !== memberIds.length || memberIds.length < 2 || memberIds.includes(creatorId)) {
    throw new AppError(400, "invalid_request");
  }
  if (memberIds.length + 1 > MAX_GROUP_MEMBERS) throw forbidden();
  await lockPairs(t, memberIds.map((m) => [creatorId, m] as const));
  for (const m of memberIds) if (!(await mayAdd(t, creatorId, m))) throw forbidden();

  const { rows } = await t.query<{ id: string }>(
    "insert into conversations (type, title, creator_id) values ('group', $1, $2) returning id",
    [title, creatorId],
  );
  const id = rows[0]!.id;
  const everyone = [creatorId, ...memberIds];
  await t.query(
    `insert into memberships (conversation_id, principal_id, role, joined_seq)
     select $1, p, 'speaker', 0 from unnest($2::uuid[]) as p`,
    [id, everyone],
  );
  await lockConversation(t, id);
  const notice = await appendSystem(t, id, { event: "group_created", actorId: creatorId, title, memberIds });
  return {
    conversationId: id,
    change: { messages: [notice], conversations: [{ conversationId: id, principalIds: everyone }] },
  };
}

/** What a principal is, or null for an unknown id. Read without a lock: neither `kind` nor `owner_id` ever changes. */
async function principalOf(q: Queryable, principalId: string): Promise<{ kind: "human" | "agent"; ownerId: string | null } | null> {
  const { rows } = await q.query<{ kind: "human" | "agent"; owner_id: string | null }>("select kind, owner_id from principals where id = $1", [principalId]);
  return rows[0] ? { kind: rows[0].kind, ownerId: rows[0].owner_id } : null;
}

/**
 * Any current member adds one of their own friends, or their own Agent (`addAgent`). The newcomer's `joined_seq` is
 * the seq at this moment, so they see the "joined" notice and nothing before it. 409 `already_member`; 403 `forbidden`
 * for non-friends, blocks either way, or a 501st member.
 */
export async function addMember(t: Tx, conversationId: string, actorId: string, targetId: string): Promise<Change> {
  const target = await principalOf(t, targetId);
  if (target?.kind === "agent") return addAgent(t, conversationId, actorId, targetId, target.ownerId);
  const { conversation } = await lockGroup(t, conversationId, actorId, targetId);
  if (await currentMembership(t, conversationId, targetId)) throw new AppError(409, "already_member");
  if (!(await mayAdd(t, actorId, targetId))) throw forbidden();
  return seat(t, conversation, actorId, targetId);
}

/**
 * The join step of `addMember` and `addAgent`, after their own checks, under the group's row: the 500 cap (403
 * `forbidden`), the membership with `joined_seq` = the seq at this moment (the newcomer reads from the notice on), and
 * the `member_joined` notice (actor: whoever added).
 */
async function seat(t: Tx, conversation: ConversationRow, actorId: string, principalId: string): Promise<Change> {
  const conversationId = conversation.id;
  const before = await currentMemberIds(t, conversationId);
  if (before.length + 1 > MAX_GROUP_MEMBERS) throw forbidden();
  await t.query(
    `insert into memberships (conversation_id, principal_id, role, joined_seq) values ($1, $2, 'speaker', $3)`,
    [conversationId, principalId, conversation.seq],
  );
  const notice = await appendSystem(t, conversationId, { event: "member_joined", actorId, principalId });
  return { messages: [notice], conversations: [{ conversationId, principalIds: [...before, principalId] }] };
}

/**
 * An Agent joins a group only by its owner's hand, and only a group its owner is in (design rule 1); its owner leaving
 * takes it out again (`removeMember`). Anyone else gets the 403 `forbidden` a random id gets (who owns an Agent is not
 * to be learnt from this), and so does its owner for a deleted Agent; a paused one may join. An Agent has no friends or
 * blocks: no pair lock, no friendship rule. The `agents` row is locked after the group's row (the lock order), so a
 * delete has either committed — refused here — or waits for this add to commit, and then its follow-up finds the Agent
 * in this group and takes it out (agents/group-leave.ts). Otherwise as a person: 409 `already_member`, the 500 cap,
 * `joined_seq`, the `member_joined` notice (actor: the owner).
 */
async function addAgent(t: Tx, conversationId: string, actorId: string, agentId: string, ownerId: string | null): Promise<Change> {
  const { conversation } = await lockGroup(t, conversationId, actorId);
  if (ownerId !== actorId) throw forbidden();
  const { rows } = await t.query<{ deleted: boolean }>("select deleted_at is not null as deleted from agents where principal_id = $1 for update", [agentId]);
  if (rows[0]?.deleted !== false) throw forbidden();
  if (await currentMembership(t, conversationId, agentId)) throw new AppError(409, "already_member");
  return seat(t, conversation, actorId, agentId);
}

/**
 * Leaving (target = actor; anyone) or removal (the creator removes anyone; an Agent's owner also removes their Agent;
 * anyone else gets 403 `forbidden`, the same for an Agent as for any id). `left_seq` is the seq of the notice, so the
 * one who left does not see it.
 *
 * A person who leaves or is removed takes their Agents in the group along (design rule 4: an Agent is only ever where
 * its owner is), in this transaction under the group's row: each Agent first, in join order, with a `member_left` of its
 * own (actor: its owner) whose seq ends its membership, then the person's own notice. The Agents' replies in this group
 * end (`endRunsInGroup`, `agent_removed`), as do a removed Agent's: the caller announces them after commit
 * (`announceEnded`). No `agents` row is locked for this: the group's row serialises it with sends and the worker.
 *
 * When the creator leaves, the earliest remaining person (lowest `joined_seq`, ties by membership id) becomes creator,
 * never an Agent (plan ruling 9); when no person remains the group closes (and then no Agent remains either: each left
 * with its owner).
 */
export async function removeMember(
  t: Tx,
  conversationId: string,
  actorId: string,
  targetId: string,
): Promise<{ change: Change; ended: EndedRuns; whispers: Whisper[]; personLeft: string | null; droppedAvatar: string | null }> {
  const target = await principalOf(t, targetId);
  const { conversation, membership } = await lockGroup(t, conversationId, actorId);
  const leaving = targetId === actorId;
  const agent = target?.kind === "agent";
  if (!leaving && conversation.creatorId !== actorId && !(agent && target.ownerId === actorId)) throw forbidden();
  const targetMembership = leaving ? membership : await currentMembership(t, conversationId, targetId);
  if (!targetMembership) throw notFound();

  const members = await currentMembers(t, conversationId);
  const along = agent ? [] : members.filter((m) => m.ownerId === targetId);
  const out = new Set([targetId, ...along.map((m) => m.principalId)]);
  const people = members.filter((m) => m.kind === "human" && !out.has(m.principalId));
  const newCreatorId = targetId === conversation.creatorId ? (people[0]?.principalId ?? null) : null;

  const messages: StoredMessage[] = [];
  for (const m of along) {
    const notice = await appendSystem(t, conversationId, { event: "member_left", actorId: targetId, principalId: m.principalId, newCreatorId: null });
    await t.query("update memberships set left_seq = $2 where id = $1", [m.membershipId, notice.seq]);
    messages.push(notice);
  }
  const notice = await appendSystem(
    t,
    conversationId,
    leaving
      ? { event: "member_left", actorId, principalId: actorId, newCreatorId }
      : { event: "member_removed", actorId, principalId: targetId },
  );
  await t.query("update memberships set left_seq = $2 where id = $1", [targetMembership.id, notice.seq]);
  messages.push(notice);
  if (newCreatorId) await t.query("update conversations set creator_id = $2 where id = $1", [conversationId, newCreatorId]);
  // A group that closes keeps no avatar: nobody can read it any more, and a referenced blob is never swept. Its key is held
  // here and the route deletes the blob after commit (as `dropAvatar` does).
  let droppedAvatar: string | null = null;
  if (people.length === 0) {
    const { rows } = await t.query<{ avatar_key: string | null }>("select avatar_key from conversations where id = $1", [conversationId]);
    droppedAvatar = rows[0]?.avatar_key ?? null;
    await t.query(
      "update conversations set closed_at = now(), avatar_key = null, avatar_version = avatar_version + (avatar_key is not null)::int where id = $1",
      [conversationId],
    );
    if (droppedAvatar) await holdBlob(t, droppedAvatar);
  }
  const ended = await endRunsInGroup(t, conversationId, agent ? [targetId] : along.map((m) => m.principalId));
  // The whispers there of whoever left, and about the Agents that left, expire (src/whispers/): pushed to their owners after commit.
  const whispers = await expireOnLeave(t, conversationId, [...out]);
  // An Agent that left loses its rolling summary of the group (agents/summary/), here, with its membership.
  await forgetSummaries(t, conversationId, [...out]);
  // A person who left can no longer read what was said here: `personLeft`, whose whispers elsewhere that point here are
  // found and pushed to her after commit, on her own queue (sync/hub.ts `pushWhispersPointingInto`) — nothing of hers is
  // read here, so nothing of this transaction's time depends on her whispers.
  return { change: { messages, conversations: [{ conversationId, principalIds: members.map((m) => m.principalId) }] }, ended, whispers, personLeft: agent ? null : targetId, droppedAvatar };
}

/** Only the creator renames. Renaming to the current title changes nothing and announces nothing. */
export async function renameGroup(t: Tx, conversationId: string, actorId: string, title: string): Promise<Change> {
  const { conversation } = await lockGroup(t, conversationId, actorId);
  if (conversation.creatorId !== actorId) throw forbidden();
  if (conversation.title === title) return { messages: [], conversations: [] };
  await t.query("update conversations set title = $2 where id = $1", [conversationId, title]);
  const notice = await appendSystem(t, conversationId, { event: "group_renamed", actorId, title });
  const members = await currentMemberIds(t, conversationId);
  return { messages: [notice], conversations: [{ conversationId, principalIds: members }] };
}

/**
 * Only the creator changes the group's avatar (the member who may also remove others; when the creator leaves, the next one
 * may). Under the group's row, like a rename. `newKey` is the new blob's key, or null to take the avatar away. Returns the
 * previous key (to hold in this transaction and delete after it commits: null when there was none) and what to announce: the
 * members are told as for a rename, but no notice is written in the group. Taking away what is not there changes and
 * announces nothing; every other change counts in `avatar_version`.
 */
export async function swapGroupAvatar(
  t: Tx,
  conversationId: string,
  actorId: string,
  newKey: string | null,
): Promise<{ previous: string | null; change: Change }> {
  const { conversation } = await lockGroup(t, conversationId, actorId);
  if (conversation.creatorId !== actorId) throw forbidden();
  const { rows } = await t.query<{ avatar_key: string | null }>("select avatar_key from conversations where id = $1", [conversationId]);
  const previous = rows[0]!.avatar_key;
  if (newKey === null && previous === null) return { previous: null, change: { messages: [], conversations: [] } };
  await t.query("update conversations set avatar_key = $2, avatar_version = avatar_version + 1 where id = $1", [conversationId, newKey]);
  const members = await currentMemberIds(t, conversationId);
  return { previous, change: { messages: [], conversations: [{ conversationId, principalIds: members }] } };
}

/** The key of a group's avatar for a current member of it, or null (no avatar, not a group, not a member: not told apart). */
export async function groupAvatarKey(q: Queryable, conversationId: string, viewerId: string): Promise<string | null> {
  const { rows } = await q.query<{ avatar_key: string }>(
    `select c.avatar_key from conversations c
       join memberships m on m.conversation_id = c.id and m.principal_id = $2 and m.left_seq is null
      where c.id = $1 and c.type = 'group' and c.closed_at is null and c.avatar_key is not null`,
    [conversationId, viewerId],
  );
  return rows[0]?.avatar_key ?? null;
}

/**
 * The cheap look, before a 2 MB blob is written, at whether `actorId` may change the group's avatar: the answers of
 * `swapGroupAvatar` (404 unless a current member of an open group, 403 unless its creator). Nothing is locked: the swap
 * checks again under the row.
 */
export async function assertMayChangeAvatar(q: Queryable, conversationId: string, actorId: string): Promise<void> {
  const { rows } = await q.query<{ creator_id: string }>(
    `select c.creator_id from conversations c
       join memberships m on m.conversation_id = c.id and m.principal_id = $2 and m.left_seq is null
      where c.id = $1 and c.type = 'group' and c.closed_at is null`,
    [conversationId, actorId],
  );
  if (!rows[0]) throw notFound();
  if (rows[0].creator_id !== actorId) throw forbidden();
}
