// @vitest-environment jsdom
// The Agent pages (list, create, edit, detail, pause, delete) and the "我的 Agent" group of the contacts, over the real
// data layer with the fake transport and fake routes.
import { PRODUCT_NAME } from "../src/brand.js";
import "./markdown-ready.js";
import { readFileSync } from "node:fs";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import {
  A1,
  A2,
  AG1,
  AG2,
  ANN,
  BO,
  D1,
  G1,
  ME_ID,
  MODELS,
  P1,
  PRINCIPALS,
  agentConv,
  agentOf,
  agentPrincipal,
  apiError,
  at,
  deferred,
  direct,
  emptySocial,
  fakeFile,
  group,
  providerOf,
  syncOf,
  usageOf,
  wire,
} from "./fixtures.js";
import { PEOPLE, click, dialog, flush, goContacts, inMain, installBrowser, mainText, openApp, push, rowNames, toastText } from "./harness.jsx";
import { optionsOf, pickOption } from "./select-helpers.js";
import { othersBudgetSent } from "../src/pages/AgentForm.jsx";
import { ModelGoneTag } from "../src/pages/Agents.jsx";
import { StoreProvider, emptyState } from "../src/data/store.jsx";

beforeEach(() => {
  installBrowser();
  let n = 0;
  URL.createObjectURL = vi.fn(() => `blob:preview-${++n}`);
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const PROVIDER = providerOf();
const SITE_MODEL = { source: "site", id: "free-1" };

/** The routes the Agent form reads, answering as the service would; `over` replaces any of them. */
const formApi = (over = {}) => ({
  getModels: vi.fn(async () => MODELS),
  listProviders: vi.fn(async () => ({ providers: [PROVIDER] })),
  getUsage: vi.fn(async () => usageOf()),
  listAgents: vi.fn(() => new Promise(() => {})),
  ...over,
});

const rail = (name) => within(screen.getByRole("navigation", { name: "主导航" })).getByRole("button", { name });
const inList = () => within(document.querySelector(".list-col"));
const goAgents = async () => {
  fireEvent.click(rail(/^Agent/));
  await flush();
};
const openRow = async (name) => click(inList().getByText(name, { selector: ".row-name" }));
const rowOf = (name) => inList().getByText(name, { selector: ".row-name" }).closest("button");

/**
 * The app with my Agents (as `GET /api/agents` answers them) and their conversations, on the Agent page.
 * `models` and `providers` are what the form reads.
 */
async function openAgents({ agents = [], api = {}, models = MODELS, providers = [PROVIDER], social = emptySocial(), extra = [], others = [] } = {}) {
  const principals = [...PRINCIPALS, ...agents.map((a) => agentPrincipal(a.id, a.handle, a.name)), ...others];
  const conversations = [...extra, ...agents.map((a) => agentConv(a.conversationId, a.id, { agent: { paused: a.paused, deleted: a.deleted } }))];
  const sync = () => syncOf(conversations, [], principals);
  const app = await openApp({
    sync,
    social,
    api: formApi({ getModels: vi.fn(async () => models), listProviders: vi.fn(async () => ({ providers })), ...api }),
    handlers: { agents: () => ({ agents }), models: () => models },
  });
  await goAgents();
  return app;
}

const openCreate = async () => {
  await click(inList().getByRole("button", { name: "创建 Agent" }));
};
const type = (label, value) => fireEvent.change(inMain().getByLabelText(label), { target: { value } });
/** The model picker's button (labelled 模型). */
const modelBox = () => inMain().getByLabelText("模型");
/**
 * Opens the picker and chooses the row whose accessible name is `name` — or begins with it: a row reads its name, then
 * its marks (“小模型 · 免费 · 工具”).
 */
const chooseModel = async (name) => {
  if (modelBox().getAttribute("aria-expanded") !== "true") await click(modelBox());
  const option = [...document.querySelectorAll('.model-pop [role="option"]')].find((o) => {
    const label = o.getAttribute("aria-label") ?? "";
    return label === name || label.startsWith(`${name} · `);
  });
  await click(option);
};
const levels = () => optionsOf(inMain().getByLabelText("思考程度")).map(([, text]) => text);
const createButton = () => inMain().getByRole("button", { name: /^创建 Agent$|^创建中…$/ });
const personaBox = () => inMain().getByLabelText("人格文档");
const sectionShown = () => document.querySelector(".rail-item.active").textContent;
/** The open chat's title (before the Agent tag the header puts after an Agent's name). */
const chatTitle = () => document.querySelector(".main-col .chat-head h2").firstChild.textContent;

describe("the Agent list", () => {
  it("lists my Agents with the prototype's row (status tag, field, model); a deleted one last, marked 已删除", async () => {
    const agents = [
      agentOf(AG2, { handle: "cook", name: "厨师", conversationId: A2, deleted: true, field: "做饭", model: SITE_MODEL, createdAt: at(1) }),
      agentOf(AG1, { field: "旅行规划", model: SITE_MODEL, createdAt: at(2) }),
    ];
    await openAgents({ agents });
    expect(document.querySelector(".list-col h1").textContent).toBe("我的 Agent");
    expect(rowNames()).toEqual(["小助手", "厨师"]);
    expect(rowOf("小助手").querySelector(".tag").textContent).toBe("可回复");
    expect(rowOf("小助手").querySelector(".row-preview").textContent).toBe("旅行规划 · 小模型");
    // 小模型 is of no known brand: the generic mark.
    expect(rowOf("小助手").querySelector(".row-preview .lab-logo").dataset.brand).toBe("generic");
    expect(rowOf("厨师").querySelector(".tag").textContent).toBe("已删除");
  });

  it("says how to start when there is none", async () => {
    await openAgents();
    expect(document.querySelector(".list-col .rows-empty").textContent).toBe("还没有 Agent，点右上角的“+”创建一个");
    expect(document.querySelector(".main-col .empty-main").textContent).toBe("选择一个 Agent");
  });

  it("an Agent whose record is not loaded yet shows its row in a neutral state, and never a form", async () => {
    const principals = [...PRINCIPALS, agentPrincipal(AG1)];
    await openApp({
      sync: () => syncOf([agentConv(A1, AG1)], [], principals),
      api: formApi(),
      handlers: { agents: () => new Promise(() => {}), models: () => MODELS },
    });
    await goAgents();
    expect(rowOf("小助手").querySelector(".row-preview").textContent).toBe("正在读取…");
    expect(rowOf("小助手").querySelector(".tag")).toBeNull();
    await openRow("小助手");
    expect(mainText()).toContain("正在读取它的资料…");
    expect(inMain().queryByRole("button", { name: /编辑/ })).toBeNull();
    expect(inMain().queryByRole("button", { name: /暂停/ })).toBeNull();
    expect(inMain().queryByRole("button", { name: /删除/ })).toBeNull();
    expect(document.querySelector(".main-col input, .main-col textarea, .main-col select")).toBeNull();
  });

  it("an Agent without a model says so instead of 可回复", async () => {
    await openAgents({ agents: [agentOf(AG1, { model: null })] });
    expect(rowOf("小助手").querySelector(".tag").textContent).toBe("未选模型");
    expect(rowOf("小助手").querySelector(".row-preview").textContent).toBe("未填写擅长领域 · 未选择模型");
  });

  it("an Agent whose model is gone (modelUsable false) says 这个模型不可用，换一个模型。 by its model on its page; one whose model is there does not", async () => {
    await openAgents({ agents: [agentOf(AG1, { model: SITE_MODEL, modelUsable: false })] });
    await openRow("小助手");
    const modelRow = () => [...document.querySelectorAll(".main-col dt")].find((dt) => dt.textContent === "模型").nextElementSibling;
    expect(modelRow().textContent).toContain("小模型");
    expect(modelRow().textContent).toContain("这个模型不可用，换一个模型。");
    // Nor does it claim 可回复: its tag reads 模型不可用 — in the list as text (the row is a button already), on its page
    // a button that opens where its model is chosen.
    expect(mainText()).not.toContain("可回复");
    expect(rowOf("小助手").querySelector(".tag").textContent).toBe("模型不可用");
    expect(within(rowOf("小助手")).queryByRole("button")).toBeNull();
    const fix = inMain().getByRole("button", { name: "模型不可用，换一个模型" });
    expect(fix.textContent).toBe("模型不可用");
    await click(fix);
    // No quick model switch on this page: the edit form opens, focused on its model field.
    expect(personaBox()).toBeTruthy();
    expect(document.activeElement).toBe(modelBox());
    cleanup();

    await openAgents({ agents: [agentOf(AG1, { model: SITE_MODEL, modelUsable: true })] });
    await openRow("小助手");
    expect(modelRow().textContent).toContain("小模型");
    expect(mainText()).not.toContain("这个模型不可用");
    expect(rowOf("小助手").querySelector(".tag").textContent).toBe("可回复");
    expect(inMain().queryByRole("button", { name: /模型不可用/ })).toBeNull();
  });

  it("a focus on the model field asked for by the tag does not outlive the form it was asked for: no model to choose there, leave, edit again — nothing is focused", async () => {
    const now = { models: { siteModels: [], providerDefaults: MODELS.providerDefaults }, providers: [] };
    await openAgents({
      agents: [agentOf(AG1, { model: SITE_MODEL, modelUsable: false })],
      api: { getModels: vi.fn(async () => now.models), listProviders: vi.fn(async () => ({ providers: now.providers })) },
    });
    await openRow("小助手");
    await click(inMain().getByRole("button", { name: "模型不可用，换一个模型" }));
    // Nothing can be chosen here: the form says so, and no picker is shown to focus.
    expect(mainText()).toContain("还没有可用的模型");
    await click(inMain().getByRole("button", { name: "取消" }));

    now.models = MODELS;
    now.providers = [PROVIDER];
    await click(inMain().getByRole("button", { name: /编辑/ }));
    expect(modelBox()).toBeTruthy();
    expect(document.activeElement).not.toBe(modelBox());
  });

  it("the 模型不可用 tag is the Agent's owner's only: for anyone else nothing of it is rendered — no text, no element", () => {
    const agent = agentOf(AG1, { model: SITE_MODEL, modelUsable: false });
    render(
      <StoreProvider initialState={emptyState()}>
        <span data-testid="mine">
          <ModelGoneTag agent={{ ...agent, mine: true }} />
        </span>
        <span data-testid="theirs">
          <ModelGoneTag agent={{ ...agent, mine: false }} />
        </span>
      </StoreProvider>,
    );
    expect(within(screen.getByTestId("mine")).getByRole("button", { name: "模型不可用，换一个模型" }).textContent).toBe("模型不可用");
    expect(screen.getByTestId("theirs").childNodes).toHaveLength(0);
    expect(screen.getByTestId("theirs").textContent).toBe("");
  });
});

describe("creating an Agent", () => {
  it("with only a name and a site model posts exactly that and lands in its conversation", async () => {
    let app;
    const createAgent = vi.fn(async () => {
      app.env.sync = () => syncOf([agentConv(A1, AG1)], [wire(A1, 1, AG1, "你好，我是 MyBot。")], [...PRINCIPALS, agentPrincipal(AG1, "mybot", "MyBot")]);
      return agentOf(AG1, { handle: "mybot", name: "MyBot", model: SITE_MODEL });
    });
    app = await openAgents({ api: { createAgent } });
    await openCreate();
    type("名称", "  MyBot ");
    expect(inMain().getByLabelText("账号名").value).toBe("mybot");
    await chooseModel("小模型 · 免费");
    await click(createButton());
    expect(createAgent).toHaveBeenCalledTimes(1);
    expect(createAgent.mock.calls[0][0]).toEqual({
      namePart: "mybot",
      name: "MyBot",
      replyMode: "always",
      groupMentions: "members",
      chainBudget: "50",
      othersBudget: "20",
      reasoning: "none",
      model: SITE_MODEL,
    });
    await flush();
    expect(sectionShown()).toContain("消息");
    expect(chatTitle()).toBe("MyBot");
  });

  it("keeps the create button disabled until a model is chosen, and says why", async () => {
    const createAgent = vi.fn();
    await openAgents({ api: { createAgent } });
    await openCreate();
    type("名称", "MyBot");
    expect(createButton().disabled).toBe(true);
    expect(document.querySelector(".main-col .form-actions .reason").textContent).toBe("请先选择一个模型，否则它不会回复");
    await chooseModel("小模型 · 免费");
    expect(createButton().disabled).toBe(false);
    expect(document.querySelector(".main-col .form-actions .reason")).toBeNull();
  });

  it("suggests an account name from an ASCII name, a random one otherwise, and never changes one I typed", async () => {
    await openAgents();
    await openCreate();
    const handleBox = () => inMain().getByLabelText("账号名");
    expect(handleBox().value).toMatch(/^agent_[a-z0-9]{6}$/);
    const random = handleBox().value;
    type("名称", "My Bot 2");
    expect(handleBox().value).toBe("my_bot_2");
    type("名称", "小助手");
    expect(handleBox().value).toBe(random);
    type("名称", "a");
    expect(handleBox().value).toBe(random);
    // A name part may be 2 characters (family names).
    type("名称", "ab");
    expect(handleBox().value).toBe("ab");
    type("账号名", "my_own");
    type("名称", "Different");
    expect(handleBox().value).toBe("my_own");
    expect(mainText()).toContain("创建后不可修改");
  });

  it("checks the fields as the service does, inline, before any request", async () => {
    const createAgent = vi.fn();
    await openAgents({ api: { createAgent } });
    await openCreate();
    await chooseModel("小模型 · 免费");
    type("名称", "   ");
    type("账号名", "No");
    type("简介", "介".repeat(41));
    type("擅长领域", "领".repeat(21));
    fireEvent.change(personaBox(), { target: { value: "人".repeat(20001) } });
    await click(createButton());
    for (const text of ["请填写名称", "账号名为 2 到 24 位小写字母、数字或下划线", "简介不超过 40 个字", "擅长领域不超过 20 个字", "人格文档不超过 20000 个字"]) {
      expect(screen.getByText(text)).toBeTruthy();
    }
    type("名称", "名".repeat(21));
    expect(screen.getByText("名称不超过 20 个字")).toBeTruthy();
    expect(createAgent).not.toHaveBeenCalled();
    expect(inMain().getByLabelText("名称").getAttribute("aria-invalid")).toBe("true");
    expect(mainText()).toContain("20001 / 20000");
  });

  it("sends what was filled in: intro, field, persona (trimmed), reply mode, reasoning, a provider model", async () => {
    const createAgent = vi.fn(async () => agentOf(AG1));
    await openAgents({ api: { createAgent } });
    await openCreate();
    type("名称", "旅行家");
    type("账号名", "traveller");
    type("简介", " 陪你规划旅行 ");
    type("擅长领域", "旅行");
    await chooseModel("gpt-x");
    pickOption(inMain().getByLabelText("思考程度"), "high");
    fireEvent.change(personaBox(), { target: { value: "\n你是一位旅行家。\n" } });
    pickOption(inMain().getByLabelText("私聊回复方式"), "mention");
    await click(createButton());
    expect(createAgent.mock.calls[0][0]).toEqual({
      namePart: "traveller",
      name: "旅行家",
      intro: "陪你规划旅行",
      field: "旅行",
      persona: "你是一位旅行家。",
      replyMode: "mention",
      groupMentions: "members",
      chainBudget: "50",
      othersBudget: "20",
      reasoning: "high",
      model: { source: "provider", providerId: P1, model: "gpt-x" },
    });
  });

  it("handle_taken shows under the account name, not as a toast", async () => {
    const createAgent = vi.fn(async () => {
      throw apiError(409, "handle_taken");
    });
    await openAgents({ api: { createAgent } });
    await openCreate();
    type("名称", "MyBot");
    await chooseModel("小模型 · 免费");
    await click(createButton());
    const handleField = inMain().getByLabelText("账号名").closest(".field");
    expect(handleField.textContent).toContain("你已经有一个用这个账号名的 Agent 了，请换一个。");
    expect(inMain().getByLabelText("账号名").getAttribute("aria-invalid")).toBe("true");
    expect(toastText()).toBeNull();
    expect(sectionShown()).toContain("Agent");
  });

  it("agent_limit shows inline with the tier's limit, not as a toast", async () => {
    const createAgent = vi.fn(async () => {
      throw apiError(403, "agent_limit");
    });
    const getUsage = vi.fn(async () => usageOf({ agentLimit: 20, agentCount: 20 }));
    await openAgents({ api: { createAgent, getUsage } });
    await openCreate();
    type("名称", "MyBot");
    await chooseModel("小模型 · 免费");
    await click(createButton());
    expect(mainText()).toContain("你的 Agent 数量已达到当前档位的上限（最多 20 个）。删除不用的 Agent 后可以再创建。");
    expect(toastText()).toBeNull();
  });

  it("shows a pending state and cannot be sent twice", async () => {
    const pending = deferred();
    const createAgent = vi.fn(() => pending.promise);
    await openAgents({ api: { createAgent } });
    await openCreate();
    type("名称", "MyBot");
    await chooseModel("小模型 · 免费");
    await click(createButton());
    expect(createButton().textContent).toBe("创建中…");
    expect(createButton().disabled).toBe(true);
    fireEvent.submit(createButton().closest("form"));
    await flush();
    expect(createAgent).toHaveBeenCalledTimes(1);
  });

  it("uploads the picked avatar once the Agent exists", async () => {
    let app;
    const order = [];
    const createAgent = vi.fn(async () => {
      order.push("create");
      app.env.sync = () => syncOf([agentConv(A1, AG1)], [], [...PRINCIPALS, agentPrincipal(AG1, "mybot", "MyBot")]);
      return agentOf(AG1, { handle: "mybot", name: "MyBot", model: SITE_MODEL });
    });
    const uploadAgentAvatar = vi.fn(async () => {
      order.push("avatar");
      return { ok: true };
    });
    app = await openAgents({ api: { createAgent, uploadAgentAvatar } });
    await openCreate();
    const file = fakeFile("bot.png", 1000, "image/png");
    fireEvent.change(inMain().getByLabelText("选择头像图片"), { target: { files: [file] } });
    await flush();
    expect(document.querySelector('img[alt="新头像预览"]').getAttribute("src")).toBe("blob:preview-1");
    expect(uploadAgentAvatar).not.toHaveBeenCalled();
    type("名称", "MyBot");
    await chooseModel("小模型 · 免费");
    await click(createButton());
    expect(order).toEqual(["create", "avatar"]);
    expect(uploadAgentAvatar).toHaveBeenCalledWith(AG1, file);
    await flush();
    expect(sectionShown()).toContain("消息");
  });

  it("an avatar that fails to upload leaves the Agent created and says why on its page", async () => {
    let app;
    const createAgent = vi.fn(async () => {
      app.env.sync = () => syncOf([agentConv(A1, AG1)], [], [...PRINCIPALS, agentPrincipal(AG1, "mybot", "MyBot")]);
      return agentOf(AG1, { handle: "mybot", name: "MyBot", model: SITE_MODEL });
    });
    const uploadAgentAvatar = vi.fn(async () => {
      throw apiError(413, "too_large");
    });
    app = await openAgents({ api: { createAgent, uploadAgentAvatar } });
    await openCreate();
    fireEvent.change(inMain().getByLabelText("选择头像图片"), { target: { files: [fakeFile("bot.png", 1000, "image/png")] } });
    await flush();
    type("名称", "MyBot");
    await chooseModel("小模型 · 免费");
    await click(createButton());
    await flush();
    expect(sectionShown()).toContain("Agent");
    expect(document.querySelector(".main-col .profile-head h2").textContent).toContain("MyBot");
    expect(mainText()).toContain("Agent 已创建，但头像没有上传成功：头像不能超过 2 MB。");
    expect(rowNames()).toEqual(["MyBot"]);
  });
});

describe("帮我起草", () => {
  const ready = async (api) => {
    const app = await openAgents({ api });
    await openCreate();
    return app;
  };

  it("is enabled once a name and a model are set; it fills the persona box and sends nothing else", async () => {
    const draftPersona = vi.fn(async () => ({ persona: "你是一位美食助手。" }));
    const createAgent = vi.fn();
    await ready({ draftPersona, createAgent });
    const draft = () => inMain().getByRole("button", { name: /帮我起草|起草中…/ });
    expect(draft().disabled).toBe(true);
    type("名称", "美食家");
    expect(draft().disabled).toBe(true);
    type("简介", "推荐好吃的");
    await chooseModel("小模型 · 免费");
    expect(draft().disabled).toBe(false);
    await click(draft());
    expect(draftPersona).toHaveBeenCalledWith({ name: "美食家", intro: "推荐好吃的", model: SITE_MODEL });
    expect(personaBox().value).toBe("你是一位美食助手。");
    expect(mainText()).toContain("已填入起草的内容，创建后才会生效。");
    expect(createAgent).not.toHaveBeenCalled();
    expect(createButton().disabled).toBe(false);
  });

  it("sits in one row with the persona's character count, the count centred on the button", async () => {
    await ready();
    const row = inMain().getByRole("button", { name: "帮我起草" }).parentElement;
    expect(row.matches(".field > .member-actions")).toBe(true);
    expect(row.textContent).toContain("0 / 20000");
    // jsdom has no layout (e2e/agents.spec.mjs measures it): here, the rule the row relies on.
    const css = readFileSync("src/styles.css", "utf8");
    const rule = css.split("\n").find((line) => line.startsWith(".field > .member-actions {")) ?? "";
    expect(rule).toMatch(/align-items:\s*center/);
  });

  it("asks before replacing text I wrote; cancelling keeps it and sends nothing", async () => {
    const draftPersona = vi.fn(async () => ({ persona: "起草的人格" }));
    await ready({ draftPersona });
    type("名称", "美食家");
    await chooseModel("小模型 · 免费");
    fireEvent.change(personaBox(), { target: { value: "我自己写的" } });
    await click(inMain().getByRole("button", { name: "帮我起草" }));
    expect(dialog().textContent).toContain("起草的内容会替换人格文档里现有的文字。");
    await click(within(dialog()).getByRole("button", { name: "取消" }));
    expect(draftPersona).not.toHaveBeenCalled();
    expect(personaBox().value).toBe("我自己写的");
    await click(inMain().getByRole("button", { name: "帮我起草" }));
    await click(within(dialog()).getByRole("button", { name: "起草并替换" }));
    expect(draftPersona).toHaveBeenCalledTimes(1);
    expect(personaBox().value).toBe("起草的人格");
  });

  it("shows a busy state while drafting and cannot be pressed twice; the box cannot be typed into meanwhile", async () => {
    const pending = deferred();
    const draftPersona = vi.fn(() => pending.promise);
    await ready({ draftPersona });
    type("名称", "美食家");
    await chooseModel("小模型 · 免费");
    await click(inMain().getByRole("button", { name: "帮我起草" }));
    const busy = inMain().getByRole("button", { name: "起草中…" });
    expect(busy.disabled).toBe(true);
    await click(busy);
    expect(draftPersona).toHaveBeenCalledTimes(1);
    expect(personaBox().readOnly).toBe(true);
    await act(async () => pending.resolve({ persona: "好了" }));
    await flush();
    expect(personaBox().value).toBe("好了");
    expect(personaBox().readOnly).toBe(false);
  });

  it("a refusal is said under the persona box, never as a toast", async () => {
    const draftPersona = vi.fn(async () => {
      throw apiError(402, "no_quota", "balance");
    });
    await ready({ draftPersona });
    type("名称", "美食家");
    await chooseModel("大模型 · 需余额");
    await click(inMain().getByRole("button", { name: "帮我起草" }));
    const field = personaBox().closest(".field");
    expect(field.textContent).toContain("余额不足：这个模型需要余额才能使用。");
    expect(toastText()).toBeNull();
    expect(personaBox().value).toBe("");
    draftPersona.mockImplementation(async () => {
      throw apiError(400, "context_too_small");
    });
    await click(inMain().getByRole("button", { name: "帮我起草" }));
    expect(field.textContent).toContain("所选模型的上下文太小，放不下起草所需的内容，请换一个模型。");
    fireEvent.change(personaBox(), { target: { value: "我自己来写" } });
    expect(field.textContent).not.toContain("所选模型的上下文太小");
    expect(field.querySelector('[role="alert"]')).toBeNull();
  });
});

describe("思考程度", () => {
  it("lists only the levels the chosen model allows, and is hidden for a model that allows none", async () => {
    await openAgents();
    await openCreate();
    expect(inMain().queryByLabelText("思考程度")).toBeNull();
    await chooseModel("小模型 · 免费");
    expect(inMain().queryByLabelText("思考程度")).toBeNull();
    await chooseModel("大模型 · 需余额");
    expect(levels()).toEqual(["不思考", "低", "高"]);
    await chooseModel("gpt-x");
    expect(levels()).toEqual(["不思考", "低", "中", "高", "很高", "最高"]);
    pickOption(inMain().getByLabelText("思考程度"), "max");
    await chooseModel("大模型 · 需余额");
    expect(inMain().getByLabelText("思考程度").value).toBe("none");
    await chooseModel("plain");
    expect(inMain().queryByLabelText("思考程度")).toBeNull();
  });

  it("a provider model that lists its reasoningLevels offers 不思考 and those only", async () => {
    const listing = providerOf(undefined, {
      models: [
        { name: "some-levels", vision: false, pdf: false, reasoning: true, contextTokens: 64000, reasoningLevels: ["low", "high", "max"] },
        { name: "all-levels", vision: false, pdf: false, reasoning: true, contextTokens: 64000 },
      ],
    });
    await openAgents({ providers: [listing] });
    await openCreate();
    await chooseModel("some-levels");
    expect(levels()).toEqual(["不思考", "低", "高", "最高"]);
    pickOption(inMain().getByLabelText("思考程度"), "max");
    await chooseModel("all-levels");
    expect(levels()).toEqual(["不思考", "低", "中", "高", "很高", "最高"]);
    expect(inMain().getByLabelText("思考程度").value).toBe("max");
  });
});

describe("no model source at all", () => {
  it("the form says so and leads to Settings › 模型供应商; nothing can be created", async () => {
    const createAgent = vi.fn();
    await openAgents({ api: { createAgent }, models: { siteModels: [], providerDefaults: MODELS.providerDefaults }, providers: [] });
    await openCreate();
    expect(mainText()).toContain("还没有可用的模型");
    expect(inMain().queryByLabelText("模型")).toBeNull();
    type("名称", "MyBot");
    expect(createButton().disabled).toBe(true);
    expect(document.querySelector(".main-col .form-actions .reason").textContent).toBe("还没有可用的模型，需要先添加模型供应商");
    await click(inMain().getByRole("button", { name: "添加模型供应商" }));
    expect(sectionShown()).toContain("设置");
    expect(createAgent).not.toHaveBeenCalled();
  });
});

describe("family names: an Agent's account name hangs under mine (Task N)", () => {
  it("the create form shows my handle as a fixed prefix before the name part, and sends the name part", async () => {
    const createAgent = vi.fn(async () => agentOf(AG1, { handle: "me_one.jarvis", name: "贾维斯" }));
    await openAgents({ api: { createAgent } });
    await openCreate();
    const field = inMain().getByLabelText("账号名").closest(".field");
    expect(field.querySelector(".handle-prefix").textContent).toBe("me_one.");
    expect(field.textContent).toContain("2 到 24 位小写字母、数字或下划线");
    type("名称", "贾维斯");
    type("账号名", "jarvis");
    await chooseModel("小模型 · 免费");
    await click(createButton());
    expect(createAgent.mock.calls[0][0]).toMatchObject({ namePart: "jarvis", name: "贾维斯" });
    expect(createAgent.mock.calls[0][0]).not.toHaveProperty("handle");
  });

  it("the Agent page, its edit form and the list show the full handle; deleting it says the name part is free again", async () => {
    const agent = agentOf(AG1, { handle: "me_one.jarvis", name: "贾维斯", model: SITE_MODEL });
    await openAgents({ agents: [agent] });
    await openRow("贾维斯");
    expect(document.querySelector(".main-col .profile-head").textContent).toContain("@me_one.jarvis · 主人：你");
    await click(inMain().getByRole("button", { name: /删除/ }));
    expect(dialog().textContent).toContain("它不会再回复。账号名 @me_one.jarvis 可以给你的新 Agent 再用。");
    await click(within(dialog()).getByRole("button", { name: "取消" }));
    await click(inMain().getByRole("button", { name: /编辑/ }));
    expect(inMain().queryByLabelText("账号名")).toBeNull();
    // The name part never changes; the part before it is my account name, and follows it.
    expect(mainText()).toContain("me_one.jarvis（名字部分创建后不可修改，前面跟随你的账号名）");
  });
});

describe("editing an Agent", () => {
  const agent = () =>
    agentOf(AG1, { intro: "旧简介", field: "旅行", persona: "你是旅行家。", personaVersion: 1, model: { source: "site", id: "paid-1" }, reasoning: "low" });

  it("opens filled in, sends only what changed, and returns to the detail", async () => {
    const patchAgent = vi.fn(async (_id, patch) => ({ ...agent(), ...patch }));
    await openAgents({ agents: [agent()], api: { patchAgent } });
    await openRow("小助手");
    await click(inMain().getByRole("button", { name: /编辑/ }));
    expect(inMain().getByLabelText("名称").value).toBe("小助手");
    expect(inMain().getByLabelText("简介").value).toBe("旧简介");
    expect(personaBox().value).toBe("你是旅行家。");
    expect(inMain().getByLabelText("思考程度").value).toBe("low");
    expect(inMain().queryByLabelText("账号名")).toBeNull();
    expect(mainText()).toContain("@helper");
    type("简介", "新简介");
    await click(inMain().getByRole("button", { name: "保存" }));
    expect(patchAgent).toHaveBeenCalledWith(AG1, { intro: "新简介" });
    expect(document.querySelector(".main-col .lead").textContent).toBe("新简介");
  });

  it("a changed model is sent with its reasoning level", async () => {
    const patchAgent = vi.fn(async (_id, patch) => ({ ...agent(), ...patch }));
    await openAgents({ agents: [agent()], api: { patchAgent } });
    await openRow("小助手");
    await click(inMain().getByRole("button", { name: /编辑/ }));
    await chooseModel("小模型 · 免费");
    await click(inMain().getByRole("button", { name: "保存" }));
    expect(patchAgent).toHaveBeenCalledWith(AG1, { model: SITE_MODEL, reasoning: "none" });
  });

  it("a refusal stays on the form, inline; an Agent deleted meanwhile is then shown as deleted", async () => {
    const patchAgent = vi.fn(async () => {
      throw apiError(400, "invalid_request");
    });
    const app = await openAgents({ agents: [agent()], api: { patchAgent } });
    app.transport.handlers.agent = () => agent();
    await openRow("小助手");
    await click(inMain().getByRole("button", { name: /编辑/ }));
    type("简介", "新简介");
    await click(inMain().getByRole("button", { name: "保存" }));
    expect(mainText()).toContain("填写的内容有误，或所选模型、思考程度不可用。");
    expect(toastText()).toBeNull();
    expect(inMain().getByLabelText("简介").value).toBe("新简介");

    patchAgent.mockImplementation(async () => {
      throw apiError(409, "agent_deleted");
    });
    app.transport.handlers.agent = () => ({ ...agent(), deleted: true });
    await click(inMain().getByRole("button", { name: "保存" }));
    expect(document.querySelector(".main-col .profile-head h2").textContent).toContain("已删除");
    expect(inMain().queryByRole("button", { name: "保存" })).toBeNull();
    expect(toastText()).toBeNull();
  });

  const CHANGED_ELSEWHERE = "这个 Agent 的配置刚刚在别处有改动，保存会用你这里的内容覆盖你改过的几项。";
  /** The record changes elsewhere while the form is open (another device, a confirmed proposal): an `agent` push. */
  const changeElsewhere = async (app, fields) => {
    app.transport.handlers.agent = () => ({ ...agent(), ...fields });
    await push(app.transport, { type: "agent", id: AG1 });
    await flush();
  };
  const openEdit = async (api = {}) => {
    const app = await openAgents({ agents: [agent()], api });
    await openRow("小助手");
    await click(inMain().getByRole("button", { name: /编辑/ }));
    return app;
  };

  it("a field changed elsewhere that I did not touch shows the new value and is not sent back", async () => {
    const patchAgent = vi.fn(async (_id, patch) => ({ ...agent(), persona: "别处改的人格", personaVersion: 2, ...patch }));
    const app = await openEdit({ patchAgent });
    await changeElsewhere(app, { persona: "别处改的人格", personaVersion: 2 });
    expect(personaBox().value).toBe("别处改的人格");
    type("简介", "新简介");
    expect(mainText()).not.toContain(CHANGED_ELSEWHERE);
    await click(inMain().getByRole("button", { name: "保存" }));
    expect(patchAgent).toHaveBeenCalledTimes(1);
    expect(patchAgent.mock.calls[0][1]).toEqual({ intro: "新简介" });
  });

  it("a field I touched that changes elsewhere keeps my text, says that saving overwrites it, and sends only mine", async () => {
    const patchAgent = vi.fn(async (_id, patch) => ({ ...agent(), ...patch }));
    const app = await openEdit({ patchAgent });
    fireEvent.change(personaBox(), { target: { value: "我改过的人格" } });
    await changeElsewhere(app, { persona: "别处改的人格", personaVersion: 2, intro: "别处改的简介" });
    expect(personaBox().value).toBe("我改过的人格");
    expect(inMain().getByLabelText("简介").value).toBe("别处改的简介");
    expect(mainText()).toContain(CHANGED_ELSEWHERE);
    await click(inMain().getByRole("button", { name: "保存" }));
    expect(patchAgent.mock.calls[0][1]).toEqual({ persona: "我改过的人格" });
  });

  it("a stored reasoning level the model no longer takes is not reset by saving another field", async () => {
    const stale = agentOf(AG1, { intro: "旧简介", model: { source: "site", id: "free-1" }, reasoning: "high" });
    const patchAgent = vi.fn(async (_id, patch) => ({ ...stale, ...patch }));
    await openAgents({ agents: [stale], api: { patchAgent } });
    await openRow("小助手");
    await click(inMain().getByRole("button", { name: /编辑/ }));
    expect(inMain().queryByLabelText("思考程度")).toBeNull();
    type("简介", "新简介");
    await click(inMain().getByRole("button", { name: "保存" }));
    expect(patchAgent.mock.calls[0][1]).toEqual({ intro: "新简介" });
  });

  describe("the avatar", () => {
    const png = () => fakeFile("bot.png", 1000, "image/png");
    const pick = async (file) => {
      fireEvent.change(inMain().getByLabelText("选择头像图片"), { target: { files: [file] } });
      await flush();
    };

    it("is held and sent by 保存, after the other changes; the form has no separate 保存头像", async () => {
      const order = [];
      const patchAgent = vi.fn(async (_id, patch) => {
        order.push("patch");
        return { ...agent(), ...patch };
      });
      const uploadAgentAvatar = vi.fn(async () => {
        order.push("avatar");
        return { ok: true };
      });
      await openEdit({ patchAgent, uploadAgentAvatar });
      const file = png();
      await pick(file);
      expect(document.querySelector('img[alt="新头像预览"]')).toBeTruthy();
      expect(inMain().queryByRole("button", { name: "保存头像" })).toBeNull();
      expect(uploadAgentAvatar).not.toHaveBeenCalled();
      type("简介", "新简介");
      await click(inMain().getByRole("button", { name: "保存" }));
      expect(order).toEqual(["patch", "avatar"]);
      expect(uploadAgentAvatar).toHaveBeenCalledWith(AG1, file);
      expect(document.querySelector(".main-col .lead").textContent).toBe("新简介");
    });

    it("alone, 保存 uploads it without any other request", async () => {
      const patchAgent = vi.fn();
      const uploadAgentAvatar = vi.fn(async () => ({ ok: true }));
      await openEdit({ patchAgent, uploadAgentAvatar });
      await pick(png());
      await click(inMain().getByRole("button", { name: "保存" }));
      expect(uploadAgentAvatar).toHaveBeenCalledTimes(1);
      expect(patchAgent).not.toHaveBeenCalled();
      expect(document.querySelector(".main-col [role=tablist]")).toBeTruthy();
    });

    it("that fails to upload keeps the form, says the rest was saved, and is sent alone when saving again", async () => {
      const patchAgent = vi.fn(async (_id, patch) => ({ ...agent(), ...patch }));
      const uploadAgentAvatar = vi.fn(async () => {
        throw apiError(413, "too_large");
      });
      await openEdit({ patchAgent, uploadAgentAvatar });
      await pick(png());
      type("简介", "新简介");
      await click(inMain().getByRole("button", { name: "保存" }));
      expect(mainText()).toContain("其他修改已保存，但头像没有上传成功：头像不能超过 2 MB。");
      expect(toastText()).toBeNull();
      expect(inMain().getByLabelText("简介").value).toBe("新简介");
      uploadAgentAvatar.mockImplementation(async () => ({ ok: true }));
      await click(inMain().getByRole("button", { name: "保存" }));
      expect(patchAgent).toHaveBeenCalledTimes(1);
      expect(uploadAgentAvatar).toHaveBeenCalledTimes(2);
      expect(document.querySelector(".main-col [role=tablist]")).toBeTruthy();
    });

    it("picked and not saved: 取消 asks once before dropping it", async () => {
      const uploadAgentAvatar = vi.fn();
      await openEdit({ uploadAgentAvatar });
      await pick(png());
      await click(inMain().getByRole("button", { name: "取消" }));
      expect(dialog().textContent).toContain("头像还没有保存，确定放弃吗？");
      await click(within(dialog()).getByRole("button", { name: "继续编辑" }));
      expect(dialog()).toBeNull();
      expect(inMain().getByLabelText("简介")).toBeTruthy();
      await click(inMain().getByRole("button", { name: "取消" }));
      await click(within(dialog()).getByRole("button", { name: "放弃" }));
      expect(document.querySelector(".main-col [role=tablist]")).toBeTruthy();
      expect(uploadAgentAvatar).not.toHaveBeenCalled();
    });

    it("nothing picked, or the pick dropped (不用这张): 取消 leaves at once and nothing is uploaded", async () => {
      const uploadAgentAvatar = vi.fn();
      await openEdit({ uploadAgentAvatar });
      await pick(png());
      await click(inMain().getByRole("button", { name: "不用这张" }));
      expect(document.querySelector('img[alt="新头像预览"]')).toBeNull();
      await click(inMain().getByRole("button", { name: "取消" }));
      expect(dialog()).toBeNull();
      expect(document.querySelector(".main-col [role=tablist]")).toBeTruthy();
      expect(uploadAgentAvatar).not.toHaveBeenCalled();
    });
  });
});

describe("群里谁可以叫它 (groupMentions)", () => {
  const box = () => inMain().getByLabelText("群里谁可以叫它");

  it("creating: 所有群成员 by default, 仅我 sends owner; the hint says the owner pays", async () => {
    const createAgent = vi.fn(async () => agentOf(AG1));
    await openAgents({ api: { createAgent } });
    await openCreate();
    expect(box().value).toBe("members");
    expect(optionsOf(box()).map(([, text]) => text)).toEqual(["所有群成员", "仅我"]);
    expect(box().closest(".field").textContent).toContain("被叫到时它会在群里回复，费用算你的。");
    type("名称", "MyBot");
    pickOption(box(), "owner");
    await chooseModel("小模型 · 免费");
    await click(createButton());
    expect(createAgent.mock.calls[0][0]).toMatchObject({ groupMentions: "owner" });
  });

  it("editing: opens with the stored choice and sends it only when changed; the Agent's page shows it", async () => {
    const record = agentOf(AG1, { model: SITE_MODEL, groupMentions: "owner" });
    const patchAgent = vi.fn(async (_id, patch) => ({ ...record, ...patch }));
    await openAgents({ agents: [record], api: { patchAgent } });
    await openRow("小助手");
    expect(document.querySelector(".main-col .kv").textContent).toContain("群里谁可以叫它仅我");
    await click(inMain().getByRole("button", { name: /编辑/ }));
    expect(box().value).toBe("owner");
    type("简介", "新简介");
    await click(inMain().getByRole("button", { name: "保存" }));
    expect(patchAgent.mock.calls[0][1]).toEqual({ intro: "新简介" });
    await click(inMain().getByRole("button", { name: /编辑/ }));
    pickOption(box(), "members");
    await click(inMain().getByRole("button", { name: "保存" }));
    expect(patchAgent.mock.calls[1][1]).toEqual({ groupMentions: "members" });
    expect(document.querySelector(".main-col .kv").textContent).toContain("群里谁可以叫它所有群成员");
  });
});

describe("别人 @ 每天最多花 (othersBudget)", () => {
  const LABEL = "别人 @ 每天最多花";
  const AMOUNT = "每天最多花（点）";
  const box = () => inMain().getByLabelText(LABEL);
  const amount = () => inMain().getByLabelText(AMOUNT);
  const WARNING = "群里任何人都能让它回复，花的是你的点。";
  const HINT = "群里别人 @ 它所花的点数，每天到了这个数就不再回复他们。你自己 @ 它不受限制。用你自己供应商模型的 Agent 不扣点，这个上限对它不起作用。";
  const WRONG = "请填写 1 到 100000 之间的点数（最多 6 位小数）";
  const kv = () => document.querySelector(".main-col .kv").textContent;
  const mentions = (value) => pickOption(inMain().getByLabelText("群里谁可以叫它"), value);

  it("the value sent: the default, the amount typed, null for 不限 — and none at all for an amount that is not one", () => {
    expect(othersBudgetSent({ othersChoice: "default", othersAmount: "abc" })).toBe("20");
    expect(othersBudgetSent({ othersChoice: "custom", othersAmount: " 035.50 " })).toBe("35.5");
    expect(othersBudgetSent({ othersChoice: "unlimited", othersAmount: "abc" })).toBeNull();
    // Never null, which the service reads as 不限: whatever lets a wrong amount through still sends nothing.
    for (const amount of ["0", "100001", "abc", "", "1.1234567"]) expect(othersBudgetSent({ othersChoice: "custom", othersAmount: amount }), amount).toBeUndefined();
  });

  it("creating: shown only for 所有群成员, with three options, 20 点（默认）first, and what it means; nothing sent for 仅我", async () => {
    const createAgent = vi.fn(async () => agentOf(AG1));
    await openAgents({ api: { createAgent } });
    await openCreate();
    expect(optionsOf(box()).map(([, text]) => text)).toEqual(["20 点（默认）", "自己填", "不限"]);
    expect(box().value).toBe("default");
    expect(document.getElementById(box().getAttribute("aria-describedby"))?.textContent).toBe(HINT);
    // The warning for 不限 comes with the hint, which stays.
    pickOption(box(), "unlimited");
    expect(mainText()).toContain(WARNING);
    expect(box().closest(".field").textContent).toContain(HINT);
    pickOption(box(), "default");
    expect(screen.queryByLabelText(AMOUNT)).toBeNull();
    mentions("owner");
    expect(screen.queryByLabelText(LABEL)).toBeNull();
    type("名称", "MyBot");
    await chooseModel("小模型 · 免费");
    await click(createButton());
    expect(createAgent.mock.calls[0][0]).not.toHaveProperty("othersBudget");
  });

  const createWith = async (choose) => {
    const createAgent = vi.fn(async () => agentOf(AG1));
    await openAgents({ api: { createAgent } });
    await openCreate();
    type("名称", "MyBot");
    await chooseModel("小模型 · 免费");
    choose();
    await click(createButton());
    return createAgent.mock.calls[0][0];
  };

  it("creating: the default sends \"20\"", async () => {
    expect(await createWith(() => {})).toMatchObject({ othersBudget: "20" });
  });

  it("creating: 自己填 sends what I typed as a decimal string", async () => {
    const body = await createWith(() => {
      pickOption(box(), "custom");
      type(AMOUNT, " 035.50 ");
      expect(mainText()).not.toContain(WARNING);
    });
    expect(body.othersBudget).toBe("35.5");
  });

  it("creating: 不限 shows the warning and sends null", async () => {
    const body = await createWith(() => {
      pickOption(box(), "unlimited");
      expect(mainText()).toContain(WARNING);
      expect(screen.queryByLabelText(AMOUNT)).toBeNull();
    });
    expect(body).toHaveProperty("othersBudget", null);
  });

  it("自己填 is refused inline like the chain budget; a wrong amount does not matter once the choice is something else", async () => {
    const createAgent = vi.fn(async () => agentOf(AG1));
    await openAgents({ api: { createAgent } });
    await openCreate();
    type("名称", "MyBot");
    await chooseModel("小模型 · 免费");
    pickOption(box(), "custom");
    for (const value of ["0", "100001", "abc", "", "1.1234567"]) {
      type(AMOUNT, value);
      await click(createButton());
      expect(amount().closest(".field").textContent, value).toContain(WRONG);
      expect(amount().getAttribute("aria-invalid"), value).toBe("true");
    }
    expect(createAgent).not.toHaveBeenCalled();
    type(AMOUNT, "99.999999");
    expect(amount().closest(".field").textContent).not.toContain(WRONG);
    type(AMOUNT, "abc");
    mentions("owner");
    await click(createButton());
    expect(createAgent).toHaveBeenCalledTimes(1);
    expect(createAgent.mock.calls[0][0]).not.toHaveProperty("othersBudget");
  });

  it("editing: \"20\" opens on the default, another number on 自己填, null on 不限", async () => {
    const open = async (extra) => {
      await openAgents({ agents: [agentOf(AG1, { model: SITE_MODEL, ...extra })] });
      await openRow("小助手");
      await click(inMain().getByRole("button", { name: /编辑/ }));
    };
    await open({ othersBudget: "20", othersSpentToday: "0" });
    expect(box().value).toBe("default");
    cleanup();
    await open({ othersBudget: "35", othersSpentToday: "0" });
    expect(box().value).toBe("custom");
    expect(amount().value).toBe("35");
    cleanup();
    await open({ othersBudget: null, othersSpentToday: "0" });
    expect(box().value).toBe("unlimited");
    expect(mainText()).toContain(WARNING);
  });

  it("editing: sent only when it changed, and never while the choice is 仅我", async () => {
    const record = agentOf(AG1, { model: SITE_MODEL, othersBudget: "35", othersSpentToday: "0" });
    const patchAgent = vi.fn(async (_id, patch) => ({ ...record, ...patch }));
    await openAgents({ agents: [record], api: { patchAgent } });
    await openRow("小助手");
    await click(inMain().getByRole("button", { name: /编辑/ }));
    type(AMOUNT, "35.0");
    type("简介", "新简介");
    await click(inMain().getByRole("button", { name: "保存" }));
    expect(patchAgent.mock.calls[0][1]).toEqual({ intro: "新简介" });
    await click(inMain().getByRole("button", { name: /编辑/ }));
    pickOption(box(), "unlimited");
    await click(inMain().getByRole("button", { name: "保存" }));
    expect(patchAgent.mock.calls[1][1]).toEqual({ othersBudget: null });
    await click(inMain().getByRole("button", { name: /编辑/ }));
    pickOption(box(), "default");
    mentions("owner");
    await click(inMain().getByRole("button", { name: "保存" }));
    expect(patchAgent.mock.calls[2][1]).toEqual({ groupMentions: "owner" });
  });

  describe("while the record changes elsewhere", () => {
    const CHANGED_ELSEWHERE = "这个 Agent 的配置刚刚在别处有改动，保存会用你这里的内容覆盖你改过的几项。";
    const record = (fields = {}) => agentOf(AG1, { model: SITE_MODEL, othersBudget: "35", othersSpentToday: "0", ...fields });
    const openEdit = async () => {
      const patchAgent = vi.fn(async (_id, patch) => ({ ...record(), ...patch }));
      const app = await openAgents({ agents: [record()], api: { patchAgent } });
      await openRow("小助手");
      await click(inMain().getByRole("button", { name: /编辑/ }));
      return { app, patchAgent };
    };
    const changeElsewhere = async (app, fields) => {
      app.transport.handlers.agent = () => record(fields);
      await push(app.transport, { type: "agent", id: AG1 });
      await flush();
    };
    const save = () => click(inMain().getByRole("button", { name: "保存" }));

    it("untouched, it shows the new value and is not sent back", async () => {
      const { app, patchAgent } = await openEdit();
      await changeElsewhere(app, { othersBudget: "50" });
      expect([box().value, amount().value]).toEqual(["custom", "50"]);
      await changeElsewhere(app, { othersBudget: null });
      expect(box().value).toBe("unlimited");
      type("简介", "新简介");
      expect(mainText()).not.toContain(CHANGED_ELSEWHERE);
      await save();
      expect(patchAgent.mock.calls.map((c) => c[1])).toEqual([{ intro: "新简介" }]);
    });

    it("the choice I made stays when the amount changes elsewhere: the notice says so, and saving sends mine", async () => {
      const { app, patchAgent } = await openEdit();
      pickOption(box(), "unlimited");
      await changeElsewhere(app, { othersBudget: "50" });
      expect(box().value).toBe("unlimited");
      expect(mainText()).toContain(CHANGED_ELSEWHERE);
      await save();
      expect(patchAgent.mock.calls.map((c) => c[1])).toEqual([{ othersBudget: null }]);
    });

    it("the amount I typed stays when the choice changes elsewhere: the notice says so, and saving sends mine", async () => {
      const { app, patchAgent } = await openEdit();
      type(AMOUNT, "40");
      await changeElsewhere(app, { othersBudget: null });
      expect([box().value, amount().value]).toEqual(["custom", "40"]);
      expect(mainText()).toContain(CHANGED_ELSEWHERE);
      await save();
      expect(patchAgent.mock.calls.map((c) => c[1])).toEqual([{ othersBudget: "40" }]);
    });

    it("my own save coming back says nothing", async () => {
      const { app } = await openEdit();
      pickOption(box(), "unlimited");
      await changeElsewhere(app, { othersBudget: null });
      expect(mainText()).not.toContain(CHANGED_ELSEWHERE);
    });
  });

  it("the Agent's page: today's spend against the budget, the used-up line, or unlimited; nothing for 仅我 or when the service says nothing", async () => {
    const show = async (extra) => {
      await openAgents({ agents: [agentOf(AG1, { model: SITE_MODEL, ...extra })] });
      await openRow("小助手");
      return kv();
    };
    expect(await show({ othersBudget: "20", othersSpentToday: "3.5" })).toContain("别人 @ 每天最多花今天别人 @ 已花 3.5 / 20 点");
    cleanup();
    expect(await show({ othersBudget: "20", othersSpentToday: "20" })).toContain("今天别人 @ 的额度已用完，调高后立即恢复。");
    cleanup();
    expect(await show({ othersBudget: "0.3", othersSpentToday: "0.300000" })).toContain("今天别人 @ 的额度已用完，调高后立即恢复。");
    cleanup();
    expect(await show({ othersBudget: "20.5", othersSpentToday: "20.499999" })).toContain("已花 20.499999 / 20.5 点");
    cleanup();
    expect(await show({ othersBudget: null, othersSpentToday: "3.5" })).toContain("今天别人 @ 已花 3.5 点（不限）");
    cleanup();
    expect(await show({ othersBudget: "20", othersSpentToday: "3.5", groupMentions: "owner" })).not.toContain("别人 @");
    cleanup();
    expect(await show({})).not.toContain("别人 @");
  });
});

describe("一次接话最多花费 (chainBudget, batch 2C)", () => {
  const LABEL = "一次接话最多花费（点）";
  const box = () => inMain().getByLabelText(LABEL);
  const HELP = "两次真人发言之间，它被其他 Agent 叫动所花的点数到了这个数就不再接话。真人 @ 它不受限制。用你自己供应商模型的 Agent 不扣点，这个上限对它不起作用。";
  const WRONG = "请填写 1 到 100000 之间的点数（最多 6 位小数）";
  const kv = () => document.querySelector(".main-col .kv").textContent;

  it("creating: 50 by default, right under 群里谁可以叫它, with what it means; what I type is sent as a decimal string", async () => {
    const createAgent = vi.fn(async () => agentOf(AG1));
    await openAgents({ api: { createAgent } });
    await openCreate();
    expect(box().value).toBe("50");
    expect(box().closest(".field").textContent).toContain(HELP);
    expect(box().closest(".field").previousElementSibling).toBe(inMain().getByLabelText("群里谁可以叫它").closest(".field"));
    type("名称", "MyBot");
    type(LABEL, " 012.50 ");
    await chooseModel("小模型 · 免费");
    await click(createButton());
    expect(createAgent.mock.calls[0][0]).toMatchObject({ chainBudget: "12.5" });
  });

  it("refuses what is not 1–100000 points (up to 6 decimals), inline, before any request", async () => {
    const createAgent = vi.fn(async () => agentOf(AG1));
    await openAgents({ api: { createAgent } });
    await openCreate();
    type("名称", "MyBot");
    await chooseModel("小模型 · 免费");
    for (const value of ["0", "0.5", "100001", "100000.000001", "abc", "", "1e3", "-5", "1.1234567", "１０"]) {
      type(LABEL, value);
      await click(createButton());
      expect(box().closest(".field").textContent, value).toContain(WRONG);
      expect(box().getAttribute("aria-invalid"), value).toBe("true");
    }
    expect(createAgent).not.toHaveBeenCalled();
    for (const value of ["1", "100000", "99.999999"]) {
      type(LABEL, value);
      expect(box().closest(".field").textContent, value).not.toContain(WRONG);
    }
    await click(createButton());
    expect(createAgent.mock.calls[0][0]).toMatchObject({ chainBudget: "99.999999" });
  });

  it("editing: opens with the stored value and sends it only when it changed; the Agent's page shows it", async () => {
    const record = agentOf(AG1, { model: SITE_MODEL, chainBudget: "80" });
    const patchAgent = vi.fn(async (_id, patch) => ({ ...record, ...patch }));
    await openAgents({ agents: [record], api: { patchAgent } });
    await openRow("小助手");
    expect(kv()).toContain("一次接话最多花费80 点");
    await click(inMain().getByRole("button", { name: /编辑/ }));
    expect(box().value).toBe("80");
    type(LABEL, "80.0");
    type("简介", "新简介");
    await click(inMain().getByRole("button", { name: "保存" }));
    expect(patchAgent.mock.calls[0][1]).toEqual({ intro: "新简介" });
    await click(inMain().getByRole("button", { name: /编辑/ }));
    type(LABEL, "100000");
    await click(inMain().getByRole("button", { name: "保存" }));
    expect(patchAgent.mock.calls[1][1]).toEqual({ chainBudget: "100000" });
    expect(kv()).toContain("一次接话最多花费100,000 点");
  });

  it("a record that does not say it reads as the default, 50", async () => {
    await openAgents({ agents: [agentOf(AG1, { model: SITE_MODEL })] });
    await openRow("小助手");
    expect(kv()).toContain("一次接话最多花费50 点");
  });
});

describe("where an Agent replies (batch 2C)", () => {
  const G2 = "00000000-0000-4000-8000-0000000000c4";
  const live = () => agentOf(AG1, { model: SITE_MODEL });

  it("the create form says it replies in its own conversation, and in the groups I bring it to", async () => {
    await openAgents();
    await openCreate();
    expect(mainText()).toContain("它会在专属会话里回复你；你也可以把它拉进你所在的群。");
    expect(mainText()).not.toContain("只在这个会话里回复你");
  });

  it("参与的会话 lists its own conversation and the groups it is in now, each opening its chat", async () => {
    const members = [ME_ID, ANN, AG1].map((id, i) => ({ id, role: "speaker", isCreator: i === 0 }));
    const extra = [group(G1, { members }), group(G2, { title: "另一个群" })];
    await openAgents({ agents: [live()], extra });
    await openRow("小助手");
    await click(inMain().getByRole("tab", { name: "参与的会话" }));
    const items = inMain().getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("Agent 私聊");
    expect(items[1].textContent).toContain("周末小组");
    expect(items[1].textContent).toContain("群聊");
    expect(mainText()).not.toContain("另一个群");
    await click(within(items[1]).getByRole("button", { name: "进入查看" }));
    expect(sectionShown()).toContain("消息");
    expect(chatTitle()).toBe("周末小组");
  });

  it("the line on when it replies in groups follows 群里谁可以叫它", async () => {
    const members = [ME_ID, ANN, AG1].map((id, i) => ({ id, role: "speaker", isCreator: i === 0 }));
    await openAgents({ agents: [agentOf(AG1, { model: SITE_MODEL, groupMentions: "owner" })], extra: [group(G1, { members })] });
    await openRow("小助手");
    await click(inMain().getByRole("tab", { name: "参与的会话" }));
    expect(mainText()).toContain("只有你 @ 它时回复。");
    expect(mainText()).not.toContain("群成员 @ 它时回复");
  });

  it("with 所有群成员 it says 群成员 @ 它时回复", async () => {
    const members = [ME_ID, ANN, AG1].map((id, i) => ({ id, role: "speaker", isCreator: i === 0 }));
    await openAgents({ agents: [agentOf(AG1, { model: SITE_MODEL, groupMentions: "members" })], extra: [group(G1, { members })] });
    await openRow("小助手");
    await click(inMain().getByRole("tab", { name: "参与的会话" }));
    expect(mainText()).toContain("群成员 @ 它时回复。");
  });
});

describe("someone else's Agent (batch 2C)", () => {
  it("in a group I share with its owner is not one of my Agents: not listed here, nor under 我的 Agent", async () => {
    const OAG = "00000000-0000-4000-8000-0000000000b9";
    const annBot = { ...agentPrincipal(OAG, "annbot", "安的助手"), ownerId: ANN, intro: "帮小安记事", field: "记事" };
    const members = [ME_ID, ANN, OAG].map((id, i) => ({ id, role: "speaker", isCreator: i === 0 }));
    const listAgents = vi.fn(async () => ({ agents: [agentOf(AG1, { model: SITE_MODEL })] }));
    await openAgents({
      agents: [agentOf(AG1, { model: SITE_MODEL })],
      extra: [group(G1, { members })],
      others: [annBot],
      social: { ...emptySocial(), friends: [PEOPLE[ANN]] },
      api: { listAgents },
    });
    expect(rowNames()).toEqual(["小助手"]);
    // (Nothing of mine is waiting for its record: the list is not asked for again.)
    expect(listAgents).not.toHaveBeenCalled();
    await goContacts();
    expect(rowNames()).toEqual(["小安", "小助手"]);
  });
});

describe("the model's logo", () => {
  it("shows the brand's mark before a known model's name in the list and on the page", async () => {
    const agents = [agentOf(AG1, { field: "旅行", model: { source: "provider", providerId: P1, model: "gpt-x" } })];
    await openAgents({ agents });
    expect(rowOf("小助手").querySelector(".row-preview .lab-logo").dataset.brand).toBe("openai");
    await openRow("小助手");
    expect(document.querySelector(".main-col .kv .lab-logo").dataset.brand).toBe("openai");
  });
});

describe("the Agent's page", () => {
  const live = () => agentOf(AG1, { intro: "陪你规划旅行", field: "旅行", persona: "你是旅行家。", model: SITE_MODEL });

  it("shows the profile; there is no device tab", async () => {
    await openAgents({ agents: [live()] });
    await openRow("小助手");
    expect(document.querySelector(".main-col .profile-head h2").textContent).toContain("可回复");
    expect(mainText()).toContain("@helper · 主人：你");
    const kv = document.querySelector(".main-col .kv").textContent;
    for (const text of ["你（不可修改）", "旅行", "小模型", "你是旅行家。", "收到消息时回复"]) expect(kv).toContain(text);
    expect(kv).not.toContain("群内回复方式");
    expect(document.querySelector(".main-col .kv .lab-logo").dataset.brand).toBe("generic");
    const tabs = within(inMain().getByRole("tablist", { name: "Agent 分区" })).getAllByRole("tab").map((t) => t.textContent);
    expect(tabs).toEqual(["资料", "参与的会话", "记忆宫殿"]);
    expect(document.querySelector(".main-col input, .main-col select")).toBeNull();
  });

  it("参与的会话 lists its one conversation and opens it", async () => {
    await openAgents({ agents: [live()] });
    await openRow("小助手");
    await click(inMain().getByRole("tab", { name: "参与的会话" }));
    expect(inMain().getAllByRole("listitem")).toHaveLength(1);
    await click(inMain().getByRole("button", { name: "进入查看" }));
    expect(sectionShown()).toContain("消息");
    expect(chatTitle()).toBe("小助手");
  });

  it("pause and resume toggle the tag and call their routes", async () => {
    const pauseAgent = vi.fn(async () => ({ ...live(), paused: true }));
    const resumeAgent = vi.fn(async () => ({ ...live(), paused: false }));
    await openAgents({ agents: [live()], api: { pauseAgent, resumeAgent } });
    await openRow("小助手");
    await click(inMain().getByRole("button", { name: "暂停全部会话" }));
    expect(pauseAgent).toHaveBeenCalledWith(AG1);
    expect(resumeAgent).not.toHaveBeenCalled();
    expect(document.querySelector(".main-col .profile-head h2").textContent).toContain("已暂停全部会话");
    expect(rowOf("小助手").querySelector(".tag").textContent).toBe("已暂停");
    expect(mainText()).toContain("已暂停全部会话：它不会有新回复。");
    await click(inMain().getByRole("button", { name: "恢复全部会话" }));
    expect(resumeAgent).toHaveBeenCalledWith(AG1);
    expect(pauseAgent).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".main-col .profile-head h2").textContent).toContain("可回复");
  });

  it("a refused pause says why", async () => {
    const pauseAgent = vi.fn(async () => {
      throw apiError(409, "agent_deleted");
    });
    await openAgents({ agents: [live()], api: { pauseAgent } });
    await openRow("小助手");
    await click(inMain().getByRole("button", { name: "暂停全部会话" }));
    expect(toastText()).toBe("这个 Agent 已删除。");
  });

  it("delete asks first, then the Agent is listed last as 已删除 and offers no actions; its chat stays reachable", async () => {
    const other = agentOf(AG2, { handle: "cook", name: "厨师", conversationId: A2, model: SITE_MODEL, createdAt: at(5) });
    const deleteAgent = vi.fn(async () => ({ ...live(), deleted: true }));
    await openAgents({ agents: [live(), other], api: { deleteAgent } });
    expect(rowNames()).toEqual(["小助手", "厨师"]);
    await openRow("小助手");
    await click(inMain().getByRole("button", { name: /删除 Agent/ }));
    expect(dialog().textContent).toContain("删除后不可恢复。");
    expect(dialog().textContent).toContain("聊天记录会保留，只能查看。");
    await click(within(dialog()).getByRole("button", { name: "取消" }));
    expect(deleteAgent).not.toHaveBeenCalled();
    await click(inMain().getByRole("button", { name: /删除 Agent/ }));
    await click(within(dialog()).getByRole("button", { name: "确认删除" }));
    expect(deleteAgent).toHaveBeenCalledWith(AG1);
    expect(dialog()).toBeNull();
    expect(rowNames()).toEqual(["厨师", "小助手"]);
    expect(rowOf("小助手").querySelector(".tag").textContent).toBe("已删除");
    expect(document.querySelector(".main-col .profile-head h2").textContent).toContain("已删除");
    for (const name of [/编辑/, /暂停/, /恢复/, /删除 Agent/]) expect(inMain().queryByRole("button", { name })).toBeNull();
    await click(inMain().getByRole("tab", { name: "参与的会话" }));
    await click(inMain().getByRole("button", { name: "进入查看" }));
    expect(chatTitle()).toBe("小助手");
  });
});

describe("contacts: 我的 Agent", () => {
  it("lists my Agents that are not deleted under 我的 Agent, below my friends; a row opens its chat", async () => {
    const agents = [agentOf(AG1, { model: SITE_MODEL }), agentOf(AG2, { handle: "cook", name: "厨师", conversationId: A2, deleted: true })];
    await openAgents({
      agents,
      social: { ...emptySocial(), friends: [PEOPLE[ANN]] },
      extra: [direct(D1, ANN, { lastSeq: 1, readSeq: 1 })],
    });
    await goContacts();
    const labels = [...document.querySelectorAll(".list-col .rows-label")].map((x) => x.textContent);
    expect(labels).toEqual(["好友", "我的 Agent"]);
    expect(rowNames()).toEqual(["小安", "小助手"]);
    const row = rowOf("小助手");
    expect(row.querySelector(".tag").textContent).toBe("Agent");
    expect(row.querySelector(".row-preview").textContent).toBe("@helper");
    expect(document.querySelector(".list-col [role=tablist]")).toBeNull();
    expect(inList().getByRole("button", { name: "添加好友" })).toBeTruthy();
    expect(document.querySelector(".list-col").textContent.replace(PRODUCT_NAME, "").match(/Agent/g)).toHaveLength(2);
    await click(row);
    expect(sectionShown()).toContain("消息");
    expect(chatTitle()).toBe("小助手");
  });

  it("the search box finds my Agents by name or account name", async () => {
    await openAgents({ agents: [agentOf(AG1, { model: SITE_MODEL })], social: { ...emptySocial(), friends: [PEOPLE[ANN]] } });
    await goContacts();
    const box = screen.getByLabelText("搜索联系人的名字或账号");
    fireEvent.change(box, { target: { value: "@help" } });
    expect(rowNames()).toEqual(["小助手"]);
    fireEvent.change(box, { target: { value: "小安" } });
    expect(rowNames()).toEqual(["小安"]);
  });
});

describe("称呼 (how an Agent addresses its owner and others)", () => {
  const OAG = "00000000-0000-4000-8000-0000000000b9";
  const DORA_P = Object.values(PEOPLE).find((p) => p.displayName === "朵拉");
  const FIELD = "它怎么称呼你";
  const ANN_ENTRY = { principalId: ANN, kind: "human", handle: "ann", name: "小安", appellation: "安姐" };
  const BOT_ENTRY = { principalId: OAG, kind: "agent", handle: "annbot", name: "安的助手", appellation: "小助理" };
  const record = (extra = {}) => agentOf(AG1, { model: SITE_MODEL, ownerAppellation: null, appellations: [], ...extra });
  // Me, my Agent, 小安, 阿波 and 小安's Agent in one group; 朵拉 is only a friend of mine.
  const MEMBERS = [ME_ID, AG1, ANN, BO, OAG].map((id, i) => ({ id, role: "speaker", isCreator: i === 0 }));
  const annBot = { ...agentPrincipal(OAG, "annbot", "安的助手"), ownerId: ANN };
  const world = (rec, api = {}, extra = {}) => ({
    agents: [rec],
    extra: [group(G1, { members: MEMBERS })],
    others: [annBot],
    social: { ...emptySocial(), friends: [PEOPLE[ANN], DORA_P] },
    api,
    ...extra,
  });
  const openEdit = async (rec, api = {}, extra = {}) => {
    const app = await openAgents(world(rec, api, extra));
    await openRow("小助手");
    await click(inMain().getByRole("button", { name: /编辑/ }));
    return app;
  };
  const section = () => inMain().getByRole("group", { name: "称呼" });
  const ownerBox = () => inMain().getByLabelText(FIELD);
  const rows = () => [...section().querySelectorAll(".appellation-rows li:not(.rows-empty)")];
  const rowOfName = (name) => rows().find((li) => li.textContent.includes(name));
  const rowInput = (name) => within(rowOfName(name)).getByLabelText(`给${name}的称呼`);
  const save = () => click(inMain().getByRole("button", { name: "保存" }));
  const answering = (rec, extra) => vi.fn(async () => ({ ...rec, ...extra }));

  describe("它怎么称呼你", () => {
    it("the create form shows only this field, with its placeholder and hint, and nothing of the list", async () => {
      await openAgents({});
      await openCreate();
      expect(inMain().getByText("称呼", { selector: "legend, h3, h4" })).toBeTruthy();
      expect(ownerBox().getAttribute("placeholder")).toBe("留空就用你的名字");
      expect(ownerBox().closest(".field").textContent).toContain("最多 20 个字。只影响它怎么叫你，不影响它把谁当主人。");
      expect(mainText()).not.toContain("它怎么称呼别人");
      expect(mainText()).not.toContain("添加称呼");
    });

    it("creating: sent trimmed when filled in, not at all when empty", async () => {
      const createAgent = vi.fn(async () => agentOf(AG1));
      await openAgents({ api: { createAgent } });
      await openCreate();
      type("名称", "MyBot");
      await chooseModel("小模型 · 免费");
      await click(createButton());
      expect(createAgent.mock.calls[0][0]).not.toHaveProperty("ownerAppellation");
      await openCreate();
      type("名称", "MyBot");
      type(FIELD, "  老板  ");
      await chooseModel("小模型 · 免费");
      await click(createButton());
      expect(createAgent.mock.calls[1][0]).toMatchObject({ ownerAppellation: "老板" });
    });

    it("is refused inline above 20 characters (counted as characters, not code units), before any request", async () => {
      const createAgent = vi.fn(async () => agentOf(AG1));
      await openAgents({ api: { createAgent } });
      await openCreate();
      type("名称", "MyBot");
      await chooseModel("小模型 · 免费");
      type(FIELD, "𠮷".repeat(21));
      await click(createButton());
      expect(ownerBox().closest(".field").textContent).toContain("称呼最多 20 个字，不能换行。");
      expect(ownerBox().getAttribute("aria-invalid")).toBe("true");
      expect(createAgent).not.toHaveBeenCalled();
      type(FIELD, `  ${"𠮷".repeat(20)}  `);
      expect(ownerBox().closest(".field").textContent).not.toContain("称呼最多");
      await click(createButton());
      expect(createAgent.mock.calls[0][0]).toMatchObject({ ownerAppellation: "𠮷".repeat(20) });
    });

    it("editing: opens with the stored value; sent only when changed, null when cleared", async () => {
      const rec = record({ ownerAppellation: "老板" });
      const patchAgent = vi.fn(async (_id, patch) => ({ ...rec, ...patch }));
      await openEdit(rec, { patchAgent });
      expect(ownerBox().value).toBe("老板");
      type(FIELD, " 老板 ");
      type("简介", "新简介");
      await save();
      expect(patchAgent.mock.calls[0][1]).toEqual({ intro: "新简介" });
      await click(inMain().getByRole("button", { name: /编辑/ }));
      type(FIELD, "大哥");
      await save();
      expect(patchAgent.mock.calls[1][1]).toEqual({ ownerAppellation: "大哥" });
      await click(inMain().getByRole("button", { name: /编辑/ }));
      type(FIELD, "  ");
      await save();
      expect(patchAgent.mock.calls[2][1]).toEqual({ ownerAppellation: null });
    });

    it("editing with none stored: leaving it empty sends nothing", async () => {
      const patchAgent = vi.fn(async (_id, patch) => ({ ...record(), ...patch }));
      await openEdit(record(), { patchAgent });
      expect(ownerBox().value).toBe("");
      type(FIELD, "   ");
      type("简介", "新简介");
      await save();
      expect(patchAgent.mock.calls[0][1]).toEqual({ intro: "新简介" });
    });

    it("changed elsewhere while I have not touched it shows the new value; one I touched keeps my text and says that saving overwrites it", async () => {
      const rec = record({ ownerAppellation: "老板" });
      const patchAgent = vi.fn(async (_id, patch) => ({ ...rec, ...patch }));
      const app = await openEdit(rec, { patchAgent });
      const elsewhere = async (fields) => {
        app.transport.handlers.agent = () => ({ ...rec, ...fields });
        await push(app.transport, { type: "agent", id: AG1 });
        await flush();
      };
      await elsewhere({ ownerAppellation: "大哥" });
      expect(ownerBox().value).toBe("大哥");
      expect(mainText()).not.toContain("刚刚在别处有改动");
      type(FIELD, "我的叫法");
      await elsewhere({ ownerAppellation: "老大" });
      expect(ownerBox().value).toBe("我的叫法");
      expect(mainText()).toContain("刚刚在别处有改动");
      await save();
      expect(patchAgent.mock.calls[0][1]).toEqual({ ownerAppellation: "我的叫法" });
    });

    it("the Agent's page shows it when set, and no row when not", async () => {
      await openAgents(world(record({ ownerAppellation: "老板" })));
      await openRow("小助手");
      expect(document.querySelector(".main-col .kv").textContent).toContain("它怎么称呼你老板");
      cleanup();
      await openAgents(world(record()));
      await openRow("小助手");
      expect(document.querySelector(".main-col .kv").textContent).not.toContain("它怎么称呼你");
    });
  });

  describe("它怎么称呼别人", () => {
    it("lists each stored entry with name, @handle and an Agent badge for Agents; the Agent's page counts them", async () => {
      const rec = record({ appellations: [ANN_ENTRY, BOT_ENTRY] });
      await openAgents(world(rec));
      await openRow("小助手");
      expect(document.querySelector(".main-col .kv").textContent).toContain("它怎么称呼别人2 个");
      await click(inMain().getByRole("button", { name: /编辑/ }));
      expect(section().textContent).toContain("它怎么称呼别人");
      expect(rows()).toHaveLength(2);
      expect(rowOfName("小安").textContent).toContain("@ann");
      expect(rowOfName("小安").querySelector(".tag")).toBeNull();
      expect(rowInput("小安").value).toBe("安姐");
      expect(rowOfName("安的助手").textContent).toContain("@annbot");
      expect(rowOfName("安的助手").querySelector(".tag").textContent).toBe("Agent");
      expect(rowInput("安的助手").value).toBe("小助理");
      expect(within(rowOfName("小安")).getByRole("button", { name: "移除" })).toBeTruthy();
    });

    it("says so when there is none, and the Agent's page has no such row", async () => {
      await openAgents(world(record()));
      await openRow("小助手");
      expect(document.querySelector(".main-col .kv").textContent).not.toContain("它怎么称呼别人");
      await click(inMain().getByRole("button", { name: /编辑/ }));
      expect(section().textContent).toContain("还没有给别人设称呼。");
      expect(rows()).toHaveLength(0);
    });

    it("an entry whose target is no longer a friend or a member is still listed and can be removed", async () => {
      const GONE = "00000000-0000-4000-8000-0000000000a9";
      const gone = { principalId: GONE, kind: "human", handle: "gone", name: "老朋友", appellation: "老哥" };
      const rec = record({ appellations: [gone] });
      const deleteAppellation = vi.fn(async () => ({ ...rec, appellations: [] }));
      await openEdit(rec, { deleteAppellation });
      expect(rowOfName("老朋友").textContent).toContain("@gone");
      expect(rowInput("老朋友").value).toBe("老哥");
      await click(within(rowOfName("老朋友")).getByRole("button", { name: "移除" }));
      expect(deleteAppellation).toHaveBeenCalledWith(AG1, GONE);
      expect(section().textContent).toContain("还没有给别人设称呼。");
    });

    it("an Agent that is no longer in a group with it (the service gives no name or handle) shows as 已不在同一个群里的 Agent, with no handle, and can still be edited and removed", async () => {
      const GONE_BOT = "00000000-0000-4000-8000-0000000000aa";
      const gone = { principalId: GONE_BOT, kind: "agent", handle: null, name: null, appellation: "老机器人" };
      const rec = record({ appellations: [gone] });
      const putAppellation = vi.fn(async (_id, _pid, body) => ({ ...rec, appellations: [{ ...gone, appellation: body.appellation }] }));
      const deleteAppellation = vi.fn(async () => ({ ...rec, appellations: [] }));
      await openEdit(rec, { putAppellation, deleteAppellation });
      const row = rowOfName("已不在同一个群里的 Agent");
      expect(row.querySelector("strong").textContent).toBe("已不在同一个群里的 Agent");
      expect(row.textContent).not.toContain("@");
      expect(rowInput("已不在同一个群里的 Agent").value).toBe("老机器人");
      fireEvent.change(rowInput("已不在同一个群里的 Agent"), { target: { value: "旧机器人" } });
      fireEvent.blur(rowInput("已不在同一个群里的 Agent"));
      await flush();
      expect(putAppellation).toHaveBeenCalledWith(AG1, GONE_BOT, { appellation: "旧机器人" });
      await click(within(rowOfName("已不在同一个群里的 Agent")).getByRole("button", { name: "移除" }));
      expect(deleteAppellation).toHaveBeenCalledWith(AG1, GONE_BOT);
      expect(section().textContent).toContain("还没有给别人设称呼。");
    });

    it("添加称呼 opens a picker of my friends and the people and Agents of its groups, less itself, me and those listed, sorted by name", async () => {
      const rec = record({ appellations: [BOT_ENTRY] });
      await openEdit(rec);
      expect(inMain().queryByLabelText("选择好友或群成员")).toBeNull();
      await click(inMain().getByRole("button", { name: "添加称呼" }));
      const picker = inMain().getByLabelText("选择好友或群成员");
      // Nothing chosen: the button says what to do; the list holds the people only.
      expect(picker.textContent).toBe("选择好友或群成员");
      // 小安 is both a friend and a member: once. 安的助手 is listed already; 小助手 is the Agent; Mei is me.
      const names = optionsOf(picker).map(([, text]) => text);
      expect(names.slice().sort()).toEqual(["小安 @ann", "朵拉 @dora", "阿波 @bo"].sort());
      expect(names).toEqual(names.slice().sort((a, b) => a.localeCompare(b, "zh")));
      expect(inMain().getByPlaceholderText("称呼")).toBeTruthy();
    });

    it("an Agent not yet listed shows its badge in the picker", async () => {
      await openEdit(record());
      await click(inMain().getByRole("button", { name: "添加称呼" }));
      expect(optionsOf(inMain().getByLabelText("选择好友或群成员")).map(([, text]) => text)).toContain("安的助手 @annbot · Agent");
    });

    it("chosen and named, it is saved by PUT and the list is the view the service answers with", async () => {
      const rec = record();
      const putAppellation = vi.fn(async () => ({ ...rec, appellations: [ANN_ENTRY] }));
      await openEdit(rec, { putAppellation });
      await click(inMain().getByRole("button", { name: "添加称呼" }));
      pickOption(inMain().getByLabelText("选择好友或群成员"), ANN);
      fireEvent.change(inMain().getByPlaceholderText("称呼"), { target: { value: "  安姐  " } });
      await click(inMain().getByRole("button", { name: "保存称呼" }));
      expect(putAppellation).toHaveBeenCalledWith(AG1, ANN, { appellation: "安姐" });
      expect(rows()).toHaveLength(1);
      expect(rowInput("小安").value).toBe("安姐");
      expect(inMain().queryByLabelText("选择好友或群成员")).toBeNull();
    });

    it("does not send an empty or too long appellation: the error is said in the section", async () => {
      const putAppellation = vi.fn(async () => record());
      await openEdit(record(), { putAppellation });
      await click(inMain().getByRole("button", { name: "添加称呼" }));
      pickOption(inMain().getByLabelText("选择好友或群成员"), ANN);
      fireEvent.change(inMain().getByPlaceholderText("称呼"), { target: { value: "字".repeat(21) } });
      await click(inMain().getByRole("button", { name: "保存称呼" }));
      expect(section().textContent).toContain("称呼最多 20 个字，不能换行。");
      expect(putAppellation).not.toHaveBeenCalled();
    });

    it("a stored one is edited in place: saved on blur or Enter when it changed, never when it did not", async () => {
      const rec = record({ appellations: [ANN_ENTRY] });
      const putAppellation = vi.fn(async (_id, _pid, body) => ({ ...rec, appellations: [{ ...ANN_ENTRY, appellation: body.appellation }] }));
      await openEdit(rec, { putAppellation });
      fireEvent.focus(rowInput("小安"));
      fireEvent.blur(rowInput("小安"));
      await flush();
      expect(putAppellation).not.toHaveBeenCalled();
      fireEvent.change(rowInput("小安"), { target: { value: "安安" } });
      fireEvent.blur(rowInput("小安"));
      await flush();
      expect(putAppellation).toHaveBeenCalledTimes(1);
      expect(putAppellation).toHaveBeenLastCalledWith(AG1, ANN, { appellation: "安安" });
      fireEvent.change(rowInput("小安"), { target: { value: " 小安姐 " } });
      fireEvent.keyDown(rowInput("小安"), { key: "Enter" });
      await flush();
      expect(putAppellation).toHaveBeenLastCalledWith(AG1, ANN, { appellation: "小安姐" });
      // Enter here never saves the Agent's form: it is still open.
      expect(inMain().getByRole("button", { name: "保存" })).toBeTruthy();
    });

    it("emptied, a row goes back to what is stored and sends nothing (移除 is how it goes)", async () => {
      const rec = record({ appellations: [ANN_ENTRY] });
      const putAppellation = vi.fn(async () => rec);
      await openEdit(rec, { putAppellation });
      fireEvent.change(rowInput("小安"), { target: { value: "  " } });
      fireEvent.blur(rowInput("小安"));
      await flush();
      expect(putAppellation).not.toHaveBeenCalled();
      expect(rowInput("小安").value).toBe("安姐");
    });

    it("移除 calls DELETE and the list is the view the service answers with", async () => {
      const rec = record({ appellations: [ANN_ENTRY, BOT_ENTRY] });
      const deleteAppellation = vi.fn(async () => ({ ...rec, appellations: [BOT_ENTRY] }));
      await openEdit(rec, { deleteAppellation });
      await click(within(rowOfName("小安")).getByRole("button", { name: "移除" }));
      expect(deleteAppellation).toHaveBeenCalledWith(AG1, ANN);
      expect(rows().map((li) => li.textContent.includes("安的助手"))).toEqual([true]);
    });

    it("移除 that answers 404 (taken back elsewhere already) is as done: no sentence, the Agent is fetched again and the row goes", async () => {
      const rec = record({ appellations: [ANN_ENTRY, BOT_ENTRY] });
      const deleteAppellation = vi.fn(async () => {
        throw apiError(404, "not_found");
      });
      const app = await openEdit(rec, { deleteAppellation });
      const fetched = vi.fn(() => ({ ...rec, appellations: [BOT_ENTRY] }));
      app.transport.handlers.agent = fetched;
      await click(within(rowOfName("小安")).getByRole("button", { name: "移除" }));
      await flush();
      expect(deleteAppellation).toHaveBeenCalledWith(AG1, ANN);
      expect(fetched).toHaveBeenCalled();
      expect(rows().map((li) => li.textContent.includes("安的助手"))).toEqual([true]);
      expect(section().textContent).not.toContain("现在不能给这个人设称呼");
      expect(section().querySelector('[role="alert"]')).toBeNull();
      expect(toastText()).toBeNull();
    });

    it("a refusal is said under its own row: 400, 404 and too_many with their sentences, anything else the generic one", async () => {
      const rec = record({ appellations: [ANN_ENTRY, BOT_ENTRY] });
      const refuse = (status, code) => async () => {
        throw apiError(status, code);
      };
      const putAppellation = vi.fn(refuse(404, "not_found"));
      await openEdit(rec, { putAppellation });
      const say = async (name, text) => {
        fireEvent.change(rowInput(name), { target: { value: `新${name}` } });
        fireEvent.blur(rowInput(name));
        await flush();
        expect(rowOfName(name).textContent).toContain(text);
      };
      await say("小安", "现在不能给这个人设称呼：对方需要是你的好友，或者和它在同一个群里。");
      // Only that row.
      expect(rowOfName("安的助手").textContent).not.toContain("现在不能");
      putAppellation.mockImplementation(refuse(400, "invalid_request"));
      await say("安的助手", "称呼最多 20 个字，不能换行。");
      putAppellation.mockImplementation(refuse(409, "too_many"));
      await say("小安", "一个 Agent 最多设 100 个称呼。");
      putAppellation.mockImplementation(refuse(500, "internal"));
      await say("小安", "操作没有成功，请稍后再试。");
      expect(toastText()).toBeNull();
    });

    it("a refused addition keeps the picker open with the sentence", async () => {
      const putAppellation = vi.fn(async () => {
        throw apiError(409, "too_many");
      });
      await openEdit(record(), { putAppellation });
      await click(inMain().getByRole("button", { name: "添加称呼" }));
      pickOption(inMain().getByLabelText("选择好友或群成员"), ANN);
      fireEvent.change(inMain().getByPlaceholderText("称呼"), { target: { value: "安姐" } });
      await click(inMain().getByRole("button", { name: "保存称呼" }));
      expect(section().textContent).toContain("一个 Agent 最多设 100 个称呼。");
      expect(inMain().getByLabelText("选择好友或群成员")).toBeTruthy();
    });
  });

  describe("keys, Enter, input methods and 移除", () => {
    const add = async (api) => {
      await openEdit(record(), api);
      await click(inMain().getByRole("button", { name: "添加称呼" }));
      pickOption(inMain().getByLabelText("选择好友或群成员"), ANN);
      fireEvent.change(inMain().getByPlaceholderText("称呼"), { target: { value: "安姐" } });
    };

    it("Enter in the add row saves the appellation and neither saves nor leaves the Agent's form", async () => {
      const putAppellation = vi.fn(async () => ({ ...record(), appellations: [ANN_ENTRY] }));
      const patchAgent = vi.fn(async () => record());
      await add({ putAppellation, patchAgent });
      // Its default (submitting the form the row sits in) is prevented: `fireEvent` answers false.
      expect(fireEvent.keyDown(inMain().getByPlaceholderText("称呼"), { key: "Enter" })).toBe(false);
      await flush();
      expect(putAppellation).toHaveBeenCalledWith(AG1, ANN, { appellation: "安姐" });
      expect(patchAgent).not.toHaveBeenCalled();
      expect(inMain().getByRole("button", { name: "保存" })).toBeTruthy();
      expect(rows()).toHaveLength(1);
    });

    it("Enter that confirms an input method's candidate saves nothing, in a row and in the add row", async () => {
      const putAppellation = vi.fn(async () => record());
      await add({ putAppellation });
      fireEvent.keyDown(inMain().getByPlaceholderText("称呼"), { key: "Enter", isComposing: true });
      fireEvent.keyDown(inMain().getByPlaceholderText("称呼"), { key: "Enter", keyCode: 229 });
      await flush();
      expect(putAppellation).not.toHaveBeenCalled();
      cleanup();
      const rec = record({ appellations: [ANN_ENTRY] });
      await openEdit(rec, { putAppellation });
      fireEvent.change(rowInput("小安"), { target: { value: "安安" } });
      fireEvent.keyDown(rowInput("小安"), { key: "Enter", isComposing: true });
      fireEvent.keyDown(rowInput("小安"), { key: "Enter", keyCode: 229 });
      await flush();
      expect(putAppellation).not.toHaveBeenCalled();
    });

    it("移除 on a row with an unsaved edit drops the edit, and the box shows what is stored again: only the DELETE is sent", async () => {
      const rec = record({ appellations: [ANN_ENTRY] });
      const putAppellation = vi.fn(async () => rec);
      const deleteAppellation = vi.fn(async () => {
        throw apiError(500, "internal");
      });
      await openEdit(rec, { putAppellation, deleteAppellation });
      const remove = within(rowOfName("小安")).getByRole("button", { name: "移除" });
      fireEvent.change(rowInput("小安"), { target: { value: "安安" } });
      // Leaving the box for 移除 (by Tab, say): the edit is dropped where it is seen.
      fireEvent.blur(rowInput("小安"), { relatedTarget: remove });
      expect(rowInput("小安").value).toBe("安姐");
      await click(remove);
      expect(putAppellation).not.toHaveBeenCalled();
      expect(deleteAppellation).toHaveBeenCalledWith(AG1, ANN);
      // The removal failed: the row stays, showing what is stored.
      expect(rowInput("小安").value).toBe("安姐");
    });
  });
});

describe("主动参与群聊 (proactive replies)", () => {
  const SWITCH = "主动参与群聊";
  const LEVEL = "话多话少";
  const AMOUNT = "主动回复每天最多花";
  const HELPER = "打开后，群里有人说到它擅长的事，没 @ 它它也可能回复。花的是你的点。";
  const WRONG = "请填写 1 到 100000 之间的点数（最多 6 位小数）";
  const UNAVAILABLE = "现在还不能打开主动参与：站点没有配置判断模型。";
  const LOST = "站点现在没有配置判断模型，主动参与不会生效。可以先关掉。";
  const ON_SITE = { ...MODELS, proactiveAvailable: true };
  const OFF_SITE = { ...MODELS, proactiveAvailable: false };
  const box = () => inMain().getByLabelText(SWITCH);
  const kv = () => document.querySelector(".main-col .kv").textContent;
  const proactive = (fields = {}) => ({ proactive: true, proactiveLevel: "normal", proactiveBudget: "20", proactiveSpentToday: "0", ...fields });
  const save = () => click(inMain().getByRole("button", { name: "保存" }));

  const createOn = async (models, choose = () => {}) => {
    const createAgent = vi.fn(async () => agentOf(AG1));
    await openAgents({ api: { createAgent }, models });
    await openCreate();
    type("名称", "MyBot");
    await chooseModel("小模型 · 免费");
    choose();
    await click(createButton());
    return createAgent;
  };
  const openEditOf = async (fields, models = ON_SITE) => {
    const record = agentOf(AG1, { model: SITE_MODEL, ...fields });
    const patchAgent = vi.fn(async (_id, patch) => ({ ...record, ...patch }));
    const app = await openAgents({ agents: [record], api: { patchAgent }, models });
    // A refusal makes the Agent be fetched again: it is still the record.
    app.transport.handlers.agent = () => record;
    await openRow("小助手");
    await click(inMain().getByRole("button", { name: /编辑/ }));
    return { app, patchAgent, record };
  };

  it("the site has no judgement model: nothing on the form, nothing sent on create or edit", async () => {
    await openAgents({ models: OFF_SITE });
    await openCreate();
    expect(screen.queryByLabelText(SWITCH)).toBeNull();
    cleanup();
    const createAgent = await createOn(OFF_SITE);
    for (const key of ["proactive", "proactiveLevel", "proactiveBudget"]) expect(createAgent.mock.calls[0][0]).not.toHaveProperty(key);
    cleanup();
    const { patchAgent } = await openEditOf(proactive({ proactive: false }), OFF_SITE);
    expect(screen.queryByLabelText(SWITCH)).toBeNull();
    type("简介", "新简介");
    await save();
    expect(patchAgent.mock.calls[0][1]).toEqual({ intro: "新简介" });
  });

  it("before the site's models have answered, an Agent that has it on shows nothing of it — not the switch, not why it would not work", async () => {
    let answer;
    const models = new Promise((resolve) => (answer = resolve));
    await openEditOf(proactive(), models);
    expect(screen.queryByLabelText(SWITCH)).toBeNull();
    expect(mainText()).not.toContain(LOST);
    await act(async () => {
      answer(OFF_SITE);
      await flush();
    });
    expect(box().checked).toBe(true);
    expect(document.getElementById(box().getAttribute("aria-describedby"))?.textContent).toBe(LOST);
  });

  it("the site has lost its judgement model: an Agent that has it on shows the switch alone, saying so, to turn it off — never on", async () => {
    const { patchAgent } = await openEditOf(proactive({ proactiveLevel: "more" }), OFF_SITE);
    expect(box().checked).toBe(true);
    expect(document.getElementById(box().getAttribute("aria-describedby"))?.textContent).toBe(LOST);
    expect(screen.queryByLabelText(LEVEL)).toBeNull();
    expect(screen.queryByLabelText(AMOUNT)).toBeNull();
    // Off and on again: as it was, nothing of it sent.
    fireEvent.click(box());
    fireEvent.click(box());
    type("简介", "新简介");
    await save();
    expect(patchAgent.mock.calls[0][1]).toEqual({ intro: "新简介" });
    // Off: that alone is sent.
    await click(inMain().getByRole("button", { name: /编辑/ }));
    fireEvent.click(box());
    expect(box().checked).toBe(false);
    await save();
    expect(patchAgent.mock.calls[1][1]).toEqual({ proactive: false });
  });

  it("an answer without the flag is read as no judgement model", async () => {
    await openAgents({ models: MODELS });
    await openCreate();
    expect(screen.queryByLabelText(SWITCH)).toBeNull();
  });

  it("creating: the switch is off by default, with its helper; level and amount appear only while it is on", async () => {
    await openAgents({ models: ON_SITE });
    await openCreate();
    expect(box().checked).toBe(false);
    expect(document.getElementById(box().getAttribute("aria-describedby"))?.textContent).toBe(HELPER);
    expect(screen.queryByLabelText(LEVEL)).toBeNull();
    expect(screen.queryByLabelText(AMOUNT)).toBeNull();
    fireEvent.click(box());
    expect(optionsOf(inMain().getByLabelText(LEVEL))).toEqual([
      ["less", "少说"],
      ["normal", "适中"],
      ["more", "多说"],
    ]);
    expect(inMain().getByLabelText(LEVEL).value).toBe("normal");
    expect(inMain().getByLabelText(AMOUNT).value).toBe("20");
    expect(document.getElementById(inMain().getByLabelText(AMOUNT).getAttribute("aria-describedby"))?.textContent).toBe(
      "每天零点（站点时间）重新计算；用完后它当天不再主动接话，被 @ 时照常回复。只对站点的模型有效，用你自己的密钥时不受限。",
    );
    // A typed amount only: no 不限 choice.
    expect(inMain().getByLabelText(AMOUNT).tagName).toBe("INPUT");
    fireEvent.click(box());
    expect(screen.queryByLabelText(LEVEL)).toBeNull();
  });

  it("creating: off sends nothing about it, even after the level or amount was changed and the switch turned off again", async () => {
    const createAgent = await createOn(ON_SITE, () => {
      fireEvent.click(box());
      pickOption(inMain().getByLabelText(LEVEL), "more");
      type(AMOUNT, "abc");
      fireEvent.click(box());
    });
    expect(createAgent).toHaveBeenCalledTimes(1);
    for (const key of ["proactive", "proactiveLevel", "proactiveBudget"]) expect(createAgent.mock.calls[0][0]).not.toHaveProperty(key);
  });

  it("creating: on with the defaults sends proactive, normal and 20", async () => {
    const createAgent = await createOn(ON_SITE, () => fireEvent.click(box()));
    expect(createAgent.mock.calls[0][0]).toMatchObject({ proactive: true, proactiveLevel: "normal", proactiveBudget: "20" });
  });

  it("creating: the level and the amount typed are sent", async () => {
    const createAgent = await createOn(ON_SITE, () => {
      fireEvent.click(box());
      pickOption(inMain().getByLabelText(LEVEL), "less");
      type(AMOUNT, " 035.50 ");
    });
    expect(createAgent.mock.calls[0][0]).toMatchObject({ proactive: true, proactiveLevel: "less", proactiveBudget: "35.5" });
  });

  it("each wrong amount is refused inline like the chain budget, while the switch is on", async () => {
    const createAgent = vi.fn(async () => agentOf(AG1));
    await openAgents({ api: { createAgent }, models: ON_SITE });
    await openCreate();
    type("名称", "MyBot");
    await chooseModel("小模型 · 免费");
    fireEvent.click(box());
    for (const value of ["0", "100001", "abc", "", "1.1234567"]) {
      type(AMOUNT, value);
      await click(createButton());
      expect(inMain().getByLabelText(AMOUNT).closest(".field").textContent, value).toContain(WRONG);
      expect(inMain().getByLabelText(AMOUNT).getAttribute("aria-invalid"), value).toBe("true");
    }
    expect(createAgent).not.toHaveBeenCalled();
    type(AMOUNT, "99.999999");
    expect(inMain().getByLabelText(AMOUNT).closest(".field").textContent).not.toContain(WRONG);
  });

  it("creating: 409 proactive_unavailable is said inline", async () => {
    const createAgent = vi.fn(async () => {
      throw apiError(409, "proactive_unavailable");
    });
    await openAgents({ api: { createAgent }, models: ON_SITE });
    await openCreate();
    type("名称", "MyBot");
    await chooseModel("小模型 · 免费");
    fireEvent.click(box());
    await click(createButton());
    expect(mainText()).toContain(UNAVAILABLE);
    expect(toastText()).toBeNull();
  });

  it("editing: opens on what is stored", async () => {
    await openEditOf(proactive({ proactiveLevel: "more", proactiveBudget: "35" }));
    expect(box().checked).toBe(true);
    expect(inMain().getByLabelText(LEVEL).value).toBe("more");
    expect(inMain().getByLabelText(AMOUNT).value).toBe("35");
    cleanup();
    await openEditOf(proactive({ proactive: false }));
    expect(box().checked).toBe(false);
    expect(screen.queryByLabelText(LEVEL)).toBeNull();
  });

  it("editing: turning it on sends only { proactive: true }", async () => {
    const { patchAgent } = await openEditOf(proactive({ proactive: false }));
    fireEvent.click(box());
    await save();
    expect(patchAgent.mock.calls[0][1]).toEqual({ proactive: true });
  });

  it("editing: only the level, only the level; only the amount, only the amount", async () => {
    const { patchAgent } = await openEditOf(proactive({ proactiveBudget: "35" }));
    pickOption(inMain().getByLabelText(LEVEL), "less");
    await save();
    expect(patchAgent.mock.calls[0][1]).toEqual({ proactiveLevel: "less" });
    await click(inMain().getByRole("button", { name: /编辑/ }));
    type(AMOUNT, "40");
    await save();
    expect(patchAgent.mock.calls[1][1]).toEqual({ proactiveBudget: "40" });
    await click(inMain().getByRole("button", { name: /编辑/ }));
  });

  it("editing: 35.0 against the stored 35 sends nothing", async () => {
    const { patchAgent } = await openEditOf(proactive({ proactiveBudget: "35" }));
    type(AMOUNT, "35.0");
    type("简介", "新简介");
    await save();
    expect(patchAgent.mock.calls[0][1]).toEqual({ intro: "新简介" });
  });

  it("editing: turning it off sends only { proactive: false }, whatever was typed in the amount meanwhile", async () => {
    const { patchAgent } = await openEditOf(proactive());
    type(AMOUNT, "abc");
    fireEvent.click(box());
    await save();
    expect(patchAgent.mock.calls[0][1]).toEqual({ proactive: false });
  });

  it("editing: the site loses its judgement model while the form is open with the switch on: the block goes and nothing about it is sent", async () => {
    let answer = ON_SITE;
    const record = agentOf(AG1, { model: SITE_MODEL, ...proactive({ proactive: false }) });
    const patchAgent = vi.fn(async (_id, patch) => ({ ...record, ...patch }));
    const app = await openAgents({ agents: [record], api: { patchAgent, getModels: vi.fn(async () => answer) }, models: ON_SITE });
    await openRow("小助手");
    await click(inMain().getByRole("button", { name: /编辑/ }));
    fireEvent.click(box());
    pickOption(inMain().getByLabelText(LEVEL), "more");
    answer = OFF_SITE;
    await act(async () => {
      await app.layer.actions.loadModels();
    });
    expect(screen.queryByLabelText(SWITCH)).toBeNull();
    type("简介", "新简介");
    await save();
    expect(patchAgent.mock.calls[0][1]).toEqual({ intro: "新简介" });
  });

  it("editing: 409 proactive_unavailable is said inline", async () => {
    const { patchAgent } = await openEditOf(proactive({ proactive: false }));
    patchAgent.mockImplementation(async () => {
      throw apiError(409, "proactive_unavailable");
    });
    fireEvent.click(box());
    await save();
    expect(mainText()).toContain(UNAVAILABLE);
    expect(toastText()).toBeNull();
    expect(box().checked).toBe(true);
  });

  it("editing: a change made elsewhere to a setting I did not touch shows; one I touched stays, with the notice", async () => {
    const CHANGED = "这个 Agent 的配置刚刚在别处有改动，保存会用你这里的内容覆盖你改过的几项。";
    const { app, patchAgent, record } = await openEditOf(proactive({ proactive: false }));
    const elsewhere = async (fields) => {
      app.transport.handlers.agent = () => ({ ...record, ...fields });
      await push(app.transport, { type: "agent", id: AG1 });
      await flush();
    };
    await elsewhere(proactive({ proactiveLevel: "more" }));
    expect(box().checked).toBe(true);
    expect(inMain().getByLabelText(LEVEL).value).toBe("more");
    expect(mainText()).not.toContain(CHANGED);
    pickOption(inMain().getByLabelText(LEVEL), "less");
    await elsewhere(proactive({ proactiveLevel: "normal" }));
    expect(inMain().getByLabelText(LEVEL).value).toBe("less");
    expect(mainText()).toContain(CHANGED);
    await save();
    expect(patchAgent.mock.calls[0][1]).toEqual({ proactiveLevel: "less" });
  });

  it("the Agent's page: no row while it is off or the service says nothing; spend and budget; the used-up line, compared as numbers", async () => {
    const show = async (extra) => {
      await openAgents({ agents: [agentOf(AG1, { model: SITE_MODEL, ...extra })], models: ON_SITE });
      await openRow("小助手");
      return kv();
    };
    expect(await show({})).not.toContain(SWITCH);
    cleanup();
    expect(await show(proactive({ proactive: false }))).not.toContain(SWITCH);
    cleanup();
    expect(await show(proactive({ proactiveLevel: "less", proactiveSpentToday: "3.5" }))).toContain("主动参与群聊少说 · 今天主动回复已花 3.5 / 20 点");
    cleanup();
    expect(await show(proactive({ proactiveLevel: "more", proactiveBudget: "20.5", proactiveSpentToday: "20.499999" }))).toContain("多说 · 今天主动回复已花 20.499999 / 20.5 点");
    cleanup();
    expect(await show(proactive({ proactiveSpentToday: "20" }))).toContain("主动参与群聊今天主动回复的额度已用完，调高后立即恢复。");
    cleanup();
    expect(await show(proactive({ proactiveBudget: "0.3", proactiveSpentToday: "0.300000" }))).toContain("今天主动回复的额度已用完，调高后立即恢复。");
    cleanup();
    // The budget missing (the service always says it): the level alone.
    expect(await show({ proactive: true, proactiveLevel: "less" })).toContain("主动参与群聊少说");
  });
});

describe("the 记忆 section of the form", () => {
  const MEMORY = "记忆";
  const ASK = "先问我再记";
  const SHARED = "使用共用的“关于我”";
  const HELPER = "它会记住关于你的事和自己学到的事。记忆每天有自己的额度，不占用你聊天的额度。";
  const sw = (label) => inMain().getByLabelText(label);
  const save = () => click(inMain().getByRole("button", { name: "保存" }));
  const openEditOf = async (fields = {}) => {
    const record = agentOf(AG1, { model: SITE_MODEL, ...fields });
    const patchAgent = vi.fn(async (_id, patch) => ({ ...record, ...patch }));
    const app = await openAgents({ agents: [record], api: { patchAgent } });
    app.transport.handlers.agent = () => record;
    await openRow("小助手");
    await click(inMain().getByRole("button", { name: /编辑/ }));
    /** The record changes elsewhere while the form is open (another tab): an `agent` push. */
    const elsewhere = async (changed) => {
      app.transport.handlers.agent = () => ({ ...record, ...changed });
      await push(app.transport, { type: "agent", id: AG1 });
      await flush();
    };
    return { patchAgent, elsewhere };
  };

  it("a 记忆 section after 称呼 has three switches with the helper; a record that says nothing is the service's defaults", async () => {
    await openEditOf();
    const sections = [...document.querySelectorAll(".main-col fieldset legend")].map((l) => l.textContent);
    expect(sections.indexOf("记忆")).toBe(sections.indexOf("称呼") + 1);
    expect(inMain().getByText(HELPER)).toBeTruthy();
    expect(sw(MEMORY).getAttribute("aria-describedby")).toBe(inMain().getByText(HELPER).id);
    expect([sw(MEMORY).checked, sw(ASK).checked, sw(SHARED).checked]).toEqual([true, false, true]);
    for (const label of [MEMORY, ASK, SHARED]) expect(sw(label).getAttribute("role")).toBe("switch");
  });

  it("the switches show the record's values", async () => {
    await openEditOf({ memory: true, memoryAsk: true, sharedNotes: false });
    expect([sw(MEMORY).checked, sw(ASK).checked, sw(SHARED).checked]).toEqual([true, true, false]);
  });

  it("saving without touching them sends none of them", async () => {
    const { patchAgent } = await openEditOf({ memory: true, memoryAsk: false, sharedNotes: true });
    type("名称", "新名字");
    await save();
    expect(patchAgent.mock.calls[0][1]).toEqual({ name: "新名字" });
  });

  it("each switch sends only itself, and one put back as it was sends nothing", async () => {
    const { patchAgent } = await openEditOf();
    fireEvent.click(sw(ASK));
    await save();
    expect(patchAgent.mock.calls[0][1]).toEqual({ memoryAsk: true });
    cleanup();
    const second = await openEditOf();
    fireEvent.click(sw(SHARED));
    await save();
    expect(second.patchAgent.mock.calls[0][1]).toEqual({ sharedNotes: false });
    cleanup();
    const third = await openEditOf();
    fireEvent.click(sw(ASK));
    fireEvent.click(sw(ASK));
    await save();
    expect(third.patchAgent).not.toHaveBeenCalled();
  });

  it("with 记忆 off the other two are disabled; turning it off sends only memory: false", async () => {
    const { patchAgent } = await openEditOf();
    expect([sw(ASK).matches(":disabled"), sw(SHARED).matches(":disabled")]).toEqual([false, false]);
    fireEvent.click(sw(MEMORY));
    expect([sw(ASK).matches(":disabled"), sw(SHARED).matches(":disabled")]).toEqual([true, true]);
    await save();
    expect(patchAgent.mock.calls[0][1]).toEqual({ memory: false });
  });

  describe("turning 记忆 back on for an Agent that had it off", () => {
    const QUESTION = "关掉期间聊过的内容，要不要也让它回顾一下？";
    const ONLY_LATER = "只记以后的";
    const LOOK_BACK = "也回顾一下";
    const question = () => inMain().queryByText(QUESTION);

    it("opens with the other two disabled; turning it on does not turn it on yet: it asks, inline, whether to look back at what was said while it was off", async () => {
      const { patchAgent } = await openEditOf({ memory: false });
      expect(sw(MEMORY).checked).toBe(false);
      expect([sw(ASK).matches(":disabled"), sw(SHARED).matches(":disabled")]).toEqual([true, true]);
      expect(question()).toBeNull();
      fireEvent.click(sw(MEMORY));
      expect(sw(MEMORY).checked).toBe(false);
      expect(question()).toBeTruthy();
      const buttons = within(question().closest(".memory-catch-up")).getAllByRole("button");
      expect(buttons.map((b) => b.textContent)).toEqual([ONLY_LATER, LOOK_BACK]);
      expect(buttons[0].className).toMatch(/primary/);
      expect(patchAgent).not.toHaveBeenCalled();
    });

    it("只记以后的 turns it on at once with catchUp false; 也回顾一下 with catchUp true; the switch is then on and the question gone", async () => {
      for (const [label, catchUp] of [[ONLY_LATER, false], [LOOK_BACK, true]]) {
        const { patchAgent } = await openEditOf({ memory: false });
        fireEvent.click(sw(MEMORY));
        await click(inMain().getByRole("button", { name: label }));
        expect(patchAgent.mock.calls.map((c) => c[1])).toEqual([{ memory: true, catchUp }]);
        expect(sw(MEMORY).checked).toBe(true);
        expect(question()).toBeNull();
        expect([sw(ASK).matches(":disabled"), sw(SHARED).matches(":disabled")]).toEqual([false, false]);
        // Saving afterwards does not send it again.
        await save();
        expect(patchAgent).toHaveBeenCalledTimes(1);
        cleanup();
      }
    });

    it("one decision at a time: while the request is under way both buttons wait; a refusal is said under the question and the switch stays off", async () => {
      const gate = deferred();
      const record = agentOf(AG1, { model: SITE_MODEL, memory: false });
      const patchAgent = vi.fn(() => gate.promise);
      const app = await openAgents({ agents: [record], api: { patchAgent } });
      app.transport.handlers.agent = () => record;
      await openRow("小助手");
      await click(inMain().getByRole("button", { name: /编辑/ }));
      fireEvent.click(sw(MEMORY));
      fireEvent.click(inMain().getByRole("button", { name: ONLY_LATER }));
      await flush();
      const buttons = within(question().closest(".memory-catch-up")).getAllByRole("button");
      expect(buttons.map((b) => b.disabled)).toEqual([true, true]);
      fireEvent.click(buttons[1]);
      expect(patchAgent).toHaveBeenCalledTimes(1);
      gate.reject(apiError(409, "agent_deleted"));
      await flush();
      expect(within(question().closest(".memory-catch-up")).getByRole("alert").textContent).not.toBe("");
      expect(sw(MEMORY).checked).toBe(false);
    });

    it("the question is announced: a polite live region is there, empty, before it asks, and the question is put into that same region", async () => {
      await openEditOf({ memory: false });
      const section = sw(MEMORY).closest("fieldset");
      // Present before anything is said in it (a region that arrives with its text already inside is often not announced).
      const live = within(section).getByRole("status");
      expect(live.textContent).toBe("");
      fireEvent.click(sw(MEMORY));
      expect(within(section).getByRole("status")).toBe(live);
      expect(live.textContent).toBe(QUESTION);
      // Answered or closed, it is emptied again (and so announces the question afresh the next time).
      fireEvent.keyDown(document, { key: "Escape" });
      expect(live.textContent).toBe("");
      expect(within(section).getByRole("status")).toBe(live);
    });

    it("memory turned on elsewhere (another tab) while the question is open: the question closes, the switch follows the record, and a later 保存 does not send memory", async () => {
      const { patchAgent, elsewhere } = await openEditOf({ memory: false });
      fireEvent.click(sw(MEMORY));
      expect(question()).toBeTruthy();
      await elsewhere({ memory: true });
      expect(question()).toBeNull();
      expect(sw(MEMORY).checked).toBe(true);
      type("名称", "新名字");
      await save();
      expect(patchAgent.mock.calls.map((c) => c[1])).toEqual([{ name: "新名字" }]);
    });

    it("记忆 switched off in this form before the record turned it off elsewhere: after 只记以后的 the switch is on, nothing says it changed elsewhere, and 保存 never sends memory again", async () => {
      const { patchAgent, elsewhere } = await openEditOf({ memory: true });
      fireEvent.click(sw(MEMORY));
      await elsewhere({ memory: false });
      // On again: the record says off, so it asks.
      fireEvent.click(sw(MEMORY));
      expect(question()).toBeTruthy();
      await click(inMain().getByRole("button", { name: ONLY_LATER }));
      expect(question()).toBeNull();
      expect(sw(MEMORY).checked).toBe(true);
      expect(mainText()).not.toContain("别处有改动");
      type("名称", "新名字");
      await save();
      expect(patchAgent.mock.calls.map((c) => c[1])).toEqual([{ memory: true, catchUp: false }, { name: "新名字" }]);
    });

    it("Esc, or a press anywhere else, leaves it off and sends nothing", async () => {
      const { patchAgent } = await openEditOf({ memory: false });
      fireEvent.click(sw(MEMORY));
      fireEvent.keyDown(document, { key: "Escape" });
      expect(question()).toBeNull();
      expect(sw(MEMORY).checked).toBe(false);
      fireEvent.click(sw(MEMORY));
      expect(question()).toBeTruthy();
      fireEvent.pointerDown(inMain().getByText(HELPER));
      expect(question()).toBeNull();
      expect(sw(MEMORY).checked).toBe(false);
      await save();
      expect(patchAgent).not.toHaveBeenCalled();
    });

    it("turning it off stays one click, and creating an Agent never asks", async () => {
      const { patchAgent } = await openEditOf({ memory: true });
      fireEvent.click(sw(MEMORY));
      expect(question()).toBeNull();
      await save();
      expect(patchAgent.mock.calls[0][1]).toEqual({ memory: false });
      cleanup();
      await openAgents({ api: { createAgent: vi.fn(async () => agentOf(AG1)) } });
      await openCreate();
      fireEvent.click(sw(MEMORY));
      fireEvent.click(sw(MEMORY));
      expect(question()).toBeNull();
      expect(sw(MEMORY).checked).toBe(true);
    });
  });

  it("creating: the defaults send none of them; a changed one is sent", async () => {
    const createAgent = vi.fn(async () => agentOf(AG1));
    await openAgents({ api: { createAgent } });
    await openCreate();
    type("名称", "MyBot");
    await chooseModel("小模型 · 免费");
    await click(createButton());
    for (const key of ["memory", "memoryAsk", "sharedNotes"]) expect(createAgent.mock.calls[0][0]).not.toHaveProperty(key);
    cleanup();
    const second = vi.fn(async () => agentOf(AG1));
    await openAgents({ api: { createAgent: second } });
    await openCreate();
    type("名称", "MyBot");
    await chooseModel("小模型 · 免费");
    fireEvent.click(sw(ASK));
    fireEvent.click(sw(SHARED));
    await click(createButton());
    expect(second.mock.calls[0][0]).toMatchObject({ memoryAsk: true, sharedNotes: false });
    expect(second.mock.calls[0][0]).not.toHaveProperty("memory");
  });
});

describe("群里没找到时悄悄告诉我", () => {
  const LABEL = "群里没找到时悄悄告诉我";
  const HELPER = "它在别处查到了，会先悄悄问你要不要告诉大家。";
  const sw = () => inMain().getByLabelText(LABEL);
  const save = () => click(inMain().getByRole("button", { name: "保存" }));
  const openEditOf = async (fields = {}) => {
    const record = agentOf(AG1, { model: SITE_MODEL, ...fields });
    const patchAgent = vi.fn(async (_id, patch) => ({ ...record, ...patch }));
    const app = await openAgents({ agents: [record], api: { patchAgent } });
    app.transport.handlers.agent = () => record;
    await openRow("小助手");
    await click(inMain().getByRole("button", { name: /编辑/ }));
    return { patchAgent };
  };

  it("a switch with its helper, on when the record says nothing (the service's default), showing the record's value", async () => {
    await openEditOf();
    expect(sw().getAttribute("role")).toBe("switch");
    expect(sw().checked).toBe(true);
    expect(sw().getAttribute("aria-describedby")).toBe(inMain().getByText(HELPER).id);
    cleanup();
    await openEditOf({ whisperElsewhere: false });
    expect(sw().checked).toBe(false);
  });

  it("editing sends it only when changed; creating sends it only when off", async () => {
    const { patchAgent } = await openEditOf({ whisperElsewhere: true });
    fireEvent.click(sw());
    await save();
    expect(patchAgent.mock.calls[0][1]).toEqual({ whisperElsewhere: false });
    cleanup();
    const createAgent = vi.fn(async () => agentOf(AG1));
    await openAgents({ api: { createAgent } });
    await openCreate();
    type("名称", "MyBot");
    await chooseModel("小模型 · 免费");
    await click(createButton());
    expect(createAgent.mock.calls[0][0]).not.toHaveProperty("whisperElsewhere");
    cleanup();
    const off = vi.fn(async () => agentOf(AG1));
    await openAgents({ api: { createAgent: off } });
    await openCreate();
    type("名称", "MyBot");
    await chooseModel("小模型 · 免费");
    fireEvent.click(sw());
    await click(createButton());
    expect(off.mock.calls[0][0]).toMatchObject({ whisperElsewhere: false });
  });
});
