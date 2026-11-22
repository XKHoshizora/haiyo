import { describe, expect, it } from "vitest";
import type { WebEngine } from "../src/agents/tools/web/engine.ts";
import { api, signUp } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";

/**
 * The web search on the owner's routes while the site offers it (lane websearch): `GET /api/models` says so
 * (`webSearchAvailable`), the Agent's view carries its switch (`webSearch`, on by default), and creating and editing an
 * Agent set it. With the site's switch off (every other test file) none of these keys exists anywhere
 * (models-route.test.ts pins the exact answer; web-search.test.ts the Agent's view). A fake engine: never a real call.
 */

const engine: WebEngine = { name: "fake", searchWeb: async () => ({ error: "no_results" }) };
const { app } = useApp({ env: { ...SITE_ENV, TOOLS: JSON.stringify({ web: { enabled: true, pointsMicroPerSearch: 770_350 } }) }, webEngine: engine, agentWorker: false });

describe("while the site offers web search", () => {
  it("GET /api/models says so, with about what one search costs (one decimal at most: 0.77035 points is 0.8)", async () => {
    const owner = await signUp(app, "routa");
    expect((await api(app, owner, "GET", "/api/models")).json).toMatchObject({ webSearchAvailable: true, webSearchPoints: "0.8" });
  });

  it("an Agent's view carries its switch, on by default; create and edit set it", async () => {
    const owner = await signUp(app, "routb");
    const on = await mustCreateAgent(app, owner, { model: { source: "site", id: "fast" } });
    expect(on.webSearch).toBe(true);
    const off = await mustCreateAgent(app, owner, { model: { source: "site", id: "fast" }, webSearch: false });
    expect(off.webSearch).toBe(false);
    expect((await api(app, owner, "PATCH", `/api/agents/${on.id}`, { webSearch: false })).json).toMatchObject({ webSearch: false });
    expect((await api(app, owner, "GET", `/api/agents/${on.id}`)).json).toMatchObject({ webSearch: false });
    expect((await api(app, owner, "GET", "/api/agents")).json.agents.map((a: { webSearch: boolean }) => a.webSearch)).toEqual([false, false]);
    expect((await api(app, owner, "PATCH", `/api/agents/${off.id}`, { webSearch: true })).json).toMatchObject({ webSearch: true });
    expect((await api(app, owner, "PATCH", `/api/agents/${off.id}`, { webSearch: "yes" })).status).toBe(400);
  });
});
