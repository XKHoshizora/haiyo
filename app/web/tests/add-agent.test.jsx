// @vitest-environment jsdom
// Agent social, A11a: finding and adding an Agent (its card, the disclosure before any button, each outcome's text) and the contacts page's rows.
// While the site's switch is off nothing of it is drawn and no lane-A route is called.
import "./markdown-ready.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { AG1, BO, ME_ID, PRINCIPALS, agentPrincipal, apiError, syncOf } from "./fixtures.js";
import { NOW, button, click, dialog, flush, goContacts, installBrowser, openApp, toastText } from "./harness.jsx";

beforeEach(installBrowser);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const AGB = "00000000-0000-4000-8000-0000000000b2";
const SC = "00000000-0000-4000-8000-000000001001";
const found = (fields = {}) => ({ id: AGB, handle: "bobby.helper", displayName: "小帮手", avatarVersion: 0, kind: "agent", ownerId: BO, ownerName: "阿波", intro: "陪你聊天", field: "", ...fields });
const visiting = (fields = {}) => ({
  id: SC,
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
  lastSeq: 0,
  readSeq: 0,
  unread: 0,
  ...fields,
});
const PEOPLE = [...PRINCIPALS, { ...agentPrincipal(AGB), ownerId: BO, displayName: "小帮手", handle: "bobby.helper" }, { ...agentPrincipal(AG1), ownerId: ME_ID }];

const LANE_A = ["addAgentContact", "approveAgentContact", "declineAgentContact", "removeAgentContact", "getAgentContacts", "putContactPolicy", "putBar", "deleteBar", "reportAgent"];
/** The search route answering `exact` to the dialog's explicit step (switch on: 查找 is the search's exact step) and no circle. */
const searchFinds = (exact) => vi.fn(async (q, options = {}) => (options.exact ? { circle: [], exact } : { circle: [] }));
function routes(over = {}) {
  const api = Object.fromEntries(LANE_A.map((name) => [name, vi.fn(async () => ({ ok: true }))]));
  return { ...api, lookupPrincipal: vi.fn(async () => found()), searchPrincipals: searchFinds({ agent: found() }), ...over };
}
async function open({ on = true, convs = [], contacts = { mine: [], waiting: [] }, api = routes() } = {}) {
  const app = await openApp({
    sync: () => ({ ...syncOf(convs, [], PEOPLE), ...(on ? { social: { enabled: true } } : {}) }),
    api,
    handlers: { agentContacts: () => contacts },
  });
  return { ...app, api };
}
const openAdd = async () => click(button("添加好友"));
const lookup = async (value, label = "昵称或账号名") => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
  await click(button("查找"));
};
const inDialog = () => within(dialog());
const laneACalls = (api) => LANE_A.flatMap((name) => api[name].mock.calls.map(() => name));

describe("the add dialog", () => {
  it("switch off: today's hint and text; an Agent's full name is no account name; no lane-A route is called", async () => {
    const { api, transport } = await open({ on: false });
    await goContacts();
    await openAdd();
    expect(inDialog().getByText("输入完整的账号名（不是昵称），例如 ann_li。")).toBeTruthy();
    await lookup("bobby.helper", "对方的账号名");
    expect(inDialog().getByText("账号名由 3–24 位小写字母、数字或下划线组成。")).toBeTruthy();
    expect(inDialog().getByRole("heading", { name: "添加好友" })).toBeTruthy();
    expect(api.lookupPrincipal).not.toHaveBeenCalled();
    api.lookupPrincipal.mockRejectedValueOnce(apiError(404, "not_found"));
    await lookup("nobody", "对方的账号名");
    expect(inDialog().getByText(/目前还不能添加 Agent 为好友。/)).toBeTruthy();
    expect(api.searchPrincipals).not.toHaveBeenCalled();
    expect(laneACalls(api)).toEqual([]);
    expect(transport.log).not.toContain("agent-contacts");
  });

  it("switch on: the hint says a name or an account name; the Agent's card shows avatar, name, handle, 主人 and intro, and the disclosure comes before any button", async () => {
    const { api } = await open();
    await goContacts();
    await openAdd();
    expect(inDialog().getByText("输入昵称或账号名。找不认识的人，要输入对方完整的账号名。")).toBeTruthy();
    // The thing added may be an Agent: the title says so (A-5 re-review, copy #1).
    expect(inDialog().getByRole("heading", { name: "添加好友或 Agent" })).toBeTruthy();
    await lookup("bobby.helper");
    expect(api.searchPrincipals).toHaveBeenCalledWith("bobby.helper", expect.objectContaining({ exact: true }));
    expect(api.lookupPrincipal).not.toHaveBeenCalled();
    const card = inDialog().getByLabelText("查找结果");
    expect(within(card).getByText("小帮手")).toBeTruthy();
    expect(within(card).getByText("@bobby.helper")).toBeTruthy();
    expect(within(card).getByText("主人：阿波")).toBeTruthy();
    expect(within(card).getByText("陪你聊天")).toBeTruthy();
    const note = within(card).getByTestId("social-disclosure");
    expect(note.textContent).toBe("这是阿波的 Agent。阿波能看到你们的对话，也可能插话。");
    const add = within(card).getByRole("button", { name: "添加小帮手" });
    // (Before the button in the page's order; and no button of the card comes earlier.)
    expect(note.compareDocumentPosition(add) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(card).getAllByRole("button")).toEqual([add]);
  });

  it("switch on: a name that finds nothing is answered with what to type, not with the rule", async () => {
    await open({ api: routes({ searchPrincipals: searchFinds(null) }) });
    await goContacts();
    await openAdd();
    await lookup("x");
    expect(inDialog().getByText("没有找到。找不认识的人，要输入对方完整的账号名，例如 ann_li。")).toBeTruthy();
  });

  it("let in: 「已添加」, the dialog closes and the sync is asked for; waiting: the outcome is said once (toast 「申请已发送」, one notice with what happens after 7 days) and the button is spent", async () => {
    const { api, transport } = await open();
    await goContacts();
    await openAdd();
    api.addAgentContact.mockResolvedValueOnce({ state: "live", conversationId: SC });
    await lookup("bobby.helper");
    await click(button("添加小帮手"));
    expect(api.addAgentContact).toHaveBeenCalledWith(AGB);
    expect(toastText()).toBe("已添加");
    expect(dialog()).toBeNull();
    expect(transport.log.filter((x) => x === "sync").length).toBeGreaterThan(1);
    cleanup();

    const waiting = await open();
    await goContacts();
    await openAdd();
    waiting.api.addAgentContact.mockResolvedValueOnce({ state: "requested", until: new Date(NOW + 7 * 86_400_000).toISOString() });
    await lookup("bobby.helper");
    await click(button("添加小帮手"));
    expect(toastText()).toBe("申请已发送");
    expect(inDialog().getAllByText("已发给阿波，等对方同意。7 天没有回应会自动取消。")).toHaveLength(1);
    expect(inDialog().queryByText("已经申请过了，在等阿波同意。")).toBeNull();
    expect(dialog().textContent).not.toContain("天内有效");
    expect(button("添加小帮手").disabled).toBe(true);
  });

  it("each refusal is said in the Step 0 texts: is_yours, cooldown with its day, not found (never why)", async () => {
    const { api } = await open();
    await goContacts();
    await openAdd();
    await lookup("bobby.helper");
    for (const [error, text] of [
      [apiError(409, "is_yours"), "你自己的 Agent 不用添加。"],
      [Object.assign(apiError(429, "cooldown"), { availableAt: "2026-12-24T00:00:00" }), "现在还不能再申请，2026年12月24日 以后可以。"],
    ]) {
      api.addAgentContact.mockRejectedValueOnce(error);
      await click(button("添加小帮手"));
      expect(toastText()).toBe(text);
    }
    api.searchPrincipals.mockResolvedValueOnce({ circle: [], exact: null });
    await lookup("bobby.nothing");
    expect(inDialog().getByText("没有找到。找不认识的人，要输入对方完整的账号名，例如 ann_li。")).toBeTruthy();
  });

  it("while the add is on its way the dialog cannot be closed from its foot either (A-5 re-review m-h)", async () => {
    const { api } = await open();
    await goContacts();
    await openAdd();
    api.addAgentContact.mockImplementationOnce(() => new Promise(() => {}));
    await lookup("bobby.helper");
    await click(button("添加小帮手"));
    expect(button("完成").disabled).toBe(true);
  });

  it("my own Agent: said at once, and no route is called", async () => {
    const api = routes({ lookupPrincipal: vi.fn(async () => found({ ownerId: ME_ID, ownerName: "你" })) });
    await open({ api });
    await goContacts();
    await openAdd();
    await lookup("me_one.helper");
    // (Recognised by its handle before the lookup, which hides it: no "not found", no route.)
    expect(inDialog().getAllByText("你自己的 Agent 不用添加。").length).toBeGreaterThan(0);
    expect(api.lookupPrincipal).not.toHaveBeenCalled();
    expect(api.searchPrincipals).not.toHaveBeenCalled();
    expect(api.addAgentContact).not.toHaveBeenCalled();
  });

  it("a person is found and added as before, with the switch on", async () => {
    const api = routes({ searchPrincipals: searchFinds({ person: { id: BO, handle: "bob", displayName: "阿波", avatarVersion: 0 }, agents: [] }), sendFriendRequest: vi.fn(async () => ({ id: "r1" })) });
    await open({ api });
    await goContacts();
    await openAdd();
    await lookup("bob");
    await click(button("发送好友申请"));
    expect(api.sendFriendRequest).toHaveBeenCalledWith("bob");
    expect(screen.queryByTestId("social-disclosure")).toBeNull();
  });
});

const IN_7_DAYS = new Date(NOW + 7 * 86_400_000).toISOString();

describe("the contacts page", () => {
  const contacts = () => ({
    mine: [
      { agentId: AGB, state: "live", conversationId: SC, since: "2026-11-16T00:00:00Z", until: null, ended: null },
      { agentId: "00000000-0000-4000-8000-0000000000b9", state: "requested", conversationId: null, since: "2026-11-16T00:00:00Z", until: IN_7_DAYS, ended: null },
      { agentId: "00000000-0000-4000-8000-0000000000b8", state: "ended", conversationId: null, since: "2026-11-01T00:00:00Z", until: null, ended: "ended" },
    ],
    waiting: [{ agentId: AG1, subject: { id: BO, handle: "bo", displayName: "阿波", avatarVersion: 0, kind: "human" }, since: "2026-11-16T00:00:00Z", until: IN_7_DAYS }],
  });
  const rowOf = (name) => screen.getByText(name, { selector: ".row-name" }).closest("li");
  it("says when a waiting request runs out as 「还有 N 天过期」, and what a request on my Agent is for, in one phrase", async () => {
    await open({ convs: [visiting()], contacts: contacts() });
    await goContacts();
    expect(rowOf("阿波").querySelector(".row-preview").textContent).toBe("想加你的小助手 · 还有 7 天过期");
    expect(screen.getByText("还有 7 天过期", { selector: ".row-preview" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("天内有效");
  });

  it("shows the Agents I let in (聊天, 移除), the ones that wait (等主人同意), and the requests waiting on mine (同意, 拒绝); an ended row is not listed", async () => {
    const { api } = await open({ convs: [visiting()], contacts: contacts() });
    await goContacts();
    expect(screen.getByText("我添加的 Agent", { selector: ".rows-label" })).toBeTruthy();
    expect(screen.getByText("别人想添加我的 Agent", { selector: ".rows-label" })).toBeTruthy();
    const live = within(rowOf("小帮手"));
    expect(live.getByRole("button", { name: "聊天" })).toBeTruthy();
    expect(screen.getByText("等主人同意")).toBeTruthy();
    const wait = within(rowOf("阿波"));
    await click(wait.getByRole("button", { name: "同意" }));
    expect(api.approveAgentContact).toHaveBeenCalledWith(AG1, BO);
    expect(toastText()).toBe("已同意");
    await click(within(rowOf("阿波")).getByRole("button", { name: "拒绝" }));
    expect(api.declineAgentContact).toHaveBeenCalledWith(AG1, BO);
    await click(within(rowOf("小帮手")).getByRole("button", { name: "移除" }));
    expect(api.removeAgentContact).not.toHaveBeenCalled();
    await click(within(dialog()).getByRole("button", { name: "确认移除" }));
    expect(api.removeAgentContact).toHaveBeenCalledWith(AGB, ME_ID);
    expect(document.body.textContent).not.toContain("b8");
  });

  it("switch off: none of those rows, and the contacts list is not asked for", async () => {
    const { api, transport } = await open({ on: false, convs: [], contacts: contacts() });
    await goContacts();
    expect(screen.queryByText("别人想添加我的 Agent")).toBeNull();
    expect(screen.queryByText("等主人同意")).toBeNull();
    expect(transport.log).not.toContain("agent-contacts");
    expect(laneACalls(api)).toEqual([]);
    await flush();
  });
});
