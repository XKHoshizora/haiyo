import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decideProactive } from "../src/agents/proactive/decide.ts";
import { runCatchUp } from "../src/memory/catchup.ts";
import type { PipelineDeps } from "../src/memory/pipeline.ts";
import type { Judge, Question } from "../src/judge/client.ts";
import { settled } from "../src/memory/stats.ts";
import { insertMessage } from "../src/messages/model.ts";
import { api, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedJudge, type ScriptedAnswers } from "./helpers/judge.ts";
import { FAST, flagHelpers, JUDGE, PERSONA } from "./helpers/memory-flags.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { closeAllSockets } from "./helpers/ws.ts";

/**
 * 也回顾一下 in a group (memory/catchup.ts; README "An Agent's memory"): switching memory on with catchUp catches up, once per group,
 * what members said there while it was off — the group's own judgement asked this Agent's questions alone, over those lines.
 */

const gateway = scriptedGateway();
const scripted = scriptedJudge();
/** Run before the judgement answers a request (the state it was shown): a test's way into the middle of a catch-up. */
let beforeAnswer: ((state: string) => Promise<void>) | null = null;
const judge: Judge = {
  async ask(state, questions, signal) {
    if (beforeAnswer) await beforeAnswer(state);
    return scripted.ask(state, questions, signal);
  },
};
const { app, db, clock } = useApp({ env: SITE_ENV, models: gateway, judge, agentWorker: false, memory: true, config: { judge: JUDGE } });
const { memory, say, world, flagRows } = flagHelpers({ app, db, clock, gateway });
const quiet = { info: () => {}, debug: () => {} };

/** Every listener question answered 0.9 (no Agent is proactive here): each line asked about is flagged. */
const everything = (_state: string, questions: readonly Question[]): ScriptedAnswers => Object.fromEntries(questions.map((q) => [q.key, 0.9]));
/** The settings a test may change, as they were before it. */
let defaults = { lines: 0, days: 0, window: 0 };

beforeEach(() => {
  defaults = { lines: app.deps.config.memory.catchUpLines, days: app.deps.config.memory.catchUpDays, window: app.deps.config.proactive.transcriptMessages };
  clock.reset();
  scripted.calls.splice(0);
  scripted.answer(everything);
  beforeAnswer = null;
});
afterEach(async () => {
  beforeAnswer = null;
  app.deps.config.memory.catchUpLines = defaults.lines;
  app.deps.config.memory.catchUpDays = defaults.days;
  app.deps.config.proactive.transcriptMessages = defaults.window;
  await closeAllSockets();
  await memory().idle();
});

type World = Awaited<ReturnType<typeof world>>;
const patch = (w: World, body: Record<string, unknown>) => api(app, w.owner, "PATCH", `/api/agents/${w.agent.id}`, body);
const switched = async (w: World, body: Record<string, unknown>) => {
  expect([body, (await patch(w, body)).status]).toEqual([body, 200]);
  await memory().idle();
};
/** The group's judgement of message `seq`, as the scheduler asks it. */
const decide = async (w: World, seq: number) => {
  const decided = await decideProactive({ db, judge, config: app.deps.config, log: quiet }, w.g, seq);
  for (const f of decided.flags ?? []) memory().flagged(f.agentId, f.conversationId, f.kind);
};
/** Another owner's Agent in the group, memory on: it listens there too. */
async function another(w: World, tag: string) {
  const bot = await mustCreateAgent(app, w.third, { handle: `cu_b${tag}`, name: `cu_b${tag}`, model: FAST, persona: PERSONA, proactive: false, memory: true });
  expect((await api(app, w.third, "POST", `/api/conversations/${w.g}/members`, { principalId: bot.id })).status).toBe(201);
  return bot as { id: string };
}
/** An Agent's state row in the group, every column, as text. */
const stateOf = async (agentId: string, g: string) =>
  (await db.query<{ row: string }>("select row_to_json(s)::text as row from agent_group_state s where agent_id = $1 and conversation_id = $2", [agentId, g])).rows[0]?.row;
const catchUps = async (agentId: string) =>
  (await db.query<{ from_seq: number; to_seq: number; next_seq: number }>("select from_seq::int, to_seq::int, next_seq::int from memory_catchups where agent_id = $1 order by conversation_id", [agentId])).rows;
const counted = async (name: string): Promise<number> => {
  await settled();
  return (await db.query<{ n: number }>("select coalesce(sum(n), 0)::int as n from memory_stats where name = $1", [name])).rows[0]!.n;
};
/** Where the Agent hears from in the group (`agent_group_state.heard_from_seq`). */
const heardOf = async (agentId: string, g: string) =>
  (await db.query<{ h: number }>("select heard_from_seq::int as h from agent_group_state where agent_id = $1 and conversation_id = $2", [agentId, g])).rows[0]?.h;
/** Switching memory on with catchUp while no judgement is configured: the catch-up is stored and waits (for `resume`, or a test). */
const storedOnly = async (w: World) => {
  const judgeConfig = app.deps.config.judge;
  app.deps.config.judge = null;
  try {
    await switched(w, { memory: true, catchUp: true });
  } finally {
    app.deps.config.judge = judgeConfig;
  }
};
/** The listener questions a catch-up asked (its requests carry no pick). */
const catchUpCalls = () => scripted.calls.filter((c) => !c.questions.some((q) => q.key === "pick"));
const spend = (ownerId: string) =>
  db.query("insert into memory_usage (owner_id, day, used_micro) values ($1, (now() at time zone 'Asia/Shanghai')::date, 900000000000) on conflict (owner_id, day) do update set used_micro = excluded.used_micro", [ownerId]);

describe("也回顾一下 in a group: what members said while memory was off", () => {
  it("off, members speak (judged meanwhile for another owner's Agent), on with catchUp: this Agent hears from those lines; the other Agent's state and the group's judged position are as they were, to the byte", async () => {
    const w = await world("cu1");
    const bob = await another(w, "1");
    await decide(w, await say(w.mia, w.g, "大家早"));
    await switched(w, { memory: false });
    const off: number[] = [];
    for (const text of ["小李下周去北京出差", "小李在学吉他", "小李搬家了"]) {
      off.push(await say(w.mia, w.g, text));
      await decide(w, off.at(-1)!);
    }
    const bobBefore = await stateOf(bob.id, w.g);
    const judgedBefore = (await db.query("select max(judged_seq)::int as j from agent_group_state where conversation_id = $1", [w.g])).rows[0].j;
    expect(await flagRows(w.agent.id, "hearsay")).toEqual([]);
    scripted.calls.splice(0);
    await switched(w, { memory: true, catchUp: true });
    expect(await flagRows(w.agent.id, "hearsay")).toEqual(off);
    expect(await stateOf(bob.id, w.g)).toBe(bobBefore);
    expect((await db.query("select max(judged_seq)::int as j from agent_group_state where conversation_id = $1", [w.g])).rows[0].j).toBe(judgedBefore);
    // One request: this owner's question alone, over the off period only.
    expect(scripted.calls).toHaveLength(1);
    expect(scripted.calls[0]!.questions.map((q) => q.key)).toEqual(["h1"]);
    expect(scripted.calls[0]!.state).toBe(`群聊记录：\n【新】miacu1：小李下周去北京出差\n【新】miacu1：小李在学吉他\n【新】miacu1：小李搬家了`);
    expect([await counted("catchup_group_jobs"), await counted("catchup_lines_judged"), await counted("catchup_flags")]).toEqual([1, 3, 3]);
    // Done: running it again (a restart) judges and flags nothing twice.
    expect(await catchUps(w.agent.id)).toEqual([{ from_seq: off[0]! - 1, to_seq: off[2]!, next_seq: off[2]! + 1 }]);
    await memory().resume();
    await memory().idle();
    expect(scripted.calls).toHaveLength(1);
  });

  it("on without catchUp: nothing is queued, nothing heard", async () => {
    const w = await world("cu2");
    await another(w, "2");
    await switched(w, { memory: false });
    await decide(w, await say(w.mia, w.g, "小李下周去北京出差"));
    scripted.calls.splice(0);
    await switched(w, { memory: true });
    expect(await catchUps(w.agent.id)).toEqual([]);
    expect(catchUpCalls()).toEqual([]);
    expect(await flagRows(w.agent.id, "hearsay")).toEqual([]);
  });

  it("bounds: the most recent MEMORY.catchUpLines lines of the off period, none older than MEMORY.catchUpDays days; older lines are not caught up, nor shown as context, and the Agent's heard position moves up to the bounded start (what a hearsay call may read)", async () => {
    app.deps.config.memory.catchUpLines = 3;
    const w = await world("cu3");
    await switched(w, { memory: false });
    const off: number[] = [];
    for (let i = 0; i < 5; i++) off.push(await say(w.mia, w.g, `小李的第${i}件事`));
    await switched(w, { memory: true, catchUp: true });
    expect(await flagRows(w.agent.id, "hearsay")).toEqual(off.slice(2));
    const shown = scripted.calls.map((c) => c.state).join("\n");
    expect([shown.includes("小李的第0件事"), shown.includes("小李的第1件事"), shown.includes("小李的第2件事")]).toEqual([false, false, true]);
    expect((await db.query("select heard_from_seq::int as h from agent_group_state where agent_id = $1 and conversation_id = $2", [w.agent.id, w.g])).rows).toEqual([{ h: off[1] }]);

    app.deps.config.memory.catchUpLines = 200;
    const v = await world("cu3b");
    await switched(v, { memory: false });
    const old: number[] = [];
    for (let i = 0; i < 3; i++) old.push(await say(v.mia, v.g, `小李的第${i}件旧事`));
    // The first two were said 31 days ago (MEMORY.catchUpDays: 30).
    await db.query("update messages set created_at = now() - interval '31 days' where conversation_id = $1 and seq = any($2::bigint[])", [v.g, old.slice(0, 2)]);
    scripted.calls.splice(0);
    await switched(v, { memory: true, catchUp: true });
    expect(await flagRows(v.agent.id, "hearsay")).toEqual(old.slice(2));
    expect(scripted.calls.map((c) => c.state).join("\n")).not.toContain("小李的第1件旧事");
  });

  it("lines go in seq order whatever their digits: a range crossing 9→10 and 99→100 is judged window by window, oldest first, every line once, none skipped", async () => {
    app.deps.config.proactive.transcriptMessages = 7;
    const w = await world("cu10");
    await switched(w, { memory: false });
    const off: number[] = [];
    while (off.length === 0 || off.at(-1)! <= 105) off.push(await say(w.mia, w.g, `小李的第${off.length}件事`));
    expect([off[0]! <= 9, off.includes(10), off.includes(99), off.includes(100)]).toEqual([true, true, true, true]);
    await switched(w, { memory: true, catchUp: true });
    expect(await flagRows(w.agent.id, "hearsay")).toEqual(off);
    // What the judgement was shown as new, window by window: each line once, in order.
    const shownNew = catchUpCalls().flatMap((c) => [...c.state.matchAll(/【新】[^\n]*小李的第(\d+)件事/g)].map((m) => Number(m[1])));
    expect(shownNew).toEqual(off.map((_, i) => i));
  });

  it("an acknowledgement is no line of a catch-up: it uses up none of MEMORY.catchUpLines, nor of a window (final review m-5)", async () => {
    app.deps.config.memory.catchUpLines = 3;
    app.deps.config.proactive.transcriptMessages = 2;
    const w = await world("cu3c");
    await switched(w, { memory: false });
    const off: number[] = [];
    for (let i = 0; i < 3; i++) {
      off.push(await say(w.mia, w.g, `小李的第${i}件事`));
      // An Agent's acknowledgement after each: nothing to remember, and no line to count.
      await db.tx((t) => insertMessage(t, w.g, w.agent.id, "text", { text: `我查一下${i}`, ack: true } as never, `ack:${crypto.randomUUID()}`));
    }
    await switched(w, { memory: true, catchUp: true });
    expect(await flagRows(w.agent.id, "hearsay")).toEqual(off);
    // Two windows of two lines (the people's), not three of two with acknowledgements among them.
    expect(catchUpCalls()).toHaveLength(2);
  });

  it("no line from before the switch-off, nor from before the Agent joined, is ever shown to the judgement", async () => {
    const w = await world("cu4");
    await say(w.mia, w.g, "关机前的话");
    await switched(w, { memory: false });
    // A second group, which the Agent joins while its memory is off.
    const g2 = await group(app, w.mia, "爬山群", [w.owner, w.third]);
    await say(w.mia, g2, "加入之前的话");
    expect((await api(app, w.owner, "POST", `/api/conversations/${g2}/members`, { principalId: w.agent.id })).status).toBe(201);
    const after2 = await say(w.mia, g2, "加入之后的话");
    const off = await say(w.mia, w.g, "关机期间的话");
    await switched(w, { memory: true, catchUp: true });
    const shown = scripted.calls.map((c) => c.state).join("\n");
    expect(shown).toContain("关机期间的话");
    expect(shown).toContain("加入之后的话");
    expect(shown).not.toContain("关机前的话");
    expect(shown).not.toContain("加入之前的话");
    expect(await flagRows(w.agent.id, "hearsay")).toEqual([after2, off].sort((a, b) => a - b));
  });

  it("the owner's memory allowance used up mid-way: it stops there, quietly; the rest of the off period is not caught up", async () => {
    app.deps.config.proactive.transcriptMessages = 2;
    const w = await world("cu5");
    await switched(w, { memory: false });
    const off: number[] = [];
    for (let i = 0; i < 6; i++) off.push(await say(w.mia, w.g, `小李的第${i}件事`));
    // Spent while the second window is asked.
    beforeAnswer = async (state) => {
      if (state.includes("小李的第2件事")) await spend(w.owner.id);
    };
    await switched(w, { memory: true, catchUp: true });
    expect(await flagRows(w.agent.id, "hearsay")).toEqual(off.slice(0, 4));
    expect(scripted.calls).toHaveLength(2);
    expect(await catchUps(w.agent.id)).toEqual([{ from_seq: off[0]! - 1, to_seq: off[5]!, next_seq: off[5]! + 1 }]);
  });

  it("memory switched off again mid-way: what the catch-up is told after it is dropped, and it asks nothing more", async () => {
    app.deps.config.proactive.transcriptMessages = 2;
    const w = await world("cu6");
    await switched(w, { memory: false });
    for (let i = 0; i < 6; i++) await say(w.mia, w.g, `小李的第${i}件事`);
    beforeAnswer = async (state) => {
      if (state.includes("小李的第2件事")) expect((await patch(w, { memory: false })).status).toBe(200);
    };
    expect((await patch(w, { memory: true, catchUp: true })).status).toBe(200);
    await memory().idle();
    expect(scripted.calls).toHaveLength(2);
    expect(await flagRows(w.agent.id, "hearsay")).toEqual([]);
    expect(await catchUps(w.agent.id)).toEqual([]);
  });

  it("a catch-up queued by a switch whose process could not run it is run after a restart (resume)", async () => {
    const w = await world("cu7");
    await switched(w, { memory: false });
    const off = await say(w.mia, w.g, "小李下周去北京出差");
    // No judgement to ask when it is queued: it waits, stored.
    const judgeConfig = app.deps.config.judge;
    app.deps.config.judge = null;
    try {
      await switched(w, { memory: true, catchUp: true });
    } finally {
      app.deps.config.judge = judgeConfig;
    }
    expect(await flagRows(w.agent.id, "hearsay")).toEqual([]);
    expect(await catchUps(w.agent.id)).toEqual([{ from_seq: off - 1, to_seq: off, next_seq: off }]);
    await memory().resume();
    await memory().idle();
    expect(await flagRows(w.agent.id, "hearsay")).toEqual([off]);
  });

  it("a normal judgement while a catch-up waits flags nothing at or below the catch-up's end for this Agent: each line is flagged once, by one of them", async () => {
    const w = await world("cu8");
    // Judged once while listening: what came after is new to the next judgement.
    await decide(w, await say(w.mia, w.g, "大家早"));
    await switched(w, { memory: false });
    // Nobody listens while it is off: these are never judged, so a judgement after the switch finds them new.
    const off = [await say(w.mia, w.g, "小李下周去北京出差"), await say(w.mia, w.g, "小李在学吉他")];
    const judgeConfig = app.deps.config.judge;
    app.deps.config.judge = null;
    try {
      await switched(w, { memory: true, catchUp: true });
    } finally {
      app.deps.config.judge = judgeConfig;
    }
    const later = await say(w.mia, w.g, "小李明天生日");
    await decide(w, later);
    // The judgement finds the off period new (nobody judged it), and asks this Agent's question about the line after it alone.
    expect(scripted.calls.at(-1)!.state).toContain("【新】miacu8：小李下周去北京出差");
    expect(await flagRows(w.agent.id, "hearsay")).toEqual([later]);
    await memory().resume();
    await memory().idle();
    expect(await flagRows(w.agent.id, "hearsay")).toEqual([...off, later]);
  });

  it("the judgement's day used up (its limit, or listening's share of it): it stops before asking anything; nothing is counted as a catch-up that got going", async () => {
    const w = await world("cu9");
    await switched(w, { memory: false });
    await say(w.mia, w.g, "小李下周去北京出差");
    const day = (await db.query<{ d: string }>("select to_char(now() at time zone 'Asia/Shanghai', 'YYYY-MM-DD') as d")).rows[0]!.d;
    await db.query("insert into judge_usage (day, calls) values ($1::date, $2) on conflict (day) do update set calls = $2", [day, JUDGE.dailyLimit]);
    try {
      await switched(w, { memory: true, catchUp: true });
    } finally {
      await db.query("delete from judge_usage where day = $1::date", [day]);
    }
    expect(scripted.calls).toEqual([]);
    expect(await flagRows(w.agent.id, "hearsay")).toEqual([]);
    const [row] = await catchUps(w.agent.id);
    expect(row!.next_seq).toBe(row!.to_seq + 1);
    expect(await counted("catchup_group_jobs")).toBe(0);
  });

  it("the Agent taken out of the group, or deleted, between two windows: what the second window raised is not written (it no longer listens there), and it stops", async () => {
    app.deps.config.proactive.transcriptMessages = 2;
    for (const [name, gone] of [
      ["cua", "update memberships set left_seq = (select seq from conversations where id = $2) where principal_id = $1 and conversation_id = $2"],
      ["cuz", "update agents set deleted_at = now() where principal_id = $1 and $2::uuid is not null"],
    ] as const) {
      scripted.calls.splice(0);
      const w = await world(name);
      await switched(w, { memory: false });
      const off: number[] = [];
      for (let i = 0; i < 6; i++) off.push(await say(w.mia, w.g, `小李的第${i}件事`));
      beforeAnswer = async (state) => {
        if (state.includes("小李的第2件事")) await db.query(gone, [w.agent.id, w.g]);
      };
      await switched(w, { memory: true, catchUp: true });
      beforeAnswer = null;
      expect([name, await flagRows(w.agent.id, "hearsay")]).toEqual([name, off.slice(0, 2)]);
      expect([name, scripted.calls.length]).toEqual([name, 2]);
      expect([name, await catchUps(w.agent.id)]).toEqual([name, [{ from_seq: off[0]! - 1, to_seq: off[5]!, next_seq: off[5]! + 1 }]]);
    }
  });

  it("paused: a catch-up ends — whether the Agent is paused when its job starts or between two windows — since a paused Agent hears nothing in its groups", async () => {
    // Paused before the job runs (it is stored while no judgement is configured, then resumed).
    const w = await world("cub");
    await switched(w, { memory: false });
    await say(w.mia, w.g, "小李下周去北京出差");
    const judgeConfig = app.deps.config.judge;
    app.deps.config.judge = null;
    try {
      await switched(w, { memory: true, catchUp: true });
    } finally {
      app.deps.config.judge = judgeConfig;
    }
    await db.query("update agents set paused = true where principal_id = $1", [w.agent.id]);
    await memory().resume();
    await memory().idle();
    expect(scripted.calls).toEqual([]);
    expect(await flagRows(w.agent.id, "hearsay")).toEqual([]);
    const [stopped] = await catchUps(w.agent.id);
    expect(stopped!.next_seq).toBe(stopped!.to_seq + 1);

    // Paused between two windows.
    app.deps.config.proactive.transcriptMessages = 2;
    const v = await world("cuc");
    await switched(v, { memory: false });
    const off: number[] = [];
    for (let i = 0; i < 6; i++) off.push(await say(v.mia, v.g, `小李的第${i}件事`));
    beforeAnswer = async (state) => {
      if (state.includes("小李的第2件事")) await db.query("update agents set paused = true where principal_id = $1", [v.agent.id]);
    };
    await switched(v, { memory: true, catchUp: true });
    expect(scripted.calls).toHaveLength(2);
    const [row] = await catchUps(v.agent.id);
    expect(row!.next_seq).toBe(row!.to_seq + 1);
  });

  it("an Agent taken out and added again after the switch: no line from before its latest joining is shown — the catch-up finds no listener for its range and stops", async () => {
    const w = await world("cud");
    await switched(w, { memory: false });
    await say(w.mia, w.g, "小李下周去北京出差");
    const judgeConfig = app.deps.config.judge;
    app.deps.config.judge = null;
    try {
      await switched(w, { memory: true, catchUp: true });
    } finally {
      app.deps.config.judge = judgeConfig;
    }
    // Joined again after the switch: its joining is past the end of the range.
    const later = await say(w.mia, w.g, "大家好");
    await db.query("update memberships set joined_seq = $3 where principal_id = $1 and conversation_id = $2", [w.agent.id, w.g, later]);
    await memory().resume();
    await memory().idle();
    expect(scripted.calls).toEqual([]);
    const [row] = await catchUps(w.agent.id);
    expect(row!.next_seq).toBe(row!.to_seq + 1);
  });

  it("an owner with two Agents in the group: while one's catch-up waits, the group's judgement still asks the owner's question for the other, and writes this one no flag at or below the catch-up's end; the catch-up then flags them for it", async () => {
    const w = await world("cue");
    const other = await mustCreateAgent(app, w.owner, { handle: "cu_e2", name: "cu_e2", model: FAST, persona: PERSONA, proactive: false, memory: true });
    expect((await api(app, w.owner, "POST", `/api/conversations/${w.g}/members`, { principalId: other.id })).status).toBe(201);
    const morning = await say(w.mia, w.g, "大家早");
    await decide(w, morning);
    await switched(w, { memory: false });
    // Not judged when said (a skipped judgement): new to the next one.
    const off = [await say(w.mia, w.g, "小李下周去北京出差"), await say(w.mia, w.g, "小李在学吉他")];
    const judgeConfig = app.deps.config.judge;
    app.deps.config.judge = null;
    try {
      await switched(w, { memory: true, catchUp: true });
    } finally {
      app.deps.config.judge = judgeConfig;
    }
    const later = await say(w.mia, w.g, "小李明天生日");
    scripted.calls.splice(0);
    await decide(w, later);
    expect(scripted.calls[0]!.questions.map((q) => q.key)).toEqual(["h1"]);
    // The other Agent never switched: it keeps what it heard before (大家早) and hears the off period now.
    expect(await flagRows(other.id, "hearsay")).toEqual([morning, ...off, later]);
    expect(await flagRows(w.agent.id, "hearsay")).toEqual([later]);
    await memory().resume();
    await memory().idle();
    expect(await flagRows(w.agent.id, "hearsay")).toEqual([...off, later]);
  });

  it("the owner's own remark in the off period: the catch-up raises an own flag for the owner's reviewing Agent, whose wake-up runs the group review over it", async () => {
    const w = await world("cuf");
    await switched(w, { memory: false });
    const own = await say(w.owner, w.g, "我下个月要搬去杭州了");
    await switched(w, { memory: true, catchUp: true });
    expect(await flagRows(w.agent.id, "own")).toEqual([own]);
    expect(await flagRows(w.agent.id, "hearsay")).toEqual([]);
    gateway.reply(JSON.stringify({ ops: [{ op: "add", kind: "owner", text: "下个月搬去杭州" }] }));
    clock.advance(2 * 60_000);
    await memory().idle();
    expect((await api(app, w.owner, "GET", "/api/memory/notes")).json.notes.map((n: { text: string }) => n.text)).toEqual(["下个月搬去杭州"]);
    expect(await flagRows(w.agent.id, "own")).toEqual([]);
  });

  it("an Agent no longer in the group when its catch-up starts: nothing is written for it there, not even its heard position — the membership is checked first", async () => {
    app.deps.config.memory.catchUpLines = 1;
    const w = await world("cuh");
    await switched(w, { memory: false });
    for (let i = 0; i < 3; i++) await say(w.mia, w.g, `小李的第${i}件事`);
    await storedOnly(w);
    await db.query("update memberships set left_seq = (select seq from conversations where id = $2) where principal_id = $1 and conversation_id = $2", [w.agent.id, w.g]);
    const before = await stateOf(w.agent.id, w.g);
    await memory().resume();
    await memory().idle();
    expect(scripted.calls).toEqual([]);
    expect(await stateOf(w.agent.id, w.g)).toBe(before);
    const [row] = await catchUps(w.agent.id);
    expect(row!.next_seq).toBe(row!.to_seq + 1);
  });

  it("a catch-up resumed after its first window keeps what that window decided — its bounded start, stored as the row's from — though the 30-day floor, measured again, has passed lines it already judged: counted once, the heard position not moved above the flags it wrote, the rest judged", async () => {
    app.deps.config.proactive.transcriptMessages = 2;
    app.deps.config.memory.catchUpLines = 4;
    const w = await world("cug");
    await switched(w, { memory: false });
    const off: number[] = [];
    for (let i = 0; i < 6; i++) off.push(await say(w.mia, w.g, `小李的第${i}件事`));
    await storedOnly(w);
    // Its first window, during which the service begins to stop: the step is recorded, and the job goes no further.
    const stopping = new AbortController();
    beforeAnswer = async () => stopping.abort();
    const deps = {
      db,
      config: app.deps.config,
      models: gateway,
      judge,
      log: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
      inFlight: new Set<string>(),
      conversations: { publish: () => {} },
      now: clock.now,
    } as unknown as PipelineDeps;
    await runCatchUp(deps, { kind: "catchup", agentId: w.agent.id, conversationId: w.g }, { closing: stopping.signal, flagged: () => {} });
    beforeAnswer = null;
    expect(await flagRows(w.agent.id, "hearsay")).toEqual(off.slice(2, 4));
    expect((await catchUps(w.agent.id))[0]!.next_seq).toBe(off[3]! + 1);
    expect(await heardOf(w.agent.id, w.g)).toBe(off[1]);
    expect(await counted("catchup_group_jobs")).toBe(1);

    // Restarted later: the first four lines are now older than MEMORY.catchUpDays.
    await db.query("update messages set created_at = now() - interval '31 days' where conversation_id = $1 and seq = any($2::bigint[])", [w.g, off.slice(0, 4)]);
    scripted.calls.splice(0);
    await memory().resume();
    await memory().idle();
    expect(scripted.calls).toHaveLength(1);
    expect(await flagRows(w.agent.id, "hearsay")).toEqual(off.slice(2));
    expect(await heardOf(w.agent.id, w.g)).toBe(off[1]);
    expect(await counted("catchup_group_jobs")).toBe(1);
    expect(await catchUps(w.agent.id)).toEqual([{ from_seq: off[1], to_seq: off[5], next_seq: off[5]! + 1 }]);
  });
});
