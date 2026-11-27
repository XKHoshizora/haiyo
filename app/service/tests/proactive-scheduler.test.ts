import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProactiveScheduler, type ProactiveScheduler } from "../src/agents/proactive/scheduler.ts";
import { noneTriggered, type Triggered } from "../src/agents/runs.ts";
import { buildApp } from "../src/app.ts";
import { lockConversation } from "../src/conversations/store.ts";
import type { Db } from "../src/db.ts";
import { insertMessage } from "../src/messages/model.ts";
import { api, befriend, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { NO_ANSWER_FLOOR, useApp } from "./helpers/harness.ts";
import { byName, scriptedJudge } from "./helpers/judge.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { closeAllSockets, connect } from "./helpers/ws.ts";

/**
 * When a group's judgement is asked (batch 2D, Task 5; design rules 3–5, 13–14): after a person's message in a group
 * that names no Agent, the scheduler waits for people to stop (the debounce), then decides once — about the latest —
 * and acts on it as on a mention's outcome. First the scheduler alone, with a fake decision and fake timers; then through
 * the real app with the scripted judgement model: what the send route and an Agent's post tell it, what comes of a
 * decision (with the reply worker running), and that nothing of it exists without a judgement model.
 */

// --- the scheduler alone ---------------------------------------------------------------------------------------------

/** A promise settled from outside. */
interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(err: unknown): void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

interface Fake {
  scheduler: ProactiveScheduler;
  /** Every decision asked for, in order. */
  decided: Array<[string, number]>;
  /** What each decision returned, in order (the very objects `act` must get). */
  returned: Triggered[];
  acted: Array<[string, Triggered]>;
  /** What was logged at error: the fields and the message. */
  errors: Array<{ fields: Record<string, unknown>; msg: string }>;
  /** The fields of what was logged at info. */
  infos: Array<Record<string, unknown>>;
  /** The decisions held (with `hold`), in the order they began: settle them by hand. */
  held: Array<Deferred<Triggered>>;
  /** The most decisions in flight at once for one conversation. */
  mostAtOnce: number;
  /** The most decisions in flight at once, all conversations together. */
  mostOverall: number;
}

const DELAY = 20;
/** The hourly caps on judgements about one group and about one sender's messages, as configured by default. */
const PER_GROUP_HOUR = 600;
const PER_SENDER_HOUR = 300;
const HOUR = 3_600_000;

/**
 * A scheduler over a recording `decide` and `act`. `hold`: each decision waits until the test settles it; `decide`
 * replaces the decision's outcome (thrown or returned) after it is recorded; `act` likewise. `asks`: whether a decision
 * asks the judgement model (it then says so at once, as a decision does as it calls the judge; default: every one does).
 * `maxAtOnce`: the scheduler's limit on decisions in flight (default its own); `perGroupHour`, `perSenderHour` its
 * hourly caps (default the configuration's).
 */
function fake(
  opts: {
    hold?: boolean;
    decide?: (call: number) => Triggered | Promise<Triggered>;
    act?: (call: number) => void | Promise<void>;
    asks?: (call: number) => boolean;
    maxAtOnce?: number;
    perGroupHour?: number;
    perSenderHour?: number;
    /** The logger throws after recording. */
    logThrows?: boolean;
  } = {},
): Fake {
  const f = { decided: [], returned: [], acted: [], errors: [], infos: [], held: [], mostAtOnce: 0, mostOverall: 0 } as unknown as Fake;
  const inFlight = new Map<string, number>();
  let overall = 0;
  const log = {
    error: (fields: Record<string, unknown>, msg: string) => {
      f.errors.push({ fields, msg });
      if (opts.logThrows) throw new Error("the logger broke");
    },
    info: (fields: Record<string, unknown>) => void f.infos.push(fields),
  } as unknown as Pick<FastifyBaseLogger, "error" | "info">;
  f.scheduler = createProactiveScheduler({
    delayMs: DELAY,
    perGroupHour: opts.perGroupHour ?? PER_GROUP_HOUR,
    perSenderHour: opts.perSenderHour ?? PER_SENDER_HOUR,
    log,
    ...(opts.maxAtOnce === undefined ? {} : { maxAtOnce: opts.maxAtOnce }),
    decide: (conversationId, seq, asked) => {
      f.decided.push([conversationId, seq]);
      const call = f.decided.length;
      if (opts.asks?.(call) ?? true) asked();
      inFlight.set(conversationId, (inFlight.get(conversationId) ?? 0) + 1);
      f.mostAtOnce = Math.max(f.mostAtOnce, inFlight.get(conversationId)!);
      f.mostOverall = Math.max(f.mostOverall, ++overall);
      const done = () => (inFlight.set(conversationId, inFlight.get(conversationId)! - 1), overall--);
      const outcome = (): Promise<Triggered> => {
        if (opts.hold) {
          const d = deferred<Triggered>();
          f.held.push(d);
          return d.promise;
        }
        if (opts.decide) return Promise.resolve(opts.decide(call));
        return Promise.resolve(noneTriggered());
      };
      let pending: Promise<Triggered>;
      try {
        pending = outcome();
      } catch (err) {
        done();
        throw err; // a decision that throws at once
      }
      return pending.then(
        (t) => (done(), f.returned.push(t), t),
        (err: unknown) => {
          done();
          throw err;
        },
      );
    },
    act: (conversationId, triggered) => {
      f.acted.push([conversationId, triggered]);
      return opts.act?.(f.acted.length);
    },
  });
  return f;
}

/** Lets every promise chain already under way run on (microtasks only; the fake clock does not move). */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** Whether `promise` settles within `ms` (real timers). */
const settlesWithin = (promise: Promise<unknown>, ms: number) => Promise.race([promise.then(() => true), sleep(ms).then(() => false)]);

/** Whether `promise` settles before the fake clock moves. */
async function settlesNow(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(() => (settled = true));
  await flush();
  return settled;
}

describe("the scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("several messages in quick succession: one decision, about the latest, `delayMs` after it; its outcome is acted on", async () => {
    const f = fake();
    f.scheduler.noted("g", 3, "p", false);
    f.scheduler.noted("g", 4, "p", false);
    f.scheduler.noted("g", 5, "p", false);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(DELAY - 1);
    expect(f.decided).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await f.scheduler.idle();
    expect(f.decided).toEqual([["g", 5]]);
    expect(f.acted).toHaveLength(1);
    expect(f.acted[0]![0]).toBe("g");
    expect(f.acted[0]![1]).toBe(f.returned[0]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("each message starts the wait again: people are waited for until they stop", async () => {
    const f = fake();
    f.scheduler.noted("g", 1, "p", false);
    await vi.advanceTimersByTimeAsync(DELAY - 1);
    f.scheduler.noted("g", 2, "p", false);
    await vi.advanceTimersByTimeAsync(DELAY - 1);
    f.scheduler.noted("g", 3, "p", false);
    await vi.advanceTimersByTimeAsync(DELAY - 1);
    expect(f.decided).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await f.scheduler.idle();
    expect(f.decided).toEqual([["g", 3]]);
  });

  it("a message naming an Agent cancels what was waiting and starts nothing", async () => {
    const f = fake();
    f.scheduler.noted("g", 1, "p", false);
    f.scheduler.noted("g", 2, "p", true);
    expect(vi.getTimerCount()).toBe(0);
    expect(await settlesNow(f.scheduler.idle())).toBe(true);
    // Naming an Agent with nothing waiting: nothing either.
    f.scheduler.noted("g", 3, "p", true);
    await vi.advanceTimersByTimeAsync(DELAY * 5);
    expect(f.decided).toEqual([]);
    expect(f.acted).toEqual([]);
  });

  it("`cancelled` (an Agent posted) drops what was waiting; for a group with nothing waiting it does nothing", async () => {
    const f = fake();
    f.scheduler.cancelled("nowhere");
    f.scheduler.noted("g", 1, "p", false);
    f.scheduler.cancelled("g");
    expect(vi.getTimerCount()).toBe(0);
    expect(await settlesNow(f.scheduler.idle())).toBe(true);
    await vi.advanceTimersByTimeAsync(DELAY * 5);
    expect(f.decided).toEqual([]);
  });

  it("a message while a decision is in flight starts no second one; once it settles, a fresh wait, then one decision about the newest", async () => {
    const f = fake({ hold: true });
    f.scheduler.noted("g", 1, "p", false);
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(f.decided).toEqual([["g", 1]]);
    f.scheduler.noted("g", 2, "p", false);
    f.scheduler.noted("g", 3, "p", false);
    expect(vi.getTimerCount()).toBe(0); // nothing waits while it is in flight
    await vi.advanceTimersByTimeAsync(DELAY * 5);
    expect(f.decided).toEqual([["g", 1]]);
    expect(await settlesNow(f.scheduler.idle())).toBe(false);

    const first = noneTriggered();
    f.held[0]!.resolve(first);
    await flush();
    expect(f.acted).toEqual([["g", first]]);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(DELAY - 1);
    expect(f.decided).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.decided).toEqual([
      ["g", 1],
      ["g", 3],
    ]);
    const second = noneTriggered();
    f.held[1]!.resolve(second);
    await f.scheduler.idle();
    expect(f.acted).toEqual([
      ["g", first],
      ["g", second],
    ]);
    expect(f.mostAtOnce).toBe(1);
  });

  it("while a decision is in flight, a message naming an Agent or an Agent's post leaves nothing to follow it; what it decided is still acted on", async () => {
    for (const drop of [(s: ProactiveScheduler) => s.noted("g", 3, "p", true), (s: ProactiveScheduler) => s.cancelled("g")]) {
      const f = fake({ hold: true });
      f.scheduler.noted("g", 1, "p", false);
      await vi.advanceTimersByTimeAsync(DELAY);
      f.scheduler.noted("g", 2, "p", false);
      drop(f.scheduler);
      const outcome = noneTriggered();
      f.held[0]!.resolve(outcome);
      await f.scheduler.idle();
      await vi.advanceTimersByTimeAsync(DELAY * 5);
      expect(f.decided).toEqual([["g", 1]]);
      expect(f.acted).toEqual([["g", outcome]]);
    }
  });

  it("a note about an older message than the one waiting or in flight changes nothing (after-commit steps may run out of order)", async () => {
    const f = fake();
    f.scheduler.noted("g", 5, "p", false);
    f.scheduler.noted("g", 4, "p", false);
    f.scheduler.noted("g", 4, "p", true);
    await vi.advanceTimersByTimeAsync(DELAY);
    await f.scheduler.idle();
    expect(f.decided).toEqual([["g", 5]]);
  });

  it("a decision that throws or rejects is logged with the conversation's id only; later messages are still decided", async () => {
    const thrown = new Error("thrown at once");
    const rejected = new Error("rejected");
    const f = fake({
      decide: (call) => {
        if (call === 1) throw thrown;
        if (call === 2) return Promise.reject(rejected);
        return noneTriggered();
      },
    });
    for (const seq of [1, 2, 3]) {
      expect(() => f.scheduler.noted("g", seq, "p", false)).not.toThrow();
      await vi.advanceTimersByTimeAsync(DELAY);
      await f.scheduler.idle();
    }
    expect(f.decided).toEqual([
      ["g", 1],
      ["g", 2],
      ["g", 3],
    ]);
    expect(f.errors.map((e) => e.fields)).toEqual([
      { err: thrown, conversationId: "g" },
      { err: rejected, conversationId: "g" },
    ]);
    expect(f.acted).toHaveLength(1);
  });

  it("acting that throws or rejects is logged; later messages are still decided and acted on", async () => {
    const thrown = new Error("publish failed");
    const rejected = new Error("announce failed");
    const f = fake({
      act: (call) => {
        if (call === 1) throw thrown;
        if (call === 2) return Promise.reject(rejected);
      },
    });
    for (const seq of [1, 2, 3]) {
      f.scheduler.noted("g", seq, "p", false);
      await vi.advanceTimersByTimeAsync(DELAY);
      await f.scheduler.idle();
    }
    expect(f.acted).toHaveLength(3);
    expect(f.errors.map((e) => e.fields)).toEqual([
      { err: thrown, conversationId: "g" },
      { err: rejected, conversationId: "g" },
    ]);
  });

  it("close(): no timer is left, later notes do nothing, and what a decision in flight decides is dropped", async () => {
    // A wait under way.
    const waiting = fake();
    waiting.scheduler.noted("g", 1, "p", false);
    waiting.scheduler.noted("h", 1, "p", false);
    waiting.scheduler.close();
    expect(vi.getTimerCount()).toBe(0);
    expect(await settlesNow(waiting.scheduler.idle())).toBe(true);
    waiting.scheduler.noted("g", 2, "p", false);
    waiting.scheduler.cancelled("g");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(DELAY * 5);
    expect(waiting.decided).toEqual([]);

    // A decision in flight: it finishes, nothing is acted on, nothing follows it.
    const flying = fake({ hold: true });
    flying.scheduler.noted("g", 1, "p", false);
    await vi.advanceTimersByTimeAsync(DELAY);
    flying.scheduler.noted("g", 2, "p", false);
    flying.scheduler.close();
    const idle = flying.scheduler.idle();
    expect(await settlesNow(idle)).toBe(false);
    flying.held[0]!.resolve(noneTriggered());
    await idle;
    await vi.advanceTimersByTimeAsync(DELAY * 5);
    expect(flying.decided).toEqual([["g", 1]]);
    expect(flying.acted).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("conversations are independent: each has its own wait and its own decision, at the same time", async () => {
    const f = fake({ hold: true });
    f.scheduler.noted("a", 1, "p", false);
    f.scheduler.noted("b", 7, "p", false);
    f.scheduler.noted("c", 4, "p", false);
    f.scheduler.cancelled("c");
    f.scheduler.noted("b", 8, "p", true); // naming an Agent in b cancels b only
    f.scheduler.noted("b", 9, "p", false);
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(f.decided).toEqual([
      ["a", 1],
      ["b", 9],
    ]);
    // a is in flight; a message in b is decided meanwhile.
    f.held[1]!.resolve(noneTriggered());
    await flush();
    f.scheduler.noted("b", 10, "p", false);
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(f.decided).toEqual([
      ["a", 1],
      ["b", 9],
      ["b", 10],
    ]);
    f.held[0]!.resolve(noneTriggered());
    f.held[2]!.resolve(noneTriggered());
    await f.scheduler.idle();
    expect(f.acted.map(([c]) => c)).toEqual(["b", "a", "b"]);
  });

  it("at most `maxAtOnce` decisions at once, all groups together: a group whose wait is over waits its turn, oldest first", async () => {
    const f = fake({ hold: true, maxAtOnce: 2 });
    f.scheduler.noted("a", 1, "p", false);
    f.scheduler.noted("b", 1, "p", false);
    f.scheduler.noted("c", 1, "p", false);
    f.scheduler.noted("d", 1, "p", false);
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(f.decided).toEqual([
      ["a", 1],
      ["b", 1],
    ]);
    expect(vi.getTimerCount()).toBe(0); // c and d wait for a place, not on a timer
    await vi.advanceTimersByTimeAsync(DELAY * 5);
    expect(f.decided).toHaveLength(2);
    f.held[1]!.resolve(noneTriggered());
    await flush();
    expect(f.decided.map(([c]) => c)).toEqual(["a", "b", "c"]);
    f.held[0]!.resolve(noneTriggered());
    await flush();
    expect(f.decided.map(([c]) => c)).toEqual(["a", "b", "c", "d"]);
    f.held[2]!.resolve(noneTriggered());
    f.held[3]!.resolve(noneTriggered());
    await f.scheduler.idle();
    expect(f.mostOverall).toBe(2);
    expect(f.acted.map(([c]) => c)).toEqual(["b", "a", "c", "d"]);
  });

  it("a group waiting its turn: a newer message replaces the one it waits with; a cancel or a message naming an Agent takes it out", async () => {
    const f = fake({ hold: true, maxAtOnce: 1 });
    for (const g of ["a", "b", "c", "d", "e"]) f.scheduler.noted(g, 1, "p", false);
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(f.decided).toEqual([["a", 1]]);
    f.scheduler.cancelled("b");
    f.scheduler.noted("c", 2, "p", false); // keeps its place, with the newer message
    f.scheduler.noted("d", 2, "p", true);
    expect(vi.getTimerCount()).toBe(0);
    f.held[0]!.resolve(noneTriggered());
    await flush();
    expect(f.decided).toEqual([
      ["a", 1],
      ["c", 2],
    ]);
    f.held[1]!.resolve(noneTriggered());
    await flush();
    expect(f.decided.at(-1)).toEqual(["e", 1]);
    f.held[2]!.resolve(noneTriggered());
    await f.scheduler.idle();
    await vi.advanceTimersByTimeAsync(DELAY * 5);
    expect(f.decided).toEqual([
      ["a", 1],
      ["c", 2],
      ["e", 1],
    ]);
  });

  it("close() empties the queue of groups waiting their turn", async () => {
    const f = fake({ hold: true, maxAtOnce: 1 });
    f.scheduler.noted("a", 1, "p", false);
    f.scheduler.noted("b", 1, "p", false);
    await vi.advanceTimersByTimeAsync(DELAY);
    f.scheduler.close();
    f.held[0]!.resolve(noneTriggered());
    await f.scheduler.idle();
    await vi.advanceTimersByTimeAsync(DELAY * 5);
    expect(f.decided).toEqual([["a", 1]]);
    expect(f.acted).toEqual([]);
  });

  it("even a logger that throws leaves no rejection unhandled, and the group goes on", async () => {
    vi.useRealTimers();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const f = fake({ logThrows: true, decide: (call) => (call === 1 ? Promise.reject(new Error("no answer")) : noneTriggered()) });
      f.scheduler.noted("g", 1, "p", false);
      await sleep(DELAY * 3);
      expect(await settlesWithin(f.scheduler.idle(), 100)).toBe(true);
      f.scheduler.noted("g", 2, "p", false);
      await sleep(DELAY * 3);
      expect(await settlesWithin(f.scheduler.idle(), 100)).toBe(true);
      expect(f.errors).toHaveLength(1);
      expect(f.decided).toEqual([
        ["g", 1],
        ["g", 2],
      ]);
      expect(f.acted).toHaveLength(1);
      // An unhandled rejection is reported on a later turn of the event loop.
      await new Promise<void>((done) => setImmediate(done));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("idle() resolves at once when nothing waits", async () => {
    expect(await settlesNow(fake().scheduler.idle())).toBe(true);
  });

  it("its timers never hold the process open (unref'd)", () => {
    vi.useRealTimers();
    const spy = vi.spyOn(globalThis, "setTimeout");
    try {
      const f = fake();
      f.scheduler.noted("g", 1, "p", false);
      const ours = spy.mock.results.filter((_, i) => spy.mock.calls[i]![1] === DELAY).map((r) => r.value as NodeJS.Timeout);
      expect(ours).toHaveLength(1);
      expect(ours[0]!.hasRef()).toBe(false);
      f.scheduler.close();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("the hourly caps: no group and no sender uses up the site's judgements", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A message noted in `group` by `sender`, waited for, decided and settled. */
  const decideOne = async (f: Fake, group: string, seq: number, sender: string) => {
    f.scheduler.noted(group, seq, sender, false);
    await vi.advanceTimersByTimeAsync(DELAY);
    await f.scheduler.idle();
  };

  it(`the ${PER_GROUP_HOUR + 1}st judged decision of one group within the hour is skipped — not queued, not judged — while another group's goes on; logged once`, async () => {
    const f = fake();
    for (let i = 1; i <= PER_GROUP_HOUR; i++) await decideOne(f, "g", i, `s${i}`);
    expect(f.decided).toHaveLength(PER_GROUP_HOUR);
    await decideOne(f, "g", PER_GROUP_HOUR + 1, "new");
    await decideOne(f, "h", 1, "new");
    expect(f.decided.slice(PER_GROUP_HOUR)).toEqual([["h", 1]]);
    expect(vi.getTimerCount()).toBe(0);
    await decideOne(f, "g", PER_GROUP_HOUR + 2, "newer");
    expect(f.decided.filter(([c]) => c === "g")).toHaveLength(PER_GROUP_HOUR);
    expect(f.infos).toEqual([{ metric: "judge_capped", scope: "group", conversationId: "g" }]);
  });

  it("the same for one sender across groups: their messages are not judged for an hour, anyone else's are", async () => {
    const f = fake();
    for (let i = 1; i <= PER_SENDER_HOUR; i++) await decideOne(f, `g${i}`, 1, "busy");
    await decideOne(f, "other", 1, "busy");
    await decideOne(f, "other", 2, "calm");
    await decideOne(f, "another", 1, "busy");
    expect(f.decided.slice(PER_SENDER_HOUR)).toEqual([["other", 2]]);
    expect(f.infos).toEqual([{ metric: "judge_capped", scope: "sender", conversationId: "other", senderId: "busy" }]);
  });

  it("only a decision that asks the judgement model counts: any number that do not (no option, a stale or calling message) caps nothing", async () => {
    const f = fake({ asks: () => false });
    for (let i = 1; i <= PER_GROUP_HOUR + 1; i++) await decideOne(f, "g", i, "busy");
    expect(f.decided).toHaveLength(PER_GROUP_HOUR + 1);
    expect(f.infos).toEqual([]);
    expect(f.scheduler.remembered()).toBe(0);
    // Every other one asks: those alone count, toward the group's and the sender's caps.
    const g = fake({ asks: (call) => call % 2 === 0, perGroupHour: 3, perSenderHour: 100 });
    for (let i = 1; i <= 7; i++) await decideOne(g, "g", i, "busy");
    expect(g.decided).toHaveLength(6);
    expect(g.infos).toEqual([{ metric: "judge_capped", scope: "group", conversationId: "g" }]);
    const s = fake({ asks: (call) => call % 2 === 0, perGroupHour: 100, perSenderHour: 2 });
    for (let i = 1; i <= 5; i++) await decideOne(s, `g${i}`, 1, "busy");
    expect(s.decided).toHaveLength(4);
    expect(s.infos).toEqual([{ metric: "judge_capped", scope: "sender", conversationId: "g5", senderId: "busy" }]);
  });

  it("the hour slides: once the first decision of it is an hour old, the group is decided again; capped is told again an hour after it was", async () => {
    const f = fake({ perGroupHour: 3 });
    await decideOne(f, "g", 1, "a");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await decideOne(f, "g", 2, "b");
    await decideOne(f, "g", 3, "c");
    await decideOne(f, "g", 4, "d");
    expect(f.decided.map(([, seq]) => seq)).toEqual([1, 2, 3]);
    // Just before the first decision is an hour old: still capped.
    await vi.advanceTimersByTimeAsync(HOUR - 10 * 60_000 - 5 * DELAY - 1);
    await decideOne(f, "g", 5, "e");
    expect(f.decided.map(([, seq]) => seq)).toEqual([1, 2, 3]);
    // Now it is: one place again, then capped until the second is an hour old.
    await vi.advanceTimersByTimeAsync(1);
    await decideOne(f, "g", 6, "f");
    await decideOne(f, "g", 7, "g");
    expect(f.decided.map(([, seq]) => seq)).toEqual([1, 2, 3, 6]);
    expect(f.infos).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(HOUR);
    for (const seq of [8, 9, 10, 11]) await decideOne(f, "g", seq, `x${seq}`);
    expect(f.decided.map(([, seq]) => seq)).toEqual([1, 2, 3, 6, 8, 9, 10]);
    expect(f.infos).toHaveLength(2);
  });

  it("a group waiting for a place is skipped when its turn comes if it is capped by then", async () => {
    const f = fake({ hold: true, maxAtOnce: 1, perSenderHour: 2 });
    for (const g of ["a", "b", "c"]) f.scheduler.noted(g, 1, "busy", false);
    await vi.advanceTimersByTimeAsync(DELAY);
    // a is decided; b and c wait for the place, neither capped yet (one decision of the sender's has started).
    expect(f.decided).toEqual([["a", 1]]);
    expect(f.infos).toEqual([]);
    f.held[0]!.resolve(noneTriggered());
    await flush();
    expect(f.decided).toEqual([
      ["a", 1],
      ["b", 1],
    ]);
    // b's decision was the sender's second of the hour: c's turn comes, and it is skipped.
    f.held[1]!.resolve(noneTriggered());
    await f.scheduler.idle();
    expect(f.decided.map(([c]) => c)).toEqual(["a", "b"]);
    expect(f.infos).toEqual([{ metric: "judge_capped", scope: "sender", conversationId: "c", senderId: "busy" }]);
  });

  it("nothing is remembered of a group or a sender once its hour is over, nor after close()", async () => {
    const f = fake({ perGroupHour: 2, perSenderHour: 2 });
    for (let i = 1; i <= 50; i++) await decideOne(f, `g${i}`, 1, `s${i}`);
    expect(f.scheduler.remembered()).toBe(100);
    await vi.advanceTimersByTimeAsync(HOUR);
    await decideOne(f, "late", 1, "late");
    expect(f.scheduler.remembered()).toBe(2);
    await decideOne(f, "late", 2, "late");
    await decideOne(f, "late", 3, "late");
    expect(f.infos).toHaveLength(1);
    f.scheduler.close();
    expect(f.scheduler.remembered()).toBe(0);
  });
});

// --- through the app -------------------------------------------------------------------------------------------------

const JUDGE = {
  model: "jev-1",
  channels: [{ url: "https://judge-a.example.test/v1/systemone", apiKeyEnv: "UPSTREAM_TEST_KEY" }],
  timeoutMs: 4000,
  dailyLimit: 20_000,
};
const judge = scriptedJudge();
const gateway = scriptedGateway();
const FAST = { source: "site", id: "fast" } as const;

beforeEach(() => {
  judge.calls.splice(0);
  judge.answer(() => ({}));
});

/** Whether the scheduler has nothing waiting and nothing in flight (it settles within a few milliseconds). */
const idleNow = (scheduler: ProactiveScheduler) => settlesWithin(scheduler.idle(), 30);

/** Counts the timers set from now on with exactly `delay` ms (the scheduler's debounce), and hands them out. */
function debounces(delay: number) {
  const spy = vi.spyOn(globalThis, "setTimeout");
  const ours = () => spy.mock.results.filter((_, i) => spy.mock.calls[i]![1] === delay).map((r) => r.value as NodeJS.Timeout);
  return { count: () => ours().length, timers: ours, stop: () => spy.mockRestore() };
}

interface World {
  owner: Actor;
  member: Actor;
  third: Actor;
  g: string;
}
async function world(app: FastifyInstance): Promise<World> {
  const [owner, member, third] = [await signUp(app, "owner"), await signUp(app, "member"), await signUp(app, "third")];
  return { owner, member, third, g: await group(app, owner, "team", [member, third]) };
}

/** An Agent of `owner` named `handle` on the site model (proactive unless `over` says otherwise), added to `conv` by its owner. */
async function agentIn(app: FastifyInstance, owner: Actor, handle: string, conv: string | null, over: Record<string, unknown> = {}) {
  const agent = (await mustCreateAgent(app, owner, { handle, name: handle, model: FAST, persona: "简短地回答。", proactive: true, ...over })) as {
    id: string;
    conversationId: string;
  };
  if (conv) {
    const added = await api(app, owner, "POST", `/api/conversations/${conv}/members`, { principalId: agent.id });
    if (added.status !== 201) throw new Error(`agentIn: ${added.status} ${JSON.stringify(added.json)}`);
  }
  return agent;
}

let txn = 0;
async function say(app: FastifyInstance, who: Actor, conv: string, text: string): Promise<number> {
  const sent = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `ps${++txn}` });
  if (sent.status !== 201) throw new Error(`say: ${sent.status} ${JSON.stringify(sent.json)}`);
  return sent.json.message.seq as number;
}

/** A message of the Agent stored as `postAsAgent` stores one (the group's row held), without the worker. */
const agentSays = (db: Db, agentId: string, conv: string, text: string) =>
  db.tx(async (t) => {
    await lockConversation(t, conv);
    return (await insertMessage(t, conv, agentId, "text", { text }, null)).seq;
  });

const runsOf = async (db: Db, agentId: string, conv: string) =>
  (
    await db.query(`select status, lane, covers_seq::int as covers from agent_runs where agent_id = $1 and conversation_id = $2 order by created_at, id`, [
      agentId,
      conv,
    ])
  ).rows;

describe("what is noted: the send route and an Agent's post", () => {
  // Nothing here waits for a debounce to end: whether one is waiting is read from the scheduler (`idleNow`).
  const LONG = 2_345;
  const { app, db } = useApp({ env: SITE_ENV, judge, models: gateway, agentWorker: false, config: { judge: JUDGE }, proactive: { delayMs: LONG } });
  const scheduler = () => app.deps.proactive!;

  afterEach(() => {
    vi.restoreAllMocks();
    expect(gateway.pending()).toBe(0);
  });

  it("a person's message in a group naming no Agent starts one debounce of the configured wait (unref'd); the next replaces it", async () => {
    const w = await world(app);
    await agentIn(app, w.owner, "anna", w.g);
    const noted = vi.spyOn(scheduler(), "noted");
    const timers = debounces(LONG);
    const first = await say(app, w.member, w.g, "今晚做什么菜好？");
    expect(timers.count()).toBe(1);
    expect(await idleNow(scheduler())).toBe(false);
    const second = await say(app, w.owner, w.g, "我也想知道");
    expect(noted.mock.calls).toEqual([
      [w.g, first, w.member.id, false],
      [w.g, second, w.owner.id, false],
    ]);
    expect(timers.count()).toBe(2);
    expect(timers.timers().every((t) => !t.hasRef())).toBe(true);
    scheduler().cancelled(w.g);
    expect(await idleNow(scheduler())).toBe(true);
    expect(judge.calls).toEqual([]);
  });

  it("a message calling an Agent of the group cancels what was waiting and starts nothing; an @handle the call did not reach is noted", async () => {
    const w = await world(app);
    await agentIn(app, w.owner, "anna", w.g);
    await agentIn(app, w.third, "bobbot", null, { proactive: false });
    const noted = vi.spyOn(scheduler(), "noted");
    await say(app, w.member, w.g, "今晚做什么菜好？");
    expect(await idleNow(scheduler())).toBe(false);
    const toAnna = await say(app, w.member, w.g, "@anna 你觉得呢？");
    expect(await idleNow(scheduler())).toBe(true);
    // An Agent outside the group, and a person: no call was made, so the message is noted as any (its decision would
    // refuse a message naming an Agent at its first read).
    const toBob = await say(app, w.member, w.g, "@BobBot 你会做饭吗？");
    expect(await idleNow(scheduler())).toBe(false);
    const toThird = await say(app, w.member, w.g, `@${w.third.handle} 你呢？`);
    expect(await idleNow(scheduler())).toBe(false);
    expect(noted.mock.calls.slice(1)).toEqual([
      [w.g, toAnna, w.member.id, true],
      [w.g, toBob, w.member.id, false],
      [w.g, toThird, w.member.id, false],
    ]);
    scheduler().cancelled(w.g);
    expect(judge.calls).toEqual([]);
  });

  it("noting a message reads nothing more from the database once it is sent, whatever @handles it has", async () => {
    const w = await world(app);
    await agentIn(app, w.owner, "anna", w.g);
    await agentIn(app, w.third, "bobbot", null, { proactive: false });
    const noted = vi.spyOn(scheduler(), "noted");
    const queries = vi.spyOn(app.deps.db, "query");
    for (const text of ["@anna 在吗？", "@bobbot 在吗？", `@${w.third.handle} 在吗？`, "@nobody_here 在吗？"]) await say(app, w.member, w.g, text);
    expect(noted).toHaveBeenCalledTimes(4);
    const handleLookups = queries.mock.calls.filter(([sql]) => /kind = 'agent' and handle = any/.test(String(sql)));
    expect(handleLookups).toEqual([]);
    scheduler().cancelled(w.g);
  });

  it("a message in a direct chat or in an Agent's own conversation is never noted, and sets no timer", async () => {
    const w = await world(app);
    const anna = await agentIn(app, w.owner, "anna", null);
    const { conversationId: direct } = await befriend(app, w.member, (await signUp(app, "friend")));
    const noted = vi.spyOn(scheduler(), "noted");
    const timers = debounces(LONG);
    await say(app, w.member, direct, "今晚做什么菜好？");
    await say(app, w.owner, anna.conversationId, "今晚做什么菜好？");
    expect(noted).not.toHaveBeenCalled();
    expect(timers.count()).toBe(0);
    expect(await idleNow(scheduler())).toBe(true);
  });

  it("an Agent's post in the group cancels the judgement waiting there", async () => {
    const w = await world(app);
    const anna = await agentIn(app, w.owner, "anna", w.g);
    const cancelled = vi.spyOn(scheduler(), "cancelled");
    await say(app, w.owner, w.g, "@anna 帮我看看菜单");
    await say(app, w.member, w.g, "今晚做什么菜好？");
    expect(await idleNow(scheduler())).toBe(false);
    gateway.reply("番茄炒蛋。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect((await runsOf(db, anna.id, w.g)).map((r) => r.status)).toEqual(["done"]);
    expect(cancelled).toHaveBeenCalledWith(w.g);
    expect(await idleNow(scheduler())).toBe(true);
    expect(judge.calls).toEqual([]);
  });

  it("the app closing with a judgement waiting leaves nothing running, and nothing is noted after", async () => {
    const SHORT = 40;
    const own = await buildApp(
      { config: app.deps.config, db, judge, models: gateway },
      { answerFloor: NO_ANSWER_FLOOR, staleRunSweep: false, agentWorker: false, proactive: { delayMs: SHORT } },
    );
    let closed = false;
    try {
      await own.ready();
      const w = await world(own);
      const anna = await agentIn(own, w.owner, "anna", w.g);
      judge.answer(byName({ anna: 0.9 }));
      const timers = debounces(SHORT);
      await say(own, w.member, w.g, "今晚做什么菜好？");
      expect(timers.count()).toBe(1);
      const ownScheduler = own.deps.proactive!;
      expect(await idleNow(ownScheduler)).toBe(false);
      // Closed as the stop begins, before the reply worker stops: nothing is judged once shutdown has started.
      const schedulerClosed = vi.spyOn(ownScheduler, "close");
      const workerStopped = vi.spyOn(own.agentWorker, "stop");
      const closing = own.close();
      closed = true;
      await sleep(SHORT * 2);
      await closing;
      expect(schedulerClosed).toHaveBeenCalledTimes(1);
      expect(schedulerClosed.mock.invocationCallOrder[0]!).toBeLessThan(workerStopped.mock.invocationCallOrder[0]!);
      expect(await idleNow(ownScheduler)).toBe(true);
      ownScheduler.noted(w.g, 999, w.member.id, false);
      expect(timers.count()).toBe(1);
      await sleep(SHORT * 4);
      expect(judge.calls).toEqual([]);
      expect(await runsOf(db, anna.id, w.g)).toEqual([]);
    } finally {
      if (!closed) await own.close();
    }
  });
});

describe("what comes of it, with the reply worker running", () => {
  const SHORT = 60;
  const { app, db } = useApp({ env: SITE_ENV, judge, models: gateway, config: { judge: JUDGE }, proactive: { delayMs: SHORT } });

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeAllSockets();
    await app.deps.proactive!.idle();
    expect(gateway.pending()).toBe(0);
  });

  it("a member's on-topic message: once people stop, the Agent's run is queued and announced, and its reply reaches every member", async () => {
    const w = await world(app);
    const anna = await agentIn(app, w.owner, "anna", w.g, { intro: "会做饭的助手", field: "家常菜" });
    const sockets = [await connect(app, w.owner), await connect(app, w.member), await connect(app, w.third)];
    let judgedAt = 0;
    judge.answer((state, questions) => {
      judgedAt = performance.now();
      return byName({ anna: 0.9, nobody: 0.05 })(state, questions);
    });
    gateway.reply("番茄炒蛋，十分钟就好。");
    const before = performance.now();
    const asked = await say(app, w.member, w.g, "今晚做什么菜好？");
    for (const s of sockets) {
      const pushed = await s.next((e) => e.type === "message" && e.message.senderId === anna.id);
      expect(pushed.message.text).toBe("番茄炒蛋，十分钟就好。");
    }
    // Once, about that message, and not before the wait was over.
    expect(judge.calls).toHaveLength(1);
    expect(judge.calls[0]!.state).toContain("今晚做什么菜好？");
    expect(judgedAt - before).toBeGreaterThanOrEqual(SHORT - 5);
    // Announced to its owner as a mention's run is: queued, then the worker's own pushes, to its end.
    await sockets[0]!.waitFor((e) => e.type === "run" && e.conversationId === w.g && e.run?.status === "done");
    expect(sockets[0]!.events.some((e) => e.type === "run" && e.conversationId === w.g && e.agentId === anna.id && e.run?.status === "queued")).toBe(true);
    expect(await runsOf(db, anna.id, w.g)).toEqual([{ status: "done", lane: "proactive", covers: asked }]);
  });

  it("the notice that an Agent keeps quiet, from a decision, is published to every member", async () => {
    const w = await world(app);
    const anna = await agentIn(app, w.owner, "anna", w.g);
    await agentSays(db, anna.id, w.g, "我来说两句");
    const sockets = [await connect(app, w.owner), await connect(app, w.member), await connect(app, w.third)];
    judge.answer(byName({ nobody: 0.9 }, { anna: 0.95 }));
    await say(app, w.member, w.g, "anna 你先别插话了");
    for (const s of sockets) {
      const pushed = await s.next((e) => e.type === "message" && e.message.system?.event === "agent_quieted");
      expect(pushed.message.text).toBe("「anna」暂时不主动发言，需要时可以 @ 一下");
    }
    expect(judge.calls).toHaveLength(1);
    expect(await runsOf(db, anna.id, w.g)).toEqual([]);
  });

  it("a message naming an Agent the call did not reach is noted, and its decision refuses it: the judge is never asked", async () => {
    const w = await world(app);
    const anna = await agentIn(app, w.owner, "anna", w.g);
    await agentIn(app, w.third, "bobbot", null, { proactive: false });
    judge.answer(byName({ anna: 0.9 }));
    const noted = vi.spyOn(app.deps.proactive!, "noted");
    // An Agent outside the group is named by its full handle (family names): nothing is stored for it, but the message
    // asks an Agent (`asks_agent`, decided at send, Task M fix round 1).
    const asked = await say(app, w.member, w.g, "@third.bobbot 今晚做什么菜好？");
    expect(noted.mock.calls).toEqual([[w.g, asked, w.member.id, false]]);
    expect(await idleNow(app.deps.proactive!)).toBe(false);
    await sleep(SHORT * 4);
    await app.deps.proactive!.idle();
    expect(judge.calls).toEqual([]);
    expect(await runsOf(db, anna.id, w.g)).toEqual([]);
  });
});

describe("the hourly caps through the app: only messages actually judged count", () => {
  const WAIT = 30;
  const { app } = useApp({
    env: { ...SITE_ENV, PROACTIVE: JSON.stringify({ perGroupHour: 2, perSenderHour: 3 }) },
    judge,
    agentWorker: false,
    config: { judge: JUDGE },
    proactive: { delayMs: WAIT },
  });
  /** A message of `who`, waited for and decided. */
  const sayDecided = async (who: Actor, conv: string, text: string) => {
    await say(app, who, conv, text);
    await app.deps.proactive!.idle();
  };

  it("a group: messages decided while no Agent there is proactive count for nothing; of those judged, the third in the hour is not", async () => {
    const w = await world(app);
    judge.answer(byName({ nobody: 0.95 }));
    for (const text of ["早", "今天天气不错", "大家在吗"]) await sayDecided(w.member, w.g, text);
    expect(judge.calls).toEqual([]);
    await agentIn(app, w.owner, "anna", w.g);
    await sayDecided(w.third, w.g, "有人会做饭吗");
    await sayDecided(w.owner, w.g, "我也想学");
    await sayDecided(w.member, w.g, "第三个问题");
    expect(judge.calls.map((c) => c.state.split("\n").at(-1))).toEqual(["【新】third：有人会做饭吗", "【新】owner：我也想学"]);
  });

  it("a sender: across groups, the fourth of their messages judged in the hour is not; unjudged ones never counted", async () => {
    const w = await world(app);
    judge.answer(byName({ nobody: 0.95 }));
    for (const text of ["一", "二", "三", "四"]) await sayDecided(w.member, w.g, text);
    const groups: string[] = [];
    for (const title of ["a", "b", "c", "d"]) {
      const g = await group(app, w.owner, `group ${title}`, [w.member, w.third]);
      await agentIn(app, w.owner, `bot_${title}`, g);
      groups.push(g);
    }
    for (const g of groups) await sayDecided(w.member, g, "有人懂吗");
    expect(judge.calls).toHaveLength(3);
    // Someone else's message in the fourth group is judged.
    await sayDecided(w.owner, groups[3]!, "我来问");
    expect(judge.calls).toHaveLength(4);
  });
});

describe("without a judgement model", () => {
  const DELAY_ASKED = 4_321;
  const { app } = useApp({ env: SITE_ENV, config: { judge: null }, proactive: { delayMs: DELAY_ASKED } });

  it("there is no scheduler: a person's message in a group sets no timer", async () => {
    expect(app.deps.judge).toBeNull();
    expect(app.deps.proactive).toBeNull();
    const w = await world(app);
    const timers = debounces(DELAY_ASKED);
    try {
      await say(app, w.member, w.g, "今晚做什么菜好？");
      expect(timers.count()).toBe(0);
    } finally {
      timers.stop();
    }
  });
});
