// What the stylesheet and the page say for a phone (iPhone Safari): pinned as text, since jsdom runs no CSS engine. The
// behaviour itself (focus zoom, a tap) needs a real device; tests/mobile-layout.test.jsx and e2e/mobile.spec.mjs do the rest.
import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { effective, px, read, rulesFor, specificity, stylesheet } from "./css-rules.js";

const rules = stylesheet();
const COARSE = "(pointer: coarse)";
const PHONE = "(max-width: 640px)";

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const merged = (list) => list.map((r) => r.decl).reduce((all, d) => ({ ...all, ...d }), {});
const plain = (selector) => merged(rulesFor(rules, selector, null));
const phone = (selector) => merged(rulesFor(rules, selector, PHONE));

describe("a text field never makes iOS zoom the page", () => {
  const floor = rules.filter((r) => r.conditions.length === 1 && r.conditions[0] === COARSE && r.decl["font-size"] !== undefined);
  const covered = (target) => floor.some((r) => r.selectors.some((s) => s.includes(target)) && /^16px\s*!important$/.test(r.decl["font-size"]));

  it("one rule under (pointer: coarse) sets 16px on every input, textarea, select, contenteditable and the composer's mirror", () => {
    for (const target of ["input", "textarea", "select", ".composer-mirror", "[contenteditable"]) expect(covered(target), target).toBe(true);
    // Not behind a width: an iPad is as much a touch screen as a phone.
    for (const r of floor) expect(r.conditions).toEqual([COARSE]);
  });

  it("leaves out the controls that show no text (checkbox, radio, range, file)", () => {
    const selector = floor.flatMap((r) => r.selectors).find((s) => s.includes("input"));
    for (const kind of ["checkbox", "radio", "range", "file"]) expect(selector).toContain(`[type="${kind}"]`);
  });

  it("no field on any page sets its own size inline", () => {
    for (const file of walk("src").filter((f) => /\.jsx$/.test(f))) {
      const source = read(file);
      for (const tag of source.match(/<(input|textarea|select)\b[^>]*>/g) ?? []) expect(tag, `${file}: ${tag}`).not.toMatch(/fontSize/);
    }
  });

  it("the desktop sizes below 16px exist (what the floor beats), so the floor is not dead", () => {
    const small = rules.filter((r) => r.conditions.length === 0 && r.selectors.some((s) => /(^|[\s>])(input|textarea)\b|\.composer-mirror/.test(s)) && px(r.decl["font-size"]) !== null && px(r.decl["font-size"]) < 16);
    expect(small.length).toBeGreaterThan(0);
  });

  it("the page's viewport meta keeps the user's zoom (no maximum-scale, no user-scalable) and covers the notch", () => {
    const meta = read("index.html").match(/<meta name="viewport" content="([^"]*)"/)[1];
    expect(meta).toContain("viewport-fit=cover");
    expect(meta).not.toMatch(/maximum-scale|user-scalable|minimum-scale/);
  });
});

describe("hover only where there is a hover", () => {
  it("every rule with :hover in a selector is inside @media (hover: hover)", () => {
    const loose = rules.filter((r) => r.selectors.some((s) => s.includes(":hover")) && !r.conditions.includes("(hover: hover)"));
    expect(loose.map((r) => r.selectors.join(", "))).toEqual([]);
  });

  it("a rule that mixes :hover with keyboard focus is split, so focus still shows on touch devices", () => {
    for (const r of rules.filter((x) => x.conditions.includes("(hover: hover)"))) expect(r.selectors.every((s) => s.includes(":hover")), r.selectors.join(", ")).toBe(true);
  });

  it("the focus ring of a button shows for the keyboard only (a tap leaves none)", () => {
    const sticky = rules.flatMap((r) => r.selectors).filter((s) => /(model|select)-trigger[^,]*:focus(?![-\w])/.test(s));
    expect(sticky).toEqual([]);
  });
});

describe("a tap is a tap", () => {
  it("tappable controls say touch-action: manipulation (no double-tap wait)", () => {
    const rule = rules.find((r) => r.conditions.length === 0 && r.decl["touch-action"] === "manipulation");
    expect(rule).toBeTruthy();
    for (const sel of ["button", "a", '[role="button"]', '[role="tab"]', "label", "summary"]) expect(rule.selectors).toContain(sel);
  });
});

describe("the Agent fallback letter is centred", () => {
  it("an element with both classes of the fallback is a grid that centres, whatever the .avatar-img rule says", () => {
    const classes = ["avatar-img", "avatar-fallback"];
    expect(effective(rules, classes, "display")).toBe("grid");
    expect(effective(rules, classes, "place-items")).toBe("center");
  });

  it("the specificity helper counts two classes as two", () => {
    expect(specificity(".avatar-img.avatar-fallback")).toEqual([0, 2, 0]);
  });
});

describe("the image viewer lays out against what is visible", () => {
  const viewerText = rulesFor(rules, ".viewer", null).map((r) => r.body).join(";");
  it("is fixed over the visible viewport, above the tab bar, sized in dynamic units", () => {
    expect(plain(".viewer").position).toBe("fixed");
    expect(viewerText).toMatch(/100dvh/);
    expect(viewerText).toMatch(/100dvw/);
    expect(Number(plain(".viewer")["z-index"])).toBeGreaterThan(Number(plain(".rail")["z-index"] ?? 0));
  });

  it("keeps its bar below the notch and its controls above the home indicator", () => {
    expect(plain(".viewer-bar").padding).toContain("env(safe-area-inset-top");
    expect(plain(".viewer-bar").padding).toContain("env(safe-area-inset-left");
    expect(plain(".viewer-stage").padding).toContain("env(safe-area-inset-bottom");
  });

  it("cuts a long sender or file name with an ellipsis instead of pushing the bar wider", () => {
    for (const selector of [".viewer-name", ".viewer-who"]) {
      expect(plain(selector)["text-overflow"], selector).toBe("ellipsis");
      expect(plain(selector)["white-space"], selector).toBe("nowrap");
      expect(plain(selector)["min-width"], selector).toBe("0");
    }
    expect(plain(".viewer-bar")["flex-wrap"]).toBe("nowrap");
  });
});

describe("the phone's bottom tab bar (the rail below 641px)", () => {
  it("is a full-width row of equal columns with a hairline above it and the home indicator's room below", () => {
    const rail = phone(".rail");
    expect(rail.display).toBe("grid");
    expect(rail["grid-template-columns"]).toMatch(/repeat\(4,\s*(1fr|minmax\(0,\s*1fr\))\)/);
    expect(rail["border-top"]).toContain("1px solid");
    expect(rail["padding-bottom"]).toContain("env(safe-area-inset-bottom");
    expect(rail.width).toBe("100%");
  });

  it("each target is at least 44px high, the icon above a 11–12px label, the current one in the accent colour", () => {
    const item = phone(".rail-item");
    expect(px(item["min-height"])).toBeGreaterThanOrEqual(44);
    expect(px(item["font-size"])).toBeGreaterThanOrEqual(11);
    expect(px(item["font-size"])).toBeLessThanOrEqual(12);
    expect(item["flex-direction"]).toBe("column");
    expect(phone(".rail-item.active").color).toBe("var(--purple-dark)");
  });

  it("the shell stacks the columns above it, and a toast clears it", () => {
    expect(phone(".app")["flex-direction"]).toBe("column");
    expect(rulesFor(rules, '.app[data-tabbar="on"] .toast', PHONE).length).toBe(1);
  });

  it("desktop and tablet keep the left rail exactly as it was", () => {
    const base = plain(".rail");
    expect(base.width).toBe("var(--rail)");
    expect(base["flex-direction"]).toBe("column");
    expect(base["border-right"]).toBe("1px solid var(--line)");
    expect(base.display).toBe("flex");
    // (The one-column layout below 861px keeps its 60px rail; only the phone query turns it over.)
    expect(merged(rulesFor(rules, ":root", "(max-width: 860px)"))["--rail"]).toBe("60px");
  });

  it("the shell keeps clear of the notch and the home indicator", () => {
    const app = plain(".app");
    expect(app.padding).toContain("env(safe-area-inset-top");
    expect(app.padding).toContain("env(safe-area-inset-left");
    expect(plain('.app:not([data-tabbar="on"])')["padding-bottom"]).toContain("env(safe-area-inset-bottom");
  });
});

describe("a button's width does not change while it saves", () => {
  it("the avatar dialog's save button has a floor wide enough for 保存中…", () => {
    expect(plain(".btn-save")["min-width"]).toMatch(/4em/);
  });
});

describe("the chat header on a phone is one row", () => {
  const narrow = (selector, condition = "(max-width: 860px)") => merged(rulesFor(rules, selector, condition));
  it("does not wrap: the actions keep their size at the right of the same row, the title gives way", () => {
    expect(narrow(".chat-head")["flex-wrap"]).toBe("nowrap");
    expect(narrow(".chat-head-actions").flex).toBe("none");
    expect(narrow(".chat-head-actions")["flex-basis"]).toBeUndefined();
    expect(plain(".chat-title")["min-width"]).toBe("0");
  });

  it("every control of it is a 44px target", () => {
    expect(px(narrow(".chat-head .icon-btn")["min-width"] ?? narrow(".chat-head .icon-btn").width)).toBeGreaterThanOrEqual(44);
    expect(px(narrow(".chat-head .icon-btn").height)).toBeGreaterThanOrEqual(44);
    expect(px(narrow(".icon-btn.boxed").width)).toBeGreaterThanOrEqual(44);
  });

  it("the subtitle hides below 340px so nothing overlaps at 320", () => {
    expect(narrow(".chat-title p", "(max-width: 339px)").display).toBe("none");
  });
});

describe("the two widths are one number each", () => {
  it("the stylesheet's media queries use the constants of ui/breakpoints.js", async () => {
    const { ONE_COLUMN_MAX, PHONE_MAX } = await import("../src/ui/breakpoints.js");
    const conditions = new Set(rules.flatMap((r) => r.conditions));
    expect(conditions.has(`(max-width: ${ONE_COLUMN_MAX}px)`)).toBe(true);
    expect(conditions.has(`(max-width: ${PHONE_MAX}px)`)).toBe(true);
    const { PHONE_QUERY } = await import("../src/ui/pointer.js");
    expect(PHONE_QUERY).toBe(`(max-width: ${PHONE_MAX}px)`);
  });
});

describe("the touch floor cannot shrink a field", () => {
  it("no rule of the stylesheet sizes a field above 16px (the floor sets 16px: a larger authored size would be lost)", () => {
    const fields = rules.filter((r) => r.selectors.some((s) => /(^|[\s>])(input|textarea|select)\b|\.composer-mirror|-input\b/.test(s)));
    for (const r of fields) if (px(r.decl["font-size"]) !== null) expect(px(r.decl["font-size"]), r.selectors.join(", ")).toBeLessThanOrEqual(16);
  });
});
