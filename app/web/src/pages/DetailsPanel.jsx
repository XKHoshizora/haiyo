import React, { useState } from "react";
import { useUp } from "../state/appHistory.js";
import { useStore } from "../data/store.jsx";
import { agentDeleted, convTitle, isMyAgent, TYPE_LABEL, nameOf, otherMember } from "../state/selectors.js";
import { blockedMe, iBlocked, isObserved, isSocialConv, pictureConv, socialEnds, socialOn } from "../state/social.js";
import { Avatar, ConvAvatar, IdentityLine, IconBtn, Btn, Tag, KV, Reason } from "../ui/primitives.jsx";
import { BlockModal } from "./BlockModal.jsx";
import { LeaveAgentModal } from "./LeaveAgentModal.jsx";
import { ReportModal } from "./ReportModal.jsx";
import { NewTopicModal } from "./AgentChatBits.jsx";
import { AgentModelSwitch, EVERYWHERE_NOTE } from "./ModelPicker.jsx";
import { X } from "../icons.js";

/** What my Agent does not get from its conversation with me. */
const AGENT_NOT_GRANTED = "对方的其他会话";

export function DetailsPanel({ conv }) {
  const { state, dispatch } = useStore();
  const up = useUp();
  const other = otherMember(conv);
  const group = conv.type === "group";
  const agentChat = conv.type === "agent";
  const [blockOpen, setBlockOpen] = useState(false);
  const [topicOpen, setTopicOpen] = useState(false);
  // A social conversation I speak in (the Agent's card): 举报, 拉黑, 移除; its owner (who only watches) gets none of them. Only while the switch is on.
  const [socialDialog, setSocialDialog] = useState(null);
  const visitorOf = isSocialConv(conv) && !isObserved(conv) && socialOn(state) ? socialEnds(state, conv).agentId : null;
  const watchedAgent = isObserved(conv) && socialOn(state) ? socialEnds(state, conv).agentId : null;
  const blocked = conv.type === "human" && iBlocked(state, other);
  const blockedByThem = conv.type === "human" && blockedMe(state, other);
  const deleted = agentChat && agentDeleted(state, conv);
  // My Agent's own conversation: its model, switched right here (as in the header), once its record is loaded.
  const myAgent = agentChat ? state.agents[conv.agentId] : null;
  const modelRow = myAgent?.mine && myAgent.loaded ? [["模型", <AgentModelSwitch key="model" agentId={conv.agentId} />]] : [];
  const go = (patch) => dispatch({ type: "nav", patch: { pane: "main", ...patch } });

  return (
    <div className="side">
      <header className="side-head">
        <h2>会话资料</h2>
        <IconBtn label="关闭" onClick={up}><X size={18} /></IconBtn>
      </header>
      <div className="side-body">
        <div className="side-hero">
          <ConvAvatar conv={pictureConv(state, conv)} size={64} />
          <strong>{convTitle(state, conv)}</strong>
          <Tag tone="solid">{TYPE_LABEL[conv.type]}</Tag>
        </div>

        <h3>发言成员</h3>
        <ul className="side-list">
          {conv.members.map((id) => (
            <li key={id}>
              <Avatar id={id} size={36} />
              <IdentityLine id={id} />
              {/* In a group, an Agent of mine: its model, switched right here (for every conversation it is in). */}
              {group && isMyAgent(state, id) && state.agents[id].loaded && (
                <span className="side-model">
                  <AgentModelSwitch agentId={id} note={EVERYWHERE_NOTE} />
                </span>
              )}
            </li>
          ))}
        </ul>
        <KV
          rows={[
            ["谁能看", conv.members.map((id) => nameOf(state, id)).join("、")],
            ...(agentChat ? [["不随关系获得", AGENT_NOT_GRANTED]] : []),
            ...modelRow,
          ]}
        />

        <h3>操作</h3>
        <div className="stack-actions">
          {group && <Btn onClick={() => dispatch({ type: "nav", patch: { view: "profile", profileTab: "members", detailsOpen: false } })}>打开群资料</Btn>}
          {conv.type === "human" && <Btn onClick={() => go({ section: "contacts", contactId: other })}>查看联系人卡片</Btn>}
          {conv.type === "human" && (
            <Btn variant={blocked ? "ghost" : "danger"} onClick={() => setBlockOpen(true)}>{blocked ? "解除我的拉黑" : "拉黑此用户"}</Btn>
          )}
          {conv.type === "human" && blockedByThem && <Reason>对方拉黑了你，只能由对方解除。</Reason>}
          {agentChat && <Btn onClick={() => go({ section: "agents", agentId: other, agentView: "detail", agentTab: "profile" })}>管理这个 Agent</Btn>}
          {agentChat && !deleted && <Btn onClick={() => setTopicOpen(true)}>开始新话题</Btn>}
          {visitorOf && <Btn onClick={() => setSocialDialog("report")}>举报</Btn>}
          {visitorOf && <Btn variant={iBlocked(state, visitorOf) ? "ghost" : "danger"} onClick={() => setSocialDialog("block")}>{iBlocked(state, visitorOf) ? "解除拉黑" : "拉黑"}</Btn>}
          {visitorOf && <Btn onClick={() => setSocialDialog("leave")}>移除</Btn>}
          {watchedAgent && <Btn onClick={() => go({ section: "agents", agentId: watchedAgent, agentView: "detail", agentTab: "others" })}>管理这个 Agent</Btn>}
        </div>
      </div>
      {blockOpen && <BlockModal target={other} onClose={() => setBlockOpen(false)} />}
      {topicOpen && <NewTopicModal conv={conv} onClose={() => setTopicOpen(false)} />}
      {socialDialog === "report" && visitorOf && <ReportModal agentId={visitorOf} onClose={() => setSocialDialog(null)} />}
      {socialDialog === "block" && visitorOf && <BlockModal target={visitorOf} onClose={() => setSocialDialog(null)} />}
      {socialDialog === "leave" && visitorOf && <LeaveAgentModal agentId={visitorOf} onClose={() => setSocialDialog(null)} />}
    </div>
  );
}
