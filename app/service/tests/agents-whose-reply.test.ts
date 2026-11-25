import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** What a test asks to happen while a reply's attachments are read (step 2 of `begin`: outside any transaction). */
const between: { run: (() => Promise<void>) | null } = { run: null };
vi.mock("../src/agents/context.ts", async (original) => {
  const real = await original<typeof import("../src/agents/context.ts")>();
  return {
    ...real,
    buildContext: async (...args: Parameters<typeof real.buildContext>) => {
      const run = between.run;
      between.run = null;
      if (run) await run();
      return real.buildContext(...args);
    },
  };
});

import { queueRun } from "../src/agents/runs.ts";
import { lockConversation } from "../src/conversations/store.ts";
import type { ModelCall } from "../src/models/gateway.ts";
import { NOTHING } from "../src/agents/runtime/port.ts";
import { api, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { grant, paidReply } from "./helpers/metering.ts";
import { scriptedGateway } from "./helpers/models.ts";

/**
 * Fix round 4, R1 to R3: whose reply a run is, is WRITTEN when each call is accepted (`agent_runs.owner_call_seqs`, `owner_retry`) and
 * never read back from who wrote a message; one function decides the lane from it (agents/runs.ts `laneOf`); and the terms a reply is
 * made on (model level, bounds, tool caps, the hold) are the terms of the row as it is at admission, under its locks — a plan
 * prepared for another lane makes no call and takes no hold. Through the real routes, the real port, a scripted gateway.
 */

const gateway = scriptedGateway();
const { app, db } = useApp({ env: SITE_ENV, models: gateway, agentWorker: false });

let first = 0;
beforeEach(() => {
  first = gateway.calls.length;
  between.run = null;
});
afterEach(() => {
  expect(gateway.pending()).toBe(0);
});

const THINKER = { source: "site", id: "thinker" } as const;
let txn = 0;
const say = async (who: Actor, conv: string, text: string): Promise<number> => {
  const sent = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `wr${++txn}` });
  if (sent.status !== 201) throw new Error(`say: ${sent.status} ${JSON.stringify(sent.json)}`);
  return sent.json.message.seq as number;
};
const block = async (by: Actor, whom: Actor): Promise<void> => {
  expect((await api(app, by, "PUT", `/api/blocks/${whom.id}`)).status).toBe(200);
};
const callsHere = (): ModelCall[] => gateway.calls.slice(first);

interface RunView {
  id: string;
  status: string;
  error: string | null;
  lane: string;
  caller: string | null;
  calls: number[] | null;
  owner_calls: number[];
  hold: string;
  reasoning: string | null;
}
const latest = async (agentId: string, conv: string): Promise<RunView> =>
  (
    await db.query<RunView>(
      `select id, status, error, lane, caller_id as caller, call_seqs::int[] as calls, owner_call_seqs::int[] as owner_calls, hold_micro::text as hold, reasoning
         from agent_runs where agent_id = $1 and conversation_id = $2 order by created_at desc, id desc limit 1`,
      [agentId, conv],
    )
  ).rows[0]!;
const posted = async (agentId: string, conv: string) =>
  (await db.query<{ text: string }>("select body ->> 'text' as text from messages where conversation_id = $1 and sender_id = $2 and kind = 'text' order by seq", [conv, agentId])).rows.map((r) => r.text);
const answersForOthers = async (owner: Actor) => (await api(app, owner, "GET", "/api/me/others-use")).json.used.answers as number;
const othersLimit = () => app.deps.config.others.outputTokens;
const allowance = () => app.deps.config.reasoningAllowanceTokens;

let n = 0;
/** A group of an owner (with points), mia and ned, with the owner's Agent: it thinks `medium` for its owner and `low` for others. */
async function world() {
  const tag = `${++n}${Math.floor(Math.random() * 1e6)}`;
  const [owner, mia, ned] = [await signUp(app, `wo${tag}`), await signUp(app, `wm${tag}`), await signUp(app, `wn${tag}`)];
  await grant(db, owner.id, 5_000n * 1_000_000n);
  const g = await group(app, owner, "楼里的群", [mia, ned]);
  const agent = await mustCreateAgent(app, owner, { handle: `helper${tag}`, name: "小助手", model: THINKER, reasoning: "medium", othersReasoning: "low", persona: "你是小助手，说话简短。" });
  expect((await api(app, owner, "POST", `/api/conversations/${g}/members`, { principalId: agent.id })).status).toBe(201);
  const at = `@helper${tag}`;
  return { owner, mia, ned, g, agent, at, tag };
}
type World = Awaited<ReturnType<typeof world>>;
/** A reply nobody asked for, queued on the message at `seq` as the judgement would queue it (agents/proactive/decide.ts). */
const queueUnasked = (w: World, seq: number, sender: Actor) =>
  db.tx(async (t) => {
    await lockConversation(t, w.g);
    await queueRun(t, { id: w.agent.id as string, ownerId: w.owner.id }, w.g, seq, "human", { id: null, lane: "proactive" }, [sender.id]);
  });
/** mia's Agent in the group relays the owner's words to the Agent: the owner's own call, through somebody else's Agent. */
async function ownerBackedRelay(w: World): Promise<number> {
  const theirs = await mustCreateAgent(app, w.mia, { handle: `miabot${w.tag}`, name: "米娅的助手", model: { source: "site", id: "fast" }, persona: "你是米娅的助手。" });
  expect((await api(app, w.mia, "POST", `/api/conversations/${w.g}/members`, { principalId: theirs.id })).status).toBe(201);
  await say(w.owner, w.g, `@miabot${w.tag} 帮我问问小助手`);
  gateway.reply(`${w.at} RELAY 主人让我问你`);
  expect(await app.agentWorker.runOnce()).toBe(true);
  const run = await latest(w.agent.id as string, w.g);
  expect(run).toMatchObject({ status: "queued", lane: "own", caller: w.owner.id });
  expect(run.owner_calls).toEqual(run.calls);
  return run.calls![0]!;
}

describe("R1: a call is the owner's own only when it was accepted as one", () => {
  it("the owner's @ and an owner-backed relay are written as owner calls; a member's call and the message a reply nobody asked for was queued on are not", async () => {
    const w = await world();
    const member = await say(w.mia, w.g, `${w.at} 在吗？`);
    expect(await latest(w.agent.id as string, w.g)).toMatchObject({ lane: "others", caller: w.mia.id, calls: [member], owner_calls: [] });
    const own = await say(w.owner, w.g, `${w.at} 我也问一句`);
    expect(await latest(w.agent.id as string, w.g)).toMatchObject({ lane: "own", caller: w.owner.id, calls: [member, own], owner_calls: [own] });
    await db.query("update agent_runs set status = 'cancelled', finished_at = now() where agent_id = $1 and status = 'queued'", [w.agent.id]);
    const seed = await say(w.owner, w.g, "今晚谁做饭？");
    await queueUnasked(w, seed, w.owner);
    expect(await latest(w.agent.id as string, w.g)).toMatchObject({ lane: "proactive", caller: null, owner_calls: [] });
    await db.query("update agent_runs set status = 'cancelled', finished_at = now() where agent_id = $1 and status = 'queued'", [w.agent.id]);
  });

  it("the owner wrote the message a reply nobody asked for was queued on; a member then calls and is refused before it begins: no model request, no hold, no reply, never the owner's own", async () => {
    const w = await world();
    const seed = await say(w.owner, w.g, "今晚谁做饭？");
    await queueUnasked(w, seed, w.owner);
    const call = await say(w.mia, w.g, `${w.at} MIA-ASK 你来定`);
    // The member's call took the unasked reply over: it is hers, and the owner's message is no call of anyone.
    expect(await latest(w.agent.id as string, w.g)).toMatchObject({ status: "queued", lane: "others", caller: w.mia.id, calls: [call], owner_calls: [] });
    await block(w.owner, w.mia);

    while (await app.agentWorker.runOnce());
    expect(callsHere()).toEqual([]);
    const run = await latest(w.agent.id as string, w.g);
    expect(run).toMatchObject({ status: "cancelled", error: null, hold: "0" });
    expect(run.lane).not.toBe("own");
    expect(await posted(w.agent.id as string, w.g)).toEqual([]);
    expect((await db.query("select 1 from agent_runs where agent_id = $1 and (lane = 'own' or source is not null)", [w.agent.id])).rowCount).toBe(0);
  });

  it("the same with two members' calls, one refused: the other is answered as a reply for others — bounded, at the level for others, counted against the owner's numbers", async () => {
    const w = await world();
    const seed = await say(w.owner, w.g, "今晚谁做饭？");
    await queueUnasked(w, seed, w.owner);
    const dropped = await say(w.mia, w.g, `${w.at} MIA-ASK 你来定`);
    const kept = await say(w.ned, w.g, `${w.at} NED-ASK 我也想知道`);
    expect(await latest(w.agent.id as string, w.g)).toMatchObject({ status: "queued", lane: "others", caller: w.mia.id, calls: [dropped, kept], owner_calls: [] });
    await block(w.owner, w.mia);

    gateway.reply("（回答 ned）");
    expect(await app.agentWorker.runOnce()).toBe(true);
    const run = await latest(w.agent.id as string, w.g);
    expect(run).toMatchObject({ status: "done", error: null, lane: "others", caller: w.ned.id, calls: [kept], reasoning: "low" });
    const call = callsHere()[0]!;
    expect([call.reasoning, call.maxOutputTokens]).toEqual(["low", othersLimit() + allowance().low]);
    expect(await answersForOthers(w.owner)).toBe(1);
  });

  it("a follow-up is the owner's own only for an owner call noted on the reply before it; the owner's ordinary message in between makes it nobody's", async () => {
    const w = await world();
    await say(w.mia, w.g, `${w.at} MIA-ASK 在吗？`);
    const ticket = (await app.agentPort.claimNext())!;
    await say(w.owner, w.g, "我先说一句别的（没有叫它）");
    const noted = await say(w.ned, w.g, `${w.at} NED-ASK 还有我`);
    await app.agentPort.finish(ticket, { status: "done" }, null, NOTHING);
    expect(await latest(w.agent.id as string, w.g)).toMatchObject({ status: "queued", lane: "others", caller: w.ned.id, calls: [noted], owner_calls: [] });
    await db.query("update agent_runs set status = 'cancelled', finished_at = now() where agent_id = $1 and status = 'queued'", [w.agent.id]);
  });
});

describe("R2: the round-3 rules hold by what is written", () => {
  it("the owner's 重试 of a reply that held an owner-backed relay and a member's call, the relay refused since: it stays the owner's own for the member's call (its 重试, not whose calls are left)", async () => {
    const w = await world();
    const relay = await ownerBackedRelay(w);
    const kept = await say(w.ned, w.g, `${w.at} NED-ASK 我也问一句`);
    await db.query("update agent_runs set status = 'failed', error = 'busy', finished_at = now() where agent_id = $1 and status = 'queued'", [w.agent.id]);
    expect((await api(app, w.owner, "POST", `/api/conversations/${w.g}/runs/retry`, { agentId: w.agent.id })).status).toBe(201);
    expect(await latest(w.agent.id as string, w.g)).toMatchObject({ status: "queued", lane: "own", caller: w.owner.id, calls: [relay, kept], owner_calls: [relay] });
    await block(w.owner, w.mia);

    const before = callsHere().length;
    gateway.reply("（回答 ned）");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(await latest(w.agent.id as string, w.g)).toMatchObject({ status: "done", lane: "own", caller: w.owner.id, calls: [kept], owner_calls: [] });
    const call = callsHere()[before]!;
    expect(call.reasoning).toBe("medium");
    expect(call.maxOutputTokens).toBeGreaterThan(othersLimit() + allowance().medium);
    expect(await answersForOthers(w.owner)).toBe(0);
  });

  it("the owner's call noted on a member's reply while it runs: the reply stays the member's, and its follow-up is the owner's own for that call", async () => {
    const w = await world();
    const member = await say(w.mia, w.g, `${w.at} MIA-ASK 在吗？`);
    const ticket = (await app.agentPort.claimNext())!;
    const own = await say(w.owner, w.g, `${w.at} OWNER-ASK 我也问一句`);
    expect(await latest(w.agent.id as string, w.g)).toMatchObject({ status: "running", lane: "others", caller: w.mia.id, calls: [member, own], owner_calls: [own] });
    await app.agentPort.finish(ticket, { status: "done" }, null, NOTHING);
    const next = await latest(w.agent.id as string, w.g);
    expect(next.id).not.toBe(ticket.id);
    expect(next).toMatchObject({ status: "queued", lane: "own", caller: w.owner.id, calls: [own], owner_calls: [own] });
    await db.query("update agent_runs set status = 'cancelled', finished_at = now() where agent_id = $1 and status = 'queued'", [w.agent.id]);
  });
});

describe("R3: the terms of a reply are those of its row at admission", () => {
  it("an owner-backed relay and a member's call in one reply, the relay refused while its attachments are read: the plan made for the owner makes no call and takes no hold; it is admitted as the member's, level, limit, hold and count agreeing", async () => {
    const w = await world();
    const relay = await ownerBackedRelay(w);
    const kept = await say(w.ned, w.g, `${w.at} NED-ASK 我也问一句`);
    expect(await latest(w.agent.id as string, w.g)).toMatchObject({ status: "queued", lane: "own", caller: w.owner.id, calls: [relay, kept], owner_calls: [relay] });

    const seen: Array<{ lane: string; hold: string }> = [];
    between.run = async () => {
      // Prepared as the owner's own; now the owner blocks the relaying Agent's owner.
      const before = await latest(w.agent.id as string, w.g);
      seen.push({ lane: before.lane, hold: before.hold });
      await block(w.owner, w.mia);
    };
    const before = callsHere().length;
    gateway.reply("（回答 ned）");
    while (await app.agentWorker.runOnce());
    expect(seen).toEqual([{ lane: "own", hold: "0" }]);
    // One request, and it is the one for others: never the plan prepared at the owner's level.
    const made = callsHere().slice(before);
    expect(made.map((c) => [c.reasoning, c.maxOutputTokens])).toEqual([["low", othersLimit() + allowance().low]]);
    const run = await latest(w.agent.id as string, w.g);
    expect(run).toMatchObject({ status: "done", error: null, lane: "others", caller: w.ned.id, calls: [kept], reasoning: "low", hold: "0" });
    expect(await answersForOthers(w.owner)).toBe(1);
    // What was charged is within what a reply for others may hold: its output limit at the level for others.
    const charged = BigInt((await db.query<{ n: string }>("select coalesce(sum(free_micro + balance_micro), 0)::text as n from usage_records where run_id = $1", [run.id])).rows[0]!.n);
    expect(charged > 0n).toBe(true);
  });

  it("the same with the owner's numbers for others used up: it ends quietly at the cap — no call, no hold, nothing posted", async () => {
    const w = await world();
    const relay = await ownerBackedRelay(w);
    const kept = await say(w.ned, w.g, `${w.at} NED-ASK 我也问一句`);
    expect(await latest(w.agent.id as string, w.g)).toMatchObject({ lane: "own", calls: [relay, kept] });
    between.run = async () => {
      await block(w.owner, w.mia);
      // All of the owner's points a day for others are used by another reply for others, settled now.
      await paidReply(db, { agentId: w.agent.id as string, ownerId: w.owner.id, conversationId: w.agent.conversationId as string, lane: "others", micro: 300n * 1_000_000n, at: new Date() });
    };
    const before = callsHere().length;
    while (await app.agentWorker.runOnce());
    expect(callsHere().slice(before)).toEqual([]);
    const run = await latest(w.agent.id as string, w.g);
    expect(run).toMatchObject({ status: "cancelled", error: null, lane: "others", hold: "0" });
    expect(await posted(w.agent.id as string, w.g)).toEqual([]);
  });

  it("AFTER admission the terms are frozen: the relay's person is blocked once the owner's reply holds its money — it is not requeued, its lane and caller stay, and it goes on for the member's call", async () => {
    const w = await world();
    const relay = await ownerBackedRelay(w);
    const kept = await say(w.ned, w.g, `${w.at} NED-ASK 我也问一句`);
    const ticket = (await app.agentPort.claimNext())!;
    const prepared = await app.agentPort.begin(ticket);
    expect("call" in prepared).toBe(true);
    const admitted = await latest(w.agent.id as string, w.g);
    expect(admitted).toMatchObject({ status: "running", lane: "own", caller: w.owner.id, calls: [relay, kept], reasoning: "medium" });
    expect(BigInt(admitted.hold) > 0n).toBe(true);
    await block(w.owner, w.mia);
    const after = await latest(w.agent.id as string, w.g);
    expect(after).toMatchObject({ id: ticket.id, status: "running", lane: "own", caller: w.owner.id, hold: admitted.hold });
    expect((await db.query("select 1 from agent_runs where agent_id = $1 and conversation_id = $2", [w.agent.id, w.g])).rowCount).toBe(1);
    await app.agentPort.releaseRun(ticket.id);
  });

  it("a fourth reply that became a reply for others after its claim is not started over the owner's three at a time: it waits, and starts when one of them ends", async () => {
    const w = await world();
    // Three replies for others of this owner under way, in three other groups.
    const tickets = [];
    for (let i = 0; i < app.deps.config.agentMaxConcurrentOthersRuns; i += 1) {
      const other = await group(app, w.owner, `别的群${i}`, [w.mia, w.ned]);
      expect((await api(app, w.owner, "POST", `/api/conversations/${other}/members`, { principalId: w.agent.id })).status).toBe(201);
      await say(w.ned, other, `${w.at} 第 ${i} 个`);
      tickets.push((await app.agentPort.claimNext())!);
    }
    expect(tickets.every((t) => t !== null)).toBe(true);
    const relay = await ownerBackedRelay(w);
    const kept = await say(w.ned, w.g, `${w.at} NED-ASK 我也问一句`);
    expect(await latest(w.agent.id as string, w.g)).toMatchObject({ status: "queued", lane: "own", calls: [relay, kept] });
    await block(w.owner, w.mia);

    // Claimed as the owner's own (the fourth of four), it is the member's as it begins: over three for others, so not begun.
    const before = callsHere().length;
    gateway.reply("（回答 ned）");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(callsHere().slice(before)).toEqual([]);
    expect(await latest(w.agent.id as string, w.g)).toMatchObject({ status: "queued", lane: "others", caller: w.ned.id, calls: [kept], hold: "0" });
    // Not claimed while three are under way.
    expect(await app.agentPort.claimNext()).toBeNull();
    await app.agentPort.releaseRun(tickets[0]!.id);
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(callsHere().slice(before).map((c) => c.reasoning)).toEqual(["low"]);
    expect(await latest(w.agent.id as string, w.g)).toMatchObject({ status: "done", lane: "others", caller: w.ned.id });
    for (const t of tickets.slice(1)) await app.agentPort.releaseRun(t.id);
  });
});
