import React, { useEffect, useState } from "react";
import { useUp } from "../state/appHistory.js";
import { useStore } from "../data/store.jsx";
import { MODEL_GONE } from "../data/errorTexts.js";
import { formatPoints, pointsReached, proactiveLevelLabel } from "../data/viewmodel.js";
import { Avatar, ConvAvatar, LoadingRow, Tag, Btn, IconBtn, Notice, Reason, KV, Modal } from "../ui/primitives.jsx";
import { ListHeader, Pills } from "./ChatList.jsx";
import { AgentForm, CHAIN_BUDGET_DEFAULT, GROUP_MENTIONS, openAgentChat } from "./AgentForm.jsx";
import { levelLabel, modelLab, modelLabel, openModelChoice } from "./ModelPicker.jsx";
import { LabLogo } from "../ui/LabLogo.jsx";
import { convSubtitle, convTitle, isMyAgent, myAgents } from "../state/selectors.js";
import { refusalText, settled, useAction } from "./useAction.js";
import { MemoryRoom, useMemoryRoom } from "./MemoryRoom.jsx";
import { MemoryHearsay } from "./MemoryHearsay.jsx";
import { AgentOthersTab } from "./AgentOthers.jsx";
import { Plus, ChevronLeft, Pencil, Pause, Play, Trash2 } from "../icons.js";

const groupMentionsLabel = (agent) => (GROUP_MENTIONS.find(([id]) => id === agent.groupMentions) ?? GROUP_MENTIONS[0])[1];

/**
 * (Every digit is kept here, `formatPoints`, on purpose: spend and budget are compared as numbers, and a rounded line — 20.5 of 20.5 for 20.499999 —
 * would say "used up" in the digits while the rule says it is not.)
 * Today's spend against a daily budget, by what spent it (`what`: 别人 @, 主动回复): how much of it, or — `reached` —
 * that it is used up.
 */
function spendLine(what, spentToday, budget) {
  const reached = pointsReached(spentToday, budget);
  return { reached, text: reached ? `今天${what}的额度已用完，调高后立即恢复。` : `今天${what}已花 ${formatPoints(spentToday)} / ${formatPoints(budget)} 点` };
}

/** 别人 @ 每天最多花 with today's spend: only for my Agent that others may call, when the service says its budget. */
function othersRows(agent) {
  if (agent.othersBudget === undefined || agent.groupMentions !== "members") return [];
  const spentToday = agent.othersSpentToday ?? "0";
  const text =
    agent.othersBudget === null ? `今天别人 @ 已花 ${formatPoints(spentToday)} 点（不限）` : spendLine("别人 @ ", spentToday, agent.othersBudget).text;
  return [["别人 @ 每天最多花", text]];
}

/** 主动参与群聊 with its level and today's spend: only in the owner's view, and only while it is on. */
function proactiveRows(agent) {
  if (agent.proactive !== true) return [];
  const level = proactiveLevelLabel(agent.proactiveLevel);
  // The budget is always said by the service; if it somehow is not, the level alone is shown.
  if (agent.proactiveBudget === undefined) return [["主动参与群聊", level]];
  const { reached, text } = spendLine("主动回复", agent.proactiveSpentToday ?? "0", agent.proactiveBudget);
  return [["主动参与群聊", reached ? text : `${level} · ${text}`]];
}

/** 它怎么称呼你 and how many others it has an appellation for: only in the owner's view of the Agent (mine), when set. */
function appellationRows(agent) {
  const others = agent.appellations?.length ?? 0;
  return [
    ...(agent.ownerAppellation ? [["它怎么称呼你", agent.ownerAppellation]] : []),
    ...(others > 0 ? [["它怎么称呼别人", `${others} 个`]] : []),
  ];
}

/**
 * 模型不可用: the Agent's model is not there to call — its owner's to know alone. For the owner a button that opens where its
 * model is chosen (`openModelChoice`), plain text only inside a row that is a button already (`plain`); for anyone else
 * nothing at all.
 */
export function ModelGoneTag({ agent, plain = false }) {
  const { dispatch } = useStore();
  if (!agent.mine) return null;
  if (plain) return <Tag tone="warn">{MODEL_GONE.tag}</Tag>;
  return (
    <button type="button" className="tag tag-warn" aria-label={`${MODEL_GONE.tag}，${MODEL_GONE.action}`} onClick={() => openModelChoice(dispatch, agent.id)}>
      {MODEL_GONE.tag}
    </button>
  );
}

/** The status tag of an Agent; none while its record is not loaded (its model is not known yet). `action`: a tag that can act may. */
function StatusTag({ agent, long = false, action = false }) {
  if (agent.deleted) return <Tag tone="muted">已删除</Tag>;
  if (agent.paused) return <Tag tone="pending">{long ? "已暂停全部会话" : "已暂停"}</Tag>;
  if (!agent.loaded) return null;
  if (!agent.model) return <Tag tone="warn">未选模型</Tag>;
  // (Its model is not there to call any more: it cannot reply, and its page says why.)
  if (!agent.modelUsable) return <ModelGoneTag agent={agent} plain={!action} />;
  return <Tag tone="ok">可回复</Tag>;
}

/** The first characters of a long text, for a summary line. */
const excerpt = (text, max = 200) => {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
};

export function AgentsList() {
  const { state, dispatch, actions } = useStore();
  const { nav } = state;
  const agents = myAgents(state);
  // A deleted Agent is not one of mine any more (the usage page counts none of it): its row waits behind one collapsed entry, because its chat history
  // stays readable by design (the row opens its page, whose 进入查看 reaches the chat). The entry opens by itself when one of them is open.
  const live = agents.filter((a) => !a.deleted);
  const gone = agents.filter((a) => a.deleted);
  const [showGone, setShowGone] = useState(false);
  const goneOpen = showGone;
  // The entry opens by itself when one of those Agents becomes the open page (a reload on its address, a click from elsewhere), and can be closed again after.
  const openGone = nav.pane === "main" && gone.some((a) => a.id === nav.agentId && nav.agentView !== "create");
  useEffect(() => {
    if (openGone) setShowGone(true);
  }, [openGone, nav.agentId]);
  const unloaded = agents.some((a) => !a.loaded);
  // An Agent known only by name (its record not loaded, e.g. the list failed on this connection): asked for once more
  // when the page opens (only then: the connection loads the list by itself).
  useEffect(() => {
    if (unloaded) actions.loadAgents();
  }, []);
  return (
    <>
      <ListHeader
        title="我的 Agent"
        action={
          <IconBtn label="创建 Agent" className="boxed" onClick={() => dispatch({ type: "nav", patch: { agentView: "create", pane: "main" } })}>
            <Plus size={20} />
          </IconBtn>
        }
      />
      <p className="list-note">这里只列出你拥有的 Agent。</p>
      <ul className="rows">
        {[...live, ...(goneOpen ? gone : [])].map((a) => (
          <li key={a.id}>
            <button
              type="button"
              className={`row ${nav.agentId === a.id && nav.agentView !== "create" ? "active" : ""}${a.deleted ? " quiet" : ""}`}
              onClick={() => dispatch({ type: "nav", patch: { agentId: a.id, agentView: "detail", pane: "main" } })}
            >
              <Avatar id={a.id} size={48} />
              <span className="row-body">
                <span className="row-top">
                  <span className="row-name">{a.name}</span>
                  <StatusTag agent={a} />
                </span>
                <span className="row-sub">
                  <span className="row-preview">{a.loaded ? (
                      <>
                        {`${a.field || "未填写擅长领域"} · `}
                        <LabLogo lab={modelLab(state, a.model)} size={16} />
                        {modelLabel(state, a.model) ?? "未选择模型"}
                      </>
                    ) : "正在读取…"}</span>
                </span>
              </span>
            </button>
          </li>
        ))}
        {agents.length === 0 && !state.loaded && <LoadingRow />}
        {live.length === 0 && state.loaded && <li className="rows-empty">还没有 Agent，点右上角的“+”创建一个</li>}
        {gone.length > 0 && (
          <li>
            <button type="button" className="row-more" aria-expanded={goneOpen} onClick={() => setShowGone(!goneOpen)}>
              已删除（{gone.length}）
            </button>
          </li>
        )}
      </ul>
    </>
  );
}

/**
 * Where it talks: its conversation with me, and the groups it is a member of now (as the conversations held here say,
 * in the chat list's order).
 */
function Conversations({ agent }) {
  const { state, dispatch, actions } = useStore();
  const id = agent.conversationId;
  const groups = state.order.map((convId) => state.convs[convId]).filter((c) => c?.type === "group" && c.members.includes(agent.id));
  return (
    <>
      <p className="muted">这是你和它的专属会话：只有你们两个成员，只包含其中的消息与附件。</p>
      {groups.length > 0 && <p className="muted">它也在下面这些群里：只看得到它进群之后的消息与附件，{agent.groupMentions === "owner" ? "只有你 @ 它时回复" : "群成员 @ 它时回复"}。</p>}
      <ul className="member-rows">
        {id && (
          <li>
            <Avatar id={agent.id} size={44} />
            <div className="member-body">
              <strong>
                {agent.name} <Tag>Agent 私聊</Tag> {agent.deleted && <Tag tone="muted">只能查看</Tag>}
              </strong>
              <p className="muted">{agent.deleted ? "它已删除，聊天记录仍可查看" : "你是发言成员"}</p>
            </div>
            <div className="member-actions">
              <Btn small variant="primary" onClick={() => openAgentChat(state, dispatch, actions, id)}>进入查看</Btn>
            </div>
          </li>
        )}
        {groups.map((c) => (
          <li key={c.id}>
            <ConvAvatar conv={c} size={44} />
            <div className="member-body">
              <strong>
                {convTitle(state, c)} <Tag tone="muted">群聊</Tag>
              </strong>
              <p className="muted">{convSubtitle(state, c)}</p>
            </div>
            <div className="member-actions">
              <Btn small variant="primary" onClick={() => dispatch({ type: "nav/openConv", convId: c.id })}>进入查看</Btn>
            </div>
          </li>
        ))}
        {!id && groups.length === 0 && <li className="rows-empty">它还没有参与任何会话</li>}
      </ul>
    </>
  );
}

/** 记忆宫殿 of an Agent: its own notes (with their vault) and what it heard, read together and again after each write. */
function AgentMemory({ agent }) {
  const memory = useMemoryRoom(agent.id);
  const { room, failure } = memory;
  if (!room) return failure ? <p className="field-msg" role="alert">{failure}</p> : <p className="muted">正在读取…</p>;
  return (
    <>
      <MemoryRoom agentId={agent.id} agentName={agent.name} title={`${agent.name}自己的笔记`} memory={memory} />
      {room.hearsay && <MemoryHearsay agentId={agent.id} agentName={agent.name} memory={memory} />}
    </>
  );
}

function DeleteModal({ agent, onClose }) {
  const { actions, dispatch } = useStore();
  const { busy, run } = useAction();
  const confirm = async () => {
    const res = await run("delete", () => settled(actions.deleteAgent(agent.id)), refusalText);
    if (!res.ok) return;
    dispatch({ type: "toast", text: `已删除${agent.name}` });
    onClose();
  };
  return (
    <Modal
      title={`删除${agent.name}`}
      onClose={onClose}
      footer={
        <>
          <Btn data-autofocus onClick={onClose}>取消</Btn>
          <Btn variant="danger" disabled={busy !== null} onClick={confirm}>
            {busy !== null ? "处理中…" : "确认删除"}
          </Btn>
        </>
      }
    >
      <p>
        你要删除 <strong>{agent.name}</strong>：
      </p>
      <ul className="plain-list">
        <li>删除后不可恢复。</li>
        <li>聊天记录会保留，只能查看。</li>
        <li>它不会再回复。账号名 {agent.handle} 可以给你的新 Agent 再用。</li>
      </ul>
    </Modal>
  );
}

function AgentDetail({ agent }) {
  const { state, dispatch, actions } = useStore();
  const up = useUp();
  const { busy, run } = useAction();
  const [deleting, setDeleting] = useState(false);
  const { nav } = state;
  const live = agent.loaded && !agent.deleted;
  // The 「别人」 tab is for a live Agent, and only while the site's Agent social switch is on.
  const othersOn = live && state.social?.enabled === true;
  // The memory tab is for a live Agent: one deleted while it is open falls back to the profile, as a tab not offered does (so does 「别人」).
  const tab = (nav.agentTab === "memory" && !live) || (nav.agentTab === "others" && !othersOn) ? "profile" : (nav.agentTab ?? "profile");
  const note = nav.agentNote?.agentId === agent.id ? nav.agentNote.text : null;
  const toggle = () => run("pause", () => settled(agent.paused ? actions.resumeAgent(agent.id) : actions.pauseAgent(agent.id)), refusalText);

  return (
    <section className="page" aria-label="Agent 管理">
      <button type="button" className="back only-mobile" onClick={up}>
        <ChevronLeft size={20} aria-hidden="true" /> 返回我的 Agent
      </button>
      <header className="profile-head">
        <Avatar id={agent.id} size={84} />
        <div className="grow">
          <p className="eyebrow">我的 Agent</p>
          <h2>
            {agent.name} <Tag>Agent</Tag> <StatusTag agent={agent} long action />
          </h2>
          <p className="muted">{agent.handle} · 主人：你</p>
        </div>
        {live && (
          <div className="head-actions">
            <Btn onClick={() => dispatch({ type: "nav", patch: { agentView: "edit" } })}>
              <Pencil size={16} aria-hidden="true" /> 编辑
            </Btn>
            <Btn variant={agent.paused ? "primary" : "ghost"} disabled={busy !== null} onClick={toggle}>
              {busy === "pause" ? (
                "处理中…"
              ) : agent.paused ? (
                <>
                  <Play size={16} aria-hidden="true" /> 恢复全部会话
                </>
              ) : (
                <>
                  <Pause size={16} aria-hidden="true" /> 暂停全部会话
                </>
              )}
            </Btn>
          </div>
        )}
      </header>
      {!agent.loaded ? (
        <div className="page-body">
          <p className="muted">正在读取它的资料…</p>
        </div>
      ) : (
        <>
          <Pills
            label="Agent 分区"
            value={tab}
            onChange={(id) => dispatch({ type: "nav", patch: { agentTab: id } })}
            options={[
              ["profile", "资料"],
              ["convs", "参与的会话"],
              ...(live ? [["memory", "记忆宫殿"]] : []),
              ...(othersOn ? [["others", "别人"]] : []),
            ]}
          />
          <div className="page-body">
            {note && (
              <Notice tone="warn" action={<Btn small onClick={() => dispatch({ type: "nav", patch: { agentNote: null } })}>知道了</Btn>}>
                {note}
              </Notice>
            )}
            {agent.deleted && <Notice tone="info">这个 Agent 已删除：它不再回复，聊天记录会保留，只能查看。</Notice>}
            {!agent.deleted && agent.paused && (
              <Notice tone="pause">已暂停全部会话：它不会有新回复。与「停止生成」不同，这不是只中断一次回复。恢复后，暂停期间收到的消息不会补上回复。</Notice>
            )}
            {tab === "profile" && (
              <>
                <p className="lead">{agent.intro || "还没有简介。"}</p>
                <KV
                  rows={[
                    ["主人", "你（不可修改）"],
                    ["擅长领域", agent.field || "未填写"],
                    ["模型", <><LabLogo lab={modelLab(state, agent.model)} size={16} />{modelLabel(state, agent.model) ?? "未选择"}{agent.model && !agent.modelUsable && <Reason>{MODEL_GONE.sentence}</Reason>}</>],
                    ["思考程度", levelLabel(agent.reasoning)],
                    ["人格文档", agent.persona ? excerpt(agent.persona) : "未填写（它会先在会话里问你几个问题）"],
                    ["私聊回复方式", agent.privateReply],
                    ["群里谁可以叫它", groupMentionsLabel(agent)],
                    ["一次接话最多花费", `${formatPoints(agent.chainBudget ?? CHAIN_BUDGET_DEFAULT)} 点`],
                    ...othersRows(agent),
                    ...proactiveRows(agent),
                    ...appellationRows(agent),
                  ]}
                />
                <Reason>人格文档只影响它如何回复，不授予任何权限。</Reason>
                {live && (
                  <div className="stack-actions row-actions">
                    <Btn variant="danger" onClick={() => setDeleting(true)}>
                      <Trash2 size={16} aria-hidden="true" /> 删除 Agent
                    </Btn>
                  </div>
                )}
              </>
            )}
            {tab === "convs" && <Conversations agent={agent} />}
            {tab === "memory" && live && <AgentMemory agent={agent} />}
            {tab === "others" && othersOn && <AgentOthersTab agent={agent} />}
          </div>
        </>
      )}
      {deleting && <DeleteModal agent={agent} onClose={() => setDeleting(false)} />}
    </section>
  );
}

export function AgentMain() {
  const { state } = useStore();
  const { nav } = state;
  // (Someone else's Agent, known from a group, has no page here.)
  const agent = isMyAgent(state, nav.agentId) ? state.agents[nav.agentId] : null;
  if (nav.agentView === "create") return <AgentForm key="create" />;
  if (!agent) return <div className="empty-main">选择一个 Agent</div>;
  // A form opens only on a loaded record (never an empty form that could wipe the persona) of an Agent not deleted.
  if (nav.agentView === "edit" && agent.loaded && !agent.deleted) return <AgentForm key={agent.id} agent={agent} />;
  return <AgentDetail agent={agent} />;
}
