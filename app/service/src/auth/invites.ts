import { createHash, randomBytes } from "node:crypto";
import type { Db, Queryable } from "../db.ts";
import { findAccountByEmail, lockAccountEmail, removeUnverifiedAccount } from "./accounts.ts";
import { VERIFY_EMAIL_TTL_SECONDS } from "./mail-copy.ts";

const CODE_LENGTH = 20;
export const MAX_INVITE_USES = 1000;
/** How much of a code's hash the operator sees and types: enough to tell codes apart, nowhere near enough to be one. */
const PREFIX_SHOWN = 8;
const PREFIX_MIN = 6;

export function hashInviteCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

/**
 * Creates an invite for `uses` sign-ups (default 1, at most 1000) and returns the plaintext code (only its SHA-256 is
 * stored).
 */
export async function createInvite(db: Queryable, opts: { ttlHours: number; uses?: number }): Promise<string> {
  const uses = opts.uses ?? 1;
  if (!Number.isInteger(uses) || uses < 1 || uses > MAX_INVITE_USES) {
    throw new Error(`--uses must be a whole number from 1 to ${MAX_INVITE_USES}`);
  }
  const code = randomBytes(CODE_LENGTH).toString("base64url").slice(0, CODE_LENGTH);
  await db.query(
    "insert into invites (code_hash, expires_at, max_uses) values ($1, now() + make_interval(secs => $2), $3)",
    [hashInviteCode(code), opts.ttlHours * 3600, uses],
  );
  return code;
}

/**
 * How many sign-ups waiting for their link a code may have: PENDING_PER_USE_LEFT for each use it has left, plus
 * PENDING_SLACK. Every one costs a mail and a held handle, so this bounds them by what the code can still admit (a
 * single-use code: 2 x 1 + 5 = 7 waiting, the 8th is refused). A sign-up waits only as long as its verification link
 * works (VERIFY_EMAIL_TTL_SECONDS, auth.ts `emailVerification.expiresIn`); after that it holds no slot, and the sweep
 * removes it. Not locked: sign-ups racing each other may overshoot the cap by a few, which still bounds them.
 */
export const PENDING_PER_USE_LEFT = 2;
export const PENDING_SLACK = 5;

/**
 * Whether a sign-up may start with this code: it exists, is not revoked, has not expired, has a use left, and not too
 * many sign-ups are already waiting for their links (the cap above; refused exactly like an unusable code). Takes and
 * holds nothing: a use is taken when the account becomes real, at e-mail verification (`takeInviteUse`), so a sign-up
 * that creates nothing, is replaced or is never verified costs the code nothing.
 */
export async function inviteUsable(q: Queryable, code: string): Promise<boolean> {
  const { rowCount } = await q.query(
    `select 1 from invites i
      where i.code_hash = $1 and i.uses < i.max_uses and i.revoked_at is null and i.expires_at > now()
        and (select count(*) from pending_invites pi
              where pi.code_hash = i.code_hash and pi.created_at > now() - make_interval(secs => $2))
            < $3 * (i.max_uses - i.uses) + $4`,
    [hashInviteCode(code), VERIFY_EMAIL_TTL_SECONDS, PENDING_PER_USE_LEFT, PENDING_SLACK],
  );
  return rowCount === 1;
}

/** Remembers which code a new, unverified account signed up with (gone with the account if it is replaced or removed). */
export async function rememberInvite(q: Queryable, code: string, principalId: string): Promise<void> {
  await q.query("insert into pending_invites (principal_id, code_hash) values ($1, $2)", [principalId, hashInviteCode(code)]);
}

export interface PendingInvite {
  userId: string;
  principalId: string;
  codeHash: string;
}

/** The code the not yet verified account of this e-mail signed up with, if any (the caller holds the address's lock). */
export async function pendingInviteOf(q: Queryable, email: string): Promise<PendingInvite | null> {
  const { rows } = await q.query<PendingInvite>(
    `select u.id as "userId", p.id as "principalId", pi.code_hash as "codeHash"
       from principals p join "user" u on u.id = p.auth_user_id join pending_invites pi on pi.principal_id = p.id
      where u.email = $1 and not u."emailVerified"`,
    [email.toLowerCase()],
  );
  return rows[0] ?? null;
}

/** Whether Better Auth has marked this user verified (inside the caller's transaction, which it joined). */
export async function isVerified(q: Queryable, userId: string): Promise<boolean> {
  const { rows } = await q.query<{ v: boolean }>('select "emailVerified" as v from public."user" where id = $1', [userId]);
  return rows[0]?.v === true;
}

/**
 * Takes the use for an account that has just been verified, in the same transaction: true, with the use recorded for
 * that account; false when the code has run out or been revoked since sign-up (the caller rolls the verification
 * back). Expiry is not checked again: the person signed up in time and has proved the address. One statement checks
 * and counts, and its row lock lasts only until the commit that follows; a loser re-checks the committed row
 * (READ COMMITTED, the default: under a stricter level this would be a serialization error instead).
 */
export async function takeInviteUse(q: Queryable, pending: PendingInvite): Promise<boolean> {
  const { rowCount } = await q.query(
    `update invites set uses = uses + 1, used_by = $2, used_at = now()
      where code_hash = $1 and uses < max_uses and revoked_at is null`,
    [pending.codeHash, pending.principalId],
  );
  if (rowCount !== 1) return false;
  await q.query("insert into invite_uses (code_hash, principal_id) values ($1, $2)", [pending.codeHash, pending.principalId]);
  await q.query("delete from pending_invites where principal_id = $1", [pending.principalId]);
  return true;
}

export interface InviteListing {
  hashPrefix: string;
  uses: number;
  maxUses: number;
  expiresAt: Date;
  createdAt: Date;
  revoked: boolean;
}

/** Every code, newest first: a prefix of its hash, never the code. */
export async function listInvites(db: Queryable): Promise<InviteListing[]> {
  const { rows } = await db.query<InviteListing>(
    `select left(code_hash, ${PREFIX_SHOWN}) as "hashPrefix", uses, max_uses as "maxUses", expires_at as "expiresAt",
            created_at as "createdAt", revoked_at is not null as revoked
       from invites order by created_at desc, code_hash`,
  );
  return rows;
}

export type RevokeResult =
  | { ok: true; hashPrefix: string }
  | { ok: false; reason: "bad_prefix" | "not_found" | "ambiguous" };

/** Closes the one code whose hash starts with `prefix` to further sign-ups; accounts already made are untouched. */
export async function revokeInvite(db: Queryable, prefix: string): Promise<RevokeResult> {
  if (prefix.length < PREFIX_MIN || !/^[0-9a-f]+$/.test(prefix)) return { ok: false, reason: "bad_prefix" };
  const { rows } = await db.query<{ hash: string }>(
    "select code_hash as hash from invites where code_hash like $1 || '%' limit 2",
    [prefix],
  );
  if (rows.length === 0) return { ok: false, reason: "not_found" };
  if (rows.length > 1) return { ok: false, reason: "ambiguous" };
  await db.query("update invites set revoked_at = coalesce(revoked_at, now()) where code_hash = $1", [rows[0]!.hash]);
  return { ok: true, hashPrefix: prefix };
}

/**
 * Removes (at most `limit`, oldest first) unverified accounts whose verification link has expired, each with its
 * pending note (it goes with the principal), so their handles and rows are freed; returns how many. Only an account
 * that is still unverified and has a pending note from this feature is touched: a verified account, an unverified
 * one made before pending notes existed, and one that holds anything a signed-in person makes (it is left, as
 * `removeUnverifiedAccount` refuses) are never removed. Each account is its own transaction under its address's lock.
 */
export async function sweepExpiredSignups(db: Db, opts: { limit: number }): Promise<number> {
  const { rows } = await db.query<{ email: string }>(
    `select u.email from pending_invites pi join principals p on p.id = pi.principal_id join public."user" u on u.id = p.auth_user_id
      where pi.created_at <= now() - make_interval(secs => $1) and not u."emailVerified"
      order by pi.created_at limit $2`,
    [VERIFY_EMAIL_TTL_SECONDS, opts.limit],
  );
  let removed = 0;
  for (const { email } of rows) {
    const done = await db
      .tx(async (t) => {
        await lockAccountEmail(t, email);
        const account = await findAccountByEmail(t, email);
        if (!account || account.verified || account.principalId === null) return false;
        const { rowCount } = await t.query(
          "select 1 from pending_invites where principal_id = $1 and created_at <= now() - make_interval(secs => $2)",
          [account.principalId, VERIFY_EMAIL_TTL_SECONDS],
        );
        if (rowCount !== 1) return false;
        await removeUnverifiedAccount(t, account);
        return true;
      })
      .catch(() => false); // one it refuses to remove (signed-in traces) is left; the rest go on
    if (done) removed++;
  }
  return removed;
}
