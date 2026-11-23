import { describe, expect, it } from "vitest";
import { api, signUp } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { SOCIAL_ON } from "./helpers/social.ts";

// Plan A10: five reports a minute per person (RATE_LIMIT_SCALE 1 here: the other agent-reports tests run with a wide scale).
const { app } = useApp({ env: { ...SITE_ENV, RATE_LIMIT_SCALE: "1" }, config: SOCIAL_ON, agentWorker: false });

describe("POST /api/reports rate", () => {
  it("the sixth report in a minute is 429; another person is unaffected", async () => {
    const owner = await signUp(app, "rlowner");
    const a = await signUp(app, "rla");
    const b = await signUp(app, "rlb");
    const agent = (await mustCreateAgent(app, owner, { handle: "rlbot" })) as { id: string };
    const send = (who: typeof a) => api(app, who, "POST", "/api/reports", { agentId: agent.id, reason: "spam" });
    for (let i = 0; i < 5; i++) expect([i, (await send(a)).status]).toEqual([i, 201]);
    expect((await send(a)).status).toBe(429);
    expect((await send(b)).status).toBe(201);
  });
});
