// @vitest-environment jsdom
// Agent social, A11b: the 「别人」 tab of an Agent's page: the one question and its three answers, the dry run before a save that would end
// accesses, the people in, the requests, and 「它和别人的对话」 (only the conversations I watch for this Agent).
import "./markdown-ready.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { ANN, A1, AG1, BO, MODELS, PRINCIPALS, agentConv, agentOf, agentPrincipal, syncOf, usageOf, wire } from "./fixtures.js";
import { button, click, dialog, flush, inMain, installBrowser, openApp, toastText } from "./harness.jsx";
import { POLICY_OPTIONS, POLICY_QUESTION } from "../src/pages/AgentOthers.jsx";

beforeEach(installBrowser);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const AGX = "00000000-0000-4000-8000-0000000000b7"; // another Agent of mine
const sid = (n) => `00000000-0000-4000-8000-${String(2000 + n).padStart(12, "0")}`;
const watched = (n, agentId, other = ANN, fields = {}) => ({
  id: sid(n),
  type: "agent_social",
  title: null,
  myRole: "observer",
  closed: false,
  canSend: { ok: true },
  social: { participants: [agentId, other], agents: [{ id: agentId, ownerId: "00000000-0000-4000-8000-0000000000a1" }] },
  members: [
    { id: other, role: "speaker", isCreator: false },
    { id: agentId, role: "speaker", isCreator: false },
    { id: "00000000-0000-4000-8000-0000000000a1", role: "observer", isCreator: false },
  ],
  lastSeq: 1,
  readSeq: 1,
  unread: 0,
  ...fields,
});
const subject = (id, name, handle) => ({ id, handle, displayName: name, avatarVersion: 0, kind: "human" });
const contactsOf = (over = {}) => ({
  policy: "ask",
  picked: false,
  picks: [],
  rows: [
    { subject: subject(ANN, "小安", "ann"), state: "live", basis: "approved", since: "2026-11-16T00:00:00Z", until: null, endReason: null, conversationId: sid(1) },
    { subject: subject(BO, "阿波", "bob"), state: "requested", basis: null, since: "2026-11-16T00:00:00Z", until: "2026-11-23T12:00:00.000Z", endReason: null, conversationId: null },
    { subject: subject("00000000-0000-4000-8000-0000000000e9", "旧人", "old"), state: "ended", basis: null, since: "2026-11-01T00:00:00Z", until: null, endReason: "left", conversationId: null },
  ],
  conversations: [],
  ...over,
});

const rail = (name) => within(screen.getByRole("navigation", { name: "主导航" })).getByRole("button", { name });
async function openTab({ contacts = contactsOf(), convs = [], api = {}, friends = [] } = {}) {
  const agents = [agentOf(AG1, { intro: "陪你规划旅行", model: { source: "site", id: "free-1" } })];
  const principals = [...PRINCIPALS, agentPrincipal(AG1)];
  const lane = {
    getAgentContacts: vi.fn(async () => structuredClone(contacts)),
    putContactPolicy: vi.fn(async () => ({ ends: 0 })),
    approveAgentContact: vi.fn(async () => ({ state: "live", conversationId: sid(2) })),
    declineAgentContact: vi.fn(async () => ({ ok: true })),
    removeAgentContact: vi.fn(async () => ({ ok: true })),
    ...api,
  };
  const app = await openApp({
    sync: () => ({ ...syncOf([agentConv(A1, AG1), ...convs], [wire(sid(1), 1, ANN, "你好")], principals), social: { enabled: true } }),
    social: { friends, incoming: [], outgoing: [], blocked: [], blockedBy: [] },
    api: { getModels: vi.fn(async () => MODELS), listProviders: vi.fn(async () => ({ providers: [] })), getUsage: vi.fn(async () => usageOf()), listAgents: vi.fn(() => new Promise(() => {})), ...lane },
    handlers: { agents: () => ({ agents }), models: () => MODELS },
  });
  fireEvent.click(rail(/^Agent/));
  await flush();
  await click(within(document.querySelector(".list-col")).getByText("小助手", { selector: ".row-name" }));
  await click(inMain().getByRole("tab", { name: "别人" }));
  return { ...app, lane };
}
const radio = (name) => within(inMain().getByRole("group", { name: POLICY_QUESTION })).getByRole("radio", { name });

describe("the question", () => {
  it("is 「谁可以添加它」 with the three answers worded as the plan has them, the service's setting chosen", async () => {
    await openTab({ contacts: contactsOf({ policy: "contacts" }) });
    expect(POLICY_QUESTION).toBe("谁可以添加它");
    expect(POLICY_OPTIONS.map(([, label]) => label)).toEqual(["需要我同意", "我的好友可以直接添加", "不让别人添加"]);
    for (const label of ["需要我同意", "我的好友可以直接添加", "不让别人添加"]) expect(radio(label)).toBeTruthy();
    expect(radio("我的好友可以直接添加").checked).toBe(true);
    expect(radio("需要我同意").checked).toBe(false);
  });

  it("under 「我的好友可以直接添加」, 「只让其中几位好友」 opens the checklist of my friends; the picks are sent", async () => {
    const friends = [
      { id: ANN, handle: "ann", displayName: "小安", avatarVersion: 0 },
      { id: BO, handle: "bob", displayName: "阿波", avatarVersion: 0 },
    ];
    const { lane } = await openTab({ friends });
    expect(screen.queryByLabelText("只让其中几位好友")).toBeNull();
    fireEvent.click(radio("我的好友可以直接添加"));
    await flush();
    fireEvent.click(screen.getByLabelText("只让其中几位好友"));
    await flush();
    const list = screen.getByRole("list", { name: "可以直接添加的好友" });
    fireEvent.click(within(list).getByLabelText("小安"));
    await flush();
    await click(button("保存"));
    expect(lane.putContactPolicy).toHaveBeenNthCalledWith(1, AG1, { policy: "contacts", picked: true, picks: [ANN], dryRun: true });
    expect(lane.putContactPolicy).toHaveBeenNthCalledWith(2, AG1, { policy: "contacts", picked: true, picks: [ANN] });
  });
});

describe("a save", () => {
  it("the dialog counts everyone it touches, also those whose request still waits, and says what happens to them (A-5 re-review)", async () => {
    const ends = (n) => ({ putContactPolicy: vi.fn(async () => ({ ends: n })) });
    await openTab({ api: ends(1) });
    fireEvent.click(radio("不让别人添加"));
    await flush();
    await click(button("保存"));
    expect(within(dialog()).getByRole("heading", { name: "这样会影响 1 个人" })).toBeTruthy();
    expect(within(dialog()).getByText("对方不能再和它聊天，也找不到它了。还在等你同意的申请会取消。")).toBeTruthy();
    cleanup();
    await openTab({ api: ends(3), contacts: contactsOf({ policy: "ask" }) });
    fireEvent.click(radio("我的好友可以直接添加"));
    await flush();
    await click(button("保存"));
    expect(within(dialog()).getByRole("heading", { name: "这样会影响 3 个人" })).toBeTruthy();
    expect(within(dialog()).getByText("他们不能再和它聊天。想再聊要重新申请，由你同意。")).toBeTruthy();
  });

  it("asks dryRun first; with 0 ends it saves at once, with no dialog", async () => {
    const { lane } = await openTab();
    expect(button("保存").disabled).toBe(true);
    fireEvent.click(radio("不让别人添加"));
    await flush();
    await click(button("保存"));
    expect(lane.putContactPolicy).toHaveBeenCalledTimes(2);
    expect(lane.putContactPolicy.mock.calls[0][1]).toEqual({ policy: "none", picked: false, picks: [], dryRun: true });
    expect(lane.putContactPolicy.mock.calls[1][1]).toEqual({ policy: "none", picked: false, picks: [] });
    expect(dialog()).toBeNull();
    expect(toastText()).toBe("已保存");
  });

  it("with 12 ends it asks first, in a dialog titled with the number, and nothing is written until 确定; 取消 writes nothing", async () => {
    const { lane } = await openTab({ api: { putContactPolicy: vi.fn(async (_id, body) => (body.dryRun ? { ends: 12 } : { ends: 12 })) } });
    fireEvent.click(radio("不让别人添加"));
    await flush();
    await click(button("保存"));
    expect(dialog()).not.toBeNull();
    expect(within(dialog()).getByRole("heading", { name: "这样会影响 12 个人" })).toBeTruthy();
    expect(lane.putContactPolicy).toHaveBeenCalledTimes(1);
    // For 不让别人添加 nobody can find it or ask again: the body does not promise a new request (A-5 review m1).
    expect(within(dialog()).getByText("他们不能再和它聊天，也找不到它了。还在等你同意的申请会取消。")).toBeTruthy();
    await click(within(dialog()).getByRole("button", { name: "取消" }));
    expect(dialog()).toBeNull();
    expect(lane.putContactPolicy).toHaveBeenCalledTimes(1);
    await click(button("保存"));
    await click(within(dialog()).getByRole("button", { name: "确定" }));
    expect(lane.putContactPolicy).toHaveBeenCalledTimes(3);
    expect(lane.putContactPolicy.mock.calls[2][1]).toEqual({ policy: "none", picked: false, picks: [] });
    expect(dialog()).toBeNull();
  });
});

describe("the people, the requests and the conversations", () => {
  it("lists who is in (移除) and the requests that wait (同意, 拒绝); an ended row is in neither", async () => {
    const { lane } = await openTab();
    const people = within(inMain().getByRole("list", { name: "已添加它的人" }));
    expect(people.getByText("小安")).toBeTruthy();
    expect(people.queryByText("旧人")).toBeNull();
    await click(people.getByRole("button", { name: "移除" }));
    expect(lane.removeAgentContact).toHaveBeenCalledWith(AG1, ANN);
    const requests = within(inMain().getByRole("list", { name: "申请" }));
    expect(requests.getByText("阿波")).toBeTruthy();
    await click(requests.getByRole("button", { name: "同意" }));
    expect(lane.approveAgentContact).toHaveBeenCalledWith(AG1, BO);
    await click(within(inMain().getByRole("list", { name: "申请" })).getByRole("button", { name: "拒绝" }));
    expect(lane.declineAgentContact).toHaveBeenCalledWith(AG1, BO);
  });

  it("「它和别人的对话」 lists only the conversations I watch for this Agent: not another Agent's, not one I speak in, not the Agent's own", async () => {
    const mine = watched(1, AG1, ANN);
    const another = watched(2, AGX, BO);
    const visiting = { ...watched(3, AGX, ANN), myRole: "speaker", social: { participants: ["00000000-0000-4000-8000-0000000000a1", AGX], agents: [{ id: AGX, ownerId: BO }] } };
    await openTab({ convs: [mine, another, visiting] });
    const list = inMain().getByRole("list", { name: "它和别人的对话" });
    expect(within(list).getAllByRole("button")).toHaveLength(1);
    expect(within(list).getByText("小安")).toBeTruthy();
    expect(within(list).getByText("小安：你好")).toBeTruthy();
  });

  it("with nothing yet, it says so; nothing of this is asked while the switch is off (the pill is not even there)", async () => {
    await openTab({ contacts: contactsOf({ rows: [] }) });
    expect(inMain().getByText("还没有人添加它。")).toBeTruthy();
    expect(inMain().getByText("没有等你同意的申请。")).toBeTruthy();
    expect(inMain().getByText("它还没有和别人聊过。")).toBeTruthy();
  });
});
