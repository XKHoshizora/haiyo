// The cards of Agent social that ask the owner something, in the owner's own conversation with their Agent. All of them are system
// UI text, in the third person: never the Agent's voice. Ring 1a: the `persona_fact` card (the persona aid, A8b); ring 1b's A12c adds
// the `note_withheld` card here. Following MemoryNotice (MemoryChip.jsx): one decision at a time, a refusal said on the card.
import React, { useState } from "react";
import { useStore } from "../data/store.jsx";
import { socialErrorText } from "../data/errorTexts.js";
import { publishBlock } from "../state/selectors.js";
import { Btn } from "../ui/primitives.jsx";
import { useDecision } from "./AgentChatBits.jsx";

/** What the owner is asked, word for word (plan "Exact copy"). */
export const personaFactQuestion = (sentence) => `人格里这句话像是关于你或别人的事实：〈${sentence}〉。别人问起时可能被说出来。要移到“关于我”吗？`;

/** The card's end: answered (what the answer did), or over. */
const MOVED = "已移到“关于我”。";
const KEPT = "已保留在人格里。";
const OVER = "这张卡片已经过期了。";

/** Refusals of this card that the screen can say better than the shared sentences. */
const refusalText = (err) => (err?.code === "room_full" ? "“关于我”装不下了，先删掉或合并几条再试。" : socialErrorText(err));

/**
 * The `persona_fact` card at `msg` (its wire `system.card` is `{answer, expired, sentence}`, sent to the Agent's owner only): the
 * question with 「移到“关于我”」 and 「不用」; once answered or over it shows the answer and offers no button. A refusal (answered
 * elsewhere, expired meanwhile) is said on the card and ends it; a room that is full or a failed request leaves the buttons for another try.
 */
export function PersonaFactCard({ msg, conv }) {
  const { state, actions } = useStore();
  // (Only its `mounted`: an answer here is a thin action that throws, so the card says its own refusals.)
  const { mounted } = useDecision();
  const card = msg.system.card;
  const [busy, setBusy] = useState(null);
  const [refusal, setRefusal] = useState(null);
  /** What this screen did: `moved` / `kept`, or `over` once the service said the card was answered or had run out. */
  const [done, setDone] = useState(null);
  const decidable = !publishBlock(state, conv);

  const answer = async (move) => {
    setBusy(move ? "move" : "keep");
    setRefusal(null);
    try {
      const res = await actions.answerPersonaFact(conv.agentId, msg.seq, move);
      if (mounted.current) setDone(res?.moved ? "moved" : "kept");
    } catch (err) {
      if (!mounted.current) return;
      setRefusal(refusalText(err));
      if (err?.code === "answered" || err?.code === "expired") setDone("over");
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const ended = card.answer ?? done;
  const note = ended === "moved" ? MOVED : ended === "kept" ? KEPT : ended === "over" || card.expired ? OVER : null;
  return (
    <li className="msg-memory" data-msg={msg.id}>
      <div className="card memory-card">
        <div className="card-head">
          <strong>{personaFactQuestion(card.sentence)}</strong>
        </div>
        {note === null ? (
          <div className="card-actions">
            <Btn variant="primary" disabled={!decidable || busy !== null} onClick={() => answer(true)}>
              {busy === "move" ? "处理中…" : "移到“关于我”"}
            </Btn>
            <Btn variant="text" disabled={!decidable || busy !== null} onClick={() => answer(false)}>
              {busy === "keep" ? "处理中…" : "不用"}
            </Btn>
          </div>
        ) : (
          <p className="muted">{note}</p>
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
