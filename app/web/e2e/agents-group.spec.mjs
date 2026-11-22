// Batch 2C in a real browser against the real service, the model being the local stub (support/model-stub.mjs): an
// owner's own Agent in a group — added from 添加成员, called with @, replying as one whole message, charged to its owner;
// what the other members never receive of it (persona, model, thinking); Agents calling each other, 让 Agent 停下 and the
// chain limit; a failed reply; leaving with its owner, taken out by the creator, deleted. Then the day's other changes:
// message times, the two-step provider form, a model's 高级 panel, and the paced reveal of a reply in an Agent's own
// conversation with its thinking line. Screenshots (E2E_SHOTS=1) go to docs/acceptance/batch2c/shots/.
import { test, expect } from "./support/fixtures.mjs";
import { befriend, createGroupApi, sendApi, uniq } from "./support/accounts.mjs";
import {
  agentMessagesWith,
  chatPane,
  composer,
  createAgentUi,
  createGroupUi,
  expectStored,
  goTo,
  messageList,
  messagesWith,
  openAgentDetail,
  openChat,
  rail,
  runStatusLine,
  sendText,
  streamingBubble,
} from "./support/app.mjs";
import { canControlService, restartService } from "./support/control.mjs";
import { backdateMessage } from "./support/db.mjs";
import { heartbeat, startHeartbeat } from "./support/heartbeat.mjs";
import { STUB_MODELS, modelStub } from "./support/model-stub.mjs";
import { captureIn } from "./support/shots.mjs";

const shot = captureIn("batch2c");

test.beforeEach(async () => {
  test.skip(!canControlService, "needs the local service and its model stub");
  await modelStub.reset();
});

// --- setup through the API (not what the tests are about) -----------------------------------------------------------

/** The site's free model (support/system.mjs `siteModels`) as an Agent's model. */
const FREE = { source: "site", id: "e2e-free" };

/** An Agent of `owner`'s made through the API (its handle is `<owner handle>.<namePart>`); resolves with the owner's view of it (`id`, `handle`, `name`…). */
async function agentApi(owner, { name, intro, field, persona, model = FREE, reasoning }) {
  const data = { namePart: `ag_${uniq(10)}`, name, model };
  if (intro) data.intro = intro;
  if (field) data.field = field;
  if (persona) data.persona = persona;
  if (reasoning) data.reasoning = reasoning;
  const res = await owner.request.post("/api/agents", { data });
  expect(res.status(), await res.text()).toBe(201);
  return res.json();
}

/** A group of `creator` and `members` (the creator's friends), made through the API: `{id, title}`. */
async function groupApi(creator, members) {
  const title = `群${uniq(6)}`;
  return { id: await createGroupApi(creator, members, title), title };
}

/** `person` adds `principalId` (a friend, or their own Agent) to group `groupId` through the API. */
async function addApi(person, groupId, principalId) {
  const res = await person.request.post(`/api/conversations/${groupId}/members`, { data: { principalId } });
  expect(res.status(), await res.text()).toBe(201);
}

/** Ann with her friends Bo and Cy (a group starts with two of its creator's friends). */
async function trio(people) {
  const [ann, bo, cy] = await people.friendsOf(["Ann", "Bo", "Cy"]);
  return { ann, bo, cy };
}

// --- what a person sees in a group -----------------------------------------------------------------------------------

/** The notices of the open conversation that contain `text`. */
const notices = (chat, text) => messageList(chat).locator("li.msg-system").filter({ hasText: text });
/** An Agent's reply being written in a group: its row, 正在回复… (`li.streaming`, also in a group). */
const replyingRow = (chat, agentName) => messageList(chat).locator("li.streaming").filter({ hasText: agentName });
/** Someone else's Agent's 暂时无法回复. */
const unavailableLine = (chat) => messageList(chat).locator("li.run-unavailable");
const haltButton = (chat) => chat.getByRole("button", { name: "让 Agent 停下" });

/** The open group's 群资料, members tab first. */
async function openMembers(page, title) {
  await chatPane(page, title).getByRole("button", { name: "群资料" }).click();
  const profile = page.getByRole("region", { name: "群资料" });
  await expect(profile).toBeVisible();
  return profile;
}

async function backToGroup(page, title, profile) {
  await profile.getByRole("button", { name: "返回群聊" }).click();
  await expect(chatPane(page, title)).toBeVisible();
}

/** The row of 群资料's member list whose name is exactly `name`. */
const memberRow = (page, profile, name) => profile.getByRole("listitem").filter({ has: page.getByText(name, { exact: true }) });

/** Waits `ms`, then: the model was called exactly `n` times in all (nothing more was started). */
async function noMoreCalls(page, n, ms = 2500) {
  await page.waitForTimeout(ms);
  expect(await modelStub.calls(), `${n} model call(s) and no more`).toHaveLength(n);
}

// --- 1. adding one's own Agent ---------------------------------------------------------------------------------------

test("an owner adds their own Agent from 添加成员 (我的 Agent); the member list shows it as an Agent with its owner and intro, to the owner and to a member", async ({ people }) => {
  const { ann, bo, cy } = await trio(people);
  const name = `查查${uniq(4)}`;
  const intro = "帮大家查资料";
  const field = "资料检索";
  await createAgentUi(ann.page, { name, intro, field, persona: "你帮群里的人查资料。" });
  const title = `周末群${uniq(4)}`;
  const annChat = await createGroupUi(ann.page, title, [bo.displayName, cy.displayName]);
  const boChat = await openChat(bo.page, title);

  const profile = await openMembers(ann.page, title);
  await profile.getByRole("button", { name: "添加成员" }).click();
  const dialog = ann.page.getByRole("dialog", { name: "添加成员" });
  await expect(dialog.getByRole("heading", { name: "我的 Agent" })).toBeVisible();
  const offered = dialog.getByRole("list", { name: "可添加的 Agent" }).getByRole("listitem");
  await expect(offered).toHaveCount(1);
  await expect(offered).toContainText(name);
  await expect(offered).toContainText("Agent");
  // Both friends are in the group already: no friend is offered.
  await expect(dialog.getByRole("list", { name: "可添加的好友" }).getByRole("listitem")).toHaveCount(0);
  await shot(ann.page, "group-add-member");
  await offered.getByRole("button", { name: "添加", exact: true }).click();
  await expect(ann.page.getByRole("status").filter({ hasText: `已添加${name}` })).toBeVisible();
  await dialog.getByRole("button", { name: "完成" }).click();
  await expect(dialog).toBeHidden();

  // The owner's list: the Agent tag, 主人：你, its intro and field; its owner may take it out.
  const mine = memberRow(ann.page, profile, name);
  await expect(mine).toContainText("Agent");
  await expect(mine).toContainText("主人：你");
  await expect(mine).toContainText(`${intro} · ${field}`);
  await expect(mine.getByRole("button", { name: "移除" })).toBeVisible();
  await expect(profile).toContainText("共 4 位成员");
  await backToGroup(ann.page, title, profile);
  await expect(notices(annChat, `你邀请${name}加入了群聊`)).toHaveCount(1);

  // The member's: the join notice, then the same row — whose it is, by the owner's name.
  await expect(notices(boChat, `${ann.displayName}邀请${name}加入了群聊`)).toHaveCount(1);
  const boProfile = await openMembers(bo.page, title);
  const theirs = memberRow(bo.page, boProfile, name);
  await expect(theirs).toContainText("Agent");
  await expect(theirs).toContainText(`主人：${ann.displayName}`);
  await expect(theirs).toContainText(`${intro} · ${field}`);
  // Bo is neither its owner nor the group's creator.
  await expect(theirs.getByRole("button", { name: "移除" })).toHaveCount(0);
  await shot(bo.page, "group-members");
});

// --- 2. calling it with @ ---------------------------------------------------------------------------------------------

test("a member calls the Agent with @ (its account name goes in); both see 正在回复…, then the whole reply at once with whose it is; the owner is charged, the member is not", async ({ people }) => {
  const { ann, bo, cy } = await trio(people);
  const agent = await agentApi(ann, { name: `答答${uniq(4)}`, intro: "回答大家的问题", persona: "你回答群里的问题。" });
  const { id: groupId, title } = await groupApi(ann, [bo, cy]);
  await addApi(ann, groupId, agent.id);
  const annChat = await openChat(ann.page, title);
  const boChat = await openChat(bo.page, title);
  await expect(notices(boChat, `邀请${agent.name}加入了群聊`)).toHaveCount(1);
  const boUsage = async () => {
    const { free, balance, recent } = await (await bo.request.get("/api/usage")).json();
    return { used: free?.used, balance, recent };
  };
  const boBefore = await boUsage();

  // Bo types @ and picks the Agent from the members: a tag of its name goes in, meaning that Agent (Task M).
  await composer(boChat).click();
  await bo.page.keyboard.type("@");
  const option = bo.page.getByRole("listbox", { name: "选择要提及的成员" }).getByRole("option").filter({ hasText: agent.name });
  await expect(option).toContainText(`@${agent.handle} · Agent · 主人：${ann.displayName}`);
  await shot(bo.page, "group-mention-picker");
  await option.click();
  await expect(composer(boChat)).toHaveValue(`@${agent.name} `);
  const tag = uniq(4);
  const question = `帮我查一下明天的天气 ${tag}`;
  const first = `先说一半 ${tag}，`;
  const rest = `明天晴，最高二十度。`;
  await modelStub.hangAfter(first);
  await bo.page.keyboard.type(question);
  await composer(boChat).press("Enter");
  await expectStored(boChat, `@${agent.name} ${question}`);

  // While it writes: 正在回复… for both, none of its text (nothing streams in a group); only its owner can stop it.
  await modelStub.holding(1);
  for (const chat of [annChat, boChat]) {
    await expect(replyingRow(chat, agent.name)).toContainText("正在回复…");
    await expect(chat).not.toContainText(first);
  }
  await expect(replyingRow(annChat, agent.name).getByRole("button", { name: "停止生成" })).toBeVisible();
  await expect(replyingRow(boChat, agent.name).getByRole("button")).toHaveCount(0);
  await shot(bo.page, "group-replying");
  await shot(ann.page, "group-replying-owner");
  await modelStub.release(rest);

  // Then the reply, once, whole, with the Agent tag and its owner.
  for (const [chat, owner] of [
    [annChat, "你"],
    [boChat, ann.displayName],
  ]) {
    const reply = agentMessagesWith(chat, first + rest);
    await expect(reply).toHaveCount(1);
    await expect(reply).toHaveAttribute("data-msg", /^m\d+$/);
    await expect(reply.locator(".msg-meta")).toContainText("Agent");
    await expect(reply.locator(".msg-meta")).toContainText(`主人：${owner}`);
    await expect(replyingRow(chat, agent.name)).toHaveCount(0);
  }
  await shot(ann.page, "group-reply-owner");
  await shot(bo.page, "group-reply-member");
  const [call] = await modelStub.calls();
  expect(JSON.stringify(call.body.messages)).toContain(question);

  // Ann pays: the free model's allowance (20 tokens in, 10 out: 0.1002 points), one reply of her Agent's.
  await goTo(ann.page, "设置");
  await ann.page.getByRole("button", { name: /用量与余额/ }).click();
  const usage = ann.page.getByRole("region", { name: "用量与余额" });
  await expect(usage.locator(".kv-row").filter({ hasText: "已用 / 每日额度" })).toContainText("0.1002 / 1 点");
  const row = usage.getByRole("list", { name: "最近用量" }).getByRole("listitem").filter({ hasText: agent.name });
  await expect(row).toContainText("演示快速模型（本站）");
  await expect(row).toContainText("0.1002 点 · 1 次回复");
  await shot(ann.page, "group-usage-owner");
  // Bo, who called it, pays nothing.
  await goTo(bo.page, "设置");
  await bo.page.getByRole("button", { name: /用量与余额/ }).click();
  const boPage = bo.page.getByRole("region", { name: "用量与余额" });
  await expect(boPage.locator(".kv-row").filter({ hasText: "已用 / 每日额度" })).toContainText("0 / 1 点");
  await expect(boPage).toContainText("最近 7 天还没有用量。");
  expect(await boUsage()).toEqual(boBefore);
});

// --- 3. what a member never receives ----------------------------------------------------------------------------------

/**
 * Everything `context`'s pages receive from now on: every HTTP response body and every WebSocket frame, as text.
 * `all()` waits for the bodies still being read.
 */
function recordTraffic(context) {
  const bodies = [];
  const frames = [];
  const reading = [];
  const watch = (page) => {
    page.on("response", (response) => {
      reading.push(
        response.body().then(
          (body) => bodies.push(`${response.url()}\n${body.toString("utf8")}`),
          () => {},
        ),
      );
    });
    page.on("websocket", (ws) => ws.on("framereceived", (frame) => frames.push(typeof frame.payload === "string" ? frame.payload : frame.payload.toString("utf8"))));
  };
  context.on("page", watch);
  for (const page of context.pages()) watch(page);
  return {
    frames,
    async all() {
      await Promise.all(reading);
      return [...bodies, ...frames].join("\n");
    },
    /** The bodies of the service's answers (`/api/…`), each `url\nbody`, once every one has been read. */
    async api() {
      await Promise.all(reading);
      return bodies.filter((b) => new URL(b.slice(0, b.indexOf("\n"))).pathname.startsWith("/api/"));
    },
  };
}

test("a member never receives the Agent's persona, its model or its thinking: not on any page they can open, not in any response or socket frame", async ({ people }) => {
  const ann = await people.member("Ann");
  const cy = await people.member("Cy");
  // Bo's browser is watched from its first request.
  const bo = await people.member("Bo", { open: false });
  await befriend(ann, bo);
  await befriend(ann, cy);
  const traffic = recordTraffic(bo.context);
  bo.page = await people.openApp(bo);

  // Ann's Agent: a persona with a mark in it, on a model of her own provider (Anthropic Messages, which streams the
  // stub's thinking) at a thinking level.
  const tag = uniq(6);
  const personaMark = `ZEBRA${tag}`;
  const thinkingMark = `OKAPI${tag}`;
  const modelName = `secret-model-${tag}`;
  const providerName = `prov-${tag}`;
  const apiKey = `sk-e2e-${tag}-not-real`;
  const res = await ann.request.post("/api/providers", {
    data: { name: providerName, protocol: "anthropic", baseUrl: modelStub.baseUrl, apiKey, models: [{ name: modelName, reasoning: true }] },
  });
  expect(res.status(), await res.text()).toBe(201);
  const provider = await res.json();
  const agent = await agentApi(ann, {
    name: `阿岚${uniq(4)}`,
    intro: "一个说话简短的助手",
    persona: `你是阿岚，说话很短。暗号 ${personaMark}。`,
    model: { source: "provider", providerId: provider.id, model: modelName },
    reasoning: "medium",
  });
  const { id: groupId, title } = await groupApi(ann, [bo, cy]);
  await addApi(ann, groupId, agent.id);
  const annChat = await openChat(ann.page, title);
  const boChat = await openChat(bo.page, title);

  const answerMark = `ANSWER${tag}`;
  const thought = `我先想想 ${thinkingMark}，再回答。`;
  await modelStub.script({ reasoning: thought, text: `我是阿岚。${answerMark}`, chunkSize: 6 });
  await sendText(bo.page, title, `@${agent.handle} 介绍一下你自己 ${tag}`);
  for (const chat of [annChat, boChat]) await expect(agentMessagesWith(chat, answerMark)).toHaveCount(1);
  // Its thinking is its owner's only: folded above the reply for Ann, nothing of it for Bo.
  const annThinking = agentMessagesWith(annChat, answerMark).locator("details.thinking");
  await expect(annThinking.locator("summary")).toHaveText("思考过程");
  await annThinking.locator("summary").click();
  await expect(annThinking.locator(".thinking-text")).toHaveText(thought);
  await expect(agentMessagesWith(boChat, answerMark).locator("details.thinking")).toHaveCount(0);
  // Which model and thinking level the reply used: a line under it for Ann (once its run is charged), none for Bo.
  await expect(agentMessagesWith(annChat, answerMark).locator(".msg-via")).toHaveText(`${modelName} · 思考：中`);
  await expect(agentMessagesWith(boChat, answerMark).locator(".msg-via")).toHaveCount(0);
  // The persona and the model were really in play: the model was given the persona, by that name, and it thought.
  const [call] = await modelStub.calls();
  expect(JSON.stringify(call.body)).toContain(personaMark);
  expect(call.body.model).toBe(modelName);

  const secrets = [personaMark, thinkingMark, modelName, providerName, apiKey];
  const onPage = async () => {
    const html = await bo.page.content();
    return secrets.filter((s) => html.includes(s));
  };
  expect(await onPage(), "in the conversation").toEqual([]);
  // 群资料: the Agent's row (its public face) and nothing more.
  const profile = await openMembers(bo.page, title);
  await expect(memberRow(bo.page, profile, agent.name)).toContainText("一个说话简短的助手");
  expect(await onPage(), "in 群资料").toEqual([]);
  await backToGroup(bo.page, title, profile);
  // 会话资料.
  await boChat.getByRole("button", { name: "会话资料" }).click();
  await expect(bo.page.getByRole("heading", { name: "会话资料" })).toBeVisible();
  await expect(bo.page.locator(".side")).toContainText(agent.name);
  expect(await onPage(), "in 会话资料").toEqual([]);
  await bo.page.getByRole("button", { name: "关闭", exact: true }).click();
  // The @ picker.
  await composer(boChat).click();
  await bo.page.keyboard.type("@");
  await expect(bo.page.getByRole("listbox", { name: "选择要提及的成员" }).getByRole("option").filter({ hasText: agent.name })).toBeVisible();
  expect(await onPage(), "in the @ picker").toEqual([]);
  await bo.page.keyboard.press("Escape");
  // A fresh load: the service's answers (/api/sync) carry the reply to Bo's browser too, and are looked at below.
  await bo.page.reload();
  await expect(bo.page.locator(".list-col .row-preview").filter({ hasText: answerMark })).toBeVisible();

  // Everything Bo's browser received: the reply came (the recording works), none of the secrets did.
  const received = await traffic.all();
  expect(received).toContain(answerMark);
  for (const secret of secrets) expect(received.includes(secret), `${secret} reached Bo's browser`).toBe(false);
  // The run pushes Bo got carry a state only (never the run, its error or its text), and no piece of the reply.
  const pushes = traffic.frames.map((f) => {
    try {
      return JSON.parse(f);
    } catch {
      return null;
    }
  });
  const runs = pushes.filter((p) => p?.type === "run");
  expect(runs.length, "run pushes Bo received").toBeGreaterThan(0);
  for (const push of runs) expect(Object.keys(push).sort(), JSON.stringify(push)).toEqual(["agentId", "conversationId", "state", "type"]);
  expect(pushes.filter((p) => p?.type === "delta")).toEqual([]);
  // Nothing Bo's browser received from the service carries a `via` (no frame, no answer), though the reply did come, once.
  const replies = pushes.filter((p) => p?.type === "message" && p.message?.text?.includes(answerMark));
  expect(replies.length, "pushes of the reply Bo received").toBe(1);
  for (const frame of traffic.frames) expect(frame.includes('"via"'), frame).toBe(false);
  const answers = await traffic.api();
  expect(answers.some((b) => b.includes(answerMark)), "an answer of the service (its sync) carried the reply").toBe(true);
  for (const body of answers) expect(body.includes('"via"'), body.slice(0, 200)).toBe(false);
});

// --- 4. Agents answering each other, and the brakes -------------------------------------------------------------------

/** Ann's Agent and Bo's in a group of Ann's (with Bo and Cy), both open: `{ann, bo, x, y, title, annChat, boChat}`. */
async function twoAgents(people) {
  const { ann, bo, cy } = await trio(people);
  const x = await agentApi(ann, { name: `甲${uniq(4)}`, persona: "你是甲。" });
  const y = await agentApi(bo, { name: `乙${uniq(4)}`, persona: "你是乙。" });
  const { id: groupId, title } = await groupApi(ann, [bo, cy]);
  await addApi(ann, groupId, x.id);
  await addApi(bo, groupId, y.id);
  const annChat = await openChat(ann.page, title);
  const boChat = await openChat(bo.page, title);
  for (const chat of [annChat, boChat]) await expect(notices(chat, `邀请${y.name}加入了群聊`)).toHaveCount(1);
  return { ann, bo, cy, x, y, title, annChat, boChat };
}

test("one Agent calling another gets it to answer; 让 Agent 停下 shows for both people, says who stopped them, and no Agent answers after", async ({ people }) => {
  const { ann, bo, x, y, title, annChat, boChat } = await twoAgents(people);
  const tag = uniq(4);
  const xFirst = `好的，@${y.handle} 你来说说 ${tag}`;
  const yReply = `我说完了，@${x.handle} 你接着说 ${tag}`;
  const xHeld = `我接着说到一半 ${tag}`;
  await modelStub.script({ text: xFirst }, { text: yReply }, { text: xHeld, hang: true });
  await sendText(ann.page, title, `@${x.handle} 请和乙聊聊 ${tag}`);

  // Ann's Agent answers her and calls Bo's, which answers and calls Ann's again: that one is being written.
  await expectStored(boChat, xFirst);
  await expectStored(annChat, yReply);
  await expect(agentMessagesWith(annChat, yReply).locator(".msg-meta")).toContainText(`主人：${bo.displayName}`);
  await modelStub.holding(1);
  for (const chat of [annChat, boChat]) {
    await expect(replyingRow(chat, x.name)).toContainText("正在回复…");
    await expect(haltButton(chat)).toBeVisible();
  }
  await shot(ann.page, "group-halt-button");

  // Bo stops them.
  await haltButton(boChat).click();
  await expect(notices(boChat, "你让 Agent 停止了接话")).toHaveCount(1);
  await expect(notices(annChat, `${bo.displayName}让 Agent 停止了接话`)).toHaveCount(1);
  await expect.poll(async () => (await modelStub.calls())[2]?.aborted, { message: "the reply being written was ended" }).toBe(true);
  for (const chat of [annChat, boChat]) {
    await expect(haltButton(chat)).toHaveCount(0);
    await expect(replyingRow(chat, x.name)).toHaveCount(0);
  }
  // Ann is told her Agent's reply was stopped by a member (nothing to retry); Bo is told nothing about Ann's Agent.
  await expect(runStatusLine(annChat)).toContainText("已被群成员叫停");
  await expect(runStatusLine(annChat).getByRole("button", { name: "重试" })).toHaveCount(0);
  await expect(unavailableLine(boChat)).toHaveCount(0);
  await shot(bo.page, "group-halt-notice");
  await noMoreCalls(ann.page, 3);
  await expect(messagesWith(annChat, xHeld)).toHaveCount(0);
});

test.describe("with AGENT_CHAIN_LIMIT=3", () => {
  // The service is started again with a chain limit of 3 for this test only, and as it was afterwards.
  test.beforeAll(async () => {
    if (canControlService) await restartService({ AGENT_CHAIN_LIMIT: "3" });
  });
  test.afterAll(async () => {
    if (canControlService) await restartService({});
  });

  test("Agents calling each other stop by themselves after 3 messages in a row, with the notice; a person writing lets them go on", async ({ people }) => {
    const { bo, x, y, title, annChat, boChat, ann } = await twoAgents(people);
    const tag = uniq(4);
    await modelStub.script(
      { text: `接龙一 @${y.handle} ${tag}` },
      { text: `接龙二 @${x.handle} ${tag}` },
      { text: `接龙三 @${y.handle} ${tag}` },
      { text: `乙又来了 ${tag}` },
    );
    await sendText(ann.page, title, `@${x.handle} 开始接龙 ${tag}`);
    const paused = "Agent 已连续对话 3 条，已暂停互相接话，有人发言后继续。";
    for (const chat of [annChat, boChat]) {
      await expectStored(chat, `接龙三 @${y.handle} ${tag}`);
      await expect(notices(chat, paused)).toHaveCount(1);
    }
    await noMoreCalls(ann.page, 3);
    await expect(haltButton(boChat)).toHaveCount(0);
    await shot(bo.page, "group-chain-paused");

    // A person writing lets them go on: Bo calls his Agent, and it answers.
    await sendText(bo.page, title, `@${y.handle} 你还在吗 ${tag}`);
    await expectStored(annChat, `乙又来了 ${tag}`);
    await noMoreCalls(ann.page, 4, 1500);
  });
});

// --- 5. a failed reply -----------------------------------------------------------------------------------------------

test("a reply that fails: its owner sees why and 重试, another member only that it cannot reply now; 重试 answers and both lines go", async ({ people }) => {
  const { ann, bo, cy } = await trio(people);
  const agent = await agentApi(ann, { name: `易错${uniq(4)}`, persona: "你是测试用的助手。" });
  const { id: groupId, title } = await groupApi(ann, [bo, cy]);
  await addApi(ann, groupId, agent.id);
  const annChat = await openChat(ann.page, title);
  const boChat = await openChat(bo.page, title);
  await expect(notices(boChat, `邀请${agent.name}加入了群聊`)).toHaveCount(1);

  const tag = uniq(4);
  // (A 400: a failure the system does not try again by itself — a 5xx it retries automatically — so the owner presses 重试.)
  await modelStub.script({ status: 400 }, { text: `重试后的回答 ${tag}` });
  await sendText(bo.page, title, `@${agent.handle} 帮个忙 ${tag}`);
  const line = runStatusLine(annChat);
  await expect(line).toContainText(`${agent.name}：站点提供的这个模型暂时用不了，请稍后重试，或换一个模型。`);
  await expect(line.getByRole("button", { name: "重试" })).toBeVisible();
  const theirs = unavailableLine(boChat);
  await expect(theirs).toHaveText(`${agent.name}暂时无法回复`);
  // Bo learns no reason and has nothing to press.
  await expect(runStatusLine(boChat)).toHaveCount(0);
  await expect(boChat).not.toContainText("站点提供的这个模型");
  await expect(messageList(boChat).getByRole("button", { name: "重试" })).toHaveCount(0);
  await shot(ann.page, "group-failed-owner");
  await shot(bo.page, "group-failed-member");

  await line.getByRole("button", { name: "重试" }).click();
  for (const chat of [annChat, boChat]) await expectStored(chat, `重试后的回答 ${tag}`);
  await expect(line).toHaveCount(0);
  await expect(theirs).toHaveCount(0);
  expect(await modelStub.calls()).toHaveLength(2);
});

// --- 6. leaving and being taken out ----------------------------------------------------------------------------------

test("the owner (the group's creator) leaves: the Agent leaves with them, both notices show, it is no longer a member, and its account name calls nobody", async ({ people }) => {
  const { ann, bo, cy } = await trio(people);
  const agent = await agentApi(ann, { name: `跟班${uniq(4)}`, persona: "你是测试用的助手。" });
  const { id: groupId, title } = await groupApi(ann, [bo, cy]);
  await addApi(ann, groupId, agent.id);
  const boChat = await openChat(bo.page, title);
  await expect(notices(boChat, `邀请${agent.name}加入了群聊`)).toHaveCount(1);

  await openChat(ann.page, title);
  const profile = await openMembers(ann.page, title);
  await profile.getByRole("tab", { name: "群设置" }).click();
  await profile.getByRole("button", { name: "退出本群" }).click();
  const dialog = ann.page.getByRole("dialog", { name: `退出群聊「${title}」` });
  await expect(dialog).toContainText("你的 Agent 会一起离开。");
  await shot(ann.page, "group-leave-with-agent");
  await dialog.getByRole("button", { name: "确认退出" }).click();
  await expect(ann.page.getByRole("status").filter({ hasText: "已退出群聊" })).toBeVisible();

  await expect(notices(boChat, `${agent.name}退出了群聊`)).toHaveCount(1);
  await expect(notices(boChat, `${ann.displayName}退出了群聊`)).toHaveCount(1);
  const boProfile = await openMembers(bo.page, title);
  await expect(boProfile).toContainText("共 2 位成员");
  await expect(memberRow(bo.page, boProfile, agent.name)).toHaveCount(0);
  await expect(memberRow(bo.page, boProfile, ann.displayName)).toHaveCount(0);
  await backToGroup(bo.page, title, boProfile);
  await shot(bo.page, "group-owner-left");

  // Its account name calls nobody now.
  await sendText(bo.page, title, `@${agent.handle} 你还在吗 ${uniq(4)}`);
  await noMoreCalls(bo.page, 0);
  await expect(replyingRow(boChat, agent.name)).toHaveCount(0);
});

test("an Agent is taken out by the group's creator (not its owner here); a member who is neither has no 移除 for it", async ({ people }) => {
  // Cy creates the group, with Ann and Bo; Ann adds her Agent.
  const [cy, ann, bo] = await people.friendsOf(["Cy", "Ann", "Bo"]);
  const agent = await agentApi(ann, { name: `外援${uniq(4)}`, persona: "你是测试用的助手。" });
  const { id: groupId, title } = await groupApi(cy, [ann, bo]);
  await addApi(ann, groupId, agent.id);

  // Bo, neither its owner nor the creator: no 移除 at all.
  const boChat = await openChat(bo.page, title);
  const boProfile = await openMembers(bo.page, title);
  await expect(memberRow(bo.page, boProfile, agent.name)).toContainText(`主人：${ann.displayName}`);
  await expect(boProfile.getByRole("button", { name: "移除" })).toHaveCount(0);
  // Ann, its owner (not the creator): 移除 on her Agent only.
  await openChat(ann.page, title);
  const annProfile = await openMembers(ann.page, title);
  await expect(memberRow(ann.page, annProfile, agent.name).getByRole("button", { name: "移除" })).toBeVisible();
  await expect(annProfile.getByRole("button", { name: "移除" })).toHaveCount(1);

  // Cy, the creator, takes it out.
  await openChat(cy.page, title);
  const cyProfile = await openMembers(cy.page, title);
  await memberRow(cy.page, cyProfile, agent.name).getByRole("button", { name: "移除" }).click();
  const confirm = cy.page.getByRole("dialog", { name: `移除${agent.name}` });
  await expect(confirm).toContainText("它将不再在这个群里回复");
  await confirm.getByRole("button", { name: "确认移除" }).click();
  await expect(cy.page.getByRole("status").filter({ hasText: `已将${agent.name}移出群聊` })).toBeVisible();
  await expect(memberRow(cy.page, cyProfile, agent.name)).toHaveCount(0);

  await expect(memberRow(bo.page, boProfile, agent.name)).toHaveCount(0);
  await backToGroup(bo.page, title, boProfile);
  await expect(notices(boChat, `${cy.displayName}将${agent.name}移出了群聊`)).toHaveCount(1);
});

// --- 7. deleting it ----------------------------------------------------------------------------------------------------

test("deleting the Agent on its page takes it out of the group: a member sees it leave", async ({ people }) => {
  const { ann, bo, cy } = await trio(people);
  const agent = await agentApi(ann, { name: `临时${uniq(4)}`, persona: "你是测试用的助手。" });
  const { id: groupId, title } = await groupApi(ann, [bo, cy]);
  await addApi(ann, groupId, agent.id);
  const boChat = await openChat(bo.page, title);
  await expect(notices(boChat, `邀请${agent.name}加入了群聊`)).toHaveCount(1);

  const detail = await openAgentDetail(ann.page, agent.name);
  await detail.getByRole("button", { name: "删除 Agent" }).click();
  const dialog = ann.page.getByRole("dialog", { name: `删除${agent.name}` });
  await dialog.getByRole("button", { name: "确认删除" }).click();
  await expect(ann.page.getByRole("status").filter({ hasText: `已删除${agent.name}` })).toBeVisible();

  await expect(notices(boChat, `${agent.name}退出了群聊`)).toHaveCount(1);
  const profile = await openMembers(bo.page, title);
  await expect(profile).toContainText("共 3 位成员");
  await expect(memberRow(bo.page, profile, agent.name)).toHaveCount(0);
});

// --- 8. the day's other changes ---------------------------------------------------------------------------------------

/** HH:mm of an instant in Asia/Shanghai (the suite's browsers' time zone; no daylight saving there). */
function shanghaiClock(iso) {
  const at = new Date(Date.parse(iso) + 8 * 3600_000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`;
}

test("message times: one from yesterday reads 昨天 HH:mm, today's HH:mm; my own messages put the time before my name, others' after theirs", async ({ people }) => {
  const ann = await people.member("Ann");
  const bo = await people.member("Bo");
  const conversationId = await befriend(ann, bo);
  const tag = uniq(4);
  const old = await sendApi(ann, conversationId, `昨天说的话 ${tag}`);
  await sendApi(bo, conversationId, `今天回的话 ${tag}`);
  const at = await backdateMessage(conversationId, old.seq, 1);

  await ann.page.reload();
  await expect(rail(ann.page)).toBeVisible();
  const chat = await openChat(ann.page, bo.displayName);
  const mine = messagesWith(chat, `昨天说的话 ${tag}`);
  await expect(mine.locator(".msg-meta time")).toHaveText(`昨天 ${shanghaiClock(at)}`);
  await expect(mine.locator(".msg-meta time")).toHaveAttribute("title", /^\d{4}年\d{1,2}月\d{1,2}日 星期[一二三四五六日] \d\d:\d\d$/);
  const theirs = messagesWith(chat, `今天回的话 ${tag}`);
  await expect(theirs.locator(".msg-meta time")).toHaveText(/^\d\d:\d\d$/);
  const order = (item) => item.locator(".msg-meta").evaluate((meta) => [...meta.children].map((e) => e.tagName.toLowerCase()));
  expect(await order(mine), "my own message: time, then name").toEqual(["time", "strong"]);
  expect(await order(theirs), "theirs: name, then time").toEqual(["strong", "time"]);
  await shot(ann.page, "message-times");
});

/** Settings › 模型供应商. */
async function openProviders(page) {
  await goTo(page, "设置");
  await page.getByRole("button", { name: /模型供应商/ }).click();
  const section = page.getByRole("region", { name: "模型供应商" });
  await expect(section.getByRole("heading", { name: "我的模型供应商" })).toBeVisible();
  return section;
}

test("adding a provider is two steps: the form has no models yet and saves with 保存并选择模型, then 同步模型 opens", async ({ people }) => {
  const ann = await people.member("Ann");
  const name = `两步供应商${uniq(4)}`;
  // The form asks for https; the request that adds it goes on with the stub's address (as in providers.spec.mjs).
  await ann.page.route("**/api/providers", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const body = JSON.parse(route.request().postData() ?? "{}");
    await route.continue({ postData: JSON.stringify({ ...body, baseUrl: modelStub.baseUrl }) });
  });
  const section = await openProviders(ann.page);
  await section.getByRole("button", { name: "添加供应商" }).click();
  const add = ann.page.getByRole("region", { name: "添加模型供应商" });
  await expect(add).toContainText("保存后从供应商的模型列表里挑选模型。");
  await expect(add.getByRole("heading", { name: "模型", exact: true })).toHaveCount(0);
  await expect(add.getByLabel("模型名称", { exact: true })).toHaveCount(0);
  await expect(add.getByRole("button", { name: "添加模型" })).toHaveCount(0);
  await add.getByLabel("名称", { exact: true }).fill(name);
  await add.getByLabel("接口地址", { exact: true }).fill("https://api.example.test/v1");
  await add.getByLabel("密钥", { exact: true }).fill(`sk-e2e-${uniq(12)}`);
  await add.getByRole("button", { name: "保存并选择模型", exact: true }).click();

  const form = ann.page.getByRole("region", { name: "编辑模型供应商" });
  await expect(form.getByRole("status").filter({ hasText: "已添加。请选择要使用的模型。" })).toBeVisible();
  await expect(ann.page.getByRole("dialog", { name: `${name} 的模型（${STUB_MODELS.length}）` })).toBeVisible();
});

test("a model's 高级 opens its panel (what it can do, its context) and 收起 folds it again", async ({ people }) => {
  const ann = await people.member("Ann");
  const name = `高级供应商${uniq(4)}`;
  const res = await ann.request.post("/api/providers", {
    data: { name, protocol: "openai_chat", baseUrl: "https://api.example.test/v1", apiKey: `sk-e2e-${uniq(12)}`, models: [{ name: "demo-model" }, { name: "gpt-4o-mini" }] },
  });
  expect(res.status(), await res.text()).toBe(201);
  const section = await openProviders(ann.page);
  await section.getByRole("list", { name: "我的模型供应商" }).getByRole("listitem").filter({ hasText: name }).getByRole("button", { name: "编辑" }).click();
  const form = ann.page.getByRole("region", { name: "编辑模型供应商" });
  const row = form.getByRole("list", { name: "模型列表" }).getByRole("listitem").filter({ hasText: "demo-model" });
  const open = row.getByRole("button", { name: "高级设置：demo-model" });
  await expect(open).toHaveText(/^高级/);
  await expect(open).toHaveAttribute("aria-expanded", "false");
  await expect(row.getByLabel("上下文容量")).toHaveCount(0);
  await shot(ann.page, "provider-model-advanced-closed", { show: row });

  await open.click();
  const fold = row.getByRole("button", { name: "收起：demo-model" });
  await expect(fold).toHaveText(/^收起/);
  await expect(fold).toHaveAttribute("aria-expanded", "true");
  const panelId = await fold.getAttribute("aria-controls");
  expect(panelId).toBeTruthy();
  const panel = row.locator(`[id="${panelId}"]`);
  for (const ability of ["能看图片", "能直接读 PDF", "支持思考"]) await expect(panel.getByRole("checkbox", { name: new RegExp(`^${ability}`) })).toBeVisible();
  await expect(panel.getByLabel("上下文容量")).toBeVisible();
  // The other model's stays folded.
  await expect(form.getByRole("button", { name: "高级设置：gpt-4o-mini" })).toHaveAttribute("aria-expanded", "false");
  await shot(ann.page, "provider-model-advanced-open", { show: panel });

  await fold.click();
  await expect(row.getByRole("button", { name: "高级设置：demo-model" })).toHaveAttribute("aria-expanded", "false");
  await expect(panel).toHaveCount(0);
});

/** A paragraph of `n` characters of plain prose (no Markdown syntax, no spaces). */
function prose(n) {
  let text = "";
  for (let i = 1; text.length < n; i += 1) text += `第${i}句说的是今天的天气很好我们一起去公园散步。`;
  return text.slice(0, n);
}

test("a reply in an Agent's own conversation is revealed a little at every frame, ends as the stored message, and the page never stalls (6 000 characters)", async ({ people }) => {
  test.setTimeout(180_000);
  const ann = await people.member("Ann");
  const agent = await agentApi(ann, { name: `长话${uniq(4)}`, persona: "你回答得很长。" });
  const chat = await openChat(ann.page, agent.name);
  const long = prose(6000);
  // Every frame: how long the text of the reply being written is (once its first characters show).
  await ann.page.evaluate(() => {
    const seen = [];
    window.__revealed = seen;
    const tick = () => {
      const bubble = document.querySelector('[data-testid="message-list"] li.streaming .bubble');
      if (bubble && !bubble.querySelector(".dots")) seen.push(bubble.textContent.length);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await startHeartbeat(ann.page);
  // 40 pieces of 150 characters, 60 ms apart (about 2.4 s).
  await modelStub.reply(long, { chunkSize: 150, delayMs: 60 });
  await sendText(ann.page, agent.name, `讲一个很长的故事 ${uniq(4)}`);

  const reply = agentMessagesWith(chat, long.slice(0, 40));
  await expect(reply).toHaveCount(1, { timeout: 30_000 });
  await expect(reply).toHaveAttribute("data-msg", /^m\d+$/);
  await expect(reply.locator(".bubble")).toHaveText(long);
  await expect(streamingBubble(chat)).toHaveCount(0);
  await ann.page.waitForTimeout(500);

  const seen = await ann.page.evaluate(() => window.__revealed);
  const grew = seen.filter((n, i) => i > 0 && n > seen[i - 1]).length;
  test.info().annotations.push({ type: "reveal", description: `${seen.length} frames with text; it grew in ${grew}; first ${seen[0]}, last ${seen[seen.length - 1]}` });
  expect(seen.length, "frames that showed part of the reply").toBeGreaterThanOrEqual(10);
  expect(grew, "frames in which the shown text grew").toBeGreaterThanOrEqual(10);
  expect(seen[0], "the first frame shows only the start").toBeLessThan(long.length / 2);
  for (let i = 1; i < seen.length; i += 1) expect(seen[i], `frame ${i} of ${JSON.stringify(seen)}`).toBeGreaterThanOrEqual(seen[i - 1]);
  const beat = await heartbeat(ann.page, "6 000 characters streamed and revealed");
  expect(beat.frames).toBeGreaterThan(10);
  expect(beat.max, `longest frame gap: ${beat.max} ms`).toBeLessThan(300);
});

test("an Agent that thinks: 正在思考… before anything comes, then its thinking open while it streams, then the answer", async ({ people }) => {
  const ann = await people.member("Ann");
  const tag = uniq(4);
  // Setup: a provider of Ann's speaking Anthropic Messages (whose thinking the service passes on), a model that thinks.
  const res = await ann.request.post("/api/providers", {
    data: { name: `思考供应商${tag}`, protocol: "anthropic", baseUrl: modelStub.baseUrl, apiKey: `sk-e2e-${tag}-not-real`, models: [{ name: "stub-think", reasoning: true }] },
  });
  expect(res.status(), await res.text()).toBe(201);
  const provider = await res.json();
  const agent = await agentApi(ann, {
    name: `深思${tag}`,
    persona: "你会先想清楚再回答。",
    model: { source: "provider", providerId: provider.id, model: "stub-think" },
    reasoning: "medium",
  });
  const chat = await openChat(ann.page, agent.name);
  const reasoning = `先弄清楚问的是什么，再一步一步推下去 ${tag}。`;
  const answer = `想好了：答案是四十二 ${tag}。`;
  // Nothing for 8 s, then the thinking all at once, then it holds until released with the answer.
  await modelStub.script({ waitMs: 8000, reasoning, text: "", chunkSize: 200, hang: true });
  await sendText(ann.page, agent.name, `宇宙的答案是什么？ ${tag}`);

  const bubble = streamingBubble(chat);
  await expect(bubble).toContainText("正在思考…");
  await expect(bubble.locator("details.thinking")).toHaveCount(0);
  await shot(ann.page, "agent-chat-thinking-line");

  await modelStub.holding(1);
  const thinking = bubble.locator("details.thinking");
  await expect(thinking).toHaveAttribute("open", "");
  await expect(thinking.locator("summary")).toHaveText(/^正在思考…( \d+ 秒)?$/);
  await expect(thinking.locator(".thinking-text")).toHaveText(reasoning);
  await shot(ann.page, "agent-chat-thinking-open");

  await modelStub.release(answer);
  const reply = agentMessagesWith(chat, answer);
  await expect(reply).toHaveCount(1);
  await expect(reply).toHaveAttribute("data-msg", /^m\d+$/);
  await expect(reply.locator("details.thinking summary")).toHaveText("思考过程");
  await expect(reply.locator("details.thinking")).not.toHaveAttribute("open", "");
});
