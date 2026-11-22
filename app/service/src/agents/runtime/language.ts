/** The languages a reply's language is decided between (lane lang): what the message being answered is written in. */
export type ReplyLanguage = "zh" | "ja" | "en";

// Fenced code first (a closed fence, then an unclosed one only to the end of its own line: what stands before a fence, and
// every later line, is the writer's), then inline code.
const FENCED_RE = /```[\s\S]*?```/gu;
const OPEN_FENCE_RE = /```[^\n]*/gu;
const INLINE_CODE_RE = /`[^`\n]*`/gu;
// A URL ends at the first character a URL cannot hold (whitespace, a CJK character, a full-width mark).
const URL_RE = /(?:https?:\/\/|www\.)[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/giu;
// A handle as a mention reads one (agents/mentions.ts `MENTION`; principals/store.ts `HANDLE_PATTERN`: a-z0-9_, an Agent's
// `<owner>.<name part>`). Mirrored here, not imported (this folder imports no database module); tests/reply-language.test.ts compares the two sources. Text glued to it stays.
export const HANDLE_PATTERN_SOURCE = "(?<![A-Za-z0-9_])@([A-Za-z0-9_]+)(?:\\.([A-Za-z0-9_]+))?";
const HANDLE_RE = new RegExp(HANDLE_PATTERN_SOURCE, "gu");
const KANA_RE = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HAN_RE = /\p{Script=Han}/gu;
const LATIN_RE = /[A-Za-z]/gu;
// A letter that is none of Han, kana or basic ASCII Latin: Hangul, Cyrillic, Greek, Arabic, Thai, Latin with diacritics...
const OTHER_LETTER_RE = /(?![A-Za-z])(?!\p{Script=Han})(?!\p{Script=Hiragana})(?!\p{Script=Katakana})\p{L}/u;

const count = (text: string, re: RegExp): number => text.match(re)?.length ?? 0;

/**
 * The language a message is written in, read by its script alone (pure: no state, no model, no database). What is not the
 * writer's own words goes first: fenced and inline code, URLs, and @handles. Then: any hiragana or katakana is Japanese
 * (`ja`); else Chinese (`zh`) when there are at least two Han characters and the Han count times three is at least the
 * ASCII Latin letters; else `null` when any Han character is left (a Chinese or Japanese writer with English terms in it:
 * the abstract rule answers in their language, a sentence saying "English" would not); else English (`en`) when there are
 * at least three ASCII Latin letters and no letter of any other script (text is normalised to NFC first, so "e" + U+0301
 * is the é it looks like); else `null` — a URL, "OK", an emoji, digits, a single character say
 * nothing of a language, and neither does a message in a script the three do not cover.
 *
 * What it does not claim (a `null` keeps the abstract rule, which answers in the writer's language):
 *  - Korean, Russian, Greek, Arabic, Thai... and any Latin text with a diacritic (é, ü, ñ, ß) are never `en`. A Chinese or a
 *    Japanese message that quotes such a word stays `zh` / `ja` (those rules count only Han, kana and ASCII Latin).
 *  - A Latin-script language written without a diacritic ("Donde esta la estacion") reads `en` by script: the sentence for
 *    `en` leaves room for that (prompt.ts `REPLY_LANGUAGE_FOR`).
 *
 * Known limits, pinned by tests (measured rules, to be tuned on data, not on a guess):
 *  - A Japanese text with no kana at all (「東京都人口」) is only Han characters and reads `zh`.
 *  - One kana wins over any amount of Han: a Chinese message with a quoted 「の」 or a katakana kaomoji reads `ja`.
 *  - A Chinese message that is mostly English terms (「我想了解 Kubernetes deployment strategies」) reads `null` (the abstract line), never `en`.
 */
export function detectLanguage(text: string): ReplyLanguage | null {
  const own = text
    .normalize("NFC")
    .replace(FENCED_RE, " ")
    .replace(OPEN_FENCE_RE, " ")
    .replace(INLINE_CODE_RE, " ")
    .replace(URL_RE, " ")
    .replace(HANDLE_RE, " ");
  if (KANA_RE.test(own)) return "ja";
  const han = count(own, HAN_RE);
  const latin = count(own, LATIN_RE);
  if (han >= 2 && han * 3 >= latin) return "zh";
  if (han > 0) return null;
  if (latin >= 3 && !OTHER_LETTER_RE.test(own)) return "en";
  return null;
}
