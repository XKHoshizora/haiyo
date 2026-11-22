// A person's own model providers in a real browser. The provider that answers is the local model stub
// (support/model-stub.mjs) at http://127.0.0.1, an address the form itself refuses (it asks for https, its own check
// before any request, also when editing): the provider is added in the form at an https address, and the one request
// that adds it goes on with the stub's address in its place. Everything else is done in the page — 同步模型 (which
// opens by itself for a provider added without models), 测试连接, an Agent choosing its model and answering with it.
// The form's own handling of a typed key is then shown on providers at an https address that is never called: a key
// typed in reaches the service once and stays nowhere in the page or the browser's storage.
import { randomBytes } from "node:crypto";
import { test, expect } from "./support/fixtures.mjs";
import { uniq } from "./support/accounts.mjs";
import { createAgentUi, expectStored, goTo, sendText } from "./support/app.mjs";
import { canControlService } from "./support/control.mjs";
import { STUB_MODELS, modelStub } from "./support/model-stub.mjs";
import { capture } from "./support/shots.mjs";

test.beforeEach(async () => {
  test.skip(!canControlService, "needs the local service and its model stub");
  await modelStub.reset();
});

/** A fake key, different every time (the stub takes any). */
const fakeKey = () => `sk-e2e-${randomBytes(12).toString("hex")}`;
/** An https address that is only stored, never called (the service checks an address when it calls it). */
const NEVER_CALLED = "https://api.example.test/v1";

/** Settings › 模型供应商. */
async function openProviders(page) {
  await goTo(page, "设置");
  await page.getByRole("button", { name: /模型供应商/ }).click();
  const section = page.getByRole("region", { name: "模型供应商" });
  await expect(section.getByRole("heading", { name: "模型供应商", exact: true })).toBeVisible();
  return section;
}

const providerRow = (section, name) => section.getByRole("list", { name: "我的模型供应商" }).getByRole("listitem").filter({ hasText: name });
const toast = (page, text) => page.getByRole("status").filter({ hasText: text });
const editForm = (page) => page.getByRole("region", { name: "编辑模型供应商" });

/** Everything of the page a key could be left in: the markup, every field's value, and both storages. */
const leftovers = (page) =>
  page.evaluate(() => {
    const values = [...document.querySelectorAll("input, textarea, select")].map((e) => e.value);
    const stored = (s) => Object.keys(s).map((k) => `${k}=${s.getItem(k)}`);
    return [document.documentElement.outerHTML, ...values, ...stored(localStorage), ...stored(sessionStorage)].join("\n");
  });

test("my own provider: added in the form, 同步模型 opens with its model list; two found by search are saved with 完成; 测试连接 reaches it; an Agent on one answers through it; the key is nowhere in the page", async ({ people }) => {
  const ann = await people.member("Ann");
  const page = ann.page;
  const name = `我的演示供应商${uniq(4)}`;
  const key = fakeKey();
  // The request that adds a provider goes on with the stub's address for the https one typed (see the header).
  await page.route("**/api/providers", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const body = JSON.parse(route.request().postData() ?? "{}");
    await route.continue({ postData: JSON.stringify({ ...body, baseUrl: modelStub.baseUrl }) });
  });

  const section = await openProviders(page);
  await section.getByRole("button", { name: "添加供应商" }).click();
  const add = page.getByRole("region", { name: "添加模型供应商" });
  await expect(add).toContainText("保存后从供应商的模型列表里挑选模型。");
  await expect(add.getByRole("button", { name: "添加模型" })).toHaveCount(0);
  await add.getByLabel("名称", { exact: true }).fill(name);
  await add.getByLabel("接口地址", { exact: true }).fill(NEVER_CALLED);
  await add.getByLabel("密钥", { exact: true }).fill(key);
  await add.getByRole("button", { name: "保存并选择模型", exact: true }).click();
  await expect(editForm(page).getByRole("status").filter({ hasText: "已添加。请选择要使用的模型。" })).toBeVisible();

  // Added without models: 同步模型 opens by itself with the provider's own list, asked for with the key.
  const sync = page.getByRole("dialog", { name: `${name} 的模型（${STUB_MODELS.length}）` });
  await expect(sync).toBeVisible();
  const chatRows = sync.getByRole("list", { name: "供应商的模型" }).getByRole("listitem");
  await expect(chatRows).toHaveCount(STUB_MODELS.length - 1);
  // What the catalogue knows shows its name; the stub's own models are marked 未收录; the embedding model is folded away.
  await expect(chatRows.filter({ hasText: "claude-sonnet-5-5" })).toContainText("Claude Sonnet 5.5");
  await expect(chatRows.filter({ hasText: "stub-chat" })).toContainText("未收录");
  await expect(sync.getByRole("button", { name: /可能不是对话模型/ })).toHaveAttribute("aria-expanded", "false");
  const listing = () => modelStub.state().then((s) => s.requests.filter((r) => r.method === "GET").map((r) => [r.path, r.authorization]));
  expect(await listing()).toEqual([["/v1/models", `Bearer ${key}`]]);

  await sync.getByRole("searchbox", { name: "搜索模型" }).fill("STUB");
  await expect(chatRows).toHaveCount(2);
  await sync.getByRole("button", { name: "添加：stub-chat" }).click();
  await sync.getByRole("button", { name: "添加：stub-vision" }).click();
  await expect(sync.getByRole("button", { name: "移除：stub-vision" })).toBeVisible();
  await expect(chatRows.filter({ hasText: "stub-chat" })).toContainText("已添加");
  await capture(page, "settings-providers-sync");
  await sync.getByRole("button", { name: "完成" }).click();
  await expect(sync).toBeHidden();
  await expect(toast(page, "已保存 2 个模型")).toBeVisible();
  const form = editForm(page);
  await expect(form.getByRole("list", { name: "模型列表" }).getByRole("listitem")).toHaveCount(2);
  await form.getByRole("button", { name: "返回" }).click();
  const row = providerRow(section, name);
  await expect(row).toContainText("2 个模型");
  await expect(row).toContainText(`密钥 …${key.slice(-4)}`);

  // 测试连接: one tiny real call to its first saved model, with the key (its model list is not asked for again).
  await row.getByRole("button", { name: "测试连接" }).click();
  await expect(row.getByRole("status")).toHaveText(/^用 stub-chat 发了一句话，用时 \d+\.\d 秒$/);
  const [probe] = await modelStub.waitForCalls(1);
  expect([probe.path, probe.authorization, probe.body.model]).toEqual(["/v1/chat/completions", `Bearer ${key}`, "stub-chat"]);
  expect(await listing()).toEqual([["/v1/models", `Bearer ${key}`]]);

  // An Agent on one of the two answers through the provider, with that key.
  const agent = `自带模型${uniq(4)}`;
  await modelStub.reply("这是供应商模型的回答。");
  const chat = await createAgentUi(page, { name: agent, model: STUB_MODELS[0], persona: "你是一个用自己供应商的助手。" });
  await sendText(ann.page, agent, `你好 ${uniq(4)}`);
  await expectStored(chat, "这是供应商模型的回答。");
  const [, call] = await modelStub.waitForCalls(2);
  expect([call.path, call.authorization, call.body.model]).toEqual(["/v1/chat/completions", `Bearer ${key}`, STUB_MODELS[0]]);

  // The key never came back to the page: not in it, not in its storage, also after a reload.
  expect(await leftovers(ann.page)).not.toContain(key);
  await ann.page.reload();
  await openProviders(ann.page);
  expect(await leftovers(ann.page)).not.toContain(key);
});

test("keys typed into the form are sent once and kept nowhere; a save refused with a new key asks for it again; 保留原密钥 with nothing else changed says so", async ({ people }) => {
  const ann = await people.member("Ann");
  const tag = uniq(4);
  const main = `主力供应商${tag}`;
  const spare = `备用供应商${tag}`;
  const keys = [fakeKey(), fakeKey(), fakeKey()];
  const section = await openProviders(ann.page);

  // Two providers added in the form.
  for (const [i, name] of [main, spare].entries()) {
    await section.getByRole("button", { name: "添加供应商" }).click();
    const add = ann.page.getByRole("region", { name: "添加模型供应商" });
    await add.getByLabel("名称", { exact: true }).fill(name);
    await add.getByLabel("接口地址", { exact: true }).fill(NEVER_CALLED);
    await add.getByLabel("密钥", { exact: true }).fill(keys[i]);
    await add.getByRole("button", { name: "保存并选择模型", exact: true }).click();
    const added = editForm(ann.page);
    await expect(added.getByRole("status").filter({ hasText: "已添加。请选择要使用的模型。" })).toBeVisible();
    // The address is never called, so the model list opened by itself fails: close it and add the model by hand.
    const listing = ann.page.getByRole("dialog");
    await expect(listing).toBeVisible();
    await listing.getByRole("button", { name: "关闭" }).click();
    await expect(listing).toBeHidden();
    await expect(added.getByLabel("密钥", { exact: true })).toHaveValue("");
    await expect(added).toContainText("还没有模型。Agent 需要至少一个模型才能使用这个供应商。");
    await added.getByLabel("模型名称", { exact: true }).fill("demo-model");
    await added.getByRole("button", { name: "添加模型" }).click();
    if (i === 0) await capture(ann.page, "settings-providers-form");
    await added.getByRole("button", { name: "保存", exact: true }).click();
    await expect(toast(ann.page, "供应商已保存")).toBeVisible();
    await expect(providerRow(section, name)).toContainText(`密钥 …${keys[i].slice(-4)}`);
  }
  await capture(ann.page, "settings-providers-list");

  // The other provider's name and a new key: refused (name_taken), the key field emptied.
  await providerRow(section, main).getByRole("button", { name: "编辑" }).click();
  const form = editForm(ann.page);
  const nameBox = form.getByLabel("名称", { exact: true });
  const keyBox = form.getByLabel("密钥", { exact: true });
  await nameBox.fill(spare);
  await keyBox.fill(keys[2]);
  await form.getByRole("button", { name: "保存", exact: true }).click();
  await expect(form.getByText("你已经有一个同名的供应商了，请换个名称。")).toBeVisible();
  await expect(keyBox).toHaveValue("");
  // Under the key field: one sentence, the error (no hint beside it).
  const keyField = form.locator(".field").filter({ has: ann.page.getByLabel("密钥", { exact: true }) });
  await expect(keyField.locator(".field-msg, .field-hint")).toHaveCount(1);
  await expect(keyField.locator(".field-msg")).toHaveText("上次填写的密钥没有保存，请重新填写；如果不想更换，点“保留原密钥”。");
  await capture(ann.page, "settings-providers-refused-key");

  // The name back as it was, the saved key kept: nothing to send, and it says so.
  await nameBox.fill(main);
  await form.getByRole("button", { name: "保留原密钥" }).click();
  await form.getByRole("button", { name: "保存", exact: true }).click();
  await expect(toast(ann.page, "没有改动，原来的密钥保持不变")).toBeVisible();
  await expect(providerRow(section, main)).toContainText(`密钥 …${keys[0].slice(-4)}`);

  for (const key of keys) expect(await leftovers(ann.page)).not.toContain(key);
  await ann.page.reload();
  await openProviders(ann.page);
  for (const key of keys) expect(await leftovers(ann.page)).not.toContain(key);
});
