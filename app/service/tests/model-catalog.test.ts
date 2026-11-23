import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ABILITIES, catalogReadme, catalogSummary, diffCatalog, formatCatalog, guardCatalog, guardProviders, reduceCatalog, type CatalogEntry } from "../scripts/update-model-catalog.mjs";

/**
 * The vendored models.dev snapshot (src/providers/model-catalog.json): how the update script reduces the two catalogue
 * files (a fixture here: no network in tests), and that the committed snapshot is what `modelHints` expects.
 */

const effort = (...values: string[]) => [{ type: "effort", values }];
const MODELS = {
  "openai/GPT-Next": { id: "openai/GPT-Next", name: "GPT Next", reasoning: true, modalities: { input: ["text", "image", "pdf"], output: ["text"] }, limit: { context: 400000, output: 128000 } },
  "openai/o-mini": { name: "o mini", reasoning: true, modalities: { input: ["text"], output: ["text"] }, limit: { context: 200000 } },
  "anthropic/claude-x": { name: "Claude X", reasoning: true, modalities: { input: ["text", "image", "pdf"], output: ["text"] }, limit: { context: 1000000 } },
  "google/gemini-x": { name: "Gemini X", reasoning: true, modalities: { input: ["text", "image", "pdf", "audio", "video"], output: ["text"] }, limit: { context: 1048576 } },
  "minimax/MiniMax-X": { name: "MiniMax X", reasoning: true, modalities: { input: ["text"], output: ["text"] }, limit: { context: 0 } },
  "acme/thinker": { name: "Thinker", reasoning: true, modalities: { input: ["text"], output: ["text"] } },
  "acme/shy": { name: "Shy", reasoning: true, modalities: { input: ["text"], output: ["text"] }, limit: { context: 8000 } },
  "acme/plain": { name: "  Plain  ", reasoning: false, modalities: { input: ["text"], output: ["text"] }, limit: { context: 32768.5 } },
  "acme/embed-x": { name: "Embed X", type: "embedding", reasoning: false, modalities: { input: ["text"], output: ["text"] }, limit: { context: 8192 } },
  "acme/painter": { name: "Painter", type: "image", reasoning: false, modalities: { input: ["text", "image"], output: ["image"] } },
  "acme/ears": { name: "Ears", reasoning: false, modalities: { input: ["audio"], output: ["text"] } },
  "other/plain": { name: "Other\nplain", reasoning: false, modalities: { input: ["text"], output: ["text"] } },
  "acme/broken": "not an entry",
};
const API = {
  openai: { models: { "GPT-Next": { reasoning_options: effort("none", "minimal", "low", "medium", "high", "xhigh", "max") }, "o-mini": { reasoning_options: effort("high", "low", "medium") } } },
  anthropic: { models: { "claude-x": { reasoning_options: effort("low", "medium", "high", "xhigh", "max") } } },
  google: { models: { "gemini-x": { reasoning_options: [{ type: "budget_tokens", min: 128, max: 32768 }] } } },
  minimax: { models: { "MiniMax-X": { reasoning_options: [{ type: "toggle" }] } } },
  acme: { models: { shy: { reasoning_options: effort("none", "minimal", "turbo") }, plain: { reasoning_options: effort("low") } } },
  // Not the lab's own entry: another provider reselling the lab's model says nothing about it.
  resold: { models: { thinker: { reasoning_options: effort("low") } } },
};

describe("reduceCatalog (the update script)", () => {
  const reduced = reduceCatalog(MODELS, API);
  const byKey = new Map(reduced.map((e) => [`${e.lab}/${e.id}`, e]));

  it("keeps id, lab, display name, vision, pdf, reasoning, chat and the context; sorted by id, then lab", () => {
    expect(reduced.map((e) => `${e.lab}/${e.id}`)).toEqual([
      "anthropic/claude-x",
      "acme/ears",
      "acme/embed-x",
      "google/gemini-x",
      "openai/gpt-next",
      "minimax/minimax-x",
      "openai/o-mini",
      "acme/painter",
      "acme/plain",
      "other/plain",
      "acme/shy",
      "acme/thinker",
    ]);
    expect(byKey.get("openai/gpt-next")).toEqual({
      id: "gpt-next",
      lab: "openai",
      name: "GPT Next",
      vision: true,
      pdf: true,
      reasoning: true,
      chat: true,
      contextTokens: 400000,
      reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
    });
    // A context that is no positive whole number is left out; so is a display name that is not one line.
    expect(byKey.get("minimax/minimax-x")).not.toHaveProperty("contextTokens");
    expect(byKey.get("acme/thinker")).not.toHaveProperty("contextTokens");
    expect(byKey.get("acme/plain")).toEqual({ id: "plain", lab: "acme", name: "Plain", vision: false, pdf: false, reasoning: false, chat: true });
    expect(byKey.get("other/plain")!.name).toBe("plain");
  });

  it("chat: takes and answers text, and is not an embedding, image, … model by the catalogue's type", () => {
    expect([...byKey.values()].filter((e) => !e.chat).map((e) => e.id)).toEqual(["ears", "embed-x", "painter"]);
    expect(byKey.get("acme/painter")).toMatchObject({ vision: true, chat: false });
  });

  it("thinking levels: the lab's own effort values among ours, in our order; none for toggle, budget_tokens, no entry or nothing left", () => {
    expect(byKey.get("openai/gpt-next")!.reasoningLevels).toEqual(["low", "medium", "high", "xhigh", "max"]); // none and minimal dropped
    expect(byKey.get("openai/o-mini")!.reasoningLevels).toEqual(["low", "medium", "high"]); // put in order
    expect(byKey.get("anthropic/claude-x")!.reasoningLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    for (const key of ["google/gemini-x", "minimax/minimax-x", "acme/shy", "acme/thinker", "acme/plain"]) expect([key, byKey.get(key)]).not.toHaveProperty([1, "reasoningLevels"]);
    // (acme/plain: levels given, but the model does not reason.)
  });

  it("refuses what is not a catalogue; reads without api.json too", () => {
    for (const bad of [null, [], "x", 1]) expect(() => reduceCatalog(bad)).toThrow();
    expect(reduceCatalog({ "a/b": { name: "B", reasoning: true, modalities: { input: ["text"], output: ["text"] } } })).toEqual([
      { id: "b", lab: "a", name: "B", vision: false, pdf: false, reasoning: true, chat: true },
    ]);
  });

  it("abilities: tools from tool_call, audio and video taken, image, video and audio answered — each only when true", () => {
    const got = reduceCatalog({
      "acme/all": { name: "All", tool_call: true, reasoning: false, modalities: { input: ["text", "image", "audio", "video"], output: ["text", "image", "audio", "video"] } },
      "acme/none": { name: "None", tool_call: false, reasoning: false, modalities: { input: ["text"], output: ["text"] } },
      "acme/odd": { name: "Odd", tool_call: "yes", reasoning: false, modalities: { input: ["text", "Audio"], output: ["text"] } },
    });
    expect(got).toEqual([
      { id: "all", lab: "acme", name: "All", vision: true, pdf: false, reasoning: false, chat: true, tools: true, audioIn: true, videoIn: true, imageOut: true, videoOut: true, audioOut: true },
      { id: "none", lab: "acme", name: "None", vision: false, pdf: false, reasoning: false, chat: true },
      { id: "odd", lab: "acme", name: "Odd", vision: false, pdf: false, reasoning: false, chat: true },
    ]);
    expect(byKey.get("google/gemini-x")).toMatchObject({ audioIn: true, videoIn: true });
    expect(byKey.get("acme/painter")).toMatchObject({ imageOut: true });
    expect(byKey.get("openai/gpt-next")).not.toHaveProperty("tools");
    expect(ABILITIES).toEqual(["vision", "pdf", "reasoning", "tools", "audioIn", "videoIn", "imageOut", "videoOut", "audioOut"]);
  });

  it("a lab or an id that is not one short line is left out: nothing of the catalogue's can add a line to a summary or a commit message", () => {
    const fine = { name: "Fine", reasoning: false, modalities: { input: ["text"], output: ["text"] } };
    const got = reduceCatalog({
      "acme/fine": fine,
      "evil\nCo-authored-by: x <x@y>/m": fine,
      "acme/bad\u0000id": fine,
      "acme/tab\tid": fine,
      [`${"l".repeat(101)}/m`]: fine,
      [`acme/${"i".repeat(101)}`]: fine,
      [`${"l".repeat(100)}/${"i".repeat(100)}`]: fine,
    });
    expect(got.map((e) => [e.lab.length, e.id.length])).toEqual([[4, 4], [100, 100]]);
    expect(catalogSummary([], got).split("\n")).toHaveLength(5);
  });

  it("writes one entry per line, and a README with the source, date, licence and count", () => {
    const text = formatCatalog(reduced);
    expect(JSON.parse(text)).toEqual(reduced);
    expect(text.split("\n")).toHaveLength(reduced.length + 3);
    const readme = catalogReadme({ fetched: "2026-11-17", count: 12 });
    for (const part of ["https://models.dev/models.json", "Fetched: 2026-11-17", "Licence: MIT", "Entries: 12", "Copyright (c) 2025 models.dev"]) expect(readme).toContain(part);
  });
});

/** `n` entries m10, m11, … (crossing 100 from 91 on), each with vision unless `more` says otherwise. */
const many = (n: number, more: Partial<CatalogEntry> = {}): CatalogEntry[] =>
  Array.from({ length: n }, (_, i) => ({ id: `m${i + 10}`, lab: "acme", name: `M${i + 10}`, vision: true, pdf: false, reasoning: false, chat: true, ...more }));

describe("diffCatalog and catalogSummary (what an update's commit message says)", () => {
  it("names what was added, removed and whose abilities changed, by lab/id, sorted; chat, name and context are no ability", () => {
    const prev = many(120);
    const next: CatalogEntry[] = [
      ...prev.slice(2).map((e, i) => (i === 0 ? { ...e, tools: true as const } : i === 1 ? { ...e, vision: false } : i === 2 ? { ...e, name: "Renamed", contextTokens: 5, chat: false } : e)),
      { id: "new", lab: "zeta", name: "New", vision: false, pdf: false, reasoning: false, chat: true },
    ];
    const diff = diffCatalog(prev, next);
    expect(diff).toEqual({ added: ["zeta/new"], removed: ["acme/m10", "acme/m11"], changed: ["acme/m12", "acme/m13"] });
    expect(diffCatalog(prev, prev)).toEqual({ added: [], removed: [], changed: [] });
    // The same id under two labs is two models.
    expect(diffCatalog([{ ...prev[0]!, lab: "a" }], [{ ...prev[0]!, lab: "b" }])).toEqual({ added: ["b/m10"], removed: ["a/m10"], changed: [] });
    const text = catalogSummary(prev, next);
    expect(text.split("\n")).toEqual([
      "Models: 120 -> 119",
      "Added (1): zeta/new",
      "Removed (2): acme/m10, acme/m11",
      "Abilities changed (2): acme/m12, acme/m13",
      "With tools: 1; audio in: 0; video in: 0; image out: 0; video out: 0; audio out: 0",
    ]);
  });

  it("lists at most 20 names of each, and says how many more", () => {
    const text = catalogSummary([], many(25));
    const added = text.split("\n")[1]!;
    expect(added.startsWith("Added (25): acme/m10, acme/m11, ")).toBe(true);
    expect(added.endsWith("acme/m29, and 5 more")).toBe(true);
    expect(text).toContain("Removed (0): none");
  });
});

describe("guardCatalog (an upstream outage or format change must not wipe the catalogue)", () => {
  const prev = many(200);
  it("passes the same catalogue, a grown one, and one that lost up to 20 % of its entries and 5 % of its able ids", () => {
    expect(() => guardCatalog(prev, prev)).not.toThrow();
    expect(() => guardCatalog(prev, [...prev, ...many(300).slice(200)])).not.toThrow();
    // 10 of 200 gone: 5 % of the able ids, 5 % of the entries.
    expect(() => guardCatalog(prev, prev.slice(10))).not.toThrow();
    // No previous snapshot: nothing to compare with.
    expect(() => guardCatalog([], prev)).not.toThrow();
  });

  it("refuses one that lost more than 5 % of the ids that had abilities — gone, or there with none left", () => {
    expect(() => guardCatalog(prev, prev.slice(11))).toThrow(/abilities/);
    // A format change: every id still there, the abilities read as nothing.
    expect(() => guardCatalog(prev, prev.map((e) => ({ ...e, vision: false })))).toThrow(/abilities/);
    // 11 of them lost theirs, the rest kept: refused; 10: passed.
    expect(() => guardCatalog(prev, prev.map((e, i) => (i < 11 ? { ...e, vision: false } : e)))).toThrow(/abilities/);
    expect(() => guardCatalog(prev, prev.map((e, i) => (i < 10 ? { ...e, vision: false } : e)))).not.toThrow();
    // Every model still has an ability, but one ability is gone from all of them: refused for that ability.
    expect(() => guardCatalog(prev, prev.map((e) => ({ ...e, vision: false, tools: true as const })))).toThrow(/vision/);
  });

  it("refuses one in which a single ability went missing (its field renamed upstream) though every model kept another", () => {
    const both = many(200, { tools: true });
    // Every model still has vision: the loss of tools alone is refused; so is a fifth of it and one more.
    expect(() => guardCatalog(both, both.map(({ tools: _tools, ...e }) => e))).toThrow(/tools/);
    expect(() => guardCatalog(both, both.map((e, i) => (i < 41 ? { ...e, tools: undefined } : e)))).toThrow(/tools/);
    expect(() => guardCatalog(both, both.map((e, i) => (i < 40 ? { ...e, tools: undefined } : e)))).not.toThrow();
    // An ability too few models had to judge by (fewer than 10) may come and go.
    const rare = many(200).map((e, i) => (i < 9 ? { ...e, videoOut: true as const } : e));
    expect(() => guardCatalog(rare, many(200))).not.toThrow();
    const ten = many(200).map((e, i) => (i < 10 ? { ...e, videoOut: true as const } : e));
    expect(() => guardCatalog(ten, many(200))).toThrow(/videoOut/);
  });

  it("refuses one in which an ability flipped on more than 20 % of the models both have — a mass gain too", () => {
    const plain = many(200);
    expect(() => guardCatalog(plain, plain.map((e) => ({ ...e, tools: true as const })))).toThrow(/tools/);
    expect(() => guardCatalog(plain, plain.map((e, i) => (i < 41 ? { ...e, tools: true as const } : e)))).toThrow(/tools/);
    expect(() => guardCatalog(plain, plain.map((e, i) => (i < 40 ? { ...e, tools: true as const } : e)))).not.toThrow();
    // New models bring their abilities freely: only models both snapshots have are compared.
    expect(() => guardCatalog(plain, [...plain, ...many(300, { tools: true }).slice(200)])).not.toThrow();
  });

  it("guardProviders: refuses a provider list that lost more than 20 % of its providers or of its model ids", () => {
    const providers = (n: number, ids: number) => Array.from({ length: n }, (_, i) => ({ id: `p${i + 10}`, hosts: [`api.p${i + 10}.example.com`], models: Array.from({ length: ids }, (_, k) => `m${k + 10}`) }));
    const prev = providers(100, 10);
    expect(() => guardProviders(prev, prev)).not.toThrow();
    expect(() => guardProviders([], prev)).not.toThrow();
    expect(() => guardProviders(prev, prev.slice(20))).not.toThrow();
    expect(() => guardProviders(prev, prev.slice(21))).toThrow(/providers/);
    expect(() => guardProviders(prev, providers(100, 8))).not.toThrow();
    expect(() => guardProviders(prev, providers(100, 7))).toThrow(/model ids/);
  });

  it("refuses one that shrank by more than 20 %, whatever its abilities", () => {
    const plain = many(200, { vision: false });
    expect(() => guardCatalog(plain, plain.slice(40))).not.toThrow();
    expect(() => guardCatalog(plain, plain.slice(41))).toThrow(/shrank/);
  });
});

describe("the daily update: the job (.github/workflows/catalog-update.yml) and its trigger for the default branch (docs/dev/)", () => {
  const workflow = readFileSync(new URL("../../../.github/workflows/catalog-update.yml", import.meta.url), "utf8");
  const trigger = readFileSync(new URL("../../../docs/dev/catalog-update-trigger.master.yml", import.meta.url), "utf8");
  /** A file's lines that are not comments. */
  const code = (text: string) => text.split("\n").filter((line) => !/^\s*#/.test(line));

  it("the job is a reusable workflow that names no branch: called with one, or run by hand on one; it passes the guard and asks for contents: write alone", () => {
    expect(workflow).toMatch(/^on:\n  workflow_call:\n    inputs:\n      branch:\n(?:        .*\n)*?        required: true\n        type: string\n(?:\s+#.*\n)*  workflow_dispatch:\n/m);
    // No schedule here (GitHub runs one only from the default branch) and no branch name: both are the trigger's.
    expect(code(workflow).join("\n")).not.toMatch(/schedule:|cron:/);
    expect(workflow).not.toMatch(/claude\/|agent-family-review/);
    expect(workflow).toContain("      DEV_BRANCH: ${{ inputs.branch || github.ref_name }}");
    expect(workflow).toContain("ref: ${{ env.DEV_BRANCH }}");
    expect(workflow).toMatch(/node scripts\/update-model-catalog\.mjs --guard --summary=/);
    // Nothing by default; the one job asks for contents: write and nothing else.
    expect(workflow).toMatch(/^permissions: \{\}\n/m);
    expect(code(workflow).filter((l) => /^\s+permissions:/.test(l))).toEqual(["    permissions:"]);
    expect(workflow).toMatch(/^    permissions:\n      contents: write\n    #/m);
    expect(workflow).not.toContain("secrets.");
    // Actions pinned by major version, as ci.yml pins them.
    expect(workflow.match(/uses: \S+/g)).toEqual(["uses: actions/checkout@v4", "uses: actions/setup-node@v4"]);
  });

  it("the token: not left on disk for the install and the tests, handed to the push step alone; nothing of an expression reaches a shell line; the push is never forced", () => {
    expect(workflow).toMatch(/uses: actions\/checkout@v4\n        with:\n          ref: \$\{\{ env\.DEV_BRANCH \}\}\n          persist-credentials: false\n/);
    // Every `${{ }}` is the value of one of these keys — never inside a `run:` script.
    const expressions = code(workflow).filter((line) => line.includes("${{"));
    expect(expressions.map((line) => line.trim().split(":")[0])).toEqual(["DEV_BRANCH", "ref", "GH_TOKEN"]);
    // The token appears once, in the last step's `env`, after every other step.
    expect(workflow.match(/github\.token|GITHUB_TOKEN \}\}/g)).toEqual(["github.token"]);
    expect(workflow.indexOf("GH_TOKEN: ${{ github.token }}")).toBeGreaterThan(workflow.indexOf("name: Commit the snapshot"));
    const pushes = code(workflow).filter((line) => /git push/.test(line));
    expect(pushes.map((l) => l.trim())).toEqual(['git push "https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" "HEAD:refs/heads/${DEV_BRANCH}"']);
    expect(code(workflow).join("\n")).not.toMatch(/--force|-f\b.*push|push.*\s-f\b|"\+HEAD|\+refs/);
  });

  it("checks and tests before it commits: every step after the diff runs only for a changed snapshot, the commit last; the tests it names exist", () => {
    const order = ["Generate the snapshot", "Did the snapshot change?", "Service type check", "Tests that read the catalogue", "Commit the snapshot"].map((name) => workflow.indexOf(`name: ${name}`));
    expect(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1]!))).toBe(true);
    const afterDiff = workflow.slice(workflow.indexOf("id: diff"));
    const steps = afterDiff.split(/\n      - /).slice(1);
    expect(steps.length).toBeGreaterThanOrEqual(5);
    for (const step of steps) expect([step.split("\n")[0], step.includes("if: steps.diff.outputs.changed == 'true'")]).toEqual([step.split("\n")[0], true]);
    expect(afterDiff).not.toContain("continue-on-error");
    const named = workflow.match(/tests\/[a-z-]+\.test\.ts/g)!.filter((file, i, all) => all.indexOf(file) === i && i > 0);
    expect(named).toEqual(["tests/provider-catalog.test.ts", "tests/provider-hints.test.ts", "tests/providers.test.ts", "tests/models-route.test.ts", "tests/build.test.ts"]);
    expect(afterDiff).toContain("          tests/model-catalog.test.ts\n          tests/provider-catalog.test.ts\n");
    for (const file of ["tests/model-catalog.test.ts", ...named]) expect([file, existsSync(new URL(`../${file}`, import.meta.url))]).toEqual([file, true]);
  });

  it("the trigger is not a workflow on this branch; it says when, grants contents: write, and calls the job at the development branch it names twice, on adjacent lines", () => {
    // Under docs/, so nothing runs from it here; nothing else under .github/workflows/ runs on a schedule.
    expect(existsSync(new URL("../../../.github/workflows/catalog-update-trigger.yml", import.meta.url))).toBe(false);
    expect(trigger).toMatch(/^on:\n  schedule:\n(?:\s+#.*\n)*\s+- cron: "\d+ \d+ \* \* \*"\n  workflow_dispatch:\n/m);
    expect(trigger).toMatch(/^permissions:\n  contents: write\n/m);
    const lines = code(trigger).filter((line) => line.trim() !== "");
    // Nothing else: a name, the triggers, the permission, one job that calls the job's file.
    expect(lines).toEqual([
      "name: Model catalogue update",
      "on:",
      "  schedule:",
      expect.stringMatching(/^    - cron: "\d+ \d+ \* \* \*"$/),
      "  workflow_dispatch:",
      "permissions:",
      "  contents: write",
      "jobs:",
      "  update:",
      expect.stringMatching(/^    uses: [\w.-]+\/[\w.-]+\/\.github\/workflows\/catalog-update\.yml@\S+$/),
      "    with:",
      expect.stringMatching(/^      branch: \S+$/),
    ]);
    const called = lines[9]!.split("@")[1];
    expect(lines[11]).toBe(`      branch: ${called}`);
    expect(trigger).not.toContain("${{");
    expect(trigger).not.toContain("secrets");
  });
});

describe("the committed snapshot", () => {
  const text = readFileSync(new URL("../src/providers/model-catalog.json", import.meta.url), "utf8");
  const catalog = JSON.parse(text) as ReturnType<typeof reduceCatalog>;
  const LEVELS = ["low", "medium", "high", "xhigh", "max"];
  const NEW = ["tools", "audioIn", "videoIn", "imageOut", "videoOut", "audioOut"] as const;

  it("is a sorted list of more than 300 well-formed entries, written as the script writes it", () => {
    expect(catalog.length).toBeGreaterThan(300);
    expect(text).toBe(formatCatalog(catalog));
    for (const [i, e] of catalog.entries()) {
      expect([i, Object.keys(e).filter((k) => !["id", "lab", "name", "vision", "pdf", "reasoning", "chat", "contextTokens", "reasoningLevels", ...NEW].includes(k))]).toEqual([i, []]);
      // A new ability is there only as `true`.
      for (const k of NEW) if (k in e) expect([e.id, k, e[k]]).toEqual([e.id, k, true]);
      expect([e.id, e.id === e.id.toLowerCase() && e.id.length > 0, typeof e.name, typeof e.vision, typeof e.pdf, typeof e.reasoning, typeof e.chat]).toEqual([e.id, true, "string", "boolean", "boolean", "boolean", "boolean"]);
      if (e.contextTokens !== undefined) expect([e.id, Number.isInteger(e.contextTokens) && e.contextTokens > 0]).toEqual([e.id, true]);
      if (e.reasoningLevels !== undefined) {
        expect([e.id, e.reasoning, e.reasoningLevels.length > 0, LEVELS.filter((l) => e.reasoningLevels!.includes(l))]).toEqual([e.id, true, true, e.reasoningLevels]);
      }
      if (i > 0) expect([catalog[i - 1]!.id, e.id, catalog[i - 1]!.id <= e.id]).toEqual([catalog[i - 1]!.id, e.id, true]);
    }
  });

  it("has the models the hints are checked against, and its README says how many", () => {
    const ids = new Set(catalog.map((e) => e.id));
    for (const id of ["gpt-6-sol", "claude-sonnet-5-5", "gemini-2.5-pro"]) expect([id, ids.has(id)]).toEqual([id, true]);
    expect(catalog.find((e) => e.id === "gpt-6-sol")).toMatchObject({ lab: "openai", reasoning: true, reasoningLevels: LEVELS });
    // The abilities are kept: most chat models use tools, and some take audio or video or answer with images.
    expect(catalog.find((e) => e.id === "gpt-6-sol")).toMatchObject({ tools: true });
    expect(catalog.filter((e) => e.tools).length).toBeGreaterThan(catalog.length / 3);
    for (const k of NEW) expect([k, catalog.some((e) => e[k] === true)]).toEqual([k, true]);
    const readme = readFileSync(new URL("../src/providers/model-catalog.README.md", import.meta.url), "utf8");
    for (const k of NEW) expect(readme).toContain(`\`${k}\``);
    expect(readme).toContain(`Entries: ${catalog.length}`);
    expect(readme).toContain("Licence: MIT");
  });
});
