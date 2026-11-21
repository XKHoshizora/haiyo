import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "../data/store.jsx";
import { ME } from "../data/identities.js";
import { entity, isAgent, nameOf, ownerOf, senderName } from "../state/selectors.js";
import { Avatar, Btn, IconBtn, composing } from "../ui/primitives.jsx";
import { useSendFiles } from "./useSendFiles.js";
import { hasVisibleText, messageText } from "../auth/validation.js";
import { MENTION_LIMIT, afterEdit, capped, caretOutside, mentionName, mentionSegments, mentionsIn, settleEdits, tagEndingAt, tagStartingAt, withoutAddressed, withoutStale } from "../data/mentions.js";
import { Smile, Image, Paperclip, AtSign, X } from "../icons.js";

const EMOJI = {
  "表情": ["😀","😄","😁","😊","🥰","😍","🤩","😎","🤔","🤗","😂","🤣","🥹","😅","😉","😋","😴","😭","😮","😱","😤","🥳","🫡","🤖"],
  "手势与心情": ["👍","👎","👏","🙌","🤝","🙏","👌","✌️","👋","💪","❤️","🧡","💛","💚","💙","💜","🩷","💕","💯","✨","🎉","🎊","💡","✅"],
  "生活与出行": ["☀️","🌈","🌸","🌊","🌿","🍀","🐱","🐶","☕","🍵","🍰","🍜","🍱","🍕","🎂","🎁","📷","🎵","📚","💻","🚆","✈️","🏖️","🗺️"],
};

/** The service's limit for a message's text, in characters (code points) after trimming. */
export const TEXT_LIMIT = 8000;
/** Typing pauses this long before the draft is written to the data layer (and at once on leaving the chat). */
const DRAFT_SAVE_MS = 300;
/** What the @ list says once a message holds as many mentions as one may (it then inserts nothing). */
export const MENTIONS_FULL_TEXT = `一条消息最多 @ ${MENTION_LIMIT} 个。`;
/** The line under the box when picked mentions went stale (`@X 已不在这个群，已改成普通文字。`). */
const staleText = (texts) => `${texts.join("、")} 已不在这个群，已改成普通文字。`;
/** …when a tag came to sit in an address (fix round 2, M-1). */
const addressedText = (texts) => `${texts.join("、")} 在网址里，已改成普通文字。`;
/** …when more tags than a message may hold came back (改一下, an undo; fix round 2, M-7). */
const OVER_TEXT = `一条消息最多 @ ${MENTION_LIMIT} 个，多出的已改成普通文字。`;

/**
 * A draft as the data layer keeps it (a text, or `{text, mentions}` while it holds tags: model.js `setDraft`), as the
 * composer holds it: `{text, tags, removals}`, the tags (`{id, start, length}`) those that still fit the text.
 */
const draftOf = (kept) => ({
  ...(typeof kept === "string" ? { text: kept, tags: [] } : kept && typeof kept.text === "string" ? { text: kept.text, tags: mentionsIn(kept.text, kept.mentions) } : { text: "", tags: [] }),
  removals: [],
});

/**
 * The composer: a textarea, and over its text a layer that draws each mention picked from the @ list as a tag (a
 * textarea cannot style a part of its text; the layer below it has the same text, transparent, with each tag's range
 * drawn as a tag behind it). Who a tag means is the id picked, kept with its range of the box's text (`{id, start,
 * length}`) and moved with every edit — typing, paste, cut, undo and redo, line breaks, IME composition — as each edit is
 * compared with the text before it (data/mentions.js `afterEdit`). **Tags are atomic** (fix round 1): the caret never
 * rests inside one (it goes to an edge, `caretOutside`); Backspace at its end or Delete at its start selects all of it
 * for the browser's own deletion (so undo brings it back), and any other edit that lands inside it takes all of it, so
 * no half of a tag is ever left as plain text to be read at send. A tag whose principal is no longer a member (they
 * left, it was taken out) turns into plain text without its `@`, and a line says so (`withoutStale`). A screen reader
 * is told the box's mentions (`提到 …`, the box's description) and each change of them. Picking from the list writes
 * `@` and the name the list shows — a person's name or an Agent's — at most MENTION_LIMIT of them; what is sent with the
 * text is the tags (`mentions`); an `@` typed and not picked is plain text, which the service reads once. A message the
 * service refused for a stale mention can be put back here, text and tags (`state.refills`, Messages.jsx 改一下).
 *
 * `sendFiles(files)` sends what is picked or pasted (the chat's, which also hears it; else the composer's own);
 * `note` is a line under the composer (the image hint of an Agent conversation).
 */
export function Composer({ conv, block, replyTo, setReplyTo, sendFiles: sendThrough = null, note = null }) {
  const { state, actions } = useStore();
  const [draft, setDraftState] = useState(() => draftOf(state.drafts?.[conv.id]));
  const { text } = draft;
  /** The tags that are mentions (not what is left of one an IME composition cut into, `broken`). */
  const tags = draft.tags.filter(t => !t.broken);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [category, setCategory] = useState("表情");
  const [mention, setMention] = useState(null);
  const [active, setActive] = useState(0);
  const [height, setHeight] = useState(64);
  const [told, setTold] = useState("");
  const [staleNote, setStaleNote] = useState("");
  const inputRef = useRef(null);
  const mirrorRef = useRef(null);
  const imagePicker = useRef(null);
  const filePicker = useRef(null);
  const rootRef = useRef(null);
  /** The caret or selection before the next edit: where an ambiguous edit is taken to be (`editOf`). */
  const selection = useRef({ start: 0, end: 0 });
  /** The draft as last set (the next edit is compared with it, whatever React has rendered yet). */
  const current = useRef(draft);
  /** A tag being inserted by a pick: added once the text holds it. */
  const picking = useRef(null);
  /** Whether an IME composition is under way (nothing is rewritten meanwhile). */
  const composition = useRef(false);
  /** Where the caret goes once the text set by the composer itself is shown. */
  const caretAfter = useRef(null);
  const drag = useRef(null);
  const unsaved = useRef(null);
  const disabled = Boolean(block);
  // What the service would store, and whether it would take it: something visible, at most TEXT_LIMIT characters.
  const body = messageText(text);
  const length = [...body].length;
  const tooLong = length > TEXT_LIMIT;
  const invisible = text.trim() !== "" && !hasVisibleText(body);
  // @ suggestions: the conversation's current members, nobody else — none once the message holds as many as it may.
  const people = conv.members.filter(id => id !== ME);
  const full = tags.length >= MENTION_LIMIT;
  const matches = mention && !full ? people.filter(id => `${nameOf(state,id)} ${entity(state,id)?.handle || ""}`.toLowerCase().includes(mention.query.toLowerCase())) : [];
  const selected = Math.min(active, Math.max(0, matches.length - 1));
  const maxHeight = () => Math.max(64, Math.min(360, Math.floor(window.innerHeight * 0.42)));
  const clampHeight = value => Math.max(56, Math.min(maxHeight(), value));
  const tagsId = `composer-mentions-${conv.id}`;
  const memberKey = conv.members.join(",");
  const refill = state.refills?.[conv.id] ?? null;

  // Drafts live in the data layer per conversation: written after a pause, and at once when the chat changes or closes.
  const saveDraft = useCallback(() => {
    const kept = unsaved.current;
    if (!kept) return;
    clearTimeout(kept.timer);
    unsaved.current = null;
    actions.setDraft(kept.convId, kept.text, kept.tags);
  }, [actions]);
  const setDraft = next => {
    const held = { text: next.text, tags: next.tags, removals: next.removals ?? [] };
    current.current = held;
    setDraftState(held);
    if (unsaved.current) clearTimeout(unsaved.current.timer);
    unsaved.current = { convId: conv.id, text: held.text, tags: held.tags.filter(t => !t.broken), timer: setTimeout(saveDraft, DRAFT_SAVE_MS) };
  };
  useEffect(() => saveDraft, [conv.id, saveDraft]);

  useEffect(() => {
    const next = draftOf(state.drafts?.[conv.id]);
    current.current = next;
    setDraftState(next);
    picking.current = null;
    setTold("");
    setStaleNote("");
    setMention(null); setEmojiOpen(false); selection.current={start:0,end:0}; setReplyTo(null);
    // (A composition the browser never ended does not carry over to another chat: tidy round, m-9.)
    composition.current = false;
  }, [conv.id]);
  // The box's tags kept to what can be sent: one whose principal is no longer a member here turns into plain text without
  // its @ (so nothing reads it at send); one that came to sit in an address stays as that text, no tag (the service
  // would refuse it; it reads that text as the address); those over MENTION_LIMIT lose their @. Each says so below the box.
  useEffect(() => {
    const members = new Set(conv.members);
    const stale = withoutStale(current.current, id => members.has(id));
    const addressed = withoutAddressed(stale);
    const after = capped(addressed);
    if (after === current.current) return;
    const lines = [
      ...(stale !== current.current ? [staleText(stale.stale)] : []),
      ...(addressed !== stale ? [addressedText(addressed.addressed)] : []),
      ...(after !== addressed ? [OVER_TEXT] : []),
    ];
    setDraft(after);
    setStaleNote(lines.join(" "));
    setTold(lines.join(" "));
  }, [memberKey, text]);
  // A message the service refused for a stale mention, put back here (Messages.jsx 改一下): after what the box holds.
  useEffect(() => {
    if (!refill) return;
    actions.takeRefill(conv.id);
    const held = current.current;
    const gap = held.text === "" ? "" : "\n";
    const shift = held.text.length + gap.length;
    setDraft({
      text: held.text + gap + refill.text,
      tags: [...held.tags, ...mentionsIn(refill.text, refill.mentions).map(t => ({ ...t, start: t.start + shift }))],
      removals: [],
    });
    caretAfter.current = shift + refill.text.length;
    inputRef.current?.focus();
  }, [refill?.n]);
  useEffect(() => { if (replyTo) inputRef.current?.focus(); }, [replyTo]);
  useEffect(() => { if(disabled) { setEmojiOpen(false); setMention(null); } }, [disabled]);
  useEffect(() => {
    const close = e => { if (!rootRef.current?.contains(e.target)) { setEmojiOpen(false); setMention(null); } };
    document.addEventListener("pointerdown",close);
    return () => document.removeEventListener("pointerdown",close);
  },[]);
  useEffect(() => { rootRef.current?.querySelector('[role="option"][aria-selected="true"]')?.scrollIntoView({block:"nearest"}); },[selected, mention?.query]);
  // The layer of tags scrolls with the box; the caret goes where the composer's own change of the text left it.
  useLayoutEffect(() => {
    if (mirrorRef.current && inputRef.current) mirrorRef.current.scrollTop = inputRef.current.scrollTop;
    const caret = caretAfter.current;
    if (caret !== null && inputRef.current) {
      caretAfter.current = null;
      inputRef.current.setSelectionRange(caret, caret);
      selection.current = { start: caret, end: caret };
    }
  }, [text]);

  const detect = (value, start, end = start, held = current.current.tags) => {
    selection.current = {start,end};
    const found = start === end && value.slice(0,start).match(/(?:^|\s)@([^\s@]*)$/u);
    const at = found ? start - found[1].length - 1 : -1;
    // (A tag's own @ opens nothing: the caret is only at the end of a tag.)
    if (found && !held.some(t => t.start === at)) { setMention({start:at,end:start,query:found[1]}); setActive(0); setEmojiOpen(false); }
    else setMention(null);
  };

  /**
   * The caret never rests inside a tag (`caretOutside`): moved by the keys from one side, it goes to the other edge; put
   * there by a click, to the nearer one. Then the @ list is looked for as before.
   */
  const settleCaret = (el, from = null) => {
    if (el.selectionStart === el.selectionEnd) {
      const to = caretOutside(current.current.tags, el.selectionStart, from);
      if (to !== null) el.setSelectionRange(to, to);
    }
    detect(el.value, el.selectionStart, el.selectionEnd);
  };

  /**
   * The box's text became `value` (by the browser, or by the composer itself): `afterEdit`; `inputType` the browser's
   * (its own undo and redo are never rewritten). Returns the text kept.
   */
  const changed = (value, inputType = "") => {
    const before = current.current;
    const history = inputType === "historyUndo" || inputType === "historyRedo";
    const after = afterEdit(before, value, { hint: selection.current, composing: composition.current, history, picking: picking.current });
    if (after.picked) picking.current = null;
    if (after.caret !== null) caretAfter.current = after.caret;
    setDraft(after);
    if (after.added.length > 0) setTold(`已提到 ${after.added.join("、")}`);
    else if (after.removed.length > 0) setTold(`已去掉提到 ${after.removed.join("、")}`);
    return after.text;
  };
  /** An IME composition ended: what is left of a tag it cut into goes (`settleEdits`), the caret kept where it was. */
  const compositionEnded = () => {
    composition.current = false;
    const after = settleEdits(current.current, inputRef.current?.selectionStart ?? null);
    if (after.caret === null) return;
    caretAfter.current = after.caret;
    setDraft(after);
  };

  /** Puts `snippet` in place of `range` of the box: as the browser's own edit when it can (undo knows it), else as the composer's. */
  const insert = (snippet, range) => {
    const el = inputRef.current;
    selection.current = { start: range.start, end: range.end };
    if (el && typeof document.execCommand === "function") {
      el.focus();
      el.setSelectionRange(range.start, range.end);
      let done = false;
      try {
        done = document.execCommand("insertText", false, snippet);
      } catch {
        done = false;
      }
      if (done) return;
    }
    const value = current.current.text.slice(0, range.start) + snippet + current.current.text.slice(range.end);
    changed(value);
    caretAfter.current = range.start + snippet.length;
    requestAnimationFrame(() => inputRef.current?.focus());
  };
  const replace = (snippet, range=selection.current) => {
    if(disabled) return;
    insert(snippet, range);
    setMention(null); setEmojiOpen(false);
  };
  const chooseMention = id => {
    if (disabled || !mention || full) return;
    const name = nameOf(state, id);
    picking.current = { id, start: mention.start, length: name.length + 1, text: `@${name}` };
    replace(`@${name} `, mention);
  };
  const openMentions = () => {
    if (mention) { setMention(null); return; }
    const range=selection.current;
    const prefix = range.start > 0 && !/\s/.test(text[range.start-1]) ? " @" : "@";
    insert(prefix, range);
    const cursor=range.start+prefix.length;
    detect(current.current.text,cursor); setEmojiOpen(false);
    requestAnimationFrame(()=>{inputRef.current?.focus();inputRef.current?.setSelectionRange(cursor,cursor);});
  };
  const send = () => {
    if(!body || invisible || disabled || tooLong) return;
    // With an IME composition still open (a tap on 发送): what is left of a tag it cut into goes first (fix round 2, M-3).
    const ready = settleEdits(current.current);
    actions.sendText(conv.id, ready.text, { replyToSeq: replyTo?.seq ?? null, mentions: ready.tags.filter(t => !t.broken) });
    picking.current = null;
    // (The box is empty now: whatever composition was open is over, whether or not the browser says so. m-9.)
    composition.current = false;
    setDraft({ text: "", tags: [], removals: [] }); saveDraft();
    setStaleNote("");
    selection.current={start:0,end:0};
    setReplyTo(null);setMention(null);setEmojiOpen(false);
  };
  /** Where the caret was when a key that moves it went down (`settleCaret` takes it to the far edge of a tag it entered). */
  const keyFrom = useRef(null);
  const keyDown = e => {
    if(composing(e)) return;
    if(["ArrowLeft","ArrowRight","ArrowUp","ArrowDown","Home","End","PageUp","PageDown"].includes(e.key)) keyFrom.current = e.currentTarget.selectionStart;
    if(e.key==="Escape") {setMention(null);setEmojiOpen(false);return;}
    if(mention && !e.shiftKey && ["ArrowDown","ArrowUp","Enter","Tab"].includes(e.key)) {
      if(e.key==="Tab" && !matches.length) {setMention(null);return;}
      e.preventDefault();
      if(e.key==="ArrowDown") setActive((selected+1)%Math.max(1,matches.length));
      else if(e.key==="ArrowUp") setActive((selected-1+matches.length)%Math.max(1,matches.length));
      else if(matches[selected]) chooseMention(matches[selected]);
      return;
    }
    if(e.key==="Enter" && !e.shiftKey) {e.preventDefault();send();return;}
    // A tag deletes as a unit: the browser's own Backspace (Delete) takes the selection, so all of the tag is selected first.
    if((e.key==="Backspace" || e.key==="Delete") && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const el = e.currentTarget;
      if (el.selectionStart !== el.selectionEnd) return;
      const tag = e.key==="Backspace" ? tagEndingAt(tags, el.selectionStart) : tagStartingAt(tags, el.selectionStart);
      if (!tag) return;
      el.setSelectionRange(tag.start, tag.start + tag.length);
      selection.current = { start: tag.start, end: tag.start + tag.length };
    }
  };
  const ownSend = useSendFiles(conv, block);
  const sendFiles = sendThrough ?? ownSend;
  // The same file input can pick the same file again; the pick is handed over and forgotten.
  const picked = e => { const list = [...e.target.files]; e.target.value = ""; sendFiles(list); };
  const paste = e => {
    const images = [...(e.clipboardData?.files ?? [])].filter(f => f.type.startsWith("image/"));
    if (images.length === 0) return;
    // Text on the clipboard as well (copied from a page or a document): it still pastes into the box.
    if (!e.clipboardData.getData?.("text/plain")) e.preventDefault();
    sendFiles(images);
  };
  const sendNote = tooLong ? `消息最多 ${TEXT_LIMIT} 字，当前 ${length} 字，请删减后再发送` : invisible ? "消息里没有看得见的文字，无法发送" : null;
  return <footer className="composer" ref={rootRef} onKeyDown={e=>{if(e.key==="Escape"){setEmojiOpen(false);setMention(null);}}}>
    {replyTo && <div className="reply-chip"><span>回复 {senderName(state,replyTo.from)}：{replyTo.kind==="image"?"[图片]":replyTo.text}</span><IconBtn label="取消回复" onClick={()=>setReplyTo(null)}><X size={14}/></IconBtn></div>}
    <div className="composer-tools">
      <div className="menu-anchor">
        <IconBtn label="表情" disabled={disabled} aria-expanded={emojiOpen} aria-controls="emoji-picker" onClick={()=>{setEmojiOpen(!emojiOpen);setMention(null);}}><Smile size={22}/></IconBtn>
        {emojiOpen && <div className="emoji-picker" id="emoji-picker" role="dialog" aria-label="选择表情">
          <div className="emoji-heading"><strong>表情</strong><IconBtn label="关闭表情" onClick={()=>setEmojiOpen(false)}><X size={16}/></IconBtn></div>
          <div className="emoji-tabs" role="tablist" aria-label="表情分类">{Object.keys(EMOJI).map(c=><button key={c} type="button" role="tab" aria-selected={category===c} onClick={()=>setCategory(c)}>{c}</button>)}</div>
          <div className="emoji-grid">{EMOJI[category].map(emoji=><button key={emoji} type="button" aria-label={`插入表情 ${emoji}`} onClick={()=>replace(emoji)}>{emoji}</button>)}</div>
        </div>}
      </div>
      <IconBtn label="发送图片" disabled={disabled} onClick={()=>imagePicker.current?.click()}><Image size={22}/></IconBtn>
      <IconBtn label="发送文件" disabled={disabled} onClick={()=>filePicker.current?.click()}><Paperclip size={22}/></IconBtn>
      <input ref={imagePicker} type="file" accept="image/*" multiple hidden tabIndex={-1} aria-label="选择图片" onChange={picked}/>
      <input ref={filePicker} type="file" multiple hidden tabIndex={-1} aria-label="选择文件" onChange={picked}/>
      {people.length>0 && <IconBtn label="@ 会话成员" disabled={disabled} aria-expanded={Boolean(mention)} onClick={openMentions}><AtSign size={22}/></IconBtn>}
    </div>
    <div className="composer-row">
      <div className="composer-input">
        <div className="composer-resize" role="separator" aria-label="拖拽输入框上边框调整高度" aria-orientation="horizontal" aria-valuemin={56} aria-valuemax={maxHeight()} aria-valuenow={height} tabIndex={0} title="拖拽输入框上边框调整高度；双击恢复"
          onPointerDown={e=>{if(e.button!==0)return;e.preventDefault();setMention(null);setEmojiOpen(false);e.currentTarget.setPointerCapture(e.pointerId);drag.current={y:e.clientY,height:inputRef.current?.getBoundingClientRect().height || height};}}
          onPointerMove={e=>{if(drag.current)setHeight(clampHeight(drag.current.height+drag.current.y-e.clientY));}}
          onPointerUp={e=>{drag.current=null;if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);}}
          onPointerCancel={()=>{drag.current=null;}}
          onDoubleClick={()=>setHeight(64)}
          onKeyDown={e=>{if(["ArrowUp","ArrowDown","Home","End"].includes(e.key)){e.preventDefault();setHeight(e.key==="Home"?56:e.key==="End"?maxHeight():clampHeight(height+(e.key==="ArrowUp"?20:-20)));}}} />
        {mention && !disabled && <div className="mention-picker" id="mention-picker" role="listbox" aria-label="选择要提及的成员">
          <div className="mention-heading">提及会话中的成员 <small>↑↓ 选择 · Enter 确认</small></div>
          {full ? <p className="mention-empty">{MENTIONS_FULL_TEXT}</p> : !matches.length && <p className="mention-empty">没有匹配的成员</p>}
          {matches.map((id,i)=><button key={id} id={`mention-${id}`} role="option" aria-selected={i===selected} type="button" onMouseDown={e=>e.preventDefault()} onClick={()=>chooseMention(id)}>
            <Avatar id={id} size={28}/><span><strong>{nameOf(state,id)}</strong><small>{isAgent(state,id)?`${entity(state,id).handle} · Agent · 主人：${nameOf(state,ownerOf(state,id))}${state.agents[id].paused?" · 已暂停":""}`:"真人 · 会话成员"}</small></span>
          </button>)}
        </div>}
        <div className={`composer-field${disabled ? " composer-field-off" : ""}`}>
          {/* The tags, drawn behind the box's own text: the same text, transparent, with each tag's range as a tag. */}
          <div className="composer-mirror" ref={mirrorRef} aria-hidden="true">
            {tags.length > 0 && mentionSegments(text, tags).map((part, i) => part.mention ? <span key={i} className="mention-chip">{part.text}</span> : <React.Fragment key={i}>{part.text}</React.Fragment>)}
            {"\u200b"}
          </div>
          <textarea ref={inputRef} rows={1} value={text} style={{height}} disabled={disabled} placeholder={disabled?"当前无法发送新消息":"发送消息，或 @ 会话成员"} aria-label="消息内容" aria-autocomplete="list" aria-controls={mention?"mention-picker":undefined} aria-expanded={Boolean(mention)} aria-activedescendant={mention&&matches[selected]?`mention-${matches[selected]}`:undefined} aria-describedby={tags.length>0?tagsId:undefined}
            onChange={e=>{const kept=changed(e.target.value,e.nativeEvent?.inputType);const caret=kept===e.target.value?e.target.selectionStart:caretAfter.current;const end=kept===e.target.value?e.target.selectionEnd:caret;detect(kept,caret,end,current.current.tags);}}
            onSelect={e=>{selection.current={start:e.target.selectionStart,end:e.target.selectionEnd};}}
            onMouseUp={e=>settleCaret(e.currentTarget)}
            onScroll={e=>{if(mirrorRef.current)mirrorRef.current.scrollTop=e.currentTarget.scrollTop;}}
            onCompositionStart={()=>{composition.current=true;}}
            onCompositionEnd={compositionEnded}
            onBlur={()=>{if(composition.current)compositionEnded();}}
            onClick={e=>settleCaret(e.currentTarget)} onKeyDown={keyDown} onPaste={paste}
            onKeyUp={e=>{const from=keyFrom.current;keyFrom.current=null;if(!e.nativeEvent.isComposing && ["ArrowLeft","ArrowRight","ArrowUp","ArrowDown","Home","End","PageUp","PageDown"].includes(e.key))settleCaret(e.currentTarget,from);}}/>
        </div>
        <ul className="sr-only" id={tagsId}>{tags.map(t=><li key={`${t.start}:${t.id}`}>{`提到 ${mentionName(text.slice(t.start,t.start+t.length))}`}</li>)}</ul>
        <p className="sr-only" aria-live="polite">{told}</p>
      </div>
      <Btn variant="primary" className="send" disabled={disabled||!body||invisible||tooLong} reason={block?.text ?? sendNote} onClick={()=>send()}>发送</Btn>
    </div>
    {staleNote && <p className="composer-hint">{staleNote}</p>}
    <p className="composer-hint">{disabled?block.text:sendNote?<span className="failed">{sendNote}</span>:"Enter 发送 · Shift+Enter 换行"}</p>
    {note && <p className="composer-hint" role="status">{note}</p>}
  </footer>;
}
