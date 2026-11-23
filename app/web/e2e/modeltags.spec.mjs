// The marks of a model row in a real browser (src/ui/ModelMarks.jsx, src/pages/ModelSelect.jsx): 看图 / 思考 / 工具 after 免费 / 需余额;
// words beside the icons while the list is wide, icons only (with a legend) while it is narrow, decided by the list's own
// width; a long name is cut with an ellipsis first and the marks never wrap or leave the row. Screenshots of the owner's kind
// of list (four site models, four of my provider's, one that sees) at 360, 402, 430 and 1280 wide go to MODELTAGS_SHOTS.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { test, expect } from "./support/fixtures.mjs";
import { uniq } from "./support/accounts.mjs";
import { goTo } from "./support/app.mjs";
import { canControlService } from "./support/control.mjs";
import { modelStub } from "./support/model-stub.mjs";

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
const SITE = [
  { id: "e2e-luna", label: "GPT-6 Luna", tier: "free", vision: true, pdf: true, reasoning: ["low", "high"], contextTokens: 128000 },
  { id: "e2e-haiku", label: "Claude Haiku 5.5", tier: "free", vision: true, pdf: false, reasoning: ["low"], contextTokens: 128000 },
  { id: "e2e-sol", label: "GPT-6 Sol", tier: "paid", vision: false, pdf: false, reasoning: ["low", "high"], contextTokens: 128000 },
  { id: "e2e-sonnet", label: "Claude Sonnet 5.5 with a rather long label to be cut", tier: "paid", vision: true, pdf: true, reasoning: ["high"], contextTokens: 128000 },
];
const PROVIDER_MODELS = [
  { name: "deepseek-flash", vision: false, reasoning: false, contextTokens: 64000 },
  { name: "deepseek-v4-flash", vision: false, reasoning: true, contextTokens: 64000 },
  { name: "deepseek-v4-flash-vision-exp", vision: true, reasoning: true, contextTokens: 64000 },
  { name: LONG, vision: true, reasoning: true, contextTokens: 64000 },
];
const SIZES = [
  { name: "360", width: 360, height: 740, icons: true },
  { name: "402", width: 402, height: 874, icons: true },
  { name: "430", width: 430, height: 932, icons: true },
  { name: "1280", width: 1280, height: 860, icons: false },
];

async function setup(people) {
  const ann = await people.member("Ann");
  const { page } = ann;
  await page.route("**/api/models", async (route) => {
    const res = await route.fetch();
    const json = await res.json();
    await route.fulfill({ response: res, json: { ...json, siteModels: SITE.map((m) => ({ ...m, vision: m.vision, pdf: m.pdf })) } });
  });
  const res = await ann.request.post("/api/providers", {
    data: { name: `DerpSeek${uniq(3)}`, protocol: "openai_chat", baseUrl: modelStub.baseUrl, apiKey: `sk-e2e-${uniq(8)}-not-real`, models: PROVIDER_MODELS },
  });
  expect(res.status(), await res.text()).toBe(201);
  return ann;
}

async function openPicker(page) {
  await goTo(page, "Agent");
  await page.getByRole("button", { name: "创建 Agent", exact: true }).click();
  const form = page.getByRole("region", { name: "创建 Agent" });
  await form.getByLabel("模型", { exact: true }).click();
  const list = page.getByRole("listbox", { name: "模型" });
  await expect(list).toBeVisible();
  await expect(list.getByRole("option")).toHaveCount(8);
  return list;
}

for (const size of SIZES) {
  test(`the picker's marks at ${size.name} px: ${size.icons ? "icons only with a legend" : "icons and words"}, a long name cut first, nothing wraps or leaves its row`, async ({ people }) => {
    const ann = await setup(people);
    const page = ann.page;
    await page.setViewportSize({ width: size.width, height: size.height });
    const list = await openPicker(page);

    await expect(list).toHaveAttribute("data-marks", size.icons ? "icons" : "text");
    // The words are shown or not, as the layout says.
    const words = list.locator(".model-mark-text").first();
    if (size.icons) await expect(words).toBeHidden();
    else await expect(words).toBeVisible();
    // The legend only while they are icons.
    const legend = page.locator(".model-legend");
    if (size.icons) {
      await expect(legend).toBeVisible();
      await expect(legend).toHaveText("看图思考工具");
    } else {
      await expect(legend).toHaveCount(0);
    }

    // The deepseek-v4-flash-vision-exp row: 看图 (and only it of the others has it), its name read once, in order.
    const seeing = list.getByRole("option", { name: /^deepseek-v4-flash-vision-exp · / });
    await expect(seeing).toHaveAttribute("aria-label", "deepseek-v4-flash-vision-exp · 看图 · 思考 · 工具");
    await expect(seeing.locator('[role="img"]')).toHaveCount(3);
    await expect(list.getByRole("option", { name: /^deepseek-v4-flash · / })).toHaveAttribute("aria-label", "deepseek-v4-flash · 思考 · 工具");
    // Every icon keeps a name and a title.
    for (const mark of await list.locator('.model-mark[role="img"]').all()) {
      await expect(mark).toHaveAttribute("aria-label", /^(看图|思考|工具)$/);
      await expect(mark).toHaveAttribute("title", /.+/);
    }

    // Geometry of every row: marks stay inside it on one line, the row is one line high, the long ones are cut with an ellipsis.
    const rows = await list.getByRole("option").evaluateAll((options) =>
      options.map((o) => {
        const box = o.getBoundingClientRect();
        const marks = o.querySelector(".model-marks")?.getBoundingClientRect();
        const name = o.querySelector(".model-name");
        const chips = [...o.querySelectorAll(".model-mark")].map((c) => c.getBoundingClientRect());
        return {
          label: o.getAttribute("aria-label"),
          rowHeight: box.height,
          inside: marks ? marks.right <= box.right + 0.5 && marks.left >= box.left : true,
          chipHeights: chips.map((c) => Math.round(c.height)),
          cut: name.scrollWidth > name.clientWidth,
          nameWidth: name.clientWidth,
        };
      }),
    );
    for (const r of rows) {
      expect(r.inside, `${r.label}: marks inside the row`).toBe(true);
      expect(r.rowHeight, `${r.label}: one line`).toBeLessThanOrEqual(46);
      expect(new Set(r.chipHeights).size, `${r.label}: chips on one line`).toBeLessThanOrEqual(1);
    }
    const long = rows.find((r) => r.label.startsWith(LONG));
    expect(long.cut, "the long name is cut with an ellipsis").toBe(true);
    expect(long.nameWidth, "something of the name is left").toBeGreaterThan(40);
    // No sideways scroll of the page or of the list.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await list.evaluate((l) => l.scrollWidth <= l.clientWidth + 1)).toBe(true);

    await shot(page, `picker-${size.name}`);
    if (size.name === "1280") await shot(page, "popover-1280", { clip: await page.locator(".model-pop").boundingBox() });
  });
}

test("the provider page's rows carry the same marks, with their words, at 360 and 1280", async ({ people }) => {
  const ann = await setup(people);
  const page = ann.page;
  for (const [width, height] of [[360, 740], [1280, 860]]) {
    await page.setViewportSize({ width, height });
    await goTo(page, "设置");
    await page.getByRole("button", { name: /模型供应商/ }).click();
    const section = page.getByRole("region", { name: "模型供应商" });
    await section.getByRole("list", { name: "我的模型供应商" }).getByRole("listitem").first().getByRole("button", { name: "编辑" }).click();
    const rows = page.getByRole("list", { name: "模型列表" });
    const seeing = rows.getByRole("listitem").filter({ hasText: "deepseek-v4-flash-vision-exp" });
    await expect(seeing.locator(".model-mark")).toHaveText(["看图", "思考", "工具"]);
    await expect(seeing.locator(".model-mark-text").first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await shot(page, `providers-${width}`);
  }
});
