// A whisper (悄悄话): a small note in a conversation that only I see, about my Agent there (app/service/README.md
// "Whispers"). Not a message — no sender, no time, nothing to quote —, it sits after the message it follows (ChatView,
// `placeWhispers`). Open: a small bubble with a lock, 只有你能看到, its text and the buttons it offers (告诉他们, 不用), one
// decision at a time (`useDecision`), a refusal said on it. Answered or expired: a quiet line. One that offers no button
// (it only tells, such as a model turned to plain chat, `tools_off`) has nothing to answer: it stays that note, with its
// text, whatever its status. An open `found_elsewhere` one is folded to one line (在别处查到了 n 条，要告诉他们吗？) that opens
// it — what was found (`hits`: where · who · when, then the text, a long one folded with 展开), so that I see what I would
// tell, then its buttons — and folds it again; opened stays opened for this tab's session (`openedWhispers`). Its state is
// the service's: 正在告诉他们… while its told reply is under way, 已告诉他们 once that posted, open again — saying 刚才没发出去，
// 可以再试一次。 above its buttons — when it posted nothing. Only a stale answer (`stale_whisper`) takes the buttons away;
// a refusal of the reply 告诉他们 would start (it is replying, paused, has no model, too many replies a minute) says why and
// leaves them. Following MemoryNotice.
import React, { useState } from "react";
import { useStore } from "../data/store.jsx";
import { ChevronDown, Lock } from "../icons.js";
import { Btn } from "../ui/primitives.jsx";
import { useDecision } from "./AgentChatBits.jsx";

/** What an answered (or found_elsewhere: telling, told) whisper says. */
export const WHISPER_DONE = { accepted: "已告诉他们", told: "已告诉他们", telling: "正在告诉他们…", declined: "已忽略", expired: "已过期" };
/** The line every open whisper starts with. */
export const ONLY_YOU = "只有你能看到";
/** The one line an open found_elsewhere whisper is folded to. */
export const foldedLine = (n) => `在别处查到了 ${n} 条，要告诉他们吗？`;
/** Above its buttons, once its told reply posted nothing (`lastTellFailed`). */
export const TELL_FAILED = "刚才没发出去，可以再试一次。";
/** A hit's text longer than this many characters is folded to a few lines (styles.css `.folded`), with 展开 / 收起. */
export const HIT_FOLD_AT = 80;

// ───────── which found_elsewhere whispers I opened, for this tab's session (sessionStorage, so across reloads)

const OPENED_KEY = "agent-family.opened-whispers";
/** Ids remembered; the oldest is dropped first. */
const OPENED_KEPT = 200;
/** Ids remembered in this page when the tab's storage cannot be used (missing, full, refused). */
const inPage = new Set();

function storage() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
function storedOpened() {
  try {
    const parsed = JSON.parse(storage()?.getItem(OPENED_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}
/** Whether I opened whisper `id` in this tab (and did not fold it again). */
export function openedWhisper(id) {
  return inPage.has(id) || storedOpened().includes(id);
}
function rememberOpened(id, opened) {
  if (opened) inPage.add(id);
  else inPage.delete(id);
  const next = [...storedOpened().filter((x) => x !== id), ...(opened ? [id] : [])].slice(-OPENED_KEPT);
  try {
    storage()?.setItem(OPENED_KEY, JSON.stringify(next));
    // Kept by the tab: the page need not hold it too (a clear of the tab's storage then forgets it, as it should).
    if (storage()) inPage.delete(id);
  } catch {
    // Not remembered beyond this page: rendering never depends on it.
  }
}

/** One thing a `found_elsewhere` whisper found: where · who · when, then what was said (React text only). */
function Hit({ hit }) {
  const [open, setOpen] = useState(false);
  const long = [...hit.text].length > HIT_FOLD_AT;
  return (
    <li className="whisper-hit">
      <p className="whisper-hit-meta">{[hit.where, hit.who, hit.when].join(" · ")}</p>
      <p className={long && !open ? "whisper-hit-text folded" : "whisper-hit-text"}>{hit.text}</p>
      {long && (
        <button type="button" className="whisper-hit-more" onClick={() => setOpen((o) => !o)}>
          {open ? "收起" : "展开"}
        </button>
      )}
    </li>
  );
}

/** One whisper of mine (`whisper`: a view of `conv.whispers`) in the conversation `conv`. */
export function Whisper({ whisper, conv }) {
  const { actions } = useStore();
  const { mounted, busy, refusal, decide } = useDecision();
  // Refused as stale (answered or expired meanwhile): nothing more is offered until it is read again.
  const [stale, setStale] = useState(false);
  const hits = whisper.kind === "found_elsewhere" && Array.isArray(whisper.hits) ? whisper.hits : [];
  // A found_elsewhere one with what it found is folded until I open it (and stays as I left it, for this tab's session).
  const foldable = hits.length > 0;
  const [opened, setOpened] = useState(() => foldable && openedWhisper(whisper.id));

  // One that offers no button was never waiting for an answer: expired, it still says what it told.
  if (whisper.status !== "open" && whisper.actions.length > 0) {
    return (
      <li className="msg-whisper whisper-done" data-whisper={whisper.id}>
        <span className="muted">
          <Lock size={12} aria-hidden="true" />
          {WHISPER_DONE[whisper.status] ?? WHISPER_DONE.expired}
        </span>
      </li>
    );
  }

  const open = (to) => {
    rememberOpened(whisper.id, to);
    setOpened(to);
  };
  if (foldable && !opened) {
    return (
      <li className="msg-whisper" data-whisper={whisper.id}>
        <div className="whisper whisper-folded" role="note" aria-label={ONLY_YOU}>
          <button type="button" className="whisper-summary" aria-expanded="false" onClick={() => open(true)}>
            <Lock size={12} aria-hidden="true" />
            <span>{foldedLine(hits.length)}</span>
            <ChevronDown size={14} aria-hidden="true" />
          </button>
        </div>
      </li>
    );
  }

  const answer = async (key) => {
    const res = await decide(key, actions.answerWhisper(conv.id, whisper.id, key));
    if (mounted.current && !res.ok && res.error?.code === "stale_whisper") setStale(true);
  };
  const offers = (action) => !stale && whisper.actions.includes(action);
  return (
    <li className="msg-whisper" data-whisper={whisper.id}>
      <div className={foldable ? "whisper whisper-open" : "whisper"} role="note" aria-label={ONLY_YOU}>
        <div className="whisper-top">
          <p className="whisper-head">
            <Lock size={12} aria-hidden="true" />
            {ONLY_YOU}
          </p>
          {foldable && (
            <button type="button" className="whisper-fold" aria-expanded="true" onClick={() => open(false)}>
              收起
            </button>
          )}
        </div>
        <p className="whisper-text">{whisper.text}</p>
        {hits.length > 0 && (
          <ul className="whisper-hits">
            {hits.map((hit, i) => (
              <Hit key={i} hit={hit} />
            ))}
          </ul>
        )}
        {whisper.lastTellFailed === true && (offers("tell") || offers("dismiss")) && <p className="whisper-failed">{TELL_FAILED}</p>}
        {(offers("tell") || offers("dismiss")) && (
          <div className="whisper-actions">
            {offers("tell") && (
              <Btn small variant="primary" disabled={busy !== null} onClick={() => answer("accept")}>
                {busy === "accept" ? "处理中…" : "告诉他们"}
              </Btn>
            )}
            {offers("dismiss") && (
              <Btn small variant="text" disabled={busy !== null} onClick={() => answer("decline")}>
                {busy === "decline" ? "处理中…" : "不用"}
              </Btn>
            )}
          </div>
        )}
        {refusal && (
          <p className="field-msg" role="alert">
            {refusal}
          </p>
        )}
      </div>
    </li>
  );
}
