// @vitest-environment jsdom
// Agent social, A11a: finding and adding an Agent (its card, the disclosure before any button, each outcome's text) and the contacts page's rows.
// While the site's switch is off nothing of it is drawn and no lane-A route is called.
import "./markdown-ready.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { AG1, BO, ME_ID, PRINCIPALS, agentPrincipal, apiError, syncOf } from "./fixtures.js";
import { button, click, dialog, flush, goContacts, installBrowser, openApp, toastText } from "./harness.jsx";

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
const PEOPLE = [...PRINCIPALS, { ...agentPrincipal(AGB), ownerId: BO, displayName: "小帮手", handle: "bobby.helper" }];

const LANE_A = ["addAgentContact", "approveAgentContact", "declineAgentContact", "removeAgentContact", "getAgentContacts", "putContactPolicy", "putBar", "deleteBar", "reportAgent"];
function routes(over = {}) {
  const api = Object.fromEntries(LANE_A.map((name) => [name, vi.fn(async () => ({ ok: true }))]));
  return { ...api, lookupPrincipal: vi.fn(async () => found()), ...over };
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
const lookup = async (value) => {
  fireEvent.change(screen.getByLabelText("对方的账号名"), { target: { value } });
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
    await lookup("bobby.helper");
    expect(inDialog().getByText("账号名由 3–24 位小写字母、数字或下划线组成。")).toBeTruthy();
    expect(api.lookupPrincipal).not.toHaveBeenCalled();
    api.lookupPrincipal.mockRejectedValueOnce(apiError(404, "not_found"));
    await lookup("nobody");
    expect(inDialog().getByText(/目前还不能添加 Agent 为好友。/)).toBeTruthy();
    expect(laneACalls(api)).toEqual([]);
    expect(transport.log).not.toContain("agent-contacts");
  });

  it("switch on: the hint names an Agent's full account name; its card shows avatar, name, handle, 主人 and intro, and the disclosure comes before any button", async () => {
    await open();
    await goContacts();
    await openAdd();
    expect(inDialog().getByText("人的账号名，或 Agent 的完整账号名，例如 ann_li.helper")).toBeTruthy();
    await lookup("bobby.helper");
    const card = inDialog().getByLabelText("查找结果");
    expect(within(card).getByText("小帮手")).toBeTruthy();
    expect(within(card).getByText("@bobby.helper")).toBeTruthy();
    expect(within(card).getByText("主人：阿波")).toBeTruthy();
    expect(within(card).getByText("陪你聊天")).toBeTruthy();
    const note = within(card).getByTestId("social-disclosure");
    expect(note.textContent).toBe("这是阿波的 Agent。阿波能看到你们的对话，也可能插话。");
    const add = within(card).getByRole("button", { name: "加为联系人" });
    // (Before the button in the page's order; and no button of the card comes earlier.)
    expect(note.compareDocumentPosition(add) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(card).getAllByRole("button")).toEqual([add]);
  });

  it("let in: 「已加为联系人」, the dialog closes and the sync is asked for; waiting: 「已发给它的主人，7 天内有效」 and the button is spent", async () => {
    const { api, transport } = await open();
    await goContacts();
    await openAdd();
    api.addAgentContact.mockResolvedValueOnce({ state: "live", conversationId: SC });
    await lookup("bobby.helper");
    await click(button("加为联系人"));
    expect(api.addAgentContact).toHaveBeenCalledWith(AGB);
    expect(toastText()).toBe("已加为联系人");
    expect(dialog()).toBeNull();
    expect(transport.log.filter((x) => x === "sync").length).toBeGreaterThan(1);
    cleanup();

    const waiting = await open();
    await goContacts();
    await openAdd();
    waiting.api.addAgentContact.mockResolvedValueOnce({ state: "requested", until: "2026-11-23T12:00:00.000Z" });
    await lookup("bobby.helper");
    await click(button("加为联系人"));
    expect(toastText()).toBe("已发给它的主人，7 天内有效");
    expect(inDialog().getAllByText("已发给它的主人，7 天内有效").length).toBeGreaterThan(0);
    expect(button("加为联系人").disabled).toBe(true);
  });

  it("each refusal is said in the Step 0 texts: is_yours, cooldown with its day, not found (never why)", async () => {
    const { api } = await open();
    await goContacts();
    await openAdd();
    await lookup("bobby.helper");
    for (const [error, text] of [
      [apiError(409, "is_yours"), "这是你自己的 Agent。"],
      [Object.assign(apiError(429, "cooldown"), { availableAt: "2026-12-24T00:00:00" }), "现在还不能再申请，2026年12月24日 以后可以。"],
    ]) {
      api.addAgentContact.mockRejectedValueOnce(error);
      await click(button("加为联系人"));
      expect(toastText()).toBe(text);
    }
    api.lookupPrincipal.mockRejectedValueOnce(apiError(404, "not_found"));
    await lookup("bobby.nothing");
    expect(inDialog().getByText("没有找到账号名为 bobby.nothing 的用户或 Agent。")).toBeTruthy();
  });

  it("my own Agent, one I added or asked: the button says why it is no use, and no route is called", async () => {
    const api = routes({ lookupPrincipal: vi.fn(async () => found({ ownerId: ME_ID, ownerName: "你" })) });
    await open({ api });
    await goContacts();
    await openAdd();
    await lookup("me_one.helper");
    expect(button("加为联系人").disabled).toBe(true);
    expect(inDialog().getAllByText("这是你自己的 Agent。").length).toBeGreaterThan(0);
    expect(api.addAgentContact).not.toHaveBeenCalled();
  });

  it("a person is found and added as before, with the switch on", async () => {
    const api = routes({ lookupPrincipal: vi.fn(async () => ({ id: BO, handle: "bob", displayName: "阿波", avatarVersion: 0 })), sendFriendRequest: vi.fn(async () => ({ id: "r1" })) });
    await open({ api });
    await goContacts();
    await openAdd();
    await lookup("bob");
    await click(button("发送好友申请"));
    expect(api.sendFriendRequest).toHaveBeenCalledWith("bob");
    expect(screen.queryByTestId("social-disclosure")).toBeNull();
  });
});

describe("the contacts page", () => {
  const contacts = () => ({
    mine: [
      { agentId: AGB, state: "live", conversationId: SC, since: "2026-11-16T00:00:00Z", until: null, ended: null },
      { agentId: "00000000-0000-4000-8000-0000000000b9", state: "requested", conversationId: null, since: "2026-11-16T00:00:00Z", until: "2026-11-23T12:00:00.000Z", ended: null },
      { agentId: "00000000-0000-4000-8000-0000000000b8", state: "ended", conversationId: null, since: "2026-11-01T00:00:00Z", until: null, ended: "ended" },
    ],
    waiting: [{ agentId: AG1, subject: { id: BO, handle: "bo", displayName: "阿波", avatarVersion: 0, kind: "human" }, since: "2026-11-16T00:00:00Z", until: "2026-11-23T12:00:00.000Z" }],
  });
  const rowOf = (name) => screen.getByText(name, { selector: ".row-name" }).closest("li");

  it("shows the Agents I let in (聊天, 移除), the ones that wait (等主人同意), and the requests waiting on mine (同意, 拒绝); an ended row is not listed", async () => {
    const { api } = await open({ convs: [visiting()], contacts: contacts() });
    await goContacts();
    expect(screen.getByText("Agent", { selector: ".rows-label" })).toBeTruthy();
    expect(screen.getByText("别人想加你的 Agent", { selector: ".rows-label" })).toBeTruthy();
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
    expect(api.removeAgentContact).toHaveBeenCalledWith(AGB, ME_ID);
    expect(document.body.textContent).not.toContain("b8");
  });

  it("switch off: none of those rows, and the contacts list is not asked for", async () => {
    const { api, transport } = await open({ on: false, convs: [], contacts: contacts() });
    await goContacts();
    expect(screen.queryByText("别人想加你的 Agent")).toBeNull();
    expect(screen.queryByText("等主人同意")).toBeNull();
    expect(transport.log).not.toContain("agent-contacts");
    expect(laneACalls(api)).toEqual([]);
    await flush();
  });
});
