// @vitest-environment jsdom
// Where the focus goes when a dialog's own action ends it (fix round 1, I1 + I2): never on <body>, and the person hears one thing.
// - The action changes the page (退出群聊 › 确认退出, 放弃新头像？ › 放弃): the focus goes where the new page puts it, and the page is said
//   once — by its heading taking the focus, or else by the page announcer.
// - The page stays but the control that opened the dialog went with the action (删除供应商, 移除成员, 解除好友): the focus goes to the
//   nearest place left of where that control was; the action's own toast is the one thing said, the page announcer says nothing.
// The person uses the keyboard (every press focuses what it presses first). One column is modelled as in tests/route-focus.test.jsx.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { ANN, BO, D1, G1, ME_ID, direct, emptySocial, group, providerOf, syncOf, wire, MODELS } from "./fixtures.js";
import { PEOPLE, flush, installBrowser, openApp, push } from "./harness.jsx";
import { COARSE_QUERY, PHONE_QUERY } from "../src/ui/pointer.js";

const ONE_COLUMN = "(max-width: 860px)";
function windowOf(width) {
  const on = width <= 640 ? [PHONE_QUERY, COARSE_QUERY, ONE_COLUMN, "(max-width: 1280px)"] : [];
  window.matchMedia = (query) => ({ matches: on.includes(query), media: query, addEventListener() {}, removeEventListener() {} });
  vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function rects() {
    if (!this.isConnected) return [];
    const app = this.closest?.(".app");
    if (app && width <= 860) {
      if (app.dataset.pane === "main" && this.closest(".list-col")) return [];
      if (app.dataset.pane === "list" && this.closest(".main-col")) return [];
    }
    return [{ top: 0 }];
  });
}

/** What the person hears from now on: the page announcer's lines, and the toasts. */
function listen() {
  const said = { page: [], toasts: [] };
  const startToast = document.querySelector(".toast-region .toast");
  let before = document.querySelector("[data-route-announcer]")?.textContent ?? "";
  const watch = new MutationObserver(() => {
    const line = document.querySelector("[data-route-announcer]")?.textContent ?? "";
    if (line && line !== before) said.page.push(line);
    before = line;
    const toast = document.querySelector(".toast-region .toast");
    if (toast && toast !== said.lastToast && toast !== startToast) {
      said.lastToast = toast;
      said.toasts.push(toast.textContent);
    }
  });
  watch.observe(document.body, { childList: true, subtree: true, characterData: true });
  said.stop = () => watch.disconnect();
  return said;
}
/** The page was said exactly once: its heading took the focus, or the announcer said it — not both, not neither. */
const pageSaidOnce = (said) => {
  const onHeading = document.activeElement?.matches?.("h1, h2") ? 1 : 0;
  return onHeading + said.page.length;
};
const press = async (el) => {
  el.focus();
  fireEvent.click(el);
  await flush();
};
const row = (name) => screen.getByText(name, { selector: ".list-col .row-name" }).closest("button");
const inDialog = (name) => within(screen.getByRole("dialog")).getByRole("button", { name });
const social = () => ({ ...emptySocial(), friends: [PEOPLE[ANN], PEOPLE[BO]] });

beforeEach(() => installBrowser());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete window.matchMedia;
});

describe("a dialog's action changes the page", () => {
  it.each([375, 1280])("退出群聊 › 确认退出 at %i px: the focus is on the list, never <body>, and the page is said once", async (width) => {
    windowOf(width);
    const members = [{ id: ANN, role: "speaker", isCreator: true }, { id: ME_ID, role: "speaker", isCreator: false }, { id: BO, role: "speaker", isCreator: false }];
    const alive = { g1: true };
    const sync = () => syncOf([direct(D1, ANN, { lastSeq: 1, readSeq: 1 }), ...(alive.g1 ? [group(G1, { creatorId: ANN, members, lastSeq: 1, readSeq: 1 })] : [])], [wire(D1, 1, ANN, "早")]);
    const removeMember = vi.fn(async () => {
      alive.g1 = false;
      return { ok: true };
    });
    const { transport } = await openApp({ sync, social: social(), api: { removeMember } });
    await press(row("周末小组"));
    await press(screen.getByRole("button", { name: "群资料" }));
    await press(screen.getByRole("tab", { name: "群设置" }));
    await press(screen.getByRole("button", { name: "退出本群" }));
    const said = listen();
    await press(inDialog("确认退出"));
    await push(transport, { type: "gone", id: G1 });
    await flush();
    said.stop();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.querySelector(".list-col").contains(document.activeElement)).toBe(true);
    expect(pageSaidOnce(said)).toBe(1);
  });
});

describe("a dialog's action removes the control that opened it; the page stays", () => {
  beforeEach(() => windowOf(1280));

  it("移除成员 › 确认移除: the focus stays in the member list, never <body>; the toast is the one thing said", async () => {
    let members = [{ id: ME_ID, role: "speaker", isCreator: true }, { id: ANN, role: "speaker", isCreator: false }, { id: BO, role: "speaker", isCreator: false }];
    const removeMember = vi.fn(async () => {
      members = members.filter((m) => m.id !== ANN);
      return { ok: true };
    });
    await openApp({ sync: () => syncOf([group(G1, { members, lastSeq: 1, readSeq: 1 })], [wire(G1, 1, ANN, "大家好")]), social: social(), api: { removeMember } });
    await press(row("周末小组"));
    await press(screen.getByRole("button", { name: "群资料" }));
    const memberRow = (name) => within(document.querySelector(".main-col")).getByText(name, { selector: ".member-rows strong" }).closest("li");
    await press(within(memberRow("小安")).getByRole("button", { name: "移除" }));
    const said = listen();
    await press(inDialog("确认移除"));
    said.stop();
    expect(removeMember).toHaveBeenCalled();
    // (The row of 小安 and its 移除 went with the action.)
    expect(within(document.querySelector(".main-col")).queryByText("小安", { selector: ".member-rows strong" })).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement.closest(".main-col")).toBeTruthy();
    expect(said.toasts).toEqual(["已将小安移出群聊"]);
    expect(said.page).toEqual([]);
  });

  it("解除好友 › 确认解除: the focus stays on the card, never <body>; the toast is the one thing said", async () => {
    const env = { social: { ...emptySocial(), friends: [PEOPLE[ANN]] } };
    const removeFriend = vi.fn(async () => {
      app.env.social = { ...emptySocial(), friends: [] };
      return { ok: true };
    });
    const app = await openApp({ sync: () => syncOf([direct(D1, ANN, { lastSeq: 1, readSeq: 1 })]), social: env.social, api: { removeFriend } });
    await press(within(screen.getByRole("navigation", { name: "主导航" })).getByRole("button", { name: /^通讯录/ }));
    await press(row("小安"));
    await press(screen.getByRole("button", { name: "解除好友" }));
    const said = listen();
    await press(inDialog("确认解除"));
    said.stop();
    expect(removeFriend).toHaveBeenCalled();
    expect(document.activeElement).not.toBe(document.body);
    expect(said.toasts).toEqual(["已解除好友关系"]);
    expect(said.page).toEqual([]);
  });

  it("删除供应商 › 确认删除: the focus stays on the providers page, never <body>; nothing is announced as a new page", async () => {
    const providers = [providerOf()];
    const deleteProvider = vi.fn(async () => {
      providers.length = 0;
      return { ok: true };
    });
    await openApp({
      sync: () => syncOf([]),
      api: { listProviders: vi.fn(async () => ({ providers: structuredClone(providers) })), deleteProvider },
      handlers: { models: () => MODELS },
    });
    await press(within(screen.getByRole("navigation", { name: "主导航" })).getByRole("button", { name: /^设置/ }));
    await press(row("模型供应商"));
    const providerRow = within(document.querySelector(".main-col")).getByText("我的 OpenAI", { selector: ".member-body strong" }).closest("li");
    await press(within(providerRow).getByRole("button", { name: "删除" }));
    const said = listen();
    await act(async () => fireEvent.click(inDialog("确认删除")));
    await flush();
    said.stop();
    expect(deleteProvider).toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement.closest(".main-col")).toBeTruthy();
    expect(said.page).toEqual([]);
  });
});
