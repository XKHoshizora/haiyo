// What is typed in a form that is a page of its own and has not been saved, kept in memory for the session so that an accidental
// Back / Forward (or a way out of the page and back in) does not lose it. Keyed by the page's address key; never in the URL, never
// in a storage: a provider form holds an API key. Gone with the session (sign-out), when saved, and when a fresh form is asked for.
const drafts = new Map();

export const peekDraft = (key) => drafts.get(key) ?? null;
export const saveDraft = (key, value) => void drafts.set(key, value);
export const forgetDraft = (key) => void drafts.delete(key);
/** Every draft goes (the session ended or another account signed in). */
export const forgetDrafts = () => drafts.clear();
export const draftKeys = () => [...drafts.keys()];
