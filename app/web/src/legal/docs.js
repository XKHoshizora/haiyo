// The three public pages (the terms, the privacy policy, the contact page): where they are, what the app's own screens call them,
// and which of their three languages a visit opens in. Their texts are ./texts/<doc>.<lang>.md, shown by LegalPage.jsx.

export const LEGAL_DOCS = ["terms", "privacy", "contact"];
export const LEGAL_PATHS = { terms: "/terms", privacy: "/privacy", contact: "/contact" };
/** Their names on the app's own screens (sign-in, registration, settings), which are in Chinese. */
export const LEGAL_LINK_NAMES = { terms: "服务条款", privacy: "隐私政策", contact: "联系我们" };
/** The languages they are written in, in the order the switch shows them. */
export const LEGAL_LANGS = ["zh", "en", "ja"];

/**
 * The language a visit opens in: `?lang=` when it names one of the three (a link made for one language), else the first of the
 * browser's languages that is Chinese or Japanese, else English (also for every other language: the one most readers share).
 */
export function pickLanguage(search, languages) {
  const asked = new URLSearchParams(search ?? "").get("lang");
  if (LEGAL_LANGS.includes(asked)) return asked;
  for (const tag of languages ?? []) {
    const base = String(tag).toLowerCase().split("-")[0];
    if (base === "zh" || base === "ja" || base === "en") return base;
  }
  return "en";
}
