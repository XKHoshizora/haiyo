// @vitest-environment jsdom
// The toast: its live region is on the page before any message is put in it (a region inserted together with its text is often
// not announced, notably by VoiceOver), it stays live while a dialog makes the rest inert, a message that repeats is read again,
// and it never takes a tap, keeps inside the safe areas, and stands at the top, clear of the end of every page (the newest
// message, the composer, a form's last line) and above every dialog. How it looks is the stylesheet's (pinned below).
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { fakeTimers, fakeTransport, syncOf } from "./fixtures.js";
import { flush, installBrowser, openApp } from "./harness.jsx";
import Shell from "../src/AppShell.jsx";
import { StoreProvider, createDataLayer, useStore } from "../src/data/store.jsx";
import { parseCss, read, rulesFor } from "./css-rules.js";

beforeEach(() => installBrowser());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const region = () => document.querySelector(".toast-region");

describe("the toast's live region", () => {
  it("is there, empty and live, before any message; a message goes into that same region, and the region stays when it goes", async () => {
    await openApp({ sync: () => syncOf([]) });
    const live = region();
    expect(live).toBeTruthy();
    expect(live.getAttribute("role")).toBe("status");
    expect(live.textContent).toBe("");
    // Outside the part of the page a dialog makes inert (ui/layers.js leaves `data-live` alone).
    expect(live.closest("#root, .app")).toBeNull();
    expect(live.hasAttribute("data-live")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "新建" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "添加好友" }));
    await flush();
    // A dialog is open: the rest is inert, the region is not.
    expect(document.querySelector(".app").closest("body > *").hasAttribute("inert")).toBe(true);
    expect(region().closest("[inert]")).toBeNull();
  });

  it("each message is its own node in the region (the same words twice are read twice), and it clears by itself", async () => {
    const { store } = await openWithStore();
    act(() => store.dispatch({ type: "toast", text: "已复制" }));
    const first = region().querySelector(".toast");
    expect(region().textContent).toBe("已复制");
    act(() => store.dispatch({ type: "toast", text: "已复制" }));
    const second = region().querySelector(".toast");
    expect(second).not.toBe(first);
    expect(second.textContent).toBe("已复制");
    await act(async () => vi.advanceTimersByTimeAsync(4300));
    expect(region().querySelector(".toast")).toBeNull();
    expect(region()).toBeTruthy();
  });
});

describe("where it stands (the stylesheet)", () => {
  const rules = parseCss(read("src/styles.css"));
  const all = (selector) => Object.assign({}, ...rulesFor(rules, selector).map((r) => r.decl));

  it("never takes a tap: the composer and anything under it get the press", () => {
    expect(all(".toast-region")["pointer-events"]).toBe("none");
    expect(all(".toast")["pointer-events"] ?? "none").toBe("none");
  });

  it("stands at the top, inside the safe areas on every side, clear of the end of a page", () => {
    const r = all(".toast-region");
    expect(r.position).toBe("fixed");
    expect(r.top).toContain("env(safe-area-inset-top");
    expect(r.left).toContain("env(safe-area-inset-left");
    expect(r.right).toContain("env(safe-area-inset-right");
    expect(r.bottom).toBeUndefined();
    // (Nowhere is it moved back down: no rule places it at the bottom.)
    expect(rules.filter((x) => x.selectors.some((s) => /\.toast\b/.test(s)) && "bottom" in x.decl).map((x) => x.selectors.join(", "))).toEqual([]);
  });

  it("is above every dialog and the viewer", () => {
    const z = (selector) => Number(all(selector)["z-index"]);
    expect(z(".toast-region")).toBeGreaterThan(z(".modal-backdrop"));
    expect(z(".toast-region")).toBeGreaterThan(z(".viewer"));
  });
});

/** The shell over a data layer, and the store's own dispatch (as a page toasts). */
async function openWithStore() {
  let dispatch = null;
  function Grab() {
    dispatch = useStore().dispatch;
    return null;
  }
  const layer = createDataLayer({ transport: fakeTransport({ sync: () => syncOf([]) }), api: {}, timers: fakeTimers(), now: () => 0, random: () => 0.5, uuid: () => "tx" });
  render(
    <StoreProvider dataLayer={layer}>
      <Shell />
      <Grab />
    </StoreProvider>,
  );
  await flush();
  return { store: { dispatch: (action) => dispatch(action) } };
}
