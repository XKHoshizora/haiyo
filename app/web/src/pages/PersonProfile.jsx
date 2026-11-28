// A person's profile (find-agent A, D10): their picture, name and account name, how we stand (the friend request), and 「{name}的 Agent」 —
// the Agents of theirs I may see, for whoever knows their account name (R2), each opening the one card (AgentCard.jsx). Also for a person
// this page holds nothing of (a search's result): the person is what the caller hands in.
import React, { useEffect, useRef, useState } from "react";
import { useStore } from "../data/store.jsx";
import { commonErrorText, friendErrorText } from "../data/errorTexts.js";
import { isAgent, nameOf } from "../state/selectors.js";
import { blockedMe, iBlocked, relationOf, socialOn } from "../state/social.js";
import { Avatar, Btn, Modal, Reason } from "../ui/primitives.jsx";
import { useAction } from "./useAction.js";
import { AgentRow, AgentSheet, OfferedScope, agentIdsOf, useOfferedAgents } from "./AgentCard.jsx";

/** What stops me from sending this person a request, or "" when I can. */
export function whyNot(state, person) {
  if (person.id === state.account?.id) return "这是你自己的账号。";
  if (iBlocked(state, person.id)) return "你已拉黑对方，需先解除拉黑。";
  if (blockedMe(state, person.id)) return "对方拉黑了你，无法发送申请。";
  const rel = relationOf(state, person.id);
  if (rel === "friend") return "你们已经是好友了。";
  if (rel === "outgoing") return "申请已发送，等待对方确认。";
  if (rel === "incoming") return "对方已向你发来申请，请在通讯录里处理。";
  return "";
}

/**
 * 发送好友申请 to `person` ({id, handle}); disabled, with the reason as its title, when it cannot be sent (the caller shows `whyNot` under it).
 * `action`: the `useAction()` of the dialog it is in, when one action at a time is the dialog's (the add dialog's 查找 waits for it too).
 */
export function FriendRequestButton({ person, action }) {
  const { state, actions, dispatch } = useStore();
  const own = useAction();
  const { busy, run } = action ?? own;
  const reason = whyNot(state, person);
  const send = async () => {
    const res = await run("send", () => actions.sendFriendRequest(person.handle), (e) => friendErrorText("sendRequest", e));
    if (res.ok) dispatch({ type: "toast", text: "好友申请已发送" });
  };
  return (
    <Btn small variant="primary" disabled={Boolean(reason) || busy !== null} reason={reason} onClick={send}>
      {busy === "send" ? "发送中…" : "发送好友申请"}
    </Btn>
  );
}

/** A person of a list (the add dialog's): picture, name and account name as one button that opens their profile; `children` sit beside it. */
export function PersonRow({ person, onOpen, children }) {
  const { state } = useStore();
  const name = state.people[person.id]?.name ?? person.displayName;
  return (
    <li>
      <button type="button" className="member-open" onClick={() => onOpen({ ...person, displayName: name })}>
        <Avatar id={person.id} size={40} name={name} />
        <span className="member-body">
          <strong>{name}</strong>
          <span className="muted">@{person.handle}</span>
        </span>
      </button>
      {children}
    </li>
  );
}

/**
 * 「{name}的 Agent」 of `person` ({id, handle, displayName}): `agents` when in hand (the add dialog's exact step), else asked by the exact
 * step of their account name (`GET /api/principals/search?exact=1`). Nothing while asked, when there is none, or when the step was refused
 * for its limit (429: the person is shown without them, and without an error). Each opens its card over the page; `onLive()` as the card's.
 * An Agent whose add answered 404, or any of theirs once a block is known, is no longer listed (G2); the marks are the dialog's it is in
 * (the add dialog's), else its own, given on to the cards it opens (fix round 2, H2); its own fresh answer offers its Agents again.
 */
export function PersonAgents({ person, agents: given = null, onLive }) {
  const { actions } = useStore();
  const [asked, setAsked] = useState(null);
  const [failed, setFailed] = useState("");
  const { offered, marks, forget } = useOfferedAgents();
  const agents = offered(given ?? asked ?? []);
  const [open, setOpen] = useState(null);
  useEffect(() => {
    if (given) return undefined;
    let alive = true;
    actions.searchPrincipals(person.handle, { exact: true }).then(
      (res) => {
        if (!alive) return;
        forget(agentIdsOf(res));
        setAsked(res?.exact?.person?.id === person.id && Array.isArray(res.exact.agents) ? res.exact.agents : []);
      },
      (error) => alive && error?.status !== 429 && setFailed(commonErrorText(error)),
    );
    return () => {
      alive = false;
    };
  }, [actions, person.id, person.handle, given, forget]);

  const title = `${person.displayName}的 Agent`;
  return (
    <OfferedScope marks={marks}>
      {failed && <p className="muted">{failed}</p>}
      {agents.length > 0 && (
        <>
          <h3>{title}</h3>
          <ul className="member-rows" aria-label={title}>
            {agents.map((agent) => (
              <AgentRow key={agent.id} agent={agent} onOpen={setOpen} />
            ))}
          </ul>
        </>
      )}
      {open && <AgentSheet agentId={open.id} profile={open} onClose={() => setOpen(null)} onLive={onLive} />}
    </OfferedScope>
  );
}

/**
 * The profile in a sheet (its title is the person's name), over the page or the dialog it was opened from. `person`: {id, handle (without
 * the @), displayName}; `agents`: their Agents when in hand. `onLive()`: an Agent of theirs let me in at once (this sheet closes first).
 * The site's switch turned off closes it (G5).
 */
export function PersonProfile({ person, agents = null, onClose, onLive, returnTo = null }) {
  const { state } = useStore();
  const on = socialOn(state);
  const closeNow = useRef(onClose);
  closeNow.current = onClose;
  useEffect(() => {
    if (!on) closeNow.current();
  }, [on]);
  if (!on) return null;
  const name = state.people[person.id]?.name ?? person.displayName;
  const live = () => {
    onClose();
    onLive?.();
  };
  return (
    <Modal title={name} onClose={onClose} returnTo={returnTo}>
      <div className="person-sheet">
        <ul className="member-rows">
          <li>
            <Avatar id={person.id} size={56} name={name} />
            <div className="member-body">
              <p className="muted">@{person.handle}</p>
            </div>
            <div className="member-actions">
              <FriendRequestButton person={person} />
            </div>
          </li>
        </ul>
        <Reason>{whyNot(state, person)}</Reason>
        <PersonAgents person={{ ...person, displayName: name }} agents={agents} onLive={live} />
      </div>
    </Modal>
  );
}

/** A member of a group's list, opened (Agent social): an Agent's card, asked by its id (D1), or a person's profile. */
export function MemberSheet({ id, onClose }) {
  const { state } = useStore();
  if (isAgent(state, id)) return <AgentSheet agentId={id} name={nameOf(state, id)} onClose={onClose} />;
  const who = state.people[id];
  if (!who) return null;
  return <PersonProfile person={{ id, handle: String(who.handle ?? "").replace(/^@/, ""), displayName: who.name }} onClose={onClose} />;
}
