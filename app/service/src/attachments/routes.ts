import multipart, { type Multipart, type MultipartFile } from "@fastify/multipart";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Socket } from "node:net";
import { Readable } from "node:stream";
import { z } from "zod";
import { canSend } from "../conversations/store.ts";
import { liftBodyDeadline } from "../body-deadline.ts";
import { AppError, notFound } from "../errors.ts";
import { perPrincipalLimit } from "../limits.ts";
import { uuidParam } from "../schemas.ts";
import { requirePrincipal } from "../session.ts";
import { isMissingBlob, newBlobKey, type BlobStore, type ByteRange } from "./blob.ts";
import { sniff, type Sniffed } from "./sniff.ts";
import { discardBlob, holdBlob } from "./pending.ts";
import type { UploadSlots } from "./slots.ts";
import { findDownloadable, insertAttachment, quotaExceeded, usedBytes, type Downloadable } from "./store.ts";

/** Uploads per principal per hour, times `RATE_LIMIT_SCALE`. (At most 3 at once: `slots.ts`.) */
export const UPLOADS_PER_HOUR = 60;
export const FILE_NAME_MAX_CHARS = 120;
/** The one multipart part an upload consists of. */
export const FILE_FIELD = "file";

/** Enough for every format `sniff` recognises. */
const SNIFF_BYTES = 4100;
const OPAQUE = "application/octet-stream";

/**
 * What a `Range` request header asks of a file of `size` bytes: one range (an inclusive byte range), `unsatisfiable` (416), or null — no range
 * this server answers, so the whole file is sent (a malformed header, another unit, several ranges: all allowed to be ignored). Suffix (`-n`) and
 * open-ended (`n-`) forms; an end past the file's end is clipped.
 */
export function parseRange(header: string | undefined, size: number): ByteRange | "unsatisfiable" | null {
  const m = typeof header === "string" ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") {
    const n = Number(m[2]);
    if (!Number.isSafeInteger(n) || n === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  if (!Number.isSafeInteger(start)) return null;
  if (m[2] !== "" && Number(m[2]) < start) return null;
  if (start >= size) return "unsatisfiable";
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  return { start, end };
}

const DOWNLOAD_HEADERS = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "sandbox; default-src 'none'",
  "cache-control": "private, no-store",
  // A browser plays and seeks a video or an audio file only through byte ranges.
  "accept-ranges": "bytes",
} as const;

// --- names ------------------------------------------------------------------------------------

/** Control, format (bidi overrides, zero-width...), lone surrogate and line/paragraph separator characters. */
const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu;

/**
 * A client-supplied file name made fit for display (it is never used as a path): unsafe characters
 * removed, NFC, only the last path segment, trimmed, at most 120 characters; "file" when nothing is left.
 */
export function sanitizeFileName(raw: string | undefined): string {
  const clean = (raw ?? "").replace(UNSAFE_CHARS, "").normalize("NFC");
  const last = clean.slice(Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\")) + 1).trim();
  const capped = Array.from(last).slice(0, FILE_NAME_MAX_CHARS).join("").trimEnd();
  return capped === "" || capped === "." || capped === ".." ? "file" : capped;
}

/**
 * `inline` or `attachment` with the name twice: a printable-ASCII fallback (anything else, quotes,
 * backslashes and percent signs become `_`) and the exact name as RFC 5987 `filename*=UTF-8''…`.
 * Nothing in the name can end the header or the parameter.
 */
export function contentDisposition(name: string, inline: boolean): string {
  // The ASCII name for a client that does not read `filename*`: the name with what is unsafe replaced; when nothing of it is a letter or
  // a digit (a Chinese name would be "___.png") it is `file` with the real extension.
  const extension = /\.[A-Za-z0-9]{1,10}$/.exec(name)?.[0] ?? "";
  const stem = name.slice(0, name.length - extension.length).replace(/[^\x20-\x7e]|["\\%]/gu, "_");
  const fallback = /[A-Za-z0-9]/.test(stem) ? `${stem}${extension}` : `file${extension}`;
  const encoded = encodeURIComponent(name.replace(/\p{Cs}/gu, "\uFFFD")).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${inline ? "inline" : "attachment"}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

// --- receiving an upload ----------------------------------------------------------------------

/** Markup and script stay opaque even when recognised (an SVG with an XML prolog sniffs as application/xml). */
const MARKUP = /^text\/|xml|html|svg|script/i;

/** What the server serves the bytes as, decided from their first bytes only. */
async function decideType(head: Buffer): Promise<Sniffed> {
  const found = await sniff(head);
  if (found.inline) return found;
  return { mime: MARKUP.test(found.mime) ? OPAQUE : found.mime, inline: false };
}

class TooLarge extends Error {}
/** The request body ended early or was malformed while the file streamed. */
class BrokenUpload extends Error {}

/**
 * Passes the file through unchanged, counting it and keeping its first bytes for sniffing. Stops (and
 * so tears down the source) the moment it passes `maxBytes` — nothing waits for the rest of the body.
 */
function metered(file: MultipartFile["file"], maxBytes: number): { stream: Readable; size: () => number; head: () => Buffer } {
  let size = 0;
  let head = Buffer.alloc(0);
  async function* pass() {
    try {
      for await (const chunk of file as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > maxBytes) throw new TooLarge();
        if (head.length < SNIFF_BYTES) head = Buffer.concat([head, chunk.subarray(0, SNIFF_BYTES - head.length)]);
        yield chunk;
      }
    } catch (err) {
      throw err instanceof TooLarge ? err : new BrokenUpload("upload stream failed", { cause: err });
    }
  }
  return { stream: Readable.from(pass()), size: () => size, head: () => head };
}

const invalid = () => new AppError(400, "invalid_request");

/** The next multipart part, or null at the end. Any parser error — malformed body, a part beyond the one allowed — is 400. */
async function nextPart(parts: AsyncIterableIterator<Multipart>): Promise<Multipart | null> {
  try {
    const r = await parts.next();
    return r.done ? null : r.value;
  } catch {
    throw invalid();
  }
}

export interface UploadDeadlines {
  /** No body bytes for this long: cut off. */
  idleMs: number;
  /** Still receiving the body after this long: cut off. */
  totalMs: number;
}

interface Deadline {
  /** Rejects (with `BrokenUpload`) when a deadline passes; never resolves. */
  expired: Promise<never>;
  disarm(): void;
}

/**
 * Cuts off a client that stalls while sending the body: idle for `idleMs`, or still sending after
 * `totalMs`. On expiry it destroys the request (for an unfinished request that destroys the socket),
 * destroys the file stream being stored (`onExpire`), and rejects `expired`, so whatever the receiving
 * code awaits settles even if the parser never hears of the destroyed request. Disarms itself once the
 * body is complete. Arm it only once the body is being consumed (a 'data' listener on a request nobody
 * reads would set it flowing into the void).
 */
function armDeadlines(req: FastifyRequest, { idleMs, totalMs }: UploadDeadlines, onExpire: (err: Error) => void): Deadline {
  let fail!: (err: Error) => void;
  const expired = new Promise<never>((_, reject) => (fail = reject));
  expired.catch(() => {}); // observed through the races below; never an unhandled rejection
  const cutOff = (why: string) => () => {
    req.log.info({ why }, "upload cut off");
    const err = new BrokenUpload(`upload cut off: ${why}`);
    req.raw.destroy();
    onExpire(err);
    fail(err);
  };
  const idle = setTimeout(cutOff("idle"), idleMs);
  const total = setTimeout(cutOff("too slow"), totalMs);
  const onData = () => void idle.refresh();
  const disarm = () => {
    clearTimeout(idle);
    clearTimeout(total);
    req.raw.off("data", onData);
    req.raw.off("end", disarm);
  };
  req.raw.on("data", onData);
  req.raw.once("end", disarm);
  return { expired, disarm };
}

/** `p`, unless the deadline passes first (then 400, like any broken upload). */
async function beforeDeadline<T>(p: Promise<T>, deadline: Deadline): Promise<T> {
  try {
    return await Promise.race([p, deadline.expired]);
  } catch (err) {
    if (err instanceof BrokenUpload) throw invalid();
    throw err;
  }
}

/**
 * Streams the upload's single file part into the blob store under `key`, enforcing the cap while it
 * streams and the deadlines while the body arrives. 400 for any other shape (a field, a second part,
 * no part, another part name, a broken or cut-off body, a client already gone), 413 `too_large` past
 * the cap. The caller discards the blob if this throws.
 */
async function receiveFile(
  req: FastifyRequest,
  blobs: BlobStore,
  key: string,
  deadlines: UploadDeadlines,
  maxBytes: number,
): Promise<{ name: string; size: number; head: Buffer }> {
  // A client that left while the pre-check ran will never produce another event on its request: the
  // parser, which only starts listening below, would wait for it forever.
  if (req.raw.destroyed) throw invalid();
  // `parts()` is a generator: nothing runs until the first `next()`, which (synchronously, in this same
  // turn, so no event can slip between the check above and it) attaches the parser's listeners and pipes
  // the body into it.
  const parts = req.parts();
  const first = nextPart(parts);
  let file: Readable | undefined;
  // The upload is let in: its own deadlines take over from the body deadline every request starts under.
  liftBodyDeadline(req);
  const deadline = armDeadlines(req, deadlines, (err) => file?.destroy(err));
  try {
    const part = await beforeDeadline(first, deadline);
    if (part?.type !== "file" || part.fieldname !== FILE_FIELD) throw invalid();
    file = part.file;
    const meter = metered(part.file, maxBytes);
    try {
      // Settles on expiry too: `onExpire` destroys the file stream it reads.
      await blobs.put(key, meter.stream);
    } catch (err) {
      if (err instanceof TooLarge) throw new AppError(413, "too_large");
      if (err instanceof BrokenUpload) throw invalid();
      throw err;
    }
    if (part.file.truncated) throw new AppError(413, "too_large"); // the parser's own cap, a backstop
    if (await beforeDeadline(nextPart(parts), deadline)) throw invalid();
    return { name: sanitizeFileName(part.filename), size: meter.size(), head: meter.head() };
  } finally {
    deadline.disarm();
  }
}

/**
 * This request's claim on its principal's upload slot, given back exactly once: by the handler when it
 * ends, or as soon as the client's connection closes, whichever is first — so a handler still waiting
 * on something after its client vanished does not keep the slot. The listener is attached before the
 * handler's first await; a client already gone gets no slot.
 */
function claimSlot(req: FastifyRequest, slots: UploadSlots) {
  const socket = req.raw.socket as Socket | undefined;
  let holder: string | null = null;
  let gone = false;
  const giveBack = () => {
    if (holder !== null) slots.release(holder);
    holder = null;
  };
  const onClose = () => {
    gone = true;
    giveBack();
  };
  socket?.once("close", onClose);
  return {
    take(principalId: string): void {
      if (gone || socket?.destroyed || req.raw.destroyed) throw invalid(); // nobody is left to answer
      if (slots.take(principalId) !== "taken") throw new AppError(429, "rate_limited");
      holder = principalId;
    },
    done(): void {
      giveBack();
      socket?.off("close", onClose);
    },
  };
}

/** After a refusal in mid-body: detach the parser and let the rest drain unread, so the answer goes out now. */
function stopReading(req: FastifyRequest): void {
  req.raw.unpipe();
  req.raw.resume();
}

// --- routes -----------------------------------------------------------------------------------

const attachmentView = z.object({ id: z.string(), name: z.string(), size: z.number(), inline: z.boolean() });

export function registerAttachmentRoutes(app: FastifyInstance): void {
  const { db, config, blobs, uploads } = app.deps;

  const uploadLimit = perPrincipalLimit(app, UPLOADS_PER_HOUR, "1 hour");

  const deadlines: UploadDeadlines = { idleMs: config.uploadIdleTimeoutMs, totalMs: config.uploadTotalTimeoutMs };

  /** After the cheap checks: hold a key, stream the file, then re-check and insert under the send locks. */
  async function acceptUpload(req: FastifyRequest, reply: FastifyReply, conversationId: string, uploaderId: string) {
    // Refuse what is obviously refused before reading a byte of the body: the answers a send gets.
    const verdict = await canSend(db, conversationId, uploaderId);
    if (!verdict) throw notFound();
    if (!verdict.ok) throw new AppError(403, "cannot_send", { reason: verdict.reason });
    if ((await usedBytes(db, uploaderId)) >= config.attachmentQuotaBytes) throw quotaExceeded();

    // Recorded before the first byte is written, so no blob ever exists unaccounted for (pending.ts).
    const key = newBlobKey("att");
    await holdBlob(db, key);
    let file: { name: string; size: number; head: Buffer };
    try {
      file = await receiveFile(req, blobs, key, deadlines, config.attachmentMaxBytes);
    } catch (err) {
      stopReading(req);
      await discardBlob({ db, blobs }, key, req.log);
      throw err;
    }

    try {
      const { mime, inline } = await decideType(file.head);
      // The right to send may have gone while the bytes streamed: re-checked under the send locks.
      const stored = await db.tx((t) =>
        insertAttachment(
          t,
          { conversationId, uploaderId, blobKey: key, name: file.name, size: file.size, mime, inline },
          config.attachmentQuotaBytes,
        ),
      );
      return reply.code(201).send(stored);
    } catch (err) {
      await discardBlob({ db, blobs }, key, req.log);
      throw err;
    }
  }

  // Multipart parsing exists only in this scope. Its parser reads nothing: the handler streams the body.
  void app.register(async (scope) => {
    await scope.register(multipart, {
      // The cap itself is enforced while streaming (`metered`); the parser's limits shape the request.
      limits: { fileSize: config.attachmentMaxBytes + 1, files: 1, fields: 0, parts: 1, headerPairs: 20 },
    });

    scope.withTypeProvider<ZodTypeProvider>().post(
      "/api/conversations/:id/attachments",
      {
        // Only multipart/form-data gets here (`preValidation`), and its parser reads nothing, so there is no
        // parsed body (Fastify validates an absent body as null). The body's shape — exactly one file part
        // named "file" — is checked as it streams, with 400 before anything is kept.
        schema: {
          params: z.object({ id: uuidParam }),
          querystring: z.object({}),
          body: z.null(),
          response: { 201: attachmentView },
        },
        preValidation: async (req) => {
          if (!req.isMultipart()) throw invalid();
        },
      },
      async (req, reply) => {
        const slot = claimSlot(req, uploads); // before the first await
        try {
          const me = await requirePrincipal(req);
          await uploadLimit(req, me.id);
          slot.take(me.id);
          return await acceptUpload(req, reply, req.params.id, me.id);
        } finally {
          slot.done();
        }
      },
    );
  });

  const downloadSchema = { params: z.object({ id: uuidParam }), querystring: z.object({}) };

  /** The attachment the caller may download now (the same 404 for everything else). */
  async function downloadable(req: FastifyRequest<{ Params: { id: string } }>): Promise<Downloadable> {
    const me = await requirePrincipal(req);
    const found = await findDownloadable(db, me.id, req.params.id);
    if (!found) throw notFound();
    return found;
  }
  const downloadHeaders = (found: Downloadable) => ({
    ...DOWNLOAD_HEADERS,
    "content-type": found.mime,
    "content-length": String(found.size),
    "content-disposition": contentDisposition(found.name, found.inline),
  });

  // Declared before the GET, so Fastify does not derive a HEAD from it (that one would open and drain the
  // whole blob). The same decision and headers; the blob is not touched.
  // `/:name` is only a name for the address (a browser titles a tab and names a saved file from the last part of it):
  // it is read by nothing, and who may fetch is decided by the id alone.
  for (const url of ["/api/attachments/:id", "/api/attachments/:id/:name"]) {
    const schema = url.endsWith(":name") ? { ...downloadSchema, params: downloadSchema.params.extend({ name: z.string().min(1).max(512) }) } : downloadSchema;
    app.withTypeProvider<ZodTypeProvider>().head(url, { schema }, async (req, reply) => {
      const found = await downloadable(req);
      return reply.headers(downloadHeaders(found)).send();
    });

    app.withTypeProvider<ZodTypeProvider>().get(url, { schema }, async (req, reply) => {
      const found = await downloadable(req);
      // A range is honoured only when the request carries no validator it would have to match (`If-Range`: this server keeps none).
      const asked = req.headers["if-range"] === undefined ? parseRange(req.headers.range, found.size) : null;
      if (asked === "unsatisfiable") {
        return reply
          .code(416)
          .headers({ ...DOWNLOAD_HEADERS, "content-range": `bytes */${found.size}`, "content-length": "0" })
          .send();
      }
      let body: Readable;
      try {
        body = await blobs.get(found.blobKey, asked ?? undefined);
      } catch (err) {
        if (!isMissingBlob(err)) throw err;
        req.log.error({ attachmentId: req.params.id }, "the blob of a sent attachment is missing");
        throw notFound();
      }
      if (asked) {
        return reply
          .code(206)
          .headers({ ...downloadHeaders(found), "content-length": String(asked.end - asked.start + 1), "content-range": `bytes ${asked.start}-${asked.end}/${found.size}` })
          .send(body);
      }
      return reply.headers(downloadHeaders(found)).send(body);
    });
  }
}
