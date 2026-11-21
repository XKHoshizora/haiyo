import { freeUsedToday, lockAccount, memoryUsedToday, nextSiteMidnight } from "../accounts/store.ts";
import type { Config } from "../config.ts";
import type { Queryable, Tx } from "../db.ts";
import { AppError } from "../errors.ts";
import type { Resolved } from "../models/resolve.ts";
import { maxCostMicro } from "./prices.ts";

/**
 * Admission (spec 6.4): before a site-model call, in one transaction under the owner's account lock, decide the one
 * source it will charge — today's free allowance or the points balance, or for a memory call (purpose `memory`) the
 * memory allowance the site pays (`MEMORY.freeDailyPoints`), never the other two — and hold the most it can cost against
 * that source until it is settled (settle.ts). A run's hold counts while the run is `running`; settle it before, or in the
 * transaction that, moves it out of `running`. Settlement charges no call more than it held.
 *
 * Money that does not block (Task H; README "Metering", The debt bound). A call starts while something is left of its
 * source (`raw`: the allowance less what the day used, or the balance), however large its hold; what the owner's other
 * running calls hold against that source only makes a reply wait: the holds against one source may add up to at most
 * `HOLDS.maxOpenShare` of what is left of it, unless the reply is the only call holding against it — then it starts
 * whatever its hold. A reply that would pass that is held back (`HeldBack`): its run goes back to `queued` until one of
 * the calls it waited for has ended (agents/port-impl.ts `begin`, `claimNext`). A persona draft (its owner waits at the
 * page) never waits: it starts while something is left, its hold counted like any. A reply that offers tools makes
 * several calls on one admission; before each after its first, extension (`raiseHold`) holds what the reply has cost so
 * far — at most what it held for its calls: an upstream that reports more is wrong and the rest is forgiven — and the
 * most of that call; where that does not fit what is left beside the other holds, the call is the reply's last — never
 * refused, also past what is left. The two sources differ there (fix round 1's ruling):
 * - the balance: so the most the owner's calls can take it below zero is what one reply that started alone costs, and
 *   one call more (a last call, or a draft) for each other call open beside it; that debt is the owner's, repaid by the
 *   next grant;
 * - the free allowance, whose overrun the site forgives: a reply offered tools holds there, from its admission, room for
 *   its last call too (the most one call of its model can cost: its whole context and output) beside its first, and every
 *   round before the last keeps that room; so its last call never passes its hold, only a reply that started alone (one
 *   at a time near the end of the day's allowance) can pass what is left, and what is forgiven a day is at most one
 *   reply, and a draft for each draft open beside it.
 * (tests/metering-concurrency.test.ts, tests/money-blocking.test.ts.)
 *
 * Lock order: the run row (admitRun, settle), then the `accounts` row. Neither function locks a conversation or an
 * `agents` row: callers that need those take them first.
 */

/**
 * A reply whose hold, beside what the owner's other running calls hold against its source (`on`), would pass what
 * `HOLDS.maxOpenShare` lets them hold of what is left: it waits for one of `behind` (those calls' run ids) to end. Thrown
 * by `admit`, under the account lock, before anything is written.
 */
export class HeldBack extends Error {
  constructor(
    readonly behind: readonly string[],
    /** The source it waits on; `any` when the holds left neither source it may use anything (a free-tier reply). */
    readonly on: "free" | "balance" | "any",
  ) {
    super("admission: the holds of the owner's other running calls leave no room for this one now");
    this.name = "HeldBack";
  }
}

export type ChargeTo = "free" | "balance" | "memory";

/** Where a call's cost goes (null: a provider model, which costs nothing) and what it holds meanwhile. */
export interface Admission {
  chargeTo: ChargeTo | null;
  holdMicro: bigint;
  /**
   * Of `holdMicro`, the room a reply offered tools keeps on the free allowance for its last call (`admit`'s `lastCallMicro`);
   * absent when none is kept.
   */
  reserveMicro?: bigint;
}

/** What the owner's running memory calls hold against the memory allowance. */
export async function readMemoryHold(q: Queryable, ownerId: string): Promise<bigint> {
  const { rows } = await q.query<{ held: string }>(
    "select coalesce(sum(hold_micro), 0)::text as held from agent_runs where owner_id = $1 and status = 'running' and charge_to = 'memory'",
    [ownerId],
  );
  return BigInt(rows[0]!.held);
}

/** What is left of the memory allowance of the site day `now` is in: the allowance less what is used and what running calls hold. */
export async function memoryLeft(q: Queryable, config: Pick<Config, "siteTimezone" | "memory">, ownerId: string, now: Date): Promise<bigint> {
  return BigInt(config.memory.freeDailyPoints) * 1_000_000n - (await memoryUsedToday(q, ownerId, now, config.siteTimezone)) - (await readMemoryHold(q, ownerId));
}

/** An amount per source: the holds against each, or what is left of each. */
export interface PerSource {
  freeMicro: bigint;
  balanceMicro: bigint;
}

/** What the owner's running calls hold, per source. */
export async function readHolds(q: Queryable, ownerId: string): Promise<PerSource> {
  const { rows } = await q.query<{ free: string; balance: string }>(
    `select coalesce(sum(hold_micro) filter (where charge_to = 'free'), 0)::text as free,
            coalesce(sum(hold_micro) filter (where charge_to = 'balance'), 0)::text as balance
       from agent_runs
      where owner_id = $1 and status = 'running'`,
    [ownerId],
  );
  return { freeMicro: BigInt(rows[0]!.free), balanceMicro: BigInt(rows[0]!.balance) };
}

/** What is left beside the running calls: today's allowance and the balance, each less what running calls hold against it (`raiseHold`'s `left`). */
export function headroom(state: { freeDailyMicro: bigint; freeUsedMicro: bigint; balanceMicro: bigint; holds: PerSource }): PerSource {
  return {
    freeMicro: state.freeDailyMicro - state.freeUsedMicro - state.holds.freeMicro,
    balanceMicro: state.balanceMicro - state.holds.balanceMicro,
  };
}

/** SQL expressions (columns or bound values) for what the one source rule below reads. */
export interface SourceCols {
  /** Boolean: the model is free-tier (a site model without a tier is paid). */
  freeTier: string;
  /** Today's free allowance less what is used, holds aside. */
  freeLeft: string;
  /** The balance, and what running calls hold against it. */
  balance: string;
  balanceHeld: string;
}

/**
 * THE source rule, written once as SQL and used by admission (`pickSources`) and by the queue's prediction of where a
 * queued reply would be paid from (agents/port-impl.ts `claimNext`), so the two cannot differ. A free-tier model takes
 * today's free allowance while any of it is left, holds aside — one all held by the owner's running calls too: a reply
 * then waits for them, a persona draft, which cannot wait, takes it — and the balance only once the allowance is used up,
 * when the balance has room after its holds. A paid-tier model takes only the balance. Null: none.
 */
export const chosenSourceSql = (c: SourceCols): string =>
  `(case when ${c.freeTier} and ${c.freeLeft} > 0 then 'free' when ${c.balance} - ${c.balanceHeld} > 0 then 'balance' end)`;

/** What a call may use at all, holds aside (null: nothing is left: refused). The same rule's second half. */
export const anySourceSql = (c: SourceCols): string =>
  `(case when ${c.freeTier} and ${c.freeLeft} > 0 then 'free' when ${c.balance} > 0 then 'balance' end)`;

/** The source rule on the owner's figures: `chosen` (on what is left after the holds) and `anything` (holds aside). */
export async function pickSources(
  q: Queryable,
  f: { freeTier: boolean; freeLeft: bigint; balance: bigint; balanceHeld: bigint },
): Promise<{ chosen: "free" | "balance" | null; anything: "free" | "balance" | null }> {
  const cols: SourceCols = { freeTier: "$1::boolean", freeLeft: "$2::bigint", balance: "$3::bigint", balanceHeld: "$4::bigint" };
  const { rows } = await q.query<{ chosen: "free" | "balance" | null; anything: "free" | "balance" | null }>(
    `select ${chosenSourceSql(cols)} as chosen, ${anySourceSql(cols)} as anything`,
    [f.freeTier, f.freeLeft.toString(), f.balance.toString(), f.balanceHeld.toString()],
  );
  return rows[0]!;
}

/** `share` (`HOLDS.maxOpenShare`, 0.01 to 1) of `micro`, rounded down, in whole micro-points. */
const shareOf = (micro: bigint, share: number): bigint => (micro * BigInt(Math.round(share * 1_000_000))) / 1_000_000n;

/**
 * Admits one call on `resolved` for `ownerId`, under the account lock. A provider model: `{chargeTo: null,
 * holdMicro: 0n}`, nothing locked or read. A site model holds `maxCostMicro` against the source `pickSources` picks by
 * what is left after the running calls' holds (`headroom`), a free-tier call taking the allowance while any of it is left,
 * holds aside, and the balance only when it is used up:
 * - nothing left of either source the model may use (`raw`, holds aside) is 402 `no_quota` with `reason`
 *   `free_and_balance` (free-tier model; `resetsAt`: the next site midnight) or `balance` (paid-tier model);
 * - a reply (`purpose` `reply`) starts when no other running call holds against that source, or when every hold
 *   against it, its own included, adds up to at most `HOLDS.maxOpenShare` of what is left of it; else — and when the
 *   holds leave neither source anything though one has something left — it throws `HeldBack` with those calls' runs and
 *   the source it waits for. On the free allowance a reply also holds `lastCallMicro` (a reply offered tools: room for its
 *   last call; `reserveMicro`), counted in that rule as its hold is;
 * - a persona draft (`draft`) starts while something is left, holds or not: on the source picked after the holds, or
 *   else the one picked on what is left;
 * - a memory call (`memory`) on a site model takes the memory allowance and nothing else, and is 402 `no_quota` with
 *   `reason` `memory` when it is used up (unchanged).
 * The caller stores `chargeTo` and `holdMicro` on the run in the same transaction (`admitRun` does).
 */
export async function admit(
  t: Tx,
  config: Pick<Config, "freeDailyMicro" | "siteTimezone" | "memory" | "holds">,
  ownerId: string,
  resolved: Pick<Resolved, "source" | "tier" | "price" | "call">,
  inputTokensEstimate: number,
  now: Date,
  purpose: "reply" | "draft" | "memory" = "reply",
  lastCallMicro = 0n,
): Promise<Admission> {
  if (resolved.source === "provider") return { chargeTo: null, holdMicro: 0n };
  if (purpose === "memory") {
    // Memory is paid from its own allowance, whatever the model's tier: not the free allowance, not the balance.
    await lockAccount(t, ownerId);
    if ((await memoryLeft(t, config, ownerId, now)) <= 0n) {
      throw new AppError(402, "no_quota", { reason: "memory", resetsAt: nextSiteMidnight(now, config.siteTimezone).toISOString() });
    }
    return { chargeTo: "memory", holdMicro: maxCostMicro(resolved, inputTokensEstimate) };
  }
  // A site model without a tier is treated as paid: it never touches the free allowance.
  const tier = resolved.tier === "free" ? "free" : "paid";
  const account = await lockAccount(t, ownerId);
  const freeUsedMicro = await freeUsedToday(t, ownerId, now, config.siteTimezone);
  const raw: PerSource = { freeMicro: config.freeDailyMicro - freeUsedMicro, balanceMicro: account.balanceMicro };
  const holds = await readHolds(t, ownerId);
  const firstMicro = maxCostMicro(resolved, inputTokensEstimate);
  // The one source rule (`chosenSourceSql`): on what is left after the holds, and on what is left, holds aside (whether anything is).
  const { chosen: chargeTo, anything } = await pickSources(t, { freeTier: tier === "free", freeLeft: raw.freeMicro, balance: raw.balanceMicro, balanceHeld: holds.balanceMicro });
  if (anything === null) {
    throw new AppError(
      402,
      "no_quota",
      tier === "free" ? { reason: "free_and_balance", resetsAt: nextSiteMidnight(now, config.siteTimezone).toISOString() } : { reason: "balance" },
    );
  }
  if (purpose === "draft") return { chargeTo: chargeTo ?? anything, holdMicro: firstMicro };
  // On the free allowance, a reply offered tools holds room for its last call too.
  const reserveMicro = chargeTo === "free" ? lastCallMicro : 0n;
  const holdMicro = firstMicro + reserveMicro;
  // A reply: the calls that hold against the source it would take — or, the holds leaving it none, against every source
  // it may use (it waits for whichever of them ends first).
  const sources: ChargeTo[] = chargeTo !== null ? [chargeTo] : tier === "free" ? ["free", "balance"] : ["balance"];
  const { rows } = await t.query<{ id: string }>(
    "select id from agent_runs where owner_id = $1 and status = 'running' and charge_to = any($2::text[]) order by id",
    [ownerId, sources],
  );
  if (chargeTo !== null) {
    const admitted: Admission = { chargeTo, holdMicro, ...(reserveMicro > 0n ? { reserveMicro } : {}) };
    // The only call holding against it: it starts, whatever its hold (one reply may always be open).
    if (rows.length === 0) return admitted;
    const held = chargeTo === "free" ? holds.freeMicro : holds.balanceMicro;
    const left = chargeTo === "free" ? raw.freeMicro : raw.balanceMicro;
    if (held + holdMicro <= shareOf(left, config.holds.maxOpenShare)) return admitted;
  }
  // Never empty here: holds leave a source with something left nothing only when calls running hold against it.
  if (rows.length === 0) throw new Error("admission: held back behind no running call");
  // It waits on the source it would take; with none left after the holds, on every source it may use (`any`, a free-tier
  // reply: the allowance and the balance). Never the memory allowance (a memory call's alone).
  throw new HeldBack(
    rows.map((r) => r.id),
    chargeTo === "free" ? "free" : chargeTo === "balance" ? "balance" : tier === "free" ? "any" : "balance",
  );
}

/**
 * `admit` for the run `runId`, which must be `running`, belong to `ownerId` and be neither admitted nor settled yet (a
 * hold taken after its usage record would never be released): locks the run row, admits, and records on it the call's
 * `source` and `model` (`resolved.name`) with its `charge_to` and `hold_micro` — what settlement goes by — and the
 * reasoning level the call is sent at (`resolved.reasoning`: what its reply's `via` shows its owner), all in the
 * caller's transaction; a reply held back before has its mark cleared (`held_back_by`, `held_back_on`: the owner's
 * younger replies stop waiting behind it, agents/port-impl.ts `claimNext`). A refusal (402 `no_quota`) or a reply held
 * back (`HeldBack`) throws and writes nothing. `lastCallMicro`: `admit`'s.
 */
export async function admitRun(
  t: Tx,
  config: Pick<Config, "freeDailyMicro" | "siteTimezone" | "memory" | "holds">,
  runId: string,
  ownerId: string,
  resolved: Pick<Resolved, "source" | "name" | "tier" | "price" | "call" | "reasoning">,
  inputTokensEstimate: number,
  now: Date,
  lastCallMicro = 0n,
): Promise<Admission> {
  const { rows } = await t.query<{ owner_id: string; status: string; source: string | null; purpose: "reply" | "draft" | "memory" }>(
    "select owner_id, status, source, purpose from agent_runs where id = $1 for update",
    [runId],
  );
  const run = rows[0];
  if (!run || run.owner_id !== ownerId || run.status !== "running") throw new Error(`admitRun: ${runId} is not a running run of ${ownerId}`);
  if (run.source !== null) throw new Error(`admitRun: ${runId} is already admitted`);
  if ((await t.query("select 1 from usage_records where run_id = $1", [runId])).rowCount !== 0) {
    throw new Error(`admitRun: ${runId} is already settled`);
  }
  const admission = await admit(t, config, ownerId, resolved, inputTokensEstimate, now, run.purpose, lastCallMicro);
  await t.query(
    `update agent_runs set source = $2, model = $3, charge_to = $4, hold_micro = $5, reasoning = $6, held_back_by = null, held_back_on = null
      where id = $1`,
    [
    runId,
    resolved.source,
    resolved.name,
    admission.chargeTo,
    admission.holdMicro.toString(),
    resolved.reasoning,
    ],
  );
  return admission;
}

/**
 * Extension: a reply that offers tools makes a call per round (agents/runtime/worker.ts), and before each call after its
 * first the hold of its run — admitted on a site model, still running, its row locked by the caller — is raised; never
 * lowered. `left` is what is left of the run's own source (its `charge_to`: today's free allowance or the balance) by
 * admission's headroom (`headroom`: what is left less what running calls hold), this run's own hold added back; never
 * another source than admission chose.
 * - "ok": `toolsAllowed` (the caller's cap and lane budgets) and `wanted.ok` within `left` — the hold becomes `wanted.ok`
 *   (what the reply has spent and the most of the next call, and on the free allowance the room kept for the last call):
 *   it overdraws nothing;
 * - "final": else — the next call is the reply's last, its hold `wanted.final` (spent and the most of that call), also
 *   past `left` and below zero: a reply that has started is never refused for money (Task H, rule 1); it only stops
 *   calling tools. On the balance that passes `left` by at most that one last call; on the free allowance the room kept
 *   holds it.
 * A memory call makes one call and is never extended (it would be refused here). Under the owner's account lock (lock
 * order: the run's row, then the account), so two runs of one owner raise their holds one after the other, each seeing
 * the other's.
 */
export async function raiseHold(
  t: Tx,
  config: Pick<Config, "freeDailyMicro" | "siteTimezone">,
  run: { id: string; ownerId: string; chargeTo: ChargeTo; holdMicro: bigint },
  wanted: { ok: bigint; final: bigint },
  toolsAllowed: boolean,
  now: Date,
): Promise<"ok" | "final"> {
  if (run.chargeTo === "memory") throw new Error("raiseHold: a memory call makes one call; it is never extended");
  const account = await lockAccount(t, run.ownerId);
  const per = headroom({
    freeDailyMicro: config.freeDailyMicro,
    freeUsedMicro: await freeUsedToday(t, run.ownerId, now, config.siteTimezone),
    balanceMicro: account.balanceMicro,
    holds: await readHolds(t, run.ownerId),
  });
  const left = (run.chargeTo === "free" ? per.freeMicro : per.balanceMicro) + run.holdMicro;
  const ok = toolsAllowed && wanted.ok <= left;
  await t.query("update agent_runs set hold_micro = greatest(hold_micro, $2::bigint) where id = $1", [run.id, (ok ? wanted.ok : wanted.final).toString()]);
  return ok ? "ok" : "final";
}
