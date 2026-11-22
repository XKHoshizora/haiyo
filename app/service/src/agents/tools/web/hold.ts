import { freeUsedToday, lockAccount, MICRO_PER_POINT, siteDay } from "../../../accounts/store.ts";
import type { Config } from "../../../config.ts";
import type { Queryable, Tx } from "../../../db.ts";
import { headroom, raiseHold, readHolds, type ChargeTo } from "../../../metering/admit.ts";
import { budgetReachedWith, type Lane } from "../../runs.ts";
import type { AgentRow } from "../../store.ts";
import { WEB_NO_MONEY, WEB_SITE_DAY, WEB_UNAVAILABLE } from "./tool.ts";

/**
 * The web search's pre-hold (lane websearch; the product owner's rules, lane websearch2; README "Metering", A web search's
 * price): a search costs exactly `TOOLS.web.pointsMicroPerSearch`, held before the engine is called, in one transaction in
 * the project's lock order — the run's conversation row, its Agent's row and its own (the caller's `lockRun`), then the
 * owner's account (`raiseHold`), and only then the site's money fuse — the one row every pre-hold shares, held for the
 * short rest of the transaction and never while an account is waited for (no other path takes it, so the order stays
 * acyclic). Refused at any step, the transaction rolls back (the hold is as it was, nothing is counted) and the engine is
 * not called; the reply goes on. No count per owner: the points are the bound.
 */

/** A refusal of the pre-hold: its plain words for the model (`{error}`). Thrown inside the transaction, so it rolls back. */
export class SearchRefused extends Error {
  constructor(readonly why: string) {
    super("web search refused before the engine was called");
    this.name = "SearchRefused";
  }
}

/** The fuse's row of a site day: `web_search_days` scope `site` (rows of another scope are the first version's, unused). */
export const SITE_SCOPE = "site";

/** What a pre-hold that held tells its caller: the site day its fuse counted, the estimate it held there, and whether the day's money reached 80 % of the fuse with it. */
export interface HeldSearch {
  day: string;
  estimateMicroUsd: bigint;
  /** This search took the day's money to 80 % of the fuse or past it (`at80`): the operator's metric line is due. */
  at80: boolean;
}

/** The site's money fuse a day, in micro-USD (`TOOLS.web.siteUsdPerDay`). */
export const fuseMicroUsd = (web: Pick<Config["tools"]["web"], "siteUsdPerDay">): bigint => BigInt(Math.round(web.siteUsdPerDay * 1_000_000));

/**
 * Whether moving the day's money from `before` to `after` crossed 80 % of the fuse `fuse`: once a day as the money grows
 * (a correction downwards, `recordSiteCost`, can make it be crossed again).
 */
export const crossed80 = (before: bigint, after: bigint, fuse: bigint): boolean => 5n * before < 4n * fuse && 4n * fuse <= 5n * after;

/**
 * Takes `estimate` micro-USD of today's fuse (the site day `day`) for one search, unless the day's money would pass
 * `fuse`: the day's money before and after, or null when it would pass. One statement: two connections racing for the
 * fuse's last search are put in order by the row's lock, and the one that comes second reads the first one's money.
 */
export async function takeFuse(t: Tx, day: string, estimate: bigint, fuse: bigint): Promise<{ before: bigint; after: bigint } | null> {
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
  return { before: after - estimate, after };
}

/**
 * After the engine answered a search the pre-hold held (`held`): what the engine said the call cost the site (`actual`,
 * Exa's `costDollars`) replaces the estimate in the day's money — never below 0; nothing changes when it said nothing.
 * Whether the correction crossed 80 % of the fuse (an upward one only can).
 */
export async function recordSiteCost(db: Queryable, held: Pick<HeldSearch, "day" | "estimateMicroUsd">, actual: bigint | undefined, fuse: bigint): Promise<boolean> {
  if (actual === undefined || actual === held.estimateMicroUsd) return false;
  const delta = actual - held.estimateMicroUsd;
  const { rows } = await db.query<{ after: string }>(
    `update web_search_days set spent_micro_usd = greatest(0, spent_micro_usd + $3) where scope = $1 and day = $2::date
     returning spent_micro_usd::text as after`,
    [SITE_SCOPE, held.day, delta.toString()],
  );
  if (!rows[0]) return false;
  const after = BigInt(rows[0].after);
  return crossed80(after - delta > 0n ? after - delta : 0n, after, fuse);
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
 *    searches' alone) — else refused;
 * 2. the money, by `extend`'s rules but "ok only": the model part of the reply so far at its bound (a site model's hold,
 *    less the free allowance's room for a last call, `reserveMicro`, and less its searches; 0 for a provider's model),
 *    with its searches and this one, within `TOOLS.maxPoints` and no budget of its lane reached (runs.ts
 *    `budgetReachedWith`, counting the searches its Agent's other replies in the same daily lane hold now: `runningWeb`),
 *    and its hold raised by the price within what is left of its own source beside the other holds (admit.ts `raiseHold`
 *    "ok": on the free allowance the allowance itself, so a search is never paid by forgiveness) — else refused, its hold
 *    as it was;
 * 3. today's money fuse of the whole site (`takeFuse`, at the configured estimate) — past it, refused (and all of the
 *    above given back);
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
  if (!row || !(site ? paid : row.source === "provider" && (paid || row.charge_to === null))) throw new SearchRefused(WEB_UNAVAILABLE);
  const price = BigInt(web.pointsMicroPerSearch);
  const hold = BigInt(row.hold);
  const searched = BigInt(row.web);
  const reserve = site && row.charge_to === "free" ? o.reserveMicro : 0n;
  const model = site && hold - reserve - searched > 0n ? hold - reserve - searched : 0n;
  const spent = model + searched + price;
  const allowed =
    spent <= BigInt(config.tools.maxPoints) * MICRO_PER_POINT &&
    !(await budgetReachedWith(t, { conversationId: o.run.conversationId, ...o.lane }, o.agent, spent, config, { runningWebExcept: o.run.id }));
  const chargeTo = (row.charge_to as "free" | "balance" | null) ?? (allowed ? await webSource(t, config, o.run.ownerId, price, now) : null);
  if (chargeTo === null) throw new SearchRefused(WEB_NO_MONEY);
  const answer = await raiseHold(t, config, { id: o.run.id, ownerId: o.run.ownerId, chargeTo, holdMicro: hold }, { ok: hold + price, final: hold }, allowed, now);
  if (answer !== "ok") throw new SearchRefused(WEB_NO_MONEY);
  // Last of the rows it takes: the site's (see above).
  const day = siteDay(now, config.siteTimezone);
  const estimate = BigInt(web.costMicroUsdPerSearch);
  const fuse = fuseMicroUsd(web);
  const taken = await takeFuse(t, day, estimate, fuse);
  if (taken === null) throw new SearchRefused(WEB_SITE_DAY);
  await t.query(
    "update agent_runs set web_searches = web_searches + 1, web_micro = web_micro + $2::bigint, charge_to = coalesce(charge_to, $3) where id = $1",
    [o.run.id, price.toString(), chargeTo],
  );
  return { day, estimateMicroUsd: estimate, at80: crossed80(taken.before, taken.after, fuse) };
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
