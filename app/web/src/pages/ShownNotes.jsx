// What my Agent could refer to of my notes when it answered someone one to one (ring 1b, option A; design §1, §7.2, §7.3, §7.8, §8),
// under each of its replies in a social conversation: a collapsed line 「<Agent>这次能参考 N 条记忆」 that opens the list — the honest
// scope once at its top, then each note: its text and 「以后别说」 while it is still exactly as that reply was shown it; a text-free
// 「这条记忆后来改过」 with no button once it was edited, merged, vaulted or deleted (the service sends no text then). 「以后别说」 puts
// that note into the vault, held to this reply (409 `note_changed`: changed since, the row turns into the marker); afterwards the row
// reads 「已放进保险箱 · 在记忆里查看」. No undo here: taking a note out of the vault is the memory page's own control. "Could refer to",
// never "used": nothing ties a sentence of the reply to a note. The service sends the list to the Agent's owner alone.
//
// The disclosure where I let people in (the approval of a request, the 「别人」 tab): one line with the Agent's name and a link to its
// memory page, for every account.
import React, { useId, useState } from "react";
import { useStore } from "../data/store.jsx";
import { nameOf } from "../state/selectors.js";
import { Btn, TextLink } from "../ui/primitives.jsx";
import { ChevronDown } from "../icons.js";

/** The collapsed line under a reply, word for word (design §8): the Agent's name, never 「它」. */
export const shownNotesLine = (name, count) => `${name}这次能参考 ${count} 条记忆`;
/** At the top of the opened list (design §7.2, in the Agent's name). */
export const shownNotesScope = (name) => `放进保险箱后，${name}和别人聊天时不再参考这条记忆。已经说过的话不会收回；这条记忆最初产生的那个群里仍会用到。`;
export const NEVER_AGAIN = "以后别说";
export const CHANGED_SINCE = "这条记忆后来改过";
export const VAULTED = "已放进保险箱";
export const SEE_IN_MEMORY = "在记忆里查看";
/** The disclosure line where I let people in (design §1, §8). */
export const memoryDisclosure = (name) => `${name}和别人聊天时，可能用到保险箱以外的记忆。`;
export const DISCLOSURE_LINK = "去记忆宫殿看看";

/** Where a note of `kind` is kept: 关于我 in the settings, or the Agent's own 记忆宫殿 tab. */
const memoryPageOf = (kind, agentId) =>
  kind === "owner"
    ? { href: "/settings/memory", patch: { section: "settings", settingsPage: "memory", pane: "main" } }
    : { href: `/agents/${agentId}`, patch: { section: "agents", agentId, agentView: "detail", agentTab: "memory", pane: "main" } };

function MemoryLink({ kind, agentId, children }) {
  const { dispatch } = useStore();
  const page = memoryPageOf(kind, agentId);
  const open = (event) => {
    event.preventDefault();
    dispatch({ type: "nav", patch: page.patch });
  };
  return (
    <TextLink href={page.href} onClick={open}>
      {children}
    </TextLink>
  );
}

/** One note of the list. `done`: what came of 以后别说 on it in this visit ("vaulted" or "changed"), else null. */
function ShownNoteRow({ note, done, busy, error, onVault, agentId }) {
  if (done === "vaulted") {
    return (
      <li className="shown-note">
        <span className="muted">
          {VAULTED} ·{" "}
          <MemoryLink kind={note.kind} agentId={agentId}>
            {SEE_IN_MEMORY}
          </MemoryLink>
        </span>
      </li>
    );
  }
  if (note.text === null || done === "changed") {
    return (
      <li className="shown-note">
        <span className="muted">{CHANGED_SINCE}</span>
      </li>
    );
  }
  return (
    <li className="shown-note">
      <span className="shown-note-text">{note.text}</span>
      <Btn small disabled={busy} onClick={onVault}>
        {busy ? "处理中…" : NEVER_AGAIN}
      </Btn>
      {error && (
        <span className="field-msg" role="alert">
          {error}
        </span>
      )}
    </li>
  );
}

/** Under `msg` (a reply of my own Agent in the social conversation `conv`): the line, and the list it opens. Nothing when it was shown no note. */
export function ShownNotes({ msg, conv }) {
  const { state, actions } = useStore();
  const [open, setOpen] = useState(false);
  /** note id → "vaulted" | "changed", for this visit of the reply. */
  const [done, setDone] = useState({});
  const [busy, setBusy] = useState(null);
  const [errors, setErrors] = useState({});
  const listId = useId();
  const notes = msg.shownNotes ?? [];
  if (notes.length === 0 || msg.seq === null) return null;
  const name = nameOf(state, msg.from) ?? "Agent";
  const vault = async (note) => {
    if (busy !== null) return;
    setBusy(note.id);
    setErrors((was) => ({ ...was, [note.id]: null }));
    const res = await actions.vaultFromReply(note.kind === "self" ? msg.from : null, note.id, { conversationId: conv.id, seq: msg.seq });
    setBusy(null);
    if (res.ok) setDone((was) => ({ ...was, [note.id]: "vaulted" }));
    else if (res.error?.code === "note_changed") setDone((was) => ({ ...was, [note.id]: "changed" }));
    else setErrors((was) => ({ ...was, [note.id]: res.text }));
  };
  return (
    <div className="shown-notes">
      <button type="button" className="shown-notes-toggle" aria-expanded={open} aria-controls={open ? listId : undefined} onClick={() => setOpen((was) => !was)}>
        {shownNotesLine(name, notes.length)}
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {open && (
        <div className="shown-notes-block" id={listId}>
          <p className="muted">{shownNotesScope(name)}</p>
          <ul className="shown-note-rows" aria-label={shownNotesLine(name, notes.length)}>
            {notes.map((note) => (
              <ShownNoteRow
                key={`${note.kind}:${note.id}`}
                note={note}
                done={done[note.id] ?? null}
                busy={busy === note.id}
                error={errors[note.id] ?? null}
                onVault={() => vault(note)}
                agentId={msg.from}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** The one line where I let people in to `agentId` (named `name`): what it may use when it talks with them, and where to look. */
export function MemoryDisclosure({ agentId, name }) {
  return (
    <p className="muted memory-disclosure">
      {memoryDisclosure(name)}
      <MemoryLink kind="self" agentId={agentId}>
        {DISCLOSURE_LINK}
      </MemoryLink>
    </p>
  );
}
