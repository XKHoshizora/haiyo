// The parts of a conversation with one of my Agents that a human chat does not have: its text (ui/AgentText.jsx, for
// stored and streaming replies), the folded thinking, the reply being written, the failed reply's status line, the persona
// proposal card, the new-topic confirmation and divider, and the image hint. In a group (batch 2C): each Agent's reply
// being written (never streamed), my Agent's status line, someone else's Agent's 暂时无法回复, and 让 Agent 停下. Each
// shows what the view model says (`conv.run`, `conv.stream`, `conv.agentRuns`, `msg.proposal`…); none of them derives it
// again from the model.
import React, { useEffect, useRef, useState } from "react";
import { useStore } from "../data/store.jsx";
import { MODEL_GONE, runFailureText } from "../data/errorTexts.js";
import { nameOf, ownerOf, publishBlock } from "../state/selectors.js";
import { GrowingText, StreamingAgentText } from "../ui/AgentText.jsx";
import { CitesContext } from "../ui/cites.jsx";
import { REVEAL_END_MS, REVEAL_FINISH_MS } from "../ui/reveal.js";
import { Avatar, Btn, Field, IconBtn, Modal, Notice, Reason, Tag, focusInvalid } from "../ui/primitives.jsx";
import { refusalText, settled, useAction, useNow } from "./useAction.js";
import { openModelChoice } from "./ModelPicker.jsx";
import { RotateCw, Sparkles, Square, X } from "../icons.js";

/** The pause notice of a paused Agent (as on its detail page). */
export const AGENT_PAUSED_TEXT = "已暂停全部会话：它不会有新回复。与「停止生成」不同，这不是只中断一次回复。恢复后，暂停期间收到的消息不会补上回复。";
/** Under the composer when an image goes to an Agent whose model cannot see images. */
export const IMAGE_HINT = "当前模型看不到图片，只会知道文件名";

const PERSONA_MAX = 20000;
const INTRO_MAX = 40;
const FIELD_MAX = 20;
const chars = (text) => [...text].length;

/** Whether the Agent's model sees images: true or false, or null when that is not known here (no model, not loaded). */
export function seesImages(state, model) {
  if (!model) return null;
  if (model.source === "site") return state.siteModels.find((m) => m.id === model.id)?.vision ?? null;
  return state.providers[model.providerId]?.models.find((m) => m.name === model.model)?.vision ?? null;
}

/** Whether a reply of the conversation's Agent is being written: queued or running, its message not here yet. */
export const isReplying = (run) => Boolean(run) && (run.status === "queued" || run.status === "running") && !run.posted;

export { AgentText, StreamingAgentText, loadMarkdown } from "../ui/AgentText.jsx";

/**
 * Ends a reply being written (or its thinking) of which only the first part is kept and shown (model.js STREAM_CHARS).
 * It promises nothing about the stored reply: the service keeps a reply's first part only, too.
 */
export const STREAM_CUT_NOTE = "（内容较长，仅显示开头部分）";
const StreamCutNote = () => <span className="md-note">{STREAM_CUT_NOTE}</span>;

/**
 * The model's thinking: folded above the answer, opened only by the reader. `cut`: more came than is shown (a stream);
 * `summary`: its header (思考过程; while a reply is still thinking, 正在思考… and its seconds).
 */
export function Thinking({ text, cut = false, summary = "思考过程" }) {
  if (!text) return null;
  return (
    <details className="thinking">
      <summary>{summary}</summary>
      <div className="thinking-text">
        {text}
        {cut && <StreamCutNote />}
      </div>
    </details>
  );
}

const Dots = () => (
  <span className="dots" aria-hidden="true">
    <i />
    <i />
    <i />
  </span>
);

/** A reply before any of its text: three dots and what it is doing (正在回复…; the dots alone when that is said above). */
function Writing({ text = "正在回复…" }) {
  return (
    <>
      <Dots />
      {text && ` ${text}`}
    </>
  );
}

/** What a reply says while its tool runs, by the kind of the tool's work (a run's `activity`). */
const ACTIVITY_LINES = { search: "正在查聊天记录…", file: "正在看文件…", time: "正在看时间…", web: "正在上网查找…" };
/** The line for `activity` (`search`, `file`, `time`, `web`), or null for none — or for a kind this page does not know. */
export const activityLine = (activity) => (typeof activity === "string" && Object.hasOwn(ACTIVITY_LINES, activity) ? ACTIVITY_LINES[activity] : null);

/** What a reply that thinks says before its text: 正在思考…, then the whole seconds it has been thinking. */
export const thinkingLine = (seconds) => (seconds > 0 ? `正在思考… ${seconds} 秒` : "正在思考…");

/**
 * The whole seconds since `since` (a time, ms), kept current once a second (at each whole second) while `counting`;
 * no timer otherwise, nor once the component has gone.
 */
export function useThinkingSeconds(since, counting) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!counting) return undefined;
    let timer = null;
    const tick = () => {
      const t = Date.now();
      setNow(t);
      const into = (((t - since) % 1000) + 1000) % 1000;
      timer = setTimeout(tick, 1000 - into);
    };
    tick();
    return () => clearTimeout(timer);
  }, [since, counting]);
  return Math.max(0, Math.floor((now - since) / 1000));
}

/** What the thinking section of a reply that is done thinking says: 思考了 and its whole seconds (at least 1). */
export const thoughtFor = (ms) => `思考了 ${Math.max(1, Math.floor(ms / 1000))} 秒`;

/**
 * When this page saw each reply's moments (by run id), for its thinking seconds — one clock a reply, from its start to
 * its text: `start` (first seen, queued or thinking) and `textAt` (its first piece of text: a time, null before it, or
 * false when it came while its bubble was not shown — a time this page did not see). The service's run carries no
 * times; these survive leaving the conversation and coming back (the bubble is made again), for the newest
 * RUN_CLOCKS_KEPT replies. With them, `thinkingOpen`: whether the reader has that reply's thinking open (folded until
 * the reader opens it, LiveThinking).
 */
const runClocks = new Map();
const RUN_CLOCKS_KEPT = 50;
function runClock(runId) {
  let clock = runClocks.get(runId);
  if (clock === undefined) {
    clock = { start: Date.now(), textAt: null, thinkingOpen: false };
    runClocks.set(runId, clock);
    if (runClocks.size > RUN_CLOCKS_KEPT) runClocks.delete(runClocks.keys().next().value);
  }
  return clock;
}

/**
 * Notes the first piece of a reply's text as this bubble sees it: at the moment it sees it, if it saw the reply without
 * it before (in this showing); otherwise it came while the bubble was not shown (false).
 */
function useRunClock(runId, text) {
  const clock = runClock(runId);
  const watched = useRef({ runId, text: false });
  if (watched.current.runId !== runId) watched.current = { runId, text: false };
  const seen = watched.current;
  if (!text) seen.text = true;
  else if (clock.textAt === null) clock.textAt = seen.text ? Date.now() : false;
  return clock;
}

/**
 * How much of each reply's text its bubble has shown (by run id), so that a bubble made again — its conversation left
 * and opened again, or a detached window closed, while the reply is written — goes on from there instead of revealing
 * it all again. Forgotten when the reply's bubble gives way to its stored message, its end or a newer reply (ChatView:
 * `forgetRevealed`); the newest REVEALED_KEPT at most. A run id is never used twice, and its text only grows.
 */
const revealedSoFar = new Map();
/** What a reply being written hands its text while the site offers web search (ui/cites.jsx `CitesContext`): no citation, its links plain. */
const PLAIN_LINKS = Object.freeze({ cites: [], onJump: null, plainLinks: true });
const REVEALED_KEPT = 20;
function noteRevealed(runId, upTo) {
  if (!revealedSoFar.has(runId) && revealedSoFar.size >= REVEALED_KEPT) revealedSoFar.delete(revealedSoFar.keys().next().value);
  revealedSoFar.set(runId, upTo);
}
/** The reply's bubble gave way: what it had shown is not kept any more. */
export function forgetRevealed(runId) {
  revealedSoFar.delete(runId);
}

/**
 * The thinking of a reply being written, under `summary`: folded from its first piece, like a stored reply's — also
 * while it still thinks (its header then counts, 正在思考… N 秒). Only the reader opens it, and it stays as the reader
 * left it for that reply: through its text starting, and through this bubble being made again (`kept`: the reply's
 * record, `runClock`). Each piece is appended to its text (GrowingText), opened or not: work for what came, not for
 * all of it.
 */
function LiveThinking({ text, cut, summary, kept }) {
  const [open, setOpen] = useState(kept.thinkingOpen);
  if (!text) return null;
  // (Every toggle that differs from what is rendered is the reader's; the one a bubble made again open fires matches it.)
  const toggled = (event) => {
    kept.thinkingOpen = event.currentTarget.open;
    setOpen(kept.thinkingOpen);
  };
  return (
    <details className="thinking" open={open} onToggle={toggled}>
      <summary>{summary}</summary>
      <div className="thinking-text">
        <GrowingText text={text} />
        {cut && <StreamCutNote />}
      </div>
    </details>
  );
}

/**
 * 停止生成 for a reply of mine: the reply of an Agent conversation, or (`agentId`) of my Agent in a group. The button stays
 * disabled from the press until that run ends (a new run has its own button); a stop that could not be sent says why.
 * `onStopping(true)` at the press, `onStopping(false)` when the stop could not be sent; `disabled`: nothing to stop any more.
 */
function StopButton({ conversationId, agentId = null, runId, disabled = false, onStopping = null }) {
  const { dispatch, actions } = useStore();
  const [stopping, setStopping] = useState(null);
  const stop = async () => {
    setStopping(runId);
    onStopping?.(true);
    const res = await (agentId ? actions.stopRun(conversationId, agentId) : actions.stopRun(conversationId));
    if (res.ok) return;
    // The reply ended meanwhile (nothing to stop), or it is not there any more: nothing to say.
    if (res.error?.code === "no_run" || res.error?.status === 404) return;
    setStopping(null);
    onStopping?.(false);
    dispatch({ type: "toast", text: res.text });
  };
  return (
    <Btn small disabled={disabled || stopping === runId} onClick={stop}>
      <Square size={12} aria-hidden="true" /> 停止生成
    </Btn>
  );
}

/**
 * The reply being written, at the end of the list: its text so far, revealed a little at every frame (ui/reveal.js;
 * the text received is kept as it comes, model.js), its thinking, and 停止生成. Before the first piece of its text — and
 * for a reply that was already under way when this page connected, whose text is not sent again — it says 正在回复…, or
 * for an Agent that thinks (its reasoning level is not none) 正在思考… and the whole seconds since this page first saw
 * the reply (queued or thinking). While such a reply's thinking streams, that line heads its thinking instead (the same
 * count, from the same start); once its text starts the header reads 思考了 N 秒 — from that start to its first piece of
 * text; 思考过程 when this page did not see when its text started. The thinking is folded all along, while it thinks
 * too: only the reader opens it, and it stays as the reader left it for that reply (LiveThinking). The stored reply's
 * thinking reads 思考过程 as ever, folded. A bubble made again while the reply is written (its
 * conversation left and opened again) shows at once what it had shown, and goes on from there. A press of
 * 停止生成 (until a stop that could not be sent) and a run that is not running any more show everything received at
 * once. A very long reply shows its first part only, and says so under it (what is left of that part is revealed
 * within a moment); the stored reply shows what the service kept, and replaces the bubble the moment it arrives,
 * revealed or not — unless `finishing` (ChatView): its stored message came while some of what it had received was still
 * unrevealed, so the bubble shows that stream (`finishing.stream`, `finishing.run`) to its end within REVEAL_FINISH_MS,
 * 停止生成 disabled, and calls `onFinished()` then. `onReveal(runId, done)` tells ChatView, whenever it changes, whether
 * all the text received is shown. Busy for assistive technology while it grows: the stored reply that replaces it is
 * announced instead (ChatView). While its tool runs (`run.activity`) it says what kind of thing it looks at
 * (`activityLine`: 正在查聊天记录…, 正在看文件…, 正在看时间…) — in place of 正在回复… / 正在思考… before any text, under the
 * text written so far after it.
 */
export function StreamBubble({ conv, finishing = null, onReveal = null, onFinished = null }) {
  const { state } = useStore();
  const run = finishing ? finishing.run : conv.run;
  const stream = finishing ? finishing.stream : conv.stream;
  const text = stream?.text ?? "";
  const reasoning = stream?.reasoning ?? "";
  const thinks = (state.agents[conv.agentId]?.reasoning ?? "none") !== "none";
  const thinking = thinks && !text;
  const clock = useRunClock(run.id, text);
  const seconds = useThinkingSeconds(clock.start, thinking);
  const [stopped, setStopped] = useState(null);
  const line = thinking ? thinkingLine(seconds) : null;
  let summary = "思考过程";
  if (thinking) summary = line;
  else if (thinks && clock.textAt) summary = thoughtFor(clock.textAt - clock.start);
  // What its tool looks at now, while one runs.
  const doing = finishing ? null : activityLine(run.activity);
  // While the site offers web search, what any reply writes shows its links as plain text until it is stored (a reply that
  // searched keeps them so, WebSources.jsx): this page may not have seen it search (a reload, another tab).
  const linksPlain = state.webSearchAvailable === true ? PLAIN_LINKS : null;
  // (While its thinking streams, the line heads it, folded: the bubble keeps the dots only; so it does for the frame before
  // the first characters of the text of a reply that thought.)
  const waiting = <Writing text={doing ?? (thinking ? (reasoning ? "" : line) : undefined)} />;
  return (
    <li className="msg theirs streaming" aria-busy="true">
      <Avatar id={conv.agentId} size={40} />
      <div className="msg-main">
        <div className="msg-meta">
          <strong>{nameOf(state, conv.agentId)}</strong>
          <Tag>Agent</Tag>
        </div>
        <LiveThinking key={run.id} text={reasoning} cut={stream?.reasoningCut} summary={summary} kept={clock} />
        <div className="bubble">
          {text ? (
            <>
              <CitesContext.Provider value={linksPlain}>
                <StreamingAgentText
                  key={run.id}
                  text={text}
                  paced
                  ended={Boolean(stream.cut) || Boolean(finishing)}
                  endWithin={stream.cut ? REVEAL_END_MS : REVEAL_FINISH_MS}
                  all={stopped === run.id || (!finishing && run.status !== "running")}
                  resumeAt={revealedSoFar.get(run.id) ?? 0}
                  placeholder={thinks ? <Writing text="" /> : waiting}
                  onShown={(upTo, length) => {
                    noteRevealed(run.id, upTo);
                    onReveal?.(run.id, upTo >= length);
                    if (finishing && upTo >= length) onFinished?.();
                  }}
                />
              </CitesContext.Provider>
              {stream.cut && <StreamCutNote />}
              {doing && (
                <p className="muted">
                  <Writing text={doing} />
                </p>
              )}
            </>
          ) : (
            waiting
          )}
        </div>
        <div className="msg-foot">
          <StopButton key={run.id} conversationId={conv.id} runId={run.id} disabled={Boolean(finishing)} onStopping={(on) => setStopped(on ? run.id : null)} />
        </div>
      </div>
    </li>
  );
}

/**
 * An Agent's reply being written in a group (`row` of `conv.agentRuns`): its identity line as a finished Agent message has it
 * (name, Agent tag, 主人：<name>), then 正在回复… only — or, while its tool runs (`row.activity`), what kind of thing it
 * looks at (`activityLine`) — nothing streams in a group, nor is any thinking shown. Its owner may stop it; nobody else
 * has a control.
 */
export function GroupReplying({ conv, row }) {
  const { state } = useStore();
  return (
    <li className="msg theirs streaming" aria-busy="true">
      <Avatar id={row.agentId} size={40} />
      <div className="msg-main">
        <div className="msg-meta">
          <strong>{nameOf(state, row.agentId)}</strong>
          <Tag>Agent</Tag>
          <span className="owner">主人：{nameOf(state, ownerOf(state, row.agentId))}</span>
        </div>
        <div className="bubble">
          <Writing text={activityLine(row.activity) ?? undefined} />
        </div>
        {row.mine && (
          <div className="msg-foot">
            <StopButton key={row.run.id} conversationId={conv.id} agentId={row.agentId} runId={row.run.id} />
          </div>
        )}
      </div>
    </li>
  );
}

/** Someone else's Agent could not reply in a group: one muted line, no reason (that is its owner's to know). */
export function GroupUnavailable({ agentId }) {
  const { state } = useStore();
  return (
    <li className="msg-system run-unavailable">
      <span>{nameOf(state, agentId)}暂时无法回复</span>
    </li>
  );
}

/**
 * 让 Agent 停下, above a group's composer while its Agents are talking to each other (any member may press it): their
 * calling each other stops until a person speaks. Disabled while the request is on its way; a refusal says why.
 */
export function HaltBar({ conv }) {
  const { dispatch, actions } = useStore();
  const mounted = useMounted();
  const [busy, setBusy] = useState(false);
  const halt = async () => {
    setBusy(true);
    const res = await actions.haltAgents(conv.id);
    if (!mounted.current) return;
    setBusy(false);
    if (!res.ok) dispatch({ type: "toast", text: res.text });
  };
  return (
    <div className="quick-bar">
      <Btn small disabled={busy} onClick={halt}>
        <Square size={12} aria-hidden="true" /> 让 Agent 停下
      </Btn>
    </div>
  );
}

/** Keeps answers that arrive after the component has gone (its run moved on) from being applied. */
function useMounted() {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}

/**
 * One decision at a time on a card or notice (`busy` names it) and the sentence of a refusal (`refusal`, until the next
 * decision). `pending(key, request)` resolves with the answer; `decide(key, request)` also keeps a refusal's text. A
 * refusal's answer is the last thing it does: nothing is set once the component has gone.
 */
export function useDecision() {
  const mounted = useMounted();
  const [busy, setBusy] = useState(null);
  const [refusal, setRefusal] = useState(null);
  const pending = async (key, request) => {
    setBusy(key);
    const res = await request;
    if (mounted.current) setBusy(null);
    return res;
  };
  const decide = async (key, request) => {
    setRefusal(null);
    const res = await pending(key, request);
    if (mounted.current && !res.ok) setRefusal(res.text);
    return res;
  };
  return { mounted, busy, refusal, pending, decide };
}

/** How a reply in a group ended that trying again cannot change: a member halted it, or its Agent was taken out. */
const NOT_RETRIED = new Set(["halted", "agent_removed"]);

/**
 * A failed reply, at the end of the list: not a message (no seq, no avatar, no time, nothing to quote or find). Its
 * sentence, 重试 when trying again may work, where to fix it (usage and balance, the Agent's edit page), and a close
 * control. A retry refused because a reply is already going says nothing (that reply shows as it comes); any other
 * refusal says why here. In a group (`agentId`: which of my Agents) the line names the Agent, and also tells of a reply
 * a member halted or whose Agent was taken out of the group — neither can be retried.
 */
export function RunStatusLine({ conv, run, agentId = null }) {
  const { state, dispatch, actions } = useStore();
  const agent = agentId ?? conv.agentId;
  // (A site model's key and address are the site's: its sentence does not send me to my settings.)
  const source = state.agents[agent]?.model?.source ?? null;
  const mounted = useMounted();
  // (A reset time reads 今天 / 明天 from now: kept current while the line is shown.)
  const now = useNow();
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState(null);
  const go = (patch) => dispatch({ type: "nav", patch: { pane: "main", ...patch } });
  const act = async (key, work, quiet = () => false) => {
    setBusy(key);
    setNote(null);
    const res = await work();
    if (!mounted.current) return;
    setBusy(null);
    if (!res.ok && !quiet(res.error)) setNote(res.text);
  };
  const retry = () => act("retry", () => (agentId ? actions.retryRun(conv.id, agentId) : actions.retryRun(conv.id)), (error) => error?.code === "busy_run");
  const dismiss = () => act("dismiss", () => (agentId ? actions.dismissRun(conv.id, agentId) : actions.dismissRun(conv.id)));
  return (
    <li className="msg-system run-status">
      <Notice
        tone="warn"
        action={
          <span className="notice-actions">
            {run.retryable && !NOT_RETRIED.has(run.error) && (
              <Btn small variant="primary" disabled={busy !== null} onClick={retry}>
                <RotateCw size={13} aria-hidden="true" /> 重试
              </Btn>
            )}
            {run.error === "no_quota" && (
              <Btn small onClick={() => go({ section: "settings", settingsPage: "usage" })}>
                查看用量与余额
              </Btn>
            )}
            {run.error === "context_too_small" && (
              <Btn small onClick={() => go({ section: "agents", agentId: agent, agentView: "edit" })}>
                修改 Agent
              </Btn>
            )}
            {run.error === "model_gone" && (
              <Btn small onClick={() => openModelChoice(dispatch, agent)}>
                {MODEL_GONE.action}
              </Btn>
            )}
            <IconBtn label="关闭提示" disabled={busy !== null} onClick={dismiss}>
              <X size={16} />
            </IconBtn>
          </span>
        }
      >
        {agentId && (
          <>
            <strong>{nameOf(state, agentId)}</strong>：
          </>
        )}
        {runFailureText(run, now, source)}
        {note && <span className="notice-sub">{note}</span>}
      </Notice>
    </li>
  );
}

/** A divider where a new topic began (the `topic_reset` notice): nothing before it is sent to the Agent any more. */
export function TopicDivider({ msg }) {
  return (
    <li className="msg-divider" data-msg={msg.id} title={msg.text}>
      <span>新话题</span>
    </li>
  );
}

/** Asks before starting a new topic in the Agent's conversation. */
export function NewTopicModal({ conv, onClose }) {
  const { actions } = useStore();
  const { busy, run } = useAction();
  const confirm = async () => {
    const res = await run("topic", () => settled(actions.resetTopic(conv.id)), refusalText);
    if (res.ok) onClose();
  };
  return (
    <Modal
      title="开始新话题"
      onClose={onClose}
      footer={
        <>
          <Btn data-autofocus onClick={onClose}>
            取消
          </Btn>
          <Btn variant="primary" disabled={busy !== null} onClick={confirm}>
            {busy !== null ? "处理中…" : "开始新话题"}
          </Btn>
        </>
      }
    >
      <p>之前的对话不会再发给它，聊天记录仍然保留。</p>
    </Modal>
  );
}

/** A proposal's state: the tag on its card. */
const PROPOSAL_STATUS = {
  open: ["待你确认", "pending"],
  confirmed: ["已采用", "ok"],
  discarded: ["已放弃", "muted"],
  superseded: ["已被新的提议取代", "muted"],
  stale: ["已失效", "warn"],
};
const FOLD_LINES = 5;
const FOLD_CHARS = 240;

/** The first lines of a long persona (null when it is short enough to show whole). */
function foldedText(text) {
  let head = text.split("\n").slice(0, FOLD_LINES).join("\n");
  if (chars(head) > FOLD_CHARS) head = [...head].slice(0, FOLD_CHARS).join("");
  return head === text ? null : `${head}…`;
}

/**
 * The proposal opened in an editor (its 简介 / 擅长领域 only when it proposes them). Confirming sends only what I changed
 * (nothing changed: no edits), and only that is checked: a value the Agent proposed is the proposal's, not mine.
 * `busy` is the card's: one decision at a time, from the card or from here.
 */
function ProposalEditor({ proposal, busy, onClose, onConfirm }) {
  const mounted = useMounted();
  const hasIntro = typeof proposal.intro === "string";
  const hasField = typeof proposal.field === "string";
  const [persona, setPersona] = useState(proposal.persona ?? "");
  const [intro, setIntro] = useState(proposal.intro ?? "");
  const [field, setField] = useState(proposal.field ?? "");
  const [tried, setTried] = useState(false);
  const [refusal, setRefusal] = useState(null);
  const edits = {};
  const body = persona.replace(/\0/g, "").trim();
  if (body !== (proposal.persona ?? "")) edits.persona = body;
  if (hasIntro && intro.trim() !== proposal.intro) edits.intro = intro.trim();
  if (hasField && field.trim() !== proposal.field) edits.field = field.trim();
  const errors = {
    persona: !("persona" in edits) ? "" : !body ? "人格文档不能为空" : chars(body) > PERSONA_MAX ? `人格文档不超过 ${PERSONA_MAX} 个字` : "",
    intro: "intro" in edits && chars(edits.intro) > INTRO_MAX ? `简介不超过 ${INTRO_MAX} 个字` : "",
    field: "field" in edits && chars(edits.field) > FIELD_MAX ? `擅长领域不超过 ${FIELD_MAX} 个字` : "",
  };
  const shown = (key) => (tried ? errors[key] : "");
  const submit = async () => {
    setTried(true);
    if (errors.persona || errors.intro || errors.field) {
      focusInvalid();
      return;
    }
    setRefusal(null);
    const res = await onConfirm(edits);
    if (!mounted.current) return;
    if (res.ok) onClose();
    else setRefusal(res.text);
  };
  return (
    <Modal
      title="修改后确认"
      wide
      onClose={onClose}
      footer={
        <>
          <Btn onClick={onClose}>取消</Btn>
          <Btn variant="primary" disabled={busy !== null} onClick={submit}>
            {busy === "edit" ? "处理中…" : "确认"}
          </Btn>
        </>
      }
    >
      <Field label="人格文档" hint={`${chars(persona)} / ${PERSONA_MAX}`} error={shown("persona")}>
        <textarea data-autofocus rows={10} value={persona} onChange={(e) => setPersona(e.target.value)} />
      </Field>
      {hasIntro && (
        <Field label="简介" error={shown("intro")}>
          <input value={intro} onChange={(e) => setIntro(e.target.value)} />
        </Field>
      )}
      {hasField && (
        <Field label="擅长领域" error={shown("field")}>
          <input value={field} onChange={(e) => setField(e.target.value)} />
        </Field>
      )}
      <Reason>确认后，它从下一次回复起按新的人格文档回复。人格文档只影响它如何回复，不授予任何权限。</Reason>
      {refusal && (
        <p className="field-msg" role="alert">
          {refusal}
        </p>
      )}
    </Modal>
  );
}

/**
 * The persona an Agent proposes in a reply (`msg.proposal`): the persona (folded beyond a few lines), the 简介 and
 * 擅长领域 it names, and by its state 确认 / 修改后确认 / 放弃 or what became of it. A refusal (the proposal went stale or
 * was superseded meanwhile) fetches the card again (the actions do), and its sentence stays on the card until the card
 * shows its real state.
 */
export function ProposalCard({ msg, conv }) {
  const { state, actions } = useStore();
  const { busy, refusal, pending, decide } = useDecision();
  const p = msg.proposal;
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const persona = p.persona ?? "";
  const folded = foldedText(persona);
  const open = p.status === "open";
  // A deleted Agent's proposals can no longer be decided (an open one is then only "not confirmed").
  const decidable = open && !publishBlock(state, conv);
  const [label, tone] = open && !decidable ? ["未确认", "muted"] : PROPOSAL_STATUS[p.status] ?? [p.status, "muted"];
  // One decision at a time, from the card or its editor: `busy` names it ("confirm" | "discard" | "edit").
  const confirm = () => decide("confirm", actions.confirmProposal(conv.agentId, p.id));
  const discard = () => decide("discard", actions.discardProposal(conv.agentId, p.id));
  // (The editor says its own refusal; a card that went stale or was superseded meanwhile closes it.)
  const confirmEdited = (edits) => pending("edit", actions.confirmProposal(conv.agentId, p.id, edits));
  return (
    <div className="card proposal-card">
      <div className="card-head">
        <Sparkles size={18} aria-hidden="true" />
        <strong>配置提议</strong>
        <Tag tone={tone}>{label}</Tag>
      </div>
      <dl className="mini-kv">
        {p.intro && (
          <div>
            <dt>简介</dt>
            <dd>{p.intro}</dd>
          </div>
        )}
        {p.field && (
          <div>
            <dt>擅长领域</dt>
            <dd>{p.field}</dd>
          </div>
        )}
        <div>
          <dt>人格文档</dt>
          <dd className="proposal-persona">{folded === null || expanded ? persona : folded}</dd>
        </div>
      </dl>
      {folded !== null && (
        <Btn small variant="text" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? "收起" : "展开全部"}
        </Btn>
      )}
      {p.status === "stale" && <Reason>配置已变更，请重新生成提议</Reason>}
      {decidable && (
        <div className="card-actions">
          <Btn variant="primary" disabled={busy !== null} onClick={confirm}>
            {busy === "confirm" ? "处理中…" : "确认"}
          </Btn>
          <Btn disabled={busy !== null} onClick={() => setEditing(true)}>
            修改后确认
          </Btn>
          <Btn variant="text" disabled={busy !== null} onClick={discard}>
            {busy === "discard" ? "处理中…" : "放弃"}
          </Btn>
        </div>
      )}
      {open && refusal && (
        <p className="field-msg" role="alert">
          {refusal}
        </p>
      )}
      {editing && decidable && <ProposalEditor proposal={p} busy={busy} onClose={() => setEditing(false)} onConfirm={confirmEdited} />}
    </div>
  );
}
