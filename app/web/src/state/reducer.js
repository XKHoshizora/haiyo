// Pure UI navigation and toast. Server-backed state is applied by the data layer (Task 2).
import { canonicalNav } from "./location.js";

/**
 * A field to focus on an Agent's page (`agentFocus`, ModelPicker.jsx `openModelChoice`) belongs to the page it was asked
 * with: a move to another section, Agent or view of it drops it, unless that move asks for one itself.
 */
function keptFocus(before, after, patch) {
  if (after.agentFocus == null || "agentFocus" in patch) return after;
  const moved = after.section !== before.section || after.agentId !== before.agentId || after.agentView !== before.agentView;
  return moved ? { ...after, agentFocus: null } : after;
}

export function reducer(state, action) {
  switch (action.type) {
    case "nav":
      return { ...state, nav: canonicalNav(keptFocus(state.nav, { ...state.nav, ...action.patch }, action.patch)) };
    case "nav/openConv":
      return {
        ...state,
        nav: canonicalNav(keptFocus(
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
      };
    case "toast":
      return { ...state, seq: state.seq + 1, toast: { id: state.seq + 1, text: action.text } };
    case "toast/clear":
      return state.toast?.id === action.id ? { ...state, toast: null } : state;
    default:
      return state;
  }
}
