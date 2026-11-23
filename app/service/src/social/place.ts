import { peekConversation, type ConversationType } from "../conversations/store.ts";
import type { Queryable } from "../db.ts";

/**
 * Where a run is: the Agent's own conversation with its owner, a group, or an `agent_social` conversation (an Agent and one
 * other party). THE test of it — every site that once asked "is it not the own conversation, so a group?" goes through
 * `placeOf` / `placeOfType` instead. FROZEN from Step 0's merge (plan, Step 0 interfaces).
 */
export type Place = "own" | "group" | "social";

/**
 * The place of a conversation of `type` for `agent`: `own` iff it is the Agent's own conversation, `group` for a group,
 * `social` for an `agent_social` conversation. Throws for anything else: an Agent is in no direct chat, and another Agent's own
 * conversation is not one of this Agent's places.
 */
export function placeOfType(type: ConversationType, conversationId: string, agent: { conversationId: string }): Place {
  if (type === "agent" && conversationId === agent.conversationId) return "own";
  if (type === "group") return "group";
  if (type === "agent_social") return "social";
  throw new Error(`placeOf: an Agent has no place in a ${type} conversation`);
}

/** `placeOfType` of the conversation as stored; throws when there is none. */
export async function placeOf(q: Queryable, conversationId: string, agent: { conversationId: string }): Promise<Place> {
  const peek = await peekConversation(q, conversationId);
  if (!peek) throw new Error("placeOf: no such conversation");
  return placeOfType(peek.type, conversationId, agent);
}

/** SQL: `${c}` (a conversations alias) is a group — every listing of an Agent's memberships beyond its own conversation keeps it. */
export const groupPlaceSql = (c: string): string => `(${c}.type = 'group')`;
/** SQL: `${c}` (a conversations alias) is a social conversation. */
export const socialPlaceSql = (c: string): string => `(${c}.type = 'agent_social')`;
