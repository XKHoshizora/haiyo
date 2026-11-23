// The model's Agent slices: runs and their transient streams, Agents, providers, usage, site models, avatar versions.
import { describe, expect, it } from "vitest";
import * as M from "../src/data/model.js";
import { toView } from "../src/data/viewmodel.js";
import { lastPreview } from "../src/state/selectors.js";
import { A1, A2, AG1, AG2, ANN, D1, G1, ME_ID, PRINCIPALS, agentConv, agentOf, agentPrincipal, at, direct, group, notice, runOf, syncOf, wire } from "./fixtures.js";

const NOW = new Date(2026, 10, 16, 12, 0).getTime();
const R1 = "00000000-0000-4000-8000-0000000000e1";
const R2 = "00000000-0000-4000-8000-0000000000e2";
const STRAY = "00000000-0000-4000-8000-0000000000e9";

/** A1 holds the Agent's greeting (seq 1) and my message (seq 2); D1 is a direct chat. */
function loaded({ agents = [agentOf()], extra = [] } = {}) {
  const sync = syncOf(
    [agentConv(A1, AG1, { lastSeq: 2, readSeq: 2 }), direct(D1, ANN), ...extra],
    [wire(A1, 1, AG1, "你好，我是小助手"), wire(A1, 2, ME_ID, "在吗")],
    [...PRINCIPALS, agentPrincipal()],
  );
  return M.applyAgents(M.applySync(M.initial(), sync), agents);
}

const view = (state) => toView(state, { now: NOW });

// The service's pushes of one reply: `running`, three text deltas (the second with reasoning), the stored message, `done`.
const STEPS = {
  running: (s) => M.applyRun(s, A1, runOf(R1, "running")),
  d1: (s) => M.applyDelta(s, { conversationId: A1, runId: R1, text: "你" }),
  d2: (s) => M.applyDelta(s, { conversationId: A1, runId: R1, text: "好", reasoning: "想一想" }),
  d3: (s) => M.applyDelta(s, { conversationId: A1, runId: R1, text: "呀" }),
  message: (s) => M.applyMessage(s, wire(A1, 3, AG1, "你好呀")).state,
  done: (s) => M.applyRun(s, A1, runOf(R1, "done")),
  late: (s) => M.applyDelta(s, { conversationId: A1, runId: R1, text: "！" }),
  stray: (s) => M.applyDelta(s, { conversationId: A1, runId: STRAY, text: "鬼" }),
};

/** Every order of `items` that keeps the deltas (d1, d2, d3) in their own order (the service sends them in order). */
function orders(items) {
  if (items.length === 0) return [[]];
  const isDelta = (step) => /^d\d$/.test(step);
  const out = [];
  items.forEach((item, i) => {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    if (isDelta(item) && rest.some((r) => isDelta(r) && r < item)) return;
    for (const tail of orders(rest)) out.push([item, ...tail]);
  });
  return out;
}

/** The reply's stored message (seq 3) and the stream bubble are never both shown. */
function checkAtMostOne(state, label) {
  const conv = view(state).convs[A1];
  if (!conv) return;
  const stored = conv.messages.filter((m) => m.seq === 3).length;
  if (conv.stream) expect(stored, `${label}: bubble and message at once`).toBe(0);
  expect(conv.stream?.text ?? "", label).not.toContain("鬼");
}

describe("a reply's stream (Review Focus 1 and 2)", () => {
  it("shows the stream as one bubble while the run is running", () => {
    let s = loaded();
    for (const step of ["running", "d1", "d2"]) s = STEPS[step](s);
    expect(s.streams).toEqual({ [R1]: { text: "你好", reasoning: "想一想" } });
    expect(view(s).convs[A1].stream).toEqual({ runId: R1, text: "你好", reasoning: "想一想", cut: false, reasoningCut: false });
    expect(view(s).convs[A1].run).toMatchObject({ id: R1, status: "running" });
  });

  const tails = orders(["d1", "d2", "d3", "message", "done"]);
  it(`covers every order the service can produce (${tails.length} orders, each with a stray delta anywhere and a late one)`, () => {
    expect(tails).toHaveLength(20);
    let cases = 0;
    for (const tail of tails) {
      for (let at = 0; at <= tail.length + 1; at += 1) {
        const steps = ["running", ...tail, "late"];
        steps.splice(at, 0, "stray");
        let s = loaded();
        for (const step of steps) {
          s = STEPS[step](s);
          checkAtMostOne(s, steps.join(" → "));
        }
        const conv = view(s).convs[A1];
        expect(conv.messages.filter((m) => m.seq === 3), steps.join(" → ")).toHaveLength(1);
        expect(s.streams, steps.join(" → ")).toEqual({});
        expect(conv.stream, steps.join(" → ")).toBeNull();
        expect(conv.run, steps.join(" → ")).toMatchObject({ id: R1, status: "done" });
        cases += 1;
      }
    }
    expect(cases).toBe(20 * 7);
  });

  it("the streamed text never enters the messages, the unread count, the preview or the position", () => {
    let s = loaded();
    const before = view(s).convs[A1];
    for (const step of ["running", "d1", "d2", "d3"]) s = STEPS[step](s);
    const conv = view(s).convs[A1];
    expect(conv.messages.map((m) => m.id)).toEqual(before.messages.map((m) => m.id));
    expect(conv.unread).toBe(before.unread);
    expect(lastPreview(view(s), conv)).toBe("在吗");
    expect(s.conversations[A1].position).toBe(2);
  });

  it("keeps the first 20 000 characters of a reply being written, and of its thinking; what comes after is dropped", () => {
    expect(M.STREAM_CHARS).toBe(20000);
    let s = M.applyRun(loaded(), A1, runOf(R1, "running"));
    const piece = "一二三四五六七八九十".repeat(200); // 2 000 characters
    for (let i = 0; i < 9; i += 1) s = M.applyDelta(s, { conversationId: A1, runId: R1, text: piece, reasoning: piece });
    expect(s.streams[R1]).toEqual({ text: piece.repeat(9), reasoning: piece.repeat(9) });
    expect(view(s).convs[A1].stream).toMatchObject({ cut: false, reasoningCut: false });
    // Exactly at the limit: nothing was dropped yet.
    s = M.applyDelta(s, { conversationId: A1, runId: R1, text: piece });
    expect(s.streams[R1].text).toHaveLength(20000);
    expect(view(s).convs[A1].stream).toMatchObject({ cut: false, reasoningCut: false });
    // 200 000 characters in all: the first 20 000 are kept, and the view says the text was cut.
    for (let i = 0; i < 90; i += 1) s = M.applyDelta(s, { conversationId: A1, runId: R1, text: piece });
    expect(s.streams[R1].text).toBe(piece.repeat(10));
    expect(view(s).convs[A1].stream).toMatchObject({ cut: true, reasoningCut: false });
    // Once cut, a text delta changes nothing at all (the same state: nothing is rendered again).
    expect(M.applyDelta(s, { conversationId: A1, runId: R1, text: piece })).toBe(s);
    // The thinking has the same limit of its own; a piece that crosses it is kept up to it.
    s = M.applyDelta(s, { conversationId: A1, runId: R1, reasoning: "想".repeat(2500) });
    expect(s.streams[R1].reasoning).toBe(piece.repeat(9) + "想".repeat(2000));
    expect(view(s).convs[A1].stream).toMatchObject({ cut: true, reasoningCut: true });
    expect(M.applyDelta(s, { conversationId: A1, runId: R1, text: "又", reasoning: "又" })).toBe(s);
  });

  it("a reply cut at the limit never ends in half a character", () => {
    let s = M.applyRun(loaded(), A1, runOf(R1, "running"));
    s = M.applyDelta(s, { conversationId: A1, runId: R1, text: "a".repeat(19999) + "😀😀" });
    expect(s.streams[R1].text).toBe("a".repeat(19999));
    expect(view(s).convs[A1].stream.cut).toBe(true);
  });

  it("once cut, nothing is appended, even where the cut left room (the fifth review: the text ended …aaZ)", () => {
    let s = M.applyRun(loaded(), A1, runOf(R1, "running"));
    s = M.applyDelta(s, { conversationId: A1, runId: R1, text: "a".repeat(19999), reasoning: "想".repeat(19999) });
    s = M.applyDelta(s, { conversationId: A1, runId: R1, text: "😀MIDDLE", reasoning: "😀MIDDLE" });
    expect(s.streams[R1]).toEqual({ text: "a".repeat(19999), reasoning: "想".repeat(19999), cut: true, reasoningCut: true });
    expect(M.applyDelta(s, { conversationId: A1, runId: R1, text: "Zlater", reasoning: "Zlater" })).toBe(s);
    // A pair that ends exactly at the limit is whole: kept.
    let t = M.applyRun(loaded(), A1, runOf(R1, "running"));
    t = M.applyDelta(t, { conversationId: A1, runId: R1, text: "a".repeat(19998) + "😀" });
    expect(t.streams[R1]).toEqual({ text: "a".repeat(19998) + "😀", reasoning: "" });
    t = M.applyDelta(t, { conversationId: A1, runId: R1, text: "b" });
    expect(t.streams[R1]).toEqual({ text: "a".repeat(19998) + "😀", reasoning: "", cut: true });
  });

  it("a delta for a queued run, another conversation's run, or a conversation not held is ignored", () => {
    let s = M.applyRun(loaded({ extra: [agentConv(A2, AG2)] }), A1, runOf(R1, "queued"));
    expect(M.applyDelta(s, { conversationId: A1, runId: R1, text: "x" })).toBe(s);
    s = M.applyRun(s, A1, runOf(R1, "running"));
    expect(M.applyDelta(s, { conversationId: A2, runId: R1, text: "x" })).toBe(s);
    expect(M.applyDelta(s, { conversationId: "00000000-0000-4000-8000-0000000000ff", runId: R1, text: "x" })).toBe(s);
    expect(M.applyDelta(s, { conversationId: A1, runId: R1 })).toBe(s);
  });

  it("every terminal status drops the stream; a newer run drops the older run's stream", () => {
    for (const status of ["done", "failed", "stopped", "cancelled"]) {
      let s = STEPS.d1(STEPS.running(loaded()));
      s = M.applyRun(s, A1, runOf(R1, status));
      expect(s.streams, status).toEqual({});
    }
    let s = STEPS.d1(STEPS.running(loaded()));
    s = M.applyRun(s, A1, runOf(R2, "queued"));
    expect(s.streams).toEqual({});
    expect(s.runs[A1]).toMatchObject({ id: R2, status: "queued" });
  });

  it("a run's status never goes back (an HTTP answer that overtook the push), and null means no run to show", () => {
    let s = M.applyRun(loaded(), A1, runOf(R1, "running"));
    expect(M.applyRun(s, A1, runOf(R1, "queued"))).toBe(s);
    s = M.applyRun(s, A1, runOf(R1, "failed", { error: "provider_unavailable", retryable: true }));
    expect(M.applyRun(s, A1, runOf(R1, "running"))).toBe(s);
    expect(M.applyRun(s, A1, null).runs[A1]).toBeNull();
    expect(M.applyRun(s, "00000000-0000-4000-8000-0000000000ff", runOf(R2, "queued"))).toBe(s);
  });

  it("clearStreams forgets every stream (a reconnect) and keeps the runs", () => {
    const s = M.clearStreams(STEPS.d1(STEPS.running(loaded())));
    expect(s.streams).toEqual({});
    expect(s.runs[A1]).toMatchObject({ id: R1, status: "running" });
    expect(M.clearStreams(s)).toBe(s);
  });

  it("clearStreams also forgets what a run's tool was doing: known only from before the reconnect, it is not shown until a push says it again", () => {
    const searching = M.applyRun(loaded(), A1, runOf(R1, "running"), { since: 2, activity: "search" });
    expect(searching.runs[A1].activity).toBe("search");
    const s = M.clearStreams(searching);
    expect(s.runs[A1]).toMatchObject({ id: R1, status: "running", joined: true });
    expect(s.runs[A1]).not.toHaveProperty("activity");
  });

  it("gone, or a sync that no longer lists the conversation, clears its run and stream", () => {
    const streaming = STEPS.d1(STEPS.running(loaded()));
    const gone = M.applyGone(streaming, A1);
    expect(gone.runs).toEqual({});
    expect(gone.streams).toEqual({});
    const resynced = M.applySync(streaming, syncOf([direct(D1, ANN)], [], PRINCIPALS));
    expect(resynced.runs).toEqual({});
    expect(resynced.streams).toEqual({});
  });
});

describe("a reply's stream across reconnects, duplicates, a follow-up run and gone", () => {
  const R1_TEXT = "你好";
  const R2_TEXT = "嗯";
  // The service's own order for A1 (it holds the greeting, seq 1, and my message, seq 2): R1 runs, I write once more
  // while it does (seq 3), R1 posts its reply (seq 4) and ends, and the follow-up R2 answers seq 3 (its reply: seq 5).
  // The old reply (seq 4) lies after what R2 covers: the case a "newer than what was read" rule gets wrong.
  const T = [
    { run: runOf(R1, "running") },
    { delta: { runId: R1, text: "你" } },
    { message: wire(A1, 3, ME_ID, "还有") },
    { delta: { runId: R1, text: "好" } },
    { message: wire(A1, 4, AG1, R1_TEXT) },
    { run: runOf(R1, "done") },
    { run: runOf(R2, "running") },
    { delta: { runId: R2, text: R2_TEXT } },
    { message: wire(A1, 5, AG1, R2_TEXT) },
    { run: runOf(R2, "done") },
  ];
  const REPLY_SEQ = { [R1]: 4, [R2]: 5 };
  const FULL = { [R1]: R1_TEXT, [R2]: R2_TEXT };
  const BASE = [wire(A1, 1, AG1, "你好，我是小助手"), wire(A1, 2, ME_ID, "在吗")];

  /** What the service holds after the first `k` events: the messages, and the run `GET .../run` answers. */
  function serverAfter(k) {
    const messages = [...BASE, ...T.slice(0, k).filter((e) => e.message).map((e) => e.message)];
    const runs = T.slice(0, k).filter((e) => e.run);
    return { messages, run: runs.length ? runs.at(-1).run : null };
  }

  function push(state, e, since) {
    if (e.run) return M.applyRun(state, A1, e.run, { since });
    if (e.delta) return M.applyDelta(state, { conversationId: A1, ...e.delta });
    return M.applyMessage(state, e.message).state;
  }

  /** Never the bubble and the stored reply of one run at once; a bubble never starts mid-reply or mixes replies. */
  function check(state, label) {
    const conv = view(state).convs[A1];
    if (!conv?.stream) return;
    const { runId, text } = conv.stream;
    expect(conv.messages.some((m) => m.seq === REPLY_SEQ[runId]), `${label}: bubble and message of ${runId}`).toBe(false);
    expect(FULL[runId].startsWith(text), `${label}: bubble "${text}" of ${runId}`).toBe(true);
  }

  it("live on one connection with a reconnect anywhere: buffered duplicates, a late GET .../run answer, the follow-up run", () => {
    let cases = 0;
    const n = T.length;
    for (let L = 0; L <= n; L += 1) {
      // Pushes L..o-1 are lost while disconnected; the snapshot is read after s events; pushes o..b-1 wait in the buffer
      // (since: the lastSeq before the snapshot); GET .../run is read after g events and answered after `a` of the pushes
      // from o (never before the buffer is applied: it is asked for once the connection is live).
      for (let o = L; o <= Math.min(L + 2, n); o += 1) {
        for (let s = o; s <= Math.min(o + 2, n); s += 1) {
          for (let b = s; b <= Math.min(s + 2, n); b += 1) {
            for (const g of new Set([b, n])) {
              for (let a = b - o; a <= n - o; a += 1) {
                const label = `L${L} o${o} s${s} b${b} g${g} a${a}`;
                let state = loaded();
                for (const e of T.slice(0, L)) {
                  state = push(state, e);
                  check(state, `${label} old`);
                }
                state = M.clearStreams(state);
                check(state, `${label} reconnect`);
                const floor = state.conversations[A1].lastSeq;
                const snap = serverAfter(s);
                state = M.applySync(state, syncOf([agentConv(A1, AG1, { lastSeq: snap.messages.at(-1).seq }), direct(D1, ANN)], snap.messages, [...PRINCIPALS, agentPrincipal()]));
                check(state, `${label} snapshot`);
                const rest = T.slice(o);
                for (let i = 0; i <= rest.length; i += 1) {
                  if (i === a) {
                    state = M.applyRun(state, A1, serverAfter(g).run, { ordered: false });
                    check(state, `${label} answer`);
                  }
                  if (i === rest.length) break;
                  state = push(state, rest[i], o + i < b ? floor : undefined);
                  check(state, `${label} push ${o + i}`);
                }
                const conv = view(state).convs[A1];
                for (const seq of [3, 4, 5]) expect(conv.messages.filter((m) => m.seq === seq), `${label} seq ${seq}`).toHaveLength(1);
                expect(state.streams, label).toEqual({});
                expect(conv.stream, label).toBeNull();
                expect(conv.run, label).toMatchObject({ id: R2, status: "done" });
                cases += 1;
              }
            }
          }
        }
      }
    }
    expect(cases).toBeGreaterThan(1000);
  });

  it("a duplicate push of an earlier reply, at any point, never brings a bubble back or doubles a message", () => {
    for (let at = 5; at <= T.length; at += 1) {
      let state = loaded();
      const steps = [...T.slice(0, at), { message: T[4].message }, ...T.slice(at)];
      for (const e of steps) {
        state = push(state, e);
        check(state, `duplicate after ${at}`);
      }
      expect(view(state).convs[A1].messages.filter((m) => m.seq === 4)).toHaveLength(1);
      expect(state.streams).toEqual({});
    }
  });

  it("gone at any point of every order clears the run and its stream, and nothing after it comes back", () => {
    for (const tail of orders(["d1", "d2", "d3", "message", "done"])) {
      for (let at = 0; at <= tail.length + 1; at += 1) {
        const steps = ["running", ...tail];
        let state = loaded();
        for (let i = 0; i <= steps.length; i += 1) {
          if (i === at) state = M.applyGone(state, A1);
          if (i === steps.length) break;
          state = STEPS[steps[i]](state);
          checkAtMostOne(state, `${steps.join(" → ")} gone@${at}`);
          if (i >= at) {
            expect(state.conversations[A1]).toBeUndefined();
            expect(state.runs[A1]).toBeUndefined();
            expect(state.streams).toEqual({});
          }
        }
      }
    }
  });
});

describe("the rules for runs known from an answer", () => {
  it("an answer brings a joined run: shown, never streamed; a push of the same run puts it in order with the pushes", () => {
    let s = M.applyRun(loaded(), A1, runOf(R1, "running"), { ordered: false });
    expect(s.runs[A1]).toMatchObject({ id: R1, status: "running", joined: true });
    expect(M.applyDelta(s, { conversationId: A1, runId: R1, text: "x" })).toBe(s);
    expect(view(s).convs[A1]).toMatchObject({ run: { id: R1, status: "running" }, stream: null });
    s = M.applyRun(s, A1, runOf(R1, "running"));
    expect(s.runs[A1].joined).toBeUndefined();
    expect(s.runs[A1].since).toBe(2);
    s = M.applyDelta(s, { conversationId: A1, runId: R1, text: "你" });
    expect(view(s).convs[A1].stream).toEqual({ runId: R1, text: "你", reasoning: "", cut: false, reasoningCut: false });
  });

  it("an answer never replaces a run named by a push of this connection with another one, or with none", () => {
    const pushed = M.applyRun(loaded(), A1, runOf(R2, "running"));
    expect(M.applyRun(pushed, A1, runOf(R1, "done"), { ordered: false })).toBe(pushed);
    expect(M.applyRun(pushed, A1, null, { ordered: false })).toBe(pushed);
    // The same run, further on: taken.
    expect(M.applyRun(pushed, A1, runOf(R2, "done"), { ordered: false }).runs[A1]).toMatchObject({ id: R2, status: "done" });
    // A pushed failure is not hidden by a `null` that may have been read before it.
    const failed = M.applyRun(loaded(), A1, runOf(R1, "failed", { error: "busy", retryable: true }));
    expect(M.applyRun(failed, A1, null, { ordered: false })).toBe(failed);
    // Known only from before (a reconnect): `null` (dismissed in another tab meanwhile) is taken.
    expect(M.applyRun(M.clearStreams(failed), A1, null, { ordered: false }).runs[A1]).toBeNull();
  });

  it("a reconnect makes every held run joined and drops its since", () => {
    const s = M.clearStreams(M.applyRun(loaded(), A1, runOf(R1, "running")));
    expect(s.runs[A1]).toEqual({ ...runOf(R1, "running"), joined: true });
  });

  it("a dismissed failed run does not come back with a late answer", () => {
    const failed = runOf(R1, "failed", { error: "provider_unavailable", retryable: true });
    let s = M.dismissRunOf(M.applyRun(loaded(), A1, failed, { ordered: false }), A1, R1);
    expect(s.runs[A1]).toBeNull();
    s = M.applyRun(s, A1, failed, { ordered: false });
    expect(s.runs[A1]).toBeNull();
    expect(M.applyRun(s, A1, runOf(R2, "queued")).runs[A1]).toMatchObject({ id: R2 });
  });

  it("markRunUnknown hides a queued or running run (no replying shown), and the next push or answer clears it", () => {
    let s = M.applyRun(loaded(), A1, runOf(R1, "running"), { ordered: false });
    s = M.markRunUnknown(s, A1);
    expect(view(s).convs[A1].run).toBeNull();
    expect(M.markRunUnknown(s, A1)).toBe(s);
    const finished = M.applyRun(loaded(), A1, runOf(R1, "done"));
    expect(M.markRunUnknown(finished, A1)).toBe(finished);
    expect(view(M.applyRun(s, A1, runOf(R1, "done"))).convs[A1].run).toMatchObject({ id: R1, status: "done" });
  });

  it("a buffered run push whose reply the snapshot already holds is posted at once (its since is the lastSeq before)", () => {
    const sync = syncOf([agentConv(A1, AG1, { lastSeq: 3 }), direct(D1, ANN)], [...[wire(A1, 1, AG1, "你好"), wire(A1, 2, ME_ID, "在吗")], wire(A1, 3, AG1, "好的")], [...PRINCIPALS, agentPrincipal()]);
    const s = M.applyRun(M.applySync(loaded(), sync), A1, runOf(R1, "running"), { since: 2 });
    expect(s.runs[A1]).toMatchObject({ posted: true, since: 2 });
    expect(M.applyDelta(s, { conversationId: A1, runId: R1, text: "好" })).toBe(s);
  });

  it("a run push that arrives late (after a snapshot that holds its reply): the reply's duplicate push ends the bubble", () => {
    const sync = syncOf([agentConv(A1, AG1, { lastSeq: 3 }), direct(D1, ANN)], [wire(A1, 1, AG1, "你好"), wire(A1, 2, ME_ID, "在吗"), wire(A1, 3, AG1, "好的")], [...PRINCIPALS, agentPrincipal()]);
    let s = M.applySync(loaded(), sync);
    // Live (no floor): in order with the pushes, after the snapshot.
    s = M.applyRun(s, A1, runOf(R1, "running"));
    s = M.applyDelta(s, { conversationId: A1, runId: R1, text: "好" });
    s = M.applyMessage(s, wire(A1, 3, AG1, "好的")).state;
    expect(s.runs[A1].posted).toBe(true);
    expect(s.streams).toEqual({});
    expect(M.applyDelta(s, { conversationId: A1, runId: R1, text: "的" })).toBe(s);
    // A duplicate that is not of the Agent changes nothing.
    const mine = M.applyMessage(STEPS.d1(STEPS.running(loaded())), wire(A1, 2, ME_ID, "在吗")).state;
    expect(mine.runs[A1].posted).toBeUndefined();
  });

  it("a history page or window that holds the running run's reply marks it posted", () => {
    let s = STEPS.d1(STEPS.running(loaded()));
    s = M.applyOlder(s, A1, { messages: [wire(A1, 3, AG1, "你好呀")], nextBefore: null });
    expect(s.runs[A1].posted).toBe(true);
    expect(s.streams).toEqual({});
  });
});

describe("Agents", () => {
  it("applyAgents replaces the list (deleted ones included) and names the Agent's principal as the Agent is named now", () => {
    let s = loaded();
    s = M.applyAgents(s, [agentOf(AG1, { name: "新名字", avatarVersion: 2 }), agentOf(AG2, { deleted: true, conversationId: A2 })]);
    expect(Object.keys(s.agents)).toEqual([AG1, AG2]);
    expect(s.agents[AG2].deleted).toBe(true);
    expect(s.principals[AG1]).toMatchObject({ displayName: "新名字", kind: "agent" });
    expect(s.avatarVersions[AG1]).toBe(2);
    s = M.applyAgents(s, [agentOf(AG1)]);
    expect(Object.keys(s.agents)).toEqual([AG1]);
  });

  it("applyAgent adds or replaces one Agent; its avatar version only goes up; dropAgent forgets it", () => {
    let s = M.applyAgent(loaded(), agentOf(AG1, { avatarVersion: 3, paused: true }));
    expect(s.agents[AG1].paused).toBe(true);
    s = M.applyAgent(s, agentOf(AG1, { avatarVersion: 2 }));
    expect(s.avatarVersions[AG1]).toBe(3);
    s = M.applyAgent(s, agentOf(AG2, { conversationId: A2 }));
    expect(Object.keys(s.agents)).toEqual([AG1, AG2]);
    expect(s.principals[AG2]).toMatchObject({ id: AG2, handle: "helper", displayName: "小助手", kind: "agent" });
    expect(M.dropAgent(s, AG2).agents[AG2]).toBeUndefined();
  });

  it("keeps the conversation's Agent and its paused and deleted flags", () => {
    const s = loaded({ extra: [agentConv(A2, AG2, { agent: { paused: true, deleted: true }, canSend: { ok: false, reason: "agent_deleted" } })] });
    expect(s.conversations[A2]).toMatchObject({ type: "agent", agentId: AG2, agent: { paused: true, deleted: true }, peerId: null });
    expect(s.conversations[D1]).toMatchObject({ agentId: null, agent: null });
  });

  it("an Agent's principal keeps its owner when a later answer names it without one (an Agent's owner never changes)", () => {
    const OAG = "00000000-0000-4000-8000-0000000000b9";
    const bot = (fields = {}) => ({ ...agentPrincipal(OAG, "annbot", "安的助手"), ...fields });
    let s = M.applySync(M.initial(), syncOf([direct(D1, ANN)], [], [...PRINCIPALS, bot({ ownerId: ANN, intro: "记事" })]));
    expect(s.principals[OAG]).toMatchObject({ ownerId: ANN, intro: "记事" });
    s = M.applyPrincipals(s, { [OAG]: bot({ displayName: "新名字", intro: "" }) });
    expect(s.principals[OAG]).toMatchObject({ displayName: "新名字", ownerId: ANN, intro: "" });
    s = M.applySync(s, syncOf([direct(D1, ANN)], [], [...PRINCIPALS, bot()]));
    expect(s.principals[OAG].ownerId).toBe(ANN);
  });
});

describe("persona proposal cards", () => {
  const P1 = "00000000-0000-4000-8000-0000000000f7";
  const proposed = (status) => wire(A1, 3, AG1, "", { proposal: { id: P1, status, persona: "你是小助手。" } });

  it("applyMessageUpdate replaces a held message, never adds one", () => {
    let s = M.applyMessage(loaded(), proposed("open")).state;
    s = M.applyMessageUpdate(s, proposed("superseded"));
    expect(s.messages[A1].find((m) => m.seq === 3).proposal.status).toBe("superseded");
    expect(M.applyMessageUpdate(s, wire(A1, 9, AG1, "x"))).toBe(s);
  });

  /** A1 holds seqs 31–40 (the newest page); a detached window around the old proposal at seq 3 is open. */
  function withWindow() {
    const later = Array.from({ length: 10 }, (_, i) => wire(A1, 31 + i, i % 2 ? AG1 : ME_ID));
    let s = M.applyAgents(M.applySync(M.initial(), syncOf([agentConv(A1, AG1, { lastSeq: 40, readSeq: 40 })], later, [...PRINCIPALS, agentPrincipal()])), [agentOf()]);
    s = M.applyMessage(s, wire(A1, 41, AG1, "新的", { proposal: { id: "p2", status: "open", persona: "y" } })).state;
    return M.openWindow(s, A1, { messages: [wire(A1, 2, ME_ID), proposed("open")], nextBefore: null }, { focusSeq: 3, n: 1 });
  }

  it("applyMessageUpdate also replaces the copy shown in a detached window", () => {
    const s = M.applyMessageUpdate(withWindow(), proposed("stale"));
    expect(s.windows[A1].messages.find((m) => m.seq === 3).proposal.status).toBe("stale");
    expect(s.messages[A1].some((m) => m.seq === 3)).toBe(false);
  });

  it("openProposals lists an Agent's cards still open, held and in a window; other statuses cannot change any more", () => {
    let s = withWindow();
    s = M.applyMessage(s, wire(A1, 42, AG1, "旧的", { proposal: { id: "p0", status: "confirmed", persona: "x" } })).state;
    expect(M.openProposals(s, AG1)).toEqual({ conversationId: A1, seqs: [3, 41] });
    expect(M.openProposals(s, AG2)).toEqual({ conversationId: null, seqs: [] });
  });

  it("setProposalStatus marks one proposal's card", () => {
    const s = M.setProposalStatus(M.applyMessage(loaded(), proposed("open")).state, A1, P1, "confirmed");
    expect(s.messages[A1].find((m) => m.seq === 3).proposal).toEqual({ id: P1, status: "confirmed", persona: "你是小助手。" });
  });
});

describe("a message I made over HTTP (the new-topic notice)", () => {
  it("applyPosted adds it and advances when it is next, and keeps it beyond a gap", () => {
    const topic = notice(A1, 3, "Mei 开始了新话题", { event: "topic_reset", actorId: ME_ID });
    const s = M.applyPosted(loaded(), topic);
    expect(s.messages[A1].map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(s.conversations[A1].position).toBe(3);
    const far = M.applyPosted(loaded(), { ...topic, seq: 5 });
    expect(far.messages[A1].map((m) => m.seq)).toEqual([1, 2, 5]);
    expect(far.conversations[A1].position).toBe(2);
  });
});

describe("providers, usage and site models", () => {
  const provider = (fields = {}) => ({
    id: "00000000-0000-4000-8000-0000000000aa",
    name: "我的 OpenAI",
    protocol: "openai_chat",
    baseUrl: "https://api.example.com/v1",
    keyLast4: "wxyz",
    models: [{ name: "gpt-x", vision: true, pdf: false, reasoning: false, contextTokens: 16000 }],
    ...fields,
  });

  it("keeps only a provider's public fields (never a key, whatever an answer carries)", () => {
    const s = M.applyProvider(M.initial(), provider({ apiKey: "sk-secret-abcdefgh", key: "sk-secret-abcdefgh" }));
    expect(JSON.stringify(s)).not.toContain("sk-secret");
    expect(s.providers["00000000-0000-4000-8000-0000000000aa"]).toEqual(provider());
  });

  it("applyProviders replaces the list in order; removeProvider drops one", () => {
    const B = "00000000-0000-4000-8000-0000000000ab";
    let s = M.applyProviders(M.initial(), [provider(), provider({ id: B, name: "第二个" })]);
    expect(Object.keys(s.providers)).toEqual(["00000000-0000-4000-8000-0000000000aa", B]);
    s = M.removeProvider(s, B);
    expect(Object.keys(s.providers)).toEqual(["00000000-0000-4000-8000-0000000000aa"]);
  });

  it("applyUsage keeps the answer (points stay strings); applyModels keeps the site models and the provider defaults", () => {
    const usage = { tier: "free", agentLimit: 20, agentCount: 1, balance: "12.5", free: { allowance: "10", used: "2.25", resetsAt: "2026-11-16T16:00:00.000Z" }, canStartFreeReply: true, recent: [] };
    expect(M.applyUsage(M.initial(), usage).usage).toEqual(usage);
    const s = M.applyModels(M.initial(), {
      siteModels: [{ id: "free-1", label: "免费模型", tier: "free", vision: false, pdf: false, reasoning: ["low"], contextTokens: 32000, upstream: "secret" }],
      providerDefaults: { contextTokens: 16000, maxOutputTokens: 2048 },
    });
    expect(s.siteModels).toEqual([{ id: "free-1", label: "免费模型", tier: "free", vision: false, pdf: false, reasoning: ["low"], contextTokens: 32000 }]);
    expect(s.providerDefaults).toEqual({ contextTokens: 16000, maxOutputTokens: 2048 });
  });

  it("applyModels keeps whether the site can judge for proactive replies: only a true counts, and the view says it — null until the models answered", () => {
    const answer = (extra) => ({ siteModels: [], providerDefaults: { contextTokens: 16000, maxOutputTokens: 2048 }, ...extra });
    expect(view(M.initial()).proactiveAvailable).toBeNull();
    expect(view(M.applyModels(M.initial(), answer({ proactiveAvailable: true }))).proactiveAvailable).toBe(true);
    expect(view(M.applyModels(M.initial(), answer({ proactiveAvailable: "yes" }))).proactiveAvailable).toBe(false);
    expect(view(M.applyModels(M.applyModels(M.initial(), answer({ proactiveAvailable: true })), answer())).proactiveAvailable).toBe(false);
  });

  it("applyModels keeps how far back turning memory on again looks (memoryCatchUp), only as whole numbers; null until said", () => {
    const answer = (extra) => ({ siteModels: [], providerDefaults: { contextTokens: 16000, maxOutputTokens: 2048 }, ...extra });
    expect(view(M.initial()).memoryCatchUp).toBeNull();
    expect(view(M.applyModels(M.initial(), answer({ memoryCatchUp: { days: 30, lines: 200 } }))).memoryCatchUp).toEqual({ days: 30, lines: 200 });
    for (const bad of [{ days: "30", lines: 200 }, { days: 30 }, { days: 0, lines: 200 }, { days: 1.5, lines: 200 }, null, "30/200"]) {
      expect([bad, view(M.applyModels(M.initial(), answer({ memoryCatchUp: bad }))).memoryCatchUp]).toEqual([bad, null]);
    }
  });

  it("an Agent's proactive settings come only as the service says them, and a malformed one is not kept", () => {
    const agentOfView = (fields) => Object.values(view(M.applyAgent(M.initial(), { id: "00000000-0000-4000-8000-0000000000a1", handle: "h", name: "n", ...fields })).agents)[0];
    expect(agentOfView({})).not.toHaveProperty("proactive");
    expect(agentOfView({ proactive: true, proactiveLevel: "more", proactiveBudget: "70" })).toMatchObject({
      proactive: true,
      proactiveLevel: "more",
      proactiveBudget: "70",
    });
    // What its proactive replies cost today is the service's, to the owner (a string), and nothing else is kept.
    expect(agentOfView({ proactive: true, proactiveSpentToday: "1.5" })).toMatchObject({ proactiveSpentToday: "1.5" });
    const odd = agentOfView({ proactive: "yes", proactiveLevel: "loud", proactiveBudget: 20, proactiveSpentToday: 1.5 });
    for (const key of ["proactive", "proactiveLevel", "proactiveBudget", "proactiveSpentToday"]) expect(odd).not.toHaveProperty(key);
  });
});

describe("an Agent's reply in a group (batch 2C)", () => {
  const OAG = "00000000-0000-4000-8000-0000000000b9"; // 小安's Agent
  const annBot = { ...agentPrincipal(OAG, "annbot", "安的助手"), ownerId: ANN };
  const member = (id, isCreator = false) => ({ id, role: "speaker", isCreator });
  const groupWith = (ids, fields = {}) => group(G1, { members: ids.map((id, i) => member(id, i === 0)), lastSeq: 2, readSeq: 2, ...fields });
  const BASE = [wire(G1, 1, ANN, "@helper @annbot 在吗"), wire(G1, 2, ME_ID, "嗯")];
  /** G1 with me, 小安, my 小助手 (AG1) and 小安's 安的助手 (OAG); my Agent's own conversation A1; a direct chat. */
  function inGroup({ ids = [ME_ID, ANN, AG1, OAG], messages = BASE } = {}) {
    const lastSeq = messages.reduce((max, m) => Math.max(max, m.seq), 0);
    const sync = syncOf([groupWith(ids, { lastSeq, readSeq: lastSeq }), agentConv(A1, AG1), direct(D1, ANN)], messages, [
      ...PRINCIPALS,
      { ...agentPrincipal(), ownerId: ME_ID },
      annBot,
    ]);
    return M.applyAgents(M.applySync(M.initial(), sync), [agentOf()]);
  }
  /** The push the owner gets, and the one everyone else gets. */
  const ownerPush = (run, agentId = AG1) => ({ type: "run", conversationId: G1, agentId, run });
  const memberPush = (state, agentId = OAG) => ({ type: "run", conversationId: G1, agentId, state });
  const put = (s, push) => M.applyGroupRun(s, G1, push.agentId, push);
  const rows = (s) => view(s).convs[G1].agentRuns;
  const failed = runOf(R1, "failed", { error: "busy", retryable: true });

  it("the owner's push holds the run, anyone else's only the state; the Agent's own conversation is untouched and nothing streams", () => {
    let s = put(inGroup(), ownerPush(runOf(R1, "running")));
    s = put(s, memberPush("replying"));
    expect(rows(s)).toEqual([
      { agentId: AG1, mine: true, kind: "replying", run: { id: R1, status: "running", retryable: false } },
      { agentId: OAG, mine: false, kind: "replying" },
    ]);
    expect(s.runs).toEqual({});
    expect(view(s).convs[A1].run).toBeNull();
    expect(M.applyDelta(s, { conversationId: G1, runId: R1, text: "不该出现" })).toBe(s);
    expect(s.streams).toEqual({});
    s = put(s, memberPush("unavailable"));
    expect(rows(s)[1]).toEqual({ agentId: OAG, mine: false, kind: "unavailable" });
    s = put(s, memberPush(null));
    expect(rows(s).map((r) => r.agentId)).toEqual([AG1]);
    // A dedicated conversation's run is still kept by its conversation, beside the group's.
    s = M.applyRun(s, A1, runOf(R2, "running"));
    expect(s.runs[A1]).toMatchObject({ id: R2 });
    expect(rows(s)).toHaveLength(1);
  });

  it("someone else's Agent never holds a run, whatever a malformed push carries: only `state` is read", () => {
    const base = inGroup();
    const leaky = { ...memberPush("unavailable"), run: runOf(R1, "failed", { error: "provider_rejected", resetsAt: at(30) }), error: "no_quota", retryable: true };
    const s = put(base, leaky);
    expect(s.groupRuns[G1][OAG].state).toBe("unavailable");
    expect(s.groupRuns[G1][OAG]).not.toHaveProperty("run");
    expect(rows(s)).toEqual([{ agentId: OAG, mine: false, kind: "unavailable" }]);
    for (const leak of [R1, "provider_rejected", "no_quota", "resetsAt", "retryable"]) expect(JSON.stringify(s.groupRuns)).not.toContain(leak);
    // A run without a state, or a state that is not one of the three: nothing at all.
    expect(put(base, { type: "run", conversationId: G1, agentId: OAG, run: runOf(R1, "running") })).toBe(base);
    expect(put(base, memberPush("thinking"))).toBe(base);
    expect(M.applyGroupRun(base, G1, undefined, memberPush("replying"))).toBe(base);
    // An answer carrying one for someone else's Agent: the same.
    const answered = M.applyGroupRuns(base, G1, { runs: [{ agentId: OAG, state: "unavailable", run: runOf(R1, "failed", { error: "no_quota" }) }] });
    for (const leak of [R1, "no_quota"]) expect(JSON.stringify(answered.groupRuns)).not.toContain(leak);
    expect(rows(answered)).toEqual([{ agentId: OAG, mine: false, kind: "unavailable" }]);
  });

  it("the store never keeps someone else's Agent's thinking in a group; mine keeps it; it stays while the sender is unknown", () => {
    const base = inGroup();
    const think = (seq, sender) => wire(G1, seq, sender, "答", { reasoning: "想" });
    const s = M.applyMessage(M.applyMessage(base, think(3, OAG)).state, think(4, AG1)).state;
    expect(s.messages[G1].find((m) => m.seq === 3)).not.toHaveProperty("reasoning");
    expect(s.messages[G1].find((m) => m.seq === 4).reasoning).toBe("想");
    // History pages and a window: the same rule.
    const older = M.applyOlder(base, G1, { messages: [think(0, OAG), think(-1, AG1)], nextBefore: null });
    expect(older.messages[G1].find((m) => m.seq === 0)).not.toHaveProperty("reasoning");
    expect(older.messages[G1].find((m) => m.seq === -1).reasoning).toBe("想");
    // A sender whose principal has not arrived: kept (the view hides it).
    const LATE = "00000000-0000-4000-8000-0000000000b8";
    const unknown = M.applyMessage(base, think(3, LATE)).state;
    expect(unknown.messages[G1].find((m) => m.seq === 3).reasoning).toBe("想");
    // A sync carrying it: dropped the same way.
    const sync = syncOf([groupWith([ME_ID, ANN, AG1, OAG], { lastSeq: 4, readSeq: 4 })], [...BASE, think(3, OAG), think(4, AG1)], [
      ...PRINCIPALS,
      { ...agentPrincipal(), ownerId: ME_ID },
      annBot,
    ]);
    const synced = M.applySync(M.initial(), sync);
    expect(synced.messages[G1].find((m) => m.seq === 3)).not.toHaveProperty("reasoning");
    expect(synced.messages[G1].find((m) => m.seq === 4).reasoning).toBe("想");
  });

  it("the store never keeps someone else's Agent's via in a group, pushed, paged or synced; mine keeps it; it stays while the sender is unknown", () => {
    const base = inGroup();
    const VIA = { model: { source: "site", id: "gpt-6-sol", label: "GPT-6 Sol" }, reasoning: "medium", points: "6.9" };
    const charged = (seq, sender) => wire(G1, seq, sender, "答", { reasoning: "想", via: VIA });
    const s = M.applyMessage(M.applyMessage(base, charged(3, OAG)).state, charged(4, AG1)).state;
    expect(s.messages[G1].find((m) => m.seq === 3)).not.toHaveProperty("via");
    expect(s.messages[G1].find((m) => m.seq === 3)).not.toHaveProperty("reasoning");
    expect(s.messages[G1].find((m) => m.seq === 4).via).toEqual(VIA);
    expect(JSON.stringify(s.messages[G1].find((m) => m.seq === 3))).not.toContain("GPT-6 Sol");
    const older = M.applyOlder(base, G1, { messages: [charged(0, OAG), charged(-1, AG1)], nextBefore: null });
    expect(older.messages[G1].find((m) => m.seq === 0)).not.toHaveProperty("via");
    expect(older.messages[G1].find((m) => m.seq === -1).via).toEqual(VIA);
    const LATE = "00000000-0000-4000-8000-0000000000b8";
    expect(M.applyMessage(base, charged(3, LATE)).state.messages[G1].find((m) => m.seq === 3).via).toEqual(VIA);
    const sync = syncOf([groupWith([ME_ID, ANN, AG1, OAG], { lastSeq: 4, readSeq: 4 })], [...BASE, charged(3, OAG), charged(4, AG1)], [
      ...PRINCIPALS,
      { ...agentPrincipal(), ownerId: ME_ID },
      annBot,
    ]);
    const synced = M.applySync(M.initial(), sync);
    expect(synced.messages[G1].find((m) => m.seq === 3)).not.toHaveProperty("via");
    expect(synced.messages[G1].find((m) => m.seq === 4).via).toEqual(VIA);
  });

  it("my Agent's reply pushed again once its run is charged replaces the copy held (and a window's), now with its via; someone else's Agent's changes nothing", () => {
    const VIA = { model: { source: "provider", model: "claude-x" }, reasoning: "high", points: "0" };
    let s = put(inGroup(), ownerPush(runOf(R1, "running")));
    s = M.applyMessage(s, wire(G1, 3, AG1, "周六十点", { reasoning: "想" })).state;
    expect(s.messages[G1].find((m) => m.seq === 3)).not.toHaveProperty("via");
    const position = s.conversations[G1].position;
    const again = M.applyMessage(s, wire(G1, 3, AG1, "周六十点", { reasoning: "想", via: VIA }));
    expect(again.gap).toBeUndefined();
    expect(again.state.messages[G1].find((m) => m.seq === 3).via).toEqual(VIA);
    expect(again.state.conversations[G1]).toMatchObject({ position, unread: s.conversations[G1].unread });
    expect(again.state.messages[G1].filter((m) => m.seq === 3)).toHaveLength(1);
    // A detached window holding it gets the charged copy too.
    const windowed = { ...s, windows: { ...s.windows, [G1]: { messages: [wire(G1, 3, AG1, "周六十点", { reasoning: "想" })] } } };
    const inWindow = M.applyMessage(windowed, wire(G1, 3, AG1, "周六十点", { reasoning: "想", via: VIA })).state;
    expect(inWindow.windows[G1].messages[0].via).toEqual(VIA);
    // A copy without via, or one from someone else's Agent, replaces nothing.
    expect(M.applyMessage(again.state, wire(G1, 3, AG1, "周六十点", { reasoning: "想" })).state.messages[G1].find((m) => m.seq === 3).via).toEqual(VIA);
    const theirs = M.applyMessage(again.state, wire(G1, 4, OAG, "周日", {})).state;
    const theirsAgain = M.applyMessage(theirs, wire(G1, 4, OAG, "周日", { via: VIA })).state;
    expect(theirsAgain.messages[G1].find((m) => m.seq === 4)).not.toHaveProperty("via");
    // A page or catch-up copy is not a push: nothing is replaced by it.
    expect(M.applyMessage(s, wire(G1, 3, AG1, "周六十点", { via: VIA }), { pushed: false }).state).toBe(s);
  });

  it("an Agent's slot clears when its reply arrives; someone else's message does not clear it; a new run shows again", () => {
    let s = put(put(inGroup(), ownerPush(runOf(R1, "running"))), memberPush("replying"));
    s = M.applyMessage(s, wire(G1, 3, ANN, "还有我")).state;
    expect(rows(s)).toHaveLength(2);
    s = M.applyMessage(s, wire(G1, 4, OAG, "在的")).state;
    expect(rows(s).map((r) => r.agentId)).toEqual([AG1]);
    s = M.applyMessage(s, wire(G1, 5, AG1, "我也在")).state;
    expect(rows(s)).toEqual([]);
    // The pushes that end the runs after their messages change nothing shown.
    s = put(put(s, ownerPush(runOf(R1, "done"))), memberPush(null));
    expect(rows(s)).toEqual([]);
    s = put(put(s, ownerPush(runOf(R2, "queued"))), memberPush("replying"));
    expect(rows(s).map((r) => r.kind)).toEqual(["replying", "replying"]);
    // A history page holding the reply, after the run was named: cleared too.
    s = M.applyOlder(s, G1, { messages: [wire(G1, 6, OAG, "好")], nextBefore: null });
    expect(rows(s).map((r) => r.agentId)).toEqual([AG1]);
  });

  it("a buffered push whose reply the snapshot already holds shows no row (its since is the lastSeq before)", () => {
    const s = M.applyGroupRun(inGroup({ messages: [...BASE, wire(G1, 3, OAG, "在的")] }), G1, OAG, memberPush("replying"), { since: 2 });
    expect(rows(s)).toEqual([]);
  });

  it("an Agent that leaves takes its slot with it: a pushed leave or removal notice, or a member list without it", () => {
    let s = put(put(inGroup(), memberPush("replying")), ownerPush(failed));
    s = M.applyMessage(s, notice(G1, 3, "小安将安的助手移出了群聊", { event: "member_removed", actorId: ANN, principalId: OAG })).state;
    expect(rows(s).map((r) => r.agentId)).toEqual([AG1]);
    s = M.applyConversation(s, groupWith([ME_ID, ANN]));
    expect(rows(s)).toEqual([]);
    let t = put(inGroup(), memberPush("replying"));
    t = M.applyMessage(t, notice(G1, 3, "安的助手退出了群聊", { event: "member_left", actorId: OAG, principalId: OAG, newCreatorId: null })).state;
    expect(rows(t)).toEqual([]);
    // A history page with an old leave notice takes nothing.
    const u = M.applyOlder(put(inGroup(), memberPush("replying")), G1, { messages: [notice(G1, 0, "x", { event: "member_left", actorId: OAG, principalId: OAG })], nextBefore: null });
    expect(rows(u)).toHaveLength(1);
  });

  it("the owner is told when the Agent was taken out while replying, or halted: neither offers a retry; other ends show nothing", () => {
    let s = put(inGroup(), ownerPush(runOf(R1, "running")));
    s = M.applyMessage(s, notice(G1, 3, "x", { event: "member_removed", actorId: ANN, principalId: AG1 })).state;
    s = M.applyConversation(s, groupWith([ME_ID, ANN, OAG]));
    s = put(s, ownerPush(runOf(R1, "cancelled", { error: "agent_removed" })));
    const removed = { agentId: AG1, mine: true, kind: "status", run: { id: R1, status: "cancelled", retryable: false, error: "agent_removed" } };
    expect(rows(s)).toEqual([removed]);
    // (A later refresh of the member list keeps it until I close it.)
    s = M.applyConversation(s, groupWith([ME_ID, ANN, OAG]));
    expect(rows(s)).toEqual([removed]);
    expect(rows(M.dismissGroupRunOf(s, G1, AG1, R1))).toEqual([]);
    const halted = put(inGroup(), ownerPush(runOf(R2, "cancelled", { error: "halted" })));
    expect(rows(halted)).toEqual([{ agentId: AG1, mine: true, kind: "status", run: { id: R2, status: "cancelled", retryable: false, error: "halted" } }]);
    for (const run of [runOf(R2, "cancelled", { error: "agent_paused" }), runOf(R2, "cancelled"), runOf(R2, "done"), runOf(R2, "stopped")]) {
      expect(rows(put(inGroup(), ownerPush(run))), run.status).toEqual([]);
    }
  });

  it("GET …/runs fills what this connection's pushes did not name; what it leaves out has nothing to show", () => {
    const answer = { runs: [{ agentId: AG1, state: "unavailable", run: failed }, { agentId: OAG, state: "replying" }] };
    let s = M.applyGroupRuns(inGroup(), G1, answer);
    expect(rows(s)).toEqual([
      { agentId: AG1, mine: true, kind: "status", run: failed },
      { agentId: OAG, mine: false, kind: "replying" },
    ]);
    expect(s.groupRuns[G1][OAG].joined).toBe(true);
    // Pushes of this connection are never replaced by an answer (it may have been read before them).
    s = put(put(s, memberPush(null)), ownerPush(runOf(R2, "running")));
    const pushed = rows(s);
    expect(rows(M.applyGroupRuns(s, G1, answer))).toEqual(pushed);
    expect(rows(M.applyGroupRuns(s, G1, { runs: [] }))).toEqual(pushed);
    // The same run further on is taken.
    expect(rows(M.applyGroupRuns(s, G1, { runs: [{ agentId: AG1, state: null, run: runOf(R2, "done") }] }))).toEqual([]);
    // Known only from before a reconnect: the answer's word is taken, its silence too.
    const before = M.clearStreams(put(inGroup(), memberPush("replying")));
    expect(before.groupRuns[G1][OAG].joined).toBe(true);
    expect(rows(M.applyGroupRuns(before, G1, { runs: [] }))).toEqual([]);
    // Malformed answers change nothing.
    for (const bad of [null, {}, { runs: "x" }, { runs: [null, { agentId: 3, state: "replying" }] }]) expect(M.applyGroupRuns(before, G1, bad)).toBe(before);
  });

  it("a dismissed failure does not come back with a late answer; the next run shows", () => {
    let s = M.dismissGroupRunOf(put(inGroup(), ownerPush(failed)), G1, AG1, R1);
    expect(rows(s)).toEqual([]);
    s = M.applyGroupRuns(s, G1, { runs: [{ agentId: AG1, state: "unavailable", run: failed }] });
    expect(rows(s)).toEqual([]);
    expect(rows(put(s, ownerPush(runOf(R2, "queued"))))).toMatchObject([{ agentId: AG1, kind: "replying" }]);
  });

  it("a pushed end of another run while my Agent's reply is queued or running is an older frame (a failed told reply's slot pushed again late): the slot keeps the reply; once that has ended, or is not known for sure, frames apply as ever", () => {
    const late = ownerPush(runOf(R1, "failed", { error: "busy", retryable: false }));
    for (const status of ["queued", "running"]) {
      const s = put(inGroup(), ownerPush(runOf(R2, status)));
      expect([status, put(s, late)]).toEqual([status, s]);
      expect(rows(put(s, late))).toMatchObject([{ agentId: AG1, kind: "replying", run: { id: R2, status } }]);
    }
    // Its own end applies; after it, another run's frame applies too.
    let s = put(put(inGroup(), ownerPush(runOf(R2, "running"))), ownerPush(runOf(R2, "done")));
    expect(s.groupRuns[G1][AG1].run).toMatchObject({ id: R2, status: "done" });
    s = put(s, ownerPush(failed));
    expect(s.groupRuns[G1][AG1].run).toMatchObject({ id: R1, status: "failed" });
    // A new reply (another run, active) replaces the one held, as ever.
    s = put(put(inGroup(), ownerPush(runOf(R1, "running"))), ownerPush(runOf(R2, "queued")));
    expect(s.groupRuns[G1][AG1].run).toMatchObject({ id: R2, status: "queued" });
    // Held but not known for sure (it could not be fetched): any frame says what it is.
    s = M.markGroupRunsUnknown(put(inGroup(), ownerPush(runOf(R2, "running"))), G1);
    expect(put(s, late).groupRuns[G1][AG1].run).toMatchObject({ id: R1, status: "failed" });
  });

  it("runs that could not be fetched are not shown as replying until a push or an answer says what they are", () => {
    let s = M.clearStreams(put(put(inGroup(), memberPush("replying")), ownerPush(runOf(R1, "queued"))));
    s = M.markGroupRunsUnknown(s, G1);
    expect(rows(s)).toEqual([]);
    expect(M.markGroupRunsUnknown(s, G1)).toBe(s);
    s = M.applyGroupRuns(s, G1, { runs: [{ agentId: OAG, state: "replying" }] });
    expect(rows(s)).toEqual([{ agentId: OAG, mine: false, kind: "replying" }]);
    expect(rows(put(s, ownerPush(runOf(R1, "running"))))).toHaveLength(2);
  });

  it("gone, or a sync that no longer lists the group, drops its slots; a reconnect keeps them as known from before", () => {
    const s = put(put(inGroup(), memberPush("replying")), ownerPush(runOf(R1, "running")));
    expect(M.applyGone(s, G1).groupRuns[G1]).toBeUndefined();
    const sync = syncOf([agentConv(A1, AG1), direct(D1, ANN)], [], [...PRINCIPALS, agentPrincipal(), annBot]);
    expect(M.applySync(s, sync).groupRuns[G1]).toBeUndefined();
    const again = M.clearStreams(s);
    expect(Object.values(again.groupRuns[G1]).every((slot) => slot.joined && !("since" in slot))).toBe(true);
    expect(rows(again)).toHaveLength(2);
    // What a slot's tool was doing is forgotten too (mine and someone else's alike).
    const busy = put(put(inGroup(), { ...memberPush("replying"), activity: "file" }), { ...ownerPush(runOf(R1, "running")), activity: "search" });
    expect(Object.values(busy.groupRuns[G1]).map((slot) => slot.activity)).toEqual(expect.arrayContaining(["file", "search"]));
    expect(Object.values(M.clearStreams(busy).groupRuns[G1]).some((slot) => "activity" in slot)).toBe(false);
  });

  it("several Agents: one row each, in the group's member order, whatever order their pushes came in", () => {
    let s = inGroup({ ids: [ME_ID, OAG, ANN, AG1] });
    s = put(put(s, ownerPush(runOf(R1, "running"))), memberPush("replying"));
    expect(rows(s).map((r) => r.agentId)).toEqual([OAG, AG1]);
  });

  it("Agents talking: the newest message an Agent's whose stored mentions mean another Agent of the group, or an Agent's with a reply under way; never a person's", () => {
    /** Who a message means, as the service stored it when it was posted (Task M). */
    const means = (id, start, length) => ({ mentions: [{ id, start, length }] });
    const talking = (messages) => view(inGroup({ messages: [...BASE, ...messages] })).convs[G1].agentsTalking;
    expect(view(inGroup()).convs[G1].agentsTalking).toBe(false);
    // A reply under way after a person's message (an @-mention of an Agent, say) is the person's ask: no.
    expect(view(put(inGroup(), memberPush("replying"))).convs[G1].agentsTalking).toBe(false);
    expect(view(put(inGroup({ messages: [...BASE, wire(G1, 3, ANN, "@annbot 你好")] }), memberPush("replying"))).convs[G1].agentsTalking).toBe(false);
    expect(view(put(inGroup(), memberPush("unavailable"))).convs[G1].agentsTalking).toBe(false);
    // An Agent's newest message and a reply under way (whatever it says): Agents answering each other.
    expect(view(put(inGroup({ messages: [...BASE, wire(G1, 3, OAG, "好的")] }), memberPush("replying"))).convs[G1].agentsTalking).toBe(true);
    expect(view(put(inGroup({ messages: [...BASE, wire(G1, 3, OAG, "好的")] }), memberPush("unavailable"))).convs[G1].agentsTalking).toBe(false);
    expect(talking([wire(G1, 3, OAG, "问问 @helper 吧", means(AG1, 3, 7))])).toBe(true);
    expect(talking([wire(G1, 3, OAG, "@小助手，你来", means(AG1, 0, 4))])).toBe(true);
    expect(talking([wire(G1, 3, AG1, "@annbot", means(OAG, 0, 7))])).toBe(true);
    // The text alone is not read: an @ the service stored nothing for (a longer handle, an address, two of one name) is no call.
    expect(talking([wire(G1, 3, OAG, "问问 @helper 吧")])).toBe(false);
    // Itself, a person, a person's message, a notice after it: no.
    expect(talking([wire(G1, 3, OAG, "我是 @annbot", means(OAG, 3, 7))])).toBe(false);
    expect(talking([wire(G1, 3, OAG, "@ann 你好", means(ANN, 0, 4))])).toBe(false);
    expect(talking([wire(G1, 3, ANN, "@helper 你好", means(AG1, 0, 7))])).toBe(false);
    expect(talking([wire(G1, 3, OAG, "@helper", means(AG1, 0, 7)), notice(G1, 4, "x", { event: "agent_chain_paused", limit: 30 })])).toBe(false);
    // A system notice as the newest message hides the button even while a row is replying.
    const noticeLast = inGroup({ messages: [...BASE, wire(G1, 3, OAG, "@helper", means(AG1, 0, 7)), notice(G1, 4, "x", { event: "agent_chain_paused", limit: 30 })] });
    expect(view(put(noticeLast, memberPush("replying"))).convs[G1].agentsTalking).toBe(false);
    expect(view(put(put(noticeLast, memberPush("replying")), ownerPush(runOf(R1, "running")))).convs[G1].agentsTalking).toBe(false);
    // An Agent that is not (or no longer) in the group is nobody to call.
    expect(view(inGroup({ ids: [ME_ID, ANN, OAG], messages: [...BASE, wire(G1, 3, OAG, "@helper", means(AG1, 0, 7))] })).convs[G1].agentsTalking).toBe(false);
    // Only a group has it.
    expect(view(inGroup()).convs[A1].agentsTalking).toBe(false);
    expect(view(inGroup()).convs[A1].agentRuns).toEqual([]);
  });
});

describe("avatar versions", () => {
  it("come from /api/sync (me and every principal) and from principal pushes", () => {
    const sync = syncOf([direct(D1, ANN)], [], [{ ...PRINCIPALS[1], avatarVersion: 4 }, agentPrincipal(AG1)]);
    let s = M.applySync(M.initial(), { ...sync, me: { ...sync.me, avatarVersion: 2 } });
    expect(s.avatarVersions).toMatchObject({ [ME_ID]: 2, [ANN]: 4, [AG1]: 0 });
    s = M.setAvatarVersion(s, ANN, 5);
    expect(s.avatarVersions[ANN]).toBe(5);
  });

  it("bumpAvatar gives my own avatar a new version at once (batch 1), or the next one for an Agent of mine", () => {
    let s = loaded();
    s = M.bumpAvatar(s, NOW);
    expect(s.avatarVersions[ME_ID]).toBe(NOW);
    s = M.bumpAvatar(s, 0, AG1);
    expect(s.avatarVersions[AG1]).toBe(1);
  });
});
