// An Agent's message as one line of plain text, for the chat list's preview: its Markdown markers taken out, without
// a Markdown library (none runs on the page's main thread). Not a parser: a few passes over the first
// PREVIEW_SOURCE_CHARS characters of the text, line by line, so its cost has a fixed ceiling whatever the text is.
// What it cannot read as a marker it leaves as written; the message itself is rendered properly where it is opened.
import { withoutBidiControls } from "./markdownRules.js";

/** How much of the text is read, and the most the preview is (the list cuts the line to its width anyway). */
export const PREVIEW_SOURCE_CHARS = 600;
export const PREVIEW_CHARS = 120;

const FENCE = /^(`{3,}|~{3,})/;
/** What a line may start with before its own text: quote markers, a list marker, a task's box, a heading's hashes. */
const QUOTE = /^(?:>[ \t]?)+/;
const LIST = /^(?:[-+*]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/;
const HEADING = /^#{1,6}[ \t]+/;
const HEADING_END = /[ \t]+#+[ \t]*$/;
/** Lines that are only structure: a thematic break, a table's delimiter row, a setext underline, a link definition. */
const RULE = /^(?:[-*_][ \t]*){3,}$|^[|:\- \t]*-[|:\- \t]*$|^=+[ \t]*$/;
const DEFINITION = /^\[[^\]]*\]:[ \t]/;
/** `![alt](url)` and `[text](url)` → alt / text; `[text][ref]` → text; `<https://…>` → the address. */
const LINK = /!?\[([^[\]\n]*)\]\([^()\n]*\)/g;
const REFERENCE = /!?\[([^[\]\n]*)\]\[[^[\]\n]*\]/g;
const ANGLE = /<(https?:\/\/[^<>\s]*)>/g;
/** Runs of emphasis characters (`*`, `_`, `~~`), of backticks, `$$`, and a table's pipes. */
const EMPHASIS = /\*+|_+|~{2,}/g;
const CODE_AND_MATHS = /`+|\${2}/g;
const WORD = /[A-Za-z0-9]/;
const BLANK = /\s/;

/** One line outside code, without its markers. */
function withoutMarkers(line) {
  let text = line.trim();
  // (A quote in a list in a quote…: a few levels are enough for a preview.)
  for (let i = 0; i < 4; i += 1) text = text.replace(QUOTE, "").replace(LIST, "");
  if (RULE.test(text) || DEFINITION.test(text)) return "";
  text = text.replace(HEADING, "").replace(HEADING_END, "");
  text = text.replace(LINK, "$1").replace(REFERENCE, "$1").replace(ANGLE, "$1").replace(CODE_AND_MATHS, "");
  // Emphasis characters go, except where they are not emphasis: inside a word (`get_user_name`, `2*3`) or alone
  // between spaces (`a * b`).
  text = text.replace(EMPHASIS, (run, at) => {
    const before = text[at - 1] ?? " ";
    const after = text[at + run.length] ?? " ";
    return (WORD.test(before) && WORD.test(after)) || (BLANK.test(before) && BLANK.test(after) && at > 0) ? run : "";
  });
  return text.replace(/\|/g, " ");
}

/**
 * The preview of an Agent's text: headings', quotes' and lists' markers, emphasis and code markers and link syntax taken
 * out (its citations are beside its text, never in it: nothing of them is here); a code fence is its first line of code (or nothing); everything on one line, at most PREVIEW_CHARS
 * characters. A text that is nothing but markers is shown as it was written (on one line).
 */
export function previewOfMarkdown(text) {
  if (typeof text !== "string") return "";
  const source = withoutBidiControls(text.slice(0, PREVIEW_SOURCE_CHARS));
  const parts = [];
  /** The open fence's character, or null; whether a line of its code has been taken. */
  let fence = null;
  let taken = false;
  for (const raw of source.split("\n")) {
    const line = raw.trim().replace(QUOTE, "").trim();
    const marker = FENCE.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence) fence = null;
      else if (!taken && line) {
        parts.push(line);
        taken = true;
      }
    } else if (marker) {
      fence = marker[0];
      taken = false;
    } else {
      parts.push(withoutMarkers(raw));
    }
  }
  const oneLine = (value) => Array.from(value.replace(/\s+/g, " ").trim()).slice(0, PREVIEW_CHARS).join("");
  return oneLine(parts.join(" ")) || oneLine(source);
}
