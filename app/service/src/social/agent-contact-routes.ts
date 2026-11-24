import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { announceEnded } from "../agents/group-leave.ts";
import { AppError, notFound } from "../errors.ts";
import { perPrincipalLimit } from "../limits.ts";
import { answerPersonaFact } from "../memory/persona-aid.ts";
import { positiveIntString, userText, uuidParam } from "../schemas.ts";
import { requirePrincipal } from "../session.ts";
import { reportAgent, REPORT_REASONS } from "./reports.ts";
import { addContact, applyPolicy, approveContact, contactsOf, contactsOfAgent, declineContact, liftBar, removeContact, setBar, socialConversationsBetween } from "./agent-contacts.ts";

// Lane A's route plugin (plan "Step 0 interfaces", Routes; README "Agent social"). Step 0 wired it in `app.ts` and registered NO route;
// a lane adds a route by writing it here and, in the same edit, what every route has (plan File map, "shared, row per route"): its
// probe row in tests/fuzz.test.ts, its README heading, and, if the name is new, its path parameter in tests/logging.test.ts.
// Here so far (A4): POST and GET /api/agent-contacts; POST …/:agentId/:subjectId/approve and /decline; DELETE …/:agentId/:subjectId.
// (A5b): PUT and DELETE /api/bars/:personId.
// (A5c): GET /api/agents/:id/contacts; PUT /api/agents/:id/contact-policy.
// (A10): POST /api/reports. (A8b): POST /api/agents/:id/persona-facts/:seq.
// Planned: PUT /api/agents/:id/note-verdicts. While `SOCIAL.enabled` is false every one of them
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
  // A stop ends rows and runs of the other side: one budget for stopping and resuming, as blocks share one.
  const barLimit = perPrincipalLimit(app, 20);
  // A report: five a minute (it writes a row the operator reads).
  const reportLimit = perPrincipalLimit(app, 5);
  const cardLimit = perPrincipalLimit(app, 30);

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

  /**
   * After a stop: the setter refetches; the other person too, and the social conversations between the two sides (a person's, or
   * their Agents') are published to their human members, only when something of theirs ended (`changed`): otherwise nothing of
   * theirs differs, and a frame would tell them that a bar was set (A-3 review m3).
   */
  async function announceBar(req: FastifyRequest, setter: string, other: string, changed: boolean): Promise<void> {
    social.emit(changed ? [setter, other] : [setter], req.log);
    if (changed) conversations.publish({ messages: [], conversations: await socialConversationsBetween(db, setter, other) }, req.log);
  }

  /** After a narrowing: the owner and every person whose row ended refetch, and their conversations are published; two statements in all. */
  async function announceNarrowed(req: FastifyRequest, agentId: string, ownerId: string, subjectIds: readonly string[]): Promise<void> {
    if (subjectIds.length === 0) {
      social.emit([ownerId], req.log);
      return;
    }
    const { rows } = await db.query<{ conversation_id: string; humans: string[] | null; person_id: string }>(
      `select sp.conversation_id, coalesce(s.owner_id, s.id) as person_id,
              (select array_agg(m.principal_id) from memberships m join principals mp on mp.id = m.principal_id
                where m.conversation_id = sp.conversation_id and m.left_seq is null and mp.kind = 'human') as humans
         from principals s left join social_pairs sp on sp.a_id = least(s.id, $1::uuid) and sp.b_id = greatest(s.id, $1::uuid)
        where s.id = any($2::uuid[])`,
      [agentId, [...subjectIds]],
    );
    social.emit([...new Set([ownerId, ...rows.map((r) => r.person_id)])], req.log);
    conversations.publish(
      { messages: [], conversations: rows.filter((r) => r.conversation_id && r.humans).map((r) => ({ conversationId: r.conversation_id, principalIds: r.humans! })) },
      req.log,
    );
  }

  api.get(
    "/api/agents/:id/contacts",
    {
      schema: {
        params: z.object({ id: uuidParam }),
        querystring: empty,
        response: {
          200: z.object({
            policy: z.enum(["ask", "contacts", "none"]),
            picked: z.boolean(),
            picks: z.array(z.string()),
            rows: z.array(
              z.object({
                subject: subjectView,
                state: z.enum(["requested", "live", "ended"]),
                basis: z.enum(["approved", "contacts"]).nullable(),
                since: z.string(),
                until: z.string().nullable(),
                endReason: z.enum(["declined", "expired", "left", "narrowed", "removed", "barred"]).nullable(),
                conversationId: z.string().nullable(),
              }),
            ),
            conversations: z.array(z.object({ conversationId: z.string(), subject: subjectView })),
          }),
        },
      },
    },
    async (req) => {
      const me = await requirePrincipal(req);
      requireSocial();
      const view = await contactsOfAgent(db, me.id, req.params.id);
      if (!view) throw notFound();
      return view;
    },
  );

  api.put(
    "/api/agents/:id/contact-policy",
    {
      schema: {
        params: z.object({ id: uuidParam }),
        querystring: empty,
        body: z.object({
          policy: z.enum(["ask", "contacts", "none"]),
          picked: z.boolean(),
          picks: z.array(uuidParam).max(500),
          dryRun: z.boolean().optional(),
        }),
        response: { 200: z.object({ ends: z.number() }) },
      },
    },
    async (req) => {
      const me = await requirePrincipal(req);
      requireSocial();
      const { dryRun, ...next } = req.body;
      const done = await db.tx((t) => applyPolicy(t, me.id, req.params.id, next, { dryRun: dryRun === true }));
      if (dryRun !== true) {
        announceEnded(app.agentPort, done.ended);
        await announceNarrowed(req, req.params.id, me.id, done.subjects);
      }
      return { ends: done.ends };
    },
  );

  api.put(
    "/api/bars/:personId",
    { schema: { params: z.object({ personId: uuidParam }), querystring: empty, response: { 200: z.object({ ok: z.literal(true), ended: z.number() }) } } },
    async (req) => {
      const me = await requirePrincipal(req);
      requireSocial();
      await barLimit(req, me.id);
      const other = req.params.personId;
      if (other === me.id) throw new AppError(400, "invalid_request");
      // A person only: an Agent's id, like an unknown one, is not found.
      const kind = (await db.query<{ kind: string }>("select kind from principals where id = $1", [other])).rows[0]?.kind;
      if (kind !== "human") throw notFound();
      const ended = await db.tx((t) => setBar(t, me.id, other, "stop"));
      announceEnded(app.agentPort, ended);
      await announceBar(req, me.id, other, ended.ended > 0);
      return { ok: true as const, ended: ended.ended };
    },
  );

  api.delete(
    "/api/bars/:personId",
    { schema: { params: z.object({ personId: uuidParam }), querystring: empty, response: { 200: ok } } },
    async (req) => {
      const me = await requirePrincipal(req);
      // NOT behind the switch (fix round 1, I4): what a person set they can always lift. With it off no stop can be made (`PUT` is 404), and
      // for someone who has none this answers the same 404 as ever.
      await barLimit(req, me.id);
      const other = req.params.personId;
      // Only the caller's own stop: every other case (none, the other person's, a block's) is the same 404. Nothing of the other
      // person's changes, so only the caller is told.
      if (!(await db.tx((t) => liftBar(t, me.id, other)))) throw notFound();
      social.emit([me.id], req.log);
      return { ok: true as const };
    },
  );

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

  api.post(
    "/api/reports",
    {
      schema: {
        params: empty,
        querystring: empty,
        body: z.object({ agentId: uuidParam, reason: z.enum(REPORT_REASONS), note: userText(0, 500).optional() }),
        response: { 201: z.object({ id: z.string() }) },
      },
    },
    async (req, reply) => {
      const me = await requirePrincipal(req);
      requireSocial();
      await reportLimit(req, me.id);
      const note = req.body.note?.trim();
      // An Agent the reporter cannot see is the answer of one that is not there (the avatar rule): nothing tells them apart.
      const id = await reportAgent(db, config, me.id, req.body.agentId, req.body.reason, note ? note : null);
      if (id === null) throw notFound();
      req.log.info({ metric: "agent_reported", reason: req.body.reason }, "an Agent was reported");
      return reply.code(201).send({ id });
    },
  );

  api.post(
    "/api/agents/:id/persona-facts/:seq",
    {
      schema: {
        params: z.object({ id: uuidParam, seq: positiveIntString() }),
        querystring: empty,
        body: z.object({ move: z.boolean() }),
        response: { 200: z.object({ ok: z.literal(true), moved: z.boolean() }) },
      },
    },
    async (req) => {
      const me = await requirePrincipal(req);
      requireSocial();
      await cardLimit(req, me.id);
      const { moved } = await answerPersonaFact(db, config, me.id, req.params.id, req.params.seq, req.body.move);
      if (moved) app.realtime.pushAgentChanged(me.id, req.params.id);
      return { ok: true as const, moved };
    },
  );
}
