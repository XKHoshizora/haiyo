import type { FastifyBaseLogger } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { siteDay } from "../src/accounts/store.ts";
import { mentionsAtSend } from "../src/agents/mentions.ts";
import { MAX_AGENT_OPTIONS, optionsFor, requestFor } from "../src/agents/proactive/candidates.ts";
import { decideProactive } from "../src/agents/proactive/decide.ts";
import { listenersFor } from "../src/agents/proactive/listeners.ts";
import { actOnTriggered, noneTriggered, triggerFromAgent, type Caller, type Triggered } from "../src/agents/runs.ts";
import { lockAgent } from "../src/agents/store.ts";
import type { Config } from "../src/config.ts";
import { lockConversation } from "../src/conversations/store.ts";
import type { Db } from "../src/db.ts";
import { JudgeError, MAX_CHOICE_OPTIONS, type Answer, type Judge, type Question } from "../src/judge/client.ts";
import { insertMessage } from "../src/messages/model.ts";
import { createWhisper } from "../src/whispers/store.ts";
import { api, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { proactivePlainFloor } from "../src/agents/proactive/decide.ts";
import { readOwnedAgent } from "../src/agents/store.ts";
import { byName, nameOf, scriptedJudge, type ScriptedAnswers } from "./helpers/judge.ts";
import { closeAllSockets, connect, type Push } from "./helpers/ws.ts";

/**
 * The decision whether an Agent replies in a group unasked (batch 2D, Task 4; design rules 3–15; "Who is asked, and
 * how"): `decideProactive` is called here directly, as the scheduler (Task 5) will call it, with a scripted judgement
 * model. Agents are put into the group by inserting their membership, as the group-trigger tests do; their own messages
 * are stored as `postAsAgent` stores them. Runs are only queued: no worker picks them up.
 */

const JUDGE = {
  model: "jev-1",
  channels: [{ url: "https://judge-a.example.test/v1/systemone", apiKeyEnv: "UPSTREAM_TEST_KEY" }],
  timeoutMs: 4000,
  dailyLimit: 20_000,
};
const judge = scriptedJudge();
/** The design's paid site model (3 000 / 15 000 micro-points a token, 800 output tokens): what a paid-tier Agent's proactive reply costs. */
const PAID3 = {
  id: "paid3",
  label: "Paid three",
  tier: "paid",
  protocol: "openai_chat",
  baseUrl: "https://api.example.test/v1",
  apiKeyEnv: "UPSTREAM_TEST_KEY",
  model: "paid3-1",
  inputMicroPerToken: 3000,
  outputMicroPerToken: 15000,
  maxOutputTokens: 800,
  contextTokens: 100000,
  vision: false,
  pdf: false,
  reasoning: [],
};
const ENV = { ...SITE_ENV, SITE_MODELS: JSON.stringify([...JSON.parse(SITE_ENV.SITE_MODELS), PAID3]) };
const { app, db } = useApp({ env: ENV, judge, agentWorker: false, config: { judge: JUDGE } });

/** Whether the Agents `agentOf` makes have memory on: the scenarios that say so run once each way. */
let memoryOn = false;

const FAST = { source: "site", id: "fast" } as const;
const RANDOM = "6a0d4c2e-1b3f-4a5e-9c7d-8e9f0a1b2c3d";

// The judgement's copy, verbatim (constraints, "Who is asked, and how").
const PICK_TEXT = "群里有几个 AI 助手。记录里标着“（Agent）”的是它们说过的话。最新这条消息如果需要某个 AI 助手主动来回答，应该由谁回答？";
const NOBODY_TEXT = "不需要任何 AI 助手回答：真人之间的闲聊、客套、道谢，已经有人回答了，或者不属于上面任何一位擅长的事";
const quietText = (name: string) =>
  `群里有一个 AI 助手「${name}」。记录里标着“${name}（Agent）”的是它说过的话。开头标着【新】的是刚发的消息。在这些【新】消息里，有人在让${name}别再说话、安静一点，或者表示它打扰到大家了，而且在那之后没有人又让它继续说。没有标【新】的旧消息不算。`;

let lines: Array<Record<string, unknown>> = [];
const log = {
  info: (o: object) => void lines.push({ level: "info", ...o }),
  debug: (o: object) => void lines.push({ level: "debug", ...o }),
  warn: (o: object) => void lines.push({ level: "warn", ...o }),
  error: (o: object) => void lines.push({ level: "error", ...o }),
} as unknown as FastifyBaseLogger;

beforeEach(() => {
  judge.calls.splice(0);
  judge.answer(() => ({}));
  lines = [];
  memoryOn = false;
});

afterEach(async () => {
  await closeAllSockets();
});

/** The decision for message `seq` of `conv`, with the app's configuration (`over` replaces fields) and judge. */
const decide = (conv: string, seq: number, over: Partial<Config> = {}, withJudge: Judge | null = judge) =>
  decideProactive({ db, judge: withJudge, config: { ...app.deps.config, ...over }, log }, conv, seq);

interface World {
  owner: Actor;
  member: Actor;
  third: Actor;
  g: string;
}

async function world(): Promise<World> {
  const [owner, member, third] = [await signUp(app, "owner"), await signUp(app, "member"), await signUp(app, "third")];
  return { owner, member, third, g: await group(app, owner, "team", [member, third]) };
}

/** Puts principal `id` into conversation `conv` from its current seq on. */
const join = (conv: string, id: string) =>
  db.query(`insert into memberships (conversation_id, principal_id, role, joined_seq) select $1, $2, 'speaker', seq from conversations where id = $1`, [conv, id]);

/**
 * A proactive Agent of `owner` named `handle`, on the site model, put into `conv` when given. Memory (`memoryOn`) is off
 * unless a scenario says otherwise: an Agent with memory also listens for what is said about its owner (memory-flags.test.ts).
 */
async function agentOf(owner: Actor, handle: string, conv: string | null, over: Record<string, unknown> = {}) {
  const agent = await mustCreateAgent(app, owner, { handle, name: handle, model: FAST, persona: "简短地回答。", proactive: true, memory: memoryOn, ...over });
  if (conv) await join(conv, agent.id);
  return agent as { id: string; handle: string; conversationId: string };
}

let txn = 0;
const say = async (who: Actor, conv: string, text: string): Promise<number> => {
  const sent = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `pd${++txn}` });
  if (sent.status !== 201) throw new Error(`say: ${sent.status} ${JSON.stringify(sent.json)}`);
  return sent.json.message.seq as number;
};

/** A message of `senderId` stored as `postAsAgent` stores one (the conversation's row held); returns its seq. */
const post = (senderId: string, conv: string, kind: "text" | "file", body: Record<string, unknown>) =>
  db.tx(async (t) => {
    await lockConversation(t, conv);
    return (await insertMessage(t, conv, senderId, kind, body, null)).seq;
  });
const agentSays = (agentId: string, conv: string, text: string) => post(agentId, conv, "text", { text });

/** Ends every active run and moves it a minute back: no longer active, out of the fuse and of every minute's count. */
const settleAndAge = () =>
  db.query("update agent_runs set status = 'done', finished_at = now(), created_at = created_at - interval '1 minute' where status in ('queued', 'running')");

/** The Agent's runs in `conv`, oldest first. */
const runsOf = async (agentId: string, conv: string) =>
  (
    await db.query(
      `select status, error, lane, caller_id as caller, triggered_by as by, covers_seq::int as covers
         from agent_runs where agent_id = $1 and conversation_id = $2 order by created_at, id`,
      [agentId, conv],
    )
  ).rows;
const proactiveRuns = async (agentId: string, conv: string) => (await runsOf(agentId, conv)).filter((r) => r.lane === "proactive");

/** Where the Agent's threshold stands in `conv` (null: no row). */
const stateOf = async (agentId: string, conv: string) =>
  (
    await db.query(
      `select surcharge, surcharge_at, surcharge_seq::int as surcharge_seq, quiet, quiet_half_life_s, quiet_at, judged_at
         from agent_group_state where agent_id = $1 and conversation_id = $2`,
      [agentId, conv],
    )
  ).rows[0] ?? null;
/** A state the decision did not change: only the judgement's stamp. */
const UNTOUCHED = { surcharge: 0, surcharge_at: null, surcharge_seq: null, quiet: 0, quiet_half_life_s: null, quiet_at: null, judged_at: expect.any(Date) };

const noticesOf = async (conv: string) =>
  (
    await db.query<{ seq: number; body: Record<string, unknown> }>(
      `select seq::int as seq, body from messages where conversation_id = $1 and kind = 'system' and body ->> 'event' = 'agent_quieted' order by seq`,
      [conv],
    )
  ).rows;

/** The `proactive_skipped` lines logged at info. */
const skipped = () => lines.filter((l) => l.metric === "proactive_skipped" && l.level === "info").map(({ level: _, ...l }) => l);

/** The pick and quiet questions of a request: what the proactive judgement asks, whatever listens besides. */
const coreKeys = (questions: readonly Question[]) => questions.filter((q) => q.key === "pick" || q.key.startsWith("q_")).map((q) => q.key);
/** The listener questions of a request by what they ask and about whom (their keys follow owner ids): `hearsay:{name}` / `own:{name}`, sorted. */
const listenerKinds = (questions: readonly Question[]) =>
  questions
    .filter((q) => /^h\d+o?$/.test(q.key))
    .map((q) => `${q.key.endsWith("o") ? "own" : "hearsay"}:${/「(.+?)」/.exec(q.instructions)![1]}`)
    .sort();

const pickOf = (questions: readonly Question[]) => questions.find((q) => q.key === "pick") as Extract<Question, { type: "choice" }>;
/** The key of the option named `name` in what was asked. */
const keyOf = (questions: readonly Question[], name: string) => Object.entries(pickOf(questions).options).find(([k, d]) => nameOf(k, d) === name)![0];
/** The names of the options offered in the judge's latest call, in key order. */
const offered = () => Object.entries(pickOf(judge.calls.at(-1)!.questions).options).map(([k, d]) => nameOf(k, d));

/** A judge that lets `meanwhile` happen while it is asked, then answers as the scripted one does. */
const judgeAfter = (meanwhile: () => Promise<unknown>): Judge => ({
  async ask(state, questions, signal) {
    await meanwhile();
    return judge.ask(state, questions, signal);
  },
});

/** After commit, what the send route does with what a message triggered: its notices published, its runs announced. */
const publish = (t: Triggered) => {
  app.deps.conversations.publish({ messages: t.notices, conversations: [] }, log);
  actOnTriggered(t, { announce: (run) => app.agentPort.announce(run), log, realtime: app.realtime, interrupt: (ids) => app.agentPort.interruptRuns(ids) });
};

// --- listeners (Task 8; the rest is in memory-flags.test.ts) ---

describe("an Agent with memory on in the request", () => {
  it("adds the listener questions after the pick and the quiet ones, and the window is the options' alone (a listener narrows nothing)", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    await say(w.member, w.g, "加入之前");
    const memo = await agentOf(w.third, "memo", w.g, { memory: true, proactive: false });
    const asked = await say(w.member, w.g, "third 周末要去爬山");
    const options = await optionsFor(db, w.g, asked, w.member.id, app.deps.config);
    const listeners = await listenersFor(db, w.g, asked);
    expect(listeners).toMatchObject([{ key: "h1", ownerId: w.third.id, ownerName: "third", agentIds: [memo.id], reviewerId: memo.id }]);
    const request = (await requestFor(db, w.g, asked, options, app.deps.config.proactive, listeners))!;
    expect(request.state).toBe("群聊记录：\nmember：加入之前\n【新】member：third 周末要去爬山");
    expect(request.questions.map((q) => q.key)).toEqual(["pick", "h1"]);
    expect(options.map((o) => o.agentId)).toEqual([anna.id]);
    // Without the listeners the request is what it was.
    expect((await requestFor(db, w.g, asked, options, app.deps.config.proactive))!.questions.map((q) => q.key)).toEqual(["pick"]);
  });

  it("a memory-only Agent that joins after a proactive one does not narrow what the pick is shown", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    await say(w.member, w.g, "加入之前的话");
    await agentOf(w.third, "memo", w.g, { memory: true, proactive: false });
    const asked = await say(w.member, w.g, "加入之后的话");
    judge.answer(byName({ anna: 0.1, nobody: 0.9 }));
    await decide(w.g, asked);
    const { state, questions } = judge.calls[0]!;
    // Exactly as without memory: anna's window starts at her own join; the listener asks for its owner meanwhile.
    expect(state).toBe("群聊记录：\nmember：加入之前的话\n【新】member：加入之后的话");
    expect(Object.values(pickOf(questions).options).map((d) => d.split("：")[0])).toEqual(["anna", "不需要任何 AI 助手回答"]);
    expect(questions.map((q) => q.key)).toEqual(["pick", "h1"]);
    expect(anna.id).toBeTruthy();
  });
});

// --- who replies ---------------------------------------------------------------------------------------------------

describe.each([false, true])("who replies unasked (memory %s)", (memory) => {
  beforeEach(() => {
    memoryOn = memory;
  });

  it("an on-topic request: the picked Agent's reply is queued in lane proactive, by nobody, covering the message; its surcharge rises", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g, { intro: "会做饭的助手", field: "家常菜" });
    judge.answer(byName({ anna: 0.9, nobody: 0.05 }));
    const asked = await say(w.member, w.g, "今晚做什么菜好？");
    const triggered = await decide(w.g, asked);
    expect(triggered).toEqual({
      runs: [{ ownerId: w.owner.id, conversationId: w.g, run: { id: expect.any(String), status: "queued", retryable: false } }],
      callerLimited: [],
      notices: [],
      budgetReached: [],
      stopped: [],
    });
    expect(await runsOf(anna.id, w.g)).toEqual([{ status: "queued", error: null, lane: "proactive", caller: null, by: "human", covers: asked }]);
    const state = await stateOf(anna.id, w.g);
    expect(state).toMatchObject({ surcharge_seq: asked, quiet: 0, surcharge_at: expect.any(Date), judged_at: expect.any(Date) });
    expect(state.surcharge).toBeCloseTo(0.1, 6);
    expect(judge.calls).toHaveLength(1);
    expect(skipped()).toEqual([]);
  });

  it("nobody: nothing, nothing locked, and the Agent's state holds nothing but the judgement's stamp", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    judge.answer(byName({ anna: 0.05, nobody: 0.95 }));
    const said = await say(w.member, w.g, "哈哈，谢谢大家");
    // Under every threshold there is, with no quiet answer: no transaction, so neither the group's row nor anna's is locked.
    const tx = vi.fn((fn: Parameters<Db["tx"]>[0]) => db.tx(fn));
    const spied = { query: db.query, tx, pool: db.pool, close: db.close } as unknown as Db;
    expect(await decideProactive({ db: spied, judge, config: app.deps.config, log }, w.g, said)).toEqual(noneTriggered());
    expect(tx).not.toHaveBeenCalled();
    expect(await runsOf(anna.id, w.g)).toEqual([]);
    expect(await stateOf(anna.id, w.g)).toEqual(UNTOUCHED);
    expect(skipped()).toEqual([]);
    expect(lines).toEqual([{ level: "debug", metric: "proactive_skipped", reason: "under_threshold", agentId: anna.id, conversationId: w.g }]);
    // A winner that might pass is decided in a transaction.
    judge.answer(byName({ anna: 0.6 }));
    await decideProactive({ db: spied, judge, config: app.deps.config, log }, w.g, await say(w.member, w.g, "好吃吗？"));
    expect(tx).toHaveBeenCalledTimes(1);
  });

  it("of two options the more probable replies and the other is untouched; under the threshold nobody does", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    const bob = await agentOf(w.member, "bob_bot", w.g);
    judge.answer(byName({ anna: 0.8, bob_bot: 0.15, nobody: 0.05 }));
    const asked = await say(w.third, w.g, "红烧肉怎么做？");
    expect((await decide(w.g, asked)).runs.map((r) => r.ownerId)).toEqual([w.owner.id]);
    expect((await proactiveRuns(anna.id, w.g)).map((r) => r.covers)).toEqual([asked]);
    expect(await runsOf(bob.id, w.g)).toEqual([]);
    expect(await stateOf(bob.id, w.g)).toEqual(UNTOUCHED);

    // 0.6 is under the default threshold (normal: 0.65): nobody, and it is not logged at info (the normal case).
    await settleAndAge();
    judge.answer(byName({ anna: 0.1, bob_bot: 0.6, nobody: 0.3 }));
    const unsure = await say(w.third, w.g, "有人去过云南吗？");
    expect(await decide(w.g, unsure)).toEqual(noneTriggered());
    expect(await runsOf(bob.id, w.g)).toEqual([]);
    expect(skipped()).toEqual([]);
  });

  it("two options tied: the one with the lower id", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g, { proactiveLevel: "more" });
    const bob = await agentOf(w.member, "bob_bot", w.g, { proactiveLevel: "more" });
    const [lower, higher] = [anna, bob].sort((a, b) => (a.id < b.id ? -1 : 1));
    judge.answer(byName({ anna: 0.5, bob_bot: 0.5 }));
    const asked = await say(w.third, w.g, "谁能帮个忙？");
    await decide(w.g, asked);
    expect((await proactiveRuns(lower!.id, w.g)).length).toBe(1);
    expect(await runsOf(higher!.id, w.g)).toEqual([]);
  });

  it("the owner's own message can be answered unasked by the owner's Agent", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    judge.answer(byName({ anna: 0.9 }));
    const asked = await say(w.owner, w.g, "今晚吃什么？");
    expect((await decide(w.g, asked)).runs).toHaveLength(1);
    expect(await proactiveRuns(anna.id, w.g)).toEqual([{ status: "queued", error: null, lane: "proactive", caller: null, by: "human", covers: asked }]);
  });

  it("probabilities for an option nobody asked about, and answers to questions not asked, are ignored", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    const bob = await agentOf(w.member, "bob_bot", w.g);
    await say(w.member, w.g, "开始");
    // A judge answering more than it was asked: an option `a9` with the highest probability, a quiet question about bob
    // (who did not speak), and a quiet answer about anna as a choice.
    let asked: readonly Question[] = [];
    const raw: Judge = {
      async ask(_state, questions) {
        asked = questions;
        const [a, b] = [keyOf(questions, "anna"), keyOf(questions, "bob_bot")];
        return new Map<string, Answer>([
          ["pick", { type: "choice", probabilities: new Map([[a, 0.7], [b, 0.2], ["nobody", 0.1], ["a9", 0.99]]) }],
          [`q_${a}`, { type: "choice", probabilities: new Map([["x", 1]]) }],
          [`q_${b}`, { type: "noul", p: 0.99 }],
        ]);
      },
    };
    const said = await say(w.third, w.g, "问一下");
    expect((await decide(w.g, said, {}, raw)).runs).toHaveLength(1);
    expect(asked.map((q) => q.key).filter((k) => k === "pick" || k.startsWith("q_"))).toEqual(["pick"]); // listener questions (`h1`, …) come with memory on
    expect((await proactiveRuns(anna.id, w.g)).length).toBe(1);
    expect(await stateOf(bob.id, w.g)).toEqual(UNTOUCHED);
  });

  it("a pick answer missing any option asked — an Agent or nobody — is no answer: nobody replies", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    await agentOf(w.member, "bob_bot", w.g);
    await agentOf(w.third, "carl_bot", w.g);
    const partial = (leaveOut: (name: string) => boolean) => (_s: string, questions: readonly Question[]): ScriptedAnswers => {
      const options = pickOf(questions).options;
      const answer: Record<string, number> = {};
      for (const [k, d] of Object.entries(options)) {
        const name = nameOf(k, d);
        if (!leaveOut(name)) answer[k] = name === "anna" ? 0.9 : 0.02;
      }
      return { pick: answer };
    };
    for (const leaveOut of ["carl_bot", "nobody"]) {
      judge.answer(partial((name) => name === leaveOut));
      const said = await say(w.member, w.g, `问题 ${leaveOut}`);
      expect([leaveOut, await decide(w.g, said)]).toEqual([leaveOut, noneTriggered()]);
    }
    expect(await runsOf(anna.id, w.g)).toEqual([]);
    // Each is logged, with no more than where.
    expect(lines.filter((l) => l.metric === "judge_partial")).toEqual([
      { level: "info", metric: "judge_partial", conversationId: w.g },
      { level: "info", metric: "judge_partial", conversationId: w.g },
    ]);
    // The whole answer: anna replies.
    judge.answer(partial(() => false));
    expect((await decide(w.g, await say(w.member, w.g, "最后一问"))).runs).toHaveLength(1);
  });

  it("a pick whose probabilities over the options asked do not sum to about 1 (0.9 to 1.1) is no answer: nobody replies", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    await agentOf(w.member, "bob_bot", w.g);
    const summing = (anna: number, bob: number, nobody: number): Judge => ({
      async ask(_state, questions) {
        const pick = new Map([[keyOf(questions, "anna"), anna], [keyOf(questions, "bob_bot"), bob], ["nobody", nobody], ["a9", 0.9]]);
        return new Map<string, Answer>([["pick", { type: "choice", probabilities: pick }]]);
      },
    });
    // Over: 0.9 + 0.9 + 0.1; under: 0.7 + 0.05 + 0.1. (An option not asked, `a9`, never counts.)
    for (const [a, b, n] of [
      [0.9, 0.9, 0.1],
      [0.7, 0.05, 0.1],
    ] as const) {
      expect(await decide(w.g, await say(w.member, w.g, `问 ${a} ${b}`), {}, summing(a, b, n))).toEqual(noneTriggered());
    }
    expect(lines.filter((l) => l.metric === "judge_partial")).toEqual([
      { level: "info", metric: "judge_partial", conversationId: w.g },
      { level: "info", metric: "judge_partial", conversationId: w.g },
    ]);
    expect(await runsOf(anna.id, w.g)).toEqual([]);
    // At the edges: 1.1 and 0.9 are answers.
    expect((await decide(w.g, await say(w.member, w.g, "问 1.1"), {}, summing(0.9, 0.1, 0.1))).runs).toHaveLength(1);
    await settleAndAge();
    expect((await decide(w.g, await say(w.member, w.g, "问 0.9"), {}, summing(0.88, 0.01, 0.01))).runs).toHaveLength(1);
  });
});

// --- what is asked ----------------------------------------------------------------------------------------------------

describe.each([false, true])("what the judgement model is asked (memory %s)", (memory) => {
  beforeEach(() => {
    memoryOn = memory;
  });

  it("one choice over every proactive Agent and nobody, keyed in id order, and a quiet question for each one that spoke", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g, { intro: "会做饭的助手", field: "家常菜" });
    const bob = await agentOf(w.member, "bob_bot", w.g, { intro: "旅行达人", field: "自由行" });
    const carl = await agentOf(w.third, "carl_bot", w.g, { intro: "", field: "" });
    // Not options: proactive off, paused, without a model, not in the group, left the group.
    const dora = await agentOf(w.owner, "dora", w.g, { proactive: false });
    const eve = await agentOf(w.third, "eve_bot", w.g);
    expect((await api(app, w.third, "POST", `/api/agents/${eve.id}/pause`)).status).toBe(200);
    await agentOf(w.member, "fay_bot", w.g, { model: null });
    await agentOf(w.member, "gus_bot", null);
    const hal = await agentOf(w.owner, "hal_bot", w.g);
    await db.query("update memberships set left_seq = (select seq from conversations where id = $1) where conversation_id = $1 and principal_id = $2", [w.g, hal.id]);

    await say(w.member, w.g, "大家好");
    await agentSays(anna.id, w.g, "我来推荐几道菜：\n番茄炒蛋");
    await agentSays(dora.id, w.g, "我也在");
    await agentSays(hal.id, w.g, "我走了");
    const asked = await say(w.third, w.g, "那周末去哪儿玩？");
    await decide(w.g, asked);

    expect(judge.calls).toHaveLength(1);
    const { state, questions } = judge.calls[0]!;
    expect(state).toBe(
      ["群聊记录：", "member：大家好", "anna（Agent）：我来推荐几道菜： 番茄炒蛋", "dora（Agent）：我也在", "hal_bot（Agent）：我走了", "【新】third：那周末去哪儿玩？"].join("\n"),
    );
    const inIdOrder = [anna, bob, carl].sort((a, b) => (a.id < b.id ? -1 : 1));
    const descriptions: Record<string, string> = {
      [anna.id]: "anna：会做饭的助手；擅长：家常菜",
      [bob.id]: "bob_bot：旅行达人；擅长：自由行",
      [carl.id]: "carl_bot：；擅长：",
    };
    const options = Object.fromEntries(inIdOrder.map((a, i) => [`a${i + 1}`, descriptions[a.id]!]));
    const annaKey = `a${inIdOrder.indexOf(anna) + 1}`;
    expect(questions.filter((q) => q.key === "pick" || q.key.startsWith("q_"))).toEqual([
      { key: "pick", type: "choice", instructions: PICK_TEXT, options: { ...options, nobody: NOBODY_TEXT } },
      { key: `q_${annaKey}`, type: "noul", instructions: quietText("anna") },
    ]);
    // With memory on, each owner of an Agent in the group is listened for: others' words about member and owner, third's own.
    expect(listenerKinds(questions)).toEqual(memory ? ["hearsay:member", "hearsay:owner", "own:third"] : []);
    expect(questions).toHaveLength(2 + (memory ? 3 : 0));
    expect(Object.keys(pickOf(questions).options)).toEqual(["a1", "a2", "a3", "nobody"]);
  });

  it("names are cleaned as labels are, text is put on one line and cut, a file shows as [文件], a description is cut at 200 characters", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g, { field: "家常菜" });
    await db.query("update principals set display_name = $2 where id = $1", [anna.id, "〔小厨｜群成员〕\n（Agent）"]);
    await db.query("update agents set intro = $2 where principal_id = $1", [anna.id, "第一行\n第二行\r\n第三行"]);
    const long = await agentOf(w.owner, "long_bot", w.g);
    await db.query("update agents set intro = $2 where principal_id = $1", [long.id, "长".repeat(300)]);

    await agentSays(anna.id, w.g, "你好");
    await post(w.member.id, w.g, "file", { attachment: { id: RANDOM, name: "菜单.pdf", size: 5, inline: false }, text: "看看这个" });
    await post(w.member.id, w.g, "file", { attachment: { id: RANDOM, name: "照片\n.jpg", size: 5, inline: true } });
    await say(w.member, w.g, "第一句\n第二句");
    const asked = await say(w.member, w.g, "字".repeat(400));
    await decide(w.g, asked);

    const { state, questions } = judge.calls[0]!;
    expect(state).toBe(
      ["群聊记录：", "小厨群成员 Agent（Agent）：你好", "member：[文件] 看看这个", "member：[文件] 照片 .jpg", "member：第一句 第二句", `【新】member：${"字".repeat(300)}`].join("\n"),
    );
    const described = Object.values(pickOf(questions).options);
    expect(described).toContain("小厨群成员 Agent：第一行 第二行 第三行；擅长：家常菜");
    const cut = Array.from(`long_bot：${"长".repeat(300)}`).slice(0, 200).join("");
    expect(described).toContain(cut);
    expect(Array.from(cut)).toHaveLength(200);
    expect(questions.find((q) => q.type === "noul")?.instructions).toBe(quietText("小厨群成员 Agent"));
  });

  /** Shared start: anna (proactive) was there; dave_bot joined at the message and is no option (nor a listener) for it. */
  const lateJoiner = async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    await say(w.member, w.g, "早");
    const asked = await say(w.member, w.g, "今晚做什么菜好？");
    // Put in while people were still being waited for: its stay begins at the message.
    await agentOf(w.third, "dave_bot", w.g);
    await decide(w.g, asked);
    expect(offered()).toEqual(["anna", "nobody"]);
    expect(judge.calls[0]!.state).toBe("群聊记录：\nmember：早\n【新】member：今晚做什么菜好？");
    expect(coreKeys(judge.calls[0]!.questions)).toEqual(["pick"]);
    // dave_bot joined at the message: no listener for it; anna's owner is listened for when memory is on.
    expect(listenerKinds(judge.calls[0]!.questions)).toEqual(memory ? ["hearsay:owner"] : []);
    await db.query("update agents set proactive = false where principal_id = $1", [anna.id]);
    return { w, asked };
  };

  it.skipIf(memory)("an Agent that joined at or after the message is no option for it; with no other option the judge is not asked", async () => {
    const { w, asked } = await lateJoiner();
    // The late one alone: nobody to ask about.
    expect(await decide(w.g, asked)).toEqual(noneTriggered());
    expect(judge.calls).toHaveLength(1);
  });

  it.skipIf(!memory)("an Agent that joined at or after the message is no option for it; with no other option, only the Agent that listens is asked about", async () => {
    // Differs from memory off: anna still listens for her owner, so the judgement is asked, with the listener question alone.
    const { w, asked } = await lateJoiner();
    expect(await decide(w.g, asked)).toEqual(noneTriggered());
    expect(judge.calls).toHaveLength(2);
    const second = judge.calls[1]!.questions;
    expect(coreKeys(second)).toEqual([]);
    expect(listenerKinds(second)).toEqual(["hearsay:owner"]);
    expect(judge.calls[1]!.state).toBe("群聊记录：\nmember：早\n【新】member：今晚做什么菜好？");
  });

  it("no line of the transcript to show (every option joined at the message or after): no request", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    const asked = await say(w.member, w.g, "今晚做什么菜好？");
    const [option] = await optionsFor(db, w.g, asked, w.member.id, app.deps.config);
    expect(option?.agentId).toBe(anna.id);
    expect(await requestFor(db, w.g, asked, [{ ...option!, joinedSeq: asked }], app.deps.config.proactive)).toBeNull();
  });

  it("an Agent that joined after earlier messages narrows the transcript for everyone; once it is no option, it widens again (with or without memory)", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    await say(w.member, w.g, "早");
    await agentSays(anna.id, w.g, "早上好");
    const dave = await agentOf(w.third, "dave_bot", w.g);
    await say(w.member, w.g, "dave 来了");
    const asked = await say(w.third, w.g, "问个问题");
    await decide(w.g, asked);
    expect(judge.calls[0]!.state).toBe("群聊记录：\nmember：dave 来了\n【新】third：问个问题");
    // anna's own message lies before dave joined: it is not shown, so anna is asked no quiet question.
    expect(coreKeys(judge.calls[0]!.questions)).toEqual(["pick"]);
    expect(listenerKinds(judge.calls[0]!.questions)).toEqual(memory ? ["hearsay:owner", "own:third"] : []);

    // A listener narrows nothing: dave_bot no option, the window is anna's again, whatever dave_bot's memory.
    await db.query("update agents set proactive = false where principal_id = $1", [dave.id]);
    const again = await say(w.third, w.g, "再问一个");
    await decide(w.g, again);
    expect(judge.calls[1]!.state).toBe("群聊记录：\nmember：早\nanna（Agent）：早上好\nmember：dave 来了\nthird：问个问题\n【新】third：再问一个");
    expect(coreKeys(judge.calls[1]!.questions)).toEqual(["pick", "q_a1"]);
    expect(listenerKinds(judge.calls[1]!.questions)).toEqual(memory ? ["hearsay:owner", "own:third"] : []);
  });

  it("the transcript holds the last 15 messages that are not notices", async () => {
    const w = await world();
    await agentOf(w.owner, "anna", w.g);
    // Seqs that cross 10 and 100 (F6): the last 15 by number.
    for (let i = 1; i <= 104; i++) await say(w.member, w.g, `第${i}条`);
    await api(app, w.owner, "PATCH", `/api/conversations/${w.g}`, { title: "新名字" });
    const asked = await say(w.member, w.g, "第105条");
    await decide(w.g, asked);
    const shown = judge.calls[0]!.state.split("\n").slice(1);
    expect(shown).toEqual(Array.from({ length: 15 }, (_, i) => `${i === 14 ? "【新】" : ""}member：第${i + 91}条`));
  });

  it("the messages since the options were last judged with an answer are marked new: a covered one too, one judged already not again", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    await agentSays(anna.id, w.g, "番茄蛋花汤");
    await decide(w.g, await say(w.member, w.g, "听起来不错"));
    expect(judge.calls[0]!.state).toBe("群聊记录：\nanna（Agent）：番茄蛋花汤\n【新】member：听起来不错");
    // Two messages before the next judgement: both are new, the one judged before is not.
    await say(w.third, w.g, "你先别插话了");
    await decide(w.g, await say(w.member, w.g, "那我们去吃火锅吧"));
    expect(judge.calls[1]!.state.split("\n").slice(2)).toEqual(["member：听起来不错", "【新】third：你先别插话了", "【新】member：那我们去吃火锅吧"]);
    // A judgement that was not answered judged nothing: what it was shown is new to the next one still.
    judge.answer(() => new JudgeError("auth"));
    await decide(w.g, await say(w.member, w.g, "几点去"));
    judge.answer(() => ({}));
    await decide(w.g, await say(w.member, w.g, "七点吧"));
    expect(judge.calls[3]!.state.split("\n").slice(-3)).toEqual(["member：那我们去吃火锅吧", "【新】member：几点去", "【新】member：七点吧"]);
  });

  it("a sender blocked by an owner, or who blocked one, is offered none of that owner's Agents; other owners' stay", async () => {
    const w = await world();
    await agentOf(w.owner, "anna", w.g);
    await agentOf(w.third, "tess_bot", w.g);
    judge.answer(byName({ nobody: 0.9 }));
    expect((await api(app, w.owner, "PUT", `/api/blocks/${w.member.id}`)).status).toBe(200);
    await decide(w.g, await say(w.member, w.g, "有人知道好餐厅吗？"));
    expect(offered()).toEqual(["tess_bot", "nobody"]);
    // The other way round: the sender blocked the owner.
    expect((await api(app, w.owner, "DELETE", `/api/blocks/${w.member.id}`)).status).toBe(200);
    expect((await api(app, w.member, "PUT", `/api/blocks/${w.owner.id}`)).status).toBe(200);
    await decide(w.g, await say(w.member, w.g, "再问一次"));
    expect(offered()).toEqual(["tess_bot", "nobody"]);
    // Lifted: both again.
    expect((await api(app, w.member, "DELETE", `/api/blocks/${w.owner.id}`)).status).toBe(200);
    await decide(w.g, await say(w.member, w.g, "现在呢"));
    expect(offered().sort()).toEqual(["anna", "nobody", "tess_bot"]);
  });

  it(`beyond ${MAX_AGENT_OPTIONS} proactive Agents, the least recently judged take the places, still keyed in id order`, async () => {
    // A choice holds at most MAX_CHOICE_OPTIONS options, one of them nobody's.
    expect(MAX_AGENT_OPTIONS).toBe(MAX_CHOICE_OPTIONS - 1);
    const w = await world();
    const total = MAX_AGENT_OPTIONS + 2;
    const made = await db.query<{ id: string; name: string }>(
      `insert into principals (kind, handle, display_name, owner_id)
       select 'agent', 'many_' || i, 'many_' || i, $1 from generate_series(1, $2::int) i returning id, display_name as name`,
      [w.owner.id, total],
    );
    const ids = made.rows.map((r) => r.id).sort();
    const nameOfId = new Map(made.rows.map((r) => [r.id, r.name]));
    await db.query(`insert into agents (principal_id, model_source, site_model_id, proactive) select unnest($1::uuid[]), 'site', 'fast', true`, [ids]);
    await db.query(`insert into memberships (conversation_id, principal_id, role, joined_seq) select $1, unnest($2::uuid[]), 'speaker', 1`, [w.g, ids]);
    // Judged an hour ago, but: the two lowest ids most recently of all, and one never.
    const [latest, nextLatest] = [ids[0]!, ids[1]!];
    const never = ids[100]!;
    await db.query(
      `insert into agent_group_state (agent_id, conversation_id, judged_at)
       select a, $1, case when a = $3 then now() - interval '1 minute' when a = $4 then now() - interval '2 minutes' else now() - interval '1 hour' end
         from unnest($2::uuid[]) a where a <> $5`,
      [w.g, ids, latest, nextLatest, never],
    );
    const asked = await say(w.member, w.g, "大家好");
    await decide(w.g, asked);
    const first = pickOf(judge.calls[0]!.questions).options;
    expect(Object.keys(first)).toHaveLength(MAX_CHOICE_OPTIONS);
    const expected = ids.filter((id) => id !== latest && id !== nextLatest);
    expect(Object.keys(first)).toEqual([...expected.map((_, i) => `a${i + 1}`), "nobody"]);
    expect(Object.values(first).slice(0, -1)).toEqual(expected.map((id) => `${nameOfId.get(id)}：；擅长：`));
    expect(Object.values(first)).toContain(`${nameOfId.get(never)}：；擅长：`);

    // Each offered was stamped: the two left out are now the least recently judged, and are offered next time.
    const again = await say(w.member, w.g, "还在吗");
    await decide(w.g, again);
    const second = Object.values(pickOf(judge.calls[1]!.questions).options);
    expect(second).toContain(`${nameOfId.get(latest)}：；擅长：`);
    expect(second).toContain(`${nameOfId.get(nextLatest)}：；擅长：`);
    expect(second).toHaveLength(MAX_CHOICE_OPTIONS);
  });
});

// --- when nothing is asked ---------------------------------------------------------------------------------------------

describe.each([false, true])("when the judgement model is not asked (memory %s)", (memory) => {
  beforeEach(() => {
    memoryOn = memory;
  });

  it("an Agent's message, a message naming any Agent, a stale seq, a halt since, or no group: the judge is not called", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    await agentOf(w.member, "loner_bot", null);
    judge.answer(byName({ anna: 0.9 }));

    await say(w.member, w.g, "问个问题");
    expect(await decide(w.g, await agentSays(anna.id, w.g, "我在"))).toEqual(noneTriggered());
    // An Agent outside the group is named by its full handle (family names; decided at send, Task M: nothing is stored
    // for it, but the message asks an Agent, `asks_agent`); one in it by its name part too.
    for (const text of ["@anna 在吗", "@member.loner_bot 你在哪", "@ANNA", "@Owner.Anna"]) expect(await decide(w.g, await say(w.member, w.g, text))).toEqual(noneTriggered());
    await settleAndAge();
    const stale = await say(w.member, w.g, "第一句");
    await say(w.third, w.g, "第二句");
    expect(await decide(w.g, stale)).toEqual(noneTriggered());
    // Halted after the message: Agents keep out of it until a person writes again.
    const halted = await say(w.member, w.g, "停之前");
    expect((await api(app, w.third, "POST", `/api/conversations/${w.g}/agents/halt`)).status).toBe(200);
    expect(await decide(w.g, halted)).toEqual(noneTriggered());
    // Not a group: the Agent's own conversation.
    expect(await decide(anna.conversationId, await say(w.owner, anna.conversationId, "你好"))).toEqual(noneTriggered());
    expect(await decide(RANDOM, 1)).toEqual(noneTriggered());
    expect(judge.calls).toHaveLength(0);
    expect(await proactiveRuns(anna.id, w.g)).toEqual([]);

    // Naming a person, with a notice after it: judged.
    const named = await say(w.member, w.g, "@third 你说呢");
    await api(app, w.owner, "PATCH", `/api/conversations/${w.g}`, { title: "改个名" });
    expect((await decide(w.g, named)).runs).toHaveLength(1);
    expect(judge.calls).toHaveLength(1);
  });

  it("with no judgement model (none in the deps, or none configured): back at once, without a query", async () => {
    const w = await world();
    await agentOf(w.owner, "anna", w.g);
    const asked = await say(w.member, w.g, "今晚吃什么？");
    const query = vi.fn();
    const tx = vi.fn();
    const fake = { query, tx, pool: null, close: vi.fn() } as unknown as Db;
    const config = { ...app.deps.config };
    expect(await decideProactive({ db: fake, judge: null, config, log }, w.g, asked)).toEqual(noneTriggered());
    expect(await decideProactive({ db: fake, judge, config: { ...config, judge: null }, log }, w.g, asked)).toEqual(noneTriggered());
    expect([query.mock.calls.length, tx.mock.calls.length, judge.calls.length]).toEqual([0, 0, 0]);
  });

  it("judge_usage counts each call of the site day; at the day's limit the judge is not called, and that is logged once", async () => {
    const w = await world();
    await agentOf(w.owner, "anna", w.g);
    const day = siteDay(new Date(), app.deps.config.siteTimezone);
    judge.answer(byName({ nobody: 0.9 }));
    await decide(w.g, await say(w.member, w.g, "一"));
    // A call that fails counts too.
    judge.answer(() => new Error("upstream down"));
    await decide(w.g, await say(w.member, w.g, "二"));
    expect((await db.query("select day::text as day, calls from judge_usage")).rows).toEqual([{ day, calls: 2 }]);
    expect(judge.calls).toHaveLength(2);

    const capped = { judge: { ...JUDGE, dailyLimit: 2 } };
    judge.answer(byName({ anna: 0.99 }));
    expect(await decide(w.g, await say(w.member, w.g, "三"), capped)).toEqual(noneTriggered());
    expect(await decide(w.g, await say(w.member, w.g, "四"), capped)).toEqual(noneTriggered());
    expect(judge.calls).toHaveLength(2);
    expect((await db.query("select calls from judge_usage")).rows).toEqual([{ calls: 2 }]);
    // The line is logged once per process and site day: only the first leg of this describe (memory off) sees it.
    if (!memory) expect(lines.filter((l) => l.metric === "judge_daily_limit")).toEqual([{ level: "info", metric: "judge_daily_limit" }]);
    // Above it again (the limit lowered): still once.
    expect(await decide(w.g, await say(w.member, w.g, "五"), { judge: { ...JUDGE, dailyLimit: 1 } })).toEqual(noneTriggered());
    if (!memory) expect(lines.filter((l) => l.metric === "judge_daily_limit")).toHaveLength(1);
  });
});

// --- failures ----------------------------------------------------------------------------------------------------------

describe.each([false, true])("a judgement that fails (memory %s)", (memory) => {
  beforeEach(() => {
    memoryOn = memory;
  });

  it("throws, or hangs past its time: nobody replies, nothing changes", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    await agentSays(anna.id, w.g, "我在");
    judge.answer(() => new Error("upstream down"));
    expect(await decide(w.g, await say(w.member, w.g, "问一下"))).toEqual(noneTriggered());
    judge.answer(() => "hang");
    const started = Date.now();
    expect(await decide(w.g, await say(w.member, w.g, "再问一下"), { judge: { ...JUDGE, timeoutMs: 50 } })).toEqual(noneTriggered());
    expect(Date.now() - started).toBeLessThan(3000);
    expect(await runsOf(anna.id, w.g)).toEqual([]);
    expect(await stateOf(anna.id, w.g)).toEqual(UNTOUCHED);
    // Why, coarsely: an error that is no JudgeError (the client's own say why), then the time all channels had.
    expect(lines.filter((l) => l.metric === "judge_failed")).toEqual([
      { level: "info", metric: "judge_failed", reason: "network", conversationId: w.g },
      { level: "info", metric: "judge_failed", reason: "timeout", conversationId: w.g },
    ]);
    judge.answer(() => new JudgeError("auth"));
    await decide(w.g, await say(w.member, w.g, "第三次"));
    expect(lines.filter((l) => l.metric === "judge_failed").at(-1)).toEqual({ level: "info", metric: "judge_failed", reason: "auth", conversationId: w.g });
  });

  it("answers only the quiet questions: nobody replies, and what they say is applied", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    await agentSays(anna.id, w.g, "我又来了");
    judge.answer((state, questions) => {
      const { pick: _, ...quietOnly } = byName({}, { anna: 0.95 })(state, questions);
      return quietOnly;
    });
    const said = await say(w.member, w.g, "anna 你先别插话了");
    const triggered = await decide(w.g, said);
    expect(triggered.runs).toEqual([]);
    expect(triggered.notices.map((n) => n.body.event)).toEqual(["agent_quieted"]);
    expect(await stateOf(anna.id, w.g)).toMatchObject({ quiet_half_life_s: 3600, quiet_at: expect.any(Date) });
    expect(lines.filter((l) => l.metric === "judge_partial")).toEqual([{ level: "info", metric: "judge_partial", conversationId: w.g }]);
  });
});

// --- quiet ---------------------------------------------------------------------------------------------------------------

describe.each([false, true])("being asked to be quiet (memory %s)", (memory) => {
  beforeEach(() => {
    memoryOn = memory;
  });

  it("a sure answer raises the threshold to its cap and tells the group once an hour; a direct address still passes", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    await agentSays(anna.id, w.g, "我来说两句");
    judge.answer(byName({ nobody: 0.9 }, { anna: 0.95 }));
    const first = await decide(w.g, await say(w.member, w.g, "anna 你先别插话了"));
    expect(first.runs).toEqual([]);
    expect(first.notices.map((n) => n.body)).toEqual([
      { event: "agent_quieted", actorId: anna.id, agentId: anna.id, text: "「anna」暂时不主动发言，需要时可以 @ 它" },
    ]);
    expect((await noticesOf(w.g)).map((n) => n.seq)).toEqual(first.notices.map((n) => n.seq));
    const raised = await stateOf(anna.id, w.g);
    expect(raised).toMatchObject({ quiet_half_life_s: 3600, quiet_at: expect.any(Date), surcharge: 0 });
    expect(raised.quiet).toBeCloseTo(0.33, 6);

    // Asked again within the hour: raised again, not told again.
    const second = await decide(w.g, await say(w.third, w.g, "真的，别说了"));
    expect(second.notices).toEqual([]);
    expect(await noticesOf(w.g)).toHaveLength(1);

    // Raised: a pick of 0.9 does not pass (the threshold is at its cap, 0.98); 0.99 does.
    judge.answer(byName({ anna: 0.9 }, { anna: 0 }));
    expect(await decide(w.g, await say(w.member, w.g, "那今晚吃什么？"))).toEqual(noneTriggered());
    judge.answer(byName({ anna: 0.99 }, { anna: 0 }));
    expect((await decide(w.g, await say(w.member, w.g, "anna，今晚吃什么？"))).runs).toHaveLength(1);
    await settleAndAge();

    // An hour after the notice: told again.
    await db.query("update messages set created_at = now() - interval '61 minutes' where conversation_id = $1 and body ->> 'event' = 'agent_quieted'", [w.g]);
    judge.answer(byName({ nobody: 0.9 }, { anna: 0.95 }));
    expect((await decide(w.g, await say(w.member, w.g, "别说了"))).notices).toHaveLength(1);
    expect(await noticesOf(w.g)).toHaveLength(2);
  });

  it("an unsure answer raises it a little, tells nobody, and hushes the Agent for this message whatever its pick", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    await agentSays(anna.id, w.g, "我来说两句");
    // 0.9 would pass the threshold even with the small raise (0.65 + 0.15): the hush rule stops it.
    judge.answer(byName({ anna: 0.9 }, { anna: 0.5 }));
    const said = await say(w.member, w.g, "这机器人话有点多啊");
    const triggered = await decide(w.g, said);
    expect(triggered).toEqual(noneTriggered());
    const state = await stateOf(anna.id, w.g);
    expect(state).toMatchObject({ quiet_half_life_s: 600, surcharge: 0 });
    expect(state.quiet).toBeCloseTo(0.15, 6);
    expect(skipped()).toEqual([{ metric: "proactive_skipped", reason: "hushed", agentId: anna.id, conversationId: w.g }]);
    // Below the small raise's mark: nothing at all.
    judge.answer(byName({ nobody: 0.9 }, { anna: 0.29 }));
    const before = await stateOf(anna.id, w.g);
    await decide(w.g, await say(w.member, w.g, "嗯"));
    expect({ ...(await stateOf(anna.id, w.g)), judged_at: null }).toEqual({ ...before, judged_at: null });
  });
});

// --- the brakes ------------------------------------------------------------------------------------------------------------

describe.each([false, true])("after it has spoken unasked (memory %s)", (memory) => {
  beforeEach(() => {
    memoryOn = memory;
  });

  it("the same pick no longer passes until time passes or others have spoken", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    judge.answer(byName({ anna: 0.7 }));
    expect((await decide(w.g, await say(w.member, w.g, "问一"))).runs).toHaveLength(1);
    await settleAndAge();
    // 0.65 + 0.10: 0.7 is under it now.
    expect(await decide(w.g, await say(w.member, w.g, "问二"))).toEqual(noneTriggered());
    // Ten minutes later the surcharge has all but gone.
    await db.query("update agent_group_state set surcharge_at = surcharge_at - interval '10 minutes' where agent_id = $1", [anna.id]);
    expect((await decide(w.g, await say(w.member, w.g, "问三"))).runs).toHaveLength(1);
    await settleAndAge();
    // Others' messages halve it every four; its own do not count: after six of its own and two of others' (the question
    // among them) it is still about 0.07 — were its own counted, eight would quarter it to about 0.026, and 0.7 would pass.
    for (let i = 0; i < 6; i++) await agentSays(anna.id, w.g, `我说${i}`);
    await say(w.third, w.g, "嗯");
    expect(await decide(w.g, await say(w.member, w.g, "问四"))).toEqual(noneTriggered());
    // Seven more of others': nine since, about 0.02 — under 0.05, so 0.7 passes.
    for (let i = 0; i < 6; i++) await say(w.third, w.g, `闲聊${i}`);
    expect((await decide(w.g, await say(w.member, w.g, "问五"))).runs).toHaveLength(1);
    expect((await proactiveRuns(anna.id, w.g)).length).toBe(3);
  });

  it("its surcharge is stamped again from what is left of it after time and others' messages, plus a step", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    judge.answer(byName({ anna: 0.95 }));
    expect((await decide(w.g, await say(w.member, w.g, "问一"))).runs).toHaveLength(1);
    await settleAndAge();
    // Four messages by others since (the question among them): the 0.1 has halved, whatever the few seconds did.
    for (let i = 0; i < 3; i++) await say(w.third, w.g, `闲聊${i}`);
    const second = await say(w.member, w.g, "问二");
    expect((await decide(w.g, second)).runs).toHaveLength(1);
    const state = await stateOf(anna.id, w.g);
    expect(state.surcharge_seq).toBe(second);
    expect(state.surcharge).toBeCloseTo(0.1 * 0.5 + 0.1, 5);
  });

  it("its owner's level sets the base: 0.6 does not pass at less (0.80), and does at more (0.50)", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g, { proactiveLevel: "less" });
    judge.answer(byName({ anna: 0.6 }));
    expect(await decide(w.g, await say(w.member, w.g, "问一"))).toEqual(noneTriggered());
    expect((await api(app, w.owner, "PATCH", `/api/agents/${anna.id}`, { proactiveLevel: "more" })).status).toBe(200);
    expect((await decide(w.g, await say(w.member, w.g, "问二"))).runs).toHaveLength(1);
  });

  it("a message leads to one proactive reply at most: once it has, it is not judged again, and a decision racing it stops short", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    judge.answer(byName({ anna: 0.99 }));
    const asked = await say(w.member, w.g, "今晚吃什么？");
    expect((await decide(w.g, asked)).runs).toHaveLength(1);
    // Nothing else would stop it now: the reply is over, out of the fuse, and 0.99 is over the surcharged threshold.
    await settleAndAge();
    expect(await decide(w.g, asked)).toEqual(noneTriggered());
    expect(judge.calls).toHaveLength(1);
    expect((await proactiveRuns(anna.id, w.g)).length).toBe(1);

    // Two decisions of one message at once: the one whose judgement comes back last finds the other's reply.
    const next = await say(w.member, w.g, "那明天呢？");
    const racing = decide(w.g, next, {}, judgeAfter(async () => (await decide(w.g, next), settleAndAge())));
    expect(await racing).toEqual(noneTriggered());
    expect(judge.calls).toHaveLength(3);
    expect((await proactiveRuns(anna.id, w.g)).map((r) => r.covers)).toEqual([asked, next]);
    expect(lines.filter((l) => l.reason === "already_decided")).toEqual([
      { level: "debug", metric: "proactive_skipped", reason: "already_decided", agentId: anna.id, conversationId: w.g },
    ]);
  });

  it("its proactive run counts in its owner's others' minute", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    const carl = await agentOf(w.owner, "carl_bot", w.g, { proactive: false });
    const limit = app.deps.config.agentOthersRunsPerMinute;
    await db.query(
      `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, created_at, finished_at, lane)
       select 'reply', $1, $2, $3, 'done', 0, now() - interval '30 seconds', now() - interval '29 seconds', 'others' from generate_series(1, $4::int)`,
      [anna.conversationId, anna.id, w.owner.id, limit - 1],
    );
    judge.answer(byName({ anna: 0.9 }));
    expect((await decide(w.g, await say(w.member, w.g, "问一下"))).runs).toHaveLength(1);
    // The minute is full now: a member's mention of the owner's other Agent is refused by it.
    await say(w.member, w.g, "@carl_bot 你呢");
    expect((await runsOf(carl.id, w.g)).map((r) => r.error)).toEqual(["rate_limited"]);
  });
});

/** Every level's threshold at 0.4: two Agents' pick probabilities, which sum to about 1, may both pass it. */
const lowBase = (): Partial<Config> => ({ proactive: { ...app.deps.config.proactive, base: { less: 0.4, normal: 0.4, more: 0.4 } } });

describe.each([false, true])("a winner that cannot speak now: nobody replies, not the runner-up, and the reason is logged (memory %s)", (memory) => {
  beforeEach(() => {
    memoryOn = memory;
  });

  const runAt = (conv: string, agentId: string, ownerId: string, lane: string, ago: string, n = 1) =>
    db.query(
      `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, created_at, finished_at, lane)
       select 'reply', $1, $2, $3, 'done', 0, now() - $5::interval, now() - $5::interval, $4 from generate_series(1, $6::int)`,
      [conv, agentId, ownerId, lane, ago, n],
    );
  type Agent = { id: string; conversationId: string };
  it.each<[string, string, (w: World, anna: Agent) => Promise<unknown>]>([
    ["a reply of it active in the group", "active_run", (w) => say(w.member, w.g, "@anna 你好")],
    ["a proactive reply of it in the group in the last 10 s", "fuse", (w, anna) => runAt(w.g, anna.id, w.owner.id, "proactive", "5 seconds")],
    ["30 proactive replies of it in the group in the last hour", "fuse", (w, anna) => runAt(w.g, anna.id, w.owner.id, "proactive", "30 minutes", 30)],
    ["its owner's others' minute full", "owner_minute", (w, anna) => runAt(anna.conversationId, anna.id, w.owner.id, "others", "30 seconds", app.deps.config.agentOthersRunsPerMinute)],
  ])("%s", async (_what, reason, before) => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    const bob = await agentOf(w.member, "bob_bot", w.g);
    await before(w, anna);
    const proactiveBefore = (await proactiveRuns(anna.id, w.g)).length;
    // bob_bot's 0.45 would pass too.
    judge.answer(byName({ anna: 0.55, bob_bot: 0.45 }));
    const asked = await say(w.third, w.g, "有人懂吗？");
    expect(await decide(w.g, asked, lowBase())).toEqual(noneTriggered());
    expect((await proactiveRuns(anna.id, w.g)).length).toBe(proactiveBefore);
    expect(await runsOf(bob.id, w.g)).toEqual([]);
    expect(skipped()).toEqual([{ metric: "proactive_skipped", reason, agentId: anna.id, conversationId: w.g }]);
    expect((await stateOf(anna.id, w.g)).surcharge).toBe(0);
  });
});

describe.each([false, true])("a proactive budget that cannot hold a reply (memory %s)", (memory) => {
  beforeEach(() => {
    memoryOn = memory;
  });

  const rowsIn = async (conv: string) => (await db.query("select count(*)::int as n from agent_runs where conversation_id = $1", [conv])).rows[0].n as number;
  /** Whether the judge was shown Agent `name` as an option in any call since `from` (an option's description starts with its name). */
  const optionIn = (from: number, name: string) => judge.calls.slice(from).some((c) => JSON.stringify(c.questions).includes(`${name}：`));
  const setBudget = (agentId: string, micro: bigint) => db.query("update agents set proactive_budget_micro = $2 where principal_id = $1", [agentId, micro.toString()]);
  const floorOf = async (w: World, agentId: string) => {
    const row = (await readOwnedAgent(db, w.owner.id, agentId))!;
    return proactivePlainFloor(db, app.deps.config as never, row, w.g, new Date());
  };

  it("asks the numbers admission asks (holds counted), before the judgement: no judge call (memory off), the Agent no option, no run row", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    // A point of budget, and a running reply of the Agent in another conversation holding all of it: nothing it can hold fits.
    expect((await api(app, w.owner, "PATCH", `/api/agents/${anna.id}`, { proactiveBudget: "1" })).status).toBe(200);
    await db.query(
      `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, started_at, source, model, charge_to, hold_micro, money_rule, lane)
       values ('reply', $1, $2, $3, 'running', 0, now(), 'site', 'fast', 'balance', 1000000, 1, 'proactive')`,
      [anna.conversationId, anna.id, w.owner.id],
    );
    const calls = judge.calls.length;
    const rowsBefore = await rowsIn(w.g);
    const asked = await say(w.third, w.g, "有人懂吗？");
    expect(await decide(w.g, asked, lowBase())).toEqual(noneTriggered());
    // With memory on the judge may still be asked to listen for notes (its own call); anna is not an option in it.
    if (!memory) expect(judge.calls.length).toBe(calls);
    expect(optionIn(calls, "anna")).toBe(false);
    expect(await rowsIn(w.g)).toBe(rowsBefore);
  });

  it("a paid-tier Agent at the default 20 points: its floor (output 12 points and the tool-less system text) passes 20 or not as the text weighs, and a budget just under the floor never reaches the judge while one just over proceeds", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g, { model: { source: "site", id: "paid3" } });
    const floor = await floorOf(w, anna.id);
    // The output alone is 15 000 x 800 = 12 points; the floor adds the system text as `begin` builds it without the conversation.
    expect(floor).toBeGreaterThan(12_000_000n);
    expect(floor).toBeLessThan(40_000_000n);

    // Just under the floor: nothing it holds can fit — no judgement, no run.
    await setBudget(anna.id, floor - 1n);
    const calls = judge.calls.length;
    const rowsBefore = await rowsIn(w.g);
    const asked = await say(w.third, w.g, "有人懂吗？");
    expect(await decide(w.g, asked, lowBase())).toEqual(noneTriggered());
    if (!memory) expect(judge.calls.length).toBe(calls);
    expect(optionIn(calls, "anna")).toBe(false);
    expect(await rowsIn(w.g)).toBe(rowsBefore);

    // Just over: the floor fits, so the judgement is asked and the pick is queued (admission, with the whole hold, decides after).
    await setBudget(anna.id, floor + 1n);
    judge.answer(byName({ anna: 0.9 }));
    const again = await say(w.third, w.g, "有人知道吗？");
    expect((await decide(w.g, again, lowBase())).runs).toHaveLength(1);
    expect(optionIn(calls, "anna")).toBe(true);
  });

  it("the locked check catches what changes while the judgement is out: a hold that appears makes the pick `budget` and no run", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    expect((await api(app, w.owner, "PATCH", `/api/agents/${anna.id}`, { proactiveBudget: "1" })).status).toBe(200);
    judge.answer(byName({ anna: 0.9 }));
    const asked = await say(w.third, w.g, "今晚吃什么？");
    const rowsBefore = await rowsIn(w.g);
    const hold = () =>
      db.query(
        `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, started_at, source, model, charge_to, hold_micro, money_rule, lane)
         values ('reply', $1, $2, $3, 'running', 0, now(), 'site', 'fast', 'balance', 1000000, 1, 'proactive')`,
        [anna.conversationId, anna.id, w.owner.id],
      );
    expect(await decide(w.g, asked, lowBase(), judgeAfter(hold))).toEqual(noneTriggered());
    expect(judge.calls.length).toBeGreaterThan(0);
    expect(await rowsIn(w.g)).toBe(rowsBefore);
    expect(skipped()).toEqual([{ metric: "proactive_skipped", reason: "budget", agentId: anna.id, conversationId: w.g }]);
  });
});

// --- between the reads and the decision ---------------------------------------------------------------------------------

describe.each([false, true])("what happens while the judgement is out (memory %s)", (memory) => {
  beforeEach(() => {
    memoryOn = memory;
  });

  it.each<[string, (w: World, annaId: string) => Promise<unknown>]>([
    ["an Agent posts", (w, annaId) => agentSays(annaId, w.g, "我先说")],
    ["another person speaks", (w) => say(w.third, w.g, "我也想知道")],
    ["a member halts Agents", (w) => api(app, w.third, "POST", `/api/conversations/${w.g}/agents/halt`)],
  ])("%s: nothing is done, not even what the quiet answers say", async (_what, meanwhile) => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    await agentSays(anna.id, w.g, "我在");
    judge.answer(byName({ anna: 0.9 }, { anna: 0.95 }));
    const asked = await say(w.member, w.g, "anna 别说了，不过今晚吃什么？");
    expect(await decide(w.g, asked, {}, judgeAfter(() => meanwhile(w, anna.id)))).toEqual(noneTriggered());
    expect(await proactiveRuns(anna.id, w.g)).toEqual([]);
    expect(await stateOf(anna.id, w.g)).toEqual(UNTOUCHED);
    expect(await noticesOf(w.g)).toEqual([]);
  });

  it("a notice meanwhile changes nothing: the decision is made", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    judge.answer(byName({ anna: 0.9 }));
    const asked = await say(w.member, w.g, "今晚吃什么？");
    const rename = () => api(app, w.owner, "PATCH", `/api/conversations/${w.g}`, { title: "饭搭子" });
    expect((await decide(w.g, asked, {}, judgeAfter(rename))).runs).toHaveLength(1);
    expect((await proactiveRuns(anna.id, w.g)).length).toBe(1);
  });

  it("the winner turned off meanwhile: nobody replies", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    const bob = await agentOf(w.member, "bob_bot", w.g);
    judge.answer(byName({ anna: 0.55, bob_bot: 0.45 }));
    const asked = await say(w.third, w.g, "有人懂吗？");
    const off = () => api(app, w.owner, "PATCH", `/api/agents/${anna.id}`, { proactive: false });
    expect(await decide(w.g, asked, lowBase(), judgeAfter(off))).toEqual(noneTriggered());
    expect(judge.calls).toHaveLength(1);
    expect([await runsOf(anna.id, w.g), await runsOf(bob.id, w.g)]).toEqual([[], []]);
  });

  it("the winner no longer found meanwhile: it is no option, and the rest of the decision stands", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    const bob = await agentOf(w.member, "bob_bot", w.g);
    await agentSays(bob.id, w.g, "我说两句");
    judge.answer(byName({ anna: 0.9 }, { bob_bot: 0.95 }));
    const asked = await say(w.third, w.g, "bob 别说了；有人会做饭吗？");
    // `lockAgent` finds no such Agent once its row is gone (it reads the Agent through its own conversation).
    const gone = () => db.query("delete from agent_conversations where agent_id = $1", [anna.id]);
    const triggered = await decide(w.g, asked, {}, judgeAfter(gone));
    expect(triggered.runs).toEqual([]);
    expect(triggered.notices.map((n) => n.body.agentId)).toEqual([bob.id]);
    expect(await runsOf(anna.id, w.g)).toEqual([]);
  });
});

// --- locks, calls and halts ---------------------------------------------------------------------------------------------

describe.each([false, true])("the rows it locks, and a proactive reply someone asks for or halts before it begins (memory %s)", (memory) => {
  beforeEach(() => {
    memoryOn = memory;
  });

  const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : 1);
  /** Until some session of this database waits for a lock. */
  const someoneWaits = async () => {
    for (let i = 0; i < 100; i++) {
      const { rows } = await db.query<{ n: number }>("select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'");
      if (rows[0]!.n > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("nobody waited for a lock");
  };

  it("its threshold rows are locked in id order before any is written: waiting on one, it holds none another may want", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    const bob = await agentOf(w.member, "bob_bot", w.g);
    const [low, high] = [anna, bob].sort(byId);
    const who = (a: { id: string }) => (a.id === anna.id ? "anna" : "bob_bot");
    // The lower id replies, the higher (which spoke) is asked to be quiet: two rows to write.
    await agentSays(high!.id, w.g, "我先说两句");
    judge.answer(byName({ [who(low!)]: 0.9 }, { [who(high!)]: 0.95 }));
    const asked = await say(w.third, w.g, "别插话了；有人懂吗？");
    const holder = await db.pool.connect();
    try {
      await holder.query("begin");
      await holder.query("set local lock_timeout = '5s'");
      const hold = (id: string) => holder.query("select 1 from agent_group_state where agent_id = $1 and conversation_id = $2 for update", [id, w.g]);
      // Once the call is counted, as the decision begins, another transaction holds the lower id's row …
      const hooked = { query: db.query, tx: async (fn: Parameters<Db["tx"]>[0]) => (await hold(low!.id), db.tx(fn)), pool: db.pool, close: db.close } as unknown as Db;
      const deciding = decideProactive({ db: hooked, judge, config: app.deps.config, log }, w.g, asked);
      await someoneWaits();
      // … and then wants the higher's: the decision, waiting for the lower one, must not hold it (that would deadlock).
      await hold(high!.id);
      await holder.query("commit");
      const triggered = await deciding;
      expect(triggered.runs.map((r) => r.conversationId)).toEqual([w.g]);
      expect((await proactiveRuns(low!.id, w.g)).length).toBe(1);
      expect((await stateOf(high!.id, w.g)).quiet).toBeCloseTo(0.33, 6);
    } finally {
      await holder.query("rollback").catch(() => {});
      holder.release();
    }
  });

  it("a mention folded into its queued run takes it over: a member's makes it others' with that caller, the owner's its own; the surcharge stays", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    judge.answer(byName({ anna: 0.99 }));
    await decide(w.g, await say(w.third, w.g, "今晚吃什么？"));
    const mention = await say(w.member, w.g, "@anna 对，就问你");
    expect(await runsOf(anna.id, w.g)).toEqual([{ status: "queued", error: null, lane: "others", caller: w.member.id, by: "human", covers: mention }]);
    expect((await stateOf(anna.id, w.g)).surcharge).toBeCloseTo(0.1, 6);

    await settleAndAge();
    await decide(w.g, await say(w.third, w.g, "那明天呢？"));
    const own = await say(w.owner, w.g, "@anna 我也想知道");
    expect((await runsOf(anna.id, w.g)).at(-1)).toEqual({ status: "queued", error: null, lane: "own", caller: w.owner.id, by: "human", covers: own });
  });

  it("an Agent's mention folded into its queued run makes it an Agent's call, in the call's lane — and a halt ends it", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    const bob = await agentOf(w.member, "bob_bot", w.g);
    const carl = await agentOf(w.third, "carl_bot", w.g);
    /** Agent `posterId`'s message in the group, handed to the trigger as `postAsAgent` does (`postedBy`: its run's call). */
    const agentCalls = (posterId: string, text: string, postedBy: Caller | null = null) =>
      db.tx(async (t) => {
        const poster = await lockAgent(t, posterId, w.g);
        const message = await insertMessage(t, w.g, posterId, "text", { text }, null, await mentionsAtSend(t, { id: w.g, type: "group" }, text));
        // Posted by no run here: whose question it carries is not known (null, the safe side; Task 10b).
        await triggerFromAgent(t, w.g, message, poster, postedBy, app.deps.config, null);
        return message.seq;
      });
    judge.answer(byName({ anna: 0.9 }));
    await decide(w.g, await say(w.third, w.g, "今晚吃什么？"));
    // bob's own message (its owner, member, behind it) calls anna: others', member's, an Agent's.
    const byBob = await agentCalls(bob.id, "@anna 你来答");
    expect(await runsOf(anna.id, w.g)).toEqual([{ status: "queued", error: null, lane: "others", caller: w.member.id, by: "agent", covers: byBob }]);
    // What a reply nobody called for relays: others', nobody's, an Agent's.
    judge.answer(byName({ carl_bot: 0.9 }));
    await decide(w.g, await say(w.member, w.g, "明天去哪儿？"));
    const relayed = await agentCalls(bob.id, "@carl_bot 你说", { id: null, lane: "proactive" });
    expect(await runsOf(carl.id, w.g)).toEqual([{ status: "queued", error: null, lane: "others", caller: null, by: "agent", covers: relayed }]);

    expect((await api(app, w.third, "POST", `/api/conversations/${w.g}/agents/halt`)).status).toBe(200);
    for (const agent of [anna, carl]) expect((await runsOf(agent.id, w.g)).map((r) => [r.status, r.error])).toEqual([["cancelled", "halted"]]);
  });

  it("a halt cancels a queued proactive run and interrupts a running one, and leaves one a mention took over", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    const bob = await agentOf(w.member, "bob_bot", w.g);
    const carl = await agentOf(w.third, "carl_bot", w.g);
    judge.answer(byName({ anna: 0.9 }));
    await decide(w.g, await say(w.member, w.g, "做饭的问题"));
    judge.answer(byName({ bob_bot: 0.9 }));
    await decide(w.g, await say(w.member, w.g, "旅行的问题"));
    await db.query("update agent_runs set status = 'running', started_at = now() where agent_id = $1", [bob.id]);
    judge.answer(byName({ carl_bot: 0.9 }));
    await decide(w.g, await say(w.member, w.g, "第三个问题"));
    await say(w.owner, w.g, "@carl_bot 就你了");
    const ends = async (agentId: string) =>
      (await db.query("select status, error, interrupted, lane from agent_runs where agent_id = $1 and conversation_id = $2", [agentId, w.g])).rows;
    expect([await ends(anna.id), await ends(bob.id), await ends(carl.id)]).toEqual([
      [{ status: "queued", error: null, interrupted: null, lane: "proactive" }],
      [{ status: "running", error: null, interrupted: null, lane: "proactive" }],
      [{ status: "queued", error: null, interrupted: null, lane: "others" }],
    ]);
    expect((await api(app, w.third, "POST", `/api/conversations/${w.g}/agents/halt`)).status).toBe(200);
    expect([await ends(anna.id), await ends(bob.id), await ends(carl.id)]).toEqual([
      [{ status: "cancelled", error: "halted", interrupted: null, lane: "proactive" }],
      [{ status: "running", error: null, interrupted: "halted", lane: "proactive" }],
      [{ status: "queued", error: null, interrupted: null, lane: "others" }],
    ]);
  });
});

// --- what others see ---------------------------------------------------------------------------------------------------------

describe("what reaches anyone", () => {
  /** Every key anywhere in `value`. */
  const keysIn = (value: unknown, into = new Set<string>()): Set<string> => {
    if (Array.isArray(value)) for (const v of value) keysIn(v, into);
    else if (value && typeof value === "object")
      for (const [k, v] of Object.entries(value)) {
        into.add(k);
        keysIn(v, into);
      }
    return into;
  };
  const HIDDEN_KEYS = ["proactive", "proactiveLevel", "proactiveBudget", "proactiveSpentToday", "memory", "memoryAsk", "sharedNotes", "newNotes", "memoryModel", "memoryModelUsable", "modelUsable", "memoryLanguage", "lane", "callerId", "caller", "quiet", "surcharge", "judgedAt", "probability", "probabilities", "threshold", "whisper", "whispers", "afterSeq", "queries", "tools", "askerIds", "asker_ids", "askers", "callSeqs", "call_seqs", "sourceLines", "whisperElsewhere", "webSearch", "webSearches", "whisperId", "whisper_id", "handleChangeAvailableAt", "asksAgent", "asks_agent", "canStartFreeReply", "heldBackBy", "held_back_by", "stopAsked", "stop_asked", "revision", "lastTellFailed", "openUntil", "retryableUntil", "shownNotes", "withheld", "shown_notes", "withheld_notes", "othersLimit", "othersUsedToday", "proactivePoints", "proactiveAnswers", "canReply", "byPerson", "perDay", "contactPolicy", "contactPicked", "picks", "audienceId", "noteId", "ownerShare", "judgeShare", "card", "endReason", "end_reason", "operatorDisabled"];

  it("no frame and no view of another member names proactive replies, lanes, callers, thresholds or probabilities; the log only ids and reasons", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    const memberSocket = await connect(app, w.member);
    const thirdSocket = await connect(app, w.third);
    judge.answer(byName({ anna: 0.9 }));
    const replied = await decide(w.g, await say(w.member, w.g, "今晚做什么菜？"));
    expect(replied.runs).toHaveLength(1);
    publish(replied);
    await memberSocket.waitFor((e) => e.type === "run" && e.conversationId === w.g);
    await settleAndAge();
    await agentSays(anna.id, w.g, "番茄炒蛋");
    judge.answer(byName({ nobody: 0.95 }, { anna: 0.95 }));
    const quieted = await decide(w.g, await say(w.third, w.g, "anna 你先别插话了"));
    expect(quieted.notices).toHaveLength(1);
    publish(quieted);
    for (const s of [memberSocket, thirdSocket]) await s.waitFor((e) => e.type === "message" && e.message.system?.event === "agent_quieted");
    judge.answer(byName({ anna: 0.9 }, { anna: 0.5 }));
    publish(await decide(w.g, await say(w.member, w.g, "这机器人话有点多啊")));
    // A whisper of the owner's about anna there (src/whispers/), pushed to them: theirs alone.
    const told = await db.tx((t) => createWhisper(t, { conversationId: w.g, ownerId: w.owner.id, agentId: anna.id, kind: "tools_off", body: { text: "这一轮没有用工具", actions: ["dismiss"] } }));
    app.realtime.pushWhisper(told!);

    const bodies: Array<[string, unknown]> = [];
    for (const who of [w.member, w.third]) {
      for (const url of ["/api/sync", `/api/conversations/${w.g}`, `/api/conversations/${w.g}/members`, `/api/conversations/${w.g}/messages`, `/api/conversations/${w.g}/runs`]) {
        const res = await api(app, who, "GET", url);
        expect([url, res.status]).toEqual([url, 200]);
        bodies.push([`${who.handle} ${url}`, res.json]);
      }
    }
    for (const s of [memberSocket, thirdSocket]) s.events.forEach((e: Push, i) => bodies.push([`frame ${i}`, e]));
    expect(bodies.some(([, b]) => JSON.stringify(b).includes("暂时不主动发言"))).toBe(true);
    for (const [label, body] of bodies) {
      const keys = keysIn(body);
      expect([label, HIDDEN_KEYS.filter((k) => keys.has(k))]).toEqual([label, []]);
      expect([label, JSON.stringify(body).includes("proactive")]).toEqual([label, false]);
    }
    // The log: ids and reasons, at info no names, texts or numbers.
    for (const line of lines.filter((l) => l.level !== "debug")) {
      expect(Object.keys(line).every((k) => ["level", "metric", "reason", "agentId", "conversationId"].includes(k))).toBe(true);
    }
    expect(JSON.stringify(lines)).not.toContain("anna");
  });
});

describe("an Agent whose model is gone (Task R fix round 1)", () => {
  it("is not offered: no judgement is spent on an Agent that cannot reply, and with no other option nothing is asked", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    // Its site model taken out of what the site offers (as removing it from SITE_MODELS and restarting does).
    await db.query("update agents set site_model_id = 'retired_q7' where principal_id = $1", [anna.id]);
    const asked = await say(w.member, w.g, "周末去哪儿玩？");
    expect(await optionsFor(db, w.g, asked, w.member.id, app.deps.config)).toEqual([]);
    await decide(w.g, asked);
    expect(judge.calls).toHaveLength(0);
    // With another that can reply, only that one is offered.
    const bob = await agentOf(w.third, "bob_bot", w.g);
    const again = await say(w.member, w.g, "那吃什么？");
    expect((await optionsFor(db, w.g, again, w.member.id, app.deps.config)).map((o) => o.agentId)).toEqual([bob.id]);
  });
});
