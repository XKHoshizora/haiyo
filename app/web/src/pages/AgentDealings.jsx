// 停止往来 and 恢复往来 on a person's profile (plan A12b; Controller ruling 2026-11-25 (B-5 review): the profile is the ONE place for them). A stop is the caller's own
// act: no access between the two of them, in either direction, for any Agent of either, until the caller lifts it. Only the caller's own stop
// is ever shown, and only as theirs: nothing here says whether the other person has stopped or blocked them (to them it only reads
// "unavailable"). Nothing is drawn, and no route called, while the site's Agent social switch is off.
import React, { useEffect, useState } from "react";
import { useStore } from "../data/store.jsx";
import { socialErrorText } from "../data/errorTexts.js";
import { readOthersUse, storeOf } from "../data/othersUseCache.js";
import { socialOn } from "../state/social.js";
import { Btn, Modal, Notice } from "../ui/primitives.jsx";
import { useAction } from "./useAction.js";

/**
 * Offered for ANY person whose profile is drawn, whatever stands between us (a friend, a stranger who only called my Agent in a group): the
 * profile is the one place where the act lives, and the use page links here.
 * @param {{personId: string, name: string}} props
 */
export function DealingsSection({ personId, name }) {
  const { state, actions, dispatch } = useStore();
  const { busy, run } = useAction();
  const on = socialOn(state);
  /**
   * Whether I stopped this person: my own list (`GET /api/me/others-use`, `stopped`), through the one read the screen shares
   * (data/othersUseCache.js), asked for when this profile opens. The answer is kept with whose it is: for anyone else it reads as not known
   * (A-5 re-review I1), and so does a read that failed, whatever an earlier one said.
   */
  const [answer, setAnswer] = useState({ id: null, value: null });
  const stopped = answer.id === personId ? answer.value : null;
  const setStopped = (value) => setAnswer({ id: personId, value });
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    if (!on) return undefined;
    let alive = true;
    const store = storeOf(actions);
    readOthersUse(actions, store).then(() => {
      if (alive && !store.failed && Array.isArray(store.use?.stopped)) setAnswer({ id: personId, value: store.use.stopped.some((s) => s?.person?.id === personId) });
    });
    return () => {
      alive = false;
    };
  }, [on, actions, personId]);

  if (!on) return null;
  // Only once it is known whether I stopped this person (A-5 review m3b): never a control whose effect the page cannot know. With the list
  // known there is exactly one of the two.
  if (stopped === null) return null;

  // A stop and a resume are writes the shared read must hear of (the use page and the list of my Agents show the same answer): read again,
  // after anything in flight.
  const told = () => void readOthersUse(actions, storeOf(actions), { afterWrite: true });
  const stop = async () => {
    const res = await run("stop", () => actions.putBar(personId), (e) => socialErrorText(e));
    if (!res.ok) return;
    setStopped(true);
    setAsking(false);
    told();
    dispatch({ type: "toast", text: "已停止往来" });
  };
  const resume = async () => {
    const res = await run("resume", () => actions.deleteBar(personId), (e) => (e?.code === "not_found" ? "你现在没有停止和对方往来。" : socialErrorText(e)));
    if (res.ok) {
      setStopped(false);
      told();
      dispatch({ type: "toast", text: "已恢复往来。想再聊，要重新加对方的 Agent。" });
    } else if (res.error?.code === "not_found") {
      setStopped(false);
      told();
    }
  };

  return (
    <>
      <h3>Agent 往来</h3>
      {stopped === true ? (
        <Notice tone="info" action={<Btn small disabled={busy !== null} onClick={resume}>{busy === "resume" ? "处理中…" : "恢复往来"}</Btn>}>
          你已停止和{name}往来：你们各自的 Agent 都不会再回应对方。
        </Notice>
      ) : (
        <div className="stack-actions">
          <Btn disabled={busy !== null} onClick={() => setAsking(true)}>停止往来</Btn>
          <p className="muted">停止后，你的 Agent 不再回应对方，对方的 Agent 也不再回应你。</p>
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
            <li>你的 Agent 不再回应{name}，{name}的 Agent 也不再回应你。</li>
            <li>恢复往来后，已经停下的对话不会自己回来。想再聊，要重新加对方的 Agent，等它的主人同意。</li>
            <li>想恢复时，到对方的资料页点“恢复往来”。已停止往来的人列在“设置 › 别人怎么用我的 Agent”里。</li>
          </ul>
        </Modal>
      )}
    </>
  );
}
