import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { isEscape } from "./keys.js";
import { useLayer } from "./layers.js";

// How a button's list opens, for the model picker (src/pages/ModelSelect.jsx) and the plain Select (src/ui/Select.jsx):
// the same place, the same ways to close it, the same look (styles.css: .model-pop, .select-pop).

/** Room kept between the popover and the window's edges, and between it and its button (px); its greatest height. */
const EDGE = 12;
const GAP = 6;
const TALLEST = 420;
/** Below this much room under its button (about six rows) the list may open above it instead (px). */
const ENOUGH_BELOW = 240;

/** The nearest box around `node` that scrolls up and down and has more than it shows (a page's body), or null. */
function scrollerOf(node) {
  for (let el = node.parentElement; el && el !== document.body; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el);
    if ((overflowY === "auto" || overflowY === "scroll") && el.scrollHeight > el.clientHeight) return el;
  }
  return null;
}
/** The list is a sheet at the bottom of the screen (styles.css, under 480 px). */
const onPhone = () => typeof window.matchMedia === "function" && window.matchMedia("(max-width: 480px)").matches;

/**
 * A button's popover (rendered by its caller, in a portal, with `popRef` and `popStyle`). Opened, it is placed under its
 * button — the page first scrolled, as far as it can with the button still in sight, so that the list has room there — and
 * above it only when there is still not enough room below and more above; laid out before it is painted, and again when
 * the window scrolls or changes size (a phone's sheet needs none of it). A press anywhere else closes it (the focus goes
 * where the press put it); Esc closes it wherever the focus is, and gives the focus back to the button; it closes when the
 * button turns off.
 * `widthOf(buttonBox)`: its width; `focus()`: where the focus goes when it opens (none given: it stays on the button);
 * `disabled` / `busy`: it does not open. → `{open, show() (whether it opened), close(focusButton), triggerRef, popRef,
 * popStyle, up}`.
 */
export function usePopover({ disabled = false, busy = false, widthOf, focus, onOpen }) {
  const [open, setOpen] = useState(false);
  // On a phone the list is a sheet over a dimmed page: a modal layer (ui/layers.js) — the page inert, the focus in the sheet (`focus`
  // gets `true`), Back closes the sheet only, and the focus comes back to the button.
  const [sheet, setSheet] = useState(false);
  const [place, setPlace] = useState(null);
  const triggerRef = useRef(null);
  const popRef = useRef(null);
  const latest = useRef(null);
  latest.current = { widthOf, focus };

  const show = () => {
    if (disabled || busy || open) return false;
    setSheet(onPhone());
    setOpen(true);
    onOpen?.();
    return true;
  };
  const close = (focusButton) => {
    setOpen(false);
    if (focusButton) triggerRef.current?.focus();
  };
  useLayer(popRef, { active: open && sheet, onClose: () => close(true), returnTo: () => triggerRef.current, autofocus: false });

  useLayoutEffect(() => {
    if (!open) return undefined;
    latest.current.focus?.(sheet);
    const placeIt = () => {
      const button = triggerRef.current;
      if (!button) return;
      const r = button.getBoundingClientRect();
      const width = Math.min(latest.current.widthOf(r), window.innerWidth - 2 * EDGE);
      const left = Math.max(EDGE, Math.min(r.left, window.innerWidth - EDGE - width));
      const below = window.innerHeight - r.bottom - GAP - EDGE;
      const above = r.top - GAP - EDGE;
      const up = below < ENOUGH_BELOW && above > below;
      const height = Math.max(160, Math.min(TALLEST, up ? above : below));
      setPlace(up ? { up, left, width, height, bottom: window.innerHeight - r.top + GAP } : { up, left, width, height, top: r.bottom + GAP });
    };
    const button = triggerRef.current;
    if (button && !onPhone()) {
      button.scrollIntoView?.({ block: "nearest" });
      // As tall as the list is now (at most TALLEST), and never less than ENOUGH_BELOW.
      const want = Math.min(TALLEST, Math.max(popRef.current?.offsetHeight ?? 0, ENOUGH_BELOW));
      const r = button.getBoundingClientRect();
      const below = window.innerHeight - r.bottom - GAP - EDGE;
      const scroller = below < want ? scrollerOf(button) : null;
      if (scroller) {
        const shown = Math.max(scroller.getBoundingClientRect().top, 0);
        const by = Math.min(want - below, scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop, r.top - shown - EDGE);
        if (by > 0) scroller.scrollTop += by;
      }
    }
    placeIt();
    const onScroll = (event) => {
      if (!popRef.current?.contains(event.target)) placeIt();
    };
    window.addEventListener("resize", placeIt);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", placeIt);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const outside = (event) => {
      if (popRef.current?.contains(event.target) || triggerRef.current?.contains(event.target)) return;
      close(false);
    };
    // (An Esc that a control inside already spent, or one that cancels an input method's candidate, is not this list's.)
    const escape = (event) => {
      if (!isEscape(event) || event.defaultPrevented) return;
      event.preventDefault();
      close(true);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  useEffect(() => {
    if (disabled && open) close(false);
  }, [disabled]);

  const popStyle = place
    ? { "--pop-left": `${place.left}px`, "--pop-w": `${place.width}px`, "--pop-h": `${place.height}px`, ...(place.up ? { "--pop-bottom": `${place.bottom}px` } : { "--pop-top": `${place.top}px` }) }
    : undefined;
  return { open, sheet: open && sheet, show, close, triggerRef, popRef, popStyle, up: Boolean(place?.up) };
}
