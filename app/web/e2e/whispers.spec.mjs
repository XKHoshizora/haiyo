// Whispers (悄悄话) born of an Agent's tools, in real browsers against the real service, the model being the local stub
// (support/model-stub.mjs): "not here, but I have it elsewhere" (found_elsewhere: only the owner sees it, folded to one line
// that opens to what was found; 告诉他们 makes the Agent say it in the group without where or who, quoting the question; a
// tell that posts nothing leaves it open, to try again), a provider that cannot use tools (tools_off),
// and the money reminder of a reply that used the allowance up. What a member's browser received is recorded from its first
// request: for them none of it exists, not in the page, not in a frame, not in an answer of the service.
import { test, expect } from "./support/fixtures.mjs";
import { befriend, grantPoints, sendApi, uniq } from "./support/accounts.mjs";
import { agentMessagesWith, chatPane, listRow, messageList, openChat, sendText } from "./support/app.mjs";
import { canControlService } from "./support/control.mjs";
import { modelStub } from "./support/model-stub.mjs";
import { addApi, agentApi, groupApi, hanTag, recordTraffic } from "./support/tools.mjs";

test.beforeEach(async () => {
  test.skip(!canControlService, "needs the local service and its model stub");
  await modelStub.reset();
});

const searchFor = (word) => [{ name: "search_messages", input: { query: word } }];
/** The whispers of an open conversation (`li.msg-whisper`), and the dot that marks a conversation in the list. */
const whispers = (chat) => messageList(chat).locator("li.msg-whisper");
const whisperDot = (page, title) => listRow(page, title).first().getByRole("img", { name: "有只给你的悄悄话" });

const ELSEWHERE_TEXT = "在别处查到了相关内容，要告诉他们吗？";
/** The one line a found_elsewhere whisper is folded to, which opens it. */
const FOLDED = (n) => `在别处查到了 ${n} 条，要告诉他们吗？`;
const TELL_FAILED = "刚才没发出去，可以再试一次。";
/** Opens a folded found_elsewhere whisper (`n` hits): what it found and its buttons show. */
async function unfold(whisper, n = 1) {
  await whisper.getByRole("button", { name: FOLDED(n) }).click();
  await expect(whisper.getByRole("button", { name: "收起" })).toBeVisible();
}
const TOOLS_OFF_TEXT = "这个模型不支持查东西，已改为普通聊天。可以在模型设置里重新打开再试。";

/**
 * Ann's Agent in two groups: G (Ann, Bo, Cy — Bo's browser is recorded from its first request) and H (Ann, Dee, Eve), where
 * Dee said `hitText` (holding `word`, the search word) in a group that has a title of its own (`hTitle`): what is found
 * elsewhere when the Agent searches G for `word`. `canaries` are what only H's members may ever read. Pages are open on G.
 */
async function elsewhereWorld(people) {
  const ann = await people.member("Ann", { open: false });
  const bo = await people.member("Bo", { open: false });
  const cy = await people.member("Cy", { open: false });
  const dee = await people.member("Dee", { open: false, displayName: `蒂${hanTag(3)}${uniq(3)}` });
  const eve = await people.member("Eve", { open: false });
  for (const friend of [bo, cy, dee, eve]) await befriend(ann, friend);
  const agent = await agentApi(ann, { name: `查查${uniq(4)}` });
  const g = await groupApi(ann, [bo, cy]);
  const hTitle = `内部群${hanTag(3)}${uniq(3)}`;
  const h = await groupApi(ann, [dee, eve], hTitle);
  await addApi(ann, g.id, agent.id);
  await addApi(ann, h.id, agent.id);
  const word = hanTag(4);
  const hitText = `周六的${word}聚会定在老地方，每人带一个菜 ${uniq(4)}`;
  await sendApi(dee, h.id, hitText);
  const traffic = recordTraffic(bo.context);
  for (const person of [ann, bo, cy]) person.page = await people.openApp(person);
  const annChat = await openChat(ann.page, g.title);
  const boChat = await openChat(bo.page, g.title);
  return { ann, bo, cy, dee, agent, g, h, word, hitText, hTitle, annChat, boChat, traffic, canaries: [hTitle, dee.displayName, hitText] };
}

/** Bo's call on the Agent in G (the words he asks with are none of the search's: they are in no message of H). */
const ask = (world, tag) => sendText(world.bo.page, world.g.title, `@${world.agent.handle} 周六有什么安排吗？${tag}`);

/**
 * Once Ann's page has what she is to see, the same moment is waited for on Bo's: a message of Ann's that comes after it
 * reached Bo (frames of one socket come in order), so that nothing meant for him is still on its way.
 */
async function bothCaughtUp(world) {
  const marker = `都收到了 ${uniq(6)}`;
  await sendApi(world.ann, world.g.id, marker);
  await expect(chatPane(world.bo.page, world.g.title)).toContainText(marker);
}

// --- 1. "not here, but elsewhere": the owner's, with what was found -------------------------------------------------------

test("a group search that finds nothing, while the Agent has it elsewhere, leaves a whisper for its owner only: the bubble with what was found, the dot in the list; nothing of it for a member, in the page or in any frame", async ({ people }) => {
  const world = await elsewhereWorld(people);
  const { ann, bo, annChat, boChat, g, word, hitText, hTitle, dee, traffic, canaries } = world;
  const tag = uniq(4);
  const answer = `这个群里没有查到。${tag}`;
  await modelStub.callTools(searchFor(word));
  await modelStub.reply(answer);
  await ask(world, tag);
  for (const chat of [annChat, boChat]) await expect(agentMessagesWith(chat, answer)).toHaveCount(1);

  // Ann: a bubble only she sees, folded to one line; opened, it says what it is and what was found (where · who · when, then
  // the text), and has the two buttons; the list marks the group with a dot.
  const whisper = whispers(annChat);
  await expect(whisper).toHaveCount(1);
  await expect(whisper.getByRole("note", { name: "只有你能看到" })).toBeVisible();
  await expect(whisper).toHaveText(FOLDED(1));
  await expect(whisper.locator(".whisper-hit")).toHaveCount(0);
  await expect(whisper.getByRole("button", { name: "告诉他们", exact: true })).toHaveCount(0);
  await unfold(whisper);
  await expect(whisper).toContainText(ELSEWHERE_TEXT);
  const hit = whisper.locator(".whisper-hit");
  await expect(hit).toHaveCount(1);
  await expect(hit.locator(".whisper-hit-meta")).toHaveText(new RegExp(`^${hTitle} · ${dee.displayName} · \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}$`));
  await expect(hit.locator(".whisper-hit-text")).toHaveText(hitText);
  await expect(whisper.getByRole("button", { name: "告诉他们" })).toBeEnabled();
  await expect(whisper.getByRole("button", { name: "不用" })).toBeEnabled();
  await expect(whisperDot(ann.page, g.title)).toBeVisible();

  // Bo: no bubble, no dot, no word of it in anything his browser received since it opened.
  await bothCaughtUp(world);
  await expect(whispers(boChat)).toHaveCount(0);
  await expect(whisperDot(bo.page, g.title)).toHaveCount(0);
  await expect(bo.page.getByText("只有你能看到")).toHaveCount(0);
  await expect(bo.page.getByText("在别处查到了")).toHaveCount(0);
  const html = await bo.page.content();
  for (const secret of canaries) expect(html.includes(secret), `${secret} on Bo's page`).toBe(false);
  const frames = traffic.frames;
  expect(frames.length, "frames Bo received").toBeGreaterThan(0);
  expect(frames.filter((f) => /whisper/i.test(f)), "a whisper frame reached Bo").toEqual([]);
  const received = [...(await traffic.api()), ...frames].join("\n");
  for (const secret of canaries) expect(received.includes(secret), `${secret} reached Bo's browser`).toBe(false);
  for (const body of await traffic.api()) expect(/whisper/i.test(body), `a whisper in an answer Bo got: ${body.slice(0, 120)}`).toBe(false);
});

// --- 2. 告诉他们 ------------------------------------------------------------------------------------------------------------

test("告诉他们 while the Agent is still replying says 它正在回复，说完再点。 and keeps the buttons; after it, the Agent answers in the group in its own words, told neither where nor by whom, quoting the question", async ({ people }) => {
  const world = await elsewhereWorld(people);
  const { ann, annChat, boChat, word, hitText, hTitle, dee, traffic, canaries } = world;
  const tag = uniq(4);
  const first = `这个群里没有查到。${tag}`;
  const rest = `你们可以再问问。`;
  const told = `周六有个聚会，定在老地方，每人带个菜。${tag}`;
  await modelStub.callTools(searchFor(word));
  await modelStub.hangAfter(first);
  await modelStub.reply(told);
  await ask(world, tag);

  // The search has answered the model, which is writing its answer (held): the whisper is there, the Agent is replying.
  await modelStub.holding(1);
  const whisper = whispers(annChat);
  await expect(whisper).toHaveCount(1);
  await unfold(whisper);
  await whisper.getByRole("button", { name: "告诉他们" }).click();
  await expect(whisper.getByRole("alert")).toHaveText("它正在回复，说完再点。");
  await expect(whisper.getByRole("button", { name: "告诉他们" })).toBeEnabled();
  await expect(whisper.getByRole("button", { name: "不用" })).toBeEnabled();
  expect((await modelStub.calls()).length, "nothing was started by the refused click").toBe(2);

  // Its reply ends; the same click now starts the Agent's telling.
  await modelStub.release(rest);
  for (const chat of [annChat, boChat]) await expect(agentMessagesWith(chat, first + rest)).toHaveCount(1);
  await whisper.getByRole("button", { name: "告诉他们" }).click();
  for (const chat of [annChat, boChat]) await expect(agentMessagesWith(chat, told)).toHaveCount(1);
  await expect(whisper).toContainText("已告诉他们");
  await expect(whisper.getByRole("button")).toHaveCount(0);
  await expect(whisperDot(ann.page, world.g.title)).toHaveCount(0);
  // It is a reply to Bo's question, quoted (so it makes sense however long after it comes), for both of them.
  for (const chat of [annChat, boChat]) await expect(agentMessagesWith(chat, told).locator("blockquote")).toContainText(`周六有什么安排吗？${tag}`);

  // What the model was told to say it from: the owner's instruction, the sentence that it is material, and each hit's time and
  // text only; no tools; neither the other group's title nor the speaker's name anywhere in the request.
  const calls = await modelStub.calls();
  expect(calls.length).toBe(3);
  const request = calls[2];
  const system = request.body.messages.filter((m) => m.role === "system").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
  expect(system).toContain("主人让你把下面查到的内容告诉大家");
  expect(system).toContain("不要说是在哪里看到的，也不要说是谁说的");
  const hits = /\{"hits":\[.*?\]\}/s.exec(system);
  expect(hits, "the hits as JSON in the system text").not.toBeNull();
  const material = JSON.parse(hits[0]);
  expect(material.hits).toHaveLength(1);
  expect(Object.keys(material.hits[0]).sort()).toEqual(["text", "when"]);
  expect(material.hits[0].text).toBe(hitText);
  expect(material.hits[0].when).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  expect(request.body.tools ?? []).toEqual([]);
  const sent = JSON.stringify(request.body);
  expect(sent.includes(hTitle), "the other group's title in the told reply's request").toBe(false);
  expect(sent.includes(dee.displayName), "the speaker's name in the told reply's request").toBe(false);

  // Bo never received the title, the name or the hit's text, nor any whisper: only the Agent's telling.
  await bothCaughtUp(world);
  const received = [...(await traffic.api()), ...traffic.frames].join("\n");
  for (const secret of canaries) expect(received.includes(secret), `${secret} reached Bo's browser`).toBe(false);
  expect(traffic.frames.filter((f) => /whisper/i.test(f))).toEqual([]);
});

test("告诉他们 whose call fails: the whisper is open again for its owner — 刚才没发出去，可以再试一次。, the hits and both buttons; a member's page and frames show nothing of it; pressing 告诉他们 again posts the answer once", async ({ people }) => {
  const world = await elsewhereWorld(people);
  const { ann, annChat, boChat, word, hitText, traffic, canaries } = world;
  const tag = uniq(4);
  const first = `这个群里没有查到。${tag}`;
  const told = `周六有个聚会，定在老地方，每人带个菜。${tag}`;
  await modelStub.callTools(searchFor(word));
  await modelStub.reply(first);
  await ask(world, tag);
  for (const chat of [annChat, boChat]) await expect(agentMessagesWith(chat, first)).toHaveCount(1);
  const whisper = whispers(annChat);
  await expect(whisper).toHaveCount(1);
  await unfold(whisper);
  await expect(whisper).toContainText(hitText.slice(0, 12));
  await expect(whisper).not.toContainText(TELL_FAILED);

  // The telling's model call fails: nothing is posted, and the whisper is open again — saying so —, hits and buttons as before.
  // (A 400: a failure the system does not try again by itself — a 5xx it retries automatically while the whisper reads open.)
  await modelStub.script({ status: 400, message: "upstream refused" }, { status: 400, message: "upstream refused" });
  await whisper.getByRole("button", { name: "告诉他们" }).click();
  await expect.poll(async () => (await modelStub.calls()).length, { message: "the telling's call was made" }).toBeGreaterThanOrEqual(3);
  await expect(whisper).toHaveCount(1);
  await expect(whisper).not.toContainText("已告诉他们");
  await expect(whisper.getByRole("button", { name: "告诉他们" })).toBeEnabled({ timeout: 30_000 });
  await expect(whisper).toContainText(TELL_FAILED);
  await expect(whisper.getByRole("button", { name: "不用" })).toBeEnabled();
  await expect(whisper).toContainText(hitText.slice(0, 12));
  await expect(whisperDot(ann.page, world.g.title)).toHaveCount(1);
  await expect(agentMessagesWith(annChat, told)).toHaveCount(0);

  // Pressing it again tells, once.
  await modelStub.reset();
  await modelStub.reply(told);
  await whisper.getByRole("button", { name: "告诉他们" }).click();
  for (const chat of [annChat, boChat]) await expect(agentMessagesWith(chat, told)).toHaveCount(1);
  await expect(whisper).toContainText("已告诉他们");
  await expect(whisper.getByRole("button")).toHaveCount(0);

  // Bo saw only the Agent's answers: no whisper, no hit's text, title or name, at any point.
  expect(traffic.frames.filter((f) => /lastTellFailed|telling/.test(f)), "the whisper's state reached Bo").toEqual([]);
  await bothCaughtUp(world);
  const received = [...(await traffic.api()), ...traffic.frames].join("\n");
  for (const secret of canaries) expect(received.includes(secret), `${secret} reached Bo's browser`).toBe(false);
  expect(traffic.frames.filter((f) => /whisper/i.test(f))).toEqual([]);
});

test("at phone width, an opened found-elsewhere whisper takes at most about half the screen: what it found scrolls inside it, its buttons stay in view", async ({ people }) => {
  const world = await elsewhereWorld(people);
  const { ann, annChat, dee, h, word } = world;
  // Four more long lines with the word in H: five hits, far taller than half a phone's screen.
  for (let i = 0; i < 4; i++) await sendApi(dee, h.id, `第${i}条：${word}${"这是一段很长很长的话，用来把这条悄悄话撑得很高。".repeat(8)}`);
  const tag = uniq(4);
  const answer = `这个群里没有查到。${tag}`;
  await modelStub.callTools(searchFor(word));
  await modelStub.reply(answer);
  await ask(world, tag);
  await expect(agentMessagesWith(annChat, answer)).toHaveCount(1);
  const whisper = whispers(annChat);
  await expect(whisper).toHaveCount(1);
  const phone = { width: 375, height: 812 };
  await ann.page.setViewportSize(phone);
  try {
    await unfold(whisper, 5);
    const bubble = whisper.locator(".whisper");
    const box = await bubble.boundingBox();
    expect(box.height, "the opened bubble's height at phone width").toBeLessThanOrEqual(phone.height / 2 + 1);
    const hits = whisper.locator(".whisper-hits");
    const scrolls = await hits.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight, overflow: getComputedStyle(el).overflowY }));
    expect(scrolls.overflow).toBe("auto");
    expect(scrolls.scroll, "what it found is taller than its room: it scrolls").toBeGreaterThan(scrolls.client);
    // Its buttons are in the bubble, not below it.
    await whisper.getByRole("button", { name: "告诉他们" }).scrollIntoViewIfNeeded();
    const tell = await whisper.getByRole("button", { name: "告诉他们" }).boundingBox();
    expect(tell.y + tell.height).toBeLessThanOrEqual(box.y + box.height + 1);
  } finally {
    await ann.page.setViewportSize({ width: 1280, height: 860 });
  }
});

// --- 3. a provider that cannot use tools -----------------------------------------------------------------------------------

test("a provider that rejects tools: the reply arrives all the same, the owner is told once by a whisper without buttons, and the next reply goes without tools", async ({ people }) => {
  const ann = await people.member("Ann");
  const modelName = `plain-e2e-${uniq(4)}`;
  const res = await ann.request.post("/api/providers", {
    data: { name: `prov-${uniq(6)}`, protocol: "openai_chat", baseUrl: modelStub.baseUrl, apiKey: `sk-e2e-${uniq(8)}-not-real`, models: [{ name: modelName }] },
  });
  expect(res.status(), await res.text()).toBe(201);
  const provider = await res.json();
  const agent = await agentApi(ann, { name: `老实${uniq(4)}`, model: { source: "provider", providerId: provider.id, model: modelName } });
  const chat = await openChat(ann.page, agent.name);
  const tag = uniq(4);
  const plain = `我不会查东西，直接回答你。${tag}`;
  await modelStub.rejectTools();
  await modelStub.reply(plain);
  await sendText(ann.page, agent.name, `帮我查一下今天的新闻 ${tag}`);
  await expect(agentMessagesWith(chat, plain)).toHaveCount(1);

  // The reply came from the second request (the first was refused, the second sent without the tools); the owner is told once.
  const [refused, again] = await modelStub.calls();
  expect(refused.body.tools?.length ?? 0).toBeGreaterThan(0);
  expect(again.body.tools ?? []).toEqual([]);
  const whisper = whispers(chat);
  await expect(whisper).toHaveCount(1);
  await expect(whisper).toContainText(TOOLS_OFF_TEXT);
  await expect(whisper.getByRole("button")).toHaveCount(0);
  await expect(whisper.getByRole("note", { name: "只有你能看到" })).toBeVisible();
  // The model is marked, on its owner's entry: its next reply is offered no tools, and says nothing more of it.
  await expect
    .poll(async () => {
      const list = await (await ann.request.get("/api/providers")).json();
      return list.providers.find((p) => p.id === provider.id)?.models.find((m) => m.name === modelName)?.tools;
    })
    .toBe(false);
  await modelStub.reply(`好的。${tag}`);
  await sendText(ann.page, agent.name, `那就算了 ${tag}`);
  await expect(agentMessagesWith(chat, `好的。${tag}`)).toHaveCount(1);
  const third = (await modelStub.calls())[2];
  expect(third.body.tools ?? []).toEqual([]);
  await expect(whispers(chat)).toHaveCount(1);
});

// --- 4. money -----------------------------------------------------------------------------------------------------------------

test("a member's call whose tool reply uses up its owner's free allowance still ends in its answer; the owner alone is told, in the Agent's own conversation, and the member sees nothing of it", async ({ people }) => {
  const ann = await people.member("Ann", { open: false });
  const bo = await people.member("Bo", { open: false });
  const cy = await people.member("Cy", { open: false });
  await befriend(ann, bo);
  await befriend(ann, cy);
  const agent = await agentApi(ann, { name: `查查${uniq(4)}` });
  const { id: groupId, title } = await groupApi(ann, [bo, cy]);
  await addApi(ann, groupId, agent.id);
  const word = hanTag(4);
  await sendApi(ann, groupId, `周五聚餐吃${word}火锅，晚上七点`);
  const traffic = recordTraffic(bo.context);
  for (const person of [ann, bo]) person.page = await people.openApp(person);

  // Ann's day's allowance (1 point) is nearly used by a reply of her Agent in their own conversation: 100 tokens in, 70 out is
  // 0.701 points at the free model's prices (support/system.mjs `siteModels`).
  const own = await openChat(ann.page, agent.name);
  await modelStub.reply("好的，收到。", { usage: { input: 100, output: 70 } });
  await sendText(ann.page, agent.name, `你好 ${uniq(4)}`);
  await expect(agentMessagesWith(own, "好的，收到。")).toHaveCount(1);
  await expect(whispers(own)).toHaveCount(0);

  // Bo calls the Agent in the group; its tool reply is two calls of 0.2002 points: the allowance is gone before it ends.
  const groupChat = await openChat(ann.page, title);
  const boChat = await openChat(bo.page, title);
  const tag = uniq(4);
  const answer = `聚餐定在周五晚上七点，吃火锅。${tag}`;
  const used = { usage: { input: 20, output: 20 } };
  await modelStub.callTools(searchFor(word), used);
  await modelStub.reply(answer, used);
  await sendText(bo.page, title, `@${agent.handle} 聚餐是什么时候？${tag}`);
  for (const chat of [groupChat, boChat]) await expect(agentMessagesWith(chat, answer)).toHaveCount(1);
  // The answer is whole, and it was the model's last call (what is left of the allowance covers no other round).
  const calls = await modelStub.calls();
  expect(calls).toHaveLength(3);
  expect(calls[2].body.tool_choice).toBe("none");

  // Ann is told in her Agent's own conversation (not in the group): once, as the product words it, no button.
  const ownAgain = await openChat(ann.page, agent.name);
  const reminder = whispers(ownAgain);
  await expect(reminder).toHaveCount(1);
  await expect(reminder).toContainText(/^[\s\S]*额度用完了，\d{1,2}月\d{1,2}日 \d\d:\d\d 恢复。$/);
  await expect(reminder.getByRole("button")).toHaveCount(0);
  await expect(whispers(chatPane(ann.page, title))).toHaveCount(0);

  // Bo is told nothing: not in his page, not in a frame, not in an answer of the service.
  await openChat(ann.page, title);
  await sendApi(ann, groupId, `都收到了 ${uniq(6)}`);
  await expect(boChat).toContainText("都收到了");
  await expect(whispers(boChat)).toHaveCount(0);
  const received = [...(await traffic.api()), ...traffic.frames].join("\n");
  expect(traffic.frames.filter((f) => /whisper/i.test(f))).toEqual([]);
  for (const body of await traffic.api()) expect(/whisper|额度用完了/i.test(body), body.slice(0, 120)).toBe(false);
  expect(received.includes("额度用完了")).toBe(false);
});

// --- 5. 不用 --------------------------------------------------------------------------------------------------------------------

test("不用 on a found-elsewhere whisper resolves it for the owner: 已忽略, no dot, nothing said in the group, no model call; a member's page and frames are as before", async ({ people }) => {
  const world = await elsewhereWorld(people);
  const { ann, bo, annChat, boChat, g, word, traffic, canaries } = world;
  const tag = uniq(4);
  const answer = `这个群里没有查到。${tag}`;
  await modelStub.callTools(searchFor(word));
  await modelStub.reply(answer);
  await ask(world, tag);
  await expect(agentMessagesWith(annChat, answer)).toHaveCount(1);
  const whisper = whispers(annChat);
  await expect(whisper).toHaveCount(1);
  await expect(whisperDot(ann.page, g.title)).toBeVisible();
  const before = await messageList(annChat).locator("li.msg").count();
  const framesBefore = traffic.frames.length;

  await unfold(whisper);
  await whisper.getByRole("button", { name: "不用" }).click();
  await expect(whisper).toContainText("已忽略");
  await expect(whisper.getByRole("button")).toHaveCount(0);
  await expect(whisperDot(ann.page, g.title)).toHaveCount(0);
  // Nothing was posted, nothing was asked of the model (two calls: the search round and its answer).
  await expect(messageList(annChat).locator("li.msg")).toHaveCount(before);
  expect((await modelStub.calls()).length).toBe(2);

  await bothCaughtUp(world);
  await expect(whispers(boChat)).toHaveCount(0);
  await expect(messageList(boChat).locator("li.msg")).toHaveCount(before + 1);
  // Only the marker message came to Bo since: no frame of a whisper, no canary.
  const since = traffic.frames.slice(framesBefore);
  expect(since.filter((f) => /whisper/i.test(f))).toEqual([]);
  const received = [...(await traffic.api()), ...traffic.frames].join("\n");
  for (const secret of canaries) expect(received.includes(secret), `${secret} reached Bo's browser`).toBe(false);
  expect(bo.page.isClosed()).toBe(false);
});

// --- 6. the balance --------------------------------------------------------------------------------------------------------------

test("an owner paying from a balance that a tool reply takes to zero is told 余额用完了。 once, in the Agent's own conversation; the member whose call it was sees nothing", async ({ people }) => {
  const ann = await people.member("Ann", { open: false });
  const bo = await people.member("Bo", { open: false });
  const cy = await people.member("Cy", { open: false });
  await befriend(ann, bo);
  await befriend(ann, cy);
  const agent = await agentApi(ann, { name: `查查${uniq(4)}`, model: { source: "site", id: "e2e-paid" } });
  const { id: groupId, title } = await groupApi(ann, [bo, cy]);
  await addApi(ann, groupId, agent.id);
  const word = hanTag(4);
  await sendApi(ann, groupId, `周五聚餐吃${word}火锅，晚上七点`);
  // The operator grants half a point: the paid model's two calls of 0.3002 points take it below zero.
  await grantPoints(ann, "0.5");
  const traffic = recordTraffic(bo.context);
  for (const person of [ann, bo]) person.page = await people.openApp(person);
  const groupChat = await openChat(ann.page, title);
  const boChat = await openChat(bo.page, title);
  const tag = uniq(4);
  const answer = `聚餐定在周五晚上七点，吃火锅。${tag}`;
  const used = { usage: { input: 20, output: 25 } };
  await modelStub.callTools(searchFor(word), used);
  await modelStub.reply(answer, used);
  await sendText(bo.page, title, `@${agent.handle} 聚餐是什么时候？${tag}`);
  for (const chat of [groupChat, boChat]) await expect(agentMessagesWith(chat, answer)).toHaveCount(1);

  const own = await openChat(ann.page, agent.name);
  const reminder = whispers(own);
  await expect(reminder).toHaveCount(1);
  await expect(reminder).toContainText("余额用完了。");
  await expect(reminder.getByRole("button")).toHaveCount(0);
  await expect(whispers(chatPane(ann.page, title))).toHaveCount(0);

  await openChat(ann.page, title);
  await sendApi(ann, groupId, `都收到了 ${uniq(6)}`);
  await expect(boChat).toContainText("都收到了");
  await expect(whispers(boChat)).toHaveCount(0);
  expect(traffic.frames.filter((f) => /whisper/i.test(f))).toEqual([]);
  for (const body of await traffic.api()) expect(/whisper|余额用完了/i.test(body), body.slice(0, 120)).toBe(false);
  expect([...traffic.frames].join("\n").includes("余额用完了")).toBe(false);
});
