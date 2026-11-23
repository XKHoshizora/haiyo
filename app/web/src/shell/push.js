// Push registration in the iOS shell: what the page does so that the person's phone is told when something arrives (the shell's README,
// "What the web side still has to do", 2; the service's README, "Push devices (the iOS app)").
//
// Signed in, inside the shell: `hello` said how the system's permission stands. `granted`: `push.register` answers with the token silently.
// `notDetermined`: the same call is what shows the system's one question, so it is made once, when the person is in (the caller is the signed-in
// app, never the sign-in screen). `denied`: nothing is asked, nothing is shown. A token is sent to `POST /api/push/devices` and goes nowhere
// else: not the log, not the address, not any storage.
//
// A registration that fails (the shell's `timeout` or `busy`, a refused question, a POST that fails) is not repeated in this page load: the
// next cold start while signed in tries again. On sign-out the phone is unbound first (`DELETE /api/push/devices/current`), then the badge
// is cleared, and both happen before the session is gone.
import { hello, inShell, request } from "./bridge.js";

/** How long a sign-out waits for the service to unbind the phone (ms); the session's end removes it too, so this only keeps it quick. */
export const UNBIND_MS = 4_000;

// The shell names the APNs environment `development` or `production`; the service's words are `sandbox` and `production`.
const ENVIRONMENTS = { development: "sandbox", sandbox: "sandbox", production: "production" };
const TOKEN = /^([0-9A-Fa-f]{2}){32,100}$/;
const VERSION = /^[\x20-\x7e]{1,32}$/;

/** A session of this page: signing out starts the next one, and an answer that comes after belongs to the old one and is dropped. */
let generation = 0;
/** This session has made its one attempt. */
let attempted = false;
/** The badge was cleared for the session that is ending. */
let cleared = false;

/** Binds this phone to the signed-in session, if the system allows pushes. Never throws; never repeats in this session. */
export async function registerPush(api) {
  if (!inShell() || attempted) return;
  attempted = true;
  cleared = false;
  const mine = generation;
  try {
    const info = await hello();
    if (mine !== generation || !info) return;
    if (info.push !== "granted" && info.push !== "notDetermined") return;
    const reply = await request("push.register", {});
    if (mine !== generation) return;
    const env = ENVIRONMENTS[reply?.env];
    if (typeof reply?.token !== "string" || !TOKEN.test(reply.token) || !env) return;
    const body = { token: reply.token, env };
    if (typeof info.shell === "string" && VERSION.test(info.shell)) body.appVersion = info.shell;
    await api.registerPushDevice(body);
  } catch {
    /* tried again at the next cold start; what failed is not logged (a token is in what was sent) */
  }
}

async function clearBadge() {
  cleared = true;
  try {
    await request("badge.set", { n: 0 });
  } catch {
    /* the badge is the shell's to correct at the next unread count */
  }
}

/** Before a deliberate sign-out: unbinds the phone, then clears the badge, whatever the first answered. */
export async function unregisterPush(api) {
  if (!inShell()) return;
  generation += 1;
  attempted = false;
  let timer;
  try {
    await Promise.race([api.removePushDevice(), new Promise((resolve) => (timer = window.setTimeout(resolve, UNBIND_MS)))]);
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
  attempted = false;
  if (!cleared) await clearBadge();
}
