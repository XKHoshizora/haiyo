// The page inside the iOS app's shell, against the real service: a fake `window.webkit.messageHandlers.haiyo` (injected before the page loads,
// as the shell's WKWebView does) answers the bridge. Sign-in → the phone is registered (the service has the row) → sign-out unbinds it, in
// order; a tapped notification opens its page; pause lets the socket go and resume catches up; in an ordinary browser none of it exists.
import { test, expect } from "./support/fixtures.mjs";
import { befriend, newIdentity, registerVerified, sendApi } from "./support/accounts.mjs";
import { chatPane, goTo, rail, signInUi, signOutUi } from "./support/app.mjs";
import { pushDevicesOf } from "./support/db.mjs";
import { REMOTE } from "./support/env.mjs";

test.skip(REMOTE, "reads the service's push_devices table: local mode only");

const TOKEN = "0123456789ABCDEF".repeat(4);

/** Runs in every document before the app: the shell's bridge, scripted, plus a record of what the page did (in the order it did it). */
function fakeShell({ push, token, env }) {
  const order = [];
  const sockets = [];
  window.__shell = { order, calls: [], sockets };
  const origFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.href);
    order.push(`${(init?.method ?? "GET").toUpperCase()} ${url.pathname}`);
    return origFetch(input, init);
  };
  const Native = window.WebSocket;
  window.WebSocket = class extends Native {
    constructor(...args) {
      super(...args);
      sockets.push("made");
      this.addEventListener("open", () => sockets.push("open"));
      this.addEventListener("close", (e) => sockets.push(`close:${e.code}`));
    }
  };
  const replies = {
    hello: (args) => ({ bridge: 1, shell: "0.1.0", build: "1", os: "26.0", push, events: args.events, layout: null }),
    "push.register": () => (push === "denied" ? { denied: true } : { token, env }),
    "badge.set": () => ({ ok: true }),
  };
  Object.defineProperty(window, "webkit", {
    configurable: true,
    value: {
      messageHandlers: {
        haiyo: {
          postMessage: async ({ name, args }) => {
            window.__shell.calls.push({ name, args });
            order.push(name);
            if (!replies[name]) throw new Error("unknown");
            return replies[name](args);
          },
        },
      },
    },
  });
}

const emit = (page, name, detail) => page.evaluate(([n, d]) => window.dispatchEvent(new CustomEvent(`haiyo:${n}`, { detail: d })), [name, detail]);
const shellOrder = (page) => page.evaluate(() => window.__shell.order);

test("sign in → the phone is registered at the service → sign-out unbinds it, then clears the badge, then ends the session", async ({ people }) => {
  const identity = newIdentity("Shell");
  const context = await people.newContext();
  await context.addInitScript(fakeShell, { push: "notDetermined", token: TOKEN, env: "development" });
  await registerVerified(context.request, identity);
  const page = await people.watchedPage(context, "shell");
  const seen = [];
  page.on("console", (m) => seen.push(m.text()));
  await page.goto("/signin");
  await expect(page.getByRole("heading", { name: "登录 Haiyo" })).toBeVisible();
  // On the sign-in page the person is not asked anything.
  expect((await shellOrder(page)).filter((n) => n === "push.register")).toEqual([]);

  await signInUi(page, identity);
  await expect(rail(page)).toBeVisible();
  const me = await (await context.request.get("/api/me")).json();
  await expect.poll(async () => (await pushDevicesOf(me.id)).length).toBe(1);
  const [row] = await pushDevicesOf(me.id);
  expect(row).toEqual({ token: TOKEN.toLowerCase(), env: "sandbox", app_version: "0.1.0" });
  // The question is asked once, and the hello listed what this build handles and nothing else.
  expect((await shellOrder(page)).filter((n) => n === "push.register")).toHaveLength(1);
  expect(await page.evaluate(() => window.__shell.calls.find((c) => c.name === "hello").args)).toEqual({ events: ["pause", "resume", "open"] });

  // A cold start while signed in registers again, silently: the same phone, still one row.
  await page.reload();
  await expect(rail(page)).toBeVisible();
  await expect.poll(async () => (await shellOrder(page)).filter((n) => n === "POST /api/push/devices").length).toBe(1);
  expect(await pushDevicesOf(me.id)).toHaveLength(1);

  await page.evaluate(() => window.__shell.order.splice(0));
  await signOutUi(page);
  const order = (await shellOrder(page)).filter((n) => ["DELETE /api/push/devices/current", "badge.set", "POST /api/auth/sign-out"].includes(n));
  expect(order).toEqual(["DELETE /api/push/devices/current", "badge.set", "POST /api/auth/sign-out"]);
  expect(await page.evaluate(() => window.__shell.calls.filter((c) => c.name === "badge.set").pop().args)).toEqual({ n: 0 });
  expect(await pushDevicesOf(me.id)).toHaveLength(0);

  // The token is nowhere a log, a store or an address could keep it.
  const everywhere = JSON.stringify(seen) + (await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + location.href + document.cookie));
  expect(everywhere.toLowerCase()).not.toContain(TOKEN.toLowerCase());
});

test("notifications refused in the system: nothing is asked or sent, and 设置 says so once, quietly", async ({ people }) => {
  const ann = await people.member("Ann", { open: false });
  await ann.context.addInitScript(fakeShell, { push: "denied", token: TOKEN, env: "production" });
  const page = await people.openApp(ann);
  await goTo(page, "设置");
  await expect(page.getByText(/通知已关闭/)).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect((await shellOrder(page)).filter((n) => n === "push.register" || n === "POST /api/push/devices")).toEqual([]);
  expect(await pushDevicesOf(ann.id)).toHaveLength(0);
});

test("a tapped notification opens its page; a path that is not the app's is ignored", async ({ people }) => {
  const ann = await people.member("Ann", { open: false });
  const bo = await people.member("Bo");
  await ann.context.addInitScript(fakeShell, { push: "granted", token: TOKEN, env: "production" });
  const dm = await befriend(ann, bo);
  const page = await people.openApp(ann);
  await emit(page, "open", { path: "https://evil.example/chat/x" });
  await emit(page, "open", { path: "/api/me" });
  await emit(page, "open", { path: "//evil.example" });
  await page.waitForTimeout(300);
  expect(new URL(page.url()).pathname).toBe("/");
  await emit(page, "open", { path: `/chat/${dm}` });
  await expect(page).toHaveURL(new RegExp(`/chat/${dm}$`));
  await expect(chatPane(page, bo.displayName)).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
});

test("a tapped notification of a signed-out phone: sign-in, then that page", async ({ people }) => {
  const identity = newIdentity("Cy");
  const context = await people.newContext();
  await context.addInitScript(fakeShell, { push: "granted", token: TOKEN, env: "production" });
  await registerVerified(context.request, identity);
  const page = await people.watchedPage(context, "signed-out");
  await page.goto("/signin");
  await expect(page.getByRole("heading", { name: "登录 Haiyo" })).toBeVisible();
  await emit(page, "open", { path: `/contacts` });
  await expect(page).toHaveURL(/\/signin$/);
  await signInUi(page, identity);
  await expect(rail(page)).toBeVisible();
  await expect(page).toHaveURL(/\/contacts$/);
});

test("pause lets the socket go, resume brings it back and catches up what was said meanwhile", async ({ people }) => {
  const ann = await people.member("Ann", { open: false });
  const bo = await people.member("Bo");
  await ann.context.addInitScript(fakeShell, { push: "granted", token: TOKEN, env: "production" });
  const dm = await befriend(ann, bo);
  const page = await people.openApp(ann, `/chat/${dm}`);
  const chat = chatPane(page, bo.displayName);
  await expect(chat).toBeVisible();
  const sockets = () => page.evaluate(() => window.__shell.sockets);
  await expect.poll(sockets).toContain("open");

  await emit(page, "pause");
  await expect.poll(sockets).toContain("close:1000");
  const made = (await sockets()).filter((s) => s === "made").length;
  await sendApi(bo, dm, "你不在的时候说的话");
  await page.waitForTimeout(1500);
  await expect(chat.getByText("你不在的时候说的话")).toHaveCount(0);
  expect((await sockets()).filter((s) => s === "made").length, "no new socket while paused").toBe(made);

  await emit(page, "resume");
  await expect(chat.getByText("你不在的时候说的话")).toHaveCount(1);
  expect((await sockets()).filter((s) => s === "made").length).toBe(made + 1);
});

test("in an ordinary browser the shell's events do nothing and no bridge exists", async ({ people }) => {
  const ann = await people.member("Ann");
  const page = ann.page;
  expect(await page.evaluate(() => typeof window.webkit)).toBe("undefined");
  await emit(page, "open", { path: "/contacts" });
  await emit(page, "pause");
  await page.waitForTimeout(300);
  expect(new URL(page.url()).pathname).toBe("/");
  expect(await pushDevicesOf(ann.id)).toHaveLength(0);
});
