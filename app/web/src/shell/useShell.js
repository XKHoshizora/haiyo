// What the signed-in page does with the iOS shell (bridge.js is the only code that talks to it): push, the socket's pause and resume, a
// tapped notification. Each hook does nothing in an ordinary browser.
import { useEffect, useState } from "react";
import { useStore } from "../data/store.jsx";
import { navOfAddress } from "../state/location.js";
import { hello, inShell, on, takeOpen, watchHello, watchOpen } from "./bridge.js";
import { pushOnResume, registerPush } from "./push.js";

/** A page that loads in the background of the shell opens no socket (README, "Bridge"): it connects on `resume` or when it is shown. */
export const startsInBackground = () => inShell() && document.visibilityState === "hidden";

/**
 * AuthRoot, while the person is signed in and the app runs on `layer` (`api`: api/routes.js).
 * - `haiyo:pause` / `haiyo:resume` (and the page's own visibility, since events are hints): the socket is let go and comes back through the
 *   data layer's ordinary reconnect (data/sync.js `pause` / `resume`), which also catches up what was missed.
 * - Push: once the app is on screen — never on the sign-in page, never while the app is in the background (the system's question must not
 *   appear where nobody sees it) — the phone is registered (shell/push.js).
 */
export function useShellSession({ running, layer, api }) {
  useEffect(() => {
    if (!running || !inShell()) return undefined;
    // "In the background" means paused by the shell, not what `visibilityState` says: measured in the shell, `haiyo:pause` comes first, while the
    // page still says "visible" (`visibilitychange` to hidden follows ~0.8 s later), and `haiyo:resume` comes first on the way back, while it
    // still says "hidden" (`visible` follows ~0.15 s later). So each signal acts on its own and the late one finds nothing left to do: the data
    // layer's `pause` / `resume` do nothing when already paused / running, and the permission is asked once per return.
    let foreground = !startsInBackground();
    let registered = false;
    const register = () => {
      if (registered || !foreground) return;
      registered = true;
      registerPush(api);
    };
    // Back from the background: the socket comes back through the data layer, and the permission is asked again (a change made in the system's
    // Settings is learned here; a registration that failed is tried once more).
    const back = (resumed = false) => {
      const was = foreground;
      foreground = true;
      layer.resume?.();
      if (resumed || !was) pushOnResume(api);
      register();
    };
    const away = () => {
      foreground = false;
      layer.pause?.();
    };
    const offs = [on("pause", away), on("resume", () => back(true))];
    const shown = () => (document.visibilityState === "visible" ? back() : away());
    document.addEventListener("visibilitychange", shown);
    register();
    return () => {
      for (const off of offs) off();
      document.removeEventListener("visibilitychange", shown);
    };
  }, [running, layer, api]);
}

/**
 * AuthRoot, while signed out: a tapped notification's path is kept for after the sign-in (`remember(path)`), the same as for a page of the app
 * opened signed out.
 */
export function useOpenWhileSignedOut(signedOut, remember) {
  useEffect(() => {
    if (!signedOut) return undefined;
    const take = () => {
      const path = takeOpen();
      if (path) remember(path);
    };
    take();
    return watchOpen(take);
  }, [signedOut, remember]);
}

/**
 * The signed-in app: a tapped notification or link (`haiyo:open { path }`, already checked to be a page of the app) opens that address through
 * the app's own navigation, as a new entry. One that came before the app was ready (a cold start) was kept, and is opened as soon as this runs.
 */
export function useShellOpen() {
  const { dispatch } = useStore();
  useEffect(() => {
    const open = () => {
      const path = takeOpen();
      if (path) dispatch({ type: "nav", patch: navOfAddress({ path }) });
    };
    open();
    return watchOpen(open);
  }, [dispatch]);
}

/** How the system's permission for notifications stands in the shell (`granted`, `denied`, `notDetermined`), or null: not in a shell, or not known yet. */
export function usePushPermission() {
  const [permission, setPermission] = useState(null);
  useEffect(() => {
    let alive = true;
    hello().then((info) => alive && setPermission(info?.push ?? null));
    const off = watchHello((info) => setPermission(info?.push ?? null));
    return () => {
      alive = false;
      off();
    };
  }, []);
  return permission;
}
