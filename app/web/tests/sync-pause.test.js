// The shell's pause and resume (README "Bridge", `haiyo:pause` / `haiyo:resume`): the socket is let go on pause and comes back through the
// ordinary reconnect procedure (catch-up from what is held, then /api/sync and /api/social) on resume; no second reconnect exists.
import { afterEach, describe, expect, it, vi } from "vitest";
import { initial } from "../src/data/model.js";
import { start } from "../src/data/sync.js";
import { ANN, D1, G1, direct, fakeTimers, fakeTransport, group, range, settle, syncOf } from "./fixtures.js";

let engines = [];
afterEach(() => {
  for (const e of engines) e.stop();
  engines = [];
});

function run(transport, options = {}) {
  const box = { model: initial() };
  const timers = fakeTimers();
  const statuses = [];
  const engine = start(transport, {
    getModel: () => box.model,
    setModel: (m) => {
      box.model = m;
    },
    timers,
    now: timers.now,
    random: () => 0.5,
    onSignedOut: vi.fn(),
    onStatus: (s) => statuses.push(s),
    ...options,
  });
  engines.push(engine);
  return { box, timers, statuses, engine };
}

const twoChats = () =>
  syncOf([direct(D1, ANN, { lastSeq: 3, readSeq: 3 }), group(G1, { lastSeq: 5, readSeq: 5 })], [...range(D1, 1, 3), ...range(G1, 1, 5, [ANN])]);

describe("pause and resume", () => {
  it("pause closes the socket and plans no reconnect; nothing is retried while paused", async () => {
    const t = fakeTransport({ sync: twoChats });
    const { timers, engine } = run(t);
    await settle();
    const socket = t.socket;
    engine.pause();
    expect(socket.closed).toBe(true);
    expect(timers.pending()).toBe(0);
    t.log.length = 0;
    timers.advance(10 * 60_000);
    await settle();
    expect(t.log).toEqual([]);
  });

  it("pause cancels a reconnect that was only waiting for its back-off, and a socket still opening is closed when it arrives", async () => {
    const t = fakeTransport({ sync: twoChats });
    const { timers, engine } = run(t);
    await settle();
    t.socket.drop(1006);
    expect(timers.pending()).toBe(1);
    engine.pause();
    expect(timers.pending()).toBe(0);
    t.autoOpen = false;
    engine.resume();
    await settle();
    engine.pause();
    t.socket.open();
    await settle();
    expect(t.sockets.every((s) => s.closed)).toBe(true);
  });

  it("resume reconnects at once through the ordinary procedure: catch-up from what is held, then sync and social", async () => {
    const t = fakeTransport({ sync: twoChats });
    const { box, engine } = run(t);
    await settle();
    engine.pause();
    t.handlers.catchUp = () => ({ messages: [], gone: [], more: false });
    t.log.length = 0;
    engine.resume();
    await settle();
    expect(t.log).toEqual(["connect", ["catchup", { [D1]: 3, [G1]: 5 }], "sync", "social"]);
    expect(t.socket.closed).toBe(false);
    expect(box.model.synced).toBe(true);
  });

  it("resume twice, or without a pause before it, makes no second connection", async () => {
    const t = fakeTransport({ sync: twoChats });
    const { engine } = run(t);
    await settle();
    t.log.length = 0;
    engine.resume();
    await settle();
    expect(t.log).toEqual([]);
    engine.pause();
    engine.pause();
    engine.resume();
    engine.resume();
    await settle();
    expect(t.log.filter((x) => x === "connect")).toHaveLength(1);
  });

  it("starting paused (a page that loads in the background) opens nothing until resume", async () => {
    const t = fakeTransport({ sync: twoChats });
    const { engine, timers } = run(t, { paused: true });
    await settle();
    expect(t.log).toEqual([]);
    expect(timers.pending()).toBe(0);
    engine.resume();
    await settle();
    expect(t.log).toEqual(["connect", "sync", "social"]);
  });

  it("a push that arrives on the old socket after pause is not applied", async () => {
    const t = fakeTransport({ sync: twoChats });
    const { box, engine } = run(t);
    await settle();
    const old = t.socket;
    engine.pause();
    old.emit({ type: "message", message: { id: "x", conversationId: D1, seq: 4 } });
    await settle();
    expect(box.model.messages[D1].map((m) => m.seq)).toEqual([1, 2, 3]);
  });

  it("a request made while paused opens nothing", async () => {
    const t = fakeTransport({ sync: twoChats });
    const { engine } = run(t);
    await settle();
    engine.pause();
    t.log.length = 0;
    engine.request({ sync: true });
    await settle();
    expect(t.log).toEqual([]);
  });

  it("a session that ended while paused is still a sign-out on resume (401 on the ticket)", async () => {
    const t = fakeTransport({ sync: twoChats });
    const onSignedOut = vi.fn();
    const { engine } = run(t, { onSignedOut });
    await settle();
    engine.pause();
    t.handlers.ticket = () => {
      throw Object.assign(new Error("x"), { status: 401 });
    };
    engine.resume();
    await settle();
    expect(onSignedOut).toHaveBeenCalledTimes(1);
  });
});
