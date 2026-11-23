// spec §7.2: three people, a group made in the UI, messages both ways, an image and a file sent and opened by the
// others with the same bytes. The group's title, one person's display name, a message and a file name are the
// XSS probe; the fixture checks that it never fires and never becomes markup on any of the three pages.
import { readFile } from "node:fs/promises";
import { test, expect, HOSTILE } from "./support/fixtures.mjs";
import { befriend, uniq } from "./support/accounts.mjs";
import { chatPane, createGroupUi, expectStored, messagesWith, openChat, sendFile, sendText } from "./support/app.mjs";
import { png, randomFile } from "./support/files.mjs";

test("spec §7.2: a group of three exchanges messages, an image and a file; hostile strings stay text @remote", async ({ people }) => {
  const ann = await people.member("Ann");
  const bo = await people.member("Bo");
  const cy = await people.member("Cy", { displayName: HOSTILE });
  await befriend(ann, bo);
  await befriend(ann, cy);
  const tag = uniq(4);
  const title = `${HOSTILE}群${tag}`;

  await createGroupUi(ann.page, title, [bo.displayName, cy.displayName]);
  const chats = { ann: chatPane(ann.page, title), bo: await openChat(bo.page, title), cy: await openChat(cy.page, title) };
  const everyone = Object.values(chats);

  // Messages from each of them reach the other two (live).
  const lines = [
    [ann, `大家好 ${tag}`],
    [bo, `Bo 在这里 ${tag}`],
    [cy, `${HOSTILE} from Cy ${tag}`],
  ];
  for (const [who, text] of lines) {
    await sendText(who.page, title, text);
    for (const chat of everyone) await expectStored(chat, text);
  }
  // The hostile display name and title are shown as text.
  await expect(chats.ann.getByRole("heading", { name: title, exact: true })).toBeVisible();
  await expect(messagesWith(chats.ann, `from Cy ${tag}`).getByText(HOSTILE, { exact: true }).first()).toBeVisible();

  // An image: shown inline to the others at its real size, the picture alone (no caption); pressing it opens the viewer in
  // the same window, whose "open the original" gives the same bytes in a new tab.
  const image = { name: `照片-${tag}.png`, mimeType: "image/png", buffer: png(48, 32) };
  await sendFile(ann.page, title, image, "选择图片或视频");
  for (const who of [bo, cy]) {
    const chat = chats[who.label.toLowerCase()];
    const shown = chat.locator(`figure.attachment-image img[alt="${image.name}"]`);
    await expect(shown).toBeVisible();
    await expect(chat.locator("figure.attachment-image figcaption")).toHaveCount(0);
    await expect.poll(() => shown.evaluate((img) => [img.naturalWidth, img.naturalHeight])).toEqual([48, 32]);
    await chat.getByRole("button", { name: image.name, exact: true }).click();
    const viewer = who.page.getByRole("dialog", { name: image.name });
    await expect(viewer).toBeVisible();
    const response = who.context.waitForEvent("response", (r) => /\/api\/attachments\/[0-9a-f-]+\/[^/]+$/.test(r.url()));
    const popup = who.page.waitForEvent("popup");
    await viewer.getByRole("link", { name: "在新标签页打开原图" }).click();
    const opened = await response;
    expect(opened.status()).toBe(200);
    // (The address ends in the file's name: the tab is titled with it and saving gives it.)
    expect(decodeURIComponent(opened.url().split("/").pop())).toBe(image.name);
    expect(opened.headers()["content-type"]).toBe("image/png");
    expect(Buffer.compare(await opened.body(), image.buffer), `${who.label} opened the same image bytes`).toBe(0);
    await (await popup).close();
    await who.page.keyboard.press("Escape");
    await expect(viewer).toHaveCount(0);
  }

  // A file (no known type, so a download) and a file whose name is the probe.
  const file = { name: `季度报告-${tag}.pdf`, mimeType: "application/pdf", buffer: randomFile(300_000) };
  const hostileFile = { name: `${HOSTILE}.txt`, mimeType: "text/plain", buffer: Buffer.from(`probe ${tag}\n`) };
  await sendFile(ann.page, title, file);
  await sendFile(ann.page, title, hostileFile);
  for (const who of [bo, cy]) {
    const chat = chats[who.label.toLowerCase()];
    await expectStored(chat, hostileFile.name);
    const download = who.page.waitForEvent("download");
    await messagesWith(chat, file.name).getByRole("link", { name: `下载 ${file.name}`, exact: false }).click();
    const done = await download;
    expect(done.suggestedFilename()).toBe(file.name);
    expect(Buffer.compare(await readFile(await done.path()), file.buffer), `${who.label} downloaded the same file bytes`).toBe(0);
  }
});
