import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mentionsAtSend } from "../src/agents/mentions.ts";
import { mayAnswerUnasked } from "../src/agents/proactive/candidates.ts";
import { NOTHING } from "../src/agents/runtime/port.ts";
import { triggerFromAgent } from "../src/agents/runs.ts";
import { lockAgent } from "../src/agents/store.ts";
import { insertMessage } from "../src/messages/model.ts";
import { reach, refusedSql } from "../src/social/reach.ts";
import { blockedEitherWay } from "../src/social/relations.ts";
import { api, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";

/**
 * Lane B, B5b: every group site asks `refusedSql` (the one access decision) instead of the block alone, and one rule ends a call in a
 * group: the refused caller's calls are taken out; a run left with no call ends quietly (`cancelled`, no error: `access_ended` is for
 * social runs), and a refused call that waited behind it is never answered; at post time, nothing is posted when no call the run answers stands, and the reply never
 * quotes or mentions a person refused now. Stops, removals and narrowings reach these sites through the same function: tested with the
 * real routes in tests/social-ring1a.test.ts and tests/social-group-calls.test.ts.
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
}
/** The Agent's earliest run in `conv`: the one the test made (a reply it ends with is a later row). */
const firstRun = async (agentId: string, conv: string): Promise<RunView> =>
  (
    await db.query<RunView>(
      `select status, error, lane, caller_id as caller, call_seqs::int[] as calls
         from agent_runs where agent_id = $1 and conversation_id = $2 order by created_at, id limit 1`,
      [agentId, conv],
    )
  ).rows[0]!;
/** The seqs of the calls waiting for the Agent in `conv` behind its active reply (`deferred_calls`), oldest first. */
const waitingOf = async (agentId: string, conv: string): Promise<number[]> =>
  (await db.query<{ seq: number }>("select message_seq::int as seq from deferred_calls where agent_id = $1 and conversation_id = $2 order by message_seq", [agentId, conv])).rows.map(
    (r) => r.seq,
  );
/** The Agent's runs in `conv` not ended yet. */
const activeOf = async (agentId: string, conv: string) =>
  (await db.query("select id from agent_runs where agent_id = $1 and conversation_id = $2 and status in ('queued', 'running')", [agentId, conv])).rows;

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

  it("105 callers: refusedSql over many rows answers as `reach` does for each (blocks, a stop either way, an ended row), and as the block rule did where only a block stands", async () => {
    const owner = await signUp(app, "gs_o105");
    const agent = (await mustCreateAgent(app, owner, { handle: "gs105_bot", model: FAST })) as { id: string };
    const people: Actor[] = [];
    for (let i = 0; i < 105; i++) people.push(await signUp(app, `gs_p${i}`));
    for (const [i, p] of people.entries()) {
      if (i % 3 === 1) await block(owner, p);
      if (i % 3 === 2) await block(p, owner);
    }
    // Lane A's access beside the blocks (the integration): a stop set by the owner, a stop set by the other person, and a row the owner removed.
    const plainOnes = people.filter((_, i) => i % 3 === 0);
    for (const [k, p] of plainOnes.entries()) {
      if (k % 5 === 1) await db.query("insert into access_bars (setter_id, other_id, kind) values ($1, $2, 'stop')", [owner.id, p.id]);
      if (k % 5 === 2) await db.query("insert into access_bars (setter_id, other_id, kind) values ($1, $2, 'stop')", [p.id, owner.id]);
      if (k % 5 === 3) await db.query("insert into agent_contacts (agent_id, subject_id, person_id, state, end_reason) values ($1, $2, $2, 'ended', 'removed')", [agent.id, p.id]);
      if (k % 5 === 4) await db.query("insert into agent_contacts (agent_id, subject_id, person_id, state, end_reason) values ($1, $2, $2, 'ended', 'left')", [agent.id, p.id]);
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
    // THE decision, asked one by one: the SQL twin spliced over many rows says the same of every one of them.
    for (const r of rows) expect([r.id, r.now]).toEqual([r.id, (await reach(db, r.id, agent.id, "group", app.deps.config)) !== "ok"]);
    // Where a block stands the old rule and the new agree; the new one also refuses the 7 + 7 stopped, and neither the 7 removed nor the 7 who left (a row that ended refuses nobody in a group: fix round 2, N2).
    for (const r of rows.filter((x) => x.old)) expect(r.now).toBe(true);
    expect(rows.filter((r) => r.now && !r.old).length).toBe(14);
  }, 180_000);
});

describe("one rule for the end of a group call", () => {
  it("a run left with no call ends cancelled with no error, and what is no call never waits behind it (a reply answers calls only)", async () => {
    const w = await world();
    await say(w.mia, w.g, "@anna_bot 在吗？");
    await say(w.ned, w.g, "ned 随口说一句");
    expect(await waitingOf(w.anna.id, w.g)).toEqual([]);
    await block(w.owner, w.mia);
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(gateway.calls.length).toBe(first);
    expect(await firstRun(w.anna.id, w.g)).toMatchObject({ status: "cancelled", error: null });
    expect(await activeOf(w.anna.id, w.g)).toEqual([]);
  });

  it("... and the refused person's call that waited behind it is never answered", async () => {
    const w = await world();
    await say(w.mia, w.g, "@anna_bot 在吗？");
    const ticket = (await app.agentPort.claimNext())!;
    const again = await say(w.mia, w.g, "@anna_bot 再问一句");
    expect(await waitingOf(w.anna.id, w.g)).toEqual([again]);
    await block(w.owner, w.mia);
    expect(await app.agentPort.begin(ticket)).toEqual({ status: "cancelled" });
    await app.agentPort.finish(ticket, { status: "cancelled" }, null, NOTHING);
    expect(gateway.calls.length).toBe(first);
    expect(await firstRun(w.anna.id, w.g)).toMatchObject({ status: "cancelled", error: null });
    expect(await activeOf(w.anna.id, w.g)).toEqual([]);
    expect(await waitingOf(w.anna.id, w.g)).toEqual([]);
  });

  it("m4: a refused acknowledgement stops the reply (the stop flag) instead of letting it run on", async () => {
    const w = await world();
    await say(w.mia, w.g, "@anna_bot MIA-ASK 在吗？");
    const ticket = (await app.agentPort.claimNext())!;
    expect("call" in (await app.agentPort.begin(ticket))).toBe(true);
    expect(app.agentPort.shouldStop(ticket)).toBe(false);
    await block(w.owner, w.mia);
    expect(await app.agentPort.acknowledge(ticket, { text: "我查一下", reasoning: "" })).toBe("refused");
    expect(app.agentPort.shouldStop(ticket)).toBe(true);
    expect(await textsOf(w.g, w.anna.id)).toEqual([]);
    await app.agentPort.finish(ticket, { status: "cancelled" }, null, NOTHING);
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
    expect(await firstRun(w.anna.id, w.g)).toMatchObject({ status: "cancelled", error: null });
    // Settled once: a second finish changes nothing and adds no usage record.
    const records = async () => Number((await db.query<{ n: string }>("select count(*) as n from usage_records where run_id = (select id from agent_runs where agent_id = $1 order by created_at limit 1)", [w.anna.id])).rows[0]!.n);
    const once = await records();
    await app.agentPort.finish(ticket, { status: "cancelled" }, null, NOTHING);
    expect(await records()).toBe(once);
  });

  /** mia's own Agent, in a reply she called for, relays a question to anna for her and for `askers`: mia's call (lane others, her the caller). */
  const relayFor = async (w: Awaited<ReturnType<typeof world>>, askers: string[]) => {
    const miaBot = (await mustCreateAgent(app, w.mia, { handle: "mia_bot", model: FAST })) as { id: string };
    expect((await api(app, w.mia, "POST", `/api/conversations/${w.g}/members`, { principalId: miaBot.id })).status).toBe(201);
    return db.tx(async (t) => {
      const poster = await lockAgent(t, miaBot.id, w.g);
      const text = "@anna_bot 帮大家问一下";
      const message = await insertMessage(t, w.g, miaBot.id, "text", { text }, null, await mentionsAtSend(t, { id: w.g, type: "group" }, text));
      await triggerFromAgent(t, w.g, message, poster, { id: w.mia.id, lane: "own" }, app.deps.config, askers);
      return message.seq;
    });
  };

  it("a person whose question it carries blocked after begin, not its caller: the reply goes on for its caller, and mentions nobody refused", async () => {
    const w = await world();
    await say(w.ned, w.g, "我也想知道");
    await relayFor(w, [w.mia.id, w.ned.id]);
    expect(await firstRun(w.anna.id, w.g)).toMatchObject({ status: "queued", lane: "others", caller: w.mia.id });
    const ticket = (await app.agentPort.claimNext())!;
    const prepared = await app.agentPort.begin(ticket);
    expect("call" in prepared).toBe(true);
    await block(w.owner, w.ned);
    expect(await app.agentPort.post(ticket, { text: `@${w.mia.handle} 和 @${w.ned.handle} 在的`, ...REPLY })).toBe("posted");
    const [message] = await textsOf(w.g, w.anna.id);
    const ids = (message!.mentions ?? []).map((m) => m.id);
    expect(ids).toContain(w.mia.id);
    expect(ids).not.toContain(w.ned.id);
    await app.agentPort.finish(ticket, { status: "done" }, null, NOTHING);
  });

  it("I1: the only ANSWERED caller refused, a third person's call that waited behind it: not posted, the call that waited gets its own reply, its caller's", async () => {
    const w = await world();
    await say(w.mia, w.g, "@anna_bot MIA-ASK 在吗？");
    const ticket = (await app.agentPort.claimNext())!;
    expect("call" in (await app.agentPort.begin(ticket))).toBe(true);
    const waited = await say(w.ned, w.g, "@anna_bot NED-ASK 我也问");
    expect(await waitingOf(w.anna.id, w.g)).toEqual([waited]);
    await block(w.owner, w.mia);
    expect(await app.agentPort.post(ticket, { text: "在的", ...REPLY })).toBe("refused");
    expect(await textsOf(w.g, w.anna.id)).toEqual([]);
    await app.agentPort.finish(ticket, { status: "cancelled" }, null, NOTHING);
    expect(await firstRun(w.anna.id, w.g)).toMatchObject({ status: "cancelled", error: null });
    const next = (await db.query<{ calls: number[]; caller: string }>("select call_seqs::int[] as calls, caller_id as caller from agent_runs where agent_id = $1 and status = 'queued'", [w.anna.id])).rows;
    expect(next).toEqual([{ calls: [waited], caller: w.ned.id }]);
  });

  it("the quote of a refused person's message is dropped at post (the reply goes on for the other's call)", async () => {
    const w = await world();
    await say(w.mia, w.g, "@anna_bot MIA-ASK 在吗？");
    const nedCall = await say(w.ned, w.g, "@anna_bot NED-ASK 我也问");
    expect(await waitingOf(w.anna.id, w.g)).toEqual([nedCall]);
    // A reply answering two persons' calls, made by hand: none is made since a reply's caller never changes (limits redesign,
    // Part 2), and the rule at post holds for one all the same.
    await db.query("delete from deferred_calls where agent_id = $1", [w.anna.id]);
    await db.query("update agent_runs set call_seqs = array_append(call_seqs, $2::bigint), covers_seq = $2 where agent_id = $1 and status = 'queued'", [w.anna.id, nedCall]);
    const ticket = (await app.agentPort.claimNext())!;
    expect("call" in (await app.agentPort.begin(ticket))).toBe(true);
    expect(await app.agentPort.acknowledge(ticket, { text: "稍等", reasoning: "" })).toBe("posted");
    await say(w.mia, w.g, "我再插一句");
    await block(w.owner, w.ned);
    expect(await app.agentPort.post(ticket, { text: "好的", ...REPLY })).toBe("posted");
    const replies = (await db.query<{ body: { replyToSeq?: number; ack?: boolean } }>("select body from messages where conversation_id = $1 and sender_id = $2 and kind = 'text' order by seq", [w.g, w.anna.id])).rows;
    const reply = replies.find((r) => !r.body.ack)!;
    expect(reply.body.replyToSeq).toBeUndefined();

    await app.agentPort.finish(ticket, { status: "done" }, null, NOTHING);
  });


  it("a run interrupted `access_ended` is refused at post, not thrown (every interruption is a refusal)", async () => {
    const w = await world();
    await say(w.mia, w.g, "@anna_bot 在吗？");
    const ticket = (await app.agentPort.claimNext())!;
    for (const why of ["access_ended", "owner_spoke", "notes_changed", "errand_ended"]) {
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
