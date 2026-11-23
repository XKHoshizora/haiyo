import type { EndedRuns } from "../agents/group-leave.ts";
import type { Config } from "../config.ts";
import type { Tx } from "../db.ts";

// Who may reach an Agent, per Agent: rows in `agent_contacts`, the policy that makes them, and the one function that ends them.
// STEP 0: the types both lanes compile against and bodies that throw. Lane A (A4, A5a, A5c) writes the mutations.

export type ContactPolicy = "ask" | "contacts" | "none";
export type ContactState = "requested" | "live" | "ended";
export type ContactBasis = "approved" | "contacts";
export type EndReason = "declined" | "expired" | "left" | "narrowed" | "removed" | "barred";

/** What access to end: all of two people's (an Agent of either's included), or an Agent's for the listed subjects. */
export type GrantScope = { between: readonly [string, string] } | { agentId: string; subjectIds: readonly string[] };

const LANE_A = "ring 1: lane A";

/** The only way access stops; the caller runs `announceEnded` after commit. Lane A (A5a). */
export async function endGrants(_t: Tx, _scope: GrantScope, _reason: "left" | "narrowed" | "removed" | "barred"): Promise<EndedRuns & { ended: number }> {
  throw new Error(LANE_A);
}

export interface PolicyChange {
  policy: ContactPolicy;
  picked: boolean;
  picks: readonly string[];
}

/** An owner's change of who may add an Agent: how many rows it ends (`dryRun`: counted, not ended). Lane A (A5c). */
export async function applyPolicy(_t: Tx, _ownerId: string, _agentId: string, _next: PolicyChange, _opts: { dryRun: boolean }): Promise<{ ends: number; ended: EndedRuns }> {
  throw new Error(LANE_A);
}

export type AddOutcome =
  | { state: "live"; conversationId: string }
  | { state: "requested"; until: Date }
  | { refused: "not_found" | "is_yours" }
  | { refused: "cooldown"; availableAt: Date };

/** A subject asks to add an Agent: let in, or waiting for the owner, or refused. Lane A (A4). */
export async function addContact(_t: Tx, _config: Pick<Config, "social" | "others">, _subjectId: string, _agentId: string): Promise<AddOutcome> {
  throw new Error(LANE_A);
}
