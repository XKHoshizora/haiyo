// The menu of a message bubble: a long-press on touch, a right-click or the context-menu key on desktop, as the mainstream
// chat apps have it. `BubbleMenu` is the menu itself (an actions list: more can be added later), `useBubbleMenu` the
// gestures that open it and what they must not do (select text, open the viewer or a mention card, hijack a link's own menu).
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** How long a finger rests on a bubble before the menu opens (ms), and how far it may wander (px) before it is a scroll. */
export const HOLD_MS = 450;
export const SLOP = 10;
/** What a press may start on: the bubble of a text, a picture, a file card. */
const TARGETS = ".bubble, .attachment-image, .file-card";
/** The click that follows a long-press's release is swallowed for this long (ms). */
const SWALLOW_MS = 600;
const GAP = 6;
const MARGIN = 8;

const clamp = (n, low, high) => Math.min(Math.max(n, low), Math.max(low, high));

/**
 * Where the menu goes: under `anchor` ({left, top, right, bottom}; a point has no size), above it when under it does not fit,
 * always inside `bounds` (the message list: clear of the header over it and the composer under it) and the sides.
 */
export function placeMenu({ anchor, size, bounds, gap = GAP, margin = MARGIN }) {
  const top = bounds.top + margin;
  const bottom = bounds.bottom - margin;
  const below = bottom - (anchor.bottom + gap);
  const above = anchor.top - gap - top;
  let flipped = false;
  let y;
  if (size.h <= below) y = anchor.bottom + gap;
  else if (size.h <= above) {
    y = anchor.top - gap - size.h;
    flipped = true;
  } else {
    flipped = above > below;
    y = clamp(flipped ? anchor.top - gap - size.h : anchor.bottom + gap, top, bottom - size.h);
  }
  return { left: clamp(anchor.left, bounds.left + margin, bounds.right - margin - size.w), top: y, flipped };
}

/** The menu that is open (one at a time): how to close it. */
let closeOpen = null;

/**
 * `actions`: `[{id, label, icon?, run(), disabled?}]`. Arrow keys, Home and End move, Enter or Space takes the item,
 * Esc closes and gives the focus back (`onClose({restore: true})`), Tab, a press elsewhere, a scroll and a resize close it.
 */
export function BubbleMenu({ anchor, bounds, actions, onClose, label = "消息操作" }) {
  const box = useRef(null);
  const [place, setPlace] = useState(null);
  useLayoutEffect(() => {
    const rect = box.current.getBoundingClientRect();
    setPlace(placeMenu({ anchor, size: { w: rect.width, h: rect.height }, bounds }));
  }, [anchor, bounds]);
  const items = () => [...box.current.querySelectorAll('[role="menuitem"]:not(:disabled)')];
  useEffect(() => {
    if (place) items()[0]?.focus({ preventScroll: true });
  }, [place === null]);
  useEffect(() => {
    const away = (e) => !box.current?.contains(e.target) && onClose({ restore: false });
    const leave = () => onClose({ restore: false });
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("scroll", leave, true);
    document.addEventListener("wheel", leave, { passive: true, capture: true });
    window.addEventListener("resize", leave);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("scroll", leave, true);
      document.removeEventListener("wheel", leave, { capture: true });
      window.removeEventListener("resize", leave);
    };
  }, [onClose]);
  const onKeyDown = (e) => {
    const list = items();
    const at = list.indexOf(document.activeElement);
    const go = (i) => {
      e.preventDefault();
      list[(i + list.length) % list.length]?.focus({ preventScroll: true });
    };
    if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at < 0 ? -1 : at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(-1);
    else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose({ restore: true });
    } else if (e.key === "Tab") onClose({ restore: false });
  };
  return createPortal(
    <div
      ref={box}
      className="bubble-menu"
      role="menu"
      aria-label={label}
      style={place ? { left: place.left, top: place.top } : { left: 0, top: 0, visibility: "hidden" }}
      data-flipped={place?.flipped ? "" : undefined}
      onKeyDown={onKeyDown}
    >
      {actions.map(({ id, label: text, icon: Icon, run, disabled }) => (
        <button
          key={id}
          type="button"
          role="menuitem"
          tabIndex={-1}
          disabled={disabled}
          onClick={() => {
            onClose({ restore: true });
            run();
          }}
        >
          {Icon && <Icon size={17} aria-hidden="true" />}
          <span>{text}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}

const rectOf = (el) => {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
};

/**
 * The gestures of one message. `getActions()` is asked when the menu is about to open (none: nothing opens and the browser's
 * own menu stays). Spread `bind` on the message's container and draw `element` anywhere.
 */
export function useBubbleMenu(getActions) {
  const [shown, setShown] = useState(null);
  const get = useRef(getActions);
  get.current = getActions;
  const timer = useRef(0);
  const press = useRef(null);
  const heldAt = useRef(0);
  const openRef = useRef(null);
  const container = useRef(null);

  const close = useCallback(({ restore = false } = {}) => {
    const was = openRef.current;
    openRef.current = null;
    if (closeOpen === close) closeOpen = null;
    setShown(null);
    if (restore && was?.returnTo?.isConnected) {
      if (!was.returnTo.matches("a, button, input, textarea, select, [tabindex]")) was.returnTo.setAttribute("tabindex", "-1");
      was.returnTo.focus({ preventScroll: true });
    }
  }, []);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      if (closeOpen === close) closeOpen = null;
    },
    [close],
  );

  const open = (target, anchor, returnTo) => {
    const actions = get.current();
    if (!actions || actions.length === 0) return false;
    if (closeOpen && closeOpen !== close) closeOpen({ restore: false });
    closeOpen = close;
    const list = target.closest("[data-testid=message-list]");
    const bounds = list ? rectOf(list) : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
    const state = { actions, anchor: anchor ?? rectOf(target), bounds, returnTo };
    openRef.current = state;
    setShown(state);
    return true;
  };
  const hit = (e) => {
    const target = e.target?.closest?.(TARGETS);
    return target && e.currentTarget.contains(target) ? target : null;
  };
  const cancel = () => {
    clearTimeout(timer.current);
    press.current = null;
  };

  const bind = {
    ref: container,
    onPointerDown(e) {
      if (e.pointerType === "mouse" || !hit(e)) return;
      const target = hit(e);
      press.current = { x: e.clientX, y: e.clientY };
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        press.current = null;
        if (open(target, null, target)) heldAt.current = Date.now();
      }, HOLD_MS);
    },
    onPointerMove(e) {
      const p = press.current;
      if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > SLOP) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onPointerLeave: cancel,
    // The release of a long-press is followed by a click: not for the picture's viewer, not for a mention's card.
    onClickCapture(e) {
      if (Date.now() - heldAt.current < SWALLOW_MS && hit(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    onContextMenu(e) {
      const target = hit(e);
      if (!target) return;
      // A link keeps its own menu (open, copy address), and so does selected text (copy).
      if (e.target.closest("a[href]") || (window.getSelection?.()?.toString() ?? "") !== "") return;
      if (openRef.current || Date.now() - heldAt.current < 1000) {
        e.preventDefault();
        return;
      }
      if (open(target, { left: e.clientX, top: e.clientY, right: e.clientX, bottom: e.clientY }, target)) e.preventDefault();
    },
    onKeyDown(e) {
      if (e.key !== "ContextMenu" && !(e.key === "F10" && e.shiftKey)) return;
      const target = container.current?.querySelector(TARGETS);
      if (!target) return;
      if (open(target, null, e.target)) e.preventDefault();
    },
  };
  // ('ref' is for the keyboard's way to a bubble; the rest spreads on the container.)
  const element = shown ? <BubbleMenu key="menu" anchor={shown.anchor} bounds={shown.bounds} actions={shown.actions} onClose={close} /> : null;
  return { bind, element };
}
