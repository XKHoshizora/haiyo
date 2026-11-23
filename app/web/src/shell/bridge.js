// The page's one client of the iOS shell's bridge (the native app that loads this site in a WKWebView; its README, "Bridge"). Nothing else in the
// web touches `window.webkit`. In an ordinary browser there is no such handler: every function here is then a no-op that answers null or
// rejects with "unavailable", nothing is listened to and nothing is left on `window`.
//
// The page calls `window.webkit.messageHandlers.haiyo.postMessage({ name, args })`, which returns a promise: the reply is correlated by
// WebKit itself (no ids of ours); a refusal rejects with `forbidden`, `malformed` or `unknown`. What this module adds is a time limit (the
// shell has its own for `push.register`: 30 s), a plain error with a short code, and events.
//
// Events the shell sends (`haiyo:pause`, `haiyo:resume`, `haiyo:open`) are hints: fire-and-forget, never guaranteed. `hello` lists the ones
// this build handles (HANDLED_EVENTS) — `layout` is not among them — and the shell falls back to loading the URL itself for `open` otherwise.
import { navOfAddress } from "../state/location.js";

/** The events of the shell this page handles, as `hello` lists them (README: `["pause", "resume", "open", "layout"]`). */
export const HANDLED_EVENTS = Object.freeze(["pause", "resume", "open"]);

/**
 * How long a request waits for its answer (ms); null: as long as the page lives. `push.register` has no limit of ours: the shell does not time
 * the system's question (its own 30 s start once permission is granted), and a limit here would lose a late "Allow".
 */
export const TIMEOUT_MS = Object.freeze({ default: 8_000, hello: 8_000, "push.register": null });

/** A request that did not succeed: `code` is `unavailable` (no shell), `timeout`, or the shell's own word (`forbidden`, `malformed`, `unknown`) or `failed`. */
export class ShellError extends Error {
  constructor(code) {
    super(code);
    this.name = "ShellError";
    this.code = code;
  }
}

function handler() {
  try {
    const h = window.webkit?.messageHandlers?.haiyo;
    return h && typeof h.postMessage === "function" ? h : null;
  } catch {
    return null;
  }
}

/** Whether this page is inside the iOS shell (its handler is there). False in every browser. */
export const inShell = () => handler() !== null;

/** Asks the shell: resolves with its reply. `timeoutMs` replaces the limit of the name. Never logs what it was asked or answered (a token is among them). */
export function request(name, args = {}, { timeoutMs } = {}) {
  const h = handler();
  if (!h) return Promise.reject(new ShellError("unavailable"));
  return new Promise((resolve, reject) => {
    const limit = timeoutMs ?? (name in TIMEOUT_MS ? TIMEOUT_MS[name] : TIMEOUT_MS.default);
    const timer = limit === null ? null : window.setTimeout(() => reject(new ShellError("timeout")), limit);
    const done = (fn, value) => {
      if (timer !== null) window.clearTimeout(timer);
      fn(value);
    };
    let sent;
    try {
      sent = h.postMessage({ name, args });
    } catch {
      done(reject, new ShellError("failed"));
      return;
    }
    Promise.resolve(sent).then(
      (reply) => done(resolve, reply),
      (reason) => {
        const word = typeof reason === "string" ? reason : reason?.message;
        done(reject, new ShellError(typeof word === "string" && /^[a-z_]{1,24}$/.test(word) ? word : "failed"));
      },
    );
  });
}

let helloReply = null;
const helloWatchers = new Set();

const askHello = () =>
  request("hello", { events: [...HANDLED_EVENTS] }).then(
    // (A later bridge version only adds to the first.)
    (reply) => (reply && typeof reply === "object" && Number.isInteger(reply.bridge) && reply.bridge >= 1 && typeof reply.push === "string" ? reply : null),
    () => null,
  );

/**
 * What the shell is (`{ bridge, shell, build, os, push, events, layout }`), or null: not in a shell, or it did not answer. Asked once per
 * page load (and again after a page restored from the back/forward cache, or by `refreshHello`): the same promise for every caller.
 */
export function hello() {
  if (!inShell()) return Promise.resolve(null);
  helloReply ??= askHello();
  return helloReply;
}

/**
 * Asks again (the shell answers each `hello` with the current permission): on a resume, so that a permission changed in the system's Settings is
 * learned at once. An answer replaces what was known and is told to `watchHello`; one that fails changes nothing and gives null.
 */
export async function refreshHello() {
  if (!inShell()) return null;
  const reply = await askHello();
  if (!reply) return null;
  helloReply = Promise.resolve(reply);
  for (const fn of [...helloWatchers]) call(fn, reply);
  return reply;
}

/** Calls `fn(reply)` whenever a fresh `hello` has answered; returns the function that stops it. */
export function watchHello(fn) {
  helloWatchers.add(fn);
  return () => helloWatchers.delete(fn);
}

// ───────── events
const subscribers = Object.fromEntries(HANDLED_EVENTS.map((name) => [name, new Set()]));

/** Calls `fn(detail)` for each `haiyo:<event>` of the shell; returns the function that stops it. An unknown event is a mistake of the code. */
export function on(event, fn) {
  if (!HANDLED_EVENTS.includes(event)) throw new Error(`the shell event "${event}" is not handled by this page (bridge.js HANDLED_EVENTS)`);
  subscribers[event].add(fn);
  return () => subscribers[event].delete(fn);
}

// ───────── a tapped notification or link: the address to open
// The path comes from a notification or a link, so it is only ever one of the app's own pages (state/location.js knows them), a plain path
// without query or fragment, never an address of another site.
const PLACEHOLDER_ORIGIN = "https://app.invalid";

/** A plain path of this site as the shell writes it: `/…`, not `//host`, no backslash, no control character, no encoded slash. */
const plain = (raw) =>
  typeof raw === "string" && raw.length > 0 && raw.length <= 2048 && raw.startsWith("/") && !raw.startsWith("//") && !/[\\\u0000-\u001f\u007f]|%2f|%5c/i.test(raw);

/** The path of a page of the app (`/chat/<id>`, `/contacts`, ...) that `raw` names, or null when it is anything else. Query and fragment are dropped. */
export function appPathOf(raw) {
  if (!plain(raw) || raw.length > 512) return null;
  let url;
  try {
    url = new URL(raw, PLACEHOLDER_ORIGIN);
  } catch {
    return null;
  }
  if (url.origin !== PLACEHOLDER_ORIGIN) return null;
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (path === "/") return path;
  // (An address the app does not know is read as its first list: only a real page is `pane: main` or in another section.)
  const page = navOfAddress({ path });
  return page.section !== "chat" || page.pane !== "list" ? path : null;
}

/**
 * Any other page of this site the shell sends (the terms and privacy pages, the sign-in, register and reset screens, a reset or verification link
 * with its query): the path and query to load as they are, or null for anything off this origin, the service's own `/api` paths, or a malformed
 * address. The query may hold a token: it is never logged.
 */
export function pageHrefOf(raw) {
  if (!plain(raw)) return null;
  let url;
  try {
    url = new URL(raw, window.location.origin);
  } catch {
    return null;
  }
  if (url.origin !== window.location.origin || /^\/api(\/|$)/i.test(url.pathname)) return null;
  return url.pathname + url.search;
}

/** How the page is loaded from this module (a seam for tests; `location.assign` is the only way). */
export const loader = { assign: (href) => window.location.assign(href) };

let pendingOpen = null;
const openWatchers = new Set();

/** The path of the latest `haiyo:open` nobody has taken yet (a cold start can hear it before the app has loaded), or null. */
export const peekOpen = () => pendingOpen;
/** Takes it: returns the path once and forgets it. */
export function takeOpen() {
  const path = pendingOpen;
  pendingOpen = null;
  return path;
}
/** Calls `fn()` whenever a path is waiting; returns the function that stops it. */
export function watchOpen(fn) {
  openWatchers.add(fn);
  return () => openWatchers.delete(fn);
}

function heard(event, detail) {
  if (event === "open") {
    // The page listed `open`, so the shell does not load the URL itself: an address of the app goes to its navigation (queued until the app is
    // there), any other page of this site is loaded as it is, and anything else is dropped.
    const path = appPathOf(detail?.path);
    if (path === null) {
      const href = pageHrefOf(detail?.path);
      if (href !== null) loader.assign(href);
      return;
    }
    pendingOpen = path;
    for (const fn of [...openWatchers]) call(fn);
    for (const fn of [...subscribers.open]) call(fn, { path });
    return;
  }
  for (const fn of [...subscribers[event]]) call(fn, detail);
}
const call = (fn, detail) => {
  try {
    fn(detail);
  } catch {
    /* a subscriber must not stop the others */
  }
};

const listeners = HANDLED_EVENTS.map((event) => [`haiyo:${event}`, (e) => heard(event, e.detail)]);
const onPageShow = (e) => {
  // A page restored from the back/forward cache sends `hello` again (README).
  if (!e.persisted) return;
  refreshHello();
};
let started = false;

/**
 * Called once as the page starts, before anything renders: in the shell it listens to the events and sends `hello`. Resolves with `hello`'s reply,
 * or null in a browser (where it does nothing at all).
 */
export function startShell() {
  if (!inShell()) return Promise.resolve(null);
  if (!started) {
    started = true;
    for (const [type, fn] of listeners) window.addEventListener(type, fn);
    window.addEventListener("pageshow", onPageShow);
  }
  return hello();
}

/** Stops listening (tests, and nothing else). */
export function stopShell() {
  if (!started) return;
  started = false;
  for (const [type, fn] of listeners) window.removeEventListener(type, fn);
  window.removeEventListener("pageshow", onPageShow);
  helloReply = null;
  pendingOpen = null;
  openWatchers.clear();
  helloWatchers.clear();
  for (const set of Object.values(subscribers)) set.clear();
}
