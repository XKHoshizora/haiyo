// Pure UI navigation and toast. Server-backed state is applied by the data layer (Task 2).
import { NAV_KEYS, canonicalNav } from "./location.js";

/**
 * A field to focus on an Agent's page (`agentFocus`, ModelPicker.jsx `openModelChoice`) belongs to the page it was asked
 * with: a move to another section, Agent or view of it drops it, unless that move asks for one itself.
 */
function keptFocus(before, after, patch) {
  if (after.agentFocus == null || "agentFocus" in patch) return after;
  const moved = after.section !== before.section || after.agentId !== before.agentId || after.agentView !== before.agentView;
  return moved ? { ...after, agentFocus: null } : after;
}

/**
 * Every move of the navigation carries its own intent as data: `replace: true` on the action makes the history entry it leaves the page it
 * goes to (a form that ends in what it made, a page that turned out to be gone); otherwise it is a new entry. The intent is recorded with the
 * navigation (`navIntent`) and read by the one history effect (state/appHistory.js): nothing is shared between effects.
 */
const intentOf = (action) => (action.intent === "none" ? "none" : action.replace === true ? "replace" : "push");

/** A page key that does not exist is a mistake in the code: in development and tests it throws, so a key that decides a page cannot slip in without an address. */
function checkKeys(patch) {
  if (import.meta.env?.PROD) return;
  for (const key of Object.keys(patch ?? {})) if (!NAV_KEYS.includes(key)) throw new Error(`nav key "${key}" is not placed (state/location.js NAV_KEYS): a key that decides a page needs an address`);
}

/** `providerCreated` (the sync dialog of a provider just made) belongs to the page it was set for: a move to another provider page clears it. */
const keptCreated = (after, patch) => ("providerId" in patch && !("providerCreated" in patch) ? { ...after, providerCreated: false } : after);

export function reducer(state, action) {
  switch (action.type) {
    case "nav":
      checkKeys(action.patch);
      return { ...state, nav: { ...canonicalNav(keptCreated(keptFocus(state.nav, { ...state.nav, ...action.patch }, action.patch), action.patch)), navIntent: intentOf(action) } };
    case "nav/openConv":
      checkKeys(action.patch);
      return {
        ...state,
        nav: {
          ...canonicalNav(keptFocus(
            state.nav,
            {
              ...state.nav,
              section: "chat",
              convId: action.convId,
              view: "chat",
              pane: "main",
              // (The details panel belongs to the one conversation it was opened in.)
              detailsOpen: false,
              // (A message to scroll to belongs to the conversation it was asked for.)
              focus: state.nav.focus?.convId === action.convId ? state.nav.focus : null,
              ...(action.patch || {}),
            },
            action.patch || {},
          )),
          navIntent: intentOf(action),
        },
      };
    case "toast":
      return { ...state, seq: state.seq + 1, toast: { id: state.seq + 1, text: action.text } };
    case "toast/clear":
      return state.toast?.id === action.id ? { ...state, toast: null } : state;
    default:
      return state;
  }
}
