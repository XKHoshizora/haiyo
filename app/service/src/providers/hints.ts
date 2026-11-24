import { z } from "zod";
import catalogFile from "./model-catalog.json" with { type: "json" };
import { modelLevels, type ModelLevel } from "./store.ts";

/**
 * What a provider's model can do, as far as its name tells: hints for its owner, who can change them when adding it
 * (README "Model providers", `POST /api/providers/:id/models/list`). Nothing here is ever enforced.
 *
 * `modelHints` looks the name up in the vendored models.dev snapshot (model-catalog.json, `npm run catalog:update`;
 * never fetched at run time); a name it does not know is judged by `inferModelHints`, the name rules.
 */
export interface NameHints {
  vision: boolean;
  pdf: boolean;
  reasoning: boolean;
  /** False when the name suggests a model that does not chat (embeddings, speech, images, video, …). */
  chat: boolean;
}

/**
 * What only the catalogue says of a model, each there only as `true` (absent: no, or not said — never guessed from a
 * name's wording): `reportedTools` (its replies can call tools: the catalogue's `tools`), `audioIn` / `videoIn` (takes
 * audio, video), `imageOut` / `videoOut` / `audioOut` (answers with images, video, audio).
 *
 * `reportedTools` is not called `tools` because a saved model stores a `tools` of its own (providers/store.ts: its
 * owner's choice, a failure found, a success found), and the two must stay apart on every wire — like `reportedLevels`
 * beside `reasoningLevels`. The five others are never stored and never accepted from a client, so nothing can be
 * confused with them and they keep their plain names.
 */
export const ABILITY_KEYS = ["reportedTools", "audioIn", "videoIn", "imageOut", "videoOut", "audioOut"] as const;
export type Abilities = { [K in (typeof ABILITY_KEYS)[number]]?: true };
/** The abilities among `from`'s keys (a `ModelHints`'), and nothing else of it. */
export function abilitiesOf(from: Abilities): Abilities {
  const out: Abilities = {};
  for (const key of ABILITY_KEYS) if (from[key] === true) out[key] = true;
  return out;
}

/**
 * The abilities as the routes answer them, each only as `true`, only for a model the catalogue knows itself (`modelHints`):
 * on a saved model and on a listed one (providers/routes.ts), and — without `reportedTools` — on a site model
 * (`GET /api/models`). Read only: no body takes any of them.
 */
export const abilitiesView = {
  reportedTools: z.literal(true).optional(),
  audioIn: z.literal(true).optional(),
  videoIn: z.literal(true).optional(),
  imageOut: z.literal(true).optional(),
  videoOut: z.literal(true).optional(),
  audioOut: z.literal(true).optional(),
};

export interface ModelHints extends NameHints, Abilities {
  /** The catalogue knows the model: the hints are its, else they are guesses from the name. */
  known: boolean;
  /** The catalogue's display name (known models only). */
  label?: string;
  /** The catalogue's context, when it gives one (known models only; it need not lie within what a model may be saved with). */
  contextTokens?: number;
  /** The levels the model's own lab offers, when the catalogue has them (only for the model itself, like the abilities: not by prefix). */
  reasoningLevels?: ModelLevel[];
}

const catalogEntry = z.strictObject({
  id: z.string().min(1),
  lab: z.string(),
  name: z.string().min(1),
  vision: z.boolean(),
  pdf: z.boolean(),
  reasoning: z.boolean(),
  chat: z.boolean(),
  contextTokens: z.number().int().positive().optional(),
  reasoningLevels: modelLevels.optional(),
  tools: z.literal(true).optional(),
  audioIn: z.literal(true).optional(),
  videoIn: z.literal(true).optional(),
  imageOut: z.literal(true).optional(),
  videoOut: z.literal(true).optional(),
  audioOut: z.literal(true).optional(),
});
type CatalogEntry = z.infer<typeof catalogEntry>;

/** A trie of the catalogue's ids, one character a step: finds the longest id a name starts with in one pass over the name. */
interface Node {
  next: Map<string, Node>;
  entry?: CatalogEntry;
}
const root: Node = { next: new Map() };
/** Puts `entry` at `id` unless something is there already (the first entry of an id two labs share wins). */
function index(id: string, entry: CatalogEntry): void {
  let node = root;
  for (const ch of id) {
    let child = node.next.get(ch);
    if (!child) node.next.set(ch, (child = { next: new Map() }));
    node = child;
  }
  node.entry ??= entry;
}
/** The entry at exactly `id`, or none. */
function at(id: string): CatalogEntry | undefined {
  let node: Node | undefined = root;
  for (const ch of id) if (!(node = node.next.get(ch))) return undefined;
  return node.entry;
}
/** The entry of the longest id `name` starts with, followed by its end or `-`. */
function longestPrefix(name: string): CatalogEntry | undefined {
  let node: Node | undefined = root;
  let best: CatalogEntry | undefined;
  for (let i = 0; node; i++) {
    if (node.entry && (i === name.length || name[i] === "-")) best = node.entry;
    if (i === name.length) break;
    node = node.next.get(name[i]!);
  }
  return best;
}

/** A trailing date (`-20251101`, `-2025-11-01`): one fixed-width test at the end. */
const DATE_SUFFIX = /-(?:\d{8}|\d{4}-\d{2}-\d{2})$/;
/** A name without a trailing `-latest`, then without a trailing date. */
const undated = (name: string): string => (name.endsWith("-latest") ? name.slice(0, -"-latest".length) : name).replace(DATE_SUFFIX, "");

/** What a snapshot entry says of the abilities (its `tools` is `reportedTools` from here on). */
type EntryAbilities = Pick<CatalogEntry, "id" | "tools" | "audioIn" | "videoIn" | "imageOut" | "videoOut" | "audioOut">;
const entryAbilities = (e: EntryAbilities): Abilities => abilitiesOf({ ...e, ...(e.tools === true ? { reportedTools: true as const } : {}) });

/**
 * Each id's abilities. An id two labs list (the snapshot keeps both entries) has an ability only when every entry of it
 * says so: which lab's model a provider serves under that id is not known, so only what holds for all is answered.
 */
export function mergedAbilities(entries: readonly EntryAbilities[]): Map<string, Abilities> {
  const out = new Map<string, Abilities>();
  for (const entry of entries) {
    const mine = entryAbilities(entry);
    const held = out.get(entry.id);
    out.set(entry.id, held === undefined ? mine : abilitiesOf(Object.fromEntries(ABILITY_KEYS.filter((key) => held[key] === true && mine[key] === true).map((key) => [key, true as const]))));
  }
  return out;
}

const CATALOG: CatalogEntry[] = z.array(catalogEntry).parse(catalogFile);
const ABLE = mergedAbilities(CATALOG);
for (const entry of CATALOG) index(entry.id, entry);
// The catalogue's own dated and `-latest` ids are found without those too, where no other id is spelt so.
for (const entry of CATALOG) index(undated(entry.id), entry);

/**
 * What the name says the model can do. The name is trimmed and lower-cased, and only its last `/` part counts
 * (`openai/gpt-6-sol` is `gpt-6-sol`). Found in the catalogue as it is; else without a trailing `-latest` and date; else
 * by the longest id it starts with, followed by `-` (`claude-sonnet-5-5-thinking` is `claude-sonnet-5-5`) — unless the
 * name rules call it no chat model (`gpt-4o-mini-tts` is not `gpt-4o-mini`). Not found: the name rules, `known: false`.
 *
 * The abilities (`ABILITY_KEYS`) and the levels (`reasoningLevels`) are answered only for the model itself — the name as
 * it is, or without its `-latest` and date — never for a name that merely starts with an id: `vision`, `pdf`, `reasoning`,
 * the label and the context of a prefix are prefills its owner sees and edits, while an ability or the levels are shown as
 * the catalogue's fact (the levels as `reportedLevels`, read each time a saved model is shown), and nothing says a variant
 * has its base's (`o1-mini` never called tools as `o1` does, nor took its levels; a relay's `gpt-4-all` is its own thing).
 * So whatever a page calls the catalogue's word is one kind of match. Such a model's tools are learned from its replies
 * instead (providers/store.ts `markToolsOn`, `markToolsOff`), and it is offered every level.
 */
export function modelHints(raw: string): ModelHints {
  const lower = raw.trim().toLowerCase();
  const name = lower.slice(lower.lastIndexOf("/") + 1);
  const short = undated(name);
  const guessed = inferModelHints(name);
  const itself = at(name) ?? at(short);
  let entry = itself;
  if (!entry) {
    const prefix = longestPrefix(short);
    if (prefix && (guessed.chat || !prefix.chat)) entry = prefix;
  }
  if (!entry) return { ...guessed, known: false };
  return {
    vision: entry.vision,
    pdf: entry.pdf,
    reasoning: entry.reasoning,
    chat: entry.chat,
    known: true,
    label: entry.name,
    ...(entry.contextTokens === undefined ? {} : { contextTokens: entry.contextTokens }),
    ...(itself?.reasoningLevels === undefined ? {} : { reasoningLevels: itself.reasoningLevels }),
    ...(itself === undefined ? {} : ABLE.get(itself.id)),
  };
}

/** Names of models that do not chat: embeddings, rerankers, speech, image and video generation, moderation, music. */
const NOT_CHAT = [
  "embed",
  "rerank",
  "bge-",
  "tts",
  "whisper",
  "speech",
  "audio",
  "voice",
  "transcribe",
  "realtime",
  "image",
  "dall-e",
  "flux",
  "stable-diffusion",
  "sd-",
  "imagen",
  "midjourney",
  "video",
  "sora",
  "veo",
  "hailuo",
  "kling",
  "moderation",
  "music",
];
const GPT_MULTIMODAL = ["gpt-4o", "gpt-4.1", "gpt-5", "gpt-6"];
const VISION = [...GPT_MULTIMODAL, "claude", "gemini", "vision", "-vl", "llava", "pixtral", "glm-4v", "qvq"];
const PDF = [...GPT_MULTIMODAL, "claude", "gemini"];
/** Anywhere in the name; `-m2` and `-m3` are MiniMax's M series. */
const REASONING = ["gpt-5", "gpt-6", "gemini-2.5", "gemini-3", "thinking", "reason", "deepseek-r", "qwq", "-m2", "-m3"];
/** At the start of the name, or of its last `/` part (`openai/o3`). */
const REASONING_START = ["o1", "o3", "o4"];
/** Claude names that do not think: every other Claude does. */
const CLAUDE_WITHOUT_REASONING = ["claude-2", "claude-3-haiku", "claude-3-opus", "claude-3-sonnet", "claude-3-5", "claude-3.5", "claude-instant"];

const hasAny = (name: string, parts: readonly string[]) => parts.some((part) => name.includes(part));

/**
 * The name rules: what a name suggests, ignoring case, by plain substring tests over the short tables above (no
 * patterns, so linear in the name's length). For names the catalogue does not know.
 */
export function inferModelHints(raw: string): NameHints {
  const name = raw.toLowerCase();
  if (hasAny(name, NOT_CHAT)) return { vision: false, pdf: false, reasoning: false, chat: false };
  const last = name.slice(name.lastIndexOf("/") + 1);
  const reasoning =
    hasAny(name, REASONING) || REASONING_START.some((start) => last.startsWith(start)) || (name.includes("claude") && !hasAny(name, CLAUDE_WITHOUT_REASONING));
  return { vision: hasAny(name, VISION), pdf: hasAny(name, PDF), reasoning, chat: true };
}
