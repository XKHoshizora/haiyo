// The number on 通讯录: a friend request sent to me shows on the entry while I am elsewhere in the app (no reload), and its name says what
// it is; it goes once I answer. (The count itself, the Agent requests and a request that runs out: tests/contacts-badge.test.jsx.)
import { test, expect } from "./support/fixtures.mjs";
import { goTo, listRow, rail } from "./support/app.mjs";

test("a friend request sent to me is counted on 通讯录 while I am on 消息, and the number goes once I accept it", async ({ people }) => {
  const ann = await people.member("Ann");
  const bo = await people.member("Bo");
  const page = ann.page;
  const chats = rail(page).getByRole("button", { name: /^消息/ });
  const contacts = rail(page).getByRole("button", { name: /^通讯录/ });
  // Ann is on 消息 (the app opens there), with nothing waiting.
  await expect(chats).toHaveAttribute("aria-current", "page");
  await expect(contacts.locator(".badge")).toHaveCount(0);
  await expect(contacts).toHaveAccessibleName("通讯录");

  // Bo asks; Ann's page is neither reloaded nor moved.
  const asked = await bo.request.post("/api/friend-requests", { data: { handle: ann.handle } });
  expect(asked.ok(), "Bo's friend request").toBe(true);
  await expect(contacts.locator(".badge")).toHaveText("1");
  await expect(contacts).toHaveAccessibleName("通讯录，1 条待处理");
  await expect(chats).toHaveAttribute("aria-current", "page");

  // Ann accepts on Bo's card: the number goes.
  await goTo(page, "通讯录");
  await listRow(page, bo.displayName).first().click();
  await page.getByRole("region", { name: "联系人卡片" }).getByRole("button", { name: "同意" }).click();
  await expect(page.getByRole("status").filter({ hasText: `已添加${bo.displayName}为好友` })).toBeVisible();
  await expect(contacts.locator(".badge")).toHaveCount(0);
  await expect(contacts).toHaveAccessibleName("通讯录");
});
