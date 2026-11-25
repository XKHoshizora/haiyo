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
 * Up for both, in ONE transaction (fix round 1, I2: the pending migrations of a deploy commit together or not at all); then the deploys
 * that go wrong: 075 fails (074 is then NOT applied either: nothing is left half-way), and both applied with a new container that never
 * serves (the old code on the new schema: taken back with `migrate:down`, 075 then 074, each confirmed), and fixed forward. The files run one after another on one database
 * (`fileParallelism: false`), and whatever happens the last step puts every migration back.
 */
const { app, db } = useApp({ env: SITE_ENV, agentWorker: false });
const url = testDatabaseUrl();
const quiet = { quiet: true } as const;
/** The operator's confirmation of a Down (`--i-understand-this-deletes-data`). */
const sure = { quiet: true, confirmed: true } as const;
afterAll(async () => {
  await db.query("drop table if exists access_bars_in_the_way");
  if ((await db.query("select 1 from pg_class where relname = 'agent_reports_one_open_idx' and relkind = 'r'")).rowCount) await db.query("drop table agent_reports_one_open_idx");
  await db.query("do $$ begin if to_regclass('public.access_bars') is not null and not exists (select 1 from pgmigrations where name = '075_agent_social_access') then drop table access_bars; end if; end $$");
  await runMigrations(url, quiet);
});

const P = 1_000_000n;
/** Ring 1a's three migrations, which deploy together: the step-L numbers, access, and the two thinking levels (fix round 2). */
const RING = ["074_others_step_l", "075_agent_social_access", "076_others_reasoning"];
const levelColumns = async () =>
  (await db.query<{ c: string }>("select column_name as c from information_schema.columns where table_name = 'agents' and column_name in ('others_reasoning', 'proactive_reasoning') order by 1")).rows.map((r) => r.c);
/** Each Agent's [own level, level for others, proactive level], by its name part. */
const levels = async () =>
  Object.fromEntries(
    (await db.query<{ tag: string; r: string; o: string; p: string }>("select p.handle::text as tag, a.reasoning as r, a.others_reasoning as o, a.proactive_reasoning as p from agents a join principals p on p.id = a.principal_id order by 1")).rows.map((x) => [x.tag, [x.r, x.o, x.p]]),
  );
/** Whether `agent_runs.owner_call_seqs` is there (076, fix round 4). */
const ownerCallsColumn = async () => (await db.query("select 1 from information_schema.columns where table_name = 'agent_runs' and column_name = 'owner_call_seqs'")).rowCount === 1;
/** A run of the Agent `agentId` in its own conversation as the code before 076 left it (no `owner_call_seqs`): `caller` its owner, somebody else, or nobody. */
const oldRun = async (agentId: string, status: string, lane: string, caller: "owner" | "other" | null, covers: number, calls: number[] | null) =>
  (
    await db.query<{ id: string }>(
      `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, triggered_by, lane, call_seqs, caller_id)
       select 'reply', ac.conversation_id, p.id, p.owner_id, $2, $3, 'human', $4, $5::bigint[],
              case $6::text when 'owner' then p.owner_id when 'other' then (select o.id from principals o where o.kind = 'human' and o.id <> p.owner_id order by o.id limit 1) end
         from principals p join agent_conversations ac on ac.agent_id = p.id where p.id = $1 returning id`,
      [agentId, status, covers, lane, calls, caller],
    )
  ).rows[0]!.id;
const ownerCalls = async (runId: string) => (await db.query<{ c: number[] }>("select owner_call_seqs::int[] as c from agent_runs where id = $1", [runId])).rows[0]!.c;
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
  it("Down for both in reverse, Up for both in one transaction; a failed 075 leaves 074 unapplied; both applied and taken back (075's Down, then 074's); fixed forward: every row ends where the first Up put it", async () => {
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
    expect((await applied()).slice(-3)).toEqual(RING);
    await expect(undoMigration(url, "074_others_step_l", sure)).rejects.toThrow(/last migration applied is 076_others_reasoning/);
    // Not without the operator's word that data goes: nothing is undone.
    await expect(undoMigration(url, "075_agent_social_access", sure)).rejects.toThrow(/last migration applied is 076_others_reasoning/);
    await expect(undoMigration(url, "076_others_reasoning", quiet)).rejects.toThrow(/--i-understand-this-deletes-data/);
    expect((await applied()).at(-1)).toBe("076_others_reasoning");
    // 076's rows before its Down: an owner's two choices (lost by the Down, `none` again after the Up: the defaults).
    await db.query("update agents set others_reasoning = 'high', proactive_reasoning = 'low' where principal_id = $1", [ids.chosen]);
    expect(await ownerCallsColumn()).toBe(true);
    await undoMigration(url, "076_others_reasoning", sure);
    // (076's Down drops it: the code before 076 reads whose reply a run is from its lane alone.)
    expect(await ownerCallsColumn()).toBe(false);
    await undoMigration(url, "075_agent_social_access", sure);
    await undoMigration(url, "074_others_step_l", sure);
    expect((await applied()).at(-1)).toBe("073_others_columns_and_social_skeleton");
    expect(await defaults()).toEqual({ others_budget_micro: "20000000", proactive_budget_micro: "20000000" });
    expect((await db.query<{ t: string | null }>("select to_regclass('public.access_bars')::text as t")).rows[0]!.t).toBeNull();
    // The old code's rows.
    for (const [tag, [others, proactive]] of Object.entries(before)) {
      await db.query("update agents set others_budget_micro = $2, proactive_budget_micro = $3 where principal_id = $1", [ids[tag], others === null ? null : (BigInt(others) * P).toString(), (BigInt(proactive) * P).toString()]);
    }

    expect(await levelColumns()).toEqual([]);
    // The deployed code runs a co-member's call and a proactive reply at the Agent's OWN level: rows of every kind of level.
    await db.query("update agents set reasoning = 'high' where principal_id = $1", [ids.chosen]);
    await db.query("update agents set reasoning = 'low' where principal_id = $1", [ids.small]);
    await db.query("update agents set reasoning = 'max' where principal_id = $1", [ids.big]);

    // Runs the old code left, queued, under way and ended (fix round 4, R1: whose reply a run is, is written from now on).
    const legacy = {
      ownQueued: await oldRun(ids.chosen!, "queued", "own", "owner", 7, [5, 7]),
      ownFailedNoCalls: await oldRun(ids.nolimit!, "failed", "own", "owner", 4, null),
      ownNobody: await oldRun(ids.seventy!, "queued", "own", null, 2, [2]),
      othersRunning: await oldRun(ids.small!, "running", "others", "other", 3, [3]),
      unasked: await oldRun(ids.big!, "queued", "proactive", null, 9, [9]),
    };

    // ── Up for all three, as a deploy runs them.
    await runMigrations(url, quiet);
    expect(await levelColumns()).toEqual(["others_reasoning", "proactive_reasoning"]);
    // 076 (fix round 4, R1): a run from before has NO owner call, except one that is its owner's own already (lane own, its caller
    // the owner): its calls are taken as the owner's (what it covers, when its calls were never recorded). Nothing is guessed from
    // who wrote a message: a reply for others, one nobody asked for, and one in the owner's lane with no caller have none.
    expect(await ownerCalls(legacy.ownQueued)).toEqual([5, 7]);
    expect(await ownerCalls(legacy.ownFailedNoCalls)).toEqual([4]);
    expect(await ownerCalls(legacy.ownNobody)).toEqual([]);
    expect(await ownerCalls(legacy.othersRunning)).toEqual([]);
    expect(await ownerCalls(legacy.unasked)).toEqual([]);
    await db.query("delete from agent_runs where id = any($1::uuid[])", [Object.values(legacy)]);
    // 076 (fix round 3, point 6): an EXISTING Agent's two new levels are its own level (what such replies run at today); none stays none.
    expect(await levels()).toEqual({ olddefault: ["none", "none", "none"], nolimit: ["none", "none", "none"], chosen: ["high", "high", "high"], seventy: ["none", "none", "none"], small: ["low", "low", "low"], big: ["max", "max", "max"] });
    // A NEW Agent has none for both, whatever its own level (the column defaults).
    await db.query("update agents set others_reasoning = default, proactive_reasoning = default where principal_id = $1", [ids.seventy]);
    expect((await levels()).seventy).toEqual(["none", "none", "none"]);
    await expect(db.query("update agents set others_reasoning = 'loud'")).rejects.toThrow(/check/);
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

    // ── A deploy that goes wrong, first way: 075 fails (here: a table in its way). Both were pending in one transaction, so 074 is not
    // applied either: the old code keeps serving on exactly the schema it had, and nothing has to be taken back.
    await undoMigration(url, "076_others_reasoning", sure);
    await undoMigration(url, "075_agent_social_access", sure);
    await undoMigration(url, "074_others_step_l", sure);
    const writeOld = async () => {
      for (const [tag, [others, proactive]] of Object.entries(before)) {
        await db.query("update agents set others_budget_micro = $2, proactive_budget_micro = $3 where principal_id = $1", [ids[tag], others === null ? null : (BigInt(others) * P).toString(), (BigInt(proactive) * P).toString()]);
      }
    };
    await writeOld();
    await db.query("create table access_bars (in_the_way int)");
    await expect(runMigrations(url, quiet)).rejects.toThrow();
    expect((await applied()).at(-1)).toBe("073_others_columns_and_social_skeleton");
    expect(await numbers()).toEqual(before);
    expect(await defaults()).toEqual({ others_budget_micro: "20000000", proactive_budget_micro: "20000000" });
    await db.query("alter table access_bars rename to access_bars_in_the_way");

    // ── The same when the LAST of the three fails (fix round 3): 076 meets a relation named as its index, after 074 and 075 have
    // run in the same transaction. Nothing of the three is applied: no bars, no cleared number, no new column.
    await db.query("create table agent_reports_one_open_idx (in_the_way int)");
    await expect(runMigrations(url, quiet)).rejects.toThrow(/agent_reports_one_open_idx/);
    expect((await applied()).at(-1)).toBe("073_others_columns_and_social_skeleton");
    expect(await numbers()).toEqual(before);
    expect(await defaults()).toEqual({ others_budget_micro: "20000000", proactive_budget_micro: "20000000" });
    expect((await db.query<{ t: string | null }>("select to_regclass('public.access_bars')::text as t")).rows[0]!.t).toBeNull();
    expect(await levelColumns()).toEqual([]);
    await db.query("drop table agent_reports_one_open_idx");

    // ── Second way: both applied, and the new container never serves; the old code is what answers, on the new schema. It reads the
    // numbers 074 cleared as "no limit": the state to leave at once.
    await runMigrations(url, quiet);
    expect(await numbers()).toEqual(first);
    expect(Object.values(await numbers()).filter(([others]) => others === null)).toHaveLength(2);
    // The take-back is 075's Down and THEN 074's: the other order is refused and undoes nothing.
    await expect(undoMigration(url, "074_others_step_l", sure)).rejects.toThrow(/last migration applied is 076_others_reasoning/);
    expect((await applied()).slice(-3)).toEqual(RING);
    await undoMigration(url, "076_others_reasoning", sure);
    await undoMigration(url, "075_agent_social_access", sure);
    await undoMigration(url, "074_others_step_l", sure);
    expect((await applied()).at(-1)).toBe("073_others_columns_and_social_skeleton");
    const back = await numbers();
    expect(Object.values(back).filter(([others]) => others === null)).toHaveLength(0);
    // Every NULL is 20 again (also the owner's 不限: the safe direction), a proactive budget at exactly 70 is 20 again, nothing else moved.
    expect(back).toEqual({ olddefault: [20, 20], nolimit: [20, 20], chosen: [35, 50], seventy: [70, 20], small: [5, 9], big: [150, 101] });
    expect(await defaults()).toEqual({ others_budget_micro: "20000000", proactive_budget_micro: "20000000" });
    expect((await db.query<{ t: string | null }>("select to_regclass('public.access_bars')::text as t")).rows[0]!.t).toBeNull();

    // ── Fixed forward: both run again; every row is where the first Up put it.
    await runMigrations(url, quiet);
    expect((await applied()).slice(-3)).toEqual(RING);
    expect(await numbers()).toEqual(first);
    expect((await db.query("select setter_id, other_id, kind from access_bars order by 1, 2")).rows).toEqual(pairs);
    // And the service, on what the migrations left, answers as ever.
    expect((await api(app, ann, "GET", "/api/me/others-use")).status).toBe(200);
    expect((await api(app, ann, "GET", "/api/sync")).status).toBe(200);
  }, 240_000);
});
