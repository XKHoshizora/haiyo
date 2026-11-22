// Screenshots of the avatar adjust dialog and the group's avatar controls for the acceptance record, taken only when
// E2E_SHOTS=1 (an ordinary run leaves the repository as it was): docs/acceptance/polish-2026-11-22/shots/avatar-*.png.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { test, expect } from "./support/fixtures.mjs";
import { befriend, createGroupApi, uniq } from "./support/accounts.mjs";
import { WEB_DIR } from "./support/env.mjs";
import { chatPane, goTo, openChat, pickAvatarUi } from "./support/app.mjs";
import { png } from "./support/files.mjs";

const shooting = process.env.E2E_SHOTS === "1";
const DIR = path.resolve(WEB_DIR, "..", "..", "docs", "acceptance", "polish-2026-11-22", "shots");
const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 360, height: 740 };
const shot = async (page, name) => {
  mkdirSync(DIR, { recursive: true });
  await page.screenshot({ path: path.join(DIR, `avatar-${name}.png`) });
};
const picture = (name, width, height) => ({ name, mimeType: "image/png", buffer: png(width, height) });

test.skip(!shooting, "screenshots are taken only with E2E_SHOTS=1");

test("the adjust dialog, its error state, and the group's avatar controls", async ({ people }) => {
  const ann = await people.member("Ann");
  const bo = await people.member("Bo");
  const cy = await people.member("Cy", { open: false });
  await befriend(ann, bo);
  await befriend(ann, cy);

  await ann.page.setViewportSize(DESKTOP);
  await goTo(ann.page, "设置");
  const dialog = await pickAvatarUi(ann.page, "更换头像", picture("wide.png", 900, 600));
  await ann.page.keyboard.press("+");
  await ann.page.keyboard.press("+");
  await shot(ann.page, "dialog-1280x800");
  await ann.page.setViewportSize(PHONE);
  await shot(ann.page, "dialog-360x740");
  await ann.page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // The error state (on a phone the profile is a page of the settings list).
  await ann.page.getByText("我的资料", { exact: true }).first().click();
  const chooser = ann.page.waitForEvent("filechooser");
  await ann.page.getByRole("button", { name: "更换头像", exact: true }).click();
  const broken = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("not really a picture")]);
  await (await chooser).setFiles({ name: "broken.png", mimeType: "image/png", buffer: broken });
  await expect(ann.page.getByRole("dialog", { name: "调整头像" }).getByRole("alert")).toBeVisible();
  await shot(ann.page, "dialog-error-360x740");
  await ann.page.setViewportSize(DESKTOP);
  await shot(ann.page, "dialog-error-1280x800");
  await ann.page.keyboard.press("Escape");

  // The group's info: the creator's controls (with a picture set), and a plain member's view.
  const title = `头像群${uniq(4)}`;
  const groupId = await createGroupApi(ann, [bo, cy], title);
  await openChat(ann.page, title);
  await chatPane(ann.page, title).getByRole("button", { name: "群资料" }).click();
  const profile = ann.page.getByRole("region", { name: "群资料" });
  await profile.getByRole("tab", { name: "群设置" }).click();
  await shot(ann.page, "group-info-creator-no-picture-1280x800");
  const set = await pickAvatarUi(ann.page, "更换头像", picture("team.png", 700, 900));
  await set.getByRole("button", { name: "保存", exact: true }).click();
  await expect(set).toBeHidden();
  await expect(profile.getByRole("button", { name: "移除头像" })).toBeVisible();
  await expect(profile.locator(".profile-head .group-picture img")).toBeVisible();
  await shot(ann.page, "group-info-creator-1280x800");
  await ann.page.setViewportSize(PHONE);
  await shot(ann.page, "group-info-creator-360x740");

  await bo.page.setViewportSize(DESKTOP);
  await openChat(bo.page, title);
  await chatPane(bo.page, title).getByRole("button", { name: "群资料" }).click();
  const boProfile = bo.page.getByRole("region", { name: "群资料" });
  await boProfile.getByRole("tab", { name: "群设置" }).click();
  await expect(boProfile.locator(".profile-head .group-picture img")).toBeVisible();
  await shot(bo.page, "group-info-member-1280x800");
  expect(groupId).toBeTruthy();
});
