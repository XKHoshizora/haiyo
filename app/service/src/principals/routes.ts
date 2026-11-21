import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { chosenModel } from "../models/choice.ts";
import { displayName, uuidParam } from "../schemas.ts";
import { AppError } from "../errors.ts";
import { perPrincipalLimit } from "../limits.ts";
import { assertModelChoice } from "../agents/store.ts";
import { paidSiteChoice } from "../memory/call.ts";
import { MEMORY_LANGUAGE_CODES } from "../memory/language.ts";
import { setDream, setMemoryLanguage, setMemoryModel, setNewNotes } from "../memory/store.ts";
import { requirePrincipal } from "../session.ts";
import { defaultAvatarSvg } from "./avatar.ts";
import { AVATAR_HEADERS, avatarBudget, readStoredAvatar, registerAvatarPut, storeAvatar } from "./avatar-upload.ts";
import { changeHandle, findAvatarSubject, findByHandle, HANDLE_PATTERN, swapAvatarKey, updateDisplayName } from "./store.ts";

const publicPrincipal = z.object({ id: z.string(), handle: z.string(), displayName: z.string(), avatarVersion: z.number() });

export function registerPrincipalRoutes(app: FastifyInstance): void {
  const { db, blobs } = app.deps;
  const api = app.withTypeProvider<ZodTypeProvider>();

  // Handle lookup is the only way to probe for handles, so it is throttled per principal.
  const lookupLimit = perPrincipalLimit(app, 30);
  // Others see both everywhere (and every avatar is a blob write): 10 changes a minute each; the avatar budget also
  // counts your Agents' avatars.
  const renameLimit = perPrincipalLimit(app, 10);
  const avatarLimit = avatarBudget(app);

  api.patch(
    "/api/me",
    {
      schema: {
        params: z.object({}),
        querystring: z.object({}),
        body: z
          .object({
            displayName: displayName.optional(),
            handle: z.string().regex(HANDLE_PATTERN).optional(),
            newNotes: z.enum(["auto", "vault", "open"]).optional(),
            memoryModel: chosenModel(uuidParam).nullable().optional(),
            dream: z.boolean().optional(),
            memoryLanguage: z.enum(MEMORY_LANGUAGE_CODES).nullable().optional(),
          })
          .refine(
            (b) =>
              b.displayName !== undefined || b.handle !== undefined || b.newNotes !== undefined || b.memoryModel !== undefined || b.dream !== undefined || b.memoryLanguage !== undefined,
            "displayName, handle, newNotes, memoryModel, dream or memoryLanguage",
          ),
        response: { 200: publicPrincipal },
      },
    },
    async (req) => {
      const me = await requirePrincipal(req);
      await renameLimit(req, me.id);
      const { displayName: name, handle, newNotes, memoryModel, dream, memoryLanguage } = req.body;
      // All or nothing: a model or a handle that is refused changes nothing, the name and the setting included.
      const renamed = await db.tx(async (t): Promise<{ agents: Array<{ id: string; deleted: boolean }> } | null> => {
        // As an Agent's model is chosen: a site model that exists, or a model on the list of the owner's own provider. Memory the site
        // pays for runs only on free-tier site models: a paid one is refused as an unknown one is.
        if (memoryModel !== undefined && memoryModel !== null) {
          if (paidSiteChoice(app.deps.config, memoryModel)) throw new AppError(400, "invalid_request");
          await assertModelChoice(t, me.id, memoryModel, "none", app.deps.config);
        }
        // Once a year (`changeHandle`); the Agents' full handles follow by themselves (`handleOf`). It locks the person's row
        // as an update that changes no key does (`for no key update`), before anything below takes their account's (the
        // settings): no foreign key's check on that row — a send of theirs, a settlement, a run queued for them — waits for
        // it, so nothing waits in a circle whichever order those take the two rows in (final review m-7; round 2, N-2).
        const changed = handle !== undefined && (await changeHandle(t, me.id, handle));
        if (name !== undefined) await updateDisplayName(t, me.id, name);
        if (newNotes !== undefined) await setNewNotes(t, me.id, newNotes);
        if (memoryModel !== undefined) await setMemoryModel(t, me.id, memoryModel);
        if (dream !== undefined) await setDream(t, me.id, dream);
        if (memoryLanguage !== undefined) await setMemoryLanguage(t, me.id, memoryLanguage);
        // The Agents' ids are read here, in the change's own transaction: nothing after it commits may turn it into an error.
        if (!changed) return null;
        const agents = await t.query<{ id: string; deleted: boolean }>(
          "select p.id, a.deleted_at is not null as deleted from principals p join agents a on a.principal_id = p.id where p.owner_id = $1 order by p.id",
          [me.id],
        );
        return { agents: agents.rows };
      });
      if (renamed) {
        // Whoever sees them, or one of their Agents that is not deleted (a deleted one is in no group), is told the new
        // handle, as an avatar change is told (`pushPrincipalChanged`); their own clients refetch each Agent. Best effort:
        // the change has committed, and a client that missed a push reads the handle at its next sync.
        const announce = async (push: () => unknown): Promise<void> => {
          try {
            await push();
          } catch (err) {
            req.log.error({ err }, "handle change announcement failed");
          }
        };
        await announce(() => app.realtime.pushPrincipalChanged(me.id));
        for (const { id, deleted } of renamed.agents) {
          if (!deleted) await announce(() => app.realtime.pushPrincipalChanged(id));
          await announce(() => app.realtime.pushAgentChanged(me.id, id));
        }
      }
      return { id: me.id, handle: renamed ? handle! : me.handle, displayName: name ?? me.displayName, avatarVersion: me.avatarVersion };
    },
  );

  api.get(
    "/api/principals/lookup",
    {
      schema: {
        params: z.object({}),
        querystring: z.object({
          handle: z
            .string()
            .max(100)
            .transform((s) => s.toLowerCase())
            .pipe(z.string().regex(HANDLE_PATTERN)),
        }),
        response: { 200: publicPrincipal },
      },
    },
    async (req) => {
      const me = await requirePrincipal(req);
      await lookupLimit(req, me.id);
      const found = await findByHandle(db, req.query.handle);
      if (!found) throw new AppError(404, "not_found");
      return found;
    },
  );

  const avatarSchema = { params: z.object({ id: uuidParam }), querystring: z.object({}) };

  /**
   * What `GET`/`HEAD /api/principals/:id/avatar` answer with: the stored image (its type from the bytes,
   * only when browsers may show it) or the generated SVG. `whole: false` reads no more than the sniffing
   * prefix of a stored image, so a HEAD does not drain the blob. Any person's; an Agent's for its owner and for whoever
   * shares a conversation with it now (anybody else: the 404 of an id that is no principal; `findAvatarSubject`).
   */
  async function avatarOf(
    req: FastifyRequest<{ Params: { id: string } }>,
    whole: boolean,
  ): Promise<{ type: string; body: Buffer | string; complete: boolean }> {
    const me = await requirePrincipal(req);
    const subject = await findAvatarSubject(db, req.params.id, me.id);
    if (!subject) throw new AppError(404, "not_found");
    const stored = subject.avatarKey ? await readStoredAvatar(blobs, subject.avatarKey, whole) : null;
    if (stored) return stored;
    return { type: "image/svg+xml", body: defaultAvatarSvg(subject.displayName, subject.id), complete: true };
  }

  // Declared before the GET, so Fastify does not derive a HEAD from it (that one would read the whole blob).
  // The same decision and headers; of a stored image only the first bytes are read, so there is no
  // `Content-Length` for it (the generated SVG has one).
  app.withTypeProvider<ZodTypeProvider>().head("/api/principals/:id/avatar", { schema: avatarSchema }, async (req, reply) => {
    const found = await avatarOf(req, false);
    reply.headers(AVATAR_HEADERS).type(found.type);
    if (found.complete) reply.header("content-length", String(Buffer.byteLength(found.body)));
    return reply.send();
  });

  api.get("/api/principals/:id/avatar", { schema: avatarSchema }, async (req, reply) => {
    const found = await avatarOf(req, true);
    return reply.headers(AVATAR_HEADERS).type(found.type).send(found.body);
  });

  registerAvatarPut(app, "/api/me/avatar", z.object({}), async (req, body) => {
    const me = await requirePrincipal(req);
    await avatarLimit(req, me.id);
    await storeAvatar(app, req.log, body, (t, key) => swapAvatarKey(t, me.id, key));
    await app.realtime.pushPrincipalChanged(me.id);
  });
}
