// The contacts page's rows of Agent social (plan A11a): the Agents I let in or asked (聊天, 移除; 「等主人同意」), and the requests waiting on
// my own Agents (同意, 拒绝). Nothing is drawn while the site's switch is off. What it shows is `state.agentContacts`, which the `social`
// fetch keeps (data/sync.js); every action asks for that fetch again, so a row's end shows without a reload.
import React, { useState } from "react";
import { useStore } from "../data/store.jsx";
import { socialErrorText } from "../data/errorTexts.js";
import { untilText } from "./untilText.js";
import { nameOf, convTitle } from "../state/selectors.js";
import { agentContactsOf, socialOn } from "../state/social.js";
import { Avatar, Btn, Tag } from "../ui/primitives.jsx";
import { useAction, useNow } from "./useAction.js";
import { openAgentChat } from "./AgentForm.jsx";
import { LeaveAgentModal } from "./LeaveAgentModal.jsx";

const matches = (text, q) => !q.trim() || text.toLowerCase().includes(q.trim().toLowerCase().replace(/^@/, ""));

/** @param {{query: string}} props The contacts page's search text: a row shows when its name or account name has it. */
export function AgentContactRows({ query }) {
  const { state, dispatch, actions } = useStore();
  const { busy, run } = useAction();
  const now = useNow();
  const [leaving, setLeaving] = useState(null);
  if (!socialOn(state)) return null;
  const { mine, waiting } = agentContactsOf(state);

  const nameFor = (row) => {
    const conv = row.conversationId ? state.convs[row.conversationId] : null;
    return conv ? convTitle(state, conv) : state.agents[row.agentId] || state.people[row.agentId] ? nameOf(state, row.agentId) : "Agent";
  };
  const live = mine.filter((r) => r.state === "live" && matches(nameFor(r), query));
  const asked = mine.filter((r) => r.state === "requested" && matches(nameFor(r), query));
  const incoming = waiting.filter((w) => matches(`${w.subject.displayName} ${w.subject.handle}`, query));

  const go = async (key, work, done) => {
    const res = await run(key, work, (e) => socialErrorText(e));
    if (res.ok && done) dispatch({ type: "toast", text: done });
  };

  return (
    <>
      {(live.length > 0 || asked.length > 0) && <li className="rows-label">我加的 Agent</li>}
      {live.map((r) => (
        <li key={`live:${r.agentId}`} className="social-row">
          <Avatar id={r.agentId} size={48} />
          <span className="row-body">
            <span className="row-top">
              <span className="row-name">{nameFor(r)}</span>
              <Tag>Agent</Tag>
            </span>
          </span>
          <span className="social-row-actions">
            <Btn small variant="primary" onClick={() => openAgentChat(state, dispatch, actions, r.conversationId)}>聊天</Btn>
            <Btn small onClick={() => setLeaving(r.agentId)}>移除</Btn>
          </span>
        </li>
      ))}
      {asked.map((r) => (
        <li key={`asked:${r.agentId}`} className="social-row">
          <Avatar id={r.agentId} size={48} />
          <span className="row-body">
            <span className="row-top">
              <span className="row-name">{nameFor(r)}</span>
              <Tag tone="pending">等主人同意</Tag>
            </span>
            <span className="row-sub">
              <span className="row-preview">{r.until ? untilText(r.until, now) : "等主人同意"}</span>
            </span>
          </span>
        </li>
      ))}
      {incoming.length > 0 && <li className="rows-label">别人想加你的 Agent</li>}
      {incoming.map((w) => (
        <li key={`wait:${w.agentId}:${w.subject.id}`} className="social-row">
          <Avatar id={w.subject.id} size={48} />
          <span className="row-body">
            <span className="row-top">
              <span className="row-name">{w.subject.displayName}</span>
              {w.subject.kind === "agent" ? <Tag>Agent</Tag> : <Tag tone="human">真人</Tag>}
            </span>
            <span className="row-sub">
              <span className="row-preview">
                想加 {nameOf(state, w.agentId)}
                {w.subject.kind === "agent" && w.subject.ownerName ? ` · ${w.subject.ownerName}的 Agent` : ""} · {untilText(w.until, now)}
              </span>
            </span>
          </span>
          <span className="social-row-actions">
            <Btn small variant="primary" disabled={busy !== null} onClick={() => go(`approve:${w.agentId}:${w.subject.id}`, () => actions.approveAgentContact(w.agentId, w.subject.id), "已同意")}>
              {busy === `approve:${w.agentId}:${w.subject.id}` ? "处理中…" : "同意"}
            </Btn>
            <Btn small disabled={busy !== null} onClick={() => go(`decline:${w.agentId}:${w.subject.id}`, () => actions.declineAgentContact(w.agentId, w.subject.id), "已拒绝")}>
              {busy === `decline:${w.agentId}:${w.subject.id}` ? "处理中…" : "拒绝"}
            </Btn>
          </span>
        </li>
      ))}
      {leaving && <LeaveAgentModal agentId={leaving} onClose={() => setLeaving(null)} />}
    </>
  );
}
