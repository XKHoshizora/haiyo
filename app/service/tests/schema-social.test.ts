import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { useApp } from "./helpers/harness.ts";

// Migration 073: columns for others' use and the empty skeleton of Agent social. It is completely inert (plan T0.1):
// the working branch is deployed after every merge, so 073 is applied on a live site and can never be edited again.
describe("073: others' columns and the social skeleton", () => {
  const { db } = useApp({ agentWorker: false });

  async function human(handle: string): Promise<string> {
    await db.query(`insert into "user" (id, name, email, "emailVerified") values ($1::text, $1::text, $1::text || '@example.test', true)`, [`auth-${handle}`]);
    const { rows } = await db.query<{ id: string }>(
      `insert into principals (kind, handle, display_name, auth_user_id) values ('human', $1::citext, $1::text, 'auth-' || $1::text) returning id`,
      [handle],
    );
    return rows[0]!.id;
  }
  async function agentPrincipal(owner: string, handle: string): Promise<string> {
    const { rows } = await db.query<{ id: string }>(`insert into principals (kind, handle, display_name, owner_id) values ('agent', $1::citext, $1::text, $2) returning id`, [handle, owner]);
    await db.query(`insert into agents (principal_id) values ($1)`, [rows[0]!.id]);
    return rows[0]!.id;
  }
  async function conversation(type: string, creator: string): Promise<string> {
    const { rows } = await db.query<{ id: string }>(`insert into conversations (type, creator_id) values ($1, $2) returning id`, [type, creator]);
    return rows[0]!.id;
  }
  async function columnDefault(table: string, column: string): Promise<string | null> {
    const { rows } = await db.query<{ d: string | null }>(`select column_default as d from information_schema.columns where table_name = $1 and column_name = $2`, [table, column]);
    return rows[0]!.d;
  }
  async function count(table: string): Promise<number> {
    return (await db.query<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0]!.n;
  }

  test("knows the social conversation type and keeps a pair once", async () => {
    const visitor = await human("visitor_a");
    const owner = await human("owner_a");
    const agent = await agentPrincipal(owner, "bot_a");
    const [lo, hi] = [visitor, agent].sort();
    const c = await conversation("agent_social", visitor);
    await db.query("insert into social_pairs (conversation_id, a_id, b_id) values ($1, $2, $3)", [c, lo, hi]);
    const c2 = await conversation("agent_social", visitor);
    await expect(db.query("insert into social_pairs (conversation_id, a_id, b_id) values ($1, $2, $3)", [c2, lo, hi])).rejects.toThrow(/social_pairs_a_id_b_id_key/);
    const c3 = await conversation("agent_social", visitor);
    await expect(db.query("insert into social_pairs (conversation_id, a_id, b_id) values ($1, $2, $3)", [c3, hi, lo])).rejects.toThrow(/check/);
    await expect(conversation("channel", visitor)).rejects.toThrow(/conversations_type_check/);
  });

  describe("agent_contacts", () => {
    async function row(o: { state: string; end_reason?: string | null; basis?: string | null; until?: Date | null }) {
      const owner = await human(`o_${Math.random().toString(36).slice(2, 8)}`);
      const subject = await human(`s_${Math.random().toString(36).slice(2, 8)}`);
      const agent = await agentPrincipal(owner, `b_${Math.random().toString(36).slice(2, 8)}`);
      return db.query(`insert into agent_contacts (agent_id, subject_id, person_id, state, basis, until, end_reason) values ($1, $2, $2, $3, $4, $5, $6)`, [
        agent,
        subject,
        o.state,
        o.basis === undefined ? "approved" : o.basis,
        o.until === undefined ? new Date(Date.now() + 86_400_000) : o.until,
        o.end_reason ?? null,
      ]);
    }

    test("a row's state, reason, basis and request deadline agree", async () => {
      await expect(row({ state: "ended", end_reason: null })).rejects.toThrow(/check/);
      await expect(row({ state: "live", basis: null })).rejects.toThrow(/check/);
      await expect(row({ state: "requested", until: null })).rejects.toThrow(/check/);
      await expect(row({ state: "ended", end_reason: "forgotten" })).rejects.toThrow(/check/);
      await expect(row({ state: "live", end_reason: "left" })).rejects.toThrow(/check/);
      await row({ state: "live" });
      await row({ state: "requested", basis: null });
      await row({ state: "ended", end_reason: "barred" });
    });

    test("an Agent is never its own subject, and a row goes with either end", async () => {
      const owner = await human("owner_c");
      const agent = await agentPrincipal(owner, "bot_c");
      await expect(db.query(`insert into agent_contacts (agent_id, subject_id, person_id, state, basis) values ($1, $1, $2, 'live', 'approved')`, [agent, owner])).rejects.toThrow(/check/);
    });
  });

  test("runs take the four new interruptions and nothing else", async () => {
    const owner = await human("owner_r");
    const agent = await agentPrincipal(owner, "bot_r");
    const c = await conversation("agent", owner);
    const setInterrupted = (reason: string) =>
      db.query(`insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, interrupted) values ('reply', $1, $2, $3, 'done', 1, $4)`, [c, agent, owner, reason]);
    for (const r of ["agent_paused", "agent_deleted", "agent_removed", "halted", "owner_spoke", "access_ended", "notes_changed", "errand_ended"]) {
      await expect(setInterrupted(r)).resolves.toBeDefined();
    }
    await expect(setInterrupted("visitor_left")).rejects.toThrow(/agent_runs_interrupted_check/);
    // The new columns of a run are null until a lane writes them.
    expect((await db.query(`select admitted_at, shown_notes, withheld_notes from agent_runs limit 1`)).rows[0]).toEqual({ admitted_at: null, shown_notes: null, withheld_notes: null });
  });

  test("numbers in range", async () => {
    const owner = await human("owner_n");
    const agent = await agentPrincipal(owner, "bot_n");
    await db.query(`insert into accounts (principal_id) values ($1)`, [owner]);
    expect((await db.query(`select others_answers, others_points_micro, others_notice_seen_at from accounts`)).rows).toEqual([{ others_answers: null, others_points_micro: null, others_notice_seen_at: null }]);
    await expect(db.query("update accounts set others_answers = 0 where principal_id = $1", [owner])).rejects.toThrow(/check/);
    await expect(db.query("update accounts set others_answers = 1001 where principal_id = $1", [owner])).rejects.toThrow(/check/);
    await expect(db.query("update accounts set others_points_micro = 999999 where principal_id = $1", [owner])).rejects.toThrow(/check/);
    await expect(db.query("update accounts set others_points_micro = 100000000001 where principal_id = $1", [owner])).rejects.toThrow(/check/);
    await expect(db.query("update agents set others_answers = 0 where principal_id = $1", [agent])).rejects.toThrow(/check/);
    await db.query("update accounts set others_answers = 1000, others_points_micro = 1000000 where principal_id = $1", [owner]);
    await db.query("update agents set others_answers = 1 where principal_id = $1", [agent]);
  });

  // 073 is applied to a live site at the merge and can never be edited again, so this is the proof that it is inert: on tables with
  // rows, whatever migration is the latest (the pattern of money-wallet.test.ts, 066's: split the file, run its Down, write the old
  // code's rows, run its Up, all inside one transaction that is rolled back).
  test("on populated tables nothing changes: every old row, the shape and the defaults are as they were (down, rows crossing 10 and 100, up; rolled back)", async () => {
    const sql = readFileSync(new URL("../migrations/073_others_columns_and_social_skeleton.sql", import.meta.url), "utf8");
    const [up, down] = sql.split("-- Down Migration");
    const NEW_COLUMNS: Record<string, string[]> = {
      accounts: ["others_answers", "others_points_micro", "others_notice_seen_at"],
      agents: ["others_answers"],
      agent_runs: ["admitted_at", "shown_notes", "withheld_notes"],
    };
    const client = await db.pool.connect();
    const one = async (q: string, p: unknown[] = []) => (await client.query(q, p)).rows as Array<Record<string, any>>;
    /** Count and a hash of every row of a table, its 073 columns left out. */
    const rows = async () => {
      const out: Record<string, unknown> = {};
      for (const t of ["principals", "accounts", "agents", "conversations", "agent_runs", "memberships"]) {
        out[t] = (await one(`select count(*)::int n, md5(coalesce(string_agg((to_jsonb(x) - $1::text[])::text, '|' order by (to_jsonb(x) - $1::text[])::text), '')) h from ${t} x`, [NEW_COLUMNS[t] ?? []]))[0];
      }
      return out;
    };
    /** Everything 073 could touch: columns with their defaults, the checks, the indexes. */
    const shape = async () => ({
      columns: await one(`select table_name t, column_name c, column_default d, is_nullable n from information_schema.columns where table_schema = 'public' order by 1, 2`),
      checks: await one(`select conrelid::regclass::text t, conname, pg_get_constraintdef(oid) d from pg_constraint where connamespace = 'public'::regnamespace and contype = 'c' order by 1, 2`),
      indexes: await one(`select indexname, indexdef from pg_indexes where schemaname = 'public' order by 1`),
    });
    try {
      await client.query("begin");
      const before = await shape();
      await client.query(down!);
      // The old code's rows: 105 people with accounts, 12 Agents (no budget, 5 points, the old default 20), 105 conversations of
      // the three old types and 105 runs in every lane and with every old interruption.
      const people: string[] = [];
      for (let i = 0; i < 105; i++) {
        await client.query(`insert into "user" (id, name, email, "emailVerified") values ($1::text, $1::text, $1::text || '@example.test', true)`, [`auth-usr_${i}`]);
        const p = await one(`insert into principals (kind, handle, display_name, auth_user_id) values ('human', $1::citext, $1::text, 'auth-' || $1::text) returning id`, [`usr_${i}`]);
        people.push(p[0]!.id);
        await client.query(`insert into accounts (principal_id, balance_micro) values ($1, $2)`, [p[0]!.id, i * 1000]);
      }
      const agents: Array<{ id: string; owner: string }> = [];
      for (let i = 0; i < 12; i++) {
        const p = await one(`insert into principals (kind, handle, display_name, owner_id) values ('agent', $1::citext, $1::text, $2) returning id`, [`bot_${i}`, people[i % 3]]);
        await client.query(`insert into agents (principal_id, others_budget_micro) values ($1, $2)`, [p[0]!.id, i % 4 === 0 ? null : i % 4 === 1 ? 20_000_000 : 5_000_000]);
        agents.push({ id: p[0]!.id, owner: people[i % 3]! });
      }
      const reasons = [null, "agent_paused", "agent_deleted", "agent_removed", "halted"];
      for (let i = 0; i < 105; i++) {
        const c = await one(`insert into conversations (type, creator_id) values ($1, $2) returning id`, [["direct", "group", "agent"][i % 3], people[i]]);
        const a = agents[i % 12]!;
        await client.query(
          `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, interrupted, lane) values ('reply', $1, $2, $3, 'done', $4, $5, $6)`,
          [c[0]!.id, a.id, a.owner, i + 1, reasons[i % 5], ["own", "others", "proactive"][i % 3]],
        );
      }
      const old = await rows();
      expect(old).toMatchObject({ principals: { n: 117 }, accounts: { n: 105 }, agents: { n: 12 }, conversations: { n: 105 }, agent_runs: { n: 105 } });
      await client.query(up!.replace("-- Up Migration", ""));
      // What a later migration added to a table 073 makes (075: `agent_contacts.barred_by` and its check) went with the table in the Down:
      // it is put back with 075's own statement, so that the shape compared is the live one.
      const later = /alter table agent_contacts add column barred_by[^;]*;/.exec(readFileSync(new URL("../migrations/075_agent_social_access.sql", import.meta.url), "utf8"));
      expect(later).not.toBeNull();
      await client.query(later![0]);
      expect(await rows()).toEqual(old);
      expect(await shape()).toEqual(before);
      // 074 (lane B) dropped 020's default of 20 points: it is whatever the live database has, which 073 does not touch.
      expect((await one(`select column_default d from information_schema.columns where table_name = 'agents' and column_name = 'others_budget_micro'`))[0]).toEqual({ d: null });
      expect(
        await one(`select (select count(*)::int from social_pairs) pairs, (select count(*)::int from agent_contacts) contacts,
                          (select count(*)::int from agent_runs where admitted_at is not null or shown_notes is not null or withheld_notes is not null) runs,
                          (select count(*)::int from accounts where others_answers is not null or others_points_micro is not null or others_notice_seen_at is not null) accounts,
                          (select count(*)::int from agents where others_answers is not null) agents`),
      ).toEqual([{ pairs: 0, contacts: 0, runs: 0, accounts: 0, agents: 0 }]);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  test("is inert: the skeleton is empty, and no existing row or default changed", async () => {
    for (const t of ["social_pairs", "agent_contacts"]) expect(await count(t)).toBe(0);
    expect(await columnDefault("agents", "others_budget_micro")).toBeNull(); // 074 (B4) dropped the 20-point default; 073 does not touch it
    expect(await columnDefault("agents", "others_answers")).toBeNull();
    expect(await columnDefault("accounts", "others_answers")).toBeNull();
    expect(await columnDefault("accounts", "others_points_micro")).toBeNull();
    expect(await columnDefault("agent_runs", "admitted_at")).toBeNull();
  });
});
