// The web pages an Agent's reply was handed by its web search (the service's `webSources`; lane websearch): a quiet
// numbered list, for whoever reads the reply — folded until the reader opens it from the reply's lookup line
// (ReplyLookups.jsx: 查了 1 次网页 · 2 个来源), then right under that line. Each row is the page's title and the real host
// of its address (`new URL(url).hostname`, a punycode host in its ASCII form — never the engine's site name), and opens
// the page in a new tab (`rel="noopener noreferrer nofollow"`). The numbers are the ones the reply's chips say
// (ui/cites.jsx): a chip opens its page itself, so reading on never needs the list. In such a reply nothing else opens:
// its Markdown links show as plain text (Markdown.jsx). A long list opens at its first SOURCES_FIRST rows, with a row
// that shows them all. What the reader chose for a reply (opened, all of them) is kept for the visit of its conversation
// (`sourcesChoice`): a row taken away and shown again within it (a jump to an older message and back) is as it was left.
import React, { useLayoutEffect, useRef } from "react";
import { TextLink } from "../ui/primitives.jsx";
import { withoutBidiControls } from "../ui/markdownRules.js";

/** How many rows a long list opens with. A list of one more is shown whole: a row to show one row saves nothing. */
export const SOURCES_FIRST = 5;

/**
 * What the reader chose for each reply's pages, by conversation and message id: `{ open, all }`, for the newest
 * SOURCES_CHOICES_KEPT replies they touched — while the conversation is shown (ChatView forgets it on leaving,
 * `forgetSourcesChoices`), as a reply's run record keeps whether its thinking is open (AgentChatBits.jsx `runClock`).
 */
const choices = new Map();
const SOURCES_CHOICES_KEPT = 50;
const NO_CHOICE = Object.freeze({ open: false, all: false });
const choiceKey = (conversationId, messageId) => `${conversationId}\n${messageId}`;

/** What the reader chose for that reply's pages; folded and short when nothing. Makes no record. */
export const sourcesChoice = (conversationId, messageId) => choices.get(choiceKey(conversationId, messageId)) ?? NO_CHOICE;

/** Notes a choice of the reader (`{ open }` or `{ all }`) for that reply's pages; resolves with the whole choice. */
export function noteSourcesChoice(conversationId, messageId, change) {
  const key = choiceKey(conversationId, messageId);
  const next = { ...(choices.get(key) ?? NO_CHOICE), ...change };
  choices.delete(key);
  choices.set(key, next);
  if (choices.size > SOURCES_CHOICES_KEPT) choices.delete(choices.keys().next().value);
  return next;
}

/** The conversation is not shown any more: every reply of it is folded when it is shown again. */
export function forgetSourcesChoices(conversationId) {
  for (const key of [...choices.keys()]) if (key.startsWith(`${conversationId}\n`)) choices.delete(key);
}

/**
 * How far the chat scrolls down when a reply's pages are opened (0: not at all), from where things are on the screen
 * (`top` and `bottom` of the chat's scroller `view`, of the `toggle`, of the block's `first` row and of the `block`):
 * only when the first row is not in sight; then by what shows the whole block, but never so far that the button leaves.
 */
export function openingScroll({ view, toggle, first, block }) {
  if (first.bottom <= view.bottom) return 0;
  return Math.max(0, Math.min(block.bottom - view.bottom, toggle.top - view.top));
}

/**
 * What an Agent's message hands its text (ui/cites.jsx `CitesContext`), or null for nothing: its message citations when
 * they can jump (`onJump`), its web chips (`msg.webCites`), in the order of their places (a message's first where both
 * stand), and `plainLinks` when its run was handed web pages (`msg.plainLinks`: from what is stored, not from which of its
 * sources can be shown).
 */
export function citingOf(msg, onJump) {
  const web = Array.isArray(msg.webCites) ? msg.webCites : [];
  const plainLinks = msg.plainLinks === true;
  const own = onJump && Array.isArray(msg.cites) ? msg.cites : [];
  const cites = web.length === 0 ? own : [...own, ...web].sort((a, b) => a.at - b.at);
  if (cites.length === 0 && !plainLinks) return null;
  return { cites, onJump, ...(plainLinks ? { plainLinks: true } : {}) };
}

/**
 * `sources` (a view message's `webSources`: `[{n, shown, url, host, title}]`) as the list, or nothing when there are
 * none. More than SOURCES_FIRST + 1 rows and not `all`: the first SOURCES_FIRST and 显示全部 N 个, which asks for the rest
 * (`onAll`) and, once they are there, hands the keyboard the first of them (only then: a list shown again whole takes no
 * focus).
 */
export function WebSources({ sources, all = false, onAll }) {
  const list = useRef(null);
  const asked = useRef(false);
  const count = Array.isArray(sources) ? sources.length : 0;
  useLayoutEffect(() => {
    if (!all || !asked.current) return;
    asked.current = false;
    list.current?.querySelectorAll("a")[SOURCES_FIRST]?.focus();
  }, [all]);
  if (count === 0) return null;
  const bounded = !all && count > SOURCES_FIRST + 1;
  const showAll = () => {
    asked.current = true;
    onAll?.();
  };
  return (
    <ol className="web-sources" ref={list} aria-label="网页来源">
      {(bounded ? sources.slice(0, SOURCES_FIRST) : sources).map((s) => {
        const title = withoutBidiControls(s.title).trim();
        return (
          <li key={s.n}>
            <span className="web-source-n" aria-hidden="true">
              {s.shown}
            </span>
            <TextLink href={s.url} target="_blank" rel="noopener noreferrer nofollow" title={s.url} aria-label={`来源 ${s.shown}：${title || s.host}（${s.host}）`}>
              <span className="web-source-title" dir="auto">
                {title || s.host}
              </span>
              <span className="web-source-host" dir="auto">
                {s.host}
              </span>
            </TextLink>
          </li>
        );
      })}
      {bounded && (
        <li className="web-sources-more">
          <button type="button" onClick={showAll}>
            显示全部 {count} 个
          </button>
        </li>
      )}
    </ol>
  );
}
