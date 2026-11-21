import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { buildApp } from "../src/app.ts";
import { createInvite } from "../src/auth/invites.ts";
import { RESET_PASSWORD_TTL_SECONDS, VERIFY_EMAIL_TTL_SECONDS } from "../src/auth/mail-copy.ts";
import { BACKOFF_SECONDS, REFUSED_PAUSE_MS, createMailSender, mailCounts } from "../src/auth/mail-sender.ts";
import { mailPolicy, sendMail, type MailKind, type MailPolicy } from "../src/auth/mailer.ts";
import { api, signUp } from "./helpers/actors.ts";
import { NO_ANSWER_FLOOR, useApp } from "./helpers/harness.ts";

const KEY = "re_test_key_that_must_never_be_printed";
const TO = "reader@example.test";

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  json: Record<string, unknown>;
}
type Reply = { status: number; body?: unknown } | "hangup";

/** A local stand-in for the mail provider: records every request, answers from a script (then 200 with an id). */
const seen: Seen[] = [];
let script: Reply[] = [];
let delayMs = 0;
const provider: Server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, json: JSON.parse(raw || "{}") });
    const next = script.shift() ?? { status: 200, body: { id: `prov-${seen.length}` } };
    setTimeout(() => {
      if (next === "hangup") return void req.socket.destroy();
      if (req.socket.destroyed) return;
      res.writeHead(next.status, { "content-type": "application/json" });
      res.end(JSON.stringify(next.body ?? {}));
    }, delayMs);
  });
});
await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
const apiUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/emails`;
afterAll(() => new Promise<void>((r) => provider.close(() => r())));

const logs: string[] = [];
const env = { MAIL_MODE: "resend", RESEND_API_KEY: KEY, MAIL_FROM: "Haiyo <no-reply@mail.example>", MAIL_REPLY_TO: "help@mail.example", MAIL_PER_ADDRESS_HOUR: "3" };
const quiet = { answerFloor: NO_ANSWER_FLOOR, staleRunSweep: false, proactive: false, memory: false, agentWorker: false } as const;
/** Policy of the helper that queues rows by hand: delivered, no cap in the way. */
const OPEN: MailPolicy = { deliver: true, perAddressHour: 1000 };
const keyOf = (id: string, to: string, subject: string, body: string): string =>
  `mail-${id}-${createHash("sha256").update(`${to}\n${subject}\n${body}`).digest("hex").slice(0, 16)}`;

describe("mail is really sent", () => {
  const { app, db } = useApp({ env, mail: { apiUrl, sender: false }, logStream: { write: (l) => void logs.push(l) } });

  beforeEach(() => {
    seen.length = 0;
    script = [];
    delayMs = 0;
    logs.length = 0;
  });

  const queue = async (body = "link https://app.example/verify?token=abc", kind: MailKind = "verify_email", policy = OPEN): Promise<string> => {
    await sendMail(db, kind, TO, "Subject line", body, policy);
    return (await db.query<{ id: string }>("select id::text from mail_outbox order by mail_outbox.id desc limit 1")).rows[0]!.id;
  };
  const row = async (id: string) =>
    (await db.query<Record<string, any>>("select status, attempts, sent_at, last_error, provider_id, next_attempt_at, expires_at, deliver from mail_outbox where id = $1", [id])).rows[0]!;
  const due = (id: string) => db.query("update mail_outbox set next_attempt_at = now() where id = $1", [id]);
  const secondsAhead = (d: Date): number => Math.round((d.getTime() - Date.now()) / 1000);

  test("a queued mail is delivered: provider call as documented, row sent with the provider's id, no memory counter touched", async () => {
    const id = await queue();
    expect((await row(id)).status).toBe("queued");
    expect(seen).toHaveLength(0); // writing the row sends nothing
    expect(await app.mailSender.runOnce()).toBe(1);
    expect(seen).toHaveLength(1);
    const s = seen[0]!;
    expect(s.method).toBe("POST");
    expect(s.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(s.headers["idempotency-key"]).toBe(keyOf(id, TO, "Subject line", "link https://app.example/verify?token=abc"));
    expect(s.json).toEqual({
      from: "Haiyo <no-reply@mail.example>",
      to: [TO],
      subject: "Subject line",
      text: "link https://app.example/verify?token=abc",
      reply_to: "help@mail.example",
    });
    const r = await row(id);
    expect(r).toMatchObject({ status: "sent", attempts: 1, last_error: null, provider_id: "prov-1" });
    expect(r.sent_at).toBeInstanceOf(Date);
    expect(await app.mailSender.runOnce()).toBe(0); // sent once, never again
    expect((await db.query("select count(*)::int n from memory_stats")).rows[0].n).toBe(0);
  });

  test("the idempotency key follows the content: same id with other content is another key; a retry of one row keeps its key", async () => {
    script = [{ status: 500 }];
    const id = await queue("first body");
    await app.mailSender.runOnce();
    await due(id);
    await app.mailSender.runOnce();
    expect(seen.map((s) => s.headers["idempotency-key"])).toEqual([keyOf(id, TO, "Subject line", "first body"), keyOf(id, TO, "Subject line", "first body")]);
    // A wiped database starts its ids again: the same id now belongs to another mail.
    await db.query("truncate mail_outbox restart identity");
    const again = await queue("second body");
    expect(again).toBe(id);
    await app.mailSender.runOnce();
    const keys = seen.map((s) => s.headers["idempotency-key"]);
    expect(keys[2]).toBe(keyOf(id, TO, "Subject line", "second body"));
    expect(keys[2]).not.toBe(keys[0]);
    expect(keys[2]).toMatch(/^mail-\d+-[0-9a-f]{16}$/);
  });

  test("a 500 is retried later with the same key and the mail is sent once", async () => {
    script = [{ status: 500, body: { message: `boom ${TO}` } }];
    const id = await queue();
    await app.mailSender.runOnce();
    expect(await row(id)).toMatchObject({ status: "queued", attempts: 1, last_error: "http_500" });
    expect(await app.mailSender.runOnce()).toBe(0); // backing off: not due yet
    expect(seen).toHaveLength(1);
    await due(id);
    await app.mailSender.runOnce();
    expect(seen).toHaveLength(2);
    expect(seen[0]!.headers["idempotency-key"]).toBe(seen[1]!.headers["idempotency-key"]);
    expect(await row(id)).toMatchObject({ status: "sent", attempts: 2, last_error: null, provider_id: "prov-2" });
  });

  test("429, a dropped connection and a 503 are retried; the waits are 1, 4, 10, then 15 minutes again and again (30 minutes for the first four)", async () => {
    expect(BACKOFF_SECONDS.slice(0, 4).reduce((a, b) => a + b, 0)).toBe(30 * 60);
    script = [{ status: 429, body: {} }, "hangup", { status: 503 }, { status: 500 }, { status: 500 }, { status: 500 }];
    const id = await queue();
    const waits: number[] = [];
    for (const code of ["http_429", "network", "http_503", "http_500", "http_500", "http_500"]) {
      await app.mailSender.runOnce();
      const r = await row(id);
      expect(r).toMatchObject({ status: "queued", last_error: code });
      waits.push(secondsAhead(r.next_attempt_at));
      await due(id);
    }
    expect(waits.map((w) => Math.round(w / 10) * 10)).toEqual([60, 240, 600, 900, 900, 900]);
  });

  test("a provider that stays down is retried until the mail's own expiry, then it ends expired (not failed), without another call", async () => {
    script = Array.from({ length: 8 }, () => ({ status: 500 }));
    const id = await queue();
    for (let i = 0; i < 8; i++) {
      await app.mailSender.runOnce();
      await due(id);
    }
    expect(seen).toHaveLength(8); // not five
    expect(await row(id)).toMatchObject({ status: "queued", attempts: 8, last_error: "http_500" });
    await db.query("update mail_outbox set expires_at = now() - interval '1 second' where id = $1", [id]);
    expect(await app.mailSender.runOnce()).toBe(0);
    expect(seen).toHaveLength(8);
    expect(await row(id)).toMatchObject({ status: "expired", attempts: 8, last_error: "expired" });
  });

  test("a row never goes out past its expires_at, even when it is due", async () => {
    const id = await queue();
    await db.query("update mail_outbox set expires_at = now() - interval '1 second' where id = $1", [id]);
    await app.mailSender.runOnce();
    expect(seen).toHaveLength(0);
    expect((await row(id)).status).toBe("expired");
  });

  test("each mail expires when its link stops working: reset 1 h, verification 24 h, a mail with no such link 24 h", async () => {
    const reset = await queue("a", "reset_password");
    const verify = await queue("b", "verify_email");
    const notice = await queue("c", "registration_attempt");
    expect(Math.abs(secondsAhead((await row(reset)).expires_at) - RESET_PASSWORD_TTL_SECONDS)).toBeLessThan(5);
    expect(Math.abs(secondsAhead((await row(verify)).expires_at) - VERIFY_EMAIL_TTL_SECONDS)).toBeLessThan(5);
    expect(Math.abs(secondsAhead((await row(notice)).expires_at) - 24 * 3600)).toBeLessThan(5);
  });

  test("a verification mail that waited more than an hour is still sent (its link lives 24 h)", async () => {
    const id = await queue("b", "verify_email");
    await db.query("update mail_outbox set created_at = now() - interval '3 hours' where id = $1", [id]);
    await app.mailSender.runOnce();
    expect((await row(id)).status).toBe("sent");
  });

  test("rows queued while MAIL_MODE was outbox (deliver false) are never sent, never expired, never counted as failed", async () => {
    const id = await queue("old backlog", "verify_email", { deliver: false, perAddressHour: 1000 });
    expect((await row(id)).deliver).toBe(false);
    await db.query("update mail_outbox set expires_at = now() - interval '1 day', created_at = now() - interval '2 days' where id = $1", [id]);
    await app.mailSender.runOnce();
    expect(seen).toHaveLength(0);
    expect(await row(id)).toMatchObject({ status: "queued", attempts: 0, last_error: null });
    expect(await mailCounts(db)).toMatchObject({ outboxOnly: 1, days: [] });
  });

  test("a 422 fails at once: no retry; the error is a short code, not the provider's words", async () => {
    script = [{ status: 422, body: { name: "missing_required_field", message: `bad ${TO} ${KEY}` } }];
    const id = await queue();
    await app.mailSender.runOnce();
    await due(id);
    await app.mailSender.runOnce();
    expect(seen).toHaveLength(1);
    expect(await row(id)).toMatchObject({ status: "failed", attempts: 1, last_error: "http_422", provider_id: null });
  });

  test("409: another request with the key still in progress is retried; a key reused for other content fails at once", async () => {
    script = [{ status: 409, body: { name: "concurrent_idempotent_requests", message: "later" } }];
    const a = await queue("a");
    await app.mailSender.runOnce();
    expect(await row(a)).toMatchObject({ status: "queued", last_error: "http_409" });
    await db.query("truncate mail_outbox restart identity");
    script = [{ status: 409, body: { name: "invalid_idempotent_request", message: "changed" } }];
    const b = await queue("b");
    await app.mailSender.runOnce();
    expect(await row(b)).toMatchObject({ status: "failed", last_error: "http_409" });
  });

  test("a call that takes too long is cut off and retried", async () => {
    const slow = await buildApp({ config: app.deps.config, db: app.deps.db }, { ...quiet, mail: { apiUrl, sender: false, callTimeoutMs: 100 } });
    await slow.ready();
    try {
      delayMs = 600;
      const id = await queue();
      await slow.mailSender.runOnce();
      expect(await row(id)).toMatchObject({ status: "queued", attempts: 1, last_error: "timeout" });
    } finally {
      await slow.close();
    }
  });

  test("a refused key or domain (401/403) pauses the whole sender: one error line, no more calls, rows stay queued; mail:status says so", async () => {
    const paused = await buildApp({ config: app.deps.config, db: app.deps.db }, { ...quiet, logStream: { write: (l) => void logs.push(l) }, mail: { apiUrl, sender: false } });
    await paused.ready();
    script = [{ status: 401, body: { message: KEY } }];
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) ids.push(await queue(`body ${i}`));
    await paused.mailSender.runOnce();
    expect(seen).toHaveLength(1); // the first call was refused, nothing else was tried
    for (let i = 0; i < 3; i++) expect(await paused.mailSender.runOnce()).toBe(0);
    expect(seen).toHaveLength(1);
    expect(await row(ids[0]!)).toMatchObject({ status: "queued", last_error: "http_401" });
    expect((await db.query("select count(*)::int n from mail_outbox where status = 'queued'")).rows[0].n).toBe(20);
    const errors = logs.map((l) => JSON.parse(l) as { level: number; msg: string }).filter((l) => l.level >= 50);
    expect(errors).toHaveLength(1);
    expect(logs.join("")).not.toContain(KEY);
    expect(logs.join("")).not.toContain(TO);
    expect((await mailCounts(db)).refused).toBe(1);
    // the rows still expire at their own time while the sender is paused
    await db.query("update mail_outbox set expires_at = now() - interval '1 second' where id = $1", [ids[5]]);
    await paused.mailSender.runOnce();
    expect(await row(ids[5]!)).toMatchObject({ status: "expired" });
    expect(REFUSED_PAUSE_MS).toBe(5 * 60_000);
    await paused.close();
  });

  test("after the pause one probe goes out with the oldest due row; the first success ends the pause", async () => {
    const probing = await buildApp({ config: app.deps.config, db: app.deps.db }, { ...quiet, logStream: { write: (l) => void logs.push(l) }, mail: { apiUrl, sender: false, refusedPauseMs: 150 } });
    await probing.ready();
    try {
      script = [{ status: 403 }];
      const first = await queue("first");
      await queue("second");
      await queue("third");
      await probing.mailSender.runOnce();
      expect(seen).toHaveLength(1);
      expect(await probing.mailSender.runOnce()).toBe(0);
      await new Promise((r) => setTimeout(r, 200));
      await probing.mailSender.runOnce(); // the probe succeeds and the pause is over: the others follow in the same pass
      expect(seen).toHaveLength(4);
      expect(seen[1]!.json.text).toBe("first");
      expect((await row(first)).status).toBe("sent");
      expect((await db.query("select count(*)::int n from mail_outbox where status = 'sent'")).rows[0].n).toBe(3);
      const lines = logs.map((l) => JSON.parse(l) as { level: number });
      expect(lines.filter((l) => l.level >= 50)).toHaveLength(1);
    } finally {
      await probing.close();
    }
  });

  test("stopping does not discard a success that has just arrived", async () => {
    const id = await queue();
    let release: (r: Response) => void = () => {};
    const slow = new Promise<Response>((r) => (release = r));
    const quietLog = { info() {}, warn() {}, error() {} };
    const own = createMailSender({ db: app.deps.db, settings: app.deps.config.mail, apiUrl, fetch: () => slow, log: quietLog });
    const pass = own.runOnce();
    await new Promise((r) => setTimeout(r, 50));
    const stopping = own.stop();
    release(new Response(JSON.stringify({ id: "late-ok" }), { status: 200 }));
    await pass;
    await stopping;
    expect(await row(id)).toMatchObject({ status: "sent", provider_id: "late-ok" });
  });

  test("a retry never falls due after the mail's expiry, so the row is closed on time", async () => {
    script = [{ status: 500 }];
    const id = await queue();
    await db.query("update mail_outbox set expires_at = now() + interval '20 seconds' where id = $1", [id]);
    await app.mailSender.runOnce();
    const r = await row(id);
    expect(r.status).toBe("queued");
    expect(r.next_attempt_at.getTime()).toBeLessThanOrEqual(r.expires_at.getTime());
  });

  test("a late answer never revives a row that was closed meanwhile", async () => {
    delayMs = 300;
    const id = await queue();
    const pass = app.mailSender.runOnce();
    await new Promise((r) => setTimeout(r, 100));
    await db.query("update mail_outbox set status = 'expired', last_error = 'expired' where id = $1", [id]);
    await pass;
    expect(await row(id)).toMatchObject({ status: "expired", provider_id: null, sent_at: null });
  });

  test("a restart between queueing and sending loses nothing: a fresh process picks the row up, with the same key", async () => {
    const id = await queue();
    // The first process never got to it (it is gone); a second one starts on the same database.
    const second = await buildApp({ config: app.deps.config, db: app.deps.db }, { ...quiet, mail: { apiUrl, sender: false } });
    await second.ready();
    try {
      expect(await second.mailSender.runOnce()).toBe(1);
    } finally {
      await second.close();
    }
    expect(seen.map((s) => s.headers["idempotency-key"])).toEqual([keyOf(id, TO, "Subject line", "link https://app.example/verify?token=abc")]);
    expect((await row(id)).status).toBe("sent");
  });

  test("a process that died in the middle of a send, even on a late try, leaves the row to be retried (never closed) once its lease has run out", async () => {
    const id = await queue();
    await db.query("update mail_outbox set attempts = 9, next_attempt_at = now() - interval '1 second' where id = $1", [id]);
    await app.mailSender.runOnce();
    expect(seen).toHaveLength(1);
    expect(await row(id)).toMatchObject({ status: "sent", attempts: 10 });
  });

  test("the lease outlasts a batch: a row claimed is not claimable again while the pass works through the others", async () => {
    delayMs = 50;
    for (let i = 0; i < 4; i++) await queue(`body ${i}`);
    await Promise.all([app.mailSender.runOnce(), app.mailSender.runOnce()]);
    expect(seen).toHaveLength(4);
    expect((await db.query("select attempts from mail_outbox order by id")).rows.map((r) => r.attempts)).toEqual([1, 1, 1, 1]);
  });

  test("two senders at once never send one row twice", async () => {
    delayMs = 150;
    const id = await queue();
    await Promise.all([app.mailSender.runOnce(), app.mailSender.runOnce()]);
    expect(seen).toHaveLength(1);
    expect((await row(id)).status).toBe("sent");
  });

  test("the key, the address and the mail's text are in no log line, no error and no row", async () => {
    script = [{ status: 500, body: { message: `${KEY} ${TO}` } }, { status: 422, body: { message: `${KEY} ${TO}` } }];
    const id = await queue("secret words in the body");
    await app.mailSender.runOnce();
    await due(id);
    await app.mailSender.runOnce();
    const rows = (await db.query("select * from mail_outbox where id = $1", [id])).rows.map((r) => ({ ...r, recipient: undefined, subject: undefined, body: undefined }));
    const everything = JSON.stringify(rows) + logs.join("");
    expect(everything).not.toContain(KEY);
    expect(everything).not.toContain(TO);
    expect(everything).not.toContain("secret words");
    expect(logs.join("")).toMatch(/mail/); // it does say something: a code and the row id
  });

  test("a registration answers as ever while delivery is down: the mail is only queued", async () => {
    script = Array.from({ length: 3 }, () => ({ status: 500 }));
    const code = await createInvite(db, { ttlHours: 1 });
    const res = await api(app, null, "POST", "/api/register", { inviteCode: code, email: "new@example.test", password: "correct horse battery", displayName: "New", handle: "new_one" });
    expect(res).toEqual({ status: 201, json: { ok: true } });
    expect(seen).toHaveLength(0);
    const { rows } = await db.query<{ status: string; deliver: boolean }>("select status, deliver from mail_outbox where kind = 'verify_email'");
    expect(rows).toEqual([{ status: "queued", deliver: true }]);
  });

  test("mail:status is derived from the outbox: per day queued, sent, failed, expired and retries; outbox-only rows apart", async () => {
    script = [{ status: 200, body: { id: "a" } }, { status: 422 }, { status: 500 }];
    await queue("a");
    await queue("b");
    await queue("c");
    const old = await queue("d");
    await db.query("update mail_outbox set expires_at = now() - interval '1 second' where id = $1", [old]);
    await queue("e", "verify_email", { deliver: false, perAddressHour: 1000 });
    await sendMail(db, "verify_email", "other@example.test", "s", "b", { deliver: true, perAddressHour: 0 });
    await app.mailSender.runOnce();
    const c = await mailCounts(db);
    expect(c.outboxOnly).toBe(1);
    expect(c.days).toHaveLength(1);
    expect(c.days[0]).toMatchObject({ queued: 1, sent: 1, failed: 1, expired: 1, capped: 1, retries: 0 });
    await due((await db.query<{ id: string }>("select id::text from mail_outbox where status = 'queued' and deliver")).rows[0]!.id);
    script = [{ status: 500 }];
    await app.mailSender.runOnce();
    expect((await mailCounts(db)).days[0]!.retries).toBe(1);
  });

  test("the sender's own timer delivers without anyone calling it", async () => {
    const timed = await buildApp({ config: app.deps.config, db: app.deps.db }, { ...quiet, mail: { apiUrl, sender: { intervalMs: 20 } } });
    await timed.ready();
    try {
      const id = await queue();
      for (let i = 0; i < 100 && (await row(id)).status !== "sent"; i++) await new Promise((r) => setTimeout(r, 30));
      expect((await row(id)).status).toBe("sent");
    } finally {
      await timed.close();
    }
  });

  test("outbox mode: rows are written as before (deliver false), nothing is delivered, nothing is touched", async () => {
    const config = { ...app.deps.config, mailMode: "outbox" as const, mail: undefined };
    const plain = await buildApp({ config, db: app.deps.db }, { ...quiet, mail: { apiUrl, sender: { intervalMs: 20 } } });
    await plain.ready();
    try {
      const id = await queue("x", "verify_email", mailPolicy(config));
      expect(await plain.mailSender.runOnce()).toBe(0);
      await new Promise((r) => setTimeout(r, 100));
      expect(seen).toHaveLength(0);
      expect(await row(id)).toMatchObject({ status: "queued", attempts: 0, deliver: false });
      const listed = await db.query("select id, created_at, recipient, kind, subject, body from mail_outbox where recipient = $1 order by id", [TO]);
      expect(listed.rows).toHaveLength(1);
    } finally {
      await plain.close();
    }
  });
});

describe("a per-address cap on mail", () => {
  const { app, db } = useApp({ env, mail: { apiUrl, sender: false } });
  beforeEach(() => {
    seen.length = 0;
    script = [];
    delayMs = 0;
  });
  const counts = async (email: string, kind: string) =>
    (await db.query<{ deliver: boolean; status: string; last_error: string | null }>("select deliver, status, last_error from mail_outbox where recipient = $1 and kind = $2 order by id", [email, kind])).rows;

  test("a fourth reset mail within the hour to one address is queued but never delivered, and the caller cannot tell", async () => {
    const a = await signUp(app, "capped");
    const answers = [];
    for (let i = 0; i < 6; i++) answers.push(await api(app, null, "POST", "/api/auth/request-password-reset", { email: a.email }));
    const unknown = await api(app, null, "POST", "/api/auth/request-password-reset", { email: "nobody@example.test" });
    for (const r of [...answers, unknown]) expect(r).toEqual(answers[0]);
    const rows = await counts(a.email, "reset_password");
    expect(rows).toHaveLength(6); // the same work for every request
    expect(rows.map((r) => r.deliver)).toEqual([true, true, true, false, false, false]);
    expect(rows.slice(3).every((r) => r.status === "capped" && !r.deliver)).toBe(true);
    await app.mailSender.runOnce();
    expect((await db.query("select count(*)::int n from mail_outbox where kind = $1 and status = $2", ["reset_password", "sent"])).rows[0].n).toBe(3);
    // another kind and another address have their own allowance
    expect((await counts(a.email, "verify_email")).every((r) => r.deliver)).toBe(true);
  });

  test("twelve resets for one address at once with a cap of 3: exactly three are deliverable", async () => {
    const a = await signUp(app, "burst");
    const all = await Promise.all(Array.from({ length: 12 }, () => api(app, null, "POST", "/api/auth/request-password-reset", { email: a.email })));
    for (const r of all) expect(r).toEqual(all[0]);
    const rows = await counts(a.email, "reset_password");
    expect(rows).toHaveLength(12);
    expect(rows.filter((r) => r.deliver)).toHaveLength(3);
    expect(rows.filter((r) => r.status === "capped")).toHaveLength(9);
    // a capital letter in the address does not open another allowance
    await sendMail(db, "reset_password", a.email.toUpperCase(), "s", "b", mailPolicy(app.deps.config));
    expect((await db.query<{ deliver: boolean }>("select deliver from mail_outbox where kind = 'reset_password' order by id desc limit 1")).rows[0]!.deliver).toBe(false);
  });

  test("open registration of one address over and over: the cap holds, every answer is the same", async () => {
    const open = await buildApp({ config: { ...app.deps.config, registrationMode: "open" }, db: app.deps.db }, { ...quiet, mail: { apiUrl, sender: false } });
    await open.ready();
    try {
      const answers = [];
      for (let i = 0; i < 5; i++) {
        answers.push(await api(open, null, "POST", "/api/register", { email: "again@example.test", password: "correct horse battery", displayName: "Again", handle: `again_${i}` }));
      }
      for (const r of answers) expect(r).toEqual(answers[0]);
      const rows = await counts("again@example.test", "verify_email");
      expect(rows).toHaveLength(5);
      expect(rows.map((r) => r.deliver)).toEqual([true, true, true, false, false]);
    } finally {
      await open.close();
    }
  });

  test("in outbox mode the cap changes nothing: every row is written as today", async () => {
    const config = { ...app.deps.config, mailMode: "outbox" as const, mail: undefined };
    for (let i = 0; i < 5; i++) await sendMail(db, "reset_password", TO, "s", "b", mailPolicy(config));
    const rows = await counts(TO, "reset_password");
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => !r.deliver && r.status === "queued" && r.last_error === null)).toBe(true);
  });
});
