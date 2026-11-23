// An owner and their Agent in a real browser against the real service, the model being the local stub
// (support/model-stub.mjs): creating one, a reply streaming in, stopping, pausing, the free allowance and the balance,
// persona proposals, a new topic, and what a stranger can reach.
import { randomUUID } from "node:crypto";
import { test, expect } from "./support/fixtures.mjs";
import { grantPoints, uniq } from "./support/accounts.mjs";
import {
  PAID_MODEL,
  agentMessagesWith,
  chooseModelUi,
  createAgentUi,
  expectOnce,
  expectStored,
  goTo,
  messageList,
  newTopicUi,
  openAgentDetail,
  openChat,
  runStatusLine,
  sendText,
  streamingBubble,
} from "./support/app.mjs";
import { canControlService } from "./support/control.mjs";
import { modelStub } from "./support/model-stub.mjs";
import { capture } from "./support/shots.mjs";

test.beforeEach(async () => {
  // (Decided in the worker: the runner lists the tests before the local system is up.)
  test.skip(!canControlService, "needs the local service and its model stub");
  await modelStub.reset();
});

/**
 * The greeting of an Agent made without a persona: its model's own first reply (app/service src/agents/conversation.ts),
 * which the stub answers with its `GREETING_REPLY` (support/model-stub.mjs) — never a fixed line of the service's.
 */
const GREETING = "你刚刚创建的 Agent";

/**
 * Records, in the page, every text the reply being written shows (to tell that it grew piece by piece), and the size of
 * its bubble each time (to tell how the layout moves while it grows: bubbles are as wide as their text).
 */
async function watchStream(page) {
  await page.evaluate(() => {
    window.__streamSeen = [];
    window.__streamBoxes = [];
    const list = document.querySelector('[data-testid="message-list"]');
    new MutationObserver(() => {
      const bubble = list.querySelector("li.streaming .bubble");
      // (正在回复… shows until the first piece arrives.)
      const text = bubble && !bubble.querySelector(".dots") ? bubble.textContent : "";
      const seen = window.__streamSeen;
      if (text && seen[seen.length - 1] !== text) {
        seen.push(text);
        const box = bubble.getBoundingClientRect();
        window.__streamBoxes.push([Math.round(box.width), Math.round(box.height)]);
      }
    }).observe(list, { subtree: true, childList: true, characterData: true });
  });
}

/** The texts of the conversation's items, in order (messages, dividers, the reply being written, the status line). */
const itemTexts = (chat) => messageList(chat).getByRole("listitem").allInnerTexts();
const indexOf = (texts, part) => texts.findIndex((t) => t.includes(part));

/** Back to the list on a phone (the Agent pages and conversations have a back button there). */
const backToList = (page, name) => () => page.getByRole("button", { name }).first().click();

test("an Agent without a persona greets; its reply streams in piece by piece; after a reload the history is whole and nothing of the stream is left", async ({ people }) => {
  const ann = await people.member("Ann");
  const name = `小助手${uniq(4)}`;
  const chat = await createAgentUi(ann.page, {
    name,
    intro: "帮你处理日常小事",
    field: "生活助理",
    onFilled: async (form) => {
      // 帮我起草 and the persona's character count share a row under the box: the count is centred on the button.
      // (Measured on the texts themselves: a box stretched to the button's height would be centred whatever its text does.)
      const textBox = (locator) =>
        locator.evaluate((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          const { y, height } = range.getBoundingClientRect();
          return { y, height };
        });
      const draft = await textBox(form.getByRole("button", { name: "帮我起草" }));
      const count = await textBox(form.getByText(/^\d+ \/ 20000$/));
      const middle = (b) => b.y + b.height / 2;
      expect(Math.abs(middle(count) - middle(draft)), `count ${JSON.stringify(count)} beside 帮我起草 ${JSON.stringify(draft)}`).toBeLessThanOrEqual(2);
      await capture(ann.page, "agent-create");
      await capture(ann.page, "agent-create-persona", { show: form.getByRole("button", { name: "帮我起草" }) });
    },
  });
  await expect(agentMessagesWith(chat, GREETING)).toHaveCount(1);

  const first = "我先说第一段，然后慢慢地往下写，";
  const rest = "这是第二段，说完了。";
  await modelStub.hangAfter(first, { chunkSize: 2, delayMs: 80 });
  await watchStream(ann.page);
  const mine = `你好呀 ${uniq(4)}`;
  await sendText(ann.page, name, mine);

  // The first part shows while the reply is still being written (the model is holding), with 停止生成.
  const bubble = streamingBubble(chat);
  await expect(bubble).toContainText(first);
  await modelStub.holding(1);
  await expect(bubble).not.toContainText(rest);
  await expect(bubble.getByRole("button", { name: "停止生成" })).toBeEnabled();
  await capture(ann.page, "agent-chat-streaming");
  await modelStub.release(rest);

  // One stored reply replaces the bubble; the bubble grew through several texts, each the start of the next.
  await expectStored(chat, first + rest);
  await expect(bubble).toHaveCount(0);
  const seen = await ann.page.evaluate(() => window.__streamSeen);
  expect(seen.length, `texts the bubble showed: ${JSON.stringify(seen)}`).toBeGreaterThanOrEqual(3);
  for (let i = 1; i < seen.length; i += 1) expect(seen[i].startsWith(seen[i - 1]), JSON.stringify(seen)).toBe(true);
  expect((first + rest).startsWith(seen[seen.length - 1])).toBe(true);
  // The bubble only grows while the text does: it never gets narrower or shorter on the way (no jumping back and forth).
  const boxes = await ann.page.evaluate(() => window.__streamBoxes);
  for (let i = 1; i < boxes.length; i += 1) {
    expect(boxes[i][0] >= boxes[i - 1][0] - 1 && boxes[i][1] >= boxes[i - 1][1] - 1, `bubble sizes: ${JSON.stringify(boxes)}`).toBe(true);
  }

  // What the model was given: my message, after the system text.
  const [call] = await modelStub.calls();
  expect(JSON.stringify(call.body.messages)).toContain(mine);

  await ann.page.reload();
  const again = await openChat(ann.page, name);
  await expectOnce(again, GREETING);
  await expectStored(again, mine);
  await expectStored(again, first + rest);
  await expect(streamingBubble(again)).toHaveCount(0);
  await expect(again.getByText("正在回复…")).toHaveCount(0);
  await expect(messageList(again).getByRole("listitem").filter({ hasText: first })).toHaveCount(1);

  await openAgentDetail(ann.page, name);
  await capture(ann.page, "agent-list", { mobile: backToList(ann.page, "返回我的 Agent") });
});

test("停止生成 keeps what was said, marked 已停止; while paused nothing is answered; after resuming the next message is, the paused one is not", async ({ people }) => {
  const ann = await people.member("Ann");
  const name = `助理${uniq(4)}`;
  const tag = uniq(4);
  const chat = await createAgentUi(ann.page, { name, persona: "你是一个简洁的助手。" });

  const said = `这句话说到一半 ${tag}`;
  await modelStub.hangAfter(said);
  await sendText(ann.page, name, `讲个长故事 ${tag}`);
  await modelStub.holding(1);
  await expect(streamingBubble(chat)).toContainText(said);
  await streamingBubble(chat).getByRole("button", { name: "停止生成" }).click();
  const stopped = agentMessagesWith(chat, said);
  await expect(stopped).toHaveCount(1);
  await expect(stopped.locator(".msg-foot")).toContainText("已停止");
  await expect(streamingBubble(chat)).toHaveCount(0);
  await expect.poll(async () => (await modelStub.calls())[0].aborted, { message: "the model call was ended" }).toBe(true);

  // Paused from its page: the page and the conversation both say so.
  let detail = await openAgentDetail(ann.page, name);
  await detail.getByRole("button", { name: "暂停全部会话" }).click();
  await expect(detail.getByRole("status").filter({ hasText: "已暂停全部会话：它不会有新回复" })).toBeVisible();
  await openChat(ann.page, name);
  await expect(chat.getByText("已暂停全部会话：它不会有新回复")).toBeVisible();
  const whilePaused = `暂停时说的话 ${tag}`;
  await sendText(ann.page, name, whilePaused);
  // (No reply is started: give the service a moment in which one would have been.)
  await ann.page.waitForTimeout(2000);
  expect(await modelStub.calls()).toHaveLength(1);
  await expect(streamingBubble(chat)).toHaveCount(0);
  await expect(runStatusLine(chat)).toHaveCount(0);

  detail = await openAgentDetail(ann.page, name);
  await detail.getByRole("button", { name: "恢复全部会话" }).click();
  await expect(detail.getByRole("button", { name: "暂停全部会话" })).toBeVisible();
  await openChat(ann.page, name);
  await expect(chat.getByText("已暂停全部会话：它不会有新回复")).toHaveCount(0);
  const answer = `恢复后的回答 ${tag}`;
  await modelStub.reply(answer);
  const afterResume = `恢复后说的话 ${tag}`;
  await sendText(ann.page, name, afterResume);
  await expectStored(chat, answer);

  // One reply, to the message after resuming; nothing answers the one sent while paused.
  const texts = await itemTexts(chat);
  expect(indexOf(texts, afterResume), "my message after the pause comes right after the one sent during it").toBe(indexOf(texts, whilePaused) + 1);
  expect(indexOf(texts, answer)).toBe(indexOf(texts, afterResume) + 1);
  const calls = await modelStub.waitForCalls(2);
  const users = calls[1].body.messages.filter((m) => m.role === "user");
  expect(JSON.stringify(users[users.length - 1])).toContain(afterResume);
});

test("used-up free allowance: the reply says so with its reset time; after a grant a paid model answers and 用量与余额 shows the charge", async ({ people }) => {
  const ann = await people.member("Ann");
  const name = `记账员${uniq(4)}`;
  const tag = uniq(4);
  const chat = await createAgentUi(ann.page, { name, persona: "你是一个记账助手。" });

  // Each reply reports 100 tokens in and 70 out: 0.701 points at the free model's prices, of the 1-point allowance (the
  // second is charged the 0.299 left, the rest forgiven).
  const heavy = { usage: { input: 100, output: 70 } };
  await modelStub.script({ text: `第一次回答 ${tag}`, ...heavy }, { text: `第二次回答 ${tag}`, ...heavy });
  await sendText(ann.page, name, `问题一 ${tag}`);
  await expectStored(chat, `第一次回答 ${tag}`);
  await sendText(ann.page, name, `问题二 ${tag}`);
  await expectStored(chat, `第二次回答 ${tag}`);
  await sendText(ann.page, name, `问题三 ${tag}`);
  const line = runStatusLine(chat);
  await expect(line).toContainText(/今天的免费额度和余额都已用完，免费额度将在 ?(明天|今天|\d+月\d+日) \d\d:\d\d 重置。/);
  await expect(line.getByRole("button", { name: "查看用量与余额" })).toBeVisible();
  expect(await modelStub.calls(), "the third message never reached the model").toHaveLength(2);
  await capture(ann.page, "agent-run-failed");

  // The operator grants 5 points; the Agent moves to the paid model.
  await grantPoints(ann, "5");
  const detail = await openAgentDetail(ann.page, name);
  await detail.getByRole("button", { name: "编辑" }).click();
  const form = ann.page.getByRole("region", { name: "编辑 Agent" });
  await chooseModelUi(ann.page, form, PAID_MODEL);
  await expect(form.getByText("你现在的余额是 5 点")).toBeVisible();
  await form.getByRole("button", { name: "保存", exact: true }).click();
  await expect(detail.locator(".kv-row").filter({ hasText: "模型" })).toContainText("演示高级模型");

  // 100 in and 50 out at the paid model's prices: 0.601 points.
  const paid = `付费模型的回答 ${tag}`;
  await modelStub.reply(paid, { usage: { input: 100, output: 50 } });
  await openChat(ann.page, name);
  await sendText(ann.page, name, `问题四 ${tag}`);
  await expectStored(chat, paid);

  await goTo(ann.page, "设置");
  await ann.page.getByRole("button", { name: /用量与余额/ }).click();
  const usage = ann.page.getByRole("region", { name: "用量与余额" });
  const row = (label) => usage.locator(".kv-row").filter({ hasText: label });
  await expect(row("已用 / 每日额度")).toContainText("1 / 1 点");
  // (A balance is shown rounded DOWN at the display precision — never more spendable points than there are: 4.399 is 4.39; the costs below 1 keep four decimals.)
  await expect(row("当前余额")).toContainText("4.39 点");
  const recent = usage.getByRole("list", { name: "最近用量" }).getByRole("listitem");
  await expect(recent.filter({ hasText: "演示高级模型（本站）" })).toContainText("0.601 点 · 1 次回复");
  await expect(recent.filter({ hasText: "演示快速模型（本站）" })).toContainText("1 点 · 2 次回复");
  await capture(ann.page, "settings-usage");
});

test("a reply the model service fails is a status line with 重试, not a message; 重试 answers, and the line goes", async ({ people }) => {
  const ann = await people.member("Ann");
  const name = `重试${uniq(4)}`;
  const tag = uniq(4);
  const chat = await createAgentUi(ann.page, { name, persona: "你是测试用的助手。" });
  // (A 400: a failure the system does not try again by itself — a 5xx it retries automatically — so the owner presses 重试.)
  await modelStub.script({ status: 400 }, { text: `重试后的回答 ${tag}` });
  await sendText(ann.page, name, `问一句 ${tag}`);
  const line = runStatusLine(chat);
  // A site model's failure: the site's to fix, so the sentence does not send the owner to their settings.
  await expect(line).toContainText("站点提供的这个模型暂时用不了，请稍后重试，或换一个模型。");
  await expect(line).not.toHaveAttribute("data-msg");
  await expect(agentMessagesWith(chat, "")).toHaveCount(0);
  await capture(ann.page, "agent-run-failed-retry");
  await line.getByRole("button", { name: "重试" }).click();
  await expectStored(chat, `重试后的回答 ${tag}`);
  await expect(line).toHaveCount(0);
  expect(await modelStub.calls()).toHaveLength(2);
});

/** A reply holding a persona proposal: optional text before it, then the block (app/service README, Persona proposals). */
const proposing = (before, { persona, intro, field }) =>
  `${before}\n${intro ? `<af-intro>${intro}</af-intro>\n` : ""}${field ? `<af-field>${field}</af-field>\n` : ""}<af-persona>${persona}</af-persona>`;

test("a proposal in a reply is a card; a newer one supersedes it; confirming puts its persona on the Agent", async ({ people }) => {
  const ann = await people.member("Ann");
  const name = `规划师${uniq(4)}`;
  const tag = uniq(4);
  const chat = await createAgentUi(ann.page, { name });
  const p1 = `你是一位旅行规划助手（第一版 ${tag}）。`;
  const p2 = `你是一位旅行规划助手（第二版 ${tag}）：说话简洁，先问预算和天数，再给出按天的行程。`;

  await modelStub.reply(proposing("好的，我整理了第一版设定。", { persona: p1, intro: "帮你规划旅行", field: "旅行规划" }));
  await sendText(ann.page, name, `你帮我规划旅行吧 ${tag}`);
  const first = agentMessagesWith(chat, "我整理了第一版设定");
  const firstCard = first.locator(".proposal-card");
  await expect(firstCard).toContainText(p1);
  await expect(firstCard).toContainText("待你确认");
  await expect(firstCard).toContainText("旅行规划");
  await expect(chat).not.toContainText("<af-");

  await modelStub.reply(proposing("改好了，请看第二版。", { persona: p2 }));
  await sendText(ann.page, name, `再简洁一点，先问预算 ${tag}`);
  const secondCard = agentMessagesWith(chat, "请看第二版").locator(".proposal-card");
  await expect(secondCard).toContainText("待你确认");
  await expect(firstCard).toContainText("已被新的提议取代");
  await expect(firstCard.getByRole("button")).toHaveCount(0);
  await capture(ann.page, "agent-proposal");

  await secondCard.getByRole("button", { name: "确认", exact: true }).click();
  await expect(secondCard).toContainText("已采用");
  await expect(secondCard.getByRole("button", { name: "确认", exact: true })).toHaveCount(0);
  const detail = await openAgentDetail(ann.page, name);
  await expect(detail.locator(".kv-row").filter({ hasText: "人格文档" })).toContainText(p2);
  // The second proposal named no 简介: the first one's was never applied.
  await expect(detail.getByText("还没有简介。")).toBeVisible();
  await capture(ann.page, "agent-detail");
});

test("a new topic shows a divider, and the Agent is then given only what came after it", async ({ people }) => {
  const ann = await people.member("Ann");
  const name = `话题${uniq(4)}`;
  const tag = uniq(4);
  const chat = await createAgentUi(ann.page, { name, persona: "你是测试用的助手。" });
  const before = `新话题之前说的 ${tag}`;
  const after = `新话题之后说的 ${tag}`;
  await modelStub.script({ text: `回答一 ${tag}` }, { text: `回答二 ${tag}` });
  await sendText(ann.page, name, before);
  await expectStored(chat, `回答一 ${tag}`);

  await newTopicUi(ann.page, chat);
  const divider = messageList(chat).locator("li.msg-divider");
  await expect(divider).toHaveCount(1);
  await expect(divider).toHaveText("新话题");
  await sendText(ann.page, name, after);
  await expectStored(chat, `回答二 ${tag}`);

  const texts = await itemTexts(chat);
  const at = texts.findIndex((t) => t.trim() === "新话题");
  expect(at).toBeGreaterThan(indexOf(texts, `回答一 ${tag}`));
  expect(at).toBeLessThan(indexOf(texts, after));
  const calls = await modelStub.waitForCalls(2);
  const sent = JSON.stringify(calls[1].body.messages);
  expect(sent).toContain(after);
  expect(sent).not.toContain(before);
  expect(sent).not.toContain(`回答一 ${tag}`);
  expect(calls[1].body.messages.filter((m) => m.role === "user")).toHaveLength(1);
  await capture(ann.page, "agent-new-topic");
});

test("a model that thinks: the level is chosen in the form, and the thinking is folded above the reply under 思考过程", async ({ people }) => {
  const ann = await people.member("Ann");
  // Setup (not what this test is about): a provider of Ann's speaking Anthropic Messages, the protocol whose thinking the
  // service passes on, with a model flagged as one that thinks.
  const provider = `思考供应商${uniq(4)}`;
  const res = await ann.request.post("/api/providers", {
    data: { name: provider, protocol: "anthropic", baseUrl: modelStub.baseUrl, apiKey: "sk-e2e-thinking-not-real", models: [{ name: "stub-think", reasoning: true }] },
  });
  expect(res.status(), await res.text()).toBe(201);

  const name = `深思${uniq(4)}`;
  const tag = uniq(4);
  const chat = await createAgentUi(ann.page, {
    name,
    model: "stub-think",
    reasoning: "中",
    persona: "你会先想清楚再回答。",
    onFilled: (form) => capture(ann.page, "agent-create-reasoning", { show: form.getByLabel("思考程度", { exact: true }) }),
  });
  const reasoning = `先看看问题问的是什么，再一步步推下去 ${tag}。`;
  const answer = `答案是四十二 ${tag}。`;
  await modelStub.script({ reasoning, text: answer, chunkSize: 3, delayMs: 30, hang: true });
  await sendText(ann.page, name, `宇宙的答案是什么？ ${tag}`);
  await modelStub.holding(1);
  // While it is written: the thinking so far is there, folded as it was from its first piece, under how long it thought.
  const bubble = streamingBubble(chat);
  await expect(bubble.locator("details.thinking summary")).toHaveText(/^思考了 \d+ 秒$/);
  await expect(bubble.locator("details.thinking")).not.toHaveAttribute("open", "");
  await capture(ann.page, "agent-chat-thinking-streaming");
  await modelStub.release("");

  const reply = agentMessagesWith(chat, answer);
  await expect(reply).toHaveCount(1);
  const thinking = reply.locator("details.thinking");
  await expect(thinking.locator(".thinking-text")).toBeHidden();
  await thinking.locator("summary").click();
  await expect(thinking.locator(".thinking-text")).toHaveText(reasoning);
  await capture(ann.page, "agent-chat-thinking");
  // The level went with the call: Anthropic's adaptive thinking at effort "medium" (app/service README, Calling a model).
  const [call] = await modelStub.calls();
  expect([call.path, call.body.thinking?.type, call.body.output_config?.effort]).toEqual(["/v1/messages", "adaptive", "medium"]);
});

test("a stranger cannot open someone's Agent conversation by its address: the same not-found answer as for an id that does not exist", async ({ people }) => {
  const ann = await people.member("Ann");
  const name = `私人助手${uniq(4)}`;
  await createAgentUi(ann.page, { name, persona: "你是私人助手。" });
  const { agents } = await (await ann.request.get("/api/agents")).json();
  const agent = agents.find((a) => a.name === name);
  const eve = await people.member("Eve");
  const nobody = randomUUID();
  const addresses = (conv, agentId) => [
    `/api/conversations/${conv}`,
    `/api/conversations/${conv}/messages`,
    `/api/conversations/${conv}/run`,
    `/api/agents/${agentId}`,
    `/api/principals/${agentId}/avatar`,
  ];
  const real = addresses(agent.conversationId, agent.id);
  const made = addresses(nobody, nobody);
  for (let i = 0; i < real.length; i += 1) {
    const theirs = await eve.page.goto(real[i]);
    const shown = await eve.page.locator("body").innerText();
    const none = await eve.page.goto(made[i]);
    expect([real[i], theirs.status()]).toEqual([real[i], 404]);
    expect([real[i], await theirs.text()]).toEqual([real[i], await none.text()]);
    expect(await eve.page.locator("body").innerText()).toBe(shown);
  }
  // The owner reads the same addresses.
  expect((await ann.request.get(real[0])).status()).toBe(200);
  // And Eve's app has nothing of it.
  await eve.page.goto("/");
  await goTo(eve.page, "消息");
  await expect(eve.page.getByText(name)).toHaveCount(0);
});
