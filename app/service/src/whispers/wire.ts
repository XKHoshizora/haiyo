import { z } from "zod";
import { hitOf, type ElsewhereHit } from "../agents/tools/elsewhere.ts";
import { onSnapshot, type Db, type Queryable } from "../db.ts";
import {
  NO_TELL,
  readableHits,
  readWhispers,
  tellStates,
  WHISPER_ACTIONS,
  WHISPER_KINDS,
  WIRE_STATUSES,
  type TellState,
  type Whisper,
  type WhisperAction,
  type WhisperKind,
  type WireStatus,
} from "./store.ts";

/**
 * A whisper as its owner receives it — and nobody else ever does (README "Whispers"): in the `whisper` push, `GET /api/sync`'s
 * and catch-up's `whispers`, the list route and an answer. `text` and `actions` are its body's; `detail` is its body's too,
 * but for a `found_elsewhere` one, whose hits are read now (`wireWhispers`); nothing else of the body, and not its owner
 * (the reader) or when it was answered, leaves the service.
 */
export interface WireWhisper {
  id: string;
  conversationId: string;
  agentId: string;
  /** It shows after the message with this seq (several there: by `createdAt`). */
  afterSeq: number;
  kind: WhisperKind;
  text: string;
  actions: WhisperAction[];
  /** As stored; a `found_elsewhere` one's derived: open, telling, told, declined or expired (`foundView`). */
  status: WireStatus;
  /** A `found_elsewhere` one that is open again because its latest told reply ended without posting (present only then). */
  lastTellFailed?: true;
  /**
   * An open `found_elsewhere` one (present only then): the moment it reads expired, a day after it was made — so its owner's
   * screen says so at that moment, without waiting for the sweep's push. Other answers end it sooner, and are pushed.
   */
  openUntil?: string;
  createdAt: string;
  /**
   * Which of two copies is the later: computed from the state it is read in, never stored (`revisionOf`), and never lower
   * for a later state. A client keeps the copy with the higher; of two with the same, the later one (they say the same).
   */
  revision: number;
  detail?: unknown;
}

export const wireWhisperSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  agentId: z.string(),
  afterSeq: z.number(),
  kind: z.enum(WHISPER_KINDS),
  text: z.string(),
  actions: z.array(z.enum(WHISPER_ACTIONS)),
  status: z.enum(WIRE_STATUSES),
  lastTellFailed: z.literal(true).optional(),
  openUntil: z.string().optional(),
  createdAt: z.string(),
  revision: z.number(),
  detail: z.unknown().optional(),
});

/** What its owner reads of a `found_elsewhere` whisper now: its state, derived (Redesign D), and the hits she can read. */
export interface FoundView {
  status: WireStatus;
  lastTellFailed: boolean;
  /** While open: the moment it reads expired (whispers/store.ts `endsSql`, the moment its rule turns). */
  openUntil: Date | null;
  revision: number;
  /** The hits, read now: given for an open or telling one only (nothing else shows them). */
  hits: ElsewhereHit[] | null;
}

/**
 * The state of `found_elsewhere` whisper `w`, from its told replies and its age (`tell`) and how many of its hits its owner
 * can read now (`readable`): told once a told reply of it posted (final); else what is stored when that is no longer open
 * (declined, expired: final); else telling while a told reply of it is queued or running; else expired when it is a day old
 * (`WHISPERS.elsewhereTtlHours`, before the sweep stores it so) or no hit is left to read; else open — `lastTellFailed`
 * when it has had a told reply (none posted, none under way: its latest ended without posting), and `openUntil` the
 * moment it will be a day old. Open is exactly what whispers/store.ts `mayTell` lets a told reply begin from. Its revision
 * rises with every step of that (`revisionOf`).
 */
export function foundView(w: Pick<Whisper, "status">, tell: TellState, readable: number): Omit<FoundView, "hits"> {
  const status: WireStatus = tell.told ? "told" : w.status !== "open" ? w.status : tell.telling ? "telling" : tell.aged || readable === 0 ? "expired" : "open";
  return {
    status,
    lastTellFailed: status === "open" && tell.runs > 0,
    openUntil: status === "open" ? tell.ends : null,
    revision: revisionOf(w, tell, status),
  };
}

/**
 * A whisper's revision, from the state it is read in: never lower for a later state, so a client that keeps the copy with
 * the higher never lets an older copy undo a change. For a `found_elsewhere` one: eight for each told reply it has had,
 * then four once the latest of them has ended, two once one has posted, one once it is final otherwise (declined or
 * expired, stored or derived) — each told reply only ever goes on (queued, running, ended), a new one comes only after the
 * last has ended, and a final state never opens again. For any other kind: 0 while open, 1 once answered or expired.
 */
function revisionOf(w: Pick<Whisper, "status">, tell: TellState, status: WireStatus): number {
  const ended = tell.runs > 0 && !tell.telling;
  const final = w.status !== "open" || status === "expired" || status === "declined";
  return 8 * tell.runs + (ended ? 4 : 0) + (tell.told ? 2 : 0) + (final ? 1 : 0);
}

/**
 * A whisper as its owner receives it; a `found_elsewhere` one with its `found` view (`wireWhispers` reads it): its derived
 * state, and its hits, as she can read them now, in place of what its row keeps (references).
 */
export function toWireWhisper(w: Whisper, found?: FoundView): WireWhisper {
  const base = { id: w.id, conversationId: w.conversationId, agentId: w.agentId, afterSeq: w.afterSeq, kind: w.kind, text: w.body.text, actions: [...w.body.actions] };
  if (w.kind === "found_elsewhere" && found) {
    return {
      ...base,
      status: found.status,
      ...(found.lastTellFailed ? { lastTellFailed: true as const } : {}),
      ...(found.openUntil ? { openUntil: found.openUntil.toISOString() } : {}),
      createdAt: w.createdAt.toISOString(),
      revision: found.revision,
      ...(found.hits === null ? {} : { detail: { hits: found.hits } }),
    };
  }
  if (w.kind === "found_elsewhere") {
    // Never sent without its view (its row's references are not the owner's to read as they are).
    throw new Error("toWireWhisper: a found_elsewhere whisper needs its view (wireWhispers)");
  }
  return {
    ...base,
    status: w.status,
    createdAt: w.createdAt.toISOString(),
    revision: w.status === "open" ? 0 : 1,
    ...(w.body.detail === undefined ? {} : { detail: w.body.detail }),
  };
}

/** How a whisper is read for its owner: the site's time zone (its hits' times) and `WHISPERS.elsewhereTtlHours`. */
export interface WireOptions {
  timeZone: string;
  elsewhereTtlHours: number;
}

/**
 * Each of `whispers` as its owner receives it now (the order kept): a `found_elsewhere` one's state derived from its told
 * replies and its age (`tellStates`, one statement for all) and its hits read under its owner's access now (`readableHits`,
 * one statement for all) — only for one stored open and not told: nothing else shows them or depends on them. `q` must be
 * one snapshot with the read of `whispers` themselves (`wireWhispersOf`; sync and catch-up read on one already), so that a
 * copy never mixes two moments.
 */
export async function wireWhispers(q: Queryable, whispers: readonly Whisper[], { timeZone, elsewhereTtlHours }: WireOptions): Promise<WireWhisper[]> {
  const found = whispers.filter((w) => w.kind === "found_elsewhere");
  if (found.length === 0) return whispers.map((w) => toWireWhisper(w));
  const tells = await tellStates(q, found.map((w) => w.id), elsewhereTtlHours);
  const reading = found.filter((w) => w.status === "open" && !(tells.get(w.id) ?? NO_TELL).told);
  const hitsOf = new Map<string, ElsewhereHit[]>();
  for (const row of await readableHits(q, reading.map((w) => w.id))) hitsOf.set(row.whisperId, [...(hitsOf.get(row.whisperId) ?? []), hitOf(row, timeZone)]);
  return whispers.map((w) => {
    if (w.kind !== "found_elsewhere") return toWireWhisper(w);
    const hits = hitsOf.get(w.id) ?? [];
    const view = foundView(w, tells.get(w.id) ?? NO_TELL, hits.length);
    return toWireWhisper(w, { ...view, hits: view.status === "open" || view.status === "telling" ? hits : null });
  });
}

/** `ownerId`'s whispers among `ids` as she receives them now: the rows and all they are derived from, read on one snapshot. */
export function wireWhispersOf(db: Db, ownerId: string, ids: readonly string[], options: WireOptions): Promise<WireWhisper[]> {
  return onSnapshot(db, async (t) => wireWhispers(t, await readWhispers(t, ownerId, ids), options));
}
