import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { addContact } from "../src/social/agent-contacts.ts";
import { reach } from "../src/social/reach.ts";
import { api, befriend, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { holdThen, someoneWaits } from "./helpers/locks.ts";
import { SOCIAL_ON, seedSocial } from "./helpers/social.ts";

// Plan A4 (design §1.2, §2, §7): the rows of `agent_contacts`: add, approve, decline, expire, remove, leave, and the lists.
const { app, db } = useApp({ env: SITE_ENV, config: SOCIAL_ON, agentWorker: false });
const on = { social: { enabled: true } } as const;
const DAY = 86_400_000;

interface MadeAgent {
  id: string;
  conversationId: string;
}
let n = 0;
async function person(): Promise<Actor> {
  const h = `sct_${++n}_${Math.random().toString(36).slice(2, 6)}`;
  await db.query(`insert into "user" (id, name, email, "emailVerified") values ($1::text, $1::text, $1::text || '@example.test', true)`, [`auth-${h}`]);
  const { rows } = await db.query<{ id: string }>(`insert into principals (kind, handle, display_name, auth_user_id) values ('human', $1::citext, $1::text, 'auth-' || $1::text) returning id`, [h]);
  return { id: rows[0]!.id, handle: h } as Actor;
}
async function agentOf(owner: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(`insert into principals (kind, handle, display_name, owner_id) values ('agent', $1::citext, $1::text, $2) returning id`, [`sg${++n}_${Math.random().toString(36).slice(2, 6)}`, owner]);
  await db.query(`insert into agents (principal_id) values ($1)`, [rows[0]!.id]);
  return rows[0]!.id;
}
async function world(prefix: string) {
  const owner = await signUp(app, `${prefix}owner`);
  const agent = (await mustCreateAgent(app, owner, { handle: `${prefix}bot` })) as MadeAgent;
  return { owner, agent };
}

const add = (who: Actor, agentId: string) => api(app, who, "POST", "/api/agent-contacts", { agentId });
const approve = (owner: Actor, agentId: string, subject: Actor | string) => api(app, owner, "POST", `/api/agent-contacts/${agentId}/${typeof subject === "string" ? subject : subject.id}/approve`);
const decline = (owner: Actor, agentId: string, subject: Actor | string) => api(app, owner, "POST", `/api/agent-contacts/${agentId}/${typeof subject === "string" ? subject : subject.id}/decline`);
const remove = (who: Actor, agentId: string, subject: Actor | string) => api(app, who, "DELETE", `/api/agent-contacts/${agentId}/${typeof subject === "string" ? subject : subject.id}`);
const policy = (agentId: string, p: "ask" | "contacts" | "none", picked = false) => db.query(`update agents set contact_policy = $2, contact_picked = $3 where principal_id = $1`, [agentId, p, picked]);
const pick = (agentId: string, personId: string) => db.query(`insert into agent_contact_picks (agent_id, person_id) values ($1, $2)`, [agentId, personId]);
const ageRow = (agentId: string, subjectId: string, ms: number) =>
  db.query(`update agent_contacts set since = since - $3 * interval '1 millisecond', until = until - $3 * interval '1 millisecond' where agent_id = $1 and subject_id = $2`, [agentId, subjectId, ms]);
const rowOf = async (agentId: string, subjectId: string) =>
  (await db.query(`select state, basis, person_id, since, until, end_reason from agent_contacts where agent_id = $1 and subject_id = $2`, [agentId, subjectId])).rows[0] as
    | { state: string; basis: string | null; person_id: string; since: Date; until: Date | null; end_reason: string | null }
    | undefined;
/** O stopped P (what 停止往来 writes, A5b): the bar, set by O. */
const stop = (ownerId: string, personId: string, o: { by?: string; block?: boolean } = {}) => {
  const [lo, hi] = [ownerId, personId].sort();
  return db.query(`insert into access_bars (lo_id, hi_id, reason, set_by, by_block) values ($1, $2, 'stopped', $3, $4)`, [lo, hi, o.by ?? ownerId, o.block ?? false]);
};
const ageBar = (a: string, b: string, ms: number) => {
  const [lo, hi] = [a, b].sort();
  return db.query(`update access_bars set since = since - $3 * interval '1 millisecond' where lo_id = $1 and hi_id = $2`, [lo, hi, ms]);
};
const direct = (subjectId: string, agentId: string) => db.tx((t) => addContact(t, app.deps.config, subjectId, agentId));
const iso = (ms: number) => new Date(ms).toISOString();

describe("add", () => {
  it("under 需要我同意 a request waits, the owner approves it once, and the visitor is let in", async () => {
    const { owner, agent } = await world("ask");
    const v = await signUp(app, "askvisitor");
    const asked = await add(v, agent.id);
    expect(asked).toMatchObject({ status: 202, json: { state: "requested" } });
    const row = (await rowOf(agent.id, v.id))!;
    expect([row.state, row.basis, row.person_id, row.end_reason]).toEqual(["requested", null, v.id, null]);
    expect(asked.json.until).toBe(row.until!.toISOString());
    expect(row.until!.getTime() - row.since.getTime()).toBe(7 * DAY);
    // Asking again says the same, with the same end.
    expect(await add(v, agent.id)).toMatchObject({ status: 202, json: { state: "requested", until: asked.json.until } });
    expect(await reach(db, v.id, agent.id, "social", on)).toBe("no_access");
    const approved = await approve(owner, agent.id, v);
    expect(approved).toMatchObject({ status: 200, json: { state: "live", conversationId: expect.any(String) } });
    expect(await approve(owner, agent.id, v)).toMatchObject({ status: 409, json: { error: "not_requested" } });
    const live = (await rowOf(agent.id, v.id))!;
    expect([live.state, live.basis, live.until, live.end_reason]).toEqual(["live", "approved", null, null]);
    expect(await reach(db, v.id, agent.id, "social", on)).toBe("ok");
    // Live: asking again answers live, with the same conversation.
    expect(await add(v, agent.id)).toMatchObject({ status: 201, json: { state: "live", conversationId: approved.json.conversationId } });
    // The conversation: both write, the owner observes.
    const sync = (await api(app, owner, "GET", "/api/sync")).json.conversations.find((c: { id: string }) => c.id === approved.json.conversationId);
    expect(sync).toMatchObject({ type: "agent_social", myRole: "observer", canSend: { ok: true } });
    expect((await api(app, v, "POST", `/api/conversations/${approved.json.conversationId}/messages`, { text: "你好", clientTxn: "c1" })).status).toBe(201);
  });

  it("is what seedSocial writes: the same live row and conversation", async () => {
    const { owner, agent } = await world("seeq");
    const a = await signUp(app, "seeqa");
    const b = await signUp(app, "seeqb");
    await add(a, agent.id);
    const approved = await approve(owner, agent.id, a);
    const seeded = await seedSocial(app, { owner, agentId: agent.id, visitor: b });
    const norm = async (v: Actor) => {
      const r = (await rowOf(agent.id, v.id))!;
      return [r.state, r.basis, r.person_id === v.id, r.until, r.end_reason];
    };
    expect(await norm(a)).toEqual(await norm(b));
    const kinds = async (c: string) => (await db.query(`select role, count(*)::int n from memberships where conversation_id = $1 group by role order by role`, [c])).rows;
    expect(await kinds(approved.json.conversationId)).toEqual(await kinds(seeded.conversationId));
  });

  it("under 我的联系人可以直接加 a friend is let in at once, a stranger asks, and with picks only a picked friend is let in", async () => {
    const { owner, agent } = await world("con");
    await policy(agent.id, "contacts");
    const friend = await signUp(app, "confriend");
    const stranger = await signUp(app, "constranger");
    const unpicked = await signUp(app, "conunpicked");
    await befriend(app, owner, friend);
    await befriend(app, owner, unpicked);
    const letIn = await add(friend, agent.id);
    expect(letIn).toMatchObject({ status: 201, json: { state: "live", conversationId: expect.any(String) } });
    expect((await rowOf(agent.id, friend.id))).toMatchObject({ state: "live", basis: "contacts", until: null });
    expect(await add(stranger, agent.id)).toMatchObject({ status: 202 });
    // With picks: only the picked.
    await policy(agent.id, "contacts", true);
    await pick(agent.id, friend.id);
    expect(await add(unpicked, agent.id)).toMatchObject({ status: 202, json: { state: "requested" } });
    // The picked friend, who is live already: still live. Another picked friend is let in.
    const other = await signUp(app, "conother");
    await befriend(app, owner, other);
    await pick(agent.id, other.id);
    expect(await add(other, agent.id)).toMatchObject({ status: 201, json: { state: "live" } });
  });

  it("is refused for the owner's own, and an Agent nobody may find is not found, however it is asked", async () => {
    const { owner, agent } = await world("own");
    const mine = await agentOf(owner.id);
    expect(await add(owner, agent.id)).toMatchObject({ status: 409, json: { error: "is_yours" } });
    expect(await direct(mine, agent.id)).toEqual({ refused: "is_yours" });
    const v = await signUp(app, "ownvisitor");
    await policy(agent.id, "none");
    const hidden = await add(v, agent.id);
    const random = await add(v, "00000000-0000-4000-8000-000000000000");
    expect([hidden.status, hidden.json]).toEqual([random.status, random.json]);
    expect(hidden.status).toBe(404);
    await policy(agent.id, "ask");
    // A person's id, an Agent that is disabled, deleted, or blocked by the asker or by its owner.
    expect((await add(v, owner.id)).status).toBe(404);
    await db.query(`update agents set disabled_at = now() where principal_id = $1`, [agent.id]);
    expect((await add(v, agent.id)).status).toBe(404);
    await db.query(`update agents set disabled_at = null where principal_id = $1`, [agent.id]);
    await db.query(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [owner.id, v.id]);
    expect((await add(v, agent.id)).status).toBe(404);
    await db.query(`delete from blocks`);
    await db.query(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [v.id, agent.id]);
    expect((await add(v, agent.id)).status).toBe(404);
    await db.query(`delete from blocks`);
    expect((await add(v, agent.id)).status).toBe(202);
    expect((await db.query(`select count(*)::int n from agent_contacts where agent_id = $1`, [agent.id])).rows[0]!.n).toBe(1);
  });

  it("an Agent as the subject is judged by its person's and its own blocks", async () => {
    const { owner, agent } = await world("asub");
    const p = await signUp(app, "asubp");
    const pAgent = await agentOf(p.id);
    expect(await direct(pAgent, agent.id)).toMatchObject({ state: "requested" });
    expect((await rowOf(agent.id, pAgent))).toMatchObject({ state: "requested", person_id: p.id });
    await db.query(`delete from agent_contacts`);
    await db.query(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [owner.id, pAgent]);
    expect(await direct(pAgent, agent.id)).toEqual({ refused: "not_found" });
  });

  it("with the switch off every route answers 404, a person's lookup of nothing included", async () => {
    const { owner, agent } = await world("sw");
    const v = await signUp(app, "swvisitor");
    expect((await add(v, agent.id)).status).toBe(202);
    const social = app.deps.config.social;
    (app.deps.config as { social: unknown }).social = { enabled: false };
    try {
      const gone = (await api(app, v, "GET", "/api/principals/00000000-0000-4000-8000-000000000000/avatar")).json;
      for (const r of [
        await add(v, agent.id),
        await api(app, v, "GET", "/api/agent-contacts"),
        await approve(owner, agent.id, v),
        await decline(owner, agent.id, v),
        await remove(v, agent.id, v),
      ]) {
        expect([r.status, r.json]).toEqual([404, gone]);
      }
    } finally {
      (app.deps.config as { social: unknown }).social = social;
    }
    expect((await rowOf(agent.id, v.id))!.state).toBe("requested");
  });
});

describe("a request expires and an approval is time-bound", () => {
  it("is approvable until its seventh day, and a row past it is ended expired when it is read for a decision", async () => {
    const { owner, agent } = await world("exp");
    const v = await signUp(app, "expvisitor");
    await add(v, agent.id);
    await ageRow(agent.id, v.id, 7 * DAY - 20_000);
    expect((await approve(owner, agent.id, v)).status).toBe(200);
    // Another asker, one second late.
    const w = await signUp(app, "expw");
    await add(w, agent.id);
    await ageRow(agent.id, w.id, 7 * DAY + 1000);
    expect(await approve(owner, agent.id, w)).toMatchObject({ status: 409, json: { error: "not_requested" } });
    expect(await rowOf(agent.id, w.id)).toMatchObject({ state: "ended", end_reason: "expired", basis: null });
    // The late asker may ask again: a new request, not a cooldown.
    expect(await add(w, agent.id)).toMatchObject({ status: 202, json: { state: "requested" } });
    // Declining a late one is the same refusal.
    const x = await signUp(app, "expx");
    await add(x, agent.id);
    await ageRow(agent.id, x.id, 7 * DAY + 1000);
    expect(await decline(owner, agent.id, x)).toMatchObject({ status: 409, json: { error: "not_requested" } });
    expect((await rowOf(agent.id, x.id))!.end_reason).toBe("expired");
    // And an add over a late request starts again (the old one expires in the add).
    const y = await signUp(app, "expy");
    await add(y, agent.id);
    await ageRow(agent.id, y.id, 8 * DAY);
    const again = await add(y, agent.id);
    expect(again).toMatchObject({ status: 202, json: { state: "requested" } });
    expect(Date.parse(again.json.until)).toBeGreaterThan(Date.now() + 6 * DAY);
  });
});

describe("decline, the cooldown, and a stop", () => {
  it("a decline ends the row declined for thirty days, for every subject of that person on that Agent", async () => {
    const { owner, agent } = await world("dec");
    const v = await signUp(app, "decvisitor");
    await add(v, agent.id);
    expect(await decline(owner, agent.id, v)).toMatchObject({ status: 200, json: { ok: true } });
    const row = (await rowOf(agent.id, v.id))!;
    expect([row.state, row.end_reason, row.basis]).toEqual(["ended", "declined", null]);
    expect(row.until!.getTime() - Date.now()).toBeGreaterThan(30 * DAY - 60_000);
    expect(await decline(owner, agent.id, v)).toMatchObject({ status: 409, json: { error: "not_requested" } });
    expect(await add(v, agent.id)).toMatchObject({ status: 429, json: { error: "cooldown", availableAt: row.until!.toISOString() } });
    // The person's Agent is held to it as well.
    const vAgent = await agentOf(v.id);
    expect(await direct(vAgent, agent.id)).toEqual({ refused: "cooldown", availableAt: row.until });
    // Past the thirtieth day: a request again.
    await ageRow(agent.id, v.id, 30 * DAY - 1000);
    expect((await add(v, agent.id)).status).toBe(429);
    await ageRow(agent.id, v.id, 2000);
    expect(await add(v, agent.id)).toMatchObject({ status: 202, json: { state: "requested" } });
    // Someone else is not held to it.
    const w = await signUp(app, "decw");
    expect((await add(w, agent.id)).status).toBe(202);
    // Another Agent of the same owner is not held either.
    const other = (await mustCreateAgent(app, owner, { handle: "decother" })) as MadeAgent;
    const x = await signUp(app, "decx");
    await add(x, agent.id);
    await decline(owner, agent.id, x);
    expect((await add(x, other.id)).status).toBe(202);
  });

  it("a stop holds the stopped person off for thirty days, never their Agents, and the bar stays", async () => {
    const { owner, agent } = await world("stp");
    await policy(agent.id, "contacts");
    const w = await signUp(app, "stpw");
    await befriend(app, owner, w);
    const wAgent = await agentOf(w.id);
    await stop(owner.id, w.id);
    const barSince = (await db.query<{ since: Date }>(`select since from access_bars`)).rows[0]!.since;
    // The bar says no to a direct let-in: a friend of a contacts Agent asks instead; and the stopped person is held off.
    expect(await add(w, agent.id)).toMatchObject({ status: 429, json: { error: "cooldown", availableAt: iso(barSince.getTime() + 30 * DAY) } });
    expect(await direct(wAgent, agent.id)).toMatchObject({ state: "requested" });
    await ageBar(owner.id, w.id, 31 * DAY);
    expect(await add(w, agent.id)).toMatchObject({ status: 202, json: { state: "requested" } });
    expect(await direct(wAgent, agent.id)).toMatchObject({ state: "requested" });
    expect((await db.query(`select count(*)::int n from access_bars`)).rows[0]!.n).toBe(1);
    // A bar W set against the owner, or a block's, holds nobody off; it still makes an add a request, never a let-in.
    await db.query(`delete from access_bars`);
    await db.query(`delete from agent_contacts`);
    await stop(owner.id, w.id, { by: w.id });
    expect(await add(w, agent.id)).toMatchObject({ status: 202 });
    await db.query(`delete from access_bars`);
    await db.query(`delete from agent_contacts`);
    await stop(owner.id, w.id, { block: true });
    expect(await add(w, agent.id)).toMatchObject({ status: 202 });
  });

  it("after a bar an approval lets in again, and only from that moment (the approved row is newer than the bar)", async () => {
    const { owner, agent } = await world("bar");
    const v = await signUp(app, "barvisitor");
    await stop(owner.id, v.id, { by: v.id });
    expect(await add(v, agent.id)).toMatchObject({ status: 202 });
    expect(await reach(db, v.id, agent.id, "social", on)).toBe("barred");
    expect((await approve(owner, agent.id, v)).status).toBe(200);
    expect(await reach(db, v.id, agent.id, "social", on)).toBe("ok");
    expect((await db.query(`select count(*)::int n from access_bars`)).rows[0]!.n).toBe(1);
  });

  it("a row ended narrowed, removed or barred makes the next add a request, even for a friend of a contacts Agent", async () => {
    const { owner, agent } = await world("nar");
    await policy(agent.id, "contacts");
    for (const reason of ["narrowed", "removed", "barred"]) {
      const v = await signUp(app, `nar${reason}`);
      await befriend(app, owner, v);
      await db.query(`insert into agent_contacts (agent_id, subject_id, person_id, state, end_reason) values ($1, $2, $2, 'ended', $3)`, [agent.id, v.id, reason]);
      expect([reason, (await add(v, agent.id)).json.state]).toEqual([reason, "requested"]);
    }
    // A row that ended by the person leaving follows the policy again.
    const w = await signUp(app, "narleft");
    await befriend(app, owner, w);
    await db.query(`insert into agent_contacts (agent_id, subject_id, person_id, state, end_reason) values ($1, $2, $2, 'ended', 'left')`, [agent.id, w.id]);
    expect((await add(w, agent.id)).json.state).toBe("live");
  });
});

describe("remove and leave", () => {
  it("the owner removes (removed), the visitor leaves (left); each is refused for anyone else; neither touches a bar", async () => {
    const { owner, agent } = await world("rem");
    const a = await signUp(app, "rema");
    const b = await signUp(app, "remb");
    const stranger = await signUp(app, "remstr");
    for (const v of [a, b]) {
      await add(v, agent.id);
      await approve(owner, agent.id, v);
    }
    expect((await remove(stranger, agent.id, a)).status).toBe(404);
    expect((await remove(a, agent.id, b)).status).toBe(404);
    expect(await remove(owner, agent.id, a)).toMatchObject({ status: 200, json: { ok: true } });
    expect(await rowOf(agent.id, a.id)).toMatchObject({ state: "ended", end_reason: "removed", basis: null });
    expect(await reach(db, a.id, agent.id, "social", on)).toBe("barred");
    expect(await remove(b, agent.id, b)).toMatchObject({ status: 200 });
    expect(await rowOf(agent.id, b.id)).toMatchObject({ state: "ended", end_reason: "left" });
    expect(await reach(db, b.id, agent.id, "social", on)).toBe("no_access");
    // An ended row cannot be ended again; the same answer as a row that never was.
    expect((await remove(owner, agent.id, a)).status).toBe(404);
    expect((await remove(owner, agent.id, stranger)).status).toBe(404);
    expect((await db.query(`select count(*)::int n from access_bars`)).rows[0]!.n).toBe(0);
    // Back in: the removed asks and waits; the one who left follows the policy (ask: a request).
    expect(await add(a, agent.id)).toMatchObject({ status: 202 });
    expect(await add(b, agent.id)).toMatchObject({ status: 202 });
    // The conversation stays and is reused by an approval.
    const first = (await db.query(`select conversation_id from social_pairs`)).rowCount;
    expect((await approve(owner, agent.id, a)).status).toBe(200);
    expect((await db.query(`select conversation_id from social_pairs`)).rowCount).toBe(first);
  });

  it("a visitor may withdraw a waiting request (left), the owner may not remove one (decline it)", async () => {
    const { owner, agent } = await world("wd");
    const v = await signUp(app, "wdvisitor");
    await add(v, agent.id);
    expect((await remove(owner, agent.id, v)).status).toBe(404);
    expect((await remove(v, agent.id, v)).status).toBe(200);
    expect(await rowOf(agent.id, v.id)).toMatchObject({ state: "ended", end_reason: "left" });
  });

  it("approve and decline are the owner's: for anyone else the answer is an unknown Agent's", async () => {
    const { owner, agent } = await world("own2");
    const v = await signUp(app, "own2v");
    await add(v, agent.id);
    const unknown = await approve(v, "00000000-0000-4000-8000-000000000000", v);
    for (const r of [await approve(v, agent.id, v), await decline(v, agent.id, v), await approve(owner, "00000000-0000-4000-8000-000000000000", v)]) {
      expect([r.status, r.json]).toEqual([unknown.status, unknown.json]);
    }
    expect((await rowOf(agent.id, v.id))!.state).toBe("requested");
    // A deleted Agent cannot be approved for.
    await db.query(`update agents set deleted_at = now() where principal_id = $1`, [agent.id]);
    expect((await approve(owner, agent.id, v)).status).toBe(404);
  });
});

describe("the lists", () => {
  it("the visitor's list is 105 rows, newest first, and says declined or ended, never why", async () => {
    const v = await person();
    const owner = await person();
    const states: Array<(agentId: string, at: Date) => Promise<void>> = [
      (a, at) => db.query(`insert into agent_contacts (agent_id, subject_id, person_id, state, until, since) values ($1, $2, $2, 'requested', now() + interval '1 day', $3)`, [a, v.id, at]).then(() => {}),
      (a, at) => db.query(`insert into agent_contacts (agent_id, subject_id, person_id, state, basis, since) values ($1, $2, $2, 'live', 'approved', $3)`, [a, v.id, at]).then(() => {}),
      (a, at) => db.query(`insert into agent_contacts (agent_id, subject_id, person_id, state, end_reason, until, since) values ($1, $2, $2, 'ended', 'declined', now() + interval '1 day', $3)`, [a, v.id, at]).then(() => {}),
      (a, at) => db.query(`insert into agent_contacts (agent_id, subject_id, person_id, state, end_reason, since) values ($1, $2, $2, 'ended', 'removed', $3)`, [a, v.id, at]).then(() => {}),
      (a, at) => db.query(`insert into agent_contacts (agent_id, subject_id, person_id, state, end_reason, since) values ($1, $2, $2, 'ended', 'narrowed', $3)`, [a, v.id, at]).then(() => {}),
      (a, at) => db.query(`insert into agent_contacts (agent_id, subject_id, person_id, state, until, since) values ($1, $2, $2, 'requested', now() - interval '1 day', $3)`, [a, v.id, at]).then(() => {}),
    ];
    const t0 = Date.parse("2026-02-01T00:00:00Z");
    const want: Array<{ agentId: string; state: string; ended: string | null }> = [];
    for (let i = 0; i < 105; i++) {
      const agentId = await agentOf(owner.id);
      await states[i % states.length]!(agentId, new Date(t0 + i * 1000));
      // A request past its end shows as ended, the way a read for a decision would leave it.
      const shape = [
        { state: "requested", ended: null },
        { state: "live", ended: null },
        { state: "ended", ended: "declined" },
        { state: "ended", ended: "ended" },
        { state: "ended", ended: "ended" },
        { state: "ended", ended: "ended" },
      ][i % states.length]!;
      want.push({ agentId, ...shape });
    }
    const actor = await signUp(app, "listvisitor");
    // The visitor is `actor`; re-point the rows to them.
    await db.query(`update agent_contacts set subject_id = $1, person_id = $1 where subject_id = $2`, [actor.id, v.id]);
    const res = await api(app, actor, "GET", "/api/agent-contacts");
    expect(res.status).toBe(200);
    const mine = res.json.mine as Array<{ agentId: string; state: string; ended: string | null; since: string; until: string | null; conversationId: string | null }>;
    expect(mine).toHaveLength(105);
    expect(mine.map((r) => r.agentId)).toEqual(want.map((w) => w.agentId).reverse());
    expect(mine.map((r) => ({ agentId: r.agentId, state: r.state, ended: r.ended })).reverse()).toEqual(want);
    for (const r of mine) expect(Object.keys(r).sort()).toEqual(["agentId", "conversationId", "ended", "since", "state", "until"]);
    expect(res.json.waiting).toEqual([]);
    // Nothing of why: no key of the owner's, and the strings `removed` and `narrowed` are nowhere.
    const text = JSON.stringify(res.json);
    for (const s of ["removed", "narrowed", "expired", "endReason", "end_reason", "left"]) expect([s, text.includes(`"${s}"`)]).toEqual([s, false]);
  });

  it("the owner's list is the waiting requests on their Agents, 105 across 12 Agents, newest first, and no one else's", async () => {
    const owner = await signUp(app, "wlowner");
    const agents: MadeAgent[] = [];
    for (let i = 0; i < 12; i++) agents.push((await mustCreateAgent(app, owner, { handle: `wl${i}bot` })) as MadeAgent);
    const t0 = Date.parse("2026-02-01T00:00:00Z");
    const want: Array<{ agentId: string; subject: string }> = [];
    for (let i = 0; i < 105; i++) {
      const p = await person();
      const agentId = agents[i % 12]!.id;
      await db.query(`insert into agent_contacts (agent_id, subject_id, person_id, state, until, since) values ($1, $2, $2, 'requested', now() + interval '1 day', $3)`, [agentId, p.id, new Date(t0 + i * 1000)]);
      want.push({ agentId, subject: p.id });
    }
    // Rows that do not wait: a live one, an ended one, an expired request.
    const noise = await person();
    await db.query(`insert into agent_contacts (agent_id, subject_id, person_id, state, basis) values ($1, $2, $2, 'live', 'approved')`, [agents[0]!.id, noise.id]);
    const stranger = await signUp(app, "wlstranger");
    expect((await api(app, stranger, "GET", "/api/agent-contacts")).json).toEqual({ mine: [], waiting: [] });
    const res = await api(app, owner, "GET", "/api/agent-contacts");
    const waiting = res.json.waiting as Array<{ agentId: string; subject: { id: string; handle: string; displayName: string; avatarVersion: number; kind: string }; since: string; until: string }>;
    expect(waiting).toHaveLength(105);
    expect(waiting.map((w) => ({ agentId: w.agentId, subject: w.subject.id }))).toEqual(want.reverse());
    expect(Object.keys(waiting[0]!.subject).sort()).toEqual(["avatarVersion", "displayName", "handle", "id", "kind"]);
    expect(waiting[0]!.subject.kind).toBe("human");
    expect(res.json.mine).toEqual([]);
  });

  it("nothing owner-only is in the visitor's list, whatever the Agent's state", async () => {
    const { owner, agent } = await world("lk");
    const v = await signUp(app, "lkvisitor");
    await add(v, agent.id);
    await approve(owner, agent.id, v);
    await remove(owner, agent.id, v);
    const text = readFileSync(new URL("./agents-co-members.test.ts", import.meta.url), "utf8");
    const keys = [...(/const HIDDEN_KEYS = \[([\s\S]*?)\n\];/.exec(text)?.[1] ?? "").matchAll(/"([A-Za-z_]+)"/g)].map((m) => m[1]!);
    const body = (await api(app, v, "GET", "/api/agent-contacts")).json;
    const seen = new Set<string>();
    const walk = (x: unknown): void => {
      if (Array.isArray(x)) x.forEach(walk);
      else if (x && typeof x === "object") for (const [k, y] of Object.entries(x)) (seen.add(k), walk(y));
    };
    walk(body);
    // `agentId` is the one key of the list that is also an owner-only name elsewhere: it names the Agent they asked, which they know.
    expect(keys.filter((k) => seen.has(k) && k !== "agentId")).toEqual([]);
  });
});

describe("races", () => {
  it("an add that waits behind a narrowing sees the narrowing: no row the new policy would not create", async () => {
    const { agent } = await world("race");
    const v = await signUp(app, "racevisitor");
    // The narrowing holds the Agent's row, as `applyPolicy` does, and changes the policy at its end.
    const narrowing = holdThen(db, ["select 1 from agents where principal_id = $1 for update", [agent.id]], ["update agents set contact_policy = 'none' where principal_id = $1", [agent.id]]);
    await narrowing.locked;
    const adding = add(v, agent.id);
    await someoneWaits(db, ["%from agents%for update%"]);
    narrowing.release();
    await narrowing.done;
    const res = await adding;
    expect(res.status).toBe(404);
    expect((await db.query(`select count(*)::int n from agent_contacts where agent_id = $1`, [agent.id])).rows[0]!.n).toBe(0);
  });

  it("two adds of one pair at once make one conversation, one row", async () => {
    const { owner, agent } = await world("twin");
    await policy(agent.id, "contacts");
    const v = await signUp(app, "twinvisitor");
    await befriend(app, owner, v);
    const [a, b] = await Promise.all([add(v, agent.id), add(v, agent.id)]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.json.conversationId).toBe(b.json.conversationId);
    expect((await db.query(`select count(*)::int n from social_pairs`)).rows[0]!.n).toBe(1);
    expect((await db.query(`select count(*)::int n from agent_contacts`)).rows[0]!.n).toBe(1);
    expect((await db.query(`select count(*)::int n from messages where kind = 'system'`)).rows.length).toBe(1);
  });
});

describe("announcing", () => {
  it("an add tells both sides to refetch, and a let-in publishes the new conversation to the owner", async () => {
    const { owner, agent } = await world("ann");
    const v = await signUp(app, "annvisitor");
    const told: string[][] = [];
    const off = app.deps.social.on((ids) => void told.push([...ids]));
    try {
      await add(v, agent.id);
      expect(told.some((ids) => ids.includes(v.id) && ids.includes(owner.id))).toBe(true);
      told.length = 0;
      await approve(owner, agent.id, v);
      expect(told.some((ids) => ids.includes(v.id) && ids.includes(owner.id))).toBe(true);
      told.length = 0;
      await remove(owner, agent.id, v);
      expect(told.some((ids) => ids.includes(v.id) && ids.includes(owner.id))).toBe(true);
    } finally {
      off();
    }
  });
});
