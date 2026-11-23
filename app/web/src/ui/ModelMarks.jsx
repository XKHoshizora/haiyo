import React, { useLayoutEffect, useState } from "react";
import { Eye, Lightbulb, Wrench } from "../icons.js";

/**
 * The marks of a model, one vocabulary wherever a model is listed (the picker, the provider page): money first as text
 * (免费 / 需余额: they are about money, not an ability, and stay words at every width), then what the model can do, each
 * with an icon and a short word, in the order of the table below. Only what the service reports for a model is marked; what
 * a model lacks shows nothing; a mark must never promise what the product does not do.
 *
 * The abilities are DATA: one row each — `kind` (its key and column), `text` (the short word, also its accessible name),
 * `title` (the whole sentence), `Icon`, `from(model)` (whether a model has it; `model`: {vision, reasoning, tools}, booleans
 * as the service reports them). A new mark is one more row, nothing else changes:
 *   // { kind: "voice", text: "语音", title: "能听语音", Icon: Mic, from: (m) => m.audio === true },
 *   // { kind: "video", text: "看视频", title: "能看视频", Icon: Video, from: (m) => m.video === true },
 * (not added: the product passes no audio or video to a model).
 */
export const PRICE_TEXT = { free: "免费", paid: "需余额" };
export const ABILITIES = [
  { kind: "vision", text: "看图", title: "能看图片", Icon: Eye, from: (m) => m.vision === true },
  { kind: "thinking", text: "思考", title: "支持思考", Icon: Lightbulb, from: (m) => m.reasoning === true },
  { kind: "tools", text: "工具", title: "会用工具（查聊天记录、看文件）", Icon: Wrench, from: (m) => m.tools !== false },
];
/** Every mark's short word. */
export const MARK_TEXT = { ...PRICE_TEXT, ...Object.fromEntries(ABILITIES.map((a) => [a.kind, a.text])) };
/** The columns in order: the money's, then each ability's. */
export const COLUMNS = ["price", ...ABILITIES.map((a) => a.kind)];

/** The ability kinds `model` has ({vision, reasoning, tools}: booleans), in table order. */
export const abilityMarks = (model) => ABILITIES.filter((a) => a.from(model)).map((a) => a.kind);

/** The kinds in `marks` in column order (a row's marks, or what a legend must explain). */
export const markKinds = (marks = []) => COLUMNS.flatMap((col) => (col === "price" ? marks.filter((m) => m in PRICE_TEXT).slice(0, 1) : marks.includes(col) ? [col] : []));
/** The words of `marks`, in order. */
export const markWords = (marks) => markKinds(marks).map((kind) => MARK_TEXT[kind]);

/** A list narrower than this (px) shows the abilities as icons only; wider, icon and word. Not known yet (0, no layout): the words. */
export const ICONS_BELOW = 520;
export const marksModeFor = (width) => (width > 0 && width < ICONS_BELOW ? "icons" : "text");

/** "text" or "icons" for the width of the element `ref` points at (`key` changes when it is drawn again); follows its resizing. */
export function useMarksMode(ref, key) {
  const [mode, setMode] = useState("text");
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => setMode(marksModeFor(el.clientWidth));
    measure();
    const resized = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    resized?.observe(el);
    return () => resized?.disconnect();
  }, [key]);
  return mode;
}

/**
 * The marks of a model: `marks` (kinds: free, paid and the table's; any order). `mode`: "text" (icon and word)
 * or "icons" (the icon only, its name kept as aria-label and its title). `columns`: the kinds a list reserves room for,
 * so the marks of different rows line up (an empty column is invisible, never a grey mark). `decorative`: hidden from the
 * accessibility tree (the row already reads them in its own name).
 */
export function ModelMarks({ marks, mode = "text", columns = null, decorative = false, className = "" }) {
  const kinds = markKinds(marks);
  const cols = columns ? COLUMNS.filter((c) => columns.includes(c)) : kinds.map((k) => (k in PRICE_TEXT ? "price" : k));
  if (cols.length === 0) return null;
  return (
    <span className={`model-marks${className ? ` ${className}` : ""}`} data-mode={mode} aria-hidden={decorative || undefined}>
      {cols.map((col) => {
        const kind = kinds.find((k) => (col === "price" ? k in PRICE_TEXT : k === col));
        if (!kind) return <span key={col} data-col={col} className="model-gap" />;
        if (col === "price") {
          return (
            <span key={col} data-col={col} className={`model-mark model-mark-${kind}`}>
              {PRICE_TEXT[kind]}
            </span>
          );
        }
        const { text, title, Icon } = ABILITIES.find((a) => a.kind === kind);
        return (
          <span key={col} data-col={col} className="model-mark model-mark-ability" role="img" aria-label={text} title={title}>
            <Icon size={13} aria-hidden="true" />
            <span className="model-mark-text" aria-hidden="true">{text}</span>
          </span>
        );
      })}
    </span>
  );
}

/** What each icon means, for a place where the marks are icons only: the icons with their words (only `kinds`, in order). */
export function MarksLegend({ kinds }) {
  const shown = ABILITIES.filter((a) => kinds.includes(a.kind));
  if (shown.length === 0) return null;
  return (
    <p className="model-legend" aria-hidden="true">
      {shown.map(({ kind, text, Icon }) => (
        <span key={kind}>
          <Icon size={13} aria-hidden="true" />
          {text}
        </span>
      ))}
    </p>
  );
}
