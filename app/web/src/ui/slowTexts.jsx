// Agents' texts the Markdown worker did not answer in time (markdownClient.js), remembered for this tab (sessionStorage,
// so across reloads) so they are shown as plain text from then on, without being sent to the worker again. Only a
// digest of each text is kept (a 64-bit non-cryptographic hash and its length), never the text. Storage that is
// missing, full or refused only means a text is not remembered: rendering never depends on it.
import React from "react";

export const SLOW_TEXT_NOTE = "这条回复内容过于复杂，已按纯文本显示。";
const KEY = "agent-family.slow-markdown";
/** Digests kept; the oldest is dropped first. */
export const SLOW_TEXTS_KEPT = 200;

/** Two 32-bit FNV-1a hashes (different offsets) of the text's UTF-16 code units, as hex, and its length. */
export function digestOf(text) {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    a = Math.imul(a ^ unit, 0x01000193);
    b = Math.imul(b ^ unit, 0x01000193);
  }
  const hex = (n) => (n >>> 0).toString(16).padStart(8, "0");
  return `${hex(a)}${hex(b)}:${text.length}`;
}

function storage() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Digests remembered in this page (also when storage is unavailable). */
const inPage = new Set();
/** The stored list, parsed once per stored value. */
let last = { raw: null, list: [], set: new Set() };
function remembered() {
  let raw = null;
  try {
    raw = storage()?.getItem(KEY) ?? null;
  } catch {
    raw = null;
  }
  if (raw === last.raw) return last;
  let list = [];
  try {
    const parsed = JSON.parse(raw ?? "[]");
    if (Array.isArray(parsed)) list = parsed.filter((item) => typeof item === "string").slice(-SLOW_TEXTS_KEPT);
  } catch {
    list = [];
  }
  last = { raw, list, set: new Set(list) };
  return last;
}

/** Whether this text was found too slow to render before (in this tab). */
export function isSlowText(text) {
  const digest = digestOf(text);
  return inPage.has(digest) || remembered().set.has(digest);
}

/** Remembers this text as too slow to render (its digest only). */
export function rememberSlowText(text) {
  const digest = digestOf(text);
  inPage.add(digest);
  if (inPage.size > SLOW_TEXTS_KEPT) inPage.delete(inPage.values().next().value);
  const { list, set } = remembered();
  if (set.has(digest)) return;
  const next = [...list, digest].slice(-SLOW_TEXTS_KEPT);
  try {
    storage()?.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage refused or full: the text is just not remembered */
  }
}

/** A text shown as plain text because it is too complex (or was too slow) to render, with a small note under it. */
export function PlainWithNote({ text }) {
  return (
    <>
      {text}
      <span className="md-note">{SLOW_TEXT_NOTE}</span>
    </>
  );
}
