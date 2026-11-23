// The muted text colour is ONE token (--ink-3 in src/styles.css) and it reaches 4.5:1 (WCAG 1.4.3, text under 18.66 px bold) on
// every background it is used on — computed here from the stylesheet itself: the page's gradient at its strongest stops, the
// translucent columns and surfaces composited over it, the tints of a selected row, a whisper, a notice, a dialog. A token that
// fails anywhere fails here, with the background named. The badge and the solid tag (white text on a colour) are held the same.
import { describe, expect, it } from "vitest";
import { parseCss, read, rulesFor } from "./css-rules.js";

const rules = parseCss(read("src/styles.css"));
const plain = (selector) => Object.assign({}, ...rulesFor(rules, selector, null).map((r) => r.decl));
const root = plain(":root");
const token = (name) => root[name];

/** A colour of the stylesheet as [r, g, b, a]: #rgb, #rrggbb, rgba(), or var(--token). */
function colour(text) {
  const value = String(text).trim();
  const variable = /^var\((--[\w-]+)\)$/.exec(value);
  if (variable) return colour(token(variable[1]));
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join("") : hex[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).concat(1);
  }
  const rgba = /^rgba?\(([^)]+)\)$/.exec(value);
  if (rgba) {
    const [r, g, b, a = "1"] = rgba[1].split(",").map((s) => s.trim());
    return [Number(r), Number(g), Number(b), Number(a)];
  }
  throw new Error(`not a colour: ${value}`);
}
/** `top` painted over the opaque `under`. */
const over = (top, under) => {
  const [r, g, b, a] = top;
  return [r * a + under[0] * (1 - a), g * a + under[1] * (1 - a), b * a + under[2] * (1 - a), 1];
};
const channel = (c) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
/** The colour a selector's own `background` paints (its first colour). */
const bg = (selector, condition = null) => {
  const decl = Object.assign({}, ...rulesFor(rules, selector, condition).map((r) => r.decl));
  const found = /(#[0-9a-f]{3,6}\b|rgba?\([^)]+\)|var\(--[\w-]+\))/i.exec(decl.background ?? decl["background-color"] ?? "");
  if (!found) throw new Error(`no background on ${selector}`);
  return colour(found[1]);
};

// The page: the flat tone, the linear gradient's stops, and each radial stop at its strongest (its centre) over each of those.
const body = plain("body");
const base = colour(body["background-color"]);
const stops = (body["background-image"].match(/(#[0-9a-f]{6}|rgba\([^)]+\))/gi) ?? []).map(colour);
const linear = stops.filter((c) => c[3] === 1);
const radial = stops.filter((c) => c[3] < 1);
const PAGES = [base, ...linear, ...radial.flatMap((r) => [base, ...linear].map((under) => over(r, under)))];
const darkest = PAGES.reduce((low, c) => (luminance(c) < luminance(low) ? c : low));

/** Every background muted text is drawn on, as it is composited on the darkest point of the page. */
const BACKGROUNDS = {
  "the page (darkest gradient stop)": darkest,
  "the list column": over(bg(".list-col"), darkest),
  "the details column": over(bg(".side-col"), darkest),
  "the details panel as an overlay": over(bg(".side-col", "(max-width: 1280px)"), darkest),
  "the selected row": over(bg(".row.active"), over(bg(".list-col"), darkest)),
  "a whisper": over(bg(".whisper"), darkest),
  "a whisper's hit": over(bg(".whisper-hit"), over(bg(".whisper"), darkest)),
  "a message bubble": over(bg(".bubble"), darkest),
  "a notice": over(bg(".notice"), darkest),
  "a paused notice": over(bg(".notice-pause"), darkest),
  "the visibility banner": over(bg(".vis-banner"), darkest),
  "a 保险箱 (vault)": over(bg(".memory-vault"), darkest),
  "the model panel of a member": over(bg(".member-rows .member-body > .model-panel"), over(bg(".side-col"), darkest)),
  "a dialog": over(bg(".modal"), darkest),
  "a picker": over(bg(".model-pop"), darkest),
  "the picker's search box": over(bg(".model-search"), colour("#fff")),
  "the mention picker's chosen row": over(bg('.mention-picker button[aria-selected="true"]'), colour("#fcfaff")),
  "an ok notice": colour(token("--ok-bg")),
  "a warning notice": colour(token("--warn-bg")),
};

describe("the muted text colour", () => {
  it("is the one token --ink-3: .muted and the hints use it", () => {
    expect(plain(".muted").color).toBe("var(--ink-3)");
    expect(plain(".field-hint").color).toBe("var(--ink-3)");
    expect(plain(".msg-meta time").color).toBe("var(--ink-3)");
  });

  it.each(Object.keys(BACKGROUNDS))("reaches 4.5:1 on %s", (name) => {
    const ink = colour(token("--ink-3"));
    expect(Number(ratio(ink, BACKGROUNDS[name]).toFixed(2)), name).toBeGreaterThanOrEqual(4.5);
  });

  it("stays quieter than the second ink, so muted text still reads as muted", () => {
    expect(luminance(colour(token("--ink-3")))).toBeGreaterThan(luminance(colour(token("--ink-2"))));
  });
});

describe("white text on a colour", () => {
  it.each([
    ["the unread badge", ".badge"],
    ["the solid tag", ".tag-solid"],
  ])("%s reaches 4.5:1", (name, selector) => {
    expect(Number(ratio(colour("#fff"), bg(selector)).toFixed(2)), name).toBeGreaterThanOrEqual(4.5);
  });
});

describe("the marks of a model row", () => {
  // The chip over the picker (white), over the keyboard's row, and on the provider page (the page at its darkest, the model row's own ground).
  const grounds = {
    "a picker": colour("#fff"),
    "the active row": over(bg(".model-option.active"), colour("#fff")),
    "the provider page (darkest point of the page)": darkest,
  };
  it.each(Object.keys(grounds))("an ability's icon reaches 3:1 and its word 4.5:1 on its chip over %s", (name) => {
    const chip = over(bg(".model-mark"), grounds[name]);
    const ink = colour(plain(".model-mark").color);
    expect(Number(ratio(ink, chip).toFixed(2)), name).toBeGreaterThanOrEqual(4.5);
  });
  it.each([
    ["免费", ".model-mark-free"],
    ["需余额", ".model-mark-paid"],
  ])("%s reaches 4.5:1 on its chip", (_, selector) => {
    expect(Number(ratio(colour(plain(selector).color), bg(selector)).toFixed(2))).toBeGreaterThanOrEqual(4.5);
  });
  it("the legend's words and icons (the muted ink) reach 4.5:1 on the picker they stand in", () => {
    const ink = colour(plain(".model-legend").color);
    expect(Number(ratio(ink, over(bg(".model-pop"), darkest)).toFixed(2))).toBeGreaterThanOrEqual(4.5);
  });
});
