import { describe, expect, it } from "vitest";
import * as M from "../src/data/model.js";
import { toView, formatAt, formatMessageAt, formatMessageTitle, expiryText, formatPoints, replyPoints, namesAgent } from "../src/data/viewmodel.js";
import { ME } from "../src/data/identities.js";
import { convSubtitle, convTitle, entity, isAgent, lastPreview, myAgents, nameOf, ownerOf, publishBlock, senderName } from "../src/state/selectors.js";
import {
  A1,
  A2,
  AG1,
  AG2,
  ANN,
  BO,
  D1,
  G1,
  ME_ID,
  PRINCIPALS,
  agentConv,
  agentOf,
  agentPrincipal,
  at,
  direct,
  emptySocial,
  group,
  notice,
  range,
  runOf,
  syncOf,
  wire,
} from "./fixtures.js";

const NOW = new Date(2026, 10, 16, 12, 0).getTime();
const D2 = "00000000-0000-4000-8000-0000000000c3";

function model({ conversations, messages = [], social = emptySocial() }) {
  return M.applySocial(M.applySync(M.initial(), syncOf(conversations, messages)), social);
}

const pub = (id, handle, displayName) => ({ id, handle, displayName });

describe("people and identities", () => {
  it("shows the signed-in user under the alias id me, everyone else by id; agents is empty", () => {
    const v = toView(model({ conversations: [direct()] }), { now: NOW });
    expect(v.people[ME]).toMatchObject({ id: ME, kind: "person", name: "你", handle: "@me_one", displayName: "Mei", principalId: ME_ID });
    expect(v.people[ME_ID]).toBeUndefined();
    expect(v.people[ANN]).toMatchObject({ id: ANN, kind: "person", name: "小安", handle: "@ann", avatar: `/api/principals/${ANN}/avatar` });
    expect(v.agents).toEqual({});
    expect(v.account).toMatchObject({ id: ME_ID, handle: "me_one", displayName: "Mei" });
    expect(v.loaded).toBe(true);
  });

  it("adds people known only from /api/social", () => {
    const CAT = "00000000-0000-4000-8000-0000000000a7";
    const v = toView(model({ conversations: [], social: { ...emptySocial(), incoming: [{ id: "r1", principal: pub(CAT, "cat", "小猫"), createdAt: at(1), expiresAt: at(2) }] } }), { now: NOW });
    expect(v.people[CAT]).toMatchObject({ name: "小猫", handle: "@cat" });
  });
});

describe("conversations", () => {
  it("maps a direct chat to type human with me and the peer as members, no title, no admin", () => {
    const v = toView(model({ conversations: [direct(D1, ANN, { lastSeq: 2, unread: 1 })], messages: range(D1, 1, 2) }), { now: NOW });
    const c = v.convs[D1];
    expect(c).toMatchObject({ id: D1, type: "human", title: null, admin: null, unread: 1, cutoffs: {}, hold: null });
    expect(c.members).toEqual([ME, ANN]);
    expect(convTitle(v, c)).toBe("小安");
  });

  it("maps a group to type group with its title and the creator as admin", () => {
    const v = toView(model({ conversations: [group(G1, { creatorId: ANN, members: [{ id: ANN, role: "speaker", isCreator: true }, { id: ME_ID, role: "speaker", isCreator: false }, { id: BO, role: "speaker", isCreator: false }] })] }), { now: NOW });
    const c = v.convs[G1];
    expect(c).toMatchObject({ type: "group", title: "周末小组", admin: ANN });
    expect(c.members).toEqual([ANN, ME, BO]);
    expect(convSubtitle(v, c)).toBe("3 位真人");
  });

  it("orders by last activity; empty conversations by createdAt when present, else the service's order", () => {
    const v = toView(
      model({
        conversations: [
          direct(D1, ANN, { lastSeq: 1 }),
          group(G1, { lastSeq: 1 }),
          direct(D2, BO, { createdAt: at(30) }),
          { ...direct("00000000-0000-4000-8000-0000000000c4", BO), peerId: BO },
        ],
        messages: [wire(D1, 1, ANN, "a", { createdAt: at(10) }), wire(G1, 1, ANN, "b", { createdAt: at(20) })],
      }),
      { now: NOW },
    );
    expect(v.order).toEqual([D2, G1, D1, "00000000-0000-4000-8000-0000000000c4"]);
    expect(v.convs[G1].at).toBe("09:20");
  });

  it("a notice this client does not know shows nothing and is no activity: no jump up the list, no time change", () => {
    const base = [wire(D1, 1, ANN, "a", { createdAt: at(10) }), wire(G1, 1, ANN, "b", { createdAt: at(20) })];
    const unknown = notice(G1, 2, "以后才有的通知", { event: "from_the_future" });
    const v = toView(model({ conversations: [direct(D1, ANN, { lastSeq: 1 }), group(G1, { lastSeq: 2 })], messages: [wire(D1, 1, ANN, "a", { createdAt: at(50) }), base[1], { ...unknown, createdAt: at(55) }] }), { now: NOW });
    // D1 (09:50) is newer than G1's last visible message (09:20); the hidden notice at 09:55 does not lift G1.
    expect(v.order).toEqual([D1, G1]);
    expect(v.convs[G1].at).toBe("09:20");
  });

  it("formats times like the prototype: today HH:MM, 昨天, then dates", () => {
    expect(formatAt(new Date(2026, 10, 16, 8, 5).getTime(), NOW)).toBe("08:05");
    expect(formatAt(new Date(2026, 10, 15, 23, 0).getTime(), NOW)).toBe("昨天");
    expect(formatAt(new Date(2026, 2, 3, 10, 0).getTime(), NOW)).toBe("3月3日");
    expect(formatAt(new Date(2025, 2, 3, 10, 0).getTime(), NOW)).toBe("2025/3/3");
    expect(formatAt(null, NOW)).toBe("");
  });
});

describe("messages", () => {
  it("text, file, image and system messages in the prototype's shape", () => {
    const FILE = "00000000-0000-4000-8000-0000000000f1";
    const IMG = "00000000-0000-4000-8000-0000000000f2";
    const v = toView(
      model({
        conversations: [group(G1, { lastSeq: 4 })],
        messages: [
          notice(G1, 1, "Mei创建了群聊「周末小组」", { event: "group_created", actorId: ME_ID, title: "周末小组", memberIds: [ANN, BO] }),
          wire(G1, 2, ANN, "早上好"),
          wire(G1, 3, BO, "", { kind: "file", attachment: { id: FILE, name: "报告.pdf", size: 1234, inline: false } }),
          wire(G1, 4, ME_ID, "看这个", { kind: "file", attachment: { id: IMG, name: "a.png", size: 99, inline: true }, replyTo: { seq: 2, visible: true, senderId: ANN, text: "早上好", kind: "text" } }),
        ],
      }),
      { now: NOW },
    );
    const [sys, text, file, image] = v.convs[G1].messages;
    expect(sys).toMatchObject({ id: "m1", seq: 1, from: null, kind: "system", text: "你创建了群聊「周末小组」，并邀请小安、阿波加入", system: { event: "group_created", actorId: ME, memberIds: [ANN, BO] } });
    expect(text).toMatchObject({ id: "m2", from: ANN, kind: "text", text: "早上好", at: "09:02", status: "sent", replyTo: null, quote: null });
    expect(file).toMatchObject({ kind: "file", text: "报告.pdf", caption: "", attachment: { id: FILE, name: "报告.pdf", size: 1234, inline: false, url: `/api/attachments/${FILE}` } });
    expect(image).toMatchObject({ from: ME, kind: "image", text: "a.png", caption: "看这个", src: `/api/attachments/${IMG}`, replyTo: "m2" });
    expect(image.quote).toEqual({ seq: 2, visible: true, from: ANN, text: "早上好", kind: "text", attachmentName: null });
    expect(lastPreview(v, v.convs[G1])).toBe("你：[图片]");
  });

  it("system notices are rendered from their event with today's names (你 for me), else the service's sentence", () => {
    const CAT = "00000000-0000-4000-8000-0000000000a7";
    const ev = (seq, system, text = `服务端句子${seq}`) => notice(G1, seq, text, system);
    const many = Array.from({ length: 11 }, (_, i) => (i === 0 ? ANN : BO));
    const v = toView(
      model({
        conversations: [group(G1, { lastSeq: 15 })],
        messages: [
          ev(1, { event: "group_created", actorId: ANN, title: "周末小组", memberIds: [ME_ID, BO] }),
          ev(2, { event: "member_joined", actorId: ANN, principalId: BO }),
          ev(3, { event: "member_left", actorId: BO, principalId: BO, newCreatorId: null }),
          ev(4, { event: "member_left", actorId: ME_ID, principalId: ME_ID, newCreatorId: ANN }),
          ev(5, { event: "member_removed", actorId: ME_ID, principalId: BO }),
          ev(6, { event: "group_renamed", actorId: ANN, title: "新名字" }),
          ev(7, { event: "friendship_ended", actorId: ANN, principalId: ME_ID }),
          ev(8, { event: "friendship_restored", actorId: ME_ID, principalId: ANN }),
          ev(9, { event: "blocked", actorId: ANN, principalId: ME_ID }),
          ev(10, { event: "blocked", actorId: ME_ID, principalId: ANN }),
          ev(11, { event: "unblocked", actorId: ME_ID, principalId: ANN }),
          ev(12, { event: "something_later", actorId: ANN }, "以后才有的通知"),
          ev(13, { event: "member_joined", actorId: ANN, principalId: CAT }, "小安邀请小猫加入了群聊"),
          ev(14, { event: "group_renamed", actorId: ANN }, "名字缺了"),
          ev(15, { event: "group_created", actorId: ME_ID, title: "大群", memberIds: many }),
        ],
      }),
      { now: NOW },
    );
    expect(v.convs[G1].messages.map((m) => m.text)).toEqual([
      "小安创建了群聊「周末小组」，并邀请你、阿波加入",
      "小安邀请阿波加入了群聊",
      "阿波退出了群聊",
      "你退出了群聊，小安成为新的创建者",
      "你将阿波移出了群聊",
      "小安将群名改为「新名字」",
      "小安解除了与你的好友关系，双方不能再发送新消息，已有历史不受影响",
      "你和小安重新成为好友，可以继续发送消息",
      "小安拉黑了你，只能由对方解除。双方不能再发送新消息，已有历史不受影响",
      "你拉黑了小安。双方不能再发送新消息，已有历史不受影响",
      "你解除了对小安的拉黑",
      // an event this client does not know: nothing (batch 2C); someone nobody named here, a malformed event: the
      // service's sentence
      "",
      "小安邀请小猫加入了群聊",
      "名字缺了",
      `你创建了群聊「大群」，并邀请${["小安", ...Array(9).fill("阿波")].join("、")}等11人加入`,
    ]);
    expect(v.convs[G1].messages.filter((m) => m.hidden).map((m) => m.seq)).toEqual([12]);
  });

  it("the notices of Agents talking to each other in a group (batch 2C); an unknown event shows nothing and never fails", () => {
    const BOT = "00000000-0000-4000-8000-0000000000b9";
    const ev = (seq, system, text = `服务端句子${seq}`) => notice(G1, seq, text, system);
    const sync = syncOf(
      [group(G1, { lastSeq: 9 })],
      [
        ev(1, { event: "agent_chain_paused", actorId: ANN, limit: 30 }),
        ev(2, { event: "agents_halted", actorId: ANN }),
        ev(3, { event: "agents_halted", actorId: ME_ID }),
        ev(4, { event: "agent_budget_reached", actorId: ANN, agentId: BOT }),
        ev(5, { event: "agent_chain_paused", actorId: ANN }, "缺了上限"),
        ev(6, { event: "agent_budget_reached", actorId: ANN, agentId: "00000000-0000-4000-8000-0000000000ef" }, "不认识的 Agent"),
        ev(7, { event: "from_the_future", actorId: ANN, agentId: BOT, limit: 3 }, "以后才有的通知"),
        ev(8, { event: 42 }, "事件不是字符串"),
        ev(9, null, "没有事件"),
      ],
      [...PRINCIPALS, { ...agentPrincipal(BOT, "annbot", "安的助手"), ownerId: ANN }],
    );
    const v = toView(M.applySync(M.initial(), sync), { now: NOW });
    expect(v.convs[G1].messages.map((m) => [m.text, Boolean(m.hidden)])).toEqual([
      ["Agent 已连续对话 30 条，已暂停互相接话，有人发言后继续。", false],
      ["小安让 Agent 停止了接话", false],
      ["你让 Agent 停止了接话", false],
      ["安的助手已达到本次接话的点数上限，有人发言后继续。", false],
      ["缺了上限", false],
      ["不认识的 Agent", false],
      ["", true],
      ["事件不是字符串", false],
      ["没有事件", false],
    ]);
    // An unknown notice is never the list's preview line either.
    expect(lastPreview(v, { ...v.convs[G1], messages: v.convs[G1].messages.slice(0, 7) })).toBe("不认识的 Agent");
  });

  it("the notice that an Agent's daily budget for others' calls is used up names the Agent, and falls back for an unknown one", () => {
    const BOT = "00000000-0000-4000-8000-0000000000b9";
    const ev = (seq, system, text) => notice(G1, seq, text, system);
    const sync = syncOf(
      [group(G1, { lastSeq: 2 })],
      [
        ev(1, { event: "agent_daily_budget_reached", actorId: ANN, agentId: BOT }, "服务端句子1"),
        ev(2, { event: "agent_daily_budget_reached", actorId: ANN, agentId: "00000000-0000-4000-8000-0000000000ef" }, "不认识的 Agent"),
      ],
      [...PRINCIPALS, { ...agentPrincipal(BOT, "annbot", "安的助手"), ownerId: ANN }],
    );
    const v = toView(M.applySync(M.initial(), sync), { now: NOW });
    expect(v.convs[G1].messages.map((m) => [m.text, Boolean(m.hidden)])).toEqual([
      ["「安的助手」今天的额度已用完", false],
      ["不认识的 Agent", false],
    ]);
  });

  it("my Agent carries the daily budget for others' calls and today's spend as the service says them; absent stays absent", () => {
    const withBudget = (extra) =>
      toView(M.applyAgents(M.applySync(M.initial(), syncOf([agentConv(A1, AG1)], [], [...PRINCIPALS, agentPrincipal(AG1)])), [agentOf(AG1, extra)]), { now: NOW }).agents[AG1];
    expect(withBudget({ othersBudget: "35.5", othersSpentToday: "3.5" })).toMatchObject({ othersBudget: "35.5", othersSpentToday: "3.5" });
    expect(withBudget({ othersBudget: null, othersSpentToday: "0" })).toMatchObject({ othersBudget: null, othersSpentToday: "0" });
    expect(withBudget({})).not.toHaveProperty("othersBudget");
    expect(withBudget({})).not.toHaveProperty("othersSpentToday");
  });

  it("my Agent carries how it addresses me and the others as the service says them; absent stays absent (someone else's view has neither)", () => {
    const view = (extra) =>
      toView(M.applyAgents(M.applySync(M.initial(), syncOf([agentConv(A1, AG1)], [], [...PRINCIPALS, agentPrincipal(AG1)])), [agentOf(AG1, extra)]), { now: NOW }).agents[AG1];
    const entry = { principalId: ANN, kind: "human", handle: "ann", name: "小安", appellation: "安姐" };
    expect(view({ ownerAppellation: "老板", appellations: [entry] })).toMatchObject({ ownerAppellation: "老板", appellations: [entry] });
    expect(view({ ownerAppellation: null, appellations: [] })).toMatchObject({ ownerAppellation: null, appellations: [] });
    expect(view({})).not.toHaveProperty("ownerAppellation");
    expect(view({})).not.toHaveProperty("appellations");
  });

  it("a sender nobody has named here is 已退出的成员 (in the timeline and the list preview)", () => {
    const GONE = "00000000-0000-4000-8000-0000000000a9";
    const v = toView(model({ conversations: [group(G1, { lastSeq: 2 })], messages: [wire(G1, 1, ANN, "在吗"), wire(G1, 2, GONE, "我先走了")] }), { now: NOW });
    expect(senderName(v, v.convs[G1].messages[1].from)).toBe("已退出的成员");
    expect(senderName(v, ANN)).toBe("小安");
    expect(lastPreview(v, v.convs[G1])).toBe("已退出的成员：我先走了");
  });

  it("a quote the reader cannot see says so", () => {
    const v = toView(model({ conversations: [group(G1, { lastSeq: 9 })], messages: [wire(G1, 9, ANN, "re", { replyTo: { seq: 2, visible: false } })] }), { now: NOW });
    expect(v.convs[G1].messages[0]).toMatchObject({ replyTo: "m2", quote: { seq: 2, visible: false } });
  });

  it("my messages in a direct chat read 已读 up to peerReadSeq; groups never do", () => {
    const v = toView(
      model({
        conversations: [direct(D1, ANN, { lastSeq: 3, peerReadSeq: 2 }), group(G1, { lastSeq: 1 })],
        messages: [wire(D1, 1, ME_ID), wire(D1, 2, ME_ID), wire(D1, 3, ME_ID), wire(G1, 1, ME_ID)],
      }),
      { now: NOW },
    );
    expect(v.convs[D1].messages.map((m) => m.status)).toEqual(["read", "read", "sent"]);
    expect(v.convs[G1].messages[0].status).toBe("sent");
  });

  it("unsent messages follow the server's as sending or failed, with their clientTxn", () => {
    let m = model({ conversations: [direct(D1, ANN, { lastSeq: 1 })], messages: [wire(D1, 1, ANN)] });
    m = M.markSending(m, { clientTxn: "t1", conversationId: D1, text: "在吗", replyToSeq: 1, at: NOW - 60_000 });
    m = M.markSending(m, { clientTxn: "t2", conversationId: D1, text: "喂", at: NOW });
    m = M.markFailed(m, "t2", { code: "network_error", reason: null });
    const msgs = toView(m, { now: NOW }).convs[D1].messages;
    expect(msgs.map((x) => x.id)).toEqual(["m1", "tx:t1", "tx:t2"]);
    expect(msgs[1]).toMatchObject({ from: ME, kind: "text", text: "在吗", status: "sending", clientTxn: "t1", replyTo: "m1", quote: { seq: 1, visible: true, from: ANN, text: "m1" } });
    expect(msgs[2]).toMatchObject({ status: "failed", clientTxn: "t2", error: { code: "network_error", reason: null } });
  });

  it("hides a sending message once its pushed copy is held (no visible duplicate before the HTTP answer)", () => {
    let m = model({ conversations: [direct(D1, ANN, { lastSeq: 1 })], messages: [wire(D1, 1, ANN)] });
    m = M.markSending(m, { clientTxn: "t1", conversationId: D1, text: "hi", at: NOW });
    m = M.markSending(m, { clientTxn: "t2", conversationId: D1, text: "hi", at: NOW + 1 });
    m = M.applyMessage(m, wire(D1, 2, ME_ID, "hi")).state;
    const msgs = toView(m, { now: NOW }).convs[D1].messages;
    expect(msgs.map((x) => x.id)).toEqual(["m1", "m2", "tx:t2"]);
  });
});

describe("social: relations, blocks and the hold", () => {
  const social = {
    friends: [pub(ANN, "ann", "小安")],
    incoming: [{ id: "r-in", principal: pub(BO, "bo", "阿波"), createdAt: at(1), expiresAt: at(2) }],
    outgoing: [],
    blocked: [pub(BO, "bo", "阿波")],
    blockedBy: [pub(ANN, "ann", "小安")],
  };

  it("relations keyed subject|target and blocks as {by, target} with the me alias", () => {
    const v = toView(model({ conversations: [], social }), { now: NOW });
    expect(v.relations[`${ME}|${ANN}`]).toEqual({ status: "established" });
    expect(v.relations[`${BO}|${ME}`]).toMatchObject({ status: "incoming", requestId: "r-in", expiresAt: at(2) });
    expect(v.blocks).toEqual([
      { by: ME, target: BO },
      { by: ANN, target: ME },
    ]);
  });

  it("outgoing requests are pending from me", () => {
    const v = toView(model({ conversations: [], social: { ...emptySocial(), outgoing: [{ id: "r-out", principal: pub(BO, "bo", "阿波"), createdAt: at(1), expiresAt: at(2) }] } }), { now: NOW });
    expect(v.relations[`${ME}|${BO}`]).toMatchObject({ status: "pending", requestId: "r-out" });
  });

  it("hold carries the service's refusal with its real reason; publishBlock returns it", () => {
    const v = toView(
      model({
        conversations: [
          direct(D1, ANN, { canSend: { ok: false, reason: "blocked" } }),
          direct(D2, BO, { canSend: { ok: false, reason: "blocked" } }),
          direct("00000000-0000-4000-8000-0000000000c5", BO, { canSend: { ok: false, reason: "not_friends" } }),
          group(G1),
        ],
        social,
      }),
      { now: NOW },
    );
    expect(v.convs[D1].hold).toMatchObject({ kind: "block", reason: "blocked", pending: ["小安拉黑了你，只能由对方解除"] });
    expect(v.convs[D1].hold.text).toContain("小安拉黑了你，只能由对方解除");
    expect(v.convs[D2].hold).toMatchObject({ kind: "block", pending: ["你已拉黑 阿波"] });
    expect(v.convs["00000000-0000-4000-8000-0000000000c5"].hold).toMatchObject({ kind: "relation", reason: "not_friends" });
    expect(v.convs["00000000-0000-4000-8000-0000000000c5"].hold.text).toContain("对方已不是你的好友");
    // a block between members never stops a group in batch 1
    expect(v.convs[G1].hold).toBeNull();
    expect(publishBlock(v, v.convs[G1])).toBeNull();
    expect(publishBlock(v, v.convs[D1])).toBe(v.convs[D1].hold);
  });

  it("a send refused with cannot_send shows at once", () => {
    let m = model({ conversations: [direct(D1, ANN)], social: { ...emptySocial(), friends: [pub(ANN, "ann", "小安")] } });
    m = M.setCanSend(m, D1, { ok: false, reason: "not_friends" });
    expect(toView(m, { now: NOW }).convs[D1].hold.kind).toBe("relation");
  });
});

describe("Agents (batch 2A)", () => {
  const P1 = "00000000-0000-4000-8000-0000000000f7";
  function agentModel({ agents = [agentOf(AG1, { intro: "帮你做事", field: "整理", persona: "你是小助手。", personaVersion: 2, model: { source: "site", id: "free-1" }, reasoning: "low" })], conversations, messages = [], principals } = {}) {
    const sync = syncOf(
      conversations ?? [agentConv(A1, AG1, { lastSeq: messages.length, readSeq: messages.length }), direct(D1, ANN)],
      messages,
      principals ?? [...PRINCIPALS, agentPrincipal(AG1)],
    );
    return M.applyAgents(M.applySync(M.initial(), sync), agents);
  }

  it("an Agent conversation is the prototype's type agent, with me and the Agent as members and its own flags", () => {
    const v = toView(agentModel(), { now: NOW });
    expect(v.convs[A1]).toMatchObject({ id: A1, type: "agent", title: null, agentId: AG1, agent: { paused: false, deleted: false }, run: null, stream: null });
    expect(v.convs[A1].members).toEqual([ME, AG1]);
    expect(convTitle(v, v.convs[A1])).toBe("小助手");
    expect(v.convs[D1].type).toBe("human");
  });

  it("the Agent's row has what the prototype's Agents page reads, plus the new fields", () => {
    const v = toView(agentModel(), { now: NOW });
    expect(v.agents[AG1]).toMatchObject({
      id: AG1,
      kind: "agent",
      name: "小助手",
      handle: "@helper",
      intro: "帮你做事",
      field: "整理",
      role: "你是小助手。",
      privateReply: "收到消息时回复",
      paused: false,
      ownerId: ME,
      personaVersion: 2,
      model: { source: "site", id: "free-1" },
      reasoning: "low",
      deleted: false,
      conversationId: A1,
      avatar: `/api/principals/${AG1}/avatar`,
    });
    const mention = toView(agentModel({ agents: [agentOf(AG1, { replyMode: "mention", paused: true })] }), { now: NOW });
    expect(mention.agents[AG1]).toMatchObject({ privateReply: "仅在我点名时回复", paused: true });
    // The prototype's selectors see it as my Agent, not as a person.
    expect(v.people[AG1]).toBeUndefined();
    expect(isAgent(v, AG1)).toBe(true);
    expect(ownerOf(v, AG1)).toBe(ME);
    expect(nameOf(v, AG1)).toBe("小助手");
  });

  it("an Agent named only by /api/sync (its record not loaded yet) is still an Agent of mine", () => {
    const v = toView(M.applySync(M.initial(), syncOf([agentConv()], [], [...PRINCIPALS, agentPrincipal(AG1, "helper", "小助手")])), { now: NOW });
    expect(entity(v, AG1)).toMatchObject({ id: AG1, kind: "agent", name: "小助手", handle: "@helper", ownerId: ME });
  });

  it("every avatar URL of another principal carries its version (spec 6.11 item 1); mine as before", () => {
    const principals = [{ ...PRINCIPALS[0] }, { ...PRINCIPALS[1], avatarVersion: 3 }, { ...PRINCIPALS[2], avatarVersion: 0 }, { ...agentPrincipal(AG1), avatarVersion: 7 }];
    const sync = syncOf([agentConv(), direct(D1, ANN)], [], principals);
    let m = M.applySync(M.initial(), { ...sync, me: { ...sync.me, avatarVersion: 1 } });
    m = M.applyAgents(m, [agentOf(AG1, { avatarVersion: 7 })]);
    const v = toView(m, { now: NOW });
    expect(v.people[ANN].avatar).toBe(`/api/principals/${ANN}/avatar?v=3`);
    expect(v.people[BO].avatar).toBe(`/api/principals/${BO}/avatar`);
    expect(v.agents[AG1].avatar).toBe(`/api/principals/${AG1}/avatar?v=7`);
    expect(v.people[ME].avatar).toBe(`/api/principals/${ME_ID}/avatar?v=1`);
    expect(v.avatarVersions).toMatchObject({ [ANN]: 3, [AG1]: 7 });
  });

  it("Agent replies carry reasoning, stopped, truncated and the proposal; my messages read 已读 up to the Agent's marker", () => {
    const messages = [
      wire(A1, 1, ME_ID, "写一首诗"),
      wire(A1, 2, AG1, "床前明月光", { reasoning: "想一想", stopped: true }),
      wire(A1, 3, ME_ID, "继续"),
      wire(A1, 4, AG1, "长长的", { truncated: true }),
      wire(A1, 5, AG1, "我整理了一份设定，请查看并确认。", { proposal: { id: P1, status: "open", persona: "你是诗人。", intro: "写诗" } }),
    ];
    const v = toView(agentModel({ conversations: [agentConv(A1, AG1, { lastSeq: 5, readSeq: 5, peerReadSeq: 1 })], messages }), { now: NOW });
    const [mine, poem, again, long, card] = v.convs[A1].messages;
    expect(mine.status).toBe("read");
    expect(again.status).toBe("sent");
    expect(poem).toMatchObject({ from: AG1, text: "床前明月光", reasoning: "想一想", stopped: true, truncated: false, proposal: null });
    expect(long).toMatchObject({ truncated: true, stopped: false, reasoning: null });
    expect(card.proposal).toEqual({ id: P1, status: "open", persona: "你是诗人。", intro: "写诗" });
    expect(lastPreview(v, v.convs[A1])).toBe("我整理了一份设定，请查看并确认。");
  });

  it("the list's preview of an Agent's message is without its Markdown markers; a person's message is as written", () => {
    const reply = "## 三日行程\n\n- **第一天**：看 [西湖](https://example.com/west-lake)，带 `伞`";
    const agentLast = toView(agentModel({ conversations: [agentConv(A1, AG1, { lastSeq: 2, readSeq: 2 })], messages: [wire(A1, 1, ME_ID, "排一下"), wire(A1, 2, AG1, reply)] }), { now: NOW });
    expect(lastPreview(agentLast, agentLast.convs[A1])).toBe("三日行程 第一天：看 西湖，带 伞");
    const mineLast = toView(agentModel({ conversations: [agentConv(A1, AG1, { lastSeq: 2, readSeq: 2 })], messages: [wire(A1, 1, AG1, "好"), wire(A1, 2, ME_ID, reply)] }), { now: NOW });
    expect(lastPreview(mineLast, mineLast.convs[A1])).toBe(reply);
  });

  it("the run and the stream bubble of the conversation", () => {
    let m = agentModel();
    m = M.applyRun(m, A1, runOf("r1", "running"));
    m = M.applyDelta(m, { conversationId: A1, runId: "r1", reasoning: "嗯" });
    expect(toView(m, { now: NOW }).convs[A1]).toMatchObject({ run: { id: "r1", status: "running" }, stream: { runId: "r1", text: "", reasoning: "嗯" } });
    m = M.applyRun(m, A1, runOf("r1", "failed", { error: "no_quota", retryable: true, resetsAt: "2026-11-16T16:00:00.000Z" }));
    expect(toView(m, { now: NOW }).convs[A1]).toMatchObject({ run: { id: "r1", status: "failed", error: "no_quota", retryable: true, resetsAt: "2026-11-16T16:00:00.000Z" }, stream: null });
  });

  it("the new-topic notice is told with 你 and the Agent's name", () => {
    const messages = [notice(A1, 1, "Mei 开始了新话题，之前的对话不再发给 小助手", { event: "topic_reset", actorId: ME_ID })];
    const v = toView(agentModel({ conversations: [agentConv(A1, AG1, { lastSeq: 1, readSeq: 1 })], messages }), { now: NOW });
    expect(v.convs[A1].messages[0].text).toBe("你开始了新话题，之前的对话不再发给小助手");
  });

  it("a memory_changed notice reads 记忆已更新 and keeps its lines, vault marks and flags; in a group it is hidden", () => {
    const event = { event: "memory_changed", actorId: AG1, changeId: "c1", lines: ["记住了：不吃辣", "记住了：住上海"], vaultLines: [false, true], pending: false, unlock: false, full: true, status: "applied" };
    const messages = [notice(A1, 1, "记忆已更新", event)];
    const v = toView(agentModel({ conversations: [agentConv(A1, AG1, { lastSeq: 1, readSeq: 1 })], messages }), { now: NOW });
    const m = v.convs[A1].messages[0];
    expect(m.text).toBe("记忆已更新");
    expect(m.hidden).toBeUndefined();
    expect(m.system).toMatchObject({ changeId: "c1", lines: ["记住了：不吃辣", "记住了：住上海"], vaultLines: [false, true], pending: false, unlock: false, full: true, status: "applied" });
    // vaultLines absent → all false; malformed lines are dropped.
    const bare = [notice(A1, 1, "记忆已更新", { ...event, vaultLines: undefined, lines: ["a", 3, "b"] })];
    const b = toView(agentModel({ conversations: [agentConv(A1, AG1, { lastSeq: 1, readSeq: 1 })], messages: bare }), { now: NOW });
    expect(b.convs[A1].messages[0].system).toMatchObject({ lines: ["a", "b"], vaultLines: [false, false], sourceLines: [false, false] });
    // sourceLines (which lines are notes a merge joined) as the vault marks: kept when of the lines' length, else all false.
    const view = (fields) => toView(agentModel({ conversations: [agentConv(A1, AG1, { lastSeq: 1, readSeq: 1 })], messages: [notice(A1, 1, "记忆已更新", { ...event, ...fields })] }), { now: NOW }).convs[A1].messages[0].system;
    expect(view({ lines: ["合并了 2 条：x", "原来：a", "原来：b"], vaultLines: [false, false, true], sourceLines: [false, true, true] }).sourceLines).toEqual([false, true, true]);
    expect(view({ lines: ["合并了 2 条：x", "原来：a", 3, "原来：b"], sourceLines: [false, true, true, true] }).sourceLines).toEqual([false, true, true]);
    expect(view({ lines: ["合并了 2 条：x", "原来：a"], sourceLines: [true] }).sourceLines).toEqual([false, false]);
    expect(view({ lines: ["原来：a"], sourceLines: ["yes"] }).sourceLines).toEqual([false]);
    // In a group the notice has no Agent conversation: nothing is shown.
    const inGroup = [notice(G1, 1, "记忆已更新", event)];
    const g = toView(M.applySync(M.initial(), syncOf([group(G1, { lastSeq: 1, readSeq: 1 })], inGroup)), { now: NOW });
    expect(g.convs[G1].messages[0].hidden).toBe(true);
  });

  it("a deleted Agent's conversation can only be read, and says so", () => {
    const conversations = [agentConv(A2, AG2, { agent: { paused: false, deleted: true }, canSend: { ok: false, reason: "agent_deleted" } })];
    const v = toView(agentModel({ conversations, agents: [agentOf(AG2, { deleted: true, conversationId: A2 })], principals: [...PRINCIPALS, agentPrincipal(AG2)] }), { now: NOW });
    expect(v.convs[A2].hold).toMatchObject({ kind: "agentDeleted", reason: "agent_deleted", canRestore: false });
    expect(v.convs[A2].hold.text).toContain("已删除");
    expect(v.agents[AG2].deleted).toBe(true);
  });

  it("who may call my Agent in a group (groupMentions): members unless it says owner", () => {
    expect(toView(agentModel(), { now: NOW }).agents[AG1].groupMentions).toBe("members");
    expect(toView(agentModel({ agents: [agentOf(AG1, { groupMentions: "owner" })] }), { now: NOW }).agents[AG1].groupMentions).toBe("owner");
  });

  it("providers (public fields only), usage with points for display, site models and the provider defaults", () => {
    let m = M.applyProviders(M.initial(), [{ id: "p1", name: "我的", protocol: "anthropic", baseUrl: "https://a.example", keyLast4: "abcd", models: [] }]);
    m = M.applyUsage(m, {
      tier: "free",
      agentLimit: 20,
      agentCount: 2,
      balance: "1234.50",
      free: { allowance: "10", used: "2.250", resetsAt: "2026-11-16T16:00:00.000Z" },
      canStartFreeReply: true,
      recent: [{ agentId: AG1, model: "free-1", source: "site", points: "0.000001", replies: 3 }],
    });
    m = M.applyModels(m, { siteModels: [{ id: "free-1", label: "免费模型", tier: "free", vision: true, pdf: false, reasoning: [], contextTokens: 32000 }], providerDefaults: { contextTokens: 16000, maxOutputTokens: 2048 } });
    const v = toView(m, { now: NOW });
    expect(v.providers).toEqual({ p1: { id: "p1", name: "我的", protocol: "anthropic", baseUrl: "https://a.example", keyLast4: "abcd", models: [] } });
    expect(v.usage).toMatchObject({ balance: "1234.50", balanceText: "1,234.5", free: { allowanceText: "10", usedText: "2.25" }, recent: [{ pointsText: "0.000001" }] });
    expect(v.siteModels).toEqual([{ id: "free-1", label: "免费模型", tier: "free", vision: true, pdf: false, reasoning: [], contextTokens: 32000 }]);
    expect(v.providerDefaults).toEqual({ contextTokens: 16000, maxOutputTokens: 2048 });
    expect(toView(M.initial(), { now: NOW })).toMatchObject({ providers: {}, usage: null, siteModels: [], providerDefaults: null });
  });
});

describe("someone else's Agent in a group I am in (batch 2C)", () => {
  const OAG = "00000000-0000-4000-8000-0000000000b9";
  const STRANGER = "00000000-0000-4000-8000-0000000000ee";
  /** 小安's Agent as a co-member learns it: public fields and its owner, nothing else. */
  const annBot = (fields = {}) => ({ ...agentPrincipal(OAG, "annbot", "安的助手"), ownerId: ANN, intro: "帮小安记事", field: "记事", ...fields });
  const MEMBERS = [ME_ID, ANN, BO, OAG].map((id, i) => ({ id, role: "speaker", isCreator: i === 0 }));
  function sharedModel(principal = annBot(), { agents = [agentOf(AG1)] } = {}) {
    const sync = syncOf([agentConv(A1, AG1), group(G1, { members: MEMBERS })], [], [...PRINCIPALS, agentPrincipal(AG1), principal]);
    return M.applyAgents(M.applySync(M.initial(), sync), agents);
  }

  it("is an Agent with its real owner and its public fields only, and never one of my Agents", () => {
    const v = toView(sharedModel(), { now: NOW });
    expect(v.agents[OAG]).toMatchObject({ id: OAG, kind: "agent", name: "安的助手", handle: "@annbot", intro: "帮小安记事", field: "记事", ownerId: ANN, mine: false });
    for (const key of ["persona", "personaVersion", "model", "reasoning", "replyMode", "privateReply", "groupMentions", "chainBudget", "paused", "deleted", "conversationId"]) {
      expect(v.agents[OAG]).not.toHaveProperty(key);
    }
    expect(v.people[OAG]).toBeUndefined();
    expect(isAgent(v, OAG)).toBe(true);
    expect(ownerOf(v, OAG)).toBe(ANN);
    expect(nameOf(v, ownerOf(v, OAG))).toBe("小安");
    expect(v.agents[AG1]).toMatchObject({ ownerId: ME, mine: true });
    expect(myAgents(v).map((a) => a.id)).toEqual([AG1]);
  });

  it("never carries how an Agent addresses its owner and others, even if its entry says so", () => {
    const v = toView(sharedModel(annBot({ ownerAppellation: "老板", appellations: [{ principalId: ANN, appellation: "安姐" }] })), { now: NOW });
    expect(v.agents[OAG]).not.toHaveProperty("ownerAppellation");
    expect(v.agents[OAG]).not.toHaveProperty("appellations");
  });

  it("an owner nobody has named here is unknown (主人：未知); an Agent with no owner and no conversation of mine is not mine", () => {
    const stranger = toView(sharedModel(annBot({ ownerId: STRANGER })), { now: NOW });
    expect(ownerOf(stranger, OAG)).toBe(STRANGER);
    expect(nameOf(stranger, ownerOf(stranger, OAG))).toBe("未知");
    const { ownerId: _none, ...ownerless } = annBot();
    const unknown = toView(sharedModel(ownerless), { now: NOW });
    expect(ownerOf(unknown, OAG)).toBeNull();
    expect(nameOf(unknown, ownerOf(unknown, OAG))).toBe("未知");
    expect(myAgents(unknown).map((a) => a.id)).toEqual([AG1]);
  });

  it("an Agent whose principal names me as its owner is mine, also before its record is loaded", () => {
    const v = toView(sharedModel(annBot({ ownerId: ME_ID }), { agents: [] }), { now: NOW });
    expect(v.agents[OAG]).toMatchObject({ ownerId: ME, mine: true, loaded: false });
    expect(myAgents(v).map((a) => a.id).sort()).toEqual([AG1, OAG].sort());
  });

  it("a group's message keeps an Agent's thinking only when the Agent is mine: someone else's Agent's is not kept, whatever the message carries", () => {
    const members = [...MEMBERS, { id: AG1, role: "speaker", isCreator: false }];
    const messages = [
      wire(G1, 1, AG1, "我的回答", { reasoning: "我的思考" }),
      wire(G1, 2, OAG, "安的回答", { reasoning: "安的思考" }),
      wire(G1, 3, ANN, "人说的", { reasoning: "人不会有思考" }),
      wire(A1, 1, AG1, "专属会话里的回答", { reasoning: "专属会话里的思考" }),
    ];
    const sync = syncOf([agentConv(A1, AG1, { lastSeq: 1, readSeq: 1 }), group(G1, { members, lastSeq: 3, readSeq: 3 })], messages, [...PRINCIPALS, agentPrincipal(AG1), annBot()]);
    const v = toView(M.applyAgents(M.applySync(M.initial(), sync), [agentOf(AG1)]), { now: NOW });
    expect(v.convs[G1].messages.map((m) => [m.from, m.text, m.reasoning])).toEqual([
      [AG1, "我的回答", "我的思考"],
      [OAG, "安的回答", null],
      [ANN, "人说的", null],
    ]);
    expect(v.convs[A1].messages.map((m) => [m.text, m.reasoning])).toEqual([["专属会话里的回答", "专属会话里的思考"]]);
    // The list's preview is the reply's text, never its thinking.
    expect(lastPreview(v, v.convs[G1])).toBe("小安：人说的");
    const mineLast = toView(M.applyAgents(M.applySync(M.initial(), { ...sync, messages: messages.slice(0, 1) }), [agentOf(AG1)]), { now: NOW });
    expect(lastPreview(mineLast, mineLast.convs[G1])).toBe("小助手：我的回答");
    // An Agent nobody says is mine (its owner unknown, no conversation of mine with it) is not mine: its thinking is not kept.
    const { ownerId: _none, ...ownerless } = annBot();
    const unknown = toView(M.applySync(M.initial(), { ...sync, principals: [...PRINCIPALS, agentPrincipal(AG1), ownerless] }), { now: NOW });
    expect(unknown.convs[G1].messages[1].reasoning).toBeNull();
  });

  it("a reply's via (its model, level and points) is kept as its thinking is: on my own Agents' replies only, checked, never someone else's", () => {
    const SOL = { model: { source: "site", id: "gpt-6-sol", label: "GPT-6 Sol" }, reasoning: "medium", points: "6.9" };
    const PROV = { model: { source: "provider", model: "claude-x" }, reasoning: "none", points: "0" };
    const members = [...MEMBERS, { id: AG1, role: "speaker", isCreator: false }];
    const messages = [
      wire(G1, 1, AG1, "我的回答", { via: SOL }),
      wire(G1, 2, OAG, "安的回答", { via: PROV }),
      wire(G1, 3, ANN, "人说的", { via: SOL }),
      wire(G1, 4, AG1, "坏的", { via: { model: { source: "site", id: "x" }, reasoning: "medium", points: "1" } }),
      wire(G1, 5, AG1, "坏的级别", { via: { ...SOL, reasoning: "huge" } }),
      wire(G1, 6, AG1, "坏的点数", { via: { ...SOL, points: 7 } }),
      wire(G1, 7, AG1, "没有"),
      wire(A1, 1, AG1, "专属会话里的回答", { via: PROV }),
    ];
    const sync = syncOf([agentConv(A1, AG1, { lastSeq: 1, readSeq: 1 }), group(G1, { members, lastSeq: 7, readSeq: 7 })], messages, [...PRINCIPALS, agentPrincipal(AG1), annBot()]);
    const v = toView(M.applyAgents(M.applySync(M.initial(), sync), [agentOf(AG1)]), { now: NOW });
    expect(v.convs[G1].messages.map((m) => [m.seq, m.via])).toEqual([
      [1, SOL],
      [2, null],
      [3, null],
      [4, null],
      [5, null],
      [6, null],
      [7, null],
    ]);
    expect(v.convs[A1].messages.map((m) => m.via)).toEqual([PROV]);
    // An Agent nobody says is mine: nothing kept.
    const { ownerId: _none, ...ownerless } = annBot();
    const unknown = toView(M.applySync(M.initial(), { ...sync, principals: [...PRINCIPALS, agentPrincipal(AG1), ownerless] }), { now: NOW });
    expect(unknown.convs[G1].messages[1].via).toBeNull();
    // The list's preview is the reply's text.
    const mineLast = toView(M.applyAgents(M.applySync(M.initial(), { ...sync, messages: messages.slice(0, 1) }), [agentOf(AG1)]), { now: NOW });
    expect(lastPreview(mineLast, mineLast.convs[G1])).toBe("小助手：我的回答");
  });

  it("a reply's via keeps proactive only when it is strictly true, and only on my own Agents' replies", () => {
    const SOL = { model: { source: "site", id: "gpt-6-sol", label: "GPT-6 Sol" }, reasoning: "medium", points: "6.9" };
    const members = [...MEMBERS, { id: AG1, role: "speaker", isCreator: false }];
    const messages = [
      wire(G1, 1, AG1, "主动", { via: { ...SOL, proactive: true } }),
      wire(G1, 2, AG1, "假", { via: { ...SOL, proactive: false } }),
      wire(G1, 3, AG1, "字符串", { via: { ...SOL, proactive: "yes" } }),
      wire(G1, 4, AG1, "没有", { via: SOL }),
      wire(G1, 5, OAG, "别人的", { via: { ...SOL, proactive: true } }),
    ];
    const sync = syncOf([group(G1, { members, lastSeq: 5, readSeq: 5 })], messages, [...PRINCIPALS, agentPrincipal(AG1), annBot()]);
    const v = toView(M.applyAgents(M.applySync(M.initial(), sync), [agentOf(AG1)]), { now: NOW });
    expect(v.convs[G1].messages.map((m) => m.via)).toEqual([{ ...SOL, proactive: true }, SOL, SOL, SOL, null]);
    expect("proactive" in v.convs[G1].messages[1].via).toBe(false);
  });

  it("the group's subtitle counts the people, and the Agents when there are any", () => {
    const v = toView(sharedModel(), { now: NOW });
    expect(v.convs[G1].members).toEqual([ME, ANN, BO, OAG]);
    expect(convSubtitle(v, v.convs[G1])).toBe("3 位真人 · 1 个 Agent");
    const two = toView(M.applySync(M.initial(), syncOf([agentConv(A1, AG1), group(G1, { members: [...MEMBERS, { id: AG1, role: "speaker", isCreator: false }] })], [], [...PRINCIPALS, agentPrincipal(AG1), annBot()])), { now: NOW });
    expect(convSubtitle(two, two.convs[G1])).toBe("3 位真人 · 2 个 Agent");
    const none = toView(model({ conversations: [group(G1)] }), { now: NOW });
    expect(convSubtitle(none, none.convs[G1])).toBe("3 位真人");
  });
});

describe("formatPoints (points are decimal strings: no float maths)", () => {
  it("groups the digits and keeps every digit of the string", () => {
    expect(formatPoints("0")).toBe("0");
    expect(formatPoints("12.5")).toBe("12.5");
    expect(formatPoints("-0.75")).toBe("-0.75");
    expect(formatPoints("1234567.000001")).toBe("1,234,567.000001");
    expect(formatPoints("-1234")).toBe("-1,234");
    expect(formatPoints("123456789012345678901.5")).toBe("123,456,789,012,345,678,901.5");
  });
  it("trims trailing zeros after the decimal point", () => {
    expect(formatPoints("12.500")).toBe("12.5");
    expect(formatPoints("3.000")).toBe("3");
    expect(formatPoints("-0.000")).toBe("0");
  });
  it("leaves what is not a decimal string as it is", () => {
    expect(formatPoints("abc")).toBe("abc");
    expect(formatPoints(undefined)).toBe("");
    expect(formatPoints(null)).toBe("");
  });
});

describe("replyPoints (what one reply cost, under it: at most 4 decimals)", () => {
  it("keeps up to 4 decimals, rounding half up on the string's digits, trailing zeros trimmed, digits grouped", () => {
    expect(replyPoints("6.9")).toBe("6.9");
    expect(replyPoints("6.90")).toBe("6.9");
    expect(replyPoints("12")).toBe("12");
    expect(replyPoints("0.1234")).toBe("0.1234");
    expect(replyPoints("0.00073")).toBe("0.0007");
    expect(replyPoints("1.23456")).toBe("1.2346");
    expect(replyPoints("0.99995")).toBe("1");
    expect(replyPoints("9999.99999")).toBe("10,000");
    expect(replyPoints("0.00005")).toBe("0.0001");
    expect(replyPoints("1234.5")).toBe("1,234.5");
    expect(replyPoints("0")).toBe("0");
  });
  it("is empty for anything that is not a decimal string of points", () => {
    for (const bad of ["", "abc", "1e3", "-", "-1", ".5", "1.", null, undefined, 7]) expect(replyPoints(bad)).toBe("");
  });
});

describe("expiryText", () => {
  const iso = (ms) => new Date(ms).toISOString();
  it("rounds up to hours above an hour, to minutes within it", () => {
    expect(expiryText(iso(NOW + 24 * 3600_000), NOW)).toBe("24 小时内有效");
    expect(expiryText(iso(NOW + 23 * 3600_000 + 60_000), NOW)).toBe("24 小时内有效");
    expect(expiryText(iso(NOW + 3600_000 + 1), NOW)).toBe("2 小时内有效");
    expect(expiryText(iso(NOW + 3600_000), NOW)).toBe("60 分钟内有效");
    expect(expiryText(iso(NOW + 61_000), NOW)).toBe("2 分钟内有效");
    expect(expiryText(iso(NOW + 1000), NOW)).toBe("1 分钟内有效");
  });
  it("says expired at and after the expiry, and nothing for a missing or unreadable time", () => {
    expect(expiryText(iso(NOW), NOW)).toBe("已过期");
    expect(expiryText(iso(NOW - 5000), NOW)).toBe("已过期");
    expect(expiryText(undefined, NOW)).toBe("");
    expect(expiryText("soon", NOW)).toBe("");
  });

  it("formats a message bubble's time: clock today, 昨天 + clock, then date + clock with the year only for an earlier year", () => {
    const now = new Date(2026, 10, 17, 23, 30).getTime();
    const f = (...a) => formatMessageAt(new Date(...a).getTime(), now);
    expect(f(2026, 10, 17, 23, 5)).toBe("23:05");
    expect(f(2026, 10, 17, 0, 0)).toBe("00:00");
    expect(f(2026, 10, 16, 23, 59)).toBe("昨天 23:59");
    expect(f(2026, 10, 16, 0, 0)).toBe("昨天 00:00");
    expect(f(2026, 10, 15, 23, 59)).toBe("11月15日 23:59");
    expect(f(2026, 0, 1, 0, 7)).toBe("1月1日 00:07");
    expect(f(2025, 11, 31, 23, 5)).toBe("2025年12月31日 23:05");
    expect(formatMessageAt(null, now)).toBe("");
    // Just after midnight, the evening before is yesterday.
    const early = new Date(2026, 10, 17, 0, 1).getTime();
    expect(formatMessageAt(new Date(2026, 10, 16, 23, 5).getTime(), early)).toBe("昨天 23:05");
    // New Year's Day: the last day of last year is yesterday, then an earlier year.
    const ny = new Date(2026, 0, 1, 9, 0).getTime();
    expect(formatMessageAt(new Date(2025, 11, 31, 23, 5).getTime(), ny)).toBe("昨天 23:05");
    expect(formatMessageAt(new Date(2025, 11, 30, 23, 5).getTime(), ny)).toBe("2025年12月30日 23:05");
    // The conversation list's form is unchanged.
    expect(formatAt(new Date(2026, 10, 16, 23, 5).getTime(), now)).toBe("昨天");
  });

  it("formats a message bubble's tooltip with the weekday", () => {
    expect(formatMessageTitle(new Date(2026, 10, 17, 23, 5).getTime())).toBe("2026年11月17日 星期二 23:05");
    expect(formatMessageTitle(new Date(2025, 0, 5, 8, 9).getTime())).toBe("2025年1月5日 星期日 08:09");
    expect(formatMessageTitle(undefined)).toBe("");
  });
});

describe("the notice that an Agent was asked to be quiet (agent_quieted)", () => {
  it("names the Agent, and falls back for an unknown one", () => {
    const BOT = "00000000-0000-4000-8000-0000000000b9";
    const ev = (seq, system, text) => notice(G1, seq, text, system);
    const sync = syncOf(
      [group(G1, { lastSeq: 2 })],
      [
        ev(1, { event: "agent_quieted", actorId: ANN, agentId: BOT }, "服务端句子1"),
        ev(2, { event: "agent_quieted", actorId: ANN, agentId: "00000000-0000-4000-8000-0000000000ef" }, "不认识的 Agent"),
      ],
      [...PRINCIPALS, { ...agentPrincipal(BOT, "annbot", "安的助手"), ownerId: ANN }],
    );
    const v = toView(M.applySync(M.initial(), sync), { now: NOW });
    expect(v.convs[G1].messages.map((m) => [m.text, Boolean(m.hidden)])).toEqual([
      ["「安的助手」暂时不主动发言，需要时可以 @ 它", false],
      ["不认识的 Agent", false],
    ]);
  });
});

describe("mentions as the service stored them (Task M): the web reads no mention text", () => {
  it("a message carries its stored mentions that fit its text (a file's caption), my id as me; none from before, none on a notice", () => {
    const v = toView(
      model({
        conversations: [group(G1, { lastSeq: 4 })],
        messages: [
          wire(G1, 1, ANN, "@阿波 和 @Mei", { mentions: [{ id: BO, start: 0, length: 3 }, { id: ME_ID, start: 6, length: 4 }] }),
          wire(G1, 2, ANN, "@阿波 旧消息"),
          wire(G1, 3, ANN, "不合 @阿波", { mentions: [{ id: BO, start: 0, length: 3 }, { id: BO, start: 3, length: 3 }] }),
          { ...wire(G1, 4, ANN, "@阿波 看文件", { mentions: [{ id: BO, start: 0, length: 3 }] }), kind: "file", attachment: { id: "f1", name: "a.pdf", size: 1, inline: false } },
        ],
      }),
      { now: NOW },
    );
    expect(v.convs[G1].messages.map((m) => m.mentions)).toEqual([
      [
        { id: BO, start: 0, length: 3 },
        { id: ME, start: 6, length: 4 },
      ],
      [],
      [{ id: BO, start: 3, length: 3 }],
      [{ id: BO, start: 0, length: 3 }],
    ]);
  });

  it("namesAgent: whether a message's stored mentions mean the Agent (its own conversation, 仅在我点名时回复); the text is not read", () => {
    expect(namesAgent({ text: "@贾维斯 在吗", mentions: [{ id: AG1, start: 0, length: 4 }] }, AG1)).toBe(true);
    expect(namesAgent({ text: "@xiaolin.jarvis 在吗", mentions: [] }, AG1)).toBe(false);
    expect(namesAgent({ text: "@xiaolin.jarvis 在吗" }, AG1)).toBe(false);
    expect(namesAgent({ text: "@阿波", mentions: [{ id: BO, start: 0, length: 3 }] }, AG1)).toBe(false);
  });
});
