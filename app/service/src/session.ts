import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { fromNodeHeaders } from "better-auth/node";
import { z } from "zod";
import { authCall } from "./auth/auth.ts";
import type { Queryable } from "./db.ts";
import { AppError } from "./errors.ts";
import { acceptanceFields, assertCurrentVersions, LEGAL_VERSIONS, recordAcceptance, termsAccepted } from "./legal.ts";
import { memoryChoice, memoryModelUsable } from "./memory/call.ts";
import { MEMORY_LANGUAGE_CODES } from "./memory/language.ts";
import { getDream, getMemoryLanguage, getMemoryModel, getNewNotes } from "./memory/store.ts";
import { handleChangeAvailableAt } from "./principals/store.ts";
import { perPrincipalLimit } from "./limits.ts";

export interface Principal {
  id: string;
  handle: string;
  displayName: string;
  avatarVersion: number;
  email: string;
  sessionId: string;
}

/**
 * The only way a handler learns who is acting: the session cookie, resolved by Better Auth.
 * Throws 401 `unauthenticated` for no/expired/revoked sessions, unverified e-mail, or a user without a principal;
 * a busy database is 503 `busy` (authCall), as everywhere.
 *
 * And 403 `terms_required` while the account has not accepted the terms and the privacy policy in force (src/legal.ts),
 * read in the same query: every signed-in route, the socket's ticket included, waits for the acceptance. Only what the
 * question itself needs passes `beforeTerms` (`GET /api/me`, `POST /api/me/terms`; signing out is Better Auth's own route).
 */
export async function requirePrincipal(req: FastifyRequest, { beforeTerms = false }: { beforeTerms?: boolean } = {}): Promise<Principal> {
  const session = await authCall(() => req.server.auth.api.getSession({ headers: fromNodeHeaders(req.headers) }));
  if (!session || !session.user.emailVerified) throw new AppError(401, "unauthenticated");
  const { rows } = await req.server.deps.db.query<{ id: string; handle: string; display_name: string; avatar_version: number; accepted: boolean }>(
    `select p.id, p.handle, p.display_name, p.avatar_version,
            exists (select 1 from terms_acceptances t where t.principal_id = p.id and t.terms_version = $2 and t.privacy_version = $3) as accepted
       from principals p where p.auth_user_id = $1`,
    [session.user.id, LEGAL_VERSIONS.terms, LEGAL_VERSIONS.privacy],
  );
  const row = rows[0];
  if (!row) throw new AppError(401, "unauthenticated");
  if (!row.accepted && !beforeTerms) throw new AppError(403, "terms_required");
  return {
    id: row.id,
    handle: row.handle,
    displayName: row.display_name,
    avatarVersion: row.avatar_version,
    email: session.user.email,
    sessionId: session.session.id,
  };
}

/**
 * Which of `sessionIds` still exist and have not expired. Sign-out and password reset delete the row
 * (and announce it through `onSessionEnded`); expiry only shows here, so long-lived connections ask.
 */
export async function liveSessions(q: Queryable, sessionIds: string[]): Promise<Set<string>> {
  if (sessionIds.length === 0) return new Set();
  const { rows } = await q.query<{ id: string }>(
    `select id from "session" where id = any($1::text[]) and "expiresAt" > now()`,
    [sessionIds],
  );
  return new Set(rows.map((r) => r.id));
}

export function registerSessionRoutes(app: FastifyInstance): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  // Accepting the terms: a budget of its own, like every write (10 a minute).
  const termsLimit = perPrincipalLimit(app, 10);
  api.get(
    "/api/me",
    {
      schema: {
        params: z.object({}),
        querystring: z.object({}),
        response: {
          200: z.object({
            id: z.string(),
            handle: z.string(),
            displayName: z.string(),
            avatarVersion: z.number(),
            email: z.string(),
            newNotes: z.enum(["auto", "vault", "open"]),
            memoryModel: z
              .union([
                z.object({ source: z.literal("site"), id: z.string() }),
                z.object({ source: z.literal("provider"), providerId: z.string(), model: z.string() }),
              ])
              .nullable(),
            memoryModelUsable: z.boolean(),
            dream: z.boolean(),
            memoryLanguage: z.enum(MEMORY_LANGUAGE_CODES).nullable(),
            handleChangeAvailableAt: z.string().nullable(),
            termsAccepted: z.boolean(),
          }),
        },
      },
    },
    async (req) => {
      // Also before the acceptance: it is what tells the web to ask.
      const p = await requirePrincipal(req, { beforeTerms: true });
      const { db, config } = app.deps;
      // False: the terms or the privacy policy has a version this account has not accepted (or it was made before them).
      const accepted = await termsAccepted(db, p.id);
      const newNotes = await getNewNotes(db, p.id);
      // A paid site model stored before such a choice was refused is no choice, here as in the calls (`memoryChoice`); the row is left as it is.
      const memoryModel = memoryChoice(config, await getMemoryModel(db, p.id));
      const usable = await memoryModelUsable(db, config, p.id, memoryModel);
      const dream = await getDream(db, p.id);
      const memoryLanguage = await getMemoryLanguage(db, p.id);
      // When the handle may be changed again (once a year); null: now.
      const handleChangeAt = await handleChangeAvailableAt(db, p.id);
      return {
        id: p.id,
        handle: p.handle,
        displayName: p.displayName,
        avatarVersion: p.avatarVersion,
        email: p.email,
        newNotes,
        memoryModel,
        memoryModelUsable: usable,
        dream,
        memoryLanguage,
        handleChangeAvailableAt: handleChangeAt === null ? null : handleChangeAt.toISOString(),
        termsAccepted: accepted,
      };
    },
  );

  // The signed-in person accepts the documents in force (asked at sign-in when `termsAccepted` is false): src/legal.ts.
  api.post(
    "/api/me/terms",
    {
      schema: {
        params: z.object({}),
        querystring: z.object({}),
        body: z.object(acceptanceFields),
        response: { 200: z.object({ termsAccepted: z.literal(true) }) },
      },
    },
    async (req) => {
      const p = await requirePrincipal(req, { beforeTerms: true });
      await termsLimit(req, p.id);
      assertCurrentVersions(req.body);
      await recordAcceptance(app.deps.db, p.id);
      return { termsAccepted: true as const };
    },
  );
}
