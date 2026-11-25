import { lockAccount, memoryUsedToday, nextSiteMidnight } from "../accounts/store.ts";
import type { Config } from "../config.ts";
import type { Queryable, Tx } from "../db.ts";
import { AppError } from "../errors.ts";
import type { Resolved } from "../models/resolve.ts";
import { keepsRoom, othersFits, OthersLimit, type OthersLane } from "./others.ts";
import { extendRound, fitsAllowance, holders, start, type PayClass } from "./pool.ts";
import { maxCostMicro } from "./prices.ts";
import { classOf, lockPots, modelPartOf, poolColumns, readParts, rowOf, shareOf, type PoolColumns } from "./wallet.ts";

/**
 * Admission (spec 6.4; wallet v3, .superpowers/sdd/2026-11-22-polish/design-wallet-v3.md): before a site-model call, in
 * one transaction under the owner's account lock, decide the call's class and hold the most it can cost against the
 * owner's pots together — today's free allowance (A) and the points balance (B) — until it is settled (settle.ts), where
 * the charge is split between them; a memory call (purpose `memory`) holds against the memory allowance the site pays
 * (`MEMORY.freeDailyPoints`), never the other two. A run's hold counts while the run is `running`; settle it before, or
 * in the transaction that, moves it out of `running`. Settlement charges no call more than it held.
 *
 * The class (`classSql`, the one rule; recorded as the run's `charge_to`): a free-tier model's calls are `free` — the
 * allowance first, then the balance (pool class `AB`); a paid-tier model's are `balance` — the balance only (`B`): the
 * allowance never pays a paid-tier model round. A tool's priced call (the web search) is `AB` whatever the model's tier.
 *
 * The pool (pool.ts, read through wallet.ts): a running run's hold is parts — what the checks promised (the pots are
 * guaranteed to cover it) and what it took beyond them (`over`, promised to nobody). A new part is promised at most what
 * keeps every promise covered (`room`): an `AB` part checks A + B⁺ against every promise, a `B` part B⁺ too.
 *
 * Money that does not block (Task H; README "Metering", The debt bound). A call starts while something is left of its
 * class (A + B⁺ for a free-tier model, B for a paid one), however large its hold:
 * - it fits beside every other promise, the capacities scaled by `HOLDS.maxOpenShare`: promised whole;
 * - it is alone on its pots (no other running run holds on a pot it shares) or a persona draft (its owner waits at the
 *   page, it never waits): it starts whatever its hold, promised what fits and over the rest;
 * - else it is held back (`HeldBack`): its run goes back to `queued` until one of the calls it waited for has ended
 *   (agents/port-impl.ts `begin`, `claimNext`).
 * A reply that offers tools makes several calls on one admission; before each after its first, extension (`raiseHold`)
 * holds what the reply has cost so far — at most what it held for its calls: an upstream that reports more is wrong and
 * the rest is forgiven — and the most of that call; where that does not fit beside the other promises, or the reply
 * already holds over, the call is the reply's last — never refused, promised what fits and over the rest. What becomes of
 * an over at settlement is the tier's (settle.ts): a free-tier one is forgiven (what could not be reserved at the time is
 * on the site), a paid-tier one is the reply's own debt on the balance. On `AB` a reply offered tools holds, from its
 * admission, room for its last call too (the most one call of its model can cost), and every round before the last keeps
 * it: so only a reply that started alone can pass what is left.
 * (tests/metering-concurrency.test.ts, tests/money-blocking.test.ts, tests/money-wallet.test.ts.)
 *
 * Lock order: the run row (admitRun, settle), then the `accounts` row. Neither function locks a conversation or an
 * `agents` row: callers that need those take them first.
 */

/**
 * A reply whose hold, beside what the owner's other running calls hold on the pots it would use, would pass what
 * `HOLDS.maxOpenShare` lets them hold: it waits for one of `behind` (those calls' run ids) to end. Thrown by `admit`, under
 * the account lock, before anything is written.
 */
export class HeldBack extends Error {
  constructor(
    readonly behind: readonly string[],
    /** Its class (`held_back_on`): `any` a free-tier reply (it may use either pot), `balance` a paid-tier one; `free` only on the old code's rows. */
    readonly on: "free" | "balance" | "any",
  ) {
    super("admission: the holds of the owner's other running calls leave no room for this one now");
    this.name = "HeldBack";
  }
}

export type ChargeTo = "free" | "balance" | "memory";

/** Where a call's cost goes (null: a provider model, which costs nothing) and what it holds meanwhile. */
export interface Admission {
  /** Its class: `free` (allowance, then balance), `balance` (balance only), `memory`; null a provider model. */
  chargeTo: ChargeTo | null;
  holdMicro: bigint;
  /**
   * Of `holdMicro`, the room a reply offered tools keeps on `AB` for its last call (`admit`'s `lastCallMicro`); absent when
   * none is kept.
   */
  reserveMicro?: bigint;
  /** Of `holdMicro`, what was held beyond what the pots could cover (a reply that started alone, or a draft); absent when nothing. */
  overMicro?: bigint;
  /**
   * An others' reply offered tools whose with-tools hold did not fit its owner's number but whose one-call hold did: it is
   * admitted holding the one-call hold, no `reserveMicro`, and makes one call without tools (`begin`; plan B1, N3).
   */
  plain?: true;
}

/** Whose reply `admit` holds to the owner's others' numbers (`othersFits`), and the one-call hold a run offered tools may fall back to. */
export interface OthersAdmission {
  agentId: string;
  lane: OthersLane;
  /** The one-call hold, in micro-points, for a run offered tools; null for one that is not. */
  plainMicro: bigint | null;
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

/** SQL expressions (columns or bound values) for what the class rule below reads. */
export interface SourceCols {
  /** Boolean: the model is free-tier (a site model without a tier is paid). */
  freeTier: string;
  /** Today's free allowance less what is used, holds aside. */
  freeLeft: string;
  /** The balance. */
  balance: string;
}

/** Whether a call may start at all, holds aside: something is left of what its class may use. Null: nothing (refused). */
export const anySourceSql = (c: SourceCols): string =>
  `(case when ${c.freeTier} and ${c.freeLeft} > 0 then 'free' when ${c.balance} > 0 then 'balance' end)`;

/**
 * THE class rule, written once as SQL and used by admission (`classOfCall`), by the queue's prediction of a queued reply's
 * class (agents/port-impl.ts `claimNext`) and by the usage page, so they cannot differ: the `charge_to` the call would be
 * admitted on — `free` a free-tier model (A + B⁺ > 0), `balance` a paid-tier one (B > 0) — or null when nothing is left
 * of what it may use (refused, 402 `no_quota`).
 */
export const classSql = (c: SourceCols): string => `(case when ${anySourceSql(c)} is null then null when ${c.freeTier} then 'free' else 'balance' end)`;

/** The class rule on the owner's figures. */
export async function classOfCall(q: Queryable, f: { freeTier: boolean; freeLeft: bigint; balance: bigint }): Promise<"free" | "balance" | null> {
  const cols: SourceCols = { freeTier: "$1::boolean", freeLeft: "$2::bigint", balance: "$3::bigint" };
  const { rows } = await q.query<{ cls: "free" | "balance" | null }>(`select ${classSql(cols)} as cls`, [f.freeTier, f.freeLeft.toString(), f.balance.toString()]);
  return rows[0]!.cls;
}

/** What `held_back_on` a reply of class `cls` waits on (migration 054's values). */
const waitsOn = (cls: PayClass): "any" | "balance" => (cls === "AB" ? "any" : "balance");

/**
 * THE condition that `o` is an older reply of `q`'s owner still waiting with a mark (held back, not admitted yet: queued,
 * or claimed again and not admitted), whose turn `q` must respect — the owner's own reply (lane `own`) never behind one
 * someone else called for. Written once, for the queue (agents/port-impl.ts `claimNext`) and admission alike.
 */
export const olderMarkSql = (o: string, q: string): string =>
  `(${o}.owner_id = ${q}.owner_id and ${o}.purpose = 'reply' and ${o}.held_back_on is not null
    and (${o}.status = 'queued' or (${o}.status = 'running' and ${o}.source is null))
    and (${o}.created_at, ${o}.id) < (${q}.created_at, ${q}.id)
    and (${q}.lane <> 'own' or ${o}.lane = 'own'))`;

/** Whether an older reply of the run `runId`'s owner waits on the balance (a paid reply held back, `olderMarkSql`). */
async function paidReplyWaits(t: Tx, runId: string): Promise<boolean> {
  const { rows } = await t.query<{ waits: boolean }>(
    `select exists (select 1 from agent_runs o, agent_runs q where q.id = $1 and ${olderMarkSql("o", "q")} and o.held_back_on = 'balance') as waits`,
    [runId],
  );
  return rows[0]!.waits;
}

/**
 * Admits one call on `resolved` for `ownerId` (the run `runId`, whose own row is not counted beside it), under the account
 * lock. A provider model: `{chargeTo: null, holdMicro: 0n}`, nothing locked or read. A site model holds `maxCostMicro`
 * on the pool by its class (`classSql`):
 * - nothing left of what it may use is 402 `no_quota` with `reason` `free_and_balance` (free-tier model; `resetsAt`: the
 *   next site midnight) or `balance` (paid-tier model);
 * - a reply (`purpose` `reply`) starts by the pool's start rule (pool.ts `start`: it fits, scaled by `HOLDS.maxOpenShare`;
 *   or it is alone on its pots) or throws `HeldBack` with the runs it waits behind (pool.ts `holders`) and its class. On
 *   `AB` a reply also holds `lastCallMicro` (a reply offered tools: room for its last call; `reserveMicro`), counted as its
 *   hold is;
 * - a persona draft (`draft`) starts while something is left, whatever the holds;
 * - a memory call (`memory`) on a site model takes the memory allowance and nothing else, and is 402 `no_quota` with
 *   `reason` `memory` when it is used up (unchanged).
 * The caller stores `chargeTo`, `holdMicro` and `overMicro` on the run in the same transaction (`admitRun` does).
 */
export async function admit(
  t: Tx,
  config: Pick<Config, "freeDailyMicro" | "siteTimezone" | "memory" | "holds" | "others">,
  ownerId: string,
  resolved: Pick<Resolved, "source" | "tier" | "price" | "call">,
  inputTokensEstimate: number,
  now: Date,
  purpose: "reply" | "draft" | "memory" = "reply",
  lastCallMicro = 0n,
  runId: string | null = null,
  others: OthersAdmission | null = null,
): Promise<Admission> {
  // Somebody other than the owner called for it: the owner's two daily numbers, decided once under the account lock before
  // anything else (plan B1, the one money invariant). With tools if the with-tools hold fits what is left, else plain if
  // the one-call hold fits, else it waits for the replies holding (HeldBack) or ends (OthersLimit).
  let plain = false;
  if (purpose === "reply" && others !== null) {
    if (runId === null) throw new Error("admit: an others' reply is admitted for a run");
    const run = { id: runId, ownerId, agentId: others.agentId, lane: others.lane };
    const x = resolved.source === "provider" ? 0n : maxCostMicro(resolved, inputTokensEstimate) + lastCallMicro;
    let verdict = await othersFits(t, config, run, x, "admission", now);
    // A points refusal (a wait or a limit alike; never an answers one): the one-call hold, in the same transaction under the same lock.
    const pointsRefused = !verdict.ok && (!("limit" in verdict) || verdict.limit !== "answers");
    if (pointsRefused && others.plainMicro !== null) {
      const again = await othersFits(t, config, run, others.plainMicro, "admission", now);
      if (again.ok) {
        plain = true;
        verdict = again;
      }
    }
    if (!verdict.ok) {
      if ("heldBackBy" in verdict) throw new HeldBack(verdict.heldBackBy, "any");
      throw new OthersLimit(verdict.limit);
    }
  }
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
  const { pots } = await lockPots(t, config, ownerId, now);
  const chargeTo = await classOfCall(t, { freeTier: tier === "free", freeLeft: pots.A, balance: pots.B });
  if (chargeTo === null) {
    throw new AppError(
      402,
      "no_quota",
      tier === "free" ? { reason: "free_and_balance", resetsAt: nextSiteMidnight(now, config.siteTimezone).toISOString() } : { reason: "balance" },
    );
  }
  const cls = classOf(chargeTo);
  // On `AB`, and for every reply somebody other than the owner called for, a reply offered tools holds room for its last
  // call too (a draft makes one call). A plain admission holds its one call (`OthersAdmission.plainMicro`) and nothing else.
  const reserveMicro = !plain && purpose === "reply" && keepsRoom(cls, others?.lane ?? "own") ? lastCallMicro : 0n;
  const holdMicro = plain ? others!.plainMicro! : maxCostMicro(resolved, inputTokensEstimate) + reserveMicro;
  const parts = await readParts(t, ownerId, runId);
  const run = runId ?? "";
  // An older paid reply of the owner waits for the balance (the queue lets a free-tier reply past its mark: review I1): a
  // free-tier reply then starts only on the allowance alone — its hold beside what the others' promises need of it —
  // so it never takes the balance the paid one waits for; else it waits too, behind the runs holding the pots.
  if (purpose === "reply" && cls === "AB" && runId !== null && !fitsAllowance(pots, parts, { run, x: holdMicro }) && (await paidReplyWaits(t, runId))) {
    const behind = holders(parts, run, cls);
    if (behind.length > 0) throw new HeldBack(behind, waitsOn(cls));
  }
  const started = start(pots, parts, { run, cls, x: holdMicro, share: shareOf(config.holds.maxOpenShare), draft: purpose === "draft" });
  // The class rule above and the pool's agree on whether anything is left; a refusal here is a bug.
  if (started.kind === "no_quota") throw new Error("admission: the pool found nothing left where the class rule found something");
  if (started.kind === "waits") throw new HeldBack(holders(parts, run, cls), waitsOn(cls));
  return {
    chargeTo,
    holdMicro,
    ...(reserveMicro > 0n ? { reserveMicro } : {}),
    ...(started.part.over > 0n ? { overMicro: started.part.over } : {}),
    ...(plain ? { plain: true as const } : {}),
  };
}

/**
 * `admit` for the run `runId`, which must be `running`, belong to `ownerId` and be neither admitted nor settled yet (a
 * hold taken after its usage record would never be released): locks the run row, admits, and records on it the call's
 * `source` and `model` (`resolved.name`) with its `charge_to`, `hold_micro` and `hold_over_micro` — what settlement goes
 * by — `money_rule` 1 (the pool's; the one place it is set, migration 066), and the reasoning level the call is sent at
 * (`resolved.reasoning`: what its reply's `via` shows its owner), all in the caller's transaction; a reply held back
 * before has its mark cleared (`held_back_by`, `held_back_on`: the owner's younger replies stop waiting behind it,
 * agents/port-impl.ts `claimNext`). A refusal (402 `no_quota`) or a reply held back (`HeldBack`) throws and writes
 * nothing. `lastCallMicro`: `admit`'s.
 */
export async function admitRun(
  t: Tx,
  config: Pick<Config, "freeDailyMicro" | "siteTimezone" | "memory" | "holds" | "others">,
  runId: string,
  ownerId: string,
  resolved: Pick<Resolved, "source" | "name" | "tier" | "price" | "call" | "reasoning">,
  inputTokensEstimate: number,
  /**
   * The moment of admission, which decides the site day the owner's numbers and allowances are read for. A function (what `begin`
   * passes: the wall clock) is asked UNDER the owner's account lock, once the run's turn has come: a reply prepared before the
   * site's midnight and admitted after it is held against the new day (fix round 3, point 2). A date is taken as given (tests).
   */
  now: Date | (() => Date),
  lastCallMicro = 0n,
  plainMicro: bigint | null = null,
): Promise<Admission> {
  const { rows } = await t.query<{
    owner_id: string;
    status: string;
    source: string | null;
    purpose: "reply" | "draft" | "memory";
    lane: "own" | "others" | "proactive";
    agent_id: string | null;
  }>("select owner_id, status, source, purpose, lane, agent_id from agent_runs where id = $1 for update", [runId]);
  const run = rows[0];
  if (!run || run.owner_id !== ownerId || run.status !== "running") throw new Error(`admitRun: ${runId} is not a running run of ${ownerId}`);
  if (run.source !== null) throw new Error(`admitRun: ${runId} is already admitted`);
  if ((await t.query("select 1 from usage_records where run_id = $1", [runId])).rowCount !== 0) {
    throw new Error(`admitRun: ${runId} is already settled`);
  }
  // A reply somebody other than the Agent's owner called for meets the owner's others' numbers (`othersFits`).
  const others: OthersAdmission | null = run.lane !== "own" && run.agent_id !== null ? { agentId: run.agent_id, lane: run.lane, plainMicro } : null;
  const at = typeof now === "function" ? (await lockAccount(t, ownerId), now()) : now;
  const admission = await admit(t, config, ownerId, resolved, inputTokensEstimate, at, run.purpose, lastCallMicro, runId, others);
  await t.query(
    `update agent_runs set source = $2, model = $3, charge_to = $4, hold_micro = $5, hold_over_micro = $6, money_rule = 1, reasoning = $7,
            held_back_by = null, held_back_on = null, admitted_at = $8
      where id = $1`,
    [
      runId,
      resolved.source,
      resolved.name,
      admission.chargeTo,
      admission.holdMicro.toString(),
      (admission.overMicro ?? 0n).toString(),
      resolved.reasoning,
      at,
    ],
  );
  return admission;
}

/**
 * Extension: a reply that offers tools makes a call per round (agents/runtime/worker.ts), and before each call after its
 * first the model's part of the hold of its run — admitted on a site model by the pool's rule (`money_rule` 1), still
 * running, its row locked by the caller — is raised; never lowered. `wanted` are the model part's targets (its searches
 * aside: they hold apart, at their price): `ok` what the reply has spent and the most of the next call, and on `AB` the
 * room kept for the last call; `final` what it has spent and the most of the next call. By the pool (pool.ts
 * `extendRound`, design-wallet-v3.md §3):
 * - "ok": `toolsAllowed` (the caller's cap and lane budgets), the raise to `wanted.ok` fits beside every promise, and the
 *   reply holds nothing over — the hold becomes `wanted.ok`, all of it promised: it overdraws nothing;
 * - "final": else — the next call is the reply's last, the hold `wanted.final`, promised what fits and over the rest, also
 *   past what is left and below zero: a reply that has started is never refused for money (Task H, rule 1); it only
 *   stops calling tools. A reply that holds over once stays "final".
 * A memory call makes one call and is never extended (it would be refused here). Under the owner's account lock (lock
 * order: the run's row, then the account), so two runs of one owner raise their holds one after the other, each seeing
 * the other's.
 */
export async function raiseHold(
  t: Tx,
  config: Pick<Config, "freeDailyMicro" | "siteTimezone">,
  run: { id: string; ownerId: string; chargeTo: ChargeTo },
  wanted: { ok: bigint; final: bigint },
  toolsAllowed: boolean,
  now: Date,
): Promise<"ok" | "final"> {
  if (run.chargeTo === "memory") throw new Error("raiseHold: a memory call makes one call; it is never extended");
  const { pots } = await lockPots(t, config, run.ownerId, now);
  const parts = await readParts(t, run.ownerId);
  const cls = classOf(run.chargeTo);
  // The model part's size as the pool reads it (wallet.ts, the one mapping), from the run's row the caller has locked.
  const { rows } = await t.query<PoolColumns>(`select ${poolColumns()} from agent_runs where id = $1`, [run.id]);
  const model = rows[0] ? modelPartOf(rowOf(rows[0])) : null;
  const held = model === null ? 0n : model.promised + model.over;
  const r = extendRound(pots, parts, { run: run.id, cls, held, ok: wanted.ok, final: wanted.final, allowed: toolsAllowed });
  if (r.add.promised + r.add.over > 0n) {
    await t.query("update agent_runs set hold_micro = hold_micro + $2::bigint, hold_over_micro = hold_over_micro + $3::bigint where id = $1", [
      run.id,
      (r.add.promised + r.add.over).toString(),
      r.add.over.toString(),
    ]);
  }
  return r.answer;
}
