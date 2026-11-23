import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createToolbox, SEARCH_MESSAGES, type ToolDeps } from "../src/agents/tools/index.ts";
import { createElsewhere } from "../src/agents/tools/elsewhere.ts";
import { createAgentPort } from "../src/agents/port-impl.ts";
import { createAgentWorker } from "../src/agents/runtime/worker.ts";
import { runCatchUp } from "../src/memory/catchup.ts";
import { runFlags } from "../src/memory/hearsay.ts";
import { runReview, type PipelineDeps } from "../src/memory/pipeline.ts";
import { writeFlags } from "../src/agents/proactive/listeners.ts";
import { createWhisper } from "../src/whispers/store.ts";
import { api, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedJudge } from "./helpers/judge.ts";
import { JUDGE, MIN, PERSONA } from "./helpers/memory-flags.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { SOCIAL_ON, seedSocial } from "./helpers/social.ts";
import { closeAllSockets } from "./helpers/ws.ts";

// Plan A9 (design §8 test 5, the memory parts): memory and "elsewhere" never see a social conversation. Nothing the visitor says
// there reaches the owner's notes, hearsay, summaries or whispers or another conversation's search; nothing the owner says there
// (as 主人) is taken for what they said to their own Agent; no job of memory is made for one (the switch, the catch-up, the
// review, the flags, the summary, the nap), however it is asked for.
const gateway = scriptedGateway();
const judge = scriptedJudge();
// A-4 review m10: a window of a few lines is worth a summary call (`summaryMinFoldWeight` 1), so that a summary leg can fail.
const { app, db, clock } = useApp({ env: { ...SITE_ENV, MEMORY: JSON.stringify({ summaryMinFoldWeight: 1, summaryMinIntervalMs: 0 }) }, models: gateway, judge, agentWorker: false, tools: true, memory: true, config: { judge: JUDGE, ...SOCIAL_ON } });
const memory = () => app.deps.memory!;
const FAST = { source: "site", id: "fast" } as const;
const VISITOR_CANARY = "SOCIAL_CANARY 蓝鲸计划的口令是七七";
const OWNER_CANARY = "OWNER_SOCIAL_CANARY 我下周三要搬家了";
const GROUP_CANARY = "GROUP_CANARY 蓝鲸计划在三楼";

beforeEach(() => {
  clock.reset();
  judge.calls.splice(0);
  judge.answer(() => ({ sort: 0.95, explicit_forget: 0.05 }));
});
afterEach(async () => {
  await closeAllSockets();
  await memory().idle();
});

let txn = 0;
const say = async (who: Actor, conv: string, text: string): Promise<number> => {
  const sent = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `smp${++txn}` });
  if (sent.status !== 201) throw new Error(`say: ${sent.status} ${JSON.stringify(sent.json)}`);
  return sent.json.message.seq as number;
};
const ops = (...o: unknown[]) => JSON.stringify({ ops: o });
const add = (text: string) => ({ op: "add", kind: "owner", text });

/**
 * The owner and their Agent (memory on), a visitor let in, the social conversation `s` where the visitor and the owner (as 主人) have
 * both spoken, and a group `g` (with `b`, a second group holding a canary) where the owner and the Agent are.
 */
async function world(tag: string) {
  const owner = await signUp(app, `smo${tag}`);
  const visitor = await signUp(app, `smv${tag}`);
  const mia = await signUp(app, `smm${tag}`);
  const ned = await signUp(app, `smn${tag}`);
  const agent = (await mustCreateAgent(app, owner, { handle: `sm_${tag}`, name: `sm_${tag}`, model: FAST, persona: PERSONA, memory: true })) as { id: string; conversationId: string };
  const g = await group(app, owner, "饭搭子", [mia, ned]);
  const b = await group(app, owner, "乙群", [mia, ned]);
  for (const c of [g, b]) expect((await api(app, owner, "POST", `/api/conversations/${c}/members`, { principalId: agent.id })).status).toBe(201);
  const social = await seedSocial(app, { owner, agentId: agent.id, visitor });
  const s = social.conversationId;
  await say(visitor, s, VISITOR_CANARY);
  await say(owner, s, OWNER_CANARY);
  await say(mia, b, GROUP_CANARY);
  await db.query("update agent_runs set status = 'cancelled', finished_at = now() where agent_id = $1 and status in ('queued', 'running')", [agent.id]);
  return { owner, visitor, mia, agent, g, b, s };
}
type World = Awaited<ReturnType<typeof world>>;

const rowsIn = async (table: string, agentId: string, conv: string): Promise<unknown[]> =>
  (await db.query(`select * from ${table} where agent_id = $1 and conversation_id = $2`, [agentId, conv])).rows;
const pipelineDeps = (): PipelineDeps => ({ db, config: app.deps.config, models: gateway, judge, log: app.log, inFlight: new Set<string>(), conversations: app.deps.conversations, now: clock.now });
const ctx = () => ({ closing: new AbortController().signal, attempted: () => {}, again: () => {}, hearsayCalls: [] as number[] });
const calls = () => gateway.calls.length + judge.calls.length;
/** Every row of every table memory writes, as text, for a canary: none of them may hold one. */
const canaryRows = async (canary: string): Promise<number> => {
  let n = 0;
  for (const t of ["owner_notes", "agent_notes", "agent_hearsay", "memory_changes", "conversation_summaries", "conversation_summary_attempts", "whispers", "memory_flags", "memory_catchups", "hearsay_mutes"]) {
    n += Number((await db.query<{ n: string }>(`select count(*)::text as n from ${t} x where x::text like $1`, [`%${canary}%`])).rows[0]!.n);
  }
  return n;
};

describe("a social conversation is no place of memory", () => {
  it("switching memory off and on, with the catch-up, gives it no state, no review position, no catch-up and no flag; the group gets its own (control)", async () => {
    const w = await world("sw");
    const patch = (body: Record<string, unknown>) => api(app, w.owner, "PATCH", `/api/agents/${w.agent.id}`, body);
    expect((await patch({ memory: false })).status).toBe(200);
    await memory().idle();
    expect((await patch({ memory: true, catchUp: true })).status).toBe(200);
    await memory().idle();
    for (const t of ["memory_review_state", "agent_group_state", "memory_catchups", "memory_flags"]) expect([t, await rowsIn(t, w.agent.id, w.s)]).toEqual([t, []]);
    // The control: the groups, and the Agent's own conversation, are what they were.
    expect((await rowsIn("agent_group_state", w.agent.id, w.g)).length).toBe(1);
    expect((await rowsIn("memory_review_state", w.agent.id, w.agent.conversationId)).length).toBe(1);
  });

  it("no job is made for it, however it is asked for: a reply noted, a new topic, a flag, a summary, a stored catch-up, flags left over, a restart; the owner's words there never reach a note", async () => {
    const w = await world("jb");
    const before = calls();
    // A review as the pipeline runs it, a flags job, a catch-up, directly.
    await runReview(pipelineDeps(), { kind: "review", agentId: w.agent.id, conversationId: w.s }, ctx());
    await db.query("insert into memory_flags (agent_id, conversation_id, seq, kind) values ($1, $2, 2, 'own'), ($1, $2, 3, 'hearsay')", [w.agent.id, w.s]);
    await runFlags(pipelineDeps(), { kind: "flags", agentId: w.agent.id, conversationId: w.s }, ctx() as never);
    await db.query("insert into memory_catchups (agent_id, conversation_id, from_seq, to_seq, next_seq) values ($1, $2, 0, 3, 1)", [w.agent.id, w.s]);
    await runCatchUp(pipelineDeps(), { kind: "catchup", agentId: w.agent.id, conversationId: w.s }, ctx() as never);
    expect(calls()).toBe(before);
    expect(await rowsIn("memory_flags", w.agent.id, w.s)).toEqual([]);
    expect(await rowsIn("memory_catchups", w.agent.id, w.s)).toEqual([]);
    expect(await rowsIn("memory_review_state", w.agent.id, w.s)).toEqual([]);
    // Through the reviewer, with the quiet time passing: the triggers a reply, a topic, a flag and a summary make.
    await db.query("insert into memory_flags (agent_id, conversation_id, seq, kind) values ($1, $2, 2, 'own')", [w.agent.id, w.s]);
    await db.query("insert into memory_catchups (agent_id, conversation_id, from_seq, to_seq, next_seq) values ($1, $2, 0, 3, 1)", [w.agent.id, w.s]);
    memory().noted(w.agent.id, w.s);
    memory().topicReset(w.agent.id, w.s);
    memory().flagged(w.agent.id, w.s, "own");
    memory().summarise(w.agent.id, w.s, 3);
    clock.advance(10 * MIN);
    await memory().idle();
    expect(await memory().resume()).toBeGreaterThanOrEqual(0);
    clock.advance(10 * MIN);
    await memory().idle();
    expect(calls()).toBe(before);
    expect(await rowsIn("memory_review_state", w.agent.id, w.s)).toEqual([]);
    expect((await db.query("select 1 from conversation_summaries where conversation_id = $1", [w.s])).rowCount).toBe(0);
    // Nothing of what was said there is anywhere in memory.
    for (const canary of [VISITOR_CANARY, OWNER_CANARY]) expect([canary, await canaryRows(canary)]).toEqual([canary, 0]);
    expect((await api(app, w.owner, "GET", "/api/memory/notes")).json.notes).toEqual([]);
    // The control: a group's review still runs from the owner's words there.
    await say(w.owner, w.g, "我喜欢吃辣");
    gateway.reply(ops(add("喜欢吃辣")));
    await runReview(pipelineDeps(), { kind: "review", agentId: w.agent.id, conversationId: w.g }, ctx());
    expect(calls()).toBeGreaterThan(before);
    expect(((await api(app, w.owner, "GET", "/api/memory/notes")).json.notes as Array<{ text: string }>).map((n) => n.text)).toEqual(["喜欢吃辣"]);
  });

  it("the rolling summary is never made for a social conversation, though its window is worth a call (A-4 review m10); the same job in a group makes one; the flag table holds no social row whoever writes it", async () => {
    const w = await world("sm");
    expect(app.deps.config.memory.summaryMinFoldWeight).toBe(1);
    let top = 0;
    let gtop = 0;
    for (let i = 0; i < 6; i++) {
      top = await say(w.visitor, w.s, `一起去爬山吧第${i}次`);
      gtop = await say(w.owner, w.g, `周末一起去爬山吧第${i}次`);
    }
    const before = calls();
    memory().summarise(w.agent.id, w.s, top);
    clock.advance(10 * MIN);
    await memory().idle();
    expect(calls()).toBe(before);
    for (const t of ["conversation_summaries", "conversation_summary_attempts"]) expect([t, (await db.query(`select 1 from ${t} where conversation_id = $1`, [w.s])).rowCount]).toEqual([t, 0]);
    // The control: the same job for the group makes a call and writes a summary.
    gateway.reply(JSON.stringify({ 人物与称呼: [], 说过的事: [{ said_by: null, text: "大家想去爬山" }], 定下的事: [], 还没解决的: [] }));
    memory().summarise(w.agent.id, w.g, gtop);
    clock.advance(10 * MIN);
    await memory().idle();
    expect(calls()).toBe(before + 1);
    expect((await db.query("select 1 from conversation_summaries where conversation_id = $1", [w.g])).rowCount).toBe(1);
    // Defence in depth (m10c): the flag writer itself refuses a social conversation; a group's flag is written.
    expect(await writeFlags(db, [{ agentId: w.agent.id, conversationId: w.s, seq: 2, kind: "own" }])).toEqual([]);
    expect(await rowsIn("memory_flags", w.agent.id, w.s)).toEqual([]);
    await db.query("update agents set memory = true where principal_id = $1", [w.agent.id]);
    expect(await writeFlags(db, [{ agentId: w.agent.id, conversationId: w.g, seq: 2, kind: "own" }])).toHaveLength(1);
  });

  it("the owner's memory never carries a visitor's words into another conversation, and a social conversation is never a place a lookup finds anything in; a group still is (control)", async () => {
    const w = await world("el");
    const hook = createElsewhere({ db: app.deps.db, config: app.deps.config, realtime: app.realtime, log: app.log });
    const { config, searches, blobs, conversations, reads } = app.deps;
    const deps: ToolDeps = { db: app.deps.db, blobs, searches, config, log: app.log, elsewhere: hook };
    const port = createAgentPort({ db: app.deps.db, config, blobs, realtime: app.realtime, conversations, reads, log: app.log, toolbox: createToolbox(deps) });
    const worker = createAgentWorker({ port, models: gateway, runTimeoutMs: config.agentRunTimeoutMs, maxRunsInFlight: 1, background: false, log: app.log, tools: config.tools });
    const ask = async (term: string): Promise<void> => {
      await say(w.mia, w.g, `@sm_el 上次说的那个计划在哪？${term}`);
      gateway.callTools([{ name: SEARCH_MESSAGES, input: { query: term } }]).reply("这个群的记录里没找到。");
      expect(await worker.runOnce()).toBe(true);
      await hook.idle();
    };
    await ask("蓝鲸计划的口令");
    expect((await db.query("select 1 from whispers where owner_id = $1 and conversation_id = $2", [w.owner.id, w.g])).rowCount).toBe(0);
    expect(await canaryRows("SOCIAL_CANARY")).toBe(0);
    await ask("蓝鲸计划在三楼");
    expect((await db.query("select 1 from whispers where owner_id = $1 and conversation_id = $2", [w.owner.id, w.g])).rowCount).toBe(1);
    // And a lookup from the social conversation itself looks nowhere.
    const before = (await db.query("select count(*)::int as n from whispers")).rows[0].n;
    await hook({ id: "00000000-0000-4000-8000-000000000000", conversationId: w.s, agentId: w.agent.id, ownerId: w.owner.id } as never, { term: "蓝鲸计划在三楼", from: null, before: null, after: null } as never);
    expect((await db.query("select count(*)::int as n from whispers")).rows[0].n).toBe(before);
  });

  it("a whisper is never made in a social conversation, though its owner and Agent are both members", async () => {
    const w = await world("wh");
    const made = await db.tx((t) =>
      createWhisper(t, { conversationId: w.s, ownerId: w.owner.id, agentId: w.agent.id, kind: "found_elsewhere", body: { text: "找到了", actions: ["tell", "dismiss"], detail: { hits: [] } } }, app.log),
    );
    expect(made).toBeNull();
    expect((await db.query("select 1 from whispers where conversation_id = $1", [w.s])).rowCount).toBe(0);
    const control = await db.tx((t) =>
      createWhisper(t, { conversationId: w.g, ownerId: w.owner.id, agentId: w.agent.id, kind: "found_elsewhere", body: { text: "找到了", actions: ["tell", "dismiss"], detail: { hits: [] } } }, app.log),
    );
    expect(control).not.toBeNull();
  });
});
