// @vitest-environment jsdom
// Owner decision 2026-11-26: the thinking level of a reply for others (「别人 @ 它或来找它时的思考程度」) and of a proactive reply
// (「主动回复时的思考程度」) are the owner's settings, in the Agent's form. Each offers exactly the levels the chosen model lists (hidden when
// it only has 不思考), shows the level that would run (the effective one), and is sent only when it is not the default (create) or when I
// changed it (edit). The Agent's page says both effective levels. The limits redesign (Part 1): each select keeps ONE short hint, the most
// one reply at that level can cost (「这一档单条回复最多约 X 点」, the service's number), and the form has no limit and no budget of the
// Agent's own any more: others' use is the owner's one number (Settings › 别人怎么用我的 Agent).
import "./markdown-ready.js";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { AG1, MODELS, P1, PRINCIPALS, SITE_MODELS, agentConv, agentOf, agentPrincipal, providerOf, syncOf, usageOf } from "./fixtures.js";
import { click, flush, inMain, installBrowser, mainText, openApp } from "./harness.jsx";
import { optionsOf, pickOption } from "./select-helpers.js";
import { readOthersUse, settleOthersUse, storeOf } from "../src/data/othersUseCache.js";

beforeEach(() => {
  installBrowser();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const OTHERS = "别人 @ 它或来找它时的思考程度";
const PROACTIVE = "主动回复时的思考程度";
const PAID = { source: "site", id: "paid-1" };
/** The site's models with what one reply to someone else can cost at each level the paid model runs (the service's `othersCeiling`). */
const PRICED = {
  ...MODELS,
  proactiveAvailable: true,
  othersOwnKeyPoints: "6",
  siteModels: SITE_MODELS.map((m) => (m.id === "paid-1" ? { ...m, othersCeiling: { none: "61.5", low: "91.5", high: "241.5" } } : { ...m, othersCeiling: { none: "2.5" } })),
};

const rail = (name) => within(screen.getByRole("navigation", { name: "主导航" })).getByRole("button", { name });
const inList = () => within(document.querySelector(".list-col"));
const box = (label) => inMain().queryByLabelText(label);
const levels = (label) => optionsOf(box(label)).map(([, text]) => text);
const hintOf = (label) => box(label).closest(".field").querySelector(".field-hint")?.textContent ?? null;

async function openAgents({ agents = [], api = {}, models = PRICED } = {}) {
  const principals = [...PRINCIPALS, ...agents.map((a) => agentPrincipal(a.id, a.handle, a.name))];
  const conversations = agents.map((a) => agentConv(a.conversationId, a.id));
  const app = await openApp({
    sync: () => syncOf(conversations, [], principals),
    api: {
      getModels: vi.fn(async () => models),
      listProviders: vi.fn(async () => ({ providers: [providerOf()] })),
      getUsage: vi.fn(async () => usageOf()),
      listAgents: vi.fn(() => new Promise(() => {})),
      ...api,
    },
    handlers: { agents: () => ({ agents }), models: () => models },
  });
  fireEvent.click(rail(/^Agent/));
  await flush();
  return app;
}
const chooseModel = async (name) => {
  const button = inMain().getByLabelText("模型");
  if (button.getAttribute("aria-expanded") !== "true") await click(button);
  const option = [...document.querySelectorAll('.model-pop [role="option"]')].find((o) => (o.getAttribute("aria-label") ?? "").startsWith(name));
  await click(option);
};
const openCreate = async (api = {}, models = PRICED) => {
  await openAgents({ api, models });
  await click(inList().getByRole("button", { name: "创建 Agent" }));
  fireEvent.change(inMain().getByLabelText("名称"), { target: { value: "MyBot" } });
};
const openEdit = async (fields = {}) => {
  const record = agentOf(AG1, { model: PAID, ...fields });
  const patchAgent = vi.fn(async (_id, patch) => ({ ...record, ...patch }));
  await openAgents({ agents: [record], api: { patchAgent } });
  await click(inList().getByText("小助手", { selector: ".row-name" }));
  await click(inMain().getByRole("button", { name: /编辑/ }));
  return { patchAgent, record };
};
const save = () => click(inMain().getByRole("button", { name: "保存" }));

describe("creating", () => {
  it("each select offers the model's levels, starts at 不思考, and is hidden for a model that only has 不思考", async () => {
    const createAgent = vi.fn(async () => agentOf(AG1));
    await openCreate({ createAgent });
    await chooseModel("小模型 · 免费");
    expect(box(OTHERS)).toBeNull();
    await chooseModel("大模型 · 需余额");
    expect(levels(OTHERS)).toEqual(["不思考", "低", "高"]);
    expect(box(OTHERS).value).toBe("none");
    // The proactive one only while proactive replies are on, beside 话多话少.
    expect(box(PROACTIVE)).toBeNull();
    fireEvent.click(inMain().getByLabelText("主动参与群聊"));
    expect(levels(PROACTIVE)).toEqual(["不思考", "低", "高"]);
    pickOption(box(OTHERS), "high");
    pickOption(box(PROACTIVE), "low");
    await click(inMain().getByRole("button", { name: /^创建 Agent$/ }));
    expect(createAgent.mock.calls[0][0]).toMatchObject({ othersReasoning: "high", proactiveReasoning: "low", reasoning: "none" });
  });

  it("each select's one hint is the most one reply at the level shown can cost, as the service says; it follows the level and the model", async () => {
    await openCreate();
    await chooseModel("大模型 · 需余额");
    expect(hintOf(OTHERS)).toBe("这一档单条回复最多约 61.5 点");
    pickOption(box(OTHERS), "high");
    expect(hintOf(OTHERS)).toBe("这一档单条回复最多约 241.5 点");
    fireEvent.click(inMain().getByLabelText("主动参与群聊"));
    expect(hintOf(PROACTIVE)).toBe("这一档单条回复最多约 61.5 点");
    pickOption(box(PROACTIVE), "low");
    expect(hintOf(PROACTIVE)).toBe("这一档单条回复最多约 91.5 点");
    // A model on my own key costs no points: each of its replies counts what the service says (6 points) whatever the level, and a
    // web search is charged besides — no "at most" is promised.
    await chooseModel("gpt-x");
    expect(hintOf(OTHERS)).toBe("按 6 点计，联网搜索另计");
  });

  it("with no number from the service the select has no hint at all", async () => {
    await openCreate({}, { ...MODELS, proactiveAvailable: true });
    await chooseModel("大模型 · 需余额");
    expect(hintOf(OTHERS)).toBeNull();
  });

  it("left at 不思考, neither is sent; the proactive level is not sent while proactive replies are off; no limit or budget of its own is sent", async () => {
    const createAgent = vi.fn(async () => agentOf(AG1));
    await openCreate({ createAgent });
    await chooseModel("大模型 · 需余额");
    fireEvent.click(inMain().getByLabelText("主动参与群聊"));
    fireEvent.click(inMain().getByLabelText("主动参与群聊"));
    await click(inMain().getByRole("button", { name: /^创建 Agent$/ }));
    const body = createAgent.mock.calls[0][0];
    for (const key of ["othersReasoning", "proactiveReasoning", "othersLimit", "othersBudget", "proactiveBudget"]) expect([key, Object.hasOwn(body, key)]).toEqual([key, false]);
  });

  it("the form has no box of the Agent's own limit for others and no daily budget for proactive replies", async () => {
    const createAgent = vi.fn(async () => agentOf(AG1));
    await openCreate({ createAgent });
    await chooseModel("小模型 · 免费");
    fireEvent.click(inMain().getByLabelText("主动参与群聊"));
    expect(mainText()).not.toContain("别人用它的上限");
    expect(inMain().queryByLabelText("每天最多回别人（次）")).toBeNull();
    expect(inMain().queryByLabelText("每天最多花（点）")).toBeNull();
    expect(inMain().queryByLabelText("主动回复每天最多花")).toBeNull();
    await click(inMain().getByRole("button", { name: /^创建 Agent$/ }));
    expect(createAgent.mock.calls[0][0]).toMatchObject({ proactive: true, proactiveLevel: "normal" });
    expect(createAgent.mock.calls[0][0]).not.toHaveProperty("proactiveBudget");
  });

  it("a model that lacks the level picked shows the level that would run, and that one is sent", async () => {
    const createAgent = vi.fn(async () => agentOf(AG1));
    await openCreate({ createAgent, listProviders: vi.fn(async () => ({ providers: [providerOf(P1, { protocol: "anthropic" })] })) });
    await chooseModel("gpt-x");
    pickOption(box(OTHERS), "max");
    await chooseModel("大模型 · 需余额");
    expect(box(OTHERS).value).toBe("high");
    await click(inMain().getByRole("button", { name: /^创建 Agent$/ }));
    expect(createAgent.mock.calls[0][0]).toMatchObject({ othersReasoning: "high" });
  });
});

describe("editing", () => {
  it("shows the saved levels as they would run on its model; untouched nothing is sent; a pick is sent alone", async () => {
    const { patchAgent } = await openEdit({ othersReasoning: "max", proactive: true, proactiveReasoning: "low" });
    expect(box(OTHERS).value).toBe("high");
    expect(box(PROACTIVE).value).toBe("low");
    pickOption(box(PROACTIVE), "high");
    await save();
    expect(patchAgent).toHaveBeenCalledTimes(1);
    expect(patchAgent.mock.calls[0][1]).toEqual({ proactiveReasoning: "high" });
  });

  it("others' level changed: sent alone, as picked", async () => {
    const { patchAgent } = await openEdit({ othersReasoning: "none" });
    pickOption(box(OTHERS), "low");
    await save();
    expect(patchAgent.mock.calls[0][1]).toEqual({ othersReasoning: "low" });
  });

  it("a model that is no longer offered: its levels are not known, so neither select is drawn (no option is made up from the Agent's own saved level), and nothing of them is sent", async () => {
    const { patchAgent } = await openEdit({ model: { source: "site", id: "gone-9" }, reasoning: "high", othersReasoning: "high", proactive: true, proactiveReasoning: "high" });
    expect(box(OTHERS)).toBeNull();
    expect(box(PROACTIVE)).toBeNull();
    fireEvent.change(inMain().getByLabelText("简介"), { target: { value: "新的简介" } });
    await save();
    expect(patchAgent.mock.calls[0][1]).toEqual({ intro: "新的简介" });
  });
});

describe("the Agent's page", () => {
  it("says the level others' replies run at and the proactive one; nothing of either for a model that only has 不思考; no limit or budget of its own", async () => {
    const record = agentOf(AG1, { model: PAID, othersReasoning: "max", proactive: true, proactiveReasoning: "none" });
    await openAgents({ agents: [record] });
    await click(inList().getByText("小助手", { selector: ".row-name" }));
    expect(mainText()).toContain("回应别人时思考：高");
    expect(mainText()).toContain(" · 主动回复时不思考");
    expect(mainText()).not.toContain("每天最多花");
    expect(mainText()).not.toContain("别人用它的上限");
    cleanup();
    installBrowser();
    await openAgents({ agents: [agentOf(AG1, { model: { source: "site", id: "free-1" }, othersReasoning: "high" })] });
    await click(inList().getByText("小助手", { selector: ".row-name" }));
    expect(mainText()).not.toContain("回应别人时");
  });
});

describe("fix round 3, ruling 5: no level is offered or shown that no reply runs at", () => {
  // The service sends 最高 as 很高 on Chat Completions and Gemini (models/resolve.ts `sentLevel`): there the top of every list is 很高.
  const GPT = { source: "provider", providerId: P1, model: "gpt-x" };
  const edit = async (provider) => {
    const record = agentOf(AG1, { model: GPT, reasoning: "max", othersReasoning: "max", proactive: true, proactiveReasoning: "max" });
    await openAgents({ agents: [record], api: { listProviders: vi.fn(async () => ({ providers: [provider] })) } });
    await click(inList().getByText("小助手", { selector: ".row-name" }));
    const page = mainText();
    await click(inMain().getByRole("button", { name: /编辑/ }));
    return page;
  };
  const UP_TO_XHIGH = ["不思考", "低", "中", "高", "很高"];

  it.each([["openai_chat"], ["gemini"]])("a model of a %s provider: the Agent's own level and both selects end at 很高, a saved 最高 is shown as 很高, on its page too", async (protocol) => {
    const page = await edit(providerOf(P1, { protocol }));
    expect(page).toContain("回应别人时思考：很高");
    expect(page).toContain("主动回复时思考：很高");
    expect(page).not.toContain("最高");
    for (const label of ["思考程度", OTHERS, PROACTIVE]) {
      expect([label, levels(label)]).toEqual([label, UP_TO_XHIGH]);
      expect([label, box(label).value]).toEqual([label, "xhigh"]);
    }
  });

  it("a model that lists 高 and 最高 there is offered 高 and 很高", async () => {
    await edit(providerOf(P1, { models: [{ name: "gpt-x", vision: false, pdf: false, reasoning: true, contextTokens: 64000, reasoningLevels: ["high", "max"] }] }));
    for (const label of ["思考程度", OTHERS, PROACTIVE]) expect([label, levels(label)]).toEqual([label, ["不思考", "高", "很高"]]);
  });

  it.each([["anthropic"], ["openai_responses"]])("a model of a %s provider keeps 最高: it is sent as it is", async (protocol) => {
    const page = await edit(providerOf(P1, { protocol }));
    expect(page).toContain("回应别人时思考：最高");
    for (const label of ["思考程度", OTHERS, PROACTIVE]) {
      expect([label, levels(label)]).toEqual([label, [...UP_TO_XHIGH, "最高"]]);
      expect([label, box(label).value]).toEqual([label, "max"]);
    }
  });
});

describe("the one read of the use route the screen shares", () => {
  const USE = (fields = {}) => ({ limit: "300", used: "0", proactive: "0", ownKeyPoints: "6", reached: false, byPerson: [], stopped: [], notice: false, ...fields });

  it("a newer answer settled while an older read is in flight is not overwritten by that read", async () => {
    let resolve = () => {};
    const actions = { getOthersUse: () => new Promise((r) => (resolve = r)) };
    const store = storeOf(actions);
    const reading = readOthersUse(actions, store);
    const newer = USE({ limit: "9" });
    settleOthersUse(store, newer);
    resolve(USE());
    await reading;
    expect(store.use).toBe(newer);
    // And the next read is taken as ever.
    const later = USE({ limit: "3" });
    const again = readOthersUse(actions, store);
    resolve(later);
    await again;
    expect(store.use).toBe(later);
  });

  it("an older read that FAILS after a newer answer was settled says nothing of it: the newer answer stands, not marked stale (review 5, item 8)", async () => {
    let reject = () => {};
    const actions = { getOthersUse: vi.fn(() => new Promise((_, r) => (reject = r))) };
    const store = storeOf(actions);
    const reading = readOthersUse(actions, store);
    const newer = USE({ limit: "9" });
    settleOthersUse(store, newer);
    reject(new Error("offline"));
    await reading;
    expect([store.use, store.failed]).toEqual([newer, false]);
    // A read of its own that fails is still said.
    const own = readOthersUse(actions, store);
    reject(new Error("offline"));
    await own;
    expect([store.use, store.failed]).toEqual([newer, true]);
  });

  it("an older read that fails after a newer read answered (a reload asked for after a change) leaves that answer unmarked", async () => {
    const answers = [];
    const actions = { getOthersUse: vi.fn(() => new Promise((resolve, reject) => answers.push({ resolve, reject }))) };
    const store = storeOf(actions);
    const older = readOthersUse(actions, store);
    const after = readOthersUse(actions, store, { afterWrite: true });
    answers[0].reject(new Error("offline"));
    await older;
    await Promise.resolve();
    expect(store.failed).toBe(false);
    await flush();
    const fresh = USE({ limit: "5" });
    answers[1].resolve(fresh);
    await after;
    expect([store.use, store.failed]).toEqual([fresh, false]);
  });

  it("an answer of the old shape (two numbers) is no answer: the read says it failed", async () => {
    const actions = { getOthersUse: vi.fn(async () => ({ limits: { answers: 50, points: "300" } })) };
    const store = storeOf(actions);
    await readOthersUse(actions, store);
    expect([store.use, store.failed]).toEqual([null, true]);
  });
});
