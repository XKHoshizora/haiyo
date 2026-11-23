import React, { useState } from "react";
import { useStore } from "../data/store.jsx";
import { friendErrorText, socialErrorText } from "../data/errorTexts.js";
import { HANDLE_PATTERN, NAME_PART_PATTERN } from "../auth/validation.js";
import { Avatar, Btn, Field, Modal, Notice, Reason, Tag } from "../ui/primitives.jsx";
import { agentContactsOf, blockedMe, disclosureText, iBlocked, relationOf, socialOn } from "../state/social.js";
import { useAction } from "./useAction.js";
import { openAgentChat } from "./AgentForm.jsx";
import { daysLeft } from "./untilText.js";

/** An Agent's full account name: `<owner's handle>.<name part>`. */
const AGENT_HANDLE = new RegExp(`^${HANDLE_PATTERN.source.slice(1, -1)}\\.${NAME_PART_PATTERN.source.slice(1, -1)}$`);

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

/** What stops me from adding this Agent, or "" when I can (the service decides the rest and says so). */
function whyNotAgent(state, agent) {
  if (agent.ownerId === state.account?.id) return "你自己的 Agent 不用添加。";
  const row = agentContactsOf(state).mine.find((r) => r.agentId === agent.id);
  if (row?.state === "live") return "已经是你的联系人了。";
  if (row?.state === "requested") return "等主人同意。";
  return "";
}

/** Exact account-name lookup → the person's card (or an Agent's, with who watches it) → send a friend request, or add the Agent. */
export function AddFriendModal({ onClose, returnTo }) {
  const { state, actions, dispatch } = useStore();
  const { busy, run } = useAction();
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [found, setFound] = useState(null);
  /** What adding an Agent came to: "requested" (waiting for its owner); a let-in one opens the chat and closes this. */
  const [outcome, setOutcome] = useState(null);
  const agentsToo = socialOn(state);

  const search = async (event) => {
    event.preventDefault();
    if (busy !== null) return;
    const handle = text.trim().toLowerCase().replace(/^@/, "");
    setFound(null);
    setOutcome(null);
    if (!HANDLE_PATTERN.test(handle) && !(agentsToo && AGENT_HANDLE.test(handle))) {
      setError(agentsToo ? "账号名不对。人的账号名像 ann_li，Agent 的像 ann_li.helper。" : "账号名由 3–24 位小写字母、数字或下划线组成。");
      return;
    }
    setError("");
    // (The lookup hides my own Agent as it hides what is not there: said here, before it.)
    if (agentsToo && AGENT_HANDLE.test(handle) && handle.startsWith(`${state.account?.handle}.`)) {
      setError("你自己的 Agent 不用添加。");
      return;
    }
    const res = await run("lookup", () => actions.lookupPrincipal(handle), () => "");
    if (res.ok) setFound(res.value);
    else if (res.error?.code === "not_found") setError(agentsToo ? `没有找到账号名为 ${handle} 的用户或 Agent。` : `没有找到账号名为 ${handle} 的用户。目前还不能添加 Agent 为好友。`);
    else setError(friendErrorText("lookup", res.error));
  };

  const send = async () => {
    const res = await run("send", () => actions.sendFriendRequest(found.handle), (e) => friendErrorText("sendRequest", e));
    if (res.ok) dispatch({ type: "toast", text: "好友申请已发送" });
  };

  const add = async () => {
    const res = await run("add", () => actions.addAgentContact(found.id), (e) => socialErrorText(e));
    if (!res.ok) return;
    if (res.value?.state === "live") {
      dispatch({ type: "toast", text: "已加为联系人" });
      onClose();
      openAgentChat(state, dispatch, actions, res.value.conversationId);
    } else {
      // The outcome is said twice at most: a short toast, and one notice that says what happens next (the line under the button is left out then).
      dispatch({ type: "toast", text: "申请已发送" });
      setOutcome({ days: daysLeft(res.value?.until ?? "", Date.now()) ?? 7 });
    }
  };

  const isAgent = agentsToo && found?.kind === "agent";
  const reason = found ? (isAgent ? (outcome ? "" : whyNotAgent(state, found)) : whyNot(state, found)) : "";
  const owner = isAgent ? (found.ownerName || state.people[found.ownerId]?.name || "它的主人") : "";
  return (
    <Modal title={agentsToo ? "添加好友或 Agent" : "添加好友"} onClose={onClose} returnTo={returnTo} locked={busy === "add"} footer={<Btn disabled={busy === "add"} onClick={onClose}>完成</Btn>}>
      <form onSubmit={search}>
        <Field
          label="对方的账号名"
          error={error}
          hint={agentsToo ? "人的账号名，或 Agent 的完整账号名，例如 ann_li.helper" : "输入完整的账号名（不是昵称），例如 ann_li。"}
        >
          <input value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck="false" data-autofocus />
        </Field>
        <Btn type="submit" variant="primary" disabled={busy !== null || !text.trim()}>
          {busy === "lookup" ? "查找中…" : "查找"}
        </Btn>
      </form>
      {found && !isAgent && (
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
      {isAgent && (
        <section className="agent-found" aria-label="查找结果">
          <div className="agent-found-head">
            <Avatar id={found.id} size={48} />
            <div className="member-body">
              <strong>{found.displayName}</strong> <Tag>Agent</Tag>
              <p className="muted">@{found.handle}</p>
              <p className="muted">主人：{owner}</p>
              {found.intro ? <p className="agent-found-intro">{found.intro}</p> : null}
            </div>
          </div>
          {/* The disclosure comes before any button (design §2: the request dialog says it). */}
          <p className="social-disclosure" data-testid="social-disclosure">
            {disclosureText([owner])}
          </p>
          {outcome && <Notice tone="ok">{`已发给它的主人，等对方同意。${outcome.days} 天没有回应会自动取消。`}</Notice>}
          <div className="agent-found-actions">
            <Btn variant="primary" disabled={Boolean(reason) || outcome !== null || busy !== null} reason={reason} onClick={add}>
              {busy === "add" ? "处理中…" : "加为联系人"}
            </Btn>
          </div>
        </section>
      )}
      {found && <Reason>{reason}</Reason>}
    </Modal>
  );
}
