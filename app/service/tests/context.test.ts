import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readPrefix } from "../src/agents/context.ts";
import { CALL_ATTACHMENT_MAX_BYTES, ContextPlan, CUT_MARK, fileText, type ContextEntry } from "../src/agents/runtime/context.ts";
import type { BlobStore } from "../src/attachments/blob.ts";
import { estimateTokens, IMAGE_TOKENS } from "../src/metering/prices.ts";
import { CONTEXT_HEADROOM } from "../src/metering/tokens.ts";
import { isRunEnd, NOTHING, type RunEnd } from "../src/agents/runtime/port.ts";
import { systemPrompt } from "../src/agents/runtime/prompt.ts";
import type { ModelCall } from "../src/models/gateway.ts";
import { api, group, seatPerson, signUp, type Actor } from "./helpers/actors.ts";
import { markOf, mustCreateAgent, PNG } from "./helpers/agents.ts";
import { useProbeBlobs } from "./helpers/blobs.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { MULTIPART, multipart } from "./helpers/multipart.ts";
import { providerBody } from "./helpers/providers.ts";

/**
 * What the model is shown (spec 6.2 "新话题", 6.5 "发给模型的内容", "思考程度"; README "Agents and runs"): the
 * conversation after the latest topic reset, newest turns kept within the model's context, with images, text files and
 * PDFs when the model can take them; never the stored reasoning. Read off the scripted gateway's recorded calls.
 */

const model = (id: string, over: Record<string, unknown>) => ({
  id,
  label: id,
  tier: "free",
  protocol: "anthropic",
  baseUrl: "https://api.example.test/v1",
  apiKeyEnv: "CONTEXT_TEST_KEY",
  model: `${id}-1`,
  // One micro-point per input token and none for output: a call's hold is its input estimate.
  inputMicroPerToken: 1,
  outputMicroPerToken: 0,
  maxOutputTokens: 4096,
  contextTokens: 1_000_000,
  vision: true,
  pdf: true,
  reasoning: ["low", "medium"],
  ...over,
});

const ENV = {
  CONTEXT_TEST_KEY: "not-a-real-key",
  SITE_MODELS: JSON.stringify([
    model("eyes", {}),
    model("blind", { vision: false, pdf: false, reasoning: [] }),
    model("tiny", { contextTokens: 2000, maxOutputTokens: 200 }),
    model("mid", { contextTokens: 8000, maxOutputTokens: 500 }),
  ]),
};

const gateway = scriptedGateway();
const store = useProbeBlobs("af-context-");
/** While set, every blob read waits for `opened` (a store that hangs), after calling `reached`. */
let held: { opened: Promise<void>; reached: () => void } | null = null;
const blobs: BlobStore = {
  ...store.blobs,
  async get(key) {
    if (held) {
      held.reached();
      await held.opened;
    }
    return store.blobs.get(key);
  },
};
const { app, db } = useApp({ env: ENV, models: gateway, blobs, agentWorker: false });

let first = 0;
beforeEach(() => {
  first = gateway.calls.length;
  held = null;
});
afterEach(() => {
  expect(gateway.pending()).toBe(0);
});

const PERSONA = "你说话简短。";

/** An owner and their Agent. Its memory is off: the budgets here are measured on the system text without memory's sentence (memory-prompt.test.ts covers it). */
async function owned(name: string, modelId = "eyes", over: Record<string, unknown> = {}) {
  const owner = await signUp(app, name);
  const agent = await mustCreateAgent(app, owner, { model: { source: "site", id: modelId }, persona: PERSONA, memory: false, ...over });
  return { owner, agent, conv: agent.conversationId as string };
}

let txn = 0;
const say = async (owner: Actor, conv: string, text: string, extra: Record<string, unknown> = {}) => {
  const res = await api(app, owner, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `c${++txn}`, ...extra });
  expect(res.status).toBe(201);
  return res.json.message;
};
async function upload(owner: Actor, conv: string, filename: string, data: Buffer | string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: `/api/conversations/${conv}/attachments`,
    headers: { cookie: owner.cookie, "content-type": MULTIPART },
    payload: multipart([{ name: "file", filename, type: "application/octet-stream", data }]),
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}
/** Uploads the file and sends it, with `caption` when given. */
async function sendFile(owner: Actor, conv: string, filename: string, data: Buffer | string, caption?: string) {
  const attachmentId = await upload(owner, conv, filename, data);
  const res = await api(app, owner, "POST", `/api/conversations/${conv}/messages`, {
    attachmentId,
    ...(caption === undefined ? {} : { text: caption }),
    clientTxn: `c${++txn}`,
  });
  expect(res.status).toBe(201);
  return attachmentId;
}
const blobKeyOf = async (attachmentId: string) =>
  (await db.query<{ blob_key: string }>("select blob_key from attachments where id = $1", [attachmentId])).rows[0]!.blob_key;

const callsHere = () => gateway.calls.slice(first);
const lastCall = (): ModelCall => {
  const calls = callsHere();
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1]!;
};
/** Every text the call shows, in order. */
const textsOf = (call: ModelCall) => call.messages.flatMap((m) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])));
const latestRun = async (owner: Actor, conv: string) => (await api(app, owner, "GET", `/api/conversations/${conv}/run`)).json.run;
const fromAgent = async (owner: Actor, conv: string, agentId: string): Promise<any[]> =>
  (await api(app, owner, "GET", `/api/conversations/${conv}/messages`)).json.messages.filter((m: any) => m.senderId === agentId);
const usageInput = async (runId: string) =>
  (await db.query<{ input: number; estimated: boolean }>("select input_tokens::int as input, estimated from usage_records where run_id = $1", [runId]))
    .rows[0];

/** Runs the queued reply, answering `reply`. */
async function answer(reply: string, options: Parameters<typeof gateway.reply>[1] = {}) {
  gateway.reply(reply, options);
  expect(await app.agentWorker.runOnce()).toBe(true);
}

describe("turns", () => {
  it("the owner's messages are user turns and the Agent's assistant turns, in the order they were answered; consecutive ones of one side are one turn; the call ends on the owner's", async () => {
    const { owner, agent, conv } = await owned("ord");
    const hold = gateway.hang();
    await say(owner, conv, "甲");
    const running = app.agentWorker.runOnce();
    await hold.reached;
    await say(owner, conv, "乙");
    await say(owner, conv, "丙");
    hold.release("答甲");
    await running;
    // Stored in this order: 甲 1, 乙 2, 丙 3, 答甲 4. 答甲 answers 甲 (its run covered seq 1), so it is shown right
    // after it; the follow-up answers 乙 and 丙 and ends on them.
    const stored = (await api(app, owner, "GET", `/api/conversations/${conv}/messages`)).json.messages;
    expect(stored.map((m: any) => [m.seq, m.text, m.senderId === agent.id])).toEqual([
      [1, "甲", false],
      [2, "乙", false],
      [3, "丙", false],
      [4, "答甲", true],
    ]);
    await answer("答乙丙");
    expect(lastCall().messages).toEqual([
      { role: "user", parts: [{ type: "text", text: "甲" }] },
      { role: "assistant", parts: [{ type: "text", text: "答甲" }] },
      {
        role: "user",
        parts: [
          { type: "text", text: "乙" },
          { type: "text", text: "丙" },
        ],
      },
    ]);

    await say(owner, conv, "丁");
    await answer("答丁");
    expect(lastCall().messages).toEqual([
      { role: "user", parts: [{ type: "text", text: "甲" }] },
      { role: "assistant", parts: [{ type: "text", text: "答甲" }] },
      {
        role: "user",
        parts: [
          { type: "text", text: "乙" },
          { type: "text", text: "丙" },
        ],
      },
      { role: "assistant", parts: [{ type: "text", text: "答乙丙" }] },
      { role: "user", parts: [{ type: "text", text: "丁" }] },
    ]);
  });

  it("carry no label and the run no mark (those are a group's): the system text is exactly its own, and a reply that looks like a label is stored as written", async () => {
    const { owner, agent, conv } = await owned("own");
    await say(owner, conv, "你好");
    const ticket = (await app.agentPort.claimNext())!;
    const before = new Date();
    const prepared = await app.agentPort.begin(ticket);
    const after = new Date();
    if (isRunEnd(prepared)) throw new Error(`begin ended the run: ${JSON.stringify(prepared)}`);
    // `begin` reads the clock between these two: its date is one of theirs, also across midnight.
    const own = (now: Date) =>
      systemPrompt({ name: agent.name, persona: PERSONA, ownerAppellation: null }, { displayName: "own" }, now, "normal", app.deps.config.siteTimezone);
    expect([own(before), own(after)]).toContain(prepared.call.system);
    expect(prepared.call.system).not.toContain("称呼");
    expect(prepared.call.messages).toEqual([{ role: "user", parts: [{ type: "text", text: "你好" }] }]);
    await app.agentPort.finish(ticket, { status: "cancelled" }, null, NOTHING);

    await say(owner, conv, "照写这一行");
    await answer("〔abc123 own｜你的主人〕abc123 照写", { reasoning: "想想 abc123" });
    expect((await fromAgent(owner, conv, agent.id)).at(-1)).toMatchObject({ text: "〔abc123 own｜你的主人〕abc123 照写", reasoning: "想想 abc123" });
  });

  it("are told what to call the owner once the owner set that — one sentence after who it talks to, shown as a label shows a name — and nothing else of the system text changes", async () => {
    const { owner, agent, conv } = await owned("named");
    expect((await api(app, owner, "PATCH", `/api/agents/${agent.id}`, { ownerAppellation: "老〔板｜" })).status).toBe(200);
    await say(owner, conv, "你好");
    const ticket = (await app.agentPort.claimNext())!;
    const before = new Date();
    const prepared = await app.agentPort.begin(ticket);
    const after = new Date();
    if (isRunEnd(prepared)) throw new Error(`begin ended the run: ${JSON.stringify(prepared)}`);
    const own = (now: Date, ownerAppellation: string | null) =>
      systemPrompt({ name: agent.name, persona: PERSONA, ownerAppellation }, { displayName: "named" }, now, "normal", app.deps.config.siteTimezone);
    expect([own(before, "老〔板｜"), own(after, "老〔板｜")]).toContain(prepared.call.system);
    expect(prepared.call.system).toContain("现在和你对话的是你的主人 named。称呼你的主人为「老板」。\n今天是");
    expect([own(before, null), own(after, null)]).toContain(prepared.call.system.replace("称呼你的主人为「老板」。", ""));
    await app.agentPort.finish(ticket, { status: "cancelled" }, null, NOTHING);
  });

  it("a quoted message is shown before the text as > and its first 200 characters", async () => {
    const { owner, conv } = await owned("quo");
    await say(owner, conv, "讲一段");
    const long = `第一行\n${"长".repeat(300)}`;
    await answer(long);
    const reply = (await api(app, owner, "GET", `/api/conversations/${conv}/messages`)).json.messages.at(-1);
    await say(owner, conv, "这段什么意思？", { replyToSeq: reply.seq });
    await answer("就是这个意思。");
    const shown = Array.from(long).slice(0, 200).join("");
    expect(textsOf(lastCall()).at(-1)).toBe(`> 第一行\n> ${shown.slice("第一行\n".length)}\n这段什么意思？`);
  });
});

describe("a new topic", () => {
  it("after a topic reset nothing older is sent, while history and search still have it", async () => {
    const { owner, agent, conv } = await owned("topic");
    await say(owner, conv, "旧话题ALPHAWORD");
    await answer("旧回复BETAWORD");
    expect((await api(app, owner, "POST", `/api/conversations/${conv}/topic`)).status).toBe(201);
    await say(owner, conv, "新话题");
    await answer("好的");
    expect(lastCall().messages).toEqual([{ role: "user", parts: [{ type: "text", text: "新话题" }] }]);
    expect(JSON.stringify(lastCall().messages)).not.toMatch(/ALPHAWORD|BETAWORD/);

    const history = (await api(app, owner, "GET", `/api/conversations/${conv}/messages`)).json.messages;
    expect(history.map((m: any) => (m.kind === "system" ? m.system.event : m.text))).toEqual([
      "旧话题ALPHAWORD",
      "旧回复BETAWORD",
      "topic_reset",
      "新话题",
      "好的",
    ]);
    expect((await api(app, owner, "GET", "/api/search?q=ALPHAWORD")).json.messages).toHaveLength(1);
    expect((await api(app, owner, "GET", `/api/conversations/${conv}/search?q=BETAWORD`)).json.messages).toHaveLength(1);
    expect((await fromAgent(owner, conv, agent.id)).map((m) => m.text)).toEqual(["旧回复BETAWORD", "好的"]);
  });

  it("a reply whose messages are all before a new topic never reaches the model: it is cancelled, with nothing to retry", async () => {
    const { owner, conv } = await owned("over");
    const calls = gateway.calls.length;
    await say(owner, conv, "算了，换个话题");
    // The owner starts over before the queued reply has begun.
    expect((await api(app, owner, "POST", `/api/conversations/${conv}/topic`)).status).toBe(201);
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(gateway.calls.length).toBe(calls);
    const run = await latestRun(owner, conv);
    expect(run).toEqual({ id: run.id, status: "cancelled", retryable: false });
    expect(await api(app, owner, "POST", `/api/conversations/${conv}/runs/retry`)).toEqual({ status: 400, json: { error: "invalid_request" } });
    // Never admitted: no model on its record and nothing charged.
    expect((await db.query("select outcome, source, cost_micro::text as cost from usage_records where run_id = $1", [run.id])).rows).toEqual([
      { outcome: "cancelled", source: null, cost: "0" },
    ]);
    // The next message is answered from the new topic on.
    await say(owner, conv, "新话题");
    await answer("好。");
    expect(lastCall().messages).toEqual([{ role: "user", parts: [{ type: "text", text: "新话题" }] }]);
  });

  it("so is a retry of a failed reply after a new topic", async () => {
    const { owner, conv } = await owned("retryover");
    gateway.fail("provider_unavailable");
    const hello = await say(owner, conv, "你好");
    await app.agentWorker.runOnce();
    expect((await latestRun(owner, conv)).error).toBe("provider_unavailable");
    expect((await api(app, owner, "POST", `/api/conversations/${conv}/topic`)).status).toBe(201);

    const calls = gateway.calls.length;
    const retried = await api(app, owner, "POST", `/api/conversations/${conv}/runs/retry`);
    expect(retried.status).toBe(201);
    // A retry answers up to the owner's last message; the notice, though written by the owner, is not one.
    const covers = await db.query("select covers_seq::int as c from agent_runs where id = $1", [retried.json.run.id]);
    expect(covers.rows).toEqual([{ c: hello.seq }]);
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(gateway.calls.length).toBe(calls);
    expect(await latestRun(owner, conv)).toEqual({ id: retried.json.run.id, status: "cancelled", retryable: false });
  });

  it("a reply with nothing to answer and no new topic to explain it fails busy, retryable, without a model call", async () => {
    const { owner, agent, conv } = await owned("nothing");
    // A run that covers nothing (no trigger makes one; inserted as the service would queue it).
    await db.query(
      `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq)
       values ('reply', $1, $2, $3, 'queued', 0)`,
      [conv, agent.id, owner.id],
    );
    const calls = gateway.calls.length;
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(gateway.calls.length).toBe(calls);
    const run = await latestRun(owner, conv);
    expect(run).toEqual({ id: run.id, status: "failed", error: "busy", retryable: true });
  });
});

describe("attachments", () => {
  it("a model that can see gets the image's bytes, counted as 1 500 tokens; one that cannot gets its name and the blob is not read", async () => {
    const { owner, conv } = await owned("vis");
    const hold = gateway.hang();
    await sendFile(owner, conv, "pixel.png", PNG, "这是什么？");
    const running = app.agentWorker.runOnce();
    const call = await hold.reached;
    expect(call.messages).toEqual([
      {
        role: "user",
        parts: [
          { type: "text", text: "这是什么？" },
          { type: "image", mime: "image/png", data: PNG },
        ],
      },
    ]);
    // The hold is the most the input can cost (1 micro-point per input token, outputs free): the system text and the
    // text at their utf-8 bytes, a token a byte at most, and the image at its constant.
    const bytes = Buffer.byteLength(call.system, "utf8") + Buffer.byteLength("这是什么？", "utf8");
    const held = await db.query<{ hold: string }>("select hold_micro::text as hold from agent_runs where status = 'running'");
    expect(held.rows).toEqual([{ hold: String(bytes + IMAGE_TOKENS) }]);
    hold.release("一个像素。");
    await running;
    // No usage reported: settled on the estimate (text in weight), images included.
    const estimate = estimateTokens(call.system) + estimateTokens("这是什么？") + IMAGE_TOKENS;
    expect(await usageInput((await latestRun(owner, conv)).id)).toEqual({ input: estimate, estimated: true });

    const blind = await owned("blind", "blind");
    const attachment = await sendFile(blind.owner, blind.conv, "pixel.png", PNG);
    await answer("看不到图。");
    expect(lastCall().messages).toEqual([{ role: "user", parts: [{ type: "text", text: "[图片：pixel.png]" }] }]);
    expect(store.probe.gets).not.toContain(await blobKeyOf(attachment));
  });

  it("only PNG, JPEG and WebP are sent as images (every protocol takes them); a GIF is named and not read", async () => {
    const { owner, conv } = await owned("gif");
    const gif = Buffer.from("47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b", "hex");
    const attachment = await sendFile(owner, conv, "dance.gif", gif, "动图");
    await answer("看不了动图。");
    expect(lastCall().messages).toEqual([
      {
        role: "user",
        parts: [
          { type: "text", text: "动图" },
          { type: "text", text: "[图片：dance.gif]" },
        ],
      },
    ]);
    expect(store.probe.gets).not.toContain(await blobKeyOf(attachment));
  });

  it("at most 10 images in one call, the newest", async () => {
    const { owner, agent, conv } = await owned("many");
    expect((await api(app, owner, "POST", `/api/agents/${agent.id}/pause`)).status).toBe(200);
    for (let i = 0; i < 12; i++) await sendFile(owner, conv, `p${i}.png`, PNG);
    expect((await api(app, owner, "POST", `/api/agents/${agent.id}/resume`)).status).toBe(200);
    await say(owner, conv, "都看看");
    await answer("看了。");
    const parts = lastCall().messages.flatMap((m) => m.parts);
    expect(parts.filter((p) => p.type === "image")).toHaveLength(10);
    expect(textsOf(lastCall())).toEqual(["[图片：p0.png]", "[图片：p1.png]", "都看看"]);
  });

  it("a text file is shown by its content, not its name: cut at 100 000 characters with a mark, BOM and unsafe characters removed", async () => {
    const { owner, conv } = await owned("txt");
    const bidi = String.fromCodePoint(0x202e);
    await sendFile(owner, conv, "notes", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`第一行\nsecond${bidi} line\n`)]), "看看笔记");
    const long = `${"a".repeat(99_990)}0123456789TAILWORD${"b".repeat(50_000)}`;
    await sendFile(owner, conv, "long.txt", long);
    await answer("读完了。");
    expect(textsOf(lastCall())).toEqual(["看看笔记", "[文件：notes]\n第一行\nsecond line\n", `[文件：long.txt]\n${long.slice(0, 100_000)}${CUT_MARK}`]);
    expect(CUT_MARK).toBe("…（已截断）");
  });

  it("at most 200 000 characters of files in one call: the oldest file over it is cut, older ones are named", async () => {
    const { owner, agent, conv } = await owned("cap");
    expect((await api(app, owner, "POST", `/api/agents/${agent.id}/pause`)).status).toBe(200);
    await sendFile(owner, conv, "a.txt", "A".repeat(80_000));
    await sendFile(owner, conv, "b.txt", "B".repeat(90_000));
    await sendFile(owner, conv, "c.txt", "C".repeat(90_000));
    await sendFile(owner, conv, "d.txt", "D".repeat(10));
    expect((await api(app, owner, "POST", `/api/agents/${agent.id}/resume`)).status).toBe(200);
    await say(owner, conv, "汇总");
    await answer("好。");
    // Newest first: d (10), c (90 000), b (90 000) fill 180 010; a gets the 19 990 left.
    expect(textsOf(lastCall())).toEqual([
      `[文件：a.txt]\n${"A".repeat(19_990)}${CUT_MARK}`,
      `[文件：b.txt]\n${"B".repeat(90_000)}`,
      `[文件：c.txt]\n${"C".repeat(90_000)}`,
      `[文件：d.txt]\n${"D".repeat(10)}`,
      "汇总",
    ]);
  });

  it("a binary file named .txt, and any other file, is shown by its name; a message with only an attachment is still a turn", async () => {
    const { owner, conv } = await owned("bin");
    const binary = Buffer.from([0x50, 0x4b, 0x00, 0x01, 0xff, 0xfe, 0x00, 0x00, 0x13, 0x37]);
    await sendFile(owner, conv, "data.txt", binary);
    await answer("这是二进制文件。");
    expect(lastCall().messages).toEqual([{ role: "user", parts: [{ type: "text", text: "[文件：data.txt]" }] }]);
    await sendFile(owner, conv, "bad.txt", Buffer.from([0x68, 0x69, 0xc3, 0x28, 0x0a])); // not UTF-8
    await sendFile(owner, conv, "ctl.txt", Buffer.from(`ok${"\u0007".repeat(5)}${"x".repeat(100)}`)); // many control characters
    await answer("都打不开。");
    expect(textsOf(lastCall()).slice(-2)).toEqual(["[文件：bad.txt]", "[文件：ctl.txt]"]);
  });

  it("a PDF goes to a model that reads PDFs as a file, counted at 300 tokens a kilobyte; to one that does not, by name", async () => {
    const pdf = Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n${"% filler\n".repeat(300)}trailer\n<< /Root 1 0 R >>\n%%EOF\n`, "latin1");
    const { owner, conv } = await owned("pdf");
    await sendFile(owner, conv, "doc.pdf", pdf, "总结");
    await answer("是个空文档。");
    const call = lastCall();
    expect(call.messages).toEqual([
      {
        role: "user",
        parts: [
          { type: "text", text: "总结" },
          { type: "file", mime: "application/pdf", name: "doc.pdf", data: pdf },
        ],
      },
    ]);
    const estimate = estimateTokens(call.system) + estimateTokens("总结") + Math.ceil((pdf.length * 300) / 1000);
    expect(await usageInput((await latestRun(owner, conv)).id)).toEqual({ input: estimate, estimated: true });

    const blind = await owned("pdfblind", "blind");
    await sendFile(blind.owner, blind.conv, "doc.pdf", pdf);
    await answer("看不了 PDF。");
    expect(lastCall().messages).toEqual([{ role: "user", parts: [{ type: "text", text: "[文件：doc.pdf]" }] }]);
  });
});

describe("reading attachments", () => {
  it("happens with no transaction open: the owner's message is accepted and a pause answers while a file is being read; the pause then ends the run without a model call", async () => {
    const { owner, agent, conv } = await owned("hang");
    let open!: () => void;
    let reached!: () => void;
    const reading = new Promise<void>((resolve) => (reached = resolve));
    held = { opened: new Promise<void>((resolve) => (open = resolve)), reached };
    try {
      await sendFile(owner, conv, "pixel.png", PNG, "看图");
      const calls = gateway.calls.length;
      const running = app.agentWorker.runOnce();
      await reading;
      // Both take the conversation's lock; neither waits for the read.
      const later = await say(owner, conv, "还在吗？");
      expect(later.text).toBe("还在吗？");
      expect((await api(app, owner, "POST", `/api/agents/${agent.id}/pause`)).status).toBe(200);
      open();
      await running;
      expect(gateway.calls.length).toBe(calls);
      const run = await latestRun(owner, conv);
      expect(run).toEqual({ id: run.id, status: "cancelled", error: "agent_paused", retryable: false });
      expect(await fromAgent(owner, conv, agent.id)).toEqual([]);
      // Never admitted: nothing held, nothing charged.
      expect((await db.query("select source, hold_micro::text as hold from agent_runs where id = $1", [run.id])).rows).toEqual([
        { source: null, hold: "0" },
      ]);
    } finally {
      held = null;
      open();
    }
  });

  it("holds at most 20 MiB of attachments in one call", () => {
    const pdf = (i: number): ContextEntry => ({ role: "user", text: "", attachment: { id: `a${i}`, name: `${i}.pdf`, image: false } });
    const plan = new ContextPlan([0, 1, 2].map(pdf), 100_000_000);
    expect(CALL_ATTACHMENT_MAX_BYTES).toBe(20 * 1024 * 1024);
    const tenMegabytes = new Uint8Array(10 * 1024 * 1024);
    const offered = plan.attachments(false).map(([slot]) => plan.offer(slot, { type: "pdf", data: tenMegabytes }));
    // Newest first: two of 10 MiB fill it; the oldest is named.
    expect(offered).toEqual([true, true, false]);
    expect(plan.bytesLeft).toBe(0);
    expect(plan.build().messages[0]!.parts[0]).toEqual({ type: "text", text: "[文件：0.pdf]" });
  });
});

describe("a reply with no call", () => {
  it("one that started over is followed by a reply to what its owner wrote while it ended", async () => {
    const { owner, conv } = await owned("follow");
    await say(owner, conv, "旧话题的话");
    expect((await api(app, owner, "POST", `/api/conversations/${conv}/topic`)).status).toBe(201);
    // The worker's steps by hand, so the owner can write between begin and finish.
    const run = (await app.agentPort.claimNext())!;
    const end = await app.agentPort.begin(run);
    expect(end).toEqual({ status: "cancelled" });
    const later = await say(owner, conv, "新话题的第一句");
    await app.agentPort.finish(run, end as RunEnd, null, { inputChars: 0, outputChars: 0 });
    expect((await db.query("select status, error from agent_runs where id = $1", [run.id])).rows).toEqual([{ status: "cancelled", error: null }]);
    const next = await latestRun(owner, conv);
    expect(next).toMatchObject({ status: "queued" });
    expect((await db.query("select covers_seq::int as c from agent_runs where id = $1", [next.id])).rows).toEqual([{ c: later.seq }]);
    await answer("好的。");
    expect(lastCall().messages).toEqual([{ role: "user", parts: [{ type: "text", text: "新话题的第一句" }] }]);
  });

  it("a model whose context cannot hold the owner's message fails context_too_small, not retryable, and is not called", async () => {
    const owner = await signUp(app, "smallctx");
    const provider = (await api(app, owner, "POST", "/api/providers", providerBody({ models: [{ name: "small", contextTokens: 16_000 }] }))).json;
    const agent = await mustCreateAgent(app, owner, { model: { source: "provider", providerId: provider.id, model: "small" }, persona: PERSONA });
    // Its context is then set below the output limit its calls get (2 048): nothing is left for the conversation.
    expect((await api(app, owner, "PATCH", `/api/providers/${provider.id}`, { models: [{ name: "small", contextTokens: 1000 }] })).status).toBe(200);
    expect(app.deps.config.providerDefaultMaxOutputTokens).toBeGreaterThan(1000);
    const calls = gateway.calls.length;
    await say(owner, agent.conversationId, "你好");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(gateway.calls.length).toBe(calls);
    const run = await latestRun(owner, agent.conversationId);
    expect(run).toEqual({ id: run.id, status: "failed", error: "context_too_small", retryable: false });
    expect((await db.query("select source, cost_micro::text as cost from usage_records where run_id = $1", [run.id])).rows).toEqual([
      { source: null, cost: "0" },
    ]);
  });

  it("the conversation must have room for the owner's newest message whole, or for 200 tokens of it", async () => {
    // A 2 000-token context, 200 of them for the output, and a persona that leaves under 200 for the conversation (the
    // system text without the persona is about 500 characters).
    const { owner, conv } = await owned("roomy", "tiny", { persona: "简".repeat(1_230) });
    await say(owner, conv, "你好");
    await answer("好。");
    const budget = 2000 - 200 - estimateTokens(lastCall().system);
    expect(budget).toBeGreaterThan(60);
    expect(budget).toBeLessThan(200);

    const calls = gateway.calls.length;
    await say(owner, conv, "长".repeat(300));
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(gateway.calls.length).toBe(calls);
    expect(await latestRun(owner, conv)).toMatchObject({ status: "failed", error: "context_too_small", retryable: false });

    // A message that fits whole is answered (what does not fit before it is left out).
    await say(owner, conv, "短一点：".concat("字".repeat(40)));
    await answer("收到。");
    expect(textsOf(lastCall()).at(-1)).toBe("短一点：".concat("字".repeat(40)));
  });
});

describe("the context budget", () => {
  it("with a 2 000-token context the oldest turns are gone and the newest owner message is there", async () => {
    const { owner, agent, conv } = await owned("tiny", "tiny");
    expect((await api(app, owner, "POST", `/api/agents/${agent.id}/pause`)).status).toBe(200);
    const sent = Array.from({ length: 10 }, (_, i) => `M${i}:${"字".repeat(296)}`);
    for (const text of sent) await say(owner, conv, text);
    expect((await api(app, owner, "POST", `/api/agents/${agent.id}/resume`)).status).toBe(200);
    await say(owner, conv, "最后一句");
    await answer("好。");
    const call = lastCall();
    const texts = textsOf(call);
    expect(texts.at(-1)).toBe("最后一句");
    expect(texts).not.toContain(sent[0]);
    // The newest that fit, with no gap.
    const kept = texts.slice(0, -1);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept).toEqual(sent.slice(sent.length - kept.length));
    const used = estimateTokens(call.system) + texts.reduce((n, t) => n + estimateTokens(t), 0);
    expect(used).toBeLessThanOrEqual(2000 - 200);
    expect(used + 300).toBeGreaterThan(2000 - 200);
  });

  it("the newest owner message alone over the budget is cut from the front", async () => {
    const { owner, conv } = await owned("huge", "tiny");
    await say(owner, conv, `HEAD${"长".repeat(5000)}TAIL`);
    await answer("太长了。");
    const call = lastCall();
    const [text] = textsOf(call);
    expect(text!.startsWith("…")).toBe(true);
    expect(text!.endsWith("TAIL")).toBe(true);
    expect(text).not.toContain("HEAD");
    // It fills the budget: what the context leaves beside the output limit and the system text, less the tenth kept free.
    expect(estimateTokens(text!)).toBe(Math.floor((2000 - 200 - estimateTokens(call.system)) * (1 - CONTEXT_HEADROOM)));
  });

  // An 8 000-token context with 500 for the output: about 7 300 tokens for the conversation; an image counts 1 500.
  it("an older message's attachment goes, leaving its name, before older messages do", async () => {
    const { owner, agent, conv } = await owned("midold", "mid");
    const early = `早${"文".repeat(5999)}`;
    expect((await api(app, owner, "POST", `/api/agents/${agent.id}/pause`)).status).toBe(200);
    await say(owner, conv, early);
    await sendFile(owner, conv, "old.png", PNG, "旧图");
    expect((await api(app, owner, "POST", `/api/agents/${agent.id}/resume`)).status).toBe(200);
    await say(owner, conv, "看图");
    await answer("看不清。");
    await say(owner, conv, "比较");
    await answer("比较完了。");
    // The image would fit without the long first message; that message stays, the image is named.
    expect(lastCall().messages).toEqual([
      {
        role: "user",
        parts: [
          { type: "text", text: early },
          { type: "text", text: "旧图" },
          { type: "text", text: "[图片：old.png]" },
          { type: "text", text: "看图" },
        ],
      },
      { role: "assistant", parts: [{ type: "text", text: "看不清。" }] },
      { role: "user", parts: [{ type: "text", text: "比较" }] },
    ]);
  });

  it("the image the owner just sent is kept before older messages", async () => {
    const { owner, agent, conv } = await owned("midnew", "mid");
    await sendFile(owner, conv, "old.png", PNG, "旧图");
    await answer("看到旧图了。");
    expect((await api(app, owner, "POST", `/api/agents/${agent.id}/pause`)).status).toBe(200);
    const sent = Array.from({ length: 6 }, (_, i) => `段${i}${"文".repeat(997)}`);
    for (const text of sent) await say(owner, conv, text);
    expect((await api(app, owner, "POST", `/api/agents/${agent.id}/resume`)).status).toBe(200);
    await say(owner, conv, "继续");
    await answer("好的。");
    await sendFile(owner, conv, "new.png", PNG, "比较一下");
    await answer("比较完了。");
    const { messages } = lastCall();
    expect(messages.at(-1)).toEqual({
      role: "user",
      parts: [
        { type: "text", text: "比较一下" },
        { type: "image", mime: "image/png", data: PNG },
      ],
    });
    // Older messages fill what is left after it, newest first: the oldest no longer fit.
    const texts = messages.slice(0, -1).flatMap((m) => m.parts.map((p) => (p.type === "text" ? p.text : p.type)));
    expect(texts.slice(-3)).toEqual([sent[5], "继续", "好的。"]);
    expect(texts).not.toContain(sent[0]);
    expect(texts).not.toContain("旧图");
  });

  it("in a group the budget is what the system text leaves, its roster included: a full roster still leaves the newest message whole; once a longer persona leaves too little for it, the run fails context_too_small with no call", async () => {
    const [owner, mia, ned] = [await signUp(app, "rosterown"), await signUp(app, "rostermia"), await signUp(app, "rosterned")];
    const g = await group(app, owner, "大群", [mia, ned]);
    const agent = await mustCreateAgent(app, owner, { handle: "roster_bot", model: { source: "site", id: "tiny" }, persona: PERSONA });
    expect((await api(app, owner, "POST", `/api/conversations/${g}/members`, { principalId: agent.id })).status).toBe(201);
    for (let i = 1; i <= 40; i++) await seatPerson(app, g, `成员${String(i).padStart(2, "0")}`, 1000 + i);
    await say(mia, g, "@roster_bot 你好");
    await answer("好。");
    const call = lastCall();
    expect(call.system.match(/^- 〔/gm)).toHaveLength(30);
    expect(call.system).toContain("\n……群里还有别的人，这里没有一一列出。\n");
    const [newest] = textsOf(call);
    expect(textsOf(call)).toEqual([`〔${markOf(call)} rostermia｜群成员〕@roster_bot 你好`]);
    const left = 2000 - 200 - estimateTokens(call.system);
    expect(estimateTokens(newest!)).toBeLessThan(left);

    // A persona longer by all but 10 of the tokens left: the system text, roster and all, leaves too little.
    expect((await api(app, owner, "PATCH", `/api/agents/${agent.id}`, { persona: `${PERSONA}${"简".repeat(left - 10)}` })).status).toBe(200);
    const calls = gateway.calls.length;
    await say(mia, g, "@roster_bot 你好");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(gateway.calls.length).toBe(calls);
    expect((await db.query("select status, error from agent_runs where agent_id = $1 order by created_at desc, id limit 1", [agent.id])).rows).toEqual([
      { status: "failed", error: "context_too_small" },
    ]);
  });
});

describe("a persona the Agent proposed", () => {
  const proposalsOf = async (agentId: string) =>
    (await db.query("select status from persona_proposals where agent_id = $1", [agentId])).rows.map((r) => r.status);

  it("is shown to it again in its assistant turn, as the block it wrote, after the reply's text; and is not read as a new one", async () => {
    const { owner, agent, conv } = await owned("proposer");
    await say(owner, conv, "帮我想个设定");
    await answer("好的，我整理了一下。\n<af-intro>读书伙伴</af-intro>\n<af-persona>你是一个陪主人读书的伙伴。</af-persona>");
    expect((await fromAgent(owner, conv, agent.id))[0].text).toBe("好的，我整理了一下。");
    await say(owner, conv, "再活泼一点");
    await answer("好，我再改改。");
    expect(lastCall().messages).toEqual([
      { role: "user", parts: [{ type: "text", text: "帮我想个设定" }] },
      {
        role: "assistant",
        parts: [{ type: "text", text: "好的，我整理了一下。\n\n<af-intro>读书伙伴</af-intro>\n<af-persona>你是一个陪主人读书的伙伴。</af-persona>" }],
      },
      { role: "user", parts: [{ type: "text", text: "再活泼一点" }] },
    ]);
    // Only the new reply was read for a block: the re-rendered one made nothing.
    expect(await proposalsOf(agent.id)).toEqual(["open"]);
  });

  it("from before a new topic is not shown", async () => {
    const { owner, agent, conv } = await owned("topicprop");
    await say(owner, conv, "想个设定");
    await answer("<af-persona>旧话题里的设定。</af-persona>");
    expect(await proposalsOf(agent.id)).toEqual(["open"]);
    expect((await api(app, owner, "POST", `/api/conversations/${conv}/topic`)).status).toBe(201);
    await say(owner, conv, "新话题");
    await answer("好。");
    expect(lastCall().messages).toEqual([{ role: "user", parts: [{ type: "text", text: "新话题" }] }]);
  });

  it("counts toward the budget: a 10 000-character proposal that does not fit is left out with what is older", async () => {
    // An 8 000-token context with 500 for the output.
    const { owner, agent, conv } = await owned("bigprop", "mid");
    await say(owner, conv, "写一份很长的设定");
    const persona = "设".repeat(10_000);
    await answer(`<af-persona>${persona}</af-persona>`);
    expect(await proposalsOf(agent.id)).toEqual(["open"]);
    await say(owner, conv, "收到了吗");
    await answer("收到了。");
    const call = lastCall();
    expect(textsOf(call)).toEqual(["收到了吗"]);
    const budget = 8000 - 500 - estimateTokens(call.system);
    expect(budget).toBeLessThan(10_000);

    // With room for it, it is there in full: the reply had no text of its own (no sentence stands in for it), only the block.
    const roomy = await owned("bigroom", "eyes");
    await say(roomy.owner, roomy.conv, "写一份很长的设定");
    await answer(`<af-persona>${persona}</af-persona>`);
    await say(roomy.owner, roomy.conv, "收到了吗");
    await answer("收到了。");
    expect(textsOf(lastCall())[1]).toBe(`<af-persona>${persona}</af-persona>`);
  });
});

describe("reasoning", () => {
  it("is stored with the reply (at most 32 000 characters) and returned, but never sent to a model again or found by search", async () => {
    const { owner, agent, conv } = await owned("rsn");
    const thought = `思考SECRETTHOUGHT${"想".repeat(40_000)}`;
    await say(owner, conv, "一加一？");
    await answer("二。", { reasoning: thought });
    const [reply] = await fromAgent(owner, conv, agent.id);
    expect(reply.reasoning).toBe(Array.from(thought).slice(0, 32_000).join(""));
    expect((await api(app, owner, "GET", "/api/search?q=SECRETTHOUGHT")).json.messages).toEqual([]);

    await say(owner, conv, "再加一？");
    await answer("三。");
    expect(lastCall().messages).toEqual([
      { role: "user", parts: [{ type: "text", text: "一加一？" }] },
      { role: "assistant", parts: [{ type: "text", text: "二。" }] },
      { role: "user", parts: [{ type: "text", text: "再加一？" }] },
    ]);
    expect(JSON.stringify(lastCall())).not.toContain("SECRETTHOUGHT");
  });

  it("the call carries the Agent's level when the model lists it, else the nearest listed level below it", async () => {
    const { owner, agent, conv } = await owned("lvl", "eyes", { reasoning: "medium" });
    await say(owner, conv, "想一想");
    await answer("想好了。");
    expect(lastCall().reasoning).toBe("medium");
    // A level the model does not (or no longer) offer, e.g. after the site's configuration changed.
    await db.query("update agents set reasoning = 'high' where principal_id = $1", [agent.id]);
    await say(owner, conv, "再想想");
    await answer("又想好了。");
    expect(lastCall().reasoning).toBe("medium");
  });
});

describe("reading files for the model", () => {
  it("decides text by its bytes: valid UTF-8 without NUL and with few control characters", () => {
    const utf8 = (s: string) => new Uint8Array(Buffer.from(s, "utf8"));
    const text = (bytes: Uint8Array, complete: boolean, maxChars: number) => fileText(bytes, complete, maxChars)?.text ?? null;
    // A form feed does not make it binary; like every control character but tab and line breaks it is not passed on.
    expect(text(utf8("hello\r\n\tworld\f"), true, 100)).toBe("hello\r\n\tworld");
    expect(text(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]), true, 100)).toBe("hi");
    expect(text(new Uint8Array([0x68, 0x00, 0x69]), true, 100)).toBeNull();
    expect(text(new Uint8Array([0x68, 0xc3, 0x28]), true, 100)).toBeNull();
    expect(text(utf8(`${"\u001b".repeat(2)}${"x".repeat(98)}`), true, 1000)).toBeNull();
    expect(text(utf8(`\u001b${"x".repeat(99)}`), true, 1000)).toBe("x".repeat(99));
    expect(text(new Uint8Array(0), true, 100)).toBeNull();
    // Cut inside a character: the partial character is dropped, and the text is marked cut.
    const word = utf8("你好");
    expect(fileText(word.subarray(0, 4), false, 100)).toEqual({ text: `你${CUT_MARK}`, chars: 1 });
    expect(fileText(utf8("abcdef"), true, 3)).toEqual({ text: `abc${CUT_MARK}`, chars: 3 });
    expect(fileText(utf8("abc"), true, 3)).toEqual({ text: "abc", chars: 3 });
  });

  it("reads at most what it is allowed, and gives up on a blob that does not come", async () => {
    const stalled: BlobStore = {
      put: async () => ({ size: 0 }),
      get: () => new Promise<Readable>(() => {}),
      delete: async () => {},
    };
    await expect(readPrefix(stalled, "att-x", 10, { timeoutMs: 50 })).rejects.toThrow(/did not arrive/);

    let pulled = 0;
    const endless: BlobStore = {
      ...stalled,
      get: async () =>
        new Readable({
          read() {
            pulled++;
            this.push(Buffer.alloc(1024, 0x61));
          },
        }),
    };
    const read = await readPrefix(endless, "att-y", 5000, { timeoutMs: 1000 });
    expect(read).toMatchObject({ complete: false });
    expect(read!.data.length).toBe(5000);
    expect(pulled).toBeLessThan(20);

    const missing: BlobStore = { ...stalled, get: async () => Promise.reject(Object.assign(new Error("gone"), { code: "ENOENT" })) };
    expect(await readPrefix(missing, "att-z", 10, { timeoutMs: 1000 })).toBeNull();
  });
});
