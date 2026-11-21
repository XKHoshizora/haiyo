import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import type { AgentPort } from "../src/agents/runtime/port.ts";
import { createAgentWorker, POLL_MS } from "../src/agents/runtime/worker.ts";
import { betweenTests, NO_ANSWER_FLOOR, useApp } from "./helpers/harness.ts";
import { holdThen } from "./helpers/locks.ts";

/**
 * The harness between two tests (tests/helpers/harness.ts `betweenTests`): the database is emptied only once nothing of the
 * app is at work — no transaction of it open anywhere, one between two statements included — and nothing a timer starts can
 * begin meanwhile. Otherwise the truncate, which takes its tables' locks one by one, meets a transaction that holds one of
 * them and asks for another, and Postgres ends the cycle with `deadlock detected` (the load-time deadlocks of whole-suite runs).
 */

const { app, db } = useApp();

const truncating = async (): Promise<boolean> =>
  (await db.query("select 1 from pg_stat_activity where datname = current_database() and query ilike 'truncate %' and state = 'active'")).rowCount !== 0;

describe("between two tests", () => {
  it("the database is emptied only once every other transaction has ended — one idle between two statements too — so one that read a table and is about to read another cannot deadlock with the truncate", async () => {
    // A transaction as app work leaves one at a test's end: it has read `messages` and, before its next statement, waits.
    const open = holdThen(db, ["select 1 from messages limit 1", []], ["select 1 from accounts limit 1", []]);
    await open.locked;
    const cleaning = betweenTests(app, db, true);
    // The truncate takes its tables in name order, `accounts` long before `messages`: started now, it would hold `accounts`
    // and wait for `messages`, and the transaction's next statement would wait for `accounts` — a cycle. It waits instead.
    await new Promise((r) => setTimeout(r, 300));
    expect(await truncating()).toBe(false);
    open.release();
    await expect(open.done).resolves.toBeUndefined();
    await expect(cleaning).resolves.toBeUndefined();
  });

  it("the reply worker's loop claims nothing while it is held — neither its poll nor a wake-up —, and what was asked meanwhile is claimed once it is released", async () => {
    let claims = 0;
    const port = { claimNext: async () => (claims++, null) } as unknown as AgentPort;
    const worker = createAgentWorker({ port, models: app.deps.models, runTimeoutMs: 1000, maxRunsInFlight: 1, background: true, log: app.log, tools: app.deps.config.tools });
    try {
      worker.start();
      await worker.idle();
      const before = claims;
      const release = worker.hold();
      worker.wake();
      await new Promise((r) => setTimeout(r, POLL_MS + 200));
      await worker.idle();
      expect(claims).toBe(before);
      release();
      await worker.idle();
      expect(claims).toBe(before + 1);
      // Released once only: a second call changes nothing.
      release();
    } finally {
      await worker.stop();
    }
  });

  it("the hub's heartbeat runs on no timer under the harness (it beats by hand there); an app built otherwise has it", async () => {
    expect(app.realtime.beating).toBe(false);
    const built = await buildApp({ config: app.deps.config, db: app.deps.db }, { answerFloor: NO_ANSWER_FLOOR, staleRunSweep: false, proactive: false, memory: false, agentWorker: false, mail: { sender: false } });
    try {
      await built.ready();
      expect(built.realtime.beating).toBe(true);
    } finally {
      await built.close();
    }
  });
});
