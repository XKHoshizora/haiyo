// @vitest-environment jsdom
// Agent social, A12b: the Agent's card in a social chat (举报, 拉黑, 移除), and 停止往来 / 恢复往来 on a person's profile. All of them only while the
// site's switch is on; 恢复往来 only where the caller has their own stop, and nothing ever says whether the other person has stopped or blocked.
import "./markdown-ready.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { A1, AG1, ANN, BO, ME_ID, MODELS, PRINCIPALS, agentConv, agentOf, agentPrincipal, apiError, syncOf, usageOf, wire } from "./fixtures.js";
import { button, click, dialog, flush, goContacts, inMain, installBrowser, openApp, toastText } from "./harness.jsx";

beforeEach(installBrowser);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const AGB = "00000000-0000-4000-8000-0000000000b2";
const SV = "00000000-0000-4000-8000-000000004001";
const SO = "00000000-0000-4000-8000-000000004002";
const PEOPLE = [...PRINCIPALS, { ...agentPrincipal(AGB), ownerId: BO, displayName: "小帮手", handle: "bobby.helper" }, { ...agentPrincipal(AG1), ownerId: ME_ID }];
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
  lastSeq: 1,
  readSeq: 1,
  unread: 0,
});
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
  lastSeq: 1,
  readSeq: 1,
  unread: 0,
});
const person = (id, handle, displayName) => ({ id, handle, displayName, avatarVersion: 0 });
const rail = (name) => within(screen.getByRole("navigation", { name: "主导航" })).getByRole("button", { name });
const inDialog = () => within(dialog());

function routes(over = {}) {
  return {
    reportAgent: vi.fn(async () => ({ id: "r1" })),
    blockPrincipal: vi.fn(async () => ({ ok: true })),
    removeAgentContact: vi.fn(async () => ({ ok: true })),
    putBar: vi.fn(async () => ({ ok: true, ended: 1 })),
    deleteBar: vi.fn(async () => ({ ok: true })),
    getOthersUse: vi.fn(async () => ({ stopped: [] })),
    getModels: vi.fn(async () => MODELS),
    listProviders: vi.fn(async () => ({ providers: [] })),
    getUsage: vi.fn(async () => usageOf()),
    listAgents: vi.fn(() => new Promise(() => {})),
    getAgentContacts: vi.fn(async () => ({ policy: "ask", picked: false, picks: [], rows: [], conversations: [] })),
    ...over,
  };
}
async function open({ on = true, convs = [visiting()], social = {}, api = routes() } = {}) {
  const app = await openApp({
    sync: () => ({ ...syncOf([agentConv(A1, AG1), ...convs], [wire(SV, 1, AGB, "你好")], PEOPLE), ...(on ? { social: { enabled: true } } : {}) }),
    social: { friends: [], incoming: [], outgoing: [], blocked: [], blockedBy: [], ...social },
    api,
    handlers: { agents: () => ({ agents: [agentOf(AG1, { model: { source: "site", id: "free-1" } })] }), models: () => MODELS },
  });
  return { ...app, api };
}
const openVisitorDetails = async () => {
  await click(screen.getByText("小帮手", { selector: ".list-col .row-name" }));
  await click(screen.getByRole("button", { name: "会话资料" }));
};

describe("the Agent's card in a social chat", () => {
  it("offers 举报, 拉黑 and 移除 to the visitor, and none of them to the owner who watches", async () => {
    await open({ convs: [visiting(), watched()] });
    await openVisitorDetails();
    const side = within(document.querySelector(".side"));
    for (const name of ["举报", "拉黑", "移除"]) expect(side.getByRole("button", { name })).toBeTruthy();
    cleanup();
    await open({ convs: [watched()] });
    fireEvent.click(rail(/^Agent/));
    await flush();
    await click(within(document.querySelector(".list-col")).getByText("小助手", { selector: ".row-name" }));
    await click(inMain().getByRole("tab", { name: "别人" }));
    await click(within(inMain().getByRole("list", { name: "它和别人的对话" })).getAllByRole("button")[0]);
    await click(screen.getByRole("button", { name: "会话资料" }));
    const owner = within(document.querySelector(".side"));
    for (const name of ["举报", "拉黑", "移除"]) expect(owner.queryByRole("button", { name })).toBeNull();
    expect(owner.getByRole("button", { name: "管理这个 Agent" })).toBeTruthy();
  });

  it("举报 asks for one of four reasons and an optional note of at most 500; the route gets the Agent, the reason and the note", async () => {
    const { api } = await open();
    await openVisitorDetails();
    await click(within(document.querySelector(".side")).getByRole("button", { name: "举报" }));
    expect(inDialog().getByRole("heading", { name: "举报小帮手" })).toBeTruthy();
    const reasons = inDialog().getAllByRole("radio");
    expect(reasons.map((r) => r.parentElement.textContent)).toEqual(["垃圾信息或广告", "骚扰", "泄露隐私", "其他"]);
    expect(inDialog().getByRole("textbox").maxLength).toBe(500);
    fireEvent.click(inDialog().getByRole("radio", { name: "骚扰" }));
    fireEvent.change(inDialog().getByRole("textbox"), { target: { value: "  一直发广告  " } });
    await click(inDialog().getByRole("button", { name: "提交举报" }));
    expect(api.reportAgent).toHaveBeenCalledWith({ agentId: AGB, reason: "harassment", note: "一直发广告" });
    expect(toastText()).toBe("已提交举报");
    expect(dialog()).toBeNull();
  });

  it("without a note, none is sent; a report that cannot be made says so and the dialog stays", async () => {
    const api = routes({ reportAgent: vi.fn(async () => { throw apiError(404, "not_found"); }) });
    await open({ api });
    await openVisitorDetails();
    await click(within(document.querySelector(".side")).getByRole("button", { name: "举报" }));
    await click(inDialog().getByRole("button", { name: "提交举报" }));
    expect(api.reportAgent).toHaveBeenCalledWith({ agentId: AGB, reason: "spam" });
    expect(toastText()).toBe("现在没法举报它，它可能已经不在了。");
    expect(dialog()).not.toBeNull();
  });

  it("拉黑 asks once, in words about an Agent, and blocks it; 移除 asks once and leaves", async () => {
    const { api } = await open();
    await openVisitorDetails();
    await click(within(document.querySelector(".side")).getByRole("button", { name: "拉黑" }));
    expect(inDialog().getByRole("heading", { name: "拉黑小帮手" })).toBeTruthy();
    expect(inDialog().getByText("你和它的对话会结束，你让它做的事会停下，已有历史不受影响。")).toBeTruthy();
    await click(inDialog().getByRole("button", { name: "确认拉黑" }));
    expect(api.blockPrincipal).toHaveBeenCalledWith(AGB);
    expect(dialog()).toBeNull();
    await click(within(document.querySelector(".side")).getByRole("button", { name: "移除" }));
    expect(inDialog().getByRole("heading", { name: "移除小帮手" })).toBeTruthy();
    await click(inDialog().getByRole("button", { name: "确认移除" }));
    expect(api.removeAgentContact).toHaveBeenCalledWith(AGB, ME_ID);
    expect(toastText()).toBe("已移除");
  });

  it("switch off: none of the three is offered", async () => {
    await open({ on: false });
    await openVisitorDetails();
    const side = within(document.querySelector(".side"));
    for (const name of ["举报", "拉黑", "移除"]) expect(side.queryByRole("button", { name })).toBeNull();
  });
});

describe("停止往来 and 恢复往来 on a person's profile", () => {
  const withBo = { friends: [person(BO, "bob", "阿波")] };
  const openCard = async (o = {}) => {
    const app = await open({ social: withBo, ...o });
    await goContacts();
    await click(screen.getByText("阿波", { selector: ".list-col .row-name" }));
    return app;
  };

  it("where we have Agent access: 停止往来 asks once, writes my stop, and the card then offers 恢复往来", async () => {
    const { api } = await openCard();
    expect(inMain().getByRole("heading", { name: "Agent 往来" })).toBeTruthy();
    await click(inMain().getByRole("button", { name: "停止往来" }));
    expect(inDialog().getByRole("heading", { name: "停止和阿波往来" })).toBeTruthy();
    expect(api.putBar).not.toHaveBeenCalled();
    await click(inDialog().getByRole("button", { name: "停止往来" }));
    expect(api.putBar).toHaveBeenCalledWith(BO);
    expect(toastText()).toBe("已停止往来");
    expect(inMain().getByRole("button", { name: "恢复往来" })).toBeTruthy();
    expect(inMain().queryByRole("button", { name: "停止往来" })).toBeNull();
    await click(inMain().getByRole("button", { name: "恢复往来" }));
    expect(api.deleteBar).toHaveBeenCalledWith(BO);
    expect(inMain().getByRole("button", { name: "停止往来" })).toBeTruthy();
  });

  it("恢复往来 appears for a person I stopped (my numbers page lists them), not for anyone else, and not when that list is not there", async () => {
    const stopped = routes({ getOthersUse: vi.fn(async () => ({ stopped: [{ person: BO, since: "2026-11-16T00:00:00Z" }] })) });
    await openCard({ api: stopped, convs: [] });
    expect(inMain().getByRole("button", { name: "恢复往来" })).toBeTruthy();
    cleanup();
    const other = routes({ getOthersUse: vi.fn(async () => ({ stopped: [{ person: ANN, since: "2026-11-16T00:00:00Z" }] })) });
    await openCard({ api: other, convs: [] });
    expect(inMain().queryByRole("heading", { name: "Agent 往来" })).toBeNull();
    expect(inMain().queryByRole("button", { name: "恢复往来" })).toBeNull();
    cleanup();
    const missing = routes({ getOthersUse: vi.fn(async () => { throw apiError(404, "not_found"); }) });
    await openCard({ api: missing, convs: [] });
    expect(inMain().queryByRole("button", { name: "恢复往来" })).toBeNull();
  });

  it("nothing says that the other person has stopped or blocked: with no stop of mine and no access, there is no such section at all", async () => {
    await openCard({ convs: [] });
    expect(inMain().queryByRole("heading", { name: "Agent 往来" })).toBeNull();
    expect(document.querySelector(".main-col").textContent).not.toMatch(/对方停止|对方已停止|他停止/);
  });

  it("switch off: nothing of it is drawn and no route is called", async () => {
    const { api } = await openCard({ on: false });
    expect(inMain().queryByRole("heading", { name: "Agent 往来" })).toBeNull();
    expect(api.getOthersUse).not.toHaveBeenCalled();
    expect(api.putBar).not.toHaveBeenCalled();
  });
});
