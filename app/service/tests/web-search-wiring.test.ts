import { describe, expect, it } from "vitest";
import { api, signUp } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";

/**
 * The web search as the app builds it from its configuration alone (lane websearch; fix round 1; lane websearch2):
 * `TOOLS.web.enabled` and a key in the variable `apiKeyEnv` names make the engine (`Deps.webEngine`: Exa's adapter by
 * default) and the site offers web search, about its price in points (`webSearchPoints`: 13 for Exa's default). Nothing
 * here calls it: no test ever calls a real engine.
 */

const { app } = useApp({ env: { ...SITE_ENV, TOOLS: JSON.stringify({ web: { enabled: true } }), WEB_SEARCH_API_KEY: "not-a-real-key" }, agentWorker: false });

describe("the switch on and its key there", () => {
  it("builds the engine and offers web search: GET /api/models says so, the Agent's view has its switch", async () => {
    expect(app.deps.webEngine?.name).toBe("exa_search");
    const owner = await signUp(app, "wirea");
    expect((await api(app, owner, "GET", "/api/models")).json).toMatchObject({ webSearchAvailable: true, webSearchPoints: "13" });
    expect((await mustCreateAgent(app, owner, { model: { source: "site", id: "fast" } })).webSearch).toBe(true);
  });
});
