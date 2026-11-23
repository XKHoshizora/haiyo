// 停止往来 and 恢复往来 on a person's profile (plan A12b; design §1.2: "on their use page or the other person's profile"). A stop is the caller's own
// act: no access between the two of them, in either direction, for any Agent of either, until the caller lifts it. Only the caller's own stop
// is ever shown, and only as theirs: nothing here says whether the other person has stopped or blocked them (to them it only reads
// "unavailable"). Nothing is drawn, and no route called, while the site's Agent social switch is off.
import React, { useEffect, useState } from "react";
import { useStore } from "../data/store.jsx";
import { socialErrorText } from "../data/errorTexts.js";
import { haveAgentAccess, socialOn } from "../state/social.js";
import { Btn, Modal, Notice } from "../ui/primitives.jsx";
import { useAction } from "./useAction.js";

/** @param {{personId: string, name: string}} props */
export function DealingsSection({ personId, name }) {
  const { state, actions, dispatch } = useStore();
  const { busy, run } = useAction();
  const on = socialOn(state);
  /** Whether I stopped this person: known from my numbers page's list when it answers (it is lane B's route: when it does not, only what I did here is known). */
  const [stopped, setStopped] = useState(null);
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    if (!on) return undefined;
    let alive = true;
    actions
      .getOthersUse()
      .then((use) => {
        if (alive && Array.isArray(use?.stopped)) setStopped(use.stopped.some((s) => (s?.person?.id ?? s?.person) === personId));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [on, actions, personId]);

  if (!on) return null;
  const access = haveAgentAccess(state, personId);
  if (stopped !== true && !access) return null;

  const stop = async () => {
    const res = await run("stop", () => actions.putBar(personId), (e) => socialErrorText(e));
    if (!res.ok) return;
    setStopped(true);
    setAsking(false);
    dispatch({ type: "toast", text: "已停止往来" });
  };
  const resume = async () => {
    const res = await run("resume", () => actions.deleteBar(personId), (e) => (e?.code === "not_found" ? "你没有停止过和对方的往来。" : socialErrorText(e)));
    if (res.ok) {
      setStopped(false);
      dispatch({ type: "toast", text: "已恢复往来" });
    } else if (res.error?.code === "not_found") setStopped(false);
  };

  return (
    <>
      <h3>Agent 往来</h3>
      {stopped === true ? (
        <Notice tone="warn" action={<Btn small disabled={busy !== null} onClick={resume}>{busy === "resume" ? "处理中…" : "恢复往来"}</Btn>}>
          你已停止和{name}往来：你们各自的 Agent 都不会再回应对方。
        </Notice>
      ) : (
        <div className="stack-actions">
          <Btn disabled={busy !== null} onClick={() => setAsking(true)}>停止往来</Btn>
          <p className="muted">你们各自的 Agent 都不再回应对方，直到你恢复往来。</p>
        </div>
      )}
      {asking && (
        <Modal
          title={`停止和${name}往来`}
          onClose={() => setAsking(false)}
          locked={busy === "stop"}
          footer={
            <>
              <Btn data-autofocus disabled={busy === "stop"} onClick={() => setAsking(false)}>取消</Btn>
              <Btn variant="danger" disabled={busy === "stop"} onClick={stop}>{busy === "stop" ? "处理中…" : "停止往来"}</Btn>
            </>
          }
        >
          <ul className="plain-list">
            <li>你们各自的 Agent 之间、你和对方的 Agent 之间的对话都会停下。</li>
            <li>已经停下的对话不会自动恢复；恢复往来后要重新申请，并由对方的主人同意。</li>
            <li>你可以随时在这里恢复往来。</li>
          </ul>
        </Modal>
      )}
    </>
  );
}
