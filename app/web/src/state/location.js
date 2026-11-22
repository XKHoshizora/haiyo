// Where a person is, as an address: the one mapping between the store's navigation and the address bar (state/appHistory.js
// is the only caller that touches `history`). No layout and no width in any of it: the same address is drawn as one column
// or three by the stylesheet. `pane` is "main" when a page is open over a list, "list" at a list.

/** The keys of the navigation that are pages (an address and its overlay say all of them). */
export const PAGE_KEYS = ["section", "pane", "convId", "view", "contactId", "agentId", "agentView", "settingsPage", "providerId", "detailsOpen"];
/** Keys that are the state of a page, not a page: kept in the entry for Forward, never a new entry. */
export const SOFT_KEYS = ["agentTab", "profileTab"];
/** Keys that are neither: a one-off request or note that is not a place (a message to scroll to, a conversation waited for, a form's field to focus...). */
export const TRANSIENT_KEYS = ["addFriend", "opening", "focus", "agentFocus", "agentNote", "providerCreated", "navIntent"];
/**
 * Every key of the navigation is a page key (an address says it), a soft key (state of a page, kept in its entry) or a transient one.
 * tests/app-history.test.jsx fails when the navigation has a key that is none of these: a new key that decides a page needs an address.
 */
export const NAV_KEYS = [...PAGE_KEYS, ...SOFT_KEYS, ...TRANSIENT_KEYS];

/** The navigation with its page keys made what its address says: the page drawn is a function of the address, nothing else. */
export function canonicalNav(nav) {
  return { ...nav, ...navOfAddress(addressOf(nav)) };
}

/** The section an address is in. */
export const sectionOfPath = (path) => (path.startsWith("/contacts") ? "contacts" : path.startsWith("/agents") ? "agents" : path.startsWith("/settings") ? "settings" : "chat");

export const SETTINGS_PAGES = ["profile", "providers", "usage", "memory", "blocks"];
const ID = "[0-9a-zA-Z_-]{1,64}";

/** `{path, overlay}` of the navigation `nav`; `overlay` is null or "details". */
export function addressOf(nav) {
  const main = nav.pane === "main";
  switch (nav.section) {
    case "contacts":
      return { path: main && nav.contactId ? `/contacts/${nav.contactId}` : "/contacts", overlay: null };
    case "agents": {
      if (!main) return { path: "/agents", overlay: null };
      if (nav.agentView === "create") return { path: "/agents/new", overlay: null };
      if (!nav.agentId) return { path: "/agents", overlay: null };
      return { path: `/agents/${nav.agentId}${nav.agentView === "edit" ? "/edit" : ""}`, overlay: null };
    }
    case "settings": {
      if (!main) return { path: "/settings", overlay: null };
      const page = SETTINGS_PAGES.includes(nav.settingsPage) ? nav.settingsPage : "profile";
      return { path: `/settings/${page}${page === "providers" && nav.providerId ? `/${nav.providerId}` : ""}`, overlay: null };
    }
    default: {
      if (!main || !nav.convId) return { path: "/", overlay: null };
      const info = nav.view === "profile";
      return { path: `/chat/${nav.convId}${info ? "/info" : ""}`, overlay: !info && nav.detailsOpen ? "details" : null };
    }
  }
}

/** The page keys an address means (all of them, so that showing it leaves nothing of the page before). */
export function navOfAddress({ path, overlay = null }) {
  const base = { section: "chat", pane: "list", convId: null, view: "chat", contactId: null, agentId: null, agentView: "detail", settingsPage: "profile", providerId: null, detailsOpen: false };
  let match;
  if ((match = new RegExp(`^/chat/(${ID})(/info)?/?$`).exec(path))) {
    return { ...base, pane: "main", convId: match[1], view: match[2] ? "profile" : "chat", detailsOpen: !match[2] && overlay === "details" };
  }
  if (path === "/contacts") return { ...base, section: "contacts" };
  if ((match = new RegExp(`^/contacts/(${ID})/?$`).exec(path))) return { ...base, section: "contacts", pane: "main", contactId: match[1] };
  if (path === "/agents") return { ...base, section: "agents" };
  if (path === "/agents/new") return { ...base, section: "agents", pane: "main", agentView: "create" };
  if ((match = new RegExp(`^/agents/(${ID})(/edit)?/?$`).exec(path))) return { ...base, section: "agents", pane: "main", agentId: match[1], agentView: match[2] ? "edit" : "detail" };
  if (path === "/settings") return { ...base, section: "settings" };
  if ((match = new RegExp(`^/settings/providers/(${ID})/?$`).exec(path))) return { ...base, section: "settings", pane: "main", settingsPage: "providers", providerId: match[1] };
  if ((match = /^\/settings\/([a-z]+)\/?$/.exec(path)) && SETTINGS_PAGES.includes(match[1])) return { ...base, section: "settings", pane: "main", settingsPage: match[1] };
  return base;
}

/** The key of an address (what an entry's `prev` holds). */
export const keyOf = ({ path, overlay = null }) => `${path}#${overlay ?? ""}`;

/** The page a page's own back or close button goes to. */
export function parentOf({ path, overlay = null }) {
  if (overlay) return { path, overlay: null };
  if (/^\/chat\/[^/]+\/info$/.test(path)) return { path: path.replace(/\/info$/, ""), overlay: null };
  if (/^\/chat\//.test(path)) return { path: "/", overlay: null };
  if (/^\/agents\/[^/]+\/edit$/.test(path)) return { path: path.replace(/\/edit$/, ""), overlay: null };
  if (/^\/agents\//.test(path)) return { path: "/agents", overlay: null };
  if (/^\/contacts\//.test(path)) return { path: "/contacts", overlay: null };
  if (/^\/settings\/providers\/[^/]+$/.test(path)) return { path: "/settings/providers", overlay: null };
  if (/^\/settings\//.test(path)) return { path: "/settings", overlay: null };
  return { path: "/", overlay: null };
}

const same = (a, b) => keyOf(a) === keyOf(b);
export const sameAddress = same;
