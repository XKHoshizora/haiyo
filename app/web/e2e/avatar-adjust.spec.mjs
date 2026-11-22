// The 调整头像 dialog in a real browser (decoding, the canvas, WebP encoding, pointer and keyboard), for my own avatar and for a
// group's: the creator sets and removes it, a member sees it and has no controls, an outsider cannot tell it exists.
import { test, expect } from "./support/fixtures.mjs";
import { befriend, createGroupApi, uniq } from "./support/accounts.mjs";
import { chatPane, goTo, listRow, openChat, pickAvatarUi, saveAvatarDialog } from "./support/app.mjs";
import { png } from "./support/files.mjs";

const picture = (name, width, height) => ({ name, mimeType: "image/png", buffer: png(width, height) });

/** The served bytes of my own avatar, as the signed-in person `who` gets them. */
async function myAvatar(who) {
  const me = await who.request.get("/api/me");
  const { id } = await me.json();
  const res = await who.request.get(`/api/principals/${id}/avatar`);
  return { type: res.headers()["content-type"], bytes: await res.body() };
}

test("my avatar is adjusted before it is saved: the dialog fits a phone, cancel changes nothing, the saved picture is a 512 square", async ({ people }) => {
  const ann = await people.member("Ann");
  await goTo(ann.page, "设置");

  // A phone: the dialog and its stage fit the screen without scrolling the page sideways.
  await ann.page.setViewportSize({ width: 360, height: 740 });
  // (A phone draws the settings list at /settings; the profile is a page of its own there.)
  await ann.page.getByText("我的资料", { exact: true }).first().click();
  const dialog = await pickAvatarUi(ann.page, "更换头像", picture("wide.png", 800, 400));
  const box = await dialog.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(360);
  const stage = dialog.getByRole("group", { name: "头像取景框" });
  const stageBox = await stage.boundingBox();
  expect(stageBox.width).toBeGreaterThan(200);
  expect(stageBox.width).toBeLessThanOrEqual(280);
  expect(stageBox.height).toBeCloseTo(stageBox.width, 0);
  expect(await ann.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(dialog.getByText("拖动调整位置，滑块或滚轮缩放。")).toBeVisible();

  // The keyboard alone: the stage has the focus, + zooms, the arrow keys move, and the slider says where it is.
  await expect(stage).toBeFocused();
  await ann.page.keyboard.press("+");
  await ann.page.keyboard.press("+");
  await expect(dialog.getByRole("slider", { name: "缩放" })).toHaveAttribute("aria-valuetext", /^1[3-9]\d%$/);
  await ann.page.keyboard.press("ArrowLeft");
  // Tab stays in the dialog.
  for (let i = 0; i < 12; i++) await ann.page.keyboard.press("Tab");
  expect(await ann.page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))).toBe(true);

  // Cancel (Esc): nothing is saved, focus is back on the button, my avatar is still the generated one.
  await ann.page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(ann.page.getByRole("button", { name: "更换头像", exact: true })).toBeFocused();
  const before = await myAvatar(ann);
  expect(before.type).toMatch(/^image\/svg\+xml/);
  await ann.page.setViewportSize({ width: 1280, height: 860 });

  // A mouse drag and the wheel, then 保存: the service holds a 512 × 512 WebP, never the picked file.
  const again = await pickAvatarUi(ann.page, "更换头像", picture("wide.png", 800, 400));
  const area = await again.getByRole("group", { name: "头像取景框" }).boundingBox();
  await ann.page.mouse.move(area.x + area.width / 2, area.y + area.height / 2);
  await ann.page.mouse.wheel(0, -300);
  await ann.page.mouse.down();
  await ann.page.mouse.move(area.x + area.width / 2 - 60, area.y + area.height / 2 + 20, { steps: 5 });
  await ann.page.mouse.up();
  await saveAvatarDialog(again);
  await expect(ann.page.getByRole("status").filter({ hasText: "头像已更新" })).toBeVisible();
  const first = await myAvatar(ann);
  expect(first.type).toBe("image/webp");
  expect(first.bytes.length).toBeLessThan(2 * 1024 * 1024);
  const size = await ann.page.evaluate(async (src) => {
    const bitmap = await createImageBitmap(await (await fetch(src)).blob());
    return [bitmap.width, bitmap.height];
  }, `/api/principals/${(await (await ann.request.get("/api/me")).json()).id}/avatar?v=check`);
  expect(size).toEqual([512, 512]);

  // Adjusted differently, the saved picture is a different one.
  const second = await pickAvatarUi(ann.page, "更换头像", picture("wide.png", 800, 400));
  await second.getByRole("group", { name: "头像取景框" }).focus();
  for (let i = 0; i < 6; i++) await ann.page.keyboard.press("+");
  await saveAvatarDialog(second);
  await expect.poll(async () => Buffer.compare((await myAvatar(ann)).bytes, first.bytes)).not.toBe(0);
});

/** A JPEG of `width` × `height` that is red at the left edge and blue at the right, with the EXIF orientation `orientation`. */
async function orientedJpeg(page, width, height, orientation) {
  const base64 = await page.evaluate(
    async ([w, h]) => {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      const gradient = ctx.createLinearGradient(0, 0, w, 0);
      gradient.addColorStop(0, "#ff0000");
      gradient.addColorStop(1, "#0000ff");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, w, h);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.95));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let text = "";
      for (const b of bytes) text += String.fromCharCode(b);
      return btoa(text);
    },
    [width, height],
  );
  const jpeg = Buffer.from(base64, "base64");
  const tiff = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, orientation, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const exif = Buffer.concat([Buffer.from([0x45, 0x78, 0x69, 0x66, 0, 0]), tiff]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0x00, exif.length + 2]), exif]);
  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
}

test("the picture's EXIF orientation is respected: a sideways photo is saved upright", async ({ people }) => {
  const ann = await people.member("Ann");
  await goTo(ann.page, "设置");
  // Stored 200 × 100, red on the left; orientation 6 (a quarter turn clockwise) makes it 100 × 200 with red on top.
  const buffer = await orientedJpeg(ann.page, 200, 100, 6);
  await saveAvatarDialog(await pickAvatarUi(ann.page, "更换头像", { name: "photo.jpg", mimeType: "image/jpeg", buffer }));
  const { id } = await (await ann.request.get("/api/me")).json();
  const [top, bottom] = await ann.page.evaluate(async (src) => {
    const bitmap = await createImageBitmap(await (await fetch(src)).blob());
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    return [ctx.getImageData(256, 12, 1, 1).data, ctx.getImageData(256, 500, 1, 1).data].map((d) => [d[0], d[2]]);
  }, `/api/principals/${id}/avatar?v=orientation`);
  // The crop is the middle half of the turned picture's height: red-ish at the top, blue-ish at the bottom (not the other way
  // round, and not the same all the way down, which is what a picture left sideways would give at the middle column).
  expect(top[0], "more red at the top than at the bottom").toBeGreaterThan(bottom[0] + 80);
  expect(bottom[1], "more blue at the bottom than at the top").toBeGreaterThan(top[1] + 80);
});

test("a picture over 8000 px a side is refused by its header with the size message, and a large one is worked with and saved", async ({ people }) => {
  const ann = await people.member("Ann");
  await goTo(ann.page, "设置");
  const uploads = [];
  ann.page.on("request", (r) => r.method() === "PUT" && uploads.push(r.url()));
  const chooser = ann.page.waitForEvent("filechooser");
  await ann.page.getByRole("button", { name: "更换头像", exact: true }).click();
  await (await chooser).setFiles({ name: "huge.png", mimeType: "image/png", buffer: png(8001, 6) });
  const refused = ann.page.getByRole("dialog", { name: "调整头像" });
  await expect(refused.getByRole("alert")).toHaveText("图片的边不能超过 8000 像素。");
  await refused.getByRole("button", { name: "知道了" }).click();
  await expect(refused).toBeHidden();
  expect(uploads).toEqual([]);

  // 3000 × 2700: decoded at a reduced size (short side over 2560), still adjustable, saved as a 512 square.
  const dialog = await pickAvatarUi(ann.page, "更换头像", picture("large.png", 3000, 2700));
  await dialog.getByRole("group", { name: "头像取景框" }).focus();
  for (let i = 0; i < 4; i++) await ann.page.keyboard.press("+");
  await saveAvatarDialog(dialog);
  const { id } = await (await ann.request.get("/api/me")).json();
  const size = await ann.page.evaluate(async (src) => {
    const bitmap = await createImageBitmap(await (await fetch(src)).blob());
    return [bitmap.width, bitmap.height];
  }, `/api/principals/${id}/avatar?v=large`);
  expect(size).toEqual([512, 512]);
});

test("a picture that cannot be decoded gets a clear message in the dialog, and nothing is uploaded", async ({ people }) => {
  const ann = await people.member("Ann");
  await goTo(ann.page, "设置");
  const uploads = [];
  ann.page.on("request", (r) => r.method() === "PUT" && uploads.push(r.url()));
  const chooser = ann.page.waitForEvent("filechooser");
  await ann.page.getByRole("button", { name: "更换头像", exact: true }).click();
  const broken = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("not really a picture")]);
  await (await chooser).setFiles({ name: "broken.png", mimeType: "image/png", buffer: broken });
  const dialog = ann.page.getByRole("dialog", { name: "调整头像" });
  await expect(dialog.getByRole("alert")).toHaveText("这张图片无法读取，请换一张。");
  await expect(dialog.getByRole("button", { name: "保存", exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "知道了" }).click();
  await expect(dialog).toBeHidden();
  expect(uploads).toEqual([]);
});

test("a group's avatar: the creator sets and removes it, a member sees it and has no controls, an outsider cannot tell", async ({ people }) => {
  const ann = await people.member("Ann");
  const bo = await people.member("Bo");
  const cy = await people.member("Cy", { open: false });
  const dan = await people.member("Dan", { open: false });
  await befriend(ann, bo);
  await befriend(ann, cy);
  const title = `头像群${uniq(4)}`;
  const groupId = await createGroupApi(ann, [bo, cy], title);
  const listPicture = (page) => listRow(page, title).first().locator(".group-picture img");
  const avatarOf = (who) => who.request.get(`/api/conversations/${groupId}/avatar`);

  // Bo has the group open: without an avatar it looks as it always did.
  await openChat(bo.page, title);
  await expect(listRow(bo.page, title).first().locator(".group-avatar")).toBeVisible();
  await expect(listPicture(bo.page)).toHaveCount(0);

  // The creator: 群资料 → 群设置 → 更换头像 → adjust → 保存.
  await openChat(ann.page, title);
  await chatPane(ann.page, title).getByRole("button", { name: "群资料" }).click();
  const profile = ann.page.getByRole("region", { name: "群资料" });
  await profile.getByRole("tab", { name: "群设置" }).click();
  await expect(profile.getByRole("button", { name: "移除头像" })).toHaveCount(0);
  await saveAvatarDialog(await pickAvatarUi(ann.page, "更换头像", picture("team.png", 600, 900)));
  await expect(ann.page.getByRole("status").filter({ hasText: "群头像已更新" })).toBeVisible();
  await expect(profile.getByRole("button", { name: "移除头像" })).toBeVisible();

  // A member's open page shows it at once, 512 × 512; it is the stored crop, served to members only.
  await expect(listPicture(bo.page)).toBeVisible();
  await expect.poll(() => listPicture(bo.page).evaluate((img) => [img.naturalWidth, img.naturalHeight])).toEqual([512, 512]);
  const served = await avatarOf(bo);
  expect(served.status()).toBe(200);
  expect(served.headers()["content-type"]).toBe("image/webp");
  const outsider = await avatarOf(dan);
  expect(outsider.status()).toBe(404);
  expect(await outsider.json()).toEqual({ error: "not_found" });

  // The member has no controls, only the picture in the group's page.
  await chatPane(bo.page, title).getByRole("button", { name: "群资料" }).click();
  const boProfile = bo.page.getByRole("region", { name: "群资料" });
  await expect(boProfile.locator(".profile-head .group-picture img")).toBeVisible();
  await boProfile.getByRole("tab", { name: "群设置" }).click();
  await expect(boProfile.getByRole("button", { name: "退出本群" })).toBeVisible();
  for (const name of ["更换头像", "移除头像"]) await expect(boProfile.getByRole("button", { name })).toHaveCount(0);
  await expect(boProfile.getByLabel("选择头像图片")).toHaveCount(0);
  const refused = await bo.request.put(`/api/conversations/${groupId}/avatar`, { headers: { "content-type": "image/png" }, data: png(8, 8) });
  expect(refused.status()).toBe(403);

  // The creator removes it: the member's list is back to the composite, and the service answers 404 to everyone.
  await profile.getByRole("button", { name: "移除头像" }).click();
  await expect(ann.page.getByRole("status").filter({ hasText: "群头像已移除" })).toBeVisible();
  // The pressed button is gone and the first one was disabled while it worked: focus must still end up on 更换头像.
  await expect(profile.getByRole("button", { name: "更换头像", exact: true })).toBeFocused();
  await expect(listPicture(bo.page)).toHaveCount(0);
  await expect(listRow(bo.page, title).first().locator(".group-avatar")).toBeVisible();
  expect((await avatarOf(bo)).status()).toBe(404);
  expect((await avatarOf(ann)).status()).toBe(404);
});
