// @vitest-environment jsdom
// Finding someone's Agent (find-agent design, rulings D1-D10): the add dialog searches my circle as I type (300 ms after the last key, the
// newest request wins, a refusal of the suggestions is quiet) and an exact account name on 查找 / Enter; every Agent found ends in the one
// card (its disclosure before 添加{name}); a person opens their profile with their Agents; a group's members are buttons of their own; a
// share link `/a/<id>` opens the card. While the site's switch is off none of it is drawn and no route of it is called.
import "./markdown-ready.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { A1, AG1, ANN, BO, G1, ME_ID, PRINCIPALS, agentConv, agentOf, agentPrincipal, apiError, deferred, group, syncOf } from "./fixtures.js";
import { DORA, NOW, PEOPLE, button, click, dialog, elapse, flush, goContacts, inMain, installBrowser, openApp, push, toastText } from "./harness.jsx";

beforeEach(installBrowser);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const AGF = "00000000-0000-4000-8000-0000000000b3"; // 小安's Agent (a friend's)
const AGG = "00000000-0000-4000-8000-0000000000b4"; // 阿波's Agent, in a group with me
const AGC = "00000000-0000-4000-8000-0000000000b5"; // an Agent I added
const AGS = "00000000-0000-4000-8000-0000000000b6"; // a stranger's Agent
const STR = "00000000-0000-4000-8000-0000000000a7"; // a stranger
const SC = "00000000-0000-4000-8000-000000001001";

/** An Agent's card as the service answers it (the lookup's: `field` too). */
const profile = (id, handle, displayName, ownerId, ownerName, intro = "", field = "") => ({ id, handle, displayName, avatarVersion: 0, kind: "agent", ownerId, ownerName, intro, field });
const person = (id, handle, displayName) => ({ id, handle, displayName, avatarVersion: 0 });
const CIRCLE = [
  person(ANN, "ann", "小安"),
  { ...profile(AGF, "ann.helper", "安安", ANN, "小安", "帮小安记事"), via: "friend" },
  { ...profile(AGG, "bo.cook", "厨师", BO, "阿波"), via: "group" },
  { ...profile(AGC, "dora.tutor", "家教", DORA, "朵拉"), via: "contact" },
];
const STRANGER = { person: person(STR, "stranger", "陌生人"), agents: [profile(AGS, "stranger.guide", "向导", STR, "陌生人", "带你走走")] };

const LANE_A = ["addAgentContact", "approveAgentContact", "declineAgentContact", "removeAgentContact", "getAgentContacts", "putContactPolicy", "putBar", "deleteBar", "reportAgent"];
function routes(over = {}) {
  const api = Object.fromEntries(LANE_A.map((name) => [name, vi.fn(async () => ({ ok: true }))]));
  return {
    ...api,
    searchPrincipals: vi.fn(async (q, { exact } = {}) => (exact ? { circle: CIRCLE, exact: null } : { circle: CIRCLE })),
    agentCard: vi.fn(async () => {
      throw apiError(404, "not_found");
    }),
    sendFriendRequest: vi.fn(async () => ({ id: "r1" })),
    ...over,
  };
}
/** My conversation with 阿波's 厨师 once it let me in (a social conversation, 阿波 watching). */
const visiting = () => ({
  id: SC,
  type: "agent_social",
  title: null,
  myRole: "speaker",
  closed: false,
  canSend: { ok: true },
  social: { participants: [ME_ID, AGG], agents: [{ id: AGG, ownerId: BO }] },
  members: [
    { id: ME_ID, role: "speaker", isCreator: false },
    { id: AGG, role: "speaker", isCreator: false },
    { id: BO, role: "observer", isCreator: false },
  ],
  lastSeq: 0,
  readSeq: 0,
  unread: 0,
});
const MY_AGENT = { ...agentPrincipal(AG1), ownerId: ME_ID };
const GROUP_AGENT = { ...agentPrincipal(AGG, "bo.cook", "厨师"), ownerId: BO };
async function open({ on = true, convs = [], principals = [...PRINCIPALS, MY_AGENT], social, api = routes(), contacts = { mine: [], waiting: [] }, handlers = {} } = {}) {
  const app = await openApp({
    sync: () => ({ ...syncOf(convs, [], principals), ...(on ? { social: { enabled: true } } : {}) }),
    social,
    api,
    handlers: { agentContacts: () => contacts, ...handlers },
  });
  return { ...app, api };
}
const openAdd = async () => {
  await goContacts();
  await click(button("添加好友"));
};
const field = () => within(dialog()).getByLabelText("昵称或账号名");
const type = (value) => fireEvent.change(field(), { target: { value } });
const inDialog = () => within(dialog());
/** The dialogs open now, bottom to top. */
const dialogs = () => [...document.querySelectorAll('[role="dialog"]')];
const top = () => within(dialogs().at(-1));
const headings = () => [...dialog().querySelectorAll("h3")].map((h) => h.textContent);
const suggestCalls = (api) => api.searchPrincipals.mock.calls.filter(([, options]) => !options?.exact);

describe("the add dialog searches as I type: my circle only", () => {
  it("one request 300 ms after the last key, never the exact step; the sections in their order, each Agent by its name, the Agent tag and its owner", async () => {
    const { api } = await open();
    await openAdd();
    expect(inDialog().getByText("输入昵称或账号名。找不认识的人，要输入对方完整的账号名。")).toBeTruthy();
    type("a");
    await elapse(200);
    type("an");
    await elapse(299);
    expect(api.searchPrincipals).not.toHaveBeenCalled();
    await elapse(1);
    expect(api.searchPrincipals).toHaveBeenCalledTimes(1);
    expect(api.searchPrincipals.mock.calls[0][0]).toBe("an");
    expect(api.searchPrincipals.mock.calls[0][1]?.exact).toBeFalsy();
    expect(api.searchPrincipals.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    await flush();
    expect(headings()).toEqual(["好友", "好友的 Agent", "同群的 Agent", "已添加的 Agent"]);
    const friendAgents = inDialog().getByRole("list", { name: "好友的 Agent" });
    expect(within(friendAgents).getByText("安安")).toBeTruthy();
    expect(within(friendAgents).getByText("Agent")).toBeTruthy();
    expect(within(friendAgents).getByText("主人：小安")).toBeTruthy();
    expect(within(inDialog().getByRole("list", { name: "已添加的 Agent" })).getByText("家教")).toBeTruthy();
    // (Nothing said while the circle answers: no "not found" before 查找.)
    expect(dialog().textContent).not.toContain("没有找到");
    expect(document.body.textContent).not.toContain("它");
  });

  it("the newest request wins: an older answer that comes last is dropped, and its request was ended", async () => {
    const answers = [];
    const api = routes({
      searchPrincipals: vi.fn(() => {
        const d = deferred();
        answers.push(d);
        return d.promise;
      }),
    });
    await open({ api });
    await openAdd();
    type("an");
    await elapse(300);
    type("ann");
    await elapse(300);
    expect(api.searchPrincipals).toHaveBeenCalledTimes(2);
    expect(api.searchPrincipals.mock.calls[0][1].signal.aborted).toBe(true);
    await act(async () => answers[1].resolve({ circle: [person(ANN, "ann", "小安")] }));
    await act(async () => answers[0].resolve({ circle: CIRCLE }));
    await flush();
    expect(headings()).toEqual(["好友"]);
    expect(inDialog().queryByText("安安")).toBeNull();
  });

  it("a refused suggestion (429) is quiet: the last list stays, nothing is said", async () => {
    const api = routes();
    await open({ api });
    await openAdd();
    type("an");
    await elapse(300);
    await flush();
    expect(inDialog().getByText("安安")).toBeTruthy();
    api.searchPrincipals.mockRejectedValueOnce(apiError(429, "rate_limited"));
    type("ann");
    await elapse(300);
    await flush();
    expect(suggestCalls(api)).toHaveLength(2);
    expect(inDialog().getByText("安安")).toBeTruthy();
    expect(dialog().querySelector('[role="alert"]')).toBeNull();
    expect(toastText()).toBeNull();
  });

  it("an emptied field asks nothing and shows nothing", async () => {
    const { api } = await open();
    await openAdd();
    type("an");
    await elapse(300);
    await flush();
    type("  ");
    await elapse(300);
    await flush();
    expect(api.searchPrincipals).toHaveBeenCalledTimes(1);
    expect(headings()).toEqual([]);
  });
});

describe("the explicit step (查找, Enter): the exact account name", () => {
  it("a person's exact name: their row with 发送好友申请, and 「{name}的 Agent」 after my circle; their Agent opens the card", async () => {
    const api = routes({ searchPrincipals: vi.fn(async (q, { exact } = {}) => (exact ? { circle: [], exact: STRANGER } : { circle: [] })) });
    await open({ api });
    await openAdd();
    type("@stranger");
    await click(inDialog().getByRole("button", { name: "查找" }));
    expect(api.searchPrincipals).toHaveBeenCalledWith("stranger", expect.objectContaining({ exact: true }));
    // (The suggestion the typing had scheduled is not sent after the explicit step.)
    await elapse(400);
    expect(suggestCalls(api)).toHaveLength(0);
    const found = inDialog().getByRole("list", { name: "查找结果" });
    expect(within(found).getByText("陌生人")).toBeTruthy();
    expect(within(found).getByText("@stranger")).toBeTruthy();
    expect(headings()).toEqual(["陌生人的 Agent"]);
    await click(within(found).getByRole("button", { name: "发送好友申请" }));
    expect(api.sendFriendRequest).toHaveBeenCalledWith("stranger");
    expect(toastText()).toBe("好友申请已发送");
    // Their Agent: a row; its card (on top of the dialog) has the disclosure before 添加向导.
    await click(within(inDialog().getByRole("list", { name: "陌生人的 Agent" })).getByRole("button", { name: /向导/ }));
    expect(dialogs()).toHaveLength(2);
    expect(top().getByRole("heading", { name: "向导" })).toBeTruthy();
    const note = top().getByTestId("social-disclosure");
    expect(note.textContent).toBe("这是陌生人的 Agent。陌生人能看到你们的对话，也可能插话。");
    const add = top().getByRole("button", { name: "添加向导" });
    expect(note.compareDocumentPosition(add) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(top().getByText("带你走走")).toBeTruthy();
  });

  it("Enter is the explicit step too; the exact result is dropped once the text changes", async () => {
    const api = routes({ searchPrincipals: vi.fn(async (q, { exact } = {}) => (exact ? { circle: [], exact: STRANGER } : { circle: [] })) });
    await open({ api });
    await openAdd();
    type("stranger");
    fireEvent.submit(field().closest("form"));
    await flush();
    expect(api.searchPrincipals).toHaveBeenCalledWith("stranger", expect.objectContaining({ exact: true }));
    expect(inDialog().getByRole("list", { name: "查找结果" })).toBeTruthy();
    type("strangers");
    await flush();
    expect(inDialog().queryByRole("list", { name: "查找结果" })).toBeNull();
  });

  it("nothing found: the empty sentence; a refusal (429) says the existing sentence", async () => {
    const api = routes({ searchPrincipals: vi.fn(async (q, { exact } = {}) => (exact ? { circle: [], exact: null } : { circle: [] })) });
    await open({ api });
    await openAdd();
    type("nobody_here");
    await click(inDialog().getByRole("button", { name: "查找" }));
    expect(inDialog().getByText("没有找到。找不认识的人，要输入对方完整的账号名，例如 ann_li。")).toBeTruthy();
    api.searchPrincipals.mockRejectedValueOnce(apiError(429, "rate_limited"));
    await click(inDialog().getByRole("button", { name: "查找" }));
    expect(inDialog().getByText("操作太频繁了，请稍等一分钟再试。")).toBeTruthy();
  });

  it("a second explicit step with a new text is sent while the first is on its way; the first's late answer does not replace it", async () => {
    const answers = [];
    const api = routes({
      searchPrincipals: vi.fn((q, { exact } = {}) => {
        if (!exact) return Promise.resolve({ circle: [] });
        const d = deferred();
        answers.push(d);
        return d.promise;
      }),
    });
    await open({ api });
    await openAdd();
    type("stranger");
    fireEvent.submit(field().closest("form"));
    await flush();
    type("ann");
    fireEvent.submit(field().closest("form"));
    await flush();
    const exactCalls = api.searchPrincipals.mock.calls.filter(([, options]) => options?.exact);
    expect(exactCalls.map(([q]) => q)).toEqual(["stranger", "ann"]);
    expect(exactCalls[0][1].signal.aborted).toBe(true);
    await act(async () => answers[1].resolve({ circle: [], exact: { person: person(ANN, "ann", "小安"), agents: [] } }));
    await act(async () => answers[0].resolve({ circle: [], exact: STRANGER }));
    await flush();
    const found = inDialog().getByRole("list", { name: "查找结果" });
    expect(within(found).getByText("小安")).toBeTruthy();
    expect(within(found).queryByText("陌生人")).toBeNull();
    expect(inDialog().getByRole("button", { name: "查找" }).disabled).toBe(false);
  });

  it("an exact hit is not listed twice: the person found is left out of 好友 and their Agents out of 好友的 Agent", async () => {
    const exact = { person: person(ANN, "ann", "小安"), agents: [profile(AGF, "ann.helper", "安安", ANN, "小安")] };
    const api = routes({ searchPrincipals: vi.fn(async (q, { exact: asked } = {}) => (asked ? { circle: CIRCLE, exact } : { circle: CIRCLE })) });
    await open({ api });
    await openAdd();
    type("ann");
    await click(inDialog().getByRole("button", { name: "查找" }));
    expect(inDialog().getAllByText("小安", { selector: "strong" })).toHaveLength(1);
    expect(inDialog().getAllByText("安安")).toHaveLength(1);
    expect(headings()).toEqual(["同群的 Agent", "已添加的 Agent", "小安的 Agent"]);
  });
});

describe("the one Agent card (D9): every way of finding an Agent ends in it", () => {
  const openCard = async (api) => {
    const app = await open({ api });
    await openAdd();
    type("an");
    await elapse(300);
    await flush();
    await click(within(inDialog().getByRole("list", { name: "同群的 Agent" })).getByRole("button", { name: /厨师/ }));
    return app;
  };

  it("waiting for the owner: 「申请已发送」 once, one notice of what happens after 7 days, the button spent", async () => {
    const api = routes();
    api.addAgentContact.mockResolvedValueOnce({ state: "requested", until: new Date(NOW + 7 * 86_400_000).toISOString() });
    await openCard(api);
    expect(top().getByText("主人：阿波")).toBeTruthy();
    await click(top().getByRole("button", { name: "添加厨师" }));
    expect(api.addAgentContact).toHaveBeenCalledWith(AGG);
    expect(toastText()).toBe("申请已发送");
    expect(top().getAllByText("已发给阿波，等对方同意。7 天没有回应会自动取消。")).toHaveLength(1);
    expect(top().getByRole("button", { name: "添加厨师" }).disabled).toBe(true);
  });

  it("let in at once: 「已添加」, both dialogs close and that new conversation opens", async () => {
    const api = routes();
    const app = await openCard(api);
    // The service let me in: the conversation with 厨师 exists from now on (the sync the add asks for brings it).
    api.addAgentContact.mockImplementationOnce(async () => {
      app.env.sync = () => ({ ...syncOf([visiting()], [], [...PRINCIPALS, MY_AGENT, GROUP_AGENT]), social: { enabled: true } });
      return { state: "live", conversationId: SC };
    });
    await click(top().getByRole("button", { name: "添加厨师" }));
    expect(toastText()).toBe("已添加");
    expect(dialogs()).toHaveLength(0);
    expect(screen.getByRole("region", { name: "厨师" })).toBeTruthy();
    // (The two dialogs' history entries are left first: the address follows once the browser has stepped back over them.)
    await elapse(2100);
    expect(location.pathname).toBe(`/chat/${SC}`);
  });

  it("cooldown: the day it may be asked again; the card stays", async () => {
    const api = routes();
    api.addAgentContact.mockRejectedValueOnce(Object.assign(apiError(429, "cooldown"), { availableAt: "2026-12-24T00:00:00" }));
    await openCard(api);
    await click(top().getByRole("button", { name: "添加厨师" }));
    expect(toastText()).toBe("现在还不能再申请，2026年12月24日 以后可以。");
    expect(dialogs()).toHaveLength(2);
  });

  it("an add answered 404 (a block applied after the card was drawn): the existing sentence, the card is no longer actionable, its row leaves the list", async () => {
    const api = routes();
    api.addAgentContact.mockRejectedValueOnce(apiError(404, "not_found"));
    await openCard(api);
    await click(top().getByRole("button", { name: "添加厨师" }));
    expect(toastText()).toBe("操作没有成功，请稍后再试。");
    expect(dialogs()).toHaveLength(2);
    expect(top().queryByText(/已发给/)).toBeNull();
    expect(document.querySelector(".chat")).toBeNull();
    // What the member list would show of it: the name, the picture, the Agent tag; no button, no owner, no disclosure.
    expect(top().getByText("厨师", { selector: "strong" })).toBeTruthy();
    expect(top().getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual(["关闭"]);
    expect(top().queryByTestId("social-disclosure")).toBeNull();
    expect(dialogs().at(-1).textContent).not.toContain("主人");
    await click(top().getByRole("button", { name: "关闭" }));
    expect(inDialog().queryByText("厨师")).toBeNull();
    expect(inDialog().getByText("安安")).toBeTruthy();
  });

  it("editing the text while the found Agent's add is on its way: once the add settles the dialog can be left again", async () => {
    const pending = deferred();
    const api = routes({
      searchPrincipals: vi.fn(async (q, { exact } = {}) => (exact ? { circle: [], exact: { agent: STRANGER.agents[0] } } : { circle: [] })),
      addAgentContact: vi.fn(() => pending.promise),
    });
    await open({ api });
    await openAdd();
    type("stranger.guide");
    await click(inDialog().getByRole("button", { name: "查找" }));
    await click(inDialog().getByRole("button", { name: "添加向导" }));
    expect(button("完成").disabled).toBe(true);
    type("stranger.guid");
    await flush();
    expect(inDialog().queryByRole("button", { name: "添加向导" })).toBeNull();
    await act(async () => pending.resolve({ state: "requested", until: new Date(NOW + 7 * 86_400_000).toISOString() }));
    await flush();
    expect(toastText()).toBe("申请已发送");
    expect(button("完成").disabled).toBe(false);
    await click(button("完成"));
    expect(dialogs()).toHaveLength(0);
  });

  it("blocking someone drops the rows of their Agents (the search's, a contact card's) and a card of theirs that is open stops being actionable", async () => {
    const friends = { friends: [PEOPLE[ANN]], incoming: [], outgoing: [], blocked: [], blockedBy: [] };
    const exact = { person: person(ANN, "ann", "小安"), agents: [profile(AGF, "ann.helper", "安安", ANN, "小安")] };
    const api = routes({ searchPrincipals: vi.fn(async (q, { exact: asked } = {}) => (asked ? { circle: [], exact } : { circle: CIRCLE })) });
    const app = await open({ api, social: friends });
    await goContacts();
    await click(screen.getByText("小安", { selector: ".list-col .row-name" }));
    await click(within(inMain().getByRole("list", { name: "小安的 Agent" })).getByRole("button", { name: /安安/ }));
    expect(top().getByRole("button", { name: "添加安安" })).toBeTruthy();
    app.env.social = { ...friends, blocked: [PEOPLE[ANN]] };
    await push(app.transport, { type: "social" });
    await flush();
    expect(top().queryByRole("button", { name: "添加安安" })).toBeNull();
    expect(top().queryByTestId("social-disclosure")).toBeNull();
    await click(top().getByRole("button", { name: "关闭" }));
    expect(inMain().queryByRole("list", { name: "小安的 Agent" })).toBeNull();
    // The search's own list: 小安's Agent is not offered either.
    await click(button("添加好友"));
    type("an");
    await elapse(300);
    await flush();
    expect(inDialog().queryByText("安安")).toBeNull();
    expect(inDialog().getByText("厨师")).toBeTruthy();
  });

  it("already added or already asked: the reason instead of the button's action", async () => {
    const contacts = { mine: [{ agentId: AGG, state: "requested", conversationId: null, since: "2026-11-16T00:00:00Z", until: new Date(NOW + 86_400_000).toISOString(), ended: null }], waiting: [] };
    const api = routes();
    await open({ api, contacts });
    await openAdd();
    type("an");
    await elapse(300);
    await flush();
    await click(within(inDialog().getByRole("list", { name: "同群的 Agent" })).getByRole("button", { name: /厨师/ }));
    expect(top().getByRole("button", { name: "添加厨师" }).disabled).toBe(true);
    expect(top().getByText("已经申请过了，在等阿波同意。")).toBeTruthy();
  });
});

describe("a person's profile (D10): name, account name, how we stand, and their Agents", () => {
  it("opened from 好友 in the search: their Agents come from the exact step of their account name", async () => {
    const api = routes();
    await open({ api });
    await openAdd();
    type("an");
    await elapse(300);
    await flush();
    api.searchPrincipals.mockResolvedValueOnce({ circle: [], exact: { person: person(ANN, "ann", "小安"), agents: [profile(AGF, "ann.helper", "安安", ANN, "小安")] } });
    await click(within(inDialog().getByRole("list", { name: "好友" })).getByRole("button", { name: /小安/ }));
    expect(api.searchPrincipals).toHaveBeenLastCalledWith("ann", expect.objectContaining({ exact: true }));
    expect(top().getByRole("heading", { name: "小安" })).toBeTruthy();
    expect(top().getByText("@ann")).toBeTruthy();
    const agents = top().getByRole("list", { name: "小安的 Agent" });
    await click(within(agents).getByRole("button", { name: /安安/ }));
    expect(dialogs()).toHaveLength(3);
    expect(top().getByRole("button", { name: "添加安安" })).toBeTruthy();
  });

  it("when the exact step is refused (429) the person is shown without the Agent list and without an error", async () => {
    const api = routes();
    await open({ api });
    await openAdd();
    type("an");
    await elapse(300);
    await flush();
    api.searchPrincipals.mockRejectedValueOnce(apiError(429, "rate_limited"));
    await click(within(inDialog().getByRole("list", { name: "好友" })).getByRole("button", { name: /小安/ }));
    expect(top().getByRole("heading", { name: "小安" })).toBeTruthy();
    expect(top().queryByRole("list", { name: "小安的 Agent" })).toBeNull();
    expect(dialogs().at(-1).querySelector('[role="alert"]')).toBeNull();
    expect(toastText()).toBeNull();
  });

  it("the contact card of a friend lists their Agents too", async () => {
    const api = routes({ searchPrincipals: vi.fn(async () => ({ circle: [], exact: { person: person(ANN, "ann", "小安"), agents: [profile(AGF, "ann.helper", "安安", ANN, "小安")] } })) });
    await open({ api, social: { friends: [PEOPLE[ANN]], incoming: [], outgoing: [], blocked: [], blockedBy: [] } });
    await goContacts();
    await click(screen.getByText("小安", { selector: ".list-col .row-name" }));
    expect(api.searchPrincipals).toHaveBeenCalledWith("ann", expect.objectContaining({ exact: true }));
    const list = inMain().getByRole("list", { name: "小安的 Agent" });
    await click(within(list).getByRole("button", { name: /安安/ }));
    expect(top().getByTestId("social-disclosure").textContent).toBe("这是小安的 Agent。小安能看到你们的对话，也可能插话。");
  });
});

const groupWith = (extra = []) =>
  group(G1, {
    members: [
      { id: ME_ID, role: "speaker", isCreator: true },
      { id: ANN, role: "speaker", isCreator: false },
      { id: BO, role: "speaker", isCreator: false },
      ...extra.map((id) => ({ id, role: "speaker", isCreator: false })),
    ],
    lastSeq: 0,
  });
const openMembers = async () => {
  await click(screen.getByText("周末小组", { selector: ".list-col .row-name" }));
  fireEvent.click(button("会话资料"));
  await flush();
  await click(within(document.querySelector(".side-col")).getByRole("button", { name: "打开群资料" }));
};
const memberRow = (name) => inMain().getByText(name, { selector: ".member-rows strong" }).closest("li");
const GROUP_PRINCIPALS = [...PRINCIPALS, MY_AGENT, GROUP_AGENT];

describe("an Agent in a group (D1, D10)", () => {
  it("each member other than me is a button of its own, apart from 移除, reachable by the keyboard", async () => {
    await open({ convs: [groupWith([AGG, AG1]), agentConv(A1, AG1)], principals: GROUP_PRINCIPALS, handlers: { agents: () => ({ agents: [agentOf(AG1)] }) } });
    await openMembers();
    const row = within(memberRow("厨师"));
    const buttons = row.getAllByRole("button");
    expect(buttons.map((b) => b.textContent.includes("厨师"))).toEqual([true, false]);
    expect(buttons[1].textContent).toBe("移除");
    expect(buttons[0].tagName).toBe("BUTTON");
    expect(within(memberRow("你")).queryAllByRole("button")).toHaveLength(0);
  });

  it("tapped: the card by its id, with 主人, the disclosure and 添加{name}", async () => {
    const api = routes({ agentCard: vi.fn(async () => profile(AGG, "bo.cook", "厨师", BO, "阿波", "会做饭")) });
    await open({ api, convs: [groupWith([AGG])], principals: GROUP_PRINCIPALS });
    await openMembers();
    await click(within(memberRow("厨师")).getAllByRole("button")[0]);
    expect(api.agentCard).toHaveBeenCalledWith(AGG);
    expect(top().getByText("主人：阿波")).toBeTruthy();
    expect(top().getByTestId("social-disclosure")).toBeTruthy();
    expect(top().getByRole("button", { name: "添加厨师" })).toBeTruthy();
  });

  it("not to be found by me (404): only what the member list had — the name, the picture, the Agent tag — and no button, no owner, no reason", async () => {
    const api = routes();
    await open({ api, convs: [groupWith([AGG])], principals: GROUP_PRINCIPALS });
    await openMembers();
    await click(within(memberRow("厨师")).getAllByRole("button")[0]);
    expect(api.agentCard).toHaveBeenCalledWith(AGG);
    expect(top().getByText("厨师", { selector: "strong" })).toBeTruthy();
    expect(top().getByText("Agent")).toBeTruthy();
    expect(top().getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual(["关闭"]);
    expect(dialogs().at(-1).textContent).not.toMatch(/主人|阿波|没有找到|拉黑|不可用/);
    expect(top().queryByTestId("social-disclosure")).toBeNull();
  });

  it("a card refused for its limit (429) is drawn as one not to be found: the member list's face, nothing more, and asked again next time", async () => {
    const api = routes({ agentCard: vi.fn(async () => Promise.reject(apiError(429, "rate_limited"))) });
    await open({ api, convs: [groupWith([AGG])], principals: GROUP_PRINCIPALS });
    await openMembers();
    await click(within(memberRow("厨师")).getAllByRole("button")[0]);
    expect(top().getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual(["关闭"]);
    expect(dialogs().at(-1).querySelector('[role="alert"]')).toBeNull();
    expect(dialogs().at(-1).textContent).not.toMatch(/主人|频繁/);
    await click(top().getByRole("button", { name: "关闭" }));
    api.agentCard.mockResolvedValueOnce(profile(AGG, "bo.cook", "厨师", BO, "阿波"));
    await click(within(memberRow("厨师")).getAllByRole("button")[0]);
    expect(api.agentCard).toHaveBeenCalledTimes(2);
    expect(top().getByRole("button", { name: "添加厨师" })).toBeTruthy();
  });

  it("the switch turned off while a member's card is open: the card closes and nothing can be added", async () => {
    const api = routes({ agentCard: vi.fn(async () => profile(AGG, "bo.cook", "厨师", BO, "阿波")) });
    const app = await open({ api, convs: [groupWith([AGG])], principals: GROUP_PRINCIPALS });
    await openMembers();
    await click(within(memberRow("厨师")).getAllByRole("button")[0]);
    expect(top().getByRole("button", { name: "添加厨师" })).toBeTruthy();
    app.env.sync = () => syncOf([groupWith([AGG])], [], GROUP_PRINCIPALS);
    await act(async () => app.layer.actions.syncNow());
    await flush();
    expect(dialogs()).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "添加厨师" })).toBeNull();
    expect(within(memberRow("厨师")).getAllByRole("button").map((b) => b.textContent)).toEqual(["移除"]);
    expect(api.addAgentContact).not.toHaveBeenCalled();
  });

  it("the switch turned off while a person's profile is open from the details panel: it closes", async () => {
    const api = routes({ searchPrincipals: vi.fn(async () => ({ circle: [], exact: { person: person(BO, "bo", "阿波"), agents: [] } })) });
    const app = await open({ api, convs: [groupWith()], principals: GROUP_PRINCIPALS });
    await click(screen.getByText("周末小组", { selector: ".list-col .row-name" }));
    fireEvent.click(button("会话资料"));
    await flush();
    await click(within(document.querySelector(".side-col")).getByRole("button", { name: /阿波/ }));
    expect(top().getByRole("heading", { name: "阿波" })).toBeTruthy();
    app.env.sync = () => syncOf([groupWith()], [], GROUP_PRINCIPALS);
    await act(async () => app.layer.actions.syncNow());
    await flush();
    expect(dialogs()).toHaveLength(0);
  });

  it("my own Agent: its card without a button, and nothing is asked", async () => {
    const api = routes();
    await open({ api, convs: [groupWith([AG1]), agentConv(A1, AG1)], principals: GROUP_PRINCIPALS, handlers: { agents: () => ({ agents: [agentOf(AG1)] }) } });
    await openMembers();
    await click(within(memberRow("小助手")).getAllByRole("button")[0]);
    expect(api.agentCard).not.toHaveBeenCalled();
    expect(top().getByText("小助手", { selector: "strong" })).toBeTruthy();
    expect(top().getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual(["关闭"]);
  });

  it("a person in the group: their profile, with how we stand and their Agents", async () => {
    const api = routes({ searchPrincipals: vi.fn(async () => ({ circle: [], exact: { person: person(BO, "bo", "阿波"), agents: [profile(AGG, "bo.cook", "厨师", BO, "阿波")] } })) });
    await open({ api, convs: [groupWith()], principals: GROUP_PRINCIPALS });
    await openMembers();
    await click(within(memberRow("阿波")).getAllByRole("button")[0]);
    expect(top().getByRole("heading", { name: "阿波" })).toBeTruthy();
    expect(top().getByRole("button", { name: "发送好友申请" })).toBeTruthy();
    expect(within(top().getByRole("list", { name: "阿波的 Agent" })).getByText("厨师")).toBeTruthy();
  });

  it("the details panel's members are buttons too, apart from the model switch", async () => {
    const api = routes({ agentCard: vi.fn(async () => profile(AGG, "bo.cook", "厨师", BO, "阿波")) });
    await open({ api, convs: [groupWith([AGG])], principals: GROUP_PRINCIPALS });
    await click(screen.getByText("周末小组", { selector: ".list-col .row-name" }));
    fireEvent.click(button("会话资料"));
    await flush();
    const side = within(document.querySelector(".side-col"));
    await click(side.getByRole("button", { name: /厨师/ }));
    expect(top().getByRole("button", { name: "添加厨师" })).toBeTruthy();
  });

  it("switch off: the member list is as it was (no member buttons) and no route of it is called", async () => {
    const api = routes();
    await open({ on: false, api, convs: [groupWith([AGG])], principals: GROUP_PRINCIPALS });
    await openMembers();
    expect(within(memberRow("厨师")).getAllByRole("button").map((b) => b.textContent)).toEqual(["移除"]);
    expect(within(memberRow("阿波")).getAllByRole("button").map((b) => b.textContent)).toEqual(["移除"]);
    expect(api.agentCard).not.toHaveBeenCalled();
    expect(api.searchPrincipals).not.toHaveBeenCalled();
  });
});

describe("a share link /a/<id> (D2, D3)", () => {
  it("signed in: the card opens over the chat list, and the address is the list's", async () => {
    history.replaceState(null, "", `/a/${AGG}`);
    const api = routes({ agentCard: vi.fn(async () => profile(AGG, "bo.cook", "厨师", BO, "阿波")) });
    await open({ api });
    expect(api.agentCard).toHaveBeenCalledWith(AGG);
    expect(top().getByRole("button", { name: "添加厨师" })).toBeTruthy();
    expect(location.pathname).toBe("/");
    await click(top().getByRole("button", { name: "关闭" }));
    expect(dialogs()).toHaveLength(0);
  });

  it("not to be found by me: the lookup's own sentence, and no card", async () => {
    history.replaceState(null, "", `/a/${AGS}`);
    const api = routes();
    await open({ api });
    expect(api.agentCard).toHaveBeenCalledWith(AGS);
    expect(toastText()).toBe("没有找到这个账号。");
    expect(dialogs()).toHaveLength(0);
  });

  it("a card refused for its limit (429) reads as one not to be found, and opening the link again asks again", async () => {
    history.replaceState(null, "", `/a/${AGG}`);
    const api = routes({ agentCard: vi.fn(async () => Promise.reject(apiError(429, "rate_limited"))) });
    await open({ api });
    expect(toastText()).toBe("没有找到这个账号。");
    expect(dialogs()).toHaveLength(0);
    cleanup();
    history.replaceState(null, "", `/a/${AGG}`);
    api.agentCard.mockResolvedValueOnce(profile(AGG, "bo.cook", "厨师", BO, "阿波"));
    await open({ api });
    expect(api.agentCard).toHaveBeenCalledTimes(2);
    expect(top().getByRole("button", { name: "添加厨师" })).toBeTruthy();
  });

  it("my own Agent's link: its card without a button, nothing asked", async () => {
    history.replaceState(null, "", `/a/${AG1}`);
    const api = routes();
    await open({ api, convs: [agentConv(A1, AG1)], handlers: { agents: () => ({ agents: [agentOf(AG1)] }) } });
    expect(api.agentCard).not.toHaveBeenCalled();
    expect(top().getByText("小助手", { selector: "strong" })).toBeTruthy();
    expect(top().queryByRole("button", { name: /添加/ })).toBeNull();
  });

  it("switch off: the chat list, as before; nothing is asked", async () => {
    history.replaceState(null, "", `/a/${AGG}`);
    const api = routes();
    await open({ on: false, api });
    expect(api.agentCard).not.toHaveBeenCalled();
    expect(dialogs()).toHaveLength(0);
    expect(location.pathname).toBe("/");
  });

  it("an address that is not an Agent's id is the chat list, and nothing is asked", async () => {
    history.replaceState(null, "", "/a/not-an-id");
    const api = routes();
    await open({ api });
    expect(api.agentCard).not.toHaveBeenCalled();
    expect(dialogs()).toHaveLength(0);
  });
});

describe("switch off: the add dialog is today's", () => {
  it("looks up the exact account name only; the search route is never called", async () => {
    const api = routes();
    await open({ on: false, api });
    await openAdd();
    expect(inDialog().getByText("输入完整的账号名（不是昵称），例如 ann_li。")).toBeTruthy();
    fireEvent.change(inDialog().getByLabelText("对方的账号名"), { target: { value: "dora" } });
    await elapse(400);
    await click(inDialog().getByRole("button", { name: "查找" }));
    expect(api.searchPrincipals).not.toHaveBeenCalled();
    expect(inDialog().getByRole("button", { name: "发送好友申请" })).toBeTruthy();
  });
});
