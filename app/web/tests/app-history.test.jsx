// @vitest-environment jsdom
// The app's pages in the browser's history by one rule: the address is the source of truth; a different address is a push; a page's
// own close goes back only to its parent entry, else replaces by the parent; popstate only re-renders; a cold start makes no entry;
// width is no input. First the mapping (a table), then every transition of the review's C1, C2, I1, I2, I3 on jsdom's history.
import React, { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { A1, AG1, ANN, D1, MODELS, PRINCIPALS, agentConv, agentOf, agentPrincipal, direct, syncOf, wire } from "./fixtures.js";
import { flush, installBrowser, openApp } from "./harness.jsx";
import { PAGE_KEYS, addressOf, keyOf, navOfAddress, parentOf } from "../src/state/location.js";
import { goUp, useAppHistory } from "../src/state/appHistory.js";
import { Modal } from "../src/ui/primitives.jsx";

const C1 = "00000000-0000-4000-8000-0000000000c1";
const C2 = "00000000-0000-4000-8000-0000000000c2";
const AG = "00000000-0000-4000-8000-0000000000b1";

/** [nav page keys, path, overlay, parent path, parent overlay] */
const TABLE = [
  [{ section: "chat", pane: "list" }, "/", null, "/", null],
  [{ section: "chat", pane: "main", convId: C1 }, `/chat/${C1}`, null, "/", null],
  [{ section: "chat", pane: "main", convId: C1, detailsOpen: true }, `/chat/${C1}`, "details", `/chat/${C1}`, null],
  [{ section: "chat", pane: "main", convId: C1, view: "profile" }, `/chat/${C1}/info`, null, `/chat/${C1}`, null],
  [{ section: "contacts", pane: "list" }, "/contacts", null, "/", null],
  [{ section: "contacts", pane: "main", contactId: C2 }, `/contacts/${C2}`, null, "/contacts", null],
  [{ section: "agents", pane: "list" }, "/agents", null, "/", null],
  [{ section: "agents", pane: "main", agentId: AG, agentView: "detail" }, `/agents/${AG}`, null, "/agents", null],
  [{ section: "agents", pane: "main", agentId: AG, agentView: "edit" }, `/agents/${AG}/edit`, null, `/agents/${AG}`, null],
  [{ section: "agents", pane: "main", agentView: "create" }, "/agents/new", null, "/agents", null],
  [{ section: "settings", pane: "list" }, "/settings", null, "/", null],
  ...["profile", "providers", "usage", "memory", "blocks"].map((page) => [{ section: "settings", pane: "main", settingsPage: page }, `/settings/${page}`, null, "/settings", null]),
];
const BASE = { section: "chat", pane: "list", convId: null, view: "chat", contactId: null, agentId: null, agentView: "detail", settingsPage: "profile", providerId: null, detailsOpen: false, agentTab: "profile", profileTab: "members", opening: null };

describe("the address of every place, and back", () => {
  it.each(TABLE)("%j is %s (overlay %s), its parent %s", (patch, path, overlay, parentPath, parentOverlay) => {
    const nav = { ...BASE, ...patch };
    expect(addressOf(nav)).toEqual({ path, overlay });
    // The address means the same page keys when it is shown again (all of them: nothing of the page before is left).
    const back = navOfAddress({ path, overlay });
    for (const key of PAGE_KEYS) expect([key, back[key]]).toEqual([key, nav[key]]);
    expect(parentOf({ path, overlay })).toEqual({ path: parentPath, overlay: parentOverlay });
  });

  it("nothing of the width is in it: the same navigation is the same address", () => {
    expect(addressOf.length).toBe(1);
    expect(keyOf({ path: "/a", overlay: "details" })).toBe("/a#details");
  });

  it("an unknown address is the chat list, a settings page that does not exist is the settings list", () => {
    expect(navOfAddress({ path: "/nowhere" })).toMatchObject({ section: "chat", pane: "list", convId: null });
    expect(navOfAddress({ path: "/settings/zzz" })).toMatchObject({ section: "chat", pane: "list" });
  });
});

// The hook on jsdom's own history. `Probe` holds a navigation the test moves; `moves` is every dispatch the hook asks for.
let moves;
let drive;
function Probe({ initial = {}, resolves = null }) {
  const [nav, set] = useState({ ...BASE, ...initial });
  const dispatch = (action) => {
    moves.push(action);
    // (As the reducer records it: the intent of a move is data on the navigation.)
    const navIntent = action.intent === "none" ? "none" : action.replace === true ? "replace" : "push";
    if (action.patch) set((n) => ({ ...n, ...action.patch, navIntent }));
  };
  drive = { set: (patch, replace = false) => set((n) => ({ ...n, ...patch, navIntent: replace ? "replace" : "push" })), dispatch, nav };
  drive.nav = nav;
  useAppHistory({ nav, dispatch, resolves });
  return <output data-nav={JSON.stringify(nav)} />;
}
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
const at = () => window.location.pathname + (window.history.state?.overlay ? `#${window.history.state.overlay}` : "");
const go = async (patch, replace = false) => {
  act(() => drive.set(patch, replace));
  await settle();
};
const back = async () => {
  act(() => window.history.back());
  await settle();
};
const up = async () => {
  act(() => goUp(drive.dispatch));
  await settle();
};
const navNow = () => JSON.parse(document.querySelector("output").dataset.nav);
const chatOf = (id, extra = {}) => ({ section: "chat", pane: "main", convId: id, view: "chat", ...extra });

beforeEach(() => {
  moves = [];
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("navigating pushes, always, when the address differs", () => {
  it("list → conversation → Back is the list; the entry is at the conversation's own address", async () => {
    render(<Probe />);
    await settle();
    await go(chatOf(C1));
    expect(at()).toBe(`/chat/${C1}`);
    expect(window.history.state).toMatchObject({ af: 1, index: 1, prev: "/#" });
    await back();
    expect(at()).toBe("/");
    expect(navNow()).toMatchObject({ pane: "list", convId: null });
  });

  it("a wide screen is the same code path: conversation to conversation is a push each, Back walks them", async () => {
    render(<Probe />);
    await settle();
    await go(chatOf(C1));
    await go(chatOf(C2));
    expect(window.history.state.index).toBe(2);
    await back();
    expect(navNow()).toMatchObject({ convId: C1, pane: "main" });
    await back();
    expect(navNow()).toMatchObject({ convId: null, pane: "list" });
  });

  it("I1: a conversation → the memory page of settings → Back is the conversation (not the settings list)", async () => {
    render(<Probe />);
    await settle();
    await go(chatOf(C1));
    await go({ section: "settings", pane: "main", settingsPage: "memory" });
    expect(at()).toBe("/settings/memory");
    await back();
    expect(navNow()).toMatchObject({ section: "chat", convId: C1, pane: "main" });
    expect(at()).toBe(`/chat/${C1}`);
  });

  it("I1: an Agent's page → the providers page (the same depth, the same old path) → Back is the Agent; Forward is the providers page", async () => {
    render(<Probe />);
    await settle();
    await go({ section: "agents", pane: "main", agentId: AG });
    await go({ section: "settings", pane: "main", settingsPage: "providers" });
    await back();
    expect(navNow()).toMatchObject({ section: "agents", agentId: AG });
    act(() => window.history.forward());
    await settle();
    expect(navNow()).toMatchObject({ section: "settings", settingsPage: "providers" });
  });

  it("C2: 添加模型供应商 from the Agent's form reaches the providers page, and Back is the form", async () => {
    render(<Probe />);
    await settle();
    await go({ section: "agents", pane: "main", agentId: AG, agentView: "edit" });
    await go({ section: "settings", pane: "main", settingsPage: "providers" });
    expect(at()).toBe("/settings/providers");
    expect(navNow()).toMatchObject({ section: "settings", settingsPage: "providers" });
    await back();
    expect(navNow()).toMatchObject({ section: "agents", agentView: "edit" });
  });

  it("C2: creating an Agent ends in its chat: the form's entry is replaced, Back is the Agents list", async () => {
    render(<Probe />);
    await settle();
    await go({ section: "agents", pane: "list" });
    await go({ pane: "main", agentView: "create" });
    expect(at()).toBe("/agents/new");
    await go(chatOf(C1, { section: "chat", agentView: "detail" }), true);
    expect(at()).toBe(`/chat/${C1}`);
    expect(navNow()).toMatchObject({ convId: C1, pane: "main" });
    await back();
    expect(at()).toBe("/agents");
    expect(navNow()).toMatchObject({ section: "agents", pane: "list" });
  });

  it("only soft state (a tab) rewrites the entry's snapshot: no new entry", async () => {
    render(<Probe />);
    await settle();
    await go({ section: "agents", pane: "main", agentId: AG });
    const pushed = vi.spyOn(window.history, "pushState");
    await go({ agentTab: "memory" });
    expect(pushed).not.toHaveBeenCalled();
    expect(window.history.state.nav.agentTab).toBe("memory");
  });
});

describe("closing a page with its own button", () => {
  it("goes back when the parent is the entry below (no new entry, the same Back as the browser's)", async () => {
    render(<Probe />);
    await settle();
    await go(chatOf(C1));
    await up();
    expect(at()).toBe("/");
    expect(navNow()).toMatchObject({ pane: "list", convId: null });
    // Forward is the conversation again: the entry was walked back to, not rewritten.
    act(() => window.history.forward());
    await settle();
    expect(at()).toBe(`/chat/${C1}`);
  });

  it("n6: a close that runs after an await (a save) does nothing once the person is on another page", async () => {
    render(<Probe />);
    await settle();
    await go(chatOf(C1));
    act(() => goUp(drive.dispatch, "/settings/providers/new")); // the form that asked is not where the person is
    await settle();
    expect(at()).toBe(`/chat/${C1}`);
    act(() => goUp(drive.dispatch, `/chat/${C1}`)); // the page that asked is still here
    await settle();
    expect(at()).toBe("/");
  });

  it("replaces by the parent when the parent is not the entry below, and nothing is pushed", async () => {
    render(<Probe />);
    await settle();
    await go({ section: "agents", pane: "list" });
    await go(chatOf(C1)); // below it: the Agents list
    const pushed = vi.spyOn(window.history, "pushState");
    await up();
    expect(pushed).not.toHaveBeenCalled();
    expect(at()).toBe("/");
    expect(navNow()).toMatchObject({ section: "chat", pane: "list", convId: null });
  });

  it("I2: the details panel is an entry; the close button and Back both end at the conversation", async () => {
    render(<Probe />);
    await settle();
    await go(chatOf(C1));
    await go({ detailsOpen: true });
    expect(at()).toBe(`/chat/${C1}#details`);
    await up();
    expect(navNow()).toMatchObject({ convId: C1, detailsOpen: false });
    await go({ detailsOpen: true });
    await back();
    expect(navNow()).toMatchObject({ convId: C1, detailsOpen: false, pane: "main" });
  });

  it("r4: a click into a page that is not there writes no entry (the shell shows the notice and stays); one that is there is a push as ever", async () => {
    render(<Probe resolves={(page) => page.convId !== C2} />);
    await settle();
    const length = window.history.length;
    await go(chatOf(C2));
    expect(at()).toBe("/");
    expect(window.history.length).toBe(length);
    await go(chatOf(C1));
    expect(at()).toBe(`/chat/${C1}`);
  });

  it("r1: after a close, a tab switch on the parent page is written to its entry: Back and Forward restore the tab the person was on", async () => {
    render(<Probe />);
    await settle();
    await go({ section: "agents", pane: "main", agentId: AG, agentView: "detail" });
    await go({ agentView: "edit" });
    await up(); // the Agent page again, by a close ("none" is still on the navigation)
    expect(at()).toBe(`/agents/${AG}`);
    await go({ agentTab: "memory" });
    expect(window.history.state.nav.agentTab).toBe("memory");
    await go({ section: "contacts", pane: "list", agentId: null });
    await back();
    expect(navNow().agentTab).toBe("memory");
  });

  it("group info → 返回群聊 is the conversation, then the list", async () => {
    render(<Probe />);
    await settle();
    await go(chatOf(C1));
    await go({ view: "profile" });
    expect(at()).toBe(`/chat/${C1}/info`);
    await up();
    expect(navNow()).toMatchObject({ view: "chat", convId: C1 });
    await up();
    expect(navNow()).toMatchObject({ pane: "list", convId: null });
  });
});

describe("a cold start draws its address and makes no entry (I3)", () => {
  it("a link or reload on a conversation: the conversation is drawn; no push, only the entry is stamped once", async () => {
    window.history.replaceState(null, "", `/chat/${C1}`);
    const pushed = vi.spyOn(window.history, "pushState");
    const length = window.history.length;
    render(<Probe />);
    await settle();
    expect(navNow()).toMatchObject({ section: "chat", convId: C1, pane: "main" });
    expect(pushed).not.toHaveBeenCalled();
    expect(window.history.length).toBe(length);
    expect(window.history.state).toMatchObject({ af: 1, index: 0, prev: null });
  });

  it("a reload of an entry of ours keeps its index and prev: nothing is stamped over, the length does not grow, however often", async () => {
    render(<Probe />);
    await settle();
    await go(chatOf(C1));
    const state = window.history.state;
    const length = window.history.length;
    for (let i = 0; i < 3; i += 1) {
      cleanup();
      render(<Probe />); // a reload: a new tree over the same entry
      await settle();
    }
    expect(navNow()).toMatchObject({ convId: C1, pane: "main" });
    expect(window.history.length).toBe(length);
    expect(window.history.state).toEqual(state);
    // And Back is the list, and one Back more leaves the app's entries: no second chat.
    await back();
    expect(at()).toBe("/");
  });

  it("the page's own back on a cold start has nothing of ours below: it replaces by the parent, once", async () => {
    window.history.replaceState(null, "", `/chat/${C1}`);
    render(<Probe />);
    await settle();
    const pushed = vi.spyOn(window.history, "pushState");
    await up();
    expect(pushed).not.toHaveBeenCalled();
    expect(at()).toBe("/");
    expect(navNow()).toMatchObject({ pane: "list", convId: null });
  });

  it("a reload on a pushed page that is not a conversation is drawn too (settings, a contact, an Agent)", async () => {
    window.history.replaceState(null, "", "/settings/memory");
    render(<Probe />);
    await settle();
    expect(navNow()).toMatchObject({ section: "settings", settingsPage: "memory", pane: "main" });
  });
});

describe("an entry rewritten below another is not mistaken for its parent (m2)", () => {
  it("cold /chat/A, group info, Back, 返回列表 (replaces /chat/A with /), Forward, 返回群聊: replaces by the parent, it does not go back to the list", async () => {
    window.history.replaceState(null, "", `/chat/${C1}`);
    render(<Probe />);
    await settle();
    await go({ view: "profile" });
    expect(window.history.state.index).toBe(1);
    await back();
    expect(at()).toBe(`/chat/${C1}`);
    await up(); // nothing of ours below index 0: the entry becomes the list
    expect(at()).toBe("/");
    act(() => window.history.forward());
    await settle();
    expect(at()).toBe(`/chat/${C1}/info`);
    await up();
    expect(at()).toBe(`/chat/${C1}`);
    expect(window.history.state.index).toBe(1); // replaced in place, not walked back to the entry that is now the list
    expect(navNow()).toMatchObject({ convId: C1, view: "chat" });
  });
});

describe("popstate only re-renders", () => {
  it("the handler never calls back, forward, push or replace by itself", async () => {
    render(<Probe />);
    await settle();
    await go(chatOf(C1));
    const spies = ["back", "forward", "go", "pushState", "replaceState"].map((name) => vi.spyOn(window.history, name));
    act(() => window.dispatchEvent(new PopStateEvent("popstate")));
    await settle();
    // (The navigation it drew equals the entry's address: the effect after it has nothing to write.)
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("a width change is nothing to it: no media query is read and the entry is left alone", async () => {
    const query = vi.fn(() => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
    window.matchMedia = query;
    try {
      render(<Probe />);
      await settle();
      await go(chatOf(C1));
      const state = window.history.state;
      window.dispatchEvent(new Event("resize"));
      await settle();
      expect(window.history.state).toEqual(state);
      expect(query).not.toHaveBeenCalled();
    } finally {
      delete window.matchMedia;
    }
  });
});

describe("a dialog is not an address: it is one entry at the page's address", () => {
  it("opening one pushes an entry at the same address; Back leaves it, closes the dialog, and the page drawn is not moved (tests/layers.test.jsx has the rest)", async () => {
    const close = vi.fn();
    render(<Probe />);
    await settle();
    await go(chatOf(C1));
    const page = window.history.state;
    const { unmount } = render(<Modal title="添加成员" onClose={close}>x</Modal>);
    await settle();
    expect(window.history.state).toMatchObject({ path: `/chat/${C1}`, index: page.index + 1, prev: `/chat/${C1}#` });
    expect(window.history.state.layers).toHaveLength(1);
    moves.length = 0;
    await back();
    expect(close).toHaveBeenCalledTimes(1);
    expect(at()).toBe(`/chat/${C1}`);
    expect(navNow()).toMatchObject({ pane: "main", convId: C1 });
    expect(window.history.state).toEqual(page);
    unmount();
  });
});

describe("the viewer is a key of the entry", () => {
  it("opening pushes one entry on the same address; Back leaves it; Forward opens it again; closing by hand goes back to the conversation entry", async () => {
    const { openViewerEntry, closeViewerEntry } = await import("../src/state/appHistory.js");
    render(<Probe />);
    await settle();
    await go(chatOf(C1));
    act(() => openViewerEntry("m3"));
    expect(window.history.state).toMatchObject({ viewer: "m3", path: `/chat/${C1}`, prev: `/chat/${C1}#` });
    expect(at()).toBe(`/chat/${C1}`);
    await back();
    expect(window.history.state.viewer).toBeNull();
    act(() => window.history.forward());
    await settle();
    expect(window.history.state.viewer).toBe("m3");
    act(() => closeViewerEntry());
    await settle();
    expect(window.history.state.viewer).toBeNull();
    expect(at()).toBe(`/chat/${C1}`);
  });
});

// ───────── the invariant: the page drawn is a function of the address, at every width
import { NAV_KEYS } from "../src/state/location.js";
import { reducer } from "../src/state/reducer.js";
import { emptyState } from "../src/data/store.jsx";
import { lastPageOf, forgetSections, sectionRoot } from "../src/state/appHistory.js";

const ALIVE = { convs: { [C1]: { type: "group" }, [C2]: { type: "group" } }, people: {}, agents: {}, providers: {} };

describe("the page-deciding keys equal their address after every move", () => {
  const pick = (nav) => Object.fromEntries(PAGE_KEYS.map((key) => [key, nav[key] ?? null]));
  const initial = () => emptyState({ id: "me" });

  it("every key of the navigation is a page key (with an address), a soft key or a transient one: a new key fails here until it is placed", () => {
    const unplaced = Object.keys(initial().nav).filter((key) => !NAV_KEYS.includes(key));
    expect(unplaced).toEqual([]);
    // A page key that is not in the address table cannot be added without a row in TABLE: each is the key of some row.
    for (const key of PAGE_KEYS) expect(TABLE.some(([patch]) => key in patch) || ["detailsOpen", "providerId"].includes(key), key).toBe(true);
  });

  it("after any nav action the page keys are what the address of the result says (a stale selection cannot stay)", () => {
    const actions = [
      { type: "nav", patch: { section: "chat", pane: "main", convId: C1, detailsOpen: true } },
      { type: "nav", patch: { section: "contacts", pane: "list" } },
      { type: "nav", patch: { section: "contacts", pane: "main", contactId: C2 } },
      { type: "nav", patch: { section: "agents", pane: "list" } },
      { type: "nav", patch: { section: "agents", pane: "main", agentId: AG, agentView: "edit" } },
      { type: "nav", patch: { section: "settings", pane: "main", settingsPage: "providers", providerId: "new" } },
      { type: "nav", patch: { section: "settings", pane: "list" } },
      { type: "nav/openConv", convId: C2 },
      { type: "nav", patch: { section: "chat", pane: "list" } },
      { type: "nav", patch: { pane: "main" } },
      { type: "nav", patch: { convId: null } },
    ];
    let state = initial();
    for (const action of actions) {
      state = reducer(state, action);
      expect(pick(state.nav), JSON.stringify(action)).toEqual(pick({ ...state.nav, ...navOfAddress(addressOf(state.nav)) }));
    }
  });

  it("n1: a key that is not placed throws in the reducer, whether or not it was ever in the initial navigation (a page key cannot arrive by dispatch alone)", () => {
    expect(() => reducer(initial(), { type: "nav", patch: { sidePage: "x" } })).toThrow(/not placed/);
    expect(() => reducer(initial(), { type: "nav/openConv", convId: C1, patch: { sidePage: "x" } })).toThrow(/not placed/);
    expect(() => reducer(initial(), { type: "nav", patch: { agentNote: { text: "x" } } })).not.toThrow();
  });

  it("every move records its own intent as data: push by default, replace when asked, none for a close the browser already made", () => {
    const state = initial();
    expect(reducer(state, { type: "nav", patch: { section: "contacts" } }).nav.navIntent).toBe("push");
    expect(reducer(state, { type: "nav", replace: true, patch: { section: "contacts" } }).nav.navIntent).toBe("replace");
    expect(reducer(state, { type: "nav", intent: "none", patch: { section: "contacts" } }).nav.navIntent).toBe("none");
    expect(reducer(state, { type: "nav/openConv", convId: C1, replace: true }).nav.navIntent).toBe("replace");
  });

  it("a move that changes no address keeps the intent of the one before it, so two moves in one commit cannot turn a replace into a push", () => {
    let state = reducer(initial(), { type: "nav", patch: { section: "agents", pane: "list" } });
    state = reducer(state, { type: "nav", replace: true, patch: { section: "agents", pane: "main", agentId: AG, agentView: "detail" } });
    state = reducer(state, { type: "nav", patch: { opening: { convId: C1 } } }); // (a conversation waited for: no address of its own)
    expect(state.nav.navIntent).toBe("replace");
    state = reducer(state, { type: "nav/openConv", convId: C1 });
    expect(state.nav.navIntent).toBe("push"); // (a move to another address is its own: a push)
  });

  it("n2: providerCreated belongs to the page it was set for: another provider page clears it", () => {
    let state = reducer(initial(), { type: "nav", patch: { section: "settings", pane: "main", settingsPage: "providers", providerId: "p1", providerCreated: true } });
    expect(state.nav.providerCreated).toBe(true);
    state = reducer(state, { type: "nav", patch: { providerId: "p2" } });
    expect(state.nav.providerCreated).toBe(false);
  });

  it("N1: a list address draws no selection: back at the list, the conversation, the contact and the Agent are gone from the page keys", () => {
    let state = reducer(initial(), { type: "nav", patch: { section: "chat", pane: "main", convId: C1, detailsOpen: true } });
    state = reducer(state, { type: "nav", patch: { section: "contacts", pane: "list" } });
    expect(state.nav).toMatchObject({ convId: null, detailsOpen: false, contactId: null });
    state = reducer(state, { type: "nav", patch: { section: "chat", pane: "list" } });
    expect(state.nav).toMatchObject({ convId: null, pane: "list" });
  });

  it("N1: the details panel is part of one conversation's address and does not follow into the next", () => {
    let state = reducer(initial(), { type: "nav/openConv", convId: C1 });
    state = reducer(state, { type: "nav", patch: { detailsOpen: true } });
    expect(addressOf(state.nav)).toEqual({ path: `/chat/${C1}`, overlay: "details" });
    state = reducer(state, { type: "nav/openConv", convId: C2 });
    expect(state.nav.detailsOpen).toBe(false);
    expect(addressOf(state.nav)).toEqual({ path: `/chat/${C2}`, overlay: null });
  });

  it("N1, where two panes show (wide): a section click goes to the last address seen in it (and to its list when it was left on the list)", async () => {
    forgetSections();
    expect(lastPageOf("chat", ALIVE)).toMatchObject({ pane: "list", convId: null });
    render(<Probe />);
    await settle();
    await go(chatOf(C1));
    await go({ section: "contacts", pane: "list", convId: null });
    expect(lastPageOf("chat", ALIVE)).toMatchObject({ pane: "main", convId: C1, detailsOpen: false });
    expect(lastPageOf("contacts", ALIVE)).toMatchObject({ pane: "list" });
    await go(lastPageOf("chat", ALIVE));
    expect(at()).toBe(`/chat/${C1}`);
    await go({ pane: "list", convId: null }); // back at the list: that is where the section was left
    expect(lastPageOf("chat", ALIVE)).toMatchObject({ pane: "list", convId: null });
  });

  it("N1, where one pane shows (a phone, one column): `sectionRoot` is each section's list, and does not forget what was seen in it last", async () => {
    forgetSections();
    render(<Probe />);
    await settle();
    await go(chatOf(C1));
    await go({ section: "agents", pane: "main", agentId: AG, agentView: "detail" });
    await go({ section: "settings", pane: "main", settingsPage: "providers", providerId: "new" });
    expect(sectionRoot("chat")).toMatchObject({ section: "chat", pane: "list", convId: null, detailsOpen: false });
    expect(sectionRoot("contacts")).toMatchObject({ section: "contacts", pane: "list", contactId: null });
    expect(sectionRoot("agents")).toMatchObject({ section: "agents", pane: "list", agentId: null, agentView: "detail" });
    expect(sectionRoot("settings")).toMatchObject({ section: "settings", pane: "list", providerId: null });
    for (const [section, path] of [["chat", "/"], ["contacts", "/contacts"], ["agents", "/agents"], ["settings", "/settings"]]) expect(addressOf({ ...BASE, ...sectionRoot(section) }).path).toBe(path);
    // (The wide layout's answer is not forgotten by it: the last page of the section is still what was seen.)
    expect(lastPageOf("chat", ALIVE)).toMatchObject({ pane: "main", convId: C1 });
  });

  it("the providers form is an address: /settings/providers/new and /settings/providers/<id>", () => {
    expect(addressOf({ ...BASE, section: "settings", pane: "main", settingsPage: "providers", providerId: "new" })).toEqual({ path: "/settings/providers/new", overlay: null });
    expect(navOfAddress({ path: "/settings/providers/p1" })).toMatchObject({ section: "settings", settingsPage: "providers", providerId: "p1", pane: "main" });
    expect(parentOf({ path: "/settings/providers/p1" })).toEqual({ path: "/settings/providers", overlay: null });
  });
});

describe("a dialog does not outlive the page that is not drawn", () => {
  it("one whose page the layout no longer shows closes on resize; one that is shown stays", () => {
    const close = vi.fn();
    const rects = vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([{ top: 0 }]);
    render(<Modal title="调整头像" onClose={close}>x</Modal>);
    act(() => window.dispatchEvent(new Event("resize")));
    expect(close).not.toHaveBeenCalled();
    rects.mockReturnValue([]);
    act(() => window.dispatchEvent(new Event("resize")));
    expect(close).toHaveBeenCalledTimes(1);
  });
});

// N1 on the real shell (the rail and the tab bar themselves, not the helper they call): every section is left on a page of its own in
// the wide layout — where a tab answers that page, which the test checks first — and then the window narrows. A tab that still opened
// the last page there fails here.
describe("N1 on the real rail: the same sections, wide and then narrowed", () => {
  const ONE_COLUMN = "(max-width: 860px)";
  let narrow;
  beforeEach(() => {
    installBrowser();
    forgetSections();
    // A window whose media queries answer from a list that can change, telling whoever listens.
    let on = [];
    const listeners = new Set();
    window.matchMedia = (query) => ({
      get matches() {
        return on.includes(query);
      },
      media: query,
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
    });
    narrow = async (queries) => {
      on = queries;
      await act(async () => listeners.forEach((listener) => listener()));
      await flush();
    };
  });
  afterEach(() => {
    vi.useRealTimers();
    delete window.matchMedia;
  });

  const sync = () =>
    syncOf(
      [direct(D1, ANN, { lastSeq: 1, readSeq: 1 }), agentConv(A1, AG1)],
      [wire(D1, 1, ANN, "早"), wire(A1, 1, AG1, "你好")],
      [...PRINCIPALS, agentPrincipal(AG1, "helper", "小助手")],
    );
  const nav = () => screen.getByRole("navigation", { name: "主导航" });
  const tab = (name) => within(nav()).getByRole("button", { name });
  const press = async (el) => {
    fireEvent.click(el);
    await flush();
  };
  const row = (name) => screen.getByText(name, { selector: ".list-col .row-name" });
  const here = () => window.location.pathname;
  const pane = () => document.querySelector(".app").dataset.pane;

  /** Wide: a conversation, an Agent's page and a settings page are open in their sections; the person is on 通讯录. */
  const leaveEachSectionOnAPage = async () => {
    await openApp({ sync, handlers: { agents: () => ({ agents: [agentOf(AG1)] }), models: () => MODELS } });
    await press(row("小安"));
    expect(here()).toBe(`/chat/${D1}`);
    await press(tab(/^Agent/));
    await press(row("小助手"));
    expect(here()).toBe(`/agents/${AG1}`);
    await press(tab(/^设置/));
    await press(row("模型供应商"));
    expect(here()).toBe("/settings/providers");
    await press(tab(/^通讯录/));
    expect(here()).toBe("/contacts");
  };
  const LAST = [[/^消息/, `/chat/${D1}`], [/^Agent/, `/agents/${AG1}`], [/^设置/, "/settings/providers"]];
  const LISTS = [[/^消息/, "/"], [/^Agent/, "/agents"], [/^设置/, "/settings"], [/^通讯录/, "/contacts"]];

  it("wide: each tab answers the page its section was left on (the control: these are the pages a narrow layout must not open)", async () => {
    await leaveEachSectionOnAPage();
    for (const [name, path] of LAST) {
      await press(tab(name));
      expect(here(), String(name)).toBe(path);
      expect(pane()).toBe("main");
      await press(tab(/^通讯录/));
    }
  });

  it.each([
    ["a phone", ["(max-width: 640px)", "(pointer: coarse)", ONE_COLUMN]],
    ["one column", [ONE_COLUMN]],
  ])("narrowed to %s: each tab answers its section's list, with the navigation still there, and tapped again stays", async (_name, queries) => {
    await leaveEachSectionOnAPage();
    await narrow(queries);
    for (const [name, path] of LISTS) {
      await press(tab(name));
      expect(here(), String(name)).toBe(path);
      expect(pane(), String(name)).toBe("list");
      expect(tab(name).getAttribute("aria-current")).toBe("page");
      const index = window.history.state.index;
      await press(tab(name));
      expect(here()).toBe(path);
      expect(window.history.state.index).toBe(index);
    }
  });
});
