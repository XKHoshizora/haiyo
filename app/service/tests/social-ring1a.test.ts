import { afterEach, describe, expect, it } from "vitest";
import { optionsFor } from "../src/agents/proactive/candidates.ts";
import { NOTHING } from "../src/agents/runtime/port.ts";
import { disableAgent } from "../src/social/reports.ts";
import { createWhisper } from "../src/whispers/store.ts";
import { reach } from "../src/social/reach.ts";
import { api, befriend, group, signUp, type Actor } from "./helpers/actors.ts";
import { markOf, mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { committedMicro, seedRun, setOwnerNumbers } from "./helpers/others.ts";
import { SOCIAL_ON } from "./helpers/social.ts";
import { closeAllSockets, connect, type TestSocket } from "./helpers/ws.ts";

/**
 * Ring 1a across both lanes (plan, Task I1a; the integration lists of `socialb-b3-review`, `socialb-b4-review` and `socialb-b5-review3`):
 * lane A's access (rows, bars, `reach`, the routes) with lane B's runs and money (trigger, `begin`, post, `othersFits`), through the real
 * add, approve, send, claim, begin and post paths and a scripted gateway. What each lane proved against the other's stand-in is proved
 * here against the real thing.
 */
const gateway = scriptedGateway();
const lines: string[] = [];
const { app, db } = useApp({ env: SITE_ENV, models: gateway, agentWorker: false, memory: true, tools: true, config: SOCIAL_ON, logStream: { write: (l) => void lines.push(l) } });
afterEach(async () => {
  await closeAllSockets();
  expect(gateway.pending()).toBe(0);
});

const FAST = { source: "site", id: "fast" } as const;
const REPLY = { reasoning: "", stopped: false, truncated: false } as const;
type Made = { id: string; conversationId: string };
let n = 0;
let txn = 0;
const tag = () => `r${++n}${Math.random().toString(36).slice(2, 6)}`;
const send = (who: Actor, conv: string, text: string) => api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `r1a${++txn}` });
const say = async (who: Actor, conv: string, text: string): Promise<number> => {
  const sent = await send(who, conv, text);
  if (sent.status !== 201) throw new Error(`say: ${sent.status} ${JSON.stringify(sent.json)}`);
  return sent.json.message.seq as number;
};
/** An Agent's full handle: its owner's, a dot, its name part. */
const fullHandle = async (agentId: string) =>
  (await db.query<{ h: string }>("select o.handle::text || '.' || p.handle::text as h from principals p join principals o on o.id = p.owner_id where p.id = $1", [agentId])).rows[0]!.h;
const stop = (by: Actor, whom: Actor) => api(app, by, "PUT", `/api/bars/${whom.id}`);
const resume = (by: Actor, whom: Actor) => api(app, by, "DELETE", `/api/bars/${whom.id}`);
const add = (who: Actor, agentId: string) => api(app, who, "POST", "/api/agent-contacts", { agentId });
/** The switch as the running app reads it, turned off for `work` and put back. */
async function switchedOff<T>(work: () => Promise<T>): Promise<T> {
  const config = app.deps.config as { social: { enabled: boolean } };
  const before = config.social;
  config.social = { enabled: false };
  try {
    return await work();
  } finally {
    config.social = before;
  }
}

/** An owner with an Agent, and a visitor let in through the real routes (a request, the owner's yes): their social conversation. */
async function visited(policy: "ask" | "contacts" = "ask") {
  const t = tag();
  const [owner, v] = [await signUp(app, `${t}o`), await signUp(app, `${t}v`)];
  const agent = (await mustCreateAgent(app, owner, { handle: `${t}y`, name: `${t}y`, model: FAST, persona: "简短地回答。" })) as Made;
  let conv: string;
  if (policy === "contacts") {
    await befriend(app, owner, v);
    expect((await api(app, owner, "PUT", `/api/agents/${agent.id}/contact-policy`, { policy: "contacts", picked: false, picks: [] })).status).toBe(200);
    const live = await add(v, agent.id);
    expect(live.status).toBe(201);
    conv = live.json.conversationId as string;
  } else {
    expect((await add(v, agent.id)).status).toBe(202);
    const yes = await api(app, owner, "POST", `/api/agent-contacts/${agent.id}/${v.id}/approve`);
    expect(yes.status).toBe(200);
    conv = yes.json.conversationId as string;
  }
  return { t, owner, v, agent, conv };
}
type Visited = Awaited<ReturnType<typeof visited>>;

/** A group made by a third person W with O and V in it (O and V are NOT friends: V is a group-only caller of O's Agent Y), and Y added. */
async function grouped() {
  const t = tag();
  const [owner, v, w] = [await signUp(app, `${t}o`), await signUp(app, `${t}v`), await signUp(app, `${t}w`)];
  const g = await group(app, w, "楼里的群", [owner, v]);
  const y = (await mustCreateAgent(app, owner, { handle: `${t}y`, name: `${t}y`, model: FAST, persona: "简短地回答。" })) as Made;
  expect((await api(app, owner, "POST", `/api/conversations/${g}/members`, { principalId: y.id })).status).toBe(201);
  return { t, owner, v, w, g, y, at: `@${t}y` };
}

const runsOf = async (agentId: string, conv: string) =>
  (
    await db.query<{ id: string; status: string; error: string | null; interrupted: string | null; pending: number | null; caller: string | null; calls: number[] | null }>(
      `select id, status, error, interrupted, pending_seq::int as pending, caller_id as caller, call_seqs::int[] as calls
         from agent_runs where agent_id = $1 and conversation_id = $2 and purpose = 'reply' order by created_at, id`,
      [agentId, conv],
    )
  ).rows;
const textsOf = async (conv: string, agentId: string) =>
  (await db.query<{ seq: number; body: { text?: string } }>("select seq::int, body from messages where conversation_id = $1 and sender_id = $2 and kind = 'text' order by seq", [conv, agentId])).rows;
const usageRecords = async (runId: string) => Number((await db.query<{ n: string }>("select count(*) as n from usage_records where run_id = $1", [runId])).rows[0]!.n);
/** Frames of a run's stream (`delta`, `activity`) that `socket` got from index `from` on, for `conv`. */
const streamed = (socket: TestSocket, conv: string, from: number) =>
  socket.events.slice(from).filter((e) => (e.type === "delta" || e.type === "activity") && e.conversationId === conv);

describe("I1a.1: access ends while a visitor's reply is mid-call", () => {
  const endings: Record<string, (w: Visited) => Promise<unknown>> = {
    "停止往来 (a bar)": (w) => stop(w.owner, w.v),
    "a narrowing to nobody": (w) => api(app, w.owner, "PUT", `/api/agents/${w.agent.id}/contact-policy`, { policy: "none", picked: false, picks: [] }),
    "a removal": (w) => api(app, w.owner, "DELETE", `/api/agent-contacts/${w.agent.id}/${w.v.id}`),
    "the owner's block of the visitor": (w) => api(app, w.owner, "PUT", `/api/blocks/${w.v.id}`),
    "the visitor's block of the Agent": (w) => api(app, w.v, "PUT", `/api/blocks/${w.agent.id}`),
    "the operator's disable": async (w) => {
      const done = await disableAgent(db, await fullHandle(w.agent.id));
      // (The command line has no hub: the route's own step, done here, abandons the call.)
      app.agentPort.interruptRuns(done!.ended.running);
      return { status: 200 };
    },
  };
  for (const [name, end] of Object.entries(endings)) {
    it(`${name}: nothing is posted, the run ends cancelled/access_ended, settled once, and no frame of it reaches anyone afterwards`, async () => {
      const w = await visited();
      const [ownerSocket, visitorSocket] = [await connect(app, w.owner), await connect(app, w.v)];
      await say(w.v, w.conv, "你好，在吗");
      const hold = gateway.hangAfter("在的，");
      const working = app.agentWorker.runOnce();
      await hold.reached;
      const [fromOwner, fromVisitor] = [ownerSocket.events.length, visitorSocket.events.length];
      const res = (await end(w)) as { status: number };
      expect(res.status).toBe(200);
      hold.release("我来回答。");
      expect(await working).toBe(true);
      expect(await textsOf(w.conv, w.agent.id)).toEqual([]);
      const [run] = await runsOf(w.agent.id, w.conv);
      expect(run).toMatchObject({ status: "cancelled", error: "access_ended", pending: null });
      expect(await usageRecords(run!.id)).toBe(1);
      expect(streamed(ownerSocket, w.conv, fromOwner)).toEqual([]);
      expect(streamed(visitorSocket, w.conv, fromVisitor)).toEqual([]);
      // The visitor is told the run's state and never why: no frame they got names the reason.
      expect(JSON.stringify(visitorSocket.events.slice(fromVisitor))).not.toContain("access_ended");
      // And the visitor's next message there starts nothing.
      const again = await send(w.v, w.conv, "还在吗");
      expect(again.status).not.toBe(201);
      expect((await runsOf(w.agent.id, w.conv)).length).toBe(1);
    });
  }

  it("access gone at the post with no mark on the run (no ending went through `endGrants`): refused there, counted once as social_post_refused with its reason and no text", async () => {
    const w = await visited();
    await say(w.v, w.conv, "SECRET-QUESTION 你好");
    const ticket = (await app.agentPort.claimNext())!;
    expect("call" in (await app.agentPort.begin(ticket))).toBe(true);
    await db.query("update agent_contacts set state = 'ended', end_reason = 'removed', basis = null where agent_id = $1 and subject_id = $2", [w.agent.id, w.v.id]);
    lines.length = 0;
    expect(await app.agentPort.post(ticket, { text: "SECRET-ANSWER 在的", ...REPLY })).toBe("refused");
    await app.agentPort.finish(ticket, { status: "cancelled" }, null, NOTHING);
    const counted = lines.filter((l) => l.includes("social_post_refused"));
    expect(counted).toHaveLength(1);
    expect(JSON.parse(counted[0]!)).toMatchObject({ metric: "social_post_refused", reason: "access_ended" });
    expect(lines.join(" ")).not.toMatch(/SECRET-(QUESTION|ANSWER)/);
    expect((await runsOf(w.agent.id, w.conv))[0]).toMatchObject({ status: "cancelled", error: "access_ended" });
  });

  it("an ending and the owner's interjection on one running reply: the first mark stays, the run is settled once", async () => {
    const w = await visited();
    await say(w.v, w.conv, "你好");
    const ticket = (await app.agentPort.claimNext())!;
    expect("call" in (await app.agentPort.begin(ticket))).toBe(true);
    await say(w.owner, w.conv, "我来回答他");
    expect((await stop(w.owner, w.v)).status).toBe(200);
    expect((await runsOf(w.agent.id, w.conv))[0]).toMatchObject({ status: "running", interrupted: "owner_spoke", pending: null });
    expect(await app.agentPort.post(ticket, { text: "在的", ...REPLY })).toBe("refused");
    await app.agentPort.finish(ticket, { status: "cancelled" }, null, NOTHING);
    await app.agentPort.finish(ticket, { status: "cancelled" }, null, NOTHING);
    expect((await runsOf(w.agent.id, w.conv))[0]).toMatchObject({ status: "cancelled", error: "owner_spoke" });
    expect(await usageRecords(ticket.id)).toBe(1);
  });
});

describe("I1a.2 and I1a.3: the owner's two numbers with real visitors", () => {
  it("12 answers a day: twelve visitor replies are admitted, the thirteenth ends quietly with one notice, and the owner's own reply runs", async () => {
    const w = await visited();
    expect((await api(app, w.owner, "PUT", "/api/me/others-limits", { answers: 12, points: "300" })).status).toBe(200);
    for (let i = 1; i <= 12; i++) {
      await say(w.v, w.conv, `第 ${i} 问`);
      gateway.reply(`第 ${i} 答`);
      expect(await app.agentWorker.runOnce()).toBe(true);
      // (Out of the callers' and the owner's minute: the day's numbers are what is tested.)
      await db.query("update agent_runs set created_at = created_at - interval '2 minutes' where agent_id = $1", [w.agent.id]);
    }
    expect((await textsOf(w.conv, w.agent.id)).map((m) => m.body.text)).toEqual(Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 答`));
    const before = gateway.calls.length;
    await say(w.v, w.conv, "第 13 问");
    await app.agentWorker.runOnce();
    await say(w.v, w.conv, "第 14 问");
    await app.agentWorker.runOnce();
    expect(gateway.calls.length).toBe(before);
    expect((await textsOf(w.conv, w.agent.id)).length).toBe(12);
    const notices = await db.query("select 1 from messages where conversation_id = $1 and kind = 'system' and body ->> 'event' = 'agent_daily_budget_reached'", [w.conv]);
    expect(notices.rowCount).toBe(1);
    const use = (await api(app, w.owner, "GET", "/api/me/others-use")).json;
    expect(use.used.answers).toBe(12);
    expect(use.reached).toBe(true);
    expect(use.byPerson.map((r: { person: { id: string }; answers: number }) => [r.person.id, r.answers])).toEqual([[w.v.id, 12]]);
    // The owner's own conversation is not held to it.
    await say(w.owner, w.agent.conversationId, "我自己问");
    gateway.reply("好的");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect((await textsOf(w.agent.conversationId, w.agent.id)).at(-1)!.body.text).toBe("好的");
  }, 120_000);

  it("five visitors at once under a points number that cannot hold them all: settled plus held never passes it, at any step", async () => {
    // What one visitor's reply holds on this model, measured once.
    const probe = await visited();
    await say(probe.v, probe.conv, "你好");
    const first = (await app.agentPort.claimNext())!;
    expect("call" in (await app.agentPort.begin(first))).toBe(true);
    const hold = await committedMicro(db, probe.owner.id);
    expect(hold > 0n).toBe(true);
    await app.agentPort.finish(first, { status: "cancelled" }, null, NOTHING);

    const t = tag();
    const owner = await signUp(app, `${t}o`);
    // An owner's points number is at least one point: the bound is 2.5 holds where a hold is that large, else what one point leaves after
    // the day's use is filled up (settled usage, written straight in, so that the same room of 2.5 holds is what is left).
    const POINT = 1_000_000n;
    const room = (hold * 5n) / 2n;
    const cap = room > POINT ? room : POINT;
    await setOwnerNumbers(db, owner.id, { pointsMicro: cap });
    const filler = cap - room;
    const visitors: Array<{ v: Actor; conv: string }> = [];
    for (let i = 0; i < 5; i++) {
      const agent = (await mustCreateAgent(app, owner, { handle: `${t}y${i}`, name: `${t}y${i}`, model: FAST, persona: "简短地回答。" })) as Made;
      const v = await signUp(app, `${t}v${i}`);
      expect((await add(v, agent.id)).status).toBe(202);
      const yes = await api(app, owner, "POST", `/api/agent-contacts/${agent.id}/${v.id}/approve`);
      visitors.push({ v, conv: yes.json.conversationId as string });
    }
    if (filler > 0n) {
      const used = (await mustCreateAgent(app, owner, { handle: `${t}f`, name: `${t}f`, model: FAST })) as Made;
      await seedRun(db, { ownerId: owner.id, agent: { agentId: used.id, conversationId: used.conversationId }, lane: "others", hold: filler, admittedAt: new Date() });
    }
    for (const x of visitors) await say(x.v, x.conv, "你好");
    const within = async (step: string) => expect([step, (await committedMicro(db, owner.id)) <= cap]).toEqual([step, true]);
    const begun: Array<{ ticket: NonNullable<Awaited<ReturnType<typeof app.agentPort.claimNext>>>; called: boolean }> = [];
    for (;;) {
      const ticket = await app.agentPort.claimNext();
      if (!ticket) break;
      const prepared = await app.agentPort.begin(ticket);
      begun.push({ ticket, called: "call" in prepared });
      await within(`after admission ${begun.length}`);
      if (!("call" in prepared)) await app.agentPort.finish(ticket, prepared, null, NOTHING);
    }
    expect(begun.some((b) => b.called)).toBe(true);
    for (const [i, b] of begun.entries()) {
      if (!b.called) continue;
      expect(await app.agentPort.post(b.ticket, { text: "在的", ...REPLY })).toBe("posted");
      await app.agentPort.finish(b.ticket, { status: "done" }, { inputTokens: 200, outputTokens: 50 }, NOTHING);
      await within(`after settlement ${i + 1}`);
    }
    // What was left waiting is admitted or refused by the same rule as the day goes on.
    for (;;) {
      const ticket = await app.agentPort.claimNext();
      if (!ticket) break;
      const prepared = await app.agentPort.begin(ticket);
      await within("after a later admission");
      await app.agentPort.finish(ticket, "call" in prepared ? { status: "cancelled" } : prepared, null, NOTHING);
      await within("after a later end");
    }
  }, 120_000);
});

describe("I1a.4: bars and blocks in a shared group (one access decision at every group site)", () => {
  it("a group-only caller who is no friend can be stopped: their @ and their Agent's relay are refused, others' go on, and 恢复往来 gives the @ back", async () => {
    const w = await grouped();
    const x = (await mustCreateAgent(app, w.v, { handle: `${w.t}x`, name: `${w.t}x`, model: FAST, persona: "简短地回答。" })) as Made;
    expect((await api(app, w.v, "POST", `/api/conversations/${w.g}/members`, { principalId: x.id })).status).toBe(201);
    expect(await reach(db, w.v.id, w.y.id, "group", app.deps.config)).toBe("ok");
    // Before: V's @ queues a reply of Y.
    await say(w.v, w.g, `${w.at} 在吗`);
    gateway.reply("在的");
    expect(await app.agentWorker.runOnce()).toBe(true);
    const before = (await runsOf(w.y.id, w.g)).length;
    expect(before).toBe(1);

    expect((await stop(w.owner, w.v)).status).toBe(200);
    expect(await reach(db, w.v.id, w.y.id, "group", app.deps.config)).toBe("barred");
    await say(w.v, w.g, `${w.at} 再问一次`);
    expect((await runsOf(w.y.id, w.g)).length).toBe(before);
    // V's Agent relays V's call: refused for the Agent as a subject and for the person behind it.
    await say(w.v, w.g, `@${w.t}x 帮我问问`);
    gateway.reply(`${w.at} 我主人想问个事`);
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect((await runsOf(w.y.id, w.g)).length).toBe(before);
    // W is not stopped: W's @ is answered as ever.
    await say(w.w, w.g, `${w.at} 我也问`);
    expect((await runsOf(w.y.id, w.g)).length).toBe(before + 1);
    gateway.reply("好的");
    expect(await app.agentWorker.runOnce()).toBe(true);
    // The owner's own list says who is stopped; the stopped person's says nothing.
    expect((await api(app, w.owner, "GET", "/api/me/others-use")).json.stopped.map((r: { person: { id: string } }) => r.person.id)).toEqual([w.v.id]);
    expect((await api(app, w.v, "GET", "/api/me/others-use")).json.stopped).toEqual([]);

    expect((await resume(w.owner, w.v)).status).toBe(200);
    await say(w.v, w.g, `${w.at} 现在呢`);
    expect((await runsOf(w.y.id, w.g)).length).toBe(before + 2);
    gateway.reply("在");
    expect(await app.agentWorker.runOnce()).toBe(true);
  });

  it("the owner's block of another person's Agent refuses its relays; a pair who never had access keeps group @ after an unfriend", async () => {
    const w = await grouped();
    const x = (await mustCreateAgent(app, w.v, { handle: `${w.t}x`, name: `${w.t}x`, model: FAST, persona: "简短地回答。" })) as Made;
    expect((await api(app, w.v, "POST", `/api/conversations/${w.g}/members`, { principalId: x.id })).status).toBe(201);
    expect((await api(app, w.owner, "PUT", `/api/blocks/${x.id}`)).status).toBe(200);
    await say(w.w, w.g, `@${w.t}x 帮我问问`);
    gateway.reply(`${w.at} 有人想问个事`);
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect((await runsOf(w.y.id, w.g)).length).toBe(0);
    // An unfriend is just an unfriend: no bar, and in a group anyone may still @ the Agent.
    await befriend(app, w.owner, w.v);
    expect((await api(app, w.owner, "DELETE", `/api/friends/${w.v.id}`)).status).toBe(200);
    expect((await db.query("select 1 from access_bars where setter_id = any($1::uuid[])", [[w.owner.id, w.v.id]])).rowCount).toBe(0);
    await say(w.v, w.g, `${w.at} 在吗`);
    expect((await runsOf(w.y.id, w.g)).length).toBe(1);
    gateway.reply("在的");
    expect(await app.agentWorker.runOnce()).toBe(true);
  });

  it("停止往来 while a group reply to that person is being written: not posted, ended quietly with NO error, settled once; a call someone else noted on it is answered", async () => {
    const w = await grouped();
    await say(w.v, w.g, `${w.at} V-ASK 在吗`);
    const ticket = (await app.agentPort.claimNext())!;
    expect("call" in (await app.agentPort.begin(ticket))).toBe(true);
    const noted = await say(w.w, w.g, `${w.at} W-ASK 我也问`);
    expect((await stop(w.owner, w.v)).status).toBe(200);
    expect((await runsOf(w.y.id, w.g))[0]).toMatchObject({ status: "running", interrupted: "access_ended", pending: noted });
    expect(app.agentPort.shouldStop(ticket)).toBe(true);
    expect(await app.agentPort.post(ticket, { text: "在的", ...REPLY })).toBe("refused");
    await app.agentPort.finish(ticket, { status: "cancelled" }, null, NOTHING);
    await app.agentPort.finish(ticket, { status: "cancelled" }, null, NOTHING);
    const runs = await runsOf(w.y.id, w.g);
    expect(runs[0]).toMatchObject({ status: "cancelled", error: null });
    expect(await usageRecords(ticket.id)).toBe(1);
    expect(await textsOf(w.g, w.y.id)).toEqual([]);
    expect(runs).toHaveLength(2);
    expect(runs[1]).toMatchObject({ status: "queued", caller: w.w.id });
    expect(runs[1]!.calls).toContain(noted);
    gateway.reply("W 的答案");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect((await textsOf(w.g, w.y.id)).map((m) => m.body.text)).toEqual(["W 的答案"]);
  });

  it("a queued group reply whose only caller is stopped ends at once, quietly; one with another caller goes on as theirs", async () => {
    const w = await grouped();
    const first = await say(w.v, w.g, `${w.at} V-ASK`);
    const second = await say(w.w, w.g, `${w.at} W-ASK`);
    expect((await runsOf(w.y.id, w.g))[0]!.calls).toEqual([first, second]);
    expect((await stop(w.owner, w.v)).status).toBe(200);
    expect((await runsOf(w.y.id, w.g))[0]).toMatchObject({ status: "queued", error: null, caller: w.w.id, calls: [second] });
    gateway.reply("只回 W");
    expect(await app.agentWorker.runOnce()).toBe(true);
    const other = await grouped();
    await say(other.v, other.g, `${other.at} V-ASK`);
    expect((await stop(other.owner, other.v)).status).toBe(200);
    expect((await runsOf(other.y.id, other.g))[0]).toMatchObject({ status: "cancelled", error: null, pending: null });
    expect(await app.agentWorker.runOnce()).toBe(false);
  });

  it("a disabled Agent answers nobody in a group: an @ is refused, it is no option for a reply nobody asked for, and its owner's own @ still goes", async () => {
    const w = await grouped();
    expect(await disableAgent(db, await fullHandle(w.y.id))).not.toBeNull();
    const seq = await say(w.v, w.g, `${w.at} 在吗`);
    expect((await runsOf(w.y.id, w.g)).length).toBe(0);
    const plain = await say(w.w, w.g, "今天谁有空");
    await db.query("update agents set proactive = true where principal_id = $1", [w.y.id]);
    expect((await optionsFor(db, w.g, plain, w.w.id, app.deps.config)).map((o) => o.agentId)).not.toContain(w.y.id);
    expect(seq).toBeLessThan(plain);
    await say(w.owner, w.g, `${w.at} 我自己问`);
    expect((await runsOf(w.y.id, w.g)).length).toBe(1);
    gateway.reply("主人好");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect((await textsOf(w.g, w.y.id)).map((m) => m.body.text)).toEqual(["主人好"]);
  });
});

describe("I1a.5: nothing of the owner's notes reaches a visitor (ring 1a), through the real add path", () => {
  it("a vault canary and an open-note canary are in no request of a visitor's reply and in nothing the visitor is sent", async () => {
    const w = await visited();
    await db.query("insert into owner_notes (owner_id, text, vault) values ($1, $2, false), ($1, $3, true)", [w.owner.id, "OPEN-CANARY 主人爱吃辣", "VAULT-CANARY 主人的存款"]);
    await db.query("insert into agent_notes (agent_id, text, vault) values ($1, $2, false)", [w.agent.id, "SELF-CANARY 我记下的"]);
    await db.query("update agents set memory = true, shared_notes = true where principal_id = $1", [w.agent.id]);
    const socket = await connect(app, w.v);
    const from = gateway.calls.length;
    await say(w.v, w.conv, "你知道主人爱吃什么吗");
    gateway.callTools([{ name: "search_messages", input: { query: "爱吃" } }], { text: "我看看。" }).reply("不方便说。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    const calls = gateway.calls.slice(from);
    expect(calls.length).toBe(2);
    expect(JSON.stringify(calls)).not.toContain("CANARY");
    const read = await api(app, w.v, "GET", `/api/conversations/${w.conv}/messages`);
    expect(JSON.stringify(read.json)).not.toContain("CANARY");
    expect(JSON.stringify(socket.events)).not.toContain("CANARY");
    const [run] = (await db.query<{ shown_notes: unknown; withheld_notes: unknown }>("select shown_notes, withheld_notes from agent_runs where agent_id = $1 and conversation_id = $2", [w.agent.id, w.conv])).rows;
    expect(run).toEqual({ shown_notes: null, withheld_notes: null });
    // What the visitor is sent of the reply: its text; never its reasoning, the model it used or what its search asked for.
    const reply = (read.json.messages as Array<Record<string, unknown>>).find((m) => m.senderId === w.agent.id)!;
    for (const key of ["reasoning", "via", "queries"]) expect(reply, key).not.toHaveProperty(key);
  });
});

describe("I1a.6: the switch off leaves groups byte for byte as they are, and refuses everything social", () => {
  /** Ids, times and the run's mark are this run's own; everything else must be the same bytes. */
  const plain = (value: unknown, mark?: string) => {
    let s = JSON.stringify(value);
    if (mark) s = s.split(mark).join("<mark>");
    return s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>").replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<t>");
  };
  it("the same group @ on two fresh groups, switch off and on: the model call, the posted reply and every member's frames are identical", async () => {
    const [owner, v, third] = [await signUp(app, "sw_same_o"), await signUp(app, "sw_same_v"), await signUp(app, "sw_same_w")];
    const y = (await mustCreateAgent(app, owner, { handle: "sw_same_y", name: "同一个", model: FAST, persona: "简短地回答。" })) as Made;
    await befriend(app, owner, v);
    await befriend(app, owner, third);
    async function round() {
      const made = await api(app, owner, "POST", "/api/conversations", { title: "同一个群", memberIds: [v.id, third.id] });
      expect(made.status).toBe(201);
      const g = made.json.id as string;
      expect((await api(app, owner, "POST", `/api/conversations/${g}/members`, { principalId: y.id })).status).toBe(201);
      const sockets = [await connect(app, owner), await connect(app, v)];
      const from = gateway.calls.length;
      await say(v, g, "@sw_same_y 周三有空吗");
      gateway.reply("周三有空。");
      expect(await app.agentWorker.runOnce()).toBe(true);
      await sockets[1]!.waitFor((e) => e.type === "message" && e.message?.senderId === y.id);
      await sockets[0]!.waitFor((e) => e.type === "run" && e.run?.status === "done");
      const [call] = gateway.calls.slice(from);
      const mark = markOf(call!);
      const out = {
        call: plain({ system: call!.system, messages: call!.messages, tools: call!.tools, maxOutputTokens: call!.maxOutputTokens }, mark),
        posted: plain((await textsOf(g, y.id)).map((m) => m.body)),
        frames: sockets.map((s) => plain(s.events.filter((e) => e.conversationId === g || e.message?.conversationId === g).map(({ seq: _seq, ...rest }) => rest))),
      };
      await closeAllSockets();
      // (Out of the minute, so the second round is as free as the first.)
      await db.query("update agent_runs set created_at = created_at - interval '2 minutes' where agent_id = $1", [y.id]);
      return out;
    }
    const off = await switchedOff(round);
    const on = await round();
    expect(on.call).toBe(off.call);
    expect(on.posted).toBe(off.posted);
    expect(on.frames).toEqual(off.frames);
  });

  it("switch off: no Agent can be added or looked up, a social conversation takes no message, a queued reply there is never claimed, and the sync says so", async () => {
    const w = await visited();
    const stranger = await signUp(app, `${w.t}s`);
    const handle = await fullHandle(w.agent.id);
    await say(w.v, w.conv, "排着队的一问");
    await switchedOff(async () => {
      expect((await add(stranger, w.agent.id)).status).toBe(404);
      expect((await api(app, stranger, "GET", `/api/principals/lookup?handle=${handle}`)).status).toBe(404);
      expect((await api(app, w.owner, "GET", `/api/agents/${w.agent.id}/contacts`)).status).toBe(404);
      expect((await stop(w.owner, w.v)).status).toBe(404);
      expect((await send(w.v, w.conv, "还能写吗")).status).not.toBe(201);
      expect(await app.agentPort.claimNext()).toBeNull();
      expect((await runsOf(w.agent.id, w.conv))[0]).toMatchObject({ status: "cancelled", error: "access_ended" });
      const sync = (await api(app, w.owner, "GET", "/api/sync")).json;
      expect(sync.social).toEqual({ enabled: false });
      expect((await api(app, w.owner, "GET", "/api/me/others-use")).json.stopped).toEqual([]);
      // Nobody stopped anybody here: there is nothing to resume, and no new stop can be made.
      expect((await resume(w.owner, w.v)).status).toBe(404);
    });
    // On again: nothing answers the old message.
    expect(await app.agentPort.claimNext()).toBeNull();
    expect(await textsOf(w.conv, w.agent.id)).toEqual([]);
  });
});

describe("fix round 1, I4: a stop its setter made can always be seen and undone by them, whatever the switch says", () => {
  it("switch on, 停止往来; switch off: it still refuses in the group, the setter still reads it and lifts it (恢复往来), no new stop can be made, and nothing else of Agent social answers", async () => {
    const w = await grouped();
    expect((await stop(w.owner, w.v)).status).toBe(200);
    await switchedOff(async () => {
      // The stop is the person's own protective act: it holds while it exists.
      await say(w.v, w.g, `${w.at} 在吗`);
      expect((await runsOf(w.y.id, w.g)).length).toBe(0);
      // Its setter reads it; the stopped person reads nothing of it.
      const listed = (await api(app, w.owner, "GET", "/api/me/others-use")).json.stopped as Array<{ person: { id: string; handle: string }; since: string }>;
      expect(listed.map((r) => r.person.id)).toEqual([w.v.id]);
      expect((await api(app, w.v, "GET", "/api/me/others-use")).json.stopped).toEqual([]);
      // No NEW stop while the switch is off, by anyone; and the rest of Agent social stays shut.
      expect((await stop(w.owner, w.w)).status).toBe(404);
      expect((await stop(w.v, w.owner)).status).toBe(404);
      expect((await add(w.w, w.y.id)).status).toBe(404);
      expect((await api(app, w.owner, "GET", `/api/agents/${w.y.id}/contacts`)).status).toBe(404);
      expect((await api(app, w.owner, "GET", "/api/sync")).json.social).toEqual({ enabled: false });
      // Only the setter lifts it; then it is gone from the list, a second lift has nothing to lift, and the person is answered again.
      expect((await resume(w.v, w.owner)).status).toBe(404);
      expect((await resume(w.owner, w.v)).status).toBe(200);
      expect((await api(app, w.owner, "GET", "/api/me/others-use")).json.stopped).toEqual([]);
      expect((await resume(w.owner, w.v)).status).toBe(404);
      await say(w.v, w.g, `${w.at} 现在呢`);
      expect((await runsOf(w.y.id, w.g)).length).toBe(1);
      gateway.reply("在的");
      expect(await app.agentWorker.runOnce()).toBe(true);
    });
  });
});

describe("fix round 1, m17: no whisper can be made in a social conversation", () => {
  it("createWhisper stores nothing and answers null there, for the owner who watches (the same call in the Agent's own conversation makes one)", async () => {
    const w = await visited();
    const body = { text: "只给主人", actions: ["dismiss"] as const };
    const made = (conversationId: string) => db.tx((t) => createWhisper(t, { conversationId, ownerId: w.owner.id, agentId: w.agent.id, kind: "tools_off", body: { ...body, actions: [...body.actions] } }));
    expect(await made(w.conv)).toBeNull();
    expect((await db.query("select 1 from whispers where conversation_id = $1", [w.conv])).rowCount).toBe(0);
    expect(await made(w.agent.conversationId)).not.toBeNull();
  });
});

describe("I1a.7: the stopped list end to end (M-V6)", () => {
  it("the owner's 停止往来 lists the person, their add meets the cooldown, 恢复往来 empties the list and the next add is a request; a block is never listed", async () => {
    const w = await visited();
    const other = await signUp(app, `${w.t}b`);
    expect((await api(app, w.owner, "PUT", `/api/blocks/${other.id}`)).status).toBe(200);
    expect((await stop(w.owner, w.v)).status).toBe(200);
    const listed = (await api(app, w.owner, "GET", "/api/me/others-use")).json.stopped as Array<{ person: { id: string; handle: string; displayName: string }; since: string }>;
    expect(listed.map((r) => r.person.id)).toEqual([w.v.id]);
    expect(listed[0]!.person).toMatchObject({ handle: w.v.handle });
    expect(Math.abs(Date.parse(listed[0]!.since) - Date.now())).toBeLessThan(60_000);
    // A second press changes neither the list nor its date.
    expect((await stop(w.owner, w.v)).status).toBe(200);
    expect(((await api(app, w.owner, "GET", "/api/me/others-use")).json.stopped as typeof listed)[0]!.since).toBe(listed[0]!.since);
    const refused = await add(w.v, w.agent.id);
    expect([refused.status, refused.json.error]).toEqual([429, "cooldown"]);
    // (With the switch off the owner still reads their own stop: the test below.)
    expect((await resume(w.owner, w.v)).status).toBe(200);
    expect((await api(app, w.owner, "GET", "/api/me/others-use")).json.stopped).toEqual([]);
    expect((await resume(w.owner, w.v)).status).toBe(404);
    expect((await add(w.v, w.agent.id)).status).toBe(202);
    const rows = await db.query<{ state: string }>("select state from agent_contacts where agent_id = $1 and subject_id = $2", [w.agent.id, w.v.id]);
    expect(rows.rows.map((r) => r.state)).toEqual(["requested"]);
  });
});
