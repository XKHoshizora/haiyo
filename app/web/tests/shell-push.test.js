// @vitest-environment jsdom
// Push registration in the iOS shell (src/shell/push.js): after sign-in `push.register`, then `POST /api/push/devices`; on sign-out
// `DELETE /api/push/devices/current`, then `badge.set { n: 0 }`. The shell's README ("What the web side still has to do", 2) and the
// service's README ("Push devices (the iOS app)") are the contract.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HELLO, fakePushApi, installShell } from "./shell-fake.js";

const TOKEN = "AB12".repeat(16);
let bridge;
let push;
beforeEach(async () => {
  vi.resetModules();
  bridge = await import("../src/shell/bridge.js");
  push = await import("../src/shell/push.js");
});
afterEach(() => {
  bridge.stopShell();
  delete window.webkit;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const shellOf = async (opts) => {
  const shell = installShell(opts);
  await bridge.startShell();
  return shell;
};

describe("registering", () => {
  it("granted: registers silently (push.register, then one POST with the token, the service's env word and the shell's version)", async () => {
    const shell = await shellOf({ register: { token: TOKEN, env: "development" } });
    const order = [];
    const api = fakePushApi(order);
    await push.registerPush(api);
    expect(shell.named("push.register")).toHaveLength(1);
    expect(api.registerPushDevice).toHaveBeenCalledTimes(1);
    expect(api.registerPushDevice).toHaveBeenCalledWith({ token: TOKEN, env: "sandbox", appVersion: "0.1.0" });
  });

  it("the shell's `production` stays production; its `development` is the service's `sandbox`", async () => {
    await shellOf({ register: { token: TOKEN, env: "production" } });
    const api = fakePushApi();
    await push.registerPush(api);
    expect(api.registerPushDevice.mock.calls[0][0].env).toBe("production");
  });

  it("notDetermined: asks once (push.register is what shows the system's question)", async () => {
    const shell = await shellOf({ hello: { ...HELLO, push: "notDetermined" } });
    const api = fakePushApi();
    await push.registerPush(api);
    await push.registerPush(api);
    await push.registerPush(api);
    expect(shell.named("push.register")).toHaveLength(1);
    expect(api.registerPushDevice).toHaveBeenCalledTimes(1);
  });

  it("denied: no ask, no POST, nothing to repeat", async () => {
    const shell = await shellOf({ hello: { ...HELLO, push: "denied" } });
    const api = fakePushApi();
    await push.registerPush(api);
    await push.registerPush(api);
    expect(shell.named("push.register")).toHaveLength(0);
    expect(api.registerPushDevice).not.toHaveBeenCalled();
  });

  it("refused at the question ({ denied: true }): no POST and not asked again in this page load", async () => {
    const shell = await shellOf({ hello: { ...HELLO, push: "notDetermined" }, register: { denied: true } });
    const api = fakePushApi();
    await push.registerPush(api);
    await push.registerPush(api);
    expect(shell.named("push.register")).toHaveLength(1);
    expect(api.registerPushDevice).not.toHaveBeenCalled();
  });

  it.each([
    ["timeout", { error: "timeout" }],
    ["busy", { error: "busy" }],
    ["a failed registration", { error: "registration_failed" }],
    ["a refusal of the shell", () => Promise.reject("forbidden")],
    ["a token that is no hex", { token: "not-hex", env: "production" }],
    ["an environment nobody knows", { token: TOKEN, env: "staging" }],
    ["no answer at all", () => Promise.resolve(undefined)],
  ])("%s: no POST, no loop; the next cold start tries again", async (_name, register) => {
    const shell = await shellOf({ register });
    const api = fakePushApi();
    await push.registerPush(api);
    await push.registerPush(api);
    await Promise.resolve();
    expect(shell.named("push.register")).toHaveLength(1);
    expect(api.registerPushDevice).not.toHaveBeenCalled();
    // The next cold start is a new page: the module is new, nothing remembered.
    vi.resetModules();
    bridge.stopShell();
    bridge = await import("../src/shell/bridge.js");
    push = await import("../src/shell/push.js");
    shell.replies["push.register"] = { token: TOKEN, env: "production" };
    await bridge.startShell();
    await push.registerPush(api);
    expect(api.registerPushDevice).toHaveBeenCalledTimes(1);
  });

  it("a POST that fails is not repeated and does not throw", async () => {
    await shellOf();
    const api = fakePushApi([], { registerPushDevice: vi.fn(async () => Promise.reject(Object.assign(new Error("x"), { status: 500 }))) });
    await expect(push.registerPush(api)).resolves.toBeUndefined();
    await push.registerPush(api);
    expect(api.registerPushDevice).toHaveBeenCalledTimes(1);
  });

  it("a shell version that is not one printable line is left out of the body", async () => {
    await shellOf({ hello: { ...HELLO, shell: "x".repeat(40) }, register: { token: TOKEN, env: "development" } });
    const api = fakePushApi();
    await push.registerPush(api);
    expect(api.registerPushDevice.mock.calls[0][0]).toEqual({ token: TOKEN, env: "sandbox" });
  });

  it("in a browser nothing is asked and nothing is sent", async () => {
    const api = fakePushApi();
    await push.registerPush(api);
    await push.unregisterPush(api);
    await push.pushSessionEnded();
    expect(api.registerPushDevice).not.toHaveBeenCalled();
    expect(api.removePushDevice).not.toHaveBeenCalled();
  });

  it("the token is in no log, no storage and no address", async () => {
    const logs = ["log", "info", "warn", "error", "debug"].map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
    await shellOf({ register: { token: TOKEN.toLowerCase(), env: "production" } });
    const api = fakePushApi([], { registerPushDevice: vi.fn(async () => Promise.reject(new Error("boom"))) });
    await push.registerPush(api);
    const all = JSON.stringify(logs.map((l) => l.mock.calls)) + JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + location.href + document.cookie;
    expect(all).not.toContain(TOKEN.toLowerCase());
    expect(all).not.toContain(TOKEN);
  });

  it("a registration that was under way when the person signed out is not sent", async () => {
    let answer;
    const shell = await shellOf({ register: () => new Promise((resolve) => (answer = resolve)) });
    const api = fakePushApi();
    const running = push.registerPush(api);
    await vi.waitFor(() => expect(shell.named("push.register")).toHaveLength(1));
    await push.unregisterPush(api);
    answer({ token: TOKEN, env: "production" });
    await running;
    expect(api.registerPushDevice).not.toHaveBeenCalled();
  });

  it("signing in again after a sign-out registers again (a new session has no phone yet)", async () => {
    await shellOf();
    const api = fakePushApi();
    await push.registerPush(api);
    await push.unregisterPush(api);
    await push.registerPush(api);
    expect(api.registerPushDevice).toHaveBeenCalledTimes(2);
  });
});

describe("signing out", () => {
  it("unbinds the phone first, then clears the badge, in that order", async () => {
    const order = [];
    const shell = await shellOf({ badge: () => (order.push("badge"), { ok: true }) });
    const api = fakePushApi(order);
    await push.unregisterPush(api);
    expect(order).toEqual(["DELETE", "badge"]);
    expect(shell.named("badge.set")[0].args).toEqual({ n: 0 });
  });

  it("a DELETE that fails does not keep the badge from being cleared", async () => {
    const order = [];
    const shell = await shellOf({ badge: () => (order.push("badge"), { ok: true }) });
    const api = fakePushApi(order, { removePushDevice: vi.fn(async () => (order.push("DELETE"), Promise.reject(new Error("offline")))) });
    await expect(push.unregisterPush(api)).resolves.toBeUndefined();
    expect(order).toEqual(["DELETE", "badge"]);
    expect(shell.named("badge.set")).toHaveLength(1);
  });

  it("a DELETE that never answers is given up after a few seconds, so signing out is not held", async () => {
    vi.useFakeTimers();
    const shell = await shellOf();
    const api = fakePushApi([], { removePushDevice: vi.fn(() => new Promise(() => {})) });
    const done = push.unregisterPush(api);
    await vi.advanceTimersByTimeAsync(push.UNBIND_MS + 1);
    await done;
    expect(shell.named("badge.set")).toHaveLength(1);
  });

  it("a session that ended by itself (expiry, another tab) clears the badge once and asks the service nothing", async () => {
    const shell = await shellOf();
    const api = fakePushApi();
    await push.pushSessionEnded();
    expect(api.removePushDevice).not.toHaveBeenCalled();
    expect(shell.named("badge.set")).toHaveLength(1);
  });

  it("the end that follows a deliberate sign-out does not clear the badge a second time", async () => {
    const shell = await shellOf();
    const api = fakePushApi();
    await push.unregisterPush(api);
    await push.pushSessionEnded();
    expect(shell.named("badge.set")).toHaveLength(1);
  });
});
