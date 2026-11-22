import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { CONFIGURATION_PAUSE_MS, createApnsClient, type ApnsClient, type ApnsOptions } from "../src/push/apns.ts";
import { fakeApns, type FakeApns } from "./helpers/apns.ts";

/**
 * The APNs sender (src/push/apns.ts) against a scripted local HTTP/2 server: no network, a key made for the test. It signs
 * an ES256 token with `node:crypto` and keeps it within the window APNs allows, keeps its connection, deletes nothing itself
 * (it says `gone`), and retries 429 / 5xx / a broken connection a bounded number of times — never in a loop.
 */

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const PUBLIC = createPublicKey(privateKey);
const TOKEN = "ab".repeat(32);
const CONV = "0b6c6d5e-0000-4000-8000-000000000001";
const PAYLOAD = JSON.stringify({ aps: { alert: { title: "Haiyo", body: "你有新消息" } }, c: CONV });
const note = (env: "sandbox" | "production" = "production") => ({ token: TOKEN, env, collapseId: CONV, payload: PAYLOAD });

let production: FakeApns;
let sandbox: FakeApns;
beforeAll(async () => {
  production = await fakeApns();
  sandbox = await fakeApns();
});
afterAll(async () => {
  await production.close();
  await sandbox.close();
});

const clients: ApnsClient[] = [];
let clock = Date.parse("2026-11-23T00:00:00Z");
function client(extra: Partial<ApnsOptions> = {}): ApnsClient {
  const c = createApnsClient({
    teamId: "ABCDE12345",
    keyId: "KEY1234567",
    keyPem: PEM,
    topic: "org.haiyo.app",
    origins: { production: production.url, sandbox: sandbox.url },
    retryDelaysMs: [5, 10],
    requestTimeoutMs: 2000,
    now: () => clock,
    ...extra,
  });
  clients.push(c);
  return c;
}
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  production.reset();
  sandbox.reset();
  clock = Date.parse("2026-11-23T00:00:00Z");
});

/** The token's parts, its signature checked against the test key's public half. */
function token(authorization: unknown): { header: Record<string, unknown>; claims: Record<string, unknown>; valid: boolean } {
  const jwt = String(authorization).replace(/^bearer /, "");
  const [h, c, s] = jwt.split(".");
  const valid = verify("sha256", Buffer.from(`${h}.${c}`), { key: PUBLIC, dsaEncoding: "ieee-p1363" }, Buffer.from(s!, "base64url"));
  return { header: JSON.parse(Buffer.from(h!, "base64url").toString()), claims: JSON.parse(Buffer.from(c!, "base64url").toString()), valid };
}

describe("one push", () => {
  test("is a POST of the payload to /3/device/<token>, with the topic, alert type, priority 10, the collapse id and a signed ES256 token", async () => {
    expect(await client().send(note())).toEqual({ outcome: "sent" });
    expect(production.requests).toHaveLength(1);
    const r = production.requests[0]!;
    expect(r.path).toBe(`/3/device/${TOKEN}`);
    expect(r.headers[":method"]).toBe("POST");
    expect(r.headers["apns-topic"]).toBe("org.haiyo.app");
    expect(r.headers["apns-push-type"]).toBe("alert");
    expect(r.headers["apns-priority"]).toBe("10");
    expect(r.headers["apns-collapse-id"]).toBe(CONV);
    expect(Number(r.headers["apns-expiration"])).toBe(Math.floor(clock / 1000) + 24 * 3600);
    expect(r.body).toBe(PAYLOAD);
    const t = token(r.headers.authorization);
    expect(t).toEqual({ header: { alg: "ES256", kid: "KEY1234567" }, claims: { iss: "ABCDE12345", iat: Math.floor(clock / 1000) }, valid: true });
  });

  test("a sandbox token goes to the sandbox server, a production one to production", async () => {
    const c = client();
    await c.send(note("sandbox"));
    expect([sandbox.requests.length, production.requests.length]).toEqual([1, 0]);
    await c.send(note("production"));
    expect([sandbox.requests.length, production.requests.length]).toEqual([1, 1]);
  });
});

describe("the token and the connection are kept", () => {
  test("one connection for many pushes, one token for 50 minutes, then a new one", async () => {
    const c = client();
    for (let i = 0; i < 12; i++) await c.send(note());
    clock += 49 * 60_000;
    await c.send(note());
    expect(production.connections()).toBe(1);
    expect(new Set(production.requests.map((r) => r.headers.authorization)).size).toBe(1);
    clock += 2 * 60_000;
    await c.send(note());
    const auths = production.requests.map((r) => String(r.headers.authorization));
    expect(new Set(auths).size).toBe(2);
    expect(token(auths.at(-1)).claims.iat).toBe(Math.floor(clock / 1000));
    expect(production.connections()).toBe(1);
  });

  test("pushes at once share the connection", async () => {
    const c = client();
    const outcomes = await Promise.all(Array.from({ length: 12 }, () => c.send(note())));
    expect(outcomes.every((o) => o.outcome === "sent")).toBe(true);
    expect(production.connections()).toBe(1);
  });

  test("a connection the server drops is opened again for the next push (and that push is retried on it)", async () => {
    const c = client();
    await c.send(note());
    production.answer("reset");
    expect(await c.send(note())).toEqual({ outcome: "sent" });
    expect(production.connections()).toBe(2);
    expect(production.requests).toHaveLength(3);
  });

  test("a push that times out leaves the other pushes on its connection alone (it takes no new ones, and its retry opens another)", async () => {
    let release!: (a: { status: number }) => void;
    production.answer("hang", { hold: new Promise<{ status: number }>((r) => (release = r)) });
    const c = client({ requestTimeoutMs: 300 });
    const silent = c.send(note());
    await production.waitFor(1);
    // The other starts later, so its own deadline is well after the silent one's.
    await new Promise((r) => setTimeout(r, 150));
    const other = c.send(note());
    await production.waitFor(2);
    // The silent one times out and is retried on a new connection (answered 200); the other is still waiting on the first.
    expect(await silent).toEqual({ outcome: "sent" });
    release({ status: 200 });
    expect(await other).toEqual({ outcome: "sent" });
    expect(production.requests.map((r) => r.connection)).toEqual([1, 1, 2]);
  });

  test("ExpiredProviderToken: a token at least 20 minutes old is made anew and the push sent once more", async () => {
    const c = client();
    await c.send(note());
    clock += 25 * 60_000;
    production.answer({ status: 403, reason: "ExpiredProviderToken" });
    expect(await c.send(note())).toEqual({ outcome: "sent" });
    const [first, refused, again] = production.requests.map((r) => String(r.headers.authorization));
    expect(refused).toBe(first);
    expect(again).not.toBe(first);
  });

  test("ExpiredProviderToken for a token another push has renewed meanwhile: retried with the new one, not failed", async () => {
    const c = client();
    await c.send(note());
    clock += 25 * 60_000;
    let first!: (a: { status: number; reason: string }) => void;
    let second!: (a: { status: number; reason: string }) => void;
    production.answer({ hold: new Promise((r) => (first = r)) }, { hold: new Promise((r) => (second = r)) });
    const b = c.send(note());
    const d = c.send({ ...note(), token: "cd".repeat(32) });
    await production.waitFor(3);
    first({ status: 403, reason: "ExpiredProviderToken" });
    expect(await b).toEqual({ outcome: "sent" });
    second({ status: 403, reason: "ExpiredProviderToken" });
    expect(await d).toEqual({ outcome: "sent" });
    const auths = production.requests.map((r) => String(r.headers.authorization));
    expect(new Set(auths).size).toBe(2);
    expect(auths.at(-1)).toBe(auths.at(-2));
  });

  test("one stream reset by the server (RST_STREAM) leaves the connection and its other pushes alone; that push is retried on it", async () => {
    let release!: (a: { status: number }) => void;
    production.answer("refuse", { hold: new Promise((r) => (release = r)) });
    const c = client();
    const refused = c.send(note());
    await production.waitFor(1);
    const other = c.send({ ...note(), token: "cd".repeat(32) });
    expect(await refused).toEqual({ outcome: "sent" });
    release({ status: 200 });
    expect(await other).toEqual({ outcome: "sent" });
    expect(production.requests.map((r) => r.connection)).toEqual([1, 1, 1]);
  });

  test("ExpiredProviderToken on a token under 20 minutes old: not made anew (APNs refuses more than one a 20 minutes), failed auth", async () => {
    const c = client();
    await c.send(note());
    clock += 5 * 60_000;
    production.answer({ status: 403, reason: "ExpiredProviderToken" });
    expect(await c.send(note())).toEqual({ outcome: "failed", why: "auth" });
    expect(production.requests).toHaveLength(2);
  });
});

describe("what APNs answers", () => {
  test("410 (Unregistered, ExpiredToken) and 400 BadDeviceToken: gone (the caller deletes the device), not retried", async () => {
    for (const answer of [{ status: 410, reason: "Unregistered" }, { status: 410, reason: "ExpiredToken" }, { status: 400, reason: "BadDeviceToken" }]) {
      production.reset();
      production.answer(answer);
      expect([answer, await client().send(note())]).toEqual([answer, { outcome: "gone" }]);
      expect(production.requests).toHaveLength(1);
    }
  });

  test("DeviceTokenNotForTopic is no dead token: failed topic, never gone; that token is paused for the cool-down, others are not", async () => {
    const c = client();
    production.answer({ status: 400, reason: "DeviceTokenNotForTopic" });
    expect(await c.send(note())).toEqual({ outcome: "failed", why: "topic" });
    expect(await c.send(note())).toEqual({ outcome: "failed", why: "paused" });
    expect(production.requests).toHaveLength(1);
    expect(await c.send({ ...note(), token: "cd".repeat(32) })).toEqual({ outcome: "sent" });
    clock += CONFIGURATION_PAUSE_MS;
    expect(await c.send(note())).toEqual({ outcome: "sent" });
    expect(production.requests).toHaveLength(3);
  });

  /**
   * Every reason Apple documents (handling-notification-responses-from-apns, read 2026-11-23), answered once on the
   * **sandbox** host — the host a signed-in person can pick for their own token with `env` —, and what that may pause:
   * - `device`: gone (the caller deletes that phone); nothing paused.
   * - `token`: that token paused; another token on the same host still sent.
   * - `host`: that host paused; production, which the person did not pick, still sent.
   * - `none`: given up (`rejected`) or retried, and nothing paused.
   * The rule (src/push/apns.ts, top): a pause is never wider than what the failing request proves, so nothing a person
   * chooses (the token, the `env`) can pause a push that would have got through.
   */
  const REFUSALS: ReadonlyArray<[number, string, string, "device" | "token" | "host" | "none"]> = [
    [400, "BadCollapseId", "rejected", "none"],
    [400, "BadDeviceToken", "gone", "device"],
    [400, "BadExpirationDate", "rejected", "none"],
    [400, "BadMessageId", "rejected", "none"],
    [400, "BadPriority", "rejected", "none"],
    [400, "BadTopic", "topic", "host"],
    [400, "DeviceTokenNotForTopic", "topic", "token"],
    [400, "DuplicateHeaders", "rejected", "none"],
    [400, "IdleTimeout", "sent", "none"],
    [400, "InvalidPushType", "rejected", "none"],
    [400, "MissingDeviceToken", "rejected", "none"],
    [400, "MissingTopic", "topic", "host"],
    [400, "PayloadEmpty", "rejected", "none"],
    [400, "TopicDisallowed", "topic", "host"],
    [403, "BadCertificate", "auth", "host"],
    [403, "BadCertificateEnvironment", "key_env", "host"],
    [403, "ExpiredProviderToken", "auth", "host"],
    [403, "Forbidden", "auth", "host"],
    [403, "InvalidProviderToken", "auth", "host"],
    [403, "MissingProviderToken", "auth", "host"],
    [403, "UnrelatedKeyIdInToken", "sent", "none"],
    [403, "BadEnvironmentKeyIdInToken", "key_env", "host"],
    [403, "BadEnvironmentKeyInToken", "key_env", "host"],
    [404, "BadPath", "rejected", "none"],
    [405, "MethodNotAllowed", "rejected", "none"],
    [410, "ExpiredToken", "gone", "device"],
    [410, "Unregistered", "gone", "device"],
    [413, "PayloadTooLarge", "rejected", "none"],
    [429, "TooManyProviderTokenUpdates", "token_rate", "host"],
    [429, "TooManyRequests", "sent", "none"],
    [500, "InternalServerError", "sent", "none"],
    [503, "ServiceUnavailable", "sent", "none"],
    [503, "Shutdown", "sent", "none"],
  ];

  test("every refusal Apple documents: its outcome, and a pause never wider than what it proves (a sandbox refusal never pauses production)", async () => {
    const other = "cd".repeat(32);
    for (const [status, reason, outcome, scope] of REFUSALS) {
      production.reset();
      sandbox.reset();
      clock = Date.parse("2026-11-23T00:00:00Z");
      const c = client();
      // (ExpiredProviderToken: the client's token is brand new, so not renewable — the configuration's, a clock that is off.)
      sandbox.answer({ status, reason });
      const first = await c.send(note("sandbox"));
      const row = `${status} ${reason}`;
      expect([row, first]).toEqual([row, outcome === "sent" || outcome === "gone" ? { outcome } : { outcome: "failed", why: outcome }]);
      // The same token on the same host, another token on the same host, another token on the other host.
      const again = await c.send(note("sandbox"));
      const sameHost = await c.send({ ...note("sandbox"), token: other });
      const otherHost = await c.send({ ...note("production"), token: other });
      expect([row, "same token", again.outcome === "failed" && again.why === "paused"]).toEqual([row, "same token", scope === "token" || scope === "host"]);
      expect([row, "same host", sameHost.outcome === "failed" && sameHost.why === "paused"]).toEqual([row, "same host", scope === "host"]);
      expect([row, "other host", otherHost]).toEqual([row, "other host", { outcome: "sent" }]);
      await c.close();
    }
  });

  test("a host's pause ends after the cool-down", async () => {
    const c = client();
    sandbox.answer({ status: 403, reason: "BadEnvironmentKeyIdInToken" });
    expect(await c.send(note("sandbox"))).toEqual({ outcome: "failed", why: "key_env" });
    clock += CONFIGURATION_PAUSE_MS - 1;
    expect(await c.send(note("sandbox"))).toEqual({ outcome: "failed", why: "paused" });
    clock += 1;
    expect(await c.send(note("sandbox"))).toEqual({ outcome: "sent" });
  });

  test("429 TooManyRequests: retried after a wait, and sent", async () => {
    production.answer({ status: 429, reason: "TooManyRequests" });
    expect(await client().send(note())).toEqual({ outcome: "sent" });
    expect(production.requests).toHaveLength(2);
  });

  test("5xx every time: two retries, then failed server — and nothing more is sent afterwards", async () => {
    production.answer({ status: 500, reason: "InternalServerError" }, { status: 503, reason: "ServiceUnavailable" }, { status: 503, reason: "Shutdown" }, { status: 500 }, { status: 500 });
    expect(await client().send(note())).toEqual({ outcome: "failed", why: "server" });
    expect(production.requests).toHaveLength(3);
    await new Promise((r) => setTimeout(r, 100));
    expect(production.requests).toHaveLength(3);
  });

  test("429 every time: two retries, then failed throttled", async () => {
    production.answer(...Array.from({ length: 5 }, () => ({ status: 429, reason: "TooManyRequests" })));
    expect(await client().send(note())).toEqual({ outcome: "failed", why: "throttled" });
    expect(production.requests).toHaveLength(3);
  });

  test("a broken connection every time: two retries, then failed network", async () => {
    production.answer("reset", "reset", "reset", "reset");
    expect(await client().send(note())).toEqual({ outcome: "failed", why: "network" });
    expect(production.requests).toHaveLength(3);
  });

  test("no answer within the time: retried, then failed timeout", async () => {
    production.answer("hang", "hang", "hang");
    expect(await client({ requestTimeoutMs: 50 }).send(note())).toEqual({ outcome: "failed", why: "timeout" });
    expect(production.requests).toHaveLength(3);
  });

  test("any other 4xx: failed rejected at once, not retried, nothing paused", async () => {
    for (const answer of [{ status: 400, reason: "BadCollapseId" }, { status: 413, reason: "PayloadTooLarge" }, { status: 400, reason: "BadPriority" }]) {
      production.reset();
      const c = client();
      production.answer(answer);
      expect([answer, await c.send(note())]).toEqual([answer, { outcome: "failed", why: "rejected" }]);
      expect(await c.send(note())).toEqual({ outcome: "sent" });
      expect(production.requests).toHaveLength(2);
    }
  });
});

describe("bounds", () => {
  test("beyond the pushes in flight and the queue, a push is refused at once (overloaded)", async () => {
    let release!: (a: { status: number }) => void;
    const held = new Promise<{ status: number }>((r) => (release = r));
    production.answer({ hold: held });
    const c = client({ maxInFlight: 1, maxQueued: 1 });
    const first = c.send(note());
    await production.waitFor(1);
    const second = c.send(note());
    expect(await c.send(note())).toEqual({ outcome: "failed", why: "overloaded" });
    release({ status: 200 });
    expect(await first).toEqual({ outcome: "sent" });
    expect(await second).toEqual({ outcome: "sent" });
  });

  test("a push waiting for its retry holds no place: another goes through meanwhile", async () => {
    const c = client({ maxInFlight: 1, maxQueued: 0, retryDelaysMs: [60_000] });
    production.answer({ status: 503, reason: "ServiceUnavailable" });
    const waiting = c.send(note());
    await production.waitFor(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(await c.send({ ...note(), token: "cd".repeat(32) })).toEqual({ outcome: "sent" });
    await c.close();
    expect(await waiting).toEqual({ outcome: "failed", why: "closed" });
  });

  test("closed: a connection already closing gracefully (a 503 on it) with a stream that never ends is destroyed too, within the grace", async () => {
    const c = client({ requestTimeoutMs: 60_000 });
    production.answer("hang", { status: 503, reason: "ServiceUnavailable" });
    const hung = c.send(note());
    await production.waitFor(1);
    // The 503 closes the first connection gracefully; the retry goes on a second, answered 200.
    expect(await c.send({ ...note(), token: "cd".repeat(32) })).toEqual({ outcome: "sent" });
    expect(production.openConnections()).toBe(2);
    const t0 = Date.now();
    await c.close();
    expect(Date.now() - t0).toBeLessThan(3_000);
    for (let i = 0; i < 100 && production.openConnections() > 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(production.openConnections()).toBe(0);
    expect(await hung).toEqual({ outcome: "failed", why: "closed" });
  });

  test("closed: a push waiting for its retry ends at once, and a new one is refused", async () => {
    const c = client({ retryDelaysMs: [60_000] });
    production.answer({ status: 503, reason: "ServiceUnavailable" });
    const waiting = c.send(note());
    await production.waitFor(1);
    await c.close();
    expect(await waiting).toEqual({ outcome: "failed", why: "closed" });
    expect(await c.send(note())).toEqual({ outcome: "failed", why: "closed" });
  });
});
