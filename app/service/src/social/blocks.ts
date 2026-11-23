import type { EndedRuns } from "../agents/group-leave.ts";
import { appendDirectNotice } from "../conversations/store.ts";
import type { Tx } from "../db.ts";
import type { StoredMessage } from "../messages/model.ts";
import { endGrants, liftBlockBar, setBar } from "./agent-contacts.ts";
import { lockPair } from "./pair.ts";

// The read-only pair questions live in relations.ts (a leaf module conversations can import).
export { areFriends, blockBetween, canDirectSend } from "./relations.ts";

export interface BlockResult {
  /** False when the block already existed. */
  created: boolean;
  /** Live pending requests this block cancelled (withdrawn if the blocker sent it, rejected if received). */
  cancelledRequestIds: string[];
  /** The "blocked" notice in the pair's direct conversation, when the block is new and they have one. */
  notices: StoredMessage[];
  /** The replies a new block stopped (a block of an Agent ends its blocker's row on it, `left`): the caller runs `announceEnded`. */
  ended: EndedRuns;
}

const SAME_PAIR =
  "least(from_id, to_id) = least($1::uuid, $2::uuid) and greatest(from_id, to_id) = greatest($1::uuid, $2::uuid)";

/**
 * Blocking is one-directional, leaves any friendship alone, and cancels live pending requests between the
 * pair. A pending request already past its deadline is recorded as what it already reads as: expired.
 * Nothing changes (and nothing is to be announced) when the block existed already: `created` is false and
 * no request is cancelled, since none can be sent while it exists.
 */
export async function blockPrincipal(t: Tx, blocker: string, blocked: string): Promise<BlockResult> {
  await lockPair(t, blocker, blocked);
  const ins = await t.query(
    "insert into blocks (blocker_id, blocked_id) values ($1, $2) on conflict do nothing",
    [blocker, blocked],
  );
  await t.query(
    `update friend_requests set status = 'expired', resolved_at = now()
      where status = 'pending' and expires_at < now() and ${SAME_PAIR}`,
    [blocker, blocked],
  );
  const cancelled = await t.query<{ id: string }>(
    `update friend_requests
        set status = case when from_id = $1 then 'withdrawn' else 'rejected' end, resolved_at = now()
      where status = 'pending' and ${SAME_PAIR}
      returning id`,
    [blocker, blocked],
  );
  const created = (ins.rowCount ?? 0) > 0;
  const notice = created ? await appendDirectNotice(t, { event: "blocked", actorId: blocker, principalId: blocked }) : null;
  // After the notice (the lock order). Blocking a person writes the bar, through the one writer, in this transaction, and it ends
  // every row between the two sides. Blocking an Agent ends the blocker's own row on it, `left`, and stops what they called on it;
  // it writes no bar (a bar is between two people).
  let ended: EndedRuns = { cancelled: [], running: [] };
  if (created) {
    const kind = (await t.query<{ kind: "human" | "agent" }>("select kind from principals where id = $1", [blocked])).rows[0]?.kind;
    if (kind === "agent") ended = await endGrants(t, { agentId: blocked, subjectIds: [blocker] }, "left");
    else if (kind === "human") ended = await setBar(t, blocker, blocked, "stopped", "block");
  }
  return { created, cancelledRequestIds: cancelled.rows.map((r) => r.id), notices: notice ? [notice] : [], ended };
}

/** Whether a block call changed anything others should hear about. */
export const blockChanged = (r: BlockResult): boolean => r.created || r.cancelledRequestIds.length > 0;

/** Restores nothing but the ability to interact. Returns whether a block was removed, and its notice. */
export async function unblockPrincipal(
  t: Tx,
  blocker: string,
  blocked: string,
): Promise<{ removed: boolean; notices: StoredMessage[] }> {
  await lockPair(t, blocker, blocked);
  const del = await t.query("delete from blocks where blocker_id = $1 and blocked_id = $2", [blocker, blocked]);
  const removed = (del.rowCount ?? 0) > 0;
  const notice = removed ? await appendDirectNotice(t, { event: "unblocked", actorId: blocker, principalId: blocked }) : null;
  // The bar this block set goes with it (or passes to the other person's block); a stop's bar stays.
  if (removed) await liftBlockBar(t, blocker, blocked);
  return { removed, notices: notice ? [notice] : [] };
}
