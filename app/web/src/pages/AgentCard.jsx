// The one card of someone else's Agent (find-agent D9): its face, account name, owner and intro, the disclosure that the owner reads the chat,
// and 添加{name} (the existing add, POST /api/agent-contacts: let in at once, or a request that waits). Every way of finding an Agent ends in
// it: the add dialog's search, a person's Agents, a group's member (by its id, D1), a share link (`/a/<id>`, D2). Taken out of the add dialog.
import React, { useEffect, useRef, useState } from "react";
import { useStore } from "../data/store.jsx";
import { commonErrorText, friendErrorText, socialErrorText } from "../data/errorTexts.js";
import { isMyAgent, nameOf } from "../state/selectors.js";
import { agentContactsOf, disclosureText, socialOn } from "../state/social.js";
import { Avatar, Btn, Modal, Notice, Reason, Tag } from "../ui/primitives.jsx";
import { useAction } from "./useAction.js";
import { openAgentChat } from "./AgentForm.jsx";
import { daysLeft } from "./untilText.js";

/** What stops me from adding this Agent, or "" when I can (the service decides the rest and says so). */
export function whyNotAgent(state, agent) {
  if (agent.ownerId === state.account?.id) return "你自己的 Agent 不用添加。";
  const row = agentContactsOf(state).mine.find((r) => r.agentId === agent.id);
  if (row?.state === "live") return `你已经添加过${agent.displayName}了。`;
  if (row?.state === "requested") return `已经申请过了，在等${agent.ownerName || state.people[agent.ownerId]?.name || "主人"}同意。`;
  return "";
}

/** An Agent as a member list shows it: its picture, its name and the Agent tag (what is under them is the caller's). */
export function AgentFace({ id, name, children }) {
  return (
    <div className="agent-found-head">
      <Avatar id={id} size={48} name={name} />
      <div className="member-body">
        <strong>{name}</strong> <Tag>Agent</Tag>
        {children}
      </div>
    </div>
  );
}

/**
 * The card. `agent`: its profile as the service answered it — the search's or the card's ({id, handle, displayName, ownerId, ownerName,
 * intro}: the owner is named only from such an answer). `onLive()`: the add let me in at once; the dialogs the card is in close (the chat
 * opens after). `onBusy(on)`: the add is on its way (the dialog it is in may not be left meanwhile). `label`: the card's accessible name.
 */
export function AgentCard({ agent, onLive, onBusy, label }) {
  const { state, actions, dispatch } = useStore();
  const { busy, run } = useAction();
  /** What adding came to: "requested" (waiting for its owner); a let-in one opens the chat and closes the dialog. */
  const [outcome, setOutcome] = useState(null);
  const busyNow = useRef(onBusy);
  busyNow.current = onBusy;
  useEffect(() => {
    busyNow.current?.(busy === "add");
  }, [busy]);

  const add = async () => {
    const res = await run("add", () => actions.addAgentContact(agent.id), (e) => socialErrorText(e));
    if (!res.ok) return;
    if (res.value?.state === "live") {
      dispatch({ type: "toast", text: "已添加" });
      onLive?.();
      openAgentChat(state, dispatch, actions, res.value.conversationId);
    } else {
      // The outcome is said twice at most: a short toast, and one notice that says what happens next (the line under the button is left out then).
      dispatch({ type: "toast", text: "申请已发送" });
      setOutcome({ days: daysLeft(res.value?.until ?? "", Date.now()) ?? 7 });
    }
  };

  const reason = outcome ? "" : whyNotAgent(state, agent);
  const owner = agent.ownerName || state.people[agent.ownerId]?.name || "Agent 的主人";
  return (
    <section className="agent-found" aria-label={label ?? agent.displayName}>
      <AgentFace id={agent.id} name={agent.displayName}>
        <p className="muted">@{agent.handle}</p>
        <p className="muted">主人：{owner}</p>
        {agent.intro ? <p className="agent-found-intro">{agent.intro}</p> : null}
      </AgentFace>
      {/* The disclosure comes before any button (design §2: the request dialog says it). */}
      <p className="social-disclosure" data-testid="social-disclosure">
        {disclosureText([owner])}
      </p>
      {outcome && <Notice tone="ok">{`已发给${owner}，等对方同意。${outcome.days} 天没有回应会自动取消。`}</Notice>}
      <div className="agent-found-actions">
        <Btn variant="primary" disabled={Boolean(reason) || outcome !== null || busy !== null} reason={reason} onClick={add}>
          {busy === "add" ? "处理中…" : `添加${agent.displayName}`}
        </Btn>
      </div>
      <Reason>{reason}</Reason>
    </section>
  );
}

/** An Agent of a list (a search's, a person's): its face and its owner, one button that opens its card. `agent`: a profile as for the card. */
export function AgentRow({ agent, onOpen }) {
  return (
    <li>
      <button type="button" className="member-open" onClick={() => onOpen(agent)}>
        <Avatar id={agent.id} size={40} name={agent.displayName} />
        <span className="member-body">
          <span className="identity-line">
            <strong>{agent.displayName}</strong>
            <Tag>Agent</Tag>
          </span>
          {agent.ownerName ? <span className="muted">主人：{agent.ownerName}</span> : null}
        </span>
      </button>
    </li>
  );
}

/**
 * An Agent's card in a sheet of its own, over the page or the dialog it was opened from (its title is the Agent's name). `profile`: the
 * service's answer in hand already (a search's row); else the card is asked by `agentId` (a group's member) — and until it answers, or when
 * the service says it is not to be found by me, only what the member list had (`name`, the picture, the Agent tag) is shown: no button, no
 * owner, no reason (D1). My own Agent: its face, nothing asked. `onLive()`: as the card's (this sheet closes first).
 */
export function AgentSheet({ agentId, profile = null, name = "", onClose, onLive, returnTo = null }) {
  const { state, actions } = useStore();
  const mine = isMyAgent(state, agentId);
  /** null while asked; {profile}, {face: true} (mine, or not to be found by me), or {error: sentence}. */
  const [card, setCard] = useState(() => (profile ? { profile } : mine ? { face: true } : null));
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    if (profile || mine) return undefined;
    let alive = true;
    actions.agentCard(agentId).then(
      (answer) => alive && setCard({ profile: answer }),
      (error) => alive && setCard(error?.status === 404 ? { face: true } : { error: commonErrorText(error) }),
    );
    return () => {
      alive = false;
    };
  }, [actions, agentId, profile, mine]);

  const shown = card?.profile ?? null;
  const live = () => {
    onClose();
    onLive?.();
  };
  return (
    <Modal title={shown?.displayName ?? name} onClose={onClose} returnTo={returnTo} locked={adding}>
      {shown ? <AgentCard agent={shown} onLive={live} onBusy={setAdding} /> : <AgentFace id={agentId} name={name} />}
      {card === null && (
        <p className="muted" role="status">
          正在读取…
        </p>
      )}
      {card?.error && <Notice tone="warn">{card.error}</Notice>}
    </Modal>
  );
}

/**
 * A share link's Agent (`/a/<id>`: the navigation's `agentCard`, state/location.js `navAtStart`): once the first sync has said what the site
 * has, its card over the chat list. One that is not to be found by me is said in the lookup's own sentence (「没有找到这个账号。」), my own is
 * its face. While the site's switch is off nothing is asked or drawn: the address was the chat list, as before.
 */
export function SharedAgent() {
  const { state, dispatch, actions } = useStore();
  const id = state.nav.agentCard;
  const loaded = state.loaded === true;
  const on = socialOn(state);
  const mine = Boolean(id) && isMyAgent(state, id);
  const [profile, setProfile] = useState(null);
  const drop = () => {
    setProfile(null);
    dispatch({ type: "nav", patch: { agentCard: null } });
  };
  const dropNow = useRef(drop);
  dropNow.current = drop;
  useEffect(() => {
    if (!id || !loaded) return undefined;
    if (!on) {
      dropNow.current();
      return undefined;
    }
    if (mine) return undefined;
    let alive = true;
    actions.agentCard(id).then(
      (answer) => alive && setProfile(answer),
      (error) => {
        if (!alive) return;
        dropNow.current();
        dispatch({ type: "toast", text: friendErrorText("lookup", error) });
      },
    );
    return () => {
      alive = false;
    };
  }, [id, loaded, on, mine, actions, dispatch]);

  if (!id || !loaded || !on) return null;
  if (mine) return <AgentSheet key={id} agentId={id} name={nameOf(state, id)} onClose={drop} />;
  if (!profile || profile.id !== id) return null;
  return <AgentSheet key={id} agentId={id} profile={profile} onClose={drop} />;
}
