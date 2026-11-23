import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { onSessionEnded } from "../auth/auth.ts";
import { perPrincipalLimit } from "../limits.ts";
import { wireMessageSchema } from "../messages/model.ts";
import { syncPrincipalSchema } from "../messages/principals.ts";
import { requirePrincipal } from "../session.ts";
import { wireWhisperSchema } from "../whispers/wire.ts";
import { Hub } from "./hub.ts";
import { notFound } from "../errors.ts";
import { uuidParam } from "../schemas.ts";
import { CATCHUP_MAX_POSITIONS, catchUp, syncConversation, syncView } from "./read.ts";
import { createTicketStore, type TicketStore } from "./tickets.ts";
import { registerWebSocketRoute } from "./ws.ts";

const empty = z.object({});
const role = z.enum(["speaker", "observer"]);

/** One conversation as the caller sees it: an element of `/api/sync`'s `conversations`, and `GET /api/conversations/:id`. */
const conversationEntry = z.object({
  id: z.string(),
  type: z.enum(["direct", "group", "agent", "agent_social"]),
  title: z.string().nullable(),
  creatorId: z.string().optional(),
  avatarVersion: z.number().optional(),
  myRole: role,
  closed: z.boolean(),
  createdAt: z.string(),
  peerId: z.string().optional(),
  agentId: z.string().optional(),
  agent: z.object({ paused: z.boolean(), deleted: z.boolean() }).optional(),
  canSend: z.object({ ok: z.boolean(), reason: z.enum(["blocked", "not_friends", "closed", "agent_deleted", "no_access", "agent_unavailable"]).optional() }),
  // Social conversations only: the two participants and their Agents with their owners (nothing owner-only).
  social: z.object({ participants: z.tuple([z.string(), z.string()]), agents: z.array(z.object({ id: z.string(), ownerId: z.string() })) }).optional(),
  members: z.array(z.object({ id: z.string(), role, isCreator: z.boolean() })),
  lastSeq: z.number(),
  readSeq: z.number(),
  unread: z.number(),
  peerReadSeq: z.number().optional(),
  // The caller's own open whispers there, when there are any (src/whispers/).
  whispers: z.number().optional(),
});

const syncResponse = z.object({
  me: z.object({ id: z.string(), handle: z.string(), displayName: z.string(), avatarVersion: z.number(), email: z.string() }),
  // The site's Agent social switch.
  social: z.object({ enabled: z.boolean() }),
  conversations: z.array(conversationEntry),
  principals: z.array(syncPrincipalSchema),
  messages: z.array(wireMessageSchema),
  whispers: z.array(wireWhisperSchema).optional(),
});

/** `{conversationId: lastSeqTheClientHas}`: ≤ 500 uuid keys (case-insensitive, lower-cased), bounded non-negative integers. */
const positions = z
  .record(z.uuid(), z.number().int().min(0).max(Number.MAX_SAFE_INTEGER))
  .refine((r) => Object.keys(r).length <= CATCHUP_MAX_POSITIONS, "too many positions")
  .refine((r) => new Set(Object.keys(r).map((k) => k.toLowerCase())).size === Object.keys(r).length, "duplicate id")
  .transform((r) => new Map(Object.entries(r).map(([id, seq]) => [id.toLowerCase(), seq])));

const catchUpResponse = z.object({ messages: z.array(wireMessageSchema), gone: z.array(z.string()), more: z.boolean(), whispers: z.array(wireWhisperSchema).optional() });

function registerSyncRoutes(app: FastifyInstance, tickets: TicketStore): void {
  const { db, config } = app.deps;
  const api = app.withTypeProvider<ZodTypeProvider>();
  const ticketLimit = perPrincipalLimit(app, 30);
  const syncLimit = perPrincipalLimit(app, 60);
  const conversationLimit = perPrincipalLimit(app, 120);
  const catchUpLimit = perPrincipalLimit(app, 60);

  api.get(
    "/api/sync",
    { schema: { params: empty, querystring: empty, response: { 200: syncResponse } } },
    async (req) => {
      const me = await requirePrincipal(req);
      await syncLimit(req, me.id);
      const view = await syncView(db, me.id, config);
      return { me: { id: me.id, handle: me.handle, displayName: me.displayName, avatarVersion: me.avatarVersion, email: me.email }, ...view };
    },
  );

  // What a client fetches on a `conversation` push instead of a full sync. Not a current member: 404, like
  // an id that does not exist.
  api.get(
    "/api/conversations/:id",
    { schema: { params: z.object({ id: uuidParam }), querystring: empty, response: { 200: conversationEntry } } },
    async (req) => {
      const me = await requirePrincipal(req);
      await conversationLimit(req, me.id);
      const entry = await syncConversation(db, me.id, req.params.id, config);
      if (!entry) throw notFound();
      return entry;
    },
  );

  api.post(
    "/api/sync/catchup",
    {
      schema: { params: empty, querystring: empty, body: z.object({ positions }), response: { 200: catchUpResponse } },
    },
    async (req) => {
      const me = await requirePrincipal(req);
      await catchUpLimit(req, me.id);
      return catchUp(db, me.id, req.body.positions, config);
    },
  );

  api.post(
    "/api/ws-ticket",
    {
      // No body (Fastify passes null) or an empty JSON object.
      schema: { params: empty, querystring: empty, body: empty.nullish(), response: { 200: z.object({ ticket: z.string() }) } },
    },
    async (req) => {
      const me = await requirePrincipal(req);
      await ticketLimit(req, me.id);
      return { ticket: tickets.issue({ principalId: me.id, sessionId: me.sessionId }) };
    },
  );
}

/**
 * Sync, catch-up and pushes: `GET /api/sync`, `POST /api/sync/catchup`, `POST /api/ws-ticket`,
 * `GET /api/ws`. The ticket store and the hub live in this process (single instance; see README). `heartbeat`: whether
 * the hub's heartbeat runs on its timer (app.ts `BuildOptions.heartbeat`).
 */
export async function registerSync(app: FastifyInstance, opts: { heartbeat: boolean } = { heartbeat: true }): Promise<void> {
  const { db, config, conversations, social, reads } = app.deps;
  const tickets = createTicketStore();
  const hub = new Hub({ db, config, conversations, social, reads, log: app.log });
  hub.start(opts);
  const offSessionEnded = onSessionEnded(app, (_principalId, sessionId) => {
    tickets.revokeSession(sessionId);
    hub.endSession(sessionId);
  });
  app.addHook("onClose", async () => {
    offSessionEnded();
    hub.stop();
  });
  app.decorate("realtime", hub);

  // The WebSocket plugin first: it wraps (through an onRoute hook) only routes registered after it, and
  // refusing an upgrade to any other route relies on that.
  await registerWebSocketRoute(app, hub, tickets);
  registerSyncRoutes(app, tickets);
}
