import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The service runs from a production install (`npm ci --omit=dev`): `npm run build` compiles src/ to dist/
 * with dev dependencies present, and everything that starts it afterwards is plain `node` on dist/.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sourceFiles(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : [],
  );
}

/** The package a bare specifier names (`@scope/name/sub` → `@scope/name`), or null for a relative path. */
function packageOf(specifier: string): string | null {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return null;
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

describe("production build", () => {
  it("npm start and the CLI's :prod scripts run plain node on the build in dist/", () => {
    const prod = Object.entries(pkg.scripts).filter(([name]) => name === "start" || name.endsWith(":prod"));
    expect(prod.map(([name]) => name).sort()).toEqual([
      "attachments:sweep:prod",
      "credits:grant:prod",
      "credits:show:prod",
      "inbox:list:prod",
      "invite:create:prod",
      "invite:list:prod",
      "invite:revoke:prod",
      "mail:status:prod",
      "memory:stats:prod",
      "migrate:prod",
      "models:list:prod",
      "start",
      "tier:set:prod",
    ]);
    for (const [name, command] of prod) {
      expect([name, command]).toEqual([name, expect.stringMatching(/^node --enable-source-maps dist\/(server|cli)\.js( [a-z:]+)?$/)]);
    }
    expect(pkg.scripts.build).toMatch(/tsc -p tsconfig\.build\.json$/);
  });

  it("everything src/ imports at run time is a production dependency or part of Node", () => {
    const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
    const imported = new Set<string>();
    for (const file of sourceFiles(path.join(root, "src"))) {
      const text = readFileSync(file, "utf8");
      // Type-only imports are erased by the build; everything else is loaded when the module is.
      for (const m of text.matchAll(/^(?:import|export)\s+(?!type\b)(?:[^;]*?\s+from\s+)?"([^"]+)"/gm)) imported.add(m[1]!);
      for (const m of text.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g)) imported.add(m[1]!);
    }
    const packages = [...imported].map(packageOf).filter((p): p is string => p !== null && !builtins.has(p));
    expect(packages.length).toBeGreaterThan(5);
    for (const p of new Set(packages)) expect([p, p in pkg.dependencies]).toEqual([p, true]);
  });

  it("a JSON file src/ imports (the model and provider catalogues) is inside src/, imported as JSON, so the build copies it to dist/", () => {
    const tsconfig = JSON.parse(readFileSync(path.join(root, "tsconfig.json"), "utf8")) as { compilerOptions: Record<string, unknown> };
    expect(tsconfig.compilerOptions.resolveJsonModule).toBe(true);
    const imports: string[] = [];
    for (const file of sourceFiles(path.join(root, "src"))) {
      for (const m of readFileSync(file, "utf8").matchAll(/^import\s+[^;]*?\s+from\s+"([^"]+\.json)"([^;\n]*);/gm)) {
        const target = path.resolve(path.dirname(file), m[1]!);
        // Node loads JSON only with the import attribute; tsc copies it to dist/ only from under rootDir (src/).
        expect([m[1], m[2]!.trim()]).toEqual([m[1], 'with { type: "json" }']);
        expect([m[1], path.relative(path.join(root, "src"), target).startsWith("..")]).toEqual([m[1], false]);
        imports.push(path.relative(root, target).split(path.sep).join("/"));
      }
    }
    expect(imports).toEqual(["src/providers/provider-catalog.json", "src/providers/model-catalog.json"]);
  });
});
