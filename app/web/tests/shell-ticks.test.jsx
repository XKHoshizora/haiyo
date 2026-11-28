// @vitest-environment jsdom
// The page's one clock moves every minute; what reads it re-renders then (the rail's number, a card's countdown, the watch on requests that
// run out), never the whole shell: a page the shell draws (here the conversation list) is not drawn again by a tick.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { fakeTimers, fakeTransport, syncOf } from "./fixtures.js";

/** How often the conversation list was drawn: the shell draws it, so a drawing of the shell draws it again. */
const drawn = vi.hoisted(() => ({ list: 0 }));
vi.mock("../src/pages/ChatList.jsx", async (original) => {
  const mod = await original();
  return {
    ...mod,
    ChatList: (props) => {
      drawn.list += 1;
      return mod.ChatList(props);
    },
  };
});
// (tests/setup.js loads the shell up front, before this file's mock: the shell and its store are loaded afresh here, so that it draws the counted list.)
vi.resetModules();
const { default: Shell } = await import("../src/AppShell.jsx");
const { StoreProvider, createDataLayer } = await import("../src/data/store.jsx");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(Date.UTC(2026, 10, 16, 4, 0));
  history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("a tick of the clock", () => {
  it("does not draw the shell's pages again (only what reads the clock is)", async () => {
    const layer = createDataLayer({ transport: fakeTransport({ sync: () => syncOf([]) }), api: {}, timers: fakeTimers(), now: () => 0, random: () => 0.5, uuid: () => "tx" });
    render(
      <StoreProvider dataLayer={layer}>
        <Shell />
      </StoreProvider>,
    );
    await act(() => vi.advanceTimersByTimeAsync(0));
    const before = drawn.list;
    expect(before).toBeGreaterThan(0);
    // (Tick by tick: each in its own act, so that each would be its own drawing.)
    for (let tick = 0; tick < 5; tick += 1) await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(drawn.list).toBe(before);
  });
});
