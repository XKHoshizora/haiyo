import { afterEach, describe, expect, it } from "vitest";
import { GREETING_LINE, GREETING_TURN } from "../src/agents/runtime/prompt.ts";
import { api, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";

/**
 * A new Agent's first message (principle P2: the Agent never says a canned sentence): with no persona yet and a model, its
 * creation queues an ordinary reply of its owner's own lane that its model makes a greeting of — told so by a fixed line of
 * its system text (`GREETING_LINE`) and, before its owner has written, shown one turn that says what is so
 * (`GREETING_TURN`). Charged and admitted like any reply. When it cannot be made there is simply no Agent message (and no
 * failure is shown): never a fixed line in its place.
 */

const gateway = scriptedGateway();
const { app, db } = useApp({ env: SITE_ENV, models: gateway, agentWorker: false, greeting: true });
const FAST = { source: "site", id: "fast" } as const;

afterEach(() => expect(gateway.pending()).toBe(0));

const messagesOf = async (owner: Actor, conv: string) => (await api(app, owner, "GET", `/api/conversations/${conv}/messages`)).json.messages;
const runsOf = async (conv: string) =>
  (await db.query<{ status: string; error: string | null; greets: boolean; lane: string }>("select status, error, greets, lane from agent_runs where conversation_id = $1 order by created_at", [conv])).rows;

describe("a new Agent's greeting", () => {
  it("is its model's own reply: queued at creation, the model told to greet, its text the Agent's first message; charged like any reply", async () => {
    const owner = await signUp(app, "greet_a");
    const agent = await mustCreateAgent(app, owner, { name: "小新", model: FAST });
    // Nothing is posted as the Agent at creation: no fixed line.
    expect(await messagesOf(owner, agent.conversationId)).toEqual([]);
    expect(await runsOf(agent.conversationId)).toEqual([{ status: "queued", error: null, greets: true, lane: "own" }]);

    gateway.reply("你好呀，我是小新。想让我变成什么样的伙伴？");
    expect(await app.agentWorker.runOnce()).toBe(true);
    const call = gateway.calls.at(-1)!;
    expect(call.system.endsWith(GREETING_LINE)).toBe(true);
    expect(call.messages).toHaveLength(1);
    expect(call.messages[0]).toMatchObject({ role: "user", parts: [{ type: "text", text: GREETING_TURN }] });

    const messages = await messagesOf(owner, agent.conversationId);
    expect(messages.map((m: { senderId: string; text: string }) => [m.senderId, m.text])).toEqual([[agent.id, "你好呀，我是小新。想让我变成什么样的伙伴？"]]);
    expect((await runsOf(agent.conversationId)).map((r) => r.status)).toEqual(["done"]);
    expect((await db.query("select 1 from usage_records u join agent_runs r on r.id = u.run_id where r.conversation_id = $1", [agent.conversationId])).rowCount).toBe(1);
  });

  it("an Agent with no model, or with a persona, gets no greeting at all — no run, no message", async () => {
    const owner = await signUp(app, "greet_b");
    const bare = await mustCreateAgent(app, owner, { name: "无模型" });
    const set = await mustCreateAgent(app, owner, { name: "有设定", model: FAST, persona: "你是一个说话简洁的助手。" });
    for (const agent of [bare, set]) {
      expect(await messagesOf(owner, agent.conversationId)).toEqual([]);
      expect(await runsOf(agent.conversationId)).toEqual([]);
    }
    expect(await app.agentWorker.runOnce()).toBe(false);
  });

  it("when it cannot be made (its key refused) there is no Agent message and no failure shown, only the empty conversation", async () => {
    const owner = await signUp(app, "greet_c");
    const agent = await mustCreateAgent(app, owner, { model: FAST });
    gateway.fail("provider_rejected", { status: 401 });
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(await messagesOf(owner, agent.conversationId)).toEqual([]);
    expect(await runsOf(agent.conversationId)).toEqual([{ status: "cancelled", error: null, greets: true, lane: "own" }]);
    const shown = (await api(app, owner, "GET", `/api/conversations/${agent.conversationId}/run`)).json.run;
    expect(shown).toMatchObject({ status: "cancelled", retryable: false });
    expect(shown).not.toHaveProperty("error");
  });

  it("its owner writes before it runs: the one reply answers them (greeting them too), with no made-up turn", async () => {
    const owner = await signUp(app, "greet_d");
    const agent = await mustCreateAgent(app, owner, { model: FAST });
    expect((await api(app, owner, "POST", `/api/conversations/${agent.conversationId}/messages`, { text: "你好", clientTxn: "g-d-1" })).status).toBe(201);
    gateway.reply("你好！");
    expect(await app.agentWorker.runOnce()).toBe(true);
    const call = gateway.calls.at(-1)!;
    expect(call.system.endsWith(GREETING_LINE)).toBe(true);
    expect(call.messages.map((m) => m.parts.map((p) => (p.type === "text" ? p.text : "")).join(""))).toEqual(["你好"]);
    expect(await app.agentWorker.runOnce()).toBe(false);
    expect((await messagesOf(owner, agent.conversationId)).map((m: { text: string }) => m.text)).toEqual(["你好", "你好！"]);
  });
});
