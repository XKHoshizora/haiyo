// A video or an audio file plays in the chat (item Q), in a real browser against the real service: the player shows the first frame (metadata loaded, not
// the whole file), plays inline through byte ranges (the service answers 206), the card with its download stays under it; a file this browser cannot play
// (a QuickTime .mov: Chromium does not claim it) stays the file card. The media are made at the start with the machine's ffmpeg (skipped without it).
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test, expect } from "./support/fixtures.mjs";
import { befriend } from "./support/accounts.mjs";
import { openChat, sendFile } from "./support/app.mjs";
import { polishShot } from "./support/shots.mjs";

const run = promisify(execFile);
const PHONE = { viewport: { width: 402, height: 874 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 };

let media = null;
test.beforeAll(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "af-media-"));
  try {
    const make = async (name, args) => {
      await run("ffmpeg", ["-y", "-loglevel", "error", ...args, path.join(dir, name)]);
      return readFileSync(path.join(dir, name));
    };
    media = {
      video: await make("clip.webm", ["-f", "lavfi", "-i", "testsrc=size=320x180:rate=10", "-t", "3", "-c:v", "libvpx", "-b:v", "200k", "-an"]),
      audio: await make("memo.mp3", ["-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:a", "libmp3lame"]),
      mov: await make("clip.mov", ["-f", "lavfi", "-i", "testsrc=size=160x90:rate=10", "-t", "1", "-c:v", "mpeg4", "-f", "mov"]),
    };
  } catch {
    media = null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a video plays in its bubble through byte ranges, an audio file has its player, a file the browser cannot play stays the card; the download stays under each player", async ({ people }) => {
  test.skip(!media, "needs ffmpeg to make the files");
  const ann = await people.member("Ann", { contextOptions: PHONE });
  const bo = await people.member("Bo");
  await befriend(ann, bo);
  const page = ann.page;
  const ranged = [];
  page.on("response", (res) => {
    if (res.url().includes("/api/attachments/") && res.status() === 206) ranged.push(res.request().headers().range);
  });
  const chat = await openChat(page, bo.displayName);
  await sendFile(page, bo.displayName, { name: "clip.webm", mimeType: "video/webm", buffer: media.video });
  await sendFile(page, bo.displayName, { name: "memo.mp3", mimeType: "audio/mpeg", buffer: media.audio });
  await sendFile(page, bo.displayName, { name: "clip.mov", mimeType: "video/quicktime", buffer: media.mov });

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
  // A long-press on the player still opens the bubble menu (the page's own gesture, not the player's controls).
  await figure.locator(".media-meta").click({ button: "right" });
  await expect(page.getByRole("menu", { name: "消息操作" })).toBeVisible();
});
