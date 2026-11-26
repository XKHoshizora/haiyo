import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NOTHING } from "../src/agents/runtime/port.ts";
import { othersUseToday } from "../src/metering/others.ts";
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
 * the others are still answered, and only a reply with no call left ends, quietly. Whatever the reply's lane: the owner's retry
 * included. A drop takes a call out and changes nothing else (limits redesign, Part 2): the reply keeps its lane and caller, and a
 * call that waited behind it is held to the same rule as it is taken. Driven through the real routes; the worker by hand.
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
/** What a scripted reply reports, so that it is charged. */
const USAGE = { inputTokens: 900, outputTokens: 20 };
/** The output limit of the site model `fast`. */
const fastOutput = () => app.deps.config.siteModels.find((m) => m.id === "fast")!.maxOutputTokens;
/** Others' use of `owner`'s Agents today, in lane others. */
const forOthersToday = (owner: Actor) => othersUseToday(db, app.deps.config, owner.id, new Date(), "others");
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

/** The Agent's runs in `conv`, oldest first. */
const runs = async (agentId: string, conv: string): Promise<RunView[]> =>
  (
    await db.query<RunView>(
      `select status, error, lane, caller_id as caller, call_seqs::int[] as calls, asker_ids::text[] as askers
         from agent_runs where agent_id = $1 and conversation_id = $2 order by created_at, id`,
      [agentId, conv],
    )
  ).rows;

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
  it("the reply's only call, its person blocked since: the reply ends quietly as the member's (its lane and caller as they were), and the newcomer's call that waited behind it gets its own reply — mia's question no call of it", async () => {
    const w = await world();
    await say(w.mia, w.g, "@helper_bot MIA-ASK-r1 上个月的账对了吗？");
    await samJoins(w);
    const theirs = await say(w.sam, w.g, "@helper_bot SAM-ASK-r1 我刚来，有什么要注意的？");
    await block(w.owner, w.mia);

    gateway.reply("（回答新来的）");
    while (await app.agentWorker.runOnce());
    expect(callsHere()).toHaveLength(1);
    const text = shownText(callsHere()[0]!);
    expect(text).toContain("SAM-ASK-r1");
    // mia's message is before the line (sam's joining) and no call of sam's reply.
    expect(text).not.toContain("MIA-ASK-r1");
    const all = await runs(w.agent.id, w.g);
    expect(all.map((r) => [r.status, r.error, r.lane, r.caller])).toEqual([
      ["cancelled", null, "others", w.mia.id],
      ["done", null, "others", w.sam.id],
    ]);
    expect(all[1]).toMatchObject({ calls: [theirs] });
    expect(all[1]!.askers).not.toContain(w.mia.id);
  });

  it("a call that waited, its person and the owner blocked since: it is dropped as it is taken, and the reply before it is answered as it was", async () => {
    const w = await world();
    await samJoins(w);
    const mine = await say(w.mia, w.g, "@helper_bot MIA-ASK-r2 周末开会吗？");
    await say(w.sam, w.g, "@helper_bot SAM-ASK-r2 我进群前大家说了什么？");
    await block(w.sam, w.owner);

    gateway.reply("（回答米娅）");
    while (await app.agentWorker.runOnce());
    expect(callsHere()).toHaveLength(1);
    const text = shownText(callsHere()[0]!);
    expect(text).toContain("MIA-ASK-r2");
    // The reply ends at its call: sam's message after it is not shown it.
    expect(text).not.toContain("SAM-ASK-r2");
    expect(await runs(w.agent.id, w.g)).toMatchObject([{ status: "done", error: null, lane: "others", caller: w.mia.id, calls: [mine] }]);
    expect((await db.query("select 1 from agent_runs where agent_id = $1 and status in ('queued', 'running')", [w.agent.id])).rowCount).toBe(0);
    expect((await db.query("select 1 from deferred_calls where agent_id = $1", [w.agent.id])).rowCount).toBe(0);
  });

  it("the owner's own call waiting behind a queued reply whose only call's person is blocked since: that reply ends quietly as theirs, and the owner's call gets its own reply, the owner's own", async () => {
    const w = await world();
    await samJoins(w);
    await say(w.sam, w.g, "@helper_bot SAM-ASK-r3 帮我看看");
    await block(w.owner, w.sam);
    const own = await say(w.owner, w.g, "@helper_bot OWNER-ASK-r3 你也看看");
    // The owner's call is of another identity: it waits behind sam's reply, never folded into it.
    expect(await latest(w.agent.id, w.g)).toMatchObject({ status: "queued", lane: "others", caller: w.sam.id, calls: [expect.any(Number)] });

    gateway.reply("（回答主人）");
    while (await app.agentWorker.runOnce());
    expect(callsHere()).toHaveLength(1);
    expect(shownText(callsHere()[0]!)).toContain("OWNER-ASK-r3");
    expect((await runs(w.agent.id, w.g)).map((r) => [r.status, r.lane, r.caller])).toEqual([
      ["cancelled", "others", w.sam.id],
      ["done", "own", w.owner.id],
    ]);
    expect(await latest(w.agent.id, w.g)).toMatchObject({ calls: [own], askers: [w.owner.id] });
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

  it("a call that waited, from someone blocked since: no second answer, no call", async () => {
    const w = await world();
    await say(w.mia, w.g, "@helper_bot MIA-ASK-r5 在吗？");
    const ticket = (await app.agentPort.claimNext())!;
    // It waits behind the reply under way.
    const noted = await say(w.ned, w.g, "@helper_bot NED-ASK-r5 还有我");
    expect((await db.query<{ seq: number }>("select message_seq::int as seq from deferred_calls where agent_id = $1", [w.agent.id])).rows).toEqual([{ seq: noted }]);
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

  it("the owner's own call waiting after the claim, the first caller blocked since: the member's reply ends quietly as the member's, and the owner's call is answered by a reply of its own on the owner's terms", async () => {
    const w = await world();
    // (A model that thinks, at the owner's own level; replies for others are set to none: what the call is prepared at tells whose it is.)
    await grant(db, w.owner.id, 1_000n * 1_000_000n);
    expect((await api(app, w.owner, "PATCH", `/api/agents/${w.agent.id}`, { model: { source: "site", id: "thinker" }, reasoning: "low", othersReasoning: "none" })).status).toBe(200);
    await say(w.mia, w.g, "@helper_bot MIA-ASK-r7 在吗？");
    const ticket = (await app.agentPort.claimNext())!;
    const own = await say(w.owner, w.g, "@helper_bot OWNER-ASK-r7 我也问一句");
    expect(await latest(w.agent.id, w.g)).toMatchObject({ status: "running", lane: "others", caller: w.mia.id });
    await block(w.owner, w.mia);

    const ended = await app.agentPort.begin(ticket);
    expect(ended).toEqual({ status: "cancelled" });
    await app.agentPort.finish(ticket, ended as { status: "cancelled" }, null, NOTHING);
    expect((await runs(w.agent.id, w.g))[0]).toMatchObject({ status: "cancelled", lane: "others", caller: w.mia.id });
    const next = (await app.agentPort.claimNext())!;
    const prepared = await app.agentPort.begin(next);
    expect("call" in prepared).toBe(true);
    expect(await latest(w.agent.id, w.g)).toMatchObject({ status: "running", lane: "own", caller: w.owner.id, calls: [own] });
    // The owner's own reply: its own level, not the level the owner set for replies to others.
    const call = (prepared as unknown as { call: ModelCall }).call;
    expect(call.reasoning).toBe("low");
    expect((await latest(w.agent.id, w.g)).askers).not.toContain(w.mia.id);
    expect(callsHere()).toEqual([]);
    await app.agentPort.releaseRun(next.id);
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

  it("the owner's chain relayed by someone else's Agent, a member's call waiting behind it, the relay dropped since: the owner's reply ends quietly as the owner's, and the member's call gets its own reply — counted in others' use of the owner's Agents", async () => {
    const w = await world();
    const theirs = await mustCreateAgent(app, w.mia, { handle: "mia_bot", name: "米娅的助手", model: FAST, persona: "你是米娅的助手。" });
    expect((await api(app, w.mia, "POST", `/api/conversations/${w.g}/members`, { principalId: theirs.id })).status).toBe(201);
    await say(w.owner, w.g, "@mia_bot 帮我问问小助手");
    gateway.reply("@helper_bot MIA-RELAY-r9 主人让我问你");
    expect(await app.agentWorker.runOnce()).toBe(true);
    const mine = await say(w.ned, w.g, "@helper_bot NED-ASK-r9 我也问一句");
    // The owner's reply is queued (the relay is the owner's call); ned's call, of another identity, waits behind it.
    expect(await latest(w.agent.id, w.g)).toMatchObject({ status: "queued", lane: "own", caller: w.owner.id });
    await block(w.owner, w.mia);

    const before = callsHere().length;
    gateway.reply("（回答 ned）", { usage: USAGE });
    while (await app.agentWorker.runOnce());
    expect((await runs(w.agent.id, w.g)).map((r) => [r.status, r.lane, r.caller])).toEqual([
      ["cancelled", "own", w.owner.id],
      ["done", "others", w.ned.id],
    ]);
    expect(await latest(w.agent.id, w.g)).toMatchObject({ calls: [mine] });
    const call = callsHere()[before]!;
    expect(shownText(call)).toContain("NED-ASK-r9");
    // Made as the owner's own would be (the model's own output limit), and counted in others' use of the owner's Agents today.
    expect(call.maxOutputTokens).toBe(fastOutput());
    expect(await forOthersToday(w.owner)).toBeGreaterThan(0n);
  });

  // Fix round 3, ruling 1, as the limits redesign (Part 2) settles it: a drop takes a call out and changes nothing else.
  describe("after a drop, whose reply it is (ruling 1)", () => {

    it("rule A — a reply's lane and caller are never changed by a drop: sam's reply ends quietly as sam's; mia's and the owner's calls, each of its own identity, get replies of their own — mia's counted in others' use", async () => {
      const w = await world();
      await samJoins(w);
      await say(w.sam, w.g, "@helper_bot SAM-ASK-rA 帮我看看");
      const kept = await say(w.mia, w.g, "@helper_bot MIA-ASK-rA 我也问一句");
      const own = await say(w.owner, w.g, "@helper_bot OWNER-ASK-rA 你也看看");
      await block(w.owner, w.sam);

      gateway.reply("（回答米娅）", { usage: USAGE }).reply("（回答主人）", { usage: USAGE });
      while (await app.agentWorker.runOnce());
      const all = await runs(w.agent.id, w.g);
      expect(all.map((r) => [r.status, r.lane, r.caller, r.calls])).toEqual([
        ["cancelled", "others", w.sam.id, expect.any(Array)],
        ["done", "others", w.mia.id, [kept]],
        ["done", "own", w.owner.id, [own]],
      ]);
      // Neither reply after sam's carries his question.
      for (const r of all.slice(1)) expect(r.askers ?? []).not.toContain(w.sam.id);
      const [toMia] = callsHere();
      expect(shownText(toMia!)).toContain("MIA-ASK-rA");
      expect(toMia!.maxOutputTokens).toBe(fastOutput());
      expect(await forOthersToday(w.owner)).toBeGreaterThan(0n);
    });

    it("rule B — the owner's retry is the owner's own: retrying a reply to a member's two calls, one of them refused by a limit since, it keeps lane own with the call left, and nothing is counted in others' use", async () => {
      const w = await world();
      const dropped = await say(w.mia, w.g, "@helper_bot MIA-ASK-rB 我也问一句");
      const kept = await say(w.mia, w.g, "@helper_bot MIA-ASK-rB 在吗？");
      expect(await latest(w.agent.id, w.g)).toMatchObject({ status: "queued", lane: "others", calls: [dropped, kept] });
      await db.query("update agent_runs set status = 'failed', error = 'busy', finished_at = now() where agent_id = $1 and status = 'queued'", [w.agent.id]);
      expect((await api(app, w.owner, "POST", `/api/conversations/${w.g}/runs/retry`, { agentId: w.agent.id })).status).toBe(201);
      expect(await latest(w.agent.id, w.g)).toMatchObject({ status: "queued", lane: "own" });
      await db.query("insert into call_refusals (conversation_id, seq, agent_id, sender_id, reason) values ($1, $2, $3, $4, 'too_often')", [w.g, dropped, w.agent.id, w.mia.id]);


      gateway.reply("（回答米娅）", { usage: USAGE });
      expect(await app.agentWorker.runOnce()).toBe(true);
      const run = await latest(w.agent.id, w.g);
      expect(run).toMatchObject({ status: "done", error: null, lane: "own", calls: [kept] });
      expect(run.askers).not.toContain(w.ned.id);
      const call = callsHere()[0]!;
      expect(shownText(call)).toContain("MIA-ASK-rB");
      expect(call.maxOutputTokens).toBe(fastOutput());
      expect(await forOthersToday(w.owner)).toBe(0n);
    });
  });
});
