import React, { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Search } from "../icons.js";
import { composing, isEnter, isEscape } from "../ui/keys.js";
import { ModelBrand } from "../ui/ModelBrand.jsx";
import { COLUMNS, MarksLegend, ModelMarks, PRICE_TEXT, markKinds, markWords, useMarksMode } from "../ui/ModelMarks.jsx";
import { useMoreBelow } from "../ui/moreBelow.js";
import { usePopover } from "../ui/popover.js";

/** What a row is called (its name, then its marks in column order; one that cannot be chosen: its name and why). */
export const optionLabel = (option) => (option.disabled && option.reason ? `${option.name}（${option.reason}）` : [option.name, ...markWords(option.marks)].join(" · "));

/** The words typed, lower-cased: every one must be in a row's name, id or provider name for it to be shown. */
const wordsOf = (query) => query.trim().toLowerCase().split(/\s+/).filter(Boolean);
const found = (option, words) => words.every((word) => (option.terms ?? [option.name.toLowerCase()]).some((term) => term.includes(word)));

/** The rows shown for `words`: the leading ones and each group's, a group without any left out (only while searching). */
function visible(lead, groups, words) {
  if (words.length === 0) return { lead, groups };
  return {
    lead: lead.filter((o) => found(o, words)),
    groups: groups.map((g) => ({ ...g, options: g.options.filter((o) => found(o, words)) })).filter((g) => g.options.length > 0),
  };
}
const rowsOf = (shown) => [...shown.lead, ...shown.groups.flatMap((g) => g.options)];

/**
 * A model picker: a button showing the current model (its brand mark and name) that opens a searchable list of models
 * grouped by where they come from, each row with its brand mark, its name and its marks at the right (免费 / 需余额, then 看图,
 * 读 PDF, 思考, 工具: src/ui/ModelMarks.jsx; icons only, with a legend, while the list is narrow), the current one ticked. Under 480 px wide the list is a sheet at the bottom of the screen.
 * `disabled`: it cannot be opened (a disabled button); `busy`: its choice is being saved — it cannot be opened either,
 * but stays focusable.
 *
 * - `value`: the key of the current choice (aria-selected), or null; `current`: {name, brand} the button shows, or null
 *   (then `placeholder`).
 * - `lead`: rows before the groups; `groups`: [{id, label, options, empty}] — `empty` is what a group without rows says.
 *   A row: {key, name, brand, marks, terms (lower-case words it is found by), disabled, reason (why it cannot be chosen)}.
 * - `id`, `labelledBy` (the field's label: the button reads "label value"), `label` (its own name instead), `describedBy`.
 * - `status`: a line shown instead of the list (it is being read); `footer`: what stands under the list; `note`: one quiet
 *   line at its top (what choosing here means beyond this place).
 * - `onOpen()` when it opens; `onChange(key, row)` when another row is chosen.
 */
export function ModelSelect({
  id,
  labelledBy,
  label,
  describedBy,
  value = null,
  current = null,
  placeholder = "请选择模型",
  lead = [],
  groups = [],
  status = null,
  footer = null,
  note = null,
  disabled = false,
  busy = false,
  compact = false,
  onOpen,
  onChange,
}) {
  const base = useId();
  const listId = `${base}-list`;
  const valueId = `${base}-value`;
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(null);
  const searchRef = useRef(null);
  const { open, show: openList, close, triggerRef, popRef, popStyle, up } = usePopover({
    disabled,
    busy,
    onOpen,
    // The search field takes the focus.
    // The search field takes the focus; on a touch screen it does not (no keyboard over a short list: a tap on the field focuses it as usual) and the sheet itself does.
    focus: () => {
      const touch = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
      if (touch) (listRef.current ?? popRef.current)?.focus();
      else searchRef.current?.focus();
    },
    widthOf: (box) => (compact ? 380 : Math.max(box.width, 320)),
  });

  // Every row's id (by its place among all rows, never by its key, which may hold anything a name may).
  const all = [...lead, ...groups.flatMap((g) => g.options)];
  const optionId = new Map(all.map((o, i) => [o.key, `${base}-o${i}`]));
  // The columns some row can be marked in (a list without a price has no price column), and the abilities the list has (for its legend).
  const kindsInList = all.filter((o) => !o.disabled).flatMap((o) => markKinds(o.marks));
  const columns = COLUMNS.filter((col) => kindsInList.some((k) => (col === "price" ? k in PRICE_TEXT : k === col)));
  const words = wordsOf(query);
  const shown = visible(lead, groups, words);
  const rows = rowsOf(shown);
  const choosable = rows.filter((o) => !o.disabled);
  // Where the keyboard is: the row moved to, else the current choice, else the first row that can be chosen.
  const activeKey = choosable.some((o) => o.key === active) ? active : (choosable.find((o) => o.key === value) ?? choosable[0])?.key ?? null;

  const show = (typed = "") => {
    if (!openList()) return;
    setQuery(typed);
    setActive(null);
  };
  const choose = (key) => {
    const row = rows.find((o) => o.key === key);
    if (!row || row.disabled) return;
    close(true);
    if (key !== value) onChange?.(key, row);
  };

  // More rows below the list's edge: the cue (ui/moreBelow.js).
  const listRef = useRef(null);
  const more = useMoreBelow(listRef, open, status);
  // How the marks are drawn: by the list's own width, never the screen's (a sheet and a popover differ, a form's wide one does not).
  const marksMode = useMarksMode(listRef, `${open}${status}`);

  // The row the keyboard is on stays in view.
  useLayoutEffect(() => {
    if (open && activeKey !== null) document.getElementById(optionId.get(activeKey))?.scrollIntoView?.({ block: "nearest" });
  }, [open, activeKey]);

  const move = (step) => {
    const at = choosable.findIndex((o) => o.key === activeKey);
    const next = choosable[Math.max(0, Math.min(choosable.length - 1, at + step))];
    if (next) setActive(next.key);
  };
  const onSearchKey = (event) => {
    if (composing(event)) return;
    // (While what can be chosen is still being read, no row is shown, so none is moved to or chosen.)
    if (status && (event.key === "ArrowDown" || event.key === "ArrowUp" || isEnter(event))) {
      event.preventDefault();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      move(event.key === "ArrowDown" ? 1 : -1);
    } else if (isEnter(event)) {
      event.preventDefault();
      if (activeKey !== null) choose(activeKey);
    } else if (isEscape(event)) {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "Tab") {
      // The focus goes back to the button now, so the browser's own Tab moves on from there.
      close(true);
    }
  };
  const onSearch = (event) => {
    const next = event.target.value;
    setQuery(next);
    setActive(rowsOf(visible(lead, groups, wordsOf(next))).find((o) => !o.disabled)?.key ?? null);
  };
  const onTriggerKey = (event) => {
    if (open || disabled || busy) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      show();
    } else if (event.key.length === 1 && event.key !== " " && !event.ctrlKey && !event.metaKey && !event.altKey) {
      // Type-ahead is the search field: what is typed on the button starts the search.
      event.preventDefault();
      show(event.key);
    }
  };

  const row = (option) => {
    const selected = option.key === value;
    const marks = option.marks ?? [];
    return (
      <div
        key={option.key}
        id={optionId.get(option.key)}
        role="option"
        className={`model-option${option.key === activeKey ? " active" : ""}`}
        aria-selected={selected}
        aria-disabled={option.disabled || undefined}
        aria-label={optionLabel(option)}
        title={option.disabled ? option.reason ?? undefined : undefined}
        onMouseMove={() => !option.disabled && option.key !== active && setActive(option.key)}
        onClick={() => choose(option.key)}
      >
        <span className="model-check" aria-hidden="true">{selected && <Check size={14} />}</span>
        <ModelBrand brand={option.brand} />
        <span className="model-name" title={option.name}>{option.name}</span>
        {option.disabled ? (
          option.reason && <span className="model-reason" aria-hidden="true">{option.reason}</span>
        ) : (
          columns.length > 0 && <ModelMarks marks={marks} mode={marksMode} columns={columns} decorative />
        )}
      </div>
    );
  };

  const popover =
    open &&
    createPortal(
      <>
        <div className="model-scrim" aria-hidden="true" />
        <div ref={popRef} className={`model-pop${up ? " up" : ""}`} style={popStyle} tabIndex={-1}>
          {note && <p className="model-scope">{note}</p>}
          <div className="model-search">
            <Search size={15} aria-hidden="true" />
            <input
              ref={searchRef}
              role="combobox"
              aria-label="搜索模型"
              aria-expanded="true"
              aria-controls={status ? undefined : listId}
              aria-autocomplete="list"
              aria-activedescendant={!status && activeKey !== null ? optionId.get(activeKey) : undefined}
              placeholder="搜索模型…"
              value={query}
              maxLength={100}
              autoComplete="off"
              spellCheck={false}
              onChange={onSearch}
              onKeyDown={onSearchKey}
            />
          </div>
          {status ? (
            <p className="model-empty" role="status">{status}</p>
          ) : (
            <>
              {/* A press on a row or a group's name leaves the focus in the search field (one on the list's own scrollbar is let through). */}
              <div className="model-list" ref={listRef} tabIndex={-1} data-more={more || undefined} data-marks={marksMode} role="listbox" id={listId} aria-label="模型" onMouseDown={(e) => e.target !== e.currentTarget && e.preventDefault()}>
                {shown.lead.map(row)}
                {shown.groups.map((g) => (
                  <div key={g.id} role="group" aria-label={g.label} className="model-group">
                    <div className="model-group-label" aria-hidden="true">{g.label}</div>
                    {g.options.length > 0 ? (
                      g.options.map(row)
                    ) : (
                      <div role="option" aria-selected="false" aria-disabled="true" className="model-option model-note">{g.empty}</div>
                    )}
                  </div>
                ))}
              </div>
              {marksMode === "icons" && <MarksLegend kinds={kindsInList} />}
              {words.length > 0 && rows.length === 0 && <p className="model-empty" role="status">没有匹配的模型</p>}
            </>
          )}
          {footer && <div className="model-foot">{footer}</div>}
        </div>
      </>,
      document.body,
    );

  // (While its choice is being saved the button does nothing, aria-disabled, yet keeps the focus a disabled one would drop.)
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        id={id}
        className={`model-trigger${compact ? " compact" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open && !status ? listId : undefined}
        aria-labelledby={labelledBy ? `${labelledBy} ${valueId}` : undefined}
        aria-label={labelledBy ? undefined : label}
        aria-describedby={describedBy}
        aria-disabled={busy || undefined}
        aria-busy={busy || undefined}
        title={current?.name}
        disabled={disabled}
        onClick={() => (open ? close(false) : show())}
        onKeyDown={onTriggerKey}
      >
        {current && <ModelBrand brand={current.brand} size={compact ? 14 : 16} />}
        <span className="model-name" id={valueId}>{current?.name ?? placeholder}</span>
        <ChevronDown className="model-chevron" size={compact ? 13 : 16} aria-hidden="true" />
      </button>
      {popover}
    </>
  );
}
