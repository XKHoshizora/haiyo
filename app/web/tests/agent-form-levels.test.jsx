// @vitest-environment jsdom
// Owner decision 2026-11-26: the thinking level of a reply for others (「别人 @ 它或来找它时的思考程度」) and of a proactive reply
// (「主动回复时的思考程度」) are the owner's settings, in the Agent's form beside the numbers each belongs to. Each offers exactly the
// levels the chosen model lists (hidden when it only has 不思考), shows the level that would run (the effective one), and is sent only
// when it is not the default (create) or when I changed it (edit). The Agent's page says both effective levels.
import "./markdown-ready.js";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { AG1, MODELS, P1, PRINCIPALS, agentConv, agentOf, agentPrincipal, providerOf, syncOf, usageOf } from "./fixtures.js";
import { click, flush, inMain, installBrowser, mainText, openApp, push } from "./harness.jsx";
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
const OTHERS_HINT = "别人在群里 @ 它、或来和它聊天时用。思考越多，回复越慢，花的额度也越多，算在别人今天的额度里。";
const PROACTIVE_HINT = "思考越多，回复越慢，花的额度也越多。";
const PAID = { source: "site", id: "paid-1" };

const rail = (name) => within(screen.getByRole("navigation", { name: "主导航" })).getByRole("button", { name });
const inList = () => within(document.querySelector(".list-col"));
const box = (label) => inMain().queryByLabelText(label);
const levels = (label) => optionsOf(box(label)).map(([, text]) => text);

async function openAgents({ agents = [], api = {} } = {}) {
  const principals = [...PRINCIPALS, ...agents.map((a) => agentPrincipal(a.id, a.handle, a.name))];
  const conversations = agents.map((a) => agentConv(a.conversationId, a.id));
  const app = await openApp({
    sync: () => syncOf(conversations, [], principals),
    api: {
      getModels: vi.fn(async () => ({ ...MODELS, proactiveAvailable: true })),
      listProviders: vi.fn(async () => ({ providers: [providerOf()] })),
      getUsage: vi.fn(async () => usageOf()),
      listAgents: vi.fn(() => new Promise(() => {})),
      ...api,
    },
    handlers: { agents: () => ({ agents }), models: () => ({ ...MODELS, proactiveAvailable: true }) },
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
const openCreate = async (api = {}) => {
  await openAgents({ api });
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
  it("each select sits with what it belongs to, offers the model's levels, starts at 不思考, and is hidden for a model that only has 不思考", async () => {
    const createAgent = vi.fn(async () => agentOf(AG1));
    await openCreate({ createAgent });
    await chooseModel("小模型 · 免费");
    expect(box(OTHERS)).toBeNull();
    await chooseModel("大模型 · 需余额");
    expect(levels(OTHERS)).toEqual(["不思考", "低", "高"]);
    expect(box(OTHERS).value).toBe("none");
    // In the group about others' use, with its one line of help.
    const group = box(OTHERS).closest("fieldset");
    expect(group.querySelector("legend").textContent).toBe("别人用它的上限（可不填）");
    expect(box(OTHERS).closest(".field").textContent).toContain(OTHERS_HINT);
    // The proactive one only while proactive replies are on, beside 话多话少.
    expect(box(PROACTIVE)).toBeNull();
    fireEvent.click(inMain().getByLabelText("主动参与群聊"));
    expect(levels(PROACTIVE)).toEqual(["不思考", "低", "高"]);
    expect(box(PROACTIVE).closest(".field").textContent).toContain(PROACTIVE_HINT);
    expect(box(PROACTIVE).closest(".field").textContent).not.toContain("别人今天的额度");
    pickOption(box(OTHERS), "high");
    pickOption(box(PROACTIVE), "low");
    await click(inMain().getByRole("button", { name: /^创建 Agent$/ }));
    expect(createAgent.mock.calls[0][0]).toMatchObject({ othersReasoning: "high", proactiveReasoning: "low", reasoning: "none" });
  });

  it("left at 不思考, neither is sent; the proactive level is not sent while proactive replies are off", async () => {
    const createAgent = vi.fn(async () => agentOf(AG1));
    await openCreate({ createAgent });
    await chooseModel("大模型 · 需余额");
    await click(inMain().getByRole("button", { name: /^创建 Agent$/ }));
    const body = createAgent.mock.calls[0][0];
    expect(body).not.toHaveProperty("othersReasoning");
    expect(body).not.toHaveProperty("proactiveReasoning");
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
});

describe("the Agent's page", () => {
  it("says the level others' replies run at beside its others' limit, and the proactive one beside the proactive budget; nothing of either for a model that only has 不思考", async () => {
    const record = agentOf(AG1, { model: PAID, othersLimit: { answers: null, points: null }, othersUsedToday: { answers: 0, points: "0" }, othersReasoning: "max", proactive: true, proactiveBudget: "70", proactiveReasoning: "none" });
    await openAgents({ agents: [record] });
    await click(inList().getByText("小助手", { selector: ".row-name" }));
    expect(mainText()).toContain("没有单独设置，和其他 Agent 共用你的每天上限 · 回应别人时思考：高");
    expect(mainText()).toContain("每天最多花 70 点");
    expect(mainText()).toContain(" · 主动回复时不思考");
    cleanup();
    installBrowser();
    await openAgents({ agents: [agentOf(AG1, { model: { source: "site", id: "free-1" }, othersLimit: { answers: null, points: null }, othersUsedToday: { answers: 0, points: "0" }, othersReasoning: "high" })] });
    await click(inList().getByText("小助手", { selector: ".row-name" }));
    expect(mainText()).toContain("没有单独设置，和其他 Agent 共用你的每天上限");
    expect(mainText()).not.toContain("回应别人时");
  });
});

describe("fix round 3, point 4", () => {
  it("the Agent's page reads the use route again when its model or either level changes elsewhere (a second tab): the state shown is not left from before the edit", async () => {
    const record = agentOf(AG1, { model: PAID, othersLimit: { answers: null, points: null }, othersUsedToday: { answers: 0, points: "0" }, othersReasoning: "none", proactiveReasoning: "none" });
    const getOthersUse = vi.fn(async () => ({ limits: { answers: 50, points: "300" }, used: { answers: 0, points: "0", proactivePoints: "0", proactiveAnswers: 0 }, reached: false, tight: false, byPerson: [], stopped: [], agents: [], notice: false }));
    const app = await openAgents({ agents: [record], api: { getOthersUse } });
    await click(inList().getByText("小助手", { selector: ".row-name" }));
    const before = getOthersUse.mock.calls.length;
    const elsewhere = async (fields) => {
      app.transport.handlers.agent = () => ({ ...record, ...fields });
      await push(app.transport, { type: "agent", id: AG1 });
      await flush();
    };
    await elsewhere({ othersReasoning: "high" });
    expect(getOthersUse.mock.calls.length).toBe(before + 1);
    await elsewhere({ othersReasoning: "high", proactiveReasoning: "low" });
    expect(getOthersUse.mock.calls.length).toBe(before + 2);
    await elsewhere({ othersReasoning: "high", proactiveReasoning: "low", model: { source: "site", id: "free-1" } });
    expect(getOthersUse.mock.calls.length).toBe(before + 3);
  });

  it("a model that is no longer offered: its levels are not known, so neither select is drawn (no option is made up from the Agent's own saved level), and nothing of them is sent", async () => {
    const { patchAgent } = await openEdit({ model: { source: "site", id: "gone-9" }, reasoning: "high", othersReasoning: "high", proactive: true, proactiveReasoning: "high" });
    expect(box(OTHERS)).toBeNull();
    expect(box(PROACTIVE)).toBeNull();
    fireEvent.change(inMain().getByLabelText("简介"), { target: { value: "新的简介" } });
    await save();
    expect(patchAgent.mock.calls[0][1]).toEqual({ intro: "新的简介" });
  });

  it("the others' select says whom it is for (a call in a group, a visitor) and what it counts against", async () => {
    await openEdit({});
    expect(box(OTHERS).closest(".field").textContent).toContain("别人在群里 @ 它、或来和它聊天时用。思考越多，回复越慢，花的额度也越多，算在别人今天的额度里。");
  });
});

describe("fix round 3, ruling 5: no level is offered or shown that no reply runs at", () => {
  // The service sends 最高 as 很高 on Chat Completions and Gemini (models/resolve.ts `sentLevel`): there the top of every list is 很高.
  const GPT = { source: "provider", providerId: P1, model: "gpt-x" };
  const edit = async (provider) => {
    const record = agentOf(AG1, { model: GPT, reasoning: "max", othersLimit: { answers: null, points: null }, othersUsedToday: { answers: 0, points: "0" }, othersReasoning: "max", proactive: true, proactiveBudget: "70", proactiveReasoning: "max" });
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

describe("fix round 4, F5: the state an Agent's page shows of its room for others is never left from before a change", () => {
  const USE = (fields = {}) => ({ limits: { answers: 50, points: "300" }, used: { answers: 0, points: "0", proactivePoints: "0", proactiveAnswers: 0 }, reached: false, tight: false, byPerson: [], stopped: [], agents: [], notice: false, ...fields });
  const record = agentOf(AG1, { model: PAID, othersLimit: { answers: null, points: null }, othersUsedToday: { answers: 0, points: "0" }, othersReasoning: "none", proactiveReasoning: "none", proactive: false, proactiveBudget: "70" });

  it("its proactive switch or its proactive budget changed elsewhere: the use route is read again (both decide whether it is used up)", async () => {
    const getOthersUse = vi.fn(async () => USE());
    const app = await openAgents({ agents: [record], api: { getOthersUse } });
    await click(inList().getByText("小助手", { selector: ".row-name" }));
    const before = getOthersUse.mock.calls.length;
    const elsewhere = async (fields) => {
      app.transport.handlers.agent = () => ({ ...record, ...fields });
      await push(app.transport, { type: "agent", id: AG1 });
      await flush();
    };
    await elsewhere({ proactive: true });
    expect(getOthersUse.mock.calls.length).toBe(before + 1);
    await elsewhere({ proactive: true, proactiveBudget: "20" });
    expect(getOthersUse.mock.calls.length).toBe(before + 2);
  });

  it("a change while a read is still in flight: that read may be from before the change, so another is made after it and its answer is the one kept", async () => {
    let answer = null;
    const waiting = [];
    const getOthersUse = vi.fn(() => (answer === null ? new Promise((resolve) => waiting.push(resolve)) : Promise.resolve(answer)));
    answer = USE();
    const app = await openAgents({ agents: [record], api: { getOthersUse } });
    await click(inList().getByText("小助手", { selector: ".row-name" }));
    const before = getOthersUse.mock.calls.length;
    const elsewhere = async (fields) => {
      app.transport.handlers.agent = () => ({ ...record, ...fields });
      await push(app.transport, { type: "agent", id: AG1 });
      await flush();
    };
    // The first change's read does not answer yet.
    answer = null;
    await elsewhere({ othersReasoning: "high" });
    expect(getOthersUse.mock.calls.length).toBe(before + 1);
    // A second change meanwhile: the read in flight was sent before it.
    await elsewhere({ othersReasoning: "high", proactive: true });
    answer = USE({ reached: true, tight: true });
    waiting.splice(0).forEach((resolve) => resolve(USE()));
    await flush();
    await flush();
    expect(getOthersUse.mock.calls.length).toBe(before + 2);
  });

  it("a newer answer settled while an older read is in flight is not overwritten by that read", async () => {
    let resolve = () => {};
    const actions = { getOthersUse: () => new Promise((r) => (resolve = r)) };
    const store = storeOf(actions);
    const reading = readOthersUse(actions, store);
    const newer = USE({ limits: { answers: 9, points: "9" } });
    settleOthersUse(store, newer);
    resolve(USE());
    await reading;
    expect(store.use).toBe(newer);
    // And the next read is taken as ever.
    const later = USE({ limits: { answers: 3, points: "3" } });
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
    const newer = USE({ limits: { answers: 9, points: "9" } });
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
    // The older read's failure is no news: the reload after the change is the read that counts.
    expect(store.failed).toBe(false);
    await flush();
    const fresh = USE({ limits: { answers: 5, points: "5" } });
    answers[1].resolve(fresh);
    await after;
    expect([store.use, store.failed]).toEqual([fresh, false]);
  });
});
