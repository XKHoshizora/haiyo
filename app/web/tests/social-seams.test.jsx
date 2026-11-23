// @vitest-environment jsdom
// Step 0's web seams for Agent social (plan T0.5): one function per route, thin actions, the refusal texts, the 「别人」 tab that
// shows only while the site's switch is on, and nothing but the lookup reaching a lane-A route while it is off.
import "./markdown-ready.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import * as routes from "../src/api/routes.js";
import { createDataLayer } from "../src/data/store.jsx";
import { socialErrorText } from "../src/data/errorTexts.js";
import { addressOf, navOfAddress, SETTINGS_PAGES } from "../src/state/location.js";
import { AG1, A1, MODELS, PRINCIPALS, agentConv, agentOf, agentPrincipal, apiError, fakeTimers, fakeTransport, settle, syncOf, usageOf } from "./fixtures.js";
import { click, flush, inMain, installBrowser, openApp } from "./harness.jsx";

// (The tab itself, `pages/AgentOthers.jsx`, is a stub that draws nothing until lane A writes it. It cannot be replaced by a mock here:
// tests/setup.js loads the application's chunk before any test file runs. So these tests see the mount by what surrounds it.)

const ID = "0b9c1c6e-0000-4000-8000-000000000001";
const ID2 = "0b9c1c6e-0000-4000-8000-000000000002";

describe("the route functions", () => {
  let fetchMock;
  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  // [call, method, path, body]  (body undefined: no body)
  const table = [
    [() => routes.listAgentContacts(), "GET", "/api/agent-contacts", undefined],
    [() => routes.addAgentContact(ID), "POST", "/api/agent-contacts", { agentId: ID }],
    [() => routes.approveAgentContact("a", "s"), "POST", "/api/agent-contacts/a/s/approve", undefined],
    [() => routes.declineAgentContact(ID, ID2), "POST", `/api/agent-contacts/${ID}/${ID2}/decline`, undefined],
    [() => routes.removeAgentContact(ID, ID2), "DELETE", `/api/agent-contacts/${ID}/${ID2}`, undefined],
    [() => routes.getAgentContacts(ID), "GET", `/api/agents/${ID}/contacts`, undefined],
    [() => routes.putContactPolicy(ID, { policy: "ask", picked: false, picks: [] }), "PUT", `/api/agents/${ID}/contact-policy`, { policy: "ask", picked: false, picks: [] }],
    [() => routes.putBar(ID), "PUT", `/api/bars/${ID}`, undefined],
    [() => routes.deleteBar(ID), "DELETE", `/api/bars/${ID}`, undefined],
    [() => routes.reportAgent({ agentId: ID, reason: "spam" }), "POST", "/api/reports", { agentId: ID, reason: "spam" }],
    [() => routes.putNoteVerdict(ID, { noteKind: "owner", noteId: ID2, audienceId: ID, share: true }), "PUT", `/api/agents/${ID}/note-verdicts`, { noteKind: "owner", noteId: ID2, audienceId: ID, share: true }],
    [() => routes.answerPersonaFact(ID, 4, true), "POST", `/api/agents/${ID}/persona-facts/4`, { move: true }],
    [() => routes.getOthersUse(), "GET", "/api/me/others-use", undefined],
    [() => routes.putOthersLimits({ answers: 50, points: "70" }), "PUT", "/api/me/others-limits", { answers: 50, points: "70" }],
    [() => routes.seenOthersNotice(), "POST", "/api/me/others-limits/seen", undefined],
  ];
  it.each(table)("%# builds its path, method and body", async (call, method, path, body) => {
    await call();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(path);
    expect(init.method).toBe(method);
    if (body === undefined) expect(init.body).toBeUndefined();
    else expect(JSON.parse(init.body)).toEqual(body);
  });

  it("encodes the segments", async () => {
    await routes.approveAgentContact("a/b", "c d");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/agent-contacts/a%2Fb/c%20d/approve");
  });
});

describe("the thin actions", () => {
  it("each calls its route with the ids as given and hands back the answer; a refusal reaches the caller as it came", async () => {
    const api = {
      listAgentContacts: vi.fn(async () => ({ mine: [], waiting: [] })),
      approveAgentContact: vi.fn(async () => ({ state: "live", conversationId: ID })),
      putBar: vi.fn(async () => {
        throw apiError(404, "not_found");
      }),
    };
    const layer = createDataLayer({ transport: fakeTransport({ sync: () => syncOf([]) }), api, timers: fakeTimers(), now: () => 1, random: () => 0.5, uuid: () => "u" });
    layer.start();
    await settle();
    expect(await layer.actions.listAgentContacts()).toEqual({ mine: [], waiting: [] });
    expect(await layer.actions.approveAgentContact("a", "s")).toEqual({ state: "live", conversationId: ID });
    expect(api.approveAgentContact).toHaveBeenCalledWith("a", "s");
    await expect(layer.actions.putBar(ID)).rejects.toMatchObject({ status: 404 });
    for (const name of ["addAgentContact", "declineAgentContact", "removeAgentContact", "getAgentContacts", "putContactPolicy", "deleteBar", "reportAgent", "putNoteVerdict", "answerPersonaFact", "getOthersUse", "putOthersLimits", "seenOthersNotice"]) {
      expect(typeof layer.actions[name], name).toBe("function");
    }
    layer.stop();
  });
});

describe("the refusal texts", () => {
  const err = (code, extra = {}) => ({ code, status: 409, reason: null, ...extra });
  it("says each code in the product's words", () => {
    expect(socialErrorText(err("is_yours"))).toBe("这是你自己的 Agent。");
    expect(socialErrorText(err("not_requested"))).toBe("这个申请已经处理过了。");
    expect(socialErrorText(err("no_access"))).toBe("你已不能再和它聊天。");
    expect(socialErrorText(err("agent_unavailable"))).toBe("这个 Agent 现在不可用。");
    expect(socialErrorText(err("answered"))).toBe("这件事已经回答过了。");
    expect(socialErrorText(err("expired"))).toBe("这张卡片已经过期了。");
  });
  it("cooldown names the day it may be tried again, as the account name's wait does", () => {
    expect(socialErrorText(err("cooldown", { availableAt: "2026-12-24T00:00:00" }))).toBe("现在还不能再申请，2026年12月24日 以后可以。");
    expect(socialErrorText(err("cooldown"))).toBe("现在还不能再申请，稍后再试。");
  });
  it("anything else is the shared sentence or the generic one", () => {
    expect(socialErrorText(err("rate_limited"))).toBe("操作太频繁了，请稍等一分钟再试。");
    expect(socialErrorText(err("something_new"))).toBe("操作没有成功，请稍后再试。");
    expect(socialErrorText(undefined)).toBe("操作没有成功，请稍后再试。");
  });
});

describe("the 「别人」 settings page id", () => {
  it("is an address of its own", () => {
    expect(SETTINGS_PAGES).toContain("others");
    expect(addressOf({ section: "settings", pane: "main", settingsPage: "others" })).toEqual({ path: "/settings/others", overlay: null });
    expect(navOfAddress({ path: "/settings/others" })).toMatchObject({ section: "settings", pane: "main", settingsPage: "others" });
  });
});

describe("the Agent page", () => {
  beforeEach(() => installBrowser());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const rail = (name) => within(screen.getByRole("navigation", { name: "主导航" })).getByRole("button", { name });
  const laneA = () => ({
    listAgentContacts: vi.fn(),
    addAgentContact: vi.fn(),
    getAgentContacts: vi.fn(),
    putContactPolicy: vi.fn(),
    putBar: vi.fn(),
    deleteBar: vi.fn(),
    reportAgent: vi.fn(),
    putNoteVerdict: vi.fn(),
    answerPersonaFact: vi.fn(),
  });
  /** The app on the Agent's page, with the site's switch as `social` says (absent: the sync does not carry it). */
  async function openAgent({ social, api = {} } = {}) {
    const agents = [agentOf(AG1, { intro: "陪你规划旅行", model: { source: "site", id: "free-1" } })];
    const principals = [...PRINCIPALS, agentPrincipal(AG1)];
    const sync = () => ({ ...syncOf([agentConv(A1, AG1)], [], principals), ...(social === undefined ? {} : { social }) });
    const app = await openApp({
      sync,
      api: { getModels: vi.fn(async () => MODELS), listProviders: vi.fn(async () => ({ providers: [] })), getUsage: vi.fn(async () => usageOf()), listAgents: vi.fn(() => new Promise(() => {})), ...api },
      handlers: { agents: () => ({ agents }), models: () => MODELS },
    });
    fireEvent.click(rail(/^Agent/));
    await flush();
    await click(within(document.querySelector(".list-col")).getByText("小助手", { selector: ".row-name" }));
    return app;
  }
  const tabs = () => within(inMain().getByRole("tablist", { name: "Agent 分区" })).getAllByRole("tab").map((t) => t.textContent);

  it("switch off (or not said): no 「别人」 tab, and nothing but the lookup is asked of a lane-A route", async () => {
    for (const social of [undefined, { enabled: false }]) {
      const lane = laneA();
      await openAgent({ social, api: lane });
      expect(tabs()).toEqual(["资料", "参与的会话", "记忆宫殿"]);
      for (const [name, fn] of Object.entries(lane)) expect(fn, name).not.toHaveBeenCalled();
      cleanup();
    }
  });

  it("switch on: the pill is there, and choosing it opens the tab", async () => {
    await openAgent({ social: { enabled: true } });
    expect(tabs()).toEqual(["资料", "参与的会话", "记忆宫殿", "别人"]);
    await click(inMain().getByRole("tab", { name: "别人" }));
    expect(inMain().getByRole("tab", { name: "别人" }).getAttribute("aria-selected")).toBe("true");
    // The tab is the stub's: the page body holds nothing of the profile, the groups or the memory, and nothing else yet.
    expect(document.querySelector(".main-col .page-body").children).toHaveLength(0);
  });

  it("the tab is the live Agent's, and goes with the switch: turned off while open, the page falls back to the profile", async () => {
    const app = await openAgent({ social: { enabled: true } });
    await click(inMain().getByRole("tab", { name: "别人" }));
    expect(inMain().getByRole("tab", { name: "别人" }).getAttribute("aria-selected")).toBe("true");
    app.env.sync = () => ({ ...syncOf([agentConv(A1, AG1)], [], [...PRINCIPALS, agentPrincipal(AG1)]), social: { enabled: false } });
    app.layer.actions.syncNow();
    await flush();
    expect(tabs()).toEqual(["资料", "参与的会话", "记忆宫殿"]);
    expect(inMain().getByRole("tab", { name: "资料" }).getAttribute("aria-selected")).toBe("true");
  });
});

describe("the default tab", () => {
  it("shows nothing until lane A writes it", async () => {
    const { AgentOthersTab } = await import("../src/pages/AgentOthers.jsx");
    expect(AgentOthersTab({ agent: { id: AG1 } })).toBeNull();
  });
});
