import { afterEach, describe, expect, it } from "vitest";
import { createAgentPort, type DbAgentPort, type Toolbox } from "../src/agents/port-impl.ts";
import { isRunEnd, type RunTicket } from "../src/agents/runtime/port.ts";
import { groupSystemText, HOW_TOLD, NO_NOTES, NO_TOOLS, REPLY_LANGUAGE, systemText, toolsPassage } from "../src/agents/runtime/prompt.ts";
import { createAgentWorker, type AgentWorker } from "../src/agents/runtime/worker.ts";
import type { Config } from "../src/config.ts";
import type { ModelCall, ToolSpec } from "../src/models/gateway.ts";
import { markToolsOff } from "../src/providers/store.ts";
import { api, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { providerBody } from "./helpers/providers.ts";
import { closeAllSockets, connect, type Push, type TestSocket } from "./helpers/ws.ts";

/**
 * Which models a reply offers tools (design 13, decision 10): every model is given them until it is found unable — a
 * site model unless its configuration says `tools: false` (the operator's, never rewritten), a provider's model unless its
 * owner's list says `tools: false`, which the service writes itself the first time a reply finds the model cannot use
 * them (the upstream refused them, or it called them garbled twice), telling its owner once with a whisper in the reply's
 * conversation. Its owner can turn it on again; nothing else changes it. A reply whose model is not offered tools is the
 * reply it always was, its system text saying it has none; one that is offered them is not told it has none. On the
 * real port, hub and database, with a toolbox the test gives the port.
 */

const SITE = JSON.parse(SITE_ENV.SITE_MODELS) as Array<Record<string, unknown>>;
/** The test's site models: `fast` and `thinker` (no `tools`: given them) and `plain_site`, configured `tools: false`. */
const ENV = { ...SITE_ENV, SITE_MODELS: JSON.stringify([...SITE, { ...SITE[0], id: "plain_site", label: "Plain", model: "plain-1", tools: false }]) };

const gateway = scriptedGateway();
const logLines: string[] = [];
/** What the provider's model list says (`POST /api/providers/:id/models/refresh`). */
const listing = { names: ["pm", "other"] };
const { app, db } = useApp({
  env: ENV,
  models: gateway,
  agentWorker: false,
  logStream: { write: (line) => void logLines.push(line) },
  providerProbe: { test: async () => {}, listModels: async () => [...listing.names] },
});

afterEach(async () => {
  await closeAllSockets();
  expect(gateway.pending()).toBe(0);
  logLines.length = 0;
});

/** The whisper's words, verbatim (task 5's copy). */
const TOOLS_OFF = "这个模型不支持查东西，已改为普通聊天。可以在模型设置里重新打开再试。";
const FAST = { source: "site", id: "fast" } as const;
const PLAIN_SITE = { source: "site", id: "plain_site" } as const;

const SEARCH: ToolSpec = {
  name: "search",
  description: "Search this conversation's messages.",
  parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
};
/** How many times the toolbox was asked what a run is offered. */
let offers = 0;
const toolbox: Toolbox = {
  offer: () => {
    offers++;
    return { tools: [SEARCH], perTool: { search: 6 }, kinds: { search: "search" } };
  },
  run: async () => ({ output: { hits: [] } }),
};

/** A port of the app's own with the toolbox, and a worker on it run by hand. */
function toolWorker(config: Config = app.deps.config): { port: DbAgentPort; worker: AgentWorker } {
  const { db: pool, blobs, conversations, reads } = app.deps;
  const port = createAgentPort({ db: pool, config, blobs, realtime: app.realtime, conversations, reads, log: app.log, toolbox });
  const worker = createAgentWorker({ port, models: gateway, runTimeoutMs: config.agentRunTimeoutMs, maxRunsInFlight: 1, background: false, log: app.log, tools: config.tools });
  return { port, worker };
}
/** One reply, worked by a fresh tool worker. */
const work = async (config?: Config) => expect(await toolWorker(config).worker.runOnce()).toBe(true);

let txn = 0;
const say = async (who: Actor, conv: string, text: string): Promise<number> => {
  const sent = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `tc${++txn}` });
  if (sent.status !== 201) throw new Error(`say: ${sent.status} ${JSON.stringify(sent.json)}`);
  return sent.json.message.seq as number;
};

/** A provider of `owner`'s with `models` (default `pm` and `pm2`, neither saying anything of tools). */
async function provider(owner: Actor, models: Array<Record<string, unknown>> = [{ name: "pm" }, { name: "pm2" }]): Promise<string> {
  const made = await api(app, owner, "POST", "/api/providers", providerBody({ models }));
  expect(made.status).toBe(201);
  return made.json.id as string;
}
const onProvider = (providerId: string, model = "pm") => ({ source: "provider", providerId, model }) as const;
/** An Agent of a new person's on their provider's model `pm`. */
async function providerAgent(name: string, over: Record<string, unknown> = {}) {
  const owner = await signUp(app, name);
  const providerId = await provider(owner);
  const agent = await mustCreateAgent(app, owner, { model: onProvider(providerId), persona: "简短地回答。", ...over });
  return { owner, providerId, agent, own: agent.conversationId as string };
}

/** The provider's `models` as stored. */
const storedModels = async (providerId: string) =>
  (await db.query<{ models: Array<Record<string, unknown>> }>("select models from providers where id = $1", [providerId])).rows[0]!.models;
const whispersOf = async (ownerId: string) =>
  (
    await db.query<{ conversation_id: string; agent_id: string; kind: string; body: unknown; status: string; after_seq: string }>(
      "select conversation_id, agent_id, kind, body, status, after_seq from whispers where owner_id = $1 order by created_at, id",
      [ownerId],
    )
  ).rows;
const allWhispers = async () => Number((await db.query<{ n: string }>("select count(*) n from whispers")).rows[0]!.n);
const bodyOf = async (conv: string, seq: number) =>
  (await db.query<{ body: Record<string, unknown> }>("select body from messages where conversation_id = $1 and seq = $2", [conv, seq])).rows[0]!.body;
const lastRun = async (agentId: string) =>
  (await db.query<{ id: string; status: string; input_estimate: number | null }>("select id, status, input_estimate from agent_runs where agent_id = $1 order by created_at desc limit 1", [agentId])).rows[0]!;
/** The provider as its owner reads it: the model `name`'s entry. */
async function wireModel(owner: Actor, providerId: string, name: string) {
  const listed = await api(app, owner, "GET", "/api/providers");
  return (listed.json.providers.find((p: { id: string }) => p.id === providerId).models as Array<{ name: string }>).find((m) => m.name === name);
}
/** A call as made, without what tests cannot compare (its signal). */
const sent = (call: ModelCall) => {
  const { signal: _signal, ...rest } = call;
  return rest;
};
/** Asserts the call offered nothing and says the model has none: what a reply sends that was never offered tools. */
function plainCall(call: ModelCall) {
  expect(Object.keys(sent(call)).filter((k) => ["tools", "toolChoice", "steps"].includes(k))).toEqual([]);
  expect(call.system).toContain(NO_TOOLS);
}
const whisperFrames = (socket: TestSocket): Push[] => socket.events.filter((e) => e.type === "whisper");

describe("a provider's model: given tools until it is found unable, then marked once, and its owner told once", () => {
  it("a model whose entry says nothing of tools is offered them, and its reply is not told it has none", async () => {
    const { owner, providerId, own } = await providerAgent("ada");
    await say(owner, own, "上次说的那家店叫什么？");
    gateway.reply("叫蜀香。");
    const before = offers;
    await work();
    expect(offers).toBe(before + 1);
    expect(gateway.calls.at(-1)!.tools).toEqual([SEARCH]);
    expect(gateway.calls.at(-1)!.system).not.toContain(NO_TOOLS);
    // Nothing is written of it while it copes: its entry, as stored and as its owner reads it, has no `tools`.
    expect((await storedModels(providerId)).map((m) => "tools" in m)).toEqual([false, false]);
    expect(await wireModel(owner, providerId, "pm")).not.toHaveProperty("tools");
  });

  it("refused by its upstream once: `tools: false` on that model only, one whisper to its owner after their message (no buttons), the reply posted; the next reply is sent no tools and told it has none, as one never offered any", async () => {
    const { owner, providerId, agent, own } = await providerAgent("bea");
    const socket = await connect(app, owner);
    const askSeq = await say(owner, own, "帮我查一下上周说的事。");
    gateway.refuseTools("我直接回答：没有找到。");
    await work();
    expect(await bodyOf(own, askSeq + 1)).toEqual({ text: "我直接回答：没有找到。" });
    // The call offered the tools with the text for them, and gave the text the gateway sends when it goes without them.
    const refused = gateway.calls.at(-1)!;
    expect(refused.system).not.toContain(NO_TOOLS);

    const stored = await storedModels(providerId);
    expect(stored.map((m) => [m.name, m.tools])).toEqual([
      ["pm", false],
      ["pm2", undefined],
    ]);
    expect(await whispersOf(owner.id)).toEqual([
      { conversation_id: own, agent_id: agent.id, kind: "tools_off", body: { text: TOOLS_OFF, actions: [] }, status: "open", after_seq: String(askSeq) },
    ]);
    const frame = await socket.next((e) => e.type === "whisper");
    expect(frame.whisper).toMatchObject({ conversationId: own, agentId: agent.id, afterSeq: askSeq, kind: "tools_off", text: TOOLS_OFF, actions: [], status: "open" });
    expect(await wireModel(owner, providerId, "pm")).toMatchObject({ name: "pm", tools: false });
    expect(await wireModel(owner, providerId, "pm2")).not.toHaveProperty("tools");

    // The next reply: no tools offered (the toolbox is not even asked), the sentence that it has none, an estimate
    // recorded for settlement to learn from, as for any reply offered none.
    await say(owner, own, "那算了，换个话题。");
    gateway.reply("好的。");
    const before = offers;
    await work();
    expect(offers).toBe(before);
    plainCall(gateway.calls.at(-1)!);
    // The text the refused call gave for going without tools is the one a reply never offered them is sent, word for word.
    expect(refused.systemWithoutTools).toBe(gateway.calls.at(-1)!.system);
    expect(gateway.calls.at(-1)).not.toHaveProperty("systemWithoutTools");
    expect((await lastRun(agent.id)).input_estimate).not.toBeNull();
    // Told once.
    expect(await whispersOf(owner.id)).toHaveLength(1);
    expect(whisperFrames(socket)).toHaveLength(1);
  });

  it("garbled twice in one reply: marked and told as for a refusal, the reply still answers; the next reply is sent none", async () => {
    const { owner, providerId, own } = await providerAgent("cai");
    await say(owner, own, "查一下。");
    gateway.callTools([
      { name: "no_such_tool", input: {} },
      { name: "search", input: { query: 42 } },
    ]);
    gateway.reply("没查到，我直接说吧。");
    await work();
    // The reply's last call (the tool phase ended at the second garbled call) and what it posted.
    expect(gateway.calls.at(-1)!.toolChoice).toBe("none");
    expect((await storedModels(providerId)).find((m) => m.name === "pm")!.tools).toBe(false);
    expect((await whispersOf(owner.id)).map((w) => [w.kind, w.body])).toEqual([["tools_off", { text: TOOLS_OFF, actions: [] }]]);

    await say(owner, own, "好。");
    gateway.reply("嗯。");
    await work();
    plainCall(gateway.calls.at(-1)!);
  });

  it("turned on again by its owner: an edit or a sync that does not name it keeps it off; `tools: true` offers them again, and a refusal then marks it and tells its owner again", async () => {
    const { owner, providerId, own } = await providerAgent("dov");
    await say(owner, own, "查一下。");
    gateway.refuseTools("直接答。");
    await work();
    expect(await wireModel(owner, providerId, "pm")).toMatchObject({ tools: false });

    // An edit of the list that says nothing of it (an older form) keeps what is stored, and so does 同步模型.
    const edited = await api(app, owner, "PATCH", `/api/providers/${providerId}`, { models: [{ name: "pm", vision: true }, { name: "pm2" }] });
    expect(edited.status).toBe(200);
    expect(edited.json.models.find((m: { name: string }) => m.name === "pm")).toMatchObject({ vision: true, tools: false });
    const synced = await api(app, owner, "POST", `/api/providers/${providerId}/models/refresh`);
    expect(synced.status).toBe(200);
    expect(synced.json.provider.models.map((m: { name: string; tools?: boolean }) => [m.name, m.tools])).toEqual([
      ["pm", false],
      ["pm2", undefined],
      ["other", undefined],
    ]);
    await say(owner, own, "再问。");
    gateway.reply("答。");
    await work();
    plainCall(gateway.calls.at(-1)!);

    // Its owner turns it on: the next reply is offered the tools again.
    const on = await api(app, owner, "PATCH", `/api/providers/${providerId}`, { models: [{ name: "pm", vision: true, tools: true }, { name: "pm2" }, { name: "other" }] });
    expect(on.status).toBe(200);
    expect(on.json.models.find((m: { name: string }) => m.name === "pm")).toMatchObject({ tools: true });
    await say(owner, own, "现在再查查？");
    gateway.refuseTools("还是不行，直接答。");
    await work();
    expect(gateway.calls.at(-1)!.tools).toEqual([SEARCH]);
    // Found unable once more: off again, and its owner told again (they asked to try).
    expect((await storedModels(providerId)).find((m) => m.name === "pm")!.tools).toBe(false);
    expect(await whispersOf(owner.id)).toHaveLength(2);
  });

  it("two replies finding it out at the same moment write it once and tell its owner once", async () => {
    const owner = await signUp(app, "eve");
    const providerId = await provider(owner);
    const a = await mustCreateAgent(app, owner, { model: onProvider(providerId), persona: "甲。" });
    const b = await mustCreateAgent(app, owner, { model: onProvider(providerId), persona: "乙。" });
    await say(owner, a.conversationId, "问甲");
    await say(owner, b.conversationId, "问乙");
    const { port } = toolWorker();
    const runs: RunTicket[] = [];
    for (let i = 0; i < 2; i++) {
      const run = await port.claimNext();
      expect(run).not.toBeNull();
      expect(isRunEnd(await port.begin(run!))).toBe(false);
      runs.push(run!);
    }
    await Promise.all([port.toolsUnusable(runs[0]!, "refused"), port.toolsUnusable(runs[1]!, "garbled")]);
    expect((await storedModels(providerId)).find((m) => m.name === "pm")!.tools).toBe(false);
    expect(await whispersOf(owner.id)).toHaveLength(1);
    for (const run of runs) await port.release(run);
  });

  it("marking waits for another transaction marking the same model, and then finds nothing to write", async () => {
    const owner = await signUp(app, "fay");
    const providerId = await provider(owner);
    let release!: () => void;
    const gate = new Promise<void>((done) => (release = done));
    let marked!: (value: boolean) => void;
    const firstMarked = new Promise<boolean>((done) => (marked = done));
    const first = db.tx(async (t) => {
      marked(await markToolsOff(t, owner.id, providerId, "pm"));
      await gate;
    });
    expect(await firstMarked).toBe(true);
    const second = db.tx((t) => markToolsOff(t, owner.id, providerId, "pm"));
    // The second waits for the first's row lock.
    let waiting = false;
    for (let i = 0; i < 150 && !waiting; i++) {
      const { rows } = await db.query<{ n: string }>(
        "select count(*) n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%from providers where id = $1 and owner_id = $2 for no key update%'",
      );
      waiting = Number(rows[0]!.n) > 0;
      if (!waiting) await new Promise((r) => setTimeout(r, 20));
    }
    expect(waiting).toBe(true);
    release();
    await first;
    expect(await second).toBe(false);
    // Nothing to write for a model not listed, a provider not theirs, or one marked already.
    const stranger = await signUp(app, "gus");
    expect(await db.tx((t) => markToolsOff(t, owner.id, providerId, "nope"))).toBe(false);
    expect(await db.tx((t) => markToolsOff(t, stranger.id, providerId, "pm2"))).toBe(false);
    expect(await db.tx((t) => markToolsOff(t, owner.id, providerId, "pm"))).toBe(false);
    expect((await storedModels(providerId)).map((m) => [m.name, m.tools])).toEqual([
      ["pm", false],
      ["pm2", undefined],
    ]);
  });

  it("in a group: the whisper is its owner's alone — no frame, key or count reaches the other member, who gets the reply as ever", async () => {
    const [mia, owner] = [await signUp(app, "mia"), await signUp(app, "hal")];
    const providerId = await provider(owner);
    const agent = await mustCreateAgent(app, owner, { handle: "hal_bot", model: onProvider(providerId), persona: "简短地回答。" });
    const g = await group(app, mia, "饭搭子", [owner, await signUp(app, "hal_friend")]);
    expect((await api(app, owner, "POST", `/api/conversations/${g}/members`, { principalId: agent.id })).status).toBe(201);
    const sockets = { owner: await connect(app, owner), mia: await connect(app, mia) };
    const before = { sync: (await api(app, mia, "GET", "/api/sync")).json, conversation: (await api(app, mia, "GET", `/api/conversations/${g}`)).json };
    const askSeq = await say(mia, g, "@hal_bot 周末吃什么？");
    gateway.refuseTools("火锅。");
    await work();
    const frame = await sockets.owner.next((e) => e.type === "whisper");
    expect(frame.whisper).toMatchObject({ conversationId: g, agentId: agent.id, afterSeq: askSeq, kind: "tools_off", text: TOOLS_OFF, actions: [] });
    await sockets.mia.waitFor((e) => e.type === "message" && e.message.seq === askSeq + 1);
    await sockets.mia.waitFor((e) => e.type === "run" && e.conversationId === g && e.state === null);
    for (const e of sockets.mia.events) {
      const text = JSON.stringify(e);
      expect([e.type, text.includes(TOOLS_OFF), text.includes(frame.whisper.id), text.includes("whisper"), text.includes("tools")]).toEqual([e.type, false, false, false, false]);
    }
    // Her reads: as before, but for the reply.
    const sync = (await api(app, mia, "GET", "/api/sync")).json;
    const conversation = (await api(app, mia, "GET", `/api/conversations/${g}`)).json;
    for (const body of [sync, conversation]) {
      const text = JSON.stringify(body);
      expect([text.includes(TOOLS_OFF), text.includes(frame.whisper.id), text.includes('"whispers"'), text.includes('"tools"')]).toEqual([false, false, false, false]);
    }
    expect(Object.keys(sync).sort()).toEqual(Object.keys(before.sync).sort());
    expect(Object.keys(conversation).sort()).toEqual(Object.keys(before.conversation).sort());
    expect((await api(app, mia, "GET", `/api/conversations/${g}/whispers`)).status).toBe(404);
  });

  it("its owner left the group while the reply ran: the model is still marked, and no whisper is made", async () => {
    const [mia, owner] = [await signUp(app, "ivy"), await signUp(app, "jon")];
    const providerId = await provider(owner);
    const agent = await mustCreateAgent(app, owner, { handle: "jon_bot", model: onProvider(providerId), persona: "简短地回答。" });
    const g = await group(app, mia, "书友", [owner, await signUp(app, "jon_friend")]);
    expect((await api(app, owner, "POST", `/api/conversations/${g}/members`, { principalId: agent.id })).status).toBe(201);
    await say(mia, g, "@jon_bot 在吗？");
    const { port } = toolWorker();
    const run = (await port.claimNext())!;
    expect(isRunEnd(await port.begin(run))).toBe(false);
    expect((await api(app, owner, "DELETE", `/api/conversations/${g}/members/${owner.id}`)).status).toBe(200);
    await port.toolsUnusable(run, "refused");
    expect((await storedModels(providerId)).find((m) => m.name === "pm")!.tools).toBe(false);
    expect(await whispersOf(owner.id)).toEqual([]);
    await port.release(run);
  });

  it("a whisper that offers no button: on the wire with `actions: []`, answered by neither route, and not counted in the conversation entry as one waiting for its owner", async () => {
    const { owner, own } = await providerAgent("kai");
    await say(owner, own, "查一下。");
    gateway.refuseTools("直接答。");
    await work();
    const synced = (await api(app, owner, "GET", "/api/sync")).json;
    const told = synced.whispers.filter((w: { kind: string }) => w.kind === "tools_off");
    expect(told).toEqual([expect.objectContaining({ conversationId: own, text: TOOLS_OFF, actions: [], status: "open" })]);
    expect(synced.conversations.find((c: { id: string }) => c.id === own)).not.toHaveProperty("whispers");
    expect((await api(app, owner, "GET", `/api/conversations/${own}`)).json).not.toHaveProperty("whispers");
    expect((await api(app, owner, "GET", `/api/conversations/${own}/whispers`)).json.whispers).toEqual(told);
    for (const verb of ["accept", "decline"]) {
      expect(await api(app, owner, "POST", `/api/whispers/${told[0].id}/${verb}`)).toEqual({ status: 409, json: { error: "stale_whisper" } });
    }
  });
});

describe("a site model: the operator's word, never rewritten", () => {
  it("configured `tools: false`: its replies are offered none (the toolbox is not asked) and say they have none; `GET /api/models` carries the flag of every site model", async () => {
    const owner = await signUp(app, "lia");
    const agent = await mustCreateAgent(app, owner, { model: PLAIN_SITE, persona: "简短地回答。" });
    await say(owner, agent.conversationId, "你好");
    gateway.reply("你好。");
    const before = offers;
    await work();
    expect(offers).toBe(before);
    plainCall(gateway.calls.at(-1)!);
    expect((await lastRun(agent.id)).input_estimate).not.toBeNull();
    const models = (await api(app, owner, "GET", "/api/models")).json;
    expect(models.siteModels.map((m: { id: string; tools: boolean }) => [m.id, m.tools])).toEqual([
      ["fast", true],
      ["thinker", true],
      ["plain_site", false],
    ]);
  });

  it("refused by its upstream: the reply is posted, its configuration stays as it is, nobody is told, and one metric line names the model and nothing else", async () => {
    const owner = await signUp(app, "max");
    const agent = await mustCreateAgent(app, owner, { model: FAST, persona: "简短地回答。" });
    const socket = await connect(app, owner);
    const askSeq = await say(owner, agent.conversationId, "查一下。");
    gateway.refuseTools("直接答。");
    await work();
    expect(await bodyOf(agent.conversationId, askSeq + 1)).toEqual({ text: "直接答。" });
    expect(app.deps.config.siteModels.find((m) => m.id === "fast")!.tools).toBe(true);
    expect(await allWhispers()).toBe(0);
    await socket.waitFor((e) => e.type === "run" && e.run?.status === "done");
    expect(whisperFrames(socket)).toEqual([]);
    const metrics = logLines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((l) => l.metric === "tools_refused_site");
    expect(metrics).toHaveLength(1);
    const { level: _level, time: _time, pid: _pid, hostname: _hostname, msg: _msg, ...fields } = metrics[0]!;
    expect(fields).toEqual({ metric: "tools_refused_site", model: "fast" });
    // Still offered them next time: the configuration is the operator's.
    await say(owner, agent.conversationId, "再试。");
    gateway.reply("好。");
    await work();
    expect(gateway.calls.at(-1)!.tools).toEqual([SEARCH]);
  });

  it("`TOOLS.enabled` false comes first: nothing is asked of the toolbox, whatever the model", async () => {
    const owner = await signUp(app, "ned");
    const agent = await mustCreateAgent(app, owner, { model: FAST, persona: "简短地回答。" });
    await say(owner, agent.conversationId, "你好");
    gateway.reply("你好。");
    const before = offers;
    await work({ ...app.deps.config, tools: { ...app.deps.config.tools, enabled: false } });
    expect(offers).toBe(before);
    plainCall(gateway.calls.at(-1)!);
  });
});

describe("the provider wire carries the flag", () => {
  it("as given when a provider is made: `tools` only where it was given, a boolean or a 400", async () => {
    const owner = await signUp(app, "oda");
    const made = await api(app, owner, "POST", "/api/providers", providerBody({ models: [{ name: "a", tools: false }, { name: "b", tools: true }, { name: "c" }] }));
    expect(made.status).toBe(201);
    expect(made.json.models.map((m: { name: string; tools?: boolean }) => [m.name, m.tools, "tools" in m])).toEqual([
      ["a", false, true],
      ["b", true, true],
      ["c", undefined, false],
    ]);
    expect((await api(app, owner, "POST", "/api/providers", providerBody({ name: "其他", models: [{ name: "x", tools: "yes" }] }))).status).toBe(400);
    expect((await api(app, owner, "PATCH", `/api/providers/${made.json.id}`, { models: [{ name: "a", tools: 1 }] })).status).toBe(400);
  });
});

describe("the system text says the reply has no tools only when it is offered none", () => {
  const agent = { name: "小助手", persona: "简短地回答。", ownerAppellation: null };
  const owner = { displayName: "Ada" };
  const now = new Date("2026-11-20T08:00:00Z");
  const scene = { title: "饭搭子", agents: [], more: false, people: [], morePeople: false };
  /**
   * `text` with the tools' passage (`toolsPassage`) in place of the line holding the sentence, and what only a reply
   * offered tools is told besides (lane prompt2): the language it replies in before the passage, and in a group, at the
   * end of what it must never reveal, that it does not explain how it tells who is who.
   */
  const withPassage = (text: string, group: boolean) => {
    expect(text.split("\n")).toContain(NO_TOOLS);
    const passage = text.replace(NO_TOOLS, `${REPLY_LANGUAGE}\n${toolsPassage(group)}`);
    return group ? passage.replace("就说这些不能透露。", `就说这些不能透露。${HOW_TOLD}`) : passage;
  };

  it("in the Agent's own conversation, onboarding too, and in a group: as it always was without tools; with tools, the same with the tools' passage in place of that sentence", () => {
    for (const mode of ["normal", "onboarding"] as const) {
      const was = systemText(agent, owner, now, mode, "Asia/Shanghai", NO_NOTES);
      expect(systemText(agent, owner, now, mode, "Asia/Shanghai", NO_NOTES, false)).toEqual(was);
      expect(was.text).toContain(NO_TOOLS);
      const offered = systemText(agent, owner, now, mode, "Asia/Shanghai", NO_NOTES, true);
      expect(offered.text).toBe(withPassage(was.text, false));
      expect(offered.text).not.toContain(NO_TOOLS);
    }
    const g = { ...agent, handle: "helper" };
    const was = groupSystemText(g, owner, scene, now, "Asia/Shanghai", "Q7", false, NO_NOTES);
    expect(groupSystemText(g, owner, scene, now, "Asia/Shanghai", "Q7", false, NO_NOTES, false)).toEqual(was);
    expect(groupSystemText(g, owner, scene, now, "Asia/Shanghai", "Q7", false, NO_NOTES, true).text).toBe(withPassage(was.text, true));
  });

  it("a reply in a group offered tools is not told it has none; one whose model is not offered them is", async () => {
    const [mia, owner] = [await signUp(app, "pia"), await signUp(app, "rex")];
    const agent = await mustCreateAgent(app, owner, { handle: "rex_bot", model: FAST, persona: "简短地回答。" });
    const plain = await mustCreateAgent(app, owner, { handle: "rex_plain", model: PLAIN_SITE, persona: "简短地回答。" });
    const g = await group(app, mia, "群", [owner, await signUp(app, "rex_friend")]);
    for (const a of [agent, plain]) expect((await api(app, owner, "POST", `/api/conversations/${g}/members`, { principalId: a.id })).status).toBe(201);
    await say(mia, g, "@rex_bot 你好");
    gateway.reply("你好。");
    await work();
    expect(gateway.calls.at(-1)!.tools).toEqual([SEARCH]);
    expect(gateway.calls.at(-1)!.system).not.toContain(NO_TOOLS);
    await say(mia, g, "@rex_plain 你好");
    gateway.reply("你好呀。");
    await work();
    plainCall(gateway.calls.at(-1)!);
  });
});
