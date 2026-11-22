// @vitest-environment jsdom
// The conversation with one of my Agents, over the real data layer with the fake transport and fake routes: the
// streaming bubble and its thinking, 停止生成, the run's status line, pause and delete, a new topic, proposal cards,
// the image hint, scrolling, mentions, read receipts and the details panel.
import "./markdown-ready.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import {
  A1,
  AG1,
  ANN,
  D1,
  ME_ID,
  MODELS,
  P1,
  PRINCIPALS,
  agentConv,
  agentOf,
  agentPrincipal,
  apiError,
  deferred,
  direct,
  fakeFile,
  notice,
  providerOf,
  runOf,
  syncOf,
  usageOf,
  wire,
} from "./fixtures.js";
import { click, dialog, elapse, flush, installBrowser, mainText, openApp, push, toastText } from "./harness.jsx";
import { useWorkers } from "./markdown-worker.js";
import { forgetRevealed, thinkingLine, useThinkingSeconds } from "../src/pages/AgentChatBits.jsx";
import { REPLY_POINTS_KEY, setShowReplyPoints } from "../src/data/prefs.js";
import { REVEAL_FINISH_MS, REVEAL_MAX_LAG_MS, setRevealFrames } from "../src/ui/reveal.js";

beforeEach(() => installBrowser());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  // (How much of a reply its bubble had shown is kept by run id for the page's life; a run id is never used twice
  // there, but these tests use R1 and R2 again and again.)
  forgetRevealed(R1);
  forgetRevealed(R2);
});

const R1 = "00000000-0000-4000-8000-0000000000e5";
const R2 = "00000000-0000-4000-8000-0000000000e6";
const STRAY = "00000000-0000-4000-8000-0000000000e9";
const PID = "00000000-0000-4000-8000-0000000000f7";
const SITE_FREE = { source: "site", id: "free-1" }; // no vision
const SITE_PAID = { source: "site", id: "paid-1" }; // vision
const PROVIDER_MODEL = { source: "provider", providerId: P1, model: "gpt-x" }; // no vision

const PAUSE_TEXT = "已暂停全部会话：它不会有新回复。与「停止生成」不同，这不是只中断一次回复。恢复后，暂停期间收到的消息不会补上回复。";
const DELETED_TEXT = "这个 Agent 已删除，聊天记录仍可查看";
const IMAGE_HINT = "当前模型看不到图片，只会知道文件名";

/** The greeting (seq 1) and my message (seq 2). */
const BASE = [wire(A1, 1, AG1, "你好，我是小助手"), wire(A1, 2, ME_ID, "在吗")];

/**
 * The app with my Agent 小助手 and its conversation open. `agent`: fields of its record; `conv`: of its conversation;
 * `run`: what `GET .../run` answers; `api`: route fakes; `handlers`: the sync engine's other answers.
 */
async function openAgentChat({ agent = {}, conv = {}, messages = BASE, run = null, api = {}, handlers = {}, providers = [], extra = [] } = {}) {
  const record = agentOf(AG1, { model: SITE_FREE, ...agent });
  const lastSeq = messages.reduce((max, m) => Math.max(max, m.seq), 0);
  const conversation = agentConv(A1, AG1, {
    lastSeq,
    readSeq: lastSeq,
    agent: { paused: record.paused, deleted: record.deleted },
    canSend: record.deleted ? { ok: false, reason: "agent_deleted" } : { ok: true },
    ...conv,
  });
  const sync = () => syncOf([conversation, ...extra], messages, [...PRINCIPALS, agentPrincipal()]);
  const app = await openApp({
    sync,
    api: {
      stopRun: vi.fn(async () => ({ ok: true })),
      retryRun: vi.fn(async () => ({ run: runOf(R2, "queued") })),
      dismissRun: vi.fn(async () => ({ ok: true })),
      resetTopic: vi.fn(async () => ({ message: notice(A1, lastSeq + 1, "Mei开始了新话题，之前的对话不再发给小助手", { event: "topic_reset", actorId: ME_ID }) })),
      confirmProposal: vi.fn(async () => agentOf(AG1, { model: SITE_FREE, persona: "新人格", personaVersion: 2 })),
      discardProposal: vi.fn(async () => ({ ok: true })),
      listProviders: vi.fn(async () => ({ providers })),
      uploadAttachment: vi.fn(() => new Promise(() => {})),
      ...api,
    },
    handlers: { agents: () => ({ agents: [record] }), agent: () => record, run: () => ({ run }), models: () => MODELS, ...handlers },
  });
  await click(screen.getByText("小助手", { selector: ".list-col .row-name" }));
  return app;
}

const timeline = () => document.querySelector("ol.messages");
const bubbleLi = () => timeline().querySelector("li.streaming");
const bubbleText = () => bubbleLi()?.querySelector(".bubble").textContent ?? null;
const statusLines = () => [...timeline().querySelectorAll("li.run-status")];
const statusLine = () => statusLines()[0] ?? null;
const storedLi = (seq) => timeline().querySelector(`li[data-msg="m${seq}"]`);
const runPush = (transport, run) => push(transport, { type: "run", conversationId: A1, run });
const deltaPush = (transport, fields) => push(transport, { type: "delta", conversationId: A1, runId: R1, ...fields });
const messagePush = (transport, message) => push(transport, { type: "message", message });
const input = () => screen.getByLabelText("消息内容");
/**
 * Lets the bubble reveal everything received: its frames run on the fake clock here (tests/setup.js), and no character
 * is shown later than REVEAL_MAX_LAG_MS after it came.
 */
const revealed = () => elapse(REVEAL_MAX_LAG_MS + 100);
const thinkingSummary = () => bubbleLi().querySelector("details > summary")?.textContent ?? null;

describe("the header and the list row", () => {
  it("carry the prototype's Agent tag; the header says it is my Agent's dedicated chat, nothing about friends", async () => {
    await openAgentChat();
    const row = screen.getByText("小助手", { selector: ".list-col .row-name" }).closest("button");
    expect(within(row).getByText("Agent", { selector: ".tag" })).toBeTruthy();
    const head = document.querySelector(".chat-head");
    expect(within(head).getByText("Agent", { selector: ".tag" })).toBeTruthy();
    expect(head.querySelector(".chat-title p").textContent).toBe("你的 Agent · 专属会话 · 小模型");
    expect(mainText()).not.toMatch(/好友|真人私聊/);
    expect(input().disabled).toBe(false);
  });

  it("the header names the Agent's model now, with its brand mark; the model opens the model picker right there; no model reads 未选模型", async () => {
    const subtitle = () => document.querySelector(".chat-head .chat-title p");
    await openAgentChat({ agent: { model: PROVIDER_MODEL }, providers: [providerOf()] });
    expect(subtitle().textContent).toBe("你的 Agent · 专属会话 · gpt-x");
    const model = within(subtitle()).getByRole("button", { name: "模型：gpt-x，点击更改" });
    expect(model.getAttribute("aria-haspopup")).toBe("listbox");
    expect(model.querySelector(".model-brand").dataset.brand).toBe("openai");
    await click(model);
    expect(screen.getByRole("listbox")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "搜索模型" }));
    // Still the conversation: no form opened.
    expect(screen.queryByLabelText("人格文档")).toBeNull();
    expect(model.getAttribute("aria-label")).toBe("模型：gpt-x，点击更改");
    cleanup();

    await openAgentChat({ agent: { model: SITE_PAID } });
    expect(subtitle().textContent).toBe("你的 Agent · 专属会话 · 大模型");
    expect(within(subtitle()).getByRole("button", { name: "模型：大模型，点击更改" }).querySelector(".model-brand").dataset.brand).toBe("generic");
    cleanup();

    await openAgentChat({ agent: { model: null } });
    expect(subtitle().textContent).toBe("你的 Agent · 专属会话 · 未选模型");
    expect(within(subtitle()).getByRole("button", { name: "模型：未选模型，点击更改" }).querySelector(".model-brand")).toBeNull();
  });

  it("an Agent whose model is gone (modelUsable false): the header's model button says 模型不可用, and still opens the picker", async () => {
    const subtitle = () => document.querySelector(".chat-head .chat-title p");
    await openAgentChat({ agent: { model: PROVIDER_MODEL, modelUsable: false }, providers: [providerOf()] });
    const model = within(subtitle()).getByRole("button", { name: "模型：gpt-x（模型不可用），点击更改" });
    expect(model.textContent).toBe("模型不可用");
    await click(model);
    expect(screen.getByRole("listbox")).toBeTruthy();
    cleanup();

    // Usable (or not said): the model's name, as always.
    await openAgentChat({ agent: { model: PROVIDER_MODEL, modelUsable: true }, providers: [providerOf()] });
    expect(within(subtitle()).getByRole("button", { name: "模型：gpt-x，点击更改" }).textContent).toBe("gpt-x");
  });

  it("a deleted Agent's row reads 已删除 after its tag", async () => {
    await openAgentChat({ agent: { deleted: true } });
    const row = screen.getByText("小助手", { selector: ".list-col .row-name" }).closest("button");
    expect([...row.querySelectorAll(".tag")].map((t) => t.textContent)).toEqual(["Agent", "已删除"]);
  });

  it("an Agent's message carries the Agent tag; my messages read 已读 up to the Agent's marker", async () => {
    await openAgentChat({ messages: [...BASE, wire(A1, 3, ME_ID, "还在吗")], conv: { peerReadSeq: 2 } });
    expect(within(storedLi(1)).getByText("Agent", { selector: ".tag" })).toBeTruthy();
    expect(storedLi(2).querySelector(".receipt").textContent.trim()).toBe("已读");
    expect(storedLi(3).querySelector(".receipt").textContent.trim()).toBe("已发送");
  });

  it("a message of mine that the Agent will not answer says why under 已发送: paused, or not named in 只在点名时回复", async () => {
    const receipt = (seq) => storedLi(seq).querySelector(".receipt").textContent.trim();
    await openAgentChat({ agent: { paused: true } });
    expect(receipt(2)).toBe("已发送 · 它暂停中");
    cleanup();

    await openAgentChat({ agent: { replyMode: "mention" } });
    expect(receipt(2)).toBe("已发送 · 没点名，它不会回复");
    cleanup();

    // Named — as the service stored it when it was sent (Task M: picked, or typed by handle or by name) — it will answer:
    // plain 已发送. Its text alone is not read: a message the service stored no mention of it for is not named.
    await openAgentChat({
      agent: { replyMode: "mention" },
      messages: [
        ...BASE,
        wire(A1, 3, ME_ID, "@Helper 在吗", { mentions: [{ id: AG1, start: 0, length: 7 }] }),
        wire(A1, 4, ME_ID, "@小助手 在吗", { mentions: [{ id: AG1, start: 0, length: 4 }] }),
        wire(A1, 5, ME_ID, "@小助手 在吗"),
      ],
    });
    expect(receipt(3)).toBe("已发送");
    expect(receipt(4)).toBe("已发送");
    expect(receipt(5)).toBe("已发送 · 没点名，它不会回复");
    cleanup();

    // Paused wins over the mode; read stays 已读.
    await openAgentChat({ agent: { paused: true, replyMode: "mention" }, conv: { peerReadSeq: 2 }, messages: [...BASE, wire(A1, 3, ME_ID, "还在吗")] });
    expect(receipt(2)).toBe("已读");
    expect(receipt(3)).toBe("已发送 · 它暂停中");
  });

  it("the list's preview is the stored message, never the streamed text", async () => {
    const { transport } = await openAgentChat();
    await runPush(transport, runOf(R1, "running"));
    await deltaPush(transport, { text: "正在写的秘密" });
    await revealed();
    const row = screen.getByText("小助手", { selector: ".list-col .row-name" }).closest("button");
    expect(row.querySelector(".row-preview").textContent).toBe("在吗");
    expect(bubbleText()).toBe("正在写的秘密");
  });
});

describe("which model and level a reply of mine used (via)", () => {
  const SOL = { model: { source: "site", id: "gpt-6-sol", label: "GPT-6 Sol" }, reasoning: "medium", points: "6.9" };
  const CLAUDE = { model: { source: "provider", model: "claude-x" }, reasoning: "none", points: "0" };
  const viaLine = (seq) => storedLi(seq).querySelector(".msg-via");
  beforeEach(() => {
    localStorage.clear();
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
  });

  it("a muted line under the reply: the model with its brand mark and the level; a site model by its label, a provider's by its name; no line without via", async () => {
    await openAgentChat({ messages: [...BASE, wire(A1, 3, AG1, "好的", { via: SOL }), wire(A1, 4, AG1, "嗯", { via: CLAUDE })] });
    expect(viaLine(1)).toBeNull(); // the greeting: no run posted it
    expect(viaLine(2)).toBeNull(); // mine
    expect(viaLine(3).textContent).toBe("GPT-6 Sol · 思考：中");
    expect(viaLine(3).querySelector(".lab-logo").dataset.brand).toBe("openai");
    expect(viaLine(4).textContent).toBe("claude-x · 不思考");
    expect(viaLine(4).querySelector(".lab-logo").dataset.brand).toBe("claude");
    // In its own conversation the header switches the model: the line under a reply is only a line.
    expect(viaLine(3).querySelector("button")).toBeNull();
    // Below the answer, not in it.
    const parts = [...storedLi(3).querySelector(".msg-main").children];
    expect(parts.indexOf(viaLine(3))).toBeGreaterThan(parts.indexOf(storedLi(3).querySelector(".bubble")));
    expect(storedLi(3).querySelector(".bubble").textContent).toBe("好的");
  });

  it("says each thinking level in words: 不思考, 思考：低, 中, 高, 很高, 最高", async () => {
    const levels = ["none", "low", "medium", "high", "xhigh", "max"];
    await openAgentChat({ messages: [...BASE, ...levels.map((reasoning, i) => wire(A1, 3 + i, AG1, `第${i}`, { via: { ...SOL, reasoning } }))] });
    expect(levels.map((_l, i) => viaLine(3 + i).textContent)).toEqual([
      "GPT-6 Sol · 不思考",
      "GPT-6 Sol · 思考：低",
      "GPT-6 Sol · 思考：中",
      "GPT-6 Sol · 思考：高",
      "GPT-6 Sol · 思考：很高",
      "GPT-6 Sol · 思考：最高",
    ]);
  });

  it("points only when the switch is on: · 6.9 点, at most 4 decimals; a provider's reply · 不扣点; turning it off or on changes an open conversation at once", async () => {
    const tiny = { ...SOL, points: "0.123456" };
    await openAgentChat({ messages: [...BASE, wire(A1, 3, AG1, "好的", { via: SOL }), wire(A1, 4, AG1, "嗯", { via: CLAUDE }), wire(A1, 5, AG1, "零头", { via: tiny })] });
    expect([3, 4, 5].map((seq) => viaLine(seq).textContent)).toEqual(["GPT-6 Sol · 思考：中", "claude-x · 不思考", "GPT-6 Sol · 思考：中"]);
    act(() => setShowReplyPoints(true));
    expect([3, 4, 5].map((seq) => viaLine(seq).textContent)).toEqual(["GPT-6 Sol · 思考：中 · 6.9 点", "claude-x · 不思考 · 不扣点", "GPT-6 Sol · 思考：中 · 0.1235 点"]);
    expect(localStorage.getItem(REPLY_POINTS_KEY)).toBe("1");
    act(() => setShowReplyPoints(false));
    expect(viaLine(3).textContent).toBe("GPT-6 Sol · 思考：中");
  });

  it("another tab turning the switch on or off shows on every open line at once, and the storage is not read again per line or per render", async () => {
    await openAgentChat({ messages: [...BASE, wire(A1, 3, AG1, "好的", { via: SOL }), wire(A1, 4, AG1, "嗯", { via: SOL }), wire(A1, 5, AG1, "再", { via: CLAUDE })] });
    expect([3, 4, 5].map((seq) => viaLine(seq).textContent)).toEqual(["GPT-6 Sol · 思考：中", "GPT-6 Sol · 思考：中", "claude-x · 不思考"]);
    const read = vi.spyOn(Storage.prototype, "getItem");
    // The other tab writes; the browser tells this page with a storage event.
    localStorage.setItem(REPLY_POINTS_KEY, "1");
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: REPLY_POINTS_KEY, newValue: "1" }));
    });
    expect([3, 4, 5].map((seq) => viaLine(seq).textContent)).toEqual(["GPT-6 Sol · 思考：中 · 6.9 点", "GPT-6 Sol · 思考：中 · 6.9 点", "claude-x · 不思考 · 不扣点"]);
    // One read for the event, not one per line; re-rendering the lines reads nothing.
    expect(read.mock.calls.filter(([key]) => key === REPLY_POINTS_KEY).length).toBeLessThanOrEqual(1);
    read.mockClear();
    act(() => setShowReplyPoints(true));
    act(() => setShowReplyPoints(true));
    expect(read).not.toHaveBeenCalled();
    // An event about another key changes nothing and reads nothing.
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: "something-else" }));
    });
    expect(read).not.toHaveBeenCalled();
    localStorage.removeItem(REPLY_POINTS_KEY);
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: REPLY_POINTS_KEY, newValue: null }));
    });
    expect([3, 4, 5].map((seq) => viaLine(seq).textContent)).toEqual(["GPT-6 Sol · 思考：中", "GPT-6 Sol · 思考：中", "claude-x · 不思考"]);
    read.mockRestore();
  });

  it("a proactive reply's line ends · 主动回复, after the points when shown; none without the key", async () => {
    await openAgentChat({
      messages: [
        ...BASE,
        wire(A1, 3, AG1, "好的", { via: { ...SOL, proactive: true } }),
        wire(A1, 4, AG1, "嗯", { via: { ...CLAUDE, proactive: true } }),
        wire(A1, 5, AG1, "再", { via: SOL }),
      ],
    });
    expect([3, 4, 5].map((seq) => viaLine(seq).textContent)).toEqual(["GPT-6 Sol · 思考：中 · 主动回复", "claude-x · 不思考 · 主动回复", "GPT-6 Sol · 思考：中"]);
    act(() => setShowReplyPoints(true));
    expect([3, 4, 5].map((seq) => viaLine(seq).textContent)).toEqual([
      "GPT-6 Sol · 思考：中 · 6.9 点 · 主动回复",
      "claude-x · 不思考 · 不扣点 · 主动回复",
      "GPT-6 Sol · 思考：中 · 6.9 点",
    ]);
    act(() => setShowReplyPoints(false));
  });

  it("the reply pushed again once its run is charged brings the line; a push without via shows none", async () => {
    const { transport } = await openAgentChat();
    await runPush(transport, runOf(R1, "running"));
    await messagePush(transport, wire(A1, 3, AG1, "你好呀"));
    expect(viaLine(3)).toBeNull();
    await messagePush(transport, wire(A1, 3, AG1, "你好呀", { via: SOL }));
    await runPush(transport, runOf(R1, "done"));
    expect(viaLine(3).textContent).toBe("GPT-6 Sol · 思考：中");
    expect(timeline().querySelectorAll('li[data-msg="m3"]')).toHaveLength(1);
  });
});

describe("an Agent conversation with nothing in it yet", () => {
  const HINT = "和 小助手 说点什么吧。";

  it("shows the system's hint (never a line as the Agent) while nothing is said and nothing is being replied", async () => {
    await openAgentChat({ messages: [] });
    const hint = within(timeline()).getByText(HINT);
    expect(hint.closest("li").className).toBe("msg-system");
    expect(timeline().querySelectorAll("li.msg")).toHaveLength(0);
  });

  it("also after its greeting could not be made (the service records that run cancelled: no failure, no 重试)", async () => {
    await openAgentChat({ messages: [], run: runOf(R1, "cancelled") });
    expect(within(timeline()).getByText(HINT)).toBeTruthy();
    expect(statusLine()).toBeNull();
  });

  it("not while its first reply is being written, nor once anything is said", async () => {
    await openAgentChat({ messages: [], run: runOf(R1, "queued") });
    expect(within(timeline()).queryByText(HINT)).toBeNull();
    cleanup();
    await openAgentChat();
    expect(within(timeline()).queryByText(HINT)).toBeNull();
  });
});

describe("the streaming bubble", () => {
  it("shows 正在回复… until the first piece, then the text so far, and the stored message replaces it", async () => {
    const { transport } = await openAgentChat();
    expect(bubbleLi()).toBeNull();
    await runPush(transport, runOf(R1, "queued"));
    expect(bubbleText()).toContain("正在回复…");
    expect(within(bubbleLi()).getByRole("button", { name: "停止生成" })).toBeTruthy();
    await runPush(transport, runOf(R1, "running"));
    // (An Agent that does not think: never 正在思考….)
    await elapse(3000);
    expect(bubbleText()).toContain("正在回复…");
    expect(bubbleText()).not.toContain("正在思考");
    await deltaPush(transport, { text: "你" });
    // Shown at the next frames, not the moment it came: 正在回复… until then.
    expect(bubbleText()).toContain("正在回复…");
    await revealed();
    expect(bubbleText()).toBe("你");
    await deltaPush(transport, { text: "好" });
    await revealed();
    expect(bubbleText()).toBe("你好");
    await messagePush(transport, wire(A1, 3, AG1, "你好呀"));
    expect(bubbleLi()).toBeNull();
    expect(storedLi(3).querySelector(".bubble").textContent).toBe("你好呀");
    await runPush(transport, runOf(R1, "done"));
    expect(bubbleLi()).toBeNull();
    expect(timeline().querySelectorAll('li[data-msg="m3"]')).toHaveLength(1);
  });

  it("a very long reply: the bubble keeps its first 20 000 characters and says so; later pieces touch nothing in it", async () => {
    const NOTE = "（内容较长，仅显示开头部分）";
    // (No Markdown worker here: the text stays the plain text it is, so what is in the bubble is exactly what was kept.)
    useWorkers(() => {
      throw new Error("no worker");
    });
    const { transport } = await openAgentChat();
    await runPush(transport, runOf(R1, "running"));
    const piece = "一二三四五六七八九十".repeat(200); // 2 000 characters
    for (let i = 0; i < 9; i += 1) await deltaPush(transport, { text: piece });
    expect(bubbleLi().querySelector(".md-note")).toBeNull();
    for (let i = 0; i < 3; i += 1) await deltaPush(transport, { text: piece });
    await flush();
    // (Nothing more will be kept: what is left is revealed within a moment.)
    await elapse(400);
    const text = bubbleLi().querySelector(".md-text");
    expect(text.textContent).toBe(piece.repeat(10));
    expect(bubbleText()).toBe(piece.repeat(10) + NOTE);
    const note = bubbleLi().querySelector(".bubble > .md-note");
    expect(note.textContent).toBe(NOTE);
    expect(note.previousElementSibling).toBe(text);
    // 200 000 characters in all: nothing in the bubble is touched by the pieces that follow.
    const leaves = [];
    const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) leaves.push([walker.currentNode, walker.currentNode.data]);
    const changes = [];
    const observer = new MutationObserver((records) => changes.push(...records));
    observer.observe(bubbleLi(), { subtree: true, childList: true, characterData: true, attributes: true });
    for (let i = 0; i < 88; i += 1) await deltaPush(transport, { text: piece });
    await flush();
    changes.push(...observer.takeRecords());
    observer.disconnect();
    expect(changes).toHaveLength(0);
    for (const [node, data] of leaves) {
      expect(node.isConnected).toBe(true);
      expect(node.data).toBe(data);
    }
    expect(text.textContent).toHaveLength(20000);
    // The stored message replaces the bubble as ever (the service keeps what it keeps).
    await messagePush(transport, wire(A1, 3, AG1, "完整的回复"));
    expect(bubbleLi()).toBeNull();
    expect(storedLi(3).querySelector(".bubble").textContent).toBe("完整的回复");
    expect(document.body.textContent).not.toContain(NOTE);
    useWorkers();
  });

  it("very long thinking is kept to its first 20 000 characters too, with the same line", async () => {
    const { transport } = await openAgentChat();
    await runPush(transport, runOf(R1, "running"));
    await deltaPush(transport, { reasoning: "想".repeat(20000) });
    const thinking = () => bubbleLi().querySelector("details .thinking-text");
    expect(thinking().textContent).toBe("想".repeat(20000));
    await deltaPush(transport, { reasoning: "再想" });
    expect(thinking().textContent).toBe(`${"想".repeat(20000)}（内容较长，仅显示开头部分）`);
    expect(thinking().querySelector(".md-note")).not.toBeNull();
  });

  it("thinking sits above the answer in a collapsed 思考过程; with only thinking so far it says 正在回复…", async () => {
    const { transport } = await openAgentChat();
    await runPush(transport, runOf(R1, "running"));
    await deltaPush(transport, { reasoning: "先想一想" });
    const thinking = bubbleLi().querySelector("details");
    expect(thinking.querySelector("summary").textContent).toBe("思考过程");
    expect(thinking.open).toBe(false);
    expect(thinking.textContent).toContain("先想一想");
    expect(bubbleText()).toContain("正在回复…");
    await deltaPush(transport, { text: "答案" });
    await revealed();
    expect(bubbleText()).toBe("答案");
    // The disclosure comes before the answer.
    const parts = [...bubbleLi().querySelector(".msg-main").children];
    expect(parts.indexOf(thinking)).toBeLessThan(parts.indexOf(bubbleLi().querySelector(".bubble")));
  });

  it("a stored reply's thinking is folded the same way", async () => {
    await openAgentChat({ messages: [...BASE, wire(A1, 3, AG1, "答案", { reasoning: "想过了" })] });
    const thinking = storedLi(3).querySelector("details");
    expect(thinking.querySelector("summary").textContent).toBe("思考过程");
    expect(thinking.open).toBe(false);
    expect(thinking.textContent).toContain("想过了");
    expect(storedLi(3).querySelector(".bubble").textContent).toBe("答案");
    expect(storedLi(2).querySelector("details")).toBeNull();
  });

  it("a reply still running when the page loads shows 正在回复… only, never a bubble starting mid-sentence", async () => {
    const { transport } = await openAgentChat({ run: runOf(R1, "running") });
    expect(bubbleText()).toContain("正在回复…");
    await deltaPush(transport, { text: "半句话" });
    expect(bubbleText()).not.toContain("半句话");
    await messagePush(transport, wire(A1, 3, AG1, "完整的回复"));
    expect(bubbleLi()).toBeNull();
    expect(storedLi(3)).not.toBeNull();
  });

  it("is never announced piece by piece: busy while it streams, the stored reply is announced once", async () => {
    const { transport } = await openAgentChat();
    // (The chat's own region, not the composer's, which tells of its mentions.)
    const live = document.querySelector('.chat > [aria-live="polite"]');
    await runPush(transport, runOf(R1, "running"));
    await deltaPush(transport, { text: "第一段" });
    expect(bubbleLi().getAttribute("aria-busy")).toBe("true");
    expect(bubbleLi().hasAttribute("aria-live")).toBe(false);
    expect(live.textContent).toBe("");
    await messagePush(transport, wire(A1, 3, AG1, "完整的回复"));
    expect(live.textContent).toBe("小助手：完整的回复");
    await runPush(transport, runOf(R1, "done"));
    expect(live.textContent).toBe("小助手：完整的回复");
  });

  // The service's pushes of one reply, and every order Task 1's model is tested with (deltas keep their order), each
  // with a stray delta of an unknown run at every position and a late delta after the end.
  const STEPS = {
    running: (t) => runPush(t, runOf(R1, "running")),
    d1: (t) => deltaPush(t, { text: "你" }),
    d2: (t) => deltaPush(t, { text: "好", reasoning: "想一想" }),
    d3: (t) => deltaPush(t, { text: "呀" }),
    message: (t) => messagePush(t, wire(A1, 3, AG1, "你好呀")),
    done: (t) => runPush(t, runOf(R1, "done")),
    late: (t) => deltaPush(t, { text: "！" }),
    stray: (t) => push(t, { type: "delta", conversationId: A1, runId: STRAY, text: "鬼" }),
  };
  function orders(items) {
    if (items.length === 0) return [[]];
    const isDelta = (step) => /^d\d$/.test(step);
    const out = [];
    items.forEach((item, i) => {
      const rest = [...items.slice(0, i), ...items.slice(i + 1)];
      if (isDelta(item) && rest.some((r) => isDelta(r) && r < item)) return;
      for (const tail of orders(rest)) out.push([item, ...tail]);
    });
    return out;
  }
  const tails = orders(["d1", "d2", "d3", "message", "done"]);

  it(`never shows the bubble and the stored reply at once, after any push of every order (${tails.length} orders × 7)`, async () => {
    expect(tails).toHaveLength(20);
    let cases = 0;
    let shownBeforeMessage = 0;
    for (const tail of tails) {
      for (let pos = 0; pos <= tail.length + 1; pos += 1) {
        const steps = ["running", ...tail, "late"];
        steps.splice(pos, 0, "stray");
        const label = steps.join(" → ");
        const { transport } = await openAgentChat();
        // The service sends the message before `done`: in that order there is never a frame with neither.
        const serviceOrder = tail.indexOf("message") < tail.indexOf("done");
        let streamed = "";
        let started = false;
        for (const step of steps) {
          await STEPS[step](transport);
          if (step === "running") started = true;
          // Right after the push, and again once the frames since have revealed what they would.
          for (const when of ["at", "after"]) {
            if (when === "after") await elapse(100);
            const bubble = bubbleText();
            const stored = storedLi(3) !== null;
            expect(bubble !== null && stored, `${label}: both ${when} ${step}`).toBe(false);
            if (serviceOrder && started) expect(bubble !== null || stored, `${label}: neither ${when} ${step}`).toBe(true);
            const placeholder = bubble !== null && bubble.includes("正在回复…");
            if (bubble !== null && !placeholder) expect("你好呀".startsWith(bubble), `${label}: ${bubble}`).toBe(true);
            expect(bubble ?? "", label).not.toContain("鬼");
            if (bubble !== null && !placeholder) streamed = bubble;
          }
        }
        // (A bubble still finishing what it had received when its stored message came is done within a moment.)
        await elapse(REVEAL_FINISH_MS + 100);
        expect(timeline().querySelectorAll('li[data-msg="m3"]'), label).toHaveLength(1);
        expect(bubbleLi(), label).toBeNull();
        expect(streamed === "" || "你好呀".startsWith(streamed), label).toBe(true);
        if (streamed !== "") shownBeforeMessage += 1;
        cleanup();
        cases += 1;
      }
    }
    expect(cases).toBe(140);
    // (The revealing was seen: in orders where pieces come before the stored message, the bubble showed them.)
    expect(shownBeforeMessage).toBeGreaterThan(0);
  }, 120000);

  const BURST = "一二三四五六七八九十".repeat(50); // 500 characters, in one piece

  it(`a burst is revealed over frames; its stored message coming meanwhile waits until the bubble has finished, within ${REVEAL_FINISH_MS} ms`, async () => {
    const { transport } = await openAgentChat();
    await runPush(transport, runOf(R1, "running"));
    await deltaPush(transport, { text: BURST });
    expect(bubbleText()).toContain("正在回复…");
    await elapse(50);
    const part = bubbleText();
    expect(part.length).toBeGreaterThan(0);
    expect(part.length).toBeLessThan(BURST.length);
    expect(BURST.startsWith(part)).toBe(true);
    // The stored reply comes while most of the burst is still unrevealed: the bubble stays and finishes, faster; the
    // stored reply is not shown beside it (never both), also once the run is done.
    await messagePush(transport, wire(A1, 3, AG1, `${BURST}。`));
    await runPush(transport, runOf(R1, "done"));
    let shown = bubbleText().length;
    let waited = 0;
    while (bubbleLi() !== null && waited <= REVEAL_FINISH_MS + 32) {
      expect(storedLi(3)).toBeNull();
      expect(BURST.startsWith(bubbleText().replace(/^\s*正在回复…$/, ""))).toBe(true);
      expect(bubbleText().length).toBeGreaterThanOrEqual(shown);
      shown = bubbleText().length;
      await elapse(16);
      waited += 16;
    }
    expect(waited).toBeGreaterThan(48);
    expect(waited).toBeLessThanOrEqual(REVEAL_FINISH_MS + 32);
    // Then the stored reply in its place, once.
    expect(bubbleLi()).toBeNull();
    expect(timeline().querySelectorAll('li[data-msg="m3"]')).toHaveLength(1);
    expect(storedLi(3).querySelector(".bubble").textContent).toBe(`${BURST}。`);
  });

  it.each([
    ["is the stream's text", BURST, BURST],
    ["begins with the stream's text (a piece was still on its way)", BURST, `${BURST}。`],
    ["is the stream's text but for the white space it ended with (the service trims what it stores)", `${BURST}
`, BURST],
    ["is the stream's text but for the white space it began with (the service trims what it stores)", `\n\n${BURST}`, BURST],
  ])("a stored reply that %s: the bubble finishes first, then the stored reply takes its place", async (_how, streamed, stored) => {
    const { transport } = await openAgentChat();
    await runPush(transport, runOf(R1, "running"));
    await deltaPush(transport, { text: streamed });
    await elapse(50);
    await messagePush(transport, wire(A1, 3, AG1, stored));
    expect(bubbleLi()).not.toBeNull();
    expect(storedLi(3)).toBeNull();
    await elapse(REVEAL_FINISH_MS + 32);
    expect(bubbleLi()).toBeNull();
    expect(timeline().querySelectorAll('li[data-msg="m3"]')).toHaveLength(1);
    expect(storedLi(3).querySelector(".bubble").textContent).toBe(stored);
  });

  it("a stream ending in a line break whose stored reply is the trimmed text finishes, and shows nothing beyond the stored text", async () => {
    const { transport } = await openAgentChat();
    await runPush(transport, runOf(R1, "running"));
    await deltaPush(transport, { text: `${BURST}
` });
    await elapse(50);
    await messagePush(transport, wire(A1, 3, AG1, BURST));
    expect(bubbleLi()).not.toBeNull();
    expect(BURST.startsWith(bubbleText().replace(/^\s*正在回复…$/, ""))).toBe(true);
    await elapse(REVEAL_FINISH_MS / 2);
    expect(BURST.startsWith(bubbleText().replace(/^\s*正在回复…$/, ""))).toBe(true);
    await elapse(REVEAL_FINISH_MS + 32);
    expect(bubbleLi()).toBeNull();
    expect(storedLi(3).querySelector(".bubble").textContent).toBe(BURST);
  });

  it.each([
    ["differs from the stream in the middle", wire(A1, 3, AG1, `${BURST.slice(0, 250)}另${BURST.slice(251)}`)],
    ["is shorter than the stream", wire(A1, 3, AG1, BURST.slice(0, 400))],
    ["was cut by the service (已截断)", wire(A1, 3, AG1, `${BURST}。`, { truncated: true })],
    ["had a persona proposal taken out of it", wire(A1, 3, AG1, `${BURST}。`, { proposal: { id: PID, status: "open", persona: "新的人格" } })],
  ])("a stored reply that %s replaces the bubble at once, with what was left unrevealed", async (_how, message) => {
    const { transport } = await openAgentChat();
    await runPush(transport, runOf(R1, "running"));
    await deltaPush(transport, { text: BURST });
    await elapse(50);
    expect(bubbleText().length).toBeLessThan(BURST.length);
    await messagePush(transport, message);
    expect(bubbleLi()).toBeNull();
    expect(storedLi(3).querySelector(".bubble").textContent).toBe(message.text);
    await elapse(REVEAL_FINISH_MS + 100);
    expect(bubbleLi()).toBeNull();
    expect(timeline().querySelectorAll('li[data-msg="m3"]')).toHaveLength(1);
  });

  it("a new reply starting while the bubble finishes: the finished one's stored reply at once, and the new reply's bubble after it", async () => {
    const { transport } = await openAgentChat();
    await runPush(transport, runOf(R1, "running"));
    await deltaPush(transport, { text: BURST });
    await elapse(50);
    await messagePush(transport, wire(A1, 3, AG1, `${BURST}。`));
    expect(bubbleLi()).not.toBeNull();
    expect(storedLi(3)).toBeNull();
    await runPush(transport, runOf(R2, "queued"));
    expect(storedLi(3).querySelector(".bubble").textContent).toBe(`${BURST}。`);
    expect(timeline().querySelectorAll("li.streaming")).toHaveLength(1);
    expect(bubbleText()).toContain("正在回复…");
    expect(bubbleText()).not.toContain("一二三");
    expect(timeline().lastElementChild.previousElementSibling).toBe(bubbleLi());
    await elapse(REVEAL_FINISH_MS + 100);
    expect(timeline().querySelectorAll('li[data-msg="m3"]')).toHaveLength(1);
    expect(bubbleText()).toContain("正在回复…");
  });

  it("leaving the conversation and coming back while the reply is written: what was revealed is not revealed again; the rest goes on from there", async () => {
    const { transport } = await openAgentChat({ extra: [direct(D1, ANN)] });
    await runPush(transport, runOf(R1, "running"));
    await deltaPush(transport, { text: BURST });
    await elapse(50);
    const part = bubbleText();
    expect(part.length).toBeGreaterThan(0);
    expect(part.length).toBeLessThan(BURST.length);
    await click(screen.getByText("小安", { selector: ".list-col .row-name" }));
    await click(screen.getByText("小助手", { selector: ".list-col .row-name" }));
    // At once what was shown when it was left (not the placeholder, not from its start)...
    expect(bubbleText().length).toBeGreaterThanOrEqual(part.length);
    expect(BURST.startsWith(bubbleText().replace(/^\s*正在回复…$/, ""))).toBe(true);
    // ... and the rest revealed from there.
    await revealed();
    expect(bubbleText()).toBe(BURST);
    // All of it shown: coming back shows all of it at once.
    await deltaPush(transport, { text: "完" });
    await revealed();
    await click(screen.getByText("小安", { selector: ".list-col .row-name" }));
    await click(screen.getByText("小助手", { selector: ".list-col .row-name" }));
    expect(bubbleText()).toBe(`${BURST}完`);
  });

  it("the stored message replaces the bubble at once when nothing is left to reveal, under reduced motion, or in a hidden tab", async () => {
    // Nothing left: at once.
    const first = await openAgentChat();
    await runPush(first.transport, runOf(R1, "running"));
    await deltaPush(first.transport, { text: "短短一句" });
    await revealed();
    await messagePush(first.transport, wire(A1, 3, AG1, "短短一句。"));
    expect(bubbleLi()).toBeNull();
    expect(storedLi(3)).not.toBeNull();
    cleanup();
    // Reduced motion: everything is shown at once, so nothing is left.
    window.matchMedia = (query) => ({ matches: query === "(prefers-reduced-motion: reduce)", addEventListener() {}, removeEventListener() {} });
    try {
      const second = await openAgentChat();
      await runPush(second.transport, runOf(R1, "running"));
      await deltaPush(second.transport, { text: BURST });
      expect(bubbleText()).toBe(BURST);
      await messagePush(second.transport, wire(A1, 3, AG1, `${BURST}。`));
      expect(bubbleLi()).toBeNull();
      expect(storedLi(3)).not.toBeNull();
    } finally {
      delete window.matchMedia;
    }
    cleanup();
    // The tab hidden while the bubble finishes: the stored reply at once.
    let hidden = false;
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    const third = await openAgentChat();
    await runPush(third.transport, runOf(R1, "running"));
    await deltaPush(third.transport, { text: BURST });
    await elapse(50);
    await messagePush(third.transport, wire(A1, 3, AG1, `${BURST}。`));
    expect(bubbleLi()).not.toBeNull();
    hidden = true;
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await flush();
    expect(bubbleLi()).toBeNull();
    expect(storedLi(3).querySelector(".bubble").textContent).toBe(`${BURST}。`);
  });

  it("a finishing bubble whose frames never come still gives way to its stored reply, a moment later", async () => {
    // (Frames that never run: the bubble cannot finish by itself.)
    setRevealFrames({ request: () => 0, cancel: () => {} });
    try {
      const { transport } = await openAgentChat();
      await runPush(transport, runOf(R1, "running"));
      await deltaPush(transport, { text: BURST });
      await messagePush(transport, wire(A1, 3, AG1, `${BURST}。`));
      expect(bubbleLi()).not.toBeNull();
      expect(storedLi(3)).toBeNull();
      await elapse(REVEAL_FINISH_MS + 1000);
      expect(bubbleLi()).toBeNull();
      expect(storedLi(3).querySelector(".bubble").textContent).toBe(`${BURST}。`);
    } finally {
      setRevealFrames({ request: (run) => setTimeout(() => run(Date.now()), 16), cancel: (id) => clearTimeout(id) });
    }
  });

  it("a stopped reply, a newer message, or leaving the conversation: the stored reply at once", async () => {
    // Stopped: everything received was shown at the press; the stopped reply replaces it at once.
    const first = await openAgentChat();
    await runPush(first.transport, runOf(R1, "running"));
    await deltaPush(first.transport, { text: BURST });
    await elapse(50);
    await click(within(bubbleLi()).getByRole("button", { name: "停止生成" }));
    await messagePush(first.transport, wire(A1, 3, AG1, BURST, { stopped: true }));
    expect(bubbleLi()).toBeNull();
    expect(storedLi(3)).not.toBeNull();
    cleanup();
    // A message after the reply while the bubble finishes: the reply in its place at once, in order.
    const second = await openAgentChat();
    await runPush(second.transport, runOf(R1, "running"));
    await deltaPush(second.transport, { text: BURST });
    await elapse(50);
    await messagePush(second.transport, wire(A1, 3, AG1, `${BURST}。`));
    expect(bubbleLi()).not.toBeNull();
    await messagePush(second.transport, wire(A1, 4, ME_ID, "好的"));
    expect(bubbleLi()).toBeNull();
    expect([...timeline().querySelectorAll("li[data-msg]")].slice(-2).map((li) => li.dataset.msg)).toEqual(["m3", "m4"]);
    cleanup();
    // Leaving while it finishes: coming back shows the stored reply, no bubble.
    const third = await openAgentChat({ extra: [direct(D1, ANN)] });
    await runPush(third.transport, runOf(R1, "running"));
    await deltaPush(third.transport, { text: BURST });
    await elapse(50);
    await messagePush(third.transport, wire(A1, 3, AG1, `${BURST}。`));
    expect(bubbleLi()).not.toBeNull();
    await click(screen.getByText("小安", { selector: ".list-col .row-name" }));
    await click(screen.getByText("小助手", { selector: ".list-col .row-name" }));
    expect(bubbleLi()).toBeNull();
    expect(storedLi(3)).not.toBeNull();
  });

  it("停止生成 shows at once everything received; a failure ends the bubble with nothing half-revealed left", async () => {
    const { transport } = await openAgentChat();
    await runPush(transport, runOf(R1, "running"));
    await deltaPush(transport, { text: BURST });
    await elapse(50);
    expect(bubbleText().length).toBeLessThan(BURST.length);
    await click(within(bubbleLi()).getByRole("button", { name: "停止生成" }));
    expect(bubbleText()).toBe(BURST);
    // A run that fails: the bubble goes (its status line says why), whatever was being revealed.
    await runPush(transport, runOf(R1, "failed", { error: "provider_unavailable", retryable: true }));
    expect(bubbleLi()).toBeNull();
    expect(statusLine()).not.toBeNull();
  });

  it("a stop that could not be sent goes back to revealing at the frames", async () => {
    const { transport } = await openAgentChat({ api: { stopRun: vi.fn(async () => Promise.reject(apiError(0, "network_error"))) } });
    await runPush(transport, runOf(R1, "running"));
    await deltaPush(transport, { text: BURST });
    await elapse(50);
    await click(within(bubbleLi()).getByRole("button", { name: "停止生成" }));
    expect(toastText()).toBe("连不上服务，请检查网络后重试。");
    const shown = bubbleText().length;
    await deltaPush(transport, { text: BURST });
    expect(bubbleText().length).toBe(shown);
    await revealed();
    expect(bubbleText()).toBe(BURST + BURST);
  });
});

describe("thinking (an Agent whose reasoning level is not none)", () => {
  // (A reply's moments are kept by its run id, which is never used twice: every test here has a run of its own.)
  let R1;
  let runs = 0;
  beforeEach(() => {
    runs += 1;
    R1 = `00000000-0000-4000-8000-0000000002${String(runs).padStart(2, "0")}`;
  });
  const deltaPush = (transport, fields) => push(transport, { type: "delta", conversationId: A1, runId: R1, ...fields });

  it("正在思考… counts whole seconds until the first piece of the reply; streamed thinking takes the line as its header", async () => {
    const { transport } = await openAgentChat({ agent: { reasoning: "high" } });
    await runPush(transport, runOf(R1, "running"));
    expect(bubbleText()).toContain("正在思考…");
    expect(bubbleText()).not.toContain("秒");
    expect(bubbleText()).not.toContain("正在回复");
    await elapse(1000);
    expect(bubbleText()).toContain("正在思考… 1 秒");
    await elapse(1500);
    expect(bubbleText()).toContain("正在思考… 2 秒");
    // Its thinking streams: the line heads it — the same count, never back to 0; it is open while it comes; the bubble
    // keeps only the dots.
    await deltaPush(transport, { reasoning: "先想一想" });
    expect(thinkingSummary()).toBe("正在思考… 2 秒");
    expect(bubbleLi().querySelector("details").open).toBe(true);
    expect(bubbleLi().querySelector("details .thinking-text").textContent).toBe("先想一想");
    expect(bubbleText()).toBe("");
    expect(bubbleLi().querySelector(".bubble .dots")).not.toBeNull();
    await elapse(1000);
    expect(thinkingSummary()).toBe("正在思考… 3 秒");
    await deltaPush(transport, { reasoning: "，再想一想" });
    await elapse(2400);
    expect(thinkingSummary()).toBe("正在思考… 5 秒");
    // The first piece of the reply: the thinking folds by itself under how long it took, from that same start; the text
    // is revealed, the count stops.
    await deltaPush(transport, { text: "答案" });
    expect(thinkingSummary()).toBe("思考了 5 秒");
    expect(bubbleLi().querySelector("details").open).toBe(false);
    await revealed();
    expect(bubbleText()).toBe("答案");
    await elapse(5000);
    expect(thinkingSummary()).toBe("思考了 5 秒");
    // The stored reply keeps its usual header: no duration is stored.
    await messagePush(transport, wire(A1, 3, AG1, "答案", { reasoning: "先想一想，再想一想" }));
    expect(storedLi(3).querySelector("details > summary").textContent).toBe("思考过程");
  });

  it("思考了 N 秒 is at least 1; the reader can open the folded thinking again", async () => {
    const { transport } = await openAgentChat({ agent: { reasoning: "high" } });
    await runPush(transport, runOf(R1, "running"));
    await deltaPush(transport, { reasoning: "嗯" });
    await elapse(300);
    await deltaPush(transport, { text: "好" });
    expect(thinkingSummary()).toBe("思考了 1 秒");
    const details = bubbleLi().querySelector("details");
    expect(details.open).toBe(false);
    await click(details.querySelector("summary"));
    await flush();
    expect(bubbleLi().querySelector("details").open).toBe(true);
    await deltaPush(transport, { text: "的" });
    await revealed();
    expect(bubbleLi().querySelector("details").open).toBe(true);
  });

  it("the reader's own open or close while the thinking streams is kept: not reopened, not folded at the text", async () => {
    const { transport } = await openAgentChat({ agent: { reasoning: "high" } });
    await runPush(transport, runOf(R1, "running"));
    await deltaPush(transport, { reasoning: "第一步" });
    const details = () => bubbleLi().querySelector("details");
    expect(details().open).toBe(true);
    // Closed by the reader: more thinking does not open it again; the text does not change it either.
    await click(details().querySelector("summary"));
    await flush();
    expect(details().open).toBe(false);
    await deltaPush(transport, { reasoning: "第二步" });
    await elapse(1000);
    expect(details().open).toBe(false);
    // Opened again by the reader: the reply's text does not fold it.
    await click(details().querySelector("summary"));
    await flush();
    expect(details().open).toBe(true);
    await deltaPush(transport, { text: "结论" });
    await revealed();
    expect(details().open).toBe(true);
    expect(thinkingSummary()).toBe("思考了 1 秒");
  });

  it("when the first piece of the text came while the conversation was not shown, the header says 思考过程", async () => {
    const { transport } = await openAgentChat({ agent: { reasoning: "high" }, extra: [direct(D1, ANN)] });
    await runPush(transport, runOf(R1, "running"));
    await deltaPush(transport, { reasoning: "想" });
    await click(screen.getByText("小安", { selector: ".list-col .row-name" }));
    await elapse(4000);
    await deltaPush(transport, { text: "答案" });
    await click(screen.getByText("小助手", { selector: ".list-col .row-name" }));
    expect(thinkingSummary()).toBe("思考过程");
  });

  it("counts from when the reply was first seen here, also across leaving the conversation and coming back", async () => {
    const { transport } = await openAgentChat({ agent: { reasoning: "low" }, extra: [direct(D1, ANN)] });
    await runPush(transport, runOf(R1, "queued"));
    await elapse(2000);
    await runPush(transport, runOf(R1, "running"));
    expect(bubbleText()).toContain("正在思考… 2 秒");
    await click(screen.getByText("小安", { selector: ".list-col .row-name" }));
    expect(bubbleLi()).toBeNull();
    await elapse(3000);
    await click(screen.getByText("小助手", { selector: ".list-col .row-name" }));
    expect(bubbleText()).toContain("正在思考… 5 秒");
  });

  it("the line's timer runs only while counting, and none is left once it stops or goes", async () => {
    function Line({ since, counting }) {
      return <p>{thinkingLine(useThinkingSeconds(since, counting))}</p>;
    }
    const since = Date.now();
    const { container, rerender, unmount } = render(<Line since={since} counting />);
    expect(vi.getTimerCount()).toBe(1);
    await elapse(1000);
    expect(container.textContent).toBe("正在思考… 1 秒");
    await elapse(999);
    expect(container.textContent).toBe("正在思考… 1 秒");
    await elapse(1);
    expect(container.textContent).toBe("正在思考… 2 秒");
    expect(vi.getTimerCount()).toBe(1);
    rerender(<Line since={since} counting={false} />);
    expect(vi.getTimerCount()).toBe(0);
    rerender(<Line since={since} counting />);
    expect(vi.getTimerCount()).toBe(1);
    act(() => unmount());
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the thinking shown open while it streams grows by appending what came to one text node; its whole text is never set again", async () => {
    const { transport } = await openAgentChat({ agent: { reasoning: "high" } });
    await runPush(transport, runOf(R1, "running"));
    let full = "想".repeat(5000);
    await deltaPush(transport, { reasoning: full });
    const host = bubbleLi().querySelector("details .thinking-text");
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    const node = walker.nextNode();
    expect(node.data).toBe(full);
    const observer = new MutationObserver(() => {});
    observer.observe(host, { subtree: true, childList: true, characterData: true, attributes: true });
    // Every way a text node's whole text is set, and what is appended (counted inside the thinking only).
    const replaced = [
      vi.spyOn(CharacterData.prototype, "data", "set"),
      vi.spyOn(Node.prototype, "nodeValue", "set"),
      vi.spyOn(Node.prototype, "textContent", "set"),
    ];
    const appended = vi.spyOn(CharacterData.prototype, "appendData");
    const inThinking = (spy) => spy.mock.calls.filter((_call, i) => host.contains(spy.mock.contexts[i]));
    for (let i = 0; i < 10; i += 1) {
      const piece = `第${i}步，`.repeat(40);
      appended.mockClear();
      for (const spy of replaced) spy.mockClear();
      await deltaPush(transport, { reasoning: piece });
      full += piece;
      expect(inThinking(appended).map(([s]) => s).join("")).toBe(piece);
      for (const spy of replaced) expect(inThinking(spy)).toHaveLength(0);
      const changes = observer.takeRecords();
      expect(changes.length).toBeLessThanOrEqual(2);
      for (const change of changes) expect(change.target).toBe(node);
    }
    observer.disconnect();
    expect(host.textContent).toBe(full);
    expect(document.createTreeWalker(host, NodeFilter.SHOW_TEXT).nextNode()).toBe(node);
  });
});

describe("停止生成", () => {
  it("calls stopRun with the run, stays disabled until the run ends, and the stored reply reads 已停止", async () => {
    const { transport, api } = await openAgentChat();
    await runPush(transport, runOf(R1, "running"));
    await deltaPush(transport, { text: "说到一半" });
    const stop = within(bubbleLi()).getByRole("button", { name: "停止生成" });
    await click(stop);
    expect(api.stopRun).toHaveBeenCalledWith(A1, R1);
    expect(within(bubbleLi()).getByRole("button", { name: "停止生成" }).disabled).toBe(true);
    await click(within(bubbleLi()).getByRole("button", { name: "停止生成" }));
    expect(api.stopRun).toHaveBeenCalledTimes(1);
    await messagePush(transport, wire(A1, 3, AG1, "说到一半", { stopped: true }));
    await runPush(transport, runOf(R1, "stopped"));
    expect(bubbleLi()).toBeNull();
    expect(within(storedLi(3)).getByText("已停止")).toBeTruthy();
    // The next reply's button is usable again.
    await runPush(transport, runOf(R2, "queued"));
    expect(within(bubbleLi()).getByRole("button", { name: "停止生成" }).disabled).toBe(false);
  });

  it("stopping a reply that has already ended says nothing", async () => {
    const { transport } = await openAgentChat({ api: { stopRun: vi.fn(async () => Promise.reject(apiError(404, "not_found"))) } });
    await runPush(transport, runOf(R1, "running"));
    await click(within(bubbleLi()).getByRole("button", { name: "停止生成" }));
    await flush();
    expect(toastText()).toBeNull();
  });

  it("a stop that could not be sent says why and can be pressed again", async () => {
    const { transport, api } = await openAgentChat({ api: { stopRun: vi.fn(async () => Promise.reject(apiError(0, "network_error"))) } });
    await runPush(transport, runOf(R1, "running"));
    await click(within(bubbleLi()).getByRole("button", { name: "停止生成" }));
    expect(toastText()).toBe("连不上服务，请检查网络后重试。");
    expect(within(bubbleLi()).getByRole("button", { name: "停止生成" }).disabled).toBe(false);
    expect(api.stopRun).toHaveBeenCalledTimes(1);
  });

  it("a cut reply reads 已截断", async () => {
    await openAgentChat({ messages: [...BASE, wire(A1, 3, AG1, "很长的回答", { truncated: true })] });
    expect(within(storedLi(3)).getByText("已截断")).toBeTruthy();
    expect(within(storedLi(1)).queryByText("已截断")).toBeNull();
  });
});

describe("the status line of a failed reply", () => {
  const tonight = new Date(2026, 10, 17, 0, 0).toISOString();
  const CASES = [
    ["provider_rejected", false, {}, "供应商拒绝了密钥，这次没有回复。请到设置里检查密钥。"],
    ["provider_unavailable", true, {}, "暂时连不上模型服务，这次没有回复。可以重试。"],
    ["address_not_allowed", false, {}, "模型的接口地址不被允许，这次没有回复。请到设置里检查地址。"],
    ["context_too_small", false, {}, "人格文档太长或模型的上下文太小，放不下你的消息。请缩短人格文档或换一个模型。"],
    ["busy", true, {}, "服务出了点问题，这次没有回复，也没有扣费。可以重试。"],
    ["rate_limited", true, {}, "发得太快了，请稍后重试。"],
    ["no_quota", true, { resetsAt: tonight }, "今天的免费额度和余额都已用完，免费额度将在明天 00:00 重置。"],
    ["no_quota", true, {}, "余额不足：这个模型需要余额才能使用。"],
    ["agent_paused", false, {}, "它已暂停，这次没有回复。"],
    ["agent_deleted", false, {}, "它已删除，这次没有回复。"],
    ["model_gone", false, {}, "这个模型不可用，换一个模型。"],
  ];
  for (const [code, retryable, extra, sentence] of CASES) {
    it(`${code}${extra.resetsAt ? " (free model)" : ""}: its sentence, 重试 ${retryable ? "shown" : "hidden"}, a dismiss control`, async () => {
      // (A model of my provider: the sentences that send me to my settings are mine to act on.)
      const { transport } = await openAgentChat({ agent: { model: PROVIDER_MODEL } });
      await runPush(transport, runOf(R1, "failed", { error: code, retryable, ...extra }));
      expect(statusLines()).toHaveLength(1);
      const line = statusLine();
      expect(line.textContent).toContain(sentence);
      expect(within(line).queryByRole("button", { name: "重试" }) !== null).toBe(retryable);
      expect(within(line).getByRole("button", { name: "关闭提示" })).toBeTruthy();
      // Not a message: no seq, no avatar, no time, no 回复.
      expect(line.dataset.msg).toBeUndefined();
      expect(line.querySelector(".avatar, time")).toBeNull();
      expect(within(line).queryByRole("button", { name: /回复/ })).toBeNull();
      // At the end of the list.
      expect(line.nextElementSibling.getAttribute("aria-hidden")).toBe("true");
    });
  }

  it("a site model's key, address or outage is not mine to check: one sentence, 重试 only when retryable", async () => {
    const SITE = "站点提供的这个模型暂时用不了，请稍后重试，或换一个模型。";
    const { transport } = await openAgentChat({ agent: { model: SITE_FREE } });
    for (const [id, code, retryable] of [
      [R1, "provider_rejected", false],
      [R2, "provider_unavailable", true],
      [STRAY, "address_not_allowed", false],
    ]) {
      await runPush(transport, runOf(id, "failed", { error: code, retryable }));
      expect(statusLines(), code).toHaveLength(1);
      expect(statusLine().textContent, code).toContain(SITE);
      expect(statusLine().textContent, code).not.toMatch(/检查密钥|检查地址/);
      expect(within(statusLine()).queryByRole("button", { name: "重试" }) !== null, code).toBe(retryable);
    }
  });

  it("no_quota links to Settings → 用量与余额", async () => {
    const { transport } = await openAgentChat({ api: { getUsage: vi.fn(() => new Promise(() => {})) } });
    await runPush(transport, runOf(R1, "failed", { error: "no_quota", retryable: true }));
    await click(within(statusLine()).getByRole("button", { name: "查看用量与余额" }));
    expect(mainText()).toContain("正在读取用量…");
  });

  it("context_too_small links to the Agent's edit page", async () => {
    const { transport } = await openAgentChat({ api: { getModels: vi.fn(async () => MODELS), getUsage: vi.fn(() => new Promise(() => {})) } });
    await runPush(transport, runOf(R1, "failed", { error: "context_too_small", retryable: false }));
    await click(within(statusLine()).getByRole("button", { name: "修改 Agent" }));
    expect(screen.getByLabelText("人格文档")).toBeTruthy();
  });

  it("model_gone, then the model is back: the Agent's push brings 重试 to the line already shown, with no reload", async () => {
    const now = { usable: false, run: runOf(R1, "failed", { error: "model_gone", retryable: false }) };
    const getRun = vi.fn(() => ({ run: now.run }));
    const { transport } = await openAgentChat({
      agent: { model: PROVIDER_MODEL, modelUsable: false },
      providers: [providerOf()],
      handlers: { agent: () => agentOf(AG1, { model: PROVIDER_MODEL, modelUsable: now.usable }), run: getRun },
    });
    await runPush(transport, now.run);
    expect(within(statusLine()).queryByRole("button", { name: "重试" })).toBeNull();
    const asked = getRun.mock.calls.length;

    // The owner put the model back on the provider's list: the service pushes the Agent, not the run.
    now.usable = true;
    now.run = runOf(R1, "failed", { error: "model_gone", retryable: true });
    await push(transport, { type: "agent", id: AG1 });
    await flush();
    expect(getRun.mock.calls.length).toBe(asked + 1);
    expect(within(statusLine()).getByRole("button", { name: "重试" })).toBeTruthy();
    // A push that changes nothing of it asks for nothing more.
    await push(transport, { type: "agent", id: AG1 });
    await flush();
    expect(getRun.mock.calls.length).toBe(asked + 1);
  });

  it("model_gone offers 换一个模型 and no 重试: it opens the header's model switch, right here", async () => {
    const { transport } = await openAgentChat({ agent: { model: PROVIDER_MODEL, modelUsable: false }, providers: [providerOf()] });
    await runPush(transport, runOf(R1, "failed", { error: "model_gone", retryable: false }));
    expect(within(statusLine()).queryByRole("button", { name: "重试" })).toBeNull();
    expect(within(statusLine()).queryByRole("button", { name: "修改 Agent" })).toBeNull();
    await click(within(statusLine()).getByRole("button", { name: "换一个模型" }));
    expect(screen.getByRole("listbox")).toBeTruthy();
    const header = document.querySelector(".chat-head .chat-title p");
    expect(within(header).getByRole("button", { name: /^模型：/ }).getAttribute("aria-expanded")).toBe("true");
    // Still the conversation: no form opened.
    expect(screen.queryByLabelText("人格文档")).toBeNull();
  });

  it("a cancelled reply shows nothing", async () => {
    const { transport } = await openAgentChat();
    for (const [id, error] of [
      [R1, "agent_paused"],
      [R2, "agent_deleted"],
      [STRAY, undefined],
    ]) {
      await runPush(transport, runOf(id, "cancelled", error ? { error } : {}));
      expect(statusLines()).toHaveLength(0);
      expect(bubbleLi()).toBeNull();
    }
  });

  it("the same failure from a push and from GET …/run is one line", async () => {
    const failed = runOf(R1, "failed", { error: "busy", retryable: true });
    const { transport } = await openAgentChat({ run: failed });
    expect(statusLines()).toHaveLength(1);
    await runPush(transport, failed);
    expect(statusLines()).toHaveLength(1);
  });

  it("dismissing calls dismissRun and hides the line", async () => {
    const { transport, api } = await openAgentChat();
    await runPush(transport, runOf(R1, "failed", { error: "busy", retryable: true }));
    await click(within(statusLine()).getByRole("button", { name: "关闭提示" }));
    expect(api.dismissRun).toHaveBeenCalledWith(A1);
    expect(statusLines()).toHaveLength(0);
  });

  it("重试 starts the new reply in place of the line", async () => {
    const { transport, api } = await openAgentChat();
    await runPush(transport, runOf(R1, "failed", { error: "busy", retryable: true }));
    await click(within(statusLine()).getByRole("button", { name: "重试" }));
    expect(api.retryRun).toHaveBeenCalledWith(A1);
    expect(statusLines()).toHaveLength(0);
    expect(bubbleText()).toContain("正在回复…");
  });

  it("a retry refused because a reply is already going says nothing (that reply shows as it comes)", async () => {
    const busy = deferred();
    const { transport } = await openAgentChat({ api: { retryRun: vi.fn(() => busy.promise) } });
    await runPush(transport, runOf(R1, "failed", { error: "busy", retryable: true }));
    await click(within(statusLine()).getByRole("button", { name: "重试" }));
    expect(within(statusLine()).getByRole("button", { name: "重试" }).disabled).toBe(true);
    await act(async () => busy.reject(apiError(409, "busy_run")));
    await flush();
    expect(toastText()).toBeNull();
    expect(mainText()).not.toContain("它正在回复");
    await runPush(transport, runOf(R2, "running"));
    expect(statusLines()).toHaveLength(0);
    expect(bubbleText()).toContain("正在回复…");
  });

  it("a retry over the reply limit (429) says why in the line, not in a toast", async () => {
    const { transport } = await openAgentChat({ api: { retryRun: vi.fn(async () => Promise.reject(apiError(429, "rate_limited"))) } });
    await runPush(transport, runOf(R1, "failed", { error: "rate_limited", retryable: true }));
    await click(within(statusLine()).getByRole("button", { name: "重试" }));
    expect(statusLine().textContent).toContain("回复太频繁了，请稍等一分钟再试。");
    expect(within(statusLine()).getByRole("button", { name: "重试" }).disabled).toBe(false);
    expect(toastText()).toBeNull();
  });
});

describe("a paused or deleted Agent", () => {
  it("paused: the pause notice sits above a composer that still sends", async () => {
    const { api } = await openAgentChat({ agent: { paused: true } });
    const pause = screen.getByText(PAUSE_TEXT);
    const composer = document.querySelector(".composer");
    expect(pause.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(pause.compareDocumentPosition(timeline()) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(input().disabled).toBe(false);
    fireEvent.change(input(), { target: { value: "你还在吗" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    await flush();
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("deleted: the frozen style with its sentence; nothing can be sent; the history stays", async () => {
    await openAgentChat({ agent: { deleted: true } });
    expect(document.querySelector(".chat > .notice").textContent).toContain(DELETED_TEXT);
    expect(input().disabled).toBe(true);
    expect(document.querySelector(".composer-hint").textContent).toBe(DELETED_TEXT);
    expect(storedLi(1)).not.toBeNull();
    expect(mainText()).not.toContain(PAUSE_TEXT);
  });
});

describe("a new topic", () => {
  const openDetails = () => click(screen.getByRole("button", { name: "会话资料" }));

  it("the details panel asks first, then the notice shows as a 新话题 divider", async () => {
    const { api } = await openAgentChat();
    await openDetails();
    await click(within(document.querySelector(".side-col")).getByRole("button", { name: "开始新话题" }));
    expect(dialog().textContent).toContain("之前的对话不会再发给它，聊天记录仍然保留。");
    await click(within(dialog()).getByRole("button", { name: "取消" }));
    expect(api.resetTopic).not.toHaveBeenCalled();

    await click(within(document.querySelector(".side-col")).getByRole("button", { name: "开始新话题" }));
    await click(within(dialog()).getByRole("button", { name: "开始新话题" }));
    expect(api.resetTopic).toHaveBeenCalledWith(A1);
    expect(dialog()).toBeNull();
    const divider = storedLi(3);
    expect(divider.classList.contains("msg-divider")).toBe(true);
    expect(divider.textContent).toBe("新话题");
  });

  it("a topic notice from the history is a divider too; a deleted Agent offers no new topic", async () => {
    await openAgentChat({
      agent: { deleted: true },
      messages: [...BASE, notice(A1, 3, "Mei开始了新话题，之前的对话不再发给小助手", { event: "topic_reset", actorId: ME_ID })],
    });
    expect(storedLi(3).classList.contains("msg-divider")).toBe(true);
    expect(storedLi(3).textContent).toBe("新话题");
    await openDetails();
    expect(within(document.querySelector(".side-col")).queryByRole("button", { name: "开始新话题" })).toBeNull();
  });

  it("the details panel shows the Agent and leads to its detail page", async () => {
    await openAgentChat();
    await openDetails();
    const side = document.querySelector(".side-col");
    expect(side.textContent).not.toMatch(/任务|设备|好友|拉黑/);
    expect(side.textContent).toContain("不随关系获得对方的其他会话");
    expect(side.textContent).not.toMatch(/文件夹|电脑/);
    await click(within(side).getByRole("button", { name: "管理这个 Agent" }));
    expect(document.querySelector(".main-col .eyebrow").textContent).toBe("我的 Agent");
    expect(document.querySelector(".main-col h2").textContent).toContain("小助手");
  });
});

describe("the proposal card", () => {
  const LONG = Array.from({ length: 12 }, (_, i) => `第${i + 1}行：你是一位耐心的旅行规划师。`).join("\n");
  const proposed = (status, fields = {}) =>
    wire(A1, 3, AG1, "", {
      proposal: { id: PID, status, persona: "你是一位耐心的旅行规划师。", intro: "帮你规划旅行", field: "旅行", ...fields },
    });
  const card = () => storedLi(3).querySelector(".proposal-card");
  const cardButton = (name) => within(card()).queryByRole("button", { name });

  it("open: the persona, 简介 and 擅长领域, and 确认 / 修改后确认 / 放弃", async () => {
    await openAgentChat({ messages: [...BASE, proposed("open")] });
    expect(card().textContent).toContain("你是一位耐心的旅行规划师。");
    expect(card().textContent).toContain("帮你规划旅行");
    expect(card().textContent).toContain("旅行");
    for (const name of ["确认", "修改后确认", "放弃"]) expect(cardButton(name)).not.toBeNull();
  });

  for (const [status, text] of [
    ["confirmed", "已采用"],
    ["discarded", "已放弃"],
    ["superseded", "已被新的提议取代"],
    ["stale", "配置已变更，请重新生成提议"],
  ]) {
    it(`${status}: reads ${text}, with nothing to press`, async () => {
      await openAgentChat({ messages: [...BASE, proposed(status)] });
      expect(card().textContent).toContain(text);
      for (const name of ["确认", "修改后确认", "放弃"]) expect(cardButton(name)).toBeNull();
    });
  }

  it("a reply that is only a proposal (no text: the service puts no sentence in the Agent's mouth) shows the card alone, no empty bubble", async () => {
    await openAgentChat({ messages: [...BASE, wire(A1, 3, AG1, "", { proposal: { id: PID, status: "open", persona: "你是一位耐心的旅行规划师。" } })] });
    expect(card().textContent).toContain("你是一位耐心的旅行规划师。");
    expect(storedLi(3).querySelector(".bubble")).toBeNull();
    expect(cardButton("确认")).not.toBeNull();
  });

  it("a quote of a proposal-only reply, and the chip while replying to one, say [设定提议] instead of nothing", async () => {
    const only = wire(A1, 3, AG1, "", { proposal: { id: PID, status: "open", persona: "你是一位耐心的旅行规划师。" } });
    const quoting = wire(A1, 4, ME_ID, "这个好", { replyTo: { seq: 3, visible: true, senderId: AG1, text: "", kind: "text" } });
    await openAgentChat({ messages: [...BASE, only, quoting] });
    expect(storedLi(4).querySelector("blockquote").textContent).toContain("[设定提议]");
  });

  it("a deleted Agent's open proposal can no longer be decided", async () => {
    await openAgentChat({ agent: { deleted: true }, messages: [...BASE, proposed("open")] });
    expect(card().textContent).toContain("未确认");
    expect(card().textContent).not.toContain("待你确认");
    for (const name of ["确认", "修改后确认", "放弃"]) expect(cardButton(name)).toBeNull();
  });

  it("a proposal without 简介 or 擅长领域 shows neither", async () => {
    await openAgentChat({ messages: [...BASE, proposed("open", { intro: undefined, field: undefined })] });
    expect(card().textContent).not.toContain("简介");
    expect(card().textContent).not.toContain("擅长领域");
  });

  it("a long persona is folded beyond a few lines and can be opened", async () => {
    await openAgentChat({ messages: [...BASE, proposed("open", { persona: LONG })] });
    expect(card().textContent).not.toContain("第12行");
    const more = cardButton("展开全部");
    expect(more.getAttribute("aria-expanded")).toBe("false");
    await click(more);
    expect(card().textContent).toContain("第12行");
    expect(cardButton("收起").getAttribute("aria-expanded")).toBe("true");
  });

  it("确认 confirms the proposal as it is, and the card reads 已采用", async () => {
    const { api } = await openAgentChat({ messages: [...BASE, proposed("open")] });
    await click(cardButton("确认"));
    expect(api.confirmProposal).toHaveBeenCalledTimes(1);
    expect(api.confirmProposal.mock.calls[0].slice(0, 2)).toEqual([AG1, PID]);
    expect(api.confirmProposal.mock.calls[0][2]).toBeUndefined();
    expect(card().textContent).toContain("已采用");
    expect(cardButton("确认")).toBeNull();
  });

  it("修改后确认 opens the text in an editor and confirms with the values I changed, only those", async () => {
    const { api } = await openAgentChat({ messages: [...BASE, proposed("open")] });
    await click(cardButton("修改后确认"));
    const editor = within(dialog());
    expect(editor.getByLabelText("人格文档").value).toBe("你是一位耐心的旅行规划师。");
    expect(editor.getByLabelText("擅长领域").value).toBe("旅行");
    fireEvent.change(editor.getByLabelText("人格文档"), { target: { value: "你是一位细心的旅行规划师。" } });
    fireEvent.change(editor.getByLabelText("简介"), { target: { value: "规划你的下一次旅行" } });
    await click(editor.getByRole("button", { name: "确认" }));
    expect(api.confirmProposal).toHaveBeenCalledWith(AG1, PID, { persona: "你是一位细心的旅行规划师。", intro: "规划你的下一次旅行" });
    expect(dialog()).toBeNull();
    expect(card().textContent).toContain("已采用");
  });

  it("an editor confirmed unchanged sends no edits (white space around the persona is no change)", async () => {
    const { api } = await openAgentChat({ messages: [...BASE, proposed("open")] });
    await click(cardButton("修改后确认"));
    fireEvent.change(within(dialog()).getByLabelText("人格文档"), { target: { value: "  你是一位耐心的旅行规划师。\n" } });
    await click(within(dialog()).getByRole("button", { name: "确认" }));
    expect(api.confirmProposal).toHaveBeenCalledWith(AG1, PID, {});
  });

  it("an over-long 简介 the Agent proposed does not block a confirm that changes only the persona", async () => {
    const long = "很".repeat(41);
    const { api } = await openAgentChat({ messages: [...BASE, proposed("open", { intro: long })] });
    await click(cardButton("修改后确认"));
    fireEvent.change(within(dialog()).getByLabelText("人格文档"), { target: { value: "新的人格" } });
    await click(within(dialog()).getByRole("button", { name: "确认" }));
    expect(api.confirmProposal).toHaveBeenCalledWith(AG1, PID, { persona: "新的人格" });
    // Changed, it is checked like any value I write.
    cleanup();
    const again = await openAgentChat({ messages: [...BASE, proposed("open", { intro: long })] });
    await click(cardButton("修改后确认"));
    fireEvent.change(within(dialog()).getByLabelText("简介"), { target: { value: `${long}了` } });
    await click(within(dialog()).getByRole("button", { name: "确认" }));
    expect(again.api.confirmProposal).not.toHaveBeenCalled();
    expect(dialog().textContent).toContain("简介不超过 40 个字");
  });

  it("while the editor's confirm is on its way, the card's 确认 and 放弃 wait too", async () => {
    const answer = deferred();
    const { api } = await openAgentChat({ messages: [...BASE, proposed("open")], api: { confirmProposal: vi.fn(() => answer.promise) } });
    await click(cardButton("修改后确认"));
    fireEvent.change(within(dialog()).getByLabelText("人格文档"), { target: { value: "新的人格" } });
    await click(within(dialog()).getByRole("button", { name: "确认" }));
    const actionsRow = within(card().querySelector(".card-actions"));
    for (const name of ["确认", "修改后确认", "放弃"]) expect(actionsRow.getByRole("button", { name }).disabled, name).toBe(true);
    expect(within(dialog()).getByRole("button", { name: "处理中…" }).disabled).toBe(true);
    await act(async () => answer.resolve(agentOf(AG1, { model: SITE_FREE, persona: "新的人格", personaVersion: 2 })));
    await flush();
    expect(api.confirmProposal).toHaveBeenCalledTimes(1);
    expect(card().textContent).toContain("已采用");
  });

  it("while the card's 确认 is on its way, 修改后确认 and 放弃 wait too", async () => {
    const answer = deferred();
    await openAgentChat({ messages: [...BASE, proposed("open")], api: { confirmProposal: vi.fn(() => answer.promise) } });
    await click(cardButton("确认"));
    for (const name of ["处理中…", "修改后确认", "放弃"]) expect(cardButton(name).disabled, name).toBe(true);
    await act(async () => answer.resolve(agentOf(AG1, { model: SITE_FREE, persona: "x", personaVersion: 2 })));
    await flush();
  });

  it("the editor refuses an empty persona and sends nothing", async () => {
    const { api } = await openAgentChat({ messages: [...BASE, proposed("open", { intro: undefined, field: undefined })] });
    await click(cardButton("修改后确认"));
    expect(within(dialog()).queryByLabelText("简介")).toBeNull();
    fireEvent.change(within(dialog()).getByLabelText("人格文档"), { target: { value: "   " } });
    await click(within(dialog()).getByRole("button", { name: "确认" }));
    expect(api.confirmProposal).not.toHaveBeenCalled();
    expect(dialog().textContent).toContain("人格文档不能为空");
  });

  it("放弃 discards it, and the card reads 已放弃", async () => {
    const { api } = await openAgentChat({ messages: [...BASE, proposed("open")] });
    await click(cardButton("放弃"));
    expect(api.discardProposal).toHaveBeenCalledWith(AG1, PID);
    expect(card().textContent).toContain("已放弃");
  });

  it("a confirm refused as stale fetches the card again and ends in the stale card, with no toast", async () => {
    const { api, transport } = await openAgentChat({
      messages: [...BASE, proposed("open")],
      api: { confirmProposal: vi.fn(async () => Promise.reject(apiError(409, "stale_proposal"))) },
      handlers: { message: () => ({ message: proposed("stale"), principals: [] }) },
    });
    await click(cardButton("确认"));
    await flush();
    expect(api.confirmProposal).toHaveBeenCalledTimes(1);
    expect(transport.agentLog).toContainEqual(["message", A1, 3]);
    expect(card().textContent).toContain("配置已变更，请重新生成提议");
    expect(cardButton("确认")).toBeNull();
    expect(toastText()).toBeNull();
  });

  it("while the card is not fetched again yet, the refusal's sentence is on the card", async () => {
    const hold = deferred();
    await openAgentChat({
      messages: [...BASE, proposed("open")],
      api: { confirmProposal: vi.fn(async () => Promise.reject(apiError(409, "stale_proposal"))) },
      handlers: { message: () => hold.promise },
    });
    await click(cardButton("确认"));
    expect(card().textContent).toContain("这份提议已失效，请让它重新生成提议。");
    await act(async () => hold.resolve({ message: proposed("superseded"), principals: [] }));
    await flush();
    expect(card().textContent).toContain("已被新的提议取代");
    expect(card().textContent).not.toContain("这份提议已失效");
  });
});

describe("the image hint", () => {
  const pick = async (files) => {
    fireEvent.change(screen.getByLabelText("选择图片"), { target: { files } });
    await flush();
  };
  const hint = () => screen.queryByText(IMAGE_HINT);

  it("shows when an image is picked for a model that cannot see images", async () => {
    await openAgentChat({ agent: { model: SITE_FREE } });
    expect(hint()).toBeNull();
    await pick([fakeFile("a.png", 5, "image/png")]);
    expect(hint()).not.toBeNull();
    expect(hint().closest(".composer")).not.toBeNull();
  });

  it("shows for a pasted image too, never for a file that is not an image", async () => {
    await openAgentChat({ agent: { model: SITE_FREE } });
    fireEvent.paste(input(), { clipboardData: { files: [fakeFile("note.txt", 5, "text/plain")], getData: () => "" } });
    await flush();
    expect(hint()).toBeNull();
    fireEvent.paste(input(), { clipboardData: { files: [fakeFile("shot.png", 5, "image/png")], getData: () => "" } });
    await flush();
    expect(hint()).not.toBeNull();
  });

  it("does not show for a model that sees images, or with no model chosen", async () => {
    await openAgentChat({ agent: { model: SITE_PAID } });
    await pick([fakeFile("a.png", 5, "image/png")]);
    expect(hint()).toBeNull();
    cleanup();
    await openAgentChat({ agent: { model: null } });
    await pick([fakeFile("a.png", 5, "image/png")]);
    expect(hint()).toBeNull();
  });

  it("goes once that image's upload settles: sent, or refused", async () => {
    const image = { id: "00000000-0000-4000-8000-00000000f001", name: "a.png", size: 5, inline: true };
    let upload = deferred();
    const sendMessage = vi.fn(async () => ({ message: wire(A1, 3, ME_ID, "", { kind: "file", attachment: image }), duplicate: false }));
    await openAgentChat({ agent: { model: SITE_FREE }, api: { uploadAttachment: vi.fn(() => upload.promise), sendMessage } });
    await pick([fakeFile("a.png", 5, "image/png")]);
    expect(hint()).not.toBeNull();
    await act(async () => upload.resolve(image));
    await flush();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(hint()).toBeNull();

    upload = deferred();
    await pick([fakeFile("b.png", 5, "image/png")]);
    expect(hint()).not.toBeNull();
    await act(async () => upload.reject(apiError(415, "unsupported_media_type")));
    await flush();
    expect(hint()).toBeNull();
  });

  it("goes when another conversation is opened, and does not come back with this one", async () => {
    await openAgentChat({ agent: { model: SITE_FREE }, extra: [direct(D1, ANN)] });
    await pick([fakeFile("a.png", 5, "image/png")]);
    expect(hint()).not.toBeNull();
    await click(screen.getByText("小安", { selector: ".list-col .row-name" }));
    expect(hint()).toBeNull();
    await click(screen.getByText("小助手", { selector: ".list-col .row-name" }));
    expect(hint()).toBeNull();
  });

  it("a provider's model is looked up in my providers", async () => {
    const { api } = await openAgentChat({ agent: { model: { source: "provider", providerId: P1, model: "gpt-x" } }, providers: [providerOf()] });
    await pick([fakeFile("a.png", 5, "image/png")]);
    expect(api.listProviders).toHaveBeenCalled();
    expect(hint()).not.toBeNull();
  });
});

describe("scrolling", () => {
  /**
   * Gives the message list a layout jsdom lacks: `height` px of content (3000; `list.grow(px)` changes it) in a 600 px
   * box, scrolled to `scrollTop` (set beyond the end, it stops at the end, as a browser's does); `list.heightReads`
   * counts the reads of its scrollHeight.
   */
  function tallList(scrollTop, height = 3000) {
    const list = timeline();
    let top = scrollTop;
    let content = height;
    const end = () => content - 600;
    Object.defineProperty(list, "scrollTop", { configurable: true, get: () => top, set: (v) => (top = Math.max(0, Math.min(v, end()))) });
    Object.defineProperty(list, "scrollHeight", {
      configurable: true,
      get: () => {
        list.heightReads += 1;
        return content;
      },
    });
    Object.defineProperty(list, "clientHeight", { configurable: true, get: () => 600 });
    list.heightReads = 0;
    list.grow = (px) => {
      content += px;
      top = Math.min(top, end());
    };
    return list;
  }
  /** The person scrolls the list to `top` (from where it is). */
  const scrollTo = (list, top) => {
    list.scrollTop = top;
    fireEvent.scroll(list);
  };

  /** The list at its end, then a reply running in it. */
  async function streaming() {
    const app = await openAgentChat();
    const list = tallList(2400);
    fireEvent.scroll(list);
    await runPush(app.transport, runOf(R1, "running"));
    return { ...app, list };
  }

  it("follows the streaming bubble only while the list is at the bottom", async () => {
    const { transport, list } = await streaming();
    scrollTo(list, 1000);
    list.grow(100);
    await deltaPush(transport, { text: "第一段" });
    expect(list.scrollTop).toBe(1000);
    scrollTo(list, 2500); // back at the end
    list.grow(100);
    await deltaPush(transport, { text: "第二段" });
    expect(list.scrollTop).toBe(2600);
    list.grow(100);
    await deltaPush(transport, { reasoning: "想" });
    expect(list.scrollTop).toBe(2700);
  });

  it("follows the bubble as it is revealed between pieces too, only while the list is at the bottom", async () => {
    const { transport, list } = await streaming();
    await deltaPush(transport, { text: "第一段".repeat(100) });
    // The bubble grows at the frames, with no piece arriving: the list stays at its end.
    list.grow(200);
    await elapse(50);
    expect(list.scrollTop).toBe(2600);
    // Scrolled up: the frames leave it where it is.
    scrollTo(list, 1000);
    list.grow(200);
    await elapse(50);
    expect(list.scrollTop).toBe(1000);
  });

  it("content growing under a list kept at its end never unsticks it, even when a scroll event comes meanwhile", async () => {
    const { transport, list } = await streaming();
    // Something grows 300 px before the list follows, and a scroll event comes (the browser's, for the list's own
    // last move): the person did not scroll.
    list.grow(300);
    fireEvent.scroll(list);
    await deltaPush(transport, { text: "第一段" });
    expect(list.scrollTop).toBe(2700);
  });

  it("scrolling up unsticks it, even a little (no pulling back against the person); coming back within 48 px of the end sticks it again", async () => {
    const { transport, list } = await streaming();
    scrollTo(list, 2390);
    list.grow(100);
    await deltaPush(transport, { text: "第一段" });
    expect(list.scrollTop).toBe(2390);
    // Scrolling down to 40 px from the end (2500 now): stuck again.
    scrollTo(list, 2460);
    list.grow(100);
    await deltaPush(transport, { text: "第二段" });
    expect(list.scrollTop).toBe(2600);
  });

  it("a bubble finishing after its stored message came: the swap keeps a list at its end there, and a scrolled-up list where it was", async () => {
    const { transport, list } = await streaming();
    await deltaPush(transport, { text: "第一段".repeat(200) });
    await elapse(50);
    await messagePush(transport, wire(A1, 3, AG1, "第一段".repeat(200)));
    expect(bubbleLi()).not.toBeNull();
    list.grow(150); // (the stored reply is taller than the bubble was)
    await elapse(REVEAL_FINISH_MS + 100);
    expect(bubbleLi()).toBeNull();
    expect(list.scrollTop).toBe(2550);

    cleanup();
    const again = await streaming();
    await deltaPush(again.transport, { text: "第一段".repeat(200) });
    await elapse(50);
    scrollTo(again.list, 1000);
    await messagePush(again.transport, wire(A1, 3, AG1, "第一段".repeat(200)));
    again.list.grow(150);
    await elapse(REVEAL_FINISH_MS + 100);
    expect(bubbleLi()).toBeNull();
    expect(again.list.scrollTop).toBe(1000);
  });

  it("a burst of 12 000 characters whose stored reply the service cut at 8 000 (已截断): replaced at once — nothing past the stored reply is shown after it came, and a list at its end stays there", async () => {
    // (No Markdown worker: the texts stay plain, so what is in the list is exactly what was revealed or stored.)
    useWorkers(() => {
      throw new Error("no worker");
    });
    const { transport, list } = await streaming();
    const kept = "一二三四五六七八九十".repeat(800); // 8 000 characters
    await deltaPush(transport, { text: `${kept}${"尾".repeat(4000)}` });
    list.grow(200);
    await elapse(50);
    expect(bubbleText().length).toBeGreaterThan(0);
    expect(bubbleText().length).toBeLessThan(8000);
    expect(list.scrollTop).toBe(2600);
    // Everything put in the list from now on.
    const added = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "characterData") added.push(record.target.data);
        for (const node of record.addedNodes ?? []) added.push(node.textContent);
      }
    });
    observer.observe(timeline(), { subtree: true, childList: true, characterData: true });
    const appended = vi.spyOn(CharacterData.prototype, "appendData");
    await messagePush(transport, wire(A1, 3, AG1, kept, { truncated: true }));
    expect(bubbleLi()).toBeNull();
    expect(storedLi(3).querySelector(".bubble").textContent).toBe(kept);
    expect(within(storedLi(3)).getByText("已截断")).toBeTruthy();
    expect(list.scrollTop).toBe(2600);
    await elapse(REVEAL_FINISH_MS + 200);
    observer.disconnect();
    expect(added.length).toBeGreaterThan(0);
    for (const text of added) expect(text).not.toContain("尾");
    for (const [piece] of appended.mock.calls) expect(piece).not.toContain("尾");
    expect(timeline().textContent).not.toContain("尾");
    expect(timeline().querySelectorAll('li[data-msg="m3"]')).toHaveLength(1);
    expect(list.scrollTop).toBe(2600);
    useWorkers();
  });

  it("the list pulled up because its content shrank stays stuck to its end", async () => {
    const { transport, list } = await streaming();
    list.grow(-300); // (the browser moves it up to its new end: 2100)
    fireEvent.scroll(list);
    list.grow(100);
    await deltaPush(transport, { text: "第一段" });
    expect(list.scrollTop).toBe(2200);
  });

  it("while stuck, a frame of the reveal reads the list's height once and its own scroll event none; scrolled up, nothing", async () => {
    // (No Markdown worker: the text stays plain, so nothing but the reveal changes the bubble.)
    useWorkers(() => {
      throw new Error("no worker");
    });
    const { transport, list } = await streaming();
    await deltaPush(transport, { text: "第一段".repeat(200) });
    list.heightReads = 0;
    for (let frame = 1; frame <= 10; frame += 1) {
      list.grow(20);
      await elapse(16);
      expect(list.scrollTop).toBe(2400 + 20 * frame);
    }
    expect(list.heightReads).toBeGreaterThan(0);
    expect(list.heightReads).toBeLessThanOrEqual(10);
    // The scroll event of its own move: nothing to measure.
    list.heightReads = 0;
    fireEvent.scroll(list);
    expect(list.heightReads).toBe(0);
    // Scrolled up: the frames read nothing.
    scrollTo(list, 1000);
    list.heightReads = 0;
    await elapse(160);
    expect(list.heightReads).toBe(0);
    expect(list.scrollTop).toBe(1000);
    useWorkers();
  });
});

describe("mentions", () => {
  it("@ offers the Agent with its account name; choosing it inserts a tag of its name, sent with its id (Task M)", async () => {
    const { api } = await openAgentChat({ agent: { replyMode: "mention" } });
    fireEvent.change(input(), { target: { value: "@", selectionStart: 1, selectionEnd: 1 } });
    const option = screen.getByRole("option", { name: /小助手/ });
    expect(option.textContent).toContain("@helper");
    expect(option.textContent).toContain("Agent · 主人：你");
    fireEvent.click(option);
    expect(input().value).toBe("@小助手 ");
    expect([...document.querySelectorAll(".composer-mirror .mention-chip")].map((c) => c.textContent)).toEqual(["@小助手"]);
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(api.sendMessage).toHaveBeenLastCalledWith(A1, expect.objectContaining({ text: "@小助手", mentions: [{ id: AG1, start: 0, length: 4 }] }));
  });

  it("an Agent's account name is its owner's and its name part (family names): the picker finds it by either", async () => {
    await openAgentChat({ agent: { replyMode: "mention", handle: "me_one.helper" } });
    fireEvent.change(input(), { target: { value: "@me_one.he", selectionStart: 10, selectionEnd: 10 } });
    const option = screen.getByRole("option", { name: /小助手/ });
    expect(option.textContent).toContain("@me_one.helper");
    fireEvent.change(input(), { target: { value: "@help", selectionStart: 5, selectionEnd: 5 } });
    fireEvent.click(screen.getByRole("option", { name: /小助手/ }));
    expect(input().value).toBe("@小助手 ");
  });
});

describe("Agents in a group (batch 2C)", () => {
  const G1 = "00000000-0000-4000-8000-0000000000c2";
  const BO = "00000000-0000-4000-8000-0000000000a3";
  const OAG = "00000000-0000-4000-8000-0000000000b9"; // 小安's Agent
  const annBot = { ...agentPrincipal(OAG, "annbot", "安的助手"), ownerId: ANN, intro: "帮小安记事", field: "记事" };
  const members = [ME_ID, ANN, BO, AG1, OAG].map((id, i) => ({ id, role: "speaker", isCreator: i === 0 }));
  const groupOf = (lastSeq) => ({ id: G1, type: "group", title: "周末小组", creatorId: ME_ID, myRole: "speaker", closed: false, canSend: { ok: true }, members, lastSeq, readSeq: lastSeq, unread: 0 });

  /** The group with my 小助手 and 小安's 安的助手 in it, open; `messages` of the group; `api` and `handlers` as openApp's. */
  async function openGroup(messages = [], { api = {}, handlers = {} } = {}) {
    const lastSeq = messages.reduce((max, m) => Math.max(max, m.seq), 0);
    const sync = () => syncOf([groupOf(lastSeq), agentConv(A1, AG1)], messages, [...PRINCIPALS, { ...agentPrincipal(), ownerId: ME_ID }, annBot]);
    const app = await openApp({
      sync,
      api: { listProviders: vi.fn(async () => ({ providers: [] })), ...api },
      handlers: { agents: () => ({ agents: [agentOf(AG1, { model: SITE_FREE, paused: true })] }), models: () => MODELS, ...handlers },
    });
    await click(screen.getByText("周末小组", { selector: ".list-col .row-name" }));
    return app;
  }
  /** A `run` push of the group: the owner's (`{run}`) or anyone else's (`{state}`). */
  const groupRun = (agentId, fields) => ({ type: "run", conversationId: G1, agentId, ...fields });
  const replyingRows = () => [...timeline().querySelectorAll("li.streaming")];
  const unavailableLines = () => [...timeline().querySelectorAll("li.run-unavailable")];
  const haltButton = () => screen.queryByRole("button", { name: /让 Agent 停下|处理中…/ });
  const groupCalls = (transport) => transport.agentLog.filter((x) => Array.isArray(x) && x[0] === "groupRuns").map((x) => x[1]);

  it("the @ picker shows each Agent with its account name and owner; choosing one inserts a tag of its name, as a person's is", async () => {
    await openGroup();
    fireEvent.change(input(), { target: { value: "@", selectionStart: 1, selectionEnd: 1 } });
    const theirs = screen.getByRole("option", { name: /安的助手/ });
    expect(theirs.textContent).toContain("@annbot");
    expect(theirs.textContent).toContain("Agent · 主人：小安");
    expect(theirs.textContent).not.toContain("已暂停");
    expect(screen.getByRole("option", { name: /小助手/ }).textContent).toContain("Agent · 主人：你 · 已暂停");
    fireEvent.click(theirs);
    expect(input().value).toBe("@安的助手 ");
    fireEvent.change(input(), { target: { value: "@安的助手 @", selectionStart: 7, selectionEnd: 7 } });
    fireEvent.click(screen.getByRole("option", { name: /阿波/ }));
    expect(input().value).toBe("@安的助手 @阿波 ");
    expect([...document.querySelectorAll(".composer-mirror .mention-chip")].map((c) => c.textContent)).toEqual(["@安的助手", "@阿波"]);
  });

  it("a message of someone else's Agent shows its tag, its real owner and its Markdown, and none of the owner's controls", async () => {
    const reply = wire(G1, 2, OAG, "**记好了**：周六见", {
      reasoning: "不该给别人看的思考",
      proposal: { id: PID, status: "open", persona: "不该给别人看的人格" },
    });
    await openGroup([wire(G1, 1, ANN, "@annbot 记一下"), reply]);
    const li = storedLi(2);
    expect(within(li).getByText("Agent", { selector: ".tag" })).toBeTruthy();
    expect(li.querySelector(".msg-meta .owner").textContent).toBe("主人：小安");
    expect(li.querySelector(".bubble .md strong").textContent).toBe("记好了");
    expect(li.querySelector(".thinking")).toBeNull();
    expect(li.querySelector(".proposal-card")).toBeNull();
    expect(li.textContent).not.toMatch(/思考过程|不该给别人看|配置提议/);
    expect(within(li).queryByRole("button", { name: /重试|停止生成|确认|放弃/ })).toBeNull();
    expect(timeline().querySelector("li.run-status, li.streaming")).toBeNull();
  });

  it("a stopped or cut reply of an Agent still says so in a group (my own Agent's with its thinking)", async () => {
    await openGroup([wire(G1, 1, OAG, "说到一半", { stopped: true }), wire(G1, 2, AG1, "很长的回答", { truncated: true, reasoning: "我的思考" })]);
    expect(within(storedLi(1)).getByText("已停止")).toBeTruthy();
    expect(within(storedLi(2)).getByText("已截断")).toBeTruthy();
    expect(storedLi(1).querySelector(".thinking")).toBeNull();
    expect(storedLi(2).querySelector("details.thinking").textContent).toContain("我的思考");
  });

  it("my own Agent's reply in a group shows its thinking as in its own conversation: one 思考过程 above the answer, collapsed until I open it, and no proposal card", async () => {
    const reply = wire(G1, 1, AG1, "**周六**十点", { reasoning: "我的 Agent 想了想", proposal: { id: PID, status: "open", persona: "群里不出卡片" } });
    await openGroup([reply]);
    const li = storedLi(1);
    const details = li.querySelectorAll("details.thinking");
    expect(details).toHaveLength(1);
    const [thinking] = details;
    expect(thinking.querySelector("summary").textContent).toBe("思考过程");
    expect(thinking.open).toBe(false);
    expect(thinking.querySelector(".thinking-text").textContent).toBe("我的 Agent 想了想");
    const parts = [...li.querySelector(".msg-main").children];
    expect(parts.indexOf(thinking)).toBeLessThan(parts.indexOf(li.querySelector(".bubble")));
    expect(li.querySelector(".bubble .md strong").textContent).toBe("周六");
    expect(li.querySelector(".proposal-card")).toBeNull();
    expect(li.textContent).not.toMatch(/群里不出卡片|配置提议/);
    fireEvent.click(thinking.querySelector("summary"));
    expect(thinking.open).toBe(true);
    // The chat list's line is the reply's text, never its thinking.
    const row = screen.getByText("周末小组", { selector: ".list-col .row-name" }).closest("button");
    expect(row.querySelector(".row-preview").textContent).toBe("小助手：周六十点");
  });

  it("my own Agent's reply in a group shows which model and level it used; someone else's Agent's, carrying a via, shows none, stored or pushed; the group's header names no model", async () => {
    localStorage.clear();
    setShowReplyPoints(true);
    try {
      const mine = { model: { source: "site", id: "gpt-6-sol", label: "GPT-6 Sol" }, reasoning: "high", points: "6.9" };
      const theirs = { model: { source: "provider", model: "secret-claude" }, reasoning: "max", points: "12", proactive: true };
      const { transport } = await openGroup([wire(G1, 1, AG1, "周六十点", { via: mine }), wire(G1, 2, OAG, "周日十点", { via: theirs })]);
      await push(transport, { type: "message", message: wire(G1, 3, OAG, "补充一句", { via: theirs }) });
      expect(storedLi(1).querySelector(".msg-via").textContent).toBe("GPT-6 Sol · 思考：高 · 6.9 点");
      for (const seq of [2, 3]) expect(storedLi(seq).querySelector(".msg-via")).toBeNull();
      expect(mainText()).not.toMatch(/secret-claude|思考：最高|12 点|主动回复/);
      expect(document.querySelector(".chat-head .chat-title p").textContent).toBe("3 位真人 · 2 个 Agent");
    } finally {
      act(() => setShowReplyPoints(false));
    }
  });

  it("someone else's Agent's reply carrying a reasoning field shows no thinking at all, wherever it appears", async () => {
    const { transport } = await openGroup([wire(G1, 1, OAG, "周日十点", { reasoning: "别人的 Agent 想的" })]);
    await push(transport, { type: "message", message: wire(G1, 2, OAG, "补充一句", { reasoning: "推来的思考" }) });
    for (const seq of [1, 2]) {
      expect(storedLi(seq).querySelector("details, .thinking")).toBeNull();
      expect(storedLi(seq).textContent).not.toMatch(/思考过程|别人的 Agent 想的|推来的思考/);
    }
    expect(mainText()).not.toMatch(/别人的 Agent 想的|推来的思考/);
  });

  it("a call of mine my own limit stopped: a muted line under my message names the Agent, kept when my message is pushed to me; under nobody else's, and not when the answer says nothing", async () => {
    const tooOften = (who) => `你 @ 得太频繁了，「${who}」这次没有收到，稍后再试。`;
    const notCalled = (...agentIds) => agentIds.map((agentId) => ({ agentId, reason: "caller_rate_limited" }));
    // What each send answers besides the message: the first, the second and the fourth were stopped (the fourth names
    // an Agent this client knows nothing of), the third reached its Agent.
    const extras = [{ notCalled: notCalled(OAG) }, { notCalled: notCalled(OAG, AG1) }, {}, { notCalled: notCalled(STRAY) }];
    let seq = 2;
    const sendMessage = vi.fn(async (_conv, body) => ({ message: wire(G1, ++seq, ME_ID, body.text), duplicate: false, ...extras.shift() }));
    // Someone else's message, whatever it carries, never shows the line.
    const { transport } = await openGroup([wire(G1, 1, ANN, "@annbot 一"), wire(G1, 2, BO, "@annbot 二", { notCalled: notCalled(OAG) })], { api: { sendMessage } });
    const send = async (text) => {
      fireEvent.change(input(), { target: { value: text } });
      fireEvent.keyDown(input(), { key: "Enter" });
      await flush();
    };
    const lines = () => [...timeline().querySelectorAll("li")].filter((li) => li.textContent.includes("这次没有收到")).map((li) => li.getAttribute("data-msg"));

    await send("@annbot 三");
    expect(within(storedLi(3)).getByText(tooOften("安的助手")).className).toBe("muted");
    expect(lines()).toEqual(["m3"]);
    // Several, joined; one that reached its Agent says nothing; a name not known reads 有的 Agent.
    await send("@annbot @helper 四");
    await send("@annbot 五");
    await send("@someone 六");
    expect(within(storedLi(4)).getByText(tooOften("安的助手、小助手"))).toBeTruthy();
    // A name not known: no 「」 (they are for real names).
    expect(within(storedLi(6)).getByText("你 @ 得太频繁了，有的 Agent 这次没有收到，稍后再试。")).toBeTruthy();
    expect(lines()).toEqual(["m3", "m4", "m6"]);
    // My message pushed to me as to every member (it carries nothing of it) keeps the line.
    await push(transport, { type: "message", message: wire(G1, 3, ME_ID, "@annbot 三") });
    expect(lines()).toEqual(["m3", "m4", "m6"]);
  });

  it("a reply being written: 正在回复… only (nothing streams), a row per Agent in member order; its owner can stop it, nobody else", async () => {
    const { transport, api } = await openGroup([], { api: { stopRun: vi.fn(async () => ({ ok: true })) } });
    await push(transport, groupRun(OAG, { state: "replying" }));
    await push(transport, groupRun(AG1, { run: runOf(R1, "running") }));
    await push(transport, { type: "delta", conversationId: G1, runId: R1, text: "不该出现的半句话" });
    const rows = replyingRows();
    expect(rows.map((li) => li.querySelector(".msg-meta strong").textContent)).toEqual(["小助手", "安的助手"]);
    for (const li of rows) {
      expect(li.querySelector(".bubble").textContent).toContain("正在回复…");
      expect(within(li).getByText("Agent", { selector: ".tag" })).toBeTruthy();
    }
    // The identity line is a finished message's: name, Agent tag, 主人：<name> — mine and someone else's.
    expect(rows[0].querySelector(".msg-meta .owner").textContent).toBe("主人：你");
    expect(rows[1].querySelector(".msg-meta .owner").textContent).toBe("主人：小安");
    expect(timeline().textContent).not.toContain("不该出现");
    expect(timeline().querySelector(".thinking")).toBeNull();
    expect(within(rows[1]).queryByRole("button")).toBeNull();
    await click(within(rows[0]).getByRole("button", { name: "停止生成" }));
    expect(api.stopRun).toHaveBeenCalledWith(G1, R1);
    expect(within(replyingRows()[0]).getByRole("button", { name: "停止生成" }).disabled).toBe(true);
    // Each reply, once it is here, takes its row away.
    await push(transport, { type: "message", message: wire(G1, 1, OAG, "在的") });
    expect(replyingRows().map((li) => li.querySelector(".msg-meta strong").textContent)).toEqual(["小助手"]);
    await push(transport, { type: "message", message: wire(G1, 2, AG1, "说到一半", { stopped: true }) });
    await push(transport, groupRun(AG1, { run: runOf(R1, "stopped") }));
    expect(replyingRows()).toHaveLength(0);
    expect(within(storedLi(2)).getByText("已停止")).toBeTruthy();
  });

  it("a failed reply: its owner gets the status line with why, 重试 and 关闭; everyone else one muted line, no reason", async () => {
    const api = { retryRun: vi.fn(async () => ({ run: runOf(R2, "queued") })), dismissRun: vi.fn(async () => ({ ok: true })) };
    const { transport } = await openGroup([], { api });
    await push(transport, groupRun(AG1, { run: runOf(R1, "failed", { error: "busy", retryable: true }) }));
    await push(transport, groupRun(OAG, { state: "unavailable" }));
    expect(statusLines()).toHaveLength(1);
    const line = statusLine();
    expect(line.textContent).toContain("小助手：服务出了点问题，这次没有回复，也没有扣费。可以重试。");
    expect(within(line).getByRole("button", { name: "关闭提示" })).toBeTruthy();
    const muted = unavailableLines();
    expect(muted.map((li) => li.textContent)).toEqual(["安的助手暂时无法回复"]);
    expect(muted[0].classList.contains("run-status")).toBe(false);
    expect(within(muted[0]).queryByRole("button")).toBeNull();
    await click(within(line).getByRole("button", { name: "重试" }));
    expect(api.retryRun).toHaveBeenCalledWith(G1, AG1);
    expect(statusLines()).toHaveLength(0);
    expect(replyingRows()).toHaveLength(1);
    await push(transport, groupRun(AG1, { run: runOf(R2, "failed", { error: "rate_limited", retryable: true }) }));
    await click(within(statusLine()).getByRole("button", { name: "关闭提示" }));
    expect(api.dismissRun).toHaveBeenCalledWith(G1, AG1);
    expect(statusLines()).toHaveLength(0);
    expect(unavailableLines()).toHaveLength(1);
    await push(transport, groupRun(OAG, { state: null }));
    expect(unavailableLines()).toHaveLength(0);
  });

  it("halted, or taken out of the group while replying: the owner is told why, with nothing to retry; closing it asks nothing", async () => {
    const dismissRun = vi.fn(async () => ({ ok: true }));
    const { transport } = await openGroup([], { api: { dismissRun } });
    await push(transport, groupRun(AG1, { run: runOf(R1, "cancelled", { error: "halted", retryable: true }) }));
    expect(statusLine().textContent).toContain("小助手：已被群成员叫停。");
    expect(within(statusLine()).queryByRole("button", { name: "重试" })).toBeNull();
    await push(transport, groupRun(AG1, { run: runOf(R2, "cancelled", { error: "agent_removed" }) }));
    expect(statusLines()).toHaveLength(1);
    expect(statusLine().textContent).toContain("小助手：它已不在这个群里，这条回复没有发出。");
    expect(within(statusLine()).queryByRole("button", { name: "重试" })).toBeNull();
    // (Nothing failed: the service keeps nothing to dismiss, and the Agent may be gone from the group.)
    await click(within(statusLine()).getByRole("button", { name: "关闭提示" }));
    expect(statusLines()).toHaveLength(0);
    expect(dismissRun).not.toHaveBeenCalled();
  });

  it("opening the group loads its Agents' replies; an Agent conversation does not", async () => {
    const answer = { runs: [{ agentId: OAG, state: "replying" }, { agentId: AG1, state: "unavailable", run: runOf(R1, "failed", { error: "busy", retryable: true }) }] };
    const { transport } = await openGroup([], { handlers: { groupRuns: () => answer } });
    expect(groupCalls(transport)).toEqual([G1]);
    expect(replyingRows().map((li) => li.querySelector(".msg-meta strong").textContent)).toEqual(["安的助手"]);
    expect(statusLine().textContent).toContain("小助手：");
    await click(screen.getByText("小助手", { selector: ".list-col .row-name" }));
    expect(groupCalls(transport)).toEqual([G1]);
  });

  it("the connection coming back while the group is open loads its replies again", async () => {
    const { transport, timers } = await openGroup();
    expect(groupCalls(transport)).toEqual([G1]);
    transport.handlers.groupRuns = () => ({ runs: [{ agentId: OAG, state: "replying" }] });
    await act(async () => transport.socket.drop(1006));
    await act(async () => timers.advance(60_000));
    await flush();
    expect(groupCalls(transport)).toEqual([G1, G1]);
    expect(replyingRows()).toHaveLength(1);
  });

  it("让 Agent 停下: for every member when Agents answer each other (an Agent's newest message calls another, or an Agent's reply is under way after an Agent's message), not for a reply a person asked for; it asks the group", async () => {
    const halt = deferred();
    const { transport, api } = await openGroup([wire(G1, 1, ANN, "@annbot 你好")], { api: { haltAgents: vi.fn(() => halt.promise) } });
    expect(haltButton()).toBeNull();
    // A person's @-mention and the reply being written to it: nothing to halt.
    await push(transport, groupRun(OAG, { state: "replying" }));
    expect(replyingRows()).toHaveLength(1);
    expect(haltButton()).toBeNull();
    await push(transport, { type: "message", message: wire(G1, 2, OAG, "问问 @helper 吧", { mentions: [{ id: AG1, start: 3, length: 7 }] }) });
    await push(transport, groupRun(OAG, { state: null }));
    expect(replyingRows()).toHaveLength(0);
    expect(haltButton()).toBeTruthy();
    // Above the composer, below the messages.
    expect(haltButton().compareDocumentPosition(document.querySelector(".composer")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(haltButton().compareDocumentPosition(timeline()) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    await click(haltButton());
    expect(api.haltAgents).toHaveBeenCalledWith(G1);
    expect(haltButton().disabled).toBe(true);
    await click(haltButton());
    expect(api.haltAgents).toHaveBeenCalledTimes(1);
    await act(async () => halt.resolve({ ok: true }));
    await flush();
    expect(haltButton().disabled).toBe(false);
    await push(transport, { type: "message", message: notice(G1, 3, "Mei 让 Agent 停止了接话", { event: "agents_halted", actorId: ME_ID }) });
    expect(haltButton()).toBeNull();
    expect(timeline().textContent).toContain("你让 Agent 停止了接话");
  });

  it("让 Agent 停下 stays away when no Agent calls another; a refusal says why", async () => {
    const haltAgents = vi.fn(async () => Promise.reject(apiError(429, "rate_limited")));
    const { transport } = await openGroup(
      [wire(G1, 1, OAG, "我是 @annbot，有事找 @ann", { mentions: [{ id: OAG, start: 3, length: 7 }, { id: ANN, start: 15, length: 4 }] })],
      { api: { haltAgents } },
    );
    expect(haltButton()).toBeNull();
    await push(transport, { type: "message", message: wire(G1, 2, ANN, "@helper @annbot 你们聊", { mentions: [{ id: AG1, start: 0, length: 7 }, { id: OAG, start: 8, length: 7 }] }) });
    expect(haltButton()).toBeNull();
    // An Agent's message naming another Agent in its text only (nothing stored for it) calls nobody.
    await push(transport, { type: "message", message: wire(G1, 3, AG1, "@annbot 等等") });
    expect(haltButton()).toBeNull();
    await push(transport, { type: "message", message: wire(G1, 4, AG1, "@annbot 交给你了", { mentions: [{ id: OAG, start: 0, length: 7 }] }) });
    await click(haltButton());
    expect(toastText()).toBe("叫停太频繁了，请稍等一会儿再试。");
    expect(haltButton().disabled).toBe(false);
  });

  it("让 Agent 停下 stays away while an Agent answers a person, its acknowledgement the newest message", async () => {
    const { transport } = await openGroup([wire(G1, 1, ANN, "@annbot 查一下")]);
    await push(transport, { type: "message", message: wire(G1, 2, OAG, "我先查一下。", { ack: true }) });
    await push(transport, groupRun(OAG, { state: "replying" }));
    expect(replyingRows()).toHaveLength(1);
    expect(haltButton()).toBeNull();
  });

  it("让 Agent 停下 stays away for an Agent's acknowledgement naming another Agent: it calls nobody; its answer naming one does", async () => {
    const { transport } = await openGroup([wire(G1, 1, ANN, "@annbot 查一下")]);
    await push(transport, { type: "message", message: wire(G1, 2, OAG, "我问问 @helper 。", { ack: true }) });
    expect(haltButton()).toBeNull();
    await push(transport, { type: "message", message: wire(G1, 3, OAG, "@helper 你看看", { mentions: [{ id: AG1, start: 0, length: 7 }] }) });
    expect(haltButton()).toBeTruthy();
  });

  const EVERYWHERE = "换了以后，它在所有会话里都用这个模型";
  const optionNamed = (name) => [...document.querySelectorAll('.model-pop [role="option"]')].find((o) => o.querySelector(".model-name")?.textContent === name);
  const keepAgent = async (_id, patch) => agentOf(AG1, { model: SITE_FREE, paused: true, ...patch });

  it("a group's header has no model picker; its details panel has one at the right of each Agent of mine, and of nobody else, saying the change is everywhere", async () => {
    const patchAgent = vi.fn(keepAgent);
    await openGroup([], { api: { patchAgent } });
    expect(document.querySelector(".chat-head").querySelector('[aria-haspopup="listbox"]')).toBeNull();
    await click(screen.getByRole("button", { name: "会话资料" }));
    const side = document.querySelector(".side-col");
    expect([...side.querySelectorAll(".kv-row dt")].map((dt) => dt.textContent)).not.toContain("模型");
    const rows = () => [...side.querySelectorAll(".side-list li")];
    const rowOf = (name) => rows().find((li) => li.querySelector(".identity-line strong").textContent === name);
    // 安的助手 is 小安's Agent; the people have no model.
    for (const li of rows().filter((li) => li !== rowOf("小助手"))) expect(li.querySelector('[aria-haspopup="listbox"]')).toBeNull();
    const button = within(rowOf("小助手")).getByRole("button", { name: "模型：小模型，点击更改" });
    expect(button.getAttribute("aria-haspopup")).toBe("listbox");
    await click(button);
    expect(document.querySelector(".model-pop .model-scope").textContent).toBe(EVERYWHERE);
    expect(optionNamed("小模型").getAttribute("aria-selected")).toBe("true");
    await click(optionNamed("大模型"));
    expect(patchAgent).toHaveBeenCalledTimes(1);
    expect(patchAgent).toHaveBeenCalledWith(AG1, { model: SITE_PAID, reasoning: "none" });
    expect(within(rowOf("小助手")).getByRole("button").textContent).toBe("大模型");
  });

  it("under my Agent's reply in a group its model is a quiet button to the same picker; the line keeps saying what that reply used; someone else's Agent's reply has none", async () => {
    const patchAgent = vi.fn(keepAgent);
    const mine = { model: { source: "site", id: "free-1", label: "小模型" }, reasoning: "none", points: "0.1" };
    const theirs = { model: { source: "provider", model: "secret-claude" }, reasoning: "max", points: "12" };
    await openGroup([wire(G1, 1, AG1, "周六十点", { via: mine }), wire(G1, 2, OAG, "周日十点", { via: theirs })], { api: { patchAgent } });
    const via = () => storedLi(1).querySelector(".msg-via");
    expect(via().textContent).toBe("小模型 · 不思考");
    const button = within(via()).getByRole("button", { name: "模型：小模型，点击更改" });
    expect(button.getAttribute("aria-haspopup")).toBe("listbox");
    expect(storedLi(2).querySelector(".msg-via")).toBeNull();
    expect(storedLi(2).querySelector('[aria-haspopup="listbox"]')).toBeNull();
    await click(button);
    expect(document.querySelector(".model-pop .model-scope").textContent).toBe(EVERYWHERE);
    await click(optionNamed("大模型"));
    expect(patchAgent).toHaveBeenCalledTimes(1);
    expect(patchAgent).toHaveBeenCalledWith(AG1, { model: SITE_PAID, reasoning: "none" });
    expect(via().textContent).toBe("小模型 · 不思考");
  });

  it("a refused switch from a reply's line says why in the update's words; the line stays as it was", async () => {
    const patchAgent = vi.fn(async () => {
      throw apiError(400, "invalid_request");
    });
    const mine = { model: { source: "site", id: "free-1", label: "小模型" }, reasoning: "none", points: "0.1" };
    // (The refusal makes the client read the Agent again: the service still holds it as it was.)
    const handlers = { agent: () => agentOf(AG1, { model: SITE_FREE, paused: true }) };
    await openGroup([wire(G1, 1, AG1, "周六十点", { via: mine })], { api: { patchAgent }, handlers });
    await click(within(storedLi(1).querySelector(".msg-via")).getByRole("button"));
    await click(optionNamed("大模型"));
    expect(toastText()).toBe("填写的内容有误，或所选模型、思考程度不可用。");
    expect(storedLi(1).querySelector(".msg-via").textContent).toBe("小模型 · 不思考");
    expect(within(storedLi(1).querySelector(".msg-via")).getByRole("button").getAttribute("aria-disabled")).toBeNull();
  });
});

describe("switching the model where I am (my Agent's own conversation)", () => {
  const headModel = () => document.querySelector(".chat-head .chat-title p button");
  const listbox = () => screen.queryByRole("listbox");
  const rowOf = (name) => [...listbox().querySelectorAll('[role="option"]')].find((o) => o.querySelector(".model-name")?.textContent === name);
  const side = () => document.querySelector(".side-col");
  const sideModel = () => [...side().querySelectorAll(".kv-row")].find((r) => r.querySelector("dt").textContent === "模型") ?? null;
  const openDetails = () => click(screen.getByRole("button", { name: "会话资料" }));
  const keep = (record) => vi.fn(async (_id, patch) => ({ ...record, ...patch }));

  it("the chat reads no models until the picker opens; then it lists the site's and my providers' models, the current one marked", async () => {
    const getUsage = vi.fn(async () => usageOf());
    const { api } = await openAgentChat({ providers: [providerOf()], api: { getUsage } });
    expect(api.listProviders).not.toHaveBeenCalled();
    expect(getUsage).not.toHaveBeenCalled();
    await click(headModel());
    expect(api.listProviders).toHaveBeenCalledTimes(1);
    expect([...listbox().querySelectorAll('[role="group"]')].map((g) => g.getAttribute("aria-label"))).toEqual(["站点提供", "我的供应商 · 我的 OpenAI"]);
    expect(rowOf("小模型").getAttribute("aria-selected")).toBe("true");
    expect(rowOf("gpt-x").getAttribute("aria-selected")).toBe("false");
  });

  it("choosing a model saves it with one update of the Agent (its level kept when the new model takes it, else 不思考), the button off meanwhile", async () => {
    const record = agentOf(AG1, { model: SITE_PAID, reasoning: "high" });
    const saving = deferred();
    const patchAgent = vi.fn(() => saving.promise);
    await openAgentChat({ agent: { model: SITE_PAID, reasoning: "high" }, providers: [providerOf()], api: { patchAgent } });
    await click(headModel());
    await click(rowOf("gpt-x"));
    expect(patchAgent).toHaveBeenCalledTimes(1);
    expect(patchAgent).toHaveBeenCalledWith(AG1, { model: PROVIDER_MODEL, reasoning: "high" });
    expect(listbox()).toBeNull();
    // Off while it saves: it opens nothing, yet keeps the focus.
    expect(headModel().getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(headModel());
    await click(headModel());
    expect(listbox()).toBeNull();
    expect(headModel().textContent).toBe("gpt-x");
    await act(async () => saving.resolve({ ...record, model: PROVIDER_MODEL }));
    await flush();
    expect(headModel().getAttribute("aria-disabled")).toBeNull();
    expect(headModel().textContent).toBe("gpt-x");
    expect(headModel().getAttribute("aria-label")).toBe("模型：gpt-x，点击更改");
    expect(toastText()).toBeNull();

    patchAgent.mockImplementation(keep({ ...record, model: PROVIDER_MODEL }));
    await click(headModel());
    await click(rowOf("小模型"));
    expect(patchAgent).toHaveBeenLastCalledWith(AG1, { model: SITE_FREE, reasoning: "none" });
    expect(headModel().textContent).toBe("小模型");
  });

  it("while my providers are being read it says so, and no key chooses a row it does not show", async () => {
    const reading = deferred();
    const patchAgent = vi.fn();
    await openAgentChat({ api: { listProviders: vi.fn(() => reading.promise), patchAgent } });
    await click(headModel());
    expect(listbox()).toBeNull();
    const line = document.querySelector(".model-pop .model-empty");
    expect(line.getAttribute("role")).toBe("status");
    expect(line.textContent).toBe("正在读取可用的模型…");
    const search = screen.getByRole("combobox", { name: "搜索模型" });
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });
    await flush();
    expect(patchAgent).not.toHaveBeenCalled();
    await act(async () => reading.resolve({ providers: [providerOf()] }));
    await flush();
    expect(rowOf("gpt-x")).toBeTruthy();
    fireEvent.keyDown(document.body, { key: "Escape" });
    await flush();
    expect(listbox()).toBeNull();
    expect(document.activeElement).toBe(headModel());
  });

  it("choosing the model it has already sends nothing", async () => {
    const patchAgent = vi.fn();
    await openAgentChat({ providers: [providerOf()], api: { patchAgent } });
    await click(headModel());
    await click(rowOf("小模型"));
    expect(listbox()).toBeNull();
    expect(patchAgent).not.toHaveBeenCalled();
  });

  it("a refused save says why (the update's own words) and the button goes back to the stored model", async () => {
    const patchAgent = vi.fn(async () => {
      throw apiError(400, "invalid_request");
    });
    await openAgentChat({ providers: [providerOf()], api: { patchAgent } });
    await click(headModel());
    await click(rowOf("大模型"));
    expect(toastText()).toBe("填写的内容有误，或所选模型、思考程度不可用。");
    expect(headModel().textContent).toBe("小模型");
    expect(headModel().getAttribute("aria-disabled")).toBeNull();
  });

  it("an Agent deleted elsewhere: the save says so, and the model is a plain label from then on", async () => {
    const patchAgent = vi.fn(async () => {
      throw apiError(409, "agent_deleted");
    });
    await openAgentChat({ providers: [providerOf()], api: { patchAgent } });
    await click(headModel());
    await click(rowOf("大模型"));
    expect(toastText()).toBe("这个 Agent 已删除。");
    expect(document.querySelector(".chat-head .chat-title p").textContent).toBe("你的 Agent · 专属会话 · 小模型");
    expect(patchAgent).toHaveBeenCalledTimes(1);
    cleanup();
    await openAgentChat({ agent: { deleted: true }, providers: [providerOf()] });
    expect(document.querySelector(".chat-head .chat-title p").textContent).toContain("小模型");
    expect(headModel()).toBeNull();
  });

  it("管理供应商 at the foot of the list leads to Settings › 模型供应商", async () => {
    await openAgentChat({ providers: [providerOf()] });
    await click(headModel());
    await click(within(document.querySelector(".model-foot")).getByRole("button", { name: "管理供应商" }));
    expect(listbox()).toBeNull();
    expect(screen.getByRole("heading", { name: "我的模型供应商" })).toBeTruthy();
  });

  it("the details panel has a 模型 row above 操作 with the same picker, which saves the same way", async () => {
    const record = agentOf(AG1, { model: SITE_FREE });
    const patchAgent = vi.fn(keep(record));
    await openAgentChat({ providers: [providerOf()], api: { patchAgent } });
    await openDetails();
    const row = sideModel();
    expect(row).not.toBeNull();
    const heading = [...side().querySelectorAll("h3")].find((h) => h.textContent === "操作");
    expect(row.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const button = within(row).getByRole("button", { name: "模型：小模型，点击更改" });
    expect(button.getAttribute("aria-haspopup")).toBe("listbox");
    await click(button);
    await click(rowOf("plain"));
    expect(patchAgent).toHaveBeenCalledWith(AG1, { model: { source: "provider", providerId: P1, model: "plain" }, reasoning: "none" });
    expect(within(sideModel()).getByRole("button").textContent).toBe("plain");
    expect(headModel().textContent).toBe("plain");
  });

  it("a deleted Agent's details panel shows its model as a plain label", async () => {
    await openAgentChat({ agent: { deleted: true } });
    await openDetails();
    expect(sideModel().querySelector("dd").textContent).toBe("小模型");
    expect(within(sideModel()).queryByRole("button")).toBeNull();
  });
});
