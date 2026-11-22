import { afterEach, describe, expect, it, vi } from "vitest";
import { initial } from "../src/data/model.js";
import { backoffDelay, start } from "../src/data/sync.js";
import {
  ANN,
  BO,
  D1,
  G1,
  ME_ID,
  apiError,
  deferred,
  direct,
  emptySocial,
  fakeTimers,
  fakeTransport,
  group,
  range,
  settle,
  syncOf,
  wire,
} from "./fixtures.js";

const seqs = (model, id) => (model.messages[id] || []).map((m) => m.seq);
const push = (message) => ({ type: "message", message });

let engines = [];
afterEach(() => {
  for (const e of engines) e.stop();
  engines = [];
});

function run(transport, { random = () => 0.5 } = {}) {
  const box = { model: initial() };
  const timers = fakeTimers();
  const onSignedOut = vi.fn();
  const statuses = [];
  const engine = start(transport, {
    getModel: () => box.model,
    setModel: (m) => {
      box.model = m;
    },
    timers,
    now: timers.now,
    random,
    onSignedOut,
    onStatus: (s) => statuses.push(s),
  });
  engines.push(engine);
  return { box, timers, onSignedOut, statuses, engine };
}

const twoChats = () =>
  syncOf([direct(D1, ANN, { lastSeq: 3, readSeq: 3 }), group(G1, { lastSeq: 5, readSeq: 5 })], [...range(D1, 1, 3), ...range(G1, 1, 5, [ANN, BO])]);

describe("first load", () => {
  it("opens the socket before asking for /api/sync, then loads social, then goes live", async () => {
    const t = fakeTransport({ sync: twoChats });
    const { box, statuses } = run(t);
    await settle();
    expect(t.log).toEqual(["connect", "sync", "social"]);
    expect(seqs(box.model, D1)).toEqual([1, 2, 3]);
    expect(box.model.social).toEqual(emptySocial());
    expect(statuses[0]).toBe("connecting");
    expect(statuses.at(-1)).toBe("live");
  });

  it("buffers pushes that arrive while the initial sync is in flight and applies them exactly once after it (Review Focus 1)", async () => {
    const t = fakeTransport();
    const held = deferred();
    t.handlers.sync = () => held.promise;
    const { box } = run(t);
    await settle();
    expect(t.log).toEqual(["connect", "sync"]);
    // committed before the snapshot (already in it), after it, and delivered twice
    t.socket.emit(push(wire(D1, 3, ANN)));
    t.socket.emit(push(wire(D1, 4, ANN)));
    t.socket.emit(push(wire(D1, 4, ANN)));
    t.socket.emit(push(wire(D1, 5, ANN)));
    expect(box.model.messages[D1]).toBeUndefined();
    held.resolve(twoChats());
    await settle();
    expect(seqs(box.model, D1)).toEqual([1, 2, 3, 4, 5]);
    expect(box.model.conversations[D1]).toMatchObject({ position: 5, unread: 2 });
  });
});

describe("live pushes", () => {
  it("a gap asks catch-up from the held position, buffers meanwhile and never appends out of order", async () => {
    const t = fakeTransport({ sync: twoChats });
    const { box } = run(t);
    await settle();
    const held = deferred();
    t.handlers.catchUp = () => held.promise;
    t.socket.emit(push(wire(D1, 6, ANN)));
    await settle();
    expect(t.log.at(-1)).toEqual(["catchup", { [D1]: 3 }]);
    expect(seqs(box.model, D1)).toEqual([1, 2, 3]);
    t.socket.emit(push(wire(D1, 7, ANN)));
    held.resolve({ messages: [wire(D1, 4, ANN), wire(D1, 5, ANN), wire(D1, 6, ANN)], gone: [], more: false });
    await settle();
    expect(seqs(box.model, D1)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(box.model.conversations[D1].position).toBe(7);
  });

  it("gone (even repeated) removes the conversation; a later conversation event for it re-syncs", async () => {
    const t = fakeTransport({ sync: twoChats });
    const { box } = run(t);
    await settle();
    t.socket.emit({ type: "gone", id: G1 });
    t.socket.emit({ type: "gone", id: G1 });
    expect(box.model.conversations[G1]).toBeUndefined();
    expect(box.model.messages[G1]).toBeUndefined();
    const syncsBefore = t.log.filter((x) => x === "sync").length;
    t.handlers.sync = () => syncOf([direct(D1, ANN, { lastSeq: 3 }), group(G1, { lastSeq: 9 })], [...range(D1, 1, 3), ...range(G1, 8, 9)]);
    t.socket.emit({ type: "conversation", id: G1 });
    await settle();
    expect(t.log.filter((x) => x === "sync").length).toBe(syncsBefore + 1);
    expect(seqs(box.model, G1)).toEqual([8, 9]);
  });

  it("a message for an unknown conversation re-syncs", async () => {
    const t = fakeTransport({ sync: () => syncOf([direct(D1, ANN, { lastSeq: 3 })], range(D1, 1, 3)) });
    const { box } = run(t);
    await settle();
    t.handlers.sync = twoChats;
    t.socket.emit(push(wire(G1, 6, ANN)));
    await settle();
    expect(t.log.filter((x) => x === "sync")).toHaveLength(2);
    expect(seqs(box.model, G1)).toEqual([1, 2, 3, 4, 5]);
  });

  it("a conversation event for a held conversation refetches only that conversation", async () => {
    const t = fakeTransport({ sync: twoChats });
    t.handlers.conversation = (id) => group(id, { title: "改名了", lastSeq: 5 });
    const { box } = run(t);
    await settle();
    t.socket.emit({ type: "conversation", id: G1 });
    await settle();
    expect(t.log.at(-1)).toEqual(["conversation", G1]);
    expect(t.log.filter((x) => x === "sync")).toHaveLength(1);
    expect(box.model.conversations[G1].title).toBe("改名了");
  });

  it("a member nobody has named yet falls back to a full sync", async () => {
    const t = fakeTransport({ sync: twoChats });
    const NEW = "00000000-0000-4000-8000-0000000000a9";
    t.handlers.conversation = (id) =>
      group(id, { members: [{ id: ME_ID, role: "speaker", isCreator: true }, { id: NEW, role: "speaker", isCreator: false }] });
    run(t);
    await settle();
    t.socket.emit({ type: "conversation", id: G1 });
    await settle();
    expect(t.log.slice(-2)).toEqual([["conversation", G1], "sync"]);
  });

  it("404 on the conversation refetch drops it without a full sync; other errors fall back to a full sync", async () => {
    const t = fakeTransport({ sync: twoChats });
    const { box } = run(t);
    await settle();
    t.handlers.sync = () => syncOf([direct(D1, ANN, { lastSeq: 3 })], range(D1, 1, 3));
    t.socket.emit({ type: "conversation", id: G1 }); // default handler answers 404
    await settle();
    expect(t.log.at(-1)).toEqual(["conversation", G1]);
    expect(t.log.filter((x) => x === "sync")).toHaveLength(1);
    expect(box.model.conversations[G1]).toBeUndefined();

    t.handlers.conversation = () => {
      throw apiError(503, "busy");
    };
    t.socket.emit({ type: "conversation", id: D1 });
    await settle();
    expect(t.log.slice(-2)).toEqual([["conversation", D1], "sync"]);
    expect(box.model.conversations[D1]).toBeDefined();
  });

  it("social refetches /api/social; read moves markers forward only", async () => {
    const t = fakeTransport({ sync: () => syncOf([direct(D1, ANN, { lastSeq: 3, readSeq: 1, unread: 2, peerReadSeq: 1 })], range(D1, 1, 3)) });
    const { box } = run(t);
    await settle();
    t.handlers.social = () => ({ ...emptySocial(), friends: [{ id: ANN, handle: "ann", displayName: "小安" }] });
    t.socket.emit({ type: "social" });
    await settle();
    expect(box.model.social.friends).toHaveLength(1);
    t.socket.emit({ type: "read", conversationId: D1, principalId: ANN, seq: 3 });
    t.socket.emit({ type: "read", conversationId: D1, principalId: ANN, seq: 2 });
    expect(box.model.conversations[D1].peerReadSeq).toBe(3);
    t.socket.emit({ type: "read", conversationId: D1, principalId: ME_ID, seq: 3 });
    expect(box.model.conversations[D1]).toMatchObject({ readSeq: 3, unread: 0 });
  });
});

describe("reconnect", () => {
  it("on a non-4001 close: backoff, new socket, catch-up for every held position while more, drop gone, then sync", async () => {
    const t = fakeTransport({ sync: twoChats });
    const { box, timers } = run(t);
    await settle();
    t.socket.drop(1006);
    expect(timers.delays()).toEqual([backoffDelay(0, () => 0.5)]);
    const catchups = [
      { messages: [wire(D1, 4, ANN), wire(D1, 5, ANN)], gone: [G1], more: true },
      { messages: [wire(D1, 6, ANN)], gone: [], more: false },
    ];
    t.handlers.catchUp = () => catchups.shift();
    t.handlers.sync = () => syncOf([direct(D1, ANN, { lastSeq: 6, readSeq: 4, unread: 2, peerReadSeq: 6 })], range(D1, 1, 6));
    t.log.length = 0;
    timers.advance(timers.delays()[0]);
    await settle();
    expect(t.log).toEqual(["connect", ["catchup", { [D1]: 3, [G1]: 5 }], ["catchup", { [D1]: 5 }], "sync", "social"]);
    expect(box.model.conversations[G1]).toBeUndefined();
    expect(seqs(box.model, D1)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(box.model.conversations[D1]).toMatchObject({ position: 6, readSeq: 4, unread: 2, peerReadSeq: 6 });
  });

  it("立即重试 (request {retryNow}) ends the back-off now: a new attempt at once, not after the delay; with nothing waiting it does nothing", async () => {
    const t = fakeTransport({ sync: twoChats });
    const { box, timers, engine } = run(t);
    await settle();
    t.socket.drop(1006);
    expect(timers.pending()).toBe(1);
    t.log.length = 0;
    engine.request({ retryNow: true, sync: true });
    await settle();
    expect(t.log[0]).toBe("connect"); // (no waiting for the delay)
    expect(timers.pending()).toBe(0);
    expect(box.model.synced).toBe(true);
    t.log.length = 0;
    engine.request({ retryNow: true });
    await settle();
    expect(t.log).not.toContain("connect"); // (live: nothing to retry)
  });

  it("buffers pushes during the reconnect procedure and applies them after it", async () => {
    const t = fakeTransport({ sync: twoChats });
    const { box, timers } = run(t);
    await settle();
    t.socket.drop(1011);
    const held = deferred();
    t.handlers.catchUp = () => held.promise;
    t.handlers.sync = () => syncOf([direct(D1, ANN, { lastSeq: 4 }), group(G1, { lastSeq: 5 })], [...range(D1, 1, 4), ...range(G1, 1, 5)]);
    timers.advance(30_000);
    await settle();
    t.socket.emit(push(wire(D1, 4, ANN)));
    t.socket.emit(push(wire(D1, 5, ANN)));
    expect(seqs(box.model, D1)).toEqual([1, 2, 3]);
    held.resolve({ messages: [wire(D1, 4, ANN)], gone: [], more: false });
    await settle();
    expect(seqs(box.model, D1)).toEqual([1, 2, 3, 4, 5]);
    expect(box.model.conversations[D1].position).toBe(5);
    expect(t.log.filter((x) => Array.isArray(x) && x[0] === "catchup")).toHaveLength(1);
  });

  it("4001 calls onSignedOut once and never reconnects", async () => {
    const t = fakeTransport({ sync: twoChats });
    const { timers, onSignedOut, statuses } = run(t);
    await settle();
    t.socket.drop(4001);
    expect(onSignedOut).toHaveBeenCalledTimes(1);
    expect(timers.pending()).toBe(0);
    timers.advance(120_000);
    await settle();
    expect(t.log.filter((x) => x === "connect")).toHaveLength(1);
    expect(statuses.at(-1)).toBe("signedOut");
  });

  it("close 4002 (a newer socket replaced this one) waits 60 s plus jitter before reconnecting", async () => {
    const t = fakeTransport({ sync: twoChats });
    const { timers } = run(t, { random: () => 0.5 });
    await settle();
    t.socket.drop(4002);
    expect(timers.delays()).toEqual([60_000 + 15_000]);
    timers.advance(74_999);
    await settle();
    expect(t.log.filter((x) => x === "connect")).toHaveLength(1);
    timers.advance(1);
    await settle();
    expect(t.log.filter((x) => x === "connect")).toHaveLength(2);
    // other close codes keep the normal backoff
    t.socket.drop(1006);
    expect(timers.delays()).toEqual([backoffDelay(0, () => 0.5)]);
  });

  it("401 from any request (ticket, sync) is a sign-out, not a reconnect", async () => {
    const t = fakeTransport({ ticket: () => {
      throw apiError(401, "unauthenticated");
    } });
    const a = run(t);
    await settle();
    expect(a.onSignedOut).toHaveBeenCalledTimes(1);
    expect(a.timers.pending()).toBe(0);

    const t2 = fakeTransport({ sync: () => {
      throw apiError(401, "unauthenticated");
    } });
    const b = run(t2);
    await settle();
    expect(b.onSignedOut).toHaveBeenCalledTimes(1);
    expect(b.timers.pending()).toBe(0);
    expect(t2.socket.closed).toBe(true);
  });

  it("other failures reconnect with growing backoff (1 s → 30 s, jitter) and reset after a stable connection", async () => {
    expect(backoffDelay(0, () => 0)).toBe(1000);
    expect(backoffDelay(0, () => 1)).toBe(2000);
    expect(backoffDelay(3, () => 0)).toBe(8000);
    expect(backoffDelay(10, () => 1)).toBe(30_000);
    expect(backoffDelay(10, () => 0)).toBe(15_000);

    const t = fakeTransport({ sync: () => {
      throw apiError(0, "network_error");
    } });
    const { timers } = run(t, { random: () => 0 });
    await settle();
    const seen = [];
    for (let i = 0; i < 6; i += 1) {
      seen.push(timers.delays()[0]);
      timers.advance(timers.delays()[0]);
      await settle();
    }
    expect(seen).toEqual([1000, 2000, 4000, 8000, 15_000, 15_000]);
    expect(t.log.filter((x) => x === "connect")).toHaveLength(7);
    expect(t.sockets.slice(0, -1).every((s) => s.closed)).toBe(true);

    t.handlers.sync = twoChats;
    timers.advance(timers.delays()[0]);
    await settle();
    timers.advance(60_000); // stays up
    t.socket.drop(1006);
    expect(timers.delays()).toEqual([1000]);
  });

  it("stop() closes the socket, cancels timers, ignores late answers, and a new start works", async () => {
    const t = fakeTransport({ sync: twoChats });
    const a = run(t);
    await settle();
    t.socket.drop(1006);
    expect(a.timers.pending()).toBe(1);
    a.engine.stop();
    expect(a.timers.pending()).toBe(0);

    const held = deferred();
    t.handlers.sync = () => held.promise;
    const b = run(t);
    await settle();
    b.engine.stop();
    expect(t.socket.closed).toBe(true);
    held.resolve(twoChats());
    await settle();
    expect(b.box.model.synced).toBe(false);
    expect(b.timers.pending()).toBe(0);

    t.handlers.sync = twoChats;
    const c = run(t);
    await settle();
    expect(c.box.model.synced).toBe(true);
  });

  it("a socket that fails to open is retried with backoff", async () => {
    const t = fakeTransport({ sync: twoChats });
    t.autoOpen = false;
    const { timers } = run(t);
    t.socket.fail(Object.assign(new Error("closed before open"), { code: 1006 }));
    await settle();
    expect(timers.pending()).toBe(1);
    t.autoOpen = true;
    timers.advance(timers.delays()[0]);
    await settle();
    expect(t.log).toEqual(["connect", "connect", "sync", "social"]);
  });
});
