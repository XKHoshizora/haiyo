import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { announceEnded } from "../agents/group-leave.ts";
import { AVATAR_HEADERS, avatarBudget, dropAvatar, readStoredAvatar, registerAvatarPut, storeAvatar } from "../principals/avatar-upload.ts";
import { notFound } from "../errors.ts";
import { perPrincipalLimit } from "../limits.ts";
import { agentProfileShape } from "../messages/principals.ts";
import { groupTitle, uuidParam } from "../schemas.ts";
import { requirePrincipal } from "../session.ts";
import type { Change } from "./events.ts";
import { addMember, createGroup, groupAvatarKey, removeMember, renameGroup, swapGroupAvatar } from "./groups.ts";
import { listMembers } from "./store.ts";
import { pushWhispers } from "../whispers/routes.ts";

const empty = z.object({});
const ok = z.object({ ok: z.literal(true) });
const idParams = z.object({ id: uuidParam });

export function registerConversationRoutes(app: FastifyInstance): void {
  const { db, conversations, blobs } = app.deps;
  const api = app.withTypeProvider<ZodTypeProvider>();

  const createLimit = perPrincipalLimit(app, 10);
  // Renaming, adding and removing (or leaving) each append a notice every member gets: one shared budget.
  const changeLimit = perPrincipalLimit(app, 20);

  api.post(
    "/api/conversations",
    {
      schema: {
        params: empty,
        querystring: empty,
        body: z.object({
          title: groupTitle,
          // Bounded only to keep input small; the 500-member rule is a 403 in createGroup.
          memberIds: z.array(uuidParam).min(2).max(1000),
        }),
        response: { 201: z.object({ id: z.string() }) },
      },
    },
    async (req, reply) => {
      const me = await requirePrincipal(req);
      await createLimit(req, me.id);

      const { conversationId, change } = await db.tx((t) => createGroup(t, me.id, req.body.title, req.body.memberIds));
      conversations.publish(change, req.log);
      return reply.code(201).send({ id: conversationId });
    },
  );

  api.patch(
    "/api/conversations/:id",
    {
      schema: {
        params: idParams,
        querystring: empty,
        body: z.object({ title: groupTitle }),
        response: { 200: z.object({ id: z.string(), title: z.string() }) },
      },
    },
    async (req) => {
      const me = await requirePrincipal(req);
      await changeLimit(req, me.id);
      const change = await db.tx((t) => renameGroup(t, req.params.id, me.id, req.body.title));
      conversations.publish(change, req.log);
      return { id: req.params.id, title: req.body.title };
    },
  );

  // The group's avatar: only the creator changes it. A change counts in the avatar budget (shared with a person's and an
  // Agent's avatars: every one is a blob write) and in the budget of the other group changes.
  const avatarLimit = avatarBudget(app);
  registerAvatarPut(app, "/api/conversations/:id/avatar", idParams, async (req, body) => {
    const me = await requirePrincipal(req);
    await changeLimit(req, me.id);
    await avatarLimit(req, me.id);
    const id = (req.params as { id: string }).id;
    let change: Change | null = null;
    await storeAvatar(app, req.log, body, async (t, key) => {
      const swapped = await swapGroupAvatar(t, id, me.id, key);
      change = swapped.change;
      return swapped.previous;
    });
    if (change) conversations.publish(change, req.log);
  });

  api.delete(
    "/api/conversations/:id/avatar",
    { schema: { params: idParams, querystring: empty, response: { 200: ok } } },
    async (req) => {
      const me = await requirePrincipal(req);
      await changeLimit(req, me.id);
      let change: Change | null = null;
      await dropAvatar(app, req.log, async (t) => {
        const swapped = await swapGroupAvatar(t, req.params.id, me.id, null);
        change = swapped.change;
        return swapped.previous;
      });
      if (change) conversations.publish(change, req.log);
      return { ok: true as const };
    },
  );

  /** What `GET`/`HEAD …/avatar` answer: the stored image, to a current member only; 404 for everyone else and for a group without one. */
  async function avatarOf(req: FastifyRequest<{ Params: { id: string } }>, whole: boolean) {
    const me = await requirePrincipal(req);
    const key = await groupAvatarKey(db, req.params.id, me.id);
    const stored = key ? await readStoredAvatar(blobs, key, whole) : null;
    if (!stored) throw notFound();
    return stored;
  }
  const avatarSchema = { params: idParams, querystring: empty };
  // Declared before the GET, so Fastify does not derive a HEAD from it (that one would read the whole blob).
  app.withTypeProvider<ZodTypeProvider>().head("/api/conversations/:id/avatar", { schema: avatarSchema }, async (req, reply) => {
    const found = await avatarOf(req, false);
    reply.headers(AVATAR_HEADERS).type(found.type);
    if (found.complete) reply.header("content-length", String(found.body.length));
    return reply.send();
  });
  api.get("/api/conversations/:id/avatar", { schema: avatarSchema }, async (req, reply) => {
    const found = await avatarOf(req, true);
    return reply.headers(AVATAR_HEADERS).type(found.type).send(found.body);
  });

  api.get(
    "/api/conversations/:id/members",
    {
      schema: {
        params: idParams,
        querystring: empty,
        response: {
          200: z.object({
            members: z.array(
              z.object({
                id: z.string(),
                handle: z.string(),
                displayName: z.string(),
                avatarVersion: z.number(),
                kind: z.enum(["human", "agent"]),
                role: z.enum(["speaker", "observer"]),
                isCreator: z.boolean(),
                ...agentProfileShape,
              }),
            ),
          }),
        },
      },
    },
    async (req) => {
      const me = await requirePrincipal(req);
      const members = await listMembers(db, me.id, req.params.id);
      if (!members) throw notFound();
      return { members };
    },
  );

  api.post(
    "/api/conversations/:id/members",
    {
      schema: {
        params: idParams,
        querystring: empty,
        body: z.object({ principalId: uuidParam }),
        response: { 201: ok },
      },
    },
    async (req, reply) => {
      const me = await requirePrincipal(req);
      await changeLimit(req, me.id);
      const change = await db.tx((t) => addMember(t, req.params.id, me.id, req.body.principalId));
      conversations.publish(change, req.log);
      return reply.code(201).send({ ok: true as const });
    },
  );

  api.delete(
    "/api/conversations/:id/members/:principalId",
    {
      schema: {
        params: z.object({ id: uuidParam, principalId: uuidParam }),
        querystring: empty,
        response: { 200: ok },
      },
    },
    async (req) => {
      const me = await requirePrincipal(req);
      await changeLimit(req, me.id);
      const { change, ended, whispers, personLeft } = await db.tx((t) => removeMember(t, req.params.id, me.id, req.params.principalId));
      // The replies of the Agents that left end (as a pause ends them) before the answer.
      announceEnded(app.agentPort, ended);
      conversations.publish(change, req.log);
      // The whispers that leaving expired, each to its owner (after the leaving's own pushes); and the person who left, her
      // whispers elsewhere that point here, as they read now (found on her own queue: the hub's).
      pushWhispers(app.realtime, whispers);
      if (personLeft) app.realtime.pushWhispersPointingInto(personLeft, req.params.id);
      return { ok: true as const };
    },
  );
}
