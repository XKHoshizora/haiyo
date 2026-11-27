// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { StoreProvider, createDataLayer, emptyState, useStore } from "../src/data/store.jsx";
import { reducer } from "../src/state/reducer.js";
import { ME } from "../src/data/identities.js";
import { ChatList } from "../src/pages/ChatList.jsx";
import { ChatView } from "../src/pages/ChatView.jsx";
import { DetailsPanel } from "../src/pages/DetailsPanel.jsx";
import { GroupProfile } from "../src/pages/GroupProfile.jsx";
import { ContactsList } from "../src/pages/Contacts.jsx";
import { ANN, BO, D1, G1, ME_ID, deferred, direct, emptySocial, fakeTimers, fakeTransport, group, notice, range, settle, syncOf, wire } from "./fixtures.js";
import { ApiError, setAccount, setAccountChangedHandler } from "../src/api/http.js";
import { httpTransport } from "../src/data/sync.js";

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

  it("an account change retires the layer before anyone is told: a late answer of the old account — a 401 included — neither merges nor signs anyone out (T2 fix 3, S1)", async () => {
    const other = { id: BO, handle: "bo", displayName: "阿波", email: "bo@example.test" };
    let as = ME_ID;
    const t = fakeTransport({ sync: () => ({ ...syncOf([direct(D1, ANN, { lastSeq: 2 })], range(D1, 1, 2)), ...(as === BO ? { me: other } : {}) }) });
    // A's GET /api/me (its memory settings screen), in flight across the change.
    const me = deferred();
    const timers = fakeTimers();
    const layer = createDataLayer({ transport: t, api: { getMe: () => me.promise }, timers, random: () => 0.5 });
    const out = [];
    const told = [];
    layer.onSignedOut(() => out.push("signed out"));
    // Told the account: by then the layer is retired, so the old account's 401 that lands now is nobody's.
    layer.onAccountChanged((who) => {
      told.push(who.id);
      me.reject(new ApiError(401, "unauthenticated"));
    });
    const store = mount(layer);
    await act(async () => {
      store.current.start({ accountId: ME_ID });
      await settle();
    });
    let settings;
    act(() => {
      settings = layer.actions.loadMemorySettings();
    });
    // Someone else signed in in this browser: the socket drops, and the reconnect's sync answers for them.
    as = BO;
    await act(async () => {
      t.socket.drop(1006);
      timers.advance(timers.delays()[0]);
      await settle();
    });
    expect(told).toEqual([BO]);
    await act(async () => {
      await settings;
      await settle();
    });
    expect(out).toEqual([]);
    expect(store.current.state.connection).not.toBe("signedOut");
  });

  it("a reconnect under another account's cookie applies nothing of it — not even the catch-up that comes first: every request names the layer's account, and the service refuses it for another (T2 fix 3, S1)", async () => {
    // The service, as far as these requests go: answers as the account whose cookie the browser sends, and refuses (409
    // account_changed) a request that names another account than that one.
    let cookie = ME_ID;
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const fetchMock = vi.fn(async (path, init) => {
      const named = init.headers["X-Account"];
      if (named !== undefined && named !== cookie) return reply(409, { error: "account_changed" });
      if (path === "/api/ws-ticket") return reply(200, { ticket: "tk" });
      if (path === "/api/sync") return reply(200, cookie === ME_ID ? syncOf([group(G1, { lastSeq: 2 })], range(G1, 1, 2)) : { ...syncOf([]), me: { id: BO } });
      if (path === "/api/sync/catchup") return reply(200, { messages: cookie === BO ? [wire(G1, 3, BO, "BO-WHISPER 只给阿波看")] : [], gone: [], more: false });
      if (path === "/api/social") return reply(200, emptySocial());
      if (path === "/api/agent-contacts") return reply(200, { mine: [], waiting: [] });
      if (path === "/api/agents") return reply(200, { agents: [] });
      if (path === "/api/models") return reply(200, { siteModels: [], providerDefaults: { contextTokens: 16000, maxOutputTokens: 2048 } });
      if (String(path).endsWith("/runs")) return reply(200, { runs: [] });
      return reply(404, { error: "not_found" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const sockets = [];
    class Socket {
      constructor() {
        sockets.push(this);
        queueMicrotask(() => this.onopen?.({}));
      }
      send() {}
      close() {}
    }
    const changed = vi.fn();
    setAccount(ME_ID);
    setAccountChangedHandler(changed);
    try {
      const timers = fakeTimers();
      const layer = createDataLayer({ transport: httpTransport({ timers, WebSocketImpl: Socket }), api: {}, timers, random: () => 0.5 });
      const store = mount(layer);
      await act(async () => {
        store.current.start({ accountId: ME_ID });
        await settle();
        await settle();
      });
      expect(store.current.state.connection).toBe("live");
      // Someone else signs in in this browser; this tab's socket drops and it reconnects with their cookie.
      cookie = BO;
      await act(async () => {
        sockets.at(-1).onclose?.({ code: 1006 });
        timers.advance(timers.delays().find((d) => d > 0 && d <= 30_000) ?? 0);
        await settle();
        await settle();
      });
      expect(JSON.stringify(layer.getSnapshot().model.messages)).not.toContain("BO-WHISPER");
      expect(changed).toHaveBeenCalled();
      expect(fetchMock.mock.calls.filter(([path]) => path === "/api/sync/catchup").every(([, init]) => init.headers["X-Account"] === ME_ID)).toBe(true);
    } finally {
      setAccount(null);
      setAccountChangedHandler(null);
      vi.unstubAllGlobals();
    }
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
