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
import type { ReasoningLevel } from "../src/config.ts";
import { othersUseToday } from "../src/metering/others.ts";
import { outputLimit } from "../src/models/resolve.ts";
import type { ModelCall } from "../src/models/gateway.ts";
import { NOTHING } from "../src/agents/runtime/port.ts";
import { api, group, signUp, type Actor } from "./helpers/actors.ts";
import { latestRunId, mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { grant } from "./helpers/metering.ts";
import { scriptedGateway } from "./helpers/models.ts";

/**
 * Whose reply a run is (limits redesign, Part 2: one identity per reply): its lane and caller are written ONCE, as the call that makes
 * its row is accepted, and nothing changes them — a member's call never rides the owner's terms, an owner's call is never made or
 * counted as others' because a member asked at the same time (they are two replies), and a refusal only takes a call out. What
 * stays checked at admission is the plan: the calls of its assignment still to answer and the Agent's settings it was made with
 * (model, level, web search) — a change meanwhile makes the plan again, with no call and no hold. Through the real routes, the real
 * port, a scripted gateway.
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
  hold: string;
  reasoning: string | null;
}
const runs = async (agentId: string, conv: string): Promise<RunView[]> =>
  (
    await db.query<RunView>(
      `select id, status, error, lane, caller_id as caller, call_seqs::int[] as calls, hold_micro::text as hold, reasoning
         from agent_runs where agent_id = $1 and conversation_id = $2 order by created_at, id`,
      [agentId, conv],
    )
  ).rows;
const latest = async (agentId: string, conv: string): Promise<RunView> => (await runs(agentId, conv)).at(-1)!;
const posted = async (agentId: string, conv: string) =>
  (await db.query<{ text: string }>("select body ->> 'text' as text from messages where conversation_id = $1 and sender_id = $2 and kind = 'text' order by seq", [conv, agentId])).rows.map((r) => r.text);
/** Whether others' use of `owner`'s Agents today counts a reply for others (its charge, lane others). */
const countedForOthers = async (owner: Actor) => (await othersUseToday(db, app.deps.config, owner.id, new Date(), "others")) > 0n;
/** The output limit of the site model `thinker` at `level`: what a reply is made at, the owner's own or one for others alike. */
const limitAt = (level: ReasoningLevel) => {
  const thinker = app.deps.config.siteModels.find((m) => m.id === THINKER.id)!;
  return outputLimit(thinker.maxOutputTokens, thinker.contextTokens, level, app.deps.config.reasoningAllowanceTokens);
};

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
/** The run claimed and begun by hand: the call it is made with, and the row as admitted. */
const begun = async (w: World) => {
  const ticket = (await app.agentPort.claimNext())!;
  const prepared = await app.agentPort.begin(ticket);
  expect("call" in prepared).toBe(true);
  return { ticket, call: (prepared as unknown as { call: ModelCall }).call, admitted: await latest(w.agent.id as string, w.g) };
};

describe("each reply on its own identity's terms", () => {
  it("the owner's @ and a member's @ together: two replies — the owner's own at the owner's level, not counted; the member's at the level for others, its hold taken, counted", async () => {
    const w = await world();
    const own = await say(w.owner, w.g, `${w.at} OWNER-ASK 在吗？`);
    const member = await say(w.mia, w.g, `${w.at} MIA-ASK 我也问一句`);
    const toOwner = await begun(w);
    expect([toOwner.call.reasoning, toOwner.call.maxOutputTokens]).toEqual(["medium", limitAt("medium")]);
    expect(toOwner.admitted).toMatchObject({ status: "running", lane: "own", caller: w.owner.id, calls: [own], reasoning: "medium" });
    await app.agentPort.finish(toOwner.ticket, { status: "done" }, null, NOTHING);
    expect(await countedForOthers(w.owner)).toBe(false);
    const toMia = await begun(w);
    expect([toMia.call.reasoning, toMia.call.maxOutputTokens]).toEqual(["low", limitAt("low")]);
    expect(toMia.admitted).toMatchObject({ status: "running", lane: "others", caller: w.mia.id, calls: [member], reasoning: "low" });
    expect(BigInt(toMia.admitted.hold) > 0n).toBe(true);
    await app.agentPort.releaseRun(toMia.ticket.id);
  });

  it("the owner's calls only (two of them, folded): one reply, the owner's own — at the owner's level, not counted", async () => {
    const w = await world();
    const one = await say(w.owner, w.g, `${w.at} OWNER-ASK 在吗？`);
    const two = await say(w.owner, w.g, `${w.at} OWNER-ASK 还有一件事`);
    expect(await latest(w.agent.id as string, w.g)).toMatchObject({ status: "queued", lane: "own", caller: w.owner.id, calls: [one, two] });
    const { ticket, call, admitted } = await begun(w);
    expect(call.reasoning).toBe("medium");
    expect(admitted).toMatchObject({ lane: "own", caller: w.owner.id });
    expect(await countedForOthers(w.owner)).toBe(false);
    await app.agentPort.releaseRun(ticket.id);
  });

  it("the owner's 重试 of a member's failed call (the one deliberate exception): the owner's own — at the owner's level, not counted", async () => {
    const w = await world();
    const member = await say(w.mia, w.g, `${w.at} MIA-ASK 在吗？`);
    await db.query("update agent_runs set status = 'failed', error = 'busy', finished_at = now() where agent_id = $1 and status = 'queued'", [w.agent.id]);
    expect((await api(app, w.owner, "POST", `/api/conversations/${w.g}/runs/retry`, { runId: await latestRunId(db, w.g, w.agent.id) })).status).toBe(201);
    expect(await latest(w.agent.id as string, w.g)).toMatchObject({ status: "queued", lane: "own", caller: w.owner.id, calls: [member] });
    const { ticket, call, admitted } = await begun(w);
    expect(call.reasoning).toBe("medium");
    expect(call.maxOutputTokens).toBe(limitAt("medium"));
    expect(admitted).toMatchObject({ lane: "own", caller: w.owner.id, calls: [member] });
    expect(await countedForOthers(w.owner)).toBe(false);
    await app.agentPort.releaseRun(ticket.id);
  });
});

describe("a reply nobody asked for is never a call's", () => {
  it("queued on the owner's message; a member then calls (it waits) and is blocked before anything begins: no model request, no hold, no reply — and nothing on the owner's terms", async () => {
    const w = await world();
    const seed = await say(w.owner, w.g, "今晚谁做饭？");
    await queueUnasked(w, seed, w.owner);
    await say(w.mia, w.g, `${w.at} MIA-ASK 你来定`);
    expect(await latest(w.agent.id as string, w.g)).toMatchObject({ status: "queued", lane: "proactive", caller: null });
    await block(w.owner, w.mia);

    while (await app.agentWorker.runOnce());
    expect(callsHere()).toEqual([]);
    expect(await runs(w.agent.id as string, w.g)).toMatchObject([{ status: "cancelled", error: null, lane: "proactive", hold: "0" }]);
    expect(await posted(w.agent.id as string, w.g)).toEqual([]);
    expect((await db.query("select 1 from agent_runs where agent_id = $1 and (lane = 'own' or source is not null)", [w.agent.id])).rowCount).toBe(0);
  });

  it("the same with two members' calls, one blocked: the other is answered as a reply for others — at the level for others, counted in others' use of the owner's Agents", async () => {
    const w = await world();
    const seed = await say(w.owner, w.g, "今晚谁做饭？");
    await queueUnasked(w, seed, w.owner);
    await say(w.mia, w.g, `${w.at} MIA-ASK 你来定`);
    const kept = await say(w.ned, w.g, `${w.at} NED-ASK 我也想知道`);
    await block(w.owner, w.mia);

    gateway.reply("（回答 ned）");
    while (await app.agentWorker.runOnce());
    const done = await runs(w.agent.id as string, w.g);
    expect(done.map((r) => [r.status, r.lane])).toEqual([
      ["cancelled", "proactive"],
      ["done", "others"],
    ]);
    expect(done[1]).toMatchObject({ caller: w.ned.id, calls: [kept], reasoning: "low" });
    const call = callsHere()[0]!;
    expect([call.reasoning, call.maxOutputTokens]).toEqual(["low", limitAt("low")]);
    expect(await countedForOthers(w.owner)).toBe(true);
  });
});

describe("the plan is the row's and the Agent's at admission; once admitted, the terms are frozen", () => {
  it("the Agent's level for others changed while the member's reply's attachments are read: the plan is made again — no call, no hold — and the one request is made at the new level", async () => {
    const w = await world();
    const member = await say(w.mia, w.g, `${w.at} MIA-ASK 在吗？`);
    between.run = async () => {
      expect((await api(app, w.owner, "PATCH", `/api/agents/${w.agent.id}`, { othersReasoning: "medium" })).status).toBe(200);
    };
    gateway.reply("（回答 mia）");
    while (await app.agentWorker.runOnce());
    expect(callsHere().map((c) => [c.reasoning, c.maxOutputTokens])).toEqual([["medium", limitAt("medium")]]);
    expect(await latest(w.agent.id as string, w.g)).toMatchObject({ status: "done", lane: "others", caller: w.mia.id, calls: [member], reasoning: "medium" });
  });

  it("one call of the assignment refused by a limit while its attachments are read: taken out (C-b), the plan made again for the call left — its lane and caller as they were", async () => {
    const w = await world();
    const one = await say(w.mia, w.g, `${w.at} MIA-ASK 一`);
    const two = await say(w.mia, w.g, `${w.at} MIA-ASK 二`);
    between.run = async () => {
      await db.query("insert into call_refusals (conversation_id, seq, agent_id, sender_id, reason) values ($1, $2, $3, $4, 'too_often')", [w.g, one, w.agent.id, w.mia.id]);
    };
    gateway.reply("（回答第二问）");
    while (await app.agentWorker.runOnce());
    expect(callsHere()).toHaveLength(1);
    expect(await latest(w.agent.id as string, w.g)).toMatchObject({ status: "done", lane: "others", caller: w.mia.id, calls: [two] });
    expect(await posted(w.agent.id as string, w.g)).toEqual(["（回答第二问）"]);
  });

  it("AFTER admission: the member is blocked once their reply holds its money — it is not requeued, its lane and caller stay, and its usage settles however it ends", async () => {
    const w = await world();
    const member = await say(w.mia, w.g, `${w.at} MIA-ASK 在吗？`);
    const { ticket, admitted } = await begun(w);
    expect(admitted).toMatchObject({ status: "running", lane: "others", caller: w.mia.id, calls: [member], reasoning: "low" });
    expect(BigInt(admitted.hold) > 0n).toBe(true);
    await block(w.owner, w.mia);
    const after = await latest(w.agent.id as string, w.g);
    expect(after).toMatchObject({ id: ticket.id, status: "running", lane: "others", caller: w.mia.id, hold: admitted.hold });
    expect((await db.query("select 1 from agent_runs where agent_id = $1 and conversation_id = $2", [w.agent.id, w.g])).rowCount).toBe(1);
    await app.agentPort.releaseRun(ticket.id);
    expect((await db.query("select 1 from usage_records where run_id = $1", [ticket.id])).rowCount).toBe(1);
    expect(await latest(w.agent.id as string, w.g)).toMatchObject({ id: ticket.id, lane: "others", caller: w.mia.id });
  });
});
