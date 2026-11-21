import { describe, expect, it } from "vitest";
import { expectLinear, LOADED_TIMEOUT_MS, MIN_SAMPLE_MS } from "./helpers/linear.ts";

/**
 * The measuring helper itself (tests/helpers/linear.ts `expectLinear`): how many calls make a sample is never decided by one
 * call's time — a busy machine, a pause of the collector, a timer firing — so a sample is never too short to judge, and a
 * linear pass is never failed for being "too quick to measure" (the load-time flake of `provider-hints.test.ts`).
 */

/** Spends `ms` of wall-clock time, whatever the machine is doing: a pass whose time is what it is told. */
const spin = (ms: number): void => {
  const end = performance.now() + ms;
  while (performance.now() < end);
};

describe("expectLinear", () => {
  it("one slow call among quick ones (a busy moment) does not decide how long a sample is: the smaller input's samples are long enough to judge, and the pass is found linear", { timeout: LOADED_TIMEOUT_MS }, () => {
    for (const slowCall of [1, 2, 3, 4, 5]) {
      let calls = 0;
      const measured = expectLinear({
        n: 1000,
        make: (n) => n,
        run: (n) => {
          calls++;
          // About 10 µs for the smaller input, four times that for the larger — and one call of 30 ms.
          spin(calls === slowCall ? 30 : n * 0.00001);
        },
      });
      expect([slowCall, measured.small >= MIN_SAMPLE_MS / 2]).toEqual([slowCall, true]);
    }
  });

  it("a quadratic pass is still caught", { timeout: LOADED_TIMEOUT_MS }, () => {
    expect(() => expectLinear({ n: 1000, make: (n) => n, run: (n) => spin(n * n * 0.00000001) })).toThrow(/4 times the input/);
  });
});
