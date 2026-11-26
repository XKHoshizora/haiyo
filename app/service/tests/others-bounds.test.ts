import { afterEach, describe, expect, it } from "vitest";
import { FINAL_LINE, OVER_CAP, REPEATED, UNUSABLE } from "../src/agents/runtime/loop.ts";
import type { ModelCall, ModelGateway, ToolCall } from "../src/models/gateway.ts";
import { isRunEnd, type Prepared } from "../src/agents/runtime/port.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { BIG_MODEL, OTHERS_ENV, PAID_MODEL } from "./helpers/others.ts";
import { boxOf, othersKitchen, SEARCH } from "./helpers/others-kitchen.ts";
import { closeAllSockets } from "./helpers/ws.ts";

/**
 * The outsider tool allowance (the limits redesign keeps it): a reply somebody other than the Agent's owner caused makes one real
 * tool call in the whole reply, the further calls of its one tool round answered with a note, one tool round whatever it ran; the
 * owner's own replies (lane `own`) as before. Everything else of such a reply is the owner's own reply's: its output limit at the
 * Agent's level for others, its wallet holds raised a call at a time, nothing it wrote dropped (the old fixed two-call hold, its
 * 800-token output and its discarded first turn are gone). On the real port and database, with the scripted gateway; the others'
 * lane is the member's @ call in a group.
 */

const lines: string[] = [];
const { app, db } = useApp({ env: OTHERS_ENV, agentWorker: false, logStream: { write: (line) => void lines.push(line) } });
/** The metric lines named `name` logged since the test began. */
const metric = (name: string) => lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((e) => e.metric === name);
afterEach(async () => {
  await closeAllSockets();
  lines.length = 0;
});

const isFinal = (call: ModelCall) => call.toolChoice === "none" && call.system.endsWith(`\n\n${FINAL_LINE}`);
const q = (query: string) => ({ name: "search", input: { query } });
const resultsOf = (call: ModelCall) => (call.steps ?? []).flatMap((s) => s.results.map((r) => r.output));
const U = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens });

describe("the outsider tool allowance", () => {
  it("every call of it is made at the Agent's level for others with the model's own output limit, as the owner's own is at the owner's level", async () => {
    const k = await othersKitchen(app, db, { box: boxOf(), agent: { model: BIG_MODEL, reasoning: "low" } });
    k.gateway.reply("好。").reply("好。");
    await k.ask();
    expect(await k.worker.runOnce()).toBe(true);
    await k.askAsOwner();
    expect(await k.worker.runOnce()).toBe(true);
    // (A new Agent's level for others is 不思考.)
    expect(k.gateway.calls[0]).toMatchObject({ maxOutputTokens: 4096, reasoning: "none" });
    expect(k.gateway.calls[1]!.reasoning).toBe("low");
    expect(k.gateway.calls[1]!.maxOutputTokens).toBeGreaterThan(4096);
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
    expect(metric("others_round_raise")).toHaveLength(0);
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

// --- What it may write, and what it holds: as the owner's own ------------------------------------------------------------------

/** A gateway that wraps `inner` and reads the run's hold each time a request is made (before it is sent): the hold at every request. */
function probed<G extends Pick<ModelGateway, "stream">>(inner: G, holdNow: () => Promise<bigint>): G & { holds: bigint[] } {
  const holds: bigint[] = [];
  const wrapped = Object.create(inner) as G & { holds: bigint[] };
  wrapped.holds = holds;
  wrapped.stream = ((call: ModelCall) => {
    const events = inner.stream(call);
    return (async function* () {
      holds.push(await holdNow());
      yield* events;
    })();
  }) as G["stream"];
  return wrapped;
}

/**
 * A provider that calls tools on every request, offered or not: its n-th request answers with `counts[n]` calls (the last count
 * repeats) and, from the second request on, the text 答案。; the first says 先查一下。 before its calls.
 */
function rogue(counts: number[]): Pick<ModelGateway, "stream"> & { calls: ModelCall[] } {
  const calls: ModelCall[] = [];
  return {
    calls,
    async *stream(call: ModelCall) {
      const n = calls.length;
      calls.push(call);
      const made: ToolCall[] = Array.from({ length: counts[Math.min(n, counts.length - 1)]! }, (_, i) => ({ id: `rogue-${n}-${i}`, name: "search", input: { query: `q${n}-${i}` } }));
      yield { type: "text" as const, delta: n === 0 ? "先查一下。" : "答案。" };
      for (const c of made) yield { type: "tool_call" as const, call: c };
      yield {
        type: "finish" as const,
        usage: null,
        truncated: false,
        toolCalls: made,
        assistant: made.length === 0 ? [] : [{ role: "assistant", content: made.map((c) => ({ type: "tool-call", toolCallId: c.id, toolName: c.name, input: c.input })) }],
      };
    },
  };
}

/** An others' reply on the paid model (no room kept for a last call there), its model `gateway`, run to its end; the hold at each request. */
async function runOthers<G extends Pick<ModelGateway, "stream"> & { calls: ModelCall[] }>(gateway: G) {
  let conv = "";
  const probe = probed(gateway, async () => BigInt((await db.query<{ h: string }>("select hold_micro::text as h from agent_runs where conversation_id = $1 order by created_at desc limit 1", [conv])).rows[0]!.h));
  const box = boxOf();
  const k = await othersKitchen(app, db, { box, gateway: probe, onGroup: (g) => void (conv = g), agent: { model: PAID_MODEL } });
  await k.ask();
  const run = await db.query<{ id: string }>("select id from agent_runs where conversation_id = $1 order by created_at desc limit 1", [k.g]);
  const started = Date.now();
  expect(await k.worker.runOnce()).toBe(true);
  return { k, box, probe, runId: run.rows[0]!.id, tookMs: Date.now() - started, final: await k.lastRun() };
}

describe("what an others' reply writes and holds", () => {
  it("its hold is raised before its last call, as the owner's own is: never fixed at admission; settled to 0", async () => {
    const scripted = scriptedGateway().callTools([q("a")], { usage: U(900, 60) }).reply("川菜。", { usage: U(1300, 20) });
    const r = await runOthers(scripted);
    expect(r.probe.holds).toHaveLength(2);
    expect(r.probe.holds[1]!).toBeGreaterThan(r.probe.holds[0]!);
    expect(r.final).toMatchObject({ status: "done", hold: "0" });
    expect(r.box.ran).toHaveLength(1);
  });

  it("25 calls in the first turn: one runs, the others are answered with the note, its words are its acknowledgement, and the next request is the last", async () => {
    const scripted = scriptedGateway()
      .callTools(Array.from({ length: 25 }, (_, i) => q(`q${i}`)), { text: "先查一下。", usage: U(900, 700) })
      .reply("答案。", { usage: U(1300, 20) });
    const r = await runOthers(scripted);
    expect(r.box.ran).toHaveLength(1);
    expect(scripted.calls).toHaveLength(2);
    expect(isFinal(scripted.calls[1]!)).toBe(true);
    expect(resultsOf(scripted.calls[1]!).filter((o) => JSON.stringify(o) === JSON.stringify({ note: OVER_CAP }))).toHaveLength(24);
    expect(await r.k.posted()).toEqual(["先查一下。", "答案。"]);
    expect(r.final).toMatchObject({ status: "done", hold: "0" });
    expect(metric("others_turn_discarded")).toHaveLength(0);
    // What both requests cost is metered.
    expect((await db.query("select input_tokens::int as i, output_tokens::int as o from usage_records where run_id = $1", [r.runId])).rows).toEqual([{ i: 900 + 1300, o: 700 + 20 }]);
  });

  it("a model that calls tools on every request: one tool round, the last request's calls ignored, a posted reply, exactly two calls, inside two seconds", async () => {
    const gateway = rogue([25]);
    const r = await runOthers(gateway);
    expect(gateway.calls).toHaveLength(2);
    expect(isFinal(gateway.calls[1]!)).toBe(true);
    expect(r.box.ran).toHaveLength(1);
    expect(await r.k.posted()).toEqual(["先查一下。", "答案。"]);
    expect(r.tookMs).toBeLessThan(2000);
    expect(r.final).toMatchObject({ status: "done", hold: "0" });
  });

  it("the last request refused 422, with usage reported or not: asked once more without tools, as the owner's own is", async () => {
    for (const usage of [undefined, { inputTokens: 2000, outputTokens: 10 }]) {
      const gateway = scriptedGateway().callTools([q("a")], { usage: U(900, 60) }).fail("provider_unavailable", { status: 422, ...(usage ? { usage } : {}) }).reply("好。", { usage: U(1300, 20) });
      const r = await runOthers(gateway);
      expect(gateway.calls).toHaveLength(3);
      expect(gateway.calls[2]!.tools ?? []).toEqual([]);
      expect(await r.k.posted()).toEqual(["好。"]);
      expect(r.final).toMatchObject({ status: "done", hold: "0" });
    }
  });

  it("its port answers a round with the last call: one tool round, whatever the money", async () => {
    const k = await othersKitchen(app, db, { box: boxOf() });
    await k.ask();
    const ticket = (await k.port.claimNext())!;
    const prepared = await k.port.begin(ticket);
    expect(isRunEnd(prepared)).toBe(false);
    expect((prepared as Prepared).toolRun).toMatchObject({ callsCap: 1 });
    const none = { inputChars: 0, outputChars: 0 };
    expect(await k.port.extend(ticket, U(900, 60), none, 1000)).toBe("final");
    expect(metric("others_round_raise")).toHaveLength(0);
  });

  it("the owner's own reply refused 422 on a later round is still asked once more without tools, as before", async () => {
    const gateway = scriptedGateway()
      .callTools([q("a")], { usage: U(900, 60) })
      .fail("provider_unavailable", { status: 422, usage: { inputTokens: 2000, outputTokens: 10 } })
      .reply("好。", { usage: U(1300, 20) });
    const k = await othersKitchen(app, db, { box: boxOf(), gateway });
    await k.askAsOwner();
    expect(await k.worker.runOnce()).toBe(true);
    expect(gateway.calls).toHaveLength(3);
    expect(await k.posted()).toEqual(["好。"]);
  });
});
