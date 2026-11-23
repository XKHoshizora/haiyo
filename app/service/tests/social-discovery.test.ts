import { describe, expect, it } from "vitest";
import { findAgentByHandle } from "../src/principals/store.ts";
import { reach } from "../src/social/reach.ts";
import { api, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { SOCIAL_ON } from "./helpers/social.ts";

// Plan A2 (design §1.3; Review Focus 1): finding an Agent by its full handle, its avatar, and blocking it.
const { app, db } = useApp({ env: SITE_ENV, config: SOCIAL_ON, agentWorker: false });
const on = { social: { enabled: true } } as const;

interface MadeAgent {
  id: string;
  handle: string;
}
async function world(prefix: string) {
  const owner = await signUp(app, `${prefix}owner`);
  const v = await signUp(app, `${prefix}visitor`);
  const agent = (await mustCreateAgent(app, owner, { handle: `${prefix}bot`, intro: "I read maps", field: "maps" })) as MadeAgent;
  return { owner, v, agent };
}
const lookup = (who: Actor, handle: string) => api(app, who, "GET", `/api/principals/lookup?handle=${handle}`);
const barsCount = async () => (await db.query<{ n: number }>("select count(*)::int n from access_bars")).rows[0]!.n;

describe("lookup of an Agent by its full handle", () => {
  it("finds a discoverable Agent however it is cased; every near miss and every hidden Agent is the unknown handle's answer", async () => {
    const { owner, v, agent } = await world("disc");
    const unknown = await lookup(v, "nobody.here");
    expect(unknown.status).toBe(404);
    for (const h of ["%20" + agent.handle + "%20", "@" + agent.handle, agent.handle.replace(".", "%E3%80%82"), agent.handle.replace(".", ".."), owner.handle + ".", "." + agent.handle.split(".")[1], "discowner.d", encodeURIComponent("Disc Owner")]) {
      const r = await lookup(v, h);
      expect([h, r.status === 404 || r.status === 400]).toEqual([h, true]);
    }
    // The owner's bare handle is the owner (a person's answer); the Agent's name alone is nobody.
    expect((await lookup(v, "discbot")).status).toBe(404);

    const found = await lookup(v, agent.handle);
    expect(found.status).toBe(200);
    expect(found.json).toEqual({
      id: agent.id,
      handle: agent.handle,
      displayName: expect.any(String),
      avatarVersion: expect.any(Number),
      kind: "agent",
      ownerId: owner.id,
      ownerName: "discowner",
      intro: "I read maps",
      field: "maps",
    });
    expect((await lookup(v, agent.handle.toUpperCase())).json).toMatchObject({ id: agent.id, kind: "agent" }); // M1
    expect((await lookup(v, agent.handle.replace("discbot", "DiscBot"))).json).toMatchObject({ id: agent.id });

    // Hidden: the owner itself, a policy of none, a disabled Agent, a block either way, the switch off.
    const sql = (q: string, p: unknown[] = []) => db.query(q, p);
    const hides: Array<[string, () => Promise<unknown>, () => Promise<unknown>]> = [
      ["policy none", () => sql(`update agents set contact_policy = 'none' where principal_id = $1`, [agent.id]), () => sql(`update agents set contact_policy = 'ask' where principal_id = $1`, [agent.id])],
      ["disabled", () => sql(`update agents set disabled_at = now() where principal_id = $1`, [agent.id]), () => sql(`update agents set disabled_at = null where principal_id = $1`, [agent.id])],
      ["owner blocks visitor", () => sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [owner.id, v.id]), () => sql(`delete from blocks`)],
      ["visitor blocks owner", () => sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [v.id, owner.id]), () => sql(`delete from blocks`)],
      ["visitor blocks the Agent", () => sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [v.id, agent.id]), () => sql(`delete from blocks`)],
      [
        "switch off",
        async () => void ((app.deps.config as { social: { enabled: boolean } }).social = { enabled: false }),
        async () => void ((app.deps.config as { social: { enabled: boolean } }).social = { enabled: true }),
      ],
    ];
    for (const [name, hide, undo] of hides) {
      await hide();
      const r = await lookup(v, agent.handle);
      expect([name, r.status, r.json]).toEqual([name, unknown.status, unknown.json]);
      await undo();
    }
    expect((await lookup(v, agent.handle)).status).toBe(200);
    // Its owner does not find it by lookup either (the owner has the Agent routes).
    expect([owner.handle, (await lookup(owner, agent.handle)).status, (await lookup(owner, agent.handle)).json]).toEqual([owner.handle, 404, unknown.json]);
  });

  it("a person's answer is as it always was: four keys", async () => {
    const { owner, v } = await world("pers");
    expect(Object.keys((await lookup(v, owner.handle)).json)).toEqual(["id", "handle", "displayName", "avatarVersion"]);
    expect((await lookup(v, v.handle)).status).toBe(200);
  });

  it("with the switch off an Agent is nobody to find", async () => {
    const { v, agent } = await world("offs");
    const social = app.deps.config.social;
    (app.deps.config as { social: unknown }).social = { enabled: false };
    try {
      expect((await lookup(v, agent.handle)).status).toBe(404);
      expect(await findAgentByHandle(db, agent.handle, v.id, { social: { enabled: false } })).toBeNull();
    } finally {
      (app.deps.config as { social: unknown }).social = social;
    }
    expect((await findAgentByHandle(db, agent.handle, v.id, on))?.id).toBe(agent.id);
  });

  it("a deleted Agent's handle, reused by a new one, is a new id with no row of the old one", async () => {
    const { owner, v, agent } = await world("reus");
    await db.query(`insert into agent_contacts (agent_id, subject_id, person_id, state, basis) values ($1, $2, $2, 'live', 'approved')`, [agent.id, v.id]);
    expect((await lookup(v, agent.handle)).json).toMatchObject({ id: agent.id });
    expect((await api(app, owner, "DELETE", `/api/agents/${agent.id}`)).status).toBe(200);
    expect((await lookup(v, agent.handle)).status).toBe(404);
    const reused = (await mustCreateAgent(app, owner, { handle: "reusbot" })) as MadeAgent;
    expect(reused.handle).toBe(agent.handle);
    expect(reused.id).not.toBe(agent.id);
    expect((await db.query("select 1 from agent_contacts where agent_id = $1", [reused.id])).rows).toEqual([]);
    expect((await lookup(v, agent.handle)).json).toMatchObject({ id: reused.id, kind: "agent" });
  });
});

describe("the avatar of a discoverable Agent", () => {
  it("loads for a stranger while the Agent is discoverable, and is a random id's the moment it is not", async () => {
    const { v, agent } = await world("avat");
    const get = () => api(app, v, "GET", `/api/principals/${agent.id}/avatar`);
    expect((await get()).status).toBe(200);
    await db.query(`update agents set contact_policy = 'none' where principal_id = $1`, [agent.id]);
    expect((await get()).status).toBe(404);
    await db.query(`update agents set contact_policy = 'ask' where principal_id = $1`, [agent.id]);
    await db.query(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [v.id, agent.id]);
    expect((await get()).status).toBe(404);
  });
});

describe("blocking an Agent", () => {
  it("a visitor blocks a discoverable Agent: the block, no bar; again is the same 200; unblocking brings no row back", async () => {
    const { owner, v, agent } = await world("blk");
    await db.query(`insert into agent_contacts (agent_id, subject_id, person_id, state, basis) values ($1, $2, $2, 'live', 'contacts')`, [agent.id, v.id]);
    expect(await reach(db, v.id, agent.id, "social", on)).toBe("ok");
    expect((await api(app, v, "PUT", `/api/blocks/${agent.id}`)).status).toBe(200);
    expect(await reach(db, v.id, agent.id, "social", on)).toBe("blocked");
    expect(await barsCount()).toBe(0);
    expect((await api(app, v, "PUT", `/api/blocks/${agent.id}`)).status).toBe(200); // it is no longer discoverable; it is still theirs to see
    expect((await db.query("select 1 from blocks where blocker_id = $1", [v.id])).rowCount).toBe(1);
    // The list of blocked names it by its full handle.
    const social = await api(app, v, "GET", "/api/social");
    expect(social.json.blocked).toEqual([{ id: agent.id, handle: agent.handle, displayName: expect.any(String), avatarVersion: expect.any(Number) }]);
    expect((await api(app, v, "DELETE", `/api/blocks/${agent.id}`)).status).toBe(200);
    expect(await reach(db, v.id, agent.id, "social", on)).toBe("ok"); // the row was never touched
    await db.query(`delete from agent_contacts where agent_id = $1`, [agent.id]);
    expect(await reach(db, v.id, agent.id, "social", on)).toBe("no_access");
    expect(owner.id).not.toBe(v.id);
  });

  it("the owner cannot block their own Agent; a stranger cannot block one they cannot see, and gets a random id's answer", async () => {
    const { owner, v, agent } = await world("blkx");
    expect(await api(app, owner, "PUT", `/api/blocks/${agent.id}`)).toMatchObject({ status: 400, json: { error: "invalid_request" } });
    await db.query(`update agents set contact_policy = 'none' where principal_id = $1`, [agent.id]);
    const hidden = await api(app, v, "PUT", `/api/blocks/${agent.id}`);
    const random = await api(app, v, "PUT", `/api/blocks/00000000-0000-4000-8000-000000000000`);
    expect([hidden.status, hidden.json]).toEqual([random.status, random.json]);
    expect((await db.query("select 1 from blocks")).rowCount).toBe(0);
    // Someone who shares a conversation with it now sees it, whatever its policy.
    const mate = await signUp(app, "blkxmate");
    const g = await group(app, owner, "with a bot", [mate, await signUp(app, "blkxmate2")]);
    expect((await api(app, owner, "POST", `/api/conversations/${g}/members`, { principalId: agent.id })).status).toBe(201);
    expect((await api(app, mate, "PUT", `/api/blocks/${agent.id}`)).status).toBe(200);
    expect((await db.query("select 1 from blocks where blocker_id = $1 and blocked_id = $2", [mate.id, agent.id])).rowCount).toBe(1);
  });

  it("with the switch off nobody can block an Agent, as before", async () => {
    const { v, agent } = await world("blkoff");
    const social = app.deps.config.social;
    (app.deps.config as { social: unknown }).social = { enabled: false };
    try {
      expect(await api(app, v, "PUT", `/api/blocks/${agent.id}`)).toMatchObject({ status: 404, json: { error: "not_found" } });
    } finally {
      (app.deps.config as { social: unknown }).social = social;
    }
    expect((await db.query("select 1 from blocks")).rowCount).toBe(0);
  });
});
