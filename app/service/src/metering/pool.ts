/**
 * The money rule of wallet v3 as pure functions (.superpowers/sdd/2026-11-22-polish/design-wallet-v3.md): one pooled hold
 * per run, checked against the payer's pots together, split into pots only at settlement. No database, no I/O, no clock:
 * the executable spec the integration (admission, `extend`, the tools' pre-holds, `settle`) is to be built on. Nothing here
 * is wired in yet.
 *
 * Pots: A — what is left of today's free allowance (≥ 0); B — the balance (may be negative; B⁺ = max(B, 0)). Classes —
 * the pots that may pay a part: `AB` (free-tier model rounds, tools), `B` (paid-tier model rounds), `A` (only legacy
 * rows of the old code during the one deploy overlap). Written for these two pots; more pots make the families
 * non-nested and need a max-flow allocation instead of "allowance first" (v3 §9).
 */

export type PayClass = "AB" | "B" | "A";

/** The payer's pots now. `A` is never below 0; `B` may be. */
export interface Pots {
  readonly A: bigint;
  readonly B: bigint;
}

/**
 * One part of a running run's hold: its class, what the checks promised it (the pots are guaranteed to cover it), and
 * what it took beyond them (`over`: a lone start's or a "final" round's excess — promised to nobody).
 */
export interface Part {
  readonly run: string;
  readonly cls: PayClass;
  readonly promised: bigint;
  readonly over: bigint;
}

const max = (a: bigint, b: bigint): bigint => (a > b ? a : b);
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const plus = (b: bigint): bigint => max(b, 0n);

/** One million parts: the scale `HOLDS.maxOpenShare` is given in (1 000 000 = the whole). */
export const SHARE_WHOLE = 1_000_000n;

/** The promised sums by class over `parts`, single-pot classes capped at their pot (`pots`; v3 §2). */
export function promisedLoad(pots: Pots, parts: readonly Part[]): { A: bigint; B: bigint; AB: bigint } {
  let a = 0n;
  let b = 0n;
  let ab = 0n;
  for (const p of parts) {
    if (p.cls === "A") a += p.promised;
    else if (p.cls === "B") b += p.promised;
    else ab += p.promised;
  }
  return { A: min(a, pots.A), B: min(b, plus(pots.B)), AB: ab };
}

/**
 * The most a new promise of class `cls` may add beside `parts` (v3 §2): with capacities A and B⁺, scaled by `share`
 * (parts of `SHARE_WHOLE`) when given, `T = A + B⁺ − P_A − P_B − P_AB`; `AB`: T; `B`: min(B⁺ − P_B, T); `A`: min(A − P_A, T);
 * never below 0. The single-pot sums are capped at the real pots, whatever the scale.
 */
export function room(pots: Pots, parts: readonly Part[], cls: PayClass, share: bigint = SHARE_WHOLE): bigint {
  const load = promisedLoad(pots, parts);
  const capA = (pots.A * share) / SHARE_WHOLE;
  const capB = (plus(pots.B) * share) / SHARE_WHOLE;
  const total = capA + capB - load.A - load.B - load.AB;
  if (cls === "AB") return max(0n, total);
  if (cls === "B") return max(0n, min(capB - load.B, total));
  return max(0n, min(capA - load.A, total));
}

/** Whether two classes share a pot (`AB` shares with every class; `A` and `B` share nothing). */
export const sharesPot = (x: PayClass, y: PayClass): boolean => x === "AB" || y === "AB" || x === y;

/** Whether class `cls` has anything left to start with (v3 §3, step 1): `AB`: A + B⁺ > 0; `B`: B > 0; `A`: A > 0. */
export function somethingLeft(pots: Pots, cls: PayClass): boolean {
  if (cls === "AB") return pots.A + plus(pots.B) > 0n;
  if (cls === "B") return pots.B > 0n;
  return pots.A > 0n;
}

/** Whether no other run than `run` holds anything (promised or over) on a class that shares a pot with `cls`. */
export function alone(parts: readonly Part[], run: string, cls: PayClass): boolean {
  return !parts.some((p) => p.run !== run && sharesPot(p.cls, cls) && p.promised + p.over > 0n);
}

/** What a hold asks for, and what the rule answered: the part to add (promised, over) or why not. */
export type Started = { kind: "started"; part: Part } | { kind: "waits" } | { kind: "no_quota" };

/**
 * A reply's first call of class `cls` and hold `x` (v3 §3): refused `no_quota` with nothing left of its class; started with
 * promised x when it fits the share-scaled room; else, alone on its pots (or a draft, which never waits), started whatever
 * its hold — promised what fits unscaled, the rest over; else it waits.
 */
export function start(
  pots: Pots,
  parts: readonly Part[],
  o: { run: string; cls: PayClass; x: bigint; share?: bigint; draft?: boolean },
): Started {
  if (!somethingLeft(pots, o.cls)) return { kind: "no_quota" };
  if (o.x <= room(pots, parts, o.cls, o.share ?? SHARE_WHOLE)) return { kind: "started", part: { run: o.run, cls: o.cls, promised: o.x, over: 0n } };
  if (o.draft === true || alone(parts, o.run, o.cls)) {
    const promised = min(o.x, room(pots, parts, o.cls));
    return { kind: "started", part: { run: o.run, cls: o.cls, promised, over: o.x - promised } };
  }
  return { kind: "waits" };
}

/**
 * A later round raising a run's part of class `cls` by `x` (v3 §3): never refused — promised what fits the unscaled room,
 * the rest over; "ok" when nothing is over (another round may follow), else "final" (it is the reply's last).
 */
export function round(pots: Pots, parts: readonly Part[], o: { run: string; cls: PayClass; x: bigint }): { answer: "ok" | "final"; add: Part } {
  const promised = min(o.x, room(pots, parts, o.cls));
  const over = o.x - promised;
  return { answer: over === 0n ? "ok" : "final", add: { run: o.run, cls: o.cls, promised, over } };
}

/** A priced tool's hold `x` of class `cls` (v3 §3): held whole when it fits the unscaled room, else refused. */
export function tool(pots: Pots, parts: readonly Part[], o: { run: string; cls: PayClass; x: bigint }): Part | null {
  return o.x <= room(pots, parts, o.cls) ? { run: o.run, cls: o.cls, promised: o.x, over: 0n } : null;
}

/** What becomes of a charge above its promise (v3 §4): forgiven by the site, or a debt on the balance. */
export type ExcessRule = "forgive" | "debt";

/**
 * The excess rule by class, tier and lane (v3 §4): a free-tier `AB` excess is forgiven (Q2); a paid-tier `B` excess is a
 * debt in the owner's own lane, and in other people's lanes too unless Q4 is answered "never below zero"
 * (`othersNeverBelowZero`); a legacy `A` excess is forgiven.
 */
export function excessRule(cls: PayClass, lane: "own" | "others" | "proactive", othersNeverBelowZero: boolean): ExcessRule {
  if (cls !== "B") return "forgive";
  return lane !== "own" && othersNeverBelowZero ? "forgive" : "debt";
}

/** A run's charge for one of its parts' classes: its cost (at most what the part holds, promised and over together). */
export interface Charge {
  readonly cls: PayClass;
  readonly cost: bigint;
}

/** What one settlement took and left (v3 §4). */
export interface Settlement {
  pots: Pots;
  fromA: bigint;
  fromB: bigint;
  /** Of `fromB`, what was taken past what was promised (a paid-tier excess). */
  debt: bigint;
  forgiven: bigint;
}

/**
 * Settles run `run` (v3 §4): for each class it holds, the cost's `covered = min(cost, promised)` is paid from the class's
 * pots — `B` from B, `A` from A, `AB` allowance first from A's spare (A less the other runs' open promised `A`, capped),
 * then B — and the excess follows `rules(cls)`: forgiven, or a debt on B. Pots are written only here; the run's parts are
 * released (the caller drops them). A cost above what the class holds is refused (a bug of the caller's).
 */
export function settle(pots: Pots, parts: readonly Part[], run: string, charges: readonly Charge[], rules: (cls: PayClass) => ExcessRule): Settlement {
  const mine = parts.filter((p) => p.run === run);
  const others = parts.filter((p) => p.run !== run);
  let A = pots.A;
  let B = pots.B;
  let fromA = 0n;
  let fromB = 0n;
  let debt = 0n;
  let forgiven = 0n;
  // Single-pot classes first: their pot is theirs; then `AB`, allowance first.
  const order: PayClass[] = ["A", "B", "AB"];
  for (const cls of order) {
    const held = mine.filter((p) => p.cls === cls);
    const promised = held.reduce((s, p) => s + p.promised, 0n);
    const over = held.reduce((s, p) => s + p.over, 0n);
    const cost = charges.filter((c) => c.cls === cls).reduce((s, c) => s + c.cost, 0n);
    if (cost < 0n || cost > promised + over) throw new Error(`settle: run ${run} charged ${cost} on ${cls}, holding ${promised + over}`);
    const covered = min(cost, promised);
    const excess = cost - covered;
    if (cls === "A") {
      const take = min(covered, A);
      A -= take;
      fromA += take;
      forgiven += covered - take + excess;
      continue;
    }
    if (cls === "B") {
      B -= covered;
      fromB += covered;
    } else {
      const othersA = min(others.filter((p) => p.cls === "A").reduce((s, p) => s + p.promised, 0n), A);
      const spare = max(0n, A - othersA);
      const takeA = min(covered, spare);
      A -= takeA;
      fromA += takeA;
      B -= covered - takeA;
      fromB += covered - takeA;
    }
    if (rules(cls) === "debt") {
      B -= excess;
      fromB += excess;
      debt += excess;
    } else {
      forgiven += excess;
    }
  }
  return { pots: { A, B }, fromA, fromB, debt, forgiven };
}

/**
 * A split of `parts`' promises over `pots` that pays each part only from its class's pots and no pot beyond its size
 * (`B` up to B⁺), or null when none exists: the constructive one of v3 §2's proof (single-pot classes on their pots, then
 * `AB` allowance first). What the invariant tests check after every step.
 */
export function split(pots: Pots, parts: readonly Part[]): { A: bigint; B: bigint } | null {
  let a = 0n;
  let b = 0n;
  let ab = 0n;
  for (const p of parts) {
    if (p.cls === "A") a += p.promised;
    else if (p.cls === "B") b += p.promised;
    else ab += p.promised;
  }
  const capB = plus(pots.B);
  if (a > pots.A || b > capB) return null;
  const abOnA = min(ab, pots.A - a);
  const abOnB = ab - abOnA;
  if (b + abOnB > capB) return null;
  return { A: a + abOnA, B: b + abOnB };
}

/**
 * A search's charge (v3 §5): `p` the configured price (the hold), `e` the site's estimate in micro-USD, `a` the engine's
 * own figure in micro-USD (null: none). Inside the trusted band [⌈e/10⌉, 10e] the price scaled by a/e, rounded up and
 * never above p; outside it, or without a figure, p.
 */
export function searchCharge(p: bigint, e: bigint, a: bigint | null): bigint {
  if (a === null || !inBand(e, a)) return p;
  return min(p, (p * a + e - 1n) / e);
}

/** What one search adds to the site's daily money fuse (v3 §5): the engine's figure inside the trusted band, else the estimate. */
export function fuseCost(e: bigint, a: bigint | null): bigint {
  return a !== null && inBand(e, a) ? a : e;
}

/** Whether `a` lies in the trusted band of estimate `e`: from a tenth (rounded up) to ten times. */
export const inBand = (e: bigint, a: bigint): boolean => a >= (e + 9n) / 10n && a <= 10n * e;
