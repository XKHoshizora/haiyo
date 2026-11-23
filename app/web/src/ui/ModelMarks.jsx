import React, { useLayoutEffect, useState } from "react";
import { AudioLines, Clapperboard, Eye, FileText, ImagePlus, Lightbulb, Video, Volume2, Wrench } from "../icons.js";

/** Money: text at every width, first, and about money, not an ability. */
export const PRICE_TEXT = { free: "免费", paid: "需余额" };

/**
 * The marks of a model, one vocabulary wherever a model is listed (the picker, the provider page): money first, then what
 * the model can do, each with an icon and a short word, in the order of this table.
 *
 * THE RULE: a mark is shown only when the product actually does that with the model. A mark must never promise what the
 * product does not do, so every kind the product may one day pass to or from a model is reserved here now (its label, its
 * accessible name and its icon fixed) with `shown: false`: never rendered, never in the legend. When the product does it,
 * the row's `shown` becomes true (and the service carries the field `from` reads); nothing else changes.
 *
 * A row: `kind` (its key and column), `text` (the short word, also its accessible name), `title` (the whole sentence),
 * `Icon`, `from(model)` (whether the model has it; `model`: an object of the fields the service reports, any of them absent),
 * `shown`. Today the wire carries `vision`, `reasoning` (a boolean here), `tools` and `pdf`; `audioIn`, `videoIn`, `imageOut`,
 * `videoOut` and `audioOut` are the names the service will carry.
 */
export const ABILITIES = [
  { kind: "vision", text: "看图", title: "能看图片", Icon: Eye, from: (m) => m.vision === true, shown: true },
  { kind: "reasoning", text: "思考", title: "支持思考", Icon: Lightbulb, from: (m) => m.reasoning === true, shown: true },
  { kind: "tools", text: "工具", title: "会用工具（查聊天记录、看文件）", Icon: Wrench, from: (m) => m.tools !== false, shown: true },
  // Reserved (the product passes no such content to or from a model yet; a PDF goes as it is, but the owner wants no chip for it).
  { kind: "audioIn", text: "听语音", title: "能听语音", Icon: AudioLines, from: (m) => m.audioIn === true, shown: false },
  { kind: "videoIn", text: "看视频", title: "能看视频", Icon: Video, from: (m) => m.videoIn === true, shown: false },
  { kind: "pdf", text: "读 PDF", title: "能直接读 PDF", Icon: FileText, from: (m) => m.pdf === true, shown: false },
  { kind: "imageOut", text: "画图", title: "能画图", Icon: ImagePlus, from: (m) => m.imageOut === true, shown: false },
  { kind: "videoOut", text: "生成视频", title: "能生成视频", Icon: Clapperboard, from: (m) => m.videoOut === true, shown: false },
  { kind: "audioOut", text: "生成语音", title: "能生成语音", Icon: Volume2, from: (m) => m.audioOut === true, shown: false },
];
/** The rows that are shown now (read at the time of use, so one flipped on is drawn at once). */
export const shownAbilities = () => ABILITIES.filter((a) => a.shown);
/** The columns in order: the money's, then each shown ability's. */
export const columnOrder = () => ["price", ...shownAbilities().map((a) => a.kind)];

/** The shown ability kinds `model` has (an object of the service's fields, any absent), in table order. */
export const abilityMarks = (model) => shownAbilities().filter((a) => a.from(model)).map((a) => a.kind);

/** The kinds in `marks` in column order (a row's marks, or what a legend must explain); a kind not shown is dropped. */
export const markKinds = (marks = []) => columnOrder().flatMap((col) => (col === "price" ? marks.filter((m) => m in PRICE_TEXT).slice(0, 1) : marks.includes(col) ? [col] : []));
/** The words of `marks`, in order. */
export const markWords = (marks) => markKinds(marks).map((kind) => PRICE_TEXT[kind] ?? ABILITIES.find((a) => a.kind === kind).text);

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
  const cols = columns ? columnOrder().filter((c) => columns.includes(c)) : kinds.map((k) => (k in PRICE_TEXT ? "price" : k));
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
  const shown = shownAbilities().filter((a) => kinds.includes(a.kind));
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
