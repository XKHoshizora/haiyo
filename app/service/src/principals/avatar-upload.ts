import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Readable } from "node:stream";
import { isMissingBlob, newBlobKey, type BlobStore } from "../attachments/blob.ts";
import { discardBlob, holdBlob, releaseBlob } from "../attachments/pending.ts";
import { sniff } from "../attachments/sniff.ts";
import { liftBodyDeadline } from "../body-deadline.ts";
import type { Tx } from "../db.ts";
import { AppError } from "../errors.ts";
import { perPrincipalLimit, type PrincipalLimit } from "../limits.ts";
import { requirePrincipal } from "../session.ts";

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const AVATAR_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);
export const SNIFF_BYTES = 4100;
/** Avatar uploads one principal may make a minute: their own and their Agents' together (every one is a blob write). */
export const AVATAR_UPLOADS_PER_MINUTE = 10;

/** The headers every served avatar carries (person, Agent or group): only the bytes' own type is trusted, nothing runs. */
export const AVATAR_HEADERS = {
  "x-content-type-options": "nosniff",
  "cache-control": "private, max-age=60",
  "content-security-policy": "default-src 'none'; sandbox",
} as const;

async function readAll(stream: AsyncIterable<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}

/** The first `max` bytes (fewer if the stream is shorter); the rest is never pulled and the stream is closed. */
async function readPrefix(stream: Readable, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  try {
    for await (const c of stream as AsyncIterable<Buffer>) {
      chunks.push(c);
      n += c.length;
      if (n >= max) break;
    }
  } finally {
    stream.destroy();
  }
  return Buffer.concat(chunks).subarray(0, max);
}

/**
 * A stored avatar as it is served: its type from the bytes, and only when browsers may show it. `whole: false` reads no more
 * than the sniffing prefix (a HEAD does not drain the blob). Null when the blob is gone or is not an image to show.
 */
export async function readStoredAvatar(
  blobs: BlobStore,
  key: string,
  whole: boolean,
): Promise<{ type: string; body: Buffer; complete: boolean } | null> {
  try {
    const stream = await blobs.get(key);
    const bytes = whole ? await readAll(stream) : await readPrefix(stream, SNIFF_BYTES);
    const { mime, inline } = await sniff(bytes.subarray(0, SNIFF_BYTES));
    return inline ? { type: mime, body: bytes, complete: whole } : null;
  } catch (err) {
    if (!isMissingBlob(err)) throw err;
    return null;
  }
}

const avatarBudgets = new WeakMap<FastifyInstance, PrincipalLimit>();

/**
 * The avatar budget of `app`: one `perPrincipalLimit` of `AVATAR_UPLOADS_PER_MINUTE`, shared by `PUT /api/me/avatar` and
 * `PUT /api/agents/:id/avatar` (the latter counts against the Agent writes' budget too). Call it while registering.
 */
export function avatarBudget(app: FastifyInstance): PrincipalLimit {
  let budget = avatarBudgets.get(app);
  if (!budget) {
    budget = perPrincipalLimit(app, AVATAR_UPLOADS_PER_MINUTE);
    avatarBudgets.set(app, budget);
  }
  return budget;
}

/**
 * Registers a raw-image `PUT` (the rules of `PUT /api/me/avatar`) in its own encapsulated scope, so the 2 MB
 * cap and the pass-through parser apply to this route only. Fastify enforces the cap while the body streams in.
 * `handle` runs after the body is in: it checks who may do this (and any rate limit) and calls `storeAvatar`.
 */
export function registerAvatarPut(
  app: FastifyInstance,
  url: string,
  params: z.ZodType,
  handle: (req: FastifyRequest, body: Buffer) => Promise<void>,
): void {
  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(
      /^(image\/[\w.+-]+|application\/octet-stream)$/i,
      { parseAs: "buffer", bodyLimit: AVATAR_MAX_BYTES },
      (_req, body, done) => done(null, body),
    );
    scope.withTypeProvider<ZodTypeProvider>().put(
      url,
      {
        bodyLimit: AVATAR_MAX_BYTES,
        // Up to 2 MiB from a slow connection may take long: a signed-in person's upload is governed by the
        // server-wide timeouts, not the body deadline (body-deadline.ts). Anyone else's body stays under it; the
        // handler still gives every answer (the order of checks is unchanged).
        preParsing: async (req) => {
          try {
            await requirePrincipal(req);
            liftBodyDeadline(req);
          } catch {
            // Not signed in (or the session could not be checked now): the body deadline stays.
          }
        },
        schema: {
          params,
          querystring: z.object({}),
          body: z.instanceof(Buffer),
          response: { 200: z.object({ ok: z.literal(true) }) },
        },
      },
      async (req) => {
        await handle(req, req.body);
        return { ok: true as const };
      },
    );
  });
}

/**
 * Stores `body` as the avatar of the principal `swap` changes. The declared Content-Type and any file name are
 * ignored: only the bytes decide (400 `invalid_request` unless PNG, JPEG or WebP). `swap` runs in the
 * transaction that commits the change: it locks what it must and returns `swapAvatarKey`'s previous key.
 */
export async function storeAvatar(
  app: FastifyInstance,
  log: FastifyRequest["log"],
  body: Buffer,
  swap: (t: Tx, newKey: string) => Promise<string | null>,
): Promise<void> {
  const { db, blobs } = app.deps;
  const { mime } = await sniff(body.subarray(0, SNIFF_BYTES));
  if (!AVATAR_MIMES.has(mime)) throw new AppError(400, "invalid_request");

  // Every blob that may exist unreferenced is held (attachments/pending.ts): the new one until the
  // swap commits, the replaced one from the swap until it is deleted. The sweep removes leftovers.
  const key = newBlobKey("avatar");
  await holdBlob(db, key);
  let previous: string | null;
  try {
    await blobs.put(key, body);
    previous = await db.tx(async (t) => {
      const old = await swap(t, key);
      await releaseBlob(t, key);
      if (old) await holdBlob(t, old);
      return old;
    });
  } catch (err) {
    await discardBlob({ db, blobs }, key, log);
    throw err;
  }
  if (previous) await discardBlob({ db, blobs }, previous, log);
}

/**
 * Takes the avatar away: `drop` runs in the transaction that commits the change (it locks what it must, clears the key and
 * returns the previous one, or null when there was none). The previous blob is held in that transaction and deleted after it
 * commits; the sweep removes it when the delete fails.
 */
export async function dropAvatar(app: FastifyInstance, log: FastifyRequest["log"], drop: (t: Tx) => Promise<string | null>): Promise<void> {
  const { db, blobs } = app.deps;
  const previous = await db.tx(async (t) => {
    const old = await drop(t);
    if (old) await holdBlob(t, old);
    return old;
  });
  if (previous) await discardBlob({ db, blobs }, previous, log);
}
