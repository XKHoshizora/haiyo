import { describe, expect, it } from "vitest";
import { api, befriend, signUp } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";

/**
 * Fix round 1, m18: an app STARTED with the site's Agent social switch off (the default configuration, the state ring 1a deploys in),
 * not one whose switch is flipped while it runs. Every route of Agent social's access answers 404 before it reads or writes anything
 * (a malformed parameter is still the schema's 400, but on the two find-an-Agent routes, which answer 404 before the shape: find-agent
 * fix round 1, F6); the lookup takes no dotted handle at all (its schema is read once, when the
 * routes are registered: 400); an Agent cannot be blocked; the money routes are live; and nothing was written.
 */
const { app, db } = useApp({ env: SITE_ENV, agentWorker: false });

describe("an app started with the switch off", () => {
  it("every access route is 404 for a signed-in person, 401 signed out; the lookup refuses an Agent's handle as malformed; the use routes answer", async () => {
    const [owner, other] = [await signUp(app, "off_owner"), await signUp(app, "off_other")];
    await befriend(app, owner, other);
    const agent = (await mustCreateAgent(app, owner, { handle: "off_bot" })) as { id: string };
    expect(app.deps.config.social.enabled).toBe(false);
    const routes: Array<["GET" | "POST" | "PUT" | "DELETE", string, unknown?]> = [
      ["POST", "/api/agent-contacts", { agentId: agent.id }],
      ["GET", "/api/agent-contacts"],
      ["POST", `/api/agent-contacts/${agent.id}/${other.id}/approve`],
      ["POST", `/api/agent-contacts/${agent.id}/${other.id}/decline`],
      ["DELETE", `/api/agent-contacts/${agent.id}/${other.id}`],
      ["GET", `/api/agents/${agent.id}/contacts`],
      ["PUT", `/api/agents/${agent.id}/contact-policy`, { policy: "none", picked: false, picks: [] }],
      ["PUT", `/api/bars/${other.id}`],
      ["DELETE", `/api/bars/${other.id}`],
      ["POST", "/api/reports", { agentId: agent.id, reason: "spam" }],
      ["POST", `/api/agents/${agent.id}/persona-facts/1`, { move: false }],
      // Finding someone's Agent (find-agent design): the search, typed and explicit, and the card by id.
      ["GET", `/api/principals/search?q=${owner.handle}`],
      ["GET", `/api/principals/search?q=${owner.handle}&exact=1`],
      ["GET", `/api/principals/agent-card/${agent.id}`],
      // …answered so before the query's shape is (fix round 1, F6): an endpoint that is not there has no shape to get wrong.
      ["GET", "/api/principals/search"],
      ["GET", "/api/principals/search?q=a%00b&exact=2"],
      ["GET", `/api/principals/agent-card/${"x".repeat(150)}`],
    ];
    for (const [method, path, body] of routes) {
      for (const who of [owner, other]) expect([method, path, (await api(app, who, method, path, body)).status]).toEqual([method, path, 404]);
      expect([method, path, (await api(app, null, method, path, body)).status]).toEqual([method, path, 401]);
    }
    expect((await api(app, owner, "PUT", "/api/bars/not-an-id")).status).toBe(400);
    // The lookup: people as ever; an Agent's full handle is not a handle here.
    expect((await api(app, other, "GET", `/api/principals/lookup?handle=${owner.handle}`)).status).toBe(200);
    expect((await api(app, other, "GET", `/api/principals/lookup?handle=${owner.handle}.off_bot`)).status).toBe(400);
    // An Agent cannot be blocked, as before; a person can, and that block is a bar's row (nothing reads it but the group decision).
    expect((await api(app, other, "PUT", `/api/blocks/${agent.id}`)).status).toBe(404);
    // Money is live whatever the switch says.
    const use = await api(app, owner, "GET", "/api/me/others-use");
    expect([use.status, use.json.limit, use.json.stopped]).toEqual([200, "300", []]);
    expect((await api(app, owner, "PUT", "/api/me/others-limits", { points: "250" })).status).toBe(200);
    expect((await api(app, owner, "GET", "/api/sync")).json.social).toEqual({ enabled: false });
    // Nothing of Agent social was written by any of it.
    const counts = await db.query<{ contacts: number; bars: number; reports: number; social: number }>(
      `select (select count(*)::int from agent_contacts) as contacts, (select count(*)::int from access_bars) as bars,
              (select count(*)::int from agent_reports) as reports, (select count(*)::int from conversations where type = 'agent_social') as social`,
    );
    expect(counts.rows[0]).toEqual({ contacts: 0, bars: 0, reports: 0, social: 0 });
    expect((await db.query<{ policy: string }>("select contact_policy as policy from agents where principal_id = $1", [agent.id])).rows[0]!.policy).toBe("ask");
  });
});
