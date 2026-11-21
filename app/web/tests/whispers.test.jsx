// @vitest-environment jsdom
// Whispers (悄悄话): a small note in a conversation only I see, about my Agent there, with the buttons it offers (告诉他们,
// 不用). It sits after the message it follows (`afterSeq`; several there by when they were made), says 只有你能看到 with a
// lock, and once answered stays as a quiet line (已告诉他们 / 已忽略 / 已过期). One decision at a time. The chat list marks
// a conversation with open ones. Contract: app/service/README.md "Whispers".
import "./markdown-ready.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { A1, AG1, ANN, BO, G1, ME_ID, MODELS, PRINCIPALS, agentConv, agentOf, agentPrincipal, apiError, at, deferred, group, range, syncOf, wire } from "./fixtures.js";
import { click, elapse, flush, installBrowser, openApp, push } from "./harness.jsx";
import { WHISPER_RETRY_MS } from "../src/data/actions.js";
import { applyCatchup, applyGone, applySync, applyWhisper, initial } from "../src/data/model.js";
import { placeWhispers } from "../src/data/viewmodel.js";

beforeEach(() => {
  installBrowser();
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const SITE_FREE = { source: "site", id: "free-1" };
/** A whisper of mine about AG1, after `afterSeq` in `conversationId`. */
const whisper = (id, conversationId, afterSeq, fields = {}) => ({
  id,
  conversationId,
  agentId: AG1,
  afterSeq,
  kind: "found_elsewhere",
  text: `悄悄话 ${id}`,
  actions: ["tell", "dismiss"],
  status: "open",
  createdAt: at(afterSeq),
  ...fields,
});
const MEMBERS = [...group().members, { id: AG1, role: "speaker", isCreator: false }];

/** My group (with my Agent in it) and my Agent's own conversation; the group is opened. */
async function openGroup({ messages = range(G1, 1, 3, [ANN, BO]), whispers, api = {}, open = "周末小组" } = {}) {
  const lastSeq = messages.reduce((max, m) => Math.max(max, m.seq), 0);
  const record = agentOf(AG1, { model: SITE_FREE });
  const conversations = [group(G1, { lastSeq, readSeq: lastSeq, members: MEMBERS }), agentConv(A1, AG1)];
  const app = await openApp({
    sync: () => ({ ...syncOf(conversations, messages, [...PRINCIPALS, { ...agentPrincipal(), ownerId: ME_ID }]), ...(whispers ? { whispers } : {}) }),
    api: {
      acceptWhisper: vi.fn(async (id) => ({ ...whispers.find((w) => w.id === id), status: "accepted" })),
      declineWhisper: vi.fn(async (id) => ({ ...whispers.find((w) => w.id === id), status: "declined" })),
      listWhispers: vi.fn(async () => ({ whispers: [], nextBefore: null })),
      listProviders: vi.fn(async () => ({ providers: [] })),
      ...api,
    },
    handlers: { agents: () => ({ agents: [record] }), agent: () => record, run: () => ({ run: null }), models: () => MODELS },
  });
  if (open) await click(screen.getByText(open, { selector: ".list-col .row-name" }));
  return app;
}

const timeline = () => document.querySelector("ol.messages");
/** The list's rows as `m<seq>` (a message) or `w:<id>` (a whisper), in order. */
const rows = () => [...timeline().children].filter((li) => li.dataset.msg || li.dataset.whisper).map((li) => (li.dataset.msg ? li.dataset.msg : `w:${li.dataset.whisper}`));
const whisperLi = (id) => timeline().querySelector(`li[data-whisper="${id}"]`);
const inWhisper = (id) => within(whisperLi(id));
const listRow = (name) => screen.getByText(name, { selector: ".list-col .row-name" }).closest("button");
const DOT = "有只给你的悄悄话";

describe("a whisper in the conversation", () => {
  it("shows after the message it follows (several there by when they were made), with a lock and 只有你能看到", async () => {
    await openGroup({
      whispers: [whisper("w2", G1, 2, { createdAt: at(30), text: "后来的" }), whisper("w1", G1, 2, { createdAt: at(20), text: "先来的" }), whisper("w3", G1, 3)],
    });
    expect(rows()).toEqual(["m1", "m2", "w:w1", "w:w2", "m3", "w:w3"]);
    expect(whisperLi("w1").textContent).toContain("只有你能看到");
    expect(whisperLi("w1").textContent).toContain("先来的");
    expect(whisperLi("w1").querySelector("svg")).toBeTruthy();
    expect(inWhisper("w1").getByRole("button", { name: "告诉他们" })).toBeTruthy();
    expect(inWhisper("w1").getByRole("button", { name: "不用" })).toBeTruthy();
    // Not a message: nothing to quote, no sender, no time.
    expect(whisperLi("w1").querySelector(".msg-action, .msg-meta, time")).toBeNull();
  });

  it("offers only the buttons it has", async () => {
    await openGroup({ whispers: [whisper("w1", G1, 1, { actions: ["dismiss"] }), whisper("w2", G1, 2, { actions: [] })] });
    expect(inWhisper("w1").queryByRole("button", { name: "告诉他们" })).toBeNull();
    expect(inWhisper("w1").getByRole("button", { name: "不用" })).toBeTruthy();
    expect(inWhisper("w2").queryAllByRole("button")).toEqual([]);
  });

  it("answered ones stay as a quiet line: 已告诉他们, 已忽略, 已过期", async () => {
    await openGroup({
      whispers: [whisper("w1", G1, 1, { status: "accepted" }), whisper("w2", G1, 2, { status: "declined" }), whisper("w3", G1, 3, { status: "expired" })],
    });
    expect(rows()).toEqual(["m1", "w:w1", "m2", "w:w2", "m3", "w:w3"]);
    expect(whisperLi("w1").textContent).toBe("已告诉他们");
    expect(whisperLi("w2").textContent).toBe("已忽略");
    expect(whisperLi("w3").textContent).toBe("已过期");
    expect(timeline().querySelectorAll(".msg-whisper button")).toHaveLength(0);
  });

  it("告诉他们 calls accept once; while it waits neither button does anything; then it reads 已告诉他们", async () => {
    const answer = deferred();
    const w1 = whisper("w1", G1, 2);
    const { api } = await openGroup({ whispers: [w1], api: { acceptWhisper: vi.fn(() => answer.promise) } });
    await click(inWhisper("w1").getByRole("button", { name: "告诉他们" }));
    expect(api.acceptWhisper).toHaveBeenCalledTimes(1);
    expect(api.acceptWhisper).toHaveBeenCalledWith("w1");
    expect(inWhisper("w1").getByRole("button", { name: "处理中…" }).disabled).toBe(true);
    const no = inWhisper("w1").getByRole("button", { name: "不用" });
    expect(no.disabled).toBe(true);
    fireEvent.click(no);
    fireEvent.click(inWhisper("w1").getByRole("button", { name: "处理中…" }));
    await flush();
    expect(api.declineWhisper).not.toHaveBeenCalled();
    expect(api.acceptWhisper).toHaveBeenCalledTimes(1);
    answer.resolve({ ...w1, status: "accepted" });
    await flush();
    expect(whisperLi("w1").textContent).toBe("已告诉他们");
  });

  it("不用 calls decline once and it reads 已忽略", async () => {
    const { api } = await openGroup({ whispers: [whisper("w1", G1, 2)] });
    await click(inWhisper("w1").getByRole("button", { name: "不用" }));
    expect(api.declineWhisper).toHaveBeenCalledTimes(1);
    expect(api.declineWhisper).toHaveBeenCalledWith("w1");
    expect(api.acceptWhisper).not.toHaveBeenCalled();
    expect(whisperLi("w1").textContent).toBe("已忽略");
  });

  it("a refusal (answered or expired meanwhile) says so, offers nothing more, and the whisper is fetched again", async () => {
    const w1 = whisper("w1", G1, 2);
    const later = deferred();
    const { api } = await openGroup({
      whispers: [w1],
      api: {
        acceptWhisper: vi.fn(async () => {
          throw apiError(409, "stale_whisper");
        }),
        listWhispers: vi.fn(() => later.promise),
      },
    });
    await click(inWhisper("w1").getByRole("button", { name: "告诉他们" }));
    expect(inWhisper("w1").getByRole("alert").textContent).toBe("这条悄悄话已经处理过了。");
    expect(inWhisper("w1").queryAllByRole("button")).toEqual([]);
    expect(api.listWhispers).toHaveBeenCalledWith(G1, { before: 3, limit: 100 });
    later.resolve({ whispers: [{ ...w1, status: "expired" }], nextBefore: null });
    await flush();
    expect(whisperLi("w1").textContent).toBe("已过期");
  });

  it("an open found_elsewhere whisper, opened, shows what was found before its buttons — where · who · when, then the text, a long one folded with 展开", async () => {
    const long = "很长的一段话".repeat(40);
    const hits = [
      { where: "我们的专属会话", who: "小美", when: "2026-11-20 14:05", text: "蓝鲸计划的口令是七七" },
      { where: "乙群", who: "小安", when: "2026-11-19 09:30", text: long },
    ];
    await openGroup({ whispers: [whisper("w1", G1, 2, { detail: { hits } }), whisper("w2", G1, 3, { status: "told", detail: { hits } })] });
    await click(inWhisper("w1").getByRole("button", { name: SUMMARY(2) }));
    const items = [...whisperLi("w1").querySelectorAll(".whisper-hit")];
    expect(items.map((li) => li.querySelector(".whisper-hit-meta").textContent)).toEqual(["我们的专属会话 · 小美 · 2026-11-20 14:05", "乙群 · 小安 · 2026-11-19 09:30"]);
    expect(items.map((li) => li.querySelector(".whisper-hit-text").textContent)).toEqual(["蓝鲸计划的口令是七七", long]);
    // Before the buttons.
    const tell = inWhisper("w1").getByRole("button", { name: "告诉他们" });
    expect(items[1].compareDocumentPosition(tell) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The long one is folded, and opens.
    expect(items[1].querySelector(".whisper-hit-text").classList.contains("folded")).toBe(true);
    expect(items[0].querySelector("button")).toBeNull();
    await click(within(items[1]).getByRole("button", { name: "展开" }));
    expect(items[1].querySelector(".whisper-hit-text").classList.contains("folded")).toBe(false);
    expect(within(items[1]).getByRole("button", { name: "收起" })).toBeTruthy();
    // Told: the quiet line only.
    expect(whisperLi("w2").textContent).toBe("已告诉他们");
  });

  it("only a found_elsewhere whisper shows hits: another kind carrying them shows its text alone", async () => {
    const hits = [{ where: "乙群", who: "小安", when: "2026-11-19 09:30", text: "不该出现的内容" }];
    await openGroup({ whispers: [whisper("w1", G1, 2, { kind: "memory", detail: { hits } })] });
    expect(whisperLi("w1").querySelector(".whisper-hit")).toBeNull();
    expect(whisperLi("w1").textContent).not.toContain("不该出现的内容");
  });

  it("a refusal that is not stale keeps the buttons and says why: busy_run, paused, no model, too fast", async () => {
    const cases = [
      [409, "busy_run", "它正在回复，说完再点。"],
      [409, "agent_paused", "这个 Agent 已暂停，恢复后才能重试。"],
      [400, "invalid_request", "这个 Agent 还没有选择模型。"],
      [429, "rate_limited", "回复太频繁了，请稍等一分钟再试。"],
    ];
    for (const [status, code, text] of cases) {
      const { api } = await openGroup({
        whispers: [whisper("w1", G1, 2)],
        api: {
          acceptWhisper: vi.fn(async () => {
            throw apiError(status, code);
          }),
        },
      });
      const asked = api.listWhispers.mock.calls.length;
      await click(inWhisper("w1").getByRole("button", { name: "告诉他们" }));
      expect([code, inWhisper("w1").getByRole("alert").textContent]).toEqual([code, text]);
      expect([code, inWhisper("w1").getByRole("button", { name: "告诉他们" }).disabled]).toEqual([code, false]);
      // Still open: nothing is fetched again (only a stale answer is).
      expect([code, api.listWhispers.mock.calls.length]).toEqual([code, asked]);
      cleanup();
    }
  });

  it("a push makes one, answers one, or expires one; a whisper of a conversation not held is ignored", async () => {
    const { transport } = await openGroup();
    await push(transport, { type: "whisper", whisper: whisper("w1", G1, 3) });
    expect(rows()).toEqual(["m1", "m2", "m3", "w:w1"]);
    await push(transport, { type: "whisper", whisper: whisper("w1", G1, 3, { status: "expired" }) });
    expect(whisperLi("w1").textContent).toBe("已过期");
    // An answer is final: an older copy that says open does not bring the buttons back.
    await push(transport, { type: "whisper", whisper: whisper("w1", G1, 3) });
    expect(whisperLi("w1").textContent).toBe("已过期");
    await push(transport, { type: "whisper", whisper: whisper("w9", "00000000-0000-4000-8000-0000000000ff", 1) });
    expect(document.querySelectorAll(".msg-whisper")).toHaveLength(1);
  });

});

/** The one line a found_elsewhere whisper is folded to (its control that opens it). */
const SUMMARY = (n) => `在别处查到了 ${n} 条，要告诉他们吗？`;
const HITS = [
  { where: "我们的专属会话", who: "小美", when: "2026-11-20 14:05", text: "蓝鲸计划的口令是七七" },
  { where: "乙群", who: "小安", when: "2026-11-19 09:30", text: "蓝鲸计划在三楼" },
];
const found = (id, afterSeq, fields = {}) => whisper(id, G1, afterSeq, { detail: { hits: HITS }, ...fields });

describe("a found_elsewhere whisper (its state is the service's to derive: Redesign D)", () => {
  it("is folded by default to one line — 在别处查到了 2 条，要告诉他们吗？ — which opens it (the hits, the buttons) and folds it again; nothing is answered by it", async () => {
    const { api } = await openGroup({ whispers: [found("w1", 2)] });
    const summary = inWhisper("w1").getByRole("button", { name: SUMMARY(2) });
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(whisperLi("w1").textContent).toBe(SUMMARY(2));
    expect(whisperLi("w1").querySelector(".whisper-hit")).toBeNull();
    expect(inWhisper("w1").queryByRole("button", { name: "告诉他们" })).toBeNull();
    // Still only mine to see: the lock, 只有你能看到 as its name.
    expect(inWhisper("w1").getByRole("note", { name: "只有你能看到" })).toBeTruthy();
    expect(whisperLi("w1").querySelector("svg")).toBeTruthy();
    await click(summary);
    expect(whisperLi("w1").querySelectorAll(".whisper-hit")).toHaveLength(2);
    expect(whisperLi("w1").textContent).toContain("只有你能看到");
    expect(inWhisper("w1").getByRole("button", { name: "告诉他们" })).toBeTruthy();
    expect(inWhisper("w1").getByRole("button", { name: "不用" })).toBeTruthy();
    const fold = inWhisper("w1").getByRole("button", { name: "收起" });
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    await click(fold);
    expect(whisperLi("w1").textContent).toBe(SUMMARY(2));
    expect(api.acceptWhisper).not.toHaveBeenCalled();
    expect(api.declineWhisper).not.toHaveBeenCalled();
  });

  it("opened, it stays open for this tab's session (that whisper only): shown again — another conversation opened and back, the page loaded again — it is still open; another whisper is folded", async () => {
    await openGroup({ whispers: [found("w1", 2), found("w2", 3)] });
    await click(inWhisper("w1").getByRole("button", { name: SUMMARY(2) }));
    await click(screen.getByText("小助手", { selector: ".list-col .row-name" }));
    await click(screen.getByText("周末小组", { selector: ".list-col .row-name" }));
    expect(inWhisper("w1").getByRole("button", { name: "告诉他们" })).toBeTruthy();
    expect(inWhisper("w2").getByRole("button", { name: SUMMARY(2) })).toBeTruthy();
    cleanup();
    await openGroup({ whispers: [found("w1", 2), found("w2", 3)] });
    expect(inWhisper("w1").getByRole("button", { name: "告诉他们" })).toBeTruthy();
    expect(inWhisper("w2").queryByRole("button", { name: "告诉他们" })).toBeNull();
    // Folded again: remembered so too.
    await click(inWhisper("w1").getByRole("button", { name: "收起" }));
    cleanup();
    await openGroup({ whispers: [found("w1", 2)] });
    expect(inWhisper("w1").getByRole("button", { name: SUMMARY(2) })).toBeTruthy();
  });

  it("telling (its told reply queued or running): a quiet line 正在告诉他们… with no button, and no dot; told: 已告诉他们", async () => {
    const { transport } = await openGroup({ whispers: [found("w1", 2, { status: "telling", revision: 8 })] });
    expect(whisperLi("w1").textContent).toBe("正在告诉他们…");
    expect(inWhisper("w1").queryAllByRole("button")).toEqual([]);
    expect(within(listRow("周末小组")).queryByLabelText(DOT)).toBeNull();
    await push(transport, { type: "whisper", whisper: found("w1", 2, { status: "told", revision: 14 }) });
    expect(whisperLi("w1").textContent).toBe("已告诉他们");
  });

  it("告诉他们 answers telling (the service's answer): the quiet line, until the push says how it went", async () => {
    const w1 = found("w1", 2);
    const { api } = await openGroup({ whispers: [w1], api: { acceptWhisper: vi.fn(async () => ({ ...w1, status: "telling", revision: 8 })) } });
    await click(inWhisper("w1").getByRole("button", { name: SUMMARY(2) }));
    await click(inWhisper("w1").getByRole("button", { name: "告诉他们" }));
    expect(api.acceptWhisper).toHaveBeenCalledWith("w1");
    expect(whisperLi("w1").textContent).toBe("正在告诉他们…");
  });

  it("open again after a tell that posted nothing (`lastTellFailed`): 刚才没发出去，可以再试一次。 above the buttons, which tell again; and the dot", async () => {
    const { api, transport } = await openGroup({ whispers: [found("w1", 2, { status: "telling", revision: 8 })] });
    await push(transport, { type: "whisper", whisper: found("w1", 2, { lastTellFailed: true, revision: 12 }) });
    await click(inWhisper("w1").getByRole("button", { name: SUMMARY(2) }));
    const line = [...whisperLi("w1").querySelectorAll("p")].find((p) => p.textContent === "刚才没发出去，可以再试一次。");
    expect(line).toBeTruthy();
    const tell = inWhisper("w1").getByRole("button", { name: "告诉他们" });
    expect(line.compareDocumentPosition(tell) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(listRow("周末小组")).getByLabelText(DOT)).toBeTruthy();
    await click(tell);
    expect(api.acceptWhisper).toHaveBeenCalledWith("w1");
    // Without a failed tell, no such line.
    cleanup();
    await openGroup({ whispers: [found("w2", 2)] });
    await click(inWhisper("w2").getByRole("button", { name: SUMMARY(2) }));
    expect(whisperLi("w2").textContent).not.toContain("刚才没发出去");
  });

  it("of two copies the one with the higher revision is kept: open again (12) after telling (8); a late copy saying telling (8) changes nothing; told (14) is final", async () => {
    const { transport } = await openGroup({ whispers: [found("w1", 3, { revision: 0 })] });
    await push(transport, { type: "whisper", whisper: found("w1", 3, { status: "telling", revision: 8 }) });
    expect(whisperLi("w1").textContent).toBe("正在告诉他们…");
    await push(transport, { type: "whisper", whisper: found("w1", 3, { lastTellFailed: true, revision: 12 }) });
    expect(inWhisper("w1").getByRole("button", { name: SUMMARY(2) })).toBeTruthy();
    await push(transport, { type: "whisper", whisper: found("w1", 3, { status: "telling", revision: 8 }) });
    expect(inWhisper("w1").getByRole("button", { name: SUMMARY(2) })).toBeTruthy();
    await push(transport, { type: "whisper", whisper: found("w1", 3, { status: "told", revision: 14 }) });
    await push(transport, { type: "whisper", whisper: found("w1", 3, { lastTellFailed: true, revision: 12 }) });
    expect(whisperLi("w1").textContent).toBe("已告诉他们");
  });

  it("at phone width an opened one never takes more than about half the screen: its hits scroll inside (the rules; e2e/whispers.spec.mjs measures)", () => {
    const css = readFileSync("src/styles.css", "utf8");
    const phone = [...css.matchAll(/@media \(max-width: 480px\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]).join("\n");
    const rule = (selector) => phone.split("\n").find((line) => line.trim().startsWith(`${selector} {`)) ?? "";
    expect(rule(".whisper.whisper-open")).toMatch(/max-height:\s*50dvh/);
    expect(rule(".whisper.whisper-open")).toMatch(/display:\s*flex/);
    expect(rule(".whisper.whisper-open .whisper-hits")).toMatch(/overflow-y:\s*auto/);
    expect(rule(".whisper.whisper-open .whisper-hits")).toMatch(/min-height:\s*0/);
  });
});

describe("with older history", () => {
  it("an open one following a message not loaded shows at the top until its page comes, then at its place; the page of older messages brings the whispers before it (the list route's `before`)", async () => {
    const older = whisper("w5", G1, 5);
    const answered = whisper("w7", G1, 7, { status: "declined" });
    const { api } = await openGroup({
      messages: range(G1, 11, 40, [ANN, BO]),
      whispers: [older],
      api: {
        listMessages: vi.fn(async () => ({ messages: range(G1, 1, 10, [ANN, BO]), nextBefore: null })),
        listWhispers: vi.fn(async () => ({ whispers: [answered, older], nextBefore: null })),
      },
    });
    // Open, its message not loaded: at the top of what is (the chat list's mark points at something).
    expect(rows().slice(0, 2)).toEqual(["w:w5", "m11"]);
    expect(rows().filter((r) => r.startsWith("w:"))).toEqual(["w:w5"]);
    expect(inWhisper("w5").getByRole("button", { name: "告诉他们" })).toBeTruthy();
    fireEvent.scroll(timeline());
    await flush();
    expect(api.listMessages).toHaveBeenCalledWith(G1, { before: 11, limit: 50 });
    expect(api.listWhispers).toHaveBeenCalledTimes(1);
    expect(api.listWhispers).toHaveBeenCalledWith(G1, { before: 11, limit: 100 });
    const shown = rows();
    expect(shown.slice(0, 1)).toEqual(["m1"]);
    expect(shown.slice(4, 9)).toEqual(["m5", "w:w5", "m6", "m7", "w:w7"]);
    expect(shown.filter((r) => r === "w:w5")).toHaveLength(1);
    expect(whisperLi("w7").textContent).toBe("已忽略");
  });

  it("several open ones above what is loaded: at the top by when they were made; an answered one there waits for its page", async () => {
    await openGroup({
      messages: range(G1, 11, 40, [ANN, BO]),
      whispers: [whisper("w8", G1, 8, { createdAt: at(30) }), whisper("w3", G1, 3, { createdAt: at(40) }), whisper("w6", G1, 6, { status: "accepted" })],
    });
    expect(rows().slice(0, 3)).toEqual(["w:w8", "w:w3", "m11"]);
    expect(rows().filter((r) => r.startsWith("w:"))).toEqual(["w:w8", "w:w3"]);
  });

  it("a page whose whispers were refused for going too fast (429) asks once more, a moment later", async () => {
    const answered = whisper("w7", G1, 7, { status: "declined" });
    let calls = 0;
    const { api } = await openGroup({
      messages: range(G1, 11, 40, [ANN, BO]),
      whispers: [],
      api: {
        listMessages: vi.fn(async () => ({ messages: range(G1, 1, 10, [ANN, BO]), nextBefore: null })),
        listWhispers: vi.fn(async () => {
          calls += 1;
          if (calls === 1) throw apiError(429, "rate_limited");
          return { whispers: [answered], nextBefore: null };
        }),
      },
    });
    fireEvent.scroll(timeline());
    await flush();
    expect(api.listWhispers).toHaveBeenCalledTimes(1);
    await elapse(WHISPER_RETRY_MS);
    await flush();
    expect(api.listWhispers).toHaveBeenCalledTimes(2);
    expect(rows().slice(6, 9)).toEqual(["m7", "w:w7", "m8"]);
  });

  it("refused twice, the page comes without its whispers (once more only)", async () => {
    const { api } = await openGroup({
      messages: range(G1, 11, 40, [ANN, BO]),
      whispers: [],
      api: {
        listMessages: vi.fn(async () => ({ messages: range(G1, 1, 10, [ANN, BO]), nextBefore: null })),
        listWhispers: vi.fn(async () => {
          throw apiError(429, "rate_limited");
        }),
      },
    });
    fireEvent.scroll(timeline());
    await flush();
    await elapse(WHISPER_RETRY_MS);
    await flush();
    await elapse(10 * WHISPER_RETRY_MS);
    await flush();
    expect(api.listWhispers).toHaveBeenCalledTimes(2);
    expect(rows().slice(0, 2)).toEqual(["m1", "m2"]);
  });

  it("refused once, and signed out (the layer stopped) meanwhile: it is not asked again", async () => {
    const app = await openGroup({
      messages: range(G1, 11, 40, [ANN, BO]),
      whispers: [],
      api: {
        listMessages: vi.fn(async () => ({ messages: range(G1, 1, 10, [ANN, BO]), nextBefore: null })),
        listWhispers: vi.fn(async () => {
          throw apiError(429, "rate_limited");
        }),
      },
    });
    fireEvent.scroll(timeline());
    await flush();
    expect(app.api.listWhispers).toHaveBeenCalledTimes(1);
    app.layer.stop();
    await elapse(WHISPER_RETRY_MS);
    await flush();
    await elapse(10 * WHISPER_RETRY_MS);
    await flush();
    expect(app.api.listWhispers).toHaveBeenCalledTimes(1);
  });

  it("a conversation where I have no Agent and no whisper asks the list route for nothing", async () => {
    const { api } = await openApp({
      sync: () => syncOf([group(G1, { lastSeq: 40, readSeq: 40 })], range(G1, 11, 40, [ANN, BO])),
      api: { listMessages: vi.fn(async () => ({ messages: range(G1, 1, 10, [ANN, BO]), nextBefore: null })), listWhispers: vi.fn(async () => ({ whispers: [], nextBefore: null })) },
    });
    await click(screen.getByText("周末小组", { selector: ".list-col .row-name" }));
    fireEvent.scroll(timeline());
    await flush();
    expect(api.listMessages).toHaveBeenCalledTimes(1);
    expect(api.listWhispers).not.toHaveBeenCalled();
  });
});

describe("the chat list", () => {
  it("marks a conversation with open whispers (有只给你的悄悄话), and clears it when none is open", async () => {
    const { transport } = await openGroup({ whispers: [whisper("w1", G1, 2)] });
    expect(within(listRow("周末小组")).getByLabelText(DOT)).toBeTruthy();
    expect(within(listRow("小助手")).queryByLabelText(DOT)).toBeNull();
    await click(inWhisper("w1").getByRole("button", { name: "不用" }));
    expect(within(listRow("周末小组")).queryByLabelText(DOT)).toBeNull();
    // One in my Agent's own conversation, pushed; it expires.
    await push(transport, { type: "whisper", whisper: whisper("w2", A1, 0, { kind: "tools_off", actions: ["dismiss"] }) });
    expect(within(listRow("小助手")).getByLabelText(DOT)).toBeTruthy();
    await push(transport, { type: "whisper", whisper: whisper("w2", A1, 0, { status: "expired" }) });
    expect(within(listRow("小助手")).queryByLabelText(DOT)).toBeNull();
  });

  it("an answered whisper alone marks nothing", async () => {
    await openGroup({ whispers: [whisper("w1", G1, 2, { status: "accepted" })], open: null });
    expect(within(listRow("周末小组")).queryByLabelText(DOT)).toBeNull();
  });

  it("an open whisper that offers no button only tells: it marks nothing", async () => {
    const { transport } = await openGroup({ whispers: [whisper("w1", G1, 2, { kind: "tools_off", actions: [] })], open: null });
    expect(within(listRow("周末小组")).queryByLabelText(DOT)).toBeNull();
    await push(transport, { type: "whisper", whisper: whisper("w2", A1, 0, { kind: "tools_off", actions: [] }) });
    expect(within(listRow("小助手")).queryByLabelText(DOT)).toBeNull();
    // Beside one that waits for me, the mark is that one's.
    await push(transport, { type: "whisper", whisper: whisper("w3", A1, 0, { actions: ["dismiss"] }) });
    expect(within(listRow("小助手")).getByLabelText(DOT)).toBeTruthy();
  });
});

describe("a whisper that offers no button (a model turned to plain chat: tools_off)", () => {
  const TOLD = "这个模型不支持查东西，已改为普通聊天。可以在模型设置里重新打开再试。";

  it("is a plain line only I see — the lock, 只有你能看到, its text — with no button, after the message it follows", async () => {
    await openGroup({ whispers: [whisper("w1", G1, 2, { kind: "tools_off", text: TOLD, actions: [] })] });
    expect(rows()).toEqual(["m1", "m2", "w:w1", "m3"]);
    expect(whisperLi("w1").textContent).toBe(`只有你能看到${TOLD}`);
    expect(whisperLi("w1").querySelector("svg")).toBeTruthy();
    expect(inWhisper("w1").queryAllByRole("button")).toEqual([]);
    expect(whisperLi("w1").querySelector(".msg-action, .msg-meta, time")).toBeNull();
  });

  it("expired (after 7 days, or its Agent gone) it still says what it told, not 已过期", async () => {
    const { transport } = await openGroup({ whispers: [whisper("w1", G1, 2, { kind: "tools_off", text: TOLD, actions: [] })] });
    await push(transport, { type: "whisper", whisper: whisper("w1", G1, 2, { kind: "tools_off", text: TOLD, actions: [], status: "expired" }) });
    expect(whisperLi("w1").textContent).toBe(`只有你能看到${TOLD}`);
    expect(whisperLi("w1").textContent).not.toContain("已过期");
    expect(inWhisper("w1").queryAllByRole("button")).toEqual([]);
  });
});

describe("the held whispers (model.js)", () => {
  const synced = (whispers, conversations = [group(G1, { lastSeq: 3, readSeq: 3, members: MEMBERS })]) =>
    applySync(initial(), { ...syncOf(conversations, range(G1, 1, 3)), ...(whispers ? { whispers } : {}) });

  it("a sync's open ones replace the open ones held; answered ones held stay; a conversation it does not list takes its whispers with it", () => {
    let state = synced([whisper("w1", G1, 1), whisper("w2", G1, 2)]);
    state = applyWhisper(state, whisper("w3", G1, 3, { status: "declined" }));
    state = applySync(state, { ...syncOf([group(G1, { lastSeq: 3, readSeq: 3, members: MEMBERS })], range(G1, 1, 3)), whispers: [whisper("w2", G1, 2)] });
    expect(Object.keys(state.whispers[G1]).sort()).toEqual(["w2", "w3"]);
    state = applySync(state, syncOf([], []));
    expect(state.whispers[G1]).toBeUndefined();
  });

  it("catch-up adds its whispers; gone drops a conversation's; a whisper that is not one is ignored", () => {
    let state = synced();
    state = applyCatchup(state, { messages: [], gone: [], more: false, whispers: [whisper("w1", G1, 3)] }).state;
    expect(state.whispers[G1].w1.status).toBe("open");
    for (const bad of [null, { id: "x" }, { ...whisper("w2", G1, 1), afterSeq: "1" }, { ...whisper("w3", G1, 1), status: "maybe" }]) {
      expect(applyWhisper(state, bad)).toBe(state);
    }
    // A found_elsewhere one's derived states, and whether its last tell failed (only when it says so).
    state = applyWhisper(state, whisper("w4", G1, 3, { status: "telling", revision: 8 }));
    state = applyWhisper(state, whisper("w5", G1, 3, { lastTellFailed: true, revision: 12 }));
    state = applyWhisper(state, whisper("w6", G1, 3, { status: "told", revision: 14, lastTellFailed: "yes" }));
    expect([state.whispers[G1].w4.status, state.whispers[G1].w5.lastTellFailed, state.whispers[G1].w6.status, "lastTellFailed" in state.whispers[G1].w6]).toEqual(["telling", true, "told", false]);
    state = applyGone(state, G1);
    expect(state.whispers[G1]).toBeUndefined();
  });

  const m = (seq) => ({ id: `m${seq}`, seq });
  const pending = { id: "p1", seq: null };
  const w = (id, afterSeq, status = "declined", createdAt = at(afterSeq)) => ({ id, afterSeq, status, createdAt });
  const ids = (out) => out.map((r) => (r.bubble ? "bubble" : r.whisper ? `w:${r.whisper.id}` : r.msg.id));

  it("placeWhispers: after the message it follows, before what I am still sending; before the first held message only when it is all there", () => {
    expect(ids(placeWhispers([m(4), m(6), pending], [w("a", 2), w("b", 4), w("c", 5), w("d", 9)], { complete: false, toEnd: true }))).toEqual(["m4", "w:b", "w:c", "m6", "w:d", "p1"]);
    expect(ids(placeWhispers([m(4), m(6)], [w("a", 2), w("b", 4)], { complete: true, toEnd: true }))).toEqual(["w:a", "m4", "w:b", "m6"]);
    // A detached window (not reaching the newest message): only those within it.
    expect(ids(placeWhispers([m(4), m(6)], [w("b", 4), w("d", 9)], { complete: false, toEnd: false }))).toEqual(["m4", "w:b", "m6"]);
    expect(ids(placeWhispers([], [w("a", 0)], { complete: true, toEnd: true }))).toEqual(["w:a"]);
  });

  it("placeWhispers: an open one whose message is older than those held is at the top (by when they were made) until it is all there", () => {
    const open = [w("x", 3, "open", at(50)), w("y", 1, "open", at(60)), w("z", 2, "open", at(40))];
    expect(ids(placeWhispers([m(4), m(6)], [...open, w("a", 2), w("b", 4)].sort((p, q) => p.afterSeq - q.afterSeq), { complete: false, toEnd: true }))).toEqual([
      "w:z",
      "w:x",
      "w:y",
      "m4",
      "w:b",
      "m6",
    ]);
    // Once it is all there, at its place.
    expect(ids(placeWhispers([m(1), m(2), m(4)], [w("y", 1, "open"), w("z", 2, "open")], { complete: true, toEnd: true }))).toEqual(["m1", "w:y", "m2", "w:z", "m4"]);
    // Nothing held yet: the open ones only.
    expect(ids(placeWhispers([], [w("a", 2), w("y", 1, "open")], { complete: false, toEnd: true }))).toEqual(["w:y"]);
  });

  it("placeWhispers: the reply bubble — at the end while it is written; while it finishes, in its stored message's place, a whisper after that message below it", () => {
    expect(ids(placeWhispers([m(4), m(5)], [w("b", 4), w("c", 5)], { complete: true, toEnd: true, bubble: true }))).toEqual(["m4", "w:b", "m5", "w:c", "bubble"]);
    expect(ids(placeWhispers([m(4), m(5)], [w("b", 4), w("c", 5)], { complete: true, toEnd: true, bubble: "m5" }))).toEqual(["m4", "w:b", "bubble", "w:c"]);
    // Once it has finished, the message is where the bubble was: nothing moved.
    expect(ids(placeWhispers([m(4), m(5)], [w("b", 4), w("c", 5)], { complete: true, toEnd: true }))).toEqual(["m4", "w:b", "m5", "w:c"]);
  });
});

describe("a message is still a message", () => {
  it("a whisper takes no seq: the next message applies by the seq rule as before", async () => {
    const { transport } = await openGroup({ whispers: [whisper("w1", G1, 3)] });
    await push(transport, { type: "message", message: wire(G1, 4, ANN, "下一句") });
    expect(rows()).toEqual(["m1", "m2", "m3", "w:w1", "m4"]);
    expect(transport.log.filter((x) => Array.isArray(x) && x[0] === "catchup")).toEqual([]);
  });
});
