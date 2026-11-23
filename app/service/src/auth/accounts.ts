import type { Queryable, Tx } from "../db.ts";

/**
 * Takes this transaction's lock on an e-mail address (lower-cased): everything that decides what an address's
 * account is — a registration finding, replacing or creating it, a verification link marking it verified —
 * holds it, so they happen one at a time per address. Released when the transaction ends.
 */
export async function lockAccountEmail(t: Queryable, email: string): Promise<void> {
  await t.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`account-email:${email.toLowerCase()}`]);
}

export interface ExistingAccount {
  /** The Better Auth user. */
  userId: string;
  email: string;
  verified: boolean;
  /** Its principal (registration creates both together, so there is one). */
  principalId: string | null;
}

const ACCOUNT_BY_EMAIL = `
  select u.id as "userId", u.email, u."emailVerified" as verified, p.id as "principalId"
    from "user" u left join principals p on p.auth_user_id = u.id
   where u.email = $1
     for update of u`;

/** The account registered under `email` (Better Auth stores e-mails lower-cased), its user row locked; or null. */
export async function findAccountByEmail(t: Tx, email: string): Promise<ExistingAccount | null> {
  const { rows } = await t.query<ExistingAccount>(ACCOUNT_BY_EMAIL, [email.toLowerCase()]);
  return rows[0] ?? null;
}

/**
 * Anything only a signed-in person makes. An account whose e-mail was never verified cannot sign in, so its
 * principal has none of it; if it does, something is wrong and the account is not touched.
 */
const SIGNED_IN_TRACES = `
  select exists (select 1 from messages where sender_id = $1)
      or exists (select 1 from memberships where principal_id = $1)
      or exists (select 1 from friendships where a_id = $1 or b_id = $1)
      or exists (select 1 from blocks where blocker_id = $1)
      or exists (select 1 from attachments where uploader_id = $1)
      or exists (select 1 from friend_requests where from_id = $1)
      or exists (select 1 from principals where owner_id = $1) as traced`;

/**
 * Deletes an account whose e-mail was never verified, inside the registration that replaces it: its principal,
 * its auth user with its sessions and credentials (they cascade), and its outstanding reset links. What other
 * people did to it goes with it — friend requests to it, blocks of it — and their ids are returned so they can be
 * told after commit. Its invite loses nothing: a use is taken only at verification.
 *
 * Throws (and so rolls the registration back) rather than delete a verified account or one with anything a
 * signed-in person makes (SIGNED_IN_TRACES).
 */
export async function removeUnverifiedAccount(t: Tx, account: ExistingAccount): Promise<string[]> {
  const refuse = (why: string) => new Error(`refusing to replace the account of user ${account.userId}: ${why}`);
  if (account.verified) throw refuse("its e-mail is verified");
  const affected = new Set<string>();
  const principalId = account.principalId;
  if (principalId !== null) {
    // Locked first, so nobody can make a new request to it or block it while it is being removed.
    await t.query("select 1 from principals where id = $1 for update", [principalId]);
    const { rows } = await t.query<{ traced: boolean }>(SIGNED_IN_TRACES, [principalId]);
    if (rows[0]!.traced) throw refuse("its principal has what only a signed-in person makes");
    const requests = await t.query<{ id: string }>("delete from friend_requests where to_id = $1 returning from_id as id", [principalId]);
    const blocks = await t.query<{ id: string }>("delete from blocks where blocked_id = $1 returning blocker_id as id", [principalId]);
    for (const { id } of [...requests.rows, ...blocks.rows]) affected.add(id);
    await t.query("delete from principals where id = $1", [principalId]);
  }
  await t.query(`delete from verification where value = $1 and identifier like 'reset-password:%'`, [account.userId]);
  const deleted = await t.query(`delete from "user" where id = $1 and not "emailVerified"`, [account.userId]);
  if (deleted.rowCount !== 1) throw refuse("its auth user is gone or verified");
  return [...affected];
}
