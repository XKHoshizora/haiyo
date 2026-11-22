// The keys every handler acts on, asked in one place. An Enter that confirms an input method's candidate (Pinyin, Japanese
// kana–kanji) and an Esc that cancels one belong to the input method, never to the app: while a composition is open the
// keydown says `isComposing`, and Safari, which ends the composition before that keydown, still gives it keyCode 229.
// tests/keys.test.jsx holds the source to it: no other file names Enter or Escape.

/** Whether a key event (React's or the browser's) belongs to an input method's composition. */
export const composing = (event) => Boolean((event.nativeEvent ?? event).isComposing) || event.keyCode === 229 || event.nativeEvent?.keyCode === 229;

/** Enter, pressed by the person (not one that confirms a candidate). */
export const isEnter = (event) => event.key === "Enter" && !composing(event);

/** Esc, pressed by the person (not one that cancels a candidate). */
export const isEscape = (event) => event.key === "Escape" && !composing(event);
