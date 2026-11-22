import type { FastifyRequest } from "fastify";
import { once } from "node:events";
import net from "node:net";
import { describe, expect, test, vi } from "vitest";
import { ANSWER_FLOOR, holdUntilFloor, startAnswerClock } from "../src/auth/answer-floor.ts";
import { createInvite } from "../src/auth/invites.ts";
import { api, signUp, TERMS } from "./helpers/actors.ts";
import { useApp } from "./helpers/harness.ts";
import { listen } from "./helpers/ws.ts";

// Long enough to cover a registration's password hashing on a loaded machine, short enough to keep the file quick.
const FLOOR = { ms: 300, jitterMs: 10 };
/**
 * What a measured answer may fall short of the floor by: timers fire on whole milliseconds and the clocks of the server's
 * timer and of the measurement differ by a little. The floor itself is unchanged; this only keeps the test from flaking.
 */
const TIMER_SLACK_MS = 2;

const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)]!;

/** Runs the timings `a` and `b` alternately (which goes first alternates too), so drift in machine load hits both alike. */
async function interleaved(rounds: number, a: () => Promise<number>, b: () => Promise<number>) {
  const as: number[] = [];
  const bs: number[] = [];
  for (let i = 0; i < rounds; i++) {
    if (i % 2 === 0) {
      as.push(await a());
      bs.push(await b());
    } else {
      bs.push(await b());
      as.push(await a());
    }
  }
  return { as, bs };
}

describe("holdUntilFloor", () => {
  test("is 400 ms plus up to 50 ms outside tests", () => {
    expect(ANSWER_FLOOR).toEqual({ ms: 400, jitterMs: 50 });
  });

  test("waits out what is left of the floor, and does not pad work that already took longer", async () => {
    const fresh = {} as FastifyRequest;
    await startAnswerClock(fresh);
    const t0 = performance.now();
    await holdUntilFloor(fresh, { ms: 80, jitterMs: 0 });
    expect(performance.now() - t0).toBeGreaterThanOrEqual(75);

    const slow = {} as FastifyRequest;
    await startAnswerClock(slow);
    await new Promise((resolve) => setTimeout(resolve, 60));
    // More than the floor has passed whatever the load (it can only add to the 60 ms): the answer is held for nothing, which
    // is that no timer is set at all, not that something returned within some number of milliseconds.
    const timers = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => (fn(), 0)) as unknown as typeof setTimeout);
    try {
      await holdUntilFloor(slow, { ms: 50, jitterMs: 0 });
      expect(timers).not.toHaveBeenCalled();
      // … and the same call on a fresh clock does set one (the spy sees the pad it is there to count).
      const again = {} as FastifyRequest;
      await startAnswerClock(again);
      await holdUntilFloor(again, { ms: 1_000_000, jitterMs: 0 });
      expect(timers).toHaveBeenCalledTimes(1);
    } finally {
      timers.mockRestore();
    }
  });
});

describe("answer floor", () => {
  const { app, db } = useApp({ answerFloor: FLOOR });

  async function timed(path: string, body: object, status: number): Promise<number> {
    const t0 = performance.now();
    const res = await api(app, null, "POST", path, body);
    const dt = performance.now() - t0;
    expect([path, res.status]).toEqual([path, status]);
    return dt;
  }

  test("a reset request answers no sooner than the floor, and as fast for a registered as for an unregistered address", async () => {
    const a = await signUp(app, "floor_known");
    const reset = (email: string) => () => timed("/api/auth/request-password-reset", { email }, 200);
    let n = 0;
    const unknown = () => reset(`ghost${n++}@example.test`)();
    await reset(a.email)(); // warm up both paths
    await unknown();
    const { as: known, bs: absent } = await interleaved(9, reset(a.email), unknown);
    expect(Math.min(...known, ...absent)).toBeGreaterThanOrEqual(FLOOR.ms - TIMER_SLACK_MS);
    expect(Math.abs(median(known) - median(absent))).toBeLessThan(40);
    // Only the registered address got mail.
    const { rows } = await db.query<{ recipient: string }>("select distinct recipient from mail_outbox where kind = 'reset_password'");
    expect(rows).toEqual([{ recipient: a.email }]);
  });

  test("a registration answers no sooner than the floor, and as fast for an e-mail that has an account as for a new one", async () => {
    const owner = await signUp(app, "floor_owner");
    let n = 0;
    const register = (email: string) => async () => {
      const i = n++;
      const inviteCode = await createInvite(db, { ttlHours: 1 });
      const t0 = performance.now();
      const res = await api(app, null, "POST", "/api/register", { inviteCode, email, password: "a good long password", displayName: "Floor", handle: `floor_${i}`, ...TERMS });
      const dt = performance.now() - t0;
      expect(res).toEqual({ status: 201, json: { ok: true } });
      return dt;
    };
    const fresh = () => register(`fresh${n}@example.test`)();
    await register(owner.email)(); // warm up both paths
    await fresh();
    const { as: taken, bs: free } = await interleaved(7, register(owner.email), fresh);
    expect(Math.min(...taken, ...free)).toBeGreaterThanOrEqual(FLOOR.ms - TIMER_SLACK_MS);
    expect(Math.abs(median(taken) - median(free))).toBeLessThan(40);
  });

  /**
   * Sends a request's head, waits `lateMs` (longer than the floor), then its body. Resolves with the answer's status
   * and the time from the body being sent to the answer's first byte: a floor counted from the head would be used up.
   */
  async function lateBody(path: string, body: object, lateMs = FLOOR.ms + 150): Promise<{ status: number; ms: number }> {
    const { port } = await listen(app);
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.on("error", () => {});
    try {
      await once(socket, "connect");
      const json = JSON.stringify(body);
      socket.write(
        [`POST ${path} HTTP/1.1`, `Host: 127.0.0.1:${port}`, "Content-Type: application/json", `Content-Length: ${Buffer.byteLength(json)}`, "Connection: close", "", ""].join("\r\n"),
      );
      await new Promise((resolve) => setTimeout(resolve, lateMs));
      const answered = once(socket, "data");
      const sentAt = performance.now();
      socket.write(json);
      const [first] = (await answered) as [Buffer];
      return { status: Number(/^HTTP\/1\.1 (\d{3})/.exec(first.toString("latin1"))![1]), ms: performance.now() - sentAt };
    } finally {
      socket.destroy();
    }
  }

  test("a body sent late still gets the whole floor: registered and unregistered addresses stay alike", async () => {
    const a = await signUp(app, "late_known");
    let n = 0;
    const reset = (email: string) => async () => {
      const { status, ms } = await lateBody("/api/auth/request-password-reset", { email });
      expect(status).toBe(200);
      return ms;
    };
    const unknown = () => reset(`late_ghost${n++}@example.test`)();
    await reset(a.email)(); // warm up both paths
    await unknown();
    const { as: known, bs: absent } = await interleaved(7, reset(a.email), unknown);
    expect(Math.min(...known, ...absent)).toBeGreaterThanOrEqual(FLOOR.ms - TIMER_SLACK_MS);
    expect(Math.abs(median(known) - median(absent))).toBeLessThan(40);
  });

  test("a registration whose body is sent late still gets the whole floor, account or not", async () => {
    const owner = await signUp(app, "late_owner");
    let n = 0;
    const register = (email: string) => async () => {
      const inviteCode = await createInvite(db, { ttlHours: 1 });
      const body = { inviteCode, email, password: "a good long password", displayName: "Late", handle: `late_${n++}`, ...TERMS };
      const { status, ms } = await lateBody("/api/register", body);
      expect(status).toBe(201);
      return ms;
    };
    const fresh = () => register(`late_fresh${n}@example.test`)();
    await register(owner.email)();
    await fresh();
    const { as: taken, bs: free } = await interleaved(5, register(owner.email), fresh);
    expect(Math.min(...taken, ...free)).toBeGreaterThanOrEqual(FLOOR.ms - TIMER_SLACK_MS);
    expect(Math.abs(median(taken) - median(free))).toBeLessThan(40);
  });
});
