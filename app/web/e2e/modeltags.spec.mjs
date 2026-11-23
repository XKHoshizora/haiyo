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

/** Geometry of a list's rows: marks inside their row on one line, one line high, no sideways scroll; the rows as the page sees them. */
async function expectRowsFit(page, list) {
  const rows = await list.getByRole("option").evaluateAll((options) =>
    options.map((o) => {
      const box = o.getBoundingClientRect();
      const marks = o.querySelector(".model-marks")?.getBoundingClientRect();
      const name = o.querySelector(".model-name");
      const chips = [...o.querySelectorAll(".model-mark:not(.model-gap)")].filter((c) => c.getBoundingClientRect().width > 0).map((c) => c.getBoundingClientRect());
      // Every visible word lies inside its own chip.
      const spill = [...o.querySelectorAll(".model-mark-text")].filter((t) => t.getBoundingClientRect().width > 0).some((t) => {
        const r = t.getBoundingClientRect();
        const c = t.closest(".model-mark").getBoundingClientRect();
        return r.left < c.left - 0.5 || r.right > c.right + 0.5;
      });
      return {
        label: o.getAttribute("aria-label"),
        rowHeight: box.height,
        inside: marks ? marks.right <= box.right + 0.5 && marks.left >= box.left : true,
        chipHeights: chips.map((c) => Math.round(c.height)),
        spill,
        cut: name.scrollWidth > name.clientWidth,
        nameWidth: name.clientWidth,
      };
    }),
  );
  for (const r of rows) {
    expect(r.inside, `${r.label}: marks inside the row`).toBe(true);
    expect(r.rowHeight, `${r.label}: one line`).toBeLessThanOrEqual(46);
    expect(new Set(r.chipHeights).size, `${r.label}: chips on one line`).toBeLessThanOrEqual(1);
    expect(r.spill, `${r.label}: every word inside its chip`).toBe(false);
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
    expect(long.nameWidth, "something of the name is left").toBeGreaterThan(40);

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
    // A model that says nothing of tools has no 工具 (here, in the picker and in the sync list alike).
    await expect(rows.getByRole("listitem").filter({ hasText: "deepseek-v4-flash" }).first().locator(".model-mark")).toHaveText(["思考"]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await seeing.scrollIntoViewIfNeeded();
    await rows.scrollIntoViewIfNeeded();
    await shot(page, `providers-${width}`);
  }
});

test("the sync dialog's rows carry the marks (the provider's hints: no 工具) at 360 and 1280", async ({ people }) => {
  const ann = await setup(people);
  const page = ann.page;
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
    const known = rows.filter({ hasText: "claude-sonnet-5-5" });
    await expect(known.locator(".model-mark").first()).toBeVisible();
    await expect(known.locator(".model-mark").filter({ hasText: "工具" })).toHaveCount(0);
    await expectOneOfEach(sync, false);
    expect(await sync.evaluate((d) => d.scrollWidth <= d.clientWidth + 1)).toBe(true);
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
    strip = {
      620: { all: markup(["paid", ...kinds], kinds), one: markup(["free", "tools"], kinds), none: markup([], kinds), cols: kinds },
      360: { all: markup(["paid", ...six], six), one: markup(["free", "tools"], six), none: markup([], six), cols: six },
    };
  } finally {
    await vite.close();
  }
  await page.goto("/");
  for (const [width, narrow] of [[620, false], [360, true]]) {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.evaluate(
      ({ width: w, strip: s, long }) => {
        const row = (marks) => `<div class="model-option" role="option"><span class="model-check"></span><span style="width:16px;flex:none"></span><span class="model-name">${long}</span>${marks}</div>`;
        document.body.innerHTML = `<div class="model-pop" style="position:fixed;left:0;top:0;width:${w}px;height:auto"><div class="model-list" role="listbox">${row(s.all)}${row(s.one)}${row(s.none)}</div></div>`;
      },
      { width, strip: strip[width], long: LONG },
    );
    const rows = page.locator(".model-option");
    const geometry = await rows.evaluateAll((els) =>
      els.map((o) => {
        const box = o.getBoundingClientRect();
        const name = o.querySelector(".model-name");
        const cells = [...o.querySelectorAll("[data-col]")].map((c) => {
          const r = c.getBoundingClientRect();
          const part = [...c.querySelectorAll(".model-mark-text, svg")].find((el) => getComputedStyle(el).display !== "none");
          const visible = part ? part.getBoundingClientRect() : null;
          return { col: c.dataset.col, left: Math.round(r.left * 10) / 10, right: Math.round(r.right * 10) / 10, inside: !visible || (visible.left >= r.left - 0.5 && visible.right <= r.right + 0.5), shown: Boolean(visible) };
        });
        const marks = o.querySelector(".model-marks");
        return { height: box.height, nameWidth: name.clientWidth, cut: name.scrollWidth > name.clientWidth, marksRight: marks ? marks.getBoundingClientRect().right : 0, rowRight: box.right, cells };
      }),
    );
    const [all, one, none] = geometry;
    expect(all.cells.map((c) => c.col)).toEqual(["price", ...strip[width].cols.slice().sort((x, y) => kinds.indexOf(x) - kinds.indexOf(y))]);
    for (const g of geometry) {
      expect(g.height, "one line").toBeLessThanOrEqual(46);
      expect(g.marksRight <= g.rowRight + 0.5, "marks inside the row").toBe(true);
      expect(g.cut, "the long name is cut").toBe(true);
      expect(g.nameWidth, "some of the name is left").toBeGreaterThan(20);
      for (const c of g.cells) expect(c.inside, `${c.col}: the ${narrow ? "icon" : "word"} inside its chip`).toBe(true);
    }
    // In row `all` every ability cell shows exactly its word (wide) or its icon (narrow); a row with fewer marks keeps every column where it was.
    for (const c of all.cells.slice(1)) expect(c.shown, c.col).toBe(true);
    expect(one.cells.map((c) => [c.col, c.left, c.right])).toEqual(all.cells.map((c) => [c.col, c.left, c.right]));
    expect(none.cells.map((c) => [c.col, c.left, c.right])).toEqual(all.cells.map((c) => [c.col, c.left, c.right]));
    // No chip overlaps its neighbour.
    for (const [a, b] of all.cells.slice(1).map((c, i) => [all.cells[i], c])) expect(a.right, `${a.col} before ${b.col}`).toBeLessThanOrEqual(b.left + 0.5);
    await shot(page, `all-marks-${narrow ? "360" : "620"}`, { clip: await page.locator(".model-pop").boundingBox() });
  }
});
