// @vitest-environment jsdom
// Agent social, A12a: the social chat. The header says who watches (a participant: always the disclosure; the supervising owner: what their
// words become); a supervising owner's words carry 主人 by the membership role alone; the visitor sees the Agent replying as a group member
// does, never a run; the composer's refusal is said once by the service's reason; the chat list holds only the conversations I speak in.
import "./markdown-ready.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { A1, AG1, ANN, BO, MODELS, ME_ID, PRINCIPALS, agentConv, agentOf, agentPrincipal, syncOf, usageOf, wire } from "./fixtures.js";
import { click, flush, inMain, installBrowser, openApp, push } from "./harness.jsx";

beforeEach(installBrowser);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const AGB = "00000000-0000-4000-8000-0000000000b2"; // BO's Agent
const SV = "00000000-0000-4000-8000-000000003001"; // I speak with AGB
const SO = "00000000-0000-4000-8000-000000003002"; // I watch AG1 with ANN
const PEOPLE = [...PRINCIPALS, { ...agentPrincipal(AGB), ownerId: BO, displayName: "小帮手", handle: "bob.helper" }, { ...agentPrincipal(AG1), ownerId: ME_ID }];
const visiting = (fields = {}) => ({
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
  lastSeq: 3,
  readSeq: 3,
  unread: 0,
  ...fields,
});
const watched = (fields = {}) => ({
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
  unread: 3,
  ...fields,
});

async function openApp2(convs, messages, extra = {}) {
  return openApp({
    sync: () => ({ ...syncOf([agentConv(A1, AG1), ...convs], messages, PEOPLE), social: { enabled: true } }),
    api: { getModels: vi.fn(async () => MODELS), listProviders: vi.fn(async () => ({ providers: [] })), getUsage: vi.fn(async () => usageOf()), listAgents: vi.fn(() => new Promise(() => {})), getAgentContacts: vi.fn(async () => ({ policy: "ask", picked: false, picks: [], rows: [], conversations: [] })), ...extra.api },
    handlers: { agents: () => ({ agents: [agentOf(AG1, { model: { source: "site", id: "free-1" } })] }), models: () => MODELS, ...extra.handlers },
  });
}
const openVisitor = async (conv = visiting(), messages = [wire(SV, 1, ME_ID, "你好"), wire(SV, 2, AGB, "你好呀"), wire(SV, 3, BO, "我是它的主人")], extra) => {
  const app = await openApp2([conv], messages, extra);
  await click(screen.getByText("小帮手", { selector: ".list-col .row-name" }));
  return app;
};
const rail = (name) => within(screen.getByRole("navigation", { name: "主导航" })).getByRole("button", { name });
const messageList = () => document.querySelector("ol.messages");
const nameLines = () => [...messageList().querySelectorAll(".msg-meta")].map((m) => m.textContent.replace(/\d{1,2}:\d{2}/g, "").trim());

describe("the header", () => {
  it("a participant always reads the disclosure with the owner's name; the title is the Agent, and it is the page's one h2", async () => {
    await openVisitor();
    const note = screen.getByTestId("social-note");
    expect(note.textContent).toBe("这是阿波的 Agent。阿波能看到你们的对话，也可能插话。");
    expect(within(inMain().getByRole("banner")).getByRole("heading", { level: 2 }).textContent).toContain("小帮手");
    expect(inMain().getAllByRole("heading", { level: 2 })).toHaveLength(1);
    // It sits in the chat column, wrapping inside it.
    expect(note.closest(".chat")).not.toBeNull();
  });

  it("the owner who watches reads the supervision line and the composer is theirs to write as 主人", async () => {
    await openApp2([watched()], [wire(SO, 1, ANN, "在吗"), wire(SO, 2, AG1, "在的")]);
    fireEvent.click(rail(/^Agent/));
    await flush();
    await click(within(document.querySelector(".list-col")).getByText("小助手", { selector: ".row-name" }));
    await click(inMain().getByRole("tab", { name: "别人" }));
    await click(within(inMain().getByRole("list", { name: "它和别人的对话" })).getAllByRole("button")[0]);
    expect(screen.getByTestId("social-note").textContent).toBe("你在旁观小助手和小安的对话。你发言时，对方会看到你是主人。");
    expect(screen.queryByText(/能看到你们的对话/)).toBeNull();
    // (Nobody to @ in a two-party conversation: the hint says in whose name the owner writes.)
    expect(screen.getByRole("textbox", { name: "消息内容" }).getAttribute("placeholder")).toBe("以主人的身份发言");
  });
});

describe("the 主人 label", () => {
  it("is on the supervising owner's words only, decided by the membership role: a visitor named 「主人」 gets none", async () => {
    const named = PEOPLE.map((p) => (p.id === ANN ? { ...p, displayName: "主人" } : p));
    await openApp({
      sync: () => ({ ...syncOf([watched()], [wire(SO, 1, ANN, "你好"), wire(SO, 2, AG1, "你好呀"), wire(SO, 3, ME_ID, "我在旁边")], named), social: { enabled: true } }),
      api: { listProviders: vi.fn(async () => ({ providers: [] })), getAgentContacts: vi.fn(async () => ({ policy: "ask", picked: false, picks: [], rows: [], conversations: [] })), getModels: vi.fn(async () => MODELS), getUsage: vi.fn(async () => usageOf()), listAgents: vi.fn(() => new Promise(() => {})) },
      handlers: { agents: () => ({ agents: [agentOf(AG1, { model: { source: "site", id: "free-1" } })] }), models: () => MODELS },
    });
    fireEvent.click(rail(/^Agent/));
    await flush();
    await click(within(document.querySelector(".list-col")).getByText("小助手", { selector: ".row-name" }));
    await click(inMain().getByRole("tab", { name: "别人" }));
    await click(within(inMain().getByRole("list", { name: "它和别人的对话" })).getAllByRole("button")[0]);
    const metas = [...messageList().querySelectorAll(".msg-meta")];
    const tags = (m) => [...m.querySelectorAll(".tag")].map((t) => t.textContent);
    // The visitor, whose name is 「主人」, has no label; my Agent has its Agent tag; I, who watch, am marked 主人.
    expect(metas[0].querySelector("strong").textContent).toBe("主人");
    expect(tags(metas[0])).toEqual([]);
    expect(tags(metas[1])).toEqual(["Agent"]);
    expect(tags(metas[2])).toEqual(["主人"]);
  });
});

describe("the Agent replying", () => {
  it("the visitor sees it as a group member does: 正在回复… and its name, never a run (the reduced push is all that is read)", async () => {
    const { transport } = await openVisitor();
    await push(transport, { type: "run", conversationId: SV, agentId: AGB, state: "replying", run: { id: "RUN-SECRET-1", status: "running" } });
    const rows = [...messageList().querySelectorAll("li.streaming")];
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("正在回复…");
    expect(rows[0].textContent).toContain("小帮手");
    expect(within(rows[0]).queryByRole("button")).toBeNull();
    expect(document.body.innerHTML).not.toContain("RUN-SECRET-1");
    await push(transport, { type: "message", message: wire(SV, 4, AGB, "好的") });
    expect(messageList().querySelectorAll("li.streaming")).toHaveLength(0);
  });
});

describe("the composer", () => {
  it.each([
    ["no_access", "你现在不能和它聊天了。"],
    ["agent_unavailable", "这个 Agent 现在不可用。"],
    ["blocked", "你现在不能和它聊天了。"],
  ])("%s: the reason is said once and no input is offered", async (reason, text) => {
    await openVisitor(visiting({ canSend: { ok: false, reason } }));
    expect(screen.getAllByText(text)).toHaveLength(1);
    expect(screen.queryByRole("textbox", { name: "消息内容" })).toBeNull();
    expect(document.querySelector("footer.composer")).toBeNull();
  });

  it("never says whose stop or block ended it: the text is the same whichever it was", async () => {
    await openVisitor(visiting({ canSend: { ok: false, reason: "no_access" } }));
    expect(document.querySelector(".main-col").textContent).not.toMatch(/停止往来|拉黑|对方已/);
  });

  it("an open conversation has its composer; with one Agent there is nobody to @, so it just says to write", async () => {
    await openVisitor();
    expect(screen.getByRole("textbox", { name: "消息内容" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "消息内容" }).getAttribute("placeholder")).toBe("发送消息");
  });
});

describe("the chat list", () => {
  it("holds the conversations I speak in, with the Agent's name and tag, and none I only watch; the tab bar's number leaves them out", async () => {
    await openApp2([visiting({ unread: 2 }), watched({ unread: 3 })], [wire(SV, 1, AGB, "嗨"), wire(SO, 1, ANN, "在吗")]);
    const rows = [...document.querySelectorAll(".list-col .rows .row-name")].map((x) => x.textContent);
    expect(rows).toContain("小帮手");
    expect(rows).not.toContain("小助手和小安");
    expect(rows.filter((r) => r.includes("小安"))).toEqual([]);
    const badges = [...document.querySelectorAll(".tabbar .badge, nav .badge")].map((b) => b.textContent);
    for (const b of badges) expect(Number(b)).toBeLessThanOrEqual(2);
  });
});
