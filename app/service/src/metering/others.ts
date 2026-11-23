import type { Lane } from "../agents/runs.ts";
import type { Config } from "../config.ts";
import type { Tx } from "../db.ts";
import type { PayClass } from "./pool.ts";

// What others' use of an Agent may cost its owner (plan: step L, lane B's B1). STEP 0: the interface and today's behaviour.
// `keepsRoom` is real but nothing calls it yet (lane B replaces `cls === "AB"` at admit.ts, port-impl.ts and tools/web/hold.ts);
// `othersFits` answers yes (lane B writes the rule under the account lock).

export type OthersLane = "others" | "proactive";

/**
 * Whether a reply of this class and lane keeps room for its last call at admission: an `AB` reply as today, and every reply
 * somebody other than the Agent's owner called for. Replaces `cls === "AB"` at admit.ts:193, port-impl.ts:1122 and
 * tools/web/hold.ts:178.
 */
export const keepsRoom = (cls: PayClass, lane: Lane): boolean => cls === "AB" || lane !== "own";

export type OthersVerdict = { ok: true } | { ok: false; heldBackBy: readonly string[] } | { ok: false; limit: "answers" | "points" | "proactive" };

/**
 * Takes the account lock itself. Settled others' charges today + the sum of `hold_micro` of every running others' run, THIS ONE
 * INCLUDED, + `x` must stay within each of the owner's numbers; at admission the answers too. `at`: where it is asked, so that the
 * answers count only at admission. Step 0: always `{ ok: true }`.
 */
export async function othersFits(
  _t: Tx,
  _config: Pick<Config, "others" | "siteTimezone">,
  _run: { id: string; ownerId: string; agentId: string; lane: OthersLane },
  _x: bigint,
  _at: "admission" | "search" | "round",
  _now: Date,
): Promise<OthersVerdict> {
  return { ok: true };
}

/** A run refused by an others' number: which one. */
export class OthersLimit extends Error {
  constructor(readonly limit: "answers" | "points" | "proactive") {
    super(`others' limit reached: ${limit}`);
    this.name = "OthersLimit";
  }
}
