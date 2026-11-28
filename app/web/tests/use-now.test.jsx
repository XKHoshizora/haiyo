// @vitest-environment jsdom
// One clock for every time that counts down on the page (`useNow`): the rail's number on 通讯录, the contacts list, a contact's card, the
// requests on my Agents. Two of them shown at once never disagree about the minute, however far apart they were mounted.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useNow } from "../src/pages/useAction.js";

const T0 = Date.UTC(2026, 10, 16, 4, 0, 10);

function Clock({ id }) {
  return <p data-testid={id}>{useNow()}</p>;
}
const read = (id) => Number(screen.getByTestId(id).textContent);
const elapse = (ms) => act(() => vi.advanceTimersByTimeAsync(ms));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useNow", () => {
  it("two consumers mounted 30 s apart read the same time and change at the same instant, on one interval", async () => {
    const first = render(<Clock id="a" />);
    expect(read("a")).toBe(T0);
    await elapse(30_000);
    const second = render(<Clock id="b" />);
    // (The one clock's time, not the moment it was mounted.)
    expect(read("b")).toBe(T0);
    expect(vi.getTimerCount()).toBe(1);
    await elapse(29_999);
    expect([read("a"), read("b")]).toEqual([T0, T0]);
    await elapse(1);
    expect([read("a"), read("b")]).toEqual([T0 + 60_000, T0 + 60_000]);
    await elapse(60_000);
    expect([read("a"), read("b")]).toEqual([T0 + 120_000, T0 + 120_000]);
    act(() => first.unmount());
    expect(vi.getTimerCount()).toBe(1);
    act(() => second.unmount());
    expect(vi.getTimerCount()).toBe(0);
  });

  it("after the page was frozen (its ticks missed), a consumer mounted then, or the page shown again, moves every consumer to the time now", async () => {
    render(<Clock id="a" />);
    // (Frozen: the wall clock moved on, no timer ran.)
    vi.setSystemTime(T0 + 5 * 60_000);
    render(<Clock id="b" />);
    expect([read("a"), read("b")]).toEqual([T0 + 5 * 60_000, T0 + 5 * 60_000]);
    vi.setSystemTime(T0 + 10 * 60_000);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect([read("a"), read("b")]).toEqual([T0 + 10 * 60_000, T0 + 10 * 60_000]);
    // (Within its period the clock is not moved by either: every consumer keeps reading the same minute.)
    vi.setSystemTime(T0 + 10 * 60_000 + 30_000);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    render(<Clock id="c" />);
    expect([read("a"), read("b"), read("c")]).toEqual([T0 + 10 * 60_000, T0 + 10 * 60_000, T0 + 10 * 60_000]);
  });

  it("with nothing shown it keeps no timer, and the next one starts from the time it is shown", async () => {
    render(<Clock id="a" />);
    cleanup();
    expect(vi.getTimerCount()).toBe(0);
    await elapse(45_000);
    render(<Clock id="c" />);
    expect(read("c")).toBe(T0 + 45_000);
    await elapse(60_000);
    expect(read("c")).toBe(T0 + 105_000);
  });
});
