// B9a and B9b in a real browser against the real service, at 402×874 and 360×740 (touch): the use page of others' use of my Agents
// (its two numbers saved in place and kept over a reload, the state words, no control that needs Agent social while its switch is
// off), the Agent form's own limit (empty for a new Agent, sent as `othersLimit`, cleared to none, the proactive default 70) and the
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
const limitsOf = async (person) => (await (await person.request.get("/api/me/others-use")).json()).limits;

for (const [size, contextOptions] of SIZES) {
  test(`the use page at ${size}: the two numbers saved in place and kept over a reload; the state in words; nothing of Agent social while its switch is off`, async ({ people }) => {
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

    // The defaults the service gives every owner, in the sentence.
    const answers = main.getByLabel("每天最多回复的次数");
    const points = main.getByLabel("每天最多花的点数");
    await expect(answers).toHaveValue("50");
    await expect(points).toHaveValue("300");
    // The Agent's line and today's use: the service's numbers, a state in words.
    await expect(main.getByText(/额度全给它用的话，每天大约能回 \d+ 次/)).toBeVisible();
    await expect(main.getByText("已回别人 0 次，花了 0 点").first()).toBeVisible();
    await expect(main.getByText(/正常|快用完了，长一点的回复可能发不出|今天给别人的额度用完了，明天恢复/).first()).toBeVisible();
    await expect(main.getByText("别人在群里 @ 你的 Agent，花的点都算在你这里。")).toBeVisible();
    // Agent social is off on this site: no 停止往来, no 恢复往来, no list of the stopped (this owner stopped nobody).
    await expect(main).not.toContainText("停止往来");
    await expect(main).not.toContainText("恢复往来");
    await integShot(page, "40-use-page-switch-off", { fullPage: true });

    // Saved on Enter (both numbers, once) and kept over a reload.
    await answers.fill("20");
    await answers.press("Enter");
    await expect(async () => expect(await limitsOf(ann)).toEqual({ answers: 20, points: "300" })).toPass();
    await points.fill("35.5");
    await points.blur();
    await expect(async () => expect(await limitsOf(ann)).toEqual({ answers: 20, points: "35.5" })).toPass();
    // A wrong number is said under the sentence and nothing is written.
    await answers.fill("0");
    await answers.press("Enter");
    await expect(main.getByRole("alert")).toContainText("次数请填 1 到 1000 的整数");
    expect(await limitsOf(ann)).toEqual({ answers: 20, points: "35.5" });
    await integShot(page, "41-use-page-wrong-number");
    await page.reload();
    const again = page.getByRole("region", { name: NAME });
    await expect(again.getByLabel("每天最多回复的次数")).toHaveValue("20");
    await expect(again.getByLabel("每天最多花的点数")).toHaveValue("35.5");

    expect(await noSideways(page)).toBe(true);
    await targetsAre44(again);
    // The usage page says it in one line and links here.
    await page.goto("/settings/usage");
    const usage = page.getByRole("region", { name: "用量与余额" });
    await usage.getByRole("link", { name: NAME }).scrollIntoViewIfNeeded();
    await expect(usage.getByRole("heading", { name: "别人用我的 Agent" })).toBeVisible();
    await expect(usage.getByText(/今天已回别人 0 次，花了 0 点 · /)).toBeVisible();
    await integShot(page, "42-usage-page-section");
    await usage.getByRole("link", { name: NAME }).click();
    await expect(page.getByRole("region", { name: NAME })).toBeVisible();
  });

  test(`the Agent form at ${size}: its own limit empty for a new Agent, sent as othersLimit, cleared to none; the proactive budget starts at 70`, async ({ people }) => {
    const ann = await people.member("Ann", { contextOptions });
    const page = ann.page;
    const name = `小帮${uniq(4)}`;
    await createAgentUi(page, {
      name,
      onFilled: async (form) => {
        await expect(form.getByText("别人用它的上限（可不填）")).toBeVisible();
        const answers = form.getByLabel("每天最多回别人（次）");
        const points = form.getByLabel("每天最多花（点）");
        await expect(answers).toHaveValue("");
        await expect(points).toHaveValue("");
        await expect(form).toContainText("不填：它和你其他的 Agent 共用你的每天上限");
        await answers.fill("12");
        await points.fill("35.5");
        const proactive = form.getByRole("switch", { name: "主动参与群聊" });
        await proactive.check();
        await expect(form.getByLabel("主动回复每天最多花", { exact: true })).toHaveValue("70");
        await answers.scrollIntoViewIfNeeded();
        await integShot(page, "43-agent-form-own-limit");
        expect(await noSideways(page)).toBe(true);
        await targetsAre44(form.locator("fieldset.others-limit"));
      },
    });
    const { agents } = await (await ann.request.get("/api/agents")).json();
    const made = agents.find((a) => a.name === name);
    expect(made.othersLimit).toEqual({ answers: 12, points: "35.5" });
    expect(made).not.toHaveProperty("othersBudget");

    // Its page says the limit; editing it away sends none.
    await page.goto("/agents");
    const detail = await openAgentDetail(page, name);
    await expect(detail).toContainText("别人用它的上限每天最多回别人 12 次，最多花 35.5 点");
    await detail.getByRole("button", { name: /编辑/ }).click();
    await page.getByLabel("每天最多回别人（次）").fill("");
    await page.getByLabel("每天最多花（点）").fill("");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(async () => {
      const got = await (await ann.request.get(`/api/agents/${made.id}`)).json();
      expect(got.othersLimit).toEqual({ answers: null, points: null });
    }).toPass();
  });

  test(`the two thinking levels at ${size}: 别人 @ 它时的思考程度 with the others' limit, 主动回复时的思考程度 with the proactive budget; each offers the model's levels, saves alone, and the Agent's page says both`, async ({ people }) => {
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
    await expect(detail).toContainText("别人 @ 它时不思考");
    await expect(detail).toContainText("主动回复时不思考");
    await detail.getByRole("button", { name: /编辑/ }).click();
    const form = page.getByRole("region", { name: "编辑 Agent" });
    const others = form.getByLabel("别人 @ 它时的思考程度", { exact: true });
    const proactive = form.getByLabel("主动回复时的思考程度", { exact: true });
    await expect(others).toBeVisible();
    await expect(proactive).toBeVisible();
    // Each sits in its own group, with its one line of help.
    await expect(form.locator("fieldset.others-limit")).toContainText("思考越多，回复越慢，花的额度也越多，算在别人今天的额度里。");
    await expect(form).toContainText("思考越多，回复越慢，花的额度也越多。");
    await chooseOptionUi(page, form, "别人 @ 它时的思考程度", "中");
    await chooseOptionUi(page, form, "主动回复时的思考程度", "低");
    await others.scrollIntoViewIfNeeded();
    expect(await noSideways(page)).toBe(true);
    await targetsAre44(form.locator("fieldset.others-limit"));
    await integShot(page, "44-agent-form-others-thinking-level");
    await proactive.scrollIntoViewIfNeeded();
    expect((await proactive.boundingBox()).height).toBeGreaterThanOrEqual(43.5);
    await integShot(page, "45-agent-form-proactive-thinking-level");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(async () => {
      const got = await (await ann.request.get(`/api/agents/${agent.id}`)).json();
      expect(got).toMatchObject({ othersReasoning: "medium", proactiveReasoning: "low", reasoning: "none" });
    }).toPass();
    await page.goto("/agents");
    const after = await openAgentDetail(page, name);
    await expect(after).toContainText("别人 @ 它时思考：中");
    await expect(after).toContainText("主动回复时思考：低");
    expect(await noSideways(page)).toBe(true);
    await integShot(page, "46-agent-page-thinking-levels", { show: after.getByText("别人用它的上限") });
  });
}
