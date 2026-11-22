import type http from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PROTOCOLS, type Protocol } from "../src/config.ts";
import { createModelGateway, type ModelCall, type ModelEvent, type ToolResult, type ToolSpec } from "../src/models/gateway.ts";
import { createSlots } from "../src/slots.ts";
import { answerCanned, CANNED_REASONING, cannedStream, protocolOfPath, protocolStub, STUB_MODEL, type ProtocolStub, type StubRequest } from "./helpers/models.ts";

/**
 * An earlier reply's tool use returned in its history (harness design §3, step 1; README "Agents and runs", Earlier tool use
 * in history), as the gateway sends it — against a local stub of each protocol's streaming endpoint: in the protocol's own
 * form when the tools are sent, lowered to the very request it always was when they are not, and once more lowered when
 * an upstream refuses it.
 */

const KEY = "sk-stub-0123456789abcdef";
const SYSTEM = "你是小助手。";
const WITHOUT = "你是小助手。你没有工具。";
const ID = "0123456789abcdef012345";
const ID2 = "fedcba9876543210fedcba";
const QUERY = { query: "北京 天气" };
const PLACEHOLDER = { note: "这次搜索的结果当时已经给你看过，系统没有保留原文。", sites: ["news1.example.com", "news2.example.com"], date: "2026-11-22" };
const REFUSED = { error: "这次回复不能再联网搜索了；之后的回复可以照常再试。", date: "2026-11-22" };

const WEB: ToolSpec = {
  name: "search_web",
  description: "上网搜索。",
  parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
};
const CLOCK: ToolSpec = { name: "current_time", description: "现在几点。", parameters: { type: "object", properties: {}, additionalProperties: false } };

/** A conversation whose earlier reply searched once (its acknowledgement, the call, the placeholder, the answer), then a question. */
const REPLAYED: ModelCall["messages"] = [
  { role: "user", parts: [{ type: "text", text: "北京今天天气？" }] },
  { role: "assistant", parts: [{ type: "text", text: "我查一下。" }, { type: "tool-call", id: ID, name: "search_web", input: QUERY }] },
  { role: "tool", parts: [{ type: "tool-result", id: ID, name: "search_web", output: PLACEHOLDER }] },
  { role: "assistant", parts: [{ type: "text", text: "今天晴。" }] },
  { role: "user", parts: [{ type: "text", text: "那明天呢？" }] },
];
/** The same conversation as it was sent before step 1: the reply's two messages one turn. */
const TODAY: ModelCall["messages"] = [
  { role: "user", parts: [{ type: "text", text: "北京今天天气？" }] },
  { role: "assistant", parts: [{ type: "text", text: "我查一下。" }, { type: "text", text: "今天晴。" }] },
  { role: "user", parts: [{ type: "text", text: "那明天呢？" }] },
];
/** Two rounds (a refused call, then one more), no acknowledgement: what a round's turn holds when nothing came before its calls. */
const TWO_ROUNDS: ModelCall["messages"] = [
  { role: "user", parts: [{ type: "text", text: "北京今天天气？" }] },
  { role: "assistant", parts: [{ type: "tool-call", id: ID, name: "search_web", input: { query: "" } }] },
  { role: "tool", parts: [{ type: "tool-result", id: ID, name: "search_web", output: REFUSED }] },
  { role: "assistant", parts: [{ type: "tool-call", id: ID2, name: "current_time", input: {} }] },
  { role: "tool", parts: [{ type: "tool-result", id: ID2, name: "current_time", output: { note: "当时给过你那时的时间。", date: "2026-11-22" } }] },
  { role: "assistant", parts: [{ type: "text", text: "搜不了，今天是 22 日。" }] },
  { role: "user", parts: [{ type: "text", text: "好" }] },
];
const TWO_TODAY: ModelCall["messages"] = [
  { role: "user", parts: [{ type: "text", text: "北京今天天气？" }] },
  { role: "assistant", parts: [{ type: "text", text: "搜不了，今天是 22 日。" }] },
  { role: "user", parts: [{ type: "text", text: "好" }] },
];

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
    messages: REPLAYED,
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

/** The raw body the stub got for one call. */
async function rawOf(c: ModelCall): Promise<string> {
  stub.reset();
  await collect(gateway.stream(c));
  expect(stub.requests).toHaveLength(1);
  return stub.requests[0]!.raw;
}

/** Each protocol's turns of a request body (the system text taken out where it is one of them). */
function turns(protocol: Protocol, body: any): any[] {
  switch (protocol) {
    case "openai_chat":
      return body.messages.filter((m: any) => m.role !== "system" && m.role !== "developer");
    case "openai_responses":
      return body.input.filter((m: any) => m.role !== "system" && m.role !== "developer");
    case "anthropic":
      return body.messages;
    case "gemini":
      return body.contents;
  }
}

/** `status` and a body that names the tools, to the first `times` requests; then the canned answer. */
const refusingFirst = (times: number, status = 400) => {
  let n = 0;
  return (req: StubRequest, res: http.ServerResponse) => {
    if (n++ >= times) return answerCanned(req, res);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "messages.2: tool_calls are not allowed here (tools)", type: "invalid_request_error" } }));
  };
};

describe.each(PROTOCOLS)("%s", (protocol) => {
  it("sent with the tools: the earlier call in the protocol's own form, its result, then the answer — and nothing else differs from the lowered request", async () => {
    const body = JSON.parse(await rawOf(call(protocol, { tools: [WEB, CLOCK] })));
    const args = JSON.stringify(QUERY);
    const output = JSON.stringify(PLACEHOLDER);
    switch (protocol) {
      case "openai_chat":
        expect(turns(protocol, body)).toEqual([
          { role: "user", content: "北京今天天气？" },
          { role: "assistant", content: "我查一下。", tool_calls: [{ id: `call_${ID}`, type: "function", function: { name: "search_web", arguments: args } }] },
          { role: "tool", tool_call_id: `call_${ID}`, content: output },
          { role: "assistant", content: "今天晴。" },
          { role: "user", content: "那明天呢？" },
        ]);
        break;
      case "openai_responses":
        expect(turns(protocol, body)).toEqual([
          { role: "user", content: [{ type: "input_text", text: "北京今天天气？" }] },
          { role: "assistant", content: "我查一下。" },
          { type: "function_call", call_id: `call_${ID}`, name: "search_web", arguments: args },
          { type: "function_call_output", call_id: `call_${ID}`, output },
          { role: "assistant", content: "今天晴。" },
          { role: "user", content: [{ type: "input_text", text: "那明天呢？" }] },
        ]);
        break;
      case "anthropic":
        expect(turns(protocol, body)).toEqual([
          { role: "user", content: [{ type: "text", text: "北京今天天气？" }] },
          { role: "assistant", content: [{ type: "text", text: "我查一下。" }, { type: "tool_use", id: `toolu_01${ID}`, name: "search_web", input: QUERY }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_01${ID}`, content: output }] },
          { role: "assistant", content: [{ type: "text", text: "今天晴。" }] },
          { role: "user", content: [{ type: "text", text: "那明天呢？" }] },
        ]);
        break;
      case "gemini":
        expect(turns(protocol, body)).toEqual([
          { role: "user", parts: [{ text: "北京今天天气？" }] },
          { role: "model", parts: [{ text: "我查一下。" }, { functionCall: { id: `call_${ID}`, name: "search_web", args: QUERY } }] },
          { role: "user", parts: [{ functionResponse: { id: `call_${ID}`, name: "search_web", response: { name: "search_web", content: PLACEHOLDER } } }] },
          { role: "model", parts: [{ text: "今天晴。" }] },
          { role: "user", parts: [{ text: "那明天呢？" }] },
        ]);
        break;
    }
    // Everything but the turns is the request the same conversation makes lowered.
    const lowered = JSON.parse(await rawOf(call(protocol, { tools: [WEB, CLOCK], messages: TODAY })));
    const rest = (b: any) => {
      const { messages: _m, input: _i, contents: _c, ...others } = b;
      return others;
    };
    expect(rest(body)).toEqual(rest(lowered));
  });

  it("rounds of several calls with no acknowledgement: one turn per round, each followed by its results; a refused call as a redacted empty query", async () => {
    const sent = turns(protocol, JSON.parse(await rawOf(call(protocol, { tools: [WEB, CLOCK], messages: TWO_ROUNDS }))));
    // user, round 1's call, its result, round 2's call, its result, the answer, user.
    expect(sent).toHaveLength(7);
    const flat = JSON.stringify(sent);
    // The redacted argument, as an object or as the JSON text of one (Chat Completions, Responses).
    expect([flat.includes('"query":""'), flat.includes('\\"query\\":\\"\\"')]).toContain(true);
    expect(flat).toContain(REFUSED.error);
    expect(flat.indexOf(REFUSED.error)).toBeLessThan(flat.indexOf("当时给过你那时的时间。"));
    expect(flat.indexOf("当时给过你那时的时间。")).toBeLessThan(flat.indexOf("搜不了，今天是 22 日。"));
  });

  it("sent without tools — none offered, an empty list, a request offering none: exactly the request the conversation made before step 1, byte for byte", async () => {
    for (const over of [{}, { tools: [] }, { tools: [], steps: [] }] as Array<Partial<ModelCall>>) {
      expect(await rawOf(call(protocol, { ...over }))).toBe(await rawOf(call(protocol, { ...over, messages: TODAY })));
      expect(await rawOf(call(protocol, { ...over, messages: TWO_ROUNDS }))).toBe(await rawOf(call(protocol, { ...over, messages: TWO_TODAY })));
    }
  });

  it("offering tools an upstream refused before: sent without them and lowered, under the text for going without them — today's request", async () => {
    const upstreamId = `site:replay-refused-${protocol}`;
    stub.answer((req, res) => {
      if (!("tools" in req.body) && !("toolConfig" in req.body)) return answerCanned(req, res);
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "tools are not supported" } }));
    });
    await collect(gateway.stream(call(protocol, { tools: [WEB], systemWithoutTools: WITHOUT, messages: TODAY, upstreamId })));
    stub.reset();
    const finish = (await collect(gateway.stream(call(protocol, { tools: [WEB], systemWithoutTools: WITHOUT, upstreamId })))).at(-1);
    expect(finish).toMatchObject({ type: "finish", toolsRefused: true });
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]!.raw).toBe(await rawOf(call(protocol, { system: WITHOUT, messages: TODAY })));
  });

  it("a replayed call to a tool this request does not offer: the whole replay is lowered (the tools still sent)", async () => {
    const raw = await rawOf(call(protocol, { tools: [CLOCK] }));
    expect(raw).toBe(await rawOf(call(protocol, { tools: [CLOCK], messages: TODAY })));
  });

  it("a 400 or 422 on a request carrying the replay, before anything came back: asked once more with it lowered, counted; nothing remembered, no toolsRefused", async () => {
    for (const status of [400, 422]) {
      const upstreamId = `site:replay-400-${protocol}-${status}`;
      stub.reset();
      stub.answer(refusingFirst(1, status));
      const events = await collect(gateway.stream(call(protocol, { tools: [WEB], systemWithoutTools: WITHOUT, upstreamId })));
      expect(events.filter((e) => e.type === "replay_lowered")).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({ type: "finish" });
      expect(events.at(-1)).not.toHaveProperty("toolsRefused");
      expect(stub.requests).toHaveLength(2);
      const [first, second] = stub.requests.map((r) => r.raw);
      expect(first).toBe(await rawOf(call(protocol, { tools: [WEB], systemWithoutTools: WITHOUT })));
      // The lowered request is today's: the tools still sent, the turns as before step 1.
      expect(second).toBe(await rawOf(call(protocol, { tools: [WEB], systemWithoutTools: WITHOUT, messages: TODAY })));
      // Nothing was remembered: the next call of that upstream sends the tools and the replay again.
      stub.reset();
      await collect(gateway.stream(call(protocol, { tools: [WEB], systemWithoutTools: WITHOUT, upstreamId })));
      expect(stub.requests.map((r) => r.raw)).toEqual([first]);
    }
  });

  it("the lowered request gets today's handling: a refusal of the tools to it leaves them out, as a call's always does (and only that is remembered)", async () => {
    const upstreamId = `site:replay-then-tools-${protocol}`;
    stub.answer(refusingFirst(2));
    const events = await collect(gateway.stream(call(protocol, { tools: [WEB], systemWithoutTools: WITHOUT, upstreamId })));
    expect(events.filter((e) => e.type === "replay_lowered")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "finish", toolsRefused: true });
    expect(stub.requests).toHaveLength(3);
    expect(stub.requests[2]!.raw).toBe(await rawOf(call(protocol, { system: WITHOUT, messages: TODAY })));
  });

  it("not lowered: a 500, a 400 to a request with no replay, a 400 after the lowered one (thrown as today), a 400 to a request sent without tools", async () => {
    const always = (status: number) => (_req: StubRequest, res: http.ServerResponse) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "bad request" } }));
    };
    const tried = async (c: ModelCall, status: number): Promise<[number, number]> => {
      stub.reset();
      stub.answer(always(status));
      const events: ModelEvent[] = [];
      await expect(
        (async () => {
          for await (const e of gateway.stream(c)) events.push(e);
        })(),
      ).rejects.toMatchObject({ upstreamStatus: status });
      return [stub.requests.length, events.filter((e) => e.type === "replay_lowered").length];
    };
    expect(await tried(call(protocol, { tools: [WEB] }), 500)).toEqual([1, 0]);
    expect(await tried(call(protocol, { tools: [WEB], messages: TODAY }), 400)).toEqual([1, 0]);
    // Once lowered, the request is today's: its 400 (naming no field) fails the call.
    expect(await tried(call(protocol, { tools: [WEB] }), 400)).toEqual([2, 1]);
    expect(await tried(call(protocol), 400)).toEqual([1, 0]);
  });
});

describe("Chat Completions: this answer's rounds keep their reasoning beside an earlier reply's calls", () => {
  it("the reasoning a round read goes back with that round's tool call, never with a replayed one", async () => {
    stub.answer((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(cannedStream(protocolOfPath(req.path)!, "reasoning_tool"));
    });
    const first = await collect(gateway.stream(call("openai_chat", { tools: [WEB], reasoning: "high", thinkingSwitch: true })));
    const finish = first.at(-1) as Extract<ModelEvent, { type: "finish" }>;
    const results: ToolResult[] = finish.toolCalls.map((c) => ({ id: c.id, name: c.name, output: { ok: true } }));
    stub.reset();
    await collect(gateway.stream(call("openai_chat", { tools: [WEB], reasoning: "high", thinkingSwitch: true, steps: [{ assistant: finish.assistant, results }] })));
    const withCalls = stub.requests[0]!.body.messages.filter((m: any) => Array.isArray(m.tool_calls));
    expect(withCalls.map((m: any) => [m.tool_calls[0].id, m.reasoning_content ?? null])).toEqual([
      [`call_${ID}`, null],
      [finish.toolCalls[0]!.id, CANNED_REASONING],
    ]);
  });
});
