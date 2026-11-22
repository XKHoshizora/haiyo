import React, { useRef, useState } from "react";
import { useUp } from "../state/appHistory.js";
import { useStore } from "../data/store.jsx";
import { friendErrorText } from "../data/errorTexts.js";
import { expiryText } from "../data/viewmodel.js";
import { ME } from "../data/identities.js";
import { entity, myAgents, nameOf } from "../state/selectors.js";
import {
  blockedMe,
  directConvWith,
  friendIds,
  iBlocked,
  incomingRequests,
  matchesPerson,
  outgoingRequests,
  requestWith,
  relationOf,
} from "../state/social.js";
import { Avatar, LoadingRow, Tag, Btn, IconBtn, Modal, Notice, Reason, KV } from "../ui/primitives.jsx";
import { ListHeader, SearchBox } from "./ChatList.jsx";
import { BlockModal } from "./BlockModal.jsx";
import { AddFriendModal } from "./AddFriendModal.jsx";
import { useAction, useNow } from "./useAction.js";
import { openAgentChat } from "./AgentForm.jsx";
import { ChevronLeft, UserPlus } from "../icons.js";

const REL = {
  friend: ["已是好友", "ok"],
  outgoing: ["待对方确认", "pending"],
  incoming: ["待你确认", "pending"],
};

export function ContactsList() {
  const { state, dispatch, actions } = useStore();
  const [query, setQuery] = useState("");
  const addButton = useRef(null);
  const now = useNow();
  const open = (id) => dispatch({ type: "nav", patch: { contactId: id, pane: "main" } });
  const visible = (id) => id !== ME && state.people[id] && matchesPerson(state.people[id], query);

  const incoming = incomingRequests(state);
  const outgoing = outgoingRequests(state);
  const requests = [...incoming.map((r) => ({ ...r, kind: "incoming" })), ...outgoing.map((r) => ({ ...r, kind: "outgoing" }))].filter((r) => visible(r.id));
  const allFriends = friendIds(state);
  const friends = allFriends.filter(visible);
  // My own Agents (never someone else's from a group), below my friends as in the prototype; a deleted one is not a contact.
  const allAgents = myAgents(state).filter((a) => !a.deleted);
  const agents = allAgents.filter((a) => matchesPerson(a, query));
  const nothing = allFriends.length === 0 && incoming.length === 0 && outgoing.length === 0 && allAgents.length === 0;

  return (
    <>
      <ListHeader
        title="通讯录"
        action={
          <IconBtn ref={addButton} label="添加好友" className="boxed" onClick={() => dispatch({ type: "nav", patch: { addFriend: true } })}>
            <UserPlus size={20} />
          </IconBtn>
        }
      />
      <SearchBox value={query} onChange={setQuery} placeholder="搜索联系人的名字或账号" />
      <ul className="rows">
        {requests.length > 0 && <li className="rows-label">待处理的申请</li>}
        {requests.map((r) => (
          <li key={`${r.kind}:${r.id}`}>
            <button type="button" className={`row ${state.nav.contactId === r.id ? "active" : ""}`} onClick={() => open(r.id)}>
              <Avatar id={r.id} size={48} />
              <span className="row-body">
                <span className="row-top">
                  <span className="row-name">{nameOf(state, r.id)}</span>
                  <Tag tone="pending">{REL[r.kind][0]}</Tag>
                </span>
                <span className="row-sub">
                  <span className="row-preview">
                    {r.kind === "incoming" ? "申请添加你为好友" : "你发起的申请"} · {expiryText(r.expiresAt, now)}
                  </span>
                </span>
              </span>
            </button>
          </li>
        ))}
        {friends.length > 0 && <li className="rows-label">好友</li>}
        {friends.map((id) => (
          <li key={id}>
            <button type="button" className={`row ${state.nav.contactId === id ? "active" : ""}`} onClick={() => open(id)}>
              <Avatar id={id} size={48} />
              <span className="row-body">
                <span className="row-top">
                  <span className="row-name">{nameOf(state, id)}</span>
                  <Tag tone="human">真人</Tag>
                </span>
                <span className="row-sub">
                  <span className="row-preview">
                    {state.people[id].handle}
                    {iBlocked(state, id) ? " · 已拉黑" : blockedMe(state, id) ? " · 对方拉黑了你" : ""}
                  </span>
                </span>
              </span>
            </button>
          </li>
        ))}
        {agents.length > 0 && <li className="rows-label">我的 Agent</li>}
        {agents.map((a) => (
          <li key={a.id}>
            <button type="button" className="row" onClick={() => openAgentChat(state, dispatch, actions, a.conversationId)}>
              <Avatar id={a.id} size={48} />
              <span className="row-body">
                <span className="row-top">
                  <span className="row-name">{a.name}</span>
                  <Tag>Agent</Tag>
                </span>
                <span className="row-sub">
                  <span className="row-preview">
                    {a.handle}
                    {a.paused ? " · 已暂停" : ""}
                  </span>
                </span>
              </span>
            </button>
          </li>
        ))}
        {requests.length === 0 && friends.length === 0 && agents.length === 0 && !state.loaded && !query.trim() && (
          <LoadingRow />
        )}
        {requests.length === 0 && friends.length === 0 && agents.length === 0 && (state.loaded || query.trim()) && (
          <li className="rows-empty">{nothing && !query.trim() ? "还没有联系人，点右上角的按钮添加好友" : "没有找到匹配的联系人"}</li>
        )}
      </ul>
      {/* (Opened from the chat list's menu too: the focus then comes back to this list's own 添加好友.) */}
      {state.nav.addFriend && <AddFriendModal returnTo={() => addButton.current} onClose={() => dispatch({ type: "nav", patch: { addFriend: false } })} />}
    </>
  );
}

export function ContactCard() {
  const { state, dispatch, actions } = useStore();
  const up = useUp();
  const id = state.nav.contactId;
  const who = entity(state, id);
  const { busy, run } = useAction();
  const now = useNow();
  const [dialog, setDialog] = useState(null); // "block" | "unfriend"
  if (!who || id === ME) return <div className="empty-main">选择一位联系人</div>;

  const rel = relationOf(state, id);
  const request = requestWith(state, id);
  const blocked = iBlocked(state, id);
  const blockedByThem = blockedMe(state, id);
  const handle = who.handle.replace(/^@/, "");
  const applyReason = blocked ? "你已拉黑对方，需先解除拉黑" : blockedByThem ? "对方拉黑了你，无法发送申请" : "";

  const go = async (key, work, action, done) => {
    const res = await run(key, work, (e) => friendErrorText(action, e));
    if (res.ok && done) dispatch({ type: "toast", text: done });
  };
  const openChat = () => {
    const conv = directConvWith(state, id);
    if (conv) {
      dispatch({ type: "nav/openConv", convId: conv.id });
      return;
    }
    // The chat exists once you are friends; this client has not heard of it yet: fetch, then open it when it arrives.
    dispatch({ type: "nav", patch: { opening: { peerId: id } } });
    actions.syncNow();
  };

  return (
    <section className="page" aria-label="联系人卡片">
      <button type="button" className="back only-mobile" onClick={up}>
        <ChevronLeft size={20} aria-hidden="true" /> 返回通讯录
      </button>
      <header className="profile-head">
        <Avatar id={id} size={84} />
        <div>
          <p className="eyebrow">联系人卡片</p>
          <h2>
            {who.name} <Tag tone="human">真人</Tag> {blocked && <Tag tone="warn">已拉黑</Tag>}
            {blockedByThem && <Tag tone="warn">对方拉黑了你</Tag>}
          </h2>
          <p className="muted">{who.handle}</p>
        </div>
      </header>
      <div className="page-body">
        <KV
          rows={[
            ["身份", "真人账户"],
            ["这段会话谁能看", `你与${who.name}两位真人`],
          ]}
        />

        <h3>联系与申请</h3>
        {!rel && <p className="muted">你们还没有建立联系。</p>}
        {rel && (
          <ul className="rel-rows">
            <li>
              <Avatar id={id} size={36} />
              <div className="member-body">
                <strong>{rel === "incoming" ? `${who.name} → 你` : rel === "outgoing" ? `你 → ${who.name}` : `你与${who.name}`}</strong>
                <p className="muted">
                  {rel === "incoming"
                    ? `对方发起 · ${request.at} · 需要你确认 · ${expiryText(request.expiresAt, now)}`
                    : rel === "outgoing"
                      ? `你发起 · ${request.at} · 等待${who.name}确认 · ${expiryText(request.expiresAt, now)}`
                      : "关系已建立，可以互相发送消息"}
                </p>
              </div>
              <Tag tone={REL[rel][1]}>{REL[rel][0]}</Tag>
              <div className="member-actions">
                {rel === "outgoing" && (
                  <Btn small disabled={busy !== null} onClick={() => go("withdraw", () => actions.withdrawFriendRequest(request.requestId), "withdraw", "已撤回申请")}>
                    {busy === "withdraw" ? "处理中…" : "撤回"}
                  </Btn>
                )}
                {rel === "incoming" && (
                  <>
                    <Btn small variant="primary" disabled={busy !== null} onClick={() => go("accept", () => actions.acceptFriendRequest(request.requestId), "accept", `已添加${who.name}为好友`)}>
                      {busy === "accept" ? "处理中…" : "同意"}
                    </Btn>
                    <Btn small disabled={busy !== null} onClick={() => go("reject", () => actions.rejectFriendRequest(request.requestId), "reject", "已拒绝申请")}>
                      {busy === "reject" ? "处理中…" : "拒绝"}
                    </Btn>
                  </>
                )}
                {rel === "friend" && (
                  <>
                    <Btn small variant="primary" onClick={openChat}>发消息</Btn>
                    <Btn small disabled={busy !== null} onClick={() => setDialog("unfriend")}>解除好友</Btn>
                  </>
                )}
              </div>
            </li>
          </ul>
        )}

        {!rel && (
          <div className="apply-box">
            <Btn
              variant="primary"
              disabled={Boolean(applyReason) || busy !== null}
              reason={applyReason}
              onClick={() => go("apply", () => actions.sendFriendRequest(handle), "sendRequest", "好友申请已发送")}
            >
              <UserPlus size={16} aria-hidden="true" /> {busy === "apply" ? "发送中…" : "添加好友"}
            </Btn>
            <Reason>{applyReason}</Reason>
          </div>
        )}

        <h3>拉黑</h3>
        {blockedByThem && <Notice tone="warn">{who.name}拉黑了你，只能由对方解除。你们之间不能发送新消息，也不能互相申请好友。</Notice>}
        {blocked ? (
          <Notice tone="warn" action={<Btn small onClick={() => setDialog("block")}>解除拉黑</Btn>}>
            你已拉黑{who.name}：你们之间不能发送新消息，已有历史不受影响。
          </Notice>
        ) : (
          <div className="stack-actions">
            <Btn variant="danger" onClick={() => setDialog("block")}>拉黑{who.name}</Btn>
            <Reason>只有你可以解除自己的拉黑。</Reason>
          </div>
        )}
      </div>
      {dialog === "block" && <BlockModal target={id} onClose={() => setDialog(null)} />}
      {dialog === "unfriend" && <UnfriendModal id={id} name={who.name} onClose={() => setDialog(null)} />}
    </section>
  );
}

function UnfriendModal({ id, name, onClose }) {
  const { actions, dispatch } = useStore();
  const { busy, run } = useAction();
  const confirm = async () => {
    const res = await run("unfriend", () => actions.removeFriend(id), (e) => friendErrorText("unfriend", e));
    if (res.ok) {
      dispatch({ type: "toast", text: "已解除好友关系" });
      onClose();
    }
  };
  return (
    <Modal
      title={`解除与${name}的好友关系`}
      onClose={onClose}
      footer={
        <>
          <Btn data-autofocus onClick={onClose}>取消</Btn>
          <Btn variant="danger" disabled={busy !== null} onClick={confirm}>
            {busy !== null ? "处理中…" : "确认解除"}
          </Btn>
        </>
      }
    >
      <p>解除后，你们的私聊记录会保留，但双方都不能再发送新消息；需要重新申请并由对方同意才能恢复。</p>
    </Modal>
  );
}
