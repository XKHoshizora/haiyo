// @vitest-environment jsdom
// A group's header counts (ui/primitives.jsx HeadCounts): an icon and a number each; the real numbers (a group has at most 500 members), the whole number in the accessible name; no Agents, no second count.
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { HeadCounts } from "../src/ui/primitives.jsx";

afterEach(cleanup);
const counts = (container) => [...container.querySelectorAll(".head-count")].map((el) => [el.getAttribute("aria-label"), el.textContent.trim()]);

describe("HeadCounts", () => {
  it("shows the numbers, with the whole number in the accessible name", () => {
    const { container } = render(<HeadCounts people={3} agents={1} />);
    expect(counts(container)).toEqual([["3 人", "3"], ["1 个 Agent", "1"]]);
  });

  it("shows the real number at three digits too", () => {
    const { container } = render(<HeadCounts people={128} agents={100} />);
    expect(counts(container)).toEqual([["128 人", "128"], ["100 个 Agent", "100"]]);
  });

  it("no Agent: no divider and no second count, never a 0", () => {
    const { container } = render(<HeadCounts people={5} agents={0} />);
    expect(container.querySelector(".head-counts-sep")).toBeNull();
    expect(counts(container)).toEqual([["5 人", "5"]]);
  });
});
