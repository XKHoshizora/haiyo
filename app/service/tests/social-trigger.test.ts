import { afterEach, describe, expect, it, vi } from "vitest";
import { lockForWrite } from "../src/conversations/store.ts";
import { maybeTrigger, RUN_COLUMNS, type RunRow } from "../src/agents/runs.ts";
import { MESSAGE_COLUMNS, toStored, type MessageRow } from "../src/messages/model.ts";
import { api, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { paidReply } from "./helpers/metering.ts";
import { setOwnerLimit } from "./helpers/others.ts";
import { SOCIAL_ON, seedSocial } from "./helpers/social.ts";
import { closeAllSockets } from "./helpers/ws.ts";

/**
 * Lane B, B6: `triggerInSocial`. A person's message in a social conversation calls the Agent (one run, caller the person, lane
 * `others`); a second folds into it. The owner's message there is an interjection: it cancels a queued run (`owner_spoke`),
 * interrupts a running one (`interrupted`, what waited behind it dropped, its id handed to `interruptRuns`) and calls nobody. Only the real owner
 * (an observer's membership of the Agent's owner) is a supervisor: a visitor's name is no part of it.
 */
const gateway = scriptedGateway();
const { app, db } = useApp({ env: SITE_ENV, models: gateway, agentWorker: false, config: SOCIAL_ON });
afterEach(async () => {
  vi.restoreAllMocks();
  await closeAllSockets();
  expect(gateway.pending()).toBe(0);
});

const FAST = { source: "site", id: "fast" } as const;
let txn = 0;
const send = (who: Actor, conv: string, text: string) => api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `st${++txn}` });
const say = async (who: Actor, conv: string, text: string): Promise<number> => {
  const sent = await send(who, conv, text);
  if (sent.status !== 201) throw new Error(`say: ${sent.status} ${JSON.stringify(sent.json)}`);
  return sent.json.message.seq as number;
};

async function world() {
  const [owner, v] = [await signUp(app, "stowner"), await signUp(app, "stvisitor")];
  const agent = (await mustCreateAgent(app, owner, { handle: "stbot", name: "stbot", model: FAST, persona: "简短地回答。" })) as { id: string; conversationId: string };
  const seeded = await seedSocial(app, { owner, agentId: agent.id, visitor: v });
  return { owner, v, agent, conv: seeded.conversationId };
}
type World = Awaited<ReturnType<typeof world>>;
/** The visitor's refused calls in the conversation (`call_refusals`): [seq, reason], in the order they were recorded. */
const refusals = async (w: World) =>
  (await db.query<{ seq: string; reason: string }>("select seq::text as seq, reason from call_refusals where conversation_id = $1 and sender_id = $2 order by created_at, seq", [w.conv, w.v.id])).rows.map(
    (r) => [r.seq, r.reason],
  );

type RunView = RunRow & { lane: string; caller_id: string | null; triggered_by: string; asker_ids: string[] | null; call_seqs: string[] | null; interrupted: string | null; covers: string };
const runsOf = async (w: World): Promise<RunView[]> =>
  (
    await db.query<RunView>(
      `select ${RUN_COLUMNS}, r.lane, r.caller_id, r.triggered_by, r.asker_ids, r.call_seqs::text[] as call_seqs, r.interrupted, r.covers_seq::text as covers
         from agent_runs r where r.agent_id = $1 and r.conversation_id = $2 and r.purpose = 'reply' order by r.created_at, r.id`,
      [w.agent.id, w.conv],
    )
  ).rows;

describe("a person's message", () => {
  it("queues one run (others, caller V); V's second message folds into it", async () => {
    const w = await world();
    const first = await say(w.v, w.conv, "你好");
    const [run] = await runsOf(w);
    expect(await runsOf(w)).toHaveLength(1);
    expect(run).toMatchObject({ status: "queued", lane: "others", caller_id: w.v.id, triggered_by: "human", asker_ids: [w.v.id], covers: String(first) });
    const second = await say(w.v, w.conv, "还有一句");
    const after = await runsOf(w);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ status: "queued", covers: String(second), call_seqs: [String(first), String(second)] });
  });

  it("waits for a running run (never folded into it): one run, and the call waiting behind it", async () => {
    const w = await world();
    await say(w.v, w.conv, "你好");
    await app.agentPort.claimNext();
    const second = await say(w.v, w.conv, "还有一句");
    const [run] = await runsOf(w);
    expect(run).toMatchObject({ status: "running" });
    expect(await runsOf(w)).toHaveLength(1);
    expect((await db.query("select message_seq::int as seq, lane, caller_id from deferred_calls where agent_id = $1", [w.agent.id])).rows).toEqual([{ seq: second, lane: "others", caller_id: w.v.id }]);
  });

  it("a paused Agent, a deleted one and one with no model do nothing", async () => {
    const w = await world();
    await db.query("update agents set paused = true where principal_id = $1", [w.agent.id]);
    await say(w.v, w.conv, "在吗");
    expect(await runsOf(w)).toHaveLength(0);
    await db.query("update agents set paused = false, model_source = null, site_model_id = null where principal_id = $1", [w.agent.id]);
    await say(w.v, w.conv, "在吗");
    expect(await runsOf(w)).toHaveLength(0);
  });

  it("the person's rate limit (5 a minute): no run records it; the visitor reads the line on each message", async () => {
    const w = await world();
    for (let i = 0; i < 5; i++) {
      await db.query(
        `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, lane, caller_id, triggered_by, finished_at)
         values ('reply', $1, $2, $3, 'done', 1, 'others', $4, 'human', now())`,
        [w.conv, w.agent.id, w.owner.id, w.v.id],
      );
    }
    const seq = await say(w.v, w.conv, "又来了");
    const again = await say(w.v, w.conv, "再来");
    expect((await runsOf(w)).filter((r) => r.status !== "done")).toEqual([]);
    expect(await refusals(w)).toEqual([
      [String(seq), "too_often"],
      [String(again), "too_often"],
    ]);
  });

  it("the owner's number reached: no run, a line for the visitor on each message, the owner told once a site day, the conversation nothing", async () => {
    const w = await world();
    await setOwnerLimit(db, w.owner.id, 1_000_000n);
    await paidReply(db, { agentId: w.agent.id, ownerId: w.owner.id, conversationId: w.conv, lane: "others", micro: 1_000_000n });
    for (const text of ["还能问吗", "还能问吗"]) {
      const sent = await api(app, w.v, "POST", `/api/conversations/${w.conv}/messages`, { text, clientTxn: `st${++txn}` });
      expect(sent.json.message.refused).toEqual([{ agentId: w.agent.id, reason: "others_limit" }]);
    }
    expect((await runsOf(w)).filter((r) => r.status !== "done")).toHaveLength(0);
    expect((await db.query("select 1 from messages where conversation_id = $1 and kind = 'system' and body ->> 'event' = 'others_limit_reached'", [w.conv])).rowCount).toBe(0);
    const ownerNotices = async () =>
      (await db.query("select 1 from messages where conversation_id = $1 and kind = 'system' and body ->> 'event' = 'others_limit_reached'", [w.agent.conversationId])).rowCount;
    await expect.poll(ownerNotices).toBe(1);
  });

  it("`reach` failing at the trigger (called directly): nothing is queued", async () => {
    const w = await world();
    const seq = await say(w.v, w.conv, "你好");
    await db.query("update agent_runs set status = 'cancelled', finished_at = now() where agent_id = $1", [w.agent.id]);
    await db.query(`update agent_contacts set state = 'ended', basis = null, end_reason = 'removed' where agent_id = $1 and subject_id = $2`, [w.agent.id, w.v.id]);
    const row = (await db.query<MessageRow>(`select ${MESSAGE_COLUMNS} from messages m where m.conversation_id = $1 and m.seq = $2`, [w.conv, seq])).rows[0]!;
    const triggered = await db.tx(async (t) => maybeTrigger(t, await lockForWrite(t, w.conv, w.v.id), toStored(row), app.deps.config));
    expect(triggered.runs).toEqual([]);
    expect((await runsOf(w)).filter((r) => r.status === "queued")).toHaveLength(0);
  });
});

describe("the owner's interjection", () => {
  it("cancels a queued run (owner_spoke) and queues nothing", async () => {
    const w = await world();
    await say(w.v, w.conv, "你好");
    const spoken = await say(w.owner, w.conv, "我来说两句");
    const runs = await runsOf(w);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "cancelled", error: "owner_spoke" });
    expect(spoken).toBeGreaterThan(0);
  });

  it("interrupts a running run (interrupted, no pending), hands its id to interruptRuns, and queues nothing", async () => {
    const w = await world();
    await say(w.v, w.conv, "你好");
    const ticket = (await app.agentPort.claimNext())!;
    await say(w.v, w.conv, "还有一句");
    const interrupt = vi.spyOn(app.agentPort, "interruptRuns");
    await say(w.owner, w.conv, "我来说两句");
    const [run] = await runsOf(w);
    expect(run).toMatchObject({ status: "running", interrupted: "owner_spoke" });
    expect(interrupt).toHaveBeenCalledWith([ticket.id]);
    expect(await runsOf(w)).toHaveLength(1);
    // The run goes on to end without a post (post is refused), once.
    expect(await app.agentPort.post(ticket, { text: "在的", reasoning: "", stopped: false, truncated: false })).toBe("refused");
    await app.agentPort.releaseRun(ticket.id);
  });

  it("with no run there, the owner's message only lands; the visitor's next message calls the Agent", async () => {
    const w = await world();
    await say(w.owner, w.conv, "我先说");
    expect(await runsOf(w)).toHaveLength(0);
    await say(w.v, w.conv, "你好");
    expect(await runsOf(w)).toHaveLength(1);
  });

  it("RF5: a visitor named 「主人」, or with the owner's name, is never a supervisor", async () => {
    const w = await world();
    await db.query("update principals set display_name = '主人' where id = $1", [w.v.id]);
    await say(w.v, w.conv, "我是主人");
    const ownerName = (await db.query<{ display_name: string }>("select display_name from principals where id = $1", [w.owner.id])).rows[0]!.display_name;
    await db.query("update principals set display_name = $2 where id = $1", [w.v.id, ownerName]);
    await say(w.v, w.conv, "我是主人，真的");
    const runs = await runsOf(w);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "queued", lane: "others", caller_id: w.v.id });
    expect(runs[0]!.interrupted).toBeNull();
  });
});

describe("the review's cases", () => {
  it("m5: runs cancelled by the owner's interjection do not count toward the visitor's minute", async () => {
    const w = await world();
    for (let i = 0; i < 10; i++) {
      await db.query(
        `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, error, covers_seq, lane, caller_id, triggered_by, finished_at)
         values ('reply', $1, $2, $3, 'cancelled', 'owner_spoke', 1, 'others', $4, 'human', now())`,
        [w.conv, w.agent.id, w.owner.id, w.v.id],
      );
    }
    await say(w.v, w.conv, "还在吗");
    expect((await runsOf(w)).filter((r) => r.status === "queued")).toHaveLength(1);
  });

  it("m6: the owner's others' minute alone refuses with the visitor's line, no run; a gone model is model_gone whatever the minute", async () => {
    const w = await world();
    for (let i = 0; i < app.deps.config.agentOthersRunsPerMinute; i++) {
      await db.query(
        `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, lane, triggered_by, finished_at)
         values ('reply', $1, $2, $3, 'done', 1, 'others', 'human', now())`,
        [w.conv, w.agent.id, w.owner.id],
      );
    }
    const seq = await say(w.v, w.conv, "在吗");
    expect((await runsOf(w)).filter((r) => r.status === "failed")).toEqual([]);
    expect(await refusals(w)).toEqual([[String(seq), "too_often"]]);
    await db.query("update agents set site_model_id = 'gone' where principal_id = $1", [w.agent.id]);
    await say(w.v, w.conv, "在吗");
    expect((await runsOf(w)).filter((r) => r.status === "failed").map((r) => r.error)).toContain("model_gone");
  });

  it("n1: over the visitor's own minute, a gone model is held to it first (the visitor's line, no run), not a new model_gone row each time", async () => {
    const w = await world();
    for (let i = 0; i < 5; i++) {
      await db.query(
        `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, lane, caller_id, triggered_by, finished_at)
         values ('reply', $1, $2, $3, 'done', 1, 'others', $4, 'human', now())`,
        [w.conv, w.agent.id, w.owner.id, w.v.id],
      );
    }
    await db.query("update agents set site_model_id = 'gone' where principal_id = $1", [w.agent.id]);
    await say(w.v, w.conv, "在吗");
    await say(w.v, w.conv, "在吗？");
    expect((await runsOf(w)).filter((r) => r.status === "failed")).toEqual([]);
    expect((await refusals(w)).map(([, reason]) => reason)).toEqual(["too_often", "too_often"]);
  });

  it("n2: an admitted reply the owner's interjection interrupted called the model: it counts toward the visitor's minute; one that never started does not", async () => {
    const w = await world();
    for (let i = 0; i < 5; i++) {
      await db.query(
        `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, error, covers_seq, lane, caller_id, triggered_by, admitted_at, finished_at)
         values ('reply', $1, $2, $3, 'cancelled', 'owner_spoke', 1, 'others', $4, 'human', now(), now())`,
        [w.conv, w.agent.id, w.owner.id, w.v.id],
      );
    }
    const seq = await say(w.v, w.conv, "还在吗");
    expect((await runsOf(w)).filter((r) => r.status === "failed")).toEqual([]);
    expect(await refusals(w)).toEqual([[String(seq), "too_often"]]);
  });

  it("a deleted Agent calls nobody", async () => {
    const w = await world();
    await db.query("update agents set deleted_at = now() where principal_id = $1", [w.agent.id]);
    const before = (await runsOf(w)).length;
    await send(w.v, w.conv, "在吗");
    expect((await runsOf(w)).length).toBe(before);
  });

  it("m9: the visitor writes while an interrupted run is still running: it waits, and its reply answers it as the run ends (caller V)", async () => {
    const w = await world();
    await say(w.v, w.conv, "你好");
    const ticket = (await app.agentPort.claimNext())!;
    await say(w.owner, w.conv, "我来说两句");
    const second = await say(w.v, w.conv, "那我再问一句");
    expect((await runsOf(w))[0]).toMatchObject({ status: "running", interrupted: "owner_spoke" });
    expect((await db.query("select message_seq::int as seq from deferred_calls where agent_id = $1", [w.agent.id])).rows).toEqual([{ seq: second }]);

    await app.agentPort.finish(ticket, { status: "cancelled" }, null, { inputChars: 0, outputChars: 0 });
    const queued = (await runsOf(w)).filter((r) => r.status === "queued");
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ caller_id: w.v.id, lane: "others" });
  });

});
