import { afterEach, describe, expect, it } from "vitest";
import { FINAL_LINE, noteBytes, OVER_CAP, REPEATED, UNUSABLE } from "../src/agents/runtime/loop.ts";
import { NO_TOOLS } from "../src/agents/runtime/prompt.ts";
import { TOOL_PREAMBLE_TOKENS } from "../src/metering/tokens.ts";
import type { ModelCall, ModelGateway, ToolCall } from "../src/models/gateway.ts";
import { isRunEnd, type Prepared } from "../src/agents/runtime/port.ts";
import { othersHold } from "../src/metering/others.ts";
import { signUp } from "./helpers/actors.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { agentsOf, BIG_MODEL, FREE_MODEL, OTHERS_ENV, PAID_MODEL, POINT, setOwnerNumbers } from "./helpers/others.ts";
import { boxOf, othersKitchen, SEARCH } from "./helpers/others-kitchen.ts";
import { closeAllSockets } from "./helpers/ws.ts";

/**
 * Lane B, B2a and B2b (plan; design §8 test 10): the bounds of a reply somebody other than the Agent's owner called for. One real
 * tool call in the whole reply, the further calls of its one tool round answered with a note (at most `OTHERS.overCapNotes`
 * of them), one tool round whatever it ran, every call at most `OTHERS.outputTokens` of output with reasoning `none`; the
 * owner's own replies (lane `own`) as before. On the real port and database, with the scripted gateway; the others' lane is
 * the member's @ call in a group.
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

// --- B2b: the hold that covers it, and the one discard -------------------------------------------------------------------------

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

const bytesOf = (texts: string[]) => texts.reduce((n, t) => n + Buffer.byteLength(t, "utf8"), 0);
const textsOf = (call: ModelCall) => call.messages.flatMap((m) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])));
/** What a request's input is held at, as `begin` and the worker hold it: its text, the tools' definitions and every step at their bytes, and what providers add around tool definitions. */
const requestBytes = (call: ModelCall) =>
  bytesOf([call.system, ...textsOf(call), ...(call.tools?.length ? [JSON.stringify(call.tools)] : []), ...(call.steps?.length ? [JSON.stringify(call.steps)] : [])]) +
  (call.tools?.length ? TOOL_PREAMBLE_TOKENS : 0);
/** The most one call of `bytes` of input can cost on the free or the paid site model (800 output tokens). */
const priced = (tier: "free" | "paid") => (bytes: number) => BigInt(bytes) * (tier === "free" ? 140n : 3000n) + 800n * (tier === "free" ? 280n : 15000n);
/** The most one more round can add to the next input: one result and the over-cap notes at their longest (the default limits; the offered tool is `search`). */
const GROWTH = 1 * (3 * 3000 + 200) + 6 * 800 + 300 + 3 * noteBytes("search");
const ROOM_CAP = 100_000 - 800 + TOOL_PREAMBLE_TOKENS;
/** The hold of an others' reply offered tools, from its first request: call 1, and the last call at what it can reach. */
const holdFor = (tier: "free" | "paid", first: ModelCall) => priced(tier)(requestBytes(first)) + priced(tier)(Math.min(requestBytes(first) + GROWTH, ROOM_CAP));

/** An others' reply on `tier`, its model `gateway`, run to its end. */
async function runOthers<G extends Pick<ModelGateway, "stream"> & { calls: ModelCall[] }>(tier: "free" | "paid", gateway: G, o: { box?: ReturnType<typeof boxOf> } = {}) {
  let conv = "";
  const probe = probed(gateway, async () => BigInt((await db.query<{ h: string }>("select hold_micro::text as h from agent_runs where conversation_id = $1 order by created_at desc limit 1", [conv])).rows[0]!.h));
  const box = o.box ?? boxOf();
  const k = await othersKitchen(app, db, {
    box,
    gateway: probe,
    onGroup: (g) => void (conv = g),
    agent: { model: tier === "free" ? FREE_MODEL : PAID_MODEL, othersBudget: null },
  });
  if (tier === "paid") await setOwnerNumbers(db, k.owner.id, { pointsMicro: 1000n * POINT });
  await k.ask();
  const run = await db.query<{ id: string }>("select id from agent_runs where conversation_id = $1 order by created_at desc limit 1", [k.g]);
  const runId = run.rows[0]!.id;
  const started = Date.now();
  expect(await k.worker.runOnce()).toBe(true);
  // The round's raise is 0 in every bounded case: the hold covers the last call, so the bug counter stays silent.
  expect(metric("others_round_raise")).toHaveLength(0);
  return { k, box, probe, runId, tookMs: Date.now() - started, hold: probe.holds[0]!, final: await k.lastRun() };
}

describe("the hold that covers an others' reply (B2b)", () => {
  it.each([
    ["one call", [q("a")]],
    ["one call and three notes", [q("a"), q("b"), q("c"), q("d")]],
    ["one call and the longest note, three times (REPEATED)", [q("a"), q("a"), q("a"), q("a")]],
  ] as const)("%s: the hold is its first call and its last at what it can reach, never raised; no request passes it, to the byte", async (_what, turn) => {
    for (const tier of ["free", "paid"] as const) {
      const scripted = scriptedGateway().callTools([...turn], { usage: U(900, 60) }).reply("川菜。", { usage: U(1300, 20) });
      const r = await runOthers(tier, scripted);
      const [first, last] = scripted.calls as [ModelCall, ModelCall];
      expect(isFinal(last)).toBe(true);
      expect(r.probe.holds).toEqual([r.hold, r.hold]);
      expect(r.hold).toBe(holdFor(tier, first));
      // The last request carries the step the hold counted: it passes neither its input nor the two calls' sum.
      expect(requestBytes(last)).toBeLessThanOrEqual(Math.min(requestBytes(first) + GROWTH, ROOM_CAP));
      expect(priced(tier)(requestBytes(first)) + priced(tier)(requestBytes(last))).toBeLessThanOrEqual(r.hold);
      expect(r.final).toMatchObject({ status: "done", hold: "0" });
      expect(await r.k.charged(r.runId)).toBeLessThanOrEqual(r.hold);
      expect(r.box.ran).toHaveLength(1);
    }
  });

  it("the design's figures, from the code's values: the longest note is 203 bytes with search_messages; 50 replies' typical cost and three holds with their searches stay within 70 points", async () => {
    expect(noteBytes("search_messages")).toBe(203);
    expect(GROWTH).toBe(14_300 + 3 * noteBytes("search"));
    const owner = await signUp(app, `fig${Math.floor(Math.random() * 1e6)}`);
    const [free] = await agentsOf(app, db, owner, 1, FREE_MODEL);
    const hold = othersHold(free!.resolved, 20_900, { growthTokens: 14_909, roomCapTokens: 1_000_000 });
    expect(hold).toBe(8_387_260n);
    // 50 answers at 0.85 each, and three replies in flight holding their tools hold and a search of 0.77: within the 70 points.
    expect(50n * 850_000n + 3n * (hold + 770_000n)).toBeLessThanOrEqual(70n * POINT);
  });

  it("the round's raise is what the next call could cost beyond the hold: asked of the hold, 0 for a real next call, counted when forced past it", async () => {
    const k = await othersKitchen(app, db, { box: boxOf() });
    await k.ask();
    const ticket = (await k.port.claimNext())!;
    const prepared = await k.port.begin(ticket);
    expect(isRunEnd(prepared)).toBe(false);
    const sent = prepared as Prepared;
    // The run's own held input (call 1's bytes, as `begin` holds them): the next call, after a round that cost something, is held at
    // no more than that plus the step — the old measure (against call 1's part alone) would have counted it.
    const held = bytesOf([sent.call.system, ...sent.call.messages.flatMap((m) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : []))), JSON.stringify(sent.tools)]) + TOOL_PREAMBLE_TOKENS;
    const none = { inputChars: 0, outputChars: 0 };
    expect(await k.port.extend(ticket, U(900, 60), none, held)).toBe("final");
    expect(metric("others_round_raise")).toHaveLength(0);
    expect(await k.port.extend(ticket, null, none, 99_000)).toBe("final");
    expect(metric("others_round_raise")).toHaveLength(1);
  });

  it("25 calls in the first turn: none runs, no result is built, the turn's text is dropped; one tool-less request finishes the reply, within the hold", async () => {
    const scripted = scriptedGateway()
      .callTools(Array.from({ length: 25 }, (_, i) => q(`q${i}`)), { text: "先查一下。", usage: U(900, 700) })
      .reply("答案。", { usage: U(1300, 20) });
    const r = await runOthers("free", scripted);
    expect(r.box.ran).toHaveLength(0);
    expect(scripted.calls).toHaveLength(2);
    const [first, second] = scripted.calls as [ModelCall, ModelCall];
    expect(second.tools ?? []).toEqual([]);
    expect(second.steps).toBeUndefined();
    expect(second.toolChoice).toBeUndefined();
    expect(second.system).not.toBe(first.system);
    expect(second.system).toContain(NO_TOOLS);
    expect(isFinal(second)).toBe(false);
    expect(await r.k.posted()).toEqual(["答案。"]);
    expect(r.probe.holds).toEqual([r.hold, r.hold]);
    expect(r.hold).toBe(holdFor("free", first));
    expect(priced("free")(requestBytes(first)) + priced("free")(requestBytes(second))).toBeLessThanOrEqual(r.hold);
    expect(r.final).toMatchObject({ status: "done", hold: "0" });
    expect(metric("others_turn_discarded")).toHaveLength(1);
    // What the discarded turn cost is metered: the usage it reported is in the settlement.
    expect((await db.query("select input_tokens::int as i, output_tokens::int as o from usage_records where run_id = $1", [r.runId])).rows).toEqual([{ i: 900 + 1300, o: 700 + 20 }]);
  });

  it("a model that calls tools on every request: one discard, one tool-less request whose calls are ignored, a posted reply, exactly two calls, inside two seconds, within the hold", async () => {
    const gateway = rogue([25]);
    const r = await runOthers("free", gateway);
    expect(gateway.calls).toHaveLength(2);
    expect(gateway.calls[1]!.tools ?? []).toEqual([]);
    expect(r.box.ran).toHaveLength(0);
    expect(await r.k.posted()).toEqual(["答案。"]);
    expect(r.tookMs).toBeLessThan(2000);
    expect(priced("free")(requestBytes(gateway.calls[0]!)) + priced("free")(requestBytes(gateway.calls[1]!))).toBeLessThanOrEqual(r.hold);
    expect(r.final).toMatchObject({ status: "done", hold: "0" });
  });

  it("the final request returning 25 calls: ignored as today, its text posted, no third request, within the hold", async () => {
    const gateway = rogue([1, 25]);
    const r = await runOthers("free", gateway);
    expect(gateway.calls).toHaveLength(2);
    expect(isFinal(gateway.calls[1]!)).toBe(true);
    expect(r.box.ran).toHaveLength(1);
    expect(await r.k.posted()).toContain("答案。");
    expect(priced("free")(requestBytes(gateway.calls[0]!)) + priced("free")(requestBytes(gateway.calls[1]!))).toBeLessThanOrEqual(r.hold);
    expect(metric("others_turn_discarded")).toHaveLength(0);
  });

  it("an id of 65 characters among two calls makes its turn one the hold does not cover: discarded, then the tool-less request; an id of 64 does not", async () => {
    const long = scriptedGateway().callTools([{ ...q("a"), id: "x".repeat(65) }, q("b")], { usage: U(900, 60) }).reply("答案。", { usage: U(1300, 20) });
    const a = await runOthers("free", long);
    expect(a.box.ran).toHaveLength(0);
    expect(long.calls).toHaveLength(2);
    expect(long.calls[1]!.tools ?? []).toEqual([]);
    expect(await a.k.posted()).toEqual(["答案。"]);
    expect(a.final).toMatchObject({ status: "done", hold: "0" });

    const edge = scriptedGateway().callTools([{ ...q("a"), id: "y".repeat(64) }, q("b")], { usage: U(900, 60) }).reply("好。", { usage: U(1300, 20) });
    const b = await runOthers("free", edge);
    expect(b.box.ran).toHaveLength(1);
    expect(resultsOf(edge.calls[1]!)).toEqual([{ hits: [] }, { note: OVER_CAP }]);
    expect(requestBytes(edge.calls[1]!)).toBeLessThanOrEqual(Math.min(requestBytes(edge.calls[0]!) + GROWTH, ROOM_CAP));
  });

  it("a tool name of 3 000 bytes, echoed in its note, passes the counted bytes: discarded", async () => {
    const gateway = scriptedGateway().callTools([q("a"), { name: "n".repeat(3000), input: {} }], { usage: U(900, 60) }).reply("答案。", { usage: U(1300, 20) });
    const r = await runOthers("free", gateway);
    expect(r.box.ran).toHaveLength(0);
    expect(gateway.calls).toHaveLength(2);
    expect(await r.k.posted()).toEqual(["答案。"]);
  });

  it("the final request refused 422 with no usage spent nothing: one tool-less request finishes the reply; refused with usage reported, no request follows and the run ends as a failed round", async () => {
    const quiet = scriptedGateway().callTools([q("a")], { usage: U(900, 60) }).fail("provider_unavailable", { status: 422 }).reply("好。", { usage: U(1300, 20) });
    const a = await runOthers("free", quiet);
    expect(quiet.calls).toHaveLength(3);
    expect(quiet.calls[2]!.tools ?? []).toEqual([]);
    expect(await a.k.posted()).toEqual(["好。"]);
    expect(priced("free")(requestBytes(quiet.calls[0]!)) + priced("free")(requestBytes(quiet.calls[2]!))).toBeLessThanOrEqual(a.hold);
    expect(a.final).toMatchObject({ status: "done", hold: "0" });

    const spent = scriptedGateway().callTools([q("a")], { usage: U(900, 60) }).fail("provider_unavailable", { status: 422, usage: { inputTokens: 2000, outputTokens: 10 } });
    const b = await runOthers("free", spent);
    expect(spent.calls).toHaveLength(2);
    expect(b.final).toMatchObject({ status: "failed", hold: "0" });
    expect(await b.k.charged(b.runId)).toBeLessThanOrEqual(b.hold);
    expect(await b.k.posted()).toEqual([]);
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
