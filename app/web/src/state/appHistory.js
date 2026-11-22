// The app's pages in the browser's history, so that Back (the button, the edge swipe) does what a person expects: on a phone
// (one column at a time) a conversation and the pages pushed over a list are history entries; on a wide screen the address
// follows the open conversation (`/chat/<id>`, replaced, not stacked: a mainstream web chat does not make Back walk through
// every conversation one looked at). A reload on a conversation's address opens it. The rules are pure functions; the hook
// is the glue between the store's navigation and `history`.
import { useEffect, useRef } from "react";

/** The one-column layout (styles.css): one page at a time, the others behind it. */
export const ONE_COLUMN_QUERY = "(max-width: 860px)";

const CHAT_PATH = /^\/chat\/([0-9a-f-]{36})(?:\/)?$/i;
/** The conversation a path names, or null. */
export const chatIdOf = (pathname) => CHAT_PATH.exec(pathname)?.[1] ?? null;

/** The keys of the navigation a history entry keeps, to show that page again on Back / Forward. */
const PAGE_KEYS = ["section", "convId", "view", "contactId", "agentId", "agentView", "agentTab", "settingsPage"];
export const snapshotOf = (nav) => Object.fromEntries(PAGE_KEYS.map((key) => [key, nav[key] ?? null]));

/**
 * Where the navigation `nav` is, as history sees it: the address and how many pages deep (0: a top-level list; 1: a page
 * pushed over it — a conversation, a contact, an Agent, a settings page; 2: one more — a group's info, an Agent's form).
 * On a wide screen everything is depth 0 (the three panes are all there); only the address follows the conversation.
 */
export function locationOf(nav, oneColumn) {
  const chat = nav.section === "chat" && nav.convId ? nav.convId : null;
  if (!oneColumn) return { path: chat ? `/chat/${chat}` : "/", depth: 0 };
  // (A conversation that is gone leaves the list, not an empty page: AppShell.jsx.)
  if (nav.pane !== "main" || (nav.section === "chat" && !chat)) return { path: "/", depth: 0 };
  const deeper = (nav.section === "chat" && nav.view === "profile") || (nav.section === "agents" && (nav.agentView === "create" || nav.agentView === "edit"));
  return { path: nav.section === "chat" && chat ? `/chat/${chat}` : "/", depth: deeper ? 2 : 1 };
}

/**
 * What to do with the history when the page goes from `prev` to `next` (both from `locationOf`; `prev` null: nothing known):
 * `{do: "none"}`, `{do: "replace"}`, `{do: "push"}` (one entry) or `{do: "back", by: n}` (n entries, `history.go(-n)`, as
 * many as the pages left; `stack` is the depths of the entries pushed above the first, oldest first).
 */
export function planStep(prev, next, stack = []) {
  if (!prev) return { do: "replace" };
  if (next.depth > prev.depth) return { do: "push" };
  if (next.depth < prev.depth) {
    let by = 0;
    for (let i = stack.length - 1; i >= 0 && stack[i] > next.depth; i -= 1) by += 1;
    return by > 0 ? { do: "back", by } : { do: "replace" };
  }
  return prev.path === next.path ? { do: "none" } : { do: "replace" };
}

const entry = (index, depth, nav) => ({ af: 1, index, depth, nav: snapshotOf(nav) });

/**
 * Keeps `history` and the navigation together. `oneColumn`: the layout shows one page at a time. `nav`, `dispatch`: the
 * store's. Run once, in the signed-in shell.
 */
export function useAppHistory({ nav, oneColumn, dispatch }) {
  const live = useRef({ nav, oneColumn });
  live.current = { nav, oneColumn };
  /** The page history shows now, and the depths of the entries pushed above the first one. */
  const applied = useRef(null);
  const stack = useRef([]);
  /** A conversation from the address is being opened: nothing is written to the history until it is shown (or given up). */
  const deepLink = useRef({ waiting: false, seen: false });

  // A reload or a link on a conversation's address opens that conversation (when it is there; `opening` waits for it and gives up);
  // one column gets the list under it, so Back goes to the list. Any other entry we left behind is a top-level page again.
  useEffect(() => {
    const id = chatIdOf(window.location.pathname);
    const phone = live.current.oneColumn;
    const wasPage = window.history.state?.af && window.history.state.depth > 0;
    if (id) {
      dispatch({ type: "nav", patch: { section: "chat", opening: { convId: id } } });
      deepLink.current = { waiting: true, seen: false };
      if (phone) {
        window.history.replaceState(entry(0, 0, live.current.nav), "", "/");
        window.history.pushState(entry(1, 1, { ...live.current.nav, section: "chat", convId: id }), "", `/chat/${id}`);
        stack.current = [1];
        applied.current = { path: `/chat/${id}`, depth: 1 };
      } else applied.current = { path: `/chat/${id}`, depth: 0 };
    } else if (wasPage) {
      window.history.replaceState(entry(0, 0, live.current.nav), "", window.location.pathname);
    }
  }, []);

  // The navigation moved: say so to the history.
  useEffect(() => {
    // (A conversation being waited for: the address is already its own.)
    if (nav.opening) {
      deepLink.current.seen = true;
      return;
    }
    if (deepLink.current.waiting && !deepLink.current.seen) return;
    deepLink.current.waiting = false;
    const next = locationOf(nav, oneColumn);
    const prev = applied.current ?? { path: window.location.pathname, depth: 0 };
    const step = planStep(prev, next, stack.current);
    applied.current = next;
    if (step.do === "none") return;
    const index = stack.current.length;
    if (step.do === "push") {
      stack.current = [...stack.current, next.depth];
      window.history.pushState(entry(stack.current.length, next.depth, nav), "", next.path);
    } else if (step.do === "back") {
      stack.current = stack.current.slice(0, stack.current.length - step.by);
      window.history.go(-step.by);
    } else {
      window.history.replaceState(entry(index, next.depth, nav), "", next.path);
    }
  }, [nav, oneColumn]);

  // Back and Forward (the browser's own): show the page of the entry reached.
  useEffect(() => {
    const onPop = () => {
      const state = window.history.state;
      const { nav: now, oneColumn: column } = live.current;
      if (state?.layer) return; // (the image viewer's own entry: ui/ImageViewer.jsx)
      if (!column) {
        const id = chatIdOf(window.location.pathname);
        if (id && id !== now.convId) dispatch({ type: "nav", patch: { section: "chat", opening: { convId: id } } });
        return;
      }
      const depth = state?.af ? state.depth : 0;
      const index = state?.af ? state.index : 0;
      stack.current = stack.current.slice(0, index);
      const same = depth > 0 && state?.nav && now.pane === "main" && JSON.stringify(snapshotOf(now)) === JSON.stringify(state.nav);
      if (same) {
        stack.current[index - 1] = depth; // (the viewer's entry was left: the page is the one shown)
        applied.current = locationOf(now, true);
      } else if (depth > 0 && state?.nav) {
        stack.current[index - 1] = depth;
        applied.current = locationOf({ ...state.nav, pane: "main" }, true);
        dispatch({ type: "nav", patch: { ...state.nav, pane: "main" } });
      } else {
        applied.current = { path: "/", depth: 0 };
        if (now.pane !== "list") dispatch({ type: "nav", patch: { pane: "list" } });
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [dispatch]);
}
