import React from "react";
import { searchErrorText } from "../data/errorTexts.js";
import { convTitle, senderName } from "../state/selectors.js";
import { useStore } from "../data/store.jsx";
import { Avatar, Btn, ConvAvatar } from "../ui/primitives.jsx";

const escapePattern = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A hit's text shortened around its first match, so the match is on screen in a one-line preview. */
export function excerpt(text, q, max = 120) {
  const chars = [...text];
  if (chars.length <= max) return text;
  const term = q.trim();
  const at = term ? text.search(new RegExp(escapePattern(term), "iu")) : -1;
  const lead = at < 0 ? 0 : [...text.slice(0, at)].length;
  const start = Math.max(0, Math.min(lead - 24, chars.length - max));
  const end = Math.min(chars.length, start + max);
  return `${start > 0 ? "…" : ""}${chars.slice(start, end).join("")}${end < chars.length ? "…" : ""}`;
}

/** `text` with every match of `q` (ignoring case) in a `<mark>`; built from text nodes, never from HTML. */
export function Highlight({ text, q }) {
  const term = q.trim();
  if (!term) return text;
  const parts = [];
  let from = 0;
  for (const match of text.matchAll(new RegExp(escapePattern(term), "giu"))) {
    if (match[0].length === 0) continue;
    if (match.index > from) parts.push(text.slice(from, match.index));
    parts.push(<mark key={match.index}>{match[0]}</mark>);
    from = match.index + match[0].length;
  }
  if (parts.length === 0) return text;
  if (from < text.length) parts.push(text.slice(from));
  return parts.map((part, i) => (typeof part === "string" ? <React.Fragment key={`t${i}`}>{part}</React.Fragment> : part));
}

/** Loading, empty, error and "more" lines under a list of hits (as `<li>`s; `search` is `useMessageSearch`'s result). */
export function SearchFooter({ search, emptyText }) {
  const { status, hits, more, loadingMore, error, loadMore, retry } = search;
  const note = (text, withRetry) => (
    <li className="rows-empty" role="status">
      {text}
      {withRetry && (
        <>
          {" "}
          <Btn small onClick={retry}>重试</Btn>
        </>
      )}
    </li>
  );
  if (status === "loading") return note("正在搜索…");
  if (status === "error") return note(searchErrorText(error), true);
  if (status === "ready" && hits.length === 0) return note(emptyText);
  return (
    <>
      {error && note(searchErrorText(error), true)}
      {more && (
        <li className="rows-empty">
          <Btn small disabled={loadingMore} onClick={loadMore}>
            {loadingMore ? "搜索中…" : "继续向更早的记录搜索"}
          </Btn>
        </li>
      )}
    </>
  );
}

/** A hit of the global search: the conversation, the sender and the text with the match emphasised. */
export function GlobalHitRow({ hit, q, onPick }) {
  const { state } = useStore();
  const conv = state.convs[hit.conversationId];
  if (!conv) return null;
  return (
    <li>
      <button type="button" className="row" onClick={() => onPick(hit)}>
        <ConvAvatar conv={conv} size={48} />
        <span className="row-body">
          <span className="row-top">
            <span className="row-name">{convTitle(state, conv)}</span>
            <time>{hit.at}</time>
          </span>
          <span className="row-sub">
            <span className="row-preview">
              {hit.from ? `${senderName(state, hit.from)}：` : ""}
              <Highlight text={excerpt(hit.text, q)} q={q} />
            </span>
          </span>
        </span>
      </button>
    </li>
  );
}

/** A hit of the search inside one conversation. */
export function ChatHitRow({ hit, q, onPick }) {
  const { state } = useStore();
  return (
    <li>
      <button type="button" className="row slim" onClick={() => onPick(hit)}>
        <Avatar id={hit.from} size={40} />
        <span className="row-body">
          <span className="row-top">
            <span className="row-name">{senderName(state, hit.from)}</span>
            <time>{hit.at}</time>
          </span>
          <span className="row-sub">
            <span className="row-preview">
              <Highlight text={excerpt(hit.text, q)} q={q} />
            </span>
          </span>
        </span>
      </button>
    </li>
  );
}
