import type { InjectOptions } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RUN_COLUMNS, toWireRun, type RunRow, type RunStatus } from "../src/agents/runs.ts";
import { api, befriend, group, signUp, type Actor } from "./helpers/actors.ts";
import { latestRunId, mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { closeAllSockets, connect, type Push, type TestSocket } from "./helpers/ws.ts";

/**
 * What each member of a group learns of an Agent's reply there, and its owner's controls over it (wire contract "Run
 * state"; README "Replies", "Pushes"; plan ruling 3, Task 6). The Agent's owner gets the run (`run` push with `agentId`,
 * `GET …/runs` entry with `run`); every other current member only `replying` / `unavailable` / null; anyone else
 * nothing. Runs are inserted and announced by hand (`agentPort.announce`, the one call site every route and the worker
 * use); the worker runs (`runOnce`) only where a reply under way is stopped.
 */

const gateway = scriptedGateway();
const { app, db } = useApp({ env: SITE_ENV, models: gateway, agentWorker: false });

afterEach(async () => {
  vi.restoreAllMocks();
  await closeAllSockets();
  expect(gateway.pending()).toBe(0);
});

const FAST = { source: "site", id: "fast" } as const;
const RANDOM = "6a0d4c2e-1b3f-4a5e-9c7d-8e9f0a1b2c3d";
const OTHER_RANDOM = "0b6f3d2a-7c1e-4f5a-8d9b-1a2b3c4d5e6f";
/** All a member who does not own the Agent ever gets of its run. */
const REDUCED_KEYS = ["agentId", "conversationId", "state", "type"];
/** Distinctive values seeded on a failed run, none of which may reach anyone but its owner. */
const RESETS_AT = "2031-07-04T05:06:07.000Z";
const TOKENS = { input: 31337, output: 27182, cost: 987654321 };

type Agent = { id: string; handle: string; conversationId: string };

interface World {
  owner: Actor;
  member: Actor;
  third: Actor;
  /** Was a member of the group, and left before anything here happened. */
  leaver: Actor;
  /** Never a member. */
  stranger: Actor;
  g: string;
  /** The owner's Agent in the group. */
  anna: Agent;
  /** The member's Agent in the group. */
  bob: Agent;
}

async function agentOf(owner: Actor, handle: string, g: string | null): Promise<Agent> {
  const agent = (await mustCreateAgent(app, owner, { handle, name: handle, model: FAST, persona: "简短地回答。" })) as Agent;
  if (g) {
    const added = await api(app, owner, "POST", `/api/conversations/${g}/members`, { principalId: agent.id });
    if (added.status !== 201) throw new Error(`add ${handle}: ${added.status} ${JSON.stringify(added.json)}`);
  }
  return agent;
}

async function world(): Promise<World> {
  const [owner, member, third, leaver, stranger] = [
    await signUp(app, "owner"),
    await signUp(app, "member"),
    await signUp(app, "third"),
    await signUp(app, "leaver"),
    await signUp(app, "stranger"),
  ];
  const g = await group(app, owner, "team", [member, third, leaver]);
  expect((await api(app, leaver, "DELETE", `/api/conversations/${g}/members/${leaver.id}`)).status).toBe(200);
  return { owner, member, third, leaver, stranger, g, anna: await agentOf(owner, "anna", g), bob: await agentOf(member, "bobbot", g) };
}

const seqOf = async (conv: string) => Number((await db.query<{ seq: string }>("select seq from conversations where id = $1", [conv])).rows[0]!.seq);

let txn = 0;
const say = async (who: Actor, conv: string, text: string): Promise<number> => {
  const sent = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `gr${++txn}` });
  if (sent.status !== 201) throw new Error(`say: ${sent.status} ${JSON.stringify(sent.json)}`);
  return sent.json.message.seq as number;
};

interface Seed {
  status: RunStatus;
  error?: string;
  covers?: number;
  /** The calls it answers (`call_seqs`; null, as an old row's: not known). */
  calls?: number[];
  resetsAt?: string;
  dismissed?: boolean;
  by?: "human" | "agent";
}

/** A reply run of `agent` (owned by `owner`) in `conv`, covering the conversation's current seq unless told. */
async function seedRun(agent: Agent, owner: Actor, conv: string, s: Seed): Promise<RunRow> {
  const covers = s.covers ?? (await seqOf(conv));
  const { rows } = await db.query<RunRow>(
    `insert into agent_runs as r (purpose, conversation_id, agent_id, owner_id, status, error, covers_seq, call_seqs, resets_at, dismissed_at,
                                  triggered_by, started_at, finished_at)
     values ('reply', $1, $2, $3, $4, $5, $6, $7, $8, case when $9 then now() end, $10,
             case when $4 <> 'queued' then now() end, case when $4 not in ('queued', 'running') then now() end)
     returning ${RUN_COLUMNS}`,
    [conv, agent.id, owner.id, s.status, s.error ?? null, covers, s.calls ?? null, s.resetsAt ?? null, s.dismissed === true, s.by ?? "human"],
  );
  return rows[0]!;
}

/** The run as its owner sees it, pushed as every route and the worker push it. */
const announce = (owner: Actor, conv: string, row: RunRow) => app.agentPort.announce({ ownerId: owner.id, conversationId: conv, run: toWireRun(row) });

/** The current state of run `id` as a row. */
const rowOf = async (id: string) => (await db.query<RunRow>(`select ${RUN_COLUMNS} from agent_runs r where r.id = $1`, [id])).rows[0]!;

/** One open socket per actor given (the same actor twice: two sockets), in that order. */
const connectAll = async <T extends Actor[]>(...actors: T): Promise<{ [K in keyof T]: TestSocket }> =>
  (await Promise.all(actors.map((a) => connect(app, a)))) as { [K in keyof T]: TestSocket };

const runPushes = (s: TestSocket, conv: string) => s.events.filter((e) => e.type === "run" && e.conversationId === conv);

/** Resolves once everything the server sent this socket before now has arrived: its answer to a ping comes after it. */
async function settled(s: TestSocket): Promise<void> {
  const from = s.events.length;
  s.send(JSON.stringify({ type: "ping" }));
  await s.waitFor((e) => e.type === "pong", { from });
}

/** The next reduced `run` push about `agentId` in `conv` from `from` on; asserts it carries nothing but the four keys. */
async function nextState(s: TestSocket, conv: string, agentId: string, from = 0): Promise<Push> {
  const e = await s.next((x) => x.type === "run" && x.conversationId === conv && x.agentId === agentId, { from });
  expect(Object.keys(e).sort()).toEqual(REDUCED_KEYS);
  return e;
}

/** What a client can observe of an answer: status, content type and body, byte for byte. */
async function observe(who: Actor | null, req: InjectOptions) {
  const res = await app.inject({ ...req, headers: { ...(req.headers as object), ...(who ? { cookie: who.cookie } : {}) } });
  return { status: res.statusCode, type: String(res.headers["content-type"] ?? ""), body: res.body };
}
const get = (url: string): InjectOptions => ({ method: "GET", url });
const post = (url: string, payload?: object | null): InjectOptions => ({ method: "POST", url, ...(payload === undefined ? {} : { payload: payload as object }) });

// --- the run push --------------------------------------------------------------------------------------------------

describe("the run push in a group", () => {
  it("queued and running: its owner gets the run with agentId; every other current member only replying; a former member and a stranger nothing", async () => {
    const w = await world();
    const [ownerS, memberS, thirdS, leaverS, strangerS] = await connectAll(w.owner, w.member, w.third, w.leaver, w.stranger);
    const queued = await seedRun(w.anna, w.owner, w.g, { status: "queued" });

    announce(w.owner, w.g, queued);
    const mine = await ownerS.next((e) => e.type === "run" && e.conversationId === w.g);
    expect(mine).toEqual({ type: "run", conversationId: w.g, agentId: w.anna.id, run: { id: queued.id, status: "queued", retryable: false } });
    for (const s of [memberS, thirdS]) expect(await nextState(s, w.g, w.anna.id)).toEqual({ type: "run", conversationId: w.g, agentId: w.anna.id, state: "replying" });

    await db.query("update agent_runs set status = 'running', started_at = now() where id = $1", [queued.id]);
    announce(w.owner, w.g, await rowOf(queued.id));
    expect((await ownerS.next((e) => e.type === "run" && e.run?.status === "running")).run).toEqual({ id: queued.id, status: "running", retryable: false });
    for (const s of [memberS, thirdS]) {
      const from = s.events.indexOf(runPushes(s, w.g)[0]!) + 1;
      expect((await nextState(s, w.g, w.anna.id, from)).state).toBe("replying");
    }

    // Nobody outside the group heard of either.
    for (const s of [leaverS, strangerS]) {
      await settled(s);
      expect(s.events.filter((e) => e.type === "run")).toEqual([]);
    }
    expect(runPushes(ownerS, w.g).every((e) => "run" in e && !("state" in e))).toBe(true);
  });

  it("failed: the others get unavailable and nothing of why; once its owner dismisses it, null — and its owner hears nothing new", async () => {
    const w = await world();
    const [ownerS, memberS, thirdS] = await connectAll(w.owner, w.member, w.third);
    const failed = await seedRun(w.anna, w.owner, w.g, { status: "failed", error: "no_quota", resetsAt: RESETS_AT });
    await db.query(
      `insert into usage_records (owner_id, agent_id, run_id, purpose, source, model, input_tokens, output_tokens, cost_micro, free_micro, outcome)
       values ($1, $2, $3, 'reply', 'site', 'fast', $4, $5, $6, $6, 'failed')`,
      [w.owner.id, w.anna.id, failed.id, TOKENS.input, TOKENS.output, TOKENS.cost],
    );

    announce(w.owner, w.g, failed);
    const mine = await ownerS.next((e) => e.type === "run" && e.conversationId === w.g);
    expect(mine.run).toEqual({ id: failed.id, status: "failed", error: "no_quota", retryable: true, resetsAt: RESETS_AT });
    for (const s of [memberS, thirdS]) expect((await nextState(s, w.g, w.anna.id)).state).toBe("unavailable");

    // Dismissed by its owner: the others' line goes; the owner, who closed it, is not told again.
    const ownerRuns = runPushes(ownerS, w.g).length;
    expect(await api(app, w.owner, "POST", `/api/conversations/${w.g}/runs/dismiss`, { agentId: w.anna.id })).toEqual({ status: 200, json: { ok: true } });
    for (const s of [memberS, thirdS]) {
      const from = s.events.indexOf(runPushes(s, w.g)[0]!) + 1;
      expect((await nextState(s, w.g, w.anna.id, from)).state).toBeNull();
    }
    await settled(ownerS);
    expect(runPushes(ownerS, w.g)).toHaveLength(ownerRuns);

    // Not one frame to the others names the run, its error, its retry or reset, what it used or cost. (The ids the frame
    // does carry are taken out first, so a digit run inside one of them cannot pass for a count.)
    for (const s of [memberS, thirdS]) {
      const frames = runPushes(s, w.g).map((e) => JSON.stringify(e).split(w.g).join("<g>").split(w.anna.id).join("<anna>"));
      expect(frames).toHaveLength(2);
      for (const secret of [failed.id, "error", "no_quota", "retryable", "resetsAt", RESETS_AT, "2031", String(TOKENS.input), String(TOKENS.output), String(TOKENS.cost)]) {
        expect([secret, frames.filter((f) => f.includes(secret))]).toEqual([secret, []]);
      }
    }
  });

  it("done, stopped and cancelled (halted, agent_removed) are null to the others; their owner gets each run", async () => {
    const w = await world();
    const [ownerS, memberS, thirdS] = await connectAll(w.owner, w.member, w.third);
    const stateTo = async (s: TestSocket, agentId: string, nth: number) => {
      await s.waitFor((e) => e.type === "run" && e.conversationId === w.g && e.agentId === agentId && runPushes(s, w.g).filter((x) => x.agentId === agentId).length >= nth);
      const e = runPushes(s, w.g).filter((x) => x.agentId === agentId)[nth - 1]!;
      expect(Object.keys(e).sort()).toEqual(REDUCED_KEYS);
      return e.state;
    };

    // done
    const running = await seedRun(w.anna, w.owner, w.g, { status: "running" });
    announce(w.owner, w.g, running);
    expect(await stateTo(memberS, w.anna.id, 1)).toBe("replying");
    await db.query("update agent_runs set status = 'done', finished_at = now() where id = $1", [running.id]);
    announce(w.owner, w.g, await rowOf(running.id));
    expect(await stateTo(memberS, w.anna.id, 2)).toBeNull();
    expect((await ownerS.next((e) => e.type === "run" && e.run?.id === running.id && e.run.status === "done")).agentId).toBe(w.anna.id);

    // stopped, by its owner through the route
    const queued = await seedRun(w.anna, w.owner, w.g, { status: "queued" });
    expect(await api(app, w.owner, "POST", `/api/conversations/${w.g}/runs/${queued.id}/stop`)).toEqual({ status: 200, json: { ok: true } });
    expect((await ownerS.next((e) => e.type === "run" && e.run?.id === queued.id)).run).toEqual({ id: queued.id, status: "stopped", retryable: false });
    expect(await stateTo(memberS, w.anna.id, 3)).toBeNull();

    // halted: a member stops Agents calling each other; the queued run an Agent's message called for is cancelled
    const called = await seedRun(w.anna, w.owner, w.g, { status: "queued", by: "agent" });
    expect((await api(app, w.third, "POST", `/api/conversations/${w.g}/agents/halt`)).status).toBe(200);
    expect((await ownerS.next((e) => e.type === "run" && e.run?.id === called.id)).run).toEqual({ id: called.id, status: "cancelled", error: "halted", retryable: false });
    for (const s of [memberS, thirdS]) expect(await stateTo(s, w.anna.id, 4)).toBeNull();

    // agent_removed: its owner (the member) takes bob out while its reply is queued
    const bobs = await seedRun(w.bob, w.member, w.g, { status: "queued" });
    expect((await api(app, w.member, "DELETE", `/api/conversations/${w.g}/members/${w.bob.id}`)).status).toBe(200);
    const ended = await memberS.next((e) => e.type === "run" && e.run?.id === bobs.id);
    expect(ended).toEqual({ type: "run", conversationId: w.g, agentId: w.bob.id, run: { id: bobs.id, status: "cancelled", error: "agent_removed", retryable: false } });
    for (const s of [ownerS, thirdS]) expect(await stateTo(s, w.bob.id, 1)).toBeNull();

    for (const s of [memberS, thirdS, ownerS]) {
      const frames = runPushes(s, w.g)
        .filter((e) => "state" in e)
        .map((e) => JSON.stringify(e));
      expect(frames.filter((f) => /halted|agent_removed|stopped|cancelled|done|error|retryable/.test(f))).toEqual([]);
    }
  });

  it("two Agents of two owners: each owner gets their own Agent's run and only the state of the other's", async () => {
    const w = await world();
    const [ownerS, memberS, thirdS] = await connectAll(w.owner, w.member, w.third);
    const annas = await seedRun(w.anna, w.owner, w.g, { status: "failed", error: "provider_unavailable" });
    const bobs = await seedRun(w.bob, w.member, w.g, { status: "queued" });
    announce(w.owner, w.g, annas);
    announce(w.member, w.g, bobs);

    expect((await ownerS.next((e) => e.type === "run" && e.agentId === w.anna.id)).run).toEqual(toWireRun(annas));
    expect((await nextState(ownerS, w.g, w.bob.id)).state).toBe("replying");
    expect((await memberS.next((e) => e.type === "run" && e.agentId === w.bob.id)).run).toEqual(toWireRun(bobs));
    expect((await nextState(memberS, w.g, w.anna.id)).state).toBe("unavailable");
    expect((await nextState(thirdS, w.g, w.anna.id)).state).toBe("unavailable");
    expect((await nextState(thirdS, w.g, w.bob.id)).state).toBe("replying");
    await Promise.all([ownerS, memberS, thirdS].map(settled));
    expect([ownerS, memberS, thirdS].map((s) => runPushes(s, w.g).length)).toEqual([2, 2, 2]);
  });

  it("an owner who has left with their Agent still gets its final run once; the members who remain are told null", async () => {
    const w = await world();
    const [ownerS, memberS, thirdS] = await connectAll(w.owner, w.member, w.third);
    const queued = await seedRun(w.anna, w.owner, w.g, { status: "queued" });

    expect((await api(app, w.owner, "DELETE", `/api/conversations/${w.g}/members/${w.owner.id}`)).status).toBe(200);
    // So no line of theirs is left "replying": the cancellation reaches them, as well as the group being gone.
    const ended = await ownerS.next((e) => e.type === "run" && e.run?.id === queued.id);
    expect(ended).toEqual({ type: "run", conversationId: w.g, agentId: w.anna.id, run: { id: queued.id, status: "cancelled", error: "agent_removed", retryable: false } });
    await ownerS.next((e) => e.type === "gone" && e.id === w.g);
    for (const s of [memberS, thirdS]) expect((await nextState(s, w.g, w.anna.id)).state).toBeNull();
    await settled(ownerS);
    expect(runPushes(ownerS, w.g)).toHaveLength(1);
  });

  it("an Agent's own conversation keeps today's push: {type, conversationId, run}, to its owner only", async () => {
    const w = await world();
    const [ownerS, memberS] = await connectAll(w.owner, w.member);
    const queued = await seedRun(w.anna, w.owner, w.anna.conversationId, { status: "queued" });
    announce(w.owner, w.anna.conversationId, queued);
    const pushed = await ownerS.next((e) => e.type === "run" && e.conversationId === w.anna.conversationId);
    expect(pushed).toEqual({ type: "run", conversationId: w.anna.conversationId, run: { id: queued.id, status: "queued", retryable: false } });
    expect(Object.keys(pushed).sort()).toEqual(["conversationId", "run", "type"]);
    await settled(memberS);
    expect(memberS.events.filter((e) => e.type === "run")).toEqual([]);
  });

  it("what each reader is told is the database's at delivery: a stale announcement gives the others the state now, and the run goes to the owner the run row names, whoever the announcement names", async () => {
    const w = await world();
    const [ownerS, memberS, thirdS] = await connectAll(w.owner, w.member, w.third);
    const queued = await seedRun(w.anna, w.owner, w.g, { status: "queued" });
    await db.query("update agent_runs set status = 'done', started_at = now(), finished_at = now() where id = $1", [queued.id]);

    // Announced as it was (queued) after it ended: its owner gets the run announced; the others the state there now.
    announce(w.owner, w.g, queued);
    expect((await ownerS.next((e) => e.type === "run" && e.conversationId === w.g)).run).toEqual(toWireRun(queued));
    for (const s of [memberS, thirdS]) expect((await nextState(s, w.g, w.anna.id)).state).toBeNull();

    // An announcement naming another member as its owner: the run still reaches only the run's owner, and that member
    // only the state, as every other member.
    app.agentPort.announce({ ownerId: w.member.id, conversationId: w.g, run: toWireRun(queued) });
    for (const s of [memberS, thirdS]) {
      const from = s.events.indexOf(runPushes(s, w.g)[0]!) + 1;
      expect((await nextState(s, w.g, w.anna.id, from)).state).toBeNull();
    }
    await ownerS.waitFor(() => runPushes(ownerS, w.g).length >= 2);
    expect(runPushes(ownerS, w.g).map((e) => e.run)).toEqual([toWireRun(queued), toWireRun(queued)]);
    // In the Agent's own conversation too.
    const own = await seedRun(w.anna, w.owner, w.anna.conversationId, { status: "failed", error: "provider_unavailable" });
    app.agentPort.announce({ ownerId: w.member.id, conversationId: w.anna.conversationId, run: toWireRun(own) });
    expect(await ownerS.next((e) => e.type === "run" && e.conversationId === w.anna.conversationId)).toEqual({
      type: "run",
      conversationId: w.anna.conversationId,
      run: toWireRun(own),
    });
    for (const s of [memberS, thirdS]) {
      await settled(s);
      expect(runPushes(s, w.anna.conversationId)).toEqual([]);
      expect(runPushes(s, w.g).every((e) => Object.keys(e).sort().join() === REDUCED_KEYS.join())).toBe(true);
    }
  });

  it("a delivery whose read fails is tried once more; failing twice it is dropped and logged, and the next delivery goes out", async () => {
    const w = await world();
    const [ownerS, thirdS] = await connectAll(w.owner, w.third);
    const failed = await seedRun(w.anna, w.owner, w.g, { status: "failed", error: "provider_unavailable" });
    // The delivery's own read (`runAudience`) fails `failures` times; every other query goes through.
    const query = app.deps.db.query.bind(app.deps.db);
    let failures = 0;
    vi.spyOn(app.deps.db, "query").mockImplementation(((text: unknown, values?: unknown) => {
      if (failures > 0 && typeof text === "string" && text.includes("left join memberships am")) {
        failures--;
        return Promise.reject(new Error("connection reset"));
      }
      return (query as (t: unknown, v?: unknown) => unknown)(text, values);
    }) as never);
    const logged = vi.spyOn(app.log, "error");

    // Once: tried again, and delivered.
    failures = 1;
    announce(w.owner, w.g, failed);
    expect((await ownerS.next((e) => e.type === "run" && e.conversationId === w.g)).run).toEqual(toWireRun(failed));
    expect((await nextState(thirdS, w.g, w.anna.id)).state).toBe("unavailable");
    expect(failures).toBe(0);
    expect(logged).not.toHaveBeenCalled();

    // Twice: dropped, for everyone, and logged once with the run.
    failures = 2;
    announce(w.owner, w.g, failed);
    await vi.waitFor(() => expect(logged).toHaveBeenCalled());
    await Promise.all([ownerS, thirdS].map(settled));
    expect([ownerS, thirdS].map((s) => runPushes(s, w.g).length)).toEqual([1, 1]);
    expect(failures).toBe(0);
    expect(logged.mock.calls.map(([fields, message]) => [(fields as { runId?: string }).runId, message])).toEqual([
      [failed.id, "realtime: a run push was dropped: who is told what could not be read (twice)"],
    ]);

    // The conversation's queue goes on: the next delivery reaches them.
    announce(w.owner, w.g, failed);
    await thirdS.waitFor(() => runPushes(thirdS, w.g).length >= 2);
    await ownerS.waitFor(() => runPushes(ownerS, w.g).length >= 2);
  });

  it("one delivery reads the database once, however many members; re-announcing the reused rate_limited run tells the others the same state again", async () => {
    const w = await world();
    const sockets = await connectAll(w.owner, w.member, w.member, w.third, w.third);
    const thirdS = sockets[4]!;
    // Over the owner's own replies a minute: every mention of theirs reuses one failed rate_limited run (plan ruling 7; someone
    // else's call over the others' minute starts nothing, others-one-number.test.ts).
    await db.query(
      `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, created_at, finished_at, lane)
       select 'reply', $1, $2, $3, 'done', 0, now() - interval '30 seconds', now() - interval '29 seconds', 'own' from generate_series(1, $4)`,
      [w.anna.conversationId, w.anna.id, w.owner.id, app.deps.config.agentRunsPerMinute],
    );
    await say(w.owner, w.g, "@anna 一");
    await say(w.owner, w.g, "@anna 二");
    const limited = (await db.query<{ id: string }>("select id from agent_runs where agent_id = $1 and conversation_id = $2", [w.anna.id, w.g])).rows;
    expect(limited).toHaveLength(1);
    for (const s of sockets.slice(1)) {
      await s.waitFor((e) => e.type === "run" && e.conversationId === w.g && runPushes(s, w.g).length >= 2);
      expect(runPushes(s, w.g)).toEqual([0, 1].map(() => ({ type: "run", conversationId: w.g, agentId: w.anna.id, state: "unavailable" })));
    }
    await sockets[0]!.waitFor(() => runPushes(sockets[0]!, w.g).length >= 2);
    expect(runPushes(sockets[0]!, w.g).map((e) => e.run)).toEqual([0, 1].map(() => ({ id: limited[0]!.id, status: "failed", error: "rate_limited", retryable: true })));

    // The same run announced three more times: three reads in all, not one per member or socket.
    const before = runPushes(thirdS, w.g).length;
    const query = vi.spyOn(app.deps.db, "query");
    const row = await rowOf(limited[0]!.id);
    query.mockClear();
    for (let i = 0; i < 3; i++) announce(w.owner, w.g, row);
    await thirdS.waitFor(() => runPushes(thirdS, w.g).length >= before + 3);
    expect(query).toHaveBeenCalledTimes(3);
  });
});

// --- GET /api/conversations/:id/runs ---------------------------------------------------------------------------------

describe("GET /api/conversations/:id/runs", () => {
  it("per reader: the owner's entry carries the run, everyone else's only the state; nothing to show, no entry; in agentId order", async () => {
    const w = await world();
    const carl = await agentOf(w.owner, "carlbot", w.g); // its latest is done: nothing to show
    await agentOf(w.third, "quiet_bot", w.g); // no run at all
    const annas = await seedRun(w.anna, w.owner, w.g, { status: "failed", error: "no_quota", resetsAt: RESETS_AT });
    const bobs = await seedRun(w.bob, w.member, w.g, { status: "running" });
    await seedRun(carl, w.owner, w.g, { status: "failed", error: "provider_unavailable" });
    await seedRun(carl, w.owner, w.g, { status: "done" });
    const byId = <T extends { agentId: string }>(xs: T[]) => [...xs].sort((a, b) => (a.agentId < b.agentId ? -1 : 1));
    const runsOf = async (who: Actor) => {
      const res = await api(app, who, "GET", `/api/conversations/${w.g}/runs`);
      expect(res.status).toBe(200);
      return res.json.runs as Array<{ agentId: string }>;
    };

    const forOwner = await runsOf(w.owner);
    expect(forOwner).toEqual(
      byId([
        { agentId: w.anna.id, state: "unavailable", run: { id: annas.id, status: "failed", error: "no_quota", retryable: true, resetsAt: RESETS_AT } },
        { agentId: w.bob.id, state: "replying" },
      ]),
    );
    expect(await runsOf(w.member)).toEqual(
      byId([
        { agentId: w.anna.id, state: "unavailable" },
        { agentId: w.bob.id, state: "replying", run: { id: bobs.id, status: "running", retryable: false } },
      ]),
    );
    const forThird = await runsOf(w.third);
    expect(forThird).toEqual(byId([{ agentId: w.anna.id, state: "unavailable" }, { agentId: w.bob.id, state: "replying" }]));
    expect(forThird.map((e) => Object.keys(e).sort())).toEqual([["agentId", "state"], ["agentId", "state"]]);
    expect(JSON.stringify(forThird)).not.toMatch(new RegExp([annas.id, bobs.id, "no_quota", "2031", "error", "retryable"].join("|")));
    // Upper case works like everywhere else.
    expect((await api(app, w.third, "GET", `/api/conversations/${w.g.toUpperCase()}/runs`)).json.runs).toEqual(forThird);
  });

  it("a dismissed failure, an Agent that has left, and a failure from before an Agent's latest stay are not shown", async () => {
    const w = await world();
    const annas = await seedRun(w.anna, w.owner, w.g, { status: "failed", error: "provider_unavailable" });
    await seedRun(w.bob, w.member, w.g, { status: "failed", error: "provider_unavailable" });
    const shown = async () => (await api(app, w.third, "GET", `/api/conversations/${w.g}/runs`)).json.runs.map((e: { agentId: string }) => e.agentId).sort();
    expect(await shown()).toEqual([w.anna.id, w.bob.id].sort());

    await db.query("update agent_runs set dismissed_at = now() where id = $1", [annas.id]);
    expect(await shown()).toEqual([w.bob.id]);
    // bob leaves: its failure stays on its run, but it is no longer in the group.
    expect((await api(app, w.member, "DELETE", `/api/conversations/${w.g}/members/${w.bob.id}`)).status).toBe(200);
    expect(await shown()).toEqual([]);
    // Back again: what failed in its earlier stay is not this stay's.
    expect((await api(app, w.member, "POST", `/api/conversations/${w.g}/members`, { principalId: w.bob.id })).status).toBe(201);
    expect(await shown()).toEqual([]);
    expect((await api(app, w.member, "GET", `/api/conversations/${w.g}/runs`)).json).toEqual({ runs: [] });
    await seedRun(w.bob, w.member, w.g, { status: "queued" });
    expect(await shown()).toEqual([w.bob.id]);
  });

  it("anyone but a current member of the group gets a random id's answer; so does an Agent's own conversation, even its owner's, and a direct chat", async () => {
    const w = await world();
    await seedRun(w.anna, w.owner, w.g, { status: "queued" });
    await seedRun(w.anna, w.owner, w.anna.conversationId, { status: "failed", error: "provider_unavailable" });
    const { conversationId: direct } = await befriend(app, w.member, w.stranger);
    const runs = (id: string) => get(`/api/conversations/${id}/runs`);

    const reference = await observe(w.stranger, runs(RANDOM));
    expect(reference).toEqual({ status: 404, type: "application/json; charset=utf-8", body: '{"error":"not_found"}' });
    for (const [label, who, conv] of [
      ["never a member", w.stranger, w.g],
      ["left", w.leaver, w.g],
      ["its owner, its own conversation", w.owner, w.anna.conversationId],
      ["a direct chat, as a member", w.member, direct],
      ["a direct chat, as an outsider", w.third, direct],
      ["a random id", w.owner, RANDOM],
    ] as const) {
      expect([label, await observe(who, runs(conv))]).toEqual([label, reference]);
    }
    expect((await observe(null, runs(w.g))).status).toBe(401);
    // The Agent's own conversation keeps its own route; a group has none of it.
    expect((await api(app, w.owner, "GET", `/api/conversations/${w.anna.conversationId}/run`)).json.run).toMatchObject({ status: "failed" });
    expect(await observe(w.owner, get(`/api/conversations/${w.g}/run`))).toEqual(await observe(w.owner, get(`/api/conversations/${RANDOM}/run`)));
  });
});

// --- the owner's controls -------------------------------------------------------------------------------------------

describe("the owner's controls over a group run", () => {
  it("stop: its owner stops a run of their Agent in the group; anyone else, a run of another conversation, a random run: a random run's answer", async () => {
    const w = await world();
    const annas = await seedRun(w.anna, w.owner, w.g, { status: "queued" });
    const bobs = await seedRun(w.bob, w.member, w.g, { status: "queued" });
    const dedicated = await seedRun(w.anna, w.owner, w.anna.conversationId, { status: "queued" });
    const stop = (conv: string, run: string) => post(`/api/conversations/${conv}/runs/${run}/stop`);

    const unknownRun = await observe(w.member, stop(w.g, OTHER_RANDOM));
    expect(unknownRun).toEqual({ status: 404, type: "application/json; charset=utf-8", body: '{"error":"not_found"}' });
    for (const [label, who, conv, run] of [
      ["a fellow member who owns another Agent there", w.member, w.g, annas.id],
      ["a fellow member", w.third, w.g, annas.id],
      ["its owner, the other owner's run", w.owner, w.g, bobs.id],
      ["its owner, its run elsewhere", w.owner, w.g, dedicated.id],
      ["a former member", w.leaver, w.g, annas.id],
      ["a stranger", w.stranger, w.g, annas.id],
      ["a stranger, a random group", w.stranger, RANDOM, annas.id],
    ] as const) {
      expect([label, await observe(who, stop(conv, run))]).toEqual([label, unknownRun]);
    }
    for (const id of [annas.id, bobs.id, dedicated.id]) expect((await rowOf(id)).status).toBe("queued");

    expect(await api(app, w.owner, "POST", `/api/conversations/${w.g}/runs/${annas.id.toUpperCase()}/stop`, {})).toEqual({ status: 200, json: { ok: true } });
    expect((await rowOf(annas.id)).status).toBe("stopped");
    // Idempotent; the other owner's own works too.
    expect((await api(app, w.owner, "POST", `/api/conversations/${w.g}/runs/${annas.id}/stop`)).status).toBe(200);
    expect((await api(app, w.member, "POST", `/api/conversations/${w.g}/runs/${bobs.id}/stop`)).status).toBe(200);
    expect((await rowOf(bobs.id)).status).toBe("stopped");
  });

  it("stop of a running reply: the worker working on it stops it (what it said is posted, stopped); nobody else can; the others are told null", async () => {
    const w = await world();
    const [ownerS, memberS] = await connectAll(w.owner, w.member);
    const hold = gateway.hangAfter("我先看看");
    await say(w.member, w.g, "@anna 帮我看看");
    const run = (await db.query<{ id: string }>("select id from agent_runs where agent_id = $1 and conversation_id = $2", [w.anna.id, w.g])).rows[0]!;
    const working = app.agentWorker.runOnce();
    await hold.reached;
    expect((await rowOf(run.id)).status).toBe("running");
    expect((await nextState(memberS, w.g, w.anna.id)).state).toBe("replying");

    // Anyone but its owner: as a run that does not exist, and it goes on.
    const stop = post(`/api/conversations/${w.g}/runs/${run.id}/stop`);
    for (const who of [w.member, w.third]) expect(await observe(who, stop)).toEqual(await observe(who, post(`/api/conversations/${w.g}/runs/${OTHER_RANDOM}/stop`)));
    expect((await rowOf(run.id)).status).toBe("running");

    expect(await api(app, w.owner, "POST", `/api/conversations/${w.g}/runs/${run.id}/stop`)).toEqual({ status: 200, json: { ok: true } });
    expect(await working).toBe(true);
    expect((await rowOf(run.id)).status).toBe("stopped");
    const posted = await db.query("select body ->> 'text' as text, body ->> 'stopped' as stopped from messages where client_txn = $1", [run.id]);
    expect(posted.rows).toEqual([{ text: "我先看看", stopped: "true" }]);
    expect((await ownerS.next((e) => e.type === "run" && e.run?.status === "stopped")).run).toEqual({ id: run.id, status: "stopped", retryable: false });
    await memberS.waitFor(() => runPushes(memberS, w.g).filter((e) => e.state === null).length > 0);
    expect(runPushes(memberS, w.g).at(-1)).toEqual({ type: "run", conversationId: w.g, agentId: w.anna.id, state: null });
  });

  it("stop of a running reply nobody here is working on: released as recovery releases one; the others are told it is unavailable", async () => {
    const w = await world();
    const [ownerS, memberS] = await connectAll(w.owner, w.member);
    const running = await seedRun(w.anna, w.owner, w.g, { status: "running" });
    expect(await api(app, w.owner, "POST", `/api/conversations/${w.g}/runs/${running.id}/stop`)).toEqual({ status: 200, json: { ok: true } });
    const released = { id: running.id, status: "failed", error: "provider_unavailable", retryable: true };
    expect(toWireRun(await rowOf(running.id))).toEqual(released);
    expect((await ownerS.next((e) => e.type === "run" && e.run?.id === running.id)).run).toEqual(released);
    expect((await nextState(memberS, w.g, w.anna.id)).state).toBe("unavailable");
  });

  it("retry: names the failed run by its id and answers again what it covered (not its owner's last message); only its owner's", async () => {
    const w = await world();
    const asked = await say(w.member, w.g, "帮我看看");
    const failed = await seedRun(w.anna, w.owner, w.g, { status: "failed", error: "provider_unavailable", covers: asked });
    const bobs = await seedRun(w.bob, w.member, w.g, { status: "failed", error: "provider_unavailable", covers: asked });
    await say(w.owner, w.g, "我后来说的话");
    const retry = (conv: string, payload?: object | null) => post(`/api/conversations/${conv}/runs/retry`, payload);
    const [ownerS, thirdS] = await connectAll(w.owner, w.third);

    // Anyone but its owner: as a run that does not exist.
    const unknown = await observe(w.member, retry(w.g, { runId: RANDOM }));
    expect(unknown).toEqual({ status: 404, type: "application/json; charset=utf-8", body: '{"error":"not_found"}' });
    for (const [label, who, conv, runId] of [
      ["a fellow member who owns another Agent there", w.member, w.g, failed.id],
      ["a fellow member", w.third, w.g, failed.id],
      ["its owner, the other owner's Agent's failure", w.owner, w.g, bobs.id],
      ["a former member", w.leaver, w.g, failed.id],
      ["a stranger", w.stranger, w.g, failed.id],
    ] as const) {
      expect([label, await observe(who, retry(conv, { runId }))]).toEqual([label, unknown]);
    }
    // Its owner, without the failed run's id (an Agent's id no longer names one: T2 fix 1, F4): a bad request, nothing queued.
    for (const payload of [undefined, {}, null, { agentId: w.anna.id }, { runId: "anna" }]) {
      expect([payload, await api(app, w.owner, "POST", `/api/conversations/${w.g}/runs/retry`, payload)]).toEqual([payload, { status: 400, json: { error: "invalid_request" } }]);
    }
    expect((await db.query("select count(*)::int as n from agent_runs where conversation_id = $1", [w.g])).rows[0].n).toBe(2);

    const retried = await api(app, w.owner, "POST", `/api/conversations/${w.g}/runs/retry`, { runId: failed.id.toUpperCase() });
    expect(retried.status).toBe(201);
    expect(retried.json.run).toMatchObject({ status: "queued", retryable: false });
    expect(retried.json.run.id).not.toBe(failed.id);
    expect((await db.query("select covers_seq::int as covers, triggered_by from agent_runs where id = $1", [retried.json.run.id])).rows).toEqual([{ covers: asked, triggered_by: "human" }]);
    expect((await ownerS.next((e) => e.type === "run" && e.run?.id === retried.json.run.id)).agentId).toBe(w.anna.id);
    expect((await nextState(thirdS, w.g, w.anna.id)).state).toBe("replying");
    // While it is queued: busy.
    expect(await api(app, w.owner, "POST", `/api/conversations/${w.g}/runs/retry`, { runId: await latestRunId(db, w.g, w.anna.id) })).toEqual({ status: 409, json: { error: "busy_run" } });
  });

  it("retry: keeps whose message the failed run answered (an Agent's stays an Agent's, so a halt still stops it) and answers the same calls as it", async () => {
    const w = await world();
    const asked = await say(w.member, w.g, "先说一句");
    const folded = await say(w.third, w.g, "又说一句");
    // A reply an Agent's messages called for, two calls folded into it, that failed.
    const failed = await seedRun(w.anna, w.owner, w.g, { status: "failed", error: "provider_unavailable", covers: folded, calls: [asked, folded], by: "agent" });
    const retried = await api(app, w.owner, "POST", `/api/conversations/${w.g}/runs/retry`, { runId: await latestRunId(db, w.g, w.anna.id) });
    expect(retried.status).toBe(201);
    const runOf = async (id: string) =>
      (await db.query("select status, error, covers_seq::int as covers, call_seqs::int[] as calls, triggered_by as by from agent_runs where id = $1", [id])).rows[0];
    expect(await runOf(retried.json.run.id)).toEqual({ status: "queued", error: null, covers: folded, calls: [asked, folded], by: "agent" });
    expect((await runOf(failed.id)).status).toBe("failed");
    // A member's halt ends it as it ends every reply Agents called for.
    expect((await api(app, w.third, "POST", `/api/conversations/${w.g}/agents/halt`)).status).toBe(200);
    expect(await runOf(retried.json.run.id)).toMatchObject({ status: "cancelled", error: "halted" });

    // A person's failed reply is retried as a person's, and a halt leaves it alone.
    await say(w.member, w.g, "继续");
    const persons = await seedRun(w.anna, w.owner, w.g, { status: "failed", error: "provider_unavailable", by: "human" });
    const again = await api(app, w.owner, "POST", `/api/conversations/${w.g}/runs/retry`, { runId: await latestRunId(db, w.g, w.anna.id) });
    expect(again.status).toBe(201);
    const covered = (await runOf(persons.id)).covers;
    expect(await runOf(again.json.run.id)).toEqual({ status: "queued", error: null, covers: covered, calls: [covered], by: "human" });
    expect((await api(app, w.member, "POST", `/api/conversations/${w.g}/agents/halt`)).status).toBe(200);
    expect((await runOf(again.json.run.id)).status).toBe("queued");
  });

  it("retry: not after a halt or the Agent's leaving, nor for one that left; paused or deleted as in its own conversation", async () => {
    const w = await world();
    /** The owner's 重试 of the Agent's latest run in the group. */
    const retry = async (agentId: string) => api(app, w.owner, "POST", `/api/conversations/${w.g}/runs/retry`, { runId: await latestRunId(db, w.g, agentId) });
    const notRetryable = { status: 400, json: { error: "invalid_request" } };

    // Halted (cancelled): not retryable.
    await seedRun(w.anna, w.owner, w.g, { status: "cancelled", error: "halted" });
    expect(await retry(w.anna.id)).toEqual(notRetryable);
    // Failed, then the Agent left: nothing to retry, while it is out and after it is back.
    await seedRun(w.anna, w.owner, w.g, { status: "failed", error: "provider_unavailable" });
    expect((await api(app, w.owner, "DELETE", `/api/conversations/${w.g}/members/${w.anna.id}`)).status).toBe(200);
    expect(await retry(w.anna.id)).toEqual(notRetryable);
    expect((await api(app, w.owner, "POST", `/api/conversations/${w.g}/members`, { principalId: w.anna.id })).status).toBe(201);
    expect(await retry(w.anna.id)).toEqual(notRetryable);
    // agent_removed (cancelled) as its latest: the same.
    await seedRun(w.anna, w.owner, w.g, { status: "cancelled", error: "agent_removed" });
    expect(await retry(w.anna.id)).toEqual(notRetryable);
    // An Agent of the owner's never in the group: no run of it there to retry.
    const carl = await agentOf(w.owner, "carlbot", null);
    expect(await retry(carl.id)).toEqual({ status: 404, json: { error: "not_found" } });

    await seedRun(w.anna, w.owner, w.g, { status: "failed", error: "provider_unavailable" });
    expect((await api(app, w.owner, "POST", `/api/agents/${w.anna.id}/pause`)).status).toBe(200);
    expect(await retry(w.anna.id)).toEqual({ status: 409, json: { error: "agent_paused" } });
    expect((await api(app, w.owner, "POST", `/api/agents/${w.anna.id}/resume`)).status).toBe(200);
    expect((await retry(w.anna.id)).status).toBe(201);
    expect((await db.query("select count(*)::int as n from agent_runs where conversation_id = $1 and status = 'queued'", [w.g])).rows[0].n).toBe(1);

    // Deleted (which also takes it out of the group): 409 agent_deleted, as in its own conversation; nothing is queued.
    const bobFailed = await seedRun(w.bob, w.member, w.g, { status: "failed", error: "provider_unavailable" });
    const bobOwnFailed = await seedRun(w.bob, w.member, w.bob.conversationId, { status: "failed", error: "provider_unavailable" });
    expect((await api(app, w.member, "DELETE", `/api/agents/${w.bob.id}`)).status).toBe(200);
    expect(await api(app, w.member, "POST", `/api/conversations/${w.g}/runs/retry`, { runId: bobFailed.id })).toEqual({ status: 409, json: { error: "agent_deleted" } });
    expect((await api(app, w.member, "POST", `/api/conversations/${w.bob.conversationId}/runs/retry`, { runId: bobOwnFailed.id })).json).toEqual({ error: "agent_deleted" });
    expect((await db.query("select id from agent_runs where agent_id = $1 and status = 'queued'", [w.bob.id])).rows).toEqual([]);
    expect((await rowOf(bobFailed.id)).status).toBe("failed");
  });

  it("dismiss: its owner's only; the others are told null; idempotent; it works for an Agent that has left", async () => {
    const w = await world();
    const failed = await seedRun(w.anna, w.owner, w.g, { status: "failed", error: "provider_unavailable" });
    const dismiss = (conv: string, payload?: object | null) => post(`/api/conversations/${conv}/runs/dismiss`, payload);
    const dismissed = async (id: string) => (await rowOf(id)).dismissed_at !== null;

    const unknown = await observe(w.member, dismiss(w.g, { agentId: RANDOM }));
    expect(unknown).toEqual({ status: 404, type: "application/json; charset=utf-8", body: '{"error":"not_found"}' });
    for (const [label, who, agentId] of [
      ["a fellow member who owns another Agent there", w.member, w.anna.id],
      ["a fellow member", w.third, w.anna.id],
      ["a former member", w.leaver, w.anna.id],
      ["a stranger", w.stranger, w.anna.id],
    ] as const) {
      expect([label, await observe(who, dismiss(w.g, { agentId }))]).toEqual([label, unknown]);
    }
    expect(await dismissed(failed.id)).toBe(false);
    expect(await api(app, w.owner, "POST", `/api/conversations/${w.g}/runs/dismiss`)).toEqual({ status: 400, json: { error: "invalid_request" } });

    const thirdS = await connect(app, w.third);
    expect(await api(app, w.owner, "POST", `/api/conversations/${w.g}/runs/dismiss`, { agentId: w.anna.id })).toEqual({ status: 200, json: { ok: true } });
    expect(await dismissed(failed.id)).toBe(true);
    expect((await nextState(thirdS, w.g, w.anna.id)).state).toBeNull();
    // Again: nothing changes, nobody is told.
    expect(await api(app, w.owner, "POST", `/api/conversations/${w.g}/runs/dismiss`, { agentId: w.anna.id })).toEqual({ status: 200, json: { ok: true } });
    await settled(thirdS);
    expect(runPushes(thirdS, w.g)).toHaveLength(1);
    // Not a failure: nothing to dismiss.
    const queued = await seedRun(w.anna, w.owner, w.g, { status: "queued" });
    expect((await api(app, w.owner, "POST", `/api/conversations/${w.g}/runs/dismiss`, { agentId: w.anna.id })).status).toBe(200);
    expect(await dismissed(queued.id)).toBe(false);

    // bob failed and then left: its owner can still close that failure.
    const bobs = await seedRun(w.bob, w.member, w.g, { status: "failed", error: "provider_unavailable" });
    expect((await api(app, w.member, "DELETE", `/api/conversations/${w.g}/members/${w.bob.id}`)).status).toBe(200);
    expect(await api(app, w.member, "POST", `/api/conversations/${w.g}/runs/dismiss`, { agentId: w.bob.id })).toEqual({ status: 200, json: { ok: true } });
    expect(await dismissed(bobs.id)).toBe(true);
  });

  it("an Agent's own conversation: a 重试 names its failure by id as in a group; a dismiss needs no body, and an agentId there plays no part", async () => {
    const w = await world();
    const conv = w.anna.conversationId;
    // An owner's message to answer (its own reply is ended here: none is under way when the failed run is seeded).
    await say(w.owner, conv, "你好");
    await db.query("update agent_runs set status = 'done', finished_at = now() where conversation_id = $1 and status = 'queued'", [conv]);
    const failed = await seedRun(w.anna, w.owner, conv, { status: "failed", error: "provider_unavailable" });
    expect(await api(app, w.owner, "GET", `/api/conversations/${conv}/run`)).toEqual({ status: 200, json: { run: toWireRun(failed) } });
    expect(await api(app, w.owner, "POST", `/api/conversations/${conv}/runs/dismiss`)).toEqual({ status: 200, json: { ok: true } });
    expect(await api(app, w.owner, "GET", `/api/conversations/${conv}/run`)).toEqual({ status: 200, json: { run: null } });

    const again = await seedRun(w.anna, w.owner, conv, { status: "failed", error: "provider_unavailable" });
    // Another Agent's run is not this conversation's to retry.
    const bobs = await seedRun(w.bob, w.member, w.bob.conversationId, { status: "failed", error: "provider_unavailable" });
    expect(await api(app, w.owner, "POST", `/api/conversations/${conv}/runs/retry`, { runId: bobs.id })).toEqual({ status: 404, json: { error: "not_found" } });
    const retried = await api(app, w.owner, "POST", `/api/conversations/${conv}/runs/retry`, { runId: again.id });

    expect(retried.status).toBe(201);
    expect((await db.query("select agent_id, conversation_id from agent_runs where id = $1", [retried.json.run.id])).rows).toEqual([{ agent_id: w.anna.id, conversation_id: conv }]);
    expect(await api(app, w.owner, "POST", `/api/conversations/${conv}/runs/${retried.json.run.id}/stop`)).toEqual({ status: 200, json: { ok: true } });
    expect(await api(app, w.owner, "POST", `/api/conversations/${conv}/runs/dismiss`, { agentId: RANDOM })).toEqual({ status: 200, json: { ok: true } });
    // Anybody else: as before, a random id's answer.
    for (const path of ["runs/retry", "runs/dismiss"]) {
      expect(await observe(w.member, post(`/api/conversations/${conv}/${path}`))).toEqual(await observe(w.member, post(`/api/conversations/${RANDOM}/${path}`)));
    }
  });
});
