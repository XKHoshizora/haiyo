// What an Agent's reply looked up with its tools, under the reply (design rule 15): one quiet line — 查了 n 次聊天记录,
// 看了 n 个文件, 查了 n 次网页, joined with ，; time lookups never in it — that opens, when there is something to open, the
// words its searches were for (in my Agent's own conversation only) and the messages it found that I can see (the service
// sends no more), each loaded as any one message is (`actions.foundMessage`, GET …/messages/:seq) and each jumping to its
// place (`onJump`: the chat's own useJumpTo, which outlives this list when the jump opens another conversation — the
// chat scrolls to the message and it flashes). A row loaded (or found gone) is kept while the reply is shown, so opening
// the line again loads nothing again; a row that failed for any other reason says so and is tried again next time. A
// reply that looked nothing up, or only at the time, shows nothing here.
//
// The web pages a reply was handed (`msg.webSources`, WebSources.jsx) are folded: the web part of the line is then a
// button of its own, at the line's end — 查了 2 次网页 · 12 个来源 and a chevron — that opens their list in place, right
// under the line, and folds it again. For whoever reads the reply, as the list always was. It is as the reader left it
// while the reply is shown (this component's state: ChatView keeps a message's item while its conversation is open), and
// folded when the conversation is opened again. A reply being written has no pages yet (they come with the stored reply).
import React, { useEffect, useId, useRef, useState } from "react";
import { useStore } from "../data/store.jsx";
import { lookupLine, searchHitView, sourcesLine } from "../data/viewmodel.js";
import { ChatHitRow } from "./SearchHits.jsx";
import { WebSources } from "./WebSources.jsx";
import { ChevronDown } from "../icons.js";

/** The line under `msg` (a view message) in `conv`, or nothing; `onJump(conversationId, seq)` opens a message found. */
export function ReplyLookups({ msg, conv, onJump }) {
  const [open, setOpen] = useState(false);
  const [pagesOpen, setPagesOpen] = useState(false);
  const pagesId = useId();
  /** What each row found loaded as, by `conversationId:seq`: kept across closing and opening the line. */
  const loaded = useRef(new Map());
  const pages = Array.isArray(msg.webSources) ? msg.webSources : [];
  const listed = pages.length > 0;
  // With pages to list, the web part of the line is their button; the rest of the line is as ever.
  const line = lookupLine(listed ? { ...msg.lookups, web: 0 } : msg.lookups);
  if (!line && !listed) return null;
  // The words are its owner's, in its own conversation: never shown in a group, whatever the message carries.
  const words = conv.type === "agent" ? msg.queries ?? [] : [];
  const found = msg.found ?? [];
  const opens = line !== null && (found.length > 0 || words.length > 0);
  if (!opens && !listed) return <p className="msg-lookups">{line}</p>;
  return (
    <>
      <div className="msg-lookups">
        {opens ? (
          <button type="button" aria-expanded={open} onClick={() => setOpen((was) => !was)}>
            {line}
          </button>
        ) : (
          line
        )}
        {line && listed && "，"}
        {listed && (
          <button type="button" className="sources-toggle" aria-expanded={pagesOpen} aria-controls={pagesOpen ? pagesId : undefined} onClick={() => setPagesOpen((was) => !was)}>
            {sourcesLine(msg.lookups, pages.length)}
            <ChevronDown size={12} aria-hidden="true" />
          </button>
        )}
        {opens && open && (
          <>
            {words.length > 0 && <p className="lookup-words">搜索词：{words.join("、")}</p>}
            {found.length > 0 && (
              <ul className="lookup-rows">
                {found.map((ref) => (
                  <FoundRow key={`${ref.conversationId}:${ref.seq}`} found={ref} onJump={onJump} kept={loaded.current} />
                ))}
              </ul>
            )}
          </>
        )}
      </div>
      {pagesOpen && <WebSources id={pagesId} sources={pages} />}
    </>
  );
}

/**
 * One message the reply found: loading, then its sender, time and a line of it (a button that jumps to it); 看不到了 when
 * the service says it is not there for me (`not_found`), else that it could not be opened now. `kept`: the rows loaded
 * so far (a failure other than `not_found` is not kept: it is asked for again the next time the line opens).
 */
function FoundRow({ found, onJump, kept }) {
  const { state, actions } = useStore();
  const meId = state.account?.id ?? null;
  const key = `${found.conversationId}:${found.seq}`;
  const [loaded, setLoaded] = useState(() => kept.get(key) ?? null);
  useEffect(() => {
    if (kept.has(key)) return undefined;
    let live = true;
    actions.foundMessage(found.conversationId, found.seq).then((res) => {
      const now = res.ok ? { message: res.message } : res.error?.code === "not_found" ? { gone: true } : { failed: true };
      if (!now.failed) kept.set(key, now);
      if (live) setLoaded(now);
    });
    return () => {
      live = false;
    };
  }, [actions, kept, key, found.conversationId, found.seq]);
  if (loaded === null) return <li className="muted">正在加载…</li>;
  if (loaded.gone) return <li className="muted">这条消息已经看不到了</li>;
  if (loaded.failed) return <li className="muted">没能打开这条消息，请稍后再试</li>;
  const hit = searchHitView(loaded.message, { meId, now: Date.now() });
  return <ChatHitRow hit={hit} q="" onPick={() => onJump(found.conversationId, found.seq)} />;
}
