import { describe, expect, it } from "vitest";
import { ensureSocial, listMembers } from "../src/conversations/store.ts";
import { lockPairs } from "../src/social/pair.ts";
import { api, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { MULTIPART, multipart } from "./helpers/multipart.ts";
import { SOCIAL_ON, seedSocial, seedSocialAgents } from "./helpers/social.ts";

// Plan A3a (design §2): the `agent_social` conversation, who is in it, and its write rule.
const { app, db } = useApp({ env: SITE_ENV, config: SOCIAL_ON, agentWorker: false });
const on = { social: { enabled: true } } as const;

let txn = 0;
const send = (who: Actor, conv: string, text: string) => api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `sc${++txn}` });
const upload = async (who: Actor, conv: string) => {
  const res = await app.inject({
    method: "POST",
    url: `/api/conversations/${conv}/attachments`,
    headers: { cookie: who.cookie, "content-type": MULTIPART },
    payload: multipart([{ name: "file", filename: "a.bin", type: "application/octet-stream", data: Buffer.alloc(100, 0x61) }]),
  });
  return { status: res.statusCode, json: JSON.parse(res.body) };
};

interface MadeAgent {
  id: string;
  conversationId: string;
}
async function world(prefix: string) {
  const owner = await signUp(app, `${prefix}owner`);
  const v = await signUp(app, `${prefix}visitor`);
  const agent = (await mustCreateAgent(app, owner, { handle: `${prefix}bot` })) as MadeAgent;
  return { owner, v, agent };
}
/** What the add flow (A4) does: the pair locks, then `ensureSocial`, plus the row that lets the subject in. */
async function open(subject: string, agentId: string, personOf: string = subject) {
  return app.deps.db.tx(async (t) => {
    const owner = (await t.query<{ owner_id: string }>("select owner_id from principals where id = $1", [agentId])).rows[0]!.owner_id;
    await lockPairs(t, [[personOf, owner], [subject, agentId]]);
    return ensureSocial(t, subject, agentId);
  });
}
const endRow = (agentId: string, subjectId: string, reason: string) =>
  db.query(`update agent_contacts set state = 'ended', basis = null, end_reason = $3 where agent_id = $1 and subject_id = $2`, [agentId, subjectId, reason]);
const live = (agentId: string, subjectId: string, personId: string = subjectId) =>
  db.query(`insert into agent_contacts (agent_id, subject_id, person_id, state, basis) values ($1, $2, $3, 'live', 'approved')`, [agentId, subjectId, personId]);
const roles = (members: Array<{ id: string; role: string }>) => new Map(members.map((m) => [m.id, m.role]));

describe("ensureSocial", () => {
  it("makes the conversation, its pair, its members and the disclosure, once", async () => {
    const { owner, v, agent } = await world("ens");
    const made = await open(v.id, agent.id);
    expect(made.created).toBe(true);
    const conv = (await db.query(`select type, creator_id, title from conversations where id = $1`, [made.conversationId])).rows[0];
    expect(conv).toEqual({ type: "agent_social", creator_id: v.id, title: null });
    const [lo, hi] = [v.id, agent.id].sort();
    expect((await db.query(`select a_id, b_id from social_pairs where conversation_id = $1`, [made.conversationId])).rows).toEqual([{ a_id: lo, b_id: hi }]);
    const members = (await listMembers(db, v.id, made.conversationId))!;
    expect(roles(members)).toEqual(new Map([[v.id, "speaker"], [agent.id, "speaker"], [owner.id, "observer"]]));
    expect((await db.query(`select principal_id, joined_seq::int from memberships where conversation_id = $1`, [made.conversationId])).rows.every((r) => r.joined_seq === 0)).toBe(true);
    expect(made.notice).toMatchObject({ seq: 1, kind: "system", conversationId: made.conversationId });
    const first = (await db.query(`select seq::int, kind, body from messages where conversation_id = $1`, [made.conversationId])).rows;
    expect(first).toHaveLength(1);
    expect(first[0]!.body).toMatchObject({ event: "social_opened", actorId: agent.id, agentIds: [agent.id], ownerIds: [owner.id] });
    // Again: the same conversation, nothing new.
    const again = await open(v.id, agent.id);
    expect(again).toEqual({ conversationId: made.conversationId, created: false, notice: null });
    expect((await db.query(`select count(*)::int n from messages where conversation_id = $1`, [made.conversationId])).rows[0]!.n).toBe(1);
    expect((await db.query(`select count(*)::int n from memberships where conversation_id = $1`, [made.conversationId])).rows[0]!.n).toBe(3);
  });

  it("is what seedSocial writes, row for row", async () => {
    const a = await world("eqa");
    const b = await world("eqb");
    const made = await open(a.v.id, a.agent.id);
    const seeded = await seedSocial(app, { owner: b.owner, agentId: b.agent.id, visitor: b.v });
    const shape = async (id: string, who: { v: string; owner: string; agent: string }) => {
      const norm = (x: string) => (x === who.v ? "V" : x === who.owner ? "O" : x === who.agent ? "A" : x);
      const c = (await db.query(`select type, creator_id, title, closed_at, seq::int from conversations where id = $1`, [id])).rows[0]!;
      const m = (await db.query(`select principal_id, role, joined_seq::int, left_seq from memberships where conversation_id = $1`, [id])).rows.map((r) => `${norm(r.principal_id)} ${r.role} ${r.joined_seq} ${r.left_seq}`).sort();
      const p = (await db.query(`select a_id, b_id from social_pairs where conversation_id = $1`, [id])).rows[0]!;
      const msg = (await db.query(`select seq::int, sender_id, kind, body from messages where conversation_id = $1`, [id])).rows.map((r) => ({
        seq: r.seq,
        sender: norm(r.sender_id),
        kind: r.kind,
        body: { ...r.body, text: undefined, actorId: norm(r.body.actorId), agentIds: r.body.agentIds.map(norm), ownerIds: r.body.ownerIds.map(norm) },
      }));
      return { c: { ...c, creator_id: norm(c.creator_id) }, m, p: [norm(p.a_id), norm(p.b_id)].sort(), msg };
    };
    expect(await shape(made.conversationId, { v: a.v.id, owner: a.owner.id, agent: a.agent.id })).toEqual(await shape(seeded.conversationId, { v: b.v.id, owner: b.owner.id, agent: b.agent.id }));
  });

  it("never makes the subject its own observer", async () => {
    const { owner, agent } = await world("self");
    const made = await open(owner.id, agent.id);
    expect(roles((await listMembers(db, owner.id, made.conversationId))!)).toEqual(new Map([[owner.id, "speaker"], [agent.id, "speaker"]]));
  });

  it("between two Agents: both speak, each owner observes, once when one person owns both", async () => {
    const { owner, agent } = await world("aa");
    const other = await signUp(app, "aaother");
    const mine = (await mustCreateAgent(app, owner, { handle: "aamine" })) as MadeAgent;
    const theirs = (await mustCreateAgent(app, other, { handle: "aatheirs" })) as MadeAgent;
    const two = await open(theirs.id, agent.id, other.id);
    expect(roles((await listMembers(db, owner.id, two.conversationId))!)).toEqual(new Map([[theirs.id, "speaker"], [agent.id, "speaker"], [other.id, "observer"], [owner.id, "observer"]]));
    const body = (await db.query(`select body from messages where conversation_id = $1`, [two.conversationId])).rows[0]!.body;
    expect(body).toMatchObject({ event: "social_opened", actorId: agent.id, agentIds: [theirs.id, agent.id] });
    expect([...body.ownerIds].sort()).toEqual([other.id, owner.id].sort());
    const same = await open(mine.id, agent.id, owner.id);
    expect(roles((await listMembers(db, owner.id, same.conversationId))!)).toEqual(new Map([[mine.id, "speaker"], [agent.id, "speaker"], [owner.id, "observer"]]));
    expect((await db.query(`select body from messages where conversation_id = $1`, [same.conversationId])).rows[0]!.body.ownerIds).toEqual([owner.id]);
  });
});

describe("the write rule", () => {
  it("lets the participant and the supervising owner write while the relation is open; a pause stops no one from writing; a removed row refuses both", async () => {
    const { owner, v, agent } = await world("wr");
    await live(agent.id, v.id);
    const { conversationId: conv } = await open(v.id, agent.id);
    expect((await send(v, conv, "你好")).status).toBe(201);
    expect((await send(owner, conv, "我来补充")).status).toBe(201);
    // Paused: the other side may write, nothing answers (design §7).
    expect((await api(app, owner, "POST", `/api/agents/${agent.id}/pause`)).status).toBe(200);
    expect((await send(v, conv, "在吗")).status).toBe(201);
    expect((await api(app, owner, "POST", `/api/agents/${agent.id}/resume`)).status).toBe(200);
    expect((await upload(v, conv)).status).toBe(201);
    await endRow(agent.id, v.id, "removed");
    expect(await send(v, conv, "还在吗")).toMatchObject({ status: 403, json: { error: "cannot_send", reason: "no_access" } });
    expect(await send(owner, conv, "…")).toMatchObject({ status: 403, json: { error: "cannot_send", reason: "no_access" } });
    expect((await upload(v, conv)).status).toBe(403);
    expect((await upload(owner, conv)).status).toBe(403);
    // Reading stays: both still see the conversation.
    expect((await api(app, v, "GET", `/api/conversations/${conv}/messages`)).status).toBe(200);
    expect((await api(app, owner, "GET", `/api/conversations/${conv}/messages`)).status).toBe(200);
  });

  it("a bar between the visitor and the owner refuses the visitor and the owner both", async () => {
    const { owner, v, agent } = await world("bar");
    await live(agent.id, v.id);
    const { conversationId: conv } = await open(v.id, agent.id);
    expect((await send(v, conv, "hi")).status).toBe(201);
    await db.query(`insert into access_bars (setter_id, other_id, kind, since) values ($1, $2, 'stop', now() + interval '1 second')`, [v.id, owner.id]);
    expect(await send(v, conv, "hi")).toMatchObject({ status: 403, json: { reason: "no_access" } });
    expect(await send(owner, conv, "hi")).toMatchObject({ status: 403, json: { reason: "no_access" } });
  });

  it("a block either way refuses with blocked; a deleted Agent refuses with agent_deleted, the owner too", async () => {
    const { owner, v, agent } = await world("blk");
    await live(agent.id, v.id);
    const { conversationId: conv } = await open(v.id, agent.id);
    await db.query(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [v.id, agent.id]);
    expect(await send(v, conv, "x")).toMatchObject({ status: 403, json: { reason: "blocked" } });
    expect(await send(owner, conv, "x")).toMatchObject({ status: 403, json: { reason: "blocked" } });
    await db.query(`delete from blocks`);
    expect((await send(v, conv, "x")).status).toBe(201);
    expect((await api(app, owner, "DELETE", `/api/agents/${agent.id}`)).status).toBe(200);
    expect(await send(v, conv, "x")).toMatchObject({ status: 403, json: { reason: "agent_deleted" } });
    expect(await send(owner, conv, "x")).toMatchObject({ status: 403, json: { reason: "agent_deleted" } });
  });

  it("with the switch off nobody writes: the visitor is agent_unavailable, and so is the owner (the relation is shut), while the Agent's own conversation is as ever (D3, M4)", async () => {
    const { owner, v, agent } = await world("off");
    const seeded = await seedSocial(app, { owner, agentId: agent.id, visitor: v });
    expect((await send(v, seeded.conversationId, "on")).status).toBe(201);
    const social = app.deps.config.social;
    (app.deps.config as { social: unknown }).social = { enabled: false };
    try {
      expect(await send(v, seeded.conversationId, "off")).toMatchObject({ status: 403, json: { error: "cannot_send", reason: "agent_unavailable" } });
      expect(await send(owner, seeded.conversationId, "off")).toMatchObject({ status: 403, json: { reason: "agent_unavailable" } });
      expect((await upload(v, seeded.conversationId)).status).toBe(403);
      expect((await send(owner, agent.conversationId, "my own chat")).status).toBe(201);
    } finally {
      (app.deps.config as { social: unknown }).social = social;
    }
    expect((await send(v, seeded.conversationId, "on again")).status).toBe(201);
  });

  it("between two Agents a supervisor writes iff both directions are open in a group's sense (Agents never use the route)", async () => {
    const { owner, agent } = await world("ag");
    const other = await signUp(app, "agother");
    const theirs = (await mustCreateAgent(app, other, { handle: "agtheirs" })) as MadeAgent;
    const { conversationId: conv } = await seedSocialAgents(app, { x: theirs.id, y: agent.id });
    expect((await send(owner, conv, "mine")).status).toBe(201);
    expect((await send(other, conv, "theirs")).status).toBe(201);
    // A block between the two owners shuts both directions, for both supervisors.
    await db.query(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [other.id, owner.id]);
    expect(await send(owner, conv, "x")).toMatchObject({ status: 403, json: { reason: "blocked" } });
    expect(await send(other, conv, "x")).toMatchObject({ status: 403, json: { reason: "blocked" } });
    await db.query(`delete from blocks`);
    // One direction shut is enough: Y's row for X ended removed shuts reach(X, Y).
    await endRow(agent.id, theirs.id, "removed");
    expect(await send(owner, conv, "x")).toMatchObject({ status: 403, json: { reason: "no_access" } });
    expect(await send(other, conv, "x")).toMatchObject({ status: 403, json: { reason: "no_access" } });
  });

  it("canSend says what a send would", async () => {
    const { owner, v, agent } = await world("cs");
    await live(agent.id, v.id);
    const { conversationId: conv } = await open(v.id, agent.id);
    const { canSend } = await import("../src/conversations/store.ts");
    expect(await canSend(db, conv, v.id, on)).toEqual({ ok: true });
    expect(await canSend(db, conv, owner.id, on)).toEqual({ ok: true });
    await endRow(agent.id, v.id, "narrowed");
    expect(await canSend(db, conv, v.id, on)).toEqual({ ok: false, reason: "no_access" });
    expect(await canSend(db, conv, owner.id, on)).toEqual({ ok: false, reason: "no_access" });
    expect(await canSend(db, conv, (await signUp(app, "csstranger")).id, on)).toBeNull();
  });

  it("M2 of block 2's review: with the switch off an Agent-to-Agent conversation is shut for both owners too", async () => {
    const { owner, agent } = await world("m2");
    const other = await signUp(app, "m2other");
    const theirs = (await mustCreateAgent(app, other, { handle: "m2theirs" })) as MadeAgent;
    const { conversationId: conv } = await seedSocialAgents(app, { x: theirs.id, y: agent.id });
    const { socialCanSendMany } = await import("../src/conversations/store.ts");
    expect((await socialCanSendMany(db, [conv], on)).get(conv)).toEqual({ ok: true });
    expect((await socialCanSendMany(db, [conv], { social: { enabled: false } })).get(conv)).toEqual({ ok: false, reason: "agent_unavailable" });
    // A deleted Agent still says so, the switch or not.
    await db.query(`update agents set deleted_at = now() where principal_id = $1`, [theirs.id]);
    expect((await socialCanSendMany(db, [conv], { social: { enabled: false } })).get(conv)).toEqual({ ok: false, reason: "agent_deleted" });
  });
});
