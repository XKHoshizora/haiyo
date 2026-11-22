// The app's pages in the browser's history, by one rule (docs in .work/history-design.md, summarised in the lane report):
// the address is the only source of truth for where a person is; navigating pushes an entry when the address differs; closing a page
// goes back when the app's own entry below is its parent, else replaces by the parent; the popstate handler only re-renders; a cold
// start draws its address with no entry made up; layout width is not an input. The mapping is state/location.js.
// A modal layer (a dialog, a picker's sheet: ui/layers.js) is not an address: it owns one entry AT THE SAME ADDRESS, so that Back
// closes it and nothing else; the entries of the open layers are kept in step with them, and a navigation made while one is on the
// stack first leaves those entries, then writes its own push or replace from the page under them.
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useStore } from "../data/store.jsx";
import { forgetDrafts } from "../data/drafts.js";
import { entity, isMyAgent } from "./selectors.js";
import { SOFT_KEYS, addressOf, hereNow, keyOf, navOfAddress, parentOf, readEntry, sameAddress, sectionOfPath } from "./location.js";

const CHANGED = "af-history";
const read = readEntry;
const notify = () => window.dispatchEvent(new Event(CHANGED));

/**
 * An entry's state: `index` counts the app's own entries (0 for a cold start), `prev` is the key of the entry below; `layers`, the
 * modal layers open over the page (their ids, bottom to top: [] on a page's own entry).
 */
const entry = ({ index, prev, address, nav, viewer = null, layers = [] }) => ({
  af: 1,
  index,
  prev,
  path: address.path,
  overlay: address.overlay,
  viewer,
  layers,
  nav: nav ? Object.fromEntries(SOFT_KEYS.map((key) => [key, nav[key] ?? null])) : {},
});
const softOf = (nav) => entry({ index: 0, prev: null, address: { path: "", overlay: null }, nav }).nav;
const softSame = (a = {}, b = {}) => SOFT_KEYS.every((key) => (a[key] ?? null) === (b[key] ?? null));

/** The viewer's own close went back and the popstate has not come yet: it is shown closed at once. */
let viewerClosing = false;
window.addEventListener("popstate", (event) => {
  viewerClosing = false;
  // (Registered when this module loads, so before any page's or layer's own listener: they hear that this one was the layers' own.)
  if (leaving) {
    ownTraversals.add(event);
    arrive();
  }
});

// ───────── modal layers: one entry each, at the address of the page under them
/** The ids of the layers that own an entry, in the order they opened. */
const layerList = [];
/** A traversal the layers made themselves (leaving their entries) is under way: what waits for its end. */
let leaving = null;
/** The popstate events of those traversals: nobody redraws on them (the page under the layers is the page drawn). */
const ownTraversals = new WeakSet();
/** How many signed-in shells keep the history (useAppHistory): the layers write entries only while one does (the history is the app's). */
let shells = 0;
/** Long enough for any browser to finish a same-document traversal (ms); past it the layers stop waiting for its popstate. */
const LEAVE_WAIT_MS = 2000;

const layersOf = (st) => st?.layers ?? [];
/** Whether this popstate is a traversal the layers made (leaving their own entries), not the person's Back or Forward. */
export const isLayerTraversal = (event) => ownTraversals.has(event);
/** Whether the entry the browser is at has the layer `id` on it (Back has not left it). */
export const layerOnEntry = (id) => layersOf(read()).includes(id);

function arrive() {
  const done = leaving;
  leaving = null;
  if (!done) return;
  clearTimeout(done.timer);
  for (const run of done.after) run();
  settleLayers();
}
function stopLeaving() {
  if (leaving) clearTimeout(leaving.timer);
  leaving = null;
}
/** Goes back over `steps` entries of layers; `after` runs once the page under them is the entry. */
function leave(steps, after) {
  leaving = { after: after ? [after] : [], timer: setTimeout(arrive, LEAVE_WAIT_MS) };
  window.history.go(-steps);
}
/** `run` once no entry of a layer is on top: now, or after those entries have been left. */
function afterLayers(run, key = null) {
  if (leaving) {
    if (!key || !leaving.after.some((f) => f.key === key)) leaving.after.push(Object.assign(run, { key }));
    return;
  }
  const on = layersOf(read()).length;
  if (on === 0) run();
  else leave(on, Object.assign(run, { key }));
}
/** The entries of the layers follow the open layers: the entries of closed ones are left (back), open ones without an entry get one. */
function settleLayers() {
  if (leaving || shells === 0) return;
  const want = [...layerList];
  const have = layersOf(read());
  let common = 0;
  while (common < have.length && common < want.length && have[common] === want[common]) common += 1;
  if (common < have.length) {
    leave(have.length - common);
    return;
  }
  for (const id of want.slice(common)) {
    const st = read();
    const here = hereNow();
    const index = (st?.index ?? 0) + 1;
    window.history.pushState({ ...(st ?? entry({ index: 0, prev: null, address: here, nav: null })), index, prev: keyOf(here), layers: [...layersOf(st), id] }, "", window.location.pathname);
    seen.set(index, keyOf(here));
  }
}
let settling = false;
const settleSoon = () => {
  if (settling) return;
  settling = true;
  // (After the commit that opened or closed it: a navigation of the same commit has written its entry by then, and a layer that a
  // development build mounts twice is the same layer.)
  queueMicrotask(() => {
    settling = false;
    settleLayers();
  });
};

/** A layer opened (ui/layers.js): it gets an entry on top of the page's. */
export function openLayerEntry(id) {
  if (!layerList.includes(id)) layerList.push(id);
  settleSoon();
}
/** A layer closed: its entry is left. */
export function closeLayerEntry(id) {
  const at = layerList.indexOf(id);
  if (at >= 0) layerList.splice(at, 1);
  settleSoon();
}
/**
 * Back left the entry of layer `id` (its popstate). Unless it may not be left now (`held`), it is no longer open as far as the
 * history goes (its owner is closing it); one that is held gets its entry again, so that the next Back is caught too.
 */
export function layerLeftByBack(id, held) {
  if (!held) {
    const at = layerList.indexOf(id);
    if (at >= 0) layerList.splice(at, 1);
  }
  settleSoon();
}

/** The last address seen in each section (without an overlay): a click on a section goes there, as a push. */
const ROOTS = { chat: "/", contacts: "/contacts", agents: "/agents", settings: "/settings" };
const lastOf = { ...ROOTS };
const remember = (address) => {
  lastOf[sectionOfPath(address.path)] = address.path;
};
/** Whether the page the keys name still resolves in `state` (a conversation, a contact, an Agent or a provider that is gone does not). */
export function alive(state, page) {
  if (page.convId && !state.convs[page.convId]) return false;
  if (page.convId && page.view === "profile" && state.convs[page.convId].type !== "group") return false;
  if (page.contactId && !entity(state, page.contactId)) return false;
  if (page.agentId && page.agentView !== "create" && !isMyAgent(state, page.agentId)) return false;
  if (page.providerId && page.providerId !== "new" && !state.providers?.[page.providerId]) return false;
  return true;
}
/**
 * The page keys of the last address of `section`, validated now: one that no longer resolves is forgotten and the section's list is
 * the answer (a click must never push an address that is gone, nor leave an entry for one).
 */
export function lastPageOf(section, state) {
  const page = navOfAddress({ path: lastOf[section] ?? ROOTS[section], overlay: null });
  if (alive(state, page)) return page;
  lastOf[section] = ROOTS[section];
  return navOfAddress({ path: ROOTS[section], overlay: null });
}
/** Forgets where each section was (a different account signs in). */
export const forgetSections = () => Object.assign(lastOf, ROOTS);

/** What each entry of the app is as far as this page has seen: index to address key. An entry rewritten by a replace changes it, which the entries above it (forward ones) do not know in their `prev`. */
const seen = new Map();
const ownParentBelow = (st, parent) => st && st.index > 0 && st.prev === keyOf(parent) && (!seen.has(st.index - 1) || seen.get(st.index - 1) === keyOf(parent));

/** Where this entry's page goes when a page's own button closes it: back when our own parent entry is below, else replaced by the parent. */
export function goUp(dispatch, onlyAt) {
  // (A close that runs after an await — a save — acts only if the person is still on the page that asked: else they would be moved from where they are now.)
  if (typeof onlyAt === "string" && hereNow().path !== onlyAt) return;
  const parent = parentOf(hereNow());
  // (A close while layers' entries are on top — a dialog's 删除 that ends the page, or one just closed whose entry is being left —
  // draws the parent at once; the history's own step, back or replace, is taken from the page's entry once those are left.)
  if (leaving || layersOf(read()).length > 0) {
    dispatch({ type: "nav", intent: "none", patch: navOfAddress(parent) });
    afterLayers(() => {
      const st = read();
      if (ownParentBelow(st, parent)) {
        window.history.back();
        return;
      }
      window.history.replaceState(entry({ index: st?.index ?? 0, prev: st?.prev ?? null, address: parent, nav: null }), "", parent.path);
      seen.set(st?.index ?? 0, keyOf(parent));
      notify();
    });
    return;
  }
  const st = read();
  if (ownParentBelow(st, parent)) {
    window.history.back();
    // (The history is the browser's from here: the page it leads to is shown at once, and the move writes nothing.)
    dispatch({ type: "nav", intent: "none", patch: { ...navOfAddress(parent), ...(st.nav ?? {}) } });
    return;
  }
  window.history.replaceState(entry({ index: st?.index ?? 0, prev: st?.prev ?? null, address: parent, nav: null }), "", parent.path);
  seen.set(st?.index ?? 0, keyOf(parent));
  dispatch({ type: "nav", intent: "none", patch: navOfAddress(parent) });
  notify();
}

/** `(onlyAt?) => void`: a page's own back or close button; `onlyAt`, the path of the page, makes it do nothing once the person is elsewhere. */
export function useUp() {
  const { dispatch } = useStore();
  return useCallback((onlyAt) => goUp(dispatch, onlyAt), [dispatch]);
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
export function useAppHistory({ nav, dispatch, resolves = null }) {
  const live = useRef(nav);
  live.current = nav;
  const send = useRef(dispatch);
  send.current = dispatch;
  const resolvesNow = useRef(resolves);
  resolvesNow.current = resolves;
  /** The address a cold start was drawn from, until the navigation shows it (no history call is made before that). */
  const cold = useRef(null);

  useEffect(() => {
    seen.clear();
    // (Nor does it wait on a traversal the layers of another session started.)
    stopLeaving();
    shells += 1;
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
    // A layer whose dialog was open when the shell went (signing out) left no traversal behind (its closing is checked after the commit).
    return () => {
      shells -= 1;
      if (shells === 0) stopLeaving();
    };
  }, []);

  // The navigation moved: say so to the history.
  const write = (move) => {
    const next = addressOf(move);
    const st = read();
    const here = hereNow();
    if (sameAddress(here, next)) {
      if (st && !softSame(st.nav, softOf(move))) window.history.replaceState({ ...st, nav: softOf(move) }, "", window.location.pathname);
      return;
    }
    // The address was written by the move itself (a page's own close): `none` skips only this write, never the soft one above (a tab on the parent page).
    if (move.navIntent === "none") return;
    // A click into a page that is not there (a search hit or a jump to a conversation that is not mine) writes no entry: the shell shows the notice and stays.
    if (move.navIntent === "push" && resolvesNow.current && !resolvesNow.current(move)) return;
    // A move made while modal layers have entries on top (a dialog that ends in a page): those entries are left first, and the move
    // is written from the page under them, push or replace as it says — never over a layer's entry.
    if (leaving || layersOf(st).length > 0) {
      afterLayers(() => write(live.current), "nav");
      return;
    }
    const index = st?.index ?? 0;
    // The intent is on the move (state/reducer.js): a page that is gone, or a form that ended in what it made, replaces the entry it leaves.
    if (move.navIntent === "replace") {
      window.history.replaceState(entry({ index, prev: st?.prev ?? null, address: next, nav: move }), "", next.path);
    } else {
      window.history.pushState(entry({ index: index + 1, prev: keyOf(here), address: next, nav: move }), "", next.path);
    }
    seen.set(read()?.index ?? 0, keyOf(next));
    notify();
  };
  useEffect(() => {
    const next = addressOf(nav);
    remember(next);
    if (cold.current) {
      if (!sameAddress(cold.current, next)) return;
      cold.current = null;
    }
    write(nav);
  }, [nav]);

  // Back and Forward (the browser's own): draw the entry reached. Nothing else. (A traversal the layers made over their own entries
  // reaches the page that is drawn already.)
  useEffect(() => {
    const onPop = (event) => {
      if (isLayerTraversal(event)) return;
      const st = read();
      if (st) seen.set(st.index, keyOf(hereNow()));
      send.current({ type: "nav", patch: { ...navOfAddress(hereNow()), ...(st?.nav ?? {}) } });
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
}
