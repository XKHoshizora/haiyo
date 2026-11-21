import { afterEach, describe, expect, it } from "vitest";
import { createAgentPort, type DbAgentPort, type Toolbox } from "../src/agents/port-impl.ts";
import type { RunScope } from "../src/agents/tools/index.ts";
import { CONTINUE_TURN } from "../src/agents/runtime/context.ts";
import { createAgentWorker, type AgentWorker } from "../src/agents/runtime/worker.ts";
import type { ToolSpec } from "../src/models/gateway.ts";
import { api, befriend, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedGateway, type ScriptedGateway } from "./helpers/models.ts";
import { UNSPOKEN } from "../src/memory/review.ts";
import { closeAllSockets, connect, type Push } from "./helpers/ws.ts";

/**
 * "先应一声、再交付" (the product owner's design of 2026-11-20): text a reply's model writes before it calls a tool, in the
 * same turn, is posted at once as a message of its own — an acknowledgement — and the answer is a later message. On the
 * real port, hub and database, with a toolbox the test gives the port (its tool runs when the test says).
 */

const gateway = scriptedGateway();
const { app, db } = useApp({ env: SITE_ENV, models: gateway, agentWorker: false });

afterEach(async () => {
  await closeAllSockets();
  expect(gateway.pending()).toBe(0);
});

const FAST = { source: "site", id: "fast" } as const;
const SEARCH: ToolSpec = {
  name: "search",
  description: "Search this conversation's messages.",
  parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
};

/** What runs while the tool runs (default nothing), with the run's scope. */
let duringTool: (scope: RunScope) => Promise<void> = async () => {};
const toolbox: Toolbox = {
  offer: () => ({ tools: [SEARCH], perTool: { search: 6 }, kinds: { search: "search" } }),
  run: async (scope) => {
    await duringTool(scope);
    return { output: { hits: [] } };
  },
};
function toolWorker(models: ScriptedGateway = gateway): { port: DbAgentPort; worker: AgentWorker } {
  const { db: pool, blobs, conversations, reads, config } = app.deps;
  const port = createAgentPort({ db: pool, config, blobs, realtime: app.realtime, conversations, reads, log: app.log, toolbox, drawTag: () => "k7q2" });
  return { port, worker: createAgentWorker({ port, models, runTimeoutMs: config.agentRunTimeoutMs, maxRunsInFlight: 1, background: false, log: app.log, tools: config.tools }) };
}

let txn = 0;
const say = async (who: Actor, conv: string, text: string): Promise<number> => {
  const sent = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `ta${++txn}` });
  if (sent.status !== 201) throw new Error(`say: ${sent.status} ${JSON.stringify(sent.json)}`);
  return sent.json.message.seq as number;
};
const messages = async (conv: string) =>
  (
    await db.query<{ seq: string; sender_id: string; body: Record<string, unknown>; client_txn: string | null }>(
      "select seq::text, sender_id, body, client_txn from messages where conversation_id = $1 and kind <> 'system' order by seq",
      [conv],
    )
  ).rows.map((r) => ({ seq: Number(r.seq), sender: r.sender_id, body: r.body, txn: r.client_txn }));
const lastRun = async (agentId: string, conv: string) =>
  (await db.query<{ id: string; status: string }>("select id, status from agent_runs where agent_id = $1 and conversation_id = $2 order by created_at desc limit 1", [agentId, conv])).rows[0]!;

afterEach(() => {
  duringTool = async () => {};
});

async function owned(name = "olive") {
  const owner = await signUp(app, name);
  const agent = await mustCreateAgent(app, owner, { handle: `${name}_bot`, name: "小助手", model: FAST, persona: "简短地回答。" });
  return { owner, agent, own: agent.conversationId as string };
}

describe("an acknowledgement, then the answer", () => {
  it("text before a tool call is posted at once, before the tool runs, as its own message; the answer follows as another, in order with the reply's pushes", async () => {
    const { owner, agent, own } = await owned();
    const socket = await connect(app, owner);
    const askSeq = await say(owner, own, "上次说的川菜馆叫什么？");
    let atTool: Array<{ seq: number; body: Record<string, unknown> }> = [];
    duringTool = async () => {
      atTool = (await messages(own)).filter((m) => m.sender === agent.id).map(({ seq, body }) => ({ seq, body }));
    };
    gateway.callTools([{ name: "search", input: { query: "川菜馆" } }], { text: "我先查一下。", reasoning: "要查一下记录。" }).reply("叫蜀香。", { reasoning: "找到了。" });
    expect(await toolWorker().worker.runOnce()).toBe(true);
    const runId = (await lastRun(agent.id, own)).id;
    await socket.waitFor((e) => e.type === "run" && e.conversationId === own && e.run?.status === "done");

    // When the tool ran, the acknowledgement was there already, and nothing else of the reply.
    expect(atTool).toEqual([{ seq: askSeq + 1, body: { text: "我先查一下。", reasoning: "要查一下记录。", ack: true } }]);
    const mine = (await messages(own)).filter((m) => m.sender === agent.id);
    expect(mine).toEqual([
      { seq: askSeq + 1, sender: agent.id, body: { text: "我先查一下。", reasoning: "要查一下记录。", ack: true }, txn: `ack:${runId}` },
      { seq: askSeq + 2, sender: agent.id, body: { text: "叫蜀香。", reasoning: "找到了。", lookups: { search: 1 } }, txn: runId },
    ]);
    // Pushed in order: the acknowledgement, what the tool did, the answer, then the end of the one run.
    const at = (pred: (e: Push) => boolean) => socket.events.findIndex(pred);
    const ack = at((e) => e.type === "message" && e.message.seq === askSeq + 1);
    const searching = at((e) => e.type === "run" && e.activity === "search");
    const answer = at((e) => e.type === "message" && e.message.seq === askSeq + 2);
    const done = at((e) => e.type === "run" && e.run?.status === "done");
    expect(ack).toBeGreaterThanOrEqual(0);
    expect([ack < searching, searching < answer, answer < done]).toEqual([true, true, true]);
    // The acknowledgement says it is one; what the run used and cost goes with the answer only.
    const read = async (seq: number) => (await api(app, owner, "GET", `/api/conversations/${own}/messages/${seq}`)).json.message;
    const [ackWire, answerWire] = [await read(askSeq + 1), await read(askSeq + 2)];
    expect(ackWire.ack).toBe(true);
    expect(ackWire).not.toHaveProperty("via");
    expect(answerWire).not.toHaveProperty("ack");
    expect(answerWire.via).toBeDefined();
    // One run, done, settled once.
    expect((await db.query("select 1 from usage_records where run_id = $1", [runId])).rowCount).toBe(1);

    // The next reply is shown both, in order, as what the Agent said.
    await say(owner, own, "谢谢");
    gateway.reply("不客气。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    const turns = gateway.calls.at(-1)!.messages;
    expect(turns.map((t) => [t.role, t.parts.map((p) => (p.type === "text" ? p.text : p.type))])).toEqual([
      ["user", ["上次说的川菜馆叫什么？"]],
      ["assistant", ["我先查一下。", "叫蜀香。"]],
      ["user", ["谢谢"]],
    ]);
  });

  it("no tool call, no acknowledgement; and text that shows nothing before a call posts none", async () => {
    const { owner, agent, own } = await owned();
    await say(owner, own, "你好");
    gateway.reply("你好！");
    expect(await toolWorker().worker.runOnce()).toBe(true);
    await say(owner, own, "查一下");
    gateway.callTools([{ name: "search", input: { query: "x" } }], { text: "  \n " }).reply("没有。");
    expect(await toolWorker().worker.runOnce()).toBe(true);
    const mine = (await messages(own)).filter((m) => m.sender === agent.id).map((m) => m.body);
    expect(mine).toEqual([{ text: "你好！" }, { text: "没有。", lookups: { search: 1 } }]);
  });

  it("at most one per reply: a later round's text before its call is part of the answer", async () => {
    const { owner, agent, own } = await owned();
    await say(owner, own, "查两样");
    gateway
      .callTools([{ name: "search", input: { query: "a" } }], { text: "我先查一下。" })
      .callTools([{ name: "search", input: { query: "b" } }], { text: "再看看另一个。" })
      .reply("都查到了。");
    expect(await toolWorker().worker.runOnce()).toBe(true);
    const mine = (await messages(own)).filter((m) => m.sender === agent.id).map((m) => m.body);
    expect(mine).toEqual([
      { text: "我先查一下。", ack: true },
      { text: "再看看另一个。\n\n都查到了。", lookups: { search: 2 } },
    ]);
  });

  it("the answer replies to the question it answers when someone else wrote after the acknowledgement; not otherwise", async () => {
    const { owner, agent, own } = await owned();
    const askSeq = await say(owner, own, "川菜馆叫什么？");
    duringTool = async () => void (await say(owner, own, "顺便问一下几点关门"));
    gateway.callTools([{ name: "search", input: { query: "川菜馆" } }], { text: "我先查一下。" }).reply("叫蜀香。");
    expect(await toolWorker().worker.runOnce()).toBe(true);
    const answer = (await messages(own)).filter((m) => m.sender === agent.id).at(-1)!;
    expect(answer.body).toEqual({ text: "叫蜀香。", lookups: { search: 1 }, replyToSeq: askSeq });
    const wire = (await api(app, owner, "GET", `/api/conversations/${own}/messages/${answer.seq}`)).json.message;
    expect(wire.replyTo).toMatchObject({ seq: askSeq, visible: true, text: "川菜馆叫什么？" });
    // Its follow-up answers what came meanwhile; nobody spoke during that one.
    duringTool = async () => {};
    gateway.callTools([{ name: "search", input: { query: "关门" } }], { text: "我看看。" }).reply("十点。");
    expect(await toolWorker().worker.runOnce()).toBe(true);
    expect((await messages(own)).filter((m) => m.sender === agent.id).at(-1)!.body).toEqual({ text: "十点。", lookups: { search: 1 } });
  });

  it("in a group: someone writing between the acknowledgement and the answer makes the answer a reply to the call", async () => {
    const [owner, mia, ned] = [await signUp(app, "owen"), await signUp(app, "mia"), await signUp(app, "ned")];
    const agent = await mustCreateAgent(app, owner, { handle: "owen_bot", name: "小助手", model: FAST, persona: "简短地回答。" });
    const g = await group(app, owner, "饭搭子", [mia, ned]);
    expect((await api(app, owner, "POST", `/api/conversations/${g}/members`, { principalId: agent.id })).status).toBe(201);
    const call = await say(mia, g, "@owen_bot 川菜馆叫什么？");
    duringTool = async () => void (await say(ned, g, "我也想知道"));
    gateway.callTools([{ name: "search", input: { query: "川菜馆" } }], { text: "我查查。" }).reply("叫蜀香。");
    expect(await toolWorker().worker.runOnce()).toBe(true);
    const mine = (await messages(g)).filter((m) => m.sender === agent.id).map((m) => m.body);
    expect(mine).toEqual([
      { text: "我查查。", ack: true },
      { text: "叫蜀香。", lookups: { search: 1 }, replyToSeq: call },
    ]);
  });

  it("stopped after the acknowledgement: it stays, nothing more is posted, and the run ends as a stopped reply", async () => {
    const { owner, agent, own } = await owned();
    await say(owner, own, "查一下");
    // Its own gateway: a round whose tool calls are never answered leaves a scripted gateway waiting for their results.
    const stopping = scriptedGateway().callTools([{ name: "search", input: { query: "x" } }], { text: "我先查一下。" });
    const { port, worker } = toolWorker(stopping);
    duringTool = async (scope) => port.requestStop(scope.id);
    expect(await worker.runOnce()).toBe(true);
    expect(stopping.pending()).toBe(0);
    expect((await messages(own)).filter((m) => m.sender === agent.id).map((m) => m.body)).toEqual([{ text: "我先查一下。", ack: true }]);
    expect((await lastRun(agent.id, own)).status).toBe("stopped");
  });

  it("an acknowledgement naming an Agent is no call on any path: a later follow-up of that Agent does not count it, nor take its caller from it", async () => {
    const [owner, mia, ned] = [await signUp(app, "owen"), await signUp(app, "mia"), await signUp(app, "ned")];
    const a = await mustCreateAgent(app, owner, { handle: "owen_bot", name: "小助手", model: FAST, persona: "简短地回答。" });
    const b = await mustCreateAgent(app, mia, { handle: "mia_bot", name: "米娅的助手", model: FAST, persona: "简短地回答。", groupMentions: "members" });
    const g = await group(app, owner, "饭搭子", [mia, ned]);
    expect((await api(app, owner, "POST", `/api/conversations/${g}/members`, { principalId: a.id })).status).toBe(201);
    expect((await api(app, mia, "POST", `/api/conversations/${g}/members`, { principalId: b.id })).status).toBe(201);
    // B is called and its reply runs (held in its model call).
    await say(mia, g, "@mia_bot 你好");
    const bGateway = scriptedGateway();
    const held = bGateway.hang();
    const bRunning = toolWorker(bGateway).worker.runOnce();
    await held.reached;
    // Meanwhile A acknowledges naming B, then answers; and Ned calls B (noted on B's running reply).
    await say(owner, g, "@owen_bot 查一下");
    gateway.callTools([{ name: "search", input: { query: "x" } }], { text: "@mia_bot 你也帮我看看。" }).reply("查完了。");
    expect(await toolWorker().worker.runOnce()).toBe(true);
    const nedCall = await say(ned, g, "@mia_bot 还有一件事");
    held.release("你好！");
    expect(await bRunning).toBe(true);
    // B's follow-up answers Ned's call only, and Ned is its caller.
    const follow = (await db.query<{ caller_id: string | null; call_seqs: string[] }>("select caller_id, call_seqs::text[] from agent_runs where agent_id = $1 and status = 'queued'", [b.id])).rows;
    expect(follow).toEqual([{ caller_id: ned.id, call_seqs: [String(nedCall)] }]);
    expect(bGateway.pending()).toBe(0);
    // At the mentions lane's merge: an acknowledgement is stored with no mentions, whatever the posting function keeps.
    const ack = (await db.query<{ row: Record<string, unknown> }>("select to_jsonb(m) as row from messages m where m.sender_id = $1 and m.client_txn like 'ack:%'", [a.id])).rows;
    expect(ack).toHaveLength(1);
    const stored = ack[0]!.row;
    expect([stored.mentions ?? null, (stored.body as Record<string, unknown>).mentions ?? null]).toSatisfy(([column, inBody]: unknown[]) => (column === null || (Array.isArray(column) && column.length === 0)) && inBody === null);
  });

  it("an acknowledgement is not counted toward the chain limit (AGENT_CHAIN_LIMIT): it is no Agent's turn", async () => {
    const owner = await signUp(app, "owen");
    const a = await mustCreateAgent(app, owner, { handle: "owen_bot", name: "小助手", model: FAST, persona: "简短地回答。" });
    const b = await mustCreateAgent(app, owner, { handle: "owen_two", name: "小二", model: FAST, persona: "简短地回答。", groupMentions: "members" });
    const g = await group(app, owner, "饭搭子", [await signUp(app, "mia"), await signUp(app, "ned")]);
    for (const x of [a, b]) expect((await api(app, owner, "POST", `/api/conversations/${g}/members`, { principalId: x.id })).status).toBe(201);
    await say(owner, g, "@owen_bot 查一下，再叫小二接着说");
    const { db: pool, blobs, conversations, reads, config } = app.deps;
    // A limit of 2: the acknowledgement and the answer would be two Agent messages in a row; only the answer counts.
    const limited = { ...config, agentChainLimit: 2 };
    const port = createAgentPort({ db: pool, config: limited, blobs, realtime: app.realtime, conversations, reads, log: app.log, toolbox, drawTag: () => "k7q2" });
    const worker = createAgentWorker({ port, models: gateway, runTimeoutMs: config.agentRunTimeoutMs, maxRunsInFlight: 1, background: false, log: app.log, tools: config.tools });
    gateway.callTools([{ name: "search", input: { query: "x" } }], { text: "我先查一下。" }).reply("@owen_two 你接着说。");
    expect(await worker.runOnce()).toBe(true);
    expect((await db.query("select 1 from agent_runs where agent_id = $1 and status = 'queued'", [b.id])).rowCount).toBe(1);
    expect((await db.query("select 1 from messages where conversation_id = $1 and body ->> 'event' = 'agent_chain_paused'", [g])).rowCount).toBe(0);
  });

  it("an acknowledgement adds nothing to unread (the answer does), and memory reads nothing of it (UNSPOKEN)", async () => {
    const { owner, agent, own } = await owned();
    await say(owner, own, "查一下");
    gateway.callTools([{ name: "search", input: { query: "x" } }], { text: "我先查一下。" }).reply("查到了。");
    expect(await toolWorker().worker.runOnce()).toBe(true);
    const entry = (await api(app, owner, "GET", `/api/conversations/${own}`)).json;
    expect(entry.unread ?? entry.conversation?.unread).toBe(1);
    const read = (await db.query<{ text: string }>(`select m.body ->> 'text' as text from messages m where m.conversation_id = $1 and m.sender_id = $2 and ${UNSPOKEN} order by m.seq`, [own, agent.id])).rows;
    expect(read.map((r) => r.text)).toEqual(["查到了。"]);
  });

  it("a retry of an acknowledged reply that failed posts no second acknowledgement: the earlier one stands, and the answer replies to the question when someone spoke after it", async () => {
    const [owner, mia, ned] = [await signUp(app, "owen"), await signUp(app, "mia"), await signUp(app, "ned")];
    const agent = await mustCreateAgent(app, owner, { handle: "owen_bot", name: "小助手", model: FAST, persona: "简短地回答。" });
    const g = await group(app, owner, "饭搭子", [mia, ned]);
    expect((await api(app, owner, "POST", `/api/conversations/${g}/members`, { principalId: agent.id })).status).toBe(201);
    const call = await say(mia, g, "@owen_bot 川菜馆叫什么？");
    gateway.callTools([{ name: "search", input: { query: "川菜馆" } }], { text: "我查查。" }).fail("provider_unavailable", { status: 502 });
    expect(await toolWorker().worker.runOnce()).toBe(true);
    expect((await lastRun(agent.id, g)).status).toBe("failed");
    await say(ned, g, "我也想知道");
    expect((await api(app, owner, "POST", `/api/conversations/${g}/runs/retry`, { agentId: agent.id })).status).toBe(201);
    gateway.callTools([{ name: "search", input: { query: "川菜馆" } }], { text: "我再查查。" }).reply("叫蜀香。");
    expect(await toolWorker().worker.runOnce()).toBe(true);
    const mine = (await messages(g)).filter((m) => m.sender === agent.id).map((m) => m.body);
    expect(mine).toEqual([
      { text: "我查查。", ack: true },
      { text: "我再查查。\n\n叫蜀香。", lookups: { search: 1 }, replyToSeq: call },
    ]);
    // A reply to a new question acknowledges again (the earlier acknowledgement stood for the old one).
    await say(mia, g, "@owen_bot 那几点关门？");
    gateway.callTools([{ name: "search", input: { query: "关门" } }], { text: "我看看。" }).reply("十点。");
    expect(await toolWorker().worker.runOnce()).toBe(true);
    expect((await messages(g)).filter((m) => m.sender === agent.id).slice(2).map((m) => m.body)).toEqual([
      { text: "我看看。", ack: true },
      { text: "十点。", lookups: { search: 1 } },
    ]);
  });

  it("a retry after an acknowledgement nobody wrote after ends its call with a person's turn (the plan shows nothing of the Agent's after the newest person's message); so does the ordinary call", async () => {
    const { owner, agent, own } = await owned();
    await say(owner, own, "查一下");
    gateway.callTools([{ name: "search", input: { query: "x" } }], { text: "我先查一下。" }).fail("provider_unavailable", { status: 502 });
    expect(await toolWorker().worker.runOnce()).toBe(true);
    // The failed reply's first call: the conversation as it was, ending with the owner's question.
    const plain = (t: { role: string; parts: Array<{ type: string; text?: string }> }) => [t.role, t.parts.map((p) => p.text)];
    expect(gateway.calls.at(-2)!.messages.map(plain)).toEqual([["user", ["查一下"]]]);
    expect((await lastRun(agent.id, own)).status).toBe("failed");
    expect((await api(app, owner, "POST", `/api/conversations/${own}/runs/retry`, {})).status).toBe(201);
    gateway.reply("查到了。");
    expect(await toolWorker().worker.runOnce()).toBe(true);
    const retried = gateway.calls.at(-1)!.messages;
    expect(retried.map(plain)).toEqual([["user", ["查一下"]]]);
    expect(retried.at(-1)!.role).toBe("user");
    expect(JSON.stringify(retried)).not.toContain(CONTINUE_TURN);
  });

  it("an acknowledgement cites nothing: every token of its run is taken out of it, a number the run gave or not, and none is streamed; what only looks like one stays; the answer cites", async () => {
    const { owner, agent, own } = await owned();
    const socket = await connect(app, owner);
    const asked = await say(owner, own, "上次那家店");
    // The first search hands the model the asked message as m1 (tools/refs.ts), as the real search would.
    duringTool = async (scope) => {
      scope.refs.message(own, asked);
    };
    gateway
      .callTools([{ name: "search", input: { query: "店" } }])
      .callTools([{ name: "search", input: { query: "地址" } }], { text: "找到了〔m1·k7q2〕〔m2·k7q2〕，〔m1〕再看看地址。", reasoning: "m1 是〔m1·k7q2〕。" })
      .reply("在河边〔m1·k7q2〕。");
    expect(await toolWorker().worker.runOnce()).toBe(true);
    await socket.waitFor((e) => e.type === "run" && e.conversationId === own && e.run?.status === "done");
    const mine = (await messages(own)).filter((m) => m.sender === agent.id);
    expect(mine.map((m) => m.body)).toEqual([
      { text: "找到了，〔m1〕再看看地址。", reasoning: "m1 是。", ack: true },
      { text: "在河边。", lookups: { search: 2 }, cites: [{ at: 3, kind: "m", ref: { conversationId: own, seq: asked } }] },
    ]);
    // Nothing that reached the owner's socket held the run's tag: not the pieces as they streamed, not the messages.
    expect(JSON.stringify(socket.events)).not.toContain("k7q2");
  });

  it("an acknowledgement naming another Agent calls nobody (its mentions are not read); the answer is read as any reply", async () => {
    const [owner, mia] = [await signUp(app, "owen"), await signUp(app, "mia")];
    const agent = await mustCreateAgent(app, owner, { handle: "owen_bot", name: "小助手", model: FAST, persona: "简短地回答。" });
    const other = await mustCreateAgent(app, mia, { handle: "mia_bot", name: "米娅的助手", model: FAST, persona: "简短地回答。" });
    await befriend(app, owner, mia);
    const g = await group(app, owner, "饭搭子", [mia, await signUp(app, "ned")]);
    expect((await api(app, owner, "POST", `/api/conversations/${g}/members`, { principalId: agent.id })).status).toBe(201);
    expect((await api(app, mia, "POST", `/api/conversations/${g}/members`, { principalId: other.id })).status).toBe(201);
    await say(owner, g, "@owen_bot 查一下");
    gateway.callTools([{ name: "search", input: { query: "x" } }], { text: "@mia_bot 你也帮我看看。" }).reply("查完了。");
    expect(await toolWorker().worker.runOnce()).toBe(true);
    expect((await messages(g)).filter((m) => m.sender === agent.id).map((m) => m.body.text)).toEqual(["@mia_bot 你也帮我看看。", "查完了。"]);
    expect((await db.query("select 1 from agent_runs where agent_id = $1", [other.id])).rowCount).toBe(0);
  });
});
