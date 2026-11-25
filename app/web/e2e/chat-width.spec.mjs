// The chat column never scrolls sideways (the owner's phone: a reply that searched the web listed sources whose titles were far wider than the screen and
// the whole message column slid off). Every block a message can hold — an unbroken 300-character string, a long address, a code line, a wide table, a quote of a
// long text, a file with a long name, a picture, a sources list with long titles — at 320, 375 and 402 wide: the message scroller never scrolls horizontally and
// neither does the page. Wide content scrolls inside its own box.
import { test, expect } from "./support/fixtures.mjs";
import { befriend, uniq } from "./support/accounts.mjs";
import { agentMessagesWith, chatPane, openChat, sendFile } from "./support/app.mjs";
import { canControlService } from "./support/control.mjs";
import { addWebSources } from "./support/db.mjs";
import { png } from "./support/files.mjs";
import { modelStub } from "./support/model-stub.mjs";
import { polishShot } from "./support/shots.mjs";
import { agentApi } from "./support/tools.mjs";

const PHONE = { viewport: { width: 402, height: 874 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 };
const LONG = `超长的没有空格的字符串${"x".repeat(300)}`;
const LONG_URL = `https://example.com/${"path-segment/".repeat(25)}?q=${"y".repeat(60)}`;
const WIDTHS = [320, 375, 402];

/** The message scroller and the page do not scroll sideways. */
async function expectNoSideways(page, what) {
  const m = await page.evaluate(() => {
    const list = document.querySelector("ol.messages");
    return { list: list ? list.scrollWidth - list.clientWidth : 0, page: document.documentElement.scrollWidth - window.innerWidth };
  });
  expect(m.list, `${what}: the message scroller's overflow`).toBeLessThanOrEqual(0);
  expect(m.page, `${what}: the page's overflow`).toBeLessThanOrEqual(0);
}

test.beforeEach(async () => {
  test.skip(!canControlService, "needs the local service, its model stub and its database");
  await modelStub.reset();
});

test("hostile content in every kind of message never makes the column wider than the screen (320, 375, 402)", async ({ people }) => {
  const ann = await people.member("Ann", { contextOptions: PHONE });
  const bo = await people.member("Bo");
  const dm = await befriend(ann, bo);
  const page = ann.page;
  const agent = await agentApi(ann, { name: `宽度${uniq(4)}` });

  // A person's chat: the unbroken string, an address, a quote of the long text, a file with a long name, a picture.
  const first = await bo.request.post(`/api/conversations/${dm}/messages`, { data: { text: LONG, clientTxn: `w${uniq(6)}` } });
  expect(first.status()).toBe(201);
  const seq = (await first.json()).message.seq;
  expect((await bo.request.post(`/api/conversations/${dm}/messages`, { data: { text: LONG_URL, clientTxn: `w${uniq(6)}` } })).status()).toBe(201);
  expect((await ann.request.post(`/api/conversations/${dm}/messages`, { data: { text: `回复${"z".repeat(300)}`, replyToSeq: seq, clientTxn: `w${uniq(6)}` } })).status()).toBe(201);
  await page.reload();
  const chat = await openChat(page, bo.displayName);
  await sendFile(page, bo.displayName, { name: `${"文件名".repeat(30)}.txt`, mimeType: "text/plain", buffer: Buffer.from("hello") });
  await sendFile(page, bo.displayName, { name: "图.png", mimeType: "image/png", buffer: png(600, 80) }, "选择图片或视频");
  await expect(chat.locator("ol.messages")).toContainText("zzzzzz");
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 800 });
    await expectNoSideways(page, `a person's chat at ${width}`);
  }
  await page.setViewportSize({ width: 402, height: 874 });
  await polishShot(page, "ui2-width-person-chat");
  await page.getByRole("button", { name: "返回列表" }).click();

  // The Agent's reply: Markdown with a wide code line, a wide table, an unbroken string and an address, then a sources list with long titles.
  const tag = uniq(6);
  const reply = [
    `# 标题 ${tag}`,
    "",
    "```text",
    "c".repeat(300),
    "```",
    "",
    `| ${"列".repeat(40)} | ${"b".repeat(80)} |`,
    "| --- | --- |",
    `| ${"数".repeat(40)} | ${"d".repeat(80)} |`,
    "",
    LONG,
    "",
    LONG_URL,
  ].join("\n");
  await modelStub.reply(reply);
  await page.locator(".list-col .row", { hasText: agent.name }).click();
  const agentChat = chatPane(page, agent.name);
  await expect(agentChat).toBeVisible();
  await agentChat.getByLabel("消息内容").fill(`给我一段长内容 ${tag}`);
  await agentChat.getByLabel("消息内容").press("Enter");
  await expect(agentMessagesWith(agentChat, tag)).toHaveCount(1);
  const res = await ann.request.get(`/api/conversations/${agent.conversationId}/messages`);
  const stored = (await res.json()).messages.find((m) => m.senderId === agent.id && m.text.includes(tag));
  const sources = [
    { n: 1, url: "https://news.example.com/a/1", title: "Max Verstappen wins the Las Vegas Grand Prix for the third time in four seasons after a late safety car" },
    { n: 2, url: "https://sport.example.org/b", title: "F1 Las Vegas Grand Prix: Oscar Piastri finishes third behind the McLaren of Lando Norris at the end of a chaotic race" },
    { n: 3, url: "https://www.formula1.example/c", title: "F1 – The Official Home of Formula 1 Racing" },
    { n: 4, url: "https://example.com/d", title: "一个特别特别长的中文标题，用来看一行放不下时是不是被省略号截断而不是把整列撑宽".repeat(2) },
  ];
  await addWebSources(agent.conversationId, stored.seq, sources, [{ at: 1, n: 2 }]);
  await page.reload();
  await expect(chatPane(page, agent.name)).toBeVisible();
  // The sources are folded until the reader opens them (web-sources.spec.mjs).
  await page.locator(".msg-lookups .sources-toggle").click();
  await expect(page.locator("ol.web-sources li")).toHaveCount(4);
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 800 });
    await expectNoSideways(page, `the Agent's reply and its sources at ${width}`);
    // The sources: each inside the column, the host kept, every row the same font size.
    const rows = await page.locator("ol.web-sources li").evaluateAll((els) =>
      els.map((li) => ({
        right: li.querySelector("a").getBoundingClientRect().right,
        colRight: li.closest(".msg-main").getBoundingClientRect().right,
        size: getComputedStyle(li.querySelector(".web-source-title")).fontSize,
        host: li.querySelector(".web-source-host").getBoundingClientRect().width,
      })),
    );
    for (const row of rows) {
      expect(row.right, `a source row ends inside the column at ${width}`).toBeLessThanOrEqual(row.colRight + 1);
      expect(row.host, "the host is still shown").toBeGreaterThan(20);
    }
    expect(new Set(rows.map((r) => r.size)).size, "every row the same font size").toBe(1);
  }
  await page.setViewportSize({ width: 402, height: 874 });
  await polishShot(page, "ui2-width-sources");
});
