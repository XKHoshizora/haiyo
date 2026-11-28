// @vitest-environment jsdom
// Contacts, friend requests and blocks over the real data layer (fake transport and fake route API).
import { PRODUCT_NAME } from "../src/brand.js";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { ANN, D1, direct, emptySocial, apiError, deferred, syncOf, wire } from "./fixtures.js";
import {
  CY,
  D2,
  DORA,
  NOW,
  PEOPLE,
  button,
  click,
  dialog,
  elapse,
  flush,
  goChats,
  goContacts,
  inMain,
  installBrowser,
  mainText,
  openApp,
  push,
  request,
  rowNames,
  toastText,
} from "./harness.jsx";

beforeEach(installBrowser);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const baseSync = () => syncOf([direct(D1, ANN, { lastSeq: 1, readSeq: 1 })], [wire(D1, 1, ANN, "早")]);
const socialWith = (over = {}) => ({ ...emptySocial(), friends: [PEOPLE[ANN]], ...over });
const openRow = async (name) => click(screen.getByText(name, { selector: ".list-col .row-name" }));
const openAdd = async () => click(button("添加好友"));
const typeHandle = (value) => fireEvent.change(screen.getByLabelText("对方的账号名"), { target: { value } });
const lookup = async (value) => {
  typeHandle(value);
  await click(button("查找"));
};
const dialogButton = (name) => within(dialog()).getByRole("button", { name });

describe("contacts list", () => {
  it("shows pending requests first (with their expiry), then friends; the search box filters locally", async () => {
    const social = socialWith({
      incoming: [request("r1", PEOPLE[CY])],
      outgoing: [request("r2", PEOPLE[DORA], { expiresAt: new Date(NOW + 35 * 60 * 1000).toISOString() })],
    });
    await openApp({ sync: baseSync, social });
    await goContacts();
    expect(rowNames()).toEqual(["小陈", "朵拉", "小安"]);
    const labels = [...document.querySelectorAll(".list-col .rows-label")].map((x) => x.textContent);
    expect(labels).toEqual(["待处理的申请", "好友"]);
    const preview = (name) => screen.getByText(name, { selector: ".row-name" }).closest("button").querySelector(".row-preview").textContent;
    expect(preview("小陈")).toBe("申请添加你为好友 · 24 小时内有效");
    expect(preview("朵拉")).toBe("你发起的申请 · 35 分钟内有效");

    const box = screen.getByLabelText("搜索联系人的名字或账号");
    fireEvent.change(box, { target: { value: "@ann" } });
    expect(rowNames()).toEqual(["小安"]);
    fireEvent.change(box, { target: { value: "陈" } });
    expect(rowNames()).toEqual(["小陈"]);
    fireEvent.change(box, { target: { value: "没有这个人" } });
    expect(screen.getByText("没有找到匹配的联系人")).toBeTruthy();
  });

  it("an empty address book says how to start; no Agent, owner or identity picker anywhere", async () => {
    await openApp();
    await goContacts();
    expect(screen.getByText("还没有联系人，点右上角的按钮添加好友")).toBeTruthy();
    const social = socialWith({ incoming: [request("r1", PEOPLE[CY])] });
    cleanup();
    await openApp({ sync: baseSync, social });
    await goContacts();
    await openRow("小安");
    for (const part of [".list-col", ".main-col"]) {
      const node = document.querySelector(part);
      expect((node.textContent + (node.querySelector("input")?.placeholder ?? "")).replace(PRODUCT_NAME, "")).not.toMatch(/Agent|主人|以谁的身份|扩展|恢复/);
    }
    expect(document.querySelector(".main-col select")).toBeNull();
  });

  it("request expiry counts down while the page is shown (at least every minute)", async () => {
    const social = socialWith({ incoming: [request("r1", PEOPLE[CY], { expiresAt: new Date(NOW + 62 * 60 * 1000).toISOString() })] });
    await openApp({ sync: baseSync, social });
    await goContacts();
    const preview = () => screen.getByText("小陈", { selector: ".row-name" }).closest("button").querySelector(".row-preview").textContent;
    expect(preview()).toBe("申请添加你为好友 · 2 小时内有效");
    await elapse(3 * 60 * 1000);
    expect(preview()).toBe("申请添加你为好友 · 59 分钟内有效");
    await elapse(60 * 60 * 1000);
    expect(preview()).toBe("申请添加你为好友 · 已过期");
  });

  it("a social push refreshes the list", async () => {
    const { env, transport } = await openApp({ sync: baseSync, social: socialWith() });
    await goContacts();
    expect(rowNames()).toEqual(["小安"]);
    env.social = socialWith({ incoming: [request("r9", PEOPLE[CY])], friends: [PEOPLE[ANN], PEOPLE[DORA]] });
    await push(transport, { type: "social" });
    await flush();
    expect(rowNames()).toEqual(["小陈", "小安", "朵拉"]);
    env.social = socialWith({ friends: [] });
    await push(transport, { type: "social" });
    await flush();
    expect(rowNames()).toEqual([]);
  });
});

describe("adding a friend", () => {
  it("looks the account name up exactly (lower-cased, @ and spaces dropped), then sends a request that shows as outgoing with its expiry", async () => {
    const sendFriendRequest = vi.fn(async (handle) => {
      env.social = { ...env.social, outgoing: [request("r1", PEOPLE[DORA], { expiresAt: new Date(NOW + 24 * 60 * 60 * 1000).toISOString() })] };
      return { id: "r1" };
    });
    const { env, api } = await openApp({ sync: baseSync, social: socialWith(), api: { sendFriendRequest } });
    await goContacts();
    await openAdd();
    await lookup("  @Dora ");
    expect(api.lookupPrincipal).toHaveBeenCalledWith("dora");
    const result = within(dialog()).getByRole("list", { name: "查找结果" });
    expect(within(result).getByText("朵拉")).toBeTruthy();
    expect(within(result).getByText("@dora")).toBeTruthy();
    expect(dialog().textContent).not.toMatch(/@example|me@/);

    await click(dialogButton("发送好友申请"));
    expect(sendFriendRequest).toHaveBeenCalledWith("dora");
    expect(toastText()).toBe("好友申请已发送");
    // the card now shows the request as sent and cannot send it twice
    expect(within(dialog()).getByRole("button", { name: "发送好友申请" }).disabled).toBe(true);
    expect(dialog().textContent).toContain("申请已发送，等待对方确认。");
    fireEvent.click(dialogButton("完成"));
    await flush();
    const row = screen.getByText("朵拉", { selector: ".list-col .row-name" }).closest("button");
    expect(row.textContent).toContain("待对方确认");
    expect(row.textContent).toContain("24 小时内有效");
  });

  it("the same flow opens from the chat list's 新建 menu", async () => {
    await openApp({ sync: baseSync, social: socialWith() });
    fireEvent.click(button("新建"));
    fireEvent.click(screen.getByRole("button", { name: /添加好友/ }));
    await flush();
    expect(screen.getByLabelText("对方的账号名")).toBeTruthy();
  });

  it("an unknown account name, a malformed one and my own account each get their own message", async () => {
    const { api } = await openApp({ sync: baseSync, social: socialWith() });
    await goContacts();
    await openAdd();
    await lookup("nobody1");
    expect(dialog().textContent).toContain("没有找到账号名为 nobody1 的用户。目前还不能添加 Agent 为好友。");
    expect(within(dialog()).queryByRole("list", { name: "查找结果" })).toBeNull();

    api.lookupPrincipal.mockClear();
    await lookup("ab");
    expect(dialog().textContent).toContain("账号名由 3–24 位小写字母、数字或下划线组成。");
    await lookup("has space");
    expect(api.lookupPrincipal).not.toHaveBeenCalled();

    api.lookupPrincipal.mockResolvedValueOnce({ id: PEOPLE[ANN].id, handle: "me_one", displayName: "Mei" });
    api.lookupPrincipal.mockResolvedValueOnce({ id: "00000000-0000-4000-8000-0000000000a1", handle: "me_one", displayName: "Mei" });
    await lookup("me_one");
    await lookup("me_one");
    expect(dialog().textContent).toContain("这是你自己的账号。");
    expect(dialogButton("发送好友申请").disabled).toBe(true);
  });

  it("a person I already befriended, blocked, or who blocked me cannot be sent a request", async () => {
    const social = { ...emptySocial(), friends: [PEOPLE[ANN]], blocked: [PEOPLE[DORA]], blockedBy: [PEOPLE[CY]] };
    const { api } = await openApp({ sync: baseSync, social });
    await goContacts();
    await openAdd();
    await lookup("ann");
    expect(dialog().textContent).toContain("你们已经是好友了。");
    await lookup("dora");
    expect(dialog().textContent).toContain("你已拉黑对方，需先解除拉黑。");
    await lookup("chen");
    expect(dialog().textContent).toContain("对方拉黑了你，无法发送申请。");
    expect(dialogButton("发送好友申请").disabled).toBe(true);
    expect(api.sendFriendRequest).toBeUndefined();
  });

  it("the send button shows its pending state and a refusal becomes a Chinese toast", async () => {
    const pending = deferred();
    const sendFriendRequest = vi.fn(() => pending.promise);
    await openApp({ sync: baseSync, social: socialWith(), api: { sendFriendRequest } });
    await goContacts();
    await openAdd();
    await lookup("dora");
    await click(dialogButton("发送好友申请"));
    expect(dialogButton("发送中…").disabled).toBe(true);
    await act(async () => pending.reject(apiError(409, "request_pending")));
    await flush();
    expect(toastText()).toBe("你们之间已有一条待处理的申请。");
    expect(dialogButton("发送好友申请").disabled).toBe(false);
  });

  it("the card of a former friend (reached from their chat) offers 添加好友 and sends the request", async () => {
    const sync = () => syncOf([direct(D1, ANN, { lastSeq: 1, readSeq: 1, canSend: { ok: false, reason: "not_friends" } })], [wire(D1, 1, ANN, "早")]);
    const sendFriendRequest = vi.fn(async () => ({ id: "r1" }));
    await openApp({ sync, social: { ...emptySocial(), friends: [], blocked: [] }, api: { sendFriendRequest } });
    await click(screen.getByText("小安", { selector: ".list-col .row-name" }));
    fireEvent.click(button("会话资料"));
    await flush();
    await click(within(document.querySelector(".side-col")).getByRole("button", { name: "查看联系人卡片" }));
    expect(mainText()).toContain("你们还没有建立联系。");
    await click(inMain().getByRole("button", { name: "添加好友" }));
    expect(sendFriendRequest).toHaveBeenCalledWith("ann");
    expect(toastText()).toBe("好友申请已发送");
  });

  it("someone I blocked cannot be sent a request from their card until the block is lifted", async () => {
    const sync = () => syncOf([direct(D1, ANN, { lastSeq: 1, readSeq: 1, canSend: { ok: false, reason: "blocked" } })], [wire(D1, 1, ANN, "早")]);
    await openApp({ sync, social: { ...emptySocial(), blocked: [PEOPLE[ANN]] } });
    await click(screen.getByText("小安", { selector: ".list-col .row-name" }));
    fireEvent.click(button("会话资料"));
    await flush();
    await click(within(document.querySelector(".side-col")).getByRole("button", { name: "查看联系人卡片" }));
    expect(inMain().getByRole("button", { name: "添加好友" }).disabled).toBe(true);
    expect(mainText()).toContain("你已拉黑对方，需先解除拉黑");
  });
});

describe("requests", () => {
  const withIncoming = () => socialWith({ incoming: [request("r1", PEOPLE[CY])] });
  const withOutgoing = () => socialWith({ outgoing: [request("r2", PEOPLE[DORA])] });

  it("accepting an incoming request makes a friend and the chat can be opened", async () => {
    const acceptFriendRequest = vi.fn(async () => {
      env.social = socialWith({ friends: [PEOPLE[ANN], PEOPLE[CY]] });
      env.sync = () => syncOf([direct(D1, ANN, { lastSeq: 1, readSeq: 1 }), direct(D2, CY)], [wire(D1, 1, ANN, "早")]);
      return { ok: true, conversationId: D2 };
    });
    const { env } = await openApp({ sync: baseSync, social: withIncoming(), api: { acceptFriendRequest } });
    await goContacts();
    await openRow("小陈");
    expect(mainText()).toContain("对方发起");
    expect(mainText()).toContain("24 小时内有效");
    await click(button("同意"));
    expect(acceptFriendRequest).toHaveBeenCalledWith("r1");
    expect(toastText()).toBe("已添加小陈为好友");
    expect(document.querySelector(".list-col .rows-label").textContent).toBe("好友");
    expect(screen.queryByRole("button", { name: "同意" })).toBeNull();
    await click(button("发消息"));
    expect(document.querySelector(".chat-head, .chat")?.textContent ?? mainText()).toContain("小陈");
  });

  it("rejecting an incoming request removes it", async () => {
    const rejectFriendRequest = vi.fn(async () => {
      env.social = socialWith();
      return { ok: true, conversationId: null };
    });
    const { env } = await openApp({ sync: baseSync, social: withIncoming(), api: { rejectFriendRequest } });
    await goContacts();
    await openRow("小陈");
    await click(button("拒绝"));
    expect(rejectFriendRequest).toHaveBeenCalledWith("r1");
    expect(toastText()).toBe("已拒绝申请");
    expect(rowNames()).toEqual(["小安"]);
  });

  it("an outgoing request shows its expiry and can be withdrawn", async () => {
    const withdrawFriendRequest = vi.fn(async () => {
      env.social = socialWith();
      return { ok: true, conversationId: null };
    });
    const { env } = await openApp({ sync: baseSync, social: withOutgoing(), api: { withdrawFriendRequest } });
    await goContacts();
    await openRow("朵拉");
    expect(mainText()).toContain("你发起");
    expect(mainText()).toContain("等待朵拉确认");
    expect(mainText()).toContain("24 小时内有效");
    expect(screen.queryByRole("button", { name: "同意" })).toBeNull();
    await click(button("撤回"));
    expect(withdrawFriendRequest).toHaveBeenCalledWith("r2");
    expect(toastText()).toBe("已撤回申请");
    expect(rowNames()).toEqual(["小安"]);
  });

  it("buttons show their pending state while the request is in flight", async () => {
    const pending = deferred();
    await openApp({ sync: baseSync, social: withIncoming(), api: { acceptFriendRequest: vi.fn(() => pending.promise) } });
    await goContacts();
    await openRow("小陈");
    await click(button("同意"));
    expect(button("处理中…").disabled).toBe(true);
    expect(button("拒绝").disabled).toBe(true);
    await act(async () => pending.resolve({ ok: true, conversationId: null }));
    await flush();
  });

  it("a stale request (already decided) says so and the list is refetched", async () => {
    const acceptFriendRequest = vi.fn(async () => {
      env.social = socialWith();
      throw apiError(409, "request_not_pending");
    });
    const { env, transport } = await openApp({ sync: baseSync, social: withIncoming(), api: { acceptFriendRequest } });
    await goContacts();
    await openRow("小陈");
    const before = transport.log.filter((x) => x === "social").length;
    await click(button("同意"));
    expect(toastText()).toBe("这条申请已经处理过了。");
    expect(transport.log.filter((x) => x === "social").length).toBe(before + 1);
    expect(rowNames()).toEqual(["小安"]);
  });
});

describe("a request past its deadline (held until the next fetch drops it)", () => {
  const in90s = () => new Date(NOW + 90_000).toISOString();
  const relLine = () => document.querySelector(".main-col .rel-rows .member-body .muted").textContent;
  const relTag = () => document.querySelector(".main-col .rel-rows .tag").textContent;
  const rowTag = (name) => screen.getByText(name, { selector: ".list-col .row-name" }).closest("button").querySelector(".tag").textContent;

  it("an incoming one: the card stops offering 同意 and 拒绝 at the minute it runs out and reads 已过期, and so does its row", async () => {
    await openApp({ sync: baseSync, social: socialWith({ incoming: [request("r1", PEOPLE[CY], { expiresAt: in90s() })] }) });
    await goContacts();
    await openRow("小陈");
    expect(inMain().getByRole("button", { name: "同意" })).toBeTruthy();
    expect(relTag()).toBe("待你确认");
    expect(rowTag("小陈")).toBe("待你确认");
    await elapse(2 * 60_000);
    expect(inMain().queryByRole("button", { name: "同意" })).toBeNull();
    expect(inMain().queryByRole("button", { name: "拒绝" })).toBeNull();
    expect(relLine()).toMatch(/^对方发起 · .+ · 已过期$/);
    expect(relTag()).toBe("已过期");
    expect(rowTag("小陈")).toBe("已过期");
    expect(screen.getByText("小陈", { selector: ".row-name" }).closest("button").querySelector(".row-preview").textContent).toBe("申请添加你为好友 · 已过期");
  });

  it("an outgoing one: no 撤回 once it has run out (the service would answer that it expired), and it reads 已过期", async () => {
    await openApp({ sync: baseSync, social: socialWith({ outgoing: [request("r2", PEOPLE[DORA], { expiresAt: in90s() })] }) });
    await goContacts();
    await openRow("朵拉");
    expect(inMain().getByRole("button", { name: "撤回" })).toBeTruthy();
    await elapse(2 * 60_000);
    expect(inMain().queryByRole("button", { name: "撤回" })).toBeNull();
    expect(relLine()).toMatch(/^你发起 · .+ · 已过期$/);
    expect(relTag()).toBe("已过期");
    expect(rowTag("朵拉")).toBe("已过期");
  });
});

describe("friends: message and unfriend", () => {
  it("发消息 opens the direct chat", async () => {
    await openApp({ sync: baseSync, social: socialWith() });
    await goContacts();
    await openRow("小安");
    await click(button("发消息"));
    expect(document.querySelector(".main-col").textContent).toContain("早");
    expect(screen.getByLabelText("消息内容")).toBeTruthy();
  });

  it("when the chat is not in state yet it is fetched and then opened", async () => {
    const noChat = () => syncOf([]);
    const { env, transport } = await openApp({ sync: noChat, social: socialWith() });
    await goContacts();
    await openRow("小安");
    await click(button("发消息"));
    expect(transport.log.filter((x) => x === "sync").length).toBe(2);
    expect(screen.queryByLabelText("消息内容")).toBeNull();
    env.sync = baseSync;
    await push(transport, { type: "conversation", id: D1 });
    await flush();
    expect(screen.getByLabelText("消息内容")).toBeTruthy();
    expect(mainText()).toContain("早");
  });

  it("gives up with a toast when the chat never arrives", async () => {
    await openApp({ sync: () => syncOf([]), social: socialWith() });
    await goContacts();
    await openRow("小安");
    await click(button("发消息"));
    await elapse(9000);
    expect(toastText()).toBe("会话还没有同步下来，请稍后在消息列表里查看");
  });

  it("unfriending asks first; cancelling does nothing, confirming ends the friendship", async () => {
    const removeFriend = vi.fn(async () => {
      env.social = socialWith({ friends: [] });
      return { ok: true };
    });
    const { env } = await openApp({ sync: baseSync, social: socialWith(), api: { removeFriend } });
    await goContacts();
    await openRow("小安");
    await click(button("解除好友"));
    expect(dialog().textContent).toContain("私聊记录会保留");
    await click(dialogButton("取消"));
    expect(removeFriend).not.toHaveBeenCalled();
    await click(button("解除好友"));
    await click(dialogButton("确认解除"));
    expect(removeFriend).toHaveBeenCalledWith(ANN);
    expect(dialog()).toBeNull();
    expect(toastText()).toBe("已解除好友关系");
    expect(rowNames()).toEqual([]);
  });
});

describe("blocks", () => {
  it("blocking from the card asks first, then shows the blocked state with a way back", async () => {
    const blockPrincipal = vi.fn(async () => {
      env.social = socialWith({ blocked: [PEOPLE[ANN]] });
      return { ok: true };
    });
    const unblockPrincipal = vi.fn(async () => {
      env.social = socialWith();
      return { ok: true };
    });
    const { env } = await openApp({ sync: baseSync, social: socialWith(), api: { blockPrincipal, unblockPrincipal } });
    await goContacts();
    await openRow("小安");
    await click(button("拉黑小安"));
    expect(dialog().textContent).toContain("你们之间的私聊不能再发送新消息");
    expect(dialog().textContent).toContain("你们各自的 Agent 也不会再回应对方：在群里 @ 不到，也不会主动接对方的话。");
    await click(dialogButton("取消"));
    expect(blockPrincipal).not.toHaveBeenCalled();
    await click(button("拉黑小安"));
    await click(dialogButton("确认拉黑"));
    expect(blockPrincipal).toHaveBeenCalledWith(ANN);
    expect(dialog()).toBeNull();
    expect(mainText()).toContain("你已拉黑小安");
    expect(screen.getByText("已拉黑", { selector: ".tag" })).toBeTruthy();
    expect(screen.getByText("小安", { selector: ".row-name" }).closest("button").textContent).toContain("已拉黑");

    await click(button("解除拉黑"));
    expect(dialog().textContent).toContain("只解除你自己的拉黑");
    await click(dialogButton("解除我的拉黑"));
    expect(unblockPrincipal).toHaveBeenCalledWith(ANN);
    expect(mainText()).not.toContain("你已拉黑小安");
    expect(screen.getByRole("button", { name: "拉黑小安" })).toBeTruthy();
  });

  it("someone who blocked me: the card says so, there is no unblock control, the chat is on hold", async () => {
    const sync = () => syncOf([direct(D1, ANN, { lastSeq: 1, readSeq: 1, canSend: { ok: false, reason: "blocked" } })], [wire(D1, 1, ANN, "早")]);
    await openApp({ sync, social: socialWith({ blockedBy: [PEOPLE[ANN]] }) });
    await goContacts();
    expect(screen.getByText("小安", { selector: ".row-name" }).closest("button").textContent).toContain("对方拉黑了你");
    await openRow("小安");
    expect(screen.getByText("对方拉黑了你", { selector: ".tag" })).toBeTruthy();
    expect(mainText()).toContain("小安拉黑了你，只能由对方解除");
    expect(screen.queryByRole("button", { name: /解除拉黑|解除我的拉黑/ })).toBeNull();

    await goChats();
    await click(screen.getByText("小安", { selector: ".list-col .row-name" }));
    fireEvent.click(button("会话资料"));
    await flush();
    const side = document.querySelector(".side-col");
    expect(side.textContent).toContain("对方拉黑了你，只能由对方解除。");
    expect(within(side).queryByRole("button", { name: /解除我的拉黑/ })).toBeNull();
  });

  it("from the direct chat's details panel: block with confirmation, then unblock", async () => {
    const blockPrincipal = vi.fn(async () => {
      env.social = socialWith({ blocked: [PEOPLE[ANN]] });
      return { ok: true };
    });
    const unblockPrincipal = vi.fn(async () => {
      env.social = socialWith();
      return { ok: true };
    });
    const { env } = await openApp({ sync: baseSync, social: socialWith(), api: { blockPrincipal, unblockPrincipal } });
    await click(screen.getByText("小安", { selector: ".list-col .row-name" }));
    fireEvent.click(button("会话资料"));
    await flush();
    const side = () => document.querySelector(".side-col");
    await click(within(side()).getByRole("button", { name: "拉黑此用户" }));
    await click(dialogButton("确认拉黑"));
    expect(blockPrincipal).toHaveBeenCalledWith(ANN);
    await click(within(side()).getByRole("button", { name: "解除我的拉黑" }));
    await click(dialogButton("解除我的拉黑"));
    expect(unblockPrincipal).toHaveBeenCalledWith(ANN);
    expect(within(side()).getByRole("button", { name: "拉黑此用户" })).toBeTruthy();
  });

  it("a person I blocked who is not a friend is listed under Settings › 拉黑 and unblocked with the same dialog", async () => {
    const unblockPrincipal = vi.fn(async () => {
      env.social = emptySocial();
      return { ok: true };
    });
    const { env } = await openApp({ sync: baseSync, social: { ...emptySocial(), blocked: [PEOPLE[DORA]] }, api: { unblockPrincipal } });
    fireEvent.click(within(screen.getByRole("navigation", { name: "主导航" })).getByRole("button", { name: /^设置/ }));
    await flush();
    await click(screen.getByText("拉黑", { selector: ".list-col .row-name" }));
    expect(mainText()).toContain("朵拉");
    await click(button("解除拉黑"));
    await click(dialogButton("解除我的拉黑"));
    expect(unblockPrincipal).toHaveBeenCalledWith(DORA);
    expect(mainText()).not.toContain("朵拉");
    expect(mainText()).toContain("你没有拉黑任何人或 Agent。");
  });
});

describe("refusals become Chinese toasts", () => {
  const cases = [
    ["accept", "同意", "request_expired", "这条申请已过期，请让对方重新发送。"],
    ["accept", "同意", "blocked", "你们之间存在拉黑，无法同意这条申请。"],
    ["accept", "同意", "not_found", "这条申请已经不存在了。"],
    ["accept", "同意", "rate_limited", "操作太频繁了，请稍等一分钟再试。"],
    ["accept", "同意", "weird_new_code", "操作没有成功，请稍后再试。"],
    ["reject", "拒绝", "request_not_pending", "这条申请已经处理过了。"],
  ];
  it.each(cases)("%s: %s → %s", async (route, label, code, text) => {
    const fn = vi.fn(async () => {
      throw apiError(code === "rate_limited" ? 429 : 409, code);
    });
    await openApp({
      sync: baseSync,
      social: socialWith({ incoming: [request("r1", PEOPLE[CY])] }),
      api: { acceptFriendRequest: fn, rejectFriendRequest: fn },
    });
    await goContacts();
    await openRow("小陈");
    await click(button(label));
    expect(toastText()).toBe(text);
  });
});
