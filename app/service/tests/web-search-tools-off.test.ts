import { describe, expect, it } from "vitest";
import type { WebEngine } from "../src/agents/tools/web/engine.ts";
import { api, signUp } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";

/**
 * With `TOOLS.enabled` false no reply is offered any tool, the web search included (lane websearch; review M3): the site
 * then offers no web search, whatever `TOOLS.web` says and even with an engine — no `webSearchAvailable`, no switch on an
 * Agent's view. A fake engine: never a real call.
 */

const engine: WebEngine = { name: "fake", searchWeb: async () => ({ error: "no_results" }) };
const { app } = useApp({ env: { ...SITE_ENV, TOOLS: JSON.stringify({ enabled: false, web: { enabled: true } }) }, webEngine: engine, agentWorker: false });

describe("tools off", () => {
  it("no web search is offered: nothing on GET /api/models, nothing on the Agent's view", async () => {
    const owner = await signUp(app, "toffa");
    expect((await api(app, owner, "GET", "/api/models")).json).not.toHaveProperty("webSearchAvailable");
    const agent = await mustCreateAgent(app, owner, { model: { source: "site", id: "fast" } });
    expect(agent).not.toHaveProperty("webSearch");
    expect((await api(app, owner, "GET", `/api/agents/${agent.id}`)).json).not.toHaveProperty("webSearch");
  });
});
