import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { othersLimitOf } from "../src/metering/others.ts";
import { useApp } from "./helpers/harness.ts";
import { OTHERS_ENV, POINT } from "./helpers/others.ts";
import { closeAllSockets } from "./helpers/ws.ts";

/**
 * Lane B, B4: migration 074, the step-L change (plan B4; Controller ruling 2026-11-24 (B-2 dispatch); Owner decision 2026-11-25 (cap)). 074 was
 * applied nowhere when it was edited for that decision, and deploys only with lane B's code and lane A's 075. What it does to a row:
 *  - an Agent's others' number (`others_budget_micro`) at exactly 20 points becomes NULL (no sub-limit of its own: the owner's 300 points
 *    and 50 answers apply); below, above (including 70), and null stay. A number an owner chose as exactly 20 cannot be told from 020's
 *    default, so it is cleared too (the plan's stated rule). The column default becomes null.
 *  - an Agent's proactive budget at exactly 20 points becomes 70, and the column default becomes 70.
 *  - nothing of an owner's (`accounts.others_*`) is written.
 * (The limits redesign reads none of those Agent columns any more — they stay, unread, until a later cleanup — so what 074 meant for
 * admission is gone with them; what it does to the rows is still what a deploy's Up and Down do.)
 */

const sql = readFileSync(new URL("../migrations/074_others_step_l.sql", import.meta.url), "utf8");
const [up, down] = sql.split("-- Down Migration") as [string, string];

const { app, db } = useApp({ env: OTHERS_ENV, agentWorker: false });
const config = () => app.deps.config;
afterEach(async () => {
  await closeAllSockets();
});

const columnDefault = async (column: string): Promise<string | null> =>
  (await db.query<{ d: string | null }>(`select column_default as d from information_schema.columns where table_name = 'agents' and column_name = $1`, [column])).rows[0]!.d;

describe("074: the step-L change", () => {
  it("is the live database's state: an Agent has no number of its own by default, and a proactive budget of 70", async () => {
    expect(await columnDefault("others_budget_micro")).toBeNull();
    expect(await columnDefault("proactive_budget_micro")).toBe("70000000");
  });

  // The pattern of schema-social.test.ts (073) and money-wallet.test.ts: split the file, run its Down, write the old code's rows, run its Up,
  // all inside one transaction that is rolled back.
  it("on rows crossing 10 and 100: only a number at exactly 20 points is raised, no row is otherwise touched, the defaults change, Down puts the defaults back (rolled back)", async () => {
    const client = await db.pool.connect();
    const one = async (q: string, p: unknown[] = []) => (await client.query(q, p)).rows as Array<Record<string, any>>;
    // Points as micro-points: nothing, the bounds, either side of 10, of 20 and of 100, and a few between and above.
    const others: Array<bigint | null> = [null, 1_000_000n, 9_999_999n, 10_000_000n, 10_000_001n, 19_999_999n, 20_000_000n, 20_000_001n, 35_000_000n, 69_999_999n, 70_000_000n, 99_999_999n, 100_000_000n, 100_000_001n, 100_000_000_000n];
    const proactive: bigint[] = [1_000_000n, 9_999_999n, 10_000_000n, 10_000_001n, 19_999_999n, 20_000_000n, 20_000_001n, 69_999_999n, 70_000_000n, 99_999_999n, 100_000_000n, 100_000_001n, 100_000_000_000n];
    const agentRows = async () =>
      one(`select p.handle::text as handle, a.others_budget_micro::text as others, a.proactive_budget_micro::text as proactive,
                  md5((to_jsonb(a) - 'others_budget_micro' - 'proactive_budget_micro')::text) as rest
             from agents a join principals p on p.id = a.principal_id order by p.handle`);
    const defaults = async () =>
      one(`select column_name c, column_default d from information_schema.columns where table_name = 'agents' and column_name in ('others_budget_micro', 'proactive_budget_micro') order by 1`);
    try {
      await client.query("begin");
      await client.query(down);
      expect(await defaults()).toEqual([
        { c: "others_budget_micro", d: "20000000" },
        { c: "proactive_budget_micro", d: "20000000" },
      ]);
      const owners: string[] = [];
      for (let i = 0; i < 4; i++) {
        await client.query(`insert into "user" (id, name, email, "emailVerified") values ($1::text, $1::text, $1::text || '@example.test', true)`, [`auth-mig_${i}`]);
        owners.push((await one(`insert into principals (kind, handle, display_name, auth_user_id) values ('human', $1::citext, $1::text, 'auth-' || $1::text) returning id`, [`mig_${i}`]))[0]!.id);
        await client.query(`insert into accounts (principal_id) values ($1)`, [owners[i]]);
      }
      // 105 Agents of four owners: every combination of the two columns' values comes round, and the old default (both at 20) is among them.
      const made: Array<{ handle: string; others: bigint | null; proactive: bigint }> = [];
      for (let i = 0; i < 105; i++) {
        const o = others[i % others.length] ?? null;
        const p = proactive[(i * 7) % proactive.length]!;
        const handle = `mig_bot_${String(i).padStart(3, "0")}`;
        const row = await one(`insert into principals (kind, handle, display_name, owner_id) values ('agent', $1::citext, $1::text, $2) returning id`, [handle, owners[i % 4]]);
        await client.query(`insert into agents (principal_id, others_budget_micro, proactive_budget_micro) values ($1, $2, $3)`, [row[0]!.id, o === null ? null : o.toString(), p.toString()]);
        made.push({ handle, others: o, proactive: p });
      }
      // And one made with the old column defaults (a row nobody chose a number for).
      const plain = await one(`insert into principals (kind, handle, display_name, owner_id) values ('agent', 'mig_bot_default', 'mig_bot_default', $1) returning id`, [owners[0]]);
      await client.query(`insert into agents (principal_id) values ($1)`, [plain[0]!.id]);
      made.push({ handle: "mig_bot_default", others: 20_000_000n, proactive: 20_000_000n });

      const before = await agentRows();
      expect(before).toHaveLength(106);
      expect(made.filter((m) => m.others === 20_000_000n).length).toBeGreaterThan(5);
      expect(made.filter((m) => m.proactive === 20_000_000n).length).toBeGreaterThan(5);
      const accountsBefore = await one(`select md5(string_agg((to_jsonb(x))::text, '|' order by principal_id)) h from accounts x`);

      await client.query(up.replace("-- Up Migration", ""));
      const after = await agentRows();
      // (Owner decision 2026-11-25: a row at exactly 20 is CLEARED to null; any other number is kept.)
      const raised = (v: bigint | null): string | null => (v === 20_000_000n || v === null ? null : v.toString());
      const raisedProactive = (v: bigint): string => (v === 20_000_000n ? "70000000" : v.toString());
      // Exactly the rows at 20 points changed; a number the owner set below 20 (including 10 and 19.999999), above it (20.000001, 35, 100) and null did not.
      expect(after.map((r) => [r.handle, r.others, r.proactive])).toEqual(made.map((m) => [m.handle, raised(m.others), raisedProactive(m.proactive)]).sort((a, b) => (a[0]! < b[0]! ? -1 : 1)));
      expect(after.map((r) => r.rest)).toEqual(before.map((r) => r.rest));
      // The numbers an owner says of their own are not written: every owner still reads the config's 300 points.
      expect(await one(`select md5(string_agg((to_jsonb(x))::text, '|' order by principal_id)) h from accounts x`)).toEqual(accountsBefore);
      expect(await one(`select count(*)::int n from accounts where others_answers is not null or others_points_micro is not null or others_notice_seen_at is not null`)).toEqual([{ n: 0 }]);
      for (const owner of owners) expect(await othersLimitOf(client, config(), owner)).toBe(300n * POINT);
      expect(await defaults()).toEqual([
        { c: "others_budget_micro", d: null },
        { c: "proactive_budget_micro", d: "70000000" },
      ]);
      // A new Agent after it: no number of its own, a proactive budget of 70.
      const fresh = await one(`insert into principals (kind, handle, display_name, owner_id) values ('agent', 'mig_bot_fresh', 'mig_bot_fresh', $1) returning id`, [owners[0]]);
      await client.query(`insert into agents (principal_id) values ($1)`, [fresh[0]!.id]);
      expect(await one(`select others_budget_micro::text o, proactive_budget_micro::text p from agents where principal_id = $1`, [fresh[0]!.id])).toEqual([{ o: null, p: "70000000" }]);

      // Down (N2: old code reads NULL as no limit): every NULL others' number is 20 again, a proactive budget at exactly 70 is 20 again, every other
      // number stays, the defaults are put back, and nothing else of any row moves.
      const beforeDown = await agentRows();
      await client.query(down);
      expect(await defaults()).toEqual([
        { c: "others_budget_micro", d: "20000000" },
        { c: "proactive_budget_micro", d: "20000000" },
      ]);
      const back = await agentRows();
      expect(back.map((r) => [r.handle, r.others, r.proactive])).toEqual(
        beforeDown.map((r) => [r.handle, r.others === null ? "20000000" : r.others, r.proactive === "70000000" ? "20000000" : r.proactive]),
      );
      expect(back.filter((r) => r.others === null)).toEqual([]);
      expect(back.map((r) => r.rest)).toEqual(beforeDown.map((r) => r.rest));
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});
