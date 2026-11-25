import { afterEach, describe, expect, it, vi } from "vitest";
import { NOTHING } from "../src/agents/runtime/port.ts";
import { weight } from "../src/metering/tokens.ts";
import { api, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { SOCIAL_ON, seedSocial } from "./helpers/social.ts";
import { closeAllSockets, connect } from "./helpers/ws.ts";

/**
 * Lane B, B8: post, finish and claim for a social run. A reply is posted once, on the access and notes as they are NOW (`reach` again,
 * `shownNotesPass`); the outcomes `owner_spoke`, `access_ended`, `notes_changed` end the run `cancelled` with that value, nothing
 * half-posted, no unhandled rejection, the hold settled exactly once, and the visitor is told nothing of why (the hub's visitor wire
 * has no reason: tests/social-places-runs.test.ts). No acknowledgement is posted in a social conversation, no review, no summary;
 * with the switch off a queued social run ends `access_ended` at the next claim and an own run is claimed.
 */
const gateway = scriptedGateway();
const { app, db } = useApp({ env: SITE_ENV, models: gateway, agentWorker: false, memory: true, tools: true, config: SOCIAL_ON });
afterEach(async () => {
  vi.restoreAllMocks();
  await closeAllSockets();
  expect(gateway.pending()).toBe(0);
});

const FAST = { source: "site", id: "fast" } as const;
const REPLY = { reasoning: "", stopped: false, truncated: false } as const;
let txn = 0;
const send = (who: Actor, conv: string, text: string) => api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `sp${++txn}` });
const say = async (who: Actor, conv: string, text: string): Promise<number> => {
  const sent = await send(who, conv, text);
  if (sent.status !== 201) throw new Error(`say: ${sent.status} ${JSON.stringify(sent.json)}`);
  return sent.json.message.seq as number;
};
async function world(tag: string) {
  const [owner, v] = [await signUp(app, `sp_o_${tag}`), await signUp(app, `sp_v_${tag}`)];
  const agent = (await mustCreateAgent(app, owner, { handle: `sp_bot_${tag}`, name: "sp", model: FAST, persona: "简短地回答。" })) as { id: string; conversationId: string };
  const seeded = await seedSocial(app, { owner, agentId: agent.id, visitor: v });
  return { owner, v, agent, conv: seeded.conversationId };
}
type World = Awaited<ReturnType<typeof world>>;
const posted = async (w: World) =>
  (await db.query<{ seq: number; body: Record<string, unknown>; mentions: unknown }>("select seq::int, body, mentions from messages where conversation_id = $1 and sender_id = $2 and kind = 'text'", [w.conv, w.agent.id])).rows;
const runOf = async (w: World) =>
  (await db.query<{ id: string; status: string; error: string | null; interrupted: string | null; pending: string | null }>(
    "select id, status, error, interrupted, pending_seq::text as pending from agent_runs where agent_id = $1 and conversation_id = $2 and purpose = 'reply' order by created_at, id limit 1",
    [w.agent.id, w.conv],
  )).rows[0]!;
const usageRecords = async (runId: string) => Number((await db.query<{ n: string }>("select count(*) as n from usage_records where run_id = $1", [runId])).rows[0]!.n);
/** The run claimed and begun by hand, as the worker does it. */
async function begun(w: World) {
  const ticket = (await app.agentPort.claimNext())!;
  expect(ticket).not.toBeNull();
  const prepared = await app.agentPort.begin(ticket);
  expect("call" in prepared).toBe(true);
  return ticket;
}

describe("a social reply is posted once", () => {
  it("posted as the Agent's message: no mentions, no tool lookups or search words, no run it calls; settled once; no review, no summary", async () => {
    const w = await world("ok");
    await say(w.v, w.conv, "你好");
    const noted = vi.spyOn(app.deps.memory!, "noted");
    const summarise = vi.spyOn(app.deps.memory!, "summarise");
    gateway.reply("你好，@xyz 在吗。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    const [message] = await posted(w);
    expect(message).toBeDefined();
    expect(message!.mentions).toBeNull();
    expect(message!.body).not.toHaveProperty("queries");
    expect(message!.body).not.toHaveProperty("toolCalls");
    const run = await runOf(w);
    expect(run).toMatchObject({ status: "done", error: null });
    expect(await usageRecords(run.id)).toBe(1);
    expect(noted).not.toHaveBeenCalled();
    expect(summarise).not.toHaveBeenCalled();
    expect((await db.query("select 1 from agent_runs where agent_id = $1 and id <> $2", [w.agent.id, run.id])).rowCount).toBe(0);
  });

  // I1 (B-4 review; controller ruling 2026-11-25): there is no separate acknowledgement MESSAGE in a social conversation, but the text the
  // model writes before a tool call is KEPT as the beginning of the one reply that is posted. The visitor sees one message; the owner pays
  // for the run as for any reply; only a reply with no visible text at all takes the empty-reply path (no message, the run fails, the
  // visitor is told nothing of why).
  it("I1: preface, a tool call, then an answer: one message, the preface first, no ack message", async () => {
    const w = await world("ack");
    await say(w.v, w.conv, "帮我查查");
    gateway.callTools([{ name: "search_messages", input: { query: "不存在的词语" } }], { text: "我查一下。" }).reply("没查到。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    const messages = await posted(w);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.body.ack).toBeUndefined();
    const text = messages[0]!.body.text as string;
    expect(text.startsWith("我查一下。")).toBe(true);
    expect(text.indexOf("没查到。")).toBeGreaterThan(text.indexOf("我查一下。"));
    expect(await runOf(w)).toMatchObject({ status: "done", error: null });
  });

  it("the preface and the answer are ONE text for the visitor and so ONE budget (review 5, item 8): two rounds each under the others' limit come out cut to it, and marked cut", async () => {
    const w = await world("onebudget");
    await say(w.v, w.conv, "帮我查查");
    const first = "好".repeat(700); // a weight of 700 each, of a limit of 800
    gateway.callTools([{ name: "search_messages", input: { query: "不存在的词语" } }], { text: first }).reply("行".repeat(700));
    expect(await app.agentWorker.runOnce()).toBe(true);
    const messages = await posted(w);
    expect(messages).toHaveLength(1);
    const text = messages[0]!.body.text as string;
    expect(text.startsWith(first)).toBe(true);
    expect(text).toContain("行");
    expect(weight(text)).toBeLessThanOrEqual(app.deps.config.others.outputTokens);
    expect(weight(text)).toBeGreaterThan(app.deps.config.others.outputTokens - 2);
    expect(messages[0]!.body.truncated).toBe(true);
  });

  it("I1: preface, a tool call, then nothing: the preface is the reply, one message, the run done", async () => {
    const w = await world("ackonly");
    await say(w.v, w.conv, "帮我查查");
    gateway.callTools([{ name: "search_messages", input: { query: "不存在的词语" } }], { text: "他周三下午有空。" }).empty();
    expect(await app.agentWorker.runOnce()).toBe(true);
    const messages = await posted(w);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.body.text).toBe("他周三下午有空。");
    expect(messages[0]!.body.ack).toBeUndefined();
    const run = await runOf(w);
    expect(run).toMatchObject({ status: "done", error: null });
    expect(await usageRecords(run.id)).toBe(1);
  });

  it("I1: no text at all (a call, then nothing): the existing empty-reply path, no message", async () => {
    const w = await world("noneatall");
    await say(w.v, w.conv, "帮我查查");
    gateway.callTools([{ name: "search_messages", input: { query: "不存在的词语" } }]).empty();
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(await posted(w)).toEqual([]);
    expect((await runOf(w)).status).toBe("failed");
  });

  it("I1: the acknowledgement port call itself posts nothing and leaves the text with the reply (\"refused\", which leaves the stream alone)", async () => {
    const w = await world("ackport");
    await say(w.v, w.conv, "你好");
    const ticket = await begun(w);
    expect(await app.agentPort.acknowledge(ticket, { text: "我查一下。", reasoning: "" })).toBe("refused");
    expect(await posted(w)).toEqual([]);
    expect(await runOf(w)).toMatchObject({ status: "running", interrupted: null });
    await app.agentPort.finish(ticket, { status: "cancelled" }, null, NOTHING);
  });
});

describe("the post checks access and notes as they are now", () => {
  it("test 1, lane B's half: access ended by SQL mid-call: refused, cancelled/access_ended, nothing posted, the hold settled once", async () => {
    const w = await world("acc");
    await say(w.v, w.conv, "你好");
    const ticket = await begun(w);
    await db.query("update agent_contacts set state = 'ended', end_reason = 'removed' where agent_id = $1 and subject_id = $2", [w.agent.id, w.v.id]);
    expect(await app.agentPort.post(ticket, { text: "在的", ...REPLY })).toBe("refused");
    expect(await posted(w)).toEqual([]);
    await app.agentPort.finish(ticket, { status: "cancelled" }, null, NOTHING);
    expect(await runOf(w)).toMatchObject({ status: "cancelled", error: "access_ended", interrupted: "access_ended", pending: null });
    await app.agentPort.finish(ticket, { status: "cancelled" }, null, NOTHING);
    expect(await usageRecords(ticket.id)).toBe(1);
  });

  it("test 8, lane B's half: a shown note without a verdict: refused, cancelled/notes_changed, nothing posted; the next message gets a new run", async () => {
    const w = await world("notes");
    await say(w.v, w.conv, "你好");
    const ticket = await begun(w);
    await db.query("update agent_runs set shown_notes = $2::jsonb where id = $1", [ticket.id, JSON.stringify([{ kind: "owner", id: "11111111-1111-4111-8111-111111111111", version: "2026-03-01T00:00:00.000000Z" }])]);
    expect(await app.agentPort.post(ticket, { text: "在的", ...REPLY })).toBe("refused");
    expect(await posted(w)).toEqual([]);
    await app.agentPort.finish(ticket, { status: "cancelled" }, null, NOTHING);
    expect(await runOf(w)).toMatchObject({ status: "cancelled", error: "notes_changed", pending: null });
    await say(w.v, w.conv, "再问一次");
    expect((await db.query("select 1 from agent_runs where agent_id = $1 and status = 'queued'", [w.agent.id])).rowCount).toBe(1);
  });

  it("owner_spoke: the owner's message while the reply is written: not posted, cancelled/owner_spoke, nothing queued", async () => {
    const w = await world("spoke");
    await say(w.v, w.conv, "你好");
    const ticket = await begun(w);
    await say(w.owner, w.conv, "我来回答他");
    expect(await app.agentPort.post(ticket, { text: "在的", ...REPLY })).toBe("refused");
    expect(await posted(w)).toEqual([]);
    await app.agentPort.finish(ticket, { status: "cancelled" }, null, NOTHING);
    expect(await runOf(w)).toMatchObject({ status: "cancelled", error: "owner_spoke" });
    expect((await db.query("select 1 from agent_runs where agent_id = $1 and status = 'queued'", [w.agent.id])).rowCount).toBe(0);
  });

  it("errand_ended (the errands plan's value): refused like the others, nothing half-posted", async () => {
    const w = await world("errand");
    await say(w.v, w.conv, "你好");
    const ticket = await begun(w);
    await db.query("update agent_runs set interrupted = 'errand_ended' where id = $1", [ticket.id]);
    expect(await app.agentPort.post(ticket, { text: "在的", ...REPLY })).toBe("refused");
    expect(await posted(w)).toEqual([]);
    await app.agentPort.finish(ticket, { status: "cancelled" }, null, NOTHING);
    expect(await runOf(w)).toMatchObject({ status: "cancelled", error: "errand_ended" });
  });

  it("a post and the owner's message on two connections serialise on the Agent's row: either the reply stands (done) or it is refused (owner_spoke), never both and never half", async () => {
    for (let round = 0; round < 6; round++) {
      const w = await world(`race${round}`);
      await say(w.v, w.conv, "你好");
      const ticket = await begun(w);
      const results = await Promise.allSettled([app.agentPort.post(ticket, { text: "在的", ...REPLY }), send(w.owner, w.conv, "我来说")]);
      expect(results.every((r) => r.status === "fulfilled")).toBe(true);
      await app.agentPort.finish(ticket, { status: "cancelled" }, null, NOTHING);
      const messages = await posted(w);
      const run = await runOf(w);
      if (messages.length === 1) expect(run).toMatchObject({ status: "done", error: null });
      else expect(run).toMatchObject({ status: "cancelled", error: "owner_spoke" });
      expect(await usageRecords(ticket.id)).toBe(1);
    }
  });
});

describe("the claim", () => {
  it("with the switch off a queued social run ends access_ended at the next claim, announced to its owner; an own run is claimed", async () => {
    const w = await world("off");
    await say(w.v, w.conv, "你好");
    const own = await say(w.owner, w.agent.conversationId, "自己的对话");
    expect(own).toBeGreaterThan(0);
    const config = app.deps.config as { social: { enabled: boolean } };
    const before = config.social;
    config.social = { enabled: false };
    const socket = await connect(app, w.owner);
    try {
      const ticket = await app.agentPort.claimNext();
      expect(ticket).not.toBeNull();
      expect(ticket!.conversationId).toBe(w.agent.conversationId);
      expect(await runOf(w)).toMatchObject({ status: "cancelled", error: "access_ended" });
      // Announced to its owner: the run's end reaches the owner's socket for that conversation.
      await socket.waitFor((e) => e.type === "run" && e.conversationId === w.conv && e.run?.status === "cancelled");
      await app.agentPort.finish(ticket!, { status: "cancelled" }, null, NOTHING);
    } finally {
      config.social = before;
    }
    // Switched on again, nothing answers the old message.
    expect(await app.agentPort.claimNext()).toBeNull();
    expect(await posted(w)).toEqual([]);
  });

  it("m5: the claim itself skips a social run while the switch is off, even one queued after the sweep (the sweep is neutralised here)", async () => {
    const w = await world("filter");
    await say(w.v, w.conv, "你好");
    const config = app.deps.config as { social: { enabled: boolean } };
    const before = config.social;
    config.social = { enabled: false };
    const port = app.agentPort as unknown as { endQueuedSocial: () => Promise<void> };
    const sweep = port.endQueuedSocial;
    port.endQueuedSocial = async () => {};
    try {
      expect(await app.agentPort.claimNext()).toBeNull();
      expect(await runOf(w)).toMatchObject({ status: "queued" });
    } finally {
      port.endQueuedSocial = sweep;
      config.social = before;
    }
    // Switched on again: the same run is claimed as usual.
    const ticket = await app.agentPort.claimNext();
    expect(ticket).not.toBeNull();
    expect(ticket!.conversationId).toBe(w.conv);
    await app.agentPort.finish(ticket!, { status: "cancelled" }, null, NOTHING);
  });
});
