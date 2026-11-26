import { afterEach, describe, expect, it } from "vitest";
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
 * The owner's one number for others' use (limits redesign, Part 1), as calls in groups meet it: what people other than an Agent's
 * owner cause on all the owner's Agents — calls by others (lane `others`) and replies nobody asked for (`proactive`) — is counted in
 * one measure a site day, and once it has reached the owner's number (`OTHERS.pointsPerDay`, 300 points, unless the owner sets
 * another: `PUT /api/me/others-limits`) a call someone other than the owner makes reaches nothing — not even a reply under way.
 * Its sender alone is told, on their own copy of the message (`refused`, `others_limit`); the owner once a site day, in the Agent's
 * own conversation (`others_limit_reached`); the group nothing. The owner's own calls never count and are never refused. As in
 * agents-group-trigger.test.ts, an Agent is put into a group by inserting its membership row, and an Agent's own message is stored
 * and handed to `triggerFromAgent` in one transaction, as `postAsAgent` does.
 */

const gateway = scriptedGateway();
// Runs are only queued here: no worker picks one up unless a test runs it (`runOnce`).
const { app, db } = useApp({ env: SITE_ENV, models: gateway, agentWorker: false });

afterEach(async () => {
  await closeAllSockets();
  expect(gateway.pending()).toBe(0);
});

const FAST = { source: "site", id: "fast" } as const;
const POINT = 1_000_000;
const EVENT = "others_limit_reached";

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

/** Sets `owner`'s one number for others' use, in points. */
const setLimit = async (owner: Actor, points: string) => {
  const res = await api(app, owner, "PUT", "/api/me/others-limits", { points });
  expect([points, res.status]).toEqual([points, 200]);
  return res.json;
};

let txn = 0;
/** `who` sends `text` in `conv`: its seq, and what the sender's own copy says a limit refused (`refused`). */
const send = async (who: Actor, conv: string, text: string): Promise<{ seq: number; refused: unknown }> => {
  const sent = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `ol${++txn}` });
  if (sent.status !== 201) throw new Error(`send: ${sent.status} ${JSON.stringify(sent.json)}`);
  return { seq: sent.json.message.seq as number, refused: sent.json.message.refused };
};
const say = async (who: Actor, conv: string, text: string): Promise<number> => (await send(who, conv, text)).seq;

/** The line `agent`'s refusal by the owner's number makes on its sender's copy. */
const limitLine = (agent: Agent) => [{ agentId: agent.id, reason: "others_limit" }];

/** The message at `seq` of `conv` as `who` reads it now. */
async function readAs(who: Actor, conv: string, seq: number): Promise<Record<string, unknown> | undefined> {
  const page = await api(app, who, "GET", `/api/conversations/${conv}/messages`);
  return (page.json.messages as Array<Record<string, unknown>>).find((m) => m.seq === seq);
}

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
    await db.query<{ status: string; lane: string; covers: number }>(
      "select status, lane, covers_seq::int as covers from agent_runs where agent_id = $1 and conversation_id = $2 order by created_at, id",
      [agentId, conv],
    )
  ).rows;

/** Ends every active run, so that the next trigger queues a new one instead of folding. */
const settleAll = async () => {
  await db.query("delete from deferred_calls");
  await db.query("update agent_runs set status = 'done', finished_at = now() where status in ('queued', 'running')");
};
/** The seqs of the calls waiting for the Agent in `conv` behind its active reply (`deferred_calls`), oldest first. */
const waitingOf = async (agentId: string, conv: string): Promise<number[]> =>
  (await db.query<{ seq: number }>("select message_seq::int as seq from deferred_calls where agent_id = $1 and conversation_id = $2 order by message_seq", [agentId, conv])).rows.map(
    (r) => r.seq,
  );

/** The system messages of the event `others_limit_reached` in `conv`: none ever in a group. */
const noticesIn = async (conv: string) =>
  (await db.query("select 1 from messages where conversation_id = $1 and kind = 'system' and body ->> 'event' = $2", [conv, EVENT])).rowCount;

/** The owner's notices that others' use reached their number, in any of their Agents' own conversations, oldest first. */
const ownerNotices = async (owner: Actor) =>
  (
    await db.query<{ conversation_id: string; body: Record<string, unknown> }>(
      `select m.conversation_id, m.body from messages m join agent_conversations ac on ac.conversation_id = m.conversation_id
        where ac.owner_id = $1 and m.kind = 'system' and m.body ->> 'event' = $2 order by m.created_at, m.seq`,
      [owner.id, EVENT],
    )
  ).rows;

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

const othersUse = async (owner: Actor) => (await api(app, owner, "GET", "/api/me/others-use")).json;

describe("the owner's one number for others' use", () => {
  it("below it another member's call is queued; at it, no run, a line for the sender alone, one notice a day for the owner in the Agent's own conversation, and nothing in the group", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g, { name: "安娜" });
    await setLimit(w.owner, "2");
    await paidOthers(anna, w.g, 2 * POINT - 1);
    const asked = await send(w.member, w.g, "@anna 你好");
    expect(asked.refused).toBeUndefined();
    expect((await runsOf(anna.id, w.g)).at(-1)).toMatchObject({ status: "queued", lane: "others", covers: asked.seq });
    await settleAll();

    // One micro-point more and it is reached: the member's call reaches nothing; the member alone reads why, on their own message;
    // the owner is told in the Agent's own conversation (live), the group nothing.
    await paidOthers(anna, w.g, 1);
    const ownerSocket = await connect(app, w.owner);
    const before = await runsOf(anna.id, w.g);
    const refused = await send(w.member, w.g, "@anna 再问");
    expect(refused.refused).toEqual(limitLine(anna));
    expect(await runsOf(anna.id, w.g)).toEqual(before);
    expect((await readAs(w.member, w.g, refused.seq))?.refused).toEqual(limitLine(anna));
    expect(await readAs(w.third, w.g, refused.seq)).not.toHaveProperty("refused");
    expect(await readAs(w.owner, w.g, refused.seq)).not.toHaveProperty("refused");
    const told = await ownerSocket.next((x) => x.type === "message" && x.message.system?.event === EVENT);
    expect(told.message).toMatchObject({ conversationId: anna.conversationId, senderId: null, system: { event: EVENT, agentId: anna.id, points: "2" } });
    expect(await ownerNotices(w.owner)).toEqual([
      {
        conversation_id: anna.conversationId,
        body: { event: EVENT, actorId: anna.id, agentId: anna.id, points: "2", text: "别人今天用你的 Agent 已经花到每天上限 2 点，今天不再回复别人；已经在回复的会照常回完。" },
      },
    ]);
    expect(await noticesIn(w.g)).toBe(0);

    // Another member's call the same day: refused too, with its own line and no second notice.
    const also = await send(w.third, w.g, "@anna 我也问");
    expect(also.refused).toEqual(limitLine(anna));
    expect(await runsOf(anna.id, w.g)).toEqual(before);

    // Another of the owner's Agents, and another group, the same day: the one number is the owner's, for all their Agents; still
    // one notice for the owner.
    const carl = await agentOf(w.owner, "carlbot", w.g);
    expect((await send(w.member, w.g, "@carlbot 你好")).refused).toEqual(limitLine(carl));
    const g2 = await anotherGroup(w, "second");
    await join(g2, anna.id);
    expect((await send(w.member, g2, "@anna 你好")).refused).toEqual(limitLine(anna));
    expect(await runsOf(anna.id, g2)).toEqual([]);
    expect(await runsOf(carl.id, w.g)).toEqual([]);
    expect(await noticesIn(g2)).toBe(0);
    expect(await ownerNotices(w.owner)).toHaveLength(1);

    // A notice of an earlier day does not count for today's.
    const dayStart = siteDayStart(new Date(), app.deps.config.siteTimezone, 0);
    await db.query("update messages set created_at = $2 where conversation_id = $1 and body ->> 'event' = $3", [anna.conversationId, new Date(dayStart.getTime() - 1000), EVENT]);
    await send(w.third, w.g, "@anna 今天呢");
    await expect.poll(async () => (await ownerNotices(w.owner)).length).toBe(2);
  });

  it("the owner's own call is answered all the same, and does not count; a reply nobody asked for does", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    const carl = await agentOf(w.owner, "carlbot", w.g);
    await setLimit(w.owner, "2");
    // What its owner's own replies were charged today — in the group, in its own conversation — does not count: another member's
    // call is queued.
    await paid(anna, w.g, "own", 50 * POINT);
    await paid(anna, anna.conversationId, "own", 50 * POINT);
    await say(w.member, w.g, "@anna 你好");
    expect((await runsOf(anna.id, w.g)).at(-1)).toMatchObject({ status: "queued", lane: "others" });
    await settleAll();

    // Replies nobody asked for count (others caused them): reached, its owner's call is answered.
    await paid(carl, w.g, "proactive", 2 * POINT);
    const mine = await say(w.owner, w.g, "@anna 我来问");
    expect((await runsOf(anna.id, w.g)).at(-1)).toMatchObject({ status: "queued", lane: "own", covers: mine });
    // Another member's call is not even folded into that reply: it is refused, with its line.
    expect((await send(w.member, w.g, "@anna 我也问")).refused).toEqual(limitLine(anna));
    expect((await runsOf(anna.id, w.g)).at(-1)).toMatchObject({ status: "queued", lane: "own", covers: mine });
    await settleAll();
    // Through another of its owner's Agents, and in its own conversation: answered too.
    const called = await agentSays(carl.id, w.g, "@anna 你看看");
    expect([called.runs.length, called.notices, called.refused, called.reached]).toEqual([1, [], [], []]);
    expect((await runsOf(anna.id, w.g)).at(-1)).toMatchObject({ status: "queued", lane: "own" });
    await say(w.owner, anna.conversationId, "你好");
    expect((await runsOf(anna.id, anna.conversationId)).at(-1)).toMatchObject({ status: "queued", lane: "own" });
    // Its owner sees what others caused today, and only that.
    expect(await othersUse(w.owner)).toMatchObject({ limit: "2", used: "2", reached: true });
  });

  it("an Agent of someone else is refused the same way: the line is for the person behind its message alone (limits redesign C-d), the owner is told", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    const mia = await agentOf(w.member, "mia", w.g);
    await setLimit(w.owner, "2");
    await say(w.third, w.g, "开始");
    await paidOthers(anna, w.g, 2 * POINT);
    const before = await runsOf(anna.id, w.g);

    const refused = await agentSays(mia.id, w.g, "@anna 你看看");
    // Posted by no run: the person behind it is its Agent's owner, the member.
    expect([refused.runs, refused.callerLimited, refused.notices, refused.reached]).toEqual([[], [], [], [{ ownerId: w.owner.id, agentId: anna.id, pointsMicro: 2_000_000n }]]);
    expect(refused.refused).toEqual([{ conversationId: w.g, senderId: w.member.id, seq: refused.message.seq }]);
    expect((await readAs(w.member, w.g, refused.message.seq))?.refused).toEqual(limitLine(anna));
    expect(await readAs(w.third, w.g, refused.message.seq)).not.toHaveProperty("refused");
    expect(await runsOf(anna.id, w.g)).toEqual(before);

    // Its reply, as the worker posts it, in another group: the same; the owner is told once (after the refusal's commit).
    const g2 = await anotherGroup(w, "second");
    await join(g2, anna.id);
    await join(g2, mia.id);
    await say(w.member, g2, "@mia 问问 anna");
    gateway.reply("@anna 你也看看");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(await runsOf(anna.id, g2)).toEqual([]);
    expect(await noticesIn(g2)).toBe(0);
    await expect.poll(async () => (await ownerNotices(w.owner)).length).toBe(1);
  });

  it("a call others made that waited behind a reply is not queued once it is reached, and the caller is told on their message; its owner's is", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    await setLimit(w.owner, "2");
    const g2 = await anotherGroup(w, "second");
    const g3 = await anotherGroup(w, "third");
    for (const conv of [g2, g3]) await join(conv, anna.id);
    // A member's reply under way in each group, with a mention waiting behind it: another member's in the first and the
    // third, its owner's in the second.
    const tickets: RunTicket[] = [];
    for (const conv of [w.g, g2, g3]) {
      await say(w.member, conv, "@anna 一");
      tickets.push(await claim(anna, conv));
    }
    const noted = [await say(w.third, w.g, "@anna 二"), await say(w.owner, g2, "@anna 我也问"), await say(w.third, g3, "@anna 二")];
    for (const [i, conv] of [w.g, g2, g3].entries()) {
      expect((await runsOf(anna.id, conv)).at(-1)).toMatchObject({ status: "running" });
      expect(await waitingOf(anna.id, conv)).toEqual([noted[i]]);
    }
    // Others' use reaches the number before they end.
    await paidOthers(anna, w.g, 2 * POINT);
    const thirdSocket = await connect(app, w.third);

    // The first ends: what the other member asked meanwhile is not answered; that member's message is pushed to them again, with
    // its line.
    await app.agentPort.finish(tickets[0]!, { status: "done" }, null, NOTHING);
    const pushed = await thirdSocket.next((x) => x.type === "message" && x.message.seq === noted[0] && Array.isArray(x.message.refused));
    expect([pushed.message.conversationId, pushed.message.refused]).toEqual([w.g, limitLine(anna)]);
    expect((await runsOf(anna.id, w.g)).filter((r) => r.status !== "done")).toEqual([]);

    // The second: what its owner asked is answered, as its owner's own.
    await app.agentPort.finish(tickets[1]!, { status: "done" }, null, NOTHING);
    expect((await runsOf(anna.id, g2)).at(-1)).toMatchObject({ status: "queued", lane: "own", covers: noted[1] });
    expect(await readAs(w.owner, g2, noted[1]!)).not.toHaveProperty("refused");

    // The third, released after its reply was posted (recovery's way): the same rule as the first.
    await db.tx((t) => insertMessage(t, g3, anna.id, "text", { text: "回答" }, tickets[2]!.id));
    expect(await app.agentPort.releaseRun(tickets[2]!.id)).toBe(true);
    expect((await runsOf(anna.id, g3)).map((r) => r.status)).toEqual(["done"]);
    expect((await readAs(w.third, g3, noted[2]!))?.refused).toEqual(limitLine(anna));
    await expect.poll(async () => (await ownerNotices(w.owner)).length).toBe(1);
  });

  it("checked again as a reply is admitted: one queued below the number ends there once others' use has reached it, with no call and no charge, and its sender is told", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    await setLimit(w.owner, "2");
    const g2 = await anotherGroup(w, "second");
    await join(g2, anna.id);
    // A micro-point short of the number: the member's calls in both groups are queued.
    await paidOthers(anna, w.g, 2 * POINT - 1);
    const first = await say(w.member, w.g, "@anna 一");
    const second = await say(w.member, g2, "@anna 二");
    expect([(await runsOf(anna.id, w.g)).at(-1), (await runsOf(anna.id, g2)).at(-1)]).toEqual([
      expect.objectContaining({ status: "queued", lane: "others" }),
      expect.objectContaining({ status: "queued", lane: "others" }),
    ]);

    // The micro-point is used while they wait (nothing is reserved against the number: only what is used counts). The first, as the
    // worker takes it, ends as it is admitted — no model call, nothing charged — and its sender's message carries the line.
    await paidOthers(anna, g2, 1);
    const calls = gateway.calls.length;
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(gateway.calls.length).toBe(calls);
    const ended = async (conv: string) =>
      (
        await db.query<{ id: string; status: string; error: string | null; source: string | null }>(
          "select id, status, error, source from agent_runs where agent_id = $1 and conversation_id = $2 and covers_seq > 0 order by created_at desc limit 1",
          [anna.id, conv],
        )
      ).rows;
    expect((await ended(w.g)).map(({ status, error, source }) => ({ status, error, source }))).toEqual([{ status: "cancelled", error: null, source: null }]);
    const charged = await db.query("select coalesce(sum(free_micro + balance_micro), 0)::text as charged from usage_records where run_id = $1", [(await ended(w.g))[0]!.id]);
    expect(charged.rows[0].charged).toBe("0");
    expect((await readAs(w.member, w.g, first))?.refused).toEqual(limitLine(anna));

    // The second, in the other group: the same; the owner is told once.
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(gateway.calls.length).toBe(calls);
    expect((await ended(g2)).map(({ status, error, source }) => ({ status, error, source }))).toEqual([{ status: "cancelled", error: null, source: null }]);
    expect((await readAs(w.member, g2, second))?.refused).toEqual(limitLine(anna));
    await expect.poll(async () => (await ownerNotices(w.owner)).length).toBe(1);
    expect([await noticesIn(w.g), await noticesIn(g2)]).toEqual([0, 0]);
    expect(await othersUse(w.owner)).toMatchObject({ used: "2" });
  });

  it.each([
    ["its owner's is answered", "owner", true],
    ["another member's meets the number again: nothing, and the line on their message", "third", false],
  ] as const)("a mention that waited from between the claim and an admission the number refused is taken as it ends: %s", async (_what, who, answered) => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    await setLimit(w.owner, "2");
    await paidOthers(anna, w.g, 2 * POINT - 1);
    await say(w.member, w.g, "@anna 一");
    const ticket = await app.agentPort.claimNext();
    expect(ticket?.conversationId).toBe(w.g);
    // Claimed (running), the reply has a mention waiting behind it before it begins; then the number is reached.
    const asked = await say(w[who], w.g, "@anna 我也问");
    expect((await runsOf(anna.id, w.g)).at(-1)).toMatchObject({ status: "running" });
    expect(await waitingOf(anna.id, w.g)).toEqual([asked]);
    await paidOthers(anna, w.g, 1);
    const calls = gateway.calls.length;
    const end = await app.agentPort.begin(ticket!);
    expect(end).toEqual({ status: "cancelled" });
    await app.agentPort.finish(ticket!, end as RunEnd, null, NOTHING);
    expect(gateway.calls.length).toBe(calls);
    const queued = (await runsOf(anna.id, w.g)).filter((r) => r.status === "queued");
    if (!answered) {
      expect(queued).toEqual([]);
      expect((await readAs(w.third, w.g, asked))?.refused).toEqual(limitLine(anna));
      return;
    }
    // The owner's mention: a reply of its own covering it, answered when it runs.
    expect(queued).toEqual([expect.objectContaining({ lane: "own", covers: asked })]);
    gateway.reply("好的");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(gateway.calls.length).toBe(calls + 1);
    expect((await runsOf(anna.id, w.g)).at(-1)).toMatchObject({ status: "done", lane: "own", covers: asked });
  });

  it("a reply being written counts nothing until it is settled: one for others under way, holding far more than the number, refuses no call", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    await setLimit(w.owner, "2");
    const g2 = await anotherGroup(w, "second");
    await join(g2, anna.id);
    await holding(anna, g2, "others", 50 * POINT);
    const asked = await say(w.member, w.g, "@anna 一");
    expect((await runsOf(anna.id, w.g)).at(-1)).toMatchObject({ status: "queued", lane: "others", covers: asked });
    expect(await othersUse(w.owner)).toMatchObject({ used: "0", reached: false });
  });

  it("a person's mention it refused never waits, so it is no call of the reply after it, whose answer it lies in: that reply is the caller's whose mention waited", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    await setLimit(w.owner, "2");
    await say(w.member, w.g, "@anna 一");
    const ticket = await claim(anna, w.g);
    // The number is reached while the reply runs: the third's mention is refused (nothing waits), with its line.
    await paidOthers(anna, w.g, 2 * POINT);
    expect((await send(w.third, w.g, "@anna 二")).refused).toEqual(limitLine(anna));
    expect(await waitingOf(anna.id, w.g)).toEqual([]);
    // Raised, the member's next mention waits behind the reply under way, after the third's.

    await setLimit(w.owner, "10");
    const asked = await say(w.member, w.g, "@anna 三");
    await app.agentPort.finish(ticket, { status: "done" }, null, NOTHING);
    const queued = await db.query("select lane, caller_id, covers_seq::int as covers from agent_runs where agent_id = $1 and conversation_id = $2 and status = 'queued'", [
      anna.id,
      w.g,
    ]);
    expect(queued.rows).toEqual([{ lane: "others", caller_id: w.member.id, covers: asked }]);
  });

  it("yesterday's use does not count", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    await setLimit(w.owner, "2");
    const dayStart = siteDayStart(new Date(), app.deps.config.siteTimezone, 0);
    await paidOthers(anna, w.g, 50 * POINT, new Date(dayStart.getTime() - 1000));
    await say(w.member, w.g, "@anna 你好");
    expect((await runsOf(anna.id, w.g)).at(-1)).toMatchObject({ status: "queued", lane: "others" });
    expect(await othersUse(w.owner)).toMatchObject({ used: "0" });
    await settleAll();
    // From the day's first instant it counts.
    await paidOthers(anna, w.g, 2 * POINT, dayStart);
    const before = await runsOf(anna.id, w.g);
    expect((await send(w.member, w.g, "@anna 再问")).refused).toEqual(limitLine(anna));
    expect(await runsOf(anna.id, w.g)).toEqual(before);
  });

  it("raising it restores calls at once; lowering it below today's use refuses; the Agents carry no number of their own", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    await setLimit(w.owner, "2");
    await paidOthers(anna, w.g, 2.5 * POINT);
    const queued = async (who: Actor, text: string) => {
      const seq = await say(who, w.g, text);
      const last = (await runsOf(anna.id, w.g)).at(-1);
      return last?.status === "queued" && last.covers === seq;
    };

    expect(await queued(w.member, "@anna 一")).toBe(false);
    // Raised above today's use (2.5 points): answered at once.
    expect(await setLimit(w.owner, "3")).toEqual({ points: "3" });
    expect(await othersUse(w.owner)).toMatchObject({ limit: "3", used: "2.5", reached: false });
    expect(await queued(w.member, "@anna 二")).toBe(true);
    await db.query("update agent_runs set status = 'done', finished_at = now() where agent_id = $1 and conversation_id = $2", [anna.id, w.g]);
    // Lowered below it: refused at once.
    await setLimit(w.owner, "1");
    expect(await queued(w.third, "@anna 三")).toBe(false);
    // No Agent has a number or a count of its own any more.
    const listed = (await api(app, w.owner, "GET", "/api/agents")).json.agents as Array<Record<string, unknown>>;
    expect(listed.flatMap((a) => ["othersLimit", "othersUsedToday", "proactiveBudget", "proactiveSpentToday"].filter((k) => Object.hasOwn(a, k)))).toEqual([]);
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

  it("the owner's number comes before the caller's limit: a caller over his limit is told the number is reached, not that he calls too often, and no limit is logged", async () => {
    const [owner, member, third] = [await signUp(limited, "owner"), await signUp(limited, "member"), await signUp(limited, "third")];
    const g = await group(limited, owner, "team", [member, third]);
    const make = async (by: Actor, handle: string) => {
      const made = await mustCreateAgent(limited, by, { handle, name: handle, model: FAST, persona: "简短地回答。" });
      await join(g, made.id);
      return { id: made.id, ownerId: by.id, conversationId: made.conversationId };
    };
    const anna = await make(owner, "anna");
    // Another owner's Agent, whose owner's number is far off.
    const carl = await make(third, "carlbot");
    expect((await api(limited, owner, "PUT", "/api/me/others-limits", { points: "2" })).status).toBe(200);
    await paidOthers(anna, g, 2 * POINT);
    const sayIn = async (text: string) => {
      const sent = await api(limited, member, "POST", `/api/conversations/${g}/messages`, { text, clientTxn: `order${++txn}` });
      expect(sent.status).toBe(201);
      return sent.json.message as Record<string, unknown>;
    };

    // The member's one call of the minute on someone else's Agent is used up (queued)...
    await sayIn("@carlbot 你好");
    expect(await runsOf(carl.id, g)).toEqual([expect.objectContaining({ status: "queued", lane: "others" })]);
    // ...so this call is over his limit, and the owner's number is reached too: the number answers.
    const answered = await sayIn("@anna 你好");
    expect(answered.refused).toEqual([{ agentId: anna.id, reason: "others_limit" }]);
    expect(lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((e) => e.metric === "caller_rate_limited")).toEqual([]);
  });
});
