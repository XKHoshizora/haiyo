import { describe, expect, it } from "vitest";
import { groupPlaceSql, placeOf, placeOfType, socialPlaceSql } from "../src/social/place.ts";
import { api, group, signUp } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { seedSocial } from "./helpers/social.ts";

/** `placeOf`: the one test of where a run is (the Agent's own conversation, a group, or a social conversation). */
const { app, db } = useApp({ env: SITE_ENV, models: scriptedGateway(), agentWorker: false });

async function world() {
  const owner = await signUp(app, "plowner");
  const friend = await signUp(app, "plfriend");
  const second = await signUp(app, "plsecond");
  const visitor = await signUp(app, "plvisitor");
  const agent = (await mustCreateAgent(app, owner, { handle: "plbot" })) as { id: string; conversationId: string };
  const groupId = await group(app, owner, "pl group", [friend, second]);
  const directId = (await api(app, owner, "GET", "/api/sync")).json.conversations.find((c: { type: string }) => c.type === "direct").id as string;
  const social = await seedSocial(app, { owner, agentId: agent.id, visitor });
  return { owner, friend, visitor, agent, groupId, directId, socialId: social.conversationId };
}

describe("placeOf", () => {
  it("names where a run is: own, group or social; a direct chat is nowhere an Agent is", async () => {
    const { agent, groupId, directId, socialId } = await world();
    expect(placeOfType("agent", agent.conversationId, agent)).toBe("own");
    expect(placeOfType("group", groupId, agent)).toBe("group");
    expect(placeOfType("agent_social", socialId, agent)).toBe("social");
    expect(() => placeOfType("direct", directId, agent)).toThrow();
    // Another Agent's own conversation is not this Agent's own.
    expect(() => placeOfType("agent", groupId, agent)).toThrow();
  });

  it("reads the type from the database", async () => {
    const { agent, groupId, directId, socialId } = await world();
    expect(await placeOf(db, agent.conversationId, agent)).toBe("own");
    expect(await placeOf(db, groupId, agent)).toBe("group");
    expect(await placeOf(db, socialId, agent)).toBe("social");
    await expect(placeOf(db, directId, agent)).rejects.toThrow();
    await expect(placeOf(db, "00000000-0000-4000-8000-000000000000", agent)).rejects.toThrow();
  });

  it("gives the SQL of a group and of a social conversation, and nothing else matches", async () => {
    const { groupId, directId, socialId, agent } = await world();
    const kinds = await db.query<{ id: string; grp: boolean; soc: boolean }>(
      `select c.id, ${groupPlaceSql("c")} as grp, ${socialPlaceSql("c")} as soc from conversations c where c.id = any($1::uuid[])`,
      [[groupId, directId, socialId, agent.conversationId]],
    );
    const by = new Map(kinds.rows.map((r) => [r.id, r]));
    expect(by.get(groupId)).toMatchObject({ grp: true, soc: false });
    expect(by.get(socialId)).toMatchObject({ grp: false, soc: true });
    expect(by.get(directId)).toMatchObject({ grp: false, soc: false });
    expect(by.get(agent.conversationId)).toMatchObject({ grp: false, soc: false });
  });
});
