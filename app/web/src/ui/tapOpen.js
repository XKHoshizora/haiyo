// What opens a picture: a click, unless it belongs to a gesture that was not a tap on it. The page's pointer presses are recorded at window level
// (one record at a time); a click is refused only when THIS click belongs to a recorded press that was multi-touch (a pinch), was taken from the
// page by the browser (`pointercancel`), or began somewhere else (on the viewer that was closing under the finger). Every other click opens —
// a mouse, a finger, the keyboard and the clicks assistive technology makes (VoiceOver sends `click` with `detail` 1 and no pointer at all).
// The rule is the gesture's own, never a time after the viewer closed.
import { useEffect } from "react";

/** The latest press: `{startedOn, active: Set of pointer ids down, multi, cancelled}`; null when there is none. */
let record = null;
let users = 0;
let off = null;

function listen() {
  const on = (type, fn) => {
    window.addEventListener(type, fn, true);
    return () => window.removeEventListener(type, fn, true);
  };
  const stops = [
    on("pointerdown", (e) => {
      const id = e.pointerId;
      // A new press starts a new record, unless another finger is down (a second touch: the first one's press is now a pinch's). A mouse or a pen is
      // one pointer and cannot be a second: a `pointerup` that never reached the window (released outside it) leaves nothing behind.
      const another = record && [...record.active].some((other) => other !== id) && e.pointerType === "touch";
      if (another) {
        record.multi = true;
        record.active.add(id);
        return;
      }
      record = { startedOn: e.target, active: new Set([id]), multi: false, cancelled: false };
    }),
    on("pointerup", (e) => record?.active.delete(e.pointerId)),
    on("pointercancel", (e) => {
      if (!record) return;
      record.active.delete(e.pointerId);
      record.cancelled = true;
    }),
    // A scroll or a lost window ends what was begun: no click comes of it.
    on("scroll", () => record?.active.size === 0 && (record = null)),
    on("blur", (e) => e.target === window && (record = null)), // (the window's own, not a control's: the capture sees those too)
  ];
  // The click of a gesture is its last event (the page's own handler has had it by now): the record is spent.
  window.addEventListener("click", spend);
  return () => {
    for (const stop of stops) stop();
    window.removeEventListener("click", spend);
    record = null;
  };
}
function spend() {
  record = null;
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
      const press = record;
      const own = press && e.currentTarget.contains(press.startedOn);
      if (press && (press.multi || press.cancelled || !own)) return;
      open(e.currentTarget);
    },
  };
}
