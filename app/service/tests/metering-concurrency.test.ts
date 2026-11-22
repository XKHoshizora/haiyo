import { describe, expect, it } from "vitest";
import { AppError } from "../src/errors.ts";
import { admitRun, HeldBack, type Admission } from "../src/metering/admit.ts";
import { settle, type SettleLog, type Usage } from "../src/metering/settle.ts";
import type { Resolved } from "../src/models/resolve.ts";
import { signUp } from "./helpers/actors.ts";
import { useApp } from "./helpers/harness.ts";
import { costOf, ESTIMATE, FULL_USAGE, grant, MAX_COST, METER_ENV, meteredAgent, OVER_USAGE, runningRun, type MeteredAgent } from "./helpers/metering.ts";

/**
 * Review Focus 2: however many replies one user starts at once, the forgiven free overrun and the negative balance
 * are each at most one reply's maximum cost. Real parallel transactions on separate pool connections against the
 * real Postgres; a hold is released only by settlement. Four rounds per scenario: all admissions at once and then all
 * settlements at once, or every call admitting and settling on its own while the others do the same; each order once
 * with every call costing exactly what it held (`FULL_USAGE`) and once with every call reporting far more than it
 * held (`OVER_USAGE`, 15 points against a hold of 2), which settlement charges only up to the hold. Since Task H a reply
 * whose hold does not fit beside the others' is not refused but held back (it would wait, queued, for one of them to
 * end): only a reply that starts alone on its pots may hold more than is left of them (wallet v3: one pool of the
 * allowance and the balance for a free-tier model).
 */

const { app, db } = useApp({ env: METER_ENV });
const config = () => app.deps.config;
const PARALLEL = 20;
const ROUNDS = 4;
const usageOf = (round: number): Usage => (round < 2 ? FULL_USAGE : OVER_USAGE);
/**
 * Every admission and settlement happens at this instant (noon in Shanghai), so all of a round's calls fall in one site
 * day whatever the clock says when the suite runs: a round that crossed midnight would use two days' allowances.
 */
const NOW = new Date("2026-03-01T04:00:00Z");
/** Every model here is configured: a settlement warning would be a bug. */
const NO_WARNINGS: SettleLog = {
  warn: (_details, msg) => {
    throw new Error(`unexpected settlement warning: ${msg}`);
  },
};

type Attempt = { run: string; admission: Admission } | { run: string; refused: AppError } | { run: string; held: HeldBack };

async function tryAdmit(run: string, ownerId: string, resolved: Resolved): Promise<Attempt> {
  try {
    return { run, admission: await db.tx((t) => admitRun(t, config(), run, ownerId, resolved, ESTIMATE, NOW)) };
  } catch (err) {
    if (err instanceof AppError) return { run, refused: err };
    if (err instanceof HeldBack) return { run, held: err };
    throw err;
  }
}

const settleWith = (run: string, usage: Usage) =>
  db.tx((t) => settle(t, config(), run, usage, { inputChars: 0, outputChars: 0 }, "done", NOW, { log: NO_WARNINGS }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `PARALLEL` Agents of `owner` on `model`, each to reply once. */
async function agentsOf(owner: Awaited<ReturnType<typeof signUp>>, model: { source: "site"; id: string }): Promise<MeteredAgent[]> {
  const agents: MeteredAgent[] = [];
  for (let i = 0; i < PARALLEL; i++) agents.push(await meteredAgent(app, db, owner, model));
  return agents;
}

/** A running reply of each of `agents` (of `ownerId`) contends for admission; every admitted one is settled. */
async function contend(ownerId: string, agents: MeteredAgent[], round: number): Promise<Attempt[]> {
  const usage = usageOf(round);
  const resolved: Resolved = agents[0]!.resolved;
  const runs = await Promise.all(agents.map((agent) => runningRun(db, ownerId, agent)));
  if (round % 2 === 0) {
    const attempts = await Promise.all(runs.map((run) => tryAdmit(run, ownerId, resolved)));
    await Promise.all(attempts.flatMap((a) => ("admission" in a ? [settleWith(a.run, usage)] : [])));
    return attempts;
  }
  return Promise.all(
    runs.map(async (run, i) => {
      const attempt = await tryAdmit(run, ownerId, resolved);
      if ("admission" in attempt) {
        await sleep(i % 4);
        await settleWith(run, usage);
      }
      return attempt;
    }),
  );
}

/**
 * The owner's books. `overrun` is the free overrun forgiven: everything forgiven less what the site absorbs above
 * the calls' holds (each call here held `MAX_COST`).
 */
async function totals(ownerId: string) {
  const { rows } = await db.query<{ records: number; cost: string; free: string; balance: string; forgiven: string; above: string }>(
    `select count(*)::int as records, coalesce(sum(cost_micro), 0)::text as cost, coalesce(sum(free_micro), 0)::text as free,
            coalesce(sum(balance_micro), 0)::text as balance, coalesce(sum(forgiven_micro), 0)::text as forgiven,
            coalesce(sum(greatest(cost_micro - $2, 0)), 0)::text as above
       from usage_records where owner_id = $1`,
    [ownerId, MAX_COST.toString()],
  );
  const used = await db.query<{ used: string }>("select coalesce(sum(used_micro), 0)::text as used from free_usage where owner_id = $1", [ownerId]);
  const account = await db.query<{ b: string }>("select balance_micro::text b from accounts where principal_id = $1", [ownerId]);
  const r = rows[0]!;
  return {
    records: r.records,
    cost: BigInt(r.cost),
    free: BigInt(r.free),
    charged: BigInt(r.balance),
    overrun: BigInt(r.forgiven) - BigInt(r.above),
    freeUsed: BigInt(used.rows[0]!.used),
    balance: BigInt(account.rows[0]?.b ?? "0"),
  };
}

function split(attempts: Attempt[]) {
  const admitted = attempts.flatMap((a) => ("admission" in a ? [a.admission] : []));
  const refused = attempts.flatMap((a) => ("refused" in a ? [a.refused] : []));
  const held = attempts.flatMap((a) => ("held" in a ? [a.held] : []));
  return { admitted, refused, held, reasons: [...new Set(refused.map((e) => `${e.status} ${e.code} ${e.details.reason}`))] };
}

/** The whole site: every balance equals its ledger, every record's cost is split exactly, and no hold is left. */
async function expectBooksBalanced(): Promise<void> {
  const { rows } = await db.query<{ balance: string; ledger: string }>(
    `select a.balance_micro::text as balance, coalesce(sum(l.delta_micro), 0)::text as ledger
       from accounts a left join balance_ledger l on l.owner_id = a.principal_id
      group by a.principal_id, a.balance_micro`,
  );
  for (const r of rows) expect(r.ledger).toBe(r.balance);
  expect((await db.query("select id from usage_records where cost_micro <> free_micro + balance_micro + forgiven_micro")).rows).toEqual([]);
  expect((await db.query("select id from agent_runs where hold_micro > 0")).rows).toEqual([]);
}

it("runs against a real pool of at least 10 connections", () => {
  expect(db.pool.options.max).toBeGreaterThanOrEqual(10);
});

describe(`${PARALLEL} replies started at once by one user`, () => {
  it("free model, allowance 1.5 × the maximum cost, balance 0: the first starts alone, the rest wait — no more start until one has ended; at most one maximum cost of free overrun forgiven", { timeout: 120_000 }, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const owner = await signUp(app, `freerace${round}`);
      const agents = await agentsOf(owner, { source: "site", id: "meter_free" });
      const { admitted, refused, held, reasons } = split(await contend(owner.id, agents, round));
      // (One that starts alone on what is left holds the rest over: `overMicro`.)
      for (const a of admitted) expect({ chargeTo: a.chargeTo, holdMicro: a.holdMicro }).toEqual({ chargeTo: "free", holdMicro: MAX_COST });
      expect(admitted.length + held.length + refused.length).toBe(PARALLEL);
      if (round % 2 === 0) expect([admitted.length, held.length]).toEqual([1, PARALLEL - 1]);
      // Each on its own: a reply that comes after the first has ended starts alone on what is left (1 point), and then
      // nothing is left.
      else expect(admitted.length).toBeLessThanOrEqual(2);
      expect(reasons.every((r) => r === "402 no_quota free_and_balance")).toBe(true);
      const t = await totals(owner.id);
      expect(t.overrun).toBeLessThanOrEqual(MAX_COST);
      expect(t.freeUsed).toBeLessThanOrEqual(3_000_000n);
      expect(t.balance).toBe(0n);
      await expectBooksBalanced();
    }
  });

  it("paid model, balance 0.5 × the maximum cost: exactly one starts, the others wait and are then refused once nothing is left; the balance ends no lower than minus one maximum cost", { timeout: 120_000 }, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const owner = await signUp(app, `paidrace${round}`);
      const agents = await agentsOf(owner, { source: "site", id: "meter_paid" });
      await grant(db, owner.id, MAX_COST / 2n);
      const { admitted, refused, held, reasons } = split(await contend(owner.id, agents, round));
      // Alone on half a maximum cost: that half promised, the other held over — its own debt at settlement.
      expect(admitted).toEqual([{ chargeTo: "balance", holdMicro: MAX_COST, overMicro: MAX_COST / 2n }]);
      expect(held.length + refused.length).toBe(PARALLEL - 1);
      if (round % 2 === 0) expect(held).toHaveLength(PARALLEL - 1);
      expect(reasons.every((r) => r === "402 no_quota balance")).toBe(true);
      const t = await totals(owner.id);
      expect(t.balance).toBeGreaterThanOrEqual(-MAX_COST);
      expect(t).toEqual({ records: 1, cost: costOf(usageOf(round)), free: 0n, charged: MAX_COST, overrun: 0n, freeUsed: 0n, balance: -MAX_COST / 2n });
      await expectBooksBalanced();
    }
  });

  it("free model with both an allowance and a balance: the bounds hold on the two pots together (Q1)", { timeout: 120_000 }, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const owner = await signUp(app, `bothrace${round}`);
      const agents = await agentsOf(owner, { source: "site", id: "meter_free" });
      await grant(db, owner.id, MAX_COST / 2n);
      const { admitted, refused, held, reasons } = split(await contend(owner.id, agents, round));
      expect(admitted.length + held.length + refused.length).toBe(PARALLEL);
      // All at once: the allowance (3) and the balance (1) together cover two holds of 2, so two start, the rest wait
      // behind them. Each on its own: one more may start alone on what is left as the one before it has ended.
      if (round % 2 === 0) expect([admitted.map((a) => a.chargeTo), held.length]).toEqual([["free", "free"], PARALLEL - 2]);
      else expect(admitted.length).toBeLessThanOrEqual(3);
      expect(reasons.every((r) => r === "402 no_quota free_and_balance")).toBe(true);
      const t = await totals(owner.id);
      expect(t.overrun).toBeLessThanOrEqual(MAX_COST);
      expect(t.balance).toBeGreaterThanOrEqual(-MAX_COST);
      await expectBooksBalanced();
    }
  });
});
