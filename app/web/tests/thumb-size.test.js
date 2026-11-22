import { describe, expect, it } from "vitest";
import { THUMB, thumbMaxWidth, thumbSize } from "../src/ui/thumbSize.js";

const ratio = (box) => box.width / box.height;

describe("thumbSize: a picture keeps its own shape inside a box", () => {
  it("a landscape photo is scaled down to the width bound, in its ratio", () => {
    expect(thumbSize({ width: 4000, height: 3000 })).toEqual({ width: 280, height: 210, cropped: false });
  });

  it("a portrait photo is scaled down to the height bound, not cropped to 3:2", () => {
    const box = thumbSize({ width: 3000, height: 4000 });
    expect(box).toEqual({ width: 240, height: 320, cropped: false });
    expect(ratio(box)).toBeCloseTo(0.75, 2);
  });

  it("a square one is a square", () => {
    expect(thumbSize({ width: 1000, height: 1000 })).toEqual({ width: 280, height: 280, cropped: false });
  });

  it("a picture already smaller than the box is shown at its own size", () => {
    expect(thumbSize({ width: 200, height: 150 })).toEqual({ width: 200, height: 150, cropped: false });
  });

  it("a tiny picture is raised until its short side is 96", () => {
    expect(thumbSize({ width: 40, height: 30 })).toEqual({ width: 128, height: 96, cropped: false });
    expect(thumbSize({ width: 30, height: 40 })).toEqual({ width: 96, height: 128, cropped: false });
  });

  it("a panorama wider than 2.5:1 is clamped to 2.5:1 and flagged as cropped", () => {
    const box = thumbSize({ width: 8000, height: 1000 });
    expect(box).toEqual({ width: 280, height: 112, cropped: true });
    expect(ratio(box)).toBeCloseTo(2.5, 2);
  });

  it("a long screenshot taller than 1:2.5 is clamped to 1:2.5", () => {
    const box = thumbSize({ width: 1000, height: 9000 });
    expect(box).toEqual({ width: 128, height: 320, cropped: true });
    expect(ratio(box)).toBeCloseTo(0.4, 2);
  });

  it("exactly 2.5:1 and 1:2.5 are not cropped", () => {
    expect(thumbSize({ width: 2500, height: 1000 }).cropped).toBe(false);
    expect(thumbSize({ width: 1000, height: 2500 }).cropped).toBe(false);
  });

  it("the short side never goes under 96 for any shape, nor the box over its bounds", () => {
    for (const [w, h] of [[10, 10], [10, 5000], [5000, 10], [96, 96], [97, 3000], [3000, 97], [500, 1250], [1250, 500], [1, 1]]) {
      const box = thumbSize({ width: w, height: h });
      expect(Math.min(box.width, box.height), `${w}x${h}`).toBeGreaterThanOrEqual(THUMB.minSide);
      expect(box.width).toBeLessThanOrEqual(THUMB.maxWidth);
      expect(box.height).toBeLessThanOrEqual(THUMB.maxHeight);
    }
  });

  it("a narrower column gives a narrower box in the same shape", () => {
    expect(thumbSize({ width: 4000, height: 3000 }, { maxWidth: 200 })).toEqual({ width: 200, height: 150, cropped: false });
    expect(thumbSize({ width: 3000, height: 4000 }, { maxWidth: 200 })).toEqual({ width: 200, height: 267, cropped: false });
  });

  it("missing or broken dimensions give nothing (the placeholder stays)", () => {
    for (const bad of [null, undefined, {}, { width: 0, height: 10 }, { width: 10, height: 0 }, { width: NaN, height: 5 }, { width: -4, height: 4 }, { width: "x", height: 3 }]) {
      expect(thumbSize(bad)).toBeNull();
    }
  });
});

describe("thumbMaxWidth: 280 on a wide screen, 70% of the bubble column on a phone", () => {
  it("is 280 above the one-column breakpoint", () => {
    expect(thumbMaxWidth(1280)).toBe(280);
    expect(thumbMaxWidth(861)).toBe(280);
  });

  it("is 70% of the 82% bubble column of a phone's padded message list, never over 280", () => {
    expect(thumbMaxWidth(375)).toBe(Math.round(0.7 * 0.82 * (375 - 24)));
    expect(thumbMaxWidth(320)).toBe(Math.round(0.7 * 0.82 * (320 - 24)));
    expect(thumbMaxWidth(860)).toBe(280);
  });

  it("never goes under the smallest side", () => {
    expect(thumbMaxWidth(100)).toBe(96);
  });
});
