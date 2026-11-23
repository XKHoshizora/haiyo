import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mayAnswerUnasked } from "../src/agents/proactive/candidates.ts";
import { NOTHING } from "../src/agents/runtime/port.ts";
import { refusedSql } from "../src/social/reach.ts";
import { blockedEitherWay } from "../src/social/relations.ts";
import { api, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";

/**
 * Lane B, B5b: every group site asks `refusedSql` (the one access decision) instead of the block alone, and one rule ends a call in a
 * group: the refused caller's calls are taken out, a run left with no call ends quietly (`cancelled`, no error; lane A ends one `access_ended`: an open decision) and keeps what
 * a third person noted, and nothing is posted to or about a person refused at post time. This branch's `refusedSql` is Step 0's (blocks
 * only): stops, removals and narrowings reach these sites through the same function and are tested in I1a once lane A's is in.
 */
const gateway = scriptedGateway();
const { app, db } = useApp({ env: SITE_ENV, models: gateway, agentWorker: false });
let first = 0;
beforeEach(() => {
  first = gateway.calls.length;
});
afterEach(() => {
  expect(gateway.pending()).toBe(0);
});

const FAST = { source: "site", id: "fast" } as const;
let txn = 0;
const say = async (who: Actor, conv: string, text: string): Promise<number> => {
  const sent = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `gs${++txn}` });
  if (sent.status !== 201) throw new Error(`say: ${sent.status} ${JSON.stringify(sent.json)}`);
  return sent.json.message.seq as number;
};
const block = async (by: Actor, whom: Actor): Promise<void> => {
  expect((await api(app, by, "PUT", `/api/blocks/${whom.id}`)).status).toBe(200);
};
const REPLY = { reasoning: "", stopped: false, truncated: false } as const;

interface RunView {
  status: string;
  error: string | null;
  lane: string;
  caller: string | null;
  calls: number[] | null;
  pending: number | null;
}
/** The Agent's earliest run in `conv`: the one the test made (a follow-up it ends with is a later row). */
const firstRun = async (agentId: string, conv: string): Promise<RunView> =>
  (
    await db.query<RunView>(
      `select status, error, lane, caller_id as caller, call_seqs::int[] as calls, pending_seq::int as pending
         from agent_runs where agent_id = $1 and conversation_id = $2 order by created_at, id limit 1`,
      [agentId, conv],
    )
  ).rows[0]!;

async function world() {
  const [owner, mia, ned] = [await signUp(app, "gs_owner"), await signUp(app, "gs_mia"), await signUp(app, "gs_ned")];
  const g = await group(app, owner, "楼里的群", [mia, ned]);
  const anna = await mustCreateAgent(app, owner, { handle: "anna_bot", name: "安娜", model: FAST, persona: "你是安娜，说话简短。" });
  expect((await api(app, owner, "POST", `/api/conversations/${g}/members`, { principalId: anna.id })).status).toBe(201);
  return { owner, mia, ned, g, anna: anna as { id: string; conversationId: string } };
}
const textsOf = async (conv: string, agentId: string) =>
  (await db.query<{ seq: number; body: { text: string }; mentions: Array<{ id: string }> | null }>("select seq::int, body, mentions from messages where conversation_id = $1 and sender_id = $2 and kind = 'text'", [conv, agentId])).rows;

describe("the sites ask refusedSql", () => {
  it("no group site asks the block alone any more: runs.ts and candidates.ts ask refusedSql (read from their source)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const file of ["../src/agents/runs.ts", "../src/agents/proactive/candidates.ts"]) {
      const source = readFileSync(join(here, file), "utf8");
      expect(source, file).not.toMatch(/blockedEitherWay\(/);
      expect(source, file).toMatch(/refused(InGroup|Sql)\(/);
    }
    // The proactive candidates' predicate, built: the sender is the subject, the Agent column the Agent.
    expect(mayAnswerUnasked("$2", "$3")).toContain(refusedSql({ subject: "$3", agent: "p.id", where: "group", socialOn: "false" }));
  });

  it("105 callers: refusedSql answers as the block rule did, for a person and for an Agent of theirs", async () => {
    const owner = await signUp(app, "gs_o105");
    const agent = (await mustCreateAgent(app, owner, { handle: "gs105_bot", model: FAST })) as { id: string };
    const people: Actor[] = [];
    for (let i = 0; i < 105; i++) people.push(await signUp(app, `gs_p${i}`));
    for (const [i, p] of people.entries()) {
      if (i % 3 === 1) await block(owner, p);
      if (i % 3 === 2) await block(p, owner);
    }
    const theirAgent = (await mustCreateAgent(app, people[1]!, { handle: "gs105_theirs", model: FAST })) as { id: string };
    const ids = [...people.map((p) => p.id), theirAgent.id, agent.id];
    const { rows } = await db.query<{ id: string; old: boolean; now: boolean }>(
      `select x.id, ${blockedEitherWay("coalesce(x.owner_id, x.id)", "(select ag.owner_id from principals ag where ag.id = $2::uuid)")} as old,
              ${refusedSql({ subject: "x.id", agent: "$2::uuid", where: "group", socialOn: "false" })} as now
         from principals x where x.id = any($1::uuid[])`,
      [ids, agent.id],
    );
    expect(rows).toHaveLength(107);
    expect(rows.filter((r) => r.old).length).toBe(70 + 1);
    for (const r of rows) expect(r.now).toBe(r.old);
  }, 180_000);
});

describe("one rule for the end of a group call", () => {
  it("a run left with no call ends cancelled (no error: today's pinned outcome), and keeps what a third person noted", async () => {
    const w = await world();
    const mine = await say(w.mia, w.g, "@anna_bot 在吗？");
    const noted = await say(w.ned, w.g, "ned 随口说一句");
    await db.query("update agent_runs set pending_seq = $2 where agent_id = $1 and status = 'queued'", [w.anna.id, noted]);
    await block(w.owner, w.mia);
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(gateway.calls.length).toBe(first);
    const run = await firstRun(w.anna.id, w.g);
    expect(run).toMatchObject({ status: "cancelled", error: null });
    expect(mine).toBeGreaterThan(0);
    // Ned's message is a third person's, noted on the run: it is not dropped (its follow-up reads it).
    expect(run.pending).toBe(noted);
  });

  it("... and drops what only the refused person noted", async () => {
    const w = await world();
    await say(w.mia, w.g, "@anna_bot 在吗？");
    const again = await say(w.mia, w.g, "@anna_bot 再问一句");
    await db.query("update agent_runs set pending_seq = $2 where agent_id = $1 and status = 'queued'", [w.anna.id, again]);
    await block(w.owner, w.mia);
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(await firstRun(w.anna.id, w.g)).toMatchObject({ status: "cancelled", error: null, pending: null });
  });

  it("a person blocked after begin: a reply whose only call is theirs is not posted; money settles once", async () => {
    const w = await world();
    await say(w.mia, w.g, "@anna_bot MIA-ASK 在吗？");
    const ticket = (await app.agentPort.claimNext())!;
    const prepared = await app.agentPort.begin(ticket);
    expect("call" in prepared).toBe(true);
    await block(w.owner, w.mia);
    expect(await app.agentPort.post(ticket, { text: "在的", ...REPLY })).toBe("refused");
    expect(await textsOf(w.g, w.anna.id)).toEqual([]);
    await app.agentPort.finish(ticket, { status: "cancelled" }, null, NOTHING);
    expect(await firstRun(w.anna.id, w.g)).toMatchObject({ status: "cancelled" });
    // Settled once: a second finish changes nothing and adds no usage record.
    const records = async () => Number((await db.query<{ n: string }>("select count(*) as n from usage_records where run_id = (select id from agent_runs where agent_id = $1 order by created_at limit 1)", [w.anna.id])).rows[0]!.n);
    const once = await records();
    await app.agentPort.finish(ticket, { status: "cancelled" }, null, NOTHING);
    expect(await records()).toBe(once);
  });

  it("a person blocked after begin who is one of two callers: the reply goes on for the other, mentions and quotes nobody refused", async () => {
    const w = await world();
    await say(w.mia, w.g, "@anna_bot MIA-ASK 在吗？");
    const ticket = (await app.agentPort.claimNext())!;
    await say(w.ned, w.g, "@anna_bot NED-ASK 我也问");
    const prepared = await app.agentPort.begin(ticket);
    expect("call" in prepared).toBe(true);
    await block(w.owner, w.mia);
    expect(await app.agentPort.post(ticket, { text: `@${w.mia.handle} 和 @${w.ned.handle} 在的`, ...REPLY })).toBe("posted");
    const [message] = await textsOf(w.g, w.anna.id);
    const ids = (message!.mentions ?? []).map((m) => m.id);
    expect(ids).toContain(w.ned.id);
    expect(ids).not.toContain(w.mia.id);
    await app.agentPort.finish(ticket, { status: "done" }, null, NOTHING);
  });

  it("a run interrupted `access_ended` is refused at post, not thrown (every interruption is a refusal)", async () => {
    const w = await world();
    await say(w.mia, w.g, "@anna_bot 在吗？");
    const ticket = (await app.agentPort.claimNext())!;
    for (const why of ["access_ended", "owner_spoke", "notes_changed"]) {
      await db.query("update agent_runs set interrupted = $2 where id = $1", [ticket.id, why]);
      expect(await app.agentPort.post(ticket, { text: "在的", ...REPLY })).toBe("refused");
    }
    await app.agentPort.releaseRun(ticket.id);
  });

  it("the owner's own call is never refused at post", async () => {
    const w = await world();
    await say(w.owner, w.g, "@anna_bot 主人在问");
    const ticket = (await app.agentPort.claimNext())!;
    expect("call" in (await app.agentPort.begin(ticket))).toBe(true);
    expect(await app.agentPort.post(ticket, { text: "在的", ...REPLY })).toBe("posted");
    await app.agentPort.finish(ticket, { status: "done" }, null, NOTHING);
  });
});
