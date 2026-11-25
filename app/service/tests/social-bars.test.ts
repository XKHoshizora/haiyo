import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { unfriend as unfriendIn } from "../src/social/friends.ts";
import { blockPrincipal, deleteBlock } from "../src/social/blocks.ts";
import { addContact, approveContact, contactsOfAgent, liftBar, setBar } from "../src/social/agent-contacts.ts";
import { reach, standingBarsSql, type Reach } from "../src/social/reach.ts";
import { api, befriend, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { someoneWaits } from "./helpers/locks.ts";
import { SOCIAL_ON, seedSocial } from "./helpers/social.ts";

// Plan A5b (design §1.2, §8 test 6; Controller ruling 2026-11-24 (Q4); A-3 review C1): bars are one row per decision: "the setter
// has barred the other", of kind `stop` or `block`. A pair is barred iff any row stands in either direction; each row is lifted only
// by its own setter through its own act, and nobody's act ever touches another person's row.
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
const idOf = (x: Actor | string) => (typeof x === "string" ? x : x.id);
const add = (who: Actor, agentId: string) => api(app, who, "POST", "/api/agent-contacts", { agentId });
const approve = (owner: Actor, agentId: string, subject: Actor | string) => api(app, owner, "POST", `/api/agent-contacts/${agentId}/${idOf(subject)}/approve`);
const stop = (by: Actor, other: Actor | string) => api(app, by, "PUT", `/api/bars/${idOf(other)}`);
const resume = (by: Actor, other: Actor | string) => api(app, by, "DELETE", `/api/bars/${idOf(other)}`);
const block = (by: Actor, other: Actor | string) => api(app, by, "PUT", `/api/blocks/${idOf(other)}`);
const unblock = (by: Actor, other: Actor | string) => api(app, by, "DELETE", `/api/blocks/${idOf(other)}`);
const unfriend = (by: Actor, other: Actor) => api(app, by, "DELETE", `/api/friends/${other.id}`);
const direct = (subjectId: string, agentId: string) => db.tx((t) => addContact(t, app.deps.config, subjectId, agentId));
const policy = (agentId: string, p: "ask" | "contacts" | "none") => db.query(`update agents set contact_policy = $2 where principal_id = $1`, [agentId, p]);
const rowState = async (agentId: string, subjectId: string) => {
  const r = (await db.query(`select state, end_reason from agent_contacts where agent_id = $1 and subject_id = $2`, [agentId, subjectId])).rows[0] as { state: string; end_reason: string | null } | undefined;
  return r ? { state: r.state, endReason: r.end_reason } : null;
};
/** Every bar row between two people, as "setter>other kind" with the people named by `names`, sorted. */
const barRows = async (a: Actor | string, b: Actor | string, names: Record<string, string> = {}): Promise<string[]> => {
  const { rows } = await db.query<{ setter_id: string; other_id: string; kind: string }>(
    `select setter_id, other_id, kind from access_bars where (setter_id = $1 and other_id = $2) or (setter_id = $2 and other_id = $1)`,
    [idOf(a), idOf(b)],
  );
  const name = (id: string) => names[id] ?? id;
  return rows.map((r) => `${name(r.setter_id)}>${name(r.other_id)} ${r.kind}`).sort();
};
const ageBar = (setter: string, other: string, ms: number) =>
  db.query(`update access_bars set since = since - $3 * interval '1 millisecond' where setter_id = $1 and other_id = $2`, [setter, other, ms]);
const blocksBetween = async (a: Actor | string, b: Actor | string) =>
  (await db.query<{ blocker_id: string }>(`select blocker_id from blocks where (blocker_id = $1 and blocked_id = $2) or (blocker_id = $2 and blocked_id = $1) order by blocker_id`, [idOf(a), idOf(b)])).rows.map((r) => r.blocker_id);
async function newGroup(creator: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(`insert into conversations (type, creator_id, title) values ('group', $1, 'g') returning id`, [creator]);
  return rows[0]!.id;
}
/** An active reply of the Agent; in a group the call is a real message by `callerId` (an ending decides a group reply by its calls). */
async function queuedRun(agentId: string, conversationId: string, callerId: string, status: "queued" | "running" = "queued"): Promise<string> {
  const group = (await db.query<{ type: string }>(`select type from conversations where id = $1`, [conversationId])).rows[0]!.type === "group";
  let call = 0;
  if (group) {
    call = Number(
      (await db.query<{ seq: string }>(
        `insert into messages (conversation_id, seq, sender_id, kind, body) select $1, coalesce(max(seq), 0) + 1, $2, 'text', '{"text":"hi"}'::jsonb from messages where conversation_id = $1 returning seq::text as seq`,
        [conversationId, callerId],
      )).rows[0]!.seq,
    );
  }
  const { rows } = await db.query<{ id: string }>(
    `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, call_seqs, pending_seq, triggered_by, lane, caller_id, started_at)
     values ('reply', $1, $2, (select owner_id from principals where id = $2), $4, $5, case when $6::boolean then array[$5::bigint] end, 5 + $5, 'human', 'others', $3, case when $4 = 'running' then now() end) returning id`,
    [conversationId, agentId, callerId, status, call, group],
  );
  return rows[0]!.id;
}
const runOf = async (id: string) => (await db.query(`select status, error, interrupted, pending_seq from agent_runs where id = $1`, [id])).rows[0] as { status: string; error: string | null; interrupted: string | null; pending_seq: string | null };

describe("停止往来 and 恢复往来 (design test 6)", () => {
  it("a stop ends every row between the two sides; no row passes it while it stands (an approval by the OTHER side is refused); only the setter lifts it", async () => {
    const owner = await signUp(app, "stpowner");
    const v = await signUp(app, "stpv");
    const y1 = await newAgent(owner, "stpy1");
    const y2 = await newAgent(owner, "stpy2");
    await policy(y2.id, "contacts");
    await befriend(app, owner, v);
    const va = await agentOf(v.id);
    await add(v, y1.id);
    await approve(owner, y1.id, v);
    const y3 = await newAgent(owner, "stpy3");
    await add(v, y3.id);
    expect(await rowState(y1.id, v.id)).toEqual({ state: "live", endReason: null });
    expect(await stop(owner, v)).toMatchObject({ status: 200, json: { ok: true, ended: 2 } });
    expect(await rowState(y1.id, v.id)).toEqual({ state: "ended", endReason: "barred" });
    expect(await rowState(y3.id, v.id)).toEqual({ state: "ended", endReason: "barred" });
    expect(await barRows(owner, v, { [owner.id]: "O", [v.id]: "V" })).toEqual(["O>V stop"]);
    // (An approval by the SETTER of someone they stopped lifts their stop: fix round 3, point 8, tests/social-ring1a.test.ts.)
    // V itself: the stop's cooldown; after it a request, never live under contacts; and so for an Agent made later.
    expect(await add(v, y2.id)).toMatchObject({ status: 429 });
    await ageBar(owner.id, v.id, 31 * DAY);
    expect(await add(v, y2.id)).toMatchObject({ status: 202 });
    const y4 = await newAgent(owner, "stpy4");
    await policy(y4.id, "contacts");
    expect(await add(v, y4.id)).toMatchObject({ status: 202 });
    // The owner as a subject of V's Agent, approved by V: the stop is the OWNER's, not V's to lift. V's approval lets nobody through
    // it and is answered as a request that is no longer there; the bar is not touched.
    expect(await direct(owner.id, va)).toMatchObject({ state: "requested" });
    expect((await approve(v, va, owner)).status).toBe(409);
    expect(await reach(db, owner.id, va, "social", on)).toBe("barred");
    expect(await barRows(owner, v)).toHaveLength(1);
    // Only the setter lifts it; and lifting brings no row back.
    expect((await resume(v, owner)).status).toBe(404);
    expect((await resume(owner, v)).status).toBe(200);
    expect(await barRows(owner, v)).toEqual([]);
    expect(await rowState(y1.id, v.id)).toEqual({ state: "ended", endReason: "removed" });
    expect((await resume(owner, v)).status).toBe(404);
  });

  it("V cannot undo O's stop by any sequence of the documented routes (C1): the stop stays, the cooldown stays, V stays out", async () => {
    const owner = await signUp(app, "c1owner");
    const v = await signUp(app, "c1v");
    const y1 = await newAgent(owner, "c1y1");
    const y4 = await newAgent(owner, "c1y4");
    await policy(y4.id, "contacts");
    await befriend(app, owner, v);
    await add(v, y1.id);
    await approve(owner, y1.id, v);
    expect((await stop(owner, v)).status).toBe(200);
    const O = { [owner.id]: "O", [v.id]: "V" };
    const standing = async (): Promise<void> => {
      expect(await barRows(owner, v, O)).toContain("O>V stop");
      expect(await reach(db, v.id, y4.id, "group", on)).not.toBe("ok");
      // The cooldown is O's own stop's: V's answer is it, unless V's own block makes the Agent no one V may find.
      expect(await add(v, y4.id)).toMatchObject({ status: (await blocksBetween(owner, v)).length === 0 ? 429 : 404 });
    };
    await standing();
    const sequence: Array<[string, () => Promise<{ status: number }>]> = [
      ["V stops O", () => stop(v, owner)],
      ["V resumes", () => resume(v, owner)],
      ["V resumes again", () => resume(v, owner)],
      ["V stops O again", () => stop(v, owner)],
      ["V blocks O", () => block(v, owner)],
      ["V unblocks O", () => unblock(v, owner)],
      ["V resumes", () => resume(v, owner)],
    ];
    for (const [what, act] of sequence) {
      await act();
      await standing();
      expect([what, await barRows(owner, v, O)]).toEqual([what, expect.arrayContaining(["O>V stop"])]);
    }
    // V's own stop and V's own block are V's rows, lifted by V alone: O's resume leaves V's.
    await stop(v, owner);
    expect(await barRows(owner, v, O)).toEqual(["O>V stop", "V>O stop"]);
    expect((await resume(owner, v)).status).toBe(200);
    expect(await barRows(owner, v, O)).toEqual(["V>O stop"]);
    expect(await reach(db, v.id, y4.id, "group", on)).toBe("barred");
    expect((await resume(owner, v)).status).toBe(404);
    expect((await resume(v, owner)).status).toBe(200);
    expect(await barRows(owner, v)).toEqual([]);
    expect(await reach(db, v.id, y4.id, "group", on)).toBe("ok");
  });

  it("both stopped: both must restore before the pair is reachable; a stop and a block of one person: the unblock leaves the stop", async () => {
    const a = await signUp(app, "bothA");
    const b = await signUp(app, "bothB");
    const y = await newAgent(a, "bothy");
    const N = { [a.id]: "A", [b.id]: "B" };
    await stop(a, b);
    await stop(b, a);
    expect(await barRows(a, b, N)).toEqual(["A>B stop", "B>A stop"]);
    await resume(a, b);
    expect(await reach(db, b.id, y.id, "group", on)).toBe("barred");
    await resume(b, a);
    expect(await reach(db, b.id, y.id, "group", on)).toBe("ok");
    await stop(a, b);
    await block(a, b);
    expect(await barRows(a, b, N)).toEqual(["A>B block", "A>B stop"]);
    await unblock(a, b);
    expect(await barRows(a, b, N)).toEqual(["A>B stop"]);
    await block(b, a);
    await resume(a, b);
    expect(await barRows(a, b, N)).toEqual(["B>A block"]);
    await unblock(b, a);
    expect(await barRows(a, b)).toEqual([]);
  });

  it("a row reads by whose bar ended it, whoever lifts last (A-4 review m4): lifting relabels only the lifter's own rows, and the other person's bar never changes a label", async () => {
    const a = await signUp(app, "m4a");
    const b = await signUp(app, "m4b");
    const ya = await newAgent(a, "m4ya");
    const vb = await agentOf(b.id);
    const live = (agentId: string, subjectId: string, personId: string) =>
      db.query(`insert into agent_contacts (agent_id, subject_id, person_id, state, basis) values ($1, $2, $3, 'live', 'approved') on conflict (agent_id, subject_id) do update set state = 'live', basis = 'approved', end_reason = null`, [agentId, subjectId, personId]);
    const read = async (subject: string) => ((await api(app, a, "GET", `/api/agents/${ya.id}/contacts`)).json.rows as Array<{ subject: { id: string }; endReason: string }>).find((r) => r.subject.id === subject)!.endReason;
    // B stops A first: the row of B's Agent on A's Agent ends by B's bar. A's own view of it: a person left.
    await live(ya.id, vb, b.id);
    expect((await stop(b, a)).status).toBe(200);
    expect(await read(vb)).toBe("left");
    // A, with B's stop standing, stops B: a live row of B itself ends by A's bar.
    await live(ya.id, b.id, b.id);
    expect((await stop(a, b)).status).toBe(200);
    expect(await read(b.id)).toBe("barred");
    expect(await read(vb)).toBe("left");
    // B lifts; nothing changes in A's view. A lifts: only A's own row is relabelled; B's bar's row stays a leaving for good.
    expect((await resume(b, a)).status).toBe(200);
    expect([await read(b.id), await read(vb)]).toEqual(["barred", "left"]);
    expect((await resume(a, b)).status).toBe(200);
    expect([await read(b.id), await read(vb)]).toEqual(["removed", "left"]);
    // The other order: A's bar ended a row, B stops, A lifts while B's stop stands, B lifts last: the label is the same.
    await live(ya.id, b.id, b.id);
    expect((await stop(a, b)).status).toBe(200);
    expect((await stop(b, a)).status).toBe(200);
    expect(await read(b.id)).toBe("barred");
    expect((await resume(a, b)).status).toBe(200);
    expect(await read(b.id)).toBe("removed");
    expect((await resume(b, a)).status).toBe(200);
    expect([await read(b.id), await read(vb)]).toEqual(["removed", "left"]);
  });

  /**
   * The model: six booleans (each person's stop, each person's block, each person's `block` bar row). An event changes only its
   * actor's own booleans. After every event the table's rows, each person's own row count and WHO IS BARRED (the standing bars,
   * and `reach` of each person to the other's Agent) follow the model.
   */
  type S = { stopA: boolean; stopB: boolean; blockA: boolean; blockB: boolean; rowA: boolean; rowB: boolean };
  const EVENTS = ["stopA", "stopB", "resumeA", "resumeB", "blockA", "blockB", "unblockA", "unblockB", "unfriendA", "unfriendB"] as const;
  async function runModel(states: S[], events: readonly (typeof EVENTS)[number][]): Promise<number> {
    // The dimension of A-4 review m4: each person's Agent has an ended row of the other person's Agent, ended `barred` by one of the
    // two. After every event each owner reads such a row as `barred` only while their own bar that ended it stands, as `removed` once
    // they lifted their last one, and as `left` for ever when the OTHER person's bar ended it, whoever lifts last.
    const A = await person();
    const B = await person();
    const YA = await agentOf(A.id);
    const YB = await agentOf(B.id);
    const N = { [A.id]: "A", [B.id]: "B" };
    const rowsOf = (s: S): string[] => [s.stopA && "A>B stop", s.stopB && "B>A stop", s.rowA && "A>B block", s.rowB && "B>A block"].filter((x): x is string => !!x).sort();
    const standing = (s: S) => s.stopA || s.stopB || (s.blockA && s.rowA) || (s.blockB && s.rowB);
    const standingNow = async () => ((await db.query(`select 1 from ${standingBarsSql("$1::uuid", "$2::uuid", "mb")}`, [A.id, B.id])).rowCount ?? 0) > 0;
    let cases = 0;
    for (const [si, s] of states.entries()) {
      for (const [ei, event] of events.entries()) {
        const key = event.endsWith("A") ? "A" : "B";
        const [who, other, whoAgent] = key === "A" ? [A, B, YA] : [B, A, YB];
        // The state, written as the code writes it (a lone block or a lone row only as an older process left it).
        await db.query(`delete from agent_contacts where agent_id = any($1::uuid[])`, [[YA, YB]]);
        await db.query(`delete from friendships where a_id = any($1::uuid[]) or b_id = any($1::uuid[])`, [[A.id, B.id]]);
        await db.query(`delete from blocks where blocker_id = any($1::uuid[])`, [[A.id, B.id]]);
        await db.query(`delete from access_bars where setter_id = any($1::uuid[])`, [[A.id, B.id]]);
        const has = { A: s.stopA || s.rowA, B: s.stopB || s.rowB };
        const flip = (si + ei) % 2 === 1;
        // The row on YA is ended by A's bar when the pattern says so and A has one, else by B's; the row on YB likewise the other way round.
        const endedBy = { YA: (flip && has.A ? "A" : "B") as "A" | "B", YB: (!flip && has.B ? "B" : "A") as "A" | "B" };
        for (const [on, subject, person, by] of [[YA, YB, B, endedBy.YA], [YB, YA, A, endedBy.YB]] as const) {
          await db.query(`insert into agent_contacts (agent_id, subject_id, person_id, state, end_reason, barred_by) values ($1, $2, $3, 'ended', 'barred', $4)`, [on, subject, person.id, by === "A" ? A.id : B.id]);
        }
        if (s.stopA) await db.tx((t) => setBar(t, A.id, B.id, "stop"));
        if (s.stopB) await db.tx((t) => setBar(t, B.id, A.id, "stop"));
        for (const [p, q, block, row] of [[A, B, s.blockA, s.rowA], [B, A, s.blockB, s.rowB]] as const) {
          if (block && row) await db.tx((t) => blockPrincipal(t, p.id, q.id));
          else if (block) await db.query(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [p.id, q.id]);
          else if (row) await db.query(`insert into access_bars (setter_id, other_id, kind) values ($1, $2, 'block')`, [p.id, q.id]);
        }
        expect(await barRows(A, B, N)).toEqual(rowsOf(s));
        const want: S = { ...s };
        let lifted: "A" | "B" | null = null;
        if (event.startsWith("stop")) {
          await db.tx((t) => setBar(t, who.id, other.id, "stop"));
          want[`stop${key}`] = true;
        } else if (event.startsWith("resume")) {
          expect(await db.tx((t) => liftBar(t, who.id, other.id))).toBe(s[`stop${key}`]);
          want[`stop${key}`] = false;
          if (s[`stop${key}`]) lifted = key;
        } else if (event.startsWith("block")) {
          await db.tx((t) => blockPrincipal(t, who.id, other.id));
          if (!s[`block${key}`]) {
            want[`block${key}`] = true;
            want[`row${key}`] = true; // a block that is new writes its row; one that stands already writes nothing
          }
        } else if (event.startsWith("unblock")) {
          expect(await db.tx((t) => deleteBlock(t, who.id, other.id))).toBe(s[`block${key}`]);
          if (s[`block${key}`]) {
            want[`block${key}`] = false;
            want[`row${key}`] = false; // the row goes with the block it was written for; a lone row is not touched
            if (s[`row${key}`]) lifted = key; // the lift (and its relabelling) happens only where a row was deleted
          }
        } else {
          // An unfriend writes no bar (Owner decision 2026-11-25); a row approved one by one stays live.
          const [lo, hi] = [A.id, B.id].sort();
          await db.query(`insert into friendships (a_id, b_id) values ($1, $2)`, [lo, hi]);
          // (A row approved one by one is live only where no bar stands: a bar ends every row, and none is made while it stands.)
          const withRow = !standing(s);
          if (withRow) await db.query(`insert into agent_contacts (agent_id, subject_id, person_id, state, basis) values ($1, $2, $2, 'live', 'approved')`, [whoAgent, other.id]);
          expect((await db.tx((t) => unfriendIn(t, who.id, other.id))).ok).toBe(true);
          if (withRow) expect((await db.query(`select state, end_reason from agent_contacts where agent_id = $1 and subject_id = $2`, [whoAgent, other.id])).rows).toEqual([{ state: "live", end_reason: null }]);
        }
        const at = [JSON.stringify(s), event];
        // After: the rows are exactly the model's, nobody's act touched the other person's rows ...
        expect([at, await barRows(A, B, N)]).toEqual([at, rowsOf(want)]);
        for (const p of [A, B]) {
          const k = p === A ? "A" : "B";
          const own = (await db.query(`select 1 from access_bars where setter_id = $1`, [p.id])).rows.length;
          expect([at, own]).toEqual([at, Number(want[`stop${k}`]) + Number(want[`row${k}`])]);
        }
        // ... and each owner reads each ended row by whose bar ended it, however the other person lifts.
        for (const [owner, k, on, subject, by] of [[A, "A", YA, YB, endedBy.YA], [B, "B", YB, YA, endedBy.YB]] as const) {
          const mine = by === k;
          const relabelled = mine && lifted === k && !(want[`stop${k}`] || want[`row${k}`]);
          const read = (await contactsOfAgent(db, owner.id, on))!.rows.find((r) => r.subject.id === subject)!.endReason;
          expect([at, k, read]).toEqual([at, k, mine ? (relabelled ? "removed" : "barred") : "left"]);
          const stored = (await db.query(`select end_reason, barred_by from agent_contacts where agent_id = $1 and subject_id = $2`, [on, subject])).rows[0];
          expect([at, k, stored]).toEqual([at, k, relabelled ? { end_reason: "removed", barred_by: null } : { end_reason: "barred", barred_by: by === "A" ? A.id : B.id }]);
        }
        // ... and who is barred follows: the pair is barred iff any row stands (a block's row only while its block does); each
        // person's reach of the other's Agent is `blocked` while a block stands, else `barred` while a bar does, else open.
        expect([at, await standingNow()]).toEqual([at, standing(want)]);
        const reachOf: Reach = want.blockA || want.blockB ? "blocked" : standing(want) ? "barred" : "ok";
        expect([at, [await reach(db, B.id, YA, "group", on), await reach(db, A.id, YB, "group", on)]]).toEqual([at, [reachOf, reachOf]]);
        cases++;
      }
    }
    return cases;
  }

  it("every state of the pair under every event, the unfriend included: the model of who holds which row and who is barred (160 cases)", async () => {
    const states: S[] = [];
    for (let m = 0; m < 16; m++) states.push({ stopA: !!(m & 1), stopB: !!(m & 2), blockA: !!(m & 4), rowA: !!(m & 4), blockB: !!(m & 8), rowB: !!(m & 8) });
    expect(await runModel(states, EVENTS)).toBe(160);
  }, 120_000);

  it("the states an older process leaves (a block without its row, a row without its block) under every event (480 cases)", async () => {
    // Each person's block is one of: none, block and row, a block alone, a row alone; with every stop: 64 states, 16 of them the
    // consistent ones above, 48 orphans. A lone row bars nobody and its setter's next block heals it; a lone block still blocks and
    // its unblock leaves the row it never wrote.
    const states: S[] = [];
    for (let stops = 0; stops < 4; stops++)
      for (let ka = 0; ka < 4; ka++)
        for (let kb = 0; kb < 4; kb++) {
          const s: S = { stopA: !!(stops & 1), stopB: !!(stops & 2), blockA: ka === 1 || ka === 2, rowA: ka === 1 || ka === 3, blockB: kb === 1 || kb === 2, rowB: kb === 1 || kb === 3 };
          if (s.blockA !== s.rowA || s.blockB !== s.rowB) states.push(s);
        }
    expect(states).toHaveLength(48);
    expect(await runModel(states, EVENTS)).toBe(480);
  }, 240_000);

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
      await setBar(t, owner.id, v.id, "stop");
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

  it("a person only, never oneself; a lift is one answer whatever stands: none, the other person's, a block's", async () => {
    const a = await signUp(app, "rfa");
    const b = await signUp(app, "rfb");
    const c = await signUp(app, "rfc");
    const agent = await newAgent(b, "rfbot");
    expect((await stop(a, a)).status).toBe(400);
    expect((await stop(a, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await stop(a, agent.id)).status).toBe(404);
    expect((await stop(a, b)).json).toEqual({ ok: true, ended: 0 });
    expect((await stop(a, b)).json).toEqual({ ok: true, ended: 0 });
    expect(await barRows(a, b)).toHaveLength(1);
    expect((await resume(a, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await resume(a, agent.id)).status).toBe(404);
    // Nothing, the other's stop, a block: the same status and body.
    await block(c, a);
    const none = await resume(a, c);
    const theirs = await resume(b, a);
    await block(a, c);
    const blocks = await resume(a, c);
    for (const r of [theirs, blocks]) expect([r.status, r.json]).toEqual([none.status, none.json]);
    expect(none.status).toBe(404);
  });

  it("what each side sees of an ending: the owner reads barred only for a bar they set themselves (A-3 review m3)", async () => {
    const o = await signUp(app, "seeowner");
    const v = await signUp(app, "seev");
    const y = await newAgent(o, "seey");
    const vy = await newAgent(v, "seevy");
    const rows = async (who: Actor, agentId: string) => ((await api(app, who, "GET", `/api/agents/${agentId}/contacts`)).json.rows as Array<{ subject: { id: string }; endReason: string | null }>).map((r) => [r.subject.id, r.endReason]);
    // V is let in to O's Agent, and O to V's.
    await db.query(`insert into agent_contacts (agent_id, subject_id, person_id, state, basis) values ($1, $2, $2, 'live', 'approved'), ($3, $4, $4, 'live', 'approved')`, [y.id, v.id, vy.id, o.id]);
    await stop(o, v);
    // O set it: O reads barred on their Agent. V did not: V reads the row of O on their Agent as a leaving, though the same ending made it.
    expect(await rows(o, y.id)).toEqual([[v.id, "barred"]]);
    expect(await rows(v, vy.id)).toEqual([[o.id, "left"]]);
    // V then bars O too: the row was ended by O's bar, so V still reads a leaving (A-4 review m4: the row records whose bar ended it).
    await stop(v, o);
    expect(await rows(v, vy.id)).toEqual([[o.id, "left"]]);
    // The other way round: only V barred O.
    await resume(o, v);
    await resume(v, o);
    await db.query(`update agent_contacts set state = 'live', basis = 'approved', end_reason = null, barred_by = null`);
    await stop(v, o);
    expect(await rows(o, y.id)).toEqual([[v.id, "left"]]);
    expect(await rows(v, vy.id)).toEqual([[o.id, "barred"]]);
  });

  it("after the owner's own 恢复往来 the rows their bar ended read removed, not left; the other person's bar still reads left (n4)", async () => {
    const rows = async (who: Actor, agentId: string) => ((await api(app, who, "GET", `/api/agents/${agentId}/contacts`)).json.rows as Array<{ subject: { id: string }; endReason: string | null }>).map((r) => [r.subject.id, r.endReason]);
    const live = (agentId: string, subjectId: string) =>
      db.query(`insert into agent_contacts (agent_id, subject_id, person_id, state, basis) values ($1, $2, $2, 'live', 'approved') on conflict (agent_id, subject_id) do update set state = 'live', basis = 'approved', end_reason = null`, [agentId, subjectId]);
    for (const how of ["stop", "block"] as const) {
      const o = await signUp(app, `n4${how}o`);
      const v = await signUp(app, `n4${how}v`);
      const y = await newAgent(o, `n4${how}y`);
      await live(y.id, v.id);
      await (how === "stop" ? stop(o, v) : block(o, v));
      expect(await rows(o, y.id)).toEqual([[v.id, "barred"]]);
      await (how === "stop" ? resume(o, v) : unblock(o, v));
      // What the owner did reads as what they did; the person stays out (an ended `removed` row is barred at reach step 5).
      expect(await rows(o, y.id)).toEqual([[v.id, "removed"]]);
      expect(await reach(db, v.id, y.id, "social", on)).toBe("barred");
      expect(await rowState(y.id, v.id)).toEqual({ state: "ended", endReason: "removed" });
    }
    // The other person's bar stands when the owner lifts theirs: the rows are not the owner's act; they still read as a leaving.
    const o = await signUp(app, "n4bo");
    const v = await signUp(app, "n4bv");
    const y = await newAgent(o, "n4by");
    await live(y.id, v.id);
    await stop(v, o);
    await stop(o, v);
    await resume(o, v);
    expect(await rows(o, y.id)).toEqual([[v.id, "left"]]);
    expect(await rowState(y.id, v.id)).toEqual({ state: "ended", endReason: "barred" });
    // A lift that is not the last bar leaves the rows as they are too: the owner's own block stands.
    const o2 = await signUp(app, "n4co");
    const v2 = await signUp(app, "n4cv");
    const y2 = await newAgent(o2, "n4cy");
    await live(y2.id, v2.id);
    await stop(o2, v2);
    await block(o2, v2);
    await resume(o2, v2);
    expect(await rows(o2, y2.id)).toEqual([[v2.id, "barred"]]);
  });

  it("an approval whose transaction began before the owner's stop but ran after it: it is the later act, and lifts that stop (the lock order decides, n6; fix round 3, point 8)", async () => {
    const owner = await signUp(app, "n6owner");
    const v = await signUp(app, "n6v");
    const y = await newAgent(owner, "n6y");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const isStarted = new Promise<void>((r) => (started = r));
    // Connection 1 begins now (its `now()` is fixed here) and works only after the gate.
    const approving = db.tx(async (t) => {
      await t.query("select 1");
      started();
      await gate;
      return approveContact(t, owner.id, y.id, v.id);
    });
    await isStarted;
    await new Promise((r) => setTimeout(r, 30));
    // Connection 2: the bar commits, and the person asks again after it.
    await db.tx((t) => setBar(t, owner.id, v.id, "stop"));
    await db.query(`insert into agent_contacts (agent_id, subject_id, person_id, state, until) values ($1, $2, $2, 'requested', now() + interval '7 days')`, [y.id, v.id]);
    release();
    expect(await approving).toMatchObject({ conversationId: expect.any(String) });
    // The owner sees the row live, and their own stop is gone with that approval: one state.
    expect(await rowState(y.id, v.id)).toEqual({ state: "live", endReason: null });
    expect(await reach(db, v.id, y.id, "social", on)).toBe("ok");
    expect((await db.query(`select 1 from access_bars where setter_id = $1`, [owner.id])).rowCount).toBe(0);
  });

  it("the other side is not told: no frame to the other person unless something of theirs ended, and none on a lift", async () => {
    const owner = await signUp(app, "frmowner");
    const v = await signUp(app, "frmv");
    const w = await signUp(app, "frmw");
    const y = await newAgent(owner, "frmy");
    const told: string[][] = [];
    const off = app.deps.social.on((ids) => void told.push([...ids]));
    try {
      await stop(owner, w);
      expect(told.flat()).not.toContain(w.id);
      await resume(owner, w);
      expect(told.flat()).not.toContain(w.id);
      await seedSocial(app, { owner, agentId: y.id, visitor: v });
      told.length = 0;
      await stop(owner, v);
      expect(told.flat()).toContain(v.id);
      told.length = 0;
      await resume(owner, v);
      expect(told.flat()).not.toContain(v.id);
    } finally {
      off();
    }
  });

  it("a bar, and an owner's block of the person, each end the person's live rows and stop their social runs; a stop also takes their call out of a group reply", async () => {
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
      // V's only call leaves the group reply: a stop cancels it quietly now; a block leaves a reply that has not begun to the check
      // `begin` makes call by call (agents-block-recheck.test.ts), which drops the same call then.
      if (how === "bar") expect(await runOf(queued)).toMatchObject({ status: "cancelled", error: null });
      else expect(await runOf(queued)).toMatchObject({ status: "queued", error: null, interrupted: null });
      expect((await barRows(owner, v)).length).toBe(1);
    }
  });
});

describe("unfriending (Owner decision 2026-11-25: just unfriending, as in WeChat / QQ)", () => {
  it("writes no bar and no cooldown; rows admitted because of the friendship end as an ordinary ending, a row the owner approved one by one stays; re-friending restores the friends' reach with no 恢复往来", async () => {
    const owner = await signUp(app, "unfowner");
    const viaFriends = await signUp(app, "unfrow");
    const approved = await signUp(app, "unfapp");
    const noRow = await signUp(app, "unfno");
    const yAsk = await newAgent(owner, "unfyask");
    const yFriends = await newAgent(owner, "unfyfr");
    await policy(yFriends.id, "contacts");
    for (const f of [viaFriends, approved, noRow]) await befriend(app, owner, f);
    await add(approved, yAsk.id);
    await approve(owner, yAsk.id, approved);
    expect((await add(viaFriends, yFriends.id)).status).toBe(201);
    const g = await newGroup(viaFriends.id);
    const queued = await queuedRun(yFriends.id, g, viaFriends.id);
    expect(await rowState(yFriends.id, viaFriends.id)).toEqual({ state: "live", endReason: null });

    expect((await unfriend(owner, viaFriends)).status).toBe(200);
    expect(await rowState(yFriends.id, viaFriends.id)).toEqual({ state: "ended", endReason: "left" });
    // A group reply to that person is not touched at all (A-5 review m8: in a group anyone may @ the Agent, friend or not): it is still queued, with its call.
    expect(await runOf(queued)).toMatchObject({ status: "queued", error: null });
    expect((await db.query(`select cardinality(call_seqs) n from agent_runs where id = $1`, [queued])).rows[0]!.n).toBe(1);
    expect((await db.query(`select count(*)::int n from access_bars where setter_id = any($1::uuid[]) or other_id = any($1::uuid[])`, [[owner.id, viaFriends.id]])).rows[0]!.n).toBe(0);
    // The one the owner approved by hand is untouched, and so is one with no row.
    expect((await unfriend(owner, approved)).status).toBe(200);
    expect(await rowState(yAsk.id, approved.id)).toEqual({ state: "live", endReason: null });
    expect((await unfriend(owner, noRow)).status).toBe(200);
    expect((await db.query(`select count(*)::int n from access_bars where setter_id = $1 or other_id = $1`, [owner.id])).rows[0]!.n).toBe(0);
    // Not stopped, so no cooldown and no 恢复往来: the unfriended person is just not a friend until they are again.
    expect(await add(viaFriends, yFriends.id)).toMatchObject({ status: 202 });
    expect((await resume(owner, viaFriends)).status).toBe(404);
    // (Its request waits, as for anyone who is no friend; they withdraw it, become friends again, and the policy lets them in at once.)
    expect((await api(app, viaFriends, "DELETE", `/api/agent-contacts/${yFriends.id}/${viaFriends.id}`)).status).toBe(200);
    await befriend(app, owner, viaFriends);
    expect(await add(viaFriends, yFriends.id)).toMatchObject({ status: 201 });
    expect(await rowState(yFriends.id, viaFriends.id)).toEqual({ state: "live", endReason: null });
    expect(await reach(db, viaFriends.id, yFriends.id, "group", on)).toBe("ok");
  });

  it("the other side's Agents count the same way: an Agent of the unfriended person that admitted the unfriender as a friend ends it, as an ordinary ending", async () => {
    const owner = await signUp(app, "unfo2");
    const f2 = await signUp(app, "unff2");
    const fAgent = await newAgent(f2, "unff2bot");
    await policy(fAgent.id, "contacts");
    await befriend(app, owner, f2);
    expect((await add(owner, fAgent.id)).status).toBe(201);
    expect((await unfriend(f2, owner)).status).toBe(200);
    expect(await rowState(fAgent.id, owner.id)).toEqual({ state: "ended", endReason: "left" });
    expect((await db.query(`select count(*)::int n from access_bars where setter_id = any($1::uuid[]) or other_id = any($1::uuid[])`, [[owner.id, f2.id]])).rows[0]!.n).toBe(0);
  });
});

describe("停止往来 pressed again (A-5 review m3a)", () => {
  it("is idempotent: the stop row keeps its `since`, so the other person's 30-day cooldown is not restarted", async () => {
    const o = await signUp(app, "idemo");
    const v = await signUp(app, "idemv");
    const y = await newAgent(o, "idemy");
    expect((await stop(o, v)).status).toBe(200);
    const since = async () => (await db.query(`select since from access_bars where setter_id = $1 and other_id = $2 and kind = 'stop'`, [o.id, v.id])).rows[0]!.since as Date;
    await ageBar(o.id, v.id, 31 * DAY);
    const first = await since();
    expect((await stop(o, v)).status).toBe(200);
    expect((await since()).getTime()).toBe(first.getTime());
    // The cooldown ran out a day ago, and pressing again did not bring it back.
    expect(await add(v, y.id)).toMatchObject({ status: 202 });
  });
});

describe("blocks (Controller ruling Q4, per setter)", () => {
  it("every person-to-person block writes its own row; the setter's unblock lifts that row and nothing else", async () => {
    const o2 = await signUp(app, "q4o2");
    const w = await signUp(app, "q4w");
    const N = { [o2.id]: "O", [w.id]: "W" };
    await block(o2, w);
    expect(await barRows(o2, w, N)).toEqual(["O>W block"]);
    // Blocking again changes nothing (the row's `since` stays).
    const first = (await db.query(`select since from access_bars where setter_id = $1`, [o2.id])).rows[0]!.since;
    await block(o2, w);
    expect((await db.query(`select since from access_bars where setter_id = $1`, [o2.id])).rows[0]!.since).toEqual(first);
    await unblock(o2, w);
    expect(await barRows(o2, w)).toEqual([]);
    // Both block; each unblock takes its own row.
    await block(o2, w);
    await block(w, o2);
    expect(await barRows(o2, w, N)).toEqual(["O>W block", "W>O block"]);
    await unblock(o2, w);
    expect(await barRows(o2, w, N)).toEqual(["W>O block"]);
    await unblock(w, o2);
    expect(await barRows(o2, w)).toEqual([]);
    // A block over a stop: the unblock leaves the stop.
    await stop(o2, w);
    await block(o2, w);
    expect(await barRows(o2, w, N)).toEqual(["O>W block", "O>W stop"]);
    await unblock(o2, w);
    expect(await barRows(o2, w, N)).toEqual(["O>W stop"]);
    await resume(o2, w);
    // A block of an Agent writes no bar, and there is none to lift.
    const o4 = await signUp(app, "q4o4");
    const ownerOfY = await signUp(app, "q4yo");
    const y = await newAgent(ownerOfY, "q4y");
    expect((await block(o4, y.id)).status).toBe(200);
    expect((await db.query(`select count(*)::int n from access_bars where setter_id = $1 or other_id = $1`, [o4.id])).rows[0]!.n).toBe(0);
    expect((await resume(o4, y.id)).status).toBe(404);
  });

  it("C1: a block that existed before 075 and is removed after it ran: its unblock lifts the row the backfill gave it", async () => {
    const oldBlocker = await person();
    const oldBlocked = await person();
    await db.query(`insert into blocks (blocker_id, blocked_id, created_at) values ($1, $2, now() - interval '9 days')`, [oldBlocker.id, oldBlocked.id]);
    expect(await barRows(oldBlocker, oldBlocked)).toEqual([]);
    const migration = readFileSync(new URL("../migrations/075_agent_social_access.sql", import.meta.url), "utf8");
    const backfill = /-- bars from blocks begin\n([\s\S]*?)-- bars from blocks end/.exec(migration)![1]!;
    // The migration's own statement, limited to this one block (the database holds other tests' blocks, which have their rows).
    expect(backfill.trim().endsWith(";")).toBe(true);
    await db.query(backfill.trim().replace(/;$/, ` where b.blocker_id = '${oldBlocker.id}';`));
    expect(await barRows(oldBlocker, oldBlocked, { [oldBlocker.id]: "X", [oldBlocked.id]: "Y" })).toEqual(["X>Y block"]);
    await db.tx((t) => deleteBlock(t, oldBlocker.id, oldBlocked.id));
    expect(await barRows(oldBlocker, oldBlocked)).toEqual([]);
    expect(await blocksBetween(oldBlocker, oldBlocked)).toEqual([]);
  });

  it("a block row whose block is gone (an unblock served by an older process) bars nobody; the next unblock clears it", async () => {
    const owner = await signUp(app, "orphowner");
    const v = await signUp(app, "orphv");
    const y = await newAgent(owner, "orphy");
    await db.query(`insert into access_bars (setter_id, other_id, kind) values ($1, $2, 'block')`, [owner.id, v.id]);
    expect(await reach(db, v.id, y.id, "group", on)).toBe("ok");
    expect((await add(v, y.id)).status).toBe(202);
    // The block itself, then its unblock: the row is the block's again, and it goes.
    await block(owner, v);
    expect(await reach(db, v.id, y.id, "group", on)).toBe("blocked");
    await unblock(owner, v);
    expect(await barRows(owner, v)).toEqual([]);
  });

  it("a block ends the rows between the two and stops their social runs, and unblocking brings no row back", async () => {
    const owner = await signUp(app, "bkrowner");
    const v = await signUp(app, "bkrv");
    const y = await newAgent(owner, "bkry");
    const { conversationId: s } = await seedSocial(app, { owner, agentId: y.id, visitor: v });
    const running = await queuedRun(y.id, s, v.id, "running");
    expect((await block(v, owner)).status).toBe(200);
    expect(await rowState(y.id, v.id)).toEqual({ state: "ended", endReason: "barred" });
    expect(await runOf(running)).toMatchObject({ interrupted: "access_ended", pending_seq: null });
    expect((await unblock(v, owner)).status).toBe(200);
    expect(await barRows(owner, v)).toEqual([]);
    expect(await rowState(y.id, v.id)).toEqual({ state: "ended", endReason: "barred" });
    // No bar is left. The row the block ended is `barred` and keeps the social conversation shut until a request is approved; in a
    // group nothing stands any more, so the person is answered there again (fix round 2, N2).
    expect(await reach(db, v.id, y.id, "social", on)).toBe("barred");
    expect(await reach(db, v.id, y.id, "group", on)).toBe("ok");
  });

  it("open screens are told: a block, an unblock and an unfriend publish the pair's social conversations to their people", async () => {
    const owner = await signUp(app, "pubowner");
    const v = await signUp(app, "pubv");
    const y = await newAgent(owner, "puby");
    const { conversationId: s } = await seedSocial(app, { owner, agentId: y.id, visitor: v });
    await befriend(app, owner, v);
    const changed: Array<{ id: string; ids: string[] }> = [];
    const off = app.deps.conversations.onMembershipChanged((id, ids) => void changed.push({ id, ids }));
    const seen = () => changed.filter((c) => c.id === s && c.ids.includes(owner.id) && c.ids.includes(v.id)).length;
    try {
      await block(owner, v);
      expect(seen()).toBe(1);
      await unblock(owner, v);
      expect(seen()).toBe(2);
      await unfriend(owner, v);
      expect(seen()).toBe(3);
      // A block of the Agent by the visitor: its owner and the visitor are told as well.
      await befriend(app, owner, v);
      await db.query(`update agent_contacts set state = 'live', basis = 'approved', end_reason = null where agent_id = $1`, [y.id]);
      await block(v, y.id);
      expect(seen()).toBe(4);
    } finally {
      off();
    }
  });

  it("racing: block and unblock, both blocking each other: a block row stands exactly while its block does", async () => {
    const consistent = async (a: Actor, b: Actor): Promise<void> => {
      const blockers = await blocksBetween(a, b);
      const rows = (await db.query<{ setter_id: string }>(`select setter_id from access_bars where kind = 'block' and ((setter_id = $1 and other_id = $2) or (setter_id = $2 and other_id = $1)) order by setter_id`, [a.id, b.id])).rows.map((r) => r.setter_id);
      expect(rows).toEqual(blockers);
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
    // A stop racing a block and its unblock: the stop is there whichever order wins, and the block's row follows the block.
    for (let i = 0; i < 6; i++) {
      const c = await signUp(app, `rcc${i}`);
      const d = await signUp(app, `rcd${i}`);
      await Promise.all([stop(c, d), block(c, d), unblock(c, d)]);
      const rows = await barRows(c, d, { [c.id]: "C", [d.id]: "D" });
      expect(rows).toContain("C>D stop");
      expect(rows.includes("C>D block")).toBe((await blocksBetween(c, d)).length === 1);
    }
    // (24 sign-ups, each with a password hash, and about 150 requests: close to the suite's default limit on a busy machine.)
  }, 45_000);
});
