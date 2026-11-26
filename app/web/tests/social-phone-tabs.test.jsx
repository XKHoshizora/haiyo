// @vitest-environment jsdom
// The seam between the one-pane rule (where one pane shows, a tab is its section's LIST) and Agent social's screens: from a social
// conversation, a watched conversation opened from the Agent section, and the use page, Back and the tabs still reach the lists.
import "./markdown-ready.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { A1, AG1, ANN, BO, MODELS, ME_ID, PRINCIPALS, agentConv, agentOf, agentPrincipal, syncOf, usageOf, wire } from "./fixtures.js";
import { flush, installBrowser, openApp } from "./harness.jsx";
import { COARSE_QUERY, PHONE_QUERY } from "../src/ui/pointer.js";
import { forgetOthersUse } from "../src/data/othersUseCache.js";

const ONE_COLUMN = "(max-width: 860px)";
beforeEach(() => {
  installBrowser();
  forgetOthersUse();
  const on = [PHONE_QUERY, COARSE_QUERY, ONE_COLUMN];
  window.matchMedia = (query) => ({ matches: on.includes(query), media: query, addEventListener() {}, removeEventListener() {} });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete window.matchMedia;
});

const AGB = "00000000-0000-4000-8000-0000000000b2"; // BO's Agent
const SV = "00000000-0000-4000-8000-000000003001"; // I speak with AGB
const SO = "00000000-0000-4000-8000-000000003002"; // I watch AG1 with ANN
const PEOPLE = [...PRINCIPALS, { ...agentPrincipal(AGB), ownerId: BO, displayName: "小帮手", handle: "bob.helper" }, { ...agentPrincipal(AG1), ownerId: ME_ID }];
const social = (id, myRole, participants, agent, owner, others) => ({
  id,
  type: "agent_social",
  title: null,
  myRole,
  closed: false,
  canSend: { ok: true },
  social: { participants, agents: [{ id: agent, ownerId: owner }] },
  members: others,
  lastSeq: 1,
  readSeq: 1,
  unread: 0,
});
const visiting = social(SV, "speaker", [ME_ID, AGB], AGB, BO, [
  { id: ME_ID, role: "speaker", isCreator: false },
  { id: AGB, role: "speaker", isCreator: false },
  { id: BO, role: "observer", isCreator: false },
]);
const watched = social(SO, "observer", [AG1, ANN], AG1, ME_ID, [
  { id: ANN, role: "speaker", isCreator: false },
  { id: AG1, role: "speaker", isCreator: false },
  { id: ME_ID, role: "observer", isCreator: false },
]);
const use = () => ({
  limit: "300",
  used: "0",
  proactive: "0",
  ownKeyPoints: "6",
  reached: false,
  byPerson: [],
  stopped: [{ person: { id: ANN, handle: "ann", displayName: "小安", avatarVersion: 0 }, since: "2026-11-20T00:00:00.000Z" }],
  notice: false,
});
const open = () =>
  openApp({
    sync: () => ({ ...syncOf([agentConv(A1, AG1), visiting, watched], [wire(SV, 1, AGB, "你好呀"), wire(SO, 1, ANN, "在吗")], PEOPLE), social: { enabled: true } }),
    api: {
      getModels: vi.fn(async () => MODELS),
      listProviders: vi.fn(async () => ({ providers: [] })),
      getUsage: vi.fn(async () => usageOf()),
      getOthersUse: vi.fn(async () => use()),
      getAgentContacts: vi.fn(async () => ({ policy: "ask", picked: false, picks: [], rows: [], conversations: [] })),
    },
    handlers: { agents: () => ({ agents: [agentOf(AG1, { model: { source: "site", id: "free-1" } })] }), models: () => MODELS },
  });

const bar = () => screen.queryByRole("navigation", { name: "主导航" });
const tab = (name) => within(bar()).getByRole("button", { name });
const press = async (el) => {
  fireEvent.click(el);
  await flush();
};
const back = async () => {
  await act(async () => {
    window.history.back();
    await vi.advanceTimersByTimeAsync(60);
  });
  await flush();
};
const path = () => window.location.pathname;
const pane = () => document.querySelector(".app").dataset.pane;

describe("on a phone, Agent social's screens keep the lists in reach", () => {
  it("a social conversation I speak in: it fills the screen; Back is the conversation list with the tab bar", async () => {
    await open();
    await press(screen.getByText("小帮手", { selector: ".list-col .row-name" }));
    expect(path()).toBe(`/chat/${SV}`);
    expect(bar()).toBeNull();
    expect(screen.getByTestId("social-note")).toBeTruthy();
    await back();
    expect(path()).toBe("/");
    expect(pane()).toBe("list");
    expect(bar()).toBeTruthy();
  });

  it("a watched conversation opened from the Agent section: Back returns through the Agent's page to the Agent list, and 消息 is the conversation list — not that conversation again", async () => {
    await open();
    await press(tab(/^Agent/));
    await press(screen.getByText("小助手", { selector: ".list-col .row-name" }));
    expect(path()).toBe(`/agents/${AG1}`);
    await press(screen.getByRole("tab", { name: "别人" }));
    await press(within(screen.getByRole("list", { name: "它和别人的对话" })).getByRole("button"));
    expect(path()).toBe(`/chat/${SO}`);
    expect(bar()).toBeNull();
    await back();
    expect(path()).toBe(`/agents/${AG1}`);
    await back();
    expect(path()).toBe("/agents");
    expect(bar()).toBeTruthy();
    await press(tab(/^消息/));
    expect(path()).toBe("/");
    expect(pane()).toBe("list");
    expect(bar()).toBeTruthy();
  });

  it("the use page and its stopped list: a stopped person's profile is one push; Back is the use page, Back again the settings list; 设置 from another tab is the settings list", async () => {
    await open();
    await press(tab(/^设置/));
    expect(path()).toBe("/settings");
    await press(screen.getByText("别人怎么用我的 Agent", { selector: ".list-col *" }));
    expect(path()).toBe("/settings/others");
    await flush();
    await press(within(screen.getByRole("list", { name: "已停止往来的人" })).getByRole("link", { name: "小安" }));
    expect(path()).toBe(`/contacts/${ANN}`);
    await back();
    expect(path()).toBe("/settings/others");
    await back();
    expect(path()).toBe("/settings");
    expect(pane()).toBe("list");
    expect(bar()).toBeTruthy();
    // Into the use page again, away by address, and 设置 is the list — not the page last seen in the section.
    await press(screen.getByText("别人怎么用我的 Agent", { selector: ".list-col *" }));
    await back();
    await press(tab(/^消息/));
    await press(tab(/^设置/));
    expect(path()).toBe("/settings");
    expect(pane()).toBe("list");
  });
});
