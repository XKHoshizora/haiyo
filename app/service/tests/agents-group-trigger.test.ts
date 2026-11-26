import type { FastifyInstance, InjectOptions } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mentionedHandles, mentionsAtSend, mentionTokens } from "../src/agents/mentions.ts";

import { NOTHING, type RunTicket } from "../src/agents/runtime/port.ts";
import { maybeTrigger, noneTriggered, triggerFromAgent, type RunLimits } from "../src/agents/runs.ts";
import { lockAgent } from "../src/agents/store.ts";
import { buildApp } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import type { WriteLock } from "../src/conversations/store.ts";
import type { Tx } from "../src/db.ts";
import { insertMessage, type StoredMessage } from "../src/messages/model.ts";
import { api, befriend, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { NO_ANSWER_FLOOR, useApp } from "./helpers/harness.ts";
import { expectLinear, LOADED_TIMEOUT_MS } from "./helpers/linear.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { MULTIPART, multipart } from "./helpers/multipart.ts";
import { closeAllSockets, connect } from "./helpers/ws.ts";

/** The handles a text names, as the reading at send looks them up (its tokens, then their distinct handles). */
const handlesIn = (text: string): string[] => mentionedHandles(mentionTokens(text));

/**
 * What makes an Agent reply in a group, and the brakes on Agents answering each other (README "Agents and runs",
 * Trigger and "In a group"; plan rulings 6–13). An Agent is put into a group by inserting its membership row, as a
 * fixture: adding it through the API, and its replies there, are other tasks'. So these tests look at the runs the
 * trigger queues or refuses, the notices it appends and the runs it announces — never at a reply. An Agent's own
 * message is stored here as `postAsAgent` stores it (the group's row, then the Agent's, locked; the message inserted)
 * and handed to `triggerFromAgent` in the same transaction, as `postAsAgent` does.
 */

const gateway = scriptedGateway();
// Runs are only queued here: no worker may pick them up.
const { app, db } = useApp({ env: SITE_ENV, models: gateway, agentWorker: false });

afterEach(async () => {
  await closeAllSockets();
  expect(gateway.pending()).toBe(0);
});

const FAST = { source: "site", id: "fast" } as const;
const RANDOM = "6a0d4c2e-1b3f-4a5e-9c7d-8e9f0a1b2c3d";

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

/** Puts principal `id` into conversation `conv` from its current seq on, as Task 2's `addMember` will. */
const join = (conv: string, id: string) =>
  db.query(`insert into memberships (conversation_id, principal_id, role, joined_seq) select $1, $2, 'speaker', seq from conversations where id = $1`, [
    conv,
    id,
  ]);

/** An Agent of `owner` with `handle` (also its name), answering on the site model, put into `conv` when given. */
async function agentOf(owner: Actor, handle: string, conv: string | null, over: Record<string, unknown> = {}) {
  const agent = await mustCreateAgent(app, owner, { handle, name: handle, model: FAST, persona: "简短地回答。", ...over });
  if (conv) await join(conv, agent.id);
  return agent as { id: string; handle: string; conversationId: string };
}

let txn = 0;
const say = async (who: Actor, conv: string, text: string, extra: object = {}): Promise<number> => {
  const sent = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `gt${++txn}`, ...extra });
  if (sent.status !== 201) throw new Error(`say: ${sent.status} ${JSON.stringify(sent.json)}`);
  return sent.json.message.seq as number;
};

/**
 * The Agent's own message in `conv`, stored and handed to the trigger in one transaction, as `postAsAgent` does — posted
 * by no run, so its owner is behind it.
 */
const agentSays = (agentId: string, conv: string, text: string, config: RunLimits & Pick<Config, "agentChainLimit"> = app.deps.config) =>
  db.tx(async (t) => {
    const poster = await lockAgent(t, agentId, conv);
    const message = await insertMessage(t, conv, agentId, "text", { text }, null, await mentionsAtSend(t, { id: conv, type: "group" }, text));
    // Posted by no run: whose question it carries is not known (null, the safe side; Task 10b).
    return { message, ...(await triggerFromAgent(t, conv, message, poster, null, config, null)) };
  });

interface RunView {
  status: string;
  error: string | null;
  covers: number;
  by: string;
  interrupted: string | null;
}

/** The Agent's runs in `conv`, oldest first. */
const runsOf = async (agentId: string, conv: string): Promise<RunView[]> =>
  (
    await db.query<RunView>(
      `select status, error, covers_seq::int as covers, triggered_by as by, interrupted
         from agent_runs where agent_id = $1 and conversation_id = $2 order by created_at, id`,
      [agentId, conv],
    )
  ).rows;

const allRuns = async () => Number((await db.query("select count(*) n from agent_runs")).rows[0].n);

/** Ends every active run, so that the next trigger queues a new one instead of folding. */
const settleAll = async () => {
  await db.query("delete from deferred_calls");
  await db.query("update agent_runs set status = 'done', finished_at = now() where status in ('queued', 'running')");
};
/** The seqs of the calls waiting for `agentId` in `conv` (`deferred_calls`), oldest first. */
const waitingOf = async (agentId: string, conv: string): Promise<number[]> =>
  (await db.query<{ seq: number }>("select message_seq::int as seq from deferred_calls where agent_id = $1 and conversation_id = $2 order by message_seq", [agentId, conv])).rows.map(
    (r) => r.seq,
  );

/** The notices of `event` in `conv`, oldest first: their seq, text and event. */
const noticesOf = async (conv: string, event: string) =>
  (
    await db.query<{ seq: number; body: Record<string, unknown> }>(
      `select seq::int as seq, body from messages where conversation_id = $1 and kind = 'system' and body ->> 'event' = $2 order by seq`,
      [conv, event],
    )
  ).rows;

const seqOf = async (conv: string) => Number((await db.query("select seq from conversations where id = $1", [conv])).rows[0].seq);

// --- mentions ------------------------------------------------------------------------------------------------

describe("mentionedHandles", () => {
  it("finds @handle on a token boundary, case ignored, lower-cased, distinct, in order", () => {
    expect(handlesIn("@anna hi @Bob_1, and @ANNA again; @carl.")).toEqual(["anna", "bob_1", "carl"]);
    expect(handlesIn("(@anna) [@bob_1] 你好@carl你好 @dave! @erin's @fred-x")).toEqual(["anna", "bob_1", "carl", "dave", "erin", "fred"]);
    expect(handlesIn("@@anna")).toEqual(["anna"]);
    // Preceded by a word character: an address, not a mention.
    expect(handlesIn("mail@anna x_@bob 9@carl Z@dave")).toEqual([]);
    // The whole run of word characters is the handle: `@anna_2` is not `@anna`.
    expect(handlesIn("@anna_2 @anna2")).toEqual(["anna_2", "anna2"]);
    // 2 to 24 characters (an Agent's name part may be 2: family names), or nothing.
    expect(handlesIn(`@a @an @ab_ @${"a".repeat(24)} @${"b".repeat(25)}`)).toEqual(["an", "ab_", "a".repeat(24)]);
    expect(handlesIn("")).toEqual([]);
    expect(handlesIn("@")).toEqual([]);
    expect(handlesIn("@ anna")).toEqual([]);
    expect(handlesIn("@安娜")).toEqual([]);
  });

  it("returns at most the first 20 distinct handles; repeats do not count toward them", () => {
    const handle = (i: number) => `h_${String(i).padStart(2, "0")}`;
    const many = Array.from({ length: 25 }, (_, i) => `@${handle(i)}`).join(" ");
    expect(handlesIn(many)).toEqual(Array.from({ length: 20 }, (_, i) => handle(i)));
    expect(handlesIn(`${"@aaa ".repeat(30)}@bbb`)).toEqual(["aaa", "bbb"]);
  });

  it("is linear: 8 000 characters of @a@a…, @aaaa… and the like take about four times what 2 000 take", { timeout: LOADED_TIMEOUT_MS }, () => {
    // Texts of about `n` characters of each shape; `expectLinear` (helpers/linear.ts) compares the two sizes with each other.
    const cases: Array<[(n: number) => string, string[]]> = [
      [(n) => "@a".repeat(n / 2), []],
      [(n) => `@${"a".repeat(n - 1)}`, []],
      [(n) => "@aaa".repeat(n / 4), ["aaa"]],
      [(n) => `${"@".repeat(n - 3)}abc`, ["abc"]],
      [(n) => `@${"a".repeat(23)}_`.repeat(n / 25), [`${"a".repeat(23)}_`]],
      [(n) => `${"a@".repeat(n / 2)}`, []],
    ];
    for (const [make, expected] of cases) {
      expect(make(8000).length).toBeGreaterThanOrEqual(8000);
      expectLinear({
        n: 2000,
        make,
        run: (text) => {
          if (JSON.stringify(handlesIn(text)) !== JSON.stringify(expected)) throw new Error(`mentionedHandles gave ${JSON.stringify(handlesIn(text))} for a text of ${text.length} characters`);
        },
      });
    }
  });
});

// --- a person's message ------------------------------------------------------------------------------------

describe("a person's message in a group", () => {
  it("without a mention, no Agent is looked up and no run is created", async () => {
    const w = await world();
    await agentOf(w.owner, "anna", w.g, { replyMode: "always" });
    // Not one query: the message names nobody (its stored mentions, Task M — whatever its text says).
    const query = vi.fn();
    const fake = { query } as unknown as Tx;
    const lock = {
      conversation: { id: w.g, type: "group", title: "team", creatorId: w.owner.id, seq: 3, closedAt: null },
      membership: { id: RANDOM, conversationId: w.g, principalId: w.member.id, role: "speaker", joinedSeq: 0, leftSeq: null, readSeq: 0 },
      peerId: null,
    } as WriteLock;
    const message = (body: StoredMessage["body"], kind: StoredMessage["kind"] = "text"): StoredMessage => ({
      id: "1",
      conversationId: w.g,
      seq: 4,
      senderId: w.member.id,
      kind,
      body,
      clientTxn: "x",
      createdAt: new Date(),
      mentions: null,
      asksAgent: false,
    });
    const nothing = noneTriggered();
    for (const body of [{ text: "大家好，今天开会" }, { text: "write to anna@example.test" }, { text: "@a @ 安娜 @x.y" }, { text: "@anna 你好" }, {}]) {
      expect(await maybeTrigger(fake, lock, message(body), app.deps.config)).toEqual(nothing);
    }
    expect(await maybeTrigger(fake, lock, message({ text: "@anna" }, "system"), app.deps.config)).toEqual(nothing);
    expect(query).not.toHaveBeenCalled();
    // Through the route: an Agent that answers everything in its own conversation still says nothing here.
    await say(w.member, w.g, "大家好，今天开会");
    await say(w.owner, w.g, "anna 你也看看");
    expect(await allRuns()).toBe(0);
  });

  it("each Agent member it names by @handle gets a run, announced to its owner; other handles call nobody", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    const anna2 = await agentOf(w.owner, "anna_2", w.g);
    const bob = await agentOf(w.member, "bobbot", w.g);
    const g2 = await group(app, w.owner, "elsewhere", [w.member, w.third]);
    const outsider = await agentOf(w.owner, "outsider", g2);
    const loner = await agentOf(w.third, "loner", null);
    const ownerSocket = await connect(app, w.owner);
    const memberSocket = await connect(app, w.member);

    const first = await say(w.member, w.g, "@anna 你好");
    expect(await runsOf(anna.id, w.g)).toEqual([{ status: "queued", error: null, covers: first, by: "human", interrupted: null }]);
    expect(await runsOf(anna2.id, w.g)).toEqual([]);
    // The owner gets the run; another member of the group only its state (`run` without a run, Task 6).
    const annaPush = await ownerSocket.next((e) => e.type === "run" && e.conversationId === w.g && "run" in e);
    expect(annaPush.run).toMatchObject({ status: "queued", retryable: false });

    // Two named: two runs, each announced to its own owner.
    const second = await say(w.third, w.g, "@ANNA_2 和 @bobbot 一起看看");
    expect(await runsOf(anna2.id, w.g)).toEqual([{ status: "queued", error: null, covers: second, by: "human", interrupted: null }]);
    expect(await runsOf(bob.id, w.g)).toEqual([{ status: "queued", error: null, covers: second, by: "human", interrupted: null }]);
    const bobPush = await memberSocket.next((e) => e.type === "run" && e.conversationId === w.g && "run" in e);
    expect(bobPush.run.status).toBe("queued");
    await ownerSocket.waitFor((e) => e.type === "run" && e.conversationId === w.g && "run" in e && e.run.id !== annaPush.run.id);

    // An Agent of another group, one in no group, a person, nobody: nothing.
    const before = await allRuns();
    await say(w.member, w.g, "@outsider @loner @owner @member @nobody_here");
    expect(await allRuns()).toBe(before);
    expect([await runsOf(outsider.id, w.g), await runsOf(outsider.id, g2), await runsOf(loner.id, loner.conversationId)]).toEqual([[], [], []]);
    // `@anna` is not `@anna_2`, nor the other way round: each run above covers only its own mention.
    expect((await runsOf(anna.id, w.g)).map((r) => r.covers)).toEqual([first]);
  });

  it("while the Agent's reply in the group is queued, its caller's next mention folds into it and another person's waits; while it runs, every mention waits; replyMode plays no part", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g, { replyMode: "mention" });
    const one = await say(w.member, w.g, "@anna 一");
    await say(w.member, w.g, "没有点名");
    const again = await say(w.member, w.g, "@anna 一又一");
    expect(await runsOf(anna.id, w.g)).toEqual([{ status: "queued", error: null, covers: again, by: "human", interrupted: null }]);
    const two = await say(w.third, w.g, "@anna 二");
    expect(await runsOf(anna.id, w.g)).toEqual([{ status: "queued", error: null, covers: again, by: "human", interrupted: null }]);
    expect(await waitingOf(anna.id, w.g)).toEqual([two]);
    expect(two).toBeGreaterThan(one);
    await db.query("update agent_runs set status = 'running', started_at = now() where agent_id = $1", [anna.id]);
    const three = await say(w.owner, w.g, "@anna 三");
    expect(await runsOf(anna.id, w.g)).toEqual([{ status: "running", error: null, covers: again, by: "human", interrupted: null }]);
    expect(await waitingOf(anna.id, w.g)).toEqual([two, three]);
    // Its own conversation is another conversation: a run there is not touched, and none is made there.
    expect(await runsOf(anna.id, anna.conversationId)).toEqual([]);
  });

  it("over the owner's own replies a minute: one failed rate_limited run per Agent in the group, reused while it is the latest and not dismissed (someone else's call over the others' minute starts nothing: others-one-number.test.ts)", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    const carl = await agentOf(w.owner, "carlbot", w.g);
    // The replies the owner called for, a minute's worth: the owner's own lane is used up.
    await db.query(
      `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, created_at, finished_at, lane)
       select 'reply', $1, $2, $3, 'done', 0, now() - interval '30 seconds', now() - interval '29 seconds', 'own' from generate_series(1, $4)`,
      [anna.conversationId, anna.id, w.owner.id, app.deps.config.agentRunsPerMinute],
    );
    const s = await connect(app, w.owner);
    const one = await say(w.owner, w.g, "@anna 一");
    const [limited] = await runsOf(anna.id, w.g);
    expect(limited).toEqual({ status: "failed", error: "rate_limited", covers: one, by: "human", interrupted: null });
    const first = await s.next((e) => e.type === "run" && e.conversationId === w.g);
    expect(first.run).toEqual({ id: first.run.id, status: "failed", error: "rate_limited", retryable: true });

    // Again: the same row covers it, and is announced again; no second line.
    const two = await say(w.owner, w.g, "@anna 二");
    expect(await runsOf(anna.id, w.g)).toEqual([{ ...limited, covers: two }]);
    const again = await s.next((e) => e.type === "run" && e.conversationId === w.g, { from: s.events.indexOf(first) + 1 });
    expect(again.run).toEqual(first.run);
    // Per Agent: another Agent of the same owner gets its own.
    await say(w.owner, w.g, "@carlbot");
    expect((await runsOf(carl.id, w.g)).map((r) => r.error)).toEqual(["rate_limited"]);

    // Dismissed, it is not reused: a new one.
    await db.query("update agent_runs set dismissed_at = now() where agent_id = $1 and conversation_id = $2", [anna.id, w.g]);
    const three = await say(w.owner, w.g, "@anna 三");
    expect((await runsOf(anna.id, w.g)).map((r) => [r.error, r.covers])).toEqual([
      ["rate_limited", two],
      ["rate_limited", three],
    ]);
    // Nor when a newer run of the Agent there came after it: it is no longer what the owner is shown.
    await db.query(
      `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, finished_at) values ('reply', $1, $2, $3, 'done', $4, now())`,
      [w.g, anna.id, w.owner.id, three],
    );
    const four = await say(w.owner, w.g, "@anna 四");
    expect((await runsOf(anna.id, w.g)).map((r) => [r.status, r.error, r.covers])).toEqual([
      ["failed", "rate_limited", two],
      ["failed", "rate_limited", three],
      ["done", null, three],
      ["failed", "rate_limited", four],
    ]);
    // None of them counts toward the limit: a minute's replies started, as before, and the done one above.
    expect(Number((await db.query("select count(*) n from agent_runs where owner_id = $1 and error is distinct from 'rate_limited'", [w.owner.id])).rows[0].n)).toBe(
      app.deps.config.agentRunsPerMinute + 1,
    );
  });

  it("groupMentions owner: only its owner's mention calls it", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g, { groupMentions: "owner" });
    await say(w.member, w.g, "@anna 帮我看看");
    await say(w.third, w.g, "@anna");
    expect(await runsOf(anna.id, w.g)).toEqual([]);
    const mine = await say(w.owner, w.g, "@anna 你来");
    expect(await runsOf(anna.id, w.g)).toEqual([{ status: "queued", error: null, covers: mine, by: "human", interrupted: null }]);
  });

  it("a person its owner has blocked, or who has blocked its owner, does not call it; the others do, and so does that person once the block is lifted", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    const theirs = await agentOf(w.third, "tess", w.g);
    expect((await api(app, w.owner, "PUT", `/api/blocks/${w.member.id}`)).status).toBe(200);
    await say(w.member, w.g, "@anna 帮我看看 @tess 你也来");
    // Only the Agent of the owner who blocked them stays silent.
    expect(await runsOf(anna.id, w.g)).toEqual([]);
    expect((await runsOf(theirs.id, w.g)).map((r) => r.status)).toEqual(["queued"]);
    // A block the other way round (the caller blocked the owner) does the same: whoever blocked someone does not call
    // that person's Agents either.
    expect((await api(app, w.third, "PUT", `/api/blocks/${w.owner.id}`)).status).toBe(200);
    await say(w.third, w.g, "@anna 我来问");
    expect(await runsOf(anna.id, w.g)).toEqual([]);
    await say(w.owner, w.g, "@tess 你呢");
    expect((await runsOf(theirs.id, w.g)).map((r) => r.status)).toEqual(["queued"]);
    const other = await say(w.owner, w.g, "@anna 我来问");
    expect(await runsOf(anna.id, w.g)).toEqual([{ status: "queued", error: null, covers: other, by: "human", interrupted: null }]);
    // Nor is the blocked person's mention folded into the run under way.
    await say(w.member, w.g, "@anna 还有我");
    await db.query("update agent_runs set status = 'running', started_at = now() where agent_id = $1", [anna.id]);
    await say(w.member, w.g, "@anna 再问一次");
    expect(await runsOf(anna.id, w.g)).toEqual([{ status: "running", error: null, covers: other, by: "human", interrupted: null }]);
    await settleAll();
    expect((await api(app, w.owner, "DELETE", `/api/blocks/${w.member.id}`)).status).toBe(200);
    const again = await say(w.member, w.g, "@anna 现在呢");
    expect((await runsOf(anna.id, w.g)).map((r) => [r.status, r.covers])).toEqual([
      ["done", other],
      ["queued", again],
    ]);
  });

  it.each([
    ["its owner blocks the person who called it", "owner", "member"],
    ["the person who called it blocks its owner", "member", "owner"],
  ] as const)("a reply already queued ends quietly when, before it begins, %s: no call, nothing charged, no message, nothing to retry", async (_what, blocker, blocked) => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    const asked = await say(w.member, w.g, "@anna 帮我看看");
    expect((await runsOf(anna.id, w.g)).map((r) => r.status)).toEqual(["queued"]);
    expect((await api(app, w[blocker], "PUT", `/api/blocks/${w[blocked].id}`)).status).toBe(200);

    const calls = gateway.calls.length;
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(gateway.calls.length).toBe(calls);
    expect(await runsOf(anna.id, w.g)).toEqual([{ status: "cancelled", error: null, covers: asked, by: "human", interrupted: null }]);
    const charged = await db.query<{ charged: string }>(
      "select coalesce(sum(u.free_micro + u.balance_micro), 0)::text as charged from usage_records u join agent_runs r on r.id = u.run_id where r.agent_id = $1",
      [anna.id],
    );
    expect(charged.rows[0]!.charged).toBe("0");
    expect((await db.query("select 1 from messages where conversation_id = $1 and sender_id = $2", [w.g, anna.id])).rowCount).toBe(0);
    // Nothing shows in the group: not 暂时无法回复 to the caller, nor anything to its owner.
    for (const who of [w.owner, w.member]) expect((await api(app, who, "GET", `/api/conversations/${w.g}/runs`)).json.runs).toEqual([]);
  });

  it("a paused, deleted or model-less Agent is not called", async () => {
    const w = await world();
    const paused = await agentOf(w.owner, "paused_bot", w.g);
    const gone = await agentOf(w.owner, "gone_bot", w.g);
    await agentOf(w.owner, "bare_bot", w.g, { model: null });
    expect((await api(app, w.owner, "POST", `/api/agents/${paused.id}/pause`)).status).toBe(200);
    expect((await api(app, w.owner, "DELETE", `/api/agents/${gone.id}`)).status).toBe(200);
    await say(w.member, w.g, "@paused_bot @gone_bot @bare_bot");
    expect(await allRuns()).toBe(0);
    expect((await api(app, w.owner, "POST", `/api/agents/${paused.id}/resume`)).status).toBe(200);
    await say(w.member, w.g, "@paused_bot");
    expect((await runsOf(paused.id, w.g)).map((r) => r.status)).toEqual(["queued"]);
  });

  it("a file message's caption counts", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    const upload = async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/conversations/${w.g}/attachments`,
        headers: { cookie: w.member.cookie, "content-type": MULTIPART },
        payload: multipart([{ name: "file", filename: "note.txt", type: "text/plain", data: "bytes" }]),
      });
      if (res.statusCode !== 201) throw new Error(`upload ${res.statusCode}`);
      return res.json().id as string;
    };
    await say(w.member, w.g, "", { attachmentId: await upload() });
    expect(await runsOf(anna.id, w.g)).toEqual([]);
    const captioned = await say(w.member, w.g, "看看这个 @anna", { attachmentId: await upload() });
    expect(await runsOf(anna.id, w.g)).toEqual([{ status: "queued", error: null, covers: captioned, by: "human", interrupted: null }]);
  });
});

// --- an Agent's message --------------------------------------------------------------------------------------

describe("an Agent's message in a group", () => {
  it("calls another Agent it names — never itself, nor an Agent only its owner may call — marked as called by an Agent", async () => {
    const w = await world();
    const a = await agentOf(w.owner, "alpha", w.g);
    const b = await agentOf(w.member, "beta", w.g);
    const c = await agentOf(w.third, "gamma", w.g, { groupMentions: "owner" });
    await say(w.owner, w.g, "开始吧");
    const said = await agentSays(a.id, w.g, "@alpha 自己，@beta 你来，@gamma 也来");
    expect(said.notices).toEqual([]);
    expect(said.runs.map((r) => [r.ownerId, r.conversationId, r.run.status])).toEqual([[w.member.id, w.g, "queued"]]);
    expect(await runsOf(b.id, w.g)).toEqual([{ status: "queued", error: null, covers: said.message.seq, by: "agent", interrupted: null }]);
    expect([await runsOf(a.id, w.g), await runsOf(c.id, w.g)]).toEqual([[], []]);
    // Its owner's own mention does call the owner-only Agent.
    const mine = await say(w.third, w.g, "@gamma");
    expect((await runsOf(c.id, w.g)).map((r) => [r.covers, r.by])).toEqual([[mine, "human"]]);
  });

  it("does not call the Agent of an owner who has blocked its own owner, nor of one its own owner has blocked", async () => {
    const w = await world();
    const a = await agentOf(w.member, "alpha", w.g);
    const b = await agentOf(w.owner, "beta", w.g);
    const c = await agentOf(w.third, "gamma", w.g);
    expect((await api(app, w.owner, "PUT", `/api/blocks/${w.member.id}`)).status).toBe(200);
    await say(w.third, w.g, "开始吧");
    const said = await agentSays(a.id, w.g, "@beta 你来，@gamma 也来");
    expect(said.notices).toEqual([]);
    expect(said.runs.map((r) => r.ownerId)).toEqual([w.third.id]);
    expect(await runsOf(b.id, w.g)).toEqual([]);
    expect((await runsOf(c.id, w.g)).map((r) => [r.covers, r.by])).toEqual([[said.message.seq, "agent"]]);
    // Nor the other way round: the Agent of who blocked someone does not call that person's Agent.
    await settleAll();
    const back = await agentSays(b.id, w.g, "@alpha 你说呢，@gamma 你呢");
    expect(back.runs.map((r) => r.ownerId)).toEqual([w.third.id]);
    expect(await runsOf(a.id, w.g)).toEqual([]);
  });

  it("folds and queues like a person's, and over the others' minute starts nothing; a person's mention while an Agent's run is queued waits for a reply of its own", async () => {
    const w = await world();
    const a = await agentOf(w.owner, "alpha", w.g);
    const b = await agentOf(w.member, "beta", w.g);
    await say(w.owner, w.g, "开始");
    const first = await agentSays(a.id, w.g, "@beta 看一下");
    const second = await agentSays(a.id, w.g, "@beta 还有这个");
    expect(second.runs).toEqual([]);
    expect(await runsOf(b.id, w.g)).toEqual([{ status: "queued", error: null, covers: second.message.seq, by: "agent", interrupted: null }]);
    expect(second.message.seq).toBeGreaterThan(first.message.seq);
    const asked = await say(w.third, w.g, "@beta 我也想知道");
    expect(await runsOf(b.id, w.g)).toEqual([{ status: "queued", error: null, covers: second.message.seq, by: "agent", interrupted: null }]);
    expect(await waitingOf(b.id, w.g)).toEqual([asked]);
    // Running: an Agent's mention waits too; the run stays whoever's it was.
    await db.query("update agent_runs set status = 'running', started_at = now() where agent_id = $1", [b.id]);
    const third = await agentSays(a.id, w.g, "@beta 再补充");
    expect(await runsOf(b.id, w.g)).toEqual([{ status: "running", error: null, covers: second.message.seq, by: "agent", interrupted: null }]);
    expect(await waitingOf(b.id, w.g)).toEqual([asked, third.message.seq]);
    // Over the limit (the others' lane: the owner's Agent calls the member's): nothing is started and no run records it; the
    // refusal is recorded for the person behind the relay (no run posted it: the Agent's owner), for them alone (C-d).
    await settleAll();
    await db.query(
      `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, created_at, finished_at, lane)
       select 'reply', $1, $2, $3, 'done', 0, now() - interval '30 seconds', now() - interval '29 seconds', 'others' from generate_series(1, 20)`,
      [b.conversationId, b.id, w.member.id],
    );
    const before = await runsOf(b.id, w.g);
    const limited = await agentSays(a.id, w.g, "@beta 超限");
    expect(limited.runs).toEqual([]);
    expect(limited.refused).toEqual([{ conversationId: w.g, senderId: w.owner.id, seq: limited.message.seq }]);
    expect(await runsOf(b.id, w.g)).toEqual(before);
  });

  it("calls nobody once the group's last AGENT_CHAIN_LIMIT messages that are not notices were all Agents'; one notice per pause", async () => {
    const w = await world();
    const a = await agentOf(w.owner, "alpha", w.g);
    const b = await agentOf(w.member, "beta", w.g);
    const config = { ...app.deps.config, agentChainLimit: 3 };
    expect(app.deps.config.agentChainLimit).toBe(30);
    await say(w.owner, w.g, "你们讨论一下");
    expect((await agentSays(a.id, w.g, "@beta 一", config)).runs).toHaveLength(1);
    await settleAll();
    // A notice between them does not break the run of Agents' messages.
    expect((await api(app, w.owner, "PATCH", `/api/conversations/${w.g}`, { title: "讨论" })).status).toBe(200);
    expect((await agentSays(b.id, w.g, "@alpha 二", config)).runs).toHaveLength(1);
    await settleAll();
    const before = await allRuns();

    // The third Agent message in a row: it calls nobody, and the group is told once.
    const third = await agentSays(a.id, w.g, "@beta 三", config);
    expect(third.runs).toEqual([]);
    expect(third.notices.map((n) => [n.seq, n.senderId, n.body])).toEqual([
      [third.message.seq + 1, a.id, { event: "agent_chain_paused", actorId: a.id, limit: 3, text: "Agent 已连续对话 3 条，已暂停互相接话，有人发言后继续。" }],
    ]);
    const fourth = await agentSays(b.id, w.g, "@alpha 四", config);
    expect([fourth.runs, fourth.notices]).toEqual([[], []]);
    // One that names nobody it could call says nothing either.
    expect((await agentSays(a.id, w.g, "没有点名", config)).notices).toEqual([]);
    expect(await allRuns()).toBe(before);
    expect((await noticesOf(w.g, "agent_chain_paused")).length).toBe(1);

    // A person speaks: Agents may call each other again, and the next pause is told again.
    await say(w.third, w.g, "好，继续");
    expect((await agentSays(a.id, w.g, "@beta 五", config)).runs).toHaveLength(1);
    await settleAll();
    expect((await agentSays(b.id, w.g, "@alpha 六", config)).runs).toHaveLength(1);
    await settleAll();
    const again = await agentSays(a.id, w.g, "@beta 七", config);
    expect([again.runs, again.notices.length]).toEqual([[], 1]);
    expect((await noticesOf(w.g, "agent_chain_paused")).length).toBe(2);
    // A person's mention is never refused by it.
    const asked = await say(w.member, w.g, "@beta 你说");
    expect((await runsOf(b.id, w.g)).at(-1)).toMatchObject({ status: "queued", covers: asked, by: "human" });
  });

  it("the chain budget: once an Agent's owner has paid its budget for its replies since a person's latest message, Agents' messages do not call it", async () => {
    const w = await world();
    const a = await agentOf(w.owner, "alpha", w.g);
    const b = await agentOf(w.member, "beta", w.g);
    const d = await agentOf(w.member, "delta", w.g);
    expect((await api(app, w.member, "PATCH", `/api/agents/${b.id}`, { chainBudget: "1" })).json.chainBudget).toBe("1");
    const human = await say(w.owner, w.g, "开始");

    /** A reply of `agentId` in the group covering `covers`, settled with `free` and `balance` micro-points charged. */
    const paid = async (agentId: string, ownerId: string, covers: number, free: number, balance: number) => {
      const run = await db.query<{ id: string }>(
        `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, source, model, charge_to, finished_at)
         values ('reply', $1, $2, $3, 'done', $4, 'site', 'fast', 'free', now()) returning id`,
        [w.g, agentId, ownerId, covers],
      );
      await db.query(
        `insert into usage_records (owner_id, agent_id, run_id, purpose, source, model, cost_micro, free_micro, balance_micro, outcome)
         values ($1, $2, $3, 'reply', 'site', 'fast', $4, $5, $6, 'done')`,
        [ownerId, agentId, run.rows[0]!.id, free + balance + 7, free, balance],
      );
    };
    // Under the budget (what was forgiven does not count): still called.
    await paid(b.id, w.member.id, human + 1, 600_000, 399_999);
    // A reply covering only the person's message is not part of the chain.
    await paid(b.id, w.member.id, human, 5_000_000, 0);
    expect((await agentSays(a.id, w.g, "@beta 一")).runs).toHaveLength(1);
    await settleAll();
    // At the budget: not called, and told once for this chain; another Agent is not affected.
    await paid(b.id, w.member.id, human + 1, 0, 1);
    const reached = await agentSays(a.id, w.g, "@beta @delta 二");
    expect(reached.runs.map((r) => r.ownerId)).toEqual([w.member.id]);
    expect(await runsOf(d.id, w.g)).toHaveLength(1);
    expect(reached.notices.map((n) => n.body)).toEqual([
      { event: "agent_budget_reached", actorId: b.id, agentId: b.id, text: "beta 已达到本次接话的点数上限，有人发言后继续。" },
    ]);
    await settleAll();
    const later = await agentSays(a.id, w.g, "@beta 三");
    expect([later.runs, later.notices]).toEqual([[], []]);
    expect((await runsOf(b.id, w.g)).filter((r) => r.by === "agent")).toHaveLength(1);

    // A person's mention is never refused, and starts a new chain: Agents may call it again, and a new notice may come.
    const asked = await say(w.third, w.g, "@beta 你说说");
    expect((await runsOf(b.id, w.g)).at(-1)).toMatchObject({ status: "queued", covers: asked, by: "human" });
    await settleAll();
    expect((await agentSays(a.id, w.g, "@beta 四")).runs).toHaveLength(1);
    await settleAll();
    await paid(b.id, w.member.id, asked + 2, 1_000_000, 0);
    expect((await agentSays(a.id, w.g, "@beta 五")).notices.map((n) => n.body.event)).toEqual(["agent_budget_reached"]);
    expect((await noticesOf(w.g, "agent_budget_reached")).length).toBe(2);
  });

  it("two Agents naming each other at the same instant do not deadlock — in one group, and each in another group", async () => {
    const w = await world();
    const a = await agentOf(w.owner, "alpha", w.g);
    const b = await agentOf(w.member, "beta", w.g);
    const g2 = await group(app, w.member, "second", [w.owner, w.third]);
    await join(g2, a.id);
    await join(g2, b.id);
    await say(w.owner, w.g, "开始");
    await say(w.member, g2, "开始");
    const bounded = <T>(p: Promise<T>): Promise<T> =>
      Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("deadlocked or stuck")), 5000))]);

    // One group: the group's row orders them, one after the other.
    await bounded(Promise.all([agentSays(a.id, w.g, "@beta"), agentSays(b.id, w.g, "@alpha")]));
    expect([(await runsOf(a.id, w.g)).map((r) => r.by), (await runsOf(b.id, w.g)).map((r) => r.by)]).toEqual([["agent"], ["agent"]]);
    await settleAll();

    // Two groups: each holds its own group and its own Agent when it calls the other — which neither locks.
    let arrived = 0;
    let release: () => void = () => {};
    const bothHold = new Promise<void>((resolve) => (release = resolve));
    const meet = async () => {
      if (++arrived === 2) release();
      await bothHold;
    };
    const holdingThenCalling = (agentId: string, conv: string, text: string) =>
      db.tx(async (t) => {
        const poster = await lockAgent(t, agentId, conv);
        await meet();
        const message = await insertMessage(t, conv, agentId, "text", { text }, null, await mentionsAtSend(t, { id: conv, type: "group" }, text));
        // Posted by no run: whose question it carries is not known (null).
        return triggerFromAgent(t, conv, message, poster, null, app.deps.config, null);
      });
    const [inG, inG2] = await bounded(Promise.all([holdingThenCalling(a.id, w.g, "@beta 一起"), holdingThenCalling(b.id, g2, "@alpha 一起")]));
    expect([inG.runs.map((r) => r.ownerId), inG2.runs.map((r) => r.ownerId)]).toEqual([[w.member.id], [w.owner.id]]);
    expect([(await runsOf(b.id, w.g)).at(-1)?.status, (await runsOf(a.id, g2)).at(-1)?.status]).toEqual(["queued", "queued"]);
  });
});

// --- halt ------------------------------------------------------------------------------------------------------

/** What a client can observe of an answer. */
async function observe(who: Actor | null, req: InjectOptions) {
  const res = await app.inject({ ...req, headers: who ? { cookie: who.cookie } : {} });
  return { status: res.statusCode, type: String(res.headers["content-type"] ?? ""), body: res.body };
}
const halt = (conv: string): InjectOptions => ({ method: "POST", url: `/api/conversations/${conv}/agents/halt` });

describe("POST /api/conversations/:id/agents/halt", () => {
  it("is a current member's of a group; anything else is answered as a conversation that does not exist", async () => {
    const w = await world();
    const outsider = await signUp(app, "outsider");
    const leaver = await signUp(app, "leaver");
    await befriend(app, w.owner, leaver);
    expect((await api(app, w.owner, "POST", `/api/conversations/${w.g}/members`, { principalId: leaver.id })).status).toBe(201);
    expect((await api(app, leaver, "DELETE", `/api/conversations/${w.g}/members/${leaver.id}`)).status).toBe(200);
    const { conversationId: direct } = await befriend(app, w.member, outsider);
    const mine = await agentOf(w.member, "mybot", null);

    const reference = await observe(w.member, halt(RANDOM));
    expect(reference).toEqual({ status: 404, type: "application/json; charset=utf-8", body: '{"error":"not_found"}' });
    // Never a member, a member no longer, a direct chat, an Agent's own conversation (its owner's): all the same.
    for (const [who, conv] of [
      [outsider, w.g],
      [leaver, w.g],
      [w.member, direct],
      [outsider, direct],
      [w.member, mine.conversationId],
    ] as const) {
      expect([conv, await observe(who, halt(conv))]).toEqual([conv, reference]);
    }
    expect((await observe(null, halt(w.g))).status).toBe(401);
    // Nobody refused changed anything.
    for (const conv of [w.g, direct, mine.conversationId]) expect([conv, await noticesOf(conv, "agents_halted")]).toEqual([conv, []]);
    expect((await db.query("select agents_halted_seq from conversations where id = $1", [w.g])).rows).toEqual([{ agents_halted_seq: null }]);
    expect(await api(app, w.third, "POST", `/api/conversations/${w.g.toUpperCase()}/agents/halt`, {})).toEqual({ status: 200, json: { ok: true } });
    expect((await noticesOf(w.g, "agents_halted")).length).toBe(1);
  });

  it("cancels the queued runs Agents called for, interrupts the running ones, leaves people's; one notice; idempotent", async () => {
    const w = await world();
    const a = await agentOf(w.owner, "alpha", w.g);
    const b = await agentOf(w.member, "beta", w.g);
    const c = await agentOf(w.third, "gamma", w.g);
    const e = await agentOf(w.third, "epsilon", w.g);
    const insertRun = async (agentId: string, ownerId: string, status: "queued" | "running", by: "human" | "agent") =>
      (
        await db.query<{ id: string }>(
          `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, triggered_by, started_at)
           values ('reply', $1, $2, $3, $4, 1, $5, case when $4 = 'running' then now() end) returning id`,
          [w.g, agentId, ownerId, status, by],
        )
      ).rows[0]!.id;
    const queuedByAgent = await insertRun(b.id, w.member.id, "queued", "agent");
    await insertRun(c.id, w.third.id, "queued", "human");
    const runningByAgent = await insertRun(a.id, w.owner.id, "running", "agent");
    const runningByPerson = await insertRun(e.id, w.third.id, "running", "human");
    // Elsewhere: untouched.
    const elsewhere = (
      await db.query<{ id: string }>(
        `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, triggered_by) values ('reply', $1, $2, $3, 'queued', 1, 'agent') returning id`,
        [b.conversationId, b.id, w.member.id],
      )
    ).rows[0]!.id;
    const memberSocket = await connect(app, w.member);
    const thirdSocket = await connect(app, w.third);
    const at = await seqOf(w.g);

    expect(await api(app, w.third, "POST", `/api/conversations/${w.g}/agents/halt`)).toEqual({ status: 200, json: { ok: true } });
    expect(await runsOf(b.id, w.g)).toEqual([{ status: "cancelled", error: "halted", covers: 1, by: "agent", interrupted: null }]);
    expect((await runsOf(c.id, w.g)).map((r) => [r.status, r.interrupted])).toEqual([["queued", null]]);
    expect((await runsOf(a.id, w.g)).map((r) => [r.status, r.interrupted])).toEqual([["running", "halted"]]);
    expect((await runsOf(e.id, w.g)).map((r) => [r.status, r.interrupted])).toEqual([["running", null]]);
    expect((await db.query("select status from agent_runs where id = $1", [elsewhere])).rows).toEqual([{ status: "queued" }]);
    // The interrupted call is abandoned at once; the person's goes on.
    const ticket = (id: string, agentId: string, ownerId: string): RunTicket => ({ id, agentId, ownerId, conversationId: w.g });
    expect(app.agentPort.shouldStop(ticket(runningByAgent, a.id, w.owner.id))).toBe(true);
    expect(app.agentPort.shouldStop(ticket(runningByPerson, e.id, w.third.id))).toBe(false);
    // The cancelled run's owner is told; the group gets the notice.
    const cancelled = await memberSocket.next((x) => x.type === "run" && x.run?.id === queuedByAgent);
    expect([cancelled.conversationId, cancelled.run]).toEqual([w.g, { id: queuedByAgent, status: "cancelled", error: "halted", retryable: false }]);
    const notice = await thirdSocket.next((x) => x.type === "message" && x.message.kind === "system" && x.message.system?.event === "agents_halted");
    expect(notice.message).toMatchObject({ seq: at + 1, senderId: null, text: "third 让 Agent 停止了接话", system: { event: "agents_halted", actorId: w.third.id } });
    expect((await db.query("select agents_halted_seq::int as s from conversations where id = $1", [w.g])).rows).toEqual([{ s: at }]);

    // Again, by anyone, while still halted: nothing more.
    expect(await api(app, w.member, "POST", `/api/conversations/${w.g}/agents/halt`, {})).toEqual({ status: 200, json: { ok: true } });
    expect((await noticesOf(w.g, "agents_halted")).length).toBe(1);
    expect(await seqOf(w.g)).toBe(at + 1);
    // Once a person has written, a halt is a new one.
    await say(w.owner, w.g, "继续");
    expect((await api(app, w.owner, "POST", `/api/conversations/${w.g}/agents/halt`)).status).toBe(200);
    expect((await noticesOf(w.g, "agents_halted")).map((n) => n.body.actorId)).toEqual([w.third.id, w.owner.id]);
  });

  it("while halted an Agent's message calls nobody; a person's mention still does, and a person's next message lifts it", async () => {
    const w = await world();
    const a = await agentOf(w.owner, "alpha", w.g);
    const b = await agentOf(w.member, "beta", w.g);
    await say(w.owner, w.g, "开始");
    expect((await api(app, w.third, "POST", `/api/conversations/${w.g}/agents/halt`)).status).toBe(200);
    const refused = await agentSays(a.id, w.g, "@beta 你说");
    expect([refused.runs, refused.notices]).toEqual([[], []]);
    expect(await runsOf(b.id, w.g)).toEqual([]);
    // Another Agent's message after it: the latest person's message is still before the halt.
    expect((await agentSays(b.id, w.g, "@alpha 你说")).runs).toEqual([]);
    // A person's message lifts it by being later; a mention in it is answered at once.
    const asked = await say(w.member, w.g, "@beta 那你说");
    expect((await runsOf(b.id, w.g)).map((r) => [r.covers, r.by])).toEqual([[asked, "human"]]);
    await settleAll();
    expect((await agentSays(a.id, w.g, "@beta 继续")).runs).toHaveLength(1);
  });

  it("a reply the halt interrupted ends cancelled, halted; what a person asked of it meanwhile is followed up, what Agents asked is not", async () => {
    const w = await world();
    const a = await agentOf(w.owner, "alpha", w.g);
    const b = await agentOf(w.member, "beta", w.g);
    await say(w.owner, w.g, "开始");
    const running = async (by: "human" | "agent") => {
      const covers = await seqOf(w.g);
      const id = (
        await db.query<{ id: string }>(
          `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, triggered_by, started_at)
           values ('reply', $1, $2, $3, 'running', $4, $5, now()) returning id`,
          [w.g, b.id, w.member.id, covers, by],
        )
      ).rows[0]!.id;
      return { id, agentId: b.id, ownerId: w.member.id, conversationId: w.g } satisfies RunTicket;
    };
    const finish = (ticket: RunTicket) => app.agentPort.finish(ticket, { status: "done" }, null, NOTHING);

    // Called by an Agent; an Agent's mention noted on it; halted: cancelled, no follow-up.
    const one = await running("agent");
    await agentSays(a.id, w.g, "@beta 补充");
    expect((await api(app, w.third, "POST", `/api/conversations/${w.g}/agents/halt`)).status).toBe(200);
    await finish(one);
    expect(await runsOf(b.id, w.g)).toEqual([expect.objectContaining({ status: "cancelled", error: "halted", interrupted: "halted" })]);

    // Called by an Agent; a person's mention noted on it; halted: cancelled, and the person is answered.
    await say(w.owner, w.g, "继续");
    const two = await running("agent");
    const asked = await say(w.third, w.g, "@beta 我的问题");
    expect((await api(app, w.third, "POST", `/api/conversations/${w.g}/agents/halt`)).status).toBe(200);
    await finish(two);
    expect((await runsOf(b.id, w.g)).slice(1)).toEqual([
      expect.objectContaining({ status: "cancelled", error: "halted" }),
      { status: "queued", error: null, covers: asked, by: "human", interrupted: null },
    ]);
    await settleAll();

    // Called by a person (not interrupted); an Agent's mention noted on it before the halt: not followed up while halted.
    await say(w.owner, w.g, "再来");
    const three = await running("human");
    await agentSays(a.id, w.g, "@beta 还有");
    expect((await api(app, w.third, "POST", `/api/conversations/${w.g}/agents/halt`)).status).toBe(200);
    expect((await runsOf(b.id, w.g)).at(-1)?.interrupted).toBeNull();
    await finish(three);
    expect((await runsOf(b.id, w.g)).slice(3)).toEqual([expect.objectContaining({ status: "done", by: "human" })]);

    // Not halted: an Agent's mention noted on a run is followed up, marked as an Agent's.
    await say(w.owner, w.g, "最后");
    const four = await running("human");
    const noted = await agentSays(a.id, w.g, "@beta 接着");
    await finish(four);
    expect((await runsOf(b.id, w.g)).slice(4)).toEqual([
      expect.objectContaining({ status: "done", by: "human" }),
      { status: "queued", error: null, covers: noted.message.seq, by: "agent", interrupted: null },
    ]);
    // Released instead of finished (recovery's way): the same rule.
    await settleAll();
    const five = await running("agent");
    await agentSays(a.id, w.g, "@beta 又一个");
    expect((await api(app, w.third, "POST", `/api/conversations/${w.g}/agents/halt`)).status).toBe(200);
    expect(await app.agentPort.releaseRun(five.id)).toBe(true);
    expect((await runsOf(b.id, w.g)).slice(6)).toEqual([expect.objectContaining({ status: "cancelled", error: "halted" })]);
  });

  it("a mention refused while halted is recorded without touching the named Agent's row: held elsewhere, the post does not wait", async () => {
    const w = await world();
    const a = await agentOf(w.owner, "alpha", w.g);
    const b = await agentOf(w.member, "beta", w.g);
    await say(w.owner, w.g, "开始");
    expect((await api(app, w.third, "POST", `/api/conversations/${w.g}/agents/halt`)).status).toBe(200);
    // Another transaction holds Beta's row (as its pause does: `lockAgent`, on its own conversation), not committed.
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    let holding: () => void = () => {};
    const held = new Promise<void>((resolve) => (holding = resolve));
    const holder = db.tx(async (t) => {
      await lockAgent(t, b.id, b.conversationId);
      holding();
      await released;
    });
    await held;
    try {
      // Alpha's message names Beta and is refused (halted). A wait on Beta's row fails fast instead of hanging.
      const refused = await db.tx(async (t) => {
        await t.query("set local lock_timeout = '2s'");
        const poster = await lockAgent(t, a.id, w.g);
        const message = await insertMessage(t, w.g, a.id, "text", { text: "@beta 你看看" }, null, await mentionsAtSend(t, { id: w.g, type: "group" }, "@beta 你看看"));
        // Posted by no run: whose question it carries is not known (null).
        return { message, ...(await triggerFromAgent(t, w.g, message, poster, null, app.deps.config, null)) };
      });
      expect(refused.runs).toEqual([]);
      const recorded = await db.query("select agent_id from refused_agent_calls where conversation_id = $1 and seq = $2", [w.g, refused.message.seq]);
      expect(recorded.rows).toEqual([{ agent_id: b.id }]);
    } finally {
      release();
      await holder;
    }
  });

  it("a reply the halt interrupted is never posted", async () => {
    const owner = await signUp(app, "solo");
    const agent = await agentOf(owner, "solo_bot", null);
    const id = (
      await db.query<{ id: string }>(
        `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, started_at, interrupted)
         values ('reply', $1, $2, $3, 'running', 1, now(), 'halted') returning id`,
        [agent.conversationId, agent.id, owner.id],
      )
    ).rows[0]!.id;
    const ticket: RunTicket = { id, agentId: agent.id, ownerId: owner.id, conversationId: agent.conversationId };
    expect(await app.agentPort.post(ticket, { text: "回答", reasoning: "", stopped: false, truncated: false })).toBe("refused");
    expect(Number((await db.query("select count(*) n from messages where client_txn = $1", [id])).rows[0].n)).toBe(0);
  });
});

// --- follow-ups ------------------------------------------------------------------------------------------------

/** Ends the running run `runId` through `port`, as the worker ends one that answered: `finish`, which follows it up. */
const endRun = async (port: FastifyInstance["agentPort"], runId: string): Promise<void> => {
  const of = (await db.query<{ agent_id: string; owner_id: string; conversation_id: string }>("select agent_id, owner_id, conversation_id from agent_runs where id = $1", [runId]))
    .rows[0]!;
  await port.finish({ id: runId, agentId: of.agent_id, ownerId: of.owner_id, conversationId: of.conversation_id }, { status: "done" }, null, NOTHING);
};

describe("follow-ups in a group", () => {
  it("count toward the owner's replies a minute: continuous mentions while each reply runs never start more than AGENT_OTHERS_RUNS_PER_MINUTE; over it, nothing is started, and the senders read the line", async () => {
    const limit = 3;
    const capped = await buildApp(
      { config: { ...app.deps.config, agentOthersRunsPerMinute: limit }, db, models: gateway },
      { answerFloor: NO_ANSWER_FLOOR, staleRunSweep: false, agentWorker: false },
    );
    try {
      await capped.ready();
      const config = capped.deps.config;
      const w = await world();
      const anna = await agentOf(w.owner, "anna", w.g);
      const alpha = await agentOf(w.member, "alpha", w.g);
      const mention = async (who: Actor, text: string): Promise<number> => {
        const sent = await api(capped, who, "POST", `/api/conversations/${w.g}/messages`, { text, clientTxn: `fu${++txn}` });
        expect(sent.status).toBe(201);
        return sent.json.message.seq as number;
      };
      /** Replies the owner started in the last minute, as the limit counts them. */
      const started = async () =>
        Number(
          (
            await db.query(
              `select count(*) n from agent_runs
                where owner_id = $1 and purpose = 'reply' and created_at > now() - interval '1 minute' and error is distinct from 'rate_limited'`,
              [w.owner.id],
            )
          ).rows[0].n,
        );
      const active = async () =>
        (await db.query<{ id: string }>("select id from agent_runs where agent_id = $1 and conversation_id = $2 and status in ('queued', 'running')", [anna.id, w.g])).rows[0]?.id ??
        null;

      await mention(w.member, "@anna 开始");
      expect(await started()).toBe(1);
      // Members keep mentioning it while each reply runs — a person and an Agent in turn — and each reply's end follows
      // up what was noted; once there is no reply under way, each further mention meets the limit at once.
      const pushed = vi.spyOn(capped.realtime, "pushRun");
      const counts: number[] = [];
      let last = 0;
      for (let i = 0; i < 7; i++) {
        const id = await active();
        if (id === null) {
          last = await mention(w.third, `@anna 还在吗 ${i}`);
        } else {
          await db.query("update agent_runs set status = 'running', started_at = now() where id = $1", [id]);
          last = i % 2 === 0 ? await mention(w.third, `@anna 再说 ${i}`) : (await agentSays(alpha.id, w.g, `@anna 补充 ${i}`, config)).message.seq;
          await endRun(capped.agentPort, id);
        }
        counts.push(await started());
      }
      expect(counts).toEqual([2, 3, 3, 3, 3, 3, 3]);
      // Two follow-ups were queued (a person's, then an Agent's); the third met the limit: nothing was queued or recorded, and
      // nothing failed for anybody to see.
      const told = pushed.mock.calls.map(([, run]) => run.error ?? null);
      expect(told).not.toContain("rate_limited");
      expect((await runsOf(anna.id, w.g)).map((r) => [r.status, r.error, r.by])).toEqual([
        ["done", null, "human"],
        ["done", null, "human"],
        ["done", null, "agent"],
      ]);
      expect((await api(capped, w.owner, "GET", `/api/conversations/${w.g}/runs`)).json.runs).toEqual([]);
      expect((await api(capped, w.member, "GET", `/api/conversations/${w.g}/runs`)).json.runs).toEqual([]);
      // The last mention, over the minute with no reply under way: its sender alone reads why.
      const mine = ((await api(capped, w.third, "GET", `/api/conversations/${w.g}/messages`)).json.messages as Array<{ seq: number; refused?: unknown }>).find((m) => m.seq === last);
      expect(mine?.refused).toEqual([{ agentId: anna.id, reason: "too_often" }]);
    } finally {
      await capped.close();
    }
  });

  /**
   * A running reply of `agentId` in the group covering its current seq, called for as `by` says; with `holdMicro`, one
   * admitted on the site model `fast`, charged to its owner's balance, holding that much.
   */
  const runningIn = async (conv: string, agentId: string, ownerId: string, by: "human" | "agent", holdMicro: number | null = null) => {
    const id = (
      await db.query<{ id: string }>(
        `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, triggered_by, started_at, source, model, charge_to, hold_micro)
         select 'reply', $1, $2, $3, 'running', seq, $4, now(),
                case when $5::bigint is null then null else 'site' end, case when $5::bigint is null then null else 'fast' end,
                case when $5::bigint is null then null else 'balance' end, coalesce($5::bigint, 0)
           from conversations where id = $1 returning id`,
        [conv, agentId, ownerId, by, holdMicro],
      )
    ).rows[0]!.id;
    return { id, agentId, ownerId, conversationId: conv } satisfies RunTicket;
  };

  it("an Agent's mention that waited from before a halt is never answered, even once a person has written since; a person's mention that waited with it still is", async () => {
    const w = await world();
    const a = await agentOf(w.owner, "alpha", w.g);
    const b = await agentOf(w.member, "beta", w.g);
    const finish = (ticket: RunTicket) => app.agentPort.finish(ticket, { status: "done" }, null, NOTHING);
    await say(w.owner, w.g, "开始");

    // A person called it; an Agent's mention is noted on it; a member halts; a person writes before the reply ends,
    // which lifts the halt for what comes next — not for what was asked before it.
    const one = await runningIn(w.g, b.id, w.member.id, "human");
    await agentSays(a.id, w.g, "@beta 补充");
    expect((await api(app, w.third, "POST", `/api/conversations/${w.g}/agents/halt`)).status).toBe(200);
    await say(w.third, w.g, "大家继续");
    await finish(one);
    expect(await runsOf(b.id, w.g)).toEqual([expect.objectContaining({ status: "done", by: "human" })]);

    // The same with a person's mention waiting before the halt too: that person is answered; the Agent's, taken after it, is not.
    const two = await runningIn(w.g, b.id, w.member.id, "human");
    const asked = await say(w.third, w.g, "@beta 我也问一下");
    await agentSays(a.id, w.g, "@beta 再补充");
    expect((await api(app, w.third, "POST", `/api/conversations/${w.g}/agents/halt`)).status).toBe(200);
    await say(w.owner, w.g, "好的");
    await finish(two);
    const three = await db.query<{ id: string }>("select id from agent_runs where agent_id = $1 and status = 'queued'", [b.id]);
    expect((await runsOf(b.id, w.g)).slice(1)).toEqual([
      expect.objectContaining({ status: "done", by: "human" }),
      { status: "queued", error: null, covers: asked, by: "human", interrupted: null },
    ]);
    await db.query("update agent_runs set status = 'running', started_at = now() where id = $1", [three.rows[0]!.id]);
    await finish({ id: three.rows[0]!.id, agentId: b.id, ownerId: w.member.id, conversationId: w.g });
    expect((await runsOf(b.id, w.g)).length).toBe(3);
    expect(await waitingOf(b.id, w.g)).toEqual([]);
  });

  it.each([
    ["its owner has blocked", "member", "third"],
    ["who has blocked its owner", "third", "member"],
  ] as const)("a mention by a person %s does not make a follow-up a person's", async (_what, blocker, blocked) => {
    const w = await world();
    const a = await agentOf(w.owner, "alpha", w.g);
    const b = await agentOf(w.member, "beta", w.g);
    expect((await api(app, w[blocker], "PUT", `/api/blocks/${w[blocked].id}`)).status).toBe(200);
    await say(w.owner, w.g, "开始");
    // The blocked person's mention falls among what an Agent's noted mention covers; then a halt, lifted by a person.
    const one = await runningIn(w.g, b.id, w.member.id, "human");
    await say(w.third, w.g, "@beta 我也问一下");
    await agentSays(a.id, w.g, "@beta 再补充");
    expect((await api(app, w.owner, "POST", `/api/conversations/${w.g}/agents/halt`)).status).toBe(200);
    await say(w.owner, w.g, "好的");
    await app.agentPort.finish(one, { status: "done" }, null, NOTHING);
    // Only an Agent asked, before the halt: nothing follows.
    expect(await runsOf(b.id, w.g)).toEqual([expect.objectContaining({ status: "done", by: "human" })]);
  });

  it("an Agent's follow-up is not queued once the reply under way has spent its Agent's chain budget; the group is told once", async () => {
    const w = await world();
    const a = await agentOf(w.owner, "alpha", w.g);
    const b = await agentOf(w.member, "beta", w.g);
    expect((await api(app, w.member, "PATCH", `/api/agents/${b.id}`, { chainBudget: "1" })).json.chainBudget).toBe("1");
    await say(w.owner, w.g, "开始");
    await agentSays(a.id, w.g, "我先说两句");
    // A reply of beta's an Agent called for, covering that message, admitted on `fast` and holding a point.
    const one = await runningIn(w.g, b.id, w.member.id, "agent", 1_000_000);
    // Nothing of the chain is charged yet: another Agent's mention of it waits behind it.
    const waits = await agentSays(a.id, w.g, "@beta 继续");
    expect(waits.notices).toEqual([]);
    expect(await waitingOf(b.id, w.g)).toEqual([waits.message.seq]);


    // It ends having cost a point (600 000 input and 200 000 output tokens on `fast`): the budget is spent, and what was
    // noted on it is not answered. The group is told as the run ends, live.
    const thirdSocket = await connect(app, w.third);
    await app.agentPort.finish(one, { status: "done" }, { inputTokens: 600_000, outputTokens: 200_000 }, NOTHING);
    const told = await thirdSocket.next((x) => x.type === "message" && x.message.system?.event === "agent_budget_reached");
    expect(told.message).toMatchObject({ senderId: null, text: "beta 已达到本次接话的点数上限，有人发言后继续。", system: { event: "agent_budget_reached", agentId: b.id } });
    expect((await db.query("select balance_micro::int as b from usage_records where run_id = $1", [one.id])).rows).toEqual([{ b: 1_000_000 }]);
    expect(await runsOf(b.id, w.g)).toEqual([expect.objectContaining({ status: "done", by: "agent" })]);
    expect((await noticesOf(w.g, "agent_budget_reached")).map((n) => [n.body.actorId, n.body.agentId])).toEqual([[b.id, b.id]]);
    // Told once for this chain: the next Agent's mention is refused without a second notice.
    expect(await agentSays(a.id, w.g, "@beta 还有")).toMatchObject({ runs: [], notices: [] });
    expect((await noticesOf(w.g, "agent_budget_reached")).length).toBe(1);
  });
});

// --- chainBudget --------------------------------------------------------------------------------------------------

describe("chainBudget", () => {
  it("is its owner's: 50 points by default, a decimal string of 1 to 100 000 points on creation and by PATCH, shown to nobody else", async () => {
    const w = await world();
    const plain = await mustCreateAgent(app, w.owner);
    expect(plain.chainBudget).toBe("50");
    const set = await mustCreateAgent(app, w.owner, { chainBudget: "12.5" });
    expect(set.chainBudget).toBe("12.5");
    expect((await api(app, w.owner, "GET", `/api/agents/${set.id}`)).json.chainBudget).toBe("12.5");
    for (const [value, shown] of [["100000", "100000"], ["1", "1"], ["1.000000", "1"], ["0099.5", "99.5"], ["2.000001", "2.000001"]] as const) {
      const patched = await api(app, w.owner, "PATCH", `/api/agents/${set.id}`, { chainBudget: value });
      expect([value, patched.status, patched.json.chainBudget]).toEqual([value, 200, shown]);
    }
    expect((await db.query("select chain_budget_micro::text as m from agents where principal_id = $1", [set.id])).rows).toEqual([{ m: "2000001" }]);
    // Other edits keep it.
    expect((await api(app, w.owner, "PATCH", `/api/agents/${set.id}`, { intro: "简介" })).json.chainBudget).toBe("2.000001");
    for (const bad of ["0", "0.999999", "100000.000001", "100001", "-1", "+5", "1e3", "", " 5", "5.", ".5", "1.0000001", "五", 5, null, [], {}]) {
      expect([bad, await api(app, w.owner, "PATCH", `/api/agents/${set.id}`, { chainBudget: bad })]).toEqual([bad, { status: 400, json: { error: "invalid_request" } }]);
      expect([bad, (await api(app, w.owner, "POST", "/api/agents", { namePart: `cb_${txn++}`, name: "CB", chainBudget: bad })).status]).toEqual([bad, 400]);
    }
    expect((await api(app, w.owner, "GET", `/api/agents/${set.id}`)).json.chainBudget).toBe("2.000001");
    // Anybody else: as for an id that does not exist, and changed nothing.
    const stranger = await observe(w.member, { method: "PATCH", url: `/api/agents/${set.id}`, payload: { chainBudget: "7" } });
    expect(stranger).toEqual(await observe(w.member, { method: "PATCH", url: `/api/agents/${RANDOM}`, payload: { chainBudget: "7" } }));
    expect(stranger.status).toBe(404);
    // A fellow member of a group it is in never sees it.
    await join(w.g, set.id);
    await say(w.owner, w.g, "大家好");
    for (const path of ["/api/sync", `/api/conversations/${w.g}/members`, `/api/conversations/${w.g}/messages`]) {
      const seen = JSON.stringify((await api(app, w.member, "GET", path)).json);
      expect([path, /chainBudget|chain_budget/.test(seen)]).toEqual([path, false]);
    }
    expect(JSON.stringify((await api(app, w.member, "GET", `/api/conversations/${w.g}/members`)).json)).toContain(set.id);
  });
});
