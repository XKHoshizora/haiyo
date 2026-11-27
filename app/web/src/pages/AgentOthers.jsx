// The 「别人」 tab of an Agent's page (plan A11b; design §1): who may add it (the one question), the people in, the requests waiting, and
// 「它和别人的对话」. Step 0 mounts it (Agents.jsx, while the site's Agent social switch is on and the Agent is live). Nothing here is drawn
// or asked while the switch is off; a save that would end accesses is asked first (`dryRun`) and says how many.
import React, { useEffect, useMemo, useState } from "react";
import { useStore } from "../data/store.jsx";
import { socialErrorText } from "../data/errorTexts.js";
import { untilText } from "./untilText.js";
import { lastPreview, nameOf } from "../state/selectors.js";
import { friendIds, isObserved, socialOn } from "../state/social.js";
import { Avatar, Btn, Modal, Notice, Tag } from "../ui/primitives.jsx";
import { useAction, useNow } from "./useAction.js";
import { MemoryDisclosure } from "./ShownNotes.jsx";

/** The one question and its three answers, word for word (plan "Exact copy"). */
export const POLICY_QUESTION = "谁可以添加它";
export const POLICY_OPTIONS = [
  ["ask", "需要我同意"],
  ["contacts", "我的好友可以直接添加"],
  ["none", "不让别人添加"],
];
/** Who may add it governs the conversation with it only: who may @ it in a group is the Agent's own setting 群里谁可以叫它 (and bars). */
const GROUPS_UNCHANGED = "这不改变谁能在群里 @ 它，那由“群里谁可以叫它”决定。";
const PICKED_LABEL = "只让其中几位好友";

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

/** @param {{agent: {id: string, name: string}}} props */
export function AgentOthersTab({ agent }) {
  const { state, dispatch, actions } = useStore();
  const { busy, run } = useAction();
  const now = useNow();
  const on = socialOn(state);
  /** What the service says of this Agent's contacts (`GET /api/agents/:id/contacts`); null until it came, "failed" when it could not. */
  const [held, setHeld] = useState(null);
  const [form, setForm] = useState(null);
  /** The save waiting for 确定: how many accesses it would end. */
  const [ask, setAsk] = useState(null);
  const stamp = state.agentContacts;

  // Loaded when the tab opens, and again whenever the `social` fetch brought something new (a request came, a row ended).
  useEffect(() => {
    if (!on) return undefined;
    let alive = true;
    actions
      .getAgentContacts(agent.id)
      .then((res) => {
        if (!alive) return;
        setHeld(res);
        setForm((was) => was ?? { policy: res.policy, picked: res.picked, picks: res.picks });
      })
      .catch(() => alive && setHeld((was) => was ?? "failed"));
    return () => {
      alive = false;
    };
  }, [on, actions, agent.id, stamp]);

  const friends = useMemo(() => friendIds(state).filter((id) => state.people[id]), [state]);
  const observed = useMemo(
    () =>
      state.order
        .map((id) => state.convs[id])
        .filter((c) => c && isObserved(c) && (c.social?.agents ?? []).some((a) => a.id === agent.id)),
    [state.order, state.convs, agent.id],
  );
  if (!on) return null;
  if (held === null || form === null) return <p className="muted">正在读取…</p>;
  if (held === "failed") return <Notice tone="warn">暂时读不到这些内容，请稍后再试。</Notice>;

  const changed = form.policy !== held.policy || form.picked !== held.picked || !sameSet(form.picks, held.picks);
  const body = (dryRun) => ({
    policy: form.policy,
    picked: form.policy === "contacts" && form.picked,
    picks: form.policy === "contacts" && form.picked ? form.picks : [],
    ...(dryRun ? { dryRun: true } : {}),
  });
  const reload = async () => {
    try {
      const res = await actions.getAgentContacts(agent.id);
      setHeld(res);
      setForm({ policy: res.policy, picked: res.picked, picks: res.picks });
    } catch {
      // (what is held stays; the next `social` push loads it again)
    }
  };
  const put = async () => {
    const res = await run("save", () => actions.putContactPolicy(agent.id, body(false)), (e) => socialErrorText(e));
    if (!res.ok) return;
    setAsk(null);
    dispatch({ type: "toast", text: "已保存" });
    await reload();
  };
  const save = async () => {
    const dry = await run("check", () => actions.putContactPolicy(agent.id, body(true)), (e) => socialErrorText(e));
    if (!dry.ok) return;
    if ((dry.value?.ends ?? 0) > 0) setAsk(dry.value.ends);
    else await put();
  };
  const act = async (key, work, done) => {
    const res = await run(key, work, (e) => socialErrorText(e));
    if (res.ok && done) dispatch({ type: "toast", text: done });
    if (res.ok) await reload();
  };
  const pick = (id) => setForm({ ...form, picks: form.picks.includes(id) ? form.picks.filter((x) => x !== id) : [...form.picks, id] });

  const people = held.rows.filter((r) => r.state === "live");
  const requests = held.rows.filter((r) => r.state === "requested");

  return (
    <div className="social-ui agent-others">
      {/* Before anyone is let in (ring 1b): what it may use of my notes when it talks with them, for every account. */}
      <MemoryDisclosure agentId={agent.id} name={agent.name} />
      <fieldset className="social-policy">
        <legend>{POLICY_QUESTION}</legend>
        {POLICY_OPTIONS.map(([value, label]) => (
          <label key={value} className="social-option">
            <input type="radio" name={`policy-${agent.id}`} value={value} checked={form.policy === value} onChange={() => setForm({ ...form, policy: value })} />
            <span>{label}</span>
          </label>
        ))}
        {form.policy === "contacts" && (
          <div className="social-picks">
            <label className="social-option">
              <input type="checkbox" checked={form.picked} onChange={(e) => setForm({ ...form, picked: e.target.checked })} />
              <span>{PICKED_LABEL}</span>
            </label>
            {form.picked && (
              <ul className="social-checklist" aria-label="可以直接添加的好友">
                {friends.length === 0 && <li className="muted">你还没有好友。</li>}
                {friends.map((id) => (
                  <li key={id}>
                    <label className="social-option">
                      <input type="checkbox" checked={form.picks.includes(id)} onChange={() => pick(id)} />
                      <Avatar id={id} size={28} />
                      <span>{nameOf(state, id)}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <div className="social-save">
          <Btn variant="primary" disabled={!changed || busy !== null} onClick={save}>
            {busy === "check" || busy === "save" ? "处理中…" : "保存"}
          </Btn>
        </div>
      </fieldset>

      <h3>已添加它的人</h3>
      {people.length === 0 ? (
        <p className="muted">还没有人添加它。</p>
      ) : (
        <ul className="member-rows" aria-label="已添加它的人">
          {people.map((r) => (
            <li key={r.subject.id}>
              <Avatar id={r.subject.id} size={40} />
              <div className="member-body">
                <strong>{r.subject.displayName}</strong>
                <p className="muted">{r.subject.kind === "agent" ? (r.subject.ownerName ? `${r.subject.ownerName}的 Agent` : "Agent") : `@${r.subject.handle}`}</p>
              </div>
              <div className="member-actions">
                <Btn small disabled={busy !== null} onClick={() => act(`remove:${r.subject.id}`, () => actions.removeAgentContact(agent.id, r.subject.id), "已移除")}>
                  {busy === `remove:${r.subject.id}` ? "处理中…" : "移除"}
                </Btn>
              </div>
            </li>
          ))}
        </ul>
      )}

      <h3>申请</h3>
      {requests.length === 0 ? (
        <p className="muted">没有等你同意的申请。</p>
      ) : (
        <ul className="member-rows" aria-label="申请">
          {requests.map((r) => (
            <li key={r.subject.id}>
              <Avatar id={r.subject.id} size={40} />
              <div className="member-body">
                <strong>{r.subject.displayName}</strong>
                <p className="muted">{r.until ? untilText(r.until, now) : ""}</p>
              </div>
              <div className="member-actions">
                <Btn small variant="primary" disabled={busy !== null} onClick={() => act(`approve:${r.subject.id}`, () => actions.approveAgentContact(agent.id, r.subject.id), "已同意")}>
                  {busy === `approve:${r.subject.id}` ? "处理中…" : "同意"}
                </Btn>
                <Btn small disabled={busy !== null} onClick={() => act(`decline:${r.subject.id}`, () => actions.declineAgentContact(agent.id, r.subject.id), "已拒绝")}>
                  {busy === `decline:${r.subject.id}` ? "处理中…" : "拒绝"}
                </Btn>
              </div>
            </li>
          ))}
        </ul>
      )}

      <h3>它和别人的对话</h3>
      {observed.length === 0 ? (
        <p className="muted">它还没有和别人聊过。</p>
      ) : (
        <ul className="rows social-convs" aria-label="它和别人的对话">
          {observed.map((c) => {
            const other = (c.social?.participants ?? []).find((id) => id !== agent.id);
            return (
              <li key={c.id}>
                <button type="button" className="row" onClick={() => dispatch({ type: "nav/openConv", convId: c.id })}>
                  <Avatar id={other} size={44} />
                  <span className="row-body">
                    <span className="row-top">
                      <span className="row-name">{nameOf(state, other)}</span>
                      {other && state.agents[other] ? <Tag>Agent</Tag> : null}
                      <time>{c.at}</time>
                    </span>
                    <span className="row-sub">
                      <span className="row-preview">{lastPreview(state, c)}</span>
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {ask !== null && (
        <Modal
          title={`这样会影响 ${ask} 个人`}
          onClose={() => setAsk(null)}
          locked={busy === "save"}
          footer={
            <>
              <Btn data-autofocus disabled={busy === "save"} onClick={() => setAsk(null)}>取消</Btn>
              <Btn variant="danger" disabled={busy === "save"} onClick={put}>
                {busy === "save" ? "处理中…" : "确定"}
              </Btn>
            </>
          }
        >
          <p>
            {form.policy === "none"
              ? `${ask === 1 ? "对方" : "他们"}不能再和它聊天，也找不到它了。还在等你同意的申请会取消。${GROUPS_UNCHANGED}`
              : `${ask === 1 ? "对方" : "他们"}不能再和它聊天。想再聊要重新申请，由你同意。${GROUPS_UNCHANGED}`}
          </p>
        </Modal>
      )}
    </div>
  );
}
