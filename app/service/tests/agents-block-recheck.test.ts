import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NOTHING } from "../src/agents/runtime/port.ts";
import type { ModelCall } from "../src/models/gateway.ts";
import { api, befriend, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { grant } from "./helpers/metering.ts";
import { scriptedGateway } from "./helpers/models.ts";

/**
 * A block made after a call, met again as the reply begins (reverse-paths audit A12; Task R fix round 1): every call the
 * reply answers is held to the block rule a call meets when it is made, one by one — a call from someone who now has a
 * block with the Agent's owner, either way, is dropped (not among the calls it answers, its person not among its askers),
 * the others are still answered, and only a reply with no call left ends, quietly. Whatever the reply's lane: a call the
 * owner's own call took over, and the owner's retry, included. Driven through the real routes; the worker by hand.
 */

const gateway = scriptedGateway();
const { app, db } = useApp({ env: SITE_ENV, models: gateway, agentWorker: false });

let first = 0;
beforeEach(() => {
  first = gateway.calls.length;
});
afterEach(() => {
  expect(gateway.pending()).toBe(0);
});

const FAST = { source: "site", id: "fast" } as const;
let txn = 0;
const say = async (who: Actor, conv: string, text: string): Promise<number> => {
  const sent = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `br${++txn}` });
  if (sent.status !== 201) throw new Error(`say: ${sent.status} ${JSON.stringify(sent.json)}`);
  return sent.json.message.seq as number;
};
const block = async (by: Actor, whom: Actor): Promise<void> => {
  expect((await api(app, by, "PUT", `/api/blocks/${whom.id}`)).status).toBe(200);
};
const callsHere = (): ModelCall[] => gateway.calls.slice(first);
const shownText = (call: ModelCall): string =>
  [call.system, ...call.messages.flatMap((m) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])))].join("\n");

interface RunView {
  status: string;
  error: string | null;
  lane: string;
  caller: string | null;
  calls: number[] | null;
  askers: string[] | null;
}
/** The Agent's latest run in `conv`, with whose call it is and which calls and askers it answers. */
const latest = async (agentId: string, conv: string): Promise<RunView> =>
  (
    await db.query<RunView>(
      `select status, error, lane, caller_id as caller, call_seqs::int[] as calls, asker_ids::text[] as askers
         from agent_runs where agent_id = $1 and conversation_id = $2 order by created_at desc, id desc limit 1`,
      [agentId, conv],
    )
  ).rows[0]!;

interface World {
  /** The Agent's owner, who made the group. */
  owner: Actor;
  mia: Actor;
  ned: Actor;
  /** Befriended by the owner, not yet in the group (`joins`). */
  sam: Actor;
  g: string;
  agent: { id: string; conversationId: string };
}

async function world(): Promise<World> {
  const [owner, mia, ned, sam] = [await signUp(app, "br_owner"), await signUp(app, "br_mia"), await signUp(app, "br_ned"), await signUp(app, "br_sam")];
  const g = await group(app, owner, "楼里的群", [mia, ned]);
  const agent = await mustCreateAgent(app, owner, { handle: "helper_bot", name: "小助手", model: FAST, persona: "你是小助手，说话简短。" });
  expect((await api(app, owner, "POST", `/api/conversations/${g}/members`, { principalId: agent.id })).status).toBe(201);
  await befriend(app, owner, sam);
  return { owner, mia, ned, sam, g, agent };
}
/** The owner adds sam: a newcomer, whose joining is after everything so far. */
const samJoins = async (w: World): Promise<void> => {
  expect((await api(app, w.owner, "POST", `/api/conversations/${w.g}/members`, { principalId: w.sam.id })).status).toBe(201);
};

describe("a block made after a call, as the reply begins", () => {
  it("two calls, the first one's person blocked since: the second is still answered, and the first is no call it answers", async () => {
    const w = await world();
    const mine = await say(w.mia, w.g, "@helper_bot MIA-ASK-r1 上个月的账对了吗？");
    await samJoins(w);
    const theirs = await say(w.sam, w.g, "@helper_bot SAM-ASK-r1 我刚来，有什么要注意的？");
    expect((await latest(w.agent.id, w.g)).calls).toEqual([mine, theirs]);
    await block(w.owner, w.mia);

    gateway.reply("（回答新来的）");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(callsHere()).toHaveLength(1);
    const text = shownText(callsHere()[0]!);
    expect(text).toContain("SAM-ASK-r1");
    // mia's message is before the line (sam's joining): shown only as a call, and it is none now.
    expect(text).not.toContain("MIA-ASK-r1");
    const run = await latest(w.agent.id, w.g);
    expect(run).toMatchObject({ status: "done", error: null, lane: "others", caller: w.sam.id, calls: [theirs] });
    expect(run.askers).not.toContain(w.mia.id);
  });

  it("a later call folded in, its person and the owner blocked since: that call is dropped, the first is still answered — and a newcomer who blocks the owner still counts toward the line", async () => {
    const w = await world();
    await say(w.ned, w.g, "SECRET-r2 sam 进群前说的话");
    await samJoins(w);
    const mine = await say(w.mia, w.g, "@helper_bot MIA-ASK-r2 周末开会吗？");
    const theirs = await say(w.sam, w.g, "@helper_bot SAM-ASK-r2 我进群前大家说了什么？");
    expect((await latest(w.agent.id, w.g)).calls).toEqual([mine, theirs]);
    await block(w.sam, w.owner);

    gateway.reply("（回答米娅）");
    expect(await app.agentWorker.runOnce()).toBe(true);
    const text = shownText(callsHere()[0]!);
    expect(text).toContain("MIA-ASK-r2");
    // Its message is heard (it is shown, after the line), so sam's joining still bounds what the reply is shown.
    expect(text).not.toContain("SECRET-r2");
    const run = await latest(w.agent.id, w.g);
    expect(run).toMatchObject({ status: "done", error: null, lane: "others", caller: w.mia.id, calls: [mine] });
    // What it covers ended at the call it answered; the dropped call is not followed up (no queued reply after it).
    expect((await db.query("select covers_seq::int as covers from agent_runs where agent_id = $1 and status = 'done'", [w.agent.id])).rows).toEqual([{ covers: mine }]);
    expect((await db.query("select 1 from agent_runs where agent_id = $1 and status in ('queued', 'running')", [w.agent.id])).rowCount).toBe(0);
  });

  it("the owner's own call folded into a queued reply that holds a blocked member's call: that member's call is not answered, and the reply is the owner's own again", async () => {
    const w = await world();
    await samJoins(w);
    const theirs = await say(w.sam, w.g, "@helper_bot SAM-ASK-r3 帮我看看");
    await block(w.owner, w.sam);
    const own = await say(w.owner, w.g, "@helper_bot OWNER-ASK-r3 你也看看");
    // Queued with sam's call still in it: a reply for others, sam's (fix round 5); the block is met as it begins.
    expect(await latest(w.agent.id, w.g)).toMatchObject({ status: "queued", lane: "others", caller: w.sam.id, calls: [theirs, own] });

    gateway.reply("（回答主人）");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(shownText(callsHere()[0]!)).toContain("OWNER-ASK-r3");
    expect(await latest(w.agent.id, w.g)).toMatchObject({ status: "done", lane: "own", caller: w.owner.id, calls: [own], askers: [w.owner.id] });
  });

  it("the owner's retry of a reply whose only call's person is now blocked: it ends quietly — no call, nothing failed, nothing to retry", async () => {
    const w = await world();
    await say(w.mia, w.g, "@helper_bot MIA-ASK-r4 在吗？");
    await db.query("update agent_runs set status = 'failed', error = 'busy', finished_at = now() where agent_id = $1 and status = 'queued'", [w.agent.id]);
    await block(w.mia, w.owner);
    expect((await api(app, w.owner, "POST", `/api/conversations/${w.g}/runs/retry`, { agentId: w.agent.id })).status).toBe(201);
    expect(await latest(w.agent.id, w.g)).toMatchObject({ status: "queued", lane: "own" });

    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(callsHere()).toEqual([]);
    expect(await latest(w.agent.id, w.g)).toMatchObject({ status: "cancelled", error: null });
    expect((await api(app, w.mia, "GET", `/api/conversations/${w.g}/runs`)).json.runs).toEqual([]);
  });

  it("a follow-up whose only call is from someone blocked since it was noted: no second answer, no call", async () => {
    const w = await world();
    await say(w.mia, w.g, "@helper_bot MIA-ASK-r5 在吗？");
    const ticket = (await app.agentPort.claimNext())!;
    // Noted on the reply under way (its follow-up would answer it).
    const noted = await say(w.ned, w.g, "@helper_bot NED-ASK-r5 还有我");
    expect((await db.query<{ pending: number }>("select pending_seq::int as pending from agent_runs where id = $1", [ticket.id])).rows[0]!.pending).toBe(noted);
    await block(w.owner, w.ned);
    await app.agentPort.finish(ticket, { status: "done" }, null, NOTHING);
    // Whatever the follow-up does, ned's call is answered by nothing: no model call, no message, nothing still waiting.
    while (await app.agentWorker.runOnce());
    expect(callsHere()).toEqual([]);
    expect((await db.query("select 1 from messages where conversation_id = $1 and sender_id = $2 and kind = 'text'", [w.g, w.agent.id])).rowCount).toBe(0);
    const after = (await db.query<{ status: string; error: string | null }>("select status, error from agent_runs where agent_id = $1 and id <> $2", [w.agent.id, ticket.id])).rows;
    expect(after.every((r) => r.status === "cancelled" && r.error === null)).toBe(true);
  });

  it("a call relayed through another of the owner's Agents, the person behind it blocked since: dropped, the reply ends quietly", async () => {
    const w = await world();
    const relay = await mustCreateAgent(app, w.owner, { handle: "relay_bot", name: "传话", model: FAST, persona: "你负责传话。" });
    expect((await api(app, w.owner, "POST", `/api/conversations/${w.g}/members`, { principalId: relay.id })).status).toBe(201);
    await say(w.mia, w.g, "@relay_bot 帮我问问小助手");
    gateway.reply("@helper_bot RELAY-ASK-r6 米娅想问点事");
    expect(await app.agentWorker.runOnce()).toBe(true);
    // The relay's message called the Agent for mia, the person behind it.
    expect(await latest(w.agent.id, w.g)).toMatchObject({ status: "queued", lane: "others", caller: w.mia.id });
    await block(w.mia, w.owner);

    const before = callsHere().length;
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(callsHere()).toHaveLength(before);
    expect(await latest(w.agent.id, w.g)).toMatchObject({ status: "cancelled", error: null });
  });

  it("the owner's own call noted after the claim, the first caller blocked since: the reply becomes the owner's own (lane own, caller the owner)", async () => {
    const w = await world();
    // (A model that thinks, at the owner's own level; replies for others are set to none: what the call is prepared at tells whose it is.)
    await grant(db, w.owner.id, 1_000n * 1_000_000n);
    expect((await api(app, w.owner, "PATCH", `/api/agents/${w.agent.id}`, { model: { source: "site", id: "thinker" }, reasoning: "low", othersReasoning: "none" })).status).toBe(200);
    await say(w.mia, w.g, "@helper_bot MIA-ASK-r7 在吗？");
    const ticket = (await app.agentPort.claimNext())!;
    const own = await say(w.owner, w.g, "@helper_bot OWNER-ASK-r7 我也问一句");
    // Noted while it ran: it is still mia's (a call noted on a running reply changes neither caller nor lane).
    expect(await latest(w.agent.id, w.g)).toMatchObject({ status: "running", lane: "others", caller: w.mia.id });
    await block(w.owner, w.mia);

    const prepared = await app.agentPort.begin(ticket);
    expect("call" in prepared).toBe(true);
    expect(await latest(w.agent.id, w.g)).toMatchObject({ status: "running", lane: "own", caller: w.owner.id, calls: [own] });
    // The owner's own reply: its own level and its model's own output limit (with the level's allowance), not the bounds of a reply for others.
    const call = (prepared as unknown as { call: ModelCall }).call;
    expect(call.reasoning).toBe("low");
    expect(call.maxOutputTokens).toBeGreaterThan(app.deps.config.others.outputTokens + app.deps.config.reasoningAllowanceTokens.low);
    const recorded = (await db.query<{ reasoning: string }>("select reasoning from agent_runs where id = $1", [ticket.id])).rows[0]!;
    expect(recorded.reasoning).toBe("low");
    expect((await latest(w.agent.id, w.g)).askers).not.toContain(w.mia.id);
    await app.agentPort.releaseRun(ticket.id);
  });

  it("the owner's own chain relayed by someone else's Agent, whose owner the owner blocks since: its only asker is the owner, yet the relayed call is dropped and the reply ends quietly", async () => {
    const w = await world();
    const theirs = await mustCreateAgent(app, w.mia, { handle: "mia_bot", name: "米娅的助手", model: FAST, persona: "你是米娅的助手。" });
    expect((await api(app, w.mia, "POST", `/api/conversations/${w.g}/members`, { principalId: theirs.id })).status).toBe(201);
    await say(w.owner, w.g, "@mia_bot 帮我问问小助手");
    gateway.reply("@helper_bot MIA-RELAY-r8 主人让我问你");
    expect(await app.agentWorker.runOnce()).toBe(true);
    // mia's Agent called it for the owner: the owner's own call, whose one asker is the owner.
    expect(await latest(w.agent.id, w.g)).toMatchObject({ status: "queued", lane: "own", caller: w.owner.id, askers: [w.owner.id] });
    await block(w.owner, w.mia);

    const before = callsHere().length;
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(callsHere()).toHaveLength(before);
    expect(await latest(w.agent.id, w.g)).toMatchObject({ status: "cancelled", error: null });
  });

  it("the owner's chain relayed by someone else's Agent with a member's call folded in, the relay dropped since: the reply is the member's (lane others, caller the member), bounded and counted as a reply for others", async () => {
    const w = await world();
    const theirs = await mustCreateAgent(app, w.mia, { handle: "mia_bot", name: "米娅的助手", model: FAST, persona: "你是米娅的助手。" });
    expect((await api(app, w.mia, "POST", `/api/conversations/${w.g}/members`, { principalId: theirs.id })).status).toBe(201);
    await say(w.owner, w.g, "@mia_bot 帮我问问小助手");
    gateway.reply("@helper_bot MIA-RELAY-r9 主人让我问你");
    expect(await app.agentWorker.runOnce()).toBe(true);
    const mine = await say(w.ned, w.g, "@helper_bot NED-ASK-r9 我也问一句");
    // Folded into the owner's reply: a reply for others now, ned's — not every call it answers is the owner's (fix round 5).
    const queued = await latest(w.agent.id, w.g);
    expect(queued).toMatchObject({ status: "queued", lane: "others", caller: w.ned.id });
    expect(queued.calls).toHaveLength(2);
    expect(queued.calls!.at(-1)).toBe(mine);
    await block(w.owner, w.mia);

    const before = callsHere().length;
    gateway.reply("（回答 ned）");
    expect(await app.agentWorker.runOnce()).toBe(true);
    // Only ned's call survived: the reply is his, in the lane somebody other than the owner calls for.
    expect(await latest(w.agent.id, w.g)).toMatchObject({ status: "done", lane: "others", caller: w.ned.id, calls: [mine] });
    const call = callsHere()[before]!;
    expect(shownText(call)).toContain("NED-ASK-r9");
    expect(call.maxOutputTokens).toBe(app.deps.config.others.outputTokens);
    // It counts against the owner's numbers for others: one answer today.
    expect((await api(app, w.owner, "GET", "/api/me/others-use")).json.used.answers).toBe(1);
  });

  // Fix round 3, ruling 1, its first rule as fix round 5 changed it: two rules, each named by its own test so neither is an accident.
  describe("after a drop, whose reply it is (ruling 1)", () => {
    const othersLimit = () => app.deps.config.others.outputTokens;
    const answersForOthers = async (owner: Actor) => (await api(app, owner, "GET", "/api/me/others-use")).json.used.answers as number;

    it("rule A — a reply is the owner's own only while EVERY call it has left is the owner's own (fix round 5): with a member's call left beside the owner's after another is dropped, it is that member's — lane others, bounded, counted as a reply for others", async () => {
      const w = await world();
      await samJoins(w);
      const dropped = await say(w.sam, w.g, "@helper_bot SAM-ASK-rA 帮我看看");
      const kept = await say(w.mia, w.g, "@helper_bot MIA-ASK-rA 我也问一句");
      const own = await say(w.owner, w.g, "@helper_bot OWNER-ASK-rA 你也看看");
      expect(await latest(w.agent.id, w.g)).toMatchObject({ status: "queued", lane: "others", caller: w.sam.id, calls: [dropped, kept, own] });
      await block(w.owner, w.sam);

      gateway.reply("（回答主人和米娅）");
      expect(await app.agentWorker.runOnce()).toBe(true);
      const run = await latest(w.agent.id, w.g);
      expect(run).toMatchObject({ status: "done", error: null, lane: "others", caller: w.mia.id, calls: [kept, own] });
      expect(run.askers).not.toContain(w.sam.id);
      const call = callsHere()[0]!;
      expect(shownText(call)).toContain("OWNER-ASK-rA");
      // A reply for others: the output limit such a reply is held to.
      expect(call.maxOutputTokens).toBe(othersLimit());
      expect(await answersForOthers(w.owner)).toBe(1);
    });

    it("rule B — the owner's retry is the owner's own: retrying a reply to two other people's calls, one of them dropped since, it keeps lane own with the call left, not bounded, and no reply for others is counted", async () => {
      const w = await world();
      // (The dropped call is the earlier one: a refused person who wrote AFTER the call left is still heard, and so among its askers.)
      const dropped = await say(w.ned, w.g, "@helper_bot NED-ASK-rB 我也问一句");
      const kept = await say(w.mia, w.g, "@helper_bot MIA-ASK-rB 在吗？");
      expect(await latest(w.agent.id, w.g)).toMatchObject({ status: "queued", lane: "others", calls: [dropped, kept] });
      await db.query("update agent_runs set status = 'failed', error = 'busy', finished_at = now() where agent_id = $1 and status = 'queued'", [w.agent.id]);
      expect((await api(app, w.owner, "POST", `/api/conversations/${w.g}/runs/retry`, { agentId: w.agent.id })).status).toBe(201);
      expect(await latest(w.agent.id, w.g)).toMatchObject({ status: "queued", lane: "own" });
      await block(w.owner, w.ned);

      gateway.reply("（回答米娅）");
      expect(await app.agentWorker.runOnce()).toBe(true);
      const run = await latest(w.agent.id, w.g);
      expect(run).toMatchObject({ status: "done", error: null, lane: "own", calls: [kept] });
      expect(run.askers).not.toContain(w.ned.id);
      const call = callsHere()[0]!;
      expect(shownText(call)).toContain("MIA-ASK-rB");
      expect(call.maxOutputTokens).toBeGreaterThan(othersLimit());
      expect(await answersForOthers(w.owner)).toBe(0);
    });
  });
});
