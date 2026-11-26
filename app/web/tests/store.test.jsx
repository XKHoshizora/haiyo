// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { StoreProvider, createDataLayer, emptyState, useStore } from "../src/data/store.jsx";
import { reducer } from "../src/state/reducer.js";
import { ME } from "../src/data/identities.js";
import { ChatList } from "../src/pages/ChatList.jsx";
import { ChatView } from "../src/pages/ChatView.jsx";
import { DetailsPanel } from "../src/pages/DetailsPanel.jsx";
import { GroupProfile } from "../src/pages/GroupProfile.jsx";
import { ContactsList } from "../src/pages/Contacts.jsx";
import { ANN, BO, D1, G1, ME_ID, direct, emptySocial, fakeTimers, fakeTransport, group, notice, range, settle, syncOf, wire } from "./fixtures.js";

afterEach(cleanup);

function Probe({ onStore }) {
  onStore(useStore());
  return null;
}

function mount(layer) {
  const seen = { current: null };
  render(
    <StoreProvider dataLayer={layer}>
      <Probe onStore={(s) => (seen.current = s)} />
    </StoreProvider>,
  );
  return seen;
}

describe("UI reducer", () => {
  it("navigates, opens a conversation and shows then clears a toast", () => {
    let s = emptyState();
    s = reducer(s, { type: "nav/openConv", convId: D1 });
    expect(s.nav).toMatchObject({ section: "chat", convId: D1, view: "chat", pane: "main" });
    s = reducer(s, { type: "toast", text: "好" });
    expect(s.toast).toEqual({ id: 1, text: "好" });
    expect(reducer(s, { type: "toast/clear", id: 2 })).toBe(s);
    expect(reducer(s, { type: "toast/clear", id: 1 }).toast).toBeNull();
    expect(reducer(s, { type: "unknown" })).toBe(s);
  });
});

describe("StoreProvider", () => {
  it("exposes state, dispatch, actions, start, stop and onSignedOut; stays empty until started", async () => {
    const t = fakeTransport({ sync: () => syncOf([direct(D1, ANN, { lastSeq: 2, unread: 1 })], range(D1, 1, 2)) });
    const layer = createDataLayer({ transport: t, api: {}, timers: fakeTimers(), random: () => 0.5 });
    const store = mount(layer);
    expect(Object.keys(store.current).sort()).toEqual(["actions", "dispatch", "onSignedOut", "start", "state", "stop"]);
    expect(store.current.state).toMatchObject({ convs: {}, order: [], agents: {}, connection: "idle", loaded: false });
    expect(t.log).toEqual([]);

    await act(async () => {
      store.current.start();
      await settle();
    });
    expect(store.current.state.order).toEqual([D1]);
    expect(store.current.state.convs[D1].members).toEqual([ME, ANN]);
    expect(store.current.state.connection).toBe("live");
    expect(typeof store.current.actions.sendText).toBe("function");

    act(() => store.current.dispatch({ type: "nav/openConv", convId: D1 }));
    expect(store.current.state.nav.convId).toBe(D1);
    expect(store.current.state.convs[D1]).toBeDefined();

    act(() => store.current.stop());
    expect(store.current.state.convs).toEqual({});
    expect(store.current.state.connection).toBe("idle");
    expect(store.current.state.nav.convId).toBe(D1);
  });

  it("the pages render the view model: direct chat with a hold, group chat, list, details, group profile, contacts", async () => {
    Element.prototype.scrollIntoView = () => {};
    const t = fakeTransport({
      sync: () =>
        syncOf(
          [direct(D1, ANN, { lastSeq: 2, unread: 1, canSend: { ok: false, reason: "blocked" } }), group(G1, { lastSeq: 2 })],
          [wire(D1, 1, ANN, "早上好"), wire(D1, 2, ME_ID, "早", { replyTo: { seq: 1, visible: true, senderId: ANN, text: "早上好", kind: "text" } }), notice(G1, 1, "Mei创建了群聊「周末小组」", { event: "group_created", actorId: ME_ID, title: "周末小组", memberIds: [ANN, BO] }), wire(G1, 2, BO, "周六可以吗")],
        ),
      social: () => ({ ...emptySocial(), friends: [{ id: ANN, handle: "ann", displayName: "小安" }], blockedBy: [{ id: ANN, handle: "ann", displayName: "小安" }] }),
    });
    const layer = createDataLayer({ transport: t, api: {}, timers: fakeTimers(), random: () => 0.5 });
    function Pages() {
      const { state } = useStore();
      if (!state.loaded) return null;
      return (
        <>
          <ChatList />
          <ChatView conv={state.convs[D1]} />
          <ChatView conv={state.convs[G1]} />
          <DetailsPanel conv={state.convs[G1]} />
          <GroupProfile conv={state.convs[G1]} />
          <ContactsList />
        </>
      );
    }
    render(
      <StoreProvider dataLayer={layer}>
        <Pages />
      </StoreProvider>,
    );
    await act(async () => {
      layer.start();
      await settle();
    });
    expect(screen.getByText("早上好", { selector: "blockquote" })).toBeTruthy();
    expect(screen.getAllByText(/小安拉黑了你，只能由对方解除/).length).toBeGreaterThan(0);
    expect(screen.getByText("你创建了群聊「周末小组」，并邀请小安、阿波加入")).toBeTruthy();
    expect(screen.getAllByLabelText("3 人").length).toBeGreaterThan(0);
    expect(screen.queryByText(/真人/)).toBeNull();
    // 会话资料 > 发言成员 (the side panel) says it of nobody either.
    expect(document.body.textContent).not.toContain("真人");
    expect(screen.getAllByRole("button", { name: "群资料" }).length).toBe(1);
    expect(screen.getByText("阿波：周六可以吗")).toBeTruthy();
  });

  it("a sync answered for another account than the layer runs for is not applied: the layer stops and names that account (T2 fix 2, R4)", async () => {
    const other = { id: BO, handle: "bo", displayName: "阿波", email: "bo@example.test" };
    let as = ME_ID;
    const t = fakeTransport({ sync: () => ({ ...syncOf([direct(D1, ANN, { lastSeq: 2 })], range(D1, 1, 2)), ...(as === BO ? { me: other } : {}) }) });
    const layer = createDataLayer({ transport: t, api: {}, timers: fakeTimers(), random: () => 0.5 });
    const told = [];
    layer.onAccountChanged((me) => told.push(me.id));
    const store = mount(layer);
    // Someone else signed in in this browser before the first sync: the answer is theirs.
    as = BO;
    await act(async () => {
      store.current.start({ accountId: ME_ID });
      await settle();
    });
    expect(told).toEqual([BO]);
    expect(store.current.state.order).toEqual([]);
    expect(store.current.state.convs).toEqual({});
    // Nothing more is asked of the service by this layer.
    const asked = t.log.length;
    await act(async () => {
      await settle();
    });
    expect(t.log.length).toBe(asked);
  });

  it("initialState renders a fixed state without a data layer running", () => {

    const fixed = emptyState({ id: ME, kind: "person", name: "你", handle: "@me", cell: [0, 0] });
    fixed.order = ["x"];
    const seen = { current: null };
    render(
      <StoreProvider initialState={fixed}>
        <Probe onStore={(s) => (seen.current = s)} />
      </StoreProvider>,
    );
    expect(seen.current.state.order).toEqual(["x"]);
    expect(seen.current.state.people[ME].name).toBe("你");
  });
});
