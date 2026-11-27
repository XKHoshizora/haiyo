// @vitest-environment jsdom
// The model picker of the Agent form: site models (免费 / 需余额) and my providers' models in a searchable list with
// brand marks and capability marks, what it says when there is nothing to choose, the privacy notice beside it, how it
// loads, and how it is used with the keyboard.
import React from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { AG1, MODELS, P1, PRINCIPALS, SITE_MODELS, agentConv, agentOf, agentPrincipal, apiError, deferred, providerOf, syncOf, usageOf } from "./fixtures.js";
import { modelLab } from "../src/pages/ModelPicker.jsx";
import { click, flush, inMain, installBrowser, mainText, openApp } from "./harness.jsx";

beforeEach(installBrowser);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const rail = (name) => within(screen.getByRole("navigation", { name: "主导航" })).getByRole("button", { name });
const inList = () => within(document.querySelector(".list-col"));
const NO_SITE = { siteModels: [], providerDefaults: MODELS.providerDefaults };

/** The create form, with what `GET /api/models`, `GET /api/providers` and `GET /api/usage` answer. */
async function openForm({ models = MODELS, providers = [providerOf()], usage = usageOf(), agents = [], api = {}, edit = false } = {}) {
  const calls = {
    getModels: vi.fn(async () => models),
    listProviders: vi.fn(async () => ({ providers })),
    getUsage: vi.fn(async () => usage),
    listAgents: vi.fn(() => new Promise(() => {})),
    ...api,
  };
  const principals = [...PRINCIPALS, ...agents.map((a) => agentPrincipal(a.id, a.handle, a.name))];
  const app = await openApp({
    sync: () => syncOf(agents.map((a) => agentConv(a.conversationId, a.id)), [], principals),
    api: calls,
    handlers: { agents: () => ({ agents }), models: () => models },
  });
  fireEvent.click(rail(/^Agent/));
  await flush();
  if (edit) {
    await click(inList().getByText(agents[0].name, { selector: ".row-name" }));
    await click(inMain().getByRole("button", { name: /编辑/ }));
  } else {
    await click(inList().getByRole("button", { name: "创建 Agent" }));
  }
  return { ...app, api: calls };
}

/** The picker's button (labelled 模型 by the field's label). */
const modelBox = () => inMain().getByLabelText("模型");
const listbox = () => screen.queryByRole("listbox");
const search = () => screen.getByRole("combobox", { name: "搜索模型" });
const openPicker = async () => {
  if (!listbox()) await click(modelBox());
};
/** A row's visible name. */
const nameOf = (row) => row.querySelector(".model-name").textContent;
/** The groups as [label, [row name, (a row that cannot be chosen)]]. */
const groups = () =>
  [...listbox().querySelectorAll('[role="group"]')].map((g) => [
    g.getAttribute("aria-label"),
    [...g.querySelectorAll('[role="option"]')].map((o) => (o.getAttribute("aria-disabled") === "true" ? `(${o.querySelector(".model-name")?.textContent ?? o.textContent})` : nameOf(o))),
  ]);
const rowOf = (name) => [...listbox().querySelectorAll('[role="option"]')].find((o) => o.querySelector(".model-name")?.textContent === name);
/** The marks at a row's right, in order. */
const marksOf = (name) => [...rowOf(name).querySelectorAll(".model-mark:not(.model-gap)")].map((m) => m.textContent).filter(Boolean);
const chooseModel = async (name) => {
  await openPicker();
  await click(rowOf(name));
};
const typeSearch = async (text) => {
  fireEvent.change(search(), { target: { value: text } });
  await flush();
};
const key = async (target, k) => {
  fireEvent.keyDown(target, { key: k });
  await flush();
};
const activeRow = () => document.getElementById(search().getAttribute("aria-activedescendant"));
const createButton = () => inMain().getByRole("button", { name: /^创建 Agent$|^创建中…$/ });
const reasonText = () => document.querySelector(".main-col .form-actions .reason")?.textContent ?? null;
const PRIVACY = "你和这个 Agent 的对话内容，包括发给 Agent 的图片和文件，会发送给所选模型的服务商。";

describe("the model picker", () => {
  it("lists 站点提供 (each 免费 or 需余额) and 我的供应商 (provider → its models); a model too small to use cannot be chosen", async () => {
    await openForm();
    expect(modelBox().textContent).toBe("请选择模型");
    await openPicker();
    expect(groups()).toEqual([
      ["站点提供", ["小模型", "大模型"]],
      ["我的供应商 · 我的 OpenAI", ["gpt-x", "plain", "(tiny)"]],
    ]);
    expect(rowOf("小模型").getAttribute("aria-label")).toBe("小模型 · 免费 · 工具");
    expect(rowOf("大模型").getAttribute("aria-label")).toBe("大模型 · 需余额 · 看图 · 思考 · 工具");
    expect(rowOf("tiny").getAttribute("aria-label")).toBe("tiny（上下文太小）");
  });

  it("re-reads the models, my providers and my usage when the form opens", async () => {
    const { api } = await openForm();
    expect(api.getModels).toHaveBeenCalledTimes(1);
    expect(api.listProviders).toHaveBeenCalledTimes(1);
    expect(api.getUsage).toHaveBeenCalledTimes(1);
  });

  it("a paid model can be chosen with no balance, and says that it needs balance", async () => {
    await openForm({ usage: usageOf({ balance: "0" }) });
    await chooseModel("大模型");
    expect(modelBox().textContent).toBe("大模型");
    expect(listbox()).toBeNull();
    expect(mainText()).toContain("需要余额：这个模型按用量从余额扣点，你现在的余额是 0 点，余额用完后不会再回复；最后一次回复可能把余额扣成负数。");
    fireEvent.change(inMain().getByLabelText("名称"), { target: { value: "MyBot" } });
    expect(createButton().disabled).toBe(false);
  });

  it("with a balance, a paid model says what it is charged from; a free model says nothing of it", async () => {
    await openForm({ usage: usageOf({ balance: "1234.500" }) });
    await chooseModel("大模型");
    expect(mainText()).toContain("这个模型按用量从余额扣点，你现在的余额是 1,234.5 点。");
    expect(mainText()).not.toContain("需要余额：");
    await chooseModel("小模型");
    expect(mainText()).not.toContain("从余额扣点");
  });

  it("no site model configured: that group reads 尚未开放", async () => {
    await openForm({ models: NO_SITE });
    await openPicker();
    expect(groups()[0]).toEqual(["站点提供", ["(尚未开放)"]]);
    await click(rowOf("gpt-x"));
    expect(modelBox().textContent).toBe("gpt-x");
  });

  it("every row and the button carry the model's brand mark (the generic one when it has none); the brand of a choice is read from a site model's id or label, a provider model's name", async () => {
    await openForm();
    await openPicker();
    expect(rowOf("gpt-x").querySelector(".model-brand").dataset.brand).toBe("openai");
    expect(rowOf("小模型").querySelector(".model-brand").dataset.brand).toBe("generic");
    await click(rowOf("gpt-x"));
    expect(modelBox().querySelector(".model-brand").dataset.brand).toBe("openai");
    const state = { siteModels: [{ id: "site-1", label: "Claude Mini" }, { id: "free-1", label: "小模型" }] };
    expect(modelLab(state, { source: "site", id: "gpt-4o" })).toBe("openai");
    expect(modelLab(state, { source: "site", id: "site-1" })).toBe("claude");
    expect(modelLab(state, { source: "site", id: "free-1" })).toBeNull();
    expect(modelLab(state, { source: "provider", providerId: "p", model: "gemini-2" })).toBe("gemini");
    expect(modelLab(state, { source: "provider", providerId: "p", model: "house-blend" })).toBeNull();
  });

  it("no provider: that group says so; a provider without models says it has none", async () => {
    await openForm({ providers: [] });
    await openPicker();
    expect(groups()[1]).toEqual(["我的供应商", ["(还没有添加供应商)"]]);
    cleanup();
    await openForm({ providers: [providerOf(P1, { name: "空的", models: [] })] });
    await openPicker();
    expect(groups()[1]).toEqual(["我的供应商 · 空的", ["(没有可选的模型)"]]);
  });

  it("nothing to choose at all (providers without models included): a notice leading to Settings › 模型供应商", async () => {
    await openForm({ models: NO_SITE, providers: [providerOf(P1, { models: [] })] });
    expect(inMain().queryByLabelText("模型")).toBeNull();
    expect(mainText()).toContain("还没有可用的模型");
    expect(inMain().getByRole("button", { name: "添加模型供应商" })).toBeTruthy();
    expect(mainText()).toContain(PRIVACY);
  });

  it("the privacy notice stands beside the picker", async () => {
    await openForm();
    const field = modelBox().closest(".field");
    expect(field.parentElement.textContent).toContain(PRIVACY);
  });

  it("every notice in the form sits inside form.page-body, whose notices stop at the fields' width (same token)", async () => {
    await openForm();
    const form = modelBox().closest("form");
    expect(form.classList.contains("page-body")).toBe(true);
    const privacy = [...form.querySelectorAll(".notice")].find((n) => n.textContent.includes(PRIVACY));
    expect(privacy).toBeTruthy();
    for (const n of form.querySelectorAll(".notice")) expect(n.closest("form.page-body")).toBe(form);
    const css = readFileSync(resolve(__dirname, "../src/styles.css"), "utf8");
    expect(css).toMatch(/form.page-body .notice\s*\{[^}]*max-width:\s*var\(--field-w\)/);
    expect(css).toMatch(/\.field\s*\{[^}]*max-width:\s*var\(--field-w\)/);
  });

  it("the model rows and the opened 高级 panel stop at the fields' width (the same token); on a phone the open panel takes the row's full width", () => {
    const css = readFileSync(resolve(__dirname, "../src/styles.css"), "utf8");
    expect(css).toMatch(/form\.page-body \.member-rows\s*\{[^}]*max-width:\s*var\(--field-w\)/);
    expect(css).toMatch(/\.model-panel\s*\{[^}]*max-width:\s*var\(--field-w\)/);
    const phone = css.slice(css.indexOf("@media (max-width: 480px)"));
    expect(phone).toMatch(/li:has\(\.model-panel\)\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(phone).toMatch(/li:has\(\.model-panel\) > \.member-body\s*\{[^}]*flex:\s*1 1 100%/);
    expect(css).toMatch(/\.model-panel \.checks label span\s*\{[^}]*min-width:\s*0/);
  });

  it("while it loads it says so (not that nothing is available), and creating waits", async () => {
    const pending = deferred();
    await openForm({ api: { listProviders: vi.fn(() => pending.promise) } });
    expect(mainText()).toContain("正在读取可用的模型…");
    expect(mainText()).not.toContain("还没有可用的模型");
    expect(reasonText()).toBe("正在读取可用的模型…");
    pending.resolve({ providers: [providerOf()] });
    await flush();
    expect(modelBox()).toBeTruthy();
  });

  it("my providers failing to load says so, keeps the site models, and can be tried again", async () => {
    const listProviders = vi.fn(async () => {
      throw apiError(503, "busy");
    });
    await openForm({ api: { listProviders } });
    expect(mainText()).toContain("没能读取你的模型供应商，请重试。");
    await openPicker();
    expect(groups()[0][1]).toEqual(["小模型", "大模型"]);
    expect(groups()[1]).toEqual(["我的供应商", ["(暂时读取不到)"]]);
    await key(search(), "Escape");
    listProviders.mockImplementation(async () => ({ providers: [providerOf()] }));
    await click(inMain().getByRole("button", { name: "重试" }));
    expect(listProviders).toHaveBeenCalledTimes(2);
    expect(mainText()).not.toContain("没能读取你的模型供应商");
    await openPicker();
    expect(groups()[1][0]).toBe("我的供应商 · 我的 OpenAI");
  });

  it("editing an Agent whose model is no longer offered keeps it as the current choice; saving other fields leaves it alone", async () => {
    const agent = agentOf(AG1, { model: { source: "site", id: "gone" }, reasoning: "none" });
    const patchAgent = vi.fn(async (_id, patch) => ({ ...agent, ...patch }));
    await openForm({ agents: [agent], api: { patchAgent }, edit: true });
    expect(modelBox().textContent).toBe("gone（当前，已不可用）");
    await openPicker();
    const current = rowOf("gone（当前，已不可用）");
    expect(current.getAttribute("aria-selected")).toBe("true");
    // It leads the list, before the groups.
    expect(current.closest('[role="group"]')).toBeNull();
    await key(search(), "Escape");
    fireEvent.change(inMain().getByLabelText("简介"), { target: { value: "新的" } });
    await click(inMain().getByRole("button", { name: "保存" }));
    expect(patchAgent).toHaveBeenCalledWith(AG1, { intro: "新的" });
  });
});

describe("opening, closing and the keyboard", () => {
  it("on a touch screen the sheet opens without the keyboard: the search field is not focused (the focus is in the sheet), a tap on it focuses it; a desktop pointer keeps the autofocus", async () => {
    window.matchMedia = (query) => ({ matches: query === "(pointer: coarse)" || query === "(max-width: 480px)", media: query, addEventListener() {}, removeEventListener() {} });
    try {
      await openForm();
      await click(modelBox());
      const pop = document.querySelector(".model-pop");
      expect(document.activeElement).not.toBe(search());
      expect(pop.contains(document.activeElement), "the focus is in the sheet").toBe(true);
      act(() => search().focus());
      expect(document.activeElement).toBe(search());
    } finally {
      delete window.matchMedia;
    }
  });

  it("the button says it opens a list; opening focuses the search field, Esc closes it and gives the focus back", async () => {
    await openForm();
    expect(modelBox().tagName).toBe("BUTTON");
    expect(modelBox().getAttribute("aria-haspopup")).toBe("listbox");
    expect(modelBox().getAttribute("aria-expanded")).toBe("false");
    await click(modelBox());
    expect(modelBox().getAttribute("aria-expanded")).toBe("true");
    expect(modelBox().getAttribute("aria-controls")).toBe(listbox().id);
    expect(document.activeElement).toBe(search());
    expect(search().getAttribute("placeholder")).toBe("搜索模型…");
    expect(search().getAttribute("aria-controls")).toBe(listbox().id);
    await key(search(), "Escape");
    expect(listbox()).toBeNull();
    expect(modelBox().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(modelBox());
  });

  it("a click outside closes it without choosing; clicking the button again closes it too", async () => {
    await openForm();
    await click(modelBox());
    fireEvent.pointerDown(inMain().getByLabelText("名称"));
    await flush();
    expect(listbox()).toBeNull();
    expect(modelBox().textContent).toBe("请选择模型");
    await click(modelBox());
    fireEvent.pointerDown(search());
    await flush();
    expect(listbox()).not.toBeNull();
    await click(modelBox());
    expect(listbox()).toBeNull();
  });

  it("Tab leaves: the list closes and the focus is back on the button, from where the browser moves on", async () => {
    await openForm();
    await click(modelBox());
    await key(search(), "Tab");
    expect(listbox()).toBeNull();
    expect(document.activeElement).toBe(modelBox());
  });

  it("↓ on the closed button opens it; ↑/↓ move over the rows that can be chosen (skipping one that cannot); Enter chooses", async () => {
    await openForm();
    modelBox().focus();
    await key(modelBox(), "ArrowDown");
    expect(listbox()).not.toBeNull();
    expect(nameOf(activeRow())).toBe("小模型");
    expect(activeRow().classList.contains("active")).toBe(true);
    await key(search(), "ArrowDown");
    expect(nameOf(activeRow())).toBe("大模型");
    await key(search(), "ArrowDown");
    await key(search(), "ArrowDown");
    expect(nameOf(activeRow())).toBe("plain");
    // tiny cannot be chosen: ↓ stays on the last row that can.
    await key(search(), "ArrowDown");
    expect(nameOf(activeRow())).toBe("plain");
    await key(search(), "ArrowUp");
    expect(nameOf(activeRow())).toBe("gpt-x");
    await key(search(), "Enter");
    expect(listbox()).toBeNull();
    expect(modelBox().textContent).toBe("gpt-x");
    expect(document.activeElement).toBe(modelBox());
    // Opened again, the current choice is marked and is where the keyboard starts.
    await click(modelBox());
    expect(rowOf("gpt-x").getAttribute("aria-selected")).toBe("true");
    expect(rowOf("小模型").getAttribute("aria-selected")).toBe("false");
    expect(nameOf(activeRow())).toBe("gpt-x");
  });

  it("typing on the closed button opens it with what was typed in the search field", async () => {
    await openForm();
    await key(modelBox(), "x");
    expect(search().value).toBe("x");
    expect(groups()).toEqual([["我的供应商 · 我的 OpenAI", ["gpt-x"]]]);
  });

  it("a row that cannot be chosen says why and cannot be chosen", async () => {
    await openForm();
    await openPicker();
    const tiny = rowOf("tiny");
    expect(tiny.getAttribute("aria-disabled")).toBe("true");
    expect(tiny.getAttribute("title")).toBe("上下文太小");
    expect(tiny.textContent).toContain("上下文太小");
    await click(tiny);
    expect(listbox()).not.toBeNull();
    expect(modelBox().textContent).toBe("请选择模型");
  });
});

describe("where the list opens", () => {
  /** The form's scrolling page: 700 px seen, `room` px more below. */
  const scrollerOf = (room) => {
    const scroller = modelBox().closest(".page-body");
    scroller.style.overflowY = "auto";
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 700 });
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 700 + room });
    Object.defineProperty(scroller, "scrollTop", { configurable: true, writable: true, value: 0 });
    return scroller;
  };
  /** The button `fromTop` px down the (768 px) window before its page scrolls; 42 px high. */
  const placeButton = (scroller, fromTop) =>
    vi.spyOn(modelBox(), "getBoundingClientRect").mockImplementation(() => {
      const top = fromTop - scroller.scrollTop;
      return { top, bottom: top + 42, left: 20, right: 520, width: 500, height: 42, x: 20, y: top };
    });
  const pop = () => document.querySelector(".model-pop");

  it("near the window's bottom it first scrolls its page to make room below, then opens downward", async () => {
    await openForm();
    const scroller = scrollerOf(1000);
    placeButton(scroller, 600);
    await click(modelBox());
    expect(scroller.scrollTop).toBeGreaterThan(0);
    expect(pop().classList.contains("up")).toBe(false);
    expect(pop().getAttribute("style")).toContain(`--pop-top: ${600 - scroller.scrollTop + 42 + 6}px`);
  });

  it("with room below it neither scrolls nor opens upward", async () => {
    await openForm();
    const scroller = scrollerOf(1000);
    placeButton(scroller, 120);
    await click(modelBox());
    expect(scroller.scrollTop).toBe(0);
    expect(pop().classList.contains("up")).toBe(false);
  });

  it("opens upward only when its page cannot make enough room below", async () => {
    await openForm();
    const scroller = scrollerOf(0);
    placeButton(scroller, 600);
    await click(modelBox());
    expect(scroller.scrollTop).toBe(0);
    expect(pop().classList.contains("up")).toBe(true);
  });
});

describe("searching", () => {
  it("filters by the model's name, its id and its provider's name, in any case; groups left empty are hidden", async () => {
    await openForm();
    await openPicker();
    await typeSearch("GPT");
    expect(groups()).toEqual([["我的供应商 · 我的 OpenAI", ["gpt-x"]]]);
    await typeSearch("paid-1");
    expect(groups()).toEqual([["站点提供", ["大模型"]]]);
    await typeSearch("openai");
    expect(groups()).toEqual([["我的供应商 · 我的 OpenAI", ["gpt-x", "plain", "(tiny)"]]]);
    await typeSearch("我的 pl");
    expect(groups()).toEqual([["我的供应商 · 我的 OpenAI", ["plain"]]]);
    await typeSearch("");
    expect(groups().map(([label]) => label)).toEqual(["站点提供", "我的供应商 · 我的 OpenAI"]);
  });

  it("nothing matches: 没有匹配的模型, and Enter chooses nothing", async () => {
    await openForm();
    await openPicker();
    await typeSearch("zzz");
    expect(groups()).toEqual([]);
    expect(screen.getByText("没有匹配的模型")).toBeTruthy();
    await key(search(), "Enter");
    expect(listbox()).not.toBeNull();
    expect(modelBox().textContent).toBe("请选择模型");
  });

  it("the keyboard starts on the first row found, and Enter takes it", async () => {
    await openForm();
    await openPicker();
    await typeSearch("plain");
    expect(nameOf(activeRow())).toBe("plain");
    await key(search(), "Enter");
    expect(modelBox().textContent).toBe("plain");
  });
});

describe("the marks at a row's right", () => {
  it("免费 / 需余额 for a site model, then 看图, 思考 and 工具 only as the model's own fields say true; nothing else", async () => {
    const models = {
      ...MODELS,
      siteModels: [...SITE_MODELS, { id: "quiet-1", label: "安静模型", tier: "free", vision: true, pdf: true, reasoning: [], contextTokens: 32000, tools: false }],
    };
    const providers = [
      providerOf(P1, {
        models: [
          { name: "gpt-x", vision: true, pdf: true, reasoning: true, contextTokens: 64000, tools: true },
          { name: "no-tools", vision: false, pdf: false, reasoning: true, contextTokens: 64000, tools: false },
          { name: "plain", vision: false, pdf: false, reasoning: false, contextTokens: 16000 },
        ],
      }),
    ];
    await openForm({ models, providers });
    await openPicker();
    expect(marksOf("小模型")).toEqual(["免费", "工具"]);
    expect(marksOf("大模型")).toEqual(["需余额", "看图", "思考", "工具"]);
    expect(marksOf("安静模型")).toEqual(["免费", "看图"]);
    expect(marksOf("gpt-x")).toEqual(["看图", "思考", "工具"]);
    expect(marksOf("no-tools")).toEqual(["思考"]);
    // A provider model that says nothing of tools (not known yet) shows none: a mark states a known fact.
    expect(marksOf("plain")).toEqual([]);
    // Each kind of mark has its own column, so the marks line up from row to row.
    const columns = (name) => [...rowOf(name).querySelectorAll("[data-col]")].map((m) => m.dataset.col);
    expect(columns("小模型")).toEqual(["price", "vision", "reasoning", "tools"]);
    // (A provider group has no price, so no room for one.)
    expect(columns("plain")).toEqual(["vision", "reasoning", "tools"]);
    expect(listbox().textContent).not.toMatch(/联网/);
  });

  it("a list without site models has no price column", async () => {
    await openForm({ models: NO_SITE });
    await openPicker();
    expect([...rowOf("plain").querySelectorAll("[data-col]")].map((m) => m.dataset.col)).toEqual(["reasoning"]);
  });
});
