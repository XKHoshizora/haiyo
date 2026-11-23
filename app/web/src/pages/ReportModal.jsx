// Report an Agent (plan A12b; design §1.3): one of four reasons and an optional note of at most 500 characters. Nothing the Agent's owner
// does or sees changes, and nothing is told to them. Opened only while the site's Agent social switch is on (its caller shows no control otherwise).
import React, { useState } from "react";
import { useStore } from "../data/store.jsx";
import { socialErrorText } from "../data/errorTexts.js";
import { nameOf } from "../state/selectors.js";
import { Btn, Modal } from "../ui/primitives.jsx";
import { useAction } from "./useAction.js";

/** The four reasons of `POST /api/reports`, with their words. */
export const REPORT_REASONS = [
  ["spam", "垃圾信息或广告"],
  ["harassment", "骚扰"],
  ["privacy", "泄露隐私"],
  ["other", "其他"],
];
export const REPORT_NOTE_MAX = 500;

/** @param {{agentId: string, onClose: () => void, returnTo?: () => (HTMLElement | null)}} props */
export function ReportModal({ agentId, onClose, returnTo }) {
  const { state, actions, dispatch } = useStore();
  const { busy, run } = useAction();
  const [reason, setReason] = useState("spam");
  const [note, setNote] = useState("");
  const name = nameOf(state, agentId);
  const submit = async () => {
    const body = { agentId, reason, ...(note.trim() ? { note: note.trim() } : {}) };
    const text = (e) => (e?.code === "not_found" ? "举报没有提交成功，这个 Agent 可能已被删除。" : socialErrorText(e));
    const res = await run("report", () => actions.reportAgent(body), text);
    if (!res.ok) return;
    dispatch({ type: "toast", text: "已提交举报" });
    onClose();
  };
  return (
    <Modal
      title={`举报${name}`}
      onClose={onClose}
      returnTo={returnTo}
      locked={busy !== null}
      footer={
        <>
          <Btn data-autofocus disabled={busy !== null} onClick={onClose}>取消</Btn>
          <Btn variant="primary" disabled={busy !== null} onClick={submit}>
            {busy !== null ? "提交中…" : "提交举报"}
          </Btn>
        </>
      }
    >
      <fieldset className="social-policy social-ui">
        <legend>举报的原因</legend>
        {REPORT_REASONS.map(([value, label]) => (
          <label key={value} className="social-option">
            <input type="radio" name="report-reason" value={value} checked={reason === value} onChange={() => setReason(value)} />
            <span>{label}</span>
          </label>
        ))}
      </fieldset>
      <label className="field social-note-field">
        <span>补充说明（可不填）</span>
        <textarea value={note} maxLength={REPORT_NOTE_MAX} rows={3} onChange={(e) => setNote(e.target.value)} aria-describedby="report-note-count" />
        <small id="report-note-count" className="muted">
          {note.length} / {REPORT_NOTE_MAX}
        </small>
      </label>
    </Modal>
  );
}
