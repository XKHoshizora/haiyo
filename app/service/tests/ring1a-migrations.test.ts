import { afterAll, describe, expect, it } from "vitest";
import { runMigrations, undoMigration } from "../src/migrate.ts";
import { api, befriend, signUp } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { testDatabaseUrl } from "./helpers/env.ts";
import { useApp } from "./helpers/harness.ts";

/**
 * Ring 1a's two migrations together, through the REAL runner on this database (the integration's proof; plan Rollout 3, B-5 re-review N2):
 * 074 (the step-L numbers) and 075 (access) deploy together, 074 first. On data in production's shape (Agents at the old default of 20
 * points, at none, at other numbers; blocks between people and of an Agent; personas): Down for both in reverse, the old values written,
 * Up for both; then the deploy that goes wrong — 075 fails after 074 was committed — taken back with the operator's command
 * (`migrate:down --name 074_others_step_l`, `undoMigration`), and fixed forward. The files run one after another on one database
 * (`fileParallelism: false`), and whatever happens the last step puts every migration back.
 */
const { app, db } = useApp({ env: SITE_ENV, agentWorker: false });
const url = testDatabaseUrl();
const quiet = { quiet: true } as const;
afterAll(async () => {
  await db.query("drop table if exists access_bars_in_the_way");
  await db.query("do $$ begin if to_regclass('public.access_bars') is not null and not exists (select 1 from pgmigrations where name = '075_agent_social_access') then drop table access_bars; end if; end $$");
  await runMigrations(url, quiet);
});

const P = 1_000_000n;
const applied = async () => (await db.query<{ name: string }>("select name from pgmigrations where name >= '073' order by name")).rows.map((r) => r.name);
/** Each Agent's two numbers in points, by the name part it was made with. */
const numbers = async () =>
  Object.fromEntries(
    (
      await db.query<{ tag: string; others: string | null; proactive: string }>(
        `select p.handle::text as tag, a.others_budget_micro::text as others, a.proactive_budget_micro::text as proactive
           from agents a join principals p on p.id = a.principal_id order by 1`,
      )
    ).rows.map((r) => [r.tag, [r.others === null ? null : Number(BigInt(r.others) / P), Number(BigInt(r.proactive) / P)]]),
  );
const defaults = async () =>
  Object.fromEntries(
    (
      await db.query<{ c: string; d: string | null }>(
        `select column_name as c, column_default as d from information_schema.columns where table_name = 'agents' and column_name in ('others_budget_micro', 'proactive_budget_micro')`,
      )
    ).rows.map((r) => [r.c, r.d]),
  );

describe("074 and 075 through the runner, on rows in production's shape", () => {
  it("Down for both in reverse, Up for both; a failed 075 is taken back by 074's Down and fixed forward: every row ends where the first Up put it", async () => {
    // Production's shape: owners with Agents, friends, a block between two people (both ways for one pair), a block of an Agent.
    const [ann, bo, cy] = [await signUp(app, "mg_ann"), await signUp(app, "mg_bo"), await signUp(app, "mg_cy")];
    // What each Agent held BEFORE 074, written below once the old columns are back: [others' number, proactive budget] in points.
    const before: Record<string, [number | null, number]> = {
      olddefault: [20, 20], // never touched: migration 020's defaults
      nolimit: [null, 20], // the owner chose 不限 in the old form
      chosen: [35, 50], // numbers the owner set
      seventy: [70, 70], // exactly the new numbers, set by hand
      small: [5, 9], // below 10
      big: [150, 101], // above 100
    };
    const ids: Record<string, string> = {};
    for (const [i, tag] of Object.keys(before).entries()) ids[tag] = ((await mustCreateAgent(app, [ann, bo, cy][i % 3]!, { handle: tag, persona: `人格 ${tag}。` })) as { id: string }).id;
    await befriend(app, ann, bo);
    expect((await api(app, ann, "PUT", `/api/blocks/${cy.id}`)).status).toBe(200);
    expect((await api(app, cy, "PUT", `/api/blocks/${ann.id}`)).status).toBe(200);
    expect((await api(app, bo, "PUT", `/api/blocks/${cy.id}`)).status).toBe(200);
    // (A person's block of an Agent, as the old code stored it: a row of `blocks`, and no bar.)
    await db.query("insert into blocks (blocker_id, blocked_id) values ($1, $2)", [bo.id, ids.small]);
    const blocksBefore = (await db.query("select blocker_id, blocked_id from blocks order by 1, 2")).rows;
    const messagesBefore = (await db.query<{ n: number }>("select count(*)::int as n from messages")).rows[0]!.n;

    // ── Down for both, in reverse. The command refuses anything but the last one applied.
    expect((await applied()).slice(-2)).toEqual(["074_others_step_l", "075_agent_social_access"]);
    await expect(undoMigration(url, "074_others_step_l", quiet)).rejects.toThrow(/last migration applied is 075_agent_social_access/);
    await undoMigration(url, "075_agent_social_access", quiet);
    await undoMigration(url, "074_others_step_l", quiet);
    expect((await applied()).at(-1)).toBe("073_others_columns_and_social_skeleton");
    expect(await defaults()).toEqual({ others_budget_micro: "20000000", proactive_budget_micro: "20000000" });
    expect((await db.query<{ t: string | null }>("select to_regclass('public.access_bars')::text as t")).rows[0]!.t).toBeNull();
    // The old code's rows.
    for (const [tag, [others, proactive]] of Object.entries(before)) {
      await db.query("update agents set others_budget_micro = $2, proactive_budget_micro = $3 where principal_id = $1", [ids[tag], others === null ? null : (BigInt(others) * P).toString(), (BigInt(proactive) * P).toString()]);
    }

    // ── Up for both, as a deploy runs them.
    await runMigrations(url, quiet);
    const first = await numbers();
    expect(first).toEqual({ olddefault: [null, 70], nolimit: [null, 70], chosen: [35, 50], seventy: [70, 70], small: [5, 9], big: [150, 101] });
    expect(await defaults()).toEqual({ others_budget_micro: null, proactive_budget_micro: "70000000" });
    // 075: one `block` bar per block between two PEOPLE, each direction its own row; none for the block of an Agent; nothing else moved.
    const bars = (await db.query<{ setter_id: string; other_id: string; kind: string }>("select setter_id, other_id, kind from access_bars order by 1, 2")).rows;
    const pairs = (
      [
        [ann.id, cy.id],
        [cy.id, ann.id],
        [bo.id, cy.id],
      ] as Array<[string, string]>
    )
      .map(([setter_id, other_id]) => ({ setter_id, other_id, kind: "block" }))
      .sort((x, y) => (x.setter_id + x.other_id < y.setter_id + y.other_id ? -1 : 1));
    expect(bars).toEqual(pairs);
    expect((await db.query("select blocker_id, blocked_id from blocks order by 1, 2")).rows).toEqual(blocksBefore);
    expect((await db.query<{ n: number }>("select count(*)::int as n from messages")).rows[0]!.n).toBe(messagesBefore);
    // Every persona that exists waits to be read once (none is stamped), every Agent takes requests by the owner's yes, none is disabled.
    const agents = (await db.query<{ due: boolean; contact_policy: string; disabled: boolean }>("select persona_version > persona_checked_version as due, contact_policy, disabled_at is not null as disabled from agents")).rows;
    expect(agents).toHaveLength(6);
    for (const a of agents) expect(a).toEqual({ due: true, contact_policy: "ask", disabled: false });

    // ── The deploy that goes wrong: 074 is committed on its own, then 075 fails (here: a table in its way).
    await undoMigration(url, "075_agent_social_access", quiet);
    await undoMigration(url, "074_others_step_l", quiet);
    for (const [tag, [others, proactive]] of Object.entries(before)) {
      await db.query("update agents set others_budget_micro = $2, proactive_budget_micro = $3 where principal_id = $1", [ids[tag], others === null ? null : (BigInt(others) * P).toString(), (BigInt(proactive) * P).toString()]);
    }
    await db.query("create table access_bars (in_the_way int)");
    await expect(runMigrations(url, quiet)).rejects.toThrow();
    expect((await applied()).at(-1)).toBe("074_others_step_l");
    // The hazard the Down exists for: the old code would read these NULLs as no limit at all.
    expect(Object.values(await numbers()).filter(([others]) => others === null)).toHaveLength(2);

    // ── Taken back at once: 074's Down, by the operator's command.
    await undoMigration(url, "074_others_step_l", quiet);
    expect((await applied()).at(-1)).toBe("073_others_columns_and_social_skeleton");
    const back = await numbers();
    expect(Object.values(back).filter(([others]) => others === null)).toHaveLength(0);
    // Every NULL is 20 again (also the owner's 不限: the safe direction), a proactive budget at exactly 70 is 20 again, nothing else moved.
    expect(back).toEqual({ olddefault: [20, 20], nolimit: [20, 20], chosen: [35, 50], seventy: [70, 20], small: [5, 9], big: [150, 101] });
    expect(await defaults()).toEqual({ others_budget_micro: "20000000", proactive_budget_micro: "20000000" });

    // ── Fixed forward: the thing in the way is gone, both run; every row is where the first Up put it.
    await db.query("alter table access_bars rename to access_bars_in_the_way");
    await runMigrations(url, quiet);
    expect((await applied()).slice(-2)).toEqual(["074_others_step_l", "075_agent_social_access"]);
    expect(await numbers()).toEqual(first);
    expect((await db.query("select setter_id, other_id, kind from access_bars order by 1, 2")).rows).toEqual(pairs);
    // And the service, on what the migrations left, answers as ever.
    expect((await api(app, ann, "GET", "/api/me/others-use")).status).toBe(200);
    expect((await api(app, ann, "GET", "/api/sync")).status).toBe(200);
  }, 240_000);
});
