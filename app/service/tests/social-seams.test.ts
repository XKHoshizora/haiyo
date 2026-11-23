import { describe, expect, it, vi } from "vitest";
import { actOnTriggered, noneTriggered } from "../src/agents/runs.ts";
import { NO_NOTES } from "../src/agents/runtime/prompt.ts";
import { renderNotice } from "../src/conversations/system.ts";
import { canSend, ensureSocial } from "../src/conversations/store.ts";
import { loadNotes } from "../src/memory/passage.ts";
import { shownNotesPass } from "../src/memory/shown.ts";
import { startNoteJudge } from "../src/memory/judge.ts";
import { keepsRoom, othersFits } from "../src/metering/others.ts";
import { addContact, applyPolicy, endGrants } from "../src/social/agent-contacts.ts";
import { discoverable, reach, reachSql, refusedSql } from "../src/social/reach.ts";
import { api, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { SOCIAL_ON, seedSocial, seedSocialAgents } from "./helpers/social.ts";

/**
 * Step 0's seams keep today's behaviour (the reach rule is A1's now, asked with the switch on for the social half), the money stubs answer yes, the notes of a social
 * conversation are none, and a seeded social conversation takes a message through the write rule's skeleton.
 */
const { app, db } = useApp({ env: SITE_ENV, models: scriptedGateway(), agentWorker: false, config: SOCIAL_ON });
const off = { social: { enabled: false } } as const;
const on = { social: { enabled: true } } as const;

let txn = 0;
const send = (who: Actor, conv: string, text: string) => api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `ss${++txn}` });

async function world() {
  const owner = await signUp(app, "ssowner");
  const member = await signUp(app, "ssmember");
  const v = await signUp(app, "ssvisitor");
  const agent = (await mustCreateAgent(app, owner, { handle: "ssbot" })) as { id: string; conversationId: string };
  return { owner, member, v, agent };
}
const asAgent = (owner: Actor, agent: { id: string }) => ({ id: agent.id, ownerId: owner.id, memory: true, sharedNotes: true });

describe("the stubs keep today's behaviour", () => {
  it("reach: a group is ok unless a block lies between the owner and the person; social is ok for the owner and a live row", async () => {
    const { owner, member, v, agent } = await world();
    expect(await reach(db, member.id, agent.id, "group", off)).toBe("ok");
    await api(app, owner, "PUT", `/api/blocks/${member.id}`);
    expect(await reach(db, member.id, agent.id, "group", off)).toBe("blocked");
    // The other way round, and through an Agent of the blocked person's.
    expect(await reach(db, v.id, agent.id, "group", off)).toBe("ok");
    await api(app, v, "PUT", `/api/blocks/${owner.id}`);
    expect(await reach(db, v.id, agent.id, "group", off)).toBe("blocked");
    // Social (the block is lifted: a block now refuses a social subject too): the owner, and a person with a live row; nobody else.
    await api(app, owner, "DELETE", `/api/blocks/${member.id}`);
    expect(await reach(db, owner.id, agent.id, "social", on)).toBe("ok");
    expect(await reach(db, member.id, agent.id, "social", on)).toBe("no_access");
    const seeded = await seedSocial(app, { owner, agentId: agent.id, visitor: member });
    expect(await reach(db, member.id, agent.id, "social", on)).toBe("ok");
    await db.query(`update agent_contacts set state = 'ended', basis = null, end_reason = 'removed' where agent_id = $1 and subject_id = $2`, [agent.id, member.id]);
    expect(await reach(db, member.id, agent.id, "social", on)).toBe("barred");
    expect(seeded.subjectId).toBe(member.id);
  });

  it("reachSql says what reach says, and refusedSql is its negation of ok", async () => {
    const { owner, member, v, agent } = await world();
    await seedSocial(app, { owner, agentId: agent.id, visitor: member });
    await api(app, owner, "PUT", `/api/blocks/${v.id}`);
    for (const where of ["group", "social"] as const) {
      for (const who of [owner, member, v]) {
        const sql = await db.query<{ r: string; refused: boolean }>(
          `select ${reachSql({ subject: "$1::uuid", agent: "$2::uuid", where, socialOn: "false" })} as r,
                  ${refusedSql({ subject: "$1::uuid", agent: "$2::uuid", where, socialOn: "false" })} as refused`,
          [who.id, agent.id],
        );
        const direct = await reach(db, who.id, agent.id, where, off);
        expect(sql.rows[0]!.r, `${where} ${who.handle}`).toBe(direct);
        expect(sql.rows[0]!.refused).toBe(direct !== "ok");
      }
    }
  });

  it("an Agent reaches as its owner does: through the person behind it", async () => {
    const { owner, member, agent } = await world();
    const other = (await mustCreateAgent(app, member, { handle: "ssother" })) as { id: string };
    expect(await reach(db, other.id, agent.id, "group", off)).toBe("ok");
    await api(app, owner, "PUT", `/api/blocks/${member.id}`);
    expect(await reach(db, other.id, agent.id, "group", off)).toBe("blocked");
  });

  it("nothing is discoverable, the money stubs say yes, the notes of a social conversation are none", async () => {
    const { owner, member, v, agent } = await world();
    expect(await discoverable(db, agent.id, member.id, off)).toBe(false);
    expect([keepsRoom("AB", "own"), keepsRoom("B", "own"), keepsRoom("B", "others"), keepsRoom("B", "proactive"), keepsRoom("A", "own")]).toEqual([true, false, true, true, false]);
    const verdict = await db.tx((t) => othersFits(t, app.deps.config, { id: "r", ownerId: owner.id, agentId: agent.id, lane: "others" }, 1n, "admission", new Date()));
    expect(verdict).toEqual({ ok: true });
    const s = (await seedSocial(app, { owner, agentId: agent.id, visitor: v })).conversationId;
    const loaded = await db.tx((t) => loadNotes(t, asAgent(owner, agent), { place: "social", conversationId: s, audienceId: v.id }, app.deps.config));
    expect(loaded).toEqual({ notes: NO_NOTES, shown: [], withheld: [] });
    expect(await db.tx((t) => shownNotesPass(t, asAgent(owner, agent), v.id, []))).toBe(true);
    expect(await db.tx((t) => shownNotesPass(t, asAgent(owner, agent), v.id, [{ kind: "owner", id: "x", version: "1" }]))).toBe(false);
  });

  it("own and group notes are read as before, on a plain connection", async () => {
    const { owner, agent } = await world();
    const own = await loadNotes(db, asAgent(owner, agent), { place: "own" }, app.deps.config);
    expect(own).toEqual({ notes: NO_NOTES, shown: [], withheld: [] });
    const grp = await loadNotes(db, asAgent(owner, agent), { place: "group", conversationId: "00000000-0000-4000-8000-000000000000" }, app.deps.config);
    expect(grp.notes).toEqual(NO_NOTES);
  });

  it("the note judge does nothing yet, and what lane A owns throws", async () => {
    const { owner, member, agent } = await world();
    const judge = startNoteJudge({ db, config: app.deps.config, models: app.deps.models, log: app.log, inFlight: new Set(), conversations: app.deps.conversations, closing: new AbortController().signal }, { timer: false });
    expect(await judge.runOnce()).toBe(0);
    await judge.close();
    const t = db as never;
    await expect(endGrants(t, { between: [owner.id, member.id] }, "barred")).rejects.toThrow("ring 1: lane A");
    await expect(applyPolicy(t, owner.id, agent.id, { policy: "ask", picked: false, picks: [] }, { dryRun: true })).rejects.toThrow("ring 1: lane A");
    await expect(addContact(t, app.deps.config, member.id, agent.id)).rejects.toThrow("ring 1: lane A");
    await expect(ensureSocial(t, member.id, agent.id)).rejects.toThrow("ring 1: lane A");
  });

  it("a message that stopped runs interrupts them after commit, and one that stopped none interrupts nothing", () => {
    expect(noneTriggered().stopped).toEqual([]);
    const interrupt = vi.fn();
    const to = { announce: vi.fn(), log: { info: vi.fn() }, realtime: { pushAgentChanged: vi.fn() }, interrupt };
    actOnTriggered(noneTriggered(), to);
    expect(interrupt).not.toHaveBeenCalled();
    actOnTriggered({ ...noneTriggered(), stopped: ["r1", "r2"] }, to);
    expect(interrupt).toHaveBeenCalledWith(["r1", "r2"]);
  });
});

describe("a seeded social conversation takes a message through the write rule's skeleton", () => {
  it("seeds the members, the pair, a live row and a first notice as the add flow will", async () => {
    const { owner, v, agent } = await world();
    const seeded = await seedSocial(app, { owner, agentId: agent.id, visitor: v });
    const members = await db.query(`select principal_id, role, joined_seq::int from memberships where conversation_id = $1 order by role, principal_id`, [seeded.conversationId]);
    expect(new Map(members.rows.map((r) => [r.principal_id, `${r.role} ${r.joined_seq}`]))).toEqual(
      new Map([[v.id, "speaker 0"], [agent.id, "speaker 0"], [owner.id, "observer 0"]]),
    );
    const live = await db.query(`select state, basis, person_id from agent_contacts where agent_id = $1`, [agent.id]);
    expect(live.rows).toEqual([{ state: "live", basis: "approved", person_id: v.id }]);
    const first = await db.query(`select seq::int, kind, body->>'event' as event from messages where conversation_id = $1`, [seeded.conversationId]);
    expect(first.rows).toEqual([{ seq: 1, kind: "system", event: "social_opened" }]);
  });

  it("the visitor writes while the row is live, and is refused no_access when it ends", async () => {
    const { owner, v, agent } = await world();
    const seeded = await seedSocial(app, { owner, agentId: agent.id, visitor: v });
    expect((await send(v, seeded.conversationId, "你好")).status).toBe(201);
    // The supervising owner writes too (the same `reach` is ok for them).
    expect((await send(owner, seeded.conversationId, "我是主人")).status).toBe(201);
    expect(await canSend(db, seeded.conversationId, v.id, on)).toEqual({ ok: true });
    await db.query(`update agent_contacts set state = 'ended', basis = null, end_reason = 'removed' where agent_id = $1 and subject_id = $2`, [agent.id, v.id]);
    expect(await send(v, seeded.conversationId, "还在吗")).toMatchObject({ status: 403, json: { reason: "no_access" } });
    expect(await canSend(db, seeded.conversationId, v.id, on)).toEqual({ ok: false, reason: "no_access" });
    // The owner is never refused by a row.
    expect((await send(owner, seeded.conversationId, "还在")).status).toBe(201);
  });

  it("syncs as a conversation of its own type, a speaker for the visitor and an observer for the owner, the switch in the view", async () => {
    const { owner, v, agent } = await world();
    const seeded = await seedSocial(app, { owner, agentId: agent.id, visitor: v });
    const mine = await api(app, v, "GET", "/api/sync");
    expect(mine.json.social).toEqual({ enabled: true });
    expect(mine.json.conversations.find((c: { id: string }) => c.id === seeded.conversationId)).toMatchObject({ type: "agent_social", myRole: "speaker", canSend: { ok: true } });
    const theirs = await api(app, owner, "GET", "/api/sync");
    expect(theirs.json.conversations.find((c: { id: string }) => c.id === seeded.conversationId)).toMatchObject({ type: "agent_social", myRole: "observer" });
  });

  it("seeds an Agent-to-Agent conversation: both Agents speak, each owner observes", async () => {
    const { owner, member, agent } = await world();
    const other = (await mustCreateAgent(app, member, { handle: "ssother2" })) as { id: string };
    const seeded = await seedSocialAgents(app, { x: other.id, y: agent.id });
    expect(seeded).toMatchObject({ agentId: agent.id, ownerId: owner.id, subjectId: other.id });
    const roles = await db.query(`select principal_id, role from memberships where conversation_id = $1`, [seeded.conversationId]);
    expect(new Map(roles.rows.map((r) => [r.principal_id, r.role]))).toEqual(
      new Map([[other.id, "speaker"], [agent.id, "speaker"], [member.id, "observer"], [owner.id, "observer"]]),
    );
  });
});

describe("the notice sentences", () => {
  it("social_opened is the disclosure; the other two are system lines", async () => {
    const { owner, agent } = await world();
    const name = (await db.query<{ display_name: string }>("select display_name from principals where id = $1", [owner.id])).rows[0]!.display_name;
    expect(await renderNotice(db, "00000000-0000-4000-8000-000000000000", { event: "social_opened", actorId: agent.id, agentIds: [agent.id], ownerIds: [owner.id] })).toBe(
      `这是${name}的 Agent。${name}能看到你们的对话，也可能插话。`,
    );
    const iso = new Date().toISOString();
    expect(await renderNotice(db, "x", { event: "note_withheld", actorId: agent.id, agentId: agent.id, audienceId: owner.id, noteKind: "owner", noteId: "n", expiresAt: iso })).toBe("有一条笔记没有告诉别人");
    expect(await renderNotice(db, "x", { event: "persona_fact", actorId: agent.id, agentId: agent.id, sentence: "s", personaVersion: 1, expiresAt: iso })).toBe("人格里有一句话可能是事实");
  });

  it("two owners are joined by 、", async () => {
    const { owner, member, agent } = await world();
    const names = (await db.query<{ id: string; display_name: string }>("select id, display_name from principals where id = any($1::uuid[])", [[owner.id, member.id]])).rows;
    const n = (id: string) => names.find((r) => r.id === id)!.display_name;
    expect(await renderNotice(db, "x", { event: "social_opened", actorId: agent.id, agentIds: [agent.id], ownerIds: [owner.id, member.id] })).toBe(
      `这是${n(owner.id)}、${n(member.id)}的 Agent。${n(owner.id)}、${n(member.id)}能看到你们的对话，也可能插话。`,
    );
  });
});

describe("the switch", () => {
  it("a test turns it on with SOCIAL_ON (the default, off, is pinned by config-agents.test.ts)", () => {
    expect(app.deps.config.social).toEqual({ enabled: true });
    expect(SOCIAL_ON).toEqual({ social: { enabled: true } });
  });
});
