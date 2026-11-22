// Where the focus may go, and the one fallback chain used whenever what had it went away (a dialog that closed, a row that was
// removed, a page that changed): ui/layers.js, ui/routeFocus.js. The focus is never left on <body>.

/** On screen and reachable: connected, drawn (not under `display: none`), not inside an inert part of the page. */
export const shown = (el) => el instanceof HTMLElement && el.isConnected && el.getClientRects().length > 0 && !el.closest("[inert]");
/** The focus is nowhere a person can see: on <body>, or on something hidden, removed or made inert. */
export const lost = () => document.activeElement === document.body || !shown(document.activeElement);

/** Focuses `el` if it is shown (a heading or a box takes it with tabindex="-1"); whether it now has the focus. */
export function focusOn(el) {
  if (!shown(el)) return false;
  if (!el.matches("a[href], button, input, select, textarea, [tabindex]")) el.setAttribute("tabindex", "-1");
  el.focus({ preventScroll: true });
  return document.activeElement === el;
}

/** A view's heading, else its first control, else the view itself. */
export function focusView(view) {
  if (!shown(view)) return false;
  return focusOn(view.querySelector("h1, h2")) || focusOn(view.querySelector("button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled])")) || focusOn(view);
}

/** The containers of `el`, nearest first (where the focus goes when `el` itself is gone): its list, its section, its column… */
export function anchorsOf(el) {
  const out = [];
  for (let node = el?.parentElement; node && node !== document.body; node = node.parentElement) out.push(node);
  return out;
}

/** The page's own heading: the page shown beside or instead of the list, else the list. */
const pageViews = () => [document.querySelector(".main-col"), document.querySelector(".list-col"), document.querySelector("main")];

/**
 * The one chain: the first of `candidates` that is shown and outside `away` (a layer that is closing); else the nearest of `anchors`
 * that is still there; else the page's heading. Returns whether something took the focus.
 */
export function restoreFocus({ candidates = [], anchors = [], away = null }) {
  for (const el of candidates) if (el instanceof HTMLElement && !away?.contains(el) && focusOn(el)) return true;
  for (const box of anchors) if (!away?.contains(box) && focusView(box)) return true;
  for (const view of pageViews()) if (focusView(view)) return true;
  return false;
}
