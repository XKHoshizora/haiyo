import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "./data/store.jsx";
import { entity, isMyAgent, unreadTotal } from "./state/selectors.js";
import { socialOn } from "./state/social.js";
import { readOthersUse, storeOf } from "./data/othersUseCache.js";
import { ME } from "./data/identities.js";
import { Avatar, BrandMark, IconBtn, LoadingRow } from "./ui/primitives.jsx";
import { useMediaQuery, usePhone } from "./ui/pointer.js";
import { ONE_COLUMN_MAX } from "./ui/breakpoints.js";
import { useRouteFocus } from "./ui/routeFocus.js";
import { ToastRegion } from "./ui/Toast.jsx";
import { pageTitle } from "./state/pageTitle.js";
import { addressOf, keyOf } from "./state/location.js";
import { alive, lastPageOf, useAppHistory, useUp } from "./state/appHistory.js";
import { useShellOpen } from "./shell/useShell.js";
import { MessageCircle, Users, Bot, Settings, ChevronLeft } from "./icons.js";
import { ChatList } from "./pages/ChatList.jsx";
import { ChatView } from "./pages/ChatView.jsx";
import { GroupProfile } from "./pages/GroupProfile.jsx";
import { DetailsPanel } from "./pages/DetailsPanel.jsx";
import { ContactsList, ContactCard } from "./pages/Contacts.jsx";
import { AgentsList, AgentMain } from "./pages/Agents.jsx";
import { SettingsList, SettingsMain } from "./pages/Settings.jsx";

const NAV = [
  { id: "chat", label: "消息", icon: MessageCircle },
  { id: "contacts", label: "通讯录", icon: Users },
  { id: "agents", label: "Agent", icon: Bot },
];

/**
 * The main navigation. On a wide screen the rail down the left edge (the brand mark, my avatar, the entries); on a phone
 * (`phone`) the same entries as the tab bar along the bottom, where the brand mark is left out (the list header says the
 * name) and so is my avatar (its one use is 设置, a tab of the bar; the settings list shows it).
 */
function Rail({ phone }) {
  const { state, dispatch } = useStore();
  const unread = unreadTotal(state);
  // A section is the last address seen in it (its list if it was left on the list): a push like any other, and the address says what is drawn.
  const go = (section) => dispatch({ type: "nav", patch: lastPageOf(section, state) });
  return (
    <nav className="rail" aria-label="主导航">
      {!phone && <BrandMark size={38} />}
      {!phone && (
        <button type="button" className="rail-me" onClick={() => go("settings")} aria-label="我的资料与设置">
          <Avatar id={ME} size={48} online />
        </button>
      )}
      <div className="rail-nav">
        {NAV.map(({ id, label, icon: Icon }) => (
          <button key={id} type="button" className={`rail-item ${state.nav.section === id ? "active" : ""}`} aria-current={state.nav.section === id ? "page" : undefined} onClick={() => go(id)}>
            <span className="rail-icon">
              <Icon size={26} aria-hidden="true" />
              {id === "chat" && unread > 0 && <span className="badge">{unread}</span>}
            </span>
            <span>{label}</span>
          </button>
        ))}
      </div>
      <div className="rail-bottom">
        <button type="button" className={`rail-item ${state.nav.section === "settings" ? "active" : ""}`} aria-current={state.nav.section === "settings" ? "page" : undefined} onClick={() => go("settings")}>
          <span className="rail-icon">
            <Settings size={26} aria-hidden="true" />
          </span>
          <span>设置</span>
        </button>
      </div>
    </nav>
  );
}

/**
 * The open conversation is not there once loaded: it disappeared (I left or was removed: `gone`, or missing from a sync), or its
 * address was opened (a link, a reload, a Forward) for one that is not mine. The list is shown, nothing of it stays on screen, the
 * entry is made the list (no Forward to it), and the reason is said once.
 */
function useCloseWhenRemoved(state, dispatch) {
  const { convId, section } = state.nav;
  const present = Boolean(convId && state.convs[convId]);
  const shown = useRef(null);
  useEffect(() => {
    if (present) {
      shown.current = convId;
      return;
    }
    // (No conversation is open: whatever was on screen before is not "removed" when a Back arrives at it later.)
    if (!convId) {
      shown.current = null;
      return;
    }
    if (!state.loaded || state.nav.opening) return;
    const was = convId === shown.current;
    shown.current = null;
    // The page is gone: the entry it is in becomes its parent (once: a replace carried by the move itself).
    dispatch({ type: "nav", replace: true, patch: { convId: null, view: "chat", detailsOpen: false, pane: "list" } });
    // (Removed: the notice says so. An address that never was mine: it cannot say "no longer".)
    // (A conversation I left on purpose says nothing at all.)
    if (section === "chat" && !state.left?.includes(convId)) dispatch({ type: "toast", text: was ? "你已不在该会话中" : "找不到这个会话，或你已不在其中" });
  }, [convId, present, section, state.loaded, state.nav.opening, dispatch]);
}

/** How long a conversation I asked for (a new group, a friend's chat) may take to arrive before I stop waiting. */
export const OPENING_WAIT_MS = 8000;

/**
 * `nav.opening` ({convId} or {peerId}) names a conversation the screen wants to show as soon as it is in state
 * (created or accepted a moment ago). It opens it, or gives up after OPENING_WAIT_MS.
 */
function useOpenWhenPresent(state, dispatch) {
  const { opening } = state.nav;
  const target = opening
    ? opening.convId
      ? state.convs[opening.convId]
      : Object.values(state.convs).find((c) => c.type === "human" && c.peerId === opening.peerId)
    : null;
  const targetId = target?.id ?? null;
  useEffect(() => {
    if (!opening || !targetId) return;
    dispatch({ type: "nav/openConv", convId: targetId, patch: { opening: null } });
  }, [opening, targetId, dispatch]);
  useEffect(() => {
    if (!opening) return undefined;
    const handle = window.setTimeout(() => {
      dispatch({ type: "nav", patch: { opening: null } });
      dispatch({ type: "toast", text: "会话还没有同步下来，请稍后在消息列表里查看" });
    }, OPENING_WAIT_MS);
    return () => window.clearTimeout(handle);
  }, [opening, dispatch]);
}

/** A detached search window belongs to the conversation that is open: once another one is, the window is dropped. */
function useDropStrayWindows(state, actions) {
  const stray = Object.values(state.convs)
    .filter((c) => c.detached && c.id !== state.nav.convId)
    .map((c) => c.id)
    .join(",");
  useEffect(() => {
    for (const id of stray ? stray.split(",") : []) actions.closeWindow(id);
  }, [stray, actions]);
}

/**
 * The list a page was pushed over keeps its place: where one column shows the list or the page, the list is `display: none`
 * while a page is open, and a browser forgets the scroll of what it hid. The place is noted as the list is scrolled and put
 * back when the list shows again (Back from a conversation).
 */
function useKeepListScroll(pane, section) {
  const saved = useRef({ section: null, top: 0 });
  const note = (e) => {
    if (pane === "list" && e.target.classList?.contains("rows")) saved.current = { section, top: e.target.scrollTop };
  };
  useLayoutEffect(() => {
    if (pane !== "list" || saved.current.section !== section) return;
    const rows = document.querySelector(".list-col .rows");
    if (rows && saved.current.top > 0 && rows.scrollTop !== saved.current.top) rows.scrollTop = saved.current.top;
  }, [pane, section]);
  return note;
}

/**
 * The chat an address names, before the first sync has said what there is: its own shell — the header with 返回列表 and, inside, the same
 * loading and cannot-connect states the lists have (ui/primitives.jsx `LoadingRow`) — so a page that never syncs is still one a person can leave.
 */
function PendingChat() {
  const up = useUp();
  return (
    <section className="chat" aria-label="会话">
      <header className="chat-head">
        <IconBtn label="返回列表" className="only-mobile" onClick={up}>
          <ChevronLeft size={22} />
        </IconBtn>
      </header>
      <ul className="rows">
        <LoadingRow />
      </ul>
    </section>
  );
}

/** The signed-in application: rail, list, chat and side panel. Loaded on demand (see App.jsx). */
export default function Shell() {
  const { state, dispatch, actions } = useStore();
  useCloseWhenRemoved(state, dispatch);
  useOpenWhenPresent(state, dispatch);
  useDropStrayWindows(state, actions);
  useShellOpen(); // (A tapped notification of the iOS app: nothing in a browser.)
  const { nav } = state;
  const conv = state.convs[nav.convId];
  const phone = usePhone();
  // A phone shows one page at a time: the tab bar belongs to the top-level lists, not to a conversation or any page pushed
  // over them (those have their back button). A conversation that is gone leaves the list, not an empty page without a way out.
  // (Until the first sync has said what there is, an address's chat is drawn as itself — empty — not as the list it would fall back to.)
  const emptyChat = nav.section === "chat" && !conv && state.loaded;
  const pane = emptyChat ? "list" : nav.pane;
  const tabbar = phone && pane === "list";
  // The address is where a person is (state/location.js); Back and the edge swipe walk its entries (state/appHistory.js).
  useAppHistory({ nav, dispatch, resolves: (page) => !state.loaded || alive(state, page) });
  // An address of a page that is not here (a conversation removed or never mine, a Forward to it, a contact nobody knows, an Agent that is not
  // mine, group info of a conversation that is not a group): the section's list or the conversation, once, with the reason; the entry is
  // made that page so that nothing shows it again.
  const seenPages = useRef(new Set());
  const askedPeople = useRef({ id: null, done: false });
  const [peopleRead, setPeopleRead] = useState(0);
  useEffect(() => {
    if (!state.loaded || nav.opening || nav.pane !== "main") return;
    // (A contact or an Agent that was on screen and went away says nothing more than its card or page already does; one never here says so.)
    const key = nav.section === "contacts" ? `c:${nav.contactId}` : `a:${nav.agentId}`;
    const was = seenPages.current.has(key);
    if (nav.section === "contacts" && entity(state, nav.contactId)) seenPages.current.add(key);
    if (nav.section === "agents" && isMyAgent(state, nav.agentId)) seenPages.current.add(key);
    const fall = (patch, text) => {
      dispatch({ type: "nav", replace: true, patch });
      if (text) dispatch({ type: "toast", text });
    };
    if (nav.section === "chat" && nav.view === "profile" && conv && conv.type !== "group") fall({ view: "chat" }, null);
    else if (nav.section === "contacts" && nav.contactId && !entity(state, nav.contactId)) {
      // A person this client has not heard of may be one my use page lists (someone who called my Agent, someone I stopped: their profile is
      // where 停止往来 and 恢复往来 live). While Agent social is on, that list is read once for the address before it is given up: the read
      // puts its people into the model (data/actions.js `getOthersUse`), and this effect runs again with them.
      const asked = askedPeople.current;
      if (socialOn(state) && asked.id !== nav.contactId) {
        asked.id = nav.contactId;
        asked.done = false;
        readOthersUse(actions, storeOf(actions)).then(() => {
          asked.done = true;
          setPeopleRead((n) => n + 1);
        });
      } else if (!socialOn(state) || asked.done) fall({ contactId: null, pane: "list" }, was ? null : "找不到这位联系人");
    }
    else if (nav.section === "agents" && nav.agentView !== "create" && nav.agentId && !isMyAgent(state, nav.agentId)) fall({ agentId: null, agentView: "detail", pane: "list" }, was ? null : "找不到这个 Agent");
  }, [state.loaded, state.convs, state.agents, state.people, conv, nav.section, nav.pane, nav.convId, nav.view, nav.contactId, nav.agentId, nav.agentView, nav.opening, dispatch, actions, state.social, peopleRead]);
  const noteScroll = useKeepListScroll(pane, nav.section);
  const oneColumn = useMediaQuery(`(max-width: ${ONE_COLUMN_MAX}px)`);
  let list = null;
  let main = null;
  let side = null;

  if (nav.section === "chat") {
    list = <ChatList />;
    if (!conv) main = nav.convId && !state.loaded ? <PendingChat /> : <div className="empty-main">选择一个会话开始聊天</div>;
    else if (nav.view === "profile") main = <GroupProfile conv={conv} />;
    else {
      main = <ChatView conv={conv} />;
      if (nav.detailsOpen) side = <DetailsPanel conv={conv} />;
    }
  } else if (nav.section === "contacts") {
    list = <ContactsList />;
    main = <ContactCard />;
  } else if (nav.section === "agents") {
    list = <AgentsList />;
    main = <AgentMain />;
  } else {
    list = <SettingsList />;
    main = <SettingsMain />;
  }

  // A change of page moves the focus somewhere sensible and names the page (ui/routeFocus.js); the tab's title is the page's.
  const address = addressOf(nav);
  const overlay = side && pane === "main" ? "details" : null;
  const { label, title } = pageTitle(state);
  // (What is drawn decides, not the address: an address of a page that is not here draws the list, and that is no change.)
  const drawn = pane === "main" ? keyOf({ path: address.path, overlay }) : `${nav.section}:list`;
  const announcer = useRouteFocus({ where: { key: drawn, path: address.path, pane, overlay }, label, title });
  // In one column the details panel covers the whole conversation: the conversation under it is inert.
  const covered = Boolean(overlay) && oneColumn;

  return (
    <div className="app" data-pane={pane} data-side={side ? "open" : "closed"} data-tabbar={tabbar ? "on" : "off"}>
      {!phone && <Rail phone={false} />}
      <aside className="list-col" onScrollCapture={noteScroll}>{list}</aside>
      <main className="main-col" inert={covered || undefined}>{main}</main>
      {side && pane === "main" && <aside className="side-col">{side}</aside>}
      {/* (On a phone the tab bar comes after the pages, in the page's order as well as on screen.) */}
      {tabbar && <Rail phone />}
      <p className="sr-only" aria-live="polite" data-route-announcer="" ref={announcer} />
      <ToastRegion />
    </div>
  );
}
