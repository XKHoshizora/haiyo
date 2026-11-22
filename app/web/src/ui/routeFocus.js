// Where the focus goes when the page changes, and what is said: one rule for every width, decided by what is on screen rather
// than by the width itself (the shown/focus rules are ui/focusRules.js, shared with the layers). After a change of what is drawn:
// - the details panel opened: the focus goes to its heading (it covers the button that opened it on all but the widest screens);
//   it closed: back to that button;
// - a page opened over the list or in place of another: if the focus was lost with what it was on (one column hides the list,
//   `display: none`; a page that went away takes its controls; a dialog that closed with it), it goes to the new page's heading;
// - back at the list: if the focus was lost, to the row (or control) of the list it was last on, else the list's heading;
// - otherwise (the row that opened a page is still on screen, beside it) the focus stays.
// The page is said once: by its heading taking the focus, or else by the polite announcer — never both, never neither.
// And whenever something the focus was on is removed from under it (a row that went with an action, a list that re-sorted), the
// focus goes to the same element if it was only moved, else to the nearest place left of where it was — never <body>.
import { useEffect, useLayoutEffect, useRef } from "react";
import { anchorsOf, focusOn, focusView, lost, restoreFocus } from "./focusRules.js";

/**
 * In the signed-in shell: `where` {key, path, pane, overlay} is what is drawn, `label` what the page is called, `title` the tab's
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
    /** What had the focus last, and where it sat, for when it is removed from under the focus. */
    let last = null;
    let anchors = [];
    const note = (e) => {
      if (!(e.target instanceof HTMLElement)) return;
      last = e.target;
      anchors = anchorsOf(e.target);
      if (e.target.closest(".list-col")) inList.current = e.target;
    };
    const watch = new MutationObserver((records) => {
      if (!last || document.activeElement !== document.body) return;
      // Only when what had the focus was itself taken out (a press on nothing, which also leaves the focus on <body>, is the person's).
      const removed = records.some((r) => [...r.removedNodes].some((n) => n === last || n.contains?.(last)));
      if (!removed) return;
      restoreFocus({ candidates: [last], anchors });
    });
    document.addEventListener("focusin", note);
    watch.observe(document.body, { childList: true, subtree: true });
    return () => {
      document.removeEventListener("focusin", note);
      watch.disconnect();
    };
  }, []);

  useLayoutEffect(() => {
    const was = before.current;
    before.current = where;
    if (!was || was.key === where.key) return;
    const main = document.querySelector(".main-col");
    const list = document.querySelector(".list-col");
    const side = document.querySelector(".side-col");
    let view = null;
    if (where.overlay && !was.overlay && where.path === was.path) {
      opener.current = document.activeElement;
      view = side;
      focusView(side);
    } else if (!where.overlay && was.overlay && where.path === was.path) {
      if (lost() && !focusOn(opener.current)) focusView(main);
    } else if (where.pane === "main") {
      view = main;
      if (lost()) focusView(main);
    } else {
      view = list;
      if (lost() && !focusOn(inList.current)) focusView(list);
    }
    // Said once: the new view's heading has the focus (it is read), or else the announcer says the page's name.
    const active = document.activeElement;
    const onHeading = Boolean(view && active?.matches?.("h1, h2") && view.contains(active));
    const line = announcer.current;
    if (!onHeading && line) line.textContent = line.textContent === label ? `${label} ` : label;
  }, [where.key]);

  return announcer;
}
