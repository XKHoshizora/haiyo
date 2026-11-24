import { readFileSync } from "node:fs";

/**
 * The committed snapshot (src/providers/model-catalog.json) for tests that say what the service answers about a model
 * the catalogue knows: they pick a model by what it can do (`pick`) and expect what its entry says (`hintsOf`,
 * `abilitiesIn`), so that the catalogue's daily update — a context that grew, an ability a model gained, a model
 * retired — does not turn them red while the service still answers the catalogue truthfully.
 */
export interface SnapshotEntry {
  id: string;
  lab: string;
  name: string;
  vision: boolean;
  pdf: boolean;
  reasoning: boolean;
  chat: boolean;
  contextTokens?: number;
  reasoningLevels?: string[];
  tools?: true;
  audioIn?: true;
  videoIn?: true;
  imageOut?: true;
  videoOut?: true;
  audioOut?: true;
}

export const SNAPSHOT: SnapshotEntry[] = JSON.parse(readFileSync(new URL("../../src/providers/model-catalog.json", import.meta.url), "utf8"));

const MEDIA = ["audioIn", "videoIn", "imageOut", "videoOut", "audioOut"] as const;
const count = new Map<string, number>();
for (const e of SNAPSHOT) count.set(e.id, (count.get(e.id) ?? 0) + 1);

/** The entry of the id `id`; throws when the snapshot has none. */
export function entryOf(id: string): SnapshotEntry {
  const found = SNAPSHOT.find((e) => e.id === id);
  if (!found) throw new Error(`the snapshot has no model ${id}`);
  return found;
}

/**
 * The first model of the snapshot that `test` accepts, among those no other lab shares the id of and that the name rules
 * do not call another kind of model — one whose hints are its entry's, whatever the catalogue lists that day. Throws,
 * naming `what`, when there is none (then the test's premise is gone, not the service's behaviour).
 */
export function pick(what: string, test: (e: SnapshotEntry) => boolean, not: readonly SnapshotEntry[] = []): SnapshotEntry {
  const found = SNAPSHOT.find((e) => count.get(e.id) === 1 && !e.id.includes("/") && !not.includes(e) && test(e));
  if (!found) throw new Error(`the snapshot has no model that ${what}`);
  return found;
}

/** What the routes answer of an entry's abilities: `reportedTools` for its `tools`, and the five media abilities, each only as true. */
export function abilitiesIn(e: SnapshotEntry): Record<string, true> {
  const out: Record<string, true> = {};
  if (e.tools === true) out.reportedTools = true;
  for (const key of MEDIA) if (e[key] === true) out[key] = true;
  return out;
}

/** The media abilities alone (what a site model carries). */
export function mediaIn(e: SnapshotEntry): Record<string, true> {
  const { reportedTools: _tools, ...media } = abilitiesIn(e);
  return media;
}

/** `modelHints` of a model the catalogue knows by exactly this entry. */
export function hintsOf(e: SnapshotEntry): Record<string, unknown> {
  return {
    vision: e.vision,
    pdf: e.pdf,
    reasoning: e.reasoning,
    chat: e.chat,
    known: true,
    label: e.name,
    ...(e.contextTokens === undefined ? {} : { contextTokens: e.contextTokens }),
    ...(e.reasoningLevels === undefined ? {} : { reasoningLevels: e.reasoningLevels }),
    ...abilitiesIn(e),
  };
}
