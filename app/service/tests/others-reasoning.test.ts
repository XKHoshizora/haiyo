import { afterEach, describe, expect, it } from "vitest";
import { boundedForOthers, othersFloorHold, othersHold, othersOutputLimit, perDayEstimate } from "../src/metering/others.ts";
import { queueRun } from "../src/agents/runs.ts";
import { lockConversation } from "../src/conversations/store.ts";
import { weight } from "../src/metering/tokens.ts";
import type { ModelCall, ModelGateway } from "../src/models/gateway.ts";
import type { Resolved } from "../src/models/resolve.ts";
import { api } from "./helpers/actors.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { OTHERS_ENV, POINT } from "./helpers/others.ts";
import { othersKitchen } from "./helpers/others-kitchen.ts";
import { closeAllSockets } from "./helpers/ws.ts";

/**
 * Owner decision 2026-11-26 (fix round 2): the thinking level of a reply made for somebody other than the Agent's owner
 * (`othersReasoning`) and of a reply nobody asked for (`proactiveReasoning`) are the owner's settings, `none` by default. A run is made
 * at the setting's EFFECTIVE level on the model, and the money follows the level actually run: the hold, the floor and the ceiling the
 * owner's page computes `tight` and `reached` from, and the per-day estimate. On the real port and database, scripted gateway.
 */

/** The design's models and a paid one that thinks at `low` and `high` only (so `medium` falls to `low`, `max` to `high`). */
const THINK = { source: "site", id: "oth_think" } as const;
const BIG = { source: "site", id: "oth_big" } as const;
const SITE_MODELS = [
  ...(JSON.parse(OTHERS_ENV.SITE_MODELS) as Array<Record<string, unknown>>),
  { ...(JSON.parse(OTHERS_ENV.SITE_MODELS) as Array<Record<string, unknown>>)[1], id: "oth_think", label: "oth_think", model: "upstream-oth_think", reasoning: ["low", "high"] },
];
/** The judgement model configured (never called here): without it no reply nobody asked for is made at all. */
const JUDGE = { model: "jev-1", channels: [{ url: "https://judge-a.example.test/v1/systemone", apiKeyEnv: "OTHERS_UPSTREAM_KEY" }], timeoutMs: 4000, dailyLimit: 20_000 };
const { app, db } = useApp({ env: { ...OTHERS_ENV, SITE_MODELS: JSON.stringify(SITE_MODELS) }, agentWorker: false, config: { judge: JUDGE } });
afterEach(closeAllSockets);

const allowance = () => app.deps.config.reasoningAllowanceTokens;
const OUT = 15_000n; // the paid model's output price, micro-points a token
const holdNow = async (conv: string) => BigInt((await db.query<{ h: string }>("select hold_micro::text as h from agent_runs where conversation_id = $1 order by created_at desc, id desc limit 1", [conv])).rows[0]!.h);

/** A scripted gateway that notes the newest run's hold at each request: what was held BEFORE the call was made. */
function watching(conv: () => string) {
  const inner = scriptedGateway();
  const holds: bigint[] = [];
  const gateway = Object.create(inner) as ModelGateway & typeof inner;
  gateway.stream = ((call: ModelCall) => {
    const events = inner.stream(call);
    return (async function* () {
      holds.push(await holdNow(conv()));
      yield* events;
    })();
  }) as ModelGateway["stream"];
  return { inner, gateway, holds };
}

describe("the settings", () => {
  it("default none for both; any product level is saved; only the owner is sent them", async () => {
    const k = await othersKitchen(app, db, { agent: { model: THINK } });
    const read = async () => (await api(app, k.owner, "GET", "/api/agents")).json.agents.find((a: { id: string }) => a.id === k.agent.id);
    expect(await read()).toMatchObject({ othersReasoning: "none", proactiveReasoning: "none" });
    expect((await api(app, k.owner, "PATCH", `/api/agents/${k.agent.id}`, { othersReasoning: "high", proactiveReasoning: "medium" })).status).toBe(200);
    expect(await read()).toMatchObject({ othersReasoning: "high", proactiveReasoning: "medium", reasoning: "none" });
    expect((await api(app, k.owner, "PATCH", `/api/agents/${k.agent.id}`, { othersReasoning: "loud" })).status).toBe(400);
    // A member's reads name neither key.
    for (const path of ["/api/sync", `/api/conversations/${k.g}/members`, `/api/conversations/${k.g}/messages`]) {
      const text = JSON.stringify((await api(app, k.member, "GET", path)).json);
      expect([path, text.includes("othersReasoning"), text.includes("proactiveReasoning")]).toEqual([path, false, false]);
    }
    // Created with them.
    const made = await api(app, k.owner, "POST", "/api/agents", { namePart: "second", name: "second", model: THINK, othersReasoning: "low", proactiveReasoning: "max" });
    expect(made.status).toBe(201);
    expect(made.json).toMatchObject({ othersReasoning: "low", proactiveReasoning: "max" });
  });
});

describe("a member's call runs at the owner's setting, and the hold is priced at the level run", () => {
  it("othersReasoning high on a paid model that lists it: sent at high with the level's allowance, held for it before the call, and the owner's via says high; the member is sent no via and no thinking", async () => {
    let conv = "";
    const w = watching(() => conv);
    const plain = await othersKitchen(app, db, { agent: { model: THINK }, gateway: w.gateway, onGroup: (g) => (conv = g) });
    w.inner.reply("好。", { usage: { inputTokens: 900, outputTokens: 30 } });
    await plain.ask();
    expect(await plain.worker.runOnce()).toBe(true);
    expect(w.inner.calls[0]).toMatchObject({ maxOutputTokens: 800, reasoning: "none" });
    const heldNone = w.holds[0]!;

    const w2 = watching(() => conv);
    const k = await othersKitchen(app, db, { agent: { model: THINK, othersReasoning: "high", reasoning: "low" }, gateway: w2.gateway, onGroup: (g) => (conv = g) });
    w2.inner.reply("想好了。", { reasoning: "先想一想", usage: { inputTokens: 900, outputTokens: 400 } });
    await k.ask();
    expect(await k.worker.runOnce()).toBe(true);
    expect(w2.inner.calls[0]).toMatchObject({ maxOutputTokens: 800 + allowance().high, reasoning: "high" });
    // Held before the call for the level run: the same reply at none, plus the level's allowance at the output price.
    // (The two groups differ by a few bytes of names: within a point of the allowance at the output price; the exact figure is pinned on the floor below.)
    const more = w2.holds[0]! - heldNone - BigInt(allowance().high) * OUT;
    expect(more < POINT && more > -POINT).toBe(true);
    expect(await k.lastRun()).toMatchObject({ status: "done", lane: "others", hold: "0" });
    const recorded = (await db.query<{ reasoning: string }>("select reasoning from agent_runs where conversation_id = $1 order by created_at desc limit 1", [k.g])).rows[0]!;
    expect(recorded.reasoning).toBe("high");
    // The owner reads the level under the reply; the member reads neither it nor the thinking.
    const of = async (who: typeof k.owner) => ((await api(app, who, "GET", `/api/conversations/${k.g}/messages`)).json.messages as Array<Record<string, unknown>>).find((m) => m.senderId === k.agent.id)!;
    expect((await of(k.owner)).via).toMatchObject({ reasoning: "high" });
    const members = await of(k.member);
    expect(members).not.toHaveProperty("via");
    expect(members).not.toHaveProperty("reasoning");
    // The owner's own call in the same group is made at the Agent's own level, not the others'.
    w2.inner.reply("在。", { usage: { inputTokens: 900, outputTokens: 30 } });
    await k.askAsOwner();
    expect(await k.worker.runOnce()).toBe(true);
    expect(w2.inner.calls.at(-1)).toMatchObject({ reasoning: "low" });
  });

  it("a level the model does not list falls to the nearest lower one, for the run and for the price alike", async () => {
    let conv = "";
    const w = watching(() => conv);
    // The model lists low and high: medium runs at low, max at high.
    const k = await othersKitchen(app, db, { agent: { model: THINK, othersReasoning: "medium" }, gateway: w.gateway, onGroup: (g) => (conv = g) });
    w.inner.reply("好。", { usage: { inputTokens: 900, outputTokens: 30 } });
    await k.ask();
    expect(await k.worker.runOnce()).toBe(true);
    expect(w.inner.calls[0]).toMatchObject({ maxOutputTokens: 800 + allowance().low, reasoning: "low" });
    expect((await api(app, k.owner, "PATCH", `/api/agents/${k.agent.id}`, { othersReasoning: "max" })).status).toBe(200);
    w.inner.reply("好。", { usage: { inputTokens: 900, outputTokens: 30 } });
    await k.ask("@chef 再说一次？");
    expect(await k.worker.runOnce()).toBe(true);
    expect(w.inner.calls[1]).toMatchObject({ maxOutputTokens: 800 + allowance().high, reasoning: "high" });
    // The same messages apart from one more: the second hold is larger by at least the difference of the two allowances.
    expect(w.holds[1]! - w.holds[0]! >= BigInt(allowance().high - allowance().low) * OUT).toBe(true);
    // A model that lists none: none, whatever is set.
    const flat = await othersKitchen(app, db, { agent: { model: { source: "site", id: "oth_paid" }, othersReasoning: "high" } });
    flat.gateway.reply("好。");
    await flat.ask();
    expect(await flat.worker.runOnce()).toBe(true);
    expect(flat.gateway.calls[0]).toMatchObject({ maxOutputTokens: 800, reasoning: "none" });
  });

  it("a reply nobody asked for runs at proactiveReasoning, not at othersReasoning", async () => {
    const k = await othersKitchen(app, db, { agent: { model: BIG, proactive: true, othersReasoning: "low", proactiveReasoning: "medium" } });
    await k.say(k.member, "今晚吃什么");
    const seq = Number((await db.query<{ seq: string }>("select max(seq)::text as seq from messages where conversation_id = $1", [k.g])).rows[0]!.seq);
    await db.tx(async (t) => {
      await lockConversation(t, k.g);
      await queueRun(t, { id: k.agent.id as string, ownerId: k.owner.id }, k.g, seq, "human", { id: null, lane: "proactive" }, null);
    });
    k.gateway.reply("吃面吧。");
    expect(await k.worker.runOnce()).toBe(true);
    expect(await k.lastRun()).toMatchObject({ status: "done", lane: "proactive", error: null });
    expect(k.gateway.calls[0]).toMatchObject({ maxOutputTokens: 800 + allowance().medium, reasoning: "medium" });
  });
});

describe("fix round 3, point 3a: the answer of a reply for others is held to the others' output limit, also at a level", () => {
  it("at high the call's one limit is 800 plus the allowance, so the model CAN write more than 800 tokens of answer: what is posted is cut to the others' limit and marked cut; the owner's own reply is not", async () => {
    const k = await othersKitchen(app, db, { agent: { model: THINK, othersReasoning: "high", reasoning: "high" } });
    const long = "好".repeat(3000); // 9 000 bytes: a weight of 3 000, far over 800
    k.gateway.reply(long, { reasoning: "想了一下", usage: { inputTokens: 900, outputTokens: 3200 } });
    await k.ask();
    expect(await k.worker.runOnce()).toBe(true);
    const posted = (await db.query<{ text: string; truncated: boolean | null }>("select body ->> 'text' as text, (body ->> 'truncated')::boolean as truncated from messages where conversation_id = $1 and sender_id = $2 and kind = 'text' order by seq", [k.g, k.agent.id])).rows;
    expect(posted).toHaveLength(1);
    expect(weight(posted[0]!.text)).toBeLessThanOrEqual(app.deps.config.others.outputTokens);
    expect(weight(posted[0]!.text)).toBeGreaterThan(app.deps.config.others.outputTokens - 2);
    expect(posted[0]!.truncated).toBe(true);
    // The owner's own call in the same group is its model's to bound, not this limit.
    k.gateway.reply(long, { usage: { inputTokens: 900, outputTokens: 3200 } });
    await k.askAsOwner();
    expect(await k.worker.runOnce()).toBe(true);
    const own = (await db.query<{ text: string }>("select body ->> 'text' as text from messages where conversation_id = $1 and sender_id = $2 and kind = 'text' order by seq desc limit 1", [k.g, k.agent.id])).rows[0]!;
    expect(Array.from(own.text).length).toBe(3000);
  });
});

describe("the owner's page follows the level", () => {
  const config = () => app.deps.config;
  it("othersOutputLimit and boundedForOthers: one definition; the floor hold, and so tight and reached, are priced at the effective level", () => {
    expect(othersOutputLimit(config(), 4096, 100_000, "none")).toBe(800);
    expect(othersOutputLimit(config(), 4096, 100_000, "high")).toBe(800 + allowance().high);
    const resolved = { source: "site", reasoning: "low", reasoningAllowed: ["none", "low", "high"], contextTokens: 100_000, replyLimit: 800, call: { maxOutputTokens: 2800 } } as unknown as Resolved;
    expect(boundedForOthers(resolved, config(), "max")).toMatchObject({ reasoning: "high", call: { maxOutputTokens: 800 + allowance().high } });
    expect(boundedForOthers(resolved, config(), "none")).toMatchObject({ reasoning: "none", call: { maxOutputTokens: 800 } });
    const at = (wanted: "none" | "medium" | "high") => othersFloorHold(config(), THINK, 16_500, 0, wanted);
    expect(at("high") - at("none")).toBe(BigInt(allowance().high) * OUT);
    expect(at("medium") - at("none")).toBe(BigInt(allowance().low) * OUT);
    // The floor is the hold admission computes: `othersHold` on the bounded model.
    const priced = { source: "site", price: { inputMicroPerToken: 3000, outputMicroPerToken: 15000 }, call: { maxOutputTokens: 800 + allowance().high } } as unknown as Resolved;
    expect(at("high")).toBe(othersHold(priced, 16_500, null));
  });

  it("the per-day estimate drops with the level, on the page as in the function; reached shows sooner", async () => {
    const numbers = { owner: { answers: 50, pointsMicro: 300n * POINT }, agent: { answers: null, pointsMicro: null } };
    const none = perDayEstimate(config(), THINK, numbers, "none");
    const high = perDayEstimate(config(), THINK, numbers, "high");
    expect(none).toBeGreaterThan(high);
    expect(high).toBeGreaterThan(0);
    expect(perDayEstimate(config(), THINK, numbers, "medium")).toBe(perDayEstimate(config(), THINK, numbers, "low"));
    const k = await othersKitchen(app, db, { agent: { model: THINK } });
    const row = async () => (await api(app, k.owner, "GET", "/api/me/others-use")).json.agents.find((a: { agentId: string }) => a.agentId === k.agent.id);
    expect((await row()).perDay).toBe(none);
    expect((await api(app, k.owner, "PATCH", `/api/agents/${k.agent.id}`, { othersReasoning: "high" })).status).toBe(200);
    expect((await row()).perDay).toBe(high);
    // With points for a plain reply at none but not at high: not reached at none, reached at high (every call would be refused).
    const between = othersFloorHold(config(), THINK, 16_500, 0, "none") + 10n * POINT;
    expect((await api(app, k.owner, "PUT", "/api/me/others-limits", { answers: 50, points: (Number(between) / 1e6).toFixed(2) })).status).toBe(200);
    expect(await row()).toMatchObject({ reached: true, perDay: 0 });
    expect((await api(app, k.owner, "PATCH", `/api/agents/${k.agent.id}`, { othersReasoning: "none" })).status).toBe(200);
    expect((await row()).reached).toBe(false);
  });
});
