import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { api, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useProbeBlobs } from "./helpers/blobs.ts";
import { NO_ANSWER_FLOOR, useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { MULTIPART, multipart } from "./helpers/multipart.ts";
import { closeAllSockets, connect, type Push } from "./helpers/ws.ts";

/**
 * A model upstream that misbehaves, and attachments that cannot be read (spec 7 item 19, README "Agents and runs"):
 * whatever happens the service stays up, the run ends in a definite state, the owner sees why on the run, nothing is
 * left held, and the call has exactly one usage record. The tests about time run on `timed`, the same service with
 * replies — and the reading of their attachments — bounded at one second (`AGENT_RUN_TIMEOUT_MS`); every other test runs
 * on `app`, with the default bound, so no slow moment of the machine can end its reply early.
 */

const gateway = scriptedGateway();
const store = useProbeBlobs("af-faults-");
const lines: string[] = [];
const logStream = { write: (line: string) => void lines.push(line) };
const { app, db } = useApp({ env: SITE_ENV, models: gateway, blobs: store.blobs, agentWorker: false, logStream });

/** `app` with replies bounded at one second (`AGENT_RUN_TIMEOUT_MS`), on the same database, gateway and store. */
let timed: FastifyInstance;
beforeAll(async () => {
  timed = await buildApp(
    { config: { ...app.deps.config, agentRunTimeoutMs: 1000 }, db, models: gateway, blobs: store.blobs },
    { agentWorker: false, answerFloor: NO_ANSWER_FLOOR, logStream, staleRunSweep: false },
  );
  await timed.ready();
});
afterAll(async () => {
  await timed.close();
});

let first = 0;
beforeEach(() => {
  first = gateway.calls.length;
  lines.length = 0;
});
afterEach(async () => {
  await closeAllSockets();
  expect(gateway.pending()).toBe(0);
});

const FAST = { source: "site", id: "fast" } as const;
const PERSONA = "简短地回答。";

async function owned(name: string, on: FastifyInstance = app) {
  const owner = await signUp(on, name);
  const agent = await mustCreateAgent(on, owner, { model: FAST, persona: PERSONA });
  return { owner, agent, conv: agent.conversationId as string };
}

let txn = 0;
const say = async (owner: Actor, conv: string, text: string, on: FastifyInstance = app) => {
  const res = await api(on, owner, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `f${++txn}` });
  expect(res.status).toBe(201);
};
async function sendFile(owner: Actor, conv: string, filename: string, data: string, on: FastifyInstance = app): Promise<string> {
  const res = await on.inject({
    method: "POST",
    url: `/api/conversations/${conv}/attachments`,
    headers: { cookie: owner.cookie, "content-type": MULTIPART },
    payload: multipart([{ name: "file", filename, type: "text/plain", data }]),
  });
  expect(res.statusCode).toBe(201);
  const id = res.json().id as string;
  expect((await api(on, owner, "POST", `/api/conversations/${conv}/messages`, { attachmentId: id, clientTxn: `f${++txn}` })).status).toBe(201);
  return id;
}
const blobKeyOf = async (attachmentId: string) =>
  (await db.query<{ blob_key: string }>("select blob_key from attachments where id = $1", [attachmentId])).rows[0]!.blob_key;
const latestRun = async (owner: Actor, conv: string, on: FastifyInstance = app) => (await api(on, owner, "GET", `/api/conversations/${conv}/run`)).json.run;
const fromAgent = async (owner: Actor, conv: string, agentId: string, on: FastifyInstance = app): Promise<any[]> =>
  (await api(on, owner, "GET", `/api/conversations/${conv}/messages`)).json.messages.filter((m: any) => m.senderId === agentId);
const callsHere = () => gateway.calls.slice(first);
const isRun = (conv: string, status: string) => (e: Push) => e.type === "run" && e.conversationId === conv && e.run.status === status;
const textsOf = (call: { messages: Array<{ parts: Array<{ type: string; text?: string }> }> }) =>
  call.messages.flatMap((m) => m.parts.flatMap((p) => (p.type === "text" ? [p.text!] : [])));
const logged = (msg: RegExp) => lines.map((l) => JSON.parse(l) as { msg: string; attachmentId?: string }).filter((l) => msg.test(l.msg));

/**
 * The invariants of every fault: the service answers, the run is `expected` (as `GET …/run` shows it), nothing is held,
 * and the run has exactly one usage record, with that outcome; returns the record.
 */
async function settled(owner: Actor, conv: string, expected: Record<string, unknown>, on: FastifyInstance = app) {
  expect((await api(on, owner, "GET", "/api/health")).status).toBe(200);
  const run = await latestRun(owner, conv, on);
  expect(run).toEqual({ id: run.id, ...expected });
  const held = await db.query<{ h: string }>("select coalesce(sum(hold_micro), 0)::text as h from agent_runs");
  expect(held.rows[0]!.h).toBe("0");
  const records = await db.query(
    "select outcome, estimated, input_tokens::int as input, output_tokens::int as output, cost_micro::text as cost from usage_records where run_id = $1",
    [run.id],
  );
  expect(records.rows).toHaveLength(1);
  expect(records.rows[0].outcome).toBe(expected.status);
  return records.rows[0] as { outcome: string; estimated: boolean; input: number; output: number; cost: string };
}

describe("a model upstream that misbehaves", () => {
  it("a slow stream still going when the time is up: what it said is posted marked truncated; the run is done", async () => {
    const { owner, agent, conv } = await owned("slow", timed);
    gateway.reply("慢慢地说。".repeat(40), { delayMsPerChunk: 100 });
    await say(owner, conv, "说吧", timed);
    const t0 = performance.now();
    expect(await timed.agentWorker.runOnce()).toBe(true);
    expect(performance.now() - t0).toBeLessThan(3000);
    const [reply] = await fromAgent(owner, conv, agent.id, timed);
    expect(reply.truncated).toBe(true);
    expect(reply.text.length).toBeGreaterThan(0);
    expect("慢慢地说。".repeat(40).startsWith(reply.text)).toBe(true);
    const record = await settled(owner, conv, { status: "done", retryable: false }, timed);
    expect(record).toMatchObject({ estimated: true, output: Array.from(reply.text).length });
  });

  it("a stream that says nothing before the time is up: no message, failed took_too_long (the provider was reached), retryable; costs nothing", async () => {
    const { owner, agent, conv } = await owned("silent", timed);
    const hold = gateway.hang();
    await say(owner, conv, "在吗", timed);
    expect(await timed.agentWorker.runOnce()).toBe(true);
    expect((await hold.reached).signal.aborted).toBe(true);
    expect(await fromAgent(owner, conv, agent.id, timed)).toEqual([]);
    expect(await settled(owner, conv, { status: "failed", error: "took_too_long", retryable: true }, timed)).toMatchObject({ cost: "0" });
  });

  it("a stream the upstream cuts off midway: what it said is discarded, nothing posted, failed; no usage reported: it costs nothing", async () => {
    for (const [name, cutOff] of [
      ["cut_error", () => gateway.fail("provider_unavailable", { afterText: "说到一半就断了，" })],
      ["cut_quiet", () => gateway.cut("说到一半就断了，")],
    ] as const) {
      const { owner, agent, conv } = await owned(name);
      const s = await connect(app, owner);
      cutOff();
      await say(owner, conv, "讲个故事");
      expect(await app.agentWorker.runOnce()).toBe(true);
      await s.next(isRun(conv, "failed"));
      // The owner saw it streaming; it is not kept.
      expect(s.events.filter((e) => e.type === "delta").map((e) => e.text).join("")).toBe("说到一半就断了，");
      expect([name, await fromAgent(owner, conv, agent.id)]).toEqual([name, []]);
      const record = await settled(owner, conv, { status: "failed", error: "provider_unavailable", retryable: true });
      expect([name, record]).toMatchObject([name, { estimated: true, output: 0, cost: "0" }]);
    }
  });

  it("an upstream error: failed with its code; a refused key is not retryable", async () => {
    const down = await owned("down");
    gateway.fail("provider_unavailable");
    await say(down.owner, down.conv, "你好");
    await app.agentWorker.runOnce();
    expect(await settled(down.owner, down.conv, { status: "failed", error: "provider_unavailable", retryable: true })).toMatchObject({ cost: "0" });

    const refused = await owned("refused");
    gateway.fail("provider_rejected");
    await say(refused.owner, refused.conv, "你好");
    await app.agentWorker.runOnce();
    expect(await settled(refused.owner, refused.conv, { status: "failed", error: "provider_rejected", retryable: false })).toMatchObject({ cost: "0" });
    expect(await fromAgent(refused.owner, refused.conv, refused.agent.id)).toEqual([]);
  });

  it("an upstream refusal is logged as a metric", async () => {
    // What the upstream answered with ends the run as before; a 429 and a 5xx are also counted in the log (the limits plan),
    // a refused key (401) and a failure that carries no status are not.
    const metrics = () =>
      lines
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter((e) => e.metric === "upstream_refused")
        .map(({ metric, status }) => ({ metric, status }));
    for (const [name, code, status] of [
      ["busy", "provider_unavailable", 429],
      ["broken", "provider_unavailable", 503],
    ] as const) {
      const w = await owned(name);
      gateway.fail(code, { status });
      await say(w.owner, w.conv, "你好");
      await app.agentWorker.runOnce();
      expect([name, await settled(w.owner, w.conv, { status: "failed", error: code, retryable: true })]).toMatchObject([name, { cost: "0" }]);
    }
    expect(metrics()).toEqual([
      { metric: "upstream_refused", status: 429 },
      { metric: "upstream_refused", status: 503 },
    ]);

    lines.length = 0;
    for (const [name, code, status] of [
      ["keyless", "provider_rejected", 401],
      ["nostatus", "provider_unavailable", undefined],
    ] as const) {
      const w = await owned(name);
      gateway.fail(code, status ? { status } : {});
      await say(w.owner, w.conv, "你好");
      await app.agentWorker.runOnce();
      await settled(w.owner, w.conv, { status: "failed", error: code, retryable: code === "provider_unavailable" });
    }
    expect(metrics()).toEqual([]);
  });

  it("an empty answer: failed provider_unavailable, nothing posted, nothing charged", async () => {
    const { owner, agent, conv } = await owned("empty");
    gateway.empty();
    await say(owner, conv, "你好");
    await app.agentWorker.runOnce();
    expect(await fromAgent(owner, conv, agent.id)).toEqual([]);
    expect(await settled(owner, conv, { status: "failed", error: "provider_unavailable", retryable: true })).toMatchObject({ cost: "0" });
  });

  it("a 50 000-character answer: its first 8 000 characters are posted, marked truncated; settled on what was produced", async () => {
    const { owner, agent, conv } = await owned("long");
    gateway.reply("长".repeat(50_000));
    await say(owner, conv, "写长一点");
    await app.agentWorker.runOnce();
    const [reply] = await fromAgent(owner, conv, agent.id);
    expect(reply).toMatchObject({ text: "长".repeat(8000), truncated: true });
    expect(await settled(owner, conv, { status: "done", retryable: false })).toMatchObject({ estimated: true, output: 50_000 });
  });

  it("no usage reported: settled on an estimate and marked so; reported usage is taken as it is", async () => {
    const quiet = await owned("nousage");
    gateway.reply("好的。");
    await say(quiet.owner, quiet.conv, "你好");
    await app.agentWorker.runOnce();
    expect(await settled(quiet.owner, quiet.conv, { status: "done", retryable: false })).toMatchObject({ estimated: true, output: 3 });

    const counted = await owned("usage");
    gateway.reply("好的。", { usage: { inputTokens: 50, outputTokens: 7 } });
    await say(counted.owner, counted.conv, "你好");
    await app.agentWorker.runOnce();
    // 50 × 1 + 7 × 2 micro-points on the free site model.
    expect(await settled(counted.owner, counted.conv, { status: "done", retryable: false })).toEqual({
      outcome: "done",
      estimated: false,
      input: 50,
      output: 7,
      cost: "64",
    });
  });
});

describe("attachments that cannot be read", () => {
  it("one unreadable file is shown by its name and logged once; the reply goes on", async () => {
    const { owner, agent, conv } = await owned("onebad");
    await sendFile(owner, conv, "good.txt", "能读的内容");
    const bad = await sendFile(owner, conv, "bad.txt", "读不到的内容");
    const badKey = await blobKeyOf(bad);
    store.probe.beforeGet = (key) => {
      if (key === badKey) throw Object.assign(new Error("simulated read failure"), { code: "EIO" });
    };
    gateway.reply("看了一个。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(textsOf(callsHere()[0]!)).toEqual(["[文件：good.txt]\n能读的内容", "[文件：bad.txt]"]);
    expect((await fromAgent(owner, conv, agent.id)).map((m) => m.text)).toEqual(["看了一个。"]);
    expect((await latestRun(owner, conv)).status).toBe("done");
    expect(logged(/could not be read/).map((l) => l.attachmentId)).toEqual([bad]);
  });

  it("a store that has served an attachment of this reply is not down: two later failures are each shown by name", async () => {
    const { owner, agent, conv } = await owned("laterbad");
    const bad1 = await sendFile(owner, conv, "bad1.txt", "读不到一");
    const bad2 = await sendFile(owner, conv, "bad2.txt", "读不到二");
    await sendFile(owner, conv, "good.txt", "能读的内容"); // the newest: read first
    const badKeys = new Set([await blobKeyOf(bad1), await blobKeyOf(bad2)]);
    store.probe.beforeGet = (key) => {
      if (badKeys.has(key)) throw Object.assign(new Error("simulated read failure"), { code: "EIO" });
    };
    gateway.reply("看了一个。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(store.probe.gets).toHaveLength(3);
    expect(textsOf(callsHere()[0]!)).toEqual(["[文件：bad1.txt]", "[文件：bad2.txt]", "[文件：good.txt]\n能读的内容"]);
    expect((await fromAgent(owner, conv, agent.id)).map((m) => m.text)).toEqual(["看了一个。"]);
    expect(logged(/could not be read/).map((l) => l.attachmentId)).toEqual([bad2, bad1]);
    expect(await settled(owner, conv, { status: "done", retryable: false })).toMatchObject({ outcome: "done" });
  });

  it("two that cannot be read, and none of the reply's read yet: the store is down, the reply fails busy, retryable, with no model call", async () => {
    const { owner, conv } = await owned("twobad");
    await sendFile(owner, conv, "one.txt", "一");
    await sendFile(owner, conv, "two.txt", "二");
    store.probe.beforeGet = () => {
      throw Object.assign(new Error("simulated outage"), { code: "EIO" });
    };
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(callsHere()).toHaveLength(0);
    expect(store.probe.gets).toHaveLength(2);
    expect(await settled(owner, conv, { status: "failed", error: "busy", retryable: true })).toMatchObject({ cost: "0" });
  });

  it("reading is bounded by the reply's time limit: a store that does not answer fails the reply busy within it", async () => {
    const { owner, conv } = await owned("stuck", timed);
    await sendFile(owner, conv, "stuck.txt", "等不到", timed);
    store.probe.beforeGet = () => new Promise<void>(() => {});
    const t0 = performance.now();
    expect(await timed.agentWorker.runOnce()).toBe(true);
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(callsHere()).toHaveLength(0);
    expect(await settled(owner, conv, { status: "failed", error: "busy", retryable: true }, timed)).toMatchObject({ cost: "0" });
  });

  it("a stop asked for while files are read: no further file is read, no model call; the run is stopped", async () => {
    const { owner, conv } = await owned("stopread");
    await sendFile(owner, conv, "a.txt", "甲");
    await sendFile(owner, conv, "b.txt", "乙");
    let open!: () => void;
    let reached!: () => void;
    const reading = new Promise<void>((resolve) => (reached = resolve));
    const gate = new Promise<void>((resolve) => (open = resolve));
    store.probe.beforeGet = async () => {
      reached();
      await gate;
    };
    const running = app.agentWorker.runOnce();
    await reading;
    const run = await latestRun(owner, conv);
    expect(await api(app, owner, "POST", `/api/conversations/${conv}/runs/${run.id}/stop`)).toEqual({ status: 200, json: { ok: true } });
    open();
    await running;
    expect(store.probe.gets).toHaveLength(1);
    expect(callsHere()).toHaveLength(0);
    expect(await settled(owner, conv, { status: "stopped", retryable: false })).toMatchObject({ cost: "0" });
  });
});
