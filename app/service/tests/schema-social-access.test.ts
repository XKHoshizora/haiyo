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

  test("a bar is one row per pair, set by one of the two", async () => {
    const a = await human();
    const b = await human();
    const third = await human();
    const [lo, hi] = [a, b].sort() as [string, string];
    const bar = (o: Partial<{ lo: string; hi: string; reason: string; set_by: string; by_block: boolean }> = {}) =>
      db.query(`insert into access_bars (lo_id, hi_id, reason, set_by, by_block) values ($1, $2, $3, $4, $5)`, [o.lo ?? lo, o.hi ?? hi, o.reason ?? "stopped", o.set_by ?? lo, o.by_block ?? false]);
    await expect(bar({ lo: hi, hi: lo })).rejects.toThrow(/check/);
    await expect(bar({ set_by: third })).rejects.toThrow(/check/);
    await expect(bar({ reason: "paused" })).rejects.toThrow(/check/);
    await expect(bar({ by_block: true, reason: "unfriended" })).rejects.toThrow(/check/);
    await bar({});
    await expect(bar({})).rejects.toThrow(/access_bars_pkey/);
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
  test("bars from blocks (Controller ruling 2026-11-24, Q4): one bar per blocked pair", async () => {
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
      expect((await one(`select count(*)::int n from access_bars`))[0]!.n).toBe(81 + 12);
      for (const m of mutual) {
        const [lo, hi] = [m.first, m.second].sort();
        expect((await one(`select reason, by_block, set_by, since from access_bars where lo_id = $1 and hi_id = $2`, [lo, hi]))[0]).toEqual({ reason: "stopped", by_block: true, set_by: m.first, since: m.at });
      }
      for (const w of oneWay) {
        const [lo, hi] = [w.blocker, w.blocked].sort();
        expect((await one(`select reason, by_block, set_by, since from access_bars where lo_id = $1 and hi_id = $2`, [lo, hi]))[0]).toEqual({ reason: "stopped", by_block: true, set_by: w.blocker, since: w.at });
      }
      expect((await one(`select count(*)::int n from access_bars b where exists (select 1 from principals p where p.id in (b.lo_id, b.hi_id) and p.kind = 'agent')`))[0]!.n).toBe(0);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  // M10 of block 1's review: a pair that blocked each other at one instant. The bar's setter is the lower blocker id, in either insert order.
  test("bars from blocks: a tie in time goes to the lower blocker id", async () => {
    const sql = readFileSync(FILE, "utf8");
    const backfill = sql.slice(sql.indexOf("-- bars from blocks begin"), sql.indexOf("-- bars from blocks end"));
    const client = await db.pool.connect();
    const one = async (q: string, p: unknown[] = []) => (await client.query(q, p)).rows as Array<Record<string, any>>;
    try {
      await client.query("begin");
      const at = new Date("2026-03-03T03:03:03Z");
      const pairs: Array<{ lo: string; hi: string }> = [];
      for (let i = 0; i < 12; i++) {
        const ids: string[] = [];
        for (const k of [0, 1]) {
          await client.query(`insert into "user" (id, name, email, "emailVerified") values ($1::text, $1::text, $1::text || '@example.test', true)`, [`auth-tie_${i}_${k}`]);
          ids.push((await one(`insert into principals (kind, handle, display_name, auth_user_id) values ('human', $1::citext, $1::text, 'auth-' || $1::text) returning id`, [`tie_${i}_${k}`]))[0]!.id);
        }
        const [lo, hi] = ids.sort() as [string, string];
        pairs.push({ lo, hi });
        const rows = i % 2 ? [[lo, hi], [hi, lo]] : [[hi, lo], [lo, hi]];
        for (const [x, y] of rows) await client.query(`insert into blocks (blocker_id, blocked_id, created_at) values ($1, $2, $3)`, [x, y, at]);
      }
      await client.query(backfill);
      for (const { lo, hi } of pairs) {
        expect((await one(`select set_by, since from access_bars where lo_id = $1 and hi_id = $2`, [lo, hi]))[0]).toEqual({ set_by: lo, since: at });
      }
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
  // persona saved before the aid counts as checked (attack M11), and the blocks become bars (the pattern of 073's test: Down, the old
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
      expect((await one(`select count(*)::int n from access_bars where by_block and reason = 'stopped'`))[0]!.n).toBe(50);
      expect(await one(`select count(*)::int n from agents where persona_checked_version <> persona_version`)).toEqual([{ n: 0 }]);
      expect(await one(`select count(*)::int n from agents where contact_policy <> 'ask' or contact_picked or disabled_at is not null`)).toEqual([{ n: 0 }]);
      expect(await one(`select (select count(*)::int from agent_reports) r, (select count(*)::int from agent_contact_picks) p, (select count(*)::int from social_card_answers) c`)).toEqual([{ r: 0, p: 0, c: 0 }]);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});
