import type { Db, Queryable, Tx } from "../db.ts";
import type { BlobStore } from "./blob.ts";

/**
 * Blobs that may exist with nothing referencing them (`pending_blobs`). Every blob write is bracketed:
 *
 *   holdBlob(db, key)        committed before the first byte is written
 *   blobs.put(key, …)
 *   releaseBlob(t, key)      in the transaction that makes a row reference the blob, or
 *   discardBlob(…, key)      when it is not wanted: deletes the blob, then the record
 *
 * Whatever is still held past the upload deadline — the delete failed, the upload was cut off, the
 * process died between `put` and the row — is deleted by `sweepPendingBlobs`.
 */

/** How long past the upload deadline a held blob is left alone: its request may still be committing. */
export const PENDING_BLOB_GRACE_MS = 60_000;

/** A held blob older than this belongs to no live request any more. */
export function abandonedAfterMs(config: { uploadTotalTimeoutMs: number }): number {
  return config.uploadTotalTimeoutMs + PENDING_BLOB_GRACE_MS;
}

export interface BlobLog {
  error(details: { err: unknown; key: string }, msg: string): void;
}

/** Records `key` as possibly unreferenced. Call (outside a transaction, or inside one that commits) before writing it. */
export async function holdBlob(q: Queryable, key: string): Promise<void> {
  await q.query("insert into pending_blobs (key) values ($1) on conflict (key) do nothing", [key]);
}

/**
 * In the transaction that makes a row reference `key`. Throws if the record is gone, i.e. the sweep
 * already took the blob after the deadline: the row must then not be written.
 */
export async function releaseBlob(t: Tx, key: string): Promise<void> {
  const res = await t.query("delete from pending_blobs where key = $1", [key]);
  if (res.rowCount !== 1) throw new Error(`blob ${key} is no longer held; it was swept after its deadline`);
}

/**
 * Deletes a held blob nothing references, then its record. If the blob cannot be deleted the record
 * stays, so the sweep retries it. Never throws; failures are logged.
 */
export async function discardBlob(deps: { db: Queryable; blobs: BlobStore }, key: string, log: BlobLog): Promise<void> {
  try {
    await deps.blobs.delete(key);
  } catch (err) {
    log.error({ err, key }, "could not delete an unused blob; the sweep will retry it");
    return;
  }
  try {
    await deps.db.query("delete from pending_blobs where key = $1", [key]);
  } catch (err) {
    log.error({ err, key }, "could not release the record of a deleted blob; the sweep will drop it");
  }
}

/**
 * Deletes every blob held for longer than `olderThanMs`, blob first (with any partial file), then the
 * record, each in its own transaction that holds the record's row lock across the blob delete. If the
 * blob delete fails the transaction rolls back and the record stays for the next sweep. A key that an
 * attachment or an avatar (a person's, an Agent's or a group's) references is never deleted (only its stray record is, and that is logged).
 * Returns how many blobs were deleted.
 */
export async function sweepPendingBlobs(
  deps: { db: Db; blobs: BlobStore },
  olderThanMs: number,
  log: BlobLog = { error: (details, msg) => console.error(msg, details) },
): Promise<number> {
  const { rows } = await deps.db.query<{ key: string }>(
    `select key from pending_blobs
      where created_at < now() - $1::double precision * interval '1 millisecond'
      order by created_at`,
    [olderThanMs],
  );
  let swept = 0;
  for (const { key } of rows) {
    try {
      const deleted = await deps.db.tx(async (t) => {
        const found = await t.query<{ referenced: boolean }>(
          `select exists (select 1 from attachments where blob_key = p.key)
               or exists (select 1 from principals where avatar_key = p.key)
               or exists (select 1 from conversations where avatar_key = p.key) as referenced
             from pending_blobs p
            where p.key = $1
              for update of p skip locked`,
          [key],
        );
        const row = found.rows[0];
        if (!row) return false; // released meanwhile, or another sweep has it
        if (!row.referenced) await deps.blobs.delete(key);
        await t.query("delete from pending_blobs where key = $1", [key]);
        if (row.referenced) log.error({ err: null, key }, "a held blob is referenced; dropped its record and kept the blob");
        return !row.referenced;
      });
      if (deleted) swept++;
    } catch (err) {
      log.error({ err, key }, "blob sweep: could not delete; it stays held and is retried next time");
    }
  }
  return swept;
}
