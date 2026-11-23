import type { FastifyInstance } from "fastify";
import { lockConversation } from "../../src/conversations/store.ts";
import { appendSystem } from "../../src/conversations/system.ts";
import { orderedPair } from "../../src/social/pair.ts";
import type { ContactBasis } from "../../src/social/agent-contacts.ts";
import type { Actor } from "./actors.ts";

// Agent social fixtures (plan, Step 0 T0.3). FROZEN from Step 0's merge: both lanes seed their social conversations through
// these two functions, so a change here is a change of what every lane's tests stand on.

/** The `config` override of a test that runs with the site's Agent social switch on (`useApp({ config: SOCIAL_ON })`). */
export const SOCIAL_ON: { social: { enabled: true } } = { social: { enabled: true } };

export interface SocialSeed {
  conversationId: string;
  agentId: string;
  ownerId: string;
  /** The person (or Agent) who reached the Agent. */
  subjectId: string;
}

/**
 * A person `visitor` reached `owner`'s Agent `agentId` and was let in, written straight into the database as the add flow's
 * own write would leave it (lane A's A4 compares the two): an `agent_social` conversation created by the visitor, its pair
 * (`social_pairs`), the members — the visitor a speaker from seq 0, the Agent a speaker from seq 0, the owner an observer from
 * seq 0 —, a `live` row in `agent_contacts` (`basis` `approved` unless asked otherwise) and the first message, the
 * `social_opened` notice (seq 1).
 */
export async function seedSocial(app: FastifyInstance, o: { owner: Actor; agentId: string; visitor: Actor; basis?: ContactBasis }): Promise<SocialSeed> {
  return app.deps.db.tx(async (t) => {
    const created = await t.query<{ id: string }>("insert into conversations (type, creator_id) values ('agent_social', $1) returning id", [o.visitor.id]);
    const conversationId = created.rows[0]!.id;
    const [lo, hi] = orderedPair(o.visitor.id, o.agentId);
    await t.query("insert into social_pairs (conversation_id, a_id, b_id) values ($1, $2, $3)", [conversationId, lo, hi]);
    await t.query(
      `insert into memberships (conversation_id, principal_id, role, joined_seq)
       values ($1, $2, 'speaker', 0), ($1, $3, 'speaker', 0), ($1, $4, 'observer', 0)`,
      [conversationId, o.visitor.id, o.agentId, o.owner.id],
    );
    await t.query(
      `insert into agent_contacts (agent_id, subject_id, person_id, state, basis) values ($1, $2, $2, 'live', $3)`,
      [o.agentId, o.visitor.id, o.basis ?? "approved"],
    );
    await lockConversation(t, conversationId);
    await appendSystem(t, conversationId, { event: "social_opened", actorId: o.agentId, agentIds: [o.agentId], ownerIds: [o.owner.id] });
    return { conversationId, agentId: o.agentId, ownerId: o.owner.id, subjectId: o.visitor.id };
  });
}

/**
 * Agent `x` reached Agent `y` (an Agent↔Agent conversation, which ring 1 never makes itself and the errands plan will): the same
 * rows as `seedSocial`, with both Agents speakers and each Agent's owner an observer (once, when one person owns both). The
 * `live` row is `y`'s, its subject `x` and its person `x`'s owner. `ownerId` is `y`'s owner, `subjectId` is `x`.
 */
export async function seedSocialAgents(app: FastifyInstance, o: { x: string; y: string }): Promise<SocialSeed> {
  return app.deps.db.tx(async (t) => {
    const owners = await t.query<{ id: string; owner_id: string }>("select id, owner_id from principals where id = any($1::uuid[]) and kind = 'agent'", [[o.x, o.y]]);
    const ownerOf = new Map(owners.rows.map((r) => [r.id, r.owner_id]));
    const ownerX = ownerOf.get(o.x);
    const ownerY = ownerOf.get(o.y);
    if (!ownerX || !ownerY) throw new Error("seedSocialAgents: both ids must be Agents");
    const created = await t.query<{ id: string }>("insert into conversations (type, creator_id) values ('agent_social', $1) returning id", [ownerX]);
    const conversationId = created.rows[0]!.id;
    const [lo, hi] = orderedPair(o.x, o.y);
    await t.query("insert into social_pairs (conversation_id, a_id, b_id) values ($1, $2, $3)", [conversationId, lo, hi]);
    await t.query(`insert into memberships (conversation_id, principal_id, role, joined_seq) values ($1, $2, 'speaker', 0), ($1, $3, 'speaker', 0)`, [conversationId, o.x, o.y]);
    for (const owner of [...new Set([ownerX, ownerY])]) {
      await t.query(`insert into memberships (conversation_id, principal_id, role, joined_seq) values ($1, $2, 'observer', 0)`, [conversationId, owner]);
    }
    await t.query(`insert into agent_contacts (agent_id, subject_id, person_id, state, basis) values ($1, $2, $3, 'live', 'approved')`, [o.y, o.x, ownerX]);
    await lockConversation(t, conversationId);
    await appendSystem(t, conversationId, { event: "social_opened", actorId: o.y, agentIds: [o.x, o.y], ownerIds: [...new Set([ownerX, ownerY])] });
    return { conversationId, agentId: o.y, ownerId: ownerY, subjectId: o.x };
  });
}
