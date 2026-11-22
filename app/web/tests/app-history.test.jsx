// @vitest-environment jsdom
// The app's pages in the browser's history: the pure rules, and the hook against jsdom's History API.
import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { chatIdOf, locationOf, planStep, snapshotOf, useAppHistory } from "../src/state/appHistory.js";

const ID = "00000000-0000-4000-8000-0000000000c1";
const nav = (patch = {}) => ({ section: "chat", convId: null, view: "chat", pane: "list", contactId: null, agentId: null, agentView: "detail", agentTab: "profile", settingsPage: "profile", opening: null, ...patch });

describe("locationOf", () => {
  it("one column: the list is depth 0 at /, a conversation depth 1 at its own address, its group info depth 2", () => {
    expect(locationOf(nav({ convId: ID }), true)).toEqual({ path: "/", depth: 0 });
    expect(locationOf(nav({ convId: ID, pane: "main" }), true)).toEqual({ path: `/chat/${ID}`, depth: 1 });
    expect(locationOf(nav({ convId: ID, pane: "main", view: "profile" }), true)).toEqual({ path: `/chat/${ID}`, depth: 2 });
  });

  it("one column: a settings page, a contact and an Agent are depth 1; an Agent's form is depth 2", () => {
    expect(locationOf(nav({ section: "settings", pane: "main", settingsPage: "memory" }), true)).toEqual({ path: "/", depth: 1 });
    expect(locationOf(nav({ section: "contacts", pane: "main", contactId: "x" }), true).depth).toBe(1);
    expect(locationOf(nav({ section: "agents", pane: "main", agentId: "a" }), true).depth).toBe(1);
    expect(locationOf(nav({ section: "agents", pane: "main", agentView: "edit" }), true).depth).toBe(2);
    expect(locationOf(nav({ section: "agents", pane: "main", agentView: "create" }), true).depth).toBe(2);
  });

  it("a conversation that is gone is the list, not a page", () => {
    expect(locationOf(nav({ pane: "main" }), true)).toEqual({ path: "/", depth: 0 });
  });

  it("several columns: always depth 0; the address follows the open conversation", () => {
    expect(locationOf(nav({ convId: ID }), false)).toEqual({ path: `/chat/${ID}`, depth: 0 });
    expect(locationOf(nav({ convId: ID, pane: "main", view: "profile" }), false)).toEqual({ path: `/chat/${ID}`, depth: 0 });
    expect(locationOf(nav({ section: "agents", convId: ID }), false)).toEqual({ path: "/", depth: 0 });
  });
});

describe("chatIdOf", () => {
  it("reads a conversation's address and nothing else", () => {
    expect(chatIdOf(`/chat/${ID}`)).toBe(ID);
    expect(chatIdOf(`/chat/${ID}/`)).toBe(ID);
    for (const other of ["/", "/chat", "/chat/abc", `/chat/${ID}/x`, `/x/chat/${ID}`, "/signin"]) expect(chatIdOf(other)).toBeNull();
  });
});

describe("planStep", () => {
  const at = (depth, path = "/") => ({ path, depth });
  it("deeper: one entry is pushed", () => {
    expect(planStep(at(0), at(1, `/chat/${ID}`), [])).toEqual({ do: "push" });
    expect(planStep(at(1), at(2), [1])).toEqual({ do: "push" });
  });

  it("shallower: back by as many entries as the pages left", () => {
    expect(planStep(at(1, `/chat/${ID}`), at(0), [1])).toEqual({ do: "back", by: 1 });
    expect(planStep(at(2), at(1), [1, 2])).toEqual({ do: "back", by: 1 });
    expect(planStep(at(2), at(0), [1, 2])).toEqual({ do: "back", by: 2 });
  });

  it("shallower with nothing of ours to go back to: the entry is replaced", () => {
    expect(planStep(at(1), at(0), [])).toEqual({ do: "replace" });
  });

  it("the same depth: nothing for the same address, a replace for another (wide screens: another conversation)", () => {
    expect(planStep(at(0, "/"), at(0, "/"))).toEqual({ do: "none" });
    expect(planStep(at(0, `/chat/${ID}`), at(0, "/chat/00000000-0000-4000-8000-0000000000c2"))).toEqual({ do: "replace" });
    expect(planStep(at(1, `/chat/${ID}`), at(1, `/chat/${ID}`), [1])).toEqual({ do: "none" });
  });

  it("nothing known yet: the entry is described by a replace", () => {
    expect(planStep(null, at(0))).toEqual({ do: "replace" });
  });
});

describe("snapshotOf", () => {
  it("keeps the page's identifying keys only", () => {
    const shot = snapshotOf(nav({ convId: ID, opening: { convId: "x" }, focus: { n: 1 }, detailsOpen: true }));
    expect(Object.keys(shot).sort()).toEqual(["agentId", "agentTab", "agentView", "contactId", "convId", "section", "settingsPage", "view"]);
  });
});

// The hook, on jsdom's own history. `Probe` holds a navigation the test moves; `moves` is every dispatch the hook asks for.
let moves;
let setNav;
function Probe({ initial, oneColumn }) {
  const [state, set] = React.useState(initial);
  setNav = set;
  useAppHistory({
    nav: state,
    oneColumn,
    dispatch: (action) => {
      moves.push(action);
      if (action.patch) set((n) => ({ ...n, ...action.patch }));
    },
  });
  return null;
}
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));

beforeEach(() => {
  moves = [];
  window.history.replaceState(null, "", "/");
});
afterEach(cleanup);

describe("useAppHistory on one column", () => {
  it("opening a conversation is an entry at its address; Back (the browser's) returns to the list", async () => {
    render(<Probe initial={nav()} oneColumn />);
    await settle();
    const before = window.history.length;
    act(() => setNav((n) => ({ ...n, convId: ID, pane: "main" })));
    await settle();
    expect(window.location.pathname).toBe(`/chat/${ID}`);
    expect(window.history.length).toBe(before + 1);
    act(() => window.history.back());
    await settle();
    expect(window.location.pathname).toBe("/");
    expect(moves.at(-1)).toEqual({ type: "nav", patch: { pane: "list" } });
  });

  it("the page's own back button (pane list) goes back in the history instead of adding an entry", async () => {
    render(<Probe initial={nav()} oneColumn />);
    await settle();
    act(() => setNav((n) => ({ ...n, convId: ID, pane: "main" })));
    await settle();
    act(() => setNav((n) => ({ ...n, pane: "list" })));
    await settle();
    expect(window.location.pathname).toBe("/");
    // (The entry is still there to go forward to; a new one at "/" would have cut it off.)
    act(() => window.history.forward());
    await settle();
    expect(window.location.pathname).toBe(`/chat/${ID}`);
    expect(moves.filter((m) => m.patch?.pane === "list")).toHaveLength(0); // (nothing is asked of the store for what the store did)
  });

  it("group info is one more entry: Back returns to the conversation, then to the list", async () => {
    render(<Probe initial={nav({ convId: ID })} oneColumn />);
    await settle();
    act(() => setNav((n) => ({ ...n, pane: "main" })));
    await settle();
    act(() => setNav((n) => ({ ...n, view: "profile" })));
    await settle();
    act(() => window.history.back());
    await settle();
    expect(moves.at(-1)).toEqual({ type: "nav", patch: expect.objectContaining({ convId: ID, view: "chat", pane: "main" }) });
    expect(window.location.pathname).toBe(`/chat/${ID}`);
    act(() => window.history.back());
    await settle();
    expect(window.location.pathname).toBe("/");
    expect(moves.at(-1)).toEqual({ type: "nav", patch: { pane: "list" } });
  });

  it("a reload on a conversation's address opens it, with the list under it", async () => {
    window.history.replaceState(null, "", `/chat/${ID}`);
    render(<Probe initial={nav()} oneColumn />);
    await settle();
    expect(moves[0]).toEqual({ type: "nav", patch: { section: "chat", opening: { convId: ID } } });
    expect(window.location.pathname).toBe(`/chat/${ID}`);
    act(() => window.history.back());
    await settle();
    expect(window.location.pathname).toBe("/");
  });

  it("a switch of tab at the top level adds nothing", async () => {
    render(<Probe initial={nav()} oneColumn />);
    await settle();
    const before = window.history.length;
    act(() => setNav((n) => ({ ...n, section: "contacts" })));
    await settle();
    expect(window.history.length).toBe(before);
  });
});

describe("useAppHistory on a wide screen", () => {
  it("the address follows the open conversation and another one replaces it: no entry per conversation", async () => {
    render(<Probe initial={nav()} oneColumn={false} />);
    await settle();
    const before = window.history.length;
    act(() => setNav((n) => ({ ...n, convId: ID, pane: "main" })));
    await settle();
    expect(window.location.pathname).toBe(`/chat/${ID}`);
    const other = "00000000-0000-4000-8000-0000000000c2";
    act(() => setNav((n) => ({ ...n, convId: other })));
    await settle();
    expect(window.location.pathname).toBe(`/chat/${other}`);
    expect(window.history.length).toBe(before);
  });

  it("a reload on a conversation's address opens it, and there is nothing under it to go back to", async () => {
    window.history.replaceState(null, "", `/chat/${ID}`);
    const before = window.history.length;
    render(<Probe initial={nav()} oneColumn={false} />);
    await settle();
    expect(moves[0].patch.opening).toEqual({ convId: ID });
    expect(window.history.length).toBe(before);
  });
});
