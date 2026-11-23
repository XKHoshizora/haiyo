import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { addContact, liftBar, liftBlockBar, setBar } from "../src/social/agent-contacts.ts";
import { reach } from "../src/social/reach.ts";
import { api, befriend, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { someoneWaits } from "./helpers/locks.ts";
import { SOCIAL_ON, seedSocial } from "./helpers/social.ts";

// Plan A5b (design §1.2, §8 test 6; Controller ruling 2026-11-24 (Q4)): bars: 停止往来 and 恢复往来, unfriending, and every block
// of a person by a person, through ONE writer (`setBar`) in the block's own transaction; the setter's unblock lifts only the bar
// that block set, or hands it to the other person's block if theirs still stands.
const { app, db } = useApp({ env: SITE_ENV, config: SOCIAL_ON, agentWorker: false });
const on = { social: { enabled: true } } as const;
const DAY = 86_400_000;

interface MadeAgent {
  id: string;
  conversationId: string;
}
let n = 0;
async function person(): Promise<Actor> {
  const h = `br${++n}_${Math.random().toString(36).slice(2, 6)}`;
  await db.query(`insert into "user" (id, name, email, "emailVerified") values ($1::text, $1::text, $1::text || '@example.test', true)`, [`auth-${h}`]);
  const { rows } = await db.query<{ id: string }>(`insert into principals (kind, handle, display_name, auth_user_id) values ('human', $1::citext, $1::text, 'auth-' || $1::text) returning id`, [h]);
  return { id: rows[0]!.id, handle: h } as Actor;
}
async function agentOf(owner: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(`insert into principals (kind, handle, display_name, owner_id) values ('agent', $1::citext, $1::text, $2) returning id`, [`bg${++n}_${Math.random().toString(36).slice(2, 6)}`, owner]);
  await db.query(`insert into agents (principal_id) values ($1)`, [rows[0]!.id]);
  return rows[0]!.id;
}
async function newAgent(owner: Actor, handle: string): Promise<MadeAgent> {
  return (await mustCreateAgent(app, owner, { handle })) as MadeAgent;
}
const add = (who: Actor, agentId: string) => api(app, who, "POST", "/api/agent-contacts", { agentId });
const approve = (owner: Actor, agentId: string, subject: Actor | string) => api(app, owner, "POST", `/api/agent-contacts/${agentId}/${typeof subject === "string" ? subject : subject.id}/approve`);
const stop = (by: Actor, other: Actor | string) => api(app, by, "PUT", `/api/bars/${typeof other === "string" ? other : other.id}`);
const resume = (by: Actor, other: Actor | string) => api(app, by, "DELETE", `/api/bars/${typeof other === "string" ? other : other.id}`);
const block = (by: Actor, other: Actor | string) => api(app, by, "PUT", `/api/blocks/${typeof other === "string" ? other : other.id}`);
const unblock = (by: Actor, other: Actor | string) => api(app, by, "DELETE", `/api/blocks/${typeof other === "string" ? other : other.id}`);
const unfriend = (by: Actor, other: Actor) => api(app, by, "DELETE", `/api/friends/${other.id}`);
const direct = (subjectId: string, agentId: string) => db.tx((t) => addContact(t, app.deps.config, subjectId, agentId));
const policy = (agentId: string, p: "ask" | "contacts" | "none") => db.query(`update agents set contact_policy = $2 where principal_id = $1`, [agentId, p]);
const rowState = async (agentId: string, subjectId: string) => {
  const r = (await db.query(`select state, end_reason from agent_contacts where agent_id = $1 and subject_id = $2`, [agentId, subjectId])).rows[0] as { state: string; end_reason: string | null } | undefined;
  return r ? { state: r.state, endReason: r.end_reason } : null;
};
const barOf = async (a: Actor | string, b: Actor | string) => {
  const [lo, hi] = [typeof a === "string" ? a : a.id, typeof b === "string" ? b : b.id].sort();
  return ((await db.query(`select reason, set_by, by_block, since from access_bars where lo_id = $1 and hi_id = $2`, [lo, hi])).rows[0] as { reason: string; set_by: string; by_block: boolean; since: Date } | undefined) ?? null;
};
const bars = async (a: Actor | string, b: Actor | string) => {
  const bar = await barOf(a, b);
  return bar ? [bar] : [];
};
const ageBar = (a: string, b: string, ms: number) => {
  const [lo, hi] = [a, b].sort();
  return db.query(`update access_bars set since = since - $3 * interval '1 millisecond' where lo_id = $1 and hi_id = $2`, [lo, hi, ms]);
};
const idOf = (x: Actor | string) => (typeof x === "string" ? x : x.id);
const blocksBetween = async (a: Actor | string, b: Actor | string) =>
  (await db.query<{ blocker_id: string }>(`select blocker_id from blocks where (blocker_id = $1 and blocked_id = $2) or (blocker_id = $2 and blocked_id = $1) order by blocker_id`, [idOf(a), idOf(b)])).rows.map((r) => r.blocker_id);
async function newGroup(creator: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(`insert into conversations (type, creator_id, title) values ('group', $1, 'g') returning id`, [creator]);
  return rows[0]!.id;
}
async function queuedRun(agentId: string, conversationId: string, callerId: string, status: "queued" | "running" = "queued"): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, pending_seq, triggered_by, lane, caller_id, started_at)
     values ('reply', $1, $2, (select owner_id from principals where id = $2), $4, 0, 5, 'human', 'others', $3, case when $4 = 'running' then now() end) returning id`,
    [conversationId, agentId, callerId, status],
  );
  return rows[0]!.id;
}
const runOf = async (id: string) => (await db.query(`select status, error, interrupted, pending_seq from agent_runs where id = $1`, [id])).rows[0] as { status: string; error: string | null; interrupted: string | null; pending_seq: string | null };

describe("停止往来 and 恢复往来 (design test 6)", () => {
  it("a stop ends every row between the two sides; one approved request of the person's Agent passes exactly that row; the bar stays; only the setter lifts it", async () => {
    const owner = await signUp(app, "stpowner");
    const v = await signUp(app, "stpv");
    const y1 = await newAgent(owner, "stpy1");
    const y2 = await newAgent(owner, "stpy2");
    await policy(y2.id, "contacts");
    await befriend(app, owner, v);
    const va = await agentOf(v.id);
    // V is let in to Y1 (approved) and has a waiting request on Y3.
    await add(v, y1.id);
    await approve(owner, y1.id, v);
    const y3 = await newAgent(owner, "stpy3");
    await add(v, y3.id);
    expect(await rowState(y1.id, v.id)).toEqual({ state: "live", endReason: null });
    expect(await stop(owner, v)).toMatchObject({ status: 200, json: { ok: true, ended: 2 } });
    expect(await rowState(y1.id, v.id)).toEqual({ state: "ended", endReason: "barred" });
    expect(await rowState(y3.id, v.id)).toEqual({ state: "ended", endReason: "barred" });
    expect(await barOf(owner, v)).toMatchObject({ reason: "stopped", set_by: owner.id, by_block: false });
    // V's Agent VA asks Y1 through addContact directly (the route takes only the caller): a request, not a cooldown (I11); approved, it passes.
    expect(await direct(va, y1.id)).toMatchObject({ state: "requested" });
    expect((await approve(owner, y1.id, va)).status).toBe(200);
    expect(await reach(db, va, y1.id, "social", on)).toBe("ok");
    expect(await bars(owner, v)).toHaveLength(1);
    // V itself: the stop's cooldown; after it a request, never live under contacts; and so for an Agent made later.
    expect(await add(v, y2.id)).toMatchObject({ status: 429 });
    await ageBar(owner.id, v.id, 31 * DAY);
    expect(await add(v, y2.id)).toMatchObject({ status: 202 });
    const y4 = await newAgent(owner, "stpy4");
    await policy(y4.id, "contacts");
    expect(await add(v, y4.id)).toMatchObject({ status: 202 });
    // The owner as a subject of V's Agent, approved by V: the bar is not touched.
    expect(await direct(owner.id, va)).toMatchObject({ state: "requested" });
    expect((await approve(v, va, owner)).status).toBe(200);
    expect(await bars(owner, v)).toHaveLength(1);
    // Only the setter lifts it; and lifting brings no row back.
    expect((await resume(v, owner)).status).toBe(404);
    expect((await resume(owner, v)).status).toBe(200);
    expect(await bars(owner, v)).toEqual([]);
    expect(await rowState(y1.id, v.id)).toEqual({ state: "ended", endReason: "barred" });
    expect((await resume(owner, v)).status).toBe(404);
  });

  it("an approval racing a bar ends not_requested: the bar's transaction holds the pair", async () => {
    const owner = await signUp(app, "rcbowner");
    const v = await signUp(app, "rcbv");
    const y = await newAgent(owner, "rcby");
    await add(v, y.id);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const isStarted = new Promise<void>((r) => (started = r));
    const stopping = db.tx(async (t) => {
      await setBar(t, owner.id, v.id, "stopped", "stop");
      started();
      await gate;
    });
    await isStarted;
    const approving = approve(owner, y.id, v);
    await someoneWaits(db, ["%pg_advisory_xact_lock%"]);
    release();
    await stopping;
    expect(await approving).toMatchObject({ status: 409, json: { error: "not_requested" } });
    expect(await rowState(y.id, v.id)).toEqual({ state: "ended", endReason: "barred" });
  });

  it("the person themself, and no one else, is refused: an unknown person 404, an Agent 404, oneself 400, and a bar twice is the same answer", async () => {
    const a = await signUp(app, "rfa");
    const b = await signUp(app, "rfb");
    const agent = await newAgent(b, "rfbot");
    expect((await stop(a, a)).status).toBe(400);
    expect((await stop(a, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await stop(a, agent.id)).status).toBe(404);
    expect((await stop(a, b)).json).toEqual({ ok: true, ended: 0 });
    expect((await stop(a, b)).json).toEqual({ ok: true, ended: 0 });
    expect(await bars(a, b)).toHaveLength(1);
    expect((await resume(a, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await resume(a, agent.id)).status).toBe(404);
  });

  it("a bar, and an owner's block of the person, each end the person's live rows and interrupt their runs, after the direct chat's notice", async () => {
    for (const how of ["bar", "block"] as const) {
      const owner = await signUp(app, `${how}owner`);
      const v = await signUp(app, `${how}v`);
      await befriend(app, owner, v);
      const y = await newAgent(owner, `${how}y`);
      const { conversationId: s } = await seedSocial(app, { owner, agentId: y.id, visitor: v });
      const g = await newGroup(v.id);
      const running = await queuedRun(y.id, s, v.id, "running");
      const queued = await queuedRun(y.id, g, v.id, "queued");
      if (how === "bar") expect((await stop(owner, v)).status).toBe(200);
      else expect((await block(owner, v)).status).toBe(200);
      expect(await rowState(y.id, v.id)).toEqual({ state: "ended", endReason: "barred" });
      expect(await runOf(running)).toMatchObject({ status: "running", interrupted: "access_ended", pending_seq: null });
      // A stop ends the group reply the person called too; a block leaves that to the check a group's reply meets as it begins
      // (agents-block-recheck.test.ts): the reply answers several calls, and the owner's own may be folded into it.
      if (how === "bar") expect(await runOf(queued)).toMatchObject({ status: "cancelled", error: "access_ended" });
      else expect(await runOf(queued)).toMatchObject({ status: "queued", error: null, interrupted: null });
      // The bar is there.
      expect(await barOf(owner, v)).not.toBeNull();
    }
  });

  it("both write a bar: the stricter reason stays; a later stop by the other takes the bar", async () => {
    const a = await person();
    const b = await person();
    const c = await person();
    const d = await person();
    // Unfriended, then stopped: stopped. Stopped, then unfriended: stopped.
    await db.tx((t) => setBar(t, a.id, b.id, "unfriended", "unfriend"));
    expect(await barOf(a, b)).toMatchObject({ reason: "unfriended", set_by: a.id, by_block: false });
    await db.tx((t) => setBar(t, a.id, b.id, "stopped", "stop"));
    expect(await barOf(a, b)).toMatchObject({ reason: "stopped", set_by: a.id, by_block: false });
    await db.tx((t) => setBar(t, a.id, b.id, "unfriended", "unfriend"));
    expect(await barOf(a, b)).toMatchObject({ reason: "stopped", set_by: a.id });
    // `since` moves on every write.
    const before = (await barOf(a, b))!.since;
    await db.tx((t) => setBar(t, a.id, b.id, "stopped", "stop"));
    expect((await barOf(a, b))!.since.getTime()).toBeGreaterThan(before.getTime());
    // A stop by the other person takes the bar's setter (the write sets stopped).
    await db.tx((t) => setBar(t, c.id, d.id, "stopped", "stop"));
    await db.tx((t) => setBar(t, d.id, c.id, "stopped", "stop"));
    expect(await barOf(c, d)).toMatchObject({ reason: "stopped", set_by: d.id, by_block: false });
    expect(await db.tx((t) => liftBar(t, c.id, d.id))).toBe(false);
    expect(await db.tx((t) => liftBar(t, d.id, c.id))).toBe(true);
  });
});

describe("unfriending", () => {
  it("writes a bar only when it ends a live or waiting row; the direct chat's notice comes first", async () => {
    const owner = await signUp(app, "unfowner");
    const withRow = await signUp(app, "unfrow");
    const withRequest = await signUp(app, "unfreq");
    const noRow = await signUp(app, "unfno");
    const y = await newAgent(owner, "unfy");
    for (const f of [withRow, withRequest, noRow]) await befriend(app, owner, f);
    await add(withRow, y.id);
    await approve(owner, y.id, withRow);
    await add(withRequest, y.id);
    const { conversationId: s } = await seedSocial(app, { owner, agentId: y.id, visitor: await person() });
    const g = await newGroup(withRow.id);
    const queued = await queuedRun(y.id, g, withRow.id);
    expect((await unfriend(owner, withRow)).status).toBe(200);
    expect(await rowState(y.id, withRow.id)).toEqual({ state: "ended", endReason: "barred" });
    expect(await barOf(owner, withRow)).toMatchObject({ reason: "unfriended", set_by: owner.id, by_block: false });
    expect(await runOf(queued)).toMatchObject({ status: "cancelled", error: "access_ended" });
    // A waiting request counts as a row.
    expect((await unfriend(owner, withRequest)).status).toBe(200);
    expect(await rowState(y.id, withRequest.id)).toEqual({ state: "ended", endReason: "barred" });
    // No row: no bar.
    expect((await unfriend(owner, noRow)).status).toBe(200);
    expect(await bars(owner, noRow)).toEqual([]);
    // The other side's Agents count too: the friend's own Agent has a row on the owner's... the owner is the person of a row on the friend's Agent.
    const f2 = await signUp(app, "unff2");
    const fAgent = await newAgent(f2, "unff2bot");
    await befriend(app, owner, f2);
    await add(owner, fAgent.id);
    await approve(f2, fAgent.id, owner);
    expect((await unfriend(f2, owner)).status).toBe(200);
    expect(await rowState(fAgent.id, owner.id)).toEqual({ state: "ended", endReason: "barred" });
    expect(await barOf(owner, f2)).toMatchObject({ reason: "unfriended", set_by: f2.id });
    expect(s).toBeTruthy();
  });
});

describe("blocks (Controller ruling Q4)", () => {
  it("every person-to-person block writes the bar; the setter's unblock lifts only that bar", async () => {
    const o2 = await signUp(app, "q4o2");
    const w = await signUp(app, "q4w");
    await block(o2, w);
    expect(await barOf(o2, w)).toMatchObject({ reason: "stopped", set_by: o2.id, by_block: true });
    // Blocking again changes nothing.
    const first = (await barOf(o2, w))!.since;
    await block(o2, w);
    expect((await barOf(o2, w))!.since).toEqual(first);
    await unblock(o2, w);
    expect(await barOf(o2, w)).toBeNull();
    // Both block; the first unblocks: the bar is the other's block's now; the second unblocks: it is gone.
    await block(o2, w);
    await block(w, o2);
    expect(await barOf(o2, w)).toMatchObject({ set_by: o2.id, by_block: true });
    await unblock(o2, w);
    expect(await barOf(o2, w)).toMatchObject({ set_by: w.id, by_block: true });
    await unblock(w, o2);
    expect(await barOf(o2, w)).toBeNull();
    // Both block; the second unblocks first: the bar stays the first's.
    await block(o2, w);
    await block(w, o2);
    await unblock(w, o2);
    expect(await barOf(o2, w)).toMatchObject({ set_by: o2.id, by_block: true });
    await unblock(o2, w);
    expect(await barOf(o2, w)).toBeNull();
    // A stop, then a block, then the unblock: the stop's bar stays.
    await stop(o2, w);
    await block(o2, w);
    expect(await barOf(o2, w)).toMatchObject({ set_by: o2.id, by_block: false });
    await unblock(o2, w);
    expect(await barOf(o2, w)).toMatchObject({ by_block: false });
    // A block of an Agent writes no bar, and there is none to lift.
    const o4 = await signUp(app, "q4o4");
    const ownerOfY = await signUp(app, "q4yo");
    const y = await newAgent(ownerOfY, "q4y");
    expect((await block(o4, y.id)).status).toBe(200);
    expect((await db.query(`select count(*)::int n from access_bars where lo_id = $1 or hi_id = $1`, [o4.id])).rows[0]!.n).toBe(0);
    expect((await resume(o4, y.id)).status).toBe(404);
  });

  it("恢复往来 never lifts a block's bar; while a block stands under a stop, lifting the stop leaves the block's bar", async () => {
    const a = await signUp(app, "lbka");
    const b = await signUp(app, "lbkb");
    await block(a, b);
    expect((await resume(a, b)).status).toBe(404);
    expect(await barOf(a, b)).toMatchObject({ by_block: true });
    await unblock(a, b);
    // A stop under the setter's own block: lifting the stop keeps a bar for the block.
    await stop(a, b);
    await block(a, b);
    expect((await resume(a, b)).status).toBe(200);
    expect(await barOf(a, b)).toMatchObject({ set_by: a.id, by_block: true });
    await unblock(a, b);
    expect(await barOf(a, b)).toBeNull();
    // A stop under the other's block: lifting it passes the bar to that block.
    await stop(a, b);
    await block(b, a);
    expect(await barOf(a, b)).toMatchObject({ set_by: a.id, by_block: false });
    expect((await resume(a, b)).status).toBe(200);
    expect(await barOf(a, b)).toMatchObject({ set_by: b.id, by_block: true });
    await unblock(b, a);
    expect(await barOf(a, b)).toBeNull();
  });

  it("C1: a block that existed before 075 and is removed after it ran: its unblock lifts the bar the backfill gave it", async () => {
    const oldBlocker = await person();
    const oldBlocked = await person();
    await db.query(`insert into blocks (blocker_id, blocked_id, created_at) values ($1, $2, now() - interval '9 days')`, [oldBlocker.id, oldBlocked.id]);
    expect(await bars(oldBlocker, oldBlocked)).toEqual([]);
    const migration = readFileSync(new URL("../migrations/075_agent_social_access.sql", import.meta.url), "utf8");
    const backfill = /-- bars from blocks begin\n([\s\S]*?)-- bars from blocks end/.exec(migration)![1]!;
    // The migration's own statement, limited to this one block (the database holds other tests' blocks, which have their bars).
    expect(backfill).toContain("\n order by ");
    await db.query(backfill.replace("\n order by ", `\n where b.blocker_id = '${oldBlocker.id}'\n order by `));
    expect(await barOf(oldBlocker, oldBlocked)).toMatchObject({ set_by: oldBlocker.id, by_block: true });
    // The unblock through the one path (a person without a session: the function itself).
    const { unblockPrincipal } = await import("../src/social/blocks.ts");
    await db.tx((t) => unblockPrincipal(t, oldBlocker.id, oldBlocked.id));
    expect(await barOf(oldBlocker, oldBlocked)).toBeNull();
    expect(await blocksBetween(oldBlocker, oldBlocked)).toEqual([]);
  });

  it("a block ends the rows between the two and stops their runs, and unblocking brings no row back", async () => {
    const owner = await signUp(app, "bkrowner");
    const v = await signUp(app, "bkrv");
    const y = await newAgent(owner, "bkry");
    const { conversationId: s } = await seedSocial(app, { owner, agentId: y.id, visitor: v });
    const running = await queuedRun(y.id, s, v.id, "running");
    expect((await block(v, owner)).status).toBe(200);
    expect(await rowState(y.id, v.id)).toEqual({ state: "ended", endReason: "barred" });
    expect(await runOf(running)).toMatchObject({ interrupted: "access_ended", pending_seq: null });
    expect((await unblock(v, owner)).status).toBe(200);
    expect(await barOf(owner, v)).toBeNull();
    expect(await rowState(y.id, v.id)).toEqual({ state: "ended", endReason: "barred" });
    // Group @ is as it was: the pair has no bar and no block, so reach is ok again.
    expect(await reach(db, v.id, y.id, "group", on)).toBe("barred");
  });

  it("racing: block and unblock, both blocking each other: a bar stands exactly while a block of its setter does", async () => {
    const consistent = async (a: Actor, b: Actor): Promise<void> => {
      const blockers = await blocksBetween(a, b);
      const bar = await barOf(a, b);
      if (blockers.length === 0) expect(bar === null || !bar.by_block).toBe(true);
      else {
        expect(bar).not.toBeNull();
        expect(bar!.by_block).toBe(true);
        expect(blockers).toContain(bar!.set_by);
      }
    };
    for (let i = 0; i < 12; i++) {
      const a = await signUp(app, `rca${i}`);
      const b = await signUp(app, `rcb${i}`);
      await Promise.all([block(a, b), block(b, a)]);
      await consistent(a, b);
      expect(await blocksBetween(a, b)).toHaveLength(2);
      await Promise.all([unblock(a, b), block(a, b), unblock(b, a)]);
      await consistent(a, b);
      await Promise.all([unblock(a, b), unblock(b, a), block(b, a)]);
      await consistent(a, b);
      await Promise.all([unblock(a, b), unblock(b, a)]);
      await consistent(a, b);
    }
    // And a stop racing a block: the bar is there whichever wins, and it is the block's only if the block stood.
    const c = await signUp(app, "rcc");
    const d = await signUp(app, "rcd");
    await Promise.all([stop(c, d), block(c, d), unblock(c, d)]);
    expect(await barOf(c, d)).not.toBeNull();
  });
});
