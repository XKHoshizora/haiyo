import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { api, signUp } from "./helpers/actors.ts";
import { SITE_ENV } from "./helpers/agents.ts";
import { NO_ANSWER_FLOOR, useApp } from "./helpers/harness.ts";

/**
 * `GET /api/models` (README "Calling a model"): what a client's model picker reads — the site models in configuration
 * order, with what an owner chooses by, and the defaults a provider model gets. Never where a site model is called, by
 * what name, with which key, or at what price. Rate limits at scale 1: 120 a minute per principal.
 */

const { app, db } = useApp({ env: { ...SITE_ENV, RATE_LIMIT_SCALE: "1" } });

describe("GET /api/models", () => {
  it("lists the site models in configuration order, and the provider defaults — never upstream, model name, key or price", async () => {
    const owner = await signUp(app, "picker");
    const res = await app.inject({ method: "GET", url: "/api/models", headers: { cookie: owner.cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      siteModels: [
        { id: "fast", label: "Fast", tier: "free", vision: false, pdf: false, reasoning: [], contextTokens: 100000, tools: true },
        { id: "thinker", label: "Thinker", tier: "paid", vision: true, pdf: true, reasoning: ["low", "medium"], contextTokens: 200000, tools: true },
      ],
      providerDefaults: { contextTokens: 16000, maxOutputTokens: 2048 },
      proactiveAvailable: false,
      memoryCatchUp: { days: 30, lines: 200 },
    });
    const serialised = `${JSON.stringify(res.headers)}${res.body}`;
    for (const secret of ["api.example.test", "fast-1", "think-1", "UPSTREAM_TEST_KEY", SITE_ENV.UPSTREAM_TEST_KEY, "MicroPerToken", "maxOutputTokens\":4096", "baseUrl", "apiKeyEnv", "protocol"]) {
      expect([secret, serialised.includes(secret)]).toEqual([secret, false]);
    }
  });

  it("with no site model configured, siteModels is empty", async () => {
    const bare = await buildApp({ config: { ...app.deps.config, siteModels: [] }, db }, { agentWorker: false, answerFloor: NO_ANSWER_FLOOR, staleRunSweep: false });
    try {
      const owner = await signUp(bare, "nomodels");
      expect(await api(bare, owner, "GET", "/api/models")).toEqual({ status: 200, json: { siteModels: [], providerDefaults: { contextTokens: 16000, maxOutputTokens: 2048 }, proactiveAvailable: false, memoryCatchUp: { days: 30, lines: 200 } } });
    } finally {
      await bare.close();
    }
  });

  it("says how far back turning memory on again may look (MEMORY.catchUpDays, MEMORY.catchUpLines), as configured", async () => {
    const memory = { ...app.deps.config.memory, catchUpDays: 7, catchUpLines: 150 };
    const tuned = await buildApp({ config: { ...app.deps.config, memory }, db }, { agentWorker: false, answerFloor: NO_ANSWER_FLOOR, staleRunSweep: false });
    try {
      const owner = await signUp(tuned, "catchup_bounds");
      expect((await api(tuned, owner, "GET", "/api/models")).json).toMatchObject({ memoryCatchUp: { days: 7, lines: 150 } });
    } finally {
      await tuned.close();
    }
  });

  it("needs a session, takes no query, and allows 120 reads a minute per principal (a budget of its own)", async () => {
    expect(await api(app, null, "GET", "/api/models")).toEqual({ status: 401, json: { error: "unauthenticated" } });
    const [a, b] = [await signUp(app, "models_rl_a"), await signUp(app, "models_rl_b")];
    expect((await api(app, a, "GET", "/api/models?x=1")).status).toBe(200); // unknown query parameters are dropped
    for (let i = 2; i <= 120; i++) expect([i, (await api(app, a, "GET", "/api/models")).status]).toEqual([i, 200]);
    expect(await api(app, a, "GET", "/api/models")).toEqual({ status: 429, json: { error: "rate_limited" } });
    expect((await api(app, b, "GET", "/api/models")).status).toBe(200);
    // Not one budget with the other reads.
    expect((await api(app, a, "GET", "/api/agents")).status).toBe(200);
    expect((await api(app, a, "GET", "/api/usage")).status).toBe(200);
  });
});
