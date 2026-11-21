import type { Config } from "../config.ts";
import type { Db, Queryable } from "../db.ts";
import { RESET_PASSWORD_TTL_SECONDS, VERIFY_EMAIL_TTL_SECONDS } from "./mail-copy.ts";

export type MailKind = "verify_email" | "reset_password" | "registration_attempt";

/** How long a mail is worth sending: until the link in it stops working (the routes' own constants); a mail with no such link, a day. */
const EXPIRES_AFTER_SECONDS: Record<MailKind, number> = {
  verify_email: VERIFY_EMAIL_TTL_SECONDS,
  reset_password: RESET_PASSWORD_TTL_SECONDS,
  registration_attempt: 24 * 60 * 60,
};

/** What `sendMail` needs of the configuration: whether rows are to be delivered, and the hourly cap per address and kind. */
export interface MailPolicy {
  deliver: boolean;
  perAddressHour: number;
}

export const mailPolicy = (config: Pick<Config, "mailMode" | "mailPerAddressHour">): MailPolicy => ({
  deliver: config.mailMode === "resend",
  perAddressHour: config.mailPerAddressHour,
});

/**
 * Queues mail by writing it to `mail_outbox` (the sender, src/auth/mail-sender.ts, delivers it in `resend` mode). Pass `q` to
 * write through a transaction client so the mail commits or rolls back together with the work that caused it; given the pool
 * (a `Db`), the lock, the count and the insert run in one transaction of their own.
 *
 * The cap: when this address already has `perAddressHour` mails of this kind from the last hour (capped ones included), the row
 * is still written, by the same statements as any other, but with status `capped` and not to be delivered (`resend` mode; in
 * `outbox` mode nothing is delivered anyway and the row is as any other). Whoever asked sees no difference. Counting and writing
 * happen under one advisory lock per (address, kind), so a burst of requests at once cannot all see room.
 */
export async function sendMail(
  q: Queryable,
  kind: MailKind,
  recipient: string,
  subject: string,
  body: string,
  policy: MailPolicy,
  /** The HTML version, sent next to `body` (Resend's `html` beside `text`). Rows written before it existed have none and go out as text only. */
  html?: string,
): Promise<void> {
  const write = async (t: Queryable): Promise<void> => {
    // After any lock of the registration path (the address's account lock is always taken first), never before.
    await t.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`mail-cap:${recipient.toLowerCase()}:${kind}`]);
    const recent = await t.query<{ n: number }>(
      "select count(*)::int as n from mail_outbox where lower(recipient) = lower($1) and kind = $2 and created_at > now() - interval '1 hour'",
      [recipient, kind],
    );
    const capped = policy.deliver && (recent.rows[0]?.n ?? 0) >= policy.perAddressHour;
    await t.query(
      `insert into mail_outbox (recipient, kind, subject, body, html, deliver, status, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(secs => $8))`,
      [recipient, kind, subject, body, html ?? null, policy.deliver && !capped, capped ? "capped" : "queued", EXPIRES_AFTER_SECONDS[kind]],
    );
  };
  const pool = q as Partial<Db>;
  if (typeof pool.tx === "function") await pool.tx(write);
  else await write(q);
}
