import { freeUsedToday, lockAccount, MICRO_PER_POINT, siteDay } from "../../../accounts/store.ts";
import type { Config } from "../../../config.ts";
import type { Db, Tx } from "../../../db.ts";
import { headroom, raiseHold, readHolds, type ChargeTo } from "../../../metering/admit.ts";
import { budgetReachedWith, type Lane } from "../../runs.ts";
import type { AgentRow } from "../../store.ts";
import { WEB_LANE_BUDGET, WEB_NO_MONEY, WEB_REPLY_CAP, WEB_SITE_DAY, WEB_UNAVAILABLE } from "./words.ts";

/**
 * The web search's pre-hold (lane websearch; the product owner's rules, lane websearch2; README "Metering", A web search's
 * price): a search costs exactly `TOOLS.web.pointsMicroPerSearch`, held before the engine is called, in one transaction in
 * the project's lock order — the run's conversation row, its Agent's row and its own (the caller's `lockRun`), then the
 * owner's account (`raiseHold`), and only then the site's money fuse — the one row every pre-hold shares, held for the
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

/** What a pre-hold that held tells its caller: the site day its fuse counted, the estimate it held there, and whether the day's money reached 80 % of the fuse with it. */
export interface HeldSearch {
  day: string;
  estimateMicroUsd: bigint;
  /** This search took the day's money to 80 % of the fuse first today (`mark80`): the operator's metric line is due. */
  at80: boolean;
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

/** The widest an engine's own report of a call's cost is believed: from a tenth of the estimate to ten times it (beyond, the estimate stands). */
export const COST_TRUST_FACTOR = 10n;

/**
 * After the engine answered a search the pre-hold held (`held`): what the engine said the call cost the site (`actual`,
 * Exa's `costDollars`) replaces the estimate in the day's money — never below 0 — when it is believable: from a tenth of
 * the estimate to ten times it (`COST_TRUST_FACTOR`); nothing changes when it said nothing. In one transaction, the row's
 * lock held for both statements. `ignored`: it said something outside that, and the estimate stands; `at80`: the
 * correction marked 80 % of the fuse first today (an upward one only can).
 */
export async function recordSiteCost(db: Db, held: Pick<HeldSearch, "day" | "estimateMicroUsd">, actual: bigint | undefined, fuse: bigint): Promise<{ ignored: boolean; at80: boolean }> {
  if (actual === undefined || actual === held.estimateMicroUsd) return { ignored: false, at80: false };
  const estimate = held.estimateMicroUsd;
  if (actual * COST_TRUST_FACTOR < estimate || actual > estimate * COST_TRUST_FACTOR) return { ignored: true, at80: false };
  const delta = actual - estimate;
  return db.tx(async (t) => {
    const { rowCount } = await t.query("update web_search_days set spent_micro_usd = greatest(0, spent_micro_usd + $3) where scope = $1 and day = $2::date", [
      SITE_SCOPE,
      held.day,
      delta.toString(),
    ]);
    return { ignored: false, at80: rowCount === 1 && delta > 0n && (await mark80(t, held.day, fuse)) };
  });
}

/**
 * Where a provider model's reply pays for its searches, chosen at its first (its model costs nothing, so admission gave it
 * no source): today's free allowance when what is left of it beside every running hold covers `price`, else the balance
 * when what is left of it does, else none. Under the owner's account lock.
 */
async function webSource(t: Tx, config: Pick<Config, "freeDailyMicro" | "siteTimezone">, ownerId: string, price: bigint, now: Date): Promise<"free" | "balance" | null> {
  const account = await lockAccount(t, ownerId);
  const left = headroom({
    freeDailyMicro: config.freeDailyMicro,
    freeUsedMicro: await freeUsedToday(t, ownerId, now, config.siteTimezone),
    balanceMicro: account.balanceMicro,
    holds: await readHolds(t, ownerId),
  });
  if (left.freeMicro >= price) return "free";
  if (left.balanceMicro >= price) return "balance";
  return null;
}

/**
 * The pre-hold of one search of run `run` (locked by the caller under `lockRun`, still running), in this order:
 * 1. the run must be admitted: on a site model (its source, `charge_to`, admission's), or on a provider's model — whose
 *    first search picks the source its searches are paid from (`webSource`: the free allowance first, then the balance;
 *    none covering the price: refused), kept for its next ones (migration 065: a provider run's `charge_to` is its
 *    searches' alone) — else refused (`unavailable`);
 * 2. the money, by `extend`'s rules but "ok only", each bound its own refusal (`RefusedBy`): the model part of the reply
 *    so far at its bound (a site model's hold, less the free allowance's room for a last call, `reserveMicro`, and less its
 *    searches; 0 for a provider's model), with its searches and this one, within `TOOLS.maxPoints` (`reply_cap`); no
 *    budget of its lane reached (runs.ts `budgetReachedWith`, counting the searches its Agent's other replies in the same
 *    daily lane hold now: `runningWeb`; `lane_budget`); and its hold raised by the price within what is left of its own
 *    source beside the other holds (admit.ts `raiseHold` "ok": on the free allowance the allowance itself, so a search is
 *    never paid by forgiveness; `no_points`) — refused, its hold as it was;
 * 3. today's money fuse of the whole site (`takeFuse`, at the configured estimate) — past it, refused (`site_fuse`, and
 *    all of the above given back);
 * 4. `web_searches + 1`, `web_micro + price` on the run (and a provider run's source).
 * Throws `SearchRefused` for a refusal (the caller's transaction then rolls back); else what the fuse held (`HeldSearch`).
 */
export async function holdSearch(
  t: Tx,
  config: Pick<Config, "freeDailyMicro" | "siteTimezone" | "tools">,
  o: {
    run: { id: string; ownerId: string; conversationId: string };
    agent: Pick<AgentRow, "id" | "conversationId" | "othersBudgetMicro" | "proactiveBudgetMicro" | "chainBudgetMicro">;
    lane: { lane: Lane; coversSeq: number };
    /** The room the reply keeps on the free allowance for its last call (port-impl.ts `RunMoney.reserveMicro`). */
    reserveMicro: bigint;
  },
  now: Date,
): Promise<HeldSearch> {
  const web = config.tools.web;
  const { rows } = await t.query<{ source: string | null; charge_to: ChargeTo | null; hold: string; web: string }>(
    "select source, charge_to, hold_micro::text as hold, web_micro::text as web from agent_runs where id = $1",
    [o.run.id],
  );
  const row = rows[0];
  const site = row?.source === "site";
  const paid = row?.charge_to === "free" || row?.charge_to === "balance";
  if (!row || !(site ? paid : row.source === "provider" && (paid || row.charge_to === null))) throw new SearchRefused("unavailable");
  const price = BigInt(web.pointsMicroPerSearch);
  const hold = BigInt(row.hold);
  const searched = BigInt(row.web);
  const reserve = site && row.charge_to === "free" ? o.reserveMicro : 0n;
  const model = site && hold - reserve - searched > 0n ? hold - reserve - searched : 0n;
  const spent = model + searched + price;
  if (spent > BigInt(config.tools.maxPoints) * MICRO_PER_POINT) throw new SearchRefused("reply_cap");
  if (await budgetReachedWith(t, { conversationId: o.run.conversationId, ...o.lane }, o.agent, spent, config, { runningWebExcept: o.run.id })) {
    throw new SearchRefused("lane_budget");
  }
  const chargeTo = (row.charge_to as "free" | "balance" | null) ?? (await webSource(t, config, o.run.ownerId, price, now));
  if (chargeTo === null) throw new SearchRefused("no_points");
  const answer = await raiseHold(t, config, { id: o.run.id, ownerId: o.run.ownerId, chargeTo, holdMicro: hold }, { ok: hold + price, final: hold }, true, now);
  if (answer !== "ok") throw new SearchRefused("no_points");
  // Last of the rows it takes: the site's (see above).
  const day = siteDay(now, config.siteTimezone);
  const estimate = BigInt(web.costMicroUsdPerSearch);
  const fuse = fuseMicroUsd(web);
  const taken = await takeFuse(t, day, estimate, fuse);
  if (taken === null) throw new SearchRefused("site_fuse");
  await t.query(
    "update agent_runs set web_searches = web_searches + 1, web_micro = web_micro + $2::bigint, charge_to = coalesce(charge_to, $3) where id = $1",
    [o.run.id, price.toString(), chargeTo],
  );
  return { day, estimateMicroUsd: estimate, at80: taken.at80 };
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
