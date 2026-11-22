/** The languages a reply's language is decided between (lane lang): what the message being answered is written in. */
export type ReplyLanguage = "zh" | "ja" | "en";

const URL_RE = /(?:https?:\/\/|www\.)\S+/giu;
const HANDLE_RE = /@[\p{L}\p{N}_.-]+/gu;
const FENCED_RE = /```[\s\S]*?(?:```|$)/gu;
const INLINE_CODE_RE = /`[^`\n]*`/gu;
const KANA_RE = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HAN_RE = /\p{Script=Han}/gu;
const LATIN_RE = /\p{Script=Latin}/gu;

const count = (text: string, re: RegExp): number => text.match(re)?.length ?? 0;

/**
 * The language a message is written in, read by its script alone (pure: no state, no model, no database). What is not the
 * writer's own words goes first: fenced and inline code, URLs, and @handles. Then: any hiragana or katakana is Japanese
 * (`ja`); else Chinese (`zh`) when there are at least two Han characters and the Han count times three is at least the
 * Latin letters; else English (`en`) when there are at least three Latin letters and at least six times as many as Han
 * characters; else `null` — a URL, "OK", an emoji, digits, a single character say nothing of a language.
 *
 * Known limit: a Japanese text with no kana at all (「東京都人口」) is only Han characters and reads as `zh`. A model told
 * "Chinese" for it answers in a language the writer can read; no script rule can tell the two apart.
 */
export function detectLanguage(text: string): ReplyLanguage | null {
  const own = text.replace(FENCED_RE, " ").replace(INLINE_CODE_RE, " ").replace(URL_RE, " ").replace(HANDLE_RE, " ");
  if (KANA_RE.test(own)) return "ja";
  const han = count(own, HAN_RE);
  const latin = count(own, LATIN_RE);
  if (han >= 2 && han * 3 >= latin) return "zh";
  if (latin >= 3 && latin >= han * 6) return "en";
  return null;
}
