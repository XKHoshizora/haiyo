import { createHash, randomBytes } from "node:crypto";
import type { Queryable } from "../db.ts";

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
 * Whether a sign-up may start with this code: it exists, is not revoked, has not expired and has a use left. Takes and
 * holds nothing: a use is taken when the account becomes real, at e-mail verification (`takeInviteUse`), so a
 * sign-up that creates nothing, is replaced or is never verified costs the code nothing.
 */
export async function inviteUsable(q: Queryable, code: string): Promise<boolean> {
  const { rowCount } = await q.query(
    "select 1 from invites where code_hash = $1 and uses < max_uses and revoked_at is null and expires_at > now()",
    [hashInviteCode(code)],
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
