// Fixes from the owner's iPhone round (shots 79 to 87): the pages that scroll inside the shell stay painted, the model
// sheet scrolls to its last row, the thinking-level choice of a provider's model. At 402×874, touch.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { test, expect } from "./support/fixtures.mjs";
import { befriend, uniq } from "./support/accounts.mjs";
import { chatPane, goTo, listRow, openChat } from "./support/app.mjs";
import { canControlService } from "./support/control.mjs";
import { modelStub } from "./support/model-stub.mjs";
import { addApi, agentApi, groupApi } from "./support/tools.mjs";
import { WEB_DIR } from "./support/env.mjs";

const BIG_PHONE = { viewport: { width: 402, height: 874 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 };
/** Phones: the owner's class (shot 86 measures as 430x932) and 402x874. Chromium with touch events: these guard layout arithmetic, not what iOS paints. */
const PHONES = [["402x874", { width: 402, height: 874 }], ["430x932", { width: 430, height: 932 }]];

const SHOTS = process.env.WEBFIX_SHOTS ?? path.resolve(WEB_DIR, "..", "..", "..", "..", ".superpowers", "sdd", "2026-11-22-polish", "webfix-shots");
/** A screenshot for the report (only with E2E_SHOTS=1). */
async function shot(page, name) {
  if (process.env.E2E_SHOTS !== "1") return;
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), animations: "disabled", caret: "hide" });
}

/** A touch drag that scrolls the element under (x, y) by `dy` (positive: down), as a finger does; the wheel where the protocol has no touch gesture. */
async function touchScroll(page, x, y, dy) {
  const cdp = await page.context().newCDPSession(page);
  try {
    // A finger: down, a run of small moves (the page takes them for a pan), up. Nothing is flung afterwards.
    const steps = Math.max(4, Math.ceil(Math.abs(dy) / 25));
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (let i = 1; i <= steps; i += 1) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - (dy * i) / steps }] });
      await page.waitForTimeout(8);
    }
    await page.waitForTimeout(120);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await cdp.detach();
  }
  await page.waitForTimeout(250);
}

/**
 * For each box (CSS px, in the viewport) how many dark pixels (text) its screenshot has: a label, a heading or a hint has some, a box the
 * browser left blank has none.
 */
async function inkIn(page, boxes) {
  const png = (await page.screenshot({ animations: "disabled", caret: "hide" })).toString("base64");
  const width = await page.evaluate(() => window.innerWidth);
  // Decoded on a blank page of its own (the site's pages forbid reading a data: address).
  const context = await page.context().browser().newContext();
  const reader = await context.newPage();
  try {
    return await reader.evaluate(
    async ({ png, boxes, width }) => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
      const scale = bitmap.width / width;
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      return boxes.map((b) => {
        const data = ctx.getImageData(Math.round(b.x * scale), Math.round(b.y * scale), Math.max(1, Math.round(b.width * scale)), Math.max(1, Math.round(b.height * scale))).data;
        // Text is far darker than what it stands on (a gradient or a field's white differs from its neighbour by a few levels only).
        let dark = 0;
        for (let i = 0; i < data.length; i += 4) if (data[i] + data[i + 1] + data[i + 2] < 3 * 150) dark += 1;
        return dark;
      });
    },
    { png, boxes, width },
    );
  } finally {
    await context.close();
  }
}

/** The labels, headings and hints of the scroller that stand wholly inside its visible part now. */
async function visibleBlocks(page, scroller) {
  return page.evaluate((selector) => {
    const root = document.querySelector(selector).getBoundingClientRect();
    return [...document.querySelectorAll(`${selector} .field-label, ${selector} h3, ${selector} .field-hint`)]
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 40 && r.height > 8 && r.top >= root.top + 2 && r.bottom <= root.bottom - 2)
      .map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height }));
  }, scroller);
}

/** Scrolls the form to each offset by touch and asserts that everything in its visible part, the upper half too, is drawn. */
async function scrollAndCheck(page, body, label) {
  const frame = await body.boundingBox();
  const max = await body.evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(max).toBeGreaterThan(500); // long enough to scroll through
  for (const target of [180, 420, 700, 360, 120, Math.min(max, 1200)]) {
    const now = await body.evaluate((el) => el.scrollTop);
    await touchScroll(page, frame.x + frame.width / 2, frame.y + frame.height / 2, target - now);
    expect(Math.abs((await body.evaluate((el) => el.scrollTop)) - target), "the touch really scrolled the form").toBeLessThan(40);
    const blocks = await visibleBlocks(page, "form.page-body");
    expect(blocks.length).toBeGreaterThan(0);
    const ink = await inkIn(page, blocks);
    ink.forEach((amount, i) => expect(amount, `${label}: block at y=${Math.round(blocks[i].y)} after scrolling to ${target}`).toBeGreaterThan(8));
    await shot(page, `f2-${label}-scrolled-${target}`);
  }
}

for (const [size, viewport] of PHONES) {
  test(`F2 (Chromium only, layout guard, not iOS painting) ${size}: a long form scrolled by touch is drawn from its top edge to its bottom, create and edit page`, async ({ people }) => {
    const ann = await people.member("Ann", { contextOptions: { ...BIG_PHONE, viewport } });
    const page = ann.page;
    await goTo(page, "Agent");
    await page.getByRole("button", { name: "创建 Agent", exact: true }).click();
    await expect(page.getByRole("region", { name: "创建 Agent" })).toBeVisible();
    const body = page.locator("form.page-body");
    await expect(body).toBeVisible();
    // The block the owner's band covered: 主动参与群聊 on, with 话多话少 and the daily number under it.
    const proactive = page.getByRole("switch", { name: /主动参与群聊/ }).or(page.getByRole("checkbox", { name: /主动参与群聊/ }));
    // (Loud: a pass always means the block was there.)
    await expect(proactive.first(), "the e2e site offers 主动参与群聊").toBeVisible();
    await proactive.first().click();
    await expect(page.getByText("话多话少", { exact: true }).first()).toBeVisible();
    await shot(page, `f2-create-top-${size}`);
    await scrollAndCheck(page, body, `create-${size}`);

    // The check sees a blank: with the texts hidden most of the same boxes carry no ink.
    await body.evaluate((el) => (el.scrollTop = 0));
    const labels = await visibleBlocks(page, "form.page-body");
    await page.addStyleTag({ content: "form.page-body .field-label, form.page-body h3, form.page-body .field-hint { visibility: hidden !important; }" });
    const blank = await inkIn(page, labels);
    expect(blank.filter((amount) => amount < 3).length).toBeGreaterThan(blank.length / 2);
    await page.goto("/");

    const agent = await agentApi(ann, { name: "表单检" });
    await page.goto("/");
    await goTo(page, "Agent");
    await listRow(page, agent.name).click();
    await page.getByRole("button", { name: "编辑" }).click();
    await expect(page.getByRole("region", { name: "编辑 Agent" })).toBeVisible();
    await scrollAndCheck(page, page.locator("form.page-body"), `edit-${size}`);
  });
}

/** A provider of `count` models (named `<prefix>-01` ...) added through the API; resolves with its name. */
async function providerWithModels(person, count, prefix) {
  const name = `prov-${uniq(6)}`;
  const models = Array.from({ length: count }, (_, i) => ({ name: `${prefix}-${String(i + 1).padStart(2, "0")}` }));
  const res = await person.request.post("/api/providers", { data: { name, protocol: "openai_chat", baseUrl: modelStub.baseUrl, apiKey: `sk-e2e-${uniq(8)}-not-real`, models } });
  expect(res.status(), await res.text()).toBe(201);
  return name;
}

/** Settings > 记忆宫殿 and the memory model's sheet, open. */
async function openMemoryModelSheet(page) {
  await goTo(page, "设置");
  await page.getByRole("button", { name: /记忆宫殿/ }).click();
  await page.getByRole("combobox", { name: /用哪个模型整理记忆/ }).or(page.getByRole("button", { name: /用哪个模型整理记忆/ })).first().click();
  const list = page.getByRole("listbox", { name: "模型" });
  await expect(list).toBeVisible();
  return list;
}

/** The last row and the sheet in numbers: where the row ends against the list's visible part, the footer, and the screen; and the cue. */
async function listState(page, lastName) {
  await page.waitForTimeout(350); // (the sheet's own slide-in is over)
  return page.evaluate((name) => {
    const list = document.querySelector(".model-list");
    const row = [...list.querySelectorAll("[role=option]")].find((el) => el.getAttribute("aria-label")?.startsWith(name));
    const foot = document.querySelector(".model-foot").getBoundingClientRect();
    const pop = document.querySelector(".model-pop").getBoundingClientRect();
    const l = list.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    return { rowTop: r.top, rowBottom: r.bottom, listTop: l.top, listBottom: l.bottom, footTop: foot.top, popBottom: pop.bottom, screen: window.innerHeight, more: list.hasAttribute("data-more"), scrollable: list.scrollHeight > list.clientHeight + 1 };
  }, lastName);
}

const SHEET_SIZES = [["360x740", { width: 360, height: 740 }], ["402x874", { width: 402, height: 874 }], ["430x932", { width: 430, height: 932 }]];

for (const [size, viewport] of SHEET_SIZES) {
  test(`F3 (Chromium only) ${size}: 6 own models (a few more rows than the old 560px sheet showed), no keyboard: the last row is whole above the footer, or the list is cut with the more-below cue`, async ({ people }) => {
    test.skip(!canControlService, "needs the local model stub");
    const ann = await people.member("Ann", { contextOptions: { ...BIG_PHONE, viewport } });
    const prefix = `modelx${uniq(3)}`;
    await providerWithModels(ann, 6, prefix);
    await ann.page.goto("/");
    await openMemoryModelSheet(ann.page);
    await shot(ann.page, `f3-six-open-${size}`);
    const at = await listState(ann.page, `${prefix}-06`);
    const whole = at.rowTop >= at.listTop - 0.5 && at.rowBottom <= at.listBottom + 0.5;
    // Either every row is whole in the list (and nothing says more), or the list is cut and says so. Never cut without the cue.
    if (whole) expect(at.more, "everything fits: no cue").toBe(false);
    else expect(at.more, "cut at the edge: the cue shows").toBe(true);
    expect(at.footTop).toBeGreaterThanOrEqual(at.listBottom - 0.5);
    expect(at.popBottom).toBeLessThanOrEqual(at.screen + 0.5);
  });

  test(`F3 (Chromium only) ${size}: 12 own models: the cue shows until the end, the last row scrolls whole above the footer`, async ({ people }) => {
    test.skip(!canControlService, "needs the local model stub");
    const ann = await people.member("Ann", { contextOptions: { ...BIG_PHONE, viewport } });
    const prefix = `modelx${uniq(3)}`;
    await providerWithModels(ann, 12, prefix);
    await ann.page.goto("/");
    const list = await openMemoryModelSheet(ann.page);
    const first = await listState(ann.page, `${prefix}-12`);
    expect(first.scrollable).toBe(true);
    expect(first.more, "cue at open").toBe(true);
    await shot(ann.page, `f3-twelve-open-${size}`);
    const frame = await list.boundingBox();
    for (let i = 0; i < 8; i += 1) await touchScroll(ann.page, frame.x + frame.width / 2, frame.y + frame.height / 2, 400);
    const end = await listState(ann.page, `${prefix}-12`);
    expect(end.rowBottom, "the last row ends above the footer").toBeLessThanOrEqual(end.footTop + 0.5);
    expect(end.rowTop).toBeGreaterThanOrEqual(end.listTop - 0.5);
    expect(end.more, "no cue at the end").toBe(false);
    expect(end.popBottom).toBeLessThanOrEqual(end.screen + 0.5);
    await shot(ann.page, `f3-twelve-end-${size}`);
  });
}

test("F3 (Chromium only, layout arithmetic: the window is cut to 520 high, which is not an on-screen keyboard): the sheet stays on screen", async ({ people }) => {
  test.skip(!canControlService, "needs the local model stub");
  const ann = await people.member("Ann", { contextOptions: { ...BIG_PHONE, viewport: { width: 402, height: 520 } } });
  const prefix = `modelx${uniq(3)}`;
  await providerWithModels(ann, 12, prefix);
  await ann.page.goto("/");
  await openMemoryModelSheet(ann.page);
  const at = await listState(ann.page, `${prefix}-12`);
  expect(at.popBottom).toBeLessThanOrEqual(at.screen + 0.5);
  expect(at.footTop).toBeLessThanOrEqual(at.screen);
});

/** Every box in the app that is scrolled, by where it is (class and path): the page's position as a person sees it. */
const scrollPositions = (page) =>
  page.evaluate(() =>
    [document.scrollingElement, ...document.querySelectorAll(".app *")]
      .filter((el) => el && el.scrollTop > 0)
      .map((el) => `${el.tagName}.${el.className}:${Math.round(el.scrollTop)}`),
  );

/** The computed overflow-y of every box of the app that scrolls (or did): where the page behind a layer is no scroller any more, all are "hidden". */
const scrollerModes = (page) =>
  page.evaluate(() => [...document.querySelectorAll("#root *")].filter((el) => el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1).map((el) => `${el.tagName}.${el.className}:${getComputedStyle(el).overflowY}/${getComputedStyle(el).overflowX}`));

test("F3 (Chromium only, it cannot show how iOS hands a gesture on): with a sheet open a drag on the list, the search row, the footer and the backdrop does not move the page, and closing puts it back exactly", async ({ people }) => {
  test.skip(!canControlService, "needs the local model stub");
  const ann = await people.member("Ann", { contextOptions: { ...BIG_PHONE, viewport: { width: 430, height: 560 } } });
  const prefix = `modelx${uniq(3)}`;
  await providerWithModels(ann, 4, prefix);
  await ann.page.goto("/");
  const page = ann.page;
  await goTo(page, "设置");
  await page.getByRole("button", { name: /记忆宫殿/ }).click();
  // The page under the sheet is scrolled a little first.
  const scrolled = await page.evaluate(() => {
    const box = [...document.querySelectorAll(".app *")].find((el) => ["auto", "scroll"].includes(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 80);
    if (box) box.scrollTop = 60;
    return Boolean(box);
  });
  expect(scrolled, "something on the page behind scrolls").toBe(true);
  const before = await scrollPositions(page);
  expect(before.length).toBeGreaterThan(0);
  const modesBefore = await scrollerModes(page);
  expect(modesBefore.some((m) => /auto|scroll/.test(m))).toBe(true);
  await page.getByRole("combobox", { name: /用哪个模型整理记忆/ }).or(page.getByRole("button", { name: /用哪个模型整理记忆/ })).first().click();
  const list = page.getByRole("listbox", { name: "模型" });
  await expect(list).toBeVisible();
  // Nothing behind the layer is a scroller (touch screen): every box of the app that overflows has hidden overflow, its position unchanged.
  const modesDuring = await scrollerModes(page);
  expect(modesDuring.length).toBeGreaterThan(0);
  for (const mode of modesDuring) expect(mode, "a scroller behind the sheet is not scrollable").toMatch(/:hidden\/hidden$/);
  expect(await scrollPositions(page)).toEqual(before);
  const search = await page.getByRole("combobox", { name: "搜索模型" }).boundingBox();
  const foot = await page.locator(".model-foot").boundingBox();
  const lst = await list.boundingBox();
  const spots = [
    [lst.x + lst.width / 2, lst.y + lst.height / 2, 300],
    [lst.x + lst.width / 2, lst.y + lst.height / 2, -300],
    [search.x + 40, search.y + search.height / 2, 300],
    [foot.x + 20, foot.y + foot.height / 2, 300],
  ];
  // (A touch that starts on the backdrop closes the sheet, as a tap there always did: last.)
  const backdrop = [[200, 60, 300]];
  const during = await scrollPositions(page);
  const withoutList = (positions) => positions.filter((p) => !p.includes("model-list"));
  for (const [x, y, dy] of spots) {
    await touchScroll(page, x, y, dy);
    // (The list's own scroll is not the page's.)
    expect(withoutList(await scrollPositions(page))).toEqual(withoutList(during));
  }
  expect(await page.evaluate(() => document.documentElement.hasAttribute("data-layer-open"))).toBe(true);
  for (const [x, y, dy] of backdrop) {
    await touchScroll(page, x, y, dy);
    expect(withoutList(await scrollPositions(page))).toEqual(withoutList(during));
  }
  await expect(list).toBeHidden();
  expect(await scrollPositions(page)).toEqual(before);
  // Closed: the scrollers are scrollers again.
  expect(await scrollerModes(page)).toEqual(modesBefore);
  expect(await page.evaluate(() => document.documentElement.hasAttribute("data-layer-open"))).toBe(false);
});

test("F3 (desktop, mouse and wheel): with a dialog open a wheel over the backdrop and over the page beside it moves nothing behind, and opening it shifts nothing", async ({ people }) => {
  const ann = await people.member("Ann", { contextOptions: { viewport: { width: 1280, height: 420 } } });
  test.skip(!canControlService, "needs the local model stub");
  const prefix = `modelx${uniq(3)}`;
  const provider = await providerWithModels(ann, 12, prefix);
  const page = ann.page;
  await page.goto("/");
  await goTo(page, "设置");
  await page.getByText("模型供应商", { exact: true }).first().click();
  const row = page.getByRole("list", { name: "我的模型供应商" }).getByRole("listitem").filter({ hasText: provider });
  await row.getByRole("button", { name: "编辑" }).click();
  const edit = page.getByRole("region", { name: "编辑模型供应商" });
  await expect(edit).toBeVisible();
  const scrolled = await page.evaluate(() => {
    const box = [...document.querySelectorAll(".app *")].find((el) => ["auto", "scroll"].includes(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 40);
    if (box) box.scrollTop = 30;
    return Boolean(box);
  });
  expect(scrolled, "something on the page behind scrolls").toBe(true);
  const boxes = () => page.evaluate(() => [...document.querySelectorAll("#root .page-body, #root .side-body, #root .rows, #root .list-col, #root .main-col")].map((el) => Math.round(el.getBoundingClientRect().width * 10) / 10));
  const widths = await boxes();
  await edit.getByRole("button", { name: "同步模型" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // (The click itself scrolled the form to its button: the positions to keep are those with the dialog open.)
  const before = await scrollPositions(page);
  expect(before.length).toBeGreaterThan(0);
  // Nothing shifted under the backdrop (no scrollbar gutter, no reflow).
  expect(await boxes()).toEqual(widths);
  const frame = await dialog.boundingBox();
  // A wheel over the backdrop, and over the page beside the narrow dialog.
  for (const [x, y] of [[20, 200], [Math.max(5, frame.x - 40), frame.y + 20], [frame.x + frame.width + 30, frame.y + 30]]) {
    await page.mouse.move(x, y);
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(150);
  }
  expect(await scrollPositions(page)).toEqual(before);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(await scrollPositions(page)).toEqual(before);
  expect(await boxes()).toEqual(widths);
});

for (const [size, viewport, options] of [["402x874", { width: 402, height: 874 }, BIG_PHONE], ["360x740", { width: 360, height: 740 }, BIG_PHONE], ["1280x800", { width: 1280, height: 800 }, {}]]) {
  test(`F6 ${size}: a direct chat header has no subtitle; a group's header counts people and Agents with icons on one line; nobody is labelled a person`, async ({ people }) => {
    const ann = await people.member("Ann", { contextOptions: { ...options, viewport } });
    const bo = await people.member("Bo");
    const cy = await people.member("Cy");
    await befriend(ann, bo);
    await befriend(ann, cy);
    const title = `群${uniq(4)}`;
    const group = await groupApi(ann, [bo, cy], title);
    const agent = await agentApi(ann, { name: "小机" });
    await addApi(ann, group.id, agent.id);
    const page = ann.page;
    await page.goto("/");
    // A direct chat: the title alone.
    await openChat(page, bo.displayName);
    const head = chatPane(page, bo.displayName).locator(".chat-head");
    await expect(head.locator(".chat-title p")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("真人");
    await shot(page, `f6-direct-header-${size}`);
    // A group: 3 people and 1 Agent.
    await page.goto("/");
    await openChat(page, title);
    const counts = chatPane(page, title).locator(".chat-head .head-counts");
    await expect(counts.locator('[aria-label="3 人"]')).toBeVisible();
    await expect(counts.locator('[aria-label="1 个 Agent"]')).toBeVisible();
    await expect(counts.locator('[title="3 人"]')).toHaveCount(1);
    expect(await counts.locator("svg").count()).toBe(2);
    const oneLine = async () => counts.evaluate((el) => ({ h: el.getBoundingClientRect().height, fits: el.getBoundingClientRect().right <= el.closest(".chat-title").getBoundingClientRect().right + 1, head: document.querySelector(".chat-head").scrollWidth <= document.querySelector(".chat-head").clientWidth + 1 }));
    expect((await oneLine()).h).toBeLessThanOrEqual(24);
    await shot(page, `f6-group-header-${size}`);
    // Three-digit numbers: still one line, the header not pushed.
    await counts.evaluate((el) => el.querySelectorAll("[aria-hidden=true]:not(svg):not(.head-counts-sep)").forEach((n) => (n.textContent = "99+")));
    const wide = await oneLine();
    expect(wide.fits, "the counts fit their room").toBe(true);
    expect(wide.h).toBeLessThanOrEqual(24);
    expect(wide.head).toBe(true);
    await shot(page, `f6-group-header-888-${size}`);
    // Both member views: the side panel (会话资料 > 发言成员, where there is one) and the full page (群资料 > 群成员): nobody is labelled a person;
    // the Agent keeps its tag and its owner, the creator her tag.
    const pane = chatPane(page, title);
    const panelButton = pane.getByRole("button", { name: "会话资料" });
    if (await panelButton.count()) {
      await panelButton.first().click();
      await expect(page.getByRole("heading", { name: "发言成员" })).toBeVisible();
      await expect(page.locator("body")).not.toContainText("真人");
      await expect(page.getByText("主人：").first()).toBeVisible();
      await shot(page, `f6-details-panel-${size}`);
      await page.getByRole("button", { name: "打开群资料" }).click();
    } else {
      await pane.getByRole("button", { name: "群资料" }).first().click();
    }
    const profile = page.getByRole("region", { name: "群资料" });
    await expect(profile.getByRole("heading", { name: "群成员" })).toBeVisible();
    await expect(profile.getByText("共 4 位成员")).toBeVisible();
    await expect(profile.getByText("创建者", { exact: true })).toBeVisible();
    await expect(profile.getByText("主人：")).toBeVisible();
    await expect(page.locator("body")).not.toContainText("真人");
    await shot(page, `f6-group-profile-${size}`);
  });
}

test("F3 (Chromium only): a long plain choice (the memory language) is cut at its foot with the cue, at 360x740", async ({ people }) => {
  const ann = await people.member("Ann", { contextOptions: { ...BIG_PHONE, viewport: { width: 360, height: 740 } } });
  const page = ann.page;
  await page.goto("/");
  await goTo(page, "设置");
  await page.getByRole("button", { name: /记忆宫殿/ }).click();
  await page.locator(".field", { hasText: "记忆用的语言" }).locator(".select-trigger").first().click();
  const list = page.getByRole("listbox", { name: /语言/ });
  await expect(list).toBeVisible();
  await page.waitForTimeout(350);
  const scrollable = await list.evaluate((el) => el.scrollHeight > el.clientHeight + 1);
  if (scrollable) await expect(list).toHaveAttribute("data-more", "true");
  await shot(page, "f3-select-long-360x740");
});
