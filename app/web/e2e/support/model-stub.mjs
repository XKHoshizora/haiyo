// A local stand-in for a model service, and how a test scripts it. The runner process (system.mjs) runs the server on
// 127.0.0.1; the service under test reaches it as its site models and as a person's own provider. It speaks OpenAI Chat
// Completions, streamed (`POST …/chat/completions`), Anthropic Messages, streamed (`POST …/messages`, the protocol whose
// thinking the service shows), and the model list both have (`GET …/models`); the wire shapes are those of
// app/service/tests/helpers/models.ts `protocolStub()`. Tests script it through the control endpoint (control.mjs):
// what the next calls answer, and what each call was sent. A step may end in tool calls (`toolCalls`: an OpenAI `tool_calls`
// delta, an Anthropic `tool_use` block), which is how a spec makes an Agent look something up (`modelStub.callTools`).
import http from "node:http";
import { expect } from "@playwright/test";
import { controlCall } from "./control.mjs";

/** What a call answers when nothing is scripted. */
export const DEFAULT_REPLY = "好的，收到。";
/** The usage every answer reports unless its step names another: small, so a person's free allowance lasts a while. */
export const DEFAULT_USAGE = { input: 20, output: 10 };
/**
 * The model names `GET …/models` lists: two of the stub's own (unknown to the service's model catalogue), two the
 * catalogue knows, and one that is no chat model.
 */
export const STUB_MODELS = ["stub-chat", "stub-vision", "gpt-4o-mini", "claude-sonnet-5-5", "text-embedding-3-small"];

/** Chunks of at most `size` code points (a surrogate pair is never split). */
function chunks(text, size) {
  const points = Array.from(text);
  const out = [];
  for (let i = 0; i < points.length; i += size) out.push(points.slice(i, i + size).join(""));
  return out;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** The words that tell a memory call from a reply: a distinctive phrase of the memory review's and the hearsay call's system text. */
const MEMORY_MARKS = { review: "记忆整理员", hearsay: "听说整理员" };
/** What a memory call answers when no rule matches it: nothing worth keeping. */
const MEMORY_DEFAULTS = { review: '{"ops":[]}', hearsay: '{"entries":[],"drop":[]}' };

/** The system text and the user messages of a call, as strings (either protocol). */
function textsOf(body) {
  const flat = (content) => (typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => c?.text ?? "").join("") : "");
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const system = [flat(body?.system), ...messages.filter((m) => m?.role === "system").map((m) => flat(m.content))].join("\n");
  const user = messages.filter((m) => m?.role === "user").map((m) => flat(m.content)).join("\n");
  return { system, user };
}

/** `"review"` or `"hearsay"` for a call of the memory feature (by its system text), else null. */
const memoryKindOf = (body) => {
  const { system } = textsOf(body);
  return Object.keys(MEMORY_MARKS).find((kind) => system.includes(MEMORY_MARKS[kind])) ?? null;
};

/**
 * `text` with each `{{m1}}` (`{{f2}}`…) as the model copies a citation: the token of that number the call was sent last
 * (`〔m1·k7q2m9x4〕`: what the service's tools label things with, carrying the reply's own tag — its tool results come after
 * the conversation, where anyone may have typed one), whole; left as it is when the call was sent none.
 */
const withTokens = (text, body) => {
  if (!text.includes("{{")) return text;
  const sent = JSON.stringify(body ?? null);
  return text.replace(/\{\{([mf][1-9][0-9]*)\}\}/g, (whole, number) => [...sent.matchAll(new RegExp(`〔${number}·[a-z0-9]+〕`, "g"))].at(-1)?.[0] ?? whole);
};

/** One server-sent event: an `event:` line when named, then the JSON as `data:`. */
const sse = (data, event) => `${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;

/** The frames of an OpenAI Chat Completions stream. */
function openaiFrames(model, usage) {
  const chunk = (delta, finish = null) =>
    sse({ id: "chatcmpl-e2e", object: "chat.completion.chunk", created: 1_700_000_000, model, choices: [{ index: 0, delta, finish_reason: finish }] });
  return {
    head: () => chunk({ role: "assistant", content: "" }),
    // (Chat Completions has no thinking the service reads: a step's reasoning is not sent on this protocol.)
    reasoning: () => "",
    text: (d) => chunk({ content: d }),
    // One tool call, streamed as the real protocol does: its id and name, then its input's JSON in pieces.
    tool: (call, index) =>
      chunk({ tool_calls: [{ index, id: call.id, type: "function", function: { name: call.name, arguments: "" } }] }) +
      chunks(call.args, 8)
        .map((piece) => chunk({ tool_calls: [{ index, function: { arguments: piece } }] }))
        .join(""),
    end: (calls = 0) =>
      chunk({}, calls > 0 ? "tool_calls" : "stop") +
      sse({
        id: "chatcmpl-e2e",
        object: "chat.completion.chunk",
        created: 1_700_000_000,
        model,
        choices: [],
        usage: { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output },
      }) +
      sse("[DONE]"),
  };
}

/** The frames of an Anthropic Messages stream: thinking (block 0) when there is reasoning, then the text. */
function anthropicFrames(model, usage) {
  const ev = (type, fields = {}) => sse({ type, ...fields }, type);
  let index = -1;
  let open = null;
  const start = (kind) => {
    let out = open ? ev("content_block_stop", { index }) : "";
    index += 1;
    open = kind;
    out += ev("content_block_start", { index, content_block: kind === "thinking" ? { type: "thinking", thinking: "", signature: "" } : { type: "text", text: "" } });
    return out;
  };
  return {
    head: () =>
      ev("message_start", {
        message: { id: "msg_e2e", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input, output_tokens: 1 } },
      }),
    reasoning: (d) => (open === "thinking" ? "" : start("thinking")) + ev("content_block_delta", { index, delta: { type: "thinking_delta", thinking: d } }),
    text: (d) =>
      (open === "text" ? "" : (open === "thinking" ? ev("content_block_delta", { index, delta: { type: "signature_delta", signature: "c2lnbmF0dXJl" } }) : "") + start("text")) +
      ev("content_block_delta", { index, delta: { type: "text_delta", text: d } }),
    tool: (call) => {
      let out = open === "thinking" ? ev("content_block_delta", { index, delta: { type: "signature_delta", signature: "c2lnbmF0dXJl" } }) : "";
      out += open ? ev("content_block_stop", { index }) : "";
      index += 1;
      open = "tool_use";
      out += ev("content_block_start", { index, content_block: { type: "tool_use", id: call.id, name: call.name, input: {} } });
      for (const piece of chunks(call.args, 8)) out += ev("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: piece } });
      return out;
    },
    end: (calls = 0) =>
      (open ? ev("content_block_stop", { index }) : "") +
      ev("message_delta", { delta: { stop_reason: calls > 0 ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: usage.output } }) +
      ev("message_stop"),
  };
}

/**
 * The stub's server. Each streaming call takes the next scripted step (or the default reply) when it arrives:
 * `{text (each `{{m1}}` in it the token of that number the call was sent, as a model copies one: `withTokens`),
 * reasoning?, chunkSize? (code points, default 4), delayMs? (before each piece), waitMs? (once, after the stream's head and
 * before its first piece), usage? ({input, output} tokens), status? (answer with this HTTP error instead), hang?
 * (after the text, hold until released or until the caller goes), toolCalls? (`[{name, input, id?}]`: the round ends in these
 * calls after its text — the service runs them and calls again, taking the next step), message? (with `status`: the error's text)}`.
 * Every request is recorded: method, path, the Authorization / x-api-key it carried, its JSON body, and whether the
 * caller went away before the answer ended.
 */
export function startModelStub() {
  let requests = [];
  let queue = [];
  /** Calls holding (`hang`), oldest first: `release(text)` goes on with `text` and ends the answer. */
  let held = [];
  /**
   * What memory calls answer (control `memory`): `{kind, when, step}`; a call of that kind whose user message contains `when`
   * takes the first such rule once. Memory calls never take a step of `queue` and are not among `calls()`: a review or a hearsay
   * call comes some time after a reply, and must not eat what a spec scripted for the next reply.
   */
  let memoryRules = [];

  async function stream(req, res, record, step, protocol) {
    const usage = step.usage ?? DEFAULT_USAGE;
    const frames = (protocol === "anthropic" ? anthropicFrames : openaiFrames)(record.body?.model ?? "stub", usage);
    const size = step.chunkSize ?? 4;
    const delay = step.delayMs ?? 0;
    let gone = false;
    res.on("close", () => {
      if (!res.writableFinished) {
        gone = true;
        record.aborted = true;
      }
    });
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(frames.head());
    if (step.waitMs > 0) await sleep(step.waitMs);
    const emit = async (kind, text) => {
      for (const piece of chunks(text, size)) {
        if (gone) return;
        if (delay > 0) await sleep(delay);
        if (gone) return;
        const frame = frames[kind](piece);
        if (frame) res.write(frame);
      }
    };
    await emit("reasoning", step.reasoning ?? "");
    await emit("text", withTokens(step.text ?? "", record.body));
    if (step.hang) {
      const rest = await new Promise((resolve) => {
        const hold = { record, release: resolve };
        held.push(hold);
        res.on("close", () => resolve(null));
      });
      held = held.filter((h) => h.record !== record);
      if (gone) return;
      if (rest === null) {
        // (Cut off by a reset: the stream ends broken at once rather than idling until the service gives up on it.)
        res.destroy();
        return;
      }
      await emit("text", rest);
    }
    if (gone) return;
    const calls = (step.toolCalls ?? []).map((c, i) => ({ id: c.id ?? `call_e2e_${i + 1}`, name: c.name, args: JSON.stringify(c.input ?? {}) }));
    calls.forEach((c, i) => res.write(frames.tool(c, i)));
    res.end(frames.end(calls.length));
  }

  const server = http.createServer((req, res) => {
    const parts = [];
    req.on("data", (c) => parts.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(parts).toString("utf8");
      let body = null;
      try {
        body = raw === "" ? null : JSON.parse(raw);
      } catch {
        body = raw;
      }
      const path = (req.url ?? "").split("?")[0];
      const record = {
        at: Date.now(),
        method: req.method,
        path,
        authorization: req.headers.authorization ?? req.headers["x-api-key"] ?? null,
        body,
        aborted: false,
      };
      requests.push(record);
      if (req.method === "GET" && path.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: STUB_MODELS.map((id) => ({ id, object: "model", created: 0, owned_by: "e2e" })) }));
        return;
      }
      const protocol = req.method === "POST" && path.endsWith("/chat/completions") ? "openai" : req.method === "POST" && path.endsWith("/messages") ? "anthropic" : null;
      if (!protocol) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end('{"error":{"message":"no such endpoint"}}');
        return;
      }
      const memoryKind = req.method === "POST" ? memoryKindOf(body) : null;
      if (memoryKind) {
        record.memory = memoryKind;
        const user = textsOf(body).user;
        const at = memoryRules.findIndex((r) => r.kind === memoryKind && user.includes(r.when));
        const rule = at >= 0 ? memoryRules.splice(at, 1)[0] : null;
        stream(req, res, record, rule?.step ?? { text: MEMORY_DEFAULTS[memoryKind] }, protocol).catch(() => res.destroy());
        return;
      }
      const step = queue.shift() ?? { text: DEFAULT_REPLY };
      if (step.status) {
        res.writeHead(step.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: step.message ?? "scripted failure", type: "e2e", code: null } }));
        return;
      }
      stream(req, res, record, step, protocol).catch(() => res.destroy());
    });
  });

  /** What the control endpoint's `/stub/<name>` does with its JSON body; answers JSON. */
  function control(name, body) {
    switch (name) {
      case "reset":
        // A call still holding from an earlier test is cut off: it can never answer anyone later.
        for (const hold of held) hold.release(null);
        held = [];
        queue = [];
        memoryRules = [];
        requests = [];
        return { ok: true };
      case "script":
        queue.push(...(body?.steps ?? []));
        return { pending: queue.length };
      case "memory":
        memoryRules.push({ kind: body.kind, when: String(body.when ?? ""), step: { text: body.text, ...(body.options ?? {}) } });
        return { rules: memoryRules.length };
      case "release": {
        const hold = held.shift();
        if (!hold) throw new Error("no call is holding");
        hold.release(body?.text ?? "");
        return { ok: true };
      }
      case "state":
        return { requests, pending: queue.length, holding: held.length };
      default:
        throw new Error(`unknown stub command ${name}`);
    }
  }

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        /** `http://127.0.0.1:<port>/v1`: a site model's or a provider's base URL. */
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        control,
        close: () => {
          for (const hold of held) hold.release(null);
          server.closeAllConnections();
          return new Promise((done) => server.close(() => done()));
        },
      });
    });
  });
}

// --- what a test does with it (through the control endpoint) ------------------------------------------------------

const call = (name, body) => controlCall(`stub/${name}`, body);

export const modelStub = {
  /** The stub's base URL (`http://127.0.0.1:<port>/v1`), for a person's own provider. */
  get baseUrl() {
    if (!process.env.E2E_STUB_URL) throw new Error("the model stub runs only in the local suite");
    return process.env.E2E_STUB_URL;
  },
  /** Forgets every script and recorded request, and cuts off any call still holding (each test starts so). */
  reset: () => call("reset"),
  /** The next streaming calls answer with these steps, in order (see `startModelStub`). */
  script: (...steps) => call("script", { steps }),
  /** The next call answers `text` (options as a step's). */
  reply: (text, options = {}) => call("script", { steps: [{ text, ...options }] }),
  /** The next call streams `text`, then holds until `release()` (or until the service stops it). */
  hangAfter: (text, options = {}) => call("script", { steps: [{ text, hang: true, ...options }] }),
  /**
   * The next call is a round of tool calls: it says `options.text` first when given (what a reply says before it looks
   * something up: its acknowledgement), then calls `calls` (`[{name, input}]`, in order); the service runs them and
   * makes its next call, which takes the next step. Other options as a step's (`usage`, `hang`: hold after the text,
   * before the calls, until `release()`…).
   */
  callTools: (calls, options = {}) => call("script", { steps: [{ text: "", ...options, toolCalls: calls }] }),
  /**
   * The next call is one an upstream refuses because of its tools (HTTP 400 naming them): the service asks again without
   * them, and that call takes the next step.
   */
  rejectTools: () => call("script", { steps: [{ status: 400, message: "this model does not support tools" }] }),
  /** The oldest holding call goes on with `text` and ends. */
  release: (text = "") => call("release", { text }),
  /** `{requests, pending, holding}`. */
  state: () => call("state"),
  /** The streaming calls received so far (model calls, not model lists, not the memory feature's), oldest first. */
  async calls() {
    return (await call("state")).requests.filter((r) => r.method === "POST" && !r.memory);
  },
  /**
   * The calls of the memory feature so far, oldest first: `kind` "review" or "hearsay" (all when omitted). Each is a recorded
   * request (`body`: the call as sent).
   */
  async memoryCalls(kind) {
    return (await call("state")).requests.filter((r) => r.memory && (kind === undefined || r.memory === kind));
  },
  /**
   * A call of kind "review" or "hearsay" whose user message contains `when` answers `text` (once). Anything else of that kind
   * answers nothing worth keeping (`{"ops":[]}` / `{"entries":[],"drop":[]}`).
   */
  memoryAnswer: (kind, when, text, options = {}) => call("memory", { kind, when, text, options }),
  /** Waits until `n` calls are holding. */
  async holding(n = 1) {
    await expect.poll(async () => (await call("state")).holding, { message: `${n} model call(s) holding`, timeout: 20_000 }).toBe(n);
  },
  /** Waits until `n` streaming calls have been received in all; resolves with them. */
  async waitForCalls(n) {
    await expect.poll(async () => (await modelStub.calls()).length, { message: `${n} model call(s) received`, timeout: 20_000 }).toBe(n);
    return modelStub.calls();
  },
};
