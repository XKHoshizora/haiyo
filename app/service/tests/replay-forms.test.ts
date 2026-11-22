import { describe, expect, it } from "vitest";
import {
  D_NOTE,
  D_RESULT_MAX_WEIGHT,
  EXCERPT_SNIPPET_MAX_WEIGHT,
  EXCERPT_TITLE_MAX_WEIGHT,
  H2_MESSAGES_NOTE,
  H2_RESULT_MAX_WEIGHT,
  H2_WEB_NOTE,
  maxCallsOf,
  mostRecent,
  REAL_REPLIES,
  REFUSAL_NOTE,
  REPLAY_TOOLS,
  replayId,
  replayOf,
  storedToolCalls,
  toolCallsOf,
  TIME_NOTE,
  WEB_NOTE,
  withReplay,
  type ReplayForm,
} from "../src/agents/replay.ts";
import { ContextPlan, partText, type ContextEntry } from "../src/agents/runtime/context.ts";
import type { ToolTrace } from "../src/agents/runtime/port.ts";
import { TOOL_MATERIAL } from "../src/agents/runtime/prompt.ts";
import { RunRefs } from "../src/agents/tools/refs.ts";
import { CURRENT_TIME } from "../src/agents/tools/clock.ts";
import { SEARCH_MESSAGES } from "../src/agents/tools/search-words.ts";
import { SEARCH_WEB, WEB_NO_MONEY, WEB_QUERY_PRIVATE } from "../src/agents/tools/web/words.ts";
import { DEFAULT_TOOLS } from "../src/config.ts";
import { weight } from "../src/metering/tokens.ts";

/**
 * The forms an earlier reply's tool use may return in (fix round 2; \`TOOLS.replayForm\`, read in config.ts alone), for a
 * measurement to choose among: H (the default), H2 (a placeholder saying what the search returned then and that its text
 * is not kept here), H3 (H2, the acknowledgement after the results), D (H3, a stored excerpt of the most recent replies'
 * web results). What each shows, its bounds, and that the default stays H.
 */

const DAY = "2026-11-22";
const ALL = new Set(REPLAY_TOOLS);
const CAP = maxCallsOf(DEFAULT_TOOLS);
const sources = (hosts: string[]) => hosts.map((h, i) => ({ n: i + 1, url: `https://${h}/a/${i + 1}`, title: `标题${i + 1}` }));
const facts = { messageId: "4711", day: DAY, webSources: sources(["news1.example.com", "news2.example.com", "news3.example.com"]), webCites: [] };
const excerpts = [
  { title: "上海天气预报_2026年11月22日", snippet: "今天白天上海多云，最高气温18℃，最低气温12℃。" },
  { title: "Hourly weather today in Shanghai", snippet: "Morning 8 °C, afternoon 16°." },
  { title: "奉贤区气象台今明天气预报", snippet: "晴到多云，明天下午起有短时小雨。" },
];
const web: ToolTrace = { name: SEARCH_WEB, round: 1, outcome: "ok", input: { query: "上海 今天 天气" }, pages: [1, 2, 3], excerpts };
const messages: ToolTrace = { name: SEARCH_MESSAGES, round: 1, outcome: "ok", input: { query: "川菜" }, found: 12 };
const refused: ToolTrace = { name: SEARCH_WEB, round: 2, outcome: "refused", said: WEB_NO_MONEY };
const results = (form: ReplayForm, real = false) => replayOf(storedToolCalls([web, messages, refused], null, CAP, form), facts, ALL, CAP, form, real)!.flatMap((r) => r.results.map((x) => x.output));

describe("the switch", () => {
  it("defaults to H, the form step 1 shipped", () => {
    expect(DEFAULT_TOOLS.replayForm).toBe("H");
    expect(results("H")[0]).toEqual({ note: WEB_NOTE, sites: ["news1.example.com", "news2.example.com", "news3.example.com"], date: DAY });
  });
});

describe("H2: the placeholder says what the search returned then, that the answer was written from it, and that its text is not kept here", () => {
  it("web and messages searches: how many results there were, that their text is not here, and what follows; the refusal and the clock as in H", () => {
    const [w, m, r] = results("H2");
    expect(w).toEqual({ results_returned_then: 3, text_kept_here: false, note: H2_WEB_NOTE, sites: ["news1.example.com", "news2.example.com", "news3.example.com"], date: DAY });
    expect(m).toEqual({ messages_found_then: 12, text_kept_here: false, note: H2_MESSAGES_NOTE, date: DAY });
    expect(r).toEqual({ error: WEB_NO_MONEY, note: REFUSAL_NOTE, date: DAY });
    expect(H2_WEB_NOTE).toBe("那次回答是根据这些结果写的；原文没有保存在这里，回答以外的细节要重新搜索");
    // Nothing of what the search found is kept for H2: no excerpt is stored.
    expect(JSON.stringify(storedToolCalls([web], null, CAP, "H2"))).not.toContain("最高气温");
  });

  it("bounds by construction: a web result at most H2_RESULT_MAX_WEIGHT, and one reply at the default caps within 1 600", () => {
    const wide = ["a", "b", "c"].map((c) => `${c.repeat(18)}.example.com`);
    const worst: ToolTrace[] = [
      ...[0, 1, 2].map((i): ToolTrace => ({ name: SEARCH_WEB, round: 1, outcome: "ok", input: { query: "搜".repeat(80 + i) }, pages: Array.from({ length: 20 }, (_, n) => n + 1) })),
      ...[0, 1, 2, 3, 4, 5].map((i): ToolTrace => ({ name: SEARCH_MESSAGES, round: 2, outcome: "ok", input: { query: "找".repeat(90 + i), from: "名".repeat(40), before: "2026-11-20", after: "2026-11-01" }, found: 999 })),
      { name: SEARCH_WEB, round: 3, outcome: "refused", said: WEB_QUERY_PRIVATE },
    ];
    for (const form of ["H2", "H3"] as const) {
      const rounds = replayOf(storedToolCalls(worst, null, CAP, form), { ...facts, webSources: sources([...wide, ...Array.from({ length: 17 }, (_, i) => `x${i}.example.com`)]) }, ALL, CAP, form)!;
      const outs = rounds.flatMap((r) => r.results.map((x) => weight(JSON.stringify(x.output))));
      expect([form, Math.max(...outs) <= H2_RESULT_MAX_WEIGHT]).toEqual([form, true]);
      const total = rounds.flatMap((r) => [...r.calls, ...r.results]).reduce((n, p) => n + weight(partText(p)!), 0);
      expect([form, total <= 1600]).toEqual([form, true]);
    }
  });
});

describe("H3: H2, and the acknowledgement no longer opens the turn that ends in a call — it heads the answer, after the results", () => {
  const ack: ContextEntry = { role: "assistant", text: "我查一下。", attachment: null, ack: true };
  const answer = (form: ReplayForm): ContextEntry => withReplay({ role: "assistant", text: "今天晴。", attachment: null }, storedToolCalls([web], null, CAP, form), facts, { tools: ALL, maxCalls: CAP, form });
  const user = (text: string): ContextEntry => ({ role: "user", text, attachment: null });
  const layout = (form: ReplayForm) => {
    const plan = new ContextPlan([user("上海天气？"), ack, answer(form), user("那明天呢？")], 100_000);
    plan.keepOlder();
    return plan.build().messages.map((m) => [m.role, m.parts.map((p) => (p.type === "text" ? p.text : p.type))]);
  };

  it("H and H2: [acknowledgement, call] > [result] > [answer]; H3 and D: [call] > [result] > [acknowledgement, answer]", () => {
    for (const form of ["H", "H2"] as const)
      expect([form, layout(form)]).toEqual([form, [["user", ["上海天气？"]], ["assistant", ["我查一下。", "tool-call"]], ["tool", ["tool-result"]], ["assistant", ["今天晴。"]], ["user", ["那明天呢？"]]]]);
    for (const form of ["H3", "D"] as const)
      expect([form, layout(form)]).toEqual([form, [["user", ["上海天气？"]], ["assistant", ["tool-call"]], ["tool", ["tool-result"]], ["assistant", ["我查一下。", "今天晴。"]], ["user", ["那明天呢？"]]]]);
  });

  it("an acknowledgement with no replayed answer after it stays where it is", () => {
    const plain: ContextEntry = { role: "assistant", text: "今天晴。", attachment: null };
    const plan = new ContextPlan([user("上海天气？"), ack, plain, user("那明天呢？")], 100_000);
    plan.keepOlder();
    expect(plan.build().messages.map((m) => [m.role, m.parts.map((p) => (p.type === "text" ? p.text : p.type))])).toEqual([["user", ["上海天气？"]], ["assistant", ["我查一下。", "今天晴。"]], ["user", ["那明天呢？"]]]);
  });
});

describe("D: H3, and the most recent replies' web results as a stored excerpt (title and snippet per page, under the material sentence)", () => {
  it("stored only under D, each cut (title, snippet, as JSON text), token-shaped strings out; read back only when well formed", () => {
    const refs = new RunRefs({}, true);
    const long = { title: "标".repeat(50) + '"', snippet: "摘".repeat(100) + "〔w1〕" };
    const stored = storedToolCalls([{ ...web, excerpts: [long, ...excerpts] }], refs, CAP, "D")!;
    const kept = (stored[0] as { excerpts: Array<{ title: string; snippet: string }> }).excerpts;
    expect(kept).toHaveLength(3);
    expect(weight(JSON.stringify(kept[0]!.title))).toBeLessThanOrEqual(EXCERPT_TITLE_MAX_WEIGHT);
    expect(weight(JSON.stringify(kept[0]!.snippet))).toBeLessThanOrEqual(EXCERPT_SNIPPET_MAX_WEIGHT);
    expect(JSON.stringify(stored)).not.toContain("〔w1〕");
    for (const form of ["H", "H2", "H3"] as const) expect([form, JSON.stringify(storedToolCalls([web], null, CAP, form)).includes("excerpts")]).toEqual([form, false]);
    expect(toolCallsOf(stored)).toEqual(stored);
    const bad = [{ ...stored[0], excerpts: [{ title: "t".repeat(200), snippet: "s" }] }];
    expect(toolCallsOf(bad)).toBeNull();
  });

  it("a real reply's result: the material sentence, how many there were, the excerpts with their sites, that only excerpts are here; an older one, H3's placeholder", () => {
    const real = results("D", true)[0];
    expect(real).toEqual({
      about: TOOL_MATERIAL,
      results_returned_then: 3,
      excerpts: excerpts.map((e, i) => ({ site: `news${i + 1}.example.com`, ...e })),
      note: D_NOTE,
      date: DAY,
    });
    expect(results("D", false)).toEqual(results("H3"));
    // Nothing stored to show (a reply from before D, or a messages search): H3's.
    expect(replayOf(storedToolCalls([web], null, CAP, "H3"), facts, ALL, CAP, "D", true)![0]!.results[0]!.output).toEqual(results("H3")[0]);
  });

  it("the most recent replies only (REAL_REPLIES), newest first", () => {
    expect(REAL_REPLIES).toBe(2);
    const items = ["a", "b", "c", "d", "e"];
    expect([...mostRecent(items, (x) => x !== "e")]).toEqual(["d", "c"]);
  });

  it("bounds by construction: a real web result at most D_RESULT_MAX_WEIGHT, and one real reply at the default caps within the stated 2 300", () => {
    const wide = ["a", "b", "c"].map((c) => `${c.repeat(18)}.example.com`);
    const heavy = Array.from({ length: 3 }, () => ({ title: '"'.repeat(80), snippet: '"'.repeat(200) }));
    const worst: ToolTrace[] = [
      ...[0, 1, 2].map((i): ToolTrace => ({ name: SEARCH_WEB, round: 1, outcome: "ok", input: { query: "搜".repeat(80 + i) }, pages: [1, 2, 3], excerpts: heavy })),
      ...[0, 1, 2, 3, 4, 5].map((i): ToolTrace => ({ name: SEARCH_MESSAGES, round: 2, outcome: "ok", input: { query: "找".repeat(90 + i), from: "名".repeat(40) }, found: 999 })),
      { name: SEARCH_WEB, round: 3, outcome: "refused", said: WEB_QUERY_PRIVATE },
    ];
    const rounds = replayOf(storedToolCalls(worst, null, CAP, "D"), { ...facts, webSources: sources(wide) }, ALL, CAP, "D", true)!;
    const outs = rounds.flatMap((r) => r.results.map((x) => weight(JSON.stringify(x.output))));
    expect(Math.max(...outs)).toBeLessThanOrEqual(D_RESULT_MAX_WEIGHT);
    expect(rounds.flatMap((r) => [...r.calls, ...r.results]).reduce((n, p) => n + weight(partText(p)!), 0)).toBeLessThanOrEqual(2300);
  });

  it("the ids are the same in every form (one call, one id)", () => {
    for (const form of ["H", "H2", "H3", "D"] as const) expect(replayOf(storedToolCalls([web], null, CAP, form), facts, ALL, CAP, form, true)![0]!.calls[0]!.id).toBe(replayId("4711", 0));
    expect(TIME_NOTE).toBe("当时给过你那时的时间。");
    void CURRENT_TIME;
  });
});
