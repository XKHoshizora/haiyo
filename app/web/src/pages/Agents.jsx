import React, { useEffect, useRef, useState } from "react";
import { useUp } from "../state/appHistory.js";
import { useStore } from "../data/store.jsx";
import { MODEL_GONE, commonErrorText } from "../data/errorTexts.js";
import { formatPoints, proactiveLevelLabel } from "../data/viewmodel.js";
import { OTHERS_NOTICE_BUTTON, OTHERS_REACHED_SHORT, OTHERS_STATES, othersNoticeText, othersStateOf, othersStateText } from "../data/othersCopy.js";
import { useOthersUse } from "./useOthersUse.js";
import { Avatar, ConvAvatar, HeadCounts, LoadingRow, Tag, Btn, IconBtn, Notice, Reason, KV, Modal } from "../ui/primitives.jsx";
import { ListHeader, Pills } from "./ChatList.jsx";
import { AgentForm, CHAIN_BUDGET_DEFAULT, GROUP_MENTIONS, openAgentChat } from "./AgentForm.jsx";
import { agentLevel, levelLabel, modelLab, modelLabel, openModelChoice } from "./ModelPicker.jsx";
import { LabLogo } from "../ui/LabLogo.jsx";
import { convTitle, groupCounts, isMyAgent, myAgents } from "../state/selectors.js";
import { socialOn } from "../state/social.js";
import { refusalText, settled, useAction } from "./useAction.js";
import { MemoryRoom, useMemoryRoom } from "./MemoryRoom.jsx";
import { MemoryHearsay } from "./MemoryHearsay.jsx";
import { AgentOthersTab } from "./AgentOthers.jsx";
import { Plus, ChevronLeft, Pencil, Pause, Play, Trash2 } from "../icons.js";

const groupMentionsLabel = (agent) => (GROUP_MENTIONS.find(([id]) => id === agent.groupMentions) ?? GROUP_MENTIONS[0])[1];

/**
 * What others' use of this Agent is, in the owner's view: its own limit (a sub-limit inside the owner's two numbers; none by default) and
 * what others used of it today, with the state the service says it is in (`row`: this Agent's entry of `GET /api/me/others-use`, null
 * until that is read). Only when the service says them; nothing is compared or counted here.
 */
function othersRows(agent, row) {
  const own = agent.othersLimit;
  const ownText =
    own === undefined
      ? null
      : own.answers === null && own.points === null
        ? "没有单独设置，和其他 Agent 共用你的每天上限"
        : [own.answers === null ? null : `每天最多回别人 ${own.answers} 次`, own.points === null ? null : `最多花 ${formatPoints(own.points)} 点`].filter(Boolean).join("，");
  const used = agent.othersUsedToday;
  const state = row && row.canReply !== false ? ` · ${othersStateText(row)}` : row ? " · 没有可用的模型，暂时不能回复" : "";
  const usedText = used === undefined ? null : `今天回了别人 ${used.answers} 次（含主动回复），别人 @ 它花了 ${formatPoints(used.points)} 点${state}`;
  return [...(ownText === null ? [] : [["别人用它的上限", ownText]]), ...(usedText === null ? [] : [["别人今天的使用", usedText]])];
}

/** 主动参与群聊 with its level and daily budget: only in the owner's view, and only while it is on. */
function proactiveRows(agent) {
  if (agent.proactive !== true) return [];
  const level = proactiveLevelLabel(agent.proactiveLevel);
  // The budget is always said by the service; if it somehow is not, the level alone is shown.
  if (agent.proactiveBudget === undefined) return [["主动参与群聊", level]];
  // Today's spend is the service's (`proactiveSpentToday`, owner only); said beside the daily budget, never compared with it here.
  const spent = typeof agent.proactiveSpentToday === "string" ? `，今天花了 ${formatPoints(agent.proactiveSpentToday)} 点` : "";
  return [["主动参与群聊", `${level} · 每天最多花 ${formatPoints(agent.proactiveBudget)} 点${spent}`]];
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
  // (The site's operator turned it off: it answers nobody but its owner, who is told here and on its page.)
  if (agent.operatorDisabled) return <Tag tone="warn">已被停用</Tag>;
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

/**
 * The one-time notice at the top of 我的 Agent while the service says `notice` (the others' limit is now counted per person): system text
 * in the web, never a message of an Agent's, dismissed for good with 「知道了」 (`POST /api/me/others-limits/seen`; the notice stays if that
 * fails, and says so).
 */
function OthersNotice({ use, settle, reload }) {
  const { dispatch, actions } = useStore();
  const [pending, setPending] = useState(false);
  if (!use?.notice) return null;
  const seen = async () => {
    if (pending) return;
    setPending(true);
    try {
      await actions.seenOthersNotice();
      settle({ ...use, notice: false });
      // A write like a save: a read already in flight may have been sent before it, so the next read starts after that one.
      reload({ afterWrite: true });
    } catch (err) {
      dispatch({ type: "toast", text: commonErrorText(err) });
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="others-notice">
      <Notice tone="info" action={<Btn small disabled={pending} onClick={seen}>{OTHERS_NOTICE_BUTTON}</Btn>}>
        {othersNoticeText(use.limits)}
      </Notice>
    </div>
  );
}

export function AgentsList() {
  const { state, dispatch, actions } = useStore();
  const { nav } = state;
  const { use, settle, reload } = useOthersUse({ maxAge: 10_000 });
  /** This Agent's entry of the use route: its numbers and its state today. */
  const useOf = (id) => use?.agents?.find((a) => a.agentId === id) ?? null;
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
      <OthersNotice use={use} settle={settle} reload={reload} />
      {/* The cap is one for all my Agents: when the day is used up it is said ONCE here, not on every card (fix round 1, I3). */}
      {othersStateOf(use) === "reached" && <p className="list-note others-reached" role="status">{OTHERS_STATES.reached}</p>}
      <p className="list-note">这里只列出你拥有的 Agent。</p>
      <ul className="rows agent-rows">
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
                  {/* Only an Agent whose OWN number is used up while my day is not: three characters, so its name keeps its room. */}
                  {!a.deleted && othersStateOf(use) !== "reached" && othersStateOf(useOf(a.id)) === "reached" && <Tag tone="warn">{OTHERS_REACHED_SHORT}</Tag>}
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
              <p className="muted"><HeadCounts {...groupCounts(state, c)} /></p>
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
  const { use, reload } = useOthersUse({ maxAge: 10_000 });
  // The numbers of the row come from the Agent's record and its state from the use route: when the record's change, the route is read again.
  const usedKey = JSON.stringify([agent.othersUsedToday, agent.othersLimit]);
  const firstKey = useRef(usedKey);
  useEffect(() => {
    if (firstKey.current !== usedKey) {
      firstKey.current = usedKey;
      reload();
    }
  }, [usedKey, reload]);
  // The 「别人」 tab is for a live Agent, and only while the site's Agent social switch is on.
  const othersOn = live && socialOn(state);
  // The memory tab is for a live Agent: one deleted while it is open falls back to the profile, as a tab not offered does (so does 「别人」).
  const tab = (nav.agentTab === "memory" && !live) || (nav.agentTab === "others" && !othersOn) ? "profile" : (nav.agentTab ?? "profile");
  const note = nav.agentNote?.agentId === agent.id ? nav.agentNote.text : null;
  const toggle = () => run("pause", () => settled(agent.paused ? actions.resumeAgent(agent.id) : actions.pauseAgent(agent.id)), refusalText);
  // 思考程度 is the level it runs at, which depends on what its model lists: a provider's model is looked up in my providers, read
  // once when they are not held here (its saved level shows until then, and stays when the provider is gone).
  const providerNeeded = agent.model?.source === "provider" && !state.providers[agent.model.providerId] ? agent.model.providerId : null;
  useEffect(() => {
    if (providerNeeded) actions.loadProviders();
  }, [providerNeeded, actions]);

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
            {!agent.deleted && agent.operatorDisabled && <Notice tone="warn">管理员停用了这个 Agent：它现在只回复你，不回复别人。</Notice>}
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
                    ["思考程度", levelLabel(agentLevel(state, agent))],
                    ["人格文档", agent.persona ? excerpt(agent.persona) : "未填写（它会先在会话里问你几个问题）"],
                    ["私聊回复方式", agent.privateReply],
                    ["群里谁可以叫它", groupMentionsLabel(agent)],
                    ["一次接话最多花费", `${formatPoints(agent.chainBudget ?? CHAIN_BUDGET_DEFAULT)} 点`],
                    ...othersRows(agent, use?.agents?.find((a) => a.agentId === agent.id) ?? null),
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
