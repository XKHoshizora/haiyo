import { afterEach, describe, expect, it } from "vitest";
import { createAgentPort, recoverRuns, sweepStaleRuns } from "../src/agents/port-impl.ts";
import { afterTell, afterTellsEnded, createWhisper } from "../src/whispers/store.ts";
import { changeSweep } from "../src/app.ts";
import { NO_TOOLS, TOLD_NO_TOOLS, TOOL_MATERIAL } from "../src/agents/runtime/prompt.ts";
import { createAgentWorker, type AgentWorker } from "../src/agents/runtime/worker.ts";
import { createElsewhere, ELSEWHERE_HITS_MAX, ELSEWHERE_OPEN_MAX, FOUND_ELSEWHERE, TELL_HOW, TELL_THEM, type ElsewhereDeps, type ElsewhereHook } from "../src/agents/tools/elsewhere.ts";
import { RunRefs } from "../src/agents/tools/refs.ts";
import { createToolbox, SEARCH_MESSAGES, type ToolDeps } from "../src/agents/tools/index.ts";
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
 * reply of the Agent in the group, its owner's own, that is shown the hits and offered no tools.
 */

const gateway = scriptedGateway();
const { app, db } = useApp({ env: SITE_ENV, models: gateway, agentWorker: false, tools: true });
afterEach(async () => {
  await closeAllSockets();
  expect(gateway.pending()).toBe(0);
});

const FAST = { source: "site", id: "fast" } as const;
const CANARY = "CANARY-ew 蓝鲸计划在三楼";

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
const whispersOf = async (ownerId: string, conv: string) =>
  (await db.query<{ id: string; status: string; body: { text: string; actions: string[]; detail?: { hits: Array<{ where: string; who: string; when: string; text: string }> } } }>(
    "select id, status, body from whispers where owner_id = $1 and conversation_id = $2 order by created_at",
    [ownerId, conv],
  )).rows;
const runsOf = async (agentId: string, conv: string) =>
  (await db.query<{ id: string; status: string; lane: string; triggered_by: string; caller_id: string | null; whisper_id: string | null }>(
    "select id, status, lane, triggered_by, caller_id, whisper_id from agent_runs where agent_id = $1 and conversation_id = $2 order by created_at",
    [agentId, conv],
  )).rows;

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
  await say(owner, agent.conversationId, "记一下：蓝鲸计划的口令是七七");
  // (The Agent's own conversation: the message started a reply there; it is not this file's business.)
  await db.query("update agent_runs set status = 'cancelled', finished_at = now() where agent_id = $1 and status = 'queued'", [agent.id]);
  return { owner, mia, ned, agent: agent as { id: string; conversationId: string }, g, b };
}
type World = Awaited<ReturnType<typeof world>>;

/** One reply in G, asked by `asker`, whose search (`input`) finds nothing in G: what its model was handed. */
async function askInGroup(w: World, hook: ElsewhereHook, asker: Actor = w.mia, d?: Db, input: Record<string, unknown> = { query: "蓝鲸计划" }) {
  await say(asker, w.g, "@olive_bot 上次说的那个计划在哪？");
  gateway.callTools([{ name: SEARCH_MESSAGES, input }]).reply("这个群的记录里没找到。");
  expect(await toolWorker(toolDeps(hook, d)).runOnce()).toBe(true);
  await hook.idle();
  return outputs(gateway.calls.at(-1)!)[0];
}

describe("a search in a group that finds nothing there", () => {
  it("found elsewhere: one whisper to the owner with the hits; the model is told the plain not-found, and nobody else is sent or shown anything", async () => {
    const w = await world();
    const sockets = { owner: await connect(app, w.owner), mia: await connect(app, w.mia), ned: await connect(app, w.ned) };
    const hook = createElsewhere(elsewhereDeps());
    const told = await askInGroup(w, hook);
    expect(told).toEqual({ results: [], note: "这个群的记录里没找到。" });
    const [made] = await whispersOf(w.owner.id, w.g);
    expect(made).toMatchObject({ status: "open", body: { text: FOUND_ELSEWHERE, actions: ["tell", "dismiss"] } });
    const hits = made!.body.detail!.hits;
    expect(hits.map((h) => [h.where, h.text])).toEqual([
      ["我们的专属会话", "记一下：蓝鲸计划的口令是七七"],
      ["乙群", CANARY],
    ]);
    expect(Object.keys(hits[0]!).sort()).toEqual(["text", "when", "where", "who"]);
    expect(hits.map((h) => h.who)).toEqual(["olive", "mia"]);
    await sockets.owner.waitFor((e) => e.type === "whisper" && e.whisper.id === made!.id);
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

  it("the model's tool result is the same, byte for byte, whether anything was found elsewhere or not", async () => {
    const w = await world();
    const hook = createElsewhere(elsewhereDeps());
    const withHits = await askInGroup(w, hook);
    await db.query("update agents set whisper_elsewhere = false where principal_id = $1", [w.agent.id]);
    const without = await askInGroup(w, hook);
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
    await say(w.mia, w.g, "@olive_bot 两件事");
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
    expect(made!.body.detail!.hits.map((h) => h.text)).toEqual([CANARY]);
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
    const scope = { id: run, agentId: w.agent.id, ownerId: w.owner.id, conversationId: w.g, group: true, refs: new RunRefs(), heardTo: 1, mark: null };
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

  it("at most 5 hits, the newest first, each text at most 200 characters", async () => {
    const w = await world();
    for (let i = 0; i < 6; i++) await say(w.mia, w.b, `第${i}次：蓝鲸计划${"很长的话".repeat(80)}`);
    const hook = createElsewhere(elsewhereDeps());
    await askInGroup(w, hook);
    const [made] = await whispersOf(w.owner.id, w.g);
    const hits = made!.body.detail!.hits;
    expect(hits).toHaveLength(ELSEWHERE_HITS_MAX);
    expect(hits.map((h) => h.text.slice(0, 3))).toEqual(["第5次", "第4次", "第3次", "第2次", "第1次"]);
    expect(hits.every((h) => Array.from(h.text).length <= 200)).toBe(true);
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
    expect(made!.body.detail!.hits.map((h) => [h.where, h.text])).toEqual([["我们的专属会话", "记一下：蓝鲸计划的口令是七七"]]);
  });
});

describe("告诉他们", () => {
  async function whispered() {
    const w = await world();
    const hook = createElsewhere(elsewhereDeps());
    await askInGroup(w, hook);
    const [made] = await whispersOf(w.owner.id, w.g);
    return { w, whisper: made! };
  }

  it("queues one reply of the Agent in the group, its owner's own, shown the hits as material and offered no tools; it posts there", async () => {
    const { w, whisper } = await whispered();
    const ownerSocket = await connect(app, w.owner);
    const accepted = await api(app, w.owner, "POST", `/api/whispers/${whisper.id}/accept`);
    expect(accepted.status).toBe(200);
    expect(accepted.json.status).toBe("accepted");
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
    const last = (await api(app, w.mia, "GET", `/api/conversations/${w.g}/messages`)).json.messages.at(-1);
    expect([last.senderId, last.text]).toEqual([w.agent.id, "蓝鲸计划在三楼。"]);
    // Answered once: again is stale.
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
    const hits = made!.body.detail!.hits;
    // The owner is shown where and who (the title without its citation).
    expect(hits[0]).toMatchObject({ where: "丙群CANARY-where", who: "CANARY-who", text: "@someone_bot 蓝鲸计划改到周五了" });
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
    for (const never of ["CANARY-where", "CANARY-who", "我们的专属会话", "丙群", "乙群"]) expect([never, whole.includes(never)]).toEqual([never, false]);
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
    gateway.reply("蓝鲸计划在三楼。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    const call = gateway.calls.at(-1)!;
    expect(call.tools ?? []).toEqual([]);
    expect(call.system).toContain(TELL_THEM);
    expect(call.system).toContain(CANARY);
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
    const said = (await api(app, w.mia, "GET", `/api/conversations/${w.g}/messages`)).json.messages.filter((m: any) => m.senderId === w.agent.id).map((m: any) => m.text);
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
    const said = async () =>
      (await api(app, w.mia, "GET", `/api/conversations/${w.g}/messages`)).json.messages.filter((m: any) => m.senderId === w.agent.id).map((m: any) => m.text);
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
    const said = (await api(app, w.mia, "GET", `/api/conversations/${w.g}/messages`)).json.messages.filter((m: any) => m.senderId === w.agent.id).map((m: any) => m.text);
    expect(said.at(-1)).toBe("周五下午三点。");
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

describe("a tell is never lost (round 3)", () => {
  const whisperStatus = async (id: string) => (await db.query<{ status: string }>("select status from whispers where id = $1", [id])).rows[0]!.status;
  /** The whisper made, its owner's 告诉他们 answered, and the told reply queued; the sockets of all three, open from the start. */
  async function toldQueued() {
    const w = await world();
    const sockets = { owner: await connect(app, w.owner), mia: await connect(app, w.mia), ned: await connect(app, w.ned) };
    await askInGroup(w, createElsewhere(elsewhereDeps()));
    const [whisper] = await whispersOf(w.owner.id, w.g);
    expect((await api(app, w.owner, "POST", `/api/whispers/${whisper!.id}/accept`)).status).toBe(200);
    const told = (await runsOf(w.agent.id, w.g)).find((r) => r.whisper_id !== null)!;
    return { w, whisper: whisper!, told, sockets };
  }
  /** The owner was pushed the whisper open again; nobody else was pushed anything of it (their frames once everything has reached them). */
  async function reopenedForOwnerOnly(x: Awaited<ReturnType<typeof toldQueued>>) {
    const { w, whisper, sockets } = x;
    expect(await whisperStatus(whisper.id)).toBe("open");
    await sockets.owner.waitFor((e) => e.type === "whisper" && e.whisper.id === whisper.id && e.whisper.status === "open");
    await settled([sockets.mia, sockets.ned], w.ned, w.g);
    for (const socket of [sockets.mia, sockets.ned]) {
      expect(socket.events.some((e) => e.type === "whisper")).toBe(false);
      expect(JSON.stringify(socket.events)).not.toContain(whisper.id);
    }
    // Its hits and both buttons, as before; and 告诉他们 once more queues a fresh told reply.
    const [again] = await whispersOf(w.owner.id, w.g);
    expect(again!.body.actions).toEqual(["tell", "dismiss"]);
    expect((await api(app, w.owner, "POST", `/api/whispers/${whisper.id}/accept`)).status).toBe(200);
    expect((await runsOf(w.agent.id, w.g)).filter((r) => r.whisper_id === whisper.id && r.status === "queued")).toHaveLength(1);
  }

  it("failed as it ran: its whisper is open again, pushed to its owner alone; 告诉他们 tells once more", async () => {
    const x = await toldQueued();
    gateway.fail("provider_unavailable", { status: 502 });
    expect(await app.agentWorker.runOnce()).toBe(true);
    await reopenedForOwnerOnly(x);
  });

  it("ended by a release (as recovery ends one), twice at once: open again, once", async () => {
    const x = await toldQueued();
    const ticket = (await app.agentPort.claimNext())!;
    expect((await Promise.all([app.agentPort.releaseRun(ticket.id), app.agentPort.releaseRun(ticket.id)])).sort()).toEqual([false, true]);
    await reopenedForOwnerOnly(x);
    // Its frames: made (open), answered, given back (open) once, answered again.
    const frames = x.sockets.owner.events.filter((e) => e.type === "whisper" && e.whisper.id === x.whisper.id).map((e: any) => e.whisper.status);
    expect(frames).toEqual(["open", "accepted", "open", "accepted"]);
  });

  it("ended by recovery at start-up: open again", async () => {
    const x = await toldQueued();
    await app.agentPort.claimNext();
    expect(await recoverRuns(app.deps.db, app.deps.config, app.log)).toBe(1);
    expect(await whisperStatus(x.whisper.id)).toBe("open");
  });

  it("ended by the stale-run sweep: open again", async () => {
    const x = await toldQueued();
    const ticket = (await app.agentPort.claimNext())!;
    await db.query("update agent_runs set started_at = now() - interval '12 minutes' where id = $1", [ticket.id]);
    expect(await sweepStaleRuns(app.agentPort, app.deps.db, app.deps.config, app.log, () => false)).toBe(1);
    await reopenedForOwnerOnly(x);
  });

  it("stopped by its owner while queued: the tell ends and its whisper is open again; a member's call noted on it still gets its follow-up", async () => {
    const x = await toldQueued();
    const call = await say(x.w.ned, x.w.g, "@olive_bot 另外，周五几点开会？");
    expect((await api(app, x.w.owner, "POST", `/api/conversations/${x.w.g}/runs/${x.told.id}/stop`)).status).toBe(200);
    expect((await runsOf(x.w.agent.id, x.w.g)).find((r) => r.id === x.told.id)!.status).toBe("stopped");
    const follow = (await db.query<{ whisper_id: string | null; lane: string; caller_id: string | null; calls: string[] }>(
      "select whisper_id, lane, caller_id, call_seqs::text[] as calls from agent_runs where agent_id = $1 and conversation_id = $2 and status = 'queued'",
      [x.w.agent.id, x.w.g],
    )).rows;
    expect(follow).toEqual([{ whisper_id: null, lane: "others", caller_id: x.w.ned.id, calls: [String(call)] }]);
    expect(await whisperStatus(x.whisper.id)).toBe("open");
    await x.sockets.owner.waitFor((e) => e.type === "whisper" && e.whisper.id === x.whisper.id && e.whisper.status === "open");
    gateway.reply("周五下午三点。");
    expect(await app.agentWorker.runOnce()).toBe(true);
  });

  it("cancelled by its owner's pause while queued: open again (to tell once the Agent is resumed)", async () => {
    const x = await toldQueued();
    expect((await api(app, x.w.owner, "POST", `/api/agents/${x.w.agent.id}/pause`)).status).toBe(200);
    expect((await runsOf(x.w.agent.id, x.w.g)).find((r) => r.id === x.told.id)!.status).toBe("cancelled");
    expect(await whisperStatus(x.whisper.id)).toBe("open");
    await x.sockets.owner.waitFor((e) => e.type === "whisper" && e.whisper.id === x.whisper.id && e.whisper.status === "open");
  });

  it("posted: the whisper stays answered", async () => {
    const x = await toldQueued();
    gateway.reply("蓝鲸计划在三楼。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(await whisperStatus(x.whisper.id)).toBe("accepted");
  });

  it("the kind's cap holds: with 3 open there already, it stays answered", async () => {
    const x = await toldQueued();
    // Three more found_elsewhere whispers of the owner there, open (as later searches would make them).
    for (let i = 0; i < 3; i++) {
      await db.tx((t) => createWhisper(t, { conversationId: x.w.g, ownerId: x.w.owner.id, agentId: x.w.agent.id, kind: "found_elsewhere", body: { text: FOUND_ELSEWHERE, actions: ["tell", "dismiss"], detail: { hits: [] } } }));
    }
    gateway.fail("provider_unavailable", { status: 502 });
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(await whisperStatus(x.whisper.id)).toBe("accepted");
  });

  it("its owner gone from the group meanwhile: it stays closed", async () => {
    const x = await toldQueued();
    const ticket = (await app.agentPort.claimNext())!;
    expect((await api(app, x.w.owner, "DELETE", `/api/conversations/${x.w.g}/members/${x.w.owner.id}`)).status).toBe(200);
    await app.agentPort.releaseRun(ticket.id);
    // Still answered: a leaving expires only open whispers, and the give-back refuses an owner no longer there.
    expect(await whisperStatus(x.whisper.id)).toBe("accepted");
  });

  it("round 4, I-1: the give-back after a pause catches a failure per run — the others still go, and what changed is still returned (to push); the log names no content", async () => {
    const x = await toldQueued();
    // As the pause's own transaction leaves it: cancelled, its whisper still answered.
    await db.query("update agent_runs set status = 'cancelled', error = 'agent_paused', finished_at = now() where id = $1", [x.told.id]);
    const logged: unknown[] = [];
    const log = { error: (obj: unknown) => void logged.push(obj) };
    const given = await afterTellsEnded(app.deps.db, ["00000000-0000-0000-0000-00000000zzzz", x.told.id], ELSEWHERE_OPEN_MAX, log);
    expect(given.map((g) => [g.id, g.status])).toEqual([[x.whisper.id, "open"]]);
    expect(logged).toHaveLength(1);
    expect(JSON.stringify(logged)).not.toContain(CANARY);
  });

  it("round 4, I-1: the periodic sweep repairs a tell whose give-back never ran (the process stopped between the two): open again, pushed to its owner alone; only for an ending between a minute and a day ago", async () => {
    const x = await toldQueued();
    // The cancel committed; the give-back after it never ran.
    const ended = (ago: string) => db.query(`update agent_runs set status = 'cancelled', error = 'agent_paused', finished_at = now() - interval '${ago}' where id = $1`, [x.told.id]);
    // Not yet (under a minute: its own give-back may still be on its way), nor any more (over a day).
    for (const ago of ["10 seconds", "2 days"]) {
      await ended(ago);
      await changeSweep(app.deps, app.deps.config, app.log, app.realtime);
      expect([ago, await whisperStatus(x.whisper.id)]).toEqual([ago, "accepted"]);
    }
    // Two minutes ago: given back.
    await ended("2 minutes");
    await changeSweep(app.deps, app.deps.config, app.log, app.realtime);
    await reopenedForOwnerOnly(x);
    // Idempotent: the next sweep changes nothing more (it is answered again by now, and its told run is no longer the latest).
    await changeSweep(app.deps, app.deps.config, app.log, app.realtime);
    expect(await whisperStatus(x.whisper.id)).toBe("accepted");
  });

  it("round 4, M-1: only the whisper's latest told run gives it back — an earlier one ended without posting does not, once a newer tell was made", async () => {
    const x = await toldQueued();
    gateway.fail("provider_unavailable", { status: 502 });
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(await whisperStatus(x.whisper.id)).toBe("open");
    // Told once more: a newer run, the whisper answered again.
    expect((await api(app, x.w.owner, "POST", `/api/whispers/${x.whisper.id}/accept`)).status).toBe(200);
    expect(await db.tx((t) => afterTell(t, x.told.id, false, ELSEWHERE_OPEN_MAX))).toBeNull();
    expect(await whisperStatus(x.whisper.id)).toBe("accepted");
  });

  it("round 4, M-3: a tell with no hits left to tell does not loop — its whisper closes (expired, as one gone stale) instead of opening again", async () => {
    const x = await toldQueued();
    await db.query("update whispers set body = jsonb_set(body, '{detail,hits}', '[]'::jsonb) where id = $1", [x.whisper.id]);
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect((await runsOf(x.w.agent.id, x.w.g)).find((r) => r.id === x.told.id)!.status).toBe("cancelled");
    expect(await whisperStatus(x.whisper.id)).toBe("expired");
    await x.sockets.owner.waitFor((e) => e.type === "whisper" && e.whisper.id === x.whisper.id && e.whisper.status === "expired");
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
    expect(frame).toMatchObject({ type: "whisper", whisper: { conversationId: w.g, kind: "found_elsewhere", text: FOUND_ELSEWHERE } });
  });
});
