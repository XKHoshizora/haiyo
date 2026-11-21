import { createHash } from "node:crypto";
import type { Db } from "../db.ts";

/** Resend's send endpoint (https://resend.com/docs/api-reference/emails/send-email). Tests point the sender elsewhere (`BuildOptions.mail`). */
export const RESEND_API_URL = "https://api.resend.com/emails";

/**
 * The wait after the first, second, third ... failed try: 1, 4, 10 minutes, then 15 minutes again and again (the first four add up to
 * half an hour). A mail is tried until its own `expires_at`, not a number of times.
 */
export const BACKOFF_SECONDS = [60, 240, 600, 900] as const;
/** While a call is in flight its row is leased this long (longer than a call can take); a process that dies mid-call leaves it to be retried after. */
const LEASE_SECONDS = 60;
const CALL_TIMEOUT_MS = 15_000;
/** Rows one pass delivers at most (one is claimed at a time, so a lease never has to cover a batch). */
const BATCH = 10;
/** While the provider refuses our key or sender (401/403) the sender makes no calls but one probe this often. */
export const REFUSED_PAUSE_MS = 5 * 60_000;
/** How often the timer looks for queued mail. */
export const DEFAULT_POLL_MS = 3000;

export interface MailSettings {
  apiKey: string;
  from: string;
  replyTo?: string | undefined;
}

export interface MailSender {
  /** One pass: closes what is past its expiry, then delivers what is due. Returns how many calls it made. Never throws. */
  runOnce(): Promise<number>;
  /** Starts the timer (no-op in `outbox` mode). */
  start(intervalMs?: number): void;
  /** Stops the timer, abandons a call in flight (its row is retried after its lease) and waits for the pass to end. */
  stop(): Promise<void>;
}

interface Logger {
  warn(obj: Record<string, unknown>, msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

interface Claimed {
  id: string;
  recipient: string;
  subject: string;
  body: string;
  /** Null for a mail queued before the HTML version existed: it goes out as text only. */
  html: string | null;
  attempts: number;
}

type Outcome = { ok: true; providerId: string | null } | { ok: false; code: string; retry: boolean; urgent?: boolean };

/**
 * One key per mail and its content: the same on every try of a row (so a retry of a call whose answer was lost cannot send it twice;
 * the provider keeps keys 24 hours), and never the same for another mail, even one that gets the same row id after a wiped database.
 */
export function idempotencyKey(row: Pick<Claimed, "id" | "recipient" | "subject" | "body">): string {
  const digest = createHash("sha256").update(`${row.recipient}\n${row.subject}\n${row.body}`).digest("hex").slice(0, 16);
  return `mail-${row.id}-${digest}`;
}

/** What a call came to, as a short code: the provider's body is never kept, bar the id of a success and the name of a 409. */
async function call(fetchFn: typeof fetch, url: string, settings: MailSettings, row: Claimed, signal: AbortSignal): Promise<Outcome> {
  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${settings.apiKey}`,
        "content-type": "application/json",
        "idempotency-key": idempotencyKey(row),
      },
      body: JSON.stringify({
        from: settings.from,
        to: [row.recipient],
        subject: row.subject,
        text: row.body,
        ...(row.html === null ? {} : { html: row.html }),
        ...(settings.replyTo === undefined ? {} : { reply_to: settings.replyTo }),
      }),
      signal,
    });
    const code = `http_${res.status}`;
    if (res.status >= 200 && res.status < 300) {
      const id = await res.json().then(
        (j: unknown) => (typeof (j as { id?: unknown })?.id === "string" ? (j as { id: string }).id : null),
        () => null,
      );
      return { ok: true, providerId: id };
    }
    if (res.status === 409) {
      // Two meanings: the same key is still being worked on (try later), or the key was used for other content (never succeeds).
      const name = await res.json().then(
        (j: unknown) => (j as { name?: unknown })?.name,
        () => undefined,
      );
      return { ok: false, code, retry: name === "concurrent_idempotent_requests" };
    }
    await res.body?.cancel().catch(() => undefined);
    // 401 and 403: a wrong, revoked or restricted key, or a domain not verified yet: every mail would meet it. Not a failure of this mail:
    // the caller pauses the whole sender (one error line), and what waits goes out once the configuration or the provider is fixed.
    if (res.status === 401 || res.status === 403) return { ok: false, code, retry: false, urgent: true };
    // 429 is a rate or quota limit, 5xx the provider's own trouble.
    return { ok: false, code, retry: res.status === 429 || res.status >= 500 };
  } catch (err) {
    return { ok: false, code: (err as { name?: string }).name === "TimeoutError" ? "timeout" : "network", retry: true };
  }
}

/**
 * The in-process sender of `MAIL_MODE=resend`. `mail_outbox` is the source of truth: `runOnce` closes rows past their `expires_at`
 * (status `expired`), then claims, one at a time, rows that are to be delivered and due (`for update skip locked`; the claim adds the
 * try and leases the row), calls the provider outside any transaction, and records the answer. A row is retried on the backoff's last
 * interval until it expires; only an answer that cannot succeed fails it. Only short codes and row ids are logged. In `outbox` mode
 * `settings` is undefined and nothing is ever delivered; rows not marked `deliver` are never touched in either mode.
 */
export function createMailSender(opts: { db: Db; settings: MailSettings | undefined; apiUrl?: string; fetch?: typeof fetch; callTimeoutMs?: number; refusedPauseMs?: number; log: Logger }): MailSender {
  const { db, settings, log } = opts;
  const url = opts.apiUrl ?? RESEND_API_URL;
  const fetchFn = opts.fetch ?? fetch;
  const timeoutMs = opts.callTimeoutMs ?? CALL_TIMEOUT_MS;
  const pauseMs = opts.refusedPauseMs ?? REFUSED_PAUSE_MS;
  const closing = new AbortController();
  /** Set while the provider refuses us: no claim before this time, and then only one (the probe) until a call succeeds. */
  let refusedUntil: number | undefined;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<number> | undefined;

  async function claim(): Promise<Claimed | undefined> {
    const { rows } = await db.query<Claimed>(
      `with due as (
         select id from mail_outbox
          where status = 'queued' and deliver and next_attempt_at <= now() and expires_at > now()
          order by id limit 1 for update skip locked)
       update mail_outbox m set attempts = m.attempts + 1, next_attempt_at = now() + make_interval(secs => $1)
         from due where m.id = due.id
      returning m.id::text as id, m.recipient, m.subject, m.body, m.html, m.attempts`,
      [LEASE_SECONDS],
    );
    return rows[0];
  }

  async function pass(): Promise<number> {
    if (settings === undefined) return 0;
    let calls = 0;
    try {
      const closed = await db.query(
        `update mail_outbox set status = 'expired', last_error = 'expired'
          where status = 'queued' and deliver and expires_at <= now() and next_attempt_at <= now()`,
      );
      if (closed.rowCount) log.warn({ expired: closed.rowCount }, "mail went past its expiry without being sent");
      while (calls < BATCH && !closing.signal.aborted) {
        if (refusedUntil !== undefined && Date.now() < refusedUntil) break;
        const row = await claim();
        if (!row) break;
        calls++;
        const outcome = await call(fetchFn, url, settings, row, AbortSignal.any([AbortSignal.timeout(timeoutMs), closing.signal]));
        // Stopping abandons a call that has not answered (the row stays leased and is tried again, same key, after the lease), but
        // a success that has just arrived is recorded.
        if (closing.signal.aborted && !outcome.ok) break;
        await record(row, outcome);
      }
    } catch (err) {
      // The database was unreachable or slow: the rows are still queued, the next pass looks again. Only a code is logged.
      log.warn({ code: (err as { code?: string }).code }, "mail sender pass failed; trying again next time");
    }
    return calls;
  }

  async function record(row: Claimed, outcome: Outcome): Promise<void> {
    if (outcome.ok) {
      await db.query(
        "update mail_outbox set status = 'sent', sent_at = now(), last_error = null, provider_id = $2 where id = $1 and status = 'queued'",
        [row.id, outcome.providerId],
      );
      if (refusedUntil !== undefined) {
        refusedUntil = undefined;
        log.info({}, "the mail provider accepts our key and sender again; sending resumes");
      }
      return;
    }
    if (outcome.urgent) {
      // A refused key, restricted key or unverified domain: every mail would meet the same answer. Pause the whole sender (rows stay
      // queued and still expire), say so once, and let one probe through every pause until it works.
      const entering = refusedUntil === undefined;
      refusedUntil = Date.now() + pauseMs;
      await db.query("update mail_outbox set last_error = $2, next_attempt_at = now() where id = $1 and status = 'queued'", [row.id, outcome.code]);
      if (entering) log.error({ code: outcome.code }, "the mail provider refuses our key or sender; mail waits until this is fixed (see MAIL_FROM, RESEND_API_KEY and the sending domain)");
      return;
    }
    if (outcome.retry) {
      const wait = BACKOFF_SECONDS[Math.min(row.attempts, BACKOFF_SECONDS.length) - 1]!;
      await db.query(
        "update mail_outbox set last_error = $2, next_attempt_at = least(now() + make_interval(secs => $3), expires_at) where id = $1 and status = 'queued'",
        [row.id, outcome.code, wait],
      );
      log.info({ id: row.id, code: outcome.code, attempts: row.attempts }, "a mail will be tried again");
      return;
    }
    await db.query("update mail_outbox set status = 'failed', last_error = $2 where id = $1 and status = 'queued'", [row.id, outcome.code]);
    log.warn({ id: row.id, code: outcome.code, attempts: row.attempts }, "a mail could not be sent");
  }

  return {
    runOnce: () => pass(),
    start(intervalMs = DEFAULT_POLL_MS) {
      if (settings === undefined || timer !== undefined || closing.signal.aborted) return;
      timer = setInterval(() => {
        if (inFlight) return; // passes never overlap in one process
        inFlight = pass().finally(() => {
          inFlight = undefined;
        });
      }, intervalMs);
      timer.unref();
    },
    async stop() {
      closing.abort();
      if (timer) clearInterval(timer);
      timer = undefined;
      await inFlight;
    },
  };
}

export interface MailDay {
  day: string;
  queued: number;
  sent: number;
  failed: number;
  expired: number;
  /** Written but over the hourly cap for their address: never delivered. */
  capped: number;
  /** Tries beyond the first, over the day's mails. */
  retries: number;
}

/**
 * What `mail:status` prints, all from `mail_outbox` (counts only): the last 7 days (by when the mail was queued) of the mails that were
 * to be delivered, and how many rows there are that never were (written in `outbox` mode).
 */
export async function mailCounts(db: Db): Promise<{ days: MailDay[]; outboxOnly: number; refused: number }> {
  const days = await db.query<MailDay>(
    `select created_at::date::text as day,
            (count(*) filter (where status = 'queued'))::int as queued,
            (count(*) filter (where status = 'sent'))::int as sent,
            (count(*) filter (where status = 'failed'))::int as failed,
            (count(*) filter (where status = 'expired'))::int as expired,
            (count(*) filter (where status = 'capped'))::int as capped,
            coalesce(sum(greatest(attempts - 1, 0)), 0)::int as retries
       from mail_outbox where (deliver or status = 'capped') and created_at >= now() - interval '7 days'
      group by 1 order by 1`,
  );
  const outbox = await db.query<{ n: number }>("select count(*)::int as n from mail_outbox where not deliver and status = 'queued'");
  // The sender's pause is in its process; its trace is here: queued rows whose last answer was a refusal of our key or sender.
  const refused = await db.query<{ n: number }>("select count(*)::int as n from mail_outbox where status = 'queued' and deliver and last_error in ('http_401', 'http_403')");
  return { days: days.rows, outboxOnly: outbox.rows[0]?.n ?? 0, refused: refused.rows[0]?.n ?? 0 };
}
