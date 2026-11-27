import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { fitNotes, passageBudget } from "../agents/runtime/prompt.ts";
import { readOwnedAgent, type AgentRow } from "../agents/store.ts";
import { lockConversationKeys, VISIBLE_JOIN } from "../conversations/store.ts";
import type { Queryable, Tx } from "../db.ts";
import { AppError, notFound, type ErrorDetails } from "../errors.ts";
import { perPrincipalLimit, type PrincipalLimit } from "../limits.ts";
import { postingRun } from "../messages/read.ts";
import { planRatio, ratioKey, readRatio } from "../metering/tokens.ts";
import { resolveModel } from "../models/resolve.ts";
import { uuidParam } from "../schemas.ts";
import { requirePrincipal } from "../session.ts";
import { groupPlaceSql } from "../social/place.ts";
import { confirmChange, discardChange, undoChange, type FullRoom } from "./apply.ts";
import { noCallCanStart } from "./call.ts";
import { loadNotes } from "./passage.ts";
import { ownerNote } from "./clean.ts";
import { keptOrigin } from "./origin.ts";
import { sortNote } from "./sort.ts";
import { changeKind, count, countDecision } from "./stats.ts";
import { getMemoryLanguage, getNewNotes, hearsayUsed, listHearsay, roomOf, type Note } from "./store.ts";
import { weight, weightOf } from "./weight.ts";
import { deleteNote, fits, insertNote, listRoom, listRoomExact, lockHearsay, lockRoom, readNote, roomLimit, takeHearsay, updateNote, type Room } from "./write.ts";

/**
 * The owner reads and edits the palace: the notes about them (shared by their Agents), each Agent's own notes, and the
 * hearsay an Agent keeps. Every route is the owner's; anyone else, and an id that is nothing of theirs, gets the same
 * 404. The vault only fills by itself: the one way out of it is the owner's `vault: false` here (the plan's rule); a
 * text edit alone may move a note in (re-sorted), never out, and never touches a note whose `vault_by` is the owner.
 */

const empty = z.object({});
const agentParams = z.object({ id: uuidParam });
const agentNoteParams = z.object({ id: uuidParam, noteId: uuidParam });
const agentHearsayParams = z.object({ id: uuidParam, hearsayId: uuidParam });
const noteParams = z.object({ id: uuidParam });
const changeParams = z.object({ id: uuidParam, changeId: uuidParam });
/** How a decision on a change ended; `dropped` (a confirmation only, when any): how many of its in-place ops were left out, their note having changed since. */
const changeStatus = z.object({ status: z.enum(["applied", "undone", "discarded"]), dropped: z.number().int().positive().optional() });

// Far beyond any room: so a too-long entry is `room_full` with what is left, not a 400.
const textField = z.string().max(10_000);
const newNote = z.strictObject({ text: textField, vault: z.boolean().optional() });
/**
 * A patch: a text, the vault, or both (the memory page's); or 以后别说 under a social reply (ring 1b): `vault: true` and the reply it was
 * pressed under (`from`), nothing else — its own shape, held to that reply (`vaultFromReply`).
 */
const notePatch = z
  .strictObject({
    text: textField.optional(),
    vault: z.boolean().optional(),
    from: z.strictObject({ conversationId: uuidParam, seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).optional(),
  })
  .refine((b) => (b.from !== undefined ? b.vault === true && b.text === undefined : b.text !== undefined || b.vault !== undefined));

const noteView = z.object({
  id: z.string(),
  text: z.string(),
  vault: z.boolean(),
  unsure: z.boolean(),
  origin: z.enum(["review", "owner", "hearsay"]),
  source: z.object({ kind: z.enum(["agent", "group", "manual", "mixed"]), title: z.string().nullable() }),
  createdAt: z.string(),
  updatedAt: z.string(),
  strength: z.number(),
  seenAt: z.string(),
});
const roomView = z.object({ notes: z.array(noteView), used: z.number(), limit: z.number(), maxNotes: z.number() });
const hearsayView = z.object({
  id: z.string(),
  text: z.string(),
  speakerName: z.string(),
  /** The speaker's account name now (read at request time); null only for an entry with no speaker id. For the owner only, never shown to a model. */
  speakerHandle: z.string().nullable(),
  group: z.object({ id: z.string(), title: z.string().nullable() }).nullable(),
  saidAt: z.string(),
});
const ok = z.object({ ok: z.literal(true) });
const conversionView = z.object({
  state: z.enum(["idle", "running", "done"]),
  result: z.object({ rooms: z.number(), converted: z.number(), kept: z.number(), noRoom: z.number(), failedRooms: z.number() }).optional(),
  unavailable: z.literal(true).optional(),
});

type Source = { kind: "agent" | "group" | "manual" | "mixed"; title: string | null };

/**
 * Where each conversation a note of `room` was learned in stands: the Agent's own chat (named after the Agent) or a group
 * (its title, read only while the room's owner — the owner, or the Agent's — is a current member there: after leaving,
 * the group's title is not read again, null).
 */
async function sourcesOf(q: Queryable, notes: ReadonlyArray<Note>, room: Room): Promise<Map<string, Source>> {
  const ids = [...new Set(notes.flatMap((n) => (n.originConversationId ? [n.originConversationId] : [])))];
  if (ids.length === 0) return new Map();
  const { rows } = await q.query<{ id: string; type: string; title: string | null; agent_name: string | null }>(
    `select c.id, c.type, case when om.principal_id is null then null else c.title end as title, p.display_name as agent_name
       from conversations c
       left join agent_conversations ac on ac.conversation_id = c.id
       left join principals p on p.id = ac.agent_id
       left join memberships om on om.conversation_id = c.id and om.left_seq is null
        and om.principal_id = coalesce($2::uuid, (select a.owner_id from principals a where a.id = $3::uuid))
      where c.id = any($1::uuid[])`,
    [ids, room.kind === "owner" ? room.ownerId : null, room.kind === "self" ? room.agentId : null],
  );
  return new Map(rows.map((r) => [r.id, r.type === "agent" ? { kind: "agent", title: r.agent_name } : { kind: "group", title: r.title }]));
}

const MANUAL: Source = { kind: "manual", title: null };
/** Made of words from more than one place: no conversation is its origin any more, and it was not typed by the owner. */
const MIXED: Source = { kind: "mixed", title: null };

const toNoteView = (n: Note, sources: Map<string, Source>): z.infer<typeof noteView> => ({
  id: n.id,
  text: n.text,
  vault: n.vault,
  unsure: n.unsure,
  origin: n.origin,
  source: (n.originConversationId && sources.get(n.originConversationId)) || (n.originConversationId === null && n.origin !== "owner" ? MIXED : MANUAL),
  createdAt: n.createdAt.toISOString(),
  updatedAt: n.updatedAt.toISOString(),
  strength: n.strength,
  seenAt: n.seenAt.toISOString(),
});

export function registerMemoryRoutes(app: FastifyInstance, { readLimit }: { readLimit: PrincipalLimit }): void {
  const { db, config, judge } = app.deps;
  const api = app.withTypeProvider<ZodTypeProvider>();
  const writeLimit = perPrincipalLimit(app, 30);
  // A conversion is paid for from the owner's memory allowance (the site's, not their points), one call per room.
  const convertLimit = perPrincipalLimit(app, 6);
  const limits = roomOf(config);
  const limitOf = (room: Room): number => roomLimit(limits, room.kind);
  const sortDeps = (log: FastifyBaseLogger, ownerId: string) => ({ db, judge, config, log, ownerId });

  // `left` is a number: `ErrorDetails` only types strings, but the handler sends whatever it is given as it is.
  // `count: true` says the room refused for the number of its notes, not for their weight (`left` is the weight really left either way).
  const roomFull = (left: number, count = false) => new AppError(409, "room_full", (count ? { left, count: true } : { left }) as unknown as ErrorDetails);
  const refused = () => new AppError(422, "note_refused");

  /** What the room holds, with the notes as the owner sees them. */
  async function view(room: Room): Promise<z.infer<typeof roomView>> {
    const notes = await listRoom(db, room);
    const sources = await sourcesOf(db, notes, room);
    return { notes: notes.map((n) => toNoteView(n, sources)), used: weightOf(notes), limit: limitOf(room), maxNotes: limits.notes! };
  }

  async function noteOf(q: Queryable, room: Room, id: string): Promise<z.infer<typeof noteView>> {
    const note = await readNote(q, room, id);
    if (!note) throw notFound();
    return toNoteView(note, await sourcesOf(q, [note], room));
  }

  /** Room left for text of `room` once `without` is not counted (a note being replaced). */
  const leftIn = (room: Room, notes: ReadonlyArray<Note>, without?: Note): number => Math.max(0, limitOf(room) - weightOf(notes) + (without ? weight(without.text) : 0));
  /** Whether `note` may take `text`: an edit that does not make the room heavier always may, also in a room over its limit (one lowered below what it holds). */
  const editFits = (room: Room, notes: ReadonlyArray<Note>, note: Note, text: string): boolean => fits(weightOf(notes), weight(text) - weight(note.text), limitOf(room));

  /** Why a new note of `text` does not fit the room as it stands (it already holds `roomNotes` notes, or the note is too heavy); null when it fits. */
  const noRoomFor = (room: Room, notes: ReadonlyArray<Note>, text: string): AppError | null => {
    const left = leftIn(room, notes);
    if (notes.length >= limits.notes!) return roomFull(left, true);
    return weight(text) > left ? roomFull(left) : null;
  };

  async function add(room: Room, ownerId: string, body: z.infer<typeof newNote>, log: FastifyBaseLogger) {
    const text = ownerNote(body.text);
    if (text === null) throw refused();
    // Over the room already (no judgement is spent on it); asked again under the lock.
    const fullNow = noRoomFor(room, await listRoom(db, room), text);
    if (fullNow) throw fullNow;
    // The owner's own choice is final; otherwise their setting decides, `auto` by the judge (sort.ts: vault when it cannot answer).
    const sorted =
      body.vault === undefined ? await sortNote(sortDeps(log, ownerId), text, room.kind, await getNewNotes(db, ownerId)) : { vault: body.vault, unsure: false };
    // The answer is the row this transaction wrote, read in it (fix round 1, F2): nothing done after the commit can turn it into a 404.
    return db.tx(async (t) => {
      await lockRoom(t, room);
      const full = noRoomFor(room, await listRoom(t, room), text);
      if (full) throw full;
      const id = await insertNote(t, room, {
        text,
        vault: sorted.vault,
        vaultBy: body.vault === undefined ? "auto" : "owner",
        unsure: sorted.unsure,
        origin: "owner",
        originConversationId: null,
      });
      return noteOf(t, room, id);
    });
  }

  async function edit(room: Room, ownerId: string, noteId: string, body: { text?: string; vault?: boolean }, log: FastifyBaseLogger) {
    const text = body.text === undefined ? undefined : ownerNote(body.text);
    if (text === null) throw refused();
    const notesBefore = await listRoom(db, room);
    const before = notesBefore.find((n) => n.id === noteId);
    if (!before) throw notFound();
    // Over the room already (no judgement is spent on it); asked again under the lock.
    if (text !== undefined && !editFits(room, notesBefore, before, text)) throw roomFull(leftIn(room, notesBefore, before));
    // A text change alone re-sorts, and only a note outside the vault that the owner never chose for: towards the vault.
    const resort = body.vault === undefined && text !== undefined && text !== before.text && !before.vault && before.vaultBy === "auto";
    const sorted = resort ? await sortNote(sortDeps(log, ownerId), text, room.kind, await getNewNotes(db, ownerId)) : null;
    // What it actually changed is decided under the lock, from the note as it is there (fix round 1, F1): a move another write made first
    // (以后别说, another tab) is not this one's to count. The answer is the row as this transaction left it (F2).
    const done = await db.tx(async (t) => {
      await lockRoom(t, room);
      const notes = await listRoom(t, room);
      const note = notes.find((n) => n.id === noteId);
      if (!note) throw notFound();
      if (text !== undefined && !editFits(room, notes, note, text)) throw roomFull(leftIn(room, notes, note));
      const patch =
        body.vault !== undefined
          ? { vault: body.vault, vaultBy: "owner" as const, unsure: false }
          : sorted?.vault && !note.vault && note.vaultBy === "auto"
            ? { vault: true, unsure: sorted.unsure }
            : {};
      const changed = (text !== undefined && text !== note.text) || Object.keys(patch).length > 0;
      // A text the owner typed may hold anything, so the note no longer began only where it did (origin.ts).
      const typed = text !== undefined && text !== note.text ? { text, originConversationId: keptOrigin(note.originConversationId, { from: "owner" }) } : {};
      if (changed) await updateNote(t, room, noteId, { ...patch, ...typed });
      return {
        view: await noteOf(t, room, noteId),
        unlocked: body.vault === false && note.vault,
        locked: body.vault === true && !note.vault,
        editedAuto: typed.text !== undefined && note.origin === "review",
      };
    });
    // What the owner did to what the model had put there (`stats.ts`): a change of mind about it, counted once it committed.
    if (done.unlocked) count(db, "owner_unlocked");
    if (done.locked) count(db, "owner_locked");
    if (done.editedAuto) count(db, "owner_edited_auto_note");
    return done.view;
  }

  /**
   * 以后别说 under a social reply (ring 1b, design §7.3): the note goes into the vault as the owner's lock, held to that reply. Under the
   * room's lock: the reply `from` must be an Agent's message of a social conversation the owner can see, sent by an Agent of theirs (this
   * one, for its own note), and posted by a run that was shown this very note (else 404, as for anything not theirs); the note must still
   * be exactly the version that run read (else 409 `note_changed`, nothing written: it was edited, merged, vaulted or deleted since, and
   * the owner's row turns into the text-free marker). One committed open→vault transition, counted apart from the memory page's own
   * (`social_note_vaulted_from_reply`, never `owner_locked`).
   */
  async function vaultFromReply(room: Room, ownerId: string, noteId: string, from: { conversationId: string; seq: number }, agentId: string | null) {
    const outcome = await db.tx(async (t): Promise<z.infer<typeof noteView> | "changed" | "unknown"> => {
      await lockRoom(t, room);
      const shown = await t.query<{ version: string | null }>(
        `select (select s ->> 'version' from jsonb_array_elements(run.shown_notes) s where s ->> 'kind' = $4 and s ->> 'id' = $5 limit 1) as version
           from messages m ${VISIBLE_JOIN}
           join conversations c on c.id = m.conversation_id and c.type = 'agent_social'
           join principals sender on sender.id = m.sender_id and sender.owner_id = $1
           join agent_runs run on ${postingRun("m", "run")} and m.client_txn = run.id::text
          where m.conversation_id = $2 and m.seq = $3 and m.kind = 'text' and ($6::uuid is null or m.sender_id = $6::uuid)
            and jsonb_typeof(run.shown_notes) = 'array'`,
        [ownerId, from.conversationId, from.seq, room.kind, noteId, agentId],
      );
      const version = shown.rows[0]?.version ?? null;
      if (version === null) return "unknown";
      // The note now, its state and exact version from one read (`listRoomExact`), under the lock every writer of the room takes.
      const now = (await listRoomExact(t, room)).find((e) => e.note.id === noteId);
      if (now === undefined || now.note.vault || now.updatedAt !== version) return "changed";
      await updateNote(t, room, noteId, { vault: true, vaultBy: "owner", unsure: false });
      // The answer is the row as this transaction left it (fix round 1, F2), not a read after the lock is let go.
      return noteOf(t, room, noteId);
    });
    if (outcome === "unknown") throw notFound();
    if (outcome === "changed") throw new AppError(409, "note_changed");
    count(db, "social_note_vaulted_from_reply");
    return outcome;
  }

  async function remove(room: Room, noteId: string): Promise<{ ok: true }> {
    // Under the room's lock like every write: an undo or a confirm of a change holds it while it reads the room.
    const gone = await db.tx(async (t) => {
      await lockRoom(t, room);
      const note = await readNote(t, room, noteId);
      return (await deleteNote(t, room, noteId)) ? { origin: note?.origin ?? null } : null;
    });
    if (!gone) throw notFound();
    if (gone.origin === "review") count(db, "owner_deleted_auto_note");
    return { ok: true };
  }

  /** The owner's Agent `agentId` as its owner sees it (also a deleted one: its notes stay theirs to read and delete); 404 for anyone else's. */
  async function ownAgent(ownerId: string, agentId: string) {
    const agent = await readOwnedAgent(db, ownerId, agentId);
    if (!agent) throw notFound();
    return agent;
  }
  /**
   * Whether the Agent's current model can carry the whole palace in its own conversation: the notes passage of everything it may be
   * shown there is within `MEMORY.passageShare` of the model's context, measured as a reply's run measures it (at the model's
   * planning ratio, metering/tokens.ts `planRatio`). No model call (the passage is measured, `fitNotes`); true when
   * there is nothing to measure against (no model that can be called, no notes read, no persona yet).
   */
  async function palaceFits(agent: AgentRow, ownerName: string): Promise<boolean> {
    if (!agent.memory || agent.persona === "") return true;
    let resolved;
    try {
      resolved = await resolveModel(db, config, agent);
    } catch {
      return true;
    }
    if (resolved === null) return true;
    const found = await loadNotes(db, agent, { place: "own" });
    const planned = planRatio(await db.tx((t) => readRatio(t, ratioKey(resolved))));
    return fitNotes(found, "own", config.siteTimezone, ownerName, passageBudget(resolved.contextTokens, resolved.call.maxOutputTokens, config.memory.passageShare), planned).fits;
  }
  const mustLive = (agent: { deleted: boolean }): void => {
    if (agent.deleted) throw new AppError(409, "agent_deleted");
  };

  // --- the owner's room: what all their Agents may know about them -------------------------------------------------

  api.get("/api/memory/notes", { schema: { params: empty, querystring: empty, response: { 200: roomView } } }, async (req) => {
    const me = await requirePrincipal(req);
    await readLimit(req, me.id);
    return view({ kind: "owner", ownerId: me.id });
  });

  api.post("/api/memory/notes", { schema: { params: empty, querystring: empty, body: newNote, response: { 201: noteView } } }, async (req, reply) => {
    const me = await requirePrincipal(req);
    await writeLimit(req, me.id);
    return reply.code(201).send(await add({ kind: "owner", ownerId: me.id }, me.id, req.body, req.log));
  });

  api.patch("/api/memory/notes/:id", { schema: { params: noteParams, querystring: empty, body: notePatch, response: { 200: noteView } } }, async (req) => {
    const me = await requirePrincipal(req);
    await writeLimit(req, me.id);
    const room: Room = { kind: "owner", ownerId: me.id };
    return req.body.from !== undefined ? vaultFromReply(room, me.id, req.params.id, req.body.from, null) : edit(room, me.id, req.params.id, req.body, req.log);
  });

  api.delete("/api/memory/notes/:id", { schema: { params: noteParams, querystring: empty, body: empty.nullish(), response: { 200: ok } } }, async (req) => {
    const me = await requirePrincipal(req);
    await writeLimit(req, me.id);
    return remove({ kind: "owner", ownerId: me.id }, req.params.id);
  });

  // --- one language for the palace ---------------------------------------------------------------------------------

  // The owner's existing notes (the shared room and each Agent's own, never hearsay) restated in the language they chose, by the
  // dream's own rewrite path (dream.ts). It takes a call per room, one after another, which may be longer than a request may wait:
  // the POST starts the job and answers at once (202), the GET says how it stands. 409 `no_language` while the setting is automatic,
  // 409 `busy` while a dream or a conversion of theirs is under way, 503 `unavailable` when it is known before starting that no call
  // could start (the allowance is spent, no model resolves) or the service is stopping.
  api.post(
    "/api/memory/language/convert",
    { schema: { params: empty, querystring: empty, body: empty.nullish(), response: { 202: z.object({ started: z.literal(true) }) } } },
    async (req, reply) => {
      const me = await requirePrincipal(req);
      await convertLimit(req, me.id);
      const language = await getMemoryLanguage(db, me.id);
      if (language === null) throw new AppError(409, "no_language");
      const memory = app.deps.memory;
      if (!memory || (await noCallCanStart(db, config, me.id, new Date()))) throw new AppError(503, "unavailable");
      const started = await memory.convert(me.id, language);
      if (started === "busy") throw new AppError(409, "busy");
      if (started === null) throw new AppError(503, "unavailable");
      return reply.code(202).send({ started: true as const });
    },
  );

  // How the owner's latest conversion stands (in this process's memory: `idle` after a restart). `unavailable` when no room's call could
  // even start (too many calls running, the allowance spent meanwhile): nothing happened, as a 503 would have said. A call that started
  // and failed is a failed room.
  api.get(
    "/api/memory/language/convert",
    { schema: { params: empty, querystring: empty, response: { 200: conversionView } } },
    async (req) => {
      const me = await requirePrincipal(req);
      await readLimit(req, me.id);
      const now = app.deps.memory?.conversion(me.id) ?? { state: "idle" as const };
      if (now.state !== "done") return { state: now.state };
      const { unanswered, ...result } = now.result;
      return { state: "done" as const, result, ...(result.rooms > 0 && unanswered === result.rooms ? { unavailable: true as const } : {}) };
    },
  );

  // --- an Agent's room: its own notes and what it heard ----------------------------------------------------------

  api.get(
    "/api/agents/:id/memory",
    {
      schema: {
        params: agentParams,
        querystring: empty,
        response: { 200: roomView.extend({ hearsay: z.array(hearsayView), hearsayUsed: z.number(), hearsayLimit: z.number(), fits: z.boolean() }) },
      },
    },
    async (req) => {
      const me = await requirePrincipal(req);
      await readLimit(req, me.id);
      const agent = await ownAgent(me.id, req.params.id);
      const [room, heard, groups, speakers] = await Promise.all([
        view({ kind: "self", agentId: agent.id }),
        listHearsay(db, agent.id),
        // The groups the Agent is in now: once it has left one, what it heard there no longer says which.
        // (Note for the controller: the notes page and the passage go by the owner's membership, as Task R asks; this, by the Agent's.)
        db.query<{ id: string; title: string | null }>(
          `select c.id, c.title from memberships m join conversations c on c.id = m.conversation_id
            where m.principal_id = $1 and m.left_seq is null and ${groupPlaceSql("c")}`,
          [agent.id],
        ),
        db.query<{ id: string; handle: string }>("select id, handle::text as handle from principals where id in (select speaker_id from agent_hearsay where agent_id = $1)", [agent.id]),
      ]);
      const titles = new Map(groups.rows.map((g) => [g.id, g.title]));
      const handles = new Map(speakers.rows.map((s) => [s.id, s.handle]));
      return {
        ...room,
        hearsay: heard.map((h) => ({
          id: h.id,
          text: h.text,
          speakerName: h.speakerName,
          speakerHandle: (h.speakerId === null ? undefined : handles.get(h.speakerId)) ?? null,
          group: titles.has(h.conversationId) ? { id: h.conversationId, title: titles.get(h.conversationId)! } : null,
          saidAt: h.saidAt.toISOString(),
        })),
        hearsayUsed: hearsayUsed(heard),
        hearsayLimit: limits.hearsay,
        fits: await palaceFits(agent, me.displayName),
      };
    },
  );

  api.post(
    "/api/agents/:id/memory/notes",
    { schema: { params: agentParams, querystring: empty, body: newNote, response: { 201: noteView } } },
    async (req, reply) => {
      const me = await requirePrincipal(req);
      await writeLimit(req, me.id);
      const agent = await ownAgent(me.id, req.params.id);
      mustLive(agent);
      return reply.code(201).send(await add({ kind: "self", agentId: agent.id }, me.id, req.body, req.log));
    },
  );

  api.patch(
    "/api/agents/:id/memory/notes/:noteId",
    { schema: { params: agentNoteParams, querystring: empty, body: notePatch, response: { 200: noteView } } },
    async (req) => {
      const me = await requirePrincipal(req);
      await writeLimit(req, me.id);
      const agent = await ownAgent(me.id, req.params.id);
      mustLive(agent);
      const room: Room = { kind: "self", agentId: agent.id };
      return req.body.from !== undefined ? vaultFromReply(room, me.id, req.params.noteId, req.body.from, agent.id) : edit(room, me.id, req.params.noteId, req.body, req.log);
    },
  );

  api.delete(
    "/api/agents/:id/memory/notes/:noteId",
    { schema: { params: agentNoteParams, querystring: empty, body: empty.nullish(), response: { 200: ok } } },
    async (req) => {
      const me = await requirePrincipal(req);
      await writeLimit(req, me.id);
      const agent = await ownAgent(me.id, req.params.id);
      return remove({ kind: "self", agentId: agent.id }, req.params.noteId);
    },
  );

  api.delete(
    "/api/agents/:id/memory/hearsay/:hearsayId",
    { schema: { params: agentHearsayParams, querystring: empty, body: empty.nullish(), response: { 200: ok } } },
    async (req) => {
      const me = await requirePrincipal(req);
      await writeLimit(req, me.id);
      const agent = await ownAgent(me.id, req.params.id);
      // Under the Agent's hearsay lock, as a consolidation and an undo are: an undo can never put back what this deleted.
      const taken = await db.tx(async (t) => {
        await lockHearsay(t, agent.id);
        return takeHearsay(t, agent.id, req.params.hearsayId);
      });
      if (!taken) throw notFound();
      count(db, "hearsay_deleted");
      return { ok: true as const };
    },
  );

  // What an Agent heard, taken as true: it becomes a note about the owner, in the vault (a group never gets it
  // except the one it was heard in), and stops being hearsay. Whether it fits is decided under the owner's room lock.
  api.post(
    "/api/agents/:id/memory/hearsay/:hearsayId/confirm",
    { schema: { params: agentHearsayParams, querystring: empty, body: empty.nullish(), response: { 201: noteView } } },
    async (req, reply) => {
      const me = await requirePrincipal(req);
      await writeLimit(req, me.id);
      const agent = await ownAgent(me.id, req.params.id);
      const room: Room = { kind: "owner", ownerId: me.id };
      // The note points at the group the entry was heard in: that row is taken first, before the room and the hearsay (the lock
      // order; conversations/store.ts `lockConversationKeys`). An entry's group never changes, so it is read before the transaction.
      const where = await db.query<{ conversation_id: string }>("select conversation_id from agent_hearsay where id = $1 and agent_id = $2", [req.params.hearsayId, agent.id]);
      // (The answer is the row this transaction wrote, read in it, as an add's is: fix round 1, F2.)
      const made = await db.tx(async (t) => {
        await lockConversationKeys(t, where.rows.map((r) => r.conversation_id));
        await lockRoom(t, room);
        await lockHearsay(t, agent.id);
        const heard = await takeHearsay(t, agent.id, req.params.hearsayId);
        if (!heard) throw notFound();
        // Held to the owner's rules as anything entering their room is; refused, it rolls back and the hearsay stays.
        const text = ownerNote(heard.text);
        if (text === null) throw refused();
        const full = noRoomFor(room, await listRoom(t, room), text);
        if (full) throw full;
        const id = await insertNote(t, room, {
          text,
          vault: true,
          vaultBy: "auto",
          unsure: false,
          origin: "hearsay",
          originConversationId: heard.conversationId,
        });
        return noteOf(t, room, id);
      });
      count(db, "hearsay_confirmed");
      return reply.code(201).send(made);
    },
  );
  // --- the changes a review made, as the owner may take them back or decide on them -----------------------------------

  /**
   * One of the owner's decisions on a change of this Agent's: `run` does it in a transaction and says how it went. 404 for
   * anyone else's change or another Agent's; asking again for what is already so answers it again; any other state of
   * the change, or a note that moved on since, is 409 `stale_change`; a room that cannot take it back 409 `room_full`, with the
   * weight really left in that room (`full`, filled in by `run`) and `count` when it is the number of its notes that refuses.
   */
  async function decide(
    ownerId: string,
    agentId: string,
    changeId: string,
    wanted: "applied" | "undone" | "discarded",
    run: (t: Tx) => Promise<"ok" | "stale" | "full" | null>,
    acted: () => void = () => undefined,
    full: FullRoom = {},
  ): Promise<{ status: typeof wanted }> {
    const found = await db.query<{ agent_id: string; status: string }>("select agent_id, status from memory_changes where id = $1 and owner_id = $2", [changeId, ownerId]);
    if (found.rows[0]?.agent_id !== agentId) throw notFound();
    const outcome = await db.tx(run);
    if (outcome === "ok") acted();
    if (outcome === "stale") throw new AppError(409, "stale_change");
    if (outcome === "full") throw roomFull(full.left ?? 0, full.count === true);
    if (outcome === null) {
      const now = await db.query<{ status: string }>("select status from memory_changes where id = $1", [changeId]);
      if (now.rows[0]?.status === wanted) return { status: wanted };
      throw new AppError(409, "stale_change");
    }
    return { status: wanted };
  }

  const changeRoute = (
    verb: "undo" | "confirm" | "discard",
    wanted: "undone" | "applied" | "discarded",
    act: (t: Tx, ownerId: string, changeId: string, report: { dropped: number } & FullRoom) => Promise<"ok" | "stale" | "full" | null>,
  ) =>
    api.post(
      `/api/agents/:id/memory/changes/:changeId/${verb}`,
      { schema: { params: changeParams, querystring: empty, body: empty.nullish(), response: { 200: changeStatus } } },
      async (req) => {
        const me = await requirePrincipal(req);
        await writeLimit(req, me.id);
        const agent = await ownAgent(me.id, req.params.id);
        // A confirmation that applied the adds of a change whose in-place ops went stale says how many ops it left out; an undo or a
        // confirmation that does not fit, why (`FullRoom`).
        const report: { dropped: number } & FullRoom = { dropped: 0 };
        // The notice of the change is pushed to its owner again, now with its new status (read when it is sent) — also when
        // a confirmation found the change stale and discarded it.
        const again = async (): Promise<void> => {
          const notices = await db.query<{ seq: string }>(
            "select seq::text from messages where conversation_id = $1 and kind = 'system' and body ->> 'changeId' = $2",
            [agent.conversationId, req.params.changeId],
          );
          for (const n of notices.rows) app.realtime.pushNoticeAgain(agent.conversationId, me.id, Number(n.seq));
        };
        let decided: { status: typeof wanted };
        try {
          const kind = verb === "discard" ? null : await changeKind(db, req.params.changeId);
          decided = await decide(me.id, agent.id, req.params.changeId, wanted, (t) => act(t, me.id, req.params.changeId, report), () => countDecision(db, verb, kind), report);
        } catch (err) {
          if (verb === "confirm" && err instanceof AppError && err.code === "stale_change") await again();
          throw err;
        }
        await again();
        // A change the owner confirmed may have left a room nearly full.
        if (verb === "confirm") app.deps.memory?.changed(agent.id);
        return report.dropped > 0 ? { ...decided, dropped: report.dropped } : decided;
      },
    );

  changeRoute("undo", "undone", async (t, ownerId, changeId, report) => undoChange(t, ownerId, changeId, limits, report).then((r) => (r === "undone" ? "ok" : r)));
  changeRoute("confirm", "applied", async (t, ownerId, changeId, report) => {
    const r = await confirmChange(t, ownerId, changeId, limits, report);
    return r === "stale" || r === "full" || r === null ? r : "ok";
  });
  changeRoute("discard", "discarded", async (t, ownerId, changeId) => ((await discardChange(t, ownerId, changeId)) === null ? null : "ok"));
}
