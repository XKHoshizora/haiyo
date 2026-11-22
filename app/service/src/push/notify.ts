import type { FastifyBaseLogger } from "fastify";
import { PRODUCT_NAME } from "../brand.ts";
import type { ConversationEvents } from "../conversations/events.ts";
import { visibleJoin } from "../conversations/store.ts";
import type { Db } from "../db.ts";
import type { StoredMessage } from "../messages/model.ts";
import { blockedEitherWay } from "../social/relations.ts";
import { CLOSE_GRACE_MS, CONFIGURATION_FAILURES, type ApnsClient, type ApnsFailure } from "./apns.ts";
import { removeDeadDevice, removeExpiredDevices, type PushDevice, type PushEnv } from "./devices.ts";

/** The one thing a push says (system wording, never a sender, a group's name or a message's text). */
export const PUSH_BODY = "你有新消息";

/**
 * How long a socket of the phone's own session has to answer a ping before the phone is pushed anyway (`Hub.probe`): a page
 * in front answers within a round trip; a suspended app's socket that never got its close out cannot. So such a "ghost" costs
 * the push this much delay, never the push.
 */
export const PRESENCE_PROBE_MS = 3_000;

/**
 * How often the counters are written to the log, when anything was counted (and once more at the stop), and the phones of
 * expired sessions are deleted.
 */
const SUMMARY_EVERY_MS = 10 * 60_000;

/**
 * The most the whole stop takes: the sender's close (its retry waits end at once; its connections, a closing one too, are
 * destroyed after its grace) and then the pushes under way, within one deadline. What is still out then is abandoned —
 * nothing of it is written anywhere.
 */
export const STOP_WAIT_MS = 5_000;

/** What each configuration refusal tells the operator to check (said once per process, class and host). */
const CONFIGURATION_ADVICE: Readonly<Record<string, (host: string) => string>> = {
  auth: (host) => `APNs (${host}) refused the provider token: check APNS_KEY_ID, APNS_KEY_P8 and APPLE_TEAM_ID; pushes to ${host} pause and are tried again later`,
  key_env: (host) =>
    `APNs: this key does not cover the ${host} environment: create the APNs key as "Sandbox & Production" (team-scoped) and set APNS_KEY_ID and APNS_KEY_P8 to it; pushes to ${host} pause, the other environment is not affected`,
  topic: (host) =>
    `APNs (${host}) refused the topic: check APPLE_BUNDLE_ID (the app's bundle id is the push topic), or a phone runs another build of the app; no phone was deleted`,
  token_rate: (host) => `APNs (${host}) says the provider token was renewed too often (restarts in a row?); pushes to ${host} pause and are tried again later`,
};

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

/** What has been counted since the last `flush` (README "Push notifications", Counters in the log). */
export interface PushStats {
  /** Pushes APNs took. */
  sent: number;
  /** Devices deleted because APNs said their token is dead. */
  removed: number;
  /** Phones not pushed to because a socket of their own session answered (`PRESENCE_PROBE_MS`). */
  present: number;
  /** Pushes not made because that phone's push for the same conversation was still out (asked, queued, sent or retried). */
  coalesced: number;
  /** Pushes not made because, after a probe without an answer, they were no longer wanted (`stillWanted`). */
  stale: number;
  /** Pushes not delivered, by class (src/push/apns.ts `ApnsFailure`; only the classes that happened). */
  failed: Partial<Record<ApnsFailure, number>>;
}

export interface Notifier {
  /** Resolves once nothing is under way (the test harness waits on it before it empties the database). */
  idle(): Promise<void>;
  /** The counters since the last flush, zeroed; written to the log as one line when anything was counted. */
  flush(): PushStats;
  /**
   * The stop: stops listening, closes the sender (its retry waits end at once), waits at most `STOP_WAIT_MS` for what is
   * under way, and writes the last counters. Again: nothing more.
   */
  close(): Promise<void>;
}

export interface NotifierDeps {
  db: Db;
  /** Null: push is not configured; nothing is read or sent for it. Closed by `close`. */
  apns: ApnsClient | null;
  /** Whether a session has an open socket, and whether it answers (src/sync/hub.ts `hasSocketFor`, `probe`). */
  presence: { hasSocketFor(sessionId: string): boolean; probe(sessionId: string, timeoutMs: number): Promise<boolean> };
  conversations: ConversationEvents;
  log: Pick<FastifyBaseLogger, "info" | "warn">;
  /** The push variables that are unset when some are set, and those set but malformed (config.ts `AppleConfig`): one WARN line at start names them. */
  missing: string[];
  malformed: string[];
  /** Whether the universal-links file is served (`AppleConfig.app`): the same line says when it is not. */
  links: boolean;
  /** Tests only (no variable sets it): the timer's period, the counters' line and the expired-phone sweep; default 10 minutes. */
  everyMs?: number;
}

/** One push to make: a phone, and the conversation it is about (up to `newestSeq`, the batch's newest message there). */
type Target = Pick<PushDevice, "id" | "principalId" | "sessionId" | "token" | "env"> & { conversationId: string; seenAt: string; newestSeq: number };

/**
 * Whether a push decided before a probe is still wanted after it (the probe can take `PRESENCE_PROBE_MS`): the phone's row
 * as it was then (same id, session and registration — not signed out, not moved to another account, not registered again),
 * its session still lasting, and its person a member who has not read up to the message meanwhile (on another device).
 * One indexed query; asked only when a probe ran and had no answer.
 */
async function stillWanted(db: Db, t: Target): Promise<boolean> {
  const { rowCount } = await db.query(
    `select 1 from push_devices d
       join "session" s on s.id = d.session_id and s."expiresAt" > now()
       join memberships ms on ms.conversation_id = $4 and ms.principal_id = d.principal_id and ms.left_seq is null
      where d.id = $1 and d.session_id = $2 and d.principal_id = $3 and d.last_seen_at = $5::timestamptz and ms.read_seq < $6`,
    [t.id, t.sessionId, t.principalId, t.conversationId, t.seenAt, t.newestSeq],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * The phones the messages are pushed to, one per phone and conversation: of each current member who may see the message
 * (THE visibility rule, `visibleJoin`), not its sender, with no block either way between them and its sender — an Agent's
 * message by its owner's blocks (an Agent is blocked as its owner is: `coalesce(owner_id, id)`, as agents/runs.ts does) —,
 * whose session still lasts. Whether that session is present is asked afterwards, in this process.
 */
async function targets(db: Db, messages: StoredMessage[]): Promise<Target[]> {
  const { rows } = await db.query<{ id: string; principal_id: string; session_id: string; token: string; env: "sandbox" | "production"; seen_at: string; conversation_id: string }>(
    // `last_seen_at` as text: to the microsecond, for `removeDeadDevice` and `stillWanted`.
    `select distinct d.id, d.principal_id, d.session_id, d.token, d.env, d.last_seen_at::text as seen_at, m.conversation_id
       from unnest($1::uuid[], $2::bigint[], $3::uuid[]) as m (conversation_id, seq, sender_id)
       join principals snd on snd.id = m.sender_id
       join (select conversation_id, principal_id as reader_id from memberships where left_seq is null) r
         on r.conversation_id = m.conversation_id and r.reader_id <> m.sender_id
       ${visibleJoin("r.reader_id")}
       join push_devices d on d.principal_id = r.reader_id
       join "session" s on s.id = d.session_id and s."expiresAt" > now()
      where not ${blockedEitherWay("r.reader_id", "coalesce(snd.owner_id, snd.id)")}
      order by m.conversation_id, d.id`,
    [messages.map((m) => m.conversationId), messages.map((m) => m.seq), messages.map((m) => m.senderId)],
  );
  const newest = new Map<string, number>();
  for (const m of messages) newest.set(m.conversationId, Math.max(newest.get(m.conversationId) ?? 0, m.seq));
  return rows.map((r) => ({
    id: r.id,
    principalId: r.principal_id,
    sessionId: r.session_id,
    token: r.token,
    env: r.env,
    seenAt: r.seen_at,
    conversationId: r.conversation_id,
    newestSeq: newest.get(r.conversation_id) ?? 0,
  }));
}

/**
 * Pushes to phones (README "Push notifications"). Listens to every stored message (after its commit, as the hub does) and,
 * for those that count (`countsForPush`), pushes each target phone (`targets`) unless its own session is present: it has an
 * open socket at the hub AND that socket answers a ping within `PRESENCE_PROBE_MS` (the page closes its socket when the app
 * goes to the background; a suspended app whose close never got out leaves an open socket that cannot answer — pushed after
 * the probe instead of never). One push per phone and conversation at a time: a message while that phone's push for the
 * conversation is still out (asked, queued, sent or retried) adds none (`coalesced`; the same content and collapse id).
 * A dead token (410, `BadDeviceToken`) deletes the device; a configuration refusal pauses pushes in the sender and is said
 * once per class. Never logs a token, a conversation's id, a person or any text: counters only (`flush`), every
 * `SUMMARY_EVERY_MS` and at the stop.
 */
export function createNotifier(deps: NotifierDeps): Notifier {
  const { db, apns, presence, log } = deps;
  const under = new Set<Promise<void>>();
  /** `<device id>:<conversation id>` of the pushes out. */
  const out = new Set<string>();
  const said = new Set<string>();
  let stats: PushStats = { sent: 0, removed: 0, present: 0, coalesced: 0, stale: 0, failed: {} };
  let closed = false;
  let closing: Promise<void> | null = null;

  if (apns === null && (deps.missing.length > 0 || deps.malformed.length > 0)) {
    // Names only: never a value (the key is a secret). Without both Team and bundle ids the universal-links file is off too,
    // and the line says so: an operator who set up the links alone would otherwise read only "push off".
    log.warn(
      { metric: "push_off", missing: deps.missing, malformed: deps.malformed, links: deps.links ? "on" : "off" },
      deps.links
        ? "push notifications are off: these Apple variables are missing or malformed (a malformed one is ignored; fix it and restart)"
        : "push notifications and universal links are off: these Apple variables are missing or malformed (a malformed one is ignored; fix it and restart)",
    );
  }

  const count = (why: ApnsFailure, host: PushEnv) => {
    stats.failed[why] = (stats.failed[why] ?? 0) + 1;
    // The configuration's refusal is the key's, the ids' or the topic's fault, not a phone's: said once per class and host,
    // by its class and the host alone (the host is a name of Apple's, not anything of a person's).
    const key = `${why}:${host}`;
    if (CONFIGURATION_FAILURES.has(why) && !said.has(key)) {
      said.add(key);
      log.warn({ metric: "push_config_refused", class: why, host }, CONFIGURATION_ADVICE[why]?.(host) ?? "APNs refused the configuration");
    }
  };

  async function pushOne(client: ApnsClient, t: Target): Promise<void> {
    // Present only when a socket of its own session is open and answers; else (none, closing, silent, closed meanwhile) pushed.
    if (presence.hasSocketFor(t.sessionId)) {
      if (await presence.probe(t.sessionId, PRESENCE_PROBE_MS)) {
        stats.present++;
        return;
      }
      // The probe took up to `PRESENCE_PROBE_MS`: what was read before it is asked once more.
      if (!(await stillWanted(db, t))) {
        stats.stale++;
        return;
      }
    }
    const result = await client.send({ token: t.token, env: t.env, collapseId: t.conversationId, payload: pushPayload(t.conversationId) });
    if (result.outcome === "sent") stats.sent++;
    else if (result.outcome === "gone") {
      if (await removeDeadDevice(db, t)) stats.removed++;
    } else count(result.why, t.env);
  }

  /** `pushOne` unless that phone's push for the conversation is out already; the key is held until this one is over. */
  async function pushOnce(client: ApnsClient, t: Target): Promise<void> {
    const key = `${t.id}:${t.conversationId}`;
    if (out.has(key)) {
      stats.coalesced++;
      return;
    }
    out.add(key);
    try {
      await pushOne(client, t);
    } finally {
      out.delete(key);
    }
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
    await Promise.all(
      found.map((t) =>
        pushOnce(client, t).catch((err: unknown) => {
          log.warn({ metric: "push_failed", code: (err as { code?: string }).code }, "push: a push could not be finished");
        }),
      ),
    );
  }

  const off = deps.conversations.onMessages((messages) => {
    if (apns === null || closed) return;
    const counted = messages.filter(countsForPush);
    if (counted.length === 0) return;
    const job: Promise<void> = deliver(apns, counted).finally(() => under.delete(job));
    under.add(job);
  });

  function flush(): PushStats {
    const counted = stats;
    stats = { sent: 0, removed: 0, present: 0, coalesced: 0, stale: 0, failed: {} };
    const failed = Object.values(counted.failed).reduce((n, k) => n + (k ?? 0), 0);
    if (counted.sent + counted.removed + counted.present + counted.coalesced + counted.stale + failed > 0) log.info({ metric: "push", ...counted }, "push: counters since the last line");
    return counted;
  }

  /**
   * The phones of expired sessions deleted (push/devices.ts `removeExpiredDevices`), counted; on this timer, which always
   * runs — with or without APNs (phones are registered either way), whatever `MEMORY.changesSweepMs` says.
   */
  function sweepExpired(): void {
    if (closed) return;
    const job: Promise<void> = removeExpiredDevices(db)
      .then((removed) => {
        if (removed > 0) log.info({ metric: "push_devices_expired", removed }, "phones of expired sessions were removed");
      })
      .catch((err: unknown) => log.warn({ code: (err as { code?: string }).code }, "push device sweep failed; trying again next interval"))
      .finally(() => under.delete(job));
    under.add(job);
  }

  const timer = setInterval(() => {
    flush();
    sweepExpired();
  }, deps.everyMs ?? SUMMARY_EVERY_MS);
  timer.unref();

  async function stop(): Promise<void> {
    closed = true;
    off();
    clearInterval(timer);
    // One deadline for all of it. The sender first: its retry waits end at once and its connections — a closing one too —
    // are destroyed by its grace, so nothing here can hold the stop for a slow APNs; then what is under way, until the
    // deadline.
    const deadline = Date.now() + STOP_WAIT_MS;
    await apns?.close(Math.min(CLOSE_GRACE_MS, STOP_WAIT_MS));
    let waited: NodeJS.Timeout | undefined;
    await Promise.race([
      (async () => {
        while (under.size > 0) await Promise.allSettled([...under]);
      })(),
      new Promise<void>((resolve) => {
        waited = setTimeout(resolve, Math.max(0, deadline - Date.now()));
        waited.unref();
      }),
    ]);
    clearTimeout(waited);
    flush();
  }

  return {
    async idle() {
      while (under.size > 0) await Promise.allSettled([...under]);
    },
    flush,
    close() {
      closing ??= stop();
      return closing;
    },
  };
}
