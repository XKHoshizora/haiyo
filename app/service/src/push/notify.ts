import type { FastifyBaseLogger } from "fastify";
import { PRODUCT_NAME } from "../brand.ts";
import type { ConversationEvents } from "../conversations/events.ts";
import { visibleJoin } from "../conversations/store.ts";
import type { Db } from "../db.ts";
import type { StoredMessage } from "../messages/model.ts";
import { socialPlaceSql } from "../social/place.ts";
import { blockedEitherWay } from "../social/relations.ts";
import { CLOSE_GRACE_MS, CONFIGURATION_FAILURES, type ApnsClient, type ApnsFailure } from "./apns.ts";
import { removeDeadDevice, removeExpiredDevices, type PushDevice, type PushEnv } from "./devices.ts";

/** The one thing a push says (system wording, never a sender, a group's name or a message's text). */
export const PUSH_BODY = "你有新消息";
/** What a push about a request says (system wording, never who asks, for whom, or which Agent). */
export const REQUEST_PUSH_BODY = "你有新的申请";
/**
 * The collapse id (and `thread-id`) of every push about a request: the phone shows one notification for all the requests that
 * wait, a later one replacing the earlier. A constant: it names no person and no request.
 */
export const REQUESTS_COLLAPSE_ID = "requests";
/**
 * The quiet window of a phone for pushes about requests: once APNs took one for that phone (`sent`), no other goes to it for
 * this long, whoever asks and whatever is asked (counted `coalesced`: the notification would be the same one, and the requests
 * are listed in the app all the same). Without it a stranger could ring a phone again and again: send, withdraw, send.
 */
export const REQUEST_QUIET_MS = 10 * 60_000;

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
  auth: (host) =>
    `APNs (${host}) refused the provider token or the request: check APNS_KEY_ID, APNS_KEY_P8 and APPLE_TEAM_ID; the pushes it covers (that host, or for a refusal Apple gives no cause for that phone) pause and are tried again later`,
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
 * The payload of a push about a request, content-free like every push: the product's name and `REQUEST_PUSH_BODY`, nothing of
 * who asks, of whom or of which Agent, and no `c` — there is no conversation to open. The shell reads `c` alone of a tapped
 * notification, as a conversation's id (docs/reviews/2026-11-24-ios-shell-review.md), and documents no other address, so a tap
 * on this one opens the app as it was: no field is added that the shell would need a new build to read.
 */
export function requestPushPayload(): string {
  return JSON.stringify({ aps: { alert: { title: PRODUCT_NAME, body: REQUEST_PUSH_BODY }, sound: "default", "thread-id": REQUESTS_COLLAPSE_ID } });
}

/**
 * A request that newly waits for a person's answer (`Notifier.requestWaiting`): a friend request, by its id; or an add of an
 * Agent that waits for its owner's decision, by the Agent and who asks (`agent_contacts`' key).
 */
export type WaitingRequest = { friendRequestId: string } | { agentId: string; subjectId: string };

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
  /**
   * Pushes not made because that phone's push for the same conversation (or about requests) was still out (asked, queued, sent
   * or retried), or, about requests, because that phone is in its quiet window (`REQUEST_QUIET_MS`).
   */
  coalesced: number;
  /** Pushes not made because, after a probe without an answer, they were no longer wanted (`PushKind.stillWanted`). */
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
   * What the timer does besides the counters: deletes the phones of expired sessions now, and forgets the quiet windows that are
   * over (`REQUEST_QUIET_MS`); how many phones were deleted.
   */
  sweepExpired(): Promise<number>;
  /** Whether the timer runs (not under the test harness: `everyMs` 0). */
  readonly ticking: boolean;
  /** How many quiet windows are held: those of phones in one now, and those over but not yet forgotten (`sweepExpired`). */
  readonly quietWindows: number;
  /**
   * Called once the transaction that made `request` has committed, and only when that call made it (not one that was waiting
   * already): it now waits for its person's answer, whose phones are pushed `REQUEST_PUSH_BODY` as a message's are (present,
   * coalesced, re-checked after a probe, counted). Never throws and never waits: the push runs on its own. Nothing without APNs
   * or once stopped.
   */
  requestWaiting(request: WaitingRequest): void;
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
  /**
   * The timer's period — the counters' line and the expired-phone sweep —, default 10 minutes; 0: no timer at all (the test
   * harness: no timer starts work between two tests; `sweepExpired` and `flush` are then called by hand). Tests only: no
   * variable sets it.
   */
  everyMs?: number;
  /** The clock of the quiet windows (`REQUEST_QUIET_MS`), default `Date.now`. Tests only: the harness's clock moves it. */
  now?: () => number;
}

/** A phone to push, as it was read when its push was decided. */
type Phone = Pick<PushDevice, "id" | "principalId" | "sessionId" | "token" | "env"> & { seenAt: string };
type PhoneRow = { id: string; principal_id: string; session_id: string; token: string; env: PushEnv; seen_at: string };
/** A phone's columns (`push_devices d`), `last_seen_at` as text: to the microsecond, for `removeDeadDevice` and the re-checks. */
const PHONE_COLUMNS = "d.id, d.principal_id, d.session_id, d.token, d.env, d.last_seen_at::text as seen_at";
const phoneOf = (r: PhoneRow): Phone => ({ id: r.id, principalId: r.principal_id, sessionId: r.session_id, token: r.token, env: r.env, seenAt: r.seen_at });
/** Only a phone whose session still lasts is pushed (an expired session's row is never pushed to). */
const LASTING_SESSION = `join "session" s on s.id = d.session_id and s."expiresAt" > now()`;

/**
 * SQL: the phone `d` is as it was when its push was decided — the same id, session, person and registration (not signed out,
 * not moved to another account, not registered again) — and its session still lasts. Its four parameters from `$n`
 * (`phoneParams`).
 */
const unchangedPhone = (n: number): string =>
  `d.id = $${n} and d.session_id = $${n + 1} and d.principal_id = $${n + 2} and d.last_seen_at = $${n + 3}::timestamptz
   and exists (select 1 from "session" s where s.id = d.session_id and s."expiresAt" > now())`;
const phoneParams = (p: Phone): string[] => [p.id, p.sessionId, p.principalId, p.seenAt];

/**
 * One kind of push (a message's, a request's). One per phone and `key` at a time: a later one while it is out (asked, queued,
 * sent or retried) adds none — it is folded into the one out (`absorb`) and counted `coalesced` —, since it would carry the
 * same content and collapse id. `stillWanted`: whether a push decided before a probe is still wanted after it (the probe can
 * take `PRESENCE_PROBE_MS`), for everything folded into it meanwhile too; one indexed query, asked only when a probe ran and
 * had no answer. `quietMs`: once APNs took one (`sent`), none more of the same key goes to that phone for this long (counted
 * `coalesced` too); a kind without it has no window.
 */
interface PushKind<T extends Phone> {
  key(t: T): string;
  collapseId(t: T): string;
  payload(t: T): string;
  absorb(out: T, later: T): void;
  stillWanted(db: Db, t: T): Promise<boolean>;
  quietMs?: number;
}

/** A message's push: a phone, and the conversation it is about (up to `newestSeq`, the newest message there it stands for). */
type MessageTarget = Phone & { conversationId: string; newestSeq: number };

/**
 * A message's push, by conversation: the conversation's id is its collapse id (a later push of it replaces the earlier on the
 * phone). Still wanted after a probe while the phone is unchanged (`unchangedPhone`) and its person a member who has not read
 * up to the newest message it stands for meanwhile (on another device).
 */
const MESSAGE_PUSH: PushKind<MessageTarget> = {
  key: (t) => t.conversationId,
  collapseId: (t) => t.conversationId,
  payload: (t) => pushPayload(t.conversationId),
  absorb(out, later) {
    out.newestSeq = Math.max(out.newestSeq, later.newestSeq);
  },
  async stillWanted(db, t) {
    const { rowCount } = await db.query(
      `select 1 from push_devices d
         join memberships ms on ms.conversation_id = $5 and ms.principal_id = d.principal_id and ms.left_seq is null
        where ${unchangedPhone(1)} and ms.read_seq < $6`,
      [...phoneParams(t), t.conversationId, t.newestSeq],
    );
    return (rowCount ?? 0) > 0;
  },
};

/**
 * The phones the messages are pushed to, one per phone and conversation: of each current member who may see the message
 * (THE visibility rule, `visibleJoin`), not its sender, with no block either way between them and its sender — an Agent's
 * message by its owner's blocks (an Agent is blocked as its owner is: `coalesce(owner_id, id)`, as agents/runs.ts does) —,
 * whose session still lasts. Whether that session is present is asked afterwards, in this process. Never the owner who only
 * observes a social conversation (the `observer` membership of an `agent_social` conversation, design §2: such a conversation is
 * listed under the Agent, outside the main list and the unread total, and sends no notification): they are pushed for none of its
 * messages, not the visitor's, not their Agent's, not a supervisor's. Everyone else is, as in any conversation.
 */
async function messageTargets(db: Db, messages: StoredMessage[]): Promise<MessageTarget[]> {
  const { rows } = await db.query<PhoneRow & { conversation_id: string }>(
    `select distinct ${PHONE_COLUMNS}, m.conversation_id
       from unnest($1::uuid[], $2::bigint[], $3::uuid[]) as m (conversation_id, seq, sender_id)
       join principals snd on snd.id = m.sender_id
       join (select ms.conversation_id, ms.principal_id as reader_id from memberships ms join conversations rc on rc.id = ms.conversation_id
              where ms.left_seq is null and not (${socialPlaceSql("rc")} and ms.role = 'observer')) r
         on r.conversation_id = m.conversation_id and r.reader_id <> m.sender_id
       ${visibleJoin("r.reader_id")}
       join push_devices d on d.principal_id = r.reader_id
       ${LASTING_SESSION}
      where not ${blockedEitherWay("r.reader_id", "coalesce(snd.owner_id, snd.id)")}
      order by m.conversation_id, d.id`,
    [messages.map((m) => m.conversationId), messages.map((m) => m.seq), messages.map((m) => m.senderId)],
  );
  const newest = new Map<string, number>();
  for (const m of messages) newest.set(m.conversationId, Math.max(newest.get(m.conversationId) ?? 0, m.seq));
  return rows.map((r) => ({ ...phoneOf(r), conversationId: r.conversation_id, newestSeq: newest.get(r.conversation_id) ?? 0 }));
}

/** A request's push: a phone of the person the requests wait for, and the requests it stands for (those folded into it too). */
type RequestTarget = Phone & { requests: WaitingRequest[] };

/**
 * SQL: the people the given requests wait for — each request that still waits gives its person. A friend request pending and
 * not past its deadline (`expires_at`, as the lists read it): its recipient. An add of an Agent still `requested` and not past
 * its `until`, of an Agent that is not deleted, by a subject that is no deleted Agent (as the owner's `waiting` list reads it,
 * social/agent-contacts.ts `contactsOf`): the Agent's owner. Never across a block either way — between the two people of a
 * friend request; between whoever asks (the subject, the person behind it) and the owner or the Agent, as `discoverableSql`
 * has it — although a block cancels the one and ends the other already: a push cannot disagree with the request. Whoever asked
 * is never given. Its three parameters from `$n` (`waitingParams`).
 */
const waitingSql = (n: number): string => `
  select r.to_id as principal_id from friend_requests r
   where r.id = any($${n}::uuid[]) and r.status = 'pending' and r.expires_at >= now() and not ${blockedEitherWay("r.to_id", "r.from_id")}
  union
  select a.owner_id from unnest($${n + 1}::uuid[], $${n + 2}::uuid[]) as w (agent_id, subject_id)
    join agent_contacts c on c.agent_id = w.agent_id and c.subject_id = w.subject_id
    join principals a on a.id = c.agent_id
    join agents ag on ag.principal_id = c.agent_id and ag.deleted_at is null
   where c.state = 'requested' and c.until > now()
     and not exists (select 1 from agents sa where sa.principal_id = c.subject_id and sa.deleted_at is not null)
     and not ${blockedEitherWay("a.owner_id", "c.person_id, c.subject_id")} and not ${blockedEitherWay("c.agent_id", "c.person_id, c.subject_id")}`;

function waitingParams(requests: readonly WaitingRequest[]): [string[], string[], string[]] {
  const friends: string[] = [];
  const agents: string[] = [];
  const subjects: string[] = [];
  for (const r of requests) {
    if ("friendRequestId" in r) friends.push(r.friendRequestId);
    else {
      agents.push(r.agentId);
      subjects.push(r.subjectId);
    }
  }
  return [friends, agents, subjects];
}

/** The phones a request is pushed to: of the person it waits for (`waitingSql`), whose session still lasts. */
async function requestTargets(db: Db, request: WaitingRequest): Promise<RequestTarget[]> {
  const { rows } = await db.query<PhoneRow>(
    `select distinct ${PHONE_COLUMNS}
       from (${waitingSql(1)}) w
       join push_devices d on d.principal_id = w.principal_id
       ${LASTING_SESSION}
      order by d.id`,
    waitingParams([request]),
  );
  return rows.map((r) => ({ ...phoneOf(r), requests: [request] }));
}

/**
 * A request's push, one per phone for every request: its collapse id the constant `REQUESTS_COLLAPSE_ID`, so that several
 * requests show as one notification, and after one is sent none more for that phone within `REQUEST_QUIET_MS`. Still wanted
 * after a probe while the phone is unchanged (`unchangedPhone`) and any request it stands for still waits for its person
 * (`waitingSql`: not withdrawn, accepted, declined, expired or blocked meanwhile).
 */
const REQUEST_PUSH: PushKind<RequestTarget> = {
  quietMs: REQUEST_QUIET_MS,
  key: () => REQUESTS_COLLAPSE_ID,
  collapseId: () => REQUESTS_COLLAPSE_ID,
  payload: () => requestPushPayload(),
  absorb(out, later) {
    out.requests.push(...later.requests);
  },
  async stillWanted(db, t) {
    const { rowCount } = await db.query(`select 1 from push_devices d where ${unchangedPhone(1)} and d.principal_id in (${waitingSql(5)})`, [
      ...phoneParams(t),
      ...waitingParams(t.requests),
    ]);
    return (rowCount ?? 0) > 0;
  },
};

/**
 * Pushes to phones (README "Push notifications"). Listens to every stored message (after its commit, as the hub does) and,
 * for those that count (`countsForPush`), pushes each target phone (`messageTargets`) unless its own session is present: it has an
 * open socket at the hub AND that socket answers a ping within `PRESENCE_PROBE_MS` (the page closes its socket when the app
 * goes to the background; a suspended app whose close never got out leaves an open socket that cannot answer — pushed after
 * the probe instead of never). One push per phone and conversation at a time: a message while that phone's push for the
 * conversation is still out (asked, queued, sent or retried) adds none (`coalesced`; the same content and collapse id).
 * A request that newly waits for a person's answer (`requestWaiting`, called by its route after the commit) is pushed to that
 * person's phones the same way (`requestTargets`, `REQUEST_PUSH`), one push per phone for all requests at a time, and none
 * more to a phone within `REQUEST_QUIET_MS` of one that was sent to it.
 * A dead token (410, `BadDeviceToken`) deletes the device; a configuration refusal pauses pushes in the sender and is said
 * once per class. Never logs a token, a conversation's id, a request's, a person or any text: counters only (`flush`), every
 * `SUMMARY_EVERY_MS` and at the stop.
 */
export function createNotifier(deps: NotifierDeps): Notifier {
  const { db, apns, presence, log } = deps;
  const now = deps.now ?? Date.now;
  const under = new Set<Promise<unknown>>();
  const said = new Set<string>();
  /**
   * The quiet windows (`PushKind.quietMs`: the requests'), by `<device id>:<person>:<key>`: until when no push of that key goes
   * to that phone for the person signed in on it (another account registering the same token starts with none). Set only when APNs took one (`sent`): a phone that was present, a push no longer wanted, one that failed or went to a
   * dead token told the person nothing. In memory (a restart forgets them); one that is over is forgotten when it is next read
   * and by the timer (`sweepExpired`), so the map holds at most the phones sent such a push in the last window.
   */
  const quietUntil = new Map<string, number>();
  const inQuiet = (key: string): boolean => {
    const until = quietUntil.get(key);
    if (until === undefined) return false;
    if (now() < until) return true;
    quietUntil.delete(key);
    return false;
  };
  const forgetQuiet = (): void => {
    const at = now();
    for (const [key, until] of quietUntil) if (until <= at) quietUntil.delete(key);
  };
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

  /**
   * One push of `kind` to its phone: skipped as present, dropped as no longer wanted after a probe, or sent and its outcome
   * counted. Whether APNs took it (`sent`).
   */
  async function pushOne<T extends Phone>(client: ApnsClient, kind: PushKind<T>, t: T): Promise<boolean> {
    // Present only when a socket of its own session is open and answers; else (none, closing, silent, closed meanwhile) pushed.
    if (presence.hasSocketFor(t.sessionId)) {
      if (await presence.probe(t.sessionId, PRESENCE_PROBE_MS)) {
        stats.present++;
        return false;
      }
      // The probe took up to `PRESENCE_PROBE_MS`: what was read before it is asked once more, with what was folded into it since.
      if (!(await kind.stillWanted(db, t))) {
        stats.stale++;
        return false;
      }
    }
    const result = await client.send({ token: t.token, env: t.env, collapseId: kind.collapseId(t), payload: kind.payload(t) });
    if (result.outcome === "sent") stats.sent++;
    else if (result.outcome === "gone") {
      if (await removeDeadDevice(db, t)) stats.removed++;
    } else count(result.why, t.env);
    return result.outcome === "sent";
  }

  /**
   * The pushes of one kind: of the phones `read` gives, each pushed (`pushOne`) unless that phone's push of the same key is out
   * already — then folded into it (`PushKind.absorb`) and counted `coalesced` — or, for a kind with a quiet window, that phone is
   * in it (`coalesced` too; asked before any probe is spent). The pushes out, by `<device id>:<person>:<key>`, are the targets
   * as they now stand: what is folded into one is what the re-check after its probe asks about (the newest message, not the
   * first; every request, not the first). A key is held until its push is over, and a window, when that push was sent, is set
   * before the key is let go — in the same step, so that a push racing it finds the one or the other, never neither. The person
   * is in the key: a token registered by another account keeps its device row (devices.ts `registerDevice`), and its new person
   * neither inherits the previous person's window nor has a push folded into one the re-check would then drop as theirs.
   */
  function pushesOf<T extends Phone>(kind: PushKind<T>): (client: ApnsClient, read: () => Promise<T[]>) => Promise<void> {
    const out = new Map<string, T>();
    async function pushOnce(client: ApnsClient, t: T): Promise<void> {
      const key = `${t.id}:${t.principalId}:${kind.key(t)}`;
      const already = out.get(key);
      if (already) {
        kind.absorb(already, t);
        stats.coalesced++;
        return;
      }
      if (kind.quietMs !== undefined && inQuiet(key)) {
        stats.coalesced++;
        return;
      }
      out.set(key, t);
      try {
        if ((await pushOne(client, kind, t)) && kind.quietMs !== undefined) quietUntil.set(key, now() + kind.quietMs);
      } finally {
        out.delete(key);
      }
    }
    return async (client, read) => {
      let found: T[];
      try {
        found = await read();
      } catch (err) {
        // Nobody is pushed for this; the message or the request reaches its people by every other way as ever.
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
    };
  }

  const pushMessages = pushesOf(MESSAGE_PUSH);
  const pushRequests = pushesOf(REQUEST_PUSH);
  /**
   * Runs a job on its own (`idle` and the stop wait for it), and gives it back. A job never rejects: `pushesOf` and the sweep
   * catch every failure.
   */
  const start = <R>(job: Promise<R>): Promise<R> => {
    const tracked: Promise<R> = job.finally(() => under.delete(tracked));
    under.add(tracked);
    return tracked;
  };

  const off = deps.conversations.onMessages((messages) => {
    if (apns === null || closed) return;
    const counted = messages.filter(countsForPush);
    if (counted.length === 0) return;
    start(pushMessages(apns, () => messageTargets(db, counted)));
  });

  function flush(): PushStats {
    const counted = stats;
    stats = { sent: 0, removed: 0, present: 0, coalesced: 0, stale: 0, failed: {} };
    const failed = Object.values(counted.failed).reduce((n, k) => n + (k ?? 0), 0);
    if (counted.sent + counted.removed + counted.present + counted.coalesced + counted.stale + failed > 0) log.info({ metric: "push", ...counted }, "push: counters since the last line");
    return counted;
  }

  /**
   * The phones of expired sessions deleted (push/devices.ts `removeExpiredDevices`), counted, and the quiet windows that are
   * over forgotten; on this timer, which always runs — with or without APNs (phones are registered either way), whatever
   * `MEMORY.changesSweepMs` says.
   */
  function sweepExpired(): Promise<number> {
    if (closed) return Promise.resolve(0);
    forgetQuiet();
    return start(
      removeExpiredDevices(db).then(
        (n) => {
          if (n > 0) log.info({ metric: "push_devices_expired", removed: n }, "phones of expired sessions were removed");
          return n;
        },
        (err: unknown) => {
          log.warn({ code: (err as { code?: string }).code }, "push device sweep failed; trying again next interval");
          return 0;
        },
      ),
    );
  }

  const everyMs = deps.everyMs ?? SUMMARY_EVERY_MS;
  const timer =
    everyMs > 0
      ? setInterval(() => {
          flush();
          void sweepExpired();
        }, everyMs)
      : null;
  timer?.unref();

  async function stop(): Promise<void> {
    closed = true;
    off();
    if (timer) clearInterval(timer);
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
    quietUntil.clear();
    flush();
  }

  return {
    async idle() {
      while (under.size > 0) await Promise.allSettled([...under]);
    },
    flush,
    sweepExpired,
    get ticking() {
      return timer !== null && !closed;
    },
    get quietWindows() {
      return quietUntil.size;
    },
    requestWaiting(request) {
      if (apns === null || closed) return;
      start(pushRequests(apns, () => requestTargets(db, request)));
    },
    close() {
      closing ??= stop();
      return closing;
    },
  };
}
