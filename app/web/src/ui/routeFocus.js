// Where the focus goes when the page changes, and what is said: one rule for every width, decided by what is on screen rather
// than by the width itself. After a change of address (state/location.js):
// - the details panel opened: the focus goes to its heading (it covers the button that opened it on all but the widest screens);
//   it closed: back to that button;
// - a page opened over the list or in place of another: if the focus was lost with what it was on (one column hides the list,
//   `display: none`; a page that went away takes its controls), it goes to the new page's heading;
// - back at the list: if the focus was lost, to the row (or control) of the list it was last on, else the list's heading;
// - otherwise (the row that opened a page is still on screen, beside it) the focus stays, and the page's name is announced.
// A heading takes the focus with tabindex="-1" (no ring for a pointer; `:focus-visible` shows it for the keyboard).
import { useEffect, useLayoutEffect, useRef } from "react";

const shown = (el) => el instanceof HTMLElement && el.isConnected && el.getClientRects().length > 0 && !el.closest("[inert]");
/** The focus is nowhere a person can see: on <body>, or on something hidden, removed or made inert. */
const lost = () => !shown(document.activeElement) || document.activeElement === document.body;

function focusOn(el) {
  if (!shown(el)) return false;
  if (!el.matches("a[href], button, input, select, textarea, [tabindex]")) el.setAttribute("tabindex", "-1");
  el.focus({ preventScroll: true });
  return document.activeElement === el;
}
/** A view's heading, else its first control, else the view itself. */
const focusView = (view) => {
  if (!view) return false;
  return focusOn(view.querySelector("h1, h2")) || focusOn(view.querySelector("button, a[href], input, textarea, select")) || focusOn(view);
};

/**
 * In the signed-in shell: `where` {key, pane, overlay} is the address drawn, `label` what the page is called, `title` the tab's
 * title. Returns the ref of the announcer (`<p aria-live="polite">`, drawn by the shell, written here only).
 */
export function useRouteFocus({ where, label, title }) {
  const announcer = useRef(null);
  const before = useRef(null);
  /** The control of the list the focus was last on (a row): where Back from a page returns it. */
  const inList = useRef(null);
  /** What opened the details panel. */
  const opener = useRef(null);

  useEffect(() => {
    document.title = title;
  }, [title]);

  useEffect(() => {
    const note = (e) => {
      if (e.target instanceof HTMLElement && e.target.closest(".list-col")) inList.current = e.target;
    };
    document.addEventListener("focusin", note);
    return () => document.removeEventListener("focusin", note);
  }, []);

  useLayoutEffect(() => {
    const was = before.current;
    before.current = where;
    if (!was || was.key === where.key) return;
    const main = document.querySelector(".main-col");
    const list = document.querySelector(".list-col");
    const side = document.querySelector(".side-col");
    let moved = false;
    if (where.overlay && !was.overlay && where.path === was.path) {
      opener.current = document.activeElement;
      moved = focusView(side);
    } else if (!where.overlay && was.overlay && where.path === was.path) {
      if (lost()) moved = focusOn(opener.current) || focusView(main);
    } else if (where.pane === "main") {
      if (lost()) moved = focusView(main);
    } else if (lost()) {
      moved = focusOn(inList.current) || focusView(list);
    }
    if (!moved && announcer.current) announcer.current.textContent = label;
  }, [where.key]);

  return announcer;
}
