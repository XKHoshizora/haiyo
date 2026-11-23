import { afterEach, describe, expect, it, vi } from "vitest";
import { siteDayStart } from "../src/accounts/store.ts";
import { NOTHING, type RunEnd, type RunTicket } from "../src/agents/runtime/port.ts";
import { triggerFromAgent } from "../src/agents/runs.ts";
import { lockAgent } from "../src/agents/store.ts";
import { mentionsAtSend } from "../src/agents/mentions.ts";
import { insertMessage } from "../src/messages/model.ts";
import { api, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { paidReply } from "./helpers/metering.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { closeAllSockets, connect } from "./helpers/ws.ts";

/**
 * The others' daily budget (the limits plan, Task 4): what calls by people other than an Agent's owner — themselves or
 * through an Agent's message they are behind, their own Agent's or one relaying their call (lane `others`) — spend of
 * its owner's points in a site day is capped by the Agent's
 * `othersBudget` (20 points unless its owner says otherwise; `null`: no cap). Spent is what those replies were charged
 * today: a reply being written counts once it is settled. Once it is spent such a call reaches nothing — not even a reply under way —
 * and the group is told once a day; its owner is pushed the Agent again. The owner's own calls never count and are never
 * refused. As in agents-group-trigger.test.ts, an Agent is put into a group by inserting its membership row, and an
 * Agent's own message is stored and handed to `triggerFromAgent` in one transaction, as `postAsAgent` does.
 */

const gateway = scriptedGateway();
// Runs are only queued here: no worker picks one up unless a test runs it (`runOnce`).
const { app, db } = useApp({ env: SITE_ENV, models: gateway, agentWorker: false });

afterEach(async () => {
  vi.restoreAllMocks();
  await closeAllSockets();
  expect(gateway.pending()).toBe(0);
});

const FAST = { source: "site", id: "fast" } as const;
const POINT = 1_000_000;
const EVENT = "agent_daily_budget_reached";

interface World {
  owner: Actor;
  member: Actor;
  third: Actor;
  /** A group of the three. */
  g: string;
}

async function world(): Promise<World> {
  const [owner, member, third] = [await signUp(app, "owner"), await signUp(app, "member"), await signUp(app, "third")];
  return { owner, member, third, g: await group(app, owner, "team", [member, third]) };
}

/** Another group of the three, made by the member. */
const anotherGroup = (w: World, title: string) => group(app, w.member, title, [w.owner, w.third]);

/** Puts principal `id` into conversation `conv` from its current seq on. */
const join = (conv: string, id: string) =>
  db.query(`insert into memberships (conversation_id, principal_id, role, joined_seq) select $1, $2, 'speaker', seq from conversations where id = $1`, [
    conv,
    id,
  ]);

interface Agent {
  id: string;
  ownerId: string;
  conversationId: string;
}

/** An Agent of `owner` with `handle` (also its name unless `over` names one), answering on the site model, put into `conv` when given. */
async function agentOf(owner: Actor, handle: string, conv: string | null, over: Record<string, unknown> = {}): Promise<Agent> {
  const made = await mustCreateAgent(app, owner, { handle, name: handle, model: FAST, persona: "简短地回答。", ...over });
  if (conv) await join(conv, made.id);
  return { id: made.id, ownerId: owner.id, conversationId: made.conversationId };
}

let txn = 0;
const say = async (who: Actor, conv: string, text: string): Promise<number> => {
  const sent = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `ob${++txn}` });
  if (sent.status !== 201) throw new Error(`say: ${sent.status} ${JSON.stringify(sent.json)}`);
  return sent.json.message.seq as number;
};

/**
 * The Agent's own message in `conv`, stored and handed to the trigger in one transaction, as `postAsAgent` does — posted
 * by no run, so its owner is behind it.
 */
const agentSays = (agentId: string, conv: string, text: string) =>
  db.tx(async (t) => {
    const poster = await lockAgent(t, agentId, conv);
    const message = await insertMessage(t, conv, agentId, "text", { text }, null, await mentionsAtSend(t, { id: conv, type: "group" }, text));
    // Posted by no run: whose question it carries is not known (null, the safe side; Task 10b).
    return { message, ...(await triggerFromAgent(t, conv, message, poster, null, app.deps.config, null)) };
  });

/** The Agent's runs in `conv`, oldest first. */
const runsOf = async (agentId: string, conv: string) =>
  (
    await db.query<{ status: string; lane: string; covers: number; pending: number | null }>(
      "select status, lane, covers_seq::int as covers, pending_seq::int as pending from agent_runs where agent_id = $1 and conversation_id = $2 order by created_at, id",
      [agentId, conv],
    )
  ).rows;

/** Ends every active run, so that the next trigger queues a new one instead of folding. */
const settleAll = () => db.query("update agent_runs set status = 'done', finished_at = now() where status in ('queued', 'running')");

/** The bodies of the budget notices in `conv`, oldest first. */
const noticesOf = async (conv: string) =>
  (
    await db.query<{ body: Record<string, unknown> }>(
      "select body from messages where conversation_id = $1 and kind = 'system' and body ->> 'event' = $2 order by seq",
      [conv, EVENT],
    )
  ).rows.map((r) => r.body);

/**
 * A finished reply of `agent` in `conv`, in `lane`, settled with `micro` charged to its owner's balance; its usage record
 * written at `at` (now unless given).
 */
async function paid(agent: Agent, conv: string, lane: "own" | "others" | "proactive", micro: number, at: Date | null = null): Promise<void> {
  await paidReply(db, { agentId: agent.id, ownerId: agent.ownerId, conversationId: conv, lane, micro, at });
}

/** A finished reply of `agent` that someone other than its owner called for, charged `micro` (at `at`: now unless given). */
const paidOthers = (agent: Agent, conv: string, micro: number, at: Date | null = null) => paid(agent, conv, "others", micro, at);

/** A running reply of `agent` in `conv`, in `lane`, covering its current seq, admitted on the site model and holding `holdMicro`. */
async function holding(agent: Agent, conv: string, lane: "own" | "others", holdMicro: number): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, started_at, source, model, charge_to, hold_micro, lane)
     select 'reply', $1, $2, $3, 'running', seq, now(), 'site', 'fast', 'balance', $4, $5 from conversations where id = $1 returning id`,
    [conv, agent.id, agent.ownerId, holdMicro, lane],
  );
  return rows[0]!.id;
}

/** The Agent's queued run in `conv`, made running as the worker's claim makes it. */
const claim = async (agent: Agent, conv: string): Promise<RunTicket> => {
  const { rows } = await db.query<{ id: string }>(
    "update agent_runs set status = 'running', started_at = now() where agent_id = $1 and conversation_id = $2 and status = 'queued' returning id",
    [agent.id, conv],
  );
  return { id: rows[0]!.id, agentId: agent.id, ownerId: agent.ownerId, conversationId: conv };
};

const viewOf = async (who: Actor, agent: Agent) => (await api(app, who, "GET", `/api/agents/${agent.id}`)).json;

describe("the others' daily budget", () => {
  it("under the budget another member's call is queued; at it, no run and one notice a day in the group", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g, { name: "安娜", othersBudget: "2" });
    await paidOthers(anna, w.g, 2 * POINT - 1);
    const asked = await say(w.member, w.g, "@anna 你好");
    expect((await runsOf(anna.id, w.g)).at(-1)).toMatchObject({ status: "queued", lane: "others", covers: asked });
    await settleAll();

    // One micro-point more and it is spent: the member's call reaches nothing, the group is told (live), and its owner is
    // pushed the Agent once.
    await paidOthers(anna, w.g, 1);
    const pushed = vi.spyOn(app.realtime, "pushAgentChanged");
    const thirdSocket = await connect(app, w.third);
    const before = await runsOf(anna.id, w.g);
    await say(w.member, w.g, "@anna 再问");
    expect(await runsOf(anna.id, w.g)).toEqual(before);
    expect(await noticesOf(w.g)).toEqual([{ event: EVENT, actorId: anna.id, agentId: anna.id, text: "「安娜」今天的额度已用完" }]);
    const told = await thirdSocket.next((x) => x.type === "message" && x.message.system?.event === EVENT);
    expect(told.message).toMatchObject({ senderId: null, text: "「安娜」今天的额度已用完", system: { event: EVENT, actorId: anna.id, agentId: anna.id } });
    expect(pushed.mock.calls).toEqual([[w.owner.id, anna.id]]);

    // Another member's call the same day: refused too, with no second notice and no second push.
    await say(w.third, w.g, "@anna 我也问");
    expect(await runsOf(anna.id, w.g)).toEqual(before);
    expect(await noticesOf(w.g)).toHaveLength(1);
    expect(pushed).toHaveBeenCalledTimes(1);

    // In another group the same day: its own one notice.
    const g2 = await anotherGroup(w, "second");
    await join(g2, anna.id);
    await say(w.member, g2, "@anna 你好");
    await say(w.third, g2, "@anna 你好");
    expect(await runsOf(anna.id, g2)).toEqual([]);
    expect((await noticesOf(g2)).map((n) => n.agentId)).toEqual([anna.id]);
    expect(await noticesOf(w.g)).toHaveLength(1);
    expect(pushed).toHaveBeenCalledTimes(2);

    // A notice of an earlier day does not count for today's.
    const dayStart = siteDayStart(new Date(), app.deps.config.siteTimezone, 0);
    await db.query("update messages set created_at = $2 where conversation_id = $1 and body ->> 'event' = $3", [w.g, new Date(dayStart.getTime() - 1000), EVENT]);
    await say(w.third, w.g, "@anna 今天呢");
    expect(await noticesOf(w.g)).toHaveLength(2);
  });

  it("the owner's own call is answered all the same, and does not count", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g, { othersBudget: "2" });
    const carl = await agentOf(w.owner, "carlbot", w.g);
    // What its owner's own replies were charged today — in the group, in its own conversation — and what replies nobody
    // called for were do not count: another member's call is queued.
    await paid(anna, w.g, "own", 50 * POINT);
    await paid(anna, anna.conversationId, "own", 50 * POINT);
    await paid(anna, w.g, "proactive", 50 * POINT);
    await say(w.member, w.g, "@anna 你好");
    expect((await runsOf(anna.id, w.g)).at(-1)).toMatchObject({ status: "queued", lane: "others" });
    await settleAll();

    // Spent: its owner's call is answered.
    await paidOthers(anna, w.g, 2 * POINT);
    const mine = await say(w.owner, w.g, "@anna 我来问");
    expect((await runsOf(anna.id, w.g)).at(-1)).toMatchObject({ status: "queued", lane: "own", covers: mine });
    // Another member's call is not even folded into that reply: it is refused, and the group told.
    await say(w.member, w.g, "@anna 我也问");
    expect((await runsOf(anna.id, w.g)).at(-1)).toMatchObject({ status: "queued", lane: "own", covers: mine });
    expect(await noticesOf(w.g)).toHaveLength(1);
    await settleAll();
    // Through another of its owner's Agents, and in its own conversation: answered too.
    const called = await agentSays(carl.id, w.g, "@anna 你看看");
    expect([called.runs.length, called.notices, called.budgetReached]).toEqual([1, [], []]);
    expect((await runsOf(anna.id, w.g)).at(-1)).toMatchObject({ status: "queued", lane: "own" });
    await say(w.owner, anna.conversationId, "你好");
    expect((await runsOf(anna.id, anna.conversationId)).at(-1)).toMatchObject({ status: "queued", lane: "own" });
    // Its owner sees what others spent today, and only that.
    expect(await viewOf(w.owner, anna)).toMatchObject({ othersLimit: { points: "2" }, othersUsedToday: { points: "2" } });
  });

  it("an Agent of someone else is refused the same way", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g, { othersBudget: "2" });
    const mia = await agentOf(w.member, "mia", w.g);
    await say(w.third, w.g, "开始");
    await paidOthers(anna, w.g, 2 * POINT);
    const before = await runsOf(anna.id, w.g);

    const refused = await agentSays(mia.id, w.g, "@anna 你看看");
    expect([refused.runs, refused.callerLimited, refused.budgetReached]).toEqual([[], [], [{ ownerId: w.owner.id, agentId: anna.id }]]);
    expect(refused.notices.map((n) => [n.seq, n.body])).toEqual([[refused.message.seq + 1, { event: EVENT, actorId: anna.id, agentId: anna.id, text: "「anna」今天的额度已用完" }]]);
    // Once a day in the group.
    const again = await agentSays(mia.id, w.g, "@anna 还在吗");
    expect([again.runs, again.notices, again.budgetReached]).toEqual([[], [], []]);
    expect(await runsOf(anna.id, w.g)).toEqual(before);

    // Its reply, as the worker posts it, in another group: the same; the notice follows the reply, and its owner is
    // pushed the Agent.
    const g2 = await anotherGroup(w, "second");
    await join(g2, anna.id);
    await join(g2, mia.id);
    await say(w.member, g2, "@mia 问问 anna");
    const pushed = vi.spyOn(app.realtime, "pushAgentChanged");
    const thirdSocket = await connect(app, w.third);
    gateway.reply("@anna 你也看看");
    expect(await app.agentWorker.runOnce()).toBe(true);
    const reply = await thirdSocket.waitFor((x) => x.type === "message" && x.message.senderId === mia.id);
    await thirdSocket.waitFor((x) => x.type === "message" && x.message.system?.event === EVENT, { from: reply + 1 });
    expect(await runsOf(anna.id, g2)).toEqual([]);
    expect((await noticesOf(g2)).map((n) => n.agentId)).toEqual([anna.id]);
    expect(pushed.mock.calls).toEqual([[w.owner.id, anna.id]]);
  });

  it("a member's call relayed by the owner's Agent meets the other Agent's budget: refused, and the group told", async () => {
    const w = await world();
    await agentOf(w.owner, "anna", w.g);
    const carl = await agentOf(w.owner, "carlbot", w.g, { othersBudget: "2" });
    await paidOthers(carl, w.g, 2 * POINT);
    const before = await runsOf(carl.id, w.g);
    await say(w.member, w.g, "@anna 问问 carlbot");
    gateway.reply("@carlbot 你也看看");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(await runsOf(carl.id, w.g)).toEqual(before);
    expect((await noticesOf(w.g)).map((n) => n.agentId)).toEqual([carl.id]);
  });

  it("a follow-up others asked for is not queued once it is spent; its owner's is", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g, { othersBudget: "2" });
    const g2 = await anotherGroup(w, "second");
    const g3 = await anotherGroup(w, "third");
    for (const conv of [g2, g3]) await join(conv, anna.id);
    // A member's reply under way in each group, with a mention noted on it: another member's in the first and the
    // third, its owner's in the second.
    const tickets: RunTicket[] = [];
    for (const conv of [w.g, g2, g3]) {
      await say(w.member, conv, "@anna 一");
      tickets.push(await claim(anna, conv));
    }
    const noted = [await say(w.third, w.g, "@anna 二"), await say(w.owner, g2, "@anna 我也问"), await say(w.third, g3, "@anna 二")];
    for (const [i, conv] of [w.g, g2, g3].entries()) expect((await runsOf(anna.id, conv)).at(-1)).toMatchObject({ status: "running", pending: noted[i] });
    // The day's spend reaches the budget before they end.
    await paidOthers(anna, w.g, 2 * POINT);
    const pushed = vi.spyOn(app.realtime, "pushAgentChanged");
    const memberSocket = await connect(app, w.member);

    // The first ends: what the other member asked meanwhile is not answered; the group is told after the run's end, and
    // its owner is pushed the Agent.
    await app.agentPort.finish(tickets[0]!, { status: "done" }, null, NOTHING);
    const told = await memberSocket.next((x) => x.type === "message" && x.message.system?.event === EVENT);
    expect([told.message.conversationId, told.message.system]).toEqual([w.g, { event: EVENT, actorId: anna.id, agentId: anna.id }]);
    expect((await runsOf(anna.id, w.g)).filter((r) => r.status !== "done")).toEqual([]);
    expect(pushed.mock.calls).toEqual([[w.owner.id, anna.id]]);

    // The second: what its owner asked is answered, as its owner's own.
    await app.agentPort.finish(tickets[1]!, { status: "done" }, null, NOTHING);
    expect((await runsOf(anna.id, g2)).at(-1)).toMatchObject({ status: "queued", lane: "own", covers: noted[1] });
    expect(await noticesOf(g2)).toEqual([]);

    // The third, released after its reply was posted (recovery's way): the same rule as the first.
    await db.tx((t) => insertMessage(t, g3, anna.id, "text", { text: "回答" }, tickets[2]!.id));
    expect(await app.agentPort.releaseRun(tickets[2]!.id)).toBe(true);
    expect((await runsOf(anna.id, g3)).map((r) => r.status)).toEqual(["done"]);
    expect((await noticesOf(g3)).map((n) => n.agentId)).toEqual([anna.id]);
    expect(pushed.mock.calls).toEqual([
      [w.owner.id, anna.id],
      [w.owner.id, anna.id],
    ]);
  });

  it("checked again as a reply is admitted, with its hold: one queued while there was room ends there when the room left cannot hold it, with no call and no charge, and the group is told", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g, { othersBudget: "2" });
    const g2 = await anotherGroup(w, "second");
    await join(g2, anna.id);
    // A micro-point short of the budget: the member's calls in both groups are queued.
    await paidOthers(anna, w.g, 2 * POINT - 1);
    await say(w.member, w.g, "@anna 一");
    await say(w.member, g2, "@anna 二");
    expect([(await runsOf(anna.id, w.g)).at(-1), (await runsOf(anna.id, g2)).at(-1)]).toEqual([
      expect.objectContaining({ status: "queued", lane: "others" }),
      expect.objectContaining({ status: "queued", lane: "others" }),
    ]);

    // The cap is exact (B1, `othersFits`): settled plus what the reply holds must stay within the budget, and the one
    // micro-point left holds nothing. The first, as the worker takes it, ends as it is admitted — no model call, nothing
    // charged — and the group is told.
    const pushed = vi.spyOn(app.realtime, "pushAgentChanged");
    const memberSocket = await connect(app, w.member);
    const calls = gateway.calls.length;
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(gateway.calls.length).toBe(calls);
    const ended = async (conv: string) =>
      (
        await db.query<{ id: string; status: string; error: string | null; source: string | null }>(
          "select id, status, error, source from agent_runs where agent_id = $1 and conversation_id = $2 and status <> 'done' order by created_at desc limit 1",
          [anna.id, conv],
        )
      ).rows;
    expect((await ended(w.g)).map(({ status, error, source }) => ({ status, error, source }))).toEqual([{ status: "cancelled", error: null, source: null }]);
    const charged = await db.query("select coalesce(sum(free_micro + balance_micro), 0)::text as charged from usage_records where run_id = $1", [(await ended(w.g))[0]!.id]);
    expect(charged.rows[0].charged).toBe("0");
    expect((await noticesOf(w.g)).map((n) => n.agentId)).toEqual([anna.id]);
    const told = await memberSocket.next((x) => x.type === "message" && x.message.system?.event === EVENT);
    expect(told.message.conversationId).toBe(w.g);
    expect(pushed.mock.calls).toEqual([[w.owner.id, anna.id]]);

    // The second, in the other group: the same, with that group's own notice (once a site day per conversation).
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(gateway.calls.length).toBe(calls);
    expect((await ended(g2)).map(({ status, error, source }) => ({ status, error, source }))).toEqual([{ status: "cancelled", error: null, source: null }]);
    expect((await noticesOf(g2)).map((n) => n.agentId)).toEqual([anna.id]);
    expect(pushed.mock.calls).toEqual([
      [w.owner.id, anna.id],
      [w.owner.id, anna.id],
    ]);
    expect(await viewOf(w.owner, anna)).toMatchObject({ othersUsedToday: { points: "1.999999" } });
  });

  it.each([
    ["its owner's is answered", "owner", true],
    ["another member's meets the budget again: nothing, and no second notice", "third", false],
  ] as const)("a mention noted between the claim and a budget-refused admission is followed up: %s", async (_what, who, answered) => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g, { othersBudget: "2" });
    await paidOthers(anna, w.g, 2 * POINT - 1);
    await say(w.member, w.g, "@anna 一");
    const ticket = await app.agentPort.claimNext();
    expect(ticket?.conversationId).toBe(w.g);
    // Claimed (running), the reply has a mention noted on it before it begins; then the budget is spent.
    const asked = await say(w[who], w.g, "@anna 我也问");
    expect((await runsOf(anna.id, w.g)).at(-1)).toMatchObject({ status: "running", pending: asked });
    await paidOthers(anna, w.g, 1);
    const calls = gateway.calls.length;
    const end = await app.agentPort.begin(ticket!);
    expect(end).toEqual({ status: "cancelled" });
    await app.agentPort.finish(ticket!, end as RunEnd, null, NOTHING);
    expect(gateway.calls.length).toBe(calls);
    expect(await noticesOf(w.g)).toHaveLength(1);
    const queued = (await runsOf(anna.id, w.g)).filter((r) => r.status === "queued");
    if (!answered) {
      expect(queued).toEqual([]);
      return;
    }
    // The owner's mention: an own follow-up covering it, answered when it runs.
    expect(queued).toEqual([expect.objectContaining({ lane: "own", covers: asked })]);
    gateway.reply("好的");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(gateway.calls.length).toBe(calls + 1);
    expect((await runsOf(anna.id, w.g)).at(-1)).toMatchObject({ status: "done", lane: "own", covers: asked });
  });

  it("a reply being written counts by what it holds (B3): its owner's own does not; another's under way, holding more than the budget, refuses the next call and the group is told once; the spend shown is what is settled", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g, { othersBudget: "2" });
    const g2 = await anotherGroup(w, "second");
    await join(g2, anna.id);
    // Its owner's reply under way in its own conversation holds many times the budget (a hold is a reply's most it can cost):
    // it is the owner's own, and counts for nothing against what others may spend.
    await holding(anna, anna.conversationId, "own", 50 * POINT);
    const asked = await say(w.member, w.g, "@anna 一");
    expect((await runsOf(anna.id, w.g)).at(-1)).toMatchObject({ status: "queued", lane: "others", covers: asked });
    await settleAll();

    // Another member's reply under way in the second group, holding the same: it is held against the budget (it will be charged
    // at most that), so the next call, in either group, is refused and the group told; a mention is not noted on it.
    await holding(anna, g2, "others", 50 * POINT);
    const before = await runsOf(anna.id, w.g);
    await say(w.third, w.g, "@anna 二");
    expect(await runsOf(anna.id, w.g)).toEqual(before);
    expect(await noticesOf(w.g)).toHaveLength(1);
    await say(w.third, g2, "@anna 三");
    expect(await runsOf(anna.id, g2)).toEqual([expect.objectContaining({ status: "running", pending: null })]);
    expect(await noticesOf(g2)).toHaveLength(1);
    // Others' use counts what the reply being written holds (the number is decided by settled plus held).
    expect(await viewOf(w.owner, anna)).toMatchObject({ othersUsedToday: { points: "50" } });

    // It ends: its hold is gone, and the call is answered again.
    await settleAll();
    const again = await say(w.member, w.g, "@anna 四");
    expect((await runsOf(anna.id, w.g)).at(-1)).toMatchObject({ status: "queued", lane: "others", covers: again });
    await settleAll();

    // Once what such replies were charged reaches it, the next call is refused (the notice, once a day, was told).
    await paidOthers(anna, w.g, 2 * POINT);
    const settled = await runsOf(anna.id, w.g);
    await say(w.third, w.g, "@anna 五");
    expect(await runsOf(anna.id, w.g)).toEqual(settled);
    expect(await noticesOf(w.g)).toHaveLength(1);
    expect(await viewOf(w.owner, anna)).toMatchObject({ othersUsedToday: { points: "2" } });
  });

  it("a person's mention it refused is no call of a later follow-up whose answer it lies in: that follow-up is the caller's whose mention was noted", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g, { othersBudget: "2" });
    await say(w.member, w.g, "@anna 一");
    const ticket = await claim(anna, w.g);
    // The budget is spent while the reply runs: the third's mention is refused (nothing noted) and the group told.
    await paidOthers(anna, w.g, 2 * POINT);
    await say(w.third, w.g, "@anna 二");
    expect(await noticesOf(w.g)).toHaveLength(1);
    expect((await db.query("select pending_seq from agent_runs where id = $1", [ticket.id])).rows).toEqual([{ pending_seq: null }]);
    // Raised, the member's next mention is noted on the reply under way, after the third's.
    expect((await api(app, w.owner, "PATCH", `/api/agents/${anna.id}`, { othersBudget: "10" })).status).toBe(200);
    const asked = await say(w.member, w.g, "@anna 三");
    await app.agentPort.finish(ticket, { status: "done" }, null, NOTHING);
    const queued = await db.query("select lane, caller_id, covers_seq::int as covers from agent_runs where agent_id = $1 and conversation_id = $2 and status = 'queued'", [
      anna.id,
      w.g,
    ]);
    expect(queued.rows).toEqual([{ lane: "others", caller_id: w.member.id, covers: asked }]);
  });

  it("yesterday's spend does not count", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g, { othersBudget: "2" });
    const dayStart = siteDayStart(new Date(), app.deps.config.siteTimezone, 0);
    await paidOthers(anna, w.g, 50 * POINT, new Date(dayStart.getTime() - 1000));
    await say(w.member, w.g, "@anna 你好");
    expect((await runsOf(anna.id, w.g)).at(-1)).toMatchObject({ status: "queued", lane: "others" });
    expect(await viewOf(w.owner, anna)).toMatchObject({ othersUsedToday: { points: "0" } });
    await settleAll();
    // From the day's first instant it counts.
    await paidOthers(anna, w.g, 2 * POINT, dayStart);
    const before = await runsOf(anna.id, w.g);
    await say(w.member, w.g, "@anna 再问");
    expect(await runsOf(anna.id, w.g)).toEqual(before);
    expect(await noticesOf(w.g)).toHaveLength(1);
  });

  it("raising it restores calls at once; null is unlimited; lowering it below today's spend refuses", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g, { othersBudget: "2" });
    const plain = await agentOf(w.owner, "plainbot", w.g);
    await paidOthers(anna, w.g, 2.5 * POINT);
    const patch = async (value: string | null) => {
      const res = await api(app, w.owner, "PATCH", `/api/agents/${anna.id}`, { othersBudget: value });
      expect([value, res.status]).toEqual([value, 200]);
      return res.json;
    };
    const queued = async (who: Actor, text: string) => {
      const seq = await say(who, w.g, text);
      const last = (await runsOf(anna.id, w.g)).at(-1);
      return last?.status === "queued" && last.covers === seq;
    };

    expect(await queued(w.member, "@anna 一")).toBe(false);
    expect(await noticesOf(w.g)).toHaveLength(1);
    // Raised above today's spend (2.5 points): answered at once.
    expect(await patch("3")).toMatchObject({ othersLimit: { points: "3" }, othersUsedToday: { points: "2.5" } });
    expect(await queued(w.member, "@anna 二")).toBe(true);
    await db.query("update agent_runs set status = 'done', finished_at = now() where agent_id = $1 and conversation_id = $2", [anna.id, w.g]);
    // Lowered below it: refused at once (the group was told today already).
    await patch("1");
    expect(await queued(w.third, "@anna 三")).toBe(false);
    expect(await noticesOf(w.g)).toHaveLength(1);
    // No limit: answered, however much was spent.
    expect(await patch(null)).toMatchObject({ othersLimit: { points: null }, othersUsedToday: { points: "2.5" } });
    expect(await queued(w.third, "@anna 四")).toBe(true);
    // Its owner's list shows each Agent's own.
    const listed = (await api(app, w.owner, "GET", "/api/agents")).json.agents as Array<Record<string, unknown>>;
    expect(listed.map((a) => [a.id, (a.othersLimit as { points: string | null }).points, (a.othersUsedToday as { points: string }).points])).toEqual([
      [anna.id, null, "2.5"],
      [plain.id, null, "0"],
    ]);
  });
});

describe("the order of the checks", () => {
  // Its own instance with a caller limit of one, and its log kept here.
  const lines: string[] = [];
  const { app: limited } = useApp({
    env: { ...SITE_ENV, AGENT_CALLER_RUNS_PER_MINUTE: "1" },
    models: gateway,
    agentWorker: false,
    logStream: { write: (line) => void lines.push(line) },
  });

  it("the others' budget comes before the caller's limit: a caller over his limit is told the budget is spent, and no limit is logged", async () => {
    const [owner, member, third] = [await signUp(limited, "owner"), await signUp(limited, "member"), await signUp(limited, "third")];
    const g = await group(limited, owner, "team", [member, third]);
    const make = async (handle: string, over: Record<string, unknown> = {}) => {
      const made = await mustCreateAgent(limited, owner, { handle, name: handle, model: FAST, persona: "简短地回答。", ...over });
      await join(g, made.id);
      return { id: made.id, ownerId: owner.id, conversationId: made.conversationId };
    };
    const anna = await make("anna", { othersBudget: "2" });
    const carl = await make("carlbot");
    await paidOthers(anna, g, 2 * POINT);
    const sayIn = async (text: string) => {
      const sent = await api(limited, member, "POST", `/api/conversations/${g}/messages`, { text, clientTxn: `order${++txn}` });
      expect(sent.status).toBe(201);
      return sent.json as Record<string, unknown>;
    };

    // The member's one call of the minute on someone else's Agent is used up (queued)...
    await sayIn("@carlbot 你好");
    expect(await runsOf(carl.id, g)).toEqual([expect.objectContaining({ status: "queued", lane: "others" })]);
    // ...so this call is over his limit, and Anna's budget is spent too: the budget answers — the group is told, and the
    // sender's answer names nothing his limit refused.
    const answered = await sayIn("@anna 你好");
    expect(await noticesOf(g)).toHaveLength(1);
    expect(answered).not.toHaveProperty("notCalled");
    expect(lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((e) => e.metric === "caller_rate_limited")).toEqual([]);
  });
});
