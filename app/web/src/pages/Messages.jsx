import React, { useContext, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../data/store.jsx";
import { ME } from "../data/identities.js";
import { isAgent, isMyAgent, nameOf, ownerOf, publishBlock, senderName } from "../state/selectors.js";
import { formatSize, namesAgent, replyPoints } from "../data/viewmodel.js";
import { useShowReplyPoints } from "../data/prefs.js";
import { failureText, retryHopeless } from "../data/uploadErrors.js";
import { Avatar, Btn, Tag } from "../ui/primitives.jsx";
import { MentionText } from "../ui/MentionText.jsx";
import { FileCard } from "../ui/FileCard.jsx";
import { thumbMaxWidth, thumbSize } from "../ui/thumbSize.js";
import { useBubbleMenu } from "../ui/BubbleMenu.jsx";
import { messageActions } from "./messageActions.js";
import { GrowContext, useImageViewer } from "../ui/ImageViewer.jsx";
import { LabLogo, labOfModel } from "../ui/LabLogo.jsx";
import { AgentModelSwitch, EVERYWHERE_NOTE, levelLabel } from "./ModelPicker.jsx";
import { AgentText, ProposalCard, Thinking, TopicDivider } from "./AgentChatBits.jsx";
import { MemoryNotice } from "./MemoryChip.jsx";
import { ReplyLookups } from "./ReplyLookups.jsx";
import { citingOf, WebSources } from "./WebSources.jsx";
import { CitesContext } from "../ui/cites.jsx";
import { Reply, RotateCw, FileText, Check, CircleAlert } from "../icons.js";

/** The quoted message as the reader may see it: the service says whether it is visible to them. */
function Quote({ quote }) {
  const { state } = useStore();
  if (!quote) return null;
  if (!quote.visible) return <blockquote>引用的消息不在你的可见范围内</blockquote>;
  return (
    <blockquote>
      <strong>{quote.from ? senderName(state, quote.from) : ""}</strong>
      {quote.kind === "file" ? quote.attachmentName : quote.text}
    </blockquote>
  );
}

/** What a file message says besides the file: the caption (its mentions as tags), and the quote when it replies to something. */
function Caption({ msg }) {
  if (!msg.caption && !msg.quote) return null;
  return (
    <div className="bubble">
      <Quote quote={msg.quote} />
      <MentionText text={msg.caption} mentions={msg.mentions} />
    </div>
  );
}

/** A file that cannot be shown or fetched (no longer visible to me, removed): neutral, no reason given. */
function UnavailableCard({ name }) {
  return (
    <div className="card file-card">
      <FileText size={28} aria-hidden="true" />
      <div>
        <strong>文件不可用</strong>
        <p className="muted">{name}</p>
      </div>
    </div>
  );
}

/**
 * A picture: only the picture (its file name is its accessible name); pressing it opens the viewer (ui/ImageViewer.jsx). It is
 * drawn in its own shape inside a box (ui/thumbSize.js; only an extreme shape is cut, from the middle). The wire carries no
 * width and height, so the box is reserved from the picture's natural size as soon as it is known (at once for a cached one);
 * until then the placeholder (3:2, styles.css) holds the place.
 */
function ImageBody({ msg }) {
  const [broken, setBroken] = useState(false);
  const [box, setBox] = useState(null);
  const img = useRef(null);
  const viewer = useImageViewer();
  const grew = useContext(GrowContext);
  const measure = (node) => setBox(thumbSize({ width: node.naturalWidth, height: node.naturalHeight }, { maxWidth: thumbMaxWidth(window.innerWidth) }));
  useLayoutEffect(() => {
    if (img.current?.complete && img.current.naturalWidth) measure(img.current);
  }, [msg.src]);
  // (The box is its final size now: a list that was at its newest message stays there; scrolled up, nothing moves.)
  useLayoutEffect(() => {
    if (box) grew?.();
  }, [box?.width, box?.height]);
  if (broken) return <UnavailableCard name={msg.text} />;
  return (
    <figure className="attachment-image" data-sized={box ? "" : undefined} style={box ? { width: box.width } : undefined}>
      <button
        type="button"
        className="image-open"
        aria-haspopup="dialog"
        data-image={msg.id}
        style={box ? { aspectRatio: `${box.width} / ${box.height}` } : undefined}
        onClick={(e) => viewer.open(msg.id, e.currentTarget)}
      >
        <img ref={img} src={msg.src} alt={msg.text} loading="lazy" onLoad={(e) => measure(e.currentTarget)} onError={() => setBroken(true)} />
      </button>
    </figure>
  );
}

function FileBody({ msg }) {
  const { upload, attachment } = msg;
  return <FileCard name={msg.text} size={attachment.size} mime={attachment.mime} url={attachment.url} upload={upload} />;
}

/**
 * An Agent's text, with its citations (`msg.cites`, beside its text) as links that jump to their messages (`onJump`), and
 * the chips of the web pages it cites (`msg.webCites`), which open them. A reply whose run was handed web pages
 * (`msg.plainLinks`) shows its own links as plain text: only its sources open anything.
 */
function CitingAgentText({ msg, onJump }) {
  const value = useMemo(() => citingOf(msg, onJump), [msg.cites, msg.webCites, msg.plainLinks, onJump]);
  return (
    <CitesContext.Provider value={value}>
      <AgentText text={msg.text} id={msg.id} mentions={msg.mentions} />
    </CitesContext.Provider>
  );
}

function Body({ msg, agent, onJump }) {
  if (msg.kind === "image" || msg.kind === "file")
    return (
      <>
        {msg.kind === "image" ? <ImageBody msg={msg} /> : <FileBody msg={msg} />}
        <Caption msg={msg} />
      </>
    );
  return (
    <div className="bubble">
      <Quote quote={msg.quote} />
      {agent ? <CitingAgentText msg={msg} onJump={onJump} /> : <MentionText text={msg.text} mentions={msg.mentions} />}
    </div>
  );
}

/** A text the service refused because one of its picked mentions is no longer here (`bad_mentions`): 改一下 puts it back. */
export const STALE_MENTION_TEXT = "有一个 @ 的对象已经不在这里了，改一下再发。";

/** How the line under a reply says the thinking level its run was sent: the Agent form's words. */
const levelWords = (level) => (level === "none" ? "不思考" : `思考：${levelLabel(level)}`);

/**
 * The muted line under a reply of my own Agent: which model and thinking level its run used (`via`, sent to its owner
 * only), and — when 在每条回复下显示消耗的点数 is on in this browser — what it cost: “GPT-6 Sol · 思考：中 · 6.9 点”;
 * a reply on my own provider's model costs no points: “ · 不扣点”. A reply the Agent gave unasked ends “ · 主动回复”.
 * In a group (`agentId`: the Agent, mine) the model's name is a quiet button opening the model picker for the Agent —
 * whose model it is everywhere; the line goes on saying what that reply used.
 */
function ReplyVia({ via, agentId = null }) {
  const withPoints = useShowReplyPoints();
  const { model } = via;
  const name = model.source === "site" ? model.label : model.model;
  const lab = model.source === "site" ? labOfModel(model.id) ?? labOfModel(model.label) : labOfModel(model.model);
  let points = "";
  if (withPoints) {
    if (model.source === "provider" && via.points === "0") points = " · 不扣点";
    else if (replyPoints(via.points)) points = ` · ${replyPoints(via.points)} 点`;
  }
  // Its web searches (their price is in its points): only when its run made any.
  const searched = via.webSearches > 0 ? ` · 联网搜索 ${via.webSearches} 次` : "";
  const rest = ` · ${levelWords(via.reasoning)}${points}${searched}${via.proactive ? " · 主动回复" : ""}`;
  if (agentId) {
    return (
      <p className="msg-via">
        <AgentModelSwitch agentId={agentId} shown={{ name, brand: lab }} note={EVERYWHERE_NOTE} />
        {rest}
      </p>
    );
  }
  return (
    <p className="msg-via">
      <LabLogo lab={lab} size={14} />
      {`${name}${rest}`}
    </p>
  );
}

/** One message of `conv`; `onJump(conversationId, seq)`: the chat's jump (to a message an Agent's reply found). */
export function MessageItem({ msg, conv, onReply, onJump, flash = false }) {
  const { state, dispatch, actions } = useStore();
  // The menu of a bubble (long-press, right-click, the context-menu key): ui/BubbleMenu.jsx.
  const bubbleMenu = useBubbleMenu(() => messageActions({ state, dispatch, msg, onReply }));
  // A notice of an event this client does not know shows nothing.
  if (msg.hidden) return null;
  if (msg.kind === "system") {
    if (msg.system?.event === "topic_reset") return <TopicDivider msg={msg} />;
    // What my Agent remembered: only in my own conversation with it, never in a group.
    if (msg.system?.event === "memory_changed") return conv.type === "agent" ? <MemoryNotice msg={msg} conv={conv} /> : null;
    return (
      <li className="msg-system" data-msg={msg.id}>
        <span>{msg.text}</span>
      </li>
    );
  }
  const mine = msg.from === ME;
  const agent = !mine && isAgent(state, msg.from);
  // What only an owner is shown of a reply: its thinking and which model and level it used (`via`), in the conversation
  // with my own Agent and in a group when the Agent is mine (never someone else's Agent's, whatever the message
  // carries); a persona proposal only in the conversation with my own Agent, never in a group. (已停止 and 已截断 show
  // wherever the reply is.)
  const ownChat = agent && conv.type === "agent" && conv.agentId === msg.from;
  const thinking = ownChat || (agent && conv.type === "group" && isMyAgent(state, msg.from));
  // Read state in direct chats and in an Agent's (by its marker); "sending" is shown wherever it happens.
  const showReceipt = mine && (conv.type === "human" || conv.type === "agent");
  // Why my message to my own Agent may get no reply (shown after 已发送, nothing else changes): it is paused, or it
  // answers only when named and this message did not name it (its stored mentions, as the service decided at send).
  const ownAgent = mine && conv.type === "agent" ? state.agents[conv.agentId] : null;
  const sentNote = ownAgent?.paused
    ? " · 它暂停中"
    : ownAgent?.replyMode === "mention" && !namesAgent(msg, conv.agentId)
      ? " · 没点名，它不会回复"
      : "";
  const cancelUpload = () => actions.cancelUpload(msg.clientTxn);
  const retry = () => {
    const block = publishBlock(state, conv);
    if (block) dispatch({ type: "toast", text: block.text });
    else actions.retrySend(msg.clientTxn);
  };
  const stamp = (
    <time dateTime={msg.createdAt ?? undefined} title={msg.atTitle || undefined}>
      {msg.at}
    </time>
  );
  return (
    <li className={`msg ${mine ? "mine" : "theirs"}${flash ? " flash" : ""}`} data-msg={msg.id}>
      <Avatar id={msg.from} size={40} />
      <div className="msg-main" {...bubbleMenu.bind}>
        <div className="msg-meta">
          {/* My own (right-aligned) messages read time then name, so the name stays next to the avatar. */}
          {mine && stamp}
          <strong>{senderName(state, msg.from)}</strong>
          {agent && <Tag>Agent</Tag>}
          {agent && <span className="owner">主人：{nameOf(state, ownerOf(state, msg.from))}</span>}
          {!mine && stamp}
        </div>
        {thinking && <Thinking text={msg.reasoning} />}
        {/* A reply that is only a persona proposal has no text: its card alone, no empty bubble. */}
        {!(ownChat && msg.proposal && !msg.text && !msg.quote) && <Body msg={msg} agent={agent} onJump={onJump} />}
        {/* What the reply looked up with its tools: one quiet line, for whoever reads the reply (its own per conversation). */}
        {agent && <ReplyLookups key={`${conv.id}:${msg.id}`} msg={msg} conv={conv} onJump={onJump} />}
        {agent && <WebSources sources={msg.webSources} />}
        {ownChat && msg.proposal && <ProposalCard msg={msg} conv={conv} />}
        {thinking && msg.via && <ReplyVia via={msg.via} agentId={!ownChat && state.agents[msg.from]?.loaded ? msg.from : null} />}
        <div className="msg-foot">
          {agent && msg.stopped && <Tag tone="muted">已停止</Tag>}
          {agent && msg.truncated && <Tag tone="muted">已截断</Tag>}
          {msg.status === "failed" ? (
            <>
              <span className="failed">
                <CircleAlert size={14} aria-hidden="true" /> 发送失败，未发布
              </span>
              {msg.kind === "file" && <span className="muted">{failureText(msg.error)}</span>}
              {msg.error?.code === "bad_mentions" && (
                <>
                  <span className="muted">{STALE_MENTION_TEXT}</span>
                  <Btn small onClick={() => actions.reviseFailed(msg.clientTxn)}>
                    改一下
                  </Btn>
                </>
              )}
              {!(msg.kind === "file" && retryHopeless(msg.error)) && msg.error?.code !== "bad_mentions" && (
                <Btn small onClick={retry}>
                  <RotateCw size={14} aria-hidden="true" /> 重试
                </Btn>
              )}
              {msg.upload === null && msg.kind === "file" && !msg.attachment.id && (
                <Btn small onClick={cancelUpload}>
                  取消
                </Btn>
              )}
            </>
          ) : msg.upload ? (
            <>
              <span className="receipt">{msg.upload.phase === "queued" ? "等待上传…" : `上传中 ${Math.round(msg.upload.progress * 100)}%`}</span>
              <Btn small onClick={cancelUpload}>
                取消
              </Btn>
            </>
          ) : msg.status === "sending" ? (
            <span className="receipt">发送中…</span>
          ) : (
            showReceipt && (
              <span className="receipt">
                {msg.status === "read" ? (
                  <>
                    <Check size={13} aria-hidden="true" /> 已读
                  </>
                ) : (
                  `已发送${sentNote}`
                )}
              </span>
            )
          )}
          {mine && msg.notCalled && <span className="muted">{msg.notCalled}</span>}
          {(msg.kind === "text" || msg.kind === "image") && msg.seq !== null && msg.status !== "failed" && msg.status !== "sending" && (
            <button type="button" className="msg-action" aria-haspopup="menu" onClick={() => onReply(msg)}>
              <Reply size={15} aria-hidden="true" /> 回复
            </button>
          )}
        </div>
      </div>
      {bubbleMenu.element}
    </li>
  );
}
