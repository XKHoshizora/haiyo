import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readOwnedAgent } from "../src/agents/store.ts";
import { REASONING_LEVELS, type ReasoningLevel } from "../src/config.ts";
import { REASONING_PARAMS, type ModelEvent } from "../src/models/gateway.ts";
import { callLevel, outputLimit, resolveModel, sendableLevels, sentLevel } from "../src/models/resolve.ts";
import { api, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { CANNED_TEXT, protocolStub, STUB_MODEL, type ProtocolStub } from "./helpers/models.ts";
import { providerBody } from "./helpers/providers.ts";

/** resolveModel: an Agent's model choice as a callable model, or null when there is none to call. */

const { app, db } = useApp({ env: SITE_ENV, allowInsecureLocal: true });
const config = () => app.deps.config;

let stub: ProtocolStub;
beforeAll(async () => {
  stub = await protocolStub();
});
afterAll(async () => {
  await stub.close();
});

async function agentWith(owner: Actor, over: Record<string, unknown>) {
  const created = await mustCreateAgent(app, owner, over);
  const row = await readOwnedAgent(db, owner.id, created.id);
  if (!row) throw new Error("agent not found");
  return row;
}

describe("resolveModel", () => {
  it("is null for an Agent without a model", async () => {
    const owner = await signUp(app, "nadia");
    expect(await resolveModel(db, config(), await agentWith(owner, {}))).toBeNull();
  });

  it("a site model: its upstream and limits, its price and tier, the key read from its variable when called", async () => {
    const owner = await signUp(app, "sami");
    const agent = await agentWith(owner, { model: { source: "site", id: "thinker" }, reasoning: "medium" });
    expect(process.env.UPSTREAM_TEST_KEY).toBe(SITE_ENV.UPSTREAM_TEST_KEY); // useApp's env is the process's while the file runs
    expect(await resolveModel(db, config(), agent)).toEqual({
      source: "site",
      name: "thinker",
      // At medium the output limit is the model's 8192 and medium's thinking allowance (6000 by default).
      call: {
        protocol: "anthropic",
        baseUrl: "https://api.example.test/v1",
        apiKey: SITE_ENV.UPSTREAM_TEST_KEY,
        model: "think-1",
        maxOutputTokens: 8192 + 6000,
        thinkingSwitch: false,
        thinks: true,
        upstreamId: "site:thinker",
      },
      contextTokens: 200000,
      vision: true,
      pdf: true,
      reasoningAllowed: ["none", "low", "medium"],
      reasoning: "medium",
      price: { inputMicroPerToken: 3, outputMicroPerToken: 6 },
      tier: "paid",
      tools: true,
    });

    const fast = await resolveModel(db, config(), await agentWith(owner, { model: { source: "site", id: "fast" } }));
    expect(fast).toMatchObject({ source: "site", tier: "free", vision: false, pdf: false, reasoningAllowed: ["none"], call: { protocol: "openai_chat", model: "fast-1" } });

    const saved = process.env.UPSTREAM_TEST_KEY;
    try {
      process.env.UPSTREAM_TEST_KEY = "rotated-upstream-key";
      expect((await resolveModel(db, config(), agent))?.call.apiKey).toBe("rotated-upstream-key");
      delete process.env.UPSTREAM_TEST_KEY;
      expect(await resolveModel(db, config(), agent)).toBeNull();
    } finally {
      process.env.UPSTREAM_TEST_KEY = saved;
    }
  });

  it("is null for a site model that is no longer configured", async () => {
    const owner = await signUp(app, "tara");
    const agent = await agentWith(owner, { model: { source: "site", id: "thinker" } });
    const without = { ...config(), siteModels: config().siteModels.filter((m) => m.id !== "thinker") };
    expect(await resolveModel(db, without, agent)).toBeNull();
  });

  it("a provider model: the owner's provider with its key opened, the model's flags, the default output limit, no price", async () => {
    const owner = await signUp(app, "ugo");
    const models = [
      { name: "deep", vision: true, pdf: false, reasoning: true, contextTokens: 50000 },
      { name: "plain", vision: false, pdf: true, reasoning: false, contextTokens: 8000 },
    ];
    const provider = (await api(app, owner, "POST", "/api/providers", providerBody({ protocol: "gemini", apiKey: "gm-key-0123456789", models }))).json;
    const deep = await agentWith(owner, { model: { source: "provider", providerId: provider.id, model: "deep" }, reasoning: "xhigh" });
    expect(await resolveModel(db, config(), deep)).toEqual({
      source: "provider",
      name: "deep",
      // At xhigh: the default output limit and xhigh's allowance (24 000), which half of what the context leaves beside
      // the limit (50 000 − 2 048) / 2 = 23 976 caps.
      call: {
        protocol: "gemini",
        baseUrl: "https://api.example.com/v1",
        apiKey: "gm-key-0123456789",
        model: "deep",
        maxOutputTokens: config().providerDefaultMaxOutputTokens + 23_976,
        thinkingSwitch: true,
        thinks: true,
        upstreamId: `provider:${provider.id}@https://api.example.com/v1`,
      },
      contextTokens: 50000,
      vision: true,
      pdf: false,
      // (Gemini has no `max` level: what it is sent for it is `xhigh`, so the levels it can run at end there. Fix round 3, ruling 5.)
      reasoningAllowed: ["none", "low", "medium", "high", "xhigh"],
      reasoning: "xhigh",
      // The provider's row: what the model's learned token ratio is kept under (metering/tokens.ts `ratioKey`).
      providerId: provider.id,
      // Its entry says nothing of tools: not known yet, so its replies may be offered them.
      tools: true,
      toolsUnknown: true,
    });
    const plain = await agentWith(owner, { model: { source: "provider", providerId: provider.id, model: "plain" } });
    // Not marked as one that reasons: none only, the default output limit, no thinking switch.
    expect(await resolveModel(db, config(), plain)).toMatchObject({
      contextTokens: 8000,
      vision: false,
      pdf: true,
      reasoningAllowed: ["none"],
      reasoning: "none",
      call: { maxOutputTokens: config().providerDefaultMaxOutputTokens, thinkingSwitch: false, thinks: false },
    });

    // Its levels narrowed after the Agent chose one (xhigh): the run is not failed, and it is made at the nearest level
    // below the saved one that the model still lists — never at one it does not list; `none` when none is below.
    const narrowed = async (reasoningLevels: string[] | undefined) => {
      const { reasoningLevels: _, ...rest } = { ...models[0], reasoningLevels };
      expect((await api(app, owner, "PATCH", `/api/providers/${provider.id}`, { models: [reasoningLevels ? { ...rest, reasoningLevels } : rest, models[1]] })).status).toBe(200);
      return resolveModel(db, config(), deep);
    };
    const room = Math.floor((50000 - config().providerDefaultMaxOutputTokens) / 2);
    const at = (level: "low" | "medium" | "high") => config().providerDefaultMaxOutputTokens + Math.min(config().reasoningAllowanceTokens[level], room);
    expect(await narrowed(["low"])).toMatchObject({ name: "deep", reasoningAllowed: ["none", "low"], reasoning: "low", call: { maxOutputTokens: at("low"), thinkingSwitch: true } });
    // (Listed `max` on this protocol is run, and so listed, as `xhigh`: the saved `xhigh` runs at it.)
    expect(await narrowed(["low", "medium", "max"])).toMatchObject({ reasoningAllowed: ["none", "low", "medium", "xhigh"], reasoning: "xhigh" });
    expect(await narrowed(["low", "medium"])).toMatchObject({ reasoningAllowed: ["none", "low", "medium"], reasoning: "medium", call: { maxOutputTokens: at("medium") } });
    expect(await narrowed(["high", "xhigh"])).toMatchObject({ reasoningAllowed: ["none", "high", "xhigh"], reasoning: "xhigh" });
    expect(await narrowed(["high"])).toMatchObject({ reasoningAllowed: ["none", "high"], reasoning: "high" });
    expect(await narrowed(["max"])).toMatchObject({ reasoningAllowed: ["none", "xhigh"], reasoning: "xhigh" });
    // Fix round 3, point 3b: this provider speaks Gemini, which has no `max` level (the call is sent `xhigh`: gateway.ts
    // REASONING_PARAMS). The level resolved IS the level sent: what the hold is sized for and what the owner's line says.
    // (`max` is no choice on it: a save takes what the picker offers. An Agent saved with it before is read here.)
    expect((await api(app, owner, "PATCH", `/api/agents/${deep.id}`, { reasoning: "max" })).status).toBe(400);
    const top = { ...deep, reasoning: "max" as const };
    const sent = await (async () => {
      expect((await api(app, owner, "PATCH", `/api/providers/${provider.id}`, { models })).status).toBe(200);
      return resolveModel(db, config(), top);
    })();
    expect(sent).toMatchObject({ reasoning: "xhigh", call: { maxOutputTokens: config().providerDefaultMaxOutputTokens + Math.min(config().reasoningAllowanceTokens.xhigh, room) } });
    for (const protocol of ["openai_chat", "openai_responses", "anthropic", "gemini"] as const) {
      for (const level of REASONING_LEVELS) expect([protocol, level, REASONING_PARAMS[protocol][sentLevel(protocol, level)]]).toEqual([protocol, level, REASONING_PARAMS[protocol][level]]);
    }
    expect(sendableLevels("gemini", ["low", "max"])).toEqual(["none", "low", "xhigh"]);
    expect(sendableLevels("openai_chat", REASONING_LEVELS)).toEqual(["none", "low", "medium", "high", "xhigh"]);
    expect(sendableLevels("anthropic", REASONING_LEVELS)).toEqual([...REASONING_LEVELS]);
    expect([sentLevel("openai_chat", "max"), sentLevel("gemini", "max"), sentLevel("anthropic", "max"), sentLevel("openai_responses", "max")]).toEqual(["xhigh", "xhigh", "max", "max"]);
    await api(app, owner, "PATCH", `/api/agents/${deep.id}`, { reasoning: "xhigh" });
    // The Agent's own level is not rewritten by any of it.
    expect((await readOwnedAgent(db, owner.id, deep.id))?.reasoning).toBe("xhigh");
    // Every level again (no list): the saved level is the one sent.
    expect(await narrowed(undefined)).toMatchObject({ reasoningAllowed: ["none", "low", "medium", "high", "xhigh"], reasoning: "xhigh" });

    // Its address changed: another upstream, so what the old one refused (src/models/gateway.ts `Refusals`) is not
    // carried over to it.
    expect((await api(app, owner, "PATCH", `/api/providers/${provider.id}`, { baseUrl: "https://api.example.com/v2beta" })).status).toBe(200);
    expect((await resolveModel(db, config(), deep))?.call).toMatchObject({
      baseUrl: "https://api.example.com/v2beta",
      upstreamId: `provider:${provider.id}@https://api.example.com/v2beta`,
    });

    // The model taken off the provider's list: nothing to call.
    await api(app, owner, "PATCH", `/api/providers/${provider.id}`, { models: [models[1]] });
    expect(await resolveModel(db, config(), deep)).toBeNull();
    expect(await resolveModel(db, config(), plain)).not.toBeNull();
  });

  it("what it resolves is what the app's own gateway (Deps.models) calls, through the guard, the opened key on the wire", async () => {
    const owner = await signUp(app, "xena");
    const created = await api(app, owner, "POST", "/api/providers", providerBody({ protocol: "anthropic", baseUrl: stub.baseUrl, models: [{ name: STUB_MODEL }] }));
    const agent = await agentWith(owner, { model: { source: "provider", providerId: created.json.id, model: STUB_MODEL } });
    const resolved = await resolveModel(db, config(), agent);
    expect(resolved?.call.apiKey).toBe(providerBody().apiKey);
    stub.reset();
    const events: ModelEvent[] = [];
    const call = {
      ...resolved!.call,
      system: "",
      messages: [{ role: "user" as const, parts: [{ type: "text" as const, text: "Hi" }] }],
      reasoning: "none" as const,
      signal: new AbortController().signal,
    };
    for await (const e of app.deps.models.stream(call)) events.push(e);
    expect(events.flatMap((e) => (e.type === "text" ? [e.delta] : [])).join("")).toBe(CANNED_TEXT);
    expect(stub.requests.map((r) => [r.path, r.headers["x-api-key"]])).toEqual([["/v1/messages", providerBody().apiKey]]);
  });

  it("the output limit is the reply's limit at none, and the level's thinking allowance on top at any other level", async () => {
    const owner = await signUp(app, "yuki");
    const at = (reasoning?: ReasoningLevel) => resolveModel(db, config(), { model: { source: "site", id: "thinker" }, ownerId: owner.id, ...(reasoning ? { reasoning } : {}) });
    expect(await at()).toMatchObject({ reasoning: "none", call: { maxOutputTokens: 8192 } }); // a persona draft names no level
    expect(await at("none")).toMatchObject({ reasoning: "none", call: { maxOutputTokens: 8192 } });
    expect(await at("low")).toMatchObject({ reasoning: "low", call: { maxOutputTokens: 8192 + 2000 } });
    // A level the model does not list is called (and sized) as the nearest one below it that it does: medium here.
    expect(await at("high")).toMatchObject({ reasoning: "medium", call: { maxOutputTokens: 8192 + 6000 } });
    // REASONING_ALLOWANCE_TOKENS is what is added.
    const custom = { ...config(), reasoningAllowanceTokens: { ...config().reasoningAllowanceTokens, low: 0, medium: 100_000 } };
    const thinker = (reasoning: ReasoningLevel) => resolveModel(db, custom, { model: { source: "site", id: "thinker" }, ownerId: owner.id, reasoning });
    expect((await thinker("low"))?.call.maxOutputTokens).toBe(8192);
    expect((await thinker("medium"))?.call.maxOutputTokens).toBe(8192 + 95_904); // (200 000 − 8 192) / 2
    // A site model sends the thinking switch only when its configuration says so.
    const switched = { ...config(), siteModels: config().siteModels.map((m) => (m.id === "fast" ? { ...m, thinkingSwitch: true } : m)) };
    expect((await resolveModel(db, switched, { model: { source: "site", id: "fast" }, ownerId: owner.id }))?.call.thinkingSwitch).toBe(true);
    expect((await resolveModel(db, config(), { model: { source: "site", id: "fast" }, ownerId: owner.id }))?.call.thinkingSwitch).toBe(false);
    // Whether the model may think (`ModelCall.thinks`: how long its calls may be silent) is the model's, whatever level is
    // asked: a site model that lists a level or takes the switch; one that lists none and takes none does not.
    expect((await thinker("none"))?.call.thinks).toBe(true);
    expect((await resolveModel(db, switched, { model: { source: "site", id: "fast" }, ownerId: owner.id }))?.call.thinks).toBe(true);
    expect((await resolveModel(db, config(), { model: { source: "site", id: "fast" }, ownerId: owner.id }))?.call.thinks).toBe(false);
    // `none` is no thinking level: a site model configured with it alone is not one that may think.
    const noneOnly = { ...config(), siteModels: config().siteModels.map((m) => (m.id === "fast" ? { ...m, reasoning: ["none" as const] } : m)) };
    expect((await resolveModel(db, noneOnly, { model: { source: "site", id: "fast" }, ownerId: owner.id }))?.call.thinks).toBe(false);
  });

  it("whether its replies may be offered tools: a site model's configuration; a provider model's entry unless it says false", async () => {
    const owner = await signUp(app, "zoe");
    const off = { ...config(), siteModels: config().siteModels.map((m) => (m.id === "fast" ? { ...m, tools: false } : m)) };
    expect((await resolveModel(db, off, { model: { source: "site", id: "fast" }, ownerId: owner.id }))?.tools).toBe(false);
    expect((await resolveModel(db, off, { model: { source: "site", id: "thinker" }, ownerId: owner.id }))?.tools).toBe(true);
    const models = [{ name: "unsaid" }, { name: "able", tools: true }, { name: "unable", tools: false }];
    const provider = (await api(app, owner, "POST", "/api/providers", providerBody({ models }))).json;
    const tools = async (model: string) => (await resolveModel(db, config(), { model: { source: "provider", providerId: provider.id, model }, ownerId: owner.id }))?.tools;
    expect([await tools("unsaid"), await tools("able"), await tools("unable")]).toEqual([true, true, false]);
    // Whether its entry says nothing yet (what a reply whose tool call ran may store): never from the catalogue, which is not stored.
    const unknown = async (model: string) => (await resolveModel(db, config(), { model: { source: "provider", providerId: provider.id, model }, ownerId: owner.id }))?.toolsUnknown;
    expect([await unknown("unsaid"), await unknown("able"), await unknown("unable")]).toEqual([true, false, false]);
    expect((await resolveModel(db, off, { model: { source: "site", id: "thinker" }, ownerId: owner.id }))).not.toHaveProperty("toolsUnknown");
  });

  it("outputLimit: the allowance is at most half of what the context leaves beside the reply's limit, never below the reply's limit", () => {
    const allowance = { low: 2000, medium: 6000, high: 12000, xhigh: 24000, max: 48000 };
    expect(outputLimit(2048, 16_000, "none", allowance)).toBe(2048);
    expect(outputLimit(2048, 16_000, "low", allowance)).toBe(4048);
    expect(outputLimit(2048, 16_000, "high", allowance)).toBe(2048 + 6976);
    expect(outputLimit(2048, 1_000_000, "max", allowance)).toBe(2048 + 48_000);
    for (const level of REASONING_LEVELS) {
      for (const [reply, context] of [[2048, 2049], [2048, 2050], [1, 2], [4096, 100_000], [2048, 1000]] as const) {
        const limit = outputLimit(reply, context, level, allowance);
        expect(limit).toBeGreaterThanOrEqual(reply);
        if (context > reply) {
          expect(limit).toBeLessThanOrEqual(context - 1);
          expect(context - limit).toBeGreaterThanOrEqual(Math.floor((context - reply) / 2));
        } else {
          expect(limit).toBe(reply); // no room: no allowance
        }
      }
    }
  });

  it("callLevel: the wanted level when the model lists it, else the nearest listed level below it; none when none is below", () => {
    expect(callLevel(["none", "low"], "low")).toBe("low");
    expect(callLevel(["none", "low"], "max")).toBe("low");
    expect(callLevel(["none", "low", "high"], "medium")).toBe("low");
    expect(callLevel(["none", "low", "high"], "xhigh")).toBe("high");
    expect(callLevel(["none", "low", "high"], "max")).toBe("high");
    expect(callLevel(["none", "high", "max"], "low")).toBe("none");
    expect(callLevel(["none", "max"], "xhigh")).toBe("none");
    expect(callLevel(["none"], "max")).toBe("none");
    // (However the list is ordered, and whether or not it says `none`.)
    expect(callLevel(["max", "low"], "high")).toBe("low");
    expect(callLevel(["high"], "low")).toBe("none");
    for (const wanted of REASONING_LEVELS) expect(callLevel(REASONING_LEVELS, wanted)).toBe(wanted);
    for (const wanted of REASONING_LEVELS) expect(callLevel([], wanted)).toBe("none");
  });

  it("a site model whose configured levels were narrowed below an Agent's saved one: the nearest listed level below it, as for a provider model", async () => {
    const owner = await signUp(app, "sita");
    const agent = await agentWith(owner, { model: { source: "site", id: "thinker" }, reasoning: "medium" });
    const withLevels = (levels: Array<"low" | "medium" | "high" | "xhigh" | "max">) => ({ ...config(), siteModels: config().siteModels.map((m) => (m.id === "thinker" ? { ...m, reasoning: levels } : m)) });
    expect(await resolveModel(db, withLevels(["low", "high"]), agent)).toMatchObject({ reasoningAllowed: ["none", "low", "high"], reasoning: "low", call: { maxOutputTokens: 8192 + config().reasoningAllowanceTokens.low } });
    expect(await resolveModel(db, withLevels(["high"]), agent)).toMatchObject({ reasoningAllowed: ["none", "high"], reasoning: "none", call: { maxOutputTokens: 8192 } });
    expect(await resolveModel(db, withLevels([]), agent)).toMatchObject({ reasoningAllowed: ["none"], reasoning: "none" });
  });

  it("is null when the provider is not the Agent owner's (or gone)", async () => {
    const owner = await signUp(app, "vera");
    const provider = (await api(app, owner, "POST", "/api/providers", providerBody({ models: [{ name: "m" }] }))).json;
    const agent = await agentWith(owner, { model: { source: "provider", providerId: provider.id, model: "m" } });
    const other = await signUp(app, "wim");
    expect(await resolveModel(db, config(), { ...agent, ownerId: other.id })).toBeNull();
    expect(await resolveModel(db, config(), { ...agent, model: { ...agent.model!, providerId: "6a0d4c2e-1b3f-4a5e-9c7d-8e9f0a1b2c3d" } as typeof agent.model })).toBeNull();
  });
});
