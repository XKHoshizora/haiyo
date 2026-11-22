import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PROTOCOLS, REASONING_LEVELS, type Protocol } from "../src/config.ts";
import { createModelGateway, MAX_REMEMBERED_UPSTREAMS, ModelError, REASONING_PARAMS, Refusals, type ModelCall, type ModelEvent } from "../src/models/gateway.ts";
import { createSlots } from "../src/slots.ts";
import { PNG } from "./helpers/agents.ts";
import {
  answerCanned,
  cannedStream,
  CANNED_REASONING,
  CANNED_REASONING_USAGE,
  CANNED_TEXT,
  CANNED_USAGE,
  protocolStub,
  STUB_MODEL,
  type ProtocolStub,
  type StubRequest,
} from "./helpers/models.ts";

/**
 * The model gateway against a local stub of each protocol's streaming endpoint (real wire formats, parsed by the AI
 * SDK), reached through the address guard with `allowInsecureLocal`.
 */

const KEY = "sk-stub-0123456789abcdef";
const SYSTEM = "You are a stub's Agent.";
const PDF = Buffer.from("%PDF-1.4\n1 0 obj <<>> endobj\ntrailer <<>>\n%%EOF\n");
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

let stub: ProtocolStub;
beforeAll(async () => {
  stub = await protocolStub();
});
afterAll(async () => {
  await stub.close();
});
beforeEach(() => stub.reset());

const gateway = createModelGateway({ calls: createSlots(64), allowInsecureLocal: true });

function call(protocol: Protocol, over: Partial<ModelCall> = {}): ModelCall {
  return {
    protocol,
    baseUrl: stub.baseUrl,
    apiKey: KEY,
    model: STUB_MODEL,
    system: SYSTEM,
    messages: [{ role: "user", parts: [{ type: "text", text: "Hi" }] }],
    reasoning: "none",
    maxOutputTokens: 256,
    signal: new AbortController().signal,
    ...over,
  };
}

async function collect(events: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

const deltas = (events: ModelEvent[], type: "text" | "reasoning") =>
  events.flatMap((e) => (e.type === type ? [e.delta] : []));

/** The one request the stub received. */
function onlyRequest() {
  expect(stub.requests).toHaveLength(1);
  return stub.requests[0]!;
}

/** Where each protocol's streaming request goes, below the baseUrl `http://127.0.0.1:<port>/v1`. */
const PATH: Record<Protocol, string> = {
  openai_chat: "/v1/chat/completions",
  openai_responses: "/v1/responses",
  anthropic: "/v1/messages",
  gemini: `/v1/models/${STUB_MODEL}:streamGenerateContent?alt=sse`,
};

/** How each protocol presents the key. */
const KEY_HEADERS: Record<Protocol, Record<string, string>> = {
  openai_chat: { authorization: `Bearer ${KEY}` },
  openai_responses: { authorization: `Bearer ${KEY}` },
  anthropic: { "x-api-key": KEY, "anthropic-version": "2023-06-01" },
  gemini: { "x-goog-api-key": KEY },
};

describe.each(PROTOCOLS)("%s", (protocol) => {
  it("streams the canned answer as text deltas, then one finish with the canned usage", async () => {
    const events = await collect(gateway.stream(call(protocol)));
    expect(deltas(events, "text").join("")).toBe(CANNED_TEXT);
    expect(deltas(events, "text").length).toBeGreaterThan(1);
    expect(deltas(events, "reasoning")).toEqual([]);
    expect(events.at(-1)).toEqual({ type: "finish", usage: CANNED_USAGE, truncated: false, toolCalls: [], assistant: expect.anything() });
    expect(events.filter((e) => e.type === "finish")).toHaveLength(1);
  });

  it("sends to the protocol's path, with the key in the protocol's header and nowhere in the URL", async () => {
    await collect(gateway.stream(call(protocol)));
    const req = onlyRequest();
    expect(req.method).toBe("POST");
    expect(req.path).toBe(PATH[protocol]);
    expect(req.headers).toMatchObject(KEY_HEADERS[protocol]);
    expect(req.path).not.toContain(KEY);
  });

  it("carries the system text, an earlier assistant turn, an image, a PDF and the output limit in the protocol's shape", async () => {
    await collect(
      gateway.stream(
        call(protocol, {
          messages: [
            {
              role: "user",
              parts: [
                { type: "text", text: "Look at these" },
                { type: "image", mime: "image/png", data: PNG },
                { type: "file", mime: "application/pdf", name: "notes.pdf", data: PDF },
              ],
            },
            { role: "assistant", parts: [{ type: "text", text: "An earlier answer" }] },
            { role: "user", parts: [{ type: "text", text: "And now?" }] },
          ],
        }),
      ),
    );
    const { body } = onlyRequest();
    const image = `data:image/png;base64,${b64(PNG)}`;
    const pdf = `data:application/pdf;base64,${b64(PDF)}`;
    switch (protocol) {
      case "openai_chat":
        expect(body).toMatchObject({ model: STUB_MODEL, stream: true, max_tokens: 256 });
        expect(body.messages).toEqual([
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: [
              { type: "text", text: "Look at these" },
              { type: "image_url", image_url: { url: image } },
              { type: "file", file: { filename: "notes.pdf", file_data: pdf } },
            ],
          },
          { role: "assistant", content: "An earlier answer" },
          { role: "user", content: "And now?" },
        ]);
        break;
      case "openai_responses":
        expect(body).toMatchObject({ model: STUB_MODEL, stream: true, max_output_tokens: 256 });
        expect(body.input).toEqual([
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: [
              { type: "input_text", text: "Look at these" },
              { type: "input_image", image_url: image },
              { type: "input_file", filename: "notes.pdf", file_data: pdf },
            ],
          },
          { role: "assistant", content: "An earlier answer" }, // an "easy input message": text as a plain string
          { role: "user", content: [{ type: "input_text", text: "And now?" }] },
        ]);
        break;
      case "anthropic":
        expect(body).toMatchObject({ model: STUB_MODEL, stream: true, max_tokens: 256 });
        expect(body.system).toEqual([{ type: "text", text: SYSTEM }]);
        expect(body.messages).toEqual([
          {
            role: "user",
            content: [
              { type: "text", text: "Look at these" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: b64(PNG) } },
              { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64(PDF) }, title: "notes.pdf" },
            ],
          },
          { role: "assistant", content: [{ type: "text", text: "An earlier answer" }] },
          { role: "user", content: [{ type: "text", text: "And now?" }] },
        ]);
        break;
      case "gemini":
        expect(body.generationConfig).toMatchObject({ maxOutputTokens: 256 });
        expect(body.systemInstruction).toEqual({ parts: [{ text: SYSTEM }] });
        expect(body.contents).toEqual([
          {
            role: "user",
            parts: [
              { text: "Look at these" },
              { inlineData: { mimeType: "image/png", data: b64(PNG) } },
              { inlineData: { mimeType: "application/pdf", data: b64(PDF) } },
            ],
          },
          { role: "model", parts: [{ text: "An earlier answer" }] },
          { role: "user", parts: [{ text: "And now?" }] },
        ]);
        break;
    }
  });

  it.each(REASONING_LEVELS)("reasoning %s: the request carries exactly REASONING_PARAMS for it", async (level) => {
    await collect(gateway.stream(call(protocol, { reasoning: level })));
    expect(reasoningFields(protocol, onlyRequest().body)).toEqual(onTheWire(protocol, REASONING_PARAMS[protocol][level]));
  });

  it("a model that stops for length finishes truncated, after the text it gave", async () => {
    stub.answer((req, res) => answerCanned(req, res, "length"));
    const events = await collect(gateway.stream(call(protocol)));
    expect(deltas(events, "text").join("")).toBe(CANNED_TEXT);
    expect(events.at(-1)).toEqual({ type: "finish", usage: CANNED_USAGE, truncated: true, toolCalls: [], assistant: expect.anything() });
  });

  // Chat Completions: its `reasoning_content`, which the SDK does not read, is read off the stream by the gateway.
  it("a reasoning stream arrives as reasoning deltas before the text; reasoning tokens count as output", async () => {
    stub.answer((req, res) => answerCanned(req, res, "reasoning"));
    const events = await collect(gateway.stream(call(protocol, { reasoning: "high" })));
    expect(deltas(events, "reasoning").join("")).toBe(CANNED_REASONING);
    expect(deltas(events, "text").join("")).toBe(CANNED_TEXT);
    const firstText = events.findIndex((e) => e.type === "text");
    const lastReasoning = events.findLastIndex((e) => e.type === "reasoning");
    expect(lastReasoning).toBeLessThan(firstText);
    expect(events.at(-1)).toEqual({ type: "finish", usage: CANNED_REASONING_USAGE, truncated: false, toolCalls: [], assistant: expect.anything() });
  });
});

// --- Chat Completions reasoning: a delta's own field, or <think> at the start of the answer --------------------------

/** One Chat Completions chunk event carrying `delta` (and a finish reason). */
const chatChunk = (delta: object, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: "chatcmpl-x", object: "chat.completion.chunk", created: 1, model: STUB_MODEL, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
/** A Chat Completions event stream: an opening chunk, `deltas`, the finish, the usage. */
function chatEvents(deltas: object[], finish = "stop", usage: object = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }): string {
  const tail = `data: ${JSON.stringify({ id: "chatcmpl-x", object: "chat.completion.chunk", created: 1, model: STUB_MODEL, choices: [], usage })}\n\n`;
  return [chatChunk({ role: "assistant", content: "" }), ...deltas.map((d) => chatChunk(d)), chatChunk({}, finish), tail, "data: [DONE]\n\n"].join("");
}
const streaming = (body: string) => (_req: unknown, res: import("node:http").ServerResponse) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(body);
};
/** The events but the finish, consecutive deltas of one type joined: what a reader sees, however it was cut. */
function runs(events: ModelEvent[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const e of events) {
    if (e.type === "finish" || e.type === "tool_call" || e.type === "replay_lowered") continue;
    const last = out.at(-1);
    if (last && last[0] === e.type) last[1] += e.delta;
    else out.push([e.type, e.delta]);
  }
  return out;
}
const chatRuns = async (deltas: object[]) => {
  stub.answer(streaming(chatEvents(deltas)));
  return runs(await collect(gateway.stream(call("openai_chat", { reasoning: "high" }))));
};
const text = (content: string) => ({ content });

describe("Chat Completions reasoning", () => {
  it("reasoning_content, or reasoning as a string, becomes reasoning, in its place among the text and never in it", async () => {
    expect(await chatRuns([{ reasoning_content: "A" }, text("X"), { reasoning_content: "B" }, text("Y")])).toEqual([
      ["reasoning", "A"],
      ["text", "X"],
      ["reasoning", "B"],
      ["text", "Y"],
    ]);
    expect(await chatRuns([{ reasoning: "via reasoning" }, { reasoning: { not: "a string" } }, text("Done.")])).toEqual([
      ["reasoning", "via reasoning"],
      ["text", "Done."],
    ]);
    // One delta with both: the reasoning first; with both fields, reasoning_content only.
    expect(await chatRuns([{ reasoning_content: "R", reasoning: "R", content: "C" }])).toEqual([
      ["reasoning", "R"],
      ["text", "C"],
    ]);
  });

  it("reasoning shows while the model still thinks: before any of the answer was sent", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    stub.answer(async (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(chatChunk({ role: "assistant", content: "" }) + chatChunk({ reasoning_content: "Let me think" }));
      await gate;
      res.end(chatEvents([text("Answer.")]).split("\n\n").slice(1).join("\n\n"));
    });
    const iterator = gateway.stream(call("openai_chat", { reasoning: "high" }))[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ type: "reasoning", delta: "Let me think" });
    release();
    const rest: ModelEvent[] = [];
    for (let r = await iterator.next(); !r.done; r = await iterator.next()) rest.push(r.value);
    expect(runs(rest)).toEqual([["text", "Answer."]]);
    expect(rest.at(-1)).toMatchObject({ type: "finish", truncated: false });
  });

  it("a stream with CRLF line ends, arriving a few bytes at a time, is read the same", async () => {
    const body = cannedStream("openai_chat", "reasoning").replaceAll("\n", "\r\n");
    stub.answer(async (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (let i = 0; i < body.length; i += 5) {
        res.write(body.slice(i, i + 5));
        await new Promise((r) => setImmediate(r));
      }
      res.end();
    });
    const events = await collect(gateway.stream(call("openai_chat", { reasoning: "high" })));
    expect(runs(events)).toEqual([
      ["reasoning", CANNED_REASONING],
      ["text", CANNED_TEXT],
    ]);
  });

  it("an answer that opens with <think> has the block taken out as reasoning, the tags cut anywhere between deltas", async () => {
    expect(await chatRuns([text("  <thi"), text("nk>Pondering"), text(" deeply</th"), text("ink>\n\nThe answer"), text(" is 42.")])).toEqual([
      ["reasoning", "Pondering deeply"],
      ["text", "The answer is 42."],
    ]);
    expect(await chatRuns([text("<"), text("t"), text("hink>a<"), text("/thinking about it</think>"), text("ok")])).toEqual([
      ["reasoning", "a</thinking about it"],
      ["text", "ok"],
    ]);
  });

  it("an unclosed <think>: everything after it is reasoning", async () => {
    expect(await chatRuns([text("<think>still"), text(" going </thi")])).toEqual([["reasoning", "still going </thi"]]);
  });

  it("an empty <think></think> block leaves the answer alone", async () => {
    expect(await chatRuns([text("<think></think>"), text("Answer")])).toEqual([["text", "Answer"]]);
  });

  it("a <think> anywhere but at the start is text, and so is a start that only looks like one", async () => {
    expect(await chatRuns([text("Use <think>"), text("tags</think> like this")])).toEqual([["text", "Use <think>tags</think> like this"]]);
    expect(await chatRuns([text("<thi"), text("s is text")])).toEqual([["text", "<this is text"]]);
    expect(await chatRuns([text("\n"), text("Hello")])).toEqual([["text", "\nHello"]]);
  });

  it("with reasoning in the protocol's own field first, <think> in the text is left as text", async () => {
    expect(await chatRuns([{ reasoning_content: "real thought" }, text("<think>x</think>y")])).toEqual([
      ["reasoning", "real thought"],
      ["text", "<think>x</think>y"],
    ]);
  });

  it("other protocols' text is never looked at for <think>", async () => {
    stub.answer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(cannedStream("anthropic", "text").replace('"text":"Hello"', '"text":"<think>Hello</think>"'));
    });
    const events = await collect(gateway.stream(call("anthropic")));
    expect(runs(events)).toEqual([["text", `<think>Hello</think>${CANNED_TEXT.slice("Hello".length)}`]]);
  });
});

const pick = (from: any, keys: string[]) => Object.fromEntries(keys.filter((k) => from?.[k] !== undefined).map((k) => [k, from[k]]));

describe("what each protocol is sent, per level: the call's output limit as it is, the effort, the thinking switch, the summary", () => {
  // A limit as resolveModel makes one at a level (the reply's 2 048 and high's 12 000): the gateway adds nothing to it.
  const LIMIT = 14_048;
  it.each(REASONING_LEVELS)("reasoning %s", async (level) => {
    const sent = async (protocol: Protocol, over: Partial<ModelCall> = {}) => {
      stub.reset();
      await collect(gateway.stream(call(protocol, { reasoning: level, maxOutputTokens: LIMIT, ...over })));
      return onlyRequest().body;
    };
    const capped = level === "max" ? "xhigh" : level; // Chat Completions and Gemini have no max
    const CHAT = ["max_tokens", "max_completion_tokens", "reasoning_effort", "thinking"];
    expect(pick(await sent("openai_chat"), CHAT)).toEqual(level === "none" ? { max_tokens: LIMIT } : { max_completion_tokens: LIMIT, reasoning_effort: capped });
    // The thinking switch: disabled at none; enabled at a level, next to the level's own effort.
    expect(pick(await sent("openai_chat", { thinkingSwitch: true }), CHAT)).toEqual(
      level === "none"
        ? { max_tokens: LIMIT, thinking: { type: "disabled" } }
        : { max_completion_tokens: LIMIT, reasoning_effort: capped, thinking: { type: "enabled" } },
    );
    expect(pick(await sent("openai_chat", { thinkingSwitch: false }), CHAT)).not.toHaveProperty("thinking");
    // The other protocols are sent the same with or without the switch; at none, exactly as before.
    for (const over of [{}, { thinkingSwitch: true }]) {
      const responses = await sent("openai_responses", over);
      expect(pick(responses, ["max_output_tokens", "reasoning", "thinking"])).toEqual(
        level === "none" ? { max_output_tokens: LIMIT } : { max_output_tokens: LIMIT, reasoning: { effort: level, summary: "auto" } },
      );
      expect(pick(await sent("anthropic", over), ["max_tokens", "thinking", "output_config"])).toEqual(
        level === "none"
          ? { max_tokens: LIMIT, thinking: { type: "disabled" } }
          : { max_tokens: LIMIT, thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: level } },
      );
      const gemini = await sent("gemini", over);
      expect(gemini).not.toHaveProperty("thinking");
      expect(pick(gemini.generationConfig, ["maxOutputTokens", "thinkingConfig"])).toEqual(
        level === "none" ? { maxOutputTokens: LIMIT } : { maxOutputTokens: LIMIT, thinkingConfig: { thinkingLevel: capped, includeThoughts: true } },
      );
    }
  });
});

describe("an optional field the upstream refuses (the thinking switch, the reasoning summary)", () => {
  /** A 400 naming the field to a request that carries it (`carries`), else the canned stream. */
  const refusing = (carries: (body: any) => boolean, message: string) => (req: StubRequest, res: import("node:http").ServerResponse) => {
    if (!carries(req.body)) return answerCanned(req, res);
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message, type: "invalid_request_error", param: null, code: null } }));
  };
  const withoutThinking = (body: any) => {
    const { thinking: _, ...rest } = body;
    return rest;
  };
  const answered = (events: ModelEvent[]) => deltas(events, "text").join("") === CANNED_TEXT && events.at(-1)?.type === "finish";

  it("Chat Completions: a 400 naming `thinking` is asked once more without it, and that upstream's later calls leave it out", async () => {
    stub.answer(refusing((b) => "thinking" in b, "Unrecognized request argument supplied: thinking"));
    const upstreamId = "provider:refuses-thinking";
    expect(answered(await collect(gateway.stream(call("openai_chat", { thinkingSwitch: true, upstreamId }))))).toBe(true);
    expect(stub.requests.map((r) => r.body.thinking)).toEqual([{ type: "disabled" }, undefined]);
    expect(withoutThinking(stub.requests[0]!.body)).toEqual(stub.requests[1]!.body); // otherwise the same request

    stub.requests.length = 0;
    expect(answered(await collect(gateway.stream(call("openai_chat", { thinkingSwitch: true, upstreamId, reasoning: "high" }))))).toBe(true);
    expect(stub.requests.map((r) => [r.body.thinking, r.body.reasoning_effort])).toEqual([[undefined, "high"]]);

    // Another upstream is asked with it; a call naming no upstream is retried every time and nothing is remembered.
    stub.requests.length = 0;
    expect(answered(await collect(gateway.stream(call("openai_chat", { thinkingSwitch: true, upstreamId: "provider:other" }))))).toBe(true);
    expect(answered(await collect(gateway.stream(call("openai_chat", { thinkingSwitch: true }))))).toBe(true);
    expect(answered(await collect(gateway.stream(call("openai_chat", { thinkingSwitch: true }))))).toBe(true);
    expect(stub.requests.map((r) => r.body.thinking?.type ?? null)).toEqual(["disabled", null, "disabled", null, "disabled", null]);
  });

  it("Responses: a 400 naming the summary is asked once more with the effort alone, and that upstream's later calls ask for none", async () => {
    stub.answer(
      refusing(
        (b) => b.reasoning?.summary !== undefined,
        "Your organization must be verified to generate reasoning summaries. Unsupported value: 'reasoning.summary'",
      ),
    );
    const upstreamId = "site:responses-no-summary";
    expect(answered(await collect(gateway.stream(call("openai_responses", { reasoning: "high", upstreamId }))))).toBe(true);
    expect(stub.requests.map((r) => r.body.reasoning)).toEqual([{ effort: "high", summary: "auto" }, { effort: "high" }]);
    stub.requests.length = 0;
    expect(answered(await collect(gateway.stream(call("openai_responses", { reasoning: "low", upstreamId }))))).toBe(true);
    expect(stub.requests.map((r) => r.body.reasoning)).toEqual([{ effort: "low" }]);
  });

  it("a 422 naming the field is taken as a 400 is: asked once more without it, then left out", async () => {
    stub.answer((req, res) => {
      if (!("thinking" in req.body)) return answerCanned(req, res);
      res.writeHead(422, { "content-type": "application/json" });
      res.end(JSON.stringify({ detail: [{ loc: ["body", "thinking"], msg: "Extra inputs are not permitted", type: "extra_forbidden" }] }));
    });
    const upstreamId = "provider:strict@https://strict.example.test/v1";
    expect(answered(await collect(gateway.stream(call("openai_chat", { thinkingSwitch: true, upstreamId }))))).toBe(true);
    expect(answered(await collect(gateway.stream(call("openai_chat", { thinkingSwitch: true, upstreamId }))))).toBe(true);
    expect(stub.requests.map((r) => r.body.thinking?.type ?? null)).toEqual(["disabled", null, null]);
  });

  it("a 400 or 422 that does not name the field, another status, or a field the call did not send: answered once, not retried", async () => {
    for (const [status, message, over] of [
      [400, "max_tokens is too large", { thinkingSwitch: true }],
      [422, "max_tokens is too large", { thinkingSwitch: true }],
      [500, "Unrecognized request argument supplied: thinking", { thinkingSwitch: true }],
      [400, "Unrecognized request argument supplied: thinking", {}],
    ] as const) {
      stub.reset();
      stub.answer((_req, res) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message } }));
      });
      const error = await collect(gateway.stream(call("openai_chat", { ...over, upstreamId: `provider:once-${status}` }))).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toMatchObject({ code: "provider_unavailable", upstreamStatus: status });
      expect(stub.requests).toHaveLength(1);
    }
  });

  it("asked once more at most: a refusal of the retry too is the call's failure, and nothing is remembered", async () => {
    stub.answer((_req, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "thinking is not supported here" } }));
    });
    const failed = (over: Partial<ModelCall>) =>
      collect(gateway.stream(call("openai_chat", { thinkingSwitch: true, ...over }))).then(
        () => null,
        (e: unknown) => e,
      );
    const error = await failed({ upstreamId: "provider:refuses-all" });
    expect(error).toBeInstanceOf(ModelError);
    expect(error).toMatchObject({ code: "provider_unavailable", upstreamStatus: 400 });
    expect(stub.requests.map((r) => r.body.thinking?.type ?? null)).toEqual(["disabled", null]);
    // Leaving the field out did not help: it is still sent on the upstream's next call.
    expect(await failed({ upstreamId: "provider:refuses-all" })).toMatchObject({ upstreamStatus: 400 });
    expect(stub.requests.map((r) => r.body.thinking?.type ?? null)).toEqual(["disabled", null, "disabled", null]);
  });

  it("remembered only once the retry is answered: a retry that fails for another reason leaves the field in the next call", async () => {
    const statuses = [400, 503, 400, 200, 200];
    stub.answer((req, res) => {
      const status = statuses.shift()!;
      if (status === 200) return answerCanned(req, res);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: status === 400 ? "Unrecognized request argument supplied: thinking" : "overloaded" } }));
    });
    const upstreamId = "provider:flaky@https://flaky.example.test/v1";
    const first = await collect(gateway.stream(call("openai_chat", { thinkingSwitch: true, upstreamId }))).then(
      () => null,
      (e: unknown) => e,
    );
    expect(first).toMatchObject({ code: "provider_unavailable", upstreamStatus: 503 });
    // Asked with it again: refused, the retry answered — and from then on it is left out.
    expect(answered(await collect(gateway.stream(call("openai_chat", { thinkingSwitch: true, upstreamId }))))).toBe(true);
    expect(answered(await collect(gateway.stream(call("openai_chat", { thinkingSwitch: true, upstreamId }))))).toBe(true);
    expect(stub.requests.map((r) => r.body.thinking?.type ?? null)).toEqual(["disabled", null, "disabled", null, null]);
  });

  it("what upstreams refused is remembered for at most MAX_REMEMBERED_UPSTREAMS of them, the one used longest ago forgotten first", () => {
    const refusals = new Refusals();
    refusals.add("provider:first", "thinking");
    for (let i = 1; i < MAX_REMEMBERED_UPSTREAMS; i++) refusals.add(`provider:${i}`, "summary");
    expect([...refusals.of("provider:first")]).toEqual(["thinking"]); // used: now the most recent
    refusals.add("provider:new", "thinking");
    expect([...refusals.of("provider:first")]).toEqual(["thinking"]);
    expect([...refusals.of("provider:1")]).toEqual([]); // the one used longest ago
    expect([...refusals.of("provider:2")]).toEqual(["summary"]);
    refusals.add(undefined, "thinking");
    expect([...refusals.of(undefined)]).toEqual([]);
  });
});

describe("nothing is kept at OpenAI", () => {
  it.each(REASONING_LEVELS)("reasoning %s: a Responses request carries store: false (Chat Completions has no such field)", async (level) => {
    await collect(gateway.stream(call("openai_responses", { reasoning: level })));
    const { body } = onlyRequest();
    expect(body.store).toBe(false);
    expect(body).not.toHaveProperty("previous_response_id");
    expect(body.include ?? []).toEqual(level === "none" ? [] : ["reasoning.encrypted_content"]);
    stub.reset();
    await collect(gateway.stream(call("openai_chat", { reasoning: level })));
    expect(onlyRequest().body).not.toHaveProperty("store");
  });
});

describe("fallback: with a reasoning level an OpenAI model is sent as one that reasons", () => {
  it("openai_chat: at none the system text is a system message and the limit max_tokens; at high a developer message and max_completion_tokens", async () => {
    await collect(gateway.stream(call("openai_chat", { reasoning: "none" })));
    let { body } = onlyRequest();
    expect(body.messages[0]).toEqual({ role: "system", content: SYSTEM });
    expect(body.max_tokens).toBe(256);
    expect(body).not.toHaveProperty("max_completion_tokens");

    stub.reset();
    await collect(gateway.stream(call("openai_chat", { reasoning: "high" })));
    ({ body } = onlyRequest());
    expect(body.messages[0]).toEqual({ role: "developer", content: SYSTEM });
    expect(body.max_completion_tokens).toBe(256);
    expect(body).not.toHaveProperty("max_tokens");
  });

  it("openai_responses: at none the system text is a system message, at high a developer message; the limit is max_output_tokens either way", async () => {
    await collect(gateway.stream(call("openai_responses", { reasoning: "none" })));
    let { body } = onlyRequest();
    expect(body.input[0]).toEqual({ role: "system", content: SYSTEM });
    expect(body.max_output_tokens).toBe(256);

    stub.reset();
    await collect(gateway.stream(call("openai_responses", { reasoning: "high" })));
    ({ body } = onlyRequest());
    expect(body.input[0]).toEqual({ role: "developer", content: SYSTEM });
    expect(body.max_output_tokens).toBe(256);
  });
});

describe("fallback: an assistant turn is text only", () => {
  it("a file in it is sent as [文件：{name}], an image as [图片]", async () => {
    await collect(
      gateway.stream(
        call("anthropic", {
          messages: [
            { role: "user", parts: [{ type: "text", text: "Send me the notes" }] },
            {
              role: "assistant",
              parts: [
                { type: "text", text: "Here:" },
                { type: "file", mime: "application/pdf", name: "notes.pdf", data: PDF },
                { type: "image", mime: "image/png", data: PNG },
              ],
            },
            { role: "user", parts: [{ type: "text", text: "Thanks" }] },
          ],
        }),
      ),
    );
    expect(onlyRequest().body.messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "Here:" },
        { type: "text", text: "[文件：notes.pdf]" },
        { type: "text", text: "[图片]" },
      ],
    });
  });
});

describe("REASONING_PARAMS (one table: provider options per protocol and level)", () => {
  it("covers every level of every protocol; a level a protocol cannot express is its nearest lower one; none disables or is omitted", () => {
    const openai = (effort: string, summary?: string) => ({ openai: { reasoningEffort: effort, ...(summary ? { reasoningSummary: summary } : {}), forceReasoning: true } });
    const anthropic = (effort: string) => ({ anthropic: { thinking: { type: "adaptive", display: "summarized" }, effort } });
    const gemini = (level: string) => ({ google: { thinkingConfig: { thinkingLevel: level, includeThoughts: true } } });
    expect(REASONING_PARAMS).toEqual({
      // `reasoning_effort` is refused by OpenAI models that do not reason, and those are sent `none`: it is left out.
      openai_chat: { none: {}, low: openai("low"), medium: openai("medium"), high: openai("high"), xhigh: openai("xhigh"), max: openai("xhigh") },
      openai_responses: {
        none: {},
        low: openai("low", "auto"),
        medium: openai("medium", "auto"),
        high: openai("high", "auto"),
        xhigh: openai("xhigh", "auto"),
        max: openai("max", "auto"),
      },
      anthropic: {
        none: { anthropic: { thinking: { type: "disabled" } } },
        low: anthropic("low"),
        medium: anthropic("medium"),
        high: anthropic("high"),
        xhigh: anthropic("xhigh"),
        max: anthropic("max"),
      },
      // Gemini's thinking levels cannot switch thinking off: none leaves the option out.
      gemini: { none: {}, low: gemini("low"), medium: gemini("medium"), high: gemini("high"), xhigh: gemini("xhigh"), max: gemini("xhigh") },
    });
  });
});

describe("listModels", () => {
  it("is the provider probe's model list: one GET {baseUrl}/models with the protocol's key header", async () => {
    stub.answer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "alpha" }, { id: "beta" }] }));
    });
    expect(await gateway.listModels({ protocol: "openai_chat", baseUrl: stub.baseUrl, apiKey: KEY })).toEqual(["alpha", "beta"]);
    const req = onlyRequest();
    expect([req.method, req.path, req.headers.authorization]).toEqual(["GET", "/v1/models", `Bearer ${KEY}`]);
  });

  it("fails with a ModelError: 401 is provider_rejected", async () => {
    stub.answer((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `bad key ${KEY}` } }));
    });
    const error = await gateway.listModels({ protocol: "anthropic", baseUrl: stub.baseUrl, apiKey: KEY }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ModelError);
    expect(error).toMatchObject({ code: "provider_rejected", upstreamStatus: 401 });
    expect(String((error as Error).message)).not.toContain(KEY);
  });
});

// --- what each protocol's reasoning settings look like on the wire --------------------------------------------------

/** The fields of a request body that carry reasoning settings, as sent. */
function reasoningFields(protocol: Protocol, body: any): Record<string, unknown> {
  const pick = (from: any, keys: string[]) => Object.fromEntries(keys.filter((k) => from?.[k] !== undefined).map((k) => [k, from[k]]));
  switch (protocol) {
    case "openai_chat":
      return pick(body, ["reasoning_effort"]);
    case "openai_responses":
      return pick(body, ["reasoning"]);
    case "anthropic":
      return pick(body, ["thinking", "output_config"]);
    case "gemini":
      return pick(body.generationConfig, ["thinkingConfig"]);
  }
}

/** What provider options become on the wire, as the provider packages document it. */
function onTheWire(protocol: Protocol, params: any): Record<string, unknown> {
  switch (protocol) {
    case "openai_chat":
      return params.openai?.reasoningEffort === undefined ? {} : { reasoning_effort: params.openai.reasoningEffort };
    case "openai_responses":
      return params.openai?.reasoningEffort === undefined
        ? {}
        : { reasoning: { effort: params.openai.reasoningEffort, summary: params.openai.reasoningSummary } };
    case "anthropic":
      return {
        ...(params.anthropic?.thinking ? { thinking: params.anthropic.thinking } : {}),
        ...(params.anthropic?.effort ? { output_config: { effort: params.anthropic.effort } } : {}),
      };
    case "gemini":
      return params.google?.thinkingConfig ? { thinkingConfig: params.google.thinkingConfig } : {};
  }
}
