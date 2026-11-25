// Ring 1a in a real browser against the real service, both lanes together (plan, Task I2a), with the site's Agent social switch on and the
// model being the local stub: a visitor is let in and the Agent really answers them while its owner watches; a person who only called the
// Agent in a group is on the owner's use page as a link to a profile, where the owner stops dealings with them (their next @ gets no
// answer) and resumes; the use page's three states, the stopped list, the one-time notice, the Agent's card and page, the blocks page with
// a blocked Agent shown as an Agent, and the persona card as an unread message. At 402×874 and at 360×740, touch. The screens for the
// product owner are taken with E2E_INTEG_SHOTS=1 (support/shots.mjs `integShot`).
import { test, expect } from "./support/fixtures.mjs";
import { befriend, sendApi, uniq } from "./support/accounts.mjs";
import { chatPane, composer, goTo, listRow, messageList, openAgentDetail, sendText } from "./support/app.mjs";
import { canControlService, restartService } from "./support/control.mjs";
import { accountFromBeforeStepL, backdateStop } from "./support/db.mjs";
import { modelStub } from "./support/model-stub.mjs";
import { integShot as shot } from "./support/shots.mjs";
import { addApi, agentApi, groupApi } from "./support/tools.mjs";

const SIZES = [
  ["402x874", { viewport: { width: 402, height: 874 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }],
  ["360x740", { viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }],
];
const USE = "别人怎么用我的 Agent";
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
const useOf = async (person) => (await person.request.get("/api/me/others-use")).json();
const limits = async (person, answers, points) => expect((await person.request.put("/api/me/others-limits", { data: { answers, points } })).status()).toBe(200);
const openUsePage = async (page) => {
  await page.goto("/settings/others");
  const main = page.getByRole("region", { name: USE });
  await expect(main.getByRole("heading", { name: USE })).toBeVisible();
  await expect(main.getByText("今天谁用过")).toBeVisible();
  return main;
};
/**
 * An Agent of `owner`'s whose persona the persona aid has already read. With the switch on the aid reads every new persona once, with a
 * model call of its own that takes the stub's next scripted step: it is given its answer (`facts`, none by default) and waited for, so
 * that a reply scripted afterwards is the reply's.
 */
async function agentRead(owner, fields, facts = []) {
  const before = (await modelStub.calls()).length;
  await modelStub.reply(JSON.stringify({ facts }));
  const agent = await agentApi(owner, fields);
  await expect.poll(async () => (await modelStub.calls()).length, { message: "the persona aid's read", timeout: 40_000 }).toBe(before + 1);
  return agent;
}
/** The Agent's messages of a conversation, as its member reads them through the API. */
const agentTexts = async (person, conversationId, agentId) =>
  (await (await person.request.get(`/api/conversations/${conversationId}/messages`)).json()).messages.filter((m) => m.senderId === agentId && m.kind === "text").map((m) => m.text);

test.beforeAll(async () => {
  if (!canControlService) return;
  await restartService({ SOCIAL: JSON.stringify({ enabled: true }) });
  // The switch just came on: the persona aid now reads every Agent the suite has made so far, each read a model call. Nothing here
  // starts before that is over (`modelStub.quiet`), or those calls would be counted, and would take the replies, as this spec's own.
  test.setTimeout(360_000);
  const backlog = await modelStub.quiet();
  console.log(`[social.spec.mjs] the persona aid's backlog at the switch-on: ${backlog} model call(s) before the stub was quiet`);
});
test.afterAll(async () => {
  if (canControlService) await restartService({});
});
test.beforeEach(async () => {
  if (canControlService) await modelStub.reset();
});

for (const [size, contextOptions] of SIZES) {
  test(`${size}: a visitor is answered while the owner watches; a group-only caller is stopped from their profile and resumed; the use page, its states and its stopped list`, async ({ people }) => {
    test.skip(!canControlService, "needs the Agent social switch on and the model stub, which only the local suite has");
    const ann = await people.member("Ann", { contextOptions });
    const bo = await people.member("Bo", { contextOptions });
    const cy = await people.member("Cy", { open: false });
    const dan = await people.member("Dan", { open: false });
    const agent = await agentRead(ann, { name: `帮手${uniq(4)}`, intro: "陪你聊天" });
    const name = agent.name;

    // ── Bo is let in (a request, Ann's yes) and writes: the Agent answers him, and Ann reads it as the owner who watches.
    expect((await bo.request.post("/api/agent-contacts", { data: { agentId: agent.id } })).status()).toBe(202);
    const yes = await ann.request.post(`/api/agent-contacts/${agent.id}/${bo.id}/approve`);
    expect(yes.status()).toBe(200);
    const { conversationId: social } = await yes.json();
    await bo.page.reload();
    await listRow(bo.page, name).first().click();
    const chat = chatPane(bo.page, name);
    await modelStub.reply("周三下午有空，我会转告主人。");
    await sendText(bo.page, name, "周三有空吗");
    await expect(messageList(chat).getByText("周三下午有空，我会转告主人。")).toBeVisible();
    expect(await noSideways(bo.page)).toBe(true);
    await shot(bo.page, "18-social-chat-visitor-answered");
    // What Bo is sent of the reply is its text: no reasoning, no model, no search words.
    const sent = (await (await bo.request.get(`/api/conversations/${social}/messages`)).json()).messages.find((m) => m.senderId === agent.id);
    for (const key of ["reasoning", "via", "queries"]) expect(sent, key).not.toHaveProperty(key);
    // Ann: not a row of her main list, and no unread there; it is under the Agent's 「别人」 tab.
    await ann.page.reload();
    await goTo(ann.page, "消息");
    await expect(listRow(ann.page, `${name}和${bo.displayName}`)).toHaveCount(0);
    await openAgentDetail(ann.page, name);
    await ann.page.getByRole("tab", { name: "别人" }).click();
    const tab = ann.page.getByRole("region", { name: "Agent 管理" });
    await tab.getByRole("list", { name: "它和别人的对话" }).getByRole("button").first().click();
    const watched = chatPane(ann.page, `${name}和${bo.displayName}`);
    await expect(messageList(watched).getByText("周三下午有空，我会转告主人。")).toBeVisible();
    await expect(watched.getByTestId("social-note")).toHaveText(`你在旁观${name}和${bo.displayName}的对话。你发言时，对方会看到你是主人。`);
    expect(await noSideways(ann.page)).toBe(true);
    await shot(ann.page, "19-social-chat-owner-observer-answered");

    // ── Dan is no friend of Ann's: he only calls her Agent in a group Cy made.
    await befriend(cy, ann);
    await befriend(cy, dan);
    const g = await groupApi(cy, [ann, dan]);
    await addApi(ann, g.id, agent.id);
    await modelStub.reply("在的，Dan。");
    await sendApi(dan, g.id, `@${String(agent.handle).replace(/^@/, "")} 在吗`);
    await expect(async () => expect(await agentTexts(dan, g.id, agent.id)).toEqual(["在的，Dan。"])).toPass({ timeout: 30_000 });

    // ── The use page: both people of today are links; nothing here stops anyone.
    let main = await openUsePage(ann.page);
    await expect(main.getByText("点名字进入对方的资料页，可以在那里停止往来。")).toBeVisible();
    const peopleList = main.getByRole("list", { name: "今天用过你的 Agent 的人" });
    await expect(peopleList.getByRole("link", { name: bo.displayName })).toBeVisible();
    await expect(peopleList.getByRole("link", { name: dan.displayName })).toBeVisible();
    await expect(main.getByText("已回别人 2 次，花了").first()).toBeVisible();
    await expect(main.getByText("现在没有停止往来的人。")).toBeVisible();
    await expect(main.getByRole("button", { name: /停止往来|恢复往来/ })).toHaveCount(0);
    await expect(main.locator("h2")).toHaveCount(1);
    expect(await noSideways(ann.page)).toBe(true);
    await targetsAre44(main);
    expect((await useOf(ann)).reached).toBe(false);
    await shot(ann.page, "20-use-page-normal");

    // ── Dan's name opens his profile (a person Ann has no friendship with), where 停止往来 is.
    await peopleList.getByRole("link", { name: dan.displayName }).click();
    const card = ann.page.getByRole("region", { name: "联系人卡片" });
    await expect(card.getByRole("heading", { level: 2 })).toContainText(dan.displayName);
    expect(new URL(ann.page.url()).pathname).toBe(`/contacts/${dan.id}`);
    await expect(card.getByText("你们还没有建立联系。")).toBeVisible();
    await expect(card.getByRole("heading", { name: "和对方的 Agent 往来" })).toBeVisible();
    expect(await noSideways(ann.page)).toBe(true);
    await shot(ann.page, "21-profile-of-a-group-only-caller", { show: card.getByRole("button", { name: "停止往来" }) });
    // The address alone draws the same profile (a reload: nothing but the id is known at first).
    await ann.page.reload();
    await expect(ann.page.getByRole("region", { name: "联系人卡片" }).getByRole("button", { name: "停止往来" })).toBeVisible();
    await card.getByRole("button", { name: "停止往来" }).click();
    const ask = ann.page.getByRole("dialog");
    await expect(ask.getByRole("heading", { name: `停止和${dan.displayName}往来` })).toBeVisible();
    await ask.getByRole("button", { name: "停止往来" }).click();
    await expect(card.getByRole("button", { name: "恢复往来" })).toBeVisible();
    // Dan's next @ in the group starts nothing: no answer comes, and nothing tells him why.
    const before = (await modelStub.calls()).length;
    await sendApi(dan, g.id, `@${String(agent.handle).replace(/^@/, "")} 还在吗`);
    await ann.page.waitForTimeout(2500);
    expect((await modelStub.calls()).length).toBe(before);
    expect(await agentTexts(dan, g.id, agent.id)).toEqual(["在的，Dan。"]);
    // Cy, who is not stopped, is answered as ever.
    await modelStub.reply("在的，Cy。");
    await sendApi(cy, g.id, `@${String(agent.handle).replace(/^@/, "")} 我问一句`);
    await expect(async () => expect(await agentTexts(cy, g.id, agent.id)).toEqual(["在的，Dan。", "在的，Cy。"])).toPass({ timeout: 30_000 });

    // ── The stopped list: who and since when (a stop from last year says its year), each a link to the profile.
    await backdateStop(ann.id, dan.id, 400);
    main = await openUsePage(ann.page);
    const stoppedList = main.getByRole("list", { name: "已停止往来的人" });
    await expect(stoppedList.getByRole("link", { name: dan.displayName })).toBeVisible();
    await expect(stoppedList).toContainText(/\d{4}年\d+月\d+日停止/);
    await expect(main.getByText("停止往来后，你们各自的 Agent 都不再回应对方。想恢复，点名字进入对方的资料页。恢复往来后，之前的对话不会自动恢复；想再聊，需要重新添加对方的 Agent，并等它的主人同意。")).toBeVisible();
    expect(await noSideways(ann.page)).toBe(true);
    await targetsAre44(main);
    await shot(ann.page, "22-use-page-stopped-list", { show: stoppedList });

    // ── The three states are the service's: 快用完了 when a longer reply may not fit, 已用完 when nothing more is answered today.
    // (Which points number leaves "a longer reply may not fit" depends on the model's prices: the service says, the test asks until it does.)
    let tight = null;
    const seen = [];
    for (const points of ["30", "20", "15", "12", "11", "10.5", "10", "9.5", "9", "8.8", "8.6", "8.4", "8.2", "8", "7.5", "7"]) {
      if (tight !== null) break;
      await limits(ann, 50, points);
      const now = await useOf(ann);
      seen.push(`${points}:${now.tight ? "t" : "-"}${now.reached ? "r" : "-"}`);
      if (now.tight && !now.reached) tight = points;
    }
    expect(tight, `a points number at which the day is tight and not reached (${seen.join(" ")})`).not.toBeNull();
    main = await openUsePage(ann.page);
    await expect(main.getByText("快用完了，长一点的回复可能发不出").first()).toBeVisible();
    expect(await noSideways(ann.page)).toBe(true);
    await shot(ann.page, "23-use-page-tight");
    // Three answers were given today: a number of three is used up.
    await limits(ann, 3, "300");
    expect((await useOf(ann)).reached).toBe(true);
    main = await openUsePage(ann.page);
    await expect(main.getByText("今天给别人的额度用完了，明天恢复").first()).toBeVisible();
    expect(await noSideways(ann.page)).toBe(true);
    await shot(ann.page, "24-use-page-reached");
    // The card of the Agent says it too, and its page says its three rows.
    await ann.page.goto("/agents");
    const row = ann.page.getByRole("button").filter({ has: ann.page.getByText(name, { exact: true }) }).first();
    // I3: the cap is one for all the owner's Agents, so it is said ONCE above the list; no card carries it, and the name is whole.
    const wholeName = async (r) => expect(await r.locator(".row-name").evaluate((el) => el.scrollWidth <= el.clientWidth), "the Agent's name is not cut").toBe(true);
    await expect(ann.page.locator(".list-col .others-reached")).toHaveText("今天给别人的额度用完了，明天恢复");
    await expect(row).not.toContainText("用完");
    await wholeName(row);
    expect(await noSideways(ann.page)).toBe(true);
    await shot(ann.page, "25-agents-list-day-used-up");
    const detail = await openAgentDetail(ann.page, name);
    await expect(detail).toContainText("别人用它的上限");
    await expect(detail).toContainText("别人今天的使用");
    await expect(detail).toContainText("今天给别人的额度用完了，明天恢复");
    expect(await noSideways(ann.page)).toBe(true);
    await shot(ann.page, "26-agent-page-rows", { show: detail.getByText("别人今天的使用") });
    // In the group, the next person who calls it is told once that it answers only its owner today.
    await sendApi(cy, g.id, `@${String(agent.handle).replace(/^@/, "")} 再问一句`);
    await expect(async () => {
      const texts = (await (await cy.request.get(`/api/conversations/${g.id}/messages`)).json()).messages.filter((m) => m.kind === "system").map((m) => m.system?.event);
      expect(texts).toContain("agent_daily_budget_reached");
    }).toPass({ timeout: 15_000 });
    await limits(ann, 50, "300");
    // Only this Agent's OWN number used up (the owner's day is not, and another Agent of theirs can still answer): its card says so in
    // three characters, beside its status, and its name is still whole at this width.
    const other = await agentRead(ann, { name: `厨子${uniq(4)}` });
    expect((await ann.request.patch(`/api/agents/${agent.id}`, { data: { othersLimit: { answers: 3, points: null } } })).status()).toBe(200);
    await ann.page.goto("/agents");
    const mine = ann.page.locator(".list-col .rows");
    const usedUp = mine.getByRole("button").filter({ has: ann.page.getByText(name, { exact: true }) }).first();
    await expect(usedUp.locator(".tag", { hasText: "别人已用完" })).toBeVisible();
    await expect(ann.page.locator(".list-col .others-reached")).toHaveCount(0);
    await wholeName(usedUp);
    await wholeName(mine.getByRole("button").filter({ has: ann.page.getByText(other.name, { exact: true }) }).first());
    expect(await noSideways(ann.page)).toBe(true);
    await shot(ann.page, "25b-agent-card-own-number-used-up");
    expect((await ann.request.patch(`/api/agents/${agent.id}`, { data: { othersLimit: null } })).status()).toBe(200);

    // ── 恢复往来, from the stopped list's link: the list empties, and Dan is answered again.
    main = await openUsePage(ann.page);
    await main.getByRole("list", { name: "已停止往来的人" }).getByRole("link", { name: dan.displayName }).click();
    await card.getByRole("button", { name: "恢复往来" }).click();
    await expect(card.getByRole("button", { name: "停止往来" })).toBeVisible();
    expect((await useOf(ann)).stopped).toEqual([]);
    await modelStub.reply("又见面了。");
    await sendApi(dan, g.id, `@${String(agent.handle).replace(/^@/, "")} 现在呢`);
    await expect(async () => expect((await agentTexts(dan, g.id, agent.id)).at(-1)).toBe("又见面了。")).toPass({ timeout: 30_000 });
  });

  test(`${size}: the one-time notice; a blocked Agent on the blocks page, shown as an Agent and unblocked there; the persona card as an unread message`, async ({ people }) => {
    test.skip(!canControlService, "needs the Agent social switch on and the model stub, which only the local suite has");
    const ann = await people.member("Ann", { contextOptions });
    const bo = await people.member("Bo", { contextOptions });
    const FACT = "主人住在杭州滨江区，家里养了一只猫。";
    // The persona aid reads each new persona once: its answer names the sentence that is a fact.
    const agent = await agentRead(ann, { name: `小周${uniq(4)}`, persona: `你是一个说话简洁的助手。${FACT}遇到不懂的事要直说。` }, [FACT]);
    const name = agent.name;

    // ── The persona card: an unread message in the Agent's own conversation, first in the list, with its question and two buttons.
    await ann.page.goto("/");
    await goTo(ann.page, "消息");
    const row = listRow(ann.page, name).first();
    await expect(row).toContainText("人格里有句话可能被说给别人", { timeout: 40_000 });
    await expect(row.locator(".badge")).toHaveText("1");
    expect(await noSideways(ann.page)).toBe(true);
    await shot(ann.page, "30-persona-card-unread-in-list");
    await row.click();
    const own = chatPane(ann.page, name);
    await expect(own.getByText(`人格里这句话像是关于你或别人的事实：〈${FACT}〉。别人问起时可能被说出来。要移到“关于我”吗？`)).toBeVisible();
    await expect(own.getByRole("button", { name: "移到“关于我”" })).toBeVisible();
    for (const b of await own.getByRole("button", { name: /移到“关于我”|不用/ }).all()) expect((await b.boundingBox()).height).toBeGreaterThanOrEqual(43.5);
    expect(await noSideways(ann.page)).toBe(true);
    await shot(ann.page, "31-persona-card");
    await own.getByRole("button", { name: "移到“关于我”" }).click();
    await expect(own.getByText("已移到“关于我”。")).toBeVisible();
    const persona = (await (await ann.request.get(`/api/agents/${agent.id}`)).json()).persona;
    expect(persona).not.toContain(FACT);

    // ── The one-time notice, for an owner from before the change: once, with their two numbers; 知道了 ends it for good.
    expect(await accountFromBeforeStepL(ann.id)).toBe(1);
    await ann.page.goto("/agents");
    const list = ann.page.locator(".list-col");
    const notice = list.locator(".others-notice");
    await expect(notice).toContainText("别人用你的 Agent，每天的上限改了。现在你所有的 Agent 合在一起，每天最多回别人 50 次、最多花你 300 点");
    await expect(notice).toContainText("原来设为“不限”的，现在也按这个总数算。");
    await expect(notice).toContainText("可在“设置 › 别人怎么用我的 Agent”里修改。");
    // (On a narrow screen the button sits under the text, not beside a squeezed column.)
    const [textBox, buttonBox] = [await notice.locator(".notice-body").boundingBox(), await notice.getByRole("button", { name: "知道了" }).boundingBox()];
    expect(buttonBox.y).toBeGreaterThanOrEqual(textBox.y + textBox.height - 1);
    expect((await notice.getByRole("button", { name: "知道了" }).boundingBox()).height).toBeGreaterThanOrEqual(43.5);
    await expect(list.getByText(name, { exact: true }).first()).toBeVisible();
    expect(await noSideways(ann.page)).toBe(true);
    await shot(ann.page, "27-one-time-notice");
    await notice.getByRole("button", { name: "知道了" }).click();
    await expect(notice).toHaveCount(0);
    await ann.page.reload();
    await expect(ann.page.locator(".list-col").getByText("这里只列出你拥有的 Agent。")).toBeVisible();
    await expect(ann.page.locator(".others-notice")).toHaveCount(0);
    expect((await useOf(ann)).notice).toBe(false);

    // ── Bo adds the Agent, blocks it from its card, and finds it on his blocks page as an Agent; he unblocks it there.
    expect((await ann.request.put(`/api/agents/${agent.id}/contact-policy`, { data: { policy: "contacts", picked: false, picks: [] } })).status()).toBe(200);
    await befriend(ann, bo);
    expect((await bo.request.post("/api/agent-contacts", { data: { agentId: agent.id } })).status()).toBe(201);
    await bo.page.reload();
    await listRow(bo.page, name).first().click();
    const chat = chatPane(bo.page, name);
    await expect(composer(chat)).toBeVisible();
    await bo.page.getByRole("button", { name: "会话资料" }).click();
    await bo.page.locator(".side").getByRole("button", { name: "拉黑" }).click();
    await bo.page.getByRole("dialog").getByRole("button", { name: "确认拉黑" }).click();
    await expect(bo.page.getByRole("dialog")).toBeHidden();
    await bo.page.goto("/settings/blocks");
    const blocks = bo.page.getByRole("region", { name: "拉黑" });
    const mine = blocks.getByRole("list", { name: "我拉黑的人和 Agent" });
    await expect(mine).toContainText(name);
    await expect(mine.locator(".tag", { hasText: "Agent" })).toBeVisible();
    await expect(blocks).not.toContainText("真人");
    expect((await mine.getByRole("button", { name: "解除拉黑" }).boundingBox()).height).toBeGreaterThanOrEqual(43.5);
    expect(await noSideways(bo.page)).toBe(true);
    await shot(bo.page, "28-blocks-page-with-an-agent");
    await mine.getByRole("button", { name: "解除拉黑" }).click();
    const lift = bo.page.getByRole("dialog");
    await lift.locator(".modal-foot").getByRole("button").last().click();
    await expect(blocks.getByText("你没有拉黑任何人或 Agent。")).toBeVisible();
    await shot(bo.page, "29-blocks-page-empty");
  });
}
