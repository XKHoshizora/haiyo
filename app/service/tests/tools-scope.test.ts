import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentPort } from "../src/agents/port-impl.ts";
import { createAgentWorker, type AgentWorker } from "../src/agents/runtime/worker.ts";
import { createToolbox, READ_FILE, runTool, SEARCH_MESSAGES, type RunScope, type ToolDeps } from "../src/agents/tools/index.ts";
import { RunRefs } from "../src/agents/tools/refs.ts";
import { TOOL_MATERIAL } from "../src/agents/runtime/prompt.ts";
import type { Db } from "../src/db.ts";
import type { ModelCall } from "../src/models/gateway.ts";
import { api, befriend, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useProbeBlobs } from "./helpers/blobs.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { MULTIPART, multipart } from "./helpers/multipart.ts";

/**
 * Where an Agent's tools may look (design rules 1, 2; Review Focus 1), on the real port, toolbox and database: in a group
 * only that group, whatever the model passes; in its own conversation every conversation it is a current member of, as
 * the Agent sees each (VISIBLE_JOIN: nothing from before it joined, nothing of a group it has left); a group reply never
 * sees past its asker's line; a file is read only where it was found. Scope is a property of the query: the test spies on
 * the SQL the tools send.
 */

const gateway = scriptedGateway();
const { blobs } = useProbeBlobs("af-tools-scope-");
const { app, db } = useApp({ env: SITE_ENV, models: gateway, blobs, agentWorker: false });

afterEach(() => {
  expect(gateway.pending()).toBe(0);
});

const FAST = { source: "site", id: "fast" } as const;
const CANARY = "CANARY-scope 蓝鲸计划";

/** Every statement the tools sent, with its parameters. */
interface Sent {
  sql: string;
  params: unknown[];
}
/** `db` with every statement recorded, its transactions' too. */
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
  return {
    sent,
    db: { pool: real.pool, query: spied(real).query, tx: (fn) => real.tx((client) => fn(spied(client))), close: () => real.close() } as Db,
  };
}
/** The statements that searched messages (`messages/search.ts` `searchRows`). */
const searches = (sent: Sent[]) => sent.filter((s) => /ilike/i.test(s.sql));

function deps(over: Partial<ToolDeps> = {}): ToolDeps {
  const { db: pool, config, searches: slots } = app.deps;
  return { db: pool, blobs, searches: slots, config, log: app.log, ...over };
}

/** A worker on a port of the app's own with the real toolbox on `deps`. */
function toolWorker(d: ToolDeps = deps()): AgentWorker {
  const { db: pool, blobs: store, conversations, reads, config } = app.deps;
  const port = createAgentPort({ db: pool, config, blobs: store, realtime: app.realtime, conversations, reads, log: app.log, toolbox: createToolbox(d) });
  return createAgentWorker({ port, models: gateway, runTimeoutMs: config.agentRunTimeoutMs, maxRunsInFlight: 1, background: false, log: app.log, tools: config.tools });
}

let txn = 0;
const say = async (who: Actor, conv: string, text: string): Promise<number> => {
  const sent = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `ts${++txn}` });
  if (sent.status !== 201) throw new Error(`say: ${sent.status} ${JSON.stringify(sent.json)}`);
  return sent.json.message.seq as number;
};
async function sendFile(who: Actor, conv: string, filename: string, data: string): Promise<number> {
  const uploaded = await app.inject({
    method: "POST",
    url: `/api/conversations/${conv}/attachments`,
    headers: { cookie: who.cookie, "content-type": MULTIPART },
    payload: multipart([{ name: "file", filename, type: "application/octet-stream", data }]),
  });
  expect(uploaded.statusCode).toBe(201);
  const sent = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { attachmentId: uploaded.json().id, clientTxn: `ts${++txn}` });
  expect(sent.status).toBe(201);
  return sent.json.message.seq as number;
}
const addAgent = async (owner: Actor, conv: string, agentId: string) =>
  expect((await api(app, owner, "POST", `/api/conversations/${conv}/members`, { principalId: agentId })).status).toBe(201);
/** What the tool calls of the reply's first round gave back, as the next call carries them. */
const outputs = (call: ModelCall): unknown[] => (call.steps ?? []).flatMap((s) => s.results.map((r) => r.output));
const conversationSeq = async (conv: string) => Number((await db.query<{ seq: string }>("select seq::text from conversations where id = $1", [conv])).rows[0]!.seq);

/** Two groups A and B with the Agent and its owner, a canary only in B, and the Agent's own conversation. */
async function world() {
  const [owner, mia, ned] = [await signUp(app, "owen"), await signUp(app, "mia"), await signUp(app, "ned")];
  const agent = await mustCreateAgent(app, owner, { handle: "scope_bot", name: "小助手", model: FAST, persona: "简短地回答。" });
  const a = await group(app, owner, "甲群", [mia, ned]);
  const b = await group(app, owner, "乙群-秘密", [mia, ned]);
  await addAgent(owner, a, agent.id);
  await addAgent(owner, b, agent.id);
  await say(mia, a, "甲群里的寻常话");
  const canarySeq = await say(ned, b, `${CANARY}：下周三在老地方`);
  return { owner, mia, ned, agent, own: agent.conversationId as string, a, b, canarySeq };
}

describe("a search in a group cannot leave it", () => {
  it("every trick in the arguments — the canary, the other group's title and id, extra keys naming a conversation or 'all' — finds nothing outside, and every search statement names only this group", async () => {
    const w = await world();
    const spy = spyDb(app.deps.db);
    // Called by the Agent's owner: an others' reply runs one real call (plan B2a), and here all five are to be tried.
    await say(w.owner, w.a, "@scope_bot 帮我查查蓝鲸计划");
    gateway
      .callTools([
        { name: SEARCH_MESSAGES, input: { query: CANARY } },
        { name: SEARCH_MESSAGES, input: { query: "乙群-秘密" } },
        { name: SEARCH_MESSAGES, input: { query: w.b } },
        { name: SEARCH_MESSAGES, input: { query: "蓝鲸计划", conversationId: w.b } },
        { name: SEARCH_MESSAGES, input: { query: "蓝鲸计划", scope: "all" } },
      ])
      .reply("没查到。");
    expect(await toolWorker(deps({ db: spy.db })).runOnce()).toBe(true);
    const [first, second] = gateway.calls.slice(-2) as [ModelCall, ModelCall];
    expect(first.tools?.map((t) => t.name)).toContain(SEARCH_MESSAGES);
    const results = outputs(second);
    // The three the schema takes ran and found nothing in this group; the two with keys of their own were not run.
    const nothing = { results: [], note: "这个群的记录里没找到。只有在你和主人的专属会话里才能查所有地方。" };
    expect(results).toEqual([nothing, nothing, nothing, { error: "这个请求无法执行。" }, { error: "这个请求无法执行。" }]);
    const shown = JSON.stringify(second.steps);
    for (const secret of [`${CANARY}：`, "下周三在老地方"]) expect([secret, shown.includes(secret)]).toEqual([secret, false]);
    // Three searches, each over exactly this group (its conversation list) and read as the Agent.
    const sent = searches(spy.sent);
    expect(sent).toHaveLength(3);
    for (const s of sent) {
      expect(s.params[0]).toBe(w.agent.id);
      expect(s.params[1]).toEqual([w.a]);
    }
    // Nothing the tools sent named the other group as a conversation, anywhere.
    const conversationParams = spy.sent.flatMap((s) => s.params.filter((p) => Array.isArray(p) || (typeof p === "string" && /^[0-9a-f-]{36}$/.test(p))));
    expect(JSON.stringify(conversationParams).includes(w.b)).toBe(false);
  });

  it("called by a member, whose reply runs one real call: the first trick runs over this group alone, the rest are answered with the note", async () => {
    const w = await world();
    const spy = spyDb(app.deps.db);
    await say(w.mia, w.a, "@scope_bot 帮我查查蓝鲸计划");
    gateway
      .callTools([
        { name: SEARCH_MESSAGES, input: { query: CANARY } },
        { name: SEARCH_MESSAGES, input: { query: "乙群-秘密" } },
        { name: SEARCH_MESSAGES, input: { query: "蓝鲸计划", conversationId: w.b } },
      ])
      .reply("没查到。");
    expect(await toolWorker(deps({ db: spy.db })).runOnce()).toBe(true);
    const second = gateway.calls.at(-1)!;
    expect(outputs(second)).toEqual([{ results: [], note: "这个群的记录里没找到。" }, { note: "这类查询这次回复里不能再用了。" }, { error: "这个请求无法执行。" }]);
    const sent = searches(spy.sent);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.params[0]).toBe(w.agent.id);
    expect(sent[0]!.params[1]).toEqual([w.a]);
    expect(JSON.stringify(second.steps).includes(`${CANARY}：`)).toBe(false);
  });

  it("from the Agent's own conversation the canary is found, with where it was said (the group's title)", async () => {
    const w = await world();
    await say(w.owner, w.own, "上次说的那个计划在哪？");
    gateway.callTools([{ name: SEARCH_MESSAGES, input: { query: "蓝鲸计划" } }]).reply("在乙群里说的。");
    expect(await toolWorker().runOnce()).toBe(true);
    const [result] = outputs(gateway.calls.at(-1)!) as [{ results: Array<Record<string, unknown>>; more: boolean }];
    expect(result.more).toBe(false);
    expect(result.results).toEqual([{ ref: "〔m1〕", where: "乙群-秘密", who: "ned｜群成员", when: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} 周./), text: `${CANARY}：下周三在老地方` }]);
  });

  it("a group the Agent has left is never searched, nor a message from before the Agent joined", async () => {
    const w = await world();
    // Before it joined group C: the Agent never saw it.
    const c = await group(app, w.owner, "丙群", [w.mia, w.ned]);
    await say(w.mia, c, "加入之前：蓝鲸计划的预算");
    await addAgent(w.owner, c, w.agent.id);
    await say(w.mia, c, "加入之后：蓝鲸计划的地点");
    // Taken out of B.
    expect((await api(app, w.owner, "DELETE", `/api/conversations/${w.b}/members/${w.agent.id}`)).status).toBe(200);
    const spy = spyDb(app.deps.db);
    await say(w.owner, w.own, "查查那个计划");
    gateway.callTools([{ name: SEARCH_MESSAGES, input: { query: "蓝鲸计划" } }]).reply("只有丙群里的。");
    expect(await toolWorker(deps({ db: spy.db })).runOnce()).toBe(true);
    const [result] = outputs(gateway.calls.at(-1)!) as [{ results: Array<{ text: string; where?: string }> }];
    expect(result.results.map((r) => [r.where, r.text])).toEqual([["丙群", "加入之后：蓝鲸计划的地点"]]);
    const [sent] = searches(spy.sent);
    expect((sent!.params[1] as string[]).sort()).toEqual([w.own, w.a, c].sort());
  });

  it("after a new topic the history is still searchable: search is history, not context", async () => {
    const w = await world();
    await say(w.owner, w.own, "记住：蓝鲸计划的口令是七七");
    gateway.reply("记住了。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect((await api(app, w.owner, "POST", `/api/conversations/${w.own}/topic`)).status).toBe(201);
    await say(w.owner, w.own, "口令是什么来着？");
    gateway.callTools([{ name: SEARCH_MESSAGES, input: { query: "口令" } }]).reply("七七。");
    expect(await toolWorker().runOnce()).toBe(true);
    const [result] = outputs(gateway.calls.at(-1)!) as [{ results: Array<{ text: string; where?: string; who: string }> }];
    expect(result.results.map((r) => r.text)).toContain("记住：蓝鲸计划的口令是七七");
    // In its own conversation a hit there names no place.
    expect(result.results.every((r) => r.where === undefined)).toBe(true);
  });
});

describe("a group reply never sees past its asker's line", () => {
  it("a newcomer's question: nothing from before they joined is found, not even a count; an older member's question finds it", async () => {
    const w = await world();
    const early = await say(w.mia, w.a, "早期：蓝鲸计划的地点在三楼");
    const sam = await signUp(app, "sam");
    await befriend(app, w.owner, sam);
    expect((await api(app, w.owner, "POST", `/api/conversations/${w.a}/members`, { principalId: sam.id })).status).toBe(201);
    await say(sam, w.a, "@scope_bot 蓝鲸计划在哪？");
    gateway.callTools([{ name: SEARCH_MESSAGES, input: { query: "蓝鲸计划" } }]).reply("没查到。");
    expect(await toolWorker().runOnce()).toBe(true);
    const fromNewcomer = outputs(gateway.calls.at(-1)!)[0];
    // Nothing: what is before their joining is not theirs to find, and their own question is what the reply answers (item E).
    expect(fromNewcomer).toEqual({ results: [], note: "这个群的记录里没找到。" });
    expect(JSON.stringify(gateway.calls.at(-1)!.steps)).not.toContain("三楼");

    await say(w.mia, w.a, "@scope_bot 蓝鲸计划在哪？我问的");
    gateway.callTools([{ name: SEARCH_MESSAGES, input: { query: "蓝鲸计划的地点" } }]).reply("在三楼。");
    expect(await toolWorker().runOnce()).toBe(true);
    const fromMia = outputs(gateway.calls.at(-1)!)[0] as { results: Array<{ text: string; ref: string }> };
    expect(fromMia.results.map((r) => r.text)).toEqual(["早期：蓝鲸计划的地点在三楼"]);
    expect(early).toBeGreaterThan(0);
  });

  it("a call at or before the line is never found — the reply answers it (item E) — not by its text, nor by its file's name", async () => {
    const w = await world();
    const uploaded = await app.inject({
      method: "POST",
      url: `/api/conversations/${w.a}/attachments`,
      headers: { cookie: w.mia.cookie, "content-type": MULTIPART },
      payload: multipart([{ name: "file", filename: "预算表-m3.txt", type: "application/octet-stream", data: "三万" }]),
    });
    expect((await api(app, w.mia, "POST", `/api/conversations/${w.a}/messages`, { attachmentId: uploaded.json().id, text: "@scope_bot 看看这个", clientTxn: `ts${++txn}` })).status).toBe(201);
    // Sam, who joins after Mia's call, is among whom the reply answers: the line is Sam's joining.
    const sam = await signUp(app, "sam");
    await befriend(app, w.owner, sam);
    expect((await api(app, w.owner, "POST", `/api/conversations/${w.a}/members`, { principalId: sam.id })).status).toBe(201);
    const run = (await db.query<{ id: string }>("select id from agent_runs where agent_id = $1 and conversation_id = $2 and status = 'queued'", [w.agent.id, w.a])).rows[0]!.id;
    await db.query("update agent_runs set asker_ids = array[$2::uuid, $3::uuid] where id = $1", [run, w.mia.id, sam.id]);
    const scope: RunScope = { id: run, agentId: w.agent.id, ownerId: w.owner.id, conversationId: w.a, group: true, refs: new RunRefs(), heardTo: await conversationSeq(w.a), mark: null };
    const signal = new AbortController().signal;
    const byName = await runTool(deps(), scope, { id: "c1", name: SEARCH_MESSAGES, input: { query: "预算表-m3" } }, signal);
    expect(byName.output).toEqual({ results: [], note: "这个群的记录里没找到。" });
    const byText = await runTool(deps(), scope, { id: "c2", name: SEARCH_MESSAGES, input: { query: "看看这个" } }, signal);
    expect(byText.output).toEqual({ results: [], note: "这个群的记录里没找到。" });
  });

  it("N-6: numbering stops at 999999, the largest number a token holds: past it no result is handed out, and the search says more were left out", async () => {
    const w = await world();
    for (const i of [1, 2, 3]) await say(w.ned, w.a, `天花板-n6 第${i}条`);
    await say(w.mia, w.a, "@scope_bot 找找");
    const run = (await db.query<{ id: string }>("select id from agent_runs where agent_id = $1 and conversation_id = $2 and status = 'queued'", [w.agent.id, w.a])).rows[0]!.id;
    const scope: RunScope = { id: run, agentId: w.agent.id, ownerId: w.owner.id, conversationId: w.a, group: true, refs: new RunRefs({ m: 999_998 }), heardTo: await conversationSeq(w.a), mark: null };
    const out = (await runTool(deps(), scope, { id: "c1", name: SEARCH_MESSAGES, input: { query: "天花板-n6" } }, new AbortController().signal)).output as { more: boolean; results: Array<{ ref: string }> };
    expect([out.results.map((r) => r.ref), out.more]).toEqual([["〔m999999〕"], true]);
  });

  it("nothing written after the reply began is found (heardTo), however well it matches", async () => {
    const w = await world();
    await say(w.ned, w.a, "之前说过：蓝鲸计划在三楼");
    await say(w.mia, w.a, "@scope_bot 蓝鲸计划在哪？");
    const run = (await db.query<{ id: string }>("select id from agent_runs where agent_id = $1 and conversation_id = $2 and status = 'queued'", [w.agent.id, w.a])).rows[0]!.id;
    const heardTo = await conversationSeq(w.a);
    await say(w.ned, w.a, "后来才说：蓝鲸计划在五楼");
    const scope: RunScope = { id: run, agentId: w.agent.id, ownerId: w.owner.id, conversationId: w.a, group: true, refs: new RunRefs(), heardTo, mark: null };
    const out = await runTool(deps(), scope, { id: "c1", name: SEARCH_MESSAGES, input: { query: "蓝鲸计划" } }, new AbortController().signal);
    // The earlier message only: not the later one (past heardTo), nor the question the reply answers (item E).
    expect((out.output as { results: Array<{ text: string }> }).results.map((r) => r.text)).toEqual(["之前说过：蓝鲸计划在三楼"]);
  });

  it("an Agent taken out of a group and added back finds there only what came after it came back, from its own conversation or in the group", async () => {
    const w = await world();
    await say(w.mia, w.a, "第一次在时：蓝鲸计划甲");
    expect((await api(app, w.owner, "DELETE", `/api/conversations/${w.a}/members/${w.agent.id}`)).status).toBe(200);
    await say(w.mia, w.a, "不在时：蓝鲸计划乙");
    await addAgent(w.owner, w.a, w.agent.id);
    await say(w.mia, w.a, "回来后：蓝鲸计划丙");
    await say(w.owner, w.own, "查查那个计划");
    gateway.callTools([{ name: SEARCH_MESSAGES, input: { query: "蓝鲸计划" } }]).reply("好。");
    expect(await toolWorker().runOnce()).toBe(true);
    const [fromOwn] = outputs(gateway.calls.at(-1)!) as [{ results: Array<{ text: string; where?: string }> }];
    expect(fromOwn.results.filter((r) => r.where === "甲群").map((r) => r.text)).toEqual(["回来后：蓝鲸计划丙"]);
    await say(w.mia, w.a, "@scope_bot 蓝鲸计划呢？");
    gateway.callTools([{ name: SEARCH_MESSAGES, input: { query: "蓝鲸计划" } }]).reply("好。");
    expect(await toolWorker().runOnce()).toBe(true);
    const [inGroup] = outputs(gateway.calls.at(-1)!) as [{ results: Array<{ text: string }> }];
    expect(inGroup.results.map((r) => r.text)).toEqual(["回来后：蓝鲸计划丙"]);
  });
});

describe("a file is read only where it may be", () => {
  /** A scope for a run of the Agent in `conversationId` (no run row: no asker's line), sharing `refs`. */
  const scopeOf = async (w: Awaited<ReturnType<typeof world>>, conversationId: string, group: boolean, refs: RunRefs): Promise<RunScope> => ({
    id: randomUUID(),
    agentId: w.agent.id,
    ownerId: w.owner.id,
    conversationId,
    group,
    refs,
    heardTo: await conversationSeq(conversationId),
    mark: null,
  });

  it("a ref minted in the own conversation for B's file reads it there, and fails inside A", async () => {
    const w = await world();
    await sendFile(w.ned, w.b, "蓝鲸计划.txt", "第一行：蓝鲸计划\n第二行：预算三万");
    const refs = new RunRefs();
    const own = await scopeOf(w, w.own, false, refs);
    const signal = new AbortController().signal;
    const found = await runTool(deps(), own, { id: "c1", name: SEARCH_MESSAGES, input: { query: "蓝鲸计划.txt" } }, signal);
    const hit = (found.output as { results: Array<{ file?: { ref: string; name: string } }> }).results.find((r) => r.file);
    expect(hit?.file).toEqual({ ref: "〔f1〕", name: "蓝鲸计划.txt" });
    const there = await runTool(deps(), own, { id: "c2", name: READ_FILE, input: { file: "f1" } }, signal);
    expect(there.output).toEqual({ about: TOOL_MATERIAL, name: "蓝鲸计划.txt", from: 0, next: null, text: "第一行：蓝鲸计划\n第二行：预算三万" });

    const inA = await scopeOf(w, w.a, true, refs);
    const refused = await runTool(deps(), inA, { id: "c3", name: READ_FILE, input: { file: "f1" } }, signal);
    expect(refused.output).toEqual({ error: "这个文件现在看不到了。" });
    expect(JSON.stringify(refused.output)).not.toContain("预算");
  });
});
