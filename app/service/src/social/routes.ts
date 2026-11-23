import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { uuidParam } from "../schemas.ts";
import type { Tx } from "../db.ts";
import { AppError } from "../errors.ts";
import { perPrincipalLimit } from "../limits.ts";
import type { StoredMessage } from "../messages/model.ts";
import { agentSeenSql, findByHandle, HANDLE_PATTERN } from "../principals/store.ts";
import { requirePrincipal } from "../session.ts";
import { blockChanged, blockPrincipal, unblockPrincipal, type BlockResult } from "./blocks.ts";
import type { SocialListener } from "./events.ts";
import {
  decideRequest,
  readRequest,
  sendRequest,
  socialView,
  unfriend,
  type Outcome,
  type Refusal,
} from "./friends.ts";

const STATUS: Record<Refusal, number> = {
  not_found: 404,
  blocked: 403,
  already_friends: 409,
  request_pending: 409,
  request_expired: 409,
  request_not_pending: 409,
};

/** Subscribe to "these principals' friends/blocks/requests changed" (fires after commit). Returns unsubscribe. */
export function onSocialChanged(app: FastifyInstance, fn: SocialListener): () => void {
  return app.deps.social.on(fn);
}

const publicPrincipal = z.object({ id: z.string(), handle: z.string(), displayName: z.string(), avatarVersion: z.number() });
const requestEntry = z.object({
  id: z.string(),
  principal: publicPrincipal,
  createdAt: z.string(),
  expiresAt: z.string(),
});
const ok = z.object({ ok: z.literal(true) });
const empty = z.object({});

/** What a social change did to the pair's direct conversation. */
interface DirectEffects {
  /** Notices appended to it (friendship ended/restored, block added/removed). */
  notices?: StoredMessage[];
  /** A direct conversation whose sendability or existence changed even without a notice (a first accept). */
  conversationId?: string | null;
}

export function registerSocialRoutes(app: FastifyInstance): void {
  const { db, social, conversations } = app.deps;
  const api = app.withTypeProvider<ZodTypeProvider>();

  const createLimit = perPrincipalLimit(app, 20);
  // Each block or unblock that changes something appends a notice to the pair's direct chat, which the other
  // side cannot stop: both together share one budget.
  const blockLimit = perPrincipalLimit(app, 20);

  /** After commit: the pair's social change, its direct-chat notices, and that chat's change of state. */
  function announce(req: FastifyRequest, pair: string[], effects: DirectEffects): void {
    social.emit(pair, req.log);
    const notices = effects.notices ?? [];
    const changed = new Set(notices.map((n) => n.conversationId));
    if (effects.conversationId) changed.add(effects.conversationId);
    conversations.publish(
      { messages: notices, conversations: [...changed].map((conversationId) => ({ conversationId, principalIds: pair })) },
      req.log,
    );
  }

  /**
   * Runs a mutation in one transaction. A refusal commits whatever the mutation wrote (e.g. a lazily
   * persisted expiry) and then becomes an error response; success is announced only after commit.
   */
  async function run<T>(
    req: FastifyRequest,
    fn: (t: Tx) => Promise<Outcome<T>>,
    affected: (r: T) => string[],
  ): Promise<T> {
    const result = await db.tx(fn);
    if (!result.ok) throw new AppError(STATUS[result.code], result.code);
    announce(req, affected(result), result as DirectEffects);
    return result;
  }

  api.post(
    "/api/friend-requests",
    {
      schema: {
        params: empty,
        querystring: empty,
        body: z.object({
          handle: z
            .string()
            .max(100)
            .transform((s) => s.toLowerCase())
            .pipe(z.string().regex(HANDLE_PATTERN)),
        }),
        response: { 201: z.object({ id: z.string() }) },
      },
    },
    async (req, reply) => {
      const me = await requirePrincipal(req);
      await createLimit(req, me.id);

      const target = await findByHandle(db, req.body.handle);
      if (!target) throw new AppError(404, "not_found");
      if (target.id === me.id) throw new AppError(400, "invalid_request");
      const r = await run(req, (t) => sendRequest(t, me.id, target.id), () => [me.id, target.id]);
      return reply.code(201).send({ id: r.id });
    },
  );

  api.get(
    "/api/friend-requests/:id",
    {
      schema: {
        params: z.object({ id: uuidParam }),
        querystring: empty,
        response: {
          200: z.object({
            id: z.string(),
            status: z.enum(["pending", "accepted", "rejected", "withdrawn", "expired"]),
            fromId: z.string(),
            toId: z.string(),
            createdAt: z.string(),
            expiresAt: z.string(),
          }),
        },
      },
    },
    async (req) => {
      const me = await requirePrincipal(req);
      const r = await readRequest(db, me.id, req.params.id);
      if (!r) throw new AppError(404, "not_found");
      return {
        id: r.id,
        status: r.status,
        fromId: r.fromId,
        toId: r.toId,
        createdAt: r.createdAt.toISOString(),
        expiresAt: r.expiresAt.toISOString(),
      };
    },
  );

  for (const decision of ["accept", "reject", "withdraw"] as const) {
    api.post(
      `/api/friend-requests/:id/${decision}`,
      {
        schema: {
          params: z.object({ id: uuidParam }),
          querystring: empty,
          response: { 200: z.object({ ok: z.literal(true), conversationId: z.string().nullable() }) },
        },
      },
      async (req) => {
        const me = await requirePrincipal(req);
        const r = await run(req, (t) => decideRequest(t, me.id, req.params.id, decision), (x) => [x.fromId, x.toId]);
        return { ok: true as const, conversationId: r.conversationId };
      },
    );
  }

  api.delete(
    "/api/friends/:principalId",
    { schema: { params: z.object({ principalId: uuidParam }), querystring: empty, response: { 200: ok } } },
    async (req) => {
      const me = await requirePrincipal(req);
      const other = req.params.principalId;
      await run(req, (t) => unfriend(t, me.id, other), () => [me.id, other]);
      return { ok: true as const };
    },
  );

  api.put(
    "/api/blocks/:principalId",
    { schema: { params: z.object({ principalId: uuidParam }), querystring: empty, response: { 200: ok } } },
    async (req) => {
      const me = await requirePrincipal(req);
      await blockLimit(req, me.id);
      const other = req.params.principalId;
      if (other === me.id) throw new AppError(400, "invalid_request");
      const result = await db.tx(async (t): Promise<Outcome<BlockResult>> => {
        // A person can be blocked. An Agent can be too, only while the switch is on and only by someone who sees it (it is
        // discoverable to them, or they share a conversation with it now, or they already block it: blocking again is the same 200):
        // for anyone else its id is answered as an id that is no principal. Its own owner cannot (400). An Agent's block writes no bar.
        const principal = await t.query<{ kind: "human" | "agent"; owner_id: string | null; seen: boolean }>(
          `select p.kind, p.owner_id,
                  (p.kind = 'agent' and ${app.deps.config.social.enabled ? "true" : "false"}
                   and ${agentSeenSql("p", "$2::uuid", app.deps.config)}) as seen
             from principals p where p.id = $1`,
          [other, me.id],
        );
        const target = principal.rows[0];
        if (!target || (target.kind === "agent" && !target.seen)) return { ok: false, code: "not_found" };
        if (target.kind === "agent" && target.owner_id === me.id) throw new AppError(400, "invalid_request");
        return { ok: true, ...(await blockPrincipal(t, me.id, other)) };
      });
      if (!result.ok) throw new AppError(STATUS[result.code], result.code);
      // Blocking again is idempotent: the same 200, and no event when nothing changed.
      if (blockChanged(result)) announce(req, [me.id, other], result);
      return { ok: true as const };
    },
  );

  api.delete(
    "/api/blocks/:principalId",
    { schema: { params: z.object({ principalId: uuidParam }), querystring: empty, response: { 200: ok } } },
    async (req) => {
      const me = await requirePrincipal(req);
      await blockLimit(req, me.id);
      const other = req.params.principalId;
      const r = await db.tx((t) => unblockPrincipal(t, me.id, other));
      if (r.removed) announce(req, [me.id, other], r);
      return { ok: true as const };
    },
  );

  api.get(
    "/api/social",
    {
      schema: {
        params: empty,
        querystring: empty,
        response: {
          200: z.object({
            friends: z.array(publicPrincipal),
            incoming: z.array(requestEntry),
            outgoing: z.array(requestEntry),
            blocked: z.array(publicPrincipal.extend({ kind: z.enum(["human", "agent"]) })),
            blockedBy: z.array(publicPrincipal),
          }),
        },
      },
    },
    async (req) => socialView(db, (await requirePrincipal(req)).id),
  );
}
