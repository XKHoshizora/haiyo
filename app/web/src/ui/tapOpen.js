// What opens a picture: a click, unless it was made by a gesture that was not a tap on it. A click is tied to its press by identity: in current
// browsers `click` is a PointerEvent (Chrome 92+, Firefox 120+, Safari 18.2+: WebKit's "click, auxclick, contextmenu and click() use PointerEvent",
// Safari 18.2 notes) and carries the `pointerType` and `pointerId` of the pointer whose release made it; a click of the keyboard or of assistive
// technology has no pointer (`pointerType` "", or the event is a plain MouseEvent). So:
//   - a click of a pointer is judged by the press recorded for THAT pointer id — refused when that press was multi-touch (a pinch), taken from the
//     page by the browser (`pointercancel`) or began somewhere else (on the viewer that was closing under the finger); a press of another pointer,
//     or none recorded, is no reason to refuse;
//   - a click of no pointer opens, always, when it is a keyboard's (`detail` 0).
// FALLBACK, only for a browser whose click is a plain MouseEvent (Safari before 18.2): there is no id to tie it with, so it belongs to the latest
// press by order — the first click anywhere spends the record (below), the keyboard and a focus change end it (`keydown`, `focusin`), and the
// reasons to refuse are the press's being multi-touch or begun elsewhere, and only while it was not cancelled (a cancelled press makes no click: one of this kind is another's).
// A record ends at its own pointerup or pointercancel and the click that carries its id; a click that is stopped on its way (the bubble menu's
// swallowing the release of a long-press) cannot leave one behind, because every click is taken off the record in the capture phase at the window,
// before anything can stop it. The rule is the gesture's own, never a time after the viewer closed.
import { useEffect } from "react";

/** The latest press: `{startedOn, ids: every pointer id seen in it, down: those down now, multi, cancelled}`; null when there is none. */
let record = null;
let users = 0;
let off = null;
/** The press each click was judged against (taken off the record when the click was first seen, even if something stops it). */
const pressOf = new WeakMap();

const POINTERS = ["mouse", "pen", "touch"];

function listen() {
  const on = (type, fn) => {
    window.addEventListener(type, fn, true);
    return () => window.removeEventListener(type, fn, true);
  };
  // (Only when no pointer is down: a press moves the focus itself, at its own mousedown, and that must not end it.)
  const end = () => record?.down.size === 0 && (record = null);
  const stops = [
    on("pointerdown", (e) => {
      const id = e.pointerId;
      // A new press starts a new record, unless another finger is down (a second touch: the first one's press is now a pinch's). A mouse or a pen is
      // one pointer and cannot be a second: a `pointerup` that never reached the window (released outside it) leaves nothing behind.
      const another = record && e.pointerType === "touch" && [...record.down].some((other) => other !== id);
      if (another) {
        record.multi = true;
        record.ids.add(id);
        record.down.add(id);
        return;
      }
      record = { startedOn: e.target, ids: new Set([id]), down: new Set([id]), multi: false, cancelled: false };
    }),
    on("pointerup", (e) => record?.down.delete(e.pointerId)),
    on("pointercancel", (e) => {
      if (!record) return;
      record.down.delete(e.pointerId);
      record.cancelled = true;
    }),
    // The first click of the page is the end of whatever press came before it: judged here, in the capture phase, so that a click stopped later still ends it.
    on("click", (e) => {
      pressOf.set(e, record);
      record = null;
    }),
    // The keyboard, a change of focus, a scroll, and the window's own blur end what was begun (the fallback's structural ends; also no click comes of them).
    on("keydown", end),
    on("focusin", end),
    on("scroll", end),
    on("blur", (e) => e.target === window && (record = null)), // (the window's own, not a control's: the capture sees those too)
  ];
  return () => {
    for (const stop of stops) stop();
    record = null;
  };
}

/** Whether `click`, made on `button`, belongs to `press` and that press was not a tap on it. */
function refused(press, click, button) {
  if (!press) return false;
  const own = button.contains(press.startedOn);
  if (POINTERS.includes(click.pointerType)) {
    if (!press.ids.has(click.pointerId)) return false; // (another pointer's press: nothing to say about this click)
    return press.multi || press.cancelled || !own;
  }
  if (click.detail === 0) return false; // (the keyboard)
  return !press.cancelled && (press.multi || !own); // (the fallback: by order; a cancelled press makes no click, so a click of this kind is another's)
}

/**
 * `open(node)` is called with the picture's button for a click that is a tap on it (or no pointer's at all). Spread the result on the button.
 */
export function useTapToOpen(open) {
  useEffect(() => {
    if (users++ === 0) off = listen();
    return () => {
      if (--users === 0) {
        off?.();
        off = null;
      }
    };
  }, []);
  return {
    onClick(e) {
      if (!refused(pressOf.get(e.nativeEvent), e.nativeEvent, e.currentTarget)) open(e.currentTarget);
    },
  };
}
