import { afterEach, describe, expect, it } from "vitest";
import { stopRun } from "../src/agents/runs.ts";
import { createAgentWorker } from "../src/agents/runtime/worker.ts";
import { mayThink, type ModelCall, type ModelGateway } from "../src/models/gateway.ts";
import { api } from "./helpers/actors.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { OTHERS_ENV } from "./helpers/others.ts";
import { othersKitchen } from "./helpers/others-kitchen.ts";
import { closeAllSockets } from "./helpers/ws.ts";

/**
 * The seam of two rules (closing step of fix round 3): "no clock cuts a call that may think" (models/gateway.ts `mayThink`, the far
 * ceiling `MODEL_CALL_CEILING_MS`) and "a reply for others is bounded, held and settled" (metering/others.ts). Whether a reply for
 * others may think is judged on the call it is actually MADE with — the owner's level for such replies as it runs on the model
 * (`boundedForOthers`), never the Agent's own level — and however such a call ends (its answer, the ceiling, a dead connection, a
 * stop), the hold it was admitted with is released: settled to what it used, nothing left held. On the real port and database,
 * a scripted gateway, a worker run by hand whose own time (300 ms) is far below what each call takes.
 */

const SITE = JSON.parse(OTHERS_ENV.SITE_MODELS) as Array<Record<string, unknown>>;
/** A paid model that thinks at `low` and `high`; `oth_free` lists no level and takes no switch: it cannot be thinking. */
const THINK = { source: "site", id: "oth_think" } as const;
const PLAIN = { source: "site", id: "oth_free" } as const;
const SITE_MODELS = [...SITE, { ...SITE[1], id: "oth_think", label: "oth_think", model: "upstream-oth_think", reasoning: ["low", "high"] }];
const { app, db } = useApp({ env: { ...OTHERS_ENV, SITE_MODELS: JSON.stringify(SITE_MODELS) }, agentWorker: false });
afterEach(closeAllSockets);

type Kitchen = Awaited<ReturnType<typeof othersKitchen>>;

/** A scripted gateway that notes the newest run and its hold at each request: what was held while the call was being made. */
function watching(conv: () => string) {
  const inner = scriptedGateway();
  const held: Array<{ id: string; hold: bigint }> = [];
  const gateway = Object.create(inner) as ModelGateway & typeof inner;
  gateway.stream = ((call: ModelCall) => {
    const events = inner.stream(call);
    return (async function* () {
      const row = (await db.query<{ id: string; h: string }>("select id, hold_micro::text as h from agent_runs where conversation_id = $1 order by created_at desc, id desc limit 1", [conv()])).rows[0]!;
      held.push({ id: row.id, hold: BigInt(row.h) });
      yield* events;
    })();
  }) as ModelGateway["stream"];
  return { inner, gateway, held };
}

/** The Agent's reasoning for its owner is `own`; for others `others`. A worker whose own time is 300 ms and whose far ceiling is `ceilingMs`. */
async function scene(model: typeof THINK | typeof PLAIN, own: string, others: string, ceilingMs: number) {
  let g = "";
  const w = watching(() => g);
  const k: Kitchen = await othersKitchen(app, db, { agent: { model }, stored: { reasoning: own, othersReasoning: others }, gateway: w.gateway as never, onGroup: (id) => (g = id) });
  const worker = createAgentWorker({ port: k.port, models: w.gateway, runTimeoutMs: 300, callCeilingMs: ceilingMs, maxRunsInFlight: 1, background: false, log: app.log, tools: app.deps.config.tools });
  /** Nothing of the owner's is held any more, by a run in any state. */
  const heldNow = async () => BigInt((await db.query<{ n: string }>("select coalesce(sum(hold_micro), 0)::text as n from agent_runs where owner_id = $1", [k.owner.id])).rows[0]!.n);
  const waiting = async () => (await db.query("select 1 from agent_runs where conversation_id = $1 and status in ('queued', 'running')", [k.g])).rowCount;
  return { k, worker, ...w, heldNow, waiting };
}

describe("a reply for others that may think: no clock but the ceiling, and its hold is always released", () => {
  it("at an effective level that is not none (the Agent's own level none): a call far slower than the reply's own time is answered in full, and the hold is settled to what it used", async () => {
    const s = await scene(THINK, "none", "high", 10_000);
    s.inner.reply("想好了，去吃面。", { delayMsPerChunk: 700, usage: { inputTokens: 900, outputTokens: 40 } });
    await s.k.ask();
    expect(await s.worker.runOnce()).toBe(true);
    const call = s.inner.calls[0]!;
    // Judged on the call as it is made: the others' level as it runs, not the Agent's own.
    expect([call.reasoning, mayThink(call)]).toEqual(["high", true]);
    expect(await s.k.posted()).toEqual(["想好了，去吃面。"]);
    const run = await s.k.lastRun();
    expect(run).toMatchObject({ status: "done", error: null, lane: "others", hold: "0" });
    const charged = await s.k.charged(run.id);
    expect(s.held[0]!.hold > 0n).toBe(true);
    expect(charged > 0n && charged < s.held[0]!.hold).toBe(true);
    expect(await s.heldNow()).toBe(0n);
  });

  it("at none on a model that may think whatever it is asked (`thinks`): still not cut by the reply's own time", async () => {
    const s = await scene(THINK, "high", "none", 10_000);
    s.inner.reply("去吃面。", { delayMsPerChunk: 700 });
    await s.k.ask();
    expect(await s.worker.runOnce()).toBe(true);
    const call = s.inner.calls[0]!;
    expect([call.reasoning, call.thinks, mayThink(call)]).toEqual(["none", true, true]);
    expect(call.maxOutputTokens).toBe(app.deps.config.others.outputTokens);
    expect(await s.k.posted()).toEqual(["去吃面。"]);
    expect(await s.k.lastRun()).toMatchObject({ status: "done", lane: "others", hold: "0" });
  });

  it("a model that cannot be thinking is cut by the reply's own time as ever, whatever the Agent's own level", async () => {
    const s = await scene(PLAIN, "none", "high", 10_000);
    s.inner.reply("去吃面。", { delayMsPerChunk: 700 });
    await s.k.ask();
    expect(await s.worker.runOnce()).toBe(true);
    const call = s.inner.calls[0]!;
    expect([call.reasoning, mayThink(call)]).toEqual(["none", false]);
    expect(await s.k.posted()).toEqual([]);
    expect(await s.k.lastRun()).toMatchObject({ status: "failed", error: "took_too_long", hold: "0" });
    expect(await s.heldNow()).toBe(0n);
  });

  it("ended by the ceiling: took_too_long, nothing posted, not tried again by itself — and the hold is released, not charged in full, not left held", async () => {
    const s = await scene(THINK, "none", "high", 900);
    s.inner.hang();
    const began = Date.now();
    await s.k.ask();
    expect(await s.worker.runOnce()).toBe(true);
    // Not at the reply's own 300 ms: at the ceiling.
    expect(Date.now() - began).toBeGreaterThanOrEqual(850);
    const run = await s.k.lastRun();
    expect(run).toMatchObject({ id: s.held[0]!.id, status: "failed", error: "took_too_long", lane: "others", hold: "0" });
    expect(await s.k.posted()).toEqual([]);
    expect(s.held[0]!.hold > 0n).toBe(true);
    expect((await s.k.charged(run.id)) < s.held[0]!.hold).toBe(true);
    expect(await s.heldNow()).toBe(0n);
    expect(await s.waiting()).toBe(0);
    // What it is counted as against the owner's numbers for others is what was charged, not what was held.
    const used = (await api(app, s.k.owner, "GET", "/api/me/others-use")).json.used as { points: string };
    expect(BigInt(Math.round(Number(used.points) * 1e6))).toBe(await s.k.charged(run.id));
  });

  it("ended by its connection dying midway: failed, and the hold is released the same", async () => {
    const s = await scene(THINK, "none", "high", 10_000);
    s.inner.cut("", "想到一半");
    await s.k.ask();
    expect(await s.worker.runOnce()).toBe(true);
    const first = (await db.query<{ status: string; error: string | null; hold: string }>("select status, error, hold_micro::text as hold from agent_runs where id = $1", [s.held[0]!.id])).rows[0]!;
    expect(first).toEqual({ status: "failed", error: "provider_unavailable", hold: "0" });
    expect(s.held[0]!.hold > 0n).toBe(true);
    expect((await s.k.charged(s.held[0]!.id)) < s.held[0]!.hold).toBe(true);
    expect(await s.heldNow()).toBe(0n);
  });

  it("stopped by its owner while it thinks: what it said is kept, and the hold is released the same", async () => {
    const s = await scene(THINK, "none", "high", 10_000);
    const hold = s.inner.hangAfter("说到一半");
    await s.k.ask();
    const running = s.worker.runOnce();
    await hold.reached;
    // Well past the reply's own 300 ms, and still running.
    await new Promise((wake) => setTimeout(wake, 600));
    expect((await s.k.lastRun()).status).toBe("running");
    // As the stop route does it for the worker that is working on the run (here this test's own, not the app's): the stop is
    // written, then that worker is told.
    expect((await app.deps.db.tx((t) => stopRun(t, s.k.owner.id, s.k.g, s.held[0]!.id, app.deps.config))).running).toBe(true);
    s.k.port.stopAsked(s.held[0]!.id);
    expect(await running).toBe(true);
    const run = await s.k.lastRun();
    expect(run).toMatchObject({ id: s.held[0]!.id, status: "stopped", hold: "0" });
    expect(await s.k.posted()).toEqual(["说到一半"]);
    expect((await s.k.charged(run.id)) < s.held[0]!.hold).toBe(true);
    expect(await s.heldNow()).toBe(0n);
  });
});
