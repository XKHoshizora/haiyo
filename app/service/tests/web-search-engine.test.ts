import { describe, expect, it } from "vitest";
import { deepseekEngine, RESPONSE_MAX_BYTES } from "../src/agents/tools/web/engine.ts";
import { checked } from "../src/agents/tools/web/tool.ts";

/**
 * The web search's first engine (agents/tools/web/engine.ts; lane websearch): DeepSeek's Anthropic-shaped messages
 * endpoint with its own search tool, used as a pure search call (`max_tokens: 1`). Never a real call: `fetch` is a fake
 * that records what it was asked and answers as the vendor was measured to (2026-11-22). Pure: no database.
 */

const QUERY = "秘密查询词 deepseek v4";
const result = (i: number, over: Record<string, unknown> = {}) => ({
  type: "web_search_result",
  title: `标题 ${i}`,
  url: `https://news.example.com/${i}`,
  snippet: `摘要 ${i} 很长的内容`,
  page_age: "2026-11-20T08:00:00Z",
  site_name: `网站 ${i}`,
  site_icon: "https://news.example.com/icon.png",
  encrypted_content: "xyz",
  ...over,
});
const answer = (content: unknown[], over: Record<string, unknown> = {}) => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  content,
  stop_reason: "max_tokens",
  usage: { input_tokens: 9000, output_tokens: 0, server_tool_use: { web_search_requests: 1 } },
  ...over,
});
const searched = (results: unknown[]) => answer([{ type: "server_tool_use", id: "s1", name: "deepseek_web_search", input: { queries: ["x"] } }, { type: "web_search_tool_result", tool_use_id: "s1", content: results }]);

function harness(respond: (req: Request) => Response | Promise<Response>) {
  const asked: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
  const lines: string[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    asked.push({ url: String(url), init: init!, body: JSON.parse(String(init!.body)) });
    return respond(new Request(String(url), init));
  }) as typeof globalThis.fetch;
  const engine = deepseekEngine({
    baseUrl: "https://api.deepseek.test/",
    apiKey: "sk-test-not-real",
    model: "deepseek-flash",
    timeoutMs: 15_000,
    maxResults: 6,
    timeZone: "Asia/Shanghai",
    now: () => new Date("2026-11-22T03:00:00Z"),
    fetch,
    log: { info: (details, msg) => lines.push(JSON.stringify({ details, msg })) },
  });
  return { engine, asked, lines };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const never = { signal: new AbortController().signal };

describe("the DeepSeek engine", () => {
  it("one POST to /anthropic/v1/messages, as measured: max_tokens 1, thinking off, the site's date, its search tool, safety high, no tool_choice", async () => {
    const { engine, asked } = harness(() => json(searched([result(1)])));
    await engine.searchWeb(QUERY, never);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.url).toBe("https://api.deepseek.test/anthropic/v1/messages");
    expect(asked[0]!.init.method).toBe("POST");
    const headers = new Headers(asked[0]!.init.headers);
    expect(headers.get("x-api-key")).toBe("sk-test-not-real");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(asked[0]!.body).toEqual({
      model: "deepseek-flash",
      max_tokens: 1,
      thinking: { type: "disabled" },
      system: "Today is 2026-11-22.",
      tools: [{ type: "deepseek_web_search", name: "deepseek_web_search" }],
      safety_check: { level: "high" },
      messages: [{ role: "user", content: QUERY }],
    });
  });

  it("the results: the first six with an https address, titles and snippets cleaned, the page's age kept; the vendor's queries and site names dropped", async () => {
    const results = [
      result(1, { url: "http://plain.example.com/1" }),
      result(2, { title: `标题${String.fromCodePoint(0x202e)}见 https://evil.example/x @alice` }),
      result(3, { url: "https://u:p@creds.example.com/" }),
      result(4, { snippet: "字".repeat(400) }),
      result(5, { page_age: "not a date" }),
      result(6),
      result(7),
      result(8),
      result(9),
      { type: "something_else" },
    ];
    const { engine } = harness(() => json(searched(results)));
    const got = await engine.searchWeb(QUERY, never);
    if (!("results" in got)) throw new Error("expected results");
    expect(got.results.map((r) => r.url)).toEqual([2, 4, 5, 6, 7, 8].map((i) => `https://news.example.com/${i}`));
    expect(got.results[0]!.title).toBe("标题见");
    expect(Array.from(got.results[1]!.snippet).length).toBeLessThanOrEqual(301);
    expect(got.results[0]!.age).toBe("2026-11-20T08:00:00Z");
    expect(got.results[2]!.age).toBeUndefined();
    expect(JSON.stringify(got)).not.toContain("网站");
  });

  it("the same address twice is one result (the first), whatever its spelling of the host", async () => {
    const results = [result(1), result(2), result(1, { title: "另一个标题" }), result(4, { url: "https://NEWS.example.com/2" }), result(3)];
    const got = await harness(() => json(searched(results))).engine.searchWeb(QUERY, never);
    if (!("results" in got)) throw new Error("expected results");
    expect(got.results.map((r) => [r.url, r.title])).toEqual([
      ["https://news.example.com/1", "标题 1"],
      ["https://news.example.com/2", "标题 2"],
      ["https://news.example.com/3", "标题 3"],
    ]);
  });

  it("the tool checks any adapter's results again: https only, each address once, titles and snippets cleaned, a bad age dropped (never a throw)", () => {
    const raw = [
      { url: "http://plain.example.com/", title: "不安全", snippet: "x" },
      { url: "https://news.example.com/a", title: `原始标题 见 https://evil.example/x @alice ${"长".repeat(300)}`, snippet: "摘要 www.evil.example/x", age: "not a date" },
      { url: "https://NEWS.example.com/a", title: "重复", snippet: "y" },
      { url: "https://news.example.com/b", title: "好", snippet: "z", age: "2026-11-20T08:00:00Z" },
    ];
    const kept = checked(raw);
    expect(kept.map((r) => r.url)).toEqual(["https://news.example.com/a", "https://news.example.com/b"]);
    expect(kept[0]!.title.startsWith("原始标题 ")).toBe(true);
    expect(kept[0]!.title).not.toMatch(/evil|@|https/);
    expect(Array.from(kept[0]!.title)).toHaveLength(200);
    expect(kept[0]!.snippet).toBe("摘要");
    expect(kept[0]).not.toHaveProperty("age");
    expect(kept[1]!.age).toBe("2026-11-20T08:00:00Z");
    expect(checked(kept)).toEqual(kept);
  });

  it("no result block (the engine answered without searching): no results; a refusal: refused", async () => {
    expect(await harness(() => json(answer([{ type: "text", text: "你好" }]))).engine.searchWeb(QUERY, never)).toEqual({ error: "no_results" });
    expect(await harness(() => json(searched([]))).engine.searchWeb(QUERY, never)).toEqual({ error: "no_results" });
    expect(await harness(() => json(searched([result(1, { url: "http://x.example.com/" })]))).engine.searchWeb(QUERY, never)).toEqual({ error: "no_results" });
    expect(await harness(() => json(answer([], { stop_reason: "refusal" }))).engine.searchWeb(QUERY, never)).toEqual({ error: "refused" });
  });

  it("anything else is an error, never a throw: a 4xx or 5xx, a 429, bad JSON, a body over 1 MB, a network failure", async () => {
    expect(await harness(() => json({ error: { message: `bad ${QUERY}` } }, 400)).engine.searchWeb(QUERY, never)).toEqual({ error: "unavailable" });
    expect(await harness(() => json({}, 503)).engine.searchWeb(QUERY, never)).toEqual({ error: "unavailable" });
    expect(await harness(() => json({}, 429)).engine.searchWeb(QUERY, never)).toEqual({ error: "busy" });
    expect(await harness(() => new Response("{not json", { status: 200 })).engine.searchWeb(QUERY, never)).toEqual({ error: "unavailable" });
    expect(await harness(() => new Response("x".repeat(RESPONSE_MAX_BYTES + 1), { status: 200 })).engine.searchWeb(QUERY, never)).toEqual({ error: "unavailable" });
    expect(
      await harness(() => {
        throw new TypeError("fetch failed");
      }).engine.searchWeb(QUERY, never),
    ).toEqual({ error: "unavailable" });
  });

  it("past its time limit: timeout; the run's signal aborting ends the call too", async () => {
    const hang = (req: Request) =>
      new Promise<Response>((_, reject) => req.signal.addEventListener("abort", () => reject(req.signal.reason), { once: true }));
    const slow = harness(hang);
    const fast = deepseekEngine({ ...engineOptions(slow), timeoutMs: 50 });
    expect(await fast.searchWeb(QUERY, never)).toEqual({ error: "timeout" });
    const stopped = new AbortController();
    const going = slow.engine.searchWeb(QUERY, { signal: stopped.signal });
    stopped.abort(new Error("stop"));
    expect(await going).toEqual({ error: "unavailable" });
  });

  it("logs the engine, the status class, the time and how many results — never the query, an address, a title, a snippet or an upstream body", async () => {
    for (const respond of [() => json(searched([result(1), result(2)])), () => json({ error: { message: `bad ${QUERY}` } }, 400)]) {
      const { engine, lines } = harness(respond);
      await engine.searchWeb(QUERY, never);
      expect(lines).toHaveLength(1);
      const line = lines[0]!;
      for (const secret of ["秘密", "deepseek v4", "news.example.com", "标题", "摘要", "sk-test", "bad "]) expect([secret, line.includes(secret)]).toEqual([secret, false]);
      expect(JSON.parse(line).details).toMatchObject({ metric: "web_search", engine: "deepseek_messages", ms: expect.any(Number) });
    }
  });
});

/** The options `harness` built its engine with (its fake fetch and log), to build another from. */
function engineOptions(h: ReturnType<typeof harness>) {
  return {
    baseUrl: "https://api.deepseek.test/",
    apiKey: "sk-test-not-real",
    model: "deepseek-flash",
    timeoutMs: 15_000,
    maxResults: 6,
    timeZone: "Asia/Shanghai",
    now: () => new Date("2026-11-22T03:00:00Z"),
    fetch: (async (url: string, init?: RequestInit) => {
      h.asked.push({ url, init: init!, body: JSON.parse(String(init!.body)) });
      return new Promise<Response>((_, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }));
    }) as unknown as typeof globalThis.fetch,
    log: { info: () => {} },
  };
}
