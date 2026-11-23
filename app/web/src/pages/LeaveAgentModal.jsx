// A visitor leaves an Agent's social conversation (plan A12b: 移除): their row on that Agent ends, so adding it again is a new request.
// Asked once, since it cannot be taken back by the person alone (the owner may have to say yes again).
import React from "react";
import { useStore } from "../data/store.jsx";
import { socialErrorText } from "../data/errorTexts.js";
import { nameOf } from "../state/selectors.js";
import { Btn, Modal } from "../ui/primitives.jsx";
import { useAction } from "./useAction.js";

/** @param {{agentId: string, onClose: () => void}} props */
export function LeaveAgentModal({ agentId, onClose }) {
  const { state, actions, dispatch } = useStore();
  const { busy, run } = useAction();
  const name = nameOf(state, agentId);
  const confirm = async () => {
    const res = await run("leave", () => actions.removeAgentContact(agentId, state.account.id), (e) => socialErrorText(e));
    if (!res.ok) return;
    dispatch({ type: "toast", text: "已移除" });
    onClose();
  };
  return (
    <Modal
      title={`移除${name}`}
      onClose={onClose}
      locked={busy !== null}
      footer={
        <>
          <Btn data-autofocus disabled={busy !== null} onClick={onClose}>取消</Btn>
          <Btn variant="danger" disabled={busy !== null} onClick={confirm}>
            {busy !== null ? "处理中…" : "确认移除"}
          </Btn>
        </>
      }
    >
      <p>移除后，你和它的对话会停下，已有的记录还在。想再聊，要重新加它，可能需要它的主人同意。</p>
    </Modal>
  );
}
