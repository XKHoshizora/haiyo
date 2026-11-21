import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentPort, type Toolbox } from "../src/agents/port-impl.ts";
import { createAgentWorker, type AgentWorker } from "../src/agents/runtime/worker.ts";
import type { ModelCall, ToolSpec } from "../src/models/gateway.ts";
import { api, befriend, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { closeAllSockets, connect, type Push, type TestSocket } from "./helpers/ws.ts";

/**
 * What people see of a reply's tools while it looks, and after (design rules 14, 15): the run's status carries the kind
 * of the tool that is running — to the owner, and in a group to every other member with the Agent's state —, never its
 * words, its results or what it found; the reply keeps what it looked up (`lookups`, `found`, `queries`), and each reader
 * is sent only what is theirs of it: the counts to everyone who sees the reply, of what was found only what they can see
 * themselves, the search words only to the Agent's owner in its own conversation. On the real port, hub and database,
 * with a toolbox the test gives the port.
 */

const gateway = scriptedGateway();
const { app, db } = useApp({ env: SITE_ENV, models: gateway, agentWorker: false });

afterEach(async () => {
  await closeAllSockets();
  expect(gateway.pending()).toBe(0);
});

const FAST = { source: "site", id: "fast" } as const;
/** The words the model searches for (its tool call's argument). */
const QUERY = "QUERY-tl4 蜀香在哪";
/** What the tool gives back to the model. */
const OUTPUT = "OUTPUT-tl4 结果正文";
/** A message of the owner's own conversation with the Agent. */
const PRIVATE = "PRIVATE-tl4 只跟它说的话";
/** A message in a group the owner is not in. */
const ELSEWHERE = "ELSEWHERE-tl4 别处的话";

const SEARCH: ToolSpec = {
  name: "search",
  description: "Search this conversation's messages.",
  parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
};

/** What the search "finds" in the test running now. */
let foundNow: Array<{ conversationId: string; seq: number }> = [];
const toolbox: Toolbox = {
  offer: () => ({ tools: [SEARCH], perTool: { search: 6 }, kinds: { search: "search" } }),
  run: async (_run, call) => ({ output: { hits: [OUTPUT] }, found: foundNow, query: (call.input as { query: string }).query }),
};

/** A worker on a port of the app's own with the toolbox. */
function toolWorker(): AgentWorker {
  const { db: pool, blobs, conversations, reads, config } = app.deps;
  const port = createAgentPort({ db: pool, config, blobs, realtime: app.realtime, conversations, reads, log: app.log, toolbox });
  return createAgentWorker({ port, models: gateway, runTimeoutMs: config.agentRunTimeoutMs, maxRunsInFlight: 1, background: false, log: app.log, tools: config.tools });
}

let txn = 0;
const say = async (who: Actor, conv: string, text: string, extra: object = {}): Promise<number> => {
  const sent = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `tl${++txn}`, ...extra });
  if (sent.status !== 201) throw new Error(`say: ${sent.status} ${JSON.stringify(sent.json)}`);
  return sent.json.message.seq as number;
};
/** A text message from `senderId` written straight into `conv` (no reply is triggered); its seq. */
async function postAs(conv: string, senderId: string, text: string): Promise<number> {
  const { rows } = await db.query<{ seq: string }>(
    `with c as (update conversations set seq = seq + 1 where id = $1 returning seq)
     insert into messages (conversation_id, seq, sender_id, kind, body) select $1, c.seq, $2, 'text', jsonb_build_object('text', $3::text) from c returning seq`,
    [conv, senderId, text],
  );
  return Number(rows[0]!.seq);
}
const bodyOf = async (conv: string, seq: number) =>
  (await db.query<{ body: Record<string, unknown> }>("select body from messages where conversation_id = $1 and seq = $2", [conv, seq])).rows[0]!.body;
const latestRun = async (agentId: string, conv: string) =>
  (await db.query<{ id: string }>("select id from agent_runs where agent_id = $1 and conversation_id = $2 order by created_at desc limit 1", [agentId, conv])).rows[0]!.id;
const ref = (conversationId: string, seq: number) => ({ conversationId, seq });

/** Every key of every object in `value`, at any depth. */
function keysOf(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) keysOf(v, out);
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysOf(v, out);
    }
  return out;
}
/** Keys that would carry a tool's words or results, or the search words: none of them in what someone else is sent. */
const ARGUMENT_KEYS = ["query", "queries", "input", "arguments", "args", "output", "results", "steps", "tool", "tools", "toolCalls"];

const runFrames = (socket: TestSocket, conv: string): Push[] => socket.events.filter((e) => e.type === "run" && e.conversationId === conv);
const activityFrames = (socket: TestSocket, conv: string): Push[] => runFrames(socket, conv).filter((e) => "activity" in e);
const messageFrame = (socket: TestSocket, conv: string, seq: number): Push | undefined =>
  socket.events.findLast((e) => e.type === "message" && e.message.conversationId === conv && e.message.seq === seq);

describe("while a reply's tool runs, and what the reply keeps of it", () => {
  it("in the Agent's own conversation: its owner is told the kind while the tool runs and none after, nothing of its words or results; the reply keeps what it looked up, and its owner reads the words and what they can see of what was found", async () => {
    const [owner, mia, ned, sam] = [await signUp(app, "olive"), await signUp(app, "mia"), await signUp(app, "ned"), await signUp(app, "sam")];
    const agent = await mustCreateAgent(app, owner, { model: FAST, persona: "简短地回答。" });
    const own = agent.conversationId as string;
    const home = await group(app, owner, "家", [mia, ned]);
    const homeSeq = await say(mia, home, "川菜馆叫蜀香");
    const away = await group(app, mia, "别处", [ned, sam]);
    const awaySeq = await say(ned, away, ELSEWHERE);
    const socket = await connect(app, owner);
    const askSeq = await say(owner, own, "上次说的川菜馆叫什么？");
    // What the search found: the owner's own question, a message of a group of theirs, one of a group they are not in,
    // and a seq that holds nothing.
    foundNow = [ref(own, askSeq), ref(home, homeSeq), ref(away, awaySeq), ref(own, 9999)];
    gateway.callTools([{ name: "search", input: { query: QUERY } }], { text: "我先查一下。" }).reply("叫蜀香。");
    expect(await toolWorker().runOnce()).toBe(true);
    const runId = await latestRun(agent.id, own);
    await socket.waitFor((e) => e.type === "run" && e.conversationId === own && e.run?.status === "done");

    const running = { id: runId, status: "running", retryable: false };
    expect(activityFrames(socket, own)).toEqual([
      { type: "run", conversationId: own, run: running, activity: "search" },
      { type: "run", conversationId: own, run: running, activity: null },
    ]);
    // In order with the reply: what it said before the tool (its acknowledgement, a message of its own), the kind while
    // the tool ran, none once the model wrote again, then the reply.
    const at = (pred: (e: Push) => boolean) => socket.events.findIndex(pred);
    const replySeq = askSeq + 2;
    const acknowledged = at((e) => e.type === "message" && e.message.seq === askSeq + 1 && e.message.conversationId === own);
    const searching = at((e) => e.type === "run" && e.activity === "search");
    const writing = at((e) => e.type === "run" && "activity" in e && e.activity === null);
    const reply = at((e) => e.type === "message" && e.message.seq === replySeq && e.message.conversationId === own);
    expect(searching).toBeGreaterThan(acknowledged);
    expect(acknowledged).toBeGreaterThan(0);
    expect(writing).toBeGreaterThan(searching);
    expect(reply).toBeGreaterThan(writing);
    // No frame but the owner's own copy of the reply names the words; none, the tool's results or anything elsewhere.
    for (const frame of socket.events) {
      const text = JSON.stringify(frame);
      expect([frame.type, text.includes(OUTPUT), text.includes(ELSEWHERE), text.includes(away)]).toEqual([frame.type, false, false, false]);
      if (frame.type !== "message") expect([frame.type, text.includes(QUERY)]).toEqual([frame.type, false]);
    }

    // Stored with the reply: the counts, what was found (in order) and the words.
    expect(await bodyOf(own, askSeq + 1)).toEqual({ text: "我先查一下。", ack: true });
    expect(await bodyOf(own, replySeq)).toEqual({ text: "叫蜀香。", lookups: { search: 1 }, found: foundNow, queries: [QUERY] });
    // The owner reads the counts, of what was found what they can see, and the words — pushed and read alike.
    const mine = { lookups: { search: 1 }, found: [ref(own, askSeq), ref(home, homeSeq)], queries: [QUERY] };
    expect(messageFrame(socket, own, replySeq)!.message).toMatchObject(mine);
    const read = (await api(app, owner, "GET", `/api/conversations/${own}/messages/${replySeq}`)).json.message;
    expect(read).toMatchObject({ text: "叫蜀香。", ...mine });
    expect((await api(app, owner, "GET", `/api/conversations/${own}/messages`)).json.messages.at(-1)).toMatchObject(mine);

    // The words, the counts and what was found are no text to search: nothing matches them.
    for (const q of [QUERY.slice(0, 12), "lookups", "found", "queries"]) {
      expect([q, (await api(app, owner, "GET", `/api/conversations/${own}/search?q=${encodeURIComponent(q)}`)).json.messages]).toEqual([q, []]);
      expect([q, (await api(app, owner, "GET", `/api/search?q=${encodeURIComponent(q)}`)).json.messages]).toEqual([q, []]);
    }

    // The next reply's model is shown the reply's text, and nothing of what it looked up.
    await say(owner, own, "谢谢");
    gateway.reply("不客气。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    const next = gateway.calls.at(-1)!;
    const shown = JSON.stringify(next.messages);
    expect(shown).toContain("叫蜀香。");
    for (const value of [QUERY, "lookups", "queries", '"found"', home, away]) expect([value, shown.includes(value)]).toEqual([value, false]);
  });

  it("in a group: the owner and every other member are told the kind while it runs and none after, never its words, results or anything found elsewhere; each reader is sent what they can see of what was found — a later joiner nothing from before they joined —, and nobody the words, the owner neither", async () => {
    const [mia, owner, ned, sam] = [await signUp(app, "mia"), await signUp(app, "owen"), await signUp(app, "ned"), await signUp(app, "sam")];
    const g = await group(app, mia, "读书会", [owner, ned]);
    const agent = await mustCreateAgent(app, owner, { handle: "helper_bot", name: "小助手", model: FAST, persona: "简短地回答。" });
    const own = agent.conversationId as string;
    expect((await api(app, owner, "POST", `/api/conversations/${g}/members`, { principalId: agent.id })).status).toBe(201);
    const early = await say(mia, g, "早期：蜀香在春熙路");
    await befriend(app, mia, sam);
    expect((await api(app, mia, "POST", `/api/conversations/${g}/members`, { principalId: sam.id })).status).toBe(201);
    const later = await say(ned, g, "后来：蜀香周一休息");
    const privateSeq = await postAs(own, owner.id, PRIVATE);
    foundNow = [ref(g, early), ref(g, later), ref(own, privateSeq), ref(g, 9999)];
    const sockets = { owner: await connect(app, owner), mia: await connect(app, mia), ned: await connect(app, ned), sam: await connect(app, sam) };
    const askSeq = await say(mia, g, "@helper_bot 蜀香在哪？");
    gateway.callTools([{ name: "search", input: { query: QUERY } }]).reply("蜀香在春熙路，周一休息。");
    expect(await toolWorker().runOnce()).toBe(true);
    const runId = await latestRun(agent.id, g);
    const replySeq = askSeq + 1;
    await sockets.owner.waitFor((e) => e.type === "run" && e.conversationId === g && e.run?.status === "done");
    for (const s of [sockets.mia, sockets.ned, sockets.sam]) {
      await s.waitFor((e) => e.type === "message" && e.message.seq === replySeq);
      await s.waitFor((e) => e.type === "run" && e.conversationId === g && e.state === null);
    }

    const running = { id: runId, status: "running", retryable: false };
    expect(activityFrames(sockets.owner, g)).toEqual([
      { type: "run", conversationId: g, agentId: agent.id, run: running, activity: "search" },
      { type: "run", conversationId: g, agentId: agent.id, run: running, activity: null },
    ]);
    for (const [who, s] of [["mia", sockets.mia], ["ned", sockets.ned], ["sam", sockets.sam]] as const) {
      expect([who, activityFrames(s, g)]).toEqual([
        who,
        [
          { type: "run", conversationId: g, agentId: agent.id, state: "replying", activity: "search" },
          { type: "run", conversationId: g, agentId: agent.id, state: "replying", activity: null },
        ],
      ]);
      for (const frame of s.events) {
        const text = JSON.stringify(frame);
        for (const value of [QUERY, OUTPUT, PRIVATE, own, runId]) expect([who, frame.type, value, text.includes(value)]).toEqual([who, frame.type, value, false]);
        const keys = keysOf(frame);
        expect([who, frame.type, ARGUMENT_KEYS.filter((k) => keys.has(k))]).toEqual([who, frame.type, []]);
        if (frame.type === "run") expect([who, Object.keys(frame).sort()]).toEqual([who, ["activity", "agentId", "conversationId", "state", "type"].filter((k) => k in frame)]);
      }
    }
    // The owner's frames carry the kind and the run, never the words or the results.
    for (const frame of sockets.owner.events) {
      const text = JSON.stringify(frame);
      expect([frame.type, text.includes(QUERY), text.includes(OUTPUT)]).toEqual([frame.type, false, false]);
    }

    // Stored with the reply in a group: no words at all, and of what was found only the group's own messages — a group
    // reply can find nothing elsewhere, and a reference elsewhere is not kept even if a tool hands one over.
    expect(await bodyOf(g, replySeq)).toEqual({ text: "蜀香在春熙路，周一休息。", lookups: { search: 1 }, found: [ref(g, early), ref(g, later), ref(g, 9999)] });
    const seen = {
      owner: [ref(g, early), ref(g, later)],
      mia: [ref(g, early), ref(g, later)],
      ned: [ref(g, early), ref(g, later)],
      // Joined after the early message: it is not theirs to see, and not theirs to be pointed at.
      sam: [ref(g, later)],
    };
    for (const [who, s] of Object.entries(sockets)) {
      const pushed = messageFrame(s, g, replySeq)!.message;
      expect([who, pushed.lookups, pushed.found, "queries" in pushed]).toEqual([who, { search: 1 }, seen[who as keyof typeof seen], false]);
    }

    // Every read of the reply, and of a quote of it, for each of them: the same, and nothing more.
    const quoteSeq = await say(ned, g, "收到", { replyToSeq: replySeq });
    const actors = { owner, mia, ned, sam };
    for (const [who, actor] of Object.entries(actors)) {
      const reads: Array<[string, unknown]> = [];
      const get = async (label: string, method: "GET" | "POST", url: string, body?: unknown) => {
        const res = await api(app, actor, method, url, body);
        expect([who, label, res.status]).toEqual([who, label, 200]);
        reads.push([label, res.json]);
        return res.json;
      };
      const replies: unknown[] = [];
      const pick = (messages: any[]) => messages.filter((m) => m.conversationId === g && m.seq === replySeq);
      replies.push(...pick((await get("history", "GET", `/api/conversations/${g}/messages`)).messages));
      replies.push((await get("one message", "GET", `/api/conversations/${g}/messages/${replySeq}`)).message);
      replies.push(...pick((await get("sync", "GET", "/api/sync")).messages ?? []));
      replies.push(...pick((await get("catch-up", "POST", "/api/sync/catchup", { positions: { [g]: 0 } })).messages));
      replies.push(...pick((await get("search", "GET", `/api/conversations/${g}/search?q=${encodeURIComponent("周一休息")}`)).messages));
      replies.push(...pick((await get("global search", "GET", `/api/search?q=${encodeURIComponent("周一休息")}`)).messages));
      const quote = (await get("a quote of it", "GET", `/api/conversations/${g}/messages/${quoteSeq}`)).message;
      expect([who, quote.replyTo]).toEqual([who, { seq: replySeq, visible: true, senderId: agent.id, text: "蜀香在春熙路，周一休息。", kind: "text" }]);
      expect([who, replies.length]).toEqual([who, 6]);
      for (const m of replies) expect([who, (m as any).found, (m as any).lookups, "queries" in (m as any)]).toEqual([who, seen[who as keyof typeof seen], { search: 1 }, false]);
      for (const [label, body] of reads) {
        const text = JSON.stringify(body);
        expect([who, label, text.includes(QUERY), text.includes(OUTPUT), keysOf(body).has("queries")]).toEqual([who, label, false, false, false]);
        if (who !== "owner") expect([who, label, text.includes(own), text.includes(PRIVATE)]).toEqual([who, label, false, false]);
      }
    }
  });

  it("a pause while the tool runs silences the reply: no word of what it is doing reaches the owner after it, as no delta does", async () => {
    const owner = await signUp(app, "pausing");
    const agent = await mustCreateAgent(app, owner, { model: FAST, persona: "简短地回答。" });
    const own = agent.conversationId as string;
    const socket = await connect(app, owner);
    await say(owner, own, "查一下");
    let reached!: () => void;
    const running = new Promise<void>((resolve) => (reached = resolve));
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const slow: Toolbox = { ...toolbox, run: async () => (reached(), await held, { output: { hits: [] }, query: QUERY }) };
    const { db: pool, blobs, conversations, reads, config } = app.deps;
    const port = createAgentPort({ db: pool, config, blobs, realtime: app.realtime, conversations, reads, log: app.log, toolbox: slow });
    const worker = createAgentWorker({ port, models: gateway, runTimeoutMs: config.agentRunTimeoutMs, maxRunsInFlight: 1, background: false, log: app.log, tools: config.tools });
    // The pause route reaches the app's own port; this one is told as the route tells the app's (`interruptRuns`).
    gateway.callTools([{ name: "search", input: { query: QUERY } }], { text: "我先查一下。" });
    const done = worker.runOnce();
    await running;
    await socket.waitFor((e) => e.type === "run" && e.conversationId === own && e.activity === "search");
    expect((await api(app, owner, "POST", `/api/agents/${agent.id}/pause`)).status).toBe(200);
    port.interruptRuns([await latestRun(agent.id, own)]);
    release();
    await done;
    await socket.waitFor((e) => e.type === "run" && e.conversationId === own && e.run?.status === "cancelled");
    expect(activityFrames(socket, own).map((e) => e.activity)).toEqual(["search"]);
  });

  it("a reply offered no tools, or whose tools ran none, stores exactly the body it stored before: no key about what it looked up", async () => {
    const owner = await signUp(app, "plain");
    const agent = await mustCreateAgent(app, owner, { model: FAST, persona: "简短地回答。" });
    const own = agent.conversationId as string;
    const first = await say(owner, own, "你好");
    gateway.reply("你好！");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(await bodyOf(own, first + 1)).toEqual({ text: "你好！" });
    // Offered the search, answered at once.
    const second = await say(owner, own, "在吗");
    gateway.reply("在的。");
    expect(await toolWorker().runOnce()).toBe(true);
    expect((gateway.calls.at(-1) as ModelCall).tools).toEqual([SEARCH]);
    expect(await bodyOf(own, second + 1)).toEqual({ text: "在的。" });
    const wire = (await api(app, owner, "GET", `/api/conversations/${own}/messages/${second + 1}`)).json.message;
    for (const key of ["lookups", "found", "queries"]) expect([key, key in wire]).toEqual([key, false]);
  });
});

describe("who reads the search words", () => {
  /** A place in code (not in a comment) that names the words a reply searched for: as a property, a key or a field. */
  const wordRefs = (source: string): string[] =>
    [...source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").matchAll(/\.queries\b|["']queries["']|\bqueries\s*\??:/g)].map((m) => m[0]);

  it("the check finds a property, a key and a field, and not the word in prose or a comment", () => {
    for (const code of ["body.queries", 'body["queries"]', "queries: [q]", "queries?: string[]", "{ 'queries': 1 }"]) expect([code, wordRefs(code).length]).toEqual([code, 1]);
    for (const prose of ["// its queries: ours", "/**\n * queries: then the resume\n */", "/* body.queries */", "the queries however many", "const queriesNow = 1"]) {
      expect([prose, wordRefs(prose)]).toEqual([prose, []]);
    }
  });

  it("only their shapes and checks (messages/lookups.ts), the post that keeps them, the wire that sends them to whom they are for and its schema name them", () => {
    const src = fileURLToPath(new URL("../src/", import.meta.url));
    const filesUnder = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(path.join(dir, e.name)) : /\.[cm]?[jt]s$/.test(e.name) ? [path.join(dir, e.name)] : []));
    const naming = filesUnder(src)
      .filter((f) => wordRefs(readFileSync(f, "utf8")).length > 0)
      .map((f) => path.relative(src, f).replaceAll("\\", "/"))
      .sort();
    expect(naming).toEqual(["agents/conversation.ts", "messages/lookups.ts", "messages/model.ts", "messages/read.ts"]);
  });
});
