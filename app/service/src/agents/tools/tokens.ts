/**
 * The one matcher of token-shaped strings (README "Agents and runs", Citations): what a reply's run numbers things with
 * (`〔m1〕`, `〔f2〕`), what is taken out of everything a reply offered tools says, and what is read for numbers someone
 * typed — the same here for all of it (agents/tools/refs.ts `TokenScanner`, `RunRefs.plant`; runtime/prompt.ts
 * `withoutMarkPlaced`, the group mark's pass). Between `〔` and `〕`: `m` or `f`, then one to six digits, spaces around
 * each, read once its inside is NFKC-normalised (full-width letters, digits and spaces are the ones they stand for) and
 * as the number it writes (leading zeros dropped: `〔f01〕` and `〔ｆ１〕` are `f1`). The brackets themselves are the
 * real `〔` `〕` only. Pure, and imports nothing, so the mark's pass and the numbers' can both use it.
 */

/** A token's brackets. */
export const OPEN = "〔";
export const CLOSE = "〕";

/** The longest inside a token-shaped string may have, as written: a letter, six digits, and spaces around them. */
export const INSIDE_MAX = 16;

/** The largest number a token holds (six digits): numbering stops there (refs.ts `RunRefs`). */
export const MAX_NUMBER = 999_999;

/** What a token-shaped string holds between its brackets, once normalised. */
const INSIDE = /^\s*([mf])\s*([0-9]{1,6})\s*$/i;
/** The same for a run offered the web tool, whose results are numbered `w` too (tools/web/tool.ts). */
const INSIDE_WEB = /^\s*([mfw])\s*([0-9]{1,6})\s*$/i;

/** How one begins — `〔`, `〔m`, `〔m1`, as `INSIDE` allows them — once normalised. */
const BEGINNING = /^〔\s*(?:[mf]\s*(?:[0-9]{1,6}\s*)?)?$/i;
const BEGINNING_WEB = /^〔\s*(?:[mfw]\s*(?:[0-9]{1,6}\s*)?)?$/i;

/** `m` or `f` and the number written, as a number: `m1`. */
const numbered = (letter: string, digits: string): string => `${letter.toLowerCase()}${Number(digits)}`;

/**
 * The number a token's inside `s` (what stands between its brackets) holds, `m1`, or null when it is no token's. `web`:
 * the run was offered the web tool, so `w` is a token's letter too (`〔w1〕`); for every other run it is not, and such a
 * string is text, as it always was.
 */
export function tokenRef(s: string, web = false): string | null {
  if (s.length > INSIDE_MAX) return null;
  const m = (web ? INSIDE_WEB : INSIDE).exec(s.normalize("NFKC"));
  return m ? numbered(m[1]!, m[2]!) : null;
}

/** Whether `s` (from a `〔`, no `〕` after it) is how a token-shaped string begins (`web`: as `tokenRef`). */
export const beginsToken = (s: string, web = false): boolean => s.length <= INSIDE_MAX + 1 && (web ? BEGINNING_WEB : BEGINNING).test(s.normalize("NFKC"));

/**
 * Where the end of `kept` begins that may still become a token (its length when none may), not before `from`, given
 * where each `〔` that may still open one stands in it (`opens`, ascending): the earliest from which each piece up to
 * the next open one, and the last to the end, begins one — a token inside another goes once it closes, so the outer one
 * may still close after it. `web`: as `tokenRef`.
 */
export function pendingStart(kept: readonly string[], opens: readonly number[], from = 0, web = false): number {
  let at = kept.length;
  for (let k = opens.length - 1; k >= 0 && opens[k]! >= from; k--) {
    const end = k === opens.length - 1 ? kept.length : opens[k + 1]!;
    if (end - opens[k]! > INSIDE_MAX + 1 || !beginsToken(kept.slice(opens[k]!, end).join(""), web)) break;
    at = opens[k]!;
  }
  return at;
}

/**
 * A file number as the file tool may be passed it, made one form (so that one file is one call, runtime/loop.ts): a
 * token as written (its real brackets, spaces around them) or its inside alone, read by the same matcher (`tokenRef`) —
 * `f1`, ` F1 `, `〔f1〕`, `〔 F1 〕`, `f01` and `〔ｆ１〕` are `f1`. Anything else is left as it is, so it names nothing:
 * what is no token in a text (`〔 f 0 1 〕`, `﹝f1﹞`) is no file number either.
 */
export function fileNumber(ref: string): string {
  const s = ref.trim();
  const inside = s.length >= OPEN.length + CLOSE.length && s.startsWith(OPEN) && s.endsWith(CLOSE) ? s.slice(OPEN.length, -CLOSE.length) : s;
  return tokenRef(inside) ?? s;
}
