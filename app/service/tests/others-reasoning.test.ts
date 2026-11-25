import { afterEach, describe, expect, it } from "vitest";
import { readOwnedAgent } from "../src/agents/store.ts";
import { boundedForOthers, othersFloorHold, othersHold, othersOutputLimit, othersPlainCeiling, perDayEstimate } from "../src/metering/others.ts";
import { queueRun } from "../src/agents/runs.ts";
import { lockConversation } from "../src/conversations/store.ts";
import { weight } from "../src/metering/tokens.ts";
import type { ModelCall, ModelGateway } from "../src/models/gateway.ts";
import type { Resolved } from "../src/models/resolve.ts";
import { api } from "./helpers/actors.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { paidReply } from "./helpers/metering.ts";
import { OTHERS_ENV, POINT } from "./helpers/others.ts";
import { boxOf, othersKitchen } from "./helpers/others-kitchen.ts";
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
  // On Chat Completions, listing `max`: a level this protocol sends as `xhigh`.
  { ...(JSON.parse(OTHERS_ENV.SITE_MODELS) as Array<Record<string, unknown>>)[1], id: "oth_top", label: "oth_top", model: "upstream-oth_top", reasoning: ["high", "max"] },
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
  it("default none for both; a level its model offers is saved; only the owner is sent them", async () => {
    const k = await othersKitchen(app, db, { agent: { model: THINK } });
    const read = async () => (await api(app, k.owner, "GET", "/api/agents")).json.agents.find((a: { id: string }) => a.id === k.agent.id);
    expect(await read()).toMatchObject({ othersReasoning: "none", proactiveReasoning: "none" });
    expect((await api(app, k.owner, "PATCH", `/api/agents/${k.agent.id}`, { othersReasoning: "high", proactiveReasoning: "low" })).status).toBe(200);
    expect(await read()).toMatchObject({ othersReasoning: "high", proactiveReasoning: "low", reasoning: "none" });
    // (A level its model does not offer is no choice: fix round 4, F4, below.)
    expect((await api(app, k.owner, "PATCH", `/api/agents/${k.agent.id}`, { proactiveReasoning: "medium" })).status).toBe(400);
    expect((await api(app, k.owner, "PATCH", `/api/agents/${k.agent.id}`, { othersReasoning: "loud" })).status).toBe(400);
    // A member's reads name neither key.
    for (const path of ["/api/sync", `/api/conversations/${k.g}/members`, `/api/conversations/${k.g}/messages`]) {
      const text = JSON.stringify((await api(app, k.member, "GET", path)).json);
      expect([path, text.includes("othersReasoning"), text.includes("proactiveReasoning")]).toEqual([path, false, false]);
    }
    // Created with them.
    const made = await api(app, k.owner, "POST", "/api/agents", { namePart: "second", name: "second", model: THINK, othersReasoning: "low", proactiveReasoning: "high" });
    expect(made.status).toBe(201);
    expect(made.json).toMatchObject({ othersReasoning: "low", proactiveReasoning: "high" });
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
    // (Levels saved before the model listed only these two: a save now takes only what the model offers, F4 below.)
    const k = await othersKitchen(app, db, { agent: { model: THINK }, stored: { othersReasoning: "medium" }, gateway: w.gateway, onGroup: (g) => (conv = g) });
    w.inner.reply("好。", { usage: { inputTokens: 900, outputTokens: 30 } });
    await k.ask();
    expect(await k.worker.runOnce()).toBe(true);
    expect(w.inner.calls[0]).toMatchObject({ maxOutputTokens: 800 + allowance().low, reasoning: "low" });
    await db.query("update agents set others_reasoning = 'max' where principal_id = $1", [k.agent.id]);
    w.inner.reply("好。", { usage: { inputTokens: 900, outputTokens: 30 } });
    await k.ask("@chef 再说一次？");
    expect(await k.worker.runOnce()).toBe(true);
    expect(w.inner.calls[1]).toMatchObject({ maxOutputTokens: 800 + allowance().high, reasoning: "high" });
    // The same messages apart from one more: the second hold is larger by at least the difference of the two allowances.
    expect(w.holds[1]! - w.holds[0]! >= BigInt(allowance().high - allowance().low) * OUT).toBe(true);
    // A model that lists none: none, whatever is set.
    const flat = await othersKitchen(app, db, { agent: { model: { source: "site", id: "oth_paid" } }, stored: { othersReasoning: "high" } });
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

describe("fix round 3, point 4: used up is said only of what admission would refuse for EVERY reply for others", () => {
  it("room for a short proactive reply at none but not for a call at high: the Agent is tight, not used up, and a refused call tells the group nothing; with nothing left that fits, it is used up and the group is told once", async () => {
    const config = () => app.deps.config;
    const k = await othersKitchen(app, db, { agent: { model: THINK, othersReasoning: "high", proactive: true, proactiveReasoning: "none" } });
    const row = async () => (await api(app, k.owner, "GET", "/api/me/others-use")).json.agents.find((a: { agentId: string }) => a.agentId === k.agent.id);
    // Points for a plain reply at none (61.5 at the estimate's input), not for one at high (the allowance alone is 180).
    const between = othersFloorHold(config(), THINK, 16_500, 0, "none") + 10n * POINT;
    expect((await api(app, k.owner, "PUT", "/api/me/others-limits", { answers: 50, points: (Number(between) / 1e6).toFixed(2) })).status).toBe(200);
    expect(await row()).toMatchObject({ reached: false, tight: true });
    const whole = (await api(app, k.owner, "GET", "/api/me/others-use")).json;
    expect(whole.reached).toBe(false);
    // A member's call cannot be afforded at high: it ends quietly, and the group is NOT told that the Agent answers only its owner today
    // (a reply nobody asked for could still come).
    await k.ask();
    expect(await k.worker.runOnce()).toBe(true);
    expect(k.gateway.calls).toHaveLength(0);
    expect(await k.lastRun()).toMatchObject({ status: "cancelled", error: null });
    expect(await k.notices()).toBe(0);
    // Its proactive replies off: now nothing it could say for others fits. Used up, and the next refused call tells the group, once.
    expect((await api(app, k.owner, "PATCH", `/api/agents/${k.agent.id}`, { proactive: false })).status).toBe(200);
    expect(await row()).toMatchObject({ reached: true, tight: true });
    await k.ask("@chef 再问一次？");
    expect(await k.worker.runOnce()).toBe(true);
    expect(k.gateway.calls).toHaveLength(0);
    expect(await k.notices()).toBe(1);
  });

  it("the high-level tight boundary: a number that covers the largest plain reply at none is not tight at none, and is tight at high; one that covers the largest at high is not tight", async () => {
    const config = () => app.deps.config;
    const k = await othersKitchen(app, db, { agent: { model: THINK, othersReasoning: "none" } });
    const row = async () => (await api(app, k.owner, "GET", "/api/me/others-use")).json.agents.find((a: { agentId: string }) => a.agentId === k.agent.id);
    const agent = async () => (await readOwnedAgent(db, k.owner.id, k.agent.id as string))!;
    const ceiling = async () => othersPlainCeiling(db, config(), await agent(), new Date());
    const set = async (micro: bigint) => expect((await api(app, k.owner, "PUT", "/api/me/others-limits", { answers: 50, points: (Number(micro) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, "") })).status).toBe(200);
    const atNone = await ceiling();
    await set(atNone);
    expect(await row()).toMatchObject({ reached: false, tight: false });
    expect((await api(app, k.owner, "PATCH", `/api/agents/${k.agent.id}`, { othersReasoning: "high" })).status).toBe(200);
    const atHigh = await ceiling();
    // The ceiling grows by the allowance at the output price, less what the larger output takes from the context a text can fill.
    expect(atHigh > atNone).toBe(true);
    expect(await row()).toMatchObject({ reached: false, tight: true });
    await set(atHigh - 1n);
    expect((await row()).tight).toBe(true);
    await set(atHigh);
    expect(await row()).toMatchObject({ reached: false, tight: false });
  });
});

describe("fix round 3, ruling 5: no list offers a level no reply runs at", () => {
  it("a Chat Completions model that lists max is listed with xhigh as its top (GET /api/models), and a reply set to max is sent, held and recorded at xhigh", async () => {
    const k = await othersKitchen(app, db, { agent: { model: { source: "site", id: "oth_top" } }, stored: { othersReasoning: "max" } });
    const listed = ((await api(app, k.owner, "GET", "/api/models")).json.siteModels as Array<{ id: string; reasoning: string[] }>).find((m) => m.id === "oth_top")!;
    expect(listed.reasoning).toEqual(["high", "xhigh"]);
    // (Room for a paid reply held at xhigh.)
    expect((await api(app, k.owner, "PUT", "/api/me/others-limits", { answers: 50, points: "2000" })).status).toBe(200);
    k.gateway.reply("好。", { usage: { inputTokens: 900, outputTokens: 30 } });
    await k.ask();
    expect(await k.worker.runOnce()).toBe(true);
    expect(k.gateway.calls[0]).toMatchObject({ reasoning: "xhigh", maxOutputTokens: 800 + allowance().xhigh });
    const reply = ((await api(app, k.owner, "GET", `/api/conversations/${k.g}/messages`)).json.messages as Array<Record<string, unknown>>).find((m) => m.senderId === k.agent.id)!;
    expect(reply.via).toMatchObject({ reasoning: "xhigh" });
  });
});

describe("fix round 4, F3: the others' output limit is ONE budget for everything of a reply the group reads", () => {
  const texts = async (k: { g: string; agent: { id: unknown } }) =>
    (
      await db.query<{ text: string; truncated: boolean | null; ack: boolean | null }>(
        "select body ->> 'text' as text, (body ->> 'truncated')::boolean as truncated, (body ->> 'ack')::boolean as ack from messages where conversation_id = $1 and sender_id = $2 and kind = 'text' order by seq",
        [k.g, k.agent.id],
      )
    ).rows;
  const limit = () => app.deps.config.others.outputTokens;

  it.each([["high"], ["none"]] as const)("at %s: a long text written before a tool call (its acknowledgement) and the answer after it together stay within the limit; each is cut and marked as a reply over its length is", async (level) => {
    const k = await othersKitchen(app, db, { box: boxOf(), agent: { model: THINK, othersReasoning: level } });
    // (Room for a paid reply with tools held at a level.)
    expect((await api(app, k.owner, "PUT", "/api/me/others-limits", { answers: 50, points: "5000" })).status).toBe(200);
    const long = "好".repeat(3000); // a weight of 3 000, far over 800
    k.gateway.callTools([{ name: "search", input: { query: "a" } }], { text: long, usage: { inputTokens: 900, outputTokens: 3100 } }).reply(long, { usage: { inputTokens: 1300, outputTokens: 3000 } });
    await k.ask();
    expect(await k.worker.runOnce()).toBe(true);
    const posted = await texts(k);
    expect(posted.map((p) => [p.ack === true, p.truncated])).toEqual([[true, true], [false, true]]);
    const [ack, answer] = posted.map((p) => weight(p.text));
    expect(ack! + answer!).toBeLessThanOrEqual(limit());
    // The acknowledgement takes at most half of it, so the answer always has room.
    expect(ack!).toBeLessThanOrEqual(limit() / 2);
    expect(answer!).toBeGreaterThanOrEqual(limit() / 2 - 2);
  });

  it("a short acknowledgement is posted whole, and the answer has the rest; the owner's own reply with tools is not held to any of it", async () => {
    const k = await othersKitchen(app, db, { box: boxOf(), agent: { model: THINK, othersReasoning: "none", reasoning: "none" } });
    const long = "好".repeat(3000);
    k.gateway.callTools([{ name: "search", input: { query: "a" } }], { text: "我查一下。", usage: { inputTokens: 900, outputTokens: 30 } }).reply(long, { usage: { inputTokens: 1300, outputTokens: 3000 } });
    await k.ask();
    expect(await k.worker.runOnce()).toBe(true);
    const posted = await texts(k);
    expect(posted.map((p) => [p.ack === true, p.truncated])).toEqual([[true, null], [false, true]]);
    expect(posted[0]!.text).toBe("我查一下。");
    expect(weight(posted[0]!.text) + weight(posted[1]!.text)).toBeLessThanOrEqual(limit());
    expect(weight(posted[1]!.text)).toBeGreaterThan(limit() - weight("我查一下。") - 2);
    k.gateway.callTools([{ name: "search", input: { query: "b" } }], { text: long, usage: { inputTokens: 900, outputTokens: 3100 } }).reply(long, { usage: { inputTokens: 1300, outputTokens: 3000 } });
    await k.askAsOwner();
    expect(await k.worker.runOnce()).toBe(true);
    const own = (await texts(k)).slice(2);
    expect(own.map((p) => [p.ack === true, p.truncated, weight(p.text)])).toEqual([[true, null, 3000], [false, null, 3000]]);
  });
});

describe("fix round 4, F4: a save accepts exactly the levels the picker offers", () => {
  // `oth_top` speaks Chat Completions and lists high and max: the picker offers 不思考, 高 and 很高 (xhigh, what max is sent as).
  const TOP = { source: "site", id: "oth_top" } as const;
  const create = (owner: Parameters<typeof api>[1], fields: Record<string, unknown>) => api(app, owner, "POST", "/api/agents", { namePart: `lv${Math.floor(Math.random() * 1e9)}`, name: "档位", model: TOP, ...fields });

  it("creating: 很高 is saved for the Agent's own level and both others' levels; a level the picker does not offer (中, and 最高 itself) is 400 for each of the three", async () => {
    const k = await othersKitchen(app, db, {});
    const made = await create(k.owner, { reasoning: "xhigh", othersReasoning: "xhigh", proactiveReasoning: "xhigh" });
    expect(made.status).toBe(201);
    expect(made.json).toMatchObject({ reasoning: "xhigh", othersReasoning: "xhigh", proactiveReasoning: "xhigh" });
    for (const key of ["reasoning", "othersReasoning", "proactiveReasoning"]) {
      for (const level of ["medium", "max", "low"]) expect([key, level, (await create(k.owner, { [key]: level })).status]).toEqual([key, level, 400]);
      for (const level of ["none", "high", "xhigh"]) expect([key, level, (await create(k.owner, { [key]: level })).status]).toEqual([key, level, 201]);
    }
  });

  it("editing: the same for each of the three; and with the model changed in the same save the levels are held to the new model", async () => {
    const k = await othersKitchen(app, db, { agent: { model: TOP } });
    const patch = (body: Record<string, unknown>) => api(app, k.owner, "PATCH", `/api/agents/${k.agent.id}`, body);
    for (const key of ["reasoning", "othersReasoning", "proactiveReasoning"]) {
      expect([key, (await patch({ [key]: "xhigh" })).status]).toEqual([key, 200]);
      for (const level of ["medium", "max"]) expect([key, level, (await patch({ [key]: level })).status]).toEqual([key, level, 400]);
    }
    expect((await patch({})).json).toMatchObject({ reasoning: "xhigh", othersReasoning: "xhigh", proactiveReasoning: "xhigh" });
    // `oth_think` lists low and high: xhigh is none of its levels.
    expect((await patch({ model: THINK, reasoning: "high", othersReasoning: "xhigh" })).status).toBe(400);
    expect((await patch({ model: THINK, reasoning: "high", othersReasoning: "low" })).status).toBe(200);
  });

  it("最高 saved before (the model's own list has it) stays saveable as it is, is shown the level it runs at, and runs as 很高", async () => {
    const k = await othersKitchen(app, db, { agent: { model: TOP } });
    await db.query("update agents set reasoning = 'max', others_reasoning = 'max', proactive_reasoning = 'max' where principal_id = $1", [k.agent.id]);
    const patch = (body: Record<string, unknown>) => api(app, k.owner, "PATCH", `/api/agents/${k.agent.id}`, body);
    // Sent back unchanged with another field, with and without the model named again: saved.
    expect((await patch({ name: "新名字", reasoning: "max", othersReasoning: "max", proactiveReasoning: "max" })).status).toBe(200);
    expect((await patch({ model: TOP, reasoning: "max" })).status).toBe(200);
    expect((await readOwnedAgent(db, k.owner.id, k.agent.id as string))!).toMatchObject({ reasoning: "max", othersReasoning: "max" });
    expect((await api(app, k.owner, "PUT", "/api/me/others-limits", { answers: 50, points: "2000" })).status).toBe(200);
    k.gateway.reply("好。", { usage: { inputTokens: 900, outputTokens: 30 } });
    await k.ask();
    expect(await k.worker.runOnce()).toBe(true);
    expect(k.gateway.calls[0]).toMatchObject({ reasoning: "xhigh" });
    // Once changed away it is not a choice any more.
    expect((await patch({ othersReasoning: "high" })).status).toBe(200);
    expect((await patch({ othersReasoning: "max" })).status).toBe(400);
  });
});

describe("fix round 4, F5: a call refused as it is made tells the group 「今天只回复它的主人，明天恢复」 only when that is so", () => {
  const queued = async (k: { g: string }) => (await db.query("select 1 from agent_runs where conversation_id = $1 and status in ('queued', 'running')", [k.g])).rowCount;

  it("its own number for called replies is spent but a reply nobody asked for still fits: the call is refused and the group is told nothing; with those replies off it is told, once", async () => {
    const k = await othersKitchen(app, db, { agent: { model: THINK, proactive: true } });
    expect((await api(app, k.owner, "PATCH", `/api/agents/${k.agent.id}`, { othersLimit: { answers: null, points: "30" } })).status).toBe(200);
    await paidReply(db, { agentId: k.agent.id as string, ownerId: k.owner.id, conversationId: k.agent.conversationId as string, lane: "others", micro: 30n * POINT });
    const row = async () => (await api(app, k.owner, "GET", "/api/me/others-use")).json.agents.find((a: { agentId: string }) => a.agentId === k.agent.id);
    expect(await row()).toMatchObject({ reached: false, tight: true });
    await k.ask();
    expect(await queued(k)).toBe(0);
    expect(await k.notices()).toBe(0);
    expect((await api(app, k.owner, "PATCH", `/api/agents/${k.agent.id}`, { proactive: false })).status).toBe(200);
    expect(await row()).toMatchObject({ reached: true });
    await k.ask("@chef 再问一次？");
    await k.ask("@chef 还有一次？");
    expect(await queued(k)).toBe(0);
    expect(await k.notices()).toBe(1);
  });

  it("only another reply's hold is in the way (nothing is used up): the call is refused and the group is told nothing; once that reply has ended a call is answered", async () => {
    const k = await othersKitchen(app, db, { agent: { model: THINK } });
    // Another reply for others of this owner, under way, holds all of the day's points.
    const held = await db.query<{ id: string }>(
      `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, source, model, charge_to, lane, hold_micro, money_rule, started_at, admitted_at)
       values ('reply', $1, $2, $3, 'running', 0, 'site', 'oth_think', 'balance', 'others', $4, 1, now(), now()) returning id`,
      [k.agent.conversationId, k.agent.id, k.owner.id, (300n * POINT).toString()],
    );
    const row = async () => (await api(app, k.owner, "GET", "/api/me/others-use")).json.agents.find((a: { agentId: string }) => a.agentId === k.agent.id);
    expect((await row()).reached).toBe(false);
    await k.ask();
    expect(await queued(k)).toBe(0);
    expect(await k.notices()).toBe(0);
    await db.query("delete from agent_runs where id = $1", [held.rows[0]!.id]);
    k.gateway.reply("好。", { usage: { inputTokens: 900, outputTokens: 30 } });
    await k.ask("@chef 再问一次？");
    expect(await k.worker.runOnce()).toBe(true);
    expect(await k.posted()).toEqual(["好。"]);
    expect(await k.notices()).toBe(0);
  });
});
