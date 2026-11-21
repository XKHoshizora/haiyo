// An Agent's stored mentions and citations in its rendered Markdown. The Markdown worker gets the text, not the mentions
// or the citations: each mention's range is put between marks — U+FDD0 before it, then U+FDD2 + its index (which of the
// message's mentions it is), and U+FDD1 after it — and each citation is a mark where it stands — U+FDE6, then U+FDD2 + its
// index (which of the message's citations it is) —, all Unicode noncharacters, so the parser keeps each where it is, and
// the tree's texts carry the marks to the main thread (Markdown.jsx), which shows the marked part as a tag meaning that
// mention's id, and a citation's mark as its link. Any such character already in a text is taken out before
// (AgentText.jsx; fix round 1, M-1): the only marks the worker sees are these. A mention inside an address — right after
// `/`, in a URL or a link's target — is not marked (the service stores none there since fix round 1, I-3; an older
// message may hold one), nor a citation there (AgentText.jsx leaves those out), so no mark ever lands in a link; the
// worker drops any from an address all the same (markdownPipeline.js `link`). Inside code and maths a mark is only taken
// out: a mention there is plain text, and a citation there is not shown.
import { outsideAddresses } from "../data/mentions.js";

const OPEN = String.fromCharCode(0xfdd0);
const CLOSE = String.fromCharCode(0xfdd1);
/** The first index mark: U+FDD2 + the mention's (or citation's) index (at most 20 of each: U+FDD2–U+FDE5). */
const INDEX = 0xfdd2;
/** How many indexes there are (U+FDD2–U+FDE5). */
const INDEXES = 20;
/** A citation's mark, before its index. */
const CITE = String.fromCharCode(0xfde6);
/** Every noncharacter of U+FDD0–U+FDEF: the marks and the indexes, and nothing a text needs. */
const MARKS = /[﷐-﷯]/g;

/** `text` without any mark (U+FDD0–U+FDEF). */
export const withoutMarks = (text) => (/[﷐-﷯]/.test(text) ? text.replace(MARKS, "") : text);

/**
 * `text` without any mark it holds itself, and `mentions` (ranges of `text`) and `cites` (places in it) moved onto what
 * is left: a forged mark hides only itself, never the text's stored mentions (fix round 2, M-4) or citations.
 * `{ text, mentions, cites }`.
 */
export function withoutMarksKeeping(text, mentions, cites = []) {
  if (!/[﷐-﷯]/.test(text)) return { text, mentions, cites };
  const at = new Array(text.length + 1);
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    at[i] = out.length;
    if (!/[﷐-﷯]/.test(text[i])) out += text[i];
  }
  at[text.length] = out.length;
  const moved = (Array.isArray(mentions) ? mentions : [])
    .filter((m) => m && Number.isSafeInteger(m.start) && Number.isSafeInteger(m.length) && m.start >= 0 && m.start + m.length <= text.length)
    .map((m) => ({ id: m.id, start: at[m.start], length: at[m.start + m.length] - at[m.start] }));
  const placed = (Array.isArray(cites) ? cites : []).filter((c) => c && Number.isSafeInteger(c.at) && c.at >= 0 && c.at <= text.length).map((c) => ({ ...c, at: at[c.at] }));
  return { text: out, mentions: moved, cites: placed };
}

/**
 * `text` (holding no mark) with each of `mentions` (in order, not overlapping: data/mentions.js `mentionsIn`) between
 * the marks, its index after the first: `OPEN INDEX+k @name CLOSE`, and each of `cites` (ascending `at`, at most 20) as
 * its mark where it stands, `CITE INDEX+k` — one inside a mention after it, one at a mention's start before it. A mention
 * right after a backslash (`\@anna`, the Markdown escape of @) is marked from the backslash, so the escape still works and
 * the tag shows no backslash (M-10). A mention inside an address (`inAddress`) is left unmarked.
 */
export function markMentions(text, mentions, cites = []) {
  const tags = Array.isArray(mentions) ? mentions : [];
  const links = Array.isArray(cites) ? cites.slice(0, INDEXES) : [];
  if (tags.length === 0 && links.length === 0) return text;
  // The ones in no address (the text's addresses found once for all of them: fix round 2, I-4).
  const kept = new Set(tags.length > 0 ? outsideAddresses(text, tags) : []);
  let out = "";
  let at = 0;
  let k = 0;
  /** The citations standing at or before `to`, each where it stands but not before `at` and not after `before`. */
  const citesUpTo = (to, before = to) => {
    while (k < links.length && links[k].at <= to) {
      const place = Math.min(Math.max(links[k].at, at), before);
      out += text.slice(at, place) + CITE + String.fromCharCode(INDEX + k);
      at = place;
      k += 1;
    }
  };
  tags.forEach((m, j) => {
    if (!kept.has(m)) return;
    const from = text[m.start - 1] === "\\" && m.start - 1 >= at ? m.start - 1 : m.start;
    citesUpTo(m.start, from);
    out += `${text.slice(at, from)}${OPEN}${String.fromCharCode(INDEX + j)}${text.slice(from, m.start + m.length)}${CLOSE}`;
    at = m.start + m.length;
    while (k < links.length && links[k].at < at) out += CITE + String.fromCharCode(INDEX + k++);
  });
  citesUpTo(text.length);
  return out + text.slice(at);
}

/**
 * A text of the tree cut at its marks: strings, `{ text, index }` for each mention whose marks are all in this one text
 * with an "@" right after them, and `{ cite }` (its index) for each citation's mark with its index (a mark left alone — a
 * mention the Markdown split — is taken out).
 */
export function mentionParts(text) {
  if (!/[﷐-﷯]/.test(text)) return [text];
  const parts = [];
  let plain = "";
  const flush = () => {
    if (plain !== "") parts.push(plain);
    plain = "";
  };
  for (let at = 0; at < text.length; ) {
    const open = text.indexOf(OPEN, at);
    const cite = text.indexOf(CITE, at);
    const next = open === -1 ? cite : cite === -1 ? open : Math.min(open, cite);
    if (next === -1) {
      plain += withoutMarks(text.slice(at));
      break;
    }
    plain += withoutMarks(text.slice(at, next));
    if (next === cite) {
      const index = text.charCodeAt(cite + 1) - INDEX;
      if (index >= 0 && index < INDEXES) {
        flush();
        parts.push({ cite: index });
        at = cite + 2;
      } else at = cite + 1;
      continue;
    }
    const index = text.charCodeAt(open + 1) - INDEX;
    const close = text.indexOf(CLOSE, open + 2);
    const following = text.indexOf(OPEN, open + 1);
    if (index < 0 || index >= INDEXES || close === -1 || (following !== -1 && following < close) || text[open + 2] !== "@") {
      at = open + 1;
      continue;
    }
    flush();
    parts.push({ text: withoutMarks(text.slice(open + 2, close)), index });
    at = close + 1;
  }
  flush();
  return parts;
}
