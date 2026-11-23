// @vitest-environment jsdom
// The page's one client of the iOS shell's bridge (src/shell/bridge.js). The shell's README, "Bridge", is the contract.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HELLO, installShell } from "./shell-fake.js";

let bridge;
beforeEach(async () => {
  vi.resetModules();
  bridge = await import("../src/shell/bridge.js");
});
afterEach(() => {
  bridge.stopShell();
  delete window.webkit;
  vi.useRealTimers();
});

describe("in an ordinary browser", () => {
  it("is not a shell, says nothing, listens to nothing and leaves nothing behind", async () => {
    const before = Object.keys(window).sort();
    const add = vi.spyOn(window, "addEventListener");
    expect(bridge.inShell()).toBe(false);
    await expect(bridge.startShell()).resolves.toBeNull();
    await expect(bridge.hello()).resolves.toBeNull();
    expect(add.mock.calls.filter(([type]) => String(type).startsWith("haiyo:"))).toEqual([]);
    expect(Object.keys(window).sort()).toEqual(before);
  });

  it("a request fails with a plain code, never a thrown error from the page's globals", async () => {
    await expect(bridge.request("badge.set", { n: 0 })).rejects.toMatchObject({ code: "unavailable" });
  });

  it("another handler under window.webkit (not Haiyo's) is not a shell either", async () => {
    window.webkit = { messageHandlers: { other: { postMessage() {} } } };
    expect(bridge.inShell()).toBe(false);
    await expect(bridge.startShell()).resolves.toBeNull();
    window.webkit = {};
    expect(bridge.inShell()).toBe(false);
    window.webkit = { messageHandlers: { haiyo: {} } };
    expect(bridge.inShell()).toBe(false);
  });
});

describe("hello", () => {
  it("is sent once per page load and lists exactly the events this build handles (not layout)", async () => {
    const shell = installShell();
    const [a, b] = await Promise.all([bridge.startShell(), bridge.hello()]);
    await bridge.hello();
    expect(shell.named("hello")).toHaveLength(1);
    expect(shell.named("hello")[0]).toEqual({ name: "hello", args: { events: ["pause", "resume", "open"] } });
    expect(shell.named("hello")[0].args.events).not.toContain("layout");
    expect(a).toEqual(HELLO);
    expect(b).toEqual(HELLO);
  });

  it("the events it lists are the ones that can be subscribed to", () => {
    expect(bridge.HANDLED_EVENTS).toEqual(["pause", "resume", "open"]);
    expect(() => bridge.on("layout", () => {})).toThrow();
  });

  it("a reply of a later bridge version is a shell too (later versions only add); version 0 or none is not", async () => {
    installShell({ hello: { ...HELLO, bridge: 2 } });
    await expect(bridge.startShell()).resolves.toMatchObject({ bridge: 2 });
    bridge.stopShell();
    installShell({ hello: { ...HELLO, bridge: 0 } });
    await expect(bridge.startShell()).resolves.toBeNull();
  });

  it("a fresh hello (refreshHello) asks the shell again, tells the watchers, and a failed one keeps what was known", async () => {
    const shell = installShell();
    await bridge.startShell();
    const heard = vi.fn();
    bridge.watchHello(heard);
    shell.replies.hello = { ...HELLO, push: "denied" };
    await expect(bridge.refreshHello()).resolves.toMatchObject({ push: "denied" });
    expect(heard).toHaveBeenCalledWith(expect.objectContaining({ push: "denied" }));
    await expect(bridge.hello()).resolves.toMatchObject({ push: "denied" });
    shell.replies.hello = () => Promise.reject("forbidden");
    await expect(bridge.refreshHello()).resolves.toBeNull();
    await expect(bridge.hello()).resolves.toMatchObject({ push: "denied" });
    expect(shell.named("hello")).toHaveLength(3);
  });

  it("a hello the shell refuses ends as null, once, and is not asked again", async () => {
    const shell = installShell({ hello: () => Promise.reject(new Error("forbidden")) });
    await expect(bridge.startShell()).resolves.toBeNull();
    await expect(bridge.hello()).resolves.toBeNull();
    expect(shell.named("hello")).toHaveLength(1);
  });

  it("a page restored from the back/forward cache sends it again on pageshow", async () => {
    const shell = installShell();
    await bridge.startShell();
    window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: false }));
    expect(shell.named("hello")).toHaveLength(1);
    window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    await bridge.hello();
    expect(shell.named("hello")).toHaveLength(2);
  });
});

describe("request", () => {
  it("sends { name, args } and gives the reply", async () => {
    const shell = installShell({ badge: { ok: false } });
    await expect(bridge.request("badge.set", { n: 3 })).resolves.toEqual({ ok: false });
    expect(shell.calls[0]).toEqual({ name: "badge.set", args: { n: 3 } });
  });

  it("a refusal of the shell (forbidden, malformed, unknown) rejects with that code", async () => {
    installShell({ badge: () => Promise.reject("forbidden") });
    await expect(bridge.request("badge.set", { n: 1 })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("push.register has no time limit while the system's question may be open, and a limit can be passed", async () => {
    vi.useFakeTimers();
    installShell({ register: () => new Promise(() => {}), badge: () => new Promise(() => {}) });
    let ended = false;
    bridge.request("push.register", {}).catch(() => (ended = true));
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(ended).toBe(false);
    const short = bridge.request("badge.set", { n: 0 }, { timeoutMs: 1000 }).catch((e) => e.code);
    await vi.advanceTimersByTimeAsync(1001);
    await expect(short).resolves.toBe("timeout");
  });

  it("an answer that does not come ends as timeout", async () => {
    vi.useFakeTimers();
    installShell({ badge: () => new Promise(() => {}), register: () => new Promise(() => {}) });
    const quick = bridge.request("badge.set", { n: 1 }).catch((e) => e.code);
    await vi.advanceTimersByTimeAsync(bridge.TIMEOUT_MS.default + 1);
    await expect(quick).resolves.toBe("timeout");
  });
});

describe("events from the shell", () => {
  it("pause and resume reach their subscribers; a subscriber that left is not called", async () => {
    const shell = installShell();
    await bridge.startShell();
    const paused = vi.fn();
    const resumed = vi.fn();
    const off = bridge.on("pause", paused);
    bridge.on("resume", resumed);
    shell.emit("pause");
    shell.emit("resume");
    off();
    shell.emit("pause");
    expect(paused).toHaveBeenCalledTimes(1);
    expect(resumed).toHaveBeenCalledTimes(1);
  });

  it("a subscriber that throws does not stop the others", async () => {
    const shell = installShell();
    await bridge.startShell();
    const second = vi.fn();
    bridge.on("pause", () => {
      throw new Error("x");
    });
    bridge.on("pause", second);
    shell.emit("pause");
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("an open with an in-app path is kept until someone takes it, once", async () => {
    const shell = installShell();
    await bridge.startShell();
    shell.emit("open", { path: "/chat/c-123" });
    expect(bridge.takeOpen()).toBe("/chat/c-123");
    expect(bridge.takeOpen()).toBeNull();
  });

  it("the latest open wins while none is taken, and watchers hear every one", async () => {
    const shell = installShell();
    await bridge.startShell();
    const heard = vi.fn();
    const off = bridge.watchOpen(heard);
    shell.emit("open", { path: "/chat/a" });
    shell.emit("open", { path: "/contacts" });
    expect(heard).toHaveBeenCalledTimes(2);
    expect(bridge.takeOpen()).toBe("/contacts");
    off();
  });

  it.each([
    ["an external address", "https://evil.example/chat/a"],
    ["a protocol-relative address", "//evil.example/chat/a"],
    ["a scheme", "javascript:alert(1)"],
    ["a backslash", "/\\evil.example"],
    ["a path that is no page of the app", "/api/me"],
    ["an encoded slash", "/chat/a%2fb"],
    ["an encoded backslash", "/chat/a%5Cb"],
    ["the service's own paths, however written", "/API/me"],
    ["a control character", "/chat/a\n/b"],
    ["an empty string", ""],
    ["a number", 5],
    ["null", null],
    ["an encoded dot segment out of the app", "/chat/%2e%2e/%2e%2e/api/me"],
  ])("an open with %s does nothing", async (_name, path) => {
    const shell = installShell();
    await bridge.startShell();
    const heard = vi.fn();
    bridge.watchOpen(heard);
    const load = vi.spyOn(bridge.loader, "assign").mockImplementation(() => {});
    shell.emit("open", { path });
    shell.emit("open", undefined);
    expect(heard).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    expect(bridge.takeOpen()).toBeNull();
  });

  it("an open with a query or a fragment keeps only the path", async () => {
    const shell = installShell();
    await bridge.startShell();
    shell.emit("open", { path: "/chat/c-1?x=1#top" });
    expect(bridge.takeOpen()).toBe("/chat/c-1");
  });

  // The page lists `open`, so the shell no longer loads a URL itself: every same-origin path it sends is opened here.
  it.each([
    ["/terms", "/terms"],
    ["/privacy", "/privacy"],
    ["/contact", "/contact"],
    ["/signin", "/signin"],
    ["/register", "/register"],
    ["/forgot", "/forgot"],
    ["/verify?error=TOKEN_EXPIRED", "/verify?error=TOKEN_EXPIRED"],
    ["a reset link with its token", "/reset-password?token=Zx9_secret-token", "/reset-password?token=Zx9_secret-token"],
    ["a page the app does not know", "/nothing-here?a=1", "/nothing-here?a=1"],
  ])("a same-origin page that is not a signed-in app page (%s) is loaded as it is, query and all, and not queued", async (name, path, expected = path) => {
    const shell = installShell();
    await bridge.startShell();
    const load = vi.spyOn(bridge.loader, "assign").mockImplementation(() => {});
    const logs = ["log", "info", "warn", "error", "debug"].map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
    shell.emit("open", { path });
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith(expected);
    expect(bridge.takeOpen()).toBeNull();
    expect(JSON.stringify(logs.map((l) => l.mock.calls))).not.toContain("token");
    void name;
  });

  it("an in-app address keeps going to the app's navigation, not to a load", async () => {
    const shell = installShell();
    await bridge.startShell();
    const load = vi.spyOn(bridge.loader, "assign").mockImplementation(() => {});
    shell.emit("open", { path: "/chat/c-9" });
    expect(load).not.toHaveBeenCalled();
    expect(bridge.takeOpen()).toBe("/chat/c-9");
  });

  it("subscribers hear the validated path, never the raw detail", async () => {
    const shell = installShell();
    await bridge.startShell();
    const heard = vi.fn();
    bridge.on("open", heard);
    shell.emit("open", { path: "/chat/c-1?x=1#y", evil: "<img>" });
    shell.emit("open", { path: "https://evil.example/" });
    expect(heard.mock.calls).toEqual([[{ path: "/chat/c-1" }]]);
  });

  it("appPathOf accepts the pages of the app and nothing else", () => {
    for (const ok of ["/", "/chat/c-1", "/chat/c-1/info", "/contacts", "/contacts/p-1", "/agents", "/agents/new", "/agents/a-1/edit", "/settings", "/settings/providers/pr-1"]) {
      expect(bridge.appPathOf(ok)).toBe(ok);
    }
    expect(bridge.appPathOf("/chat/c-1/")).toBe("/chat/c-1");
    for (const bad of ["/chat", "/chat/", "/nothing", "/register", "/terms", "chat/c-1", " /chat/c-1"]) {
      expect(bridge.appPathOf(bad)).toBeNull();
    }
  });
});
