// A small reader of src/styles.css for the tests that pin what the stylesheet says (no CSS engine runs in jsdom):
// the rules in source order, each with the at-rule conditions around it, its selectors and its declarations.
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
export const read = (file) => readFileSync(path.join(root, file), "utf8");

const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "");

/** Splits a selector list at its top-level commas. */
const splitSelectors = (list) => {
  const out = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < list.length; i += 1) {
    const c = list[i];
    if (c === "(" || c === "[") depth += 1;
    else if (c === ")" || c === "]") depth -= 1;
    else if (c === "," && depth === 0) {
      out.push(list.slice(from, i).trim());
      from = i + 1;
    }
  }
  out.push(list.slice(from).trim());
  return out.filter(Boolean);
};

const declarations = (body) => {
  const out = {};
  for (const part of body.split(/;(?![^(]*\))/)) {
    const at = part.indexOf(":");
    if (at > 0) out[part.slice(0, at).trim().toLowerCase()] = part.slice(at + 1).trim();
  }
  return out;
};

/** `[{ conditions: ["(max-width: 480px)"], selectors: [".a", ".b"], body: "color: red", decl: { color: "red" }, order }]` */
export function parseCss(source) {
  const text = stripComments(source);
  const rules = [];
  let order = 0;
  const walk = (from, to, conditions) => {
    let i = from;
    while (i < to) {
      const open = text.indexOf("{", i);
      if (open < 0 || open >= to) break;
      const head = text.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      while (j < to && depth > 0) {
        if (text[j] === "{") depth += 1;
        else if (text[j] === "}") depth -= 1;
        j += 1;
      }
      const body = text.slice(open + 1, j - 1);
      if (head.startsWith("@media") || head.startsWith("@supports") || head.startsWith("@container")) walk(open + 1, j - 1, [...conditions, head.replace(/^@\w+\s*/, "").trim()]);
      else if (!head.startsWith("@")) rules.push({ conditions, selectors: splitSelectors(head), body: body.trim(), decl: declarations(body), order: order++ });
      i = j;
    }
  };
  walk(0, text.length, []);
  return rules;
}

export const stylesheet = () => parseCss(read("src/styles.css"));

/** The rules that have exactly this selector among theirs (and the conditions, when given as a string; `null` = none). */
export const rulesFor = (rules, selector, condition) =>
  rules.filter((r) => r.selectors.includes(selector) && (condition === undefined || (condition === null ? r.conditions.length === 0 : r.conditions.includes(condition))));

/** The pixel size of a `font-size` declaration, or null when it is not in px. */
export const px = (value) => {
  const found = /^([\d.]+)px/.exec(value ?? "");
  return found ? Number(found[1]) : null;
};

/** Specificity (ids, classes + attributes + pseudo-classes, elements) of one simple selector; enough for compound class selectors. */
export function specificity(selector) {
  const bare = selector.replace(/:where\([^)]*\)/g, "");
  const ids = (bare.match(/#[\w-]+/g) ?? []).length;
  const classes = (bare.match(/\.[\w-]+|\[[^\]]*\]|:(?!:|not|is|where)[\w-]+/g) ?? []).length + (bare.match(/:not\(([^)]*)\)/g) ?? []).length;
  const elements = (bare.replace(/\[[^\]]*\]|[.#:][\w-]+(\([^)]*\))?/g, " ").match(/(^|[\s>+~])[a-z][\w-]*/gi) ?? []).length;
  return [ids, classes, elements];
}
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/**
 * The value of `property` on an element that has exactly `classes` (and no ancestors the rules could depend on), from
 * the rules outside any media query that select only by those classes: the later rule of the higher specificity wins.
 */
export function effective(rules, classes, property) {
  let best = null;
  for (const rule of rules) {
    if (rule.conditions.length || !(property in rule.decl)) continue;
    for (const selector of rule.selectors) {
      const parts = selector.match(/^(\.[\w-]+)+$/) ? selector.split(".").filter(Boolean) : null;
      if (!parts || !parts.every((c) => classes.includes(c))) continue;
      const s = specificity(selector);
      if (!best || cmp(s, best.s) > 0 || (cmp(s, best.s) === 0 && rule.order > best.order)) best = { s, order: rule.order, value: rule.decl[property] };
    }
  }
  return best?.value ?? null;
}
