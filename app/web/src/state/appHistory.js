// The app's pages in the browser's history, by one rule (docs in .work/history-design.md, summarised in the lane report):
// the address is the only source of truth for where a person is; navigating pushes an entry when the address differs; closing a page
// goes back when the app's own entry below is its parent, else replaces by the parent; the popstate handler only re-renders; a cold
// start draws its address with no entry made up; layout width is not an input. The mapping is state/location.js.
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useStore } from "../data/store.jsx";
import { forgetDrafts } from "../data/drafts.js";
import { SOFT_KEYS, addressOf, keyOf, navOfAddress, parentOf, sameAddress, sectionOfPath } from "./location.js";

const CHANGED = "af-history";
const read = () => (window.history.state?.af ? window.history.state : null);
const notify = () => window.dispatchEvent(new Event(CHANGED));
/** The address the browser is at: the path and the overlay of our entry. */
export const hereNow = () => ({ path: window.location.pathname, overlay: read()?.overlay ?? null });

/** An entry's state: `index` counts the app's own entries (0 for a cold start), `prev` is the key of the entry below. */
const entry = ({ index, prev, address, nav, viewer = null }) => ({
  af: 1,
  index,
  prev,
  path: address.path,
  overlay: address.overlay,
  viewer,
  nav: nav ? Object.fromEntries(SOFT_KEYS.map((key) => [key, nav[key] ?? null])) : {},
});
const softOf = (nav) => entry({ index: 0, prev: null, address: { path: "", overlay: null }, nav }).nav;
const softSame = (a = {}, b = {}) => SOFT_KEYS.every((key) => (a[key] ?? null) === (b[key] ?? null));

/** A `history.back()` this module asked for is on its way (the browser answers with a popstate a moment later): the page it leads to is shown at once, and nothing is written to the history for it. */
let expecting = null;
let viewerClosing = false;
window.addEventListener("popstate", () => {
  expecting = null;
  viewerClosing = false;
});

/** The last address seen in each section (without an overlay): a click on a section goes there, as a push. */
const ROOTS = { chat: "/", contacts: "/contacts", agents: "/agents", settings: "/settings" };
const lastOf = { ...ROOTS };
const remember = (address) => {
  lastOf[sectionOfPath(address.path)] = address.path;
};
/** The page keys of the last address of `section` (its list when it has not been left on a page). */
export const lastPageOf = (section) => navOfAddress({ path: lastOf[section] ?? ROOTS[section], overlay: null });
/** Forgets where each section was (a different account signs in). */
export const forgetSections = () => Object.assign(lastOf, ROOTS);

/** What each entry of the app is as far as this page has seen: index to address key. An entry rewritten by a replace changes it, which the entries above it (forward ones) do not know in their `prev`. */
const seen = new Map();
const ownParentBelow = (st, parent) => st && st.index > 0 && st.prev === keyOf(parent) && (!seen.has(st.index - 1) || seen.get(st.index - 1) === keyOf(parent));

let replaceNext = false;
/** The next move of the navigation replaces the entry it leaves (a form that ends in what it made, a page that is gone). */
export const markReplace = () => {
  replaceNext = true;
};

/** Where this entry's page goes when a page's own button closes it: back when our own parent entry is below, else replaced by the parent. */
export function goUp(dispatch) {
  const st = read();
  const parent = parentOf(hereNow());
  if (ownParentBelow(st, parent)) {
    expecting = parent;
    window.history.back();
    dispatch({ type: "nav", patch: { ...navOfAddress(parent), ...(st.nav ?? {}) } });
    return;
  }
  window.history.replaceState(entry({ index: st?.index ?? 0, prev: st?.prev ?? null, address: parent, nav: null }), "", parent.path);
  seen.set(st?.index ?? 0, keyOf(parent));
  dispatch({ type: "nav", patch: navOfAddress(parent) });
  notify();
}

/** `() => void`: a page's own back or close button. */
export function useUp() {
  const { dispatch } = useStore();
  return useCallback(() => goUp(dispatch), [dispatch]);
}

// ───────── the image viewer: a key on the conversation's entry, and one entry pushed with it
const subscribe = (fn) => {
  window.addEventListener("popstate", fn);
  window.addEventListener(CHANGED, fn);
  return () => {
    window.removeEventListener("popstate", fn);
    window.removeEventListener(CHANGED, fn);
  };
};
/** The message id of the picture the viewer shows (from the entry), or null. */
export const useViewerId = () => useSyncExternalStore(subscribe, () => (viewerClosing ? null : read()?.viewer ?? null), () => null);

export function openViewerEntry(id) {
  viewerClosing = false;
  const st = read();
  const here = hereNow();
  window.history.pushState(entry({ index: (st?.index ?? 0) + 1, prev: keyOf(here), address: here, nav: st?.nav, viewer: id }), "", here.path);
  notify();
}
export function stepViewerEntry(id) {
  const st = read();
  if (st) window.history.replaceState({ ...st, viewer: id }, "", window.location.pathname);
  notify();
}
/** The viewer's key goes from the entry it is on, with no traversal (its picture is not there: a Forward, a reload, a picture gone). */
export function dropViewerKey() {
  const st = read();
  if (!st?.viewer) return;
  window.history.replaceState({ ...st, viewer: null }, "", window.location.pathname);
  notify();
}

export function closeViewerEntry() {
  const st = read();
  if (!st?.viewer) return;
  if (st.index > 0 && st.prev === keyOf(hereNow())) {
    viewerClosing = true;
    window.history.back();
    notify();
  } else {
    window.history.replaceState({ ...st, viewer: null }, "", window.location.pathname);
    notify();
  }
}

/**
 * Keeps the address and the store's navigation together; run once in the signed-in shell. The store's navigation is moved by pages
 * and by this hook (from the address); every move of it is followed by the history operation the rule says.
 */
export function useAppHistory({ nav, dispatch }) {
  const live = useRef(nav);
  live.current = nav;
  const send = useRef(dispatch);
  send.current = dispatch;
  /** The address a cold start was drawn from, until the navigation shows it (no history call is made before that). */
  const cold = useRef(null);

  useEffect(() => {
    seen.clear();
    forgetSections(); // (A shell is a session: where its sections were left, and what was typed in a form, are not carried over from another.)
    forgetDrafts();
    const st = read();
    const here = hereNow();
    const patch = navOfAddress(here);
    const canonical = addressOf({ ...live.current, ...patch });
    if (!st) window.history.replaceState(entry({ index: 0, prev: null, address: canonical, nav: st?.nav ?? live.current }), "", canonical.path);
    else if (!sameAddress(here, canonical)) window.history.replaceState({ ...st, path: canonical.path, overlay: canonical.overlay }, "", canonical.path);
    seen.set(read()?.index ?? 0, keyOf(canonical));
    if (!sameAddress(addressOf(live.current), canonical)) {
      cold.current = canonical;
      send.current({ type: "nav", patch: { ...patch, ...(st?.nav ?? {}) } });
    }
  }, []);

  // The navigation moved: say so to the history.
  useEffect(() => {
    const next = addressOf(nav);
    remember(next);
    // (The back asked for is in flight: the page it leads to is already shown, and writing it is the browser's.)
    if (expecting) {
      const mine = sameAddress(expecting, next);
      expecting = null;
      if (mine) return;
    }
    if (cold.current) {
      if (!sameAddress(cold.current, next)) return;
      cold.current = null;
    }
    const st = read();
    const here = hereNow();
    if (sameAddress(here, next)) {
      if (st && !softSame(st.nav, softOf(nav))) window.history.replaceState({ ...st, nav: softOf(nav) }, "", window.location.pathname);
      replaceNext = false;
      return;
    }
    const index = st?.index ?? 0;
    if (replaceNext) {
      replaceNext = false;
      window.history.replaceState(entry({ index, prev: st?.prev ?? null, address: next, nav }), "", next.path);
    } else {
      window.history.pushState(entry({ index: index + 1, prev: keyOf(here), address: next, nav }), "", next.path);
    }
    seen.set(read()?.index ?? 0, keyOf(next));
    notify();
  }, [nav]);

  // Back and Forward (the browser's own): draw the entry reached. Nothing else.
  useEffect(() => {
    const onPop = () => {
      const st = read();
      if (st) seen.set(st.index, keyOf(hereNow()));
      send.current({ type: "nav", patch: { ...navOfAddress(hereNow()), ...(st?.nav ?? {}) } });
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
}
