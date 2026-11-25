// A reply whose run searched the web (lane websearch), in a real browser against the real service — with no engine and
// the site's web search left off (the shared service's configuration is every spec's): the model stub writes a reply with
// a Markdown link and a bare address, and the spec gives that stored reply what a web reply keeps beside its text
// (`webSources`, `webCites`) straight in the database (support/db.mjs `addWebSources`). Reloaded, the reply's text opens
// nothing — its link and its bare address are plain text — and only its sources list and its chip open pages, in a new tab
// with rel="noopener noreferrer nofollow"; a reply without sources keeps its link as a link. The list is folded: one button
// at the end of the reply's lookup line (查了 1 次网页 · 12 个来源) opens it in place, five rows first and 显示全部 12 个 —
// at 1280 and at 390 wide, by the keyboard too, without widening the column. With E2E_SHOTS=1 the second test leaves
// screenshots of each state (SRCFOLD_SHOTS, else the review folder of the checkout this lane lives in).
import { mkdirSync } from "node:fs";
import path from "node:path";
import { test, expect } from "./support/fixtures.mjs";
import { WEB_DIR } from "./support/env.mjs";
import { uniq } from "./support/accounts.mjs";
import { agentMessagesWith, chatPane, openChat, sendText } from "./support/app.mjs";
import { canControlService } from "./support/control.mjs";
import { addWebSources } from "./support/db.mjs";
import { modelStub } from "./support/model-stub.mjs";
import { agentApi } from "./support/tools.mjs";

test.beforeEach(async () => {
  test.skip(!canControlService, "needs the local service, its model stub and its database");
  await modelStub.reset();
});

const SHOTS = process.env.SRCFOLD_SHOTS ?? path.resolve(WEB_DIR, "..", "..", "..", "..", ".superpowers", "sdd", "2026-11-22-polish", "srcfold-shots");
/** A screenshot for the report (only with E2E_SHOTS=1). */
async function shot(page, name) {
  if (process.env.E2E_SHOTS !== "1") return;
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), animations: "disabled", caret: "hide" });
}

/** The message scroller and the page do not scroll sideways. */
async function expectNoSideways(page, what) {
  const m = await page.evaluate(() => {
    const list = document.querySelector("ol.messages");
    return { list: list ? list.scrollWidth - list.clientWidth : 0, page: document.documentElement.scrollWidth - window.innerWidth };
  });
  expect(m.list, `${what}: the message scroller's overflow`).toBeLessThanOrEqual(0);
  expect(m.page, `${what}: the page's overflow`).toBeLessThanOrEqual(0);
}

const SOURCES = [
  { n: 1, url: "https://news.example.com/a/1", title: "北京明天晴" },
  { n: 2, url: "https://weather.example.org/b", title: "气象台：明天降温" },
];

/** The seq of Agent `agentId`'s reply in `conversationId` whose text holds `tag`, read as its owner reads it. */
async function replySeq(person, agentId, conversationId, tag) {
  const res = await person.request.get(`/api/conversations/${conversationId}/messages`);
  expect(res.status()).toBe(200);
  const found = (await res.json()).messages.find((m) => m.senderId === agentId && m.text.includes(tag));
  expect(found, "the reply is stored").toBeTruthy();
  return found.seq;
}

test("a web reply's own link and bare address are plain text; only its sources and its chip open pages, safely", async ({ people }) => {
  const ann = await people.member("Ann");
  const agent = await agentApi(ann, { name: `网页${uniq(4)}` });
  const tag = uniq(6);
  const plainTag = uniq(6);
  const text = (t) => `见[详情](https://evil.example/?d=1) 或 https://bare.example/x 。${t}`;
  const chat = await openChat(ann.page, agent.name);

  // A reply that will be given sources, and one that will not.
  await modelStub.reply(text(tag));
  await sendText(ann.page, agent.name, `明天天气？${tag}`);
  await expect(agentMessagesWith(chat, tag)).toHaveCount(1);
  await modelStub.reply(text(plainTag));
  await sendText(ann.page, agent.name, `再说一次？${plainTag}`);
  await expect(agentMessagesWith(chat, plainTag)).toHaveCount(1);

  const seq = await replySeq(ann, agent.id, agent.conversationId, tag);
  await addWebSources(agent.conversationId, seq, SOURCES, [{ at: 1, n: 2 }]);
  await ann.page.reload();
  const again = await openChat(ann.page, agent.name);

  const web = agentMessagesWith(again, tag);
  await expect(web).toHaveCount(1);
  // Rendered (the Markdown tree, where links would be links), and none of its text's links is one.
  await expect(web.locator(".bubble .md")).toHaveCount(1);
  await expect(web.locator(".bubble")).toContainText("详情");
  await expect(web.locator(".bubble")).toContainText("evil.example");
  await expect(web.locator(".bubble a:not(.cite-link)")).toHaveCount(0);
  // Its one chip opens the page it cites.
  const chip = web.locator(".bubble a.cite-link");
  await expect(chip).toHaveCount(1);
  await expect(chip).toHaveText("网2");
  await expect(chip).toHaveAttribute("href", SOURCES[1].url);
  await expect(chip).toHaveAttribute("target", "_blank");
  await expect(chip).toHaveAttribute("rel", "noopener noreferrer nofollow");
  // Its sources, under its lookup line: the title and the address's real host, each opening a new tab.
  await expect(web.locator(".msg-lookups")).toHaveText("查了 1 次网页 · 2 个来源");
  await expect(web.locator("ol.web-sources")).toHaveCount(0);
  await web.locator(".msg-lookups .sources-toggle").click();
  const rows = web.locator("ol.web-sources li");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("北京明天晴");
  await expect(rows.nth(0)).toContainText("news.example.com");
  await expect(web.locator('ol.web-sources a[target="_blank"][rel="noopener noreferrer nofollow"]')).toHaveCount(2);

  // The reply without sources keeps its link a link.
  const plain = agentMessagesWith(again, plainTag);
  await expect(plain.locator(".bubble .md")).toHaveCount(1);
  await expect(plain.locator('.bubble a[href="https://evil.example/?d=1"]')).toHaveCount(1);
  await expect(plain.locator("ol.web-sources")).toHaveCount(0);
});

test("twelve sources are one folded line under the reply; opened in place they are five rows and 显示全部 12 个 — at 1280 and at 390, by the keyboard, never wider than the column", async ({ people }) => {
  const ann = await people.member("Ann");
  const page = ann.page;
  const agent = await agentApi(ann, { name: `来源${uniq(4)}` });
  const tag = uniq(6);
  const chat = await openChat(page, agent.name);
  await modelStub.reply(`明天晴，气温 12 到 20 度，傍晚转多云，早晚温差大，出门带件外套。${tag}`);
  await sendText(page, agent.name, `明天天气？${tag}`);
  await expect(agentMessagesWith(chat, tag)).toHaveCount(1);
  const seq = await replySeq(ann, agent.id, agent.conversationId, tag);
  const titles = ["北京明天晴", "气象台：明天降温", "Max Verstappen wins the Las Vegas Grand Prix for the third time in four seasons after a late safety car", "一个特别特别长的中文标题，用来看一行放不下时是不是被省略号截断而不是把整列撑宽，再长一点再长一点"];
  const twelve = Array.from({ length: 12 }, (_, i) => ({ n: i + 1, url: `https://${i === 2 ? "a-rather-long-host-name.news" : "site"}${i + 1}.example.com/p/${i + 1}`, title: titles[i] ?? `第 ${i + 1} 个网页的标题` }));
  await addWebSources(agent.conversationId, seq, twelve, [{ at: 1, n: 2 }]);

  for (const [name, size] of [["1280", { width: 1280, height: 860 }], ["390", { width: 390, height: 844 }]]) {
    await page.setViewportSize(size);
    // Shown again (a reload), the list is folded — whatever the reader did before.
    await page.reload();
    if (size.width < 700) await expect(chatPane(page, agent.name)).toBeVisible();
    else await openChat(page, agent.name);
    const web = agentMessagesWith(chatPane(page, agent.name), tag);
    await expect(web).toHaveCount(1);
    const toggle = web.locator(".msg-lookups button.sources-toggle");
    const list = web.locator("ol.web-sources");
    await expect(toggle).toHaveText("查了 1 次网页 · 12 个来源");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(list).toHaveCount(0);
    // One quiet line: the button adds no height to it; narrow, its target is still 44px high (20px above and below its middle are the button's).
    const line = await toggle.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const at = (dy) => document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2 + dy)?.closest(".sources-toggle") === el;
      return { height: box.height, parent: el.parentElement.getBoundingClientRect().height, above: at(-20), below: at(20) };
    });
    expect(line.height, "the button is one line of small text").toBeLessThanOrEqual(22);
    expect(line.parent, "the line is one line").toBeLessThanOrEqual(22);
    if (size.width <= 480) expect([line.above, line.below], "a 44px target on a narrow screen").toEqual([true, true]);
    await shot(page, `srcfold-${name}-1-folded`);

    // Opened by the keyboard, in place: five rows and the row that shows them all.
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(list.locator("a")).toHaveCount(5);
    await expect(list).toBeInViewport({ ratio: 1 });
    const more = list.getByRole("button", { name: "显示全部 12 个" });
    await expect(more).toBeVisible();
    await expectNoSideways(page, `opened at ${name}`);
    await shot(page, `srcfold-${name}-2-open`);

    // Tab walks the rows to 显示全部; pressed, the rest are there and the first of them has the focus.
    for (let i = 0; i < 6; i += 1) await page.keyboard.press("Tab");
    await expect(more).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(list.locator("a")).toHaveCount(12);
    await expect(more).toHaveCount(0);
    await expect(list.locator("a").nth(5)).toBeFocused();
    await expect(list.locator("li").nth(11)).toContainText("12");
    await expectNoSideways(page, `all twelve at ${name}`);
    const rows = await list.locator("li").evaluateAll((els) => els.map((li) => ({ right: li.querySelector("a").getBoundingClientRect().right, colRight: li.closest(".msg-main").getBoundingClientRect().right })));
    for (const row of rows) expect(row.right, `a source row ends inside the column at ${name}`).toBeLessThanOrEqual(row.colRight + 1);
    await shot(page, `srcfold-${name}-3-all`);

    // The chip in the text opens its page itself, folded or not.
    await expect(web.locator(".bubble a.cite-link")).toHaveAttribute("href", twelve[1].url);
    await toggle.click();
    await expect(list).toHaveCount(0);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
  }
});
