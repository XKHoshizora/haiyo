// @vitest-environment jsdom
// Ring 1b (option A; design §1, §7.2, §7.3, §7.8, §8): under my Agent's reply in a social conversation, folded, what it could refer to of
// my notes — in the Agent's name, never 「它」 —, each note with 以后别说 while it is as the reply was shown it, a text-free line once it
// changed; the button's own request; and the disclosure where I let people in.
import "./markdown-ready.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { A1, AG1, ANN, BO, MODELS, ME_ID, PRINCIPALS, agentConv, agentOf, agentPrincipal, apiError, syncOf, usageOf, wire } from "./fixtures.js";
import { click, flush, goContacts, inMain, installBrowser, openApp } from "./harness.jsx";

beforeEach(installBrowser);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const AGB = "00000000-0000-4000-8000-0000000000b2"; // BO's Agent
const SV = "00000000-0000-4000-8000-000000003001"; // I speak with AGB
const SO = "00000000-0000-4000-8000-000000003002"; // I watch AG1 with ANN
const N1 = "00000000-0000-4000-8000-00000000e001";
const N2 = "00000000-0000-4000-8000-00000000e002";
const N3 = "00000000-0000-4000-8000-00000000e003";
const PEOPLE = [...PRINCIPALS, { ...agentPrincipal(AGB), ownerId: BO, displayName: "小帮手", handle: "bob.helper" }, { ...agentPrincipal(AG1), ownerId: ME_ID }];
const SHOWN = [
  { kind: "owner", id: N1, text: "主人爱吃辣" },
  { kind: "self", id: N2, text: "上次推荐过川菜馆" },
  { kind: "owner", id: N3, text: null },
];
const watched = () => ({
  id: SO,
  type: "agent_social",
  title: null,
  myRole: "observer",
  closed: false,
  canSend: { ok: true },
  social: { participants: [AG1, ANN], agents: [{ id: AG1, ownerId: ME_ID }] },
  members: [
    { id: ANN, role: "speaker", isCreator: false },
    { id: AG1, role: "speaker", isCreator: false },
    { id: ME_ID, role: "observer", isCreator: false },
  ],
  lastSeq: 2,
  readSeq: 2,
  unread: 0,
});
const visiting = () => ({
  id: SV,
  type: "agent_social",
  title: null,
  myRole: "speaker",
  closed: false,
  canSend: { ok: true },
  social: { participants: [ME_ID, AGB], agents: [{ id: AGB, ownerId: BO }] },
  members: [
    { id: ME_ID, role: "speaker", isCreator: false },
    { id: AGB, role: "speaker", isCreator: false },
    { id: BO, role: "observer", isCreator: false },
  ],
  lastSeq: 2,
  readSeq: 2,
  unread: 0,
});

const rail = (name) => within(screen.getByRole("navigation", { name: "主导航" })).getByRole("button", { name });
const note = (id, fields = {}) => ({ id, text: "x", vault: true, unsure: false, origin: "review", source: { kind: "agent", title: null }, createdAt: "2026-11-16T00:00:00Z", updatedAt: "2026-11-16T00:00:00Z", strength: 0, seenAt: "2026-11-16T00:00:00Z", ...fields });

async function openApp2(convs, messages, api = {}, contacts = { mine: [], waiting: [] }) {
  return openApp({
    sync: () => ({ ...syncOf([agentConv(A1, AG1), ...convs], messages, PEOPLE), social: { enabled: true } }),
    api: {
      getModels: vi.fn(async () => MODELS),
      listProviders: vi.fn(async () => ({ providers: [] })),
      getUsage: vi.fn(async () => usageOf()),
      listAgents: vi.fn(() => new Promise(() => {})),
      getAgentContacts: vi.fn(async () => ({ policy: "ask", picked: false, picks: [], rows: [], conversations: [] })),
      patchMemoryNote: vi.fn(async (id) => note(id)),
      patchAgentMemoryNote: vi.fn(async (_agent, id) => note(id)),
      ...api,
    },
    handlers: { agents: () => ({ agents: [agentOf(AG1, { model: { source: "site", id: "free-1" } })] }), models: () => MODELS, agentContacts: () => contacts },
  });
}
/** My Agent's page, its 「别人」 tab. */
async function othersTab() {
  fireEvent.click(rail(/^Agent/));
  await flush();
  await click(within(document.querySelector(".list-col")).getByText("小助手", { selector: ".row-name" }));
  await click(inMain().getByRole("tab", { name: "别人" }));
}
/** The social conversation I watch, opened from my Agent's 「别人」 tab. */
async function openWatched(shownNotes = SHOWN, api) {
  const app = await openApp2([watched()], [wire(SO, 1, ANN, "你知道他爱吃什么吗"), wire(SO, 2, AG1, "他爱吃辣。", shownNotes === null ? {} : { shownNotes })], api);
  await othersTab();
  await click(within(document.querySelector(".social-convs")).getAllByRole("button")[0]);
  return app;
}
const replyItem = () => document.querySelector('ol.messages li[data-msg="m2"]');
const toggle = () => within(replyItem()).getByRole("button", { name: /这次能参考/ });

describe("the line under my Agent's reply", () => {
  it("is folded and in the Agent's name; opened, the scope once, then each note: its text and 以后别说, or a text-free line with no button", async () => {
    await openWatched();
    expect(toggle().textContent).toBe("小助手这次能参考 3 条记忆");
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(replyItem().textContent).not.toContain("主人爱吃辣");
    await click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    const block = replyItem().querySelector(".shown-notes-block");
    expect(block.querySelector("p").textContent).toBe("放进保险箱后，小助手和别人聊天时不再参考这条记忆。已经说过的话不会收回；这条记忆最初产生的那个群里仍会用到。");
    const rows = [...block.querySelectorAll("li")];
    expect(rows.map((r) => r.textContent)).toEqual(["主人爱吃辣以后别说", "上次推荐过川菜馆以后别说", "这条记忆后来改过"]);
    expect(within(rows[2]).queryByRole("button")).toBeNull();
    expect(replyItem().textContent).not.toContain("它");
    // Folded again.
    await click(toggle());
    expect(replyItem().querySelector(".shown-notes-block")).toBeNull();
  });

  it("以后别说 sends the button's own request, bound to this reply: a note about me by the shared room, the Agent's own by its room; then 已放进保险箱 and the way to it", async () => {
    const { api } = await openWatched();
    await click(toggle());
    const rows = () => [...replyItem().querySelectorAll(".shown-notes-block li")];
    await click(within(rows()[0]).getByRole("button", { name: "以后别说" }));
    expect(api.patchMemoryNote).toHaveBeenCalledWith(N1, { vault: true, from: { conversationId: SO, seq: 2 } });
    expect(rows()[0].textContent).toBe("已放进保险箱 · 在记忆里查看");
    expect(within(rows()[0]).getByRole("link", { name: "在记忆里查看" }).getAttribute("href")).toBe("/settings/memory");
    await click(within(rows()[1]).getByRole("button", { name: "以后别说" }));
    expect(api.patchAgentMemoryNote).toHaveBeenCalledWith(AG1, N2, { vault: true, from: { conversationId: SO, seq: 2 } });
    expect(within(rows()[1]).getByRole("link", { name: "在记忆里查看" }).getAttribute("href")).toBe(`/agents/${AG1}`);
    // No undo here: the memory page is where a note comes out of the vault.
    expect(replyItem().textContent).not.toMatch(/撤销|取出/);
  });

  it("a note changed since (409 note_changed): the row turns into the text-free line, with no button; another refusal is said on the row", async () => {
    const patchMemoryNote = vi.fn(async (id) => {
      if (id === N1) throw apiError(409, "note_changed");
      throw apiError(429, "rate_limited");
    });
    await openWatched([SHOWN[0], { kind: "owner", id: N3, text: "另一条" }], { patchMemoryNote });
    await click(toggle());
    const rows = () => [...replyItem().querySelectorAll(".shown-notes-block li")];
    await click(within(rows()[0]).getByRole("button", { name: "以后别说" }));
    expect(rows()[0].textContent).toBe("这条记忆后来改过");
    expect(within(rows()[0]).queryByRole("button")).toBeNull();
    await click(within(rows()[1]).getByRole("button", { name: "以后别说" }));
    expect(within(rows()[1]).getByRole("alert").textContent).not.toBe("");
    expect(within(rows()[1]).getByRole("button", { name: "以后别说" })).toBeTruthy();
  });

  it.each([
    ["its 200", vi.fn(async (id) => note(id))],
    ["its 409 note_changed", vi.fn(async () => Promise.reject(apiError(409, "note_changed")))],
  ])("fix round 1, F3: the same note under another reply turns into the text-free line after %s, with no live button left", async (_label, patchMemoryNote) => {
    const watching = { ...watched(), lastSeq: 4, readSeq: 4 };
    await openApp2(
      [watching],
      [wire(SO, 1, ANN, "你知道他爱吃什么吗"), wire(SO, 2, AG1, "他爱吃辣。", { shownNotes: SHOWN }), wire(SO, 3, ANN, "还有呢"), wire(SO, 4, AG1, "也爱吃甜。", { shownNotes: [SHOWN[0], SHOWN[1]] })],
      { patchMemoryNote },
    );
    await othersTab();
    await click(within(document.querySelector(".social-convs")).getAllByRole("button")[0]);
    const item = (seq) => document.querySelector(`ol.messages li[data-msg="m${seq}"]`);
    const rowsOf = (seq) => [...item(seq).querySelectorAll(".shown-notes-block li")];
    for (const seq of [2, 4]) await click(within(item(seq)).getByRole("button", { name: /这次能参考/ }));
    expect(rowsOf(4)[0].textContent).toBe("主人爱吃辣以后别说");
    await click(within(rowsOf(2)[0]).getByRole("button", { name: "以后别说" }));
    expect(patchMemoryNote).toHaveBeenCalledTimes(1);
    expect(rowsOf(4)[0].textContent).toBe("这条记忆后来改过");
    expect(within(rowsOf(4)[0]).queryByRole("button")).toBeNull();
    // Another note of that reply is untouched.
    expect(rowsOf(4)[1].textContent).toBe("上次推荐过川菜馆以后别说");
  });

  it("a reply that was shown no note has no line", async () => {
    await openWatched(null);
    expect(within(replyItem()).queryByRole("button", { name: /这次能参考/ })).toBeNull();
  });

  it("someone else's Agent's reply never shows one, whatever the message carries", async () => {
    await openApp2([visiting()], [wire(SV, 1, ME_ID, "你好"), wire(SV, 2, AGB, "你好呀", { shownNotes: SHOWN })]);
    await click(screen.getByText("小帮手", { selector: ".list-col .row-name" }));
    expect(document.querySelector("ol.messages").textContent).not.toContain("这次能参考");
    expect(document.body.textContent).not.toContain("主人爱吃辣");
  });
});

describe("the disclosure where I let people in", () => {
  it("the 「别人」 tab says it once, in the Agent's name, with the way to its memory", async () => {
    await openApp2([], []);
    await othersTab();
    const line = inMain().getByText(/可能用到保险箱以外的记忆/);
    expect(line.textContent).toBe("小助手和别人聊天时，可能用到保险箱以外的记忆。去记忆宫殿看看");
    expect(within(line).getByRole("link", { name: "去记忆宫殿看看" }).getAttribute("href")).toBe(`/agents/${AG1}`);
  });

  it("the contacts page says it above the requests waiting on my Agents, once for each Agent", async () => {
    const waiting = [
      { agentId: AG1, subject: { id: BO, handle: "bo", displayName: "阿波", avatarVersion: 0, kind: "human" }, since: "2026-11-16T00:00:00Z", until: "2026-11-23T12:00:00Z" },
      { agentId: AG1, subject: { id: ANN, handle: "ann", displayName: "小安", avatarVersion: 0, kind: "human" }, since: "2026-11-16T00:00:00Z", until: "2026-11-23T12:00:00Z" },
    ];
    await openApp2([], [], { approveAgentContact: vi.fn(async () => ({ ok: true })), declineAgentContact: vi.fn(async () => ({ ok: true })) }, { mine: [], waiting });
    await goContacts();
    const lines = screen.getAllByText(/可能用到保险箱以外的记忆/);
    expect(lines.map((l) => l.textContent)).toEqual(["小助手和别人聊天时，可能用到保险箱以外的记忆。去记忆宫殿看看"]);
  });
});
