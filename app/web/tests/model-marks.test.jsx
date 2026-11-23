// @vitest-environment jsdom
// The marks of a model row (src/ui/ModelMarks.jsx): every ability the product uses (看图, 思考, 工具) in a fixed order,
// money first as text, nothing for what a model lacks; wide rows say the word beside the icon, narrow ones the icon only (the
// list's own width decides: data-marks on the list), every icon keeping its name; a legend only while they are icons.
// No layout runs in jsdom: the width is faked here; the real layout is tested in e2e/modeltags.spec.mjs.
import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ModelSelect, optionLabel } from "../src/pages/ModelSelect.jsx";
import { modelChoices, pickerGroups } from "../src/pages/ModelPicker.jsx";
import { ABILITIES, ModelMarks, abilityMarks, marksModeFor } from "../src/ui/ModelMarks.jsx";
import { parseCss, read, rulesFor } from "./css-rules.js";

let width = 0;
let observers = [];
beforeEach(() => {
  width = 0;
  observers = [];
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => width });
  globalThis.ResizeObserver = class {
    constructor(run) {
      this.run = run;
      observers.push(this);
    }
    observe() {}
    disconnect() {}
  };
});
afterEach(() => {
  cleanup();
  delete HTMLElement.prototype.clientWidth;
  delete globalThis.ResizeObserver;
});
const resize = (to) => {
  width = to;
  act(() => observers.forEach((o) => o.run()));
};

const STATE = {
  siteModels: [
    { id: "all", label: "全能", tier: "paid", vision: true, pdf: true, reasoning: ["low", "high"] },
    { id: "bare", label: "素的", tier: "free", vision: false, pdf: false, reasoning: [], tools: false },
  ],
  providers: {
    p1: {
      id: "p1",
      name: "DerpSeek",
      models: [
        { name: "deepseek-v4-flash-vision-exp", vision: true, pdf: false, reasoning: true, contextTokens: 64000 },
        { name: "deepseek-v4-flash", vision: false, pdf: false, reasoning: false, contextTokens: 64000 },
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
const marks = (el) => [...el.querySelectorAll(".model-mark")];

describe("ModelMarks", () => {
  it("vision + pdf + reasoning + tools: four marks in a fixed order whatever order they come in, after the money", () => {
    const { container } = render(<ModelMarks marks={["tools", "reasoning", "vision", "paid"]} />);
    expect(marks(container).map((m) => m.textContent)).toEqual(["需余额", "看图", "思考", "工具"]);
    expect(within(container).getAllByRole("img").map((m) => m.getAttribute("aria-label"))).toEqual(["看图", "思考", "工具"]);
  });

  it("a model with none shows none (and no placeholder)", () => {
    const { container } = render(<ModelMarks marks={[]} />);
    expect(container.querySelectorAll(".model-mark")).toHaveLength(0);
    expect(container.textContent).toBe("");
  });

  it("each ability has a title that says it in full, and the money stays text", () => {
    const { container } = render(<ModelMarks marks={["free", "vision", "reasoning", "tools"]} mode="icons" />);
    expect(marks(container).map((m) => m.getAttribute("title"))).toEqual([null, "能看图片", "支持思考", "会用工具（查聊天记录、看文件）"]);
    // Every ability mark carries an icon (an svg), the price never does.
    expect(marks(container).map((m) => m.querySelector("svg") !== null)).toEqual([false, true, true, true]);
    expect(marks(container)[0].textContent).toBe("免费");
  });

  it("the mode of a width: text from 520 px, icons under it; no width known (no layout): text", () => {
    expect(marksModeFor(0)).toBe("text");
    expect([300, 519].map(marksModeFor)).toEqual(["icons", "icons"]);
    expect([520, 900].map(marksModeFor)).toEqual(["text", "text"]);
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

  it("a reserved row never renders and is never in the legend, even when the model's data says it is true", () => {
    expect(abilityMarks(ALL_TRUE)).toEqual(["vision", "reasoning", "tools"]);
    const { container } = render(<ModelMarks marks={Object.keys(ALL_TRUE)} />);
    expect(marks(container).map((m) => m.textContent)).toEqual(["看图", "思考", "工具"]);
    expect(container.textContent).not.toMatch(/PDF|语音|视频|画图/);
    width = 340;
    render(<ModelSelect label="模型" lead={[{ key: "a", name: "甲", marks: Object.keys(ALL_TRUE) }]} onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "模型" }));
    expect(document.querySelector(".model-legend").textContent).toBe("看图思考工具");
    expect(screen.getByRole("option", { name: "甲 · 看图 · 思考 · 工具" })).toBeTruthy();
  });

  it("a reserved row is safe when its field is absent", () => {
    for (const a of ABILITIES.filter((r) => !r.shown)) expect(a.from({}), a.kind).toBe(false);
  });

  it("flipping `shown` on one row draws it, in table order, with its accessible name (and puts it in the legend); flipped back, it is gone", () => {
    const row = ABILITIES.find((a) => a.kind === "pdf");
    row.shown = true;
    try {
      const { container } = render(<ModelMarks marks={["tools", "pdf", "vision"]} />);
      expect(marks(container).map((m) => m.textContent)).toEqual(["看图", "工具", "读 PDF"]);
      expect(within(container).getByRole("img", { name: "读 PDF" }).getAttribute("title")).toBe("能直接读 PDF");
      expect(abilityMarks({ pdf: true })).toEqual(["tools", "pdf"]);
    } finally {
      row.shown = false;
    }
    cleanup();
    const { container } = render(<ModelMarks marks={["tools", "pdf", "vision"]} />);
    expect(marks(container).map((m) => m.textContent)).toEqual(["看图", "工具"]);
  });
});

describe("the picker's rows", () => {
  it("a provider model that can see (deepseek-v4-flash-vision-exp) is marked 看图; one that cannot is not", () => {
    openPicker();
    expect(marks(row("deepseek-v4-flash-vision-exp")).map((m) => m.textContent)).toEqual(["看图", "思考", "工具"]);
    expect(marks(row("deepseek-v4-flash")).map((m) => m.textContent)).toEqual(["工具"]);
    expect(row("deepseek-v4-flash-vision-exp").getAttribute("aria-label")).toBe("deepseek-v4-flash-vision-exp · 看图 · 思考 · 工具");
  });

  it("a site model with all four: the row's name reads once, in order: its name, the money, then the abilities", () => {
    openPicker();
    expect(row("全能").getAttribute("aria-label")).toBe("全能 · 需余额 · 看图 · 思考 · 工具");
    expect(marks(row("全能")).map((m) => m.textContent)).toEqual(["需余额", "看图", "思考", "工具"]);
    // The marks are not read again: the whole strip is hidden from the tree (the row's name has them).
    expect(row("全能").querySelector(".model-marks").getAttribute("aria-hidden")).toBe("true");
    expect(optionLabel({ name: "x", marks: ["tools", "vision", "free"] })).toBe("x · 免费 · 看图 · 工具");
  });

  it("a model without abilities keeps only the money (and its columns, empty, so rows line up)", () => {
    openPicker();
    expect(marks(row("素的")).map((m) => m.textContent)).toEqual(["免费"]);
    expect([...row("素的").querySelectorAll("[data-col]")].map((m) => m.dataset.col)).toEqual(["price", "vision", "reasoning", "tools"]);
    expect(row("素的").querySelectorAll('[role="img"]')).toHaveLength(0);
  });

  it("wide list: the words are shown (data-marks=text), no legend; narrow: icons only with their names kept, and the legend; wide again: back", () => {
    width = 600;
    openPicker();
    const list = screen.getByRole("listbox");
    expect(list.dataset.marks).toBe("text");
    expect(document.querySelector(".model-legend")).toBeNull();
    resize(340);
    expect(list.dataset.marks).toBe("icons");
    const strip = row("全能").querySelector(".model-marks");
    expect(strip.dataset.mode).toBe("icons");
    expect([...strip.querySelectorAll('[role="img"]')].map((m) => [m.getAttribute("aria-label"), m.getAttribute("title")])).toEqual([
      ["看图", "能看图片"],
      ["思考", "支持思考"],
      ["工具", "会用工具（查聊天记录、看文件）"],
    ]);
    // The legend says each icon, only the kinds this list has.
    expect(document.querySelector(".model-legend").textContent).toBe("看图思考工具");
    resize(700);
    expect(list.dataset.marks).toBe("text");
    expect(document.querySelector(".model-legend")).toBeNull();
  });

  it("the legend names only the abilities the list has", () => {
    width = 340;
    render(<ModelSelect label="模型" lead={[{ key: "a", name: "甲", marks: ["free", "vision"] }, { key: "b", name: "乙", marks: ["paid"] }]} onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "模型" }));
    expect(document.querySelector(".model-legend").textContent).toBe("看图");
  });

  it("a list without any ability has no legend even when narrow", () => {
    width = 340;
    render(<ModelSelect label="模型" lead={[{ key: "a", name: "甲", marks: ["free"] }]} onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "模型" }));
    expect(document.querySelector(".model-legend")).toBeNull();
  });
});

describe("the stylesheet", () => {
  const rules = parseCss(read("src/styles.css"));
  const decl = (selector, condition = null) => Object.assign({}, ...rulesFor(rules, selector, condition).map((r) => r.decl));

  it("a long name gives way first: it truncates, the marks never shrink or wrap; in icons mode the words are not shown", () => {
    expect(decl(".model-option .model-name")).toMatchObject({ "min-width": "0", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" });
    expect(decl(".model-marks")).toMatchObject({ flex: "none" });
    expect(decl(".model-mark")).toMatchObject({ "white-space": "nowrap" });
    expect(decl('.model-marks[data-mode="icons"] .model-mark-text')).toMatchObject({ display: "none" });
  });
});
