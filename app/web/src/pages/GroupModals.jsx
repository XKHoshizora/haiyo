// The group dialogs: start a group, add a member, remove a member, leave. Built from the prototype's Modal, Field,
// Btn and the `.checks` / `.member-rows` classes.
import React, { useState } from "react";
import { useStore } from "../data/store.jsx";
import { groupErrorText } from "../data/errorTexts.js";
import { groupTitle } from "../auth/validation.js";
import { ME } from "../data/identities.js";
import { convTitle, isAgent, isMyAgent, myAgents, nameOf } from "../state/selectors.js";
import { eligibleFriends, matchesPerson } from "../state/social.js";
import { Avatar, Btn, Field, IdentityLine, Modal, Notice, Reason, focusInvalid } from "../ui/primitives.jsx";
import { useAction } from "./useAction.js";

/** Fewest friends a group starts with (the service's rule). */
export const MIN_GROUP_FRIENDS = 2;

function SearchField({ value, onChange, label = "搜索好友" }) {
  return (
    <Field label={label}>
      <input type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder="名字或账号" autoComplete="off" data-autofocus />
    </Field>
  );
}

/** "发起群聊": a name and at least two of my friends (nobody with a block in either direction). */
export function NewGroupModal({ onClose }) {
  const { state, dispatch, actions } = useStore();
  const { busy, run } = useAction();
  const [title, setTitle] = useState("");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState([]);
  const [errors, setErrors] = useState({});
  const offered = eligibleFriends(state);
  const shown = offered.filter((id) => matchesPerson(state.people[id], query));
  const chosen = picked.filter((id) => offered.includes(id));

  const toggle = (id) => setPicked((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]));
  const submit = async (event) => {
    event.preventDefault();
    if (busy !== null) return;
    const found = {};
    const titleError = groupTitle(title);
    if (titleError) found.title = titleError;
    if (chosen.length < MIN_GROUP_FRIENDS) found.members = `至少选择 ${MIN_GROUP_FRIENDS} 位好友`;
    setErrors(found);
    if (Object.keys(found).length > 0) {
      if (found.title) focusInvalid();
      return;
    }
    const res = await run("create", () => actions.createGroup(title.trim(), chosen), (e) => groupErrorText("create", e));
    if (!res.ok) return;
    // Open it as soon as it is in state (the service pushes it to me; the app waits for that).
    dispatch({ type: "nav", patch: { opening: { convId: res.value.id } } });
    onClose();
  };

  return (
    <Modal
      title="发起群聊"
      onClose={onClose}
      footer={
        <>
          <Btn onClick={onClose}>取消</Btn>
          <Btn variant="primary" type="submit" form="new-group-form" disabled={busy !== null}>
            {busy !== null ? "创建中…" : "创建群聊"}
          </Btn>
        </>
      }
    >
      <form id="new-group-form" onSubmit={submit} noValidate>
        <Field label="群名称" hint="1–60 个字" error={errors.title}>
          <input value={title} onChange={(e) => setTitle(e.target.value)} autoComplete="off" data-autofocus />
        </Field>
        <SearchField value={query} onChange={setQuery} />
        <fieldset className="checks">
          <legend>
            选择好友（至少 {MIN_GROUP_FRIENDS} 位，已选 {chosen.length} 位）
          </legend>
          {offered.length === 0 && <p className="muted">没有可以拉进群聊的好友。</p>}
          {offered.length > 0 && shown.length === 0 && <p className="muted">没有找到匹配的好友。</p>}
          {shown.map((id) => (
            <label key={id}>
              <input type="checkbox" checked={picked.includes(id)} onChange={() => toggle(id)} />
              <Avatar id={id} size={28} />
              <span>
                {nameOf(state, id)}
                <small>{state.people[id].handle}</small>
              </span>
            </label>
          ))}
        </fieldset>
        {errors.members && (
          <p className="field-msg" role="alert">
            {errors.members}
          </p>
        )}
        <Reason>和你有拉黑关系的人不会出现在这里。群里最多 500 人。</Reason>
      </form>
    </Modal>
  );
}

/**
 * "添加成员": my friends who are not in the group yet (nobody with a block in either direction), and below them my own
 * Agents that are not deleted and not in it yet (someone else's Agent is never offered). The search covers both.
 */
export function AddMemberModal({ conv, onClose }) {
  const { state, dispatch, actions } = useStore();
  const { busy, run } = useAction();
  const [query, setQuery] = useState("");
  const [added, setAdded] = useState([]);
  const inGroup = conv.memberRoles.map((m) => m.id);
  const offered = eligibleFriends(state, inGroup);
  const shown = offered.filter((id) => matchesPerson(state.people[id], query));
  const agents = myAgents(state).filter((a) => !a.deleted && !inGroup.includes(a.id));
  const shownAgents = agents.filter((a) => matchesPerson(a, query));

  const add = async (id) => {
    const res = await run(id, () => actions.addMember(conv.id, id), (e) => groupErrorText(isAgent(state, id) ? "addAgent" : "add", e));
    if (res.ok) {
      setAdded((list) => [...list, id]);
      dispatch({ type: "toast", text: `已添加${nameOf(state, id)}` });
    }
  };
  const addButton = (id) => (
    <div className="member-actions">
      <Btn small variant="primary" disabled={busy !== null || added.includes(id)} onClick={() => add(id)}>
        {added.includes(id) ? "已添加" : busy === id ? "添加中…" : "添加"}
      </Btn>
    </div>
  );
  return (
    <Modal title="添加成员" onClose={onClose} footer={<Btn onClick={onClose}>完成</Btn>}>
      <SearchField value={query} onChange={setQuery} label="搜索好友或我的 Agent" />
      {offered.length === 0 && agents.length === 0 && <p className="muted">没有可以添加的好友或 Agent：你的好友都已在群里，或与你有拉黑关系，你的 Agent 也都已在群里。</p>}
      {offered.length + agents.length > 0 && shown.length + shownAgents.length === 0 && <p className="muted">没有找到匹配的好友或 Agent。</p>}
      <ul className="member-rows" aria-label="可添加的好友">
        {shown.map((id) => (
          <li key={id}>
            <Avatar id={id} size={40} />
            <div className="member-body">
              <strong>{nameOf(state, id)}</strong>
              <p className="muted">{state.people[id].handle}</p>
            </div>
            {addButton(id)}
          </li>
        ))}
      </ul>
      {shownAgents.length > 0 && (
        <>
          <h3>我的 Agent</h3>
          <ul className="member-rows" aria-label="可添加的 Agent">
            {shownAgents.map((a) => (
              <li key={a.id}>
                <Avatar id={a.id} size={40} />
                <div className="member-body">
                  <IdentityLine id={a.id} showOwner={false} />
                  <p className="muted">{a.handle}</p>
                </div>
                {addButton(a.id)}
              </li>
            ))}
          </ul>
        </>
      )}
    </Modal>
  );
}

/** The creator removes a member, or an owner their own Agent: confirm first (an Agent in words of its own). */
export function RemoveMemberModal({ conv, memberId, onClose }) {
  const { state, dispatch, actions } = useStore();
  const { busy, run } = useAction();
  const name = nameOf(state, memberId);
  const agent = isAgent(state, memberId);
  const confirm = async () => {
    const res = await run("remove", () => actions.removeMember(conv.id, memberId), (e) => groupErrorText(agent ? "removeAgent" : "remove", e));
    if (res.ok) {
      dispatch({ type: "toast", text: `已将${name}移出群聊` });
      onClose();
    }
  };
  return (
    <Modal
      title={`移除${name}`}
      onClose={onClose}
      footer={
        <>
          <Btn data-autofocus onClick={onClose}>取消</Btn>
          <Btn variant="danger" disabled={busy !== null} onClick={confirm}>
            {busy !== null ? "处理中…" : "确认移除"}
          </Btn>
        </>
      }
    >
      {agent ? (
        <p>
          把 <strong>{name}</strong> 移出群聊？它将不再在这个群里回复。
        </p>
      ) : (
        <p>
          把 <strong>{name}</strong> 移出「{convTitle(state, conv)}」？对方会立刻失去这个群聊的全部内容，群里会留下一条提示。
        </p>
      )}
    </Modal>
  );
}

/**
 * Who becomes creator when I (the creator) leave, as the service decides it: the earliest remaining person (never an
 * Agent). The conversation lists its members in join order, so that is the first one who is neither me nor an Agent;
 * null when no person is left (the group closes), `undefined` when I cannot tell who it is (not known by name here).
 */
export function successorOf(state, conv) {
  const next = conv.memberRoles.find((m) => m.id !== ME && !isAgent(state, m.id));
  if (!next) return null;
  return state.people[next.id] ? next.id : undefined;
}

/**
 * Leaving: confirm first; the creator is told who takes over (people only: an Agent never does), and anyone whose own
 * Agents are in the group that they leave with them.
 */
export function LeaveModal({ conv, onLeave, onClose }) {
  const { state } = useStore();
  const creator = conv.admin === ME;
  const successor = creator ? successorOf(state, conv) : null;
  const mineHere = conv.memberRoles.some((m) => isMyAgent(state, m.id));
  const withMine = mineHere ? "你的 Agent 会一起离开。" : "";
  return (
    <Modal
      title={`退出群聊「${convTitle(state, conv)}」`}
      onClose={onClose}
      footer={
        <>
          <Btn data-autofocus onClick={onClose}>取消</Btn>
          <Btn variant="danger" onClick={onLeave}>确认退出</Btn>
        </>
      }
    >
      <p>退出后你不会再收到这个群的消息，也看不到群里的历史消息；需要群里的人重新邀请你才能回来。</p>
      {creator && successor === null && (
        <Notice tone="warn">
          {mineHere ? "群里除了 Agent 只剩你了，退出后这个群会关闭。" : "你是群里的最后一位成员，退出后这个群会关闭。"}
          {withMine}
        </Notice>
      )}
      {creator && successor !== null && (
        <Notice tone="info">
          你是这个群的创建者。
          {successor ? `退出后，最早加入的成员${nameOf(state, successor)}会成为新的创建者。` : "退出后，最早加入的成员会成为新的创建者。"}
          {withMine}
        </Notice>
      )}
      {!creator && mineHere && <Notice tone="info">{withMine}</Notice>}
    </Modal>
  );
}
