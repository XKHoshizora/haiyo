import { describe, expect, it } from "vitest";
import {
  alone,
  excessRule,
  extendRound,
  fuseCost,
  inBand,
  room,
  round,
  searchCharge,
  settle,
  SHARE_WHOLE,
  somethingLeft,
  split,
  start,
  tool,
  type Charge,
  type Part,
  type PayClass,
  type Pots,
} from "../src/metering/pool.ts";

/**
 * The money rule of wallet v3 (.superpowers/sdd/2026-11-22-polish/design-wallet-v3.md) as its executable spec
 * (src/metering/pool.ts): every counterexample of the three attacks (design-wallet-attack.md) as a named case, the live
 * case, the two-pot proof cases, and a randomized invariant test over many sequences of holds, charges, settlements,
 * grants, adjustments and daily resets across concurrent runs of one owner — old code's own rows among them, as old code
 * admits, raises and settles them during the deploy overlap. Pure: no database.
 */

const P = (n: number): bigint => BigInt(n) * 1_000_000n; // whole points, in micro-points
const pots = (A: number, B: number): Pots => ({ A: P(A), B: P(B) });
const part = (run: string, cls: PayClass, promised: number, over = 0): Part => ({ run, cls, promised: P(promised), over: P(over) });
const own = (cls: PayClass) => excessRule(cls, "own", false);
const pos = (b: bigint): bigint => (b > 0n ? b : 0n);
const big = (a: bigint, b: bigint): bigint => (a > b ? a : b);
const small = (a: bigint, b: bigint): bigint => (a < b ? a : b);

describe("the check for a new part (v3 §2)", () => {
  it("C1a — five free points left (attack V2-C1): a free-tier reply alone holds 13; its search of 13 is held, not refused", () => {
    const at = pots(5, 1000);
    const started = start(at, [], { run: "f", cls: "AB", x: P(13) });
    expect(started).toEqual({ kind: "started", part: part("f", "AB", 13) });
    const parts = [part("f", "AB", 13)];
    // v2's check counted the reply's whole hold against A (13 ≤ 5: false) — the live bug. v3: 13 + 13 ≤ 5 + 1000.
    expect(room(at, parts, "AB")).toBe(P(992));
    expect(tool(at, parts, { run: "f", cls: "AB", x: P(13) })).toEqual(part("f", "AB", 13));
  });

  it("C1b — a paid reply started alone on a small balance does not block the owner's free-model replies (A 50, B 3, paid 5)", () => {
    const at = pots(50, 3);
    const paid = start(at, [], { run: "p", cls: "B", x: P(5) });
    expect(paid).toEqual({ kind: "started", part: part("p", "B", 3, 2) });
    const parts = [part("p", "B", 3, 2)];
    // Its excess is promised to nobody: a free-tier reply starts (not held back), rounds stay "ok", its search is held.
    expect(start(at, parts, { run: "f", cls: "AB", x: P(20) })).toEqual({ kind: "started", part: part("f", "AB", 20) });
    const withF = [...parts, part("f", "AB", 20)];
    expect(round(at, withF, { run: "f", cls: "AB", x: P(10) })).toEqual({ answer: "ok", add: part("f", "AB", 10) });
    expect(tool(at, [...withF, part("f", "AB", 10)], { run: "f", cls: "AB", x: P(13) })).toEqual(part("f", "AB", 13));
  });

  it("the live case — 81 of 100 free points used, balance 1000, a free-tier reply holding 13 (2 + last-call room 11), a search of 13: held; settled from the allowance first", () => {
    const at = pots(19, 1000);
    const parts = [part("f", "AB", 13)];
    expect(room(at, parts, "AB")).toBe(P(1006));
    const search = tool(at, parts, { run: "f", cls: "AB", x: P(13) });
    expect(search).toEqual(part("f", "AB", 13));
    // An illustration (third attack V3.4): say the model cost 2 and the search 7 — 9 from A, nothing from the balance.
    // Realistically such a reply costs about 8–14, all of it from the allowance as long as A covers it.
    const s = settle(at, [...parts, search!], "f", [{ cls: "AB", cost: P(9) }], own);
    expect(s).toEqual({ pots: pots(10, 1000), fromA: P(9), fromB: 0n, debt: 0n, forgiven: 0n });
  });

  it("a part checks only the inequalities of its own pots: a B part also (2), an AB part only (1)", () => {
    const at = pots(10, 5);
    const parts = [part("x", "B", 5)];
    expect(room(at, parts, "B")).toBe(0n); // (2): B⁺ − P_B = 0
    expect(room(at, parts, "AB")).toBe(P(10)); // (1) only: 15 − 5
    // A legacy A row (the old code's, during the overlap) capped at A: its excess beyond A is old code's own overrun.
    expect(room(pots(4, 10), [part("l", "A", 9)], "AB")).toBe(P(10)); // 4 + 10 − min(9, 4)
    // The cap binds too once a debt has taken B below the open B promises: they do not block the allowance's room.
    expect(room(pots(6, 2), [part("q", "B", 5)], "AB")).toBe(P(6)); // 6 + 2 − min(5, 2)
  });

  it("the share scales the capacities at a start, never the cap; later rounds and tools use the real pots", () => {
    const at = pots(10, 10);
    const parts = [part("x", "AB", 4)];
    const half = SHARE_WHOLE / 2n;
    expect(room(at, parts, "AB", half)).toBe(P(6)); // 5 + 5 − 4
    expect(start(at, parts, { run: "y", cls: "AB", x: P(7), share: half })).toEqual({ kind: "waits" });
    expect(start(at, parts, { run: "y", cls: "AB", x: P(6), share: half })).toEqual({ kind: "started", part: part("y", "AB", 6) });
    expect(round(at, parts, { run: "x", cls: "AB", x: P(16) })).toEqual({ answer: "ok", add: part("x", "AB", 16) });
  });
});

describe("the start rule, the lone reply and the rounds (v3 §3; attack V2-I2, V2-I3, V3-I1)", () => {
  it("V2-I2 — an owner in debt keeps the use of his free points: B −10, A 5, a free-tier reply starts; a paid one is refused", () => {
    const at = pots(5, -10);
    expect(somethingLeft(at, "AB")).toBe(true);
    expect(start(at, [], { run: "f", cls: "AB", x: P(3) })).toEqual({ kind: "started", part: part("f", "AB", 3) });
    expect(start(at, [], { run: "p", cls: "B", x: P(3) })).toEqual({ kind: "no_quota" });
    expect(start(pots(0, 0), [], { run: "f", cls: "AB", x: P(1) })).toEqual({ kind: "no_quota" });
  });

  it("V2-I3 — a reply alone on its pots starts whatever its hold (promised what fits, the rest over); one beside another waits; a draft never waits", () => {
    const at = pots(2, 0);
    expect(start(at, [], { run: "f", cls: "AB", x: P(13) })).toEqual({ kind: "started", part: part("f", "AB", 2, 11) });
    const other = [part("g", "AB", 1)];
    expect(alone(other, "f", "AB")).toBe(false);
    expect(start(at, other, { run: "f", cls: "AB", x: P(13) })).toEqual({ kind: "waits" });
    expect(start(at, other, { run: "d", cls: "AB", x: P(13), draft: true })).toEqual({ kind: "started", part: part("d", "AB", 1, 12) });
    // Shared pots: a paid reply is alone beside a legacy A row (no pot in common), not beside an AB one.
    expect(alone([part("l", "A", 5)], "p", "B")).toBe(true);
    expect(alone([part("g", "AB", 5)], "p", "B")).toBe(false);
  });

  it("both pots used up after the reply started (V2-M2): its later rounds are 'final', never refused; its tools are refused, the reply goes on", () => {
    const at = pots(3, 0);
    const started = start(at, [], { run: "f", cls: "AB", x: P(13) });
    expect(started).toEqual({ kind: "started", part: part("f", "AB", 3, 10) });
    const parts = [part("f", "AB", 3, 10)];
    expect(tool(at, parts, { run: "f", cls: "AB", x: P(13) })).toBeNull();
    expect(round(at, parts, { run: "f", cls: "AB", x: P(5) })).toEqual({ answer: "final", add: part("f", "AB", 0, 5) });
  });

  it("V3-I1 — after a lone start past its pot (A 2, B 0, hold 13 → 2 + 11) a round asking nothing more is 'final', not 'ok'", () => {
    const at = pots(2, 0);
    const parts = [part("f", "AB", 2, 11)];
    expect(round(at, parts, { run: "f", cls: "AB", x: 0n })).toEqual({ answer: "final", add: part("f", "AB", 0) });
    // Another run's over is not this one's: beside g's lone start, f's round that fits is "ok".
    expect(round(pots(10, 0), [part("g", "AB", 2, 11), part("f", "AB", 3)], { run: "f", cls: "AB", x: P(4) }).answer).toBe("ok");
  });

  it("extend's two targets onto the pool (third attack, minor 4): 'ok' — raised to ok, all promised — when tools are allowed, the raise fits whole and the class carries no over; else 'final', raised to final, promised what fits; a target at or below the hold raises nothing", () => {
    const at = pots(10, 0);
    const f4 = [part("f", "AB", 4)];
    // Room 6: a raise of 5 to ok fits.
    expect(extendRound(at, f4, { run: "f", cls: "AB", held: P(4), ok: P(9), final: P(7), allowed: true })).toEqual({ answer: "ok", add: part("f", "AB", 5) });
    // A raise of 8 to ok does not: final, raised by 3, all of it fitting.
    expect(extendRound(at, f4, { run: "f", cls: "AB", held: P(4), ok: P(12), final: P(7), allowed: true })).toEqual({ answer: "final", add: part("f", "AB", 3) });
    // Final past the room: promised the room, the rest over.
    expect(extendRound(at, f4, { run: "f", cls: "AB", held: P(4), ok: P(20), final: P(15), allowed: true })).toEqual({ answer: "final", add: part("f", "AB", 6, 5) });
    // Tools not allowed (the cap or a lane budget): final, whatever fits.
    expect(extendRound(at, f4, { run: "f", cls: "AB", held: P(4), ok: P(5), final: P(5), allowed: false })).toEqual({ answer: "final", add: part("f", "AB", 1) });
    // V3-I1 through extend: the lone start's hold already covers the target, yet the class carries over: final.
    expect(extendRound(pots(2, 0), [part("f", "AB", 2, 11)], { run: "f", cls: "AB", held: P(13), ok: P(12), final: P(12), allowed: true })).toEqual({
      answer: "final",
      add: part("f", "AB", 0),
    });
    // A target below what is held: nothing raised, "ok".
    expect(extendRound(at, [part("f", "AB", 8)], { run: "f", cls: "AB", held: P(8), ok: P(6), final: P(6), allowed: true })).toEqual({ answer: "ok", add: part("f", "AB", 0) });
  });
});

describe("settlement (v3 §4; attack V2-I1)", () => {
  it("V2-I1 — A 0, B 10, paid P promised 8, free F raised to 12 while P holds: the same in both orders, and F's overrun is never P's debt", () => {
    const at = pots(0, 10);
    const p = start(at, [], { run: "p", cls: "B", x: P(8) });
    expect(p).toEqual({ kind: "started", part: part("p", "B", 8) });
    const withP = [part("p", "B", 8)];
    const f = start(at, withP, { run: "f", cls: "AB", x: P(2) });
    expect(f).toEqual({ kind: "started", part: part("f", "AB", 2) });
    const raised = round(at, [...withP, part("f", "AB", 2)], { run: "f", cls: "AB", x: P(10) });
    expect(raised).toEqual({ answer: "final", add: part("f", "AB", 0, 10) });
    const all = [...withP, part("f", "AB", 2), raised.add];
    const charges: Record<string, Charge[]> = { p: [{ cls: "B", cost: P(8) }], f: [{ cls: "AB", cost: P(12) }] };
    const fFirst = settleAll(at, all, ["f", "p"], charges, own);
    const pFirst = settleAll(at, all, ["p", "f"], charges, own);
    expect(fFirst.pots).toEqual(pots(0, 0));
    expect(pFirst.pots).toEqual(pots(0, 0));
    expect([fFirst.forgiven, fFirst.debt, pFirst.forgiven, pFirst.debt]).toEqual([P(10), 0n, P(10), 0n]);
  });

  it("what could not be reserved at the time is on the site: a free-tier over is forgiven even when a grant arrived before it settled", () => {
    // A 1, B 0: alone with 5 → 1 promised, 4 over. A grant of 10 lands before it settles at 5: 1 from A, 4 forgiven.
    const started = start(pots(1, 0), [], { run: "f", cls: "AB", x: P(5) });
    expect(started).toEqual({ kind: "started", part: part("f", "AB", 1, 4) });
    const s = settle(pots(1, 10), [part("f", "AB", 1, 4)], "f", [{ cls: "AB", cost: P(5) }], own);
    expect(s).toEqual({ pots: pots(0, 10), fromA: P(1), fromB: 0n, debt: 0n, forgiven: P(4) });
  });

  it("a paid-tier excess in the owner's own lane is a debt; in other people's lanes it is forgiven when Q4 says never below zero", () => {
    const at = pots(0, 3);
    const parts = [part("p", "B", 3, 2)];
    expect(settle(at, parts, "p", [{ cls: "B", cost: P(5) }], own)).toEqual({ pots: pots(0, -2), fromA: 0n, fromB: P(5), debt: P(2), forgiven: 0n });
    const q4 = (cls: PayClass) => excessRule(cls, "others", true);
    expect(settle(at, parts, "p", [{ cls: "B", cost: P(5) }], q4)).toEqual({ pots: pots(0, 0), fromA: 0n, fromB: P(3), debt: 0n, forgiven: P(2) });
    expect(excessRule("B", "others", false)).toBe("debt");
    expect(excessRule("AB", "own", false)).toBe("forgive");
  });

  it("a paid reply's own-lane debt is its own and may take the balance below what others were promised: their covered charges then land below zero", () => {
    // A 0, B 10: the paid reply alone with 15 → 10 + 5 over. A grant of 10 while it runs; a free-tier reply is promised 10.
    expect(start(pots(0, 10), [], { run: "p", cls: "B", x: P(15) })).toEqual({ kind: "started", part: part("p", "B", 10, 5) });
    const at = pots(0, 20);
    const parts = [part("p", "B", 10, 5)];
    expect(start(at, parts, { run: "f", cls: "AB", x: P(10) })).toEqual({ kind: "started", part: part("f", "AB", 10) });
    const s = settle(at, [...parts, part("f", "AB", 10)], "p", [{ cls: "B", cost: P(15) }], own);
    expect(s).toEqual({ pots: pots(0, 5), fromA: 0n, fromB: P(15), debt: P(5), forgiven: 0n });
    // f's promise of 10 has 5 under it now; what it used is still charged, to −5. The 5 below zero are p's debt.
    const f = settle(s.pots, [part("f", "AB", 10)], "f", [{ cls: "AB", cost: P(10) }], own);
    expect(f).toEqual({ pots: pots(0, -5), fromA: 0n, fromB: P(10), debt: 0n, forgiven: 0n });
  });

  it("a paid reply's model on the balance and its searches on the allowance first; a charge above what is held is refused", () => {
    const at = pots(10, 10);
    const parts = [part("p", "B", 6), part("p", "AB", 13)];
    // A cost above what the class holds (13) is the caller's bug.
    expect(() => settle(at, parts, "p", [{ cls: "AB", cost: P(14) }], own)).toThrow(/charged/);
    expect(settle(at, parts, "p", [{ cls: "B", cost: P(4) }, { cls: "AB", cost: P(12) }], own)).toEqual({ pots: pots(0, 4), fromA: P(10), fromB: P(6), debt: 0n, forgiven: 0n });
  });

  it("covered is measured per class within a run: a search that cost less than its hold covers the model's over (third attack V3.2)", () => {
    // A free-tier reply: model 2 promised + 6 over, a search held 13 that cost 7: 15 of 21 promised, nothing forgiven.
    const at = pots(30, 0);
    const parts = [part("f", "AB", 2, 6), part("f", "AB", 13)];
    expect(settle(at, parts, "f", [{ cls: "AB", cost: P(15) }], own)).toEqual({ pots: pots(15, 0), fromA: P(15), fromB: 0n, debt: 0n, forgiven: 0n });
  });

  it("during the overlap a legacy A row keeps its allowance: an AB charge takes only A's spare, then the balance", () => {
    const at = pots(10, 5);
    const parts = [part("l", "A", 10), part("x", "AB", 5)];
    expect(settle(at, parts, "x", [{ cls: "AB", cost: P(5) }], own)).toEqual({ pots: pots(10, 0), fromA: 0n, fromB: P(5), debt: 0n, forgiven: 0n });
  });
});

describe("the search's charge and the fuse (v3 §5; attack V2-I4)", () => {
  const p = P(13);
  const e = 13_000n;
  it("inside the trusted band the price scaled by the actual, at most the hold; outside it, or without a figure, the price", () => {
    expect(searchCharge(p, e, 7_000n)).toBe(P(7));
    expect(searchCharge(p, e, 20_000n)).toBe(p); // capped at the hold
    expect(searchCharge(p, e, 1_300n)).toBe(1_300_000n); // the band's edge
    expect(searchCharge(p, e, 1_299n)).toBe(p); // below the band: the estimate (the price) stands — not a tenth
    expect(searchCharge(p, e, 130_001n)).toBe(p);
    expect(searchCharge(p, e, null)).toBe(p);
    expect(searchCharge(0n, e, 7_000n)).toBe(0n);
    // Rounded up to a whole micro-point.
    expect(searchCharge(770_350n, 2_000n, 1_001n)).toBe(385_561n); // 385 560.175 → 385 561
  });

  it("the fuse takes the figure inside the band, else the estimate: a bogus low figure does not weaken it", () => {
    expect([fuseCost(e, 7_000n), fuseCost(e, 1n), fuseCost(e, 1_000_000n), fuseCost(e, null)]).toEqual([7_000n, e, e, e]);
    expect([inBand(e, 1_300n), inBand(e, 1_299n), inBand(e, 130_000n), inBand(e, 130_001n)]).toEqual([true, false, true, false]);
  });
});

describe("the two-pot proof cases (v3 §2)", () => {
  it("for small promise sets, a split exists exactly when (1)–(3) hold (brute force over every allocation)", () => {
    let checked = 0;
    for (let A = 0; A <= 4; A++) {
      for (let B = -2; B <= 4; B++) {
        for (const sizes of combos(3, 4)) {
          for (const classes of classCombos(3)) {
            const parts = sizes.map((s, i) => ({ run: `r${i}`, cls: classes[i]!, promised: BigInt(s), over: 0n }));
            const at = { A: BigInt(A), B: BigInt(B) };
            const byInequalities = holds(at, parts);
            expect([A, B, sizes.join(","), classes.join(","), split(at, parts) !== null]).toEqual([A, B, sizes.join(","), classes.join(","), byInequalities]);
            expect([A, B, sizes.join(","), classes.join(","), bruteForce(at, parts)]).toEqual([A, B, sizes.join(","), classes.join(","), byInequalities]);
            checked++;
          }
        }
      }
    }
    expect(checked).toBe(5 * 7 * 64 * 27);
  });

  it("a part admitted by room() keeps a split for every promise", () => {
    for (let A = 0; A <= 6; A++) {
      for (let B = -2; B <= 6; B++) {
        for (const sizes of combos(2, 5)) {
          for (const classes of classCombos(2)) {
            const at = { A: BigInt(A), B: BigInt(B) };
            const parts = sizes.map((s, i) => ({ run: `r${i}`, cls: classes[i]!, promised: BigInt(s), over: 0n }));
            if (split(at, parts) === null) continue;
            for (const cls of ["AB", "B", "A"] as const) {
              const x = room(at, parts, cls);
              expect(split(at, [...parts, { run: "n", cls, promised: x, over: 0n }])).not.toBeNull();
              expect(split(at, [...parts, { run: "n", cls, promised: x + 1n, over: 0n }])).toBeNull();
            }
          }
        }
      }
    }
  });
});

/**
 * A run in the random sequences: by new code — a free-tier reply (its model part `AB`), a paid-tier one (`B`), or a
 * provider model's (no model part, only its tools' `AB`) — or by old code during the overlap: a row admitted on the
 * free allowance (`A`) or the balance (`B`), whole, as old code writes it.
 */
type Kind = "free" | "paid" | "provider" | "old-free" | "old-balance";
type Lane = "own" | "others" | "proactive";
const isOld = (k: Kind): boolean => k === "old-free" || k === "old-balance";
const modelClass = (k: Kind): PayClass | null => (k === "free" ? "AB" : k === "paid" ? "B" : null);
/** The run row's `charge_to` as old code reads it (null: a provider model's run, which old code never counts). */
const chargeToOf = (k: Kind): "free" | "balance" | null => (k === "free" || k === "old-free" ? "free" : k === "paid" || k === "old-balance" ? "balance" : null);

describe("the invariants, over random sequences (third attack V3.3)", () => {
  /** How many random sequences the invariant test runs (each of up to 30 steps across up to 6 runs of one owner). */
  const SEQUENCES = 5000;

  it(`${SEQUENCES} random sequences — daily resets, grants, adjustments down, provider runs and old code's own rows — each step checked against the rule's statement`, () => {
    const rand = mulberry32(20261122);
    const n = (top: number): bigint => BigInt(Math.floor(rand() * top));
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
    const seen = { lonely: 0, overStarts: 0, roundsOnOver: 0, debts: 0, deficitUp: 0, old: 0, oldRaised: 0, resets: 0, adjustments: 0, orders: 0 };
    for (let seq = 0; seq < SEQUENCES; seq++) {
      const overlap = seq % 3 === 0; // old code still running beside the new: it admits, raises and settles rows of its own
      const A0 = n(30);
      const B0 = n(50) - 10n;
      let at: Pots = { A: A0, B: B0 };
      let parts: Part[] = [];
      const runs = new Map<string, { kind: Kind; lane: Lane }>();
      const q4 = rand() < 0.5;
      const rulesOf = (run: string) => (cls: PayClass) => excessRule(cls, runs.get(run)!.lane, q4);
      let grants = 0n; // into B
      let resets = 0n; // into A
      let adjustedDown = 0n; // out of B
      let charged = 0n; // what settlements took
      let sinks = 0n; // what may take the balance below the open promises: debts, adjustments down, old code's own holds
      const steps = 4 + Math.floor(rand() * 27);
      for (let step = 0; step < steps; step++) {
        const where = `${seq}:${step}`;
        const before = deficit(at, parts);
        const beforeOnA = overOnA(at, parts);
        let sink = 0n; // what this step may add to the deficit
        let sinkOnA = 0n; // what this step may add to old code's own overrun of the allowance (old code's steps only)
        let promise = false; // a promise of new code's: the deficit must not move at all
        const live = [...runs.keys()];
        const newRuns = live.filter((r) => !isOld(runs.get(r)!.kind));
        const modelRuns = newRuns.filter((r) => modelClass(runs.get(r)!.kind) !== null);
        const oldRuns = live.filter((r) => isOld(runs.get(r)!.kind));
        const roll = rand();
        if (live.length === 0 || (roll < 0.22 && runs.size < 6)) {
          // A new reply, by new code.
          const run = `r${step}`;
          const kind: Kind = rand() < 0.15 ? "provider" : rand() < 0.4 ? "paid" : "free";
          const lane = pick(["own", "others", "proactive"] as const);
          const cls = modelClass(kind);
          if (cls === null) {
            runs.set(run, { kind, lane }); // a provider model's run holds nothing of its own; its tools hold through the pool
          } else {
            const x = 1n + n(20);
            const draft = rand() < 0.1;
            const left = cls === "AB" ? at.A + pos(at.B) > 0n : at.B > 0n;
            const lone = aloneOn(parts, run, cls);
            const started = start(at, parts, { run, cls, x, share: rand() < 0.3 ? SHARE_WHOLE / 2n : SHARE_WHOLE, draft });
            // Refused only with nothing left of its class; a lone reply or a draft always starts.
            expect([where, started.kind === "no_quota"]).toEqual([where, !left]);
            if (left && (lone || draft)) {
              expect([where, started.kind]).toEqual([where, "started"]);
              seen.lonely++;
            }
            if (started.kind === "started") {
              // Only a lone reply or a draft takes more than the pots cover.
              if (started.part.over > 0n) {
                expect([where, lone || draft]).toEqual([where, true]);
                seen.overStarts++;
              }
              expectMostThatFits(where, at, parts, started.part, before);
              parts.push(started.part);
              runs.set(run, { kind, lane });
              promise = true;
            }
          }
        } else if (overlap && roll < 0.3 && runs.size < 6) {
          // A reply admitted by OLD code (admit.ts as deployed): its source by its own rule, every rule-1 row counted whole
          // on its charge_to, a provider run's tools not at all — so it may admit on pots new code promised elsewhere.
          const run = `o${step}`;
          const freeTier = rand() < 0.5;
          const x = 1n + n(15);
          const held = oldHolds(parts, runs);
          const chosen = freeTier && at.A > 0n ? "free" : at.B - held.balance > 0n ? "balance" : null;
          if (chosen !== null) {
            const rowsOn = [...runs.values()].filter((m) => chargeToOf(m.kind) === chosen).length;
            const heldOn = chosen === "free" ? held.free : held.balance;
            const leftOn = chosen === "free" ? at.A : at.B;
            if (rowsOn === 0 || heldOn + x <= leftOn) {
              parts.push({ run, cls: chosen === "free" ? "A" : "B", promised: x, over: 0n });
              runs.set(run, { kind: chosen === "free" ? "old-free" : "old-balance", lane: "own" });
              sink = x;
              if (chosen === "free") sinkOnA = x;
              seen.old++;
            }
          }
        } else if (overlap && roll < 0.34 && oldRuns.length > 0) {
          // Old code's raiseHold on its own row: "ok" within what it sees left, else "final" past it; greatest() as today.
          const run = pick(oldRuns);
          const kind = runs.get(run)!.kind;
          const mine = parts.find((p) => p.run === run)!;
          const held = oldHolds(parts, runs);
          const left = (kind === "old-free" ? at.A - held.free : at.B - held.balance) + mine.promised;
          const final = mine.promised + n(9);
          const ok = final + n(5);
          const next = big(mine.promised, rand() < 0.85 && ok <= left ? ok : final);
          parts = parts.map((p) => (p === mine ? { ...p, promised: next } : p));
          sink = next - mine.promised;
          if (kind === "old-free") sinkOnA = sink;
          if (sink > 0n) seen.oldRaised++;
        } else if (roll < 0.5 && modelRuns.length > 0) {
          // A later round of a new-code reply, through extend's two targets.
          const run = pick(modelRuns);
          const cls = modelClass(runs.get(run)!.kind)!;
          const mine = parts.filter((p) => p.run === run && p.cls === cls);
          const held = mine.reduce((s, p) => s + p.promised + p.over, 0n);
          const carriesOver = mine.some((p) => p.over > 0n);
          const final = held + n(12) - 3n;
          const ok = final + n(6);
          const allowed = rand() < 0.85;
          const r = extendRound(at, parts, { run, cls, held, ok, final, allowed });
          // "ok" exactly when tools are allowed, nothing of the class is over, and the raise to ok leaves the pots covering
          // every promise as they did; the hold becomes the target, never lowered.
          const okFits = deficit(at, [...parts, { run, cls, promised: pos(ok - held), over: 0n }]) === before;
          expect([where, r.answer]).toEqual([where, allowed && !carriesOver && okFits ? "ok" : "final"]);
          expect([where, held + r.add.promised + r.add.over]).toEqual([where, big(held, r.answer === "ok" ? ok : final)]);
          expectMostThatFits(where, at, parts, r.add, before);
          if (carriesOver) seen.roundsOnOver++;
          parts.push(r.add);
          promise = true;
        } else if (roll < 0.62 && newRuns.length > 0) {
          // A priced tool of a new-code run (a provider model's too): held whole exactly when the pots still cover every
          // promise with it as they did without it.
          const run = pick(newRuns);
          const x = 1n + n(13);
          const held = tool(at, parts, { run, cls: "AB", x });
          expect([where, held !== null]).toEqual([where, deficit(at, [...parts, { run, cls: "AB", promised: x, over: 0n }]) === before]);
          if (held !== null) {
            parts.push(held);
            promise = true;
          }
        } else if (roll < 0.82) {
          const run = pick(live);
          const kind = runs.get(run)!.kind;
          const mine = parts.filter((p) => p.run === run);
          const charges = randomCharges(rand, parts, run);
          if (isOld(kind)) {
            // The legacy branch, as old code settles (settle.ts as deployed): the cost up to the hold, to the row's source; on
            // the allowance at most what is left of it, the rest forgiven.
            const cost = charges.reduce((s, c) => s + c.cost, 0n);
            const due = small(cost, mine.reduce((s, p) => s + p.promised, 0n));
            const take = kind === "old-free" ? small(due, at.A) : due;
            at = kind === "old-free" ? { A: at.A - take, B: at.B } : { A: at.A, B: at.B - take };
            charged += take;
          } else {
            const expected = ruleCharge(mine, charges, rulesOf(run));
            const s = settle(at, parts, run, charges, rulesOf(run));
            expect([where, s.fromA + s.fromB, s.forgiven, s.debt]).toEqual([where, expected.charged, expected.forgiven, expected.debt]);
            // What is forgiven or owed is never more than what was over; a run without a paid-tier part never owes.
            const over = mine.reduce((t, p) => t + p.over, 0n);
            const bParts = mine.filter((p) => p.cls === "B");
            const bOver = bParts.reduce((t, p) => t + p.over, 0n);
            expect([where, s.forgiven <= over, s.debt <= bOver, bParts.length > 0 || s.debt === 0n]).toEqual([where, true, true, true]);
            at = s.pots;
            charged += s.fromA + s.fromB;
            sink = s.debt;
            if (s.debt > 0n) seen.debts++;
          }
          parts = parts.filter((p) => p.run !== run);
          runs.delete(run);
        } else if (roll < 0.88) {
          const g = n(10);
          at = { A: at.A, B: at.B + g };
          grants += g;
        } else if (roll < 0.93) {
          // An operator's adjustment down: it may break promises; what they used is still charged, below zero.
          const g = n(8);
          at = { A: at.A, B: at.B - g };
          adjustedDown += g;
          sink = g;
          seen.adjustments++;
        } else {
          // The daily reset: the allowance rises while the runs go on.
          const g = n(15);
          at = { A: at.A + g, B: at.B };
          resets += g;
          seen.resets++;
        }

        // After every step. The deficit (how far the balance falls short of every open promise, with nothing below zero):
        // a promise of new code's never moves it; a settlement adds at most its own debt, an adjustment down its size, old
        // code at most the hold it took — never more, and never later from an earlier one (not cumulative: a grant that
        // covered a debt leaves nothing for a later step to hide behind).
        const after = deficit(at, parts);
        if (promise) expect([where, after]).toEqual([where, before]);
        expect([where, after <= before + sink]).toEqual([where, true]);
        if (after > before) seen.deficitUp++;
        sinks += sink;
        // The allowance old code's rows were promised: new code never takes it from them (only old code itself overruns it).
        const afterOnA = overOnA(at, parts);
        expect([where, afterOnA <= beforeOnA + sinkOnA]).toEqual([where, true]);
        expect([where, at.A >= 0n]).toEqual([where, true]);
        // Nothing created or lost: the pots fell by exactly what the settlements took.
        expect([where, A0 + B0 + grants + resets - adjustedDown - at.A - at.B]).toEqual([where, charged]);
        // The balance's floor (v3 §4, with grants): only the sinks take it below min(B₀ + grants, 0).
        expect([where, at.B >= small(B0 + grants, 0n) - sinks]).toEqual([where, true]);

        // Now and then two open new-code runs settled in both orders from the same state, with the same charges.
        const openNew = [...runs.entries()].filter(([, m]) => !isOld(m.kind)).map(([r]) => r);
        if (openNew.length >= 2 && rand() < 0.15) {
          const pair = [openNew[0]!, openNew[openNew.length - 1]!];
          const charges = Object.fromEntries(pair.map((r) => [r, randomCharges(rand, parts, r)]));
          const forward = settleAllBy(at, parts, pair, charges, rulesOf);
          const backward = settleAllBy(at, parts, [...pair].reverse(), charges, rulesOf);
          // The owner's totals never depend on the order; without a legacy A row the pots do not either.
          expect([where, forward.fromA + forward.fromB, forward.forgiven, forward.debt]).toEqual([where, backward.fromA + backward.fromB, backward.forgiven, backward.debt]);
          if (!parts.some((p) => p.cls === "A")) expect([where, forward.pots]).toEqual([where, backward.pots]);
          seen.orders++;
        }
      }
    }
    // The generator reaches the states that matter (counts of this seed's sequences).
    expect(seen.lonely).toBeGreaterThan(SEQUENCES / 2);
    expect(seen.overStarts).toBeGreaterThan(500);
    expect(seen.roundsOnOver).toBeGreaterThan(500);
    expect(seen.debts).toBeGreaterThan(200);
    expect(seen.deficitUp).toBeGreaterThan(500);
    expect(seen.old).toBeGreaterThan(500);
    expect(seen.oldRaised).toBeGreaterThan(100);
    expect(seen.resets).toBeGreaterThan(1000);
    expect(seen.adjustments).toBeGreaterThan(1000);
    expect(seen.orders).toBeGreaterThan(500);
  });
});

// ── helpers ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * How far the balance falls short of paying every open promise with nothing left below zero, written from the
 * inequalities (v3 §2) apart from `room()`: the promised B, and what of the promised AB the allowance cannot take (A less
 * the legacy A promises, those capped at A — their excess beyond A is old code's own, forgiven), less B. 0 exactly when
 * a split exists.
 */
function deficit(at: Pots, parts: readonly Part[]): bigint {
  const sum = (cls: PayClass) => parts.filter((p) => p.cls === cls).reduce((s, p) => s + p.promised, 0n);
  const onA = small(sum("A"), at.A);
  return pos(sum("B") + pos(sum("AB") + onA - at.A) - at.B);
}

/** How far old code's rows on the allowance (legacy A) exceed it: old code's own overrun, which new code never adds to. */
function overOnA(at: Pots, parts: readonly Part[]): bigint {
  return pos(parts.filter((p) => p.cls === "A").reduce((s, p) => s + p.promised, 0n) - at.A);
}

/** A promise new code made moves the deficit not at all, and is the most that does not (one micro-point more would). */
function expectMostThatFits(where: string, at: Pots, parts: readonly Part[], add: Part, before: bigint): void {
  expect([where, deficit(at, [...parts, add])]).toEqual([where, before]);
  if (add.over > 0n) expect([where, deficit(at, [...parts, { ...add, promised: add.promised + 1n }]) > before]).toEqual([where, true]);
}

/** Whether no run but `run` holds anything on a pot of `cls`'s (the rule's statement: AB shares A and B; A and B share nothing). */
function aloneOn(parts: readonly Part[], run: string, cls: PayClass): boolean {
  const meets = (other: PayClass) => cls === "AB" || other === "AB" || other === cls;
  return parts.every((p) => p.run === run || !meets(p.cls) || p.promised + p.over === 0n);
}

/** What old code's `readHolds` sums by `charge_to`: a run row's whole hold (its tools' and its over too); a provider run's never. */
function oldHolds(parts: readonly Part[], runs: ReadonlyMap<string, { kind: Kind }>): { free: bigint; balance: bigint } {
  let free = 0n;
  let balance = 0n;
  for (const p of parts) {
    const to = chargeToOf(runs.get(p.run)!.kind);
    if (to === "free") free += p.promised + p.over;
    else if (to === "balance") balance += p.promised + p.over;
  }
  return { free, balance };
}

/** The charge `settle` is to make, from the rule's statement (v3 §4): per class, the cost up to the run's promise of it; a debt class's excess too. */
function ruleCharge(mine: readonly Part[], charges: readonly Charge[], rules: (cls: PayClass) => "forgive" | "debt") {
  let charged = 0n;
  let debt = 0n;
  let cost = 0n;
  for (const cls of ["A", "B", "AB"] as const) {
    const promised = mine.filter((p) => p.cls === cls).reduce((s, p) => s + p.promised, 0n);
    const c = charges.filter((x) => x.cls === cls).reduce((s, x) => s + x.cost, 0n);
    cost += c;
    charged += small(c, promised);
    if (rules(cls) === "debt") {
      charged += pos(c - promised);
      debt += pos(c - promised);
    }
  }
  return { charged, debt, forgiven: cost - charged };
}

function settleAll(at: Pots, parts: readonly Part[], order: string[], charges: Record<string, Charge[]>, rules: (cls: PayClass) => "forgive" | "debt") {
  return settleAllBy(at, parts, order, charges, () => rules);
}

function settleAllBy(at: Pots, parts: readonly Part[], order: string[], charges: Record<string, Charge[]>, rules: (run: string) => (cls: PayClass) => "forgive" | "debt") {
  let pots = at;
  let open = [...parts];
  let fromA = 0n;
  let fromB = 0n;
  let debt = 0n;
  let forgiven = 0n;
  for (const run of order) {
    const s = settle(pots, open, run, charges[run] ?? [], rules(run));
    pots = s.pots;
    open = open.filter((p) => p.run !== run);
    fromA += s.fromA;
    fromB += s.fromB;
    debt += s.debt;
    forgiven += s.forgiven;
  }
  return { pots, fromA, fromB, debt, forgiven };
}

/** A cost for each class `run` holds: at most what the class holds, often below what was promised, sometimes into its over. */
function randomCharges(rand: () => number, parts: readonly Part[], run: string): Charge[] {
  const out: Charge[] = [];
  for (const cls of ["A", "B", "AB"] as const) {
    const held = parts.filter((p) => p.run === run && p.cls === cls).reduce((s, p) => s + p.promised + p.over, 0n);
    if (held === 0n && !parts.some((p) => p.run === run && p.cls === cls)) continue;
    out.push({ cls, cost: (held * BigInt(Math.floor(rand() * 1001))) / 1000n });
  }
  return out;
}

/** (1)–(3) on the uncapped promised sums: the inequalities of v3 §2 for a set that is meant to be all promised. */
function holds(at: Pots, parts: readonly Part[]): boolean {
  const sum = (cls: PayClass) => parts.filter((p) => p.cls === cls).reduce((s, p) => s + p.promised, 0n);
  const b = at.B > 0n ? at.B : 0n;
  return sum("A") + sum("B") + sum("AB") <= at.A + b && sum("B") <= b && sum("A") <= at.A;
}

/** Whether some allocation of every AB part's promise over A and B fits both pots (every A-portion tried). */
function bruteForce(at: Pots, parts: readonly Part[]): boolean {
  const b = at.B > 0n ? at.B : 0n;
  const fixedA = parts.filter((p) => p.cls === "A").reduce((s, p) => s + p.promised, 0n);
  const fixedB = parts.filter((p) => p.cls === "B").reduce((s, p) => s + p.promised, 0n);
  const flexible = parts.filter((p) => p.cls === "AB").map((p) => p.promised);
  const go = (i: number, a: bigint, bb: bigint): boolean => {
    if (a > at.A || bb > b) return false;
    if (i === flexible.length) return true;
    for (let onA = 0n; onA <= flexible[i]!; onA++) if (go(i + 1, a + onA, bb + flexible[i]! - onA)) return true;
    return false;
  };
  return go(0, fixedA, fixedB);
}

/** Every list of `n` sizes from 0 to `top - 1`. */
function combos(n: number, top: number): number[][] {
  if (n === 0) return [[]];
  return combos(n - 1, top).flatMap((rest) => Array.from({ length: top }, (_, i) => [i, ...rest]));
}

/** Every list of `n` classes. */
function classCombos(n: number): PayClass[][] {
  if (n === 0) return [[]];
  return classCombos(n - 1).flatMap((rest) => (["AB", "B", "A"] as const).map((c) => [c, ...rest]));
}

/** A small seeded generator: the same sequences every run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
