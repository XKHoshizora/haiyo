// spec §7.1: two new accounts sign up with an invite, verify, sign in; one resets its password; they become
// friends through the UI and chat both ways; history survives a reload and a fresh browser. Also: the page's
// CSP header, no CSP violation anywhere (the fixture), the WebSocket, and a signed-out deep link.
import { test, expect } from "./support/fixtures.mjs";
import { mailLink, mintInvite, newIdentity, newPassword, uniq } from "./support/accounts.mjs";
import { chatPane, expectOnce, expectStored, goTo, listRow, openChat, rail, sendText, signInUi } from "./support/app.mjs";

/**
 * What the page after a mail is asked for says: 请查收邮箱 on a site that delivers mail; on one that does not (`GET /api/site`
 * `mailDelivered` false — the local suite's outbox) the page says so instead, under `noMailTitle`.
 */
async function expectMailPage(page, noMailTitle) {
  const { mailDelivered } = await (await page.request.get("/api/site")).json();
  if (mailDelivered) await expect(page.getByRole("heading", { name: "请查收邮箱" })).toBeVisible();
  else {
    await expect(page.getByRole("heading", { name: noMailTitle })).toBeVisible();
    await expect(page.getByText("这个站点不发送邮件。请向管理员索取验证链接。")).toBeVisible();
  }
}

/** /register → the inbox's verification link → /verify → sign in. Resolves with the page's WebSocket. */
async function signUp(page, identity) {
  await page.goto("/register");
  await page.getByLabel("邀请码").fill(await mintInvite());
  await page.getByLabel("邮箱", { exact: true }).fill(identity.email);
  await page.getByLabel("密码", { exact: true }).fill(identity.password);
  await page.getByLabel("昵称").fill(identity.displayName);
  await page.getByLabel("账号名").fill(identity.handle);
  await page.getByRole("button", { name: "注册", exact: true }).click();
  await expectMailPage(page, "验证邮箱");

  await page.goto(await mailLink(identity.email, "verify_email"));
  await expect(page.getByRole("heading", { name: "邮箱已验证" })).toBeVisible();
  await page.getByRole("link", { name: "去登录" }).click();

  const socket = page.waitForEvent("websocket", (ws) => new URL(ws.url()).pathname === "/api/ws");
  await signInUi(page, identity);
  await expect(rail(page)).toBeVisible();
  return socket;
}

test("spec §7.1: sign up, verify, reset, befriend, chat both ways; history survives reload and a new browser @remote", async ({ people }) => {
  const ann = await people.stranger("Ann");
  const bo = await people.stranger("Bo");
  const annId = newIdentity("Ann");
  const boId = newIdentity("Bo");

  // The page itself carries the Content-Security-Policy (the fixture fails the test on any violation).
  const root = await ann.page.goto("/");
  const csp = root.headers()["content-security-policy"] ?? "";
  for (const directive of ["default-src 'self'", "script-src 'self'", "connect-src 'self'", "object-src 'none'", "frame-ancestors 'none'"]) {
    expect(csp, "CSP of /").toContain(directive);
  }
  await expect(ann.page).toHaveURL(/\/signin$/);

  const annSocket = await signUp(ann.page, annId);
  const boSocket = await signUp(bo.page, boId);
  expect(annSocket.isClosed(), "Ann's push socket is open").toBe(false);
  expect(boSocket.isClosed(), "Bo's push socket is open").toBe(false);

  // Bo forgets the password and resets it from another browser (request, mailed link, new password).
  const elsewhere = await people.stranger("Bo-elsewhere");
  await elsewhere.page.goto("/signin");
  await elsewhere.page.getByRole("link", { name: "忘记密码" }).click();
  await elsewhere.page.getByLabel("邮箱", { exact: true }).fill(boId.email);
  await elsewhere.page.getByRole("button", { name: "发送重置邮件" }).click();
  await expectMailPage(elsewhere.page, "重置密码");
  await elsewhere.page.goto(await mailLink(boId.email, "reset_password"));
  await expect(elsewhere.page).toHaveURL(/\/reset-password$/); // the token left the address bar
  const oldPassword = boId.password;
  boId.password = newPassword();
  await elsewhere.page.getByLabel("新密码").fill(boId.password);
  await elsewhere.page.getByRole("button", { name: "重置密码" }).click();
  await expect(elsewhere.page.getByRole("heading", { name: "密码已重置" })).toBeVisible();

  // The reset ended Bo's first session: that browser is back at sign-in (its socket closed), told why.
  await expect(bo.page.getByRole("heading", { name: "登录 Haiyo" })).toBeVisible();
  await expect(bo.page.getByText("登录已失效，请重新登录。")).toBeVisible();
  await expect.poll(() => boSocket.isClosed()).toBe(true);
  await signInUi(bo.page, { email: boId.email, password: oldPassword });
  await expect(bo.page.getByRole("alert")).toContainText("邮箱或密码不对");
  await signInUi(bo.page, boId);
  await expect(rail(bo.page)).toBeVisible();

  // Ann finds Bo by account name and asks; Bo accepts (both pages live, no reload).
  await goTo(ann.page, "通讯录");
  await ann.page.getByRole("button", { name: "添加好友" }).click();
  const add = ann.page.getByRole("dialog", { name: "添加好友" });
  await add.getByLabel("对方的账号名").fill(boId.handle);
  await add.getByRole("button", { name: "查找" }).click();
  await expect(add.getByRole("list", { name: "查找结果" })).toContainText(boId.displayName);
  await add.getByRole("button", { name: "发送好友申请" }).click();
  await expect(ann.page.getByRole("status").filter({ hasText: "好友申请已发送" })).toBeVisible();
  await add.getByRole("button", { name: "完成" }).click();

  await goTo(bo.page, "通讯录");
  await listRow(bo.page, annId.displayName).click();
  await bo.page.getByRole("button", { name: "同意" }).click();
  await expect(bo.page.getByRole("status").filter({ hasText: `已添加${annId.displayName}为好友` })).toBeVisible();

  // Direct chat both ways, each side live (the push socket delivers; nobody reloads).
  const annChat = await openChat(ann.page, boId.displayName);
  const boChat = await openChat(bo.page, annId.displayName);
  const first = `你好，我是 Ann ${uniq()}`;
  const second = `收到，Bo 回复 ${uniq()}`;
  await sendText(ann.page, boId.displayName, first);
  await expectStored(boChat, first);
  await sendText(bo.page, annId.displayName, second);
  await expectStored(annChat, second);

  // A reload keeps the history, once each.
  await ann.page.reload();
  const reloaded = await openChat(ann.page, boId.displayName);
  await expectOnce(reloaded, first);
  await expectOnce(reloaded, second);

  // Another browser: a signed-out deep link lands on sign-in; after signing in the app shows the same history.
  const again = await people.stranger("Ann-again");
  await again.page.goto("/some/deep/link");
  await expect(again.page).toHaveURL(/\/signin$/);
  await signInUi(again.page, annId);
  await expect(rail(again.page)).toBeVisible();
  const fresh = await openChat(again.page, boId.displayName);
  await expectOnce(fresh, first);
  await expectOnce(fresh, second);
  await expect(chatPane(again.page, boId.displayName)).toBeVisible();
});
