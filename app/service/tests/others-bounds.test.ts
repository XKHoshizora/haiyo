import { afterEach, describe, expect, it } from "vitest";
import { FINAL_LINE, OVER_CAP, REPEATED, UNUSABLE } from "../src/agents/runtime/loop.ts";
import type { ModelCall } from "../src/models/gateway.ts";
import { useApp } from "./helpers/harness.ts";
import { BIG_MODEL, OTHERS_ENV } from "./helpers/others.ts";
import { boxOf, othersKitchen, SEARCH } from "./helpers/others-kitchen.ts";
import { closeAllSockets } from "./helpers/ws.ts";

/**
 * Lane B, B2a and B2b (plan; design §8 test 10): the bounds of a reply somebody other than the Agent's owner called for. One real
 * tool call in the whole reply, the further calls of its one tool round answered with a note (at most `OTHERS.overCapNotes`
 * of them), one tool round whatever it ran, every call at most `OTHERS.outputTokens` of output with reasoning `none`; the
 * owner's own replies (lane `own`) as before. On the real port and database, with the scripted gateway; the others' lane is
 * the member's @ call in a group.
 */

const { app, db } = useApp({ env: OTHERS_ENV, agentWorker: false });
afterEach(async () => {
  await closeAllSockets();
});

const isFinal = (call: ModelCall) => call.toolChoice === "none" && call.system.endsWith(`\n\n${FINAL_LINE}`);
const q = (query: string) => ({ name: "search", input: { query } });
const resultsOf = (call: ModelCall) => (call.steps ?? []).flatMap((s) => s.results.map((r) => r.output));
const U = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens });

describe("the bounds of an others' reply (B2a)", () => {
  it("every call of it is made at 800 output tokens and reasoning none, where the owner's own is made as the model allows", async () => {
    const k = await othersKitchen(app, db, { box: boxOf(), agent: { model: BIG_MODEL, reasoning: "low" } });
    k.gateway.reply("好。").reply("好。");
    await k.ask();
    expect(await k.worker.runOnce()).toBe(true);
    await k.askAsOwner();
    expect(await k.worker.runOnce()).toBe(true);
    expect(k.gateway.calls[0]).toMatchObject({ maxOutputTokens: 800, reasoning: "none" });
    expect(k.gateway.calls[1]!.reasoning).toBe("low");
    expect(k.gateway.calls[1]!.maxOutputTokens).toBeGreaterThan(800);
  });

  it("one call: it runs, and the next request is the last", async () => {
    const box = boxOf();
    const k = await othersKitchen(app, db, { box });
    k.gateway.callTools([q("a")], { usage: U(900, 40) }).reply("川菜。", { usage: U(1100, 20) });
    await k.ask();
    expect(await k.worker.runOnce()).toBe(true);
    expect(box.ran).toHaveLength(1);
    expect(k.gateway.calls).toHaveLength(2);
    expect(isFinal(k.gateway.calls[1]!)).toBe(true);
    expect(await k.posted()).toEqual(["川菜。"]);
    expect(await k.lastRun()).toMatchObject({ status: "done", lane: "others", hold: "0" });
  });

  it("one call and three more: the first runs, the other three are answered with the over-cap note, and the next request is the last", async () => {
    const box = boxOf();
    const k = await othersKitchen(app, db, { box });
    k.gateway.callTools([q("a"), q("b"), q("c"), q("d")], { usage: U(900, 60) }).reply("川菜。", { usage: U(1300, 20) });
    await k.ask();
    expect(await k.worker.runOnce()).toBe(true);
    expect(box.ran).toHaveLength(1);
    expect(box.ran[0]!.input).toEqual({ query: "a" });
    expect(resultsOf(k.gateway.calls[1]!)).toEqual([{ hits: [] }, { note: OVER_CAP }, { note: OVER_CAP }, { note: OVER_CAP }]);
    expect(isFinal(k.gateway.calls[1]!)).toBe(true);
    expect(await k.lastRun()).toMatchObject({ status: "done", hold: "0" });
  });

  it("a repeat is answered REPEATED, an unknown tool UNUSABLE, a further call OVER_CAP: the notes are counted among the three", async () => {
    const box = boxOf();
    const k = await othersKitchen(app, db, { box });
    k.gateway.callTools([q("a"), q("a"), { name: "nope", input: {} }, q("b")], { usage: U(900, 60) }).reply("好。", { usage: U(1300, 20) });
    await k.ask();
    expect(await k.worker.runOnce()).toBe(true);
    expect(box.ran).toHaveLength(1);
    expect(resultsOf(k.gateway.calls[1]!)).toEqual([{ hits: [] }, { note: REPEATED }, { error: UNUSABLE }, { note: OVER_CAP }]);
  });

  it("a garbled first call is UNUSABLE, the first usable call after it runs, and the tool phase still ends", async () => {
    const box = boxOf();
    const k = await othersKitchen(app, db, { box });
    k.gateway.callTools([{ name: "nope", input: {} }, q("a")], { usage: U(900, 60) }).reply("好。", { usage: U(1300, 20) });
    await k.ask();
    expect(await k.worker.runOnce()).toBe(true);
    expect(resultsOf(k.gateway.calls[1]!)).toEqual([{ error: UNUSABLE }, { hits: [] }]);
    expect(box.ran).toHaveLength(1);
    expect(isFinal(k.gateway.calls[1]!)).toBe(true);
  });

  it("a garbled call alone is the whole tool round: the second request is the last, and calls in it are not run", async () => {
    const box = boxOf();
    const k = await othersKitchen(app, db, { box });
    k.gateway.callTools([{ name: "nope", input: {} }], { usage: U(900, 60) }).callTools([q("a")], { text: "答案。", usage: U(1300, 20) });
    await k.ask();
    expect(await k.worker.runOnce()).toBe(true);
    expect(k.gateway.calls).toHaveLength(2);
    expect(isFinal(k.gateway.calls[1]!)).toBe(true);
    expect(box.ran).toHaveLength(0);
    expect(await k.posted()).toEqual(["答案。"]);
    expect(await k.lastRun()).toMatchObject({ status: "done", hold: "0" });
  });

  it("the owner's own reply is as before: three calls run, and the next request is not yet the last", async () => {
    const box = boxOf([SEARCH]);
    const k = await othersKitchen(app, db, { box });
    k.gateway.callTools([q("a"), q("b"), q("c")], { usage: U(900, 60) }).reply("好。", { usage: U(1300, 20) });
    await k.askAsOwner();
    expect(await k.worker.runOnce()).toBe(true);
    expect(box.ran).toHaveLength(3);
    expect(isFinal(k.gateway.calls[1]!)).toBe(false);
    expect(await k.lastRun()).toMatchObject({ status: "done", lane: "own" });
  });
});
