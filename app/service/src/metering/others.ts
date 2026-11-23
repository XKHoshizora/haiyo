import { lockAccount, MICRO_PER_POINT, nextSiteMidnight, siteDayStart } from "../accounts/store.ts";
import type { Lane } from "../agents/runs.ts";
import type { AgentModel } from "../agents/store.ts";
import type { Config } from "../config.ts";
import type { Queryable, Tx } from "../db.ts";
import { groupSystemText, NO_NOTES, type GroupScene } from "../agents/runtime/prompt.ts";
import type { Resolved } from "../models/resolve.ts";
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

/**
 * The model as an others' reply calls it (plan B2a): every call at most `OTHERS.outputTokens` of output and reasoning
 * `none`. What admission holds for, what the context plan leaves room beside, and what the call is sent at — one `Resolved`.
 */
export function boundedForOthers<R extends Pick<Resolved, "call" | "reasoning">>(resolved: R, outputTokens: number): R {
  return { ...resolved, reasoning: "none", call: { ...resolved.call, maxOutputTokens: Math.min(resolved.call.maxOutputTokens, outputTokens) } };
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
 * admission holds by, without a last call. 0 for a provider's own model (it holds nothing).
 */
export function othersFloorHold(config: Pick<Config, "siteModels" | "others">, model: { source: string; id?: string } | null, inputBytes: number): bigint {
  if (model?.source !== "site") return 0n;
  const site = config.siteModels.find((m) => m.id === model.id);
  if (!site) return 0n;
  const maxOutputTokens = Math.min(site.maxOutputTokens, config.others.outputTokens);
  const priced = { source: "site", price: { inputMicroPerToken: site.inputMicroPerToken, outputMicroPerToken: site.outputMicroPerToken }, call: { maxOutputTokens } } as unknown as Pick<
    Resolved,
    "price" | "call" | "source"
  >;
  return othersHold(priced, Math.max(0, Math.min(inputBytes, site.contextTokens - maxOutputTokens)), null);
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
    out.set(id, { answers: answers.answers, pointsMicro: points.settledMicro + points.heldMicro });
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
  config: Pick<Config, "siteModels" | "others">,
  model: AgentModel,
  numbers: { owner: OthersNumbers; agent: { answers: number | null; pointsMicro: bigint | null } },
): number {
  if (model === null) return 0;
  const answers = BigInt(Math.min(numbers.owner.answers, numbers.agent.answers ?? Number.MAX_SAFE_INTEGER));
  if (model.source !== "site") return Number(answers);
  const site = config.siteModels.find((m) => m.id === model.id);
  if (!site) return 0;
  const points = numbers.agent.pointsMicro !== null && numbers.agent.pointsMicro < numbers.owner.pointsMicro ? numbers.agent.pointsMicro : numbers.owner.pointsMicro;
  const plainHold = othersFloorHold(config, model, PLAIN_REPLY_INPUT_TOKENS);
  if (points < plainHold) return 0;
  const plainCost = BigInt(PLAIN_COST_INPUT_TOKENS) * BigInt(site.inputMicroPerToken) + BigInt(PLAIN_COST_OUTPUT_TOKENS) * BigInt(site.outputMicroPerToken);
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
 * 0 for a provider's own model. (A social reply's text, B7a, is a separate one; its floor is not claimed here.)
 */
export async function othersPlainFloor(
  q: Queryable,
  config: Pick<Config, "siteModels" | "others" | "siteTimezone">,
  agent: { name: string; handle: string; persona: string; ownerId: string; model: AgentModel },
  scene: GroupScene | null,
  now: Date,
): Promise<bigint> {
  if (agent.model?.source !== "site") return 0n;
  const owner = await q.query<{ display_name: string }>("select display_name from principals where id = $1", [agent.ownerId]);
  const text = groupSystemText(
    { name: agent.name, handle: agent.handle, persona: agent.persona, bare: null },
    { displayName: owner.rows[0]?.display_name ?? "" },
    scene ?? EMPTY_SCENE,
    now,
    config.siteTimezone,
    "",
    true,
    NO_NOTES,
    false,
  ).text;
  return othersFloorHold(config, agent.model, Buffer.byteLength(text, "utf8"));
}

/** The most a plain reply can hold: the model's whole context beside its output (an input never passes it): the one upper bound that is provable. */
export const othersCeilingHold = (config: Pick<Config, "siteModels" | "others">, model: AgentModel): bigint => othersFloorHold(config, model, Number.MAX_SAFE_INTEGER);

/**
 * What the owner's page may say of an Agent's room, two one-sided facts (a future reply's hold is not knowable, so one boolean cannot
 * be exact), each by the function admission asks (`othersCheck`, no lock):
 * - `reached`: true ONLY IF every call would be refused: the answers are used up, or what is left is below the floor
 *   (`othersPlainFloor`, a lower bound of any hold admission can compute for the Agent) and the verdict is a `limit`. Never true while a
 *   reply could be admitted. (Waiting behind other replies' holds is not refused, `heldBackBy`; and the owner's points are looked at
 *   before the Agent's own number, so an Agent whose own number is spent can read not reached while another reply holds the owner's:
 *   admission then waits and refuses, as the same function says.)
 * - `tight`: true IF a reply COULD be refused for size: what is left (holds counted) is below the ceiling (`othersCeilingHold`).
 *   False means every plain reply fits. `reached` implies `tight`.
 * `askable` false: no model, or a site model the site no longer has: it can answer nobody, whatever the room; the page leaves it out.
 */
export async function agentRoom(
  q: Queryable,
  config: Pick<Config, "others" | "siteTimezone" | "siteModels">,
  agent: { id: string; ownerId: string; name: string; handle: string; persona: string; model: AgentModel },
  now: Date,
): Promise<{ askable: boolean; reached: boolean; tight: boolean }> {
  if (agent.model === null) return { askable: false, reached: false, tight: false };
  if (agent.model.source === "site" && !config.siteModels.some((m) => m.id === (agent.model as { id: string }).id)) return { askable: false, reached: false, tight: false };
  const run = { id: NO_RUN, ownerId: agent.ownerId, agentId: agent.id, lane: "others" as const };
  const floor = await othersCheck(q, config, run, await othersPlainFloor(q, config, agent, null, now), "admission", now);
  const reached = !floor.ok && "limit" in floor;
  if (reached) return { askable: true, reached: true, tight: true };
  const ceiling = await othersCheck(q, config, run, othersCeilingHold(config, agent.model), "admission", now);
  return { askable: true, reached: false, tight: !ceiling.ok };
}
