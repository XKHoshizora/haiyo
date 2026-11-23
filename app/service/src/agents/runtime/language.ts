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

// What tells a piece of text (a run without whitespace, the marks at its two ends dropped) that is not prose: a digit, or
// a mark inside it that prose does not put inside a word (_ @ . / \ = :), or two steps from a small letter to a capital.
const NOT_PROSE_RE = /[0-9_@./\\=:]|[a-z][A-Z].*[a-z][A-Z]/u;
// `#fff`, `#ffccee`: a colour (its `#` is a mark at the edge, so it is asked of the piece as written).
const HEX_COLOUR_RE = /^#[0-9A-Fa-f]+$/u;
// Bytes are written in pairs and in one case: FF, ab, DEADBEEF, cafe.
const HEX_WORD_RE = /^(?:[A-F]{2})+$|^(?:[a-f]{2})+$/u;
const ENGLISH_MIN_LETTERS = 3;

const count = (text: string, re: RegExp): number => text.match(re)?.length ?? 0;

const isAsciiLetterOrDigit = (code: number): boolean => (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);

/** `piece` without the marks at its two ends (everything that is no ASCII letter or digit): one pass from each end. */
function withoutEdgeMarks(piece: string): string {
  let from = 0;
  let to = piece.length;
  while (from < to && !isAsciiLetterOrDigit(piece.charCodeAt(from))) from += 1;
  while (to > from && !isAsciiLetterOrDigit(piece.charCodeAt(to - 1))) to -= 1;
  return piece.slice(from, to);
}

/**
 * Whether `own` (ASCII Latin text, already without code, URLs and handles) holds real words — the least that lets a
 * message be called English. The definition, narrow on purpose:
 *  1. The text is cut at whitespace into pieces; the marks at the two ends of a piece are dropped (`"word,"`, `_word_`,
 *     `Note:`).
 *  2. A piece is not prose, and gives no word, when
 *     - it holds a digit (`12345`, `E6`, `0xFF`, `v2.10`, `3pm`, `gr8`, most base64);
 *     - it holds, inside, one of `_ @ . / \ = :` (`user_id`, `bob@example.com`, `readme.md`, `com.example.app`,
 *       `src/app/main.ts`, `C:\Users\bob`, `key=value`, `de:ad:be:ef` — and, the cost, `e.g.`, `yes/no`, `wait...what`);
 *     - it has two steps from a small letter to a capital (`getUserProfileById`, longer base64 without a digit; one
 *       such step is a name: `TypeScript`, `iPhone` — and `getUser`);
 *     - it is, as written, `#` and hex digits (`#fff`).
 *  3. The runs of letters in every other piece are its words (`don't` → don, t; `well-known` → well, known).
 *  4. A word of a–f alone, of an even length and in one case (`FF`, `ab`, `cafe`, `DEADBEEF`) is hex-looking: it may be a
 *     word or bytes. `Add`, `bad`, `Dead` are not (bytes are not written so).
 * There are real words when at least one word of two or more letters is not hex-looking, and the words together have at
 * least three letters (the measure before this rule: `yes` is, `OK` and `hi` are not). Hex-looking words count toward
 * the three once a real one stands beside them (`be ok`, `the cafe was bad`); alone they do not (`FF AB CD`,
 * `deadbeef cafe babe`, and so `dead beef`: more often bytes than a sentence, and a wrong "no language" only falls back
 * to the abstract rule, while a wrong "English" tells the model something false).
 *
 * Known limits, pinned by tests. What still reads as words, because by script it is the same as words: a kebab
 * identifier (`kebab-case-id`, like `well-known`), a key of capitals or base32 (`AKIAIOSFODNN`, like `HELLO`), short
 * base64 with no digit and fewer than two small-to-capital steps (`QUJD`, `YWJj`), an identifier with one inner capital
 * (`getUser`), pinyin (`ni hao`). And what no longer does, though a person wrote it: a short message whose words stand
 * in a piece that is not prose, or are single letters (`at 3pm` has two letters left; `I'm` is I and m; `gr8`).
 */
function hasEnglishWords(own: string): boolean {
  let letters = 0;
  let real = false;
  for (const raw of own.split(/\s+/u)) {
    if (HEX_COLOUR_RE.test(raw)) continue;
    const piece = withoutEdgeMarks(raw);
    if (NOT_PROSE_RE.test(piece)) continue;
    for (const word of piece.match(/[A-Za-z]+/gu) ?? []) {
      letters += word.length;
      if (word.length >= 2 && !HEX_WORD_RE.test(word)) real = true;
    }
  }
  return real && letters >= ENGLISH_MIN_LETTERS;
}

/**
 * The language a message is written in, read by its script alone (pure: no state, no model, no database). What is not the
 * writer's own words goes first: fenced and inline code, URLs, and @handles. Then: any hiragana or katakana is Japanese
 * (`ja`); else Chinese (`zh`) when there are at least two Han characters and the Han count times three is at least the
 * ASCII Latin letters; else `null` when any Han character is left (a Chinese or Japanese writer with English terms in it:
 * the abstract rule answers in their language, a sentence saying "English" would not); else English (`en`) when there are
 * real words in ASCII Latin letters (`hasEnglishWords`, which states exactly what counts and what slips through: at
 * least three letters in words, one of them of two letters or more and not hex-looking, no word taken from a piece with
 * a digit or an inner `_ @ . / \ = :`) and no letter of any other script (text is normalised to NFC first, so "e" +
 * U+0301 is the é it looks like); else `null` — a URL, "OK", an emoji, digits, hex bytes ("E6 88 91"), an e-mail address,
 * a file name, base64 that holds a digit, a single character say nothing of a language, and neither does a message in a
 * script the three do not cover.
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
  if (hasEnglishWords(own) && !OTHER_LETTER_RE.test(own)) return "en";
  return null;
}
