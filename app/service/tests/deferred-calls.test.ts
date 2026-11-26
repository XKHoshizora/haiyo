import { describe, expect, it } from "vitest";
import { createAgentPort, recoverRuns } from "../src/agents/port-impl.ts";
import { mentionsAtSend } from "../src/agents/mentions.ts";
import { queueRun, triggerFromAgent } from "../src/agents/runs.ts";
import { lockAgent } from "../src/agents/store.ts";
import { failedEnd, isRunEnd, NOTHING, type RunTicket } from "../src/agents/runtime/port.ts";
import { createAgentWorker } from "../src/agents/runtime/worker.ts";
import { lockConversation } from "../src/conversations/store.ts";
import { insertMessage } from "../src/messages/model.ts";
import type { ModelCall } from "../src/models/gateway.ts";
import { api, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { grant } from "./helpers/metering.ts";
import { scriptedGateway } from "./helpers/models.ts";

/**
 * The limits redesign, Part 2 ("one identity per reply"): a run's lane and caller are fixed when its row is made and never change; a
 * call on a pair (an Agent in a conversation) with a run active waits in `deferred_calls` and, when that run ends, the same transaction
 * takes the oldest call waiting and the calls right after it of the same identity as ONE assignment and queues its reply. Each test
 * names the invariant of the design (`limits-redesign-design.md`, Invariants) or the carried item (C-a … C-e) it holds to. Through the
 * real routes, the real port and a scripted gateway; `claim` makes a queued run running as the worker's claim does, so calls can come
 * while it runs.
 */

const gateway = scriptedGateway();
const { app, db } = useApp({ env: { ...SITE_ENV, AGENTS: JSON.stringify({ autoRetryDelaysMs: [] }) }, models: gateway, agentWorker: false });

const THINKER = { source: "site", id: "thinker" } as const;
/** The calls that may wait per pair (the design's internal 8: runs.ts `DEFERRED_PER_PAIR`). */
const DEFERRED_PER_PAIR = 8;
let txn = 0;
const say = async (who: Actor, conv: string, text: string, on = app): Promise<number> => {
  const sent = await api(on, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `dc${++txn}` });
  if (sent.status !== 201) throw new Error(`say: ${sent.status} ${JSON.stringify(sent.json)}`);
  return sent.json.message.seq as number;
};

interface RunView {
  id: string;
  status: string;
  error: string | null;
  lane: string;
  caller: string | null;
  covers: number;
  calls: number[] | null;
}
const runsOf = async (agentId: string, conv: string): Promise<RunView[]> =>
  (
    await db.query<RunView>(
      `select id, status, error, lane, caller_id as caller, covers_seq::int as covers, call_seqs::int[] as calls
         from agent_runs where agent_id = $1 and conversation_id = $2 and purpose = 'reply' order by created_at, id`,
      [agentId, conv],
    )
  ).rows;
const waiting = async (agentId: string, conv: string) =>
  (
    await db.query<{ seq: number; lane: string; caller: string | null }>(
      "select message_seq::int as seq, lane, caller_id as caller from deferred_calls where agent_id = $1 and conversation_id = $2 order by message_seq",
      [agentId, conv],
    )
  ).rows;
const refusals = async (agentId: string, conv: string) =>
  (await db.query<{ seq: number; sender: string; reason: string }>("select seq::int as seq, sender_id as sender, reason from call_refusals where agent_id = $1 and conversation_id = $2 order by seq", [agentId, conv])).rows;

/** The Agent's queued run in `conv`, made running as the worker's claim makes it. */
const claim = async (agentId: string, conv: string): Promise<RunTicket> => {
  const { rows } = await db.query<{ id: string; owner_id: string }>(
    "update agent_runs set status = 'running', started_at = now() where agent_id = $1 and conversation_id = $2 and status = 'queued' returning id, owner_id",
    [agentId, conv],
  );
  return { id: rows[0]!.id, agentId, ownerId: rows[0]!.owner_id, conversationId: conv };
};
const finish = (ticket: RunTicket, on = app) => on.agentPort.finish(ticket, { status: "done" }, null, NOTHING);
/** The last user turn of a model call, as text. */
const lastTurn = (call: ModelCall): string => {
  const turn = call.messages.at(-1)!;
  return turn.parts.map((p) => ("text" in p ? p.text : "")).join("");
};
const everything = (call: ModelCall): string => call.messages.map((m) => m.parts.map((p) => ("text" in p ? p.text : "")).join("")).join("\n");

let n = 0;
/** A group of an owner (with points), mia and ned, with the owner's Agent: it thinks `medium` for its owner and `low` for others. */
async function world(on = app) {
  const tag = `${++n}${Math.floor(Math.random() * 1e6)}`;
  const [owner, mia, ned] = [await signUp(on, `dco${tag}`), await signUp(on, `dcm${tag}`), await signUp(on, `dcn${tag}`)];
  await grant(db, owner.id, 5_000n * 1_000_000n);
  const g = await group(on, owner, "楼里的群", [mia, ned]);
  const agent = (await mustCreateAgent(on, owner, { handle: `dch${tag}`, name: "小助手", model: THINKER, reasoning: "medium", othersReasoning: "low", persona: "你是小助手。" })) as { id: string; conversationId: string };
  expect((await api(on, owner, "POST", `/api/conversations/${g}/members`, { principalId: agent.id })).status).toBe(201);
  return { owner, mia, ned, g, agent, at: `@dch${tag}` };
}

describe("invariants 1 and 2: a run's lane and caller are fixed as its row is made, and nothing changes them", () => {
  it("invariant 2: the owner and a member ask together — two replies, in acceptance order, the owner's own then the member's, neither changes lane; the first is shown nothing after its call", async () => {
    const w = await world();
    const first = gateway.calls.length;
    const own = await say(w.owner, w.g, `${w.at} OWNER-ASK 帮我看看`);
    const member = await say(w.mia, w.g, `${w.at} MIA-ASK 我也问一句`);
    // The member's call is of another identity: it is not folded into the owner's queued reply, it waits.
    expect(await runsOf(w.agent.id, w.g)).toMatchObject([{ status: "queued", lane: "own", caller: w.owner.id, covers: own, calls: [own] }]);
    expect(await waiting(w.agent.id, w.g)).toEqual([{ seq: member, lane: "others", caller: w.mia.id }]);

    gateway.reply("给主人的回答");
    expect(await app.agentWorker.runOnce()).toBe(true);
    // Its end queued the member's reply in the same transaction, in the member's identity.
    expect(await runsOf(w.agent.id, w.g)).toMatchObject([
      { status: "done", lane: "own", caller: w.owner.id, calls: [own] },
      { status: "queued", lane: "others", caller: w.mia.id, covers: member, calls: [member] },
    ]);
    expect(await waiting(w.agent.id, w.g)).toEqual([]);
    gateway.reply("给米娅的回答");
    expect(await app.agentWorker.runOnce()).toBe(true);
    const [toOwner, toMia] = gateway.calls.slice(first);
    // On the owner's terms for the owner, on the others' terms for the member.
    expect([toOwner!.reasoning, toMia!.reasoning]).toEqual(["medium", "low"]);
    // The owner's reply answered the owner's call and was shown nothing after it — not the member's question.
    expect(lastTurn(toOwner!)).toContain("OWNER-ASK");
    expect(everything(toOwner!)).not.toContain("MIA-ASK");
    expect(lastTurn(toMia!)).toContain("MIA-ASK");
    expect((await runsOf(w.agent.id, w.g)).map((r) => [r.lane, r.caller])).toEqual([
      ["own", w.owner.id],
      ["others", w.mia.id],
    ]);
  });

  it("invariant 2, the other order: the member first, then the owner — the member's reply on the others' terms, then the owner's own", async () => {
    const w = await world();
    const first = gateway.calls.length;
    const member = await say(w.mia, w.g, `${w.at} MIA-ASK 在吗？`);
    const own = await say(w.owner, w.g, `${w.at} OWNER-ASK 我也问`);
    expect(await runsOf(w.agent.id, w.g)).toMatchObject([{ status: "queued", lane: "others", caller: w.mia.id, calls: [member] }]);
    expect(await waiting(w.agent.id, w.g)).toEqual([{ seq: own, lane: "own", caller: w.owner.id }]);
    gateway.reply("一").reply("二");
    while (await app.agentWorker.runOnce());
    expect((await runsOf(w.agent.id, w.g)).map((r) => [r.status, r.lane, r.caller, r.calls])).toEqual([
      ["done", "others", w.mia.id, [member]],
      ["done", "own", w.owner.id, [own]],
    ]);
    expect(gateway.calls.slice(first).map((c) => c.reasoning)).toEqual(["low", "medium"]);
  });

  it("invariant 1: one person asking twice folds into the one reply (same identity, nothing waiting); the owner's call is never folded into a member's reply", async () => {
    const w = await world();
    const one = await say(w.mia, w.g, `${w.at} 一`);
    const two = await say(w.mia, w.g, `${w.at} 二`);
    const own = await say(w.owner, w.g, `${w.at} 三`);
    expect(await runsOf(w.agent.id, w.g)).toMatchObject([{ status: "queued", lane: "others", caller: w.mia.id, covers: two, calls: [one, two] }]);
    expect(await waiting(w.agent.id, w.g)).toEqual([{ seq: own, lane: "own", caller: w.owner.id }]);
    // Once something waits, nothing is folded any more (nothing passes the head): mia's third call waits behind the owner's.
    const three = await say(w.mia, w.g, `${w.at} 四`);
    expect(await waiting(w.agent.id, w.g)).toEqual([
      { seq: own, lane: "own", caller: w.owner.id },
      { seq: three, lane: "others", caller: w.mia.id },
    ]);
    await db.query("delete from deferred_calls where agent_id = $1", [w.agent.id]);
    await db.query("update agent_runs set status = 'cancelled', finished_at = now() where agent_id = $1 and status = 'queued'", [w.agent.id]);
  });

  it("invariant 1: a refusal takes a call out and changes nothing else — the member's run whose call is refused ends quietly as the member's; a waiting call refused is dropped, the owner's run stays the owner's", async () => {
    const w = await world();
    const first = gateway.calls.length;
    await say(w.mia, w.g, `${w.at} MIA-ASK 在吗？`);
    expect((await api(app, w.owner, "PUT", `/api/blocks/${w.mia.id}`)).status).toBe(200);
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(await runsOf(w.agent.id, w.g)).toMatchObject([{ status: "cancelled", error: null, lane: "others", caller: w.mia.id }]);
    expect(gateway.calls.length).toBe(first);

    // The owner's own run, the ned's call waiting; ned is blocked before it is taken: dropped, and the owner's reply is as it was.
    const own = await say(w.owner, w.g, `${w.at} OWNER-ASK 看看`);
    const ticket = await claim(w.agent.id, w.g);
    await say(w.ned, w.g, `${w.at} NED-ASK 我也问`);
    expect((await api(app, w.owner, "PUT", `/api/blocks/${w.ned.id}`)).status).toBe(200);
    await finish(ticket);
    expect((await runsOf(w.agent.id, w.g)).slice(1)).toMatchObject([{ status: "done", lane: "own", caller: w.owner.id, calls: [own] }]);
    expect(await waiting(w.agent.id, w.g)).toEqual([]);
  });
});

describe("invariant 5: at most one active row per pair; assignments served in acceptance order, each exactly once", () => {
  it("the calls right after the head of its identity are one assignment; another identity between them splits them: ned ×2, mia, the owner → three replies, in that order", async () => {
    const w = await world();
    await say(w.mia, w.g, `${w.at} 零`);
    const r0 = await claim(w.agent.id, w.g);
    const ned1 = await say(w.ned, w.g, `${w.at} 一`);
    const ned2 = await say(w.ned, w.g, `${w.at} 二`);
    const mia = await say(w.mia, w.g, `${w.at} 三`);
    const own = await say(w.owner, w.g, `${w.at} 四`);
    const ned3 = await say(w.ned, w.g, `${w.at} 五`);
    expect((await waiting(w.agent.id, w.g)).map((c) => c.seq)).toEqual([ned1, ned2, mia, own, ned3]);
    await finish(r0);
    await finish(await claim(w.agent.id, w.g));
    await finish(await claim(w.agent.id, w.g));
    await finish(await claim(w.agent.id, w.g));
    await finish(await claim(w.agent.id, w.g));
    expect((await runsOf(w.agent.id, w.g)).slice(1).map((r) => [r.lane, r.caller, r.calls])).toEqual([
      ["others", w.ned.id, [ned1, ned2]],
      ["others", w.mia.id, [mia]],
      ["own", w.owner.id, [own]],
      ["others", w.ned.id, [ned3]],
    ]);
    // Never two active at once, nothing left waiting.
    expect(await waiting(w.agent.id, w.g)).toEqual([]);
    expect((await runsOf(w.agent.id, w.g)).every((r) => r.status === "done")).toBe(true);
  });

  it("nothing overtakes the head: the owner's own call, with a member's waiting, waits behind it; a reply nobody asked for is never a call's — it ends quietly as it begins, and the call gets its own reply", async () => {
    const w = await world();
    await say(w.mia, w.g, `${w.at} 零`);
    const r0 = await claim(w.agent.id, w.g);
    const ned = await say(w.ned, w.g, `${w.at} 一`);
    const own = await say(w.owner, w.g, `${w.at} 二`);
    expect((await waiting(w.agent.id, w.g)).map((c) => [c.seq, c.lane])).toEqual([
      [ned, "others"],
      [own, "own"],
    ]);
    await db.query("delete from deferred_calls where agent_id = $1", [w.agent.id]);
    await finish(r0);

    // A reply nobody asked for, queued; a member's call meanwhile waits (it never takes the reply over).
    const seed = await say(w.ned, w.g, "今晚谁做饭？");
    await db.tx(async (t) => {
      await lockConversation(t, w.g);
      await queueRun(t, { id: w.agent.id, ownerId: w.owner.id }, w.g, seed, "human", { id: null, lane: "proactive" }, [w.ned.id]);
    });
    const call = await say(w.mia, w.g, `${w.at} MIA-ASK 你来定`);
    expect((await runsOf(w.agent.id, w.g)).at(-1)).toMatchObject({ status: "queued", lane: "proactive", caller: null });
    expect(await waiting(w.agent.id, w.g)).toEqual([{ seq: call, lane: "others", caller: w.mia.id }]);
    const first = gateway.calls.length;
    gateway.reply("给米娅的回答");
    while (await app.agentWorker.runOnce());
    expect((await runsOf(w.agent.id, w.g)).slice(-2).map((r) => [r.status, r.lane, r.caller])).toEqual([
      ["cancelled", "proactive", null],
      ["done", "others", w.mia.id],
    ]);
    // One model call: the member's; none for the unasked remark.
    expect(gateway.calls.length - first).toBe(1);
  });

  it(`invariant 5 (bound): at most ${DEFERRED_PER_PAIR} calls wait per pair; one more is refused 太频繁, its sender alone told`, async () => {
    const w = await world();
    await say(w.owner, w.g, `${w.at} 零`);
    const r0 = await claim(w.agent.id, w.g);
    for (let i = 0; i < DEFERRED_PER_PAIR; i++) await say(w.owner, w.g, `${w.at} ${i}`);
    const over = await say(w.mia, w.g, `${w.at} 多一个`);
    expect((await waiting(w.agent.id, w.g)).length).toBe(DEFERRED_PER_PAIR);
    expect(await refusals(w.agent.id, w.g)).toEqual([{ seq: over, sender: w.mia.id, reason: "too_often" }]);
    await finish(r0);
    // The owner's calls, all of one identity: one reply.
    expect((await runsOf(w.agent.id, w.g)).at(-1)!.calls).toHaveLength(DEFERRED_PER_PAIR);
    await db.query("update agent_runs set status = 'cancelled', finished_at = now() where agent_id = $1 and status = 'queued'", [w.agent.id]);
  });

  it("invariant 5 (crash and recovery): a run lost mid-call with calls waiting — recovery ends it and queues the next assignment in the same transaction; recovering again answers nothing twice", async () => {
    const w = await world();
    await say(w.owner, w.g, `${w.at} 零`);
    await claim(w.agent.id, w.g);
    const mia = await say(w.mia, w.g, `${w.at} 一`);
    const ned = await say(w.ned, w.g, `${w.at} 二`);
    expect(await recoverRuns(db, app.deps.config, app.log)).toBeGreaterThanOrEqual(1);
    expect((await runsOf(w.agent.id, w.g)).map((r) => [r.status, r.lane, r.caller, r.calls])).toEqual([
      ["failed", "own", w.owner.id, expect.any(Array)],
      ["queued", "others", w.mia.id, [mia]],
    ]);
    expect(await waiting(w.agent.id, w.g)).toEqual([{ seq: ned, lane: "others", caller: w.ned.id }]);
    await recoverRuns(db, app.deps.config, app.log);
    expect(await runsOf(w.agent.id, w.g)).toHaveLength(2);
    // Calls left waiting with nothing active (an ending outside the conversation's lock order whose next step was lost): taken
    // at start-up, once.
    await db.query("update agent_runs set status = 'cancelled', finished_at = now() where agent_id = $1 and status = 'queued'", [w.agent.id]);
    await recoverRuns(db, app.deps.config, app.log);
    await recoverRuns(db, app.deps.config, app.log);
    expect((await runsOf(w.agent.id, w.g)).map((r) => [r.status, r.caller, r.calls]).slice(2)).toEqual([["queued", w.ned.id, [ned]]]);
    expect(await waiting(w.agent.id, w.g)).toEqual([]);
    await db.query("update agent_runs set status = 'cancelled', finished_at = now() where agent_id = $1 and status = 'queued'", [w.agent.id]);
  });
});

describe("invariant 5 (retries): an automatic retry takes the slot before any waiting call, keeps its assignment and its identity; the calls are answered after it", () => {
  // Its own instance, with one automatic retry 20 s after a passing failure, on a clock of its own.
  const { app: retrying } = useApp({ env: { ...SITE_ENV, AGENTS: JSON.stringify({ autoRetryDelaysMs: [20_000] }) }, models: gateway, agentWorker: false });
  let offset = 0;
  const now = (): Date => new Date(Date.now() + offset);

  it("the member's reply fails passing with the owner's call waiting: the retry is the member's, queued first; the owner's reply after it", async () => {
    offset = 0;
    const w = await world(retrying);
    const { db: pool, conversations, reads } = retrying.deps;
    const port = createAgentPort({ db: pool, config: retrying.deps.config, blobs: retrying.deps.blobs, realtime: retrying.realtime, conversations, reads, log: retrying.log, now });
    const worker = createAgentWorker({ port, models: gateway, runTimeoutMs: 60_000, callCeilingMs: 60_000, maxRunsInFlight: 1, background: false, log: retrying.log, tools: retrying.deps.config.tools });
    const member = await say(w.mia, w.g, `${w.at} MIA-ASK 在吗？`, retrying);
    const ticket = await claim(w.agent.id, w.g);
    const own = await say(w.owner, w.g, `${w.at} OWNER-ASK 我也问`, retrying);
    await port.finish(ticket, failedEnd("provider_unavailable", { kind: "upstream", code: "provider_unavailable", status: 503, progress: false }), null, NOTHING);
    expect(await runsOf(w.agent.id, w.g)).toMatchObject([
      { status: "failed", lane: "others", caller: w.mia.id, calls: [member] },
      { status: "queued", lane: "others", caller: w.mia.id, covers: member, calls: [member] },
    ]);
    expect(await waiting(w.agent.id, w.g)).toEqual([{ seq: own, lane: "own", caller: w.owner.id }]);
    offset += 20_000;
    gateway.reply("给米娅").reply("给主人");
    while (await worker.runOnce());
    expect((await runsOf(w.agent.id, w.g)).map((r) => [r.status, r.lane, r.caller, r.calls])).toEqual([
      ["failed", "others", w.mia.id, [member]],
      ["done", "others", w.mia.id, [member]],
      ["done", "own", w.owner.id, [own]],
    ]);
  });
});

describe("invariant 5 (retries, T2 fix 1, F5b): calls that wait never cost an automatic retry its slot", () => {
  // Its own instance: one automatic retry, and the owner's others' minute at 3 (a run and two waiting calls fill it).
  const { app: tight } = useApp({ env: { ...SITE_ENV, AGENTS: JSON.stringify({ autoRetryDelaysMs: [20_000] }), AGENT_OTHERS_RUNS_PER_MINUTE: "3" }, models: gateway, agentWorker: false });

  it("the owner's others' minute full of waiting calls (this pair's and another's): the failed reply's retry is still queued first, before the calls that wait", async () => {
    const w = await world(tight);
    const member = await say(w.mia, w.g, `${w.at} MIA-ASK 在吗？`, tight);
    const ticket = await claim(w.agent.id, w.g);
    const ned = await say(w.ned, w.g, `${w.at} NED-ASK 我也问`, tight);
    // Another pair of the owner's: the same Agent in a second group, a call waiting there (accepted now).
    const g2 = await group(tight, w.owner, "另一个群", [w.mia, w.ned]);
    expect((await api(tight, w.owner, "POST", `/api/conversations/${g2}/members`, { principalId: w.agent.id })).status).toBe(201);
    const elsewhere = await say(w.ned, g2, "随便说一句", tight);
    await db.query(
      "insert into deferred_calls (agent_id, conversation_id, message_seq, owner_id, lane, caller_id, triggered_by, asker_ids) values ($1, $2, $3, $4, 'others', $5, 'human', array[$5::uuid])",
      [w.agent.id, g2, elsewhere, w.owner.id, w.ned.id],
    );
    // One reply started for others and two waiting: the minute (3) is full as the reply fails for a passing reason.
    await tight.agentPort.finish(ticket, failedEnd("provider_unavailable", { kind: "upstream", code: "provider_unavailable", status: 503, progress: false }), null, NOTHING);
    expect(await runsOf(w.agent.id, w.g)).toMatchObject([
      { status: "failed", lane: "others", caller: w.mia.id, calls: [member] },
      { status: "queued", lane: "others", caller: w.mia.id, calls: [member] },
    ]);
    expect((await waiting(w.agent.id, w.g)).map((c) => c.seq)).toEqual([ned]);
    await db.query("delete from deferred_calls where agent_id = $1", [w.agent.id]);
    await db.query("update agent_runs set status = 'cancelled', finished_at = now() where agent_id = $1 and status = 'queued'", [w.agent.id]);
  });
});

describe("C-a: the caller's and the owner's minutes are met as each call is accepted, also while a reply runs", () => {

  const { app: limited } = useApp({ env: { ...SITE_ENV, AGENT_CALLER_RUNS_PER_MINUTE: "1", AGENT_OTHERS_RUNS_PER_MINUTE: "2" }, models: gateway, agentWorker: false });

  it("a member at their minute: a call folded or waiting is refused 太频繁 like any other; a waiting call counts toward the minute as it is accepted", async () => {
    const w = await world(limited);
    const one = await say(w.mia, w.g, `${w.at} 一`, limited);
    // At their limit (one reply started): a second call that would fold is refused.
    const two = await say(w.mia, w.g, `${w.at} 二`, limited);
    expect(await runsOf(w.agent.id, w.g)).toMatchObject([{ status: "queued", calls: [one] }]);
    const ticket = await claim(w.agent.id, w.g);
    // And so is one that would wait.
    const three = await say(w.mia, w.g, `${w.at} 三`, limited);
    expect(await waiting(w.agent.id, w.g)).toEqual([]);
    expect(await refusals(w.agent.id, w.g)).toEqual([
      { seq: two, sender: w.mia.id, reason: "too_often" },
      { seq: three, sender: w.mia.id, reason: "too_often" },
    ]);
    // ned's call waits, and counts toward the owner's others' minute (2) at once: with mia's reply it is full.
    const ned = await say(w.ned, w.g, `${w.at} 四`, limited);
    expect(await waiting(w.agent.id, w.g)).toEqual([{ seq: ned, lane: "others", caller: w.ned.id }]);
    const third = await signUp(limited, `dct${n}`);
    await db.query("insert into memberships (conversation_id, principal_id, role, joined_seq) select $1, $2, 'speaker', seq from conversations where id = $1", [w.g, third.id]);
    const late = await say(third, w.g, `${w.at} 五`, limited);
    expect((await refusals(w.agent.id, w.g)).at(-1)).toEqual({ seq: late, sender: third.id, reason: "too_often" });
    await finish(ticket, limited);
    await db.query("update agent_runs set status = 'cancelled', finished_at = now() where agent_id = $1 and status = 'queued'", [w.agent.id]);
  });
});

describe("C-b: a call a limit refused is in no assignment", () => {
  it("a failed run whose call has a refusal row since: the owner's 重试 answers the rest, never that call", async () => {
    const w = await world();
    const one = await say(w.mia, w.g, `${w.at} 一`);
    const two = await say(w.mia, w.g, `${w.at} 二`);
    const [failed] = await runsOf(w.agent.id, w.g);
    await db.query("update agent_runs set status = 'failed', error = 'provider_unavailable', finished_at = now() where agent_id = $1 and status = 'queued'", [w.agent.id]);
    await db.query("insert into call_refusals (conversation_id, seq, agent_id, sender_id, reason) values ($1, $2, $3, $4, 'others_limit')", [w.g, one, w.agent.id, w.mia.id]);
    const retried = await api(app, w.owner, "POST", `/api/conversations/${w.g}/runs/retry`, { runId: failed!.id });
    expect(retried.status).toBe(201);
    expect((await runsOf(w.agent.id, w.g)).at(-1)).toMatchObject({ status: "queued", lane: "own", caller: w.owner.id, calls: [two] });
    await db.query("update agent_runs set status = 'cancelled', finished_at = now() where agent_id = $1 and status = 'queued'", [w.agent.id]);
  });
});

describe("the owner's 重试 names the failure it was shown, by its id (design Part 2, Retries; T2 fix 1, F4)", () => {
  /** The owner's 重试 of run `runId` in `conv`. */
  const retry = (w: Awaited<ReturnType<typeof world>>, runId: string) => api(app, w.owner, "POST", `/api/conversations/${w.g}/runs/retry`, { runId });
  const failRun = (id: string) => db.query("update agent_runs set status = 'failed', error = 'provider_unavailable', finished_at = now() where id = $1", [id]);

  it("failure A shown, then the assignment that waited behind it (B) fails too: a 重试 of A answers A's call, not B's; A once retried is not retried twice", async () => {
    const w = await world();
    const asked = await say(w.mia, w.g, `${w.at} 一`);
    const a = await claim(w.agent.id, w.g);
    const later = await say(w.ned, w.g, `${w.at} 二`);
    // A fails (nothing tries it again here): what waited behind it, ned's call, is B; B fails too.
    await app.agentPort.finish(a, { status: "failed", error: "provider_unavailable" }, null, NOTHING);
    const b = await claim(w.agent.id, w.g);
    await app.agentPort.finish(b, { status: "failed", error: "provider_unavailable" }, null, NOTHING);
    expect((await runsOf(w.agent.id, w.g)).map((r) => [r.status, r.calls])).toEqual([
      ["failed", [asked]],
      ["failed", [later]],
    ]);
    const retried = await retry(w, a.id);
    expect(retried.status).toBe(201);
    expect((await runsOf(w.agent.id, w.g)).at(-1)).toMatchObject({ status: "queued", lane: "own", caller: w.owner.id, covers: asked, calls: [asked] });
    // Its retry ends; A is retried already: a second 重试 of it is refused, and B is still the owner's to retry.
    await db.query("update agent_runs set status = 'done', finished_at = now() where agent_id = $1 and status = 'queued'", [w.agent.id]);
    expect(await retry(w, a.id)).toEqual({ status: 400, json: { error: "invalid_request" } });
    expect((await retry(w, b.id)).status).toBe(201);
    expect((await runsOf(w.agent.id, w.g)).at(-1)).toMatchObject({ status: "queued", calls: [later] });
    await db.query("update agent_runs set status = 'cancelled', finished_at = now() where agent_id = $1 and status = 'queued'", [w.agent.id]);
  });

  it("what it covers is its last call left: the last refused since, it covers the one before; every call refused, there is nothing to retry and no run", async () => {
    const w = await world();
    const one = await say(w.mia, w.g, `${w.at} 一`);
    const two = await say(w.mia, w.g, `${w.at} 二`);
    const [failed] = await runsOf(w.agent.id, w.g);
    await failRun(failed!.id);
    const refuse = (seq: number) =>
      db.query("insert into call_refusals (conversation_id, seq, agent_id, sender_id, reason) values ($1, $2, $3, $4, 'too_often')", [w.g, seq, w.agent.id, w.mia.id]);
    await refuse(two);
    expect((await retry(w, failed!.id)).status).toBe(201);
    expect((await runsOf(w.agent.id, w.g)).at(-1)).toMatchObject({ status: "queued", covers: one, calls: [one] });
    await db.query("delete from agent_runs where agent_id = $1 and status = 'queued'", [w.agent.id]);
    await refuse(one);
    const runs = (await runsOf(w.agent.id, w.g)).length;
    expect(await retry(w, failed!.id)).toEqual({ status: 400, json: { error: "invalid_request" } });
    expect((await runsOf(w.agent.id, w.g)).length).toBe(runs);
  });

  it("a run that is not its failure to retry is refused: another conversation's (404), a reply that did not fail (400), none named (400)", async () => {
    const w = await world();
    await say(w.mia, w.g, `${w.at} 一`);
    const [run] = await runsOf(w.agent.id, w.g);
    // Its own conversation does not hold this run.
    expect(await api(app, w.owner, "POST", `/api/conversations/${w.agent.conversationId}/runs/retry`, { runId: run!.id })).toEqual({ status: 404, json: { error: "not_found" } });
    expect(await api(app, w.owner, "POST", `/api/conversations/${w.g}/runs/retry`, { runId: run!.id })).toEqual({ status: 409, json: { error: "busy_run" } });
    await db.query("update agent_runs set status = 'done', finished_at = now() where id = $1", [run!.id]);
    expect(await retry(w, run!.id)).toEqual({ status: 400, json: { error: "invalid_request" } });
    expect(await api(app, w.owner, "POST", `/api/conversations/${w.g}/runs/retry`, { agentId: w.agent.id })).toEqual({ status: 400, json: { error: "invalid_request" } });
    // Another member may not retry the owner's Agent's failure.
    await failRun(run!.id);
    expect(await api(app, w.mia, "POST", `/api/conversations/${w.g}/runs/retry`, { runId: run!.id })).toEqual({ status: 404, json: { error: "not_found" } });
  });
});


describe("C-c and C-d: what a relay carries is recorded only where it is accepted; a relay refused for a limit tells the person behind it", () => {
  it("a member's call relayed through the owner's Agent to another Agent, refused 太频繁 there: nothing is written to the relaying run's askers, and the member alone reads the line on the Agent's message", async () => {
    const w = await world();
    const other = await signUp(app, `dcx${n}`);
    await db.query("insert into memberships (conversation_id, principal_id, role, joined_seq) select $1, $2, 'speaker', seq from conversations where id = $1", [w.g, other.id]);
    const target = (await mustCreateAgent(app, other, { handle: `dctg${n}`, name: "阿杰", model: { source: "site", id: "fast" }, persona: "简短。" })) as { id: string };
    expect((await api(app, other, "POST", `/api/conversations/${w.g}/members`, { principalId: target.id })).status).toBe(201);
    // mia has called other people's Agents four times this minute (half a minute ago): her call on the owner's Agent is her fifth.
    await db.query(
      `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, created_at, finished_at, lane, caller_id)
       select 'reply', $1, $2, $3, 'done', 0, now() - interval '30 seconds', now() - interval '29 seconds', 'others', $4 from generate_series(1, 4)`,
      [w.g, target.id, other.id, w.mia.id],
    );
    // The owner's Agent answers mia with a message that calls the other Agent: mia's call, relayed.
    await say(w.mia, w.g, `${w.at} 帮我问问阿杰`);
    const before = (await db.query<{ askers: string[] }>("select asker_ids as askers from agent_runs where agent_id = $1 and status = 'queued'", [w.agent.id])).rows[0]!.askers;
    gateway.reply(`@dctg${n} 米娅问你`);
    expect(await app.agentWorker.runOnce()).toBe(true);
    const relay = (await db.query<{ seq: number }>("select seq::int as seq from messages where conversation_id = $1 and sender_id = $2 order by seq desc limit 1", [w.g, w.agent.id])).rows[0]!.seq;
    expect(await runsOf(target.id, w.g)).toHaveLength(4);
    expect(await refusals(target.id, w.g)).toEqual([{ seq: relay, sender: w.mia.id, reason: "too_often" }]);
    const after = (await db.query<{ askers: string[] }>("select asker_ids as askers from agent_runs where agent_id = $1 order by created_at desc limit 1", [w.agent.id])).rows[0]!.askers;
    expect(after).toEqual(before);
    // Only mia is sent the line, on the Agent's message.
    const lineFor = async (who: Actor) =>
      ((await api(app, who, "GET", `/api/conversations/${w.g}/messages`)).json.messages as Array<{ seq: number; refused?: unknown }>).find((m) => m.seq === relay)?.refused;
    expect(await lineFor(w.mia)).toEqual([{ agentId: target.id, reason: "too_often" }]);
    expect(await lineFor(w.owner)).toBeUndefined();
    expect(await lineFor(other)).toBeUndefined();
  });
});

describe("a halt and the chain budget are met by each relayed call as it is taken, whatever else its assignment holds (T2 fix 1, F9)", () => {
  /** mia's own Agent in the group: what it posts in a reply she called for is her call on the Agents it names (lane others, her the caller). */
  const miaAgent = async (w: Awaited<ReturnType<typeof world>>): Promise<string> => {
    const bot = (await mustCreateAgent(app, w.mia, { handle: `dcr${n}x${Math.floor(Math.random() * 1e6)}`, name: "米娅的助手", model: { source: "site", id: "fast" }, persona: "简短。" })) as { id: string };
    expect((await api(app, w.mia, "POST", `/api/conversations/${w.g}/members`, { principalId: bot.id })).status).toBe(201);
    return bot.id;
  };
  /** `botId`'s message in the group, posted in a reply mia called for (as `postAsAgent` hands it to the trigger): its seq. */
  const relay = (w: Awaited<ReturnType<typeof world>>, botId: string, text: string) =>
    db.tx(async (t) => {
      const poster = await lockAgent(t, botId, w.g);
      const message = await insertMessage(t, w.g, botId, "text", { text }, null, await mentionsAtSend(t, { id: w.g, type: "group" }, text));
      await triggerFromAgent(t, w.g, message, poster, { id: w.mia.id, lane: "own" }, app.deps.config, [w.mia.id]);
      return message.seq;
    });
  const halt = async (w: Awaited<ReturnType<typeof world>>) => expect((await api(app, w.ned, "POST", `/api/conversations/${w.g}/agents/halt`)).status).toBe(200);
  const cleanUp = (w: Awaited<ReturnType<typeof world>>) => db.query("update agent_runs set status = 'cancelled', finished_at = now() where agent_id = $1 and status = 'queued'", [w.agent.id]);

  it("a relay waits, the group is halted, then its caller calls directly: the reply after the one under way answers the direct call only", async () => {
    const w = await world();
    const bot = await miaAgent(w);
    await say(w.ned, w.g, `${w.at} 先问一句`);
    const ticket = await claim(w.agent.id, w.g);
    const relayed = await relay(w, bot, `${w.at} 帮 mia 问一下`);
    await halt(w);
    const direct = await say(w.mia, w.g, `${w.at} 我自己也问`);
    expect((await waiting(w.agent.id, w.g)).map((c) => [c.seq, c.caller])).toEqual([
      [relayed, w.mia.id],
      [direct, w.mia.id],
    ]);
    await finish(ticket);
    expect((await runsOf(w.agent.id, w.g)).at(-1)).toMatchObject({ status: "queued", lane: "others", caller: w.mia.id, covers: direct, calls: [direct] });
    expect(await waiting(w.agent.id, w.g)).toEqual([]);
    await cleanUp(w);
  });

  it("two relays straddling a halt (a person wrote after it): only the later one is answered", async () => {
    const w = await world();
    const bot = await miaAgent(w);
    await say(w.ned, w.g, `${w.at} 先问一句`);
    const ticket = await claim(w.agent.id, w.g);
    const before = await relay(w, bot, `${w.at} 帮 mia 问一下`);
    await halt(w);
    await say(w.owner, w.g, "好了，继续吧");
    const afterwards = await relay(w, bot, `${w.at} 再帮 mia 问一下`);
    expect((await waiting(w.agent.id, w.g)).map((c) => c.seq)).toEqual([before, afterwards]);
    await finish(ticket);
    expect((await runsOf(w.agent.id, w.g)).at(-1)).toMatchObject({ status: "queued", caller: w.mia.id, covers: afterwards, calls: [afterwards] });
    await cleanUp(w);
  });
});

describe("the prompt names the calls a reply answers (design [C7])", () => {

  it("one person's two calls in one reply: its system text says there are two and that the last message is one; a reply of one call says nothing more", async () => {
    const w = await world();
    await say(w.mia, w.g, `${w.at} 第一问`);
    await say(w.mia, w.g, `${w.at} 第二问`);
    const first = gateway.calls.length;
    gateway.reply("两个都答了");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(gateway.calls[first]!.system).toContain("这次一共有 2 条消息叫了你（对话里最后一条就是其中之一），都要回答。");
    await say(w.ned, w.g, `${w.at} 只问一次`);
    gateway.reply("答了");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(gateway.calls[first + 1]!.system).not.toContain("条消息叫了你");
  });
});

describe("a run begun is shown nothing after its assignment's last call", () => {
  it("in the Agent's own conversation: the owner writes again while it runs; that message waits for a reply of its own, and the first is not shown it", async () => {
    const owner = await signUp(app, `dcself${++n}`);
    const agent = (await mustCreateAgent(app, owner, { model: { source: "site", id: "fast" }, persona: "简短。" })) as { id: string; conversationId: string };
    const conv = agent.conversationId;
    const one = await say(owner, conv, "FIRST 第一件事");
    const ticket = await claim(agent.id, conv);
    const two = await say(owner, conv, "SECOND 第二件事");
    expect(await waiting(agent.id, conv)).toEqual([{ seq: two, lane: "own", caller: owner.id }]);
    const prepared = await app.agentPort.begin(ticket);
    expect(isRunEnd(prepared)).toBe(false);
    const call = (prepared as unknown as { call: ModelCall }).call;
    expect(everything(call)).toContain("FIRST");
    expect(everything(call)).not.toContain("SECOND");
    await finish(ticket);
    expect((await runsOf(agent.id, conv)).map((r) => [r.status, r.calls])).toEqual([
      ["done", [one]],
      ["queued", [two]],
    ]);
    await db.query("update agent_runs set status = 'cancelled', finished_at = now() where agent_id = $1 and status = 'queued'", [agent.id]);
  });
});
