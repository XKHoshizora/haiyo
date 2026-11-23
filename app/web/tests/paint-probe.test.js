// @vitest-environment jsdom
// The paint probe (src/debug/paintProbe.js): a debug-only switch for the diagnosis of the blank band on the long forms (F2). With `?paint=a|b|c|d` in the
// address it applies one candidate mitigation (styles/paint-probe.css) and shows which one; without it nothing at all happens. To be removed with the diagnosis.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { applyPaintProbe } from "../src/debug/paintProbe.js";

const label = () => document.querySelector("[data-paint-label]");
const at = (search) => history.replaceState(null, "", `/agents/new${search}`);

beforeEach(() => {
  sessionStorage.clear();
  document.documentElement.removeAttribute("data-paint");
  label()?.remove();
});
afterEach(() => at(""));

describe("the paint probe", () => {
  it("does nothing without ?paint= (no attribute, no label, nothing stored)", () => {
    at("");
    applyPaintProbe();
    expect(document.documentElement.hasAttribute("data-paint")).toBe(false);
    expect(label()).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });

  for (const variant of ["a", "b", "c", "d"]) {
    it(`?paint=${variant} sets the variant and says so on screen`, () => {
      at(`?paint=${variant}`);
      applyPaintProbe();
      expect(document.documentElement.getAttribute("data-paint")).toBe(variant);
      expect(label().textContent).toBe(`paint ${variant}`);
      expect(label().getAttribute("aria-hidden")).toBe("true");
    });
  }

  it("keeps the variant for the session when the address no longer has it, and ?paint=off clears it", () => {
    at("?paint=c");
    applyPaintProbe();
    document.documentElement.removeAttribute("data-paint");
    label().remove();
    at("");
    applyPaintProbe();
    expect(document.documentElement.getAttribute("data-paint")).toBe("c");
    at("?paint=off");
    document.documentElement.removeAttribute("data-paint");
    label()?.remove();
    applyPaintProbe();
    expect(document.documentElement.hasAttribute("data-paint")).toBe(false);
    expect(label()).toBeNull();
    at("");
    applyPaintProbe();
    expect(document.documentElement.hasAttribute("data-paint")).toBe(false);
  });

  it("ignores any other value", () => {
    at("?paint=zzz");
    applyPaintProbe();
    expect(document.documentElement.hasAttribute("data-paint")).toBe(false);
  });

  it("every rule of the probe's stylesheet is under html[data-paint=...] (no effect without it)", () => {
    const css = readFileSync(path.join(import.meta.dirname, "..", "src", "styles", "paint-probe.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const selectors = css.split("}").map((block) => block.split("{")[0].trim()).filter(Boolean).flatMap((list) => list.split(","));
    expect(selectors.length).toBeGreaterThan(4);
    for (const selector of selectors) expect(selector.trim(), selector).toMatch(/^html\[data-paint="[abcd]"\]/);
  });
});
