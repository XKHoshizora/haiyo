// What the owner is told when their Agent remembered something (the `memory_changed` notice, only ever in their own
// conversation with that Agent): a small closed chip (one sentence with the Agent's name, `memorySentence`) that opens to the lines of the change with 撤销; and the
// two confirmation cards (记住 / 不用 for new notes, 取出 / 不用 for a note to take out of the vault). Following
// TopicDivider (a notice) and ProposalCard (decisions, one at a time, a refusal said on the card).
import React, { useState } from "react";
import { useStore } from "../data/store.jsx";
import { ChevronDown, Lock } from "../icons.js";
import { isMergedSource, memorySentence } from "../data/memoryPhrases.js";
import { entity, publishBlock } from "../state/selectors.js";
import { Btn, Tag } from "../ui/primitives.jsx";
import { useDecision } from "./AgentChatBits.jsx";

/**
 * The lines of a change, each with the vault tag when it went into (or came out of) the vault. Under a merge's line (`合并了 n 条：…`)
 * the notes it joined (`原来：…`, marked so by the notice), set in under it: what a merge kept is there to see, and what its 撤销 brings back.
 */
function MemoryLines({ system }) {
  return (
    <ul className="memory-lines">
      {system.lines.map((line, i) => (
        <li key={i} className={isMergedSource(system, i) ? "memory-merged" : undefined}>
          {line}
          {system.vaultLines[i] && <Tag tone="muted">保险箱</Tag>}
        </li>
      ))}
    </ul>
  );
}

// A pending change's lines are in the future tense (the service writes them so): `要记住：…`, `要改成：…`, `要忘掉：…`, `要锁进保险箱：…`,
// a dream's `要合并成：…`, `要拆成：…`. A card whose lines all say `要记住：` asks 要记住这些吗？; any other asks 要这样整理记忆吗？.
const FUTURE = /^要(?:记住|改成|忘掉|锁进保险箱|合并成|拆成)：/;
const asksToRemember = (lines) => lines.length > 0 && lines.every((l) => l.startsWith("要记住："));

/**
 * One notice of a change to my Agent's memory, by its state: applied → the chip (closed; opened: the lines, 撤销 or 已撤销,
 * and — when the room is nearly full — a link to the palace's settings); pending → the card asking first; discarded → nothing;
 * expired (the record of the change is gone, 30 days after it was over) → the chip and its lines with nothing to decide, and for a card that
 * asked first, only 已过期.
 * A refusal (the change went stale meanwhile) stays on it as a sentence.
 */
export function MemoryNotice({ msg, conv }) {
  const { state, actions, dispatch } = useStore();
  const { mounted, busy, refusal, decide } = useDecision();
  const system = msg.system;
  const [open, setOpen] = useState(false);
  // Refused as stale (the memory changed since): the notice keeps its lines and offers nothing more.
  const [stale, setStale] = useState(false);
  // A deleted Agent's changes can no longer be decided, as its proposals cannot.
  const decidable = !stale && !publishBlock(state, conv);

  const run = async (key, request) => {
    const res = await decide(key, request);
    if (mounted.current && !res.ok && res.error?.code === "stale_change") setStale(true);
    return res;
  };
  const undo = () => run("undo", actions.undoMemoryChange(conv.agentId, system.changeId));
  // A confirmation may apply the adds and leave out the in-place ops whose note changed since: it says how many.
  const confirm = async () => {
    const res = await run("confirm", actions.confirmMemoryChange(conv.agentId, system.changeId));
    if (res.ok && res.value?.dropped > 0) dispatch({ type: "toast", text: `有 ${res.value.dropped} 处没有改：那条记忆后来又变过。` });
  };
  const discard = () => run("discard", actions.discardMemoryChange(conv.agentId, system.changeId));
  const openPalace = () => dispatch({ type: "nav", patch: { pane: "main", section: "settings", settingsPage: "memory" } });

  const alert = refusal && (
    <p className="field-msg" role="alert">
      {refusal}
    </p>
  );

  if (system.status === "discarded") return <li className="msg-memory" data-msg={msg.id} hidden />;

  if (system.status === "expired" && (system.unlock || system.lines.some((l) => FUTURE.test(l)))) {
    return (
      <li className="msg-memory" data-msg={msg.id}>
        <span className="muted">已过期</span>
      </li>
    );
  }

  if (system.status === "pending") {
    const remember = asksToRemember(system.lines);
    const title = system.unlock ? "要把这条从保险箱取出来吗？" : remember ? "要记住这些吗？" : "要这样整理记忆吗？";
    const yes = system.unlock ? "取出" : remember ? "记住" : "确认";
    return (
      <li className="msg-memory" data-msg={msg.id}>
        <div className="card memory-card">
          <div className="card-head">
            {system.unlock && <Lock size={16} aria-hidden="true" />}
            <strong>{title}</strong>
          </div>
          <MemoryLines system={system} />
          {!stale && (
            <div className="card-actions">
              <Btn variant="primary" disabled={!decidable || busy !== null} onClick={confirm}>
                {busy === "confirm" ? "处理中…" : yes}
              </Btn>
              <Btn variant="text" disabled={!decidable || busy !== null} onClick={discard}>
                {busy === "discard" ? "处理中…" : "不用"}
              </Btn>
            </div>
          )}
          {alert}
        </div>
      </li>
    );
  }

  // The Agent's name as the conversation shows it; one that cannot be named is 「Agent」 (never 「它」: design §8).
  const sentence = memorySentence({ ...system, name: entity(state, system.actorId)?.name || "Agent" });
  return (
    <li className="msg-memory" data-msg={msg.id}>
      <button type="button" className="memory-chip" aria-expanded={open} onClick={() => setOpen(!open)}>
        {sentence}
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open && (
        <div className="memory-detail">
          <MemoryLines system={system} />
          <div className="memory-foot">
            {system.status === "undone" ? (
              <span className="muted">已撤销</span>
            ) : (
              !stale &&
              system.status !== "expired" && (
                <Btn small variant="text" disabled={!decidable || busy !== null} onClick={undo}>
                  {busy === "undo" ? "处理中…" : "撤销"}
                </Btn>
              )
            )}
          </div>
          {system.full && (
            <p className="memory-hint">
              <Btn small variant="text" onClick={openPalace}>
                记忆宫殿快满了，去整理一下。
              </Btn>
            </p>
          )}
          {alert}
        </div>
      )}
    </li>
  );
}
