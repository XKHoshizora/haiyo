// @vitest-environment jsdom
// The page in the iOS shell, wired into the app (src/shell/useShell.js, auth/AuthRoot.jsx, AppShell.jsx): push after the person is in,
// sign-out in order, pause/resume of the socket, a tapped notification — and, in an ordinary browser, none of it.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, configure, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiError } from "../src/api/http.js";
import { AuthRoot, useSession } from "../src/auth/AuthRoot.jsx";
import { StoreProvider, createDataLayer, emptyState, useStore } from "../src/data/store.jsx";
import { fakeTimers, fakeTransport, syncOf } from "./fixtures.js";
import { useAppHistory } from "../src/state/appHistory.js";
import * as bridge from "../src/shell/bridge.js";
import { pushSessionEnded } from "../src/shell/push.js";
import { useShellOpen } from "../src/shell/useShell.js";
import { SettingsList } from "../src/pages/Settings.jsx";
import { HELLO, fakePushApi, installShell } from "./shell-fake.js";

configure({ asyncUtilTimeout: 5_000 });
vi.setConfig({ testTimeout: 15_000 });

const ANN = { id: "p-ann", handle: "ann", displayName: "小安", email: "ann@x.com" };
const C1 = "00000000-0000-4000-8000-0000000000c1";
const SIGNED_OUT = () => new ApiError(401, "unauthenticated");
const at = (path) => history.replaceState(null, "", path);
const place = () => location.pathname + location.search;

let layers;
let order;
let shell;
const fakeLayer = () => {
  const handlers = new Set();
  const layer = {
    start: vi.fn(),
    stop: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    onSignedOut: (fn) => {
      handlers.add(fn);
      return () => handlers.delete(fn);
    },
    /** The session ends from the data layer's side (socket close 4001, a 401). */
    end: () => handlers.forEach((fn) => fn()),
  };
  layers.push(layer);
  return layer;
};

function apiOf(over = {}) {
  return {
    getMe: vi.fn(async () => ANN),
    signIn: vi.fn(async () => ({})),
    signOut: vi.fn(async () => (order.push("signOut"), { success: true })),
    getSite: vi.fn(async () => ({ mailDelivered: true, termsRequired: true })),
    ...fakePushApi(order),
    ...over,
  };
}
const outThenIn = (over) => apiOf({ getMe: vi.fn().mockRejectedValueOnce(SIGNED_OUT()).mockResolvedValue(ANN), ...over });

function SignOutButton() {
  const session = useSession();
  return <button onClick={() => session.signOut()}>退出</button>;
}
const mount = (api) =>
  render(
    <AuthRoot api={api} createLayer={fakeLayer}>
      {() => (
        <div data-testid="app">
          <SignOutButton />
        </div>
      )}
    </AuthRoot>,
  );
const signInUi = async () => {
  fireEvent.change(await screen.findByLabelText("邮箱"), { target: { value: "ann@x.com" } });
  fireEvent.change(screen.getByLabelText("密码"), { target: { value: "correct horse" } });
  fireEvent.click(screen.getByRole("button", { name: "登录" }));
  await screen.findByTestId("app");
};

beforeEach(() => {
  layers = [];
  order = [];
  at("/");
});
afterEach(async () => {
  cleanup();
  await pushSessionEnded(); // (A new page for the next test: nothing of this session is remembered.)
  bridge.stopShell();
  delete window.webkit;
  vi.restoreAllMocks();
});

const enterShell = async (opts) => {
  shell = installShell({ badge: () => (order.push("badge"), { ok: true }), ...opts });
  await bridge.startShell();
};

describe("push", () => {
  it("a cold start while signed in, permission granted: registered silently, once", async () => {
    await enterShell();
    const api = apiOf();
    mount(api);
    await screen.findByTestId("app");
    await waitFor(() => expect(api.registerPushDevice).toHaveBeenCalledTimes(1));
    expect(shell.named("push.register")).toHaveLength(1);
    expect(layers[0].start).toHaveBeenCalledWith({ paused: false });
  });

  it("signed out: not asked on the sign-in page; asked once after the sign-in, and the token sent", async () => {
    await enterShell({ hello: { ...HELLO, push: "notDetermined" } });
    const api = outThenIn();
    at("/signin");
    mount(api);
    await screen.findByLabelText("邮箱");
    await act(async () => {});
    expect(shell.named("push.register")).toHaveLength(0);
    expect(api.registerPushDevice).not.toHaveBeenCalled();
    await signInUi();
    await waitFor(() => expect(api.registerPushDevice).toHaveBeenCalledTimes(1));
    expect(shell.named("push.register")).toHaveLength(1);
  });

  it("denied: nothing asked, nothing sent", async () => {
    await enterShell({ hello: { ...HELLO, push: "denied" } });
    const api = apiOf();
    mount(api);
    await screen.findByTestId("app");
    await act(async () => {});
    expect(shell.named("push.register")).toHaveLength(0);
    expect(api.registerPushDevice).not.toHaveBeenCalled();
  });

  it("a page that loads in the background asks nothing and opens no socket until it is shown", async () => {
    await enterShell({ hello: { ...HELLO, push: "notDetermined" } });
    const state = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const api = apiOf();
    mount(api);
    await screen.findByTestId("app");
    await act(async () => {});
    expect(layers[0].start).toHaveBeenCalledWith({ paused: true });
    expect(shell.named("push.register")).toHaveLength(0);
    state.mockReturnValue("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() => expect(api.registerPushDevice).toHaveBeenCalledTimes(1));
    expect(layers[0].resume).toHaveBeenCalled();
  });

  it("sign-out: the phone is unbound, then the badge cleared, then the session ended — in that order", async () => {
    await enterShell();
    const api = apiOf();
    mount(api);
    await waitFor(() => expect(api.registerPushDevice).toHaveBeenCalledTimes(1));
    order.length = 0;
    fireEvent.click(screen.getByRole("button", { name: "退出" }));
    await screen.findByLabelText("邮箱");
    expect(order).toEqual(["DELETE", "badge", "signOut"]);
    expect(shell.named("badge.set")).toEqual([{ name: "badge.set", args: { n: 0 } }]);
  });

  it("sign-out goes on although the unbinding failed", async () => {
    await enterShell();
    const api = apiOf({ removePushDevice: vi.fn(async () => (order.push("DELETE"), Promise.reject(new ApiError(0, "network_error")))) });
    mount(api);
    await waitFor(() => expect(api.registerPushDevice).toHaveBeenCalledTimes(1));
    order.length = 0;
    fireEvent.click(screen.getByRole("button", { name: "退出" }));
    await screen.findByLabelText("邮箱");
    expect(order).toEqual(["DELETE", "badge", "signOut"]);
  });

  it("a session that ended by itself clears the badge and asks the service nothing", async () => {
    await enterShell();
    const api = apiOf({ getMe: vi.fn(async () => ANN) });
    mount(api);
    await waitFor(() => expect(api.registerPushDevice).toHaveBeenCalledTimes(1));
    order.length = 0;
    act(() => layers[0].end());
    await screen.findByLabelText("邮箱");
    await waitFor(() => expect(shell.named("badge.set")).toHaveLength(1));
    expect(api.removePushDevice).not.toHaveBeenCalled();
    expect(order).toEqual(["badge"]);
  });
});

describe("in an ordinary browser", () => {
  it("signing in and out sends nothing to anyone and leaves nothing on window", async () => {
    const before = Object.keys(window).sort();
    const api = outThenIn();
    at("/signin");
    mount(api);
    await signInUi();
    expect(layers[0].start).toHaveBeenCalledWith({ paused: false });
    fireEvent.click(screen.getByRole("button", { name: "退出" }));
    await screen.findByLabelText("邮箱");
    expect(api.registerPushDevice).not.toHaveBeenCalled();
    expect(api.removePushDevice).not.toHaveBeenCalled();
    expect(order).toEqual(["signOut"]);
    expect(Object.keys(window).sort()).toEqual(before);
  });

  it("the shell's events do nothing", async () => {
    const api = apiOf();
    mount(api);
    await screen.findByTestId("app");
    act(() => {
      window.dispatchEvent(new Event("haiyo:pause"));
      window.dispatchEvent(new CustomEvent("haiyo:open", { detail: { path: `/chat/${C1}` } }));
    });
    expect(layers[0].pause).not.toHaveBeenCalled();
    expect(place()).toBe("/");
  });
});

describe("an ordinary desktop browser", () => {
  it("hiding the tab does not touch the socket, and a tab that mounts hidden connects as before", async () => {
    const state = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    mount(apiOf());
    await screen.findByTestId("app");
    await act(async () => {});
    expect(layers[0].start).toHaveBeenCalledWith({ paused: false });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    state.mockReturnValue("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    state.mockReturnValue("hidden");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(layers[0].pause).not.toHaveBeenCalled();
    expect(layers[0].resume).not.toHaveBeenCalled();
  });
});

describe("pause and resume", () => {
  it("several visibility changes register the phone once", async () => {
    await enterShell();
    const api = apiOf();
    mount(api);
    await waitFor(() => expect(api.registerPushDevice).toHaveBeenCalledTimes(1));
    for (let i = 0; i < 3; i += 1) act(() => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => {});
    expect(shell.named("push.register")).toHaveLength(1);
    expect(api.registerPushDevice).toHaveBeenCalledTimes(1);
  });

  it("a resume asks the shell again (hello) and registers a phone whose permission was turned on meanwhile", async () => {
    await enterShell({ hello: { ...HELLO, push: "denied" } });
    const api = apiOf();
    mount(api);
    await screen.findByTestId("app");
    await act(async () => {});
    expect(api.registerPushDevice).not.toHaveBeenCalled();
    shell.replies.hello = { ...HELLO, push: "granted" };
    act(() => shell.emit("resume"));
    await waitFor(() => expect(api.registerPushDevice).toHaveBeenCalledTimes(1));
    expect(shell.named("hello")).toHaveLength(2);
  });

  it("haiyo:pause lets the socket go, haiyo:resume brings it back through the data layer", async () => {
    await enterShell();
    mount(apiOf());
    await screen.findByTestId("app");
    await act(async () => {});
    act(() => shell.emit("pause"));
    expect(layers[0].pause).toHaveBeenCalledTimes(1);
    act(() => shell.emit("resume"));
    expect(layers[0].resume).toHaveBeenCalledTimes(1);
  });

  it("the page's own visibility says the same, so a missed event does not leave a ghost socket", async () => {
    await enterShell();
    mount(apiOf());
    await screen.findByTestId("app");
    await act(async () => {});
    const state = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(layers[0].pause).toHaveBeenCalledTimes(1);
    state.mockReturnValue("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(layers[0].resume).toHaveBeenCalledTimes(1);
  });
});

describe("a tapped notification, signed out", () => {
  it("one that comes after an expiry is not kept for the next person to sign in", async () => {
    await enterShell();
    const api = apiOf();
    mount(api);
    await screen.findByTestId("app");
    act(() => layers[0].end());
    await screen.findByLabelText("邮箱");
    act(() => shell.emit("open", { path: `/chat/${C1}` }));
    expect(place()).toBe("/signin");
    api.getMe.mockResolvedValue(ANN);
    await signInUi();
    expect(place()).toBe("/");
  });

  it.each(["/register", "/forgot", "/reset-password", "/verify"])("one that comes while %s is open leaves that page alone", async (page) => {
    await enterShell();
    at(page);
    mount(outThenIn());
    await act(async () => {});
    act(() => shell.emit("open", { path: `/chat/${C1}` }));
    await act(async () => {});
    expect(place()).toBe(page);
  });

  it("a page that is not an app page (the terms, a reset link with its token) is loaded as it is, signed in or out", async () => {
    await enterShell();
    const load = vi.spyOn(bridge.loader, "assign").mockImplementation(() => {});
    mount(outThenIn());
    await screen.findByLabelText("邮箱");
    act(() => shell.emit("open", { path: "/reset-password?token=abc123" }));
    act(() => shell.emit("open", { path: "/terms" }));
    expect(load.mock.calls).toEqual([["/reset-password?token=abc123"], ["/terms"]]);
  });

  it("goes to the sign-in page and on to that page after the sign-in (the app's own return address)", async () => {
    await enterShell();
    const api = outThenIn();
    at("/");
    mount(api);
    await screen.findByLabelText("邮箱");
    act(() => shell.emit("open", { path: `/chat/${C1}` }));
    expect(place()).toBe("/signin");
    await signInUi();
    expect(place()).toBe(`/chat/${C1}`);
  });

  it("one that came before the session was known (a cold start) is kept until it is", async () => {
    await enterShell();
    let answer;
    const api = outThenIn({ getMe: vi.fn(() => new Promise((_, reject) => (answer = reject))) });
    mount(api);
    shell.emit("open", { path: `/chat/${C1}` });
    expect(place()).toBe("/");
    await act(async () => answer(SIGNED_OUT()));
    await screen.findByLabelText("邮箱");
    expect(place()).toBe("/signin");
    api.getMe.mockResolvedValue(ANN);
    await signInUi();
    expect(place()).toBe(`/chat/${C1}`);
  });

  it("an address that is not a page of the app is ignored", async () => {
    await enterShell();
    mount(outThenIn());
    await screen.findByLabelText("邮箱");
    act(() => shell.emit("open", { path: "https://evil.example/chat/x" }));
    expect(place()).toBe("/signin");
    await signInUi();
    expect(place()).toBe("/");
  });
});

// The signed-in app: `useShellOpen` hands the address to the navigation and the history writes the entry.
function Reader() {
  const { state, dispatch } = useStore();
  useShellOpen();
  useAppHistory({ nav: state.nav, dispatch });
  return <output data-testid="nav">{state.nav.convId ?? "-"}|{state.nav.section}|{state.nav.pane}</output>;
}
const withStore = () => (
  <StoreProvider initialState={emptyState(ANN)}>
    <Reader />
  </StoreProvider>
);

describe("a tapped notification, signed in", () => {
  it("opens that address through the app's own navigation, as one new entry", async () => {
    await enterShell();
    render(withStore());
    await act(async () => {});
    const length = history.length;
    act(() => shell.emit("open", { path: `/chat/${C1}` }));
    await waitFor(() => expect(screen.getByTestId("nav").textContent).toBe(`${C1}|chat|main`));
    expect(place()).toBe(`/chat/${C1}`);
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(history.length).toBe(length + 1);
    // The same tap again is the same address: no second entry.
    act(() => shell.emit("open", { path: `/chat/${C1}` }));
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(history.length).toBe(length + 1);
  });

  it("one that arrived before the app was there is opened when it is (a cold start)", async () => {
    await enterShell();
    shell.emit("open", { path: "/contacts" });
    render(withStore());
    await waitFor(() => expect(screen.getByTestId("nav").textContent).toBe("-|contacts|list"));
    expect(place()).toBe("/contacts");
  });

  it.each(["https://evil.example/x", "//evil.example", "/api/me", "javascript:alert(1)", "/chat"])("%s does nothing", async (path) => {
    await enterShell();
    render(withStore());
    await act(async () => {});
    const length = history.length;
    act(() => shell.emit("open", { path }));
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(place()).toBe("/");
    expect(history.length).toBe(length);
    expect(screen.getByTestId("nav").textContent).toBe("-|chat|list");
  });
});

describe("settings, when notifications are off for the app", () => {
  const settings = () => (
    <StoreProvider initialState={emptyState(ANN)}>
      <SettingsList />
    </StoreProvider>
  );
  const LINE = /通知已关闭/;

  it("says so in one quiet line (no banner, no dialog) when the system refused them", async () => {
    await enterShell({ hello: { ...HELLO, push: "denied" } });
    render(settings());
    expect(await screen.findByText(LINE)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each(["granted", "notDetermined"])("says nothing when the permission is %s", async (push) => {
    await enterShell({ hello: { ...HELLO, push } });
    render(settings());
    await screen.findByText("设置");
    await act(async () => {});
    expect(screen.queryByText(LINE)).toBeNull();
  });

  it("follows a resume: off in the system's Settings shows the line, on takes it away", async () => {
    await enterShell({ hello: { ...HELLO, push: "granted" } });
    render(settings());
    await screen.findByText("设置");
    await act(async () => {});
    expect(screen.queryByText(LINE)).toBeNull();
    shell.replies.hello = { ...HELLO, push: "denied" };
    await act(async () => {
      await bridge.refreshHello();
    });
    expect(screen.getByText(LINE)).toBeTruthy();
    shell.replies.hello = { ...HELLO, push: "granted" };
    await act(async () => {
      await bridge.refreshHello();
    });
    expect(screen.queryByText(LINE)).toBeNull();
  });

  it("says nothing in a browser", async () => {
    render(settings());
    await screen.findByText("设置");
    await act(async () => {});
    expect(screen.queryByText(LINE)).toBeNull();
  });
});

// The order measured in the shell's WKWebView (iOS 27.2): going away, `haiyo:pause` arrives while `visibilityState` is still "visible" and
// `visibilitychange` to hidden follows ~0.8 s later; coming back, `haiyo:resume` arrives while it is still "hidden" and `visibilitychange` to
// visible follows ~0.15 s later. Each order, and the reverse, ends with exactly one open socket (or none), through the real data layer.
describe("the order of the signals", () => {
  let transport;
  let visibilityState;
  const realLayer = () => {
    transport = fakeTransport({ sync: () => syncOf([]) });
    return createDataLayer({ transport, api: {}, timers: fakeTimers(), now: () => 0 });
  };
  const mountReal = (api) =>
    render(
      <AuthRoot api={api} createLayer={realLayer}>
        {() => <div data-testid="app" />}
      </AuthRoot>,
    );
  const visibility = (state) => {
    visibilityState.mockReturnValue(state);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
  };
  const open = () => transport.sockets.filter((s) => !s.closed).length;
  const connects = () => transport.log.filter((x) => x === "connect").length;
  beforeEach(() => {
    visibilityState = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  });

  const live = async () => {
    mountReal(apiOf());
    await screen.findByTestId("app");
    await waitFor(() => expect(open()).toBe(1));
    await act(async () => {});
  };

  it("away: pause first (still visible), hidden after: one close, the late one a no-op; back: resume first (still hidden), visible after: one socket", async () => {
    await enterShell({ hello: { ...HELLO, push: "denied" } });
    await live();
    act(() => shell.emit("pause"));
    expect(open()).toBe(0);
    visibility("hidden");
    expect(open()).toBe(0);
    expect(connects()).toBe(1);
    shell.replies.hello = { ...HELLO, push: "granted" };
    act(() => shell.emit("resume"));
    await waitFor(() => expect(open()).toBe(1));
    // The permission is asked while visibilityState still says hidden: "in the background" is the shell's pause, not the page's visibility.
    await waitFor(() => expect(shell.named("push.register")).toHaveLength(1));
    visibility("visible");
    await act(async () => {});
    expect(open()).toBe(1);
    expect(connects()).toBe(2);
    expect(shell.named("hello")).toHaveLength(2);
  });

  it("the reverse orders end the same way: hidden before pause, visible before resume", async () => {
    await enterShell();
    await live();
    visibility("hidden");
    expect(open()).toBe(0);
    act(() => shell.emit("pause"));
    expect(open()).toBe(0);
    visibility("visible");
    await waitFor(() => expect(open()).toBe(1));
    act(() => shell.emit("resume"));
    await act(async () => {});
    expect(open()).toBe(1);
    expect(connects()).toBe(2);
  });

  it("a resume with nothing before it (a missed pause), or twice, and a pause twice, leave one socket and none", async () => {
    await enterShell();
    await live();
    act(() => shell.emit("resume"));
    act(() => shell.emit("resume"));
    await act(async () => {});
    expect(open()).toBe(1);
    expect(connects()).toBe(1);
    act(() => shell.emit("pause"));
    act(() => shell.emit("pause"));
    visibility("hidden");
    visibility("hidden");
    expect(open()).toBe(0);
  });

  it("a page that loads in the background opens nothing; the shell's resume (visibilityState still hidden) connects it, the later visible adds nothing", async () => {
    await enterShell({ hello: { ...HELLO, push: "notDetermined" } });
    visibilityState.mockReturnValue("hidden");
    const api = apiOf();
    mountReal(api);
    await screen.findByTestId("app");
    await act(async () => {});
    expect(connects()).toBe(0);
    expect(shell.named("push.register")).toHaveLength(0);
    act(() => shell.emit("resume"));
    await waitFor(() => expect(open()).toBe(1));
    await waitFor(() => expect(api.registerPushDevice).toHaveBeenCalledTimes(1));
    visibility("visible");
    await act(async () => {});
    expect(open()).toBe(1);
    expect(connects()).toBe(1);
    expect(shell.named("push.register")).toHaveLength(1);
  });
});
