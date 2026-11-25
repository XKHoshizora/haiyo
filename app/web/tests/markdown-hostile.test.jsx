// @vitest-environment jsdom
// Every hostile text the reviews found (rounds 1 to 3) against the round-3 design: the pipeline runs in the Markdown
// worker under a hard deadline, so a text's own work can no longer hold up the page. Each text's outcome class comes
// from the pipeline itself (`renderToTree`, what the worker runs): rendered within the caps, or plain with a reason.
// For the texts that are slow, the main thread's side is what matters: a worker that does not answer in time is ended,
// the text is shown plain with the note and remembered (by digest only), it is never sent again, and the next text
// gets a new worker.
import React from "react";
import katex from "katex";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { AgentText, loadMarkdown } from "../src/ui/AgentText.jsx";
import { DEADLINE_MS } from "../src/ui/markdownClient.js";
import { fitsMarkdown } from "../src/ui/markdownLimits.js";
import { LIMITS, highlighter, renderToTree, treeSize } from "../src/ui/markdownPipeline.js";
import { TREE_DEPTH, TREE_ELEMENTS } from "../src/ui/markdownRules.js";
import { validateTree } from "../src/ui/markdownTree.js";
import { SLOW_TEXTS_KEPT, SLOW_TEXT_NOTE, digestOf, isSlowText, rememberSlowText } from "../src/ui/slowTexts.jsx";
import { CASES } from "./hostile-cases.js";
import { CASES as R3_CASES } from "./hostile-cases-r3.js";
import { SilentWorker, settle, useWorkers } from "./markdown-worker.js";

await loadMarkdown();

const KEY = "agent-family.slow-markdown";
const stored = () => JSON.parse(sessionStorage.getItem(KEY) ?? "[]");
const longestLine = (source) => Math.max(...source.split("\n").map((line) => line.length));
const wrapLines = (body, n) => Array.from({ length: Math.ceil(body.length / n) }, (_, i) => body.slice(i * n, (i + 1) * n)).join("\n");
/** The clock of the pipeline's time budgets, standing still: what a text comes to does not depend on the machine. */
const STILL = { now: () => 0 };

let errors;
beforeEach(() => {
  sessionStorage.clear();
  errors = vi.spyOn(console, "error");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const ALL = { ...CASES, ...Object.fromEntries(Object.entries(R3_CASES).map(([name, make]) => [`rr3_${name}`, make])) };

/**
 * What each case must come to, beyond the bounds every case is held to: refused by the raw-text checks before parsing
 * (`unparsed`), plain after parsing (`plain`), rendered (`rich`), rendered with no formula typeset (`no-maths`) or no
 * grammar run (`no-highlight`). Unlisted cases may be rendered or plain.
 */
const OUTCOME = {
  r1_table_2000x20000: "unparsed",
  c1_2000x20000: "unparsed",
  c1_100x60_piped: "unparsed",
  c1_just_under: "unparsed",
  md_tables_many: "unparsed",
  md_links: "unparsed",
  md_ref_defs: "unparsed",
  md_quotes_list: "unparsed",
  c1_300x2000: "plain",
  md_soft_breaks: "plain",
  md_em: "plain",
  md_footnote_defs: "plain",
  r1_table_5x3: "rich",
  r1_macro400: "no-maths",
  c2_macro100: "no-maths",
  one_sup_nest: "no-maths",
  one_sub_sup_nest: "no-maths",
  one_text_nest: "no-maths",
  one_mathchoice: "no-maths",
  code_js_tpl_2k: "no-highlight",
  code_js_tpl_4k: "no-highlight",
  code_js_tpl_6k: "no-highlight",
  code_js_tpl_9k: "no-highlight",
  code_js_tpl_20k: "no-highlight",
  code_js_tpl_x5_4k: "no-highlight",
  code_rust_cmt_9k: "no-highlight",
  code_bash_9k: "no-highlight",
  code_shell_4: "no-highlight",
  code_shell_dollar: "no-highlight",
  code_mdlink_1: "no-highlight",
  code_mdlink_line5k: "no-highlight",
  code_mdlink_5: "no-highlight",
  code_mdimg_1: "no-highlight",
  code_c_dyn_1: "no-highlight",
  // Round 3: the xml grammar and its aliases are gone (plain code); raw HTML past 2 000 `<` is not parsed; fences in
  // quotes and lists are counted.
  rr3_hl_html_script_160: "no-highlight",
  rr3_hl_xml_script_160: "no-highlight",
  rr3_hl_svg_script_80: "no-highlight",
  rr3_hl_html_script_x4: "unparsed",
  rr3_md_html_comment: "unparsed",
  rr3_md_html_pi: "unparsed",
  rr3_md_html_decl: "unparsed",
  rr3_md_html_attr_dq: "unparsed",
  rr3_md_html_attr_sq: "unparsed",
  rr3_md_html_open: "unparsed",
  rr3_md_lt_autolink: "unparsed",
  rr3_md_fence_in_list: "unparsed",
  rr3_md_fence_in_quote: "unparsed",
  rr3_md_lists_flat: "plain",
  rr3_md_table_pipeless: "plain",
  rr3_md_footnote_defs_400: "plain",
  rr3_md_em_under: "plain",
};

/**
 * The cases slow enough (measured: over the deadline in Node or in Chrome, in round 2's renderer or in this pipeline)
 * that the worker's deadline is what bounds them: the main thread must give up on them.
 */
const SLOW = [
  "rr3_md_html_pi", "rr3_md_html_decl", "rr3_md_html_comment", "rr3_hl_html_script_160", "rr3_hl_c_case_80", "rr3_hl_cpp_def_80",
  "rr3_md_setext", "rr3_md_lists_flat", "rr3_md_quote_lazy", "rr3_md_table_pipeless", "rr3_md_footnote_defs_400", "rr3_md_em_under",
  "md_soft_breaks", "md_em", "md_footnote_defs", "agg_sup50", "agg_sup_cap48", "agg_sup_p500", "agg_frac_p500", "agg_mix_p300",
];

describe("the reviews' hostile texts: what the worker's pipeline makes of each", () => {
  it.each(Object.keys(ALL))("%s", (name) => {
    const text = ALL[name]();
    const typesets = vi.spyOn(katex, "renderToString");
    const highlights = vi.spyOn(highlighter, "highlight");
    const result = renderToTree(text, STILL);
    // Its outcome class: a tree within the caps, which the main thread's check accepts; or plain, with its reason.
    if (result.plain) {
      expect(result.reason).toBe("complex");
    } else {
      const { elements, depth } = treeSize(result.tree);
      expect(elements).toBe(result.elements);
      expect(elements).toBeLessThanOrEqual(TREE_ELEMENTS);
      expect(depth).toBeLessThanOrEqual(TREE_DEPTH);
      expect(validateTree(structuredClone(result.tree)).ok).toBe(true);
    }
    // No more formulas typeset than the cap; no block given to a grammar that the cost gate refuses.
    expect(typesets.mock.calls.length).toBeLessThanOrEqual(LIMITS.mathCount);
    for (const [, source] of highlights.mock.calls) {
      expect(source.length).toBeLessThanOrEqual(LIMITS.highlightCode);
      expect(longestLine(source)).toBeLessThanOrEqual(LIMITS.highlightLine);
    }
    const outcome = OUTCOME[name];
    if (outcome === "unparsed") {
      expect(fitsMarkdown(text)).toBe(false);
      expect(result).toEqual({ plain: true, reason: "complex" });
    }
    if (outcome === "plain") expect(result).toEqual({ plain: true, reason: "complex" });
    if (outcome === "rich" || outcome === "no-maths" || outcome === "no-highlight") expect(result.tree).toBeDefined();
    if (outcome === "no-maths") expect(typesets).not.toHaveBeenCalled();
    if (outcome === "no-highlight") expect(highlights).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
    // (Its own limit: the longest of these, `rr3_md_lists_flat`, takes about 5 s when the whole suite runs in parallel.)
  }, 30_000);
});

describe("a slow text: the main thread gives up on it", () => {
  /** A text shown, its worker never answering; the deadline passed. */
  async function showLate(text) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { client, workers } = useWorkers(() => new SilentWorker());
    const { container } = render(
      <div className="bubble">
        <AgentText text={text} />
      </div>,
    );
    await settle();
    expect(workers).toHaveLength(1);
    expect(workers[0].sent.map((m) => m.text)).toEqual([text]);
    expect(container.querySelector(".md-note")).toBeNull(); // plain, waiting
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1);
    });
    expect(workers[0].terminated).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await settle();
    return { client, workers, container };
  }

  it.each(SLOW)("%s: after the deadline the worker is ended, the text plain with the note and remembered", async (name) => {
    const text = ALL[name]();
    const { client, workers, container } = await showLate(text);
    expect(workers[0].terminated).toBe(true);
    expect(container.querySelector(".md")).toBeNull();
    expect(container.textContent).toBe(`${text}${SLOW_TEXT_NOTE}`);
    expect(isSlowText(text)).toBe(true);
    expect(stored()).toEqual([digestOf(text)]);
    // Never sent again; the next text has a worker of its own.
    expect(await client.request(text)).toEqual({ plain: true, reason: "slow" });
    client.request("下一条 **回复**");
    await settle();
    expect(workers).toHaveLength(2);
    expect(workers[1].sent.map((m) => m.text)).toEqual(["下一条 **回复**"]);
    expect(workers.flatMap((w) => w.sent).filter((m) => m.text === text)).toHaveLength(1);
  });

  it("a remembered text is shown plain with the note at once, without a worker (also after a reload)", async () => {
    const text = "很慢的回复 $$x^{slow1}$$";
    rememberSlowText(text);
    const { workers } = useWorkers();
    const { container } = render(<AgentText text={text} />);
    expect(container.textContent).toBe(`${text}${SLOW_TEXT_NOTE}`);
    await settle();
    expect(workers).toHaveLength(0);
    expect(sessionStorage.getItem(KEY)).not.toContain("慢");
    // A reload: the module's memory starts empty, the tab's storage still has the digest.
    vi.resetModules();
    const reloaded = await import("../src/ui/slowTexts.jsx");
    expect(reloaded.isSlowText(text)).toBe(true);
    expect(reloaded.isSlowText(`${text}。`)).toBe(false);
  });

  it("storage that fails never breaks rendering; the text is still remembered in the page", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const text = "很慢的回复 $$x^{slow2}$$";
    const { container } = await showLate(text);
    expect(container.querySelector(".md-note")).not.toBeNull();
    cleanup();
    const again = render(<AgentText text={text} />);
    expect(again.container.querySelector(".md-note")).not.toBeNull();
    expect(errors).not.toHaveBeenCalled();
  });

  it(`keeps at most ${SLOW_TEXTS_KEPT} digests, the oldest dropped`, () => {
    for (let i = 0; i < SLOW_TEXTS_KEPT + 5; i += 1) rememberSlowText(`第${i}条`);
    const list = stored();
    expect(list).toHaveLength(SLOW_TEXTS_KEPT);
    expect(list[0]).toBe(digestOf("第5条"));
    expect(list.at(-1)).toBe(digestOf(`第${SLOW_TEXTS_KEPT + 4}条`));
  });
});

describe("highlighting, refused by cost before any grammar runs", () => {
  const OPENERS = ["[a](", "${", "/*", '"', "'", "`", "<", "{", "(", "`${"];
  it.each(highlighter.listLanguages())("%s: lines of 5 000 characters of openers", (language) => {
    const highlights = vi.spyOn(highlighter, "highlight");
    for (const opener of OPENERS) {
      // (After an `x`, so that a line of backticks is code, not the fence's end.)
      const line = `x${opener.repeat(Math.ceil(5000 / opener.length))}`.slice(0, 5000);
      const result = renderToTree(`\`\`\`${language}\n${line}\n\`\`\``, STILL);
      expect(JSON.stringify(result.tree ?? [])).not.toContain("hljs-");
    }
    expect(highlights).not.toHaveBeenCalled();
  });

  it("Markdown and XML (HTML, SVG, XHTML…) fences are not highlighted at all: their grammars are not registered", () => {
    for (const name of ["markdown", "md", "xml", "html", "svg", "xhtml", "rss", "atom", "xsl", "plist"]) expect(highlighter.registered(name), name).toBe(false);
  });

  it("a block over 10 000 characters, or with a line over 500, is not highlighted; within both it is", () => {
    const highlights = vi.spyOn(highlighter, "highlight");
    renderToTree(`\`\`\`js\n${"let a = 1;\n".repeat(1000)}\`\`\``, STILL); // 11 000 characters
    renderToTree(`\`\`\`js\nlet a = "${"x".repeat(500)}";\n\`\`\``, STILL); // one line of 511
    expect(highlights).not.toHaveBeenCalled();
    const result = renderToTree(`\`\`\`js\n${"let a = 1;\n".repeat(90)}\`\`\``, STILL);
    expect(highlights).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result.tree)).toContain("hljs-keyword");
  });

  it("never a fence still open at the end of the text (a reply being written): only once it closes", () => {
    const highlights = vi.spyOn(highlighter, "highlight");
    renderToTree("```js\nconst open = 1;", STILL);
    const open = renderToTree("```js\nconst open = 1;\nconst more = 2;", STILL);
    expect(highlights).not.toHaveBeenCalled();
    expect(JSON.stringify(open.tree)).toContain("const open = 1;\\nconst more = 2;\\n");
    const closed = renderToTree("```js\nconst open = 1;\nconst more = 2;\n```", STILL);
    expect(highlights).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(closed.tree)).toContain("hljs-keyword");
  });

  it("a result with too many elements or nesting too deep is discarded (plain code), and not highlighted again", () => {
    const highlights = vi.spyOn(highlighter, "highlight");
    const deep = `\`\`\`shell\n${wrapLines("`${".repeat(300), 80)}\n\`\`\``; // nests ~300 deep
    const wide = `\`\`\`json\n${wrapLines("[[".repeat(1000), 80)}\n\`\`\``; // ~2 000 elements
    const result = renderToTree(`${deep}\n\n${wide}`, STILL);
    expect(highlights).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result.tree)).not.toContain("hljs-");
    renderToTree(`${deep}\n\n${wide}\n\n。`, STILL);
    expect(highlights).toHaveBeenCalledTimes(2);
  });

  it("past 50 ms of highlighting in one text the remaining blocks are plain; the next pieces highlight them", () => {
    let clock = 1000;
    const real = highlighter.highlight;
    const highlights = vi.spyOn(highlighter, "highlight").mockImplementation((...args) => {
      clock += 30;
      return real(...args);
    });
    const now = () => clock;
    const blocks = [1, 2, 3].map((i) => `\`\`\`js\nconst budget${i} = ${i};\n\`\`\``).join("\n\n");
    // 30, then 60 ms: the third block waits.
    const first = renderToTree(blocks, { now });
    expect(highlights).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(first.tree).match(/"hljs","language-js"/g)).toHaveLength(2);
    const second = renderToTree(`${blocks}\n\n。`, { now });
    expect(highlights).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(second.tree).match(/"hljs","language-js"/g)).toHaveLength(3);
  });
});

describe("the final count holds on its own", () => {
  // Every earlier limit lifted, the raw-text checks skipped, the clock standing still: what remains is the count of
  // the whole tree (3 000 elements, depth 60).
  const EARLIER = ["cells", "mathCount", "katexOutput", "katexTextOutput", "highlightLine", "highlightCode", "highlightElements", "highlightDepth"];
  const lifted = { ...STILL, skipChecks: true, limits: Object.fromEntries(EARLIER.map((key) => [key, Infinity])) };
  const table = (cols, rows) => `${"|a".repeat(cols)}|\n${"|-".repeat(cols)}|\n${"x\n".repeat(rows)}`;
  it.each([
    ["a table padded to 3 100 cells", table(31, 99), "cells"],
    ["highlighted code nesting ~666 deep", CASES.code_js_tpl_2k(), "highlight"],
    ["30 large formulas", Array.from({ length: 30 }, (_, i) => `$$\nfinal${i}+${"x^{1}".repeat(198)}\n$$`).join("\n\n"), "maths"],
    ["3 100 line breaks", "a\n".repeat(3100), "breaks"],
  ])("%s", (_, text, earlier) => {
    const typesets = vi.spyOn(katex, "renderToString");
    const highlights = vi.spyOn(highlighter, "highlight");
    const result = renderToTree(text, lifted);
    // The earlier guard really was out of the way: its work was done…
    if (earlier === "highlight") expect(highlights).toHaveBeenCalledTimes(1);
    if (earlier === "maths") expect(typesets).toHaveBeenCalledTimes(30);
    // …and the final count made the text plain.
    expect(result).toEqual({ plain: true, reason: "complex" });
  });

  it("3 000 elements are shown; one more is not", () => {
    const at = (n) => renderToTree(`- a\n`.repeat(n - 1), STILL);
    expect(at(3000).elements).toBe(3000); // one ul and 2 999 li
    expect(at(3001)).toEqual({ plain: true, reason: "complex" });
  });
});
