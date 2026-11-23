import type { Tx } from "../db.ts";
import type { ShownNote } from "./passage.ts";

/**
 * The post-time check of a social reply (ring 1b, lane A's A6b): whether every note the reply was shown to a non-owner may still
 * be said to that audience at the moment it is posted (the owner's no, or a stale verdict, stops it). STEP 0: true iff nothing was
 * shown, which is what ring 1a always has (a visitor is shown no owner notes).
 */
export async function shownNotesPass(
  _t: Tx,
  _agent: { id: string; ownerId: string; sharedNotes: boolean },
  _audienceId: string,
  shown: readonly ShownNote[],
): Promise<boolean> {
  return shown.length === 0;
}
