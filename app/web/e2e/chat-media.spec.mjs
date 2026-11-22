// A video or an audio file plays in the chat (item Q), in a real browser against the real service: the player shows the first frame (metadata loaded, not
// the whole file), plays inline through byte ranges (the service answers 206), the card with its download stays under it; a file this browser cannot play
// (a QuickTime .mov: Chromium does not claim it) stays the file card; a portrait clip growing the list (its metadata arrives after it was laid out as 16:9) does
// not push the newest message under the composer. The media are small checked-in files (e2e/fixtures/media: clip.webm and portrait.webm are VP8, memo.mp3,
// clip.mov is MPEG-4 in a QuickTime box), made with `ffmpeg -f lavfi -i testsrc=size=WxH:rate=10 -t 2 -c:v libvpx`, `-i sine=frequency=440:duration=2 -c:a libmp3lame`
// and `-c:v mpeg4 -f mov`.
import { readFileSync } from "node:fs";
import { test, expect } from "./support/fixtures.mjs";
import { befriend, sendApi, uniq } from "./support/accounts.mjs";
import { openChat, sendFile } from "./support/app.mjs";
import { polishShot } from "./support/shots.mjs";

const PHONE = { viewport: { width: 402, height: 874 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 };
const fixture = (name) => readFileSync(new URL(`./fixtures/media/${name}`, import.meta.url));

/** How far the message list is from its end (px); 0 or less: at the newest message. */
const fromEnd = (page) => page.evaluate(() => {
  const list = document.querySelector("ol.messages");
  return list.scrollHeight - list.scrollTop - list.clientHeight;
});

test("a video plays in its bubble through byte ranges, an audio file has its player, a file the browser cannot play stays the card; the download stays under each player", async ({ people }) => {
  const ann = await people.member("Ann", { contextOptions: PHONE });
  const bo = await people.member("Bo");
  await befriend(ann, bo);
  const page = ann.page;
  const ranged = [];
  page.on("response", (res) => {
    if (res.url().includes("/api/attachments/") && res.status() === 206) ranged.push(res.request().headers().range);
  });
  const chat = await openChat(page, bo.displayName);
  await sendFile(page, bo.displayName, { name: "clip.webm", mimeType: "video/webm", buffer: fixture("clip.webm") });
  await sendFile(page, bo.displayName, { name: "memo.mp3", mimeType: "audio/mpeg", buffer: fixture("memo.mp3") });
  await sendFile(page, bo.displayName, { name: "clip.mov", mimeType: "video/quicktime", buffer: fixture("clip.mov") });

  // The video: a player with controls that loaded its metadata (the first frame), paused, inside the column, a download link beneath.
  const figure = chat.locator("figure.attachment-media.attachment-video");
  await expect(figure).toHaveCount(1);
  const video = figure.locator("video");
  await expect.poll(() => video.evaluate((v) => v.readyState)).toBeGreaterThanOrEqual(1);
  expect(await video.evaluate((v) => [v.paused, v.autoplay, v.controls, v.videoWidth, v.preload])).toEqual([true, false, true, 320, "metadata"]);
  const box = await figure.boundingBox();
  const column = await chat.locator("ol.messages").boundingBox();
  expect(box.width).toBeLessThanOrEqual(280.5);
  expect(box.x + box.width).toBeLessThanOrEqual(column.x + column.width + 1);
  await expect(figure.getByRole("link", { name: /下载 clip\.webm/ })).toBeVisible();
  await polishShot(page, "ui2-video-rest");
  // It plays (muted: a script may not start sound without a tap), and the service has answered ranges.
  await video.evaluate((v) => {
    v.muted = true;
    return v.play();
  });
  await expect.poll(() => video.evaluate((v) => v.currentTime)).toBeGreaterThan(0.2);
  await polishShot(page, "ui2-video-playing");
  expect(ranged.length, "the player's requests are answered with 206").toBeGreaterThan(0);
  await video.evaluate((v) => v.pause());

  // The audio: its own player and download.
  const audio = chat.locator("figure.attachment-media.attachment-audio audio");
  await expect(audio).toHaveCount(1);
  expect(await audio.evaluate((a) => [a.controls, a.autoplay, a.preload])).toEqual([true, false, "metadata"]);
  await expect(chat.getByRole("link", { name: /下载 memo\.mp3/ })).toBeVisible();
  // The file Chromium does not claim: the card, with its download.
  const card = chat.locator(".file-card", { hasText: "clip.mov" });
  await expect(card).toHaveCount(1);
  await expect(card.locator("video")).toHaveCount(0);
  await polishShot(page, "ui2-media-fallback");
  // The column did not widen for any of it.
  expect(await page.evaluate(() => document.querySelector("ol.messages").scrollWidth <= document.querySelector("ol.messages").clientWidth)).toBe(true);
  // A right-click on the name line under the player opens the bubble menu; on the player itself the browser's own player menu stays.
  await figure.locator(".media-meta").click({ button: "right" });
  await expect(page.getByRole("menu", { name: "消息操作" })).toBeVisible();
});

test("a portrait clip whose metadata arrives after it was laid out keeps a list at its newest message at the newest message; a list scrolled up does not move", async ({ people }) => {
  const ann = await people.member("Ann", { contextOptions: PHONE });
  const bo = await people.member("Bo");
  const dm = await befriend(ann, bo);
  const page = ann.page;
  for (let i = 0; i < 14; i += 1) await sendApi(bo, dm, `填充消息 ${i} ${uniq(4)}`);
  const chat = await openChat(page, bo.displayName);
  await expect.poll(() => fromEnd(page)).toBeLessThanOrEqual(2);

  // Ann sends a portrait recording: its box is the 16:9 placeholder first, then 180×320. The list stays at its end throughout. (The file is held back for
  // a moment, so that its metadata really does arrive after the message was laid out and the list scrolled to its end.)
  await page.route("**/api/attachments/*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 700));
    await route.continue();
  });
  await sendFile(page, bo.displayName, { name: "portrait.webm", mimeType: "video/webm", buffer: fixture("portrait.webm") });
  const video = chat.locator("figure.attachment-media video");
  await expect.poll(() => video.evaluate((v) => v.readyState)).toBeGreaterThanOrEqual(1);
  await expect.poll(() => video.evaluate((v) => v.videoHeight)).toBe(320);
  await expect.poll(() => fromEnd(page)).toBeLessThanOrEqual(2);
  const frame = await chat.locator("figure.attachment-media .media-frame").boundingBox();
  expect(frame.height).toBeGreaterThan(frame.width); // (portrait: the box took the video's own shape)
  const composer = await chat.locator("footer.composer").boundingBox();
  const meta = await chat.locator("figure.attachment-media .media-meta").boundingBox();
  expect(meta.y + meta.height, "the download line is above the composer").toBeLessThanOrEqual(composer.y + 1);
  await polishShot(page, "ui2-video-portrait");

  // Scrolled up, a clip arriving below changes nothing under the reader's eyes.
  await chat.locator("ol.messages").evaluate((list) => (list.scrollTop = 0));
  await expect.poll(() => chat.locator("ol.messages").evaluate((list) => list.scrollTop)).toBe(0);
  const up = await bo.request.post(`/api/conversations/${dm}/attachments`, { multipart: { file: { name: "again.webm", mimeType: "video/webm", buffer: fixture("portrait.webm") } } });
  expect(up.status()).toBe(201);
  const sent = await bo.request.post(`/api/conversations/${dm}/messages`, { data: { attachmentId: (await up.json()).id, clientTxn: `m${uniq(6)}` } });
  expect(sent.status()).toBe(201);
  await expect(chat.locator("figure.attachment-media")).toHaveCount(2);
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))); // (two frames: whatever the new clip would do to the list, it has done by now)
  expect(await chat.locator("ol.messages").evaluate((list) => list.scrollTop)).toBe(0);
});
