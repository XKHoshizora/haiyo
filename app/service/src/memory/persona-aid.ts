import type { FastifyBaseLogger } from "fastify";
import { siteDay } from "../accounts/store.ts";
import { judgementsOn } from "../agents/proactive/decide.ts";
import { lockAgent, lockOwnedAgent } from "../agents/store.ts";
import type { Config } from "../config.ts";
import type { ConversationEvents } from "../conversations/events.ts";
import { appendSystem } from "../conversations/system.ts";
import type { Db } from "../db.ts";
import { AppError, notFound } from "../errors.ts";
import type { Judge, Question } from "../judge/client.ts";
import type { StoredMessage } from "../messages/model.ts";
import { ownerNote } from "./clean.ts";
import { askAllOutcome, judgeConfigured, ownerJudgementsUsed, type NoAnswer, type SortDeps } from "./sort.ts";
import { roomOf } from "./store.ts";
import { weight, weightOf } from "./weight.ts";
import { insertNote, listRoom, lockRoom, roomLimit, fits, type Room } from "./write.ts";

// The persona aid (plan A8b; design §4; v2 of 2026-11-28), the one check on owner facts written into a persona: ring 1a sends the
// persona whole to a visitor's reply, so each new persona version is read once for sentences that tell a stranger a fact of the owner's
// or someone else's real life. The judgement is where every other memory judgement is: the decision model, one calibrated yes/no
// question (`PERSONA_FACT_INSTRUCTIONS`) per sentence, one request each through memory's judgement path (memory/sort.ts
// `askAllOutcome`: the owner's `judgePerOwnerDay`, memory's `judgeShare` of the site's day), a sentence at `MEMORY.personaFactAt` or more
// a candidate. No chat model is called and no memory allowance spent; no note is read, vault or other. The three highest candidates
// not asked before each become a card for the owner alone. Nothing here logs a sentence, a persona or a note: counters and ids.

/** The most cards one persona version gets. */
export const PERSONA_CARDS = 3;

/**
 * The question each sentence is asked, its state `句子：<sentence>`. Calibrated on the real judgement model on 2026-11-28 (200
 * hand-written sentences, `calibration/persona-facts.jsonl`; `scripts/calibrate-memory.mjs --mode persona`;
 * docs/acceptance/memory/calibration.md): nothing that only gives the Agent a role, a name, a manner, a joke or a line, or says how the
 * owner wants to be answered, scored above 0.26; no fact or mixed sentence below 0.53.
 */
const PERSONA_FACT_INSTRUCTIONS =
  "这是一个 AI 助手的人格设定里的一句话，由它的主人写给它，可能用任何语言写。一个陌生人读到这句话，会因此知道主人本人或者某个真实的人在现实生活中的一件具体的事（比如在哪工作、住在哪、家里有谁、身体状况、行程安排、钱、感情、经历、信仰、联系方式）。如果这句话只是在说助手自己的身份、称呼、性格、语气、台词、玩笑、和主人的关系或态度，或者只是说主人希望助手怎么回答、怎么称呼，陌生人并不会因此知道主人的任何现实情况，就不算。拿不准的不算。";
const PERSONA_FACT = "persona_fact";
const QUESTION: Question = { key: PERSONA_FACT, type: "noul", instructions: PERSONA_FACT_INSTRUCTIONS };

/**
 * The most sentences of one persona version that are asked about, the first of them (round 1, A3): a request each, from the owner's
 * day of memory judgements. A typical persona has far fewer; the length limit (`PERSONA_MAX`, 20 000 characters) would allow some
 * four thousand sentences of `MIN_SENTENCE`.
 */
export const PERSONA_ASKED = 40;
/**
 * A sentence longer than this many characters is not asked (round 1, A5): what was calibrated are single sentences, and an ASCII full
 * stop ends none (`END`), so a paragraph of a Latin script is one span, and a card for it would move the whole paragraph.
 */
const LONGEST_ASKED = 200;

/** The marks that end a sentence of a persona (and a line break). */
const END = "。！？!?；;\n";
const MIN_SENTENCE = 4;
/** What `sentenceSpan` steps over before a sentence; no sentence of `personaSentences` starts with one. */
const LEAD = " \t　";

/**
 * Where `sentence` stands in `persona` as a WHOLE sentence (A-4 review m7): it starts at the text's start or after an end mark, ends at
 * the text's end or at an end mark (its own, or the one that follows it), and holds no end mark inside. A fragment, a clause or a few
 * characters are none, so a move never cuts a persona mid-sentence. `end` takes the sentence's own end mark with it. Null: no such place.
 */
export function sentenceSpan(persona: string, sentence: string): { start: number; end: number } | null {
  const last = sentence.at(-1);
  if (last === undefined || sentence.replace(/[。！？!?；;\s]/g, "").length < MIN_SENTENCE) return null;
  const marked = END.includes(last);
  if ([...(marked ? sentence.slice(0, -1) : sentence)].some((c) => END.includes(c))) return null;
  for (let from = 0; ; ) {
    const at = persona.indexOf(sentence, from);
    if (at < 0) return null;
    let before = at;
    while (before > 0 && LEAD.includes(persona[before - 1]!)) before--;
    const stop = at + sentence.length;
    if ((before === 0 || END.includes(persona[before - 1]!)) && (stop === persona.length || marked || END.includes(persona[stop]!))) {
      return { start: at, end: marked || stop === persona.length ? stop : stop + 1 };
    }
    from = at + 1;
  }
}

/** A sentence of a persona: where it stands, and its text (`persona.slice(start, end)`, its own end mark with it). */
export interface PersonaSentence {
  start: number;
  end: number;
  text: string;
}

/**
 * The sentences of `persona` the aid asks about, in the persona's order: each piece of it up to and with an end mark (`END`; the last
 * piece runs to its end), without the spaces before it that `sentenceSpan` steps over, kept only when `sentenceSpan` finds exactly that
 * span for its text — so a card made of it can always be moved (round 1, A4) — and when it is at most `LONGEST_ASKED` characters long.
 * The same text is asked once: at its first place, the one `sentenceSpan` finds.
 */
export function personaSentences(persona: string): PersonaSentence[] {
  const out: PersonaSentence[] = [];
  const seen = new Set<string>();
  let from = 0;
  for (let i = 0; i <= persona.length; i++) {
    if (i < persona.length && !END.includes(persona[i]!)) continue;
    const end = i < persona.length ? i + 1 : i;
    let start = from;
    from = end;
    while (start < end && LEAD.includes(persona[start]!)) start++;
    if (start === end) continue;
    const text = persona.slice(start, end);
    if (seen.has(text) || [...text.trim()].length > LONGEST_ASKED) continue;
    const span = sentenceSpan(persona, text);
    if (span === null || span.start !== start || span.end !== end) continue;
    seen.add(text);
    out.push({ start, end, text });
  }
  return out;
}

/**
 * Sorting keeps priority (round 1, A3): the persona aid reads a persona only while the owner's memory judgements of the day stay within
 * half of their `judgePerOwnerDay` (`ownerRoom`), and the site's judgements of the day within half of memory's `judgeShare` of its daily
 * limit (`siteRoom`; none without a judgement model) — counting the requests the read will make.
 */
export const ownerRoom = (config: Pick<Config, "memory">): number => config.memory.judgePerOwnerDay / 2;
export const siteRoom = (config: Pick<Config, "memory" | "judge">): number =>
  config.judge === null ? Number.POSITIVE_INFINITY : (config.memory.judgeShare * config.judge.dailyLimit) / 2;

/** Whether `count` more requests for `ownerId` now would pass `ownerRoom` or `siteRoom`. A read that fails throws. */
async function crowds(db: Db, config: Config, ownerId: string, count: number): Promise<boolean> {
  const day = siteDay(new Date(), config.siteTimezone);
  if ((await ownerJudgementsUsed(db, ownerId, day)) + count > ownerRoom(config)) return true;
  return (await judgementsOn(db, day)) + count > siteRoom(config);
}

/**
 * The refusals that clear by themselves (round 1, A2): the version is given back (`releasePersona`), to be read whole at a later pass.
 * Any other — no judgement model, the owner's or the site's day used up — leaves it read: the aid is a help, never a gate.
 */
const GIVEN_BACK: ReadonlySet<NoAnswer> = new Set<NoAnswer>(["closing", "limit_unread", "busy"]);

export interface PersonaAidDeps {
  db: Db;
  config: Config;
  /** The judgement model; null when `JUDGE` is not configured. */
  judge: Judge | null;
  conversations: Pick<ConversationEvents, "publish">;
  log: Pick<FastifyBaseLogger, "error" | "warn" | "info" | "debug">;
}

/** An Agent claimed by the worker, with the persona version that was stamped as checked. */
export interface Claimed {
  id: string;
  ownerId: string;
  persona: string;
  personaVersion: number;
}

/** A sentence scored at `personaFactAt` or more: its text, its score, its place among the sentences asked. */
interface Candidate {
  sentence: string;
  p: number;
  order: number;
}

/**
 * One Agent's persona, read once: its first `PERSONA_ASKED` sentences (`personaSentences`), each asked `QUESTION` in a request of its
 * own, then under the Agent's lock the cards. Before anything is asked, a read that would crowd out sorting (`crowds`) is given back.
 * A sentence whose request failed is no candidate; once no more can be asked (no judgement model, the owner's or the site's day used
 * up) the sentences answered so far are all there is; a refusal that clears by itself (`GIVEN_BACK`) gives the version back. When the
 * persona was saved again while the questions were out, nothing is written (the newer version is read on its own). Returns the requests
 * made.
 */
export async function runPersonaAid(deps: PersonaAidDeps, agent: Claimed, closing: AbortSignal): Promise<number> {
  const { db, config, log } = deps;
  if (agent.persona.trim() === "") return 0;
  if (closing.aborted) {
    await releasePersona(db, agent);
    return 0;
  }
  const sort: SortDeps = { db, ownerId: agent.ownerId, judge: deps.judge, config, log };
  const sentences = personaSentences(agent.persona).slice(0, PERSONA_ASKED);
  if (!judgeConfigured(sort) || sentences.length === 0) {
    log.info({ metric: "persona_aid", agentId: agent.id, cards: 0, answered: false }, "the persona aid read a persona");
    return 0;
  }
  let deferred: boolean;
  try {
    deferred = await crowds(db, config, agent.ownerId, sentences.length);
  } catch (err) {
    log.info({ metric: "judge_limit_check_failed", err }, "the judgement limit could not be read: not judged");
    deferred = true;
  }
  if (deferred) {
    await releasePersona(db, agent);
    return 0;
  }
  let started = 0;
  let answered = false;
  const candidates: Candidate[] = [];
  for (const [order, s] of sentences.entries()) {
    const asked = await askAllOutcome(sort, `句子：${s.text.trim()}`, [QUESTION], "persona", closing);
    if (asked.started) started++;
    if (asked.answers === null) {
      if (GIVEN_BACK.has(asked.why)) {
        await releasePersona(db, agent);
        return started;
      }
      if (asked.why === "failed") continue;
      break;
    }
    answered = true;
    const answer = asked.answers.get(PERSONA_FACT);
    if (answer?.type === "noul" && answer.p >= config.memory.personaFactAt) candidates.push({ sentence: s.text, p: answer.p, order });
  }
  if (candidates.length === 0) {
    log.info({ metric: "persona_aid", agentId: agent.id, cards: 0, answered }, "the persona aid read a persona");
    return started;
  }
  const expiresAt = new Date(Date.now() + config.others.cardDays * 86_400_000).toISOString();
  const posted = await db.tx(async (t): Promise<StoredMessage[]> => {
    // The Agent's own conversation, then its row (the lock order); a persona saved meanwhile has a newer version: not this one's cards.
    const now = await lockAgent(t, agent.id);
    if (now.deleted || now.personaVersion !== agent.personaVersion || !candidates.every((c) => sentenceSpan(now.persona, c.sentence) !== null)) return [];
    // A sentence the owner answered 不用, or whose card still waits, is not asked again (A-4 review m6): left out BEFORE the highest are
    // taken (round 1, A6), so a fact behind three asked ones still gets its card.
    const asked = await t.query<{ sentence: string }>(
      `select distinct m.body ->> 'sentence' as sentence
         from messages m left join social_card_answers a on a.message_id = m.id
        where m.conversation_id = $1 and m.kind = 'system' and m.body ->> 'event' = 'persona_fact' and m.body ->> 'agentId' = $2
          and (a.answer = 'kept' or (a.message_id is null and (m.body ->> 'expiresAt')::timestamptz > now()))`,
      [now.conversationId, agent.id],
    );
    const chosen = candidates
      .filter((c) => !asked.rows.some((r) => r.sentence === c.sentence))
      .sort((a, b) => b.p - a.p || a.order - b.order)
      .slice(0, PERSONA_CARDS)
      .sort((a, b) => a.order - b.order);
    const out: StoredMessage[] = [];
    for (const { sentence } of chosen) {
      out.push(await appendSystem(t, now.conversationId, { event: "persona_fact", actorId: agent.id, agentId: agent.id, sentence, personaVersion: agent.personaVersion, expiresAt }));
    }
    return out;
  });
  if (posted.length > 0) deps.conversations.publish({ messages: posted, conversations: [] }, log);
  log.info({ metric: "persona_aid", agentId: agent.id, cards: posted.length, answered: true }, "the persona aid read a persona");
  return started;
}

/** A claimed version that was not read goes back to being due (guarded by the version: a newer save is its own). */
export async function releasePersona(db: Db, agent: Claimed): Promise<void> {
  await db.query(
    "update agents set persona_checked_version = persona_version - 1 where principal_id = $1 and persona_version = $2 and persona_checked_version = $2",
    [agent.id, agent.personaVersion],
  );
}

/** What a card's answer did: the sentence moved out of the persona (`moved`), or left as it is. */
export type PersonaFactAnswer = { moved: boolean };

/**
 * The owner answers the `persona_fact` card at `seq` of their Agent's own conversation, in one transaction under `lockOwnedAgent`.
 * 404 for what is no card of this Agent; 409 `answered` / `expired`. `move`: the card's sentence is taken out of the persona (its first
 * occurrence, by a guarded update, `persona_version + 1`), `persona_checked_version` follows so the owner's own edit is not read again,
 * and the sentence becomes an owner note (in the vault, as a hearsay taken as true is); a room that cannot take it is 409 `room_full`
 * and nothing is changed. A sentence no longer in the persona changes nothing and is answered `kept`. No move: the answer is `kept`.
 * One `social_card_answers` row per card.
 */
export async function answerPersonaFact(
  db: Db,
  config: Pick<Config, "memory">,
  ownerId: string,
  agentId: string,
  seq: number,
  move: boolean,
): Promise<PersonaFactAnswer> {
  return db.tx(async (t) => {
    const agent = await lockOwnedAgent(t, ownerId, agentId);
    const card = (
      await t.query<{ id: string; sentence: unknown; expires_at: unknown }>(
        `select id::text, body ->> 'sentence' as sentence, body ->> 'expiresAt' as expires_at from messages
          where conversation_id = $1 and seq = $2 and kind = 'system' and body ->> 'event' = 'persona_fact' and body ->> 'agentId' = $3`,
        [agent.conversationId, seq, agent.id],
      )
    ).rows[0];
    if (!card || typeof card.sentence !== "string") throw notFound();
    const done = await t.query("select 1 from social_card_answers where message_id = $1::bigint", [card.id]);
    if ((done.rowCount ?? 0) > 0) throw new AppError(409, "answered");
    const expires = typeof card.expires_at === "string" ? Date.parse(card.expires_at) : Number.NaN;
    if (!(expires > Date.now())) throw new AppError(409, "expired");
    const sentence = card.sentence;
    const span = sentenceSpan(agent.persona, sentence);
    const moves = move && span !== null;
    if (moves) {
      const room: Room = { kind: "owner", ownerId };
      const text = ownerNote(sentence);
      if (text === null) throw new AppError(422, "note_refused");
      await lockRoom(t, room);
      const rooms = roomOf(config);
      const held = await listRoom(t, room);
      const left = Math.max(0, roomLimit(rooms, "owner") - weightOf(held));
      if (held.length >= rooms.notes! || !fits(weightOf(held), weight(text), roomLimit(rooms, "owner"))) throw new AppError(409, "room_full", { left } as never);
      const next = `${agent.persona.slice(0, span.start)}${agent.persona.slice(span.end)}`.trim();
      const changed = await t.query(
        "update agents set persona = $2, persona_version = persona_version + 1, persona_checked_version = persona_version + 1 where principal_id = $1 and persona = $3",
        [agent.id, next, agent.persona],
      );
      if ((changed.rowCount ?? 0) === 0) throw new AppError(409, "answered");
      await insertNote(t, room, { text, vault: true, vaultBy: "auto", unsure: false, origin: "owner", originConversationId: null });
    }
    await t.query("insert into social_card_answers (message_id, answer) values ($1::bigint, $2)", [card.id, moves ? "moved" : "kept"]);
    return { moved: moves };
  });
}

