import { describe, expect, it } from "vitest";
import {
  alone,
  excessRule,
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
 * (src/metering/pool.ts): every counterexample of both attacks (design-wallet-attack.md) as a named case, the live case,
 * the two-pot proof cases, and a randomized invariant test over many sequences of holds, charges and settlements across
 * concurrent runs of one owner. Pure: no database, nothing wired in.
 */

const P = (n: number): bigint => BigInt(n) * 1_000_000n; // whole points, in micro-points
const pots = (A: number, B: number): Pots => ({ A: P(A), B: P(B) });
const part = (run: string, cls: PayClass, promised: number, over = 0): Part => ({ run, cls, promised: P(promised), over: P(over) });
const own = (cls: PayClass) => excessRule(cls, "own", false);

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
    // The model cost 2, the search 7 (its actual): 9 from A, nothing from the balance.
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

describe("the start rule and the lone reply (v3 §3; attack V2-I2, V2-I3)", () => {
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

  it("a paid-tier excess in the owner's own lane is a debt; in other people's lanes it is forgiven when Q4 says never below zero", () => {
    const at = pots(0, 3);
    const parts = [part("p", "B", 3, 2)];
    expect(settle(at, parts, "p", [{ cls: "B", cost: P(5) }], own)).toEqual({ pots: pots(0, -2), fromA: 0n, fromB: P(5), debt: P(2), forgiven: 0n });
    const q4 = (cls: PayClass) => excessRule(cls, "others", true);
    expect(settle(at, parts, "p", [{ cls: "B", cost: P(5) }], q4)).toEqual({ pots: pots(0, 0), fromA: 0n, fromB: P(3), debt: 0n, forgiven: P(2) });
    expect(excessRule("B", "others", false)).toBe("debt");
    expect(excessRule("AB", "own", false)).toBe("forgive");
  });

  it("a paid reply's model on the balance and its searches on the allowance first; a charge above what is held is refused", () => {
    const at = pots(10, 10);
    const parts = [part("p", "B", 6), part("p", "AB", 13)];
    // A cost above what the class holds (13) is the caller's bug.
    expect(() => settle(at, parts, "p", [{ cls: "AB", cost: P(14) }], own)).toThrow(/charged/);
    expect(settle(at, parts, "p", [{ cls: "B", cost: P(4) }, { cls: "AB", cost: P(12) }], own)).toEqual({ pots: pots(0, 4), fromA: P(10), fromB: P(6), debt: 0n, forgiven: 0n });
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

describe("the invariants, over random sequences", () => {
  /** How many random sequences the invariant test runs (each of up to 24 steps across up to 5 runs of one owner). */
  const SEQUENCES = 5000;

  it(`${SEQUENCES} random sequences: no pot below its floor, nothing created or lost, a lone reply always starts, a split for every promise, the outcome independent of settlement order`, () => {
    const rand = mulberry32(20261122);
    let lonelyStarts = 0;
    let orderCompared = 0;
    for (let seq = 0; seq < SEQUENCES; seq++) {
      const legacyAllowed = seq % 4 === 0;
      const A0 = BigInt(Math.floor(rand() * 30));
      const B0 = BigInt(Math.floor(rand() * 50) - 10);
      let at: Pots = { A: A0, B: B0 };
      let parts: Part[] = [];
      const runs = new Map<string, { cls: PayClass; lane: "own" | "others" | "proactive" }>();
      let grants = 0n;
      let debts = 0n;
      let costs = 0n;
      let paid = 0n;
      let forgiven = 0n;
      const q4 = rand() < 0.5;
      const rulesOf = (run: string) => (cls: PayClass) => excessRule(cls, runs.get(run)!.lane, q4);
      const check = (where: string) => {
        expect([where, at.A >= 0n]).toEqual([where, true]);
        // The balance never below where promises alone could take it: only debts go further.
        expect([where, at.B + debts >= (B0 + grants < 0n ? B0 + grants : 0n)]).toEqual([where, true]);
        // Every open promise still has a split (debts aside: a debt is below the floor by its own rule).
        expect([where, split({ A: at.A, B: at.B + debts }, parts) !== null]).toEqual([where, true]);
        // Nothing created or lost.
        expect([where, A0 + B0 + grants - at.A - at.B]).toEqual([where, paid]);
        expect([where, paid + forgiven]).toEqual([where, costs]);
      };
      const steps = 4 + Math.floor(rand() * 20);
      for (let step = 0; step < steps; step++) {
        const roll = rand();
        const live = [...runs.keys()];
        if ((roll < 0.3 && runs.size < 5) || live.length === 0) {
          const run = `r${seq}-${step}`;
          const cls: PayClass = legacyAllowed && rand() < 0.15 ? "A" : rand() < 0.4 ? "B" : "AB";
          const lane = (["own", "others", "proactive"] as const)[Math.floor(rand() * 3)]!;
          const x = BigInt(1 + Math.floor(rand() * 20));
          const share = rand() < 0.3 ? SHARE_WHOLE / 2n : SHARE_WHOLE;
          const draft = rand() < 0.1;
          const wasAlone = alone(parts, run, cls);
          const started = start(at, parts, { run, cls, x, share, draft });
          if (wasAlone && somethingLeft(at, cls)) {
            expect([`${seq}:${step} lone start`, started.kind]).toEqual([`${seq}:${step} lone start`, "started"]);
            lonelyStarts++;
          }
          if (!somethingLeft(at, cls)) expect(started.kind).toBe("no_quota");
          if (started.kind === "started") {
            expect(started.part.promised + started.part.over).toBe(x);
            parts.push(started.part);
            runs.set(run, { cls, lane });
          }
        } else if (roll < 0.55) {
          const run = live[Math.floor(rand() * live.length)]!;
          const r = round(at, parts, { run, cls: runs.get(run)!.cls, x: BigInt(Math.floor(rand() * 15)) });
          expect(r.answer).toBe(r.add.over === 0n ? "ok" : "final");
          parts.push(r.add);
        } else if (roll < 0.75) {
          const run = live[Math.floor(rand() * live.length)]!;
          if (runs.get(run)!.cls === "A") continue;
          const x = BigInt(1 + Math.floor(rand() * 13));
          const held = tool(at, parts, { run, cls: "AB", x });
          if (held !== null) parts.push(held);
          else expect(x > room(at, parts, "AB")).toBe(true);
        } else if (roll < 0.92) {
          const run = live[Math.floor(rand() * live.length)]!;
          const charges = randomCharges(rand, parts, run);
          const s = settle(at, parts, run, charges, rulesOf(run));
          at = s.pots;
          parts = parts.filter((p) => p.run !== run);
          runs.delete(run);
          debts += s.debt;
          paid += s.fromA + s.fromB;
          forgiven += s.forgiven;
          costs += charges.reduce((sum, c) => sum + c.cost, 0n);
        } else {
          const g = BigInt(Math.floor(rand() * 10));
          at = { A: at.A, B: at.B + g };
          grants += g;
        }
        check(`${seq}:${step}`);
      }
      // What is still running, settled in two orders from the same state, with the same charges.
      const left = [...runs.keys()];
      if (left.length >= 2) {
        const charges = Object.fromEntries(left.map((run) => [run, randomCharges(rand, parts, run)]));
        const rules = (run: string) => rulesOf(run);
        const forward = settleAllBy(at, parts, left, charges, rules);
        const backward = settleAllBy(at, parts, [...left].reverse(), charges, rules);
        const hasLegacyA = parts.some((p) => p.cls === "A");
        // The owner's totals never depend on the order; without a legacy A row the pots do not either.
        expect([seq, forward.fromA + forward.fromB, forward.forgiven, forward.debt]).toEqual([seq, backward.fromA + backward.fromB, backward.forgiven, backward.debt]);
        if (!hasLegacyA) expect([seq, forward.pots]).toEqual([seq, backward.pots]);
        orderCompared++;
      }
    }
    expect(lonelyStarts).toBeGreaterThan(SEQUENCES / 2);
    expect(orderCompared).toBeGreaterThan(SEQUENCES / 10);
  });
});

// ── helpers ───────────────────────────────────────────────────────────────────────────────────────────────────────────

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
