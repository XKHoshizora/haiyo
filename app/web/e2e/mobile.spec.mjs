// The phone, in a touch Chromium (375×812 and 402×874, `pointer: coarse`, `hover: none`): the tab bar at the bottom, fields
// that cannot make iOS zoom, the viewer inside the screen, a picture in its own shape, Back and reload in a conversation.
// What only an iPhone can show (the focus zoom itself, the safe areas, the edge swipe) is listed in the lane's report.
import { test, expect } from "./support/fixtures.mjs";
import { befriend, createGroupApi, sendApi, uniq } from "./support/accounts.mjs";
import { agentApi } from "./support/tools.mjs";
import { chatPane, createAgentUi, goTo, listRow, openChat, pickAvatarUi, sendFile } from "./support/app.mjs";
import { png } from "./support/files.mjs";
import { polishShot } from "./support/shots.mjs";

const PHONE = { viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 };
const BIG_PHONE = { viewport: { width: 402, height: 874 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 };

const bar = (page) => page.getByRole("navigation", { name: "主导航" });
const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const picture = (name, width, height) => ({ name, mimeType: "image/png", buffer: png(width, height) });

/** The font sizes of every field that is on the page now and could take the keyboard. */
const fieldSizes = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("input, textarea, select, [contenteditable]")]
      .filter((el) => !["checkbox", "radio", "range", "file", "hidden"].includes(el.type) && el.getClientRects().length > 0)
      .map((el) => ({ what: `${el.tagName.toLowerCase()}${el.type ? `[${el.type}]` : ""}`, size: parseFloat(getComputedStyle(el).fontSize) })),
  );

test("the rail is a tab bar along the bottom on the top-level lists and is gone inside a conversation", async ({ people }) => {
  const ann = await people.member("Ann", { contextOptions: PHONE });
  const bo = await people.member("Bo");
  const dm = await befriend(ann, bo);
  const page = ann.page;
  await sendApi(bo, dm, "你好呀");

  await expect(bar(page)).toBeVisible();
  const frame = await bar(page).boundingBox();
  expect(frame.x).toBe(0);
  expect(frame.width).toBe(375);
  expect(frame.y + frame.height).toBeGreaterThanOrEqual(812 - 1);
  expect(frame.height).toBeGreaterThanOrEqual(44);
  const entries = bar(page).getByRole("button");
  await expect(entries).toHaveCount(4);
  for (const entry of await entries.all()) expect((await entry.boundingBox()).height).toBeGreaterThanOrEqual(44);
  await expect(bar(page).getByRole("button", { name: /消息$/ })).toHaveAttribute("aria-current", "page");
  // The unread badge, on 消息.
  await expect(bar(page).locator(".badge")).toHaveText("1");
  // No left rail: the list starts at the left edge.
  expect((await page.locator(".list-col").boundingBox()).x).toBe(0);
  expect(await noSideways(page)).toBe(true);
  await polishShot(page, "mobile-tabbar-list");

  await bar(page).getByRole("button", { name: "通讯录" }).click();
  await expect(bar(page)).toBeVisible();
  await polishShot(page, "mobile-tabbar-contacts");
  await bar(page).getByRole("button", { name: "Agent" }).click();
  await expect(page.getByRole("heading", { name: "Agent" }).first()).toBeVisible();
  await polishShot(page, "mobile-tabbar-agents");
  await bar(page).getByRole("button", { name: "设置" }).click();
  await expect(page.locator(".settings-me")).toBeVisible();
  await expect(bar(page)).toBeVisible();
  await polishShot(page, "mobile-tabbar-settings");

  // Into a conversation: no bar; the composer is at the bottom of the screen; back returns to the list with the bar.
  await bar(page).getByRole("button", { name: /消息$/ }).click();
  const chat = await openChat(page, bo.displayName);
  await expect(bar(page)).toHaveCount(0);
  const composerBox = await chat.getByRole("textbox", { name: "消息内容" }).boundingBox();
  expect(composerBox.y + composerBox.height).toBeLessThanOrEqual(812);
  await polishShot(page, "mobile-tabbar-chat");
  await chat.getByRole("button", { name: "返回列表" }).click();
  await expect(bar(page)).toBeVisible();
  await expect(listRow(page, bo.displayName).first()).toBeVisible();

  // A settings page is a pushed page: no bar.
  await bar(page).getByRole("button", { name: "设置" }).click();
  await page.getByText("模型供应商", { exact: true }).first().click();
  await expect(bar(page)).toHaveCount(0);
});

test("a wide screen keeps the rail on the left (the same page at 1280 and at tablet width)", async ({ people }) => {
  const ann = await people.member("Ann");
  const page = ann.page;
  for (const width of [1280, 768]) {
    await page.setViewportSize({ width, height: 860 });
    const frame = await bar(page).boundingBox();
    expect(frame.x).toBe(0);
    expect(frame.height).toBeGreaterThan(400);
    expect(frame.width).toBeLessThan(100);
  }
});

test("nothing scrolls sideways from 320 to 430", async ({ people }) => {
  const ann = await people.member("Ann", { contextOptions: PHONE });
  for (const width of [320, 360, 375, 402, 430]) {
    await ann.page.setViewportSize({ width, height: 800 });
    expect(await noSideways(ann.page), `${width}px`).toBe(true);
    expect((await bar(ann.page).boundingBox()).width).toBe(width);
  }
});

test("every field is 16px or more on a touch screen, so iOS does not zoom in; and a tap leaves no hover behind", async ({ people }) => {
  const context = await people.newContext(PHONE);
  const login = await people.watchedPage(context, "visitor");
  await login.goto("/signin");
  const email = login.getByLabel(/邮箱|电子邮件/).first();
  await email.focus();
  expect((await fieldSizes(login)).length).toBeGreaterThan(1);
  for (const field of await fieldSizes(login)) expect(field.size, field.what).toBeGreaterThanOrEqual(16);
  await polishShot(login, "mobile-login-375");

  const ann = await people.member("Ann", { contextOptions: PHONE });
  const bo = await people.member("Bo");
  await befriend(ann, bo);
  const page = ann.page;
  for (const field of await fieldSizes(page)) expect(field.size, `list: ${field.what}`).toBeGreaterThanOrEqual(16);
  const chat = await openChat(page, bo.displayName);
  await chat.getByRole("textbox", { name: "消息内容" }).focus();
  await chat.getByRole("button", { name: "搜索本会话" }).click();
  const sizes = await fieldSizes(page);
  expect(sizes.length).toBeGreaterThanOrEqual(2);
  for (const field of sizes) expect(field.size, `chat: ${field.what}`).toBeGreaterThanOrEqual(16);
  await chat.getByRole("textbox", { name: "消息内容" }).focus();
  await polishShot(page, "mobile-chat-composer-375");
  // The mirror of the composer lays out like its box.
  expect(await page.evaluate(() => [getComputedStyle(document.querySelector(".composer textarea")).fontSize, getComputedStyle(document.querySelector(".composer-mirror")).fontSize])).toEqual(["16px", "16px"]);
  // Hints for a keyboard are not shown on a touch screen.
  await expect(page.getByText("Shift+Enter")).toHaveCount(0);

  // The letter of the fallback avatar sits in the middle (a grid, not a block at the top left).
  expect(await page.evaluate(() => getComputedStyle(document.querySelector(".avatar-img.avatar-fallback")).display)).toBe("grid");

  // No hover on a screen without one: a pointer over a row leaves it unpainted.
  await chat.getByRole("button", { name: "返回列表" }).click();
  const row = listRow(page, bo.displayName).first();
  const before = await row.evaluate((el) => getComputedStyle(el).backgroundColor);
  await row.hover();
  expect(await row.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(before);
  expect(await page.evaluate(() => matchMedia("(hover: hover)").matches)).toBe(false);
});

test("the settings page and the avatar dialog fit 375 and 402 wide; the help names a finger; 保存中… keeps its width", async ({ people }) => {
  for (const [options, label] of [[PHONE, "375"], [BIG_PHONE, "402"]]) {
    const ann = await people.member(`Ann${label}`, { contextOptions: options });
    const page = ann.page;
    await page.getByRole("button", { name: "设置" }).click();
    await page.getByText("我的资料", { exact: true }).first().click();
    await expect(page.getByRole("button", { name: "更换头像" })).toBeVisible();
    expect(await noSideways(page)).toBe(true);
    await polishShot(page, `mobile-settings-${label}`);
    const dialog = await pickAvatarUi(page, "更换头像", picture("p.png", 640, 480));
    await expect(dialog.getByText("拖动调整位置，双指或滑块缩放。")).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(options.viewport.width);
    expect(box.y + box.height).toBeLessThanOrEqual(options.viewport.height);
    const save = dialog.getByRole("button", { name: "保存", exact: true });
    const width = (await save.boundingBox()).width;
    const reset = (await dialog.getByRole("button", { name: "重置" }).boundingBox()).x;
    await polishShot(page, `mobile-avatar-dialog-${label}`);
    // While it saves its label is longer; the button and its neighbours stay where they were.
    await page.route("**/api/me/avatar", async (route) => {
      await new Promise((r) => setTimeout(r, 600));
      await route.continue();
    });
    await save.click();
    const saving = dialog.getByRole("button", { name: "保存中…" });
    await expect(saving).toBeVisible(); // (the request is held for 600 ms: the state is there to be measured)
    expect(Math.abs((await saving.boundingBox()).width - width)).toBeLessThanOrEqual(1);
    expect(Math.abs((await dialog.getByRole("button", { name: "重置" }).boundingBox()).x - reset)).toBeLessThanOrEqual(1);
    await expect(dialog).toBeHidden();
  }
});

test("pictures keep their own shape; the viewer fits the screen with its bar and controls; the original opens under its name", async ({ people }) => {
  const ann = await people.member("Ann", { contextOptions: PHONE });
  const bo = await people.member("Bo");
  await befriend(ann, bo);
  const page = ann.page;
  const chat = await openChat(page, bo.displayName);
  const long = `一张名字特别特别长的照片${"很长".repeat(25)}.png`;
  const pictures = [picture("竖.png", 300, 600), picture("横.png", 600, 300), picture("全景.png", 1000, 100), picture("长截图.png", 100, 1000), picture(long, 400, 300)];
  for (const item of pictures) await sendFile(page, bo.displayName, item, "选择图片或视频");

  const figureOf = (name) => chat.locator("figure.attachment-image").filter({ has: page.locator(`img[alt=${JSON.stringify(name)}]`) });
  const ratio = async (name) => {
    const box = await figureOf(name).boundingBox();
    return { box, ratio: box.width / box.height };
  };
  await expect.poll(async () => (await ratio("竖.png")).ratio).toBeCloseTo(0.5, 1);
  await expect.poll(async () => (await ratio("横.png")).ratio).toBeCloseTo(2, 1);
  expect((await ratio("全景.png")).ratio).toBeCloseTo(2.5, 1); // cut to 2.5:1
  expect((await ratio("长截图.png")).ratio).toBeCloseTo(0.4, 1); // cut to 1:2.5
  for (const item of pictures) {
    const { box } = await ratio(item.name);
    // (A panorama on a phone is 70% of the column wide, 201px: its 2.5:1 height of 80 is under the 96 floor, the width bound wins.)
    expect(Math.min(box.width, box.height), item.name).toBeGreaterThanOrEqual(item.name === "全景.png" ? 79 : 95);
    expect(box.height).toBeLessThanOrEqual(321);
    expect(box.x + box.width).toBeLessThanOrEqual(375);
  }
  await polishShot(page, "mobile-thumbnails-375");

  // The viewer: the bar below the top edge, all three controls inside the screen, the name cut, the picture in the middle.
  await figureOf(long).getByRole("button").click();
  const viewer = page.getByRole("dialog");
  await expect(viewer).toBeVisible();
  await expect.poll(() => viewer.locator(".viewer-img").evaluate((img) => img.naturalWidth)).toBe(400);
  const inside = async (locator) => {
    const box = await locator.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(375.5);
    expect(box.y + box.height).toBeLessThanOrEqual(812.5);
  };
  for (const name of ["关闭", `下载 ${long}`, "在新标签页打开原图"]) await inside(viewer.getByRole(name === "关闭" ? "button" : "link", { name }));
  await inside(viewer.locator(".viewer-bar"));
  expect(await viewer.locator(".viewer-name").evaluate((el) => el.scrollWidth > el.clientWidth && getComputedStyle(el).textOverflow === "ellipsis")).toBe(true);
  const img = await viewer.locator(".viewer-img").boundingBox();
  expect(Math.abs(img.x + img.width / 2 - 187.5)).toBeLessThanOrEqual(2);
  await polishShot(page, "mobile-viewer-375");

  // Opened original: the address ends in the file's name and answers like the plain one.
  const href = await viewer.getByRole("link", { name: "在新标签页打开原图" }).getAttribute("href");
  expect(decodeURIComponent(href.split("/").pop())).toBe(long);
  const named = await ann.request.get(href);
  expect(named.status()).toBe(200);
  expect(named.headers()["content-disposition"]).toContain("filename*=UTF-8''");
  await viewer.getByRole("button", { name: "关闭" }).click();
  await expect(viewer).toBeHidden();
});

test("Back: a conversation, the viewer over it, and a reload inside it", async ({ people }) => {
  const ann = await people.member("Ann", { contextOptions: PHONE });
  const bo = await people.member("Bo");
  const cy = await people.member("Cy");
  await befriend(ann, bo);
  await befriend(ann, cy);
  const page = ann.page;
  const tag = uniq(4);
  // Enough conversations that the list scrolls.
  const titles = [];
  for (let i = 1; i <= 16; i += 1) {
    const title = `群${String(i).padStart(2, "0")}-${tag}`;
    titles.push(title);
    await createGroupApi(ann, [bo, cy], title);
  }
  await page.reload();
  await expect(bar(page)).toBeVisible();
  const last = titles[0];
  const rows = page.locator(".list-col .rows");
  await expect(listRow(page, last).first()).toBeAttached();
  await rows.evaluate((el) => (el.scrollTop = el.scrollHeight));
  const top = await rows.evaluate((el) => el.scrollTop);
  expect(top).toBeGreaterThan(100);

  // Into a conversation: an entry at its own address; Back returns to the list where it was.
  await listRow(page, last).first().click();
  const chat = chatPane(page, last);
  await expect(chat).toBeVisible();
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/);
  await page.goBack();
  await expect(chat).toBeHidden();
  await expect(bar(page)).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  expect(Math.abs((await rows.evaluate((el) => el.scrollTop)) - top)).toBeLessThanOrEqual(2);

  // A picture, the viewer: Back closes the viewer and stays in the chat, Back again returns to the list.
  await listRow(page, last).first().click();
  await sendFile(page, last, picture("图.png", 80, 60), "选择图片或视频");
  await chat.getByRole("button", { name: "图.png" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(chat).toBeVisible();
  // (Closing it by hand leaves no entry behind: the next Back leaves the chat, not the viewer.)
  await chat.getByRole("button", { name: "图.png" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "关闭" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.goBack();
  await expect(chat).toBeHidden();
  await expect(bar(page)).toBeVisible();

  // Inside a conversation the page's own back button goes back too (no entry added), and a reload opens the conversation again.
  await listRow(page, last).first().click();
  await expect(chat).toBeVisible();
  await page.reload();
  await expect(chatPane(page, last)).toBeVisible();
  await expect(bar(page)).toHaveCount(0);
  await page.goBack();
  await expect(bar(page)).toBeVisible();
});

/** A finger resting on `locator` for `ms` (the DevTools touch events: a real touch, so pointerType is "touch"), then lifted. */
async function press(page, locator, ms) {
  const box = await locator.boundingBox();
  const x = box.x + Math.min(box.width / 2, 40);
  const y = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await page.waitForTimeout(ms);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

test("a long-press on a bubble opens its menu: 回复 quotes it, 复制 copies the text; no 回复 is drawn under a bubble on touch", async ({ people }) => {
  const ann = await people.member("Ann", { contextOptions: { ...PHONE, permissions: ["clipboard-read", "clipboard-write"] } });
  const bo = await people.member("Bo");
  const dm = await befriend(ann, bo);
  await sendApi(bo, dm, "长按我试试");
  const page = ann.page;
  const chat = await openChat(page, bo.displayName);
  const bubble = chat.locator(".bubble", { hasText: "长按我试试" });
  await expect(bubble).toBeVisible();
  // Not drawn on touch (a 1px clipped box, there for a keyboard).
  expect((await chat.locator(".msg-action").first().boundingBox()).width).toBeLessThanOrEqual(1);

  // A short touch is a tap: nothing opens. The browser's own selection does not start on a held bubble.
  await press(page, bubble, 150);
  await expect(page.getByRole("menu")).toHaveCount(0);
  await press(page, bubble, 700);
  const menu = page.getByRole("menu", { name: "消息操作" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem")).toHaveText(["回复", "复制"]);
  expect(await page.evaluate(() => window.getSelection().toString())).toBe("");
  const frame = await menu.boundingBox();
  expect(frame.x).toBeGreaterThanOrEqual(0);
  expect(frame.x + frame.width).toBeLessThanOrEqual(375);
  const composerTop = (await chat.locator(".composer").boundingBox()).y;
  expect(frame.y + frame.height).toBeLessThanOrEqual(composerTop);
  await polishShot(page, "mobile-bubble-menu");

  await menu.getByRole("menuitem", { name: "复制" }).click();
  await expect(page.locator(".toast")).toHaveText("已复制");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("长按我试试");

  await press(page, bubble, 700);
  await page.getByRole("menuitem", { name: "回复" }).click();
  await expect(chat.locator(".reply-chip")).toContainText("长按我试试");

  // A tap elsewhere closes an open menu.
  await press(page, bubble, 700);
  await expect(page.getByRole("menu")).toBeVisible();
  await page.mouse.click(10, 300);
  await expect(page.getByRole("menu")).toHaveCount(0);
});

test("the chat header is one row at 375 and at 320: back, picture, title, then search and menu, 44px each, nothing overlapping", async ({ people }) => {
  const ann = await people.member("Ann", { contextOptions: PHONE });
  const bo = await people.member("Bo");
  const cy = await people.member("Cy");
  await befriend(ann, bo);
  await befriend(ann, cy);
  const title = `一行${uniq(4)}`;
  await createGroupApi(ann, [bo, cy], title);
  const page = ann.page;
  await page.reload();
  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 800 });
    const chat = await openChat(page, title);
    const head = chat.locator(".chat-head");
    const parts = [
      head.getByRole("button", { name: "返回列表" }),
      head.locator(".chat-title"),
      head.getByRole("button", { name: "搜索本会话" }),
      head.getByRole("button", { name: "群资料" }),
      head.getByRole("button", { name: "会话资料" }),
    ];
    const boxes = [];
    for (const part of parts) boxes.push(await part.boundingBox());
    const middle = boxes[0].y + boxes[0].height / 2;
    for (const box of boxes) expect(Math.abs(box.y + box.height / 2 - middle), `${width}px: one row`).toBeLessThanOrEqual(30);
    for (const box of [boxes[0], boxes[2], boxes[3], boxes[4]]) expect(box.width).toBeGreaterThanOrEqual(43.5);
    // Left to right, no overlap (the picture's box is not counted: it is drawn smaller than its place).
    expect(boxes[1].x + boxes[1].width).toBeLessThanOrEqual(boxes[2].x + 0.5);
    expect(boxes[2].x + boxes[2].width).toBeLessThanOrEqual(boxes[3].x + 0.5);
    expect(boxes[3].x + boxes[3].width).toBeLessThanOrEqual(boxes[4].x + 0.5);
    expect(boxes[4].x + boxes[4].width).toBeLessThanOrEqual(width);
    expect(await noSideways(page)).toBe(true);
    if (width === 375) await polishShot(page, "mobile-chat-header-375");
    await chat.getByRole("button", { name: "返回列表" }).click();
  }
});

test("desktop: the 回复 button shows on hover and the right-click menu opens (a link keeps the browser's own menu: unit-tested, a person's text has no links)", async ({ people }) => {
  const ann = await people.member("Ann");
  const bo = await people.member("Bo");
  const dm = await befriend(ann, bo);
  await sendApi(bo, dm, "右键我");
  const page = ann.page;
  const chat = await openChat(page, bo.displayName);
  const item = chat.getByRole("listitem").filter({ hasText: "右键我" });
  const button = item.locator(".msg-action");
  await expect(button).toHaveCSS("opacity", "0");
  await item.hover();
  await expect(button).toHaveCSS("opacity", "1");

  await item.locator(".bubble").click({ button: "right" });
  const menu = page.getByRole("menu", { name: "消息操作" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem")).toHaveText(["回复", "复制"]);
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: "复制" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  // The keyboard's own way to it, from the 回复 button of the message.
  await button.focus();
  await page.keyboard.press("Shift+F10");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(button).toBeFocused();
});

test("history at 375: group info and the details panel are pages; the viewer survives a rotation; Back walks them one by one", async ({ people }) => {
  const ann = await people.member("Ann", { contextOptions: PHONE });
  const bo = await people.member("Bo");
  const cy = await people.member("Cy");
  await befriend(ann, bo);
  await befriend(ann, cy);
  const title = `页面${uniq(4)}`;
  await createGroupApi(ann, [bo, cy], title);
  const page = ann.page;
  await page.reload();
  const chat = await openChat(page, title);
  await sendFile(page, title, picture("轮转.png", 120, 80), "选择图片或视频");

  // The details panel is a page of its own: Back closes it and shows the chat.
  await chat.getByRole("button", { name: "会话资料" }).click();
  await expect(page.locator(".side-col")).toBeVisible();
  await page.goBack();
  await expect(page.locator(".side-col")).toHaveCount(0);
  await expect(chat).toBeVisible();
  // Closed by its own button it goes back too: the chat is the entry underneath, and Back from the chat is the list.
  await chat.getByRole("button", { name: "会话资料" }).click();
  await page.locator(".side-col").getByRole("button", { name: "关闭" }).click();
  await expect(page.locator(".side-col")).toHaveCount(0);

  // Group info: Back is the chat, and Back again the list.
  await chat.getByRole("button", { name: "群资料" }).click();
  await expect(page.getByRole("region", { name: "群资料" })).toBeVisible();
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}\/info$/);
  await page.goBack();
  await expect(chat).toBeVisible();

  // The viewer stays open while the phone turns (a width across 860px) and its entry is as it was.
  await chat.getByRole("button", { name: "轮转.png" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const entry = await page.evaluate(() => JSON.stringify(history.state));
  await page.setViewportSize({ width: 874, height: 402 });
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.setViewportSize({ width: 402, height: 874 });
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(await page.evaluate(() => JSON.stringify(history.state))).toBe(entry);
  await page.goBack();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(chat).toBeVisible();
  await page.goBack();
  await expect(chat).toBeHidden();
  await expect(bar(page)).toBeVisible();

  // Reload inside a chat and Back: one Back reaches the list, and another does not show the chat again.
  await listRow(page, title).first().click();
  await expect(chat).toBeVisible();
  await page.reload();
  await expect(chatPane(page, title)).toBeVisible();
  await page.goBack();
  await expect(bar(page)).toBeVisible();
  await expect(chatPane(page, title)).toBeHidden();
  await page.goBack().catch(() => {});
  await expect(chatPane(page, title)).toBeHidden();
});

test("history at 375: a new Agent ends in its chat and Back is its page, then the Agents list", async ({ people }) => {
  const ann = await people.member("Ann", { contextOptions: PHONE });
  const page = ann.page;
  await bar(page).getByRole("button", { name: "Agent" }).click();
  await page.getByRole("button", { name: "创建 Agent" }).click();
  await expect(page).toHaveURL(/\/agents\/new$/);
  // The form's own back goes back (the Agents list is the entry below).
  await page.getByRole("button", { name: /^返回/ }).first().click();
  await expect(page).toHaveURL(/\/agents$/);
  await expect(bar(page)).toBeVisible();
  await createAgentUi(page, { name: `小新${uniq(3)}` });
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("region", { name: /^小新/ })).toBeVisible();
  // Back from its chat is the Agent's own page (the form's entry became it), and Back again the Agents list: never the empty form.
  await page.goBack();
  await expect(page).toHaveURL(/\/agents\/[0-9a-f-]{36}$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/agents$/);
  await expect(bar(page)).toBeVisible();
});

test("history at 1280: a conversation is an address, selecting another is a push, Back walks them; a link opens it", async ({ people }) => {
  const ann = await people.member("Ann");
  const bo = await people.member("Bo");
  const cy = await people.member("Cy");
  await befriend(ann, bo);
  await befriend(ann, cy);
  const page = ann.page;
  await openChat(page, bo.displayName);
  const first = new URL(page.url()).pathname;
  expect(first).toMatch(/^\/chat\/[0-9a-f-]{36}$/);
  await listRow(page, cy.displayName).first().click();
  await expect(chatPane(page, cy.displayName)).toBeVisible();
  const second = new URL(page.url()).pathname;
  expect(second).not.toBe(first);
  await page.goBack();
  expect(new URL(page.url()).pathname).toBe(first);
  await expect(chatPane(page, bo.displayName)).toBeVisible();
  await page.goForward();
  await expect(chatPane(page, cy.displayName)).toBeVisible();
  // A link (a cold start) opens it; the rail is there and there are no entries made up.
  const length = await page.evaluate(() => history.length);
  await page.reload();
  await expect(chatPane(page, cy.displayName)).toBeVisible();
  expect(await page.evaluate(() => history.length)).toBe(length);
  const fresh = await ann.context.newPage();
  await fresh.goto(second);
  await expect(chatPane(fresh, cy.displayName)).toBeVisible();
});

test("a conversation I am not in: the address shows the list with the notice, at once", async ({ people }) => {
  const ann = await people.member("Ann");
  const page = await ann.context.newPage();
  await page.goto("/chat/00000000-0000-4000-8000-0000000000ee");
  await expect(page.locator(".toast")).toHaveText("找不到这个会话，或你已不在其中");
  await expect(page).toHaveURL(/\/$/);
});

test("N1 at 1280: a section is its last address (消息 returns to the open chat, and says so); a plain / is the list with the empty pane; the details panel stays with its conversation", async ({ people }) => {
  const ann = await people.member("Ann");
  const bo = await people.member("Bo");
  const cy = await people.member("Cy");
  await befriend(ann, bo);
  await befriend(ann, cy);
  const page = ann.page;
  await openChat(page, bo.displayName);
  const chatPath = new URL(page.url()).pathname;
  await page.getByRole("button", { name: "会话资料" }).click();
  await expect(page.locator(".side-col")).toBeVisible();
  await goTo(page, "通讯录");
  expect(new URL(page.url()).pathname).toBe("/contacts");
  await expect(page.locator(".side-col")).toHaveCount(0);
  await goTo(page, "消息");
  expect(new URL(page.url()).pathname).toBe(chatPath);
  await expect(chatPane(page, bo.displayName)).toBeVisible();
  // The panel was part of the first conversation's address, not of the section: it is closed, and the next conversation does not inherit it.
  await expect(page.locator(".side-col")).toHaveCount(0);
  await page.getByRole("button", { name: "会话资料" }).click();
  await listRow(page, cy.displayName).first().click();
  await expect(chatPane(page, cy.displayName)).toBeVisible();
  await expect(page.locator(".side-col")).toHaveCount(0);
  // The address tells the truth: a reload of / shows the list and the empty pane, as the page was left at / only when it was.
  const fresh = await ann.context.newPage();
  await fresh.goto("/");
  await expect(fresh.getByText("选择一个会话开始聊天")).toBeVisible();
});

test("N2 at 375: the add form of the providers is a page: Back is the list, Forward the typed form (the key never in the address), a fresh Add is empty", async ({ people }) => {
  const ann = await people.member("Ann", { contextOptions: PHONE });
  const page = ann.page;
  await bar(page).getByRole("button", { name: "设置" }).click();
  await page.getByText("模型供应商", { exact: true }).first().click();
  await page.getByRole("button", { name: /添加供应商/ }).click();
  await expect(page).toHaveURL(/\/settings\/providers\/new$/);
  await page.getByLabel("名称").fill("草稿供应商");
  await page.getByLabel("密钥").fill("sk-draft-secret-1234567890");
  await page.goBack();
  await expect(page).toHaveURL(/\/settings\/providers$/);
  await expect(page.getByRole("button", { name: /添加供应商/ })).toBeVisible();
  await page.goForward();
  await expect(page.getByLabel("名称")).toHaveValue("草稿供应商");
  await expect(page.getByLabel("密钥")).toHaveValue("sk-draft-secret-1234567890");
  expect(page.url()).not.toContain("sk-draft");
  expect(await page.evaluate(() => JSON.stringify(history.state) + JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }))).not.toContain("sk-draft");
  await page.goBack();
  await page.getByRole("button", { name: /添加供应商/ }).click();
  await expect(page.getByLabel("名称")).toHaveValue("");
});

test("profile-style headers at 320 and 375: the title keeps a sensible width (a long Latin name, a long CJK name), the actions wrap to a row of their own", async ({ people }) => {
  const ann = await people.member("Ann", { contextOptions: PHONE });
  const bo = await people.member("Bo");
  const cy = await people.member("Cy");
  await befriend(ann, bo);
  await befriend(ann, cy);
  const page = ann.page;
  const latin = "Wolfeschlegelsteinha";
  const cjk = "一个名字特别特别长的智能助手朋友";
  await createAgentUi(page, { name: latin });
  const groupTitle = `${cjk}${uniq(3)}`;
  await createGroupApi(ann, [bo, cy], groupTitle);
  await page.reload();

  // A list with the tab bar: waits for whichever of the tab bar and a chat's 返回列表 is on the page (the first paint after the reload is already the chat's), and goes back by the button.
  const toList = async () => {
    const back = page.getByRole("button", { name: "返回列表" });
    await expect(bar(page).or(back).first()).toBeVisible();
    if (!(await bar(page).isVisible())) await back.click();
    await expect(bar(page)).toBeVisible();
  };
  const check = async (header, what) => {
    const title = await header.locator("h2").first().boundingBox();
    expect(title.width, `${what}: the title column is not one letter wide`).toBeGreaterThanOrEqual(120);
    const actions = header.locator(".head-actions, .grow ~ *").first();
    if (await actions.count()) {
      const a = await actions.boundingBox();
      const apart = a.y >= title.y + title.height - 1 || a.x >= title.x + title.width - 1 || a.x + a.width <= title.x + 1;
      expect(apart, `${what}: actions do not overlap the title`).toBe(true);
    }
  };
  for (const width of [320, 375]) {
    await page.setViewportSize({ width, height: 800 });
    // An Agent's page (my own).
    await toList();
    await expect(bar(page)).toBeVisible();
    await bar(page).getByRole("button", { name: "Agent" }).click();
    await page.getByRole("button").filter({ hasText: latin }).first().click();
    await check(page.locator("section.page .profile-head").first(), `Agent page at ${width}`);
    expect(await noSideways(page)).toBe(true);
    await page.getByRole("button", { name: /^返回/ }).first().click();
    // Group info.
    await bar(page).getByRole("button", { name: /消息$/ }).click();
    await toList(); // (消息 returns to the chat that was open last, the Agent's; a phone shows one page, whose 返回列表 is the way to the list)
    const chat = await openChat(page, groupTitle);
    await chat.getByRole("button", { name: "群资料" }).click();
    await check(page.getByRole("region", { name: "群资料" }).locator(".profile-head"), `group info at ${width}`);
    expect(await noSideways(page)).toBe(true);
    await page.getByRole("button", { name: /^返回群聊/ }).click();
    await chat.getByRole("button", { name: "返回列表" }).click();
    // A contact's card, and my profile.
    await bar(page).getByRole("button", { name: "通讯录" }).click();
    await page.getByRole("button").filter({ hasText: bo.displayName }).first().click();
    await check(page.locator("section.page .profile-head").first(), `contact card at ${width}`);
    await page.getByRole("button", { name: /^返回/ }).first().click();
    await bar(page).getByRole("button", { name: "设置" }).click();
    await page.getByText("我的资料", { exact: true }).first().click();
    await check(page.locator("section.page .profile-head").first(), `my profile at ${width}`);
    await page.getByRole("button", { name: /^返回/ }).first().click();
    await bar(page).getByRole("button", { name: /消息$/ }).click();
  }
  await polishShot(page, "mobile-profile-header-320");
});

test("a quote draws the mention as @name, as the bubble does: the quoted message's mentions come with its preview", async ({ people }) => {
  const ann = await people.member("Ann");
  const bo = await people.member("Bo");
  const cy = await people.member("Cy");
  await befriend(ann, bo);
  await befriend(ann, cy);
  const title = `引用${uniq(4)}`;
  const g = await createGroupApi(ann, [bo, cy], title);
  const call = `@${cy.handle}`;
  await sendApi(ann, g, `${call} 你好`, [{ id: cy.id, start: 0, length: call.length }]);
  const page = bo.page;
  const chat = await openChat(page, title);
  const item = chat.getByRole("listitem").filter({ hasText: "你好" });
  await item.hover();
  await item.locator(".msg-action").click();
  await chat.getByRole("textbox", { name: "消息内容" }).fill("收到");
  await chat.getByRole("textbox", { name: "消息内容" }).press("Enter");
  const reply = chat.getByRole("listitem").filter({ hasText: "收到" });
  const quote = reply.locator("blockquote");
  await expect(quote).toContainText(`@${cy.displayName} 你好`);
  expect(await quote.textContent()).not.toContain(call);
  // A reload: the quote is drawn from the wire again (the quoted message need not be loaded for it).
  await page.reload();
  const again = chatPane(page, title);
  await expect(again.locator("blockquote").first()).toContainText(`@${cy.displayName} 你好`);
});

test("ui2 A: sign-in with the keyboard up (the window cut to 402×420): the focused field and 登录 are both on screen, the page stays put under the status bar", async ({ people }) => {
  const visitor = await people.stranger("Visitor");
  const context = await visitor.page.context().browser().newContext({ ...BIG_PHONE, locale: "zh-CN" });
  const page = await context.newPage();
  await page.goto("/signin");
  await expect(page.getByRole("heading", { name: "登录 Haiyo" })).toBeVisible();
  await polishShot(page, "ui2-signin-rest");
  await page.setViewportSize({ width: 402, height: 420 }); // (the keyboard takes the rest: the page is what is left)
  await page.getByLabel("密码").focus();
  const inside = async (locator) => {
    const box = await locator.boundingBox();
    return box.y >= 0 && box.y + box.height <= 420;
  };
  expect(await inside(page.getByLabel("密码"))).toBe(true);
  expect(await inside(page.getByRole("button", { name: "登录", exact: true }))).toBe(true);
  // The document itself does not scroll (nothing slides under the status bar); the page layer does.
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await polishShot(page, "ui2-signin-keyboard");
  await context.close();
});

test("ui2 B, C, F, M: the tab pages sit on the page itself, the detail pages scroll to their very bottom, one gutter, the group picture whole", async ({ people }) => {
  const ann = await people.member("Ann", { contextOptions: BIG_PHONE });
  const bo = await people.member("Bo");
  const cy = await people.member("Cy");
  await befriend(ann, bo);
  await befriend(ann, cy);
  const page = ann.page;
  const title = `三人群${uniq(3)}`;
  await createGroupApi(ann, [bo, cy], title);
  await page.reload();
  // B: the list is not a panel of its own (no edge under the status bar).
  await expect(bar(page)).toBeVisible();
  expect(await page.locator(".list-col").evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
  await polishShot(page, "ui2-list");
  await goTo(page, "设置");
  await polishShot(page, "ui2-settings");
  const rows = page.locator(".list-col .row.slim");
  await expect(rows.first().locator("svg.row-chevron")).toBeVisible();
  // F: the list's text and a detail page's text start at the same x.
  const listX = await page.locator(".list-col .row.slim .row-name").first().evaluate((el) => el.getBoundingClientRect().left);
  await page.getByRole("button", { name: /记忆宫殿/ }).click();
  await expect(page.getByRole("region", { name: "记忆宫殿" })).toBeVisible();
  const pageX = await page.locator("section.page h2").first().evaluate((el) => el.getBoundingClientRect().left);
  expect(Math.abs(pageX - (await page.locator("section.page .back").evaluate((el) => el.getBoundingClientRect().left)))).toBeLessThanOrEqual(1);
  expect(pageX).toBeGreaterThanOrEqual(19);
  expect(listX - 20).toBeLessThanOrEqual(20); // (the row's own inner padding sits on the same 20px gutter plus its 17px: both start on the grid)
  // C: scrolled to the end, the last thing on the page is above the bottom edge and nothing is cut by a band under it.
  const scroller = page.locator("section.page .page-body");
  await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight));
  const metrics = await scroller.evaluate((el) => {
    const last = el.lastElementChild.getBoundingClientRect();
    return { bottomOfScroller: el.getBoundingClientRect().bottom, lastBottom: last.bottom, viewport: window.innerHeight, pad: parseFloat(getComputedStyle(el).paddingBottom) };
  });
  expect(metrics.bottomOfScroller).toBeGreaterThanOrEqual(metrics.viewport - 1); // (the scroller runs to the screen's bottom: no band under it)
  expect(metrics.lastBottom).toBeLessThanOrEqual(metrics.bottomOfScroller);
  expect(metrics.pad).toBeGreaterThanOrEqual(28);
  await polishShot(page, "ui2-memory-bottom");
  await page.getByRole("button", { name: /^返回/ }).first().click();
  // M: the composite picture in the header has its three members inside its own box.
  const chat = await openChat(page, title);
  const box = await chat.locator(".chat-head .group-avatar").boundingBox();
  for (const member of await chat.locator(".chat-head .group-avatar > .avatar").all()) {
    const m = await member.boundingBox();
    expect(m.x).toBeGreaterThanOrEqual(box.x - 2);
    expect(m.y).toBeGreaterThanOrEqual(box.y - 2);
    expect(m.x + m.width).toBeLessThanOrEqual(box.x + box.width + 2);
    expect(m.y + m.height).toBeLessThanOrEqual(box.y + box.height + 2);
  }
  await polishShot(page, "ui2-group-header");
});

test("ui2 H, I, J, N, O: deleted Agents behind one entry and quiet in the list, the providers page and the usage page on a phone, a long group title on two lines", async ({ people }) => {
  const ann = await people.member("Ann", { contextOptions: BIG_PHONE });
  const bo = await people.member("Bo");
  const cy = await people.member("Cy");
  await befriend(ann, bo);
  await befriend(ann, cy);
  const page = ann.page;
  const names = [`小查${uniq(3)}`, `小搜${uniq(3)}`];
  for (const name of names) await agentApi(ann, { name });
  await page.reload();
  // Delete one of them on its page.
  await goTo(page, "Agent");
  await page.getByRole("button").filter({ has: page.getByText(names[0], { exact: true }) }).first().click();
  await page.getByRole("button", { name: "删除 Agent" }).click();
  await page.getByRole("dialog", { name: `删除${names[0]}` }).getByRole("button", { name: "确认删除" }).click();
  await expect(page.getByRole("status").filter({ hasText: `已删除${names[0]}` })).toBeVisible();
  // H: the Agent tab lists the live one and one entry 已删除（1）; it opened itself on the deleted Agent's page and stays as it was left.
  await page.getByRole("button", { name: /^返回/ }).first().click();
  await expect(bar(page)).toBeVisible();
  const entry = page.getByRole("button", { name: "已删除（1）" });
  await expect(entry).toHaveAttribute("aria-expanded", "true");
  await polishShot(page, "ui2-agents-expanded");
  await entry.click();
  await expect(entry).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".list-col .row-name", { hasText: names[0] })).toHaveCount(0);
  await expect(page.locator(".list-col .row-name", { hasText: names[1] })).toHaveCount(1);
  await polishShot(page, "ui2-agents-collapsed");
  // O: the message list — the deleted Agent's conversation: one chip, muted, no badge.
  await goTo(page, "消息");
  const row = page.locator(".list-col .row", { hasText: names[0] });
  await expect(row.locator(".tag")).toHaveText(["已删除"]);
  await expect(row).toHaveClass(/quiet/);
  await expect(row.locator(".badge")).toHaveCount(0);
  await polishShot(page, "ui2-chats-quiet");
  // I, J: the providers page and the usage page on a phone.
  await goTo(page, "设置");
  await page.getByRole("button", { name: /模型供应商/ }).click();
  await expect(page.getByRole("heading", { name: "模型供应商", level: 2 })).toBeVisible();
  const actions = await page.locator("section.page .head-actions").boundingBox();
  const lead = await page.locator("section.page .profile-head p.muted").boundingBox();
  expect(actions.y).toBeGreaterThanOrEqual(lead.y + lead.height - 1); // (the button has a row of its own, below the text)
  expect(lead.width).toBeGreaterThan(402 * 0.8);
  await polishShot(page, "ui2-providers");
  await page.getByRole("button", { name: /^返回/ }).first().click();
  await page.getByRole("button", { name: /用量与余额/ }).click();
  await expect(page.getByRole("heading", { name: "用量与余额", level: 2 })).toBeVisible();
  await expect(page.locator("section.page")).not.toContainText(/\d\.\d{3,}/); // (no long decimals anywhere)
  await expect(page.locator(".toast")).toHaveCount(0); // (an earlier notice is gone: nothing covers the last paragraph)
  await polishShot(page, "ui2-usage");
  await page.getByRole("button", { name: /^返回/ }).first().click();
  // N: a long group title takes two lines, the three controls stay.
  const title = `一个名字特别特别长的三人群聊${uniq(3)}`;
  await createGroupApi(ann, [bo, cy], title);
  await page.reload();
  const chat = await openChat(page, title);
  const h2 = await chat.locator(".chat-head h2").boundingBox();
  expect(h2.height).toBeGreaterThan(30); // (two lines)
  for (const control of ["搜索本会话", "群资料", "会话资料"]) expect((await chat.getByRole("button", { name: control }).boundingBox()).height).toBeGreaterThanOrEqual(44);
  await polishShot(page, "ui2-long-title-header");
});

test("ui2 I1: the loading line and the crash fallback are centred on the layer, at 402 and at desktop width", async ({ people }) => {
  for (const [label, viewport, options] of [["402", { width: 402, height: 874 }, BIG_PHONE], ["desktop", { width: 1280, height: 800 }, {}]]) {
    const ann = await people.member(`Ann${label}`, { contextOptions: { ...options, viewport }, open: false });
    // Loading: the first answer of /api/me never comes.
    const loading = await ann.context.newPage();
    await loading.route("**/api/me", () => {});
    await loading.goto("/");
    const line = loading.getByRole("status").filter({ hasText: "正在加载" });
    await expect(line).toBeVisible();
    const box = await line.boundingBox();
    expect(Math.abs(box.x + box.width / 2 - viewport.width / 2)).toBeLessThan(8);
    expect(Math.abs(box.y + box.height / 2 - viewport.height / 2)).toBeLessThan(40);
    await polishShot(loading, `ui2-loading-${label}`);
    await loading.close();
    // The crash fallback: the shell's chunk cannot be fetched (twice: the page may reload itself once for a stale chunk).
    const broken = await ann.context.newPage();
    await broken.addInitScript(() => sessionStorage.setItem("stale-chunk-reload", String(Date.now())));
    await broken.route("**/assets/AppShell-*.js", (route) => route.abort());
    await broken.goto("/");
    const alert = broken.getByRole("alert").filter({ hasText: /请刷新/ });
    await expect(alert).toBeVisible();
    const stack = await broken.locator(".auth-stack").boundingBox();
    expect(Math.abs(stack.x + stack.width / 2 - viewport.width / 2)).toBeLessThan(8);
    expect(Math.abs(stack.y + stack.height / 2 - viewport.height / 2)).toBeLessThan(40);
    // The message above the button, not beside it.
    expect((await broken.getByRole("button", { name: "刷新页面" }).boundingBox()).y).toBeGreaterThan((await alert.boundingBox()).y);
    await polishShot(broken, `ui2-crash-${label}`);
    await broken.close();
  }
});
