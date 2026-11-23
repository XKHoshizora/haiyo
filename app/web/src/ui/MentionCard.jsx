// A mention of someone who is here: their current display name on a light tint, and a small card on hover, focus or tap
// — avatar, display name, kind, account name and, for an Agent, its owner. The card hangs in the page's body (fixed,
// placed from the mention's box), so it never moves the message; it closes on Esc, on a press anywhere else, and when
// the pointer or the focus leaves; one card at a time.
import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ME } from "../data/identities.js";
import { useStore } from "../data/store.jsx";
import { isAgent, nameOf, ownerOf } from "../state/selectors.js";
import { Avatar, Tag } from "./primitives.jsx";
import { isEnter, isEscape } from "./keys.js";

/** The pointer rests this long (ms) on a mention before its card opens, and leaves it this long before it closes. */
const OPEN_DELAY = 250;
/** A mouseenter this soon after a touch is the browser's emulation of it, not a mouse (ms). */
const AFTER_TOUCH_MS = 1000;
const CLOSE_DELAY = 150;
/** Room kept between the card and the window's edges, and between it and the mention (px). */
const EDGE = 8;
const GAP = 6;

/** The card that is open, if any: opening another closes it. */
let openCard = null;

/** Who the card is about: name, kind, account name, owner (an Agent's) — all as the store says now. */
function Who({ id }) {
  const { state } = useStore();
  const who = state.people[id] || state.agents[id];
  const agent = isAgent(state, id);
  if (!who) return null;
  return (
    <>
      <span aria-hidden="true">
        <Avatar id={id} size={40} />
      </span>
      <span className="mention-card-body">
        <span className="mention-card-name">
          <strong>{who.displayName || who.name}</strong>
          {agent && <Tag>Agent</Tag>}
        </span>
        <span className="mention-card-handle">{who.handle}</span>
        {agent && <span className="owner">主人：{nameOf(state, ownerOf(state, id))}</span>}
      </span>
    </>
  );
}

/**
 * `spoken`: what a screen reader says it means (提到 …); `shown`: the name on the tint (`@name`). The visible name comes
 * first, the hidden words after it: a pointer's target (a test's default hover, too) is then the name itself.
 */
export function MentionChip({ id, spoken, shown, agent }) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState(null);
  const chip = useRef(null);
  const card = useRef(null);
  const timer = useRef(0);
  // iOS answers a tap with mouse events too (mouseenter first): a card that appears on that "hover" makes Safari take the tap for the
  // hover and drop the click. A mouseenter just after a touch is not a hover.
  const touched = useRef(0);
  const cardId = useId();
  const close = useCallback(() => {
    clearTimeout(timer.current);
    setOpen(false);
  }, []);
  const show = useCallback(() => {
    clearTimeout(timer.current);
    if (openCard && openCard !== close) openCard();
    openCard = close;
    setOpen(true);
  }, [close]);
  const later = (run, delay) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(run, delay);
  };

  useEffect(
    () => () => {
      clearTimeout(timer.current);
      if (openCard === close) openCard = null;
    },
    [close],
  );

  // Placed under the mention, above it when there is no room below; again when the page scrolls or the window changes.
  useLayoutEffect(() => {
    if (!open) {
      setPlace(null);
      if (openCard === close) openCard = null;
      return undefined;
    }
    const placeIt = () => {
      const anchor = chip.current?.getBoundingClientRect();
      const box = card.current;
      if (!anchor || !box) return;
      const w = box.offsetWidth;
      const h = box.offsetHeight;
      const below = anchor.bottom + GAP;
      const above = anchor.top - GAP - h;
      const top = below + h > window.innerHeight - EDGE && above >= EDGE ? above : below;
      const left = Math.max(EDGE, Math.min(anchor.left, window.innerWidth - w - EDGE));
      setPlace({ top, left });
    };
    placeIt();
    window.addEventListener("scroll", placeIt, true);
    window.addEventListener("resize", placeIt);
    return () => {
      window.removeEventListener("scroll", placeIt, true);
      window.removeEventListener("resize", placeIt);
    };
  }, [open, close]);

  // Esc and a press anywhere else close it.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (!isEscape(e)) return;
      e.preventDefault();
      close();
    };
    const onPress = (e) => {
      if (!chip.current?.contains(e.target) && !card.current?.contains(e.target)) close();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPress);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPress);
    };
  }, [open, close]);

  const self = id === ME;
  const className = `mention${agent ? " mention-agent" : ""}${self ? " mention-self" : ""}`;
  return (
    <>
      <span
        ref={chip}
        className={className}
        role="button"
        tabIndex={0}
        data-mention={id}
        aria-describedby={open ? cardId : undefined}
        onTouchStart={() => (touched.current = Date.now())}
        onMouseEnter={() => Date.now() - touched.current > AFTER_TOUCH_MS && later(show, OPEN_DELAY)}
        onMouseLeave={() => later(close, CLOSE_DELAY)}
        onFocus={show}
        onBlur={close}
        onClick={(e) => {
          // (A click on a mention is for the mention: the message around it does not hear it.)
          e.stopPropagation();
          show();
        }}
        onKeyDown={(e) => {
          if (isEnter(e) || e.key === " ") {
            e.preventDefault();
            show();
          }
        }}
      >
        <span aria-hidden="true">{shown}</span>
        <span className="sr-only">{spoken}</span>
      </span>
      {open &&
        createPortal(
          <div
            ref={card}
            id={cardId}
            role="tooltip"
            className="mention-card"
            style={place ? { top: place.top, left: place.left } : { top: 0, left: 0, visibility: "hidden" }}
            onMouseEnter={() => clearTimeout(timer.current)}
            onMouseLeave={() => later(close, CLOSE_DELAY)}
          >
            <Who id={id} />
          </div>,
          document.body,
        )}
    </>
  );
}
