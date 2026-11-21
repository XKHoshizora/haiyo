import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../data/store.jsx";
import { ME } from "../data/identities.js";
import { convTitle, convSubtitle, isAgent, nameOf, publishBlock } from "../state/selectors.js";
import { ConvAvatar, Btn, IconBtn, Notice, Tag } from "../ui/primitives.jsx";
import { AgentModelSwitch } from "./ModelPicker.jsx";
import { MarkdownView, NEWEST_NEAR } from "../ui/markdownView.jsx";
import { withoutBidiControls } from "../ui/markdownRules.js";
import { REVEAL_FINISH_MS } from "../ui/reveal.js";
import { MessageItem } from "./Messages.jsx";
import { ImageViewerProvider } from "../ui/ImageViewer.jsx";
import {
  AGENT_PAUSED_TEXT,
  GroupReplying,
  GroupUnavailable,
  HaltBar,
  IMAGE_HINT,
  RunStatusLine,
  StreamBubble,
  forgetRevealed,
  isReplying,
  seesImages,
} from "./AgentChatBits.jsx";
import { ChatHitRow, SearchFooter } from "./SearchHits.jsx";
import { useJumpTo } from "./useJumpTo.js";
import { useMessageSearch } from "./useMessageSearch.js";
import { placeWhispers, searchHitView } from "../data/viewmodel.js";
import { Whisper } from "./Whisper.jsx";
import { Search, Menu, ChevronLeft, X } from "../icons.js";

import { Composer } from "./Composer.jsx";
import { droppedFiles, useSendFiles } from "./useSendFiles.js";

/**
 * This close to the bottom, scrolled to, the list counts as "at the newest message" again and follows new ones. It
 * stops following only when the person scrolls up (never because what is in it grew).
 */
const BOTTOM_SLACK_PX = 48;
/** A bubble finishing after its stored message came gives way to it at the latest this long after (its frames stalled). */
const FINISH_GIVE_UP_MS = REVEAL_FINISH_MS + 1000;
/** This close to the top, the page of older messages is loaded. */
const TOP_SLACK_PX = 120;
/** The newest message is marked read once the open chat has been in view this long. */
export const READ_DELAY_MS = 500;
/** After older (or newer) history failed to load, scrolling asks again only after this long. */
const OLDER_RETRY_MS = 3000;
/** A message jumped to stays highlighted this long. */
const FLASH_MS = 2000;
/** Search answers that need no word: a newer one replaced them, or the session ended. */
const hushed = (error) => ["stale", "stopped", "superseded"].includes(error?.code) || [401, 404].includes(error?.status);

const newestSeqOf = (messages) => messages.reduce((max, m) => (Number.isSafeInteger(m.seq) && m.seq > max ? m.seq : max), 0);
/** The person can see this tab: it is visible and the window has focus. */
const inView = () => document.visibilityState === "visible" && document.hasFocus();
/** The element is laid out: not inside a `display: none` pane (the phone layout hides the chat while the list shows). */
const onScreen = (element) => Boolean(element) && element.getClientRects().length > 0;
const firstMessageNode = (list) => [...list.children].find((li) => li.dataset.msg);
/** The newest message `from` sent (not a notice), or null. */
function newestFrom(messages, from) {
  for (let i = messages.length - 1; i >= 0; i -= 1) if (messages[i].from === from && messages[i].kind !== "system") return messages[i];
  return null;
}
const topWithin = (node, list) => node.getBoundingClientRect().top - list.getBoundingClientRect().top;

/**
 * The header line of my Agent's own conversation ends with the Agent's model now — a site model's label, a provider
 * model's name, 未选模型 when it has none — and its brand mark; it opens the model picker right there
 * (`AgentModelSwitch`). Nothing until the Agent's record is loaded (its model is not known before then), nothing for an
 * Agent not mine; a plain label once the Agent is deleted.
 */
function AgentModel({ agentId }) {
  const { state } = useStore();
  const agent = state.agents[agentId];
  if (!agent?.loaded || !agent.mine) return null;
  return (
    <>
      {" · "}
      <AgentModelSwitch agentId={agentId} />
    </>
  );
}

/**
 * Whether a bubble may finish revealing `stream` before `reply` (its stored message) takes its place: only when the
 * stored reply has every character the bubble would show, in the same order — so the finish never shows anything the
 * stored reply then takes away. Not when the service cut it (已截断: it streams on past what it keeps) or stopped it,
 * took a persona proposal out of it, or the stream was cut here; and its text must be the stream's, or begin with it (a
 * piece still on its way), both as the bubble shows text (bidi controls taken out), the stream trimmed at both ends as the service trims what it
 * stores. Marks and lengths first, then one comparison of the two texts: this is
 * asked once, when the stored reply comes, never at a frame.
 */
function finishable(reply, stream) {
  if (reply.truncated || reply.stopped || reply.proposal || stream.cut) return false;
  const stored = withoutBidiControls(reply.text);
  const streamed = withoutBidiControls(stream.text).trim();
  return stored.length >= streamed.length && stored.startsWith(streamed);
}

export function ChatView({ conv }) {
  const { state, dispatch, actions } = useStore();
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [replyTo, setReplyTo] = useState(null);
  /** Bumped when the person may have started looking (tab shown, window focused, scrolled to the newest). */
  const [attention, setAttention] = useState(0);
  const listRef = useRef(null);
  const atBottom = useRef(true);
  const lastSeen = useRef(null);
  /** While an older page loads: the first message on screen and where it was, to keep it in place. */
  const anchor = useRef(null);
  /** The conversation whose older page is loading, and when loading failed per conversation. */
  const older = useRef({ busy: null, failedAt: new Map() });
  /** Loading the messages after a detached window's newest one. */
  const newer = useRef({ busy: false, failedAt: 0 });
  const readFailed = useRef(null);
  /** The seq of the message just jumped to, highlighted for FLASH_MS. */
  const [flash, setFlash] = useState(null);
  const [dropping, setDropping] = useState(false);
  const block = publishBlock(state, conv);
  const group = conv.type === "group";
  const q = query.trim();
  // A detached window (around a search hit) is shown instead of the newest messages while it exists.
  const detached = Boolean(conv.detached);
  const messages = conv.window ? conv.window.messages : conv.messages;
  const hasOlder = conv.window ? conv.window.hasOlder : conv.hasOlder;
  const firstId = messages[0]?.id ?? null;
  const last = messages[messages.length - 1] ?? null;
  const newestSeq = newestSeqOf(conv.messages);
  const search = useMessageSearch(searching ? query : "", (term, before) => actions.searchConversation(conv.id, { q: term, before }), conv.id);
  const showHits = searching && q !== "";
  const hits = useMemo(() => search.hits.map((m) => searchHitView(m, { meId: state.account?.id ?? null, now: Date.now() })), [search.hits, state.account?.id]);
  const jumpTo = useJumpTo();
  const focus = state.nav.focus;
  /** The list's last known scroll position, kept by `onScroll`: a list hidden by the results reports 0, so it is never read then. */
  const lastTop = useRef(0);
  const wasShowingHits = useRef(false);

  // An Agent's conversation: its reply being written (a bubble at the end) or its failed reply (a status line at the
  // end), as the view model says; neither under a detached window, which does not reach the end.
  const agentChat = conv.type === "agent";
  const agent = agentChat ? state.agents[conv.agentId] ?? null : null;
  const run = agentChat && !detached ? conv.run : null;
  const replying = isReplying(run);
  const failedRun = run?.status === "failed" ? run : null;
  const paused = agentChat && !block && Boolean(agent ? agent.paused : conv.agent?.paused);
  // A reply whose stored message came while its bubble still had some of what it had received to reveal: the bubble
  // stays and finishes (within REVEAL_FINISH_MS: StreamBubble `finishing`), and the stored message waits meanwhile —
  // never both. Decided while rendering, so the bubble is never taken down for a moment. Only when the stored reply has
  // all the bubble would show (`finishable`: not cut, stopped — all of it was shown at the press — or changed); nor
  // with nothing left to reveal (reduced motion, a hidden tab: everything is shown). Otherwise the stored message
  // replaces the bubble at once. It ends when the bubble is done (in the same commit the stored message takes its
  // place), when anything comes after the reply, when the conversation changes or a new reply starts, and at the latest
  // FINISH_GIVE_UP_MS later.
  const shownStream = useRef(null);
  const revealedAll = useRef({ runId: null, done: true });
  const [finish, setFinish] = useState(null);
  if (agentChat && !replying && finish === null && shownStream.current) {
    const seen = shownStream.current;
    const reply = newestFrom(conv.messages, conv.agentId);
    const held = revealedAll.current;
    const posted = !detached && seen.convId === conv.id && conv.run?.id === seen.runId && conv.run.posted;
    if (posted && reply && last?.id === reply.id && held.runId === seen.runId && !held.done && finishable(reply, seen.stream)) {
      setFinish({ convId: conv.id, runId: seen.runId, stream: { ...seen.stream, text: seen.stream.text.trimEnd() }, run: conv.run, messageId: reply.id });
    }
  }
  const finishing = finish && finish.convId === conv.id && !replying && !detached && last?.id === finish.messageId ? finish : null;
  /** The reply whose bubble was shown at the last commit: `{ convId, runId }`, or null. */
  const bubbleShown = useRef(null);
  useLayoutEffect(() => {
    shownStream.current = replying && conv.stream ? { convId: conv.id, runId: run.id, stream: conv.stream } : null;
    // A bubble that gave way here (to its stored message, its end, a newer reply) is not made again: what it had shown
    // is forgotten. Not when the conversation was left or a detached window hides it: made again, it goes on from there.
    const showing = finishing ? finishing.runId : replying ? run.id : null;
    const was = bubbleShown.current;
    if (was && was.convId === conv.id && !detached && was.runId !== showing) forgetRevealed(was.runId);
    bubbleShown.current = showing ? { convId: conv.id, runId: showing } : null;
    if (finish && !finishing) setFinish(null);
  });
  useEffect(() => {
    if (!finish) return undefined;
    const timer = setTimeout(() => setFinish(null), FINISH_GIVE_UP_MS);
    return () => clearTimeout(timer);
  }, [finish]);
  // My whispers (悄悄话) among the messages, each after the message it follows, and the reply's bubble: at the end while it is
  // written, in its stored message's place while it finishes — so a whisper after that message is below it, and stays (`placeWhispers`).
  const whispers = conv.whispers ?? [];
  const rows = placeWhispers(messages, whispers, { complete: !hasOlder, toEnd: !detached, bubble: finishing ? finishing.messageId : replying ? true : null });
  // A group: each Agent's reply being written, my Agent's status line, someone else's 暂时无法回复 — at the end of the
  // list (not under a detached window); and 让 Agent 停下 above the composer while its Agents talk to each other.
  const groupRows = group && !detached ? conv.agentRuns ?? [] : [];
  const hasAgents = group && conv.members.some((id) => isAgent(state, id));
  const live = state.connection === "live";
  /** What changes at the end of the list besides messages: the bubble growing, the status lines coming or going. */
  const tail = `${replying ? `${run.id}:${conv.stream?.text.length ?? 0}:${conv.stream?.reasoning.length ?? 0}:${run.activity ?? ""}` : ""}|${finishing ? `finishing:${finishing.runId}` : ""}|${failedRun?.id ?? ""}|${groupRows
    .map((r) => `${r.agentId}:${r.kind}:${r.run?.id ?? ""}:${r.activity ?? ""}`)
    .join(",")}|${whispers.map((w) => `${w.id}:${w.status}`).join(",")}`;
  // A group with Agents: what their replies are now is fetched when it opens, and again when the connection comes back
  // (the pushes of a break are not sent again).
  useEffect(() => {
    if (hasAgents && live) actions.loadGroupRuns(conv.id);
  }, [conv.id, hasAgents, live, actions]);
  // Files picked, pasted or dropped are sent the same way (nothing is uploaded where sending is held). An image on its
  // way to an Agent whose model cannot see images gets one line under the composer, until its upload settles (sent or
  // refused) or another conversation is opened: `imagesSending` counts those in flight here.
  const sendFiles = useSendFiles(conv, block);
  const [imagesSending, setImagesSending] = useState({ convId: null, n: 0 });
  const sendAndNote = useCallback(
    (list) => {
      const images = sendFiles(list).filter(({ file }) => file.type?.startsWith("image/"));
      if (!agentChat || images.length === 0) return;
      const convId = conv.id;
      setImagesSending((s) => ({ convId, n: (s.convId === convId ? s.n : 0) + images.length }));
      const settled = () => setImagesSending((s) => (s.convId === convId ? { convId, n: Math.max(0, s.n - 1) } : s));
      for (const { done } of images) done.then(settled, settled);
    },
    [sendFiles, agentChat, conv.id],
  );
  const imagePending = imagesSending.convId === conv.id && imagesSending.n > 0;
  const imageHint = imagePending && seesImages(state, agent?.model) === false ? IMAGE_HINT : null;
  const providerNeeded = imagePending && agent?.model?.source === "provider" && !state.providers[agent.model.providerId] ? agent.model.providerId : null;
  // (A provider's model is looked up in my providers, read once when they are not held here.)
  useEffect(() => {
    if (providerNeeded) actions.loadProviders();
  }, [providerNeeded, actions]);
  // The Agent's reply is announced once, when its stored message arrives (never piece by piece while it streams).
  const newestReply = agentChat ? newestFrom(conv.messages, conv.agentId) : null;
  // The newest Agent texts: rendered first where the browser cannot tell which texts are near the visible part.
  const agentsHere = state.agents;
  const newestAgentTexts = useMemo(
    () => new Set(messages.filter((m) => m.kind === "text" && Boolean(agentsHere[m.from])).slice(-NEWEST_NEAR).map((m) => m.id)),
    [messages, agentsHere],
  );
  const [announcement, setAnnouncement] = useState("");
  const announced = useRef({ convId: null, seq: 0 });

  useEffect(() => {
    setSearching(false);
    setQuery("");
    setImagesSending({ convId: null, n: 0 });
  }, [conv.id]);

  useEffect(() => {
    const seq = newestReply?.seq ?? 0;
    if (announced.current.convId !== conv.id) {
      announced.current = { convId: conv.id, seq };
      setAnnouncement("");
    } else if (seq > announced.current.seq) {
      announced.current.seq = seq;
      setAnnouncement(`${nameOf(state, conv.agentId)}：${newestReply.text}`);
    }
  }, [conv.id, newestReply?.seq]);

  // A chat opens at its newest message. Opening it is also the person asking again for history that failed.
  useLayoutEffect(() => {
    atBottom.current = true;
    anchor.current = null;
    readFailed.current = null;
    older.current.failedAt.delete(conv.id);
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [conv.id]);

  // After the list changed: an older page keeps what was on screen where it was; otherwise a list that was at
  // the newest message stays there, and so does one where I just sent something. Scrolled up: no jump. (The end of
  // the list also changes while an Agent's reply streams in, or its status line comes or goes: the same rule.)
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const mineNew = last !== null && last.id !== lastSeen.current && last.from === ME && last.seq === null;
    lastSeen.current = last?.id ?? null;
    const held = anchor.current;
    if (held && held.convId === conv.id && firstId !== held.id) {
      anchor.current = null;
      const node = [...list.children].find((li) => li.dataset.msg === held.id);
      if (node) list.scrollTop += topWithin(node, list) - held.top;
      return;
    }
    // (A detached window is read from where the hit is: it never follows to its end.)
    if (!detached && (atBottom.current || mineNew)) {
      list.scrollTop = list.scrollHeight;
      lastTop.current = list.scrollTop;
      atBottom.current = true;
    }
  }, [conv.id, firstId, last?.id, messages.length, detached, tail]);

  // An Agent's text shown rich once its tree has come (or plain again), and a reply being revealed at every frame,
  // change its height: a list that was at the newest message stays there — one read of its height, then the scroll (its
  // position read back after it costs no layout). Scrolled up: nothing is read, and the browser keeps what is on screen
  // in place.
  const keepNewestInView = () => {
    const list = listRef.current;
    if (!list || detached || !atBottom.current || showHits) return;
    list.scrollTop = list.scrollHeight;
    lastTop.current = list.scrollTop;
  };

  // The results cover the list while there is a query: its scroll position is kept for when they go away.
  useLayoutEffect(() => {
    const list = listRef.current;
    const returning = wasShowingHits.current && !showHits;
    wasShowingHits.current = showHits;
    if (!list || !returning) return;
    // (Messages may have arrived while the results covered the list: at the newest ones, stay at the newest.)
    list.scrollTop = atBottom.current && !detached ? list.scrollHeight : lastTop.current;
  }, [showHits]);

  // A jump (nav.focus) scrolls to the message once it is shown, and highlights it for a moment.
  useLayoutEffect(() => {
    if (!focus || focus.convId !== conv.id) return;
    const node = [...(listRef.current?.children ?? [])].find((li) => li.dataset.msg === `m${focus.seq}`);
    if (!node) return;
    dispatch({ type: "nav", patch: { focus: null } });
    node.scrollIntoView({ block: "center" });
    setFlash(focus.seq);
  }, [focus, conv.id, messages, dispatch]);

  useEffect(() => {
    if (flash === null) return undefined;
    const timer = window.setTimeout(() => setFlash(null), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [flash]);

  /**
   * Loads the page before the oldest held message. `byScroll`: the person scrolled to the top — after a failure
   * that asks again once OLDER_RETRY_MS has passed. Otherwise (a history too short to scroll) a failure stops the
   * automatic path for this conversation until the person scrolls or opens the chat again, so nothing repeats on
   * its own while the service is unreachable.
   */
  function loadOlder({ byScroll }) {
    const list = listRef.current;
    const convId = conv.id;
    const { busy, failedAt } = older.current;
    if (!list || q || !hasOlder || busy === convId) return;
    if (failedAt.has(convId) && (!byScroll || Date.now() - failedAt.get(convId) < OLDER_RETRY_MS)) return;
    const first = firstMessageNode(list);
    anchor.current = first ? { convId, id: first.dataset.msg, top: topWithin(first, list) } : null;
    older.current.busy = convId;
    actions.loadOlder(convId).then((res) => {
      if (older.current.busy === convId) older.current.busy = null;
      if (res.ok) older.current.failedAt.delete(convId);
      else older.current.failedAt.set(convId, Date.now());
      // Nothing was added: nothing to keep in place.
      if ((!res.ok || res.loaded === 0) && anchor.current?.convId === convId) anchor.current = null;
      const quiet = ["stale", "stopped"].includes(res.error?.code) || [401, 404].includes(res.error?.status);
      if (!res.ok && !quiet) dispatch({ type: "toast", text: "更早的消息加载失败，请稍后再试" });
    });
  }

  // History shorter than the list's height cannot be scrolled: ask for older messages straight away (once per
  // page; not again on its own after a failure, see loadOlder).
  useEffect(() => {
    const list = listRef.current;
    if (list && hasOlder && list.clientHeight > 0 && list.scrollHeight <= list.clientHeight) loadOlder({ byScroll: false });
  }, [conv.id, hasOlder, messages.length, q]);

  /**
   * Loads the messages after a detached window's newest one (the window joins the newest ones when it reaches them).
   * `byScroll`: the person scrolled to the end — after a failure that asks again once OLDER_RETRY_MS has passed.
   */
  function loadNewer({ byScroll }) {
    const { busy, failedAt } = newer.current;
    if (!detached || q || busy) return;
    if (byScroll && failedAt && Date.now() - failedAt < OLDER_RETRY_MS) return;
    newer.current.busy = true;
    actions.loadNewer(conv.id).then((res) => {
      newer.current.busy = false;
      newer.current.failedAt = res.ok ? 0 : Date.now();
      if (!res.ok && !hushed(res.error)) dispatch({ type: "toast", text: "更新的消息加载失败，请稍后再试" });
    });
  }

  function backToNewest() {
    atBottom.current = true;
    actions.closeWindow(conv.id);
    setAttention((n) => n + 1);
  }

  function pickHit(hit) {
    setSearching(false);
    setQuery("");
    jumpTo(conv.id, hit.seq);
  }

  /**
   * The list scrolled. Following the newest messages stops only when the person scrolls up (its position went up and is
   * not the very end: the browser moving it up to a shorter list's end is not the person), and starts again when they
   * come back within BOTTOM_SLACK_PX of the end; content that grew under it changes neither. The scroll of the list's own
   * follow (where it was put, still following) is not measured.
   */
  function onScroll() {
    const list = listRef.current;
    const top = list.scrollTop;
    const own = atBottom.current && !detached && top === lastTop.current;
    let bottom = own;
    if (!own) {
      const gap = list.scrollHeight - top - list.clientHeight;
      bottom = gap <= BOTTOM_SLACK_PX;
      const up = top < lastTop.current && gap > 1;
      if (bottom && !up && !atBottom.current) {
        readFailed.current = null;
        setAttention((n) => n + 1);
      }
      // (A detached window never counts as "at the newest message": when it joins them the view must stay where it is.)
      if (detached || up) atBottom.current = false;
      else if (bottom) atBottom.current = true;
    }
    lastTop.current = top;
    if (top <= TOP_SLACK_PX) loadOlder({ byScroll: true });
    if (bottom) loadNewer({ byScroll: true });
  }

  useEffect(() => {
    const look = () => {
      readFailed.current = null;
      setAttention((n) => n + 1);
    };
    document.addEventListener("visibilitychange", look);
    window.addEventListener("focus", look);
    return () => {
      document.removeEventListener("visibilitychange", look);
      window.removeEventListener("focus", look);
    };
  }, []);

  // Mark read up to the newest message once the chat has been in view for a moment: the tab is visible, the
  // window focused, the chat laid out on screen (not behind the phone layout's list pane), the list at the newest
  // message, no search filtering it. A failed attempt is not repeated until something changes (a new message,
  // the person looks again, the chat pane is shown again).
  const pane = state.nav.pane;
  useEffect(() => {
    if (conv.unread === 0 || newestSeq === 0 || q || detached) return undefined;
    const key = `${conv.id}:${newestSeq}`;
    if (readFailed.current === key) return undefined;
    const timer = setTimeout(() => {
      // (A failure re-renders before it is recorded below, so this timer may predate it: check again.)
      if (readFailed.current === key || !inView() || !onScreen(listRef.current) || !atBottom.current) return;
      actions.markRead(conv.id, newestSeq).then((res) => {
        if (!res.ok) readFailed.current = key;
      });
    }, READ_DELAY_MS);
    return () => clearTimeout(timer);
  }, [conv.id, conv.unread, newestSeq, q, detached, attention, pane, actions]);

  // Files dropped anywhere on the chat are sent like picked ones (`sendAndNote`).
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes("Files");
  const dropHandlers = {
    onDragOver: (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (!block) setDropping(true); // a chat that cannot send does not invite the drop (it still answers it with the hold notice)
    },
    onDragLeave: (e) => {
      if (!e.currentTarget.contains(e.relatedTarget)) setDropping(false);
    },
    onDrop: (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDropping(false);
      sendAndNote(droppedFiles(e.dataTransfer));
    },
  };

  return (
    <section className={`chat${dropping ? " dropping" : ""}`} aria-label={convTitle(state, conv)} {...dropHandlers}>
      <header className="chat-head">
        <IconBtn label="返回列表" className="only-mobile" onClick={() => dispatch({ type: "nav", patch: { pane: "list" } })}><ChevronLeft size={22} /></IconBtn>
        <ConvAvatar conv={conv} size={56} />
        <div className="chat-title">
          <h2>
            {convTitle(state, conv)}
            {agentChat && (
              <>
                {" "}
                <Tag>Agent</Tag>
              </>
            )}
          </h2>
          <p>
            {convSubtitle(state, conv)}
            {agentChat && <AgentModel agentId={conv.agentId} />}
          </p>
        </div>
        <div className="chat-head-actions">
          <IconBtn label="搜索本会话" className="boxed" aria-pressed={searching} onClick={() => (setSearching(!searching), setQuery(""))}><Search size={22} /></IconBtn>
          {group ? (
            <Btn className="boxed" onClick={() => dispatch({ type: "nav", patch: { view: "profile", profileTab: "members" } })}>群资料</Btn>
          ) : null}
          <IconBtn label="会话资料" className="boxed" aria-pressed={state.nav.detailsOpen} onClick={() => dispatch({ type: "nav", patch: { detailsOpen: !state.nav.detailsOpen } })}><Menu size={22} /></IconBtn>
        </div>
      </header>

      {searching && (
        <div className="chat-search">
          <Search size={16} aria-hidden="true" />
          <input autoFocus value={query} maxLength={100} onChange={(e) => setQuery(e.target.value)} onKeyDown={e=>{if(e.key==="Escape"){setQuery("");setSearching(false);}}} placeholder="在本会话中搜索" aria-label="在本会话中搜索" />
          <span className="muted">{showHits && search.status === "ready" ? `${hits.length}${search.more ? "+" : ""} 条结果` : ""}</span>
          <IconBtn label="关闭会话搜索" onClick={()=>{setQuery("");setSearching(false);}}><X size={16}/></IconBtn>
        </div>
      )}
      {block && (
        <Notice tone="pause">
          <strong>{block.text}</strong>
        </Notice>
      )}
      {detached && (
        <Notice
          tone="info"
          action={
            <div className="notice-actions">
              <Btn small onClick={() => loadNewer({ byScroll: false })}>查看更新的消息</Btn>
              <Btn small variant="primary" onClick={backToNewest}>回到最新消息</Btn>
            </div>
          }
        >
          <strong>正在查看较早的消息</strong>
          {conv.unread > 0 ? `，有 ${conv.unread} 条新消息` : ""}
        </Notice>
      )}
      {showHits && (
        <ul className="rows search-hits" aria-label="搜索结果">
          {hits.map((hit) => (
            <ChatHitRow key={hit.key} hit={hit} q={search.q} onPick={pickHit} />
          ))}
          <SearchFooter search={search} emptyText="没有找到相关消息，请换个关键词" />
        </ul>
      )}
      <ImageViewerProvider messages={messages}>
      <MarkdownView listRef={listRef} newest={newestAgentTexts} onChange={keepNewestInView}>
        <ol className="messages" data-testid="message-list" ref={listRef} onScroll={onScroll} style={showHits ? { display: "none" } : undefined}>
          {rows.map(({ msg, whisper, bubble }) =>
            bubble ? (
              // One key wherever it is in the list: from written to finishing it is the same bubble, never made again.
              <StreamBubble
                key="stream-bubble"
                conv={conv}
                finishing={finishing}
                onReveal={(runId, done) => {
                  revealedAll.current = { runId, done };
                }}
                onFinished={() => setFinish(null)}
              />
            ) : whisper ? (
              <Whisper key={`w:${whisper.id}`} whisper={whisper} conv={conv} />
            ) : (
              <MessageItem key={msg.id} msg={msg} conv={conv} flash={flash !== null && msg.seq === flash} onReply={block ? () => dispatch({ type: "toast", text: block.text }) : setReplyTo} onJump={jumpTo} />
            ),
          )}
          {failedRun && <RunStatusLine key={failedRun.id} conv={conv} run={failedRun} />}
          {groupRows.map((row) =>
            row.kind === "replying" ? (
              <GroupReplying key={`${row.agentId}:replying`} conv={conv} row={row} />
            ) : row.kind === "status" ? (
              <RunStatusLine key={`${row.agentId}:${row.run.id}`} conv={conv} run={row.run} agentId={row.agentId} />
            ) : (
              <GroupUnavailable key={`${row.agentId}:unavailable`} agentId={row.agentId} />
            ),
          )}
          <li aria-hidden="true" />
        </ol>
      </MarkdownView>
      </ImageViewerProvider>

      {paused && <Notice tone="pause">{AGENT_PAUSED_TEXT}</Notice>}
      {group && conv.agentsTalking && <HaltBar key={conv.id} conv={conv} />}
      <Composer conv={conv} block={block} replyTo={replyTo} setReplyTo={setReplyTo} sendFiles={sendAndNote} note={imageHint} />
      {agentChat && (
        <p className="sr-only" aria-live="polite">
          {announcement}
        </p>
      )}
    </section>
  );
}
