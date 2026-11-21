// A message's text with its stored mentions shown as tags over their ranges (data/mentions.js): each one the current
// display name of whom it means (`@小助`, follows a rename) on a light tint, with a card on hover or focus (ui/MentionCard.jsx).
// Who a tag means is the stored id; nothing here reads the text to decide it. A screen reader reads a tag as 提到 and
// that name. A mention of someone no longer here keeps the name it was sent with, muted, and has no card.
import React, { Fragment } from "react";
import { Cite, textPieces } from "./cites.jsx";
import { mentionName, mentionsIn } from "../data/mentions.js";
import { useStore } from "../data/store.jsx";
import { entity, isAgent } from "../state/selectors.js";
import { MentionChip } from "./MentionCard.jsx";

/**
 * One mention: `@` and the current display name of the principal it means (`id`) — the reader herself is `mention-self`,
 * on a stronger tint —, read as `提到` and that name. When that principal is not known (gone, no id, or outside the
 * app's store) it shows `text` as it was sent, muted (`mention-gone`), and nothing opens. The hidden words are not
 * selected or copied with the text (styles.css `.mention .sr-only`).
 */
export function MentionTag({ text, id }) {
  const state = useStore()?.state ?? null;
  const known = state && id ? entity(state, id) : null;
  if (!known) {
    return (
      <span className="mention mention-gone">
        <span className="sr-only">{`提到 ${mentionName(text)}`}</span>
        <span aria-hidden="true">{text}</span>
      </span>
    );
  }
  return <MentionChip id={id} spoken={`提到 ${known.name}`} shown={`@${known.displayName || known.name}`} agent={isAgent(state, id)} />;
}

/**
 * `text` with `mentions` (`[{id, start, length}]`, stored with the message) as tags and, for an Agent's reply, its
 * `cites` (numbered, ui/cites.jsx `numberedCites`: places in the same text) as links that `onJump`; plain text without any.
 */
export function MentionText({ text, mentions, cites = null, onJump = null }) {
  const tags = Array.isArray(mentions) ? mentionsIn(text, mentions) : [];
  const links = Array.isArray(cites) ? cites : [];
  if (tags.length === 0 && links.length === 0) return text ?? "";
  return textPieces(text, tags, links).map((part, i) =>
    typeof part === "string" ? (
      <Fragment key={i}>{part}</Fragment>
    ) : part.mention ? (
      <MentionTag key={i} text={part.text} id={part.mention.id} />
    ) : (
      <Cite key={i} cite={part.cite} onJump={onJump} />
    ),
  );
}
