import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { tellFromWhisper } from "../agents/runs.ts";
import type { Tx } from "../db.ts";
import { AppError, notFound } from "../errors.ts";
import { perPrincipalLimit } from "../limits.ts";
import { positiveIntString, uuidParam } from "../schemas.ts";
import { requirePrincipal } from "../session.ts";
import type { Hub } from "../sync/hub.ts";
import { listWhispers, resolveWhisper, type Whisper, type WhisperAnswer, type WhisperKind } from "./store.ts";
import { wireWhispers, wireWhisperSchema } from "./wire.ts";

/**
 * What answering a whisper of a kind does besides its status: run in the answer's transaction, after the status is written
 * (the conversation's row, the Agent's `for update` and the whisper's are held, in that order: store.ts's lock order; the
 * hook may lock the Agent's row again — `lockAgent` with the whisper's conversation —, then run rows and accounts); what
 * it returns runs once that transaction has committed (pushes, announcements). A throw rolls the answer back (the whisper
 * stays open). `found_elsewhere` (Task 8): `告诉他们` queues one reply of the Agent in the group that tells what was found
 * (agents/runs.ts `tellFromWhisper`), announced once committed — nothing is written to the whisper (Redesign D: that run
 * is what it reads telling from); `不用` does nothing more.
 */
export type WhisperHook = (t: Tx, whisper: Whisper, app: FastifyInstance) => Promise<(() => void) | void>;
export const ANSWER_HOOKS: { [K in WhisperKind]?: Partial<Record<WhisperAnswer, WhisperHook>> } = {
  found_elsewhere: {
    accepted: async (t, whisper, app) => {
      const queued = await tellFromWhisper(t, whisper, app.deps.config);
      if (queued) return () => app.agentPort.announce(queued);
    },
  },
};

/** Each whisper to its owner's sockets as it is when delivered (after a commit that changed them: `Hub.pushWhisper`). */
export function pushWhispers(realtime: Pick<Hub, "pushWhisper">, whispers: readonly Whisper[]): void {
  for (const w of whispers) realtime.pushWhisper(w);
}

const empty = z.object({});
const idParams = z.object({ id: uuidParam });

/**
 * The owner's whispers (README "Whispers"): a conversation's list, a page at a time, and the answers. Anyone else — a fellow
 * member, the owner of another Agent there, a stranger, a whisper or conversation id that is none — gets the same 404
 * `not_found`, found by one read of the caller's own rows (store.ts), so it costs what an id that is none costs.
 */
export function registerWhisperRoutes(app: FastifyInstance): void {
  const { db, config } = app.deps;
  const api = app.withTypeProvider<ZodTypeProvider>();
  const readLimit = perPrincipalLimit(app, 120);
  const answerLimit = perPrincipalLimit(app, 30);

  api.get(
    "/api/conversations/:id/whispers",
    {
      schema: {
        params: idParams,
        querystring: z.object({ before: positiveIntString().optional(), limit: positiveIntString(100).optional() }),
        response: { 200: z.object({ whispers: z.array(wireWhisperSchema), nextBefore: z.number().nullable() }) },
      },
    },
    async (req) => {
      const me = await requirePrincipal(req);
      await readLimit(req, me.id);
      const page = await listWhispers(db, me.id, req.params.id, { before: req.query.before, limit: req.query.limit ?? 50 });
      if (!page) throw notFound();
      return { whispers: await wireWhispers(db, page.whispers, config.siteTimezone), nextBefore: page.nextBefore };
    },
  );

  // Answered once: the whisper as it is now (a `found_elsewhere` one told: `telling`), pushed to the owner's sockets too
  // (their other tabs). Again, the other answer, or an answer whose button it does not offer: 409 `stale_whisper`; a
  // `found_elsewhere` one while its told reply is queued or running: 409 `busy_run`.
  const answer = (verb: "accept" | "decline", to: WhisperAnswer) =>
    api.post(
      `/api/whispers/:id/${verb}`,
      { schema: { params: idParams, querystring: empty, body: empty.nullish(), response: { 200: wireWhisperSchema } } },
      async (req) => {
        const me = await requirePrincipal(req);
        await answerLimit(req, me.id);
        let afterCommit: (() => void) | void = undefined;
        const outcome = await db.tx(async (t) => {
          const resolved = await resolveWhisper(t, me.id, req.params.id, to);
          if (typeof resolved !== "string") afterCommit = await ANSWER_HOOKS[resolved.kind]?.[to]?.(t, resolved, app);
          return resolved;
        });
        if (outcome === "gone") throw notFound();
        if (outcome === "stale") throw new AppError(409, "stale_whisper");
        if (outcome === "busy") throw new AppError(409, "busy_run");
        const [wire] = await wireWhispers(db, [outcome], config.siteTimezone);
        app.realtime.pushWhisper(outcome);
        (afterCommit as (() => void) | void)?.();
        return wire!;
      },
    );
  answer("accept", "accepted");
  answer("decline", "declined");
}
