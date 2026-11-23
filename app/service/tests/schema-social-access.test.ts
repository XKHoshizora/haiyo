import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { useApp } from "./helpers/harness.ts";

// Migration 075: lane A's ring-1a schema (bars, contact policy, reports, disable, the persona aid's columns, card answers) and the
// bars of the blocks that already exist (plan A0). 075 is applied to a live site and can never be edited again.
const FILE = new URL("../migrations/075_agent_social_access.sql", import.meta.url);

describe("075: access bars, contact policy, reports, the persona aid", () => {
  const { db } = useApp({ agentWorker: false });
  let n = 0;

  async function human(handle?: string): Promise<string> {
    const h = handle ?? `sa_${++n}_${Math.random().toString(36).slice(2, 6)}`;
    await db.query(`insert into "user" (id, name, email, "emailVerified") values ($1::text, $1::text, $1::text || '@example.test', true)`, [`auth-${h}`]);
    const { rows } = await db.query<{ id: string }>(
      `insert into principals (kind, handle, display_name, auth_user_id) values ('human', $1::citext, $1::text, 'auth-' || $1::text) returning id`,
      [h],
    );
    return rows[0]!.id;
  }
  async function agentOf(owner: string): Promise<string> {
    const { rows } = await db.query<{ id: string }>(`insert into principals (kind, handle, display_name, owner_id) values ('agent', $1::citext, $1::text, $2) returning id`, [`ag${++n}_${Math.random().toString(36).slice(2, 6)}`, owner]);
    await db.query(`insert into agents (principal_id) values ($1)`, [rows[0]!.id]);
    return rows[0]!.id;
  }

  test("a bar is one row per setter, other person and kind; a person cannot bar themself", async () => {
    const a = await human();
    const b = await human();
    const bar = (o: Partial<{ setter: string; other: string; kind: string }> = {}) =>
      db.query(`insert into access_bars (setter_id, other_id, kind) values ($1, $2, $3)`, [o.setter ?? a, o.other ?? b, o.kind ?? "stop"]);
    await expect(bar({ setter: a, other: a })).rejects.toThrow(/check/);
    await expect(bar({ kind: "unfriended" })).rejects.toThrow(/check/);
    await bar({});
    await expect(bar({})).rejects.toThrow(/access_bars_pkey/);
    // The other direction, and the other kind, are rows of their own: two people's decisions are never one row.
    await bar({ setter: b, other: a });
    await bar({ kind: "block" });
    expect((await db.query(`select count(*)::int n from access_bars where setter_id in ($1, $2) and other_id in ($1, $2)`, [a, b])).rows[0]!.n).toBe(3);
    // A person's removal takes their bars with it.
    await db.query(`delete from access_bars where setter_id = $1`, [a]);
  });

  test("a contact policy is one of three; an Agent is not disabled until someone says so", async () => {
    const owner = await human();
    const agent = await agentOf(owner);
    expect((await db.query(`select contact_policy, contact_picked, disabled_at from agents where principal_id = $1`, [agent])).rows[0]).toEqual({ contact_policy: "ask", contact_picked: false, disabled_at: null });
    await expect(db.query(`update agents set contact_policy = 'everyone' where principal_id = $1`, [agent])).rejects.toThrow(/check/);
    const picked = await human();
    await db.query(`insert into agent_contact_picks (agent_id, person_id) values ($1, $2)`, [agent, picked]);
    await expect(db.query(`insert into agent_contact_picks (agent_id, person_id) values ($1, $2)`, [agent, picked])).rejects.toThrow(/agent_contact_picks_pkey/);
  });

  // The block of 075 between its two markers, run in a rolled-back transaction over blocks crossing 10 and 100.
  test("bars from blocks (Controller ruling 2026-11-24, Q4; A-3 review C1): one `block` row per block between people, set by the blocker", async () => {
    const sql = readFileSync(FILE, "utf8");
    const begin = sql.indexOf("-- bars from blocks begin");
    const end = sql.indexOf("-- bars from blocks end");
    expect(begin).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(begin);
    const backfill = sql.slice(begin, end);
    const client = await db.pool.connect();
    const one = async (q: string, p: unknown[] = []) => (await client.query(q, p)).rows as Array<Record<string, any>>;
    try {
      await client.query("begin");
      // 81 pairs blocked one way, 12 pairs blocking each other: 105 block rows between people.
      const people: string[] = [];
      for (let i = 0; i < 186; i++) {
        await client.query(`insert into "user" (id, name, email, "emailVerified") values ($1::text, $1::text, $1::text || '@example.test', true)`, [`auth-bb_${i}`]);
        people.push((await one(`insert into principals (kind, handle, display_name, auth_user_id) values ('human', $1::citext, $1::text, 'auth-' || $1::text) returning id`, [`bb_${i}`]))[0]!.id);
      }
      const t0 = Date.parse("2026-01-01T00:00:00Z");
      const oneWay: Array<{ blocker: string; blocked: string; at: Date }> = [];
      for (let i = 0; i < 81; i++) {
        // Alternate the direction against the id order: the bar's pair is ordered, the block's is not.
        const [x, y] = i % 2 ? [people[2 * i]!, people[2 * i + 1]!] : [people[2 * i + 1]!, people[2 * i]!];
        const at = new Date(t0 + i * 1000);
        await client.query(`insert into blocks (blocker_id, blocked_id, created_at) values ($1, $2, $3)`, [x, y, at]);
        oneWay.push({ blocker: x, blocked: y, at });
      }
      const mutual: Array<{ first: string; second: string; at: Date }> = [];
      for (let j = 0; j < 12; j++) {
        const [x, y] = [people[162 + 2 * j]!, people[163 + 2 * j]!];
        const [first, second] = j % 2 ? [x, y] : [y, x];
        const at = new Date(t0 + 1_000_000 + j * 1000);
        await client.query(`insert into blocks (blocker_id, blocked_id, created_at) values ($1, $2, $3), ($2, $1, $4)`, [first, second, at, new Date(at.getTime() + 500)]);
        mutual.push({ first, second, at });
      }
      // Three rows that name an Agent: a person blocking one, twice, and an Agent blocking a person.
      const owner = people[0]!;
      const agent = (await one(`insert into principals (kind, handle, display_name, owner_id) values ('agent', 'bbbot', 'bbbot', $1) returning id`, [owner]))[0]!.id as string;
      await client.query(`insert into agents (principal_id) values ($1)`, [agent]);
      const agent2 = (await one(`insert into principals (kind, handle, display_name, owner_id) values ('agent', 'bbbot2', 'bbbot2', $1) returning id`, [owner]))[0]!.id as string;
      await client.query(`insert into agents (principal_id) values ($1)`, [agent2]);
      await client.query(`insert into blocks (blocker_id, blocked_id) values ($1, $2), ($3, $2), ($2, $4)`, [people[10]!, agent, people[11]!, people[12]!]);
      await client.query(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [agent2, people[13]!]);
      expect((await one(`select count(*)::int n from blocks`))[0]!.n).toBe(105 + 4);
      await client.query(backfill);
      // One row per block between people: 81 one way, and both directions of the 12 mutual pairs.
      expect((await one(`select count(*)::int n from access_bars`))[0]!.n).toBe(81 + 24);
      expect((await one(`select count(*)::int n from access_bars where kind <> 'block'`))[0]!.n).toBe(0);
      for (const m of mutual) {
        expect((await one(`select setter_id, other_id, kind, since from access_bars where setter_id = $1 and other_id = $2`, [m.first, m.second]))[0]).toEqual({ setter_id: m.first, other_id: m.second, kind: "block", since: m.at });
        expect((await one(`select setter_id, other_id, kind from access_bars where setter_id = $1 and other_id = $2`, [m.second, m.first]))[0]).toEqual({ setter_id: m.second, other_id: m.first, kind: "block" });
      }
      for (const w of oneWay) {
        expect((await one(`select kind, since from access_bars where setter_id = $1 and other_id = $2`, [w.blocker, w.blocked]))[0]).toEqual({ kind: "block", since: w.at });
        expect((await one(`select count(*)::int n from access_bars where setter_id = $1 and other_id = $2`, [w.blocked, w.blocker]))[0]!.n).toBe(0);
      }
      expect((await one(`select count(*)::int n from access_bars b where exists (select 1 from principals p where p.id in (b.setter_id, b.other_id) and p.kind = 'agent')`))[0]!.n).toBe(0);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  test("a report is an Agent report until a later migration widens target_kind", async () => {
    const reporter = await human();
    const owner = await human();
    const agent = await agentOf(owner);
    const report = (o: Record<string, unknown>) =>
      db.query(`insert into agent_reports (reporter_id, target_kind, agent_id, message_id, reason) values ($1, $2, $3, $4, 'spam')`, [reporter, o.target_kind ?? "agent", "agent_id" in o ? o.agent_id : agent, o.message_id ?? null]);
    await expect(report({ target_kind: "message", message_id: 1 })).rejects.toThrow(/agent_reports_target_kind_check/);
    await expect(report({ target_kind: "agent", agent_id: null })).rejects.toThrow(/agent_reports_agent_shape/);
    await db.query(`insert into agent_reports (reporter_id, target_kind, agent_id, reason, note) values ($1, 'agent', $2, 'other', $3)`, [reporter, agent, "x".repeat(500)]);
    await expect(db.query(`insert into agent_reports (reporter_id, target_kind, agent_id, reason, note) values ($1, 'agent', $2, 'other', $3)`, [reporter, agent, "x".repeat(501)])).rejects.toThrow(/check/);
    await expect(db.query(`insert into agent_reports (reporter_id, target_kind, agent_id, reason) values ($1, 'agent', $2, 'rude')`, [reporter, agent])).rejects.toThrow(/check/);
    // A reported Agent's principal cannot be removed from under its reports.
    await expect(db.query(`delete from principals where id = $1`, [agent])).rejects.toThrow(/foreign key|violates/);
  });

  test("whose bar ended a row is recorded only on a row ended `barred` (A-4 review m4); the aid's due Agents have an index", async () => {
    const owner = await human();
    const person = await human();
    const agent = await agentOf(owner);
    const row = (o: { state: string; reason: string | null; by: string | null }) =>
      db.query(
        `insert into agent_contacts (agent_id, subject_id, person_id, state, basis, end_reason, barred_by) values ($1, $2, $2, $3, case when $3 = 'live' then 'approved' end, $4, $5)
         on conflict (agent_id, subject_id) do update set state = excluded.state, basis = excluded.basis, end_reason = excluded.end_reason, barred_by = excluded.barred_by`,
        [agent, person, o.state, o.reason, o.by],
      );
    await expect(row({ state: "ended", reason: "left", by: owner })).rejects.toThrow(/agent_contacts_barred_by_check/);
    await expect(row({ state: "live", reason: null, by: owner })).rejects.toThrow(/check/);
    await row({ state: "ended", reason: "barred", by: owner });
    await row({ state: "ended", reason: "barred", by: null });
    expect((await db.query(`select 1 from pg_indexes where indexname = 'agents_persona_due_idx'`)).rowCount).toBe(1);
  });

  test("a card has one answer", async () => {
    const owner = await human();
    const { rows: c } = await db.query<{ id: string }>(`insert into conversations (type, creator_id) values ('agent', $1) returning id`, [owner]);
    const msg = async (seq: number) =>
      (await db.query<{ id: string }>(`insert into messages (conversation_id, seq, sender_id, kind, body) values ($1, $2, $3, 'system', '{}'::jsonb) returning id`, [c[0]!.id, seq, owner])).rows[0]!.id;
    const m = await msg(1);
    const m2 = await msg(2);
    const cardAnswer = (id: string, answer: string) => db.query(`insert into social_card_answers (message_id, answer) values ($1, $2)`, [id, answer]);
    await cardAnswer(m, "moved");
    await expect(cardAnswer(m, "kept")).rejects.toThrow(/social_card_answers_pkey/);
    await expect(cardAnswer(m2, "maybe")).rejects.toThrow(/check/);
  });

  // 075 is applied to a live site and can never be edited again: on tables with rows, the old code's rows survive it untouched, a
  // persona saved before the aid is NOT marked as checked (A-4 review I2, reversing M11), and the blocks become bars (the pattern of 073's test: Down, the old
  // code's rows, Up, inside one transaction that is rolled back).
  test("on populated tables nothing old changes (down, rows crossing 10 and 100, up; rolled back)", async () => {
    const [up, down] = readFileSync(FILE, "utf8").split("-- Down Migration");
    const NEW_COLUMNS: Record<string, string[]> = { agents: ["contact_policy", "contact_picked", "disabled_at", "persona_checked_version"] };
    const client = await db.pool.connect();
    const one = async (q: string, p: unknown[] = []) => (await client.query(q, p)).rows as Array<Record<string, any>>;
    const rows = async () => {
      const out: Record<string, unknown> = {};
      for (const t of ["principals", "agents", "blocks", "conversations", "memberships", "messages"]) {
        out[t] = (await one(`select count(*)::int n, md5(coalesce(string_agg((to_jsonb(x) - $1::text[])::text, '|' order by (to_jsonb(x) - $1::text[])::text), '')) h from ${t} x`, [NEW_COLUMNS[t] ?? []]))[0];
      }
      return out;
    };
    try {
      await client.query("begin");
      await client.query(down!);
      const people: string[] = [];
      for (let i = 0; i < 105; i++) {
        await client.query(`insert into "user" (id, name, email, "emailVerified") values ($1::text, $1::text, $1::text || '@example.test', true)`, [`auth-pop_${i}`]);
        people.push((await one(`insert into principals (kind, handle, display_name, auth_user_id) values ('human', $1::citext, $1::text, 'auth-' || $1::text) returning id`, [`pop_${i}`]))[0]!.id);
      }
      for (let i = 0; i < 12; i++) {
        const p = await one(`insert into principals (kind, handle, display_name, owner_id) values ('agent', $1::citext, $1::text, $2) returning id`, [`popbot_${i}`, people[i % 3]]);
        await client.query(`insert into agents (principal_id, persona_version) values ($1, $2)`, [p[0]!.id, i * 9]);
      }
      for (let i = 0; i < 50; i++) await client.query(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [people[i]!, people[i + 50]!]);
      for (let i = 0; i < 105; i++) {
        const c = await one(`insert into conversations (type, creator_id) values ($1, $2) returning id`, [["direct", "group", "agent"][i % 3], people[i]]);
        await client.query(`insert into messages (conversation_id, seq, sender_id, kind, body) values ($1, 1, $2, 'system', '{}'::jsonb)`, [c[0]!.id, people[i]]);
      }
      const old = await rows();
      expect(old).toMatchObject({ principals: { n: 117 }, agents: { n: 12 }, blocks: { n: 50 }, conversations: { n: 105 }, messages: { n: 105 } });
      await client.query(up!.replace("-- Up Migration", ""));
      expect(await rows()).toEqual(old);
      expect((await one(`select count(*)::int n from access_bars where kind = 'block'`))[0]!.n).toBe(50);
      // A-4 review I2 (reversing attack M11): no persona that exists is marked as checked; the worker reads each at its pace once the switch is on.
      expect(await one(`select count(*)::int n from agents where persona_checked_version <> 0`)).toEqual([{ n: 0 }]);
      expect(await one(`select count(*)::int n from agents where persona_version > persona_checked_version`)).toEqual([{ n: 11 }]);
      expect(await one(`select count(*)::int n from agents where contact_policy <> 'ask' or contact_picked or disabled_at is not null`)).toEqual([{ n: 0 }]);
      expect(await one(`select (select count(*)::int from agent_reports) r, (select count(*)::int from agent_contact_picks) p, (select count(*)::int from social_card_answers) c`)).toEqual([{ r: 0, p: 0, c: 0 }]);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});
