// Every modal surface in a real browser, on a 402 px phone (touch Chromium): the page behind is inert (`#root`), the focus is in
// the dialog and Tab stays there, Esc closes it and the focus is back on what opened it, and Back closes the dialog only — the
// address and the page under it stay. One screenshot of each (E2E_DIALOG_SHOTS: the folder; else test-results/dialog-shots).
// Then, at 375 px, the focus after opening a conversation and after Back, the tab's title, and the toast's live region and taps.
// (Composition — Pinyin, Japanese — is driven by its events in tests/keys.test.jsx; a real input method needs a person.)
import path from "node:path";
import { mkdirSync } from "node:fs";
import { test, expect } from "./support/fixtures.mjs";
import { befriend, createGroupApi, uniq } from "./support/accounts.mjs";
import { agentApi } from "./support/tools.mjs";
import { chatPane, goTo, listRow, openAgentDetail, openChat, openContact, pickAvatarUi, sendFile } from "./support/app.mjs";
import { png } from "./support/files.mjs";
import { OUTPUT_DIR } from "./support/env.mjs";

const PHONE = { viewport: { width: 402, height: 874 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 };
const SMALL = { viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 };
const SHOTS = process.env.E2E_DIALOG_SHOTS || path.join(OUTPUT_DIR, "dialog-shots");
mkdirSync(SHOTS, { recursive: true });

/** Back at the top-level lists (a phone shows its tab bar only there): a fresh load of the app. */
const home = async (page) => {
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
};
/** A screenshot once nothing is moving in (a sheet slides in; endless ones such as the typing dots are left alone). */
async function shoot(page, name) {
  await expect.poll(() => page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running" && a.effect?.getTiming().iterations !== Infinity).length)).toBe(0);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}
const rootInert = (page) => page.evaluate(() => document.getElementById("root").inert === true);
const focusIn = (locator) => locator.evaluate((el) => el.contains(document.activeElement));
const focused = (locator) => locator.evaluate((el) => el === document.activeElement);

/**
 * `open()` opens the dialog `dialog` from `opener`: it holds the contract (inert page, focus in, Tab round, Esc closes, focus
 * back), is photographed as `shot`, and — opened again — Back closes it and leaves the address and the page as they were.
 */
async function contract(page, { open, dialog, opener, shot, tabs = 8 }) {
  await open();
  await expect(dialog).toBeVisible();
  await expect.poll(() => rootInert(page), { message: `${shot}: the page behind is inert` }).toBe(true);
  expect(await focusIn(dialog), `${shot}: the focus is in the dialog`).toBe(true);
  for (let i = 0; i < tabs; i += 1) {
    await page.keyboard.press("Tab");
    expect(await focusIn(dialog), `${shot}: Tab ${i + 1} stays inside`).toBe(true);
  }
  await shoot(page, shot);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(await rootInert(page), `${shot}: nothing inert after`).toBe(false);
  expect(await focused(opener), `${shot}: the focus is back on its opener`).toBe(true);

  const at = page.url();
  await open();
  await expect(dialog).toBeVisible();
  await page.goBack();
  await expect(dialog).toBeHidden();
  expect(page.url(), `${shot}: Back did not move the page`).toBe(at);
  expect(await rootInert(page)).toBe(false);
}

test("the chats', contacts' and groups' dialogs at 402 px: inert page, focus in and back, Esc, and Back closes only the dialog", async ({ people }) => {
  const ann = await people.member("Ann", { contextOptions: PHONE });
  const bo = await people.member("Bo");
  const cy = await people.member("Cy");
  await befriend(ann, bo);
  await befriend(ann, cy);
  const title = `对话框${uniq(4)}`;
  await createGroupApi(ann, [bo, cy], title);
  const page = ann.page;

  // 发起群聊, from the 新建 menu (whose item goes away with the menu: the focus comes back to 新建).
  await goTo(page, "消息");
  const plus = page.getByRole("button", { name: "新建", exact: true });
  await contract(page, {
    open: async () => {
      await plus.click();
      await page.getByRole("button", { name: "发起群聊" }).click();
    },
    dialog: page.getByRole("dialog", { name: "发起群聊" }),
    opener: plus,
    shot: "dialog-new-group-402",
  });

  // 添加好友, in 通讯录.
  await goTo(page, "通讯录");
  const add = page.getByRole("button", { name: "添加好友", exact: true });
  await contract(page, { open: () => add.click(), dialog: page.getByRole("dialog", { name: "添加好友" }), opener: add, shot: "dialog-add-friend-402" });

  // 解除好友, on a contact's card.
  await openContact(page, bo.displayName);
  const unfriend = page.getByRole("button", { name: "解除好友" });
  await contract(page, { open: () => unfriend.click(), dialog: page.getByRole("dialog", { name: `解除与${bo.displayName}的好友关系` }), opener: unfriend, shot: "dialog-unfriend-402" });

  // 拉黑, in a direct chat's 会话资料.
  await home(page);
  const chat = await openChat(page, bo.displayName);
  await chat.getByRole("button", { name: "会话资料" }).click();
  const block = page.getByRole("button", { name: "拉黑此用户" });
  await contract(page, { open: () => block.click(), dialog: page.getByRole("dialog", { name: `拉黑${bo.displayName}` }), opener: block, shot: "dialog-block-402" });
  await page.getByRole("button", { name: "关闭", exact: true }).click();

  // The picture viewer.
  await sendFile(page, bo.displayName, { name: "风景.png", mimeType: "image/png", buffer: png(640, 480) }, "选择图片");
  const picture = chatPane(page, bo.displayName).locator("button[data-image]").first();
  await contract(page, { open: () => picture.click(), dialog: page.getByRole("dialog", { name: "风景.png" }), opener: picture, shot: "dialog-viewer-402", tabs: 4 });

  // 添加成员, 移除, 退出群聊, on 群资料.
  await home(page);
  const group = await openChat(page, title);
  await group.getByRole("button", { name: "群资料" }).click();
  const profile = page.getByRole("region", { name: "群资料" });
  await expect(profile).toBeVisible();
  const addMember = profile.getByRole("button", { name: "添加成员" });
  await contract(page, { open: () => addMember.click(), dialog: page.getByRole("dialog", { name: "添加成员" }), opener: addMember, shot: "dialog-add-member-402" });
  const remove = profile.getByRole("listitem").filter({ hasText: cy.displayName }).getByRole("button", { name: "移除" });
  await contract(page, { open: () => remove.click(), dialog: page.getByRole("dialog", { name: `移除${cy.displayName}` }), opener: remove, shot: "dialog-remove-member-402" });
  await profile.getByRole("tab", { name: "群设置" }).click();
  const leave = profile.getByRole("button", { name: "退出本群" });
  await contract(page, { open: () => leave.click(), dialog: page.getByRole("dialog", { name: `退出群聊「${title}」` }), opener: leave, shot: "dialog-leave-402" });

  // 调整头像, from 设置 › 我的资料.
  await home(page);
  await goTo(page, "设置");
  await page.getByText("我的资料", { exact: true }).first().click();
  const change = page.getByRole("button", { name: "更换头像", exact: true });
  await contract(page, {
    open: () => pickAvatarUi(page, "更换头像", { name: "头像.png", mimeType: "image/png", buffer: png(600, 400) }),
    dialog: page.getByRole("dialog", { name: "调整头像" }),
    opener: change,
    shot: "dialog-avatar-402",
  });
});

test("a dialog's own action never leaves the focus on <body>; Forward onto a closed dialog stays on the page and one Back leaves it", async ({ people }) => {
  const ann = await people.member("Ann", { contextOptions: PHONE });
  const bo = await people.member("Bo");
  const cy = await people.member("Cy");
  await befriend(ann, bo);
  await befriend(ann, cy);
  const title = `动作${uniq(4)}`;
  await createGroupApi(ann, [bo, cy], title);
  const page = ann.page;
  const onBody = () => page.evaluate(() => document.activeElement === document.body);

  // 移除 › 确认移除: the member's row and its 移除 go; the focus stays on the page.
  const group = await openChat(page, title);
  await group.getByRole("button", { name: "群资料" }).click();
  const profile = page.getByRole("region", { name: "群资料" });
  const remove = profile.getByRole("listitem").filter({ hasText: cy.displayName }).getByRole("button", { name: "移除" });
  await remove.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("dialog", { name: `移除${cy.displayName}` }).getByRole("button", { name: "确认移除" }).click();
  await expect(profile.getByRole("listitem").filter({ hasText: cy.displayName })).toHaveCount(0);
  expect(await onBody(), "移除: the focus is not on <body>").toBe(false);

  // 退出群聊 › 确认退出: the page changes to the list; the focus is on it.
  await profile.getByRole("tab", { name: "群设置" }).click();
  await profile.getByRole("button", { name: "退出本群" }).click();
  await page.getByRole("dialog", { name: `退出群聊「${title}」` }).getByRole("button", { name: "确认退出" }).click();
  await expect(listRow(page, title)).toHaveCount(0);
  expect(await onBody(), "退出群聊: the focus is not on <body>").toBe(false);
  expect(await page.evaluate(() => Boolean(document.activeElement.closest(".list-col")))).toBe(true);

  // Forward onto a dialog closed by its own button: nothing opens, the page stays, and one Back leaves the page.
  await goTo(page, "通讯录");
  const at = page.url();
  await page.getByRole("button", { name: "添加好友", exact: true }).click();
  const add = page.getByRole("dialog", { name: "添加好友" });
  await add.getByRole("button", { name: "完成" }).click();
  await expect(add).toBeHidden();
  await page.goForward();
  await expect(add).toBeHidden();
  expect(page.url()).toBe(at);
  await page.goBack();
  await expect.poll(() => page.url()).not.toBe(at);
});

test("an Agent's dialogs and the model picker's sheet at 402 px", async ({ people }) => {
  const ann = await people.member("Ann", { contextOptions: PHONE });
  const page = ann.page;
  const name = `助手${uniq(4)}`;
  await agentApi(ann, { name });
  await page.reload();

  // 开始新话题, in the Agent conversation's 会话资料.
  const chat = await openChat(page, name);
  await chat.getByRole("button", { name: "会话资料" }).click();
  const topic = page.getByRole("button", { name: "开始新话题" });
  await contract(page, { open: () => topic.click(), dialog: page.getByRole("dialog", { name: "开始新话题" }), opener: topic, shot: "dialog-new-topic-402" });
  await page.getByRole("button", { name: "关闭", exact: true }).click();

  // 删除 Agent, on its page.
  await home(page);
  const detail = await openAgentDetail(page, name);
  const remove = detail.getByRole("button", { name: "删除 Agent" });
  await contract(page, { open: () => remove.click(), dialog: page.getByRole("dialog", { name: `删除${name}` }), opener: remove, shot: "dialog-delete-agent-402" });

  // The model picker on a phone is a sheet: a modal layer too (the page inert, the focus in its search), and Back closes the sheet only.
  await detail.getByRole("button", { name: "编辑" }).click();
  const trigger = page.getByLabel("模型", { exact: true });
  await trigger.click();
  const search = page.getByRole("combobox", { name: "搜索模型" });
  await expect(search).toBeFocused();
  await expect.poll(() => rootInert(page)).toBe(true);
  await shoot(page, "sheet-model-picker-402");
  const at = page.url();
  await page.goBack();
  await expect(search).toBeHidden();
  expect(page.url()).toBe(at);
  expect(await rootInert(page)).toBe(false);
  await expect(trigger).toBeFocused();
});

test("a provider's dialogs at 402 px: 同步模型 and 删除", async ({ people }) => {
  const ann = await people.member("Ann", { contextOptions: PHONE });
  const page = ann.page;
  const name = `供应商${uniq(4)}`;
  await goTo(page, "设置");
  await page.getByText("模型供应商", { exact: true }).first().click();
  await page.getByRole("button", { name: "添加供应商" }).click();
  const form = page.getByRole("region", { name: "添加模型供应商" });
  await form.getByLabel("名称", { exact: true }).fill(name);
  // (An https address that is stored and never answers: 同步模型 says it could not reach it, inside the dialog.)
  await form.getByLabel("接口地址", { exact: true }).fill("https://api.example.test/v1");
  await form.getByLabel("密钥", { exact: true }).fill(`sk-e2e-${uniq(12)}`);
  await form.getByRole("button", { name: "保存并选择模型", exact: true }).click();
  const sync = page.getByRole("dialog", { name: new RegExp(`^${name} 的模型`) });
  await expect(sync).toBeVisible();
  await expect.poll(() => rootInert(page)).toBe(true);
  await shoot(page, "dialog-sync-models-402");
  await page.keyboard.press("Escape");
  await expect(sync).toBeHidden();
  const edit = page.getByRole("region", { name: "编辑模型供应商" });
  const again = edit.getByRole("button", { name: "同步模型" });
  await contract(page, { open: () => again.click(), dialog: sync, opener: again, shot: "dialog-sync-models-again-402", tabs: 4 });
  await edit.getByRole("button", { name: /返回/ }).click();
  const row = page.getByRole("list", { name: "我的模型供应商" }).getByRole("listitem").filter({ hasText: name });
  const remove = row.getByRole("button", { name: "删除", exact: true });
  await contract(page, { open: () => remove.click(), dialog: page.getByRole("dialog", { name: `删除「${name}」` }), opener: remove, shot: "dialog-delete-provider-402" });
});

test("at 375 px the focus follows the page: a conversation's heading, then the row again after Back; the tab is titled", async ({ people }) => {
  const ann = await people.member("Ann", { contextOptions: SMALL });
  const bo = await people.member("Bo");
  await befriend(ann, bo);
  const page = ann.page;
  await goTo(page, "消息");
  await expect(page).toHaveTitle("消息 · Haiyo");
  const row = listRow(page, bo.displayName).first();
  await row.focus();
  await page.keyboard.press("Enter");
  const chat = chatPane(page, bo.displayName);
  await expect(chat).toBeVisible();
  await expect(chat.getByRole("heading", { level: 2 })).toBeFocused();
  await expect(page).toHaveTitle(`${bo.displayName} · 消息 · Haiyo`);
  await page.goBack();
  await expect(row).toBeFocused();
  await expect(page).toHaveTitle("消息 · Haiyo");
  await row.click();
  await chat.getByRole("button", { name: "返回列表" }).click();
  await expect(row).toBeFocused();
  // Nothing is ever left on <body>.
  expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);
});

test("the toast: a live region there before any message, at the top inside the safe area, and a tap goes through it", async ({ people }) => {
  const ann = await people.member("Ann", { contextOptions: SMALL });
  const bo = await people.member("Bo");
  await befriend(ann, bo);
  const page = ann.page;
  const region = page.locator(".toast-region");
  await expect(region).toHaveAttribute("role", "status");
  await expect(region).toHaveText("");
  expect(await region.evaluate((el) => el.parentElement === document.body && !el.closest("[inert]"))).toBe(true);
  // A message: 已复制, from a message's own menu.
  const chat = await openChat(page, bo.displayName);
  const box = chat.getByRole("textbox", { name: "消息内容" });
  await box.fill("复制这一句");
  await box.press("Enter");
  const bubble = chat.locator(".bubble").filter({ hasText: "复制这一句" });
  await bubble.click({ button: "right" });
  await page.getByRole("menuitem", { name: "复制" }).click();
  const shown = region.locator(".toast");
  await expect(shown).toHaveText("已复制");
  const place = await shown.boundingBox();
  expect(place.y).toBeLessThan(80);
  expect(place.x).toBeGreaterThanOrEqual(16);
  expect(place.x + place.width).toBeLessThanOrEqual(375 - 16);
  // It takes no tap: what is under its middle is the page, not the toast.
  const under = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest(".toast-region") ?? null, { x: place.x + place.width / 2, y: place.y + place.height / 2 });
  expect(under).toBeNull();
  await shoot(page, "toast-375");
});
