import { lockAccount, MICRO_PER_POINT, nextSiteMidnight, siteDayStart } from "../accounts/store.ts";
import type { Lane } from "../agents/runs.ts";
import type { Config } from "../config.ts";
import type { Queryable, Tx } from "../db.ts";
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

/**
 * The numbers `othersFits` holds an Agent's others' replies to: the owner's (the account's own, else the config's), the
 * Agent's own sub-limits (null: none) and the Agent's proactive budget (a hard sub-cap since B1).
 */
export async function othersNumbers(
  q: Queryable,
  config: Pick<Config, "others">,
  ownerId: string,
  agentId: string,
): Promise<{ owner: OthersNumbers; agent: { answers: number | null; pointsMicro: bigint | null }; proactiveMicro: bigint }> {
  const { rows } = await q.query<{
    owner_answers: number | null;
    owner_points: string | null;
    agent_answers: number | null;
    agent_points: string | null;
    proactive: string;
  }>(
    `select acc.others_answers as owner_answers, acc.others_points_micro::text as owner_points,
            a.others_answers as agent_answers, a.others_budget_micro::text as agent_points, a.proactive_budget_micro::text as proactive
       from agents a left join accounts acc on acc.principal_id = $1
      where a.principal_id = $2`,
    [ownerId, agentId],
  );
  const r = rows[0];
  if (!r) throw new Error(`othersNumbers: ${agentId} is not an Agent`);
  return {
    owner: {
      answers: r.owner_answers ?? config.others.answersPerDay,
      pointsMicro: r.owner_points === null ? BigInt(config.others.pointsPerDay) * MICRO_PER_POINT : BigInt(r.owner_points),
    },
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
  const [answers, points] = await Promise.all([answersToday(q, config, ownerId, now, scope, null), pointsToday(q, config, ownerId, now, scope, null)]);
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
 * Advisory (no lock), at a trigger: whether a number is already reached — the owner's answers or points (settled plus
 * held), the Agent's own answers, its lane's number. A call then reaches nothing. `othersFits` decides for good, at admission.
 */
export async function othersReached(
  q: Queryable,
  config: Pick<Config, "others" | "siteTimezone">,
  ownerId: string,
  agentId: string,
  lane: OthersLane,
  now: Date,
): Promise<boolean> {
  const numbers = await othersNumbers(q, config, ownerId, agentId);
  const owner = await othersUsedToday(q, config, ownerId, now);
  if (owner.answers >= numbers.owner.answers || owner.settledMicro + owner.heldMicro >= numbers.owner.pointsMicro) return true;
  if (numbers.agent.answers !== null && (await othersUsedToday(q, config, ownerId, now, { agentId })).answers >= numbers.agent.answers) return true;
  const own = lane === "others" ? numbers.agent.pointsMicro : numbers.proactiveMicro;
  if (own === null) return false;
  const used = await othersUsedToday(q, config, ownerId, now, { agentId, lane });
  return used.settledMicro + used.heldMicro >= own;
}

/** A run refused by an others' number: which one. */
export class OthersLimit extends Error {
  constructor(readonly limit: "answers" | "points" | "proactive") {
    super(`others' limit reached: ${limit}`);
    this.name = "OthersLimit";
  }
}
