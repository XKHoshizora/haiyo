import type { FastifyBaseLogger } from "fastify";
import { PRODUCT_NAME } from "../brand.ts";
import type { ConversationEvents } from "../conversations/events.ts";
import { visibleJoin } from "../conversations/store.ts";
import type { Db } from "../db.ts";
import type { StoredMessage } from "../messages/model.ts";
import { blockedEitherWay } from "../social/relations.ts";
import type { ApnsClient, ApnsFailure } from "./apns.ts";
import { removeDeadDevice, type PushDevice } from "./devices.ts";

/** The one thing a push says (system wording, never a sender, a group's name or a message's text). */
export const PUSH_BODY = "你有新消息";

/** How often the counters are written to the log, when anything was counted (and once more at the stop). */
const SUMMARY_EVERY_MS = 10 * 60_000;

/**
 * A push's payload, content-free always: the product's name and `PUSH_BODY` as the alert, the conversation's id to open it
 * (`c`, what the shell turns into `haiyo:open {path: "/chat/<c>"}`) and to group the conversation's pushes on the phone
 * (`thread-id`). No badge: the service has no unread total yet (S6); when it does, its number goes in `aps.badge`.
 */
export function pushPayload(conversationId: string): string {
  return JSON.stringify({ aps: { alert: { title: PRODUCT_NAME, body: PUSH_BODY }, sound: "default", "thread-id": conversationId }, c: conversationId });
}

/**
 * Whether a stored message is one a push is for: what counts as unread does (sync/read.ts `unread`, the web client's
 * `countsAsUnread`) — not a system notice, not an Agent's acknowledgement (`body.ack`, messages/model.ts
 * `notAcknowledgement`). An Agent's reply, in its owner's own conversation or in a group, counts; so does a person's message.
 */
export function countsForPush(m: StoredMessage): boolean {
  return m.kind !== "system" && m.body.ack !== true;
}

/** What has been counted since the last `flush` (README "Push notifications", Metrics in the log). */
export interface PushStats {
  /** Pushes APNs took. */
  sent: number;
  /** Devices deleted because APNs said their token is dead. */
  removed: number;
  /** Phones not pushed to because their own session had a socket open. */
  present: number;
  /** Pushes not delivered, by class (src/push/apns.ts `ApnsFailure`; only the classes that happened). */
  failed: Partial<Record<ApnsFailure, number>>;
}

export interface Notifier {
  /** Resolves once nothing is under way (the test harness waits on it before it empties the database). */
  idle(): Promise<void>;
  /** The counters since the last flush, zeroed; written to the log as one line when anything was counted. */
  flush(): PushStats;
  /** Stops listening; waits for what is under way; writes the last counters. */
  close(): Promise<void>;
}

export interface NotifierDeps {
  db: Db;
  /** Null: push is not configured; nothing is read or sent for it. */
  apns: ApnsClient | null;
  /** Whether a session has a socket registered (src/sync/hub.ts `hasSocketFor`). */
  presence: { hasSocketFor(sessionId: string): boolean };
  conversations: ConversationEvents;
  log: Pick<FastifyBaseLogger, "info" | "warn">;
  /** The push variables that are unset when some are set, and those set but malformed (config.ts `AppleConfig`): one WARN line at start names them. */
  missing: string[];
  malformed: string[];
}

/** One push to make: a phone, and the conversation it is about. */
type Target = Pick<PushDevice, "id" | "sessionId" | "token" | "env"> & { conversationId: string; seenAt: string };

/**
 * The phones the messages are pushed to, one per phone and conversation: of each current member who may see the message
 * (THE visibility rule, `visibleJoin`), not its sender, with no block either way between them and its sender, whose
 * session still lasts. Whether that session is present is asked afterwards, in this process (`present`).
 */
async function targets(db: Db, messages: StoredMessage[]): Promise<Target[]> {
  const { rows } = await db.query<{ id: string; session_id: string; token: string; env: "sandbox" | "production"; seen_at: string; conversation_id: string }>(
    // `last_seen_at` as text: to the microsecond, for `removeDeadDevice`.
    `select distinct d.id, d.session_id, d.token, d.env, d.last_seen_at::text as seen_at, m.conversation_id
       from unnest($1::uuid[], $2::bigint[], $3::uuid[]) as m (conversation_id, seq, sender_id)
       join (select conversation_id, principal_id as reader_id from memberships where left_seq is null) r
         on r.conversation_id = m.conversation_id and r.reader_id <> m.sender_id
       ${visibleJoin("r.reader_id")}
       join push_devices d on d.principal_id = r.reader_id
       join "session" s on s.id = d.session_id and s."expiresAt" > now()
      where not ${blockedEitherWay("r.reader_id", "m.sender_id")}
      order by m.conversation_id, d.id`,
    [messages.map((m) => m.conversationId), messages.map((m) => m.seq), messages.map((m) => m.senderId)],
  );
  return rows.map((r) => ({ id: r.id, sessionId: r.session_id, token: r.token, env: r.env, seenAt: r.seen_at, conversationId: r.conversation_id }));
}

/**
 * Pushes to phones (README "Push notifications"). Listens to every stored message (after its commit, as the hub does) and,
 * for those that count (`countsForPush`), pushes each target phone (`targets`) whose own session has no socket at the hub:
 * the page in the iOS app closes its socket when the app goes to the background, so a phone in the background is pushed
 * to — also while its person has the web open on another session — and a phone whose page is open is not (the socket
 * brings the message). A push APNs says is for a dead token deletes the device. Never logs a token, a conversation's id, a
 * person or any text: counters only (`flush`), every `SUMMARY_EVERY_MS` and at the stop.
 */
export function createNotifier(deps: NotifierDeps): Notifier {
  const { db, apns, presence, log } = deps;
  const under = new Set<Promise<void>>();
  let stats: PushStats = { sent: 0, removed: 0, present: 0, failed: {} };
  let authSaid = false;
  let closed = false;

  if (apns === null && (deps.missing.length > 0 || deps.malformed.length > 0)) {
    // Names only: never a value (the key is a secret). A malformed Team or bundle id also turns the universal-links file off.
    log.warn(
      { metric: "push_off", missing: deps.missing, malformed: deps.malformed },
      "push notifications are off: these Apple variables are missing or malformed (a malformed one is ignored; fix it and restart)",
    );
  }

  const count = (why: ApnsFailure) => {
    stats.failed[why] = (stats.failed[why] ?? 0) + 1;
    // A refused provider token is the key's or the ids' fault, and refuses every push: said once, by its class alone.
    if (why === "auth" && !authSaid) {
      authSaid = true;
      log.warn({ metric: "push_auth_refused" }, "APNs refused the provider token: check APNS_KEY_ID, APNS_KEY_P8 and APPLE_TEAM_ID");
    }
  };

  async function pushOne(client: ApnsClient, t: Target): Promise<void> {
    if (presence.hasSocketFor(t.sessionId)) {
      stats.present++;
      return;
    }
    const result = await client.send({ token: t.token, env: t.env, collapseId: t.conversationId, payload: pushPayload(t.conversationId) });
    if (result.outcome === "sent") stats.sent++;
    else if (result.outcome === "gone") {
      if (await removeDeadDevice(db, t)) stats.removed++;
    } else count(result.why);
  }

  async function deliver(client: ApnsClient, messages: StoredMessage[]): Promise<void> {
    let found: Target[];
    try {
      found = await targets(db, messages);
    } catch (err) {
      // Nobody is pushed for these messages; they are delivered by every other way as ever.
      log.warn({ metric: "push_targets_failed", code: (err as { code?: string }).code }, "push: who to push to could not be read");
      return;
    }
    await Promise.all(found.map((t) => pushOne(client, t).catch((err: unknown) => {
      log.warn({ metric: "push_failed", code: (err as { code?: string }).code }, "push: a push could not be finished");
    })));
  }

  const off = deps.conversations.onMessages((messages) => {
    if (apns === null || closed) return;
    const counted = messages.filter(countsForPush);
    if (counted.length === 0) return;
    const job: Promise<void> = deliver(apns, counted).finally(() => under.delete(job));
    under.add(job);
  });

  function flush(): PushStats {
    const out = stats;
    stats = { sent: 0, removed: 0, present: 0, failed: {} };
    const failed = Object.values(out.failed).reduce((n, k) => n + (k ?? 0), 0);
    if (out.sent + out.removed + out.present + failed > 0) log.info({ metric: "push", ...out }, "push: counters since the last line");
    return out;
  }

  const timer = setInterval(() => void flush(), SUMMARY_EVERY_MS);
  timer.unref();

  return {
    async idle() {
      while (under.size > 0) await Promise.allSettled([...under]);
    },
    flush,
    async close() {
      closed = true;
      off();
      clearInterval(timer);
      while (under.size > 0) await Promise.allSettled([...under]);
      flush();
    },
  };
}
