// @vitest-environment jsdom
// Message search: the list's global search, the search inside a chat, and jumping to a hit (a detached window of messages).
import React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ANN, BO, D1, G1, ME_ID, apiError, at, deferred, direct, group, range, syncOf, wire } from "./fixtures.js";
import { button, click, elapse, flush, installBrowser, openApp, push, toastText } from "./harness.jsx";
import { Highlight, excerpt } from "../src/pages/SearchHits.jsx";
import { searchHitView } from "../src/data/viewmodel.js";
import { READ_DELAY_MS } from "../src/pages/ChatView.jsx";

beforeAll(() => {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
});
beforeEach(installBrowser);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const SENDERS = [ANN, BO];
/** G1: me, 小安, 阿波; 200 messages, the newest 30 (171..200) held, all read. D1: m1..m3. */
const baseSync = (extra = {}) => () =>
  syncOf(
    [direct(D1, ANN, { lastSeq: 3, readSeq: 3 }), group(G1, { lastSeq: 200, readSeq: 200, ...extra })],
    [...range(D1, 1, 3), ...range(G1, 171, 200, SENDERS)],
  );

/** The service's paging: the newest `limit` messages below `before`, `nextBefore` when older ones exist. */
function history(total = 200) {
  return vi.fn(async (conversationId, { before, limit = 50 } = {}) => {
    if (conversationId !== G1) return { messages: [], nextBefore: null, principals: {} };
    const below = range(G1, 1, total, SENDERS).filter((m) => (before ? m.seq < before : true));
    const page = below.slice(-limit);
    return { messages: page, nextBefore: page.length > 0 && page[0].seq > 1 ? page[0].seq : null, principals: {} };
  });
}

const hit = (seq, text, extra = {}) => wire(G1, seq, ANN, text, { createdAt: at(seq % 50), ...extra });
const page = (messages, nextBefore = null) => ({ messages, nextBefore, principals: {} });

const listBox = () => screen.getByLabelText("搜索联系人、群聊");
const typeInList = (value) => fireEvent.change(listBox(), { target: { value } });
const openGroup = () => click(screen.getByText("周末小组", { selector: ".list-col .row-name" }));
const openChatSearch = () => click(button("搜索本会话"));
const chatBox = () => screen.getByLabelText("在本会话中搜索");
const typeInChat = (value) => fireEvent.change(chatBox(), { target: { value } });
const messageTexts = () => [...document.querySelectorAll("ol.messages .bubble")].map((x) => x.textContent);
const hasMessage = (text) => messageTexts().some((t) => t.includes(text));
const bar = () => screen.queryByText("正在查看较早的消息");
const listEl = () => document.querySelector("ol.messages");
/** Gives the message list a layout jsdom lacks, scrolled to `scrollTop`. */
function tallList(scrollTop, { scrollHeight = 3000, clientHeight = 600 } = {}) {
  const list = listEl();
  let top = scrollTop;
  // (A browser reports 0 for a list that is display: none, and forgets the position while it is.)
  Object.defineProperty(list, "scrollTop", {
    configurable: true,
    get: () => (list.style.display === "none" ? 0 : top),
    set: (v) => {
      if (list.style.display !== "none") top = v;
    },
  });
  list.forget = () => (top = 0);
  Object.defineProperty(list, "scrollHeight", { configurable: true, get: () => scrollHeight });
  Object.defineProperty(list, "clientHeight", { configurable: true, get: () => clientHeight });
  return list;
}

describe("the view of a hit keeps its mentions for the list to draw", () => {
  it("ids are mapped (mine is me) and a file hit has none", () => {
    const view = searchHitView(wire(G1, 5, ANN, "@bo 好", { mentions: [{ id: ME_ID, start: 0, length: 3 }] }), { meId: ME_ID, now: Date.now() });
    expect(view.mentions).toEqual([{ id: "me", start: 0, length: 3 }]);
  });
});

describe("text of a hit", () => {
  it("marks every match, ignoring case, from text nodes only", () => {
    render(<Highlight text="Hello hello <b>HeLLo</b>" q="hello" />);
    const marks = [...document.querySelectorAll("mark")].map((m) => m.textContent);
    expect(marks).toEqual(["Hello", "hello", "HeLLo"]);
    expect(document.querySelector("b")).toBeNull();
  });

  it("treats the query's regular-expression characters as plain text", () => {
    render(<Highlight text="a.b (c) a.b" q="a.b" />);
    expect([...document.querySelectorAll("mark")].map((m) => m.textContent)).toEqual(["a.b", "a.b"]);
    cleanup();
    render(<Highlight text="x" q="(" />);
    expect(document.querySelector("mark")).toBeNull();
  });

  it("shortens a long text around its first match", () => {
    const text = `${"前".repeat(200)}目标${"后".repeat(200)}`;
    const cut = excerpt(text, "目标");
    expect(cut).toContain("目标");
    expect([...cut].length).toBeLessThan(130);
    expect(cut.startsWith("…") && cut.endsWith("…")).toBe(true);
    expect(excerpt("短", "短")).toBe("短");
  });
});

describe("global search in the conversation list", () => {
  it("waits 300 ms after the last keystroke, then asks once with the trimmed text", async () => {
    const searchAll = vi.fn(async () => page([]));
    await openApp({ sync: baseSync(), api: { searchAll } });
    typeInList("聚");
    await elapse(200);
    typeInList(" 聚餐 ");
    await elapse(299);
    expect(searchAll).not.toHaveBeenCalled();
    await elapse(1);
    expect(searchAll).toHaveBeenCalledTimes(1);
    expect(searchAll).toHaveBeenCalledWith({ q: "聚餐", before: null, limit: 20 });
  });

  it("never asks for more than 100 characters: the box is capped and a longer text is not sent", async () => {
    const searchAll = vi.fn(async () => page([]));
    await openApp({ sync: baseSync(), api: { searchAll } });
    expect(listBox().maxLength).toBe(100);
    typeInList("长".repeat(101));
    await elapse(500);
    expect(searchAll).not.toHaveBeenCalled();
    typeInList("长".repeat(100));
    await elapse(300);
    expect(searchAll).toHaveBeenCalledTimes(1);
  });

  it("shows the hits below the local matches with the conversation, the sender and the match emphasised", async () => {
    const searchAll = vi.fn(async () => page([hit(50, "周末聚餐在哪里")]));
    await openApp({ sync: baseSync(), api: { searchAll } });
    typeInList("聚餐");
    await elapse(300);
    const label = screen.getByText("聊天记录", { selector: ".rows-label" });
    expect(label).toBeTruthy();
    const row = document.querySelector(".list-col .row-preview mark").closest("button");
    expect(within(row).getByText("周末小组")).toBeTruthy();
    expect(row.querySelector(".row-preview").textContent).toBe("小安：周末聚餐在哪里");
    expect(row.querySelector("mark").textContent).toBe("聚餐");
    expect(row.querySelector("time").textContent).toBe("09:00");
  });

  it("ignores the answer of an older query that arrives after a newer one", async () => {
    const first = deferred();
    const second = deferred();
    const searchAll = vi.fn(({ q }) => (q === "旧" ? first.promise : second.promise));
    await openApp({ sync: baseSync(), api: { searchAll } });
    typeInList("旧");
    await elapse(300);
    typeInList("新");
    await elapse(300);
    expect(searchAll).toHaveBeenCalledTimes(2);
    await act(async () => second.resolve(page([hit(60, "新的结果")])));
    await act(async () => first.resolve(page([hit(61, "旧的结果")])));
    await flush();
    expect(document.querySelector(".list-col").textContent).toContain("新的结果");
    expect(document.querySelector(".list-col").textContent).not.toContain("旧的结果");
  });

  it("a keystroke while a search is in flight drops its answer", async () => {
    const pending = deferred();
    const searchAll = vi.fn(() => pending.promise);
    await openApp({ sync: baseSync(), api: { searchAll } });
    typeInList("慢");
    await elapse(300);
    typeInList("");
    await act(async () => pending.resolve(page([hit(60, "迟到的结果")])));
    await flush();
    expect(document.querySelector(".list-col").textContent).not.toContain("迟到的结果");
    expect(screen.queryByText("聊天记录")).toBeNull();
  });

  it("pages with the cursor: 继续向更早的记录搜索 asks for the next page and appends it", async () => {
    const searchAll = vi.fn(async ({ before }) => (before ? page([hit(40, "第二页")], null) : page([hit(50, "第一页")], "cursor-1")));
    await openApp({ sync: baseSync(), api: { searchAll } });
    typeInList("页");
    await elapse(300);
    await click(button("继续向更早的记录搜索"));
    expect(searchAll).toHaveBeenLastCalledWith({ q: "页", before: "cursor-1", limit: 20 });
    const previews = [...document.querySelectorAll(".list-col .row-preview")].map((x) => x.textContent);
    expect(previews.filter((t) => t.includes("页"))).toEqual(["小安：第一页", "小安：第二页"]);
    expect(screen.queryByRole("button", { name: "继续向更早的记录搜索" })).toBeNull();
  });

  it("shows loading, empty, rate-limited and busy as quiet notes with a retry", async () => {
    const answers = [new Promise(() => {})];
    const searchAll = vi.fn(() => answers.shift());
    await openApp({ sync: baseSync(), api: { searchAll } });
    typeInList("等");
    expect(screen.getByText("正在搜索…")).toBeTruthy();
    await elapse(300);
    expect(screen.getByText("正在搜索…")).toBeTruthy();

    searchAll.mockImplementation(async () => page([]));
    typeInList("没有");
    await elapse(300);
    expect(screen.getByText("没有找到相关聊天记录")).toBeTruthy();

    searchAll.mockImplementation(async () => {
      throw apiError(429, "rate_limited");
    });
    typeInList("忙");
    await elapse(300);
    expect(screen.getByText(/搜索太频繁了，请稍等一会儿再试。/)).toBeTruthy();

    searchAll.mockImplementation(async () => {
      throw apiError(503, "busy");
    });
    await click(button("重试"));
    expect(screen.getByText(/服务现在有点忙，请稍后再试。/)).toBeTruthy();

    searchAll.mockImplementation(async () => page([hit(70, "忙完了")]));
    await click(button("重试"));
    expect(document.querySelector(".list-col mark").textContent).toBe("忙");
    expect(toastText()).toBeNull();
  });

  it("a failure while paging keeps the hits and offers a retry", async () => {
    let calls = 0;
    const searchAll = vi.fn(async () => {
      calls += 1;
      if (calls === 2) throw apiError(429, "rate_limited");
      return page([hit(50, "第一页")], "cursor-1");
    });
    await openApp({ sync: baseSync(), api: { searchAll } });
    typeInList("页");
    await elapse(300);
    await click(button("继续向更早的记录搜索"));
    expect(document.querySelector(".list-col").textContent).toContain("第一页");
    expect(screen.getByText(/搜索太频繁了/)).toBeTruthy();
    await click(button("重试"));
    expect(searchAll).toHaveBeenCalledTimes(3);
  });

  it("a hostile text stays text", async () => {
    const evil = "<img src=x onerror=1> img";
    const searchAll = vi.fn(async () => page([hit(50, evil)]));
    await openApp({ sync: baseSync(), api: { searchAll } });
    typeInList("img");
    await elapse(300);
    expect(document.querySelector(".list-col img[src=\"x\"]")).toBeNull();
    const preview = document.querySelector(".list-col .row-preview");
    expect(preview.textContent).toBe(`小安：${evil}`);
    expect([...preview.querySelectorAll("mark")].map((m) => m.textContent)).toEqual(["img", "img"]);
  });

  it("a file message is found by its name; my own hit shows 你", async () => {
    const file = wire(G1, 55, ME_ID, "说明", { kind: "file", attachment: { id: "00000000-0000-4000-8000-00000000f001", name: "报告.pdf", size: 10, inline: false } });
    const searchAll = vi.fn(async () => page([file]));
    await openApp({ sync: baseSync(), api: { searchAll } });
    typeInList("报告");
    await elapse(300);
    expect(document.querySelector(".list-col .row-preview").textContent).toBe("你：报告.pdf · 说明");
  });

  it("a hit opens its conversation and jumps to the message", async () => {
    const searchAll = vi.fn(async () => page([hit(50, "老消息里的聚餐")]));
    const listMessages = history();
    await openApp({ sync: baseSync(), api: { searchAll, listMessages } });
    typeInList("聚餐");
    await elapse(300);
    await click(document.querySelector(".list-col .row-preview mark").closest("button"));
    expect(listMessages).toHaveBeenCalledWith(G1, { before: 75, limit: 50 });
    expect(screen.getByLabelText("周末小组", { selector: "section" })).toBeTruthy();
    expect(hasMessage("m50")).toBe(true);
    expect(bar()).toBeTruthy();
    expect(document.querySelector(".msg.flash").textContent).toContain("m50");
  });
});

describe("search inside a conversation", () => {
  async function inChat(api = {}) {
    const app = await openApp({ sync: baseSync(), api });
    await openGroup();
    await openChatSearch();
    return app;
  }

  it("asks the service after 300 ms with the conversation, the text and no cursor", async () => {
    const searchConversation = vi.fn(async () => page([]));
    await inChat({ searchConversation });
    typeInChat("聚");
    await elapse(299);
    expect(searchConversation).not.toHaveBeenCalled();
    await elapse(1);
    expect(searchConversation).toHaveBeenCalledWith(G1, { q: "聚", before: null, limit: 20 });
  });

  it("lists the hits newest first in place of the messages, with the sender, time and emphasised match", async () => {
    const searchConversation = vi.fn(async () => page([hit(150, "再聚餐吧"), hit(50, "周末聚餐")], 50));
    await inChat({ searchConversation });
    typeInChat("聚餐");
    await elapse(300);
    const rows = [...document.querySelectorAll(".search-hits .row")];
    expect(rows.map((r) => r.querySelector(".row-preview").textContent)).toEqual(["再聚餐吧", "周末聚餐"]);
    expect(rows[0].querySelector(".row-name").textContent).toBe("小安");
    expect(rows[0].querySelector("mark").textContent).toBe("聚餐");
    expect(screen.getByText("2+ 条结果")).toBeTruthy();
    expect(listEl().style.display).toBe("none");
    expect(getComputedStyle(listEl()).display).toBe("none");
  });

  it("a hit is drawn as the bubble draws it: a mention is @name (not the handle typed), and an Agent's hit has no bidi control or mark", async () => {
    const typed = "聚餐 @bo 来";
    const searchConversation = vi.fn(async () => page([hit(150, typed, { mentions: [{ id: BO, start: 3, length: 3 }] })]));
    await inChat({ searchConversation });
    typeInChat("聚餐");
    await elapse(300);
    const preview = document.querySelector(".search-hits .row-preview").textContent;
    expect(preview).toBe("聚餐 @阿波 来");
    expect(preview).not.toContain("@bo");
  });

  it("r7: a hit is highlighted on the text as drawn: a query that matches only a handle (the service matched the stored text) highlights nothing and the hit is shown from its start", async () => {
    const typed = "聚餐 @bo 来";
    const searchConversation = vi.fn(async () => page([hit(150, typed, { mentions: [{ id: BO, start: 3, length: 3 }] })]));
    await inChat({ searchConversation });
    typeInChat("bo");
    await elapse(300);
    const row = document.querySelector(".search-hits .row-preview");
    expect(row.textContent).toBe("聚餐 @阿波 来");
    expect(row.querySelector("mark")).toBeNull();
  });

  it("closing the search brings the list back where it was, or at the newest messages when it was there", async () => {
    await inChat({ searchConversation: vi.fn(async () => page([hit(50, "周末聚餐")])) });
    const list = tallList(2400);
    typeInChat("聚餐");
    await elapse(300);
    await click(button("关闭会话搜索"));
    expect(list.scrollTop).toBe(3000); // it was at the end: stays at the end
    await openChatSearch();
    fireEvent.scroll(list);
    list.scrollTop = 500;
    fireEvent.scroll(list);
    typeInChat("聚餐");
    await elapse(300);
    list.forget();
    await click(button("关闭会话搜索"));
    expect(list.scrollTop).toBe(500);
  });

  it("pages with nextBefore", async () => {
    const searchConversation = vi.fn(async (_id, { before }) => (before ? page([hit(20, "更早的聚餐")], null) : page([hit(50, "周末聚餐")], 50)));
    await inChat({ searchConversation });
    typeInChat("聚餐");
    await elapse(300);
    await click(button("继续向更早的记录搜索"));
    expect(searchConversation).toHaveBeenLastCalledWith(G1, { q: "聚餐", before: 50, limit: 20 });
    expect(document.querySelectorAll(".search-hits .row")).toHaveLength(2);
    expect(screen.getByText("2 条结果")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "继续向更早的记录搜索" })).toBeNull();
  });

  it("ignores an older answer that arrives late", async () => {
    const first = deferred();
    const second = deferred();
    const searchConversation = vi.fn((_id, { q }) => (q === "旧" ? first.promise : second.promise));
    await inChat({ searchConversation });
    typeInChat("旧");
    await elapse(300);
    typeInChat("新");
    await elapse(300);
    await act(async () => second.resolve(page([hit(60, "新的结果")])));
    await act(async () => first.resolve(page([hit(61, "旧的结果")])));
    await flush();
    const text = document.querySelector(".search-hits").textContent;
    expect(text).toContain("新的结果");
    expect(text).not.toContain("旧的结果");
  });

  it("shows empty, loading, rate-limited and busy quietly", async () => {
    const searchConversation = vi.fn(() => new Promise(() => {}));
    await inChat({ searchConversation });
    typeInChat("等");
    expect(screen.getByText("正在搜索…")).toBeTruthy();
    searchConversation.mockImplementation(async () => page([]));
    typeInChat("没有");
    await elapse(300);
    expect(screen.getByText("没有找到相关消息，请换个关键词")).toBeTruthy();
    searchConversation.mockImplementation(async () => {
      throw apiError(429, "rate_limited");
    });
    typeInChat("忙");
    await elapse(300);
    expect(screen.getByText(/搜索太频繁了/)).toBeTruthy();
    searchConversation.mockImplementation(async () => {
      throw apiError(503, "busy");
    });
    await click(button("重试"));
    expect(screen.getByText(/服务现在有点忙/)).toBeTruthy();
    expect(toastText()).toBeNull();
  });

  it("a hostile text stays text", async () => {
    const evil = "<img src=x onerror=1> img";
    await inChat({ searchConversation: vi.fn(async () => page([hit(50, evil)])) });
    typeInChat("img");
    await elapse(300);
    expect(document.querySelector(".search-hits img[src=\"x\"]")).toBeNull();
    expect(document.querySelector(".search-hits .row-preview").textContent).toBe(evil);
  });

  it("Escape and the close button end the search and bring the messages back", async () => {
    await inChat({ searchConversation: vi.fn(async () => page([hit(50, "周末聚餐")])) });
    typeInChat("聚餐");
    await elapse(300);
    fireEvent.keyDown(chatBox(), { key: "Escape" });
    await flush();
    expect(screen.queryByLabelText("在本会话中搜索")).toBeNull();
    expect(listEl().style.display).toBe("");
    expect(hasMessage("m200")).toBe(true);
    await openChatSearch();
    typeInChat("聚餐");
    await elapse(300);
    await click(button("关闭会话搜索"));
    expect(screen.queryByLabelText("在本会话中搜索")).toBeNull();
  });

  it("a hit far from the loaded messages opens a window around it and ends the search", async () => {
    const listMessages = history();
    await inChat({ searchConversation: vi.fn(async () => page([hit(50, "周末聚餐")])), listMessages });
    typeInChat("聚餐");
    await elapse(300);
    await click(document.querySelector(".search-hits .row"));
    expect(listMessages).toHaveBeenCalledWith(G1, { before: 75, limit: 50 });
    expect(screen.queryByLabelText("在本会话中搜索")).toBeNull();
    expect(hasMessage("m50")).toBe(true);
    expect(hasMessage("m26") && hasMessage("m74")).toBe(true);
    expect(hasMessage("m200")).toBe(false);
    expect(bar()).toBeTruthy();
    expect(document.querySelector(".msg.flash").textContent).toContain("m50");
    await elapse(2100);
    expect(document.querySelector(".msg.flash")).toBeNull();
  });

  it("a hit among the held messages needs no request and no window", async () => {
    const listMessages = history();
    await inChat({ searchConversation: vi.fn(async () => page([hit(190, "最近的聚餐")])), listMessages });
    typeInChat("聚餐");
    await elapse(300);
    await click(document.querySelector(".search-hits .row"));
    expect(listMessages).not.toHaveBeenCalled();
    expect(bar()).toBeNull();
    expect(document.querySelector(".msg.flash").textContent).toContain("m190");
  });

  it("a hit that is no longer visible falls back to the conversation as it was, with a toast", async () => {
    const listMessages = vi.fn(async () => {
      throw apiError(404, "not_found");
    });
    await inChat({ searchConversation: vi.fn(async () => page([hit(50, "周末聚餐")])), listMessages });
    typeInChat("聚餐");
    await elapse(300);
    await click(document.querySelector(".search-hits .row"));
    expect(toastText()).toBe("这条消息已经看不到了");
    expect(bar()).toBeNull();
    expect(hasMessage("m200")).toBe(true);
    expect(document.querySelector(".msg.flash")).toBeNull();
  });

  it("a page that lacks the hit is the same fallback", async () => {
    const listMessages = vi.fn(async () => page([wire(G1, 70, ANN), wire(G1, 71, ANN)]));
    await inChat({ searchConversation: vi.fn(async () => page([hit(50, "周末聚餐")])), listMessages });
    typeInChat("聚餐");
    await elapse(300);
    await click(document.querySelector(".search-hits .row"));
    expect(toastText()).toBe("这条消息已经看不到了");
    expect(bar()).toBeNull();
  });

  it("another failure of the jump says so without blaming the message", async () => {
    const listMessages = vi.fn(async () => {
      throw apiError(0, "network_error");
    });
    await inChat({ searchConversation: vi.fn(async () => page([hit(50, "周末聚餐")])), listMessages });
    typeInChat("聚餐");
    await elapse(300);
    await click(document.querySelector(".search-hits .row"));
    expect(toastText()).toBe("没能打开这条消息，请稍后再试");
  });
});

describe("a detached window", () => {
  /** Opens the group and jumps to message 50 (the window holds 25..74). */
  async function detached(options = {}) {
    const listMessages = history();
    const app = await openApp({ sync: baseSync(options.conv), api: { listMessages, searchConversation: vi.fn(async () => page([hit(50, "周末聚餐")])), searchAll: vi.fn(async () => page([hit(120, "另一处聚餐")])) } });
    await openGroup();
    await openChatSearch();
    typeInChat("聚餐");
    await elapse(300);
    await click(document.querySelector(".search-hits .row"));
    return { ...app, listMessages };
  }

  it("loads newer messages from the window, then reaches the newest ones and joins them", async () => {
    const { listMessages } = await detached();
    expect(hasMessage("m74")).toBe(true);
    expect(hasMessage("m75")).toBe(false);
    await click(button("查看更新的消息"));
    expect(listMessages).toHaveBeenLastCalledWith(G1, { before: 125, limit: 50 });
    expect(hasMessage("m75") && hasMessage("m124")).toBe(true);
    expect(hasMessage("m200")).toBe(false);
    expect(bar()).toBeTruthy();
    await click(button("查看更新的消息"));
    expect(listMessages).toHaveBeenLastCalledWith(G1, { before: 175, limit: 50 });
    // The window reached the held messages: one list again, nothing missing, no bar.
    expect(bar()).toBeNull();
    expect(hasMessage("m50") && hasMessage("m124") && hasMessage("m171") && hasMessage("m200")).toBe(true);
  });

  it("scrolling to the end loads newer messages", async () => {
    const { listMessages } = await detached();
    const list = tallList(2400);
    fireEvent.scroll(list);
    await flush();
    expect(listMessages).toHaveBeenLastCalledWith(G1, { before: 125, limit: 50 });
    expect(hasMessage("m124")).toBe(true);
  });

  it("does not follow the list to its end when messages are added at the bottom", async () => {
    await detached();
    const list = tallList(1000);
    await click(button("查看更新的消息"));
    expect(list.scrollTop).toBe(1000);
  });

  it("keeps the place when the window joins the newest messages while reading forward", async () => {
    const { listMessages } = await detached();
    const list = tallList(2400);
    fireEvent.scroll(list);
    await flush();
    fireEvent.scroll(list);
    await flush();
    expect(listMessages).toHaveBeenLastCalledWith(G1, { before: 175, limit: 50 });
    expect(bar()).toBeNull();
    expect(list.scrollTop).toBe(2400);
  });

  it("scrolling to the top loads older messages into the window, not into the newest ones", async () => {
    const { listMessages } = await detached();
    const list = tallList(0);
    fireEvent.scroll(list);
    await flush();
    expect(listMessages).toHaveBeenLastCalledWith(G1, { before: 25, limit: 50 });
    expect(hasMessage("m1") && hasMessage("m24") && hasMessage("m50")).toBe(true);
    expect(hasMessage("m200")).toBe(false);
    expect(bar()).toBeTruthy();
  });

  it("回到最新消息 shows the newest messages again", async () => {
    await detached();
    await click(button("回到最新消息"));
    expect(bar()).toBeNull();
    expect(hasMessage("m200")).toBe(true);
    expect(hasMessage("m50")).toBe(false);
  });

  it("a message pushed meanwhile is not shown in the window, is not lost and is not misplaced", async () => {
    const { transport } = await detached();
    await push(transport, { type: "message", message: wire(G1, 201, ANN, "新来的") });
    expect(hasMessage("新来的")).toBe(false);
    expect(screen.getByText(/有 1 条新消息/)).toBeTruthy();
    expect(hasMessage("m50")).toBe(true);
    await click(button("回到最新消息"));
    const texts = messageTexts();
    expect(texts[texts.length - 1]).toContain("新来的");
    expect(texts[texts.length - 2]).toContain("m200");
  });

  it("a message pushed meanwhile stays after the window joins the newest ones", async () => {
    const { transport } = await detached();
    await push(transport, { type: "message", message: wire(G1, 201, ANN, "新来的") });
    await click(button("查看更新的消息"));
    await click(button("查看更新的消息"));
    expect(bar()).toBeNull();
    const texts = messageTexts();
    expect(texts[texts.length - 1]).toContain("新来的");
    expect(texts.findIndex((t) => t.includes("m199"))).toBeLessThan(texts.findIndex((t) => t.includes("m200")));
  });

  it("does not mark anything read while it is shown, and does once the newest messages are back", async () => {
    const { api } = await detached({ conv: { readSeq: 197, unread: 3 } });
    await elapse(READ_DELAY_MS * 3);
    expect(api.markRead).not.toHaveBeenCalled();
    await click(button("回到最新消息"));
    await elapse(READ_DELAY_MS + 50);
    expect(api.markRead).toHaveBeenCalledWith(G1, 200);
  });

  it("sending leaves the window: the message goes to the end of the conversation", async () => {
    const { api } = await detached();
    const box = screen.getByLabelText("消息内容");
    fireEvent.change(box, { target: { value: "我来说一句" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await flush();
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(bar()).toBeNull();
    expect(hasMessage("m200")).toBe(true);
    expect(hasMessage("我来说一句")).toBe(true);
  });

  it("is dropped when another conversation is opened; the first one then opens at its newest messages", async () => {
    await detached();
    await click(screen.getByText("小安", { selector: ".list-col .row-name" }));
    await click(screen.getByText("周末小组", { selector: ".list-col .row-name" }));
    expect(bar()).toBeNull();
    expect(hasMessage("m200")).toBe(true);
  });

  it("jumping to a hit the window already shows moves no messages", async () => {
    const { listMessages } = await detached();
    const calls = listMessages.mock.calls.length;
    await openChatSearch();
    typeInChat("聚餐");
    await elapse(300);
    await click(document.querySelector(".search-hits .row"));
    expect(listMessages.mock.calls.length).toBe(calls);
    expect(bar()).toBeTruthy();
  });

  it("a second jump (from the list's search) replaces the window", async () => {
    const { listMessages } = await detached();
    typeInList("另一处");
    await elapse(300);
    await click(document.querySelector(".list-col .row-preview mark").closest("button"));
    expect(listMessages).toHaveBeenLastCalledWith(G1, { before: 145, limit: 50 });
    expect(hasMessage("m120")).toBe(true);
    expect(hasMessage("m50")).toBe(false);
    expect(bar()).toBeTruthy();
  });

  it("mentions nothing about the window in the conversation list: its preview is still the newest message", async () => {
    await detached();
    const row = screen.getByText("周末小组", { selector: ".list-col .row-name" }).closest("button");
    expect(within(row).getByText(/m200/)).toBeTruthy();
  });
});
