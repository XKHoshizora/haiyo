// @vitest-environment jsdom
// The menu of a message bubble: long-press on touch, right-click and the context-menu key on desktop, the one reusable
// BubbleMenu; and what its actions do in a conversation (回复, 复制, 保存图片, 下载).
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { BubbleMenu, HOLD_MS, SLOP, placeMenu, useBubbleMenu } from "../src/ui/BubbleMenu.jsx";
import { plainText } from "../src/pages/messageActions.js";
import { ANN, BO, D1, G1, ME_ID, direct, group, syncOf, wire } from "./fixtures.js";
import { flush, installBrowser, openApp } from "./harness.jsx";
import { readFileSync } from "node:fs";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete window.matchMedia;
});

describe("placeMenu", () => {
  const bounds = { left: 0, top: 60, right: 400, bottom: 700 };
  const size = { w: 160, h: 100 };
  const at = (left, top, right = left + 100, bottom = top + 40) => ({ left, top, right, bottom });

  it("is below the bubble when there is room", () => {
    expect(placeMenu({ anchor: at(20, 200), size, bounds })).toEqual({ left: 20, top: 246, flipped: false });
  });

  it("flips above when the room below is too small and above is enough", () => {
    const place = placeMenu({ anchor: at(20, 640), size, bounds });
    expect(place.flipped).toBe(true);
    expect(place.top).toBe(640 - 6 - 100);
  });

  it("never leaves the bounds sideways", () => {
    expect(placeMenu({ anchor: at(380, 200), size, bounds }).left).toBe(400 - 8 - 160);
    expect(placeMenu({ anchor: at(-30, 200), size, bounds }).left).toBe(8);
  });

  it("a bubble as tall as the list: the menu stays inside the list, clear of the composer under it and the header over it", () => {
    const place = placeMenu({ anchor: at(20, 60, 300, 700), size, bounds });
    expect(place.top).toBeGreaterThanOrEqual(60 + 8);
    expect(place.top + size.h).toBeLessThanOrEqual(700 - 8);
  });

  it("a point (a right-click) is an anchor of no size", () => {
    expect(placeMenu({ anchor: { left: 50, top: 300, right: 50, bottom: 300 }, size, bounds })).toEqual({ left: 50, top: 306, flipped: false });
  });
});

// A bubble of the kind MessageItem draws, with the hook on its container.
const calls = [];
function Item({ actions = [{ id: "reply", label: "回复", run: () => calls.push("reply") }, { id: "copy", label: "复制", run: () => calls.push("copy") }], extra = null }) {
  const menu = useBubbleMenu(() => actions);
  return (
    <>
      <ol data-testid="message-list">
        <li className="msg" {...menu.bind}>
          <div className="msg-main">
            <div className="bubble">
              你好 <a href="https://example.test/x">链接</a>
            </div>
            <button type="button" className="msg-action">回复按钮</button>
            {extra}
          </div>
        </li>
      </ol>
      {menu.element}
    </>
  );
}
const bubble = () => document.querySelector(".bubble");
const touch = (el, type, x = 100, y = 100) => fireEvent[type](el, { pointerId: 1, pointerType: "touch", clientX: x, clientY: y, isPrimary: true });
const menu = () => screen.queryByRole("menu");

describe("long-press on touch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    calls.length = 0;
  });

  it("opens the menu after the hold, not before", () => {
    render(<Item />);
    touch(bubble(), "pointerDown");
    act(() => vi.advanceTimersByTime(HOLD_MS - 1));
    expect(menu()).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(menu()).not.toBeNull();
    expect(within(menu()).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["回复", "复制"]);
  });

  it("a finger that moves more than the slop, lifts, or is taken by a scroll (pointercancel) cancels it", () => {
    render(<Item />);
    touch(bubble(), "pointerDown");
    touch(bubble(), "pointerMove", 100 + SLOP + 1, 100);
    act(() => vi.advanceTimersByTime(HOLD_MS + 50));
    expect(menu()).toBeNull();
    touch(bubble(), "pointerDown");
    touch(bubble(), "pointerMove", 100 + SLOP - 1, 100); // a small tremble does not
    touch(bubble(), "pointerUp");
    act(() => vi.advanceTimersByTime(HOLD_MS + 50));
    expect(menu()).toBeNull();
    touch(bubble(), "pointerDown");
    touch(bubble(), "pointerCancel");
    act(() => vi.advanceTimersByTime(HOLD_MS + 50));
    expect(menu()).toBeNull();
  });

  it("a mouse press does not hold (the mouse has the right button)", () => {
    render(<Item />);
    fireEvent.pointerDown(bubble(), { pointerId: 1, pointerType: "mouse", clientX: 1, clientY: 1 });
    act(() => vi.advanceTimersByTime(HOLD_MS + 50));
    expect(menu()).toBeNull();
  });

  it("only a bubble holds: a press on the foot does nothing", () => {
    render(<Item />);
    touch(document.querySelector(".msg-action"), "pointerDown");
    act(() => vi.advanceTimersByTime(HOLD_MS + 50));
    expect(menu()).toBeNull();
  });

  it("the click that follows the release is swallowed (it would open the viewer or a mention card)", () => {
    const opened = vi.fn();
    render(<Item extra={<button type="button" className="attachment-image" onClick={opened}>图</button>} />);
    const picture = document.querySelector(".attachment-image");
    touch(picture, "pointerDown");
    act(() => vi.advanceTimersByTime(HOLD_MS));
    touch(picture, "pointerUp");
    fireEvent.click(picture);
    expect(opened).not.toHaveBeenCalled();
    // A later tap works as ever.
    act(() => vi.advanceTimersByTime(1000));
    fireEvent.click(picture);
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it("an item runs its action and closes the menu; a tap elsewhere, a scroll and Esc close it", () => {
    render(<Item />);
    touch(bubble(), "pointerDown");
    act(() => vi.advanceTimersByTime(HOLD_MS));
    fireEvent.click(screen.getByRole("menuitem", { name: "复制" }));
    expect(calls).toEqual(["copy"]);
    expect(menu()).toBeNull();
    touch(bubble(), "pointerDown");
    act(() => vi.advanceTimersByTime(HOLD_MS));
    fireEvent.pointerDown(document.body, { pointerId: 2, pointerType: "touch" });
    expect(menu()).toBeNull();
    touch(bubble(), "pointerDown");
    act(() => vi.advanceTimersByTime(HOLD_MS));
    fireEvent.scroll(document.querySelector("[data-testid=message-list]"));
    expect(menu()).toBeNull();
    touch(bubble(), "pointerDown");
    act(() => vi.advanceTimersByTime(HOLD_MS));
    fireEvent.keyDown(menu(), { key: "Escape" });
    expect(menu()).toBeNull();
  });
});

describe("right-click and the keyboard", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("a right-click on a bubble opens the menu at the pointer and keeps the browser's own menu away", () => {
    render(<Item />);
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 90 });
    act(() => void bubble().dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(menu()).not.toBeNull();
  });

  it("a right-click on a link, or with text selected, is left to the browser", () => {
    render(<Item />);
    const onLink = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    act(() => void document.querySelector(".bubble a").dispatchEvent(onLink));
    expect(onLink.defaultPrevented).toBe(false);
    expect(menu()).toBeNull();
    vi.spyOn(window, "getSelection").mockReturnValue({ toString: () => "你好" });
    const selected = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    act(() => void bubble().dispatchEvent(selected));
    expect(selected.defaultPrevented).toBe(false);
    expect(menu()).toBeNull();
  });

  it("Shift+F10 and the context-menu key on a control of the message open it; the first item has the focus", () => {
    render(<Item />);
    const control = document.querySelector(".msg-action");
    control.focus();
    fireEvent.keyDown(control, { key: "F10", shiftKey: true });
    expect(menu()).not.toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "回复" }));
    fireEvent.keyDown(menu(), { key: "Escape" });
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(control); // back where it came from
    fireEvent.keyDown(control, { key: "ContextMenu" });
    expect(menu()).not.toBeNull();
  });

  it("arrows move between the items (and wrap), Home and End jump, Enter takes the one with the focus, Tab leaves", () => {
    render(<Item />);
    const control = document.querySelector(".msg-action");
    control.focus();
    fireEvent.keyDown(control, { key: "F10", shiftKey: true });
    const [first, second] = screen.getAllByRole("menuitem");
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second, { key: "ArrowDown" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "ArrowUp" });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second, { key: "Home" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "End" });
    expect(document.activeElement).toBe(second);
    fireEvent.click(second); // (Enter on a button is a click)
    expect(calls).toEqual(["copy"]);
    expect(menu()).toBeNull();
    control.focus();
    fireEvent.keyDown(control, { key: "F10", shiftKey: true });
    fireEvent.keyDown(screen.getAllByRole("menuitem")[0], { key: "Tab" });
    expect(menu()).toBeNull();
  });

  it("the menu is a role=menu with a name, its items menuitems", () => {
    render(<Item />);
    act(() => void bubble().dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 1, clientY: 1 })));
    expect(menu().getAttribute("aria-label")).toBe("消息操作");
    for (const item of screen.getAllByRole("menuitem")) expect(item.tagName).toBe("BUTTON");
  });

  it("one menu at a time: opening on another message closes the first", () => {
    render(
      <>
        <Item />
        <Item actions={[{ id: "x", label: "另一个", run() {} }]} />
      </>,
    );
    const [one, two] = document.querySelectorAll(".bubble");
    act(() => void one.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 1, clientY: 1 })));
    act(() => void two.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 1, clientY: 1 })));
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(screen.getByRole("menuitem", { name: "另一个" })).toBeTruthy();
  });

  it("a message with no action gets no menu and its right-click is the browser's", () => {
    render(<Item actions={[]} />);
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    act(() => void bubble().dispatchEvent(event));
    expect(menu()).toBeNull();
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("BubbleMenu as a component", () => {
  it("takes the actions it is given (more can be added): label, icon, run, and a disabled one", () => {
    const run = vi.fn();
    render(<BubbleMenu anchor={{ left: 10, top: 10, right: 10, bottom: 10 }} bounds={{ left: 0, top: 0, right: 400, bottom: 700 }} onClose={() => {}} actions={[{ id: "a", label: "甲", run }, { id: "b", label: "乙", disabled: true, run }]} />);
    fireEvent.click(screen.getByRole("menuitem", { name: "甲" }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("menuitem", { name: "乙" }).disabled).toBe(true);
  });
});

// ───────── in a conversation
const MENTIONED = "@阿波 你们好";
const sync = () =>
  syncOf(
    [direct(D1, ANN, { lastSeq: 1, readSeq: 1 }), group(G1, { lastSeq: 3, readSeq: 3 })],
    [
      wire(D1, 1, ANN, "早"),
      wire(G1, 1, ANN, MENTIONED, { mentions: [{ id: BO, start: 0, length: 3 }] }),
      wire(G1, 2, ME_ID, "我的话"),
      wire(G1, 3, ANN, "", { kind: "file", attachment: { id: "00000000-0000-4000-8000-00000000f001", name: "报告.pdf", size: 10, inline: false } }),
    ],
  );
const liOf = (text) => screen.getByText(text, { exact: false, selector: ".bubble" }).closest("li");

async function openGroup() {
  installBrowser();
  const app = await openApp({ sync });
  fireEvent.click(screen.getByText("周末小组", { selector: ".list-col .row-name" }));
  await flush();
  return app;
}
const hold = async (el) => {
  fireEvent.pointerDown(el, { pointerId: 1, pointerType: "touch", clientX: 5, clientY: 5, isPrimary: true });
  await act(async () => vi.advanceTimersByTimeAsync(HOLD_MS));
};

describe("a message's menu in a conversation", () => {
  it("long-press: 回复 puts the quote in the composer; 复制 copies the plain text, a mention as @name, no hidden words, and says so", async () => {
    await openGroup();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const li = liOf("你们好");
    await hold(li.querySelector(".bubble"));
    expect(within(screen.getByRole("menu")).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["回复", "复制"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "复制" }));
    await flush();
    expect(writeText).toHaveBeenCalledWith("@阿波 你们好");
    expect(document.querySelector(".toast").textContent).toBe("已复制");
    await hold(li.querySelector(".bubble"));
    fireEvent.click(screen.getByRole("menuitem", { name: "回复" }));
    await flush();
    expect(screen.getByText("回复 小安：@阿波 你们好", { exact: false })).toBeTruthy();
  });

  it("a file's menu is 下载 (its link), no 回复, no 复制", async () => {
    await openGroup();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const card = document.querySelector(".file-card");
    await hold(card);
    expect(within(screen.getByRole("menu")).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["下载"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "下载" }));
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("right-click on desktop opens the same menu; the hover 回复 button is still there", async () => {
    await openGroup();
    const li = liOf("我的话");
    expect(li.querySelector(".msg-action")).not.toBeNull();
    act(() => void li.querySelector(".bubble").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 30, clientY: 30 })));
    expect(screen.getByRole("menu")).toBeTruthy();
  });
});

describe("plainText", () => {
  const state = { people: { [BO]: { id: BO, name: "阿波改", displayName: "阿波改", handle: "bo" } }, agents: {} };
  it("a mention is @ and the name it shows now, a gone one keeps what was sent, markup stays text", () => {
    const msg = { kind: "text", text: "@阿波 和 @走了 <b>你们好</b>", mentions: [{ id: BO, start: 0, length: 3 }, { id: "gone", start: 6, length: 3 }] };
    expect(plainText({ people: state.people, agents: {}, ...{} }, msg)).toBe("@阿波改 和 @走了 <b>你们好</b>");
  });

  it("no mentions: the text as it is", () => {
    expect(plainText(state, { kind: "text", text: "早上好", mentions: [] })).toBe("早上好");
    expect(plainText(state, { kind: "text", text: "早上好" })).toBe("早上好");
  });
});

describe("the stylesheet", () => {
  const css = readFileSync("src/styles.css", "utf8");
  it("on a touch screen the 回复 button is not drawn (the menu is the way) and a bubble has no callout or selection", () => {
    expect(css).toMatch(/@media \(pointer: coarse\) \{\s*\.msg-action \{ display: none; \}/);
    expect(css).toMatch(/@media \(pointer: coarse\) \{[\s\S]*?\.bubble, \.attachment-image, \.file-card \{ -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; \}/);
    expect(css).not.toMatch(/@media \(hover: none\) \{ \.msg-action/);
  });

  it("the menu has a z-index above the page and below the viewer", () => {
    expect(css).toMatch(/\.bubble-menu \{[^}]*z-index: 70;/);
  });
});
