import { describe, expect, it } from "vitest";
import { partsOf, readParts, type PoolRow } from "../src/metering/wallet.ts";
import { signUp } from "./helpers/actors.ts";
import { useApp } from "./helpers/harness.ts";
import { METER_ENV, meteredAgent, runningRun } from "./helpers/metering.ts";

/**
 * Wallet v3 wired in (.superpowers/sdd/2026-11-22-polish/design-wallet-v3.md; third attack V3.2, V3.6): the rows → parts
 * mapping against rows of every shape, migration 066's checks, and the pool end to end against the database.
 */

const { app, db } = useApp({ env: METER_ENV, agentWorker: false });

const row = (o: Partial<PoolRow>): PoolRow => ({ id: "r", moneyRule: 1, chargeTo: "free", holdMicro: 0n, webMicro: 0n, overMicro: 0n, ...o });

describe("rows → parts (V3.2)", () => {
  it("rule 1: a site run's model part of its tier class (promised hold − web − over, its over), its searches' part AB whatever the tier; a provider run its searches only", () => {
    // A free-tier reply: 13 held, nothing over, no search.
    expect(partsOf(row({ holdMicro: 13n }))).toEqual([{ run: "r", cls: "AB", promised: 13n, over: 0n }]);
    // With two searches of 13 and a lone start's over of 11: model 2 + 11 over, searches 26.
    expect(partsOf(row({ holdMicro: 39n, webMicro: 26n, overMicro: 11n }))).toEqual([
      { run: "r", cls: "AB", promised: 2n, over: 11n },
      { run: "r", cls: "AB", promised: 26n, over: 0n },
    ]);
    // A paid-tier reply: the model on B, its search on AB (Q3: the allowance may pay our site tool's search).
    expect(partsOf(row({ chargeTo: "balance", holdMicro: 18n, webMicro: 13n, overMicro: 2n }))).toEqual([
      { run: "r", cls: "B", promised: 3n, over: 2n },
      { run: "r", cls: "AB", promised: 13n, over: 0n },
    ]);
    // A provider model's run: no model part, its searches only (its hold is theirs).
    expect(partsOf(row({ chargeTo: null, holdMicro: 26n, webMicro: 26n }))).toEqual([{ run: "r", cls: "AB", promised: 26n, over: 0n }]);
  });

  it("rule 0, as the old code writes it: the whole hold promised on its charge_to — free the allowance (A), balance the balance (B) — its searches inside it, nothing over", () => {
    expect(partsOf(row({ moneyRule: 0, holdMicro: 15n, webMicro: 13n }))).toEqual([{ run: "r", cls: "A", promised: 15n, over: 0n }]);
    expect(partsOf(row({ moneyRule: 0, chargeTo: "balance", holdMicro: 2n }))).toEqual([{ run: "r", cls: "B", promised: 2n, over: 0n }]);
    // A provider run of the old code that searched carries its searches' source (migration 065).
    expect(partsOf(row({ moneyRule: 0, chargeTo: "balance", holdMicro: 13n, webMicro: 13n }))).toEqual([{ run: "r", cls: "B", promised: 13n, over: 0n }]);
    expect(partsOf(row({ moneyRule: 0, chargeTo: null, holdMicro: 0n }))).toEqual([]);
  });

  it("nothing for a row holding nothing (not admitted, a provider run without searches, settled) or a memory call", () => {
    expect(partsOf(row({ holdMicro: 0n, webMicro: 26n, overMicro: 3n }))).toEqual([]); // settled: hold zeroed, the rest kept
    expect(partsOf(row({ chargeTo: null, holdMicro: 0n }))).toEqual([]);
    expect(partsOf(row({ chargeTo: "memory", holdMicro: 5n }))).toEqual([]);
    expect(partsOf(row({ moneyRule: 0, chargeTo: "memory", holdMicro: 5n }))).toEqual([]);
  });
});

describe("migration 066's checks (V3.2)", () => {
  it("over never negative, web and over within the hold while it stands, the searches' charge within their price; a settled row's zeroed hold passes", async () => {
    const owner = await signUp(app, "walletchecks");
    const fast = await meteredAgent(app, db, owner, { source: "site", id: "meter_free" });
    const run = await runningRun(db, owner.id, fast);
    const set = (sql: string) => db.query(`update agent_runs set ${sql} where id = $1`, [run]);
    await set("source = 'site', model = 'meter_free', charge_to = 'free', money_rule = 1, hold_micro = 39, web_micro = 26, hold_over_micro = 11, web_charge_micro = 20, web_searches = 2");
    await expect(set("hold_over_micro = -1")).rejects.toMatchObject({ code: "23514", constraint: "agent_runs_hold_parts" });
    await expect(set("hold_over_micro = 14")).rejects.toMatchObject({ code: "23514", constraint: "agent_runs_hold_parts" });
    await expect(set("web_micro = 29")).rejects.toMatchObject({ code: "23514", constraint: "agent_runs_hold_parts" });
    await expect(set("web_charge_micro = 27")).rejects.toMatchObject({ code: "23514", constraint: "agent_runs_web_charge" });
    await expect(set("web_charge_micro = -1")).rejects.toMatchObject({ code: "23514", constraint: "agent_runs_web_charge" });
    await expect(set("money_rule = 2")).rejects.toMatchObject({ code: "23514" });
    // Settled: the hold zeroed, what was held beside it kept as the record.
    await set("hold_micro = 0");
    expect(await readParts(db, owner.id)).toEqual([]);
  });

  it("readParts reads every running row of the owner through the one mapping, the run asked aside, nothing of other owners or of ended runs", async () => {
    const owner = await signUp(app, "walletread");
    const other = await signUp(app, "walletother");
    const fast = await meteredAgent(app, db, owner, { source: "site", id: "meter_free" });
    const [a, b, c, d] = [await runningRun(db, owner.id, fast), await runningRun(db, owner.id), await runningRun(db, owner.id), await runningRun(db, other.id)];
    await db.query("update agent_runs set source = 'site', model = 'meter_free', charge_to = 'free', money_rule = 1, hold_micro = 20, web_micro = 13, web_searches = 1 where id = $1", [a]);
    await db.query("update agent_runs set source = 'site', model = 'meter_paid', charge_to = 'balance', money_rule = 0, hold_micro = 2 where id = $1", [b]);
    await db.query("update agent_runs set source = 'site', model = 'meter_paid', charge_to = 'balance', money_rule = 1, hold_micro = 5, status = 'done' where id = $1", [c]);
    await db.query("update agent_runs set source = 'site', model = 'meter_free', charge_to = 'free', money_rule = 1, hold_micro = 9 where id = $1", [d]);
    const parts = await readParts(db, owner.id);
    expect(parts).toEqual(
      expect.arrayContaining([
        { run: a, cls: "AB", promised: 7n, over: 0n },
        { run: a, cls: "AB", promised: 13n, over: 0n },
        { run: b, cls: "B", promised: 2n, over: 0n },
      ]),
    );
    expect(parts).toHaveLength(3);
    expect(await readParts(db, owner.id, a)).toEqual([{ run: b, cls: "B", promised: 2n, over: 0n }]);
  });
});
