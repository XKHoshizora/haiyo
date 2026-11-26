import { MICRO_PER_POINT, siteDay } from "../../../accounts/store.ts";
import type { Config } from "../../../config.ts";
import type { Db, Tx } from "../../../db.ts";
import type { ChargeTo } from "../../../metering/admit.ts";
import { othersAdmissible } from "../../../metering/others.ts";
import { fuseCost, inBand, searchCharge, tool } from "../../../metering/pool.ts";
import { classOf, lockPots, readParts } from "../../../metering/wallet.ts";
import { budgetReachedWith, type Lane } from "../../runs.ts";
import type { AgentRow } from "../../store.ts";
import { WEB_LANE_BUDGET, WEB_NO_MONEY, WEB_REPLY_CAP, WEB_SITE_DAY, WEB_UNAVAILABLE } from "./words.ts";

/**
 * The web search's pre-hold (lane websearch; the product owner's rules, lane websearch2; README "Metering", A web search's
 * price): a search is held at `TOOLS.web.pointsMicroPerSearch` before the engine is called, in one transaction in the
 * project's lock order — the run's conversation row, its Agent's row and its own (the caller's `lockRun`), then the
 * owner's account (wallet.ts `lockPots`), and only then the site's money fuse — the one row every pre-hold shares, held for the
 * short rest of the transaction and never while an account is waited for (no other path takes it, so the order stays
 * acyclic). Refused at any step, the transaction rolls back (the hold is as it was, nothing is counted) and the engine is
 * not called; the reply goes on. No count per owner: the points are the bound.
 */

/**
 * Which bound refused a search at the pre-hold — each its own words for the model and its own metric (port-impl.ts
 * `holdSearch`), so what bites after go-live can be read off the log: the reply's `TOOLS.maxPoints` (`reply_cap`), a
 * budget of its lane (`lane_budget`: the others' daily, the proactive daily, the chain budget), the owner's points
 * (`no_points`: the source cannot cover the price), the site's money fuse (`site_fuse`); `unavailable`: the run is not one
 * a search can be held for.
 */
export type RefusedBy = "reply_cap" | "lane_budget" | "no_points" | "site_fuse" | "unavailable";

const REFUSED_WORDS: Readonly<Record<RefusedBy, string>> = {
  reply_cap: WEB_REPLY_CAP,
  lane_budget: WEB_LANE_BUDGET,
  no_points: WEB_NO_MONEY,
  site_fuse: WEB_SITE_DAY,
  unavailable: WEB_UNAVAILABLE,
};

/** A refusal of the pre-hold: by which bound, and its plain words for the model (`{error}`). Thrown inside the transaction, so it rolls back. */
export class SearchRefused extends Error {
  readonly why: string;
  constructor(readonly by: RefusedBy) {
    super("web search refused before the engine was called");
    this.name = "SearchRefused";
    this.why = REFUSED_WORDS[by];
  }
}

/** The fuse's row of a site day: `web_search_days` scope `site` (rows of another scope are the first version's, unused). */
export const SITE_SCOPE = "site";

/**
 * What a pre-hold that held tells its caller: the site day its fuse counted, the estimate it held there, whether the day's
 * money reached 80 % of the fuse with it, and the run and the price it was held at (what its charge is lowered from once
 * the engine says what the call cost: `recordSearchCost`).
 */
export interface HeldSearch {
  day: string;
  estimateMicroUsd: bigint;
  /** This search took the day's money to 80 % of the fuse first today (`mark80`): the operator's metric line is due. */
  at80: boolean;
  runId: string;
  priceMicro: bigint;
}

/** The site's money fuse a day, in micro-USD (`TOOLS.web.siteUsdPerDay`). */
export const fuseMicroUsd = (web: Pick<Config["tools"]["web"], "siteUsdPerDay">): bigint => BigInt(Math.round(web.siteUsdPerDay * 1_000_000));

/**
 * Marks today's fuse row (`day`) as having reached 80 % of `fuse`, the first time its money is there: whether this call
 * marked it (`warned_80`, migration 065) — once a site day, whatever corrections come after. Under the row's lock the
 * caller's statement before took, in its transaction.
 */
async function mark80(t: Tx, day: string, fuse: bigint): Promise<boolean> {
  const { rowCount } = await t.query(
    "update web_search_days set warned_80 = true where scope = $1 and day = $2::date and not warned_80 and 5 * spent_micro_usd >= 4 * $3::bigint",
    [SITE_SCOPE, day, fuse.toString()],
  );
  return rowCount === 1;
}

/**
 * Takes `estimate` micro-USD of today's fuse (the site day `day`) for one search, unless the day's money would pass
 * `fuse`: the day's money before and after and whether this search marked 80 % of it first today, or null when it would
 * pass. One statement: two connections racing for the fuse's last search are put in order by the row's lock, and the one
 * that comes second reads the first one's money.
 */
export async function takeFuse(t: Tx, day: string, estimate: bigint, fuse: bigint): Promise<{ before: bigint; after: bigint; at80: boolean } | null> {
  if (estimate > fuse) return null;
  const { rows } = await t.query<{ spent: string }>(
    `insert into web_search_days as d (scope, day, searches, spent_micro_usd) values ($1, $2::date, 1, $3)
     on conflict (scope, day) do update set searches = d.searches + 1, spent_micro_usd = d.spent_micro_usd + $3
       where d.spent_micro_usd + $3 <= $4
     returning d.spent_micro_usd::text as spent`,
    [SITE_SCOPE, day, estimate.toString(), fuse.toString()],
  );
  if (!rows[0]) return null;
  const after = BigInt(rows[0].spent);
  return { before: after - estimate, after, at80: await mark80(t, day, fuse) };
}

/**
 * After the engine answered a search the pre-hold held (`held`), by what the engine said the call cost the site
 * (`actual`, Exa's `costDollars`; undefined: it said nothing), believed inside the trusted band — from a tenth of the
 * estimate (rounded up) to ten times it (pool.ts `inBand`, design-wallet-v3.md §5):
 * - the owner's charge for it (`web_charge_micro`, the price until now) is lowered to the price scaled by the actual,
 *   rounded up, never above the price (pool.ts `searchCharge`) — only while its hold stands (`running`, not settled: a
 *   settled run keeps what it was charged, its `hold_micro` zeroed), under its row's lock;
 * - the day's money in the site's fuse takes the actual in place of the estimate, never below 0 (pool.ts `fuseCost`).
 * Outside the band, or with no figure, the price and the estimate stand: a bogus low figure neither undercharges the
 * owner nor weakens the fuse. In one transaction, the run's row first and the fuse's last (the pre-hold's order).
 * `ignored`: a figure outside the band; `at80`: the correction marked 80 % of the fuse first today (an upward one only can).
 */
export async function recordSearchCost(db: Db, held: HeldSearch, actual: bigint | undefined, fuse: bigint): Promise<{ ignored: boolean; at80: boolean }> {
  const figure = actual ?? null;
  const ignored = figure !== null && !inBand(held.estimateMicroUsd, figure);
  const lower = held.priceMicro - searchCharge(held.priceMicro, held.estimateMicroUsd, figure);
  const delta = fuseCost(held.estimateMicroUsd, figure) - held.estimateMicroUsd;
  if (lower === 0n && delta === 0n) return { ignored, at80: false };
  return db.tx(async (t) => {
    if (lower > 0n) {
      await t.query(
        `update agent_runs set web_charge_micro = web_charge_micro - $2::bigint
          where id = $1 and status = 'running' and hold_micro > 0 and money_rule = 1 and web_charge_micro >= $2::bigint`,
        [held.runId, lower.toString()],
      );
    }
    if (delta === 0n) return { ignored, at80: false };
    const { rowCount } = await t.query("update web_search_days set spent_micro_usd = greatest(0, spent_micro_usd + $3) where scope = $1 and day = $2::date", [
      SITE_SCOPE,
      held.day,
      delta.toString(),
    ]);
    return { ignored, at80: rowCount === 1 && delta > 0n && (await mark80(t, held.day, fuse)) };
  });
}

/**
 * The pre-hold of one search of run `run` (locked by the caller under `lockRun`, still running), in this order:
 * 1. the run must be admitted by the pool's rule (`money_rule` 1): on a site model (its class, `charge_to`), or on a
 *    provider's model (no class: its model costs nothing) — else refused (`unavailable`);
 * 2. the money, each bound its own refusal (`RefusedBy`): the model part of the reply so far at its bound (a site model's
 *    hold, less the room kept on `AB` for a last call, `reserveMicro`, and less its searches; 0 for a provider's model),
 *    with what its searches are charged so far and this one's price, within `TOOLS.maxPoints` (`reply_cap`); no chain budget
 *    reached (runs.ts `budgetReachedWith`; `lane_budget`), and for a reply somebody other than the owner caused, others' use
 *    of the owner's Agents today still below the owner's one number (metering/others.ts `othersAdmissible`, the measure
 *    admission decides by, under the account lock; `lane_budget`); and the price held whole on the owner's pots beside every promise (pool.ts
 *    `tool`, class `AB` whatever the model's tier — the allowance first at settlement —, under the account lock: so a
 *    search is never paid by forgiveness; `no_points`);
 * 3. today's money fuse of the whole site (`takeFuse`, at the configured estimate) — past it, refused (`site_fuse`, and
 *    all of the above given back);
 * 4. `web_searches + 1`, `web_micro + price`, `web_charge_micro + price` and `hold_micro + price` on the run, in one
 *    statement.
 * Throws `SearchRefused` for a refusal (the caller's transaction then rolls back); else what the fuse held (`HeldSearch`).
 */
export async function holdSearch(
  t: Tx,
  config: Pick<Config, "freeDailyMicro" | "siteTimezone" | "tools" | "others">,
  o: {
    run: { id: string; ownerId: string; conversationId: string };
    agent: Pick<AgentRow, "id" | "conversationId" | "chainBudgetMicro">;
    lane: { lane: Lane; coversSeq: number };
    /** The room the reply keeps on the free allowance for its last call (port-impl.ts `RunMoney.reserveMicro`). */
    reserveMicro: bigint;
  },
  now: Date,
): Promise<HeldSearch> {
  const web = config.tools.web;
  const { rows } = await t.query<{ source: string | null; charge_to: ChargeTo | null; money_rule: number; hold: string; web: string; web_charge: string }>(
    "select source, charge_to, money_rule, hold_micro::text as hold, web_micro::text as web, web_charge_micro::text as web_charge from agent_runs where id = $1",
    [o.run.id],
  );
  const row = rows[0];
  const site = row?.source === "site";
  const admitted = site ? row?.charge_to === "free" || row?.charge_to === "balance" : row?.source === "provider" && row.charge_to === null;
  if (!row || Number(row.money_rule) !== 1 || !admitted) throw new SearchRefused("unavailable");
  const price = BigInt(web.pointsMicroPerSearch);
  const hold = BigInt(row.hold);
  const searched = BigInt(row.web);
  // The room kept for the last call on the free allowance.
  const reserve = site && row.charge_to !== null && classOf(row.charge_to as "free" | "balance") === "AB" ? o.reserveMicro : 0n;
  const model = site && hold - reserve - searched > 0n ? hold - reserve - searched : 0n;
  const spent = model + BigInt(row.web_charge) + price;
  if (spent > BigInt(config.tools.maxPoints) * MICRO_PER_POINT) throw new SearchRefused("reply_cap");
  if (await budgetReachedWith(t, { conversationId: o.run.conversationId, ...o.lane }, o.agent, spent)) {
    throw new SearchRefused("lane_budget");
  }
  // A reply somebody other than the owner caused: while others' use of the owner's Agents today is below the owner's one number.
  if (o.lane.lane !== "own" && !(await othersAdmissible(t, config, o.run.ownerId, now))) throw new SearchRefused("lane_budget");
  const { pots } = await lockPots(t, config, o.run.ownerId, now);
  if (tool(pots, await readParts(t, o.run.ownerId), { run: o.run.id, cls: "AB", x: price }) === null) throw new SearchRefused("no_points");
  // Last of the rows it takes: the site's (see above).
  const day = siteDay(now, config.siteTimezone);
  const estimate = BigInt(web.costMicroUsdPerSearch);
  const fuse = fuseMicroUsd(web);
  const taken = await takeFuse(t, day, estimate, fuse);
  if (taken === null) throw new SearchRefused("site_fuse");
  await t.query(
    `update agent_runs set web_searches = web_searches + 1, web_micro = web_micro + $2::bigint, web_charge_micro = web_charge_micro + $2::bigint,
            hold_micro = hold_micro + $2::bigint
      where id = $1`,
    [o.run.id, price.toString()],
  );
  return { day, estimateMicroUsd: estimate, at80: taken.at80, runId: o.run.id, priceMicro: price };
}

/** How many site days of counts are kept: today and the 7 before it. */
export const COUNT_DAYS_KEPT = 7;

/**
 * Deletes the counter rows of site days more than `COUNT_DAYS_KEPT` before today (`siteDay`), of every scope (the change
 * sweep, app.ts `changeSweep`): a count means nothing once its day is over. How many went.
 */
export async function sweepSearchDays(db: Pick<Tx, "query">, now: Date, timeZone: string): Promise<number> {
  const { rowCount } = await db.query("delete from web_search_days where day < $1::date - $2::int", [siteDay(now, timeZone), COUNT_DAYS_KEPT]);
  return rowCount ?? 0;
}
