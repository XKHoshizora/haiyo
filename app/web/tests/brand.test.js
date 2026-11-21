import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PRODUCT_NAME } from "../src/brand.js";

const root = path.resolve(import.meta.dirname, "..");

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* files(full);
    else if (/\.(jsx?|html|json)$/.test(name)) yield full;
  }
}

describe("the public name", () => {
  it("is Haiyo, and the HTML title says the same", () => {
    expect(PRODUCT_NAME).toBe("Haiyo");
    expect(readFileSync(path.join(root, "index.html"), "utf8")).toContain(`<title>${PRODUCT_NAME}</title>`);
  });

  it("is written once: no other source line spells it, and the old name is not shown anywhere (storage keys and file names are not text)", () => {
    const literal = [];
    const old = [];
    for (const file of files(path.join(root, "src"))) {
      if (file.endsWith(path.join("src", "brand.js"))) continue;
      readFileSync(file, "utf8").split(/\r?\n/).forEach((line, i) => {
        if (/^\s*(\/\/|\/\*|\*)/.test(line)) return;
        if (/["'`>]Haiyo["'`<]|Haiyo[ 」]/.test(line) && !/PRODUCT_NAME/.test(line)) literal.push(`${path.relative(root, file)}:${i + 1}`);
        if (/Agent Family/.test(line)) old.push(`${path.relative(root, file)}:${i + 1}`);
      });
    }
    expect({ literal, old }).toEqual({ literal: [], old: [] });
  });
});
