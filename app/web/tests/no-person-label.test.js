// The product labels Agents and nobody else: whoever has no label is a person. No tag, line or count of the web says 真人 of a person; the
// few sentences that still use the word to tell people from Agents in a rule are listed here and nowhere else.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const SRC = path.join(import.meta.dirname, "..", "src");
/** Sentences (rules and help), not labels: kept for the owner to decide. */
const SENTENCES = ["data/errorTexts.js", "legal/texts/terms.zh.md", "pages/AgentForm.jsx", "pages/GroupModals.jsx"];

describe("no label calls anyone a person", () => {
  it("真人 occurs only in the listed sentences", () => {
    const found = walk(SRC)
      .filter((f) => readFileSync(f, "utf8").includes("真人"))
      .map((f) => path.relative(SRC, f).split(path.sep).join("/"))
      .sort();
    expect(found).toEqual([...SENTENCES].sort());
  });

  it("no Tag of the `human` tone is drawn", () => {
    for (const f of walk(SRC).filter((f) => /\.jsx?$/.test(f))) expect(readFileSync(f, "utf8"), f).not.toMatch(/tone="human"/);
  });
});
