// Finding someone's Agent (find-agent design, rulings D1-D10), on a phone (402×874): the add dialog finds a friend's Agent by a fragment of
// its name as one types; a stranger's exact account name lists their Agents; a group's member opens the Agent's card by its id (one nobody may
// add shows its face only); the owner copies the share link from the Agent's 「别人」 tab and the link opens the card; a link opened signed out
// survives the sign-up — whose verification mail opens another tab — and the sign-in. Every Agent ends in the existing add (the request waits for
// the owner). Runs with the site's Agent social switch on (restarting the service for this file). No model call is made.
import { test, expect } from "./support/fixtures.mjs";
import { befriend, mailLink, mintInvite, newIdentity } from "./support/accounts.mjs";
import { addApi, agentApi, groupApi, hanTag } from "./support/tools.mjs";
import { chatPane, goTo, listRow, openAgentDetail, rail, signInUi } from "./support/app.mjs";
import { canControlService, restartService } from "./support/control.mjs";
import { judgeStub } from "./support/judge-stub.mjs";
import { integShot as shot } from "./support/shots.mjs";
import { BASE_URL } from "./support/env.mjs";

const PHONE = { viewport: { width: 402, height: 874 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 };
const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const tall = async (locator) => {
  for (const el of await locator.all()) expect((await el.boundingBox()).height, "a 44px target").toBeGreaterThanOrEqual(43.5);
};
/** The dialogs open now: the top one is the last. */
const topDialog = (page) => page.getByRole("dialog").last();
const waiting = (owner) => `已发给${owner.displayName}，等对方同意。7 天没有回应会自动取消。`;

test.beforeAll(async () => {
  if (!canControlService) return;
  await restartService({ SOCIAL: JSON.stringify({ enabled: true }) });
  // (As social-web.spec.mjs: the persona aid reads the suite's Agents at the switch-on; nothing starts before that is over.)
  test.setTimeout(360_000);
  const backlog = await judgeStub.quiet();
  console.log(`[find-agent.spec.mjs] the persona aid's backlog at the switch-on: ${backlog} sentence(s) asked before it was quiet`);
});
test.afterAll(async () => {
  if (canControlService) await restartService({});
});

/** 通讯录 → 添加好友: the dialog. */
async function openAdd(page) {
  await goTo(page, "通讯录");
  await page.getByRole("button", { name: "添加好友" }).click();
  const dlg = page.getByRole("dialog");
  await expect(dlg.getByRole("heading", { name: "添加好友或 Agent" })).toBeVisible();
  return dlg;
}

test("a fragment of a name finds a friend's Agent as one types; its card asks the owner", async ({ people }) => {
  test.skip(!canControlService, "needs the Agent social switch on, which only the local suite's service can be restarted with");
  const ann = await people.member("Ann", { contextOptions: PHONE });
  const bo = await people.member("Bo", { contextOptions: PHONE });
  await befriend(ann, bo);
  const tag = hanTag(4);
  const agent = await agentApi(ann, { name: `厨师${tag}`, intro: "会做饭" });
  await bo.page.reload();

  const dlg = await openAdd(bo.page);
  await expect(dlg.getByText("输入昵称或账号名。找不认识的人，要输入对方完整的账号名。")).toBeVisible();
  // No 查找: the circle comes as one types.
  await dlg.getByLabel("昵称或账号名").fill(tag.slice(1));
  const friendsAgents = dlg.getByRole("list", { name: "好友的 Agent" });
  await expect(friendsAgents.getByText(agent.name, { exact: true })).toBeVisible();
  await expect(friendsAgents.getByText(`主人：${ann.displayName}`)).toBeVisible();
  expect(await noSideways(bo.page)).toBe(true);
  await tall(friendsAgents.getByRole("button"));
  await shot(bo.page, "find-01-search-friends-agent");
  await friendsAgents.getByRole("button").filter({ hasText: agent.name }).click();

  const card = topDialog(bo.page);
  await expect(card.getByRole("heading", { name: agent.name, exact: true })).toBeVisible();
  await expect(card.getByTestId("social-disclosure")).toHaveText(`这是${ann.displayName}的 Agent。${ann.displayName}能看到你们的对话，也可能插话。`);
  await expect(card.getByText("会做饭")).toBeVisible();
  await tall(card.getByRole("button", { name: `添加${agent.name}` }));
  await shot(bo.page, "find-02-agent-card");
  await card.getByRole("button", { name: `添加${agent.name}` }).click();
  await expect(card.getByText(waiting(ann))).toBeVisible();
  expect(await noSideways(bo.page)).toBe(true);
  // At 360 wide nothing goes sideways either.
  await bo.page.setViewportSize({ width: 360, height: 740 });
  expect(await noSideways(bo.page)).toBe(true);
});

test("a stranger's exact account name (Enter): the person and their Agents; one of them is asked for", async ({ people }) => {
  test.skip(!canControlService, "needs the Agent social switch on, which only the local suite's service can be restarted with");
  const bo = await people.member("Bo", { contextOptions: PHONE });
  const cy = await people.member("Cy", { open: false, contextOptions: PHONE });
  const agent = await agentApi(cy, { name: `向导${hanTag(4)}`, intro: "带你走走" });

  const dlg = await openAdd(bo.page);
  const field = dlg.getByLabel("昵称或账号名");
  await field.fill(cy.handle);
  await field.press("Enter");
  const found = dlg.getByRole("list", { name: "查找结果" });
  await expect(found.getByText(cy.displayName, { exact: true })).toBeVisible();
  await expect(found.getByRole("button", { name: "发送好友申请" })).toBeVisible();
  const theirs = dlg.getByRole("list", { name: `${cy.displayName}的 Agent` });
  await expect(theirs.getByText(agent.name, { exact: true })).toBeVisible();
  expect(await noSideways(bo.page)).toBe(true);
  await shot(bo.page, "find-03-exact-person");

  // The person's own profile lists them too.
  await found.getByRole("button").filter({ hasText: cy.displayName }).first().click();
  const profile = topDialog(bo.page);
  await expect(profile.getByRole("heading", { name: cy.displayName, exact: true })).toBeVisible();
  await expect(profile.getByText(`@${cy.handle}`)).toBeVisible();
  await expect(profile.getByRole("list", { name: `${cy.displayName}的 Agent` }).getByText(agent.name, { exact: true })).toBeVisible();
  await tall(profile.getByRole("button", { name: "发送好友申请" }));
  await shot(bo.page, "find-04-person-profile");
  await profile.getByRole("button", { name: "关闭" }).click();
  await expect(bo.page.getByRole("dialog")).toHaveCount(1);

  await theirs.getByRole("button").filter({ hasText: agent.name }).click();
  const card = topDialog(bo.page);
  await expect(card.getByTestId("social-disclosure")).toHaveText(`这是${cy.displayName}的 Agent。${cy.displayName}能看到你们的对话，也可能插话。`);
  await card.getByRole("button", { name: `添加${agent.name}` }).click();
  await expect(card.getByText(waiting(cy))).toBeVisible();
  const requests = await (await bo.request.get("/api/agent-contacts")).json();
  expect(requests.mine.map((r) => [r.agentId, r.state])).toEqual([[agent.id, "requested"]]);
});

test("a group's member is a button of its own: the Agent's card by its id, and the request; an Agent nobody may add shows its face only", async ({ people }) => {
  test.skip(!canControlService, "needs the Agent social switch on, which only the local suite's service can be restarted with");
  const ann = await people.member("Ann", { open: false, contextOptions: PHONE });
  const bo = await people.member("Bo", { contextOptions: PHONE });
  const dora = await people.member("Dora", { open: false, contextOptions: PHONE });
  await befriend(ann, bo);
  await befriend(ann, dora);
  const open = await agentApi(dora, { name: `厨师${hanTag(4)}`, intro: "会做饭" });
  const closed = await agentApi(dora, { name: `管家${hanTag(4)}` });
  const none = await dora.request.put(`/api/agents/${closed.id}/contact-policy`, { data: { policy: "none", picked: false, picks: [] } });
  expect(none.status()).toBe(200);
  const group = await groupApi(ann, [bo, dora]);
  await addApi(dora, group.id, open.id);
  await addApi(dora, group.id, closed.id);
  await bo.page.reload();

  await goTo(bo.page, "消息");
  await listRow(bo.page, group.title).first().click();
  await chatPane(bo.page, group.title).getByRole("button", { name: "会话资料" }).click();
  await bo.page.getByRole("button", { name: "打开群资料" }).click();
  const page = bo.page.getByRole("region", { name: "群资料" });
  const member = (name) => page.locator(".member-rows li").filter({ hasText: name }).getByRole("button").filter({ hasText: name });
  await expect(member(open.name)).toBeVisible();
  await tall(member(open.name));
  expect(await noSideways(bo.page)).toBe(true);
  await shot(bo.page, "find-05-group-members");

  // By the keyboard: the member's own button, then Enter.
  await member(open.name).focus();
  await bo.page.keyboard.press("Enter");
  const card = topDialog(bo.page);
  await expect(card.getByText(`主人：${dora.displayName}`)).toBeVisible();
  await expect(card.getByTestId("social-disclosure")).toBeVisible();
  await shot(bo.page, "find-06-group-agent-card");
  await card.getByRole("button", { name: `添加${open.name}` }).click();
  await expect(card.getByText(waiting(dora))).toBeVisible();
  await card.getByRole("button", { name: "关闭" }).click();
  await expect(bo.page.getByRole("dialog")).toHaveCount(0);

  // Nobody may add the other one: what the member list had — its name, picture and the Agent tag — and nothing else.
  await member(closed.name).click();
  const face = topDialog(bo.page);
  await expect(face.getByRole("heading", { name: closed.name, exact: true })).toBeVisible();
  await expect(face.locator(".tag", { hasText: "Agent" })).toBeVisible();
  await expect(face.getByRole("status")).toHaveCount(0);
  await expect(face.getByRole("button")).toHaveCount(1); // 关闭
  await expect(face).not.toContainText("主人");
  await expect(face).not.toContainText(dora.displayName);
  await shot(bo.page, "find-07-group-agent-hidden");
});

test("the owner copies the share link from the Agent's 「别人」 tab; signed in, the link opens the card over the list", async ({ people }) => {
  test.skip(!canControlService, "needs the Agent social switch on, which only the local suite's service can be restarted with");
  const ann = await people.member("Ann", { contextOptions: { ...PHONE, permissions: ["clipboard-read", "clipboard-write"] } });
  const bo = await people.member("Bo", { contextOptions: PHONE });
  const agent = await agentApi(ann, { name: `帮手${hanTag(4)}` });
  await ann.page.reload();

  await openAgentDetail(ann.page, agent.name);
  await ann.page.getByRole("tab", { name: "别人" }).click();
  const tab = ann.page.getByRole("region", { name: "Agent 管理" });
  await expect(tab.getByText(`把链接发给别人，对方打开就能找到${agent.name}。`)).toBeVisible();
  await tall(tab.getByRole("button", { name: "复制链接" }));
  await tab.getByRole("button", { name: "复制链接" }).click();
  await expect(ann.page.getByText("已复制")).toBeVisible();
  const link = await ann.page.evaluate(() => navigator.clipboard.readText());
  expect(link).toBe(`${BASE_URL}/a/${agent.id}`);
  await shot(ann.page, "find-08-copy-link");

  await bo.page.goto(new URL(link).pathname);
  await expect(rail(bo.page)).toHaveCount(1);
  const card = topDialog(bo.page);
  await expect(card.getByRole("heading", { name: agent.name, exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: `添加${agent.name}` })).toBeVisible();
  await expect(bo.page).toHaveURL(`${BASE_URL}/`);
  expect(await noSideways(bo.page)).toBe(true);
  await shot(bo.page, "find-09-link-card");
});

test("a share link opened signed out survives the sign-up (its mail opens another tab) and the sign-in: the card is there", async ({ people }) => {
  test.skip(!canControlService, "needs the Agent social switch on, which only the local suite's service can be restarted with");
  const ann = await people.member("Ann", { open: false, contextOptions: PHONE });
  const agent = await agentApi(ann, { name: `帮手${hanTag(4)}` });
  const newcomer = await people.newContext(PHONE);
  const first = await people.watchedPage(newcomer, "Newcomer");

  await first.goto(`/a/${agent.id}`);
  await expect(first.getByRole("heading", { name: "登录 Haiyo" })).toBeVisible();
  await expect(first).toHaveURL(`${BASE_URL}/signin`);
  await first.getByRole("link", { name: "注册新账号" }).click();
  const identity = newIdentity("Newcomer");
  await first.getByLabel("邀请码").fill(await mintInvite());
  await first.getByLabel("邮箱", { exact: true }).fill(identity.email);
  await first.getByLabel("密码", { exact: true }).fill(identity.password);
  await first.getByLabel("昵称").fill(identity.displayName);
  await first.getByLabel("账号名").fill(identity.handle);
  await first.getByRole("button", { name: "注册", exact: true }).click();
  await expect(first.getByRole("heading", { name: /验证邮箱|请查收邮箱/ })).toBeVisible();

  // The verification mail's link: a tab of its own (this tab's memory is not there).
  const link = await mailLink(identity.email, "verify_email");
  const second = await people.watchedPage(newcomer, "Newcomer (mail)");
  await second.goto(link);
  await expect(second.getByText("邮箱已验证，现在可以登录了。")).toBeVisible();
  await second.getByRole("link", { name: "去登录" }).click();
  await signInUi(second, identity);
  const card = topDialog(second);
  await expect(card.getByRole("heading", { name: agent.name, exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: `添加${agent.name}` })).toBeVisible();
  await expect(second).toHaveURL(`${BASE_URL}/`);
  expect(await second.evaluate(() => localStorage.getItem("agent-family:return-to"))).toBeNull();
  await shot(second, "find-10-link-after-sign-up");
});
