import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { postAsAgent, type PostedReply } from "../src/agents/conversation.ts";
import { NOTHING, type RunTicket } from "../src/agents/runtime/port.ts";
import { behindAgentMessage, behindMessageSql, triggerFromAgent, type Caller } from "../src/agents/runs.ts";
import { lockAgent } from "../src/agents/store.ts";
import { mentionsAtSend } from "../src/agents/mentions.ts";
import { insertMessage } from "../src/messages/model.ts";
import { api, group, signUp, type Actor } from "./helpers/actors.ts";
import { latestRunId, mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";

/**
 * Who called for each run, and its lane (`agent_runs.caller_id`, `lane`; the limits plan, Task 1): `own` when the Agent's
 * owner called for it — themselves, or through an Agent's message they are behind — and `others` when someone else did,
 * with who. An Agent's message is the call of the person behind it: the caller of the run that posted it when that run is
 * not its owner's own (a member's call relayed through the owner's Agent stays the member's), else its owner. The limits
 * read these two columns (Task 2, at the end): an owner's replies a minute are counted apart in their own lane and in
 * the others', and one person's calls on other people's Agents have a limit of their own. As in
 * agents-group-trigger.test.ts, an Agent is put into a group by inserting its membership row, and an Agent's own message
 * is stored and handed to `triggerFromAgent` in one transaction, as `postAsAgent` does — posted by no run, so its owner
 * is behind it; the relays go through the worker (`runOnce`), whose run posts the message.
 */

const gateway = scriptedGateway();
// Runs are only queued here: no worker may pick them up.
const { app, db } = useApp({ env: SITE_ENV, models: gateway, agentWorker: false });

afterEach(() => {
  expect(gateway.pending()).toBe(0);
});

const FAST = { source: "site", id: "fast" } as const;

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

// The helpers below act through `app` unless given another instance (`on`): the limits tests at the end build their
// own, with small limits, on the same database.

/** Puts principal `id` into conversation `conv` from its current seq on. */
const join = (conv: string, id: string) =>
  db.query(`insert into memberships (conversation_id, principal_id, role, joined_seq) select $1, $2, 'speaker', seq from conversations where id = $1`, [
    conv,
    id,
  ]);

/** An Agent of `owner` with `handle` (also its name), answering on the site model, put into `conv` when given. */
async function agentOf(owner: Actor, handle: string, conv: string | null, on: FastifyInstance = app) {
  const agent = await mustCreateAgent(on, owner, { handle, name: handle, model: FAST, persona: "简短地回答。" });
  if (conv) await join(conv, agent.id);
  return agent as { id: string; handle: string; conversationId: string };
}

let txn = 0;
const say = async (who: Actor, conv: string, text: string, on: FastifyInstance = app): Promise<number> => {
  const sent = await api(on, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `ln${++txn}` });
  if (sent.status !== 201) throw new Error(`say: ${sent.status} ${JSON.stringify(sent.json)}`);
  return sent.json.message.seq as number;
};

/**
 * The Agent's own message in `conv`, stored and handed to the trigger in one transaction, as `postAsAgent` does — posted
 * by no run, so its owner is behind it.
 */
const agentSays = (agentId: string, conv: string, text: string, on: FastifyInstance = app) =>
  db.tx(async (t) => {
    const poster = await lockAgent(t, agentId, conv);
    const message = await insertMessage(t, conv, agentId, "text", { text }, null, await mentionsAtSend(t, { id: conv, type: "group" }, text));
    // Posted by no run: whose question it carries is not known (null, the safe side; Task 10b).
    return { message, ...(await triggerFromAgent(t, conv, message, poster, null, on.deps.config, null)) };
  });

/** The Agent's runs in `conv`, oldest first: each one's lane and who called for it. */
const laneOf = async (agentId: string, conv: string): Promise<Array<[string, string | null]>> =>
  (
    await db.query<{ lane: string; caller_id: string | null }>(
      "select lane, caller_id from agent_runs where agent_id = $1 and conversation_id = $2 order by created_at, id",
      [agentId, conv],
    )
  ).rows.map((r) => [r.lane, r.caller_id]);

/** Ends every active run, and drops every call waiting for one, so that the next trigger queues a new one. */
const settleAll = async () => {
  await db.query("delete from deferred_calls");
  await db.query("update agent_runs set status = 'done', finished_at = now() where status in ('queued', 'running')");
};
/** The calls waiting for `agentId` in `conv` (`deferred_calls`), oldest first: [seq, lane, caller]. */
const waitingOf = async (agentId: string, conv: string): Promise<Array<[number, string, string | null]>> =>
  (
    await db.query<{ seq: number; lane: string; caller_id: string | null }>(
      "select message_seq::int as seq, lane, caller_id from deferred_calls where agent_id = $1 and conversation_id = $2 order by message_seq",
      [agentId, conv],
    )
  ).rows.map((r) => [r.seq, r.lane, r.caller_id]);
/** The calls of the Agent's runs in `conv` (`call_seqs`), oldest first. */
const callsOf = async (agentId: string, conv: string): Promise<number[][]> =>
  (await db.query<{ calls: number[] }>("select call_seqs::int[] as calls from agent_runs where agent_id = $1 and conversation_id = $2 order by created_at, id", [agentId, conv])).rows.map(
    (r) => r.calls,
  );

/** The Agent's queued run in `conv`, made running as the worker's claim makes it. */
const claim = async (agentId: string, conv: string): Promise<RunTicket> => {
  const { rows } = await db.query<{ id: string; owner_id: string }>(
    "update agent_runs set status = 'running', started_at = now() where agent_id = $1 and conversation_id = $2 and status = 'queued' returning id, owner_id",
    [agentId, conv],
  );
  return { id: rows[0]!.id, agentId, ownerId: rows[0]!.owner_id, conversationId: conv };
};

/** Ends a running run as the worker ends one that answered: `finish`, which follows it up. */
const finish = (ticket: RunTicket, on: FastifyInstance = app) => on.agentPort.finish(ticket, { status: "done" }, null, NOTHING);

/**
 * Twenty replies of `agentId`'s in each lane, its owner's own and others', started half a minute ago in `conv`: its
 * owner's replies a minute, in both lanes, are used up.
 */
/** The senders and reasons of the refusals of calls on `agentId` in `conv` (`call_refusals`), in the order they were recorded. */
const refusalsOf = async (agentId: string, conv: string) =>
  (await db.query<{ sender_id: string; reason: string }>("select sender_id, reason from call_refusals where agent_id = $1 and conversation_id = $2 order by created_at, seq", [agentId, conv])).rows.map(
    (r) => [r.sender_id, r.reason],
  );
const useUpTheMinute = (conv: string, agentId: string, ownerId: string) =>
  db.query(
    `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, created_at, finished_at, lane)
     select 'reply', $1, $2, $3, 'done', 0, now() - interval '30 seconds', now() - interval '29 seconds', lane
       from generate_series(1, 20), unnest(array['own', 'others']) lane`,
    [conv, agentId, ownerId],
  );

describe("a run's lane and who called for it", () => {
  it("the owner's mention is own, another member's is others, with who called", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    await say(w.owner, w.g, "@anna 你好");
    expect(await laneOf(anna.id, w.g)).toEqual([["own", w.owner.id]]);
    await settleAll();
    await say(w.member, w.g, "@anna 你好");
    expect(await laneOf(anna.id, w.g)).toEqual([
      ["own", w.owner.id],
      ["others", w.member.id],
    ]);
  });

  it("an Agent's mention carries its owner as the caller", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    const carl = await agentOf(w.owner, "carlbot", w.g);
    const beta = await agentOf(w.member, "beta", w.g);
    await say(w.third, w.g, "开始吧");
    await agentSays(beta.id, w.g, "@anna 你来");
    expect(await laneOf(anna.id, w.g)).toEqual([["others", w.member.id]]);
    await agentSays(anna.id, w.g, "@carlbot 你也来");
    expect(await laneOf(carl.id, w.g)).toEqual([["own", w.owner.id]]);
  });

  it("its own conversation is own, and so is a follow-up there", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", null);
    await say(w.owner, anna.conversationId, "你好");
    expect(await laneOf(anna.id, anna.conversationId)).toEqual([["own", w.owner.id]]);
    const one = await claim(anna.id, anna.conversationId);
    await say(w.owner, anna.conversationId, "还有一件事");
    await finish(one);
    expect(await laneOf(anna.id, anna.conversationId)).toEqual([
      ["own", w.owner.id],
      ["own", w.owner.id],
    ]);
  });

  it("folding (limits redesign, Part 2): a call is folded only into a queued, never claimed reply of its own identity with nothing waiting; any other call waits for a reply of its own, and the run's lane and caller never change", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    const carl = await agentOf(w.owner, "carlbot", w.g);
    const one = await say(w.member, w.g, "@anna 一");
    const two = await say(w.member, w.g, "@anna 二");
    expect(await laneOf(anna.id, w.g)).toEqual([["others", w.member.id]]);
    expect(await callsOf(anna.id, w.g)).toEqual([[one, two]]);
    // The owner's mention and another member's: each of another identity, so each waits; the run stays the member's.
    const three = await say(w.owner, w.g, "@anna 三");
    const four = await say(w.third, w.g, "@anna 四");
    // Once something waits, the member's own next call waits too (nothing passes the head).
    const five = await say(w.member, w.g, "@anna 五");
    expect(await laneOf(anna.id, w.g)).toEqual([["others", w.member.id]]);
    expect(await waitingOf(anna.id, w.g)).toEqual([
      [three, "own", w.owner.id],
      [four, "others", w.third.id],
      [five, "others", w.member.id],
    ]);

    // The owner's call and one of the owner's Agents': one identity, so one reply, the owner's own; a member's after it waits.
    await settleAll();
    const eight = await say(w.owner, w.g, "@anna 八");
    await agentSays(carl.id, w.g, "@anna 也看看");
    expect((await laneOf(anna.id, w.g)).at(-1)).toEqual(["own", w.owner.id]);
    expect((await callsOf(anna.id, w.g)).at(-1)).toHaveLength(2);
    expect((await callsOf(anna.id, w.g)).at(-1)![0]).toBe(eight);
    const nine = await say(w.third, w.g, "@anna 九");
    expect((await laneOf(anna.id, w.g)).at(-1)).toEqual(["own", w.owner.id]);
    expect(await waitingOf(anna.id, w.g)).toEqual([[nine, "others", w.third.id]]);

    // A running run is never folded into, not even by its own caller: the call waits, and the run stays as it was.
    await settleAll();
    await say(w.member, w.g, "@anna 六");
    await claim(anna.id, w.g);
    const seven = await say(w.member, w.g, "@anna 七");
    expect((await laneOf(anna.id, w.g)).at(-1)).toEqual(["others", w.member.id]);
    expect(await waitingOf(anna.id, w.g)).toEqual([[seven, "others", w.member.id]]);
  });

  it("the calls that waited are answered in their own identities, in the order they were made", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    const carl = await agentOf(w.owner, "carlbot", w.g);
    const beta = await agentOf(w.third, "beta", w.g);

    // A member's reply under way; the owner mentions it meanwhile, then the member: two replies after it, the owner's own first.
    await say(w.member, w.g, "@anna 一");
    const one = await claim(anna.id, w.g);
    await say(w.owner, w.g, "@anna 我也问");
    await say(w.member, w.g, "@anna 还有");
    await finish(one);
    await finish(await claim(anna.id, w.g));
    expect(await laneOf(anna.id, w.g)).toEqual([
      ["others", w.member.id],
      ["own", w.owner.id],
      ["others", w.member.id],
    ]);

    // An Agent of someone else's is its owner's call (the third's); one of the owner's Agents, the owner's own.
    await settleAll();
    await say(w.member, w.g, "@anna 三");
    const three = await claim(anna.id, w.g);
    await agentSays(beta.id, w.g, "@anna 补充");
    await agentSays(carl.id, w.g, "@anna 也看看");
    await finish(three);
    await finish(await claim(anna.id, w.g));
    expect((await laneOf(anna.id, w.g)).slice(3)).toEqual([
      ["others", w.member.id],
      ["others", w.third.id],
      ["own", w.owner.id],
    ]);
  });

  it("a call that waited from someone the owner has blocked since is dropped as it is taken: no reply, and nothing rides the owner's own lane", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    await say(w.third, w.g, "@anna 一");
    const one = await claim(anna.id, w.g);
    await say(w.member, w.g, "@anna 我也问");
    expect((await api(app, w.owner, "PUT", `/api/blocks/${w.member.id}`)).status).toBe(200);
    await finish(one);
    expect(await laneOf(anna.id, w.g)).toEqual([["others", w.third.id]]);
    expect(await waitingOf(anna.id, w.g)).toEqual([]);
  });

  it("a rate-limited record carries them too: the owner's own, over their minute; someone else's call over the others' minute records nothing but its sender's line", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    const carl = await agentOf(w.owner, "carlbot", null);
    await useUpTheMinute(carl.conversationId, carl.id, w.owner.id);
    const errors = async (conv: string) =>
      (await db.query<{ error: string | null }>("select error from agent_runs where agent_id = $1 and conversation_id = $2 order by created_at, id", [anna.id, conv])).rows.map(
        (r) => r.error,
      );

    await say(w.member, w.g, "@anna 一");
    expect(await errors(w.g)).toEqual([]);
    expect(await refusalsOf(anna.id, w.g)).toEqual([[w.member.id, "too_often"]]);
    // The owner's own call: the record, its lane and caller the owner's.
    await say(w.owner, w.g, "@anna 三");
    expect(await errors(w.g)).toEqual(["rate_limited"]);
    expect(await laneOf(anna.id, w.g)).toEqual([["own", w.owner.id]]);
    // Another member's call meanwhile leaves it as it is: it is refused on its own, with its own line.
    await say(w.third, w.g, "@anna 二");
    expect(await laneOf(anna.id, w.g)).toEqual([["own", w.owner.id]]);
    expect(await errors(w.g)).toEqual(["rate_limited"]);
    expect(await refusalsOf(anna.id, w.g)).toEqual([
      [w.member.id, "too_often"],
      [w.third.id, "too_often"],
    ]);

    // In its own conversation: own.
    await say(w.owner, anna.conversationId, "你好");
    expect(await errors(anna.conversationId)).toEqual(["rate_limited"]);
    expect(await laneOf(anna.id, anna.conversationId)).toEqual([["own", w.owner.id]]);
  });

  it("a retry is its owner's own, whoever called for the run that failed", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    const fail = (agentId: string, conv: string) =>
      db.query("update agent_runs set status = 'failed', error = 'provider_unavailable', finished_at = now() where agent_id = $1 and conversation_id = $2 and status = 'queued'", [
        agentId,
        conv,
      ]);

    await say(w.member, w.g, "@anna 一");
    await fail(anna.id, w.g);
    expect((await api(app, w.owner, "POST", `/api/conversations/${w.g}/runs/retry`, { runId: await latestRunId(db, w.g, anna.id) })).status).toBe(201);
    expect(await laneOf(anna.id, w.g)).toEqual([
      ["others", w.member.id],
      ["own", w.owner.id],
    ]);

    await say(w.owner, anna.conversationId, "你好");
    await fail(anna.id, anna.conversationId);
    expect((await api(app, w.owner, "POST", `/api/conversations/${anna.conversationId}/runs/retry`, { runId: await latestRunId(db, anna.conversationId) })).status).toBe(201);
    expect(await laneOf(anna.id, anna.conversationId)).toEqual([
      ["own", w.owner.id],
      ["own", w.owner.id],
    ]);
  });

  it("a persona draft is its owner's own", async () => {
    const owner = await signUp(app, "drafter");
    gateway.reply("你是小橘，一个温和的读书伙伴。");
    expect((await api(app, owner, "POST", "/api/agents/draft-persona", { name: "小橘", model: FAST })).status).toBe(200);
    expect((await db.query("select purpose, lane, caller_id from agent_runs where owner_id = $1", [owner.id])).rows).toEqual([
      { purpose: "draft", lane: "own", caller_id: owner.id },
    ]);
  });

  it("a member's call relayed by the owner's Agent to another of the owner's Agents stays the member's", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    const carl = await agentOf(w.owner, "carlbot", w.g);
    await say(w.member, w.g, "@anna 问问 carlbot");
    gateway.reply("@carlbot 你也看看");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(await laneOf(anna.id, w.g)).toEqual([["others", w.member.id]]);
    expect(await laneOf(carl.id, w.g)).toEqual([["others", w.member.id]]);
  });

  it("relayed to the other Agent while a run of someone else's is queued there: the relayed call waits (another identity), that run stays as it was; the owner's own minute is untouched", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    const carl = await agentOf(w.owner, "carlbot", w.g);
    await say(w.member, w.g, "@anna 问问 carlbot");
    await say(w.third, w.g, "@carlbot 你好");
    // The owner's replies of their own lane started in the last minute, as the limit counts them.
    const ownMinute = async () =>
      Number(
        (
          await db.query(
            "select count(*) n from agent_runs where owner_id = $1 and purpose = 'reply' and lane = 'own' and created_at > now() - interval '1 minute' and error is distinct from 'rate_limited'",
            [w.owner.id],
          )
        ).rows[0].n,
      );
    expect(await ownMinute()).toBe(0);
    gateway.reply("@carlbot 你也看看");
    // The worker takes Anna's reply (the older), which names Carl: the member's call, relayed, waits behind the third's reply.
    expect(await app.agentWorker.runOnce()).toBe(true);
    const relayed = (await db.query<{ seq: string }>("select seq::text from messages where conversation_id = $1 and sender_id = $2", [w.g, anna.id])).rows[0]!;
    expect(await laneOf(carl.id, w.g)).toEqual([["others", w.third.id]]);
    expect(await waitingOf(carl.id, w.g)).toEqual([[Number(relayed.seq), "others", w.member.id]]);
    expect(await ownMinute()).toBe(0);
  });

  it("the owner's call relayed by their Agent to another of theirs is the owner's own", async () => {
    const w = await world();
    await agentOf(w.owner, "anna", w.g);
    const carl = await agentOf(w.owner, "carlbot", w.g);
    await say(w.owner, w.g, "@anna 问问 carlbot");
    gateway.reply("@carlbot 你也看看");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(await laneOf(carl.id, w.g)).toEqual([["own", w.owner.id]]);
  });

  it("the owner's call on someone else's Agent that names one of the owner's Agents is the owner's own", async () => {
    const w = await world();
    const carl = await agentOf(w.owner, "carlbot", w.g);
    const beta = await agentOf(w.third, "beta", w.g);
    await say(w.owner, w.g, "@beta 问问 carlbot");
    gateway.reply("@carlbot 你也看看");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(await laneOf(beta.id, w.g)).toEqual([["others", w.owner.id]]);
    expect(await laneOf(carl.id, w.g)).toEqual([["own", w.owner.id]]);
  });

  it.each([
    ["the called Agent's owner has blocked the person behind it", "third", "member"],
    ["the person behind it has blocked the called Agent's owner", "member", "third"],
  ] as const)(
    "a call relayed through someone else's Agent reaches nothing when %s; the relaying Agent's owner's own call does; lifting the block restores it",
    async (_what, blocker, blocked) => {
      const w = await world();
      await agentOf(w.owner, "alpha", w.g);
      const beta = await agentOf(w.third, "beta", w.g);
      expect((await api(app, w[blocker], "PUT", `/api/blocks/${w[blocked].id}`)).status).toBe(200);
      const notices = async () => Number((await db.query("select count(*) n from messages where conversation_id = $1 and kind = 'system'", [w.g])).rows[0].n);
      const relay = async (who: Actor, text: string) => {
        await say(who, w.g, text);
        gateway.reply("@beta 你看看");
        expect(await app.agentWorker.runOnce()).toBe(true);
      };

      // The member asks the owner's Alpha, whose reply names the third's Beta: as if the member had named Beta — no run,
      // no notice, nothing spent.
      const before = await notices();
      await relay(w.member, "@alpha 问问 beta");
      expect(await laneOf(beta.id, w.g)).toEqual([]);
      expect(await notices()).toBe(before);
      // The owner's own call through Alpha does reach Beta (no block between the owner and the third).
      await relay(w.owner, "@alpha 问问 beta");
      expect(await laneOf(beta.id, w.g)).toEqual([["others", w.owner.id]]);
      // Once the block is lifted, the member's call relayed so reaches Beta again.
      await settleAll();
      expect((await api(app, w[blocker], "DELETE", `/api/blocks/${w[blocked].id}`)).status).toBe(200);
      await relay(w.member, "@alpha 再问问 beta");
      expect(await laneOf(beta.id, w.g)).toEqual([
        ["others", w.owner.id],
        ["others", w.member.id],
      ]);
    },
  );

  it("a relayed call that waited for a reply under way is dropped as it is taken once a block stands between the person behind it and the Agent's owner", async () => {
    const w = await world();
    await agentOf(w.owner, "alpha", w.g);
    const beta = await agentOf(w.third, "beta", w.g);
    await say(w.third, w.g, "@beta 一");
    const one = await claim(beta.id, w.g);
    // While Beta's reply runs, the member asks the owner's Alpha to ask it: Alpha's message, the member's call, waits.
    await say(w.member, w.g, "@alpha 问问 beta");
    gateway.reply("@beta 你看看");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect((await waitingOf(beta.id, w.g)).map(([, lane, caller]) => [lane, caller])).toEqual([["others", w.member.id]]);
    // Then Beta's owner blocks the member: as Beta's reply ends the relayed call is held to the block, and nothing is queued.
    expect((await api(app, w.third, "PUT", `/api/blocks/${w.member.id}`)).status).toBe(200);
    await finish(one);
    expect(await laneOf(beta.id, w.g)).toEqual([["own", w.third.id]]);
    expect(await waitingOf(beta.id, w.g)).toEqual([]);
  });

  it("a reply nobody called for names nobody: what it calls is others', with no caller", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    const carl = await agentOf(w.owner, "carlbot", w.g);
    await say(w.third, w.g, "开始吧");
    // A running reply of Anna's in lane others with no caller (a follow-up whose callers it can no longer see, `followUp`).
    const run = await db.query<{ id: string }>(
      `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, started_at, lane)
       select 'reply', $1, $2, $3, 'running', seq, now(), 'others' from conversations where id = $1 returning id`,
      [w.g, anna.id, w.owner.id],
    );
    // A reply in a group is posted with the mark its run drew: this run, made by hand, is given one.
    const posted = await db.tx((t) =>
      postAsAgent(t, anna.id, w.g, run.rows[0]!.id, { text: "@carlbot 你看看", reasoning: "", stopped: false, truncated: false }, "k7f2ab", app.deps.config),
    );
    expect((posted as PostedReply | null)?.triggered.runs).toHaveLength(1);
    expect(await laneOf(carl.id, w.g)).toEqual([["others", null]]);
  });

  it("a follow-up answering a relayed call takes the relayed caller", async () => {
    const w = await world();
    await agentOf(w.owner, "anna", w.g);
    const carl = await agentOf(w.owner, "carlbot", w.g);
    await say(w.third, w.g, "@carlbot 一");
    const one = await claim(carl.id, w.g);
    // While Carl's reply runs, the member asks Anna to ask him: her message is noted on his reply.
    await say(w.member, w.g, "@anna 问问 carlbot");
    gateway.reply("@carlbot 你也看看");
    expect(await app.agentWorker.runOnce()).toBe(true);
    await finish(one);
    expect(await laneOf(carl.id, w.g)).toEqual([
      ["others", w.third.id],
      ["others", w.member.id],
    ]);
  });

  /**
   * Beta (the member's) replies to the third; while it runs, Delta (the member's too: its message, posted by no run, is
   * the member's own call) names Beta and is refused by `refuse`. Alone nothing waits and nothing follows; with the third's mention
   * waiting after it, the next reply is the third's and answers that call only — the refused mention never waited.
   */
  const refusedThenAsked = async (refuse: (w: World, betaId: string) => Promise<string[]>) => {
    const w = await world();
    const beta = await agentOf(w.member, "beta", w.g);
    const delta = await agentOf(w.member, "delta", w.g);
    const lastWaiting = async () => (await waitingOf(beta.id, w.g)).at(-1)?.[0] ?? null;
    // Beta's runs as `laneOf` gives them, less the fixtures `refuse` made.
    const fixtures: string[] = [];
    const lanes = async () =>
      (
        await db.query<{ lane: string; caller_id: string | null }>(
          "select lane, caller_id from agent_runs where agent_id = $1 and conversation_id = $2 and id <> all($3::uuid[]) order by created_at, id",
          [beta.id, w.g, fixtures],
        )
      ).rows.map((r) => [r.lane, r.caller_id]);

    // Only the refused mention after what the reply covers: nothing is noted, nothing follows.
    await say(w.third, w.g, "@beta 一");
    const one = await claim(beta.id, w.g);
    fixtures.push(...(await refuse(w, beta.id)));
    expect((await agentSays(delta.id, w.g, "@beta 你看看")).runs).toEqual([]);
    expect(await lastWaiting()).toBeNull();
    await finish(one);
    expect(await lanes()).toEqual([["others", w.third.id]]);

    // The same, then the third's mention noted on the reply: the follow-up is the third's, not the member's own.
    await say(w.third, w.g, "@beta 二");
    const two = await claim(beta.id, w.g);
    fixtures.push(...(await refuse(w, beta.id)));
    expect((await agentSays(delta.id, w.g, "@beta 你再看看")).runs).toEqual([]);
    const asked = await say(w.third, w.g, "@beta 三");
    expect(await lastWaiting()).toBe(asked);
    await finish(two);
    expect((await lanes()).slice(1)).toEqual([
      ["others", w.third.id],
      ["others", w.third.id],
    ]);
    expect((await callsOf(beta.id, w.g)).at(-1)).toEqual([asked]);
  };

  it("an Agent's mention refused because the group was halted never counts as a call of a later follow-up", async () => {
    await refusedThenAsked(async (w) => {
      expect((await api(app, w.owner, "POST", `/api/conversations/${w.g}/agents/halt`)).status).toBe(200);
      return [];
    });
  });

  it("an Agent's mention refused by the called Agent's chain budget never counts as a call of a later follow-up", async () => {
    let budgetSet = false;
    await refusedThenAsked(async (w, betaId) => {
      if (!budgetSet) {
        expect((await api(app, w.member, "PATCH", `/api/agents/${betaId}`, { chainBudget: "1" })).status).toBe(200);
        budgetSet = true;
      }
      // A reply of Beta's in the group covering a message after the latest from a person, charged a point: spent.
      const run = await db.query<{ id: string }>(
        `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, source, model, charge_to, finished_at)
         select 'reply', $1, $2, $3, 'done', seq + 1, 'site', 'fast', 'balance', now() from conversations where id = $1 returning id`,
        [w.g, betaId, w.member.id],
      );
      await db.query(
        `insert into usage_records (owner_id, agent_id, run_id, purpose, source, model, cost_micro, balance_micro, outcome)
         values ($1, $2, $3, 'reply', 'site', 'fast', 1000000, 1000000, 'done')`,
        [w.member.id, betaId, run.rows[0]!.id],
      );
      return [run.rows[0]!.id];
    });
  });

  it("who is behind an Agent's message: behindAgentMessage and its SQL twin give the same person, whatever run posted it", async () => {
    const [agentId, ownerId, callerId, personId] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    /** `behindMessageSql` for a message of sender `id` (owned by `owner`) posted by a run of `postedBy`'s (none: null). */
    const inSql = async (id: string, owner: string | null, postedBy: Caller | null) =>
      (
        await db.query<{ behind: string | null }>(
          `select ${behindMessageSql("p", "r")} as behind
             from (select $1::uuid as id, $2::uuid as owner_id) p
             left join (select $3::text as lane, $4::uuid as caller_id) r on $5::boolean`,
          [id, owner, postedBy?.lane ?? null, postedBy?.id ?? null, postedBy !== null],
        )
      ).rows[0]!.behind;
    const cases: Array<Caller | null> = [
      null,
      { id: ownerId, lane: "own" },
      { id: callerId, lane: "own" },
      { id: callerId, lane: "others" },
      { id: null, lane: "others" },
      { id: callerId, lane: "proactive" },
      { id: null, lane: "proactive" },
    ];
    for (const postedBy of cases) expect([postedBy, await inSql(agentId, ownerId, postedBy)]).toEqual([postedBy, behindAgentMessage(ownerId, postedBy)]);
    // A person's message (no run posted it) has that person behind it.
    expect(await inSql(personId, null, null)).toBe(personId);
  });

  it("is never on the wire: a run's owner and the other members see no lane and no caller", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    await say(w.member, w.g, "@anna 你好");
    await db.query("update agent_runs set status = 'failed', error = 'provider_unavailable', finished_at = now() where agent_id = $1", [anna.id]);
    for (const who of [w.owner, w.member]) {
      const seen = JSON.stringify((await api(app, who, "GET", `/api/conversations/${w.g}/runs`)).json);
      expect([who.id, seen.includes("unavailable"), /lane|caller/i.test(seen)]).toEqual([who.id, true, false]);
    }
  });
});

describe("replies a minute by lane, and one caller's limit on other people's Agents", () => {
  // Its own instance, on the same database, with small limits: an owner's own replies 2 a minute, those others call for
  // 2, and one person's calls on other people's Agents 1. Its log (info and above) is kept here.
  const lines: string[] = [];
  const { app: limited } = useApp({
    env: { ...SITE_ENV, AGENT_RUNS_PER_MINUTE: "2", AGENT_OTHERS_RUNS_PER_MINUTE: "2", AGENT_CALLER_RUNS_PER_MINUTE: "1" },
    models: gateway,
    agentWorker: false,
    logStream: { write: (line) => void lines.push(line) },
  });

  /** Four people in one group: its owner, and three others. */
  async function crowd() {
    const [owner, member, third, fourth] = [await signUp(limited, "owner"), await signUp(limited, "member"), await signUp(limited, "third"), await signUp(limited, "fourth")];
    return { owner, member, third, fourth, g: await group(limited, owner, "team", [member, third, fourth]) };
  }

  /** The Agent's runs in `conv`, oldest first: status, error, what each covers. */
  const runsOf = async (agentId: string, conv: string) =>
    (
      await db.query<{ status: string; error: string | null; covers: number }>(
        "select status, error, covers_seq::int as covers from agent_runs where agent_id = $1 and conversation_id = $2 order by created_at, id",
        [agentId, conv],
      )
    ).rows;
  const statusOf = async (agentId: string, conv: string) => (await runsOf(agentId, conv)).map((r) => [r.status, r.error]);

  /** The log lines of calls their caller's limit refused. */
  const callerLimited = () =>
    lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((e) => e.metric === "caller_rate_limited")
      .map(({ metric, callerId, agentId, conversationId }) => ({ metric, callerId, agentId, conversationId }));

  const noticeCount = async (conv: string) =>
    Number((await db.query("select count(*) n from messages where conversation_id = $1 and kind = 'system'", [conv])).rows[0].n);

  /** `n` replies of `agentId`'s in `lane`, started half a minute ago in `conv` (covering nothing there): they count this minute. */
  const startedEarlier = (conv: string, agentId: string, ownerId: string, lane: "own" | "others" | "proactive", n: number) =>
    db.query(
      `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, created_at, finished_at, lane)
       select 'reply', $1, $2, $3, 'done', 0, now() - interval '30 seconds', now() - interval '29 seconds', $4 from generate_series(1, $5)`,
      [conv, agentId, ownerId, lane, n],
    );

  it("replies nobody called for (lane proactive) count with others' calls in the owner's others' minute, not in their own", async () => {
    const w = await crowd();
    const anna = await agentOf(w.owner, "anna", w.g, limited);
    await startedEarlier(w.g, anna.id, w.owner.id, "proactive", 2);
    // The others' two a minute are used up: a member's call starts nothing, its sender's line the one result.
    await say(w.member, w.g, "@anna 一", limited);
    expect(await statusOf(anna.id, w.g)).toEqual([
      ["done", null],
      ["done", null],
    ]);
    expect(await refusalsOf(anna.id, w.g)).toEqual([[w.member.id, "too_often"]]);
    // The owner's own call in the same minute starts a reply.
    await say(w.owner, w.g, "@anna 我来问", limited);
    expect((await statusOf(anna.id, w.g)).at(-1)).toEqual(["queued", null]);
  });

  it("its owner's retry in a group is held to their own lane: with the others' lane full it is answered; with their own full, 429", async () => {
    const w = await crowd();
    const anna = await agentOf(w.owner, "anna", w.g, limited);
    const retry = async () => api(limited, w.owner, "POST", `/api/conversations/${w.g}/runs/retry`, { runId: await latestRunId(db, w.g, anna.id) });
    const failQueued = () =>
      db.query("update agent_runs set status = 'failed', error = 'provider_unavailable', finished_at = now() where agent_id = $1 and status = 'queued'", [anna.id]);
    // A member's call, which failed; with one more of others' this minute, the others' lane is full.
    await say(w.member, w.g, "@anna 一", limited);
    await failQueued();
    await startedEarlier(w.g, anna.id, w.owner.id, "others", 1);
    expect((await retry()).status).toBe(201);
    expect((await laneOf(anna.id, w.g)).at(-1)).toEqual(["own", w.owner.id]);
    // That retry failed too; with one more of the owner's own this minute, their own lane is full: 429.
    await failQueued();
    await startedEarlier(w.g, anna.id, w.owner.id, "own", 1);
    expect(await retry()).toEqual({ status: 429, json: { error: "rate_limited" } });
  });

  it("a call is met by the minutes as it is accepted, never later (C-a): one that waited is answered though the others' minute filled since; one made over the minute is refused at once and never waits", async () => {
    const w = await crowd();
    const anna = await agentOf(w.owner, "anna", w.g, limited);
    await say(w.member, w.g, "@anna 一", limited);
    const one = await claim(anna.id, w.g);
    // The third's mention waits behind the member's reply (the others' minute: one reply and this call, two of two).
    const asked = await say(w.third, w.g, "@anna 二", limited);
    expect(await waitingOf(anna.id, w.g)).toEqual([[asked, "others", w.third.id]]);
    // Full now: the fourth's call is refused as it is made, its sender alone told, and nothing of it waits.
    const late = await say(w.fourth, w.g, "@anna 三", limited);
    expect(await waitingOf(anna.id, w.g)).toEqual([[asked, "others", w.third.id]]);
    expect(await refusalsOf(anna.id, w.g)).toEqual([[w.fourth.id, "too_often"]]);
    expect(late).toBeGreaterThan(asked);
    await finish(one, limited);
    expect(await statusOf(anna.id, w.g)).toEqual([
      ["done", null],
      ["queued", null],
    ]);
    expect((await laneOf(anna.id, w.g)).at(-1)).toEqual(["others", w.third.id]);
  });

  it("others' calls do not use up the owner's own minute", async () => {
    const w = await crowd();
    const anna = await agentOf(w.owner, "anna", w.g, limited);
    await say(w.member, w.g, "@anna 一", limited);
    await settleAll();
    await say(w.third, w.g, "@anna 二", limited);
    await settleAll();
    // The others' two a minute are used up: a third caller's call is refused, its sender alone told.
    await say(w.fourth, w.g, "@anna 三", limited);
    expect(await statusOf(anna.id, w.g)).toEqual([
      ["done", null],
      ["done", null],
    ]);
    expect(await refusalsOf(anna.id, w.g)).toEqual([[w.fourth.id, "too_often"]]);
    // The owner's own call in the same minute starts a reply: in the group, and in the Agent's own conversation.
    await say(w.owner, w.g, "@anna 我来问", limited);
    expect((await statusOf(anna.id, w.g)).at(-1)).toEqual(["queued", null]);
    expect((await laneOf(anna.id, w.g)).at(-1)).toEqual(["own", w.owner.id]);
    await say(w.owner, anna.conversationId, "你好", limited);
    expect(await statusOf(anna.id, anna.conversationId)).toEqual([["queued", null]]);
  });

  it("the owner's own calls do not use up the others'", async () => {
    const w = await crowd();
    const anna = await agentOf(w.owner, "anna", w.g, limited);
    await say(w.owner, anna.conversationId, "一", limited);
    await say(w.owner, w.g, "@anna 二", limited);
    await settleAll();
    // The owner's own two a minute are used up: their next call, here or in the Agent's own conversation, is refused.
    await say(w.owner, w.g, "@anna 三", limited);
    await say(w.owner, anna.conversationId, "四", limited);
    expect(await statusOf(anna.id, w.g)).toEqual([
      ["done", null],
      ["failed", "rate_limited"],
    ]);
    expect(await statusOf(anna.id, anna.conversationId)).toEqual([
      ["done", null],
      ["failed", "rate_limited"],
    ]);
    // Others' calls in the same minute start replies, two of them.
    await say(w.member, w.g, "@anna 你好", limited);
    expect((await statusOf(anna.id, w.g)).at(-1)).toEqual(["queued", null]);
    await settleAll();
    await say(w.third, w.g, "@anna 我也问", limited);
    expect((await statusOf(anna.id, w.g)).at(-1)).toEqual(["queued", null]);
    expect((await laneOf(anna.id, w.g)).slice(-2)).toEqual([
      ["others", w.member.id],
      ["others", w.third.id],
    ]);
  });

  it("one caller's second call in a minute starts nothing, records nothing; another caller's does", async () => {
    const w = await crowd();
    const anna = await agentOf(w.owner, "anna", w.g, limited);
    const tess = await agentOf(w.third, "tess", w.g, limited);
    lines.length = 0;
    await say(w.member, w.g, "@anna 一", limited);
    expect(await statusOf(anna.id, w.g)).toEqual([["queued", null]]);
    await settleAll();
    // The member's second call on someone else's Agent this minute — another owner's — is sent, and calls nobody: no
    // run, no rate_limited record, no notice. Only the log has it.
    const notices = await noticeCount(w.g);
    await say(w.member, w.g, "@tess 二", limited);
    expect((await db.query("select 1 from agent_runs where agent_id = $1", [tess.id])).rowCount).toBe(0);
    expect(await noticeCount(w.g)).toBe(notices);
    expect(callerLimited()).toEqual([{ metric: "caller_rate_limited", callerId: w.member.id, agentId: tess.id, conversationId: w.g }]);
    // Another caller's call in that minute starts a reply.
    await say(w.third, w.g, "@anna 三", limited);
    expect(await statusOf(anna.id, w.g)).toEqual([
      ["done", null],
      ["queued", null],
    ]);
    expect((await laneOf(anna.id, w.g)).at(-1)).toEqual(["others", w.third.id]);
  });

  it("the sender alone is told which of their calls their limit refused: on their own copy of the message, as they read it again too; nobody else reads it", async () => {
    const w = await crowd();
    const anna = await agentOf(w.owner, "anna", w.g, limited);
    const tess = await agentOf(w.third, "tess", w.g, limited);
    const send = async (text: string) => {
      const sent = await api(limited, w.member, "POST", `/api/conversations/${w.g}/messages`, { text, clientTxn: `ln${++txn}` });
      expect(sent.status).toBe(201);
      return sent.json as { message: { seq: number; refused?: unknown } };
    };
    const read = async (who: Actor, seq: number) =>
      ((await api(limited, who, "GET", `/api/conversations/${w.g}/messages`)).json.messages as Array<{ seq: number; refused?: unknown }>).find((m) => m.seq === seq);

    // A call that reaches its Agent: no such key at all.
    const first = await send("@anna 一");
    expect(first.message).not.toHaveProperty("refused");
    expect(first).not.toHaveProperty("notCalled");
    await settleAll();
    // The member's next calls this minute on other people's Agents start nothing: their copy names each, in id order.
    const refused = await send("@tess @anna 二");
    const line = [anna.id, tess.id].sort().map((agentId) => ({ agentId, reason: "too_often" }));
    expect(refused.message.refused).toEqual(line);
    expect((await read(w.member, refused.message.seq))?.refused).toEqual(line);
    // Nobody else's copy carries anything of it.
    for (const who of [w.third, w.owner]) {
      const stored = await read(who, refused.message.seq);
      expect([who.id, stored]).toEqual([who.id, expect.objectContaining({ seq: refused.message.seq })]);
      expect(stored).not.toHaveProperty("refused");
    }
  });

  it("exact under concurrency: one person's two calls at the same instant, in two groups, start exactly one reply", { timeout: 60_000 }, async () => {
    const w = await crowd();
    const anna = await agentOf(w.owner, "anna", w.g, limited);
    const g2 = await group(limited, w.third, "elsewhere", [w.member, w.fourth]);
    const tess = await agentOf(w.third, "tess", g2, limited);
    for (let round = 0; round < 8; round++) {
      await db.query("delete from agent_runs where agent_id = any($1::uuid[])", [[anna.id, tess.id]]);
      lines.length = 0;
      await Promise.all([say(w.member, w.g, `@anna ${round}`, limited), say(w.member, g2, `@tess ${round}`, limited)]);
      const started = (await db.query<{ agent_id: string }>("select agent_id from agent_runs where agent_id = any($1::uuid[])", [[anna.id, tess.id]])).rows.map((r) => r.agent_id);
      // Exactly one started; the other is only logged.
      expect([round, started.length, callerLimited().length]).toEqual([round, 1, 1]);
      expect([anna.id, tess.id]).toContain(started[0]);
    }
  });

  it("a caller's limit does not count calls to their own Agents; their Agents' calls on others' are theirs", async () => {
    const w = await crowd();
    const anna = await agentOf(w.owner, "anna", w.g, limited);
    const tess = await agentOf(w.third, "tess", w.g, limited);
    const mia = await agentOf(w.member, "mia", w.g, limited);
    lines.length = 0;
    // The member calls their own Agent, then someone else's: the first does not count, so the second starts a reply.
    await say(w.member, w.g, "@mia 一", limited);
    await settleAll();
    await say(w.member, w.g, "@anna 二", limited);
    expect([await statusOf(mia.id, w.g), await statusOf(anna.id, w.g)]).toEqual([[["done", null]], [["queued", null]]]);
    await settleAll();
    // At their limit, a call on their own Agent is not refused.
    await say(w.member, w.g, "@mia 三", limited);
    expect(await statusOf(mia.id, w.g)).toEqual([
      ["done", null],
      ["queued", null],
    ]);
    // Their Agent's call on someone else's Agent is theirs: refused, as their own would be, and logged.
    gateway.reply("@tess 你也看看");
    expect(await limited.agentWorker.runOnce()).toBe(true);
    expect((await db.query("select 1 from messages where conversation_id = $1 and sender_id = $2", [w.g, mia.id])).rowCount).toBe(1);
    expect(await statusOf(tess.id, w.g)).toEqual([]);
    expect(callerLimited()).toEqual([{ metric: "caller_rate_limited", callerId: w.member.id, agentId: tess.id, conversationId: w.g }]);
    // The same, as an Agent's message hands it to the trigger: nothing to announce, the refused call to log.
    const again = await agentSays(mia.id, w.g, "@tess 再看看", limited);
    expect([again.runs, again.callerLimited]).toEqual([[], [{ callerId: w.member.id, agentId: tess.id, conversationId: w.g }]]);
  });

  it("a member's call relayed by an owner's Agent to a third person's Agent is the member's call, not the owner's", async () => {
    const w = await crowd();
    await agentOf(w.owner, "anna", w.g, limited);
    const tess = await agentOf(w.third, "tess", w.g, limited);
    lines.length = 0;
    // The member's one call of the minute on someone else's Agent.
    await say(w.member, w.g, "@anna 问问 tess", limited);
    gateway.reply("@tess 你也看看");
    expect(await limited.agentWorker.runOnce()).toBe(true);
    // Relayed, Anna's call on Tess is the member's second: it starts nothing, and is logged as theirs.
    expect(await statusOf(tess.id, w.g)).toEqual([]);
    expect(callerLimited()).toEqual([{ metric: "caller_rate_limited", callerId: w.member.id, agentId: tess.id, conversationId: w.g }]);
    // The owner's own call on someone else's Agent this minute is still theirs to make.
    await say(w.owner, w.g, "@tess 我来问", limited);
    expect(await statusOf(tess.id, w.g)).toEqual([["queued", null]]);
    expect(await laneOf(tess.id, w.g)).toEqual([["others", w.owner.id]]);
  });

  it("the caller's minute is met by every call as it is made (C-a): at their limit, a call that would fold, and one that would wait, are refused 太频繁 — and nothing follows them", async () => {
    const w = await crowd();
    const anna = await agentOf(w.owner, "anna", w.g, limited);
    lines.length = 0;
    const one = await say(w.member, w.g, "@anna 一", limited);
    // At their limit (one call a minute): the next would fold into the queued reply; it is refused instead.
    const two = await say(w.member, w.g, "@anna 二", limited);
    expect(await runsOf(anna.id, w.g)).toEqual([{ status: "queued", error: null, covers: one }]);
    const running = await claim(anna.id, w.g);
    // And the next would wait behind the reply under way: refused too.
    const three = await say(w.member, w.g, "@anna 三", limited);
    expect(await waitingOf(anna.id, w.g)).toEqual([]);
    expect(await refusalsOf(anna.id, w.g)).toEqual([
      [w.member.id, "too_often"],
      [w.member.id, "too_often"],
    ]);
    expect(callerLimited().map((c) => c.callerId)).toEqual([w.member.id, w.member.id]);
    await finish(running, limited);
    expect(await statusOf(anna.id, w.g)).toEqual([["done", null]]);
    expect([two, three].every((seq) => seq > one)).toBe(true);
  });

});
