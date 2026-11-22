import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { perPrincipalLimit } from "../limits.ts";
import { requirePrincipal } from "../session.ts";
import { registerDevice, removeSessionDevice } from "./devices.ts";

const empty = z.object({});
const ok = z.object({ ok: z.literal(true) });

/**
 * What the iOS app's `push.register` gives the page, sent on: the APNs device token in hex (32 to 100 bytes; any case,
 * stored lower-case), which APNs it is for, and optionally the app's version as the shell reports it (one line, ≤ 32).
 */
const deviceBody = z.object({
  token: z
    .string()
    .regex(/^([0-9A-Fa-f]{2}){32,100}$/)
    .transform((s) => s.toLowerCase()),
  env: z.enum(["sandbox", "production"]),
  appVersion: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[\x20-\x7e]+$/)
    .optional(),
});

/**
 * `POST /api/push/devices` and `DELETE /api/push/devices/current` (README "Push notifications"): the signed-in page in the
 * iOS app binds its phone to its session, and unbinds it on sign-out. 30 a minute together per person.
 */
export function registerPushRoutes(app: FastifyInstance): void {
  const { db } = app.deps;
  const api = app.withTypeProvider<ZodTypeProvider>();
  const limit = perPrincipalLimit(app, 30);

  api.post(
    "/api/push/devices",
    { schema: { params: empty, querystring: empty, body: deviceBody, response: { 200: ok } } },
    async (req) => {
      const me = await requirePrincipal(req);
      await limit(req, me.id);
      const { token, env, appVersion } = req.body;
      await registerDevice(db, { principalId: me.id, sessionId: me.sessionId, token, env, appVersion: appVersion ?? null });
      return { ok: true as const };
    },
  );

  api.delete(
    "/api/push/devices/current",
    { schema: { params: empty, querystring: empty, response: { 200: ok } } },
    async (req) => {
      const me = await requirePrincipal(req);
      await limit(req, me.id);
      await removeSessionDevice(db, me.sessionId);
      return { ok: true as const };
    },
  );
}
