import React, { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "../icons.js";
import { composing, isEnter, isEscape } from "./keys.js";
import { usePopover } from "./popover.js";

/** Letters typed this close together make one word to jump to (ms). */
const TYPED_TOGETHER_MS = 700;

/**
 * A plain choice in the app's own look, where a native `<select>` would be: a button showing the chosen option that opens
 * a list of the options (no search, no marks), the chosen one ticked; a sheet at the bottom of the screen under 480 px.
 * The model picker's popover and keyboard (src/ui/popover.js), as a select-only combobox: the focus stays on the button;
 * ↑/↓ open it and move (Home/End to the ends), Enter or Space chooses, Esc closes, Tab leaves, a press outside closes,
 * and typing jumps to the option that begins with what was typed. An option that cannot be chosen is skipped and says
 * why (`hint`).
 *
 * - `value` (the chosen option's `value`; one not offered shows `placeholder`), `options`: [{value, label, disabled, hint}],
 *   `onChange(value)` when another option is chosen.
 * - `id`, `aria-describedby`, `aria-invalid`, `aria-label` / `labelledBy`, as a field gives them (`Field` passes the first
 *   three); `listLabel`: what its list is called (the field's label).
 */
export function Select({
  id,
  value = null,
  options,
  onChange,
  placeholder = "",
  disabled = false,
  listLabel,
  labelledBy,
  "aria-label": ariaLabel,
  "aria-describedby": describedBy,
  "aria-invalid": invalid,
}) {
  const base = useId();
  const listId = `${base}-list`;
  const [active, setActive] = useState(null);
  const typed = useRef({ text: "", at: 0 });
  // A Space that chose ends with a click on the button (at its keyup): that click must not open the list again.
  const spaceChose = useRef(false);
  const listRef = useRef(null);
  // (On a phone the list is a sheet over an inert page: the focus goes to the list itself, which takes the same keys.)
  const { open, sheet, show, close, triggerRef, popRef, popStyle, up } = usePopover({ disabled, widthOf: (box) => Math.max(box.width, 200), focus: (asSheet) => asSheet && listRef.current?.focus() });

  const optionId = new Map(options.map((o, i) => [o.value, `${base}-o${i}`]));
  const current = options.find((o) => o.value === value) ?? null;
  const choosable = options.filter((o) => !o.disabled);
  // Where the keyboard is: the option moved to, else the chosen one, else the first that can be chosen.
  const activeValue = choosable.some((o) => o.value === active) ? active : (choosable.find((o) => o.value === value) ?? choosable[0])?.value ?? null;

  const openList = () => {
    if (show()) setActive(null);
  };
  const choose = (next) => {
    const option = options.find((o) => o.value === next);
    if (!option || option.disabled) return;
    close(true);
    if (next !== value) onChange(next);
  };
  const move = (to) => {
    if (choosable.length === 0) return;
    const at = choosable.findIndex((o) => o.value === activeValue);
    const index = to === "first" ? 0 : to === "last" ? choosable.length - 1 : Math.max(0, Math.min(choosable.length - 1, at + to));
    setActive(choosable[index].value);
  };
  const jump = (letter) => {
    const now = Date.now();
    const together = now - typed.current.at < TYPED_TOGETHER_MS;
    const startsWith = (text) => choosable.find((o) => String(o.label).toLowerCase().startsWith(text));
    let text = together ? typed.current.text + letter.toLowerCase() : letter.toLowerCase();
    let found = startsWith(text);
    if (!found && text.length > 1) {
      text = letter.toLowerCase();
      found = startsWith(text);
    }
    typed.current = { text, at: now };
    if (found) setActive(found.value);
  };

  // The option the keyboard is on stays in view.
  useLayoutEffect(() => {
    if (open && activeValue !== null) document.getElementById(optionId.get(activeValue))?.scrollIntoView?.({ block: "nearest" });
  }, [open, activeValue]);

  const onKeyDown = (event) => {
    if (composing(event) || disabled) return;
    const { key } = event;
    const letter = key.length === 1 && key !== " " && !event.ctrlKey && !event.metaKey && !event.altKey;
    if (!open) {
      if (key === "ArrowDown" || key === "ArrowUp" || isEnter(event) || key === " ") {
        event.preventDefault();
        if (key === " ") spaceChose.current = true;
        openList();
      } else if (letter) {
        event.preventDefault();
        openList();
        jump(key);
      }
      return;
    }
    if (key === "ArrowDown" || key === "ArrowUp") {
      event.preventDefault();
      move(key === "ArrowDown" ? 1 : -1);
    } else if (key === "Home" || key === "End") {
      event.preventDefault();
      move(key === "Home" ? "first" : "last");
    } else if (isEnter(event) || key === " ") {
      event.preventDefault();
      if (key === " ") spaceChose.current = true;
      if (activeValue !== null) choose(activeValue);
    } else if (isEscape(event)) {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (key === "Tab") {
      close(false);
    } else if (letter) {
      event.preventDefault();
      jump(key);
    }
  };
  const onKeyUp = (event) => {
    if (event.key !== " ") return;
    event.preventDefault();
    setTimeout(() => {
      spaceChose.current = false;
    }, 0);
  };
  const onClick = () => {
    if (spaceChose.current) {
      spaceChose.current = false;
      return;
    }
    if (open) close(true);
    else openList();
  };

  const popover =
    open &&
    createPortal(
      <>
        <div className="model-scrim" aria-hidden="true" />
        <div ref={popRef} className={`select-pop${up ? " up" : ""}`} style={popStyle}>
          {/* A press on an option leaves the focus on the button (one on the list's own scrollbar is let through). */}
          <div
            ref={listRef}
            className="select-list"
            role="listbox"
            id={listId}
            aria-label={listLabel}
            tabIndex={sheet ? -1 : undefined}
            aria-activedescendant={sheet && activeValue !== null ? optionId.get(activeValue) : undefined}
            onKeyDown={sheet ? onKeyDown : undefined}
            onKeyUp={sheet ? onKeyUp : undefined}
            onMouseDown={(e) => e.target !== e.currentTarget && e.preventDefault()}
          >
            {options.map((o) => (
              <div
                key={o.value}
                id={optionId.get(o.value)}
                role="option"
                data-value={o.value}
                className={`select-option${o.value === activeValue ? " active" : ""}`}
                aria-selected={o.value === value}
                aria-disabled={o.disabled || undefined}
                title={o.disabled ? o.hint : undefined}
                onMouseMove={() => !o.disabled && o.value !== active && setActive(o.value)}
                onClick={() => choose(o.value)}
              >
                <span className="model-check" aria-hidden="true">{o.value === value && <Check size={14} />}</span>
                <span className="select-label">{o.label}</span>
                {o.hint && <span className="model-reason">{o.hint}</span>}
              </div>
            ))}
          </div>
        </div>
      </>,
      document.body,
    );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        id={id}
        className="select-trigger"
        value={value ?? ""}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && !sheet && activeValue !== null ? optionId.get(activeValue) : undefined}
        aria-label={ariaLabel}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        title={current?.label}
        disabled={disabled}
        onClick={onClick}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
      >
        <span className="select-label">{current?.label ?? placeholder}</span>
        <ChevronDown className="model-chevron" size={16} aria-hidden="true" />
      </button>
      {popover}
    </>
  );
}
