# History: one rule (replaces appHistory.js of 72fc955)

## The rule

**The address is the only source of truth for where a person is.** An address is a path and, for the two overlays, a key in
`history.state`. Everything drawn is a function of it; nothing else decides a page.

| Place | Path | Overlay key |
|---|---|---|
| chat list | `/` | |
| a conversation | `/chat/<id>` | |
| its info page (group info) | `/chat/<id>/info` | |
| its details panel (会话资料, a full page on a phone) | `/chat/<id>` | `details` |
| the image viewer | the entry's own path | state `viewer: <message id>` |
| contacts, a contact card | `/contacts`, `/contacts/<id>` | |
| Agents, an Agent, its form, create | `/agents`, `/agents/<id>`, `/agents/<id>/edit`, `/agents/new` | |
| settings home, a settings page | `/settings`, `/settings/<profile\|providers\|usage\|memory\|blocks>` | |

Two pure functions in `state/location.js` do the whole mapping, no layout and no width in either:
`addressOf(nav)` (the page keys of the store's navigation → address) and `navOfAddress(address)` (address → a complete page
patch: section, pane, convId, view, contactId, agentId, agentView, settingsPage, detailsOpen). `pane` is not a layout flag any
more: it says "a page is open over the list" and is a function of the address (`/`, `/contacts`, `/agents`, `/settings` are the
lists; the rest are pages). The store's navigation stays what pages read; it is only ever (a) set from an address or (b) moved by
a page, after which the address is derived from it by `addressOf`. Both directions are the same two functions, so they cannot
disagree.

## The five operations (the only ones that touch `history`)

Each entry's state is `{af: 1, index, prev, path, overlay, viewer, nav}`: `index` counts the app's own entries from the first
(0 for a cold start), `prev` is the key (`path#overlay`) of the entry below, `nav` a snapshot of the page keys and the soft keys
(agentTab, profileTab) for Forward.

1. **Navigate** (a page changes the store's navigation, or opens the viewer): if the new address differs from the entry's,
   `pushState` a new entry (`index + 1`, `prev` = the key left). Always a push when the address differs: no "replace because
   the depth is the same". Same address, only soft keys changed: `replaceState` the snapshot of the same entry.
   A programmatic move that must not leave its starting page in the history (a create form that ends in the thing it created,
   a deleted page, a conversation that is gone) marks itself `markReplace()` and is a `replaceState` instead.
2. **Close** (a page's own back / close button, the viewer's): `up()`. `parent = parentOf(address)`. If the entry's `prev` is
   exactly the parent's key (the app's own entry is below), `history.back()`; else `replaceState` to the parent and show it.
3. **Popstate**: the handler only re-renders: it dispatches the page patch of the entry reached (`history.state.nav`, or the
   path when there is no state). It never calls back/forward/replace/push. (The viewer reads its own key from the entry the
   same way, so a Back that leaves its entry closes it.)
4. **Cold start** (reload, link, restored tab): draw the address (and `history.state` when it is ours: keep its `index`/`prev`,
   which survive a reload in the browser); stamp the entry with `replaceState` if it has no state of ours. **No entry is
   synthesized.** The in-app back button there is `up()` with nothing of ours below: a `replaceState` to the parent.
5. **Layout** is not an input to any of the above. Crossing 640/860px or rotating changes how the same address is drawn
   (`.app[data-pane]`, the tab bar, the details panel's place) and nothing else.

Desktop and phone are one code path. **Selecting another conversation is a push** on both (as Slack, Discord and Telegram Web
do): Back returns to the previous conversation, then the list; the cost (a long Back chain after much browsing) is the
mainstream one. (The previous lane's `replaceState` on wide screens was width-dependent logic; it is gone.)

## Derived drawing (no history call)

- A conversation address whose conversation is not in the store once it has loaded (removed, never a member, deleted) draws the
  list (the existing 「你已不在该会话中」 toast) and `markReplace`s the entry to `/`: Forward never shows it again.
- A modal dialog open when a popstate arrives closes (its own `onClose`), leaving no entry: a dialog is not an address.
- Sign-in: a signed-out visit to an app address remembers the path in memory; after signing in the app opens it.
- The bubble menu is not an address and is not an entry.

## Tests (table-driven on a fake history, then jsdom, then e2e at 375 and 1280)

The table: every transition of the review's C1, C2, I1, I2, I3, plus viewer → rotate (a width flip has no effect), viewer → Back →
chat → Back → list, removal then Back, Forward to a gone page, signed-out deep link, a dialog during popstate.
