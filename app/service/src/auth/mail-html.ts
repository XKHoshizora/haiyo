import { PRODUCT_NAME } from "../brand.ts";

/**
 * The HTML version of the mails. Mail clients are restrictive, so the document is a centred 480px column of nested tables with
 * inline styles only: no style block, script, remote image or web font, and it reads with images off. Colours are mid-tone or
 * explicit on both ground and text, so a client that inverts for dark mode keeps every line readable.
 */

/** The one escape helper: text and attribute values alike (it covers the quotes). */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** The value for an `href` (already escaped), or undefined unless the address is an http(s) URL: nothing else is ever linked. */
export function safeHref(url: string): string | undefined {
  // No whitespace or control character anywhere (URL parsing would silently strip some of them), then a real parse.
  if (/[\s\p{Cc}]/u.test(url)) return undefined;
  // The URL parser forgives "https:///path" (host "path"): the text itself must put a host right after the two slashes.
  if (!/^https?:\/\/[^/?#]/i.test(url)) return undefined;
  try {
    const u = new URL(url);
    if ((u.protocol !== "http:" && u.protocol !== "https:") || u.hostname === "") return undefined;
  } catch {
    return undefined;
  }
  return escapeHtml(url);
}

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',Roboto,Helvetica,Arial,sans-serif";
const ACCENT = "#5b4fd6";
const INK = "#1f2430";
const SOFT = "#5f6577";
const PAGE = "#f3f3f8";
const CARD = "#ffffff";
const RULE = "#dcdce6";

export interface MailLayout {
  /** The subject, which is also the document's title. */
  title: string;
  /** The hidden line mail clients show after the subject in the inbox: the first sentence. */
  preheader: string;
  heading: string;
  /** One or two short sentences, plain text. */
  paragraphs: string[];
  /** The one button; left out (no anchor at all) when its address is not an http(s) URL. */
  button?: { label: string; url: string };
  /** More links, each a sentence that leads to it and the address, shown as a link whose text is the address. */
  links?: { lead: string; url: string }[];
  /** The address a person can copy when the button does not open: shown as plain visible text. */
  fallbackUrl?: string;
  /** The small grey footer: how long the link works (if it says), then the copy-the-address help, then the "not you? ignore this mail" line. */
  lifetime?: string;
  notYou: string;
}

const e = escapeHtml;
/** After the preheader: the usual run of zero-width non-joiner + non-breaking space pairs, so a client fills the inbox preview with it and not with the body. */
const PREHEADER_PAD = "&zwnj;&nbsp;".repeat(100);

function button(label: string, url: string): string {
  const href = safeHref(url);
  if (href === undefined) return "";
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 8px"><tr>` +
    `<td bgcolor="${ACCENT}" style="background-color:${ACCENT};padding:12px 28px;border-radius:8px">` +
    `<a href="${href}" style="color:#ffffff;font-family:${FONT};font-size:16px;font-weight:600;line-height:20px;text-decoration:none">${e(label)}</a>` +
    `</td></tr></table>`
  );
}

function link(lead: string, url: string): string {
  const href = safeHref(url);
  const shown = e(url);
  const target = href === undefined ? shown : `<a href="${href}" style="color:${ACCENT};text-decoration:underline;word-break:break-all">${shown}</a>`;
  return `<p style="margin:16px 0 0;font-size:15px;line-height:24px;color:${INK}">${e(lead)}<br>${target}</p>`;
}

export function renderMailHtml(m: MailLayout): string {
  const paragraphs = m.paragraphs
    .map((p) => `<p style="margin:0 0 12px;font-size:16px;line-height:26px;color:${INK}">${e(p)}</p>`)
    .join("");
  const fallback =
    m.fallbackUrl === undefined
      ? ""
      : `<p style="margin:0 0 8px;font-size:13px;line-height:20px;color:${SOFT}">打不开按钮？把下面的地址复制到浏览器：<br>` +
        `<span style="word-break:break-all;color:${SOFT}">${e(m.fallbackUrl)}</span></p>`;
  const small = (line: string): string => `<p style="margin:0 0 8px;font-size:13px;line-height:20px;color:${SOFT}">${e(line)}</p>`;
  return (
    `<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<meta name="color-scheme" content="light dark">\n<meta name="supported-color-schemes" content="light dark">\n` +
    `<title>${e(m.title)}</title>\n</head>\n` +
    `<body style="margin:0;padding:0;background-color:${PAGE};font-family:${FONT}">\n` +
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;mso-hide:all">${e(m.preheader)}${PREHEADER_PAD}</div>\n` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PAGE}" style="background-color:${PAGE}"><tr><td align="center" style="padding:24px 12px">\n` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${CARD}" style="max-width:480px;margin:0 auto;background-color:${CARD};border:1px solid ${RULE};border-radius:12px"><tr><td style="padding:28px 28px 8px;font-family:${FONT}">\n` +
    `<p style="margin:0 0 20px;font-size:20px;line-height:24px;font-weight:700;color:${ACCENT}">${e(PRODUCT_NAME)}</p>\n` +
    `<h1 style="margin:0 0 12px;font-size:22px;line-height:30px;font-weight:700;color:${INK}">${e(m.heading)}</h1>\n` +
    `${paragraphs}\n` +
    `${m.button ? button(m.button.label, m.button.url) : ""}\n` +
    `${(m.links ?? []).map((l) => link(l.lead, l.url)).join("")}\n` +
    `</td></tr><tr><td style="padding:16px 28px 24px;font-family:${FONT}">\n` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:1px solid ${RULE};padding-top:16px;font-family:${FONT}">\n` +
    `${m.lifetime === undefined ? "" : small(m.lifetime)}${fallback}${small(m.notYou)}\n` +
    `</td></tr></table>\n</td></tr></table>\n</td></tr></table>\n</body>\n</html>\n`
  );
}
