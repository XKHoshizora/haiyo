import React, { useState } from "react";
import { useStore } from "../data/store.jsx";
import { groupErrorText } from "../data/errorTexts.js";
import { groupTitle } from "../auth/validation.js";
import { ME } from "../data/identities.js";
import { convTitle, entity, isMyAgent, nameOf } from "../state/selectors.js";
import { Avatar, ConvAvatar, Tag, Btn, Field, IdentityLine, KV, Reason, focusInvalid } from "../ui/primitives.jsx";
import { AvatarEditor } from "./AvatarEditor.jsx";
import { Pills } from "./ChatList.jsx";
import { AddMemberModal, LeaveModal, RemoveMemberModal } from "./GroupModals.jsx";
import { useAction } from "./useAction.js";
import { ChevronLeft } from "../icons.js";

/** An Agent's intro and field, as one line ("" for a person, or an Agent with neither). */
const aboutOf = (state, id) => {
  const agent = state.agents[id];
  return agent ? [agent.intro, agent.field].filter(Boolean).join(" · ") : "";
};

function Members({ conv }) {
  const { state } = useStore();
  const [dialog, setDialog] = useState(null); // {kind: "add"} | {kind: "remove", id}
  const creator = conv.admin === ME;
  return (
    <>
      <h3>群成员</h3>
      <ul className="member-rows">
        {conv.memberRoles.map(({ id, isCreator }) => {
          const about = aboutOf(state, id);
          // The creator may remove anyone else; an Agent's owner may take their own Agent out.
          const removable = id !== ME && (creator || isMyAgent(state, id));
          return (
            <li key={id}>
              <Avatar id={id} size={44} />
              <div className="member-body">
                <IdentityLine id={id} extra={isCreator ? <Tag tone="solid">创建者</Tag> : null} />
                <p className="muted">{entity(state, id)?.handle ?? ""}</p>
                {about && <p className="muted">{about}</p>}
              </div>
              <div className="member-actions">
                {removable && <Btn small onClick={() => setDialog({ kind: "remove", id })}>移除</Btn>}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="stack-actions">
        <Btn variant="primary" onClick={() => setDialog({ kind: "add" })}>添加成员</Btn>
        <Reason>只能添加你的好友和你自己的 Agent，和你有拉黑关系的人除外。群里最多 500 人。</Reason>
      </div>
      {dialog?.kind === "add" && <AddMemberModal conv={conv} onClose={() => setDialog(null)} />}
      {dialog?.kind === "remove" && <RemoveMemberModal conv={conv} memberId={dialog.id} onClose={() => setDialog(null)} />}
    </>
  );
}

function Rename({ conv }) {
  const { actions, dispatch } = useStore();
  const { busy, run } = useAction();
  const [title, setTitle] = useState(conv.title ?? "");
  const [error, setError] = useState("");
  const unchanged = title.trim() === (conv.title ?? "");
  const save = async (event) => {
    event.preventDefault();
    if (busy !== null || unchanged) return;
    const problem = groupTitle(title);
    setError(problem);
    if (problem) {
      focusInvalid();
      return;
    }
    const res = await run("rename", () => actions.renameGroup(conv.id, title.trim()), (e) => groupErrorText("rename", e));
    if (res.ok) dispatch({ type: "toast", text: "群名称已修改" });
  };
  return (
    <form className="apply-box" onSubmit={save} noValidate>
      <Field label="群名称" hint="只有创建者可以修改，1–60 个字" error={error}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} autoComplete="off" />
      </Field>
      <Btn type="submit" variant="primary" disabled={busy !== null || unchanged} reason={unchanged ? "名称没有变化" : undefined}>
        {busy !== null ? "保存中…" : "保存"}
      </Btn>
    </form>
  );
}

function GroupSettings({ conv }) {
  const { state, dispatch, actions } = useStore();
  const { run } = useAction();
  const [leaving, setLeaving] = useState(false);
  const creator = conv.admin === ME;

  // Navigate away first: the conversation leaves the state when the service answers, and by then nothing of it
  // is on screen, so the "no longer in this conversation" notice (for removals) does not fire for my own action.
  const leave = async () => {
    const id = conv.id;
    setLeaving(false);
    dispatch({ type: "nav", patch: { convId: null, view: "chat", detailsOpen: false } });
    const res = await run("leave", () => actions.leaveGroup(id), (e) => groupErrorText("leave", e));
    if (res.ok) dispatch({ type: "toast", text: "已退出群聊" });
    else dispatch({ type: "nav/openConv", convId: id, patch: { view: "profile", profileTab: "settings" } });
  };

  return (
    <>
      <h3>群设置</h3>
      <KV rows={[["群创建者", nameOf(state, conv.admin)], ...(creator ? [] : [["群名称", convTitle(state, conv)]])]} />
      {creator && (
        <>
          <h3>群头像</h3>
          {/* The creator's: pick, adjust, save; 移除 goes back to the members' faces. Everyone else sees the picture above. */}
          <AvatarEditor
            current={<ConvAvatar conv={conv} size={84} />}
            upload={(file) => actions.uploadGroupAvatar(conv.id, file)}
            errorText={(e) => groupErrorText("avatar", e)}
            doneText="群头像已更新"
            onRemove={() => actions.removeGroupAvatar(conv.id)}
            canRemove={Boolean(conv.avatar)}
            removedText="群头像已移除"
            removeErrorText={(e) => groupErrorText("avatar", e)}
            hint="只有创建者可以修改。支持 PNG、JPEG、WebP，不超过 20 MB；不设置时显示成员头像的拼图。"
          />
        </>
      )}
      {creator && <Rename conv={conv} />}
      <h3>我的操作</h3>
      <div className="stack-actions">
        <div>
          <Btn variant="danger" onClick={() => setLeaving(true)}>退出本群</Btn>
          <Reason>退出后你不会再收到这个群的消息，也看不到群里的历史消息。</Reason>
        </div>
      </div>
      {leaving && <LeaveModal conv={conv} onLeave={leave} onClose={() => setLeaving(false)} />}
    </>
  );
}

export function GroupProfile({ conv }) {
  const { state, dispatch } = useStore();
  const tab = state.nav.profileTab;
  return (
    <section className="page profile" aria-label="群资料">
      <button type="button" className="back" onClick={() => dispatch({ type: "nav", patch: { view: "chat" } })}>
        <ChevronLeft size={20} aria-hidden="true" /> 返回群聊
      </button>
      <header className="profile-head">
        <ConvAvatar conv={conv} size={84} />
        <div>
          <p className="eyebrow">群资料</p>
          <h2>{convTitle(state, conv)}</h2>
          <p className="muted">共 {conv.memberRoles.length} 位成员</p>
        </div>
      </header>
      <Pills
        label="群资料分区"
        value={tab}
        onChange={(id) => dispatch({ type: "nav", patch: { profileTab: id } })}
        options={[
          ["members", "群成员"],
          ["settings", "群设置"],
        ]}
      />
      <div className="page-body">
        {tab === "members" && <Members conv={conv} />}
        {tab === "settings" && <GroupSettings conv={conv} />}
      </div>
    </section>
  );
}
