import { applyLedger, freeUsedToday, lockAccount, memoryUsedToday, siteDay } from "../accounts/store.ts";
import type { Config } from "../config.ts";
import type { Tx } from "../db.ts";
import type { ChargeTo } from "./admit.ts";
import { excessRule, settle as settlePool, type Charge, type PayClass } from "./pool.ts";
import { assertCount, costMicro, isCount } from "./prices.ts";
import { learnRatio } from "./tokens.ts";
import { lockPots, partsOf, readParts, rowOf, type PoolColumns } from "./wallet.ts";

/**
 * Settlement (spec 6.4): after a call, in one transaction, charge what it cost — at most what it held — to the pots its
 * admission's class may use (admit.ts), write its usage record and release its hold.
 */

export type Outcome = "done" | "stopped" | "failed" | "cancelled";

/** Where settlement says what it could not do (a call on a site model no longer configured). Every caller passes one. */
export interface SettleLog {
  warn(details: Record<string, unknown>, msg: string): void;
}

/** Token counts the upstream reported. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/**
 * Q4 of the wallet design (others' calls never below zero), still the product owner's to answer: until then a paid-tier
 * reply's over in other people's lanes is a debt on its owner's balance, as in the owner's own lane (pool.ts `excessRule`).
 */
const OTHERS_NEVER_BELOW_ZERO = false;

/**
 * What a settlement charged: the run's class (`cls`, its `charge_to`: never who paid; null: a run never admitted, or a
 * provider model), how much of it the balance, and of that what was a paid reply's own debt (`debtMicro`: its over);
 * and, for one that could charge the free allowance or the balance, what the day's free allowance has used and the
 * balance is once it is charged (read under the account lock it took). The reminders (reminders.ts) go by it.
 */
export interface Settled {
  cls: ChargeTo | null;
  balanceMicro: bigint;
  debtMicro: bigint;
  after: { freeUsedMicro: bigint; balanceMicro: bigint } | null;
}

/** The run row as settlement reads it. */
interface SettleRow extends PoolColumns {
  owner_id: string;
  agent_id: string | null;
  purpose: string;
  source: "site" | "provider" | null;
  model: string | null;
  lane: "own" | "others" | "proactive";
  hold_micro: string;
  input_estimate: number | null;
  ratio_key: string | null;
  web_searches: number;
  web_micro: string;
  web_charge: string;
}

/** What the money step of a settlement took (by either rule): to each pot, and what the searches were charged. */
interface Taken {
  freeMicro: bigint;
  balanceMicro: bigint;
  memoryMicro: bigint;
  /** Of `balanceMicro`, a paid reply's own debt: what it used beyond its promise (rule 1; 0 by the old rule). */
  debtMicro: bigint;
  /** The searches' part of the cost: their price (rule 0), what they are charged (rule 1). */
  webMicro: bigint;
  after: Settled["after"];
}

/**
 * Settles the call of run `runId` with `outcome`, by what its admission recorded on the run (`source`, `model`,
 * `charge_to`, `hold_micro`, `money_rule`), whatever the Agent's model is by now:
 * - Tokens: `usage` as reported; when none was reported (or it is not two whole non-negative numbers), `fallback` (the
 *   caller's estimate: text in weight, the input's times the model's learned ratio, images and PDFs at their
 *   constants; tokens.ts) and the record says `estimated`. `fallback` is ours, so its counts must be
 *   whole numbers of 0 or more: anything else throws before anything is read or written.
 * - Cost (`cost_micro`, the true cost): the tokens at the site model's configured price; 0 for a provider model, for a
 *   `failed` call that produced no output, for no tokens at all (a run recovered at start-up settles so), and for a
 *   run never admitted (no model recorded; nothing is charged). A call that cost something on a site model removed from
 *   the configuration since cannot be priced: its true cost is unknown, so it is recorded as 0 and `estimated`, nothing
 *   is charged, and that is logged (`log.warn`, with the run and the model). Its web searches' part is added.
 * - Charged, by the pool's rule (`money_rule` 1, `settlePooled`; design-wallet-v3.md §4): the model's cost up to what the
 *   run held for it, the rest forgiven (an upstream that reports more is wrong), and its searches at what they are
 *   charged (`web_charge_micro`: their actual, at most their price). Per class within the run — the model's of its tier
 *   class, the searches' `AB` — what is covered by the run's promise is charged from the class's pots: `B` the balance,
 *   `AB` the allowance first (A's spare beside the old code's open rows on it), then the balance; what is over is the
 *   tier's: a free-tier over forgiven, a paid-tier one a debt on the balance (in others' lanes too while Q4 is open). The
 *   allowance is the site day's it is *now* (a call that started before midnight and ends after it uses the new day's).
 *   The balance may go below zero. By the old rule (`money_rule` 0, a run the old code admitted during a deploy's
 *   overlap: `settleLegacy`), as the old code settles: everything to its one `charge_to`.
 * - `memory` (a memory call, either rule) grows the memory allowance of that site day up to what is left of it
 *   (`memory_usage`, `usage_records.memory_micro`) and never touches the other two. `forgiven_micro` is everything of the
 *   cost not charged.
 * - Appends the `usage_records` row (its `money_rule` the run's) and zeroes the run's `hold_micro`.
 * - Learns: a reply (purpose `reply`) whose input estimate admission recorded (`input_estimate`, `ratio_key`) and whose
 *   usage was reported teaches its model's ratio once (`learnRatio`, which never throws and never holds this up). Nothing
 *   else does: no draft, no memory call, no settlement on an estimate.
 * - `forgiveAll`: the call's result was lost on the service's side (its reply could not be stored): nothing is charged
 *   and the whole cost, still recorded in `cost_micro`, is `forgiven_micro`.
 * Locks the run row, then (a call that holds on the pots or the memory allowance) the account. Throws, changing nothing,
 * for a run that does not exist or was settled already (`usage_records_run_id_key` holds that in the database too).
 * Returns what it charged (`Settled`: the reminders, reminders.ts, go by it).
 */
export async function settle(
  t: Tx,
  config: Pick<Config, "freeDailyMicro" | "siteTimezone" | "siteModels" | "memory">,
  runId: string,
  usage: Usage | null,
  fallback: { inputChars: number; outputChars: number },
  outcome: Outcome,
  now: Date,
  { forgiveAll = false, log }: { forgiveAll?: boolean; log: SettleLog },
): Promise<Settled> {
  assertCount("settle: fallback.inputChars", fallback.inputChars);
  assertCount("settle: fallback.outputChars", fallback.outputChars);
  const { rows } = await t.query<SettleRow>(
    `select owner_id, agent_id, purpose, source, model, lane, charge_to, hold_micro::text, input_estimate, ratio_key, web_searches, web_micro::text,
            web_charge_micro::text as web_charge, id, money_rule, hold_micro::text as hold, web_micro::text as web, hold_over_micro::text as over
       from agent_runs where id = $1 for update`,
    [runId],
  );
  const run = rows[0];
  if (!run) throw new Error(`settle: no run ${runId}`);
  if ((await t.query("select 1 from usage_records where run_id = $1", [runId])).rowCount !== 0) {
    throw new Error(`settle: run ${runId} is already settled`);
  }

  const reported = usage !== null && isCount(usage.inputTokens) && isCount(usage.outputTokens);
  const input = reported ? usage.inputTokens : fallback.inputChars;
  const output = reported ? usage.outputTokens : fallback.outputChars;
  let modelCost = 0n;
  let priced = true;
  if (run.source === "site" && !(outcome === "failed" && output === 0) && input + output > 0) {
    const site = config.siteModels.find((m) => m.id === run.model);
    if (site) {
      modelCost = costMicro(site, input, output);
    } else {
      priced = false;
      log.warn({ runId, model: run.model }, "settle: the run's site model is no longer configured, so its cost is unknown: recorded as 0 and not charged");
    }
  }

  const taken =
    Number(run.money_rule) === 1 ? await settlePooled(t, config, run, modelCost, now, forgiveAll) : await settleLegacy(t, config, run, modelCost, now, forgiveAll);
  const cost = modelCost + taken.webMicro;
  const forgivenMicro = cost - taken.freeMicro - taken.balanceMicro - taken.memoryMicro;

  const inserted = await t.query<{ id: string }>(
    `insert into usage_records (owner_id, agent_id, run_id, purpose, source, model, input_tokens, output_tokens, estimated,
                                cost_micro, free_micro, balance_micro, memory_micro, forgiven_micro, outcome, web_searches, web_micro, money_rule, debt_micro)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
     returning id::text`,
    [
      run.owner_id, run.agent_id, runId, run.purpose, run.source, run.model, input, output, !reported || !priced,
      cost.toString(), taken.freeMicro.toString(), taken.balanceMicro.toString(), taken.memoryMicro.toString(), forgivenMicro.toString(), outcome,
      run.web_searches, taken.webMicro.toString(), Number(run.money_rule), taken.debtMicro.toString(),
    ],
  );
  if (taken.balanceMicro > 0n) await applyLedger(t, run.owner_id, -taken.balanceMicro, "usage", null, inserted.rows[0]!.id);
  await t.query("update agent_runs set hold_micro = 0 where id = $1", [runId]);
  if (reported && run.purpose === "reply" && run.input_estimate !== null && run.ratio_key !== null) {
    await learnRatio(t, run.ratio_key, run.input_estimate, usage.inputTokens, log);
  }
  const after = taken.after && { freeUsedMicro: taken.after.freeUsedMicro + taken.freeMicro, balanceMicro: taken.after.balanceMicro - taken.balanceMicro };
  return { cls: run.charge_to, balanceMicro: taken.balanceMicro, debtMicro: taken.debtMicro, after };
}

/** A memory call (either rule): the memory allowance of the site day it is now, up to what is left of it; the rest forgiven. */
async function takeMemory(t: Tx, config: Pick<Config, "siteTimezone" | "memory">, ownerId: string, charged: bigint, now: Date): Promise<bigint> {
  await lockAccount(t, ownerId);
  const used = await memoryUsedToday(t, ownerId, now, config.siteTimezone);
  const allowance = BigInt(config.memory.freeDailyPoints) * 1_000_000n;
  const memoryMicro = min(charged, allowance > used ? allowance - used : 0n);
  if (memoryMicro > 0n) {
    await t.query(
      `insert into memory_usage (owner_id, day, used_micro) values ($1, $2::date, $3)
       on conflict (owner_id, day) do update set used_micro = memory_usage.used_micro + excluded.used_micro`,
      [ownerId, siteDay(now, config.siteTimezone), memoryMicro.toString()],
    );
  }
  return memoryMicro;
}

/** Grows the free allowance's use of the site day it is now by `micro`. */
async function useFree(t: Tx, config: Pick<Config, "siteTimezone">, ownerId: string, micro: bigint, now: Date): Promise<void> {
  if (micro <= 0n) return;
  await t.query(
    `insert into free_usage (owner_id, day, used_micro) values ($1, $2::date, $3)
     on conflict (owner_id, day) do update set used_micro = free_usage.used_micro + excluded.used_micro`,
    [ownerId, siteDay(now, config.siteTimezone), micro.toString()],
  );
}

/**
 * The pool's money step (`money_rule` 1; pool.ts `settle`): the run's parts (wallet.ts `partsOf`) charged per class —
 * the model's cost up to its part's hold, the searches at `web_charge_micro` — against the owner's pots beside every
 * other running run's parts, under the account lock. A run holding nothing on the pots (not admitted, a provider run
 * without searches) charges nothing and takes no lock.
 */
async function settlePooled(t: Tx, config: Pick<Config, "freeDailyMicro" | "siteTimezone" | "memory">, run: SettleRow, modelCost: bigint, now: Date, forgiveAll: boolean): Promise<Taken> {
  const webCharge = BigInt(run.web_charge);
  const nothing: Taken = { freeMicro: 0n, balanceMicro: 0n, memoryMicro: 0n, debtMicro: 0n, webMicro: webCharge, after: null };
  if (run.charge_to === "memory") {
    const charged = forgiveAll ? 0n : min(modelCost, BigInt(run.hold_micro));
    return { ...nothing, memoryMicro: await takeMemory(t, config, run.owner_id, charged, now) };
  }
  const mine = partsOf(rowOf(run));
  if (mine.length === 0) return nothing;
  const { pots, freeUsedMicro } = await lockPots(t, config, run.owner_id, now);
  const others = await readParts(t, run.owner_id, run.id);
  const modelPart = run.charge_to === null ? null : mine[0]!;
  const modelCharge = forgiveAll || modelPart === null ? 0n : min(modelCost, modelPart.promised + modelPart.over);
  const searches = forgiveAll ? 0n : webCharge;
  // One charge per class: the model's of its class, the searches' AB (the same class as a free-tier model's).
  const byClass = new Map<PayClass, bigint>();
  if (modelPart !== null) byClass.set(modelPart.cls, modelCharge);
  if (searches > 0n) byClass.set("AB", (byClass.get("AB") ?? 0n) + searches);
  const charges: Charge[] = [...byClass].map(([cls, cost]) => ({ cls, cost }));
  const s = settlePool(pots, [...others, ...mine], run.id, charges, (cls) => excessRule(cls, run.lane, OTHERS_NEVER_BELOW_ZERO));
  await useFree(t, config, run.owner_id, s.fromA, now);
  return { freeMicro: s.fromA, balanceMicro: s.fromB, memoryMicro: 0n, debtMicro: s.debt, webMicro: webCharge, after: { freeUsedMicro, balanceMicro: pots.B } };
}

/**
 * The old rule's money step (`money_rule` 0: a run the old code admitted during a deploy's overlap), as the old code
 * settles it: the cost up to the run's hold — its web searches' fixed price in full, outside the model's clip — to its
 * one `charge_to`: `free` grows the free allowance of the site day it is now by the charge, up to what is left of it, the
 * rest forgiven, charged to nobody, not even the next day; `memory` the memory allowance (`takeMemory`); `balance` debits
 * the whole charge, which may take the balance below zero.
 */
async function settleLegacy(t: Tx, config: Pick<Config, "freeDailyMicro" | "siteTimezone" | "memory">, run: SettleRow, modelCost: bigint, now: Date, forgiveAll: boolean): Promise<Taken> {
  const web = BigInt(run.web_micro);
  const taken: Taken = { freeMicro: 0n, balanceMicro: 0n, memoryMicro: 0n, debtMicro: 0n, webMicro: web, after: null };
  if (run.charge_to === null) return taken;
  const modelHold = BigInt(run.hold_micro) - web > 0n ? BigInt(run.hold_micro) - web : 0n;
  const charged = forgiveAll ? 0n : min(modelCost, modelHold) + web;
  if (run.charge_to === "memory") return { ...taken, memoryMicro: await takeMemory(t, config, run.owner_id, charged, now) };
  const account = await lockAccount(t, run.owner_id);
  const used = await freeUsedToday(t, run.owner_id, now, config.siteTimezone);
  taken.after = { freeUsedMicro: used, balanceMicro: account.balanceMicro };
  if (run.charge_to === "free") {
    taken.freeMicro = min(charged, config.freeDailyMicro > used ? config.freeDailyMicro - used : 0n);
    await useFree(t, config, run.owner_id, taken.freeMicro, now);
  } else {
    taken.balanceMicro = charged;
  }
  return taken;
}
