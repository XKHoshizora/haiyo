import React, { useState } from "react";
import { useStore } from "../data/store.jsx";
import { friendErrorText } from "../data/errorTexts.js";
import { HANDLE_PATTERN } from "../auth/validation.js";
import { Avatar, Btn, Field, Modal, Reason, Tag } from "../ui/primitives.jsx";
import { blockedMe, iBlocked, relationOf } from "../state/social.js";
import { useAction } from "./useAction.js";

/** What stops me from sending this person a request, or "" when I can. */
function whyNot(state, person) {
  if (person.id === state.account?.id) return "这是你自己的账号。";
  if (iBlocked(state, person.id)) return "你已拉黑对方，需先解除拉黑。";
  if (blockedMe(state, person.id)) return "对方拉黑了你，无法发送申请。";
  const rel = relationOf(state, person.id);
  if (rel === "friend") return "你们已经是好友了。";
  if (rel === "outgoing") return "申请已发送，等待对方确认。";
  if (rel === "incoming") return "对方已向你发来申请，请在通讯录里处理。";
  return "";
}

/** Exact account-name lookup → the person's card → send a friend request. */
export function AddFriendModal({ onClose, returnTo }) {
  const { state, actions, dispatch } = useStore();
  const { busy, run } = useAction();
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [found, setFound] = useState(null);

  const search = async (event) => {
    event.preventDefault();
    if (busy !== null) return;
    const handle = text.trim().toLowerCase().replace(/^@/, "");
    setFound(null);
    if (!HANDLE_PATTERN.test(handle)) {
      setError("账号名由 3–24 位小写字母、数字或下划线组成。");
      return;
    }
    setError("");
    const res = await run("lookup", () => actions.lookupPrincipal(handle), () => "");
    if (res.ok) setFound(res.value);
    else setError(res.error?.code === "not_found" ? `没有找到账号名为 ${handle} 的用户。目前还不能添加 Agent 为好友。` : friendErrorText("lookup", res.error));
  };

  const send = async () => {
    const res = await run("send", () => actions.sendFriendRequest(found.handle), (e) => friendErrorText("sendRequest", e));
    if (res.ok) dispatch({ type: "toast", text: "好友申请已发送" });
  };

  const reason = found ? whyNot(state, found) : "";
  return (
    <Modal title="添加好友" onClose={onClose} returnTo={returnTo} footer={<Btn onClick={onClose}>完成</Btn>}>
      <form onSubmit={search}>
        <Field label="对方的账号名" error={error} hint="输入完整的账号名（不是昵称），例如 ann_li。">
          <input value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck="false" data-autofocus />
        </Field>
        <Btn type="submit" variant="primary" disabled={busy !== null || !text.trim()}>
          {busy === "lookup" ? "查找中…" : "查找"}
        </Btn>
      </form>
      {found && (
        <ul className="member-rows" aria-label="查找结果">
          <li>
            <Avatar id={found.id} size={48} />
            <div className="member-body">
              <strong>{state.people[found.id]?.name ?? found.displayName}</strong> <Tag tone="human">真人</Tag>
              <p className="muted">@{found.handle}</p>
            </div>
            <div className="member-actions">
              <Btn small variant="primary" disabled={Boolean(reason) || busy !== null} reason={reason} onClick={send}>
                {busy === "send" ? "发送中…" : "发送好友申请"}
              </Btn>
            </div>
          </li>
        </ul>
      )}
      {found && <Reason>{reason}</Reason>}
    </Modal>
  );
}
