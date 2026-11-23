import { describe, expect, it } from "vitest";
import { discoverable, discoverableSql, reach, reachSql, refusedSql, type Reach } from "../src/social/reach.ts";
import { useApp } from "./helpers/harness.ts";
import { SOCIAL_ON } from "./helpers/social.ts";

// `reach` and its SQL twin (plan A1; design §1.2; D3; Controller ruling 2026-11-24 (attack, I8)): one table of worlds, each asked of
// both forms (`social` and `group`), each from scratch, each asked of `reach` and of `reachSql`.
const { db } = useApp({ agentWorker: false, config: SOCIAL_ON });
const on = { social: { enabled: true } } as const;
const off = { social: { enabled: false } } as const;

let n = 0;
const tag = () => `${++n}_${Math.random().toString(36).slice(2, 6)}`;

async function human(): Promise<string> {
  const h = `rc_${tag()}`;
  await db.query(`insert into "user" (id, name, email, "emailVerified") values ($1::text, $1::text, $1::text || '@example.test', true)`, [`auth-${h}`]);
  const { rows } = await db.query<{ id: string }>(`insert into principals (kind, handle, display_name, auth_user_id) values ('human', $1::citext, $1::text, 'auth-' || $1::text) returning id`, [h]);
  return rows[0]!.id;
}
async function agentOf(owner: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(`insert into principals (kind, handle, display_name, owner_id) values ('agent', $1::citext, $1::text, $2) returning id`, [`ag${tag()}`, owner]);
  await db.query(`insert into agents (principal_id) values ($1)`, [rows[0]!.id]);
  return rows[0]!.id;
}

interface World {
  /** The Agent's owner, the person who asks, their Agent, and the Agent asked. */
  O: string;
  P: string;
  pAgent: string;
  agent: string;
  /** Who asks (the person by default). */
  subject: string;
  /** The site switch the world is asked under. */
  on: boolean;
}
async function world(): Promise<World> {
  const O = await human();
  const P = await human();
  return { O, P, pAgent: await agentOf(P), agent: await agentOf(O), subject: P, on: true };
}

const T1 = "2026-01-01T00:00:00Z";
const T2 = "2026-01-02T00:00:00Z";
const row = (w: World, subject: string, state: "live" | "requested" | "ended", o: { basis?: "approved" | "contacts"; reason?: string; since?: string } = {}) =>
  db.query(
    `insert into agent_contacts (agent_id, subject_id, person_id, state, basis, until, end_reason, since) values ($1, $2, $3, $4, $5, $6, $7, coalesce($8::timestamptz, now()))`,
    [
      w.agent,
      subject,
      subject === w.pAgent ? w.P : subject,
      state,
      state === "live" ? (o.basis ?? "approved") : null,
      state === "requested" ? new Date(Date.now() + 86_400_000) : null,
      state === "ended" ? o.reason : null,
      o.since ?? null,
    ],
  );
const bar = (w: World, since = T1) => {
  const [lo, hi] = [w.P, w.O].sort();
  return db.query(`insert into access_bars (lo_id, hi_id, reason, set_by, since) values ($1, $2, 'stopped', $3, $4)`, [lo, hi, w.P, since]);
};
const block = (blocker: string, blocked: string) => db.query(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [blocker, blocked]);

type Setup = (w: World) => Promise<void>;
const none: Setup = async () => {};
const liveRow = (basis: "approved" | "contacts"): Setup => (w) => row(w, w.P, "live", { basis }).then(() => {});
const ended = (reason: string): Setup => (w) => row(w, w.P, "ended", { reason }).then(() => {});

const cases: Array<[name: string, setup: Setup, social: Reach, group: Reach]> = [
  ["never met", none, "no_access", "ok"],
  ["live row, contacts basis", liveRow("contacts"), "ok", "ok"],
  ["owner reaching own Agent", async (w) => void (w.subject = w.O), "ok", "ok"],
  ["Agent deleted (owner too)", async (w) => void (await db.query(`update agents set deleted_at = now() where principal_id = $1`, [w.agent]), (w.subject = w.O)), "gone", "gone"],
  ["Agent deleted (a stranger)", async (w) => void (await db.query(`update agents set deleted_at = now() where principal_id = $1`, [w.agent])), "gone", "gone"],
  ["Agent disabled", async (w) => void (await db.query(`update agents set disabled_at = now() where principal_id = $1`, [w.agent])), "gone", "gone"],
  ["Agent disabled, the owner asks", async (w) => void (await db.query(`update agents set disabled_at = now() where principal_id = $1`, [w.agent]), (w.subject = w.O)), "ok", "ok"],
  ["switch off, live row", async (w) => void (await liveRow("approved")(w), (w.on = false)), "gone", "ok"], // D3
  ["switch off, the owner asks", async (w) => void ((w.subject = w.O), (w.on = false)), "ok", "ok"],
  ["block O→P", (w) => block(w.O, w.P).then(() => {}), "blocked", "blocked"],
  ["block P→O", (w) => block(w.P, w.O).then(() => {}), "blocked", "blocked"],
  ["block P→Agent", (w) => block(w.P, w.agent).then(() => {}), "blocked", "blocked"],
  ["block Agent→P", (w) => block(w.agent, w.P).then(() => {}), "blocked", "blocked"],
  ["block O→P's Agent, P's Agent asks", async (w) => void ((w.subject = w.pAgent), await block(w.O, w.pAgent)), "blocked", "blocked"], // I8
  ["block P's Agent→the Agent, P's Agent asks", async (w) => void ((w.subject = w.pAgent), await block(w.pAgent, w.agent)), "blocked", "blocked"],
  ["block wins over a live row", async (w) => void (await liveRow("approved")(w), await block(w.O, w.P)), "blocked", "blocked"],
  ["bar, no row", (w) => bar(w).then(() => {}), "barred", "barred"],
  ["bar, row approved before the bar", async (w) => void (await row(w, w.P, "live", { since: T1 }), await bar(w, T2)), "barred", "barred"],
  ["bar, row approved after the bar", async (w) => void (await bar(w, T1), await row(w, w.P, "live", { since: T2 })), "ok", "ok"],
  ["bar, row on the contacts basis after the bar", async (w) => void (await bar(w, T1), await row(w, w.P, "live", { basis: "contacts", since: T2 })), "barred", "barred"],
  ["bar, approved row of P's Agent, P asks", async (w) => void (await bar(w, T1), await row(w, w.pAgent, "live", { since: T2 })), "barred", "barred"],
  ["bar, the owner asks", async (w) => void ((w.subject = w.O), await bar(w)), "ok", "ok"],
  ["row ended narrowed", ended("narrowed"), "barred", "barred"],
  ["row ended removed", ended("removed"), "barred", "barred"],
  ["row ended barred", ended("barred"), "barred", "barred"],
  ["row ended declined", ended("declined"), "no_access", "ok"],
  ["row ended expired", ended("expired"), "no_access", "ok"],
  ["row ended left", ended("left"), "no_access", "ok"],
  ["row requested", (w) => row(w, w.P, "requested").then(() => {}), "no_access", "ok"],
  ["person's live row, P's Agent asks", async (w) => void ((w.subject = w.pAgent), await row(w, w.P, "live")), "no_access", "ok"],
  ["P's Agent's own live row", async (w) => void ((w.subject = w.pAgent), await row(w, w.pAgent, "live", { basis: "contacts" })), "ok", "ok"],
  ["P's Agent's row ended narrowed", async (w) => void ((w.subject = w.pAgent), await row(w, w.pAgent, "ended", { reason: "narrowed" })), "barred", "barred"],
];

describe("reach", () => {
  for (const [name, setup, social, group] of cases) {
    it(`${name}: social ${social}, group ${group}`, async () => {
      const w = await world();
      await setup(w);
      const config = w.on ? on : off;
      const socialOn = w.on ? "true" : "false";
      for (const [where, want] of [["social", social], ["group", group]] as const) {
        expect(await reach(db, w.subject, w.agent, where, config), `reach ${where}`).toBe(want);
        const { rows } = await db.query<{ r: Reach; refused: boolean }>(
          `select ${reachSql({ subject: "$1::uuid", agent: "$2::uuid", where, socialOn })} as r, ${refusedSql({ subject: "$1::uuid", agent: "$2::uuid", where, socialOn })} as refused`,
          [w.subject, w.agent],
        );
        expect(rows[0], `reachSql ${where}`).toEqual({ r: want, refused: want !== "ok" });
      }
    });
  }

  it("an Agent that does not exist is gone", async () => {
    const w = await world();
    expect(await reach(db, w.P, w.O, "group", on)).toBe("gone"); // a person's id is no Agent
    expect(await reach(db, w.P, "00000000-0000-4000-8000-000000000000", "social", on)).toBe("gone");
  });

  it("the switch is the SQL boolean given, not a column", async () => {
    const w = await world();
    await row(w, w.P, "live");
    const q = (socialOn: string) => db.query<{ r: Reach }>(`select ${reachSql({ subject: "$1::uuid", agent: "$2::uuid", where: "social", socialOn })} as r`, [w.P, w.agent]).then((r) => r.rows[0]!.r);
    expect(await q("true")).toBe("ok");
    expect(await q("false")).toBe("gone");
    expect(await q("(select count(*) = 1 from agents where principal_id = $2::uuid)")).toBe("ok");
  });

  it("the twin agrees with reach over 105 seeded subjects in one statement", async () => {
    const w = await world();
    // 105 people, 15 in each of seven states, asked of one Agent in one select over unnest.
    const states: Array<[string, (p: string) => Promise<void>, Reach, Reach]> = [
      ["never met", async () => {}, "no_access", "ok"],
      ["live", async (p) => void (await db.query(`insert into agent_contacts (agent_id, subject_id, person_id, state, basis) values ($1, $2, $2, 'live', 'approved')`, [w.agent, p])), "ok", "ok"],
      ["requested", async (p) => void (await db.query(`insert into agent_contacts (agent_id, subject_id, person_id, state, until) values ($1, $2, $2, 'requested', now() + interval '1 day')`, [w.agent, p])), "no_access", "ok"],
      ["narrowed", async (p) => void (await db.query(`insert into agent_contacts (agent_id, subject_id, person_id, state, end_reason) values ($1, $2, $2, 'ended', 'narrowed')`, [w.agent, p])), "barred", "barred"],
      ["barred, no row", async (p) => void (await db.query(`insert into access_bars (lo_id, hi_id, reason, set_by) values (least($1::uuid, $2::uuid), greatest($1::uuid, $2::uuid), 'stopped', $1)`, [p, w.O])), "barred", "barred"],
      [
        "barred, then approved",
        async (p) => {
          await db.query(`insert into access_bars (lo_id, hi_id, reason, set_by, since) values (least($1::uuid, $2::uuid), greatest($1::uuid, $2::uuid), 'stopped', $1, $3)`, [p, w.O, T1]);
          await db.query(`insert into agent_contacts (agent_id, subject_id, person_id, state, basis, since) values ($1, $2, $2, 'live', 'approved', $3)`, [w.agent, p, T2]);
        },
        "ok",
        "ok",
      ],
      ["blocked", async (p) => void (await block(w.O, p)), "blocked", "blocked"],
    ];
    const people: Array<{ id: string; social: Reach; group: Reach }> = [];
    for (let i = 0; i < 105; i++) {
      const [, make, social, group] = states[i % states.length]!;
      const id = await human();
      await make(id);
      people.push({ id, social, group });
    }
    for (const where of ["social", "group"] as const) {
      const { rows } = await db.query<{ id: string; r: Reach }>(
        `select s.id::text as id, ${reachSql({ subject: "s.id", agent: "$2::uuid", where, socialOn: "true" })} as r from unnest($1::uuid[]) as s (id)`,
        [people.map((p) => p.id), w.agent],
      );
      expect(rows).toHaveLength(105);
      const got = new Map(rows.map((r) => [r.id, r.r]));
      for (const p of people) expect(got.get(p.id), `${where} ${p.id}`).toBe(p[where]);
    }
    // And `reach` says the same for every one.
    for (const p of people) {
      expect(await reach(db, p.id, w.agent, "social", on)).toBe(p.social);
      expect(await reach(db, p.id, w.agent, "group", on)).toBe(p.group);
    }
  });
});

describe("the twin over Agent subjects (the relay check, I8)", () => {
  it("agrees with reach over 105 Agents of other people in one statement, whatever their person or they themselves are to the Agent", async () => {
    const w = await world();
    // 105 Agents, 15 in each of seven states, each owned by a person of its own; the Agent asked is O's.
    const states: Array<[string, (a: { agent: string; person: string }) => Promise<void>, Reach, Reach]> = [
      ["never met", async () => {}, "no_access", "ok"],
      ["its own row live", async (a) => void (await db.query(`insert into agent_contacts (agent_id, subject_id, person_id, state, basis) values ($1, $2, $3, 'live', 'approved')`, [w.agent, a.agent, a.person])), "ok", "ok"],
      ["only its person's row live", async (a) => void (await db.query(`insert into agent_contacts (agent_id, subject_id, person_id, state, basis) values ($1, $2, $2, 'live', 'approved')`, [w.agent, a.person])), "no_access", "ok"],
      ["its own row narrowed", async (a) => void (await db.query(`insert into agent_contacts (agent_id, subject_id, person_id, state, end_reason) values ($1, $2, $3, 'ended', 'narrowed')`, [w.agent, a.agent, a.person])), "barred", "barred"],
      ["its person barred", async (a) => void (await db.query(`insert into access_bars (lo_id, hi_id, reason, set_by) values (least($1::uuid, $2::uuid), greatest($1::uuid, $2::uuid), 'stopped', $1)`, [a.person, w.O])), "barred", "barred"],
      ["O blocks its person", async (a) => void (await block(w.O, a.person)), "blocked", "blocked"],
      ["it blocks the Agent", async (a) => void (await block(a.agent, w.agent)), "blocked", "blocked"],
    ];
    const subjects: Array<{ id: string; social: Reach; group: Reach }> = [];
    for (let i = 0; i < 105; i++) {
      const [, make, social, group] = states[i % states.length]!;
      const person = await human();
      const agent = await agentOf(person);
      await make({ agent, person });
      subjects.push({ id: agent, social, group });
    }
    for (const where of ["social", "group"] as const) {
      const { rows } = await db.query<{ id: string; r: Reach }>(
        `select s.id::text as id, ${reachSql({ subject: "s.id", agent: "$2::uuid", where, socialOn: "true" })} as r from unnest($1::uuid[]) as s (id)`,
        [subjects.map((s) => s.id), w.agent],
      );
      expect(rows).toHaveLength(105);
      const got = new Map(rows.map((r) => [r.id, r.r]));
      for (const s of subjects) expect(got.get(s.id), `${where} ${s.id}`).toBe(s[where]);
    }
    for (const s of subjects) {
      expect(await reach(db, s.id, w.agent, "social", on)).toBe(s.social);
      expect(await reach(db, s.id, w.agent, "group", on)).toBe(s.group);
    }
  });
});

describe("discoverable", () => {
  async function found(w: World, viewer = w.P, socialOn = "true") {
    const { rows } = await db.query<{ d: boolean }>(`select ${discoverableSql({ agent: "$1::uuid", viewer: "$2::uuid", socialOn })} as d`, [w.agent, viewer]);
    const twin = rows[0]!.d;
    const direct = await discoverable(db, w.agent, viewer, socialOn === "true" ? on : off);
    expect(direct, "discoverable and discoverableSql agree").toBe(twin);
    return twin;
  }

  it("a stranger finds an Agent that takes contacts; the owner, a blocked pair, a hidden Agent and a switch off do not", async () => {
    const w = await world();
    expect(await found(w)).toBe(true); // contact_policy 'ask' is the default
    expect(await found(w, w.O)).toBe(false);
    expect(await found(w, w.P, "false")).toBe(false);
    for (const policy of ["contacts", "ask"]) {
      await db.query(`update agents set contact_policy = $2 where principal_id = $1`, [w.agent, policy]);
      expect(await found(w)).toBe(true);
    }
    await db.query(`update agents set contact_policy = 'none' where principal_id = $1`, [w.agent]);
    expect(await found(w)).toBe(false);
    await db.query(`update agents set contact_policy = 'ask' where principal_id = $1`, [w.agent]);
    await db.query(`update agents set disabled_at = now() where principal_id = $1`, [w.agent]);
    expect(await found(w)).toBe(false);
    await db.query(`update agents set disabled_at = null, deleted_at = now() where principal_id = $1`, [w.agent]);
    expect(await found(w)).toBe(false);
    await db.query(`update agents set deleted_at = null where principal_id = $1`, [w.agent]);
    expect(await found(w)).toBe(true);
    // A block either way, with the owner or with the Agent.
    for (const [a, b] of [[w.O, w.P], [w.P, w.O], [w.P, w.agent], [w.agent, w.P]] as const) {
      await block(a, b);
      expect(await found(w), `block ${a === w.O ? "O" : a === w.P ? "P" : "Agent"}→${b === w.O ? "O" : b === w.P ? "P" : "Agent"}`).toBe(false);
      await db.query(`delete from blocks`);
    }
    expect(await found(w)).toBe(true);
    // A person is no Agent.
    const { rows } = await db.query<{ d: boolean }>(`select ${discoverableSql({ agent: "$1::uuid", viewer: "$2::uuid", socialOn: "true" })} as d`, [w.O, w.P]);
    expect(rows[0]!.d).toBe(false);
  });
});
