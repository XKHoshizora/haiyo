// @vitest-environment jsdom
// The number on 通讯录 (the rail and the phone's tab bar): what waits for my answer — the friend requests sent to me and, while the site's
// Agent social switch is on, the requests waiting on my own Agents — each only while it can still be answered. A request I sent is not mine
// to answer. There is no "seen" state: the number is the count, and it goes when a request is answered, withdrawn or runs out.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import { ME } from "../src/data/identities.js";
import { expiryText } from "../src/data/viewmodel.js";
import { untilText } from "../src/pages/untilText.js";
import { waitingForMe } from "../src/state/selectors.js";
import { COARSE_QUERY, PHONE_QUERY } from "../src/ui/pointer.js";
import { AG1, ANN, BO, D1, PRINCIPALS, agentPrincipal, direct, emptySocial, syncOf, wire } from "./fixtures.js";
import { CY, DORA, NOW, PEOPLE, click, elapse, flush, goContacts, installBrowser, openApp, push, request } from "./harness.jsx";

const H = 3_600_000;
const D = 24 * H;
const at = (ms) => new Date(NOW + ms).toISOString();

// ── The selector, over the page's state as the view model builds it (relations keyed "from|to", the switch, the held agent-contacts answer).

const asked = (expiresIn = D) => ({ status: "incoming", requestId: "r", createdAt: at(-H), expiresAt: at(expiresIn) });
const sent = (expiresIn = D) => ({ status: "pending", requestId: "s", createdAt: at(-H), expiresAt: at(expiresIn) });
const waitingOn = (agentId, subjectId, untilIn = 7 * D) => ({
  agentId,
  subject: { id: subjectId, handle: subjectId, displayName: subjectId, avatarVersion: 0, kind: "human" },
  since: at(-H),
  until: at(untilIn),
});
/** `incoming` / `outgoing`: [id, relation]; `friends`: ids; `waiting` / `mine`: agent-contacts rows; `on`: the site's switch. */
function stateOf({ incoming = [], outgoing = [], friends = [], waiting = [], mine = [], on = true, contacts = true } = {}) {
  const relations = {};
  for (const id of friends) relations[`${ME}|${id}`] = { status: "established" };
  for (const [id, rel] of outgoing) relations[`${ME}|${id}`] = rel;
  for (const [id, rel] of incoming) relations[`${id}|${ME}`] = rel;
  return { relations, social: { enabled: on }, agentContacts: contacts ? { mine, waiting } : null };
}

describe("waitingForMe", () => {
  it("counts the friend requests sent to me", () => {
    expect(waitingForMe(stateOf({ incoming: [["p1", asked()], ["p2", asked()]] }), NOW)).toBe(2);
  });

  it("counts the requests waiting on my own Agents while the site's switch is on", () => {
    expect(waitingForMe(stateOf({ waiting: [waitingOn("ag1", "p1"), waitingOn("ag1", "p2"), waitingOn("ag2", "p1")] }), NOW)).toBe(3);
  });

  it("adds the two kinds together", () => {
    expect(waitingForMe(stateOf({ incoming: [["p1", asked()]], waiting: [waitingOn("ag1", "p2"), waitingOn("ag2", "p3")] }), NOW)).toBe(3);
  });

  it("a request I sent is not mine to answer: my friend requests and my own asks of someone's Agent count nothing", () => {
    const mine = [{ agentId: "x1", state: "requested", conversationId: null, since: at(-H), until: at(7 * D) }];
    expect(waitingForMe(stateOf({ outgoing: [["p1", sent()], ["p2", sent()]], friends: ["p3"], mine }), NOW)).toBe(0);
    expect(waitingForMe(stateOf({ outgoing: [["p1", sent()]], incoming: [["p2", asked()]], mine }), NOW)).toBe(1);
  });

  it("switch off: the requests waiting on my Agents are not counted (the friend requests still are)", () => {
    const state = stateOf({ on: false, incoming: [["p1", asked()]], waiting: [waitingOn("ag1", "p2"), waitingOn("ag1", "p3")] });
    expect(waitingForMe(state, NOW)).toBe(1);
  });

  it("nothing waiting is 0, and so is the time before the agent-contacts answer came", () => {
    expect(waitingForMe(stateOf(), NOW)).toBe(0);
    expect(waitingForMe(stateOf({ contacts: false, friends: ["p1"] }), NOW)).toBe(0);
  });

  it("a request past its deadline is not counted: it is still held until the next fetch, and the contacts page reads it 已过期", () => {
    const state = stateOf({ incoming: [["p1", asked(1000)]], waiting: [waitingOn("ag1", "p2", 2000)] });
    expect(waitingForMe(state, NOW)).toBe(2);
    expect(waitingForMe(state, NOW + 1000)).toBe(1);
    expect(waitingForMe(state, NOW + 2000)).toBe(0);
  });

  it("counts a request exactly while the contacts page does not read it 已过期 (the same moment for both kinds)", () => {
    for (const ms of [-D, -1, 0, 1, 59_000, H, D, 7 * D]) {
      const friend = stateOf({ incoming: [["p1", asked(ms)]] });
      const agent = stateOf({ waiting: [waitingOn("ag1", "p1", ms)] });
      expect(waitingForMe(friend, NOW) === 1, `friend request, ${ms} ms left`).toBe(expiryText(at(ms), NOW) !== "已过期");
      expect(waitingForMe(agent, NOW) === 1, `Agent request, ${ms} ms left`).toBe(untilText(at(ms), NOW) !== "已过期");
    }
  });
});

// ── In the app: the whole App over the real data layer (fake transport, fake routes).

beforeEach(installBrowser);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete window.matchMedia;
});

const baseSync = () => syncOf([direct(D1, ANN, { lastSeq: 1, readSeq: 1 })], [wire(D1, 1, ANN, "早")]);
const socialWith = (over = {}) => ({ ...emptySocial(), friends: [PEOPLE[ANN]], ...over });
const nav = () => within(screen.getByRole("navigation", { name: "主导航" }));
/** The 通讯录 entry, whatever its number. */
const contactsEntry = () => nav().getByRole("button", { name: /^通讯录/ });
const badgeOf = (entry) => entry.querySelector(".badge")?.textContent ?? null;
/** My Agent AG1 and the agent-contacts answer `contacts`; `on`: the site's switch. */
const withAgents = (on, contacts) => ({
  sync: () => ({ ...syncOf([direct(D1, ANN, { lastSeq: 1, readSeq: 1 })], [wire(D1, 1, ANN, "早")], [...PRINCIPALS, { ...agentPrincipal(AG1), ownerId: PRINCIPALS[0].id }]), ...(on ? { social: { enabled: true } } : {}) }),
  handlers: { agentContacts: () => contacts },
});
const waitingRow = (subjectId, name) => ({ agentId: AG1, subject: { id: subjectId, handle: subjectId, displayName: name, avatarVersion: 0, kind: "human" }, since: at(-H), until: at(7 * D) });

describe("the number on 通讯录", () => {
  it("shows from the first sync while I am on 消息 (the contacts page never opened), and its name says what it is", async () => {
    await openApp({ sync: baseSync, social: socialWith({ incoming: [request("r1", PEOPLE[CY]), request("r2", PEOPLE[DORA])] }) });
    expect(nav().getByRole("button", { name: /^消息/ }).getAttribute("aria-current")).toBe("page");
    const entry = nav().getByRole("button", { name: "通讯录，2 条待处理" });
    expect(badgeOf(entry)).toBe("2");
    expect(entry.querySelector(".badge").className).toBe("badge");
    // (Only that entry: Agent and 设置 carry none.)
    expect(nav().getAllByRole("button").filter((b) => b.querySelector(".badge")).length).toBe(1);
  });

  it("is absent at zero, and the entry is called just 通讯录 (a request I sent counts nothing)", async () => {
    await openApp({ sync: baseSync, social: socialWith({ outgoing: [request("r1", PEOPLE[DORA])] }) });
    const entry = nav().getByRole("button", { name: "通讯录" });
    expect(badgeOf(entry)).toBeNull();
    expect(entry.getAttribute("aria-label")).toBeNull();
  });

  it("follows the count without a reload: a new request brings it, an answer given elsewhere (a social push) takes it away", async () => {
    const { env, transport } = await openApp({ sync: baseSync, social: socialWith() });
    expect(badgeOf(contactsEntry())).toBeNull();
    env.social = socialWith({ incoming: [request("r9", PEOPLE[CY])] });
    await push(transport, { type: "social" });
    await flush();
    expect(badgeOf(contactsEntry())).toBe("1");
    expect(contactsEntry().getAttribute("aria-label")).toBe("通讯录，1 条待处理");
    env.social = socialWith({ friends: [PEOPLE[ANN], PEOPLE[CY]] });
    await push(transport, { type: "social" });
    await flush();
    expect(badgeOf(contactsEntry())).toBeNull();
    expect(nav().getByRole("button", { name: "通讯录" })).toBe(contactsEntry());
  });

  it("goes when I accept the request on the contact's card", async () => {
    const { env } = await openApp({
      sync: baseSync,
      social: socialWith({ incoming: [request("r1", PEOPLE[CY])] }),
      api: {
        acceptFriendRequest: vi.fn(async () => {
          env.social = socialWith({ friends: [PEOPLE[ANN], PEOPLE[CY]] });
          return {};
        }),
      },
    });
    expect(badgeOf(contactsEntry())).toBe("1");
    await goContacts();
    await click(screen.getByText("小陈", { selector: ".list-col .row-name" }).closest("button"));
    await click(within(document.querySelector(".main-col")).getByRole("button", { name: "同意" }));
    expect(badgeOf(contactsEntry())).toBeNull();
  });

  it("a request that runs out leaves the number at the minute the list reads it 已过期, before any fetch drops it", async () => {
    const { transport } = await openApp({ sync: baseSync, social: socialWith({ incoming: [request("r1", PEOPLE[CY], { expiresAt: at(90_000) })] }) });
    expect(badgeOf(contactsEntry())).toBe("1");
    const fetches = transport.log.filter((x) => x === "social").length;
    await elapse(2 * 60_000);
    expect(badgeOf(contactsEntry())).toBeNull();
    expect(transport.log.filter((x) => x === "social").length).toBe(fetches);
    await goContacts();
    expect(screen.getByText("小陈", { selector: ".row-name" }).closest("button").querySelector(".row-preview").textContent).toBe("申请添加你为好友 · 已过期");
  });

  it("counts the requests waiting on my Agents with the friend requests while the switch is on, from the first sync", async () => {
    const contacts = { mine: [], waiting: [waitingRow(BO, "阿波"), waitingRow(DORA, "朵拉")] };
    await openApp({ ...withAgents(true, contacts), social: socialWith({ incoming: [request("r1", PEOPLE[CY])] }) });
    expect(badgeOf(contactsEntry())).toBe("3");
    expect(contactsEntry().getAttribute("aria-label")).toBe("通讯录，3 条待处理");
  });

  it("switch off: the requests waiting on my Agents are not counted (a friend request still is)", async () => {
    const contacts = { mine: [], waiting: [waitingRow(BO, "阿波")] };
    const { transport } = await openApp({ ...withAgents(false, contacts), social: socialWith({ incoming: [request("r1", PEOPLE[CY])] }) });
    expect(badgeOf(contactsEntry())).toBe("1");
    expect(transport.log).not.toContain("agent-contacts");
  });

  it("the phone's tab bar carries the same number", async () => {
    window.matchMedia = (query) => ({ matches: [PHONE_QUERY, COARSE_QUERY].includes(query), media: query, addEventListener() {}, removeEventListener() {} });
    await openApp({ sync: baseSync, social: socialWith({ incoming: [request("r1", PEOPLE[CY])] }) });
    expect(document.querySelector(".app").dataset.tabbar).toBe("on");
    expect(badgeOf(nav().getByRole("button", { name: "通讯录，1 条待处理" }))).toBe("1");
  });
});

describe("the number on 消息", () => {
  it("says what it is in the entry's name the same way, and the entry is just 消息 without one", async () => {
    await openApp({ sync: () => syncOf([direct(D1, ANN, { lastSeq: 3, readSeq: 1, unread: 2 })], [wire(D1, 1, ANN, "早"), wire(D1, 2, ANN, "在吗"), wire(D1, 3, ANN, "喂")]) });
    const entry = nav().getByRole("button", { name: "消息，2 条未读" });
    expect(badgeOf(entry)).toBe("2");
    cleanup();
    await openApp({ sync: baseSync });
    expect(badgeOf(nav().getByRole("button", { name: "消息" }))).toBeNull();
  });
});
