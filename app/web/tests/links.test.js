import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const src = path.resolve(import.meta.dirname, "..", "src");
const css = readFileSync(path.join(src, "styles.css"), "utf8");

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* files(full);
    else if (full.endsWith(".jsx")) yield full;
  }
}

/**
 * Anchors that are deliberately not text links: a file card that is one link that downloads, an inline media box, the links of
 * rendered Markdown (styled by `.md a`), and the public pages' own text (their links styled by `.legal-doc a`, and their name at the top).
 */
const OWN_STYLE = new Set(["ui/FileCard.jsx", "ui/MediaBody.jsx", "ui/Markdown.jsx", "legal/LegalPage.jsx"]);

describe("text links share one style", () => {
  it("every anchor in the app is the shared text link or a button, or is on the short list of own-style ones", () => {
    const raw = [];
    for (const file of files(src)) {
      const rel = path.relative(src, file).split(path.sep).join("/");
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/<a\b[^>]*>/g)) {
        const tag = m[0];
        // (`cite-link`: a web page's citation chip, a superscript number, ui/cites.jsx; `row`: a row of a list that opens a page,
        // Settings › 关于.)
        if (/className=["{`][^>]*\b(text-link|btn|cite-link|row)\b/.test(tag) || OWN_STYLE.has(rel)) continue;
        raw.push(`${rel}: ${tag.slice(0, 60)}`);
      }
    }
    expect(raw).toEqual([]);
  });

  it("the style: accent colour from the variables, no underline at rest, underline on hover and focus, same colour visited, 32px hit area", () => {
    const rest = /\.text-link \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rest).toMatch(/color:\s*var\(--purple-dark\)/);
    expect(rest).toMatch(/text-decoration:\s*none/);
    expect(rest).toMatch(/min-height:\s*32px/);
    expect(css).toMatch(/\.text-link:focus-visible[^{]*\{[^}]*text-decoration:\s*underline/);
    expect(css).toMatch(/@media \(hover: hover\) \{ \.text-link:hover[^{]*\{[^}]*text-decoration:\s*underline/);
    expect(css).toMatch(/\.text-link:visited[^{]*\{[^}]*color:\s*var\(--purple-dark\)/);
  });

  it("the hit area is 44px tall on a coarse pointer or a narrow viewport", () => {
    expect(css).toMatch(/@media \(pointer: coarse\), \(max-width: 480px\) \{\s*\.text-link \{[^}]*min-height:\s*44px/);
  });

  it("a link made a button has no underline and no browser blue", () => {
    expect(css).toMatch(/:where\(a\)\.btn\s*\{[^}]*color:\s*inherit[^}]*text-decoration:\s*none/);
  });
});
