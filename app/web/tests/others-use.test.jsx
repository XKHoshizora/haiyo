// @vitest-environment jsdom
// The limits redesign, Part 1: others' use of my Agents is ONE number — 「别人每天最多花我 N 点」 (300 by default) — for all my Agents and
// their proactive replies together. The use page (Settings › 别人怎么用我的 Agent) shows today's use against it, who used it and the one
// editable number; the usage page has one line of it; 我的 Agent says once at its top when the day is used up, and its one-time notice is
// one sentence and an entry. Everything shown is the service's (`GET /api/me/others-use`): the web only words it, and never compares what
// was used with the number. The page has NO stop and NO restore control of its own (that act lives on the person's profile).
import "./markdown-ready.js";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { AG1, ANN, MODELS, PRINCIPALS, agentConv, agentOf, agentPrincipal, apiError, deferred, syncOf, usageOf } from "./fixtures.js";
import { click, flush, inMain, installBrowser, mainText, openApp, toastText } from "./harness.jsx";
import { OTHERS_NOTICE_LINK, OTHERS_STATES, othersNoticeText, othersStateOf } from "../src/data/othersCopy.js";
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

/** The route's answer for an owner; `over` replaces any part. */
const useOf = (over = {}) => ({
  limit: "300",
  used: "12.5",
  proactive: "0",
  ownKeyPoints: "6",
  reached: false,
  byPerson: [{ person: MEI, points: "8" }, { person: KEN, points: "4.5" }],
  stopped: [],
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
const pointsBox = () => inMain().getByLabelText("每天最多花的点数");
const enter = (box) => fireEvent.keyDown(box, { key: "Enter" });
const typeInto = (box, value) => fireEvent.change(box, { target: { value } });

describe("the two states, in one place", () => {
  it("normal and reached, as the service says; the second says it is OTHERS' use and when it is back", () => {
    expect(OTHERS_STATES).toEqual({ ok: "正常", reached: "今天给别人的额度用完了，明天恢复" });
    expect(othersStateOf({ reached: false })).toBe("ok");
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

  it("the sentence with the owner's one number (300 by default) and what it covers; today's use with the proactive part; who used it, by points", async () => {
    const { calls } = await openPage({ answer: () => useOf({ proactive: "2" }) });
    expect(calls.getOthersUse).toHaveBeenCalled();
    expect(pointsBox().value).toBe("300");
    expect(pointsBox().closest("p").textContent).toBe("别人用我的 Agent，每天合计最多花我点");
    const text = mainText();
    // One number for all of them, proactive replies included; an own key's reply counted at the service's number; replies under way finish.
    expect(text).toContain("你所有的 Agent 合在一起算，它们主动回复的也算。用你自己的模型密钥时不扣点，每条回复按 6 点计，联网搜索另计。每天零点（站点时间）重新算。已经在回复的会照常回完，所以一天用的可能超过这个数。");
    expect(text).toContain("今天别人花了 12.5 点（其中主动回复 2 点）");
    expect(text).toContain("小美");
    expect(text).toContain("@mei · 花了 8 点");
    expect(text).toContain("阿健");
    // No Agent-by-Agent part, no count of answers, no per-day estimate.
    expect(mainEl().querySelector(".others-agents")).toBeNull();
    expect(text).not.toMatch(/次/);
    expect(text).not.toContain("大约能回");
  });

  it("the number is saved on Enter or on leaving the box, once; an unchanged or wrong number is not saved", async () => {
    // (The service keeps what it was given, as it does.)
    let limit = "300";
    const { calls } = await openPage({ answer: () => useOf({ limit }), api: { putOthersLimits: vi.fn(async (body) => ((limit = body.points), body)) } });
    typeInto(pointsBox(), "20");
    enter(pointsBox());
    await flush();
    expect(calls.putOthersLimits).toHaveBeenCalledTimes(1);
    expect(calls.putOthersLimits).toHaveBeenLastCalledWith({ points: "20" });
    typeInto(pointsBox(), " 035.50 ");
    fireEvent.blur(pointsBox());
    await flush();
    expect(calls.putOthersLimits).toHaveBeenCalledTimes(2);
    expect(calls.putOthersLimits).toHaveBeenLastCalledWith({ points: "35.5" });
    // What is shown is what is stored: the box shows the normal form of what was sent.
    expect(pointsBox().value).toBe("35.5");
    // Nothing typed that differs: no write. A wrong number: said under the sentence, nothing sent.
    fireEvent.blur(pointsBox());
    await flush();
    expect(calls.putOthersLimits).toHaveBeenCalledTimes(2);
    typeInto(pointsBox(), "100001");
    fireEvent.blur(pointsBox());
    await flush();
    expect(calls.putOthersLimits).toHaveBeenCalledTimes(2);
    expect(mainText()).toContain("点数请填 1 到 100000 的数");
    expect(pointsBox().getAttribute("aria-invalid")).toBe("true");
  });

  it("raised above today's use while the page's refresh fails: the number and its state change together (no 用完了 beside the new number)", async () => {
    let fail = false;
    const { calls } = await openPage({
      answer: () => {
        if (fail) throw apiError(503, "unavailable");
        return useOf({ limit: "10", used: "12.5", reached: true });
      },
    });
    expect(mainEl().querySelector(".others-today").textContent).toContain("今天给别人的额度用完了");
    fail = true;
    typeInto(pointsBox(), "20");
    enter(pointsBox());
    await flush();
    expect(calls.putOthersLimits).toHaveBeenLastCalledWith({ points: "20" });
    expect(pointsBox().value).toBe("20");
    expect(mainEl().querySelector(".others-today").textContent).toContain("正常");
    expect(mainEl().querySelector(".others-today").textContent).not.toContain("用完了");
    // Lowered to today's use or below: reached again, as the service would say.
    typeInto(pointsBox(), "12.5");
    enter(pointsBox());
    await flush();
    expect(mainEl().querySelector(".others-today").textContent).toContain("今天给别人的额度用完了");
  });

  it("an Enter that confirms an input method's candidate saves nothing", async () => {
    const { calls } = await openPage();
    typeInto(pointsBox(), "20");
    fireEvent.keyDown(pointsBox(), { key: "Enter", isComposing: true });
    fireEvent.keyDown(pointsBox(), { key: "Enter", keyCode: 229 });
    await flush();
    expect(calls.putOthersLimits).not.toHaveBeenCalled();
  });

  it("a refusal of the save is said under the sentence", async () => {
    const { calls } = await openPage({ api: { putOthersLimits: vi.fn(async () => { throw apiError(429, "rate_limited"); }) } });
    typeInto(pointsBox(), "20");
    enter(pointsBox());
    await flush();
    expect(calls.putOthersLimits).toHaveBeenCalledTimes(1);
    expect(mainEl().querySelector(".others-limit-sentence [role='alert']")?.textContent).toBeTruthy();
  });

  describe("I3: the box owns its draft, saves go one at a time, what is stored is what is shown (a slow server)", () => {
    /** A server that keeps the number and answers each PUT when the test says so. */
    function slowServer() {
      let limit = "300";
      const puts = [];
      return {
        puts,
        answer: () => useOf({ limit }),
        put: vi.fn((body) => {
          const gate = deferred();
          puts.push({ body, release: () => ((limit = body.points), gate.resolve(body)) });
          return gate.promise;
        }),
        stored: () => limit,
      };
    }

    it("a save's answer never writes into the box while it is being typed in", async () => {
      const server = slowServer();
      await openPage({ answer: server.answer, api: { putOthersLimits: server.put } });
      typeInto(pointsBox(), "200");
      fireEvent.blur(pointsBox());
      await flush();
      expect(server.puts).toHaveLength(1);
      expect(server.puts[0].body).toEqual({ points: "200" });
      // The owner comes back and begins typing 35.5 while the save is on its way.
      fireEvent.focus(pointsBox());
      typeInto(pointsBox(), "35");
      server.puts[0].release();
      await flush();
      expect(pointsBox().value).toBe("35");
      typeInto(pointsBox(), "35.5");
      fireEvent.blur(pointsBox());
      await flush();
      expect(server.puts).toHaveLength(2);
      expect(server.puts[1].body).toEqual({ points: "35.5" });
      server.puts[1].release();
      await flush();
      expect(server.stored()).toBe("35.5");
      expect(pointsBox().value).toBe("35.5");
    });

    it("two quick edits: the second is not dropped, it runs when the first ends, with what is shown by then", async () => {
      const server = slowServer();
      await openPage({ answer: server.answer, api: { putOthersLimits: server.put } });
      typeInto(pointsBox(), "20");
      enter(pointsBox());
      await flush();
      typeInto(pointsBox(), "30");
      enter(pointsBox());
      await flush();
      expect(server.puts).toHaveLength(1);
      server.puts[0].release();
      await flush();
      expect(server.puts).toHaveLength(2);
      expect(server.puts[1].body).toEqual({ points: "30" });
      server.puts[1].release();
      await flush();
      expect(server.stored()).toBe("30");
      expect(pointsBox().value).toBe("30");
    });

    it("a save queued when the page is left is still sent (leaving only stops drawing)", async () => {
      const server = slowServer();
      await openPage({ answer: server.answer, api: { putOthersLimits: server.put } });
      typeInto(pointsBox(), "20");
      enter(pointsBox());
      await flush();
      typeInto(pointsBox(), "35.5");
      fireEvent.blur(pointsBox());
      await flush();
      expect(server.puts).toHaveLength(1);
      cleanup();
      server.puts[0].release();
      await flush();
      expect(server.puts).toHaveLength(2);
      expect(server.puts[1].body).toEqual({ points: "35.5" });
    });

    it("a save that fails while another is queued: the queued one runs with the number as shown, the failure is said only if that fails too", async () => {
      let limit = "300";
      let n = 0;
      const put = vi.fn(async (body) => {
        if (++n === 1) throw apiError(500, "internal");
        limit = body.points;
        return body;
      });
      await openPage({ answer: () => useOf({ limit }), api: { putOthersLimits: put } });
      typeInto(pointsBox(), "20");
      enter(pointsBox());
      typeInto(pointsBox(), "123.5");
      fireEvent.blur(pointsBox());
      await flush();
      expect(put).toHaveBeenCalledTimes(2);
      expect(put).toHaveBeenLastCalledWith({ points: "123.5" });
      expect(limit).toBe("123.5");
      expect(mainEl().querySelector(".others-limit-sentence [role='alert']")).toBeNull();
    });

    it("a read already in flight when a save completes does not answer the reload after it: the reload starts its own request, after that one", async () => {
      const { app } = await openPage();
      const actions = app.layer.actions;
      const store = storeOf(actions);
      const sent = [];
      const gates = [];
      let limit = "300";
      // (Each read answers with the state of the moment it was SENT, as a real request does.)
      app.api.getOthersUse.mockImplementation(() => {
        const gate = deferred();
        const at = limit;
        sent.push(at);
        gates.push(() => gate.resolve(useOf({ limit: at })));
        return gate.promise;
      });
      const before = readOthersUse(actions, store);
      expect(sent).toHaveLength(1);
      limit = "20"; // the save lands while that read is in flight
      const after = readOthersUse(actions, store, { afterWrite: true });
      expect(after).not.toBe(before);
      expect(sent).toHaveLength(1);
      gates[0]();
      await before;
      await flush();
      expect(sent).toEqual(["300", "20"]);
      gates[1]();
      await after;
      expect(store.use.limit).toBe("20");
    });

    it("a box nobody touched follows the service (a change made on another device shows after the next read)", async () => {
      let limit = "300";
      const { app } = await openPage({ answer: () => useOf({ limit }) });
      expect(pointsBox().value).toBe("300");
      limit = "310";
      await readOthersUse(app.layer.actions, storeOf(app.layer.actions));
      await flush();
      expect(pointsBox().value).toBe("310");
    });
  });

  it("the two states are the service's, never counted from what was used and the number", async () => {
    for (const [reached, words] of [
      [false, "正常"],
      [true, "今天给别人的额度用完了，明天恢复"],
    ]) {
      // Used far over the number with `reached` false, and the other way: the words follow the flag alone.
      await openPage({ answer: () => useOf({ reached, used: reached ? "1" : "9999" }) });
      const text = mainText();
      expect(text.split(words).length - 1, words).toBe(1);
      for (const other of Object.values(OTHERS_STATES).filter((w) => w !== words)) expect(text, other).not.toContain(other);
      cleanup();
    }
  });

  it("the proactive part of today's line is left out when it is zero", async () => {
    await openPage({ answer: () => useOf({ proactive: "0" }) });
    expect(mainEl().querySelector(".others-today").textContent).toContain("今天别人花了 12.5 点");
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

  it("the page's save asks for its reload AFTER anything in flight: what the save changed is what is shown", async () => {
    let limit = "300";
    let used = "12.5";
    const gates = [];
    const get = vi.fn(() => {
      const gate = deferred();
      const sent = { limit, used };
      gates.push(() => gate.resolve(useOf(sent)));
      return gate.promise;
    });
    const put = vi.fn(async (body) => {
      limit = body.points;
      used = "13.75";
      return body;
    });
    const { app } = await openWith({ api: { getOthersUse: get, putOthersLimits: put } });
    await goSettings();
    await click(inList().getByText(NAME, { selector: ".row-name" }));
    gates[0]();
    await flush();
    // A second read is in flight (sent before the save) when the owner saves.
    const stale = readOthersUse(app.layer.actions, storeOf(app.layer.actions));
    typeInto(pointsBox(), "20");
    enter(pointsBox());
    await flush();
    // The page did not take the older read as its reload: it starts a request of its own only after that one answers.
    const sentBefore = get.mock.calls.length;
    gates[gates.length - 1]();
    await stale;
    await flush();
    expect(get.mock.calls.length).toBe(sentBefore + 1);
    for (const g of gates) g();
    await flush();
    expect(mainText()).toContain("今天别人花了 13.75 点");
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
    const stale = readOthersUse(app.layer.actions, storeOf(app.layer.actions));
    typeInto(pointsBox(), "20");
    enter(pointsBox());
    await flush();
    expect(put).toHaveBeenCalledTimes(1);
    gates[gates.length - 1].reject(apiError(503, "unavailable"));
    await stale.catch(() => {});
    await flush();
    expect(mainText()).not.toContain("没读到最新的数据");
    expect(pointsBox().value).toBe("20");
    for (const g of gates) g.resolve(useOf({ limit: "20" }));
    await flush();
    expect(mainText()).not.toContain("没读到最新的数据");
  });

  it("nobody used them today: it says so; the number still shows", async () => {
    await openPage({ answer: () => useOf({ byPerson: [], used: "0" }) });
    expect(mainText()).toContain("今天还没有别人用过你的 Agent。");
    expect(pointsBox().value).toBe("300");
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
    expect(pointsBox().value).toBe("300");
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
      expect(within(mainEl().querySelector(".others-stopped")).getByRole("link", { name: "阿健" }).getAttribute("href")).toBe(`/contacts/${KEN.id}`);
      expect(mainText()).not.toContain("可以在那里停止往来");
      expect(mainText()).toContain("停止往来后，你们各自的 Agent 都不再回应对方。想恢复，点名字进入对方的资料页。");
      expect(mainText()).not.toContain("重新添加");
      expect(mainText()).toContain("别人在群里 @ 你的 Agent，花的点都算在你这里。");
      expect(mainText()).not.toContain("聊天");
      expect(inMain().queryByRole("button", { name: /停止往来|恢复往来/ })).toBeNull();
      expect(calls.putBar).not.toHaveBeenCalled();
      cleanup();
    }
  });

  it("the link opens the person's page (the profile where the act lives)", async () => {
    const known = { id: ANN, handle: "ann", displayName: "小安", avatarVersion: 0 };
    await openPage({ social: { enabled: true }, answer: () => useOf({ byPerson: [{ person: known, points: "1" }] }) });
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
    expect(mainText()).not.toContain("这段会话谁能看");
    await click(inMain().getByRole("button", { name: "停止往来" }));
    stopped = [{ person: MEI, since: "2026-11-20T04:00:00.000Z" }];
    await click(within(screen.getByRole("dialog")).getByRole("button", { name: "停止往来" }));
    expect(calls.putBar).toHaveBeenCalledWith(MEI.id);
    expect(inMain().getByRole("button", { name: "恢复往来" })).toBeTruthy();
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
  it("one line of today's use against the number, its state, and a link to the page", async () => {
    await openWith({ answer: () => useOf({ reached: true, used: "301" }) });
    await goSettings();
    await click(inList().getByText("用量与余额", { selector: ".row-name" }));
    const section = mainEl().querySelector(".others-usage");
    expect(section.querySelector("h3").textContent).toBe("别人用我的 Agent");
    expect(section.textContent).toContain("今天别人花了 301 点，每天最多 300 点 · 今天给别人的额度用完了，明天恢复");
    await click(within(section).getByRole("link", { name: NAME }));
    expect(window.location.pathname).toBe("/settings/others");
  });
});

describe("the Agent's card and page", () => {
  it("when my day for others is used up the list says it ONCE at its top and no card carries a tag; otherwise nothing", async () => {
    await openWith({ answer: () => useOf({ reached: true }) });
    await goAgents();
    const top = document.querySelector(".list-col .others-reached");
    expect(top.textContent).toBe("今天给别人的额度用完了，明天恢复");
    expect(document.querySelector(".list-col .rows").textContent).not.toContain("用完");
    expect(document.querySelectorAll(".list-col .rows .tag-warn")).toHaveLength(0);
    cleanup();
    await openWith({});
    await goAgents();
    expect(listText()).not.toContain("用完");
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
    const { calls } = await openWith({});
    await goAgents();
    await click(inList().getByText("小助手", { selector: ".row-name" }));
    expect(calls.getOthersUse).toHaveBeenCalledTimes(1);
  });

  it("the page says no limit of its own and no budget of its own: only how readily it joins in", async () => {
    await openWith({ agentFields: { proactive: true, proactiveLevel: "normal" } });
    await goAgents();
    await click(inList().getByText("小助手", { selector: ".row-name" }));
    const kv = document.querySelector(".main-col .kv").textContent;
    expect(kv).toContain("主动参与群聊适中");
    expect(kv).not.toContain("每天最多花");
    expect(kv).not.toContain("别人用它的上限");
    expect(kv).not.toContain("别人今天的使用");
  });
});

describe("the one-time notice at the top of 我的 Agent", () => {
  const noticeEl = () => document.querySelector(".others-notice");

  it("one sentence with the owner's number, and the entry to see and change it", async () => {
    await openWith({ answer: () => useOf({ notice: true }) });
    await goAgents();
    expect(othersNoticeText("300")).toBe("别人用你的 Agent，每天合计最多花 300 点。");
    expect(OTHERS_NOTICE_LINK).toBe("查看和修改");
    expect(document.querySelector(".list-col .others-notice").textContent).toContain("别人用你的 Agent，每天合计最多花 300 点。");
    expect(othersNoticeText("300")).not.toMatch(/[!！]/);
    await click(within(noticeEl()).getByRole("link", { name: "查看和修改" }));
    expect(window.location.pathname).toBe("/settings/others");
  });

  it("the owner's own number is in it (grouped digits)", async () => {
    await openWith({ answer: () => useOf({ notice: true, limit: "1500.5" }) });
    await goAgents();
    expect(noticeEl().textContent).toContain("每天合计最多花 1,500.5 点。");
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
    const inFlight = readOthersUse(app.layer.actions, storeOf(app.layer.actions));
    await click(within(noticeEl()).getByRole("button", { name: "知道了" }));
    expect(noticeEl()).toBeNull();
    gates[1]();
    await inFlight;
    await flush();
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
