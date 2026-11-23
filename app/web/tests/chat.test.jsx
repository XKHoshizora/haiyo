// @vitest-environment jsdom
// The chat pages over the real data layer (fake transport and API): list, timeline, composer, details.
import React from "react";
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { App } from "../src/App.jsx";
import { createDataLayer } from "../src/data/store.jsx";
import {
  ANN,
  BO,
  D1,
  G1,
  ME,
  ME_ID,
  PRINCIPALS,
  apiError,
  at,
  deferred,
  direct,
  emptySocial,
  fakeTimers,
  fakeTransport,
  group,
  notice,
  range,
  syncOf,
  wire,
} from "./fixtures.js";

const NOW = new Date(2026, 10, 16, 12, 0).getTime();
const GONE = "00000000-0000-4000-8000-0000000000a9";
const pub = (id, handle, displayName) => ({ id, handle, displayName });

/** D1: 小安 wrote m1..m3, two unread. G1: 30 messages 11..40 (older ones exist), newest activity. */
const baseSync = () =>
  syncOf(
    [direct(D1, ANN, { lastSeq: 3, readSeq: 1, unread: 2 }), group(G1, { lastSeq: 40, readSeq: 40 })],
    [...range(D1, 1, 3), ...range(G1, 11, 40, [ANN, BO])],
  );

function chatApi(over = {}) {
  return {
    sendMessage: vi.fn(() => new Promise(() => {})),
    markRead: vi.fn(async (_id, seq) => ({ readSeq: seq })),
    listMessages: vi.fn(async () => ({ messages: [], nextBefore: null })),
    ...over,
  };
}

let visibility = "visible";
/** Whether the chat's message list is laid out on screen (false: hidden by the mobile list pane's display:none). */
let chatOnScreen = true;
beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});
beforeEach(() => {
  // The page's timers (mark-read delay, draft save, toast) run on a fake clock; the data layer has its own fake timers.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  visibility = "visible";
  chatOnScreen = true;
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function rects() {
    return chatOnScreen || !this.matches("ol.messages") ? [{ top: 0 }] : [];
  });
  history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Lets pending promises and zero-delay timers run. */
const flush = () =>
  act(async () => {
    for (let i = 0; i < 6; i += 1) await vi.advanceTimersByTimeAsync(0);
  });
/** Moves the fake clock forward, running what falls due. */
const elapse = (ms) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const toastText = () => document.querySelector(".toast")?.textContent ?? null;

async function openApp({ sync = baseSync, social = emptySocial, api = {} } = {}) {
  const transport = fakeTransport({ sync, social });
  const calls = chatApi(api);
  let n = 0;
  const layer = createDataLayer({ transport, api: calls, timers: fakeTimers(), now: () => NOW, random: () => 0.5, uuid: () => `tx-${++n}` });
  render(<App api={{ getMe: async () => ME }} createLayer={() => layer} />);
  await flush();
  return { layer, transport, api: calls };
}

const rowNames = () => [...document.querySelectorAll(".list-col .row-name")].map((x) => x.textContent);
const openChat = async (name) => {
  fireEvent.click(screen.getByText(name, { selector: ".list-col .row-name" }));
  await flush();
};
const input = () => screen.getByLabelText("消息内容");
const type = (value) => fireEvent.change(input(), { target: { value } });
const press = (key, init = {}) => fireEvent.keyDown(input(), { key, ...init });
const timeline = () => document.querySelector("ol.messages");
/** Gives the message list a layout jsdom lacks: 3000 px of content in a 600 px box, scrolled to `scrollTop`. */
function tallList(scrollTop, { scrollHeight = 3000, clientHeight = 600 } = {}) {
  const list = timeline();
  let top = scrollTop;
  Object.defineProperty(list, "scrollTop", { configurable: true, get: () => top, set: (v) => (top = v) });
  Object.defineProperty(list, "scrollHeight", { configurable: true, get: () => scrollHeight });
  Object.defineProperty(list, "clientHeight", { configurable: true, get: () => clientHeight });
  return list;
}
const mainText = () => document.querySelector(".main-col").textContent;
const push = (transport, event) => act(() => transport.socket.emit(event));

describe("conversation list", () => {
  it("shows unread and the last message, and moves a conversation up when a message is pushed", async () => {
    const { transport } = await openApp();
    expect(rowNames()).toEqual(["周末小组", "小安"]);
    const row = screen.getByText("小安", { selector: ".row-name" }).closest("button");
    expect(within(row).getByText("m3")).toBeTruthy();
    expect(within(row).getByText("2", { selector: ".badge" })).toBeTruthy();
    expect(within(screen.getByText("周末小组", { selector: ".row-name" }).closest("button")).getByText("小安：m40")).toBeTruthy();

    await push(transport, { type: "message", message: wire(D1, 4, ANN, "到了吗", { createdAt: at(50) }) });
    expect(rowNames()).toEqual(["小安", "周末小组"]);
    const moved = screen.getByText("小安", { selector: ".row-name" }).closest("button");
    expect(within(moved).getByText("到了吗")).toBeTruthy();
    expect(within(moved).getByText("3", { selector: ".badge" })).toBeTruthy();
  });

  it("the search box filters conversations locally by name, handle and last message", async () => {
    await openApp();
    const box = screen.getByLabelText("搜索联系人、群聊");
    fireEvent.change(box, { target: { value: "@ann" } });
    expect(rowNames()).toEqual(["小安"]);
    fireEvent.change(box, { target: { value: "周末" } });
    expect(rowNames()).toEqual(["周末小组"]);
    fireEvent.change(box, { target: { value: "没有这个" } });
    expect(screen.getByText("没有符合条件的会话")).toBeTruthy();
  });

  it("nothing about Agents or owners in the list, its menu, the chat or the details panel", async () => {
    await openApp();
    fireEvent.click(screen.getByRole("button", { name: "新建" }));
    expect(screen.getByRole("button", { name: /添加好友/ })).toBeTruthy();
    await openChat("周末小组");
    fireEvent.click(screen.getByRole("button", { name: "会话资料" }));
    // (the list header's brand name stays)
    for (const part of [".list-col .menu", ".list-col .search", ".list-col .rows", ".main-col", ".side-col"]) {
      const node = document.querySelector(part);
      expect(node.textContent + (node.querySelector("input,textarea")?.placeholder ?? "")).not.toMatch(/Agent|主人|插话/);
    }
    type("@");
    expect(document.querySelector(".composer").textContent).not.toMatch(/Agent|主人/);
    expect(screen.getByRole("button", { name: "@ 会话成员" })).toBeTruthy();
    const side = document.querySelector(".side-col");
    expect(within(side).getByText("发言成员")).toBeTruthy();
    expect(within(side).getByText("谁能看")).toBeTruthy();
    expect(within(side).getByRole("button", { name: "打开群资料" })).toBeTruthy();
  });
});

describe("nobody is labelled a person", () => {
  it("a direct chat's header is its title alone: no subtitle line, no empty gap; a group's header counts its people with an icon", async () => {
    await openApp();
    await openChat("小安");
    const title = document.querySelector(".chat-head .chat-title");
    expect(title.querySelector("p")).toBeNull();
    expect(document.body.textContent).not.toContain("真人");
    await openChat("周末小组");
    const counts = document.querySelector(".chat-head .chat-title .head-counts");
    expect(counts.querySelectorAll("svg").length).toBe(1);
    expect(counts.querySelector('[aria-label="3 人"]')).toBeTruthy();
    expect(counts.querySelector(".head-counts-sep")).toBeNull();
    expect(counts.querySelector('[aria-label$="Agent"]')).toBeNull();
  });
});

describe("reading", () => {
  it("opening a chat marks it read up to the newest seq once the tab is visible and focused", async () => {
    const { api } = await openApp();
    await openChat("小安");
    await elapse(400);
    expect(api.markRead).not.toHaveBeenCalled();
    await elapse(200);
    expect(api.markRead).toHaveBeenCalledWith(D1, 3);
    expect(api.markRead).toHaveBeenCalledTimes(1);
    expect(screen.getByText("小安", { selector: ".row-name" }).closest("button").querySelector(".badge")).toBeNull();
  });

  it("does not mark read while the tab is hidden or the window is not focused; does when it comes back", async () => {
    visibility = "hidden";
    const { api } = await openApp();
    await openChat("小安");
    await elapse(2000);
    expect(api.markRead).not.toHaveBeenCalled();

    visibility = "visible";
    document.hasFocus.mockReturnValue(false);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await elapse(2000);
    expect(api.markRead).not.toHaveBeenCalled();

    document.hasFocus.mockReturnValue(true);
    act(() => window.dispatchEvent(new Event("focus")));
    await elapse(600);
    expect(api.markRead).toHaveBeenCalledWith(D1, 3);
  });

  it("a chat hidden behind the list pane (phone layout) is not marked read; shown again, it is", async () => {
    const { api, transport } = await openApp();
    await openChat("小安");
    await elapse(600);
    expect(api.markRead).toHaveBeenCalledWith(D1, 3);
    fireEvent.click(screen.getByRole("button", { name: "返回列表" }));
    chatOnScreen = false; // the main column is display:none while the list pane shows
    await push(transport, { type: "message", message: wire(D1, 4, ANN, "你看列表的时候发的") });
    await elapse(2000);
    expect(api.markRead).toHaveBeenCalledTimes(1);
    expect(screen.getByText("小安", { selector: ".row-name" }).closest("button").querySelector(".badge").textContent).toBe("1");

    chatOnScreen = true;
    await openChat("小安");
    await elapse(600);
    expect(api.markRead).toHaveBeenLastCalledWith(D1, 4);
  });

  it("a failed read is not retried in a loop: once more only when the person looks again", async () => {
    const { api } = await openApp({ api: { markRead: vi.fn(async () => Promise.reject(apiError(0, "network_error"))) } });
    await openChat("小安");
    await elapse(600);
    expect(api.markRead).toHaveBeenCalledTimes(1);
    await elapse(10_000);
    expect(api.markRead).toHaveBeenCalledTimes(1);
    expect(screen.getByText("小安", { selector: ".row-name" }).closest("button").querySelector(".badge").textContent).toBe("2");
    act(() => window.dispatchEvent(new Event("focus")));
    await elapse(600);
    expect(api.markRead).toHaveBeenCalledTimes(2);
  });

  it("a message arriving in the open chat is marked read too", async () => {
    const { api, transport } = await openApp();
    await openChat("小安");
    await elapse(600);
    expect(api.markRead).toHaveBeenCalledWith(D1, 3);
    await push(transport, { type: "message", message: wire(D1, 4, ANN, "还在吗") });
    await elapse(600);
    expect(api.markRead).toHaveBeenLastCalledWith(D1, 4);
  });

  it("scrolled up: a new message is not marked read until the list is back at the newest message", async () => {
    const { api, transport } = await openApp();
    await openChat("小安");
    await elapse(600);
    // (At the end, then scrolled up by the person.)
    const list = tallList(2400);
    fireEvent.scroll(list);
    list.scrollTop = 1000;
    fireEvent.scroll(list);
    await push(transport, { type: "message", message: wire(D1, 4, ANN, "还在吗") });
    await elapse(2000);
    expect(api.markRead).toHaveBeenCalledTimes(1);

    list.scrollTop = 2400; // back at the bottom
    fireEvent.scroll(list);
    await elapse(600);
    expect(api.markRead).toHaveBeenLastCalledWith(D1, 4);
  });

  it("已读 in a direct chat from the peer's marker; groups show no read state", async () => {
    const sync = () =>
      syncOf(
        [direct(D1, ANN, { lastSeq: 3, readSeq: 3, peerReadSeq: 2 }), group(G1, { lastSeq: 2, readSeq: 2 })],
        [wire(D1, 1, ANN, "早"), wire(D1, 2, ME_ID, "看到了"), wire(D1, 3, ME_ID, "还没看"), wire(G1, 1, ANN, "大家好"), wire(G1, 2, ME_ID, "群里的我")],
      );
    const { transport } = await openApp({ sync });
    await openChat("小安");
    const receipt = (text) => screen.getByText(text, { selector: ".bubble" }).closest("li").querySelector(".receipt")?.textContent.trim();
    expect(receipt("看到了")).toBe("已读");
    expect(receipt("还没看")).toBe("已发送");
    await push(transport, { type: "read", conversationId: D1, principalId: ANN, seq: 3 });
    expect(receipt("还没看")).toBe("已读");

    await openChat("周末小组");
    expect(receipt("群里的我")).toBeUndefined();
    expect(mainText()).not.toMatch(/已读|已发送/);
  });

  it("the foot under my bubble holds the receipt and the 回复 control, and the CSS keeps the control out of the receipt's way", async () => {
    const sync = () =>
      syncOf([direct(D1, ANN, { lastSeq: 2, readSeq: 2, peerReadSeq: 2 })], [wire(D1, 1, ANN, "早"), wire(D1, 2, ME_ID, "看到了")]);
    await openApp({ sync });
    await openChat("小安");
    const foot = (text) => screen.getByText(text, { selector: ".bubble" }).closest("li").querySelector(".msg-main > .msg-foot");
    const mine = foot("看到了");
    expect(mine.closest("li").className).toContain("mine");
    expect(mine.querySelector(":scope > .receipt")).not.toBeNull();
    expect(mine.querySelector(":scope > .msg-action")).not.toBeNull();
    expect(foot("早").closest("li").className).toContain("theirs");
    expect(foot("早").querySelector(":scope > .msg-action")).not.toBeNull();

    // jsdom has no layout (the e2e spec measures): here, the rules that this structure relies on.
    const css = readFileSync("src/styles.css", "utf8");
    const rule = (selector) => css.split("\n").find((line) => line.startsWith(`${selector} {`)) ?? "";
    expect(rule(".msg-main")).toMatch(/align-items:\s*flex-start/); // theirs: as wide as its content, not the name line
    expect(rule(".msg.mine .msg-main")).toMatch(/align-items:\s*flex-end/);
    expect(rule(".msg.mine .msg-foot")).toMatch(/position:\s*relative/);
    expect(rule(".msg.mine .msg-action")).toMatch(/position:\s*absolute/); // takes no room: 已读 stays under the bubble's edge
    expect(rule(".msg.mine .msg-action")).toMatch(/right:\s*100%/);
  });
});

describe("timeline", () => {
  it("system notices for each event in the system-line style, with names from people", async () => {
    const sync = () =>
      syncOf(
        [group(G1, { lastSeq: 9, readSeq: 9 })],
        [
          notice(G1, 1, "x", { event: "group_created", actorId: ME_ID, title: "周末小组", memberIds: [ANN, BO] }),
          notice(G1, 2, "x", { event: "member_joined", actorId: ANN, principalId: BO }),
          notice(G1, 3, "x", { event: "member_left", actorId: BO, principalId: BO, newCreatorId: null }),
          notice(G1, 4, "x", { event: "member_removed", actorId: ME_ID, principalId: ANN }),
          notice(G1, 5, "x", { event: "group_renamed", actorId: ME_ID, title: "新名字" }),
          notice(G1, 6, "x", { event: "friendship_ended", actorId: ANN, principalId: ME_ID }),
          notice(G1, 7, "x", { event: "friendship_restored", actorId: ME_ID, principalId: ANN }),
          notice(G1, 8, "x", { event: "blocked", actorId: ANN, principalId: ME_ID }),
          notice(G1, 9, "x", { event: "unblocked", actorId: ANN, principalId: ME_ID }),
        ],
      );
    await openApp({ sync });
    await openChat("周末小组");
    const lines = [...document.querySelectorAll("li.msg-system > span")].map((x) => x.textContent);
    expect(lines).toEqual([
      "你创建了群聊「周末小组」，并邀请小安、阿波加入",
      "小安邀请阿波加入了群聊",
      "阿波退出了群聊",
      "你将小安移出了群聊",
      "你将群名改为「新名字」",
      "小安解除了与你的好友关系，双方不能再发送新消息，已有历史不受影响",
      "你和小安重新成为好友，可以继续发送消息",
      "小安拉黑了你，只能由对方解除。双方不能再发送新消息，已有历史不受影响",
      "小安解除了对你的拉黑",
    ]);
  });

  it("the notices of Agents talking to each other in a group (batch 2C); a notice of an unknown event shows nothing", async () => {
    const BOT = "00000000-0000-4000-8000-0000000000b9";
    const sync = () =>
      syncOf(
        [group(G1, { lastSeq: 6, readSeq: 6 })],
        [
          wire(G1, 1, ANN, "@annbot 你好"),
          notice(G1, 2, "x", { event: "agent_chain_paused", actorId: ANN, limit: 30 }),
          notice(G1, 3, "x", { event: "agents_halted", actorId: ANN }),
          notice(G1, 4, "x", { event: "agent_budget_reached", actorId: ANN, agentId: BOT }),
          notice(G1, 5, "以后才有的通知", { event: "from_the_future", actorId: ANN, agentId: BOT }),
          notice(G1, 6, "x", { event: "agents_halted", actorId: ME_ID }),
        ],
        [...PRINCIPALS, { id: BOT, handle: "annbot", displayName: "安的助手", kind: "agent", ownerId: ANN }],
      );
    const { transport } = await openApp({ sync });
    await openChat("周末小组");
    const lines = () => [...document.querySelectorAll("li.msg-system > span")].map((x) => x.textContent);
    expect(lines()).toEqual([
      "Agent 已连续对话 30 条，已暂停互相接话，有人发言后继续。",
      "小安让 Agent 停止了接话",
      "安的助手已达到本次接话的点数上限，有人发言后继续。",
      "你让 Agent 停止了接话",
    ]);
    expect(timeline().querySelector('[data-msg="m5"]')).toBeNull();
    expect(timeline().textContent).not.toContain("以后才有的通知");
    // Pushed, it shows nothing either and breaks nothing after it; it is never the list's preview line.
    await push(transport, { type: "message", message: notice(G1, 7, "又一个以后才有的通知", { event: "from_the_future_2", actorId: ANN }) });
    expect(lines()).toHaveLength(4);
    expect(document.querySelector(".list-col").textContent).not.toContain("以后才有的通知");
    await push(transport, { type: "message", message: wire(G1, 8, ANN, "还在吗") });
    expect(timeline().querySelector('[data-msg="m8"]').textContent).toContain("还在吗");
  });

  it("quotes: an invisible one says so, a visible file quote shows the file name, names come from people", async () => {
    const sync = () =>
      syncOf(
        [group(G1, { lastSeq: 12, readSeq: 12 })],
        [
          wire(G1, 10, ANN, "看不到原文", { replyTo: { seq: 2, visible: false } }),
          wire(G1, 11, BO, "这个文件", { replyTo: { seq: 5, visible: true, senderId: ANN, text: "", kind: "file", attachmentName: "行程.pdf" } }),
          wire(G1, 12, ME_ID, "好", { replyTo: { seq: 11, visible: true, senderId: BO, text: "这个文件", kind: "text" } }),
        ],
      );
    await openApp({ sync });
    await openChat("周末小组");
    const quotes = [...document.querySelectorAll(".bubble blockquote")].map((x) => x.textContent);
    expect(quotes).toEqual(["引用的消息不在你的可见范围内", "小安行程.pdf", "阿波这个文件"]);
  });

  it("a sender nobody named is 已退出的成员 until an older page names them", async () => {
    const sync = () => syncOf([group(G1, { lastSeq: 40, readSeq: 40 })], [...range(G1, 11, 39, [ANN]), wire(G1, 40, GONE, "我先走了")]);
    const departed = { id: GONE, handle: "gone", displayName: "老周", kind: "human" };
    const { api } = await openApp({ sync, api: { listMessages: vi.fn(async () => ({ messages: [wire(G1, 10, GONE, "最早的一句")], nextBefore: null, principals: { [GONE]: departed } })) } });
    await openChat("周末小组");
    const name = (text) => screen.getByText(text, { selector: ".bubble" }).closest("li").querySelector(".msg-meta strong").textContent;
    expect(name("我先走了")).toBe("已退出的成员");
    expect(screen.getByText("已退出的成员：我先走了")).toBeTruthy();
    fireEvent.scroll(timeline());
    await flush();
    expect(api.listMessages).toHaveBeenCalledTimes(1);
    expect(name("我先走了")).toBe("老周");
    expect(name("最早的一句")).toBe("老周");
  });

  it("user text is never markup", async () => {
    const sync = () => syncOf([direct(D1, ANN, { lastSeq: 1, readSeq: 1 })], [wire(D1, 1, ANN, "<b>粗</b><img src=x onerror=alert(1)>")], [PRINCIPALS[0], { ...PRINCIPALS[1], displayName: "<i>小安</i>" }]);
    await openApp({ sync });
    await openChat("<i>小安</i>");
    expect(screen.getByText("<b>粗</b><img src=x onerror=alert(1)>", { selector: ".bubble" })).toBeTruthy();
    expect(document.querySelector(".main-col b, .main-col i, .main-col img[src=x]")).toBeNull();
  });
});

describe("older history", () => {
  it("scrolling to the top loads the page before the oldest held message, keeps the place, and stops at the start", async () => {
    const page = deferred();
    const { api } = await openApp({ api: { listMessages: vi.fn(() => page.promise) } });
    await openChat("周末小组");
    // a tall list scrolled to the top: m11 is 20 px below the list's top edge
    const list = tallList(0);
    const tops = new Map([["m11", 20]]);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function rect() {
      const top = tops.get(this.dataset?.msg) ?? 0;
      return { top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top, toJSON: () => ({}) };
    });

    fireEvent.scroll(list);
    fireEvent.scroll(list);
    expect(api.listMessages).toHaveBeenCalledTimes(1);
    expect(api.listMessages).toHaveBeenCalledWith(G1, { before: 11, limit: 50 });

    tops.set("m11", 520); // ten older messages of 50 px each now sit above it
    page.resolve({ messages: range(G1, 1, 10, [ANN, BO]), nextBefore: null });
    await flush();
    expect(document.querySelectorAll("ol.messages > li[data-msg]")).toHaveLength(40);
    expect(list.querySelector("li[data-msg]").dataset.msg).toBe("m1");
    expect(list.scrollTop).toBe(500);

    fireEvent.scroll(list);
    await flush();
    expect(api.listMessages).toHaveBeenCalledTimes(1);
  });

  it("a short history that is all there asks for nothing", async () => {
    const { api } = await openApp();
    await openChat("小安");
    fireEvent.scroll(timeline());
    await flush();
    expect(api.listMessages).not.toHaveBeenCalled();
  });

  it("history shorter than the list loads older messages by itself; after a failure only the person asks again", async () => {
    // The list box is taller than its content, so it cannot be scrolled (scrollTop stays 0).
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function height() {
      return this.matches("ol.messages") ? 600 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function height() {
      return this.matches("ol.messages") ? 300 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "scrollTop", "get").mockReturnValue(0);
    const { api, transport } = await openApp({ api: { listMessages: vi.fn(async () => Promise.reject(apiError(503, "busy"))) } });
    await openChat("周末小组");
    expect(api.listMessages).toHaveBeenCalledTimes(1);
    expect(toastText()).toBe("更早的消息加载失败，请稍后再试");
    await elapse(10_000); // the toast clears (a re-render) and much more time passes
    expect(api.listMessages).toHaveBeenCalledTimes(1);
    expect(toastText()).toBeNull();
    await push(transport, { type: "message", message: wire(G1, 41, BO, "新的一条") }); // the list changes
    await elapse(10_000);
    expect(api.listMessages).toHaveBeenCalledTimes(1);

    // opening the chat again asks once more
    await openChat("小安");
    await openChat("周末小组");
    expect(api.listMessages).toHaveBeenCalledTimes(2);
    await elapse(10_000);
    expect(api.listMessages).toHaveBeenCalledTimes(2);

    // so does a scroll at the top (wheel or touch on a list that became scrollable), at most every 3 s
    fireEvent.scroll(timeline());
    await flush();
    expect(api.listMessages).toHaveBeenCalledTimes(3);
    expect(toastText()).toBe("更早的消息加载失败，请稍后再试");
    fireEvent.scroll(timeline());
    await flush();
    expect(api.listMessages).toHaveBeenCalledTimes(3);
  });

  it("scrolled up: a message arriving does not move the list; at the bottom it follows", async () => {
    const { transport } = await openApp();
    await openChat("周末小组");
    // (At the end, then scrolled up by the person.)
    const list = tallList(2400);
    fireEvent.scroll(list);
    list.scrollTop = 1000;
    fireEvent.scroll(list);
    await push(transport, { type: "message", message: wire(G1, 41, BO, "新的一条") });
    expect(list.scrollTop).toBe(1000);

    list.scrollTop = 2400;
    fireEvent.scroll(list);
    await push(transport, { type: "message", message: wire(G1, 42, BO, "又一条") });
    expect(list.scrollTop).toBe(3000);
  });
});

describe("composer", () => {
  it("send: appears at once as sending, then sent; Shift+Enter and IME composition do not send", async () => {
    const answer = deferred();
    const { api } = await openApp({ api: { sendMessage: vi.fn(() => answer.promise) } });
    await openChat("小安");
    type("第一行");
    press("Enter", { shiftKey: true });
    press("Enter", { keyCode: 229 });
    expect(api.sendMessage).not.toHaveBeenCalled();
    type("  你好  ");
    press("Enter");
    expect(api.sendMessage).toHaveBeenCalledWith(D1, { clientTxn: "tx-1", text: "你好" });
    expect(input().value).toBe("");
    await flush();
    const mine = () => screen.getByText("你好", { selector: ".bubble" }).closest("li");
    expect(mine().querySelector(".receipt").textContent.trim()).toBe("发送中…");
    answer.resolve({ message: wire(D1, 4, ME_ID, "你好"), duplicate: false });
    await flush();
    expect(mine().querySelector(".receipt").textContent.trim()).toBe("已发送");
  });

  it("Enter twice in a row sends once", async () => {
    const { api } = await openApp();
    await openChat("小安");
    type("只发一次");
    press("Enter");
    press("Enter");
    await flush();
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText("只发一次", { selector: ".bubble" })).toHaveLength(1);
  });

  it("a failed send shows 发送失败，未发布 · 重试, and retry reuses the clientTxn", async () => {
    const sendMessage = vi.fn().mockRejectedValueOnce(apiError(0, "network_error")).mockResolvedValueOnce({ message: wire(D1, 4, ME_ID, "在吗"), duplicate: false });
    const { api } = await openApp({ api: { sendMessage } });
    await openChat("小安");
    type("在吗");
    press("Enter");
    await flush();
    const item = () => screen.getByText("在吗", { selector: ".bubble" }).closest("li");
    expect(within(item()).getByText(/发送失败，未发布/)).toBeTruthy();
    fireEvent.click(within(item()).getByRole("button", { name: /重试/ }));
    await flush();
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(api.sendMessage.mock.calls[1]).toEqual([D1, { clientTxn: "tx-1", text: "在吗" }]);
    expect(within(item()).queryByText(/发送失败/)).toBeNull();
    expect(item().querySelector(".receipt").textContent.trim()).toBe("已发送");
  });

  it("cannot_send shows the hold notice with the real reason and disables the composer", async () => {
    const { api, transport } = await openApp({ api: { sendMessage: vi.fn(async () => Promise.reject(apiError(403, "cannot_send", "blocked"))) } });
    transport.handlers.conversation = () => direct(D1, ANN, { lastSeq: 3, readSeq: 3, canSend: { ok: false, reason: "blocked" } });
    transport.handlers.social = () => ({ ...emptySocial(), friends: [pub(ANN, "ann", "小安")], blockedBy: [pub(ANN, "ann", "小安")] });
    await openChat("小安");
    type("还能发吗");
    press("Enter");
    await flush();
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    const notice = document.querySelector(".chat > .notice");
    expect(notice.textContent).toContain("小安拉黑了你，只能由对方解除");
    // Said once (the notice); the composer offers nothing.
    expect(screen.queryByLabelText("消息内容")).toBeNull();
    expect(document.querySelector(".composer")).toBeNull();
    expect(within(document.querySelector("section.chat")).getAllByText(/小安拉黑了你，只能由对方解除/)).toHaveLength(1);
    expect(within(screen.getByText("还能发吗", { selector: ".bubble" }).closest("li")).getByText(/发送失败，未发布/)).toBeTruthy();
  });

  it("not friends any more: the hold says so", async () => {
    const sync = () => syncOf([direct(D1, ANN, { lastSeq: 1, readSeq: 1, canSend: { ok: false, reason: "not_friends" } })], [wire(D1, 1, ANN, "再见")]);
    await openApp({ sync });
    await openChat("小安");
    expect(document.querySelector(".chat > .notice").textContent).toContain("对方已不是你的好友");
    expect(screen.queryByLabelText("消息内容")).toBeNull();
  });

  it("a reply is sent with replyToSeq and shows the quote meanwhile", async () => {
    const { api } = await openApp();
    await openChat("小安");
    const m2 = screen.getByText("m2", { selector: ".bubble" }).closest("li");
    fireEvent.click(within(m2).getByRole("button", { name: /回复/ }));
    expect(screen.getByText("回复 小安：m2")).toBeTruthy();
    type("收到");
    press("Enter");
    expect(api.sendMessage).toHaveBeenCalledWith(D1, { clientTxn: "tx-1", text: "收到", replyToSeq: 2 });
    await flush();
    expect(screen.queryByText("回复 小安：m2")).toBeNull();
    expect(screen.getByText("收到", { selector: ".bubble" }).querySelector("blockquote").textContent).toBe("小安m2");
  });

  it("@ suggestions list the current members only and insert plain text", async () => {
    await openApp();
    await openChat("周末小组");
    type("@");
    const options = screen.getAllByRole("option").map((o) => o.querySelector("strong").textContent);
    expect(options).toEqual(["小安", "阿波"]);
    fireEvent.click(screen.getAllByRole("option")[1]);
    expect(input().value).toBe("@阿波 ");
  });

  it("text over 8000 characters cannot be sent and says why", async () => {
    const { api } = await openApp();
    await openChat("小安");
    type("字".repeat(8001));
    expect(screen.getByRole("button", { name: "发送" }).disabled).toBe(true);
    expect(document.querySelector(".composer-hint").textContent).toContain("消息最多 8000 字");
    press("Enter");
    expect(api.sendMessage).not.toHaveBeenCalled();
    type("😀".repeat(8000));
    expect(screen.getByRole("button", { name: "发送" }).disabled).toBe(false);
  });

  it("a message of only invisible characters cannot be sent and says why; bidi overrides are not sent", async () => {
    const { api } = await openApp();
    await openChat("小安");
    type("\u200B\u2060\uFEFF");
    expect(screen.getByRole("button", { name: "发送" }).disabled).toBe(true);
    expect(document.querySelector(".composer-hint").textContent).toContain("消息里没有看得见的文字");
    press("Enter");
    expect(api.sendMessage).not.toHaveBeenCalled();
    type("safe\u202Eelif.exe");
    expect(screen.getByRole("button", { name: "发送" }).disabled).toBe(false);
    press("Enter");
    expect(api.sendMessage).toHaveBeenCalledWith(D1, { clientTxn: "tx-1", text: "safeelif.exe" });
  });

  it("characters that show nothing (Hangul filler, Braille blank) cannot be sent; stray controls are dropped before sending", async () => {
    const { api } = await openApp();
    await openChat("小安");
    type("\u{3164}\u{2800}");
    expect(screen.getByRole("button", { name: "发送" }).disabled).toBe(true);
    expect(document.querySelector(".composer-hint").textContent).toContain("消息里没有看得见的文字");
    type("bell\u{7}ed");
    press("Enter");
    expect(api.sendMessage).toHaveBeenCalledWith(D1, { clientTxn: "tx-1", text: "belled" });
  });

  it("drafts are kept per conversation in the data layer", async () => {
    const { layer } = await openApp();
    await openChat("小安");
    type("写了一半");
    await openChat("周末小组");
    expect(input().value).toBe("");
    expect(layer.getSnapshot().model.drafts[D1]).toBe("写了一半");
    type("群里的草稿");
    await openChat("小安");
    expect(input().value).toBe("写了一半");
    expect(layer.getSnapshot().model.drafts[G1]).toBe("群里的草稿");
  });
});

describe("being removed while viewing (Review Focus 3)", () => {
  it("the conversation leaves the list, the main pane shows the empty state and a toast says why", async () => {
    const { transport, api } = await openApp();
    await openChat("周末小组");
    fireEvent.click(screen.getByRole("button", { name: "会话资料" }));
    expect(document.querySelector(".side-col")).toBeTruthy();
    await push(transport, { type: "gone", id: G1 });
    await flush();
    expect(rowNames()).toEqual(["小安"]);
    expect(mainText()).toBe("选择一个会话开始聊天");
    expect(document.querySelector(".side-col")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("你已不在该会话中");
    // a repeated gone changes nothing and asks for nothing
    await push(transport, { type: "gone", id: G1 });
    await flush();
    expect(api.markRead).not.toHaveBeenCalledWith(G1, expect.anything());
    expect(api.listMessages).not.toHaveBeenCalled();
  });

  it("the toast is shown exactly once", async () => {
    const { transport } = await openApp();
    await openChat("周末小组");
    const shown = [];
    const watch = new MutationObserver(() => {
      const now = toastText();
      if (now !== shown[shown.length - 1]) shown.push(now);
    });
    watch.observe(document.body, { childList: true, subtree: true, characterData: true });
    await push(transport, { type: "gone", id: G1 });
    await flush();
    await elapse(5000); // the toast has cleared
    await push(transport, { type: "gone", id: G1 });
    await push(transport, { type: "message", message: wire(D1, 4, ANN, "别的会话还在动") });
    await elapse(10_000);
    watch.disconnect();
    expect(shown.filter((text) => text === "你已不在该会话中")).toHaveLength(1);
    expect(toastText()).toBeNull();
  });
});
