import type { FastifyBaseLogger } from "fastify";
import type { Change, ConversationEvents } from "../conversations/events.ts";
import { currentMemberIds, currentMembership, lockConversation } from "../conversations/store.ts";
import { appendSystem } from "../conversations/system.ts";
import type { Db, Tx } from "../db.ts";
import type { Hub } from "../sync/hub.ts";
import { pushWhispers } from "../whispers/routes.ts";
import { expireOnLeave, type Whisper } from "../whispers/store.ts";
import { forgetSummaries } from "./summary/store.ts";
import type { DbAgentPort } from "./port-impl.ts";
import { dropDeferred, lockActiveRuns, RUN_COLUMNS, toWireRun, type Announced, type RunRow } from "./runs.ts";

/**
 * An Agent leaving a group (design rules 3–5): taken out by the group's creator or its owner, taken along when its owner
 * leaves or is removed (conversations/groups.ts `removeMember`), or after it was deleted (below). Its replies in that
 * group end with it.
 */

/**
 * The runs an ending ended: the cancelled ones to announce after commit, and the running ones to stop; and the pairs (an Agent and a
 * conversation) whose queued run it cancelled outside the conversation's lock order, with calls that may wait behind it: taken after
 * commit (`announceEnded`, runs.ts `consumeIdle`).
 */
export interface EndedRuns {
  cancelled: Announced[];
  running: string[];
  idle?: Array<{ agentId: string; conversationId: string }>;
}

/**
 * In the transaction that takes `agentIds` out of group `conversationId`, which holds the group's row: their active
 * replies there end for good, as a pause ends them (runs.ts `interruptRuns`) but in this group only. A queued one is
 * cancelled, `agent_removed` (it never reached a model: nothing to settle); a running one is marked `interrupted`
 * (`agent_removed`, unless a pause or delete marked it first): `postAsAgent` refuses it and `finish` records it `cancelled`; and
 * every call waiting for them there is dropped (runs.ts `dropDeferred`), so nothing answers anything in a group the Agent is no
 * longer in. The run rows come after the group's row in the lock order, and no `agents` row is locked: holding the
 * group's row is what serialises this with sends there and with the worker, whose every step on a run locks the run's
 * conversation first. Their replies in other conversations are not touched.
 */
export async function endRunsInGroup(t: Tx, conversationId: string, agentIds: readonly string[]): Promise<EndedRuns> {
  if (agentIds.length === 0) return { cancelled: [], running: [] };
  await lockActiveRuns(t, "r.conversation_id = $1 and r.agent_id = any($2::uuid[])", [conversationId, agentIds]);
  const queued = await t.query<RunRow & { owner_id: string }>(
    `update agent_runs as r set status = 'cancelled', error = 'agent_removed', finished_at = now()
      where r.conversation_id = $1 and r.agent_id = any($2::uuid[]) and r.status = 'queued'
      returning ${RUN_COLUMNS}, r.owner_id`,
    [conversationId, agentIds],
  );
  const running = await t.query<{ id: string }>(
    `update agent_runs set interrupted = coalesce(interrupted, 'agent_removed')
      where conversation_id = $1 and agent_id = any($2::uuid[]) and status = 'running' returning id`,
    [conversationId, agentIds],
  );
  await dropDeferred(t, { conversationId, agentIds });
  return {
    cancelled: queued.rows.map((r) => ({ ownerId: r.owner_id, conversationId, run: toWireRun(r) })),
    running: running.rows.map((r) => r.id),
  };
}

/**
 * After that transaction committed, before the request answers, as the pause route does: the running replies' calls are
 * abandoned and nothing more of them reaches anyone; each cancelled one is pushed to its owner; then what waits behind the queued
 * ones an ending cancelled outside the conversation's lock order is taken (`DbAgentPort.consumeIdle`, a transaction per pair; the
 * stale-run sweep takes whatever this misses).
 */
export async function announceEnded(port: Pick<DbAgentPort, "interruptRuns" | "announce" | "consumeIdle">, ended: EndedRuns): Promise<void> {
  port.interruptRuns(ended.running);
  for (const cancelled of ended.cancelled) port.announce(cancelled);
  if (ended.idle && ended.idle.length > 0) await port.consumeIdle(ended.idle);
}


export interface LeaveDeps {
  db: Db;
  conversations: ConversationEvents;
  log: Pick<FastifyBaseLogger, "error">;
  /** Where the whispers a leaving expires go to their owner (none: nobody is told until their next sync). */
  realtime?: Pick<Hub, "pushWhisper">;
}

/**
 * A deleted Agent leaves every open group it is still a current member of (plan ruling 4): one transaction per group,
 * so that no transaction locks more than one conversation row `for update` — the group's, then nothing else (the memory
 * paths that hold several groups' rows hold them `for key share`, taken before anything else: agents/store.ts `lockAgent`) — each appending a
 * `member_left` notice (actor: its owner, who did the deleting; principal: the Agent) whose seq ends the membership, and
 * each published once committed. Its messages there stay. With `agentId`, only that Agent's groups: what
 * `DELETE /api/agents/:id` runs once its own transaction (the dedicated conversation's row, then the `agents` row) has
 * committed. Without, every deleted Agent's: the start-up sweep, for a delete whose leaving did not happen (the process
 * died between the two, or a group's transaction failed). Meanwhile the Agent never replies there: it is deleted, which
 * the trigger and every step of a run refuse. A group whose transaction fails is logged and left for the next start.
 * Whatever of its whispers there was still open expires with it and is pushed to its owner (`deps.realtime`). Returns how
 * many memberships ended.
 */
export async function leaveGroupsOfDeleted(deps: LeaveDeps, agentId?: string): Promise<number> {
  const { rows } = await deps.db.query<{ conversation_id: string; agent_id: string; owner_id: string }>(
    `select ms.conversation_id, ms.principal_id as agent_id, p.owner_id
       from memberships ms
       join agents a on a.principal_id = ms.principal_id
       join principals p on p.id = ms.principal_id
       join conversations c on c.id = ms.conversation_id
      where ms.left_seq is null and a.deleted_at is not null and c.type = 'group' and c.closed_at is null
        ${agentId === undefined ? "" : "and ms.principal_id = $1"}
      order by ms.principal_id, ms.conversation_id`,
    agentId === undefined ? [] : [agentId],
  );
  let left = 0;
  for (const r of rows) {
    let ended: { change: Change; whispers: Whisper[] } | null;
    try {
      ended = await deps.db.tx((t) => leaveAfterDelete(t, r.conversation_id, r.agent_id, r.owner_id));
    } catch (err) {
      deps.log.error({ err, agentId: r.agent_id, conversationId: r.conversation_id }, "a deleted Agent could not leave a group; the next start tries again");
      continue;
    }
    if (!ended) continue;
    left++;
    try {
      deps.conversations.publish(ended.change, deps.log);
      // After the leaving's own pushes: what it expired, to the owner alone.
      if (deps.realtime) pushWhispers(deps.realtime, ended.whispers);
    } catch (err) {
      deps.log.error({ err, agentId: r.agent_id, conversationId: r.conversation_id }, "a deleted Agent left a group (committed), but announcing it failed");
    }
  }
  return left;
}

/** One group of `leaveGroupsOfDeleted`, under the group's row: null when the Agent is no longer in it (or it closed). */
async function leaveAfterDelete(t: Tx, conversationId: string, agentId: string, ownerId: string): Promise<{ change: Change; whispers: Whisper[] } | null> {
  const conversation = await lockConversation(t, conversationId);
  if (!conversation || conversation.closedAt) return null;
  // It may have left meanwhile: taken out, or along with its owner.
  const membership = await currentMembership(t, conversationId, agentId);
  if (!membership) return null;
  const before = await currentMemberIds(t, conversationId);
  const notice = await appendSystem(t, conversationId, { event: "member_left", actorId: ownerId, principalId: agentId, newCreatorId: null });
  await t.query("update memberships set left_seq = $2 where id = $1", [membership.id, notice.seq]);
  // Its whispers there expire with it: the delete expired its open ones already, so this is whatever is left open (none, as
  // `createWhisper` waits for a delete in flight), pushed to its owner all the same — whisper rows last.
  const whispers = await expireOnLeave(t, conversationId, [agentId]);
  // Its rolling summary of the group goes with its membership (agents/summary/).
  await forgetSummaries(t, conversationId, [agentId]);
  return { change: { messages: [notice], conversations: [{ conversationId, principalIds: before }] }, whispers };
}
