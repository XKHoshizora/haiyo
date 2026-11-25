import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentPort, recoverRuns, sweepStaleRuns } from "../src/agents/port-impl.ts";
import { createWhisper, expireWhispers, type HitRow } from "../src/whispers/store.ts";
import { changeSweep } from "../src/app.ts";
import { NO_TOOLS, TOLD_NO_TOOLS, TOOL_MATERIAL } from "../src/agents/runtime/prompt.ts";
import { createAgentWorker, type AgentWorker } from "../src/agents/runtime/worker.ts";
import { createElsewhere, ELSEWHERE_HITS_MAX, FOUND_ELSEWHERE, TELL_HOW, TELL_THEM, hitOf, toldPassage, type ElsewhereDeps, type ElsewhereHook } from "../src/agents/tools/elsewhere.ts";
import { RunRefs } from "../src/agents/tools/refs.ts";
import { createToolbox, SEARCH_MESSAGES, type ToolDeps } from "../src/agents/tools/index.ts";
import { excerptAt, matchAt } from "../src/agents/tools/search.ts";
import { QUOTE_MAX_CHARS } from "../src/agents/runtime/context.ts";
import type { Db } from "../src/db.ts";
import type { ModelCall } from "../src/models/gateway.ts";
import { api, befriend, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { closeAllSockets, connect, type TestSocket } from "./helpers/ws.ts";

/**
 * "Not in this group, but I have it elsewhere" (Task 8; design rules 17, 18, decision 9): in a group, when a reply's search
 * finds nothing there and its Agent's `whisperElsewhere` is on, the same words are looked for once more — on their own,
 * after the search has answered — in the Agent's other conversations that its owner can read now; hits become one whisper
 * to the owner (`告诉他们` / `不用`). The run's model is told nothing, and no one else learns anything. `告诉他们` queues one
 * reply of the Agent in the group, its owner's own, that is shown the hits and offered no tools. Redesign D: the whisper keeps
 * references to the messages it found (read under its owner's access now, whenever it is shown or told), and its state is
 * derived — telling while a told reply of it is queued or running, told once one has posted; nothing stores either.
 */

const gateway = scriptedGateway();
const { app, db } = useApp({ env: SITE_ENV, models: gateway, agentWorker: false, tools: true });
afterEach(async () => {
  await closeAllSockets();
  expect(gateway.pending()).toBe(0);
});

const FAST = { source: "site", id: "fast" } as const;
const CANARY = "CANARY-ew 蓝鲸计划在三楼";
const OWN_NOTE = "记一下：蓝鲸计划的口令是七七";
const HOUR = 3_600_000;

/** Every statement sent through `real`, its transactions' too. */
function spyDb(real: Db): { db: Db; sql: string[] } {
  const sql: string[] = [];
  const spied = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(t, prop) {
        const value = Reflect.get(t, prop, t);
        if (prop === "query") return (text: unknown, params?: unknown) => (sql.push(typeof text === "string" ? text : String((text as { text?: string }).text)), (value as Function).call(t, text, params));
        return typeof value === "function" ? value.bind(t) : value;
      },
    });
  return { sql, db: { pool: real.pool, query: spied(real).query, tx: (fn) => real.tx((client) => fn(spied(client))), close: () => real.close() } as Db };
}
const searchesIn = (sql: string[]) => sql.filter((s) => /ilike/i.test(s)).length;

function elsewhereDeps(over: Partial<ElsewhereDeps> = {}): ElsewhereDeps {
  return { db: app.deps.db, config: app.deps.config, realtime: app.realtime, log: app.log, ...over };
}
/**
 * Each socket's frames once everything pushed before now has reached it (one socket's pushes keep their order): `who`
 * sends a message in `conversationId`, and every socket waits for its frame.
 */
async function settled(sockets: TestSocket[], who: Actor, conversationId: string): Promise<void> {
  const last = await say(who, conversationId, "收尾");
  for (const s of sockets) await s.waitFor((e) => e.type === "message" && e.message.conversationId === conversationId && e.message.seq === last);
}
function toolDeps(elsewhere: ElsewhereHook, d: Db = app.deps.db): ToolDeps {
  const { config, searches, blobs } = app.deps;
  return { db: d, blobs, searches, config, log: app.log, elsewhere };
}
function toolWorker(d: ToolDeps): AgentWorker {
  const { db: pool, blobs, conversations, reads, config } = app.deps;
  const port = createAgentPort({ db: pool, config, blobs, realtime: app.realtime, conversations, reads, log: app.log, toolbox: createToolbox(d) });
  return createAgentWorker({ port, models: gateway, runTimeoutMs: config.agentRunTimeoutMs, maxRunsInFlight: 1, background: false, log: app.log, tools: config.tools });
}

let txn = 0;
const say = async (who: Actor, conv: string, text: string): Promise<number> => {
  const sent = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `we${++txn}` });
  if (sent.status !== 201) throw new Error(`say: ${sent.status} ${JSON.stringify(sent.json)}`);
  return sent.json.message.seq as number;
};
const outputs = (call: ModelCall): unknown[] => (call.steps ?? []).flatMap((s) => s.results.map((r) => r.output));
type Ref = { conversationId: string; seq: number; at: number };
/** The owner's whispers of a conversation as their rows hold them, oldest first. */
const whispersOf = async (ownerId: string, conv: string) =>
  (await db.query<{ id: string; status: string; body: { text: string; actions: string[]; detail?: { hits: Ref[]; askedSeq?: number } } }>(
    "select id, status, body from whispers where owner_id = $1 and conversation_id = $2 order by created_at",
    [ownerId, conv],
  )).rows;
type WireHit = { where: string; who: string; when: string; text: string; mentions: Array<{ id: string; start: number; length: number }> };
/** A whisper as its owner reads it now (the list route). */
const wireOf = async (owner: Actor, conv: string, id: string) =>
  (await api(app, owner, "GET", `/api/conversations/${conv}/whispers`)).json.whispers.find((x: { id: string }) => x.id === id) as
    | { id: string; status: string; actions: string[]; lastTellFailed?: boolean; revision: number; detail?: { hits: WireHit[] } }
    | undefined;
const runsOf = async (agentId: string, conv: string) =>
  (await db.query<{ id: string; status: string; lane: string; triggered_by: string; caller_id: string | null; whisper_id: string | null }>(
    "select id, status, lane, triggered_by, caller_id, whisper_id from agent_runs where agent_id = $1 and conversation_id = $2 order by created_at",
    [agentId, conv],
  )).rows;
/** What the Agent said in `conv`, as a member reads it. */
const agentSaid = async (w: World, conv: string = w.g) =>
  (await api(app, w.mia, "GET", `/api/conversations/${conv}/messages`)).json.messages.filter((m: { senderId: string }) => m.senderId === w.agent.id);

/**
 * olive and her Agent: in group G with mia and ned, where nothing says 蓝鲸计划; in group B with them too, where the canary is
 * said; and in its own conversation, where olive said something about it too.
 */
async function world() {
  const [owner, mia, ned] = [await signUp(app, "olive"), await signUp(app, "mia"), await signUp(app, "ned")];
  const agent = await mustCreateAgent(app, owner, { handle: "olive_bot", name: "小助手", model: FAST, persona: "简短地回答。" });
  const g = await group(app, owner, "饭搭子", [mia, ned]);
  const b = await group(app, owner, "乙群", [mia, ned]);
  for (const c of [g, b]) expect((await api(app, owner, "POST", `/api/conversations/${c}/members`, { principalId: agent.id })).status).toBe(201);
  await say(mia, b, CANARY);
  await say(owner, agent.conversationId, OWN_NOTE);
  // (The Agent's own conversation: the message started a reply there; it is not this file's business.)
  await db.query("update agent_runs set status = 'cancelled', finished_at = now() where agent_id = $1 and status = 'queued'", [agent.id]);
  return { owner, mia, ned, agent: agent as { id: string; conversationId: string }, g, b };
}
type World = Awaited<ReturnType<typeof world>>;

/** One reply in G, asked by `asker`, whose search (`input`) finds nothing in G: what its model was handed, and the question's seq. */
async function askInGroup(w: World, hook: ElsewhereHook, asker: Actor = w.mia, d?: Db, input: Record<string, unknown> = { query: "蓝鲸计划" }) {
  const asked = await say(asker, w.g, "@olive_bot 上次说的那个计划在哪？");
  gateway.callTools([{ name: SEARCH_MESSAGES, input }]).reply("这个群的记录里没找到。");
  expect(await toolWorker(toolDeps(hook, d)).runOnce()).toBe(true);
  await hook.idle();
  return { output: outputs(gateway.calls.at(-1)!)[0], asked };
}

/** A whisper whose told reply failed (its question's search `input`): the whisper, and the failed told run — the Agent's latest in G. */
async function failedTold(input?: Record<string, unknown>) {
  const w = await world();
  await askInGroup(w, createElsewhere(elsewhereDeps()), w.mia, undefined, input);
  const [whisper] = await whispersOf(w.owner.id, w.g);
  expect((await api(app, w.owner, "POST", `/api/whispers/${whisper!.id}/accept`)).status).toBe(200);
  gateway.fail("provider_unavailable", { status: 502 });
  expect(await app.agentWorker.runOnce()).toBe(true);
  const told = (await runsOf(w.agent.id, w.g)).at(-1)!;
  return { w, whisper: whisper!, told };
}
/** The Agent's slot in G as `who` reads it (`GET …/runs`); its owner's own run there. */
const slotOf = async (w: World, who: Actor) => (await api(app, who, "GET", `/api/conversations/${w.g}/runs`)).json;
const ownSlot = async (w: World) => (await slotOf(w, w.owner)).runs.find((e: { agentId: string }) => e.agentId === w.agent.id)?.run;

describe("a search in a group that finds nothing there", () => {
  it("item E: a real question holding its own search words is not its own result — nothing is found in the group, and the whisper is made", async () => {
    const w = await world();
    const hook = createElsewhere(elsewhereDeps());
    await say(w.mia, w.g, "@olive_bot 查一下群里有没有人说过蓝鲸计划");
    gateway.callTools([{ name: SEARCH_MESSAGES, input: { query: "蓝鲸计划" } }]).reply("这个群的记录里没找到。");
    expect(await toolWorker(toolDeps(hook)).runOnce()).toBe(true);
    await hook.idle();
    expect(outputs(gateway.calls.at(-1)!)[0]).toEqual({ results: [], note: "这个群的记录里没找到。" });
    const [made] = await whispersOf(w.owner.id, w.g);
    expect(made).toMatchObject({ status: "open", body: { text: FOUND_ELSEWHERE, actions: ["tell", "dismiss"] } });
  });

  it("found elsewhere: one whisper to the owner, keeping references to what it found (never its text or names); she reads the hits; the model is told the plain not-found, and nobody else is sent or shown anything", async () => {
    const w = await world();
    const sockets = { owner: await connect(app, w.owner), mia: await connect(app, w.mia), ned: await connect(app, w.ned) };
    const hook = createElsewhere(elsewhereDeps());
    const { output, asked } = await askInGroup(w, hook);
    expect(output).toEqual({ results: [], note: "这个群的记录里没找到。" });
    const [made] = await whispersOf(w.owner.id, w.g);
    expect(made).toMatchObject({ status: "open", body: { text: FOUND_ELSEWHERE, actions: ["tell", "dismiss"] } });
    // Kept: for each hit the conversation and the message it points at (and where in it the words are), and which message
    // asked — nothing of what was said, where or by whom.
    expect(made!.body.detail).toEqual({
      hits: [
        { conversationId: w.agent.conversationId, seq: expect.any(Number), at: expect.any(Number) },
        { conversationId: w.b, seq: expect.any(Number), at: expect.any(Number) },
      ],
      askedSeq: asked,
    });
    const stored = JSON.stringify(made!.body.detail);
    for (const never of ["CANARY", "蓝鲸计划", "乙群", "你和它的专属会话", "olive", "mia"]) expect([never, stored.includes(never)]).toEqual([never, false]);
    // What she reads (the list route, her push): each hit as it is now — where, who, when, what.
    const wire = await wireOf(w.owner, w.g, made!.id);
    expect(wire!.detail!.hits.map((h) => [h.where, h.who, h.text])).toEqual([
      ["你和它的专属会话", "olive", OWN_NOTE],
      ["乙群", "mia", CANARY],
    ]);
    expect(Object.keys(wire!.detail!.hits[0]!).sort()).toEqual(["mentions", "text", "when", "where", "who"]);
    expect(wire!.detail!.hits.map((h) => h.mentions)).toEqual([[], []]); // (nobody mentioned in either)
    const push = await sockets.owner.next((e) => e.type === "whisper" && e.whisper.id === made!.id);
    expect(push.whisper.detail).toEqual(wire!.detail);
    // Their frames once everything the run and the whisper pushed has reached them.
    await settled([sockets.mia, sockets.ned], w.ned, w.g);
    for (const socket of [sockets.mia, sockets.ned]) {
      expect(JSON.stringify(socket.events)).not.toContain("CANARY-ew");
      expect(socket.events.some((e) => e.type === "whisper")).toBe(false);
    }
    // The model's whole call, and the reply in the group: nothing of it.
    expect(JSON.stringify(gateway.calls.at(-1))).not.toContain("CANARY-ew");
    expect(JSON.stringify((await api(app, w.mia, "GET", `/api/conversations/${w.g}/messages`)).json)).not.toContain("CANARY-ew");
  });

  it("a hit carries the mentions of its message, moved to where they are in the text she is shown; a range the cut took is left out; only its owner is given any of it", async () => {
    const w = await world();
    const mention = `@${w.mia.handle}`;
    const sendWith = async (text: string, mentions: Array<{ id: string; start: number; length: number }>) => {
      const sent = await api(app, w.ned, "POST", `/api/conversations/${w.b}/messages`, { text, clientTxn: `we${++txn}`, mentions });
      expect(sent.status).toBe(201);
      return sent.json.message.seq as number;
    };
    // A short one: the words, with a mention before them, on one line (the break is one space, so the range moves with it).
    const shortText = `${mention}

蓝鲸计划 在三楼`;
    await sendWith(shortText, [{ id: w.mia.id, start: 0, length: mention.length }]);
    // A long one: a mention far before the words (cut away), one near them (kept, moved), one far after them (cut away).
    const before = `${"前".repeat(150)}`;
    const long = `${mention} ${before}${mention} 蓝鲸计划改在周五 ${"后".repeat(300)} ${mention}`;
    const near = long.indexOf(mention, 5);
    await sendWith(long, [
      { id: w.mia.id, start: 0, length: mention.length },
      { id: w.mia.id, start: near, length: mention.length },
      { id: w.mia.id, start: long.length - mention.length, length: mention.length },
    ]);
    const sockets = { owner: await connect(app, w.owner), ned: await connect(app, w.ned) };
    await askInGroup(w, createElsewhere(elsewhereDeps()));
    const [made] = await whispersOf(w.owner.id, w.g);
    const hits = (await wireOf(w.owner, w.g, made!.id))!.detail!.hits.filter((h) => h.who === "ned");
    expect(hits).toHaveLength(2);
    const byText = (needle: string) => hits.find((h) => h.text.includes(needle))!;
    const one = byText("在三楼");
    expect(one.text).toBe(`${mention} 蓝鲸计划 在三楼`);
    expect(one.mentions).toEqual([{ id: w.mia.id, start: 0, length: mention.length }]);
    const two = byText("改在周五");
    expect(two.text.startsWith("…")).toBe(true); // (cut: the first mention is not in it)
    expect(two.mentions).toHaveLength(1);
    for (const m of two.mentions) expect(two.text.slice(m.start, m.start + m.length)).toBe(mention);
    expect(two.mentions[0]!.start).toBeLessThan(two.text.indexOf("蓝鲸计划"));
    // Only its owner is given a thing of it: not the others' frames, not their list, and not what the told reply is handed.
    await sockets.ned.waitFor((e) => e.type === "message");
    expect(sockets.ned.events.some((e) => e.type === "whisper")).toBe(false);
    expect((await api(app, w.ned, "GET", `/api/conversations/${w.g}/whispers`)).json.whispers ?? []).toEqual([]);
    expect(toldPassage([{ where: "x", who: "y", when: "2026-01-01 10:00", text: "hello", mentions: [{ id: w.mia.id, start: 0, length: 3 }] }])).not.toContain(w.mia.id);
    // A member's own sync (the list route, and the frames of a socket that stayed open) holds none of the hit: not its words, not its ranges.
    for (const member of [w.mia, w.ned]) {
      const theirs = JSON.stringify((await api(app, member, "GET", `/api/conversations/${w.g}/whispers`)).json);
      expect([member.handle, theirs.includes("在三楼"), theirs.includes("改在周五"), theirs.includes('"mentions"')]).toEqual([member.handle, false, false, false]);
    }
    expect(JSON.stringify(sockets.ned.events)).not.toContain("改在周五");
  });

  it("telling it: the told run's system text holds the hits' words and times only — no mention id, no range", async () => {
    const w = await world();
    const mention = `@${w.mia.handle}`;
    const sent = await api(app, w.ned, "POST", `/api/conversations/${w.b}/messages`, {
      text: `${mention} 蓝鲸计划改在周五`,
      clientTxn: `we${++txn}`,
      mentions: [{ id: w.mia.id, start: 0, length: mention.length }],
    });
    expect(sent.status).toBe(201);
    await askInGroup(w, createElsewhere(elsewhereDeps()));
    const [made] = await whispersOf(w.owner.id, w.g);
    expect((await wireOf(w.owner, w.g, made!.id))!.detail!.hits.some((h) => h.mentions.some((m) => m.id === w.mia.id))).toBe(true); // (she is given it)
    expect((await api(app, w.owner, "POST", `/api/whispers/${made!.id}/accept`)).status).toBe(200);
    gateway.reply("蓝鲸计划改在周五。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    const call = gateway.calls.at(-1)!;
    expect(call.system).toContain(TELL_THEM);
    expect(call.system).toContain("改在周五");
    for (const never of [w.mia.id, w.ned.id, w.owner.id, '"mentions"', '"start"', '"length"']) expect([never, call.system.includes(never)]).toEqual([never, false]);
  });

  it("a long hit: the place kept (`at`) is where the words are in the text as stored, and what she is shown is cut there — what looks like a citation before them is text, kept, and moves nothing", async () => {
    const w = await world();
    // Before the words, a person's typed numbers (a hundred characters of them) and more: the line is cut for its weight.
    const said = `前面${"〔m1〕说过".repeat(60)}蓝鲸计划改在周五${"后面的话".repeat(60)}`;
    const seq = await say(w.ned, w.b, said);
    await askInGroup(w, createElsewhere(elsewhereDeps()));
    const [made] = await whispersOf(w.owner.id, w.g);
    const ref = made!.body.detail!.hits.find((h) => h.conversationId === w.b && h.seq === seq)!;
    expect(ref.at).toBe(matchAt(said, "蓝鲸计划"));
    expect(ref.at).toBeGreaterThan(300);
    const hit = (await wireOf(w.owner, w.g, made!.id))!.detail!.hits.find((h) => h.who === "ned")!;
    expect(hit.text).toBe(Array.from(excerptAt(said, ref.at)).slice(0, QUOTE_MAX_CHARS).join(""));
    expect(hit.text).toContain("蓝鲸计划改在周五");
    expect(hit.text).toContain("〔m1〕说过");
    expect(hit.text.startsWith("…")).toBe(true);
  });

  it("the model's tool result is the same, byte for byte, whether anything was found elsewhere or not", async () => {
    const w = await world();
    const hook = createElsewhere(elsewhereDeps());
    const withHits = (await askInGroup(w, hook)).output;
    await db.query("update agents set whisper_elsewhere = false where principal_id = $1", [w.agent.id]);
    const without = (await askInGroup(w, hook)).output;
    expect(JSON.stringify(withHits)).toBe(JSON.stringify(without));
  });

  it("nothing found elsewhere either: no whisper", async () => {
    const w = await world();
    const hook = createElsewhere(elsewhereDeps());
    await say(w.mia, w.g, "@olive_bot 有那个东西吗？");
    gateway.callTools([{ name: SEARCH_MESSAGES, input: { query: "哪里都没有的词" } }]).reply("没找到。");
    expect(await toolWorker(toolDeps(hook)).runOnce()).toBe(true);
    await hook.idle();
    expect(await whispersOf(w.owner.id, w.g)).toEqual([]);
  });

  it("the switch off (`whisperElsewhere`): no second query at all", async () => {
    const w = await world();
    expect((await api(app, w.owner, "PATCH", `/api/agents/${w.agent.id}`, { whisperElsewhere: false })).json).toMatchObject({ whisperElsewhere: false });
    const spy = spyDb(app.deps.db);
    const hook = createElsewhere(elsewhereDeps({ db: spy.db }));
    await askInGroup(w, hook, w.mia, spy.db);
    expect(searchesIn(spy.sql)).toBe(1);
    expect(await whispersOf(w.owner.id, w.g)).toEqual([]);
    // On again: the second query runs.
    expect((await api(app, w.owner, "PATCH", `/api/agents/${w.agent.id}`, { whisperElsewhere: true })).json).toMatchObject({ whisperElsewhere: true });
    spy.sql.length = 0;
    await askInGroup(w, hook, w.mia, spy.db);
    expect(searchesIn(spy.sql)).toBe(2);
  });

  it("at most one whisper a reply, and at most 3 open for the owner in a group: more are not made", async () => {
    const w = await world();
    const hook = createElsewhere(elsewhereDeps());
    // Called by the Agent's owner: a reply of its own has several tool rounds (a reply a member called for has one, plan B2a), so
    // two searches that find nothing here in one reply are what the once-a-reply cap is held to.
    await say(w.owner, w.g, "@olive_bot 两件事");
    gateway
      .callTools([{ name: SEARCH_MESSAGES, input: { query: "蓝鲸计划" } }])
      .callTools([{ name: SEARCH_MESSAGES, input: { query: "口令是七七" } }])
      .reply("都没找到。");
    expect(await toolWorker(toolDeps(hook)).runOnce()).toBe(true);
    await hook.idle();
    expect(await whispersOf(w.owner.id, w.g)).toHaveLength(1);
    for (let i = 0; i < 3; i++) await askInGroup(w, hook);
    expect((await whispersOf(w.owner.id, w.g)).map((x) => x.status)).toEqual(["open", "open", "open"]);
    // One answered: room for another.
    const [first] = await whispersOf(w.owner.id, w.g);
    expect((await api(app, w.owner, "POST", `/api/whispers/${first!.id}/decline`)).status).toBe(200);
    await askInGroup(w, hook);
    expect((await whispersOf(w.owner.id, w.g)).map((x) => x.status)).toEqual(["declined", "open", "open", "open"]);
  });

  it("the second query keeps the model's filters: `from`, `before`, `after` narrow it as they narrowed the group's search", async () => {
    const w = await world();
    const hook = createElsewhere(elsewhereDeps());
    await askInGroup(w, hook, w.mia, undefined, { query: "蓝鲸计划", from: "mia" });
    const [made] = await whispersOf(w.owner.id, w.g);
    expect((await wireOf(w.owner, w.g, made!.id))!.detail!.hits.map((h) => h.text)).toEqual([CANARY]);
    await db.query("delete from whispers where id = $1", [made!.id]);
    await askInGroup(w, hook, w.mia, undefined, { query: "蓝鲸计划", before: "2000-01-01" });
    expect(await whispersOf(w.owner.id, w.g)).toEqual([]);
  });

  it("the caps are read before the second query: with 3 open there, it does not even run", async () => {
    const w = await world();
    const hook = createElsewhere(elsewhereDeps());
    for (let i = 0; i < 3; i++) await askInGroup(w, hook);
    expect(await whispersOf(w.owner.id, w.g)).toHaveLength(3);
    const spy = spyDb(app.deps.db);
    const spied = createElsewhere(elsewhereDeps({ db: spy.db }));
    await askInGroup(w, spied, w.mia, spy.db);
    expect(searchesIn(spy.sql)).toBe(1);
    expect(await whispersOf(w.owner.id, w.g)).toHaveLength(3);
  });

  it("at most `atOnce` second queries at a time in the whole service: one more while they run is skipped (and the model is told nothing either way)", async () => {
    const w = await world();
    // A database whose first search statement waits until released.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held = false;
    let reached!: () => void;
    const reachedP = new Promise<void>((r) => (reached = r));
    const real = app.deps.db;
    const sql: string[] = [];
    const slow = <T extends object>(target: T): T =>
      new Proxy(target, {
        get(t, prop) {
          const value = Reflect.get(t, prop, t);
          if (prop === "query")
            return async (text: unknown, params?: unknown) => {
              const s = typeof text === "string" ? text : String((text as { text?: string }).text);
              sql.push(s);
              if (/ilike/i.test(s) && !held) {
                held = true;
                reached();
                await gate;
              }
              return (value as Function).call(t, text, params);
            };
          return typeof value === "function" ? value.bind(t) : value;
        },
      });
    const gated = { pool: real.pool, query: slow(real).query, tx: (fn: any) => real.tx((client) => fn(slow(client))), close: () => real.close() } as Db;
    const counted: unknown[] = [];
    const log = { warn: app.log.warn.bind(app.log), error: app.log.error.bind(app.log), info: (obj: unknown) => void counted.push(obj) } as ElsewhereDeps["log"];
    const hook = createElsewhere(elsewhereDeps({ db: gated, log }), { atOnce: 1 });
    const run = (await db.query<{ id: string }>("insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, triggered_by, lane) values ('reply', $1, $2, $3, 'done', 1, 'human', 'own') returning id", [w.g, w.agent.id, w.owner.id])).rows[0]!.id;
    const scope = { id: run, agentId: w.agent.id, ownerId: w.owner.id, conversationId: w.g, place: "group" as const, refs: new RunRefs(), heardTo: 1, mark: null };
    const first = hook(scope, { term: "蓝鲸计划", from: null, before: null, after: null });
    await reachedP;
    await hook(scope, { term: "口令是七七", from: null, before: null, after: null });
    const searched = sql.filter((s) => /ilike/i.test(s)).length;
    release();
    await first;
    expect(searched).toBe(1);
    // Counted (a counter only: no words, nothing found).
    expect(counted).toEqual([{ metric: "elsewhere_skipped", runId: run }]);
    await hook.idle();
    expect(await whispersOf(w.owner.id, w.g)).toHaveLength(1);
  });

  it("at most 5 hits, the newest first, each text at most 200 characters — around the words, as it is read now", async () => {
    const w = await world();
    for (let i = 0; i < 6; i++) await say(w.mia, w.b, `第${i}次：${"很长的话".repeat(30)}蓝鲸计划${"很长的话".repeat(80)}`);
    const hook = createElsewhere(elsewhereDeps());
    await askInGroup(w, hook);
    const [made] = await whispersOf(w.owner.id, w.g);
    expect(made!.body.detail!.hits).toHaveLength(ELSEWHERE_HITS_MAX);
    const hits = (await wireOf(w.owner, w.g, made!.id))!.detail!.hits;
    expect(hits).toHaveLength(ELSEWHERE_HITS_MAX);
    // Cut around the words (where they are in the message is all that was kept of them).
    expect(hits.every((h) => h.text.startsWith("…") && h.text.includes("蓝鲸计划"))).toBe(true);
    expect(hits.every((h) => Array.from(h.text).length <= 200)).toBe(true);
    // The newest first.
    const seqs = made!.body.detail!.hits.map((h) => h.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => b - a));
  });

  it("hits come only from what the owner can read now: not a message of B from before her current stay there, nor a group she is not in now", async () => {
    const w = await world();
    // As if olive had joined B after everything said there: the Agent sees it all, she sees none of it.
    await say(w.mia, w.b, "她看不到的：蓝鲸计划在地下室");
    await db.query("update memberships set joined_seq = (select seq from conversations where id = $1) where conversation_id = $1 and principal_id = $2", [w.b, w.owner.id]);
    // And group C, which (as if) she has left while her Agent stayed.
    const c = await group(app, w.owner, "丙群", [w.mia, w.ned]);
    expect((await api(app, w.owner, "POST", `/api/conversations/${c}/members`, { principalId: w.agent.id })).status).toBe(201);
    await say(w.mia, c, "也看不到的：蓝鲸计划在顶楼");
    await db.query("update memberships set left_seq = (select seq from conversations where id = $1) where conversation_id = $1 and principal_id = $2", [c, w.owner.id]);
    const hook = createElsewhere(elsewhereDeps());
    await askInGroup(w, hook);
    const [made] = await whispersOf(w.owner.id, w.g);
    expect((await wireOf(w.owner, w.g, made!.id))!.detail!.hits.map((h) => [h.where, h.text])).toEqual([["你和它的专属会话", OWN_NOTE]]);
    expect(made!.body.detail!.hits.map((h) => h.conversationId)).toEqual([w.agent.conversationId]);
  });
});

describe("告诉他们", () => {
  async function whispered(asker?: (w: World) => Actor) {
    const w = await world();
    const hook = createElsewhere(elsewhereDeps());
    const { asked } = await askInGroup(w, hook, asker?.(w) ?? w.mia);
    const [made] = await whispersOf(w.owner.id, w.g);
    return { w, whisper: made!, asked };
  }

  it("queues one reply of the Agent in the group, its owner's own, shown the hits as material and offered no tools; it posts there", async () => {
    const { w, whisper } = await whispered();
    const ownerSocket = await connect(app, w.owner);
    const accepted = await api(app, w.owner, "POST", `/api/whispers/${whisper.id}/accept`);
    expect(accepted.status).toBe(200);
    expect(accepted.json.status).toBe("telling");
    const runs = (await runsOf(w.agent.id, w.g)).filter((r) => r.status === "queued");
    expect(runs).toEqual([{ id: expect.any(String), status: "queued", lane: "own", triggered_by: "human", caller_id: w.owner.id, whisper_id: whisper.id }]);
    await ownerSocket.waitFor((e) => e.type === "run" && e.run?.id === runs[0]!.id);
    gateway.reply("蓝鲸计划在三楼。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    const call = gateway.calls.at(-1)!;
    expect(call.tools ?? []).toEqual([]);
    expect(call.system).toContain(TELL_THEM);
    expect(call.system).toContain(TOOL_MATERIAL);
    expect(call.system).toContain(CANARY);
    const last = (await agentSaid(w)).at(-1);
    expect([last.senderId, last.text]).toEqual([w.agent.id, "蓝鲸计划在三楼。"]);
    // Told: final — again is stale.
    expect((await wireOf(w.owner, w.g, whisper.id))!.status).toBe("told");
    expect((await api(app, w.owner, "POST", `/api/whispers/${whisper.id}/accept`)).status).toBe(409);
  });

  it("the told reply's model is given each hit's time and text only — never where it was said or by whom — and told not to say; nothing of those reaches the group", async () => {
    const w = await world();
    const sam = await signUp(app, "sam");
    await befriend(app, w.owner, sam);
    // Group C with a citation-shaped title and a speaker whose name is a canary; neither is in G.
    const c = await group(app, w.owner, "丙群〔m1〕CANARY-where", [w.mia, sam]);
    expect((await api(app, w.owner, "POST", `/api/conversations/${c}/members`, { principalId: w.agent.id })).status).toBe(201);
    await db.query("update principals set display_name = 'CANARY-who' where id = $1", [sam.id]);
    await say(sam, c, "@someone_bot 蓝鲸计划改到周五了");
    const hook = createElsewhere(elsewhereDeps());
    await askInGroup(w, hook);
    const [made] = await whispersOf(w.owner.id, w.g);
    const hits = (await wireOf(w.owner, w.g, made!.id))!.detail!.hits;
    // The owner is shown where and who (the title as its members wrote it: what looks like a citation in it is text).
    expect(hits[0]).toMatchObject({ where: "丙群〔m1〕CANARY-where", who: "CANARY-who", text: "@someone_bot 蓝鲸计划改到周五了" });
    const nedSocket = await connect(app, w.ned);
    expect((await api(app, w.owner, "POST", `/api/whispers/${made!.id}/accept`)).status).toBe(200);
    gateway.reply("蓝鲸计划改到周五了。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    const call = gateway.calls.at(-1)!;
    expect(call.system).toContain(`${TELL_THEM}\n${TELL_HOW}`);
    expect(call.system).toContain("someone_bot 蓝鲸计划改到周五了");
    expect(call.system).not.toContain("@someone_bot");
    expect(call.system).toContain(hits[0]!.when);
    const whole = JSON.stringify(call);
    for (const never of ["CANARY-where", "CANARY-who", "你和它的专属会话", "丙群", "乙群"]) expect([never, whole.includes(never)]).toEqual([never, false]);
    // Its no-tools sentence is one that does not deny having looked (TOLD_NO_TOOLS), and its last turn is a person's.
    expect(call.system).toContain(TOLD_NO_TOOLS);
    expect(call.system).not.toContain(NO_TOOLS);
    // Its last turn is a person's: the question it tells about (its own 没找到 after it is not shown).
    expect(call.messages.at(-1)!.role).toBe("user");
    expect(JSON.stringify(call.messages.at(-1))).toContain("上次说的那个计划在哪");
    expect(JSON.stringify(call.messages)).not.toContain("这个群的记录里没找到。");
    await settled([nedSocket], w.mia, w.g);
    const frames = JSON.stringify(nedSocket.events);
    for (const never of ["CANARY-where", "CANARY-who"]) expect([never, frames.includes(never)]).toEqual([never, false]);
  });

  it("the told reply quotes the message that asked (its reply-to), so it makes sense hours later", async () => {
    const { w, whisper, asked } = await whispered();
    // Much said since.
    for (let i = 0; i < 3; i++) await say(w.ned, w.g, `后来的话 ${i}`);
    expect((await api(app, w.owner, "POST", `/api/whispers/${whisper.id}/accept`)).status).toBe(200);
    gateway.reply("蓝鲸计划在三楼。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    const told = (await agentSaid(w)).at(-1);
    expect(told.text).toBe("蓝鲸计划在三楼。");
    expect(told.replyTo).toMatchObject({ seq: asked, visible: true, senderId: w.mia.id });
    expect(told.replyTo.text).toContain("上次说的那个计划在哪");
  });

  it("the message that asked no longer visible to the Agent (it left the group and came back since): the told reply is posted without the quote", async () => {
    const { w, whisper } = await whispered();
    // As if the Agent had left and come back after the question.
    await db.query("update memberships set joined_seq = (select seq from conversations where id = $1) where conversation_id = $1 and principal_id = $2", [w.g, w.agent.id]);
    await say(w.ned, w.g, "它回来了");
    expect((await api(app, w.owner, "POST", `/api/whispers/${whisper.id}/accept`)).status).toBe(200);
    gateway.reply("蓝鲸计划在三楼。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    const told = (await agentSaid(w)).at(-1);
    expect(told.text).toBe("蓝鲸计划在三楼。");
    expect(told.replyTo).toBeUndefined();
  });

  it("a told reply that failed is told again by a retry: the retry keeps the whisper, the passage, and no tools", async () => {
    const { w, whisper } = await whispered();
    expect((await api(app, w.owner, "POST", `/api/whispers/${whisper.id}/accept`)).status).toBe(200);
    gateway.fail("provider_unavailable", { status: 502 });
    expect(await app.agentWorker.runOnce()).toBe(true);
    const failed = (await runsOf(w.agent.id, w.g)).at(-1)!;
    expect([failed.status, failed.whisper_id]).toEqual(["failed", whisper.id]);
    expect((await api(app, w.owner, "POST", `/api/conversations/${w.g}/runs/retry`, { agentId: w.agent.id })).status).toBe(201);
    const retry = (await runsOf(w.agent.id, w.g)).at(-1)!;
    expect([retry.status, retry.whisper_id]).toEqual(["queued", whisper.id]);
    expect((await wireOf(w.owner, w.g, whisper.id))!.status).toBe("telling");
    gateway.reply("蓝鲸计划在三楼。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    const call = gateway.calls.at(-1)!;
    expect(call.tools ?? []).toEqual([]);
    expect(call.system).toContain(TELL_THEM);
    expect(call.system).toContain(CANARY);
    expect((await wireOf(w.owner, w.g, whisper.id))!.status).toBe("told");
  });

  it("refused like the owner's retry, and the whisper stays open: a reply of it under way there (409 busy_run), paused (409 agent_paused), no model (400)", async () => {
    const { w, whisper } = await whispered();
    const told = async () => (await runsOf(w.agent.id, w.g)).filter((r) => r.whisper_id !== null);
    // A reply of it queued there.
    await say(w.mia, w.g, "@olive_bot 还有一件事");
    const busy = await api(app, w.owner, "POST", `/api/whispers/${whisper.id}/accept`);
    expect([busy.status, busy.json.error]).toEqual([409, "busy_run"]);
    await db.query("update agent_runs set status = 'cancelled', finished_at = now() where agent_id = $1 and status = 'queued'", [w.agent.id]);
    expect((await api(app, w.owner, "POST", `/api/agents/${w.agent.id}/pause`)).status).toBe(200);
    const paused = await api(app, w.owner, "POST", `/api/whispers/${whisper.id}/accept`);
    expect([paused.status, paused.json.error]).toEqual([409, "agent_paused"]);
    expect((await api(app, w.owner, "POST", `/api/agents/${w.agent.id}/resume`)).status).toBe(200);
    expect((await api(app, w.owner, "PATCH", `/api/agents/${w.agent.id}`, { model: null })).status).toBe(200);
    const bare = await api(app, w.owner, "POST", `/api/whispers/${whisper.id}/accept`);
    expect([bare.status, bare.json.error]).toEqual([400, "invalid_request"]);
    expect((await whispersOf(w.owner.id, w.g))[0]!.status).toBe("open");
    expect((await wireOf(w.owner, w.g, whisper.id))).toMatchObject({ status: "open" });
    expect((await wireOf(w.owner, w.g, whisper.id))!.lastTellFailed).toBeUndefined();
    expect(await told()).toEqual([]);
  });

  it("a member's call while a told reply is queued is not folded into it: the told reply tells, then an ordinary reply, with tools, answers the member — nothing lost, nothing answered twice", async () => {
    const { w, whisper } = await whispered();
    expect((await api(app, w.owner, "POST", `/api/whispers/${whisper.id}/accept`)).status).toBe(200);
    const told = (await runsOf(w.agent.id, w.g)).find((r) => r.whisper_id !== null)!;
    const before = (await db.query<{ covers: string; calls: string[] | null }>("select covers_seq::text as covers, call_seqs::text[] as calls from agent_runs where id = $1", [told.id])).rows[0]!;
    // It answers no call: what it covers is none of its calls.
    expect(before.calls).toEqual([]);
    const call = await say(w.ned, w.g, "@olive_bot 另外，周五几点开会？");
    // Noted on the told reply for its follow-up (recorded as noted: `call_seqs`), not taken on by it.
    const after = (await db.query<{ covers: string; pending: string | null; calls: string[] | null; lane: string; caller_id: string | null }>(
      "select covers_seq::text as covers, pending_seq::text as pending, call_seqs::text[] as calls, lane, caller_id from agent_runs where id = $1",
      [told.id],
    )).rows[0]!;
    expect(after).toEqual({ covers: before.covers, pending: String(call), calls: [String(call)], lane: "own", caller_id: w.owner.id });
    expect((await runsOf(w.agent.id, w.g)).filter((r) => r.status === "queued")).toHaveLength(1);
    // The told reply: shown nothing of the member's question.
    gateway.reply("蓝鲸计划在三楼。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    const toldCall = gateway.calls.at(-1)!;
    expect(toldCall.system).toContain(TELL_THEM);
    expect(JSON.stringify(toldCall.messages)).not.toContain("周五几点开会");
    expect(JSON.stringify(toldCall.messages.at(-1))).toContain("上次说的那个计划在哪");
    // Then its follow-up: an ordinary reply, in the member's lane, offered tools, answering the member's call.
    const follow = (await db.query<{ whisper_id: string | null; lane: string; caller_id: string | null; calls: string[] }>(
      "select whisper_id, lane, caller_id, call_seqs::text[] as calls from agent_runs where agent_id = $1 and conversation_id = $2 and status = 'queued'",
      [w.agent.id, w.g],
    )).rows;
    expect(follow).toEqual([{ whisper_id: null, lane: "others", caller_id: w.ned.id, calls: [String(call)] }]);
    gateway.callTools([{ name: SEARCH_MESSAGES, input: { query: "周五几点" } }]).reply("周五下午三点。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    const followCall = gateway.calls.at(-1)!;
    expect((followCall.tools ?? []).length).toBeGreaterThan(0);
    expect(followCall.system).not.toContain(TELL_THEM);
    expect(JSON.stringify(followCall.messages)).toContain("周五几点开会");
    // Each posted once.
    const said = (await agentSaid(w)).map((m: any) => m.text);
    expect(said.slice(-2)).toEqual(["蓝鲸计划在三楼。", "周五下午三点。"]);
    expect(said.filter((t: string) => t === "蓝鲸计划在三楼。")).toHaveLength(1);
  });

  /**
   * The group's latest message is ned's, and ned and the owner have a block between them (`by` blocked `whom`): the told
   * reply covers that message, yet answers nobody's call — the owner's own tell is never dropped as blocked (final review
   * I-1), and a member's call noted on it while it waited is still answered by its follow-up.
   */
  async function toldPastABlock(blocker: "owner" | "ned"): Promise<void> {
    const { w, whisper } = await whispered();
    const [by, whom] = blocker === "owner" ? [w.owner, w.ned] : [w.ned, w.owner];
    expect((await api(app, by, "PUT", `/api/blocks/${whom.id}`)).status).toBe(200);
    await say(w.ned, w.g, "我先走了，你们聊");
    expect((await api(app, w.owner, "POST", `/api/whispers/${whisper.id}/accept`)).status).toBe(200);
    const told = (await runsOf(w.agent.id, w.g)).find((r) => r.whisper_id !== null)!;
    const call = await say(w.mia, w.g, "@olive_bot 另外，周五几点开会？");
    gateway.reply("蓝鲸计划在三楼。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect((await runsOf(w.agent.id, w.g)).find((r) => r.id === told.id)!.status).toBe("done");
    const said = async () => (await agentSaid(w)).map((m: any) => m.text);
    expect((await said()).at(-1)).toBe("蓝鲸计划在三楼。");
    const follow = (await db.query<{ lane: string; caller_id: string | null; calls: string[] }>(
      "select lane, caller_id, call_seqs::text[] as calls from agent_runs where agent_id = $1 and conversation_id = $2 and status = 'queued'",
      [w.agent.id, w.g],
    )).rows;
    expect(follow).toEqual([{ lane: "others", caller_id: w.mia.id, calls: [String(call)] }]);
    gateway.reply("周五下午三点。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect((await said()).slice(-2)).toEqual(["蓝鲸计划在三楼。", "周五下午三点。"]);
  }

  it("the group's latest message from someone the owner blocked since: the told reply still tells, and a member's call noted on it is still answered", async () => {
    await toldPastABlock("owner");
  });

  it("the group's latest message from someone who blocked the owner since: the told reply still tells, and a member's call noted on it is still answered", async () => {
    await toldPastABlock("ned");
  });

  it("its follow-up answers exactly the calls noted on it: a mention refused when it was sent (only its owner might call it then) is no call of it, though it names the Agent", async () => {
    const { w, whisper } = await whispered();
    expect((await api(app, w.owner, "PATCH", `/api/agents/${w.agent.id}`, { groupMentions: "owner" })).status).toBe(200);
    expect((await api(app, w.owner, "POST", `/api/whispers/${whisper.id}/accept`)).status).toBe(200);
    const told = (await runsOf(w.agent.id, w.g)).find((r) => r.whisper_id !== null)!;
    // Refused as it is sent (a member's, while only the owner may call it): nothing is noted, though its mention is stored.
    const refused = await say(w.mia, w.g, "@olive_bot 先问一句：明天带伞吗？");
    expect((await db.query("select 1 from messages where conversation_id = $1 and seq = $2 and mentions @> $3::jsonb", [w.g, refused, JSON.stringify([{ id: w.agent.id }])])).rowCount).toBe(1);
    expect((await api(app, w.owner, "PATCH", `/api/agents/${w.agent.id}`, { groupMentions: "members" })).status).toBe(200);
    const call = await say(w.ned, w.g, "@olive_bot 周五几点开会？");
    // Noted on the told reply, and recorded as noted: its follow-up's calls are these, and only these.
    expect((await db.query<{ calls: string[] }>("select call_seqs::text[] as calls from agent_runs where id = $1", [told.id])).rows[0]!.calls).toEqual([String(call)]);
    gateway.reply("蓝鲸计划在三楼。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    const follow = (await db.query<{ lane: string; caller_id: string | null; calls: string[]; askers: string[] | null }>(
      "select lane, caller_id, call_seqs::text[] as calls, asker_ids::text[] as askers from agent_runs where agent_id = $1 and conversation_id = $2 and status = 'queued'",
      [w.agent.id, w.g],
    )).rows;
    expect(follow).toEqual([{ lane: "others", caller_id: w.ned.id, calls: [String(call)], askers: expect.any(Array) }]);
    gateway.reply("周五下午三点。");
    expect(await app.agentWorker.runOnce()).toBe(true);
  });

  /**
   * The members' calls noted on a told reply are never held to its owner (round 2, N-3): however it ends without posting —
   * failed as it ran, ended by recovery at start-up or by a release, or superseded by a later run — they go to an ordinary
   * follow-up at once, and the told run keeps none of them (a retry of it would tell with nothing noted).
   */
  async function notedThenEnded(claimed: boolean, end: (ticketId: string) => Promise<void>) {
    const { w, whisper } = await whispered();
    expect((await api(app, w.owner, "POST", `/api/whispers/${whisper.id}/accept`)).status).toBe(200);
    const id = claimed ? (await app.agentPort.claimNext())!.id : (await runsOf(w.agent.id, w.g)).find((r) => r.whisper_id !== null)!.id;
    const call = await say(w.ned, w.g, "@olive_bot 另外，周五几点开会？");
    await end(id);
    const ticket = { id };
    const told = (await db.query<{ status: string; pending: string | null; calls: string[] }>(
      "select status, pending_seq::text as pending, call_seqs::text[] as calls from agent_runs where id = $1",
      [ticket.id],
    )).rows[0]!;
    expect(told).toEqual({ status: "failed", pending: null, calls: [] });
    const follow = (await db.query<{ whisper_id: string | null; lane: string; caller_id: string | null; calls: string[] }>(
      "select whisper_id, lane, caller_id, call_seqs::text[] as calls from agent_runs where agent_id = $1 and conversation_id = $2 and status = 'queued'",
      [w.agent.id, w.g],
    )).rows;
    expect(follow).toEqual([{ whisper_id: null, lane: "others", caller_id: w.ned.id, calls: [String(call)] }]);
    return { w, call };
  }
  const answered = async (w: World) => {
    gateway.reply("周五下午三点。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect((await agentSaid(w)).at(-1).text).toBe("周五下午三点。");
  };

  it("a told reply that fails as it runs: the members' calls noted on it are followed up at once", async () => {
    const { w } = await notedThenEnded(false, async () => {
      gateway.fail("provider_unavailable", { status: 502 });
      expect(await app.agentWorker.runOnce()).toBe(true);
    });
    await answered(w);
  });

  it("a told reply that recovery at start-up ends: the members' calls noted on it are followed up at once (a failed run is otherwise followed by nothing)", async () => {
    const { w } = await notedThenEnded(true, async () => {
      expect(await recoverRuns(app.deps.db, app.deps.config, app.log)).toBe(1);
    });
    await answered(w);
  });

  it("a told reply that a release ends (as recovery ends one): the members' calls noted on it are followed up at once", async () => {
    const { w } = await notedThenEnded(true, async (id) => {
      expect(await app.agentPort.releaseRun(id)).toBe(true);
    });
    await answered(w);
  });

  it("a told reply ended so and then superseded (its owner calls the Agent before anything ran): the member's call is answered, once", async () => {
    const { w } = await notedThenEnded(true, async (id) => {
      expect(await app.agentPort.releaseRun(id)).toBe(true);
    });
    const own = await say(w.owner, w.g, "@olive_bot 我也问一句：明天几点？");
    // Folded into the follow-up that waits: one reply answers both.
    const queued = (await db.query<{ calls: string[]; covers: string }>("select call_seqs::text[] as calls, covers_seq::text as covers from agent_runs where agent_id = $1 and conversation_id = $2 and status = 'queued'", [w.agent.id, w.g])).rows;
    expect(queued).toHaveLength(1);
    expect(queued[0]!.calls).toContain(String(own));
    await answered(w);
    expect((await runsOf(w.agent.id, w.g)).filter((r) => r.status === "queued")).toEqual([]);
  });

  it("不用: nothing happens", async () => {
    const { w, whisper } = await whispered();
    const before = await runsOf(w.agent.id, w.g);
    expect((await api(app, w.owner, "POST", `/api/whispers/${whisper.id}/decline`)).json.status).toBe("declined");
    expect(await runsOf(w.agent.id, w.g)).toEqual(before);
  });

  it("after the owner left the group: gone (404), and nothing is queued", async () => {
    const { w, whisper } = await whispered();
    const before = await runsOf(w.agent.id, w.g);
    expect((await api(app, w.owner, "DELETE", `/api/conversations/${w.g}/members/${w.owner.id}`)).status).toBe(200);
    expect((await api(app, w.owner, "POST", `/api/whispers/${whisper.id}/accept`)).status).toBe(404);
    expect((await runsOf(w.agent.id, w.g)).length).toBe(before.length);
  });

  it("an owner at their replies a minute gets the ordinary refusal (429), and the whisper stays open to answer later", async () => {
    const { w, whisper } = await whispered();
    const limit = app.deps.config.agentRunsPerMinute;
    for (let i = 0; i < limit; i++) {
      await db.query(
        `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, triggered_by, caller_id, lane, finished_at)
         values ('reply', $1, $2, $3, 'done', 1, 'human', $3, 'own', now())`,
        [w.agent.conversationId, w.agent.id, w.owner.id],
      );
    }
    const refused = await api(app, w.owner, "POST", `/api/whispers/${whisper.id}/accept`);
    expect([refused.status, refused.json.error]).toEqual([429, "rate_limited"]);
    expect((await whispersOf(w.owner.id, w.g))[0]!.status).toBe("open");
    expect((await runsOf(w.agent.id, w.g)).some((r) => r.whisper_id !== null)).toBe(false);
  });
});

describe("the state of a told whisper is derived, never stored (Redesign D)", () => {
  /** What a whisper's row holds: telling it — however that goes — changes none of it. */
  const rowOf = async (id: string) => (await db.query("select status, resolved_at, revision, body from whispers where id = $1", [id])).rows[0];
  /** The whisper made, its owner's 告诉他们 answered `telling`, and the told reply queued; the sockets of all three, open from the start. */
  async function toldQueued() {
    const w = await world();
    const sockets = { owner: await connect(app, w.owner), mia: await connect(app, w.mia), ned: await connect(app, w.ned) };
    await askInGroup(w, createElsewhere(elsewhereDeps()));
    const [whisper] = await whispersOf(w.owner.id, w.g);
    const before = await rowOf(whisper!.id);
    const accepted = await api(app, w.owner, "POST", `/api/whispers/${whisper!.id}/accept`);
    expect([accepted.status, accepted.json.status]).toEqual([200, "telling"]);
    const told = (await runsOf(w.agent.id, w.g)).find((r) => r.whisper_id !== null)!;
    return { w, whisper: whisper!, told, sockets, before };
  }
  type Told = Awaited<ReturnType<typeof toldQueued>>;
  /** The whisper frames its owner was pushed of `id`, in order. */
  const framesOf = (socket: TestSocket, id: string) => socket.events.filter((e) => e.type === "whisper" && e.whisper.id === id).map((e) => e.whisper);
  /** Nothing of the whisper reached the members' sockets: no frame of it, no key, its id, a hit's text. */
  async function nothingForMembers(x: Told) {
    const { w, whisper, sockets } = x;
    await settled([sockets.mia, sockets.ned], w.ned, w.g);
    for (const socket of [sockets.mia, sockets.ned]) {
      expect(socket.events.some((e) => e.type === "whisper")).toBe(false);
      const frames = JSON.stringify(socket.events);
      for (const never of [whisper.id, "lastTellFailed", "CANARY-ew", "telling", "revision"]) expect([never, frames.includes(never)]).toEqual([never, false]);
    }
    // Nor what they read: their sync (which holds B, where mia said the canary herself), the group's catch-up and replies.
    for (const who of [w.mia, w.ned]) {
      const sync = JSON.stringify((await api(app, who, "GET", "/api/sync")).json);
      const group = JSON.stringify([
        (await api(app, who, "POST", "/api/sync/catchup", { positions: { [w.g]: 0 } })).json,
        (await api(app, who, "GET", `/api/conversations/${w.g}/runs`)).json,
      ]);
      for (const never of [whisper.id, "lastTellFailed", "telling", "\"whisper", "afterSeq", "revision"]) expect([who.handle, never, sync.includes(never)]).toEqual([who.handle, never, false]);
      for (const never of [whisper.id, "lastTellFailed", "CANARY-ew", "telling", "\"whisper", "afterSeq", "revision"]) expect([who.handle, never, group.includes(never)]).toEqual([who.handle, never, false]);
    }
  }
  /**
   * The told reply ended without posting: the whisper reads open again for its owner — its hits, both buttons, and that the
   * last tell failed —, waits for an answer (counted), and its row is as it was before the tell: nothing was stored, so there
   * is nothing to repair. Pushed to its owner (when `pushed`: the ending was announced) and to nobody else.
   */
  async function openAgain(x: Told, { pushed = true }: { pushed?: boolean } = {}) {
    const { w, whisper, sockets, before } = x;
    expect(await rowOf(whisper.id)).toEqual(before);
    const wire = (await wireOf(w.owner, w.g, whisper.id))!;
    expect(wire).toMatchObject({ status: "open", lastTellFailed: true, actions: ["tell", "dismiss"] });
    expect(wire.detail!.hits.map((h) => h.text)).toEqual([OWN_NOTE, CANARY]);
    expect((await api(app, w.owner, "GET", `/api/conversations/${w.g}`)).json.whispers).toBe(1);
    if (pushed) await sockets.owner.waitFor((e) => e.type === "whisper" && e.whisper.id === whisper.id && e.whisper.lastTellFailed === true);
    // Of two copies the later never has the lower revision (the web keeps the higher).
    const revisions = framesOf(sockets.owner, whisper.id).map((f) => f.revision as number);
    expect(revisions).toEqual([...revisions].sort((a, b) => a - b));
    await nothingForMembers(x);
  }
  /** 告诉他们 once more tells, once: told, and still nothing stored. */
  async function tellsAgain(x: Told) {
    const { w, whisper, before } = x;
    const again = await api(app, w.owner, "POST", `/api/whispers/${whisper.id}/accept`);
    expect([again.status, again.json.status, "lastTellFailed" in again.json]).toEqual([200, "telling", false]);
    expect((await runsOf(w.agent.id, w.g)).filter((r) => r.whisper_id === whisper.id && r.status === "queued")).toHaveLength(1);
    gateway.reply("蓝鲸计划在三楼。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect((await agentSaid(w)).filter((m: any) => m.text === "蓝鲸计划在三楼。")).toHaveLength(1);
    expect((await wireOf(w.owner, w.g, whisper.id))!.status).toBe("told");
    expect(await rowOf(whisper.id)).toEqual(before);
  }

  it("telling while its told reply is queued or running: counted as waiting for nothing; 告诉他们 and 不用 are refused as busy (409 busy_run)", async () => {
    const x = await toldQueued();
    const { w, whisper } = x;
    expect((await wireOf(w.owner, w.g, whisper.id))!.status).toBe("telling");
    expect("whispers" in (await api(app, w.owner, "GET", `/api/conversations/${w.g}`)).json).toBe(false);
    for (const verb of ["accept", "decline"]) expect([verb, await api(app, w.owner, "POST", `/api/whispers/${whisper.id}/${verb}`)]).toEqual([verb, { status: 409, json: { error: "busy_run" } }]);
    await app.agentPort.claimNext();
    expect((await wireOf(w.owner, w.g, whisper.id))!.status).toBe("telling");
    expect((await api(app, w.owner, "POST", `/api/whispers/${whisper.id}/accept`)).status).toBe(409);
    await x.sockets.owner.waitFor((e) => e.type === "whisper" && e.whisper.id === whisper.id && e.whisper.status === "telling");
    await app.agentPort.releaseRun(x.told.id);
    await openAgain(x);
  });

  it("a told reply that fails: open again with lastTellFailed, pushed to its owner alone; nothing was stored to repair; 告诉他们 tells once more", async () => {
    const x = await toldQueued();
    gateway.fail("provider_unavailable", { status: 502 });
    expect(await app.agentWorker.runOnce()).toBe(true);
    await openAgain(x);
    await tellsAgain(x);
  });

  for (const end of ["a release", "recovery at start-up", "the stale-run sweep"] as const) {
    it(`ended by ${end}: the same`, async () => {
      const x = await toldQueued();
      const ticket = (await app.agentPort.claimNext())!;
      if (end === "a release") expect(await app.agentPort.releaseRun(ticket.id)).toBe(true);
      if (end === "recovery at start-up") expect(await recoverRuns(app.deps.db, app.deps.config, app.log)).toBe(1);
      if (end === "the stale-run sweep") {
        await db.query("update agent_runs set started_at = now() - interval '42 minutes' where id = $1", [ticket.id]);
        expect(await sweepStaleRuns(app.agentPort, app.deps.db, app.deps.config, app.log, () => false)).toBe(1);
      }
      // (Recovery at start-up announces nothing: no socket could be open yet. The owner's next read has it.)
      await openAgain(x, { pushed: end !== "recovery at start-up" });
      await tellsAgain(x);
    });
  }

  it("stopped by its owner while queued: the tell ends, open again; a member's call noted on it still gets its follow-up", async () => {
    const x = await toldQueued();
    const call = await say(x.w.ned, x.w.g, "@olive_bot 另外，周五几点开会？");
    expect((await api(app, x.w.owner, "POST", `/api/conversations/${x.w.g}/runs/${x.told.id}/stop`)).status).toBe(200);
    expect((await runsOf(x.w.agent.id, x.w.g)).find((r) => r.id === x.told.id)!.status).toBe("stopped");
    const follow = (await db.query<{ whisper_id: string | null; lane: string; caller_id: string | null; calls: string[] }>(
      "select whisper_id, lane, caller_id, call_seqs::text[] as calls from agent_runs where agent_id = $1 and conversation_id = $2 and status = 'queued'",
      [x.w.agent.id, x.w.g],
    )).rows;
    expect(follow).toEqual([{ whisper_id: null, lane: "others", caller_id: x.w.ned.id, calls: [String(call)] }]);
    await openAgain(x);
    gateway.reply("周五下午三点。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    await tellsAgain(x);
  });

  it("cancelled by its owner's pause while queued: open again, to tell once the Agent is resumed", async () => {
    const x = await toldQueued();
    expect((await api(app, x.w.owner, "POST", `/api/agents/${x.w.agent.id}/pause`)).status).toBe(200);
    expect((await runsOf(x.w.agent.id, x.w.g)).find((r) => r.id === x.told.id)!.status).toBe("cancelled");
    await openAgain(x);
    expect((await api(app, x.w.owner, "POST", `/api/agents/${x.w.agent.id}/resume`)).status).toBe(200);
    await tellsAgain(x);
  });

  it("two endings racing change nothing wrong: two releases at once, and a stop and a pause at once, each leave it open, once", async () => {
    const x = await toldQueued();
    const ticket = (await app.agentPort.claimNext())!;
    expect((await Promise.all([app.agentPort.releaseRun(ticket.id), app.agentPort.releaseRun(ticket.id)])).sort()).toEqual([false, true]);
    await openAgain(x);
    // Told again, and this time its owner stops it and pauses the Agent at the same moment.
    expect((await api(app, x.w.owner, "POST", `/api/whispers/${x.whisper.id}/accept`)).status).toBe(200);
    const second = (await runsOf(x.w.agent.id, x.w.g)).filter((r) => r.whisper_id === x.whisper.id).at(-1)!;
    const [stopped, paused] = await Promise.all([
      api(app, x.w.owner, "POST", `/api/conversations/${x.w.g}/runs/${second.id}/stop`),
      api(app, x.w.owner, "POST", `/api/agents/${x.w.agent.id}/pause`),
    ]);
    expect([stopped.status, paused.status]).toEqual([200, 200]);
    expect(["stopped", "cancelled"]).toContain((await runsOf(x.w.agent.id, x.w.g)).find((r) => r.id === second.id)!.status);
    await openAgain(x);
    expect(framesOf(x.sockets.owner, x.whisper.id).some((f) => f.status === "told")).toBe(false);
  });

  it("told once a told reply posted: final (409 stale_whisper for 告诉他们 and 不用), not counted; its row says open as it always did — nothing stores accepted", async () => {
    const x = await toldQueued();
    gateway.reply("蓝鲸计划在三楼。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    const { w, whisper, before } = x;
    await x.sockets.owner.waitFor((e) => e.type === "whisper" && e.whisper.id === whisper.id && e.whisper.status === "told");
    expect((await wireOf(w.owner, w.g, whisper.id))!.status).toBe("told");
    for (const verb of ["accept", "decline"]) expect([verb, await api(app, w.owner, "POST", `/api/whispers/${whisper.id}/${verb}`)]).toEqual([verb, { status: 409, json: { error: "stale_whisper" } }]);
    expect("whispers" in (await api(app, w.owner, "GET", `/api/conversations/${w.g}`)).json).toBe(false);
    expect(await rowOf(whisper.id)).toEqual(before);
    expect((await db.query("select count(*)::int as n from whispers where status = 'accepted'")).rows[0].n).toBe(0);
    await nothingForMembers(x);
  });

  it("the cap counts the whispers whose state is open or telling: a telling one counts; a told one, or one with no hit left, makes room", async () => {
    const w = await world();
    const hook = createElsewhere(elsewhereDeps());
    for (let i = 0; i < 3; i++) await askInGroup(w, hook);
    const [a, b, c] = await whispersOf(w.owner.id, w.g);
    // A's told reply queued: telling, still counted — a lookup of another reply there makes nothing.
    expect((await api(app, w.owner, "POST", `/api/whispers/${a!.id}/accept`)).status).toBe(200);
    const done = (await db.query<{ id: string }>("insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, triggered_by, lane) values ('reply', $1, $2, $3, 'done', 1, 'human', 'own') returning id", [w.g, w.agent.id, w.owner.id])).rows[0]!.id;
    const scope = { id: done, agentId: w.agent.id, ownerId: w.owner.id, conversationId: w.g, place: "group" as const, refs: new RunRefs(), heardTo: 1, mark: null };
    await hook(scope, { term: "蓝鲸计划", from: null, before: null, after: null });
    expect(await whispersOf(w.owner.id, w.g)).toHaveLength(3);
    // A told (in words the group's next search does not find): room for one.
    gateway.reply("在三楼。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect((await wireOf(w.owner, w.g, a!.id))!.status).toBe("told");
    await askInGroup(w, hook);
    expect(await whispersOf(w.owner.id, w.g)).toHaveLength(4);
    // B's hits no longer readable by its owner (as if what it found were gone): expired, room for one more.
    await db.query("update whispers set body = jsonb_set(body, '{detail,hits}', $2::jsonb) where id = $1", [b!.id, JSON.stringify([{ conversationId: w.b, seq: 999_999, at: 0 }])]);
    expect((await wireOf(w.owner, w.g, b!.id))!.status).toBe("expired");
    await askInGroup(w, hook);
    expect(await whispersOf(w.owner.id, w.g)).toHaveLength(5);
    expect((await wireOf(w.owner, w.g, c!.id))!.status).toBe("open");
  });
});

describe("hits are references, read under the owner's access when shown or told", () => {
  it("a hit whose message the owner can no longer read is left out of the bubble and of the told reply's passage", async () => {
    const w = await world();
    const ownerSocket = await connect(app, w.owner);
    await askInGroup(w, createElsewhere(elsewhereDeps()));
    const [made] = await whispersOf(w.owner.id, w.g);
    expect((await wireOf(w.owner, w.g, made!.id))!.detail!.hits.map((h) => h.text)).toEqual([OWN_NOTE, CANARY]);
    // olive leaves B: what was said there is no longer hers to read.
    expect((await api(app, w.owner, "DELETE", `/api/conversations/${w.b}/members/${w.owner.id}`)).status).toBe(200);
    const wire = (await wireOf(w.owner, w.g, made!.id))!;
    expect(wire.status).toBe("open");
    expect(wire.detail!.hits.map((h) => [h.where, h.text])).toEqual([["你和它的专属会话", OWN_NOTE]]);
    expect(JSON.stringify((await api(app, w.owner, "GET", "/api/sync")).json)).not.toContain("CANARY-ew");
    // Told now: the passage holds what she can read now, and nothing of B.
    const accepted = await api(app, w.owner, "POST", `/api/whispers/${made!.id}/accept`);
    expect(JSON.stringify(accepted.json)).not.toContain("CANARY-ew");
    gateway.reply("口令是七七。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    const call = gateway.calls.at(-1)!;
    expect(call.system).toContain(OWN_NOTE);
    expect(call.system).not.toContain("CANARY-ew");
    const frames = ownerSocket.events.filter((e) => e.type === "whisper" && e.whisper.id === made!.id);
    expect(JSON.stringify(frames.slice(1))).not.toContain("CANARY-ew");
  });

  it("no hit left: the whisper is expired (已过期) — not counted, 告诉他们 and 不用 409 stale_whisper, no room taken; a told reply that begins with none left tells nothing", async () => {
    const w = await world();
    const hook = createElsewhere(elsewhereDeps());
    // Only mia's line in B is found (`from`).
    await askInGroup(w, hook, w.mia, undefined, { query: "蓝鲸计划", from: "mia" });
    const [made] = await whispersOf(w.owner.id, w.g);
    expect((await api(app, w.owner, "GET", `/api/conversations/${w.g}`)).json.whispers).toBe(1);
    // Told: queued — and before it begins, olive leaves B.
    expect((await api(app, w.owner, "POST", `/api/whispers/${made!.id}/accept`)).status).toBe(200);
    expect((await api(app, w.owner, "DELETE", `/api/conversations/${w.b}/members/${w.owner.id}`)).status).toBe(200);
    const before = gateway.calls.length;
    const said = (await agentSaid(w)).length;
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(gateway.calls.length).toBe(before);
    expect((await agentSaid(w)).length).toBe(said);
    const wire = (await wireOf(w.owner, w.g, made!.id))!;
    expect(wire.status).toBe("expired");
    expect(wire.detail?.hits ?? []).toEqual([]);
    expect("whispers" in (await api(app, w.owner, "GET", `/api/conversations/${w.g}`)).json).toBe(false);
    for (const verb of ["accept", "decline"]) expect([verb, await api(app, w.owner, "POST", `/api/whispers/${made!.id}/${verb}`)]).toEqual([verb, { status: 409, json: { error: "stale_whisper" } }]);
  });
});

describe("expiry: a found-elsewhere whisper a day after it was made", () => {
  it("expires 24 h after it was made (`WHISPERS.elsewhereTtlHours`), pushed to its owner; a told one stays told; other kinds keep their 7 days", async () => {
    const w = await world();
    const ownerSocket = await connect(app, w.owner);
    const hook = createElsewhere(elsewhereDeps());
    for (let i = 0; i < 3; i++) await askInGroup(w, hook);
    const [old, young, told] = await whispersOf(w.owner.id, w.g);
    expect((await api(app, w.owner, "POST", `/api/whispers/${told!.id}/accept`)).status).toBe(200);
    gateway.reply("蓝鲸计划在三楼。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    const other = (await db.tx((t) => createWhisper(t, { conversationId: w.g, ownerId: w.owner.id, agentId: w.agent.id, kind: "memory", body: { text: "别的", actions: ["dismiss"] } })))!;
    const age = (id: string, hours: number) => db.query("update whispers set created_at = now() - $2::int * interval '1 hour' where id = $1", [id, hours]);
    await age(old!.id, 25);
    await age(young!.id, 23);
    await age(told!.id, 25);
    await age(other.id, 25);
    expect(app.deps.config.whispers.elsewhereTtlHours).toBe(24);
    // A day old, it reads expired at once, before any sweep (the service's own 24 hours); a sweep set longer leaves it stored open.
    expect((await wireOf(w.owner, w.g, old!.id))!.status).toBe("expired");
    await changeSweep(app.deps, { ...app.deps.config, whispers: { elsewhereTtlHours: 48 } }, app.log, app.realtime);
    expect((await db.query("select status from whispers where id = $1", [old!.id])).rows[0].status).toBe("open");
    await changeSweep(app.deps, app.deps.config, app.log, app.realtime);
    expect(await Promise.all([old, young, told].map(async (x) => (await wireOf(w.owner, w.g, x!.id))!.status))).toEqual(["expired", "open", "told"]);
    expect((await db.query("select status from whispers where id = $1", [other.id])).rows[0].status).toBe("open");
    await ownerSocket.waitFor((e) => e.type === "whisper" && e.whisper.id === old!.id && e.whisper.status === "expired");
    expect(await api(app, w.owner, "POST", `/api/whispers/${old!.id}/accept`)).toEqual({ status: 409, json: { error: "stale_whisper" } });
    // The clock is the sweep's argument: an hour later, the young one too.
    expect((await expireWhispers(db, new Date(Date.now() + 2 * HOUR))).map((x) => x.id)).toEqual([young!.id]);
  });
});

describe("migration 058: what was stored before", () => {
  it("a told whisper (answered, its told reply posted) keeps nothing more: it reads told; one answered whose tell posted nothing, or open, is expired (its hits were copies, with nothing to read)", async () => {
    const w = await world();
    const hook = createElsewhere(elsewhereDeps());
    for (let i = 0; i < 3; i++) await askInGroup(w, hook);
    const [told, unposted, open] = await whispersOf(w.owner.id, w.g);
    expect((await api(app, w.owner, "POST", `/api/whispers/${told!.id}/accept`)).status).toBe(200);
    gateway.reply("蓝鲸计划在三楼。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect((await api(app, w.owner, "POST", `/api/whispers/${unposted!.id}/accept`)).status).toBe(200);
    gateway.fail("provider_unavailable", { status: 502 });
    expect(await app.agentWorker.runOnce()).toBe(true);
    const sql = readFileSync(new URL("../migrations/058_whisper_derived_state.sql", import.meta.url), "utf8");
    const [up, down] = sql.split("-- Down Migration") as [string, string];
    const after = await db
      .tx(async (t) => {
        await t.query(down);
        // As the rows stood before: answered `accepted`, hits as copies.
        await t.query("update whispers set status = 'accepted', resolved_at = now() where id = any($1::uuid[])", [[told!.id, unposted!.id]]);
        await t.query(`update whispers set body = jsonb_set(body, '{detail}', '{"hits": [{"where": "乙群", "who": "mia", "when": "2026-11-20 10:00", "text": "蓝鲸计划在三楼"}]}'::jsonb)`);
        await t.query(up);
        const rows = (await t.query<{ id: string; status: string; copies: unknown }>("select id, status, body -> 'detail' -> 'hits' as copies from whispers where owner_id = $1", [w.owner.id])).rows;
        throw Object.assign(new Error("rollback"), { rows });
      })
      .catch((err: { rows?: Array<{ id: string; status: string; copies: unknown }> }) => err.rows);
    const statusOf = (id: string) => after!.find((r) => r.id === id)!.status;
    expect([statusOf(told!.id), statusOf(unposted!.id), statusOf(open!.id)]).toEqual(["open", "expired", "expired"]);
    // M-6: no copy of what was found is left at rest in any row it converted or expired.
    expect(after!.map((r) => r.copies)).toEqual([null, null, null]);
    // And as the service reads them: told stays told, whatever the hits were.
    expect((await wireOf(w.owner, w.g, told!.id))!.status).toBe("told");
  });
});

describe("fix round 1", () => {
  const statusOf = async (id: string) => (await db.query<{ status: string }>("select status from whispers where id = $1", [id])).rows[0]?.status;
  const toldRuns = async (w: World, whisperId: string) => (await runsOf(w.agent.id, w.g)).filter((r) => r.whisper_id === whisperId);
  /** A whisper made, 告诉他们 pressed, and its told reply failed: it reads open with lastTellFailed, and the failed run is the Agent's latest there. */
  async function failedTell() {
    const w = await world();
    await askInGroup(w, createElsewhere(elsewhereDeps()));
    const [whisper] = await whispersOf(w.owner.id, w.g);
    expect((await api(app, w.owner, "POST", `/api/whispers/${whisper!.id}/accept`)).status).toBe(200);
    gateway.fail("provider_unavailable", { status: 502 });
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect((await wireOf(w.owner, w.g, whisper!.id))).toMatchObject({ status: "open", lastTellFailed: true });
    return { w, whisper: whisper! };
  }
  const retry = (w: World) => api(app, w.owner, "POST", `/api/conversations/${w.g}/runs/retry`, { agentId: w.agent.id });

  // I-1: declined and expired are final — no told reply may begin for one, by any way.
  it("I-1: 不用 after a failed tell is final: 重试 of the failed told reply answers 409 stale_whisper, queues nothing and posts nothing; it stays 已忽略", async () => {
    const { w, whisper } = await failedTell();
    expect((await api(app, w.owner, "POST", `/api/whispers/${whisper.id}/decline`)).json.status).toBe("declined");
    const said = (await agentSaid(w)).length;
    expect(await retry(w)).toEqual({ status: 409, json: { error: "stale_whisper" } });
    expect((await toldRuns(w, whisper.id)).filter((r) => r.status === "queued")).toEqual([]);
    expect(await app.agentWorker.runOnce()).toBe(false);
    expect((await agentSaid(w)).length).toBe(said);
    expect((await wireOf(w.owner, w.g, whisper.id))!.status).toBe("declined");
  });

  it("I-1: a failed tell left until a day has passed is final: 重试 answers 409 stale_whisper before the sweep has run (it already reads expired) and after it; nothing is posted", async () => {
    const { w, whisper } = await failedTell();
    await db.query("update whispers set created_at = now() - interval '25 hours' where id = $1", [whisper.id]);
    // A day old: it reads expired at once (not counted, 告诉他们 stale), whether or not the sweep has stored it so yet.
    expect((await wireOf(w.owner, w.g, whisper.id))!.status).toBe("expired");
    expect("whispers" in (await api(app, w.owner, "GET", `/api/conversations/${w.g}`)).json).toBe(false);
    expect(await api(app, w.owner, "POST", `/api/whispers/${whisper.id}/accept`)).toEqual({ status: 409, json: { error: "stale_whisper" } });
    const said = (await agentSaid(w)).length;
    expect(await retry(w)).toEqual({ status: 409, json: { error: "stale_whisper" } });
    await changeSweep(app.deps, app.deps.config, app.log, app.realtime);
    expect(await statusOf(whisper.id)).toBe("expired");
    expect(await retry(w)).toEqual({ status: 409, json: { error: "stale_whisper" } });
    expect(await app.agentWorker.runOnce()).toBe(false);
    expect((await agentSaid(w)).length).toBe(said);
  });

  for (const status of ["declined", "expired"] as const) {
    it(`I-1: a told reply that begins while its whisper is ${status} ends as one with nothing left: no model call, nothing posted`, async () => {
      const { w, whisper } = await failedTell();
      expect((await retry(w)).status).toBe(201);
      // However it came to be so while its told reply waited.
      await db.query("update whispers set status = $2, resolved_at = now() where id = $1", [whisper.id, status]);
      const calls = gateway.calls.length;
      const said = (await agentSaid(w)).length;
      expect(await app.agentWorker.runOnce()).toBe(true);
      expect([gateway.calls.length, (await agentSaid(w)).length]).toEqual([calls, said]);
      expect((await toldRuns(w, whisper.id)).at(-1)!.status).toBe("cancelled");
      expect((await wireOf(w.owner, w.g, whisper.id))!.status).toBe(status);
    });
  }

  it("I-1: its own told reply, already under way when a day passes, still tells (it reads telling, not expired)", async () => {
    const w = await world();
    await askInGroup(w, createElsewhere(elsewhereDeps()));
    const [whisper] = await whispersOf(w.owner.id, w.g);
    expect((await api(app, w.owner, "POST", `/api/whispers/${whisper!.id}/accept`)).status).toBe(200);
    await db.query("update whispers set created_at = now() - interval '25 hours' where id = $1", [whisper!.id]);
    expect((await wireOf(w.owner, w.g, whisper!.id))!.status).toBe("telling");
    gateway.reply("蓝鲸计划在三楼。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect((await agentSaid(w)).at(-1).text).toBe("蓝鲸计划在三楼。");
    expect((await wireOf(w.owner, w.g, whisper!.id))!.status).toBe("told");
  });

  // I-2: the bubble on screen follows the owner's access.
  it("I-2: the owner leaves a group a hit points at, her socket open: her bubble in G is pushed after the leave — without that hit; one whose only hit was there, expired with none", async () => {
    const w = await world();
    const hook = createElsewhere(elsewhereDeps());
    await askInGroup(w, hook);
    await askInGroup(w, hook, w.mia, undefined, { query: "蓝鲸计划", from: "mia" });
    const [both, onlyB] = await whispersOf(w.owner.id, w.g);
    const socket = await connect(app, w.owner);
    expect((await api(app, w.owner, "DELETE", `/api/conversations/${w.b}/members/${w.owner.id}`)).status).toBe(200);
    const after = socket.events.length;
    const first = await socket.next((e) => e.type === "whisper" && e.whisper.id === both!.id, { from: after });
    expect(first.whisper.status).toBe("open");
    expect(first.whisper.detail.hits.map((h: WireHit) => [h.where, h.text])).toEqual([["你和它的专属会话", OWN_NOTE]]);
    expect(JSON.stringify(first)).not.toContain("CANARY-ew");
    const second = await socket.next((e) => e.type === "whisper" && e.whisper.id === onlyB!.id, { from: after });
    expect(second.whisper.status).toBe("expired");
    expect(second.whisper.detail).toBeUndefined();
  });

  it("I-2: removed from that group by its creator: the same push", async () => {
    const w = await world();
    // Group C is mia's: she says the canary there, and later takes olive out.
    const c = await group(app, w.mia, "丙群", [w.owner, w.ned]);
    expect((await api(app, w.owner, "POST", `/api/conversations/${c}/members`, { principalId: w.agent.id })).status).toBe(201);
    await say(w.mia, c, "丙群里说：蓝鲸计划改到后天");
    await askInGroup(w, createElsewhere(elsewhereDeps()));
    const [made] = await whispersOf(w.owner.id, w.g);
    expect((await wireOf(w.owner, w.g, made!.id))!.detail!.hits.map((h) => h.where)).toContain("丙群");
    const socket = await connect(app, w.owner);
    expect((await api(app, w.mia, "DELETE", `/api/conversations/${c}/members/${w.owner.id}`)).status).toBe(200);
    const frame = await socket.next((e) => e.type === "whisper" && e.whisper.id === made!.id);
    expect(frame.whisper.detail.hits.map((h: WireHit) => h.where)).not.toContain("丙群");
  });

  // M-1: never twice, however the presses meet.
  it("M-1: two presses at once (two tabs): one answers telling, the other 409 busy_run; one told reply, posted once; both tabs end on told", async () => {
    const w = await world();
    await askInGroup(w, createElsewhere(elsewhereDeps()));
    const [whisper] = await whispersOf(w.owner.id, w.g);
    const tabs = [await connect(app, w.owner), await connect(app, w.owner)];
    const answers = await Promise.all([1, 2].map(() => api(app, w.owner, "POST", `/api/whispers/${whisper!.id}/accept`)));
    expect(answers.map((a) => a.status).sort()).toEqual([200, 409]);
    expect(answers.find((a) => a.status === 409)!.json).toEqual({ error: "busy_run" });
    expect(await toldRuns(w, whisper!.id)).toHaveLength(1);
    gateway.reply("蓝鲸计划在三楼。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(await app.agentWorker.runOnce()).toBe(false);
    expect((await agentSaid(w)).filter((m: any) => m.text === "蓝鲸计划在三楼。")).toHaveLength(1);
    for (const tab of tabs) await tab.waitFor((e) => e.type === "whisper" && e.whisper.id === whisper!.id && e.whisper.status === "told");
  });

  it("M-1: after a failed tell, a press and a 重试 at once: one starts the tell, the other is refused; one told reply, posted once", async () => {
    const { w, whisper } = await failedTell();
    const [press, again] = await Promise.all([api(app, w.owner, "POST", `/api/whispers/${whisper.id}/accept`), retry(w)]);
    expect([press.status, again.status].filter((s) => s === 200 || s === 201)).toHaveLength(1);
    expect([press.status, again.status].filter((s) => s === 409)).toHaveLength(1);
    expect((await toldRuns(w, whisper.id)).filter((r) => r.status === "queued")).toHaveLength(1);
    gateway.reply("蓝鲸计划在三楼。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(await app.agentWorker.runOnce()).toBe(false);
    expect((await agentSaid(w)).filter((m: any) => m.text === "蓝鲸计划在三楼。")).toHaveLength(1);
  });

  // M-2: the owner or the Agent gone from the group while telling: closed for good.
  for (const who of ["the owner", "the Agent"] as const) {
    it(`M-2: ${who} leaving the group while its told reply is under way: the whisper expires for good, the told reply posts nothing, and the push says expired`, async () => {
      const w = await world();
      const socket = await connect(app, w.owner);
      await askInGroup(w, createElsewhere(elsewhereDeps()));
      const [whisper] = await whispersOf(w.owner.id, w.g);
      expect((await api(app, w.owner, "POST", `/api/whispers/${whisper!.id}/accept`)).status).toBe(200);
      const ticket = (await app.agentPort.claimNext())!;
      const leaver = who === "the owner" ? w.owner.id : w.agent.id;
      expect((await api(app, w.owner, "DELETE", `/api/conversations/${w.g}/members/${leaver}`)).status).toBe(200);
      await app.agentPort.releaseRun(ticket.id);
      expect(await statusOf(whisper!.id)).toBe("expired");
      expect((await agentSaid(w)).filter((m: any) => m.text === "蓝鲸计划在三楼。")).toEqual([]);
      await socket.waitFor((e) => e.type === "whisper" && e.whisper.id === whisper!.id && e.whisper.status === "expired");
      // And nothing after makes it open again.
      await settled([socket], w.mia, w.b);
      const frames = socket.events.filter((e) => e.type === "whisper" && e.whisper.id === whisper!.id).map((e) => e.whisper.status);
      expect(frames.at(-1)).toBe("expired");
      expect(frames.slice(frames.indexOf("expired"))).toEqual(frames.slice(frames.indexOf("expired")).map(() => "expired"));
    });
  }

  // M-4: one copy, one moment.
  it("M-4: a copy of a whisper (a push, the list route, an answer) is read at one moment: the row, its told replies and its hits", async () => {
    const w = await world();
    await askInGroup(w, createElsewhere(elsewhereDeps()));
    const [whisper] = await whispersOf(w.owner.id, w.g);
    const socket = await connect(app, w.owner);
    // Every transaction's statements, recorded per transaction.
    const real = app.deps.db.tx;
    const txs: string[][] = [];
    app.deps.db.tx = ((fn: (t: unknown) => Promise<unknown>) =>
      real.call(app.deps.db, (t: any) => {
        const seen: string[] = [];
        txs.push(seen);
        const spied = new Proxy(t, { get: (o, p) => (p === "query" ? (text: unknown, params?: unknown) => (seen.push(String(text)), o.query(text, params)) : Reflect.get(o, p)) });
        return fn(spied);
      })) as typeof real;
    try {
      const snapshotOf = (pred: (sql: string) => boolean) => txs.find((seen) => seen.some(pred));
      const readsHits = (s: string) => /jsonb_array_elements/.test(s) && /join messages m/.test(s) && /join principals sp/.test(s);
      expect((await api(app, w.owner, "GET", `/api/conversations/${w.g}/whispers`)).status).toBe(200);
      const listed = snapshotOf(readsHits);
      expect(listed?.[0]).toMatch(/repeatable read/);
      expect(listed!.some((s) => /from whispers/.test(s) && /order by after_seq desc/.test(s))).toBe(true);
      expect(listed!.some((s) => /left join agent_runs r/.test(s))).toBe(true);
      txs.length = 0;
      app.realtime.pushWhisper({ id: whisper!.id, ownerId: w.owner.id });
      await socket.waitFor((e) => e.type === "whisper" && e.whisper.id === whisper!.id);
      const pushed = snapshotOf(readsHits);
      expect(pushed?.[0]).toMatch(/repeatable read/);
      expect(pushed!.some((s) => /from whispers where owner_id = \$1 and id = any/.test(s))).toBe(true);
      txs.length = 0;
      expect((await api(app, w.owner, "POST", `/api/whispers/${whisper!.id}/accept`)).status).toBe(200);
      // An answer's own copy is read in the answer's transaction, after what it wrote (the told reply it queued: telling),
      // so nothing is read after its commit (F3): there the whisper's row, the Agent's (which every told reply's start and
      // retry takes) and the conversation's are held, so its told replies cannot change between its reads — one moment for
      // all it is derived from. Its push is read on a snapshot of its own, as every push.
      const answered = txs.find((seen) => seen.some((s) => /from whispers where id = \$1 and owner_id = \$2 for update/.test(s)));
      expect(answered!.some(readsHits)).toBe(true);
      expect(answered!.some((s) => /left join agent_runs r/.test(s))).toBe(true);
    } finally {
      app.deps.db.tx = real;
    }
  });

  // M-5: one rule for whether a hit can be read — the dot, the answer and the bubble agree whatever a reference holds.
  it("M-5: a reference of another shape (no `at`, a seq that is no number, a conversation id that is no uuid) points at nothing, for the count, the answer and the bubble alike", async () => {
    const w = await world();
    await askInGroup(w, createElsewhere(elsewhereDeps()));
    const [whisper] = await whispersOf(w.owner.id, w.g);
    const good = whisper!.body.detail!.hits[0]!;
    for (const bad of [{ conversationId: good.conversationId, seq: good.seq }, { ...good, seq: String(good.seq) }, { ...good, conversationId: "nope" }, { ...good, at: -1 }]) {
      await db.query("update whispers set body = jsonb_set(body, '{detail,hits}', $2::jsonb) where id = $1", [whisper!.id, JSON.stringify([bad])]);
      const label = JSON.stringify(bad);
      expect([label, (await wireOf(w.owner, w.g, whisper!.id))!.status]).toEqual([label, "expired"]);
      expect([label, "whispers" in (await api(app, w.owner, "GET", `/api/conversations/${w.g}`)).json]).toEqual([label, false]);
      expect([label, (await api(app, w.owner, "POST", `/api/whispers/${whisper!.id}/accept`)).status]).toEqual([label, 409]);
    }
    // The well-shaped one again: all of them say open.
    await db.query("update whispers set body = jsonb_set(body, '{detail,hits}', $2::jsonb) where id = $1", [whisper!.id, JSON.stringify([good])]);
    expect((await wireOf(w.owner, w.g, whisper!.id))!.status).toBe("open");
    expect((await api(app, w.owner, "GET", `/api/conversations/${w.g}`)).json.whispers).toBe(1);
  });
});

describe("fix round 2", () => {
  /** Every transaction's statements while `work` runs, one list per transaction (app.deps.db.tx, wrapped). */
  async function recordingTxs<T>(work: () => Promise<T>): Promise<{ result: T; txs: string[][] }> {
    const real = app.deps.db.tx;
    const txs: string[][] = [];
    app.deps.db.tx = ((fn: (t: unknown) => Promise<unknown>) =>
      real.call(app.deps.db, (t: any) => {
        const seen: string[] = [];
        txs.push(seen);
        return fn(new Proxy(t, { get: (o, p) => (p === "query" ? (text: unknown, params?: unknown) => (seen.push(String(text)), o.query(text, params)) : Reflect.get(o, p)) }));
      })) as typeof real;
    try {
      return { result: await work(), txs };
    } finally {
      app.deps.db.tx = real;
    }
  }

  it("M-9: removing someone reads none of her whispers in the removal's transaction (nothing of its time depends on them); she is still pushed hers that pointed there, after it, on her own queue", async () => {
    const w = await world();
    // C is mia's: she says something there about 蓝鲸计划, and later takes olive out.
    const c = await group(app, w.mia, "丙群", [w.owner, w.ned]);
    expect((await api(app, w.owner, "POST", `/api/conversations/${c}/members`, { principalId: w.agent.id })).status).toBe(201);
    await say(w.mia, c, "丙群里说：蓝鲸计划改到后天");
    await askInGroup(w, createElsewhere(elsewhereDeps()));
    const [made] = await whispersOf(w.owner.id, w.g);
    const socket = await connect(app, w.owner);
    const { result, txs } = await recordingTxs(() => api(app, w.mia, "DELETE", `/api/conversations/${c}/members/${w.owner.id}`));
    expect(result.status).toBe(200);
    const removal = txs.find((seen) => seen.some((s) => /update memberships set left_seq/.test(s)));
    expect(removal).toBeDefined();
    // No read of where her whispers point (the remover's request waits for nothing of hers).
    expect(removal!.filter((s) => /jsonb_build_object\('conversationId'/.test(s))).toEqual([]);
    const frame = await socket.next((e) => e.type === "whisper" && e.whisper.id === made!.id);
    expect(frame.whisper.detail.hits.map((h: WireHit) => h.where)).not.toContain("丙群");
  });

  it("M-10: a failed told reply is offered 重试 (retryable) only while its whisper reads open: after 不用 its owner is pushed the slot without it, and reads it so; another member reads byte for byte what they read before", async () => {
    const { w, whisper, told } = await failedTold();
    const socket = await connect(app, w.owner);
    expect(await ownSlot(w)).toMatchObject({ id: told.id, status: "failed", retryable: true });
    const before = JSON.stringify(await slotOf(w, w.mia));
    expect((await api(app, w.owner, "POST", `/api/whispers/${whisper.id}/decline`)).status).toBe(200);
    const pushed = await socket.next((e) => e.type === "run" && e.run?.id === told.id);
    expect(pushed.run).toMatchObject({ status: "failed", retryable: false });
    expect(await ownSlot(w)).toMatchObject({ id: told.id, status: "failed", retryable: false });
    expect(JSON.stringify(await slotOf(w, w.mia))).toBe(before);
    // The race answer stays: a retry asked anyway is refused stale.
    expect((await api(app, w.owner, "POST", `/api/conversations/${w.g}/runs/retry`, { agentId: w.agent.id })).status).toBe(409);
  });

  it("M-10: a day after the whisper was made its failed told reply is not offered 重试 — before the sweep (read so) and once the sweep expires it (pushed so)", async () => {
    const { w, whisper, told } = await failedTold();
    const socket = await connect(app, w.owner);
    await db.query("update whispers set created_at = now() - interval '25 hours' where id = $1", [whisper.id]);
    expect(await ownSlot(w)).toMatchObject({ id: told.id, status: "failed", retryable: false });
    const from = socket.events.length;
    await changeSweep(app.deps, app.deps.config, app.log, app.realtime);
    const pushed = await socket.next((e) => e.type === "run" && e.run?.id === told.id, { from });
    expect(pushed.run).toMatchObject({ status: "failed", retryable: false });
  });

  it("M-10: a failed told reply whose whisper still reads open is offered 重试 as any failed reply is", async () => {
    const { w, told } = await failedTold();
    expect(await ownSlot(w)).toMatchObject({ id: told.id, status: "failed", retryable: true });
  });
});

describe("fix round 3: the moment an offer ends, on its owner's wire", () => {
  const HOURS = () => app.deps.config.whispers.elsewhereTtlHours * HOUR;
  const madeAt = async (id: string) => (await db.query<{ ms: string }>("select floor(extract(epoch from created_at) * 1000)::bigint::text as ms from whispers where id = $1", [id])).rows[0]!.ms;
  /** The whisper's own made time, to the millisecond, plus `WHISPERS.elsewhereTtlHours`: when the server's rule (`mayTell`) stops letting it be told. */
  const endOf = async (id: string) => new Date(Number(await madeAt(id)) + HOURS()).toISOString();

  it("a failed told reply's slot carries `retryableUntil` — its whisper's made time plus the day — to its owner alone; the server's own rule turns at that same moment", async () => {
    const w = await world();
    const [mia] = [await connect(app, w.mia)];
    const ownerSocket = await connect(app, w.owner);
    await askInGroup(w, createElsewhere(elsewhereDeps()));
    const [whisper] = await whispersOf(w.owner.id, w.g);
    expect((await api(app, w.owner, "POST", `/api/whispers/${whisper!.id}/accept`)).status).toBe(200);
    gateway.fail("provider_unavailable", { status: 502 });
    expect(await app.agentWorker.runOnce()).toBe(true);
    const told = (await runsOf(w.agent.id, w.g)).at(-1)!;
    const until = await endOf(whisper!.id);
    // The owner's push of the failed run, and her read of the slot.
    const pushed = await ownerSocket.next((e) => e.type === "run" && e.run?.id === told.id && e.run.status === "failed");
    expect(pushed.run).toMatchObject({ retryable: true, retryableUntil: until });
    expect(await ownSlot(w)).toMatchObject({ retryable: true, retryableUntil: until });
    // Nobody else: not in a member's read of the group's replies, nor in any frame of hers.
    await settled([mia], w.ned, w.g);
    expect(JSON.stringify((await api(app, w.mia, "GET", `/api/conversations/${w.g}/runs`)).json)).not.toContain("retryableUntil");
    expect(JSON.stringify(mia.events)).not.toContain("retryableUntil");
    // The server's rule turns at that moment: a minute before it, a retry is taken; a minute after, refused.
    await db.query("update whispers set created_at = now() - ($2::bigint - 60000) * interval '1 millisecond' where id = $1", [whisper!.id, HOURS()]);
    expect((await ownSlot(w)).retryable).toBe(true);
    await db.query("update whispers set created_at = now() - ($2::bigint + 60000) * interval '1 millisecond' where id = $1", [whisper!.id, HOURS()]);
    const after = await ownSlot(w);
    expect([after.retryable, "retryableUntil" in after]).toEqual([false, false]);
    expect(await api(app, w.owner, "POST", `/api/conversations/${w.g}/runs/retry`, { agentId: w.agent.id })).toEqual({ status: 409, json: { error: "stale_whisper" } });
  });

  it("an open found_elsewhere whisper carries `openUntil` — the same moment — to its owner alone (none while telling, told or ended); the server reads it expired from then", async () => {
    const w = await world();
    const mia = await connect(app, w.mia);
    const ownerSocket = await connect(app, w.owner);
    await askInGroup(w, createElsewhere(elsewhereDeps()));
    const [whisper] = await whispersOf(w.owner.id, w.g);
    const until = await endOf(whisper!.id);
    expect((await wireOf(w.owner, w.g, whisper!.id)) as unknown).toMatchObject({ status: "open", openUntil: until });
    const push = await ownerSocket.next((e) => e.type === "whisper" && e.whisper.id === whisper!.id);
    expect(push.whisper.openUntil).toBe(until);
    // Telling: no offer to end.
    expect((await api(app, w.owner, "POST", `/api/whispers/${whisper!.id}/accept`)).json).not.toHaveProperty("openUntil");
    await settled([mia], w.ned, w.g);
    expect(JSON.stringify(mia.events)).not.toContain("openUntil");
    expect(JSON.stringify((await api(app, w.mia, "GET", "/api/sync")).json)).not.toContain("openUntil");
    // Past that moment (its told reply ended without posting meanwhile): expired, and nothing to end.
    gateway.fail("provider_unavailable", { status: 502 });
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect((await wireOf(w.owner, w.g, whisper!.id)) as unknown).toMatchObject({ status: "open", openUntil: until });
    await db.query("update whispers set created_at = now() - ($2::bigint + 60000) * interval '1 millisecond' where id = $1", [whisper!.id, HOURS()]);
    const ended = (await wireOf(w.owner, w.g, whisper!.id))!;
    expect([ended.status, "openUntil" in ended]).toEqual(["expired", false]);
  });
});

describe("fix round 4", () => {
  /**
   * Each task the hub delivers on `conversationId`'s queue, with the statements it sends as it starts — before it first
   * waits, which is where it reads what it needs (`runAudience`, the members, the messages) — and every statement with its
   * parameters meanwhile; `stop` puts both back.
   */
  function onQueue(conversationId: string) {
    const hub = app.realtime as unknown as { run(id: string, task: object): Promise<void> };
    const real = app.deps.db.query;
    const tasks: { task: string; sql: string[] }[] = [];
    const sent: { text: string; params: unknown }[] = [];
    let current: string[] | null = null;
    app.deps.db.query = ((text: unknown, params?: unknown) => {
      sent.push({ text: String(text), params });
      current?.push(String(text));
      return (real as (...a: unknown[]) => unknown).call(app.deps.db, text, params);
    }) as typeof real;
    const run = Object.getPrototypeOf(hub).run as typeof hub.run;
    hub.run = function (id, task) {
      if (id !== conversationId.toLowerCase()) return run.call(this, id, task);
      const sql: string[] = [];
      tasks.push({ task: JSON.stringify(task), sql });
      current = sql;
      try {
        return run.call(this, id, task);
      } finally {
        current = null;
      }
    };
    return {
      tasks,
      sent,
      stop: () => {
        delete (hub as { run?: unknown }).run;
        app.deps.db.query = real;
      },
    };
  }
  /** `runAudience`'s one statement (agents/runs.ts): who is told what of a run, read for its delivery. */
  const AUDIENCE = /select c\.type, a\.agent_id, a\.owner_id, a\.whisper_id/;

  it("M-11: the slot pushed to its owner after 不用 reads nothing on the group's queue — a member's message sent at that moment is fanned out with no statement of it before", async () => {
    const { w, whisper, told } = await failedTold();
    const [owner, ned] = [await connect(app, w.owner), await connect(app, w.ned)];
    const from = owner.events.length;
    const queue = onQueue(w.g);
    try {
      const [declined, seq] = await Promise.all([api(app, w.owner, "POST", `/api/whispers/${whisper.id}/decline`), say(w.mia, w.g, "就现在")]);
      expect(declined.status).toBe(200);
      expect((await owner.next((e) => e.type === "run" && e.run?.id === told.id, { from })).run).toMatchObject({ status: "failed", retryable: false });
      await ned.waitFor((e) => e.type === "message" && e.message.conversationId === w.g && e.message.seq === seq);
    } finally {
      queue.stop();
    }
    const slot = queue.tasks.filter((t) => t.task.includes(told.id));
    expect(slot).toHaveLength(1);
    expect(slot[0]!.sql).toEqual([]);
    // Nothing anywhere read who is told what of that run: the push knew it (its owner, its Agent).
    expect(queue.sent.filter((s) => AUDIENCE.test(s.text) && JSON.stringify(s.params).includes(told.id))).toEqual([]);
  });

  it("M-12: a told reply failed, then its owner leaves the group its only hit was in: the bubble is pushed 已过期 and the slot without 重试 — no reconnect, no read of hers", async () => {
    const { w, whisper, told } = await failedTold({ query: "蓝鲸计划", from: "mia" });
    expect(whisper.body.detail!.hits.map((h) => h.conversationId)).toEqual([w.b]);
    const socket = await connect(app, w.owner);
    expect(await ownSlot(w)).toMatchObject({ id: told.id, status: "failed", retryable: true });
    const from = socket.events.length;
    expect((await api(app, w.owner, "DELETE", `/api/conversations/${w.b}/members/${w.owner.id}`)).status).toBe(200);
    const bubble = await socket.next((e) => e.type === "whisper" && e.whisper.id === whisper.id, { from });
    expect([bubble.whisper.status, bubble.whisper.detail]).toEqual(["expired", undefined]);
    const slot = await socket.next((e) => e.type === "run" && e.run?.id === told.id, { from });
    expect(slot).toMatchObject({ conversationId: w.g, agentId: w.agent.id, run: { status: "failed", retryable: false } });
    expect(slot.run).not.toHaveProperty("retryableUntil");
    expect(await ownSlot(w)).toMatchObject({ id: told.id, retryable: false });
  });
});

describe("the service's own hook", () => {
  it("a reply on the app's worker whispers too (the toolbox the app builds carries the hook)", async () => {
    const w = await world();
    const ownerSocket = await connect(app, w.owner);
    await say(w.mia, w.g, "@olive_bot 上次说的那个计划在哪？");
    gateway.callTools([{ name: SEARCH_MESSAGES, input: { query: "蓝鲸计划" } }]).reply("这个群的记录里没找到。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    const frame = await ownerSocket.next((e) => e.type === "whisper");
    expect(frame).toMatchObject({ type: "whisper", whisper: { conversationId: w.g, kind: "found_elsewhere", text: FOUND_ELSEWHERE, status: "open" } });
    expect(frame.whisper.detail.hits.map((h: WireHit) => h.text)).toEqual([OWN_NOTE, CANARY]);
  });
});

describe("the system's automatic retry and a found-elsewhere whisper (README Replies, Automatic retry: round 1 I-5, I-6)", () => {
  let offset = 0;
  const now = (): Date => new Date(Date.now() + offset);
  /** A worker of a port whose replies the system does try again (20 s, then 2 min), on the fake clock `now`. */
  function retrying(hook?: ElsewhereHook): { worker: AgentWorker; port: ReturnType<typeof createAgentPort> } {
    const { db: pool, blobs, conversations, reads, config, searches } = app.deps;
    const on = { ...config, agents: { autoRetryDelaysMs: [20_000, 120_000] } };
    const toolbox = createToolbox({ db: pool, blobs, searches, config: on, log: app.log, ...(hook ? { elsewhere: hook } : {}) });
    const port = createAgentPort({ db: pool, config: on, blobs, realtime: app.realtime, conversations, reads, log: app.log, toolbox, now });
    return { port, worker: createAgentWorker({ port, models: gateway, runTimeoutMs: on.agentRunTimeoutMs, maxRunsInFlight: 1, background: false, log: app.log, tools: on.tools }) };
  }

  it("a told reply that fails for a passing reason, its whisper open, is not tried again: the whisper reads open again, and a member's call noted on it is followed up at once", async () => {
    offset = 0;
    const w = await world();
    await askInGroup(w, createElsewhere(elsewhereDeps()));
    const [whisper] = await whispersOf(w.owner.id, w.g);
    expect((await api(app, w.owner, "POST", `/api/whispers/${whisper!.id}/accept`)).status).toBe(200);
    // Ned calls the Agent while the told reply waits: noted on it, never taken on.
    const nedAsked = await say(w.ned, w.g, "@olive_bot 我也有个问题");
    const { worker } = retrying();
    gateway.fail("provider_unavailable", { status: 503 });
    expect(await worker.runOnce()).toBe(true);
    const runs = await db.query<{ status: string; whisper_id: string | null; auto_attempt: number; caller_id: string | null; covers: string }>(
      "select status, whisper_id, auto_attempt, caller_id, covers_seq::text as covers from agent_runs where agent_id = $1 and conversation_id = $2 order by created_at",
      [w.agent.id, w.g],
    );
    expect(runs.rows.map((r) => [r.status, r.whisper_id !== null, r.auto_attempt])).toEqual([
      ["done", false, 0],
      ["failed", true, 0],
      ["queued", false, 0],
    ]);
    expect(runs.rows[2]).toMatchObject({ caller_id: w.ned.id, covers: String(nedAsked) });
    expect((await wireOf(w.owner, w.g, whisper!.id))!.status).toBe("open");
    offset += 200_000;
    gateway.reply("回答 ned。");
    expect(await worker.runOnce()).toBe(true);
    expect(await worker.runOnce()).toBe(false);
  });

  it("a told reply lost mid-call after its whisper stopped reading open is not tried again either", async () => {
    offset = 0;
    const w = await world();
    await askInGroup(w, createElsewhere(elsewhereDeps()));
    const [whisper] = await whispersOf(w.owner.id, w.g);
    expect((await api(app, w.owner, "POST", `/api/whispers/${whisper!.id}/accept`)).status).toBe(200);
    const { port, worker } = retrying();
    const lost = await port.claimNext();
    expect(lost).not.toBeNull();
    await db.query("update whispers set created_at = created_at - interval '25 hours' where id = $1", [whisper!.id]);
    expect(await port.releaseRun(lost!.id)).toBe(true);
    offset += 200_000;
    expect(await worker.runOnce()).toBe(false);
    const runs = await runsOf(w.agent.id, w.g);
    expect(runs.map((r) => [r.status, r.whisper_id !== null])).toEqual([
      ["done", false],
      ["failed", true],
    ]);
  });

  it("a reply whose later round fails after its search found nothing here is not retried by the system (it had done a tool round); its owner's 重试 searches again and makes no second whisper about the same question", async () => {
    offset = 0;
    const w = await world();
    const hook = createElsewhere(elsewhereDeps());
    const { worker } = retrying(hook);
    await say(w.mia, w.g, "@olive_bot 群里有人说过蓝鲸计划吗？");
    gateway.callTools([{ name: SEARCH_MESSAGES, input: { query: "蓝鲸计划" } }]).fail("provider_unavailable", { status: 503 });
    expect(await worker.runOnce()).toBe(true);
    await hook.idle();
    expect(await whispersOf(w.owner.id, w.g)).toHaveLength(1);
    offset += 200_000;
    expect(await worker.runOnce()).toBe(false);
    expect((await api(app, w.owner, "POST", `/api/conversations/${w.g}/runs/retry`, { agentId: w.agent.id })).status).toBe(201);
    gateway.callTools([{ name: SEARCH_MESSAGES, input: { query: "蓝鲸计划" } }]).reply("这个群的记录里没找到。");
    expect(await worker.runOnce()).toBe(true);
    await hook.idle();
    expect(await whispersOf(w.owner.id, w.g)).toHaveLength(1);
    expect((await runsOf(w.agent.id, w.g)).map((r) => r.status)).toEqual(["failed", "done"]);
  });
});

describe("hitOf: the ranges follow the cut", () => {
  const typed = "@mia";
  const row = (text: string, at: number, mentions: Array<{ id: string; start: number; length: number }>): HitRow => ({
    whisperId: "w",
    ord: 1,
    at,
    createdAt: new Date("2026-01-01T10:00:00Z"),
    text,
    mentions,
    attachmentName: null,
    senderName: "Ned",
    senderHandle: "ned",
    title: "乙群",
    conversationType: "group",
  });
  // (A mention of characters that weigh as much as the words around it, so the windows below are cut by count: `typed` is ASCII, and weighs less.)
  const wide = "＠米娅";
  const range = (start: number, length = typed.length) => ({ id: "u1", start, length });
  /** Every range is exactly the typed mention, whole, and no half of a surrogate pair is anywhere in the text. */
  const intact = (hit: ReturnType<typeof hitOf>, name = typed) => {
    for (const m of hit.mentions) expect(hit.text.slice(m.start, m.start + m.length)).toBe(name);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(hit.text)).toBe(false);
  };

  it("the tail ellipsis: ranges before the cut are kept where they were; the one the end of the window straddles, and the one after it, are left out", () => {
    // The window of a line cut from its start holds 199 characters (200 less the ellipsis).
    const text = `${"字".repeat(10)}${wide}${"字".repeat(185)}${wide}${"字".repeat(60)}${wide}`;
    expect(text.indexOf(wide, 20)).toBe(198); // (198 to 201: across the end of the window)
    const hit = hitOf(row(text, 0, [range(10, 3), range(198, 3), range(text.length - 3, 3)]), "UTC");
    expect(hit.text.endsWith("…")).toBe(true);
    expect(hit.text.startsWith("…")).toBe(false);
    expect(hit.mentions).toEqual([range(10, 3)]);
    intact(hit, wide);
  });

  it("the head ellipsis: ranges move by its one character; the one the start of the window straddles is left out", () => {
    // The words at 300; the window starts 60 characters before them, at 240: the first range (238 to 242) is across it, the second (262) is inside.
    const text = `${"前".repeat(238)}${wide}${"前".repeat(21)}${wide}${"前".repeat(35)}蓝鲸计划${"后".repeat(300)}`;
    expect(text.indexOf("蓝鲸计划")).toBe(300);
    const hit = hitOf(row(text, 300, [range(238, 3), range(262, 3)]), "UTC");
    expect(hit.text.startsWith("…")).toBe(true);
    expect(hit.mentions).toEqual([range(262 - 240 + "…".length, 3)]);
    intact(hit, wide);
  });

  it("a surrogate pair at the cut is never split; a range over the pair the cut took is left out, one over a pair that stays is kept", () => {
    // 190 characters of 3 bytes after the mention, then pairs of 4: five of them fit the window (597 bytes), the sixth and seventh do not.
    const text = `${typed}${"字".repeat(190)}${"😀".repeat(7)}`;
    const fifth = 194 + 4 * 2;
    const sixth = fifth + 2;
    const hit = hitOf(row(text, 0, [range(0), range(fifth, 2), range(sixth, 2)]), "UTC");
    expect(hit.text.endsWith("…")).toBe(true);
    expect(Array.from(hit.text).filter((c) => c === "😀")).toHaveLength(5);
    expect(hit.mentions).toEqual([range(0), range(fifth, 2)]);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(hit.text)).toBe(false);
    // A mention after a pair: its start counts the pair as two units, as the text it is drawn on does.
    const after = hitOf(row(`好😀${typed}`, 0, [range(3)]), "UTC");
    expect(after.mentions).toEqual([range(3)]);
    intact(after);
  });

  it("the clip at 200 characters: a range wholly inside it is kept; one that crosses it, or lies past it though the window holds it, is left out", () => {
    // ASCII weighs a third of a character: the window holds 597 of them, the hit shows 200.
    const chars = Array.from({ length: 800 }, () => "a");
    for (const at of [10, 197, 300]) chars.splice(at, typed.length, ...typed);
    const hit = hitOf(row(chars.join(""), 0, [range(10), range(197), range(300)]), "UTC");
    expect(Array.from(hit.text)).toHaveLength(QUOTE_MAX_CHARS);
    expect(hit.mentions).toEqual([range(10)]);
    intact(hit);
  });
});
