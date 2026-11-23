// @vitest-environment jsdom
// Creating and managing groups over the real data layer (fake transport and fake route API).
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
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
  apiError,
  at,
  deferred,
  direct,
  group,
  notice,
  syncOf,
  wire,
} from "./fixtures.js";
import {
  CY,
  DORA,
  EVE,
  PEOPLE,
  button,
  click,
  dialog,
  elapse,
  flush,
  inMain,
  installBrowser,
  mainText,
  openApp,
  push,
  rowNames,
  toastText,
} from "./harness.jsx";

const G2 = "00000000-0000-4000-8000-0000000000c4";

beforeEach(installBrowser);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Friends: 小安, 阿波, 朵拉, plus 伊芙 (I blocked her) and 小陈 (blocked me): the last two are never offered. */
const social = () => ({
  friends: [PEOPLE[ANN], PEOPLE[BO], PEOPLE[DORA], PEOPLE[EVE], PEOPLE[CY]],
  incoming: [],
  outgoing: [],
  blocked: [PEOPLE[EVE]],
  blockedBy: [PEOPLE[CY]],
});
const baseSync = () =>
  syncOf(
    [direct(D1, ANN, { lastSeq: 1, readSeq: 1 }), group(G1, { lastSeq: 1, readSeq: 1 })],
    [wire(D1, 1, ANN, "早"), wire(G1, 1, ANN, "大家好")],
  );
const MEMBER = (id, isCreator = false) => ({ id, role: "speaker", isCreator });
/** A group created by someone else: 小安 is the creator, I joined second, 阿波 third. */
const othersGroup = () =>
  syncOf(
    [direct(D1, ANN, { lastSeq: 1, readSeq: 1 }), group(G1, { creatorId: ANN, members: [MEMBER(ANN, true), MEMBER(ME_ID), MEMBER(BO)], lastSeq: 1, readSeq: 1 })],
    [wire(D1, 1, ANN, "早"), wire(G1, 1, ANN, "大家好")],
  );

const openChat = async (name) => click(screen.getByText(name, { selector: ".list-col .row-name" }));
const openMenuItem = async (name) => {
  fireEvent.click(button("新建"));
  await click(screen.getByRole("button", { name: new RegExp(name) }));
};
const dialogButton = (name) => within(dialog()).getByRole("button", { name });
const pickRow = (name) => within(dialog()).getByText(name, { selector: "label span" }).closest("label");
const setName = (value) => fireEvent.change(within(dialog()).getByLabelText("群名称"), { target: { value } });
const openProfile = async (name = "周末小组", tab = "群成员") => {
  await openChat(name);
  fireEvent.click(button("会话资料"));
  await flush();
  await click(within(document.querySelector(".side-col")).getByRole("button", { name: "打开群资料" }));
  if (tab !== "群成员") await click(screen.getByRole("tab", { name: tab }));
};
const memberRow = (name) => inMain().getByText(name, { selector: ".member-rows strong" }).closest("li");
/** Every distinct toast text, in order. */
function watchToasts() {
  const seen = [];
  const watch = new MutationObserver(() => {
    const text = toastText();
    if (text && text !== seen[seen.length - 1]) seen.push(text);
  });
  watch.observe(document.body, { childList: true, subtree: true, characterData: true });
  return { seen, stop: () => watch.disconnect() };
}

describe("starting a group", () => {
  it("offers my friends (never someone with a block in either direction), filtered by the search box", async () => {
    await openApp({ sync: baseSync, social: social() });
    await openMenuItem("发起群聊");
    const names = () => [...dialog().querySelectorAll("fieldset label small")].map((x) => x.parentElement.firstChild.textContent);
    expect(names()).toEqual(["小安", "阿波", "朵拉"]);
    expect(dialog().textContent).not.toMatch(/伊芙|小陈/);
    fireEvent.change(within(dialog()).getByLabelText("搜索好友"), { target: { value: "@do" } });
    expect(names()).toEqual(["朵拉"]);
    fireEvent.change(within(dialog()).getByLabelText("搜索好友"), { target: { value: "没有这个" } });
    expect(dialog().textContent).toContain("没有找到匹配的好友。");
  });

  it("with no friends there is nobody to pick, and nothing to create", async () => {
    const { api } = await openApp({ sync: baseSync });
    api.createGroup = vi.fn();
    await openMenuItem("发起群聊");
    expect(dialog().textContent).toContain("没有可以拉进群聊的好友。");
    setName("空群");
    await click(dialogButton("创建群聊"));
    expect(dialog().textContent).toContain("至少选择 2 位好友");
    expect(api.createGroup).not.toHaveBeenCalled();
  });

  it("needs a name of 1–60 characters and at least two friends before anything is sent", async () => {
    const createGroup = vi.fn(async () => ({ id: G2 }));
    await openApp({ sync: baseSync, social: social(), api: { createGroup } });
    await openMenuItem("发起群聊");
    await click(dialogButton("创建群聊"));
    expect(dialog().textContent).toContain("请输入群名称");
    expect(dialog().textContent).toContain("至少选择 2 位好友");

    setName("   ");
    fireEvent.click(within(pickRow("小安")).getByRole("checkbox"));
    await click(dialogButton("创建群聊"));
    expect(dialog().textContent).toContain("请输入群名称");
    expect(dialog().textContent).toContain("至少选择 2 位好友");

    setName("字".repeat(61));
    fireEvent.click(within(pickRow("阿波")).getByRole("checkbox"));
    await click(dialogButton("创建群聊"));
    expect(dialog().textContent).toContain("群名称最多 60 个字");
    expect(dialog().textContent).not.toContain("至少选择");
    expect(createGroup).not.toHaveBeenCalled();

    setName("\u200B\u2060"); // invisible: the service would refuse it
    await click(dialogButton("创建群聊"));
    expect(dialog().textContent).toContain("群名称需要包含看得见的文字");
    expect(createGroup).not.toHaveBeenCalled();

    setName("😀".repeat(60)); // 60 code points (120 UTF-16 units) is fine
    await click(dialogButton("创建群聊"));
    expect(createGroup).toHaveBeenCalledTimes(1);
  });

  it("creates the group with the trimmed name and the picked friends, then opens it once it is in state", async () => {
    const created = deferred();
    const createGroup = vi.fn(() => created.promise);
    const { env } = await openApp({ sync: baseSync, social: social(), api: { createGroup } });
    await openMenuItem("发起群聊");
    setName("  周日爬山  ");
    fireEvent.click(within(pickRow("小安")).getByRole("checkbox"));
    fireEvent.click(within(pickRow("朵拉")).getByRole("checkbox"));
    expect(dialog().textContent).toContain("已选 2 位");
    await click(dialogButton("创建群聊"));
    expect(createGroup).toHaveBeenCalledWith({ title: "周日爬山", memberIds: [ANN, DORA] });
    expect(dialogButton("创建中…").disabled).toBe(true);

    env.sync = () =>
      syncOf(
        [direct(D1, ANN, { lastSeq: 1, readSeq: 1 }), group(G1, { lastSeq: 1, readSeq: 1 }), group(G2, { title: "周日爬山", members: [MEMBER(ME_ID, true), MEMBER(ANN), MEMBER(DORA)], lastSeq: 1, readSeq: 1 })],
        [wire(D1, 1, ANN, "早"), wire(G1, 1, ANN, "大家好"), notice(G2, 1, "x", { event: "group_created", actorId: ME_ID, title: "周日爬山", memberIds: [ANN, DORA] })],
      );
    await act(async () => created.resolve({ id: G2 }));
    await flush();
    expect(dialog()).toBeNull();
    expect(rowNames()).toContain("周日爬山");
    expect(document.querySelector(".main-col .chat-head, .main-col header")?.textContent).toContain("周日爬山");
    expect(screen.getByLabelText("消息内容")).toBeTruthy();
    expect(mainText()).toContain("你创建了群聊「周日爬山」");
  });

  it("if the service pushes the group before the answer, it still opens", async () => {
    const created = deferred();
    const { env, transport } = await openApp({ sync: baseSync, social: social(), api: { createGroup: vi.fn(() => created.promise) } });
    await openMenuItem("发起群聊");
    setName("先到的推送");
    fireEvent.click(within(pickRow("小安")).getByRole("checkbox"));
    fireEvent.click(within(pickRow("阿波")).getByRole("checkbox"));
    await click(dialogButton("创建群聊"));
    env.sync = () => syncOf([direct(D1, ANN), group(G2, { title: "先到的推送", members: [MEMBER(ME_ID, true), MEMBER(ANN), MEMBER(BO)] })]);
    transport.handlers.conversation = () => group(G2, { title: "先到的推送", members: [MEMBER(ME_ID, true), MEMBER(ANN), MEMBER(BO)] });
    await push(transport, { type: "conversation", id: G2 });
    await flush();
    await act(async () => created.resolve({ id: G2 }));
    await flush();
    expect(screen.getByLabelText("消息内容")).toBeTruthy();
  });

  it.each([
    ["rate_limited", 429, "操作太频繁了，请稍等一分钟再试。"],
    ["forbidden", 403, "没能创建群聊：有人已不是你的好友、与你存在拉黑，或群成员超过 500 人。"],
    ["invalid_request", 400, "群名称需要 1–60 个字，并至少选择 2 位好友。"],
    ["busy", 503, "服务现在有点忙，请稍后再试。"],
    ["surprise", 500, "操作没有成功，请稍后再试。"],
  ])("a refusal (%s) is a Chinese toast and the dialog stays for another try", async (code, status, text) => {
    const createGroup = vi.fn(async () => Promise.reject(apiError(status, code)));
    await openApp({ sync: baseSync, social: social(), api: { createGroup } });
    await openMenuItem("发起群聊");
    setName("会失败的群");
    fireEvent.click(within(pickRow("小安")).getByRole("checkbox"));
    fireEvent.click(within(pickRow("阿波")).getByRole("checkbox"));
    await click(dialogButton("创建群聊"));
    expect(toastText()).toBe(text);
    expect(dialog()).not.toBeNull();
    expect(dialogButton("创建群聊").disabled).toBe(false);
  });
});

describe("the group page", () => {
  it("lists the members with a creator badge, and no Agent, owner, visibility or freeze content", async () => {
    await openApp({ sync: baseSync, social: social() });
    await openProfile();
    expect(inMain().getByText("共 3 位成员")).toBeTruthy();
    expect(memberRow("你").textContent).toContain("创建者");
    expect(memberRow("小安").textContent).not.toContain("创建者");
    expect(inMain().getAllByText("创建者")).toHaveLength(1);
    expect(screen.queryByText("已冻结")).toBeNull();
    for (const tab of ["群成员", "群设置"]) expect(screen.getByRole("tab", { name: tab })).toBeTruthy();
    await click(screen.getByRole("tab", { name: "群设置" }));
    expect(mainText()).not.toMatch(/Agent|主人|拉黑冲突|发布状态|冻结/);
    expect(mainText()).toContain("群创建者");
  });

  it("a block never freezes a human group: the page shows nothing about it", async () => {
    await openApp({ sync: baseSync, social: { ...social(), blocked: [PEOPLE[ANN]] } });
    await openProfile();
    expect(mainText()).not.toMatch(/冻结|拉黑冲突/);
    await click(screen.getByRole("tab", { name: "群设置" }));
    expect(mainText()).not.toMatch(/冻结|拉黑冲突/);
  });
});

describe("adding members", () => {
  it("offers only my friends who are not in the group and not blocked either way, and adds one", async () => {
    const addMember = vi.fn(async () => {
      env.sync = () =>
        syncOf(
          [direct(D1, ANN, { lastSeq: 1, readSeq: 1 }), group(G1, { members: [MEMBER(ME_ID, true), MEMBER(ANN), MEMBER(BO), MEMBER(DORA)], lastSeq: 2, readSeq: 1 })],
          [wire(D1, 1, ANN, "早"), wire(G1, 1, ANN, "大家好")],
        );
      return { ok: true };
    });
    const { env } = await openApp({ sync: baseSync, social: social(), api: { addMember } });
    await openProfile();
    await click(button("添加成员"));
    const names = () => [...dialog().querySelectorAll(".member-rows strong")].map((x) => x.textContent);
    expect(names()).toEqual(["朵拉"]);
    await click(within(dialog()).getByRole("button", { name: "添加" }));
    expect(addMember).toHaveBeenCalledWith(G1, DORA);
    expect(toastText()).toBe("已添加朵拉");
    // the refetched group has her now, so nobody is left to add
    expect(dialog().textContent).toContain("没有可以添加的好友或 Agent");
    fireEvent.click(dialogButton("完成"));
    await flush();
    expect(inMain().getByText("共 4 位成员")).toBeTruthy();
    expect(memberRow("朵拉")).toBeTruthy();
  });

  it("any member may add, not only the creator", async () => {
    await openApp({ sync: othersGroup, social: social() });
    await openProfile();
    expect(button("添加成员")).toBeTruthy();
  });

  it("the pending state shows while the request is in flight", async () => {
    const pending = deferred();
    await openApp({ sync: baseSync, social: social(), api: { addMember: vi.fn(() => pending.promise) } });
    await openProfile();
    await click(button("添加成员"));
    await click(within(dialog()).getByRole("button", { name: "添加" }));
    expect(within(dialog()).getByRole("button", { name: "添加中…" }).disabled).toBe(true);
    await act(async () => pending.resolve({ ok: true }));
    await flush();
  });

  it.each([
    ["already_member", 409, "对方已经在群里了。"],
    ["forbidden", 403, "没能添加：对方已不是你的好友、与你存在拉黑，或本群已满 500 人。"],
    ["not_found", 404, "你已不在这个群聊中。"],
    ["rate_limited", 429, "操作太频繁了，请稍等一分钟再试。"],
  ])("a refusal (%s) is a Chinese toast", async (code, status, text) => {
    await openApp({ sync: baseSync, social: social(), api: { addMember: vi.fn(async () => Promise.reject(apiError(status, code))) } });
    await openProfile();
    await click(button("添加成员"));
    await click(within(dialog()).getByRole("button", { name: "添加" }));
    expect(toastText()).toBe(text);
    expect(within(dialog()).getByRole("button", { name: "添加" }).disabled).toBe(false);
  });
});

describe("removing members", () => {
  it("only the creator sees 移除; it asks first, and then removes", async () => {
    const removeMember = vi.fn(async () => {
      env.sync = () => syncOf([direct(D1, ANN), group(G1, { members: [MEMBER(ME_ID, true), MEMBER(BO)], lastSeq: 2, readSeq: 1 })]);
      return { ok: true };
    });
    const { env } = await openApp({ sync: baseSync, social: social(), api: { removeMember } });
    await openProfile();
    expect(within(memberRow("你")).queryByRole("button", { name: "移除" })).toBeNull();
    await click(within(memberRow("小安")).getByRole("button", { name: "移除" }));
    expect(dialog().textContent).toContain("对方会立刻失去这个群聊的全部内容");
    await click(dialogButton("取消"));
    expect(removeMember).not.toHaveBeenCalled();
    await click(within(memberRow("小安")).getByRole("button", { name: "移除" }));
    await click(dialogButton("确认移除"));
    expect(removeMember).toHaveBeenCalledWith(G1, ANN);
    expect(toastText()).toBe("已将小安移出群聊");
    expect(dialog()).toBeNull();
    expect(inMain().getByText("共 2 位成员")).toBeTruthy();
  });

  it("a member who is not the creator has no remove or rename controls", async () => {
    await openApp({ sync: othersGroup, social: social() });
    await openProfile();
    expect(inMain().queryByRole("button", { name: "移除" })).toBeNull();
    await click(screen.getByRole("tab", { name: "群设置" }));
    expect(screen.queryByLabelText("群名称")).toBeNull();
    expect(mainText()).toContain("周末小组");
    expect(mainText()).toContain("小安");
    expect(screen.getByRole("button", { name: "退出本群" })).toBeTruthy();
  });

  it.each([
    ["forbidden", 403, "只有群的创建者可以移除成员。"],
    ["not_found", 404, "这位成员已经不在群里了。"],
    ["rate_limited", 429, "操作太频繁了，请稍等一分钟再试。"],
  ])("a refusal (%s) is a Chinese toast", async (code, status, text) => {
    await openApp({ sync: baseSync, social: social(), api: { removeMember: vi.fn(async () => Promise.reject(apiError(status, code))) } });
    await openProfile();
    await click(within(memberRow("小安")).getByRole("button", { name: "移除" }));
    await click(dialogButton("确认移除"));
    expect(toastText()).toBe(text);
    expect(dialog()).not.toBeNull();
  });
});

describe("Agents in a group (batch 2C)", () => {
  const AG3 = "00000000-0000-4000-8000-0000000000b3"; // an Agent of mine, already in the group
  const A3 = "00000000-0000-4000-8000-0000000000d3";
  const OAG = "00000000-0000-4000-8000-0000000000b9"; // 小安's Agent
  /** My Agents as `GET /api/agents` lists them: 小助手, 厨师 (deleted), 书记员. */
  const myBots = () => [
    agentOf(AG1, { createdAt: at(1) }),
    agentOf(AG2, { handle: "cook", name: "厨师", conversationId: A2, deleted: true, createdAt: at(2) }),
    agentOf(AG3, { handle: "scribe", name: "书记员", conversationId: A3, intro: "记下要点", createdAt: at(3) }),
  ];
  const bots = [
    { ...agentPrincipal(AG1), ownerId: ME_ID },
    { ...agentPrincipal(AG2, "cook", "厨师"), ownerId: ME_ID },
    { ...agentPrincipal(AG3, "scribe", "书记员"), ownerId: ME_ID, intro: "记下要点", field: "" },
    { ...agentPrincipal(OAG, "annbot", "安的助手"), ownerId: ANN, intro: "帮小安记事", field: "记事" },
  ];
  /** G1 with `members`, created by `creatorId`; my Agents' conversations; everyone named. */
  const withAgents = (members, creatorId = ME_ID) => () =>
    syncOf(
      [
        direct(D1, ANN, { lastSeq: 1, readSeq: 1 }),
        group(G1, { creatorId, members, lastSeq: 1, readSeq: 1 }),
        agentConv(A1, AG1),
        agentConv(A2, AG2, { agent: { paused: false, deleted: true }, canSend: { ok: false, reason: "agent_deleted" } }),
        agentConv(A3, AG3),
      ],
      [wire(D1, 1, ANN, "早"), wire(G1, 1, ANN, "大家好")],
      [...PRINCIPALS, ...bots],
    );
  /** I created it; 书记员 (mine) and 安的助手 (小安's) are in it. */
  const CREATED = [MEMBER(ME_ID, true), MEMBER(ANN), MEMBER(BO), MEMBER(AG3), MEMBER(OAG)];
  const handlers = { agents: () => ({ agents: myBots() }) };
  const listIn = (label) => within(dialog()).getByRole("list", { name: label });
  const namesIn = (label) => [...listIn(label).querySelectorAll("strong")].map((x) => x.textContent);

  it("添加成员 also offers my own Agents that are not deleted and not in the group, under 我的 Agent, added the same way", async () => {
    const addMember = vi.fn(async () => ({ ok: true }));
    await openApp({ sync: withAgents(CREATED), social: social(), api: { addMember }, handlers });
    await openProfile();
    expect(mainText()).toContain("只能添加你的好友和你自己的 Agent，和你有拉黑关系的人除外。群里最多 500 人。");
    await click(button("添加成员"));
    expect(namesIn("可添加的好友")).toEqual(["朵拉"]);
    expect(within(dialog()).getByRole("heading", { name: "我的 Agent" })).toBeTruthy();
    expect(namesIn("可添加的 Agent")).toEqual(["小助手"]);
    const row = listIn("可添加的 Agent").querySelector("li");
    expect(row.textContent).toContain("@helper");
    expect(within(row).getByText("Agent", { selector: ".tag" })).toBeTruthy();
    await click(within(row).getByRole("button", { name: "添加" }));
    expect(addMember).toHaveBeenCalledWith(G1, AG1);
    expect(toastText()).toBe("已添加小助手");
  });

  it("the Agent section is hidden when none is left; 'nobody to add' only when neither friends nor Agents are left", async () => {
    const members = [MEMBER(ME_ID, true), MEMBER(ANN), MEMBER(BO), MEMBER(DORA), MEMBER(AG3)];
    const addMember = vi.fn(async () => {
      env.sync = withAgents([...members, MEMBER(AG1)]);
      return { ok: true };
    });
    const { env } = await openApp({ sync: withAgents(members), social: social(), api: { addMember }, handlers });
    await openProfile();
    await click(button("添加成员"));
    expect(dialog().textContent).not.toContain("没有可以添加的好友或 Agent");
    expect(namesIn("可添加的 Agent")).toEqual(["小助手"]);
    await click(within(dialog()).getByRole("button", { name: "添加" }));
    expect(addMember).toHaveBeenCalledWith(G1, AG1);
    expect(within(dialog()).queryByRole("heading", { name: "我的 Agent" })).toBeNull();
    expect(within(dialog()).queryByRole("list", { name: "可添加的 Agent" })).toBeNull();
    expect(dialog().textContent).toContain("没有可以添加的好友或 Agent：你的好友都已在群里，或与你有拉黑关系，你的 Agent 也都已在群里。");
  });

  it("an Agent's row carries the Agent tag, its owner, and its intro · field; 共 N 位成员 counts everyone, the chat header people and Agents", async () => {
    await openApp({ sync: withAgents(CREATED), social: social(), handlers });
    await openChat("周末小组");
    const counts = document.querySelector(".main-col .chat-title .head-counts");
    expect([...counts.querySelectorAll("[aria-label]")].map((el) => [el.getAttribute("aria-label"), el.getAttribute("title"), el.textContent.trim()])).toEqual([["3 人", "3 人", "3"], ["2 个 Agent", "2 个 Agent", "2"]]);
    expect(counts.textContent).not.toMatch(/真人/);
    await openProfile();
    expect(inMain().getByText("共 5 位成员")).toBeTruthy();
    const theirs = memberRow("安的助手");
    expect(within(theirs).getByText("Agent", { selector: ".tag" })).toBeTruthy();
    expect(theirs.textContent).toContain("主人：小安");
    expect(theirs.textContent).toContain("@annbot");
    expect(theirs.textContent).toContain("帮小安记事 · 记事");
    expect(memberRow("书记员").textContent).toContain("主人：你");
    expect(memberRow("书记员").textContent).toContain("记下要点");
    expect(memberRow("小安").textContent).not.toMatch(/主人|Agent/);
    // 群资料 > 群成员: nobody is labelled a person (the creator's tag and the Agent's stay).
    expect(document.body.textContent).not.toContain("真人");
    expect(inMain().getAllByText("创建者").length).toBeGreaterThan(0);
  });

  it("移除: the creator sees it on everyone else, Agents included", async () => {
    await openApp({ sync: withAgents(CREATED), social: social(), handlers });
    await openProfile();
    for (const name of ["小安", "阿波", "书记员", "安的助手"]) expect(within(memberRow(name)).getByRole("button", { name: "移除" })).toBeTruthy();
    expect(within(memberRow("你")).queryByRole("button", { name: "移除" })).toBeNull();
  });

  it("an owner who is not the creator may remove their own Agent and nobody else (asked first); someone else's Agent has no 移除", async () => {
    const members = [MEMBER(ANN, true), MEMBER(ME_ID), MEMBER(BO), MEMBER(AG3), MEMBER(OAG)];
    const removeMember = vi.fn(async () => {
      env.sync = withAgents(members.filter((m) => m.id !== AG3), ANN);
      return { ok: true };
    });
    const { env } = await openApp({ sync: withAgents(members, ANN), social: social(), api: { removeMember }, handlers });
    await openProfile();
    for (const name of ["你", "小安", "阿波", "安的助手"]) expect(within(memberRow(name)).queryByRole("button", { name: "移除" })).toBeNull();
    await click(within(memberRow("书记员")).getByRole("button", { name: "移除" }));
    expect(removeMember).not.toHaveBeenCalled();
    await click(dialogButton("确认移除"));
    expect(removeMember).toHaveBeenCalledWith(G1, AG3);
    expect(toastText()).toBe("已将书记员移出群聊");
    expect(inMain().getByText("共 4 位成员")).toBeTruthy();
  });

  it("the creator leaving is told the earliest remaining person takes over, never an Agent", async () => {
    await openApp({ sync: withAgents([MEMBER(ME_ID, true), MEMBER(AG3), MEMBER(ANN), MEMBER(OAG)]), social: social(), handlers });
    await openProfile("周末小组", "群设置");
    await click(button("退出本群"));
    expect(dialog().textContent).toContain("最早加入的成员小安会成为新的创建者");
  });

  it("the creator with only my Agents left is told the group closes, counting people only, and that my Agents leave too", async () => {
    await openApp({ sync: withAgents([MEMBER(ME_ID, true), MEMBER(AG3)]), social: social(), handlers });
    await openProfile("周末小组", "群设置");
    await click(button("退出本群"));
    expect(dialog().textContent).toContain("你是群里的最后一位真人，退出后这个群会关闭。你的 Agent 会一起离开。");
    expect(dialog().textContent).not.toContain("最后一位成员");
  });

  it.each([
    ["the creator", [MEMBER(ME_ID, true), MEMBER(AG3), MEMBER(ANN), MEMBER(OAG)], ME_ID, "你是这个群的创建者。退出后，最早加入的成员小安会成为新的创建者。你的 Agent 会一起离开。"],
    ["a member", [MEMBER(ANN, true), MEMBER(ME_ID), MEMBER(AG3)], ANN, "你的 Agent 会一起离开。"],
  ])("%s leaving with my Agent in the group is told it leaves too", async (_who, members, creatorId, sentence) => {
    await openApp({ sync: withAgents(members, creatorId), social: social(), handlers });
    await openProfile("周末小组", "群设置");
    await click(button("退出本群"));
    expect(dialog().textContent).toContain(sentence);
  });

  it("leaving a group where only someone else's Agent is says nothing about Agents", async () => {
    await openApp({ sync: withAgents([MEMBER(ME_ID, true), MEMBER(ANN), MEMBER(OAG)]), social: social(), handlers });
    await openProfile("周末小组", "群设置");
    await click(button("退出本群"));
    expect(dialog().textContent).not.toContain("Agent");
  });

  it("添加成员's search finds friends and my Agents; nothing matching either says so once", async () => {
    await openApp({ sync: withAgents(CREATED), social: social(), handlers });
    await openProfile();
    await click(button("添加成员"));
    const box = within(dialog()).getByLabelText("搜索好友或我的 Agent");
    fireEvent.change(box, { target: { value: "@help" } });
    expect(namesIn("可添加的好友")).toEqual([]);
    expect(namesIn("可添加的 Agent")).toEqual(["小助手"]);
    expect(dialog().textContent).not.toContain("没有找到");
    fireEvent.change(box, { target: { value: "朵" } });
    expect(namesIn("可添加的好友")).toEqual(["朵拉"]);
    expect(within(dialog()).queryByRole("list", { name: "可添加的 Agent" })).toBeNull();
    expect(dialog().textContent).not.toContain("没有找到");
    fireEvent.change(box, { target: { value: "zzz" } });
    expect(dialog().textContent).toContain("没有找到匹配的好友或 Agent。");
    expect(dialog().textContent.match(/没有找到/g)).toHaveLength(1);
  });

  it.each([
    ["forbidden", 403, "没能添加：这个 Agent 可能已删除，或本群已满 500 人。"],
    ["already_member", 409, "它已经在群里了。"],
    ["rate_limited", 429, "操作太频繁了，请稍等一分钟再试。"],
  ])("adding my Agent refused (%s) reads as being about an Agent", async (code, status, text) => {
    const addMember = vi.fn(async () => Promise.reject(apiError(status, code)));
    await openApp({ sync: withAgents(CREATED), social: social(), api: { addMember }, handlers });
    await openProfile();
    await click(button("添加成员"));
    await click(within(listIn("可添加的 Agent")).getByRole("button", { name: "添加" }));
    expect(toastText()).toBe(text);
  });

  it("removing an Agent asks in its own words; a refusal reads as being about it; a person's removal reads as before", async () => {
    const removeMember = vi.fn(async () => Promise.reject(apiError(403, "forbidden")));
    await openApp({ sync: withAgents(CREATED), social: social(), api: { removeMember }, handlers });
    await openProfile();
    await click(within(memberRow("安的助手")).getByRole("button", { name: "移除" }));
    expect(dialog().textContent).toContain("把 安的助手 移出群聊？它将不再在这个群里回复。");
    expect(dialog().textContent).not.toContain("对方会立刻失去");
    await click(dialogButton("确认移除"));
    expect(toastText()).toBe("只有群的创建者和它的主人可以把它移出群聊。");
    await click(dialogButton("取消"));
    await click(within(memberRow("小安")).getByRole("button", { name: "移除" }));
    expect(dialog().textContent).toContain("对方会立刻失去这个群聊的全部内容");
    await click(dialogButton("确认移除"));
    expect(toastText()).toBe("只有群的创建者可以移除成员。");
  });
});

describe("renaming", () => {
  it("the creator renames with the same 1–60 rule; saving is disabled until the name changes", async () => {
    const renameGroup = vi.fn(async (id, title) => {
      env.sync = () => syncOf([direct(D1, ANN), group(G1, { title, lastSeq: 2, readSeq: 1 })]);
      return { id, title };
    });
    const { env } = await openApp({ sync: baseSync, social: social(), api: { renameGroup } });
    await openProfile("周末小组", "群设置");
    const input = () => screen.getByLabelText("群名称");
    expect(button("保存").disabled).toBe(true);
    fireEvent.change(input(), { target: { value: "   " } });
    await click(button("保存"));
    expect(mainText()).toContain("请输入群名称");
    fireEvent.change(input(), { target: { value: "字".repeat(61) } });
    await click(button("保存"));
    expect(mainText()).toContain("群名称最多 60 个字");
    fireEvent.change(input(), { target: { value: "\u200B" } });
    await click(button("保存"));
    expect(mainText()).toContain("群名称需要包含看得见的文字");
    expect(renameGroup).not.toHaveBeenCalled();
    fireEvent.change(input(), { target: { value: "  下周也去  " } });
    await click(button("保存"));
    expect(renameGroup).toHaveBeenCalledWith(G1, "下周也去");
    expect(toastText()).toBe("群名称已修改");
    expect(inMain().getByRole("heading", { name: "下周也去" })).toBeTruthy();
    expect(rowNames()).toContain("下周也去");
  });

  it.each([
    ["forbidden", 403, "只有群的创建者可以修改群名称。"],
    ["not_found", 404, "你已不在这个群聊中。"],
    ["invalid_request", 400, "群名称需要 1–60 个字，且只能一行。"],
    ["rate_limited", 429, "操作太频繁了，请稍等一分钟再试。"],
  ])("a refusal (%s) is a Chinese toast", async (code, status, text) => {
    await openApp({ sync: baseSync, social: social(), api: { renameGroup: vi.fn(async () => Promise.reject(apiError(status, code))) } });
    await openProfile("周末小组", "群设置");
    fireEvent.change(screen.getByLabelText("群名称"), { target: { value: "新名字" } });
    await click(button("保存"));
    expect(toastText()).toBe(text);
  });
});

describe("leaving", () => {
  const leaveFlow = async () => {
    await click(screen.getByRole("tab", { name: "群设置" }));
    await click(button("退出本群"));
  };

  it("a member confirms, lands on the empty chat pane, and is told 已退出群聊 (never 你已不在该会话中)", async () => {
    const answer = deferred();
    const removeMember = vi.fn(() => answer.promise);
    const { transport } = await openApp({ sync: othersGroup, social: social(), api: { removeMember } });
    await openProfile();
    await leaveFlow();
    expect(dialog().textContent).toContain("退出后你不会再收到这个群的消息");
    expect(dialog().textContent).not.toContain("成为新的创建者");
    await click(dialogButton("取消"));
    expect(removeMember).not.toHaveBeenCalled();

    await click(button("退出本群"));
    const toasts = watchToasts();
    await click(dialogButton("确认退出"));
    expect(removeMember).toHaveBeenCalledWith(G1, ME_ID);
    // already away from it while the answer is on its way; the service's own push for me arrives first: no removal notice
    expect(mainText()).toBe("选择一个会话开始聊天");
    await push(transport, { type: "gone", id: G1 });
    await flush();
    expect(toastText()).toBeNull();
    await act(async () => answer.resolve({ ok: true }));
    await flush();
    expect(rowNames()).toEqual(["小安"]);
    expect(toastText()).toBe("已退出群聊");
    await elapse(10_000);
    toasts.stop();
    expect(toasts.seen).toEqual(["已退出群聊"]);
  });

  it("after 退出群聊, Back three times: never a trap, the stack never grows, and no 「你已不在该会话中」 for a leave I chose", async () => {
    const answer = deferred();
    const removeMember = vi.fn(() => answer.promise);
    const { transport } = await openApp({ sync: othersGroup, social: social(), api: { removeMember } });
    await openProfile();
    await leaveFlow();
    await click(dialogButton("确认退出"));
    await push(transport, { type: "gone", id: G1 });
    await act(async () => answer.resolve({ ok: true }));
    await flush();
    const length = window.history.length;
    let index = window.history.state.index;
    const toasts = watchToasts();
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        window.history.back();
        await vi.advanceTimersByTimeAsync(60);
      });
      expect(window.history.length).toBeLessThanOrEqual(length);
      expect(window.history.state.index).toBeLessThanOrEqual(index);
      index = window.history.state.index;
    }
    toasts.stop();
    expect(index).toBe(0);
    // (A leave I chose says nothing at all afterwards.)
    expect(toasts.seen).toEqual([]);
  });

  it("the creator is told who takes over: the earliest remaining member", async () => {
    await openApp({ sync: baseSync, social: social() });
    await openProfile();
    await leaveFlow();
    expect(dialog().textContent).toContain("你是这个群的创建者。");
    expect(dialog().textContent).toContain("最早加入的成员小安会成为新的创建者");
  });

  it("the creator of a group where I am the only one left is told it closes", async () => {
    const sync = () => syncOf([direct(D1, ANN), group(G1, { members: [MEMBER(ME_ID, true)] })]);
    await openApp({ sync, social: social() });
    await openProfile();
    await leaveFlow();
    expect(dialog().textContent).toContain("你是群里的最后一位成员，退出后这个群会关闭。");
  });

  it("when the earliest member is not known by name here, it says so generally instead of naming someone", async () => {
    const stranger = "00000000-0000-4000-8000-0000000000ee";
    const sync = () => syncOf([direct(D1, ANN), group(G1, { members: [MEMBER(ME_ID, true), MEMBER(stranger), MEMBER(ANN)] })]);
    await openApp({ sync, social: social() });
    await openProfile();
    await leaveFlow();
    expect(dialog().textContent).toContain("退出后，最早加入的成员会成为新的创建者。");
    expect(dialog().textContent).not.toContain("小安会成为");
  });

  it("the creator leaves: same navigation and toast", async () => {
    const answer = deferred();
    const { transport } = await openApp({ sync: baseSync, social: social(), api: { removeMember: vi.fn(() => answer.promise) } });
    await openProfile();
    await leaveFlow();
    await click(dialogButton("确认退出"));
    await push(transport, { type: "gone", id: G1 });
    await flush();
    expect(toastText()).toBeNull();
    await act(async () => answer.resolve({ ok: true }));
    await flush();
    expect(toastText()).toBe("已退出群聊");
    expect(mainText()).toBe("选择一个会话开始聊天");
  });

  it("a refusal brings the group back with its reason", async () => {
    await openApp({ sync: baseSync, social: social(), api: { removeMember: vi.fn(async () => Promise.reject(apiError(429, "rate_limited"))) } });
    await openProfile();
    await leaveFlow();
    await click(dialogButton("确认退出"));
    expect(toastText()).toBe("操作太频繁了，请稍等一分钟再试。");
    expect(rowNames()).toContain("周末小组");
    expect(inMain().getByRole("heading", { name: "周末小组" })).toBeTruthy();
    expect(button("退出本群")).toBeTruthy();
  });

  it("being removed by someone else still says 你已不在该会话中", async () => {
    const { transport } = await openApp({ sync: othersGroup, social: social() });
    await openChat("周末小组");
    await push(transport, { type: "gone", id: G1 });
    await flush();
    expect(toastText()).toBe("你已不在该会话中");
  });
});
