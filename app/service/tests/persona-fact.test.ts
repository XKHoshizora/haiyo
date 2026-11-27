import { readFileSync } from "node:fs";
import type { FastifyBaseLogger } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { siteDay } from "../src/accounts/store.ts";
import type { Db } from "../src/db.ts";
import { JudgeError, type Answer, type Judge, type Question } from "../src/judge/client.ts";
import { PERSONA_ASKED, personaSentences, runPersonaAid, sentenceSpan, type Claimed } from "../src/memory/persona-aid.ts";
import { api, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedJudge } from "./helpers/judge.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { SOCIAL_ON, seedSocial } from "./helpers/social.ts";

// Plan A8b (ring 1a; design §4), v2 of 2026-11-28: the persona aid. A persona is sent whole to a visitor's reply, so each new persona
// version is read once: every sentence of it (the first PERSONA_ASKED) is asked ONE calibrated yes/no question of the judgement model,
// one request each, the state `句子：<sentence>`; a sentence scored at MEMORY.personaFactAt or more is a candidate, and the three highest
// of them get a `persona_fact` card in the Agent's own conversation, for its owner alone, who may move it to 关于我 or leave it. No chat
// model is called.
const JUDGE = {
  model: "jev-1",
  channels: [{ url: "https://judge-a.example.test/v1/systemone", apiKeyEnv: "UPSTREAM_TEST_KEY" }],
  timeoutMs: 500,
  dailyLimit: 20_000,
};
const gateway = scriptedGateway();
const judge = scriptedJudge();
const lines: string[] = [];
const { app, db } = useApp({ env: SITE_ENV, config: { ...SOCIAL_ON, judge: JUDGE }, models: gateway, judge, agentWorker: false, logStream: { write: (l) => void lines.push(l) } });
const FAST = { source: "site", id: "fast" } as const;

/** The question, word for word as calibrated (docs/acceptance/memory/calibration.md, 2026-11-28). */
const QUESTION =
  "这是一个 AI 助手的人格设定里的一句话，由它的主人写给它，可能用任何语言写。一个陌生人读到这句话，会因此知道主人本人或者某个真实的人在现实生活中的一件具体的事（比如在哪工作、住在哪、家里有谁、身体状况、行程安排、钱、感情、经历、信仰、联系方式）。如果这句话只是在说助手自己的身份、称呼、性格、语气、台词、玩笑、和主人的关系或态度，或者只是说主人希望助手怎么回答、怎么称呼，陌生人并不会因此知道主人的任何现实情况，就不算。拿不准的不算。";
const KEY = "persona_fact";

// The three shapes of the owner's report of 2026-11-28: a role that names 主人, a running joke with a sample line that says 主人, an
// attitude to the owner. None tells a stranger anything of the owner's real life.
const ROLE = "你叫小雪，是主人的私人女仆，说话温柔又认真。";
const JOKE = "你和主人有个固定的玩笑：他说累了，你就回一句“主人辛苦啦，女仆这就给您捶背”。";
const ATTITUDE = "你只对主人一个人上心，别人问起他的事一概不答。";
const FACT = "主人住在杭州滨江区，家里养了一只猫。";
const MIXED = "主人在杭州一家医院做护士，你要用轻松的口吻陪她聊天。";
const FACT2 = "主人的妹妹在上海做医生。";
const PERSONA = `你是一个说话简洁的助手。${FACT}遇到不懂的事要直说。${FACT2}`;

/** Answers the persona question by sentence (the state is `句子：<sentence>`); a sentence not named is scored 0.05. */
const scoring =
  (scores: Record<string, number | Error>) =>
  (state: string): Record<string, number> | Error => {
    const given = scores[state.slice("句子：".length)] ?? 0.05;
    return given instanceof Error ? given : { [KEY]: given };
  };
const asked = () => judge.calls.map((c) => c.state.slice("句子：".length));

beforeEach(() => {
  gateway.calls.splice(0);
  judge.calls.splice(0);
  judge.answer(scoring({}));
  lines.length = 0;
});
afterEach(async () => {
  expect(gateway.pending()).toBe(0);
  // The aid asks the judgement model only: no chat model call, ever.
  expect(gateway.calls).toHaveLength(0);
});

let n = 0;
interface Made {
  id: string;
  conversationId: string;
}
async function world(persona = PERSONA) {
  const tag = `${++n}${Math.random().toString(36).slice(2, 5)}`;
  const owner = await signUp(app, `pao${tag}`);
  const agent = (await mustCreateAgent(app, owner, { handle: `pay${tag}`, model: FAST, persona })) as Made;
  return { owner, agent };
}
const aid = async () => app.noteJudge.runOnce();
const cardsOf = async (conv: string) =>
  (await db.query<{ seq: string; body: Record<string, unknown> }>(`select seq::text, body from messages where conversation_id = $1 and kind = 'system' and body ->> 'event' = 'persona_fact' order by seq`, [conv])).rows;
const sentencesOf = async (conv: string) => (await cardsOf(conv)).map((c) => c.body.sentence);
const personaOf = async (agentId: string) =>
  (await db.query<{ persona: string; persona_version: number; persona_checked_version: number }>(`select persona, persona_version, persona_checked_version from agents where principal_id = $1`, [agentId])).rows[0]!;
const answer = (owner: Actor, agentId: string, seq: number | string, move: boolean) => api(app, owner, "POST", `/api/agents/${agentId}/persona-facts/${seq}`, { move });
const patchPersona = (owner: Actor, agentId: string, persona: string) => api(app, owner, "PATCH", `/api/agents/${agentId}`, { persona });
/** Agents of other owners that no test below should be bothered by: stamp everything that is waiting, without a request. */
async function clearBacklog() {
  await db.query(`update agents set persona_checked_version = persona_version`);
}
const today = () => siteDay(new Date(), app.deps.config.siteTimezone);
const setOwnerUsed = (ownerId: string, calls: number) =>
  db.query("insert into memory_judge_usage (owner_id, day, calls) values ($1, $2::date, $3) on conflict (owner_id, day) do update set calls = excluded.calls", [ownerId, today(), calls]);
const setSiteUsed = (calls: number) => db.query("insert into judge_usage (day, calls) values ($1::date, $2) on conflict (day) do update set calls = excluded.calls", [today(), calls]);
const logged = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);

describe("the persona aid's worker", () => {
  it("the owner's three shapes score low and make no card; a fact and a mixed sentence score high and make cards with the exact sentences; one request per sentence, nothing else sent", async () => {
    await clearBacklog();
    const w = await world(`${ROLE}${JOKE}${FACT}${ATTITUDE}${MIXED}`);
    judge.answer(scoring({ [ROLE]: 0.05, [JOKE]: 0.06, [ATTITUDE]: 0.04, [FACT]: 0.87, [MIXED]: 0.8 }));
    expect(await aid()).toBe(5);
    expect(judge.calls).toHaveLength(5);
    for (const [i, s] of [ROLE, JOKE, FACT, ATTITUDE, MIXED].entries()) {
      expect(judge.calls[i]).toEqual({ state: `句子：${s}`, questions: [{ key: KEY, type: "noul", instructions: QUESTION }] });
    }
    const cards = await cardsOf(w.agent.conversationId);
    expect(cards.map((c) => c.body.sentence)).toEqual([FACT, MIXED]);
    expect(cards[0]!.body).toMatchObject({ event: "persona_fact", actorId: w.agent.id, agentId: w.agent.id, personaVersion: 1 });
    const expires = Date.parse(cards[0]!.body.expiresAt as string) - Date.now();
    expect(Math.abs(expires - app.deps.config.others.cardDays * 86_400_000)).toBeLessThan(60_000);
    expect(await personaOf(w.agent.id)).toMatchObject({ persona_version: 1, persona_checked_version: 1 });
    // The line of the read: ids and counts.
    expect(logged().filter((l) => l.metric === "persona_aid").map(({ agentId, cards, answered }) => ({ agentId, cards, answered }))).toEqual([{ agentId: w.agent.id, cards: 2, answered: true }]);
    // The same version is never read again; a new version is, whole.
    expect(await aid()).toBe(0);
    expect((await patchPersona(w.owner, w.agent.id, `${ROLE}${FACT}再加一句新的话。`)).status).toBe(200);
    judge.calls.splice(0);
    expect(await aid()).toBe(3);
    expect(asked()).toEqual([ROLE, FACT, "再加一句新的话。"]);
    // FACT's card still waits: not posted again.
    expect(await sentencesOf(w.agent.conversationId)).toEqual([FACT, MIXED]);
    // Never a word of a persona in the log.
    for (const word of ["杭州", "女仆", "捶背", "上心", "护士"]) expect(lines.join("\n")).not.toContain(word);
  });

  it("a candidate is a score of MEMORY.personaFactAt (0.4) or more: 0.4 is one, 0.39 is not; the number is the setting's", async () => {
    await clearBacklog();
    expect(app.deps.config.memory.personaFactAt).toBe(0.4);
    const w = await world(`${FACT}${FACT2}`);
    judge.answer(scoring({ [FACT]: 0.4, [FACT2]: 0.39 }));
    expect(await aid()).toBe(2);
    expect(await sentencesOf(w.agent.conversationId)).toEqual([FACT]);
    const config = app.deps.config as { memory: typeof app.deps.config.memory };
    const before = config.memory;
    config.memory = { ...before, personaFactAt: 0.3 };
    try {
      const x = await world(`${FACT}${FACT2}`);
      expect(await aid()).toBe(2);
      expect(await sentencesOf(x.agent.conversationId)).toEqual([FACT, FACT2]);
    } finally {
      config.memory = before;
    }
  });

  it("more than three candidates: the three highest, in persona order", async () => {
    await clearBacklog();
    const s = ["一", "二", "三", "四", "五"].map((x) => `主人说过的第${x}件事。`);
    const w = await world(s.join(""));
    judge.answer(scoring({ [s[0]!]: 0.5, [s[1]!]: 0.9, [s[2]!]: 0.6, [s[3]!]: 0.95, [s[4]!]: 0.8 }));
    expect(await aid()).toBe(5);
    expect(await sentencesOf(w.agent.conversationId)).toEqual([s[1], s[3], s[4]]);
  });

  it("a sentence already asked (its card waiting, or answered 不用) is dropped BEFORE the three highest are taken (round 1, A6)", async () => {
    await clearBacklog();
    const s = ["一", "二", "三", "四", "五"].map((x) => `主人说过的第${x}件事。`);
    const w = await world(s.join(""));
    judge.answer(scoring({ [s[0]!]: 0.5, [s[1]!]: 0.9, [s[2]!]: 0.6, [s[3]!]: 0.95, [s[4]!]: 0.8 }));
    await aid();
    const first = await cardsOf(w.agent.conversationId);
    expect(first.map((c) => c.body.sentence)).toEqual([s[1], s[3], s[4]]);
    // 不用 for the fourth sentence; the cards of the second and fifth still wait.
    expect((await answer(w.owner, w.agent.id, Number(first[1]!.seq), false)).status).toBe(200);
    expect((await patchPersona(w.owner, w.agent.id, `${s.join("")}最后再补一句话。`)).status).toBe(200);
    expect(await aid()).toBe(6);
    // The highest three of what was not asked yet: the first and the third, the only ones left.
    expect(await sentencesOf(w.agent.conversationId)).toEqual([s[1], s[3], s[4], s[0], s[2]]);
  });

  it("two workers polling at once ask each sentence once; an Agent with no persona asks nothing", async () => {
    await clearBacklog();
    const w = await world();
    const e = await world("");
    const [a, b] = await Promise.all([aid(), aid()]);
    expect(a + b).toBe(4);
    expect(judge.calls).toHaveLength(4);
    expect((await personaOf(e.agent.id)).persona_version).toBe(0);
    expect((await personaOf(w.agent.id)).persona_checked_version).toBe(1);
  });

  it("a persona with no sentence to ask (each under four characters) makes no request and is read", async () => {
    await clearBacklog();
    const w = await world("你好。早安！嗯。");
    expect(await aid()).toBe(0);
    expect(judge.calls).toHaveLength(0);
    expect(await personaOf(w.agent.id)).toMatchObject({ persona_version: 1, persona_checked_version: 1 });
    expect(await aid()).toBe(0);
  });

  it("personas saved while the switch is off: no request and NOTHING stamped (A-4 review I2); turned on, each is read once", async () => {
    await clearBacklog();
    (app.deps.config as { social: unknown }).social = { enabled: false };
    const w = await world();
    try {
      expect(await aid()).toBe(0);
    } finally {
      (app.deps.config as { social: unknown }).social = { enabled: true };
    }
    expect(await personaOf(w.agent.id)).toMatchObject({ persona_version: 1, persona_checked_version: 0 });
    expect(judge.calls).toHaveLength(0);
    judge.answer(scoring({ [FACT]: 0.9 }));
    expect(await aid()).toBe(4);
    expect(await personaOf(w.agent.id)).toMatchObject({ persona_version: 1, persona_checked_version: 1 });
    expect(await sentencesOf(w.agent.conversationId)).toEqual([FACT]);
    expect(await aid()).toBe(0);
  });

  it("25 owners with a persona of one sentence each: the first poll asks 10, the second 10, the third 5; each is read exactly once (round 1, A7)", async () => {
    await clearBacklog();
    for (let i = 0; i < 25; i++) await world("你好，我是你的助手。");
    const polls = [await aid(), await aid(), await aid(), await aid()];
    expect(polls).toEqual([10, 10, 5, 0]);
    expect(judge.calls).toHaveLength(25);
  });

  it("a poll serves at most OTHERS.judgeOwnersPerPoll owners and one Agent of each: 105 owners, one with two Agents", async () => {
    await clearBacklog();
    const per = app.deps.config.others.judgeOwnersPerPoll;
    expect(per).toBe(10);
    const owners: string[] = [];
    for (let i = 0; i < 105; i++) {
      const h = `pb${i}_${Math.random().toString(36).slice(2, 6)}`;
      await db.query(`insert into "user" (id, name, email, "emailVerified") values ($1::text, $1::text, $1::text || '@example.test', true)`, [`auth-${h}`]);
      const o = await db.query<{ id: string }>(`insert into principals (kind, handle, display_name, auth_user_id) values ('human', $1::citext, $1::text, 'auth-' || $1::text) returning id`, [h]);
      owners.push(o.rows[0]!.id);
    }
    const agentFor = async (owner: string, tag: string) => {
      const p = await db.query<{ id: string }>(`insert into principals (kind, handle, display_name, owner_id) values ('agent', $1::citext, $1::text, $2) returning id`, [`${tag}_${Math.random().toString(36).slice(2, 6)}`, owner]);
      await db.query(`insert into agents (principal_id, persona, persona_version) values ($1, '你好，我是你的助手。', 1)`, [p.rows[0]!.id]);
      return p.rows[0]!.id;
    };
    for (const [i, o] of owners.entries()) await agentFor(o, `pa${i}`);
    await agentFor(owners[0]!, "pasecond");
    // The switch off claims, asks and stamps nothing (A-4 review I2).
    (app.deps.config as { social: unknown }).social = { enabled: false };
    try {
      expect(await aid()).toBe(0);
    } finally {
      (app.deps.config as { social: unknown }).social = { enabled: true };
    }
    const left = async () => Number((await db.query<{ n: string }>(`select count(*)::text as n from agents where persona_version > persona_checked_version`)).rows[0]!.n);
    expect(await left()).toBe(106);
    // With it on, a poll is 10 requests (an owner with two Agents is served one per poll).
    expect(await aid()).toBe(10);
    expect(await left()).toBe(106 - 10);
    await clearBacklog();
  });

  it("a persona of more than PERSONA_ASKED (40) sentences: only the first 40 are asked (round 1, A3)", async () => {
    await clearBacklog();
    expect(PERSONA_ASKED).toBe(40);
    const many = Array.from({ length: 45 }, (_, i) => `这是人格里的第${i + 1}句话。`);
    const w = await world(`${many.join("")}${FACT}`);
    judge.answer(scoring({ [FACT]: 0.9, [many[39]!]: 0.9 }));
    expect(await aid()).toBe(40);
    expect(asked()).toEqual(many.slice(0, 40));
    expect(await sentencesOf(w.agent.conversationId)).toEqual([many[39]]);
  });

  it("a request that fails or times out: that sentence is no candidate, the rest are asked, the version stays read", async () => {
    await clearBacklog();
    const w = await world(`${FACT}${ATTITUDE}${FACT2}`);
    judge.answer(scoring({ [FACT]: new JudgeError("timeout"), [FACT2]: 0.9 }));
    expect(await aid()).toBe(3);
    expect(await sentencesOf(w.agent.conversationId)).toEqual([FACT2]);
    expect(await personaOf(w.agent.id)).toMatchObject({ persona_checked_version: 1 });
  });

  it("refused for a moment (no place among the judgement's calls in flight): the version is given back and read at a later pass", async () => {
    await clearBacklog();
    const w = await world(`${FACT}${FACT2}`);
    judge.answer(scoring({ [FACT]: new JudgeError("busy") }));
    expect(await aid()).toBe(0);
    expect(await personaOf(w.agent.id)).toMatchObject({ persona_version: 1, persona_checked_version: 0 });
    expect(await cardsOf(w.agent.conversationId)).toEqual([]);
    judge.answer(scoring({ [FACT]: 0.9 }));
    expect(await aid()).toBe(2);
    expect(await personaOf(w.agent.id)).toMatchObject({ persona_checked_version: 1 });
    expect(await sentencesOf(w.agent.conversationId)).toEqual([FACT]);
  });

  it("no judgement model configured: nothing is asked, the version stays read, no card (a help, never a gate)", async () => {
    await clearBacklog();
    const config = app.deps.config as { judge: typeof app.deps.config.judge };
    const before = config.judge;
    config.judge = null;
    try {
      const w = await world();
      expect(await aid()).toBe(0);
      expect(judge.calls).toHaveLength(0);
      expect(await personaOf(w.agent.id)).toMatchObject({ persona_version: 1, persona_checked_version: 1 });
      expect(await cardsOf(w.agent.conversationId)).toEqual([]);
    } finally {
      config.judge = before;
    }
  });

  it("sorting keeps priority: a read that would take the owner past half their judgements of the day is put off — at half or more the owner is not even claimed; under it, given back (round 1, A3)", async () => {
    await clearBacklog();
    const half = app.deps.config.memory.judgePerOwnerDay / 2;
    expect(half).toBe(150);
    const w = await world(`${FACT}${FACT2}`);
    // 149 + 2 sentences > 150: claimed, given back, nothing asked.
    await setOwnerUsed(w.owner.id, 149);
    expect(await aid()).toBe(0);
    expect(await personaOf(w.agent.id)).toMatchObject({ persona_version: 1, persona_checked_version: 0 });
    // At 150 the owner is not claimed at all: nothing is stamped, so no poll is spent on them.
    await setOwnerUsed(w.owner.id, 150);
    const other = await world(FACT2);
    judge.answer(scoring({ [FACT2]: 0.9 }));
    expect(await aid()).toBe(1);
    expect(asked()).toEqual([FACT2]);
    expect(await personaOf(w.agent.id)).toMatchObject({ persona_checked_version: 0 });
    expect(await sentencesOf(other.agent.conversationId)).toEqual([FACT2]);
    // 148 + 2 = 150: asked.
    await setOwnerUsed(w.owner.id, 148);
    judge.calls.splice(0);
    expect(await aid()).toBe(2);
    expect(await personaOf(w.agent.id)).toMatchObject({ persona_checked_version: 1 });
    expect(await sentencesOf(w.agent.conversationId)).toEqual([FACT2]);
  });

  it("half of an odd judgePerOwnerDay is a fraction: 5 a day puts off a one-sentence read at 2 used, asks it at 1", async () => {
    await clearBacklog();
    const config = app.deps.config as { memory: typeof app.deps.config.memory };
    const before = config.memory;
    config.memory = { ...before, judgePerOwnerDay: 5 };
    try {
      const w = await world(FACT);
      await setOwnerUsed(w.owner.id, 2);
      expect(await aid()).toBe(0);
      expect(await personaOf(w.agent.id)).toMatchObject({ persona_checked_version: 0 });
      await setOwnerUsed(w.owner.id, 1);
      expect(await aid()).toBe(1);
      expect(await personaOf(w.agent.id)).toMatchObject({ persona_checked_version: 1 });
    } finally {
      config.memory = before;
    }
  });

  it("sorting keeps priority site-wide: past half of memory's share of the site's day a read is put off; at half or more nothing is claimed", async () => {
    await clearBacklog();
    // judgeShare 0.5 of dailyLimit 20 000: memory stops at 10 000, the persona aid at half of that.
    const half = (app.deps.config.memory.judgeShare * JUDGE.dailyLimit) / 2;
    expect(half).toBe(5000);
    const w = await world(`${FACT}${FACT2}`);
    await setSiteUsed(half - 1);
    expect(await aid()).toBe(0);
    expect(await personaOf(w.agent.id)).toMatchObject({ persona_checked_version: 0 });
    await setSiteUsed(half);
    expect(await aid()).toBe(0);
    expect(await personaOf(w.agent.id)).toMatchObject({ persona_checked_version: 0 });
    expect(judge.calls).toHaveLength(0);
    await setSiteUsed(half - 2);
    expect(await aid()).toBe(2);
    expect(await personaOf(w.agent.id)).toMatchObject({ persona_checked_version: 1 });
  });

  it("the memory chat model and its allowance play no part: a spent memory allowance still reads the persona", async () => {
    await clearBacklog();
    const w = await world();
    await db.query(
      "insert into memory_usage (owner_id, day, used_micro) values ($1, (now() at time zone 'Asia/Shanghai')::date, 900000000000) on conflict (owner_id, day) do update set used_micro = excluded.used_micro",
      [w.owner.id],
    );
    judge.answer(scoring({ [FACT]: 0.9 }));
    expect(await aid()).toBe(4);
    expect(await sentencesOf(w.agent.conversationId)).toEqual([FACT]);
  });

  it("never sends vault text to the judgement model, and never reveals a held-back fact to a visitor", async () => {
    await clearBacklog();
    const w = await world();
    const VAULT = "VAULT-CANARY 主人的银行卡尾号 8888";
    await db.query(`insert into owner_notes (owner_id, text, vault, vault_by, unsure, origin) values ($1, $2, true, 'auto', false, 'owner')`, [w.owner.id, VAULT]);
    judge.answer(scoring({ [FACT]: 0.9 }));
    await aid();
    expect(JSON.stringify(judge.calls)).not.toContain("VAULT-CANARY");
    // The card is the owner's alone: a visitor in a social conversation with the Agent is told nothing of it.
    const visitor = await signUp(app, `pavisitor${n}`);
    const { conversationId } = await seedSocial(app, { owner: w.owner, agentId: w.agent.id, visitor });
    const keys = JSON.stringify(await Promise.all([api(app, visitor, "GET", "/api/sync"), api(app, visitor, "GET", `/api/conversations/${conversationId}/messages`)].map((p) => p.then((r) => r.json))));
    expect(keys).not.toContain("persona_fact");
    expect(keys).not.toContain("杭州");
    expect(keys).not.toContain('"card"');
    expect((await api(app, visitor, "GET", `/api/conversations/${w.agent.conversationId}/messages`)).status).toBe(404);
    expect((await api(app, visitor, "POST", `/api/agents/${w.agent.id}/persona-facts/1`, { move: true })).status).toBe(404);
  });
});

describe("why there is no answer, and what the aid does with it (round 1, A2)", () => {
  const silent = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} } as unknown as FastifyBaseLogger;
  /** The Agent as the worker claims it: its version stamped as read (memory/judge.ts `claim`). */
  async function claimed(persona = `${FACT}${ATTITUDE}${FACT2}`): Promise<{ agent: Claimed; conversationId: string }> {
    await clearBacklog();
    const w = await world(persona);
    await db.query("update agents set persona_checked_version = persona_version where principal_id = $1", [w.agent.id]);
    const p = await personaOf(w.agent.id);
    return { agent: { id: w.agent.id, ownerId: w.owner.id, persona: p.persona, personaVersion: p.persona_version }, conversationId: w.agent.conversationId };
  }
  const run = (j: Judge | null, agent: Claimed, closing: AbortSignal = new AbortController().signal, over: { db?: Db } = {}) =>
    runPersonaAid({ db, config: app.deps.config, judge: j, conversations: app.deps.conversations, log: silent, ...over }, agent, closing);
  const stamp = async (agent: Claimed) => (await personaOf(agent.id)).persona_checked_version;
  /** A judge that answers every question it is asked with `p`, after `before` (its `n`-th call: 1, 2, …). */
  const answering = (p: (state: string) => number, before: (call: number) => Promise<void> = async () => {}): Judge & { calls: number } => {
    const j = {
      calls: 0,
      async ask(state: string, questions: readonly Question[]) {
        j.calls++;
        await before(j.calls);
        return new Map<string, Answer>(questions.map((q) => [q.key, { type: "noul", p: p(state) }]));
      },
    };
    return j;
  };
  const high = (sentence: string) => (state: string) => (state === `句子：${sentence}` ? 0.9 : 0.05);
  /** `db`, with the `n`-th statement matching `when` and every later one failing. */
  const failingFrom = (when: RegExp, from: number): Db => {
    let seen = 0;
    return new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "query") return Reflect.get(target, prop, receiver);
        return (sql: string, ...rest: unknown[]) =>
          when.test(sql) && ++seen >= from ? Promise.reject(new Error("db hiccup")) : (target.query as (...a: unknown[]) => unknown)(sql, ...rest);
      },
    });
  };

  it("given back for a later pass: the service stopping (before or while asking), the allowance unreadable (before or while asking), a moment's refusal", async () => {
    const closed = new AbortController();
    closed.abort();
    const a = await claimed();
    expect(await run(answering(() => 0.9), a.agent, closed.signal)).toBe(0);
    expect(await stamp(a.agent)).toBe(0);

    const b = await claimed();
    const stopping = new AbortController();
    const hangs: Judge = { ask: (_s, _q, signal) => new Promise((_, reject) => signal!.addEventListener("abort", () => reject(signal!.reason))) };
    setTimeout(() => stopping.abort(), 20);
    expect(await run(hangs, b.agent, stopping.signal)).toBe(1);
    expect(await stamp(b.agent)).toBe(0);

    for (const from of [1, 2]) {
      const c = await claimed();
      const j = answering(() => 0.9);
      expect(await run(j, c.agent, undefined, { db: failingFrom(/^\s*select calls from memory_judge_usage/, from) })).toBe(0);
      expect([from, j.calls, await stamp(c.agent)]).toEqual([from, 0, 0]);
    }

    const d = await claimed();
    expect(await run({ ask: async () => Promise.reject(new JudgeError("busy")) }, d.agent)).toBe(0);
    expect(await stamp(d.agent)).toBe(0);
    for (const x of [a, b, d]) expect(await cardsOf(x.conversationId)).toEqual([]);
  });

  it("kept as read: no judge; the owner's or the site's day used up while asking (what was answered still counts, nothing more is asked); a failed request", async () => {
    const a = await claimed();
    expect(await run(null, a.agent)).toBe(0);
    expect(await stamp(a.agent)).toBe(1);

    // The owner's other memory checks use up the day while the first sentence is asked: the second is not asked.
    const b = await claimed(`${ATTITUDE}${FACT}`);
    const owner = answering(high(FACT), async (call) => void (call === 1 && (await setOwnerUsed(b.agent.ownerId, app.deps.config.memory.judgePerOwnerDay))));
    expect(await run(owner, b.agent)).toBe(1);
    expect([owner.calls, await stamp(b.agent)]).toEqual([1, 1]);
    expect(await cardsOf(b.conversationId)).toEqual([]);

    // The site's: what was answered before still makes its card.
    const c = await claimed(`${FACT}${ATTITUDE}${FACT2}`);
    const site = answering(high(FACT), async (call) => void (call === 1 && (await setSiteUsed(app.deps.config.memory.judgeShare * JUDGE.dailyLimit))));
    expect(await run(site, c.agent)).toBe(1);
    expect([site.calls, await stamp(c.agent)]).toEqual([1, 1]);
    expect(await sentencesOf(c.conversationId)).toEqual([FACT]);
    await setSiteUsed(0);

    const d = await claimed(`${FACT}${FACT2}`);
    let calls = 0;
    const flaky: Judge = {
      ask: async (state, questions) => {
        if (++calls === 1) throw new JudgeError("network");
        return new Map(questions.map((q) => [q.key, { type: "noul", p: high(FACT2)(state) }]));
      },
    };
    expect(await run(flaky, d.agent)).toBe(2);
    expect(await stamp(d.agent)).toBe(1);
    expect(await sentencesOf(d.conversationId)).toEqual([FACT2]);
  });

  it("a persona saved while the questions are out: no card is written for the old version (the newer is read on its own)", async () => {
    const a = await claimed();
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const held = answering(high(FACT), async () => gate);
    const running = run(held, a.agent);
    while (held.calls === 0) await new Promise((r) => setTimeout(r, 5));
    // The owner's save, as PATCH makes it: a new version.
    await db.query("update agents set persona = $2, persona_version = persona_version + 1 where principal_id = $1", [a.agent.id, `新的人格。${FACT2}`]);
    open();
    expect(await running).toBe(3);
    expect(await cardsOf(a.conversationId)).toEqual([]);
    judge.answer(scoring({ [FACT2]: 0.9 }));
    expect(await aid()).toBe(2);
    expect(await sentencesOf(a.conversationId)).toEqual([FACT2]);
  });
});

describe("the sentences that are asked (round 1, A4, A5)", () => {
  const texts = (persona: string) => personaSentences(persona).map((s) => s.text);

  it("whole sentences of the persona, each with its own end mark, each once, in order; under four characters none; leading spaces left out", () => {
    expect(texts(PERSONA)).toEqual(["你是一个说话简洁的助手。", FACT, "遇到不懂的事要直说。", FACT2]);
    expect(texts("主人住在杭州。\r\n他养了一只猫。")).toEqual(["主人住在杭州。", "他养了一只猫。"]);
    expect(texts("Owner lives here  \r\nNext line is here")).toEqual(["Owner lives here  \r\n", "Next line is here"]);
    expect(texts("主人住在杭州")).toEqual(["主人住在杭州"]);
    expect(texts("主人住在杭州。主人住在杭州。他养了一只猫。")).toEqual(["主人住在杭州。", "他养了一只猫。"]);
    expect(texts("- 主人住在杭州\n- 他养了一只猫\n")).toEqual(["- 主人住在杭州\n", "- 他养了一只猫\n"]);
    expect(texts("　　主人住在杭州。  \t他养猫很多年了。")).toEqual(["主人住在杭州。", "他养猫很多年了。"]);
    expect(texts("你好。主人：\n住在杭州。")).toEqual(["住在杭州。"]);
    // The same words with and without the line break that ends them are one sentence: the first.
    expect(texts("主人住在杭州\n其他的一句话。\n主人住在杭州")).toEqual(["主人住在杭州\n", "其他的一句话。"]);
    expect(texts("")).toEqual([]);
    expect(texts("\n\n。；!?")).toEqual([]);
  });

  it("a span of more than 200 characters is not asked: an English paragraph is one span (an ASCII full stop ends none)", () => {
    const paragraph = Array.from({ length: 12 }, (_, i) => `The owner said thing number ${i}.`).join(" ");
    expect([...paragraph].length).toBeGreaterThan(200);
    expect(texts(`${paragraph}\n主人住在杭州。`)).toEqual(["主人住在杭州。"]);
    const exactly = `${"字".repeat(199)}。`;
    expect(texts(`${exactly}${"字".repeat(200)}。`)).toEqual([exactly]);
  });

  it("property: every span is the one sentenceSpan finds for its text, so a card's sentence can always be moved (CRLF, trailing spaces, no final mark, repeats, bullets)", () => {
    // mulberry32, a fixed seed: the same 400 personas every run.
    let seed = 7;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
    const words = ["主人住在杭州", "他养了一只猫", "你是一个助手", "Owner lives in Lima", "オーナーは東京に住んでいる", "好", "嗯嗯", "abc", "主人", "你要温柔"];
    const ends = ["。", "！", "？", "!", "?", "；", ";", "\n", "\r\n", "  \n", " \r\n", "", "。 ", "\t。"];
    const leads = ["", "", " ", "\t", "　", "- ", "• ", "1. "];
    for (let k = 0; k < 400; k++) {
      const parts: string[] = [];
      const count = 1 + Math.floor(rand() * 8);
      for (let i = 0; i < count; i++) parts.push(`${pick(leads)}${rand() < 0.3 && parts.length > 0 ? parts[0]!.trim() : pick(words)}${pick(ends)}`);
      const persona = parts.join("");
      const got = personaSentences(persona);
      const seen = new Set<string>();
      let last = -1;
      for (const s of got) {
        expect([persona, s.text]).toEqual([persona, persona.slice(s.start, s.end)]);
        expect([persona, sentenceSpan(persona, s.text)]).toEqual([persona, { start: s.start, end: s.end }]);
        expect(seen.has(s.text)).toBe(false);
        seen.add(s.text);
        expect(s.start).toBeGreaterThan(last);
        last = s.end - 1;
        expect([...s.text].length).toBeLessThanOrEqual(200);
      }
    }
  });
});

describe("the card and its answer", () => {
  /** An owner whose persona has been read once and made one card at `seq`. */
  async function carded() {
    await clearBacklog();
    const w = await world();
    judge.answer(scoring({ [FACT]: 0.9 }));
    await aid();
    const [card] = await cardsOf(w.agent.conversationId);
    return { ...w, seq: Number(card!.seq) };
  }
  const wireCard = async (owner: Actor, w: { agent: Made; seq: number }) =>
    ((await api(app, owner, "GET", `/api/conversations/${w.agent.conversationId}/messages`)).json.messages as Array<{ seq: number; system?: { card?: unknown } }>).find((m) => m.seq === w.seq);

  it("a sentence the owner answered 不用, or whose card still waits, is not asked again by a later save; an expired one is", async () => {
    await clearBacklog();
    const w = await world();
    judge.answer(scoring({ [FACT]: 0.9, [FACT2]: 0.85 }));
    await aid();
    const [first, second] = await cardsOf(w.agent.conversationId);
    expect((await answer(w.owner, w.agent.id, Number(first!.seq), false)).status).toBe(200);
    // FACT was kept as it is; FACT2's card still waits (unanswered, not expired); a moved sentence is gone from the persona.
    expect(second).toBeTruthy();
    expect((await patchPersona(w.owner, w.agent.id, `${PERSONA}又加一句。`)).status).toBe(200);
    expect(await aid()).toBe(5);
    expect(await sentencesOf(w.agent.conversationId)).toEqual([FACT, FACT2]);
    // An expired card that was never answered is asked again.
    await db.query(`update messages set body = jsonb_set(body, '{expiresAt}', to_jsonb($2::text)) where id = $1`, [(await db.query<{ id: string }>(`select id::text from messages where conversation_id = $1 and seq = $2`, [w.agent.conversationId, Number(second!.seq)])).rows[0]!.id, new Date(Date.now() - 1000).toISOString()]);
    expect((await patchPersona(w.owner, w.agent.id, `${PERSONA}再加一句。`)).status).toBe(200);
    await aid();
    expect(await sentencesOf(w.agent.conversationId)).toEqual([FACT, FACT2, FACT2]);
  });

  it("the owner reads the card with its answer and whether it is over; moving removes exactly that sentence, writes it as a note, and asks nothing new", async () => {
    const w = await carded();
    expect((await wireCard(w.owner, w))!.system).toMatchObject({ event: "persona_fact", sentence: FACT, card: { answer: null, expired: false, sentence: FACT } });
    const moved = await answer(w.owner, w.agent.id, w.seq, true);
    expect([moved.status, moved.json]).toEqual([200, { ok: true, moved: true }]);
    expect(await personaOf(w.agent.id)).toEqual({ persona: PERSONA.replace(FACT, ""), persona_version: 2, persona_checked_version: 2 });
    const notes = (await db.query(`select text, vault from owner_notes where owner_id = $1`, [w.owner.id])).rows;
    expect(notes).toEqual([{ text: FACT, vault: true }]);
    expect((await db.query(`select answer from social_card_answers`)).rows.map((r) => r.answer)).toContain("moved");
    expect((await wireCard(w.owner, w))!.system).toMatchObject({ card: { answer: "moved", expired: false } });
    // Nothing asked for the owner's own edit.
    const before = judge.calls.length;
    expect(await aid()).toBe(0);
    expect(judge.calls).toHaveLength(before);
    // A second answer, either way: 409 answered.
    for (const move of [true, false]) {
      const again = await answer(w.owner, w.agent.id, w.seq, move);
      expect([again.status, again.json.error]).toEqual([409, "answered"]);
    }
    expect((await personaOf(w.agent.id)).persona_version).toBe(2);
  });

  // Lane I (Controller ruling 2026-11-25 (A-5 review), I1): the card must be noticed. It counts as unread for its owner in the Agent's own
  // conversation, as a message would; another notice there does not; answering it does not read it, reading does; and while the site's
  // switch is off (the web then draws no card) it counts nothing.
  it("the card counts as unread for its owner: 1 for the Agent's own conversation, not lowered by the answer, cleared by reading; nothing with the switch off", async () => {
    const w = await carded();
    const unread = async () =>
      ((await api(app, w.owner, "GET", "/api/sync")).json.conversations as Array<{ id: string; unread: number }>).find((c) => c.id === w.agent.conversationId)!.unread;
    const read = (seq: number) => api(app, w.owner, "POST", `/api/conversations/${w.agent.conversationId}/read`, { seq });
    expect(await unread()).toBe(1);
    // Another notice after it (a new topic) is no unread message, as before.
    await db.query(
      `insert into messages (conversation_id, seq, sender_id, kind, body) select $1, max(seq) + 1, $2, 'system', '{"event":"topic_reset"}'::jsonb from messages where conversation_id = $1`,
      [w.agent.conversationId, w.agent.id],
    );
    expect(await unread()).toBe(1);
    const config = app.deps.config as { social: { enabled: boolean } };
    const before = config.social;
    config.social = { enabled: false };
    try {
      expect(await unread()).toBe(0);
    } finally {
      config.social = before;
    }
    expect((await answer(w.owner, w.agent.id, w.seq, false)).status).toBe(200);
    expect(await unread()).toBe(1);
    expect((await read(w.seq)).status).toBe(200);
    expect(await unread()).toBe(0);
  });

  it("not moving keeps the persona as it is and records the answer; an expired card, an unknown seq, another kind of message, and anyone else's: 409 or 404", async () => {
    const w = await carded();
    const kept = await answer(w.owner, w.agent.id, w.seq, false);
    expect([kept.status, kept.json]).toEqual([200, { ok: true, moved: false }]);
    expect(await personaOf(w.agent.id)).toMatchObject({ persona: PERSONA, persona_version: 1 });
    expect((await wireCard(w.owner, w))!.system).toMatchObject({ card: { answer: "kept" } });
    // Expired (without an answer).
    const e = await carded();
    await db.query(`update messages set body = jsonb_set(body, '{expiresAt}', to_jsonb($2::text)) where conversation_id = $1 and body ->> 'event' = 'persona_fact'`, [e.agent.conversationId, new Date(Date.now() - 1000).toISOString()]);
    expect((await wireCard(e.owner, e))!.system).toMatchObject({ card: { answer: null, expired: true } });
    const late = await answer(e.owner, e.agent.id, e.seq, true);
    expect([late.status, late.json.error]).toEqual([409, "expired"]);
    expect(await personaOf(e.agent.id)).toMatchObject({ persona: PERSONA, persona_version: 1 });
    // 404: no such message, a message that is no card, another owner's Agent, another Agent of the owner's.
    expect((await answer(w.owner, w.agent.id, 99999, true)).status).toBe(404);
    const plain = (await db.query<{ seq: string }>(`select seq::text from messages where conversation_id = $1 and kind = 'system' and body ->> 'event' <> 'persona_fact' limit 1`, [w.agent.conversationId])).rows[0];
    if (plain) expect((await answer(w.owner, w.agent.id, plain.seq, true)).status).toBe(404);
    expect((await answer(e.owner, w.agent.id, w.seq, true)).status).toBe(404);
    const second = (await mustCreateAgent(app, w.owner, { handle: `payb${n}` })) as Made;
    expect((await answer(w.owner, second.id, w.seq, true)).status).toBe(404);
    expect((await api(app, w.owner, "POST", `/api/agents/${w.agent.id}/persona-facts/${w.seq}`, { move: "yes" })).status).toBe(400);
  });

  it("a sentence that is no longer in the persona: nothing is changed; the answer is kept and says it did not move", async () => {
    const w = await carded();
    expect((await patchPersona(w.owner, w.agent.id, "完全不同的人格。")).status).toBe(200);
    const r = await answer(w.owner, w.agent.id, w.seq, true);
    expect([r.status, r.json]).toEqual([200, { ok: true, moved: false }]);
    expect(await personaOf(w.agent.id)).toMatchObject({ persona: "完全不同的人格。", persona_version: 2 });
    expect((await db.query(`select 1 from owner_notes where owner_id = $1`, [w.owner.id])).rowCount).toBe(0);
    expect((await wireCard(w.owner, w))!.system).toMatchObject({ card: { answer: "kept" } });
  });

  it("two answers at once make one: the sentence is moved once", async () => {
    const w = await carded();
    const both = await Promise.all([answer(w.owner, w.agent.id, w.seq, true), answer(w.owner, w.agent.id, w.seq, true)]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await db.query(`select 1 from owner_notes where owner_id = $1`, [w.owner.id])).rowCount).toBe(1);
    expect((await personaOf(w.agent.id)).persona).toBe(PERSONA.replace(FACT, ""));
  });

  it("a room that cannot take the note refuses the move and changes nothing; the card can be answered again", async () => {
    const w = await carded();
    const limit = app.deps.config.memory.roomNotes;
    await db.query(`insert into owner_notes (owner_id, text, vault, vault_by, unsure, origin) select $1, 'n' || g, false, 'auto', false, 'owner' from generate_series(1, $2) g`, [w.owner.id, limit]);
    const full = await answer(w.owner, w.agent.id, w.seq, true);
    expect([full.status, full.json.error]).toEqual([409, "room_full"]);
    expect(await personaOf(w.agent.id)).toMatchObject({ persona: PERSONA, persona_version: 1 });
    expect((await db.query(`select 1 from social_card_answers`)).rowCount).toBe(0);
    await db.query(`delete from owner_notes where owner_id = $1`, [w.owner.id]);
    expect((await answer(w.owner, w.agent.id, w.seq, true)).status).toBe(200);
  });
});

describe("the route and the files", () => {
  it("the card's route is in the README under its heading", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toContain("#### `POST /api/agents/:id/persona-facts/:seq`");
    expect(readme).not.toContain("**Planned: `POST /api/agents/:id/persona-facts/:seq`**");
  });
});
