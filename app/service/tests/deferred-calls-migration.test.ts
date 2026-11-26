import { afterAll, describe, expect, it } from "vitest";
import { recoverRuns } from "../src/agents/port-impl.ts";
import { runMigrations, DOWN_REMOVES, undoMigration } from "../src/migrate.ts";
import { signUp } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { testDatabaseUrl } from "./helpers/env.ts";
import { useApp } from "./helpers/harness.ts";

/**
 * Migration 078 (the limits redesign, Part 2): the deferred-call table, and the cutover by draining, not by inference. Its Up ends
 * every active reply — a queued one `cancelled` at once, a running one marked so that start-up recovery ends it `cancelled` without
 * posting and settles it — and discards whatever was noted on any run (`pending_seq`). Its Down drops the table, and nothing else.
 * Through the real runner on this database; whatever happens, the last step puts every migration back.
 */
const { app, db } = useApp({ env: SITE_ENV, agentWorker: false });
const url = testDatabaseUrl();
const sure = { quiet: true, confirmed: true } as const;
afterAll(async () => {
  await runMigrations(url, { quiet: true });
});

const tableThere = async () => (await db.query<{ t: string | null }>("select to_regclass('public.deferred_calls')::text as t")).rows[0]!.t !== null;
const last = async () => (await db.query<{ name: string }>("select name from pgmigrations order by run_on desc, id desc limit 1")).rows[0]!.name;
const run = async (agentId: string, conv: string, status: string, pending: number | null) =>
  (
    await db.query<{ id: string }>(
      `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, pending_seq, triggered_by, lane, caller_id, started_at, finished_at)
       select 'reply', $2, p.id, p.owner_id, $3, 0, $4, 'human', 'own', p.owner_id,
              case when $3 in ('running', 'done') then now() end, case when $3 = 'done' then now() end
         from principals p where p.id = $1 returning id`,
      [agentId, conv, status, pending],
    )
  ).rows[0]!.id;
const rowOf = async (id: string) =>
  (await db.query<{ status: string; error: string | null; interrupted: string | null; pending: string | null }>("select status, error, interrupted, pending_seq::text as pending from agent_runs where id = $1", [id])).rows[0]!;

describe("078: the deferred calls, and the cutover by draining", () => {
  it("its Down drops the table alone; its Up ends every active reply (queued now, running at recovery: cancelled, never posted, settled) and discards what was noted", async () => {
    expect(DOWN_REMOVES["078_deferred_calls"]).toMatch(/deferred_calls/);
    expect(await last()).toBe("078_deferred_calls");
    expect(await tableThere()).toBe(true);
    await undoMigration(url, "078_deferred_calls", sure);
    expect(await tableThere()).toBe(false);
    expect(await last()).toBe("077_call_refusals");

    // Runs the old code left: one queued, one running with a call noted on it, one done with a stale note.
    const owner = await signUp(app, "dc_owner");
    const agent = (await mustCreateAgent(app, owner, { handle: "dcbot", persona: "简短。" })) as { id: string; conversationId: string };
    const second = (await mustCreateAgent(app, owner, { handle: "dcbot2", persona: "简短。" })) as { id: string; conversationId: string };
    const third = (await mustCreateAgent(app, owner, { handle: "dcbot3", persona: "简短。" })) as { id: string; conversationId: string };
    const queued = await run(agent.id, agent.conversationId, "queued", null);
    const running = await run(second.id, second.conversationId, "running", 3);
    const done = await run(third.id, third.conversationId, "done", 5);
    // And one admitted (its model called, a hold written on the site model), as a live worker would have left it (T2 fix 1, F7c).
    const fourth = (await mustCreateAgent(app, owner, { handle: "dcbot4", persona: "简短。" })) as { id: string; conversationId: string };
    const admitted = await run(fourth.id, fourth.conversationId, "running", null);
    await db.query(
      "update agent_runs set admitted_at = now(), source = 'site', model = 'fast', charge_to = 'balance', hold_micro = 5000, money_rule = 1 where id = $1",
      [admitted],
    );

    await runMigrations(url, { quiet: true });
    expect(await tableThere()).toBe(true);
    expect(await rowOf(queued)).toEqual({ status: "cancelled", error: null, interrupted: null, pending: null });
    expect(await rowOf(running)).toEqual({ status: "running", error: null, interrupted: "access_ended", pending: null });
    expect(await rowOf(admitted)).toEqual({ status: "running", error: null, interrupted: "access_ended", pending: null });
    expect(await rowOf(done)).toMatchObject({ status: "done", pending: null });

    // Start-up recovery, before the worker: each running one ends cancelled with no error, posts nothing, and is settled once — the
    // admitted one's hold released.
    expect(await recoverRuns(db, app.deps.config, { error: () => {}, warn: () => {} })).toBe(2);
    for (const [id, agentId] of [
      [running, second.id],
      [admitted, fourth.id],
    ] as const) {
      expect(await rowOf(id)).toEqual({ status: "cancelled", error: null, interrupted: "access_ended", pending: null });
      expect((await db.query("select 1 from usage_records where run_id = $1", [id])).rowCount).toBe(1);
      expect((await db.query("select 1 from messages where sender_id = $1", [agentId])).rowCount).toBe(0);
    }
    expect((await db.query<{ hold: string }>("select hold_micro::text as hold from agent_runs where id = $1", [admitted])).rows[0]!.hold).toBe("0");
    // Nothing was queued in its place.
    expect((await db.query("select 1 from agent_runs where status in ('queued', 'running')")).rowCount).toBe(0);
  }, 120_000);
});
