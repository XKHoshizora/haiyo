// The sync engine's Agent pushes (agent, principal, run, delta) and what every connection loads for Agents.
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyOlder, initial } from "../src/data/model.js";
import { RUN_FETCHES, RUN_RETRY_MS, start } from "../src/data/sync.js";
import { toView } from "../src/data/viewmodel.js";
import { ME } from "../src/data/identities.js";
import {
  A1,
  A2,
  AG1,
  AG2,
  ANN,
  D1,
  G1,
  ME_ID,
  PRINCIPALS,
  agentConv,
  agentOf,
  agentPrincipal,
  apiError,
  deferred,
  direct,
  fakeTimers,
  group,
  fakeTransport,
  range,
  runOf,
  settle,
  syncOf,
  wire,
} from "./fixtures.js";

const R1 = "00000000-0000-4000-8000-0000000000e1";
const R2 = "00000000-0000-4000-8000-0000000000e2";
const P1 = "00000000-0000-4000-8000-0000000000f7";
const P0 = "00000000-0000-4000-8000-0000000000f6";

let engines = [];
afterEach(() => {
  for (const e of engines) e.stop();
  engines = [];
});

function run(transport, { onModel = () => {} } = {}) {
  const box = { model: initial() };
  const timers = fakeTimers();
  const onSignedOut = vi.fn();
  const statuses = [];
  const engine = start(transport, {
    getModel: () => box.model,
    setModel: (m) => {
      box.model = m;
      onModel(m);
    },
    timers,
    now: timers.now,
    random: () => 0.5,
    onSignedOut,
    onStatus: (s) => statuses.push(s),
  });
  engines.push(engine);
  return { box, timers, engine, onSignedOut, statuses };
}

/** Records every model the engine sets in which the bubble and the stored reply (A1, `seq`) are shown at once. */
function bothShown(seq) {
  const seen = [];
  const onModel = (m) => {
    const conv = toView(m, { now: 0 }).convs[A1];
    if (conv?.stream && conv.messages.some((x) => x.seq === seq)) seen.push(conv.stream);
  };
  return { seen, onModel };
}

const card = (seq, status, id = P1) => wire(A1, seq, AG1, "", { proposal: { id, status, persona: "你是小助手。" } });

/** Two Agents of mine (their conversations A1 and A2) and a direct chat with Ann. */
function agentsSync() {
  const principals = [...PRINCIPALS, agentPrincipal(AG1, "helper", "小助手"), agentPrincipal(AG2, "writer", "写作助手")];
  return syncOf(
    [agentConv(A1, AG1, { lastSeq: 3, readSeq: 3 }), agentConv(A2, AG2), direct(D1, ANN, { lastSeq: 1, readSeq: 1 })],
    [wire(A1, 1, ME_ID, "在吗"), card(2, "open"), card(3, "confirmed", P0), wire(D1, 1, ANN)],
    principals,
  );
}

function agentsTransport(handlers = {}) {
  return fakeTransport({
    sync: agentsSync,
    agents: () => ({ agents: [agentOf(AG1), agentOf(AG2, { handle: "writer", name: "写作助手", conversationId: A2 })] }),
    run: (id) => ({ run: id === A1 ? runOf(R1, "running") : null }),
    ...handlers,
  });
}

const runCalls = (t) => t.agentLog.filter((x) => Array.isArray(x) && x[0] === "run").map((x) => x[1]);

describe("every connection", () => {
  it("first load: the Agents, the run of every Agent conversation once, and the site models", async () => {
    const t = agentsTransport({
      models: () => ({ siteModels: [{ id: "free-1", label: "免费模型", tier: "free", vision: false, pdf: false, reasoning: [], contextTokens: 32000 }], providerDefaults: { contextTokens: 16000, maxOutputTokens: 2048 } }),
    });
    const { box } = run(t);
    await settle();
    expect(t.log).toEqual(["connect", "sync", "social"]);
    expect(t.agentLog.filter((x) => x === "agents")).toHaveLength(1);
    expect(runCalls(t).sort()).toEqual([A1, A2].sort());
    expect(t.agentLog.filter((x) => x === "models")).toHaveLength(1);
    expect(Object.keys(box.model.agents)).toEqual([AG1, AG2]);
    // Known from an answer, not from a push of this connection: shown as replying, never streamed.
    expect(box.model.runs).toEqual({ [A1]: { ...runOf(R1, "running"), joined: true }, [A2]: null });
    expect(box.model.siteModels.map((m) => m.id)).toEqual(["free-1"]);
    // Nothing on the first load asks for single messages: everything is fresh.
    expect(t.agentLog.some((x) => Array.isArray(x) && x[0] === "message")).toBe(false);
  });

  it("a reconnect clears every stream and asks for the run of each Agent conversation once more; the site models are not asked again", async () => {
    const t = agentsTransport({ run: () => ({ run: null }) });
    const { box, timers } = run(t);
    await settle();
    t.socket.emit({ type: "run", conversationId: A1, run: runOf(R1, "running") });
    t.socket.emit({ type: "delta", conversationId: A1, runId: R1, text: "你好" });
    expect(box.model.streams).toEqual({ [R1]: { text: "你好", reasoning: "" } });

    t.handlers.run = (id) => ({ run: id === A1 ? runOf(R1, "running") : runOf(R2, "failed", { error: "busy", retryable: true }) });
    const held = deferred();
    t.handlers.sync = () => held.promise;
    t.socket.drop(1006);
    timers.advance(60_000);
    await settle();
    // Cleared as soon as the new socket opens: no text from before the break is shown again.
    expect(box.model.streams).toEqual({});
    held.resolve(agentsSync());
    await settle();
    expect(runCalls(t).filter((id) => id === A1)).toHaveLength(2);
    expect(runCalls(t).filter((id) => id === A2)).toHaveLength(2);
    expect(box.model.runs[A2]).toMatchObject({ id: R2, status: "failed" });
    expect(t.agentLog.filter((x) => x === "agents")).toHaveLength(2);
    expect(t.agentLog.filter((x) => x === "models")).toHaveLength(1);
    // The run is still going, but what it said before the break is not sent again: no bubble starts mid-sentence.
    t.socket.emit({ type: "delta", conversationId: A1, runId: R1, text: "呀" });
    expect(box.model.streams).toEqual({});
    expect(toView(box.model, { now: 0 }).convs[A1]).toMatchObject({ run: { id: R1, status: "running" }, stream: null });
    // The next reply, announced on this connection, streams from its first piece.
    t.socket.emit({ type: "run", conversationId: A1, run: runOf(R1, "done") });
    t.socket.emit({ type: "run", conversationId: A1, run: runOf(R2, "running") });
    t.socket.emit({ type: "delta", conversationId: A1, runId: R2, text: "好的" });
    expect(box.model.streams).toEqual({ [R2]: { text: "好的", reasoning: "" } });
  });

  it("an Agent conversation that appears in a later sync (an Agent made in another tab) has its run and its Agent loaded", async () => {
    const t = fakeTransport({ sync: () => syncOf([direct(D1, ANN)]) });
    const { box } = run(t);
    await settle();
    expect(runCalls(t)).toEqual([]);
    expect(t.agentLog.filter((x) => x === "agents")).toHaveLength(1);
    t.handlers.sync = agentsSync;
    t.handlers.agents = () => ({ agents: [agentOf(AG1), agentOf(AG2, { conversationId: A2 })] });
    t.socket.emit({ type: "conversation", id: A2 });
    await settle();
    expect(runCalls(t).sort()).toEqual([A1, A2].sort());
    expect(t.agentLog.filter((x) => x === "agents")).toHaveLength(2);
    expect(Object.keys(box.model.agents)).toEqual([AG1, AG2]);
    // A sync that brings nothing new asks for nothing more.
    t.socket.emit({ type: "message", message: wire("00000000-0000-4000-8000-0000000000c9", 1, ANN) });
    await settle();
    expect(runCalls(t)).toHaveLength(2);
    expect(t.agentLog.filter((x) => x === "agents")).toHaveLength(2);
  });

  it("a failed site-model list keeps what was there and does not stop the connection", async () => {
    const t = agentsTransport({
      models: () => {
        throw apiError(404, "not_found");
      },
    });
    const statuses = [];
    const box = { model: initial() };
    engines.push(start(t, { getModel: () => box.model, setModel: (m) => (box.model = m), timers: fakeTimers(), now: () => 0, random: () => 0.5, onStatus: (s) => statuses.push(s) }));
    await settle();
    expect(statuses.at(-1)).toBe("live");
    expect(box.model.siteModels).toEqual([]);
  });
});

describe("run and delta pushes", () => {
  it("a run push sets the conversation's run; a delta is appended only while that run is running", async () => {
    const t = agentsTransport({ run: () => ({ run: null }) });
    const { box } = run(t);
    await settle();
    t.socket.emit({ type: "delta", conversationId: A1, runId: R1, text: "鬼" });
    expect(box.model.streams).toEqual({});
    t.socket.emit({ type: "run", conversationId: A1, run: runOf(R1, "queued") });
    t.socket.emit({ type: "run", conversationId: A1, run: runOf(R1, "running") });
    t.socket.emit({ type: "delta", conversationId: A1, runId: R1, text: "你", reasoning: "想" });
    t.socket.emit({ type: "delta", conversationId: A1, runId: R1, text: "好" });
    expect(box.model.streams).toEqual({ [R1]: { text: "你好", reasoning: "想" } });
    t.socket.emit({ type: "message", message: wire(A1, 4, AG1, "你好") });
    expect(box.model.streams).toEqual({});
    t.socket.emit({ type: "run", conversationId: A1, run: runOf(R1, "done") });
    expect(box.model.runs[A1]).toMatchObject({ id: R1, status: "done" });
    t.socket.emit({ type: "delta", conversationId: A1, runId: R1, text: "！" });
    expect(box.model.streams).toEqual({});
  });

  it("malformed run and delta pushes change nothing", async () => {
    const t = agentsTransport();
    const { box } = run(t);
    await settle();
    const before = box.model;
    t.socket.emit({ type: "run", conversationId: A1 });
    t.socket.emit({ type: "run", conversationId: A1, run: { status: "done" } });
    t.socket.emit({ type: "delta", conversationId: A1 });
    t.socket.emit({ type: "principal", id: ANN, avatarVersion: "3" });
    expect(box.model).toBe(before);
  });

  it("gone clears the run and the stream of that conversation", async () => {
    const t = agentsTransport();
    const { box } = run(t);
    await settle();
    t.socket.emit({ type: "delta", conversationId: A1, runId: R1, text: "你" });
    t.socket.emit({ type: "gone", id: A1 });
    expect(box.model.runs[A1]).toBeUndefined();
    expect(box.model.streams).toEqual({});
  });
});

describe("an Agent's reply in a group (batch 2C)", () => {
  const OAG = "00000000-0000-4000-8000-0000000000b9"; // 小安's Agent
  const groupSync = () => {
    const base = agentsSync();
    const members = [ME_ID, ANN, AG1, OAG].map((id, i) => ({ id, role: "speaker", isCreator: i === 0 }));
    return syncOf(
      [group(G1, { members, lastSeq: 1, readSeq: 1 }), ...base.conversations],
      [wire(G1, 1, ANN, "@helper @annbot 在吗"), ...base.messages],
      [...base.principals, { ...agentPrincipal(OAG, "annbot", "安的助手"), ownerId: ANN }],
    );
  };
  const groupCalls = (t) => t.agentLog.filter((x) => Array.isArray(x) && x[0] === "groupRuns").map((x) => x[1]);
  const rows = (model) => toView(model, { now: 0 }).convs[G1].agentRuns;

  it("both push shapes, each kept by (group, Agent): the owner's run, anyone else's state; nothing streams; a dedicated push is as before", async () => {
    const t = agentsTransport({ sync: groupSync, run: () => ({ run: null }) });
    const { box } = run(t);
    await settle();
    t.socket.emit({ type: "run", conversationId: G1, agentId: AG1, run: runOf(R1, "running") });
    t.socket.emit({ type: "run", conversationId: G1, agentId: OAG, state: "replying" });
    t.socket.emit({ type: "delta", conversationId: G1, runId: R1, text: "不该出现" });
    t.socket.emit({ type: "run", conversationId: A1, run: runOf(R2, "running") });
    expect(rows(box.model)).toEqual([
      { agentId: AG1, mine: true, kind: "replying", run: runOf(R1, "running") },
      { agentId: OAG, mine: false, kind: "replying" },
    ]);
    expect(box.model.runs[A1]).toMatchObject({ id: R2, status: "running" });
    expect(box.model.runs[G1]).toBeUndefined();
    expect(box.model.streams).toEqual({});
    // A push to a member that (wrongly) carries the run's details: only its state is kept.
    t.socket.emit({ type: "run", conversationId: G1, agentId: OAG, state: "unavailable", run: runOf(P1, "failed", { error: "provider_rejected" }) });
    expect(rows(box.model)[1]).toEqual({ agentId: OAG, mine: false, kind: "unavailable" });
    expect(JSON.stringify(box.model.groupRuns)).not.toMatch(/provider_rejected|f7/);
    // The reply clears its Agent's row.
    t.socket.emit({ type: "message", message: wire(G1, 2, AG1, "在的") });
    expect(rows(box.model).map((r) => r.agentId)).toEqual([OAG]);
    t.socket.emit({ type: "gone", id: G1 });
    expect(box.model.groupRuns[G1]).toBeUndefined();
  });

  it("malformed group pushes change nothing", async () => {
    const t = agentsTransport({ sync: groupSync });
    const { box } = run(t);
    await settle();
    const before = box.model;
    t.socket.emit({ type: "run", conversationId: G1 });
    t.socket.emit({ type: "run", conversationId: G1, agentId: OAG });
    t.socket.emit({ type: "run", conversationId: G1, agentId: OAG, state: "thinking" });
    t.socket.emit({ type: "run", conversationId: G1, agentId: 7, state: "replying" });
    t.socket.emit({ type: "run", conversationId: G1, agentId: OAG, run: runOf(R1, "running") });
    expect(box.model).toBe(before);
  });

  it("a group's runs are fetched when asked (the group is opened), once while one is on its way, and on a reconnect for the groups that hold any", async () => {
    const answer = deferred();
    const t = agentsTransport({ sync: groupSync, groupRuns: () => answer.promise });
    const { box, engine, timers } = run(t);
    await settle();
    // Not on a first load: nothing is held yet, and the open group asks for itself.
    expect(groupCalls(t)).toEqual([]);
    engine.request({ groupRuns: G1 });
    engine.request({ groupRuns: G1 });
    await settle();
    engine.request({ groupRuns: G1 });
    await settle();
    expect(groupCalls(t)).toEqual([G1]);
    answer.resolve({ runs: [{ agentId: OAG, state: "replying" }, { agentId: AG1, state: "unavailable", run: runOf(R1, "failed", { error: "busy", retryable: true }) }] });
    await settle();
    expect(rows(box.model).map((r) => [r.agentId, r.kind])).toEqual([
      [AG1, "status"],
      [OAG, "replying"],
    ]);
    // A reconnect: the pushes of the break are not replayed, so the group holding rows is asked again.
    t.handlers.groupRuns = () => ({ runs: [] });
    t.socket.drop(1006);
    timers.advance(60_000);
    await settle();
    expect(groupCalls(t)).toEqual([G1, G1]);
    expect(rows(box.model)).toEqual([]);
    // Holding nothing now: the next reconnect does not ask.
    t.socket.drop(1006);
    timers.advance(60_000);
    await settle();
    expect(groupCalls(t)).toEqual([G1, G1]);
  });

  it("a fetch that fails is tried once more; failing again, the group's replying rows are hidden; a 404 checks the conversation", async () => {
    const t = agentsTransport({
      sync: groupSync,
      groupRuns: () => {
        throw apiError(503, "busy");
      },
    });
    const { box, engine, timers } = run(t);
    await settle();
    t.socket.emit({ type: "run", conversationId: G1, agentId: OAG, state: "replying" });
    engine.request({ groupRuns: G1 });
    await settle();
    expect(groupCalls(t)).toEqual([G1]);
    expect(rows(box.model)).toHaveLength(1);
    expect(timers.delays()).toContain(RUN_RETRY_MS);
    timers.advance(RUN_RETRY_MS);
    await settle();
    expect(groupCalls(t)).toEqual([G1, G1]);
    expect(rows(box.model)).toEqual([]);
    t.handlers.groupRuns = () => {
      throw apiError(404, "not_found");
    };
    engine.request({ groupRuns: G1 });
    await settle();
    expect(t.log).toContainEqual(["conversation", G1]);
  });
});

describe("principal pushes (spec 6.11 item 1)", () => {
  /** Every avatar URL of `id` anywhere in the view model. */
  const urlsOf = (model, id) => JSON.stringify(toView(model, { now: 0 })).match(new RegExp(`/api/principals/${id}/avatar[^"]*`, "g")) ?? [];

  it("changes that principal's avatar URL everywhere the view model shows it: a person, an Agent, me", async () => {
    const t = agentsTransport();
    const { box } = run(t);
    await settle();
    expect(urlsOf(box.model, ANN).length).toBeGreaterThan(0);
    t.socket.emit({ type: "principal", id: ANN, avatarVersion: 3 });
    t.socket.emit({ type: "principal", id: AG1, avatarVersion: 2 });
    t.socket.emit({ type: "principal", id: ME_ID, avatarVersion: 5 });
    expect(urlsOf(box.model, ANN).length).toBeGreaterThan(0);
    expect(new Set(urlsOf(box.model, ANN))).toEqual(new Set([`/api/principals/${ANN}/avatar?v=3`]));
    expect(new Set(urlsOf(box.model, AG1))).toEqual(new Set([`/api/principals/${AG1}/avatar?v=2`]));
    expect(new Set(urlsOf(box.model, ME_ID))).toEqual(new Set([`/api/principals/${ME_ID}/avatar?v=5`]));
    const view = toView(box.model, { now: 0 });
    expect(view.people[ANN].avatar).toBe(`/api/principals/${ANN}/avatar?v=3`);
    expect(view.agents[AG1].avatar).toBe(`/api/principals/${AG1}/avatar?v=2`);
    expect(view.people[ME].avatar).toBe(`/api/principals/${ME_ID}/avatar?v=5`);
    // No refetch is needed for it.
    expect(t.log).toEqual(["connect", "sync", "social"]);
  });

  it("carries the handle now (a rename; an Agent's full handle follows its owner's): shown everywhere at once, mine included", async () => {
    const t = agentsTransport();
    const { box } = run(t);
    await settle();
    t.socket.emit({ type: "principal", id: ANN, avatarVersion: 0, handle: "ann_2" });
    t.socket.emit({ type: "principal", id: AG1, avatarVersion: 0, handle: "mei_2.helper" });
    t.socket.emit({ type: "principal", id: ME_ID, avatarVersion: 0, handle: "mei_2" });
    // Malformed: ignored.
    t.socket.emit({ type: "principal", id: ANN, avatarVersion: 0, handle: 7 });
    expect(box.model.principals[ANN].handle).toBe("ann_2");
    expect(box.model.principals[AG1].handle).toBe("mei_2.helper");
    expect(box.model.agents[AG1].handle).toBe("mei_2.helper");
    expect(box.model.me.handle).toBe("mei_2");
    const view = toView(box.model, { now: 0 });
    expect(view.people[ANN].handle).toBe("@ann_2");
    expect(view.account.handle).toBe("mei_2");
    expect(t.log).toEqual(["connect", "sync", "social"]);
  });
});

describe("agent pushes", () => {
  it("refetch that Agent and the proposal cards still open in its conversation — nothing else", async () => {
    const t = agentsTransport();
    const { box } = run(t);
    await settle();
    const before = [...t.log];
    t.handlers.agent = (id) => agentOf(id, { personaVersion: 3, persona: "你是新的小助手。" });
    t.handlers.message = (conversationId, seq) => ({ message: card(seq, "confirmed"), principals: {} });
    t.agentLog.length = 0;
    t.socket.emit({ type: "agent", id: AG1 });
    await settle();
    // Only the open card (seq 2) is asked for again: a confirmed one (seq 3) cannot change any more.
    expect(t.agentLog).toEqual([["agent", AG1], ["message", A1, 2]]);
    expect(t.log).toEqual(before);
    expect(box.model.agents[AG1]).toMatchObject({ personaVersion: 3, persona: "你是新的小助手。" });
    expect(box.model.messages[A1].find((m) => m.seq === 2).proposal.status).toBe("confirmed");
  });

  it("an Agent that is not found any more is dropped; another failure refetches the list", async () => {
    const t = agentsTransport();
    const { box } = run(t);
    await settle();
    t.socket.emit({ type: "agent", id: AG2 });
    await settle();
    expect(box.model.agents[AG2]).toBeUndefined();
    t.handlers.agent = () => {
      throw apiError(503, "busy");
    };
    const lists = t.agentLog.filter((x) => x === "agents").length;
    t.socket.emit({ type: "agent", id: AG1 });
    await settle();
    expect(t.agentLog.filter((x) => x === "agents")).toHaveLength(lists + 1);
  });

  it("a reconnect refetches the open cards too (agent pushes are not replayed, and /api/sync has only the newest page)", async () => {
    // A1's newest 30 messages are 11–40; the card at seq 2 was loaded with older history.
    const longSync = () => syncOf([agentConv(A1, AG1, { lastSeq: 40, readSeq: 40 }), agentConv(A2, AG2)], range(A1, 11, 40, [ME_ID, AG1]), agentsSync().principals);
    const t = agentsTransport({ sync: longSync, message: (conversationId, seq) => ({ message: card(seq, "superseded"), principals: {} }) });
    const { box, timers } = run(t);
    await settle();
    box.model = applyOlder(box.model, A1, { messages: [wire(A1, 1, ME_ID, "在吗"), card(2, "open")], nextBefore: null });
    expect(t.agentLog.some((x) => Array.isArray(x) && x[0] === "message")).toBe(false);
    t.socket.drop(1006);
    timers.advance(60_000);
    await settle();
    expect(t.agentLog.filter((x) => Array.isArray(x) && x[0] === "message")).toEqual([["message", A1, 2]]);
    expect(box.model.messages[A1].find((m) => m.seq === 2).proposal.status).toBe("superseded");
  });
});

describe("the reply posted while the connection was being made (M1)", () => {
  const reply = wire(A1, 4, AG1, "你好呀");
  const snapshotWith = (messages) =>
    syncOf([agentConv(A1, AG1, { lastSeq: messages.at(-1).seq, readSeq: 3 }), agentConv(A2, AG2)], messages, agentsSync().principals);
  const before = [wire(A1, 1, ME_ID, "在吗"), card(2, "confirmed"), wire(A1, 3, ME_ID, "说点什么")];

  it("the page loads while a reply streams, and the reply is in the snapshot: never the bubble and the message at once", async () => {
    const held = deferred();
    const t = agentsTransport({ sync: () => held.promise, run: (id) => ({ run: id === A1 ? runOf(R1, "running") : null }) });
    const watch = bothShown(4);
    const { box } = run(t, { onModel: watch.onModel });
    await settle();
    // Buffered while /api/sync is on its way: the reply's last pieces, then the reply itself (posted before the snapshot).
    t.socket.emit({ type: "delta", conversationId: A1, runId: R1, text: "你" });
    t.socket.emit({ type: "delta", conversationId: A1, runId: R1, text: "好呀" });
    t.socket.emit({ type: "message", message: reply });
    held.resolve(snapshotWith([...before, reply]));
    await settle();
    // GET .../run answered after the snapshot: still running (the run ends in a transaction of its own).
    expect(box.model.runs[A1]).toMatchObject({ id: R1, status: "running", joined: true });
    expect(watch.seen).toEqual([]);
    expect(box.model.streams).toEqual({});
    expect(box.model.messages[A1].filter((m) => m.seq === 4)).toHaveLength(1);
    t.socket.emit({ type: "delta", conversationId: A1, runId: R1, text: "！" });
    t.socket.emit({ type: "run", conversationId: A1, run: runOf(R1, "done") });
    expect(watch.seen).toEqual([]);
    expect(box.model.runs[A1]).toMatchObject({ id: R1, status: "done" });
  });

  it("a run starts during an outage and its reply comes with the snapshot: the buffered duplicate push ends the bubble", async () => {
    const t = agentsTransport({ sync: () => snapshotWith(before), run: () => ({ run: null }) });
    const watch = bothShown(4);
    const { box, timers } = run(t, { onModel: watch.onModel });
    await settle();
    t.socket.drop(1006);
    const held = deferred();
    t.handlers.sync = () => held.promise;
    t.handlers.run = (id) => ({ run: id === A1 ? runOf(R2, "running") : null });
    timers.advance(60_000);
    await settle();
    // On the new socket, buffered: the run starts, streams, and posts (before the snapshot is read).
    t.socket.emit({ type: "run", conversationId: A1, run: runOf(R2, "running") });
    t.socket.emit({ type: "delta", conversationId: A1, runId: R2, text: "你" });
    t.socket.emit({ type: "delta", conversationId: A1, runId: R2, text: "好呀" });
    t.socket.emit({ type: "message", message: reply });
    held.resolve(snapshotWith([...before, reply]));
    await settle();
    expect(watch.seen).toEqual([]);
    expect(box.model.streams).toEqual({});
    expect(box.model.runs[A1]).toMatchObject({ id: R2, status: "running", posted: true });
    t.socket.emit({ type: "delta", conversationId: A1, runId: R2, text: "！" });
    expect(box.model.streams).toEqual({});
    expect(watch.seen).toEqual([]);
  });
});

describe("a run that cannot be fetched (M2)", () => {
  it("is tried once more after a short delay; failing again, a run held as replying is shown as unknown until a push", async () => {
    const t = agentsTransport({ run: () => ({ run: null }) });
    const { box, timers } = run(t);
    await settle();
    t.socket.emit({ type: "run", conversationId: A1, run: runOf(R1, "running") });
    t.socket.drop(1006);
    t.handlers.run = () => {
      throw apiError(503, "busy");
    };
    timers.advance(60_000);
    await settle();
    expect(runCalls(t).filter((id) => id === A1)).toHaveLength(2);
    expect(toView(box.model, { now: 0 }).convs[A1].run).toMatchObject({ id: R1, status: "running" });
    expect(timers.delays()).toContain(RUN_RETRY_MS);
    timers.advance(RUN_RETRY_MS);
    await settle();
    expect(runCalls(t).filter((id) => id === A1)).toHaveLength(3);
    expect(box.model.runs[A1]).toMatchObject({ id: R1, unknown: true });
    expect(toView(box.model, { now: 0 }).convs[A1]).toMatchObject({ run: null, stream: null });
    // No third try; the next push says what it is.
    timers.advance(RUN_RETRY_MS * 10);
    await settle();
    expect(runCalls(t).filter((id) => id === A1)).toHaveLength(3);
    t.socket.emit({ type: "run", conversationId: A1, run: runOf(R1, "failed", { error: "provider_unavailable", retryable: true }) });
    expect(toView(box.model, { now: 0 }).convs[A1].run).toMatchObject({ id: R1, status: "failed" });
  });

  it("a retry that succeeds shows the run", async () => {
    let calls = 0;
    const t = agentsTransport({
      run: (id) => {
        if (id !== A1) return { run: null };
        calls += 1;
        if (calls === 1) throw apiError(429, "rate_limited");
        return { run: runOf(R1, "failed", { error: "busy", retryable: true }) };
      },
    });
    const { box, timers } = run(t);
    await settle();
    expect(box.model.runs[A1]).toBeUndefined();
    timers.advance(RUN_RETRY_MS);
    await settle();
    expect(box.model.runs[A1]).toMatchObject({ id: R1, status: "failed" });
  });
});

describe("Agents never hold up or break the connection (M4)", () => {
  const humanSync = () => syncOf([...agentsSync().conversations], [wire(D1, 1, ANN)], agentsSync().principals);

  it("Agents, runs and models still on their way: live on batch 1's path, and human messages flow in order", async () => {
    const never = () => new Promise(() => {});
    const t = agentsTransport({ sync: humanSync, agents: never, run: never, models: never });
    const { box, statuses } = run(t);
    await settle();
    expect(t.log).toEqual(["connect", "sync", "social"]);
    expect(statuses.at(-1)).toBe("live");
    t.socket.emit({ type: "message", message: wire(D1, 2, ANN, "在吗") });
    t.socket.emit({ type: "message", message: wire(D1, 3, ANN, "人呢") });
    expect(box.model.messages[D1].map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(box.model.conversations[D1]).toMatchObject({ position: 3, unread: 2 });
    // The runs were asked for (a few at a time), the list and the models too, all still pending.
    expect(runCalls(t).sort()).toEqual([A1, A2].sort());
    expect(t.agentLog.filter((x) => x === "agents" || x === "models")).toEqual(["agents", "models"]);
  });

  it("pushes buffered while the connection was made are applied before any Agent answer", async () => {
    const held = deferred();
    const t = agentsTransport({ sync: () => held.promise, run: () => new Promise(() => {}) });
    const { box, statuses } = run(t);
    await settle();
    t.socket.emit({ type: "message", message: wire(D1, 2, ANN, "早") });
    held.resolve(humanSync());
    await settle();
    expect(statuses.at(-1)).toBe("live");
    expect(box.model.messages[D1].map((m) => m.seq)).toEqual([1, 2]);
  });

  it("a failing /api/agents keeps the socket and human chats; the next connection asks for the list (and the models) again", async () => {
    const t = agentsTransport({
      sync: humanSync,
      agents: () => {
        throw apiError(500, "internal");
      },
      models: () => {
        throw apiError(503, "busy");
      },
    });
    const { box, timers, statuses, onSignedOut } = run(t);
    await settle();
    expect(t.sockets).toHaveLength(1);
    expect(statuses.at(-1)).toBe("live");
    expect(onSignedOut).not.toHaveBeenCalled();
    t.socket.emit({ type: "message", message: wire(D1, 2, ANN, "在吗") });
    expect(box.model.messages[D1].map((m) => m.seq)).toEqual([1, 2]);
    // Runs do not depend on the list.
    expect(box.model.runs[A1]).toMatchObject({ id: R1 });
    t.handlers.agents = () => ({ agents: [agentOf(AG1)] });
    t.handlers.models = () => ({ siteModels: [{ id: "free-1", label: "免费", tier: "free", vision: false, pdf: false, reasoning: [], contextTokens: 8000 }], providerDefaults: null });
    t.socket.drop(1006);
    timers.advance(60_000);
    await settle();
    expect(Object.keys(box.model.agents)).toEqual([AG1]);
    expect(box.model.siteModels.map((m) => m.id)).toEqual(["free-1"]);
    expect(t.agentLog.filter((x) => x === "models")).toHaveLength(2);
  });

  it("runs are fetched a few at a time", async () => {
    const ids = Array.from({ length: 7 }, (_, i) => `00000000-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`);
    const agentIds = ids.map((_, i) => `00000000-0000-4000-8000-0000000002${String(i).padStart(2, "0")}`);
    const sync = () =>
      syncOf(
        ids.map((id, i) => agentConv(id, agentIds[i])),
        [],
        [...PRINCIPALS, ...agentIds.map((id, i) => agentPrincipal(id, `agent_${i}`, `助手${i}`))],
      );
    const answers = [];
    let inFlight = 0;
    let most = 0;
    const t = fakeTransport({
      sync,
      run: () => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        const d = deferred();
        answers.push(d);
        return d.promise.finally(() => {
          inFlight -= 1;
        });
      },
    });
    run(t);
    await settle();
    expect(answers).toHaveLength(RUN_FETCHES);
    for (let i = 0; i < ids.length; i += 1) {
      answers[i].resolve({ run: null });
      await settle();
    }
    expect(most).toBe(RUN_FETCHES);
    expect(runCalls(t).sort()).toEqual([...ids].sort());
  });

  it("a GET .../run answer older than this connection's pushes changes nothing", async () => {
    const late = deferred();
    const t = agentsTransport({ run: (id) => (id === A1 ? late.promise : { run: null }) });
    const { box } = run(t);
    await settle();
    t.socket.emit({ type: "run", conversationId: A1, run: runOf(R2, "running") });
    t.socket.emit({ type: "delta", conversationId: A1, runId: R2, text: "你" });
    late.resolve({ run: runOf(R1, "done") });
    await settle();
    expect(box.model.runs[A1]).toMatchObject({ id: R2, status: "running" });
    expect(box.model.streams).toEqual({ [R2]: { text: "你", reasoning: "" } });
  });
});
