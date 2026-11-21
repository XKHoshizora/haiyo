import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createModelGateway, type ModelCall, type ModelEvent } from "../src/models/gateway.ts";
import { createSlots } from "../src/slots.ts";
import { protocolStub, STUB_MODEL, type ProtocolStub } from "./helpers/models.ts";

/**
 * A tool call the provider ran itself (lane websearch, attack I7): a stream `tool-call` part with `providerExecuted` is
 * never handed to the loop — neither reported as a call nor named in the finish — so a provider or relay that runs its
 * own `web_search` cannot make the service run ours too, nor count as a garbled call. Against a local stub of the
 * Anthropic messages stream; no database.
 */

let stub: ProtocolStub;
beforeAll(async () => {
  stub = await protocolStub();
});
afterAll(async () => {
  await stub.close();
});

const gateway = createModelGateway({ calls: createSlots(8), allowInsecureLocal: true });

/** An Anthropic stream whose answer ran the provider's own `web_search`, then said `text`. */
function serverSearched(text: string): string {
  const ev = (type: string, fields: object = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
  return [
    ev("message_start", {
      message: { id: "msg_stub", type: "message", role: "assistant", model: STUB_MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 11, output_tokens: 1 } },
    }),
    ev("content_block_start", { index: 0, content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} } }),
    ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '{"query":"天气"}' } }),
    ev("content_block_stop", { index: 0 }),
    ev("content_block_start", {
      index: 1,
      content_block: {
        type: "web_search_tool_result",
        tool_use_id: "srvtoolu_1",
        content: [{ type: "web_search_result", url: "https://news.example.com/1", title: "天气", encrypted_content: "x", page_age: null }],
      },
    }),
    ev("content_block_stop", { index: 1 }),
    ev("content_block_start", { index: 2, content_block: { type: "text", text: "" } }),
    ev("content_block_delta", { index: 2, delta: { type: "text_delta", text } }),
    ev("content_block_stop", { index: 2 }),
    ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 7 } }),
    ev("message_stop"),
  ].join("");
}

const call = (over: Partial<ModelCall> = {}): ModelCall => ({
  protocol: "anthropic",
  baseUrl: stub.baseUrl,
  apiKey: "sk-stub-0123456789abcdef",
  model: STUB_MODEL,
  system: "stub",
  messages: [{ role: "user", parts: [{ type: "text", text: "Hi" }] }],
  reasoning: "none",
  maxOutputTokens: 256,
  signal: new AbortController().signal,
  tools: [{ name: "search_messages", description: "search", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }],
  ...over,
});

describe("a provider-executed tool call", () => {
  it("is skipped: no tool_call event, none in the finish; the text still arrives", async () => {
    stub.answer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.end(serverSearched("今天晴。"));
    });
    const events: ModelEvent[] = [];
    for await (const e of gateway.stream(call())) events.push(e);
    expect(events.filter((e) => e.type === "tool_call")).toEqual([]);
    const finish = events.find((e) => e.type === "finish");
    expect(finish && finish.type === "finish" ? finish.toolCalls : null).toEqual([]);
    expect(events.flatMap((e) => (e.type === "text" ? [e.delta] : [])).join("")).toBe("今天晴。");
  });
});
