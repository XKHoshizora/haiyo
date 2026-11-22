import { describe, expect, it } from "vitest";
import { freeUsedToday, nextSiteMidnight, siteDay } from "../src/accounts/store.ts";
import type { Config, ReasoningLevel } from "../src/config.ts";
import { AppError } from "../src/errors.ts";
import { admit, admitRun, HeldBack } from "../src/metering/admit.ts";
import { estimateTokens, IMAGE_TOKENS, maxCostMicro, PDF_TOKENS_PER_KB, pdfTokens } from "../src/metering/prices.ts";
import { settle, type Outcome, type SettleLog } from "../src/metering/settle.ts";
import { resolveModel, type Resolved } from "../src/models/resolve.ts";
import { api, signUp, type Actor } from "./helpers/actors.ts";
import { useApp } from "./helpers/harness.ts";
import { costOf, ESTIMATE, FULL_USAGE, grant, MAX_COST, METER_ENV, meteredAgent, OVER_USAGE, runningRun, type MeteredAgent } from "./helpers/metering.ts";
import { providerBody } from "./helpers/providers.ts";

/**
 * Admission and settlement of model calls (spec 6.3 "站点提供", 6.4): which source a call charges, decided once at
 * admission and recorded on the run with the model; what it costs, charged at settlement up to what it held. Prices
 * and allowance: see METER_ENV (3 points a day, 2 points the most one call can cost).
 */

// Runs are made and moved by hand here (a reply run is briefly `queued`): no reply worker may pick them up.
const { app, db } = useApp({ env: METER_ENV, agentWorker: false });
const config = () => app.deps.config;
const TZ = "Asia/Shanghai";
/** Noon of 2026-03-01 in Shanghai. */
const NOON = new Date("2026-03-01T04:00:00Z");
const NO_TEXT = { inputChars: 0, outputChars: 0 };
/** The log settlement gets unless a test watches it: a warning where none is expected fails the settlement. */
const NO_WARNINGS: SettleLog = {
  warn: (_details, msg) => {
    throw new Error(`unexpected settlement warning: ${msg}`);
  },
};

const FREE = { source: "site", id: "meter_free" } as const;
const PAID = { source: "site", id: "meter_paid" } as const;

const admitAt = (runId: string, owner: Actor, resolved: Resolved, now = NOON) =>
  db.tx((t) => admitRun(t, config(), runId, owner.id, resolved, ESTIMATE, now));

function settleAt(
  runId: string,
  usage: { inputTokens: number; outputTokens: number } | null,
  {
    fallback = NO_TEXT,
    outcome = "done" as Outcome,
    now = NOON,
    cfg = config() as Config,
    log = NO_WARNINGS as SettleLog,
  } = {},
) {
  return db.tx((t) => settle(t, cfg, runId, usage, fallback, outcome, now, { log }));
}

/** The refusal `p` rejects with, as plain data. */
async function refusal(p: Promise<unknown>) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof AppError)) throw new Error(`expected an AppError, got ${String(err)}`);
  return { status: err.status, error: err.code, ...err.details };
}

async function usageRecords(runId: string) {
  const { rows } = await db.query(
    `select id::text, owner_id, agent_id, purpose, source, model, input_tokens::text, output_tokens::text, estimated,
            cost_micro::text, free_micro::text, balance_micro::text, forgiven_micro::text, outcome
       from usage_records where run_id = $1 order by usage_records.id`,
    [runId],
  );
  return rows;
}

async function record(runId: string) {
  const rows = await usageRecords(runId);
  expect(rows).toHaveLength(1);
  return rows[0];
}

const freeUsage = async (ownerId: string) =>
  (await db.query("select day::text, used_micro::text as used from free_usage where owner_id = $1 order by day", [ownerId])).rows;

const ledger = async (ownerId: string) =>
  (await db.query("select delta_micro::text as delta, reason, usage_id::text from balance_ledger where owner_id = $1 order by id", [ownerId])).rows;

async function balanceOf(ownerId: string): Promise<bigint> {
  const { rows } = await db.query<{ b: string }>("select balance_micro::text b from accounts where principal_id = $1", [ownerId]);
  return BigInt(rows[0]?.b ?? "0");
}

const runRow = async (runId: string) =>
  (await db.query("select source, model, charge_to, hold_micro::text as hold from agent_runs where id = $1", [runId])).rows[0];

const useFree = (ownerId: string, day: string, micro: bigint) =>
  db.query("insert into free_usage (owner_id, day, used_micro) values ($1, $2, $3)", [ownerId, day, micro.toString()]);

/** The ledger sums to the balance (spec 6.4). */
async function expectLedgerMatchesBalance(ownerId: string): Promise<void> {
  const { rows } = await db.query<{ ledger: string }>("select coalesce(sum(delta_micro), 0)::text as ledger from balance_ledger where owner_id = $1", [ownerId]);
  expect(BigInt(rows[0]!.ledger)).toBe(await balanceOf(ownerId));
}

describe("prices", () => {
  it("estimates a token per weight: ceil(utf-8 bytes / 3)", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("hello world")).toBe(4); // 11 bytes
    expect(estimateTokens("你好，世界")).toBe(5); // 15 bytes
    expect(estimateTokens("😀👍🏽")).toBe(4); // three code points of 4 bytes each, five UTF-16 units
    expect(IMAGE_TOKENS).toBe(1500);
    expect(PDF_TOKENS_PER_KB).toBe(300);
  });

  it("the most a call can cost: the input estimate and the whole output limit at the model's prices; a provider model costs nothing", async () => {
    const owner = await signUp(app, "maxcost");
    const fast = await meteredAgent(app, db, owner, FREE);
    expect(maxCostMicro(fast.resolved, ESTIMATE)).toBe(MAX_COST);
    expect(maxCostMicro(fast.resolved, 0)).toBe(1_000_000n);
    expect(maxCostMicro(fast.resolved, 3)).toBe(1_000_300n);
    const provider = (await api(app, owner, "POST", "/api/providers", providerBody({ models: [{ name: "mine" }] }))).json;
    const own = await meteredAgent(app, db, owner, { source: "provider", providerId: provider.id, model: "mine" });
    expect(maxCostMicro(own.resolved, ESTIMATE)).toBe(0n);
    // An input estimate is a whole number of tokens, 0 or more (a caller's bug otherwise), for any model.
    for (const bad of [1.5, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => maxCostMicro(fast.resolved, bad)).toThrow(/input token estimate must be a whole number/);
      expect(() => maxCostMicro(own.resolved, bad)).toThrow(/input token estimate must be a whole number/);
    }
  });

  it("a PDF is counted at 300 tokens per 1 000 bytes, rounded up", () => {
    expect(pdfTokens(0)).toBe(0);
    expect(pdfTokens(1)).toBe(1);
    expect(pdfTokens(1000)).toBe(300);
    expect(pdfTokens(1001)).toBe(301);
    expect(pdfTokens(10 * 1024 * 1024)).toBe(3_145_728);
    expect(pdfTokens(10 * 1024 * 1024 + 1)).toBe(3_145_729);
  });
});

describe("a call's hold covers its thinking allowance", () => {
  it("a site model at level high holds the input and its reply limit plus high's allowance at the output price; at none exactly today's hold", async () => {
    const owner = await signUp(app, "thinkhold");
    const meterFree = config().siteModels.find((m) => m.id === "meter_free")!;
    const cfg = { ...config(), siteModels: [...config().siteModels, { ...meterFree, id: "meter_think", reasoning: ["high"] as ReasoningLevel[] }] };
    const at = async (reasoning: ReasoningLevel) => (await resolveModel(db, cfg, { model: { source: "site", id: "meter_think" }, ownerId: owner.id, reasoning }))!;
    const none = await at("none");
    const high = await at("high");
    // What the gateway is sent as the output limit: the model's 1 000 at none, and high's 12 000 on top at high.
    expect([none.reasoning, none.call.maxOutputTokens]).toEqual(["none", 1000]);
    expect([high.reasoning, high.call.maxOutputTokens]).toEqual(["high", 1000 + 12_000]);

    const noneRun = await runningRun(db, owner.id);
    expect(await db.tx((t) => admitRun(t, cfg, noneRun, owner.id, none, ESTIMATE, NOON))).toEqual({ chargeTo: "free", holdMicro: MAX_COST });
    const highRun = await runningRun(db, owner.id);
    const held = costOf({ inputTokens: ESTIMATE, outputTokens: 1000 + 12_000 });
    expect(held).toBe(14_000_000n);
    // A draft never waits: beside the first's 2 of the 3 points, 1 of its 14 is promised, the rest held over.
    expect(await db.tx((t) => admitRun(t, cfg, highRun, owner.id, high, ESTIMATE, NOON))).toEqual({ chargeTo: "free", holdMicro: held, overMicro: held - 1_000_000n });
    expect(maxCostMicro(high, ESTIMATE)).toBe(held);
    const { rows } = await db.query<{ id: string; hold_micro: string }>("select id, hold_micro::text from agent_runs where id = any($1)", [[noneRun, highRun]]);
    expect(Object.fromEntries(rows.map((r) => [r.id, BigInt(r.hold_micro)]))).toEqual({ [noneRun]: MAX_COST, [highRun]: held });
  });
});

describe("free-tier model", () => {
  it("inside the allowance: admitted to the allowance, holding the maximum cost; settled in full to the allowance", async () => {
    const owner = await signUp(app, "freeinside");
    const fast = await meteredAgent(app, db, owner, FREE);
    const run = await runningRun(db, owner.id, fast);
    expect(await admitAt(run, owner, fast.resolved)).toEqual({ chargeTo: "free", holdMicro: MAX_COST });
    expect(await runRow(run)).toEqual({ source: "site", model: "meter_free", charge_to: "free", hold: "2000000" });

    await settleAt(run, { inputTokens: 5_000, outputTokens: 500 });
    expect(await record(run)).toMatchObject({
      owner_id: owner.id,
      agent_id: fast.agentId,
      purpose: "reply",
      source: "site",
      model: "meter_free",
      input_tokens: "5000",
      output_tokens: "500",
      estimated: false,
      cost_micro: "1000000",
      free_micro: "1000000",
      balance_micro: "0",
      forgiven_micro: "0",
      outcome: "done",
    });
    expect(await freeUsage(owner.id)).toEqual([{ day: "2026-03-01", used: "1000000" }]);
    expect(await runRow(run)).toEqual({ source: "site", model: "meter_free", charge_to: "free", hold: "0" });
    expect(await ledger(owner.id)).toEqual([]);
  });

  it("the reply that crosses the allowance with a balance there: the allowance first, then the balance (Q1); never tomorrow's", async () => {
    const owner = await signUp(app, "freecross");
    const fast = await meteredAgent(app, db, owner, FREE);
    await grant(db, owner.id, 5_000_000n);
    await useFree(owner.id, "2026-03-01", 2_500_000n);
    const run = await runningRun(db, owner.id, fast);
    // Its 2 fit the half point left and the balance together: all of it promised.
    expect(await admitAt(run, owner, fast.resolved)).toEqual({ chargeTo: "free", holdMicro: MAX_COST });

    await settleAt(run, { inputTokens: 5_000, outputTokens: 1_000 }); // 1.5 points
    const rec = await record(run);
    expect(rec).toMatchObject({ cost_micro: "1500000", free_micro: "500000", balance_micro: "1000000", forgiven_micro: "0" });
    expect(await freeUsage(owner.id)).toEqual([{ day: "2026-03-01", used: "3000000" }]);
    expect(await balanceOf(owner.id)).toBe(4_000_000n);
    expect(await ledger(owner.id)).toEqual([
      { delta: "5000000", reason: "grant", usage_id: null },
      { delta: "-1000000", reason: "usage", usage_id: rec.id },
    ]);

    // The next site day begins at midnight in Shanghai, 16:00 UTC, while the UTC date is still the 1st.
    const lastMinute = new Date("2026-03-01T15:59:00Z");
    const midnight = new Date("2026-03-01T16:00:00Z");
    expect(siteDay(midnight, "UTC")).toBe("2026-03-01");
    expect(await freeUsedToday(db, owner.id, lastMinute, TZ)).toBe(3_000_000n);
    expect(await freeUsedToday(db, owner.id, midnight, TZ)).toBe(0n);
    // A free-tier model's class is `free` (the allowance, then the balance) whichever pot is left.
    const [before, after] = [await runningRun(db, owner.id), await runningRun(db, owner.id)];
    expect(await admitAt(before, owner, fast.resolved, lastMinute)).toEqual({ chargeTo: "free", holdMicro: MAX_COST });
    expect(await admitAt(after, owner, fast.resolved, midnight)).toEqual({ chargeTo: "free", holdMicro: MAX_COST });
  });

  it("a reply admitted before midnight and settled after it: what was reserved at the time is charged, on the new day's allowance; the rest, reserved for nobody, is the site's (Q2)", async () => {
    const owner = await signUp(app, "freemidnight");
    const fast = await meteredAgent(app, db, owner, FREE);
    await useFree(owner.id, "2026-03-01", 2_500_000n);
    const run = await runningRun(db, owner.id, fast);
    // 23:50 on the 1st in Shanghai: half a point left today, no balance: alone, it starts with 0.5 promised, 1.5 over.
    expect(await admitAt(run, owner, fast.resolved, new Date("2026-03-01T15:50:00Z"))).toEqual({ chargeTo: "free", holdMicro: MAX_COST, overMicro: 1_500_000n });
    // 00:10 on the 2nd: the half point promised is charged to the new day's allowance; the 1 point above it is forgiven
    // though the new day could pay it.
    await settleAt(run, { inputTokens: 5_000, outputTokens: 1_000 }, { now: new Date("2026-03-01T16:10:00Z") });
    expect(await record(run)).toMatchObject({ cost_micro: "1500000", free_micro: "500000", balance_micro: "0", forgiven_micro: "1000000" });
    expect(await freeUsage(owner.id)).toEqual([
      { day: "2026-03-01", used: "2500000" },
      { day: "2026-03-02", used: "500000" },
    ]);
  });

  it("allowance used up and a balance of 5 points: charged to the balance in full", async () => {
    const owner = await signUp(app, "freebalance");
    const fast = await meteredAgent(app, db, owner, FREE);
    await useFree(owner.id, "2026-03-01", 3_000_000n);
    await grant(db, owner.id, 5_000_000n);
    const run = await runningRun(db, owner.id, fast);
    // Its class stays the free tier's (the allowance first, then the balance): settlement finds the allowance used up.
    expect(await admitAt(run, owner, fast.resolved)).toEqual({ chargeTo: "free", holdMicro: MAX_COST });
    expect(await runRow(run)).toEqual({ source: "site", model: "meter_free", charge_to: "free", hold: "2000000" });

    await settleAt(run, { inputTokens: 5_000, outputTokens: 1_000 });
    const rec = await record(run);
    expect(rec).toMatchObject({ cost_micro: "1500000", free_micro: "0", balance_micro: "1500000", forgiven_micro: "0" });
    expect(await ledger(owner.id)).toEqual([
      { delta: "5000000", reason: "grant", usage_id: null },
      { delta: "-1500000", reason: "usage", usage_id: rec.id },
    ]);
    expect(await balanceOf(owner.id)).toBe(3_500_000n);
    expect(await freeUsage(owner.id)).toEqual([{ day: "2026-03-01", used: "3000000" }]);
    expect(await runRow(run)).toMatchObject({ charge_to: "free", hold: "0" });
    await expectLedgerMatchesBalance(owner.id);
  });

  it("allowance used up and no balance (zero or below): 402 no_quota with the reset time; the run is left as it was", async () => {
    const owner = await signUp(app, "freenone");
    const fast = await meteredAgent(app, db, owner, FREE);
    await useFree(owner.id, "2026-03-01", 3_000_000n);
    const run = await runningRun(db, owner.id, fast);
    const refused = { status: 402, error: "no_quota", reason: "free_and_balance", resetsAt: "2026-03-01T16:00:00.000Z" };
    expect(nextSiteMidnight(NOON, TZ).toISOString()).toBe(refused.resetsAt);
    expect(await refusal(admitAt(run, owner, fast.resolved))).toEqual(refused);
    expect(await runRow(run)).toEqual({ source: null, model: null, charge_to: null, hold: "0" });
    await grant(db, owner.id, -1n);
    expect(await refusal(admitAt(run, owner, fast.resolved))).toEqual(refused);
    // Every detail is a string (the error-body convention).
    const err = await admitAt(run, owner, fast.resolved).catch((e: AppError) => e);
    expect(Object.values((err as AppError).details).every((v) => typeof v === "string")).toBe(true);
  });
});

describe("paid-tier model", () => {
  it("with a balance of 0 it is refused even though the free allowance is untouched", async () => {
    const owner = await signUp(app, "paidzero");
    const thinker = await meteredAgent(app, db, owner, PAID);
    const run = await runningRun(db, owner.id, thinker);
    expect(await refusal(admitAt(run, owner, thinker.resolved))).toEqual({ status: 402, error: "no_quota", reason: "balance" });
    expect(await freeUsedToday(db, owner.id, NOON, TZ)).toBe(0n);
  });

  it("a reply that takes the balance below zero is charged in full; the next is refused until a grant makes it positive", async () => {
    const owner = await signUp(app, "paidneg");
    const thinker = await meteredAgent(app, db, owner, PAID);
    await grant(db, owner.id, 1_000_000n);
    const run = await runningRun(db, owner.id, thinker);
    // Alone on a balance of 1: 1 promised, 1 over — the paid reply's own debt at settlement.
    expect(await admitAt(run, owner, thinker.resolved)).toEqual({ chargeTo: "balance", holdMicro: MAX_COST, overMicro: 1_000_000n });
    await settleAt(run, FULL_USAGE);
    expect(await record(run)).toMatchObject({ model: "meter_paid", cost_micro: "2000000", balance_micro: "2000000", free_micro: "0", forgiven_micro: "0" });
    expect(await balanceOf(owner.id)).toBe(-1_000_000n);
    expect(await freeUsage(owner.id)).toEqual([]);

    const next = await runningRun(db, owner.id);
    const refused = { status: 402, error: "no_quota", reason: "balance" };
    expect(await refusal(admitAt(next, owner, thinker.resolved))).toEqual(refused);
    await grant(db, owner.id, 1_000_000n); // back to exactly zero: still nothing to spend
    expect(await refusal(admitAt(next, owner, thinker.resolved))).toEqual(refused);
    await grant(db, owner.id, 1n);
    expect(await admitAt(next, owner, thinker.resolved)).toEqual({ chargeTo: "balance", holdMicro: MAX_COST, overMicro: MAX_COST - 1n });
    await expectLedgerMatchesBalance(owner.id);
  });
});

describe("a call that reports more than it held", () => {
  // OVER_USAGE costs 15 points; every call here held 2.
  it("on the allowance: charged only what it held, the rest forgiven; the allowance gets no more than that", async () => {
    const owner = await signUp(app, "capfree");
    const fast = await meteredAgent(app, db, owner, FREE);
    const run = await runningRun(db, owner.id, fast);
    await admitAt(run, owner, fast.resolved);
    await settleAt(run, OVER_USAGE);
    expect(await record(run)).toMatchObject({ cost_micro: "15000000", free_micro: "2000000", balance_micro: "0", forgiven_micro: "13000000" });
    expect(await freeUsage(owner.id)).toEqual([{ day: "2026-03-01", used: "2000000" }]);

    // With half a point left: the 2 points it may charge take the half point, the rest is forgiven.
    const second = await signUp(app, "capfreeleft");
    const fast2 = await meteredAgent(app, db, second, FREE);
    await useFree(second.id, "2026-03-01", 2_500_000n);
    const run2 = await runningRun(db, second.id, fast2);
    await admitAt(run2, second, fast2.resolved);
    await settleAt(run2, OVER_USAGE);
    expect(await record(run2)).toMatchObject({ cost_micro: "15000000", free_micro: "500000", balance_micro: "0", forgiven_micro: "14500000" });
    expect(await freeUsage(second.id)).toEqual([{ day: "2026-03-01", used: "3000000" }]);
  });

  it("on the balance: debited only what it held, the rest forgiven", async () => {
    const owner = await signUp(app, "capbalance");
    const thinker = await meteredAgent(app, db, owner, PAID);
    await grant(db, owner.id, 1_000_000n);
    const run = await runningRun(db, owner.id, thinker);
    await admitAt(run, owner, thinker.resolved);
    await settleAt(run, OVER_USAGE);
    const rec = await record(run);
    expect(rec).toMatchObject({ cost_micro: "15000000", free_micro: "0", balance_micro: "2000000", forgiven_micro: "13000000" });
    expect(await ledger(owner.id)).toEqual([
      { delta: "1000000", reason: "grant", usage_id: null },
      { delta: "-2000000", reason: "usage", usage_id: rec.id },
    ]);
    expect(await balanceOf(owner.id)).toBe(-1_000_000n);
    expect(costOf(OVER_USAGE)).toBe(15_000_000n);
  });
});

describe("provider model", () => {
  it("costs nothing, needs no allowance or balance, touches neither, and is still recorded", async () => {
    const owner = await signUp(app, "provider");
    const provider = (await api(app, owner, "POST", "/api/providers", providerBody({ models: [{ name: "my-model" }] }))).json;
    const own = await meteredAgent(app, db, owner, { source: "provider", providerId: provider.id, model: "my-model" });
    await useFree(owner.id, "2026-03-01", 3_000_000n);
    await grant(db, owner.id, -5_000_000n);
    expect(await db.tx((t) => admit(t, config(), owner.id, own.resolved, ESTIMATE, NOON))).toEqual({ chargeTo: null, holdMicro: 0n });
    const run = await runningRun(db, owner.id, own);
    expect(await admitAt(run, owner, own.resolved)).toEqual({ chargeTo: null, holdMicro: 0n });
    expect(await runRow(run)).toEqual({ source: "provider", model: "my-model", charge_to: null, hold: "0" });

    await settleAt(run, { inputTokens: 10_000, outputTokens: 5_000 });
    expect(await record(run)).toMatchObject({
      agent_id: own.agentId,
      source: "provider",
      model: "my-model",
      input_tokens: "10000",
      output_tokens: "5000",
      estimated: false,
      cost_micro: "0",
      free_micro: "0",
      balance_micro: "0",
      forgiven_micro: "0",
    });
    expect(await freeUsage(owner.id)).toEqual([{ day: "2026-03-01", used: "3000000" }]);
    expect(await balanceOf(owner.id)).toBe(-5_000_000n);
    expect(await ledger(owner.id)).toHaveLength(1);
  });
});

describe("settlement", () => {
  async function admitted(name: string): Promise<{ owner: Actor; fast: MeteredAgent; run: string }> {
    const owner = await signUp(app, name);
    const fast = await meteredAgent(app, db, owner, FREE);
    const run = await runningRun(db, owner.id, fast);
    await admitAt(run, owner, fast.resolved);
    return { owner, fast, run };
  }

  it("without reported usage: estimated from the characters, one token each, and marked estimated", async () => {
    const { run } = await admitted("estimated");
    await settleAt(run, null, { fallback: { inputChars: 3_000, outputChars: 400 } });
    expect(await record(run)).toMatchObject({ input_tokens: "3000", output_tokens: "400", estimated: true, cost_micro: "700000", free_micro: "700000" });
  });

  it("the character counts to fall back on must be whole numbers, 0 or more: anything else is refused and changes nothing", async () => {
    const { owner, run } = await admitted("badfallback");
    for (const fallback of [{ inputChars: 1.5, outputChars: 0 }, { inputChars: 10, outputChars: -1 }, { inputChars: Number.NaN, outputChars: 0 }]) {
      await expect(settleAt(run, FULL_USAGE, { fallback })).rejects.toThrow(/settle: fallback\.(inputChars|outputChars) must be a whole number/);
    }
    expect(await usageRecords(run)).toEqual([]);
    expect(await runRow(run)).toMatchObject({ hold: MAX_COST.toString() });
    expect(await freeUsage(owner.id)).toEqual([]);
  });

  it("a reported usage that is not two whole non-negative numbers counts as none reported", async () => {
    for (const [i, usage] of [{ inputTokens: -1, outputTokens: 10 }, { inputTokens: 1.5, outputTokens: 10 }, { inputTokens: 10, outputTokens: Number.NaN }].entries()) {
      const { run } = await admitted(`badusage${i}`);
      await settleAt(run, usage, { fallback: { inputChars: 10, outputChars: 1 } });
      expect(await record(run)).toMatchObject({ input_tokens: "10", output_tokens: "1", estimated: true, cost_micro: "2000" });
    }
  });

  it("a failed call with no output costs nothing but is recorded; one that produced output is charged", async () => {
    const a = await admitted("failednone");
    await settleAt(a.run, { inputTokens: 5_000, outputTokens: 0 }, { outcome: "failed" });
    expect(await record(a.run)).toMatchObject({ outcome: "failed", input_tokens: "5000", output_tokens: "0", cost_micro: "0", free_micro: "0" });
    expect(await runRow(a.run)).toMatchObject({ charge_to: "free", hold: "0" });
    expect(await freeUsage(a.owner.id)).toEqual([]);

    const b = await admitted("failedestimate");
    await settleAt(b.run, null, { outcome: "failed", fallback: { inputChars: 5_000, outputChars: 0 } });
    expect(await record(b.run)).toMatchObject({ outcome: "failed", estimated: true, cost_micro: "0" });

    const c = await admitted("failedsome");
    await settleAt(c.run, { inputTokens: 5_000, outputTokens: 100 }, { outcome: "failed" });
    expect(await record(c.run)).toMatchObject({ outcome: "failed", cost_micro: "600000", free_micro: "600000" });

    const d = await admitted("stoppednone");
    await settleAt(d.run, { inputTokens: 5_000, outputTokens: 0 }, { outcome: "stopped" });
    expect(await record(d.run)).toMatchObject({ outcome: "stopped", cost_micro: "500000" });
  });

  it("prices and records the model the run was admitted on, whatever the Agent uses by then", async () => {
    const { owner, fast, run } = await admitted("modelchange");
    expect((await api(app, owner, "PATCH", `/api/agents/${fast.agentId}`, { model: PAID })).status).toBe(200);
    await settleAt(run, FULL_USAGE);
    expect(await record(run)).toMatchObject({ source: "site", model: "meter_free", cost_micro: "2000000", free_micro: "2000000" });
  });

  it("a site model no longer configured cannot be priced: the call is settled at no charge, its true cost unknown (0, estimated), and logged", async () => {
    const { owner, run } = await admitted("unconfigured");
    const without = { ...config(), siteModels: [] };
    const warned: Array<[Record<string, unknown>, string]> = [];
    const log = { warn: (details: Record<string, unknown>, msg: string) => void warned.push([details, msg]) };
    await settleAt(run, FULL_USAGE, { cfg: without, log });
    expect(await record(run)).toMatchObject({
      source: "site",
      model: "meter_free",
      input_tokens: "10000",
      output_tokens: "1000",
      estimated: true,
      cost_micro: "0",
      free_micro: "0",
      balance_micro: "0",
      forgiven_micro: "0",
      outcome: "done",
    });
    expect(await runRow(run)).toMatchObject({ hold: "0" });
    expect(await freeUsage(owner.id)).toEqual([]);
    expect(await ledger(owner.id)).toEqual([]);
    expect(warned).toEqual([[{ runId: run, model: "meter_free" }, expect.stringMatching(/no longer configured/)]]);
    // On the balance too: nothing is debited.
    const paid = await signUp(app, "unconfigured_paid");
    const paidAgent = await meteredAgent(app, db, paid, PAID);
    await grant(db, paid.id, MAX_COST);
    const paidRun = await runningRun(db, paid.id, paidAgent);
    await admitAt(paidRun, paid, paidAgent.resolved);
    await settleAt(paidRun, FULL_USAGE, { cfg: without, log });
    expect(await record(paidRun)).toMatchObject({ cost_micro: "0", balance_micro: "0", estimated: true });
    expect(await balanceOf(paid.id)).toBe(MAX_COST);
    expect(warned).toHaveLength(2);

    // A failed call that produced nothing costs nothing at any price: nothing unknown, nothing logged.
    const { run: failed } = await admitted("unconfigured_failed");
    await settleAt(failed, null, { cfg: without, outcome: "failed", log });
    expect(await record(failed)).toMatchObject({ source: "site", model: "meter_free", cost_micro: "0", estimated: true });
    expect(warned).toHaveLength(2);
    // No tokens at all cost nothing at any price, whatever the outcome (a run recovered at start-up with its reply posted).
    const { run: done } = await admitted("unconfigured_done");
    await settleAt(done, null, { cfg: without, outcome: "done", fallback: NO_TEXT, log });
    expect(await record(done)).toMatchObject({ source: "site", outcome: "done", cost_micro: "0", input_tokens: "0", output_tokens: "0" });
  });

  it("a persona draft is recorded without an Agent", async () => {
    const { owner, fast } = await admitted("draft");
    const run = await runningRun(db, owner.id);
    await admitAt(run, owner, fast.resolved);
    await settleAt(run, { inputTokens: 1_000, outputTokens: 100 });
    expect(await record(run)).toMatchObject({ purpose: "draft", agent_id: null, cost_micro: "200000" });
  });

  it("a run is settled once: a second settlement is refused and changes nothing", async () => {
    const { owner, run } = await admitted("twice");
    await settleAt(run, FULL_USAGE);
    await expect(settleAt(run, FULL_USAGE)).rejects.toThrow(/already settled/);
    expect(await usageRecords(run)).toHaveLength(1);
    expect(await freeUsage(owner.id)).toEqual([{ day: "2026-03-01", used: "2000000" }]);
  });

  it("a run never admitted settles to a record with no source or model that costs nothing, left out of GET /api/usage", async () => {
    const owner = await signUp(app, "unadmitted");
    const fast = await meteredAgent(app, db, owner, FREE);
    const run = await runningRun(db, owner.id, fast);
    await settleAt(run, null, { outcome: "failed", now: new Date() });
    expect(await record(run)).toMatchObject({
      agent_id: fast.agentId,
      source: null,
      model: null,
      cost_micro: "0",
      free_micro: "0",
      balance_micro: "0",
      forgiven_micro: "0",
      estimated: true,
      outcome: "failed",
    });
    expect(await runRow(run)).toEqual({ source: null, model: null, charge_to: null, hold: "0" });
    expect(await freeUsage(owner.id)).toEqual([]);
    expect(await ledger(owner.id)).toEqual([]);
    // Even a reported usage is not charged: nothing was admitted.
    const draft = await runningRun(db, owner.id);
    await settleAt(draft, FULL_USAGE, { now: new Date() });
    expect(await record(draft)).toMatchObject({ source: null, model: null, cost_micro: "0", input_tokens: "10000" });

    const admittedRun = await runningRun(db, owner.id);
    await admitAt(admittedRun, owner, fast.resolved, new Date());
    await settleAt(admittedRun, { inputTokens: 0, outputTokens: 100 }, { now: new Date() });
    expect((await api(app, owner, "GET", "/api/usage")).json.recent).toEqual([{ agentId: null, purpose: "draft", model: "meter_free", source: "site", points: "0.1", replies: 0 }]);
  });
});

describe("admitRun", () => {
  it("admits only a running run of that owner, once", async () => {
    const owner = await signUp(app, "admitrun");
    const other = await signUp(app, "admitother");
    const fast = await meteredAgent(app, db, owner, FREE);
    const run = await runningRun(db, owner.id, fast);
    await expect(admitAt(run, other, fast.resolved)).rejects.toThrow(/not a running run/);
    await db.query("update agent_runs set status = 'queued' where id = $1", [run]);
    await expect(admitAt(run, owner, fast.resolved)).rejects.toThrow(/not a running run/);
    await db.query("update agent_runs set status = 'running' where id = $1", [run]);
    await admitAt(run, owner, fast.resolved);
    await expect(admitAt(run, owner, fast.resolved)).rejects.toThrow(/already admitted/);
    expect(await runRow(run)).toEqual({ source: "site", model: "meter_free", charge_to: "free", hold: "2000000" });

    // A provider run is admitted once too.
    const provider = (await api(app, owner, "POST", "/api/providers", providerBody({ models: [{ name: "mine" }] }))).json;
    const own = await meteredAgent(app, db, owner, { source: "provider", providerId: provider.id, model: "mine" });
    const ownRun = await runningRun(db, owner.id, own);
    await admitAt(ownRun, owner, own.resolved);
    await expect(admitAt(ownRun, owner, own.resolved)).rejects.toThrow(/already admitted/);
  });

  it("refuses a run that already has a usage record, and the database holds at most one record per run", async () => {
    const owner = await signUp(app, "admitsettled");
    const fast = await meteredAgent(app, db, owner, FREE);
    // Settled before it was ever admitted (it ended before reaching a model), yet still running.
    const run = await runningRun(db, owner.id, fast);
    await settleAt(run, null, { outcome: "failed", now: new Date() });
    await expect(admitAt(run, owner, fast.resolved)).rejects.toThrow(/already settled/);
    expect(await runRow(run)).toEqual({ source: null, model: null, charge_to: null, hold: "0" });

    // A second record for the run, written past settle's own check, is refused by the database itself.
    const second = db.query("insert into usage_records (owner_id, run_id, purpose, outcome) values ($1, $2, 'reply', 'failed')", [owner.id, run]);
    await expect(second).rejects.toMatchObject({ code: "23505", constraint: "usage_records_run_id_key" });
    expect(await usageRecords(run)).toHaveLength(1);
  });
});

describe("holds", () => {
  it("count against the source a call is picked by until settled: a reply waits behind them, a persona draft does not; GET /api/usage's canStartFreeReply says whether anything is left, holds aside", async () => {
    const owner = await signUp(app, "holds");
    const [a, b] = [await meteredAgent(app, db, owner, FREE), await meteredAgent(app, db, owner, FREE)];
    const now = new Date();
    const canStart = async () => (await api(app, owner, "GET", "/api/usage")).json.canStartFreeReply;
    expect(await canStart()).toBe(true);

    // 3 points of allowance: a reply holds 2 of it; a second reply's 2 more would pass the 3, so it waits (held back,
    // nothing written), and nothing is refused.
    const r1 = await runningRun(db, owner.id, a);
    expect(await admitAt(r1, owner, a.resolved, now)).toMatchObject({ chargeTo: "free" });
    const r2 = await runningRun(db, owner.id, b);
    const waited = await admitAt(r2, owner, b.resolved, now).catch((e: unknown) => e);
    expect(waited).toBeInstanceOf(HeldBack);
    expect((waited as HeldBack).behind).toEqual([r1]);
    expect(await runRow(r2)).toEqual({ source: null, model: null, charge_to: null, hold: "0" });
    expect(await canStart()).toBe(true);
    // A persona draft never waits: on the 1 point left after the hold, then — nothing left after the holds, 3 before them
    // — on the allowance all the same.
    const [d1, d2] = [await runningRun(db, owner.id), await runningRun(db, owner.id)];
    expect(await admitAt(d1, owner, a.resolved, now)).toMatchObject({ chargeTo: "free" });
    expect(await admitAt(d2, owner, a.resolved, now)).toMatchObject({ chargeTo: "free" });
    expect(await canStart()).toBe(true);

    // A balance of 1 point does not change it: of the pots together (3 + 1), 3 are promised (r1's 2, d1's 1; d2's hold is
    // all over), 1 is left, less than its 2 — so the waiting reply keeps waiting, behind the calls holding them.
    await grant(db, owner.id, 1_000_000n);
    const stillWaiting = await admitAt(r2, owner, b.resolved, now).catch((e: unknown) => e);
    expect(stillWaiting).toBeInstanceOf(HeldBack);
    expect((stillWaiting as HeldBack).behind).toEqual(expect.arrayContaining([r1]));
    expect(await runRow(r2)).toEqual({ source: null, model: null, charge_to: null, hold: "0" });

    // A persona draft cannot wait: with the allowance all held and a balance there, it still takes the allowance.
    const d3 = await runningRun(db, owner.id);
    expect(await admitAt(d3, owner, a.resolved, now)).toMatchObject({ chargeTo: "free" });
    await settleAt(d3, { inputTokens: 0, outputTokens: 0 }, { now });

    // Settled: r1 0.5 of the allowance; each draft what was promised it at the time — d1 its 1, d2 nothing — the rest of
    // their 2 forgiven, reserved for nobody (Q2), though the allowance has room by now. 1.5 of the allowance is left, and
    // the balance's 1: the waiting reply fits them together and starts, its class still the free tier's, and settles 2 —
    // the allowance first, then the balance (Q1).
    await settleAt(r1, { inputTokens: 0, outputTokens: 500 }, { now });
    await settleAt(d1, FULL_USAGE, { now });
    expect(await canStart()).toBe(true);
    await settleAt(d2, FULL_USAGE, { now });
    expect(await admitAt(r2, owner, b.resolved, now)).toEqual({ chargeTo: "free", holdMicro: MAX_COST });
    await settleAt(r2, FULL_USAGE, { now });
    expect(await record(r2)).toMatchObject({ free_micro: "1500000", balance_micro: "500000", forgiven_micro: "0" });
    expect((await api(app, owner, "GET", "/api/usage")).json.free.used).toBe("3");
    expect(await balanceOf(owner.id)).toBe(500_000n);
    expect(await canStart()).toBe(true);
    await expectLedgerMatchesBalance(owner.id);
  });
});
