import { lockAccount, MICRO_PER_POINT, nextSiteMidnight, siteDayStart } from "../accounts/store.ts";
import type { Config, ReasoningLevel, SiteModel } from "../config.ts";
import type { Queryable, Tx } from "../db.ts";
import { callLevel, outputLimit, sendableLevels } from "../models/resolve.ts";
import { costMicro } from "./prices.ts";

/**
 * Others' use of an owner's Agents (README "Agent social", One number): ONE number per owner, N — the most points a site day that
 * what people other than the owner cause on all of the owner's Agents may use, in both lanes they cause (`others`: someone else
 * called; `proactive`: nobody did) — the account's own (`accounts.others_points_micro`), else `OTHERS.pointsPerDay` (300).
 *
 * One measure, "others' use today" (`othersUseToday`), read by admission, by every refusal at a call and by the owner's page: the
 * wallet charges settled today for replies of those lanes (their model points and their web searches alike), plus a nominal
 * `OWN_KEY_NOMINAL_MICRO` — counted, never charged — for each reply chain on the owner's own provider key admitted today (a chain:
 * an original call and its automatic retries; failed attempts too), so that an Agent on its owner's own key cannot be used by others
 * without bound.
 *
 * Admission is the whole rule (`othersAdmissible`): under the owner's account lock a reply of those lanes is admitted while the
 * measure is below N, N as it is at that moment. Nothing is reserved against N: an admitted reply always finishes and settles, so a
 * day may pass N by what the replies in flight cost.
 */

export type OthersLane = "others" | "proactive";

/** The lanes somebody other than the owner causes. */
const OTHERS_LANES: readonly OthersLane[] = ["others", "proactive"];

/** What one reply chain on the owner's own provider key counts toward N: 6 points (the old 300 points over the old 50 answers). */
export const OWN_KEY_NOMINAL_MICRO = 6n * MICRO_PER_POINT;

/** The owner's N in micro-points: the account's own, else the configuration's. */
export async function othersLimitOf(q: Queryable, config: Pick<Config, "others">, ownerId: string): Promise<bigint> {
  const { rows } = await q.query<{ points: string | null }>("select others_points_micro::text as points from accounts where principal_id = $1", [ownerId]);
  const own = rows[0]?.points ?? null;
  return own === null ? BigInt(config.others.pointsPerDay) * MICRO_PER_POINT : BigInt(own);
}

/**
 * Others' use of `ownerId`'s Agents in the site day `now` is in, in micro-points (the module's one measure): settled charges of their
 * replies of both lanes (or of `lane` alone) plus `OWN_KEY_NOMINAL_MICRO` for each chain of theirs on a provider's model admitted that day.
 * No lock: under the caller's, or advisory.
 */
export async function othersUseToday(q: Queryable, config: Pick<Config, "siteTimezone">, ownerId: string, now: Date, lane?: OthersLane): Promise<bigint> {
  const { rows } = await q.query<{ n: string }>(
    `select ((select coalesce(sum(u.free_micro + u.balance_micro), 0)
                from usage_records u join agent_runs r on r.id = u.run_id
               where u.owner_id = $1 and u.created_at >= $2 and u.created_at < $3 and r.purpose = 'reply' and r.lane = any($4::text[]))
           + $5::bigint * (select count(distinct coalesce(r.retry_of, r.id))
                             from agent_runs r
                            where r.owner_id = $1 and r.purpose = 'reply' and r.lane = any($4::text[]) and r.source = 'provider'
                              and r.admitted_at >= $2 and r.admitted_at < $3))::text as n`,
    [ownerId, siteDayStart(now, config.siteTimezone, 0), nextSiteMidnight(now, config.siteTimezone), lane ? [lane] : OTHERS_LANES, OWN_KEY_NOMINAL_MICRO.toString()],
  );
  return BigInt(rows[0]!.n);
}

/** Whether others' use today has reached the owner's N (no lock: what a call is refused by before any run exists). */
export async function othersReached(q: Queryable, config: Pick<Config, "others" | "siteTimezone">, ownerId: string, now: Date): Promise<boolean> {
  return (await othersUseToday(q, config, ownerId, now)) >= (await othersLimitOf(q, config, ownerId));
}

/**
 * THE admission rule for a reply somebody other than the owner caused: takes the owner's account lock, then true while others' use
 * today is below N (both read under it). Also what a reply nobody asked for is decided by where it is acted on, and a web search of
 * such a reply before it is made.
 */
export async function othersAdmissible(t: Tx, config: Pick<Config, "others" | "siteTimezone">, ownerId: string, now: Date): Promise<boolean> {
  await lockAccount(t, ownerId);
  return !(await othersReached(t, config, ownerId, now));
}

/** A reply refused at admission because others' use today has reached its owner's N. */
export class OthersLimit extends Error {
  constructor() {
    super("others' use of the owner's Agents has reached its daily number");
    this.name = "OthersLimit";
  }
}

/** One person whose calls the owner's Agents answered today, and what that used (`othersByPerson`). */
export interface PersonUse {
  person: { id: string; handle: string; displayName: string; avatarVersion: number };
  pointsMicro: bigint;
}

/**
 * The people whose calls the owner's replies of lane `others` answered today (a reply admitted today with them as its caller), each with
 * what their replies used by the one measure (settled charges, and the nominal count of a chain on a provider's model — each chain
 * once, for the caller of its latest attempt of today, so the rows never add up to more than the total), most first, then by id. A reply
 * nobody asked for has no caller, and one whose caller is gone names nobody: both are in the owner's total and in no row.
 */
export async function othersByPerson(q: Queryable, config: Pick<Config, "siteTimezone">, ownerId: string, now: Date): Promise<PersonUse[]> {
  const { rows } = await q.query<{ id: string; handle: string; name: string; avatar_version: number; points: string }>(
    `with chain as (
       -- Each reply chain on the owner's key once, for the person whose call its latest attempt of today answers.
       select distinct on (coalesce(r.retry_of, r.id)) r.caller_id
         from agent_runs r
        where r.owner_id = $1 and r.purpose = 'reply' and r.lane = 'others' and r.source = 'provider' and r.admitted_at >= $2 and r.admitted_at < $3
        order by coalesce(r.retry_of, r.id), r.admitted_at desc, r.id desc),
     chains as (
       select caller_id, count(*) * $4::bigint as nominal from chain where caller_id is not null group by caller_id),
     settled as (
       select r.caller_id, sum(u.free_micro + u.balance_micro) as micro
         from usage_records u join agent_runs r on r.id = u.run_id
        where u.owner_id = $1 and u.created_at >= $2 and u.created_at < $3 and r.purpose = 'reply' and r.lane = 'others' and r.caller_id is not null
        group by r.caller_id)
     select p.id, p.handle::text as handle, p.display_name as name, p.avatar_version,
            (coalesce(s.micro, 0) + coalesce(c.nominal, 0))::text as points
       from principals p
       left join chains c on c.caller_id = p.id left join settled s on s.caller_id = p.id
      where c.caller_id is not null or s.caller_id is not null
      order by coalesce(s.micro, 0) + coalesce(c.nominal, 0) desc, p.id`,
    [ownerId, siteDayStart(now, config.siteTimezone, 0), nextSiteMidnight(now, config.siteTimezone), OWN_KEY_NOMINAL_MICRO.toString()],
  );
  return rows.map((r) => ({ person: { id: r.id, handle: r.handle, displayName: r.name, avatarVersion: r.avatar_version }, pointsMicro: BigInt(r.points) }));
}

/**
 * The level setting that applies to a reply of `lane` that is not the owner's own (Owner decision 2026-11-26): the Agent's
 * `proactiveReasoning` for a reply nobody asked for, its `othersReasoning` for every other (a co-member's call, a visitor's).
 */
export const othersWanted = (agent: { othersReasoning: ReasoningLevel; proactiveReasoning: ReasoningLevel }, lane: string): ReasoningLevel =>
  lane === "proactive" ? agent.proactiveReasoning : agent.othersReasoning;

/**
 * The most one reply to somebody other than the owner can cost on site model `site` at `level` (its effective level there): what the
 * owner's page says under each of the two level selects. Each of its model calls at the most one call can cost — the whole context beside
 * the level's output limit in, that limit out, at the model's prices — two of them when it may be offered tools (its one tool round and its
 * last call), else one; and, when it may search the web (`webSearchMicro`: one search's price), as many searches as its one tool round may
 * make (`OTHERS.toolCalls`, at most the reply's `TOOLS.web.perReply`). Shown, never reserved: no reply is held to it.
 */
export function othersReplyCeilingMicro(
  config: Pick<Config, "reasoningAllowanceTokens" | "tools" | "others">,
  site: Pick<SiteModel, "protocol" | "reasoning" | "maxOutputTokens" | "contextTokens" | "inputMicroPerToken" | "outputMicroPerToken" | "tools">,
  level: ReasoningLevel,
  webSearchMicro: bigint | null,
): bigint {
  const run = callLevel(sendableLevels(site.protocol, site.reasoning), level);
  const out = outputLimit(site.maxOutputTokens, site.contextTokens, run, config.reasoningAllowanceTokens);
  const call = costMicro(site, Math.max(0, site.contextTokens - out), out);
  const tools = config.tools.enabled && site.tools;
  const searches = tools && webSearchMicro !== null ? BigInt(Math.min(config.others.toolCalls, config.tools.web.perReply)) * webSearchMicro : 0n;
  return (tools ? 2n : 1n) * call + searches;
}
