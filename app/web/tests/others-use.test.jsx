// @vitest-environment jsdom
// B9a and B9b: the use page of others' use of my Agents (Settings › 别人怎么用我的 Agent), its row and its section on the usage page, the Agent
// card and page's three states, and the one-time notice at the top of 我的 Agent. Everything shown is the service's (`GET /api/me/others-use`):
// the web only words it, and never compares what was used with a limit. The page has NO stop and NO restore control of its own (that act lives
// on the person's profile): a person is a link there.
import "./markdown-ready.js";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { AG1, ANN, MODELS, PRINCIPALS, agentConv, agentOf, agentPrincipal, apiError, deferred, syncOf, usageOf } from "./fixtures.js";
import { click, flush, inMain, installBrowser, mainText, openApp, toastText } from "./harness.jsx";
import { OTHERS_STATES, othersNoticeText, othersStateOf } from "../src/data/othersCopy.js";
import { sinceText } from "../src/pages/OthersUse.jsx";
import { forgetOthersUse, readOthersUse, storeOf } from "../src/data/othersUseCache.js";

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
  limits: { answers: 50, points: "300" },
  used: { answers: 3, points: "12.5", proactivePoints: "0", proactiveAnswers: 0 },
  reached: false,
  tight: false,
  byPerson: [{ person: MEI, answers: 2, points: "8" }, { person: KEN, answers: 1, points: "4.5" }],
  stopped: [],
  agents: [{ agentId: AG1, answers: 3, points: "12.5", perDay: 41, reached: false, tight: false, canReply: true }],
  notice: false,
  ...over,
});

const rail = (name) => within(screen.getByRole("navigation", { name: "主导航" })).getByRole("button", { name });
const inList = () => within(document.querySelector(".list-col"));
const listText = () => document.querySelector(".list-col").textContent;
const mainEl = () => document.querySelector(".main-col");

/** The app with one Agent of mine; the use route answers `answer()` (a function, so a test can change what it says). */
async function openWith({ social, answer = () => useOf(), api = {}, agentFields = {} } = {}) {
  const agent = agentOf(AG1, { model: SITE_MODEL, groupMentions: "members", ...agentFields });
  const principals = [...PRINCIPALS, agentPrincipal(AG1)];
  const sync = () => ({ ...syncOf([agentConv(agent.conversationId, AG1)], [], principals), ...(social === undefined ? {} : { social }) });
  const calls = {
    getOthersUse: vi.fn(async () => structuredClone(answer())),
    putOthersLimits: vi.fn(async (body) => body),
    putBar: vi.fn(async () => ({ ok: true })),
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
const typeInto = (box, value) => fireEvent.change(box, { target: { value } });

describe("the three states, in one place", () => {
  it("normal, tight and reached, as the owner confirms them; reached first, as it implies tight; the third says it is OTHERS' use", () => {
    expect(OTHERS_STATES).toEqual({ ok: "正常", tight: "快用完了，长一点的回复可能发不出", reached: "今天给别人的额度用完了，明天恢复" });
    // The third says whose quota it is (what is given to OTHERS) and when it is back.
    expect(OTHERS_STATES.reached).toContain("给别人");
    expect(OTHERS_STATES.reached).toContain("明天恢复");
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
    expect(inList().getByText("别人每天最多能花你多少点")).toBeTruthy();
  });

  it("the sentence with the owner's two numbers (300 by default); the Agent's line cannot be summed; today's use with the proactive part", async () => {
    const { calls } = await openPage({ answer: () => useOf({ used: { answers: 3, points: "12.5", proactivePoints: "2", proactiveAnswers: 1 } }) });
    expect(calls.getOthersUse).toHaveBeenCalled();
    expect(answersBox().value).toBe("50");
    expect(pointsBox().value).toBe("300");
    expect(answersBox().closest("p").textContent).toBe("别人每天最多让我的 Agent 回复次，最多花我点");
    const text = mainText();
    // The Agent's line says what ONE Agent alone would give from the whole shared amount: it is not "this Agent's share".
    expect(text).toContain("小助手：额度全给它用的话，每天大约能回 41 次");
    expect(text).not.toContain("以这个数");
    // The people below were called twice and once: 3 answers; the proactive reply is counted once, shown, so the numbers add up.
    expect(text).toContain("已回别人 3 次（其中主动回复 1 次），花了 12.5 点（其中主动回复 2 点）");
    expect(text).toContain("今天回了别人 3 次（含主动回复），回应别人花了 12.5 点");
    expect(text).toContain("小美");
    expect(text).toContain("@mei · 回了对方 2 次，花了 8 点");
    expect(text).toContain("阿健");
    expect(mainEl().querySelector(".others-agents strong").textContent).toBe("小助手");
  });

  it("an Agent that cannot answer anybody says so, never 「大约能回 0 次 · 正常」", async () => {
    await openPage({ answer: () => useOf({ agents: [{ agentId: AG1, answers: 0, points: "0", perDay: 0, reached: false, tight: false, canReply: false }] }) });
    expect(mainText()).toContain("小助手：没有可用的模型，暂时不能回复");
    expect(mainText()).not.toContain("大约能回 0 次");
    expect(mainEl().querySelector(".others-agents").textContent).not.toContain("正常");
  });

  it("each number is saved on Enter or on leaving the box, both together, once; unchanged or wrong numbers are not saved", async () => {
    // (The service keeps what it was given, as it does.)
    let limits = { answers: 50, points: "300" };
    const { calls } = await openPage({ answer: () => useOf({ limits }), api: { putOthersLimits: vi.fn(async (body) => (limits = body)) } });
    typeInto(answersBox(), "20");
    enter(answersBox());
    await flush();
    expect(calls.putOthersLimits).toHaveBeenCalledTimes(1);
    expect(calls.putOthersLimits).toHaveBeenLastCalledWith({ answers: 20, points: "300" });
    typeInto(pointsBox(), " 035.50 ");
    fireEvent.blur(pointsBox());
    await flush();
    expect(calls.putOthersLimits).toHaveBeenCalledTimes(2);
    expect(calls.putOthersLimits).toHaveBeenLastCalledWith({ answers: 20, points: "35.5" });
    // What is shown is what is stored: the box shows the normal form of what was sent.
    expect(pointsBox().value).toBe("35.5");
    // Nothing typed that differs: no write. A wrong number: said under the sentence, nothing sent.
    fireEvent.blur(pointsBox());
    await flush();
    expect(calls.putOthersLimits).toHaveBeenCalledTimes(2);
    typeInto(answersBox(), "0");
    enter(answersBox());
    await flush();
    expect(calls.putOthersLimits).toHaveBeenCalledTimes(2);
    expect(mainText()).toContain("次数请填 1 到 1000 的整数");
    expect(answersBox().getAttribute("aria-invalid")).toBe("true");
    typeInto(answersBox(), "20");
    typeInto(pointsBox(), "100001");
    fireEvent.blur(pointsBox());
    await flush();
    expect(calls.putOthersLimits).toHaveBeenCalledTimes(2);
    expect(mainText()).toContain("点数请填 1 到 100000 的数");
    expect(pointsBox().getAttribute("aria-invalid")).toBe("true");
  });

  it("an Enter that confirms an input method's candidate saves nothing", async () => {
    const { calls } = await openPage();
    typeInto(answersBox(), "20");
    fireEvent.keyDown(answersBox(), { key: "Enter", isComposing: true });
    fireEvent.keyDown(answersBox(), { key: "Enter", keyCode: 229 });
    await flush();
    expect(calls.putOthersLimits).not.toHaveBeenCalled();
  });

  it("a refusal of the save is said under the sentence", async () => {
    const { calls } = await openPage({ api: { putOthersLimits: vi.fn(async () => { throw apiError(429, "rate_limited"); }) } });
    typeInto(answersBox(), "20");
    enter(answersBox());
    await flush();
    expect(calls.putOthersLimits).toHaveBeenCalledTimes(1);
    expect(mainEl().querySelector(".others-limit-sentence [role='alert']")?.textContent).toBeTruthy();
  });

  describe("I3: each box owns its draft, saves go one at a time, what is stored is what is shown (a slow server)", () => {
    /** A server that keeps the limits and answers each PUT when the test says so. */
    function slowServer() {
      let limits = { answers: 50, points: "300" };
      const puts = [];
      return {
        puts,
        answer: () => useOf({ limits }),
        put: vi.fn((body) => {
          const gate = deferred();
          puts.push({ body, release: () => ((limits = body), gate.resolve(body)) });
          return gate.promise;
        }),
        stored: () => limits,
      };
    }

    it("the 7035.5 sequence: the first save's answer never writes into the box being typed in", async () => {
      const server = slowServer();
      await openPage({ answer: server.answer, api: { putOthersLimits: server.put } });
      // The first box changes to 20 and the person moves on: its save starts and is slow.
      typeInto(answersBox(), "20");
      fireEvent.blur(answersBox());
      await flush();
      expect(server.puts).toHaveLength(1);
      expect(server.puts[0].body).toEqual({ answers: 20, points: "300" });
      // They clear the second box and begin typing 35.5 while the save is on its way.
      fireEvent.focus(pointsBox());
      typeInto(pointsBox(), "");
      typeInto(pointsBox(), "35");
      // The answer comes: the first number is stored and the page is read again; the second box keeps what is being typed.
      server.puts[0].release();
      await flush();
      expect(answersBox().value).toBe("20");
      expect(pointsBox().value).toBe("35");
      typeInto(pointsBox(), "35.5");
      fireEvent.blur(pointsBox());
      await flush();
      expect(server.puts).toHaveLength(2);
      expect(server.puts[1].body).toEqual({ answers: 20, points: "35.5" });
      server.puts[1].release();
      await flush();
      expect(server.stored()).toEqual({ answers: 20, points: "35.5" });
      expect([answersBox().value, pointsBox().value]).toEqual(["20", "35.5"]);
    });

    it("two quick edits: the second is not dropped, it runs when the first ends, with what is shown by then", async () => {
      const server = slowServer();
      await openPage({ answer: server.answer, api: { putOthersLimits: server.put } });
      typeInto(answersBox(), "20");
      enter(answersBox());
      await flush();
      typeInto(answersBox(), "30");
      enter(answersBox());
      await flush();
      expect(server.puts).toHaveLength(1);
      server.puts[0].release();
      await flush();
      expect(server.puts).toHaveLength(2);
      expect(server.puts[1].body).toEqual({ answers: 30, points: "300" });
      server.puts[1].release();
      await flush();
      expect(server.stored()).toEqual({ answers: 30, points: "300" });
      expect(answersBox().value).toBe("30");
    });

    it("an edit made during a save and left by blur is saved after it, both numbers as shown", async () => {
      const server = slowServer();
      await openPage({ answer: server.answer, api: { putOthersLimits: server.put } });
      typeInto(answersBox(), "20");
      enter(answersBox());
      await flush();
      typeInto(pointsBox(), "123.5");
      fireEvent.blur(pointsBox());
      await flush();
      expect(server.puts).toHaveLength(1);
      server.puts[0].release();
      await flush();
      expect(server.puts).toHaveLength(2);
      expect(server.puts[1].body).toEqual({ answers: 20, points: "123.5" });
      server.puts[1].release();
      await flush();
      expect(server.stored()).toEqual({ answers: 20, points: "123.5" });
    });

    it("a save queued when the page is left is still sent (leaving only stops drawing)", async () => {
      const server = slowServer();
      await openPage({ answer: server.answer, api: { putOthersLimits: server.put } });
      typeInto(answersBox(), "20");
      enter(answersBox());
      await flush();
      typeInto(pointsBox(), "35.5");
      fireEvent.blur(pointsBox());
      await flush();
      expect(server.puts).toHaveLength(1);
      // The page is left (the owner goes back) while the first save is on its way.
      cleanup();
      server.puts[0].release();
      await flush();
      expect(server.puts).toHaveLength(2);
      expect(server.puts[1].body).toEqual({ answers: 20, points: "35.5" });
    });

    it("a save that fails while another is queued: the queued one runs with both numbers as shown, the failure is said only if that fails too", async () => {
      let limits = { answers: 50, points: "300" };
      let n = 0;
      const put = vi.fn(async (body) => {
        if (++n === 1) throw apiError(500, "internal");
        limits = body;
        return body;
      });
      await openPage({ answer: () => useOf({ limits }), api: { putOthersLimits: put } });
      typeInto(answersBox(), "20");
      enter(answersBox());
      typeInto(pointsBox(), "123.5");
      fireEvent.blur(pointsBox());
      await flush();
      expect(put).toHaveBeenCalledTimes(2);
      expect(put).toHaveBeenLastCalledWith({ answers: 20, points: "123.5" });
      expect(limits).toEqual({ answers: 20, points: "123.5" });
      expect(mainEl().querySelector(".others-limit-sentence [role='alert']")).toBeNull();
    });

    it("a read already in flight when a save completes does not answer the reload after it: the reload starts its own request, after that one", async () => {
      const { app } = await openPage();
      const actions = app.layer.actions;
      const store = storeOf(actions);
      const sent = [];
      const gates = [];
      let limits = { answers: 50, points: "300" };
      // (Each read answers with the state of the moment it was SENT, as a real request does.)
      app.api.getOthersUse.mockImplementation(() => {
        const gate = deferred();
        const at = structuredClone(limits);
        sent.push(at);
        gates.push(() => gate.resolve(useOf({ limits: at })));
        return gate.promise;
      });
      const before = readOthersUse(actions, store);
      expect(sent).toHaveLength(1);
      limits = { answers: 20, points: "300" }; // the save lands while that read is in flight
      const after = readOthersUse(actions, store, { afterWrite: true });
      // The reload asked for after the write is not the older request, and it has not been sent before that one answered.
      expect(after).not.toBe(before);
      expect(sent).toHaveLength(1);
      gates[0]();
      await before;
      await flush();
      expect(sent).toEqual([{ answers: 50, points: "300" }, { answers: 20, points: "300" }]);
      gates[1]();
      await after;
      expect(store.use.limits).toEqual({ answers: 20, points: "300" });
    });

    it("a box nobody touched follows the service (a change made on another device shows after the next read)", async () => {
      let limits = { answers: 50, points: "300" };
      const { calls } = await openPage({
        answer: () => useOf({ limits }),
        // (Another device had set the points to 310 by the time this save was answered.)
        api: { putOthersLimits: vi.fn(async (body) => ((limits = { answers: body.answers, points: "310" }), limits)) },
      });
      typeInto(answersBox(), "20");
      enter(answersBox());
      await flush();
      expect(calls.putOthersLimits).toHaveBeenCalledTimes(1);
      expect([answersBox().value, pointsBox().value]).toEqual(["20", "310"]);
    });
  });

  it("the three states are the service's: overall and per Agent, never counted from used and the limit", async () => {
    const states = [
      [{ reached: false, tight: false }, "正常"],
      [{ reached: false, tight: true }, "快用完了，长一点的回复可能发不出"],
      [{ reached: true, tight: true }, "今天给别人的额度用完了，明天恢复"],
    ];
    for (const [flags, words] of states) {
      // Used far over the limit with `reached` false, and the other way: the words follow the flags alone.
      await openPage({ answer: () => useOf({ ...flags, used: { answers: 9999, points: "9999", proactivePoints: "0" }, agents: [{ agentId: AG1, answers: 1, points: "1", perDay: 5, canReply: true, ...flags }] }) });
      const text = mainText();
      expect(text.split(words).length - 1, words).toBe(2);
      for (const other of Object.values(OTHERS_STATES).filter((w) => w !== words)) expect(text, other).not.toContain(other);
      cleanup();
    }
  });

  it("the proactive part of today's line is left out when it is zero", async () => {
    await openPage({ answer: () => useOf({ used: { answers: 3, points: "12.5", proactivePoints: "0", proactiveAnswers: 0 } }) });
    expect(mainText()).toContain("已回别人 3 次，花了 12.5 点");
    expect(mainText()).not.toContain("其中主动回复");
    expect(mainEl().querySelector(".others-today").textContent).not.toContain("主动回复");
  });

  it("the date of a stop: no year in this year, the year otherwise", () => {
    const now = new Date(2026, 10, 25, 12);
    expect(sinceText(new Date(2026, 10, 20, 12).toISOString(), now)).toBe("11月20日");
    expect(sinceText(new Date(2025, 10, 5, 12).toISOString(), now)).toBe("2025年11月5日");
    expect(sinceText("nonsense", now)).toBe("");
  });

  it("the shared read is forgotten when the session ends: the layer's stop() does it, nothing of it is shown under the next one", async () => {
    const { app } = await openPage();
    expect(storeOf(app.layer.actions).use).not.toBeNull();
    app.layer.stop();
    expect(storeOf(app.layer.actions).use).toBeNull();
    // (and the function itself)
    forgetOthersUse(app.layer.actions);
  });

  it("the page's save asks for its reload AFTER anything in flight: the numbers the save changed are the ones shown", async () => {
    let limits = { answers: 50, points: "300" };
    let perDay = 41;
    const gates = [];
    const get = vi.fn(() => {
      const gate = deferred();
      const sent = { limits: structuredClone(limits), perDay };
      gates.push(() => gate.resolve(useOf({ limits: sent.limits, agents: [{ agentId: AG1, answers: 3, points: "12.5", perDay: sent.perDay, reached: false, tight: false, canReply: true }] })));
      return gate.promise;
    });
    const put = vi.fn(async (body) => {
      limits = body;
      perDay = 7;
      return body;
    });
    const { app } = await openWith({ api: { getOthersUse: get, putOthersLimits: put } });
    await goSettings();
    await click(inList().getByText(NAME, { selector: ".row-name" }));
    gates[0]();
    await flush();
    // A second read is in flight (sent before the save) when the owner saves.
    const stale = readOthersUse(app.layer.actions, storeOf(app.layer.actions));
    typeInto(answersBox(), "20");
    enter(answersBox());
    await flush();
    // The page did not take the older read as its reload: it starts a request of its own only after that one answers.
    const sentBefore = get.mock.calls.length;
    gates[gates.length - 1]();
    await stale;
    await flush();
    expect(get.mock.calls.length).toBe(sentBefore + 1);
    for (const g of gates) g();
    await flush();
    expect(mainText()).toContain("每天大约能回 7 次");
  });

  it("a read sent before a save that fails after the save's answer: the page says nothing of stale data (review 5, item 8)", async () => {
    const gates = [];
    const get = vi.fn(() => {
      const gate = deferred();
      gates.push(gate);
      return gate.promise;
    });
    const put = vi.fn(async (body) => body);
    const { app } = await openWith({ api: { getOthersUse: get, putOthersLimits: put } });
    await goSettings();
    await click(inList().getByText(NAME, { selector: ".row-name" }));
    gates[0].resolve(useOf());
    await flush();
    // A read is in flight (sent before the save) when the owner saves.
    const stale = readOthersUse(app.layer.actions, storeOf(app.layer.actions));
    typeInto(answersBox(), "20");
    enter(answersBox());
    await flush();
    expect(put).toHaveBeenCalledTimes(1);
    // That older read fails now: the save's answer is newer than anything it could have said.
    gates[gates.length - 1].reject(apiError(503, "unavailable"));
    await stale.catch(() => {});
    await flush();
    expect(mainText()).not.toContain("没读到最新的数据");
    expect(answersBox().value).toBe("20");
    for (const g of gates) g.resolve(useOf({ limits: { answers: 20, points: "300" } }));
    await flush();
    expect(mainText()).not.toContain("没读到最新的数据");
  });

  it("an owner with no Agent is told so; nobody used them today: it says so; the numbers still show", async () => {
    await openPage({ answer: () => useOf({ agents: [], byPerson: [] }) });
    expect(mainText()).toContain("你还没有可以回复别人的 Agent。");
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

describe("people on the page: links to their profile only while Agent social is on; the page stops and resumes nobody", () => {
  it("switch on: a person of today is a link to their profile and the sentence says where to stop; no 停止往来 or 恢复往来 button, no bar route called", async () => {
    const { calls } = await openPage({ social: { enabled: true }, answer: () => useOf({ stopped: [{ person: KEN, since: "2026-11-20T04:00:00.000Z" }] }) });
    const link = within(mainEl().querySelector(".others-people")).getByRole("link", { name: "小美" });
    expect(link.getAttribute("href")).toBe(`/contacts/${MEI.id}`);
    expect(mainText()).toContain("点名字进入对方的资料页，可以在那里停止往来。");
    expect(mainText()).toContain("别人和你的 Agent 聊天、在群里 @ 它，花的点都算在你这里。");
    expect(inMain().queryByRole("button", { name: /停止往来|恢复往来/ })).toBeNull();
    expect(calls.putBar).not.toHaveBeenCalled();
    expect(calls.deleteBar).not.toHaveBeenCalled();
  });

  it("switch off (or not said): today's people are plain names and the sentence about stopping is not drawn; my own stops stay listed, as links (I4)", async () => {
    for (const social of [undefined, { enabled: false }]) {
      const { calls } = await openPage({ social, answer: () => useOf({ stopped: [{ person: KEN, since: "2026-11-20T04:00:00.000Z" }] }) });
      const people = mainEl().querySelector(".others-people");
      expect(people.textContent).toContain("小美");
      expect(within(people).queryByRole("link")).toBeNull();
      // I4 (fix round 1): a stop I made is still listed, as a link to the profile where I can lift it.
      expect(within(mainEl().querySelector(".others-stopped")).getByRole("link", { name: "阿健" }).getAttribute("href")).toBe(`/contacts/${KEN.id}`);
      expect(mainText()).not.toContain("可以在那里停止往来");
      // (Nothing can be added while it is off: the paragraph says how to resume and stops there. Review 2, n3.)
      expect(mainText()).toContain("停止往来后，你们各自的 Agent 都不再回应对方。想恢复，点名字进入对方的资料页。");
      expect(mainText()).not.toContain("重新添加");
      // m3: with the switch off nobody chats with someone else's Agent: the page says what does happen.
      expect(mainText()).toContain("别人在群里 @ 你的 Agent，花的点都算在你这里。");
      expect(mainText()).not.toContain("聊天");
      expect(inMain().queryByRole("button", { name: /停止往来|恢复往来/ })).toBeNull();
      expect(calls.putBar).not.toHaveBeenCalled();
      cleanup();
    }
  });

  it("the link opens the person's page (the profile where the act lives)", async () => {
    // (A person this client knows: the profile is drawn for those it knows.)
    const known = { id: ANN, handle: "ann", displayName: "小安", avatarVersion: 0 };
    await openPage({ social: { enabled: true }, answer: () => useOf({ byPerson: [{ person: known, answers: 1, points: "1" }] }) });
    await click(within(mainEl().querySelector(".others-people")).getByRole("link", { name: "小安" }));
    expect(window.location.pathname).toBe(`/contacts/${ANN}`);
  });

  it("a person this client knows only from this page (no friend, in no chat of mine) opens as a profile with 停止往来; the stop is then on this page's list", async () => {
    let stopped = [];
    const { calls } = await openPage({ social: { enabled: true }, answer: () => useOf({ stopped }) });
    await click(within(mainEl().querySelector(".others-people")).getByRole("link", { name: "小美" }));
    expect(window.location.pathname).toBe(`/contacts/${MEI.id}`);
    expect(toastText()).toBeNull();
    expect(inMain().getByRole("heading", { level: 2 }).textContent).toContain("小美");
    expect(mainText()).toContain("@mei");
    // m15: no conversation exists with a stranger, so the card says nothing of who can read one.
    expect(mainText()).not.toContain("这段会话谁能看");
    await click(inMain().getByRole("button", { name: "停止往来" }));
    stopped = [{ person: MEI, since: "2026-11-20T04:00:00.000Z" }];
    await click(within(screen.getByRole("dialog")).getByRole("button", { name: "停止往来" }));
    expect(calls.putBar).toHaveBeenCalledWith(MEI.id);
    expect(inMain().getByRole("button", { name: "恢复往来" })).toBeTruthy();
    // The profile told the shared read: the use page lists the person when it is opened again.
    await goSettings();
    await click(inList().getByText(NAME, { selector: ".row-name" }));
    expect(mainEl().querySelector(".others-stopped").textContent).toContain("小美");
  });

  it("such a person's address opened directly draws the profile once the list is read; an id in nobody's list falls back to the contacts as before", async () => {
    window.history.replaceState(null, "", `/contacts/${MEI.id}`);
    await openWith({ social: { enabled: true } });
    await flush();
    expect(window.location.pathname).toBe(`/contacts/${MEI.id}`);
    expect(inMain().getByRole("heading", { level: 2 }).textContent).toContain("小美");
    expect(toastText()).toBeNull();
    cleanup();
    installBrowser();
    window.history.replaceState(null, "", "/contacts/00000000-0000-4000-8000-00000000dead");
    await openWith({ social: { enabled: true } });
    await flush();
    expect(window.location.pathname).toBe("/contacts");
    expect(toastText()).toBe("找不到这位联系人");
    cleanup();
    installBrowser();
    // The switch off (m9, I4): the same read is made once, so a person I stopped earlier is still reached by address; anyone else falls back.
    window.history.replaceState(null, "", `/contacts/${MEI.id}`);
    await openWith({ social: { enabled: false }, answer: () => useOf({ byPerson: [], stopped: [{ person: MEI, since: "2026-11-20T04:00:00.000Z" }] }) });
    await flush();
    expect(window.location.pathname).toBe(`/contacts/${MEI.id}`);
    expect(inMain().getByRole("button", { name: "恢复往来" })).toBeTruthy();
    expect(inMain().queryByRole("button", { name: "停止往来" })).toBeNull();
    cleanup();
    installBrowser();
    window.history.replaceState(null, "", "/contacts/00000000-0000-4000-8000-00000000dead");
    await openWith({ social: { enabled: false } });
    await flush();
    expect(window.location.pathname).toBe("/contacts");
  });

  it("the stopped list shows who and since when, as links, and says what the act does in both directions; nothing to press", async () => {
    await openPage({ social: { enabled: true }, answer: () => useOf({ stopped: [{ person: MEI, since: "2026-11-20T04:00:00.000Z" }] }) });
    const list = mainEl().querySelector(".others-stopped");
    expect(within(list).getByRole("link", { name: "小美" }).getAttribute("href")).toBe(`/contacts/${MEI.id}`);
    expect(list.textContent).toMatch(/@mei · (\d+年)?\d+月\d+日停止/);
    expect(inMain().queryAllByRole("button").map((b) => b.textContent)).not.toContain("恢复往来");
    expect(mainText()).toContain("停止往来后，你们各自的 Agent 都不再回应对方。想恢复，点名字进入对方的资料页。恢复往来后，之前的对话不会自动恢复；想再聊，需要重新添加对方的 Agent，并等它的主人同意。");
  });

  it("with the switch off and nobody stopped there is no stopped section; with it on and nobody stopped it says so", async () => {
    await openPage({ social: { enabled: false } });
    expect(mainText()).not.toContain("已停止往来的人");
    cleanup();
    await openPage({ social: { enabled: true } });
    expect(mainText()).toContain("现在没有停止往来的人。");
  });
});

describe("the usage page's section", () => {
  it("one line of today's use and its state, and a link to the page", async () => {
    await openWith({ answer: () => useOf({ tight: true }) });
    await goSettings();
    await click(inList().getByText("用量与余额", { selector: ".row-name" }));
    const section = mainEl().querySelector(".others-usage");
    expect(section.querySelector("h3").textContent).toBe("别人用我的 Agent");
    expect(section.textContent).toContain("今天已回别人 3 次，花了 12.5 点 · 快用完了，长一点的回复可能发不出");
    expect(section.textContent).not.toContain("含主动回复");
    await click(within(section).getByRole("link", { name: NAME }));
    expect(window.location.pathname).toBe("/settings/others");
  });
});

describe("the Agent's card and page", () => {
  it("I3: when my day for others is used up the list says it ONCE at its top and no card carries a tag; a card's short tag 已用完 only for an Agent whose own number is used up while mine is not; the page says all three states", async () => {
    const reached = { agentId: AG1, answers: 1, points: "1", perDay: 41, reached: true, tight: true, canReply: true };
    // The owner's day is used up: every Agent of theirs is, together.
    await openWith({ answer: () => useOf({ reached: true, tight: true, agents: [reached] }) });
    await goAgents();
    const top = document.querySelector(".list-col .others-reached");
    expect(top.textContent).toBe("今天给别人的额度用完了，明天恢复");
    expect(document.querySelector(".list-col .rows").textContent).not.toContain("用完");
    expect(document.querySelectorAll(".list-col .rows .tag-warn")).toHaveLength(0);
    cleanup();
    // Only this Agent's own number is used up: its card says so in three characters, the list's top says nothing.
    await openWith({ answer: () => useOf({ reached: false, tight: false, agents: [reached] }) });
    await goAgents();
    expect(document.querySelector(".list-col .others-reached")).toBeNull();
    expect(within(document.querySelector(".list-col .rows")).getByText("别人已用完", { selector: ".tag" })).toBeTruthy();
    cleanup();
    // Nothing used up: neither.
    await openWith({});
    await goAgents();
    expect(listText()).not.toContain("用完");
    cleanup();
    for (const [flags, words] of [
      [{ reached: false, tight: false }, OTHERS_STATES.ok],
      [{ reached: false, tight: true }, OTHERS_STATES.tight],
      [{ reached: true, tight: true }, OTHERS_STATES.reached],
    ]) {
      await openWith({ answer: () => useOf({ agents: [{ agentId: AG1, answers: 1, points: "1", perDay: 41, canReply: true, ...flags }] }), agentFields: { othersUsedToday: { answers: 1, points: "1" } } });
      await goAgents();
      await click(inList().getByText("小助手", { selector: ".row-name" }));
      expect(document.querySelector(".main-col .kv").textContent, words).toContain(`别人今天的使用今天回了别人 1 次（含主动回复），回应别人花了 1 点 · ${words}`);
      cleanup();
    }
  });

  it("m5: an Agent the site's operator turned off says so to its owner, on its card and on its page, instead of 可回复", async () => {
    await openWith({ agentFields: { operatorDisabled: true } });
    await goAgents();
    const row = inList().getByText("小助手", { selector: ".row-name" }).closest(".row");
    expect(within(row).getByText("已被停用", { selector: ".tag" })).toBeTruthy();
    expect(row.textContent).not.toContain("可回复");
    await click(inList().getByText("小助手", { selector: ".row-name" }));
    expect(mainText()).toContain("管理员停用了这个 Agent：它现在只回复你，不回复别人。");
    cleanup();
    await openWith({});
    await goAgents();
    await click(inList().getByText("小助手", { selector: ".row-name" }));
    expect(mainText()).not.toContain("停用");
  });

  it("the list and the page read the route once between them", async () => {
    const { calls } = await openWith({ agentFields: { othersLimit: { answers: null, points: null }, othersUsedToday: { answers: 0, points: "0" } } });
    await goAgents();
    await click(inList().getByText("小助手", { selector: ".row-name" }));
    expect(calls.getOthersUse).toHaveBeenCalledTimes(1);
  });

  it("the page's row says its own limit as the owner would read it, and what its proactive replies cost today", async () => {
    await openWith({
      answer: () => useOf(),
      agentFields: {
        othersLimit: { answers: null, points: null },
        othersUsedToday: { answers: 3, points: "12.5" },
        proactive: true,
        proactiveLevel: "normal",
        proactiveBudget: "70",
        proactiveSpentToday: "4.25",
      },
    });
    await goAgents();
    await click(inList().getByText("小助手", { selector: ".row-name" }));
    const kv = document.querySelector(".main-col .kv").textContent;
    expect(kv).toContain("别人用它的上限没有单独设置，和其他 Agent 共用你的每天上限");
    expect(kv).toContain("主动参与群聊适中 · 每天最多花 70 点，今天花了 4.25 点");
  });

  it("an Agent that cannot answer says so on its page instead of a state", async () => {
    await openWith({
      answer: () => useOf({ agents: [{ agentId: AG1, answers: 0, points: "0", perDay: 0, reached: false, tight: false, canReply: false }] }),
      agentFields: { othersLimit: { answers: null, points: null }, othersUsedToday: { answers: 0, points: "0" } },
    });
    await goAgents();
    await click(inList().getByText("小助手", { selector: ".row-name" }));
    const kv = document.querySelector(".main-col .kv").textContent;
    expect(kv).toContain("没有可用的模型，暂时不能回复");
    expect(kv).not.toContain("正常");
  });
});

describe("the one-time notice at the top of 我的 Agent", () => {
  const NOTICE = "别人用你的 Agent，每天的上限变了：以前每个 Agent 默认各有 20 点，现在你所有的 Agent 合在一起，每天最多回别人 50 次、最多花你 300 点，它们主动说的话也算在里面。还是默认 20 点的 Agent，自己的上限已取消；你改过的不变。主动回复的上限原来是 20 点的，已改成 70 点。可以在“设置 › 别人怎么用我的 Agent”里改。";
  const noticeEl = () => document.querySelector(".others-notice");

  it("its text is exactly the copy, with the owner's two numbers, and is true for every owner: one who never changed a number, one who chose 不限, one above the total, one below (I1)", async () => {
    await openWith({ answer: () => useOf({ notice: true }) });
    await goAgents();
    const text = othersNoticeText({ answers: 50, points: "300" });
    expect(text).toBe(
      "别人用你的 Agent，每天的上限改了。现在你所有的 Agent 合在一起，每天最多回别人 50 次、最多花你 300 点，它们主动回复的也算在内。原来每个 Agent 默认的 20 点上限已取消。你单独给某个 Agent 设过的上限还在，但不会超过这个总数；原来设为“不限”的，现在也按这个总数算。主动回复的上限原来是 20 点的，已改成 70 点。可在“设置 › 别人怎么用我的 Agent”里修改。",
    );
    expect(document.querySelector(".list-col .others-notice").textContent).toContain(text);
    // Never the sentence that was untrue for an owner of 不限 or of a number above the total.
    expect(text).not.toContain("你改过的不变");
    expect(text).toContain("原来设为“不限”的，现在也按这个总数算");
    expect(text).toContain("不会超过这个总数");
    // System text, in the list column; no exclamation mark.
    expect(document.querySelector(".main-col")?.textContent ?? "").not.toContain("每天的上限改了");
    expect(text).not.toMatch(/[!！]/);
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

  it("知道了 is a write like a save: a read already in flight when it is pressed does not bring the notice back", async () => {
    let notice = true;
    const gates = [];
    const get = vi.fn(() => {
      const gate = deferred();
      const sent = notice;
      gates.push(() => gate.resolve(useOf({ notice: sent })));
      return gate.promise;
    });
    const { app } = await openWith({ api: { getOthersUse: get, seenOthersNotice: vi.fn(async () => ((notice = false), { ok: true })) } });
    await goAgents();
    gates[0]();
    await flush();
    expect(noticeEl()).not.toBeNull();
    // A read is in flight (sent while the notice was still on) when 知道了 is pressed.
    const inFlight = readOthersUse(app.layer.actions, storeOf(app.layer.actions));
    await click(within(noticeEl()).getByRole("button", { name: "知道了" }));
    expect(noticeEl()).toBeNull();
    gates[1](); // the older read answers with notice: true (it was sent before the write)
    await inFlight;
    await flush();
    // The reload after the write is its own request, sent after that one: its answer (notice false) is what stays.
    expect(gates).toHaveLength(3);
    gates[2]();
    await flush();
    expect(noticeEl()).toBeNull();
  });

  it("when the service cannot take 知道了, the notice stays and a toast says why", async () => {
    await openWith({ answer: () => useOf({ notice: true }), api: { seenOthersNotice: vi.fn(async () => { throw apiError(500, "internal"); }) } });
    await goAgents();
    await click(within(noticeEl()).getByRole("button", { name: "知道了" }));
    expect(noticeEl()).not.toBeNull();
    expect(toastText()).toBeTruthy();
  });
});
