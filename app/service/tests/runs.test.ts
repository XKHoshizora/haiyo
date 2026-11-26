import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextSiteMidnight, siteDay } from "../src/accounts/store.ts";
import type { AgentPort, RunTicket } from "../src/agents/runtime/port.ts";
import { createAgentWorker } from "../src/agents/runtime/worker.ts";
import { buildApp } from "../src/app.ts";
import { api, befriend, signUp, type Actor } from "./helpers/actors.ts";
import { latestRunId, mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { NO_ANSWER_FLOOR, useApp } from "./helpers/harness.ts";
import { grant } from "./helpers/metering.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { closeAllSockets, connect, type Push, type TestSocket } from "./helpers/ws.ts";

/**
 * Replies (README "Agents and runs"): an owner's message in the Agent's conversation queues a run; the worker
 * (driven by hand here: `agentWorker: false`, `app.agentWorker.runOnce()`) calls the model, streams deltas to the
 * owner's sockets and posts the reply as an ordinary message from the Agent.
 */

const gateway = scriptedGateway();
const { app, db } = useApp({ env: SITE_ENV, models: gateway, agentWorker: false });

let first = 0;
beforeEach(() => {
  first = gateway.calls.length;
});
afterEach(async () => {
  await closeAllSockets();
  expect(gateway.pending()).toBe(0);
});

const FAST = { source: "site", id: "fast" } as const;
const PERSONA = "你是一个说话简洁的助手。";

/** A person and an Agent of theirs on the free site model, with a persona (so no greeting). */
async function owned(name: string, over: Record<string, unknown> = {}) {
  const owner = await signUp(app, name);
  const agent = await mustCreateAgent(app, owner, { model: FAST, persona: PERSONA, ...over });
  return { owner, agent, conv: agent.conversationId as string };
}

let txn = 0;
const say = (owner: Actor, conv: string, text: string) =>
  api(app, owner, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `r${++txn}` });
const latestRun = async (owner: Actor, conv: string) => (await api(app, owner, "GET", `/api/conversations/${conv}/run`)).json.run;
const callsHere = () => gateway.calls.slice(first);
const fromAgent = async (owner: Actor, conv: string, agentId: string): Promise<any[]> =>
  (await api(app, owner, "GET", `/api/conversations/${conv}/messages`)).json.messages.filter((m: any) => m.senderId === agentId);
const runPushes = (s: TestSocket, conv: string) => s.events.filter((e) => e.type === "run" && e.conversationId === conv);
const deltaText = (s: TestSocket, conv: string, field: "text" | "reasoning" = "text") =>
  s.events
    .filter((e) => e.type === "delta" && e.conversationId === conv)
    .map((e) => e[field] ?? "")
    .join("");
const usageOf = async (runId: string) =>
  (await db.query("select outcome, source, model, estimated from usage_records where run_id = $1", [runId])).rows;
const holds = async () => (await db.query<{ h: string }>("select coalesce(sum(hold_micro), 0)::text as h from agent_runs")).rows[0]!.h;
const isRun = (conv: string, status: string) => (e: Push) => e.type === "run" && e.conversationId === conv && e.run.status === status;

describe("a reply", () => {
  it("an owner message queues a run; the reply streams to every socket of the owner and is posted once", async () => {
    const { owner, agent, conv } = await owned("olive");
    const [s1, s2] = [await connect(app, owner), await connect(app, owner)];
    const reply = "你好！很高兴见到你。今天想聊点什么？我可以帮你整理想法、回答问题，或者只是陪你说说话。";
    gateway.reply(reply);

    const sent = await say(owner, conv, "你好");
    expect(sent.status).toBe(201);
    await s1.next(isRun(conv, "queued"));
    expect(await latestRun(owner, conv)).toMatchObject({ status: "queued", retryable: false });

    expect(await app.agentWorker.runOnce()).toBe(true);
    for (const s of [s1, s2]) {
      const done = await s.waitFor(isRun(conv, "done"));
      expect(runPushes(s, conv).map((e) => e.run.status)).toEqual(["queued", "running", "done"]);
      expect(deltaText(s, conv)).toBe(reply);
      const posted = s.events.filter((e) => e.type === "message" && e.message.senderId === agent.id);
      // Pushed when it is posted, and to its owner once more when its run is charged, now with its `via`.
      expect(posted.map((e) => e.message.text)).toEqual([reply, reply]);
      expect(posted.map((e) => e.message.seq)).toEqual([posted[0]!.message.seq, posted[0]!.message.seq]);
      expect(posted[1]!.message.via).toEqual({ model: { source: "site", id: "fast", label: "Fast" }, reasoning: "none", points: expect.any(String) });
      // The message arrives before the run is announced done (the client swaps its bubble for the message), and so
      // does its charged copy.
      expect(s.events.indexOf(posted[0]!)).toBeLessThan(done);
      expect(s.events.indexOf(posted[1]!)).toBeLessThan(done);
      // The Agent's read marker moved to the owner's message when it started.
      expect(s.events).toContainEqual({ type: "read", conversationId: conv, principalId: agent.id, seq: sent.json.message.seq });
    }

    const mine = await fromAgent(owner, conv, agent.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ kind: "text", text: reply });
    expect(mine[0]).not.toHaveProperty("reasoning");
    expect(mine[0]).not.toHaveProperty("stopped");
    expect(mine[0]).not.toHaveProperty("truncated");
    const run = await latestRun(owner, conv);
    expect(run).toEqual({ id: expect.any(String), status: "done", retryable: false });
    expect(await usageOf(run.id)).toEqual([{ outcome: "done", source: "site", model: "fast", estimated: true }]);
    expect(await holds()).toBe("0");
    expect((await api(app, owner, "GET", `/api/conversations/${conv}`)).json).toMatchObject({ peerReadSeq: sent.json.message.seq });

    // What the model was given.
    const [call] = callsHere();
    expect(call).toMatchObject({ protocol: "openai_chat", model: "fast-1", reasoning: "none", maxOutputTokens: 4096 });
    expect(call!.messages).toEqual([{ role: "user", parts: [{ type: "text", text: "你好" }] }]);
    expect(call!.system).toContain(PERSONA);
    expect(call!.system).toContain("olive");
    expect(call!.system).toContain(agent.name);
    expect(call!.system).toContain(`${new Date().getUTCFullYear()}年`);
  });

  it("history: the owner's turns are user, the Agent's assistant, in order", async () => {
    const { owner, conv } = await owned("hank");
    gateway.reply("第一句回复");
    await say(owner, conv, "第一句");
    await app.agentWorker.runOnce();
    gateway.reply("第二句回复");
    await say(owner, conv, "第二句");
    await app.agentWorker.runOnce();
    expect(callsHere()[1]!.messages).toEqual([
      { role: "user", parts: [{ type: "text", text: "第一句" }] },
      { role: "assistant", parts: [{ type: "text", text: "第一句回复" }] },
      { role: "user", parts: [{ type: "text", text: "第二句" }] },
    ]);
  });

  it("reasoning is stored with the reply and streamed, but is not searchable", async () => {
    const { owner, agent, conv } = await owned("rita");
    const s = await connect(app, owner);
    gateway.reply("答案是四十二。", { reasoning: "先想一想这个独特的问题。" });
    await say(owner, conv, "答案是什么？");
    await app.agentWorker.runOnce();
    await s.next(isRun(conv, "done"));
    expect(deltaText(s, conv, "reasoning")).toBe("先想一想这个独特的问题。");
    const [reply] = await fromAgent(owner, conv, agent.id);
    expect(reply).toMatchObject({ text: "答案是四十二。", reasoning: "先想一想这个独特的问题。" });
    expect((await api(app, owner, "GET", `/api/search?q=${encodeURIComponent("独特的问题")}`)).json.messages).toEqual([]);
    expect((await api(app, owner, "GET", `/api/search?q=${encodeURIComponent("四十二")}`)).json.messages).toHaveLength(1);
  });

  it("a 9 000-character reply is stored as its first 8 000 characters, marked truncated", async () => {
    const { owner, agent, conv } = await owned("tess");
    gateway.reply("字".repeat(9000));
    await say(owner, conv, "写很长的一段");
    await app.agentWorker.runOnce();
    const [reply] = await fromAgent(owner, conv, agent.id);
    expect(reply.text).toBe("字".repeat(8000));
    expect(reply.truncated).toBe(true);
    expect((await latestRun(owner, conv)).status).toBe("done");
  });

  it("an answer cut off by the model's output limit is marked truncated", async () => {
    const { owner, agent, conv } = await owned("lena");
    gateway.reply("说到一半", { truncated: true, usage: { inputTokens: 10, outputTokens: 4096 } });
    await say(owner, conv, "说吧");
    await app.agentWorker.runOnce();
    const [reply] = await fromAgent(owner, conv, agent.id);
    expect(reply).toMatchObject({ text: "说到一半", truncated: true });
    expect(await usageOf((await latestRun(owner, conv)).id)).toEqual([{ outcome: "done", source: "site", model: "fast", estimated: false }]);
  });

  it("after the model is changed (PATCH), the next reply calls the new model and is recorded with its source (spec 7.2)", async () => {
    const { owner, agent, conv } = await owned("switcher");
    const runModel = async (runId: string) =>
      (await db.query("select r.source, r.model, u.source as usage_source, u.model as usage_model from agent_runs r join usage_records u on u.run_id = r.id where r.id = $1", [runId])).rows[0];
    const replyAndRecord = async (text: string) => {
      gateway.reply(text);
      await say(owner, conv, "继续");
      expect(await app.agentWorker.runOnce()).toBe(true);
      const run = await latestRun(owner, conv);
      expect(run).toMatchObject({ status: "done" });
      return { call: callsHere().at(-1)!, recorded: await runModel(run.id) };
    };

    const onSite = await replyAndRecord("站点模型回答。");
    expect(onSite.call).toMatchObject({ protocol: "openai_chat", baseUrl: "https://api.example.test/v1", model: "fast-1", apiKey: SITE_ENV.UPSTREAM_TEST_KEY });
    expect(onSite.recorded).toEqual({ source: "site", model: "fast", usage_source: "site", usage_model: "fast" });

    const provider = (
      await api(app, owner, "POST", "/api/providers", { name: "Mine", protocol: "gemini", baseUrl: "https://gemini.example.com/v1beta", apiKey: "gm-key-0123456789", models: [{ name: "deep" }] })
    ).json;
    expect((await api(app, owner, "PATCH", `/api/agents/${agent.id}`, { model: { source: "provider", providerId: provider.id, model: "deep" } })).status).toBe(200);
    const onProvider = await replyAndRecord("自己的模型回答。");
    expect(onProvider.call).toMatchObject({ protocol: "gemini", baseUrl: "https://gemini.example.com/v1beta", model: "deep", apiKey: "gm-key-0123456789" });
    expect(onProvider.recorded).toEqual({ source: "provider", model: "deep", usage_source: "provider", usage_model: "deep" });

    expect((await api(app, owner, "PATCH", `/api/agents/${agent.id}`, { model: { source: "site", id: "thinker" } })).status).toBe(200);
    await grant(db, owner.id, 5_000_000n); // a paid-tier model needs a balance
    const backOnSite = await replyAndRecord("付费模型回答。");
    expect(backOnSite.call).toMatchObject({ protocol: "anthropic", model: "think-1" });
    expect(backOnSite.recorded).toEqual({ source: "site", model: "thinker", usage_source: "site", usage_model: "thinker" });
  });

  it("pushes about a reply go to its owner only", async () => {
    const { owner, conv } = await owned("ovid");
    const friend = await signUp(app, "felix");
    await befriend(app, owner, friend);
    const [mine, theirs] = [await connect(app, owner), await connect(app, friend)];
    gateway.reply("只给主人看。");
    await say(owner, conv, "在吗");
    await app.agentWorker.runOnce();
    await mine.next(isRun(conv, "done"));
    await new Promise((r) => setTimeout(r, 200));
    expect(theirs.events.filter((e) => ["run", "delta", "message", "read"].includes(e.type))).toEqual([]);
  });
});

describe("when there is no reply", () => {
  it("an Agent without a model, or a paused one, gets no run", async () => {
    const { owner, conv } = await owned("nina", { model: null });
    const s = await connect(app, owner);
    expect((await say(owner, conv, "你好")).status).toBe(201);
    expect(await app.agentWorker.runOnce()).toBe(false);
    expect(await latestRun(owner, conv)).toBeNull();

    const paused = await owned("pam");
    expect((await api(app, paused.owner, "POST", `/api/agents/${paused.agent.id}/pause`)).status).toBe(200);
    expect((await say(paused.owner, paused.conv, "你好")).status).toBe(201);
    expect(await app.agentWorker.runOnce()).toBe(false);
    expect(await latestRun(paused.owner, paused.conv)).toBeNull();
    expect(runPushes(s, conv)).toEqual([]);
    expect((await db.query("select count(*)::int n from agent_runs")).rows[0].n).toBe(0);
  });

  it("replyMode mention: plain text is ignored; @handle and @name are answered", async () => {
    const { owner, agent, conv } = await owned("mira", { replyMode: "mention", handle: "helper_mira", name: "小米" });
    await say(owner, conv, "随便说一句，不叫它");
    expect(await app.agentWorker.runOnce()).toBe(false);

    gateway.reply("我在。");
    await say(owner, conv, "@helper_mira 你在吗");
    expect(await app.agentWorker.runOnce()).toBe(true);
    gateway.reply("又见面了。");
    await say(owner, conv, "@小米 再说一句");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect((await fromAgent(owner, conv, agent.id)).map((m) => m.text)).toEqual(["我在。", "又见面了。"]);
    // A message that does not call it is still part of what it is shown (with the next one: both are the owner's turn).
    expect(callsHere()[0]!.messages).toEqual([
      {
        role: "user",
        parts: [
          { type: "text", text: "随便说一句，不叫它" },
          { type: "text", text: "@helper_mira 你在吗" },
        ],
      },
    ]);
  });
});

describe("coalescing", () => {
  it("three messages while the first reply hangs: exactly one further reply, covering all three", async () => {
    const { owner, agent, conv } = await owned("cora");
    const hold = gateway.hang();
    await say(owner, conv, "one");
    const running = app.agentWorker.runOnce();
    await hold.reached;
    await say(owner, conv, "two");
    await say(owner, conv, "three");
    expect((await db.query("select count(*)::int n from agent_runs")).rows[0].n).toBe(1);

    gateway.reply("answer to all");
    hold.release("answer to one");
    await running;
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(await app.agentWorker.runOnce()).toBe(false);

    expect(callsHere()).toHaveLength(2);
    const texts = callsHere()[1]!.messages.flatMap((m) => m.parts.map((p) => (p.type === "text" ? p.text : "")));
    expect(texts).toEqual(expect.arrayContaining(["one", "two", "three"]));
    expect((await fromAgent(owner, conv, agent.id)).map((m) => m.text)).toEqual(["answer to one", "answer to all"]);
    const runs = (await db.query("select status from agent_runs order by created_at")).rows.map((r) => r.status);
    expect(runs).toEqual(["done", "done"]);
  });
});

describe("stopping, pausing, failing", () => {
  it("stop mid-stream: the text so far is posted marked stopped; the usage record says stopped", async () => {
    const { owner, agent, conv } = await owned("stella");
    const s = await connect(app, owner);
    const full = "从前有座山，山里有座庙。".repeat(30);
    gateway.reply(full, { delayMsPerChunk: 30 });
    await say(owner, conv, "讲个故事");
    const running = app.agentWorker.runOnce();
    const delta = await s.next((e) => e.type === "delta" && e.conversationId === conv);
    const stop = () => api(app, owner, "POST", `/api/conversations/${conv}/runs/${delta.runId}/stop`);
    expect(await stop()).toEqual({ status: 200, json: { ok: true } });
    await running;

    const [reply] = await fromAgent(owner, conv, agent.id);
    expect(reply.stopped).toBe(true);
    expect(reply.text.length).toBeGreaterThan(0);
    expect(reply.text.length).toBeLessThan(full.length);
    expect(full.startsWith(reply.text)).toBe(true);
    await s.next(isRun(conv, "stopped"));
    expect(deltaText(s, conv)).toBe(reply.text);
    expect(await latestRun(owner, conv)).toEqual({ id: delta.runId, status: "stopped", retryable: false });
    expect(await usageOf(delta.runId)).toEqual([{ outcome: "stopped", source: "site", model: "fast", estimated: true }]);
    expect(await holds()).toBe("0");
    // Idempotent.
    expect(await stop()).toEqual({ status: 200, json: { ok: true } });
  });

  it("a queued run that is stopped never reaches the model", async () => {
    const { owner, conv } = await owned("quinn");
    const s = await connect(app, owner);
    await say(owner, conv, "算了");
    const queued = (await s.next(isRun(conv, "queued"))).run;
    expect(await api(app, owner, "POST", `/api/conversations/${conv}/runs/${queued.id}/stop`)).toEqual({ status: 200, json: { ok: true } });
    await s.next(isRun(conv, "stopped"));
    expect(await app.agentWorker.runOnce()).toBe(false);
    expect(callsHere()).toHaveLength(0);
    expect(await latestRun(owner, conv)).toMatchObject({ status: "stopped" });
  });

  it("a running run nobody here is working on is released by the stop at once, as recovery would end it", async () => {
    // Claimed and admitted by hand, then left: what another instance, or one that died, leaves behind.
    const { owner, conv } = await owned("orphan");
    const s = await connect(app, owner);
    await say(owner, conv, "你在吗");
    const ticket = (await app.agentPort.claimNext())!;
    expect(await app.agentPort.begin(ticket)).toHaveProperty("call");
    expect(app.agentWorker.isWorking(ticket.id)).toBe(false);
    expect(await holds()).not.toBe("0");

    expect(await api(app, owner, "POST", `/api/conversations/${conv}/runs/${ticket.id}/stop`)).toEqual({ status: 200, json: { ok: true } });
    expect(await latestRun(owner, conv)).toEqual({ id: ticket.id, status: "failed", error: "provider_unavailable", retryable: true });
    await s.next((e) => isRun(conv, "failed")(e) && e.run.id === ticket.id);
    expect(await holds()).toBe("0");
    expect(await usageOf(ticket.id)).toEqual([{ outcome: "failed", source: "site", model: "fast", estimated: true }]);
    expect(callsHere()).toHaveLength(0);
    // Idempotent: an ended run is left as it is.
    expect(await api(app, owner, "POST", `/api/conversations/${conv}/runs/${ticket.id}/stop`)).toEqual({ status: 200, json: { ok: true } });
    expect(await usageOf(ticket.id)).toHaveLength(1);

    // One whose reply was already posted (stopped) ends stopped, with that message.
    const other = await owned("orphan2");
    await say(other.owner, other.conv, "讲吧");
    const posted = (await app.agentPort.claimNext())!;
    await app.agentPort.begin(posted);
    expect(await app.agentPort.post(posted, { text: "讲到一半", reasoning: "", stopped: true, truncated: false })).toBe("posted");
    expect((await api(app, other.owner, "POST", `/api/conversations/${other.conv}/runs/${posted.id}/stop`)).status).toBe(200);
    expect(await latestRun(other.owner, other.conv)).toEqual({ id: posted.id, status: "stopped", retryable: false });
    expect(await fromAgent(other.owner, other.conv, other.agent.id)).toMatchObject([{ text: "讲到一半", stopped: true }]);
  });

  it("a stop or pause landing between begin and the call: no call is made and nothing is charged, not even the input", async () => {
    /** The app's own port, with `act` run right after `begin` has admitted the call and before the worker calls. */
    const landingAfterBegin = (act: (run: RunTicket) => Promise<void>): AgentPort => {
      const port = app.agentPort;
      return {
        claimNext: () => port.claimNext(),
        begin: async (run, closing) => {
          const prepared = await port.begin(run, closing);
          await act(run);
          return prepared;
        },
        emit: (run, delta) => port.emit(run, delta),
        post: (run, reply) => port.post(run, reply),
        acknowledge: (run, said) => port.acknowledge(run, said),
        finish: (run, end, usage, fallback) => port.finish(run, end, usage, fallback),
        release: (run, progress) => port.release(run, progress),
        progressed: (run) => port.progressed(run),
        shouldStop: (run) => port.shouldStop(run),
        tool: (run, call, signal) => port.tool(run, call, signal),
        extend: (run, spent, estimated, next) => port.extend(run, spent, estimated, next),
        activity: (run, activity) => port.activity(run, activity),
        toolsUnusable: (run, why) => port.toolsUnusable(run, why),
        toolsWorked: (run) => port.toolsWorked(run),
      };
    };
    const charged = async (runId: string) =>
      (
        await db.query(
          "select outcome, input_tokens::int, output_tokens::int, cost_micro::text as cost, free_micro::text as free from usage_records where run_id = $1",
          [runId],
        )
      ).rows;
    const workerOn = (port: AgentPort) =>
      createAgentWorker({ port, models: gateway, runTimeoutMs: 120_000, maxRunsInFlight: 8, background: false, log: app.log });

    // The owner's stop (as the stop route flags a run its worker is working on).
    const stopped = await owned("between");
    await say(stopped.owner, stopped.conv, "算了");
    expect(await workerOn(landingAfterBegin(async (run) => app.agentPort.requestStop(run.id))).runOnce()).toBe(true);
    const stoppedRun = await latestRun(stopped.owner, stopped.conv);
    expect(stoppedRun).toMatchObject({ status: "stopped" });
    expect(await charged(stoppedRun.id)).toEqual([{ outcome: "stopped", input_tokens: 0, output_tokens: 0, cost: "0", free: "0" }]);

    // A pause.
    const paused = await owned("between2");
    await say(paused.owner, paused.conv, "你好");
    const pause = async () => void (await api(app, paused.owner, "POST", `/api/agents/${paused.agent.id}/pause`));
    expect(await workerOn(landingAfterBegin(pause)).runOnce()).toBe(true);
    const pausedRun = await latestRun(paused.owner, paused.conv);
    expect(pausedRun).toMatchObject({ status: "cancelled", error: "agent_paused" });
    expect(await charged(pausedRun.id)).toEqual([{ outcome: "cancelled", input_tokens: 0, output_tokens: 0, cost: "0", free: "0" }]);

    expect(callsHere()).toHaveLength(0);
    expect(await holds()).toBe("0");
  });

  it("pause mid-run: the call is abandoned, nothing is posted, the run is cancelled", async () => {
    const { owner, agent, conv } = await owned("paula");
    const hold = gateway.hang();
    await say(owner, conv, "你好");
    const running = app.agentWorker.runOnce();
    const call = await hold.reached;
    expect(await latestRun(owner, conv)).toMatchObject({ status: "running" });
    expect((await api(app, owner, "POST", `/api/agents/${agent.id}/pause`)).status).toBe(200);
    await running;
    expect(call.signal.aborted).toBe(true);
    expect(await fromAgent(owner, conv, agent.id)).toEqual([]);
    const run = await latestRun(owner, conv);
    expect(run).toEqual({ id: run.id, status: "cancelled", error: "agent_paused", retryable: false });
    expect(await usageOf(run.id)).toEqual([{ outcome: "cancelled", source: "site", model: "fast", estimated: true }]);
    expect(await holds()).toBe("0");
    // Retrying a paused Agent's reply is refused.
    expect(await api(app, owner, "POST", `/api/conversations/${conv}/runs/retry`, { runId: await latestRunId(db, conv) })).toEqual({ status: 409, json: { error: "agent_paused" } });
  });

  it("delete mid-run: the call is abandoned, nothing is posted, the run is cancelled", async () => {
    const { owner, agent, conv } = await owned("dorian");
    const hold = gateway.hang();
    await say(owner, conv, "你好");
    const running = app.agentWorker.runOnce();
    const call = await hold.reached;
    expect((await api(app, owner, "DELETE", `/api/agents/${agent.id}`)).status).toBe(200);
    await running;
    expect(call.signal.aborted).toBe(true);
    expect(await fromAgent(owner, conv, agent.id)).toEqual([]);
    const run = await latestRun(owner, conv);
    expect(run).toEqual({ id: run.id, status: "cancelled", error: "agent_deleted", retryable: false });
    expect(await holds()).toBe("0");
  });

  it("a reply the database refuses to store fails as busy, retryable, and costs the owner nothing", async () => {
    const { owner, agent, conv } = await owned("bruno");
    // An injected database error on storing exactly this Agent's messages.
    const fn = `refuse_agent_${agent.id.replaceAll("-", "")}`;
    await db.query(
      `create function ${fn}() returns trigger language plpgsql as $$
       begin if new.sender_id = '${agent.id}' then raise exception 'injected failure'; end if; return new; end $$`,
    );
    await db.query(`create trigger ${fn} before insert on messages for each row execute function ${fn}()`);
    try {
      gateway.reply("这条存不下来。", { usage: { inputTokens: 100, outputTokens: 20 } });
      await say(owner, conv, "你好");
      expect(await app.agentWorker.runOnce()).toBe(true);
    } finally {
      await db.query(`drop trigger ${fn} on messages`);
      await db.query(`drop function ${fn}()`);
    }
    expect(await fromAgent(owner, conv, agent.id)).toEqual([]);
    const run = await latestRun(owner, conv);
    expect(run).toEqual({ id: run.id, status: "failed", error: "busy", retryable: true });
    // The true cost (100 × 1 + 20 × 2 micro-points) is recorded and wholly forgiven: no allowance, no balance used.
    const records = await db.query(
      `select outcome, cost_micro::text as cost, free_micro::text as free, balance_micro::text as balance, forgiven_micro::text as forgiven
         from usage_records where run_id = $1`,
      [run.id],
    );
    expect(records.rows).toEqual([{ outcome: "failed", cost: "140", free: "0", balance: "0", forgiven: "140" }]);
    expect((await db.query("select * from free_usage where owner_id = $1", [owner.id])).rows).toEqual([]);
    expect((await db.query("select * from balance_ledger where owner_id = $1", [owner.id])).rows).toEqual([]);
    expect(await holds()).toBe("0");
  });

  it("the provider refusing the key: no message, the run failed and not retryable", async () => {
    const { owner, agent, conv } = await owned("fran");
    const s = await connect(app, owner);
    gateway.fail("provider_rejected", { afterText: "部分文字" });
    await say(owner, conv, "你好");
    await app.agentWorker.runOnce();
    expect(await fromAgent(owner, conv, agent.id)).toEqual([]);
    const run = await latestRun(owner, conv);
    expect(run).toEqual({ id: run.id, status: "failed", error: "provider_rejected", retryable: false });
    expect((await s.next(isRun(conv, "failed"))).run).toEqual(run);
    expect((await usageOf(run.id))[0]).toMatchObject({ outcome: "failed" });
    expect(await holds()).toBe("0");
  });

  it("an empty answer fails as provider_unavailable, which may be retried; retry posts a reply", async () => {
    const { owner, agent, conv } = await owned("emma");
    gateway.empty();
    const sent = await say(owner, conv, "你好");
    await app.agentWorker.runOnce();
    expect(await fromAgent(owner, conv, agent.id)).toEqual([]);
    const failed = await latestRun(owner, conv);
    expect(failed).toEqual({ id: failed.id, status: "failed", error: "provider_unavailable", retryable: true });

    gateway.reply("这次好了。");
    const retried = await api(app, owner, "POST", `/api/conversations/${conv}/runs/retry`, { runId: await latestRunId(db, conv) });
    expect(retried.status).toBe(201);
    expect(retried.json.run).toEqual({ id: expect.any(String), status: "queued", retryable: false });
    expect(retried.json.run.id).not.toBe(failed.id);
    const covers = await db.query("select covers_seq::int c from agent_runs where id = $1", [retried.json.run.id]);
    expect(covers.rows[0].c).toBe(sent.json.message.seq);
    await app.agentWorker.runOnce();
    expect((await fromAgent(owner, conv, agent.id)).map((m) => m.text)).toEqual(["这次好了。"]);
    expect(callsHere()[1]!.messages).toEqual([{ role: "user", parts: [{ type: "text", text: "你好" }] }]);
    expect(await latestRun(owner, conv)).toMatchObject({ status: "done" });
  });

  it("retry: 404 for no run there; 409 busy_run while a run is active; 400 when the run named did not fail", async () => {
    const { owner, conv } = await owned("rhea");
    const retry = async () => api(app, owner, "POST", `/api/conversations/${conv}/runs/retry`, { runId: await latestRunId(db, conv) });
    // No run there to name (T2 fix 1, F4: a 重试 names the failure by its id).
    expect(await retry()).toEqual({ status: 404, json: { error: "not_found" } });
    const hold = gateway.hang();
    await say(owner, conv, "你好");
    expect(await retry()).toEqual({ status: 409, json: { error: "busy_run" } });
    const running = app.agentWorker.runOnce();
    await hold.reached;
    expect(await retry()).toEqual({ status: 409, json: { error: "busy_run" } });
    hold.release("好的");
    await running;
    expect(await retry()).toEqual({ status: 400, json: { error: "invalid_request" } });
  });

  it("dismiss hides a failed run from GET …/run until the next run", async () => {
    const { owner, conv } = await owned("dina");
    const dismiss = () => api(app, owner, "POST", `/api/conversations/${conv}/runs/dismiss`);
    expect(await dismiss()).toEqual({ status: 200, json: { ok: true } });
    gateway.fail("provider_unavailable");
    await say(owner, conv, "你好");
    await app.agentWorker.runOnce();
    expect(await latestRun(owner, conv)).toMatchObject({ status: "failed" });
    expect(await dismiss()).toEqual({ status: 200, json: { ok: true } });
    expect(await latestRun(owner, conv)).toBeNull();
    expect(await dismiss()).toEqual({ status: 200, json: { ok: true } });
    gateway.reply("回来了");
    await say(owner, conv, "再试试");
    expect(await latestRun(owner, conv)).toMatchObject({ status: "queued" });
    await app.agentWorker.runOnce();
    expect(await latestRun(owner, conv)).toMatchObject({ status: "done" });
  });

  it("no quota: the run fails with no_quota and when the allowance resets", async () => {
    const owner = await signUp(app, "zoe");
    const agent = await mustCreateAgent(app, owner, { model: { source: "site", id: "thinker" }, persona: PERSONA });
    await say(owner, agent.conversationId, "你好");
    await app.agentWorker.runOnce();
    const run = await latestRun(owner, agent.conversationId);
    // A paid-tier model with no balance: nothing resets on its own.
    expect(run).toEqual({ id: run.id, status: "failed", error: "no_quota", retryable: true });
    expect(callsHere()).toHaveLength(0);
    expect(await usageOf(run.id)).toEqual([{ outcome: "failed", source: null, model: null, estimated: true }]);

    // A free-tier model once today's allowance is used up (and there is no balance): when it starts again.
    const fast = await mustCreateAgent(app, owner, { model: FAST, persona: PERSONA });
    const now = new Date();
    await db.query("insert into free_usage (owner_id, day, used_micro) values ($1, $2::date, $3)", [
      owner.id,
      siteDay(now, app.deps.config.siteTimezone),
      app.deps.config.freeDailyMicro.toString(),
    ]);
    await say(owner, fast.conversationId, "你好");
    await app.agentWorker.runOnce();
    const free = await latestRun(owner, fast.conversationId);
    expect(free).toEqual({
      id: free.id,
      status: "failed",
      error: "no_quota",
      retryable: true,
      resetsAt: nextSiteMidnight(now, app.deps.config.siteTimezone).toISOString(),
    });
    expect(callsHere()).toHaveLength(0);
  });
});

describe("the run routes are the owner's", () => {
  it("another person's run id or conversation is 404 exactly like a random one", async () => {
    const a = await owned("anna");
    const b = await owned("bert");
    await say(a.owner, a.conv, "你好");
    const runId = (await latestRun(a.owner, a.conv)).id;
    const nobody = randomUUID();
    const notFound = { status: 404, json: { error: "not_found" } };
    for (const conv of [a.conv, b.conv, nobody]) {
      for (const id of [runId, nobody]) {
        expect([conv, id, await api(app, b.owner, "POST", `/api/conversations/${conv}/runs/${id}/stop`)]).toEqual([conv, id, notFound]);
      }
    }
    // The owner too, for a run of another conversation.
    expect(await api(app, b.owner, "POST", `/api/conversations/${b.conv}/runs/${runId}/stop`)).toEqual(notFound);
    for (const conv of [a.conv, nobody]) {
      expect(await api(app, b.owner, "GET", `/api/conversations/${conv}/run`)).toEqual(notFound);
      expect(await api(app, b.owner, "POST", `/api/conversations/${conv}/runs/retry`, { runId: await latestRunId(db, conv) })).toEqual(notFound);
      expect(await api(app, b.owner, "POST", `/api/conversations/${conv}/runs/dismiss`)).toEqual(notFound);
    }
    // A conversation that is not an Agent's: also 404.
    const friend = await signUp(app, "carl");
    const { conversationId: dm } = await befriend(app, a.owner, friend);
    expect(await api(app, a.owner, "GET", `/api/conversations/${dm}/run`)).toEqual(notFound);
    // Nothing changed for A.
    expect(await latestRun(a.owner, a.conv)).toMatchObject({ id: runId, status: "queued" });
  });
});

describe("closing the app", () => {
  it("abandons a call in flight without posting, ends its run as recovery would (failed, retryable), and does not hang", async () => {
    const own = scriptedGateway();
    const other = await buildApp({ config: app.deps.config, db, models: own }, { agentWorker: false, answerFloor: NO_ANSWER_FLOOR });
    await other.ready();
    const owner = await signUp(other, "cleo");
    const agent = await mustCreateAgent(other, owner, { model: FAST, persona: PERSONA });
    const hold = own.hang();
    await api(other, owner, "POST", `/api/conversations/${agent.conversationId}/messages`, { text: "你好", clientTxn: "c1" });
    const running = other.agentWorker.runOnce();
    const call = await hold.reached;
    const t0 = performance.now();
    await other.close();
    await running;
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(call.signal.aborted).toBe(true);
    const rows = await db.query("select status, error, hold_micro::text as hold from agent_runs");
    expect(rows.rows).toEqual([{ status: "failed", error: "provider_unavailable", hold: "0" }]);
    const posted = await db.query("select count(*)::int n from messages where sender_id = $1", [agent.id]);
    expect(posted.rows[0].n).toBe(0);
  });
});
