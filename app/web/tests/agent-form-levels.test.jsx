// @vitest-environment jsdom
// Owner decision 2026-11-26: the thinking level of a reply for others (「别人 @ 它或来找它时的思考程度」) and of a proactive reply
// (「主动回复时的思考程度」) are the owner's settings, in the Agent's form beside the numbers each belongs to. Each offers exactly the
// levels the chosen model lists (hidden when it only has 不思考), shows the level that would run (the effective one), and is sent only
// when it is not the default (create) or when I changed it (edit). The Agent's page says both effective levels.
import "./markdown-ready.js";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { AG1, MODELS, PRINCIPALS, agentConv, agentOf, agentPrincipal, providerOf, syncOf, usageOf } from "./fixtures.js";
import { click, flush, inMain, installBrowser, mainText, openApp, push } from "./harness.jsx";
import { optionsOf, pickOption } from "./select-helpers.js";

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
    await openCreate({ createAgent });
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
