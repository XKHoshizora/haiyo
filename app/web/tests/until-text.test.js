// Agent social, A-5 re-review m-f and copy #3: when a request runs out is said as 「还有 N 天过期」 / 「还有 N 小时过期」, and the dialog's
// count of days is the rows' count (nearest day: a request made a moment ago with 7 days to live reads 7 even when the clocks differ a little).
import { describe, expect, it } from "vitest";
import { daysLeft, untilText } from "../src/pages/untilText.js";

const NOW = Date.UTC(2026, 10, 16, 12, 0);
const at = (ms) => new Date(NOW + ms).toISOString();
const H = 3_600_000;
const D = 24 * H;

describe("untilText", () => {
  it.each([
    [7 * D, "还有 7 天过期"],
    [7 * D + 10 * 60_000, "还有 7 天过期"],
    [7 * D - 10 * 60_000, "还有 7 天过期"],
    [6 * D + 6 * H, "还有 6 天过期"],
    [6 * D + 14 * H, "还有 7 天过期"],
    [D, "还有 1 天过期"],
    [23 * H + 1, "还有 1 天过期"],
    [5 * H - 1, "还有 5 小时过期"],
    [1, "还有 1 小时过期"],
    [0, "已过期"],
    [-D, "已过期"],
  ])("%i ms left reads %s", (ms, text) => expect(untilText(at(ms), NOW)).toBe(text));

  it("the dialog's days are the rows' days, and an unreadable time says nothing of days", () => {
    for (const ms of [7 * D, 7 * D + 5 * 60_000, 3 * D - 1, 40 * H]) expect(untilText(at(ms), NOW)).toBe(`还有 ${daysLeft(at(ms), NOW)} 天过期`);
    expect(daysLeft("", NOW)).toBeNull();
  });
});
