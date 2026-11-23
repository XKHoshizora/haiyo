// A small path router on the History API. Everything that is not an account screen is the app.
import { useSyncExternalStore } from "react";

/** Failure codes Better Auth puts in `?error=` when the verification link redirects back. */
export const VERIFY_ERRORS = ["INVALID_TOKEN", "TOKEN_EXPIRED", "USER_NOT_FOUND", "INVALID_USER"];

const SCREENS = { "/signin": "signin", "/register": "register", "/verify": "verify", "/forgot": "forgot", "/reset-password": "reset" };
/** The public pages (src/legal/): open to anyone, signed in or not, whatever the session is doing. */
const LEGAL = { "/terms": "terms", "/privacy": "privacy", "/contact": "contact" };
const RESET_PATH = "/reset-password";

const cleanPath = (pathname) => pathname.replace(/\/+$/, "") || "/";

/**
 * @returns {{name: "signin"|"register"|"verify"|"forgot"|"reset"|"legal"|"app", error?: string|null, doc?: "terms"|"privacy"|"contact"}}
 * The service's verification link redirects to `<origin>/` on success and `<origin>/?error=CODE` on failure
 * (the callbackURL given when the mail was made), so `/` with a known code is the failure landing; the sign-in
 * resend asks for `/verify` itself.
 */
export function parseRoute({ pathname, search = "" }) {
  const path = cleanPath(pathname);
  const error = new URLSearchParams(search).get("error");
  if (path === "/" && VERIFY_ERRORS.includes(error)) return { name: "verify", error };
  if (LEGAL[path]) return { name: "legal", doc: LEGAL[path] };
  const name = SCREENS[path];
  if (name === "verify") return { name, error };
  return { name: name ?? "app" };
}

/**
 * What to show for a route given the session: `{view}` or `{redirect}` (replace the address with that path).
 * `status` is "loading" | "in" | "terms" | "out"; while loading nothing is decided, so neither screen flashes (but a public page
 * is shown at once). "terms": signed in, with the terms or the privacy policy of a version not yet accepted — every page of
 * the app is the question (`accept`) until it is answered.
 */
export function decide(route, status) {
  if (route.name === "legal") return { view: "legal" };
  if (status === "loading") return { view: "loading" };
  const signedIn = status === "in" || status === "terms";
  if (status === "terms" && route.name === "app") return { view: "accept" };
  switch (route.name) {
    case "signin":
    case "register":
    case "forgot":
      return signedIn ? { redirect: "/" } : { view: route.name };
    case "verify":
      // Without an error a signed-in visitor has nothing to read here.
      return signedIn && !route.error ? { redirect: "/" } : { view: "verify" };
    case "reset":
      return { view: "reset" };
    default:
      return signedIn ? { view: "app" } : { redirect: "/signin" };
  }
}

// ───────── the address bar as a store
const listeners = new Set();
let cached = null;

function readLocation() {
  const { pathname, search } = globalThis.location;
  if (!cached || cached.pathname !== pathname || cached.search !== search) cached = { pathname, search };
  return cached;
}

function subscribe(fn) {
  listeners.add(fn);
  if (listeners.size === 1) globalThis.addEventListener("popstate", notify);
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0) globalThis.removeEventListener("popstate", notify);
  };
}

function notify() {
  for (const fn of [...listeners]) fn();
}

export const useLocation = () => useSyncExternalStore(subscribe, readLocation, readLocation);

/** Goes to a path of this site. `replace` swaps the current history entry instead of adding one. */
export function navigate(path, { replace = false } = {}) {
  globalThis.history[replace ? "replaceState" : "pushState"](null, "", path);
  notify();
}

// ───────── where a signed-out visit was going
let returnTo = null;
/** A signed-out visit to a page of the app: its path is kept (in memory only) for after the sign-in. */
export const rememberReturn = (path) => {
  returnTo = path && path !== "/" ? path : null;
};
/** The path remembered by `rememberReturn`, once. */
export function takeReturn() {
  const path = returnTo;
  returnTo = null;
  return path;
}

// ───────── the reset token
let captured = null;

/**
 * On `/reset-password`: takes `?token=` from the address, removes the query from the address bar at once
 * (before any request), and keeps the token here for the screen to take. Calling it again after the address
 * was cleaned returns the same token (React may render twice). Returns null when there is none.
 */
export function captureResetToken() {
  const { pathname, search } = globalThis.location;
  if (cleanPath(pathname) === RESET_PATH && search) {
    const token = new URLSearchParams(search).get("token");
    if (token) captured = token;
    globalThis.history.replaceState(globalThis.history.state, "", pathname);
  }
  return captured;
}

export const takeResetToken = () => captured;
export const clearResetToken = () => {
  captured = null;
};
