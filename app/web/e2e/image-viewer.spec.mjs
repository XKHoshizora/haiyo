// The image viewer in a real browser: a picture of a conversation opens in the same window, steps to the next, closes with
// Esc and gives the focus back to the picture; and what the file card and the picture bubble look like and do.
import { test, expect } from "./support/fixtures.mjs";
import { befriend, uniq } from "./support/accounts.mjs";
import { chatPane, createGroupUi, openChat, sendFile } from "./support/app.mjs";
import { png, randomFile } from "./support/files.mjs";
import { polishShot } from "./support/shots.mjs";

test("a picture opens a viewer in the same window: next, Esc, and the focus comes back @remote", async ({ people }) => {
  const ann = await people.member("Ann");
  const bo = await people.member("Bo");
  const cy = await people.member("Cy");
  await befriend(ann, bo);
  await befriend(ann, cy);
  const tag = uniq(4);
  const title = `看图${tag}`;
  await createGroupUi(ann.page, title, [bo.displayName, cy.displayName]);
  const pictures = [1, 2, 3].map((n) => ({ name: `图${n}-${tag}.png`, mimeType: "image/png", buffer: png(40 + n, 30) }));
  for (const picture of pictures) await sendFile(ann.page, title, picture, "选择图片或视频");

  const chat = await openChat(bo.page, title);
  const page = bo.page;
  const opener = chat.getByRole("button", { name: pictures[0].name, exact: true });
  await expect(opener).toBeVisible();
  const pagesBefore = page.context().pages().length;
  await opener.click();

  // Same window: a dialog over the page, the picture, who sent it, a counter, no new tab.
  await expect(page.getByRole("dialog", { name: pictures[0].name })).toBeVisible();
  const viewer = page.getByRole("dialog"); // (its name is the file name shown, which changes as it steps)
  expect(page.context().pages().length).toBe(pagesBefore);
  await expect(viewer.getByText(ann.displayName)).toBeVisible();
  await expect(viewer.locator(".viewer-count")).toHaveText("1 / 3");
  await expect(viewer.getByRole("button", { name: "上一张" })).toHaveCount(0);
  await expect.poll(() => viewer.locator(".viewer-img").evaluate((img) => img.naturalWidth)).toBe(41);
  await expect(viewer.getByRole("button", { name: "关闭" })).toBeFocused();

  await polishShot(page, "viewer-1280x800");
  await page.setViewportSize({ width: 360, height: 740 });
  await polishShot(page, "viewer-360x740");
  await page.setViewportSize({ width: 1280, height: 860 });

  // A click on the picture (and on the backdrop's drag) leaves the keys working: the dialog has the focus.
  await viewer.locator(".viewer-img").click();
  await expect(viewer).toBeFocused();

  // Next, by the arrow key and by the button; the last has no next.
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("dialog", { name: pictures[1].name })).toBeVisible();
  await expect(viewer.locator(".viewer-count")).toHaveText("2 / 3");
  await viewer.getByRole("button", { name: "下一张" }).click();
  await expect(viewer.locator(".viewer-count")).toHaveText("3 / 3");
  await expect(viewer.getByRole("button", { name: "下一张" })).toHaveCount(0);
  await expect(viewer.getByRole("link", { name: `下载 ${pictures[2].name}` })).toHaveAttribute("download", pictures[2].name);

  // Zoom by key, and back.
  await page.keyboard.press("+");
  await expect(viewer.locator(".viewer-img")).not.toHaveAttribute("data-scale", "1");
  await page.keyboard.press("0");
  await expect(viewer.locator(".viewer-img")).toHaveAttribute("data-scale", "1");

  // Esc closes it (after a click on the picture, too) and the focus is back on the picture that opened it.
  await viewer.locator(".viewer-img").click();
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("a file is a card: an icon of its kind, the name's middle elided with its extension kept, one link that downloads @remote", async ({ people }) => {
  const ann = await people.member("Ann");
  const bo = await people.member("Bo");
  const cy = await people.member("Cy");
  await befriend(ann, bo);
  await befriend(ann, cy);
  const tag = uniq(4);
  const title = `文件卡${tag}`;
  await createGroupUi(ann.page, title, [bo.displayName, cy.displayName]);
  const name = `第三季度销售数据汇总报告（含各区域明细和同比环比分析）最终修订版-${tag}.pdf`;
  await sendFile(ann.page, title, { name, mimeType: "application/pdf", buffer: randomFile(2_000) });

  const chat = await openChat(bo.page, title);
  const card = chat.getByRole("link", { name: /^下载 / });
  await expect(card).toHaveCount(1);
  await expect(card).toHaveAttribute("data-kind", "pdf");
  await expect(card.locator(".file-name")).toHaveAttribute("title", name);
  // One tab stop inside the card's own box: the card itself.
  await expect(card.locator("a, button")).toHaveCount(0);

  // At phone width the name is cut in the middle: the head shows "…" and the extension is still on screen.
  await bo.page.setViewportSize({ width: 360, height: 740 });
  const cut = await card.evaluate((el) => {
    const head = el.querySelector(".file-name-head");
    const tail = el.querySelector(".file-name-tail");
    const box = el.getBoundingClientRect();
    // (Cut at the pixel: the head ends with "…" against the tail, nothing is left to clip, and no gap is between them.)
    return { clipped: head.scrollWidth > head.clientWidth || head.textContent.endsWith("…"), gap: tail.getBoundingClientRect().left - head.getBoundingClientRect().right, tail: tail.textContent, tailInside: tail.getBoundingClientRect().right <= box.right + 1, cardInside: box.right <= window.innerWidth };
  });
  expect(cut.clipped).toBe(true);
  expect(Math.abs(cut.gap)).toBeLessThanOrEqual(1.5);
  expect(cut.tail.endsWith(".pdf")).toBe(true);
  expect(cut.tailInside).toBe(true);
  expect(cut.cardInside).toBe(true);

  await polishShot(bo.page, "file-card-360", { clip: await chat.getByTestId("message-list").boundingBox() });

  // Clicking anywhere on the card downloads the file.
  const download = bo.page.waitForEvent("download");
  await card.click();
  expect((await download).suggestedFilename()).toBe(name);
  await expect(chatPane(bo.page, title)).toBeVisible();
});
