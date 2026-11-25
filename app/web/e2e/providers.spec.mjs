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
import { chatPane, chooseModelUi, chooseOptionUi, createAgentUi, expectStored, goTo, openAgentDetail, sendText } from "./support/app.mjs";
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

/** Where this run's pictures of the 高级 section go (`WEBNAV_SHOTS`: a folder outside the repository); none without it. */
const LEVEL_SHOTS = process.env.WEBNAV_SHOTS?.trim() || null;

test("思考档位 under 高级 for every model that thinks: one the catalogue does not know has five boxes, all ticked; two unticked and saved, the Agent form offers exactly the rest; one it knows has the reported set or 全部档位", async ({ people }) => {
  const ann = await people.member("Ann");
  const page = ann.page;
  const name = `档位供应商${uniq(4)}`;
  const section = await openProviders(page);
  await section.getByRole("button", { name: "添加供应商" }).click();
  const add = page.getByRole("region", { name: "添加模型供应商" });
  await add.getByLabel("名称", { exact: true }).fill(name);
  await add.getByLabel("接口地址", { exact: true }).fill(NEVER_CALLED);
  await add.getByLabel("密钥", { exact: true }).fill(fakeKey());
  await add.getByRole("button", { name: "保存并选择模型", exact: true }).click();
  const form = editForm(page);
  // (The address is never called: the model list that opens by itself fails; the models are added by hand.)
  const listing = page.getByRole("dialog");
  await expect(listing).toBeVisible();
  await listing.getByRole("button", { name: "关闭" }).click();
  await expect(listing).toBeHidden();
  for (const model of ["house-think", "o3-mini"]) {
    await form.getByLabel("模型名称", { exact: true }).fill(model);
    await form.getByRole("button", { name: "添加模型" }).click();
  }
  const rowOf = (model) => form.getByRole("list", { name: "模型列表" }).getByRole("listitem").filter({ hasText: model });
  const thinks = (model) => rowOf(model).getByRole("checkbox", { name: /支持思考/ });
  /** The row at 360 and at 1280: nothing sideways, and a picture of each when asked for. */
  const shoot = async (model, label) => {
    const before = page.viewportSize();
    for (const width of [360, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await rowOf(model).scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      const box = await rowOf(model).locator(".model-panel").boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      if (LEVEL_SHOTS) await rowOf(model).screenshot({ path: `${LEVEL_SHOTS}/levels-${label}-${width}.png` });
    }
    await page.setViewportSize(before);
  };

  // A model the catalogue does not know, not thinking: no control. Ticked 支持思考: the line and five boxes, all ticked.
  await rowOf("house-think").getByRole("button", { name: "高级设置：house-think" }).click();
  const levels = rowOf("house-think").getByRole("group", { name: "思考档位：house-think" });
  if (await thinks("house-think").isChecked()) await thinks("house-think").uncheck();
  await expect(levels).toHaveCount(0);
  await thinks("house-think").check();
  await expect(levels).toContainText("默认全部档位可选。这个模型不支持的，可以取消。");
  await expect(levels.getByRole("checkbox")).toHaveCount(5);
  for (const label of ["低", "中", "高", "很高", "最高"]) await expect(levels.getByRole("checkbox", { name: label, exact: true })).toBeChecked();
  // Each box's label is a 44 px target, at 360 too.
  await page.setViewportSize({ width: 360, height: 800 });
  for (const label of await levels.locator(".level-boxes label").all()) {
    const box = await label.boundingBox();
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  await shoot("house-think", "unknown-all");
  await levels.getByRole("checkbox", { name: "很高", exact: true }).uncheck();
  await levels.getByRole("checkbox", { name: "最高", exact: true }).uncheck();
  await expect(rowOf("house-think")).toContainText("思考档位：低、中、高");
  await shoot("house-think", "unknown-three");
  await rowOf("o3-mini").getByRole("button", { name: "高级设置：o3-mini" }).click();
  if (!(await thinks("o3-mini").isChecked())) await thinks("o3-mini").check();
  await form.getByRole("button", { name: "保存", exact: true }).click();
  await expect(toast(page, "供应商已保存")).toBeVisible();

  // Saved: the boxes are as they were left; the model the catalogue knows offers its reported levels (named) or every level.
  await providerRow(section, name).getByRole("button", { name: "编辑" }).click();
  await rowOf("house-think").getByRole("button", { name: "高级设置：house-think" }).click();
  for (const [label, on] of [["低", true], ["中", true], ["高", true], ["很高", false], ["最高", false]]) {
    expect(await levels.getByRole("checkbox", { name: label, exact: true }).isChecked()).toBe(on);
  }
  await rowOf("o3-mini").getByRole("button", { name: "高级设置：o3-mini" }).click();
  const known = rowOf("o3-mini").getByRole("radiogroup", { name: "思考档位：o3-mini" });
  await expect(known).toContainText("资料显示支持：低、中、高。");
  await expect(known.getByRole("radio", { name: "资料里的档位", exact: true })).not.toBeChecked();
  await expect(known.getByRole("radio", { name: "全部档位" })).toBeChecked();
  await expect(rowOf("o3-mini").getByRole("checkbox", { name: "很高", exact: true })).toHaveCount(0);
  await shoot("o3-mini", "known");
  await form.getByRole("button", { name: "返回" }).click();

  // The Agent form offers exactly what is left ticked (and 不思考), and every level for the model saved with 全部档位.
  await goTo(page, "Agent");
  await page.getByRole("button", { name: "创建 Agent", exact: true }).click();
  const agentForm = page.getByRole("region", { name: "创建 Agent" });
  const offered = async () => {
    await agentForm.getByLabel("思考程度", { exact: true }).click();
    const list = page.getByRole("listbox", { name: "思考程度", exact: true });
    const texts = await list.getByRole("option").allTextContents();
    await page.keyboard.press("Escape");
    await expect(list).toBeHidden();
    return texts.map((t) => t.trim());
  };
  await chooseModelUi(page, agentForm, "house-think");
  expect(await offered()).toEqual(["不思考", "低", "中", "高"]);
  await chooseModelUi(page, agentForm, "o3-mini");
  // (Every level its interface has: this provider speaks Chat Completions, where 最高 is sent as 很高, so the list ends there.)
  expect(await offered()).toEqual(["不思考", "低", "中", "高", "很高"]);
  // And the top it offers is one the save takes (fix round 4, F4: the write accepts exactly what the picker offers): picked,
  // saved, and still 很高 when its form is opened again.
  const agentName = `档位${uniq(4)}`;
  await agentForm.getByLabel("名称", { exact: true }).fill(agentName);
  await chooseOptionUi(page, agentForm, "思考程度", "很高");
  await agentForm.getByRole("button", { name: "创建 Agent", exact: true }).click();
  await expect(chatPane(page, agentName)).toBeVisible();
  const detail = await openAgentDetail(page, agentName);
  await detail.getByRole("button", { name: "编辑" }).click();
  const editForm = page.getByRole("region", { name: "编辑 Agent" });
  await expect(editForm.getByLabel("思考程度", { exact: true })).toContainText("很高");
});
