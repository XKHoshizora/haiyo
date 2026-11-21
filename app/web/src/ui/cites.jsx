// What an Agent's reply cites (design rule 4; the service's `cites`): its citations are kept beside its text, never in it
// — `[{at, kind, conversationId, seq}]` (data/viewmodel.js), each where it stands in the text (UTF-16 code units,
// ascending), as a mention's range is — and each reader is sent those whose message they can see. Each is shown as a
// small superscript link where it stands, numbered by the message it points to (the same message, the same number, in
// order of first appearance), that jumps to its message (the chat's own jump: it scrolls there, opening its
// conversation when it is another, and the message flashes). Nothing of a citation is ever read from the text: what
// looks like one in it (`〔m1〕`) is text someone wrote. A reply's text is plain or rendered Markdown (AgentText.jsx,
// Markdown.jsx): the message being shown hands its citations and its jump down by `CitesContext`.
import React, { createContext } from "react";

/** The citations of the message being shown, `{ cites: [{at, kind, conversationId, seq}], onJump }`, or null. */
export const CitesContext = createContext(null);

/**
 * `cites` (ascending) numbered for showing: `[{ ...cite, n }]`, `n` from 1 by the message each points to, in the order
 * the messages are first cited.
 */
export function numberedCites(cites) {
  const numbers = new Map();
  return (Array.isArray(cites) ? cites : []).map((c) => {
    const key = `${c.conversationId}|${c.seq}`;
    if (!numbers.has(key)) numbers.set(key, numbers.size + 1);
    return { ...c, n: numbers.get(key) };
  });
}

/**
 * One citation: a `sup` that moves no line, holding a button that is a box as tall as the text line (easy to hit), the
 * number small at its top — a superscript to look at (styles.css `.cite`).
 */
export function Cite({ cite, onJump }) {
  return (
    <sup className="cite">
      <button type="button" title="跳到引用的消息" aria-label={`引用 ${cite.n}`} onClick={() => onJump?.(cite.conversationId, cite.seq)}>
        <span>{cite.n}</span>
      </button>
    </sup>
  );
}

/**
 * `text` cut into what is shown of it, in order: strings, `{ mention }` for each of `mentions` (`{start, length}`,
 * ascending, not overlapping: data/mentions.js `mentionsIn`) with its text, and `{ cite }` for each of `cites` (ascending
 * `at`) where it stands — one inside a mention after it, one at a mention's start before it. Empty strings are left out.
 */
export function textPieces(text, mentions = [], cites = []) {
  const source = typeof text === "string" ? text : "";
  const out = [];
  let at = 0;
  let k = 0;
  /** The text from `at` to `to`, with every citation standing at or before `to` where it stands. */
  const upTo = (to) => {
    while (k < cites.length && cites[k].at <= to) {
      const place = Math.max(cites[k].at, at);
      if (place > at) out.push(source.slice(at, place));
      at = place;
      out.push({ cite: cites[k] });
      k += 1;
    }
    if (to > at) out.push(source.slice(at, to));
    at = Math.max(at, to);
  };
  for (const m of mentions) {
    upTo(m.start);
    out.push({ mention: m, text: source.slice(m.start, m.start + m.length) });
    at = m.start + m.length;
    while (k < cites.length && cites[k].at < at) out.push({ cite: cites[k++] });
  }
  upTo(source.length);
  while (k < cites.length) out.push({ cite: cites[k++] });
  return out;
}
