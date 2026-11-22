// The one primitive of every modal surface: a dialog (ui/primitives.jsx `Modal`), the image viewer (ui/ImageViewer.jsx), a picker's
// sheet on a phone (ui/popover.js). While one is open:
// - the page behind it, and any layer under it, is inert (the platform's `inert`: Chrome 102, Firefox 112, Safari 15.5 — inside our
//   floor of Chrome 111 / Firefox 114 / Safari 16.4); only what must stay live (the toast's region, `data-live`) is left out;
// - the focus goes in (its `[data-autofocus]`, else its first control) and Tab goes round inside it;
// - Esc closes the top layer only — never an Esc a control inside spent (`preventDefault`, as a list or a menu does), nor one that
//   cancels an input method's candidate (ui/keys.js); in a search box with words, Esc empties the box first;
// - when it closes, the focus goes back to its opener (`returnTo()`, else where the focus was);
// - Back closes it and nothing else: it owns one history entry at the address of the page under it (state/appHistory.js).
// Each layer node is drawn straight in document.body (a portal), so that everything else there can be made inert.
// Why not `<dialog>` + showModal(): its top layer would sit over the toast and over the pickers a dialog opens (portalled lists,
// menus), and lifting those into the top layer needs `popover` (Safari 17); `inert` gives the same inert page on our floor.
import { useEffect, useRef } from "react";
import { isEscape } from "./keys.js";
import { closeLayerEntry, isLayerTraversal, layerLeftByBack, layerOnEntry, openLayerEntry } from "../state/appHistory.js";

const FOCUSABLE = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex='-1'])";
const focusables = (node) => [...node.querySelectorAll(FOCUSABLE)];

/** The open layers, bottom to top: {node, close(), held()}. */
const stack = [];
/** The elements this module made inert (it never touches an `inert` it did not set). */
const madeInert = new Set();
let nextId = 1;

/** The child of document.body that holds `node`. */
const hostOf = (node) => {
  let el = node;
  while (el?.parentElement && el.parentElement !== document.body) el = el.parentElement;
  return el;
};

/** Everything in the body but the top layer (and what must stay live) is inert; nothing is while no layer is open. */
function settleInert() {
  const top = stack.at(-1);
  const keep = top ? hostOf(top.node) : null;
  const want = new Set(top ? [...document.body.children].filter((el) => el !== keep && !el.hasAttribute("data-live") && el.tagName !== "SCRIPT") : []);
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
  useEffect(() => {
    if (!active) return undefined;
    const node = ref.current;
    if (!node) return undefined;
    if (!listening) {
      window.addEventListener("keydown", onEscape);
      listening = true;
    }
    id.current ??= `layer-${nextId++}`;
    const own = id.current;
    const previous = document.activeElement;
    const layer = { node, close: () => latest.current.onClose?.(), held: () => Boolean(latest.current.held?.()) };
    stack.push(layer);
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
      settleInert();
      if (history) {
        window.removeEventListener("popstate", onPop);
        closeLayerEntry(own);
      }
      // The element that opened it; else where the focus was — whichever is still on the page (and not inside a layer that is gone).
      const back = [latest.current.returnTo?.(), previous].find((el) => el instanceof HTMLElement && el.isConnected && el !== document.body && !node.contains(el));
      back?.focus();
    };
  }, [active]);
}
