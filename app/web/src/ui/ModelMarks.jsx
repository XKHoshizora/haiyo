import React, { memo } from "react";
import { AudioLines, Clapperboard, Eye, FileText, ImagePlus, Lightbulb, Video, Volume2, Wrench } from "../icons.js";

/** Money: text at every width, first, and about money, not an ability. */
export const PRICE_TEXT = { free: "免费", paid: "需余额" };
/** The longest of them: every price chip (and the hidden copy that keeps its column) is as wide as this, whichever word it holds (`data-sizer`, styles.css). */
const PRICE_SIZER = Object.values(PRICE_TEXT).reduce((a, b) => (b.length > a.length ? b : a));

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
 * `Icon`, `from(model)` (whether the model has it: true only when its own field is exactly true; `model`: an object of the
 * fields the service reports, any of them absent: an unknown is not shown),
 * `shown`. The wire carries `vision`, `reasoning` (a boolean here), `tools`, `pdf`, and — what the service's model catalogue
 * reports of a model it knows, each only as true — `reportedTools`, `audioIn`, `videoIn`, `imageOut`, `videoOut`, `audioOut`
 * (`REPORTED`: the names a list keeps of a model so that `from` can read them).
 *
 * 工具, THE ONE RULE (here and nowhere else; every list draws it through `abilityMarks`): `tools` is only what is stored of a
 * model — its owner's choice, or what its replies taught the service — and `reportedTools` is the catalogue's word beside it.
 * Stored true: yes. Stored false: never, whatever is reported. Nothing stored: what the catalogue reports. A site model always
 * has its boolean `tools` (the operator's word); a row of a provider's own list (同步模型) has only `reportedTools`.
 *
 * BEFORE ANY RESERVED ROW IS TURNED ON the design needs three more things (turning a row on is one line in code, but past four marks it is not
 * one line of design: nine abilities and the price take about 300 px of icons, or 490 px of words, leaving the name a few characters):
 * a name floor (a row keeps at least about half its width, or ten characters, for the name), a per-row cap with a "+N" chip (the full set stays in
 * the row's accessible name and title), and a word/icon threshold that depends on the number of columns instead of the fixed 519 px; the legend
 * may then wrap to two lines. The hidden column copies (`.model-gap`) are fine at three columns; replace them (a grid with shared column
 * tracks) before many rows are on.
 */
/** What the catalogue reports of a model: the fields a list carries along untouched for the table to read. The one list is the data layer's (data/reported.js). */
export { REPORTED, reportedOf } from "../data/reported.js";

export const ABILITIES = [
  { kind: "vision", text: "看图", title: "能看图片", Icon: Eye, from: (m) => m.vision === true, shown: true },
  { kind: "reasoning", text: "思考", title: "支持思考", Icon: Lightbulb, from: (m) => m.reasoning === true, shown: true },
  { kind: "tools", text: "工具", title: "会用工具（查聊天记录、看文件）", Icon: Wrench, from: (m) => m.tools === true || (typeof m.tools !== "boolean" && m.reportedTools === true), shown: true },
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

/** Whether two lists hold the same items in the same order (a row's marks and columns, for `memo`). */
const sameList = (a, b) => a === b || (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]));

/**
 * The marks of a model: `marks` (kinds: free, paid and the table's; any order). An ability mark holds its word AND its icon;
 * the stylesheet shows one of them: the word, or — inside a picker whose box is narrow (styles.css, the `modelpop`
 * container) — the icon, its name kept as aria-label and its title. `columns`: the kinds a list reserves room for, so the
 * marks of different rows line up: a column a model has no mark in holds a hidden copy of that column's own mark (so every
 * column is as wide as its own word, whatever the word, and nothing is a fixed width). `decorative`: hidden from the
 * accessibility tree (the row already reads them in its own name).
 */
export const ModelMarks = memo(
  function ModelMarks({ marks, columns = null, decorative = false, className = "" }) {
    const kinds = markKinds(marks);
    const cols = columns ? columnOrder().filter((c) => columns.includes(c)) : kinds.map((k) => (k in PRICE_TEXT ? "price" : k));
    if (cols.length === 0) return null;
    return (
      <span className={`model-marks${className ? ` ${className}` : ""}`} aria-hidden={decorative || undefined}>
        {cols.map((col) => {
          const kind = kinds.find((k) => (col === "price" ? k in PRICE_TEXT : k === col));
          if (col === "price") {
            return kind ? (
              <span key={col} data-col={col} data-sizer={PRICE_SIZER} className={`model-mark model-mark-${kind}`}>
                {PRICE_TEXT[kind]}
              </span>
            ) : (
              <span key={col} data-col={col} data-sizer={PRICE_SIZER} className="model-mark model-gap" aria-hidden="true" />
            );
          }
          const { text, title, Icon } = ABILITIES.find((a) => a.kind === (kind ?? col));
          const body = (
            <>
              <Icon className="model-mark-icon" size={13} aria-hidden="true" />
              <span className="model-mark-text" aria-hidden="true">{text}</span>
            </>
          );
          return kind ? (
            <span key={col} data-col={col} className="model-mark model-mark-ability" role="img" aria-label={text} title={title}>
              {body}
            </span>
          ) : (
            <span key={col} data-col={col} className="model-mark model-mark-ability model-gap" aria-hidden="true">
              {body}
            </span>
          );
        })}
      </span>
    );
  },
  (a, b) => a.decorative === b.decorative && a.className === b.className && sameList(a.marks, b.marks) && sameList(a.columns, b.columns),
);

/** What each icon means, shown (by the stylesheet) only where the marks are icons: the icons with their words (only `kinds`, in order). */
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
