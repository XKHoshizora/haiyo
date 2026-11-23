// @vitest-environment jsdom
// B9a and B9b: the use page of others' use of my Agents (Settings › 别人怎么用我的 Agent), its row and its section on the usage page, the Agent
// card and page's three states, and the one-time notice at the top of 我的 Agent. Everything shown is the service's (`GET /api/me/others-use`):
// the web only words it, and never compares what was used with a limit.
import "./markdown-ready.js";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { AG1, MODELS, PRINCIPALS, agentConv, agentOf, agentPrincipal, apiError, syncOf, usageOf } from "./fixtures.js";
import { click, flush, inMain, installBrowser, mainText, openApp } from "./harness.jsx";
import { OTHERS_STATES, othersNoticeText, othersStateOf } from "../src/data/othersCopy.js";

beforeEach(() => installBrowser());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const MEI = { id: "00000000-0000-4000-8000-0000000000c1", handle: "mei", displayName: "小美", avatarVersion: 0 };
const KEN = { id: "00000000-0000-4000-8000-0000000000c2", handle: "ken", displayName: "阿健", avatarVersion: 0 };
const NAME = "别人怎么用我的 Agent";
const SITE_MODEL = { source: "site", id: "free-1" };

/** The route's answer for an owner with one Agent; `over` replaces any part. */
const useOf = (over = {}) => ({
  limits: { answers: 50, points: "70" },
  used: { answers: 3, points: "12.5" },
  reached: false,
  tight: false,
  byPerson: [{ person: MEI, answers: 2, points: "8" }, { person: KEN, answers: 1, points: "4.5" }],
  stopped: [],
  agents: [{ agentId: AG1, answers: 3, points: "12.5", perDay: 41, reached: false, tight: false }],
  notice: false,
  ...over,
});

const rail = (name) => within(screen.getByRole("navigation", { name: "主导航" })).getByRole("button", { name });
const inList = () => within(document.querySelector(".list-col"));
const listText = () => document.querySelector(".list-col").textContent;
const mainEl = () => document.querySelector(".main-col");

/** The app with one Agent of mine; the use route answers `answer()` (a function, so a test can change what it says). */
async function openWith({ social, answer = () => useOf(), api = {} } = {}) {
  const agent = agentOf(AG1, { model: SITE_MODEL, groupMentions: "members" });
  const principals = [...PRINCIPALS, agentPrincipal(AG1)];
  const sync = () => ({ ...syncOf([agentConv(agent.conversationId, AG1)], [], principals), ...(social === undefined ? {} : { social }) });
  const calls = {
    getOthersUse: vi.fn(async () => structuredClone(answer())),
    putOthersLimits: vi.fn(async (body) => body),
    putBar: vi.fn(async () => ({ ok: true, ended: 0 })),
    deleteBar: vi.fn(async () => ({ ok: true })),
    seenOthersNotice: vi.fn(async () => ({ ok: true })),
    getModels: vi.fn(async () => MODELS),
    listProviders: vi.fn(async () => ({ providers: [] })),
    getUsage: vi.fn(async () => usageOf()),
    listAgents: vi.fn(() => new Promise(() => {})),
    ...api,
  };
  const app = await openApp({ sync, api: calls, handlers: { agents: () => ({ agents: [agent] }), models: () => MODELS } });
  return { app, calls };
}
const goSettings = async () => {
  fireEvent.click(rail(/^设置/));
  await flush();
};
const openPage = async (options) => {
  const made = await openWith(options);
  await goSettings();
  await click(inList().getByText(NAME, { selector: ".row-name" }));
  return made;
};
const goAgents = async () => {
  fireEvent.click(rail(/^Agent/));
  await flush();
};
const answersBox = () => inMain().getByLabelText("每天最多回复的次数");
const pointsBox = () => inMain().getByLabelText("每天最多花的点数");
const enter = (box) => fireEvent.keyDown(box, { key: "Enter" });

describe("the three states, in one place", () => {
  it("normal, tight and reached, exactly as the owner confirms them; reached first, as it implies tight", () => {
    expect(OTHERS_STATES).toEqual({ ok: "正常", tight: "快用完了，较长的回复可能发不出", reached: "今天的额度用完了" });
    expect(othersStateOf({ reached: false, tight: false })).toBe("ok");
    expect(othersStateOf({ reached: false, tight: true })).toBe("tight");
    expect(othersStateOf({ reached: true, tight: true })).toBe("reached");
    expect(othersStateOf({ reached: true })).toBe("reached");
    expect(othersStateOf(null)).toBe("ok");
  });
});

describe("the settings row and the page", () => {
  it("a row 「别人怎么用我的 Agent」 opens the page: its title, one h2, the address and the document's title", async () => {
    await openPage();
    expect(window.location.pathname).toBe("/settings/others");
    expect(document.title).toBe(`${NAME} · 设置 · Haiyo`);
    expect([...mainEl().querySelectorAll("h2")].map((h) => h.textContent)).toEqual([NAME]);
  });

  it("the sentence with the owner's two numbers; the Agent's per-day line; today's use", async () => {
    const { calls } = await openPage();
    expect(calls.getOthersUse).toHaveBeenCalled();
    expect(answersBox().value).toBe("50");
    expect(pointsBox().value).toBe("70");
    const sentence = answersBox().closest("p").textContent;
    expect(sentence).toBe("别人每天最多让我的 Agent 回复次，最多花我点");
    const text = mainText();
    expect(text).toContain("小助手：以这个数，每天大约能回别人 41 次");
    expect(text).toContain("已回 3 次，花了 12.5 点");
    expect(text).toContain("小美");
    expect(text).toContain("@mei · 回了 2 次，花了 8 点");
    expect(text).toContain("阿健");
  });

  it("each number is saved on Enter or on leaving the box, both together, once; unchanged or wrong numbers are not saved", async () => {
    // (The service keeps what it was given, as it does.)
    let limits = { answers: 50, points: "70" };
    const { calls } = await openPage({
      answer: () => useOf({ limits }),
      api: { putOthersLimits: vi.fn(async (body) => (limits = body)) },
    });
    fireEvent.change(answersBox(), { target: { value: "20" } });
    enter(answersBox());
    await flush();
    expect(calls.putOthersLimits).toHaveBeenCalledTimes(1);
    expect(calls.putOthersLimits).toHaveBeenLastCalledWith({ answers: 20, points: "70" });
    fireEvent.change(pointsBox(), { target: { value: " 035.50 " } });
    fireEvent.blur(pointsBox());
    await flush();
    expect(calls.putOthersLimits).toHaveBeenCalledTimes(2);
    expect(calls.putOthersLimits).toHaveBeenLastCalledWith({ answers: 20, points: "35.5" });
    // Nothing typed that differs: no write. A wrong number: said under the sentence, no write.
    fireEvent.blur(pointsBox());
    await flush();
    expect(calls.putOthersLimits).toHaveBeenCalledTimes(2);
    fireEvent.change(answersBox(), { target: { value: "0" } });
    enter(answersBox());
    await flush();
    expect(calls.putOthersLimits).toHaveBeenCalledTimes(2);
    expect(mainText()).toContain("请填写 1 到 1000 之间的整数");
    expect(answersBox().getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(answersBox(), { target: { value: "20" } });
    fireEvent.change(pointsBox(), { target: { value: "100001" } });
    fireEvent.blur(pointsBox());
    await flush();
    expect(calls.putOthersLimits).toHaveBeenCalledTimes(2);
    expect(mainText()).toContain("请填写 1 到 100000 之间的点数（最多 6 位小数）");
  });

  it("an Enter that confirms an input method's candidate saves nothing", async () => {
    const { calls } = await openPage();
    fireEvent.change(answersBox(), { target: { value: "20" } });
    fireEvent.keyDown(answersBox(), { key: "Enter", isComposing: true });
    fireEvent.keyDown(answersBox(), { key: "Enter", keyCode: 229 });
    await flush();
    expect(calls.putOthersLimits).not.toHaveBeenCalled();
  });

  it("a refusal of the save is said under the sentence", async () => {
    const { calls } = await openPage({ api: { putOthersLimits: vi.fn(async () => { throw apiError(429, "rate_limited"); }) } });
    fireEvent.change(answersBox(), { target: { value: "20" } });
    enter(answersBox());
    await flush();
    expect(calls.putOthersLimits).toHaveBeenCalledTimes(1);
    expect(mainEl().querySelector(".others-limit-sentence [role='alert']")?.textContent).toBeTruthy();
  });

  it("the three states are the service's: overall and per Agent, never counted from used and the limit", async () => {
    const states = [
      [{ reached: false, tight: false }, "正常"],
      [{ reached: false, tight: true }, "快用完了，较长的回复可能发不出"],
      [{ reached: true, tight: true }, "今天的额度用完了"],
    ];
    for (const [flags, words] of states) {
      // Used far over the limit with `reached` false, and the other way: the words follow the flags alone.
      await openPage({ answer: () => useOf({ ...flags, used: { answers: 9999, points: "9999" }, agents: [{ agentId: AG1, answers: 1, points: "1", perDay: 5, ...flags }] }) });
      const text = mainText();
      expect(text.split(words).length - 1, words).toBe(2);
      for (const other of Object.values(OTHERS_STATES).filter((w) => w !== words)) expect(text, other).not.toContain(other);
      cleanup();
    }
  });

  it("an Agent the route says nothing of is listed by nothing; an owner with no Agent is told so", async () => {
    await openPage({ answer: () => useOf({ agents: [] }) });
    expect(mainText()).toContain("你还没有可以回复别人的 Agent。");
  });

  it("nobody used them today: it says so; the numbers still show", async () => {
    await openPage({ answer: () => useOf({ byPerson: [], used: { answers: 0, points: "0" } }) });
    expect(mainText()).toContain("今天还没有别人用过你的 Agent。");
    expect(answersBox().value).toBe("50");
  });

  it("an unreadable page says so and offers a retry that reads it again", async () => {
    let fail = true;
    const { calls } = await openPage({
      answer: () => {
        if (fail) throw apiError(500, "internal");
        return useOf();
      },
    });
    expect(mainText()).toContain("没能读取，请重试。");
    fail = false;
    await click(inMain().getByRole("button", { name: "重试" }));
    expect(calls.getOthersUse).toHaveBeenCalledTimes(2);
    expect(answersBox().value).toBe("50");
  });
});

describe("停止往来 and 恢复往来 (only while the site's Agent social switch is on)", () => {
  it("switch off (or not said): no 停止往来 and no 恢复往来 anywhere, no bar route called, and no stopped list while the route says none", async () => {
    for (const social of [undefined, { enabled: false }]) {
      const { calls } = await openPage({ social });
      const text = mainText();
      expect(text).not.toContain("停止往来");
      expect(text).not.toContain("恢复往来");
      expect(text).not.toContain("已停止往来的人");
      expect(calls.putBar).not.toHaveBeenCalled();
      expect(calls.deleteBar).not.toHaveBeenCalled();
      cleanup();
    }
  });

  it("switch off with a stopped list the service still names: the people are listed, without any control", async () => {
    await openPage({ social: { enabled: false }, answer: () => useOf({ stopped: [{ person: MEI, since: "2026-11-20T00:00:00.000Z" }] }) });
    expect(mainText()).toContain("已停止往来的人");
    expect(mainText()).toContain("小美");
    expect(inMain().queryByRole("button", { name: /往来/ })).toBeNull();
  });

  it("switch on: each person of today has 停止往来, which calls putBar for that person and reads the page again", async () => {
    let stopped = [];
    const { calls } = await openPage({
      social: { enabled: true },
      answer: () => useOf({ stopped, byPerson: stopped.length ? [{ person: KEN, answers: 1, points: "4.5" }] : useOf().byPerson }),
    });
    const stop = inMain().getByRole("button", { name: "停止往来：小美" });
    expect(inMain().getAllByRole("button", { name: /^停止往来：/ })).toHaveLength(2);
    stopped = [{ person: MEI, since: "2026-11-20T00:00:00.000Z" }];
    await click(stop);
    expect(calls.putBar).toHaveBeenCalledTimes(1);
    expect(calls.putBar).toHaveBeenCalledWith(MEI.id);
    expect(calls.getOthersUse).toHaveBeenCalledTimes(2);
    // She is in the stopped list now, with 恢复往来.
    expect(inMain().getByRole("button", { name: "恢复往来：小美" })).toBeTruthy();
    expect(inMain().queryByRole("button", { name: "停止往来：小美" })).toBeNull();
  });

  it("switch on: 恢复往来 calls deleteBar for that person; with nobody stopped the list says so", async () => {
    let stopped = [{ person: MEI, since: "2026-11-20T00:00:00.000Z" }];
    const { calls } = await openPage({ social: { enabled: true }, answer: () => useOf({ stopped }) });
    stopped = [];
    await click(inMain().getByRole("button", { name: "恢复往来：小美" }));
    expect(calls.deleteBar).toHaveBeenCalledWith(MEI.id);
    expect(mainText()).toContain("你没有停止过和谁的往来。");
  });

  it("a refusal is said under that person and nothing else changes", async () => {
    const { calls } = await openPage({ social: { enabled: true }, api: { putBar: vi.fn(async () => { throw apiError(404, "not_found"); }) } });
    await click(inMain().getByRole("button", { name: "停止往来：小美" }));
    expect(calls.putBar).toHaveBeenCalledTimes(1);
    expect(mainEl().querySelector(".others-people .field-msg")?.textContent).toBeTruthy();
    expect(inMain().getByRole("button", { name: "停止往来：小美" })).toBeTruthy();
  });
});

describe("the usage page's section", () => {
  it("one line of today's use and its state, and a link to the page", async () => {
    await openWith({ answer: () => useOf({ tight: true }) });
    await goSettings();
    await click(inList().getByText("用量与余额", { selector: ".row-name" }));
    const section = mainEl().querySelector(".others-usage");
    expect(section.querySelector("h3").textContent).toBe("别人的使用");
    expect(section.textContent).toContain("今天别人已回 3 次，花了 12.5 点 · 快用完了，较长的回复可能发不出");
    await click(within(section).getByRole("link", { name: NAME }));
    expect(window.location.pathname).toBe("/settings/others");
  });
});

describe("the Agent's card and page", () => {
  it("the card says 今天的额度用完了 only when reached; the page says all three states from the service's flags", async () => {
    for (const [flags, words, card] of [
      [{ reached: false, tight: false }, "正常", false],
      [{ reached: false, tight: true }, "快用完了，较长的回复可能发不出", false],
      [{ reached: true, tight: true }, "今天的额度用完了", true],
    ]) {
      await openWith({ answer: () => useOf({ agents: [{ agentId: AG1, answers: 1, points: "1", perDay: 5, ...flags }] }) });
      await goAgents();
      expect(listText().includes("今天的额度用完了"), words).toBe(card);
      await click(inList().getByText("小助手", { selector: ".row-name" }));
      cleanup();
    }
  });

  it("the page's rows name the state next to what others used today", async () => {
    const agent = agentOf(AG1, { model: SITE_MODEL, othersLimit: { answers: null, points: null }, othersUsedToday: { answers: 3, points: "12.5" } });
    const sync = () => syncOf([agentConv(agent.conversationId, AG1)], [], [...PRINCIPALS, agentPrincipal(AG1)]);
    await openApp({
      sync,
      api: {
        getOthersUse: vi.fn(async () => useOf({ agents: [{ agentId: AG1, answers: 3, points: "12.5", perDay: 5, reached: false, tight: true }] })),
        getModels: vi.fn(async () => MODELS),
        listProviders: vi.fn(async () => ({ providers: [] })),
        getUsage: vi.fn(async () => usageOf()),
        listAgents: vi.fn(() => new Promise(() => {})),
      },
      handlers: { agents: () => ({ agents: [agent] }), models: () => MODELS },
    });
    await goAgents();
    await click(inList().getByText("小助手", { selector: ".row-name" }));
    expect(document.querySelector(".main-col .kv").textContent).toContain("别人今天的使用已回 3 次，花了 12.5 点 · 快用完了，较长的回复可能发不出");
  });
});

describe("the one-time notice at the top of 我的 Agent", () => {
  const NOTICE = "别人让你的 Agent 回复，现在按人算：你所有的 Agent 加起来，每天最多回别人 50 次、最多花你 70 点，没人叫它时的主动回复也算在里面。Agent 自己的上限和主动回复的上限，原来是 20 点的，都已经提到 70 点。";
  const noticeEl = () => document.querySelector(".others-notice");

  it("its text is exactly the copy, with the owner's two numbers, says what changed and never says it stayed the same; system UI, not a chat message", async () => {
    await openWith({ answer: () => useOf({ notice: true }) });
    await goAgents();
    expect(noticeEl().textContent).toContain(NOTICE);
    expect(othersNoticeText({ answers: 50, points: "70" })).toBe(NOTICE);
    expect(noticeEl().textContent).not.toContain("不变");
    expect(within(noticeEl()).getByRole("button", { name: "知道了" })).toBeTruthy();
    expect(document.querySelector(".chat")).toBeNull();
  });

  it("the owner's own numbers are in it (a changed number, grouped digits)", async () => {
    await openWith({ answer: () => useOf({ notice: true, limits: { answers: 120, points: "1500.5" } }) });
    await goAgents();
    expect(noticeEl().textContent).toContain("每天最多回别人 120 次、最多花你 1,500.5 点");
  });

  it("shown once: 知道了 tells the service and the notice goes; it is not there when the service says no", async () => {
    let notice = true;
    const { calls } = await openWith({ answer: () => useOf({ notice }) });
    await goAgents();
    notice = false;
    await click(within(noticeEl()).getByRole("button", { name: "知道了" }));
    expect(calls.seenOthersNotice).toHaveBeenCalledTimes(1);
    expect(noticeEl()).toBeNull();
    cleanup();
    await openWith({ answer: () => useOf({ notice: false }) });
    await goAgents();
    expect(noticeEl()).toBeNull();
  });

  it("when the service cannot take 知道了, the notice stays and a toast says so", async () => {
    await openWith({ answer: () => useOf({ notice: true }), api: { seenOthersNotice: vi.fn(async () => { throw apiError(500, "internal"); }) } });
    await goAgents();
    await click(within(noticeEl()).getByRole("button", { name: "知道了" }));
    expect(noticeEl()).not.toBeNull();
  });
});
