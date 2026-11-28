import React, { useEffect, useRef, useState } from "react";
import { useStore } from "../data/store.jsx";
import { friendErrorText } from "../data/errorTexts.js";
import { HANDLE_PATTERN, NAME_PART_PATTERN } from "../auth/validation.js";
import { Avatar, Btn, Field, Modal, Reason } from "../ui/primitives.jsx";
import { socialOn } from "../state/social.js";
import { useAction } from "./useAction.js";
import { AgentCard, AgentRow, AgentSheet } from "./AgentCard.jsx";
import { FriendRequestButton, PersonAgents, PersonProfile, PersonRow, whyNot } from "./PersonProfile.jsx";

/** An Agent's full account name: `<owner's handle>.<name part>`. */
const AGENT_HANDLE = new RegExp(`^${HANDLE_PATTERN.source.slice(1, -1)}\\.${NAME_PART_PATTERN.source.slice(1, -1)}$`);

/**
 * 添加好友: while the site's Agent social switch is on, finding people and Agents (find-agent D6): my circle as I type, an exact account name
 * on 查找; otherwise today's exact lookup of a person's account name.
 */
export function AddFriendModal(props) {
  const { state } = useStore();
  return socialOn(state) ? <FindModal {...props} /> : <LookupModal {...props} />;
}

/** Switch off: the exact account name of a person, looked up → their card → send a friend request. */
function LookupModal({ onClose, returnTo }) {
  const { state, actions } = useStore();
  const action = useAction();
  const { busy, run } = action;
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [found, setFound] = useState(null);

  const search = async (event) => {
    event.preventDefault();
    if (busy !== null) return;
    const handle = text.trim().toLowerCase().replace(/^@/, "");
    setFound(null);
    if (!HANDLE_PATTERN.test(handle)) {
      setError("账号名由 3–24 位小写字母、数字或下划线组成。");
      return;
    }
    setError("");
    const res = await run("lookup", () => actions.lookupPrincipal(handle), () => "");
    if (res.ok) setFound(res.value);
    else if (res.error?.code === "not_found") setError(`没有找到账号名为 ${handle} 的用户。目前还不能添加 Agent 为好友。`);
    else setError(friendErrorText("lookup", res.error));
  };

  return (
    <Modal title="添加好友" onClose={onClose} returnTo={returnTo} footer={<Btn onClick={onClose}>完成</Btn>}>
      <form onSubmit={search}>
        <Field label="对方的账号名" error={error} hint="输入完整的账号名（不是昵称），例如 ann_li。">
          <input value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck="false" data-autofocus />
        </Field>
        <Btn type="submit" variant="primary" disabled={busy !== null || !text.trim()}>
          {busy === "lookup" ? "查找中…" : "查找"}
        </Btn>
      </form>
      {found && (
        <ul className="member-rows" aria-label="查找结果">
          <li>
            <Avatar id={found.id} size={48} />
            <div className="member-body">
              <strong>{state.people[found.id]?.name ?? found.displayName}</strong>
              <p className="muted">@{found.handle}</p>
            </div>
            <div className="member-actions">
              <FriendRequestButton person={found} action={action} />
            </div>
          </li>
        </ul>
      )}
      {found && <Reason>{whyNot(state, found)}</Reason>}
    </Modal>
  );
}

/** How long the typing rests before my circle is asked (ms). */
const SUGGEST_AFTER_MS = 300;
/** What is typed as the search reads it (as the service does): trimmed, a leading @ dropped. */
const queryOf = (text) => text.trim().replace(/^@/, "").trim();
const listOf = (answer) => (Array.isArray(answer?.circle) ? answer.circle : []);

/**
 * Switch on. As I type, my circle (friends, their Agents, the Agents of my groups, the Agents I added), 300 ms after the last key; the newest
 * request wins (an older one is ended, its answer dropped), and a refused suggestion is quiet (the last list stays). 查找 or Enter is the exact
 * step: also the person of that exact account name with their Agents, or the Agent of that full name (the one card). A person opens their
 * profile, an Agent its card; every Agent ends in the existing add (AgentCard.jsx).
 */
function FindModal({ onClose, returnTo }) {
  const { state, actions } = useStore();
  const action = useAction();
  const { busy, run } = action;
  const [text, setText] = useState("");
  /** The latest list of my circle that came (what is shown while the next is asked). */
  const [circle, setCircle] = useState([]);
  /** The exact step's answer for the text as it is: undefined before it (or after a change), null for nothing, {person, agents} or {agent}. */
  const [exact, setExact] = useState(undefined);
  const [error, setError] = useState("");
  /** The sheet open over the dialog: {agent} (a profile) or {person, agents?}. */
  const [open, setOpen] = useState(null);
  /** The card of the Agent found is adding it: the dialog may not be left meanwhile. */
  const [adding, setAdding] = useState(false);
  const latest = useRef(0);
  const inflight = useRef(null);
  const timer = useRef(null);
  const query = queryOf(text);

  /** Nothing asked before this is wanted any more: the scheduled suggestion is not sent, the one on its way is ended. → this request's number. */
  const askAnew = () => {
    latest.current += 1;
    window.clearTimeout(timer.current);
    timer.current = null;
    inflight.current?.abort();
    inflight.current = null;
    return latest.current;
  };

  useEffect(() => {
    askAnew();
    setExact(undefined);
    setError("");
    if (!query) {
      setCircle([]);
      return undefined;
    }
    timer.current = window.setTimeout(() => {
      timer.current = null;
      const mine = askAnew();
      const controller = new AbortController();
      inflight.current = controller;
      actions.searchPrincipals(query, { signal: controller.signal }).then(
        (answer) => mine === latest.current && setCircle(listOf(answer)),
        // (Quiet: the last list stays — a refusal for the limit among them; the explicit step says what went wrong.)
        () => {},
      );
    }, SUGGEST_AFTER_MS);
    return () => window.clearTimeout(timer.current);
  }, [query, actions]);
  useEffect(() => () => void askAnew(), []);

  const find = async (event) => {
    event.preventDefault();
    if (busy !== null || !query) return;
    const mine = askAnew();
    // (The search hides my own Agent as it hides what is not there: said here, before it.)
    const handle = query.toLowerCase();
    if (AGENT_HANDLE.test(handle) && handle.startsWith(`${state.account?.handle}.`)) {
      setExact(undefined);
      setError("你自己的 Agent 不用添加。");
      return;
    }
    setError("");
    const res = await run("lookup", () => actions.searchPrincipals(query, { exact: true }), () => "");
    if (mine !== latest.current) return;
    if (res.ok) {
      setCircle(listOf(res.value));
      setExact(res.value?.exact ?? null);
    } else setError(friendErrorText("lookup", res.error));
  };

  const person = exact?.person ?? null;
  const agent = exact?.agent ?? null;
  const theirs = Array.isArray(exact?.agents) ? exact.agents : [];
  // (What the exact step shows is not listed again under my circle.)
  const shownExactly = new Set([person?.id, agent?.id, ...theirs.map((a) => a.id)].filter(Boolean));
  const listed = circle.filter((entry) => !shownExactly.has(entry.id));
  const agentsBy = (via) => listed.filter((entry) => entry.kind === "agent" && entry.via === via);
  const sections = [
    ["好友", listed.filter((entry) => entry.kind !== "agent")],
    ["好友的 Agent", agentsBy("friend")],
    ["同群的 Agent", agentsBy("group")],
    ["已添加的 Agent", agentsBy("contact")],
  ];
  const openPerson = (who) => setOpen({ person: who });
  const nothing = exact === null && circle.length === 0;

  return (
    <Modal title="添加好友或 Agent" onClose={onClose} returnTo={returnTo} locked={adding} footer={<Btn disabled={adding} onClick={onClose}>完成</Btn>}>
      <div className="find-agent">
        <form onSubmit={find}>
          <Field label="昵称或账号名" error={error} hint="输入昵称或账号名。找不认识的人，要输入对方完整的账号名。">
            <input
              type="search"
              enterKeyHint="search"
              maxLength={100}
              value={text}
              onChange={(e) => setText(e.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck="false"
              data-autofocus
            />
          </Field>
          <Btn type="submit" variant="primary" disabled={busy !== null || !query}>
            {busy === "lookup" ? "查找中…" : "查找"}
          </Btn>
        </form>
        {sections.map(
          ([title, entries]) =>
            entries.length > 0 && (
              <React.Fragment key={title}>
                <h3>{title}</h3>
                <ul className="member-rows" aria-label={title}>
                  {entries.map((entry) =>
                    entry.kind === "agent" ? (
                      <AgentRow key={entry.id} agent={entry} onOpen={(found) => setOpen({ agent: found })} />
                    ) : (
                      <PersonRow key={entry.id} person={entry} onOpen={openPerson} />
                    ),
                  )}
                </ul>
              </React.Fragment>
            ),
        )}
        {person && (
          <>
            <ul className="member-rows" aria-label="查找结果">
              <PersonRow person={person} onOpen={(who) => setOpen({ person: who, agents: theirs })}>
                <div className="member-actions">
                  <FriendRequestButton person={person} action={action} />
                </div>
              </PersonRow>
            </ul>
            <Reason>{whyNot(state, person)}</Reason>
            <PersonAgents person={{ ...person, displayName: state.people[person.id]?.name ?? person.displayName }} agents={theirs} onLive={onClose} />
          </>
        )}
        {agent && <AgentCard key={agent.id} agent={agent} label="查找结果" onLive={onClose} onBusy={setAdding} />}
        {nothing && <p className="muted">没有找到。找不认识的人，要输入对方完整的账号名，例如 ann_li。</p>}
      </div>
      {open?.agent && <AgentSheet agentId={open.agent.id} profile={open.agent} onClose={() => setOpen(null)} onLive={onClose} />}
      {open?.person && <PersonProfile person={open.person} agents={open.agents ?? null} onClose={() => setOpen(null)} onLive={onClose} />}
    </Modal>
  );
}
