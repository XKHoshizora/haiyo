import { describe, expect, it } from "vitest";
import {
  INPUT_MAX_WEIGHT,
  MESSAGES_NOTE,
  replayTools,
  RESULT_MAX_WEIGHT,
  replayId,
  replayOf,
  siteOf,
  SITE_MAX_CHARS,
  storedToolCalls,
  TIME_NOTE,
  toolCallsOf,
  WEB_NOTE,
} from "../src/agents/replay.ts";
import { ContextPlan, minimalTokens, partText, partTokens, type ContextEntry, type ReplayRound } from "../src/agents/runtime/context.ts";
import { OVER_CAP, REPEATED, UNUSABLE } from "../src/agents/runtime/loop.ts";
import type { ToolTrace } from "../src/agents/runtime/port.ts";
import { RunRefs } from "../src/agents/tools/refs.ts";
import { BAD_DATE, QUERY_TOO_LONG, QUERY_TOO_SHORT, SEARCH_BUSY, SEARCH_MESSAGES, SEARCH_TIMEOUT } from "../src/agents/tools/search.ts";
import { CURRENT_TIME } from "../src/agents/tools/clock.ts";
import { SEARCH_WEB } from "../src/agents/tools/web/tool.ts";
import * as WEB_WORDS from "../src/agents/tools/web/words.ts";
import { estimateTokens, TOOL_TEXT_FACTOR, weight } from "../src/metering/tokens.ts";

/**
 * The pure parts of step 1 of the harness design (docs/design/2026-11-24-agent-harness-design.md §3): what a reply that
 * looked something up keeps of its calls (`storedToolCalls`, read back by `toolCallsOf`), what it returns as in a later
 * reply's history (`replayOf`: native calls with placeholder results), and how the plan weighs and lays that out
 * (runtime/context.ts `partText`, `ContextPlan`).
 */

const DAY = "2026-11-22";
const ALL = new Set(replayTools());
const sources = (hosts: string[]) => hosts.map((h, i) => ({ n: i + 1, url: `https://${h}/page/${i + 1}`, title: `标题${i + 1}` }));
const web = (query: string, pages: number[], round = 1): ToolTrace => ({ name: SEARCH_WEB, round, outcome: "ok", input: { query }, pages });
const refused = (said: string, name = SEARCH_WEB, round = 1): ToolTrace => ({ name, round, outcome: "refused", said });
/** Every fixed sentence a tool or the loop answers a call it did not run with. */
const SENTENCES = [...(Object.values(WEB_WORDS) as unknown[]).filter((v): v is string => typeof v === "string"), SEARCH_TIMEOUT, SEARCH_BUSY, QUERY_TOO_SHORT, QUERY_TOO_LONG, BAD_DATE, UNUSABLE, REPEATED, OVER_CAP];

describe("what a reply keeps of its calls (storedToolCalls)", () => {
  it("a search that ran: its query cleaned and its token-shaped strings out, the pages it handed out; a refused one: its sentence and no input at all", () => {
    const refs = new RunRefs({}, true);
    const stored = storedToolCalls([web(" 上海​ 今天〔m1〕天气\n", [1, 2, 3]), refused(WEB_WORDS.WEB_QUERY_PRIVATE, SEARCH_WEB, 2)], refs);
    expect(stored).toEqual([
      { name: SEARCH_WEB, round: 1, outcome: "ok", input: { query: "上海 今天天气" }, pages: [1, 2, 3] },
      { name: SEARCH_WEB, round: 2, outcome: "refused", error: WEB_WORDS.WEB_QUERY_PRIVATE },
    ]);
    expect(JSON.stringify(stored)).not.toContain("〔m1〕");
  });

  it("a refused call never keeps its input, whatever the trace holds; a sentence that is none of the fixed ones is kept as UNUSABLE", () => {
    const stored = storedToolCalls([{ name: SEARCH_WEB, round: 1, outcome: "refused", said: "我的私事 13800138000", input: { query: "我的私事 13800138000" } }], null);
    expect(stored).toEqual([{ name: SEARCH_WEB, round: 1, outcome: "refused", error: UNUSABLE }]);
    for (const s of SENTENCES) expect(storedToolCalls([refused(s)], null)).toEqual([{ name: SEARCH_WEB, round: 1, outcome: "refused", error: s }]);
  });

  it("the input is at most 60 weight as JSON text (escaping counted); the messages search keeps its filters, the clock nothing", () => {
    const long = "天气".repeat(80) + '"\\';
    const [cut] = storedToolCalls([web(long, [])], null)!;
    expect(weight(JSON.stringify((cut as { input: unknown }).input))).toBeLessThanOrEqual(INPUT_MAX_WEIGHT);
    expect((cut as unknown as { input: { query: string } }).input.query.startsWith("天气天气")).toBe(true);
    const quoted = '"'.repeat(100);
    const [escaped] = storedToolCalls([web(quoted, [])], null)!;
    expect(weight(JSON.stringify((escaped as { input: unknown }).input))).toBeLessThanOrEqual(INPUT_MAX_WEIGHT);
    expect(
      storedToolCalls(
        [
          { name: SEARCH_MESSAGES, round: 1, outcome: "ok", input: { query: "川菜", from: "小林", after: "2026-11-01", extra: "x" }, found: 3 },
          { name: CURRENT_TIME, round: 1, outcome: "ok", input: { anything: 1 } },
        ],
        null,
      ),
    ).toEqual([
      { name: SEARCH_MESSAGES, round: 1, outcome: "ok", input: { query: "川菜", from: "小林", after: "2026-11-01" }, found: 3 },
      { name: CURRENT_TIME, round: 1, outcome: "ok", input: {} },
    ]);
  });

  it("nothing is kept for no calls, or for a trace with a call of any other tool (a file read, a name made up)", () => {
    expect(storedToolCalls([], null)).toBeNull();
    expect(storedToolCalls([web("天气", [1]), { name: "read_file", round: 1, outcome: "ok", input: { file: "f1" } }], null)).toBeNull();
    expect(storedToolCalls([refused(UNUSABLE, "x".repeat(5000))], null)).toBeNull();
  });

  it("read back only when well formed (toolCallsOf): anything else is no replay", () => {
    const good = storedToolCalls([web("天气", [1]), refused(REPEATED, SEARCH_WEB, 2)], null);
    expect(toolCallsOf(good)).toEqual(good);
    for (const bad of [
      null,
      {},
      [],
      [{ name: "read_file", round: 1, outcome: "ok", input: {} }],
      [{ name: SEARCH_WEB, round: 0, outcome: "ok", input: { query: "a" } }],
      [{ name: SEARCH_WEB, round: 1, outcome: "refused", error: "我的私事" }],
      [{ name: SEARCH_WEB, round: 1, outcome: "refused", error: UNUSABLE, input: { query: "私事" } }],
      [{ name: SEARCH_WEB, round: 1, outcome: "ok", input: { query: "天".repeat(61) } }],
      [{ name: SEARCH_WEB, round: 2, outcome: "ok", input: { query: "a" } }, { name: SEARCH_WEB, round: 1, outcome: "ok", input: { query: "b" } }],
      [{ name: SEARCH_WEB, round: 1, outcome: "ok", input: { query: 3 } }],
    ]) {
      expect([bad, toolCallsOf(bad)]).toEqual([bad, null]);
    }
  });
});

describe("what it returns as (replayOf)", () => {
  const facts = (over: Partial<Parameters<typeof replayOf>[1]> = {}) => ({ messageId: "4711", day: DAY, webSources: sources(["news1.example.com", "news2.example.com", "news3.example.com", "news4.example.com"]), webCites: [], ...over });

  it("round by round: each round's calls, then their results — a web search's sites (cited first, at most three), the date; ids from the message and the call's place", () => {
    const stored = storedToolCalls([web("北京 天气", [1, 2, 3, 4]), { name: CURRENT_TIME, round: 1, outcome: "ok", input: {} }, refused(OVER_CAP, SEARCH_WEB, 2)], null);
    const rounds = replayOf(stored, facts({ webCites: [{ at: 1, n: 3 }] }), ALL)!;
    const [a, b, c] = [replayId("4711", 0), replayId("4711", 1), replayId("4711", 2)];
    expect(rounds).toEqual([
      {
        calls: [
          { type: "tool-call", id: a, name: SEARCH_WEB, input: { query: "北京 天气" } },
          { type: "tool-call", id: b, name: CURRENT_TIME, input: {} },
        ],
        results: [
          { type: "tool-result", id: a, name: SEARCH_WEB, output: { note: WEB_NOTE, sites: ["news3.example.com", "news1.example.com", "news2.example.com"], date: DAY } },
          { type: "tool-result", id: b, name: CURRENT_TIME, output: { note: TIME_NOTE, date: DAY } },
        ],
      },
      {
        calls: [{ type: "tool-call", id: c, name: SEARCH_WEB, input: { query: "" } }],
        results: [{ type: "tool-result", id: c, name: SEARCH_WEB, output: { error: OVER_CAP, date: DAY } }],
      },
    ]);
    expect(new Set([a, b, c, replayId("4712", 0)]).size).toBe(4);
    expect(a).toMatch(/^[0-9a-f]{22}$/);
    expect(replayOf(stored, facts({ webCites: [{ at: 1, n: 3 }] }), ALL)).toEqual(rounds);
  });

  it("a messages search: how many it found, never what", () => {
    const stored = storedToolCalls([{ name: SEARCH_MESSAGES, round: 1, outcome: "ok", input: { query: "川菜" }, found: 12 }], null);
    expect(replayOf(stored, facts(), ALL)![0]!.results[0]!.output).toEqual({ note: MESSAGES_NOTE, found: 12, date: DAY });
  });

  it("sites: one each, whole labels from the right while at most 30 characters — a 253-character host is cut so, one with no such label is left out", () => {
    const deep = `${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(58)}.example.com`;
    expect(deep.length).toBe(253);
    expect(siteOf(`https://${deep}/x`)).toBe("example.com");
    expect(siteOf("https://www.tianqi.com/shanghai/")).toBe("www.tianqi.com");
    expect(siteOf("https://a.very-long-subdomain-name.example.co.uk/")).toBe("example.co.uk");
    expect(siteOf(`https://x.${"t".repeat(31)}/`)).toBeNull();
    const stored = storedToolCalls([web("q", [1, 2, 3])], null);
    const sites = (replayOf(stored, facts({ webSources: sources([deep, "news.example.com", "news.example.com"]) }), ALL)![0]!.results[0]!.output as { sites: string[] }).sites;
    expect(sites).toEqual(["example.com", "news.example.com"]);
    for (const s of sites) expect(s.length).toBeLessThanOrEqual(SITE_MAX_CHARS);
  });

  it("no replay: a call to a tool this request does not offer, nothing stored, nothing well formed", () => {
    const stored = storedToolCalls([web("q", [1])], null);
    expect(replayOf(stored, facts(), new Set([CURRENT_TIME, SEARCH_MESSAGES]))).toBeNull();
    expect(replayOf(undefined, facts(), ALL)).toBeNull();
    expect(replayOf([{ name: SEARCH_WEB }], facts(), ALL)).toBeNull();
  });

  it("bounds by construction: every result at most 72 weight, every input at most 60 — worst cases included", () => {
    const wide = Array.from({ length: 3 }, (_, i) => `${String.fromCharCode(97 + i).repeat(18)}.example.com`);
    expect(wide.every((h) => h.length === SITE_MAX_CHARS)).toBe(true);
    const stored = storedToolCalls(
      [
        web("搜".repeat(200), [1, 2, 3]),
        ...SENTENCES.map((s) => refused(s, SEARCH_WEB, 2)),
        { name: SEARCH_MESSAGES, round: 3, outcome: "ok", input: { query: "找".repeat(100), from: "名".repeat(100), before: "2026-11-20", after: "2026-11-01" }, found: 999 },
        { name: CURRENT_TIME, round: 3, outcome: "ok", input: {} },
      ],
      null,
    );
    const rounds = replayOf(stored, facts({ webSources: sources(wide) }), ALL)!;
    const results = rounds.flatMap((r) => r.results);
    const calls = rounds.flatMap((r) => r.calls);
    const worst = { result: Math.max(...results.map((r) => weight(JSON.stringify(r.output)))), input: Math.max(...calls.map((c) => weight(JSON.stringify(c.input)))) };
    expect(worst.result).toBeLessThanOrEqual(RESULT_MAX_WEIGHT);
    expect(worst.input).toBeLessThanOrEqual(INPUT_MAX_WEIGHT);
    // One call with its result, as the plan and the holds weigh it (`partText`).
    const pair = Math.max(...calls.map((c, i) => weight(partText(c)!) + weight(partText(results[i]!)!)));
    expect(pair).toBeLessThanOrEqual(INPUT_MAX_WEIGHT + RESULT_MAX_WEIGHT + 46);
  });
});

describe("the plan: a reply and its replay are one unit, weighed by one function (partText)", () => {
  const round = (id: string): ReplayRound => ({
    calls: [{ type: "tool-call", id, name: SEARCH_WEB, input: { query: "北京 天气" } }],
    results: [{ type: "tool-result", id, name: SEARCH_WEB, output: { note: WEB_NOTE, sites: ["news1.example.com"], date: DAY } }],
  });
  const ack: ContextEntry = { role: "assistant", text: "我查一下。", attachment: null };
  const answer = (rounds: ReplayRound[]): ContextEntry => ({ role: "assistant", text: "今天晴。", attachment: null, replay: rounds });
  const user = (text: string): ContextEntry => ({ role: "user", text, attachment: null });

  it("partText: a text part's text, a call's {id, name, input}, a result's {id, name, output}; images and PDFs none (their constants stand)", () => {
    const [call] = round("abc").calls;
    const [result] = round("abc").results;
    expect(partText({ type: "text", text: "你好" })).toBe("你好");
    expect(partText(call!)).toBe(JSON.stringify({ id: "abc", name: SEARCH_WEB, input: { query: "北京 天气" } }));
    expect(partText(result!)).toBe(JSON.stringify({ id: "abc", name: SEARCH_WEB, output: result!.output }));
    expect(partText({ type: "image", mime: "image/png", data: new Uint8Array(3) })).toBeNull();
    expect(partTokens(call!, 1.2)).toBe(estimateTokens(partText(call!)!, 1.2 * TOOL_TEXT_FACTOR));
    expect(minimalTokens(answer([round("abc")]), 1.2)).toBe(estimateTokens("今天晴。", 1.2) + partTokens(call!, 1.2) + partTokens(result!, 1.2));
  });

  it("build: [acknowledgement, the round's calls] > [their results] > [the answer], round by round; the tool parts counted in tokens, never as fixed", () => {
    const plan = new ContextPlan([user("北京今天天气？"), ack, answer([round("a1"), round("a2")]), user("那明天呢？")], 100_000);
    plan.keepOlder();
    const built = plan.build();
    expect(built.messages.map((m) => [m.role, m.parts.map((p) => (p.type === "text" ? p.text : `${p.type}:${(p as { id: string }).id}`))])).toEqual([
      ["user", ["北京今天天气？"]],
      ["assistant", ["我查一下。", "tool-call:a1"]],
      ["tool", ["tool-result:a1"]],
      ["assistant", ["tool-call:a2"]],
      ["tool", ["tool-result:a2"]],
      ["assistant", ["今天晴。"]],
      ["user", ["那明天呢？"]],
    ]);
    const parts = built.messages.flatMap((m) => m.parts);
    expect(built.tokens).toBe(parts.reduce((n, p) => n + partTokens(p), 0));
    expect(built.fixed).toBe(0);
  });

  it("kept or left out as one: a budget that holds the answer's text but not its replay shows neither (nor anything older)", () => {
    const entries = [user("北京今天天气？"), ack, answer([round("a1")]), user("那明天呢？")];
    const newest = minimalTokens(entries[3]!);
    const answerText = estimateTokens("今天晴。");
    const plan = new ContextPlan(entries, newest + answerText + 1);
    plan.keepOlder();
    expect(plan.shownAt()).toEqual([3]);
    const whole = new ContextPlan(entries, newest + minimalTokens(entries[2]!) + minimalTokens(entries[1]!) + minimalTokens(entries[0]!));
    whole.keepOlder();
    expect(whole.shownAt()).toEqual([0, 1, 2, 3]);
  });
});
