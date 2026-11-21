import { expect } from "vitest";

/**
 * "Linear, not quadratic" tests without an absolute bound on milliseconds.
 *
 * `expectLinear` builds an input of size `n` and one `factor` times larger, times `run` on both, and asserts that the
 * larger takes less than `2 * factor` times as long as the smaller: a linear pass takes about `factor` times as long, a
 * quadratic one `factor ** 2` times (so use a `factor` of at least 4: that is 8 against 16). Nothing in it depends on how
 * fast the machine is, nor on how busy it is at any one moment:
 *  - one sample is `reps` calls in a row, with `reps` found by measuring, never by one call's time: doubled until the
 *    fastest of `CALIBRATION_SAMPLES` samples of the smaller size lasts at least `MIN_SAMPLE_MS` (ten times a timer's
 *    grain: neither it nor one pause of the collector decides a sample that long). One call made slow by a busy moment
 *    cannot make the samples short (it is one sample's, and the fastest is taken), and a call too quick even at
 *    `MAX_REPS` is made longer by growing the input, never judged as it is;
 *  - the larger size runs the same `reps`; each size counts by its fastest sample (a busy machine only ever adds time, so
 *    the fastest is the one closest to the truth), the two are sampled in turn (a load that lasts is felt by both), and
 *    more pairs are taken, up to `MAX_PAIRS`, while the two are not yet in proportion. Should the machine have got so much
 *    quicker since `reps` was found that the smaller's fastest sample falls under half of `MIN_SAMPLE_MS`, `reps` is
 *    doubled and the pairs start over (at most `MAX_RECALIBRATIONS` times).
 * A busy machine makes the measurement longer, not wrong: a test that uses it asks for a timeout of its own that leaves
 * room for that (`LOADED_TIMEOUT_MS`).
 * `run` should check its own result (throw when it is wrong; `expect` costs time in the samples), so that a call that does less than it should cannot pass for fast.
 */
export const MIN_SAMPLE_MS = 10;
const CALIBRATION_SAMPLES = 3;
const MIN_PAIRS = 3;
const MAX_PAIRS = 25;
const MAX_RECALIBRATIONS = 4;
/** For the `it(…, { timeout })` of a test that calls `expectLinear` several times: a loaded machine takes several times longer to measure. */
export const LOADED_TIMEOUT_MS = 60_000;
const MAX_REPS = 5_000;
const MAX_N = 50_000_000;

const timed = (run: () => void, reps: number): number => {
  const started = performance.now();
  for (let i = 0; i < reps; i++) run();
  return performance.now() - started;
};

/** The fastest of `count` samples of `reps` calls of `run`. */
const fastest = (run: () => void, reps: number, count: number): number => {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < count; i++) best = Math.min(best, timed(run, reps));
  return best;
};

/** The fewest calls (doubling from 1) whose fastest sample lasts `MIN_SAMPLE_MS`; null when `MAX_REPS` calls are still quicker. */
function repsFor(run: () => void): number | null {
  for (let reps = 1; ; reps = Math.min(MAX_REPS, reps * 2)) {
    if (fastest(run, reps, CALIBRATION_SAMPLES) >= MIN_SAMPLE_MS) return reps;
    if (reps >= MAX_REPS) return null;
  }
}

export function expectLinear<T>(options: { n: number; factor?: number; make: (n: number) => T; run: (input: T) => void }): { small: number; large: number; reps: number; n: number } {
  const { factor = 4, make, run } = options;
  let n = options.n;
  expect(factor).toBeGreaterThanOrEqual(4);
  let [small, large] = [make(n), make(n * factor)];
  let reps: number | null;
  for (;;) {
    run(small); // warm up (compilation), and the result is checked once
    run(large);
    reps = repsFor(() => run(small));
    if (reps !== null || n >= MAX_N) break;
    n *= 4;
    [small, large] = [make(n), make(n * factor)];
  }
  reps ??= MAX_REPS;
  const [once, twice] = [() => run(small), () => run(large)];
  let [fastSmall, fastLarge] = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  // Pairs of samples, until the fastest of each size (so far) are in proportion, but at least `MIN_PAIRS` of them: noise only
  // ever adds time, so a busy machine takes more pairs, not a different answer (the fastest of each size, not the median,
  // because noise is one-sided: a median of a loaded machine is a measurement of the load), and a pass gone quadratic
  // (16 times, not 4) stays above the bound in every pair until `MAX_PAIRS` end it.
  for (let pair = 0, again = 0; pair < MAX_PAIRS; pair++) {
    fastSmall = Math.min(fastSmall, timed(once, reps));
    fastLarge = Math.min(fastLarge, timed(twice, reps));
    if (fastSmall < MIN_SAMPLE_MS / 2 && again < MAX_RECALIBRATIONS && reps < MAX_REPS) {
      // Quicker than when `reps` was found: longer samples, measured afresh.
      again++;
      reps = Math.min(MAX_REPS, reps * 2);
      [fastSmall, fastLarge, pair] = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, -1];
      continue;
    }
    if (pair + 1 >= MIN_PAIRS && fastLarge / fastSmall < 2 * factor) break;
  }
  expect(fastSmall, "the smaller input is still too quick to measure: give `expectLinear` a larger `n`").toBeGreaterThanOrEqual(MIN_SAMPLE_MS / 10);
  expect([`${factor} times the input`, fastLarge / fastSmall < 2 * factor], `large ${fastLarge.toFixed(1)} ms, small ${fastSmall.toFixed(1)} ms, ${reps} calls a sample, n ${n}`).toEqual([`${factor} times the input`, true]);
  return { small: fastSmall, large: fastLarge, reps, n };
}
