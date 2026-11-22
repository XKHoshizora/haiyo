import { describe, expect, test } from "vitest";
import { useApp } from "./helpers/harness.ts";

const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

describe("agent, provider, metering and run tables", () => {
  // Queued reply runs are inserted by hand here: no reply worker may pick them up.
  const { db } = useApp({ agentWorker: false });

  async function human(handle: string): Promise<string> {
    await db.query(
      `insert into "user" (id, name, email, "emailVerified") values ($1::text, $1::text, $1::text || '@example.test', true)`,
      [`auth-${handle}`],
    );
    const { rows } = await db.query<{ id: string }>(
      `insert into principals (kind, handle, display_name, auth_user_id)
       values ('human', $1::citext, $1::text, 'auth-' || $1::text) returning id`,
      [handle],
    );
    return rows[0]!.id;
  }

  async function agentPrincipal(owner: string, handle: string): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `insert into principals (kind, handle, display_name, owner_id) values ('agent', $1::citext, $1::text, $2) returning id`,
      [handle, owner],
    );
    return rows[0]!.id;
  }

  async function provider(owner: string, name = "mine"): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `insert into providers (owner_id, name, protocol, base_url, key_cipher, key_last4)
       values ($1, $2, 'openai_chat', 'https://api.example.test/v1', '\\x00', 'abcd') returning id`,
      [owner, name],
    );
    return rows[0]!.id;
  }

  async function rejectedWith(code: string, sql: string, params: unknown[] = []): Promise<void> {
    // `code` may name several (a|b): Postgres 18 reports a delete refused by `on delete restrict` as 23001, earlier versions as 23503.
    await expect(db.query(sql, params)).rejects.toMatchObject({ code: expect.stringMatching(new RegExp(`^(${code})$`)) });
  }

  test("an agents row for a human principal is rejected; for an agent principal it gets its defaults", async () => {
    const owner = await human("owner_a");
    await rejectedWith(FOREIGN_KEY_VIOLATION, `insert into agents (principal_id) values ($1)`, [owner]);
    const agent = await agentPrincipal(owner, "bot_a");
    await db.query(`insert into agents (principal_id) values ($1)`, [agent]);
    const { rows } = await db.query(
      `select intro, field, persona, persona_version, reply_mode, group_mentions, reasoning, model_source, paused, deleted_at,
              chain_budget_micro::text as chain_budget_micro from agents`,
    );
    expect(rows).toEqual([
      {
        intro: "",
        field: "",
        persona: "",
        persona_version: 0,
        reply_mode: "always",
        group_mentions: "members",
        reasoning: "none",
        model_source: null,
        paused: false,
        deleted_at: null,
        chain_budget_micro: "50000000",
      },
    ]);
  });

  test("chain_budget_micro is from 1 to 100 000 points in micro-points, never null", async () => {
    const owner = await human("owner_cb");
    const insert = async (handle: string, value: unknown) =>
      db.query(`insert into agents (principal_id, chain_budget_micro) values ($1, $2)`, [await agentPrincipal(owner, handle), value]);
    await insert("cb_low", "1000000");
    await insert("cb_high", "100000000000");
    for (const [handle, value] of [["cb_under", "999999"], ["cb_zero", "0"], ["cb_over", "100000000001"], ["cb_minus", "-1"]] as const) {
      await expect(insert(handle, value)).rejects.toMatchObject({ code: CHECK_VIOLATION });
    }
    await expect(insert("cb_null", null)).rejects.toMatchObject({ code: "23502" });
  });

  test("proactive is off, proactive_level normal and proactive_budget_micro 20 points by default; the level is one of three, the budget from 1 to 100 000 points", async () => {
    const owner = await human("owner_pr");
    const insert = async (handle: string, column: string, value: unknown) =>
      db.query(`insert into agents (principal_id, ${column}) values ($1, $2)`, [await agentPrincipal(owner, handle), value]);
    await db.query(`insert into agents (principal_id) values ($1)`, [await agentPrincipal(owner, "pr_default")]);
    expect(
      (await db.query(`select proactive, proactive_level, proactive_budget_micro::text as budget from agents`)).rows,
    ).toEqual([{ proactive: false, proactive_level: "normal", budget: "20000000" }]);
    for (const level of ["less", "normal", "more"]) await insert(`pr_${level}`, "proactive_level", level);
    await insert("pr_low", "proactive_budget_micro", "1000000");
    await insert("pr_high", "proactive_budget_micro", "100000000000");
    for (const [handle, column, value] of [
      ["pr_bad_level", "proactive_level", "most"],
      ["pr_under", "proactive_budget_micro", "999999"],
      ["pr_zero", "proactive_budget_micro", "0"],
      ["pr_over", "proactive_budget_micro", "100000000001"],
    ] as const) {
      await expect(insert(handle, column, value)).rejects.toMatchObject({ code: CHECK_VIOLATION });
    }
    for (const [n, column] of ["proactive", "proactive_level", "proactive_budget_micro"].entries()) {
      await expect(insert(`pr_null_${n}`, column, null)).rejects.toMatchObject({ code: "23502" });
    }
  });

  test("others_budget_micro is 20 points by default, from 1 to 100 000 points in micro-points, or null for no limit", async () => {
    const owner = await human("owner_ob");
    const insert = async (handle: string, value: unknown) =>
      db.query(`insert into agents (principal_id, others_budget_micro) values ($1, $2)`, [await agentPrincipal(owner, handle), value]);
    await db.query(`insert into agents (principal_id) values ($1)`, [await agentPrincipal(owner, "ob_default")]);
    await insert("ob_low", "1000000");
    await insert("ob_high", "100000000000");
    await insert("ob_null", null);
    for (const [handle, value] of [["ob_under", "999999"], ["ob_zero", "0"], ["ob_over", "100000000001"], ["ob_minus", "-1"]] as const) {
      await expect(insert(handle, value)).rejects.toMatchObject({ code: CHECK_VIOLATION });
    }
    const { rows } = await db.query(
      `select p.handle::text as handle, a.others_budget_micro::text as budget from agents a join principals p on p.id = a.principal_id order by p.handle`,
    );
    expect(rows).toEqual([
      { handle: "ob_default", budget: "20000000" },
      { handle: "ob_high", budget: "100000000000" },
      { handle: "ob_low", budget: "1000000" },
      { handle: "ob_null", budget: null },
    ]);
  });

  test("owner_appellation is null or 1 to 20 characters; agent_appellations are one per target, never for the Agent itself, and go with either end", async () => {
    const owner = await human("owner_ap");
    const insert = async (handle: string, value: unknown) =>
      db.query(`insert into agents (principal_id, owner_appellation) values ($1, $2)`, [await agentPrincipal(owner, handle), value]);
    await insert("ap_null", null);
    await insert("ap_one", "一");
    await insert("ap_twenty", "一".repeat(20));
    await expect(insert("ap_empty", "")).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(insert("ap_long", "一".repeat(21))).rejects.toMatchObject({ code: CHECK_VIOLATION });

    const agent = await agentPrincipal(owner, "ap_bot");
    await db.query(`insert into agents (principal_id) values ($1)`, [agent]);
    const target = await human("target_ap");
    const name = (principalId: string, appellation: string) =>
      db.query(`insert into agent_appellations (agent_id, principal_id, appellation) values ($1, $2, $3)`, [agent, principalId, appellation]);
    await name(target, "好友");
    await rejectedWith(UNIQUE_VIOLATION, `insert into agent_appellations (agent_id, principal_id, appellation) values ($1, $2, 'x')`, [agent, target]);
    await expect(name(owner, "")).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(name(owner, "一".repeat(21))).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(name(agent, "自己")).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await rejectedWith(FOREIGN_KEY_VIOLATION, `insert into agent_appellations (agent_id, principal_id, appellation) values ($1, $2, 'x')`, [owner, target]);
    await db.query(`delete from principals where id = $1`, [target]);
    expect((await db.query(`select 1 from agent_appellations`)).rowCount).toBe(0);
  });

  test("agent_group_state is one row per Agent and group, goes with either end, and refuses negative numbers", async () => {
    const owner = await human("owner_gs");
    const agent = await agentPrincipal(owner, "gs_bot");
    const group = async () =>
      (await db.query<{ id: string }>(`insert into conversations (type, creator_id) values ('group', $1) returning id`, [owner])).rows[0]!.id;
    const [one, two] = [await group(), await group()];
    const insert = (conversation: string, cols = "", vals = "") =>
      db.query(`insert into agent_group_state (agent_id, conversation_id${cols}) values ($1, $2${vals})`, [agent, conversation]);
    await insert(one);
    expect((await db.query(`select surcharge, quiet, quiet_half_life_s, judged_at from agent_group_state`)).rows).toEqual([
      { surcharge: 0, quiet: 0, quiet_half_life_s: null, judged_at: null },
    ]);
    await expect(insert(one)).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
    await expect(insert(two, ", surcharge", ", -0.1")).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(insert(two, ", quiet", ", -0.1")).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(insert(two, ", quiet_half_life_s", ", 0")).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await insert(two, ", quiet, quiet_half_life_s", ", 0.5, 3600");
    await rejectedWith(FOREIGN_KEY_VIOLATION, `insert into agent_group_state (agent_id, conversation_id) values ($1, $2)`, [agent, agent]);
    await rejectedWith(FOREIGN_KEY_VIOLATION, `insert into agent_group_state (agent_id, conversation_id) values ($1, $2)`, [one, one]);
    await db.query(`delete from conversations where id = $1`, [one]);
    expect((await db.query(`select conversation_id from agent_group_state`)).rows).toEqual([{ conversation_id: two }]);
    await db.query(`delete from principals where id = $1`, [agent]);
    expect((await db.query(`select 1 from agent_group_state`)).rowCount).toBe(0);
  });

  test("judge_usage is one row per day, starting at no calls, never below none", async () => {
    await db.query(`insert into judge_usage (day) values ('2026-11-19')`);
    expect((await db.query(`select day::text as day, calls from judge_usage`)).rows).toEqual([{ day: "2026-11-19", calls: 0 }]);
    await rejectedWith(UNIQUE_VIOLATION, `insert into judge_usage (day, calls) values ('2026-11-19', 1)`);
    await rejectedWith(CHECK_VIOLATION, `insert into judge_usage (day, calls) values ('2026-11-20', -1)`);
    await rejectedWith("23502", `insert into judge_usage (day) values (null)`);
  });

  test("conversations.agents_halted_seq is null until a halt sets it", async () => {
    const owner = await human("owner_hs");
    const { rows } = await db.query(`insert into conversations (type, creator_id) values ('group', $1) returning agents_halted_seq`, [owner]);
    expect(rows).toEqual([{ agents_halted_seq: null }]);
  });

  test("group_mentions is 'members' or 'owner', never anything else or null", async () => {
    const owner = await human("owner_gm");
    const insert = async (handle: string, value: unknown) =>
      db.query(`insert into agents (principal_id, group_mentions) values ($1, $2)`, [await agentPrincipal(owner, handle), value]);
    await insert("gm_members", "members");
    await insert("gm_owner", "owner");
    await expect(insert("gm_nobody", "nobody")).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(insert("gm_upper", "Owner")).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(insert("gm_null", null)).rejects.toMatchObject({ code: "23502" });
    expect((await db.query(`select group_mentions from agents order by group_mentions`)).rows).toEqual([
      { group_mentions: "members" },
      { group_mentions: "owner" },
    ]);
  });

  test("the model columns must agree with model_source", async () => {
    const owner = await human("owner_b");
    const prov = await provider(owner);
    const insert = async (handle: string, cols: string, vals: string, params: unknown[] = []) => {
      const id = await agentPrincipal(owner, handle);
      return db.query(`insert into agents (principal_id, ${cols}) values ($1, ${vals})`, [id, ...params]);
    };
    await expect(insert("bad_site_prov", "model_source, site_model_id, provider_id", `'site', 'fast', $2`, [prov])).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(insert("bad_site_none", "model_source", `'site'`)).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(insert("bad_prov_none", "model_source", `'provider'`)).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(insert("bad_prov_site", "model_source, provider_id, provider_model, site_model_id", `'provider', $2, 'm', 'fast'`, [prov])).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(insert("bad_null_src", "site_model_id", `'fast'`)).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(insert("bad_mode", "reply_mode", `'sometimes'`)).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await insert("good_site", "model_source, site_model_id", `'site', 'fast'`);
    await insert("good_prov", "model_source, provider_id, provider_model", `'provider', $2, 'm'`, [prov]);
  });

  test("a provider in use by an agent cannot be deleted; names are unique per owner", async () => {
    const owner = await human("owner_c");
    const other = await human("owner_d");
    const prov = await provider(owner);
    await rejectedWith(
      UNIQUE_VIOLATION,
      `insert into providers (owner_id, name, protocol, base_url, key_cipher, key_last4) values ($1, 'mine', 'gemini', 'https://x.test', '\\x00', 'abcd')`,
      [owner],
    );
    await provider(other); // same name, other owner: fine
    await rejectedWith(
      CHECK_VIOLATION,
      `insert into providers (owner_id, name, protocol, base_url, key_cipher, key_last4) values ($1, 'odd', 'smoke_signal', 'https://x.test', '\\x00', 'abcd')`,
      [owner],
    );
    const agent = await agentPrincipal(owner, "bot_c");
    await db.query(`insert into agents (principal_id, model_source, provider_id, provider_model) values ($1, 'provider', $2, 'm')`, [agent, prov]);
    await rejectedWith(`${FOREIGN_KEY_VIOLATION}|23001`, `delete from providers where id = $1`, [prov]);
  });

  test("conversations.type accepts 'agent'; an agent has one conversation row", async () => {
    const owner = await human("owner_e");
    const agent = await agentPrincipal(owner, "bot_e");
    await db.query(`insert into agents (principal_id) values ($1)`, [agent]);
    const first = await db.query<{ id: string }>(`insert into conversations (type, creator_id) values ('agent', $1) returning id`, [owner]);
    await db.query(`insert into agent_conversations (conversation_id, agent_id, owner_id) values ($1, $2, $3)`, [first.rows[0]!.id, agent, owner]);
    const second = await db.query<{ id: string }>(`insert into conversations (type, creator_id) values ('agent', $1) returning id`, [owner]);
    await rejectedWith(UNIQUE_VIOLATION, `insert into agent_conversations (conversation_id, agent_id, owner_id) values ($1, $2, $3)`, [second.rows[0]!.id, agent, owner]);
    await rejectedWith(CHECK_VIOLATION, `insert into conversations (type, creator_id) values ('channel', $1)`, [owner]);
  });

  test("principals.avatar_version starts at 0", async () => {
    const owner = await human("owner_f");
    expect((await db.query(`select avatar_version from principals where id = $1`, [owner])).rows).toEqual([{ avatar_version: 0 }]);
  });

  test("accounts may go negative (one reply of debt); ledger, usage and free-usage rows keep their shape", async () => {
    const owner = await human("owner_g");
    await db.query(`insert into accounts (principal_id) values ($1)`, [owner]);
    await db.query(`update accounts set balance_micro = -5000000 where principal_id = $1`, [owner]);
    expect((await db.query(`select tier, balance_micro::text as b from accounts`)).rows).toEqual([{ tier: "free", b: "-5000000" }]);
    const usageSql = (outcome: string, purpose = "draft") =>
      `insert into usage_records (owner_id, purpose, source, model, input_tokens, output_tokens, estimated, cost_micro, free_micro, balance_micro, forgiven_micro, outcome)
       values ($1, '${purpose}', 'site', 'fast', 10, 20, false, 70, 0, 70, 0, '${outcome}') returning id::text`;
    const usage = await db.query<{ id: string }>(usageSql("done"), [owner]);
    await db.query(`insert into balance_ledger (owner_id, delta_micro, reason, note, usage_id) values ($1, -70, 'usage', null, $2)`, [owner, usage.rows[0]!.id]);
    await rejectedWith(CHECK_VIOLATION, `insert into balance_ledger (owner_id, delta_micro, reason) values ($1, 1, 'gift')`, [owner]);
    await rejectedWith(CHECK_VIOLATION, usageSql("exploded"), [owner]);
    await rejectedWith(CHECK_VIOLATION, usageSql("done", "chat"), [owner]);
    await db.query(`insert into free_usage (owner_id, day, used_micro) values ($1, '2026-11-16', 5)`, [owner]);
    await rejectedWith(UNIQUE_VIOLATION, `insert into free_usage (owner_id, day, used_micro) values ($1, '2026-11-16', 6)`, [owner]);
    await rejectedWith(FOREIGN_KEY_VIOLATION, `insert into accounts (principal_id) values (gen_random_uuid())`);
  });

  describe("agent_runs and persona_proposals", () => {
    async function setup(): Promise<{ owner: string; agent: string; conversation: string }> {
      const owner = await human("owner_h");
      const agent = await agentPrincipal(owner, "bot_h");
      await db.query(`insert into agents (principal_id) values ($1)`, [agent]);
      const { rows } = await db.query<{ id: string }>(`insert into conversations (type, creator_id) values ('agent', $1) returning id`, [owner]);
      return { owner, agent, conversation: rows[0]!.id };
    }
    const runSql = `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq) values ('reply', $1, $2, $3, $4, 1)`;

    test("two active runs for one agent in one conversation fail on the partial index; a done plus a queued succeed", async () => {
      const { owner, agent, conversation } = await setup();
      await db.query(runSql, [conversation, agent, owner, "done"]);
      await db.query(runSql, [conversation, agent, owner, "queued"]);
      await rejectedWith(UNIQUE_VIOLATION, runSql, [conversation, agent, owner, "running"]);
      await rejectedWith(UNIQUE_VIOLATION, runSql, [conversation, agent, owner, "queued"]);
      await db.query(`update agent_runs set status = 'failed' where status = 'queued'`);
      await db.query(runSql, [conversation, agent, owner, "running"]);
      await rejectedWith(CHECK_VIOLATION, runSql, [conversation, agent, owner, "sleeping"]);
    });

    test("one agent may have an active run in each of two conversations, and another agent one in the same conversation", async () => {
      const { owner, agent, conversation } = await setup();
      const group = (await db.query<{ id: string }>(`insert into conversations (type, creator_id) values ('group', $1) returning id`, [owner])).rows[0]!.id;
      const other = await agentPrincipal(owner, "bot_h2");
      await db.query(`insert into agents (principal_id) values ($1)`, [other]);
      await db.query(runSql, [conversation, agent, owner, "running"]);
      await db.query(runSql, [group, agent, owner, "running"]);
      await db.query(runSql, [group, other, owner, "queued"]);
      // Still one per agent and conversation: in the group too.
      await rejectedWith(UNIQUE_VIOLATION, runSql, [group, agent, owner, "queued"]);
      await rejectedWith(UNIQUE_VIOLATION, runSql, [group, other, owner, "running"]);
      expect((await db.query(`select count(*)::int as n from agent_runs where status in ('queued', 'running')`)).rows).toEqual([{ n: 3 }]);
      // Only the new index: the old one-per-agent index is gone.
      const indexes = await db.query<{ indexname: string; indexdef: string }>(
        `select indexname, indexdef from pg_indexes where tablename = 'agent_runs' and indexdef like '%UNIQUE%'`,
      );
      expect(indexes.rows.map((r) => r.indexname).sort()).toEqual(["agent_runs_one_active_per_agent_conversation", "agent_runs_pkey"]);
    });

    test("interrupted is null, agent_paused, agent_deleted, agent_removed or halted", async () => {
      const { owner, agent, conversation } = await setup();
      const interrupted = `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, interrupted)
                           values ('reply', $1, $2, $3, 'done', 1, $4)`;
      for (const reason of [null, "agent_paused", "agent_deleted", "agent_removed", "halted"]) await db.query(interrupted, [conversation, agent, owner, reason]);
      await rejectedWith(CHECK_VIOLATION, interrupted, [conversation, agent, owner, "agent_bored"]);
      await rejectedWith(CHECK_VIOLATION, interrupted, [conversation, agent, owner, "agent_left"]);
      await rejectedWith(CHECK_VIOLATION, interrupted, [conversation, agent, owner, "Halted"]);
    });

    test("triggered_by is 'human' unless set to 'agent', never anything else or null", async () => {
      const { owner, agent, conversation } = await setup();
      await db.query(runSql, [conversation, agent, owner, "done"]);
      const by = `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, triggered_by)
                  values ('reply', $1, $2, $3, 'done', 1, $4)`;
      await db.query(by, [conversation, agent, owner, "agent"]);
      await db.query(by, [conversation, agent, owner, "human"]);
      await rejectedWith(CHECK_VIOLATION, by, [conversation, agent, owner, "bot"]);
      await rejectedWith(CHECK_VIOLATION, by, [conversation, agent, owner, "Agent"]);
      await expect(db.query(by, [conversation, agent, owner, null])).rejects.toMatchObject({ code: "23502" });
      expect((await db.query(`select triggered_by from agent_runs order by triggered_by`)).rows.map((r) => r.triggered_by)).toEqual(["agent", "human", "human"]);
    });

    test("lane is 'own' unless set to 'others' or 'proactive', never anything else or null; caller_id is a principal, or null once it is gone", async () => {
      const { owner, agent, conversation } = await setup();
      await db.query(runSql, [conversation, agent, owner, "done"]);
      const lane = `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, lane, caller_id)
                    values ('reply', $1, $2, $3, 'done', 1, $4, $5)`;
      const caller = await human("caller_h");
      await db.query(lane, [conversation, agent, owner, "others", caller]);
      await db.query(lane, [conversation, agent, owner, "proactive", null]);
      await rejectedWith(CHECK_VIOLATION, lane, [conversation, agent, owner, "x", owner]);
      await rejectedWith(CHECK_VIOLATION, lane, [conversation, agent, owner, "Own", owner]);
      await expect(db.query(lane, [conversation, agent, owner, null, owner])).rejects.toMatchObject({ code: "23502" });
      await rejectedWith(FOREIGN_KEY_VIOLATION, lane, [conversation, agent, owner, "others", "6a0d4c2e-1b3f-4a5e-9c7d-8e9f0a1b2c3d"]);
      const rows = async () => (await db.query(`select lane, caller_id from agent_runs order by lane`)).rows;
      expect(await rows()).toEqual([
        { lane: "others", caller_id: caller },
        { lane: "own", caller_id: null },
        { lane: "proactive", caller_id: null },
      ]);
      await db.query(`delete from principals where id = $1`, [caller]);
      expect((await rows())[0]).toEqual({ lane: "others", caller_id: null });
    });

    test("a reply run needs both conversation and agent; a draft run has neither", async () => {
      const { owner, agent, conversation } = await setup();
      await rejectedWith(CHECK_VIOLATION, `insert into agent_runs (purpose, owner_id, status) values ('reply', $1, 'queued')`, [owner]);
      await rejectedWith(CHECK_VIOLATION, `insert into agent_runs (purpose, agent_id, owner_id, status) values ('reply', $1, $2, 'queued')`, [agent, owner]);
      await rejectedWith(CHECK_VIOLATION, `insert into agent_runs (purpose, conversation_id, owner_id, status) values ('reply', $1, $2, 'queued')`, [conversation, owner]);
      await rejectedWith(CHECK_VIOLATION, `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status) values ('draft', $1, $2, $3, 'running')`, [conversation, agent, owner]);
      await db.query(`insert into agent_runs (purpose, owner_id, status, source, model, charge_to, hold_micro) values ('draft', $1, 'running', 'site', 'fast', 'free', 1000)`, [owner]);
      await db.query(`insert into agent_runs (purpose, owner_id, status) values ('draft', $1, 'running')`, [owner]); // drafts are not limited by the per-agent index
      expect((await db.query(`select hold_micro::text as h from agent_runs order by hold_micro desc`)).rows[0]).toEqual({ h: "1000" });
    });

    test("a run's recorded model: source and model together, and a charge exactly when it is a site model's call", async () => {
      const { owner } = await setup();
      const draft = (cols: string, vals: string) =>
        `insert into agent_runs (purpose, owner_id, status, ${cols}) values ('draft', $1, 'running', ${vals})`;
      for (const [cols, vals] of [
        ["source", "'site'"], // no model
        ["model", "'fast'"], // no source
        ["source, model", "'cloud', 'fast'"],
        ["source, model", "'site', 'fast'"], // a site call charged to nothing
        ["source, model, charge_to", "'provider', 'm', 'free'"], // a provider call charged
        ["charge_to", "'balance'"], // charged without a model
      ] as const) {
        await rejectedWith(CHECK_VIOLATION, draft(cols, vals), [owner]);
      }
      await db.query(draft("source, model, charge_to, hold_micro", "'site', 'fast', 'balance', 5"), [owner]);
      await db.query(draft("source, model", "'provider', 'm'"), [owner]);
      await db.query(`insert into agent_runs (purpose, owner_id, status) values ('draft', $1, 'queued')`, [owner]); // not admitted: neither
      expect((await db.query("select count(*)::int n from agent_runs")).rows).toEqual([{ n: 3 }]);
    });

    test("a usage record may lack a model only together with its source, and then costs nothing", async () => {
      const { owner } = await setup();
      const usage = `insert into usage_records (owner_id, purpose, source, model, cost_micro, outcome) values ($1, 'draft', $2, $3, $4, 'failed')`;
      await db.query(usage, [owner, null, null, 0]);
      await rejectedWith(CHECK_VIOLATION, usage, [owner, null, null, 5]);
      await rejectedWith(CHECK_VIOLATION, usage, [owner, "site", null, 0]);
      await rejectedWith(CHECK_VIOLATION, usage, [owner, null, "fast", 0]);
      await rejectedWith(CHECK_VIOLATION, usage, [owner, "cloud", "fast", 0]);
    });

    test("persona proposals reference a message and have a status", async () => {
      const { agent, conversation } = await setup();
      const message = await db.query<{ id: string }>(
        `insert into messages (conversation_id, seq, sender_id, kind, body) values ($1, 1, $2, 'text', '{}') returning id::text`,
        [conversation, agent],
      );
      const messageId = message.rows[0]!.id;
      await db.query(`insert into persona_proposals (agent_id, message_id, base_persona_version, persona) values ($1, $2, 0, 'be nice')`, [agent, messageId]);
      expect((await db.query(`select status from persona_proposals`)).rows).toEqual([{ status: "open" }]);
      await rejectedWith(CHECK_VIOLATION, `insert into persona_proposals (agent_id, message_id, base_persona_version, persona, status) values ($1, $2, 0, 'x', 'maybe')`, [agent, messageId]);
    });

    test("a refused call refers to its message and to the Agent's principal — never its agents row, which writing it must not lock", async () => {
      const { rows } = await db.query<{ def: string }>(
        "select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'refused_agent_calls'::regclass and contype = 'f' order by 1",
      );
      expect(rows.map((r) => r.def)).toEqual([
        "FOREIGN KEY (agent_id) REFERENCES principals(id) ON DELETE CASCADE",
        "FOREIGN KEY (conversation_id, seq) REFERENCES messages(conversation_id, seq) ON DELETE CASCADE",
      ]);
    });
  });
});
