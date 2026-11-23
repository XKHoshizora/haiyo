// @vitest-environment jsdom
// The marks of a model row (src/ui/ModelMarks.jsx): the abilities the product uses (看图, 思考, 工具) in a fixed order, money
// first as text, nothing for what a model lacks, and a mark states only a known fact. Each ability mark holds its word AND
// its icon; the stylesheet shows ONE of them by the width of the picker's box (a container query: wide = the word, narrow = the
// icon), and the legend (icon + word, the key) only in the narrow form. No layout runs in jsdom: the DOM and the rules are
// pinned here, the real layout is tested in e2e/modeltags.spec.mjs.
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ModelSelect, optionLabel } from "../src/pages/ModelSelect.jsx";
import { modelChoices, pickerGroups } from "../src/pages/ModelPicker.jsx";
import { ABILITIES, ModelMarks, abilityMarks } from "../src/ui/ModelMarks.jsx";
import { parseCss, read, rulesFor } from "./css-rules.js";

afterEach(cleanup);

const STATE = {
  siteModels: [
    { id: "all", label: "全能", tier: "paid", vision: true, pdf: true, reasoning: ["low", "high"], tools: true },
    { id: "bare", label: "素的", tier: "free", vision: false, pdf: false, reasoning: [], tools: false },
    { id: "silent", label: "没说的", tier: "free", vision: false, pdf: false, reasoning: [] },
  ],
  providers: {
    p1: {
      id: "p1",
      name: "DerpSeek",
      models: [
        { name: "deepseek-v4-flash-vision-exp", vision: true, pdf: false, reasoning: true, contextTokens: 64000, tools: true },
        { name: "deepseek-v4-flash", vision: false, pdf: false, reasoning: false, contextTokens: 64000 },
        // What the catalogue reports beside what is stored (the service's `reportedTools`, and what the model takes and answers with).
        { name: "deepseek-chat", vision: false, pdf: false, reasoning: false, contextTokens: 64000, reportedTools: true },
        { name: "qwen-plus", vision: false, pdf: false, reasoning: true, contextTokens: 64000, tools: false, reportedTools: true },
        { name: "qwen-omni-turbo", vision: true, pdf: false, reasoning: false, contextTokens: 64000, tools: true, reportedTools: true, audioIn: true, videoIn: true, audioOut: true },
      ],
    },
  },
  providerDefaults: { contextTokens: 16000, maxOutputTokens: 2048 },
};
const groupsOf = () => pickerGroups({ choices: modelChoices(STATE), modelsKnown: true, providersKnown: true });
const openPicker = () => {
  render(<ModelSelect label="模型" groups={groupsOf()} onChange={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "模型" }));
};
const row = (name) => [...screen.getByRole("listbox").querySelectorAll('[role="option"]')].find((o) => o.querySelector(".model-name")?.textContent === name);
/** The real marks of an element (a gap that only keeps a column's room is not one). */
const marks = (el) => [...el.querySelectorAll(".model-mark:not(.model-gap)")];
const wordsOf = (el) => marks(el).map((m) => m.querySelector(".model-mark-text")?.textContent ?? m.textContent);

describe("ModelMarks", () => {
  it("看图 + 思考 + 工具: three marks in a fixed order whatever order they come in, after the money", () => {
    const { container } = render(<ModelMarks marks={["tools", "reasoning", "vision", "paid"]} />);
    expect(wordsOf(container)).toEqual(["需余额", "看图", "思考", "工具"]);
    expect(within(container).getAllByRole("img").map((m) => m.getAttribute("aria-label"))).toEqual(["看图", "思考", "工具"]);
  });

  it("a model with none shows none (and no placeholder)", () => {
    const { container } = render(<ModelMarks marks={[]} />);
    expect(container.querySelectorAll(".model-mark, .model-gap")).toHaveLength(0);
    expect(container.textContent).toBe("");
  });

  it("each ability mark holds its word and its icon (the stylesheet shows one of them), and a title that says it in full; the money is text only", () => {
    const { container } = render(<ModelMarks marks={["free", "vision", "reasoning", "tools"]} />);
    const all = marks(container);
    expect(all.map((m) => m.getAttribute("title"))).toEqual([null, "能看图片", "支持思考", "会用工具（查聊天记录、看文件）"]);
    expect(all.map((m) => m.querySelector("svg") !== null)).toEqual([false, true, true, true]);
    expect(all.map((m) => m.querySelector(".model-mark-text")?.textContent ?? null)).toEqual([null, "看图", "思考", "工具"]);
    expect(all[0].textContent).toBe("免费");
    // The icon is decoration (the mark has its name), the word is not read twice.
    expect(all[1].querySelector("svg").getAttribute("aria-hidden")).toBe("true");
    expect(all[1].querySelector(".model-mark-text").getAttribute("aria-hidden")).toBe("true");
  });

  it("a column a model has no mark in keeps its room with a hidden copy of the column's own mark, so every column is as wide as its word and rows line up", () => {
    const { container } = render(<ModelMarks marks={["free", "tools"]} columns={["price", "vision", "reasoning", "tools"]} decorative />);
    const cells = [...container.querySelectorAll("[data-col]")];
    expect(cells.map((c) => c.dataset.col)).toEqual(["price", "vision", "reasoning", "tools"]);
    const gap = cells[1];
    expect(gap.classList.contains("model-gap")).toBe(true);
    expect(gap.getAttribute("aria-hidden")).toBe("true");
    expect(gap.getAttribute("role")).toBeNull();
    expect(gap.querySelector(".model-mark-text").textContent).toBe("看图");
    expect(gap.querySelector("svg")).not.toBeNull();
  });
});

describe("the price column", () => {
  it("every price chip, and the hidden copy that keeps the column, carries the longest price word as its sizer, so the column is one width whichever word a row has", () => {
    const { container } = render(
      <>
        <ModelMarks marks={["free"]} columns={["price"]} />
        <ModelMarks marks={["paid"]} columns={["price"]} />
        <ModelMarks marks={[]} columns={["price"]} />
      </>,
    );
    expect([...container.querySelectorAll('[data-col="price"]')].map((c) => c.dataset.sizer)).toEqual(["需余额", "需余额", "需余额"]);
    const rules = parseCss(read("src/styles.css"));
    const decl = Object.assign({}, ...rulesFor(rules, '.model-mark[data-col="price"]::after', null).map((r) => r.decl));
    expect(decl).toMatchObject({ content: "attr(data-sizer)", visibility: "hidden" });
    // (And no minimum width of its own to stand in for it.)
    expect(read("src/styles.css")).not.toMatch(/data-col="price"\][^{]*\{[^}]*min-width/);
  });
});

describe("the table of marks", () => {
  const ALL_TRUE = { vision: true, reasoning: true, tools: true, pdf: true, audioIn: true, videoIn: true, imageOut: true, videoOut: true, audioOut: true };

  it("holds the whole vocabulary, each with its word, name and icon; only 看图, 思考, 工具 are shown now", () => {
    expect(ABILITIES.map((a) => [a.kind, a.text, a.shown])).toEqual([
      ["vision", "看图", true],
      ["reasoning", "思考", true],
      ["tools", "工具", true],
      ["audioIn", "听语音", false],
      ["videoIn", "看视频", false],
      ["pdf", "读 PDF", false],
      ["imageOut", "画图", false],
      ["videoOut", "生成视频", false],
      ["audioOut", "生成语音", false],
    ]);
    for (const a of ABILITIES) expect([typeof a.title, typeof a.Icon, typeof a.from], a.kind).toEqual(["string", "object", "function"]);
  });

  it("a mark states only a known fact: every row reads true only from its own field being exactly true (absent, null, 'true', 1 are no)", () => {
    expect(abilityMarks({})).toEqual([]);
    for (const a of ABILITIES) {
      expect(a.from({}), `${a.kind} absent`).toBe(false);
      expect(a.from({ [a.kind]: null }), `${a.kind} null`).toBe(false);
      expect(a.from({ [a.kind]: "true" }), `${a.kind} text`).toBe(false);
      expect(a.from({ [a.kind]: 1 }), `${a.kind} number`).toBe(false);
      expect(a.from({ [a.kind]: false }), `${a.kind} false`).toBe(false);
      expect(a.from({ [a.kind]: true }), `${a.kind} true`).toBe(true);
    }
    expect(abilityMarks({ tools: true })).toEqual(["tools"]);
  });

  it("工具, the one rule, here and nowhere else: stored true, yes; stored false, never; nothing stored, what the catalogue reports", () => {
    const tools = ABILITIES.find((a) => a.kind === "tools").from;
    const cases = [
      [{ tools: true }, true],
      [{ tools: true, reportedTools: true }, true],
      [{ tools: false }, false],
      // A failure found, or its owner's word, wins over the catalogue.
      [{ tools: false, reportedTools: true }, false],
      [{ reportedTools: true }, true],
      [{}, false],
      // Only exactly true reports: the service sends `reportedTools` as true or not at all.
      [{ reportedTools: false }, false],
      [{ reportedTools: "true" }, false],
      [{ reportedTools: 1 }, false],
      [{ reportedTools: null }, false],
    ];
    for (const [model, shown] of cases) expect([JSON.stringify(model), tools(model)]).toEqual([JSON.stringify(model), shown]);
    expect(abilityMarks({ reportedTools: true })).toEqual(["tools"]);
    expect(abilityMarks({ tools: false, reportedTools: true, vision: true })).toEqual(["vision"]);
  });

  it("the reserved rows read the fields the service now carries (audioIn, videoIn, pdf, imageOut, videoOut, audioOut) and are still not drawn", () => {
    const MEDIA = { audioIn: "audioIn", videoIn: "videoIn", pdf: "pdf", imageOut: "imageOut", videoOut: "videoOut", audioOut: "audioOut" };
    for (const [kind, field] of Object.entries(MEDIA)) {
      const row = ABILITIES.find((a) => a.kind === kind);
      expect([kind, row.shown, row.from({ [field]: true }), row.from({})]).toEqual([kind, false, true, false]);
    }
    const everything = { audioIn: true, videoIn: true, pdf: true, imageOut: true, videoOut: true, audioOut: true, reportedTools: true };
    expect(abilityMarks(everything)).toEqual(["tools"]);
    const { container } = render(<ModelMarks marks={abilityMarks(everything)} />);
    expect(wordsOf(container)).toEqual(["工具"]);
  });

  it("a reserved row never renders and is never in the legend, even when the model's data says it is true", () => {
    expect(abilityMarks(ALL_TRUE)).toEqual(["vision", "reasoning", "tools"]);
    const { container } = render(<ModelMarks marks={Object.keys(ALL_TRUE)} />);
    expect(wordsOf(container)).toEqual(["看图", "思考", "工具"]);
    expect(container.textContent).not.toMatch(/PDF|语音|视频|画图/);
    render(<ModelSelect label="模型" lead={[{ key: "a", name: "甲", marks: Object.keys(ALL_TRUE) }]} onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "模型" }));
    expect(document.querySelector(".model-legend").textContent).toBe("看图思考工具");
    expect(screen.getByRole("option", { name: "甲 · 看图 · 思考 · 工具" })).toBeTruthy();
  });

  it("flipping `shown` on one row draws it, in table order, with its accessible name (and puts it in the legend); flipped back, it is gone", () => {
    const row2 = ABILITIES.find((a) => a.kind === "pdf");
    row2.shown = true;
    try {
      const { container } = render(<ModelMarks marks={["tools", "pdf", "vision"]} />);
      expect(wordsOf(container)).toEqual(["看图", "工具", "读 PDF"]);
      expect(within(container).getByRole("img", { name: "读 PDF" }).getAttribute("title")).toBe("能直接读 PDF");
      expect(abilityMarks({ pdf: true })).toEqual(["pdf"]);
    } finally {
      row2.shown = false;
    }
    cleanup();
    const { container } = render(<ModelMarks marks={["tools", "pdf", "vision"]} />);
    expect(wordsOf(container)).toEqual(["看图", "工具"]);
  });
});

describe("the picker's rows", () => {
  it("a provider model that can see (deepseek-v4-flash-vision-exp) is marked 看图; one that says nothing has no mark", () => {
    openPicker();
    expect(wordsOf(row("deepseek-v4-flash-vision-exp"))).toEqual(["看图", "思考", "工具"]);
    expect(wordsOf(row("deepseek-v4-flash"))).toEqual([]);
    expect(row("deepseek-v4-flash-vision-exp").getAttribute("aria-label")).toBe("deepseek-v4-flash-vision-exp · 看图 · 思考 · 工具");
    expect(row("deepseek-v4-flash").getAttribute("aria-label")).toBe("deepseek-v4-flash");
  });

  it("a provider model with nothing stored that the catalogue reports is marked 工具; one stored false is not, whatever is reported; what it takes and answers with reaches the row and draws nothing yet", () => {
    openPicker();
    expect(wordsOf(row("deepseek-chat"))).toEqual(["工具"]);
    expect(row("deepseek-chat").getAttribute("aria-label")).toBe("deepseek-chat · 工具");
    expect(wordsOf(row("qwen-plus"))).toEqual(["思考"]);
    expect(wordsOf(row("qwen-omni-turbo"))).toEqual(["看图", "工具"]);
    // The fields are carried to the marks' table (a reserved row turned on would draw them): flip one and it is there.
    const audio = ABILITIES.find((a) => a.kind === "audioIn");
    audio.shown = true;
    try {
      const omni = modelChoices(STATE).providers[0].models.find((c) => c.name === "qwen-omni-turbo");
      expect(omni.marks).toEqual(["vision", "tools", "audioIn"]);
    } finally {
      audio.shown = false;
    }
  });

  it("a site model keeps its own boolean tools (the operator's word); what the catalogue knows it to take reaches its row too, undrawn", () => {
    const state = { ...STATE, siteModels: [{ id: "omni", label: "Omni", tier: "free", vision: true, pdf: false, reasoning: [], tools: false, audioIn: true, videoOut: true }], providers: {} };
    expect(modelChoices(state).site[0].marks).toEqual(["free", "vision"]);
    const video = ABILITIES.find((a) => a.kind === "videoOut");
    video.shown = true;
    try {
      expect(modelChoices(state).site[0].marks).toEqual(["free", "vision", "videoOut"]);
    } finally {
      video.shown = false;
    }
  });

  it("工具 only where the model's own field says true: a site model the operator says can, yes; one saying false or nothing, no", () => {
    openPicker();
    expect(wordsOf(row("全能"))).toEqual(["需余额", "看图", "思考", "工具"]);
    expect(wordsOf(row("素的"))).toEqual(["免费"]);
    expect(wordsOf(row("没说的"))).toEqual(["免费"]);
  });

  it("a site model with all of them: the row's name reads once, in order: its name, the money, then the abilities", () => {
    openPicker();
    expect(row("全能").getAttribute("aria-label")).toBe("全能 · 需余额 · 看图 · 思考 · 工具");
    // The marks are not read again: the whole strip is hidden from the tree (the row's name has them).
    expect(row("全能").querySelector(".model-marks").getAttribute("aria-hidden")).toBe("true");
    expect(optionLabel({ name: "x", marks: ["tools", "vision", "free"] })).toBe("x · 免费 · 看图 · 工具");
  });

  it("columns are shared down the list for the abilities, and the money's only where a group has a price: a provider's rows give no room to it", () => {
    openPicker();
    const cols = (name) => [...row(name).querySelectorAll("[data-col]")].map((m) => m.dataset.col);
    expect(cols("素的")).toEqual(["price", "vision", "reasoning", "tools"]);
    expect(cols("deepseek-v4-flash")).toEqual(["vision", "reasoning", "tools"]);
    expect(row("素的").querySelectorAll('[role="img"]')).toHaveLength(0);
  });

  it("the legend is in the DOM (the stylesheet shows it only while the marks are icons), says only the abilities of the rows shown, and goes with them", () => {
    openPicker();
    const legend = () => document.querySelector(".model-legend");
    expect(legend().textContent).toBe("看图思考工具");
    expect(legend().getAttribute("aria-hidden")).toBe("true");
    expect(legend().querySelectorAll("svg")).toHaveLength(3);
    // Search narrows the rows: the legend follows them, and with no row left there is none.
    fireEvent.change(screen.getByRole("combobox", { name: "搜索模型" }), { target: { value: "素的" } });
    expect(legend()).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "搜索模型" }), { target: { value: "vision-exp" } });
    expect(legend().textContent).toBe("看图思考工具");
    fireEvent.change(screen.getByRole("combobox", { name: "搜索模型" }), { target: { value: "zzz" } });
    expect(legend()).toBeNull();
  });

  it("the legend names only the abilities the rows have", () => {
    render(<ModelSelect label="模型" lead={[{ key: "a", name: "甲", marks: ["free", "vision"] }, { key: "b", name: "乙", marks: ["paid"] }]} onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "模型" }));
    expect(document.querySelector(".model-legend").textContent).toBe("看图");
  });

  it("a list without any ability has no legend", () => {
    render(<ModelSelect label="模型" lead={[{ key: "a", name: "甲", marks: ["free"] }]} onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "模型" }));
    expect(document.querySelector(".model-legend")).toBeNull();
  });
});

describe("the stylesheet", () => {
  const rules = parseCss(read("src/styles.css"));
  const decl = (selector, condition = null) => Object.assign({}, ...rulesFor(rules, selector, condition).map((r) => r.decl));
  const NARROW = "modelpop (max-width: 519px)";

  it("the picker's box is the container: its own width decides, not the screen's", () => {
    expect(decl(".model-pop")).toMatchObject({ container: "modelpop / inline-size" });
  });

  it("wide (and on a page): the word and not the icon; the legend is hidden", () => {
    expect(decl(".model-mark-icon")).toMatchObject({ display: "none" });
    expect(decl(".model-legend")).toMatchObject({ display: "none" });
  });

  it("narrow: the icon and not the word, and the legend", () => {
    expect(decl(".model-mark-ability .model-mark-icon", NARROW)).toMatchObject({ display: "block" });
    expect(decl(".model-mark-ability .model-mark-text", NARROW)).toMatchObject({ display: "none" });
    expect(decl(".model-legend", NARROW)).toMatchObject({ display: "flex" });
  });

  it("a long name gives way first: it truncates, the marks never shrink or wrap; no mark has a fixed width", () => {
    expect(decl(".model-option .model-name")).toMatchObject({ "min-width": "0", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" });
    expect(decl(".model-marks")).toMatchObject({ flex: "none" });
    expect(decl(".model-mark")).toMatchObject({ "white-space": "nowrap" });
    const css = read("src/styles.css").replace(/\/\*[\s\S]*?\*\//g, "");
    const block = css.slice(css.indexOf(".model-marks {"), css.indexOf(".model-empty {"));
    expect(block).not.toMatch(/(^|[^-])width:\s*\d+px/);
  });
});
