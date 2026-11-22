// @vitest-environment jsdom
// Settings › 用量与余额: today's free allowance and when it resets (local time), the balance (a negative one said
// plainly), the tier and the number of Agents, the recent usage per Agent and model; points shown as the service gives
// them; read again when the section opens and after each reply that ends while it is open.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { A1, AG1, AG2, A2, MODELS, PRINCIPALS, agentConv, agentOf, agentPrincipal, apiError, deferred, runOf, syncOf, usageOf } from "./fixtures.js";
import { click, flush, inMain, installBrowser, mainText, openApp, push } from "./harness.jsx";
import { REPLY_POINTS_KEY, setShowReplyPoints, showReplyPoints } from "../src/data/prefs.js";

beforeEach(() => installBrowser());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const rail = (name) => within(screen.getByRole("navigation", { name: "主导航" })).getByRole("button", { name });
const settingsRow = (name) => screen.getByText(name, { selector: ".list-col .row-name" });
/** The value of a row of the page's key-value lists, by its label. */
const kv = (label) => [...document.querySelectorAll(".main-col .kv-row")].find((row) => row.querySelector("dt").textContent === label)?.querySelector("dd").textContent;
const recentRows = () =>
  [...within(inMain().getByRole("list", { name: "最近用量" })).getAllByRole("listitem")].map((li) => [
    li.querySelector("strong").textContent,
    li.querySelector(".member-body p").textContent,
    li.lastElementChild.textContent,
  ]);

const AGENTS = [agentOf(AG1), agentOf(AG2, { handle: "cook", name: "厨师", conversationId: A2, deleted: true })];

/** The app with my two Agents (one deleted) and their conversations, on Settings › 用量与余额. */
async function openUsage({ getUsage = vi.fn(async () => usageOf()), open = true, models = MODELS } = {}) {
  const principals = [...PRINCIPALS, agentPrincipal(AG1), agentPrincipal(AG2, "cook", "厨师")];
  const sync = () => syncOf([agentConv(A1, AG1), agentConv(A2, AG2, { agent: { paused: false, deleted: true } })], [], principals);
  const app = await openApp({ sync, api: { getUsage }, handlers: { agents: () => ({ agents: AGENTS }), models: () => models } });
  fireEvent.click(rail(/^设置/));
  await flush();
  if (open) await click(settingsRow("用量与余额"));
  return { ...app, getUsage };
}

describe("usage and balance", () => {
  it("shows today's free allowance (used / allowance) and when it resets, in local time", async () => {
    const resetsAt = new Date(2026, 10, 17, 0, 0).toISOString();
    await openUsage({ getUsage: vi.fn(async () => usageOf({ free: { allowance: "10", used: "2.5", resetsAt } })) });
    expect(document.querySelector(".main-col .profile-head h2").textContent).toBe("用量与余额");
    expect(kv("已用 / 每日额度")).toBe("2.5 / 10 点");
    expect(kv("下次重置")).toBe("11月17日 00:00（本地时间）");
  });

  it("shows points at a sensible precision, one rule everywhere: two decimals from 1 up, four below it, a trace as <0.0001; digits grouped", async () => {
    const usage = usageOf({
      balance: "1234567.000001",
      free: { allowance: "100", used: "0.000001", resetsAt: new Date(2026, 10, 17).toISOString() },
      recent: [{ agentId: AG1, model: "free-1", source: "site", points: "3.000001", replies: 4 }],
    });
    await openUsage({ getUsage: vi.fn(async () => usage) });
    expect(kv("当前余额")).toBe("1,234,567 点");
    expect(kv("已用 / 每日额度")).toBe("<0.0001 / 100 点");
    expect(recentRows()[0][2]).toBe("3 点 · 4 次回复");
    expect(mainText()).not.toContain("余额为负");
  });

  it("web searches are a line of their own, 联网搜索 with the count and the points, for site and provider models alike — never in a model's line", async () => {
    const usage = usageOf({
      recent: [
        { agentId: AG1, model: "free-1", source: "site", points: "4.5", replies: 12 },
        { agentId: AG1, model: "own-1", source: "provider", points: "0", replies: 3 },
      ],
      recentWeb: [
        { agentId: AG1, searches: 11, points: "8.47385" },
        { agentId: AG2, searches: 1, points: "13" },
      ],
    });
    await openUsage({ getUsage: vi.fn(async () => usage) });
    expect(recentRows()).toEqual([
      ["小助手", "小模型（本站）", "4.5 点 · 12 次回复"],
      ["小助手", "own-1（我的供应商）", "0 点 · 3 次回复"],
      ["小助手", "联网搜索", "8.47 点 · 11 次"],
      ["已删除的 Agent", "联网搜索", "13 点 · 1 次"],
    ]);
    expect(mainText()).toContain("用你自己的供应商时，模型本身不扣点，联网搜索照样扣点。联网搜索单独列出。");
  });

  it("while the site offers web search, with none in these days yet: the model costs no points, web searches do (fix round 1, I2)", async () => {
    const usage = usageOf({ recent: [{ agentId: AG1, model: "own-1", source: "provider", points: "0", replies: 1 }] });
    await openUsage({ getUsage: vi.fn(async () => usage), models: { ...MODELS, webSearchAvailable: true } });
    expect(mainText()).toContain("最近 7 天（含今天），按 Agent 和模型汇总。用你自己的供应商时，模型本身不扣点，联网搜索照样扣点。");
    expect(mainText()).not.toContain("联网搜索单独列出");
  });

  it("with no web search in these days: no such line, and the page says nothing of it", async () => {
    const usage = usageOf({ recent: [{ agentId: AG1, model: "free-1", source: "site", points: "1", replies: 1, webSearches: 2 }] });
    await openUsage({ getUsage: vi.fn(async () => usage) });
    expect(recentRows()).toEqual([["小助手", "小模型（本站）", "1 点 · 1 次回复"]]);
    expect(mainText()).not.toContain("联网搜索");
  });

  it("a negative balance is shown plainly, with one sentence saying why and what happens next", async () => {
    await openUsage({ getUsage: vi.fn(async () => usageOf({ balance: "-2.5" })) });
    expect(kv("当前余额")).toBe("-2.5 点");
    expect(mainText()).toContain("余额为负：上一次回复超出了余额，下次发放时会先补平。");
  });

  it("shows the tier and how many Agents of the limit I have", async () => {
    await openUsage({ getUsage: vi.fn(async () => usageOf({ tier: "free", agentCount: 3, agentLimit: 20 })) });
    expect(kv("档位")).toBe("免费档");
    expect(kv("Agent 数量")).toBe("3 / 20");
  });

  it("lists the recent usage per Agent and model; a deleted or unknown Agent, and persona drafts, are named for what they are", async () => {
    const recent = [
      { agentId: AG1, model: "paid-1", source: "site", points: "12.5", replies: 7 },
      { agentId: AG2, model: "gpt-x", source: "provider", points: "0", replies: 2 },
      { agentId: "00000000-0000-4000-8000-0000000000bf", model: "free-1", source: "site", points: "1", replies: 1 },
      { agentId: null, model: "free-1", source: "site", points: "0.2", replies: 0 },
    ];
    await openUsage({ getUsage: vi.fn(async () => usageOf({ recent })) });
    expect(recentRows()).toEqual([
      ["小助手", "大模型（本站）", "12.5 点 · 7 次回复"],
      ["已删除的 Agent", "gpt-x（我的供应商）", "0 点 · 2 次回复"],
      ["已删除的 Agent", "小模型（本站）", "1 点 · 1 次回复"],
      ["起草人格文档", "小模型（本站）", "0.2 点"],
    ]);
  });

  it("a row with purpose memory reads 记忆, apart from persona drafts (which have no Agent either)", async () => {
    const recent = [
      { agentId: null, purpose: "draft", model: "free-1", source: "site", points: "0.2", replies: 0 },
      { agentId: null, purpose: "memory", model: "free-1", source: "site", points: "0.05", replies: 0 },
      { agentId: AG1, purpose: "reply", model: "paid-1", source: "site", points: "3", replies: 2 },
    ];
    await openUsage({ getUsage: vi.fn(async () => usageOf({ recent })) });
    expect(recentRows()).toEqual([
      ["起草人格文档", "小模型（本站）", "0.2 点"],
      ["记忆", "小模型（本站）", "0.05 点"],
      ["小助手", "大模型（本站）", "3 点 · 2 次回复"],
    ]);
  });

  it("a memory row paid by the site says so instead of a charge, and one quiet line gives memory's own allowance for today", async () => {
    const recent = [
      { agentId: null, purpose: "memory", model: "free-1", source: "site", points: "0.05", replies: 0, paidBy: "site" },
      { agentId: AG1, purpose: "reply", model: "paid-1", source: "site", points: "3", replies: 2 },
    ];
    await openUsage({ getUsage: vi.fn(async () => usageOf({ recent, memory: { allowance: "20", used: "1.5", resetsAt: "2026-11-16T16:00:00.000Z" } })) });
    expect(recentRows()).toEqual([
      ["记忆", "小模型（本站）", "由站点承担"],
      ["小助手", "大模型（本站）", "3 点 · 2 次回复"],
    ]);
    // The memory's allowance is a row of today's free allowance, not a clause glued to the paragraph above the recent list.
    expect(kv("记忆今天的额度")).toBe("已用 1.5 / 20 点");
    expect(document.querySelector('[aria-label="最近用量"]').previousElementSibling.textContent).not.toContain("记忆今天的额度");
    expect(mainText()).not.toContain("0.05 点");
  });

  it("without memory figures (an older service) shows no allowance line", async () => {
    await openUsage();
    expect(mainText()).not.toContain("记忆今天的额度");
  });

  it("with no recent usage says so plainly", async () => {
    await openUsage();
    expect(inMain().queryByRole("list", { name: "最近用量" })).toBeNull();
    expect(mainText()).toContain("最近 7 天还没有用量。");
  });

  it("says when it cannot be read, and reads it again on 重试", async () => {
    const getUsage = vi.fn(async () => {
      throw apiError(503, "busy");
    });
    await openUsage({ getUsage });
    expect(mainText()).toContain("没能读取用量");
    getUsage.mockResolvedValueOnce(usageOf({ balance: "8" }));
    await click(inMain().getByRole("button", { name: "重试" }));
    expect(kv("当前余额")).toBe("8 点");
    expect(mainText()).not.toContain("没能读取用量");
  });

  it("shows that it is reading until the first answer", async () => {
    const pending = deferred();
    await openUsage({ getUsage: vi.fn(() => pending.promise) });
    expect(mainText()).toContain("正在读取用量…");
    await act(async () => pending.resolve(usageOf()));
    await flush();
    expect(kv("当前余额")).toBe("0 点");
  });
});

describe("reading it again", () => {
  /** A `run` push for my Agent's conversation, then whatever it sets off. */
  const run = async (transport, id, status) => {
    await push(transport, { type: "run", conversationId: A1, run: runOf(id, status) });
    await flush();
  };

  it("when the section opens, and after every reply that ends while it is open (never while it runs, never when closed)", async () => {
    const app = await openUsage({ open: false });
    expect(app.getUsage).not.toHaveBeenCalled();
    await click(settingsRow("用量与余额"));
    expect(app.getUsage).toHaveBeenCalledTimes(1);

    await run(app.transport, "r1", "queued");
    await run(app.transport, "r1", "running");
    expect(app.getUsage).toHaveBeenCalledTimes(1);
    await run(app.transport, "r1", "done");
    expect(app.getUsage).toHaveBeenCalledTimes(2);
    // The same end pushed again is not another reply.
    await run(app.transport, "r1", "done");
    expect(app.getUsage).toHaveBeenCalledTimes(2);

    for (const [id, status, calls] of [
      ["r2", "failed", 3],
      ["r3", "stopped", 4],
      ["r4", "cancelled", 5],
    ]) {
      await run(app.transport, id, "running");
      await run(app.transport, id, status);
      expect(app.getUsage, status).toHaveBeenCalledTimes(calls);
    }

    await click(settingsRow("我的资料"));
    await run(app.transport, "r5", "running");
    await run(app.transport, "r5", "done");
    expect(app.getUsage).toHaveBeenCalledTimes(5);
    await click(settingsRow("用量与余额"));
    expect(app.getUsage).toHaveBeenCalledTimes(6);
  });

  it("the newest answer is shown", async () => {
    const getUsage = vi.fn(async () => usageOf({ balance: "5" }));
    const app = await openUsage({ getUsage });
    expect(kv("当前余额")).toBe("5 点");
    getUsage.mockResolvedValue(usageOf({ balance: "4.75" }));
    await run(app.transport, "r1", "running");
    await run(app.transport, "r1", "done");
    expect(kv("当前余额")).toBe("4.75 点");
  });
});

describe("在每条回复下显示消耗的点数", () => {
  beforeEach(() => {
    localStorage.clear();
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
  });
  const pointsSwitch = () => inMain().getByRole("switch", { name: "在每条回复下显示消耗的点数" });

  it("is off by default, says it only changes this device, and is kept in this browser (not the account): on, then off", async () => {
    const { getUsage } = await openUsage();
    expect(pointsSwitch().checked).toBe(false);
    expect(mainText()).toContain("只影响你这台设备上的显示。");
    fireEvent.click(pointsSwitch());
    expect(pointsSwitch().checked).toBe(true);
    expect(localStorage.getItem(REPLY_POINTS_KEY)).toBe("1");
    expect(showReplyPoints()).toBe(true);
    // Nothing is asked of the service for it.
    expect(getUsage).toHaveBeenCalledTimes(1);
    cleanup();
    await openUsage();
    expect(pointsSwitch().checked).toBe(true);
    fireEvent.click(pointsSwitch());
    expect(pointsSwitch().checked).toBe(false);
    expect(localStorage.getItem(REPLY_POINTS_KEY)).toBeNull();
  });

  it("shows even when the usage cannot be read", async () => {
    await openUsage({
      getUsage: vi.fn(async () => {
        throw apiError(503, "busy");
      }),
    });
    expect(pointsSwitch().checked).toBe(false);
  });

  it("a browser that refuses storage: off, and turning it on still holds on this page", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("denied");
    });
    await openUsage();
    expect(pointsSwitch().checked).toBe(false);
    fireEvent.click(pointsSwitch());
    expect(pointsSwitch().checked).toBe(true);
    expect(showReplyPoints()).toBe(true);
    vi.restoreAllMocks();
    act(() => setShowReplyPoints(false));
    expect(showReplyPoints()).toBe(false);
  });
});
