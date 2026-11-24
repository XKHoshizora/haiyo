// The app's pages in the browser's history, by one rule (docs in .work/history-design.md, summarised in the lane report):
// the address is the only source of truth for where a person is; navigating pushes an entry when the address differs; closing a page
// goes back when the app's own entry below is its parent, else replaces by the parent; the popstate handler only re-renders; a cold
// start draws its address with no entry made up; layout width is not an input. The mapping is state/location.js.
// A modal layer (a dialog, a picker's sheet: ui/layers.js) is not an address: it owns one entry AT THE SAME ADDRESS, marked with its
// id (`layers`), so that Back closes it and nothing else. The marked entries follow the open layers: wherever the app finds itself
// on a marked entry none of whose layers is open — a dialog just closed, Forward onto one closed before, a reload or a restored tab
// with one open — it steps back off it at once to the page's own entry, quietly and without opening anything again. A navigation
// written while one layer's entry is on top (that is, in the same commit as the dialog's close, before the close's settle) is written
// IN PLACE of that entry (a push lands where a push from the page would; a replace takes the page's index and says which entry it
// supersedes, and Back steps over that one), so the app takes no history step of its own that a person's Back could race. A replace
// of the app's first entry is not written in place (there is nothing below to step over to): the layer's entry is left first and the
// page's own entry replaced. A navigation written after the close has settled (a later render) takes the step-then-write path too.
// Nothing is added to the history outside a gesture: a dialog held open by Back returns forward onto its own entry.
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
 * modal layers open over the page (their ids, bottom to top: [] on a page's own entry); on a layer's entry, `under` is the page's own
 * {index, prev}; `supersedes`, on an entry written in place of a layer's for a replace, the key of the page entry it replaced in
 * effect; `superseded`, on that page entry once stepped over.
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

/** The entry the browser was on before the latest popstate, and the one it is on now (as this module last wrote or reached it). */
let departed = null;
let lastEntry = read();
/** Every write of this module goes through these: the entry it leaves the browser on is known. */
function pushEntry(state, path) {
  window.history.pushState(state, "", path);
  lastEntry = read();
}
function replaceEntry(state, path = window.location.pathname) {
  window.history.replaceState(state, "", path);
  lastEntry = read();
}
/** The shell's own redraw from the address (useAppHistory), for when a step of the layers never came: the address is the truth. */
let redrawFromAddress = null;

/** The viewer's own close went back and the popstate has not come yet: it is shown closed at once. */
let viewerClosing = false;
// (Registered when this module loads, so before any page's or layer's own listener: they hear whether this one was the layers' own.)
window.addEventListener("popstate", (event) => {
  viewerClosing = false;
  departed = lastEntry;
  lastEntry = read();
  const at = read()?.index;
  if (leaving) {
    // Only the popstate that reaches the entry the layers were going to is theirs; any other is the person's, and the address it
    // reached is what is drawn (what waited for the layers' step is not done: the person moved on from it).
    if (at === leaving.expected) {
      ownTraversals.add(event);
      arrive();
    } else stopLeaving();
  }
});

// ───────── modal layers: one entry each, at the address of the page under them
/** The ids of the layers that own an entry, in the order they opened. */
const layerList = [];
/** A step the layers take themselves (off their own entries) is under way: the index it goes to, and what waits for its end. */
let leaving = null;
/** The popstate events of those steps: nobody redraws on them (the page under the layers is the page drawn). */
const ownTraversals = new WeakSet();
/** How many signed-in shells keep the history (useAppHistory): the layers write entries only while one does (the history is the app's). */
let shells = 0;
/** Long enough for any browser to finish a same-document traversal (ms); the layers look again after each such wait. */
const LEAVE_WAIT_MS = 2000;
/** How many waits before the layers give their step up. */
const LEAVE_TRIES = 3;

const layersOf = (st) => st?.layers ?? [];
/** Whether this popstate is a step the layers took (off their own entries), not the person's Back or Forward. */
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
/**
 * A step of the layers' own, `steps` entries (back when negative); `after` runs once there. Its popstate is recognised by the index it
 * reaches. If none came after a wait: when the browser is there already (the popstate was lost) it counts as arrived; otherwise the
 * layers wait again, and after LEAVE_TRIES give the step up without writing anything — the page is drawn from the address the browser
 * is at, so a step that comes even later is the person's like any other.
 */
function stepOwn(steps, after) {
  const expected = (read()?.index ?? 0) + steps;
  let tries = 0;
  const wait = () =>
    setTimeout(() => {
      if (!leaving) return;
      if (read()?.index === expected) arrive();
      else if ((tries += 1) < LEAVE_TRIES) leaving.timer = wait();
      else {
        stopLeaving();
        redrawFromAddress?.();
      }
    }, LEAVE_WAIT_MS);
  leaving = { expected, after: after ? [after] : [], timer: wait() };
  window.history.go(steps);
}
/** Steps back over `steps` entries of layers, to the page's own; `after` runs once there. */
const leave = (steps, after) => stepOwn(-steps, after);
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
/**
 * The marked entries follow the open layers. The entries of layers that are not open (closed, or from before a reload) are left at
 * once, back to the page's own entry; open layers without an entry get one.
 */
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
    const base = st ?? entry({ index: 0, prev: null, address: here, nav: null });
    const under = layersOf(st).length > 0 ? st.under : { index: base.index, prev: base.prev };
    pushEntry({ ...base, index, prev: keyOf(here), layers: [...layersOf(st), id], under }, window.location.pathname);
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
let settlingLater = false;
/**
 * A settle caused by a popstate runs after that popstate's whole dispatch (a task, not a microtask): a browser runs microtasks between
 * its listeners, and the layers' listeners must all have heard the Back before the entries are put in step.
 */
const settleAfterPopstate = () => {
  if (settlingLater) return;
  settlingLater = true;
  setTimeout(() => {
    settlingLater = false;
    settleLayers();
  }, 0);
};

/** A layer opened (ui/layers.js): it gets an entry on top of the page's. */
export function openLayerEntry(id) {
  if (!layerList.includes(id)) layerList.push(id);
  settleSoon();
}
/** A layer closed: its entry is left (unless a navigation wrote over it first). */
export function closeLayerEntry(id) {
  const at = layerList.indexOf(id);
  if (at >= 0) layerList.splice(at, 1);
  settleSoon();
}
/**
 * Back left the entry of layer `id` (its popstate). Unless it may not be left now (`held`), it is no longer open as far as the
 * history goes (its owner is closing it). One that is held is taken forward onto its own entry again (still there, one ahead), so that
 * the next Back is caught too — never a new entry, which a browser may mark as one to skip, having no gesture since the page's.
 */
export function layerLeftByBack(id, held) {
  if (held && !leaving && layerList.includes(id)) {
    stepOwn(1);
    return;
  }
  const at = layerList.indexOf(id);
  if (at >= 0) layerList.splice(at, 1);
  settleAfterPopstate();
}

/**
 * The last address seen in each section (without an overlay). Where two panes show (the wide layout) a click on a section goes there,
 * as a push; where one pane shows at a time (a phone, one column) it goes to the section's list (`sectionRoot`): a page there fills
 * the screen, and a tab that answered a conversation opened from another section would leave its list out of reach.
 */
const ROOTS = { chat: "/", contacts: "/contacts", agents: "/agents", settings: "/settings" };
/** The page keys of `section`'s list (its root address). */
export const sectionRoot = (section) => navOfAddress({ path: ROOTS[section], overlay: null });
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
  return sectionRoot(section);
}
/** Forgets where each section was (a different account signs in). */
export const forgetSections = () => Object.assign(lastOf, ROOTS);

/** What each entry of the app is as far as this page has seen: index to address key. An entry rewritten by a replace changes it, which the entries above it (forward ones) do not know in their `prev`. */
const seen = new Map();
/** The indexes at which this session wrote an entry superseding another (a replace made in place of a layer's entry). */
const supersededAt = new Set();
const ownParentBelow = (st, parent) => st && st.index > 0 && st.prev === keyOf(parent) && (!seen.has(st.index - 1) || seen.get(st.index - 1) === keyOf(parent));

/**
 * In place of the one layer entry on top (`st`), the entry of `address`: for a push, where a push from the page under it would go;
 * for a replace, at the page's own index, superseding the page's entry (Back steps over it).
 */
function writeOverLayer(st, address, nav, replace) {
  const under = st.under ?? { index: Math.max(0, st.index - 1), prev: null };
  // The app's first entry (a deep link, a cold start): nothing of the app is below it to step over to, so it is not superseded but
  // replaced itself — the layer's entry is left first. The address and the screen then agree, and Back does what it does there.
  if (replace && under.index === 0) {
    leave(1, () => {
      const page = read();
      replaceEntry(entry({ index: page?.index ?? 0, prev: page?.prev ?? null, address, nav }), address.path);
      seen.set(page?.index ?? 0, keyOf(address));
      notify();
    });
    return;
  }
  if (replace) {
    replaceEntry({ ...entry({ index: under.index, prev: under.prev, address, nav }), supersedes: st.prev }, address.path);
    seen.set(under.index, keyOf(address));
    supersededAt.add(under.index);
  } else {
    replaceEntry(entry({ index: st.index, prev: st.prev, address, nav }), address.path);
    seen.set(st.index, keyOf(address));
  }
  notify();
  // (A layer still open — a dialog that stays across the move — gets its entry again, on top of the new one.)
  settleSoon();
}

/** Where this entry's page goes when a page's own button closes it: back when our own parent entry is below, else replaced by the parent. */
export function goUp(dispatch, onlyAt) {
  // (A close that runs after an await — a save — acts only if the person is still on the page that asked: else they would be moved from where they are now.)
  if (typeof onlyAt === "string" && hereNow().path !== onlyAt) return;
  const parent = parentOf(hereNow());
  const st = read();
  const on = layersOf(st).length;
  // A close while a layer's entry is on top (a dialog's 放弃 that ends the page): the parent is drawn at once; in history, back over the
  // layer's entry and the page's when the parent is the entry below the page, else the parent in place of the layer's entry.
  if (!leaving && on === 1) {
    dispatch({ type: "nav", intent: "none", patch: navOfAddress(parent) });
    const under = st.under ?? { index: Math.max(0, st.index - 1), prev: null };
    if (ownParentBelow(under, parent)) leave(2);
    else writeOverLayer(st, parent, null, true);
    return;
  }
  // (More than one, or a step of the layers' under way: the parent at once, the history's own step from the page's entry after.)
  if (leaving || on > 0) {
    dispatch({ type: "nav", intent: "none", patch: navOfAddress(parent) });
    afterLayers(() => {
      const page = read();
      if (ownParentBelow(page, parent)) {
        window.history.back();
        return;
      }
      replaceEntry(entry({ index: page?.index ?? 0, prev: page?.prev ?? null, address: parent, nav: null }), parent.path);
      seen.set(page?.index ?? 0, keyOf(parent));
      notify();
    });
    return;
  }
  if (ownParentBelow(st, parent)) {
    window.history.back();
    // (The history is the browser's from here: the page it leads to is shown at once, and the move writes nothing.)
    dispatch({ type: "nav", intent: "none", patch: { ...navOfAddress(parent), ...(st.nav ?? {}) } });
    return;
  }
  replaceEntry(entry({ index: st?.index ?? 0, prev: st?.prev ?? null, address: parent, nav: null }), parent.path);
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
  pushEntry(entry({ index: (st?.index ?? 0) + 1, prev: keyOf(here), address: here, nav: st?.nav, viewer: id }), here.path);
  notify();
}
export function stepViewerEntry(id) {
  const st = read();
  if (st) replaceEntry({ ...st, viewer: id });
  notify();
}
/** The viewer's key goes from the entry it is on, with no traversal (its picture is not there: a Forward, a reload, a picture gone). */
export function dropViewerKey() {
  const st = read();
  if (!st?.viewer) return;
  replaceEntry({ ...st, viewer: null });
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
    replaceEntry({ ...st, viewer: null });
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
    supersededAt.clear();
    // (Nor does it wait on a traversal the layers of another session started.)
    stopLeaving();
    shells += 1;
    forgetSections(); // (A shell is a session: where its sections were left, and what was typed in a form, are not carried over from another.)
    forgetDrafts();
    const st = read();
    const here = hereNow();
    const patch = navOfAddress(here);
    const canonical = addressOf({ ...live.current, ...patch });
    if (!st) replaceEntry(entry({ index: 0, prev: null, address: canonical, nav: st?.nav ?? live.current }), canonical.path);
    else if (!sameAddress(here, canonical)) replaceEntry({ ...st, path: canonical.path, overlay: canonical.overlay }, canonical.path);
    lastEntry = read();
    seen.set(read()?.index ?? 0, keyOf(canonical));
    if (!sameAddress(addressOf(live.current), canonical)) {
      cold.current = canonical;
      send.current({ type: "nav", patch: { ...patch, ...(st?.nav ?? {}) } });
    }
    // A reload or a restored tab on a layer's entry (a dialog that was open): that entry is left at once, back to the page's own.
    settleSoon();
    // (When a step of the layers' never comes, what is drawn is the address the browser is at.)
    redrawFromAddress = () => send.current({ type: "nav", patch: { ...navOfAddress(hereNow()), ...(read()?.nav ?? {}) } });
    // A layer whose dialog was open when the shell went (signing out) left no traversal behind (its closing is checked after the commit).
    return () => {
      shells -= 1;
      if (shells === 0) {
        stopLeaving();
        redrawFromAddress = null;
      }
    };
  }, []);

  // The navigation moved: say so to the history.
  const write = (move) => {
    const next = addressOf(move);
    const st = read();
    const here = hereNow();
    if (sameAddress(here, next)) {
      if (st && !softSame(st.nav, softOf(move))) replaceEntry({ ...st, nav: softOf(move) });
      return;
    }
    // The address was written by the move itself (a page's own close): `none` skips only this write, never the soft one above (a tab on the parent page).
    if (move.navIntent === "none") return;
    // A click into a page that is not there (a search hit or a jump to a conversation that is not mine) writes no entry: the shell shows the notice and stays.
    if (move.navIntent === "push" && resolvesNow.current && !resolvesNow.current(move)) return;
    const on = layersOf(st).length;
    // A move made over one layer's entry (a dialog that ends in a page) is written in its place, push or replace as it says.
    if (!leaving && on === 1) {
      writeOverLayer(st, next, move, move.navIntent === "replace");
      return;
    }
    // (Over more than one, or while the layers' own step is under way: written from the page under them once they are left.)
    if (leaving || on > 1) {
      afterLayers(() => write(live.current), "nav");
      return;
    }
    const index = st?.index ?? 0;
    // The intent is on the move (state/reducer.js): a page that is gone, or a form that ended in what it made, replaces the entry it leaves.
    if (move.navIntent === "replace") {
      replaceEntry(entry({ index, prev: st?.prev ?? null, address: next, nav: move }), next.path);
    } else {
      pushEntry(entry({ index: index + 1, prev: keyOf(here), address: next, nav: move }), next.path);
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

  // Back and Forward (the browser's own): draw the entry reached. Nothing else — but an entry the app superseded (a page replaced from
  // a dialog) is stepped over in the direction the person went, before anything of it is drawn; and an entry of layers none of which is
  // open is stepped off, back to the page's own entry (the same page: it is drawn now). A step the layers took themselves reaches the
  // page that is drawn already.
  useEffect(() => {
    const onPop = (event) => {
      if (isLayerTraversal(event)) return;
      const st = read();
      const from = departed;
      // Superseded: marked once stepped over; or left from the entry that superseded it (one step); or not what this session last wrote
      // at its index (a jump onto it, from anywhere: `seen` holds the superseding entry's address there).
      const here = keyOf(hereNow());
      const stepOver = st && (st.superseded || (from?.supersedes === here && from.index === st.index) || (seen.has(st.index) && seen.get(st.index) !== here && supersededAt.has(st.index)));
      if (stepOver) {
        if (!st.superseded) replaceEntry({ ...st, superseded: true });
        if (from && from.index < st.index) window.history.forward();
        else window.history.back();
        return;
      }
      if (st) seen.set(st.index, keyOf(hereNow()));
      send.current({ type: "nav", patch: { ...navOfAddress(hereNow()), ...(st?.nav ?? {}) } });
      // Only an entry marked with a layer that is not open is settled from here. (A browser runs microtasks between the listeners of
      // one popstate: settling on every one would give a layer that Back is closing its entry again before its own listener hears it.)
      if (layersOf(st).some((id) => !layerList.includes(id))) settleAfterPopstate();
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
}
