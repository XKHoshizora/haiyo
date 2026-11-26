import { afterEach, describe, expect, it, vi } from "vitest";
import { NOTHING, type RunEnd } from "../src/agents/runtime/port.ts";
import { queueRun, type Announced } from "../src/agents/runs.ts";
import { lockConversation } from "../src/conversations/store.ts";
import { api, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { paidReply } from "./helpers/metering.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { closeAllSockets, connect, type TestSocket } from "./helpers/ws.ts";

/**
 * The run of a reply an Agent makes unasked (lane `proactive`, batch 2D) once it is queued: what the group's other
 * members are told when it fails, and what is read again as it is admitted (its owner's switch, its proactive budget).
 * The run is queued as the decision queues one (agents/proactive/decide.ts: covering a person's message, called for by
 * nobody) and announced as its `act` announces it; the worker runs it by hand.
 */

const JUDGE = {
  model: "jev-1",
  channels: [{ url: "https://judge-a.example.test/v1/systemone", apiKeyEnv: "UPSTREAM_TEST_KEY" }],
  timeoutMs: 4000,
  dailyLimit: 20_000,
};
const gateway = scriptedGateway();
const { app, db } = useApp({ env: SITE_ENV, models: gateway, agentWorker: false, config: { judge: JUDGE } });

afterEach(async () => {
  vi.restoreAllMocks();
  await closeAllSockets();
  expect(gateway.pending()).toBe(0);
});

const FAST = { source: "site", id: "fast" } as const;
/** A paid model: an owner with no balance cannot pay for a reply on it (`no_quota` as it is admitted). */
const THINKER = { source: "site", id: "thinker" } as const;

interface Agent {
  id: string;
  ownerId: string;
  conversationId: string;
}

interface World {
  owner: Actor;
  member: Actor;
  third: Actor;
  g: string;
}

async function world(): Promise<World> {
  const [owner, member, third] = [await signUp(app, "owner"), await signUp(app, "member"), await signUp(app, "third")];
  return { owner, member, third, g: await group(app, owner, "team", [member, third]) };
}

/** A proactive Agent of `owner` named `handle` (on the site's free model unless `over` says otherwise), added to `conv` by its owner. */
async function agentIn(owner: Actor, handle: string, conv: string, over: Record<string, unknown> = {}): Promise<Agent> {
  const made = await mustCreateAgent(app, owner, { handle, name: handle, model: FAST, persona: "简短地回答。", proactive: true, ...over });
  const added = await api(app, owner, "POST", `/api/conversations/${conv}/members`, { principalId: made.id });
  if (added.status !== 201) throw new Error(`agentIn: ${added.status} ${JSON.stringify(added.json)}`);
  return { id: made.id, ownerId: owner.id, conversationId: made.conversationId };
}

let txn = 0;
const say = async (who: Actor, conv: string, text: string): Promise<number> => {
  const sent = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `pr${++txn}` });
  if (sent.status !== 201) throw new Error(`say: ${sent.status} ${JSON.stringify(sent.json)}`);
  return sent.json.message.seq as number;
};

/** The reply of `agent` nobody asked for, covering message `seq` of `conv`, queued under the group's row and announced. */
async function unasked(agent: Agent, conv: string, seq: number): Promise<Announced> {
  const run = await db.tx(async (t) => {
    await lockConversation(t, conv);
    // Queued by hand, not by a judgement: whose message it answers is not known here (null, the safe side; Task 10b).
    return queueRun(t, agent, conv, seq, "human", { id: null, lane: "proactive" }, null);
  });
  app.agentPort.announce(run);
  return run;
}

/** The Agent's runs in `conv`, oldest first. */
const runsOf = async (agentId: string, conv: string) =>
  (
    await db.query<{ status: string; error: string | null; lane: string }>(
      "select status, error, lane from agent_runs where agent_id = $1 and conversation_id = $2 order by created_at, id",
      [agentId, conv],
    )
  ).rows;

/** What `who` reads of the group's Agents' replies (`GET …/runs`). */
const runsRead = async (who: Actor, conv: string) => (await api(app, who, "GET", `/api/conversations/${conv}/runs`)).json.runs as Array<Record<string, unknown>>;

/** The state the member's socket was told of `agentId` once its reply stopped being one under way. */
const stateAfterReplying = async (s: TestSocket, conv: string, agentId: string) =>
  (await s.next((e) => e.type === "run" && e.conversationId === conv && e.agentId === agentId && e.state !== "replying")).state;

const POINT = 1_000_000;

/** A reply of `agent` nobody asked for, finished today in its own conversation and charged `micro`. */
const paidUnasked = (agent: Agent, micro: number) => paidReply(db, { agentId: agent.id, ownerId: agent.ownerId, conversationId: agent.conversationId, lane: "proactive", micro });

/** The notices of `conv` (every system message), oldest first. */
const noticesOf = async (conv: string) =>
  (await db.query<{ body: Record<string, unknown> }>("select body from messages where conversation_id = $1 and kind = 'system' order by seq", [conv])).rows.map((r) => r.body);

/** What run `id` was charged. */
const chargedFor = async (id: string) =>
  (await db.query<{ charged: string }>("select coalesce(sum(free_micro + balance_micro), 0)::text as charged from usage_records where run_id = $1", [id])).rows[0]!.charged;

describe("a reply nobody asked for that fails", () => {
  it.each([
    ["no_quota, as it is admitted", "no_quota"],
    ["a provider error", "provider_unavailable"],
  ] as const)("%s: its owner is told as of any failure of theirs; the other members are told nothing failed", async (_what, error) => {
    const w = await world();
    const anna = await agentIn(w.owner, "anna", w.g, error === "no_quota" ? { model: THINKER } : {});
    const [ownerS, memberS] = [await connect(app, w.owner), await connect(app, w.member)];
    await unasked(anna, w.g, await say(w.third, w.g, "今晚做什么菜好？"));
    if (error === "provider_unavailable") gateway.fail("provider_unavailable");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(await runsOf(anna.id, w.g)).toEqual([{ status: "failed", error, lane: "proactive" }]);

    const mine = await ownerS.next((e) => e.type === "run" && e.conversationId === w.g && e.run?.status === "failed");
    expect(mine).toMatchObject({ agentId: anna.id, run: { status: "failed", error, retryable: true } });
    expect(await runsRead(w.owner, w.g)).toEqual([{ agentId: anna.id, state: "unavailable", run: expect.objectContaining({ status: "failed", error }) }]);

    expect(await stateAfterReplying(memberS, w.g, anna.id)).toBeNull();
    expect(memberS.events.some((e) => e.type === "run" && e.state === "unavailable")).toBe(false);
    for (const who of [w.member, w.third]) expect(await runsRead(who, w.g)).toEqual([]);
  });

  it("ended by recovery (released as the stale-run sweep or a restart ends it): the same", async () => {
    const w = await world();
    const anna = await agentIn(w.owner, "anna", w.g);
    const memberS = await connect(app, w.member);
    await unasked(anna, w.g, await say(w.third, w.g, "今晚做什么菜好？"));
    const ticket = await app.agentPort.claimNext();
    expect(await app.agentPort.releaseRun(ticket!.id)).toBe(true);
    expect(await runsOf(anna.id, w.g)).toEqual([{ status: "failed", error: "provider_unavailable", lane: "proactive" }]);
    expect(await runsRead(w.owner, w.g)).toEqual([{ agentId: anna.id, state: "unavailable", run: expect.objectContaining({ status: "failed" }) }]);
    expect(await stateAfterReplying(memberS, w.g, anna.id)).toBeNull();
    expect(await runsRead(w.member, w.g)).toEqual([]);
  });

  it("a failed reply someone asked for — a mention, or one that took over an unasked reply — is shown to the members as before", async () => {
    const w = await world();
    const anna = await agentIn(w.owner, "anna", w.g);
    const memberS = await connect(app, w.member);
    // A member's mention folded into the unasked reply while it was queued makes it theirs (lane `others`).
    await unasked(anna, w.g, await say(w.third, w.g, "今晚做什么菜好？"));
    await say(w.member, w.g, "@anna 对，就问你");
    gateway.fail("provider_unavailable");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(await runsOf(anna.id, w.g)).toEqual([{ status: "failed", error: "provider_unavailable", lane: "others" }]);
    expect(await stateAfterReplying(memberS, w.g, anna.id)).toBe("unavailable");
    expect(await runsRead(w.third, w.g)).toEqual([{ agentId: anna.id, state: "unavailable" }]);
  });
});

describe("read again as it is admitted", () => {
  /** The worker takes the next queued run; no model is called. */
  const endsAtAdmission = async () => {
    const calls = gateway.calls.length;
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(gateway.calls.length).toBe(calls);
  };

  it("the owner's number for others' use: of two queued in two groups below it, once others' use has reached it both end at admission — no call, no charge, nobody told", async () => {
    const w = await world();
    const g2 = await group(app, w.member, "second", [w.owner, w.third]);
    const anna = await agentIn(w.owner, "anna", w.g);
    expect((await api(app, w.owner, "PUT", "/api/me/others-limits", { points: "2" })).status).toBe(200);
    expect((await api(app, w.owner, "POST", `/api/conversations/${g2}/members`, { principalId: anna.id })).status).toBe(201);
    await paidUnasked(anna, 2 * POINT - 1);
    const first = await unasked(anna, w.g, await say(w.third, w.g, "问一"));
    const second = await unasked(anna, g2, await say(w.third, g2, "问二"));
    // Used while they wait (nothing is reserved against the number: only what is used counts).
    await paidUnasked(anna, 1);

    const [ownerS, memberS] = [await connect(app, w.owner), await connect(app, w.member)];
    const pushed = vi.spyOn(app.realtime, "pushAgentChanged");
    const notices = await noticesOf(g2);
    await endsAtAdmission();
    expect(await runsOf(anna.id, w.g)).toEqual([{ status: "cancelled", error: null, lane: "proactive" }]);
    expect(await chargedFor(first.run.id)).toBe("0");
    await endsAtAdmission();
    expect(await runsOf(anna.id, g2)).toEqual([{ status: "cancelled", error: null, lane: "proactive" }]);
    expect(await chargedFor(second.run.id)).toBe("0");
    // As any cancelled run of its owner's: its owner is pushed the run, the others the Agent's state, null; no notice.
    expect((await ownerS.next((e) => e.type === "run" && e.conversationId === g2 && e.run?.status === "cancelled")).run).toEqual({
      id: second.run.id,
      status: "cancelled",
      retryable: false,
    });
    expect(await stateAfterReplying(memberS, g2, anna.id)).toBeNull();
    expect(await noticesOf(g2)).toEqual(notices);
    expect(pushed).not.toHaveBeenCalled();
  });

  it("its owner turned proactive replies off meanwhile: it ends there", async () => {
    const w = await world();
    const anna = await agentIn(w.owner, "anna", w.g);
    await unasked(anna, w.g, await say(w.third, w.g, "今晚做什么菜好？"));
    expect((await api(app, w.owner, "PATCH", `/api/agents/${anna.id}`, { proactive: false })).status).toBe(200);
    await endsAtAdmission();
    expect(await runsOf(anna.id, w.g)).toEqual([{ status: "cancelled", error: null, lane: "proactive" }]);
  });

  it("its owner lowered their number for others' use to today's use meanwhile: it ends there", async () => {
    const w = await world();
    const anna = await agentIn(w.owner, "anna", w.g);
    await paidUnasked(anna, 3 * POINT);
    await unasked(anna, w.g, await say(w.third, w.g, "今晚做什么菜好？"));
    expect((await api(app, w.owner, "PUT", "/api/me/others-limits", { points: "3" })).status).toBe(200);
    await endsAtAdmission();
    expect(await runsOf(anna.id, w.g)).toEqual([{ status: "cancelled", error: null, lane: "proactive" }]);
  });

  it("a mention its owner made after the claim, the switch turned off meanwhile, is answered, as the owner's own", async () => {
    const w = await world();
    const anna = await agentIn(w.owner, "anna", w.g);
    const judged = await say(w.third, w.g, "今晚做什么菜好？");
    await unasked(anna, w.g, judged);
    const ticket = await app.agentPort.claimNext();
    expect(ticket?.conversationId).toBe(w.g);
    const asked = await say(w.owner, w.g, "@anna 我也想知道");
    expect((await api(app, w.owner, "PATCH", `/api/agents/${anna.id}`, { proactive: false })).status).toBe(200);
    const calls = gateway.calls.length;
    const end = await app.agentPort.begin(ticket!);
    expect(end).toEqual({ status: "cancelled" });
    await app.agentPort.finish(ticket!, end as RunEnd, null, NOTHING);
    expect(gateway.calls.length).toBe(calls);
    gateway.reply("番茄炒蛋。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(gateway.calls.length).toBe(calls + 1);
    const runs = await db.query("select status, lane, covers_seq::int as covers from agent_runs where agent_id = $1 and conversation_id = $2 order by created_at, id", [
      anna.id,
      w.g,
    ]);
    expect(runs.rows).toEqual([
      { status: "cancelled", lane: "proactive", covers: judged },
      { status: "done", lane: "own", covers: asked },
    ]);
  });
});

describe("a mention noted between its claim and its beginning", () => {
  it("ends the reply nobody asked for there, quietly — no call, no charge — and the mention is answered once, by the follow-up, in its caller's lane", async () => {
    const w = await world();
    const anna = await agentIn(w.owner, "anna", w.g);
    const judged = await say(w.third, w.g, "今晚做什么菜好？");
    await unasked(anna, w.g, judged);
    const ticket = await app.agentPort.claimNext();
    const asked = await say(w.member, w.g, "@anna 对，就问你");
    const calls = gateway.calls.length;
    const end = await app.agentPort.begin(ticket!);
    expect(end).toEqual({ status: "cancelled" });
    await app.agentPort.finish(ticket!, end as RunEnd, null, NOTHING);
    expect(gateway.calls.length).toBe(calls);
    expect(await chargedFor(ticket!.id)).toBe("0");
    gateway.reply("番茄炒蛋。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(gateway.calls.length).toBe(calls + 1);
    const runs = await db.query("select status, lane, caller_id as caller, covers_seq::int as covers from agent_runs where agent_id = $1 and conversation_id = $2 order by created_at, id", [
      anna.id,
      w.g,
    ]);
    expect(runs.rows).toEqual([
      { status: "cancelled", lane: "proactive", caller: null, covers: judged },
      { status: "done", lane: "others", caller: w.member.id, covers: asked },
    ]);
    const replies = await db.query("select count(*)::int as n from messages where conversation_id = $1 and sender_id = $2", [w.g, anna.id]);
    expect(replies.rows[0].n).toBe(1);
  });
});
