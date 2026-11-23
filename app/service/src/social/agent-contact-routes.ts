import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { announceEnded } from "../agents/group-leave.ts";
import { AppError, notFound } from "../errors.ts";
import { perPrincipalLimit } from "../limits.ts";
import { uuidParam } from "../schemas.ts";
import { requirePrincipal } from "../session.ts";
import { addContact, approveContact, contactsOf, declineContact, removeContact } from "./agent-contacts.ts";

// Lane A's route plugin (plan "Step 0 interfaces", Routes; README "Agent social"). Step 0 wired it in `app.ts` and registered NO route;
// a lane adds a route by writing it here and, in the same edit, what every route has (plan File map, "shared, row per route"): its
// probe row in tests/fuzz.test.ts, its README heading, and, if the name is new, its path parameter in tests/logging.test.ts.
// Here so far (A4): POST and GET /api/agent-contacts; POST …/:agentId/:subjectId/approve and /decline; DELETE …/:agentId/:subjectId.
// Planned: GET /api/agents/:id/contacts; PUT /api/agents/:id/contact-policy; PUT and DELETE /api/bars/:personId; POST /api/reports;
// PUT /api/agents/:id/note-verdicts; POST /api/agents/:id/persona-facts/:seq. While `SOCIAL.enabled` is false every one of them
// answers 404 (the lookup, `GET /api/principals/lookup`, is not here: it exists already).
const empty = z.object({});
const ok = z.object({ ok: z.literal(true) });
const pairParams = z.object({ agentId: uuidParam, subjectId: uuidParam });
const live = z.object({ state: z.literal("live"), conversationId: z.string() });
const subjectView = z.object({
  id: z.string(),
  handle: z.string(),
  displayName: z.string(),
  avatarVersion: z.number(),
  kind: z.enum(["human", "agent"]),
  ownerId: z.string().optional(),
  ownerName: z.string().optional(),
});

export function registerAgentContactRoutes(app: FastifyInstance): void {
  const { db, config, social, conversations } = app.deps;
  const api = app.withTypeProvider<ZodTypeProvider>();
  const addLimit = perPrincipalLimit(app, 20);

  /** Every lane-A route answers 404 while the site's switch is off; after the session (and the terms) have been asked. */
  const requireSocial = (): void => {
    if (!config.social.enabled) throw notFound();
  };

  /**
   * After commit: both sides refetch their lists, and the pair's conversation, if it has one, changed state for its humans (a new
   * one, or one that opened or shut): they are told, so that a client shows it, or its `canSend`, without waiting for a refetch.
   */
  async function announce(req: FastifyRequest, agentId: string, subjectId: string): Promise<void> {
    const { rows } = await db.query<{ conversation_id: string | null; person_id: string; owner_id: string; humans: string[] | null }>(
      `select sp.conversation_id, coalesce(s.owner_id, s.id) as person_id, a.owner_id,
              (select array_agg(m.principal_id) from memberships m join principals mp on mp.id = m.principal_id
                where m.conversation_id = sp.conversation_id and m.left_seq is null and mp.kind = 'human') as humans
         from principals a, principals s
         left join social_pairs sp on sp.a_id = least(s.id, $1::uuid) and sp.b_id = greatest(s.id, $1::uuid)
        where a.id = $1 and s.id = $2`,
      [agentId, subjectId],
    );
    const r = rows[0];
    if (!r) return;
    social.emit([...new Set([r.person_id, r.owner_id])], req.log);
    if (r.conversation_id && r.humans) conversations.publish({ messages: [], conversations: [{ conversationId: r.conversation_id, principalIds: r.humans }] }, req.log);
  }

  api.post(
    "/api/agent-contacts",
    {
      schema: {
        params: empty,
        querystring: empty,
        body: z.object({ agentId: uuidParam }),
        response: { 201: live, 202: z.object({ state: z.literal("requested"), until: z.string() }) },
      },
    },
    async (req, reply) => {
      const me = await requirePrincipal(req);
      requireSocial();
      await addLimit(req, me.id);
      const outcome = await db.tx((t) => addContact(t, config, me.id, req.body.agentId));
      if ("refused" in outcome) {
        if (outcome.refused === "cooldown") throw new AppError(429, "cooldown", { availableAt: outcome.availableAt.toISOString() });
        if (outcome.refused === "is_yours") throw new AppError(409, "is_yours");
        throw notFound();
      }
      await announce(req, req.body.agentId, me.id);
      if (outcome.state === "requested") return reply.code(202).send({ state: "requested" as const, until: outcome.until.toISOString() });
      return reply.code(201).send(outcome);
    },
  );

  api.get(
    "/api/agent-contacts",
    {
      schema: {
        params: empty,
        querystring: empty,
        response: {
          200: z.object({
            mine: z.array(
              z.object({
                agentId: z.string(),
                state: z.enum(["requested", "live", "ended"]),
                conversationId: z.string().nullable(),
                since: z.string(),
                until: z.string().nullable(),
                ended: z.enum(["declined", "ended"]).nullable(),
              }),
            ),
            waiting: z.array(z.object({ agentId: z.string(), subject: subjectView, since: z.string(), until: z.string() })),
          }),
        },
      },
    },
    async (req) => {
      const me = await requirePrincipal(req);
      requireSocial();
      return contactsOf(db, me.id);
    },
  );

  api.post(
    "/api/agent-contacts/:agentId/:subjectId/approve",
    { schema: { params: pairParams, querystring: empty, response: { 200: live } } },
    async (req) => {
      const me = await requirePrincipal(req);
      requireSocial();
      const { agentId, subjectId } = req.params;
      const result = await db.tx((t) => approveContact(t, me.id, agentId, subjectId));
      if ("refused" in result) throw result.refused === "not_found" ? notFound() : new AppError(409, "not_requested");
      await announce(req, agentId, subjectId);
      return { state: "live" as const, conversationId: result.conversationId };
    },
  );

  api.post(
    "/api/agent-contacts/:agentId/:subjectId/decline",
    { schema: { params: pairParams, querystring: empty, response: { 200: ok } } },
    async (req) => {
      const me = await requirePrincipal(req);
      requireSocial();
      const { agentId, subjectId } = req.params;
      const result = await db.tx((t) => declineContact(t, me.id, agentId, subjectId, config));
      if ("refused" in result) throw result.refused === "not_found" ? notFound() : new AppError(409, "not_requested");
      await announce(req, agentId, subjectId);
      return { ok: true as const };
    },
  );

  api.delete(
    "/api/agent-contacts/:agentId/:subjectId",
    { schema: { params: pairParams, querystring: empty, response: { 200: ok } } },
    async (req) => {
      const me = await requirePrincipal(req);
      requireSocial();
      const { agentId, subjectId } = req.params;
      const ended = await db.tx((t) => removeContact(t, me.id, agentId, subjectId));
      if (!ended) throw notFound();
      announceEnded(app.agentPort, ended);
      await announce(req, agentId, subjectId);
      return { ok: true as const };
    },
  );
}
