// The terms, the privacy policy and the contact page (app/web/src/legal), and the acceptance the service records
// (app/service/src/legal.ts): public pages that open signed out, in three languages, at a phone's width without sideways
// scrolling; registration that needs the 18+ declaration and the agreement (refused by the service without them); an account
// without a record asked before the app opens; Settings › 关于. With E2E_SHOTS=1 it leaves the phone screenshots of each
// (375 and 402 wide) in docs/acceptance/polish-2026-11-22/shots/storepages-*.png.
import { test, expect } from "./support/fixtures.mjs";
import { mintInvite, newIdentity } from "./support/accounts.mjs";
import { polishShot } from "./support/shots.mjs";
import { forgetTermsAcceptance } from "./support/db.mjs";
import { REMOTE } from "./support/env.mjs";
import { rail } from "./support/app.mjs";
import { canControlService, restartService } from "./support/control.mjs";

// This file runs with the terms required (`LEGAL={"required":true}`); the suite's site has the default (off) again after it.
test.beforeAll(async () => {
  if (canControlService) await restartService({ LEGAL: JSON.stringify({ required: true }) });
});
test.afterAll(async () => {
  if (canControlService) await restartService({});
});

const PHONES = [
  [375, 812],
  [402, 874],
];

/** At each phone width: nothing wider than the screen, every text field at least 16px; then the shot `storepages-<name>-<width>`. */
async function atPhones(page, name, { before } = {}) {
  for (const [width, height] of PHONES) {
    await page.setViewportSize({ width, height });
    if (before) await before();
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect([name, width, wide]).toEqual([name, width, 0]);
    const small = await page.evaluate(() =>
      // (The fields the stylesheet's touch floor covers: not the controls that show no text.)
      [...document.querySelectorAll("input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]):not([type=button]):not([type=submit]):not([type=hidden]), textarea, select")]
        .filter((el) => parseFloat(getComputedStyle(el).fontSize) < 16).length,
    );
    expect([name, width, small]).toEqual([name, width, 0]);
    await polishShot(page, `storepages-${name}-${width}`);
  }
}

/** A touch phone (`pointer: coarse`), as mobile.spec.mjs has it; `atPhones` takes it to 402 wide too. */
const PHONE = { viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 };

async function phonePage(people, label) {
  const context = await people.newContext(PHONE);
  return { context, page: await people.watchedPage(context, label), request: context.request };
}

test("the terms, the privacy policy and the contact page open signed out, in three languages, at a phone's width", async ({ people }) => {
  const visitor = await phonePage(people, "Visitor");
  const page = visitor.page;
  await page.goto("/terms");
  await expect(page.getByRole("heading", { level: 1, name: "服务条款" })).toBeVisible();
  await expect(page.getByText("只有年满 18 岁的人可以使用 Haiyo。", { exact: false })).toBeVisible();
  await atPhones(page, "terms-zh");

  await page.getByRole("button", { name: "English" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Terms of Service" })).toBeVisible();
  await expect(page).toHaveURL(/\/terms\?lang=en$/);

  await page.goto("/privacy?lang=en");
  await expect(page.getByRole("heading", { level: 1, name: "Privacy Policy" })).toBeVisible();
  await expect(page.getByText("We do not ask for or keep your date of birth.", { exact: false })).toBeVisible();
  await atPhones(page, "privacy-en");

  await page.goto("/contact?lang=ja");
  await expect(page.getByRole("heading", { level: 1, name: "お問い合わせ" })).toBeVisible();
  await expect(page.getByRole("link", { name: "support@haiyo.org" }).first()).toHaveAttribute("href", "mailto:support@haiyo.org");
  await atPhones(page, "contact-ja");
  // The other pages, in the language chosen, without a reload.
  await page.getByRole("navigation", { name: "ほかのページ" }).getByRole("link", { name: "利用規約" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "利用規約" })).toBeVisible();
  // Nobody was signed in, and nothing sent a visitor to the sign-in page.
  await expect(page).toHaveURL(/\/terms\?lang=ja$/);
});

test("registration needs both boxes: the form says so, and the service refuses a registration without them", async ({ people }) => {
  test.skip(!canControlService, "needs the terms required (LEGAL), which only the local suite's service can be restarted with");
  const visitor = await phonePage(people, "Newcomer");
  const page = visitor.page;
  const identity = newIdentity("Newcomer");
  const invite = await mintInvite();
  // The service, not only the form.
  const bare = await visitor.request.post("/api/register", { data: { inviteCode: invite, email: identity.email, password: identity.password, displayName: identity.displayName, handle: identity.handle } });
  expect(bare.status()).toBe(400);

  await page.goto("/register");
  for (const link of ["服务条款", "隐私政策", "联系我们"]) await expect(page.getByRole("navigation", { name: "条款与联系" }).getByRole("link", { name: link })).toHaveAttribute("target", "_blank");
  await page.getByLabel("邀请码").fill(invite);
  await page.getByLabel("邮箱", { exact: true }).fill(identity.email);
  await page.getByLabel("密码", { exact: true }).fill(identity.password);
  await page.getByLabel("昵称").fill(identity.displayName);
  await page.getByLabel("账号名").fill(identity.handle);
  await page.getByRole("button", { name: "注册", exact: true }).click();
  await expect(page.getByText("请确认你已年满 18 岁")).toBeVisible();
  await expect(page.getByText("请先阅读并同意服务条款和隐私政策")).toBeVisible();
  await atPhones(page, "register-unticked", { before: () => page.getByRole("checkbox", { name: "我已年满 18 岁" }).scrollIntoViewIfNeeded() });
  await page.getByRole("checkbox", { name: "我已年满 18 岁" }).check();
  await page.getByRole("checkbox", { name: "我已阅读并同意《服务条款》和《隐私政策》" }).check();
  await atPhones(page, "register-ticked", { before: () => page.getByRole("button", { name: "注册", exact: true }).scrollIntoViewIfNeeded() });
  await page.getByRole("button", { name: "注册", exact: true }).click();
  await expect(page.getByRole("heading", { name: /验证邮箱|请查收邮箱/ })).toBeVisible();
});

test("an account without a record of the terms is asked before the app opens, and then the app opens", async ({ people }) => {
  test.skip(REMOTE || !canControlService, "needs the local suite's database and the terms required (LEGAL)");
  const ann = await people.member("Ann", { open: false, contextOptions: PHONE });
  expect(await forgetTermsAcceptance(ann.id)).toBe(1);
  const page = await people.watchedPage(ann.context, "Ann (asked)");
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "请确认条款" })).toBeVisible();
  await expect(rail(page)).toHaveCount(0);
  await atPhones(page, "asked-again");
  await page.getByRole("checkbox", { name: "我已年满 18 岁" }).check();
  await page.getByRole("checkbox", { name: "我已阅读并同意《服务条款》和《隐私政策》" }).check();
  await page.getByRole("button", { name: "同意并继续" }).click();
  await expect(rail(page)).toBeVisible();
  // Asked once: a reload goes straight to the app.
  await page.reload();
  await expect(rail(page)).toBeVisible();
  await expect(page.getByRole("heading", { name: "请确认条款" })).toHaveCount(0);
});

test("Settings › 关于 lists the three pages, each opening in a new tab", async ({ people }) => {
  const bo = await people.member("Bo", { contextOptions: PHONE });
  const page = bo.page;
  await rail(page).getByRole("button", { name: /设置/ }).click();
  const terms = page.getByRole("link", { name: /服务条款/ });
  await terms.scrollIntoViewIfNeeded();
  await expect(terms).toHaveAttribute("href", "/terms");
  await expect(terms).toHaveAttribute("target", "_blank");
  await atPhones(page, "settings-about", { before: () => page.getByRole("link", { name: /联系我们/ }).scrollIntoViewIfNeeded() });
  const [tab] = await Promise.all([bo.context.waitForEvent("page"), terms.click()]);
  await expect(tab.getByRole("heading", { level: 1, name: "服务条款" })).toBeVisible();
  await tab.close();
});
