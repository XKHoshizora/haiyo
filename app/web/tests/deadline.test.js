// One rule for when a request's deadline has passed (`isPast`): the friend requests' 已过期 (`expiryText`), the Agent requests' 已过期
// (`untilText`), 通讯录's number (`waitingForMe`) and whether 同意 / 拒绝 is offered all read it. An unreadable time is not past anywhere: its
// text says nothing (as `expiryText` always did), and the service answers whatever is done with it.
import { describe, expect, it } from "vitest";
import { isPast } from "../src/data/deadline.js";
import { expiryText } from "../src/data/viewmodel.js";
import { untilText } from "../src/pages/untilText.js";

const NOW = Date.UTC(2026, 10, 16, 4, 0);
const at = (ms) => new Date(NOW + ms).toISOString();

describe("isPast", () => {
  it("is true from the deadline itself on, false before it", () => {
    expect([-86_400_000, -1, 0].map((ms) => isPast(at(ms), NOW))).toEqual([true, true, true]);
    expect([1, 59_000, 86_400_000].map((ms) => isPast(at(ms), NOW))).toEqual([false, false, false]);
  });

  it("an unreadable or missing time is not past", () => {
    for (const iso of [undefined, null, "", "soon"]) expect(isPast(iso, NOW), String(iso)).toBe(false);
  });

  it("both texts say 已过期 exactly when it is past, and nothing for an unreadable time", () => {
    for (const ms of [-86_400_000, -1, 0, 1, 61_000, 3_600_000, 7 * 86_400_000]) {
      expect(expiryText(at(ms), NOW) === "已过期", `expiryText, ${ms} ms left`).toBe(isPast(at(ms), NOW));
      expect(untilText(at(ms), NOW) === "已过期", `untilText, ${ms} ms left`).toBe(isPast(at(ms), NOW));
    }
    for (const iso of [undefined, "", "soon"]) {
      expect(expiryText(iso, NOW)).toBe("");
      expect(untilText(iso, NOW)).toBe("");
    }
  });
});
