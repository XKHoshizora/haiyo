// Agent social (lane A's web, ring 1a): finding and adding an Agent with the disclosure, the owner's yes, the social chat from both sides
// (the visitor's disclosure, the owner's supervision line and their 主人 mark), the Agent card's actions, the owner's setting with its
// dry run, and 停止往来 and 恢复往来 on a profile. On a phone (402×874, the screens are saved under
// .superpowers/sdd/2026-11-22-polish/sociala-shots/). Runs with the site's Agent social switch on (restarting the service for this file).
// No model call is made: nothing here asks the Agent to reply (that is lane B's run, the integration lane's spec).
import { mkdirSync } from "node:fs";
import path from "node:path";
import { test, expect } from "./support/fixtures.mjs";
import { befriend } from "./support/accounts.mjs";
import { agentApi } from "./support/tools.mjs";
import { chatPane, composer, goTo, listRow, messageList, openAgentDetail, openContact, sendText } from "./support/app.mjs";
import { canControlService, restartService } from "./support/control.mjs";
import { WEB_DIR } from "./support/env.mjs";

// 402×874 by default; E2E_SHOT_WIDTH=360 runs it at 360×740 (the screens are saved with the suffix -360).
const SMALL = process.env.E2E_SHOT_WIDTH === "360";
const BIG_PHONE = { viewport: SMALL ? { width: 360, height: 740 } : { width: 402, height: 874 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 };
const SHOTS = path.resolve(WEB_DIR, "..", "..", "..", "..", ".superpowers", "sdd", "2026-11-22-polish", "sociala-shots");
const shot = async (page, name) => {
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, `${name}${SMALL ? "-360" : ""}.png`), animations: "disabled", caret: "hide" });
};
const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const tall = async (locator) => {
  for (const el of await locator.all()) expect((await el.boundingBox()).height, "a 44px target").toBeGreaterThanOrEqual(43.5);
};

test.beforeAll(async () => {
  if (canControlService) await restartService({ SOCIAL: JSON.stringify({ enabled: true }) });
});
test.afterAll(async () => {
  if (canControlService) await restartService({});
});

test("an owner's Agent is found by its full handle, added with the disclosure, let in by the owner, and talked to while the owner watches", async ({ people }) => {
  test.skip(!canControlService, "needs the Agent social switch on, which only the local suite's service can be restarted with");
  const ann = await people.member("Ann", { contextOptions: BIG_PHONE });
  const bo = await people.member("Bo", { contextOptions: BIG_PHONE });
  const agent = await agentApi(ann, { name: `帮手${Date.now() % 10000}`, intro: "陪你聊天" });
  const full = String(agent.handle).replace(/^@/, "");
  const name = agent.name;

  // ── Bo finds it: the card, and the disclosure before the button.
  await goTo(bo.page, "通讯录");
  await bo.page.getByRole("button", { name: "添加好友" }).click();
  const dlg = bo.page.getByRole("dialog");
  await expect(dlg.getByText("人的账号名，或 Agent 的完整账号名，例如 ann_li.helper")).toBeVisible();
  await dlg.getByLabel("对方的账号名").fill(full);
  await dlg.getByRole("button", { name: "查找" }).click();
  const note = dlg.getByTestId("social-disclosure");
  await expect(note).toHaveText(`这是${ann.displayName}的 Agent。${ann.displayName}能看到你们的对话，也可能插话。`);
  await expect(dlg.getByText(`主人：${ann.displayName}`)).toBeVisible();
  await expect(dlg.getByRole("button", { name: "加为联系人" })).toBeVisible();
  expect(await noSideways(bo.page)).toBe(true);
  await tall(dlg.getByRole("button", { name: "加为联系人" }));
  await shot(bo.page, "a11a-add-agent-dialog");
  await dlg.getByRole("button", { name: "加为联系人" }).click();
  await expect(dlg.getByText("已发给它的主人，7 天内有效").first()).toBeVisible();
  await shot(bo.page, "a11a-add-agent-requested");
  await dlg.getByRole("button", { name: "完成" }).click();

  // ── Ann sees the request in her contacts, and lets Bo in.
  await ann.page.reload();
  await goTo(ann.page, "通讯录");
  await expect(ann.page.getByText("别人想加你的 Agent")).toBeVisible();
  const waiting = ann.page.locator(".social-row").filter({ hasText: bo.displayName });
  await expect(waiting).toBeVisible();
  await tall(waiting.getByRole("button"));
  expect(await noSideways(ann.page)).toBe(true);
  await shot(ann.page, "a11a-contacts-waiting");
  await waiting.getByRole("button", { name: "同意" }).click();
  await expect(waiting).toBeHidden();

  // ── Bo has it as a contact and opens the chat: the disclosure in the header, always.
  await bo.page.reload();
  await goTo(bo.page, "通讯录");
  const mine = bo.page.locator(".social-row").filter({ hasText: name });
  await expect(mine.getByRole("button", { name: "聊天" })).toBeVisible();
  await shot(bo.page, "a11a-contacts-agent-row");
  await mine.getByRole("button", { name: "聊天" }).click();
  const chat = chatPane(bo.page, name);
  await expect(chat).toBeVisible();
  await expect(chat.getByTestId("social-note")).toHaveText(`这是${ann.displayName}的 Agent。${ann.displayName}能看到你们的对话，也可能插话。`);
  expect(await noSideways(bo.page)).toBe(true);
  await sendText(bo.page, name, "你好，想问个事");
  await shot(bo.page, "a12a-social-chat-visitor");

  // ── The Agent's card: 举报, 拉黑, 移除.
  await bo.page.getByRole("button", { name: "会话资料" }).click();
  const side = bo.page.locator(".side");
  for (const label of ["举报", "拉黑", "移除"]) await expect(side.getByRole("button", { name: label })).toBeVisible();
  await tall(side.getByRole("button", { name: "举报" }));
  await shot(bo.page, "a12b-agent-card-actions");
  await side.getByRole("button", { name: "举报" }).click();
  const report = bo.page.getByRole("dialog");
  await expect(report.getByRole("heading", { name: `举报${name}` })).toBeVisible();
  await tall(report.getByRole("radio").locator(".."));
  await shot(bo.page, "a12b-report-dialog");
  await report.getByRole("radio", { name: "骚扰" }).check();
  await report.getByRole("button", { name: "提交举报" }).click();
  await expect(bo.page.getByText("已提交举报")).toBeVisible();
  await expect(report).toBeHidden();

  // ── Ann watches it in the Agent's 「别人」 tab, and writes as 主人.
  await openAgentDetail(ann.page, name);
  await ann.page.getByRole("tab", { name: "别人" }).click();
  const tab = ann.page.getByRole("region", { name: "Agent 管理" });
  await expect(tab.getByRole("group", { name: "谁可以加它为好友" })).toBeVisible();
  for (const label of ["需要我同意", "我的联系人可以直接加", "不让别人加"]) await expect(tab.getByRole("radio", { name: label })).toBeVisible();
  await tall(tab.getByRole("radio").locator(".."));
  expect(await noSideways(ann.page)).toBe(true);
  await shot(ann.page, "a11b-others-tab");
  await tab.getByRole("list", { name: "它和别人的对话" }).getByRole("button").first().click();
  const watched = chatPane(ann.page, `${name} · ${bo.displayName}`);
  await expect(watched).toBeVisible();
  await expect(watched.getByTestId("social-note")).toHaveText(`你在旁观${name}和${bo.displayName}的对话，你说的话会标成主人`);
  await expect(messageList(watched).getByText("你好，想问个事")).toBeVisible();
  await composer(watched).fill("我是它的主人，有事问我");
  await composer(watched).press("Enter");
  const mark = messageList(watched).locator("li.msg").filter({ hasText: "我是它的主人，有事问我" });
  await expect(mark).toBeVisible();
  await expect(mark.locator(".tag", { hasText: "主人" })).toBeVisible();
  expect(await noSideways(ann.page)).toBe(true);
  await shot(ann.page, "a12a-social-chat-owner");
  // (The conversation is the Agent's page's, not a row of Ann's main list.)
  await ann.page.goto("/");
  await goTo(ann.page, "消息");
  await expect(listRow(ann.page, `${name} · ${bo.displayName}`)).toHaveCount(0);

  // ── Bo sees the owner's words marked 主人 too.
  const ownerLine = messageList(chat).locator("li.msg").filter({ hasText: "我是它的主人，有事问我" });
  await expect(ownerLine.locator(".tag", { hasText: "主人" })).toBeVisible();
});

test("changing who may add it asks first how many it would end; after it, the visitor is told once that they cannot chat; the owner can stop dealings with them and lift it", async ({ people }) => {
  test.skip(!canControlService, "needs the Agent social switch on, which only the local suite's service can be restarted with");
  const ann = await people.member("Ann", { contextOptions: BIG_PHONE });
  const bo = await people.member("Bo", { contextOptions: BIG_PHONE });
  await befriend(ann, bo);
  const agent = await agentApi(ann, { name: `帮手${Date.now() % 10000}` });
  const name = agent.name;
  // Ann's setting lets her contacts in directly: Bo is her friend, so his add is live at once.
  const put = await ann.request.put(`/api/agents/${agent.id}/contact-policy`, { data: { policy: "contacts", picked: false, picks: [] } });
  expect(put.status()).toBe(200);
  const added = await bo.request.post("/api/agent-contacts", { data: { agentId: agent.id } });
  expect(added.status()).toBe(201);
  await bo.page.reload();
  await listRow(bo.page, name).first().click();
  const chat = chatPane(bo.page, name);
  await expect(composer(chat)).toBeVisible();

  await openAgentDetail(ann.page, name);
  await ann.page.getByRole("tab", { name: "别人" }).click();
  const tab = ann.page.getByRole("region", { name: "Agent 管理" });
  await tab.getByRole("radio", { name: "不让别人加" }).check();
  await tab.getByRole("button", { name: "保存" }).click();
  const ask = ann.page.getByRole("dialog");
  await expect(ask.getByRole("heading", { name: "这样会让 1 个人不能再和它聊天" })).toBeVisible();
  await tall(ask.locator(".modal-foot").getByRole("button"));
  await shot(ann.page, "a11b-dry-run-dialog");
  await ask.getByRole("button", { name: "确定" }).click();
  await expect(ask).toBeHidden();

  // Bo: no input, the reason once, nothing about who or why.
  await expect(chat.getByText("你已不能再和它聊天。")).toHaveCount(1);
  await expect(composer(chat)).toHaveCount(0);
  await expect(chat.locator(".social-note")).toBeVisible();
  await shot(bo.page, "a12a-social-chat-refused");

  // 停止往来 and 恢复往来 on Bo's card (they have an Agent conversation between them).
  await ann.page.goto("/");
  await openContact(ann.page, bo.displayName);
  const card = ann.page.getByRole("region", { name: "联系人卡片" });
  // Whether I stopped them is known only from lane B's use page (`GET /api/me/others-use`): without it (this lane alone) the profile
  // offers neither 停止往来 nor 恢复往来 (A-5 review m3b). With both lanes merged the section is there, and the rest runs.
  await ann.page.waitForTimeout(1500);
  if (!(await card.getByRole("heading", { name: "Agent 往来" }).isVisible())) {
    await expect(card.getByRole("button", { name: /^(停止|恢复)往来$/ })).toHaveCount(0);
    await shot(ann.page, "a12b-profile-without-the-stopped-list");
    return;
  }
  await card.getByRole("button", { name: "停止往来" }).click();
  const confirm = ann.page.getByRole("dialog");
  await expect(confirm.getByRole("heading", { name: `停止和${bo.displayName}往来` })).toBeVisible();
  await shot(ann.page, "a12b-stop-dialog");
  await confirm.getByRole("button", { name: "停止往来" }).click();
  await expect(card.getByRole("button", { name: "恢复往来" })).toBeVisible();
  expect(await noSideways(ann.page)).toBe(true);
  await shot(ann.page, "a12b-resume-on-profile");
  // Bo's side says nothing of it: the same one sentence.
  await expect(chat.getByText("你已不能再和它聊天。")).toHaveCount(1);
  await card.getByRole("button", { name: "恢复往来" }).click();
  await expect(card.getByRole("button", { name: "停止往来" })).toBeVisible();
});
