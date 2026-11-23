import { describe, expect, it } from "vitest";
import { ABILITY_KEYS, abilitiesOf, inferModelHints, modelHints } from "../src/providers/hints.ts";
import { expectLinear, LOADED_TIMEOUT_MS } from "./helpers/linear.ts";

/**
 * What a model's name says it can do (README "Model providers", `POST /api/providers/:id/models/list`): hints for the
 * owner, who can change them. First from the vendored models.dev snapshot, then by the name rules — each rule with a
 * name it fits and one it does not.
 */

const ALL_LEVELS = ["low", "medium", "high", "xhigh", "max"];
const GPT_6_SOL = { vision: true, pdf: true, reasoning: true, chat: true, known: true, label: "GPT-6 Sol", contextTokens: 1050000, reasoningLevels: ALL_LEVELS, tools: true };
const SONNET = { vision: true, pdf: true, reasoning: true, chat: true, known: true, label: "Claude Sonnet 5.5", contextTokens: 1000000, reasoningLevels: ALL_LEVELS, tools: true };

describe("modelHints: the catalogue first", () => {
  it("an exact id, also behind a vendor prefix, in any case, with spaces around it", () => {
    expect(modelHints("gpt-6-sol")).toEqual(GPT_6_SOL);
    expect(modelHints("openai/gpt-6-sol")).toEqual(GPT_6_SOL);
    expect(modelHints("  OpenRouter/OpenAI/GPT-6-Sol ")).toEqual(GPT_6_SOL);
    expect(modelHints("claude-sonnet-5-5")).toEqual(SONNET);
    // The lab's levels when it has them; a model whose levels are a toggle or a token budget has none listed.
    expect(modelHints("gemini-2.5-pro")).toEqual({ vision: true, pdf: true, reasoning: true, chat: true, known: true, label: "Gemini 2.5 Pro", contextTokens: 1048576, tools: true, audioIn: true, videoIn: true });
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
    expect(modelHints("claude-sonnet-5-5-thinking")).toEqual(SONNET);
    expect(modelHints("gpt-6-sol-free-20261101")).toEqual(GPT_6_SOL);
    // Only at a -: gpt-6-solar is not gpt-6-sol.
    expect(modelHints("gpt-6-solar").label).not.toBe("GPT-6 Sol");
    // Not a variant the name rules call no chat model: a speech or transcription model is not the chat model it starts with.
    for (const name of ["gpt-4o-mini-tts", "gpt-4o-transcribe", "gpt-4o-audio-preview"]) {
      expect([name, modelHints(name)]).toEqual([name, { vision: false, pdf: false, reasoning: false, chat: false, known: false }]);
    }
  });

  it("abilities: tools, audio and video in, image, video and audio out — only as true, only from the catalogue", () => {
    expect(modelHints("deepseek-chat")).toMatchObject({ known: true, tools: true });
    expect(modelHints("dashscope/Qwen-Omni-Turbo")).toMatchObject({ known: true, tools: true, audioIn: true, videoIn: true, audioOut: true });
    expect(modelHints("gemini-2.5-flash-image")).toMatchObject({ known: true, chat: false, imageOut: true });
    expect(modelHints("gemini-omni-1.1-flash")).toMatchObject({ known: true, videoIn: true, videoOut: true });
    // Through the same matching as every hint: a dated name, a variant of a known model.
    expect(modelHints("claude-sonnet-5-5-thinking").tools).toBe(true);
    expect(modelHints("deepseek-chat-latest").tools).toBe(true);
    // What the catalogue does not say is absent, never false: a known model without tool support …
    const plain = modelHints("gemini-embedding-001");
    for (const key of ABILITY_KEYS) expect([key, key in plain]).toEqual([key, false]);
    expect(modelHints("gpt-6-sol")).not.toHaveProperty("audioIn");
    // … and nothing is guessed from a name's wording: a name the catalogue does not know says none of them.
    for (const name of ["my-tools-model", "acme/function-calling-audio-video-omni", "gpt-6", "o4-ultra-custom", "vision-video-in-image-out"]) {
      const unknown = modelHints(name);
      expect([name, unknown.known, ABILITY_KEYS.filter((key) => key in unknown)]).toEqual([name, false, []]);
      expect([name, abilitiesOf(unknown)]).toEqual([name, {}]);
    }
    expect(abilitiesOf(modelHints("qwen-omni-turbo"))).toEqual({ tools: true, audioIn: true, videoIn: true, audioOut: true });
    expect(ABILITY_KEYS).toEqual(["tools", "audioIn", "videoIn", "imageOut", "videoOut", "audioOut"]);
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
