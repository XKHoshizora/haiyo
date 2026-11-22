// @vitest-environment jsdom
// The modal contract of tests/layers.test.jsx, through the app's own dialogs: opened from where a person opens them, the app
// behind inert, the focus in, Esc closes, and the focus comes back to what opened it — also when that was a menu item that
// went away with the menu. (Each dialog at 402 px in a real browser: e2e/dialogs.spec.mjs.)
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { D1, ANN, direct, emptySocial, syncOf, wire } from "./fixtures.js";
import { PEOPLE, flush, installBrowser, openApp } from "./harness.jsx";

beforeEach(() => installBrowser());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const app = () => document.querySelector(".app").closest("body > *");
const theDialog = (name) => screen.getByRole("dialog", { name });
const friends = () => ({ ...emptySocial(), friends: [PEOPLE[ANN]] });

/** The contract for one dialog, opened by `open()` (which leaves the focus where the person's press put it). */
async function contract(name, open, opener) {
  await open();
  const box = theDialog(name);
  expect(app().hasAttribute("inert"), `${name}: the app behind is inert`).toBe(true);
  expect(box.closest("[inert]"), `${name}: the dialog is not`).toBeNull();
  expect(box.contains(document.activeElement), `${name}: the focus is in it`).toBe(true);
  fireEvent.keyDown(document.activeElement, { key: "Escape" });
  await flush();
  expect(screen.queryByRole("dialog", { name }), `${name}: Esc closed it`).toBeNull();
  expect(app().hasAttribute("inert"), `${name}: nothing inert after`).toBe(false);
  expect(document.activeElement, `${name}: the focus is back on its opener`).toBe(opener());
}

describe("the app's dialogs keep the contract", () => {
  it("发起群聊 from the 新建 menu: the focus comes back to 新建, not to the page", async () => {
    await openApp({ sync: () => syncOf([]), social: friends() });
    const plus = () => screen.getByRole("button", { name: "新建" });
    await contract(
      "发起群聊",
      async () => {
        plus().focus();
        fireEvent.click(plus());
        await flush();
        const item = screen.getByRole("button", { name: "发起群聊" });
        item.focus();
        fireEvent.click(item);
        await flush();
      },
      plus,
    );
  });

  it("添加好友 from the chat list's menu opens on 通讯录; it gives the focus to that list's own 添加好友", async () => {
    await openApp({ sync: () => syncOf([]), social: friends() });
    await contract(
      "添加好友",
      async () => {
        fireEvent.click(screen.getByRole("button", { name: "新建" }));
        await flush();
        const item = screen.getByRole("button", { name: "添加好友" });
        item.focus();
        fireEvent.click(item);
        await flush();
      },
      () => within(document.querySelector(".list-col")).getByRole("button", { name: "添加好友" }),
    );
  });

  it("拉黑 from a chat's 会话资料: the focus comes back to its button", async () => {
    await openApp({ sync: () => syncOf([direct(D1, ANN, { lastSeq: 1, readSeq: 1 })], [wire(D1, 1, ANN, "早")]), social: friends() });
    fireEvent.click(screen.getByText("小安", { selector: ".list-col .row-name" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "会话资料" }));
    await flush();
    const block = () => within(document.querySelector(".side-col")).getByRole("button", { name: "拉黑此用户" });
    await contract(
      "拉黑小安",
      async () => {
        block().focus();
        fireEvent.click(block());
        await flush();
      },
      block,
    );
  });
});
