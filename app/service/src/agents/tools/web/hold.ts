import { MICRO_PER_POINT, siteDay } from "../../../accounts/store.ts";
import type { Config } from "../../../config.ts";
import type { Tx } from "../../../db.ts";
import { raiseHold, type ChargeTo } from "../../../metering/admit.ts";
import { budgetReachedWith, type Lane } from "../../runs.ts";
import type { AgentRow } from "../../store.ts";
import { WEB_NO_MONEY, WEB_OWNER_DAY, WEB_SITE_DAY, WEB_UNAVAILABLE } from "./tool.ts";

/**
 * The web search's pre-hold (lane websearch; README "Metering", A web search's price): a search costs exactly
 * `TOOLS.web.pointsMicroPerSearch`, held before the engine is called, in one transaction in the project's lock order — the
 * run's conversation row, its Agent's row and its own (the caller's `lockRun`), then today's counters (the owner's row,
 * then the site's), then the owner's account (`raiseHold`). Refused at any step, the transaction rolls back (a counter
 * taken is given back) and the engine is not called; the reply goes on.
 */

/** A refusal of the pre-hold: its plain words for the model (`{error}`). Thrown inside the transaction, so it rolls back. */
export class SearchRefused extends Error {
  constructor(readonly why: string) {
    super("web search refused before the engine was called");
    this.name = "SearchRefused";
  }
}

/** The counter scope of the whole site (an owner's is their id). */
export const SITE_SCOPE = "site";

/**
 * Counts one search of today (the site day, `siteDay`) in `scope`'s row, unless it has `cap` already: whether it was
 * counted. One statement: two connections racing for the last search are put in order by the row's lock, and the one
 * that comes second reads the first one's count.
 */
async function countSearch(t: Tx, scope: string, day: string, cap: number): Promise<boolean> {
  const { rowCount } = await t.query(
    `insert into web_search_days as d (scope, day, searches) values ($1, $2::date, 1)
     on conflict (scope, day) do update set searches = d.searches + 1 where d.searches < $3
     returning d.searches`,
    [scope, day, cap],
  );
  return rowCount === 1;
}

/**
 * The pre-hold of one search of run `run` (locked by the caller under `lockRun`, still running), in this order:
 * 1. the run must be admitted on a site model (`source`, `charge_to`) — else refused (never offered otherwise);
 * 2. today's searches: the owner's (`perOwnerPerDay`), then the site's (`sitePerDay`) — over either, refused;
 * 3. the money, by `extend`'s rules but "ok only": the model part of the reply so far at its bound (its hold, less the
 *    free allowance's room for a last call, `reserveMicro`, and less its searches) with its searches and this one within
 *    `TOOLS.maxPoints` and no budget of its lane reached (runs.ts `budgetReachedWith`), and its hold raised by the price
 *    within what is left of its own source beside the other holds (admit.ts `raiseHold` "ok": on the free allowance the
 *    allowance itself, so a search is never paid by forgiveness) — else refused, its hold as it was;
 * 4. `web_searches + 1`, `web_micro + price` on the run.
 * Throws `SearchRefused` for a refusal (the caller's transaction then rolls back).
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
): Promise<void> {
  const web = config.tools.web;
  const { rows } = await t.query<{ source: string | null; charge_to: ChargeTo | null; hold: string; web: string }>(
    "select source, charge_to, hold_micro::text as hold, web_micro::text as web from agent_runs where id = $1",
    [o.run.id],
  );
  const row = rows[0];
  if (!row || row.source !== "site" || (row.charge_to !== "free" && row.charge_to !== "balance")) throw new SearchRefused(WEB_UNAVAILABLE);
  const day = siteDay(now, config.siteTimezone);
  if (!(await countSearch(t, o.run.ownerId, day, web.perOwnerPerDay))) throw new SearchRefused(WEB_OWNER_DAY);
  if (!(await countSearch(t, SITE_SCOPE, day, web.sitePerDay))) throw new SearchRefused(WEB_SITE_DAY);
  const price = BigInt(web.pointsMicroPerSearch);
  const hold = BigInt(row.hold);
  const searched = BigInt(row.web);
  const reserve = row.charge_to === "free" ? o.reserveMicro : 0n;
  const model = hold - reserve - searched > 0n ? hold - reserve - searched : 0n;
  const spent = model + searched + price;
  const allowed =
    spent <= BigInt(config.tools.maxPoints) * MICRO_PER_POINT &&
    !(await budgetReachedWith(t, { conversationId: o.run.conversationId, ...o.lane }, o.agent, spent, config));
  const answer = await raiseHold(t, config, { id: o.run.id, ownerId: o.run.ownerId, chargeTo: row.charge_to, holdMicro: hold }, { ok: hold + price, final: hold }, allowed, now);
  if (answer !== "ok") throw new SearchRefused(WEB_NO_MONEY);
  await t.query("update agent_runs set web_searches = web_searches + 1, web_micro = web_micro + $2::bigint where id = $1", [o.run.id, price.toString()]);
}
