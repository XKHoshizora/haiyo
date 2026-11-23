// The marks of a model row in a real browser (src/ui/ModelMarks.jsx, src/pages/ModelSelect.jsx, src/styles.css): an ability shows its
// WORD while the picker's box is wide and its ICON while it is narrow, never both (a container query on the box, so the first frame
// is right), with the legend (icon + word) only in the narrow form; money stays text; a long name is cut with an ellipsis first and
// the marks never wrap or leave their row. Everywhere a model is listed: the Agent form's picker, the memory model's picker, the
// chat header's model switch, the provider page's rows and the sync dialog's. One test turns EVERY reserved row on and checks that
// each word stays inside its own chip and every icon in its place. Screenshots go to MODELTAGS_SHOTS (when set).
import { mkdirSync } from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test, expect } from "./support/fixtures.mjs";
import { uniq } from "./support/accounts.mjs";
import { FREE_MODEL, createAgentUi, goTo } from "./support/app.mjs";
import { canControlService } from "./support/control.mjs";
import { modelStub } from "./support/model-stub.mjs";
import { createServer } from "vite";
import { WEB_DIR } from "./support/env.mjs";

test.beforeEach(async () => {
  test.skip(!canControlService, "needs the local service and its model stub");
  await modelStub.reset();
});

const SHOTS = process.env.MODELTAGS_SHOTS ?? "";
const shot = async (page, name, options = {}) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), animations: "disabled", caret: "hide", ...options });
};

const LONG = "claude-3-5-sonnet-extra-long-model-name-with-everything-v2026-11-25-preview";
// The site's models as `GET /api/models` sends them (the service always sends `tools` as a boolean).
const SITE = [
  { id: "e2e-luna", label: "GPT-6 Luna", tier: "free", vision: true, pdf: true, reasoning: ["low", "high"], contextTokens: 128000, tools: true },
  { id: "e2e-haiku", label: "Claude Haiku 5.5", tier: "free", vision: true, pdf: false, reasoning: ["low"], contextTokens: 128000, tools: true },
  { id: "e2e-sol", label: "GPT-6 Sol", tier: "paid", vision: false, pdf: false, reasoning: ["low", "high"], contextTokens: 128000, tools: false },
  { id: "e2e-sonnet", label: "Claude Sonnet 5.5 with a rather long label to be cut", tier: "paid", vision: true, pdf: true, reasoning: ["high"], contextTokens: 128000, tools: true },
];
// My provider's (the owner's kind of list): one that sees, one that thinks and says nothing of tools, one with a very long name.
const PROVIDER_MODELS = [
  { name: "deepseek-flash", vision: false, reasoning: false, contextTokens: 64000 },
  { name: "deepseek-v4-flash", vision: false, reasoning: true, contextTokens: 64000 },
  { name: "deepseek-v4-flash-vision-exp", vision: true, reasoning: true, contextTokens: 64000, tools: true },
  { name: LONG, vision: true, reasoning: true, contextTokens: 64000, tools: true },
];
const PHONES = [
  { name: "360", width: 360, height: 740 },
  { name: "402", width: 402, height: 874 },
  { name: "430", width: 430, height: 932 },
];

/** A person with the owner's kind of list; `keepReal`: the site's own models stay in it too (for an Agent that must be created). */
async function setup(people, { keepReal = false } = {}) {
  const ann = await people.member("Ann");
  const { page } = ann;
  await page.route("**/api/models", async (route) => {
    const res = await route.fetch();
    const json = await res.json();
    await route.fulfill({ response: res, json: { ...json, siteModels: keepReal ? [...json.siteModels, ...SITE] : SITE } });
  });
  const res = await ann.request.post("/api/providers", {
    data: { name: `DerpSeek${uniq(3)}`, protocol: "openai_chat", baseUrl: modelStub.baseUrl, apiKey: `sk-e2e-${uniq(8)}-not-real`, models: PROVIDER_MODELS },
  });
  expect(res.status(), await res.text()).toBe(201);
  // The provider was added behind the page's back: read again.
  await page.reload();
  return ann;
}

async function openFormPicker(page, count) {
  await goTo(page, "Agent");
  await page.getByRole("button", { name: "创建 Agent", exact: true }).click();
  const form = page.getByRole("region", { name: "创建 Agent" });
  await form.getByLabel("模型", { exact: true }).click();
  const list = page.getByRole("listbox", { name: "模型" });
  await expect(list).toBeVisible();
  await expect(list.getByRole("option")).toHaveCount(count);
  return list;
}

/** For every ability mark of `scope`: exactly one of its word and its icon is on screen; which one the picker's box is wide or narrow. */
async function expectOneOfEach(scope, narrow) {
  const seen = await scope.locator(".model-mark-ability:not(.model-gap)").evaluateAll((marks) =>
    marks.map((m) => {
      const shown = (el) => getComputedStyle(el).display !== "none" && el.getBoundingClientRect().width > 0;
      return { word: shown(m.querySelector(".model-mark-text")), icon: shown(m.querySelector("svg")) };
    }),
  );
  expect(seen.length).toBeGreaterThan(0);
  for (const s of seen) expect(s, "a mark shows its word or its icon, never both").toEqual(narrow ? { word: false, icon: true } : { word: true, icon: false });
}

/**
 * Defines `window.markDrawn(chip)` in the page: the box of what a mark really DRAWS — its text as the browser lays it out (a range over its rendered text
 * nodes, wherever they are: a bare text node counts) joined with its visible icon — or null when it draws nothing. The earlier checks measured the chip's own
 * box and the `.model-mark-text` / `svg` elements inside it; a money chip had neither (its word was a bare text node), so for it they compared nothing and
 * passed while the word was drawn under the chip.
 */
const defineMarkDrawn = () => {
  window.markDrawn = (chip) => {
    const rects = [];
    const walker = document.createTreeWalker(chip, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      rects.push(...[...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0));
    }
    for (const svg of chip.querySelectorAll("svg")) {
      const r = svg.getBoundingClientRect();
      if (getComputedStyle(svg).display !== "none" && r.width > 0) rects.push(r);
    }
    if (rects.length === 0) return null;
    return { left: Math.min(...rects.map((r) => r.left)), right: Math.max(...rects.map((r) => r.right)), top: Math.min(...rects.map((r) => r.top)), bottom: Math.max(...rects.map((r) => r.bottom)) };
  };
  window.boxInside = (t, c, slack = 0.5) => Boolean(t) && t.left >= c.left - slack && t.right <= c.right + slack && t.top >= c.top - slack && t.bottom <= c.bottom + slack;
};

/** On a page (provider rows, sync rows: no option rows there): every mark of `scope` draws something, inside its own chip. */
async function expectMarksDrawn(page, scope) {
  await page.evaluate(defineMarkDrawn);
  const out = await scope.locator(".model-mark:not(.model-gap)").evaluateAll((chips) => chips.filter((c) => !window.boxInside(window.markDrawn(c), c.getBoundingClientRect())).map((c) => c.textContent));
  expect(await scope.locator(".model-mark:not(.model-gap)").count()).toBeGreaterThan(0);
  expect(out, "what each mark draws lies inside its chip").toEqual([]);
}

/** Geometry of a list's rows: marks inside their row on one line, one line high, no sideways scroll; the rows as the page sees them. */
async function expectRowsFit(page, list) {
  await page.evaluate(defineMarkDrawn);
  const rows = await list.getByRole("option").evaluateAll((options) =>
    options.map((o) => {
      const box = o.getBoundingClientRect();
      const marks = o.querySelector(".model-marks")?.getBoundingClientRect();
      const name = o.querySelector(".model-name");
      const chips = [...o.querySelectorAll(".model-mark:not(.model-gap)")].filter((c) => c.getBoundingClientRect().width > 0).map((c) => c.getBoundingClientRect());
      // Every visible word fits its own chip EXACTLY: the chip is as wide as its word and its padding (a fixed width, too wide or too narrow, fails).
      const spill = [...o.querySelectorAll(".model-mark-ability .model-mark-text")].filter((t) => t.getBoundingClientRect().width > 0).some((t) => {
        const r = t.getBoundingClientRect();
        const chip = t.closest(".model-mark");
        const c = chip.getBoundingClientRect();
        const pad = parseFloat(getComputedStyle(chip).paddingLeft) + parseFloat(getComputedStyle(chip).paddingRight);
        return Math.abs(c.width - (r.width + pad)) > 1 || chip.scrollWidth > chip.clientWidth;
      });
      // What every mark DRAWS (window.markDrawn: its text as laid out, or its icon) lies inside its own chip and inside the row, and there is something drawn
      // (a mark that draws nothing, or whose word is under its chip over the next row, fails here). A money chip (免费 / 需余额) is one line high: as high
      // as an ability chip of the same list (18 px).
      const live = [...o.querySelectorAll(".model-marks .model-mark:not(.model-gap)")];
      const drawnOut = live.filter((c) => !window.boxInside(window.markDrawn(c), c.getBoundingClientRect()) || !window.boxInside(window.markDrawn(c), box)).map((c) => c.dataset.col);
      const abilityHeight = o.closest('[role="listbox"]').querySelector(".model-mark-ability:not(.model-gap)")?.getBoundingClientRect().height ?? 18;
      const priceHeights = live.filter((c) => c.dataset.col === "price").map((c) => c.getBoundingClientRect().height - abilityHeight);
      // The name keeps at least its first six characters' width (a probe in the name's own font).
      const probe = document.createElement("span");
      probe.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${getComputedStyle(name).font}`;
      probe.textContent = name.textContent.slice(0, 6);
      document.body.append(probe);
      const six = probe.getBoundingClientRect().width;
      probe.remove();
      return {
        label: o.getAttribute("aria-label"),
        rowHeight: box.height,
        inside: marks ? marks.right <= box.right + 0.5 && marks.left >= box.left : true,
        chipHeights: chips.map((c) => Math.round(c.height)),
        spill,
        drawnOut,
        priceHeights,
        floor: name.clientWidth + 0.5 >= six,
        cut: name.scrollWidth > name.clientWidth,
        nameWidth: name.clientWidth,
      };
    }),
  );
  for (const r of rows) {
    expect(r.inside, `${r.label}: marks inside the row`).toBe(true);
    expect(r.rowHeight, `${r.label}: one line`).toBeLessThanOrEqual(46);
    expect(new Set(r.chipHeights).size, `${r.label}: chips on one line`).toBeLessThanOrEqual(1);
    expect(r.spill, `${r.label}: every word exactly fills its chip`).toBe(false);
    expect(r.floor, `${r.label}: at least the first six characters of the name are left`).toBe(true);
    expect(r.drawnOut, `${r.label}: what each mark draws (the money word too) lies inside its chip and its row`).toEqual([]);
    for (const d of r.priceHeights) expect(Math.abs(d), `${r.label}: the money chip is one line, as high as an ability chip`).toBeLessThanOrEqual(0.5);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await list.evaluate((l) => l.scrollWidth <= l.clientWidth + 1)).toBe(true);
  return rows;
}

for (const size of [...PHONES, { name: "1280", width: 1280, height: 860 }]) {
  const narrow = size.width < 1280;
  test(`the Agent form's picker at ${size.name} px: ${narrow ? "icons only with a legend" : "words only"}, a long name cut first, nothing wraps or leaves its row`, async ({ people }) => {
    const ann = await setup(people);
    const page = ann.page;
    await page.setViewportSize({ width: size.width, height: size.height });
    const list = await openFormPicker(page, 8);

    await expectOneOfEach(list, narrow);
    const legend = page.locator(".model-legend");
    if (narrow) {
      await expect(legend).toBeVisible();
      await expect(legend).toHaveText("看图思考工具");
    } else {
      await expect(legend).toBeHidden();
    }

    // deepseek-v4-flash-vision-exp: 看图, its name read once, in order; one that says nothing of tools has no 工具; a model with no ability has no mark.
    await expect(list.getByRole("option", { name: /^deepseek-v4-flash-vision-exp · / })).toHaveAttribute("aria-label", "deepseek-v4-flash-vision-exp · 看图 · 思考 · 工具");
    await expect(list.getByRole("option", { name: /^deepseek-v4-flash · / })).toHaveAttribute("aria-label", "deepseek-v4-flash · 思考");
    await expect(list.getByRole("option", { name: "GPT-6 Sol · 需余额 · 思考" })).toBeVisible();
    // Every icon keeps a name and a title.
    for (const mark of await list.locator('.model-mark[role="img"]').all()) {
      await expect(mark).toHaveAttribute("aria-label", /^(看图|思考|工具)$/);
      await expect(mark).toHaveAttribute("title", /.+/);
    }

    const rows = await expectRowsFit(page, list);
    const long = rows.find((r) => r.label.startsWith(LONG));
    expect(long.cut, "the long name is cut with an ellipsis").toBe(true);
    expect(long.nameWidth, "something of the name is left").toBeGreaterThan(60);

    await shot(page, `picker-${size.name}`);
    if (!narrow) await shot(page, "popover-1280", { clip: await page.locator(".model-pop").boundingBox() });
  });
}

test("the provider page's rows carry the same marks, as words, at 360 and 1280 (the rows in the picture)", async ({ people }) => {
  const ann = await setup(people);
  const page = ann.page;
  for (const [width, height] of [[360, 740], [1280, 860]]) {
    await page.setViewportSize({ width, height });
    await goTo(page, "设置");
    await page.getByRole("button", { name: /模型供应商/ }).click();
    const section = page.getByRole("region", { name: "模型供应商" });
    const rows = page.getByRole("list", { name: "模型列表" });
    // (Settings opens on the form again when it was left open.)
    if (!(await rows.isVisible())) await section.getByRole("list", { name: "我的模型供应商" }).getByRole("listitem").first().getByRole("button", { name: "编辑" }).click();
    const seeing = rows.getByRole("listitem").filter({ hasText: "deepseek-v4-flash-vision-exp" });
    await expect(seeing.locator(".model-mark")).toHaveText(["看图", "思考", "工具"]);
    // Words on a page, at any width, and no icon.
    await expectOneOfEach(rows, false);
    await expectMarksDrawn(page, rows);
    // A model that says nothing of tools has no 工具 (here, in the picker and in the sync list alike).
    await expect(rows.getByRole("listitem").filter({ hasText: "deepseek-v4-flash" }).first().locator(".model-mark")).toHaveText(["思考"]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // The form tells the mark's story: a model whose entry says nothing of tools has the mixed box (a screen reader says so), with its helper.
    if (width === 1280) {
      const unknown = rows.getByRole("listitem").filter({ hasText: "deepseek-v4-flash" }).first();
      await unknown.getByRole("button", { name: /高级/ }).click();
      const box = unknown.getByLabel("会用工具（查聊天记录、看文件）");
      await expect(box).toMatchAriaSnapshot('- checkbox "会用工具（查聊天记录、看文件）" [checked=mixed]');
      await expect(unknown.getByText("还不确定，会先让它试着用。确定会用就勾上，确定不会就取消。")).toBeVisible();
      await box.click();
      await expect(unknown.locator(".model-mark")).toHaveText(["思考", "工具"]);
      await expect(unknown.getByText("还不确定，会先让它试着用。确定会用就勾上，确定不会就取消。")).toHaveCount(0);
    }
    await seeing.scrollIntoViewIfNeeded();
    await rows.scrollIntoViewIfNeeded();
    await shot(page, `providers-${width}`);
  }
});

test("the sync dialog (a list read from a sibling address) shows the marks (the provider's hints: no 工具) AND the sibling line, at 360 and 1280", async ({ people }) => {
  const ann = await setup(people);
  const page = ann.page;
  const entry = (name, fields = {}) => ({ name, vision: false, pdf: false, reasoning: false, chat: true, known: false, added: false, ...fields });
  await page.route("**/models/list", (route) =>
    route.fulfill({
      json: {
        ok: true,
        source: "sibling",
        listed: [
          entry("claude-sonnet-5-5", { known: true, label: "Claude Sonnet 5.5", vision: true, pdf: true, reasoning: true, contextTokens: 200000 }),
          entry("gpt-4o-mini", { known: true, label: "GPT-4o mini", vision: true, contextTokens: 128000 }),
          entry("stub-chat"),
          entry("a-rather-long-model-name-from-the-sibling-list-that-has-to-be-cut-somewhere", { known: true, label: "Long", vision: true, reasoning: true }),
        ],
      },
    }),
  );
  for (const [width, height] of [[360, 740], [1280, 860]]) {
    await page.setViewportSize({ width, height });
    await goTo(page, "设置");
    await page.getByRole("button", { name: /模型供应商/ }).click();
    const section = page.getByRole("region", { name: "模型供应商" });
    if (!(await page.getByRole("list", { name: "模型列表" }).isVisible())) await section.getByRole("list", { name: "我的模型供应商" }).getByRole("listitem").first().getByRole("button", { name: "编辑" }).click();
    await page.getByRole("button", { name: "同步模型", exact: true }).click();
    const sync = page.getByRole("dialog", { name: /的模型（/ });
    await expect(sync).toBeVisible();
    const rows = sync.getByRole("list", { name: "供应商的模型" }).getByRole("listitem");
    // The catalogue knows claude-sonnet-5-5: its hints are the marks (words, on a page's dialog), and the list says nothing of tools.
    // The sibling line is there beside the rows (outside the marks).
    await expect(sync.getByText("这些模型是从供应商的另一个地址读到的")).toBeVisible();
    const known = rows.filter({ hasText: "claude-sonnet-5-5" });
    await expect(known.locator(".model-mark").first()).toBeVisible();
    await expect(known.locator(".model-mark").filter({ hasText: "工具" })).toHaveCount(0);
    await expectOneOfEach(sync, false);
    await expectMarksDrawn(page, sync);
    expect(await sync.evaluate((d) => d.scrollWidth <= d.clientWidth + 1)).toBe(true);
    // The dialog lies inside the screen with its 20 px gutter on both sides (at 360 it used to run to the right edge), and its body does not scroll sideways.
    const box = await sync.boundingBox();
    expect(box.x, "left gutter").toBeGreaterThanOrEqual(19.5);
    expect(box.x + box.width, "right gutter").toBeLessThanOrEqual(width - 19.5);
    expect(await sync.locator(".modal-body").evaluate((el) => el.scrollWidth <= el.clientWidth + 1), "the body does not scroll sideways").toBe(true);
    await shot(page, `sync-${width}`);
    await sync.getByRole("button", { name: "完成" }).click();
    await expect(sync).toBeHidden();
  }
});

test("the memory model's picker (管理供应商 under its list): at 360 the legend sits above it, at 1280 words and no legend", async ({ people }) => {
  const ann = await setup(people);
  const page = ann.page;
  for (const [width, height] of [[360, 740], [1280, 860]]) {
    await page.setViewportSize({ width, height });
    await goTo(page, "设置");
    await page.getByRole("button", { name: /记忆宫殿/ }).click();
    await page.getByRole("combobox", { name: /用哪个模型整理记忆/ }).or(page.getByRole("button", { name: /用哪个模型整理记忆/ })).first().click();
    const list = page.getByRole("listbox", { name: "模型" });
    await expect(list).toBeVisible();
    const narrow = width < 1280;
    await expectOneOfEach(list, narrow);
    await expectRowsFit(page, list);
    const manage = page.getByRole("button", { name: "管理供应商" });
    await expect(manage).toBeVisible();
    const legend = page.locator(".model-legend");
    if (narrow) {
      await expect(legend).toBeVisible();
      const [l, m, p] = await Promise.all([legend.boundingBox(), manage.boundingBox(), page.locator(".model-pop").boundingBox()]);
      expect(l.y + l.height, "the legend is above 管理供应商").toBeLessThanOrEqual(m.y + 1);
      expect(m.y + m.height, "管理供应商 is inside the sheet").toBeLessThanOrEqual(p.y + p.height + 1);
    } else {
      await expect(legend).toBeHidden();
    }
    await shot(page, `memory-picker-${width}`);
    await page.keyboard.press("Escape");
  }
});

test("the chat header's model switch (a 380 px popover on a desktop, a sheet on a phone): icons, the legend and 管理供应商 together", async ({ people }) => {
  const ann = await setup(people, { keepReal: true });
  const page = ann.page;
  const name = `标记${uniq(4)}`;
  const chat = await createAgentUi(page, { name, model: FREE_MODEL, persona: "你是一个测试助手。" });
  for (const [width, height] of [[360, 740], [1280, 860]]) {
    await page.setViewportSize({ width, height });
    const trigger = chat.locator(".chat-title .model-trigger");
    await expect(trigger).toBeVisible();
    await trigger.click();
    const list = page.getByRole("listbox", { name: "模型" });
    await expect(list).toBeVisible();
    // 380 px: narrow at either size, so icons and the key.
    await expectOneOfEach(list, true);
    await expectRowsFit(page, list);
    const legend = page.locator(".model-legend");
    await expect(legend).toBeVisible();
    const manage = page.getByRole("button", { name: "管理供应商" });
    await expect(manage).toBeVisible();
    const [l, m, p] = await Promise.all([legend.boundingBox(), manage.boundingBox(), page.locator(".model-pop").boundingBox()]);
    expect(l.y + l.height).toBeLessThanOrEqual(m.y + 1);
    expect(m.y + m.height).toBeLessThanOrEqual(p.y + p.height + 1);
    await shot(page, `header-switch-${width}`);
    await page.keyboard.press("Escape");
    await expect(list).toBeHidden();
  }
});

// Turning on EVERY reserved row of the table (test only: the table's own `shown` flipped here, in this process) must break nothing: the
// real ModelMarks markup, on the real stylesheet, in a picker's box at 620 (words) and at 360 (icons), with a 75-character name.
test("every reserved mark turned on: each word stays inside its own chip, the columns line up row to row, every icon is in its place, the long name is still cut", async ({ page }) => {
  // The component is loaded through vite (its own JSX transform, the project's config), in this process, and closed again.
  const vite = await createServer({ configFile: path.join(WEB_DIR, "vite.config.mjs"), root: WEB_DIR, appType: "custom", logLevel: "silent", server: { middlewareMode: true, hmr: false } });
  let strip;
  let kinds;
  try {
    const { ABILITIES, ModelMarks } = await vite.ssrLoadModule("/src/ui/ModelMarks.jsx");
    kinds = ABILITIES.map((a) => a.kind);
    for (const a of ABILITIES) a.shown = true;
    const markup = (marks, columns) => renderToStaticMarkup(React.createElement(ModelMarks, { marks, columns: ["price", ...columns], decorative: true }));
    // Nine abilities and the price do not fit a 360 px phone row beside any name (the marks alone are about 300 px), so there the list has six
    // columns (the three shown and three reserved, the longest words among them); in a 620 px box all nine.
    const six = ["vision", "reasoning", "tools", "videoOut", "audioOut", "audioIn"];
    const three = ["vision", "reasoning", "tools"];
    strip = {
      620: { all: markup(["paid", ...kinds], kinds), one: markup(["free", "tools"], kinds), none: markup([], kinds), cols: kinds },
      360: { all: markup(["paid", ...six], six), one: markup(["free", "tools"], six), none: markup([], six), cols: six },
      // What is shown today: the three abilities and the price at 360 px, where the name has a real floor.
      "360-three": { all: markup(["paid", ...three], three), one: markup(["free", "tools"], three), none: markup([], three), cols: three },
    };
  } finally {
    await vite.close();
  }
  await page.goto("/");
  // "620-wide-price": the price words set wider than the font would (what a font with wider CJK glyphs does, as on the CI machines): the price column must
  // still be one width whether a row says 免费 or 需余额 (it was not: the chip took the width of its own word).
  const WIDE_PRICE = '.model-mark[data-col="price"] { letter-spacing: 0.15em; }';
  for (const [key, narrow] of [[620, false], [360, true], ["360-three", true], ["620-wide-price", false]]) {
    const width = Number(String(key).slice(0, 3));
    const stress = key === "620-wide-price" ? await page.addStyleTag({ content: WIDE_PRICE }) : null;
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.evaluate(
      ({ width: w, strip: s, long }) => {
        const row = (marks) => `<div class="model-option" role="option"><span class="model-check"></span><span style="width:16px;flex:none"></span><span class="model-name">${long}</span>${marks}</div>`;
        document.body.innerHTML = `<div class="model-pop" style="position:fixed;left:0;top:0;width:${w}px;height:auto"><div class="model-list" role="listbox">${row(s.all)}${row(s.one)}${row(s.none)}</div></div>`;
      },
      { width, strip: strip[key] ?? strip[620], long: LONG },
    );
    const rows = page.locator(".model-option");
    await page.evaluate(defineMarkDrawn);
    const geometry = await rows.evaluateAll((els) =>
      els.map((o) => {
        const box = o.getBoundingClientRect();
        const name = o.querySelector(".model-name");
        const cells = [...o.querySelectorAll("[data-col]")].map((c) => {
          const r = c.getBoundingClientRect();
          const part = [...c.querySelectorAll(".model-mark-text, svg")].find((el) => getComputedStyle(el).display !== "none");
          const visible = part ? part.getBoundingClientRect() : null;
          // The visible word or icon fills its chip exactly (the chip is as wide as it and its padding): able to fail on a width too wide or too narrow.
          const cs = getComputedStyle(c);
          const exact = !visible || c.classList.contains("model-gap") || Math.abs(r.width - (visible.width + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight))) <= 1;
          // What the mark draws (its text as laid out — a bare text node counts — or its icon) lies inside the chip, and the chip is one line (18 px) high.
          const drawn = c.classList.contains("model-gap") ? null : window.markDrawn(c);
          const drawnOk = c.classList.contains("model-gap") || (window.boxInside(drawn, r) && Math.abs(r.height - 18) <= 0.5);
          return { col: c.dataset.col, drawnOk, drawnBelow: drawn ? drawn.bottom - r.bottom : 0, left: r.left, right: r.right, inside: exact && (!visible || (visible.left >= r.left - 0.5 && visible.right <= r.right + 0.5)), shown: Boolean(visible) };
        });
        const marks = o.querySelector(".model-marks");
        const probe = document.createElement("span");
        probe.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${getComputedStyle(name).font}`;
        probe.textContent = name.textContent.slice(0, 6);
        document.body.append(probe);
        const six = probe.getBoundingClientRect().width;
        probe.remove();
        return { height: box.height, six, nameWidth: name.clientWidth, cut: name.scrollWidth > name.clientWidth, marksRight: marks ? marks.getBoundingClientRect().right : 0, rowRight: box.right, cells };
      }),
    );
    const [all, one, none] = geometry;
    expect(all.cells.map((c) => c.col)).toEqual(["price", ...(strip[key] ?? strip[620]).cols.slice().sort((x, y) => kinds.indexOf(x) - kinds.indexOf(y))]);
    for (const g of geometry) {
      expect(g.height, "one line").toBeLessThanOrEqual(46);
      expect(g.marksRight <= g.rowRight + 0.5, "marks inside the row").toBe(true);
      expect(g.cut, "the long name is cut").toBe(true);
      // The name floor: with today's three marks, at least the first six characters; with six or nine (reserved rows, see the table's note) the
      // limit is known and only something of the name is asked for.
      if (key === "360-three") expect(g.nameWidth + 0.5, "the first six characters of the name are left").toBeGreaterThanOrEqual(g.six);
      else expect(g.nameWidth, "some of the name is left").toBeGreaterThan(20);
      for (const c of g.cells) expect(c.drawnOk, `${c.col}: what the mark draws lies inside its one-line chip (its bottom is ${c.drawnBelow} px under the chip's)`).toBe(true);
      for (const c of g.cells) expect(c.inside, `${c.col}: the ${narrow ? "icon" : "word"} inside its chip`).toBe(true);
    }
    // In row `all` every ability cell shows exactly its word (wide) or its icon (narrow); a row with fewer marks keeps every column where it was.
    for (const c of all.cells.slice(1)) expect(c.shown, c.col).toBe(true);
    // The columns line up: every column has the same edges in every row, whichever row holds the real mark (to a sub-pixel: layout rounds to 1/64 px).
    const edges = (g) => g.cells.flatMap((c) => [c.left, c.right]);
    const delta = (g) => Math.max(0, ...edges(g).map((x, i) => Math.abs(x - edges(all)[i])));
    expect(one.cells.map((c) => c.col)).toEqual(all.cells.map((c) => c.col));
    expect(delta(one), "a row with one mark keeps every column where the row with all of them has it").toBeLessThanOrEqual(0.5);
    expect(delta(none), "a row with none keeps every column too").toBeLessThanOrEqual(0.5);
    // No chip overlaps its neighbour.
    for (const [a, b] of all.cells.slice(1).map((c, i) => [all.cells[i], c])) expect(a.right, `${a.col} before ${b.col}`).toBeLessThanOrEqual(b.left + 0.5);
    await shot(page, `all-marks-${key}`, { clip: await page.locator(".model-pop").boundingBox() });
    await stress?.evaluate((el) => el.remove());
  }
});
