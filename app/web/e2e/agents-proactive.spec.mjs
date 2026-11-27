// Batch 2D in a real browser against the real service: an Agent whose owner turned 主动参与群聊 on replies in a group to
// a message that did not @ it, when the judgement model — the local judgement stub (support/judge-stub.mjs), whose rules
// pick the Agent for a message about 川菜 and hear 别插话 as a request for quiet — picks it. Its owner's copy of the reply
// says so (` · 主动回复` on the model line under it); a member's shows no such line, and nothing the member's browser
// receives says so. Asked to keep out of it, the Agent goes quiet and the group is told; chit-chat gets no reply.
import { test, expect } from "./support/fixtures.mjs";
import { befriend, createGroupApi, uniq } from "./support/accounts.mjs";
import { agentMessagesWith, createAgentUi, messageList, openChat, sendText } from "./support/app.mjs";
import { canControlService } from "./support/control.mjs";
import { HUSH, ON_TOPIC, judgeStub, judgedLine } from "./support/judge-stub.mjs";
import { modelStub } from "./support/model-stub.mjs";

test.beforeEach(async () => {
  test.skip(!canControlService, "needs the local service, its model stub and its judgement stub");
  await modelStub.reset();
  await judgeStub.reset();
});

/** The notices of the open conversation that contain `text`. */
const notices = (chat, text) => messageList(chat).locator("li.msg-system").filter({ hasText: text });

/**
 * Everything `context`'s pages receive from now on that comes from the service: every WebSocket frame, and the body of
 * every answer under `/api/` (each `url\nbody`). `api()` waits for the bodies still being read.
 */
function recordTraffic(context) {
  const bodies = [];
  const frames = [];
  const reading = [];
  const watch = (page) => {
    page.on("response", (response) => {
      if (!new URL(response.url()).pathname.startsWith("/api/")) return;
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
    async api() {
      await Promise.all(reading);
      return bodies;
    },
  };
}

test("an Agent replies unasked when the judgement picks it: its owner sees ` · 主动回复`, a member sees and receives nothing of it; asked to keep out, it goes quiet and the group is told; chit-chat gets no reply", async ({ people }) => {
  const ann = await people.member("Ann");
  const cy = await people.member("Cy");
  // Bo's browser is watched from its first request.
  const bo = await people.member("Bo", { open: false });
  await befriend(ann, bo);
  await befriend(ann, cy);
  const traffic = recordTraffic(bo.context);
  bo.page = await people.openApp(bo);

  // Ann creates her Agent with 主动参与群聊 on: the switch is offered because the site has a judgement model.
  const tag = uniq(6);
  const name = `川小厨${uniq(4)}`;
  const personaMark = `PANDA${tag}`;
  await createAgentUi(ann.page, {
    name,
    intro: "帮大家找好吃的",
    field: "川菜馆",
    persona: `你是川小厨，熟悉成都的馆子。暗号 ${personaMark}。`,
    onFilled: async (form) => {
      const proactive = form.getByRole("switch", { name: "主动参与群聊" });
      await expect(proactive).not.toBeChecked();
      await expect(form).toContainText("打开后，群里有人说到擅长领域里的事，没人 @ 也可能回复。花的是你的点。");
      await proactive.check();
      await expect(form.getByLabel("话多话少", { exact: true })).toHaveAttribute("value", "normal");
      // No daily budget of its own: the owner's one number for others' use covers its proactive replies.
      await expect(form.getByLabel("主动回复每天最多花", { exact: true })).toHaveCount(0);
    },
  });
  const { agents } = await (await ann.request.get("/api/agents")).json();
  const agent = agents.find((a) => a.name === name);
  expect(agent, "the Agent Ann created").toBeDefined();
  expect({ proactive: agent.proactive, proactiveLevel: agent.proactiveLevel }).toEqual({ proactive: true, proactiveLevel: "normal" });
  expect(agent).not.toHaveProperty("proactiveBudget");

  // Ann's group with Bo and Cy, her Agent in it.
  const title = `吃饭群${uniq(4)}`;
  const groupId = await createGroupApi(ann, [bo, cy], title);
  const added = await ann.request.post(`/api/conversations/${groupId}/members`, { data: { principalId: agent.id } });
  expect(added.status(), await added.text()).toBe(201);
  const annChat = await openChat(ann.page, title);
  const boChat = await openChat(bo.page, title);
  await expect(notices(boChat, `邀请${name}加入了群聊`)).toHaveCount(1);

  // Bo asks about 川菜 without @: the judgement picks the Agent, which replies — on both pages.
  const answer = `巷子口那家老馆子的水煮鱼不错 ${tag}`;
  await modelStub.reply(answer);
  const question = `周末想吃${ON_TOPIC}，有推荐的馆子吗 ${tag}`;
  expect(question).not.toContain("@");
  await sendText(bo.page, title, question);
  for (const chat of [annChat, boChat]) await expect(agentMessagesWith(chat, answer)).toHaveCount(1);
  // It was judged once, about Bo's message, shown no persona; one model call wrote the reply.
  const asked = await judgeStub.judged(question);
  expect(Object.keys(asked.body.questions.pick.criteria)).toEqual(["a1", "nobody"]);
  expect(asked.body.questions.pick.criteria.a1).toContain(name);
  expect(JSON.stringify(await judgeStub.requests())).not.toContain(personaMark);
  expect(await modelStub.calls()).toHaveLength(1);

  // Ann's copy says it was unasked, at the end of the model line under it; Bo's has no such line at all.
  await expect(agentMessagesWith(annChat, answer).locator(".msg-via")).toHaveText(/^演示快速模型 · .* · 主动回复$/);
  await expect(agentMessagesWith(boChat, answer).locator(".msg-via")).toHaveCount(0);
  await expect(boChat).not.toContainText("主动回复");

  // Bo tells it to keep out: it goes quiet, and both pages show the notice.
  const hush = `你先${HUSH}了，我们自己商量 ${tag}`;
  await sendText(bo.page, title, hush);
  const notice = `「${name}」暂时不主动发言，需要时可以 @ 一下`;
  for (const chat of [annChat, boChat]) await expect(notices(chat, notice)).toHaveCount(1);
  const quieted = await judgeStub.judged(hush);
  expect(quieted.answer.answers.q_a1).toEqual({ noul: 0.95 });

  // Chit-chat: judged, nobody picked, no reply (nothing more asked of the model).
  const chat = `今天天气真不错 ${tag}`;
  await sendText(bo.page, title, chat);
  const chatted = await judgeStub.judged(chat);
  expect(chatted.answer.answers.pick.choice).toBe("nobody");
  await ann.page.waitForTimeout(2000);
  expect(await modelStub.calls(), "one model call, for the one reply").toHaveLength(1);
  for (const [page, pane] of [
    [ann.page, annChat],
    [bo.page, boChat],
  ]) {
    const fromAgent = messageList(pane).locator("li.msg").filter({ has: page.locator(".msg-meta strong").filter({ hasText: name }) });
    await expect(fromAgent, "the Agent's messages in the group").toHaveCount(1);
  }
  expect((await judgeStub.requests()).map(judgedLine).filter((l) => l.includes(tag))).toHaveLength(3);

  // A fresh load: the service's answers (/api/sync) carry the reply to Bo's browser as it reads now, its run charged
  // (its owner's copy now has `via`), and are looked at below with the pushes.
  await bo.page.reload();
  const boAgain = await openChat(bo.page, title);
  await expect(agentMessagesWith(boAgain, answer)).toHaveCount(1);
  await expect(boAgain).not.toContainText("主动回复");

  // Nothing Bo's browser received from the service says the reply was unasked, or that the Agent may reply so: no frame,
  // no answer. (The one word of it a member may receive is the site's own flag, `proactiveAvailable`, the same for
  // everyone, of `GET /api/models`.)
  const replies = traffic.frames.filter((f) => f.includes(answer));
  expect(replies.length, "pushes of the reply Bo received").toBeGreaterThan(0);
  for (const frame of traffic.frames) expect(frame.includes("proactive"), frame.slice(0, 200)).toBe(false);
  const answers = await traffic.api();
  expect(answers.some((b) => b.includes(answer)), "an answer of the service (its sync) carried the reply").toBe(true);
  for (const body of answers) expect(body.replaceAll('"proactiveAvailable":true', "").includes("proactive"), body.slice(0, 200)).toBe(false);
});
