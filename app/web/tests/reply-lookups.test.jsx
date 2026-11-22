// @vitest-environment jsdom
// What a reply's tools show (design rules 14, 15), over the real data layer with the fake transport and fake routes:
// while a tool runs, the reply being written says what kind of thing it looks at (正在查聊天记录… / 正在看文件… /
// 正在看时间…) — in my Agent's own conversation and in a group, my Agent's and someone else's alike; under the finished
// reply one quiet line says what it looked up, and opens the messages it found (each loaded as any one message, each
// jumping to its place) and, in my Agent's own conversation only, the words it searched for.
import "./markdown-ready.js";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { A1, AG1, ANN, BO, ME_ID, MODELS, PRINCIPALS, agentConv, agentOf, agentPrincipal, apiError, at, group, runOf, syncOf, wire } from "./fixtures.js";
import { click, elapse, flush, installBrowser, openApp, push } from "./harness.jsx";
import { forgetRevealed } from "../src/pages/AgentChatBits.jsx";
import { REVEAL_MAX_LAG_MS } from "../src/ui/reveal.js";

const R1 = "00000000-0000-4000-8000-0000000000e7";
const G1 = "00000000-0000-4000-8000-0000000000c2";
const OAG = "00000000-0000-4000-8000-0000000000b9"; // 小安's Agent
const SITE_FREE = { source: "site", id: "free-1" };

beforeEach(() => installBrowser());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  forgetRevealed(R1);
});

/** The greeting (seq 1) and my message (seq 2). */
const BASE = [wire(A1, 1, AG1, "你好，我是小助手"), wire(A1, 2, ME_ID, "在吗")];
const annBot = { ...agentPrincipal(OAG, "annbot", "安的助手"), ownerId: ANN, intro: "", field: "" };
const groupMembers = [ME_ID, ANN, BO, AG1, OAG].map((id, i) => ({ id, role: "speaker", isCreator: i === 0 }));

/** The app with my Agent 小助手, its conversation (`messages`) and the group 周末小组 (`groupMessages`); `open`: which one is open. */
async function openChats({ messages = BASE, groupMessages = [], api = {}, open = "小助手", models = MODELS } = {}) {
  const lastSeq = (list) => list.reduce((max, m) => Math.max(max, m.seq), 0);
  const conversation = agentConv(A1, AG1, { lastSeq: lastSeq(messages), readSeq: lastSeq(messages) });
  const team = group(G1, { members: groupMembers, lastSeq: lastSeq(groupMessages), readSeq: lastSeq(groupMessages) });
  const sync = () => syncOf([conversation, team], [...messages, ...groupMessages], [...PRINCIPALS, { ...agentPrincipal(), ownerId: ME_ID }, annBot]);
  const record = agentOf(AG1, { model: SITE_FREE });
  const app = await openApp({
    sync,
    api: { listProviders: vi.fn(async () => ({ providers: [] })), ...api },
    handlers: { agents: () => ({ agents: [record] }), agent: () => record, run: () => ({ run: null }), groupRuns: () => ({ runs: [] }), models: () => models },
  });
  await click(screen.getByText(open, { selector: ".list-col .row-name" }));
  return app;
}

const timeline = () => document.querySelector("ol.messages");
const bubbleText = () => timeline().querySelector("li.streaming")?.querySelector(".bubble").textContent ?? null;
const storedLi = (seq) => timeline().querySelector(`li[data-msg="m${seq}"]`);
const lookupLine = (seq) => storedLi(seq).querySelector(".msg-lookups");
const runPush = (transport, fields = {}) => push(transport, { type: "run", conversationId: A1, run: runOf(R1, "running"), ...fields });
/** A reply's citation as the service sends it: where it stands in the text, the message it points to. */
const cite = (at, conversationId, seq, kind = "m") => ({ at, kind, ref: { conversationId, seq } });

/** A selector's specificity as [ids, classes, elements] (`:is`/`:not`/`:has` count their most specific argument, `:where` none). */
function specificity(selector) {
  let s = selector;
  const total = [0, 0, 0];
  const more = (a, b) => {
    const i = a.findIndex((n, k) => n !== b[k]);
    return i >= 0 && a[i] > b[i];
  };
  // Functional pseudo-classes first, innermost out: each counts as the most specific of its arguments (`:where` as nothing).
  for (let m = /:(is|not|has|where)\(([^()]*)\)/.exec(s); m; m = /:(is|not|has|where)\(([^()]*)\)/.exec(s)) {
    if (m[1] !== "where") {
      const best = m[2].split(",").map((a) => specificity(a.trim())).reduce((x, y) => (more(y, x) ? y : x));
      best.forEach((n, i) => (total[i] += n));
    }
    s = `${s.slice(0, m.index)} ${s.slice(m.index + m[0].length)}`;
  }
  s = s.replace(/::[\w-]+/g, () => ((total[2] += 1), " "));
  s = s.replace(/:[\w-]+/g, () => ((total[1] += 1), " "));
  s = s.replace(/\[[^\]]*\]/g, () => ((total[1] += 1), " "));
  s = s.replace(/#[\w-]+/g, () => ((total[0] += 1), " "));
  s = s.replace(/\.[\w-]+/g, () => ((total[1] += 1), " "));
  total[2] += [...s.matchAll(/(?:^|[\s>+~])[a-zA-Z][\w-]*/g)].length;
  return total;
}

/**
 * The cascade of a stylesheet's text over an element, a property at a time: the value of the declaration that wins among
 * the rules (also inside `@media`) whose selectors match the element — the most specific matching selector, then the later
 * rule; `font: inherit` sets `font-size` and `line-height` too. Undefined when no rule sets it.
 */
function cascadeOf(cssText) {
  const css = cssText.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [];
  const read = (text) => {
    let at = 0;
    for (let open = text.indexOf("{", at); open >= 0; open = text.indexOf("{", at)) {
      const head = text.slice(at, open).trim();
      if (head.startsWith("@")) {
        let depth = 1;
        let i = open + 1;
        for (; i < text.length && depth > 0; i += 1) depth += text[i] === "{" ? 1 : text[i] === "}" ? -1 : 0;
        read(text.slice(open + 1, i - 1));
        at = i;
        continue;
      }
      const close = text.indexOf("}", open);
      const decls = {};
      for (const d of text.slice(open + 1, close).split(";")) {
        const k = d.indexOf(":");
        if (k > 0) decls[d.slice(0, k).trim()] = d.slice(k + 1).trim();
      }
      const selectors = [];
      let depth = 0;
      let from = 0;
      for (let i = 0; i <= head.length; i += 1) {
        if (head[i] === "(") depth += 1;
        else if (head[i] === ")") depth -= 1;
        else if ((head[i] === "," && depth === 0) || i === head.length) {
          selectors.push(head.slice(from, i).trim());
          from = i + 1;
        }
      }
      rules.push({ selectors, decls });
      at = close + 1;
    }
  };
  read(css);
  const beats = (a, b) => {
    const i = a.findIndex((n, k) => n !== b[k]);
    return i < 0 || a[i] > b[i];
  };
  return (el, property) => {
    let won = null;
    for (const rule of rules) {
      let value = rule.decls[property];
      if (value === undefined && (property === "font-size" || property === "line-height") && rule.decls.font === "inherit") value = "inherit";
      if (value === undefined) continue;
      for (const selector of rule.selectors) {
        let matches = false;
        try {
          matches = el.matches(selector);
        } catch {
          matches = false;
        }
        if (!matches) continue;
        const spec = specificity(selector);
        // A later rule wins a tie.
        if (!won || beats(spec, won.spec)) won = { spec, value: value.replace(/\s*!important$/, "") };
      }
    }
    return won?.value;
  };
}

describe("while a reply's tool runs", () => {
  it("in my Agent's own conversation the bubble says what kind of thing it looks at — 正在查聊天记录… / 正在看文件… / 正在看时间… —, under what it wrote so far, and 正在回复… again once the model writes", async () => {
    const { transport } = await openChats();
    await runPush(transport);
    expect(bubbleText()).toContain("正在回复…");
    await runPush(transport, { activity: "search" });
    expect(bubbleText().trim()).toBe("正在查聊天记录…");
    await runPush(transport, { activity: "file" });
    expect(bubbleText().trim()).toBe("正在看文件…");
    await runPush(transport, { activity: "time" });
    expect(bubbleText().trim()).toBe("正在看时间…");
    await runPush(transport, { activity: null });
    expect(bubbleText().trim()).toBe("正在回复…");
    // Text written before the call: kept, and the line under it while the tool runs.
    await push(transport, { type: "delta", conversationId: A1, runId: R1, text: "我先查一下。" });
    await elapse(REVEAL_MAX_LAG_MS + 100);
    await runPush(transport, { activity: "search" });
    expect(bubbleText()).toContain("我先查一下。");
    expect(bubbleText()).toContain("正在查聊天记录…");
    await runPush(transport, { activity: null });
    expect(bubbleText().trim()).toBe("我先查一下。");
    // The web search (a run offered it): 正在上网查找….
    await runPush(transport, { activity: "web" });
    expect(bubbleText()).toContain("正在上网查找…");
    await runPush(transport, { activity: null });
    // A kind this page does not know says nothing of itself.
    await runPush(transport, { activity: "fax" });
    expect(bubbleText().trim()).toBe("我先查一下。");
  });

  it("an acknowledgement (what it said before it looked something up, a message of its own) takes the place of what was streamed, and the reply goes on being written", async () => {
    const { transport } = await openChats();
    await runPush(transport);
    await push(transport, { type: "delta", conversationId: A1, runId: R1, text: "我先查一下。" });
    await elapse(REVEAL_MAX_LAG_MS + 100);
    expect(bubbleText()).toContain("我先查一下。");
    await push(transport, { type: "message", message: wire(A1, 3, AG1, "我先查一下。", { ack: true }) });
    expect(storedLi(3).querySelector(".bubble").textContent).toContain("我先查一下。");
    // The reply is still being written: what was streamed is that message now.
    expect(bubbleText().trim()).toBe("正在回复…");
    await runPush(transport, { activity: "search" });
    expect(bubbleText().trim()).toBe("正在查聊天记录…");
    await runPush(transport, { activity: null });
    await push(transport, { type: "delta", conversationId: A1, runId: R1, text: "叫蜀香。" });
    await elapse(REVEAL_MAX_LAG_MS + 100);
    expect(bubbleText()).toContain("叫蜀香。");
    expect(bubbleText()).not.toContain("我先查一下。");
    // The answer, a later message: the reply is done being written.
    await push(transport, { type: "message", message: wire(A1, 4, AG1, "叫蜀香。") });
    await elapse(REVEAL_MAX_LAG_MS + 2000);
    expect(bubbleText()).toBeNull();
    expect(storedLi(4).querySelector(".bubble").textContent).toContain("叫蜀香。");
  });

  it("an acknowledgement adds nothing to unread and is never the chat list's line; the answer is both", async () => {
    const { transport } = await openChats({ open: "周末小组" });
    const row = () => screen.getByText("小助手", { selector: ".list-col .row-name" }).closest(".row");
    const badge = () => row().querySelector(".badge")?.textContent ?? null;
    expect([row().querySelector(".row-preview").textContent, badge()]).toEqual(["在吗", null]);
    await push(transport, { type: "message", message: wire(A1, 3, AG1, "我先查一下。", { ack: true }) });
    expect([row().querySelector(".row-preview").textContent, badge()]).toEqual(["在吗", null]);
    await push(transport, { type: "message", message: wire(A1, 4, AG1, "叫蜀香。") });
    expect([row().querySelector(".row-preview").textContent, badge()]).toEqual(["叫蜀香。", "1"]);
  });

  it("in a group someone's acknowledgement leaves their reply shown as being written, until the answer comes", async () => {
    const { transport } = await openChats({ open: "周末小组" });
    const rows = () => [...timeline().querySelectorAll("li.streaming")].map((li) => li.querySelector(".msg-meta strong").textContent);
    await push(transport, { type: "run", conversationId: G1, agentId: OAG, state: "replying" });
    expect(rows()).toEqual(["安的助手"]);
    await push(transport, { type: "message", message: wire(G1, 1, OAG, "我查查。", { ack: true }) });
    expect(rows()).toEqual(["安的助手"]);
    await push(transport, { type: "message", message: wire(G1, 2, OAG, "查到了。") });
    expect(rows()).toEqual([]);
  });

  it("in a group each reply being written says it too, my Agent's and someone else's alike, and 正在回复… again once the model writes", async () => {
    const { transport } = await openChats({ open: "周末小组" });
    const groupRun = (agentId, fields) => push(transport, { type: "run", conversationId: G1, agentId, ...fields });
    const rows = () => [...timeline().querySelectorAll("li.streaming")].map((li) => [li.querySelector(".msg-meta strong").textContent, li.querySelector(".bubble").textContent.trim()]);
    await groupRun(OAG, { state: "replying" });
    await groupRun(AG1, { run: runOf(R1, "running") });
    expect(rows()).toEqual([["小助手", "正在回复…"], ["安的助手", "正在回复…"]]);
    await groupRun(OAG, { state: "replying", activity: "search" });
    await groupRun(AG1, { run: runOf(R1, "running"), activity: "file" });
    expect(rows()).toEqual([["小助手", "正在看文件…"], ["安的助手", "正在查聊天记录…"]]);
    await groupRun(AG1, { run: runOf(R1, "running"), activity: "time" });
    await groupRun(OAG, { state: "replying", activity: null });
    expect(rows()).toEqual([["小助手", "正在看时间…"], ["安的助手", "正在回复…"]]);
    // My stop button stays; nobody else's reply has one.
    expect(within(timeline().querySelectorAll("li.streaming")[0]).getByRole("button", { name: "停止生成" })).toBeTruthy();
  });
});

describe("what a reply looked up", () => {
  const reply = (seq, extra) => wire(A1, seq, AG1, `回答${seq}`, extra);

  it("one quiet line under the reply: 查了 n 次聊天记录 / 看了 n 个文件, both joined with ，; time lookups never in it; a reply that only looked at the time shows none", async () => {
    await openChats({
      messages: [
        ...BASE,
        reply(3, { lookups: { search: 2 } }),
        reply(4, { lookups: { file: 1 } }),
        reply(5, { lookups: { search: 2, file: 1 } }),
        reply(6, { lookups: { time: 1 } }),
        reply(7, { lookups: { search: 1, time: 2 } }),
        reply(8, { lookups: { file: 3, time: 1 } }),
        reply(9, { lookups: { search: 0, file: -1, time: 1.5, fax: 4 } }),
        reply(10),
        reply(11, { lookups: { search: 1, web: 2 } }),
      ],
    });
    expect([3, 4, 5, 6, 7, 8, 9, 10, 11].map((seq) => lookupLine(seq)?.textContent ?? null)).toEqual([
      "查了 2 次聊天记录",
      "看了 1 个文件",
      "查了 2 次聊天记录，看了 1 个文件",
      null,
      "查了 1 次聊天记录",
      "看了 3 个文件",
      null,
      null,
      "查了 1 次聊天记录，查了 2 次网页",
    ]);
    // Under the reply, before the foot.
    const parts = [...storedLi(5).querySelector(".msg-main").children];
    expect(parts.indexOf(lookupLine(5))).toBe(parts.indexOf(storedLi(5).querySelector(".bubble")) + 1);
    // Nothing found and no words: nothing to open.
    expect(within(lookupLine(3)).queryByRole("button")).toBeNull();
  });

  it("a reply that looked nothing up, or only at the time, renders exactly as one carrying none of it", async () => {
    const same = { createdAt: at(3) };
    await openChats({ messages: [...BASE, reply(3, same), reply(4, { ...same, lookups: { time: 2 }, found: [{ conversationId: A1, seq: 2 }], queries: ["几点"] })] });
    const html = (seq) => storedLi(seq).innerHTML.replaceAll(`m${seq}`, "m?").replaceAll(`回答${seq}`, "回答?");
    expect(lookupLine(3)).toBeNull();
    expect([...storedLi(3).querySelector(".msg-main").children].map((el) => el.className)).toEqual(["msg-meta", "bubble", "msg-foot"]);
    expect(html(4)).toBe(html(3));
  });

  it("the line opens what it looked up: in my Agent's own conversation the words first, then each message found — its sender, time and a line of it, loaded as any one message —, and each jumps to its message", async () => {
    const getMessage = vi.fn(async (conversationId, seq) => {
      if (seq === 404) throw apiError(404, "not_found");
      const message = conversationId === A1 ? wire(A1, 2, ME_ID, "在吗") : wire(G1, 7, ANN, "蜀香在春熙路，周一休息");
      return { message, principals: {} };
    });
    const listMessages = vi.fn(async (conversationId) => ({ messages: conversationId === G1 ? [wire(G1, 7, ANN, "蜀香在春熙路，周一休息")] : [], nextBefore: null, principals: {} }));
    const found = [{ conversationId: A1, seq: 2 }, { conversationId: G1, seq: 7 }, { conversationId: A1, seq: 404 }];
    await openChats({
      messages: [...BASE, reply(3, { lookups: { search: 2, file: 1 }, found, queries: ["川菜馆", "蜀香"] })],
      // The group's newest message is held; the one found, older, is not.
      groupMessages: [wire(G1, 8, BO, "最新的一条")],
      api: { getMessage, listMessages },
    });
    const line = within(lookupLine(3)).getByRole("button", { name: "查了 2 次聊天记录，看了 1 个文件" });
    expect(line.getAttribute("aria-expanded")).toBe("false");
    // Nothing is loaded before it is opened.
    expect(getMessage).not.toHaveBeenCalled();
    await click(line);
    expect(line.getAttribute("aria-expanded")).toBe("true");
    expect(getMessage.mock.calls).toEqual([[A1, 2], [G1, 7], [A1, 404]]);
    const box = lookupLine(3);
    const words = box.querySelector(".lookup-words");
    expect(words.textContent).toBe("搜索词：川菜馆、蜀香");
    const rows = [...box.querySelectorAll(".lookup-rows > li")];
    expect(words.compareDocumentPosition(rows[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(rows.map((li) => [li.querySelector(".row-name")?.textContent ?? null, li.querySelector(".row-preview")?.textContent ?? li.textContent])).toEqual([
      ["你", "在吗"],
      ["小安", "蜀香在春熙路，周一休息"],
      [null, "这条消息已经看不到了"],
    ]);
    expect(rows[0].querySelector("time").textContent).not.toBe("");
    expect(within(rows[2]).queryByRole("button")).toBeNull();

    // A message held here: the list scrolls to it and it flashes.
    await click(within(rows[0]).getByRole("button"));
    expect(storedLi(2).classList.contains("flash")).toBe(true);
    // One elsewhere: its conversation opens around it, and it flashes there.
    await click(within([...lookupLine(3).querySelectorAll(".lookup-rows > li")][1]).getByRole("button"));
    expect(listMessages).toHaveBeenCalledWith(G1, { before: 32, limit: 50 });
    expect(document.querySelector(".chat-head").textContent).toContain("周末小组");
    expect(storedLi(7).classList.contains("flash")).toBe(true);
  });

  it("a row that could not be loaded for another reason says so — not that the message is gone; what was loaded is not loaded again when the line is opened again, and one that failed is tried again", async () => {
    let failing = true;
    const getMessage = vi.fn(async (_conversationId, seq) => {
      if (seq === 404) throw apiError(404, "not_found");
      if (seq === 503) {
        if (failing) throw apiError(503, "busy");
        return { message: wire(A1, 1, AG1, "你好，我是小助手"), principals: {} };
      }
      return { message: wire(A1, 2, ME_ID, "在吗"), principals: {} };
    });
    const found = [{ conversationId: A1, seq: 2 }, { conversationId: A1, seq: 404 }, { conversationId: A1, seq: 503 }];
    await openChats({ messages: [...BASE, reply(3, { lookups: { search: 1 }, found })], api: { getMessage } });
    const line = within(lookupLine(3)).getByRole("button", { name: "查了 1 次聊天记录" });
    const texts = () => [...lookupLine(3).querySelectorAll(".lookup-rows > li")].map((li) => li.querySelector(".row-preview")?.textContent ?? li.textContent);
    await click(line);
    expect(texts()).toEqual(["在吗", "这条消息已经看不到了", "没能打开这条消息，请稍后再试"]);
    expect(getMessage).toHaveBeenCalledTimes(3);
    await click(line);
    failing = false;
    await click(line);
    // Only the row that failed is asked for again.
    expect(getMessage.mock.calls.map(([, seq]) => seq)).toEqual([2, 404, 503, 503]);
    expect(texts()).toEqual(["在吗", "这条消息已经看不到了", "你好，我是小助手"]);
  });

  it("what a reply cites is a small superscript link where the citation stands (its place beside the text), numbered by the message it points to, that jumps there, here or in another conversation; what only looks like a citation in its text stays the text it is", async () => {
    const listMessages = vi.fn(async (conversationId) => ({ messages: conversationId === G1 ? [wire(G1, 7, ANN, "蜀香在春熙路，周一休息")] : [], nextBefore: null, principals: {} }));
    // "你问过¹，在春熙路²，也许〔m9〕¹。": the same message cited twice has the same number.
    const cites = [cite(3, A1, 2), cite(8, G1, 7), cite(15, A1, 2)];
    await openChats({
      messages: [...BASE, wire(A1, 3, AG1, "你问过，在春熙路，也许〔m9〕。", { lookups: { search: 1 }, cites })],
      groupMessages: [wire(G1, 8, BO, "最新的一条")],
      api: { listMessages },
    });
    const bubble = storedLi(3).querySelector(".bubble");
    const links = [...bubble.querySelectorAll("sup.cite button")];
    expect(links.map((b) => [b.textContent, b.getAttribute("aria-label")])).toEqual([
      ["1", "引用 1"],
      ["2", "引用 2"],
      ["1", "引用 1"],
    ]);
    expect(bubble.textContent).toBe("你问过1，在春熙路2，也许〔m9〕1。");
    await click(links[0]);
    expect(storedLi(2).classList.contains("flash")).toBe(true);
    await click(links[1]);
    expect(document.querySelector(".chat-head").textContent).toContain("周末小组");
    expect(storedLi(7).classList.contains("flash")).toBe(true);
  });

  it("a citation's link is a real box as tall as the text line, its number set high in it as a superscript — in a rendered reply too, where the Markdown tree's own rule for a sup does not win (final review, item 13; round 2)", async () => {
    const cites = [cite(3, A1, 2)];
    await openChats({ messages: [...BASE, wire(A1, 3, AG1, "你问过。", { lookups: { search: 1 }, cites })] });
    // The reply as the Markdown tree renders it: the citation's sup inside `.md`.
    const sup = storedLi(3).querySelector(".md sup.cite");
    expect(sup).not.toBeNull();
    const link = sup.querySelector(":scope > button");
    // The button is the box; the number is a span inside it.
    expect(link.querySelector(":scope > span")?.textContent).toBe("1");
    // jsdom has no layout (the real proof is the e2e spec agents-tools.spec.mjs, "the citation link is a real box"): here,
    // the declaration that wins for each property the box relies on — every rule of styles.css whose selector matches the
    // element, by specificity and then by order, as a browser's cascade picks it.
    const winner = cascadeOf(readFileSync("src/styles.css", "utf8"));
    // The sup moves no line and takes the line's own height and font (not the Markdown tree's 0.75em and line-height 0)…
    expect([winner(sup, "line-height"), winner(sup, "font-size"), winner(sup, "vertical-align")]).toEqual(["inherit", "inherit", "baseline"]);
    // …the button is a box of the text's own font and line height (nothing more specific sets either)…
    expect([winner(link, "display"), winner(link, "font-size"), winner(link, "line-height")]).toEqual(["inline-block", "inherit", "inherit"]);
    // …and the number is small, at the top of it.
    const number = link.querySelector(":scope > span");
    expect([winner(number, "font-size"), winner(number, "vertical-align")]).toEqual(["11px", "top"]);
    // An ordinary superscript of the Markdown tree keeps its own rule.
    const plain = document.createElement("div");
    plain.className = "md";
    plain.innerHTML = "<p>x<sup>2</sup></p>";
    document.body.append(plain);
    expect([winner(plain.querySelector("sup"), "line-height"), winner(plain.querySelector("sup"), "font-size")]).toEqual(["0", "0.75em"]);
    plain.remove();
  });

  it("a cited reply shown as plain text (too long to render, with the note) keeps its citations as links", async () => {
    const cites = [cite(3, A1, 2)];
    const long = `你问过。${"很长的一段话。".repeat(8000)}`;
    await openChats({ messages: [...BASE, wire(A1, 3, AG1, long, { lookups: { search: 1 }, cites })] });
    const bubble = storedLi(3).querySelector(".bubble");
    expect(bubble.querySelector(".md-note")).not.toBeNull();
    const links = [...bubble.querySelectorAll("sup.cite button")];
    expect(links.map((b) => b.getAttribute("aria-label"))).toEqual(["引用 1"]);
    expect(bubble.textContent.startsWith("你问过1。")).toBe(true);
    await click(links[0]);
    expect(storedLi(2).classList.contains("flash")).toBe(true);
  });

  it("closing the line hides the list again; in a group no words are shown, whatever a message carries", async () => {
    const getMessage = vi.fn(async () => ({ message: wire(G1, 1, ANN, "周六见"), principals: {} }));
    await openChats({
      open: "周末小组",
      groupMessages: [wire(G1, 1, ANN, "周六见"), wire(G1, 2, AG1, "周六见。", { lookups: { search: 1 }, found: [{ conversationId: G1, seq: 1 }], queries: ["不该出现的词"] })],
      api: { getMessage },
    });
    const line = within(lookupLine(2)).getByRole("button", { name: "查了 1 次聊天记录" });
    await click(line);
    expect(lookupLine(2).querySelector(".lookup-words")).toBeNull();
    expect(timeline().textContent).not.toContain("不该出现的词");
    expect([...lookupLine(2).querySelectorAll(".lookup-rows .row-preview")].map((p) => p.textContent)).toEqual(["周六见"]);
    await click(line);
    expect(line.getAttribute("aria-expanded")).toBe("false");
    expect(lookupLine(2).querySelector(".lookup-rows")).toBeNull();
    await flush();
  });
});

describe("a reply's citations are beside its text: wherever its text is shown but in its message, it is the text as stored; what only looks like a citation is text", () => {
  // A reply as stored (its citations beside it; what looks like one in it is what it copied of someone's text), and a text
  // someone typed that looks like one.
  const STORED = "她说在春熙路〔m1〕，周一休息。";
  const TYPED = "在春熙路〔m1〕，周一休息〔f2·k7q2〕。";

  it("in the message itself: the links where they stand, around a mention, after surrogate pairs, plain and rendered alike; a person's citation-shaped text is text and never a link", async () => {
    // "😀@阿波 在春熙路¹，🌊周一休息²。"
    const text = "😀@阿波 在春熙路，🌊周一休息。";
    const cites = [cite(10, G1, 1), cite(17, G1, 3)];
    await openChats({
      open: "周末小组",
      groupMessages: [
        wire(G1, 1, ANN, TYPED),
        wire(G1, 3, BO, "好"),
        wire(G1, 4, AG1, text, { mentions: [{ id: BO, start: 2, length: 3 }], lookups: { search: 1 }, cites }),
      ],
    });
    const bubble = storedLi(4).querySelector(".bubble");
    expect(bubble.querySelector(".md")).not.toBeNull();
    expect(bubble.textContent).toBe("😀提到 阿波@阿波 在春熙路1，🌊周一休息2。");
    expect([...bubble.querySelectorAll("sup.cite button")].map((b) => b.getAttribute("aria-label"))).toEqual(["引用 1", "引用 2"]);
    expect(storedLi(1).textContent).toContain(TYPED);
    expect(storedLi(1).querySelector("sup.cite")).toBeNull();
  });

  it("a found message that is an Agent's reply: its row is its text", async () => {
    const getMessage = vi.fn(async () => ({ message: wire(G1, 1, OAG, STORED, { cites: [cite(4, G1, 9)] }), principals: {} }));
    await openChats({
      open: "周末小组",
      groupMessages: [wire(G1, 1, OAG, STORED, { cites: [cite(4, G1, 9)] }), wire(G1, 2, AG1, "见上。", { lookups: { search: 1 }, found: [{ conversationId: G1, seq: 1 }] })],
      api: { getMessage },
    });
    await click(within(lookupLine(2)).getByRole("button", { name: "查了 1 次聊天记录" }));
    expect([...lookupLine(2).querySelectorAll(".lookup-rows .row-preview")].map((p) => p.textContent)).toEqual([STORED]);
  });

  it("a quote shows the text as it is, an Agent's reply's and a person's alike", async () => {
    await openChats({
      open: "周末小组",
      groupMessages: [
        wire(G1, 1, OAG, STORED, { cites: [cite(4, G1, 9)] }),
        wire(G1, 2, ME_ID, "好的", { replyTo: { seq: 1, visible: true, senderId: OAG, text: STORED, kind: "text" } }),
        wire(G1, 3, ANN, TYPED),
        wire(G1, 4, BO, "嗯", { replyTo: { seq: 3, visible: true, senderId: ANN, text: TYPED, kind: "text" } }),
      ],
    });
    expect(storedLi(2).querySelector("blockquote").textContent).toBe(`安的助手${STORED}`);
    expect(storedLi(4).querySelector("blockquote").textContent).toBe(`小安${TYPED}`);
  });

  it("the reply chip over the composer shows the text of the Agent's reply it answers", async () => {
    await openChats({ messages: [...BASE, wire(A1, 3, AG1, STORED, { cites: [cite(4, A1, 2)] })] });
    await click(within(storedLi(3)).getByRole("button", { name: /回复/ }));
    expect(document.querySelector(".reply-chip span").textContent).toBe(`回复 小助手：${STORED}`);
  });

  it("a hit of the list's search shows the text as it is: an Agent's reply's, and a person's that looks like a citation", async () => {
    const searchAll = vi.fn(async () => ({
      messages: [wire(G1, 1, OAG, STORED, { createdAt: at(1), cites: [cite(4, G1, 9)] }), wire(G1, 2, ANN, TYPED, { createdAt: at(2) })],
      nextBefore: null,
      principals: {},
    }));
    await openChats({ groupMessages: [wire(G1, 2, ANN, TYPED)], api: { searchAll } });
    fireEvent.change(screen.getByLabelText("搜索联系人、群聊"), { target: { value: "春熙路" } });
    await elapse(300);
    const rows = [...document.querySelectorAll(".list-col .row-preview mark")].map((m) => m.closest("button").querySelector(".row-preview").textContent);
    expect(rows.sort()).toEqual([`安的助手：${STORED}`, `小安：${TYPED}`].sort());
  });
});

describe("a reply that searched the web (its webSources and webCites)", () => {
  const SOURCES = [
    { n: 2, url: "https://news.example.com/a/1", title: "北京明天晴" },
    { n: 3, url: "https://xn--bcher-kva.example/b", title: "气象台：降温" },
    { n: 4, url: "http://plain.example.com/", title: "不安全的地址" },
  ];
  const TEXT = "明天晴，见[详情](https://evil.example/?d=1)，或 https://bare.example/x 。";
  const webReply = (seq, extra = {}) => wire(A1, seq, AG1, TEXT, { lookups: { web: 1 }, webSources: SOURCES, webCites: [{ at: 3, n: 3 }, { at: 3, n: 9 }], ...extra });

  it("a quiet numbered list under its lookup line: each row the title and the address's real host, opening a new tab; an http source is not listed", async () => {
    await openChats({ messages: [...BASE, webReply(3)] });
    expect(lookupLine(3).textContent).toBe("查了 1 次网页");
    const list = storedLi(3).querySelector("ol.web-sources");
    expect(list.getAttribute("aria-label")).toBe("网页来源");
    const rows = [...list.querySelectorAll("li")];
    expect(rows.map((li) => li.textContent)).toEqual(["1北京明天晴news.example.com", "2气象台：降温xn--bcher-kva.example"]);
    for (const [i, a] of [...list.querySelectorAll("a")].entries()) {
      expect(a.getAttribute("href")).toBe(SOURCES[i].url);
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toBe("noopener noreferrer nofollow");
      expect(a.classList.contains("text-link")).toBe(true);
    }
    // Under the lookup line.
    const parts = [...storedLi(3).querySelector(".msg-main").children];
    expect(parts.indexOf(list)).toBe(parts.indexOf(lookupLine(3)) + 1);
  });

  it("its chips open the page they cite (a number it was not handed shows none); its own links and bare addresses are plain text", async () => {
    await openChats({ messages: [...BASE, webReply(3)] });
    await elapse(2000);
    const bubble = storedLi(3).querySelector(".bubble");
    const anchors = [...bubble.querySelectorAll("a")];
    expect(anchors.map((a) => a.getAttribute("href"))).toEqual([SOURCES[1].url]);
    const chip = anchors[0];
    expect(chip.closest("sup").classList.contains("cite-web")).toBe(true);
    expect(chip.classList.contains("cite-link")).toBe(true);
    // Told apart from a message's citation by its visible text too.
    expect(chip.textContent).toBe("网2");
    expect([chip.getAttribute("target"), chip.getAttribute("rel")]).toEqual(["_blank", "noopener noreferrer nofollow"]);
    expect(chip.getAttribute("aria-label")).toBe("来源 2：气象台：降温（xn--bcher-kva.example）");
    expect(bubble.textContent).toContain("详情");
    expect(bubble.textContent).toContain("evil.example");
  });

  it("a reply that did not search the web keeps its links as links, and shows no list", async () => {
    await openChats({ messages: [...BASE, wire(A1, 3, AG1, TEXT)] });
    await elapse(2000);
    expect(storedLi(3).querySelector("ol.web-sources")).toBeNull();
    expect([...storedLi(3).querySelectorAll(".bubble a")].map((a) => a.getAttribute("href"))).toContain("https://evil.example/?d=1");
  });

  it("a reply its run was handed web pages for shows its links as plain text even when none of its sources can be shown", async () => {
    await openChats({
      messages: [
        ...BASE,
        wire(A1, 3, AG1, TEXT, { plainLinks: true }),
        wire(A1, 4, AG1, TEXT, { webSources: [{ n: 1, url: "http://plain.example.com/", title: "x" }, { n: 2, url: "https://u:p@a.example/", title: "y" }] }),
        wire(A1, 5, AG1, TEXT, { webSources: [{ n: 1, url: "https://news.example.com/a", title: "长".repeat(250) }] }),
      ],
    });
    await elapse(2000);
    for (const seq of [3, 4]) {
      expect(storedLi(seq).querySelector("ol.web-sources")).toBeNull();
      expect(storedLi(seq).querySelectorAll(".bubble a")).toHaveLength(0);
      expect(storedLi(seq).querySelector(".bubble").textContent).toContain("evil.example");
    }
    // A long title is shown (cut by the service's one rule; the client never drops it), the links still plain.
    expect(storedLi(5).querySelectorAll("ol.web-sources li")).toHaveLength(1);
    expect(storedLi(5).querySelectorAll(".bubble a")).toHaveLength(0);
  });

  it("while the site offers web search, every reply being written shows its links as plain text, whether or not this page saw it search", async () => {
    const { transport } = await openChats({ models: { ...MODELS, webSearchAvailable: true } });
    await runPush(transport);
    await push(transport, { type: "delta", conversationId: A1, runId: R1, text: "见[详情](https://evil.example/?d=1)。" });
    await elapse(REVEAL_MAX_LAG_MS + 2000);
    const streaming = timeline().querySelector("li.streaming .bubble");
    expect(streaming.textContent).toContain("详情");
    expect(streaming.querySelectorAll("a")).toHaveLength(0);
  });

  it("while the site offers none, a reply being written keeps its links as links (as before)", async () => {
    const { transport } = await openChats();
    await runPush(transport);
    await push(transport, { type: "delta", conversationId: A1, runId: R1, text: "见[详情](https://evil.example/?d=1)。" });
    await elapse(REVEAL_MAX_LAG_MS + 2000);
    const streaming = timeline().querySelector("li.streaming .bubble");
    expect([...streaming.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(["https://evil.example/?d=1"]);
  });
});