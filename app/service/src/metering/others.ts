import { lockAccount, MICRO_PER_POINT, nextSiteMidnight, siteDayStart } from "../accounts/store.ts";
import type { Lane } from "../agents/runs.ts";
import type { AgentModel } from "../agents/store.ts";
import type { Config } from "../config.ts";
import type { Queryable, Tx } from "../db.ts";
import {
  groupSystemText,
  GROUP_AGENTS_NAMED,
  GROUP_PEOPLE_NAMED,
  NO_NOTES,
  NOTES_SECRET_CLAUSE,
  notesPassage,
  passageBudget,
  socialSystemText,
  SUMMARY_HEADING,
  SUMMARY_SAID_BY,
  type GroupScene,
} from "../agents/runtime/prompt.ts";
import { AGENT_NAME_MAX, DISPLAY_NAME_MAX } from "../schemas.ts";
import { notesFor } from "../memory/store.ts";
import { REASONING_LEVELS, type ReasoningLevel } from "../config.ts";
import { callLevel, outputLimit, sentLevel, type Resolved } from "../models/resolve.ts";
import { maxCostMicro } from "./prices.ts";
import type { PayClass } from "./pool.ts";

/**
 * What others' use of an Agent may cost its owner (plan: step L, lane B's B1 to B3; README "Agent social", Numbers). One owner has two
 * numbers a site day, answers and points (`OTHERS.answersPerDay` / `pointsPerDay`, an account's own replacing them), shared by all
 * their Agents and by both lanes somebody other than the owner calls for (`others`, `proactive`). `othersFits` decides them
 * in ONE place, under the account lock, at admission, at a search's pre-hold and at a round, and each time counts what is
 * settled today plus the hold of every running reply of those lanes, the asking run's own included (D19): so settled +
 * holds never pass a number, whatever order replies arrive in. An Agent's own numbers are sub-limits inside its owner's.
 */

export type OthersLane = "others" | "proactive";

/** The lanes somebody other than the owner calls for. */
const OTHERS_LANES: readonly OthersLane[] = ["others", "proactive"];

/**
 * Whether a reply of this class and lane keeps room for its last call at admission: an `AB` reply as today, and every reply
 * somebody other than the Agent's owner called for. Replaces `cls === "AB"` at admit.ts:193, port-impl.ts:1122 and
 * tools/web/hold.ts:178.
 */
export const keepsRoom = (cls: PayClass, lane: Lane): boolean => cls === "AB" || lane !== "own";

export type OthersVerdict = { ok: true } | { ok: false; heldBackBy: readonly string[] } | { ok: false; limit: "answers" | "points" | "proactive" };

/** An owner's two numbers, or an Agent's. */
export interface OthersNumbers {
  answers: number;
  pointsMicro: bigint;
}

/** An owner's two numbers: the account's own, else the config's (one reader: `othersNumbers` and the use route both call it). */
export async function ownerNumbers(q: Queryable, config: Pick<Config, "others">, ownerId: string): Promise<OthersNumbers> {
  const { rows } = await q.query<{ answers: number | null; points: string | null }>(
    "select others_answers as answers, others_points_micro::text as points from accounts where principal_id = $1",
    [ownerId],
  );
  const r = rows[0];
  return {
    answers: r?.answers ?? config.others.answersPerDay,
    pointsMicro: r?.points == null ? BigInt(config.others.pointsPerDay) * MICRO_PER_POINT : BigInt(r.points),
  };
}

/**
 * The numbers `othersFits` holds an Agent's others' replies to: the owner's (`ownerNumbers`), the Agent's own sub-limits (null:
 * none) and the Agent's proactive budget (a hard sub-cap since B1).
 */
export async function othersNumbers(
  q: Queryable,
  config: Pick<Config, "others">,
  ownerId: string,
  agentId: string,
): Promise<{ owner: OthersNumbers; agent: { answers: number | null; pointsMicro: bigint | null }; proactiveMicro: bigint }> {
  const { rows } = await q.query<{ agent_answers: number | null; agent_points: string | null; proactive: string }>(
    `select others_answers as agent_answers, others_budget_micro::text as agent_points, proactive_budget_micro::text as proactive
       from agents where principal_id = $1`,
    [agentId],
  );
  const r = rows[0];
  if (!r) throw new Error(`othersNumbers: ${agentId} is not an Agent`);
  return {
    owner: await ownerNumbers(q, config, ownerId),
    agent: { answers: r.agent_answers, pointsMicro: r.agent_points === null ? null : BigInt(r.agent_points) },
    proactiveMicro: BigInt(r.proactive),
  };
}

/** What others' replies have used of the site day `now` is in (`othersUsedToday`). */
export interface OthersUse {
  answers: number;
  settledMicro: bigint;
  heldMicro: bigint;
}

interface Scope {
  agentId?: string;
  lane?: OthersLane;
}

/** The answers of the site day: distinct retry chains admitted in it (`admitted_at`, never reset), and whether `chainOf`'s chain is one. */
async function answersToday(
  q: Queryable,
  config: Pick<Config, "siteTimezone">,
  ownerId: string,
  now: Date,
  scope: Scope,
  runId: string | null,
): Promise<{ answers: number; counted: boolean }> {
  const { rows } = await q.query<{ n: number; counted: boolean }>(
    `with me as (select coalesce(retry_of, id) as chain from agent_runs where id::text = $5)
     select count(distinct coalesce(r.retry_of, r.id))::int as n,
            coalesce(bool_or(coalesce(r.retry_of, r.id) = (select chain from me)), false) as counted
       from agent_runs r
      where r.owner_id = $1 and r.purpose = 'reply' and r.lane = any($2::text[]) and r.admitted_at >= $3 and r.admitted_at < $4
        and ($6::uuid is null or r.agent_id = $6)`,
    [
      ownerId,
      scope.lane ? [scope.lane] : OTHERS_LANES,
      siteDayStart(now, config.siteTimezone, 0),
      nextSiteMidnight(now, config.siteTimezone),
      runId,
      scope.agentId ?? null,
    ],
  );
  return { answers: rows[0]!.n, counted: rows[0]!.counted };
}

/**
 * The points of the site day in `scope`: what the replies of those lanes were charged today (`usage_records` of the day,
 * free plus balance — settled), the sum of `hold_micro` of the running ones (`heldMicro`: the run `exceptId` included — it is
 * the caller's to count — and the ids of the others that hold anything, `holders`, for the wait).
 */
async function pointsToday(
  q: Queryable,
  config: Pick<Config, "siteTimezone">,
  ownerId: string,
  now: Date,
  scope: Scope,
  exceptId: string | null,
): Promise<{ settledMicro: bigint; heldMicro: bigint; holders: string[] }> {
  const lanes = scope.lane ? [scope.lane] : OTHERS_LANES;
  const agent = scope.agentId ?? null;
  const settled = await q.query<{ n: string }>(
    `select coalesce(sum(u.free_micro + u.balance_micro), 0)::text as n
       from usage_records u join agent_runs r on r.id = u.run_id
      where u.owner_id = $1 and u.created_at >= $2 and u.created_at < $3 and r.purpose = 'reply' and r.lane = any($4::text[])
        and ($5::uuid is null or r.agent_id = $5)`,
    [ownerId, siteDayStart(now, config.siteTimezone, 0), nextSiteMidnight(now, config.siteTimezone), lanes, agent],
  );
  const held = await q.query<{ n: string; holders: string[] }>(
    `select coalesce(sum(hold_micro), 0)::text as n,
            coalesce(array_agg(id order by created_at, id) filter (where hold_micro > 0 and id::text <> coalesce($4, '')), '{}') as holders
       from agent_runs
      where owner_id = $1 and status = 'running' and purpose = 'reply' and lane = any($2::text[]) and ($3::uuid is null or agent_id = $3)`,
    [ownerId, lanes, agent, exceptId],
  );
  return { settledMicro: BigInt(settled.rows[0]!.n), heldMicro: BigInt(held.rows[0]!.n), holders: held.rows[0]!.holders };
}

/** What has been used today of the owner's numbers (or, with `scope`, of one Agent's, one lane's). No lock: advisory, or under the caller's. */
export async function othersUsedToday(q: Queryable, config: Pick<Config, "siteTimezone">, ownerId: string, now: Date, scope: Scope = {}): Promise<OthersUse> {
  // One after the other: `q` may be a transaction's one connection.
  const answers = await answersToday(q, config, ownerId, now, scope, null);
  const points = await pointsToday(q, config, ownerId, now, scope, null);
  return { answers: answers.answers, settledMicro: points.settledMicro, heldMicro: points.heldMicro };
}

/**
 * The most a run offered tools is held for: its first call at `heldTokens` and — when it is offered tools, `room` — its last
 * call at the input it can reach, `min(heldTokens + growth, roomCap)` (B2b); both with the whole output limit. Null: one
 * call, no tools. The two parts are one hold; nothing is raised after (`extend`).
 */
export function othersHold(
  resolved: Pick<Resolved, "price" | "call" | "source">,
  heldTokens: number,
  room: { growthTokens: number; roomCapTokens: number } | null,
): bigint {
  const first = maxCostMicro(resolved, heldTokens);
  return room === null ? first : first + maxCostMicro(resolved, Math.min(heldTokens + room.growthTokens, room.roomCapTokens));
}

/** What the level rules of a reply for others need of the configuration. */
type LevelConfig = Pick<Config, "others" | "reasoningAllowanceTokens">;

/**
 * The output limit of every call of a reply for others at `level`: the reply's own part is at most `OTHERS.outputTokens`, and at a
 * level its thinking allowance comes on top, exactly as for any call (models/resolve.ts `outputLimit`: upstreams count thinking
 * inside the output limit). ONE definition: what the call is sent at, what admission holds for, and what the owner's page computes
 * the floor, the ceiling and the estimate from.
 */
export function othersOutputLimit(config: LevelConfig, replyLimit: number, contextTokens: number, level: ReasoningLevel): number {
  return outputLimit(Math.min(replyLimit, config.others.outputTokens), contextTokens, level, config.reasoningAllowanceTokens);
}

/** The level a site model runs `wanted` at: the effective level (models/resolve.ts `callLevel`) over what the site lists for it. */
export const siteLevel = (site: { reasoning: readonly ReasoningLevel[]; protocol: Resolved["call"]["protocol"] }, wanted: ReasoningLevel): ReasoningLevel =>
  sentLevel(site.protocol, callLevel(REASONING_LEVELS.filter((level) => level === "none" || site.reasoning.includes(level)), wanted));

/**
 * The level setting that applies to a reply of `lane` that is not the owner's own (Owner decision 2026-11-26): the Agent's
 * `proactiveReasoning` for a reply nobody asked for, its `othersReasoning` for every other (a co-member's call, a visitor's).
 */
export const othersWanted = (agent: { othersReasoning: ReasoningLevel; proactiveReasoning: ReasoningLevel }, lane: string): ReasoningLevel =>
  lane === "proactive" ? agent.proactiveReasoning : agent.othersReasoning;

/**
 * The model as a reply for others calls it (plan B2a; Owner decision 2026-11-26): every call's own output at most
 * `OTHERS.outputTokens`, at the EFFECTIVE level of `wanted` (the owner's setting for such replies: `othersWanted`) on this model,
 * with that level's thinking allowance. What admission holds for, what the context plan leaves room beside, and what the call is
 * sent at — one `Resolved`, so the hold is always priced at the level actually run.
 */
export function boundedForOthers<R extends Pick<Resolved, "call" | "reasoning" | "reasoningAllowed" | "contextTokens" | "replyLimit">>(resolved: R, config: LevelConfig, wanted: ReasoningLevel): R {
  const reasoning = sentLevel(resolved.call.protocol, callLevel(resolved.reasoningAllowed, wanted));
  const maxOutputTokens = othersOutputLimit(config, resolved.replyLimit ?? resolved.call.maxOutputTokens, resolved.contextTokens, reasoning);
  return { ...resolved, reasoning, call: { ...resolved.call, maxOutputTokens } };
}

/**
 * Takes the account lock itself. Settled others' charges today + the sum of `hold_micro` of every running others' run, THIS ONE
 * INCLUDED (at admission its hold is still 0: `admitRun` writes it after `admit`), + `x` must stay within each of the owner's
 * numbers — and within the Agent's own, and for a proactive reply its proactive budget; at admission the answers too (an
 * answer is an admitted reply chain: the run being admitted adds one unless its chain counts today). `at`: where it is
 * asked, so that the answers count only at admission. An answers refusal never waits (`limit`); a points refusal while other
 * running replies hold anything in the number's scope waits for them (`heldBackBy`), else is `limit`. A call that costs
 * nothing (`x` 0: a provider's model, a round that raises nothing) meets only the answers.
 */
export async function othersFits(
  t: Tx,
  config: Pick<Config, "others" | "siteTimezone">,
  run: { id: string; ownerId: string; agentId: string; lane: OthersLane },
  x: bigint,
  at: "admission" | "search" | "round",
  now: Date,
): Promise<OthersVerdict> {
  await lockAccount(t, run.ownerId);
  return othersCheck(t, config, run, x, at, now);
}

/**
 * The rule of `othersFits` without the lock: what a read that needs no lock asks (the proactive judgement's early check, before a
 * judgement is spent) — the same function, so the two cannot differ; only `othersFits` decides for good.
 */
export async function othersCheck(
  t: Queryable,
  config: Pick<Config, "others" | "siteTimezone">,
  run: { id: string; ownerId: string; agentId: string; lane: OthersLane },
  x: bigint,
  at: "admission" | "search" | "round",
  now: Date,
): Promise<OthersVerdict> {
  const numbers = await othersNumbers(t, config, run.ownerId, run.agentId);
  if (at === "admission") {
    const owner = await answersToday(t, config, run.ownerId, now, {}, run.id);
    const add = owner.counted ? 0 : 1;
    if (owner.answers + add > numbers.owner.answers) return { ok: false, limit: "answers" };
    if (numbers.agent.answers !== null) {
      const agent = await answersToday(t, config, run.ownerId, now, { agentId: run.agentId }, run.id);
      if (agent.answers + (agent.counted ? 0 : 1) > numbers.agent.answers) return { ok: false, limit: "answers" };
    }
  }
  if (x === 0n) return { ok: true };
  const refusal = (holders: readonly string[], limit: "points" | "proactive"): OthersVerdict =>
    holders.length > 0 ? { ok: false, heldBackBy: holders } : { ok: false, limit };
  const owner = await pointsToday(t, config, run.ownerId, now, {}, run.id);
  if (owner.settledMicro + owner.heldMicro + x > numbers.owner.pointsMicro) return refusal(owner.holders, "points");
  const own = run.lane === "others" ? numbers.agent.pointsMicro : numbers.proactiveMicro;
  if (own !== null) {
    const agent = await pointsToday(t, config, run.ownerId, now, { agentId: run.agentId, lane: run.lane }, run.id);
    if (agent.settledMicro + agent.heldMicro + x > own) return refusal(agent.holders, run.lane === "others" ? "points" : "proactive");
  }
  return { ok: true };
}

/**
 * Advisory (no lock; plan B7c, D11): the least room an others' reply of `agentId` has left under the numbers that bind it — the owner's
 * (`OTHERS.pointsPerDay` or their own) and the Agent's own where lower, or for a proactive reply its proactive budget — as `othersCheck`
 * reads them: the number less what is settled today and what every running reply of those lanes holds. Never below 0. `begin` offers an
 * others' reply tools only when this covers the hold with them (it plans one call otherwise); `othersFits` decides for good at admission.
 */
export async function othersRoomAdvisory(q: Queryable, config: Pick<Config, "others" | "siteTimezone">, ownerId: string, agentId: string, lane: OthersLane, now: Date): Promise<bigint> {
  const numbers = await othersNumbers(q, config, ownerId, agentId);
  const owner = await pointsToday(q, config, ownerId, now, {}, null);
  let room = numbers.owner.pointsMicro - owner.settledMicro - owner.heldMicro;
  const own = lane === "others" ? numbers.agent.pointsMicro : numbers.proactiveMicro;
  if (own !== null) {
    const agent = await pointsToday(q, config, ownerId, now, { agentId, lane }, null);
    const left = own - agent.settledMicro - agent.heldMicro;
    if (left < room) room = left;
  }
  return room < 0n ? 0n : room;
}

/**
 * Advisory (no lock), at a trigger: whether a call of an Agent is already refused by the numbers: `othersCheck` at the least a
 * call can cost (one micro-point, so that "settled plus held plus 1 over the number" is "reached"; nothing for an Agent whose model
 * costs nothing, `points: false`, which only the answers refuse, as at admission). One rule with admission and the proactive
 * early check; `othersFits` decides for good.
 */
export async function othersReached(
  q: Queryable,
  config: Pick<Config, "others" | "siteTimezone">,
  ownerId: string,
  agentId: string,
  lane: OthersLane,
  now: Date,
  o: { points?: boolean } = {},
): Promise<boolean> {
  const verdict = await othersCheck(q, config, { id: NO_RUN, ownerId, agentId, lane }, o.points === false ? 0n : 1n, "admission", now);
  return !verdict.ok;
}

/** The id of a run that does not exist: what a check made before any run (a trigger, a candidate) asks with. */
export const NO_RUN = "00000000-0000-0000-0000-000000000000";

/**
 * The least an others' reply of an Agent on `model` can hold, given `inputBytes` of input it is sure to send: one call at those
 * bytes (never more than the model's context beside its output) and the others' output limit: `othersHold`, the one definition
 * admission holds by, without a last call. 0 for a provider's own model (it holds nothing). `fixedTokens`: the images' and PDFs'
 * constants, which admission adds AFTER the clamp (`holdTokens(...) + context.fixedTokens`, port-impl.ts), so they are added after it here too.
 */
export function othersFloorHold(
  config: Pick<Config, "siteModels"> & LevelConfig,
  model: { source: string; id?: string } | null,
  inputBytes: number,
  fixedTokens = 0,
  /** The level setting of the reply (`othersWanted`); the hold is for its effective level on the model, as `boundedForOthers` sizes the call. */
  wanted: ReasoningLevel = "none",
): bigint {
  if (model?.source !== "site") return 0n;
  const site = config.siteModels.find((m) => m.id === model.id);
  if (!site) return 0n;
  const maxOutputTokens = othersOutputLimit(config, site.maxOutputTokens, site.contextTokens, siteLevel(site, wanted));
  const priced = { source: "site", price: { inputMicroPerToken: site.inputMicroPerToken, outputMicroPerToken: site.outputMicroPerToken }, call: { maxOutputTokens } } as unknown as Pick<
    Resolved,
    "price" | "call" | "source"
  >;
  return othersHold(priced, Math.max(0, Math.min(inputBytes, site.contextTokens - maxOutputTokens)) + fixedTokens, null);
}

/** A run refused by an others' number: which one. */
export class OthersLimit extends Error {
  constructor(readonly limit: "answers" | "points" | "proactive") {
    super(`others' limit reached: ${limit}`);
    this.name = "OthersLimit";
  }
}

/** What each of an owner's Agents has taken of the owner's numbers today (`othersUsedByAgents`). */
export interface AgentUse {
  answers: number;
  pointsMicro: bigint;
  /** Points of the Agent's proactive replies today (settled plus held), the one definition of "used" (`pointsToday`, lane `proactive`). */
  proactiveMicro: bigint;
}

/**
 * What each of `agentIds` (all of one owner's) has used of the site day `now` is in, against its own limits, in one statement: the
 * answers (distinct retry chains admitted today, both lanes others call for: the Agent's own answers number counts both) and the
 * points (settled plus held, lane `others` only: the Agent's own points number scopes that lane; its proactive replies have
 * `proactiveBudget`, and the owner's total, `othersUsedToday`, counts both). An Agent with nothing is in the map with zeros.
 * Advisory, no lock: the owner's view (`othersUsedToday` of the Agent wire, the use page's `agents`).
 */
export async function othersUsedByAgents(
  q: Queryable,
  config: Pick<Config, "siteTimezone">,
  ownerId: string,
  agentIds: readonly string[],
  now: Date,
): Promise<Map<string, AgentUse>> {
  const out = new Map<string, AgentUse>();
  // The same two functions enforcement counts with (`answersToday`, `pointsToday`): one definition of "used"; one Agent at a time
  // (an owner has few), one query at a time (`q` may be a transaction's one connection).
  for (const id of agentIds) {
    const answers = await answersToday(q, config, ownerId, now, { agentId: id }, null);
    const points = await pointsToday(q, config, ownerId, now, { agentId: id, lane: "others" }, null);
    const proactive = await pointsToday(q, config, ownerId, now, { agentId: id, lane: "proactive" }, null);
    out.set(id, { answers: answers.answers, pointsMicro: points.settledMicro + points.heldMicro, proactiveMicro: proactive.settledMicro + proactive.heldMicro });
  }
  return out;
}

/** One person's calls on an owner's Agents today (`othersByPerson`). */
export interface PersonUse {
  person: { id: string; handle: string; displayName: string; avatarVersion: number };
  answers: number;
  pointsMicro: bigint;
}

/**
 * The people whose calls the owner's others' replies answered today, by points (settled plus held), then answers, then id: the
 * callers of the replies of lane `others` (a proactive reply has no caller, and one whose caller has left names nobody; both are
 * in the owner's total and in no row).
 */
export async function othersByPerson(q: Queryable, config: Pick<Config, "siteTimezone">, ownerId: string, now: Date): Promise<PersonUse[]> {
  const from = siteDayStart(now, config.siteTimezone, 0);
  const to = nextSiteMidnight(now, config.siteTimezone);
  const { rows } = await q.query<{ id: string; handle: string; name: string; avatar_version: number; answers: number; points: string }>(
    `with chains as (
       select r.caller_id, count(distinct coalesce(r.retry_of, r.id))::int as answers
         from agent_runs r
        where r.owner_id = $1 and r.purpose = 'reply' and r.lane = 'others' and r.caller_id is not null and r.admitted_at >= $2 and r.admitted_at < $3
        group by r.caller_id),
     settled as (
       select r.caller_id, sum(u.free_micro + u.balance_micro) as micro
         from usage_records u join agent_runs r on r.id = u.run_id
        where u.owner_id = $1 and u.created_at >= $2 and u.created_at < $3 and r.purpose = 'reply' and r.lane = 'others' and r.caller_id is not null
        group by r.caller_id),
     held as (
       select caller_id, sum(hold_micro) as micro from agent_runs
        where owner_id = $1 and status = 'running' and purpose = 'reply' and lane = 'others' and caller_id is not null
        group by caller_id)
     select p.id, p.handle::text as handle, p.display_name as name, p.avatar_version, coalesce(c.answers, 0) as answers,
            (coalesce(s.micro, 0) + coalesce(h.micro, 0))::text as points
       from principals p
       left join chains c on c.caller_id = p.id left join settled s on s.caller_id = p.id left join held h on h.caller_id = p.id
      where c.caller_id is not null or s.caller_id is not null or h.caller_id is not null
      order by coalesce(s.micro, 0) + coalesce(h.micro, 0) desc, coalesce(c.answers, 0) desc, p.id`,
    [ownerId, from, to],
  );
  return rows.map((r) => ({ person: { id: r.id, handle: r.handle, displayName: r.name, avatarVersion: r.avatar_version }, answers: r.answers, pointsMicro: BigInt(r.points) }));
}

/** The estimate's plain reply: held for 16 500 input tokens, costing 5 000 input and 500 output tokens. */
const PLAIN_REPLY_INPUT_TOKENS = 16_500;
const PLAIN_COST_INPUT_TOKENS = 5_000;
const PLAIN_COST_OUTPUT_TOKENS = 500;

/**
 * How many replies a site day an Agent can give others, estimated for the owner's page (plan B4): 0 when the numbers that bind
 * it (the owner's, or the Agent's own where lower) do not cover one plain reply's hold (one call at 16 500 input tokens and the
 * others' output limit: `othersFloorHold`), else `min(answers, 1 + ⌊(points − plain hold) / plain cost⌋)` with the plain cost of
 * 5 000 input and 500 output tokens at the model's price. A provider's own model costs the owner nothing: the answers number. No
 * model, or a site model the site no longer has: 0.
 */
export function perDayEstimate(
  config: Pick<Config, "siteModels"> & LevelConfig,
  model: AgentModel,
  numbers: { owner: OthersNumbers; agent: { answers: number | null; pointsMicro: bigint | null } },
  /** The Agent's `othersReasoning`: the estimate is for the level its replies for others run at. */
  wanted: ReasoningLevel = "none",
): number {
  if (model === null) return 0;
  const answers = BigInt(Math.min(numbers.owner.answers, numbers.agent.answers ?? Number.MAX_SAFE_INTEGER));
  if (model.source !== "site") return Number(answers);
  const site = config.siteModels.find((m) => m.id === model.id);
  if (!site) return 0;
  const points = numbers.agent.pointsMicro !== null && numbers.agent.pointsMicro < numbers.owner.pointsMicro ? numbers.agent.pointsMicro : numbers.owner.pointsMicro;
  const plainHold = othersFloorHold(config, model, PLAIN_REPLY_INPUT_TOKENS, 0, wanted);
  if (points < plainHold) return 0;
  // At a level a plain reply also thinks: counted as half of the level's allowance on this model (what the limit grows by, halved).
  const thinking = Math.floor((othersOutputLimit(config, site.maxOutputTokens, site.contextTokens, siteLevel(site, wanted)) - othersOutputLimit(config, site.maxOutputTokens, site.contextTokens, "none")) / 2);
  const plainCost = BigInt(PLAIN_COST_INPUT_TOKENS) * BigInt(site.inputMicroPerToken) + BigInt(PLAIN_COST_OUTPUT_TOKENS + thinking) * BigInt(site.outputMicroPerToken);
  const replies = plainCost === 0n ? answers : 1n + (points - plainHold) / plainCost;
  return Number(replies < answers ? replies : answers);
}

/** A group with nothing named: the smallest scene a group reply's system text can have. */
const EMPTY_SCENE: GroupScene = { title: null, agents: [], more: false, people: [], morePeople: false };

/**
 * The least a plain reply of `agent` can hold, as `begin` will hold it (the ONE floor: the proactive lane's early check and the use
 * page both ask it): one call without tools at the model's prices (`othersFloorHold`, through `othersHold`), at the bytes of the
 * tool-less system text as `begin` builds it from what is known before any conversation exists: the persona, the owner's name, the
 * date and `scene` (the group's title and Agents when the caller knows the group; none: the smallest scene, so that the result is
 * a lower bound for every group). Never the conversation shown, the roster of speakers, the mark or the notes, which only add bytes.
 * `lane` picks the text's shape, so that the floor is a lower bound BY CONSTRUCTION: an others' reply's text carries the called
 * sentence (`unasked` false), the proactive lane's the unasked passage (69 to 113 bytes longer), and each is floored by its own.
 * 0 for a provider's own model. `place` says whose text the floor is: a group's (`group`, with `scene`), a social conversation's (`social`:
 * `socialSystemText` with the fewest names there can be, one owner, a person for the other party, no mark and no notes) or, by default,
 * a bound for BOTH (`any`: the lower of the two, which is what an Agent's room asks, since either may be the reply admission holds for).
 * The proactive lane is a group's alone (a social reply is only ever called for). So the floor is a lower bound of the hold of every
 * reply of that lane in that place BY CONSTRUCTION: it is built by the place's own text function from the least its inputs can be.
 */
export async function othersPlainFloor(
  q: Queryable,
  config: Pick<Config, "siteModels" | "siteTimezone"> & LevelConfig,
  agent: { name: string; handle: string; persona: string; ownerId: string; model: AgentModel; othersReasoning: ReasoningLevel; proactiveReasoning: ReasoningLevel },
  scene: GroupScene | null,
  now: Date,
  lane: "others" | "proactive",
  place: "group" | "social" | "any" = "any",
): Promise<bigint> {
  if (agent.model?.source !== "site") return 0n;
  const owner = await q.query<{ display_name: string }>("select display_name from principals where id = $1", [agent.ownerId]);
  const displayName = owner.rows[0]?.display_name ?? "";
  const grouped = (): number =>
    Buffer.byteLength(
      groupSystemText(
        { name: agent.name, handle: agent.handle, persona: agent.persona, bare: null },
        { displayName },
        scene ?? EMPTY_SCENE,
        now,
        config.siteTimezone,
        "",
        lane === "proactive",
        NO_NOTES,
        false,
      ).text,
      "utf8",
    );
  const social = (): number =>
    Buffer.byteLength(
      socialSystemText({ name: agent.name, handle: agent.handle, persona: agent.persona }, [{ displayName }], { name: "", handle: "", kind: "human" }, now, config.siteTimezone, "", NO_NOTES, false).text,
      "utf8",
    );
  const bytes = lane === "proactive" || place === "group" ? grouped() : place === "social" ? social() : Math.min(grouped(), social());
  return othersFloorHold(config, agent.model, bytes, 0, othersWanted(agent, lane));
}

/** A string of `n` four-byte characters: the most bytes a name or a line of that many characters can have. */
const WIDE = (n: number): string => "\u{1F600}".repeat(n);

/** The fullest group scene a system text can show: the longest title, 20 Agents, 30 people, each with the longest names, handles, intros and appellations. */
function fullScene(): GroupScene {
  const handle = "a".repeat(49); // <owner's handle (24)>.<name part (24)>
  return {
    title: WIDE(60),
    agents: Array.from({ length: GROUP_AGENTS_NAMED }, () => ({ name: WIDE(AGENT_NAME_MAX), handle, intro: WIDE(40) })),
    more: true,
    people: Array.from({ length: GROUP_PEOPLE_NAMED }, () => ({ name: WIDE(DISPLAY_NAME_MAX), handle, role: "你的主人" as const, appellation: WIDE(20) })),
    morePeople: true,
  };
}

/**
 * The most a plain reply of `agent` to another person can hold: `othersFloorHold` at the most input bytes ADMISSION CAN COMPUTE for it
 * (`holdTokens` counts utf-8 bytes of the system text and of every message part, at most the model's context beside its output, plus
 * the images' and PDFs' constants: port-impl.ts `begin`, the `held` sum). What is unknown before the reply is only what the plan lets
 * in, and each part has a bound of its own:
 * - the system text: the one `begin` builds (`groupSystemText`) with the Agent's real persona and the owner's name and the FULLEST scene,
 *   a mark and a roster of the most names there can be (the scene and the people are capped by `GROUP_AGENTS_NAMED`, `GROUP_PEOPLE_NAMED`
 *   and the schemas' name lengths, at four bytes a character); and a social conversation's (`socialSystemText`) with the longest
 *   names it can show (two owners and an Agent for the other party, each at the schemas' limits, four bytes a character): the bound is
 *   the LONGER of the two texts, so it is an upper bound for a reply in either place (the longer is a pinned fact of the test, not a hope);
 * - the notes passage, appended to it: at most what the Agent's stored notes make (`notesPassage` of ALL of them, hearsay of every
 *   group, in the longer of the group's and the social form: a place is shown a subset of these, and a subset's passage is never longer) and at most
 *   `passageBudget` weight (`fitNotes`, port-impl.ts:728), a weight being at most 3 bytes (`weight`, metering/tokens.ts);
 * - the rolling summary, the system text's last passage (`withSummary`): its fixed heading and line and at most `MEMORY.summaryMaxWeight`
 *   weight as shown, so at most 3 bytes a weight;
 * - the conversation: the plan keeps messages (labels, quotes and attachments' estimates counted: `shown`, `ContextPlan`, agents/context.ts)
 *   to at most the place's cap in estimated tokens, an estimate being its weight times a ratio of at least 1 (`planRatio`), so the text
 *   a plan keeps weighs at most the cap and has at most 3 bytes a weight, attachments' constants (`fixedTokens`, a part of that estimate)
 *   included: at most 3 x the cap in text bytes and at most the cap in constants (added after the clamp, as admission does). The cap is the largest that applies to an others' reply: `AGENT_GROUP_CONTEXT_TOKENS` in a group,
 *   `OTHERS.contextWeight` in a social conversation (agents/context.ts `loadContext`, port-impl.ts:769).
 * A reply `告诉他们` (toldPassage) is the owner's own, never an others' call. Nothing else is sent: a plain call has no tools, no replayed
 * calls (the Agent's own conversation only), no greeting.
 */
export async function othersPlainCeiling(
  q: Queryable,
  config: Pick<Config, "siteModels" | "siteTimezone" | "memory" | "agentGroupContextTokens"> & LevelConfig,
  agent: { id: string; name: string; handle: string; persona: string; ownerId: string; memory: boolean; sharedNotes: boolean; model: AgentModel; othersReasoning: ReasoningLevel; proactiveReasoning: ReasoningLevel },
  now: Date,
): Promise<bigint> {
  if (agent.model?.source !== "site") return 0n;
  const site = config.siteModels.find((m) => m.id === (agent.model as { id: string }).id);
  if (!site) return 0n;
  const owner = await q.query<{ display_name: string }>("select display_name from principals where id = $1", [agent.ownerId]);
  const ownerName = owner.rows[0]?.display_name ?? "";
  const grouped = groupSystemText({ name: agent.name, handle: agent.handle, persona: agent.persona, bare: "a".repeat(24) }, { displayName: ownerName }, fullScene(), now, config.siteTimezone, "abcdef", false, NO_NOTES, false).text;
  const handle = "a".repeat(49);
  const social = socialSystemText(
    { name: agent.name, handle: agent.handle, persona: agent.persona },
    [{ displayName: ownerName }, { displayName: WIDE(DISPLAY_NAME_MAX) }],
    { name: WIDE(DISPLAY_NAME_MAX), handle, kind: "agent" },
    now,
    config.siteTimezone,
    "abcdef",
    NO_NOTES,
    false,
  ).text;
  const system = Buffer.byteLength(grouped, "utf8") >= Buffer.byteLength(social, "utf8") ? grouped : social;
  // (The output limit at the level such replies run at: what `begin` leaves room beside, so what the notes' budget is computed with.)
  const maxOutput = othersOutputLimit(config, site.maxOutputTokens, site.contextTokens, siteLevel(site, agent.othersReasoning));
  // Notes: a superset of any place's (the owner's whole view: everything), shown in the group's form.
  const all = await notesFor(q, agent, { conversationId: "", group: false });
  const everything = { owner: all.owner, self: all.self, hearsay: all.hearsay.map((h) => ({ speakerName: h.speakerName, text: h.text, saidAt: h.saidAt, group: "" })) };
  const stored = Math.max(
    Buffer.byteLength(notesPassage(everything, "group", config.siteTimezone, ownerName), "utf8"),
    Buffer.byteLength(notesPassage(everything, "social", config.siteTimezone, ownerName), "utf8"),
  );
  const notes = Math.min(stored, 3 * Math.floor(passageBudget(site.contextTokens, maxOutput, config.memory.passageShare)));
  const summary = Buffer.byteLength(`${SUMMARY_HEADING}${SUMMARY_SAID_BY}`, "utf8") + 3 * config.memory.summaryMaxWeight + 16;
  const conversation = 3 * Math.max(config.agentGroupContextTokens, config.others.contextWeight);
  // The notes passage, its two separator bytes and the clause the secrets sentence gains with notes (`NOTES_SECRET_CLAUSE`).
  const noted = notes > 0 ? notes + 2 + Buffer.byteLength(NOTES_SECRET_CLAUSE, "utf8") : 0;
  // The text clamps at the context beside the output; the images' and PDFs' constants (at most the cap) are added after the clamp.
  const constants = Math.max(config.agentGroupContextTokens, config.others.contextWeight);
  return othersFloorHold(config, agent.model, Buffer.byteLength(system, "utf8") + noted + summary + conversation, constants, agent.othersReasoning);
}

/**
 * What the owner's page may say of an Agent's room, two one-sided facts (a future reply's hold is not knowable, so one boolean cannot
 * be exact), each by the function admission asks (`othersCheck`, no lock):
 * - `reached`: true ONLY IF every call would be refused: the answers are used up, or what is left is below the floor
 *   (`othersPlainFloor`, a lower bound of any hold admission can compute for the Agent) and the verdict is a `limit`. Never true while a
 *   reply could be admitted. (Waiting behind other replies' holds is not refused, `heldBackBy`; and the owner's points are looked at
 *   before the Agent's own number, so an Agent whose own number is spent can read not reached while another reply holds the owner's:
 *   admission then waits and refuses, as the same function says.)
 * - `tight`: true IF a reply COULD be refused for size: what is left (holds counted) is below the ceiling (`othersPlainCeiling`: the largest hold admission can compute for a plain reply of this Agent, proved part by part there).
 *   False means every plain reply fits. `reached` implies `tight`.
 * `askable` false: no model, or a site model the site no longer has: it can answer nobody, whatever the room; the page leaves it out.
 */
export async function agentRoom(
  q: Queryable,
  config: Pick<Config, "siteTimezone" | "siteModels" | "memory" | "agentGroupContextTokens"> & LevelConfig,
  agent: { id: string; ownerId: string; name: string; handle: string; persona: string; memory: boolean; sharedNotes: boolean; model: AgentModel; othersReasoning: ReasoningLevel; proactiveReasoning: ReasoningLevel },
  now: Date,
): Promise<{ askable: boolean; reached: boolean; tight: boolean }> {
  if (agent.model === null) return { askable: false, reached: false, tight: false };
  if (agent.model.source === "site" && !config.siteModels.some((m) => m.id === (agent.model as { id: string }).id)) return { askable: false, reached: false, tight: false };
  const run = { id: NO_RUN, ownerId: agent.ownerId, agentId: agent.id, lane: "others" as const };
  const floor = await othersCheck(q, config, run, await othersPlainFloor(q, config, agent, null, now, "others"), "admission", now);
  const reached = !floor.ok && "limit" in floor;
  if (reached) return { askable: true, reached: true, tight: true };
  const ceiling = await othersCheck(q, config, run, await othersPlainCeiling(q, config, agent, now), "admission", now);
  return { askable: true, reached: false, tight: !ceiling.ok };
}
