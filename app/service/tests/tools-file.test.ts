import { afterEach, describe, expect, it } from "vitest";
import { createAgentPort } from "../src/agents/port-impl.ts";
import { createAgentWorker, type AgentWorker } from "../src/agents/runtime/worker.ts";
import { createToolbox, READ_FILE, runTool, type ToolDeps } from "../src/agents/tools/index.ts";
import { RunRefs } from "../src/agents/tools/refs.ts";
import { weight } from "../src/metering/tokens.ts";
import type { ModelCall } from "../src/models/gateway.ts";
import { TOOL_MATERIAL } from "../src/agents/runtime/prompt.ts";
import { api, befriend, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useProbeBlobs } from "./helpers/blobs.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { MULTIPART, multipart } from "./helpers/multipart.ts";

/**
 * The file tool (`read_file`, agents/tools/file.ts) and the file numbers the model is shown, on the real port, toolbox and
 * database: every attachment label of a reply offered tools carries its number, as a token with the run's tag; a text
 * file is read in pages; anything else is refused with a fixed error; a file is read only where the reply may see it.
 */

const gateway = scriptedGateway();
const { blobs } = useProbeBlobs("af-tools-file-");
const { app, db } = useApp({ env: SITE_ENV, models: gateway, blobs, agentWorker: false });

afterEach(() => {
  expect(gateway.pending()).toBe(0);
});

const FAST = { source: "site", id: "fast" } as const;
/** The tag of every run of this file's port (tools/refs.ts): what its tokens carry. */
const TAG = "k7q2";

function deps(over: Partial<ToolDeps> = {}): ToolDeps {
  const { db: pool, config, searches } = app.deps;
  return { db: pool, blobs, searches, config, log: app.log, ...over };
}
function toolWorker(d: ToolDeps = deps()): AgentWorker {
  const { db: pool, blobs: store, conversations, reads, config } = app.deps;
  const port = createAgentPort({ db: pool, config, blobs: store, realtime: app.realtime, conversations, reads, log: app.log, toolbox: createToolbox(d), drawTag: () => TAG });
  return createAgentWorker({ port, models: gateway, runTimeoutMs: config.agentRunTimeoutMs, maxRunsInFlight: 1, background: false, log: app.log, tools: config.tools });
}

let txn = 0;
const say = async (who: Actor, conv: string, text: string): Promise<number> => {
  const sent = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `tf${++txn}` });
  if (sent.status !== 201) throw new Error(`say: ${sent.status} ${JSON.stringify(sent.json)}`);
  return sent.json.message.seq as number;
};
/** Uploads `data` as `filename` (`type`) and sends it to `conv`; the attachment's id and the message's seq. */
async function sendFile(who: Actor, conv: string, filename: string, data: string | Buffer, type = "application/octet-stream") {
  const uploaded = await app.inject({
    method: "POST",
    url: `/api/conversations/${conv}/attachments`,
    headers: { cookie: who.cookie, "content-type": MULTIPART },
    payload: multipart([{ name: "file", filename, type, data }]),
  });
  expect(uploaded.statusCode).toBe(201);
  const id = uploaded.json().id as string;
  const sent = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { attachmentId: id, clientTxn: `tf${++txn}` });
  expect(sent.status).toBe(201);
  return { id, seq: sent.json.message.seq as number };
}
const outputs = (call: ModelCall): any[] => (call.steps ?? []).flatMap((s) => s.results.map((r) => r.output));
const textsOf = (call: ModelCall): string[] => call.messages.flatMap((m) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])));
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgAAACAAAB4iG8MwAAAABJRU5ErkJggg==", "base64");
const PDF = Buffer.from("%PDF-1.4\n1 0 obj <<>> endobj\ntrailer <<>>\n%%EOF\n");

async function owned(name = "olive") {
  const owner = await signUp(app, name);
  const agent = await mustCreateAgent(app, owner, { handle: `${name}_bot`, name: "小助手", model: FAST, persona: "简短地回答。" });
  return { owner, agent, own: agent.conversationId as string };
}
/** One reply in `conv` whose first round reads `input`: what it gave. */
async function readOnce(asker: Actor, conv: string, question: string, input: Record<string, unknown>, d?: ToolDeps) {
  await say(asker, conv, question);
  gateway.callTools([{ name: READ_FILE, input }]).reply("好。");
  expect(await toolWorker(d).runOnce()).toBe(true);
  return outputs(gateway.calls.at(-1)!)[0];
}

describe("the numbers the model is shown", () => {
  it("offered tools, every attachment label carries its file's number as the run's token; offered none, the labels are as they always were", async () => {
    const { owner, own } = await owned();
    await sendFile(owner, own, "notes.txt", "第一行笔记");
    await sendFile(owner, own, "photo.png", PNG, "image/png");
    await say(owner, own, "看看这两个");
    gateway.reply("好。");
    expect(await toolWorker().runOnce()).toBe(true);
    const offered = textsOf(gateway.calls.at(-1)!);
    // Numbered as they are read, the newest first.
    expect(offered).toContain("[图片 〔f1·k7q2〕：photo.png]");
    expect(offered).toContain("[文件 〔f2·k7q2〕：notes.txt]\n第一行笔记");

    await say(owner, own, "再看看");
    gateway.reply("好。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    const plain = textsOf(gateway.calls.at(-1)!);
    expect(plain).toContain("[图片：photo.png]");
    expect(plain).toContain("[文件：notes.txt]\n第一行笔记");
    expect(plain.join("\n")).not.toMatch(/f\d|〔/);
  });
});

describe("reading a file", () => {
  it("a text file by its number: its name and text, from 0, nothing more to read", async () => {
    const { owner, own } = await owned();
    await sendFile(owner, own, "notes.txt", "第一行\nsecond line\n");
    const out = await readOnce(owner, own, "读一下那个文件", { file: "f1" });
    expect(out).toEqual({ about: TOOL_MATERIAL, name: "notes.txt", from: 0, next: null, text: "第一行\nsecond line\n" });
  });

  it("a long one in pages: each at most resultMaxWeight, with where to go on (`next`) and a note while more remains; read on with `from` to the end", async () => {
    const { owner, own } = await owned();
    const text = Array.from({ length: 60 }, (_, i) => `第${i}段：一些内容。`).join("\n");
    await sendFile(owner, own, "long.txt", text);
    const small = deps({ config: { ...app.deps.config, tools: { ...app.deps.config.tools, resultMaxWeight: 200 } } });
    let from = 0;
    let read = "";
    for (let page = 0; page < 20; page++) {
      const out = await readOnce(owner, own, `第${page}页`, page === 0 ? { file: "f1" } : { file: "f1", from }, small);
      expect(out.from).toBe(from);
      expect(weight(JSON.stringify(out))).toBeLessThanOrEqual(200);
      read += out.text;
      if (out.next === null) {
        expect(out).not.toHaveProperty("note");
        break;
      }
      expect(out.note).toBe("只读了一部分，可以用 from 接着读。");
      expect(out.next).toBe(from + Array.from(out.text as string).length);
      from = out.next;
    }
    expect(read).toBe(text);
  });

  it("images, PDFs and anything that is not text: the fixed error; a number it was never given, or a blob that is gone: an error of its own", async () => {
    const { owner, own } = await owned();
    await sendFile(owner, own, "photo.png", PNG, "image/png");
    expect(await readOnce(owner, own, "看图", { file: "f1" })).toEqual({ error: "这种文件我读不了内容。" });
    const pdf = await sendFile(owner, own, "report.pdf", PDF, "application/pdf");
    // The newest is f1 in each reply's own numbering.
    expect(await readOnce(owner, own, "看报告", { file: "f1" })).toEqual({ error: "这种文件我读不了内容。" });
    await sendFile(owner, own, "blob.bin", Buffer.from([0, 1, 2, 3, 0, 0, 255, 254]));
    expect(await readOnce(owner, own, "看这个", { file: "f1" })).toEqual({ error: "这种文件我读不了内容。" });
    expect(await readOnce(owner, own, "看那个", { file: "f9" })).toEqual({ error: "没有这个文件编号。" });
    const gone = await sendFile(owner, own, "gone.txt", "会被删掉的内容");
    const key = (await db.query<{ blob_key: string }>("select blob_key from attachments where id = $1", [gone.id])).rows[0]!.blob_key;
    await blobs.delete(key);
    expect(await readOnce(owner, own, "看丢了的", { file: "f1" })).toEqual({ error: "这个文件的内容找不到了。" });
    expect(pdf.seq).toBeGreaterThan(0);
  });

  it("`from` past the end of the file: an error saying so", async () => {
    const { owner, own } = await owned();
    await sendFile(owner, own, "short.txt", "短");
    expect(await readOnce(owner, own, "从后面读", { file: "f1", from: 5 })).toEqual({ error: "from 超出了文件的长度。" });
  });

  it("a page says first that it is material (`about`: TOOL_MATERIAL), then its name, where it starts, where to go on and the note, the text last — so a cut keeps them", async () => {
    const { owner, own } = await owned();
    const text = Array.from({ length: 60 }, (_, i) => `第${i}段：一些内容。`).join("\n");
    await sendFile(owner, own, "long.txt", text);
    const small = deps({ config: { ...app.deps.config, tools: { ...app.deps.config.tools, resultMaxWeight: 200 } } });
    const out = await readOnce(owner, own, "读", { file: "f1" }, small);
    expect(Object.keys(out)).toEqual(["about", "name", "from", "next", "note", "text"]);
    expect(out.about).toBe(TOOL_MATERIAL);
  });

  it("a negative `from`: an error of its own", async () => {
    const { owner, own } = await owned();
    await sendFile(owner, own, "short.txt", "短");
    expect(await readOnce(owner, own, "从前面读", { file: "f1", from: -1 })).toEqual({ error: "from 要写 0 或更大的整数。" });
  });

  it("a file is shown as it is, read by the tool or in the context, its text and its name: what looks like a citation in it is what someone wrote; it is read by its token too", async () => {
    const { owner, own } = await owned();
    await sendFile(owner, own, "引用〔m3〕.txt", "第一行〔m1〕\n第二行〔f2·k7q2〕结束");
    const out = await readOnce(owner, own, "读一下", { file: "〔f1·k7q2〕" });
    expect([out.name, out.text]).toEqual(["引用〔m3〕.txt", "第一行〔m1〕\n第二行〔f2·k7q2〕结束"]);
    const shown = JSON.stringify(gateway.calls.at(-1)!.messages);
    expect(shown).toContain("[文件 〔f1·k7q2〕：引用〔m3〕.txt]");
    expect(shown).toContain("第一行〔m1〕\\n第二行〔f2·k7q2〕结束");
  });

  it("in a group, a file from before the run's asker's line is not read, whatever number is given for it", async () => {
    const [owner, mia] = [await signUp(app, "owen"), await signUp(app, "mia")];
    const agent = await mustCreateAgent(app, owner, { handle: "owen_bot", name: "小助手", model: FAST, persona: "简短地回答。" });
    const g = await group(app, owner, "饭搭子", [mia, await signUp(app, "ned")]);
    expect((await api(app, owner, "POST", `/api/conversations/${g}/members`, { principalId: agent.id })).status).toBe(201);
    const early = await sendFile(mia, g, "early.txt", "早先的文件内容");
    const sam = await signUp(app, "sam");
    await befriend(app, owner, sam);
    expect((await api(app, owner, "POST", `/api/conversations/${g}/members`, { principalId: sam.id })).status).toBe(201);
    await say(sam, g, "@owen_bot 早先那个文件写了什么？");
    const run = (await db.query<{ id: string }>("select id from agent_runs where agent_id = $1 and conversation_id = $2", [agent.id, g])).rows[0]!.id;
    const refs = new RunRefs();
    const ref = refs.file(early.id, { conversationId: g, seq: early.seq });
    const heardTo = Number((await db.query<{ seq: string }>("select seq::text from conversations where id = $1", [g])).rows[0]!.seq);
    const scope = { id: run, agentId: agent.id, ownerId: owner.id, conversationId: g, group: true, refs, heardTo, mark: null };
    const out = await runTool(deps(), scope, { id: "c1", name: READ_FILE, input: { file: ref } }, new AbortController().signal);
    expect(out.output).toEqual({ error: "这个文件现在看不到了。" });
    // A file sent after the line (and within what the reply heard) is read.
    const later = await sendFile(mia, g, "later.txt", "后来的文件内容");
    const after = refs.file(later.id, { conversationId: g, seq: later.seq });
    const heardNow = Number((await db.query<{ seq: string }>("select seq::text from conversations where id = $1", [g])).rows[0]!.seq);
    const read = await runTool(deps(), { ...scope, heardTo: heardNow }, { id: "c2", name: READ_FILE, input: { file: after } }, new AbortController().signal);
    expect(read.output).toEqual({ about: TOOL_MATERIAL, name: "later.txt", from: 0, next: null, text: "后来的文件内容" });
  });
});
