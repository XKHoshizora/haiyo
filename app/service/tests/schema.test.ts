import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { useApp } from "./helpers/harness.ts";

const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

describe("schema guarantees enforced by the database", () => {
  const { db } = useApp();

  async function authUser(id: string): Promise<void> {
    await db.query(
      `insert into "user" (id, name, email, "emailVerified") values ($1::text, $1::text, $1::text || '@example.test', true)`,
      [id],
    );
  }

  async function human(handle: string): Promise<string> {
    await authUser(`auth-${handle}`);
    const { rows } = await db.query<{ id: string }>(
      `insert into principals (kind, handle, display_name, auth_user_id)
       values ('human', $1::citext, $1::text, 'auth-' || $1::text) returning id`,
      [handle],
    );
    return rows[0]!.id;
  }

  async function conversation(creatorId: string): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `insert into conversations (type, creator_id) values ('group', $1) returning id`,
      [creatorId],
    );
    return rows[0]!.id;
  }

  async function rejectedWith(code: string, sql: string, params: unknown[] = []): Promise<void> {
    // `code` may name several (a|b): Postgres 18 reports a delete refused by `on delete restrict` as 23001, earlier versions as 23503.
    await expect(db.query(sql, params)).rejects.toMatchObject({ code: expect.stringMatching(new RegExp(`^(${code})$`)) });
  }

  test("an agent with no owner is rejected", async () => {
    await rejectedWith(
      CHECK_VIOLATION,
      `insert into principals (kind, handle, display_name) values ('agent', 'lonely_bot', 'Lonely')`,
    );
  });

  test("a human with an owner is rejected", async () => {
    const owner = await human("owner_one");
    await rejectedWith(
      CHECK_VIOLATION,
      `insert into principals (kind, handle, display_name, owner_id, auth_user_id)
       values ('human', 'owned_human', 'Owned', $1, 'auth-owned')`,
      [owner],
    );
  });

  test("a human without an auth user is rejected", async () => {
    await rejectedWith(
      CHECK_VIOLATION,
      `insert into principals (kind, handle, display_name) values ('human', 'no_auth', 'No Auth')`,
    );
  });

  test("an agent with an owner is accepted", async () => {
    const owner = await human("owner_two");
    const { rowCount } = await db.query(
      `insert into principals (kind, handle, display_name, owner_id) values ('agent', 'good_bot', 'Good', $1)`,
      [owner],
    );
    expect(rowCount).toBe(1);
  });

  test("a principal that owns itself is rejected", async () => {
    await rejectedWith(
      CHECK_VIOLATION,
      `insert into principals (id, kind, handle, display_name, owner_id)
       values ('00000000-0000-0000-0000-00000000000a', 'agent', 'self_bot', 'Self', '00000000-0000-0000-0000-00000000000a')`,
    );
  });

  test("an agent owned by another agent is rejected", async () => {
    const owner = await human("owner_three");
    const { rows } = await db.query<{ id: string }>(
      `insert into principals (kind, handle, display_name, owner_id) values ('agent', 'first_bot', 'First', $1) returning id`,
      [owner],
    );
    await rejectedWith(
      FOREIGN_KEY_VIOLATION,
      `insert into principals (kind, handle, display_name, owner_id) values ('agent', 'second_bot', 'Second', $1)`,
      [rows[0]!.id],
    );
  });

  test("an agent carrying an auth user is rejected", async () => {
    const owner = await human("owner_four");
    await authUser("auth-agent-user");
    await rejectedWith(
      CHECK_VIOLATION,
      `insert into principals (kind, handle, display_name, owner_id, auth_user_id)
       values ('agent', 'authed_bot', 'Authed', $1, 'auth-agent-user')`,
      [owner],
    );
  });

  test("a human whose auth user does not exist is rejected", async () => {
    await rejectedWith(
      FOREIGN_KEY_VIOLATION,
      `insert into principals (kind, handle, display_name, auth_user_id) values ('human', 'ghost_user', 'Ghost', 'no-such-auth-user')`,
    );
  });

  test("a membership that leaves before it joined is rejected", async () => {
    const p = await human("member_three");
    const c = await conversation(p);
    await rejectedWith(
      CHECK_VIOLATION,
      `insert into memberships (conversation_id, principal_id, role, joined_seq, left_seq)
       values ($1, $2, 'speaker', 5, 4)`,
      [c, p],
    );
  });

  test("a second current membership for the same conversation and principal is rejected", async () => {
    const p = await human("member_one");
    const c = await conversation(p);
    await db.query(
      `insert into memberships (conversation_id, principal_id, role, joined_seq) values ($1, $2, 'speaker', 0)`,
      [c, p],
    );
    await rejectedWith(
      UNIQUE_VIOLATION,
      `insert into memberships (conversation_id, principal_id, role, joined_seq) values ($1, $2, 'speaker', 0)`,
      [c, p],
    );
  });

  test("a new membership is allowed after the previous one has left", async () => {
    const p = await human("member_two");
    const c = await conversation(p);
    await db.query(
      `insert into memberships (conversation_id, principal_id, role, joined_seq, left_seq)
       values ($1, $2, 'speaker', 0, 3)`,
      [c, p],
    );
    const { rowCount } = await db.query(
      `insert into memberships (conversation_id, principal_id, role, joined_seq) values ($1, $2, 'speaker', 3)`,
      [c, p],
    );
    expect(rowCount).toBe(1);
  });

  test("a second pending friend request for the same pair is rejected in either direction", async () => {
    const a = await human("friend_a");
    const b = await human("friend_b");
    await db.query(
      `insert into friend_requests (from_id, to_id, expires_at) values ($1, $2, now() + interval '24 hours')`,
      [a, b],
    );
    await rejectedWith(
      UNIQUE_VIOLATION,
      `insert into friend_requests (from_id, to_id, expires_at) values ($1, $2, now() + interval '24 hours')`,
      [a, b],
    );
    await rejectedWith(
      UNIQUE_VIOLATION,
      `insert into friend_requests (from_id, to_id, expires_at) values ($1, $2, now() + interval '24 hours')`,
      [b, a],
    );
  });

  test("a new friend request is allowed once the earlier one is no longer pending", async () => {
    const a = await human("friend_c");
    const b = await human("friend_d");
    await db.query(
      `insert into friend_requests (from_id, to_id, status, expires_at, resolved_at)
       values ($1, $2, 'rejected', now() + interval '24 hours', now())`,
      [a, b],
    );
    const { rowCount } = await db.query(
      `insert into friend_requests (from_id, to_id, expires_at) values ($2, $1, now() + interval '24 hours')`,
      [a, b],
    );
    expect(rowCount).toBe(1);
  });

  test("a duplicate (conversation_id, seq) is rejected", async () => {
    const p = await human("sender_one");
    const c = await conversation(p);
    const insert = `insert into messages (conversation_id, seq, sender_id, kind, body)
                    values ($1, 1, $2, 'text', '{"text":"hi"}')`;
    await db.query(insert, [c, p]);
    await rejectedWith(UNIQUE_VIOLATION, insert, [c, p]);
  });

  test("the same (conversation, sender, client_txn) is rejected; another conversation or sender may reuse it; a null client_txn may repeat", async () => {
    const p = await human("txn_one");
    const q = await human("txn_two");
    const c1 = await conversation(p);
    const c2 = await conversation(p);
    const insert = `insert into messages (conversation_id, seq, sender_id, kind, body, client_txn)
                    values ($1, $2, $3, 'text', '{"text":"hi"}', $4)`;
    await db.query(insert, [c1, 1, p, "retry-1"]);
    await rejectedWith(UNIQUE_VIOLATION, insert, [c1, 2, p, "retry-1"]);
    expect((await db.query(insert, [c2, 1, p, "retry-1"])).rowCount).toBe(1); // another conversation
    expect((await db.query(insert, [c1, 2, q, "retry-1"])).rowCount).toBe(1); // another sender
    expect((await db.query(insert, [c1, 3, p, null])).rowCount).toBe(1);
    expect((await db.query(insert, [c1, 4, p, null])).rowCount).toBe(1);
  });

  test.each(["Upper", "has space", "ab", "x".repeat(25), "dash-ed"])("handle %j is rejected", async (handle) => {
    await rejectedWith(
      CHECK_VIOLATION,
      `insert into principals (kind, handle, display_name, auth_user_id) values ('human', $1, 'X', 'auth-x')`,
      [handle],
    );
  });

  test("handles are unique case-insensitively", async () => {
    await human("same_name");
    await rejectedWith(
      UNIQUE_VIOLATION,
      `insert into principals (kind, handle, display_name, auth_user_id) values ('human', 'same_name', 'X', 'auth-y')`,
    );
  });

  test("an Agent's handle is its name part: 2 to 24 of a-z0-9_, in no pool with people's or other owners' Agents' (family names)", async () => {
    const [one, two] = [await human("owner_fn1"), await human("owner_fn2")];
    const agent = (owner: string, handle: string) =>
      db.query(`insert into principals (kind, handle, display_name, owner_id) values ('agent', $1, 'A', $2)`, [handle, owner]);
    await agent(one, "ai");
    await agent(one, "x".repeat(24));
    await agent(two, "ai"); // another owner's
    await agent(one, "owner_fn2"); // a person's handle
    for (const bad of ["a", "x".repeat(25), "Upper", "dot.ted", "dash-ed"]) await expect(agent(one, bad)).rejects.toMatchObject({ code: CHECK_VIOLATION });
    // A person's handle is still 3 to 24 and still unique among people.
    await rejectedWith(CHECK_VIOLATION, `insert into principals (kind, handle, display_name, auth_user_id) values ('human', 'ab', 'X', 'auth-ab')`);
    await authUser("auth-fn3");
    expect((await db.query(`insert into principals (kind, handle, display_name, auth_user_id) values ('human', 'ai_x', 'X', 'auth-fn3')`)).rowCount).toBe(1);
    expect((await db.query(`select handle_changed_at from principals where id = $1`, [one])).rows).toEqual([{ handle_changed_at: null }]);
  });

  test("reserved_handles: one row per handle, of a person's handle's shape, for a principal that exists", async () => {
    const a = await human("reserve_a");
    const b = await human("reserve_b");
    await db.query(`insert into reserved_handles (handle, principal_id) values ('old_a', $1)`, [a]);
    await rejectedWith(UNIQUE_VIOLATION, `insert into reserved_handles (handle, principal_id) values ('old_a', $1)`, [b]);
    for (const bad of ["ab", "OLD_B", "old.b"]) await rejectedWith(CHECK_VIOLATION, `insert into reserved_handles (handle, principal_id) values ($1, $2)`, [bad, b]);
    await rejectedWith(FOREIGN_KEY_VIOLATION, `insert into reserved_handles (handle, principal_id) values ('old_c', gen_random_uuid())`);
    await rejectedWith(`${FOREIGN_KEY_VIOLATION}|23001`, `delete from principals where id = $1`, [a]);
  });

  test("friendships must be stored with the smaller id first", async () => {
    const a = await human("order_a");
    const b = await human("order_b");
    const [lo, hi] = a < b ? [a, b] : [b, a];
    await rejectedWith(CHECK_VIOLATION, `insert into friendships (a_id, b_id) values ($1, $2)`, [hi, lo]);
    const { rowCount } = await db.query(`insert into friendships (a_id, b_id) values ($1, $2)`, [lo, hi]);
    expect(rowCount).toBe(1);
  });

  test("migration 030's Down runs once memory calls are recorded: its old checks are added not valid, so a rollback is not stopped half way", async () => {
    const owner = await human("down_030");
    const sql = readFileSync(new URL("../migrations/030_memory_purpose.sql", import.meta.url), "utf8");
    const down = sql.split("-- Down Migration")[1]!;
    const ran = await db
      .tx(async (t) => {
        await t.query("insert into agent_runs (purpose, owner_id, status, started_at) values ('memory', $1, 'running', now())", [owner]);
        await t.query(down);
        // Rolled back whatever happened: the schema stays as it is.
        throw new Error("rollback");
      })
      .catch((err: Error) => err.message);
    expect(ran).toBe("rollback");
    const still = await db.query("select count(*)::int as n from agent_runs where owner_id = $1", [owner]);
    expect(still.rows[0].n).toBe(0);
    await db.query("insert into agent_runs (purpose, owner_id, status, started_at) values ('memory', $1, 'running', now())", [owner]);
    await db.query("delete from agent_runs where owner_id = $1", [owner]);
  });
});
