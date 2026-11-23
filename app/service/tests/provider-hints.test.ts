import { describe, expect, it } from "vitest";
import { ABILITY_KEYS, abilitiesOf, inferModelHints, mergedAbilities, modelHints } from "../src/providers/hints.ts";
import { abilitiesIn, entryOf, hintsOf, pick, SNAPSHOT } from "./helpers/catalog.ts";
import { expectLinear, LOADED_TIMEOUT_MS } from "./helpers/linear.ts";

/**
 * What a model's name says it can do (README "Model providers", `POST /api/providers/:id/models/list`): hints for the
 * owner, who can change them. First from the vendored models.dev snapshot, then by the name rules — each rule with a
 * name it fits and one it does not.
 */

// What the snapshot's own entry says (tests/helpers/catalog.ts), not values copied from it: the catalogue is updated daily.
const GPT_6_SOL = hintsOf(entryOf("gpt-6-sol"));
const SONNET = hintsOf(entryOf("claude-sonnet-5-5"));
/** The hints of a known model without what only an exact or undated match answers: what a variant by prefix gets. */
const withoutAbilities = (hints: Record<string, unknown>) => Object.fromEntries(Object.entries(hints).filter(([key]) => !(ABILITY_KEYS as readonly string[]).includes(key)));

describe("modelHints: the catalogue first", () => {
  it("an exact id, also behind a vendor prefix, in any case, with spaces around it", () => {
    expect(modelHints("gpt-6-sol")).toEqual(GPT_6_SOL);
    expect(modelHints("openai/gpt-6-sol")).toEqual(GPT_6_SOL);
    expect(modelHints("  OpenRouter/OpenAI/GPT-6-Sol ")).toEqual(GPT_6_SOL);
    expect(modelHints("claude-sonnet-5-5")).toEqual(SONNET);
    // The lab's levels when it has them; a model whose levels are a toggle or a token budget has none listed.
    expect(modelHints("gemini-2.5-pro")).toEqual(hintsOf(entryOf("gemini-2.5-pro")));
    expect(modelHints("gemini-2.5-pro")).not.toHaveProperty("reasoningLevels");
    expect(modelHints("o3-mini")).toMatchObject({ known: true, reasoning: true, reasoningLevels: ["low", "medium", "high"] });
    expect(modelHints("minimax/MiniMax-M3")).toMatchObject({ known: true, label: "MiniMax-M3", reasoning: true });
    expect(modelHints("minimax/MiniMax-M3")).not.toHaveProperty("reasoningLevels");
  });

  it("without a trailing date or -latest; the catalogue's own dated ids also without their date", () => {
    for (const name of ["claude-sonnet-5-5-20261101", "claude-sonnet-5-5-2026-11-01", "claude-sonnet-5-5-latest", "anthropic/claude-sonnet-5-5-latest"]) expect([name, modelHints(name)]).toEqual([name, SONNET]);
    expect(modelHints("gpt-6-sol-2026-10-01")).toEqual(GPT_6_SOL);
    expect(modelHints("claude-3-5-haiku-20241022")).toMatchObject({ known: true, reasoning: false });
    for (const name of ["claude-3-5-haiku", "claude-3-5-haiku-latest"]) expect([name, modelHints(name).label]).toEqual([name, modelHints("claude-3-5-haiku-20241022").label]);
  });

  it("else the longest id the name starts with, followed by - (a variant of a known model)", () => {
    // The hints its owner edits are the known model's; what is shown as the catalogue's fact (the abilities) is not: see below.
    expect(modelHints("claude-sonnet-5-5-thinking")).toEqual(withoutAbilities(SONNET));
    expect(modelHints("gpt-6-sol-free-20261101")).toEqual(withoutAbilities(GPT_6_SOL));
    // Only at a -: gpt-6-solar is not gpt-6-sol.
    expect(modelHints("gpt-6-solar").label).not.toBe("GPT-6 Sol");
    // Not a variant the name rules call no chat model: a speech or transcription model is not the chat model it starts with.
    for (const name of ["gpt-4o-mini-tts", "gpt-4o-transcribe", "gpt-4o-audio-preview"]) {
      expect([name, modelHints(name)]).toEqual([name, { vision: false, pdf: false, reasoning: false, chat: false, known: false }]);
    }
  });

  it("abilities: reportedTools, audio and video in, image, video and audio out — only as true, only from the catalogue", () => {
    const tools = pick("uses tools", (e) => e.chat && e.tools === true);
    const hears = pick("takes audio", (e) => e.audioIn === true);
    const paints = pick("answers with images", (e) => e.imageOut === true);
    const films = pick("answers with video", (e) => e.videoOut === true);
    const speaks = pick("answers with audio", (e) => e.audioOut === true);
    for (const e of [tools, hears, paints, films, speaks]) {
      expect([e.id, abilitiesOf(modelHints(e.id))]).toEqual([e.id, abilitiesIn(e)]);
      expect([e.id, abilitiesOf(modelHints(`SomeHost/${e.id.toUpperCase()}`))]).toEqual([e.id, abilitiesIn(e)]);
    }
    expect(modelHints(tools.id).reportedTools).toBe(true);
    // The catalogue's word travels as `reportedTools`: a hint never says `tools`, which is what a saved model stores.
    for (const e of SNAPSHOT.slice(0, 120)) expect([e.id, "tools" in modelHints(e.id)]).toEqual([e.id, false]);
    // What the catalogue does not say is absent, never false: a known model without tool support …
    const plain = pick("has no ability", (e) => Object.keys(abilitiesIn(e)).length === 0);
    const hints = modelHints(plain.id);
    expect(hints.known).toBe(true);
    for (const key of ABILITY_KEYS) expect([key, key in hints]).toEqual([key, false]);
    // … and nothing is guessed from a name's wording: a name the catalogue does not know says none of them.
    for (const name of ["my-tools-model", "acme/function-calling-audio-video-omni", "gpt-6", "o4-ultra-custom", "vision-video-in-image-out"]) {
      const unknown = modelHints(name);
      expect([name, unknown.known, ABILITY_KEYS.filter((key) => key in unknown)]).toEqual([name, false, []]);
      expect([name, abilitiesOf(unknown)]).toEqual([name, {}]);
    }
    expect(ABILITY_KEYS).toEqual(["reportedTools", "audioIn", "videoIn", "imageOut", "videoOut", "audioOut"]);
  });

  it("abilities need the model itself: an exact id, or one without its date or -latest — never a mere prefix", () => {
    // Exact and undated: the entry's abilities.
    const dated = entryOf("claude-3-5-haiku-20241022");
    for (const name of ["claude-sonnet-5-5", "claude-sonnet-5-5-20261101", "claude-sonnet-5-5-2026-11-01", "anthropic/claude-sonnet-5-5-latest"]) {
      expect([name, abilitiesOf(modelHints(name))]).toEqual([name, abilitiesIn(entryOf("claude-sonnet-5-5"))]);
    }
    for (const name of ["claude-3-5-haiku-20241022", "claude-3-5-haiku", "claude-3-5-haiku-latest"]) expect([name, abilitiesOf(modelHints(name))]).toEqual([name, abilitiesIn(dated)]);
    expect(abilitiesIn(entryOf("claude-sonnet-5-5")).reportedTools).toBe(true);
    // A prefix: a name the catalogue does not list, starting with an id it does. The base model uses tools; nothing says
    // the variant does (o1-mini never did; a search-preview model calls none; a relay's `gpt-4-all` is its own thing).
    const variants: Array<[string, string]> = [
      ["o1-mini", "o1"],
      ["o1-preview", "o1"],
      ["gpt-4-all", "gpt-4"],
      ["gpt-4-gizmo-g-abc123", "gpt-4"],
      ["gpt-4o-search-preview", "gpt-4o"],
      ["gpt-4o-mini-search-preview", "gpt-4o-mini"],
      ["gemini-2.0-flash-thinking-exp", "gemini-2.0-flash"],
      ["qwen-plus-anything", "qwen-plus"],
      ["qwen-max-longcontext", "qwen-max"],
      ["claude-sonnet-5-5-thinking", "claude-sonnet-5-5"],
      ["deepseek-chat-free-20261101", "deepseek-chat"],
      ["openrouter/openai/gpt-6-sol-free", "gpt-6-sol"],
    ];
    for (const [name, base] of variants) {
      // The table's premise: the variant is not listed itself, and its base says it uses tools.
      expect([name, SNAPSHOT.some((e) => e.id === name.slice(name.lastIndexOf("/") + 1)), entryOf(base).tools]).toEqual([name, false, true]);
      const hints = modelHints(name);
      // Still known by its base for the hints its owner edits (label, vision, reasoning, context) …
      expect([name, hints.known, hints.label]).toEqual([name, true, entryOf(base).name]);
      // … and none of the abilities.
      expect([name, ABILITY_KEYS.filter((key) => key in hints)]).toEqual([name, []]);
    }
  });

  it("an id two labs share has an ability only when every lab's entry says so (mergedAbilities)", () => {
    const merged = mergedAbilities([
      { id: "twin", tools: true, audioIn: true },
      { id: "twin", tools: true, videoOut: true },
      { id: "solo", tools: true, imageOut: true },
      { id: "mute" },
      { id: "half", tools: true },
      { id: "half" },
    ]);
    expect(Object.fromEntries(merged)).toEqual({ twin: { reportedTools: true }, solo: { reportedTools: true, imageOut: true }, mute: {}, half: {} });
    // In the committed snapshot each id's merged abilities are what the hints answer.
    for (const e of SNAPSHOT.slice(0, 60)) expect([e.id, abilitiesOf(modelHints(e.id))]).toEqual([e.id, mergedAbilities(SNAPSHOT).get(e.id)]);
  });

  it("a model the catalogue lists as no chat model is known as such", () => {
    expect(modelHints("gemini-embedding-001")).toMatchObject({ known: true, chat: false });
  });

  it("not found: the name rules, known false, and nothing else", () => {
    for (const name of ["my-private-model", "text-embedding-3-small", "acme/claude-house-blend", "o4-ultra-custom"]) {
      expect([name, modelHints(name)]).toEqual([name, { ...inferModelHints(name), known: false }]);
    }
    expect(modelHints("acme/claude-house-blend")).toEqual({ vision: true, pdf: true, reasoning: true, chat: true, known: false });
  });

  it("takes a long name in time linear in its length", { timeout: LOADED_TIMEOUT_MS }, () => {
    expectLinear({ n: 40, make: (n) => `gpt-${"-".repeat(n)}${"a".repeat(n + 10)}`, run: (name) => void modelHints(name) });
    expectLinear({ n: 40, make: (n) => `claude-sonnet-5-5${"-x".repeat(n)}`, run: (name) => void modelHints(name) });
  });
});

/** The name rules (`inferModelHints`), for names the catalogue does not know. */

const hints = (name: string) => inferModelHints(name);
const CHAT_ONLY = { vision: false, pdf: false, reasoning: false, chat: true };
const NOT_CHAT = { vision: false, pdf: false, reasoning: false, chat: false };

describe("inferModelHints", () => {
  it("a name that says nothing: a chat model that cannot see, read PDFs or reason", () => {
    for (const name of ["llama-3.1-8b-instruct", "mistral-large-latest", "qwen-turbo", "my-model", "gpt-3.5-turbo", "deepseek-chat"]) {
      expect([name, hints(name)]).toEqual([name, CHAT_ONLY]);
    }
  });

  it("not a chat model: embeddings, rerankers, speech, images, video, moderation, music", () => {
    const notChat = [
      "text-embedding-3-small",
      "gemini-embedding-001",
      "bge-reranker-v2",
      "BAAI/bge-m3",
      "jina-rerank-m0",
      "tts-1-hd",
      "gpt-4o-mini-tts",
      "whisper-1",
      "speech-02-hd",
      "gpt-4o-audio-preview",
      "voice-clone",
      "gpt-image-1",
      "dall-e-3",
      "flux-1.1-pro",
      "stable-diffusion-xl",
      "sd-turbo",
      "imagen-4.0-generate-001",
      "midjourney-v7",
      "gemini-2.5-flash-image",
      "video-01",
      "sora-2",
      "veo-3.0-generate-preview",
      "hailuo-02",
      "kling-v2",
      "omni-moderation-latest",
      "music-1.5",
      "gpt-4o-transcribe",
      "gpt-realtime",
    ];
    for (const name of notChat) expect([name, hints(name)]).toEqual([name, NOT_CHAT]);
    // Whatever else the name says: a non-chat model is marked as nothing else either.
    expect(hints("claude-image-thinking")).toEqual(NOT_CHAT);
  });

  it("vision: the GPT-4o, 4.1, 5 and 6 families, Claude, Gemini, and names that say vision or VL", () => {
    for (const name of ["gpt-4o-mini", "chatgpt-4o-latest", "gpt-4.1-nano", "gpt-5-mini", "gpt-6", "claude-sonnet-4-5", "gemini-2.0-flash", "llama-3.2-11b-vision-instruct", "qwen2.5-vl-72b-instruct", "llava-v1.6", "pixtral-large-latest", "glm-4v-plus", "qvq-max"]) {
      expect([name, hints(name).vision]).toEqual([name, true]);
    }
    for (const name of ["gpt-4-turbo", "gpt-3.5-turbo", "qwen-max", "o1-mini", "devil-model"]) expect([name, hints(name).vision]).toEqual([name, false]);
  });

  it("PDF: Claude, Gemini and the GPT-4o, 4.1, 5 and 6 families", () => {
    for (const name of ["claude-opus-4-1", "gemini-2.5-pro", "gpt-4o", "gpt-4.1", "gpt-5", "gpt-6-pro"]) expect([name, hints(name).pdf]).toEqual([name, true]);
    for (const name of ["llama-3.2-90b-vision", "qwen2.5-vl-7b", "gpt-4-turbo", "deepseek-reasoner"]) expect([name, hints(name).pdf]).toEqual([name, false]);
  });

  it("reasoning: GPT-5 and 6, o1/o3/o4, recent Claude, Gemini 2.5 and 3, and names that say they think or reason", () => {
    const reasons = [
      "gpt-5",
      "gpt-6-mini",
      "o1",
      "o3-mini",
      "o4-mini-high",
      "openai/o3",
      "claude-sonnet-4-5",
      "claude-3-7-sonnet-20250219",
      "claude-opus-4-1",
      "gemini-2.5-flash",
      "gemini-3-pro-preview",
      "kimi-k2-thinking",
      "deepseek-reasoner",
      "deepseek-r1-distill-qwen-32b",
      "qwq-32b",
      "MiniMax-M2",
      "minimax-m3",
      "GPT-5-MINI",
    ];
    for (const name of reasons) expect([name, hints(name).reasoning]).toEqual([name, true]);
    const not = [
      "gpt-4o",
      "gpt-4.1",
      "claude-2.1",
      "claude-instant-1.2",
      "claude-3-haiku-20240307",
      "claude-3-opus-20240229",
      "claude-3-sonnet-20240229",
      "claude-3-5-sonnet-20241022",
      "claude-3.5-haiku",
      "gemini-2.0-flash",
      "gemini-1.5-pro",
      "deepseek-chat",
      "pro1-model",
      "my-o3-copy",
    ];
    for (const name of not) expect([name, hints(name).reasoning]).toEqual([name, false]);
  });

  it("ignores case, and takes a long name in time linear in its length", { timeout: LOADED_TIMEOUT_MS }, () => {
    expect(hints("CLAUDE-SONNET-4")).toEqual({ vision: true, pdf: true, reasoning: true, chat: true });
    expect(hints("Text-Embedding-Ada-002")).toEqual(NOT_CHAT);
    // Four times the name, about four times the time (`expectLinear`, helpers/linear.ts), not a number of milliseconds.
    expectLinear({ n: 50, make: (n) => `${"-".repeat(n)}${"o".repeat(n)}`, run: (name) => void hints(name) });
  });
});
