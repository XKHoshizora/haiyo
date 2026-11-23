import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { admitRun, type Admission } from "../src/metering/admit.ts";
import { OthersLimit, othersHold, othersNumbers } from "../src/metering/others.ts";
import { maxCostMicro } from "../src/metering/prices.ts";
import { settle } from "../src/metering/settle.ts";
import { signUp, type Actor } from "./helpers/actors.ts";
import { useApp } from "./helpers/harness.ts";
import { grant, type MeteredAgent } from "./helpers/metering.ts";
import { agentsOf, committedMicro, FREE_MODEL, HELD_PLAIN, HELD_WITH_TOOLS, NOON, OTHERS_ENV, PAID_MODEL, POINT, ROOM, seedRun } from "./helpers/others.ts";
import { closeAllSockets } from "./helpers/ws.ts";

/**
 * Lane B, B4: migration 074, the step-L change (plan B4; Controller ruling 2026-11-24 (B-2 dispatch); Owner decision 2026-11-25 (cap)). 074 was
 * applied nowhere when it was edited for that decision, and deploys only with lane B's code and lane A's 075. What it does to a row:
 *  - an Agent's others' number (`others_budget_micro`) at exactly 20 points becomes NULL (no sub-limit of its own: the owner's 300 points
 *    and 50 answers apply); below, above (including 70), and null stay. A number an owner chose as exactly 20 cannot be told from 020's
 *    default, so it is cleared too (the plan's stated rule). The column default becomes null.
 *  - an Agent's proactive budget at exactly 20 points becomes 70, and the column default becomes 70.
 *  - nothing of an owner's (`accounts.others_*`) is written.
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
      // The numbers an owner says of their own are not written: every owner still reads the config's 300 points and 50 answers.
      expect(await one(`select md5(string_agg((to_jsonb(x))::text, '|' order by principal_id)) h from accounts x`)).toEqual(accountsBefore);
      expect(await one(`select count(*)::int n from accounts where others_answers is not null or others_points_micro is not null or others_notice_seen_at is not null`)).toEqual([{ n: 0 }]);
      for (const owner of owners) {
        const agent = (await one(`select principal_id id from agents a join principals p on p.id = a.principal_id where p.owner_id = $1 limit 1`, [owner]))[0]!.id as string;
        expect((await othersNumbers(client, config(), owner, agent)).owner).toEqual({ answers: 50, pointsMicro: 300n * POINT });
      }
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

  describe("after it, for the owners that already have Agents", () => {
    let n = 0;
    const newOwner = async (): Promise<Actor> => {
      const owner = await signUp(app, `mg${++n}x${Math.floor(Math.random() * 1e6)}`);
      await grant(db, owner.id, 10_000n * POINT);
      return owner;
    };
    /** Puts an owner's Agents where migration 020 and 027 left every Agent before this lane (both numbers 20) and applies 074's Up to them. */
    async function atOldDefault(agents: MeteredAgent[]): Promise<void> {
      await db.query(`update agents set others_budget_micro = 20000000, proactive_budget_micro = 20000000 where principal_id = any($1::uuid[])`, [agents.map((a) => a.agentId)]);
      await db.query(up.replace("-- Up Migration", ""));
    }
    /** Admits a reply of `agent` as `begin` does. */
    function admitAs(ownerId: string, agent: MeteredAgent, runId: string, o: { tools: boolean }): Promise<Admission> {
      const held = o.tools ? HELD_WITH_TOOLS : HELD_PLAIN;
      const last = o.tools ? maxCostMicro(agent.resolved, Math.min(held + ROOM.growthTokens, ROOM.roomCapTokens)) : 0n;
      const plain = o.tools ? othersHold(agent.resolved, HELD_PLAIN, null) : null;
      return db.tx((t) => admitRun(t, config(), runId, ownerId, agent.resolved, held, NOON, last, plain));
    }

    it("M-V1 at 300: three Agents at the old default lose their number (null) and share 300 points, never 900: ten replies of 29.624 points fit, the eleventh is refused, and settled + holds never pass 300", async () => {
      const owner = await newOwner();
      const agents = await agentsOf(app, db, owner, 3, FREE_MODEL);
      await atOldDefault(agents);
      expect((await db.query(`select others_budget_micro::text n from agents where principal_id = any($1::uuid[])`, [agents.map((a) => a.agentId)])).rows).toEqual([{ n: null }, { n: null }, { n: null }]);
      // The free model holds 140 µpt an input token and 280 an output token, 800 output tokens: 210 000 input tokens hold exactly 29.624 points.
      const BIG = { input: 210_000, output: 800 };
      const EACH = BigInt(BIG.input) * 140n + BigInt(BIG.output) * 280n;
      expect(EACH).toBe(29_624_000n);
      const refusals: unknown[] = [];
      for (let i = 0; i < 11; i++) {
        const agent = agents[i % 3]!;
        const runId = await seedRun(db, { ownerId: owner.id, agent, lane: "others" });
        try {
          await db.tx((t) => admitRun(t, config(), runId, owner.id, agent.resolved, BIG.input, NOON, 0n, null));
        } catch (err) {
          refusals.push(err);
          expect(await committedMicro(db, owner.id)).toBeLessThanOrEqual(300n * POINT);
          continue;
        }
        expect(await committedMicro(db, owner.id)).toBeLessThanOrEqual(300n * POINT);
        await db.tx((t) => settle(t, config(), runId, { inputTokens: BIG.input, outputTokens: BIG.output }, { inputChars: 0, outputChars: 0 }, "done", NOON, { log: { warn: () => undefined } }));
        await db.query("update agent_runs set status = 'done', finished_at = now() where id = $1", [runId]);
        // The test's clock is noon in Shanghai on one day (`NOON`): the charge is recorded on it, as the real settlement would on the day it happens.
        await db.query("update usage_records set created_at = $2 where run_id = $1", [runId, NOON]);
        expect(await committedMicro(db, owner.id)).toBeLessThanOrEqual(300n * POINT);
      }
      // Ten settled (296.24 points), and the eleventh (296.24 + 29.624 > 300) refused by the points, with nothing held.
      expect(await committedMicro(db, owner.id)).toBe(10n * EACH);
      expect(refusals).toHaveLength(1);
      expect(refusals[0]).toBeInstanceOf(OthersLimit);
      expect((refusals[0] as OthersLimit).limit).toBe("points");
    });

    it("how many replies with tools fit at once in 300 points at the design's prices: free tier 35 (8.387 each), paid tier 1 (194.127), then plain ones (61.5), never more than 300 held", async () => {
      // (The holds are the plan's: one with tools is call 1 plus the last call; the plain fallback is one call. A reply of one owner holds both
      // at admission, so the count is the arithmetic of the holds under the cap; one active reply an Agent is a rule of the claim, not of the cap.)
      const owner = await newOwner();
      const [free, paid] = [(await agentsOf(app, db, owner, 1, FREE_MODEL))[0]!, (await agentsOf(app, db, owner, 1, PAID_MODEL))[0]!];
      const cap = 300n * POINT;
      const freeTools = othersHold(free.resolved, HELD_WITH_TOOLS, ROOM);
      const paidTools = othersHold(paid.resolved, HELD_WITH_TOOLS, ROOM);
      expect([freeTools, paidTools]).toEqual([8_387_260n, 194_127_000n]);
      expect(cap / freeTools).toBe(35n);
      expect(cap / paidTools).toBe(1n);
      // Paid: one with tools, and the rest of the room holds one plain reply (61.5): 194.127 + 61.5 = 255.6; a second plain one would pass 300.
      const paidPlain = othersHold(paid.resolved, HELD_PLAIN, null);
      expect(paidPlain).toBe(61_500_000n);
      expect(paidTools + paidPlain).toBeLessThanOrEqual(cap);
      expect(paidTools + 2n * paidPlain).toBeGreaterThan(cap);
      // And through admission: two paid Agents' replies, the first with tools, the second plain (its tools hold does not fit).
      const agents = await agentsOf(app, db, owner, 2, PAID_MODEL);
      await atOldDefault(agents);
      const first = await admitAs(owner.id, agents[0]!, await seedRun(db, { ownerId: owner.id, agent: agents[0]!, lane: "others" }), { tools: true });
      expect(first.plain).toBeFalsy();
      const second = await admitAs(owner.id, agents[1]!, await seedRun(db, { ownerId: owner.id, agent: agents[1]!, lane: "others" }), { tools: true });
      expect(second.plain).toBe(true);
      expect(await committedMicro(db, owner.id)).toBeLessThanOrEqual(cap);
    });

    it("M-V2: an Agent whose owner set its own number below 20 keeps it and, on a paid-tier model (plain hold 61.5), answers no one", async () => {
      const owner = await newOwner();
      const [paid] = await agentsOf(app, db, owner, 1, PAID_MODEL);
      await db.query(`update agents set others_budget_micro = 10000000 where principal_id = $1`, [paid!.agentId]);
      await db.query(up.replace("-- Up Migration", ""));
      expect((await db.query(`select others_budget_micro::text n from agents where principal_id = $1`, [paid!.agentId])).rows).toEqual([{ n: "10000000" }]);
      const runId = await seedRun(db, { ownerId: owner.id, agent: paid!, lane: "others" });
      await expect(admitAs(owner.id, paid!, runId, { tools: true })).rejects.toMatchObject({ limit: "points" });
    });

    it("an Agent with a null number has no sub-limit of its own: the owner's 300 is the only one", async () => {
      const owner = await newOwner();
      const [free] = await agentsOf(app, db, owner, 1, FREE_MODEL);
      await db.query(`update agents set others_budget_micro = null where principal_id = $1`, [free!.agentId]);
      await db.query(up.replace("-- Up Migration", ""));
      expect(await othersNumbers(db, config(), owner.id, free!.agentId)).toMatchObject({ agent: { pointsMicro: null }, owner: { answers: 50, pointsMicro: 300n * POINT } });
    });
  });
});
