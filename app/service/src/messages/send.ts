import { addressRanges, checkPicked, mentionsAtSend } from "../agents/mentions.ts";
import { claimAttachment, linkAttachment } from "../attachments/store.ts";
import { assertCanSend, lockForWrite, VISIBLE_JOIN, type WriteLock } from "../conversations/store.ts";
import type { Config } from "../config.ts";
import type { Tx } from "../db.ts";
import { AppError } from "../errors.ts";
import { insertMessage, MESSAGE_COLUMNS, toStored, type Mention, type MessageBody, type MessageRow, type StoredMessage } from "./model.ts";

/** The longest text a message holds, in characters: the send schema's limit (people's messages are refused above it; an
 * Agent's reply is cut there). */
export const MESSAGE_TEXT_MAX = 8000;

export interface SendInput {
  /** Already trimmed and validated: 0–`MESSAGE_TEXT_MAX` characters, and not empty unless `attachmentId` is given. */
  text?: string;
  /** The sender's own unsent upload in this conversation; makes a `file` message with `text` as caption. */
  attachmentId?: string;
  replyToSeq?: number;
  /** The client's retry key: one message per (conversation, sender, clientTxn). */
  clientTxn: string;
  /**
   * The mentions picked from the @ list (Task M): who each means and the range of `text` (as stored) that names them;
   * checked here (agents/mentions.ts `checkPicked`: 400 `bad_mentions`).
   */
  mentions?: readonly Mention[];
}

const invalid = () => new AppError(400, "invalid_request");

/**
 * Sends as `senderId` (always the session principal). Lock order: pair lock (direct), conversation row;
 * then, all in this transaction: membership, idempotency, permission, quote visibility, the attachment
 * (claimed with its row lock), seq assignment, and linking the attachment to the new message.
 *
 * A repeated `clientTxn` returns the stored message with `duplicate: true` and writes nothing — even if
 * sending is no longer allowed or its attachment is linked by now — provided the sender can still read
 * it; otherwise 409 `client_txn_reused`. `lock` is what the transaction holds (for the reply trigger).
 *
 * Who its mentions mean is decided here, once, under the conversation's lock (Task M): the picked ones are checked
 * against the text and the current members (`checkPicked`, 400 `bad_mentions`, nothing stored), and what is typed and
 * not picked is read (`mentionsAtSend`); both are stored with the message (`messages.mentions`), with whether it asked
 * an Agent it could not name (`messages.asks_agent`). Nothing reads its text again to decide who was meant.
 */
export async function sendMessage(
  t: Tx,
  conversationId: string,
  senderId: string,
  input: SendInput,
  config: Pick<Config, "social">,
): Promise<{ message: StoredMessage; duplicate: boolean; lock: WriteLock }> {
  const lock = await lockForWrite(t, conversationId, senderId);

  const prior = await t.query<MessageRow>(
    `select ${MESSAGE_COLUMNS} from messages m where m.conversation_id = $1 and m.sender_id = $2 and m.client_txn = $3`,
    [conversationId, senderId, input.clientTxn],
  );
  if (prior.rows[0]) {
    const readable = await t.query(`select 1 from messages m ${VISIBLE_JOIN} where m.id = $2`, [senderId, prior.rows[0].id]);
    if (readable.rowCount === 0) throw new AppError(409, "client_txn_reused");
    return { message: toStored(prior.rows[0]), duplicate: true, lock };
  }

  if (input.attachmentId === undefined && !input.text) throw invalid();
  await assertCanSend(t, lock, config);

  if (input.replyToSeq !== undefined) {
    const quoted = await t.query(`select 1 from messages m ${VISIBLE_JOIN} where m.conversation_id = $2 and m.seq = $3`, [
      senderId,
      conversationId,
      input.replyToSeq,
    ]);
    if (quoted.rowCount === 0) throw invalid();
  }

  const body: MessageBody = {};
  if (input.text) body.text = input.text;
  if (input.replyToSeq !== undefined) body.replyToSeq = input.replyToSeq;
  if (input.attachmentId !== undefined) {
    // Unknown, someone else's, another conversation's and already sent all look the same.
    const attachment = await claimAttachment(t, input.attachmentId, conversationId, senderId);
    if (!attachment) throw invalid();
    body.attachment = attachment;
  }

  const text = input.text ?? "";
  const picked = input.mentions ?? [];
  // The text's addresses, found once for both (fix round 2) — the picked tags' own text never one (tidy round, m-6);
  // none to find in a text without an `@`, where nothing is picked or read (m-8).
  const addresses = text.includes("@") ? addressRanges(text, picked.map((m) => [m.start, m.start + m.length] as const)) : [];
  await checkPicked(t, conversationId, text, picked, addresses);
  const read = await mentionsAtSend(t, { id: conversationId, type: lock.conversation.type }, text, picked, addresses);
  const message = await insertMessage(t, conversationId, senderId, body.attachment ? "file" : "text", body, input.clientTxn, read);
  if (body.attachment && !(await linkAttachment(t, body.attachment.id, message.id))) throw invalid();
  return { message, duplicate: false, lock };
}
