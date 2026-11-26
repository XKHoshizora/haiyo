import { afterEach, describe, expect, it, vi } from "vitest";
import { useApp } from "./helpers/harness.ts";
import { paidReply } from "./helpers/metering.ts";
import { OTHERS_ENV, PAID_MODEL, POINT } from "./helpers/others.ts";
import { othersKitchen } from "./helpers/others-kitchen.ts";
import { closeAllSockets } from "./helpers/ws.ts";

/**
 * Fix round 3, point 2: the site day the owner's numbers for others are read for is the day it is WHEN THE HOLD IS PLACED, under the
 * owner's account lock, not the day it was when the reply began to be prepared — nor the day it was just before the lock was waited
 * for. Through the production path: the real `begin` of the real port. The wall clock passes the site's midnight WHILE ADMISSION
 * WAITS FOR THE ACCOUNT LOCK (fix round 4: another transaction holds the owner's account row; the clock is moved only once a
 * statement of this database is waiting for a lock, and then the row is let go). So a clock read anywhere before the lock is
 * granted — in step 1, or in admission just before it asks for the lock — reads the old day, and these tests fail. Nothing hands
 * admission a timestamp.
 */
const { app, db } = useApp({ env: OTHERS_ENV, agentWorker: false });
afterEach(async () => {
  vi.useRealTimers();
  await closeAllSockets();
});

/** 23:59:50 and 00:00:10 in Shanghai, the site's zone here. */
const BEFORE = new Date("2026-03-01T15:59:50Z");
const AFTER = new Date("2026-03-01T16:00:10Z");

/**
 * Runs `work` with the owner's account row held by another transaction; once a statement is waiting for a lock (admission's, on that
 * row), the clock is moved past midnight and the row is let go. Returns whether a statement was seen waiting.
 */
async function overMidnightAtTheLock(ownerId: string, work: () => Promise<unknown>): Promise<boolean> {
  let letGo: () => void = () => {};
  const gate = new Promise<void>((r) => (letGo = r));
  let held: () => void = () => {};
  const holding = new Promise<void>((r) => (held = r));
  const holder = db.tx(async (t) => {
    await t.query("select 1 from accounts where principal_id = $1 for update", [ownerId]);
    held();
    await gate;
  });
  await holding;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(BEFORE);
  const working = work();
  let waited = false;
  for (let i = 0; i < 400 && !waited; i += 1) {
    await new Promise((r) => setTimeout(r, 25));
    waited = (await db.query<{ n: number }>("select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'")).rows[0]!.n > 0;
  }
  // Admission stands at the account lock: midnight passes now, before the lock is granted.
  vi.setSystemTime(AFTER);
  letGo();
  await holder;
  await working;
  return waited;
}

describe("a reply for others prepared across the site's midnight", () => {
  it("is admitted against the NEW day's use: with the new day's number already reached by another reply, it is refused (no call), though yesterday was below it", async () => {
    const k = await othersKitchen(app, db, { agent: { model: PAID_MODEL } });
    await k.ask();
    // After midnight another reply for others of this owner has settled the day's 300 points: the number is reached.
    await paidReply(db, { agentId: k.agent.id as string, ownerId: k.owner.id, conversationId: k.agent.conversationId as string, lane: "others", micro: 300n * POINT, at: new Date(AFTER.getTime() + 1000) });
    k.gateway.reply("不该说出来。");
    let ran: boolean | undefined;
    expect(await overMidnightAtTheLock(k.owner.id, async () => (ran = await k.worker.runOnce()))).toBe(true);
    expect(ran).toBe(true);
    expect(k.gateway.calls).toHaveLength(0);
    expect(await k.lastRun()).toMatchObject({ status: "cancelled", error: null, hold: "0" });
    expect(await k.posted()).toEqual([]);
    // Nothing of it was held or charged on either day.
    const used = (await db.query<{ n: string }>("select coalesce(sum(free_micro + balance_micro), 0)::text as n from usage_records where owner_id = $1", [k.owner.id])).rows[0]!.n;
    expect(used).toBe((300n * POINT).toString());
  });

  it("and the other way: yesterday's number reached, the new day's use is what counts: it is answered, and its admission is stamped on the new day", async () => {
    const k = await othersKitchen(app, db, { agent: { model: PAID_MODEL } });
    await k.ask();
    await paidReply(db, { agentId: k.agent.id as string, ownerId: k.owner.id, conversationId: k.agent.conversationId as string, lane: "others", micro: 300n * POINT, at: new Date(BEFORE.getTime() - 1000) });
    k.gateway.reply("好。");
    expect(await overMidnightAtTheLock(k.owner.id, () => k.worker.runOnce())).toBe(true);
    expect(await k.posted()).toEqual(["好。"]);
    const admitted = (await db.query<{ at: Date }>("select admitted_at as at from agent_runs where conversation_id = $1 order by created_at desc limit 1", [k.g])).rows[0]!.at;
    expect(admitted.getTime()).toBeGreaterThanOrEqual(AFTER.getTime());
  });
});
