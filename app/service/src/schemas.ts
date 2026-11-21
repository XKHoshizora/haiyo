import { z } from "zod";

/** A UUID in canonical (lower-case) form: Postgres returns lower-case, so everything compared in JS must be too. */
export const uuidParam = z.uuid().transform((s) => s.toLowerCase());

/**
 * A decimal integer in [1, max] given as a string (path or query): no sign, leading zero, fraction,
 * exponent or whitespace, and never beyond Number.MAX_SAFE_INTEGER.
 */
export const positiveIntString = (max: number = Number.MAX_SAFE_INTEGER) =>
  z
    .string()
    .regex(/^[1-9][0-9]{0,15}$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(max));

/** The same bounds for a JSON number. */
export const positiveInt = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

/** Counts Unicode code points, so an emoji is one character. */
export function characters(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

const LONE_SURROGATE = /\p{Cs}/u;

/**
 * Trimmed user text of `min`–`max` characters. Lone surrogates and NUL are always refused (Postgres jsonb
 * cannot store them); `singleLine` text also refuses every other control character, line breaks included.
 */
export function userText(min: number, max: number, { singleLine = false }: { singleLine?: boolean } = {}) {
  return z
    .string()
    .trim()
    .refine((s) => !LONE_SURROGATE.test(s), "lone surrogate")
    .refine((s) => (singleLine ? !/\p{Cc}/u.test(s) : !s.includes("\u0000")), "control character")
    .refine((s) => {
      const n = characters(s);
      return n >= min && n <= max;
    }, `must be ${min}-${max} characters`);
}

/**
 * Format characters (`\p{Cf}`: bidi overrides and isolates, zero-width spaces, the BOM, the soft hyphen…)
 * except the ones that carry meaning: the zero-width non-joiner and joiner (U+200C, U+200D: emoji sequences
 * such as 👩‍💻, Persian and Indic text) and the emoji tag characters (U+E0020–U+E007F: subdivision flags).
 */
const STRIPPED_FORMAT_CHARS = /(?![\u200C\u200D\u{E0020}-\u{E007F}])\p{Cf}/gu;

/**
 * Something visible: a character that is not white space, not a control character, and not one that shows nothing
 * on its own — the default-ignorable code points (format characters, joiners, variation selectors, tag characters,
 * Hangul fillers, the combining grapheme joiner, …) and the Braille blank U+2800. Emoji sequences, keycaps, flags
 * and right-to-left text all have a visible base character.
 */
const VISIBLE_CHARACTER = /[^\s\p{Cc}\p{Default_Ignorable_Code_Point}\u{2800}]/u;

/**
 * A name others see: format characters removed except U+200C, U+200D and the tag characters (the rest could
 * reorder or hide what others see), then trimmed; 1–`max` characters (code points), with a visible character
 * (VISIBLE_CHARACTER); one line — no control characters, no line or paragraph separators; no lone surrogates.
 */
function visibleName(max: number) {
  return z
    .string()
    .transform((s) => s.replace(STRIPPED_FORMAT_CHARS, ""))
    .pipe(
      userText(1, max, { singleLine: true })
        .refine((s) => !/[\p{Zl}\p{Zp}]/u.test(s), "one line")
        .refine((s) => VISIBLE_CHARACTER.test(s), "nothing visible"),
    );
}

/** The most characters (code points) a person's display name has, and an Agent's name. */
export const DISPLAY_NAME_MAX = 40;
export const AGENT_NAME_MAX = 20;

/** A person's display name, on registration and `PATCH /api/me` alike: `visibleName`, 1–`DISPLAY_NAME_MAX`. */
export const displayName = visibleName(DISPLAY_NAME_MAX);

/** An Agent's name, on creation and editing: the display-name rule (`visibleName`), 1–`AGENT_NAME_MAX`. */
export const agentName = visibleName(AGENT_NAME_MAX);

/** A group's title, on creation and renaming: the display-name rule (`visibleName`), 1–60. */
export const groupTitle = visibleName(60);

/**
 * Bidi overrides and isolates (U+202A–U+202E, U+2066–U+2069): in a message they reorder what others see
 * ("safe\u202Eelif.exe" shows as "safeexe.file"), so they are removed. They have no use in plain chat text.
 */
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/g;

/** Control characters other than tab, line feed and carriage return: refused in message text and captions. */
const CONTROLS_BUT_LINE_BREAKS = /(?![\t\n\r])\p{Cc}/u;

/**
 * Message text or a caption: stored as sent except that bidi overrides and isolates are removed, then
 * `userText(min, max)` (trimmed; line breaks allowed; no lone surrogates; length counted after removal); no control
 * character other than tab, line feed and carriage return (NUL included).
 */
export function messageText(min: number, max: number) {
  return z
    .string()
    .transform((s) => s.replace(BIDI_CONTROLS, ""))
    .pipe(userText(min, max).refine((s) => !CONTROLS_BUT_LINE_BREAKS.test(s), "control character"));
}

/** What `messageText` refuses or removes, as one pattern to remove every occurrence: built from those rules' own patterns. */
const UNSAFE_IN_TEXT = new RegExp(`${CONTROLS_BUT_LINE_BREAKS.source}|${LONE_SURROGATE.source}|${BIDI_CONTROLS.source}`, "gu");

/**
 * A model's output under the rules of message text: what `messageText` would refuse is removed instead (nobody can
 * send the output again) — bidi overrides and isolates, control characters other than tab and line breaks, lone
 * surrogates. Not trimmed: `cleanModelText` is, for storing; streamed pieces are not.
 */
export function stripUnsafeText(s: string): string {
  return s.replace(UNSAFE_IN_TEXT, "");
}

/** `stripUnsafeText`, then trimmed: an Agent's text as it is stored (the length limit is the caller's). */
export function cleanModelText(s: string): string {
  return stripUnsafeText(s).trim();
}

/** A search term: what `messageText` would store of it (so it matches stored text), one line, 1–100 characters. */
export const searchTerm = z
  .string()
  .transform((s) => s.replace(BIDI_CONTROLS, ""))
  .pipe(userText(1, 100, { singleLine: true }));

/** Whether text shows anything: it has a VISIBLE_CHARACTER (not white space, a control or a character that shows nothing). */
export function hasVisibleText(s: string): boolean {
  return VISIBLE_CHARACTER.test(s);
}
