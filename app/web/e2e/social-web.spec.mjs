// Agent social (lane A's web, ring 1a): finding and adding an Agent with the disclosure, the owner's yes, the social chat from both sides
// (the visitor's disclosure, the owner's supervision line and their 主人 mark), the Agent card's actions, the owner's setting with its
// dry run, and 停止往来 and 恢复往来 on a profile. On a phone, at 402×874 and at 360×740 (the screens are taken with E2E_INTEG_SHOTS=1:
// support/shots.mjs `integShot`). Runs with the site's Agent social switch on (restarting the service for this file).
// No model call is made: nothing here asks the Agent to reply (that is e2e/social.spec.mjs).
import { test, expect } from "./support/fixtures.mjs";
import { befriend } from "./support/accounts.mjs";
import { agentApi } from "./support/tools.mjs";
import { chatPane, composer, goTo, listRow, messageList, openAgentDetail, openContact, sendText } from "./support/app.mjs";
import { canControlService, restartService } from "./support/control.mjs";
import { judgeStub } from "./support/judge-stub.mjs";
import { integShot as shot } from "./support/shots.mjs";

const SIZES = [
  ["402x874", { viewport: { width: 402, height: 874 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }],
  ["360x740", { viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }],
];
const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const tall = async (locator) => {
  for (const el of await locator.all()) expect((await el.boundingBox()).height, "a 44px target").toBeGreaterThanOrEqual(43.5);
};

test.beforeAll(async () => {
  if (!canControlService) return;
  await restartService({ SOCIAL: JSON.stringify({ enabled: true }) });
  // The switch just came on: the persona aid now reads every Agent the suite has made so far, a judgement request per sentence. Nothing
  // here starts before that is over (`judgeStub.quiet`): the service is not busy with it while this spec's screens are measured.
  test.setTimeout(360_000);
  const backlog = await judgeStub.quiet();
  console.log(`[social-web.spec.mjs] the persona aid's backlog at the switch-on: ${backlog} sentence(s) asked before it was quiet`);
});
test.afterAll(async () => {
  if (canControlService) await restartService({});
});

for (const [size, BIG_PHONE] of SIZES) {
test(`${size}: an owner's Agent is found by its full handle, added with the disclosure, let in by the owner, and talked to while the owner watches`, async ({ people }) => {
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
  // (The dialog searches: a name or an account name; the full account name of an Agent is found on 查找: e2e/find-agent.spec.mjs.)
  await expect(dlg.getByText("输入昵称或账号名。找不认识的人，要输入对方完整的账号名。")).toBeVisible();
  await dlg.getByLabel("昵称或账号名").fill(full);
  await tall(dlg.getByRole("button", { name: "查找" }));
  await expect(dlg.getByRole("heading", { name: "添加好友或 Agent" })).toBeVisible();
  await dlg.getByRole("button", { name: "查找" }).click();
  const note = dlg.getByTestId("social-disclosure");
  await expect(note).toHaveText(`这是${ann.displayName}的 Agent。${ann.displayName}能看到你们的对话，也可能插话。`);
  await expect(dlg.getByText(`主人：${ann.displayName}`)).toBeVisible();
  await expect(dlg.getByRole("button", { name: `添加${name}` })).toBeVisible();
  expect(await noSideways(bo.page)).toBe(true);
  await tall(dlg.getByRole("button", { name: `添加${name}` }));
  await shot(bo.page, "01-add-agent-dialog");
  await dlg.getByRole("button", { name: `添加${name}` }).click();
  await expect(dlg.getByText(`已发给${ann.displayName}，等对方同意。7 天没有回应会自动取消。`)).toBeVisible();
  await shot(bo.page, "02-add-agent-requested");
  await dlg.getByRole("button", { name: "完成" }).click();
  // Bo's own waiting request in his contacts.
  const asked = bo.page.locator(".social-row").filter({ hasText: "等主人同意" });
  await expect(asked).toBeVisible();
  expect(await noSideways(bo.page)).toBe(true);
  await shot(bo.page, "03-visitor-contacts-my-request");

  // ── Ann sees the request in her contacts, and lets Bo in.
  await ann.page.reload();
  await goTo(ann.page, "通讯录");
  await expect(ann.page.getByText("别人想添加我的 Agent")).toBeVisible();
  const waiting = ann.page.locator(".social-row").filter({ hasText: bo.displayName });
  await expect(waiting).toBeVisible();
  await tall(waiting.getByRole("button"));
  expect(await noSideways(ann.page)).toBe(true);
  await shot(ann.page, "04-owner-contacts-request-waiting");
  await waiting.getByRole("button", { name: "同意" }).click();
  await expect(waiting).toBeHidden();

  // ── Bo has it as a contact and opens the chat: the disclosure in the header, always.
  await bo.page.reload();
  await goTo(bo.page, "通讯录");
  const mine = bo.page.locator(".social-row").filter({ hasText: name });
  await expect(mine.getByRole("button", { name: "聊天" })).toBeVisible();
  await shot(bo.page, "05-visitor-contacts-agent-row");
  await mine.getByRole("button", { name: "聊天" }).click();
  const chat = chatPane(bo.page, name);
  await expect(chat).toBeVisible();
  await expect(chat.getByTestId("social-note")).toHaveText(`这是${ann.displayName}的 Agent。${ann.displayName}能看到你们的对话，也可能插话。`);
  expect(await noSideways(bo.page)).toBe(true);
  await sendText(bo.page, name, "你好，想问个事");
  await shot(bo.page, "06-social-chat-visitor");

  // ── The Agent's card: 举报, 拉黑, 移除.
  await bo.page.getByRole("button", { name: "会话资料" }).click();
  const side = bo.page.locator(".side");
  for (const label of ["举报", "拉黑", "移除"]) await expect(side.getByRole("button", { name: label })).toBeVisible();
  await tall(side.getByRole("button", { name: "举报" }));
  await shot(bo.page, "07-agent-card-actions");
  await side.getByRole("button", { name: "举报" }).click();
  const report = bo.page.getByRole("dialog");
  await expect(report.getByRole("heading", { name: `举报${name}` })).toBeVisible();
  await tall(report.getByRole("radio").locator(".."));
  await shot(bo.page, "08-report-dialog");
  await report.getByRole("radio", { name: "骚扰" }).check();
  await report.getByRole("button", { name: "提交举报" }).click();
  await expect(bo.page.getByText("已提交举报")).toBeVisible();
  await expect(report).toBeHidden();
  // 拉黑 and 移除 each ask first, in words about an Agent (both closed again: the chat goes on below).
  await side.getByRole("button", { name: "拉黑" }).click();
  const blockAsk = bo.page.getByRole("dialog");
  await expect(blockAsk.getByRole("heading", { name: `拉黑${name}` })).toBeVisible();
  await expect(blockAsk).toContainText(`你和${name}的对话会结束，${name}不再回你的话。聊天记录还在。`);
  await tall(blockAsk.locator(".modal-foot").getByRole("button"));
  await shot(bo.page, "09-block-agent-dialog");
  await blockAsk.getByRole("button", { name: "取消" }).click();
  await side.getByRole("button", { name: "移除" }).click();
  const leaveAsk = bo.page.getByRole("dialog");
  await expect(leaveAsk.getByRole("heading", { name: `移除${name}` })).toBeVisible();
  await tall(leaveAsk.locator(".modal-foot").getByRole("button"));
  await shot(bo.page, "10-remove-agent-dialog");
  await leaveAsk.getByRole("button", { name: "取消" }).click();

  // ── Ann watches it in the Agent's 「别人」 tab, and writes as 主人.
  await openAgentDetail(ann.page, name);
  await ann.page.getByRole("tab", { name: "别人" }).click();
  const tab = ann.page.getByRole("region", { name: "Agent 管理" });
  await expect(tab.getByRole("group", { name: `谁可以添加${name}` })).toBeVisible();
  for (const label of ["需要我同意", "我的好友可以直接添加", "不让别人添加"]) await expect(tab.getByRole("radio", { name: label })).toBeVisible();
  await tall(tab.getByRole("radio").locator(".."));
  expect(await noSideways(ann.page)).toBe(true);
  await shot(ann.page, "11-agent-others-tab");
  await tab.getByRole("list", { name: `${name}和别人的对话` }).getByRole("button").first().click();
  const watched = chatPane(ann.page, `${name}和${bo.displayName}`);
  await expect(watched).toBeVisible();
  await expect(watched.getByTestId("social-note")).toHaveText(`你在旁观${name}和${bo.displayName}的对话。你发言时，对方会看到你是主人。`);
  await expect(messageList(watched).getByText("你好，想问个事")).toBeVisible();
  await composer(watched).fill("我是它的主人，有事问我");
  await composer(watched).press("Enter");
  const mark = messageList(watched).locator("li.msg").filter({ hasText: "我是它的主人，有事问我" });
  await expect(mark).toBeVisible();
  await expect(mark.locator(".tag", { hasText: "主人" })).toBeVisible();
  expect(await noSideways(ann.page)).toBe(true);
  await shot(ann.page, "12-social-chat-owner-observer");
  // (The conversation is the Agent's page's, not a row of Ann's main list.)
  await ann.page.goto("/");
  await goTo(ann.page, "消息");
  await expect(listRow(ann.page, `${name}和${bo.displayName}`)).toHaveCount(0);

  // ── Bo sees the owner's words marked 主人 too.
  const ownerLine = messageList(chat).locator("li.msg").filter({ hasText: "我是它的主人，有事问我" });
  await expect(ownerLine.locator(".tag", { hasText: "主人" })).toBeVisible();
});

test(`${size}: changing who may add it asks first how many it would end; after it, the visitor is told once that they cannot chat; the owner can stop dealings with them and lift it`, async ({ people }) => {
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
  await tab.getByRole("radio", { name: "不让别人添加" }).check();
  await tab.getByRole("button", { name: "保存" }).click();
  const ask = ann.page.getByRole("dialog");
  await expect(ask.getByRole("heading", { name: "这样会影响 1 个人" })).toBeVisible();
  await tall(ask.locator(".modal-foot").getByRole("button"));
  await shot(ann.page, "13-narrowing-dry-run-dialog");
  await ask.getByRole("button", { name: "确定" }).click();
  await expect(ask).toBeHidden();

  // Bo: no input, the reason once, nothing about who or why.
  await expect(chat.getByText(`你现在不能和${name}聊天了。`)).toHaveCount(1);
  await expect(composer(chat)).toHaveCount(0);
  await expect(chat.locator(".social-note")).toBeVisible();
  await shot(bo.page, "14-social-chat-refused");

  // 停止往来 and 恢复往来 on Bo's card (they have an Agent conversation between them).
  await ann.page.goto("/");
  await openContact(ann.page, bo.displayName);
  const card = ann.page.getByRole("region", { name: "联系人卡片" });
  // Whether I stopped them comes from my own list (`GET /api/me/others-use`): the section must be there once it has answered (never
  // skipped by a timer: a slow or missing route fails here).
  expect((await ann.request.get("/api/me/others-use")).status()).toBe(200);
  await expect(card.getByRole("heading", { name: "和对方的 Agent 往来" })).toBeVisible();
  await tall(card.getByRole("button", { name: "停止往来" }));
  expect(await noSideways(ann.page)).toBe(true);
  await shot(ann.page, "15-profile-stop", { show: card.getByRole("button", { name: "停止往来" }) });
  await card.getByRole("button", { name: "停止往来" }).click();
  const confirm = ann.page.getByRole("dialog");
  await expect(confirm.getByRole("heading", { name: `停止和${bo.displayName}往来` })).toBeVisible();
  await expect(confirm).toContainText("以后想恢复：在“设置 › 别人怎么用我的 Agent”里找到对方，进入资料页点“恢复往来”。");
  await expect(confirm).toContainText("不会通知对方。对方会发现你的 Agent 不再回应，也可能因此猜到。");
  await tall(confirm.locator(".modal-foot").getByRole("button"));
  expect(await noSideways(ann.page)).toBe(true);
  await shot(ann.page, "16-stop-dialog");
  await confirm.getByRole("button", { name: "停止往来" }).click();
  await expect(card.getByRole("button", { name: "恢复往来" })).toBeVisible();
  await tall(card.getByRole("button", { name: "恢复往来" }));
  expect(await noSideways(ann.page)).toBe(true);
  await shot(ann.page, "17-profile-stopped-resume", { show: card.getByRole("button", { name: "恢复往来" }) });
  // Her use page lists him as stopped.
  expect((await (await ann.request.get("/api/me/others-use")).json()).stopped.map((x) => x.person.id)).toEqual([bo.id]);
  // Bo's side says nothing of it: the same one sentence.
  await expect(chat.getByText(`你现在不能和${name}聊天了。`)).toHaveCount(1);
  await card.getByRole("button", { name: "恢复往来" }).click();
  await expect(card.getByRole("button", { name: "停止往来" })).toBeVisible();
});
}
