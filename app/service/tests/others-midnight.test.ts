import { afterEach, describe, expect, it, vi } from "vitest";
import { useApp } from "./helpers/harness.ts";
import { paidReply } from "./helpers/metering.ts";
import { OTHERS_ENV, PAID_MODEL, POINT } from "./helpers/others.ts";
import { boxOf, othersKitchen } from "./helpers/others-kitchen.ts";
import { closeAllSockets } from "./helpers/ws.ts";

/**
 * Fix round 3, point 2: the site day the owner's numbers for others are read for is the day it is WHEN THE HOLD IS PLACED, under the
 * owner's account lock, not the day it was when the reply began to be prepared. Through the production path: the real `begin` of the
 * real port, with the wall clock moved over the site's midnight while the reply is being prepared (here: as the toolbox is asked what
 * to offer, which `begin` does before admission). Nothing hands admission a timestamp.
 */
const { app, db } = useApp({ env: OTHERS_ENV, agentWorker: false });
afterEach(async () => {
  vi.useRealTimers();
  await closeAllSockets();
});

/** 23:59:50 and 00:00:10 in Shanghai, the site's zone here. */
const BEFORE = new Date("2026-03-01T15:59:50Z");
const AFTER = new Date("2026-03-01T16:00:10Z");

describe("a reply for others prepared across the site's midnight", () => {
  it("is admitted against the NEW day's room: with the new day's points already used up by another reply, it is refused (no call), though yesterday had room", async () => {
    const inner = boxOf();
    let crossed = false;
    const box = {
      ...inner,
      offer: (...args: Parameters<typeof inner.offer>) => {
        // The reply is being prepared: the clock passes midnight before its hold is placed.
        vi.setSystemTime(AFTER);
        crossed = true;
        return inner.offer(...args);
      },
    };
    const k = await othersKitchen(app, db, { box, agent: { model: PAID_MODEL } });
    await k.ask();
    // After midnight another reply for others of this owner has settled 295 of the day's 300 points: 5 are left, and a reply on
    // the paid model holds 12 at least.
    await paidReply(db, { agentId: k.agent.id as string, ownerId: k.owner.id, conversationId: k.agent.conversationId as string, lane: "others", micro: 295n * POINT, at: new Date(AFTER.getTime() + 1000) });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(BEFORE);
    k.gateway.reply("不该说出来。");
    expect(await k.worker.runOnce()).toBe(true);
    expect(crossed).toBe(true);
    expect(k.gateway.calls).toHaveLength(0);
    expect(await k.lastRun()).toMatchObject({ status: "cancelled", error: null, hold: "0" });
    expect(await k.posted()).toEqual([]);
    // Nothing of it was held or charged on either day.
    const used = (await db.query<{ n: string }>("select coalesce(sum(free_micro + balance_micro), 0)::text as n from usage_records where owner_id = $1", [k.owner.id])).rows[0]!.n;
    expect(used).toBe((295n * POINT).toString());
  });

  it("and the other way: yesterday's points used up, the new day's room is what counts: it is answered", async () => {
    const inner = boxOf();
    const box = { ...inner, offer: (...args: Parameters<typeof inner.offer>) => (vi.setSystemTime(AFTER), inner.offer(...args)) };
    const k = await othersKitchen(app, db, { box, agent: { model: PAID_MODEL } });
    await k.ask();
    await paidReply(db, { agentId: k.agent.id as string, ownerId: k.owner.id, conversationId: k.agent.conversationId as string, lane: "others", micro: 295n * POINT, at: new Date(BEFORE.getTime() - 1000) });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(BEFORE);
    k.gateway.reply("好。");
    expect(await k.worker.runOnce()).toBe(true);
    expect(await k.posted()).toEqual(["好。"]);
  });
});
