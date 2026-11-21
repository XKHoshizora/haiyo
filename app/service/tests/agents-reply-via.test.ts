import { afterEach, describe, expect, it } from "vitest";
import { siteDay } from "../src/accounts/store.ts";
import { api, befriend, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { grant } from "./helpers/metering.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { providerBody } from "./helpers/providers.ts";
import { closeAllSockets, connect, type Push, type TestSocket } from "./helpers/ws.ts";

/**
 * Which model and thinking level an Agent's reply used, and what its owner was charged for it (`via`; the product
 * owner's decision of 2026-11-18): carried by each of the Agent's replies — in its own conversation and in a group —
 * for the Agent's owner only, decided per reader where `reasoning` and persona proposals are (messages/read.ts
 * `toWireForReaders`), from the run that posted the reply. Everyone else gets the message without the key.
 */

/** A site model with distinctive id, label, upstream name and address: only its id and label may reach the owner. */
const SOL = {
  id: "sol_q9x",
  label: "GPT-6 Sol q9x",
  tier: "free",
  protocol: "openai_chat",
  baseUrl: "https://upstream-q9x.example.test/v1",
  apiKeyEnv: "UPSTREAM_TEST_KEY",
  model: "upstream-sol-q9x",
  inputMicroPerToken: 1000,
  outputMicroPerToken: 1000,
  maxOutputTokens: 4096,
  contextTokens: 100000,
  vision: false,
  pdf: false,
  reasoning: ["low", "medium", "high"],
};
const ENV = { ...SITE_ENV, SITE_MODELS: JSON.stringify([...JSON.parse(SITE_ENV.SITE_MODELS), SOL]) };

/** ned's provider: its name, address and model are distinctive too. */
const PROV = { name: "PROVNAME-q9x", baseUrl: "https://prov-q9x.example.com/v1", model: "PROVMODEL-q9x" };
/** What no reader but the Agent's owner may receive, and the owner only within `via` (the label, the id, the model). */
const DISTINCT = [SOL.id, SOL.label, PROV.model];
/** What nobody ever receives in a message, the owner included: the upstream's name and address, the key variable. */
const NEVER = [SOL.model, SOL.baseUrl, "UPSTREAM_TEST_KEY", PROV.baseUrl, PROV.name];

const gateway = scriptedGateway();
const { app, db } = useApp({ env: ENV, models: gateway, agentWorker: false });

afterEach(async () => {
  await closeAllSockets();
  expect(gateway.pending()).toBe(0);
});

let txn = 0;
const say = async (who: Actor, conv: string, text: string): Promise<number> => {
  const sent = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `via${++txn}` });
  if (sent.status !== 201) throw new Error(`say: ${sent.status} ${JSON.stringify(sent.json)}`);
  return sent.json.message.seq as number;
};
async function answer(text: string, options: Parameters<typeof gateway.reply>[1] = {}): Promise<void> {
  gateway.reply(text, options);
  expect(await app.agentWorker.runOnce()).toBe(true);
}
const seqFrom = async (conv: string, sender: string): Promise<number> =>
  Number((await db.query<{ seq: string }>("select seq from messages where conversation_id = $1 and sender_id = $2 and kind = 'text' order by seq desc limit 1", [conv, sender])).rows[0]!.seq);
const runOf = async (conv: string, agentId: string): Promise<string> =>
  (await db.query<{ id: string }>("select id from agent_runs where conversation_id = $1 and agent_id = $2 order by created_at desc limit 1", [conv, agentId])).rows[0]!.id;

/** Every key of every object in `value`, at any depth. */
function keysOf(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) keysOf(v, out);
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysOf(v, out);
    }
  return out;
}

const SOL_VIA = { model: { source: "site", id: SOL.id, label: SOL.label }, reasoning: "medium", points: "6.9" };
const PROV_VIA = { model: { source: "provider", model: PROV.model }, reasoning: "high", points: "0" };

/**
 * mia's group with owen (his Agent `sol_bot`, on the site model SOL at medium) and ned (his Agent `prov_bot`, on his own
 * provider's model at high). Each Agent answered mia once; owen's reply cost 6.9 points (6 000 + 900 tokens at 1 000
 * micro-points), ned's nothing. sam is mia's friend and in no conversation with them. Everyone had a socket open from
 * the start; `last` is mia's message after both replies, which every socket has received.
 */
async function viaWorld() {
  const [mia, owen, ned, sam] = [await signUp(app, "mia"), await signUp(app, "owen"), await signUp(app, "ned"), await signUp(app, "sam")];
  const g = await group(app, mia, "周末读书会", [owen, ned]);
  await befriend(app, mia, sam);
  const sol = await mustCreateAgent(app, owen, { handle: "sol_bot", name: "小索", model: { source: "site", id: SOL.id }, reasoning: "medium", persona: "你是小索。" });
  const provider = (await api(app, ned, "POST", "/api/providers", providerBody({ name: PROV.name, baseUrl: PROV.baseUrl, models: [{ name: PROV.model, reasoning: true }] }))).json.id as string;
  const prov = await mustCreateAgent(app, ned, {
    handle: "prov_bot",
    name: "阿普",
    model: { source: "provider", providerId: provider, model: PROV.model },
    reasoning: "high",
    persona: "你是阿普。",
  });
  for (const [owner, agent] of [
    [owen, sol],
    [ned, prov],
  ] as const) {
    const added = await api(app, owner, "POST", `/api/conversations/${g}/members`, { principalId: agent.id });
    expect(added.status).toBe(201);
  }
  const sockets = new Map<Actor, TestSocket>();
  for (const who of [owen, ned, mia, sam]) sockets.set(who, await connect(app, who));
  await say(mia, g, "@sol_bot SOLASK-q9x 周六几点？");
  await answer("SOLREPLY-q9x 周六十点。", { reasoning: "想想", usage: { inputTokens: 6000, outputTokens: 900 } });
  await say(mia, g, "@prov_bot PROVASK-q9x 周日呢？");
  await answer("PROVREPLY-q9x 周日也是十点。", { usage: { inputTokens: 5000, outputTokens: 5000 } });
  const [mine, theirs] = [await seqFrom(g, sol.id), await seqFrom(g, prov.id)];
  const last = await say(mia, g, "好的，谢谢");
  for (const who of [owen, ned, mia]) await sockets.get(who)!.waitFor((e) => e.type === "message" && e.message.conversationId === g && e.message.seq === last);
  return { mia, owen, ned, sam, g, sol, prov, provider, sockets, mine, theirs, last };
}
type ViaWorld = Awaited<ReturnType<typeof viaWorld>>;

/** What `who` must be shown of the two replies: `via` of their own Agent's, "absent" for any other. */
const expectedFor = (w: ViaWorld, who: Actor) => [
  [w.mine, who === w.owen ? SOL_VIA : "absent"],
  [w.theirs, who === w.ned ? PROV_VIA : "absent"],
];
/** Of `messages`, the two replies in seq order, each with its `via` or "absent" (never null or empty). */
function viasIn(w: ViaWorld, messages: any[]) {
  return messages
    .filter((m) => m.conversationId === w.g && (m.seq === w.mine || m.seq === w.theirs))
    .sort((a, b) => a.seq - b.seq)
    .map((m) => [m.seq, "via" in m ? m.via : "absent"]);
}
/** `body` carries no `via` key at any depth, and nothing distinctive of a model nobody may see in it. */
function clean(body: unknown, distinct: readonly string[] = DISTINCT) {
  const text = JSON.stringify(body);
  return { via: keysOf(body).has("via"), leaked: [...distinct, ...NEVER].filter((s) => text.includes(s)) };
}

describe("which model and thinking level a reply used: its Agent's owner's only", () => {
  it("history, a single message, sync, catch-up and both searches: each owner reads their own Agent's via and not the other's; a fellow member neither", async () => {
    const w = await viaWorld();
    for (const who of [w.owen, w.ned, w.mia]) {
      const want = expectedFor(w, who);
      const reads: Array<[string, any[]]> = [];
      reads.push(["history", (await api(app, who, "GET", `/api/conversations/${w.g}/messages`)).json.messages]);
      const singles = [];
      for (const seq of [w.mine, w.theirs]) singles.push((await api(app, who, "GET", `/api/conversations/${w.g}/messages/${seq}`)).json.message);
      reads.push(["single", singles]);
      reads.push(["sync", (await api(app, who, "GET", "/api/sync")).json.messages]);
      reads.push(["catch-up", (await api(app, who, "POST", "/api/sync/catchup", { positions: { [w.g]: 0 } })).json.messages]);
      reads.push(["search", (await api(app, who, "GET", `/api/conversations/${w.g}/search?q=REPLY-q9x`)).json.messages]);
      reads.push(["global search", (await api(app, who, "GET", "/api/search?q=REPLY-q9x")).json.messages]);
      for (const [path, messages] of reads) expect([who.handle, path, viasIn(w, messages)]).toEqual([who.handle, path, want]);
    }
  });

  it("nothing a fellow member or a stranger receives carries a via key or the model's id, label or name; the owner's carries no upstream name, address or price", async () => {
    const w = await viaWorld();
    const readsOf = async (who: Actor) => {
      const out: Array<[string, unknown]> = [];
      for (const [method, path, body] of [
        ["GET", "/api/sync", undefined],
        ["GET", `/api/conversations/${w.g}`, undefined],
        ["GET", `/api/conversations/${w.g}/members`, undefined],
        ["GET", `/api/conversations/${w.g}/messages`, undefined],
        ["GET", `/api/conversations/${w.g}/messages/${w.mine}`, undefined],
        ["GET", `/api/conversations/${w.g}/messages/${w.theirs}`, undefined],
        ["GET", `/api/conversations/${w.g}/runs`, undefined],
        ["GET", `/api/conversations/${w.g}/search?q=REPLY-q9x`, undefined],
        ["GET", "/api/search?q=REPLY-q9x", undefined],
        ["GET", "/api/search?q=q9x", undefined],
        ["POST", "/api/sync/catchup", { positions: { [w.g]: 0 } }],
      ] as const) {
        out.push([path, (await api(app, who, method, path, body)).json]);
      }
      return out;
    };
    // mia (a fellow member) and sam (a stranger): no via anywhere, nothing of either model.
    for (const who of [w.mia, w.sam]) {
      for (const [path, body] of await readsOf(who)) expect([who.handle, path, clean(body)]).toEqual([who.handle, path, { via: false, leaked: [] }]);
    }
    // Each owner: their own Agent's via, and nothing of the other's model; never an upstream name, address or key.
    for (const [who, own] of [
      [w.owen, SOL_VIA],
      [w.ned, PROV_VIA],
    ] as const) {
      const others = who === w.owen ? [PROV.model] : [SOL.id, SOL.label];
      for (const [path, body] of await readsOf(who)) {
        const text = JSON.stringify(body);
        expect([who.handle, path, [...others, ...NEVER].filter((s) => text.includes(s))]).toEqual([who.handle, path, []]);
      }
      const history = (await api(app, who, "GET", `/api/conversations/${w.g}/messages`)).json.messages;
      expect(history.filter((m: any) => "via" in m).map((m: any) => m.via)).toEqual([own]);
    }
  });

  it("the pushes: once its run is charged, the owner's socket gets the reply again with its via; nobody else's ever gets a via, or the reply twice", async () => {
    const w = await viaWorld();
    for (const who of [w.owen, w.ned, w.mia]) {
      const events = w.sockets.get(who)!.events;
      for (const [seq, want] of expectedFor(w, who) as Array<[number, unknown]>) {
        const frames = events.filter((e) => e.type === "message" && e.message.conversationId === w.g && e.message.seq === seq).map((e) => e.message);
        if (want === "absent") {
          // Exactly as before this change: one frame, without the key.
          expect([who.handle, seq, frames.length, frames.map((m) => "via" in m)]).toEqual([who.handle, seq, 1, [false]]);
        } else {
          // Its last frame is the charged one; no frame carries a via other than its own.
          expect([who.handle, seq, frames.at(-1)!.via]).toEqual([who.handle, seq, want]);
          expect([who.handle, seq, frames.filter((m) => "via" in m).every((m) => JSON.stringify(m.via) === JSON.stringify(want))]).toEqual([who.handle, seq, true]);
        }
      }
      const others = who === w.owen ? [PROV.model] : who === w.ned ? [SOL.id, SOL.label] : DISTINCT;
      const text = JSON.stringify(events);
      expect([who.handle, [...others, ...NEVER].filter((s) => text.includes(s))]).toEqual([who.handle, []]);
      // No other frame (runs, the other reply, mia's messages) carries a via.
      const elsewhere: Push[] = events.filter((e) => !(e.type === "message" && e.message.seq === (who === w.owen ? w.mine : w.theirs)));
      expect([who.handle, keysOf(elsewhere).has("via")]).toEqual([who.handle, false]);
    }
    // The stranger was pushed nothing of the group at all.
    expect(clean(w.sockets.get(w.sam)!.events)).toEqual({ via: false, leaked: [] });
  });

  it("points is what its owner was charged for that run (as GET /api/usage reports it): 6.9 for the site reply, 0 on the owner's provider", async () => {
    const w = await viaWorld();
    const charged = async (runId: string) =>
      (await db.query<{ p: string }>("select (free_micro + balance_micro)::text as p from usage_records where run_id = $1", [runId])).rows[0]!.p;
    expect(await charged(await runOf(w.g, w.sol.id))).toBe("6900000");
    expect(await charged(await runOf(w.g, w.prov.id))).toBe("0");
    expect((await api(app, w.owen, "GET", "/api/usage")).json.recent).toEqual([{ agentId: w.sol.id, purpose: "reply", model: SOL.id, source: "site", points: "6.9", replies: 1 }]);
    expect((await api(app, w.ned, "GET", "/api/usage")).json.recent).toEqual([{ agentId: w.prov.id, purpose: "reply", model: PROV.model, source: "provider", points: "0", replies: 1 }]);
  });

  it("the model and level are the run's, as it was called: the Agent's later change does not touch them, and the call was sent that level", async () => {
    const w = await viaWorld();
    const calls = gateway.calls.slice(-2);
    expect(calls.map((c) => [c.model, c.reasoning])).toEqual([
      [SOL.model, "medium"],
      [PROV.model, "high"],
    ]);
    const patched = await api(app, w.owen, "PATCH", `/api/agents/${w.sol.id}`, { model: { source: "site", id: "fast" }, reasoning: "none" });
    expect(patched.status).toBe(200);
    expect((await api(app, w.owen, "GET", `/api/conversations/${w.g}/messages/${w.mine}`)).json.message.via).toEqual(SOL_VIA);
    // Its next reply was called on the new model at the new level, and says so (100 + 50 tokens at 1 and 2 micro-points).
    await say(w.mia, w.g, "@sol_bot 再说一次");
    await answer("SOLREPLY-q9x 好的。", { usage: { inputTokens: 100, outputTokens: 50 } });
    expect(gateway.calls.at(-1)!.reasoning).toBe("none");
    const next = await seqFrom(w.g, w.sol.id);
    expect((await api(app, w.owen, "GET", `/api/conversations/${w.g}/messages/${next}`)).json.message.via).toEqual({
      model: { source: "site", id: "fast", label: "Fast" },
      reasoning: "none",
      points: "0.0002",
    });
  });

  it("a level its model no longer takes is sent as none, and via says none, whatever the Agent's own setting", async () => {
    const owner = await signUp(app, "olga");
    const agent = await mustCreateAgent(app, owner, { handle: "high_bot", name: "高高", model: { source: "site", id: SOL.id }, reasoning: "high", persona: "你好。" });
    const config = app.deps.config as { siteModels: typeof app.deps.config.siteModels };
    const kept = config.siteModels;
    config.siteModels = kept.map((m) => (m.id === SOL.id ? { ...m, reasoning: ["low"] } : m));
    try {
      await say(owner, agent.conversationId, "你好");
      await answer("HIGH-q9x 你好。", { usage: { inputTokens: 10, outputTokens: 10 } });
    } finally {
      config.siteModels = kept;
    }
    expect(gateway.calls.at(-1)!.reasoning).toBe("none");
    expect((await api(app, owner, "GET", `/api/agents/${agent.id}`)).json.reasoning).toBe("high");
    const reply = (await api(app, owner, "GET", `/api/conversations/${agent.conversationId}/messages`)).json.messages.at(-1);
    expect([reply.text, reply.via]).toEqual(["HIGH-q9x 你好。", { model: { source: "site", id: SOL.id, label: SOL.label }, reasoning: "none", points: "0.02" }]);
  });

  it("a site model taken out of the configuration since is named by its id; a run without its level recorded, or without its usage record, gives no via", async () => {
    const w = await viaWorld();
    const config = app.deps.config as { siteModels: typeof app.deps.config.siteModels };
    const kept = config.siteModels;
    config.siteModels = kept.filter((m) => m.id !== SOL.id);
    try {
      expect((await api(app, w.owen, "GET", `/api/conversations/${w.g}/messages/${w.mine}`)).json.message.via).toEqual({
        ...SOL_VIA,
        model: { source: "site", id: SOL.id, label: SOL.id },
      });
    } finally {
      config.siteModels = kept;
    }
    const keys = async (seq: number) => Object.keys((await api(app, w.owen, "GET", `/api/conversations/${w.g}/messages/${seq}`)).json.message).sort();
    expect(await keys(w.mine)).toContain("via");
    // A run admitted before its level was recorded (a reply stored before this change).
    await db.query("update agent_runs set reasoning = null where id = $1", [await runOf(w.g, w.sol.id)]);
    expect(await keys(w.mine)).not.toContain("via");
    // A usage record that is gone (ned's provider reply: no ledger entry refers to it).
    await db.query("delete from usage_records where run_id = $1", [await runOf(w.g, w.prov.id)]);
    const theirs = (await api(app, w.ned, "GET", `/api/conversations/${w.g}/messages/${w.theirs}`)).json.message;
    expect(Object.keys(theirs).sort()).toEqual(["conversationId", "createdAt", "kind", "senderId", "seq", "text"]);
  });
});

describe("in the Agent's own conversation", () => {
  it("its replies carry via for its owner; its owner's own message does not (and nothing is posted as the Agent at creation: no fixed greeting)", async () => {
    const owner = await signUp(app, "olga");
    const agent = await mustCreateAgent(app, owner, { handle: "solo_bot", name: "独奏", model: { source: "site", id: SOL.id }, reasoning: "low" });
    const conv = agent.conversationId as string;
    const socket = await connect(app, owner);
    await say(owner, conv, "你好");
    await answer("SOLO-q9x 你好。", { usage: { inputTokens: 1000, outputTokens: 234 } });
    const want = { model: { source: "site", id: SOL.id, label: SOL.label }, reasoning: "low", points: "1.234" };
    const history = (await api(app, owner, "GET", `/api/conversations/${conv}/messages`)).json.messages;
    expect(history.map((m: any) => [m.seq, m.senderId === agent.id, "via" in m ? m.via : "absent"])).toEqual([
      [1, false, "absent"], // the owner's own message
      [2, true, want],
    ]);
    expect((await api(app, owner, "GET", `/api/conversations/${conv}/messages/2`)).json.message.via).toEqual(want);
    expect((await api(app, owner, "GET", "/api/sync")).json.messages.find((m: any) => m.conversationId === conv && m.seq === 2).via).toEqual(want);
    expect((await api(app, owner, "GET", "/api/search?q=SOLO-q9x")).json.messages.map((m: any) => m.via)).toEqual([want]);
    await socket.waitFor((e) => e.type === "message" && e.message.conversationId === conv && e.message.seq === 2 && "via" in e.message);
    const frames = socket.events.filter((e) => e.type === "message" && e.message.seq === 2);
    expect(frames.at(-1)!.message.via).toEqual(want);
  });
});

/** Frames of `seq` of `g` on `socket`, in arrival order, with where each stands among all the socket's events. */
const framesOf = (socket: TestSocket, g: string, seq: number) =>
  socket.events.map((e, at) => ({ e, at })).filter(({ e }) => e.type === "message" && e.message.conversationId === g && e.message.seq === seq);

describe("the second push, on the paths a normal reply does not take", () => {
  /** A new mention of sol_bot, claimed and posted by hand, not yet ended. */
  async function postedByHand(w: ViaWorld, text: string) {
    await say(w.mia, w.g, `@sol_bot ${text}`);
    const ticket = (await app.agentPort.claimNext())!;
    const prepared = await app.agentPort.begin(ticket);
    if ("status" in prepared) throw new Error(`begin ended the run: ${JSON.stringify(prepared)}`);
    expect(await app.agentPort.post(ticket, { text: `HAND-q9x ${text}`, reasoning: "", stopped: false, truncated: false })).toBe("posted");
    return { ticket, prepared, seq: await seqFrom(w.g, w.sol.id) };
  }

  it("in a group, the owner's charged copy arrives before the run's end push", async () => {
    const w = await viaWorld();
    const runId = await runOf(w.g, w.sol.id);
    const owen = w.sockets.get(w.owen)!;
    const charged = framesOf(owen, w.g, w.mine).filter(({ e }) => "via" in e.message);
    expect(charged).toHaveLength(1);
    const ended = owen.events.findIndex((e) => e.type === "run" && e.run.id === runId && e.run.status === "done");
    expect(ended).toBeGreaterThan(-1);
    expect(charged[0]!.at).toBeLessThan(ended);
  });

  it("an owner who left the group with the run in flight gets no second push", async () => {
    const w = await viaWorld();
    const { ticket, prepared, seq } = await postedByHand(w, "再来一个");
    const owen = w.sockets.get(w.owen)!;
    await owen.waitFor((e) => e.type === "message" && e.message.conversationId === w.g && e.message.seq === seq);
    expect((await api(app, w.owen, "DELETE", `/api/conversations/${w.g}/members/${w.owen.id}`)).status).toBe(200);
    const before = owen.events.length;
    await app.agentPort.finish(ticket, { status: "done" }, { inputTokens: 100, outputTokens: 50 }, { inputChars: prepared.inputChars, outputChars: 5 });
    // Whatever the hub did for the charge is queued before mia's next message, which every member still in it receives.
    const marker = await say(w.mia, w.g, "收到");
    await w.sockets.get(w.mia)!.waitFor((e) => e.type === "message" && e.message.conversationId === w.g && e.message.seq === marker);
    expect(owen.events.slice(before).filter((e) => e.type === "message" && e.message.seq === seq)).toEqual([]);
    expect(framesOf(owen, w.g, seq).map(({ e }) => "via" in e.message)).toEqual([false]);
    expect(keysOf(owen.events.slice(before)).has("via")).toBe(false);
  });

  it("a run released with its reply posted (ended by the owner's stop, as recovery would end it: the posted reply stands) sends the charged copy to its owner only, before the run's end", async () => {
    const w = await viaWorld();
    const { ticket, seq } = await postedByHand(w, "讲一半");
    for (const who of [w.owen, w.ned, w.mia]) await w.sockets.get(who)!.waitFor((e) => e.type === "message" && e.message.conversationId === w.g && e.message.seq === seq);
    expect((await api(app, w.owen, "POST", `/api/conversations/${w.g}/runs/${ticket.id}/stop`)).status).toBe(200);
    const owen = w.sockets.get(w.owen)!;
    const ended = (e: Push) => e.type === "run" && e.run?.id === ticket.id && e.run?.status === "done";
    await owen.waitFor(ended);
    const frames = framesOf(owen, w.g, seq);
    // The released run was charged nothing: its copy says so.
    expect(frames.map(({ e }) => ("via" in e.message ? e.message.via : "absent"))).toEqual(["absent", { model: { source: "site", id: SOL.id, label: SOL.label }, reasoning: "medium", points: "0" }]);
    expect(frames[1]!.at).toBeLessThan(owen.events.findIndex(ended));
    // Nobody else gets the reply twice or with a via.
    const marker = await say(w.mia, w.g, "好");
    for (const who of [w.ned, w.mia]) {
      const socket = w.sockets.get(who)!;
      await socket.waitFor((e) => e.type === "message" && e.message.seq === marker);
      expect([who.handle, framesOf(socket, w.g, seq).map(({ e }) => "via" in e.message)]).toEqual([who.handle, [false]]);
    }
  });
});

describe("points is what was charged, not what the call cost", () => {
  const config = () => app.deps.config as { freeDailyMicro: bigint };
  /** A reply of 1.5 points (1 000 + 500 tokens at 1 000 micro-points) on SOL by an owner whose allowance is `allowance` with `used` of it spent today. */
  async function reply(handle: string, allowance: bigint, used: bigint, balance: bigint) {
    const kept = config().freeDailyMicro;
    config().freeDailyMicro = allowance;
    try {
      const owner = await signUp(app, handle);
      const agent = await mustCreateAgent(app, owner, { handle: `${handle}_bot`, name: handle, model: { source: "site", id: SOL.id }, persona: "你好。" });
      if (used > 0n) await db.query("insert into free_usage (owner_id, day, used_micro) values ($1, $2::date, $3)", [owner.id, siteDay(new Date(), app.deps.config.siteTimezone), used.toString()]);
      if (balance > 0n) await grant(db, owner.id, balance);
      await say(owner, agent.conversationId, "你好");
      await answer("PTS-q9x 你好。", { usage: { inputTokens: 1000, outputTokens: 500 } });
      const run = await runOf(agent.conversationId, agent.id);
      const record = (await db.query("select cost_micro::text as cost, free_micro::text as free, balance_micro::text as balance, forgiven_micro::text as forgiven from usage_records where run_id = $1", [run])).rows[0];
      const seq = await seqFrom(agent.conversationId, agent.id);
      const via = (await api(app, owner, "GET", `/api/conversations/${agent.conversationId}/messages/${seq}`)).json.message.via;
      return { record, via, owner, run, conv: agent.conversationId as string, seq };
    } finally {
      config().freeDailyMicro = kept;
    }
  }

  it("a charge to the balance (the allowance used up): its amount", async () => {
    const r = await reply("balo", 5_000_000n, 5_000_000n, 10_000_000n);
    expect(r.record).toEqual({ cost: "1500000", free: "0", balance: "1500000", forgiven: "0" });
    expect(r.via.points).toBe("1.5");
  });

  it("an overrun of the allowance is forgiven, not counted: only what the allowance took", async () => {
    const r = await reply("overo", 5_000_000n, 4_500_000n, 0n);
    expect(r.record).toEqual({ cost: "1500000", free: "500000", balance: "0", forgiven: "1000000" });
    expect(r.via.points).toBe("0.5");
    expect((await api(app, r.owner, "GET", "/api/usage")).json.recent).toMatchObject([{ points: "0.5" }]);
  });

  it("a record holding both parts (allowance and balance) is their sum, and never the forgiven rest", async () => {
    // Settlement charges one source per run, so a split is set by hand: this pins the read, which must be the sum
    // GET /api/usage reports.
    const r = await reply("splito", 5_000_000n, 0n, 0n);
    await db.query("update usage_records set free_micro = 400000, balance_micro = 700000, forgiven_micro = 400000 where run_id = $1", [r.run]);
    const read = (await api(app, r.owner, "GET", `/api/conversations/${r.conv}/messages/${r.seq}`)).json.message.via;
    expect(read.points).toBe("1.1");
  });
});

describe("a reply nobody called for: its owner's via says so, and nobody else's", () => {
  /** `lane` is what the run row holds: a proactive run, or one a member's mention took over while it was queued. */
  async function withLane(w: ViaWorld, agentId: string, lane: string) {
    await db.query("update agent_runs set lane = $2 where id = $1", [await runOf(w.g, agentId), lane]);
  }

  it("a proactive run's reply carries via.proactive: true for its owner on every read; a mentioned run's reply has no such key", async () => {
    const w = await viaWorld();
    await withLane(w, w.sol.id, "proactive");
    const reads = async (who: Actor, seq: number) => {
      const single = (await api(app, who, "GET", `/api/conversations/${w.g}/messages/${seq}`)).json.message;
      const history = (await api(app, who, "GET", `/api/conversations/${w.g}/messages`)).json.messages.find((m: any) => m.seq === seq);
      const sync = (await api(app, who, "GET", "/api/sync")).json.messages.find((m: any) => m.conversationId === w.g && m.seq === seq);
      const search = (await api(app, who, "GET", "/api/search?q=REPLY-q9x")).json.messages.find((m: any) => m.seq === seq);
      return [single, history, sync, search].map((m) => m.via);
    };
    for (const via of await reads(w.owen, w.mine)) expect(via).toEqual({ ...SOL_VIA, proactive: true });
    // ned's reply came from a mentioned run (lane own): the key is absent, not false.
    for (const via of await reads(w.ned, w.theirs)) {
      expect(via).toEqual(PROV_VIA);
      expect("proactive" in via).toBe(false);
    }
  });

  it("a run queued proactive and taken over by a member's mention (lane others) has no key", async () => {
    const w = await viaWorld();
    await withLane(w, w.sol.id, "others");
    const via = (await api(app, w.owen, "GET", `/api/conversations/${w.g}/messages/${w.mine}`)).json.message.via;
    expect(via).toEqual(SOL_VIA);
    expect("proactive" in via).toBe(false);
  });

  it("a fellow member and the other Agent's owner get no via on a proactive reply, and no word of its lane anywhere", async () => {
    const w = await viaWorld();
    await withLane(w, w.sol.id, "proactive");
    for (const who of [w.mia, w.ned]) {
      const read = await api(app, who, "GET", `/api/conversations/${w.g}/messages`);
      const copy = read.json.messages.find((m: any) => m.seq === w.mine);
      expect([who.handle, "via" in copy, JSON.stringify(read.json).includes("proactive")]).toEqual([who.handle, false, false]);
    }
  });
});
