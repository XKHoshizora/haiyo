// An Agent's reply as Markdown in a real browser, through the real Markdown worker under the page's real
// Content-Security-Policy: what renders (a heading, code, a table, display maths, every link with its real host), what
// never happens (a remote image fetched, a raw <script> run), and that neither hostile replies nor a long conversation
// opened again can hold up the page (a requestAnimationFrame heartbeat measured in the page). The replies come from the local model stub
// (support/model-stub.mjs); the people fixture also fails the test on any CSP violation, uncaught error or injected
// markup (support/fixtures.mjs).
import { test, expect } from "./support/fixtures.mjs";
import { HOSTILE } from "./support/fixtures.mjs";
import { uniq } from "./support/accounts.mjs";
import { agentMessagesWith, createAgentUi, goTo, openChat, sendText, streamingBubble } from "./support/app.mjs";
import { canControlService } from "./support/control.mjs";
import { modelStub } from "./support/model-stub.mjs";
import { capture } from "./support/shots.mjs";

test.beforeEach(async () => {
  test.skip(!canControlService, "needs the local service and its model stub");
  await modelStub.reset();
});

/** Where the reply's image points: a host nothing on the page may ever ask for. */
const IMAGE_HOST = "images.example.test";
/** The note under an Agent's text shown plain because it is too complex (or was too slow) to render. */
const NOTE = "这条回复内容过于复杂，已按纯文本显示。";
/** The longest the page's main thread may be held up while hostile replies are streamed and opened. */
const STALL_MS = 300;

const REPLY = [
  "# 三日行程",
  "",
  "先看一段代码：",
  "",
  "```python",
  'print("出发")',
  "```",
  "",
  "| 城市 | 天数 |",
  "| --- | --- |",
  "| 杭州 | 2 |",
  "| 苏州 | 1 |",
  "",
  "$$",
  "E = mc^2",
  "$$",
  "",
  `![西湖风景](https://${IMAGE_HOST}/west-lake.png)`,
  "",
  "<script>window.__markdownScript = 1</script>",
  "",
  HOSTILE,
  "",
  "资料见 [https://docs.example.com/guide](https://evil.example.net/steal)。",
].join("\n");

// The third review's inputs (app/web/tests/hostile-cases-r3.js): in round 2's renderer, on the page's main thread,
// 12.0 s (raw-HTML processing instructions) and 4.5 s (an html fence of <script> lines).
const lines = (unit, lineLen, total) => {
  const line = unit.repeat(Math.ceil(lineLen / unit.length)).slice(0, lineLen);
  const count = Math.floor((total + 1) / (lineLen + 1));
  return Array.from({ length: count }, () => line).join("\n");
};
const para = (unit, lineLen, total, lead = "a ") => {
  const body = lead + unit.repeat(Math.ceil((lineLen - lead.length) / unit.length));
  return Array.from({ length: Math.floor((total + 1) / (lineLen + 1)) }, () => body.slice(0, lineLen)).join("\n");
};
const HTML_PI = para("<?", 9990, 49990);
const HTML_SCRIPT_FENCE = "```html\n" + lines("<script>", 160, 10000) + "\n```";
/** Slow for the parser past a few thousand lines (its time grows with the square of their number): 36 000 characters. */
const SETEXT = Array.from({ length: 12000 }, () => "a\n=").join("\n");

/** Starts a requestAnimationFrame heartbeat in the page: the longest gap between two frames is kept. */
async function startHeartbeat(page) {
  await page.evaluate(() => {
    const beat = { max: 0, last: performance.now(), frames: 0 };
    window.__heartbeat = beat;
    const tick = (now) => {
      beat.max = Math.max(beat.max, now - beat.last);
      beat.last = now;
      beat.frames += 1;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
/** The heartbeat so far (also kept in the test's annotations, for the record). */
async function heartbeat(page, label) {
  const beat = await page.evaluate(() => ({ max: Math.round(window.__heartbeat.max), frames: window.__heartbeat.frames }));
  test.info().annotations.push({ type: "heartbeat", description: `${label}: longest frame gap ${beat.max} ms over ${beat.frames} frames` });
  return beat;
}

test("an Agent's reply renders its heading, code, table and maths through the worker; its remote image is never fetched, its script never runs, every link shows where it really goes", async ({ people }) => {
  const ann = await people.member("Ann");
  const name = `排版${uniq(4)}`;
  const workers = [];
  ann.page.on("worker", (worker) => workers.push(worker.url()));
  const chat = await createAgentUi(ann.page, { name, persona: "你用 Markdown 回答。" });
  const asked = [];
  ann.page.on("request", (request) => asked.push(request.url()));

  await modelStub.reply(REPLY, { chunkSize: 16 });
  await sendText(ann.page, name, `排一下行程 ${uniq(4)}`);
  const reply = agentMessagesWith(chat, "三日行程");
  await expect(reply).toHaveCount(1);
  const body = reply.locator(".bubble");

  await expect(body.getByRole("heading", { name: "三日行程" })).toBeVisible();
  await expect(body.locator(".md-code code")).toHaveText('print("出发")');
  await expect(body.locator(".md-code code .hljs-built_in")).toHaveText("print");
  const table = body.getByRole("table");
  await expect(table.getByRole("cell", { name: "杭州" })).toBeVisible();
  await expect(table.getByRole("row")).toHaveCount(3);
  await expect(body.locator(".katex-display .katex")).toBeVisible();
  // It came from the Markdown worker: a module worker, a same-origin file of its own.
  expect(workers.some((url) => new URL(url).origin === new URL(ann.page.url()).origin && /\/assets\/markdownWorker-[\w-]+\.js$/.test(new URL(url).pathname))).toBe(true);

  // The image is its alt text as a link, never an <img>; nothing asked the image's host for anything.
  await expect(body.locator("img")).toHaveCount(0);
  await expect(body.getByRole("link", { name: "西湖风景" })).toHaveAttribute("href", `https://${IMAGE_HOST}/west-lake.png`);
  // Every link is followed by its real host, whatever its text says.
  const docs = body.getByRole("link", { name: "https://docs.example.com/guide" });
  await expect(docs).toHaveAttribute("href", "https://evil.example.net/steal");
  await expect(body.locator(".md-host")).toHaveText([`(${IMAGE_HOST})`, "(evil.example.net)"]);
  // …after one space, in ASCII brackets (no mark of any one language).
  await expect(body.locator(".md-link").filter({ has: ann.page.getByRole("link", { name: "https://docs.example.com/guide" }) })).toHaveText(
    "https://docs.example.com/guide (evil.example.net)",
  );
  // Raw HTML is not markup: no <script> in the page from it, and it never ran.
  await expect(chat.locator("script")).toHaveCount(0);
  expect(await ann.page.evaluate(() => window.__markdownScript)).toBeUndefined();

  // (Give anything that would load a moment to try, and look at the shot meanwhile.)
  await capture(ann.page, "agent-chat-markdown");
  await ann.page.waitForTimeout(500);
  expect(asked.filter((url) => new URL(url).host === IMAGE_HOST), "requests to the image's host").toEqual([]);
});

test("hostile replies never hold up the page: streamed in full, then opened from storage, the heartbeat never stalls", async ({ people }) => {
  test.setTimeout(180_000);
  const ann = await people.member("Ann");
  const name = `重负${uniq(4)}`;
  let chat = await createAgentUi(ann.page, { name, persona: "你回答。" });
  await startHeartbeat(ann.page);

  // Streamed in full (the bubble shows what comes; the stored message keeps the first 8 000 characters).
  await modelStub.reply(HTML_PI, { chunkSize: 5000, delayMs: 50 });
  await sendText(ann.page, name, `第一个 ${uniq(4)}`);
  await expect(agentMessagesWith(chat, "a <?<?<?")).toHaveCount(1);
  await modelStub.reply(HTML_SCRIPT_FENCE, { chunkSize: 2000, delayMs: 50 });
  await sendText(ann.page, name, `第二个 ${uniq(4)}`);
  await expect(agentMessagesWith(chat, "<script><script>")).toHaveCount(1);
  let beat = await heartbeat(ann.page, "streaming");
  expect(beat.frames).toBeGreaterThan(10);
  expect(beat.max, `longest frame gap while streaming: ${beat.max} ms`).toBeLessThan(STALL_MS);

  // Opened from storage in a fresh page, the heartbeat running from before the conversation opens.
  await ann.page.goto("/");
  await goTo(ann.page, "Agent");
  await startHeartbeat(ann.page);
  chat = await openChat(ann.page, name);
  const pi = agentMessagesWith(chat, "a <?<?<?");
  const fence = agentMessagesWith(chat, "<script><script>");
  // The html fence (the newest, in view): code, never highlighted (there is no grammar for it any more).
  await expect(fence.locator(".md pre > code")).toBeVisible();
  await expect(fence.locator(".md pre > code span")).toHaveCount(0);
  // The processing instructions, once scrolled near: plain, with the note.
  await pi.scrollIntoViewIfNeeded();
  await expect(pi.locator(".md-note")).toHaveText(NOTE);
  await expect(pi.locator(".md")).toHaveCount(0);
  await ann.page.waitForTimeout(1000);
  beat = await heartbeat(ann.page, "opening");
  expect(beat.frames).toBeGreaterThan(10);
  expect(beat.max, `longest frame gap while opening: ${beat.max} ms`).toBeLessThan(STALL_MS);
  expect(await ann.page.evaluate(() => window.__xss)).toBeUndefined();
});

/** An ordinary long reply (a heading and a list of 480 items with bold and code: about 1 440 elements, 6 700 characters). */
const longReply = (i) => [`## 第 ${i} 篇`, "", ...Array.from({ length: 480 }, (_, n) => `- **项** \`c${n % 10}\` 文`)].join("\n");
/** Replies in the conversation opened again (the service starts at most 20 replies a minute for one owner). */
const REPLIES = 18;

test("a conversation of many long replies opened again costs what is in view: far replies stay plain, the heartbeat never stalls", async ({ people }) => {
  test.setTimeout(240_000);
  const ann = await people.member("Ann");
  const name = `重开${uniq(4)}`;
  const other = `旁边${uniq(4)}`;
  await createAgentUi(ann.page, { name: other, persona: "你回答。" });
  let chat = await createAgentUi(ann.page, { name, persona: "你回答。" });
  for (let i = 0; i < REPLIES; i += 1) {
    // (Little usage reported, so the suite's small free allowance lasts all these replies.)
    await modelStub.reply(longReply(i), { chunkSize: 4000, usage: { input: 1, output: 1 } });
    await sendText(ann.page, name, `第 ${i} 问 ${uniq(4)}`);
    const reply = agentMessagesWith(chat, `第 ${i} 篇`);
    await expect(reply).toHaveCount(1);
    // Each reply is rendered while it is the newest: the page now holds its answer.
    await expect(reply.locator(".md li").first()).toBeVisible();
  }

  // Leave for another conversation, then open this one again, the heartbeat running from before it opens.
  await openChat(ann.page, other);
  await startHeartbeat(ann.page);
  chat = await openChat(ann.page, name);
  const newest = agentMessagesWith(chat, `第 ${REPLIES - 1} 篇`);
  await expect(newest.locator(".md li").first()).toBeVisible();
  await ann.page.waitForTimeout(1000);
  // What is far from view stays plain, though its answer is held; nothing was rendered just because it was held.
  await expect(agentMessagesWith(chat, "第 0 篇").locator(".md")).toHaveCount(0);
  expect(await chat.locator(".md-text > .md").count()).toBeLessThan(REPLIES);
  const beat = await heartbeat(ann.page, "opening again");
  expect(beat.frames).toBeGreaterThan(10);
  expect(beat.max, `longest frame gap while opening again: ${beat.max} ms`).toBeLessThan(STALL_MS);
});

test("a reply the worker is too slow for: the worker is ended and made again, the rest of the reply stays plain with the note, the page never stalls", async ({ people }) => {
  test.setTimeout(180_000);
  const ann = await people.member("Ann");
  const name = `慢速${uniq(4)}`;
  const workers = [];
  ann.page.on("worker", (worker) => workers.push(worker.url()));
  const chat = await createAgentUi(ann.page, { name, persona: "你回答。" });
  await startHeartbeat(ann.page);

  await modelStub.reply(SETEXT, { chunkSize: 1500, delayMs: 250 });
  await sendText(ann.page, name, `慢一点 ${uniq(4)}`);
  // While it streams, two answers in a row come too late: the rest of this reply is plain, with the note.
  await expect(streamingBubble(chat).locator(".md-note")).toHaveText(NOTE, { timeout: 30_000 });
  // (The first worker rendered the Agent's greeting; each late answer ended one, and the next text got a new one.)
  expect(workers.length, "workers made").toBeGreaterThanOrEqual(2);
  await expect(streamingBubble(chat)).toHaveCount(0, { timeout: 30_000 });
  await ann.page.waitForTimeout(1000);
  const beat = await heartbeat(ann.page, "slow reply");
  expect(beat.frames).toBeGreaterThan(10);
  expect(beat.max, `longest frame gap: ${beat.max} ms`).toBeLessThan(STALL_MS);
});
