import { freeUsedToday, lockAccount } from "../accounts/store.ts";
import type { Config } from "../config.ts";
import type { Queryable, Tx } from "../db.ts";
import type { Part, PayClass, Pots } from "./pool.ts";

/**
 * The pool's rows (wallet v3, .superpowers/sdd/2026-11-22-polish/design-wallet-v3.md §6; migration 066): how a run row's
 * money is read as the parts of pool.ts, and the payer's pots, both read by admission, `extend`, the tools' pre-holds and
 * settlement under the owner's account lock. The one place a row becomes parts: what admission checks and what settlement
 * splits cannot read a row two ways.
 */

/** A running run's row as the pool reads it. */
export interface PoolRow {
  id: string;
  /** 0: written by the old code (one source per run); 1: the pool's (migration 066). */
  moneyRule: number;
  chargeTo: "free" | "balance" | "memory" | null;
  holdMicro: bigint;
  webMicro: bigint;
  overMicro: bigint;
}

/** The pool's class of a rule-1 model part by its `charge_to`, the model's tier class: `free` the allowance then the balance, `balance` the balance only. */
export const classOf = (chargeTo: "free" | "balance"): PayClass => (chargeTo === "free" ? "AB" : "B");

/**
 * A row's parts (design-wallet-v3.md §6, third attack V3.2). None for a row holding nothing (`hold_micro` 0: not admitted
 * yet, a provider run without searches, or settled) or a memory call (its own allowance, outside the pool). Then:
 * - rule 0, the old code's: its whole hold promised on its `charge_to` — `free` the allowance alone (class `A`),
 *   `balance` the balance (`B`) — nothing over (old code's own overrun is capped at the pot by the check, pool.ts
 *   `promisedLoad`); a provider run of the old code that searched carries its searches' source so (migration 065);
 * - rule 1: the model's part, of its tier class (`classOf`), promised `hold − web − over` and over `hold_over_micro` —
 *   none for a provider's model, whose model costs nothing — and the searches' part, class `AB` whatever the model's tier
 *   (Q3), promised `web_micro`: tools are held whole or refused, never over.
 */
export function partsOf(row: PoolRow): Part[] {
  if (row.holdMicro <= 0n || row.chargeTo === "memory") return [];
  if (row.moneyRule === 0) {
    return row.chargeTo === null ? [] : [{ run: row.id, cls: row.chargeTo === "free" ? "A" : "B", promised: row.holdMicro, over: 0n }];
  }
  const web = row.webMicro < row.holdMicro ? row.webMicro : row.holdMicro;
  const parts: Part[] = [];
  if (row.chargeTo !== null) {
    const promised = row.holdMicro - web - row.overMicro;
    parts.push({ run: row.id, cls: classOf(row.chargeTo), promised: promised > 0n ? promised : 0n, over: row.overMicro });
  }
  if (web > 0n) parts.push({ run: row.id, cls: "AB", promised: web, over: 0n });
  return parts;
}

/** The columns `rowOf` reads, of `agent_runs` (`a` its alias, or none). */
export const poolColumns = (a = ""): string => {
  const p = a === "" ? "" : `${a}.`;
  return `${p}id, ${p}money_rule, ${p}charge_to, ${p}hold_micro::text as hold, ${p}web_micro::text as web, ${p}hold_over_micro::text as over`;
};

/** What `poolColumns` selects. */
export interface PoolColumns {
  id: string;
  money_rule: number;
  charge_to: PoolRow["chargeTo"];
  hold: string;
  web: string;
  over: string;
}

/** A row `poolColumns` selected, as the pool reads it. */
export const rowOf = (r: PoolColumns): PoolRow => ({
  id: r.id,
  moneyRule: Number(r.money_rule),
  chargeTo: r.charge_to,
  holdMicro: BigInt(r.hold),
  webMicro: BigInt(r.web),
  overMicro: BigInt(r.over),
});

/**
 * The parts of every running run of `ownerId` (`except` aside: the run being admitted or settled), in run order. Under
 * the account lock the caller holds: every writer of a hold takes it first, so what is read here stays true until it
 * commits.
 */
export async function readParts(q: Queryable, ownerId: string, except: string | null = null): Promise<Part[]> {
  const { rows } = await q.query<PoolColumns>(
    `select ${poolColumns()} from agent_runs
      where owner_id = $1 and status = 'running' and hold_micro > 0 and charge_to is distinct from 'memory' and id is distinct from $2::uuid
      order by id`,
    [ownerId, except],
  );
  return rows.flatMap((r) => partsOf(rowOf(r)));
}

/**
 * Locks the payer's account (lock order: after the run's row) and reads its pots: A, what is left of the allowance of the
 * site day `now` is in (never below 0), and B, the balance (it may be below 0); with what the day has used.
 */
export async function lockPots(t: Tx, config: Pick<Config, "freeDailyMicro" | "siteTimezone">, ownerId: string, now: Date): Promise<{ pots: Pots; freeUsedMicro: bigint }> {
  const account = await lockAccount(t, ownerId);
  const used = await freeUsedToday(t, ownerId, now, config.siteTimezone);
  const left = config.freeDailyMicro - used;
  return { pots: { A: left > 0n ? left : 0n, B: account.balanceMicro }, freeUsedMicro: used };
}

/** `HOLDS.maxOpenShare` (0.01 to 1) in the pool's millionths (pool.ts `SHARE_WHOLE`). */
export const shareOf = (share: number): bigint => BigInt(Math.round(share * 1_000_000));
