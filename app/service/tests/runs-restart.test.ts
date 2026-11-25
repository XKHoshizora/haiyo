import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recoverRuns } from "../src/agents/port-impl.ts";
import { isRunEnd } from "../src/agents/runtime/port.ts";
import { lockAgent } from "../src/agents/store.ts";
import { buildApp } from "../src/app.ts";
import type { BlobStore } from "../src/attachments/blob.ts";
import type { Db } from "../src/db.ts";
import { settle } from "../src/metering/settle.ts";
import type { ModelGateway } from "../src/models/gateway.ts";
import { api, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useProbeBlobs } from "./helpers/blobs.ts";
import { NO_ANSWER_FLOOR, useApp } from "./helpers/harness.ts";
import { runningRun } from "./helpers/metering.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { MULTIPART, multipart } from "./helpers/multipart.ts";
import { closeAllSockets, connect } from "./helpers/ws.ts";

/**
 * The service dying mid-reply (review focus 5, spec 6.4 and 6.5, README "Agents and runs"): at the next start, before
 * the worker, every run left `running` is ended without a model call — `failed` / `provider_unavailable` and
 * retryable, or `done` when its reply had been posted, or `cancelled` when its Agent's pause or delete had interrupted
 * it — and its hold released by a settlement that costs nothing. No second call, no duplicate message, no hold left.
 * A graceful stop ends the runs its own worker and draft requests were working on in the same way itself (within 5 s);
 * a crash is what the tests below make by driving the port by hand (no worker holds the run) or by a database that
 * stops answering. Each test builds the apps it stops and starts on the same database.
 */

const store = useProbeBlobs("af-restart-");
// The file's own app only gives the configuration and empties the database before each test; every test builds the
// apps it stops and starts.
const { app: base, db } = useApp({ env: SITE_ENV, models: scriptedGateway(), agentWorker: false });

const FAST = { source: "site", id: "fast" } as const;
const PERSONA = "简短地回答。";
const NOTHING = { inputChars: 0, outputChars: 0 };

const open: FastifyInstance[] = [];
afterEach(async () => {
  await closeAllSockets();
  for (const app of open.splice(0)) await app.close();
});

/** A new app on the test database (or `database`), as if the service started: ready, its worker driven by hand. */
async function start(models: ModelGateway, blobs: BlobStore = store.blobs, lines?: string[], database: Db = db): Promise<FastifyInstance> {
  const app = await buildApp(
    { config: base.deps.config, db: database, models, blobs },
    {
      agentWorker: false,
      answerFloor: NO_ANSWER_FLOOR,
      staleRunSweep: false,
      ...(lines ? { logStream: { write: (l: string) => void lines.push(l) } } : {}),
    },
  );
  await app.ready();
  open.push(app);
  return app;
}
/**
 * The test database, except that once `stall()` is called every transaction begun waits until `release()` and then
 * fails (a database that stopped answering). Closing it closes nothing: the test's own pool stays open.
 */
function stallingDb(): { db: Db; stall(): void; release(): void } {
  let stalled: Promise<void> | null = null;
  let open!: () => void;
  return {
    db: {
      get pool() {
        return db.pool;
      },
      query: ((...args: unknown[]) => (db.query as (...a: unknown[]) => unknown)(...args)) as Db["query"],
      tx: (fn) => (stalled ? stalled.then(() => Promise.reject(new Error("the database did not answer"))) : db.tx(fn)),
      close: async () => {},
    },
    stall() {
      stalled = new Promise<void>((resolve) => (open = resolve));
    },
    release() {
      open();
    },
  };
}

/** Closes `app` (the service stops) and forgets it. */
async function stop(app: FastifyInstance): Promise<void> {
  open.splice(open.indexOf(app), 1);
  await app.close();
}

let txn = 0;
const say = (app: FastifyInstance, owner: Actor, conv: string, text: string) =>
  api(app, owner, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `rs${++txn}` });
const latestRun = async (app: FastifyInstance, owner: Actor, conv: string) => (await api(app, owner, "GET", `/api/conversations/${conv}/run`)).json.run;
const fromAgent = async (app: FastifyInstance, owner: Actor, conv: string, agentId: string): Promise<any[]> =>
  (await api(app, owner, "GET", `/api/conversations/${conv}/messages`)).json.messages.filter((m: any) => m.senderId === agentId);
const holds = async () => (await db.query<{ h: string }>("select coalesce(sum(hold_micro), 0)::text as h from agent_runs")).rows[0]!.h;
const records = async (runId: string) =>
  (
    await db.query(
      `select outcome, source, model, estimated, cost_micro::text as cost, free_micro::text as free, balance_micro::text as balance
         from usage_records where run_id = $1`,
      [runId],
    )
  ).rows;
const statusOf = async (runId: string) =>
  (await db.query("select status, error, source, hold_micro::text as hold from agent_runs where id = $1", [runId])).rows[0];

/** A person (signed up on `app`) with an Agent on the free site model. */
async function owned(app: FastifyInstance, name: string) {
  const owner = await signUp(app, name);
  const agent = await mustCreateAgent(app, owner, { model: FAST, persona: PERSONA });
  return { owner, agent, conv: agent.conversationId as string };
}

describe("a reply in progress when the service stops", () => {
  it("is ended by the stopping service itself: failed and retryable, nothing held, nothing left for the next start; retry then works", async () => {
    const before = scriptedGateway();
    const old = await start(before);
    const { owner, agent, conv } = await owned(old, "rex");
    const hold = before.hang();
    await say(old, owner, conv, "你好");
    const running = old.agentWorker.runOnce();
    const call = await hold.reached;
    const run = await latestRun(old, owner, conv);
    expect(run).toMatchObject({ status: "running" });
    expect(await holds()).not.toBe("0"); // admitted: its maximum cost is held

    await stop(old);
    expect(call.signal.aborted).toBe(true);
    // Before any new start: what recovery would have written, written by the service that stopped.
    expect(await statusOf(run.id)).toMatchObject({ status: "failed", error: "provider_unavailable", hold: "0" });
    expect(await holds()).toBe("0");
    expect(await records(run.id)).toEqual([{ outcome: "failed", source: "site", model: "fast", estimated: true, cost: "0", free: "0", balance: "0" }]);
    await running;
    expect(await recoverRuns(db, base.deps.config, base.log)).toBe(0);

    const after = scriptedGateway();
    const fresh = await start(after);
    expect(after.calls).toHaveLength(0);
    expect(await latestRun(fresh, owner, conv)).toEqual({ id: run.id, status: "failed", error: "provider_unavailable", retryable: true });
    expect(await records(run.id)).toHaveLength(1);
    expect(await fromAgent(fresh, owner, conv, agent.id)).toEqual([]);
    expect(await fresh.agentWorker.runOnce()).toBe(false);
    expect(after.calls).toHaveLength(0);

    after.reply("我回来了。");
    expect((await api(fresh, owner, "POST", `/api/conversations/${conv}/runs/retry`)).status).toBe(201);
    expect(await fresh.agentWorker.runOnce()).toBe(true);
    expect((await fromAgent(fresh, owner, conv, agent.id)).map((m) => m.text)).toEqual(["我回来了。"]);
    expect(await latestRun(fresh, owner, conv)).toMatchObject({ status: "done" });
    expect(await holds()).toBe("0");
  });

  it("whose ending cannot be written (the database stopped answering): the stop returns within its 5 s, and the next start recovers the run", { timeout: 20_000 }, async () => {
    const stalling = stallingDb();
    const before = scriptedGateway();
    const old = await start(before, store.blobs, undefined, stalling.db);
    const { owner, conv } = await owned(old, "stuck");
    const hold = before.hang();
    await say(old, owner, conv, "你好");
    const running = old.agentWorker.runOnce();
    await hold.reached;
    const run = await latestRun(old, owner, conv);

    stalling.stall();
    const t0 = performance.now();
    await stop(old);
    expect(performance.now() - t0).toBeLessThan(6500);
    expect(await statusOf(run.id)).toMatchObject({ status: "running" });
    stalling.release();
    await running;
    // The write failed: the run is left as it was, for the stale-run sweep or the next start.
    expect(await statusOf(run.id)).toMatchObject({ status: "running" });
    expect(await records(run.id)).toEqual([]);

    const after = scriptedGateway();
    await start(after);
    expect(after.calls).toHaveLength(0);
    expect(await statusOf(run.id)).toMatchObject({ status: "failed", error: "provider_unavailable", hold: "0" });
    expect(await records(run.id)).toEqual([{ outcome: "failed", source: "site", model: "fast", estimated: true, cost: "0", free: "0", balance: "0" }]);
    expect(await holds()).toBe("0");
  });
});

describe("a run left running when the service stopped", () => {
  it("whose reply was posted before the stop (the crash fell between post and finish) is done, with exactly one message", async () => {
    const old = await start(scriptedGateway());
    const { owner, agent, conv } = await owned(old, "posty");
    await say(old, owner, conv, "你好");
    const ticket = (await old.agentPort.claimNext())!;
    expect(isRunEnd(await old.agentPort.begin(ticket))).toBe(false);
    expect(await old.agentPort.post(ticket, { text: "已经说完了。", reasoning: "", stopped: false, truncated: false })).toBe("posted");
    await stop(old);

    const after = scriptedGateway();
    const fresh = await start(after);
    expect(await latestRun(fresh, owner, conv)).toEqual({ id: ticket.id, status: "done", retryable: false });
    expect((await fromAgent(fresh, owner, conv, agent.id)).map((m) => m.text)).toEqual(["已经说完了。"]);
    expect(await records(ticket.id)).toEqual([{ outcome: "done", source: "site", model: "fast", estimated: true, cost: "0", free: "0", balance: "0" }]);
    expect(await holds()).toBe("0");
    expect(await fresh.agentWorker.runOnce()).toBe(false);
    expect(after.calls).toHaveLength(0);
  });

  it("whose reply was posted as stopped by its owner is recorded stopped, as finish would have", async () => {
    const old = await start(scriptedGateway());
    const { owner, agent, conv } = await owned(old, "halted");
    await say(old, owner, conv, "讲吧");
    const ticket = (await old.agentPort.claimNext())!;
    await old.agentPort.begin(ticket);
    expect(await old.agentPort.post(ticket, { text: "讲到一半", reasoning: "", stopped: true, truncated: false })).toBe("posted");
    await stop(old);

    const fresh = await start(scriptedGateway());
    expect(await latestRun(fresh, owner, conv)).toEqual({ id: ticket.id, status: "stopped", retryable: false });
    expect(await fromAgent(fresh, owner, conv, agent.id)).toMatchObject([{ text: "讲到一半", stopped: true }]);
    expect(await records(ticket.id)).toMatchObject([{ outcome: "stopped", cost: "0" }]);
  });

  it("whose reply was posted while the owner wrote more: done, and the follow-up answers what came meanwhile", async () => {
    const old = await start(scriptedGateway());
    const { owner, agent, conv } = await owned(old, "follow");
    await say(old, owner, conv, "第一句");
    const ticket = (await old.agentPort.claimNext())!;
    await old.agentPort.begin(ticket);
    await say(old, owner, conv, "第二句"); // noted on the running reply
    expect(await old.agentPort.post(ticket, { text: "回第一句。", reasoning: "", stopped: false, truncated: false })).toBe("posted");
    await stop(old);

    const after = scriptedGateway();
    const fresh = await start(after);
    expect(await statusOf(ticket.id)).toMatchObject({ status: "done" });
    expect(await latestRun(fresh, owner, conv)).toMatchObject({ status: "queued" });
    after.reply("回第二句。");
    expect(await fresh.agentWorker.runOnce()).toBe(true);
    expect((await fromAgent(fresh, owner, conv, agent.id)).map((m) => m.text)).toEqual(["回第一句。", "回第二句。"]);
  });

  it("that its Agent's pause had interrupted is cancelled with that reason; queued runs stay queued and the new service answers them", async () => {
    const old = await start(scriptedGateway());
    const a = await owned(old, "paws");
    const b = await mustCreateAgent(old, a.owner, { model: FAST, persona: PERSONA });
    await say(old, a.owner, a.conv, "你好");
    const ticket = (await old.agentPort.claimNext())!;
    await old.agentPort.begin(ticket);
    expect((await api(old, a.owner, "POST", `/api/agents/${a.agent.id}/pause`)).status).toBe(200);
    await say(old, a.owner, b.conversationId, "另一个"); // queued, never claimed
    const queued = await latestRun(old, a.owner, b.conversationId);
    expect(queued).toMatchObject({ status: "queued" });
    await stop(old);

    const after = scriptedGateway();
    const fresh = await start(after);
    expect(await latestRun(fresh, a.owner, a.conv)).toEqual({ id: ticket.id, status: "cancelled", error: "agent_paused", retryable: false });
    expect(await records(ticket.id)).toMatchObject([{ outcome: "cancelled", cost: "0" }]);
    expect(await latestRun(fresh, a.owner, b.conversationId)).toEqual(queued);
    expect(after.calls).toHaveLength(0);

    after.reply("现在回答。");
    expect(await fresh.agentWorker.runOnce()).toBe(true);
    expect((await fromAgent(fresh, a.owner, b.conversationId, b.id)).map((m) => m.text)).toEqual(["现在回答。"]);
    expect(await fresh.agentWorker.runOnce()).toBe(false);
    expect(await holds()).toBe("0");
  });

  it("that already has its usage record gets no second one; a persona draft left running is released too", async () => {
    const old = await start(scriptedGateway());
    const { owner, conv } = await owned(old, "twice");
    await say(old, owner, conv, "你好");
    const ticket = (await old.agentPort.claimNext())!;
    await old.agentPort.begin(ticket);
    // Settled, but the service stopped before the run left `running`.
    await db.tx((t) => settle(t, old.deps.config, ticket.id, null, NOTHING, "failed", new Date(), { log: old.log }));
    const draft = await runningRun(db, owner.id);
    await stop(old);

    await start(scriptedGateway());
    expect(await statusOf(ticket.id)).toMatchObject({ status: "failed", error: "provider_unavailable", hold: "0" });
    expect(await records(ticket.id)).toHaveLength(1);
    expect(await statusOf(draft)).toMatchObject({ status: "failed", error: "provider_unavailable", hold: "0" });
    expect(await records(draft)).toEqual([{ outcome: "failed", source: null, model: null, estimated: true, cost: "0", free: "0", balance: "0" }]);
  });

  it("a persona draft under way when the service stops is ended by that service: 503 busy, failed, nothing held, nothing for the next start", async () => {
    const before = scriptedGateway();
    const old = await start(before);
    const owner = await signUp(old, "drafty");
    const hold = before.hang();
    const answer = api(old, owner, "POST", "/api/agents/draft-persona", { name: "小橘", model: FAST });
    const call = await hold.reached;
    const draft = (await db.query<{ id: string }>("select id from agent_runs where owner_id = $1", [owner.id])).rows[0]!.id;
    expect(await statusOf(draft)).toMatchObject({ status: "running", source: "site" });
    expect(await holds()).not.toBe("0");

    await stop(old);
    expect(call.signal.aborted).toBe(true);
    expect(await answer).toEqual({ status: 503, json: { error: "busy" } });
    expect(await statusOf(draft)).toMatchObject({ status: "failed", error: "provider_unavailable", hold: "0" });
    expect(await records(draft)).toEqual([{ outcome: "failed", source: "site", model: "fast", estimated: true, cost: "0", free: "0", balance: "0" }]);
    expect(await recoverRuns(db, base.deps.config, base.log)).toBe(0);

    const after = scriptedGateway();
    await start(after);
    expect(after.calls).toHaveLength(0);
    expect(await records(draft)).toHaveLength(1);
  });
});

describe("the service starting to close while a reply waits for its admission", () => {
  it("is seen inside the admitting transaction: nothing is admitted and begin rejects, leaving the run to its caller (the worker ends it as recovery would)", async () => {
    let open!: () => void;
    let reached!: () => void;
    const reading = new Promise<void>((resolve) => (reached = resolve));
    const gate = new Promise<void>((resolve) => (open = resolve));
    store.probe.beforeGet = async () => {
      reached();
      await gate;
    };
    const old = await start(scriptedGateway());
    const { owner, agent, conv } = await owned(old, "closer");
    const upload = await old.inject({
      method: "POST",
      url: `/api/conversations/${conv}/attachments`,
      headers: { cookie: owner.cookie, "content-type": MULTIPART },
      payload: multipart([{ name: "file", filename: "notes.txt", type: "text/plain", data: "一些笔记" }]),
    });
    expect((await api(old, owner, "POST", `/api/conversations/${conv}/messages`, { attachmentId: upload.json().id, clientTxn: "rs-close" })).status).toBe(201);
    const ticket = (await old.agentPort.claimNext())!;
    const closing = new AbortController();
    const begun = old.agentPort.begin(ticket, closing.signal);
    begun.catch(() => {});
    await reading; // step 2: the attachment is being read, no transaction open

    // Someone holds the Agent's locks, so step 3 waits for them after the read; meanwhile the service starts closing.
    let release!: () => void;
    let held!: () => void;
    const holding = new Promise<void>((resolve) => (held = resolve));
    let holderPid = 0;
    const holder = db.tx(async (t) => {
      await lockAgent(t, agent.id);
      holderPid = (await t.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
      held();
      await new Promise<void>((resolve) => (release = resolve));
    });
    await holding;
    open();
    // Step 3 waits for the Agent's conversation row, which the holder has locked.
    const waitingForTheAgent = () =>
      db.query("select 1 from pg_stat_activity where $1 = any(pg_blocking_pids(pid)) and query ilike '%from conversations where id%for update%'", [holderPid]);
    await vi.waitFor(async () => expect((await waitingForTheAgent()).rowCount).toBe(1));
    closing.abort(new Error("the service is closing"));
    release();
    await holder;

    await expect(begun).rejects.toThrow("the service is closing");
    expect(await statusOf(ticket.id)).toEqual({ status: "running", error: null, source: null, hold: "0" });
    expect(await records(ticket.id)).toEqual([]);
    expect(await holds()).toBe("0");
  });
});

describe("a second instance started while the first still answers (a deploy where old and new overlap)", () => {
  it("the new one's recovery ends the old one's reply; the old one then posts nothing and records nothing more, and tells its owner how the run stands", async () => {
    const before = scriptedGateway();
    const old = await start(before);
    const { owner, agent, conv } = await owned(old, "overlap");
    const socket = await connect(old, owner);
    const hold = before.hang();
    await say(old, owner, conv, "你好");
    const running = old.agentWorker.runOnce();
    await hold.reached;
    const run = await latestRun(old, owner, conv);
    expect(run).toMatchObject({ status: "running" });
    const runningAt = await socket.waitFor((e) => e.type === "run" && e.run.id === run.id && e.run.status === "running");

    // The new instance starts: its recovery ends the run as one the previous process left running.
    const after = scriptedGateway();
    await start(after);
    expect(await statusOf(run.id)).toMatchObject({ status: "failed", error: "provider_unavailable", hold: "0" });
    expect(await records(run.id)).toHaveLength(1);

    // The old instance's call finishes after that: it must not post, and must not settle or record the run again.
    hold.release("旧实例写完了。");
    await running;
    expect(await db.query("select 1 from messages where sender_id = $1", [agent.id]).then((r) => r.rowCount)).toBe(0);
    expect(await statusOf(run.id)).toMatchObject({ status: "failed", error: "provider_unavailable", hold: "0" });
    expect(await records(run.id)).toEqual([{ outcome: "failed", source: "site", model: "fast", estimated: true, cost: "0", free: "0", balance: "0" }]);
    expect(after.calls).toHaveLength(0);
    // Its sockets were told it was running; they are now told how it ended, so no "replying" stays shown.
    expect((await socket.next((e) => e.type === "run" && e.run.id === run.id, { from: runningAt + 1, timeoutMs: 2000 })).run).toEqual({
      id: run.id,
      status: "failed",
      error: "provider_unavailable",
      retryable: true,
    });
  });
});

describe("a run's stop and silence flags", () => {
  it("are forgotten when the stale-run sweep releases the run, and when finish fails", async () => {
    const failing = { on: false };
    const app = await start(scriptedGateway(), store.blobs, undefined, {
      get pool() {
        return db.pool;
      },
      query: ((...args: unknown[]) => (db.query as (...a: unknown[]) => unknown)(...args)) as Db["query"],
      tx: (fn) => (failing.on ? Promise.reject(new Error("the database refused")) : db.tx(fn)),
      close: async () => {},
    });
    const swept = await owned(app, "flagsswept");
    await say(app, swept.owner, swept.conv, "你好");
    const left = (await app.agentPort.claimNext())!;
    await app.agentPort.begin(left);
    expect((await api(app, swept.owner, "POST", `/api/agents/${swept.agent.id}/pause`)).status).toBe(200);
    expect(app.agentPort.shouldStop(left)).toBe(true);
    await db.query("update agent_runs set started_at = now() - interval '42 minutes' where id = $1", [left.id]);
    expect(await app.staleRunSweep.run()).toBe(1);
    expect(app.agentPort.shouldStop(left)).toBe(false);

    const thrown = await owned(app, "flagsthrown");
    await say(app, thrown.owner, thrown.conv, "你好");
    const ticket = (await app.agentPort.claimNext())!;
    await app.agentPort.begin(ticket);
    app.agentPort.requestStop(ticket.id);
    expect(app.agentPort.shouldStop(ticket)).toBe(true);
    failing.on = true;
    await expect(app.agentPort.finish(ticket, { status: "stopped" }, null, NOTHING)).rejects.toThrow("the database refused");
    failing.on = false;
    expect(app.agentPort.shouldStop(ticket)).toBe(false);
    expect(await statusOf(ticket.id)).toMatchObject({ status: "running" }); // for the sweep or the next start
  });
});

describe("a run another instance ended while this one was still starting it", () => {
  it("is not started: the worker logs it at warn (not as an error) and records nothing more", async () => {
    let open!: () => void;
    let reached!: () => void;
    const reading = new Promise<void>((resolve) => (reached = resolve));
    const gate = new Promise<void>((resolve) => (open = resolve));
    store.probe.beforeGet = async () => {
      reached();
      await gate;
    };
    const lines: string[] = [];
    const before = scriptedGateway();
    const old = await start(before, store.blobs, lines);
    const { owner, agent, conv } = await owned(old, "startled");
    const upload = await old.inject({
      method: "POST",
      url: `/api/conversations/${conv}/attachments`,
      headers: { cookie: owner.cookie, "content-type": MULTIPART },
      payload: multipart([{ name: "file", filename: "notes.txt", type: "text/plain", data: "一些笔记" }]),
    });
    expect((await api(old, owner, "POST", `/api/conversations/${conv}/messages`, { attachmentId: upload.json().id, clientTxn: "rs-startled" })).status).toBe(201);
    const running = old.agentWorker.runOnce();
    await reading; // begin's step 2
    const run = await latestRun(old, owner, conv);

    await start(scriptedGateway()); // a second instance: its recovery ends the run
    expect(await statusOf(run.id)).toMatchObject({ status: "failed", error: "provider_unavailable", hold: "0" });
    open();
    await running;

    expect(before.calls).toHaveLength(0);
    expect(await statusOf(run.id)).toMatchObject({ status: "failed", error: "provider_unavailable", hold: "0" });
    expect(await records(run.id)).toHaveLength(1);
    expect(await db.query("select 1 from messages where sender_id = $1", [agent.id]).then((r) => r.rowCount)).toBe(0);
    const about = lines.map((l) => JSON.parse(l) as { msg: string; runId?: string; level: number }).filter((l) => l.runId === run.id);
    expect(about).toEqual([expect.objectContaining({ level: 40, msg: expect.stringMatching(/ended elsewhere/) })]);
  });
});

describe("the stale-run sweep", () => {
  /** Makes the run look as if it had been running for `minutes`. */
  const age = (runId: string, minutes: number) => db.query("update agent_runs set started_at = now() - make_interval(mins => $2) where id = $1", [runId, minutes]);
  // AGENT_RUN_TIMEOUT_MS is 2 minutes, TOOLS.runTimeoutMs 5 and MODEL_CALL_CEILING_MS 30 here: a run is stale after 2 × max(2, 5) + 30 + 1 = 41 minutes.

  it("releases a running run no worker holds once it is old enough — as start-up recovery would — and leaves a fresh one alone", async () => {
    const gateway = scriptedGateway();
    const app = await start(gateway);
    const { owner, agent, conv } = await owned(app, "sweepy");
    await say(app, owner, conv, "你好");
    // Claimed and admitted, then left: what an instance that died mid-call leaves behind.
    const ticket = (await app.agentPort.claimNext())!;
    expect(isRunEnd(await app.agentPort.begin(ticket))).toBe(false);
    expect(await holds()).not.toBe("0");

    await age(ticket.id, 40);
    expect(await app.staleRunSweep.run()).toBe(0); // not stale yet
    expect(await statusOf(ticket.id)).toMatchObject({ status: "running" });

    const socket = await connect(app, owner);
    await age(ticket.id, 42);
    expect(await app.staleRunSweep.run()).toBe(1);
    expect(await statusOf(ticket.id)).toMatchObject({ status: "failed", error: "provider_unavailable", hold: "0" });
    expect(await holds()).toBe("0");
    expect(await records(ticket.id)).toEqual([{ outcome: "failed", source: "site", model: "fast", estimated: true, cost: "0", free: "0", balance: "0" }]);
    expect(await latestRun(app, owner, conv)).toEqual({ id: ticket.id, status: "failed", error: "provider_unavailable", retryable: true });
    // Its owner is told (unlike at start-up, sockets are open now).
    expect(await socket.next((e) => e.type === "run" && e.run.id === ticket.id && e.run.status === "failed")).toMatchObject({ conversationId: conv });
    expect(gateway.calls).toHaveLength(0);
    // Sweeping again finds nothing; a retry then works.
    expect(await app.staleRunSweep.run()).toBe(0);
    gateway.reply("重新回答。");
    expect((await api(app, owner, "POST", `/api/conversations/${conv}/runs/retry`)).status).toBe(201);
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect((await fromAgent(app, owner, conv, agent.id)).map((m) => m.text)).toEqual(["重新回答。"]);
  });

  it("a stale run its Agent's pause interrupted ends cancelled, and one whose reply had been posted ends done with its follow-up queued", async () => {
    const app = await start(scriptedGateway());
    const paused = await owned(app, "sweptpaused");
    await say(app, paused.owner, paused.conv, "你好");
    const interrupted = (await app.agentPort.claimNext())!;
    expect(interrupted.agentId).toBe(paused.agent.id);
    await app.agentPort.begin(interrupted);
    expect((await api(app, paused.owner, "POST", `/api/agents/${paused.agent.id}/pause`)).status).toBe(200);
    await age(interrupted.id, 42);
    expect(await app.staleRunSweep.run()).toBe(1);
    expect(await statusOf(interrupted.id)).toMatchObject({ status: "cancelled", error: "agent_paused", hold: "0" });

    const posted = await owned(app, "sweptdone");
    await say(app, posted.owner, posted.conv, "第一句");
    const done = (await app.agentPort.claimNext())!;
    await app.agentPort.begin(done);
    await say(app, posted.owner, posted.conv, "第二句"); // noted on the running reply
    expect(await app.agentPort.post(done, { text: "回第一句。", reasoning: "", stopped: false, truncated: false })).toBe("posted");
    await age(done.id, 42);
    expect(await app.staleRunSweep.run()).toBe(1);
    expect(await statusOf(done.id)).toMatchObject({ status: "done", hold: "0" });
    expect(await latestRun(app, posted.owner, posted.conv)).toMatchObject({ status: "queued" });
  });

  it("never touches a run this process's worker is working on, however old it looks", async () => {
    const gateway = scriptedGateway();
    const app = await start(gateway);
    const { owner, agent, conv } = await owned(app, "busyworker");
    const hold = gateway.hang();
    await say(app, owner, conv, "慢慢说");
    const running = app.agentWorker.runOnce();
    await hold.reached;
    const run = await latestRun(app, owner, conv);
    await age(run.id, 60);
    expect(app.agentWorker.isWorking(run.id)).toBe(true);
    expect(await app.staleRunSweep.run()).toBe(0);
    expect(await statusOf(run.id)).toMatchObject({ status: "running", source: "site" });
    hold.release("说完了。");
    await running;
    expect(await statusOf(run.id)).toMatchObject({ status: "done", hold: "0" });
    expect(await records(run.id)).toHaveLength(1);
    expect((await fromAgent(app, owner, conv, agent.id)).map((m) => m.text)).toEqual(["说完了。"]);
  });

  it("releases a stale persona draft, but never one a request of this process is still making", async () => {
    const gateway = scriptedGateway();
    const app = await start(gateway);
    const owner = await signUp(app, "staledraft");
    const left = await runningRun(db, owner.id);
    await age(left, 42);

    const hold = gateway.hang();
    const answer = api(app, owner, "POST", "/api/agents/draft-persona", { name: "小橘", model: FAST });
    await hold.reached;
    const live = (await db.query<{ id: string }>("select id from agent_runs where owner_id = $1 and id <> $2", [owner.id, left])).rows[0]!.id;
    await age(live, 42);

    expect(await app.staleRunSweep.run()).toBe(1);
    expect(await statusOf(left)).toMatchObject({ status: "failed", error: "provider_unavailable", hold: "0" });
    expect(await records(left)).toEqual([{ outcome: "failed", source: null, model: null, estimated: true, cost: "0", free: "0", balance: "0" }]);
    expect(await statusOf(live)).toMatchObject({ status: "running", source: "site" });

    hold.release("你是一个温和的读书伙伴。");
    expect(await answer).toEqual({ status: 200, json: { persona: "你是一个温和的读书伙伴。" } });
    expect(await statusOf(live)).toMatchObject({ status: "done", hold: "0" });
  });

  it("runs on its own: a minute after start, then every minute (shortened here)", async () => {
    const owner = await signUp(base, "timed");
    const left = await runningRun(db, owner.id);
    await age(left, 42);
    const app = await buildApp({ config: base.deps.config, db, models: scriptedGateway() }, { agentWorker: false, answerFloor: NO_ANSWER_FLOOR, staleRunSweep: { initialDelayMs: 20, intervalMs: 50 } });
    open.push(app);
    await app.ready();
    // Start-up recovery takes it first; a second one, left later, is the timer's.
    expect(await statusOf(left)).toMatchObject({ status: "failed" });
    const later = await runningRun(db, owner.id);
    await age(later, 42);
    await vi.waitFor(async () => expect(await statusOf(later)).toMatchObject({ status: "failed", error: "provider_unavailable", hold: "0" }), { timeout: 3000 });
  });
});

describe("the service stopping while a reply reads its attachments", () => {
  it("abandons the read at once, admits nothing and ends the run itself, as the next start would have", async () => {
    let reached!: () => void;
    const reading = new Promise<void>((resolve) => (reached = resolve));
    // A store whose reads never come (the service closes before they would).
    const hanging: BlobStore = {
      ...store.blobs,
      get: () => {
        reached();
        return new Promise(() => {});
      },
    };
    const before = scriptedGateway();
    const old = await start(before, hanging);
    const { owner, agent, conv } = await owned(old, "reader");
    const upload = await old.inject({
      method: "POST",
      url: `/api/conversations/${conv}/attachments`,
      headers: { cookie: owner.cookie, "content-type": MULTIPART },
      payload: multipart([{ name: "file", filename: "notes.txt", type: "text/plain", data: "一些笔记" }]),
    });
    expect(upload.statusCode).toBe(201);
    expect((await api(old, owner, "POST", `/api/conversations/${conv}/messages`, { attachmentId: upload.json().id, clientTxn: "rs-file" })).status).toBe(201);
    const running = old.agentWorker.runOnce();
    await reading;
    const run = await latestRun(old, owner, conv);

    const t0 = performance.now();
    await stop(old);
    await running;
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(before.calls).toHaveLength(0);
    expect(await statusOf(run.id)).toEqual({ status: "failed", error: "provider_unavailable", source: null, hold: "0" });
    expect(await records(run.id)).toEqual([{ outcome: "failed", source: null, model: null, estimated: true, cost: "0", free: "0", balance: "0" }]);
    expect(await recoverRuns(db, base.deps.config, base.log)).toBe(0);
    expect(await db.query("select 1 from messages where sender_id = $1", [agent.id]).then((r) => r.rowCount)).toBe(0);
  });
});
