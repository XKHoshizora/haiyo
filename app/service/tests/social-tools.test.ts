import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentPort } from "../src/agents/port-impl.ts";
import { createAgentWorker, type AgentWorker } from "../src/agents/runtime/worker.ts";
import { createToolbox, READ_FILE, runTool, SEARCH_MESSAGES, toolSpecs, type RunScope, type ToolDeps } from "../src/agents/tools/index.ts";
import { RunRefs } from "../src/agents/tools/refs.ts";
import { TOOL_MATERIAL } from "../src/agents/runtime/prompt.ts";
import type { Db } from "../src/db.ts";
import type { ModelCall } from "../src/models/gateway.ts";
import { api, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useProbeBlobs } from "./helpers/blobs.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { MULTIPART, multipart } from "./helpers/multipart.ts";
import { SOCIAL_ON, seedSocial } from "./helpers/social.ts";

/**
 * Lane B, B7b: tools in a social conversation are scoped to THAT conversation only, enforced by the query (a call can only name this
 * conversation; a second social conversation and a group each hold a canary), and the Agent's own conversation's search and
 * `read_file` never see a social conversation (a stranger's words must not enter the context that holds the owner's vault notes and
 * full tools: lane A's review of agents/tools/search.ts:226). Canary tests both ways.
 */
const gateway = scriptedGateway();
const { blobs } = useProbeBlobs("af-social-tools-");
const { app, db } = useApp({ env: SITE_ENV, models: gateway, blobs, agentWorker: false, config: SOCIAL_ON });
afterEach(() => {
  expect(gateway.pending()).toBe(0);
});

const FAST = { source: "site", id: "fast" } as const;
// A canary is searched for by its key; what follows the key in the stored text (its tail) is what must never come back.
const OWN_CANARY = "OWN-CANARY 保险库口令 TAIL-OWN";
const GROUP_CANARY = "GROUP-CANARY 群里的暗号 TAIL-GROUP";
const OTHER_SOCIAL_CANARY = "OTHER-SOCIAL-CANARY 另一位访客的话 TAIL-OTHER";
const VISITOR_CANARY = "VISITOR-CANARY 访客说的事 TAIL-VISITOR";
const TAILS = ["TAIL-OWN", "TAIL-GROUP", "TAIL-OTHER", "TAIL-VISITOR"];
const leaked = (call: ModelCall): string[] => TAILS.filter((t) => JSON.stringify(call.steps).includes(t));

function deps(over: Partial<ToolDeps> = {}): ToolDeps {
  const { db: pool, config, searches: slots } = app.deps;
  return { db: pool, blobs, searches: slots, config, log: app.log, ...over };
}
function toolWorker(d: ToolDeps = deps()): AgentWorker {
  const { db: pool, blobs: store, conversations, reads, config } = app.deps;
  const port = createAgentPort({ db: pool, config, blobs: store, realtime: app.realtime, conversations, reads, log: app.log, toolbox: createToolbox(d) });
  return createAgentWorker({ port, models: gateway, runTimeoutMs: config.agentRunTimeoutMs, maxRunsInFlight: 1, background: false, log: app.log, tools: config.tools });
}

/** Every statement the tools sent, with its parameters (as tests/tools-scope.test.ts records them). */
interface Sent {
  sql: string;
  params: unknown[];
}
function spyDb(real: Db): { db: Db; sent: Sent[] } {
  const sent: Sent[] = [];
  const record = (sql: unknown, params: unknown) => sent.push({ sql: typeof sql === "string" ? sql : String((sql as { text?: string }).text), params: Array.isArray(params) ? params : [] });
  const spied = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(t, prop) {
        const value = Reflect.get(t, prop, t);
        if (prop === "query") return (sql: unknown, params?: unknown) => (record(sql, params), (value as Function).call(t, sql, params));
        return typeof value === "function" ? value.bind(t) : value;
      },
    });
  return { sent, db: { pool: real.pool, query: spied(real).query, tx: (fn) => real.tx((client) => fn(spied(client))), close: () => real.close() } as Db };
}
/** The statements that searched messages (`messages/search.ts` `searchRows`). */
const searches = (sent: Sent[]) => sent.filter((q) => /ilike/i.test(q.sql));

let txn = 0;
const say = async (who: Actor, conv: string, text: string): Promise<number> => {
  const sent = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `sto${++txn}` });
  if (sent.status !== 201) throw new Error(`say: ${sent.status} ${JSON.stringify(sent.json)}`);
  return sent.json.message.seq as number;
};
async function sendFile(who: Actor, conv: string, filename: string, data: string): Promise<{ id: string; seq: number }> {
  const uploaded = await app.inject({
    method: "POST",
    url: `/api/conversations/${conv}/attachments`,
    headers: { cookie: who.cookie, "content-type": MULTIPART },
    payload: multipart([{ name: "file", filename, type: "application/octet-stream", data }]),
  });
  expect(uploaded.statusCode).toBe(201);
  const sent = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { attachmentId: uploaded.json().id, clientTxn: `sto${++txn}` });
  expect(sent.status).toBe(201);
  return { id: uploaded.json().id as string, seq: sent.json.message.seq as number };
}
const outputs = (call: ModelCall): unknown[] => (call.steps ?? []).flatMap((s) => s.results.map((r) => r.output));
const seqOf = async (conv: string) => Number((await db.query<{ seq: string }>("select seq::text from conversations where id = $1", [conv])).rows[0]!.seq);

/**
 * The owner O with an Agent X, its own conversation (OWN canary), a group with X (GROUP canary), and two social conversations of X:
 * S1 with the visitor V (V's words, a file) and S2 with W (OTHER canary).
 */
async function world() {
  const [owner, v, w, mia, ned] = [await signUp(app, "sto_owner"), await signUp(app, "sto_v"), await signUp(app, "sto_w"), await signUp(app, "sto_mia"), await signUp(app, "sto_ned")];
  const agent = (await mustCreateAgent(app, owner, { handle: "sto_bot", name: "小助手", model: FAST, persona: "简短地回答。" })) as { id: string; conversationId: string };
  const g = await group(app, owner, "楼里的群", [mia, ned]);
  expect((await api(app, owner, "POST", `/api/conversations/${g}/members`, { principalId: agent.id })).status).toBe(201);
  await say(mia, g, GROUP_CANARY);
  await say(owner, agent.conversationId, OWN_CANARY);
  const s1 = (await seedSocial(app, { owner, agentId: agent.id, visitor: v })).conversationId;
  const s2 = (await seedSocial(app, { owner, agentId: agent.id, visitor: w })).conversationId;
  await say(w, s2, OTHER_SOCIAL_CANARY);
  await say(v, s1, VISITOR_CANARY);
  // What the setup's messages queued is not what a test runs: each test sends the message whose reply it runs.
  await db.query("delete from agent_runs where agent_id = $1", [agent.id]);
  return { owner, v, w, agent, own: agent.conversationId, g, s1, s2 };
}

describe("a tool call in a social run names only that conversation", () => {
  it.each([
    ["the owner's own conversation", "OWN-CANARY"],
    ["a group of the Agent's", "GROUP-CANARY"],
    ["a second social conversation of the Agent's", "OTHER-SOCIAL-CANARY"],
  ])("searching for what is in %s finds nothing; the search's statement names only this conversation", async (_where, canary) => {
    const x = await world();
    await say(x.v, x.s1, "帮我查一下");
    gateway.callTools([{ name: SEARCH_MESSAGES, input: { query: canary } }]).reply("没查到。");
    const spy = spyDb(app.deps.db);
    expect(await toolWorker(deps({ db: spy.db })).runOnce()).toBe(true);
    const second = gateway.calls.at(-1)!;
    expect(outputs(second)).toEqual([{ results: [], note: "这段对话的记录里没找到。" }]);
    expect(leaked(second)).toEqual([]);
    const sent = searches(spy.sent);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.params[0]).toBe(x.agent.id);
    expect(sent[0]!.params[1]).toEqual([x.s1]);
    const named = JSON.stringify(spy.sent.flatMap((q) => q.params.filter((p) => Array.isArray(p) || (typeof p === "string" && /^[0-9a-f-]{36}$/.test(p)))));
    for (const other of [x.s2, x.g, x.own]) expect(named).not.toContain(other);
  });

  it("what was said in this conversation is found, with no `where`; the elsewhere hook is never called", async () => {
    const x = await world();
    await say(x.v, x.s1, "再问你一件事");
    gateway.callTools([{ name: SEARCH_MESSAGES, input: { query: "VISITOR-CANARY" } }]).reply("你说过。");
    const calls: unknown[] = [];
    expect(await toolWorker(deps({ elsewhere: (scope, ask) => void calls.push([scope, ask]) })).runOnce()).toBe(true);
    const [result] = outputs(gateway.calls.at(-1)!) as [{ results: Array<Record<string, unknown>> }];
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ text: VISITOR_CANARY, who: expect.stringContaining("｜对方") });
    expect(result.results[0]).not.toHaveProperty("where");
    // And a search that finds nothing never starts the elsewhere hook either.
    await say(x.v, x.s1, "还有一件");
    gateway.callTools([{ name: SEARCH_MESSAGES, input: { query: "不存在的词语" } }]).reply("没有。");
    await toolWorker(deps({ elsewhere: (scope, ask) => void calls.push([scope, ask]) })).runOnce();
    expect(calls).toEqual([]);
  });

  it("the tools of a social reply: the three, this conversation's wording (no 群), with no sentence to say first", async () => {
    const x = await world();
    await say(x.v, x.s1, "你好");
    gateway.reply("好。");
    expect(await toolWorker().runOnce()).toBe(true);
    const call = gateway.calls.at(-1)!;
    expect(call.tools?.map((t) => t.name)).toEqual(["search_messages", "current_time", "read_file"]);
    expect(call.tools).toEqual(toolSpecs({ place: "social" }));
    expect(JSON.stringify(call.tools)).not.toContain("群");
    expect(call.system).toContain("这段对话");
    expect(call.system).not.toContain("先用一句很短的话说一声");
  });

  it("read_file in a social run reads this conversation's files and no other's", async () => {
    const x = await world();
    const mine = await sendFile(x.v, x.s1, "访客的.txt", "访客文件内容");
    const theirs = await sendFile(x.w, x.s2, "别人的.txt", "别人文件内容");
    const groupFile = await sendFile(x.owner, x.g, "群里的.txt", "群文件内容");
    const run = randomUUID();
    const refs = new RunRefs();
    const scope: RunScope = { id: run, agentId: x.agent.id, ownerId: x.owner.id, conversationId: x.s1, place: "social", refs, heardTo: await seqOf(x.s1), mark: null };
    const ask = (ref: string | null) => runTool(deps(), scope, { id: "c", name: READ_FILE, input: { file: ref } }, new AbortController().signal);
    expect((await ask(refs.file(mine.id, { conversationId: x.s1, seq: mine.seq })))?.output).toEqual({ about: TOOL_MATERIAL, name: "访客的.txt", from: 0, next: null, text: "访客文件内容" });
    expect((await ask(refs.file(theirs.id, { conversationId: x.s2, seq: theirs.seq })))?.output).toEqual({ error: "这个文件现在看不到了。" });
    expect((await ask(refs.file(groupFile.id, { conversationId: x.g, seq: groupFile.seq })))?.output).toEqual({ error: "这个文件现在看不到了。" });
  });
});

describe("the own conversation's tools never see a social conversation (the query excludes it)", () => {
  it("search from the Agent's own conversation: a visitor's canary is never found, the group's and the own conversation's are", async () => {
    const x = await world();
    await say(x.owner, x.own, "查查看");
    const spy = spyDb(app.deps.db);
    gateway.callTools([{ name: SEARCH_MESSAGES, input: { query: "VISITOR-CANARY" } }]).reply("没找到。");
    expect(await toolWorker(deps({ db: spy.db })).runOnce()).toBe(true);
    const found = outputs(gateway.calls.at(-1)!)[0] as { results: unknown[] };
    expect(found.results).toEqual([]);
    expect(leaked(gateway.calls.at(-1)!)).toEqual([]);
    // The statement was given the Agent's own conversation and its groups, never a social conversation.
    const sent = searches(spy.sent);
    expect(sent).toHaveLength(1);
    const asked = (sent[0]!.params[1] as string[]).sort();
    expect(asked).toEqual([x.own, x.g].sort());
    // The other canaries: the group's is found, from where it was said.
    await say(x.owner, x.own, "再查查");
    gateway.callTools([{ name: SEARCH_MESSAGES, input: { query: "GROUP-CANARY" } }]).reply("在群里。");
    expect(await toolWorker().runOnce()).toBe(true);
    const [group] = outputs(gateway.calls.at(-1)!) as [{ results: Array<{ where?: string }> }];
    expect(group.results.map((r) => r.where)).toEqual(["楼里的群"]);
    await say(x.owner, x.own, "还有");
    gateway.callTools([{ name: SEARCH_MESSAGES, input: { query: "OTHER-SOCIAL-CANARY" } }]).reply("没有。");
    expect(await toolWorker().runOnce()).toBe(true);
    expect(outputs(gateway.calls.at(-1)!)[0]).toEqual({ results: [], note: "没找到。" });
  });

  it("read_file from the own conversation never reads a social conversation's file, whatever number it is handed", async () => {
    const x = await world();
    const visitorFile = await sendFile(x.v, x.s1, "访客的.txt", "访客文件内容");
    const ownFile = await sendFile(x.owner, x.own, "主人的.txt", "主人文件内容");
    const groupFile = await sendFile(x.owner, x.g, "群里的.txt", "群文件内容");
    const refs = new RunRefs();
    const scope: RunScope = { id: randomUUID(), agentId: x.agent.id, ownerId: x.owner.id, conversationId: x.own, place: "own", refs, heardTo: await seqOf(x.own), mark: null };
    const ask = (ref: string | null) => runTool(deps(), scope, { id: "c", name: READ_FILE, input: { file: ref } }, new AbortController().signal);
    expect((await ask(refs.file(visitorFile.id, { conversationId: x.s1, seq: visitorFile.seq })))?.output).toEqual({ error: "这个文件现在看不到了。" });
    expect((await ask(refs.file(ownFile.id, { conversationId: x.own, seq: ownFile.seq })))?.output).toMatchObject({ name: "主人的.txt", text: "主人文件内容" });
    expect((await ask(refs.file(groupFile.id, { conversationId: x.g, seq: groupFile.seq })))?.output).toMatchObject({ name: "群里的.txt", text: "群文件内容" });
  });
});

describe("a social run is offered tools only under the others' bounds", () => {
  it("one real call; a second call in the same turn is answered with the note, and the hold covers it (the social reply is bounded as an others' reply)", async () => {
    const x = await world();
    await say(x.v, x.s1, "帮我查");
    gateway.callTools([
      { name: SEARCH_MESSAGES, input: { query: "VISITOR-CANARY" } },
      { name: SEARCH_MESSAGES, input: { query: "OWN-CANARY" } },
    ]).reply("好的。");
    expect(await toolWorker().runOnce()).toBe(true);
    const results = outputs(gateway.calls.at(-1)!) as Array<Record<string, unknown>>;
    expect(results).toHaveLength(2);
    expect(results[0]).toHaveProperty("results");
    expect(results[1]).toHaveProperty("note");
    expect(leaked(gateway.calls.at(-1)!).filter((t) => t !== "TAIL-VISITOR")).toEqual([]);
  });
});
