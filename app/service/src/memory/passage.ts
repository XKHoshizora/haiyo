import type { Config } from "../config.ts";
import type { Queryable, Tx } from "../db.ts";
import { NO_GROUP_TITLE, NO_NOTES, type PromptNote, type PromptNotes } from "../agents/runtime/prompt.ts";
import { notesFor, type NoteKind } from "./store.ts";
import { listRoomExact, type ExactNote } from "./write.ts";

/**
 * What a group the Agent's owner is no longer a member of is called in the passage: after leaving, the group's title is
 * not read again (renames after the owner left are not theirs to learn). Lines written while they were a member — a memory
 * notice's — keep the title they were written with (the controller's ruling, Task R fix round 1).
 */
export const LEFT_GROUP_TITLE = "一个已离开的群";

/**
 * Where a run's notes are read for: the owner's own conversation with the Agent, a group, or a social conversation with
 * `audienceId` (the person the reply speaks to; ring 1b decides what they may be shown of the owner's notes).
 */
export type NotesPlace = { place: "own" } | { place: "group"; conversationId: string } | { place: "social"; conversationId: string; audienceId: string };

/** A note a reply was shown: its kind, its id, and the version shown (the note's `updated_at` in `exactTs` form, memory/write.ts:30, compared in SQL only). */
export interface ShownNote {
  kind: NoteKind;
  id: string;
  version: string;
}

/** A note of a social reply's passage with the reference that records it as shown. */
export interface SocialNote extends PromptNote {
  ref: ShownNote;
}

/**
 * What `loadNotes` found: the notes for the passage, the notes a non-owner was shown (`shown`, for the post-time check) and the
 * ones that were left out because the audience may not be told them yet (`withheld`, for the withheld check). Both lists are
 * empty everywhere until ring 1b.
 */
export interface LoadedNotes {
  notes: PromptNotes;
  shown: readonly ShownNote[];
  withheld: readonly ShownNote[];
}

type NotesAgent = { id: string; ownerId: string; memory: boolean; sharedNotes: boolean };

/**
 * What a social reply is shown of its Agent's memory (ring 1b, option A: the vault, exactly as in a group): nothing when its memory
 * is off; the notes about its owner (when it uses the shared ones) and its own that are not in the vault — never a vault note, not
 * even one that began in this very conversation (a group's origin exception is not a social reply's), and never hearsay. Each note
 * carries its reference at the version read (`exactTs`, in the same read as its text), so that what `fitNotes` keeps can be recorded
 * on the run. Read once, at the run's start, as a group's are: no check after.
 */
async function socialNotes(q: Queryable, agent: NotesAgent): Promise<PromptNotes> {
  if (!agent.memory) return NO_NOTES;
  const shown = (entries: ExactNote[]): SocialNote[] =>
    entries.filter((e) => !e.note.vault).map((e) => ({ ...e.note, ref: { kind: e.note.kind, id: e.note.id, version: e.updatedAt } }));
  // In sequence: `q` is one transaction client, which runs one query at a time.
  const owner = agent.sharedNotes ? shown(await listRoomExact(q, { kind: "owner", ownerId: agent.ownerId })) : [];
  const self = shown(await listRoomExact(q, { kind: "self", agentId: agent.id }));
  return { owner, self, hearsay: [] };
}

/**
 * What a run is given of its Agent's memory (`notesFor`'s answer, rule for rule), with each piece of hearsay carrying
 * the title of the group it was said in — read here for just the conversations `notesFor` returned, and only while the
 * Agent's owner is a current member there (else `LEFT_GROUP_TITLE`); a group that has no title is
 * `某个群`. `notesPassage` (agents/runtime/prompt.ts) turns the result into text.
 *
 * Own and group only read, and take any `Queryable`, so memory/routes.ts's call on `db` stays as it is. A social conversation is
 * shown what `socialNotes` says, read in the run's own transaction.
 */
export async function loadNotes(q: Queryable, agent: NotesAgent, where: Extract<NotesPlace, { place: "own" | "group" }>, config: Pick<Config, "others">): Promise<LoadedNotes>;
export async function loadNotes(t: Tx, agent: NotesAgent, where: NotesPlace, config: Pick<Config, "others">): Promise<LoadedNotes>;
export async function loadNotes(q: Queryable, agent: NotesAgent, where: NotesPlace, _config: Pick<Config, "others">): Promise<LoadedNotes> {
  if (where.place === "social") {
    const notes = await socialNotes(q, agent);
    return { notes, shown: [...notes.owner, ...notes.self].map((n) => (n as SocialNote).ref), withheld: [] };
  }
  const found = await notesFor(q, agent, where.place === "group" ? { conversationId: where.conversationId, group: true } : { conversationId: "", group: false });
  const ids = [...new Set(found.hearsay.map((h) => h.conversationId))];
  const titles = new Map<string, string>();
  if (ids.length > 0) {
    const { rows } = await q.query<{ id: string; title: string | null; member: boolean }>(
      `select c.id, c.title, exists (select 1 from memberships m where m.conversation_id = c.id and m.principal_id = $2 and m.left_seq is null) as member
         from conversations c where c.id = any($1::uuid[])`,
      [ids, agent.ownerId],
    );
    for (const r of rows) {
      if (!r.member) titles.set(r.id, LEFT_GROUP_TITLE);
      else if (r.title !== null && r.title !== "") titles.set(r.id, r.title);
    }
  }
  const notes: PromptNotes = { ...found, hearsay: found.hearsay.map((h) => ({ ...h, group: titles.get(h.conversationId) ?? NO_GROUP_TITLE })) };
  return { notes, shown: [], withheld: [] };
}
