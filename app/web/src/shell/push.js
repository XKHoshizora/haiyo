// Push registration in the iOS shell: what the page does so that the person's phone is told when something arrives (the shell's README,
// "What the web side still has to do", 2; the service's README, "Push devices (the iOS app)").
//
// Signed in, inside the shell: `hello` said how the system's permission stands. `granted`: `push.register` answers with the token silently.
// `notDetermined`: the same call is what shows the system's one question, so it is made once, when the person is in (the caller is the signed-in
// app, never the sign-in screen). `denied`: nothing is asked, nothing is shown. A token is sent to `POST /api/push/devices` and goes nowhere
// else: not the log, not the address, not any storage.
//
// A registration that fails (the shell's `timeout` or `busy`, a refused question, a POST that fails) is never retried in a loop. It is tried again
// when the app comes back (`pushOnResume`: once per resume, and only while the permission is `granted`; a fresh `hello` also tells a permission
// changed in the system's Settings) and at the next cold start. One `push.register` is in flight at a time. On sign-out the phone is unbound first
// (`DELETE /api/push/devices/current`), then the badge is cleared, and both happen before the session is gone, within a few seconds in all.
import { hello, inShell, refreshHello, request } from "./bridge.js";

/** Of the few seconds a sign-out may wait in all: for the service to unbind the phone (ms); the request is aborted after it. */
export const UNBIND_MS = 3_000;
/** ... and for the shell to clear the badge (ms). */
export const BADGE_MS = 1_000;

// The shell names the APNs environment `development` (Debug builds only) or `production`; the service's words are `sandbox` and `production`.
// Both forms are accepted; any other word registers nothing (and is counted, never guessed).
const ENVIRONMENTS = { development: "sandbox", sandbox: "sandbox", production: "production" };
const TOKEN = /^([0-9A-Fa-f]{2}){32,100}$/;
const VERSION = /^[\x20-\x7e]{1,32}$/;

/** What went unusual, as numbers only (the page has no other sink, and a token must never reach one). */
export const counters = { unknownEnv: 0 };

/** A session of this page: signing out starts the next one, and an answer that comes after belongs to the old one and is dropped. */
let generation = 0;
/** The signed-in app has begun registering this session (the one first attempt is made). */
let active = false;
/** This session's phone is bound at the service. */
let registered = false;
/** The `push.register` that is waiting for its answer: `{ id, generation, push, at }`, or null. It is abandoned (and a new one may start) when its session ended, when a hello reports another permission, or after `ABANDON_MS`. */
let inflight = null;
let attempts = 0;
/** The question (or the silent registration) was begun once in this page load, whatever came of it. */
let asked = false;
/** A fresh `hello` of a resume is on its way. */
let refreshing = false;
/** The badge was cleared for the session that is ending. */
let cleared = false;

/** How long a `push.register` may stay unanswered before the next resume may start another (the system's question can stay open that long). */
export const ABANDON_MS = 10 * 60_000;

const holding = (info) => inflight && inflight.generation === generation && inflight.push === info.push && Date.now() - inflight.at < ABANDON_MS;

/** One `push.register` and the POST that follows. Never throws; never two at once (unless the earlier is abandoned, see `inflight`). */
async function attempt(api, info) {
  if (registered || holding(info)) return;
  const claim = { id: (attempts += 1), generation, push: info.push, at: Date.now() };
  inflight = claim;
  asked = true;
  const mine = generation;
  try {
    const reply = await request("push.register", {});
    if (mine !== generation || inflight !== claim) return;
    const env = ENVIRONMENTS[reply?.env];
    if (typeof reply?.token === "string" && TOKEN.test(reply.token) && !env) counters.unknownEnv += 1;
    if (typeof reply?.token !== "string" || !TOKEN.test(reply.token) || !env) return;
    const body = { token: reply.token, env };
    if (typeof info.shell === "string" && VERSION.test(info.shell)) body.appVersion = info.shell;
    await api.registerPushDevice(body);
    if (mine === generation && inflight === claim) registered = true;
  } catch {
    /* tried again at the next resume or cold start; what failed is not logged (a token is in what was sent) */
  } finally {
    if (inflight === claim) inflight = null;
  }
}

/** Binds this phone to the signed-in session, if the system allows pushes. Never throws; one first attempt per session. */
export async function registerPush(api) {
  if (!inShell() || active) return;
  active = true;
  cleared = false;
  const mine = generation;
  try {
    const info = await hello();
    if (mine !== generation || !info) return;
    if (info.push !== "granted" && info.push !== "notDetermined") return;
    await attempt(api, info);
  } catch {
    /* see above */
  }
}

/**
 * The app came back: asks the shell for the permission as it is now. Newly `granted`, or `granted` with the phone not bound yet (a failed
 * attempt): registers silently, once per resume. `denied` (newly): nothing, and whoever watches `hello` (the 设置 line) is told.
 */
export async function pushOnResume(api) {
  if (!inShell() || !active || refreshing) return;
  refreshing = true;
  const mine = generation;
  try {
    let info;
    try {
      info = await refreshHello();
    } finally {
      // (Only the hello is waited for here: a `push.register` that never answers must not hold the next resume's hello.)
      refreshing = false;
    }
    if (mine !== generation || !info) return;
    // (A hello that failed at the start leaves the question unasked: the first answer after it asks it, once.)
    if (info.push === "granted" || (info.push === "notDetermined" && !asked)) await attempt(api, info);
  } catch {
    /* see above */
  }
}

async function clearBadge() {
  cleared = true;
  try {
    await request("badge.set", { n: 0 }, { timeoutMs: BADGE_MS });
  } catch {
    /* the badge is the shell's to correct at the next unread count */
  }
}

/** Before a deliberate sign-out: unbinds the phone, then clears the badge, whatever the first answered; never waits more than a few seconds in all. */
export async function unregisterPush(api) {
  if (!inShell()) return;
  generation += 1;
  active = false;
  registered = false;
  inflight = null;
  asked = false;
  const control = new AbortController();
  let timer;
  try {
    await Promise.race([
      api.removePushDevice({ signal: control.signal }),
      new Promise((resolve) => {
        timer = window.setTimeout(() => {
          // (A DELETE that is still on its way must not land later and unbind a phone that is bound again by then.)
          control.abort();
          resolve();
        }, UNBIND_MS);
      }),
    ]);
  } catch {
    /* the session's end removes the phone anyway */
  } finally {
    window.clearTimeout(timer);
  }
  await clearBadge();
}

/** The session ended by itself (it expired, another tab signed out): the service has unbound the phone; the badge goes unless it already has. */
export async function pushSessionEnded() {
  if (!inShell()) return;
  generation += 1;
  active = false;
  registered = false;
  inflight = null;
  asked = false;
  if (!cleared) await clearBadge();
}
