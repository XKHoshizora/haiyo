import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { createApnsClient, type ApnsClient, type ApnsOptions } from "../src/push/apns.ts";
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
  test("410, BadDeviceToken and DeviceTokenNotForTopic: gone (the caller deletes the device), not retried", async () => {
    for (const answer of [{ status: 410, reason: "Unregistered" }, { status: 410, reason: "ExpiredToken" }, { status: 400, reason: "BadDeviceToken" }, { status: 400, reason: "DeviceTokenNotForTopic" }]) {
      production.reset();
      production.answer(answer);
      expect([answer, await client().send(note())]).toEqual([answer, { outcome: "gone" }]);
      expect(production.requests).toHaveLength(1);
    }
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

  test("InvalidProviderToken and TooManyProviderTokenUpdates: failed auth at once; other 4xx: failed rejected at once", async () => {
    for (const [answer, why] of [
      [{ status: 403, reason: "InvalidProviderToken" }, "auth"],
      [{ status: 429, reason: "TooManyProviderTokenUpdates" }, "auth"],
      [{ status: 400, reason: "BadCollapseId" }, "rejected"],
      [{ status: 413, reason: "PayloadTooLarge" }, "rejected"],
      [{ status: 400, reason: "TopicDisallowed" }, "rejected"],
    ] as const) {
      production.reset();
      production.answer(answer);
      expect([answer, await client().send(note())]).toEqual([answer, { outcome: "failed", why }]);
      expect(production.requests).toHaveLength(1);
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
