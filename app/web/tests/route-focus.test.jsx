// @vitest-environment jsdom
// A change of page moves the focus to a sensible place and says where the person is, and the tab's title names the page.
// One column (375 px: the list and the page are shown one at a time, the other `display: none`): opening a conversation
// puts the focus on its heading, never on <body>; Back (the browser's or the page's own) puts it back on the row that opened
// it. Two columns: the row stays focused and the page is announced instead. The details panel takes the focus when it
// opens and gives it back to 会话资料. jsdom draws nothing: the one-column layout is modelled by what is hidden.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ANN, BO, D1, G1, direct, emptySocial, group, syncOf, wire } from "./fixtures.js";
import { PEOPLE, flush, installBrowser, openApp } from "./harness.jsx";
import { COARSE_QUERY, PHONE_QUERY } from "../src/ui/pointer.js";
import { AuthRoot } from "../src/auth/AuthRoot.jsx";
import { ApiError } from "../src/api/http.js";

const ONE_COLUMN = "(max-width: 860px)";
const sync = () =>
  syncOf([direct(D1, ANN, { lastSeq: 1, readSeq: 1 }), group(G1, { lastSeq: 1, readSeq: 1 })], [wire(D1, 1, ANN, "早"), wire(G1, 1, BO, "大家好")]);
const social = () => ({ ...emptySocial(), friends: [PEOPLE[ANN], PEOPLE[BO]] });

/** A window `width` wide: its media queries, and what the stylesheet hides in one column (the pane that is not shown). */
function windowOf(width) {
  const on = width <= 640 ? [PHONE_QUERY, COARSE_QUERY, ONE_COLUMN, "(max-width: 1280px)"] : width <= 860 ? [ONE_COLUMN, "(max-width: 1280px)"] : [];
  window.matchMedia = (query) => ({ matches: on.includes(query), media: query, addEventListener() {}, removeEventListener() {} });
  vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function rects() {
    const app = this.closest?.(".app");
    if (!this.isConnected) return [];
    if (app && width <= 860) {
      const pane = app.dataset.pane;
      if (pane === "main" && this.closest(".list-col")) return [];
      if (pane === "list" && this.closest(".main-col")) return [];
    }
    return [{ top: 0 }];
  });
}
const row = (name) => screen.getByText(name, { selector: ".list-col .row-name" }).closest("button");
const press = async (el) => {
  el.focus();
  fireEvent.click(el);
  await flush();
};
const back = async () => {
  await act(async () => {
    window.history.back();
    await vi.advanceTimersByTimeAsync(60);
  });
  await flush();
};
const announced = () => document.querySelector("[data-route-announcer]")?.textContent ?? null;

beforeEach(() => installBrowser());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete window.matchMedia;
});

describe("one column (375 px)", () => {
  beforeEach(() => windowOf(375));

  it("opening a conversation puts the focus on its heading; Back puts it back on the row that opened it", async () => {
    await openApp({ sync, social: social() });
    await press(row("小安"));
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(within(document.querySelector(".main-col")).getByRole("heading", { level: 2 }));
    expect(document.activeElement.textContent).toContain("小安");
    await back();
    expect(document.activeElement).toBe(row("小安"));
  });

  it("the page's own 返回列表 does the same, and so does every page pushed over a list (a contact's card)", async () => {
    await openApp({ sync, social: social() });
    await press(row("周末小组"));
    expect(document.activeElement.textContent).toContain("周末小组");
    await press(within(document.querySelector(".main-col")).getByRole("button", { name: "返回列表" }));
    expect(document.activeElement).toBe(row("周末小组"));
    await press(within(screen.getByRole("navigation", { name: "主导航" })).getByRole("button", { name: "通讯录" }));
    const card = screen.getByText("小安", { selector: ".list-col .row-name" }).closest("button");
    await press(card);
    expect(document.activeElement.tagName).toBe("H2");
    expect(document.activeElement.textContent).toContain("小安");
    await back();
    expect(document.activeElement).toBe(screen.getByText("小安", { selector: ".list-col .row-name" }).closest("button"));
  });

  it("会话资料 takes the focus to its heading, the chat under it is inert; closing it gives the focus back to 会话资料", async () => {
    await openApp({ sync, social: social() });
    await press(row("小安"));
    const opener = screen.getByRole("button", { name: "会话资料" });
    await press(opener);
    const side = document.querySelector(".side-col");
    expect(document.activeElement).toBe(within(side).getByRole("heading", { name: "会话资料" }));
    expect(document.querySelector(".main-col").hasAttribute("inert")).toBe(true);
    await press(within(side).getByRole("button", { name: "关闭" }));
    expect(document.querySelector(".main-col").hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "会话资料" }));
  });
});

describe("two columns (1280 px)", () => {
  beforeEach(() => windowOf(1280));

  it("the row keeps the focus (it is still on screen) and the page is announced; 会话资料 takes the focus and gives it back", async () => {
    await openApp({ sync, social: social() });
    await press(row("小安"));
    expect(document.activeElement).toBe(row("小安"));
    expect(announced()).toContain("小安");
    const opener = screen.getByRole("button", { name: "会话资料" });
    await press(opener);
    expect(document.activeElement).toBe(within(document.querySelector(".side-col")).getByRole("heading", { name: "会话资料" }));
    expect(document.querySelector(".main-col").hasAttribute("inert")).toBe(false);
    await back();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "会话资料" }));
  });
});

describe("the tab's title follows the page", () => {
  beforeEach(() => windowOf(1280));

  it("a list, a conversation, its details, group info, a contact, a settings page", async () => {
    await openApp({ sync, social: social() });
    expect(document.title).toBe("消息 · Haiyo");
    await press(row("小安"));
    expect(document.title).toBe("小安 · 消息 · Haiyo");
    await press(screen.getByRole("button", { name: "会话资料" }));
    expect(document.title).toBe("会话资料 · 小安 · Haiyo");
    await press(row("周末小组"));
    expect(document.title).toBe("周末小组 · 消息 · Haiyo");
    await press(screen.getByRole("button", { name: "群资料" }));
    expect(document.title).toBe("群资料 · 周末小组 · Haiyo");
    const rail = within(screen.getByRole("navigation", { name: "主导航" }));
    await press(rail.getByRole("button", { name: /^通讯录/ }));
    expect(document.title).toBe("通讯录 · Haiyo");
    await press(screen.getByText("阿波", { selector: ".list-col .row-name" }).closest("button"));
    expect(document.title).toBe("阿波 · 通讯录 · Haiyo");
    await press(rail.getByRole("button", { name: /^设置/ }));
    expect(document.title).toBe("设置 · Haiyo");
    await press(screen.getByText("模型供应商", { selector: ".list-col .row-name" }).closest("button"));
    expect(document.title).toBe("模型供应商 · 设置 · Haiyo");
  });

  it("an account screen: its own title (登录 Haiyo is already the product's)", { timeout: 15000 }, async () => {
    vi.useRealTimers();
    history.replaceState(null, "", "/register");
    const api = { getMe: vi.fn(async () => Promise.reject(new ApiError(401, "unauthenticated"))) };
    render(<AuthRoot api={api} createLayer={() => ({ start() {}, stop() {}, onSignedOut: () => () => {} })}>{() => null}</AuthRoot>);
    // (The account screens load lazily: on a busy machine that takes longer than the default wait, as tests/auth-app.test.jsx says.)
    await screen.findByRole("heading", { name: "注册账号" }, { timeout: 5000 });
    expect(document.title).toBe("注册账号 · Haiyo");
    fireEvent.click(screen.getByRole("link", { name: /去登录/ }));
    await screen.findByRole("heading", { name: "登录 Haiyo" }, { timeout: 5000 });
    expect(document.title).toBe("登录 Haiyo");
    // A change of screen puts the focus on its heading (the link that was pressed is gone with the old screen).
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "登录 Haiyo" }));
  });
});
