import { afterEach, describe, expect, it } from "vitest";
import { recoverRuns } from "../src/agents/port-impl.ts";
import { NOTHING } from "../src/agents/runtime/port.ts";
import { admit, admitRun } from "../src/metering/admit.ts";
import { OWN_KEY_NOMINAL_MICRO, othersReplyCeilingMicro, othersUseToday, OthersLimit } from "../src/metering/others.ts";
import { maxCostMicro } from "../src/metering/prices.ts";
import { settle } from "../src/metering/settle.ts";
import { api, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { paidReply, grant } from "./helpers/metering.ts";
import { agentsOf, BIG_MODEL, OTHERS_ENV, PAID_MODEL, POINT, providerAgent, seedRun, setOwnerLimit } from "./helpers/others.ts";
import { boxOf, othersKitchen } from "./helpers/others-kitchen.ts";
import { connect, closeAllSockets } from "./helpers/ws.ts";

/**
 * Limits redesign, Part 1 (".superpowers/sdd/2026-11-22-polish/limits-redesign-design.md"): ONE number per owner, N (default 300
 * points), for everything people other than the owner cause on all the owner's Agents (lanes `others` and `proactive`); one measure,
 * "others' use today" — settled wallet charges of those replies plus a nominal 6 points, counted and never charged, once per admitted
 * reply chain on the owner's own provider key; admission while the measure is below N, nothing reserved against it; replies to others
 * sized as the owner's own at the Agent's `othersReasoning`, nothing cut for cost; every LIMIT refusal a line for its sender alone.
 */

const lines: string[] = [];
const { app, db } = useApp({ env: OTHERS_ENV, agentWorker: false, logStream: { write: (line) => void lines.push(line) } });
afterEach(async () => {
  await closeAllSockets();
  lines.length = 0;
});

let n = 0;
const newOwner = (): Promise<Actor> => signUp(app, `on${++n}x${Math.floor(Math.random() * 1e6)}`);
const config = () => app.deps.config;

/** A reply run of `agent` on a provider's model in `lane`, admitted at `at` (a chain of its own unless `retryOf`). */
async function providerRun(o: { ownerId: string; agent: { agentId: string; conversationId: string }; lane: "own" | "others" | "proactive"; status?: string; at?: Date; retryOf?: string | null }): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, started_at, finished_at, lane, source, model, admitted_at, retry_of, money_rule)
     values ('reply', $1, $2, $3, $4, now(), case when $4 in ('done', 'failed') then now() end, $5, 'provider', 'mine', $6, $7, 1) returning id`,
    [o.agent.conversationId, o.agent.agentId, o.ownerId, o.status ?? "done", o.lane, o.at ?? new Date(), o.retryOf ?? null],
  );
  return rows[0]!.id;
}

/** The message a person sent, as `who` reads it now (`GET …/messages`). */
async function readAs(who: Actor, conversationId: string, seq: number): Promise<Record<string, unknown> | undefined> {
  const page = await api(app, who, "GET", `/api/conversations/${conversationId}/messages`);
  return (page.json.messages as Array<Record<string, unknown>>).find((m) => m.seq === seq);
}

describe("the one measure", () => {
  it("is today's settled charges of the owner's others' and proactive replies, every Agent together: not the owner's own, not yesterday's, not what running replies hold", async () => {
    const owner = await newOwner();
    const [a, b] = await agentsOf(app, db, owner, 2);
    await paidReply(db, { agentId: a!.agentId, ownerId: owner.id, conversationId: a!.conversationId, lane: "others", micro: 2_500_000n });
    await paidReply(db, { agentId: b!.agentId, ownerId: owner.id, conversationId: b!.conversationId, lane: "proactive", micro: 1_000_000n });
    await paidReply(db, { agentId: a!.agentId, ownerId: owner.id, conversationId: a!.conversationId, lane: "own", micro: 9_000_000n });
    await paidReply(db, { agentId: a!.agentId, ownerId: owner.id, conversationId: a!.conversationId, lane: "others", micro: 8_000_000n, at: new Date(Date.now() - 36 * 3600_000) });
    await seedRun(db, { ownerId: owner.id, agent: b!, lane: "others", hold: 50n * POINT, admittedAt: new Date() });
    expect(await othersUseToday(db, config(), owner.id, new Date())).toBe(3_500_000n);
    expect(await othersUseToday(db, config(), owner.id, new Date(), "proactive")).toBe(1_000_000n);
  });

  it("counts 6 points, never charged, once per reply chain on the owner's own provider key admitted today, failed attempts included", async () => {
    const owner = await newOwner();
    const mine = await providerAgent(app, db, owner);
    const balance = async () => (await db.query<{ b: string }>("select coalesce((select balance_micro::text from accounts where principal_id = $1), '0') as b", [owner.id])).rows[0]!.b;
    const before = await balance();
    const first = await providerRun({ ownerId: owner.id, agent: mine, lane: "others", status: "failed" });
    expect(OWN_KEY_NOMINAL_MICRO).toBe(6n * POINT);
    expect(await othersUseToday(db, config(), owner.id, new Date())).toBe(6n * POINT);
    // Its automatic retry is the same chain: still one.
    await providerRun({ ownerId: owner.id, agent: mine, lane: "others", retryOf: first });
    expect(await othersUseToday(db, config(), owner.id, new Date())).toBe(6n * POINT);
    // A reply nobody asked for counts the same; the owner's own reply and one admitted yesterday do not; nor one never admitted.
    await providerRun({ ownerId: owner.id, agent: mine, lane: "proactive" });
    await providerRun({ ownerId: owner.id, agent: mine, lane: "own" });
    await providerRun({ ownerId: owner.id, agent: mine, lane: "others", at: new Date(Date.now() - 36 * 3600_000) });
    await db.query("insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, lane) values ('reply', $1, $2, $3, 'queued', 'others')", [mine.conversationId, mine.agentId, owner.id]);
    expect(await othersUseToday(db, config(), owner.id, new Date())).toBe(12n * POINT);
    expect(await othersUseToday(db, config(), owner.id, new Date(), "proactive")).toBe(6n * POINT);
    // Counted, never charged.
    expect(await balance()).toBe(before);
  });
});

describe("admission", () => {
  it("admits an others' reply while use is below N, whatever it may cost (nothing is reserved against N), and refuses one once use has reached it", async () => {
    const owner = await newOwner();
    await grant(db, owner.id, 10_000n * POINT);
    const [paid] = await agentsOf(app, db, owner, 1, PAID_MODEL);
    await setOwnerLimit(db, owner.id, 10n * POINT);
    const resolved = paid!.resolved;
    const runId = await seedRun(db, { ownerId: owner.id, agent: paid!, lane: "others" });
    // One call of this model can cost far more than N (60 000 input tokens at 3 000, 800 output at 15 000: 192 points): admitted.
    expect(maxCostMicro(resolved, 60_000)).toBeGreaterThan(10n * POINT);
    await paidReply(db, { agentId: paid!.agentId, ownerId: owner.id, conversationId: paid!.conversationId, lane: "others", micro: 10n * POINT - 1n });
    const admitted = await db.tx((t) => admit(t, config(), owner.id, resolved, 60_000, new Date(), "reply", 0n, runId, "others"));
    expect(admitted.holdMicro).toBe(maxCostMicro(resolved, 60_000));
    // At N: refused, nothing held.
    await paidReply(db, { agentId: paid!.agentId, ownerId: owner.id, conversationId: paid!.conversationId, lane: "proactive", micro: 1n });
    await expect(db.tx((t) => admit(t, config(), owner.id, resolved, 10, new Date(), "reply", 0n, runId, "others"))).rejects.toBeInstanceOf(OthersLimit);
    await expect(db.tx((t) => admit(t, config(), owner.id, resolved, 10, new Date(), "reply", 0n, runId, "proactive"))).rejects.toBeInstanceOf(OthersLimit);
    // The owner's own reply never meets N.
    expect((await db.tx((t) => admit(t, config(), owner.id, resolved, 10, new Date(), "reply", 0n, runId, null))).chargeTo).toBe("balance");
  });

  it("an Agent on the owner's own key is refused once its chains' nominal count reaches N", async () => {
    const owner = await newOwner();
    const mine = await providerAgent(app, db, owner);
    await setOwnerLimit(db, owner.id, 12n * POINT);
    const runId = await seedRun(db, { ownerId: owner.id, agent: mine, lane: "others" });
    await providerRun({ ownerId: owner.id, agent: mine, lane: "others" });
    expect((await db.tx((t) => admit(t, config(), owner.id, mine.resolved, 10, new Date(), "reply", 0n, runId, "others"))).chargeTo).toBeNull();
    await providerRun({ ownerId: owner.id, agent: mine, lane: "others" });
    await expect(db.tx((t) => admit(t, config(), owner.id, mine.resolved, 10, new Date(), "reply", 0n, runId, "others"))).rejects.toBeInstanceOf(OthersLimit);
  });

  it("admission keeps a given last call's room on the free allowance only, for an others' reply as for the owner's own (how large that room is, the one calculation for both: others-reserve.test.ts)", async () => {
    const owner = await newOwner();
    await grant(db, owner.id, 10_000n * POINT);
    const [free] = await agentsOf(app, db, owner, 1);
    const [paid] = await agentsOf(app, db, owner, 1, PAID_MODEL);
    const last = 5n * POINT;
    for (const [agent, keeps] of [[free!, true], [paid!, false]] as const) {
      for (const lane of [null, "others"] as const) {
        const runId = await seedRun(db, { ownerId: owner.id, agent, lane: lane ?? "own" });
        const got = await db.tx((t) => admit(t, config(), owner.id, agent.resolved, 1000, new Date(), "reply", last, runId, lane));
        expect([lane, got.holdMicro]).toEqual([lane, maxCostMicro(agent.resolved, 1000) + (keeps ? last : 0n)]);
        await db.query("update agent_runs set status = 'done', hold_micro = 0 where id = $1", [runId]);
      }
    }
  });
});

describe("admission across connections and days", () => {
  it("two replies admitted at once on two connections while use is below N: both are, nothing being reserved; the day passes N by them alone", async () => {
    const owner = await newOwner();
    await grant(db, owner.id, 10_000n * POINT);
    const [a, b] = await agentsOf(app, db, owner, 2, PAID_MODEL);
    await setOwnerLimit(db, owner.id, 10n * POINT);
    await paidReply(db, { agentId: a!.agentId, ownerId: owner.id, conversationId: a!.conversationId, lane: "others", micro: 9n * POINT });
    const [r1, r2] = [await seedRun(db, { ownerId: owner.id, agent: a!, lane: "others" }), await seedRun(db, { ownerId: owner.id, agent: b!, lane: "others" })];
    const admitBoth = await Promise.allSettled([
      db.tx((t) => admitRun(t, config(), r1, owner.id, a!.resolved, 20_000, () => new Date())),
      db.tx((t) => admitRun(t, config(), r2, owner.id, b!.resolved, 20_000, () => new Date())),
    ]);
    expect(admitBoth.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    // Settled, they pass N; the next reply for others is refused.
    for (const id of [r1, r2]) {
      await db.tx((t) => settle(t, config(), id, { inputTokens: 1000, outputTokens: 100 }, { inputChars: 0, outputChars: 0 }, "done", new Date(), { log: { warn: () => undefined } }));
      await db.query("update agent_runs set status = 'done', finished_at = now() where id = $1", [id]);
    }
    expect(await othersUseToday(db, config(), owner.id, new Date())).toBeGreaterThan(10n * POINT);
    const r3 = await seedRun(db, { ownerId: owner.id, agent: a!, lane: "others" });
    await expect(db.tx((t) => admitRun(t, config(), r3, owner.id, a!.resolved, 10, () => new Date()))).rejects.toBeInstanceOf(OthersLimit);
  });

  /**
   * Holds `ownerId`'s account row (as a raise of their number does) in a transaction of its own, writing `pointsMicro` as their
   * number, until `release`; resolves `locked` once it holds it.
   */
  const raising = (ownerId: string, pointsMicro: bigint) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const held = new Promise<void>((r) => (locked = r));
    const done = db.tx(async (t) => {
      await t.query("select 1 from accounts where principal_id = $1 for update", [ownerId]);
      await t.query("update accounts set others_points_micro = $2 where principal_id = $1", [ownerId, pointsMicro.toString()]);
      locked();
      await gate;
    });
    return { held, release: () => release(), done };
  };

  for (const where of ["a group", "a follow-up"] as const) {
    it(`a refusal by N is decided under the owner's account lock (${where}): a raise committing meanwhile is waited for, and the call is answered`, async () => {
      const k = await othersKitchen(app, db);
      await setOwnerLimit(db, k.owner.id, POINT);
      await paidReply(db, { agentId: k.agent.id, ownerId: k.owner.id, conversationId: k.agent.conversationId, lane: "others", micro: POINT });
      let ticket: Awaited<ReturnType<typeof k.port.claimNext>> = null;
      if (where === "a follow-up") {
        // A reply under way with the third's call noted on it; it ends while the raise holds the account.
        await db.query("update accounts set others_points_micro = $2 where principal_id = $1", [k.owner.id, (10n * POINT).toString()]);
        await k.ask("@chef 一");
        ticket = await k.port.claimNext();
        expect((await api(app, k.third, "POST", `/api/conversations/${k.g}/messages`, { text: "@chef 二", clientTxn: "f2f" })).status).toBe(201);
        await setOwnerLimit(db, k.owner.id, POINT);
      }
      const raise = raising(k.owner.id, 2n * POINT);
      await raise.held;
      const deciding =
        where === "a group"
          ? api(app, k.member, "POST", `/api/conversations/${k.g}/messages`, { text: "@chef 在吗", clientTxn: "f2g" })
          : k.port.finish(ticket!, { status: "done" }, null, NOTHING);
      // It waits for the account the raise holds (it does not decide on what it read before).
      await new Promise((r) => setTimeout(r, 300));
      raise.release();
      await raise.done;
      const result = await deciding;
      if (where === "a group") expect((result as { json: { message: Record<string, unknown> } }).json.message).not.toHaveProperty("refused");
      expect((await db.query("select 1 from call_refusals where agent_id = $1", [k.agent.id])).rowCount).toBe(0);
      expect((await db.query("select 1 from agent_runs where conversation_id = $1 and status = 'queued'", [k.g])).rowCount).toBe(1);
    });
  }

  it("the site day's edge: a reply admitted at 00:00:01 is counted on the new day, read under the account lock; a chain begun yesterday and retried today counts on both days", async () => {
    const owner = await newOwner();
    const mine = await providerAgent(app, db, owner);
    const before = new Date("2026-03-02T15:59:58Z"); // 23:59:58 in Shanghai on 2 March
    const after = new Date("2026-03-02T16:00:01Z"); // 00:00:01 on 3 March
    const run = await seedRun(db, { ownerId: owner.id, agent: mine, lane: "others" });
    await db.query("update agent_runs set started_at = $2 where id = $1", [run, before]);
    await db.tx((t) => admitRun(t, config(), run, owner.id, mine.resolved, 10, after));
    expect(await othersUseToday(db, config(), owner.id, after)).toBe(6n * POINT);
    expect(await othersUseToday(db, config(), owner.id, before)).toBe(0n);
    await db.query("update agent_runs set status = 'failed', finished_at = now() where id = $1", [run]);
    const retry = await seedRun(db, { ownerId: owner.id, agent: mine, lane: "others", retryOf: run });
    const nextDay = new Date("2026-03-03T16:00:05Z");
    await db.tx((t) => admitRun(t, config(), retry, owner.id, mine.resolved, 10, nextDay));
    expect(await othersUseToday(db, config(), owner.id, after)).toBe(6n * POINT);
    expect(await othersUseToday(db, config(), owner.id, nextDay)).toBe(6n * POINT);
  });
});

describe("a reply to someone else is made as the owner's own is, at the Agent's othersReasoning", () => {
  it("its calls have the model's own output limit at that level, never a smaller one for others", async () => {
    const k = await othersKitchen(app, db, { box: boxOf(), agent: { model: BIG_MODEL, reasoning: "none", othersReasoning: "low" } });
    k.gateway.reply("好。").reply("好。");
    await k.ask();
    expect(await k.worker.runOnce()).toBe(true);
    await k.askAsOwner();
    expect(await k.worker.runOnce()).toBe(true);
    const allowance = config().reasoningAllowanceTokens.low;
    expect(k.gateway.calls[0]).toMatchObject({ reasoning: "low", maxOutputTokens: 4096 + allowance });
    expect(k.gateway.calls[1]).toMatchObject({ reasoning: "none", maxOutputTokens: 4096 });
  });

  it("its answer and its acknowledgement are posted whole, however long: nothing is cut for cost", async () => {
    const k = await othersKitchen(app, db, { box: boxOf() });
    const ack = "我先查一下。".repeat(300);
    const answer = "川菜很好吃。".repeat(800);
    k.gateway.callTools([{ name: "search", input: { query: "川菜" } }], { text: ack }).reply(answer);
    await k.ask();
    expect(await k.worker.runOnce()).toBe(true);
    expect(await k.posted()).toEqual([ack, answer]);
    const truncated = await db.query("select 1 from messages where conversation_id = $1 and sender_id = $2 and (body -> 'truncated') = 'true'::jsonb", [k.g, k.agent.id]);
    expect(truncated.rowCount).toBe(0);
  });

  it("a first turn asking for more tools than it may run keeps its text: one call runs, the rest are answered with a note, and its words are its acknowledgement", async () => {
    const box = boxOf();
    const k = await othersKitchen(app, db, { box });
    const q = (query: string) => ({ name: "search", input: { query } });
    k.gateway.callTools([q("a"), q("b"), q("c"), q("d"), q("e"), q("f")], { text: "我查一下。" }).reply("川菜。");
    await k.ask();
    expect(await k.worker.runOnce()).toBe(true);
    expect(box.ran).toHaveLength(1);
    expect(k.gateway.calls).toHaveLength(2);
    expect(await k.posted()).toEqual(["我查一下。", "川菜。"]);
    expect(lines.some((l) => l.includes("others_turn_discarded"))).toBe(false);
  });
});

describe("a call refused by N: one line for its sender alone, and one notice a day for the owner", () => {
  it("the sender's copy of their message carries the refusal, no one else's does, the group is told nothing, and the owner is told once in the Agent's own conversation", async () => {
    const k = await othersKitchen(app, db);
    await setOwnerLimit(db, k.owner.id, 1n * POINT);
    await paidReply(db, { agentId: k.agent.id, ownerId: k.owner.id, conversationId: k.agent.conversationId, lane: "others", micro: POINT });
    const sent = await api(app, k.member, "POST", `/api/conversations/${k.g}/messages`, { text: "@chef 附近有什么好吃的？", clientTxn: "n1" });
    expect(sent.status).toBe(201);
    const seq = sent.json.message.seq as number;
    expect(sent.json.message.refused).toEqual([{ agentId: k.agent.id, reason: "others_limit" }]);
    expect(sent.json).not.toHaveProperty("notCalled");
    expect((await readAs(k.member, k.g, seq))?.refused).toEqual([{ agentId: k.agent.id, reason: "others_limit" }]);
    expect(await readAs(k.owner, k.g, seq)).not.toHaveProperty("refused");
    expect(await readAs(k.third, k.g, seq)).not.toHaveProperty("refused");
    // No run, nothing told the group.
    expect((await db.query("select 1 from agent_runs where conversation_id = $1", [k.g])).rowCount).toBe(0);
    expect((await db.query("select 1 from messages where conversation_id = $1 and kind = 'system' and seq > 1", [k.g])).rowCount).toBe(0);
    // The owner's notice, in the Agent's own conversation: once a site day, however many are refused.
    const ownerNotices = async () =>
      (await db.query<{ body: Record<string, unknown> }>("select body from messages where conversation_id = $1 and body ->> 'event' = 'others_limit_reached'", [k.agent.conversationId])).rows;
    await expect.poll(async () => (await ownerNotices()).length).toBe(1);
    expect((await ownerNotices())[0]!.body).toMatchObject({ event: "others_limit_reached", agentId: k.agent.id, points: "1" });
    const again = await api(app, k.third, "POST", `/api/conversations/${k.g}/messages`, { text: "@chef 再问一次", clientTxn: "n2" });
    expect(again.json.message.refused).toEqual([{ agentId: k.agent.id, reason: "others_limit" }]);
    await new Promise((r) => setTimeout(r, 200));
    expect(await ownerNotices()).toHaveLength(1);
  });

  it("refused at admission (use reached N while it was queued): no call, and the sender's message is pushed to them again with the line", async () => {
    const k = await othersKitchen(app, db);
    await setOwnerLimit(db, k.owner.id, 1n * POINT);
    const socket = await connect(app, k.member);
    const sent = await api(app, k.member, "POST", `/api/conversations/${k.g}/messages`, { text: "@chef 附近有什么好吃的？", clientTxn: "n3" });
    const seq = sent.json.message.seq as number;
    expect(sent.json.message).not.toHaveProperty("refused");
    await paidReply(db, { agentId: k.agent.id, ownerId: k.owner.id, conversationId: k.agent.conversationId, lane: "others", micro: POINT });
    expect(await k.worker.runOnce()).toBe(true);
    expect(k.gateway.calls).toHaveLength(0);
    expect(await k.lastRun()).toMatchObject({ status: "cancelled", lane: "others" });
    const pushed = await socket.next((e) => e.type === "message" && e.message.seq === seq && Array.isArray(e.message.refused));
    expect(pushed.message.refused).toEqual([{ agentId: k.agent.id, reason: "others_limit" }]);
    expect((await readAs(k.member, k.g, seq))?.refused).toEqual([{ agentId: k.agent.id, reason: "others_limit" }]);
  });

  it("refused at admission, its end commits with the refusal: a process that dies before it finishes leaves nothing for recovery to answer, though the number is raised since", async () => {
    const k = await othersKitchen(app, db);
    await setOwnerLimit(db, k.owner.id, 1n * POINT);
    const sent = await api(app, k.member, "POST", `/api/conversations/${k.g}/messages`, { text: "@chef 附近有什么好吃的？", clientTxn: "n5a" });
    const seq = sent.json.message.seq as number;
    await paidReply(db, { agentId: k.agent.id, ownerId: k.owner.id, conversationId: k.agent.conversationId, lane: "others", micro: POINT });
    const ticket = (await k.port.claimNext())!;
    expect(await k.port.begin(ticket)).toEqual({ status: "cancelled" });
    // The refusal and the run's end are one transaction: the run is over already.
    expect(await k.lastRun()).toMatchObject({ id: ticket.id, status: "cancelled", error: null, hold: "0" });
    // The process dies here (no `finish`); the number is raised; the next process recovers what was left running: nothing.
    await setOwnerLimit(db, k.owner.id, 100n * POINT);
    await recoverRuns(db, config(), app.log);
    expect(await k.port.releaseRun(ticket.id)).toBe(false);
    expect((await db.query("select 1 from agent_runs where conversation_id = $1 and status in ('queued', 'running')", [k.g])).rowCount).toBe(0);
    expect((await readAs(k.member, k.g, seq))?.refused).toEqual([{ agentId: k.agent.id, reason: "others_limit" }]);
    // The worker's own finish after it changes nothing.
    await k.port.finish(ticket, { status: "cancelled" }, null, NOTHING);
    expect(await k.lastRun()).toMatchObject({ id: ticket.id, status: "cancelled", error: null });
  });

  it("a refusal for access stays quiet: an Agent only its owner may call, a paused one", async () => {
    const k = await othersKitchen(app, db, { agent: { groupMentions: "owner" } });
    const sent = await api(app, k.member, "POST", `/api/conversations/${k.g}/messages`, { text: "@chef 你好", clientTxn: "n4" });
    expect(sent.json.message).not.toHaveProperty("refused");
    expect((await db.query("select 1 from call_refusals")).rowCount).toBe(0);
  });
});

describe("a call refused for being too often", () => {
  it("over the caller's calls a minute: the sender's copy says so (there is no notCalled any more)", async () => {
    const k = await othersKitchen(app, db);
    const limit = config().agentCallerRunsPerMinute;
    // Each earlier call made a run (queued) in the last minute; the reply under way folds nothing more, so each is a run of its own.
    for (let i = 0; i < limit; i++) await db.query("insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, lane, caller_id, finished_at) values ('reply', $1, $2, $3, 'done', 'others', $4, now())", [k.g, k.agent.id, k.owner.id, k.member.id]);
    const sent = await api(app, k.member, "POST", `/api/conversations/${k.g}/messages`, { text: "@chef 又来了", clientTxn: "n5" });
    expect(sent.json.message.refused).toEqual([{ agentId: k.agent.id, reason: "too_often" }]);
    expect(sent.json).not.toHaveProperty("notCalled");
  });

  /** The group's runs as `who` reads them again (`GET …/runs`): the Agent's entry, and whether any run of it there failed. */
  const runsSeenBy = async (k: Awaited<ReturnType<typeof othersKitchen>>, who: Actor) =>
    ((await api(app, who, "GET", `/api/conversations/${k.g}/runs`)).json.runs as Array<Record<string, unknown>>).find((r) => r.agentId === k.agent.id) ?? null;
  const failedIn = async (conv: string) => (await db.query("select 1 from agent_runs where conversation_id = $1 and status = 'failed'", [conv])).rowCount;
  /** `limit` replies of the owner's for others started in the last minute (by somebody else: not the member's own minute). */
  const ownerMinuteFull = async (k: Awaited<ReturnType<typeof othersKitchen>>) => {
    const other = await newOwner();
    for (let i = 0; i < config().agentOthersRunsPerMinute; i++) {
      await db.query("insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, lane, caller_id, finished_at) values ('reply', $1, $2, $3, 'done', 'others', $4, now())", [k.g, k.agent.id, k.owner.id, other.id]);
    }
  };

  it("over the owner's others' replies a minute: the sender's line is the one outward result — no rate_limited run for the owner, nothing unavailable for the other members, pushed or read again", async () => {
    const k = await othersKitchen(app, db);
    await ownerMinuteFull(k);
    const [ownerSocket, thirdSocket] = [await connect(app, k.owner), await connect(app, k.third)];
    const sent = await api(app, k.member, "POST", `/api/conversations/${k.g}/messages`, { text: "@chef 又来了", clientTxn: "n6" });
    expect(sent.json.message.refused).toEqual([{ agentId: k.agent.id, reason: "too_often" }]);
    expect(await failedIn(k.g)).toBe(0);
    // Read again: the Agent's latest run there is as it was (done): no entry for the owner, none for the others.
    expect([await runsSeenBy(k, k.owner), await runsSeenBy(k, k.third)]).toEqual([null, null]);
    // Nothing pushed of it: no run frame to the owner, no state to the others (the message itself, as any).
    await new Promise((r) => setTimeout(r, 300));
    expect(ownerSocket.events.filter((e) => e.type === "run")).toEqual([]);
    expect(thirdSocket.events.filter((e) => e.type === "run")).toEqual([]);
  });

  it("over the caller's minute or the owner's others' minute, a follow-up for others is no rate_limited run either: its calls' senders read the line", async () => {
    const k = await othersKitchen(app, db);
    await k.ask("@chef 一");
    const ticket = (await k.port.claimNext())!;
    const noted = await api(app, k.third, "POST", `/api/conversations/${k.g}/messages`, { text: "@chef 二", clientTxn: "n7" });
    const seq = noted.json.message.seq as number;
    await ownerMinuteFull(k);
    await k.port.finish(ticket, { status: "done" }, null, NOTHING);
    expect(await failedIn(k.g)).toBe(0);
    expect((await db.query("select 1 from agent_runs where conversation_id = $1 and status = 'queued'", [k.g])).rowCount).toBe(0);
    expect((await readAs(k.third, k.g, seq))?.refused).toEqual([{ agentId: k.agent.id, reason: "too_often" }]);
  });

  it("the owner's own lane over its minute is as before: the owner's rate_limited run, no line", async () => {
    const k = await othersKitchen(app, db);
    for (let i = 0; i < config().agentRunsPerMinute; i++) {
      await db.query("insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, lane, caller_id, finished_at) values ('reply', $1, $2, $3, 'done', 'own', $3, now())", [k.g, k.agent.id, k.owner.id]);
    }
    const sent = await api(app, k.owner, "POST", `/api/conversations/${k.g}/messages`, { text: "@chef 我来问", clientTxn: "n8" });
    expect(sent.json.message).not.toHaveProperty("refused");
    expect(await k.lastRun()).toMatchObject({ status: "failed", error: "rate_limited", lane: "own" });
  });
});

describe("the owner's page", () => {
  it("GET /api/me/others-use: today's use against N, its proactive part, who used it, reached, the stops and the notice — one number", async () => {
    const owner = await newOwner();
    const [a] = await agentsOf(app, db, owner, 1);
    const mine = await providerAgent(app, db, owner);
    const caller = await newOwner();
    const id = await paidReply(db, { agentId: a!.agentId, ownerId: owner.id, conversationId: a!.conversationId, lane: "others", micro: 2_500_000n });
    await db.query("update agent_runs set caller_id = $2, admitted_at = now() where id = $1", [id, caller.id]);
    await paidReply(db, { agentId: a!.agentId, ownerId: owner.id, conversationId: a!.conversationId, lane: "proactive", micro: 1_000_000n });
    const own = await providerRun({ ownerId: owner.id, agent: mine, lane: "others" });
    await db.query("update agent_runs set caller_id = $2 where id = $1", [own, caller.id]);
    const got = await api(app, owner, "GET", "/api/me/others-use");
    expect(got.status).toBe(200);
    expect(got.json).toEqual({
      limit: "300",
      used: "9.5",
      proactive: "1",
      ownKeyPoints: "6",
      reached: false,
      byPerson: [{ person: { id: caller.id, handle: caller.handle, displayName: expect.any(String), avatarVersion: 0 }, points: "8.5" }],
      stopped: [],
      notice: false,
    });
    await setOwnerLimit(db, owner.id, 9n * POINT);
    expect((await api(app, owner, "GET", "/api/me/others-use")).json).toMatchObject({ limit: "9", used: "9.5", reached: true });
  });

  it("PUT /api/me/others-limits sets the one number; the old body with answers is a 400", async () => {
    const owner = await newOwner();
    const put = await api(app, owner, "PUT", "/api/me/others-limits", { points: "120.5" });
    expect(put).toEqual({ status: 200, json: { points: "120.5" } });
    expect((await api(app, owner, "GET", "/api/me/others-use")).json.limit).toBe("120.5");
    for (const bad of [{ answers: 5, points: "10" }, {}, { points: "0.5" }, { points: "100001" }, { points: 7 }]) {
      expect([bad, (await api(app, owner, "PUT", "/api/me/others-limits", bad)).status]).toEqual([bad, 400]);
    }
  });
});

describe("the Agent's wire and settings", () => {
  it("has none of the deleted numbers, and a body naming one is a 400", async () => {
    const owner = await newOwner();
    const made = await mustCreateAgent(app, owner, {});
    for (const gone of ["othersLimit", "othersUsedToday", "proactiveBudget", "proactiveSpentToday", "othersBudget"]) expect(Object.keys(made)).not.toContain(gone);
    for (const bad of [{ othersLimit: null }, { othersBudget: "6" }, { proactiveBudget: "70" }]) {
      expect([bad, (await api(app, owner, "PATCH", `/api/agents/${made.id}`, bad)).status]).toEqual([bad, 400]);
    }
  });
});

describe("GET /api/models: the hint under the two level selects", () => {
  it("says, for each site model and each level it runs, the most one reply to someone else can cost there, and the nominal count of an own-key reply", async () => {
    const owner = await newOwner();
    const got = (await api(app, owner, "GET", "/api/models")).json;
    expect(got.othersOwnKeyPoints).toBe("6");
    const big = (got.siteModels as Array<{ id: string; othersCeiling: Record<string, string> }>).find((m) => m.id === "oth_big")!;
    expect(Object.keys(big.othersCeiling)).toEqual(["none", "low", "medium"]);
    const site = config().siteModels.find((m) => m.id === "oth_big")!;
    for (const level of ["none", "low", "medium"] as const) {
      const micro = othersReplyCeilingMicro(config(), site, level, null);
      expect(Number(big.othersCeiling[level])).toBeCloseTo(Number(micro) / 1e6, 1);
    }
  });
});
