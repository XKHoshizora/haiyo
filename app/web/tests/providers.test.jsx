// @vitest-environment jsdom
// Settings › 模型供应商: the list, adding and editing a provider (the key sent once and never kept or shown), its
// models with the 高级 disclosure, 同步模型 (choosing from the provider's own list), 测试连接 and deleting one that
// Agents use. Over the real data layer.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { AG1, AG2, MODELS, P1, apiError, deferred, providerOf, syncOf } from "./fixtures.js";
import { click, dialog, flush, inMain, installBrowser, mainText, openApp, toastText } from "./harness.jsx";
import { storedBaseUrl } from "../src/pages/Providers.jsx";
import { draftKeys } from "../src/data/drafts.js";

beforeEach(() => installBrowser());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const P2 = "00000000-0000-4000-8000-0000000000e2";
const KEY = "sk-test-SECRET-key-0123456789";
const NEW_KEY = "sk-another-SECRET-9876";

/** What the service answers for a provider it stored: every model with its flags and a context. */
const stored = (id, body, keyLast4) => ({
  id,
  name: body.name,
  protocol: body.protocol,
  baseUrl: body.baseUrl,
  keyLast4,
  models: (body.models ?? []).map((m) => ({ vision: false, pdf: false, reasoning: false, contextTokens: 16000, ...m })),
});

const rail = (name) => within(screen.getByRole("navigation", { name: "主导航" })).getByRole("button", { name });
const settingsRow = (name) => screen.getByText(name, { selector: ".list-col .row-name" });
const goSettings = async () => {
  fireEvent.click(rail(/^设置/));
  await flush();
};

/** The app on Settings › 模型供应商 with `providers` held by the fake service; `api` replaces any route. */
async function openProviders({ providers = [providerOf()], api = {}, models = MODELS } = {}) {
  const env = { providers: structuredClone(providers) };
  const routes = {
    listProviders: vi.fn(async () => ({ providers: structuredClone(env.providers) })),
    createProvider: vi.fn(async (body) => {
      const p = stored(P2, body, body.apiKey.slice(-4));
      env.providers.push(p);
      return structuredClone(p);
    }),
    patchProvider: vi.fn(async (id, patch) => {
      const at = env.providers.findIndex((p) => p.id === id);
      const { apiKey, ...rest } = patch;
      const next = { ...env.providers[at], ...rest, ...(apiKey ? { keyLast4: apiKey.slice(-4) } : {}) };
      if (rest.models) next.models = stored(id, { models: rest.models }).models;
      env.providers[at] = next;
      return structuredClone(next);
    }),
    deleteProvider: vi.fn(async (id) => {
      env.providers = env.providers.filter((p) => p.id !== id);
      return { ok: true };
    }),
    testProvider: vi.fn(async (_id, model) => (model === undefined ? { ok: true, mode: "list", latencyMs: 400 } : { ok: true, mode: "chat", latencyMs: 812 })),
    listProviderModels: vi.fn(async () => ({ ok: true, listed: [] })),
    ...api,
  };
  const app = await openApp({ sync: () => syncOf([]), api: routes, handlers: { models: () => models } });
  await goSettings();
  await click(settingsRow("模型供应商"));
  return { ...app, env };
}

describe("what the page says of points (fix round 1, I2)", () => {
  const head = () => document.querySelector(".main-col .profile-head .muted").textContent;
  it("while the site offers web search: the model costs no points, but web searches do; otherwise as before", async () => {
    await openProviders({ models: { ...MODELS, webSearchAvailable: true, webSearchPoints: "13" } });
    expect(head()).toBe("在模型服务商那里有账号的话，把它的接口地址和密钥填在这里，你的 Agent 就可以用它的模型回复。用自己的供应商时，模型本身不扣本站的点数，但联网搜索照样扣点。");
    cleanup();
    await openProviders();
    expect(head()).toBe("在模型服务商那里有账号的话，把它的接口地址和密钥填在这里，你的 Agent 就可以用它的模型回复。用自己的供应商不扣本站的点数。");
  });
});

const type = (label, value) => fireEvent.change(inMain().getByLabelText(label), { target: { value } });
const keyBox = () => inMain().getByLabelText("密钥");
const providerRow = (name) => inMain().getByText(name, { selector: ".member-body strong" }).closest("li");
const inRow = (name) => within(providerRow(name));
const modelRow = (name) => within(inMain().getByRole("list", { name: "模型列表" })).getByText(name, { selector: "strong" }).closest("li");
const modelNames = () => [...within(inMain().getByRole("list", { name: "模型列表" })).queryAllByRole("listitem")].map((li) => li.querySelector("strong").textContent);
/** Every argument any route was called with, as one string (to find where a key went). */
const sentAnywhere = (api) =>
  JSON.stringify(
    Object.values(api)
      .filter((fn) => fn?.mock)
      .flatMap((fn) => fn.mock.calls),
  );
const occurrences = (text, part) => text.split(part).length - 1;

// [protocol, typed, stored (null: refused)] — copied as it is from app/service/tests/provider-base-url.test.ts, which
// checks the service's rule (providerBaseUrl) against it: change both together.
const BASE_URL_CASES = [
  ["openai_chat", "https://api.deepseek.com", "https://api.deepseek.com/v1"],
  ["openai_chat", "https://api.deepseek.com/", "https://api.deepseek.com/v1"],
  ["openai_chat", "  https://api.deepseek.com/v1/  ", "https://api.deepseek.com/v1"],
  ["openai_responses", "https://api.openai.com", "https://api.openai.com/v1"],
  ["openai_chat", "https://open.bigmodel.cn/api/paas/v4", "https://open.bigmodel.cn/api/paas/v4"],
  ["openai_chat", "https://ark.cn-beijing.volces.com/api/v3/", "https://ark.cn-beijing.volces.com/api/v3"],
  ["openai_chat", "https://dashscope.aliyuncs.com/compatible-mode/v1", "https://dashscope.aliyuncs.com/compatible-mode/v1"],
  ["openai_chat", "https://example.com/v1/openai", "https://example.com/v1/openai"],
  ["openai_chat", "https://example.com/openai", "https://example.com/openai/v1"],
  ["openai_chat", "https://example.com/v1beta", "https://example.com/v1beta"],
  ["openai_chat", "https://us-central1-aiplatform.googleapis.com/v1beta1/projects/p/locations/l/endpoints/openapi", "https://us-central1-aiplatform.googleapis.com/v1beta1/projects/p/locations/l/endpoints/openapi"],
  ["openai_chat", "https://example.com/v1alpha2", "https://example.com/v1alpha2"],
  ["openai_chat", "https://example.com/v1beta1x/", "https://example.com/v1beta1x/v1"],
  ["openai_chat", "https://example.com/v1_2", "https://example.com/v1_2/v1"],
  ["openai_chat", "https://example.com/version1", "https://example.com/version1/v1"],
  ["openai_chat", "https://example.com/v1x2", "https://example.com/v1x2"],
  ["openai_chat", "https://example.com/V1", "https://example.com/V1/v1"],
  ["anthropic", "https://api.anthropic.com", "https://api.anthropic.com/v1"],
  ["anthropic", "https://api.minimax.io/anthropic", "https://api.minimax.io/anthropic/v1"],
  ["anthropic", "https://api.minimax.io/anthropic/v1", "https://api.minimax.io/anthropic/v1"],
  ["gemini", "https://generativelanguage.googleapis.com", "https://generativelanguage.googleapis.com/v1beta"],
  ["gemini", "https://generativelanguage.googleapis.com/v1", "https://generativelanguage.googleapis.com/v1"],
  ["gemini", "https://generativelanguage.googleapis.com/v1beta/", "https://generativelanguage.googleapis.com/v1beta"],
  ["openai_chat", "https://api.longcat.chat/openai#", "https://api.longcat.chat/openai"],
  ["openai_chat", "https://api.longcat.chat/openai/#", "https://api.longcat.chat/openai"],
  ["gemini", "https://proxy.example.com/google#", "https://proxy.example.com/google"],
  ["anthropic", " https://proxy.example.com/claude# ", "https://proxy.example.com/claude"],
  ["openai_chat", "https://example.com#", "https://example.com"],
  ["openai_chat", "https://example.com/#", "https://example.com"],
  ["openai_chat", "https://API.Example.com:443/v1/?x=1#frag", "https://api.example.com/v1"],
  ["openai_chat", "https://example.com/openai?x=1", "https://example.com/openai/v1"],
  ["openai_chat", "https://example.com:8443/x", "https://example.com:8443/x/v1"],
  ["openai_chat", "https://203.0.113.9", "https://203.0.113.9/v1"],
  ["openai_chat", "http://api.example.com", null],
  ["openai_chat", "https://user:pw@api.example.com", null],
  ["openai_chat", "https://@api.example.com/v1", null],
  ["openai_chat", "https://exa_mple.com/v1", null],
  ["openai_chat", "not a url", null],
  ["openai_chat", "#", null],
  ["openai_chat", "", null],
];

describe("storedBaseUrl (the service's rule, for the preview)", () => {
  it("gives what the service stores, for every case of the shared table", () => {
    for (const [protocol, typed, stored] of BASE_URL_CASES) expect([protocol, typed, storedBaseUrl(protocol, typed)]).toEqual([protocol, typed, stored]);
  });
});

describe("the settings entries", () => {
  it("Settings lists 模型供应商 and 用量与余额; each opens its own section", async () => {
    await openApp({ sync: () => syncOf([]), api: { listProviders: vi.fn(async () => ({ providers: [] })), getUsage: vi.fn(() => new Promise(() => {})) } });
    await goSettings();
    expect([...document.querySelectorAll(".list-col .row-name")].map((x) => x.textContent)).toEqual(["我的资料", "模型供应商", "用量与余额", "记忆宫殿", "拉黑"]);
    await click(settingsRow("模型供应商"));
    expect(document.querySelector(".main-col .profile-head h2").textContent).toBe("模型供应商");
    await click(settingsRow("用量与余额"));
    expect(document.querySelector(".main-col .profile-head h2").textContent).toBe("用量与余额");
    await click(settingsRow("我的资料"));
    expect(document.querySelector(".main-col .profile-head h2").textContent).toBe("我的资料");
  });

  it("the Agent form's 添加模型供应商 lands on this section", async () => {
    const empty = { siteModels: [], providerDefaults: MODELS.providerDefaults };
    await openApp({
      sync: () => syncOf([]),
      api: { getModels: vi.fn(async () => empty), listProviders: vi.fn(async () => ({ providers: [] })), getUsage: vi.fn(async () => ({})) },
      handlers: { models: () => empty },
    });
    fireEvent.click(rail(/^Agent/));
    await flush();
    await click(within(document.querySelector(".list-col")).getByRole("button", { name: "创建 Agent" }));
    await click(inMain().getByRole("button", { name: "添加模型供应商" }));
    expect(document.querySelector(".main-col .profile-head h2").textContent).toBe("模型供应商");
    expect(mainText()).toContain("还没有添加模型供应商");
  });
});

describe("the provider list", () => {
  it("shows each provider's name, interface type, address, the key's last four characters and its models", async () => {
    const second = providerOf(P2, { name: "Gemini", protocol: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", keyLast4: "wxyz", models: [] });
    await openProviders({ providers: [providerOf(), second] });
    const first = providerRow("我的 OpenAI").textContent;
    expect(first).toContain("OpenAI Chat Completions");
    expect(first).toContain("https://api.example.com/v1");
    expect(first).toContain("…abcd");
    expect(first).toContain("3 个模型");
    const gemini = providerRow("Gemini").textContent;
    expect(gemini).toContain("Gemini API");
    expect(gemini).toContain("…wxyz");
    expect(gemini).toContain("还没有模型");
  });

  it("offers no more than 10 providers", async () => {
    const ten = Array.from({ length: 10 }, (_, i) => providerOf(`00000000-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`, { name: `P${i}` }));
    await openProviders({ providers: ten });
    expect(inMain().getByRole("button", { name: /添加供应商/ }).disabled).toBe(true);
    expect(mainText()).toContain("最多只能添加 10 个模型供应商");
  });

  it("says when the list cannot be read, and reads it again on 重试", async () => {
    const listProviders = vi.fn(async () => {
      throw apiError(503, "busy");
    });
    await openProviders({ api: { listProviders } });
    expect(mainText()).toContain("没能读取你的模型供应商");
    listProviders.mockResolvedValueOnce({ providers: [providerOf()] });
    await click(inMain().getByRole("button", { name: "重试" }));
    expect(providerRow("我的 OpenAI")).toBeTruthy();
  });
});

describe("adding a provider", () => {
  const fillNew = async ({ protocol = "anthropic", baseUrl = "https://api.anthropic.com/v1", key = KEY } = {}) => {
    await click(inMain().getByRole("button", { name: /添加供应商/ }));
    type("名称", " 我的 Claude ");
    fireEvent.change(inMain().getByLabelText("接口类型"), { target: { value: protocol } });
    type("接口地址", baseUrl);
    fireEvent.change(keyBox(), { target: { value: key } });
  };

  it("offers the four interface types by their common names, and says the conversations go to the provider", async () => {
    await openProviders({ providers: [] });
    await click(inMain().getByRole("button", { name: /添加供应商/ }));
    const options = within(inMain().getByLabelText("接口类型")).getAllByRole("option");
    expect(options.map((o) => [o.value, o.textContent])).toEqual([
      ["openai_chat", "OpenAI Chat Completions"],
      ["openai_responses", "OpenAI Responses"],
      ["anthropic", "Anthropic Messages"],
      ["gemini", "Gemini API"],
    ]);
    expect(mainText()).toContain("你与它的对话内容，包括发给它的图片和文件，会发送给这个供应商");
    expect(mainText()).toContain("https://");
  });

  it("the privacy notice is inside form.page-body, so it stops at the fields' width", async () => {
    await openProviders({ providers: [] });
    await click(inMain().getByRole("button", { name: /添加供应商/ }));
    const form = inMain().getByLabelText("接口类型").closest("form");
    expect(form.classList.contains("page-body")).toBe(true);
    const notice = [...form.querySelectorAll(".notice")].find((n) => n.textContent.includes("会发送给这个供应商"));
    expect(notice.closest("form.page-body")).toBe(form);
  });

  it("sends the key once, empties the field as soon as the request is sent, and never shows it again", async () => {
    const pending = deferred();
    const createProvider = vi.fn(() => pending.promise);
    const app = await openProviders({ providers: [], api: { createProvider } });
    await fillNew();
    const box = keyBox();
    expect(box.type).toBe("password");
    expect(box.getAttribute("autocomplete")).toBe("new-password");
    // Typed, it lives only in the input: never in an attribute or anywhere else on the page.
    expect(box.value).toBe(KEY);
    expect(document.documentElement.outerHTML).not.toContain(KEY);
    await click(inMain().getByRole("button", { name: "保存并选择模型" }));
    expect(createProvider).toHaveBeenCalledTimes(1);
    expect(createProvider).toHaveBeenCalledWith({
      name: "我的 Claude",
      protocol: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: KEY,
    });
    // Sent: the field is empty before the answer comes.
    expect(keyBox().value).toBe("");
    expect(inMain().getByRole("button", { name: "保存中…" }).disabled).toBe(true);
    await act(async () => pending.resolve(stored(P2, createProvider.mock.calls[0][0], "6789")));
    await flush();
    // Saved: the form now edits the new provider, the key shows as its last four characters only.
    expect(mainText()).toContain("已添加");
    expect(keyBox().value).toBe("");
    expect(mainText()).toContain("…6789");
    expect(document.documentElement.outerHTML).not.toContain(KEY);
    expect(occurrences(sentAnywhere(app.api), KEY)).toBe(1);
    await click(within(dialog()).getByRole("button", { name: "关闭" }));
    await click(inMain().getByRole("button", { name: /返回/ }));
    expect(providerRow("我的 Claude").textContent).toContain("…6789");
    expect(document.documentElement.outerHTML).not.toContain(KEY);
  });

  it("a refusal keeps the form but not the key: it asks for the key again", async () => {
    const createProvider = vi.fn(async () => {
      throw apiError(409, "name_taken");
    });
    await openProviders({ providers: [], api: { createProvider } });
    await fillNew();
    await click(inMain().getByRole("button", { name: "保存并选择模型" }));
    expect(createProvider).toHaveBeenCalledTimes(1);
    expect(screen.getByText("你已经有一个同名的供应商了，请换个名称。")).toBeTruthy();
    expect(inMain().getByLabelText("名称").value).toBe(" 我的 Claude ");
    expect(keyBox().value).toBe("");
    expect(mainText()).toContain("刚才填写的密钥已经清空，请重新填写");
    expect(document.documentElement.outerHTML).not.toContain(KEY);
  });

  it("checks the fields before any request: an https address, a key, a name", async () => {
    const app = await openProviders({ providers: [] });
    await fillNew({ baseUrl: "http://api.example.com/v1", key: "" });
    type("名称", "");
    await click(inMain().getByRole("button", { name: "保存并选择模型" }));
    expect(mainText()).toContain("请填写名称");
    expect(mainText()).toContain("接口地址需要以 https:// 开头");
    expect(mainText()).toContain("请填写密钥");
    type("接口地址", "https://user:pw@api.example.com/v1");
    fireEvent.change(keyBox(), { target: { value: "short" } });
    await click(inMain().getByRole("button", { name: "保存并选择模型" }));
    expect(mainText()).toContain("接口地址里不能包含用户名或密码");
    expect(mainText()).toContain("密钥需要是 8 到 1000 个字符");
    expect(app.api.createProvider).not.toHaveBeenCalled();
  });

  it("under the address, live: where a reply will go (the version added as the service will), and how to keep it as typed", async () => {
    const app = await openProviders({ providers: [] });
    await click(inMain().getByRole("button", { name: /添加供应商/ }));
    const preview = () => inMain().queryByText(/^实际请求地址：/)?.textContent ?? null;
    expect(mainText()).toContain("地址末尾加 # 表示原样使用，不自动补全版本号。");
    expect(preview()).toBeNull();
    type("接口地址", "https://api.deepseek.com/");
    await flush();
    expect(preview()).toBe("实际请求地址：https://api.deepseek.com/v1/chat/completions");
    const as = async (protocol, address, expected) => {
      fireEvent.change(inMain().getByLabelText("接口类型"), { target: { value: protocol } });
      type("接口地址", address);
      await flush();
      expect([protocol, address, preview()]).toEqual([protocol, address, expected]);
    };
    await as("openai_responses", "https://api.openai.com", "实际请求地址：https://api.openai.com/v1/responses");
    await as("anthropic", "https://api.minimax.io/anthropic", "实际请求地址：https://api.minimax.io/anthropic/v1/messages");
    await as("gemini", "https://generativelanguage.googleapis.com", "实际请求地址：https://generativelanguage.googleapis.com/v1beta/models/<模型>:streamGenerateContent");
    await as("openai_chat", "https://open.bigmodel.cn/api/paas/v4", "实际请求地址：https://open.bigmodel.cn/api/paas/v4/chat/completions");
    await as("openai_chat", "https://api.longcat.chat/openai#", "实际请求地址：https://api.longcat.chat/openai/chat/completions");
    // Not an address the service takes: no line, and saving says the address is wrong.
    await as("openai_chat", "https://exa_mple.com/v1", null);
    await as("openai_chat", "http://api.example.com", null);
    type("名称", "x");
    fireEvent.change(keyBox(), { target: { value: KEY } });
    type("接口地址", "https://exa_mple.com/v1");
    await click(inMain().getByRole("button", { name: "保存并选择模型" }));
    expect(mainText()).toContain("接口地址的格式不对");
    expect(app.api.createProvider).not.toHaveBeenCalled();
    // What is sent is what was typed (trimmed): the service applies the rule itself.
    type("接口地址", " https://api.deepseek.com ");
    await click(inMain().getByRole("button", { name: "保存并选择模型" }));
    expect(app.api.createProvider.mock.calls[0][0].baseUrl).toBe("https://api.deepseek.com");
  });

  it("create mode is step one: only the connection fields, one line about models, and 保存并选择模型 (no model controls)", async () => {
    await openProviders({ providers: [] });
    await click(inMain().getByRole("button", { name: /添加供应商/ }));
    for (const label of ["名称", "接口类型", "接口地址", "密钥"]) expect(inMain().getByLabelText(label)).toBeTruthy();
    expect(mainText()).toContain("保存后从供应商的模型列表里挑选模型。");
    expect(mainText()).toContain("你与它的对话内容");
    expect(inMain().getByRole("button", { name: "取消" })).toBeTruthy();
    expect(inMain().getByRole("button", { name: "保存并选择模型" })).toBeTruthy();
    expect(inMain().queryByRole("button", { name: "保存" })).toBeNull();
    expect(inMain().queryByRole("button", { name: "添加模型" })).toBeNull();
    expect(inMain().queryByRole("button", { name: "同步模型" })).toBeNull();
    expect(inMain().queryByLabelText("模型名称")).toBeNull();
    expect(inMain().queryByRole("heading", { name: "模型" })).toBeNull();
    expect(mainText()).not.toContain("还没有模型");
    expect(mainText()).not.toContain("手动添加");
  });

  it("a successful create lands in edit mode with the notice and the 同步模型 dialog open", async () => {
    const listProviderModels = vi.fn(async () => ({ ok: true, listed: [{ name: "m-1", vision: false, pdf: false, reasoning: false, chat: true, known: false, added: false }] }));
    const app = await openProviders({ providers: [], api: { listProviderModels } });
    await fillNew();
    await click(inMain().getByRole("button", { name: "保存并选择模型" }));
    expect(app.api.createProvider.mock.calls[0][0]).not.toHaveProperty("models");
    expect(document.querySelector(".main-col .profile-head h2").textContent).toBe("编辑 我的 Claude");
    expect(mainText()).toContain("已添加。请选择要使用的模型。");
    expect(dialog().querySelector(".modal-head h2").textContent).toBe("我的 Claude 的模型（1）");
    expect(listProviderModels).toHaveBeenCalledWith(P2);
  });

  it("a create followed by a failing list request: the failure and the by-hand sentence are in the dialog, and adding by hand works", async () => {
    const listProviderModels = vi.fn(async () => ({ ok: false, error: "provider_unavailable" }));
    const app = await openProviders({ providers: [], api: { listProviderModels } });
    await fillNew();
    await click(inMain().getByRole("button", { name: "保存并选择模型" }));
    expect(mainText()).toContain("已添加。请选择要使用的模型。");
    expect(within(dialog()).getByRole("alert").textContent).toBe("暂时连不上供应商，或它没有给出可用的回答，请稍后再试。");
    expect(dialog().textContent).toContain("有的供应商不提供模型列表。关闭这个窗口后，可以在下面手动添加模型。");
    await click(within(dialog()).getByRole("button", { name: "完成" }));
    expect(dialog()).toBeNull();
    // Edit mode: the manual path (moved here from the old create form) saves the model.
    type("模型名称", "claude-x");
    await click(inMain().getByRole("button", { name: "添加模型" }));
    expect(modelNames()).toEqual(["claude-x"]);
    await click(inMain().getByRole("button", { name: "保存" }));
    expect(app.api.patchProvider).toHaveBeenCalledWith(P2, { models: [{ name: "claude-x", vision: false, pdf: false, reasoning: false }] });
    expect(toastText()).toBe("供应商已保存");
  });

  it("closing the dialog with no model chosen leaves the edit page saying there is no model yet, with 同步模型 beside it", async () => {
    const listProviderModels = vi.fn(async () => ({ ok: true, listed: [] }));
    await openProviders({ providers: [], api: { listProviderModels } });
    await fillNew();
    await click(inMain().getByRole("button", { name: "保存并选择模型" }));
    await click(within(dialog()).getByRole("button", { name: "关闭" }));
    expect(dialog()).toBeNull();
    expect(mainText()).toContain("还没有模型。Agent 需要至少一个模型才能使用这个供应商。");
    expect(inMain().getAllByRole("button", { name: "同步模型" })).toHaveLength(1);
    await click(inMain().getByRole("button", { name: "同步模型" }));
    expect(dialog()).not.toBeNull();
    expect(listProviderModels).toHaveBeenCalledTimes(2);
  });
});

describe("editing a provider", () => {
  const openEdit = async (options) => {
    const app = await openProviders(options);
    await click(inRow("我的 OpenAI").getByRole("button", { name: "编辑" }));
    return app;
  };

  it("the preview shows the saved address as it is stored (never rewritten); an edited one as the service will store it", async () => {
    await openEdit({ providers: [providerOf(P1, { baseUrl: "https://api.deepseek.com" })] });
    const preview = () => inMain().queryByText(/^实际请求地址：/)?.textContent ?? null;
    expect(preview()).toBe("实际请求地址：https://api.deepseek.com/chat/completions");
    type("接口地址", "https://api.deepseek.com/");
    await flush();
    expect(preview()).toBe("实际请求地址：https://api.deepseek.com/v1/chat/completions");
  });

  it("shows the interface type read-only and the saved key as its last four characters, never filled in", async () => {
    await openEdit();
    expect(inMain().queryByLabelText("接口类型")).toBeNull();
    expect(mainText()).toContain("OpenAI Chat Completions（创建后不可修改）");
    expect(keyBox().value).toBe("");
    expect(mainText()).toContain("…abcd");
  });

  it("without a key the key is left out: only what changed is sent", async () => {
    const app = await openEdit();
    type("名称", "工作用");
    await click(inMain().getByRole("button", { name: "保存" }));
    expect(app.api.patchProvider).toHaveBeenCalledTimes(1);
    expect(app.api.patchProvider).toHaveBeenCalledWith(P1, { name: "工作用" });
    expect(app.api.patchProvider.mock.calls[0][1]).not.toHaveProperty("apiKey");
    expect(toastText()).toBe("供应商已保存");
    expect(providerRow("工作用")).toBeTruthy();
  });

  it("another path on the same address needs no key", async () => {
    const app = await openEdit();
    type("接口地址", "https://API.example.com:443/v2");
    expect(mainText()).not.toContain("接口地址换了域名");
    await click(inMain().getByRole("button", { name: "保存" }));
    expect(app.api.patchProvider).toHaveBeenCalledWith(P1, { baseUrl: "https://API.example.com:443/v2" });
  });

  it("another address needs the key again: it says so and sends nothing until the key is filled in", async () => {
    const app = await openEdit();
    type("接口地址", "https://other.example.com/v1");
    expect(mainText()).toContain("接口地址换了域名，需要重新填写密钥。");
    await click(inMain().getByRole("button", { name: "保存" }));
    expect(app.api.patchProvider).not.toHaveBeenCalled();
    expect(keyBox().getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(keyBox().getAttribute("aria-describedby")).textContent).toBe("接口地址换了域名，需要重新填写密钥。");
    fireEvent.change(keyBox(), { target: { value: NEW_KEY } });
    await click(inMain().getByRole("button", { name: "保存" }));
    expect(app.api.patchProvider).toHaveBeenCalledWith(P1, { baseUrl: "https://other.example.com/v1", apiKey: NEW_KEY });
    expect(document.documentElement.outerHTML).not.toContain(NEW_KEY);
    expect(providerRow("我的 OpenAI").textContent).toContain("…9876");
  });

});

describe("a refused save that carried a new key", () => {
  const KEY_NOT_SAVED = "上次填写的密钥没有保存，请重新填写；如果不想更换，点“保留原密钥”。";
  const save = () => click(inMain().getByRole("button", { name: "保存" }));
  const keyMessage = () => document.getElementById(keyBox().getAttribute("aria-describedby"))?.textContent;
  /** Edits the provider; the first save is refused (busy), the next ones answer as the service would. */
  const openRefusingOnce = async () => {
    const patchProvider = vi.fn(async (_id, patch) => {
      const { apiKey, ...rest } = patch;
      return { ...providerOf(), ...rest, ...(apiKey ? { keyLast4: apiKey.slice(-4) } : {}) };
    });
    patchProvider.mockRejectedValueOnce(apiError(503, "busy"));
    await openProviders({ api: { patchProvider } });
    await click(inRow("我的 OpenAI").getByRole("button", { name: "编辑" }));
    return patchProvider;
  };

  it("key only: the field is emptied once sent; saving again sends nothing and points at the key until it is typed again", async () => {
    // focusInvalid moves the focus on the next frame: here, at once.
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 0;
    });
    const patchProvider = await openRefusingOnce();
    fireEvent.change(keyBox(), { target: { value: NEW_KEY } });
    await save();
    expect(patchProvider).toHaveBeenCalledTimes(1);
    expect(patchProvider).toHaveBeenCalledWith(P1, { apiKey: NEW_KEY });
    expect(keyBox().value).toBe("");
    expect(mainText()).toContain("服务现在有点忙，请稍后再试。");
    expect(keyBox().getAttribute("aria-invalid")).toBe("true");
    expect(keyMessage()).toBe(KEY_NOT_SAVED);
    expect(document.documentElement.outerHTML).not.toContain(NEW_KEY);

    // Saving again: no request, no "saved", still in the form, the key field focused with its message.
    keyBox().blur();
    expect(document.activeElement).not.toBe(keyBox());
    await save();
    expect(patchProvider).toHaveBeenCalledTimes(1);
    expect(toastText()).toBeNull();
    expect(document.activeElement).toBe(keyBox());
    expect(keyMessage()).toBe(KEY_NOT_SAVED);

    fireEvent.change(keyBox(), { target: { value: NEW_KEY } });
    expect(inMain().queryByRole("button", { name: "保留原密钥" })).toBeNull();
    await save();
    expect(patchProvider).toHaveBeenCalledTimes(2);
    expect(patchProvider).toHaveBeenLastCalledWith(P1, { apiKey: NEW_KEY });
    expect(toastText()).toBe("供应商已保存");
    expect(providerRow("我的 OpenAI").textContent).toContain("…9876");
  });

  it("key plus a name change: the same rule; 保留原密钥 saves the other changes without the key", async () => {
    const patchProvider = await openRefusingOnce();
    type("名称", "工作用");
    fireEvent.change(keyBox(), { target: { value: NEW_KEY } });
    await save();
    expect(patchProvider).toHaveBeenCalledWith(P1, { name: "工作用", apiKey: NEW_KEY });
    expect(keyMessage()).toBe(KEY_NOT_SAVED);
    await save();
    expect(patchProvider).toHaveBeenCalledTimes(1);
    expect(toastText()).toBeNull();

    await click(inMain().getByRole("button", { name: "保留原密钥" }));
    expect(keyBox().getAttribute("aria-invalid")).toBeNull();
    expect(mainText()).not.toContain(KEY_NOT_SAVED);
    expect(mainText()).toContain("已保存的密钥：…abcd");
    expect(document.activeElement).toBe(keyBox());
    await save();
    expect(patchProvider).toHaveBeenCalledTimes(2);
    expect(patchProvider).toHaveBeenLastCalledWith(P1, { name: "工作用" });
    expect(patchProvider.mock.calls[1][1]).not.toHaveProperty("apiKey");
    expect(toastText()).toBe("供应商已保存");
    expect(providerRow("工作用").textContent).toContain("…abcd");
  });

  it("保留原密钥 with nothing else changed sends nothing, goes back and says the saved key was kept", async () => {
    const patchProvider = await openRefusingOnce();
    fireEvent.change(keyBox(), { target: { value: NEW_KEY } });
    await save();
    expect(patchProvider).toHaveBeenCalledTimes(1);
    await click(inMain().getByRole("button", { name: "保留原密钥" }));
    await save();
    expect(patchProvider).toHaveBeenCalledTimes(1);
    expect(toastText()).toBe("没有改动，原来的密钥保持不变");
    expect(providerRow("我的 OpenAI").textContent).toContain("…abcd");
  });

  it("a form with nothing changed (no key refused) still goes back quietly", async () => {
    const patchProvider = await openRefusingOnce();
    await save();
    expect(patchProvider).not.toHaveBeenCalled();
    expect(toastText()).toBeNull();
    expect(providerRow("我的 OpenAI").textContent).toContain("…abcd");
  });

  it("an address on another origin still needs the key: 保留原密钥 is not offered", async () => {
    const patchProvider = await openRefusingOnce();
    type("接口地址", "https://other.example.com/v1");
    fireEvent.change(keyBox(), { target: { value: NEW_KEY } });
    await save();
    expect(patchProvider).toHaveBeenCalledTimes(1);
    expect(keyMessage()).toBe("接口地址换了域名，需要重新填写密钥。");
    expect(inMain().queryByRole("button", { name: "保留原密钥" })).toBeNull();
    await save();
    expect(patchProvider).toHaveBeenCalledTimes(1);
  });
});

describe("a connection test result never outlives what it tested", () => {
  /** What the form's 测试连接 shows under its button (a refusal notice elsewhere in the form is not it). */
  const result = () => inMain().getByRole("button", { name: /测试/ }).closest(".field").querySelector('[role="status"], [role="alert"]');
  const openTested = async () => {
    await openProviders();
    await click(inRow("我的 OpenAI").getByRole("button", { name: "编辑" }));
    await click(inMain().getByRole("button", { name: "测试连接" }));
    expect(result().textContent).toBe("用 gpt-x 发了一句话，用时 0.8 秒");
  };

  it("is cleared when the address is edited", async () => {
    await openTested();
    type("接口地址", "https://api.example.com/v2");
    await flush();
    expect(result()).toBeNull();
  });

  it("is cleared when the key is edited", async () => {
    await openTested();
    fireEvent.change(keyBox(), { target: { value: NEW_KEY } });
    await flush();
    expect(result()).toBeNull();
  });

  it("is cleared when the provider is saved, also when that save is refused", async () => {
    const patchProvider = vi.fn(async () => {
      throw apiError(503, "busy");
    });
    await openProviders({ api: { patchProvider } });
    await click(inRow("我的 OpenAI").getByRole("button", { name: "编辑" }));
    await click(inMain().getByRole("button", { name: "测试连接" }));
    expect(result().textContent).toBe("用 gpt-x 发了一句话，用时 0.8 秒");
    type("名称", "工作用");
    await click(inMain().getByRole("button", { name: "保存" }));
    expect(patchProvider).toHaveBeenCalledTimes(1);
    expect(result()).toBeNull();
  });

  it("an answer that arrives after the address was edited is not shown", async () => {
    const pending = deferred();
    await openProviders({ api: { testProvider: vi.fn(() => pending.promise) } });
    await click(inRow("我的 OpenAI").getByRole("button", { name: "编辑" }));
    await click(inMain().getByRole("button", { name: "测试连接" }));
    type("接口地址", "https://api.example.com/v2");
    await act(async () => pending.resolve({ ok: true }));
    await flush();
    expect(result()).toBeNull();
  });
});

describe("the models of a provider", () => {
  it("adds and removes models; 高级 sets what each can do and its context; only the changed list is sent", async () => {
    const app = await openProviders();
    await click(inRow("我的 OpenAI").getByRole("button", { name: "编辑" }));
    expect(modelNames()).toEqual(["gpt-x", "plain", "tiny"]);
    expect(modelRow("tiny").textContent).toContain("上下文太小");
    // A model whose brand is known (gpt-x) shows its mark before the name; one that is not (plain) the generic mark.
    expect(modelRow("gpt-x").querySelector("strong .lab-logo").dataset.brand).toBe("openai");
    expect(modelRow("plain").querySelector("strong .lab-logo").dataset.brand).toBe("generic");
    await click(within(modelRow("tiny")).getByRole("button", { name: /移除/ }));
    type("模型名称", "  vision-1 ");
    fireEvent.keyDown(inMain().getByLabelText("模型名称"), { key: "Enter" });
    await flush();
    expect(modelNames()).toEqual(["gpt-x", "plain", "vision-1"]);
    expect(inMain().getByLabelText("模型名称").value).toBe("");
    type("模型名称", "plain");
    await click(inMain().getByRole("button", { name: "添加模型" }));
    expect(mainText()).toContain("列表里已经有这个模型了");

    const advanced = within(modelRow("vision-1")).getByRole("button", { name: /高级/ });
    expect(advanced.getAttribute("aria-expanded")).toBe("false");
    await click(advanced);
    expect(advanced.getAttribute("aria-expanded")).toBe("true");
    const panel = within(modelRow("vision-1"));
    // The output limit every call gets, from /api/models: a context not above it cannot be used.
    expect(modelRow("vision-1").textContent).toContain("2,048");
    fireEvent.click(panel.getByLabelText(/能看图片/));
    fireEvent.click(panel.getByLabelText(/能直接读 PDF/));
    fireEvent.change(panel.getByLabelText("上下文容量"), { target: { value: "500" } });
    await click(inMain().getByRole("button", { name: "保存" }));
    expect(app.api.patchProvider).not.toHaveBeenCalled();
    expect(mainText()).toContain("上下文容量需要是 1000 到 2000000 之间的整数");
    fireEvent.change(panel.getByLabelText("上下文容量"), { target: { value: "128,000" } });
    await click(inMain().getByRole("button", { name: "保存" }));
    expect(app.api.patchProvider).toHaveBeenCalledWith(P1, {
      models: [
        { name: "gpt-x", vision: false, pdf: false, reasoning: true, contextTokens: 64000 },
        { name: "plain", vision: false, pdf: false, reasoning: false, contextTokens: 16000 },
        { name: "vision-1", vision: true, pdf: true, reasoning: false, contextTokens: 128000 },
      ],
    });
  });

  it("a model's 高级 button says whether its panel is open: 高级 closed, 收起 open, with aria-expanded and its panel", async () => {
    await openProviders();
    await click(inRow("我的 OpenAI").getByRole("button", { name: "编辑" }));
    const row = () => within(modelRow("plain"));
    const button = row().getByRole("button", { name: /高级/ });
    expect(button.textContent).toBe("高级");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.hasAttribute("aria-controls")).toBe(false);
    expect(row().queryByLabelText("上下文容量")).toBeNull();
    await click(button);
    const open = row().getByRole("button", { name: /收起/ });
    expect(open.textContent).toBe("收起");
    expect(open.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(open.getAttribute("aria-controls"))).toBe(row().getByLabelText("上下文容量").closest("div[id]"));
    await click(open);
    const closed = row().getByRole("button", { name: /高级/ });
    expect(closed.textContent).toBe("高级");
    expect(closed.getAttribute("aria-expanded")).toBe("false");
    expect(row().queryByLabelText("上下文容量")).toBeNull();
  });

  it("同步模型 and 测试连接 wait until a new address or key is saved", async () => {
    await openProviders();
    await click(inRow("我的 OpenAI").getByRole("button", { name: "编辑" }));
    expect(inMain().queryByRole("button", { name: "从供应商读取" })).toBeNull();
    fireEvent.change(keyBox(), { target: { value: NEW_KEY } });
    await flush();
    expect(inMain().getByRole("button", { name: "同步模型" }).disabled).toBe(true);
    expect(inMain().getByRole("button", { name: "测试连接" }).disabled).toBe(true);
    expect(mainText()).toContain("请先保存新的接口地址或密钥，再测试连接或同步模型。");
  });

  it("添加模型 with the name box empty says 请填写模型名称, and that does not stop 保存", async () => {
    const app = await openProviders();
    await click(inRow("我的 OpenAI").getByRole("button", { name: "编辑" }));
    await click(inMain().getByRole("button", { name: "添加模型" }));
    expect(mainText()).toContain("请填写模型名称");
    type("名称", "工作用");
    await click(inMain().getByRole("button", { name: "保存" }));
    expect(app.api.patchProvider).toHaveBeenCalledWith(P1, { name: "工作用" });
    expect(toastText()).toBe("供应商已保存");
  });

  it("会用工具（查聊天记录、看文件） is ticked unless the model's entry says tools: false; unticking saves tools: false and ticking tools: true, in the one PATCH of its list", async () => {
    const marked = providerOf(P1, {
      models: [
        { name: "gpt-x", vision: false, pdf: false, reasoning: true, contextTokens: 64000 },
        { name: "plain", vision: false, pdf: false, reasoning: false, contextTokens: 16000, tools: false },
      ],
    });
    const app = await openProviders({ providers: [marked] });
    await click(inRow("我的 OpenAI").getByRole("button", { name: "编辑" }));
    const box = (name) => within(modelRow(name)).getByLabelText("会用工具（查聊天记录、看文件）");
    for (const name of ["gpt-x", "plain"]) await click(within(modelRow(name)).getByRole("button", { name: `高级设置：${name}` }));
    expect([box("gpt-x").checked, box("plain").checked]).toEqual([true, false]);
    fireEvent.click(box("gpt-x"));
    fireEvent.click(box("plain"));
    await flush();
    expect([box("gpt-x").checked, box("plain").checked]).toEqual([false, true]);
    await click(inMain().getByRole("button", { name: "保存" }));
    expect(app.api.patchProvider).toHaveBeenCalledTimes(1);
    expect(app.api.patchProvider).toHaveBeenCalledWith(P1, {
      models: [
        { name: "gpt-x", vision: false, pdf: false, reasoning: true, contextTokens: 64000, tools: false },
        { name: "plain", vision: false, pdf: false, reasoning: false, contextTokens: 16000, tools: true },
      ],
    });
    // As saved: the form, opened again, holds what the service answered.
    await click(inRow("我的 OpenAI").getByRole("button", { name: "编辑" }));
    for (const name of ["gpt-x", "plain"]) await click(within(modelRow(name)).getByRole("button", { name: `高级设置：${name}` }));
    expect([box("gpt-x").checked, box("plain").checked]).toEqual([false, true]);
  });

  it("a model marked tools: false keeps it when the list is saved for another change; one whose entry says nothing sends nothing of it", async () => {
    const marked = providerOf(P1, {
      models: [
        { name: "gpt-x", vision: false, pdf: false, reasoning: true, contextTokens: 64000 },
        { name: "plain", vision: false, pdf: false, reasoning: false, contextTokens: 16000, tools: false },
      ],
    });
    const app = await openProviders({ providers: [marked] });
    await click(inRow("我的 OpenAI").getByRole("button", { name: "编辑" }));
    await click(within(modelRow("plain")).getByRole("button", { name: /高级/ }));
    fireEvent.click(within(modelRow("plain")).getByLabelText(/能看图片/));
    await flush();
    await click(inMain().getByRole("button", { name: "保存" }));
    expect(app.api.patchProvider).toHaveBeenCalledWith(P1, {
      models: [
        { name: "gpt-x", vision: false, pdf: false, reasoning: true, contextTokens: 64000 },
        { name: "plain", vision: true, pdf: false, reasoning: false, contextTokens: 16000, tools: false },
      ],
    });
  });

  it("a model's listed thinking levels show beside 支持思考; 改为全部档位 clears them, and so does unticking 支持思考", async () => {
    const levels = providerOf(P1, {
      models: [
        { name: "gpt-x", vision: false, pdf: false, reasoning: true, contextTokens: 64000, reasoningLevels: ["low", "high"] },
        { name: "deep", vision: false, pdf: false, reasoning: true, contextTokens: 64000, reasoningLevels: ["max"] },
      ],
    });
    const app = await openProviders({ providers: [levels] });
    await click(inRow("我的 OpenAI").getByRole("button", { name: "编辑" }));
    expect(modelRow("gpt-x").textContent).toContain("支持思考（低、高）");
    await click(within(modelRow("gpt-x")).getByRole("button", { name: "改为全部档位：gpt-x" }));
    expect(modelRow("gpt-x").textContent).not.toContain("（低、高）");
    expect(within(modelRow("gpt-x")).queryByRole("button", { name: "改为全部档位：gpt-x" })).toBeNull();
    await click(within(modelRow("deep")).getByRole("button", { name: /高级/ }));
    fireEvent.click(within(modelRow("deep")).getByLabelText(/支持思考/));
    await flush();
    await click(inMain().getByRole("button", { name: "保存" }));
    expect(app.api.patchProvider).toHaveBeenCalledWith(P1, {
      models: [
        { name: "gpt-x", vision: false, pdf: false, reasoning: true, contextTokens: 64000 },
        { name: "deep", vision: false, pdf: false, reasoning: false, contextTokens: 64000 },
      ],
    });
  });
});

describe("同步模型", () => {
  const NO_LIST = (status) => `这个供应商没有提供模型列表（状态码 ${status}），所以没能确认密钥是否可用。对话可能仍然可以使用，模型名称需要手动添加。`;
  const entry = (name, fields = {}) => ({ name, vision: false, pdf: false, reasoning: false, chat: true, known: false, added: false, ...fields });
  const ALL = ["low", "medium", "high", "xhigh", "max"];
  const LISTING = [
    entry("gpt-x", { known: true, label: "GPT X", reasoning: true, added: true }),
    entry("gpt-6-sol", { known: true, label: "GPT-6 Sol", vision: true, pdf: true, reasoning: true, contextTokens: 1050000, reasoningLevels: ALL }),
    entry("claude-long", { known: true, label: "Claude Long", vision: true, pdf: true, reasoning: true, contextTokens: 10000000, reasoningLevels: ["low", "high"] }),
    entry("house-blend"),
    entry("o3-mini", { known: true, label: "o3-mini", reasoning: true, contextTokens: 200000, reasoningLevels: ["low", "medium", "high"] }),
    entry("text-embedding-3-small", { chat: false }),
    entry("tts-1", { chat: false }),
  ];
  const listOf = (listed) => vi.fn(async () => ({ ok: true, listed: structuredClone(listed) }));
  const sync = () => dialog();
  const inSync = () => within(sync());
  const syncRows = (label = "供应商的模型") => [...within(inSync().getByRole("list", { name: label })).queryAllByRole("listitem")];
  const rowOf = (name) => syncRows().find((li) => li.querySelector("strong").textContent === name) ?? null;
  const openSync = async (options = {}) => {
    const app = await openProviders({ ...options, api: { listProviderModels: listOf(LISTING), ...options.api } });
    await click(inRow("我的 OpenAI").getByRole("button", { name: "编辑" }));
    await click(inMain().getByRole("button", { name: "同步模型" }));
    return app;
  };
  const done = () => click(inSync().getByRole("button", { name: "完成" }));

  it("lists the provider's chat models with the hints as tags, the catalogue's name, 未收录 for a guess; the others folded away", async () => {
    const app = await openSync();
    expect(app.api.listProviderModels).toHaveBeenCalledWith(P1);
    expect(sync().querySelector(".modal-head h2").textContent).toBe("我的 OpenAI 的模型（7）");
    expect(syncRows().map((li) => li.querySelector("strong").textContent)).toEqual(["gpt-x", "gpt-6-sol", "claude-long", "house-blend", "o3-mini"]);
    const sol = rowOf("gpt-6-sol");
    expect(sol.textContent).toContain("GPT-6 Sol");
    expect([...sol.querySelectorAll(".tag")].map((t) => t.textContent)).toEqual(["看图", "思考", "PDF"]);
    expect([...rowOf("house-blend").querySelectorAll(".tag")].map((t) => t.textContent)).toEqual(["未收录"]);
    // The display name is not repeated when it is the id itself.
    expect(rowOf("o3-mini").querySelector(".member-body").textContent).not.toContain("o3-mini · o3-mini");
    // gpt-x is in the provider's list already: 已添加, with 移除.
    expect(rowOf("gpt-x").textContent).toContain("已添加");
    expect(within(rowOf("gpt-x")).getByRole("button", { name: "移除：gpt-x" })).toBeTruthy();
    expect(within(rowOf("house-blend")).getByRole("button", { name: "添加：house-blend" })).toBeTruthy();

    // The mark of the model's brand (read from its name) before it, in the brand's colours where it has them; the generic
    // mark for a model of no known brand.
    expect(rowOf("claude-long").querySelector("strong img.lab-logo").dataset.brand).toBe("claude");
    expect(rowOf("gpt-6-sol").querySelector("strong .lab-logo").dataset.brand).toBe("openai");
    expect(rowOf("house-blend").querySelector("strong .lab-logo").dataset.brand).toBe("generic");

    const others = inSync().getByRole("button", { name: /可能不是对话模型/ });
    expect(others.getAttribute("aria-expanded")).toBe("false");
    expect(inSync().queryByRole("list", { name: "可能不是对话模型" })).toBeNull();
    await click(others);
    expect(syncRows("可能不是对话模型").map((li) => li.querySelector("strong").textContent)).toEqual(["text-embedding-3-small", "tts-1"]);
  });

  it("the search box keeps the names (or display names) holding what is typed, ignoring case", async () => {
    await openSync();
    fireEvent.change(inSync().getByRole("searchbox", { name: "搜索模型" }), { target: { value: "SOL" } });
    await flush();
    expect(syncRows().map((li) => li.querySelector("strong").textContent)).toEqual(["gpt-6-sol"]);
    fireEvent.change(inSync().getByRole("searchbox", { name: "搜索模型" }), { target: { value: "claude l" } });
    await flush();
    expect(syncRows().map((li) => li.querySelector("strong").textContent)).toEqual(["claude-long"]);
    fireEvent.change(inSync().getByRole("searchbox", { name: "搜索模型" }), { target: { value: "embed" } });
    await flush();
    expect(syncRows()).toEqual([]);
    expect(inSync().getByRole("button", { name: /可能不是对话模型/ }).textContent).toContain("1");
  });

  it("添加 puts the model in the form's list with its hints as flags, a known model's context (within 1,000–2,000,000) and levels; 完成 saves it when nothing else waits", async () => {
    const app = await openSync();
    await click(within(rowOf("gpt-6-sol")).getByRole("button", { name: "添加：gpt-6-sol" }));
    expect(rowOf("gpt-6-sol").textContent).toContain("已添加");
    await click(within(rowOf("claude-long")).getByRole("button", { name: "添加：claude-long" }));
    await click(within(rowOf("house-blend")).getByRole("button", { name: "添加：house-blend" }));
    // The form's own list, behind the dialog, already has them; nothing was sent yet.
    expect(modelNames()).toEqual(["gpt-x", "plain", "tiny", "gpt-6-sol", "claude-long", "house-blend"]);
    expect(app.api.patchProvider).not.toHaveBeenCalled();
    await done();
    expect(app.api.patchProvider).toHaveBeenCalledTimes(1);
    expect(app.api.patchProvider).toHaveBeenCalledWith(P1, {
      models: [
        { name: "gpt-x", vision: false, pdf: false, reasoning: true, contextTokens: 64000 },
        { name: "plain", vision: false, pdf: false, reasoning: false, contextTokens: 16000 },
        { name: "tiny", vision: false, pdf: false, reasoning: false, contextTokens: 1000 },
        { name: "gpt-6-sol", vision: true, pdf: true, reasoning: true, contextTokens: 1050000, reasoningLevels: ALL },
        { name: "claude-long", vision: true, pdf: true, reasoning: true, contextTokens: 2000000, reasoningLevels: ["low", "high"] },
        { name: "house-blend", vision: false, pdf: false, reasoning: false },
      ],
    });
    expect(dialog()).toBeNull();
    expect(toastText()).toBe("已保存 6 个模型");
    // Still in the form, which now matches what is saved: 保存 has nothing to send.
    expect(modelRow("claude-long").textContent).toContain("支持思考（低、高）");
    await click(inMain().getByRole("button", { name: "保存" }));
    expect(app.api.patchProvider).toHaveBeenCalledTimes(1);
  });

  it("never changes whether a model may use tools: a model marked tools: false keeps it through 完成, a model added says nothing of it", async () => {
    const marked = providerOf(P1, {
      models: [
        { name: "gpt-x", vision: false, pdf: false, reasoning: true, contextTokens: 64000 },
        { name: "plain", vision: false, pdf: false, reasoning: false, contextTokens: 16000, tools: false },
      ],
    });
    const app = await openSync({ providers: [marked] });
    await click(within(rowOf("house-blend")).getByRole("button", { name: "添加：house-blend" }));
    await done();
    expect(app.api.patchProvider).toHaveBeenCalledTimes(1);
    expect(app.api.patchProvider).toHaveBeenCalledWith(P1, {
      models: [
        { name: "gpt-x", vision: false, pdf: false, reasoning: true, contextTokens: 64000 },
        { name: "plain", vision: false, pdf: false, reasoning: false, contextTokens: 16000, tools: false },
        { name: "house-blend", vision: false, pdf: false, reasoning: false },
      ],
    });
    // The form now holds what was saved: plain still unticked.
    await click(within(modelRow("plain")).getByRole("button", { name: /高级/ }));
    expect(within(modelRow("plain")).getByLabelText("会用工具（查聊天记录、看文件）").checked).toBe(false);
  });

  it("移除 takes a model off the form's list, a saved one too; with nothing changed 完成 only closes", async () => {
    const app = await openSync();
    await click(within(rowOf("gpt-x")).getByRole("button", { name: "移除：gpt-x" }));
    expect(within(rowOf("gpt-x")).getByRole("button", { name: "添加：gpt-x" })).toBeTruthy();
    expect(modelNames()).toEqual(["plain", "tiny"]);
    await click(within(rowOf("gpt-x")).getByRole("button", { name: "添加：gpt-x" }));
    await click(within(rowOf("house-blend")).getByRole("button", { name: "添加：house-blend" }));
    await click(within(rowOf("house-blend")).getByRole("button", { name: "移除：house-blend" }));
    // gpt-x came back with its hints as flags (reasoning, the context left to the default): a change, saved.
    await done();
    expect(app.api.patchProvider.mock.calls[0][1].models.map((m) => m.name)).toEqual(["plain", "tiny", "gpt-x"]);

    app.api.patchProvider.mockClear();
    await click(inMain().getByRole("button", { name: "同步模型" }));
    await done();
    expect(app.api.patchProvider).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
  });

  it("完成 does not save while the form has another unsaved change: the models wait for the form's 保存", async () => {
    const app = await openProviders({ api: { listProviderModels: listOf(LISTING) } });
    await click(inRow("我的 OpenAI").getByRole("button", { name: "编辑" }));
    type("名称", "工作用");
    await click(inMain().getByRole("button", { name: "同步模型" }));
    await click(within(rowOf("house-blend")).getByRole("button", { name: "添加：house-blend" }));
    await done();
    expect(app.api.patchProvider).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
    expect(modelNames()).toEqual(["gpt-x", "plain", "tiny", "house-blend"]);
    await click(inMain().getByRole("button", { name: "保存" }));
    expect(app.api.patchProvider).toHaveBeenCalledWith(P1, { name: "工作用", models: expect.arrayContaining([{ name: "house-blend", vision: false, pdf: false, reasoning: false }]) });
  });

  it("a model added by hand before opening it counts as another unsaved change too", async () => {
    const app = await openProviders({ api: { listProviderModels: listOf(LISTING) } });
    await click(inRow("我的 OpenAI").getByRole("button", { name: "编辑" }));
    type("模型名称", "typed-by-hand");
    await click(inMain().getByRole("button", { name: "添加模型" }));
    await click(inMain().getByRole("button", { name: "同步模型" }));
    await click(within(rowOf("house-blend")).getByRole("button", { name: "添加：house-blend" }));
    await done();
    expect(app.api.patchProvider).not.toHaveBeenCalled();
    expect(modelNames()).toEqual(["gpt-x", "plain", "tiny", "typed-by-hand", "house-blend"]);
  });

  it("添加全部 adds every chat model not yet added; at the limit of 100 it says how many were added", async () => {
    const many = providerOf(P1, { models: Array.from({ length: 97 }, (_, i) => ({ name: `m${i}`, vision: false, pdf: false, reasoning: false, contextTokens: 16000 })) });
    const app = await openSync({ providers: [many] });
    await click(inSync().getByRole("button", { name: "添加全部" }));
    // Three places were left: gpt-x, gpt-6-sol, claude-long; never the models that may not chat.
    expect(modelNames().slice(97)).toEqual(["gpt-x", "gpt-6-sol", "claude-long"]);
    expect(inSync().getByRole("status").textContent).toBe("已添加 3 个模型。每个供应商最多 100 个模型，其余的没有添加。");
    expect(within(rowOf("house-blend")).getByRole("button", { name: "添加：house-blend" }).disabled).toBe(true);
    expect(inSync().getByRole("button", { name: "添加全部" }).disabled).toBe(true);
    await done();
    expect(app.api.patchProvider.mock.calls[0][1].models).toHaveLength(100);
    expect(toastText()).toBe("已保存 100 个模型");
  });

  it("添加全部 with room for all: they are added, the non-chat ones left out, and nothing is said", async () => {
    await openSync();
    await click(inSync().getByRole("button", { name: "添加全部" }));
    expect(modelNames()).toEqual(["gpt-x", "plain", "tiny", "gpt-6-sol", "claude-long", "house-blend", "o3-mini"]);
    expect(inSync().queryByRole("status")).toBeNull();
    expect(inSync().getByRole("button", { name: "添加全部" }).disabled).toBe(true);
  });

  it("添加全部 with text in the search box adds only the listed chat models that match, and its label says so", async () => {
    await openSync();
    fireEvent.change(inSync().getByRole("searchbox", { name: "搜索模型" }), { target: { value: "claude" } });
    await flush();
    expect(inSync().queryByRole("button", { name: "添加全部" })).toBeNull();
    await click(inSync().getByRole("button", { name: "添加全部匹配项" }));
    expect(modelNames()).toEqual(["gpt-x", "plain", "tiny", "claude-long"]);
    expect(inSync().getByRole("button", { name: "添加全部匹配项" }).disabled).toBe(true);
    fireEvent.change(inSync().getByRole("searchbox", { name: "搜索模型" }), { target: { value: "" } });
    await flush();
    expect(inSync().getByRole("button", { name: "添加全部" }).disabled).toBe(false);
  });

  it("the 可能不是对话模型 toggle points at the group it opens", async () => {
    await openSync();
    const toggle = inSync().getByRole("button", { name: /可能不是对话模型/ });
    await click(toggle);
    const id = toggle.getAttribute("aria-controls");
    expect(id).toBeTruthy();
    expect(document.getElementById(id).getAttribute("aria-label")).toBe("可能不是对话模型");
  });

  it("the 改为全部档位 button names its model", async () => {
    const levels = providerOf(P1, {
      models: [{ name: "gpt-x", vision: false, pdf: false, reasoning: true, contextTokens: 64000, reasoningLevels: ["low", "high"] }],
    });
    await openProviders({ providers: [levels] });
    await click(inRow("我的 OpenAI").getByRole("button", { name: "编辑" }));
    expect(within(modelRow("gpt-x")).getByRole("button", { name: "改为全部档位：gpt-x" })).toBeTruthy();
  });

  it("shows at most 200 rows at a time; past them it asks to narrow down by searching", async () => {
    const long = Array.from({ length: 260 }, (_, i) => entry(`model-${String(i).padStart(3, "0")}`));
    await openSync({ api: { listProviderModels: listOf(long) } });
    expect(syncRows()).toHaveLength(200);
    expect(sync().textContent).toContain("还有 60 个，请用搜索缩小范围");
    fireEvent.change(inSync().getByRole("searchbox", { name: "搜索模型" }), { target: { value: "model-25" } });
    await flush();
    expect(syncRows()).toHaveLength(10);
    expect(sync().textContent).not.toContain("请用搜索缩小范围");
  });

  it("after a provider is added, it opens by itself, once", async () => {
    const listProviderModels = listOf(LISTING);
    await openProviders({ providers: [], api: { listProviderModels } });
    await click(inMain().getByRole("button", { name: /添加供应商/ }));
    expect(mainText()).toContain("保存后从供应商的模型列表里挑选模型。");
    type("名称", "新的");
    type("接口地址", "https://api.example.com/v1");
    fireEvent.change(keyBox(), { target: { value: KEY } });
    await click(inMain().getByRole("button", { name: "保存并选择模型" }));
    expect(mainText()).toContain("已添加。请选择要使用的模型。");
    expect(sync().querySelector(".modal-head h2").textContent).toBe("新的 的模型（7）");
    expect(listProviderModels).toHaveBeenCalledWith(P2);
    await click(inSync().getByRole("button", { name: "关闭" }));
    expect(dialog()).toBeNull();
    await click(inMain().getByRole("button", { name: /返回/ }));
    await click(inRow("新的").getByRole("button", { name: "编辑" }));
    expect(dialog()).toBeNull();
    expect(listProviderModels).toHaveBeenCalledTimes(1);
  });

  it("a provider that already has models, opened for editing, does not open it", async () => {
    const listProviderModels = listOf(LISTING);
    await openProviders({ api: { listProviderModels } });
    await click(inRow("我的 OpenAI").getByRole("button", { name: "编辑" }));
    expect(dialog()).toBeNull();
    expect(listProviderModels).not.toHaveBeenCalled();
  });

  it("says why it has no list: no model list at the provider, a refused key, unreachable, too many tries, an empty list", async () => {
    const listProviderModels = vi.fn();
    const NO_LIST_HERE = "这个接口没有模型列表，请关闭后在下面手动添加模型名称。";
    const cases = [
      [async () => ({ ok: false, error: "provider_unavailable", upstreamStatus: "404" }), NO_LIST_HERE, "status"],
      [async () => ({ ok: false, error: "provider_unavailable", upstreamStatus: "405" }), NO_LIST_HERE, "status"],
      [async () => ({ ok: false, error: "provider_rejected", upstreamStatus: "401" }), "供应商拒绝了这个密钥，或已保存的密钥无法再使用。请重新填写密钥并保存，然后再试。（供应商返回的状态码：401）", "alert"],
      [async () => ({ ok: false, error: "provider_unavailable" }), "暂时连不上供应商，或它没有给出可用的回答，请稍后再试。", "alert"],
      [async () => ({ ok: false, error: "address_not_allowed" }), "这个接口地址不被允许：需要是 https 开头的公网地址。", "alert"],
      [async () => Promise.reject(apiError(429, "rate_limited")), "操作太频繁了，请稍等一分钟再试。", "alert"],
      [async () => ({ ok: true, listed: [] }), "供应商没有列出任何模型，可以手动添加。", "status"],
    ];
    await openProviders({ api: { listProviderModels } });
    await click(inRow("我的 OpenAI").getByRole("button", { name: "编辑" }));
    for (const [answer, sentence, role] of cases) {
      listProviderModels.mockImplementationOnce(answer);
      await click(inMain().getByRole("button", { name: "同步模型" }));
      expect([sentence, inSync().getByRole(role).textContent]).toEqual([sentence, sentence]);
      expect(inSync().queryByRole("searchbox")).toBeNull();
      await done();
    }
    // An error that may pass can be tried again from the dialog.
    listProviderModels.mockImplementationOnce(async () => ({ ok: false, error: "provider_unavailable" }));
    await click(inMain().getByRole("button", { name: "同步模型" }));
    listProviderModels.mockImplementationOnce(listOf(LISTING));
    await click(inSync().getByRole("button", { name: "重试" }));
    expect(syncRows()).toHaveLength(5);
  });

  it("models from the public catalogue (the address has no list) say so, and are added like any others", async () => {
    const listProviderModels = vi.fn(async () => ({ ok: true, listed: structuredClone(LISTING.slice(3, 5)), source: "catalogue" }));
    const app = await openSync({ api: { listProviderModels } });
    expect(sync().textContent).toContain("这个接口没有模型列表，以下来自公开的模型目录，请只添加你确实能用的模型。");
    expect(sync().querySelector("p.muted").textContent).toBe("这个接口没有模型列表，以下来自公开的模型目录，请只添加你确实能用的模型。");
    await click(within(rowOf("house-blend")).getByRole("button", { name: "添加：house-blend" }));
    await done();
    expect(app.api.patchProvider.mock.calls[0][1].models.map((m) => m.name)).toContain("house-blend");
    // A list the provider gives itself says nothing of the kind.
    listProviderModels.mockImplementationOnce(listOf(LISTING));
    await click(inMain().getByRole("button", { name: "同步模型" }));
    expect(sync().textContent).not.toContain("公开的模型目录");
  });

  it("under a failure, 详情: the provider's status and what it said, as plain text", async () => {
    const said = '<img src=x onerror="alert(1)"> **Model** `nope` not found';
    const listProviderModels = vi.fn(async () => ({ ok: false, error: "provider_unavailable", upstreamStatus: "500", detail: { upstreamStatus: "500", message: said } }));
    await openSync({ api: { listProviderModels } });
    const details = sync().querySelector("details");
    expect(details.open).toBe(false);
    expect(details.querySelector("summary").textContent).toBe("详情");
    expect(details.textContent).toContain("状态码：500");
    expect(details.textContent).toContain(`供应商的回复：${said}`);
    expect(details.querySelector("img, strong, code")).toBeNull();
    expect(inSync().getByRole("alert").textContent).toBe("暂时连不上供应商，或它没有给出可用的回答，请稍后再试。（供应商返回的状态码：500）");
  });

  it("a refused save on 完成 is said in the dialog, which stays open with the models still in the form", async () => {
    const patchProvider = vi.fn(async () => Promise.reject(apiError(503, "busy")));
    await openSync({ api: { patchProvider } });
    await click(within(rowOf("house-blend")).getByRole("button", { name: "添加：house-blend" }));
    await done();
    expect(patchProvider).toHaveBeenCalledTimes(1);
    expect(sync()).not.toBeNull();
    expect(inSync().getByRole("alert").textContent).toBe("服务现在有点忙，请稍后再试。");
    expect(modelNames()).toContain("house-blend");
  });
});

describe("测试连接", () => {
  const NO_LIST = (status) => `这个供应商没有提供模型列表（状态码 ${status}），所以没能确认密钥是否可用。对话可能仍然可以使用，模型名称需要手动添加。`;
  const REJECTED = "供应商拒绝了这个密钥，或已保存的密钥无法再使用。请重新填写密钥并保存，然后再试。";
  const UNAVAILABLE = "暂时连不上供应商，或它没有给出可用的回答，请稍后再试。";
  const common = [
    [{ ok: false, error: "provider_rejected", upstreamStatus: "401" }, `${REJECTED}（供应商返回的状态码：401）`],
    [{ ok: false, error: "provider_rejected" }, REJECTED],
    [{ ok: false, error: "provider_unavailable", upstreamStatus: "500" }, `${UNAVAILABLE}（供应商返回的状态码：500）`],
    [{ ok: false, error: "provider_unavailable" }, UNAVAILABLE],
    [{ ok: false, error: "address_not_allowed" }, "这个接口地址不被允许：需要是 https 开头的公网地址。"],
  ];
  const run = async (provider, cases, model) => {
    const testProvider = vi.fn();
    await openProviders({ providers: [provider], api: { testProvider } });
    for (const [answer, sentence] of cases) {
      testProvider.mockResolvedValueOnce(answer);
      await click(inRow(provider.name).getByRole("button", { name: "测试连接" }));
      const shown = providerRow(provider.name).querySelector('[role="status"], [role="alert"]');
      expect(shown.textContent, JSON.stringify(answer)).toBe(sentence);
    }
    expect(testProvider).toHaveBeenCalledTimes(cases.length);
    for (const args of testProvider.mock.calls) expect(args).toEqual([provider.id, model]);
  };

  it("with saved models: says hi to the first one, and says which and how long it took; a 404 there is no missing list", async () => {
    await run(providerOf(), [
      [{ ok: true, mode: "chat", latencyMs: 812 }, "用 gpt-x 发了一句话，用时 0.8 秒"],
      [{ ok: true, mode: "chat", latencyMs: 12345 }, "用 gpt-x 发了一句话，用时 12.3 秒"],
      ...common,
      [{ ok: false, error: "provider_unavailable", upstreamStatus: "404" }, `${UNAVAILABLE}（供应商返回的状态码：404）`],
      [{ ok: false, error: "provider_unavailable", upstreamStatus: "405" }, `${UNAVAILABLE}（供应商返回的状态码：405）`],
      [{ ok: false, error: "invalid_request" }, "这个模型已经不在供应商的模型列表里了，请刷新页面后再试。"],
    ], "gpt-x");
  });

  it("without a saved model: the model list, as before (a 404 or 405: no model list there)", async () => {
    await run(providerOf(P2, { name: "空的", models: [] }), [
      [{ ok: true, mode: "list", latencyMs: 400 }, "连接成功，供应商正常回应。"],
      [{ ok: true }, "连接成功，供应商正常回应。"],
      ...common,
      [{ ok: false, error: "provider_unavailable", upstreamStatus: "404" }, NO_LIST("404")],
      [{ ok: false, error: "provider_unavailable", upstreamStatus: "405" }, NO_LIST("405")],
    ], undefined);
  });

  it("under a failure, a folded 详情 with the provider's status and its own words, as plain text; a reply that held the key says so", async () => {
    const testProvider = vi.fn();
    await openProviders({ api: { testProvider } });
    const said = "Model `gpt-x` does not exist\n<b>or</b> you have no access";
    testProvider.mockResolvedValueOnce({ ok: false, error: "provider_unavailable", upstreamStatus: "404", detail: { upstreamStatus: "404", message: said, extra: "x" } });
    await click(inRow("我的 OpenAI").getByRole("button", { name: "测试连接" }));
    const details = () => providerRow("我的 OpenAI").querySelector("details");
    expect(details().open).toBe(false);
    expect(details().querySelector("summary").textContent).toBe("详情");
    expect([...details().querySelectorAll("p")].map((p) => p.textContent)).toEqual(["状态码：404", `供应商的回复：${said}`]);
    expect(details().querySelector("b, code")).toBeNull();
    fireEvent.click(details().querySelector("summary"));
    testProvider.mockResolvedValueOnce({ ok: false, error: "provider_rejected", upstreamStatus: "401", detail: { upstreamStatus: "401", message: null, redacted: true } });
    await click(inRow("我的 OpenAI").getByRole("button", { name: "测试连接" }));
    expect([...details().querySelectorAll("p")].map((p) => p.textContent)).toEqual(["状态码：401", "供应商的回复里有密钥的一部分，为了安全没有显示。"]);
    // Nothing to tell (no detail, or one that is no object): no 详情.
    for (const answer of [{ ok: false, error: "provider_unavailable" }, { ok: false, error: "provider_unavailable", detail: "text" }, { ok: true, mode: "chat", latencyMs: 5 }]) {
      testProvider.mockResolvedValueOnce(answer);
      await click(inRow("我的 OpenAI").getByRole("button", { name: "测试连接" }));
      expect([answer, details()]).toEqual([answer, null]);
    }
  });

  it("a refused request (not the provider's answer) says why too, and the button shows it is busy meanwhile", async () => {
    const pending = deferred();
    const testProvider = vi.fn(() => pending.promise);
    await openProviders({ api: { testProvider } });
    await click(inRow("我的 OpenAI").getByRole("button", { name: "测试连接" }));
    expect(inRow("我的 OpenAI").getByRole("button", { name: "测试中…" }).disabled).toBe(true);
    await act(async () => pending.reject(apiError(429, "rate_limited")));
    await flush();
    expect(providerRow("我的 OpenAI").querySelector('[role="alert"]').textContent).toBe("操作太频繁了，请稍等一分钟再试。");
  });
});

describe("deleting a provider", () => {
  it("asks first; while Agents use it, the refusal lists them and the provider stays", async () => {
    const deleteProvider = vi.fn(async () => {
      throw apiError(409, "provider_in_use", null, { agents: [{ id: AG1, name: "小助手" }, { id: AG2, name: "写作助手" }] });
    });
    await openProviders({ api: { deleteProvider } });
    await click(inRow("我的 OpenAI").getByRole("button", { name: "删除" }));
    expect(dialog().textContent).toContain("不可恢复");
    await click(within(dialog()).getByRole("button", { name: "取消" }));
    expect(deleteProvider).not.toHaveBeenCalled();
    await click(inRow("我的 OpenAI").getByRole("button", { name: "删除" }));
    await click(within(dialog()).getByRole("button", { name: "确认删除" }));
    expect(deleteProvider).toHaveBeenCalledWith(P1);
    const users = within(within(dialog()).getByRole("list", { name: "正在使用它的 Agent" })).getAllByRole("listitem");
    expect(users.map((li) => li.textContent)).toEqual(["小助手", "写作助手"]);
    expect(dialog().textContent).toContain("请先给它们换一个模型");
    await click(within(dialog()).getByRole("button", { name: "取消" }));
    expect(providerRow("我的 OpenAI")).toBeTruthy();
  });

  it("removes it once confirmed", async () => {
    const app = await openProviders();
    await click(inRow("我的 OpenAI").getByRole("button", { name: "删除" }));
    await click(within(dialog()).getByRole("button", { name: "确认删除" }));
    expect(app.api.deleteProvider).toHaveBeenCalledWith(P1);
    expect(dialog()).toBeNull();
    expect(inMain().queryByText("我的 OpenAI", { selector: ".member-body strong" })).toBeNull();
    expect(mainText()).toContain("还没有添加模型供应商");
  });
});

describe("the add and edit forms are pages with addresses", () => {
  const stepHistory = (move) =>
    act(async () => {
      move();
      await vi.advanceTimersByTimeAsync(50);
    });

  it("添加供应商 is /settings/providers/new: Back is the list; Forward brings the typed form back, key included; none of it in the address or a storage", async () => {
    await openProviders({ providers: [] });
    await click(inMain().getByRole("button", { name: /添加供应商/ }));
    expect(window.location.pathname).toBe("/settings/providers/new");
    type("名称", "草稿供应商");
    fireEvent.change(keyBox(), { target: { value: "sk-draft-1234567890" } });
    await stepHistory(() => window.history.back());
    expect(window.location.pathname).toBe("/settings/providers");
    expect(inMain().queryByLabelText("名称")).toBeNull();
    await stepHistory(() => window.history.forward());
    expect(window.location.pathname).toBe("/settings/providers/new");
    expect(inMain().getByLabelText("名称").value).toBe("草稿供应商");
    expect(keyBox().value).toBe("sk-draft-1234567890");
    expect(window.location.href).not.toContain("sk-draft");
    expect(JSON.stringify(window.history.state)).not.toContain("sk-draft");
    expect(JSON.stringify({ ...localStorage })).not.toContain("sk-draft");
    expect(JSON.stringify({ ...sessionStorage })).not.toContain("sk-draft");
  });

  it("a fresh 添加供应商 starts empty (a typed draft comes back only through Back and Forward)", async () => {
    await openProviders({ providers: [] });
    await click(inMain().getByRole("button", { name: /添加供应商/ }));
    type("名称", "旧草稿");
    await stepHistory(() => window.history.back());
    await click(inMain().getByRole("button", { name: /添加供应商/ }));
    expect(inMain().getByLabelText("名称").value).toBe("");
  });

  it("the form's own 返回 and 取消 go back to the list; 编辑 is /settings/providers/<id>", async () => {
    await openProviders();
    await click(inMain().getByRole("button", { name: /编辑/ }));
    expect(window.location.pathname).toBe(`/settings/providers/${P1}`);
    await click(inMain().getByRole("button", { name: "取消" }));
    await stepHistory(() => {});
    expect(window.location.pathname).toBe("/settings/providers");
  });

  it("an address of a provider that is not mine shows the list with a notice, at once", async () => {
    window.history.replaceState(null, "", "/settings/providers/00000000-0000-4000-8000-0000000000ee");
    installBrowser();
    window.history.replaceState(null, "", "/settings/providers/00000000-0000-4000-8000-0000000000ee");
    const env = { providers: [providerOf()] };
    await openApp({ sync: () => syncOf([]), api: { listProviders: vi.fn(async () => ({ providers: structuredClone(env.providers) })) }, handlers: { models: () => MODELS } });
    await flush();
    expect(toastText()).toBe("找不到这个模型供应商");
    expect(window.location.pathname).toBe("/settings/providers");
  });

  it("the page's own 取消 and 返回 forget what was typed, the key with it: 编辑 again starts from the stored provider", async () => {
    await openProviders();
    for (const leave of [{ name: "取消" }, { name: /返回/ }]) {
      await click(inMain().getByRole("button", { name: /编辑/ }));
      type("名称", "取消的名字");
      fireEvent.change(keyBox(), { target: { value: "sk-cancelled-1234567890" } });
      expect(draftKeys()).toContain(P1);
      await click(inMain().getByRole("button", leave));
      await stepHistory(() => {});
      expect(draftKeys()).toEqual([]);
      await click(inMain().getByRole("button", { name: /编辑/ }));
      expect(inMain().getByLabelText("名称").value).not.toBe("取消的名字");
      expect(keyBox().value).toBe("");
      await click(inMain().getByRole("button", { name: "取消" }));
      await stepHistory(() => {});
    }
  });

  it("the browser's Back and Forward keep an edit's draft (that was the point); a save forgets it", async () => {
    await openProviders();
    await click(inMain().getByRole("button", { name: /编辑/ }));
    type("名称", "改了一半");
    await stepHistory(() => window.history.back());
    expect(draftKeys()).toContain(P1);
    await stepHistory(() => window.history.forward());
    expect(inMain().getByLabelText("名称").value).toBe("改了一半");
    await click(inMain().getByRole("button", { name: "保存" }));
    expect(draftKeys()).toEqual([]);
  });

  it("Forward into the form of a provider that was deleted meanwhile shows the list, once, and the entry is the list", async () => {
    const app = await openProviders();
    await click(inMain().getByRole("button", { name: /编辑/ }));
    await stepHistory(() => window.history.back());
    app.env.providers = [];
    await act(async () => app.layer.actions.loadProviders());
    await flush();
    await stepHistory(() => window.history.forward());
    await flush();
    expect(window.location.pathname).toBe("/settings/providers");
    const length = window.history.length;
    await stepHistory(() => window.history.back());
    expect(window.history.length).toBeLessThanOrEqual(length);
  });
});
