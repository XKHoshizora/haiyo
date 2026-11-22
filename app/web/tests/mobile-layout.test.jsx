// @vitest-environment jsdom
// The phone layout in the DOM: below 641px the rail is a bottom tab bar on the top-level list pages and is gone inside a
// conversation; wider screens are untouched. (How it looks is pinned by tests/mobile-styles.test.js and e2e/mobile.spec.mjs.)
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ANN, D1, G1, deferred, direct, group, syncOf, wire } from "./fixtures.js";
import { flush, goContacts, installBrowser, openApp, toastText } from "./harness.jsx";
import { COARSE_QUERY, PHONE_QUERY } from "../src/ui/pointer.js";
import { AvatarDialog } from "../src/pages/AvatarDialog.jsx";

/** A window whose media queries answer from `on` (the queries that match). */
function media(on) {
  window.matchMedia = (query) => ({ matches: on.includes(query), media: query, addEventListener() {}, removeEventListener() {} });
}

beforeEach(() => installBrowser());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete window.matchMedia;
});

const sync = () => syncOf([direct(D1, ANN, { lastSeq: 3, readSeq: 1, unread: 2 })], [wire(D1, 1, ANN, "早"), wire(D1, 2, ANN, "在吗"), wire(D1, 3, ANN, "喂")]);
const bar = () => screen.queryByRole("navigation", { name: "主导航" });

describe("on a phone", () => {
  beforeEach(() => media([PHONE_QUERY, COARSE_QUERY]));

  it("the conversation list has the four entries along the bottom, the unread badge on 消息, no brand mark and no avatar entry", async () => {
    await openApp({ sync });
    expect(bar()).toBeTruthy();
    expect(document.querySelector(".app").dataset.tabbar).toBe("on");
    const names = within(bar()).getAllByRole("button").map((b) => b.textContent.replace(/\d+/g, ""));
    expect(names).toEqual(["消息", "通讯录", "Agent", "设置"]);
    expect(within(bar()).getByRole("button", { name: /消息$/ }).getAttribute("aria-current")).toBe("page");
    expect(bar().querySelector(".badge").textContent).toBe("2");
    expect(bar().querySelector(".brand-mark")).toBeNull();
    expect(bar().querySelector(".rail-me")).toBeNull();
    // The header already says the name.
    expect(document.querySelector(".list-head .brand-name")).toBeTruthy();
  });

  it("is gone inside a conversation, and back with the list", async () => {
    await openApp({ sync });
    fireEvent.click(document.querySelector(".list-col .row"));
    await flush();
    expect(bar()).toBeNull();
    expect(document.querySelector(".app").dataset.tabbar).toBe("off");
    fireEvent.click(screen.getByRole("button", { name: "返回列表" }));
    await flush();
    expect(bar()).toBeTruthy();
  });

  it("switches tabs; 设置 lands on the settings list, not on a page", async () => {
    await openApp({ sync });
    await goContacts();
    expect(within(bar()).getByRole("button", { name: /^通讯录/ }).getAttribute("aria-current")).toBe("page");
    expect(bar()).toBeTruthy();
    fireEvent.click(within(bar()).getByRole("button", { name: /^设置/ }));
    await flush();
    expect(document.querySelector(".app").dataset.pane).toBe("list");
    expect(bar()).toBeTruthy();
    expect(document.querySelector(".list-col .settings-me")).toBeTruthy();
    // A settings page is a pushed page: no bar, a back button.
    fireEvent.click(screen.getByText("模型供应商", { selector: ".list-col .row-name" }));
    await flush();
    expect(bar()).toBeNull();
  });
});

describe("on a tablet or a desktop", () => {
  it("nothing changes: the rail with the brand mark and the avatar stays, also inside a conversation", async () => {
    media([COARSE_QUERY]); // a touch tablet: wide
    await openApp({ sync });
    expect(bar().querySelector(".brand-mark")).toBeTruthy();
    expect(bar().querySelector(".rail-me")).toBeTruthy();
    expect(document.querySelector(".app").dataset.tabbar).toBe("off");
    fireEvent.click(document.querySelector(".list-col .row"));
    await flush();
    expect(bar()).toBeTruthy();
  });

  it("设置 is its list at every width; the profile is drawn beside it by default (no width in what the page is)", async () => {
    await openApp({ sync });
    fireEvent.click(within(bar()).getByRole("button", { name: /^设置/ }));
    await flush();
    expect(document.querySelector(".app").dataset.pane).toBe("list");
    expect(document.querySelector(".main-col").textContent).toContain("我的资料");
    expect(window.location.pathname).toBe("/settings");
  });

});

describe("hints for a keyboard and a mouse", () => {
  const composerHint = () => document.querySelector(".composer-hint")?.textContent ?? "";

  it("show on a mouse and are gone on a touch screen", async () => {
    await openApp({ sync });
    fireEvent.click(document.querySelector(".list-col .row"));
    await flush();
    expect(composerHint()).toBe("Enter 发送 · Shift+Enter 换行");
    cleanup();
    media([COARSE_QUERY]);
    await openApp({ sync });
    fireEvent.click(document.querySelector(".list-col .row"));
    await flush();
    expect(composerHint()).toBe("");
    expect(document.body.textContent).not.toContain("Shift+Enter");
  });

  it("the avatar dialog's help says what a finger does", async () => {
    const props = { file: new File(["x"], "me.png", { type: "image/png" }), onSave: async () => "", onCancel() {} };
    render(<AvatarDialog {...props} />);
    await act(async () => {});
    expect(document.body.textContent).toContain("拖动调整位置，滑块或滚轮缩放。");
    cleanup();
    media([COARSE_QUERY]);
    render(<AvatarDialog {...props} />);
    await act(async () => {});
    expect(document.body.textContent).toContain("拖动调整位置，双指或滑块缩放。");
    expect(document.body.textContent).not.toContain("滚轮");
  });
});

describe("the avatar dialog's save button", () => {
  it("keeps its class while it says 保存中…, so its width holds", async () => {
    let finish;
    const props = { file: new File(["x"], "me.png", { type: "image/png" }), onSave: () => new Promise((r) => (finish = r)), onCancel() {} };
    render(<AvatarDialog {...props} />);
    await act(async () => {});
    const save = () => screen.getByRole("button", { name: /^保存/ });
    expect(save().className).toContain("btn-save");
    fireEvent.click(save());
    await act(async () => {});
    expect(save().textContent).toBe("保存中…");
    expect(save().className).toContain("btn-save");
    await act(async () => finish(""));
  });
});

describe("the chat header of a group", () => {
  const groupSync = () => syncOf([group(G1, { lastSeq: 1, readSeq: 1 })], [wire(G1, 1, ANN, "早")]);
  const open = async () => {
    await openApp({ sync: groupSync });
    fireEvent.click(document.querySelector(".list-col .row"));
    await flush();
  };

  it("on a phone 群资料 is an icon button with its name (the row has room for it beside the search and the menu)", async () => {
    media([PHONE_QUERY, COARSE_QUERY]);
    await open();
    const head = document.querySelector(".chat-head");
    const button = within(head).getByRole("button", { name: "群资料" });
    expect(button.textContent).toBe("");
    expect(button.querySelector("svg")).toBeTruthy();
    expect(within(head).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual(["返回列表", "搜索本会话", "群资料", "会话资料"]);
  });

  it("on a wide screen it is the text button, as before", async () => {
    await open();
    expect(within(document.querySelector(".chat-head")).getByRole("button", { name: "群资料" }).textContent).toBe("群资料");
  });
});

describe("an address of a conversation that is not here", () => {
  const GONE = "00000000-0000-4000-8000-0000000000ee";

  it("a link or reload on it draws the list with the existing notice, and the entry becomes the list", async () => {
    window.history.replaceState(null, "", `/chat/${GONE}`);
    await openApp({ sync });
    await flush();
    expect(window.location.pathname).toBe("/");
    expect(document.querySelector(".toast")?.textContent).toBe("找不到这个会话，或你已不在其中");
    expect(document.querySelector(".app").dataset.pane).toBe("list");
    expect(document.querySelector(".list-col .row")).toBeTruthy();
  });

  it("Forward to a conversation that is gone by then shows the list, not the conversation (and not an 8 s wait)", async () => {
    const { env, layer } = await openApp({ sync });
    fireEvent.click(document.querySelector(".list-col .row"));
    await flush();
    const path = window.location.pathname;
    expect(path).toMatch(/^\/chat\//);
    await act(async () => {
      window.history.back();
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(window.location.pathname).toBe("/");
    env.sync = () => syncOf([], []);
    await act(async () => layer.actions.syncNow());
    await flush();
    await act(async () => {
      window.history.forward();
      await vi.advanceTimersByTimeAsync(50);
    });
    await flush();
    expect(window.location.pathname).toBe("/");
    expect(document.querySelector(".app").dataset.pane).toBe("list");
  });
});

describe("addresses of other pages that do not resolve", () => {
  const cold = async (path) => {
    window.history.replaceState(null, "", path);
    await openApp({ sync });
    await flush();
  };

  it("/contacts/<nobody> is the contacts list with a notice (never a dead end), the entry is the list", async () => {
    await cold("/contacts/00000000-0000-4000-8000-0000000000ee");
    expect(window.location.pathname).toBe("/contacts");
    expect(toastText()).toBe("找不到这位联系人");
    expect(document.querySelector(".app").dataset.pane).toBe("list");
  });

  it("/agents/<not mine> is the Agents list with a notice", async () => {
    await cold("/agents/00000000-0000-4000-8000-0000000000ee");
    expect(window.location.pathname).toBe("/agents");
    expect(toastText()).toBe("找不到这个 Agent");
  });

  it("/chat/<a 1:1 chat>/info is the chat, not group info", async () => {
    await cold(`/chat/${D1}/info`);
    expect(window.location.pathname).toBe(`/chat/${D1}`);
    expect(document.querySelector('[aria-label="群资料"]')).toBeNull();
  });
});

describe("the lists before the first sync has answered", () => {
  it("say loading, never the empty state; the empty state only when the answer is empty", async () => {
    const answer = deferred();
    await openApp({ sync: () => answer.promise });
    const list = () => document.querySelector(".list-col").textContent;
    expect(list()).toContain("正在读取…");
    expect(list()).not.toContain("还没有会话");
    await act(async () => answer.resolve(syncOf([])));
    await flush();
    expect(list()).toContain("还没有会话");
    expect(list()).not.toContain("正在读取…");
  });

  it("the Agents list and the contacts list the same", async () => {
    const answer = deferred();
    await openApp({ sync: () => answer.promise });
    fireEvent.click(within(document.querySelector(".rail")).getByRole("button", { name: /^Agent/ }));
    await flush();
    expect(document.querySelector(".list-col").textContent).toContain("正在读取…");
    expect(document.querySelector(".list-col").textContent).not.toContain("还没有 Agent");
    fireEvent.click(within(document.querySelector(".rail")).getByRole("button", { name: /^通讯录/ }));
    await flush();
    expect(document.querySelector(".list-col").textContent).not.toContain("还没有联系人");
    await act(async () => answer.resolve(syncOf([])));
    await flush();
    expect(document.querySelector(".list-col").textContent).toContain("还没有联系人");
  });
});
