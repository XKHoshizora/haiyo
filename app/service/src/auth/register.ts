import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { APIError } from "better-auth/api";
import { z } from "zod";
import type { Tx } from "../db.ts";
import { AppError } from "../errors.ts";
import { acceptanceFields, assertCurrentVersions, recordAcceptance } from "../legal.ts";
import { handleFree, HANDLE_PATTERN } from "../principals/store.ts";
import { displayName } from "../schemas.ts";
import { findAccountByEmail, lockAccountEmail, removeUnverifiedAccount, type ExistingAccount } from "./accounts.ts";
import { holdUntilFloor, startAnswerClock, type AnswerFloor } from "./answer-floor.ts";
import { runInTransaction } from "./auth.ts";
import { inviteUsable, rememberInvite } from "./invites.ts";
import { registrationAttemptMail } from "./mail-copy.ts";
import { mailPolicy, sendMail, type MailPolicy } from "./mailer.ts";

const UNIQUE_VIOLATION = "23505";

export const registerBody = z.object({
  inviteCode: z.string().max(100).optional(),
  email: z.email().max(254),
  password: z.string().min(10).max(128),
  displayName,
  handle: z.string().regex(HANDLE_PATTERN),
  // The terms and the privacy policy the person was shown, and their 18+ declaration (src/legal.ts): required.
  ...acceptanceFields,
});

/** How often, at most, the owner of an address hears that someone tried to register it again. */
const ATTEMPT_NOTICE_INTERVAL = "1 hour";

/**
 * Tells the owner of a verified account that someone tried to register its address; at most once per
 * ATTEMPT_NOTICE_INTERVAL per address (the caller holds the address's lock, so two attempts cannot both send).
 */
async function noticeRegistrationAttempt(t: Tx, account: ExistingAccount, appOrigin: string, policy: MailPolicy): Promise<void> {
  const recent = await t.query(
    `select 1 from mail_outbox
      where recipient = $1 and kind = 'registration_attempt' and created_at > now() - $2::interval limit 1`,
    [account.email, ATTEMPT_NOTICE_INTERVAL],
  );
  if (recent.rowCount) return;
  const mail = registrationAttemptMail(`${appOrigin}/signin`, `${appOrigin}/forgot`);
  await sendMail(t, "registration_attempt", account.email, mail.subject, mail.body, policy, mail.html);
}

export function registerRegistrationRoutes(
  app: FastifyInstance,
  rateLimit: { max: number; timeWindow: string },
  answerFloor: AnswerFloor,
): void {
  const { db, config, social } = app.deps;
  const api = app.withTypeProvider<ZodTypeProvider>();

  api.post(
    "/api/register",
    {
      config: { rateLimit },
      // Once the body is in (however late the client sent it): the answer floor counts from here.
      preValidation: startAnswerClock,
      schema: {
        params: z.object({}),
        querystring: z.object({}),
        body: registerBody,
        response: { 201: z.object({ ok: z.literal(true) }) },
      },
    },
    async (req, reply) => {
      const { inviteCode, email, password, displayName, handle } = req.body;
      const needsInvite = config.registrationMode === "invite";
      // Before anything is locked or used up: a page older than the documents in force is told to reload (409).
      assertCurrentVersions(req.body);

      let told: string[];
      try {
        // One transaction for the whole decision: the invite lock, the address's lock and account, removing an
        // unverified one, Better Auth's user/account rows and mail (joined to this transaction, see auth.ts), the
        // principal, and which invite it came with all commit together, or nothing does.
        told = await db.tx(async (client) => {
          // The invite first: without one, nothing (not even whether a handle is taken) is revealed.
          if (needsInvite) {
            if (!inviteCode || !(await inviteUsable(client, inviteCode))) throw new AppError(400, "invalid_invite");
          }

          // Whoever holds the handle — also an unverified account this registration would replace — or gave it up
          // (`reserved_handles`: theirs for good), it is taken: the answer must not depend on whose e-mail is being registered.
          if (!(await handleFree(client, handle, null))) throw new AppError(409, "handle_taken");

          // From here on the answer is 201, account or not; the invite is untouched either way (its use is taken at verification).
          await lockAccountEmail(client, email);
          const existing = await findAccountByEmail(client, email);
          if (existing?.verified) {
            // Never touched: its owner is told that someone tried, and nothing is created.
            await noticeRegistrationAttempt(client, existing, config.appOrigin, mailPolicy(config));
            return [];
          }
          // An unverified account proves nobody owns the address yet: the newest registration replaces it.
          const affected = existing ? await removeUnverifiedAccount(client, existing) : [];

          const created = await runInTransaction(client, () =>
            app.auth.api.signUpEmail({
              body: { name: displayName, email, password, callbackURL: `${config.appOrigin}/verify` },
            }),
          );
          // Better Auth answers a taken e-mail with a synthetic user and writes nothing; under the address's lock,
          // with no account left, that cannot be the case.
          const real = await client.query(`select 1 from "user" where id = $1`, [created.user.id]);
          if (real.rowCount !== 1) throw new Error("registration: Better Auth created no user for an address without one");

          let principalId: string;
          try {
            const { rows } = await client.query<{ id: string }>(
              `insert into principals (kind, handle, display_name, auth_user_id)
               values ('human', $1, $2, $3) returning id`,
              [handle, displayName, created.user.id],
            );
            principalId = rows[0]!.id;
          } catch (err) {
            if ((err as { code?: string }).code === UNIQUE_VIOLATION) throw new AppError(409, "handle_taken");
            throw err;
          }
          // What the new account accepted, with it (an account whose address was taken gets nothing: nothing was made).
          await recordAcceptance(client, principalId);
          if (needsInvite) await rememberInvite(client, inviteCode!, principalId);
          return affected;
        });
      } catch (err) {
        if (err instanceof APIError && err.statusCode >= 400 && err.statusCode < 500) {
          throw new AppError(400, "invalid_request");
        }
        throw err;
      }
      // Friend requests to and blocks of a replaced account are gone: their makers' lists changed.
      if (told.length > 0) social.emit(told, req.log);
      await holdUntilFloor(req, answerFloor);
      return reply.code(201).send({ ok: true });
    },
  );
}
