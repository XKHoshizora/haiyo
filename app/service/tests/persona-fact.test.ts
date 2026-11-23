import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { verbatimFacts } from "../src/memory/persona-aid.ts";
import { SOCIAL_ON, seedSocial } from "./helpers/social.ts";

// Plan A8b (ring 1a; design §4): the persona aid. A persona is sent whole to a visitor's reply, so each new persona version is read once
// by one cheap model call for sentences that state a fact about the owner or someone else; each such sentence found verbatim in the
// persona gets a `persona_fact` card in the Agent's own conversation, for its owner alone, who may move it to 关于我 or leave it.
const gateway = scriptedGateway();
const lines: string[] = [];
const { app, db } = useApp({ env: SITE_ENV, config: SOCIAL_ON, models: gateway, agentWorker: false, logStream: { write: (l) => void lines.push(l) } });
const FAST = { source: "site", id: "fast" } as const;
const FACT = "主人住在杭州滨江区，家里养了一只猫。";
const FACT2 = "主人的妹妹在上海做医生。";
const PERSONA = `你是一个说话简洁的助手。${FACT}遇到不懂的事要直说。${FACT2}`;

beforeEach(() => {
  gateway.calls.splice(0);
  lines.length = 0;
});
afterEach(async () => {
  expect(gateway.pending()).toBe(0);
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
const facts = (...f: string[]) => JSON.stringify({ facts: f });
const aid = async () => app.noteJudge.runOnce();
const cardsOf = async (conv: string) =>
  (await db.query<{ seq: string; body: Record<string, unknown> }>(`select seq::text, body from messages where conversation_id = $1 and kind = 'system' and body ->> 'event' = 'persona_fact' order by seq`, [conv])).rows;
const personaOf = async (agentId: string) =>
  (await db.query<{ persona: string; persona_version: number; persona_checked_version: number }>(`select persona, persona_version, persona_checked_version from agents where principal_id = $1`, [agentId])).rows[0]!;
const answer = (owner: Actor, agentId: string, seq: number | string, move: boolean) => api(app, owner, "POST", `/api/agents/${agentId}/persona-facts/${seq}`, { move });
const patchPersona = (owner: Actor, agentId: string, persona: string) => api(app, owner, "PATCH", `/api/agents/${agentId}`, { persona });
/** Agents of other owners that no test below should be bothered by: stamp everything that is waiting, without a call. */
async function clearBacklog() {
  await db.query(`update agents set persona_checked_version = persona_version`);
}

describe("the persona aid's worker", () => {
  it("one call per persona version; only sentences found verbatim in the persona make a card (at most 3, each once), in the Agent's own conversation", async () => {
    await clearBacklog();
    const w = await world();
    gateway.reply(facts(FACT, "不在人格里的一句话。", FACT, FACT2));
    expect(await aid()).toBe(1);
    expect(gateway.calls).toHaveLength(1);
    const cards = await cardsOf(w.agent.conversationId);
    expect(cards.map((c) => c.body.sentence)).toEqual([FACT, FACT2]);
    expect(cards[0]!.body).toMatchObject({ event: "persona_fact", actorId: w.agent.id, agentId: w.agent.id, personaVersion: 1 });
    const expires = Date.parse(cards[0]!.body.expiresAt as string) - Date.now();
    expect(Math.abs(expires - app.deps.config.others.cardDays * 86_400_000)).toBeLessThan(60_000);
    // The persona went to the model as it is, and nothing else of the owner's.
    const sent = JSON.stringify(gateway.calls[0]);
    expect(sent).toContain(FACT);
    // The same version is never read again; a new version is.
    expect(await aid()).toBe(0);
    expect((await patchPersona(w.owner, w.agent.id, `${PERSONA}再加一句。`)).status).toBe(200);
    gateway.reply(facts());
    expect(await aid()).toBe(1);
    expect(await cardsOf(w.agent.conversationId)).toHaveLength(2);
    // Never a word of it in the log.
    expect(lines.join("\n")).not.toContain("杭州");
  });

  it("at most three cards, however many sentences the model returns; an answer that does not parse makes none", async () => {
    await clearBacklog();
    const persona = ["一。", "二。", "三。", "四。", "五。"].map((s) => `主人说过${s}`).join("");
    const w = await world(persona);
    gateway.reply(facts("主人说过一。", "主人说过二。", "主人说过三。", "主人说过四。", "主人说过五。"));
    expect(await aid()).toBe(1);
    expect(await cardsOf(w.agent.conversationId)).toHaveLength(3);
    const x = await world();
    gateway.reply("这不是 JSON");
    expect(await aid()).toBe(1);
    expect(await cardsOf(x.agent.conversationId)).toEqual([]);
    for (const bad of [JSON.stringify([FACT]), JSON.stringify({ facts: FACT }), JSON.stringify({ facts: [1, null, { a: 1 }] }), "```json\n" + facts("不在里面") + "\n```"]) {
      const y = await world();
      gateway.reply(bad);
      await aid();
      expect([bad, await cardsOf(y.agent.conversationId)]).toEqual([bad, []]);
    }
  });

  it("two workers polling at once make one call; an Agent with no persona makes none", async () => {
    await clearBacklog();
    const w = await world();
    const e = await world("");
    gateway.reply(facts());
    const [a, b] = await Promise.all([aid(), aid()]);
    expect(a + b).toBe(1);
    expect(gateway.calls).toHaveLength(1);
    expect((await personaOf(e.agent.id)).persona_version).toBe(0);
    expect((await personaOf(w.agent.id)).persona_checked_version).toBe(1);
  });

  it("personas saved while the switch is off: no call and NOTHING stamped (A-4 review I2); turned on, each is read once", async () => {
    await clearBacklog();
    (app.deps.config as { social: unknown }).social = { enabled: false };
    const w = await world();
    try {
      expect(await aid()).toBe(0);
    } finally {
      (app.deps.config as { social: unknown }).social = { enabled: true };
    }
    expect(await personaOf(w.agent.id)).toMatchObject({ persona_version: 1, persona_checked_version: 0 });
    expect(gateway.calls).toHaveLength(0);
    gateway.reply(facts(FACT));
    expect(await aid()).toBe(1);
    expect(await personaOf(w.agent.id)).toMatchObject({ persona_version: 1, persona_checked_version: 1 });
    expect((await cardsOf(w.agent.conversationId)).map((c) => c.body.sentence)).toEqual([FACT]);
    expect(await aid()).toBe(0);
  });

  it("25 owners with a persona each: the first poll serves 10, the second 10, the third 5; each is read exactly once", async () => {
    await clearBacklog();
    const owners: Awaited<ReturnType<typeof world>>[] = [];
    for (let i = 0; i < 25; i++) owners.push(await world("你好。"));
    for (let i = 0; i < 25; i++) gateway.reply(facts());
    const polls = [await aid(), await aid(), await aid(), await aid()];
    expect(polls).toEqual([10, 10, 5, 0]);
    expect(gateway.calls).toHaveLength(25);
    expect(gateway.pending()).toBe(0);
  });

  it("a persona read refused for a moment (the owner's calls are at their cap) is read again once there is room (A-4 review m5); one refused for good is not", async () => {
    await clearBacklog();
    const w = await world();
    const cap = app.deps.config.agentMaxConcurrentRuns;
    for (let i = 0; i < cap; i++) await db.query(`insert into agent_runs (purpose, owner_id, status, started_at) values ('draft', $1, 'running', now())`, [w.owner.id]);
    expect(await aid()).toBe(0);
    expect(gateway.calls).toHaveLength(0);
    expect(await personaOf(w.agent.id)).toMatchObject({ persona_version: 1, persona_checked_version: 0 });
    await db.query(`delete from agent_runs where owner_id = $1 and purpose = 'draft'`, [w.owner.id]);
    gateway.reply(facts(FACT));
    expect(await aid()).toBe(1);
    expect(await personaOf(w.agent.id)).toMatchObject({ persona_checked_version: 1 });
    expect((await cardsOf(w.agent.conversationId)).map((c) => c.body.sentence)).toEqual([FACT]);
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
      await db.query(`insert into agents (principal_id, persona, persona_version) values ($1, '你好。', 1)`, [p.rows[0]!.id]);
      return p.rows[0]!.id;
    };
    for (const [i, o] of owners.entries()) await agentFor(o, `pa${i}`);
    await agentFor(owners[0]!, "pasecond");
    // The switch off claims, calls and stamps nothing (A-4 review I2).
    (app.deps.config as { social: unknown }).social = { enabled: false };
    try {
      expect(await aid()).toBe(0);
    } finally {
      (app.deps.config as { social: unknown }).social = { enabled: true };
    }
    const left = async () => Number((await db.query<{ n: string }>(`select count(*)::text as n from agents where persona_version > persona_checked_version`)).rows[0]!.n);
    expect(await left()).toBe(106);
    // With it on, a poll is 10 calls (an owner with two Agents is served one per poll).
    for (let i = 0; i < 10; i++) gateway.reply(facts());
    expect(await aid()).toBe(10);
    expect(await left()).toBe(106 - 10);
    await clearBacklog();
  });

  it("an owner's memory allowance spent: no call is made (the answer is not guessed)", async () => {
    await clearBacklog();
    const w = await world();
    await db.query(
      "insert into memory_usage (owner_id, day, used_micro) values ($1, (now() at time zone 'Asia/Shanghai')::date, 900000000000) on conflict (owner_id, day) do update set used_micro = excluded.used_micro",
      [w.owner.id],
    );
    expect(await aid()).toBe(0);
    expect(gateway.calls).toHaveLength(0);
    expect(await cardsOf(w.agent.conversationId)).toEqual([]);
  });

  it("a persona saved while the call is out: that call writes no card (the newer version is read on its own)", async () => {
    await clearBacklog();
    const w = await world();
    const hold = gateway.hang();
    const running = aid();
    await hold.reached;
    expect((await patchPersona(w.owner, w.agent.id, `新的人格。${FACT2}`)).status).toBe(200);
    hold.release(facts(FACT));
    await running;
    expect(await cardsOf(w.agent.conversationId)).toEqual([]);
    gateway.reply(facts(FACT2));
    expect(await aid()).toBe(1);
    expect((await cardsOf(w.agent.conversationId)).map((c) => c.body.sentence)).toEqual([FACT2]);
  });

  it("never sends vault text to the model, and never reveals a held-back fact to a visitor", async () => {
    await clearBacklog();
    const w = await world();
    const VAULT = "VAULT-CANARY 主人的银行卡尾号 8888";
    await db.query(`insert into owner_notes (owner_id, text, vault, vault_by, unsure, origin) values ($1, $2, true, 'auto', false, 'owner')`, [w.owner.id, VAULT]);
    gateway.reply(facts(FACT));
    await aid();
    expect(JSON.stringify(gateway.calls)).not.toContain("VAULT-CANARY");
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

describe("what makes a card (A-4 review m6, m7)", () => {
  it("only a whole sentence of the persona is kept: a fragment, a clause or a few characters are not, and the sentence's own end mark goes with it", () => {
    const keep = (facts: string[]) => verbatimFacts(JSON.stringify({ facts }), PERSONA);
    expect(keep([FACT])).toEqual([FACT]);
    expect(keep([FACT.slice(0, -1)])).toEqual([FACT]);
    expect(keep([FACT2, "你是一个说话简洁的助手。"])).toEqual([FACT2, "你是一个说话简洁的助手。"]);
    expect(keep(["杭州滨江区"])).toEqual([]);
    expect(keep(["主人住在杭州滨江区"])).toEqual([]);
    expect(keep(["家里养了一只猫。"])).toEqual([]);
    expect(keep(["主人"])).toEqual([]);
    expect(keep([PERSONA])).toEqual([]);
    expect(verbatimFacts(JSON.stringify({ facts: ["我住在杭州"] }), "我住在杭州")).toEqual(["我住在杭州"]);
  });

  it("a sentence the owner answered 不用, or whose card still waits, is not asked again by a later save", async () => {
    await clearBacklog();
    const w = await world();
    gateway.reply(facts(FACT, FACT2));
    await aid();
    const [first, second] = await cardsOf(w.agent.conversationId);
    expect((await answer(w.owner, w.agent.id, Number(first!.seq), false)).status).toBe(200);
    // FACT was kept as it is; FACT2's card still waits (unanswered, not expired); a moved sentence is gone from the persona.
    expect(second).toBeTruthy();
    expect((await patchPersona(w.owner, w.agent.id, `${PERSONA}又加一句。`)).status).toBe(200);
    gateway.reply(facts(FACT, FACT2));
    expect(await aid()).toBe(1);
    expect((await cardsOf(w.agent.conversationId)).map((c) => c.body.sentence)).toEqual([FACT, FACT2]);
    // An expired card that was never answered is asked again.
    await db.query(`update messages set body = jsonb_set(body, '{expiresAt}', to_jsonb($2::text)) where id = $1`, [(await db.query<{ id: string }>(`select id::text from messages where conversation_id = $1 and seq = $2`, [w.agent.conversationId, Number(second!.seq)])).rows[0]!.id, new Date(Date.now() - 1000).toISOString()]);
    expect((await patchPersona(w.owner, w.agent.id, `${PERSONA}再加一句。`)).status).toBe(200);
    gateway.reply(facts(FACT, FACT2));
    await aid();
    expect((await cardsOf(w.agent.conversationId)).map((c) => c.body.sentence)).toEqual([FACT, FACT2, FACT2]);
  });
});

describe("the card and its answer", () => {
  /** An owner whose persona has been read once and made one card at `seq`. */
  async function carded() {
    await clearBacklog();
    const w = await world();
    gateway.reply(facts(FACT));
    await aid();
    const [card] = await cardsOf(w.agent.conversationId);
    return { ...w, seq: Number(card!.seq) };
  }
  const wireCard = async (owner: Actor, w: { agent: Made; seq: number }) =>
    ((await api(app, owner, "GET", `/api/conversations/${w.agent.conversationId}/messages`)).json.messages as Array<{ seq: number; system?: { card?: unknown } }>).find((m) => m.seq === w.seq);

  it("the owner reads the card with its answer and whether it is over; moving removes exactly that sentence, writes it as a note, and makes no new call", async () => {
    const w = await carded();
    expect((await wireCard(w.owner, w))!.system).toMatchObject({ event: "persona_fact", sentence: FACT, card: { answer: null, expired: false, sentence: FACT } });
    const moved = await answer(w.owner, w.agent.id, w.seq, true);
    expect([moved.status, moved.json]).toEqual([200, { ok: true, moved: true }]);
    expect(await personaOf(w.agent.id)).toEqual({ persona: PERSONA.replace(FACT, ""), persona_version: 2, persona_checked_version: 2 });
    const notes = (await db.query(`select text, vault from owner_notes where owner_id = $1`, [w.owner.id])).rows;
    expect(notes).toEqual([{ text: FACT, vault: true }]);
    expect((await db.query(`select answer from social_card_answers`)).rows.map((r) => r.answer)).toContain("moved");
    expect((await wireCard(w.owner, w))!.system).toMatchObject({ card: { answer: "moved", expired: false } });
    // No new call for the owner's own edit.
    expect(await aid()).toBe(0);
    expect(gateway.calls).toHaveLength(1);
    // A second answer, either way: 409 answered.
    for (const move of [true, false]) {
      const again = await answer(w.owner, w.agent.id, w.seq, move);
      expect([again.status, again.json.error]).toEqual([409, "answered"]);
    }
    expect((await personaOf(w.agent.id)).persona_version).toBe(2);
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
