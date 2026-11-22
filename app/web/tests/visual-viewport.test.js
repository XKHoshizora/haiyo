import { describe, expect, it } from "vitest";
import { boxFor, frameFor } from "../src/ui/visualViewport.js";

describe("boxFor: the box a fixed layer takes to cover exactly what the person sees", () => {
  it("is nothing while the page is not zoomed and not moved (inset: 0 already does)", () => {
    expect(boxFor({ scale: 1, offsetLeft: 0, offsetTop: 0, width: 402, height: 874 })).toBeNull();
    expect(boxFor(null)).toBeNull();
  });

  it("a page pinched to 2x: the layer sits where the visible part is, as large as the layout viewport, shrunk back to its size", () => {
    // The visible part is 201 × 437 CSS px of a 402 × 874 layout viewport, starting at (100, 200).
    const box = boxFor({ scale: 2, offsetLeft: 100, offsetTop: 200, width: 201, height: 437 });
    expect(box).toEqual({ position: "fixed", inset: "auto", left: 100, top: 200, width: 402, height: 874, transform: "scale(0.5)", transformOrigin: "0 0" });
    // What it covers on screen: its size after the scale is the visible part's.
    expect(box.width * 0.5).toBe(201);
    expect(box.height * 0.5).toBe(437);
  });

  it("not zoomed but moved (Safari's toolbar, the keyboard): the layer follows the visible part", () => {
    const box = boxFor({ scale: 1, offsetLeft: 0, offsetTop: 54, width: 402, height: 780 });
    expect(box).toMatchObject({ left: 0, top: 54, width: 402, height: 780, transform: "scale(1)" });
  });

  it("a scale a hair off 1 (rounding) counts as 1", () => {
    expect(boxFor({ scale: 1.004, offsetLeft: 0, offsetTop: 0, width: 400.4, height: 870 })).toBeNull();
  });
});

describe("frameFor: the layer that is exactly the visible part, the keyboard's shrinking of it included", () => {
  it("is nothing while the visible part is the whole window (the stylesheet's inset: 0 does it)", () => {
    expect(frameFor({ scale: 1, offsetLeft: 0, offsetTop: 0, width: 402, height: 874 }, 874)).toBeNull();
    expect(frameFor(null, 874)).toBeNull();
  });

  it("with the keyboard up the layer is as high as what is left of the screen, where the visible part starts", () => {
    expect(frameFor({ scale: 1, offsetLeft: 0, offsetTop: 0, width: 402, height: 520 }, 874)).toEqual({ position: "fixed", inset: "auto", left: 0, top: 0, width: 402, height: 520 });
    // Panned down by the browser to show the focused field.
    expect(frameFor({ scale: 1, offsetLeft: 0, offsetTop: 120, width: 402, height: 520 }, 874)).toMatchObject({ top: 120, height: 520 });
  });
});
