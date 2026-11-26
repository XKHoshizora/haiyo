import { describe, expect, it, vi } from "vitest";
import { isRunEnd, type Prepared } from "../src/agents/runtime/port.ts";
import { createToolbox } from "../src/agents/tools/index.ts";
import { useApp } from "./helpers/harness.ts";
import { OTHERS_ENV } from "./helpers/others.ts";
import { othersKitchen } from "./helpers/others-kitchen.ts";

/**
 * Fix round 1, F4: what a reply for others keeps on the wallet for its last call is the owner's own reply's calculation, for the
 * same model, level and offered tools — no separate sizing for outside replies. Read where it is made: every `maxCostMicro` of a
 * `begin` (the reply's first call at its input bound, and its last call at that bound plus what its tool rounds may add).
 */
const asked = vi.hoisted(() => [] as number[]);
vi.mock("../src/metering/prices.ts", async (original) => {
  const real = await original<typeof import("../src/metering/prices.ts")>();
  return {
    ...real,
    maxCostMicro: (resolved: Parameters<typeof real.maxCostMicro>[0], tokens: number) => {
      asked.push(tokens);
      return real.maxCostMicro(resolved, tokens);
    },
  };
});

const { app, db } = useApp({ env: OTHERS_ENV, agentWorker: false, tools: true });

describe("the room a reply keeps for its last call", () => {
  it("is the same for a reply for others as for the owner's own, with the same model, level and offered tools", async () => {
    const { db: pool, blobs, searches, config } = app.deps;
    const k = await othersKitchen(app, db, { box: createToolbox({ db: pool, blobs, searches, config, log: app.log }) });
    /** One reply begun: the tools it is offered, and its two input bounds (its first call's; its last call's, which a round may grow to). */
    const begun = async (ask: () => Promise<void>) => {
      await ask();
      const ticket = (await k.port.claimNext())!;
      asked.length = 0;
      const prepared = await k.port.begin(ticket);
      expect(isRunEnd(prepared)).toBe(false);
      const bounds = [...asked];
      await k.port.releaseRun(ticket.id);
      await db.query("update agent_runs set status = 'done', hold_micro = 0, finished_at = now() where id = $1", [ticket.id]);
      expect(bounds).toHaveLength(2);
      const [first, last] = [Math.min(...bounds), Math.max(...bounds)];
      return { offered: (prepared as Prepared).toolRun?.perTool ?? null, first, last };
    };
    const others = await begun(() => k.ask("@chef 附近有什么好吃的？"));
    const own = await begun(() => k.askAsOwner("@chef 附近有什么好吃的？"));
    expect(others.offered).not.toBeNull();
    expect(others.offered).toEqual(own.offered);
    // The offered tools' caps can bring back more than the room of one call of this model: the last call is held at that room —
    // the context beside the output limit, and what providers add around tools — for both alike, whatever their inputs.
    expect(own.last).toBeGreaterThan(own.first);
    expect(others.last).toBe(own.last);
  });
});
