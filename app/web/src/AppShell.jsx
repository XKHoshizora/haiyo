import React, { useEffect, useLayoutEffect, useRef } from "react";
import { useStore } from "./data/store.jsx";
import { unreadTotal } from "./state/selectors.js";
import { ME } from "./data/identities.js";
import { Avatar, BrandMark } from "./ui/primitives.jsx";
import { useMediaQuery, usePhone } from "./ui/pointer.js";
import { ONE_COLUMN_QUERY, useAppHistory } from "./state/appHistory.js";
import { MessageCircle, Users, Bot, Settings } from "./icons.js";
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
  // (A phone opens 设置 at its list, like the other tabs; a wide screen shows the profile beside it at once.)
  const go = (section) => dispatch({ type: "nav", patch: { section, pane: section === "settings" && !phone ? "main" : "list" } });
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
        <button type="button" className={`rail-item ${state.nav.section === "settings" ? "active" : ""}`} onClick={() => go("settings")}>
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
 * The open conversation disappeared while loaded (I left or was removed: `gone`, or missing from a sync):
 * close it, so nothing of it stays on screen, and say why once.
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
    if (!convId || convId !== shown.current || !state.loaded) return;
    shown.current = null;
    dispatch({ type: "nav", patch: { convId: null, view: "chat", detailsOpen: false } });
    if (section === "chat") dispatch({ type: "toast", text: "你已不在该会话中" });
  }, [convId, present, section, state.loaded, dispatch]);
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

/** The signed-in application: rail, list, chat and side panel. Loaded on demand (see App.jsx). */
export default function Shell() {
  const { state, dispatch, actions } = useStore();
  useCloseWhenRemoved(state, dispatch);
  useOpenWhenPresent(state, dispatch);
  useDropStrayWindows(state, actions);
  const { nav } = state;
  const conv = state.convs[nav.convId];
  const phone = usePhone();
  // A phone shows one page at a time: the tab bar belongs to the top-level lists, not to a conversation or any page pushed
  // over them (those have their back button). A conversation that is gone leaves the list, not an empty page without a way out.
  const emptyChat = nav.section === "chat" && !conv;
  const pane = phone && emptyChat ? "list" : nav.pane;
  const tabbar = phone && pane === "list";
  // Back and the edge swipe walk the pages of one column (a conversation, group info, a settings page); the address follows the conversation.
  useAppHistory({ nav, oneColumn: useMediaQuery(ONE_COLUMN_QUERY), dispatch });
  const noteScroll = useKeepListScroll(pane, nav.section);
  let list = null;
  let main = null;
  let side = null;

  if (nav.section === "chat") {
    list = <ChatList />;
    if (!conv) main = <div className="empty-main">选择一个会话开始聊天</div>;
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

  return (
    <div className="app" data-pane={pane} data-side={side ? "open" : "closed"} data-tabbar={tabbar ? "on" : "off"}>
      {(!phone || tabbar) && <Rail phone={phone} />}
      <aside className="list-col" onScrollCapture={noteScroll}>{list}</aside>
      <main className="main-col">{main}</main>
      {side && <aside className="side-col">{side}</aside>}
      {state.toast && (
        <div className="toast" role="status" aria-live="polite">
          {state.toast.text}
        </div>
      )}
    </div>
  );
}
