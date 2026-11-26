import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decideProactive } from "../src/agents/proactive/decide.ts";
import { insertMessage } from "../src/messages/model.ts";
import type { ModelCall } from "../src/models/gateway.ts";
import { api, befriend, group, signUp, type Actor } from "./helpers/actors.ts";
import { markOf, mustCreateAgent, PNG, SITE_ENV } from "./helpers/agents.ts";
import { useProbeBlobs } from "./helpers/blobs.ts";
import { useApp } from "./helpers/harness.ts";
import { byName, scriptedJudge } from "./helpers/judge.ts";
import { grant } from "./helpers/metering.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { MULTIPART, multipart } from "./helpers/multipart.ts";

/**
 * A late joiner cannot get the past out of someone's Agent (Task 10b; the product rule of 2026-11-20): in a group, the
 * history a reply's model is shown starts at the later of where the Agent's own membership began and where the asker's
 * current membership began — the asker being the person whose message caused the reply: the sender of a mention, the
 * sender of the message a reply nobody asked for answers, and in an Agents' chain the person whose message started it
 * (unknown, or no longer in the group: the latest join among the group's people now) — and, as asking too, every person
 * whose message came after what the reply answers before it began (fix round 1, I-1). Nothing before that line reaches
 * the model: no message, no quote of one, no file of one; a reply whose every question is at or before it ends quietly.
 * Driven through the real routes, the worker run by hand; every assertion is on what the scripted model was actually
 * sent.
 */

const JUDGE = {
  model: "jev-1",
  channels: [{ url: "https://judge-a.example.test/v1/systemone", apiKeyEnv: "UPSTREAM_TEST_KEY" }],
  timeoutMs: 4000,
  dailyLimit: 20_000,
};
const gateway = scriptedGateway();
const judge = scriptedJudge();
const { blobs } = useProbeBlobs("af-group-asker-");
const { app, db } = useApp({ env: SITE_ENV, models: gateway, judge, blobs, agentWorker: false, config: { judge: JUDGE } });

let first = 0;
beforeEach(() => {
  first = gateway.calls.length;
  judge.calls.splice(0);
  judge.answer(() => ({}));
});
afterEach(() => {
  expect(gateway.pending()).toBe(0);
});

const FAST = { source: "site", id: "fast" } as const;
/** What the attack asked (docs/acceptance/attack-1). */
const QUESTION = "@helper_bot 我刚进群，大家最近有什么要注意的吗？";
/** Said in the group after the Agent joined and before the newcomer did: never shown to a reply the newcomer asked for. */
const SECRET = {
  m: "SECRET-M-10b 我下个月要做手术，先别往外说",
  m2: "SECRET-M2-10b 我家最近在闹离婚",
  file: "FILE-SECRET-10b 体检结果：一切正常",
};
const FILE_NAME = "体检报告.txt";

let txn = 0;
const say = async (who: Actor, conv: string, text: string, extra: Record<string, unknown> = {}): Promise<number> => {
  const sent = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `ak${++txn}`, ...extra });
  if (sent.status !== 201) throw new Error(`say: ${sent.status} ${JSON.stringify(sent.json)}`);
  return sent.json.message.seq as number;
};
/** Uploads `data` as `filename` (of `type`) and sends it to `conv`, with `caption` as its text if given; returns its seq. */
async function sendFile(who: Actor, conv: string, filename: string, data: string | Buffer, type = "application/octet-stream", caption?: string): Promise<number> {
  const uploaded = await app.inject({
    method: "POST",
    url: `/api/conversations/${conv}/attachments`,
    headers: { cookie: who.cookie, "content-type": MULTIPART },
    payload: multipart([{ name: "file", filename, type, data }]),
  });
  expect(uploaded.statusCode).toBe(201);
  const sent = await api(app, who, "POST", `/api/conversations/${conv}/messages`, {
    attachmentId: uploaded.json().id,
    clientTxn: `ak${++txn}`,
    ...(caption === undefined ? {} : { text: caption }),
  });
  expect(sent.status).toBe(201);
  return sent.json.message.seq as number;
}
/** An image (a 1×1 PNG, shown inline) named `filename`. */
const sendImage = (who: Actor, conv: string, filename: string): Promise<number> => sendFile(who, conv, filename, PNG, "image/png");
const addMember = async (by: Actor, conv: string, principalId: string): Promise<void> => {
  const res = await api(app, by, "POST", `/api/conversations/${conv}/members`, { principalId });
  if (res.status !== 201) throw new Error(`addMember: ${res.status} ${JSON.stringify(res.json)}`);
};
const removeMember = async (by: Actor, conv: string, principalId: string): Promise<void> => {
  const res = await api(app, by, "DELETE", `/api/conversations/${conv}/members/${principalId}`);
  if (res.status !== 200) throw new Error(`removeMember: ${res.status} ${JSON.stringify(res.json)}`);
};
const leave = (who: Actor, conv: string): Promise<void> => removeMember(who, conv, who.id);
/** Where `principalId`'s current stay in `conv` began. */
const joinedSeq = async (conv: string, principalId: string): Promise<number> =>
  Number(
    (await db.query<{ seq: string }>("select joined_seq::text as seq from memberships where conversation_id = $1 and principal_id = $2 and left_seq is null", [conv, principalId]))
      .rows[0]!.seq,
  );

const callsHere = (): ModelCall[] => gateway.calls.slice(first);
const lastCall = (): ModelCall => {
  const calls = callsHere();
  expect(calls.length).toBeGreaterThan(0);
  return calls.at(-1)!;
};
/** Runs the oldest queued reply, which answers `text`. */
async function answer(text: string): Promise<void> {
  gateway.reply(text);
  expect(await app.agentWorker.runOnce()).toBe(true);
}
/** Everything a call shows the model as text: its system text and every text part of its turns. */
const shownText = (call: ModelCall): string =>
  [call.system, ...call.messages.flatMap((m) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])))].join("\n");

/**
 * The seqs of `conv`'s messages from people that `call` shows — a message's text, or its file's name, appears in what
 * it sends (every such text is distinct in these tests) — and, for comparison, those after `line`.
 */
async function seqsShown(call: ModelCall, conv: string): Promise<{ shown: number[]; all: Array<{ seq: number }> }> {
  const { rows } = await db.query<{ seq: string; text: string | null; name: string | null }>(
    `select m.seq::text as seq, m.body ->> 'text' as text, m.body -> 'attachment' ->> 'name' as name
       from messages m join principals p on p.id = m.sender_id
      where m.conversation_id = $1 and m.kind in ('text', 'file') and p.kind = 'human'
      order by m.seq`,
    [conv],
  );
  const text = shownText(call);
  const all = rows.map((r) => ({ seq: Number(r.seq), shows: r.text ? r.text : r.name! }));
  return { shown: all.filter((m) => text.includes(m.shows)).map((m) => m.seq), all };
}
/** The seqs of `conv`'s messages from people after `line`. */
const peopleAfter = async (conv: string, line: number): Promise<number[]> =>
  (
    await db.query<{ seq: string }>(
      `select m.seq::text as seq from messages m join principals p on p.id = m.sender_id
        where m.conversation_id = $1 and m.kind in ('text', 'file') and p.kind = 'human' and m.seq > $2 order by m.seq`,
      [conv, line],
    )
  ).rows.map((r) => Number(r.seq));

/** No canary of what was said before the line in anything the call sends: its system text, its texts, its files' bytes. */
function expectNoSecret(call: ModelCall): void {
  const sent = JSON.stringify(call);
  for (const secret of [...Object.values(SECRET), FILE_NAME]) expect([secret, sent.includes(secret)]).toEqual([secret, false]);
  for (const m of call.messages) for (const p of m.parts) if (p.type === "image" || p.type === "file") expect(Buffer.from(p.data).toString("utf8")).not.toContain("SECRET");
}

const runsOf = async (agentId: string, conv: string) =>
  (
    await db.query<{ status: string; error: string | null; lane: string }>(
      "select status, error, lane from agent_runs where agent_id = $1 and conversation_id = $2 order by created_at, id",
      [agentId, conv],
    )
  ).rows;

interface World {
  /** The Agent's owner, who made the group. */
  v: Actor;
  m: Actor;
  m2: Actor;
  /** The newcomer: befriended by `v`, not yet in the group. */
  s: Actor;
  g: string;
  /** `v`'s Agent 小助手 (`@helper_bot`), in the group, proactive. */
  agent: { id: string; handle: string; name: string; conversationId: string };
}

async function world(): Promise<World> {
  const [v, m, m2, s] = [await signUp(app, "vivi"), await signUp(app, "mona"), await signUp(app, "mike"), await signUp(app, "sam")];
  const g = await group(app, v, "小区业主群", [m, m2]);
  const agent = await mustCreateAgent(app, v, { handle: "helper_bot", name: "小助手", intro: "帮大家记事", model: FAST, persona: "你是小助手，说话简短。", proactive: true });
  await addMember(v, g, agent.id);
  await befriend(app, v, s);
  return { v, m, m2, s, g, agent };
}

/** `m` and `m2` each say a private thing (no mention) and `m2` sends a file: all after the Agent joined. */
async function privateThings(w: World): Promise<void> {
  await say(w.m, w.g, SECRET.m);
  await say(w.m2, w.g, SECRET.m2);
  await sendFile(w.m2, w.g, FILE_NAME, SECRET.file);
}

/** `v` adds the newcomer; returns where their stay began. */
async function newcomerJoins(w: World): Promise<number> {
  await addMember(w.v, w.g, w.s.id);
  return joinedSeq(w.g, w.s.id);
}

/** `v` befriends `name` and adds them after everything so far: another newcomer, and where their stay began. */
async function anotherJoins(w: World, name: string): Promise<{ who: Actor; line: number }> {
  const who = await signUp(app, name);
  await befriend(app, w.v, who);
  await addMember(w.v, w.g, who.id);
  return { who, line: await joinedSeq(w.g, who.id) };
}

/** Every part of a call that is not text (an image, a PDF). */
const filesSent = (call: ModelCall) => call.messages.flatMap((m) => m.parts.filter((p) => p.type !== "text"));

// --- the attack ------------------------------------------------------------------------------------------------------

describe("a newcomer asks someone's Agent what was said before they joined", () => {
  it("the attack: the newcomer's question is answered from nothing before their joining — no message, no file; the same question from an older member is answered from everything since the Agent joined", async () => {
    const w = await world();
    const agentJoined = await joinedSeq(w.g, w.agent.id);
    await privateThings(w);
    const line = await newcomerJoins(w);

    const asked = await say(w.s, w.g, QUESTION);
    await answer("（给新来的回答）");
    const toNewcomer = lastCall();
    expectNoSecret(toNewcomer);
    const fromNewcomer = await seqsShown(toNewcomer, w.g);
    expect(fromNewcomer.shown).toEqual(await peopleAfter(w.g, line));
    expect(fromNewcomer.shown).toEqual([asked]);
    expect(fromNewcomer.all.filter((x) => x.seq <= line && x.seq > agentJoined)).toHaveLength(3);

    // The same question from a member who was there before the Agent: everything since the Agent joined.
    await say(w.m, w.g, QUESTION);
    await answer("（给老成员的回答）");
    const toMember = lastCall();
    const sent = shownText(toMember);
    for (const secret of [SECRET.m, SECRET.m2]) expect([secret, sent.includes(secret)]).toEqual([secret, true]);
    expect(sent).toContain(`[文件：${FILE_NAME}]\n${SECRET.file}`);
    expect((await seqsShown(toMember, w.g)).shown).toEqual(await peopleAfter(w.g, agentJoined));
    expect(await runsOf(w.agent.id, w.g)).toEqual([
      { status: "done", error: null, lane: "others" },
      { status: "done", error: null, lane: "others" },
    ]);
  });

  it("a reply nobody asked for, picked for the newcomer's message, is cut at the newcomer's joining", async () => {
    const w = await world();
    await privateThings(w);
    const line = await newcomerJoins(w);
    await say(w.m, w.g, "欢迎新邻居");
    const asked = await say(w.s, w.g, "我刚进群，大家最近有什么要注意的吗？");
    judge.answer(byName({ 小助手: 0.95 }));
    const decided = await decideProactive({ db, judge, config: app.deps.config, log: app.log }, w.g, asked);
    expect(decided.runs).toHaveLength(1);
    for (const run of decided.runs) app.agentPort.announce(run);

    await answer("（主动回答新来的）");
    const call = lastCall();
    expectNoSecret(call);
    expect((await seqsShown(call, w.g)).shown).toEqual(await peopleAfter(w.g, line));
    expect(await runsOf(w.agent.id, w.g)).toEqual([{ status: "done", error: null, lane: "proactive" }]);
  });

  it("an Agents' chain the newcomer started: the Agent they asked and the Agent it asked are both cut at the newcomer's joining; the same chain an older member started is not", async () => {
    const w = await world();
    const other = await mustCreateAgent(app, w.m, { handle: "other_bot", name: "阿杰", intro: "擅长查资料", model: FAST, persona: "你是阿杰。" });
    await addMember(w.m, w.g, other.id);
    await privateThings(w);
    const line = await newcomerJoins(w);

    const asked = await say(w.s, w.g, "@helper_bot 你帮我问问阿杰，大家最近有什么要注意的？");
    await answer("@other_bot 最近群里有什么要注意的吗？");
    const toFirst = lastCall();
    await answer("没什么特别的。");
    const toSecond = lastCall();
    expect(toSecond).not.toBe(toFirst);
    for (const call of [toFirst, toSecond]) {
      expectNoSecret(call);
      expect((await seqsShown(call, w.g)).shown).toEqual([asked]);
    }
    expect(shownText(toSecond)).toContain("@other_bot 最近群里有什么要注意的吗？");
    expect((await runsOf(other.id, w.g)).map((r) => r.status)).toEqual(["done"]);

    // The same chain from an older member reaches back to the Agents' own joining.
    await say(w.m2, w.g, "@helper_bot 你也帮我问问阿杰，大家最近有什么要注意的？");
    await answer("@other_bot 再问一次，最近群里有什么要注意的吗？");
    await answer("还是没什么。");
    const fromMember = lastCall();
    for (const secret of [SECRET.m, SECRET.m2]) expect([secret, shownText(fromMember).includes(secret)]).toEqual([secret, true]);
    expect(line).toBeGreaterThan(0);
  });

  it("after leaving and coming back the line is where the newcomer came back: nothing of their first stay, nothing of while they were away", async () => {
    const w = await world();
    await privateThings(w);
    await newcomerJoins(w);
    await say(w.s, w.g, "FIRST-STAY-10b 大家好");
    await leave(w.s, w.g);
    await say(w.m, w.g, "SECRET-AWAY-10b 他走了我们说点别的");
    const back = await newcomerJoins(w);

    const asked = await say(w.s, w.g, QUESTION);
    await answer("（回答回来的人）");
    const call = lastCall();
    expectNoSecret(call);
    for (const absent of ["FIRST-STAY-10b", "SECRET-AWAY-10b"]) expect([absent, JSON.stringify(call).includes(absent)]).toEqual([absent, false]);
    expect((await seqsShown(call, w.g)).shown).toEqual([asked]);
    expect(await peopleAfter(w.g, back)).toEqual([asked]);
  });

  it("a message after the line quoting one before it: the quote is left out for the newcomer's question (as for one the Agent cannot see), shown for an older member's", async () => {
    const w = await world();
    const quoted = await say(w.m, w.g, "SECRET-QUOTED-10b 我们周六去吃火锅");
    await newcomerJoins(w);
    const quoting = await say(w.m2, w.g, "看上面这条", { replyToSeq: quoted });
    // The newcomer's read of it carries no quoted text either (the wire's own "not visible").
    const read = (await api(app, w.s, "GET", `/api/conversations/${w.g}/messages`)).json.messages.find((x: { seq: number }) => x.seq === quoting);
    expect(read.replyTo).toEqual({ seq: quoted, visible: false });

    const asked = await say(w.s, w.g, QUESTION);
    await answer("（回答新来的）");
    const toNewcomer = lastCall();
    const m = markOf(toNewcomer);
    expect(JSON.stringify(toNewcomer)).not.toContain("SECRET-QUOTED-10b");
    expect(toNewcomer.messages).toEqual([
      {
        role: "user",
        parts: [
          { type: "text", text: `〔${m} mike｜群成员〕看上面这条` },
          { type: "text", text: `〔${m} sam｜群成员〕${QUESTION}` },
        ],
      },
    ]);
    expect((await seqsShown(toNewcomer, w.g)).shown).toEqual([quoting, asked]);

    await say(w.m, w.g, "@helper_bot 上面那条引用说的是什么？");
    await answer("（回答老成员）");
    expect(shownText(lastCall())).toContain(`〔${markOf(lastCall())} mike｜群成员〕\n> SECRET-QUOTED-10b 我们周六去吃火锅\n看上面这条`);
  });

  it("the newcomer's mention folded into a reply an older member asked for: the one reply answers both, cut at the later joining — the newcomer's", async () => {
    const w = await world();
    await privateThings(w);
    const line = await newcomerJoins(w);
    const older = await say(w.m, w.g, "@helper_bot 周末停水的事你记得吗？");
    const asked = await say(w.s, w.g, QUESTION);
    // One queued reply covers both.
    expect((await runsOf(w.agent.id, w.g)).map((r) => r.status)).toEqual(["queued"]);
    await answer("（一起回答）");
    const call = lastCall();
    expectNoSecret(call);
    expect((await seqsShown(call, w.g)).shown).toEqual([older, asked]);
    expect(await peopleAfter(w.g, line)).toEqual([older, asked]);
  });

  it("the newcomer's mention noted while a reply to an older member runs: that reply is as it was; its follow-up is cut at the newcomer's joining", async () => {
    const w = await world();
    await privateThings(w);
    const line = await newcomerJoins(w);
    await say(w.m, w.g, "@helper_bot 周末停水的事你记得吗？");
    const hold = gateway.hang();
    const running = app.agentWorker.runOnce();
    const toMember = await hold.reached;
    const asked = await say(w.s, w.g, QUESTION);
    hold.release("（回答老成员）");
    expect(await running).toBe(true);
    // The older member's reply was shown everything since the Agent joined.
    for (const secret of [SECRET.m, SECRET.m2]) expect([secret, shownText(toMember).includes(secret)]).toEqual([secret, true]);

    await answer("（回答新来的）");
    const followUp = lastCall();
    expect(followUp).not.toBe(toMember);
    expectNoSecret(followUp);
    expect((await seqsShown(followUp, w.g)).shown).toEqual(await peopleAfter(w.g, line));
    expect((await seqsShown(followUp, w.g)).shown).toContain(asked);
  });

  it("a reply whose asker is not known (a run recorded before askers were, or a chain whose first person cannot be told) is cut at the latest joining of the group's people now", async () => {
    const w = await world();
    await privateThings(w);
    const line = await newcomerJoins(w);
    const after = await say(w.m, w.g, "AFTER-10b 新邻居来了");
    // As a run recorded before this rule: no asker on it.
    await db.query(
      `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, triggered_by, lane)
       values ('reply', $1, $2, $3, 'queued', $4, 'agent', 'others')`,
      [w.g, w.agent.id, w.v.id, after],
    );
    await answer("（不知道谁问的）");
    const call = lastCall();
    expectNoSecret(call);
    expect((await seqsShown(call, w.g)).shown).toEqual(await peopleAfter(w.g, line));
    expect((await seqsShown(call, w.g)).shown).toEqual([after]);
  });

  it("a newcomer's very first question is a window of one message: planned and answered, no context_too_small", async () => {
    const w = await world();
    await privateThings(w);
    for (let i = 0; i < 5; i++) await say(w.m, w.g, `早先的闲聊 ${i}`);
    await newcomerJoins(w);
    await say(w.s, w.g, QUESTION);
    await answer("（一条消息的窗口）");
    const call = lastCall();
    expect(call.messages).toEqual([{ role: "user", parts: [{ type: "text", text: `〔${markOf(call)} sam｜群成员〕${QUESTION}` }] }]);
    expect(await runsOf(w.agent.id, w.g)).toEqual([{ status: "done", error: null, lane: "others" }]);
    const posted = (await api(app, w.s, "GET", `/api/conversations/${w.g}/messages`)).json.messages.at(-1);
    expect(posted).toMatchObject({ senderId: w.agent.id, text: "（一条消息的窗口）" });
  });
});

// --- whoever the reply will hear from (fix round 1) -------------------------------------------------------------------

describe("everyone whose words the reply will see counts: what a person sends while the reply waits", () => {
  it("the newcomer's question without a mention, sent while an older member's reply waits to run, is not answered from before their joining", async () => {
    const w = await world();
    await privateThings(w);
    const line = await newcomerJoins(w);
    const older = await say(w.m, w.g, "@helper_bot 周末停水的事你记得吗？");
    // Every member is told the Agent is replying: the newcomer can watch for the moment.
    expect((await runsOf(w.agent.id, w.g)).map((r) => r.status)).toEqual(["queued"]);
    const slipped = await say(w.s, w.g, "我刚进群，大家最近有什么要注意的吗？");

    await answer("（回答老成员）");
    const call = lastCall();
    expectNoSecret(call);
    expect((await seqsShown(call, w.g)).shown).toEqual([older, slipped]);
    expect(await peopleAfter(w.g, line)).toEqual([older, slipped]);
    expect(await runsOf(w.agent.id, w.g)).toEqual([{ status: "done", error: null, lane: "others" }]);
  });

  it("the same for a reply nobody asked for that the newcomer's message rides on", async () => {
    const w = await world();
    await privateThings(w);
    const line = await newcomerJoins(w);
    const remark = await say(w.m, w.g, "周末好像要停水");
    judge.answer(byName({ 小助手: 0.95 }));
    const decided = await decideProactive({ db, judge, config: app.deps.config, log: app.log }, w.g, remark);
    expect(decided.runs).toHaveLength(1);
    for (const run of decided.runs) app.agentPort.announce(run);
    const slipped = await say(w.s, w.g, "我刚进群，大家最近有什么要注意的吗？");

    await answer("（主动说一句）");
    const call = lastCall();
    expectNoSecret(call);
    expect((await seqsShown(call, w.g)).shown).toEqual([remark, slipped]);
    expect(await peopleAfter(w.g, line)).toEqual([remark, slipped]);
    expect(await runsOf(w.agent.id, w.g)).toEqual([{ status: "done", error: null, lane: "proactive" }]);
  });

  it("control: an older member, or an Agent that joined later, writing while the reply waits does not move the line", async () => {
    const w = await world();
    const other = await mustCreateAgent(app, w.m2, { handle: "other_bot", name: "阿杰", intro: "擅长查资料", model: FAST, persona: "你是阿杰。" });
    const agentJoined = await joinedSeq(w.g, w.agent.id);
    await privateThings(w);
    // An Agent that joined after the private things, and a newcomer who says nothing.
    await addMember(w.m2, w.g, other.id);
    await newcomerJoins(w);
    await say(w.m2, w.g, "@other_bot 你好");
    await say(w.m, w.g, "@helper_bot 周末停水的事你记得吗？");
    // 阿杰's reply (queued first) is posted while the older member's reply waits; so is an older member's message.
    await answer("AGENT-GAP-10b 我在");
    await say(w.m2, w.g, "我也想知道");

    await answer("（回答老成员）");
    const call = lastCall();
    const sent = shownText(call);
    for (const secret of [SECRET.m, SECRET.m2, "AGENT-GAP-10b"]) expect([secret, sent.includes(secret)]).toEqual([secret, true]);
    expect((await seqsShown(call, w.g)).shown).toEqual(await peopleAfter(w.g, agentJoined));
  });
});

describe("whoever the reply hears from is recorded as it goes (fix round 2): each place what a run covers moves forward", () => {
  /** The askers recorded on the Agent's first run in the group. */
  const recordedAskers = async (agentId: string, conv: string): Promise<string[] | null> =>
    (await db.query<{ ids: string[] | null }>("select asker_ids as ids from agent_runs where agent_id = $1 and conversation_id = $2 order by created_at, id limit 1", [agentId, conv]))
      .rows[0]!.ids;

  it("begin: the newcomer writes without a mention while an older member's reply waits, and that reply calls another Agent — the newcomer is recorded on the reply, and both replies are cut at their joining", async () => {
    const w = await world();
    const other = await mustCreateAgent(app, w.m, { handle: "other_bot", name: "阿杰", intro: "擅长查资料", model: FAST, persona: "你是阿杰。" });
    await addMember(w.m, w.g, other.id);
    await privateThings(w);
    const line = await newcomerJoins(w);
    const asked = await say(w.m, w.g, "@helper_bot 你帮我问问阿杰，周末停水吗？");
    const slipped = await say(w.s, w.g, "我刚进群，大家最近有什么要注意的吗？");

    await answer("@other_bot 周末停水吗？");
    expect(await recordedAskers(w.agent.id, w.g)).toContain(w.s.id);
    await answer("不停水。");
    const calls = callsHere();
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expectNoSecret(call);
      expect((await seqsShown(call, w.g)).shown).toEqual([asked, slipped]);
    }
    expect(await peopleAfter(w.g, line)).toEqual([asked, slipped]);
  });

  it("the hand-down: the newcomer writes while the reply runs, before it calls another Agent — that Agent's reply is cut at their joining", async () => {
    const w = await world();
    const other = await mustCreateAgent(app, w.m, { handle: "other_bot", name: "阿杰", intro: "擅长查资料", model: FAST, persona: "你是阿杰。" });
    await addMember(w.m, w.g, other.id);
    await privateThings(w);
    const line = await newcomerJoins(w);
    const asked = await say(w.m, w.g, "@helper_bot 你帮我问问阿杰，周末停水吗？");
    const hold = gateway.hang();
    const running = app.agentWorker.runOnce();
    await hold.reached;
    const slipped = await say(w.s, w.g, "我刚进群，大家最近有什么要注意的吗？");
    hold.release("@other_bot 周末停水吗？");
    expect(await running).toBe(true);

    await answer("不停水。");
    const call = lastCall();
    expectNoSecret(call);
    expect((await seqsShown(call, w.g)).shown).toEqual([asked, slipped]);
    expect(await peopleAfter(w.g, line)).toEqual([asked, slipped]);
    expect((await runsOf(other.id, w.g)).map((r) => r.status)).toEqual(["done"]);
  });

  it("a mention folded into a waiting reply, with the newcomer's message before it: the newcomer counts", async () => {
    const w = await world();
    await privateThings(w);
    const line = await newcomerJoins(w);
    const older = await say(w.m, w.g, "@helper_bot 周末停水的事你记得吗？");
    const slipped = await say(w.s, w.g, "我刚进群，大家最近有什么要注意的吗？");
    const again = await say(w.m2, w.g, "@helper_bot 我也想知道");
    expect((await runsOf(w.agent.id, w.g)).map((r) => r.status)).toEqual(["queued"]);

    await answer("（一起回答）");
    const call = lastCall();
    expectNoSecret(call);
    expect((await seqsShown(call, w.g)).shown).toEqual([older, slipped, again]);
    expect(await peopleAfter(w.g, line)).toEqual([older, slipped, again]);
  });

  it("begin taking on a call noted after the reply was claimed, with the newcomer's message before it: the newcomer counts", async () => {
    const w = await world();
    await privateThings(w);
    const line = await newcomerJoins(w);
    const older = await say(w.m, w.g, "@helper_bot 周末停水的事你记得吗？");
    const slipped = await say(w.s, w.g, "我刚进群，大家最近有什么要注意的吗？");
    const later = await say(w.m2, w.g, "还有物业费的事");
    // As if `later` had been a call noted on the reply after its claim, before it began: begin takes it on.
    await db.query("update agent_runs set pending_seq = $2 where agent_id = $1 and status = 'queued'", [w.agent.id, later]);

    await answer("（回答）");
    const call = lastCall();
    expectNoSecret(call);
    expect((await seqsShown(call, w.g)).shown).toEqual([older, slipped, later]);
    expect(await peopleAfter(w.g, line)).toEqual([older, slipped, later]);
  });

  it("a follow-up answering a call noted while the reply ran, with the newcomer's message before it: the newcomer counts", async () => {
    const w = await world();
    await privateThings(w);
    const line = await newcomerJoins(w);
    const older = await say(w.m, w.g, "@helper_bot 周末停水的事你记得吗？");
    const hold = gateway.hang();
    const running = app.agentWorker.runOnce();
    await hold.reached;
    const slipped = await say(w.s, w.g, "我刚进群，大家最近有什么要注意的吗？");
    const noted = await say(w.m2, w.g, "@helper_bot 我也想知道");
    hold.release("（回答 mona）");
    expect(await running).toBe(true);

    await answer("（回答 mike）");
    const followUp = lastCall();
    expectNoSecret(followUp);
    expect((await seqsShown(followUp, w.g)).shown).toEqual([older, slipped, noted]);
    expect(await peopleAfter(w.g, line)).toEqual([older, slipped, noted]);
  });

  it("the owner's own calls recorded on the Agent's rate-limited reply (their own minute used up), the newcomer's message between them: the retry counts the newcomer", async () => {
    const w = await world();
    await privateThings(w);
    const line = await newcomerJoins(w);
    // The owner's own replies a minute used up (in the Agent's own conversation: none of them is in the group).
    await db.query(
      `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, triggered_by, lane, created_at, finished_at)
       select 'reply', $1, $2, $3, 'done', 1, 'human', 'own', now() - interval '30 seconds', now() - interval '29 seconds' from generate_series(1, $4)`,
      [w.agent.conversationId, w.agent.id, w.v.id, app.deps.config.agentRunsPerMinute],
    );
    const older = await say(w.v, w.g, "@helper_bot 周末停水的事你记得吗？");
    expect(await runsOf(w.agent.id, w.g)).toEqual([{ status: "failed", error: "rate_limited", lane: "own" }]);
    const slipped = await say(w.s, w.g, "我刚进群，大家最近有什么要注意的吗？");
    const again = await say(w.v, w.g, "@helper_bot 我也想知道");
    // The same row records the owner's second call.
    expect(await runsOf(w.agent.id, w.g)).toEqual([{ status: "failed", error: "rate_limited", lane: "own" }]);

    // The minute clears; the owner retries.
    await db.query("update agent_runs set created_at = created_at - interval '2 minutes' where agent_id = $1 and conversation_id = $2", [w.agent.id, w.agent.conversationId]);
    expect((await api(app, w.v, "POST", `/api/conversations/${w.g}/runs/retry`, { agentId: w.agent.id })).status).toBe(201);
    await answer("（重试的回答）");
    const call = lastCall();
    expectNoSecret(call);
    expect((await seqsShown(call, w.g)).shown).toEqual([older, slipped, again]);
    expect(await peopleAfter(w.g, line)).toEqual([older, slipped, again]);
  });

  it("a call noted on a claimed reply that is then released (failed, not followed up), with the newcomer's message before it: the owner's retry counts the newcomer", async () => {
    const w = await world();
    await privateThings(w);
    const line = await newcomerJoins(w);
    const older = await say(w.m, w.g, "@helper_bot 周末停水的事你记得吗？");
    const ticket = await app.agentPort.claimNext();
    const slipped = await say(w.s, w.g, "我刚进群，大家最近有什么要注意的吗？");
    const noted = await say(w.m2, w.g, "@helper_bot 我也想知道");
    expect(await app.agentPort.releaseRun(ticket!.id)).toBe(true);
    expect(await runsOf(w.agent.id, w.g)).toEqual([{ status: "failed", error: "provider_unavailable", lane: "others" }]);

    expect((await api(app, w.v, "POST", `/api/conversations/${w.g}/runs/retry`, { agentId: w.agent.id })).status).toBe(201);
    await answer("（重试的回答）");
    const call = lastCall();
    expectNoSecret(call);
    expect((await seqsShown(call, w.g)).shown).toEqual([older, slipped, noted]);
    expect(await peopleAfter(w.g, line)).toEqual([older, slipped, noted]);
  });
});

describe("what an Agent relays counts for whoever asked it (fix round 3)", () => {
  /** The newcomer's own Agent 小喇叭 (`@x_bot`), which repeats what it is asked, added to the group by them. */
  async function relayOf(w: World): Promise<{ id: string }> {
    const relay = await mustCreateAgent(app, w.s, { handle: "x_bot", name: "小喇叭", intro: "原样转述", model: FAST, persona: "你原样复述别人让你说的话。" });
    await addMember(w.s, w.g, relay.id);
    return relay;
  }

  it("the newcomer's own Agent, called before an older member's question, posts the newcomer's question while that reply waits: the reply is cut at the newcomer's joining", async () => {
    const w = await world();
    await privateThings(w);
    const line = await newcomerJoins(w);
    await relayOf(w);
    const toRelay = await say(w.s, w.g, "@x_bot 请原样说一遍：大家最近有什么要注意的吗？");
    const older = await say(w.m, w.g, "@helper_bot 周末停水吗？");
    // 小喇叭's run was queued first: it posts the question (no mention, nobody's new message) into the wait.
    await answer("大家最近有什么要注意的吗？");

    await answer("（回答 mona）");
    const call = lastCall();
    expectNoSecret(call);
    expect((await seqsShown(call, w.g)).shown).toEqual([toRelay, older]);
    expect(await peopleAfter(w.g, line)).toEqual([toRelay, older]);
  });

  it("the same through a reply nobody asked for, picked for an older member's remark", async () => {
    const w = await world();
    await privateThings(w);
    const line = await newcomerJoins(w);
    await relayOf(w);
    const toRelay = await say(w.s, w.g, "@x_bot 请原样说一遍：大家最近有什么要注意的吗？");
    const remark = await say(w.m, w.g, "周末好像要停水");
    judge.answer(byName({ 小助手: 0.95 }));
    const decided = await decideProactive({ db, judge, config: app.deps.config, log: app.log }, w.g, remark);
    expect(decided.runs).toHaveLength(1);
    for (const run of decided.runs) app.agentPort.announce(run);
    await answer("大家最近有什么要注意的吗？");

    await answer("（主动说一句）");
    const call = lastCall();
    expectNoSecret(call);
    expect((await seqsShown(call, w.g)).shown).toEqual([toRelay, remark]);
    expect(await peopleAfter(w.g, line)).toEqual([toRelay, remark]);
    expect((await runsOf(w.agent.id, w.g)).map((r) => r.lane)).toEqual(["proactive"]);
  });

  it("an Agent's message no run posted, while the reply waits: whose question it carries is not known — the latest joining of the people there now", async () => {
    const w = await world();
    const other = await mustCreateAgent(app, w.m2, { handle: "other_bot", name: "阿杰", intro: "擅长查资料", model: FAST, persona: "你是阿杰。" });
    await addMember(w.m2, w.g, other.id);
    await privateThings(w);
    const line = await newcomerJoins(w);
    const older = await say(w.m, w.g, "@helper_bot 周末停水吗？");
    await db.tx((t) => insertMessage(t, w.g, other.id, "text", { text: "大家最近有什么要注意的吗？" }, null));

    await answer("（回答 mona）");
    const call = lastCall();
    expectNoSecret(call);
    expect((await seqsShown(call, w.g)).shown).toEqual([older]);
    expect(await peopleAfter(w.g, line)).toEqual([older]);
  });

  it("a reply that calls nobody records nothing more when it is posted (what it heard is recorded only for what it hands down)", async () => {
    const w = await world();
    await privateThings(w);
    await newcomerJoins(w);
    await say(w.m, w.g, "@helper_bot 周末停水的事你记得吗？");
    const hold = gateway.hang();
    const running = app.agentWorker.runOnce();
    await hold.reached;
    await say(w.s, w.g, "我刚进群，大家最近有什么要注意的吗？");
    hold.release("（回答 mona）");
    expect(await running).toBe(true);
    const askers = (await db.query<{ ids: string[] }>("select asker_ids as ids from agent_runs where agent_id = $1 and conversation_id = $2", [w.agent.id, w.g])).rows[0]!.ids;
    expect(askers).toEqual([w.m.id]);
  });
});

describe("the calls shown from before the line, and the calls a follow-up or a retry carries (fix round 3)", () => {
  it("a call from before the line that carries a file is shown as its text only — not its file, not its name; a call after the line is shown whole", async () => {
    const w = await world();
    await sendFile(w.m2, w.g, FILE_NAME, SECRET.file, "application/octet-stream", "@helper_bot 帮我看看这份报告");
    await newcomerJoins(w);
    await say(w.s, w.g, "我刚进群，大家好");
    await sendFile(w.m, w.g, "AFTER-10b.txt", "AFTER-CONTENT-10b 一切正常", "application/octet-stream", "@helper_bot 也看看这份");
    expect((await runsOf(w.agent.id, w.g)).map((r) => r.status)).toEqual(["queued"]);

    await answer("（回答）");
    const call = lastCall();
    const m = markOf(call);
    expectNoSecret(call);
    expect(call.messages).toEqual([
      {
        role: "user",
        parts: [
          { type: "text", text: `〔${m} mike｜群成员〕@helper_bot 帮我看看这份报告` },
          { type: "text", text: `〔${m} sam｜群成员〕我刚进群，大家好` },
          { type: "text", text: `〔${m} mona｜群成员〕@helper_bot 也看看这份` },
          { type: "text", text: "[文件：AFTER-10b.txt]\nAFTER-CONTENT-10b 一切正常" },
        ],
      },
    ]);
  });

  it("a follow-up answering two noted calls, the earlier from before the newcomer joined: both calls are shown, nothing else from before the joining", async () => {
    const w = await world();
    await privateThings(w);
    await say(w.m, w.g, "@helper_bot 周末停水的事你记得吗？");
    const hold = gateway.hang();
    const running = app.agentWorker.runOnce();
    await hold.reached;
    const earlier = await say(w.m2, w.g, "@helper_bot 还有物业费呢？");
    const line = await newcomerJoins(w);
    const slipped = await say(w.s, w.g, "我刚进群，大家最近有什么要注意的吗？");
    const later = await say(w.m, w.g, "@helper_bot 再问一句，垃圾什么时候收？");
    hold.release("（回答 mona）");
    expect(await running).toBe(true);

    await answer("（回答后来的）");
    const followUp = lastCall();
    expectNoSecret(followUp);
    expect((await seqsShown(followUp, w.g)).shown).toEqual([earlier, slipped, later]);
    expect(await peopleAfter(w.g, line)).toEqual([slipped, later]);
  });

  it("a group retry of a reply that had an older member's call folded in from before the line: the retry shows that call too", async () => {
    const w = await world();
    await privateThings(w);
    const older = await say(w.m, w.g, "@helper_bot 周末停水的事你记得吗？");
    const line = await newcomerJoins(w);
    const asked = await say(w.s, w.g, QUESTION);
    gateway.fail("provider_unavailable");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(await runsOf(w.agent.id, w.g)).toEqual([{ status: "failed", error: "provider_unavailable", lane: "others" }]);

    expect((await api(app, w.v, "POST", `/api/conversations/${w.g}/runs/retry`, { agentId: w.agent.id })).status).toBe(201);
    await answer("（重试的回答）");
    const call = lastCall();
    expectNoSecret(call);
    expect((await seqsShown(call, w.g)).shown).toEqual([older, asked]);
    expect(await peopleAfter(w.g, line)).toEqual([asked]);
    // The calls it carries are a set (each once), not the failed run's appended to its own.
    const stored = await db.query<{ calls: string[] }>(
      "select call_seqs::text[] as calls from agent_runs where agent_id = $1 and conversation_id = $2 order by created_at desc, id desc limit 1",
      [w.agent.id, w.g],
    );
    expect(stored.rows[0]!.calls.map(Number)).toEqual([older, asked]);
  });
});

describe("the calls a reply answers are always shown; an asker who is not in the group now", () => {
  it("a newcomer who joined after the question and spoke before the reply began: the question is still answered — from itself and what came after the newcomer's joining", async () => {
    const w = await world();
    await privateThings(w);
    const older = await say(w.m, w.g, "@helper_bot 周末停水的事你记得吗？");
    const line = await newcomerJoins(w);
    const slipped = await say(w.s, w.g, "我刚进群，大家最近有什么要注意的吗？");

    await answer("（回答 mona）");
    const call = lastCall();
    expectNoSecret(call);
    expect((await seqsShown(call, w.g)).shown).toEqual([older, ...(await peopleAfter(w.g, line))]);
    expect(await peopleAfter(w.g, line)).toEqual([slipped]);
    expect(await runsOf(w.agent.id, w.g)).toEqual([{ status: "done", error: null, lane: "others" }]);
    const posted = (await api(app, w.m, "GET", `/api/conversations/${w.g}/messages`)).json.messages.at(-1);
    expect(posted).toMatchObject({ senderId: w.agent.id, text: "（回答 mona）" });
  });

  it("the asker asked, left and came back, nobody wrote since: their question is answered from itself alone", async () => {
    const w = await world();
    await privateThings(w);
    await newcomerJoins(w);
    await say(w.s, w.g, QUESTION);
    await leave(w.s, w.g);
    await newcomerJoins(w);

    await answer("（回答回来的人）");
    const call = lastCall();
    expect(call.messages).toEqual([{ role: "user", parts: [{ type: "text", text: `〔${markOf(call)} sam｜群成员〕${QUESTION}` }] }]);
    expect(await runsOf(w.agent.id, w.g)).toEqual([{ status: "done", error: null, lane: "others" }]);
  });

  it("older members' questions folded with a newcomer's: every question is shown, nothing else from before the newcomer's joining", async () => {
    const w = await world();
    await privateThings(w);
    const older = await say(w.m, w.g, "@helper_bot 周末停水的事你记得吗？");
    const folded = await say(w.m2, w.g, "@helper_bot 还有物业费呢？");
    const line = await newcomerJoins(w);
    const asked = await say(w.s, w.g, QUESTION);
    expect((await runsOf(w.agent.id, w.g)).map((r) => r.status)).toEqual(["queued"]);

    await answer("（一起回答）");
    const call = lastCall();
    expectNoSecret(call);
    expect((await seqsShown(call, w.g)).shown).toEqual([older, folded, asked]);
    expect(await peopleAfter(w.g, line)).toEqual([asked]);
  });

  it("a call that quotes something from before the line: the call is shown, its quote left out (as one the Agent cannot see)", async () => {
    const w = await world();
    const quoted = await say(w.m, w.g, "SECRET-QUOTED-10b 我们周六去吃火锅");
    await say(w.m2, w.g, "@helper_bot 这条怎么看？", { replyToSeq: quoted });
    await newcomerJoins(w);
    const slipped = "我刚进群，大家最近有什么要注意的吗？";
    await say(w.s, w.g, slipped);

    await answer("（回答 mike）");
    const call = lastCall();
    const m = markOf(call);
    expect(JSON.stringify(call)).not.toContain("SECRET-QUOTED-10b");
    expect(call.messages).toEqual([
      {
        role: "user",
        parts: [
          { type: "text", text: `〔${m} mike｜群成员〕@helper_bot 这条怎么看？` },
          { type: "text", text: `〔${m} sam｜群成员〕${slipped}` },
        ],
      },
    ]);
  });

  it("a reply none of whose calls its Agent can see (a run recorded as answering a notice): it ends quietly — no call, nothing failed, nothing to retry", async () => {
    const w = await world();
    await privateThings(w);
    await newcomerJoins(w);
    const notice = Number((await db.query<{ seq: string }>("select max(seq)::text as seq from messages where conversation_id = $1 and kind = 'system'", [w.g])).rows[0]!.seq);
    await db.query(
      `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, triggered_by, lane)
       values ('reply', $1, $2, $3, 'queued', $4, 'human', 'others')`,
      [w.g, w.agent.id, w.v.id, notice],
    );

    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(callsHere()).toEqual([]);
    expect(await runsOf(w.agent.id, w.g)).toEqual([{ status: "cancelled", error: null, lane: "others" }]);
    expect((await api(app, w.v, "POST", `/api/conversations/${w.g}/runs/retry`, { agentId: w.agent.id })).status).toBe(400);
  });

  it("an asker who is no longer in the group when the reply begins counts as not known: the latest joining among the group's people now", async () => {
    const w = await world();
    await privateThings(w);
    await newcomerJoins(w);
    await say(w.m, w.g, "BETWEEN-10b 欢迎新邻居");
    const later = await anotherJoins(w, "tina");
    const asked = await say(w.s, w.g, QUESTION);
    await leave(w.s, w.g);

    await answer("（回答已经走了的人）");
    const call = lastCall();
    expectNoSecret(call);
    expect(JSON.stringify(call)).not.toContain("BETWEEN-10b");
    expect((await seqsShown(call, w.g)).shown).toEqual([asked]);
    expect(await peopleAfter(w.g, later.line)).toEqual([asked]);
  });

  it("asks, is removed, others talk, is added back before the reply runs: nothing of the time away (nor before) but their own questions", async () => {
    const w = await world();
    await privateThings(w);
    await newcomerJoins(w);
    const first = await say(w.s, w.g, QUESTION);
    await removeMember(w.v, w.g, w.s.id);
    await say(w.m, w.g, "SECRET-GAP-10b 他不在，说点别的");
    const back = await newcomerJoins(w);
    const again = await say(w.s, w.g, "@helper_bot 我回来了，刚才的问题还在吗？");
    expect((await runsOf(w.agent.id, w.g)).map((r) => r.status)).toEqual(["queued"]);

    await answer("（回答回来的人）");
    const call = lastCall();
    expectNoSecret(call);
    expect(JSON.stringify(call)).not.toContain("SECRET-GAP-10b");
    // Both of its calls: the one from the first stay too (fix round 2, R3).
    expect((await seqsShown(call, w.g)).shown).toEqual([first, again]);
    expect(await peopleAfter(w.g, back)).toEqual([again]);
  });
});

describe("more of what reaches back, and more of who asked", () => {
  it("the Agent's own replies from before the line are not shown, nor one posted after it whose run answered what came before it", async () => {
    const w = await world();
    await privateThings(w);
    await say(w.m, w.g, "@helper_bot 记一下我下个月不在");
    await answer("REPLY-BEFORE-10b 记下了");
    await say(w.m2, w.g, "@helper_bot 也记一下我的");
    const line = await newcomerJoins(w);
    // Posted after the newcomer joined, answering a question from before.
    await answer("REPLY-COVERED-10b 也记下了");
    const asked = await say(w.s, w.g, QUESTION);

    await answer("（回答新来的）");
    const call = lastCall();
    expectNoSecret(call);
    for (const absent of ["REPLY-BEFORE-10b", "REPLY-COVERED-10b"]) expect([absent, JSON.stringify(call).includes(absent)]).toEqual([absent, false]);
    expect(call.messages.filter((m) => m.role === "assistant")).toEqual([]);
    expect((await seqsShown(call, w.g)).shown).toEqual(await peopleAfter(w.g, line));
    expect((await seqsShown(call, w.g)).shown).toEqual([asked]);
  });

  it("a chain of two hops the newcomer started (小助手 → 阿杰 → 小助手): every reply in it is cut at the newcomer's joining", async () => {
    const w = await world();
    const other = await mustCreateAgent(app, w.m, { handle: "other_bot", name: "阿杰", intro: "擅长查资料", model: FAST, persona: "你是阿杰。" });
    await addMember(w.m, w.g, other.id);
    await privateThings(w);
    const line = await newcomerJoins(w);
    const welcome = await say(w.m, w.g, "欢迎新邻居");
    // Someone joins later still: a chain that lost its asker would be cut at their joining instead.
    await anotherJoins(w, "tina");
    const asked = await say(w.s, w.g, "@helper_bot 你帮我问问阿杰，大家最近有什么要注意的？");

    await answer("@other_bot 最近群里有什么要注意的吗？");
    await answer("@helper_bot 没什么特别的。");
    await answer("好的，谢谢阿杰。");
    const calls = callsHere();
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expectNoSecret(call);
      expect((await seqsShown(call, w.g)).shown).toEqual([welcome, asked]);
    }
    expect(await peopleAfter(w.g, line)).toEqual([welcome, asked]);
    expect((await runsOf(w.agent.id, w.g)).map((r) => r.status)).toEqual(["done", "done"]);
    expect((await runsOf(other.id, w.g)).map((r) => r.status)).toEqual(["done"]);
  });

  it("two newcomers' mentions folded into one reply: the later joining is the line", async () => {
    const w = await world();
    await privateThings(w);
    await newcomerJoins(w);
    await say(w.m, w.g, "BETWEEN-10b 欢迎新邻居");
    const later = await anotherJoins(w, "tina");
    const first = await say(w.s, w.g, QUESTION);
    const second = await say(later.who, w.g, "@helper_bot 我也刚进群，有什么要注意的？");
    expect((await runsOf(w.agent.id, w.g)).map((r) => r.status)).toEqual(["queued"]);

    await answer("（回答两位新来的）");
    const call = lastCall();
    expectNoSecret(call);
    expect(JSON.stringify(call)).not.toContain("BETWEEN-10b");
    expect((await seqsShown(call, w.g)).shown).toEqual([first, second]);
    expect(await peopleAfter(w.g, later.line)).toEqual([first, second]);
  });

  it("a quote, after the line, of a file or an image sent before it: nothing of it is shown — not its name, not its label; an older member's question shows both", async () => {
    const w = await world();
    const file = await sendFile(w.m2, w.g, FILE_NAME, SECRET.file);
    const image = await sendImage(w.m2, w.g, "SECRET-PHOTO-10b.png");
    await newcomerJoins(w);
    await say(w.m, w.g, "看这个文件", { replyToSeq: file });
    await say(w.m, w.g, "看这张图", { replyToSeq: image });
    await say(w.s, w.g, QUESTION);

    await answer("（回答新来的）");
    const toNewcomer = lastCall();
    const m = markOf(toNewcomer);
    expectNoSecret(toNewcomer);
    for (const absent of ["SECRET-PHOTO-10b", "[文件：", "[图片："]) expect([absent, JSON.stringify(toNewcomer).includes(absent)]).toEqual([absent, false]);
    expect(toNewcomer.messages).toEqual([
      {
        role: "user",
        parts: [
          { type: "text", text: `〔${m} mona｜群成员〕看这个文件` },
          { type: "text", text: `〔${m} mona｜群成员〕看这张图` },
          { type: "text", text: `〔${m} sam｜群成员〕${QUESTION}` },
        ],
      },
    ]);

    await say(w.m, w.g, "@helper_bot 上面引用的是什么？");
    await answer("（回答老成员）");
    const toMember = shownText(lastCall());
    expect(toMember).toContain(`> [文件：${FILE_NAME}]\n看这个文件`);
    expect(toMember).toContain("> [图片：SECRET-PHOTO-10b.png]\n看这张图");
  });

  it("an image sent before the line, with a model that sees images: not sent for the newcomer's question; sent for an older member's", async () => {
    const w = await world();
    expect((await api(app, w.v, "PATCH", `/api/agents/${w.agent.id}`, { model: { source: "site", id: "thinker" } })).status).toBe(200);
    await grant(db, w.v.id, 5_000_000n); // a paid-tier model needs a balance
    await sendImage(w.m2, w.g, "SECRET-PHOTO-10b.png");
    await newcomerJoins(w);
    await say(w.s, w.g, QUESTION);

    await answer("（回答新来的）");
    expect(filesSent(lastCall())).toEqual([]);
    expect(JSON.stringify(lastCall())).not.toContain("SECRET-PHOTO-10b");

    await say(w.m, w.g, "@helper_bot 上面那张图是什么？");
    await answer("（回答老成员）");
    expect(filesSent(lastCall()).map((p) => p.type)).toEqual(["image"]);
  });

  it("a reply nobody asked for, taken over by the newcomer's mention while it waits: cut at the newcomer's joining", async () => {
    const w = await world();
    await privateThings(w);
    const line = await newcomerJoins(w);
    const remark = await say(w.m, w.g, "周末好像要停水");
    judge.answer(byName({ 小助手: 0.95 }));
    const decided = await decideProactive({ db, judge, config: app.deps.config, log: app.log }, w.g, remark);
    expect(decided.runs).toHaveLength(1);
    for (const run of decided.runs) app.agentPort.announce(run);
    const asked = await say(w.s, w.g, QUESTION);

    await answer("（回答新来的）");
    const call = lastCall();
    expectNoSecret(call);
    expect((await seqsShown(call, w.g)).shown).toEqual([remark, asked]);
    expect(await peopleAfter(w.g, line)).toEqual([remark, asked]);
    expect(await runsOf(w.agent.id, w.g)).toEqual([{ status: "done", error: null, lane: "others" }]);
  });

  it("the owner retrying a failed reply the newcomer asked for: the retry answers the same asker, cut at the newcomer's joining", async () => {
    const w = await world();
    await privateThings(w);
    const line = await newcomerJoins(w);
    const welcome = await say(w.m, w.g, "欢迎新邻居");
    // Someone joins later still: a retry that lost its asker would be cut at their joining instead.
    await anotherJoins(w, "tina");
    const asked = await say(w.s, w.g, QUESTION);
    gateway.fail("provider_unavailable");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(await runsOf(w.agent.id, w.g)).toEqual([{ status: "failed", error: "provider_unavailable", lane: "others" }]);

    const retried = await api(app, w.v, "POST", `/api/conversations/${w.g}/runs/retry`, { agentId: w.agent.id });
    expect(retried.status).toBe(201);
    await answer("（重试的回答）");
    const call = lastCall();
    expectNoSecret(call);
    expect((await seqsShown(call, w.g)).shown).toEqual([welcome, asked]);
    expect(await peopleAfter(w.g, line)).toEqual([welcome, asked]);
  });
});

// --- unchanged ---------------------------------------------------------------------------------------------------------

describe("what the rule does not change", () => {
  it("a question from a member who joined before the Agent, with a newcomer in the group, shows exactly what it showed: everything since the Agent joined", async () => {
    const w = await world();
    await privateThings(w);
    await newcomerJoins(w);
    await say(w.v, w.g, "@helper_bot 帮大家总结一下");
    await answer("（总结）");
    const call = lastCall();
    const m = markOf(call);
    expect(call.messages).toEqual([
      {
        role: "user",
        parts: [
          { type: "text", text: `〔${m} mona｜群成员〕${SECRET.m}` },
          { type: "text", text: `〔${m} mike｜群成员〕${SECRET.m2}` },
          { type: "text", text: `〔${m} mike｜群成员〕` },
          { type: "text", text: `[文件：${FILE_NAME}]\n${SECRET.file}` },
          { type: "text", text: `〔${m} vivi｜你的主人〕@helper_bot 帮大家总结一下` },
        ],
      },
    ]);
  });

  it("the Agent's own conversation with its owner is as it was", async () => {
    const w = await world();
    await privateThings(w);
    await newcomerJoins(w);
    await say(w.v, w.agent.conversationId, "私下问一句：群里谁最近不方便？");
    await answer("我不清楚。");
    await say(w.v, w.agent.conversationId, "好的");
    await answer("嗯。");
    expect(lastCall().messages).toEqual([
      { role: "user", parts: [{ type: "text", text: "私下问一句：群里谁最近不方便？" }] },
      { role: "assistant", parts: [{ type: "text", text: "我不清楚。" }] },
      { role: "user", parts: [{ type: "text", text: "好的" }] },
    ]);
  });
});
