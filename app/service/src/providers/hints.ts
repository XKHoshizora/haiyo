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
 * name's wording): `tools` (its replies can call tools), `audioIn` / `videoIn` (takes audio, video), `imageOut` /
 * `videoOut` / `audioOut` (answers with images, video, audio).
 */
export const ABILITY_KEYS = ["tools", "audioIn", "videoIn", "imageOut", "videoOut", "audioOut"] as const;
export type Abilities = { [K in (typeof ABILITY_KEYS)[number]]?: true };
/** The abilities among `from`'s keys (a catalogue entry's, a `ModelHints`'), and nothing else of it. */
export function abilitiesOf(from: Abilities): Abilities {
  const out: Abilities = {};
  for (const key of ABILITY_KEYS) if (from[key] === true) out[key] = true;
  return out;
}

/**
 * What only the catalogue says a model takes and answers with (`ABILITY_KEYS` without `tools`), each only as
 * `true`, only for a name it knows: as the routes answer it — on a saved model, on a listed one (providers/routes.ts), and on a site model (`GET /api/models`).
 */
export const mediaView = {
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
  /** The levels the model's own lab offers, when the catalogue has them (known models only). */
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

const CATALOG: CatalogEntry[] = z.array(catalogEntry).parse(catalogFile);
for (const entry of CATALOG) index(entry.id, entry);
// The catalogue's own dated and `-latest` ids are found without those too, where no other id is spelt so.
for (const entry of CATALOG) index(undated(entry.id), entry);

/**
 * What the name says the model can do. The name is trimmed and lower-cased, and only its last `/` part counts
 * (`openai/gpt-6-sol` is `gpt-6-sol`). Found in the catalogue as it is; else without a trailing `-latest` and date; else
 * by the longest id it starts with, followed by `-` (`claude-sonnet-5-5-thinking` is `claude-sonnet-5-5`) — unless the
 * name rules call it no chat model (`gpt-4o-mini-tts` is not `gpt-4o-mini`). Not found: the name rules, `known: false`,
 * and none of the abilities (`ABILITY_KEYS`), which only the catalogue's entry answers.
 */
export function modelHints(raw: string): ModelHints {
  const lower = raw.trim().toLowerCase();
  const name = lower.slice(lower.lastIndexOf("/") + 1);
  const short = undated(name);
  const guessed = inferModelHints(name);
  let entry = at(name) ?? at(short);
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
    ...(entry.reasoningLevels === undefined ? {} : { reasoningLevels: entry.reasoningLevels }),
    ...abilitiesOf(entry),
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
