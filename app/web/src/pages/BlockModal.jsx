import React from "react";
import { useStore } from "../data/store.jsx";
import { isAgent, nameOf } from "../state/selectors.js";
import { iBlocked } from "../state/social.js";
import { friendErrorText } from "../data/errorTexts.js";
import { Modal, Btn, Notice } from "../ui/primitives.jsx";
import { useAction } from "./useAction.js";

/** Confirm blocking `target` (a person), or lifting my block when I have one. */
export function BlockModal({ target, onClose }) {
  const { state, actions } = useStore();
  const { busy, run } = useAction();
  const blocked = iBlocked(state, target);
  const name = nameOf(state, target);
  const agent = isAgent(state, target);
  const confirm = async () => {
    const action = blocked ? "unblock" : "block";
    const res = await run(action, () => (blocked ? actions.unblockPrincipal(target) : actions.blockPrincipal(target)), (e) => friendErrorText(action, e));
    if (res.ok) onClose();
  };
  return (
    <Modal
      title={blocked ? `解除对${name}的拉黑` : `拉黑${name}`}
      onClose={onClose}
      footer={
        <>
          <Btn data-autofocus onClick={onClose}>取消</Btn>
          <Btn variant={blocked ? "primary" : "danger"} disabled={busy !== null} onClick={confirm}>
            {busy !== null ? "处理中…" : blocked ? "解除我的拉黑" : "确认拉黑"}
          </Btn>
        </>
      }
    >
      {blocked ? (
        <>
          <p>只解除你自己的拉黑。</p>
          <Notice tone="info">如果你们仍是好友，并且对方没有拉黑你，私聊就可以继续发送；否则需要重新成为好友，或等对方解除拉黑。</Notice>
        </>
      ) : agent ? (
        <>
          <p>
            你要拉黑 <strong>{name}</strong>：
          </p>
          <ul className="plain-list">
            <li>你和它的对话会结束，你让它做的事会停下，已有历史不受影响。</li>
            <li>你也找不到它，不能再加它为联系人。</li>
            <li>你可以随时解除自己的拉黑。</li>
          </ul>
        </>
      ) : (
        <>
          <p>
            你要拉黑 <strong>{name}</strong>：
          </p>
          <ul className="plain-list">
            <li>你们之间的私聊不能再发送新消息，已有历史不受影响。</li>
            <li>你们之间待处理的好友申请会被取消，也不能再互相申请。</li>
            <li>好友关系不会自动解除。</li>
            <li>你们各自的 Agent 也不会再回应对方：在群里 @ 不到，也不会主动接对方的话。</li>
            <li>你们的私聊里会留下一条拉黑的提示；你可以随时解除自己的拉黑。</li>
          </ul>
        </>
      )}
    </Modal>
  );
}
