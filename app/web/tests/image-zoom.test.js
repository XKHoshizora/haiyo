// The viewer's zoom and pan arithmetic (src/ui/imageZoom.js): scale 1 to 4, a point under the pointer stays under it,
// the picture never leaves the window further than its own edge.
import { describe, expect, it } from "vitest";
import { FIT, MAX_SCALE, MIN_SCALE, clampPan, clampScale, keyZoom, swipeOf, toggleZoom, wheelFactor, zoomAt } from "../src/ui/imageZoom.js";

const stage = { w: 800, h: 600 };
const image = { w: 400, h: 300 }; // as laid out at 1x

describe("scale limits", () => {
  it("is held between 1x and 4x", () => {
    expect([MIN_SCALE, MAX_SCALE]).toEqual([1, 4]);
    expect(clampScale(0.3)).toBe(1);
    expect(clampScale(2.5)).toBe(2.5);
    expect(clampScale(9)).toBe(4);
    expect(clampScale(Number.NaN)).toBe(1);
  });
});

describe("clampPan", () => {
  it("a picture smaller than the window at that scale cannot be moved on that axis", () => {
    expect(clampPan({ x: 50, y: -50 }, 1, stage, image)).toEqual({ x: 0, y: 0 });
    expect(clampPan({ x: 50, y: 50 }, 1.5, stage, image)).toEqual({ x: 0, y: 0 });
  });
  it("a larger one moves until its edge meets the window's", () => {
    // 400 x 3 = 1200 wide in an 800 window: 200 of room each way; 300 x 3 = 900 tall in 600: 150.
    expect(clampPan({ x: 999, y: -999 }, 3, stage, image)).toEqual({ x: 200, y: -150 });
    expect(clampPan({ x: 120, y: 40 }, 3, stage, image)).toEqual({ x: 120, y: 40 });
  });
});

describe("zoomAt", () => {
  it("keeps the point under the pointer where it was", () => {
    const point = { x: 100, y: 40 }; // from the window's centre
    const from = { scale: 2, x: 30, y: -10 };
    const to = zoomAt(from, 3, point, stage, image);
    expect(to.scale).toBe(3);
    // The picture's own coordinate under the point is the same before and after.
    const under = (v) => [(point.x - v.x) / v.scale, (point.y - v.y) / v.scale];
    expect(under(to)[0]).toBeCloseTo(under(from)[0], 6);
    expect(under(to)[1]).toBeCloseTo(under(from)[1], 6);
  });
  it("is held at the limits, and at 1x the picture is back in the middle", () => {
    expect(zoomAt({ scale: 3, x: 100, y: 50 }, 20, { x: 0, y: 0 }, stage, image).scale).toBe(4);
    expect(zoomAt({ scale: 3, x: 100, y: 50 }, 0.1, { x: 10, y: 10 }, stage, image)).toEqual({ scale: 1, x: 0, y: 0 });
  });
  it("never leaves the picture further out than its edge", () => {
    const to = zoomAt({ scale: 1, x: 0, y: 0 }, 4, { x: 390, y: 290 }, stage, image);
    expect(Math.abs(to.x)).toBeLessThanOrEqual((400 * 4 - 800) / 2);
    expect(Math.abs(to.y)).toBeLessThanOrEqual((300 * 4 - 600) / 2);
  });
});

describe("double click / double tap", () => {
  it("from 1x goes to 2x at the point; from any zoom goes back to 1x", () => {
    const zoomed = toggleZoom({ scale: 1, x: 0, y: 0 }, { x: 100, y: 0 }, stage, image);
    expect(zoomed.scale).toBe(2);
    expect(toggleZoom(zoomed, { x: 0, y: 0 }, stage, image)).toEqual({ scale: 1, x: 0, y: 0 });
    expect(toggleZoom({ scale: 3.2, x: 10, y: 10 }, { x: 0, y: 0 }, stage, image)).toEqual({ scale: 1, x: 0, y: 0 });
  });
});

describe("the wheel", () => {
  it("up zooms in, down out; a trackpad's pinch (ctrl) moves faster; a line-mode wheel counts as lines", () => {
    expect(wheelFactor({ deltaY: -100, deltaMode: 0, ctrlKey: false })).toBeGreaterThan(1);
    expect(wheelFactor({ deltaY: 100, deltaMode: 0, ctrlKey: false })).toBeLessThan(1);
    expect(wheelFactor({ deltaY: -10, deltaMode: 0, ctrlKey: true })).toBeGreaterThan(wheelFactor({ deltaY: -10, deltaMode: 0, ctrlKey: false }));
    expect(wheelFactor({ deltaY: -3, deltaMode: 1, ctrlKey: false })).toBeGreaterThan(wheelFactor({ deltaY: -3, deltaMode: 0, ctrlKey: false }));
    expect(wheelFactor({ deltaY: 0, deltaMode: 0, ctrlKey: false })).toBe(1);
  });
});

describe("the keys + - 0", () => {
  it("steps in and out about the middle, and 0 is 1x again", () => {
    const one = { scale: 1, x: 0, y: 0 };
    const more = keyZoom("+", one, stage, image);
    expect(more.scale).toBeGreaterThan(1);
    expect(keyZoom("=", one, stage, image).scale).toBe(more.scale);
    expect(keyZoom("-", more, stage, image).scale).toBeCloseTo(1, 6);
    expect(keyZoom("-", one, stage, image)).toEqual(one);
    expect(keyZoom("0", { scale: 3, x: 5, y: 5 }, stage, image)).toEqual(one);
    expect(keyZoom("a", more, stage, image)).toBeNull();
  });
});

describe("a swipe at 1x", () => {
  it("down closes, sideways goes to the neighbour, a short or slanting one does nothing", () => {
    expect(swipeOf(5, 140)).toBe("close");
    expect(swipeOf(-120, 4)).toBe("next");
    expect(swipeOf(120, -3)).toBe("previous");
    expect(swipeOf(10, 30)).toBe(null);
    expect(swipeOf(80, 70)).toBe(null);
    expect(swipeOf(0, -200)).toBe(null);
  });
});

it("FIT is the state of a picture not zoomed", () => {
  expect(FIT).toEqual({ scale: 1, x: 0, y: 0 });
});
