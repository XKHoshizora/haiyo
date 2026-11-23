import type { Config } from "../config.ts";
import { assertCanSend, lockForWrite, VISIBLE_JOIN } from "../conversations/store.ts";
import type { Db, Queryable, Tx } from "../db.ts";
import { AppError } from "../errors.ts";
import type { AttachmentRef } from "../messages/model.ts";
import type { BlobStore } from "./blob.ts";
import { releaseBlob } from "./pending.ts";

/**
 * Class of the per-uploader quota lock. Two-key advisory locks live in a key space of their own, so this
 * can never collide with the pair locks (single bigint keys, `src/social/pair.ts`).
 */
const QUOTA_LOCK_CLASS = 0x617474; // "att"

export const quotaExceeded = (): AppError => new AppError(413, "too_large", { reason: "quota" });

export interface NewAttachment {
  conversationId: string;
  uploaderId: string;
  blobKey: string;
  /** Already sanitised for display. */
  name: string;
  size: number;
  /** Decided by the server from the bytes. */
  mime: string;
  inline: boolean;
}

/** Bytes `uploaderId` stores in attachments, sent or not. */
export async function usedBytes(q: Queryable, uploaderId: string): Promise<number> {
  const { rows } = await q.query<{ used: string }>(
    "select coalesce(sum(size), 0) as used from attachments where uploader_id = $1",
    [uploaderId],
  );
  return Number(rows[0]!.used);
}

/**
 * The last step of an upload, once its bytes are in the blob store. Takes the locks a send takes (pair
 * lock for a direct chat, then the conversation row) and re-checks, as a send would, that the uploader is
 * still a current member (404 `not_found`) who may send (403 `cannot_send` with the reason). Then, under
 * a per-uploader lock so concurrent uploads are counted one after another, the quota (413 `too_large`
 * `{reason: "quota"}`), and inserts the row, releasing the blob's pending record in the same
 * transaction (see pending.ts). The caller discards the blob if this throws.
 */
export async function insertAttachment(t: Tx, a: NewAttachment, quotaBytes: number, config: Pick<Config, "social">): Promise<AttachmentRef> {
  const lock = await lockForWrite(t, a.conversationId, a.uploaderId);
  await assertCanSend(t, lock, config);
  await t.query("select pg_advisory_xact_lock($1::int, hashtext($2::text))", [QUOTA_LOCK_CLASS, a.uploaderId]);
  if ((await usedBytes(t, a.uploaderId)) + a.size > quotaBytes) throw quotaExceeded();
  await releaseBlob(t, a.blobKey);
  const { rows } = await t.query<{ id: string }>(
    `insert into attachments (conversation_id, uploader_id, blob_key, name, size, mime, inline)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [a.conversationId, a.uploaderId, a.blobKey, a.name, a.size, a.mime, a.inline],
  );
  return { id: rows[0]!.id, name: a.name, size: a.size, inline: a.inline };
}

export interface Downloadable {
  blobKey: string;
  name: string;
  size: number;
  mime: string;
  inline: boolean;
}

/**
 * The attachment, if and only if the message that carries it (in the attachment's own conversation) is
 * visible to `readerId` right now under the visibility rule. One statement: lookup and permission come
 * from the same snapshot. Null for every other case alike — unknown id, never sent (also for the
 * uploader), another conversation, a late joiner's pre-join message, a member who left or was removed. `within`: also
 * only when its message is in that conversation, after seq `after` and at most `upTo` (what a group reply's file tool may
 * read: agents/tools/file.ts).
 */
export async function findDownloadable(
  q: Queryable,
  readerId: string,
  attachmentId: string,
  within: { conversationId: string; after: number; upTo: number } | null = null,
): Promise<Downloadable | null> {
  const { rows } = await q.query<{ blob_key: string; name: string; size: string; mime: string; inline: boolean }>(
    `select a.blob_key, a.name, a.size, a.mime, a.inline
       from attachments a
       join messages m on m.id = a.message_id and m.conversation_id = a.conversation_id
       ${VISIBLE_JOIN}
      where a.id = $2
        and ($3::uuid is null or (a.conversation_id = $3::uuid and m.seq > $4::bigint and m.seq <= $5::bigint))`,
    [readerId, attachmentId, within?.conversationId ?? null, within?.after ?? 0, within?.upTo ?? 0],
  );
  const r = rows[0];
  return r ? { blobKey: r.blob_key, name: r.name, size: Number(r.size), mime: r.mime, inline: r.inline } : null;
}

/**
 * For a send (inside its transaction, under the conversation lock): the sender's own attachment in this
 * conversation that no message carries yet, row-locked until commit. Null otherwise.
 */
export async function claimAttachment(
  t: Tx,
  attachmentId: string,
  conversationId: string,
  senderId: string,
): Promise<AttachmentRef | null> {
  const { rows } = await t.query<{ id: string; name: string; size: string; inline: boolean; mime: string }>(
    `select id, name, size, inline, mime from attachments
      where id = $1 and conversation_id = $2 and uploader_id = $3 and message_id is null
      for update`,
    [attachmentId, conversationId, senderId],
  );
  const r = rows[0];
  return r ? { id: r.id, name: r.name, size: Number(r.size), inline: r.inline, mime: r.mime } : null;
}

/** Links a claimed attachment to its message. False if it was linked already (the send must fail). */
export async function linkAttachment(t: Tx, attachmentId: string, messageId: string): Promise<boolean> {
  const res = await t.query("update attachments set message_id = $2 where id = $1 and message_id is null", [
    attachmentId,
    messageId,
  ]);
  return res.rowCount === 1;
}

export interface SweepLog {
  error(details: { err: unknown; attachmentId: string }, msg: string): void;
}

/**
 * Deletes attachments no message carries that are older than `olderThanMinutes`, blob first, then row.
 * Each in its own transaction that holds the row lock across the blob delete: a send cannot link it
 * meanwhile (rows a send holds are skipped), and if the blob delete fails the transaction rolls back, the
 * row stays, and the next sweep retries it (deleting a missing blob is not an error, so a retry after a
 * half-done attempt also succeeds). Failures are logged and do not stop the sweep. Returns how many were
 * deleted.
 */
export async function sweepOrphans(
  deps: { db: Db; blobs: BlobStore },
  olderThanMinutes: number,
  log: SweepLog = { error: (details, msg) => console.error(msg, details) },
): Promise<number> {
  const { rows } = await deps.db.query<{ id: string }>(
    `select id from attachments
      where message_id is null and created_at < now() - $1::double precision * interval '1 minute'
      order by created_at`,
    [olderThanMinutes],
  );
  let swept = 0;
  for (const { id } of rows) {
    try {
      const deleted = await deps.db.tx(async (t) => {
        const found = await t.query<{ blob_key: string }>(
          "select blob_key from attachments where id = $1 and message_id is null for update skip locked",
          [id],
        );
        const key = found.rows[0]?.blob_key;
        if (key === undefined) return false; // just sent, being sent, or already swept
        await deps.blobs.delete(key);
        await t.query("delete from attachments where id = $1", [id]);
        return true;
      });
      if (deleted) swept++;
    } catch (err) {
      log.error({ err, attachmentId: id }, "attachment sweep: could not delete; it stays and is retried next time");
    }
  }
  return swept;
}
