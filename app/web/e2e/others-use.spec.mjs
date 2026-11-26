// The limits redesign (Part 1) in a real browser against the real service, at 402×874 and 360×740 (touch): the use page of others' use
// of my Agents (its ONE number saved in place and kept over a reload, the state in words, no control that needs Agent social while its
// switch is off), the Agent form with no limit or budget of the Agent's own and the hint under each of the two thinking levels, and the
// pages' measures: one h2, no sideways scroll, every control a 44px target, the document's title. Screenshots with E2E_INTEG_SHOTS=1
// (support/shots.mjs `integShot`).
import { test, expect } from "./support/fixtures.mjs";
import { uniq } from "./support/accounts.mjs";
import { chooseOptionUi, createAgentUi, goTo, openAgentDetail } from "./support/app.mjs";
import { canControlService } from "./support/control.mjs";
import { modelStub } from "./support/model-stub.mjs";
import { integShot } from "./support/shots.mjs";
import { agentApi } from "./support/tools.mjs";

const SIZES = [
  ["402x874", { viewport: { width: 402, height: 874 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }],
  ["360x740", { viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }],
];
const NAME = "别人怎么用我的 Agent";

const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
/** Every button, link and field shown in `scope` (a locator) is at least 44px high. */
async function targetsAre44(scope) {
  const small = await scope.evaluate((root) =>
    [...root.querySelectorAll("button, a[href], input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=hidden]), [role=switch], select")]
      .filter((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden")
      .map((el) => ({ what: (el.getAttribute("aria-label") || el.textContent || el.tagName).trim().slice(0, 30), h: Math.round(el.getBoundingClientRect().height) }))
      .filter((x) => x.h < 44),
  );
  expect(small, "controls under 44px").toEqual([]);
}
const limitOf = async (person) => (await (await person.request.get("/api/me/others-use")).json()).limit;

for (const [size, contextOptions] of SIZES) {
  test(`the use page at ${size}: the one number saved in place and kept over a reload; the state in words; nothing of Agent social while its switch is off`, async ({ people }) => {
    const ann = await people.member("Ann", { contextOptions });
    await agentApi(ann, { name: `小厨${uniq(4)}` });
    const page = ann.page;
    await goTo(page, "设置");
    await page.getByRole("button", { name: new RegExp(NAME) }).click();
    const main = page.getByRole("region", { name: NAME });
    await expect(main.getByRole("heading", { name: NAME })).toBeVisible();
    await expect(page).toHaveTitle(`${NAME} · 设置 · Haiyo`);
    expect(new URL(page.url()).pathname).toBe("/settings/others");
    await expect(main.locator("h2")).toHaveCount(1);

    // The default the service gives every owner, in the sentence; what it covers under it.
    const points = main.getByLabel("每天最多花的点数");
    await expect(points).toHaveValue("300");
    await expect(main).toContainText("你所有的 Agent 合在一起算，它们主动回复的也算。");
    await expect(main.getByText("今天别人花了 0 点").first()).toBeVisible();
    await expect(main.getByText(/正常|今天给别人的额度用完了，明天恢复/).first()).toBeVisible();
    await expect(main.getByText("别人在群里 @ 你的 Agent，花的点都算在你这里。")).toBeVisible();
    // No Agent-by-Agent estimate, no count of answers.
    await expect(main).not.toContainText("大约能回");
    await expect(main.getByLabel("每天最多回复的次数")).toHaveCount(0);
    // Agent social is off on this site: no 停止往来, no 恢复往来, no list of the stopped (this owner stopped nobody).
    await expect(main).not.toContainText("停止往来");
    await expect(main).not.toContainText("恢复往来");
    await integShot(page, "40-use-page-switch-off", { fullPage: true });

    // Saved on Enter and on leaving the box, kept over a reload.
    await points.fill("20");
    await points.press("Enter");
    await expect(async () => expect(await limitOf(ann)).toBe("20")).toPass();
    await points.fill("35.5");
    await points.blur();
    await expect(async () => expect(await limitOf(ann)).toBe("35.5")).toPass();
    // A wrong number is said under the sentence and nothing is written.
    await points.fill("0");
    await points.press("Enter");
    await expect(main.getByRole("alert")).toContainText("点数请填 1 到 100000 的数");
    expect(await limitOf(ann)).toBe("35.5");
    await integShot(page, "41-use-page-wrong-number");
    await page.reload();
    const again = page.getByRole("region", { name: NAME });
    await expect(again.getByLabel("每天最多花的点数")).toHaveValue("35.5");

    expect(await noSideways(page)).toBe(true);
    await targetsAre44(again);
    // The usage page says it in one line and links here.
    await page.goto("/settings/usage");
    const usage = page.getByRole("region", { name: "用量与余额" });
    await usage.getByRole("link", { name: NAME }).scrollIntoViewIfNeeded();
    await expect(usage.getByRole("heading", { name: "别人用我的 Agent" })).toBeVisible();
    await expect(usage.getByText(/今天别人花了 0 点，每天最多 35\.5 点 · /)).toBeVisible();
    await integShot(page, "42-usage-page-section");
    await usage.getByRole("link", { name: NAME }).click();
    await expect(page.getByRole("region", { name: NAME })).toBeVisible();
  });

  test(`the Agent form at ${size}: no limit of its own for others and no budget of its own for proactive replies`, async ({ people }) => {
    const ann = await people.member("Ann", { contextOptions });
    const page = ann.page;
    const name = `小帮${uniq(4)}`;
    await createAgentUi(page, {
      name,
      onFilled: async (form) => {
        await expect(form).not.toContainText("别人用它的上限");
        await expect(form.getByLabel("每天最多回别人（次）")).toHaveCount(0);
        const proactive = form.getByRole("switch", { name: "主动参与群聊" });
        await proactive.check();
        await expect(form.getByLabel("主动回复每天最多花", { exact: true })).toHaveCount(0);
        await integShot(page, "43-agent-form-no-own-limit");
        expect(await noSideways(page)).toBe(true);
      },
    });
    const { agents } = await (await ann.request.get("/api/agents")).json();
    const made = agents.find((a) => a.name === name);
    for (const gone of ["othersLimit", "othersUsedToday", "othersBudget", "proactiveBudget", "proactiveSpentToday"]) expect(made).not.toHaveProperty(gone);
    await page.goto("/agents");
    const detail = await openAgentDetail(page, name);
    await expect(detail).not.toContainText("别人用它的上限");
    await expect(detail).not.toContainText("每天最多花");
  });

  test(`the two thinking levels at ${size}: each offers the model's levels with its one hint, saves alone, and the Agent's page says both`, async ({ people }) => {
    test.skip(!canControlService, "needs the model stub as a provider's address");
    const ann = await people.member("Ann", { contextOptions });
    const page = ann.page;
    const tag = uniq(6);
    // A model of her own provider that can think (the site's two demo models list no level, so the form shows neither select for them).
    const made = await ann.request.post("/api/providers", {
      data: { name: `想${tag}`, protocol: "anthropic", baseUrl: modelStub.baseUrl, apiKey: `sk-e2e-${tag}-not-real`, models: [{ name: `think-${tag}`, reasoning: true }] },
    });
    expect(made.status(), await made.text()).toBe(201);
    const provider = await made.json();
    const name = `小想${uniq(4)}`;
    const created = await ann.request.post("/api/agents", {
      data: { namePart: `ag_${uniq(10)}`, name, persona: "你是一个乐于助人的助手。", model: { source: "provider", providerId: provider.id, model: `think-${tag}` }, proactive: true },
    });
    expect(created.status(), await created.text()).toBe(201);
    const agent = await created.json();
    expect(agent).toMatchObject({ othersReasoning: "none", proactiveReasoning: "none" });

    await page.goto("/agents");
    const detail = await openAgentDetail(page, name);
    await expect(detail).toContainText("回应别人时不思考");
    await expect(detail).toContainText("主动回复时不思考");
    await detail.getByRole("button", { name: /编辑/ }).click();
    const form = page.getByRole("region", { name: "编辑 Agent" });
    const others = form.getByLabel("别人 @ 它或来找它时的思考程度", { exact: true });
    const proactive = form.getByLabel("主动回复时的思考程度", { exact: true });
    await expect(others).toBeVisible();
    await expect(proactive).toBeVisible();
    // A model on her own key: each reply to others counts what the service says (6 points), whatever the level.
    await expect(others.locator("xpath=ancestor::*[contains(@class,'field')][1]")).toContainText("这一档单条回复最多约 6 点");
    await expect(proactive.locator("xpath=ancestor::*[contains(@class,'field')][1]")).toContainText("这一档单条回复最多约 6 点");
    await chooseOptionUi(page, form, "别人 @ 它或来找它时的思考程度", "中");
    await chooseOptionUi(page, form, "主动回复时的思考程度", "低");
    await others.scrollIntoViewIfNeeded();
    expect(await noSideways(page)).toBe(true);
    await integShot(page, "44-agent-form-others-thinking-level");
    await proactive.scrollIntoViewIfNeeded();
    expect((await proactive.boundingBox()).height).toBeGreaterThanOrEqual(43.5);
    await integShot(page, "45-agent-form-proactive-thinking-level");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(async () => {
      const got = await (await ann.request.get(`/api/agents/${agent.id}`)).json();
      expect(got).toMatchObject({ othersReasoning: "medium", proactiveReasoning: "low", reasoning: "none" });
    }).toPass();
    // The form leaves by itself once the save has answered (one step back in history, to the Agent's page): the page is read THERE. A
    // `goto` here would start a second navigation while that one is under way, and one of the two is aborted (the cloud run's
    // net::ERR_ABORTED at 360).
    const after = page.getByRole("region", { name: "Agent 管理" });
    await expect(after.getByRole("heading", { name })).toBeVisible();
    await expect(page.getByRole("region", { name: "编辑 Agent" })).toHaveCount(0);
    await expect(after).toContainText("回应别人时思考：中");
    await expect(after).toContainText("主动回复时思考：低");
    expect(await noSideways(page)).toBe(true);
    await integShot(page, "46-agent-page-thinking-levels", { show: after.getByText("回应别人时") });
  });
}
