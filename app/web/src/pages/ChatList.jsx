import React, { useEffect, useMemo, useRef, useState } from "react";
import { PRODUCT_NAME } from "../brand.js";
import { useStore } from "../data/store.jsx";
import { agentDeleted, quiet, convTitle, entity, lastPreview, TYPE_LABEL, otherMember } from "../state/selectors.js";
import { ConvAvatar, IconBtn, LoadingRow, Tag } from "../ui/primitives.jsx";
import { Plus, Search, UserPlus, Users } from "../icons.js";
import { NewGroupModal } from "./GroupModals.jsx";
import { GlobalHitRow, SearchFooter } from "./SearchHits.jsx";
import { useJumpTo } from "./useJumpTo.js";
import { useMessageSearch } from "./useMessageSearch.js";
import { searchHitView } from "../data/viewmodel.js";

const FILTERS = [
  ["all", "全部"],
  ["unread", "未读"],
  ["group", "群聊"],
];

export function ListHeader({ title, action }) {
  return (
    <header className="list-head">
      <p className="brand-name">{PRODUCT_NAME}</p>
      <div className="list-title">
        <h1>{title}</h1>
        {action}
      </div>
    </header>
  );
}

export function SearchBox({ value, onChange, placeholder }) {
  return (
    <label className="search">
      <Search size={18} aria-hidden="true" />
      <input type="search" maxLength={100} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} />
    </label>
  );
}

export function Pills({ options, value, onChange, label }) {
  return (
    <div className="pills" role="tablist" aria-label={label}>
      {options.map(([id, text]) => (
        <button key={id} type="button" role="tab" tabIndex={value === id ? 0 : -1} aria-selected={value === id} className={value === id ? "active" : ""} onClick={() => onChange(id)} onKeyDown={e=>{
          if (!["ArrowLeft","ArrowRight","Home","End"].includes(e.key)) return;
          e.preventDefault();
          const i=options.findIndex(([key])=>key===id);
          const next=e.key==="Home"?0:e.key==="End"?options.length-1:(i+(e.key==="ArrowRight"?1:-1)+options.length)%options.length;
          onChange(options[next][0]);
          const button=e.currentTarget.parentElement.querySelectorAll('[role="tab"]')[next];
          button.focus();button.scrollIntoView({block:"nearest",inline:"nearest"});
        }}>
          {text}
        </button>
      ))}
    </div>
  );
}

/** Local filter: the conversation's name, a direct chat's account name (@handle), the last message, or 私聊/群聊. */
function matches(state, conv, q) {
  if (!q) return true;
  const handle = conv.type === "human" ? entity(state, otherMember(conv))?.handle ?? "" : "";
  return [convTitle(state, conv), handle, lastPreview(state, conv), TYPE_LABEL[conv.type] ?? ""].some((text) => text.toLowerCase().includes(q));
}

export function ChatList() {
  const { state, dispatch, actions } = useStore();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  // Below the local matches: the messages that contain the text (searched at the service, in every conversation I am in).
  const search = useMessageSearch(query, (term, before) => actions.searchAll({ q: term, before }), "all");
  const hits = useMemo(() => search.hits.map((m) => searchHitView(m, { meId: state.account?.id ?? null, now: Date.now() })), [search.hits, state.account?.id]);
  const jumpTo = useJumpTo();
  const [menu, setMenu] = useState(false);
  const [newGroup, setNewGroup] = useState(false);
  const menuRef = useRef(null);
  useEffect(() => {
    if (!menu) return;
    const outside = e => { if(!menuRef.current?.contains(e.target)) setMenu(false); };
    const escape = e => { if(e.key === "Escape") { setMenu(false); menuRef.current?.querySelector('button')?.focus(); } };
    document.addEventListener("pointerdown",outside);
    document.addEventListener("keydown",escape);
    return () => {document.removeEventListener("pointerdown",outside);document.removeEventListener("keydown",escape);};
  },[menu]);
  const q = query.trim().toLowerCase();

  const rows = state.order
    .map((id) => state.convs[id])
    .filter(Boolean)
    .filter((c) => (filter === "unread" ? c.unread > 0 && !quiet(state, c) : filter === "group" ? c.type === "group" : true))
    .filter((c) => matches(state, c, q));

  return (
    <>
      <ListHeader
        title="消息"
        action={
          <div className="menu-anchor" ref={menuRef}>
            <IconBtn label="新建" className="boxed" aria-expanded={menu} onClick={() => setMenu(!menu)}>
              <Plus size={20} />
            </IconBtn>
            {menu && (
              <div className="menu" aria-label="新建选项">
                <button type="button" onClick={() => (setMenu(false), setNewGroup(true))}>
                  <Users size={16} aria-hidden="true" /> 发起群聊
                </button>
                <button type="button" onClick={() => (setMenu(false), dispatch({ type: "nav", patch: { section: "contacts", pane: "list", addFriend: true } }))}>
                  <UserPlus size={16} aria-hidden="true" /> 添加好友
                </button>
              </div>
            )}
          </div>
        }
      />
      <SearchBox value={query} onChange={setQuery} placeholder="搜索联系人、群聊" />
      <Pills options={FILTERS} value={filter} onChange={setFilter} label="会话筛选" />
      <ul className="rows">
        {rows.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              className={`row ${state.nav.convId === c.id ? "active" : ""}${quiet(state, c) ? " quiet" : ""}`}
              aria-current={state.nav.convId === c.id ? "true" : undefined}
              onClick={() => dispatch({ type: "nav/openConv", convId: c.id })}
            >
              <ConvAvatar conv={c} size={48} />
              <span className="row-body">
                <span className="row-top">
                  <span className="row-name">{convTitle(state, c)}</span>
                  {c.type === "agent" && !agentDeleted(state, c) && <Tag>Agent</Tag>}
                  {c.type === "agent" && agentDeleted(state, c) && <Tag tone="muted">已删除</Tag>}
                  <time>{c.at}</time>
                </span>
                <span className="row-sub">
                  <span className="row-preview">{lastPreview(state, c)}</span>
                  {c.unread > 0 && !quiet(state, c) && <span className="badge inline">{c.unread}</span>}
                  {/* My whispers there that wait for me (悄悄话): a small dot, gone once none is open and offering a button. */}
                  {c.openWhispers > 0 && <span className="whisper-dot" role="img" aria-label="有只给你的悄悄话" title="有只给你的悄悄话" />}
                </span>
              </span>
            </button>
          </li>
        ))}
        {/* (The empty state is for an answer that is really empty: until the first sync has answered the list is loading.) */}
        {rows.length === 0 && !state.loaded && !q && <LoadingRow />}
        {rows.length === 0 && (state.loaded || q) && <li className="rows-empty">{state.order.length === 0 && !q ? "还没有会话，点右上角的“+”添加好友或发起群聊" : "没有符合条件的会话"}</li>}
        {q && (
          <>
            <li className="rows-label">聊天记录</li>
            {hits.map((hit) => (
              <GlobalHitRow key={hit.key} hit={hit} q={search.q} onPick={(h) => jumpTo(h.conversationId, h.seq)} />
            ))}
            <SearchFooter search={search} emptyText="没有找到相关聊天记录" />
          </>
        )}
      </ul>
      {newGroup && <NewGroupModal onClose={() => setNewGroup(false)} />}
    </>
  );
}
