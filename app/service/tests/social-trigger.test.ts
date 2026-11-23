import { afterEach, describe, expect, it, vi } from "vitest";
import { lockForWrite } from "../src/conversations/store.ts";
import { maybeTrigger, RUN_COLUMNS, type RunRow } from "../src/agents/runs.ts";
import { MESSAGE_COLUMNS, toStored, type MessageRow } from "../src/messages/model.ts";
import { api, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { setOwnerNumbers } from "./helpers/others.ts";
import { SOCIAL_ON, seedSocial } from "./helpers/social.ts";
import { closeAllSockets } from "./helpers/ws.ts";

/**
 * Lane B, B6: `triggerInSocial`. A person's message in a social conversation calls the Agent (one run, caller the person, lane
 * `others`); a second folds into it. The owner's message there is an interjection: it cancels a queued run (`owner_spoke`),
 * interrupts a running one (`interrupted`, no pending, its id handed to `interruptRuns`) and calls nobody. Only the real owner
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

type RunView = RunRow & { lane: string; caller_id: string | null; triggered_by: string; asker_ids: string[] | null; call_seqs: string[] | null; pending: string | null; interrupted: string | null; covers: string };
const runsOf = async (w: World): Promise<RunView[]> =>
  (
    await db.query<RunView>(
      `select ${RUN_COLUMNS}, r.lane, r.caller_id, r.triggered_by, r.asker_ids, r.call_seqs::text[] as call_seqs, r.pending_seq::text as pending, r.interrupted, r.covers_seq::text as covers
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

  it("folds into a running run as a noted call", async () => {
    const w = await world();
    await say(w.v, w.conv, "你好");
    await app.agentPort.claimNext();
    const second = await say(w.v, w.conv, "还有一句");
    const [run] = await runsOf(w);
    expect(run).toMatchObject({ status: "running", pending: String(second) });
    expect(await runsOf(w)).toHaveLength(1);
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

  it("the person's rate limit (5 a minute) and the owner's others' minute record one rate_limited run, reused", async () => {
    const w = await world();
    for (let i = 0; i < 5; i++) {
      await db.query(
        `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, lane, caller_id, triggered_by, finished_at)
         values ('reply', $1, $2, $3, 'done', 1, 'others', $4, 'human', now())`,
        [w.conv, w.agent.id, w.owner.id, w.v.id],
      );
    }
    const seq = await say(w.v, w.conv, "又来了");
    const runs = (await runsOf(w)).filter((r) => r.status === "failed");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ error: "rate_limited", lane: "others", caller_id: w.v.id, covers: String(seq) });
    const again = await say(w.v, w.conv, "再来");
    const reused = (await runsOf(w)).filter((r) => r.status === "failed");
    expect(reused).toHaveLength(1);
    expect(reused[0]!.covers).toBe(String(again));
  });

  it("the owner's numbers reached: no run, the notice once a site day", async () => {
    const w = await world();
    await setOwnerNumbers(db, w.owner.id, { answers: 1 });
    await db.query(
      `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, lane, caller_id, triggered_by, finished_at, admitted_at)
       values ('reply', $1, $2, $3, 'done', 1, 'others', $4, 'human', now(), now())`,
      [w.conv, w.agent.id, w.owner.id, w.v.id],
    );
    await say(w.v, w.conv, "还能问吗");
    await say(w.v, w.conv, "还能问吗");
    expect((await runsOf(w)).filter((r) => r.status !== "done")).toHaveLength(0);
    const notices = await db.query("select 1 from messages where conversation_id = $1 and kind = 'system' and body ->> 'event' = 'agent_daily_budget_reached'", [w.conv]);
    expect(notices.rowCount).toBe(1);
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
    expect(runs[0]).toMatchObject({ status: "cancelled", error: "owner_spoke", pending: null });
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
    expect(run).toMatchObject({ status: "running", interrupted: "owner_spoke", pending: null });
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
