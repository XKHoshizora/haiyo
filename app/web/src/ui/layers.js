// The one primitive of every modal surface: a dialog (ui/primitives.jsx `Modal`), the image viewer (ui/ImageViewer.jsx), a picker's
// sheet on a phone (ui/popover.js). While one is open:
// - the page behind it, and any layer under it, is inert (the platform's `inert`: Chrome 102, Firefox 112, Safari 15.5 — inside our
//   floor of Chrome 111 / Firefox 114 / Safari 16.4); only what must stay live (the toast's region, `data-live`) is left out;
// - the focus goes in (its `[data-autofocus]`, else its first control) and Tab goes round inside it;
// - Esc closes the top layer only — never an Esc a control inside spent (`preventDefault`, as a list or a menu does), nor one that
//   cancels an input method's candidate (ui/keys.js); in a search box with words, Esc empties the box first;
// - when it closes (in the same commit, its inert gone first), the focus goes back to its opener (`returnTo()`, else where the focus
//   was) if that is still shown, else to the nearest place left of where it sat, else to the page's heading — never to <body>;
// - Back closes it and nothing else: it owns one history entry at the address of the page under it (state/appHistory.js).
// Each layer node is drawn straight in document.body (a portal), so that everything else there can be made inert.
// Why not `<dialog>` + showModal(): its top layer would sit over the toast and over the pickers a dialog opens (portalled lists,
// menus), and lifting those into the top layer needs `popover` (Safari 17); `inert` gives the same inert page on our floor.
import { useLayoutEffect, useRef } from "react";
import { isEscape } from "./keys.js";
import { anchorsOf, neighboursOf, restoreFocus } from "./focusRules.js";
import { closeLayerEntry, isLayerTraversal, layerLeftByBack, layerOnEntry, openLayerEntry } from "../state/appHistory.js";

const FOCUSABLE = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex='-1'])";
const focusables = (node) => [...node.querySelectorAll(FOCUSABLE)];

/** The open layers, bottom to top: {node, close(), held()}. */
const stack = [];
/** The elements this module made inert (it never touches an `inert` it did not set). */
const madeInert = new Set();
/** Ids are unique across loads of the page: an entry left by a page before a reload never names a layer of this one. */
const LOAD = Math.random().toString(36).slice(2, 8);
let nextId = 1;

/** The child of document.body that holds `node`. */
const hostOf = (node) => {
  let el = node;
  while (el?.parentElement && el.parentElement !== document.body) el = el.parentElement;
  return el;
};

/**
 * Everything in the body before the top layer is inert (the page and the layers under it); what comes after it in the body was
 * opened from it (a list, a menu: portals are appended as they open) and stays live, as does what must (the toast's region,
 * `data-live`). Nothing is inert while no layer is open.
 */
function settleInert() {
  const top = stack.at(-1);
  const keep = top ? hostOf(top.node) : null;
  const children = [...document.body.children];
  const upTo = keep ? children.indexOf(keep) : -1;
  const want = new Set(children.slice(0, Math.max(upTo, 0)).filter((el) => !el.hasAttribute("data-live") && el.tagName !== "SCRIPT"));
  for (const el of madeInert) {
    if (want.has(el)) continue;
    el.removeAttribute("inert");
    madeInert.delete(el);
  }
  for (const el of want) {
    if (madeInert.has(el) || el.hasAttribute("inert")) continue;
    el.setAttribute("inert", "");
    madeInert.add(el);
  }
}

// ───────── the page behind does not scroll
// `inert` stops focus and taps, not scrolling: on iOS a drag on a layer whose list has little or nothing to scroll is handed to what is behind it, and the
// pages scroll in boxes of their own (a form, a list), not in the document. So while a layer is open: the document is locked (`html[data-layer-open]`,
// styles.css), and every touch move or wheel is judged here — it goes on only when it starts inside the top layer (or what was opened from it) on a
// box that can scroll the way it goes; anything else is stopped, which is also what keeps a drag at a list's end from reaching the page.
const scrollOf = (el, vertical) => {
  const style = getComputedStyle(el);
  const mode = vertical ? style.overflowY : style.overflowX;
  return (mode === "auto" || mode === "scroll") && (vertical ? el.scrollHeight > el.clientHeight : el.scrollWidth > el.clientWidth);
};
/** Whether `target` is in the top layer or in something opened after it (the body's later children). */
function inLiveRegion(target) {
  const top = stack.at(-1);
  if (!top || !(target instanceof Node)) return false;
  const children = [...document.body.children];
  const host = hostOf(target instanceof Element ? target : target.parentElement);
  return host !== null && children.indexOf(host) >= children.indexOf(hostOf(top.node));
}
/** Whether a box between `target` and the top layer can scroll by `delta` (positive: down / right) on that axis. */
function canScroll(target, delta, vertical) {
  const top = stack.at(-1);
  for (let el = target instanceof Element ? target : target.parentElement; el && el !== document.body; el = el.parentElement) {
    if (scrollOf(el, vertical)) {
      const at = vertical ? el.scrollTop : el.scrollLeft;
      const max = vertical ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth;
      if (delta > 0 ? at < max - 0.5 : at > 0.5) return true;
    }
    if (el === top?.node) break;
  }
  return false;
}
let touchFrom = null;
function onTouchStart(event) {
  touchFrom = event.touches.length === 1 ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : null;
}
function onTouchMove(event) {
  if (!stack.length || event.defaultPrevented || event.touches.length !== 1 || !touchFrom) return;
  const dx = touchFrom.x - event.touches[0].clientX;
  const dy = touchFrom.y - event.touches[0].clientY;
  const vertical = Math.abs(dy) >= Math.abs(dx);
  touchFrom = { x: event.touches[0].clientX, y: event.touches[0].clientY };
  if (inLiveRegion(event.target) && canScroll(event.target, vertical ? dy : dx, vertical)) return;
  if (event.cancelable) event.preventDefault();
}
function onWheel(event) {
  if (!stack.length || event.defaultPrevented || event.ctrlKey) return;
  const vertical = Math.abs(event.deltaY) >= Math.abs(event.deltaX);
  if (inLiveRegion(event.target) && canScroll(event.target, vertical ? event.deltaY : event.deltaX, vertical)) return;
  if (event.cancelable) event.preventDefault();
}
let documentAt = null;
function lockDocument() {
  documentAt = { x: window.scrollX, y: window.scrollY };
  document.documentElement.setAttribute("data-layer-open", "");
  document.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
  document.addEventListener("touchmove", onTouchMove, { capture: true, passive: false });
  document.addEventListener("wheel", onWheel, { capture: true, passive: false });
}
function unlockDocument() {
  document.documentElement.removeAttribute("data-layer-open");
  document.removeEventListener("touchstart", onTouchStart, { capture: true });
  document.removeEventListener("touchmove", onTouchMove, { capture: true });
  document.removeEventListener("wheel", onWheel, { capture: true });
  // Exactly where it was.
  if (documentAt && (window.scrollX !== documentAt.x || window.scrollY !== documentAt.y)) window.scrollTo(documentAt.x, documentAt.y);
  documentAt = null;
}

/** A search box's own Esc: it empties the box, as the browsers' own search fields do, and React hears the change. */
function emptySearch(field) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(field, "");
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Esc for the top layer: on the window, so after every handler of the page and of the layer itself has had its say. */
function onEscape(event) {
  const top = stack.at(-1);
  if (!top || event.defaultPrevented || !isEscape(event)) return;
  event.preventDefault();
  const field = event.target;
  if (field instanceof HTMLInputElement && field.type === "search" && field.value !== "" && top.node.contains(field)) {
    emptySearch(field);
    return;
  }
  if (!top.held()) top.close();
}
let listening = false;

/**
 * Makes the box `ref` a modal layer while `active`. `onClose()`: what closes it (Esc, Back; the owner decides); `returnTo()`: where
 * the focus goes when it closes (else where the focus was before); `held()`: true while it may not be left (Esc does nothing and
 * Back is caught again); `history`: false for a layer whose entry is kept elsewhere (the viewer's); `autofocus`: false when the
 * caller moves the focus in itself.
 */
export function useLayer(ref, { onClose, returnTo = null, held = null, active = true, history = true, autofocus = true }) {
  const latest = useRef(null);
  latest.current = { onClose, returnTo, held };
  const id = useRef(null);
  // In the layout phase, opening and closing alike: the inert of a layer that goes is gone in the very commit that removes it, so no
  // effect after it (the page's own focus, ui/routeFocus.js) ever sees a stale one.
  useLayoutEffect(() => {
    if (!active) return undefined;
    const node = ref.current;
    if (!node) return undefined;
    if (!listening) {
      window.addEventListener("keydown", onEscape);
      listening = true;
    }
    id.current ??= `layer-${LOAD}-${nextId++}`;
    const own = id.current;
    const previous = document.activeElement;
    // Where the opener sits (its list, its section, its column…): where the focus goes if the opener is gone when this closes.
    const anchors = anchorsOf(previous);
    const neighbours = neighboursOf(previous);
    const layer = { node, close: () => latest.current.onClose?.(), held: () => Boolean(latest.current.held?.()) };
    stack.push(layer);
    if (stack.length === 1) lockDocument();
    settleInert();
    if (autofocus && !node.contains(document.activeElement)) {
      const first = node.querySelector("[data-autofocus]") || focusables(node)[0];
      if (first) first.focus();
      else {
        if (!node.hasAttribute("tabindex")) node.setAttribute("tabindex", "-1");
        node.focus();
      }
    }
    const onTab = (e) => {
      if (e.key !== "Tab") return;
      const list = focusables(node);
      if (!list.length) return;
      const head = list[0];
      const tail = list[list.length - 1];
      if (e.shiftKey && document.activeElement === head) {
        e.preventDefault();
        tail.focus();
      } else if (!e.shiftKey && document.activeElement === tail) {
        e.preventDefault();
        head.focus();
      }
    };
    node.addEventListener("keydown", onTab);
    // Back: the person's own traversal left this layer's entry (one the layers make themselves, over their own entries, is not that).
    const onPop = (event) => {
      if (isLayerTraversal(event) || layerOnEntry(own)) return;
      const keep = layer.held();
      layerLeftByBack(own, keep);
      if (!keep) layer.close();
    };
    if (history) {
      openLayerEntry(own);
      window.addEventListener("popstate", onPop);
    }
    return () => {
      node.removeEventListener("keydown", onTab);
      const at = stack.indexOf(layer);
      if (at >= 0) stack.splice(at, 1);
      if (stack.length === 0) unlockDocument();
      settleInert();
      if (history) {
        window.removeEventListener("popstate", onPop);
        closeLayerEntry(own);
      }
      // One decision, after the inert is gone (ui/focusRules.js `restoreFocus`): the element that opened it, else where the focus was,
      // if shown; else the nearest place left of where it sat; else the page's heading — never <body>. A change of page in the same
      // commit has its own say right after (ui/routeFocus.js moves a focus this put on something that page removed), and anything
      // else the commit removes from under the focus is caught after it (the shell's watch, ui/routeFocus.js).
      restoreFocus({ candidates: [latest.current.returnTo?.(), previous], neighbours, anchors, away: node });
    };
  }, [active]);
}
