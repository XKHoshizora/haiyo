import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import http2 from "node:http2";
import type { PushEnv } from "./devices.ts";

/**
 * Apple's push servers (developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns): a
 * development build's tokens are the sandbox's. Not configuration: tests point a client at a local server instead.
 */
export const APNS_ORIGINS: Readonly<Record<PushEnv, string>> = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
};

/**
 * How long one provider token is used (establishing-a-token-based-connection-to-apns: "Refresh your token no more than once
 * every 20 minutes and no less than once every 60 minutes"): 50 minutes, and never anew under 20 — not even when APNs says
 * it expired (a clock that is off would otherwise have it refuse every push for `TooManyProviderTokenUpdates`).
 */
export const TOKEN_LIFETIME_MS = 50 * 60_000;
export const TOKEN_MIN_AGE_MS = 20 * 60_000;
/**
 * How long pushes pause after APNs refused the configuration: the provider token (403: the key, its id, the Team ID), the
 * topic (the bundle id), or the token's renewals (`TooManyProviderTokenUpdates`) — every push, which would all fail the same
 * way; after `DeviceTokenNotForTopic`, only that token's (one phone of another app's build must not pause everyone's
 * pushes). Nothing is deleted for these: the phones are not at fault.
 */
export const CONFIGURATION_PAUSE_MS = 15 * 60_000;
/** At most this many tokens are remembered as paused (`DeviceTokenNotForTopic`); the oldest are forgotten first. */
const MAX_PAUSED_TOKENS = 10_000;
/** A push older than this is no news: APNs keeps it for a phone that is off at most this long (`apns-expiration`). */
const EXPIRY_S = 24 * 3600;
/** A connection idle this long is closed; the next push opens another ("Reuse a connection as long as possible"). */
const IDLE_CLOSE_MS = 60 * 60_000;
/** An error answer's body is a small JSON object; more than this is not read. */
const MAX_ANSWER_BYTES = 4096;

/**
 * Why a push was not delivered (the counters' classes: README "Push notifications"). The configuration's refusals — `auth`
 * (403), `topic` (the bundle id, or a token of another app), `token_rate` (`TooManyProviderTokenUpdates`) — start a pause
 * (`CONFIGURATION_PAUSE_MS`), during which a push is `paused` without being sent.
 */
export type ApnsFailure = "throttled" | "server" | "network" | "timeout" | "auth" | "topic" | "token_rate" | "rejected" | "overloaded" | "closed" | "paused";

/** The failures that are the configuration's, not a phone's: each is said once to the operator (src/push/notify.ts). */
export const CONFIGURATION_FAILURES: ReadonlySet<ApnsFailure> = new Set(["auth", "topic", "token_rate"]);

/** `gone`: APNs says the token is dead (410, 400 `BadDeviceToken`); the caller deletes the device. Nothing else is. */
export type ApnsOutcome = { outcome: "sent" } | { outcome: "gone" } | { outcome: "failed"; why: ApnsFailure };

export interface ApnsNotification {
  token: string;
  env: PushEnv;
  /** `apns-collapse-id` (at most 64 bytes): a later push with the same one replaces the earlier on the phone. */
  collapseId: string;
  /** The JSON payload, as it is sent (at most 4 KB). */
  payload: string;
}

export interface ApnsClient {
  /** Never throws: the outcome after at most `retryDelaysMs.length` retries. */
  send(n: ApnsNotification): Promise<ApnsOutcome>;
  /** Ends every connection; a push waiting for a retry ends `closed`, and so does every later one. */
  close(): Promise<void>;
}

export interface ApnsOptions {
  teamId: string;
  keyId: string;
  /** The `.p8` key's PEM (a P-256 private key; `loadConfig` checked it). */
  keyPem: string;
  /** `apns-topic`: the app's bundle id. */
  topic: string;
  /** Tests only (no variable sets it): a local server instead of Apple's (`APNS_ORIGINS`). */
  origins?: Readonly<Record<PushEnv, string>>;
  /**
   * The waits before each retry of a push APNs answered 429 `TooManyRequests` or 5xx, or whose connection broke or did not
   * answer in time ("You can retry with a delay, if you get the error code TooManyRequests"): default 2 s and 30 s, so at
   * most three attempts. Nothing else is retried. Apple suggests 15 minutes before resending after a 5xx; a "new
   * messages" push that late is replaced by the next message's anyway, so the wait here is short and bounded instead.
   */
  retryDelaysMs?: readonly number[];
  /** How long one attempt may take, in ms (default 10 s). */
  requestTimeoutMs?: number;
  /** The token's clock (tests move it). */
  now?: () => number;
  /** Pushes in flight at once (default 32), and how many may wait for a place (default 5 000); beyond, `overloaded`. */
  maxInFlight?: number;
  maxQueued?: number;
}

type Attempt = { status: number; reason: string | null } | { error: "network" | "timeout" };

const b64url = (data: string | Buffer): string => Buffer.from(data).toString("base64url");

/**
 * The APNs sender: token-based (an ES256 JWT signed with `node:crypto`), over `node:http2`, one connection per APNs host kept
 * for as long as it lasts. It reads nothing and writes nothing of the database and logs nothing: the caller
 * (src/push/notify.ts) deletes a `gone` device and counts the outcomes.
 */
export function createApnsClient(options: ApnsOptions): ApnsClient {
  const origins = options.origins ?? APNS_ORIGINS;
  const retryDelays = options.retryDelaysMs ?? [2_000, 30_000];
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  const now = options.now ?? Date.now;
  const maxInFlight = options.maxInFlight ?? 32;
  const maxQueued = options.maxQueued ?? 5_000;
  const key: KeyObject = createPrivateKey(options.keyPem);

  let closed = false;
  let current: { jwt: string; issuedAt: number } | null = null;
  const sessions = new Map<PushEnv, http2.ClientHttp2Session>();
  const waits = new Set<{ timer: NodeJS.Timeout; resolve: () => void }>();
  let inFlight = 0;
  const queue: Array<() => void> = [];
  /** Until when every push is paused (a configuration failure); 0: none. */
  let pausedUntil = 0;
  /** Tokens paused after `DeviceTokenNotForTopic`, until when (insertion order: the oldest first). */
  const pausedTokens = new Map<string, number>();

  /** Whether a push to `token` is paused now (a configuration failure, everyone's or that token's). */
  function paused(token: string): boolean {
    const at = now();
    if (at < pausedUntil) return true;
    const until = pausedTokens.get(token);
    if (until === undefined) return false;
    if (at < until) return true;
    pausedTokens.delete(token);
    return false;
  }

  /** Starts a pause of `CONFIGURATION_PAUSE_MS`: of every push, or of one token's. */
  function holdBack(scope: "all" | { token: string }): void {
    const until = now() + CONFIGURATION_PAUSE_MS;
    if (scope === "all") {
      pausedUntil = until;
      return;
    }
    pausedTokens.delete(scope.token);
    pausedTokens.set(scope.token, until);
    if (pausedTokens.size > MAX_PAUSED_TOKENS) pausedTokens.delete(pausedTokens.keys().next().value!);
  }

  /** The provider token: kept for `TOKEN_LIFETIME_MS`, or made anew now (`fresh`) when it is at least `TOKEN_MIN_AGE_MS` old. */
  function providerToken(fresh = false): string {
    const at = now();
    const age = current === null ? Infinity : at - current.issuedAt;
    if (current === null || age >= TOKEN_LIFETIME_MS || (fresh && age >= TOKEN_MIN_AGE_MS)) {
      const head = b64url(JSON.stringify({ alg: "ES256", kid: options.keyId }));
      const claims = b64url(JSON.stringify({ iss: options.teamId, iat: Math.floor(at / 1000) }));
      const signature = sign("sha256", Buffer.from(`${head}.${claims}`), { key, dsaEncoding: "ieee-p1363" });
      current = { jwt: `${head}.${claims}.${b64url(signature)}`, issuedAt: at };
    }
    return current.jwt;
  }

  function connection(env: PushEnv): http2.ClientHttp2Session {
    const open = sessions.get(env);
    if (open && !open.closed && !open.destroyed) return open;
    const session = http2.connect(origins[env]);
    const forget = () => {
      if (sessions.get(env) === session) sessions.delete(env);
    };
    // A failure reaches the streams on it; the session itself is only forgotten (nothing is logged here).
    session.on("error", forget);
    session.on("goaway", forget);
    session.on("close", forget);
    session.setTimeout(IDLE_CLOSE_MS, () => session.close());
    sessions.set(env, session);
    return session;
  }

  /** One attempt on `session` (the caller's: it decides what becomes of that connection afterwards). */
  function attempt(session: http2.ClientHttp2Session, n: ApnsNotification, jwt: string): Promise<Attempt> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (a: Attempt) => {
        if (settled) return;
        settled = true;
        resolve(a);
      };
      let stream: http2.ClientHttp2Stream;
      try {
        stream = session.request({
          ":method": "POST",
          ":path": `/3/device/${n.token}`,
          authorization: `bearer ${jwt}`,
          "apns-topic": options.topic,
          "apns-push-type": "alert",
          "apns-priority": "10",
          "apns-collapse-id": n.collapseId,
          "apns-expiration": String(Math.floor(now() / 1000) + EXPIRY_S),
          "content-type": "application/json",
        });
      } catch {
        return done({ error: "network" });
      }
      let status = 0;
      const chunks: Buffer[] = [];
      let size = 0;
      stream.setTimeout(requestTimeoutMs, () => {
        stream.close(http2.constants.NGHTTP2_CANCEL);
        done({ error: "timeout" });
      });
      stream.on("response", (headers) => {
        status = Number(headers[":status"] ?? 0);
      });
      stream.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size <= MAX_ANSWER_BYTES) chunks.push(chunk);
      });
      stream.on("end", () => {
        if (status === 0) return done({ error: "network" });
        let reason: string | null = null;
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString()) as { reason?: unknown };
          if (typeof parsed.reason === "string") reason = parsed.reason;
        } catch {
          // a 200 has no body; another without JSON is classed by its status alone
        }
        done({ status, reason });
      });
      stream.on("error", () => done({ error: "network" }));
      stream.on("close", () => done(status === 0 ? { error: "network" } : { status, reason: null }));
      stream.end(n.payload);
    });
  }

  /** Waits `ms` unless the client is closed meanwhile: false then. */
  function pause(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (closed) return resolve(false);
      const w = {
        timer: setTimeout(() => {
          waits.delete(w);
          resolve(!closed);
        }, ms),
        resolve: () => resolve(false),
      };
      w.timer.unref();
      waits.add(w);
    });
  }

  async function slot(): Promise<boolean> {
    if (inFlight < maxInFlight) {
      inFlight++;
      return true;
    }
    if (queue.length >= maxQueued) return false;
    await new Promise<void>((resolve) => queue.push(resolve));
    return true; // the place is handed over by `release`
  }

  function release(): void {
    const next = queue.shift();
    if (next) next();
    else inFlight--;
  }

  /** A configuration failure: every push (or, `token`, that token's) paused for `CONFIGURATION_PAUSE_MS`; nothing gone. */
  function refused(why: "auth" | "topic" | "token_rate", token?: string): ApnsOutcome {
    holdBack(token === undefined ? "all" : { token });
    return { outcome: "failed", why };
  }

  /**
   * One push, attempt after attempt, holding a place only while an attempt is under way: during a retry's wait the place
   * is given back (`waitOutside`), so one slow push never holds up the others.
   */
  async function deliver(n: ApnsNotification, waitOutside: (ms: number) => Promise<"ok" | "closed" | "overloaded">): Promise<ApnsOutcome> {
    let renewed = false;
    for (let tries = 0; ; tries++) {
      if (closed) return { outcome: "failed", why: "closed" };
      if (paused(n.token)) return { outcome: "failed", why: "paused" };
      let session: http2.ClientHttp2Session | null = null;
      const jwt = providerToken();
      let a: Attempt;
      try {
        session = connection(n.env);
        a = await attempt(session, n, jwt);
      } catch {
        a = { error: "network" };
      }
      let retry: ApnsFailure | null = null;
      if ("error" in a) {
        retry = a.error;
        // Only the connection this attempt used, never one another push opened meanwhile. A broken connection forgets
        // itself (its `error` / `close`); one stream reset leaves it up, for this push's retry and everyone else's. A silent
        // one takes no new pushes (what is on it may still finish) and the retry opens another.
        if (a.error === "timeout") session?.close();
      } else if (a.status === 200) {
        return { outcome: "sent" };
      } else if (a.status === 410 || (a.status === 400 && a.reason === "BadDeviceToken")) {
        return { outcome: "gone" };
      } else if (a.status === 400 && a.reason === "DeviceTokenNotForTopic") {
        // A token of another app (another bundle id): that token alone is paused, never deleted.
        return refused("topic", n.token);
      } else if (a.status === 400 && (a.reason === "TopicDisallowed" || a.reason === "BadTopic" || a.reason === "MissingTopic")) {
        return refused("topic");
      } else if (a.status === 403 && a.reason === "ExpiredProviderToken" && !renewed) {
        // Once: with the token another push has renewed since this attempt's, or with one made anew now if this one is old
        // enough; else the configuration's (a clock that is off).
        renewed = true;
        if (current?.jwt !== jwt || providerToken(true) !== jwt) {
          tries--;
          continue;
        }
        return refused("auth");
      } else if (a.status === 403) {
        return refused("auth");
      } else if (a.status === 429 && a.reason === "TooManyProviderTokenUpdates") {
        return refused("token_rate");
      } else if (a.status === 429) {
        retry = "throttled";
      } else if (a.status >= 500) {
        retry = "server";
        // 503 is a server going away (`Shutdown`, `ServiceUnavailable`): the retry takes a new connection.
        if (a.status === 503) session?.close();
      } else {
        return { outcome: "failed", why: "rejected" };
      }
      const wait = retryDelays[tries];
      if (wait === undefined) return { outcome: "failed", why: retry };
      const waited = await waitOutside(wait);
      if (waited !== "ok") return { outcome: "failed", why: waited };
    }
  }

  return {
    async send(n) {
      if (closed) return { outcome: "failed", why: "closed" };
      if (paused(n.token)) return { outcome: "failed", why: "paused" };
      if (!(await slot())) return { outcome: "failed", why: "overloaded" };
      let holding = true;
      const waitOutside = async (ms: number): Promise<"ok" | "closed" | "overloaded"> => {
        release();
        holding = false;
        if (!(await pause(ms))) return "closed";
        if (!(await slot())) return "overloaded";
        holding = true;
        return closed ? "closed" : "ok";
      };
      try {
        return await deliver(n, waitOutside);
      } finally {
        if (holding) release();
      }
    },
    async close() {
      closed = true;
      for (const w of waits) {
        clearTimeout(w.timer);
        w.resolve();
      }
      waits.clear();
      // Each push waiting for a place is handed one, finds the client closed, and gives it back.
      const waiting = queue.splice(0);
      inFlight += waiting.length;
      for (const resolve of waiting) resolve();
      await Promise.all(
        [...sessions.values()].map(
          (s) =>
            new Promise<void>((resolve) => {
              if (s.closed || s.destroyed) return resolve();
              s.close(() => resolve());
              // A stream that never ends must not hold the stop.
              setTimeout(() => {
                s.destroy();
                resolve();
              }, 2_000).unref();
            }),
        ),
      );
      sessions.clear();
    },
  };
}
