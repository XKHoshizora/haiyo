// The one card of someone else's Agent (find-agent D9): its face, account name, owner and intro, the disclosure that the owner reads the chat,
// and 添加{name} (the existing add, POST /api/agent-contacts: let in at once, or a request that waits). Every way of finding an Agent ends in
// it: the add dialog's search, a person's Agents, a group's member (by its id, D1), a share link (`/a/<id>`, D2). Taken out of the add dialog.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../data/store.jsx";
import { commonErrorText, friendErrorText, socialErrorText } from "../data/errorTexts.js";
import { isMyAgent, nameOf } from "../state/selectors.js";
import { agentContactsOf, blockBetween, disclosureText, socialOn } from "../state/social.js";
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

/** A block between me and the Agent or its owner that this page knows of (fix round 1, G2): its card is no longer to be acted on. */
export const blockedAgent = (state, agent) => blockBetween(state, agent.ownerId) || blockBetween(state, agent.id);

/** The marks a dialog keeps of the Agents that cannot be added (their add answered 404): `{gone: Set, drop(id), forget(ids)}`. */
const OfferedContext = createContext(null);

function useMarks() {
  const [gone, setGone] = useState(() => new Set());
  const drop = useCallback((id) => setGone((was) => (was.has(id) ? was : new Set([...was, id]))), []);
  const forget = useCallback(
    (ids) =>
      setGone((was) => {
        const left = [...was].filter((id) => !ids.includes(id));
        return left.length === was.size ? was : new Set(left);
      }),
    [],
  );
  return useMemo(() => ({ gone, drop, forget }), [gone, drop, forget]);
}

/**
 * Which Agents may still be offered (fix round 2, H2). The marks live in one place per dialog: the nearest `OfferedScope`'s — the add
 * dialog's, shared by its results and every sheet and card opened from them — else this component's own (a contact card's list, a sheet
 * opened by itself), which it gives on with `OfferedScope`; they go with the dialog. `drop(id)`: its add answered 404 (a card does it);
 * `forget(ids)`: a fresh answer of the service lists them, so they are offered again. `cannot(agent)`: marked, or a block the page knows of
 * (G2); `offered(list)` leaves those Agents out (a person stays). `marks`: what `OfferedScope` gives on.
 */
export function useOfferedAgents() {
  const { state } = useStore();
  const outer = useContext(OfferedContext);
  const own = useMarks();
  const marks = outer ?? own;
  const cannot = (agent) => marks.gone.has(agent.id) || blockedAgent(state, agent);
  const offered = (list) => list.filter((entry) => entry.kind !== "agent" || !cannot(entry));
  return { marks, cannot, offered, drop: marks.drop, forget: marks.forget };
}

/** Gives a dialog's marks (`useOfferedAgents().marks`) to everything it opens. */
export function OfferedScope({ marks, children }) {
  return <OfferedContext.Provider value={marks}>{children}</OfferedContext.Provider>;
}

/** The Agents a search answer lists (its circle's, the exact Agent, the exact person's): what a fresh answer offers again. */
export const agentIdsOf = (answer) =>
  [...(Array.isArray(answer?.circle) ? answer.circle : []), answer?.exact?.agent, ...(Array.isArray(answer?.exact?.agents) ? answer.exact.agents : [])]
    .filter((entry) => entry && entry.kind === "agent" && typeof entry.id === "string")
    .map((entry) => entry.id);

/**
 * The adds on their way in a dialog, counted (fix round 2, H1): `[held, onBusy]` — `held` while any is on its way (the dialog may not be
 * left), `onBusy(on)` the card's signal, once `true` when an add starts and once `false` when it settles.
 */
export function usePendingAdds() {
  const [pending, setPending] = useState(0);
  const onBusy = useCallback((on) => setPending((n) => Math.max(0, n + (on ? 1 : -1))), []);
  return [pending > 0, onBusy];
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
 * The card. `agent`: its card as the service answered it — the search's or the card route's ({id, handle, displayName, ownerId, ownerName,
 * intro, field}: the owner is named only from such an answer). `onLive()`: the add let me in at once; the dialogs the card is in close (the
 * chat opens after). `onBusy(on)`: the add is on its way, told once when it starts and once when it settles — also if the card has left the
 * page by then (the dialog counts them: `usePendingAdds`). An add answered 404 (the Agent is not to be found by me any more: a block since,
 * a policy changed) marks it in the dialog's marks (`useOfferedAgents`): this card, and any of it in the same dialog, shows only its face from
 * then on, and the lists drop its row. `label`: its accessible name. A block the page knows of (G2), or the site's switch turned off (G5),
 * leaves the face only as well: nothing to add.
 */
export function AgentCard({ agent, onLive, onBusy, label }) {
  const { state, actions, dispatch } = useStore();
  const { busy, run } = useAction();
  const { cannot, drop } = useOfferedAgents();
  /** What adding came to: "requested" (waiting for its owner); a let-in one opens the chat and closes the dialog. */
  const [outcome, setOutcome] = useState(null);

  const add = async () => {
    onBusy?.(true);
    try {
      const res = await run("add", () => actions.addAgentContact(agent.id), (e) => socialErrorText(e));
      if (!res.ok) {
        if (res.error?.status === 404) drop(agent.id);
        return;
      }
      if (res.value?.state === "live") {
        dispatch({ type: "toast", text: "已添加" });
        onLive?.();
        openAgentChat(state, dispatch, actions, res.value.conversationId);
      } else {
        // The outcome is said twice at most: a short toast, and one notice that says what happens next (the line under the button is left out then).
        dispatch({ type: "toast", text: "申请已发送" });
        setOutcome({ days: daysLeft(res.value?.until ?? "", Date.now()) ?? 7 });
      }
    } finally {
      // (The parent's own state: it settles even when this card is no longer drawn, G4.)
      onBusy?.(false);
    }
  };

  const reason = outcome ? "" : whyNotAgent(state, agent);
  const owner = agent.ownerName || state.people[agent.ownerId]?.name || "Agent 的主人";
  if (cannot(agent) || !socialOn(state)) {
    return (
      <section className="agent-found" aria-label={label ?? agent.displayName}>
        <AgentFace id={agent.id} name={agent.displayName} />
      </section>
    );
  }
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
 * owner, no reason (D1); a card refused for its limit (429) is drawn the same, and asked again the next time the sheet opens. My own Agent:
 * its face, nothing asked. `onLive()`: as the card's (this sheet closes first on a let-in). It shares the marks of the dialog it was opened
 * from, else keeps its own (`OfferedScope`); a fresh card answer offers the Agent again. The site's switch turned off closes the sheet (G5).
 */
export function AgentSheet({ agentId, profile = null, name = "", onClose, onLive, returnTo = null }) {
  const { state, actions } = useStore();
  const mine = isMyAgent(state, agentId);
  const on = socialOn(state);
  const { marks, forget } = useOfferedAgents();
  /** null while asked; {profile}, {face: true} (mine, or not to be found by me), or {error: sentence}. */
  const [card, setCard] = useState(() => (profile ? { profile } : mine ? { face: true } : null));
  const [adding, onBusy] = usePendingAdds();
  useEffect(() => {
    if (profile || mine) return undefined;
    let alive = true;
    actions.agentCard(agentId).then(
      (answer) => {
        if (!alive) return;
        forget([agentId]);
        setCard({ profile: answer });
      },
      (error) => alive && setCard(error?.status === 404 || error?.status === 429 ? { face: true } : { error: commonErrorText(error) }),
    );
    return () => {
      alive = false;
    };
  }, [actions, agentId, profile, mine, forget]);
  const closeNow = useRef(onClose);
  closeNow.current = onClose;
  useEffect(() => {
    if (!on) closeNow.current();
  }, [on]);

  if (!on) return null;
  const shown = card?.profile ?? null;
  const live = () => {
    onClose();
    onLive?.();
  };
  return (
    <OfferedScope marks={marks}>
      <Modal title={shown?.displayName ?? name} onClose={onClose} returnTo={returnTo} locked={adding}>
        {shown ? <AgentCard agent={shown} onLive={live} onBusy={onBusy} /> : <AgentFace id={agentId} name={name} />}
        {card === null && (
          <p className="muted" role="status">
            正在读取…
          </p>
        )}
        {card?.error && <Notice tone="warn">{card.error}</Notice>}
      </Modal>
    </OfferedScope>
  );
}

/**
 * A share link's Agent (`/a/<id>`: the navigation's `agentCard`, state/location.js `navAtStart`): once the first sync has said what the site
 * has, its card over the chat list. One that is not to be found by me is said in the lookup's own sentence (「没有找到这个账号。」), my own is
 * its face (fix round 1, G6: kept so — the owner's own link reading "not found" would look broken). While the site's switch is off nothing
 * is asked or drawn: the address was the chat list, as before.
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
        // (A refusal for the card route's limit reads as one not to be found, and nothing is kept of it: the link asks again when opened again.)
        dispatch({ type: "toast", text: friendErrorText("lookup", error?.status === 429 ? { code: "not_found" } : error) });
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
