import type { FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.ts";
import { NO_ANSWER_FLOOR, useApp } from "./helpers/harness.ts";

/**
 * A stop of the service aborts what Agent social's worker has in flight instead of waiting for it (plan T0.3, as built): the worker
 * is built with the memory calls' `closing` signal and closed in `preClose`, after that signal is aborted. The worker here is a
 * stand-in whose one pass is "a model call" that ends only when the signal says so.
 */
const seen = vi.hoisted(() => ({ finished: false, abortedAtClose: null as boolean | null, started: 0 }));
vi.mock("../src/memory/judge.ts", () => ({
  startNoteJudge: (deps: { closing: AbortSignal }) => {
    seen.started++;
    const inFlight = new Promise<void>((resolve) =>
      deps.closing.addEventListener("abort", () => {
        seen.finished = true;
        resolve();
      }),
    );
    return {
      runOnce: async () => 0,
      close: async () => {
        seen.abortedAtClose = deps.closing.aborted;
        await inFlight;
      },
    };
  },
}));

describe("stopping the service with Agent social's worker busy", () => {
  const { app } = useApp({ agentWorker: false });

  it("aborts its call at once; nothing waits out the grace period", async () => {
    const built: FastifyInstance = await buildApp({ config: app.deps.config, db: app.deps.db }, { answerFloor: NO_ANSWER_FLOOR, heartbeat: false, pushTimer: false, noteJudgeTimer: false, agentWorker: false, tools: false, greeting: false, mail: { sender: false } });
    await built.ready();
    expect(seen.started).toBeGreaterThanOrEqual(2);
    seen.finished = false;
    seen.abortedAtClose = null;
    const t0 = Date.now();
    await built.close();
    expect(seen.finished).toBe(true);
    expect(seen.abortedAtClose).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2500);
  });
});
