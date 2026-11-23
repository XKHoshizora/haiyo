// @vitest-environment jsdom
// B9b: an Agent's own limit on what others cause, in its form (「它自己的上限（可不填）」), on its page, and the proactive budget's new
// default (70). The form sends `othersLimit` and never `othersBudget`; emptying both fields sends null (the Agent then has only its
// owner's two numbers); a raised 70 shows as 70; the old fields of the wire are read nowhere.
import "./markdown-ready.js";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { AG1, MODELS, PRINCIPALS, agentConv, agentOf, agentPrincipal, providerOf, syncOf, usageOf } from "./fixtures.js";
import { click, flush, inMain, installBrowser, mainText, openApp, push } from "./harness.jsx";
import { PROACTIVE_BUDGET_DEFAULT, othersLimitOf } from "../src/pages/AgentForm.jsx";

beforeEach(() => {
  installBrowser();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const SITE_MODEL = { source: "site", id: "free-1" };
const ANSWERS = "每天最多回别人（次）";
const POINTS = "每天最多花（点）";
const LEGEND = "别人用它的上限（可不填）";
const HINT = "不填：它和你其他的 Agent 共用你的每天上限（在“别人怎么用我的 Agent”里改）。填了：它自己每天最多这么多，同时不超过你的每天上限。";
const ANSWERS_WRONG = "请填 1 到 1000 的整数，或者不填";
const POINTS_WRONG = "请填 1 到 100000 的点数，或者不填";

const rail = (name) => within(screen.getByRole("navigation", { name: "主导航" })).getByRole("button", { name });
const inList = () => within(document.querySelector(".list-col"));
const type = (label, value) => fireEvent.change(inMain().getByLabelText(label), { target: { value } });
const answers = () => inMain().getByLabelText(ANSWERS);
const points = () => inMain().getByLabelText(POINTS);

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
const openCreate = async () => click(inList().getByRole("button", { name: "创建 Agent" }));
const openEdit = async (fields = {}) => {
  const record = agentOf(AG1, { model: SITE_MODEL, ...fields });
  const patchAgent = vi.fn(async (_id, patch) => ({ ...record, ...patch }));
  const app = await openAgents({ agents: [record], api: { patchAgent } });
  await click(inList().getByText("小助手", { selector: ".row-name" }));
  await click(inMain().getByRole("button", { name: /编辑/ }));
  return { app, patchAgent, record };
};
const chooseModel = async (name) => {
  const box = inMain().getByLabelText("模型");
  if (box.getAttribute("aria-expanded") !== "true") await click(box);
  const option = [...document.querySelectorAll('.model-pop [role="option"]')].find((o) => (o.getAttribute("aria-label") ?? "").startsWith(name));
  await click(option);
};
const createWith = async (fill = () => {}) => {
  const createAgent = vi.fn(async () => agentOf(AG1));
  await openAgents({ api: { createAgent } });
  await openCreate();
  type("名称", "MyBot");
  await chooseModel("小模型 · 免费");
  fill();
  await click(inMain().getByRole("button", { name: /^创建 Agent$/ }));
  return createAgent;
};
const save = () => click(inMain().getByRole("button", { name: "保存" }));

describe("the value sent (othersLimitOf)", () => {
  it("each part a number of its kind or null for empty; undefined while either is something else", () => {
    expect(othersLimitOf({ othersAnswers: "", othersPoints: "" })).toEqual({ answers: null, points: null });
    expect(othersLimitOf({ othersAnswers: " 12 ", othersPoints: " 035.50 " })).toEqual({ answers: 12, points: "35.5" });
    expect(othersLimitOf({ othersAnswers: "1000", othersPoints: "100000" })).toEqual({ answers: 1000, points: "100000" });
    for (const [a, p] of [["0", ""], ["1001", ""], ["1.5", ""], ["abc", ""], ["", "0"], ["", "100001"], ["", "1.1234567"], ["", "abc"], ["5", "x"]]) {
      expect(othersLimitOf({ othersAnswers: a, othersPoints: p }), `${a}|${p}`).toBeUndefined();
    }
  });
});

describe("creating", () => {
  it("shows 「别人用它的上限（可不填）」 with two empty boxes and what empty means; a new Agent sends no limit of its own and never othersBudget", async () => {
    const createAgent = await createWith(() => {
      expect(inMain().getByText(LEGEND)).toBeTruthy();
      expect([answers().value, points().value]).toEqual(["", ""]);
      expect(inMain().getByText(HINT).id).toBe(answers().closest("fieldset").getAttribute("aria-describedby"));
    });
    const body = createAgent.mock.calls[0][0];
    expect(body).not.toHaveProperty("othersLimit");
    expect(body).not.toHaveProperty("othersBudget");
  });

  it("is shown whoever may call it: the people who reach it in a conversation of their own count too", async () => {
    await openAgents();
    await openCreate();
    fireEvent.change(inMain().getByLabelText("群里谁可以叫它"), { target: { value: "owner" } });
    expect(inMain().getByText(LEGEND)).toBeTruthy();
  });

  it("sends what was typed as the Agent's own limit: both parts, or one part with the other null", async () => {
    const both = await createWith(() => {
      type(ANSWERS, "12");
      type(POINTS, " 035.50 ");
    });
    expect(both.mock.calls[0][0]).toMatchObject({ othersLimit: { answers: 12, points: "35.5" } });
    cleanup();
    const one = await createWith(() => type(POINTS, "20"));
    expect(one.mock.calls[0][0]).toMatchObject({ othersLimit: { answers: null, points: "20" } });
    cleanup();
    const other = await createWith(() => type(ANSWERS, "7"));
    expect(other.mock.calls[0][0]).toMatchObject({ othersLimit: { answers: 7, points: null } });
  });

  it("a wrong number is refused inline with the service's ranges, and nothing is sent until it is mended", async () => {
    const createAgent = vi.fn(async () => agentOf(AG1));
    await openAgents({ api: { createAgent } });
    await openCreate();
    type("名称", "MyBot");
    await chooseModel("小模型 · 免费");
    for (const value of ["0", "1001", "1.5", "abc"]) {
      type(ANSWERS, value);
      await click(inMain().getByRole("button", { name: /^创建 Agent$/ }));
      expect(answers().closest(".field").textContent, value).toContain(ANSWERS_WRONG);
      expect(answers().getAttribute("aria-invalid"), value).toBe("true");
    }
    type(ANSWERS, "");
    for (const value of ["0", "100001", "abc", "1.1234567"]) {
      type(POINTS, value);
      await click(inMain().getByRole("button", { name: /^创建 Agent$/ }));
      expect(points().closest(".field").textContent, value).toContain(POINTS_WRONG);
    }
    expect(createAgent).not.toHaveBeenCalled();
    type(POINTS, "99.999999");
    await click(inMain().getByRole("button", { name: /^创建 Agent$/ }));
    expect(createAgent).toHaveBeenCalledTimes(1);
    expect(createAgent.mock.calls[0][0].othersLimit).toEqual({ answers: null, points: "99.999999" });
  });

  it("the proactive budget starts at 70 (the owner's whole default), and is sent as 70 when the switch is on", async () => {
    expect(PROACTIVE_BUDGET_DEFAULT).toBe("70");
    const createAgent = await createWith(() => fireEvent.click(inMain().getByLabelText("主动参与群聊")));
    expect(createAgent.mock.calls[0][0]).toMatchObject({ proactive: true, proactiveLevel: "normal", proactiveBudget: "70" });
  });
});

describe("editing", () => {
  it("shows the numbers as stored, so a raised 70 shows as 70; a part with none of its own is empty", async () => {
    await openEdit({ othersLimit: { answers: null, points: "70" } });
    expect([answers().value, points().value]).toEqual(["", "70"]);
    cleanup();
    await openEdit({ othersLimit: { answers: 5, points: null } });
    expect([answers().value, points().value]).toEqual(["5", ""]);
    cleanup();
    await openEdit({ othersLimit: { answers: null, points: null } });
    expect([answers().value, points().value]).toEqual(["", ""]);
  });

  it("clearing both parts sends othersLimit: null (the Agent then has only its owner's numbers)", async () => {
    const { patchAgent } = await openEdit({ othersLimit: { answers: 5, points: "70" } });
    type(ANSWERS, "");
    type(POINTS, "");
    await save();
    expect(patchAgent.mock.calls[0][1]).toEqual({ othersLimit: null });
  });

  it("clearing one part sends the other as it is; changing nothing sends nothing of it", async () => {
    const { patchAgent } = await openEdit({ othersLimit: { answers: 5, points: "70" } });
    type(POINTS, "");
    await save();
    expect(patchAgent.mock.calls[0][1]).toEqual({ othersLimit: { answers: 5, points: null } });
    await click(inMain().getByRole("button", { name: /编辑/ }));
    type("简介", "新简介");
    await save();
    expect(patchAgent.mock.calls[1][1]).toEqual({ intro: "新简介" });
  });

  it("a number typed and then written back as the record's is no change; a wrong one is never sent", async () => {
    const { patchAgent } = await openEdit({ othersLimit: { answers: 5, points: "70" } });
    type(POINTS, "70.000");
    type("简介", "新简介");
    await save();
    expect(patchAgent.mock.calls[0][1]).toEqual({ intro: "新简介" });
    await click(inMain().getByRole("button", { name: /编辑/ }));
    type(ANSWERS, "abc");
    await save();
    expect(patchAgent).toHaveBeenCalledTimes(1);
    expect(answers().closest(".field").textContent).toContain(ANSWERS_WRONG);
  });

  it("while the record changes elsewhere: an untouched limit follows it; once I touched either box the pair (one setting) stays as I have it, with the notice", async () => {
    const { app, patchAgent, record } = await openEdit({ othersLimit: { answers: 5, points: "70" } });
    const elsewhere = async (limit) => {
      app.transport.handlers.agent = () => ({ ...record, othersLimit: limit });
      await push(app.transport, { type: "agent", id: AG1 });
      await flush();
    };
    await elsewhere({ answers: 8, points: "70" });
    expect([answers().value, points().value]).toEqual(["8", "70"]);
    type(POINTS, "40");
    await elsewhere({ answers: 9, points: "50" });
    expect([answers().value, points().value]).toEqual(["8", "40"]);
    expect(mainText()).toContain("这个 Agent 的配置刚刚在别处有改动，保存会用你这里的内容覆盖你改过的几项。");
    await save();
    expect(patchAgent.mock.calls[0][1]).toEqual({ othersLimit: { answers: 8, points: "40" } });
  });
});

describe("the Agent's page", () => {
  const kv = () => document.querySelector(".main-col .kv").textContent;
  const show = async (fields) => {
    await openAgents({ agents: [agentOf(AG1, { model: SITE_MODEL, ...fields })] });
    await click(inList().getByText("小助手", { selector: ".row-name" }));
    return kv();
  };

  it("says its own limit (none by default) and what others used of it today, as the service says them", async () => {
    expect(await show({ othersLimit: { answers: null, points: null }, othersUsedToday: { answers: 0, points: "0" } })).toContain("它自己的上限没有单独设置，和其他 Agent 共用你的每天上限");
    cleanup();
    const text = await show({ othersLimit: { answers: 5, points: "35.5" }, othersUsedToday: { answers: 2, points: "3.5" } });
    expect(text).toContain("它自己的上限每天最多回别人 5 次，最多花 35.5 点");
    expect(text).toContain("别人今天的使用已回 2 次（含主动回复），别人叫它的花了 3.5 点");
    cleanup();
    expect(await show({ othersLimit: { answers: null, points: "70" }, othersUsedToday: { answers: 0, points: "0" } })).toContain("它自己的上限最多花 70 点");
  });

  it("says nothing of them when the service says nothing, and never the old 别人 @ 每天最多花 rows", async () => {
    const text = await show({});
    expect(text).not.toContain("它自己的上限");
    expect(text).not.toContain("别人今天的使用");
    expect(text).not.toContain("别人 @");
    cleanup();
    expect(await show({ othersBudget: "20", othersSpentToday: "3.5" })).not.toContain("别人 @");
  });
});
