// A reply whose run searched the web (lane websearch), in a real browser against the real service — with no engine and
// the site's web search left off (the shared service's configuration is every spec's): the model stub writes a reply with
// a Markdown link and a bare address, and the spec gives that stored reply what a web reply keeps beside its text
// (`webSources`, `webCites`) straight in the database (support/db.mjs `addWebSources`). Reloaded, the reply's text opens
// nothing — its link and its bare address are plain text — and only its sources list and its chip open pages, in a new tab
// with rel="noopener noreferrer nofollow"; a reply without sources keeps its link as a link. The list is folded: one button
// at the end of the reply's lookup line (查了 1 次网页 · 12 个来源) opens it in place, five rows first and 显示全部 12 个 —
// at 1280 and at 390 wide, by the keyboard too, without widening the column; in its owner's conversation the words it
// searched for head the opened list; the button's enlarged target on a narrow page never takes a press meant for 回复.
// Screenshots of each state are taken only when SRCFOLD_SHOTS names the folder to put them in (nothing is written
// otherwise, and never outside it).
import { mkdirSync } from "node:fs";
import path from "node:path";
import { test, expect } from "./support/fixtures.mjs";
import { befriend, uniq } from "./support/accounts.mjs";
import { agentMessagesWith, chatPane, openChat, sendText } from "./support/app.mjs";
import { canControlService } from "./support/control.mjs";
import { addWebSources } from "./support/db.mjs";
import { modelStub } from "./support/model-stub.mjs";
import { addApi, agentApi, groupApi } from "./support/tools.mjs";

test.beforeEach(async () => {
  test.skip(!canControlService, "needs the local service, its model stub and its database");
  await modelStub.reset();
});

const SHOTS = (process.env.SRCFOLD_SHOTS ?? "").trim();
/** A screenshot for the report: only when SRCFOLD_SHOTS names a folder — of the page, or of `part` of it alone. */
async function shot(page, name, part = page) {
  if (SHOTS === "") return;
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(250);
  await part.screenshot({ path: path.join(SHOTS, `${name}.png`), animations: "disabled", caret: "hide" });
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
  // Its number alone, no word of any language (told from a message's citation by its box).
  await expect(chip).toHaveText(/^\d+$/);
  await expect(chip).toHaveText("2");
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
  // Each link's real host after it, in ASCII brackets after one space — no mark of any one language — plain in the web
  // reply, after the link in the other.
  for (const reply of [web, plain]) {
    await expect(reply.locator(".bubble .md-host")).toHaveText(["(evil.example)", "(bare.example)"]);
    await expect(reply.locator(".bubble")).toContainText("详情 (evil.example) 或 https://bare.example/x (bare.example) 。");
  }
  await shot(ann.page, "srcfold-1280-link-host", plain);
});

test("a chip in a narrow, deeply nested list stays one line: 12 keeps its 16px box, and its line is as tall as a line without a chip (360)", async ({ people }) => {
  const ann = await people.member("Ann");
  const page = ann.page;
  const agent = await agentApi(ann, { name: `嵌套${uniq(4)}` });
  const tag = uniq(6);
  const chat = await openChat(page, agent.name);
  // Fourteen levels of list; at the deepest, two items alike but for the chip after the first.
  const levels = Array.from({ length: 14 }, (_, i) => `${"  ".repeat(i)}- ${i === 0 ? `第1层 ${tag}` : `第${i + 1}层`}`);
  const deep = "  ".repeat(14);
  const text = [...levels, `${deep}- 晴`, `${deep}- 晴`].join("\n");
  await modelStub.reply(text);
  await sendText(page, agent.name, `明天天气？${tag}`);
  await expect(agentMessagesWith(chat, tag)).toHaveCount(1);
  const seq = await replySeq(ann, agent.id, agent.conversationId, tag);
  const twelve = Array.from({ length: 12 }, (_, i) => ({ n: i + 1, url: `https://site${i + 1}.example.com/p`, title: `第 ${i + 1} 个网页` }));
  await addWebSources(agent.conversationId, seq, twelve, [{ at: text.indexOf("- 晴") + 3, n: 12 }]);
  await page.setViewportSize({ width: 360, height: 780 });
  await page.reload();
  const web = agentMessagesWith(chatPane(page, agent.name), tag);
  await expect(web.locator(".bubble .md")).toHaveCount(1);
  const chip = web.locator(".bubble .md li a.cite-link");
  await expect(chip).toHaveText("12");
  const m = await chip.evaluate((a) => {
    const li = a.closest("li");
    const twin = li.nextElementSibling;
    // The chip's own width on one line, measured apart from the list.
    const alone = a.closest("sup").cloneNode(true);
    li.closest(".md").append(alone);
    const natural = alone.querySelector("a").getBoundingClientRect().width;
    alone.remove();
    const style = getComputedStyle(li);
    return {
      room: li.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      natural,
      box: a.querySelector(":scope > span").getBoundingClientRect().height,
      link: a.getBoundingClientRect().height,
      line: parseFloat(style.lineHeight),
      item: li.getBoundingClientRect().height,
      twin: twin.getBoundingClientRect().height,
    };
  });
  // The case this guards: the item is narrower than the chip on one line.
  expect(m.room, `the deepest item's room against the chip's ${m.natural}px`).toBeLessThan(m.natural);
  expect(m.box, "the number's box is one 16px line").toBeCloseTo(16, 0);
  expect(m.link, "the chip is as tall as the text's line").toBeCloseTo(m.line, 0);
  // The item without a chip is whole lines of the text; so is the one with it (its chip on a line of its own or not).
  const whole = (height) => Math.max(1, Math.round(height / m.line)) * m.line;
  expect(m.twin, `the item without a chip, in lines of ${m.line}px`).toBeCloseTo(whole(m.twin), 0);
  expect(m.item, `the item with the chip, in lines of ${m.line}px`).toBeCloseTo(whole(m.item), 0);
  await chip.scrollIntoViewIfNeeded();
  await shot(page, "srcfold-360-nested-chip");
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
  await addWebSources(agent.conversationId, seq, twelve, [{ at: 1, n: 2 }], { queries: ["北京 明天 天气", "明天 降温"] });

  /** The opened block as it is laid out: its height, each row's box and its link's, the words line, 显示全部 when it is there. */
  const layout = (block) =>
    block.evaluate((el) => {
      const box = (node) => {
        const r = node.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height };
      };
      const more = el.querySelector(".web-sources-more > button");
      const words = el.querySelector(".lookup-words");
      return {
        height: box(el).height,
        rows: [...el.querySelectorAll("ol > li:not(.web-sources-more)")].map((li) => ({ row: box(li), link: box(li.querySelector("a")), title: box(li.querySelector(".web-source-title")) })),
        words: { ...box(words), text: box(words).left + parseFloat(getComputedStyle(words).paddingLeft) },
        more: more && { ...box(more), text: box(more).left + parseFloat(getComputedStyle(more).paddingLeft), low: document.elementFromPoint(box(more).left + 20, box(more).top + 41) === more },
      };
    });
  /** Dense rows: one line each (a phone's a little taller), no room between them, the link as long as the row. */
  const expectDense = (m, narrow, what) => {
    const [least, most] = narrow ? [32, 34] : [28, 30];
    for (const [i, { row, link }] of m.rows.entries()) {
      expect(row.height, `${what}: row ${i + 1} is one dense line`).toBeGreaterThanOrEqual(least);
      expect(row.height, `${what}: row ${i + 1} is one dense line`).toBeLessThanOrEqual(most);
      expect(link.height, `${what}: row ${i + 1}'s link is the row's height`).toBeCloseTo(row.height, 0);
      expect(link.right, `${what}: row ${i + 1}'s link reaches the row's end`).toBeGreaterThanOrEqual(row.right - 1);
      if (i > 0) expect(Math.abs(row.top - m.rows[i - 1].row.bottom), `${what}: row ${i + 1} follows row ${i} with nothing between, and no overlap`).toBeLessThanOrEqual(0.5);
    }
    // The words head the rows in the same rhythm, in line with the titles.
    expect(m.words.height, `${what}: the words line`).toBeGreaterThanOrEqual(least);
    expect(m.words.height, `${what}: the words line`).toBeLessThanOrEqual(most);
    expect(Math.abs(m.words.text - m.rows[0].title.left), `${what}: the words start where the titles do`).toBeLessThanOrEqual(1);
    expect(Math.abs(m.rows[0].row.top - m.words.bottom), `${what}: the first row follows the words`).toBeLessThanOrEqual(0.5);
  };

  for (const [name, size] of [["1280", { width: 1280, height: 860 }], ["390", { width: 390, height: 844 }], ["360", { width: 360, height: 780 }]]) {
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
    // The reply itself, its chip in its text (its number alone, in its box) — on a phone's width too.
    await shot(page, `srcfold-${name}-0-chip`, web);
    if (name !== "360") await shot(page, `srcfold-${name}-1-folded`);

    // Opened by the keyboard, in place: five rows and the row that shows them all.
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(list.locator("a")).toHaveCount(5);
    await expect(list).toBeInViewport({ ratio: 1 });
    await expect(toggle).toBeInViewport({ ratio: 1 });
    // Its owner's conversation: the words it searched for head the block.
    await expect(web.locator(".sources-block > *").first()).toHaveText("搜索词：北京 明天 天气、明天 降温");
    const more = list.getByRole("button", { name: "显示全部 12 个" });
    await expect(more).toBeVisible();
    await expectNoSideways(page, `opened at ${name}`);
    const narrow = size.width <= 480;
    const short = await layout(web.locator(".sources-block"));
    expectDense(short, narrow, `five rows at ${name}`);
    // 显示全部: a row of the same rhythm in line with the titles; narrow, its target is still 44px (it reaches down, off the rows).
    expect(short.more.height, "显示全部 is a row like the others").toBeLessThanOrEqual(narrow ? 34 : 30);
    expect(Math.abs(short.more.text - short.rows[0].title.left), "显示全部 starts where the titles do").toBeLessThanOrEqual(1);
    expect(Math.abs(short.more.top - short.rows[4].row.bottom), "显示全部 follows row 5").toBeLessThanOrEqual(0.5);
    if (narrow) expect(short.more.low, "显示全部 keeps a 44px target").toBe(true);
    if (name !== "360") await shot(page, `srcfold-${name}-2-open`);
    if (name === "390") await shot(page, "srcfold-390-4-owner-words");

    // Tab walks the rows to 显示全部; pressed, the rest are there and the first of them has the focus.
    for (let i = 0; i < 6; i += 1) await page.keyboard.press("Tab");
    await expect(more).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(list.locator("a")).toHaveCount(12);
    await expect(more).toHaveCount(0);
    await expect(list.locator("a").nth(5)).toBeFocused();
    await expect(list.locator("li").nth(11)).toContainText("12");
    await expectNoSideways(page, `all twelve at ${name}`);
    const whole = await layout(web.locator(".sources-block"));
    expect(whole.rows).toHaveLength(12);
    expectDense(whole, narrow, `twelve rows at ${name}`);
    // Twelve rows and the words: thirteen dense lines and next to nothing around them.
    expect(whole.height, `the opened block of twelve at ${name}`).toBeLessThanOrEqual(13 * (narrow ? 34 : 30) + 6);
    const rows = await list.locator("li").evaluateAll((els) => els.map((li) => ({ right: li.querySelector("a").getBoundingClientRect().right, colRight: li.closest(".msg-main").getBoundingClientRect().right })));
    for (const row of rows) expect(row.right, `a source row ends inside the column at ${name}`).toBeLessThanOrEqual(row.colRight + 1);
    if (name !== "360") await shot(page, `srcfold-${name}-3-all`);

    // The chip in the text opens its page itself, folded or not.
    await expect(web.locator(".bubble a.cite-link")).toHaveAttribute("href", twelve[1].url);
    await toggle.click();
    await expect(list).toHaveCount(0);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
  }
});

test("on a narrow page the button's enlarged target leaves 回复 its own presses: a press on that button's top edge replies, and the sources stay folded (390)", async ({ people }) => {
  // A member reads someone else's Agent's reply in a group: no model line under it, the footer follows the lookup line.
  const ann = await people.member("Ann", { open: false });
  const bo = await people.member("Bo");
  const cy = await people.member("Cy", { open: false });
  await befriend(ann, bo);
  await befriend(ann, cy);
  const agent = await agentApi(ann, { name: `边缘${uniq(4)}` });
  const { id: groupId, title } = await groupApi(ann, [bo, cy]);
  await addApi(ann, groupId, agent.id);
  const page = bo.page;
  const tag = uniq(6);
  await page.reload();
  const chat = await openChat(page, title);
  await modelStub.reply(`明天晴。${tag}`);
  await sendText(page, title, `@${agent.handle} 明天天气？${tag}`);
  await expect(agentMessagesWith(chat, `明天晴。${tag}`)).toHaveCount(1);
  const seq = await replySeq(bo, agent.id, groupId, `明天晴。${tag}`);
  await addWebSources(groupId, seq, SOURCES, [], { queries: ["明天 天气"] });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(chatPane(page, title)).toBeVisible();
  const web = agentMessagesWith(chatPane(page, title), `明天晴。${tag}`);
  const toggle = web.locator(".msg-lookups button.sources-toggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(web.locator(".msg-via")).toHaveCount(0);
  await web.locator(".bubble").hover();
  const reply = web.getByRole("button", { name: "回复" });
  await expect(reply).toBeVisible();
  const [box, above] = [await reply.boundingBox(), await toggle.boundingBox()];
  // The case this guards: the top of 回复 is within the 13px the target reaches below the line.
  expect(box.y - (above.y + above.height), "回复 starts inside the target's reach").toBeLessThan(13);
  expect(box.x, "回复 is under the button").toBeLessThan(above.x + above.width);
  await page.mouse.click(box.x + box.width / 2, box.y + 1);
  await expect(chatPane(page, title).locator(".reply-chip")).toContainText(`回复 ${agent.name}`);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(web.locator("ol.web-sources")).toHaveCount(0);
  // And the button's own line still opens the sources.
  await page.mouse.click(above.x + above.width / 2, above.y + above.height / 2);
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  // A member is shown the pages, never the words.
  await expect(web.locator("ol.web-sources a")).toHaveCount(2);
  await expect(web.locator(".lookup-words")).toHaveCount(0);
  await expect(chatPane(page, title)).not.toContainText("搜索词");
});
