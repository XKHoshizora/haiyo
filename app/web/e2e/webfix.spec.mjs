// Fixes from the owner's iPhone round (shots 79 to 87): the pages that scroll inside the shell stay painted, the model
// sheet scrolls to its last row, the thinking-level choice of a provider's model. At 402×874, touch.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { test, expect } from "./support/fixtures.mjs";
import { goTo, listRow } from "./support/app.mjs";
import { uniq } from "./support/accounts.mjs";
import { canControlService } from "./support/control.mjs";
import { modelStub } from "./support/model-stub.mjs";
import { agentApi } from "./support/tools.mjs";
import { WEB_DIR } from "./support/env.mjs";

const BIG_PHONE = { viewport: { width: 402, height: 874 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 };

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

test("F2: a long form scrolled by touch stays painted from its top edge to its bottom, on the create and the edit page", async ({ people }) => {
  const ann = await people.member("Ann", { contextOptions: BIG_PHONE });
  const page = ann.page;
  await goTo(page, "Agent");
  await page.getByRole("button", { name: "创建 Agent", exact: true }).click();
  await expect(page.getByRole("region", { name: "创建 Agent" })).toBeVisible();
  const body = page.locator("form.page-body");
  await expect(body).toBeVisible();
  await shot(page, "f2-create-top");
  await scrollAndCheck(page, body, "create");

  // The check sees a blank: with the texts hidden most of the same boxes carry no ink (so a band the browser leaves unpainted fails it).
  await body.evaluate((el) => (el.scrollTop = 0));
  const labels = await visibleBlocks(page, "form.page-body");
  await page.addStyleTag({ content: "form.page-body .field-label, form.page-body h3, form.page-body .field-hint { visibility: hidden !important; }" });
  const blank = await inkIn(page, labels);
  expect(blank.filter((amount) => amount < 3).length).toBeGreaterThan(blank.length / 2);
  await page.goto("/");

  // The edit page of an Agent has the same body.
  const agent = await agentApi(ann, { name: "表单检" });
  await page.goto("/");
  await goTo(page, "Agent");
  await listRow(page, agent.name).click();
  await page.getByRole("button", { name: "编辑" }).click();
  await expect(page.getByRole("region", { name: "编辑 Agent" })).toBeVisible();
  await scrollAndCheck(page, page.locator("form.page-body"), "edit");
});

/** A provider of `count` models (named `<prefix>-01` …) added through the API; resolves with its name. */
async function providerWithModels(person, count, prefix) {
  const name = `prov-${uniq(6)}`;
  const models = Array.from({ length: count }, (_, i) => ({ name: `${prefix}-${String(i + 1).padStart(2, "0")}` }));
  const res = await person.request.post("/api/providers", { data: { name, protocol: "openai_chat", baseUrl: modelStub.baseUrl, apiKey: `sk-e2e-${uniq(8)}-not-real`, models } });
  expect(res.status(), await res.text()).toBe(201);
  return name;
}

/** Settings → 记忆宫殿 and the memory model's sheet, open. */
async function openMemoryModelSheet(page) {
  await goTo(page, "设置");
  await page.getByRole("button", { name: /记忆宫殿/ }).click();
  await page.getByRole("combobox", { name: /用哪个模型整理记忆/ }).or(page.getByRole("button", { name: /用哪个模型整理记忆/ })).first().click();
  const list = page.getByRole("listbox", { name: "模型" });
  await expect(list).toBeVisible();
  return list;
}

/** Every row can be brought into view above the footer: the list scrolls (by touch), and its last row ends above the footer's top edge. */
async function expectListReachesItsEnd(page, list, lastName) {
  const frame = await list.boundingBox();
  const sheet = page.locator(".model-pop");
  for (let i = 0; i < 6; i += 1) await touchScroll(page, frame.x + frame.width / 2, frame.y + frame.height / 2, 400);
  const last = list.getByRole("option", { name: new RegExp(lastName) });
  await expect(last).toBeVisible();
  const row = await last.boundingBox();
  const foot = await sheet.locator(".model-foot").boundingBox();
  const box = await sheet.boundingBox();
  const listBox = await list.boundingBox();
  expect(row.y + row.height, "the last row ends above the footer").toBeLessThanOrEqual(foot.y + 0.5);
  expect(row.y, "and inside the list").toBeGreaterThanOrEqual(listBox.y - 0.5);
  expect(foot.y + foot.height, "the footer stays on screen").toBeLessThanOrEqual(page.viewportSize().height + 0.5);
  expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize().height + 0.5);
}

for (const [label, viewport] of [["360", { width: 360, height: 740 }], ["402", { width: 402, height: 874 }], ["402, short (keyboard up)", { width: 402, height: 520 }]]) {
  test(`F3: the model sheet's list scrolls to its last row above the footer with 12 models, at ${label}`, async ({ people }) => {
    test.skip(!canControlService, "needs the local model stub");
    const ann = await people.member("Ann", { contextOptions: { ...BIG_PHONE, viewport } });
    const prefix = `modelx${uniq(3)}`;
    await providerWithModels(ann, 12, prefix);
    await ann.page.goto("/");
    const list = await openMemoryModelSheet(ann.page);
    await shot(ann.page, `f3-sheet-open-${viewport.width}x${viewport.height}`);
    await expectListReachesItsEnd(ann.page, list, `${prefix}-12`);
    await shot(ann.page, `f3-sheet-end-${viewport.width}x${viewport.height}`);
  });
}
