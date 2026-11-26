import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isRunEnd, type RunTicket } from "../src/agents/runtime/port.ts";
import { insertMessage } from "../src/messages/model.ts";
import type { ModelCall } from "../src/models/gateway.ts";
import { api, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { closeAllSockets, connect, type Push } from "./helpers/ws.ts";

/**
 * Pausing or deleting an Agent ends its active reply for good (spec 6.2, 6.5): a queued reply is cancelled by the pause
 * itself, a running one is never posted — not even when the Agent is resumed before the model ends — nothing written
 * during the pause is answered after it, and no delta reaches the owner once the pause has answered. A reply already
 * posted keeps its record. Interleavings are driven by hand: the worker (`runOnce`) or the port itself.
 */

const gateway = scriptedGateway();
const { app, db } = useApp({ env: SITE_ENV, models: gateway, agentWorker: false });

let first = 0;
beforeEach(() => {
  first = gateway.calls.length;
});
afterEach(async () => {
  await closeAllSockets();
  expect(gateway.pending()).toBe(0);
});

const FAST = { source: "site", id: "fast" } as const;
const NOTHING = { inputChars: 0, outputChars: 0 };

async function owned(name: string) {
  const owner = await signUp(app, name);
  const agent = await mustCreateAgent(app, owner, { model: FAST, persona: "简短地回答。" });
  return { owner, agent, conv: agent.conversationId as string };
}

let txn = 0;
const say = (owner: Actor, conv: string, text: string) =>
  api(app, owner, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `p${++txn}` });
const pause = async (owner: Actor, agentId: string) => expect((await api(app, owner, "POST", `/api/agents/${agentId}/pause`)).status).toBe(200);
const resume = async (owner: Actor, agentId: string) => expect((await api(app, owner, "POST", `/api/agents/${agentId}/resume`)).status).toBe(200);
const latestRun = async (owner: Actor, conv: string) => (await api(app, owner, "GET", `/api/conversations/${conv}/run`)).json.run;
const fromAgent = async (owner: Actor, conv: string, agentId: string): Promise<any[]> =>
  (await api(app, owner, "GET", `/api/conversations/${conv}/messages`)).json.messages.filter((m: any) => m.senderId === agentId);
const runsOf = async (agentId: string) =>
  (await db.query("select status, error from agent_runs where agent_id = $1 order by created_at", [agentId])).rows;
const usageOf = async (runId: string) => (await db.query("select outcome, source, model from usage_records where run_id = $1", [runId])).rows;
const isRun = (conv: string, status: string) => (e: Push) => e.type === "run" && e.conversationId === conv && e.run.status === status;
const userTexts = (call: ModelCall) =>
  call.messages.filter((m) => m.role === "user").flatMap((m) => m.parts.map((p) => (p.type === "text" ? p.text : "")));

describe("pause or delete ends the active reply for good", () => {
  it("a queued reply is cancelled by the pause itself; resuming does not bring it back (delete likewise)", async () => {
    const { owner, agent, conv } = await owned("quella");
    const s = await connect(app, owner);
    await say(owner, conv, "你好");
    await s.next(isRun(conv, "queued"));
    await pause(owner, agent.id);
    const run = await latestRun(owner, conv);
    expect(run).toEqual({ id: run.id, status: "cancelled", error: "agent_paused", retryable: false });
    expect((await s.next(isRun(conv, "cancelled"))).run).toEqual(run);
    await resume(owner, agent.id);
    expect(await app.agentWorker.runOnce()).toBe(false);
    expect(gateway.calls.length).toBe(first);
    expect(await fromAgent(owner, conv, agent.id)).toEqual([]);
    // It never reached a model: nothing to settle.
    expect(await usageOf(run.id)).toEqual([]);

    const gone = await owned("quentin");
    await say(gone.owner, gone.conv, "你好");
    expect((await api(app, gone.owner, "DELETE", `/api/agents/${gone.agent.id}`)).status).toBe(200);
    expect(await latestRun(gone.owner, gone.conv)).toMatchObject({ status: "cancelled", error: "agent_deleted" });
    expect(await app.agentWorker.runOnce()).toBe(false);
  });

  it("a running reply is not posted though the Agent is resumed before the model ends; nothing written meanwhile is answered later", async () => {
    const { owner, agent, conv } = await owned("rosa");
    const hold = gateway.hangAfter("前半句，");
    await say(owner, conv, "你好");
    const running = app.agentWorker.runOnce();
    await hold.reached;
    await say(owner, conv, "还有一句"); // noted on the running reply
    await pause(owner, agent.id);
    await say(owner, conv, "暂停时说的");
    await resume(owner, agent.id);
    hold.release("后半句。");
    await running;

    expect(await fromAgent(owner, conv, agent.id)).toEqual([]);
    const run = await latestRun(owner, conv);
    expect(run).toEqual({ id: run.id, status: "cancelled", error: "agent_paused", retryable: false });
    // What it had used is settled (spec 6.5: 用量按已产生的结算); its hold is released.
    expect(await usageOf(run.id)).toEqual([{ outcome: "cancelled", source: "site", model: "fast" }]);
    expect((await db.query("select coalesce(sum(hold_micro), 0)::int h from agent_runs")).rows[0].h).toBe(0);
    // No follow-up for the message noted on it, no reply for what was written during the pause.
    expect(await app.agentWorker.runOnce()).toBe(false);
    expect(await runsOf(agent.id)).toEqual([{ status: "cancelled", error: "agent_paused" }]);

    // The next message is answered as usual, with everything written before it in what the model is shown.
    gateway.reply("都看到了。");
    await say(owner, conv, "恢复了");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect((await fromAgent(owner, conv, agent.id)).map((m) => m.text)).toEqual(["都看到了。"]);
    expect(userTexts(gateway.calls.at(-1)!)).toEqual(["你好", "还有一句", "暂停时说的", "恢复了"]);
  });

  it("a message sent right after the resume, while the interrupted reply is still ending, is answered by a follow-up", async () => {
    const { owner, agent, conv } = await owned("rory");
    await say(owner, conv, "你好");
    const run = (await app.agentPort.claimNext())!;
    expect(isRunEnd(await app.agentPort.begin(run))).toBe(false);
    await say(owner, conv, "暂停前说的"); // noted on the running reply; the pause drops the note
    await pause(owner, agent.id);
    await say(owner, conv, "暂停时说的"); // not answered for itself
    await resume(owner, agent.id);
    await say(owner, conv, "恢复后说的"); // the interrupted run is still running: noted on it
    expect(await app.agentPort.post(run, { text: "说到一半", reasoning: "", stopped: true, truncated: false })).toBe("refused");
    await app.agentPort.finish(run, { status: "stopped" }, null, NOTHING);

    expect(await runsOf(agent.id)).toEqual([
      { status: "cancelled", error: "agent_paused" },
      { status: "queued", error: null },
    ]);
    gateway.reply("收到。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect((await fromAgent(owner, conv, agent.id)).map((m) => m.text)).toEqual(["收到。"]);
    expect(userTexts(gateway.calls.at(-1)!)).toEqual(["你好", "暂停前说的", "暂停时说的", "恢复后说的"]);
    expect(await app.agentWorker.runOnce()).toBe(false);
  });

  it("messages written while paused get no reply, during the pause or after the resume", async () => {
    const { owner, agent, conv } = await owned("mina");
    await pause(owner, agent.id);
    await say(owner, conv, "一");
    await say(owner, conv, "二");
    await resume(owner, agent.id);
    expect(await app.agentWorker.runOnce()).toBe(false);
    expect(await latestRun(owner, conv)).toBeNull();
    expect(await runsOf(agent.id)).toEqual([]);
  });

  it("the port: an interrupted run's reply is refused after the resume, and a run claimed before the pause ends cancelled, not stopped", async () => {
    const { owner, agent, conv } = await owned("petra");
    await say(owner, conv, "第一句");
    const run = (await app.agentPort.claimNext())!;
    expect(isRunEnd(await app.agentPort.begin(run))).toBe(false);
    await pause(owner, agent.id);
    await resume(owner, agent.id);
    expect(app.agentPort.shouldStop(run)).toBe(true);
    expect(await app.agentPort.post(run, { text: "说到一半", reasoning: "", stopped: true, truncated: false })).toBe("refused");
    await app.agentPort.finish(run, { status: "cancelled" }, null, { inputChars: 3, outputChars: 4 });
    expect(await latestRun(owner, conv)).toEqual({ id: run.id, status: "cancelled", error: "agent_paused", retryable: false });
    expect(await fromAgent(owner, conv, agent.id)).toEqual([]);

    // Claimed, then paused and resumed before it began: nobody pressed stop, yet it does not run.
    await say(owner, conv, "第二句");
    const next = (await app.agentPort.claimNext())!;
    await pause(owner, agent.id);
    await resume(owner, agent.id);
    const begun = await app.agentPort.begin(next);
    expect(begun).toEqual({ status: "cancelled", error: "agent_paused" });
    if (!isRunEnd(begun)) throw new Error("begin should have ended the run");
    await app.agentPort.finish(next, begun, null, NOTHING);
    expect(await latestRun(owner, conv)).toEqual({ id: next.id, status: "cancelled", error: "agent_paused", retryable: false });
    expect(gateway.calls.length).toBe(first);
  });

  it("an owner's stop whose reply was posted stays stopped, with its message, though a pause comes before the run is recorded", async () => {
    const { owner, agent, conv } = await owned("stan");
    await say(owner, conv, "讲吧");
    const run = (await app.agentPort.claimNext())!;
    await app.agentPort.begin(run);
    // The test plays the worker: the owner's stop reaches it as the stop route flags a run its worker is working on
    // (a run nobody works on would be released by the route at once).
    app.agentPort.requestStop(run.id);
    expect(app.agentPort.shouldStop(run)).toBe(true);
    expect(await app.agentPort.post(run, { text: "讲到一半", reasoning: "", stopped: true, truncated: false })).toBe("posted");
    await pause(owner, agent.id);
    await app.agentPort.finish(run, { status: "stopped" }, null, { inputChars: 2, outputChars: 4 });
    expect(await latestRun(owner, conv)).toEqual({ id: run.id, status: "stopped", retryable: false });
    expect(await fromAgent(owner, conv, agent.id)).toMatchObject([{ text: "讲到一半", stopped: true }]);
    expect(await usageOf(run.id)).toEqual([{ outcome: "stopped", source: "site", model: "fast" }]);
  });
});

describe("no delta once the pause has answered", () => {
  it("the port drops a delta emitted after the pause, and one emitted before it that the hub had not delivered yet", async () => {
    const { owner, agent, conv } = await owned("della");
    const s = await connect(app, owner);
    await say(owner, conv, "你好");
    const run = (await app.agentPort.claimNext())!;
    await app.agentPort.begin(run);
    app.agentPort.emit(run, { text: "甲" });
    await s.next((e) => e.type === "delta" && e.text === "甲");

    // A delta waiting in the conversation's queue behind a message being fanned out (a database read) when the
    // run is interrupted: dropped at delivery.
    const late = await db.tx((t) => insertMessage(t, conv, owner.id, "text", { text: "排队中" }, "late-1"));
    app.deps.conversations.publish({ messages: [late], conversations: [] }, app.log);
    app.agentPort.emit(run, { text: "乙" });
    app.agentPort.interruptRuns([run.id]);
    await s.next((e) => e.type === "message" && e.message.text === "排队中");

    // And one emitted after the pause has answered.
    await pause(owner, agent.id);
    app.agentPort.emit(run, { text: "丙", reasoning: "丁" });
    await app.agentPort.finish(run, { status: "stopped" }, null, NOTHING);
    await s.next(isRun(conv, "cancelled"));
    expect(s.events.filter((e) => e.type === "delta").map((e) => [e.text, e.reasoning])).toEqual([["甲", undefined]]);
  });

  it("a delta queued before the pause is dropped even when the hub delivers it after the run has ended", async () => {
    const { owner, agent, conv } = await owned("lara");
    const s = await connect(app, owner);
    await say(owner, conv, "你好");
    const run = (await app.agentPort.claimNext())!;
    await app.agentPort.begin(run);
    app.agentPort.emit(run, { text: "甲" });
    await s.next((e) => e.type === "delta" && e.text === "甲");

    // The conversation's delivery queue is held: the fan-out of a message waits on a lock of the memberships table.
    const late = await db.tx((t) => insertMessage(t, conv, owner.id, "text", { text: "排队中" }, "late-2"));
    let locked!: () => void;
    let release!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const holding = db.tx(async (t) => {
      await t.query("lock table memberships in access exclusive mode");
      locked();
      await new Promise<void>((resolve) => (release = resolve));
    });
    await isLocked;
    try {
      app.deps.conversations.publish({ messages: [late], conversations: [] }, app.log);
      app.agentPort.emit(run, { text: "乙" }); // waits behind the fan-out
      await pause(owner, agent.id);
      // The run ends, and its final push is queued, before the hub gets to the delta.
      expect(await app.agentPort.post(run, { text: "甲乙", reasoning: "", stopped: true, truncated: false })).toBe("refused");
      await app.agentPort.finish(run, { status: "stopped" }, null, NOTHING);
    } finally {
      release();
      await holding;
    }
    await s.next(isRun(conv, "cancelled"));
    expect(s.events.filter((e) => e.type === "delta").map((e) => e.text)).toEqual(["甲"]);
    expect(s.events.some((e) => e.type === "message" && e.message.text === "排队中")).toBe(true);
  });

  it("the worker: after the pause has answered, nothing more of the reply reaches the owner", async () => {
    const { owner, agent, conv } = await owned("wren");
    const s = await connect(app, owner);
    const hold = gateway.hangAfter("第一段，");
    await say(owner, conv, "你好");
    const running = app.agentWorker.runOnce();
    await hold.reached;
    await s.next((e) => e.type === "delta" && e.text === "第一段，");
    await pause(owner, agent.id);
    const at = s.events.length;
    hold.release("第二段。".repeat(20));
    await running;
    await s.next(isRun(conv, "cancelled"), { from: at });
    expect(s.events.slice(at).filter((e) => e.type === "delta")).toEqual([]);
    expect(await fromAgent(owner, conv, agent.id)).toEqual([]);
  });
});

/**
 * A pause cannot be undone by a quick resume. An Agent's message in a group reads the Agents it calls without locking
 * them (runs.ts `triggerFromAgent`), so a pause committing inside that message's transaction cannot see what it then
 * writes: a reply queued for the paused Agent, or a mention noted on its interrupted reply. The resume, which holds the
 * Agent's row as the pause did, ends them. Each interleaving is reproduced by writing, between the pause and the resume,
 * the row that message's transaction writes.
 */
describe("what a pause could not see is ended by the resume", () => {
  /** An Agent of a new owner, put by its owner into a group of the owner and two mates. */
  async function inGroup(name: string) {
    const owner = await signUp(app, name);
    const mate = await signUp(app, `${name}mate`);
    const g = await group(app, owner, `${name} 的群`, [mate, await signUp(app, `${name}third`)]);
    const agent = await mustCreateAgent(app, owner, { model: FAST, persona: "简短地回答。" });
    expect((await api(app, owner, "POST", `/api/conversations/${g}/members`, { principalId: agent.id })).status).toBe(201);
    return { owner, mate, agent, g };
  }
  const seqOf = async (conv: string) => Number((await db.query("select seq from conversations where id = $1", [conv])).rows[0].seq);
  /** A run of the Agent in `conv`, called for by an Agent's message, as that message's transaction inserts it. */
  const insertRun = async (agentId: string, ownerId: string, conv: string, status: "queued" | "running", covers: number) =>
    (
      await db.query<{ id: string }>(
        `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, triggered_by, started_at)
         values ('reply', $1, $2, $3, $4, $5, 'agent', case when $4 = 'running' then now() end) returning id`,
        [conv, agentId, ownerId, status, covers],
      )
    ).rows[0]!.id;
  /** What the owner was charged, free allowance and balance. */
  const charged = async (ownerId: string) =>
    Number((await db.query("select coalesce(sum(free_micro + balance_micro), 0)::int as n from usage_records where owner_id = $1", [ownerId])).rows[0].n);

  it("a reply queued for the Agent after its pause committed is cancelled by the resume and announced: never claimed, no call, nothing charged", async () => {
    const { owner, mate, agent, g } = await inGroup("ivy");
    const s = await connect(app, owner);
    await say(mate, g, "写在暂停之前");
    const covers = await seqOf(g);
    await pause(owner, agent.id);
    const stray = await insertRun(agent.id, owner.id, g, "queued", covers);
    await resume(owner, agent.id);

    expect(await runsOf(agent.id)).toEqual([{ status: "cancelled", error: "agent_paused" }]);
    expect((await s.next((e) => e.type === "run" && e.run?.id === stray)).run).toEqual({ id: stray, status: "cancelled", error: "agent_paused", retryable: false });
    expect(await app.agentWorker.runOnce()).toBe(false);
    expect(gateway.calls.length).toBe(first);
    expect(await usageOf(stray)).toEqual([]);
    expect(await charged(owner.id)).toBe(0);
    expect(await fromAgent(owner, g, agent.id)).toEqual([]);
    // A mention after the resume calls it as usual.
    await say(mate, g, `@${agent.handle} 现在呢`);
    expect((await runsOf(agent.id)).at(-1)).toEqual({ status: "queued", error: null });
  });

  it("one the worker claimed meanwhile (it does not look at the pause) ends at its start, without a call", async () => {
    const { owner, mate, agent, g } = await inGroup("ike");
    await say(mate, g, "写在暂停之前");
    const covers = await seqOf(g);
    await pause(owner, agent.id);
    await insertRun(agent.id, owner.id, g, "queued", covers);
    const claimed = (await app.agentPort.claimNext())!;
    expect([claimed.agentId, claimed.conversationId]).toEqual([agent.id, g]);
    await resume(owner, agent.id);

    expect(app.agentPort.shouldStop(claimed)).toBe(true);
    const begun = await app.agentPort.begin(claimed);
    expect(begun).toEqual({ status: "cancelled", error: "agent_paused" });
    if (!isRunEnd(begun)) throw new Error("begin should have ended the run");
    await app.agentPort.finish(claimed, begun, null, NOTHING);
    expect(await runsOf(agent.id)).toEqual([{ status: "cancelled", error: "agent_paused" }]);
    expect(await app.agentWorker.runOnce()).toBe(false);
    expect(gateway.calls.length).toBe(first);
    expect(await charged(owner.id)).toBe(0);
    expect(await fromAgent(owner, g, agent.id)).toEqual([]);
  });

  it("a call left waiting behind the interrupted reply after the pause dropped what waited is dropped by the resume: no reply of it", async () => {
    const { owner, mate, agent, g } = await inGroup("iris");
    await say(mate, g, "第一句");
    const id = await insertRun(agent.id, owner.id, g, "running", await seqOf(g));
    const ticket: RunTicket = { id, agentId: agent.id, ownerId: owner.id, conversationId: g };
    // The message of an Agent's that called it was written before the pause; it reads the Agents it calls without locking them, so
    // the call it left waiting is one the pause did not see.
    await say(mate, g, "暂停前写的");
    const noted = await seqOf(g);
    await pause(owner, agent.id);
    await db.query(
      `insert into deferred_calls (agent_id, conversation_id, message_seq, owner_id, lane, caller_id, triggered_by, asker_ids)
       values ($1, $2, $3, $4, 'others', $5, 'agent', array[$5::uuid])`,
      [agent.id, g, noted, owner.id, mate.id],
    );
    await resume(owner, agent.id);

    expect((await db.query("select interrupted from agent_runs where id = $1", [id])).rows).toEqual([{ interrupted: "agent_paused" }]);
    expect((await db.query("select 1 from deferred_calls where agent_id = $1", [agent.id])).rowCount).toBe(0);

    await app.agentPort.finish(ticket, { status: "cancelled" }, null, NOTHING);
    expect(await runsOf(agent.id)).toEqual([{ status: "cancelled", error: "agent_paused" }]);
    expect(await app.agentWorker.runOnce()).toBe(false);
    expect(gateway.calls.length).toBe(first);
    expect(await charged(owner.id)).toBe(0);
  });

  it("after such a resume a message is answered as usual; resuming an Agent that is not paused cancels nothing", async () => {
    const { owner, agent, conv } = await owned("ida");
    await pause(owner, agent.id);
    await insertRun(agent.id, owner.id, conv, "queued", await seqOf(conv));
    await resume(owner, agent.id);
    expect(await runsOf(agent.id)).toEqual([{ status: "cancelled", error: "agent_paused" }]);

    await say(owner, conv, "恢复后说的");
    expect(await latestRun(owner, conv)).toMatchObject({ status: "queued" });
    await resume(owner, agent.id);
    expect(await latestRun(owner, conv)).toMatchObject({ status: "queued" });
    gateway.reply("在的。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect((await fromAgent(owner, conv, agent.id)).map((m) => m.text)).toEqual(["在的。"]);
    expect(userTexts(gateway.calls.at(-1)!)).toEqual(["恢复后说的"]);
    expect(await runsOf(agent.id)).toEqual([
      { status: "cancelled", error: "agent_paused" },
      { status: "done", error: null },
    ]);
  });
});
