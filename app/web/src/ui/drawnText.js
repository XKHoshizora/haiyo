// A message's text in the form it is drawn, as plain text: the ONE function behind everything that shows or copies a message's words
// outside its bubble (the quote under a reply, the reply chip over the composer, the chat list's line, the copied text).
import { mentionSegments } from "../data/mentions.js";
import { withoutBidiControls } from "./markdownRules.js";
import { withoutMarksKeeping } from "./mentionMarks.js";

/**
 * `text` with its `mentions` ({id, start, length}, as stored) as they are drawn: a mention is `@` and the name it shows now
 * (`known(id)` gives `{displayName, name}` or null; a gone one is as it was sent), never the handle typed or the words of a screen reader.
 * An Agent's text (`fromAgent`) is drawn without the marks of its own pipeline and without bidirectional controls (ui/AgentText.jsx: when
 * a control was there its mentions are not tags either): the same here, so a reply that picked up a control from a page it read is not
 * shown or copied differently from what is on screen.
 */
export function drawnText({ text, mentions, fromAgent = false, known }) {
  const source = typeof text === "string" ? text : "";
  const clean = fromAgent ? withoutMarksKeeping(source, mentions, []) : { text: source, mentions };
  const shown = fromAgent ? withoutBidiControls(clean.text) : clean.text;
  if (shown !== clean.text) return shown;
  return mentionSegments(shown, clean.mentions)
    .map((part) => {
      if (!part.mention) return part.text;
      const who = known?.(part.mention.id);
      return who ? `@${who.displayName || who.name}` : part.text;
    })
    .join("");
}
