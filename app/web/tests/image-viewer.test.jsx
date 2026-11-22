// @vitest-environment jsdom
// The image viewer (src/ui/ImageViewer.jsx) as the chat uses it: opening from a picture, what it shows, closing and where
// the focus goes, stepping through the conversation's pictures, zoom, the loading and error states, swipes.
import React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { App } from "../src/App.jsx";
import { createDataLayer } from "../src/data/store.jsx";
import { ANN, BO, D1, G1, ME, direct, emptySocial, fakeTimers, fakeTransport, group, syncOf, wire } from "./fixtures.js";

const NOW = new Date(2026, 10, 16, 12, 0).getTime();
const idOf = (n) => `00000000-0000-4000-8000-0000000d${String(n).padStart(3, "0")}`;
const image = (conv, seq, n, sender = ANN) => wire(conv, seq, sender, "", { kind: "file", attachment: { id: idOf(n), name: `照片${n}.png`, size: 1000, inline: true } });

// Twelve pictures in the direct chat (seqs 2, 4 ... 24, between texts), one in the group.
const baseSync = () =>
  syncOf(
    [direct(D1, ANN, { lastSeq: 24, readSeq: 24 }), group(G1, { lastSeq: 1, readSeq: 1 })],
    [
      ...Array.from({ length: 12 }, (_, i) => [wire(D1, 2 * i + 1, ANN, `文字${i + 1}`), image(D1, 2 * i + 2, i + 1)]).flat(),
      image(G1, 1, 99, BO),
    ],
  );

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(Element.prototype, "getClientRects").mockImplementation(() => [{ top: 0 }]);
  history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.style.overflow = "";
});

const flush = () =>
  act(async () => {
    for (let i = 0; i < 6; i += 1) await vi.advanceTimersByTimeAsync(0);
  });

async function openApp() {
  const transport = fakeTransport({ sync: baseSync, social: emptySocial });
  const api = { sendMessage: vi.fn(() => new Promise(() => {})), markRead: vi.fn(async (_id, seq) => ({ readSeq: seq })), listMessages: vi.fn(async () => ({ messages: [], nextBefore: null })) };
  let n = 0;
  const layer = createDataLayer({ transport, api, timers: fakeTimers(), now: () => NOW, random: () => 0.5, uuid: () => `tx-${++n}` });
  render(<App api={{ getMe: async () => ME }} createLayer={() => layer} />);
  await flush();
}
const openChat = async (name) => {
  fireEvent.click(screen.getByText(name, { selector: ".list-col .row-name" }));
  await flush();
};
const picture = (n) => within(document.querySelector("ol.messages")).getByRole("button", { name: `照片${n}.png` });
const shownImg = () => document.querySelector(".viewer .viewer-img");
const loaded = () => fireEvent.load(shownImg());
const press = (key, opts = {}) => fireEvent.keyDown(document.activeElement, { key, ...opts });
const counter = () => document.querySelector(".viewer-count")?.textContent ?? null;

async function open(n = 3) {
  await openApp();
  await openChat("小安");
  fireEvent.click(picture(n));
  loaded();
  return picture(n);
}

describe("opening", () => {
  it("a picture's button opens a modal dialog labelled by the file name, with who sent it, when, and what the file is called", async () => {
    await open(3);
    const dialog = document.querySelector(".viewer");
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const label = document.getElementById(dialog.getAttribute("aria-labelledby"));
    expect(label.textContent).toBe("照片3.png");
    expect(within(dialog).getByText("小安")).toBeTruthy();
    expect(dialog.querySelector("time").textContent.length).toBeGreaterThan(0);
    expect(shownImg().getAttribute("src")).toBe(`/api/attachments/${idOf(3)}`);
    expect(shownImg().getAttribute("alt")).toBe("照片3.png");
  });

  it("offers close, download (the original file name), the original in a new tab, previous and next", async () => {
    await open(3);
    const dialog = within(document.querySelector(".viewer"));
    expect(dialog.getByRole("button", { name: "关闭" })).toBeTruthy();
    const download = dialog.getByRole("link", { name: "下载 照片3.png" });
    expect(download.getAttribute("href")).toBe(`/api/attachments/${idOf(3)}`);
    expect(download.getAttribute("download")).toBe("照片3.png");
    const original = dialog.getByRole("link", { name: "在新标签页打开原图" });
    expect(original.getAttribute("target")).toBe("_blank");
    expect(original.getAttribute("rel")).toContain("noopener");
    // The address ends in the file's name, so the tab is titled with it and a saved file is called by it (not by the id).
    expect(original.getAttribute("href")).toBe(`/api/attachments/${idOf(3)}/${encodeURIComponent("照片3.png")}`);
    expect(dialog.getByRole("button", { name: "上一张" })).toBeTruthy();
    expect(dialog.getByRole("button", { name: "下一张" })).toBeTruthy();
  });

  it("the page behind is inert while it is open (the one modal layer, ui/layers.js), and not after; the body's own overflow is left alone", async () => {
    await openApp();
    await openChat("小安");
    const app = document.querySelector(".app").closest("body > *");
    document.body.style.overflow = "auto";
    fireEvent.click(picture(3));
    expect(app.hasAttribute("inert")).toBe(true);
    expect(document.querySelector(".viewer").closest("[inert]")).toBeNull();
    // (The page never scrolls under it: the root does not scroll, and .viewer contains its own; styles.css.)
    expect(document.body.style.overflow).toBe("auto");
    press("Escape");
    expect(app.hasAttribute("inert")).toBe(false);
  });
});

describe("a picture opens only on a genuine single-finger tap that began and ended on it", () => {
  const down = (el, pointerId = 1, extra = {}) => fireEvent.pointerDown(el, { pointerId, pointerType: "touch", isPrimary: pointerId === 1, ...extra });
  const up = (el, pointerId = 1) => fireEvent.pointerUp(el, { pointerId, pointerType: "touch", isPrimary: pointerId === 1 });
  const viewerOpen = () => document.querySelector(".viewer") !== null;
  /** The click of a pointer, as current browsers make it (a PointerEvent with the pointer's id); `fireEvent.click` is a plain MouseEvent (old Safari's, or an assistive one). */
  const pclick = (el, pointerId = 1, pointerType = "touch") => act(() => void el.dispatchEvent(new PointerEvent("click", { bubbles: true, cancelable: true, pointerId, pointerType, detail: 1 })));

  it("a plain tap (press, release, click) opens it on the first tap", async () => {
    await openApp();
    await openChat("小安");
    down(picture(3));
    up(picture(3));
    fireEvent.click(picture(3), { detail: 1 });
    expect(viewerOpen()).toBe(true);
  });

  it("two fingers down on it (a pinch), then the click some browsers synthesise: nothing opens", async () => {
    await openApp();
    await openChat("小安");
    down(picture(3), 1);
    down(picture(3), 2);
    up(picture(3), 2);
    up(picture(3), 1);
    fireEvent.click(picture(3), { detail: 1 });
    expect(viewerOpen()).toBe(false);
  });

  it("the second finger landing anywhere else on the page while the first is on it is a pinch too", async () => {
    await openApp();
    await openChat("小安");
    down(picture(3), 1);
    down(document.querySelector(".composer, .main-col") ?? document.body, 2);
    up(picture(3), 1);
    fireEvent.click(picture(3), { detail: 1 });
    expect(viewerOpen()).toBe(false);
  });

  it("a press that began while the viewer was still there (on it), whose click reaches the picture once it is gone: nothing opens", async () => {
    await open(3);
    const stage = document.querySelector(".viewer");
    down(stage, 1);
    press("Escape"); // (closed under the finger)
    expect(viewerOpen()).toBe(false);
    up(picture(3), 1);
    fireEvent.click(picture(3), { detail: 1 });
    expect(viewerOpen()).toBe(false);
  });

  it("a cancelled press (the browser took the touch for a pinch or a scroll) opens nothing; the next plain tap does", async () => {
    await openApp();
    await openChat("小安");
    down(picture(3));
    fireEvent.pointerCancel(picture(3), { pointerId: 1, pointerType: "touch" });
    pclick(picture(3), 1);
    expect(viewerOpen()).toBe(false);
    down(picture(3));
    up(picture(3));
    pclick(picture(3), 1);
    expect(viewerOpen()).toBe(true);
  });

  it("by identity: a click of a pointer is judged by the press of THAT pointer — a pinch's (ids 1 and 2) refuses ids 1 and 2, never a click of pointer 9", async () => {
    await openApp();
    await openChat("小安");
    down(picture(3), 1);
    down(picture(3), 2);
    up(picture(3), 2);
    up(picture(3), 1);
    pclick(picture(3), 2);
    expect(viewerOpen()).toBe(false);
    down(picture(3), 1);
    down(picture(3), 2);
    up(picture(3), 2);
    up(picture(3), 1);
    pclick(picture(3), 9);
    expect(viewerOpen()).toBe(true);
  });

  it("the reviewer's sequence: a long-press on picture A whose click the bubble menu swallows leaves nothing behind — Enter on picture B opens it, and so does an assistive click on it", async () => {
    await openApp();
    await openChat("小安");
    down(picture(3), 1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(screen.queryByRole("menu")).not.toBeNull(); // (the long-press opened the menu)
    up(picture(3), 1);
    pclick(picture(3), 1); // (swallowed: never reaches the picture's handler)
    expect(viewerOpen()).toBe(false);
    fireEvent.click(picture(4), { detail: 0 }); // Tab to B and Enter
    expect(viewerOpen()).toBe(true);
    press("Escape");
    expect(viewerOpen()).toBe(false);
    fireEvent.click(picture(4), { detail: 1 }); // VoiceOver: a click with no pointer events
    expect(viewerOpen()).toBe(true);
  });

  it("a pinch on a browser that focuses a tapped button: pointerdown, pointerup, focusin, mousedown, then the click — still refused", async () => {
    await openApp();
    await openChat("小安");
    down(picture(3), 1);
    down(picture(3), 2);
    up(picture(3), 2);
    up(picture(3), 1);
    fireEvent.focusIn(picture(3));
    fireEvent.mouseDown(picture(3));
    pclick(picture(3), 1);
    expect(viewerOpen()).toBe(false);
  });

  it("the same order for a press that began on the viewer which closed under the finger: still refused", async () => {
    await open(3);
    down(document.querySelector(".viewer"), 1);
    press("Escape");
    up(picture(3), 1);
    fireEvent.focusIn(picture(3));
    fireEvent.mouseDown(picture(3));
    pclick(picture(3), 1);
    expect(viewerOpen()).toBe(false);
  });

  it("a right-click, then an assistive click with no pointer (detail 1) on a picture: it opens — the right press's record ended with its contextmenu", async () => {
    await openApp();
    await openChat("小安");
    fireEvent.pointerDown(picture(3), { pointerId: 1, pointerType: "mouse", isPrimary: true, button: 2 });
    fireEvent.contextMenu(picture(3));
    fireEvent.pointerUp(picture(3), { pointerId: 1, pointerType: "mouse", isPrimary: true, button: 2 });
    fireEvent.click(picture(4), { detail: 1 });
    expect(viewerOpen()).toBe(true);
  });

  it("a cancelled press with no scroll and no click leaves nothing behind: the next pointer-less click on another picture opens it", async () => {
    await openApp();
    await openChat("小安");
    down(picture(3), 1);
    fireEvent.pointerCancel(picture(3), { pointerId: 1, pointerType: "touch" });
    fireEvent.click(picture(4), { detail: 1 });
    expect(viewerOpen()).toBe(true);
  });

  it("a click with no pointer press at all opens it whatever `detail` says: assistive technology (VoiceOver) sends click with detail 1 and no pointerdown", async () => {
    await openApp();
    await openChat("小安");
    fireEvent.click(picture(3), { detail: 1 });
    expect(viewerOpen()).toBe(true);
  });

  it("a mouse press whose release never reached the window (let go outside it) does not cost the next click", async () => {
    await openApp();
    await openChat("小安");
    fireEvent.pointerDown(picture(3), { pointerId: 7, pointerType: "mouse", isPrimary: true, button: 0 });
    // (no pointerup, no click: gone)
    fireEvent.pointerDown(picture(3), { pointerId: 7, pointerType: "mouse", isPrimary: true, button: 0 });
    fireEvent.pointerUp(picture(3), { pointerId: 7, pointerType: "mouse", isPrimary: true });
    fireEvent.click(picture(3), { detail: 1 });
    expect(viewerOpen()).toBe(true);
  });

  it("a press elsewhere on the page that ended with no click does not refuse the later pointer-less click: a press is spent by the click, a scroll ends it", async () => {
    await openApp();
    await openChat("小安");
    down(document.querySelector(".main-col"), 1);
    up(document.querySelector(".main-col"), 1);
    fireEvent.scroll(document.querySelector("ol.messages"));
    fireEvent.click(picture(3), { detail: 1 });
    expect(viewerOpen()).toBe(true);
  });

  it("the keyboard (Enter or Space is a click with no pointer) still opens it", async () => {
    await openApp();
    await openChat("小安");
    fireEvent.click(picture(3), { detail: 0 });
    expect(viewerOpen()).toBe(true);
  });
});

describe("closing and the focus", () => {
  it("the focus goes to the close button, Esc closes it, and the focus goes back to the picture that opened it", async () => {
    const opener = await open(3);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "关闭" }));
    press("Escape");
    expect(document.querySelector(".viewer")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("the close button closes it and gives the focus back", async () => {
    const opener = await open(5);
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(document.querySelector(".viewer")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("the focus goes back to the picture that opened it even after stepping to another", async () => {
    const opener = await open(5);
    press("ArrowRight");
    press("ArrowRight");
    expect(counter()).toBe("7 / 12");
    press("Escape");
    expect(document.activeElement).toBe(opener);
  });

  it("a click on the backdrop closes it; a click on the picture does not", async () => {
    await open(3);
    fireEvent.click(shownImg());
    expect(document.querySelector(".viewer")).not.toBeNull();
    fireEvent.click(document.querySelector(".viewer-stage"));
    expect(document.querySelector(".viewer")).toBeNull();
  });

  it("a click on the bar's empty space closes it too", async () => {
    await open(3);
    fireEvent.click(document.querySelector(".viewer-bar"));
    expect(document.querySelector(".viewer")).toBeNull();
  });

  it("Tab goes round inside the dialog and never out of it", async () => {
    await open(5);
    const dialog = document.querySelector(".viewer");
    const stops = [...dialog.querySelectorAll("button, a[href]")];
    expect(stops.length).toBeGreaterThan(3);
    stops.at(-1).focus();
    fireEvent.keyDown(stops.at(-1), { key: "Tab" });
    expect(document.activeElement).toBe(stops[0]);
    fireEvent.keyDown(stops[0], { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(stops.at(-1));
  });
});

describe("the keyboard after the mouse (the focus never leaves the dialog)", () => {
  it("a click on the picture or the empty stage gives the focus to the dialog, so Esc, the arrows and + still work", async () => {
    await open(5);
    const dialog = document.querySelector(".viewer");
    expect(dialog.getAttribute("tabindex")).toBe("-1");
    // The browser leaves the focus on the page's body after a press on something that cannot take it.
    document.activeElement.blur();
    expect(document.activeElement).toBe(document.body);
    fireEvent.pointerDown(shownImg(), { pointerId: 1, pointerType: "mouse", clientX: 5, clientY: 5 });
    expect(document.activeElement).toBe(dialog);
    press("+");
    expect(Number(shownImg().dataset.scale)).toBeGreaterThan(1);
    press("ArrowRight");
    expect(counter()).toBe("6 / 12");
    document.activeElement.blur();
    fireEvent.pointerDown(document.querySelector(".viewer-stage"), { pointerId: 1, pointerType: "mouse", clientX: 5, clientY: 5 });
    press("Escape");
    expect(document.querySelector(".viewer")).toBeNull();
  });

  it("a press on a button keeps the focus on it (the dialog does not take it)", async () => {
    await open(5);
    const next = screen.getByRole("button", { name: "下一张" });
    next.focus();
    fireEvent.pointerDown(next, { pointerId: 1, pointerType: "mouse" });
    expect(document.activeElement).toBe(next);
  });

  it("after Retry (its button goes away) the focus is still inside, and Tab goes round inside", async () => {
    await openApp();
    await openChat("小安");
    fireEvent.click(picture(3));
    fireEvent.error(shownImg());
    const retry = screen.getByRole("button", { name: "重试" });
    retry.focus();
    fireEvent.click(retry);
    const dialog = document.querySelector(".viewer");
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
    expect(dialog.contains(document.activeElement)).toBe(true);
    const stops = [...dialog.querySelectorAll("button, a[href]")];
    stops.at(-1).focus();
    fireEvent.keyDown(stops.at(-1), { key: "Tab" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(stops[0]);
  });

  it("a mouse drag of a zoomed picture captures the pointer (a release outside the stage still ends it)", async () => {
    const capture = vi.fn();
    Element.prototype.setPointerCapture = capture;
    try {
      await open(5);
      press("+");
      const stage = document.querySelector(".viewer-stage");
      fireEvent.pointerDown(shownImg(), { pointerId: 7, pointerType: "mouse", clientX: 10, clientY: 10 });
      fireEvent.pointerMove(stage, { pointerId: 7, pointerType: "mouse", clientX: 40, clientY: 10 });
      expect(capture).toHaveBeenCalledWith(7);
    } finally {
      delete Element.prototype.setPointerCapture;
    }
  });

  it("the focus goes back to the opener found again by its id when the opener node is gone", async () => {
    const opener = await open(5);
    // (Seen as gone once, by the viewer's own check; it is the node on the page when the focus is given back.)
    let asked = 0;
    Object.defineProperty(opener, "isConnected", { configurable: true, get: () => (asked += 1) > 1 });
    press("Escape");
    expect(document.activeElement).toBe(opener); // (the same picture's button, found by its data-image)
  });

  it("the counter is a polite live region without a role of its own", async () => {
    await open(5);
    const count = document.querySelector(".viewer-count");
    expect(count.getAttribute("aria-live")).toBe("polite");
    expect(count.getAttribute("role")).toBeNull();
  });
});

describe("stepping through the conversation's pictures", () => {
  it("in message order, with a counter; the arrows, the buttons; only this conversation's, and the buttons hide at the ends", async () => {
    await open(1);
    expect(counter()).toBe("1 / 12");
    expect(screen.queryByRole("button", { name: "上一张" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "下一张" }));
    expect(counter()).toBe("2 / 12");
    expect(document.getElementById(document.querySelector(".viewer").getAttribute("aria-labelledby")).textContent).toBe("照片2.png");
    for (let i = 0; i < 8; i += 1) press("ArrowRight");
    expect(counter()).toBe("10 / 12");
    press("ArrowRight");
    press("ArrowRight");
    expect(counter()).toBe("12 / 12");
    expect(screen.queryByRole("button", { name: "下一张" })).toBeNull();
    press("ArrowRight");
    expect(counter()).toBe("12 / 12");
    expect(shownImg().getAttribute("src")).toBe(`/api/attachments/${idOf(12)}`);
    press("ArrowLeft");
    expect(counter()).toBe("11 / 12");
    fireEvent.click(screen.getByRole("button", { name: "上一张" }));
    expect(counter()).toBe("10 / 12");
  });

  it("the focus stays in the dialog when the button it was on goes away at an end", async () => {
    await open(11);
    const next = screen.getByRole("button", { name: "下一张" });
    next.focus();
    fireEvent.click(next);
    expect(counter()).toBe("12 / 12");
    expect(screen.queryByRole("button", { name: "下一张" })).toBeNull();
    expect(document.querySelector(".viewer").contains(document.activeElement)).toBe(true);
  });

  it("the group's one picture is alone there: no counter, no arrows", async () => {
    await openApp();
    await openChat("周末小组");
    fireEvent.click(within(document.querySelector("ol.messages")).getByRole("button", { name: "照片99.png" }));
    expect(counter()).toBeNull();
    expect(screen.queryByRole("button", { name: "上一张" })).toBeNull();
    expect(screen.queryByRole("button", { name: "下一张" })).toBeNull();
  });

  it("a swipe sideways steps (left: next, right: previous), a swipe down closes", async () => {
    await open(5);
    const stage = document.querySelector(".viewer-stage");
    const swipe = (from, to) => {
      fireEvent.pointerDown(stage, { pointerId: 1, pointerType: "touch", clientX: from[0], clientY: from[1] });
      fireEvent.pointerUp(stage, { pointerId: 1, pointerType: "touch", clientX: to[0], clientY: to[1] });
    };
    swipe([300, 200], [120, 210]);
    expect(counter()).toBe("6 / 12");
    swipe([100, 200], [290, 190]);
    expect(counter()).toBe("5 / 12");
    swipe([100, 100], [105, 260]);
    expect(document.querySelector(".viewer")).toBeNull();
  });
});

describe("zoom", () => {
  const scale = () => Number(shownImg().dataset.scale);

  it("the wheel zooms between 1x and 4x, and another picture starts at 1x again", async () => {
    await open(5);
    const stage = document.querySelector(".viewer-stage");
    expect(scale()).toBe(1);
    fireEvent.wheel(stage, { deltaY: -200, clientX: 10, clientY: 10 });
    expect(scale()).toBeGreaterThan(1);
    for (let i = 0; i < 40; i += 1) fireEvent.wheel(stage, { deltaY: -400 });
    expect(scale()).toBe(4);
    for (let i = 0; i < 60; i += 1) fireEvent.wheel(stage, { deltaY: 400 });
    expect(scale()).toBe(1);
    fireEvent.wheel(stage, { deltaY: -400 });
    press("ArrowRight");
    expect(scale()).toBe(1);
  });

  it("+ - 0 zoom by key", async () => {
    await open(5);
    press("+");
    const more = scale();
    expect(more).toBeGreaterThan(1);
    press("+");
    expect(scale()).toBeGreaterThan(more);
    press("-");
    expect(scale()).toBeCloseTo(more, 6);
    press("0");
    expect(scale()).toBe(1);
  });

  it("a double click toggles 1x and 2x", async () => {
    await open(5);
    fireEvent.pointerDown(shownImg(), { pointerId: 1, pointerType: "mouse", clientX: 5, clientY: 5 });
    fireEvent.pointerUp(shownImg(), { pointerId: 1, pointerType: "mouse", clientX: 5, clientY: 5 });
    fireEvent.doubleClick(shownImg(), { clientX: 5, clientY: 5 });
    expect(scale()).toBe(2);
    fireEvent.doubleClick(shownImg());
    expect(scale()).toBe(1);
  });

  it("a double tap toggles it too, and one tap does nothing", async () => {
    await open(5);
    const tap = () => {
      fireEvent.pointerDown(shownImg(), { pointerId: 1, pointerType: "touch", clientX: 50, clientY: 50 });
      fireEvent.pointerUp(shownImg(), { pointerId: 1, pointerType: "touch", clientX: 50, clientY: 50 });
    };
    tap();
    expect(scale()).toBe(1);
    tap();
    expect(scale()).toBe(2);
    vi.advanceTimersByTime(1000);
    tap();
    expect(scale()).toBe(2);
    tap();
    expect(scale()).toBe(1);
  });

  it("two fingers pinch, and when zoomed a swipe does not step but pans", async () => {
    await open(5);
    const stage = document.querySelector(".viewer-stage");
    const down = (id, x, y) => fireEvent.pointerDown(shownImg(), { pointerId: id, pointerType: "touch", clientX: x, clientY: y });
    const move = (id, x, y) => fireEvent.pointerMove(stage, { pointerId: id, pointerType: "touch", clientX: x, clientY: y });
    down(1, 100, 100);
    down(2, 200, 100);
    move(2, 300, 100);
    expect(scale()).toBeCloseTo(2, 5);
    fireEvent.pointerUp(stage, { pointerId: 1, pointerType: "touch", clientX: 100, clientY: 100 });
    fireEvent.pointerUp(stage, { pointerId: 2, pointerType: "touch", clientX: 300, clientY: 100 });
    fireEvent.pointerDown(shownImg(), { pointerId: 3, pointerType: "touch", clientX: 300, clientY: 200 });
    fireEvent.pointerUp(stage, { pointerId: 3, pointerType: "touch", clientX: 100, clientY: 200 });
    expect(counter()).toBe("5 / 12");
  });
});

describe("loading and failing", () => {
  it("shows a loading indicator until the picture has loaded", async () => {
    await openApp();
    await openChat("小安");
    fireEvent.click(picture(3));
    expect(within(document.querySelector(".viewer")).getByRole("status", { name: "" }).textContent).toContain("加载中");
    expect(shownImg().dataset.phase).toBe("loading");
    loaded();
    expect(shownImg().dataset.phase).toBe("loaded");
    expect(document.querySelector(".viewer-state")).toBeNull();
  });

  it("a picture that cannot be fetched shows an error with a retry, never a broken image; retry asks again", async () => {
    await openApp();
    await openChat("小安");
    fireEvent.click(picture(3));
    fireEvent.error(shownImg());
    const dialog = within(document.querySelector(".viewer"));
    expect(dialog.getByRole("alert").textContent).toContain("无法显示");
    expect(shownImg()).toBeNull();
    fireEvent.click(dialog.getByRole("button", { name: "重试" }));
    expect(shownImg().dataset.phase).toBe("loading");
    loaded();
    expect(shownImg().dataset.phase).toBe("loaded");
    fireEvent.error(shownImg());
    expect(shownImg()).toBeNull();
    // The rest of the dialog works: next goes on to the next picture, which starts loading.
    fireEvent.click(dialog.getByRole("button", { name: "下一张" }));
    expect(shownImg().dataset.phase).toBe("loading");
    expect(counter()).toBe("4 / 12");
  });
});

describe("the viewer's layout hooks", () => {
  it("the sender and the file name have classes that cut with an ellipsis, and the bar keeps one row", async () => {
    await open(3);
    const bar = document.querySelector(".viewer-bar");
    expect(bar.querySelector(".viewer-who").textContent).toBe("小安");
    expect(bar.querySelector(".viewer-name").textContent).toBe("照片3.png");
  });

  it("follows the visible viewport when the page is pinch-zoomed, and lets go when it is not", async () => {
    const listeners = {};
    const vv = { scale: 2, offsetLeft: 100, offsetTop: 200, width: 201, height: 437, addEventListener: (t, f) => (listeners[t] = f), removeEventListener() {} };
    Object.defineProperty(window, "visualViewport", { configurable: true, value: vv });
    try {
      await open(3);
      const viewer = document.querySelector(".viewer");
      expect(viewer.style.left).toBe("100px");
      expect(viewer.style.width).toBe("402px");
      expect(viewer.style.transform).toBe("scale(0.5)");
      Object.assign(vv, { scale: 1, offsetLeft: 0, offsetTop: 0, width: 402, height: 874 });
      await act(async () => listeners.resize());
      expect(viewer.style.transform).toBe("");
      expect(viewer.style.left).toBe("");
    } finally {
      delete window.visualViewport;
    }
  });
});

describe("the viewer is a key of the conversation's entry (and one entry pushed with it)", () => {
  const viewerKey = () => window.history.state?.viewer ?? null;
  const settle = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

  it("opening pushes one entry on the conversation's own address; Back closes only the viewer and stays in the chat", async () => {
    await openApp();
    await openChat("小安");
    const path = window.location.pathname;
    expect(viewerKey()).toBeNull();
    fireEvent.click(picture(3));
    loaded();
    expect(viewerKey()).not.toBeNull();
    expect(window.location.pathname).toBe(path);
    await act(async () => {
      window.history.back();
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(document.querySelector(".viewer")).toBeNull();
    expect(document.querySelector("ol.messages")).toBeTruthy();
    expect(viewerKey()).toBeNull();
    // Forward is the viewer again (a page of its own); Back once more and then the list.
    await act(async () => {
      window.history.forward();
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(document.querySelector(".viewer")).not.toBeNull();
  });

  it("viewer → Back → chat → Back → the list", async () => {
    await openApp();
    await openChat("小安");
    fireEvent.click(picture(3));
    loaded();
    for (const [step, expected] of [["viewer", null], ["chat", "/"]]) {
      await act(async () => {
        window.history.back();
        await vi.advanceTimersByTimeAsync(50);
      });
      if (step === "viewer") expect(document.querySelector("ol.messages")).toBeTruthy();
      else expect(window.location.pathname).toBe(expected);
    }
    expect(document.querySelector("ol.messages")).toBeNull();
  });

  it("closing it with Esc or the button goes back to the conversation's entry: nothing dangles", async () => {
    await openApp();
    await openChat("小安");
    const entry = window.history.state;
    fireEvent.click(picture(3));
    loaded();
    press("Escape");
    await settle();
    expect(document.querySelector(".viewer")).toBeNull();
    expect(window.history.state).toEqual(entry);
  });

  it("rotating the phone (a width change across 860px) does not touch it: still open, the entry as it was", async () => {
    let wide = false;
    const listeners = new Set();
    window.matchMedia = (query) => ({ matches: query.includes("max-width") ? !wide : false, media: query, addEventListener: (_t, f) => listeners.add(f), removeEventListener: (_t, f) => listeners.delete(f) });
    try {
      await open(3);
      const entry = window.history.state;
      const length = window.history.length;
      wide = true;
      await act(async () => {
        for (const f of listeners) f({ matches: false });
        window.dispatchEvent(new Event("resize"));
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(document.querySelector(".viewer")).not.toBeNull();
      expect(window.history.state).toEqual(entry);
      expect(window.history.length).toBe(length);
      wide = false;
      await act(async () => {
        for (const f of listeners) f({ matches: true });
        window.dispatchEvent(new Event("resize"));
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(document.querySelector(".viewer")).not.toBeNull();
      expect(window.history.state).toEqual(entry);
    } finally {
      delete window.matchMedia;
    }
  });

  it("a viewer entry whose picture is gone loses its key by a replace, never by a traversal", async () => {
    await openApp();
    await openChat("小安");
    const back = vi.spyOn(window.history, "back");
    const length = window.history.length;
    window.history.replaceState({ ...window.history.state, viewer: "gone-picture" }, "");
    await act(async () => {
      window.dispatchEvent(new Event("af-history"));
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(viewerKey()).toBeNull();
    expect(document.querySelector(".viewer")).toBeNull();
    expect(back).not.toHaveBeenCalled();
    expect(window.history.length).toBe(length);
  });

  it("stepping to the next picture adds no entry (the key is rewritten)", async () => {
    await open(3);
    const index = window.history.state.index;
    const first = window.history.state.viewer;
    press("ArrowRight");
    expect(window.history.state.index).toBe(index);
    expect(window.history.state.viewer).not.toBe(first);
  });
});
