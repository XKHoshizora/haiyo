// @vitest-environment jsdom
// Agent social, A12b: the Agent's card in a social chat (举报, 拉黑, 移除), and 停止往来 / 恢复往来 on a person's profile. All of them only while the
// site's switch is on; 恢复往来 only where the caller has their own stop, and nothing ever says whether the other person has stopped or blocked.
import "./markdown-ready.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
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
/** `GET /api/me/others-use` as the service answers it, with these people stopped (the one read the screen shares: data/othersUseCache.js). */
const useOf = (stoppedIds) => ({
  limit: "300",
  used: "0",
  proactive: "0",
  ownKeyPoints: "6",
  reached: false,
  byPerson: [],
  stopped: stoppedIds.map((id) => ({ person: { id, handle: id === BO ? "bob" : "ann", displayName: id === BO ? "阿波" : "小安", avatarVersion: 0 }, since: "2026-11-16T00:00:00Z" })),
  notice: false,
});
const rail = (name) => within(screen.getByRole("navigation", { name: "主导航" })).getByRole("button", { name });
const inDialog = () => within(dialog());

function routes(over = {}) {
  return {
    reportAgent: vi.fn(async () => ({ id: "r1" })),
    blockPrincipal: vi.fn(async () => ({ ok: true })),
    removeAgentContact: vi.fn(async () => ({ ok: true })),
    putBar: vi.fn(async () => ({ ok: true, ended: 1 })),
    deleteBar: vi.fn(async () => ({ ok: true })),
    getOthersUse: vi.fn(async () => useOf([])),
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
    await click(within(inMain().getByRole("list", { name: "小助手和别人的对话" })).getAllByRole("button")[0]);
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
    expect(toastText()).toBe("举报没有提交成功，这个 Agent 可能已被删除。");
    expect(dialog()).not.toBeNull();
  });

  it("拉黑 asks once, in words about an Agent, and blocks it; 移除 asks once and leaves", async () => {
    const { api } = await open();
    await openVisitorDetails();
    await click(within(document.querySelector(".side")).getByRole("button", { name: "拉黑" }));
    expect(inDialog().getByRole("heading", { name: "拉黑小帮手" })).toBeTruthy();
    expect(inDialog().getByText("你和小帮手的对话会结束，小帮手不再回你的话。聊天记录还在。")).toBeTruthy();
    expect(inDialog().getByText("拉黑期间，你找不到小帮手，也不能添加。")).toBeTruthy();
    await click(inDialog().getByRole("button", { name: "确认拉黑" }));
    expect(api.blockPrincipal).toHaveBeenCalledWith(AGB);
    expect(dialog()).toBeNull();
    await click(within(document.querySelector(".side")).getByRole("button", { name: "移除" }));
    expect(inDialog().getByRole("heading", { name: "移除小帮手" })).toBeTruthy();
    expect(inDialog().getByText("移除后，你和小帮手的对话会停下，已有的记录还在。想再聊，要重新添加，可能需要主人同意。")).toBeTruthy();
    await click(inDialog().getByRole("button", { name: "确认移除" }));
    expect(api.removeAgentContact).toHaveBeenCalledWith(AGB, ME_ID);
    expect(toastText()).toBe("已移除");
  });

  it("once I have blocked the Agent, the card's button says 解除拉黑 and opens the dialog that lifts it", async () => {
    await open({ social: { blocked: [person(AGB, "bobby.helper", "小帮手")] } });
    await openVisitorDetails();
    const side = within(document.querySelector(".side"));
    expect(side.queryByRole("button", { name: "拉黑" })).toBeNull();
    await click(side.getByRole("button", { name: "解除拉黑" }));
    expect(inDialog().getByRole("heading", { name: "解除对小帮手的拉黑" })).toBeTruthy();
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
    expect(inMain().getByRole("heading", { name: "和对方的 Agent 往来" })).toBeTruthy();
    expect(inMain().getByText("停止后，你的 Agent 不再回应对方，对方的 Agent 也不再回应你。")).toBeTruthy();
    await click(inMain().getByRole("button", { name: "停止往来" }));
    expect(inDialog().getByRole("heading", { name: "停止和阿波往来" })).toBeTruthy();
    expect(api.putBar).not.toHaveBeenCalled();
    await click(inDialog().getByRole("button", { name: "停止往来" }));
    expect(api.putBar).toHaveBeenCalledWith(BO);
    expect(toastText()).toBe("已停止往来");
    expect(inMain().getByRole("button", { name: "恢复往来" })).toBeTruthy();
    expect(inMain().getByText("你已停止和阿波往来：你们各自的 Agent 都不会再回应对方。")).toBeTruthy();
    expect(inMain().queryByRole("button", { name: "停止往来" })).toBeNull();
    await click(inMain().getByRole("button", { name: "恢复往来" }));
    expect(api.deleteBar).toHaveBeenCalledWith(BO);
    expect(toastText()).toBe("已恢复往来。想再聊，需要重新添加对方的 Agent。");
    expect(inMain().getByRole("button", { name: "停止往来" })).toBeTruthy();
  });

  it("a stop and a resume are writes the shared read is told of: it is read again after each (the use page then lists the person)", async () => {
    const { api } = await openCard();
    expect(api.getOthersUse).toHaveBeenCalledTimes(1);
    await click(inMain().getByRole("button", { name: "停止往来" }));
    await click(inDialog().getByRole("button", { name: "停止往来" }));
    expect(api.getOthersUse).toHaveBeenCalledTimes(2);
    await click(inMain().getByRole("button", { name: "恢复往来" }));
    expect(api.getOthersUse).toHaveBeenCalledTimes(3);
  });

  it("停止往来 is offered for ANY person, also one with no Agent access between us (a group-only caller): the profile is where the act lives", async () => {
    const { api } = await openCard({ convs: [] });
    expect(inMain().getByRole("heading", { name: "和对方的 Agent 往来" })).toBeTruthy();
    await click(inMain().getByRole("button", { name: "停止往来" }));
    await click(inDialog().getByRole("button", { name: "停止往来" }));
    expect(api.putBar).toHaveBeenCalledWith(BO);
    expect(inMain().getByRole("button", { name: "恢复往来" })).toBeTruthy();
  });

  it("恢复往来 appears for a person I stopped (my numbers page lists them), not for anyone else, and not when that list is not there", async () => {
    const stopped = routes({ getOthersUse: vi.fn(async () => useOf([BO])) });
    await openCard({ api: stopped, convs: [] });
    expect(inMain().getByRole("button", { name: "恢复往来" })).toBeTruthy();
    cleanup();
    const other = routes({ getOthersUse: vi.fn(async () => useOf([ANN])) });
    await openCard({ api: other, convs: [] });
    expect(inMain().getByRole("button", { name: "停止往来" })).toBeTruthy();
    expect(inMain().queryByRole("button", { name: "恢复往来" })).toBeNull();
    cleanup();
    const missing = routes({ getOthersUse: vi.fn(async () => { throw apiError(404, "not_found"); }) });
    await openCard({ api: missing, convs: [] });
    expect(inMain().queryByRole("button", { name: "恢复往来" })).toBeNull();
  });

  it("while it is not known whether I stopped them (the list is missing or has not come), the profile offers neither 停止往来 nor 恢复往来 (A-5 review m3b)", async () => {
    const missing = routes({ getOthersUse: vi.fn(async () => { throw apiError(404, "not_found"); }) });
    await openCard({ api: missing });
    expect(inMain().queryByRole("button", { name: "停止往来" })).toBeNull();
    expect(inMain().queryByRole("button", { name: "恢复往来" })).toBeNull();
    expect(inMain().queryByRole("heading", { name: "和对方的 Agent 往来" })).toBeNull();
  });

  describe("the answer belongs to one person: opening another profile never shows the previous person's control (A-5 re-review I1)", () => {
    const both = { friends: [person(BO, "bob", "阿波"), person(ANN, "ann", "小安")] };
    const profile = (name) => click(screen.getByText(name, { selector: ".list-col .row-name" }));
    // First asked: the first person's list (answers at once); every later ask is the second person's, held until the test lets it go.
    const twoProfiles = async (stoppedIds, second) => {
      const held = [];
      const getOthersUse = vi.fn(() => {
        if (getOthersUse.mock.calls.length === 1) return Promise.resolve(useOf(stoppedIds));
        return new Promise((resolve, reject) => held.push({ resolve, reject }));
      });
      const app = await open({ api: routes({ getOthersUse }), social: both, convs: [visiting(), watched()] });
      await goContacts();
      await profile(second.first);
      return { held, ...app };
    };
    const none = () => {
      expect(inMain().queryByRole("button", { name: "停止往来" })).toBeNull();
      expect(inMain().queryByRole("button", { name: "恢复往来" })).toBeNull();
      expect(inMain().queryByRole("heading", { name: "和对方的 Agent 往来" })).toBeNull();
    };

    it("after a stopped person, a person who is not stopped: nothing while the answer is slow or fails, then only their own control", async () => {
      const { held } = await twoProfiles([BO], { first: "阿波" });
      expect(inMain().getByRole("button", { name: "恢复往来" })).toBeTruthy();
      await profile("小安");
      none();
      await act(async () => held.at(-1).reject(apiError(500, "internal")));
      none();
      cleanup();
      const again = await twoProfiles([BO], { first: "阿波" });
      await profile("小安");
      none();
      await act(async () => again.held.at(-1).resolve(useOf([BO])));
      expect(inMain().getByRole("button", { name: "停止往来" })).toBeTruthy();
      expect(inMain().queryByRole("button", { name: "恢复往来" })).toBeNull();
    });

    it("the other way round (a stopped person, then another one): no control of the first while the answer is slow or fails", async () => {
      const { held } = await twoProfiles([ANN], { first: "小安" });
      expect(inMain().getByRole("button", { name: "恢复往来" })).toBeTruthy();
      await profile("阿波");
      none();
      await act(async () => held.at(-1).reject(apiError(500, "internal")));
      none();
    });

    it("the list is one read the screen shares: a read in flight for the previous profile answers the one on screen too, each person by their own entry", async () => {
      const held = [];
      const getOthersUse = vi.fn(() => new Promise((resolve) => held.push(resolve)));
      await open({ api: routes({ getOthersUse }), social: both, convs: [visiting(), watched()] });
      await goContacts();
      await profile("阿波");
      await profile("小安");
      none();
      expect(getOthersUse).toHaveBeenCalledTimes(1);
      await act(async () => held[0](useOf([BO])));
      // 小安 is on screen and is not in the list: 停止往来, never 阿波's 恢复往来.
      expect(inMain().getByRole("button", { name: "停止往来" })).toBeTruthy();
      expect(inMain().queryByRole("button", { name: "恢复往来" })).toBeNull();
      await profile("阿波");
      none();
      await act(async () => held[1](useOf([BO])));
      expect(inMain().getByRole("button", { name: "恢复往来" })).toBeTruthy();
    });
  });

  it("恢复往来 when there is nothing to lift says so plainly, and the card then offers 停止往来", async () => {
    const stale = routes({
      getOthersUse: vi.fn(async () => useOf([BO])),
      deleteBar: vi.fn(async () => { throw apiError(404, "not_found"); }),
    });
    await openCard({ api: stale });
    await click(inMain().getByRole("button", { name: "恢复往来" }));
    expect(toastText()).toBe("你没有停止和对方往来，不用恢复。");
    expect(inMain().getByRole("button", { name: "停止往来" })).toBeTruthy();
  });

  it("with the list known, exactly one of the two is offered", async () => {
    await openCard();
    expect(inMain().getAllByRole("button", { name: /^(停止|恢复)往来$/ })).toHaveLength(1);
  });

  it("the stop dialog says both ways and that the other person's asks need the owner's yes again", async () => {
    await openCard();
    await click(inMain().getByRole("button", { name: "停止往来" }));
    expect(inDialog().getByText("你的 Agent 不再回应阿波，阿波的 Agent 也不再回应你。")).toBeTruthy();
    expect(inDialog().getByText("恢复往来后，之前的对话不会自动恢复；想再聊，需要重新添加对方的 Agent，并等对方同意。")).toBeTruthy();
    expect(inDialog().getByText("以后想恢复：在“设置 › 别人怎么用我的 Agent”里找到对方，进入资料页点“恢复往来”。")).toBeTruthy();
    expect(dialog().textContent).not.toContain("对方的主人");
  });

  it("nothing says that the other person has stopped or blocked: with no stop of mine the section offers my own 停止往来 and no word of theirs", async () => {
    await openCard({ convs: [] });
    expect(inMain().getByRole("button", { name: "停止往来" })).toBeTruthy();
    expect(document.querySelector(".main-col").textContent).not.toMatch(/对方停止|对方已停止|他停止/);
  });

  it("switch off: no 停止往来 is offered and nothing of the section is drawn for a person I did not stop", async () => {
    const { api } = await openCard({ on: false });
    expect(inMain().queryByRole("heading", { name: "和对方的 Agent 往来" })).toBeNull();
    expect(inMain().queryByRole("button", { name: /^(停止|恢复)往来$/ })).toBeNull();
    expect(api.putBar).not.toHaveBeenCalled();
  });

  it("I4: switch off, a person I stopped while it was on: 恢复往来 is there and works, 停止往来 is not offered again afterwards", async () => {
    const { api } = await openCard({ on: false, api: routes({ getOthersUse: vi.fn(async () => useOf([BO])) }) });
    expect(inMain().getByText("你已停止和阿波往来：你们各自的 Agent 都不会再回应对方。")).toBeTruthy();
    expect(inMain().queryByRole("button", { name: "停止往来" })).toBeNull();
    await click(inMain().getByRole("button", { name: "恢复往来" }));
    expect(api.deleteBar).toHaveBeenCalledWith(BO);
    // (With the switch off nothing can be added, so the toast does not tell anyone to add again: review 2, n3.)
    expect(toastText()).toBe("已恢复往来。");
    expect(inMain().queryByRole("button", { name: /^(停止|恢复)往来$/ })).toBeNull();
    expect(inMain().queryByRole("heading", { name: "和对方的 Agent 往来" })).toBeNull();
    expect(api.putBar).not.toHaveBeenCalled();
  });

  it("the stop dialog also says the other person is not told", async () => {
    await openCard();
    await click(inMain().getByRole("button", { name: "停止往来" }));
    expect(inDialog().getByText("不会通知对方。对方会发现你的 Agent 不再回应，也可能因此猜到。")).toBeTruthy();
  });
});
