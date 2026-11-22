import { describe, expect, it } from "vitest";
import { EXA_RESULTS_READ, exaCostOf, exaEngine, REFUSED_WARN_EVERY_MS, RESPONSE_MAX_BYTES, statusError } from "../src/agents/tools/web/engine.ts";

/**
 * The web search's default engine since lane websearch2 (agents/tools/web/engine.ts `exaEngine`): Exa's search API, as its
 * docs and pricing page read on 2026-11-22. Never a real call: `fetch` is a fake that records what it was asked and
 * answers in the documented shape. Pure: no database.
 */

const QUERY = "秘密查询词 exa search";
const result = (i: number, over: Record<string, unknown> = {}) => ({
  id: `https://news.example.com/${i}`,
  title: `标题 ${i}`,
  url: `https://news.example.com/${i}`,
  publishedDate: "2026-11-20T08:00:00.000Z",
  author: `作者 ${i}`,
  text: `全文 ${i}`,
  highlights: [`要点 ${i} 甲`, `要点 ${i} 乙`],
  ...over,
});
const answer = (results: unknown, over: Record<string, unknown> = {}) => ({
  requestId: "req-1",
  results,
  costDollars: { total: 0.013, search: { neural: 0.007 }, contents: { highlights: 0.006 } },
  ...over,
});

function harness(respond: (req: Request) => Response | Promise<Response>, at: { now: number } = { now: 1_000_000 }) {
  const asked: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
  const lines: Array<{ level: string; details: Record<string, unknown>; msg: string }> = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    asked.push({ url: String(url), init: init!, body: JSON.parse(String(init!.body)) });
    return respond(new Request(String(url), init));
  }) as typeof globalThis.fetch;
  const engine = exaEngine({
    baseUrl: "https://api.exa.test/",
    apiKey: "exa-test-not-real",
    type: "auto",
    timeoutMs: 15_000,
    maxResults: 6,
    clock: () => at.now,
    fetch,
    log: { info: (details, msg) => lines.push({ level: "info", details, msg }), warn: (details, msg) => lines.push({ level: "warn", details, msg }) },
  });
  return { engine, asked, lines, at };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const never = { signal: new AbortController().signal };

describe("the Exa engine", () => {
  it("one POST to /search with the key in x-api-key and exactly the documented body: query, type, numResults, highlights of 400, moderation", async () => {
    const { engine, asked } = harness(() => json(answer([result(1)])));
    await engine.searchWeb(QUERY, never);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.url).toBe("https://api.exa.test/search");
    expect(asked[0]!.init.method).toBe("POST");
    expect(asked[0]!.init.redirect).toBe("error");
    const headers = new Headers(asked[0]!.init.headers);
    expect(headers.get("x-api-key")).toBe("exa-test-not-real");
    expect(headers.get("content-type")).toBe("application/json");
    expect(asked[0]!.body).toEqual({ query: QUERY, type: "auto", numResults: 6, contents: { highlights: { maxCharacters: 400 } }, moderation: true });
    // The type is the configuration's.
    const fast = exaEngine({ baseUrl: "https://api.exa.test", apiKey: "k", type: "fast", timeoutMs: 15_000, maxResults: 3, fetch: async (_u, init) => { asked.push({ url: "", init: init!, body: JSON.parse(String(init!.body)) }); return json(answer([])); }, log: { info: () => {}, warn: () => {} } });
    await fast.searchWeb(QUERY, never);
    expect(asked[1]!.body).toMatchObject({ type: "fast", numResults: 3 });
  });

  it("the results: https only, each address once, never Exa's own; the highlights joined and cut; the published date as the page's age; author and text never read", async () => {
    const results = [
      result(1, { url: "http://plain.example.com/1" }),
      result(2, { title: `标题${String.fromCodePoint(0x202e)}见 https://evil.example/x @alice` }),
      result(3, { url: "https://u:p@creds.example.com/" }),
      result(4, { highlights: ["字".repeat(250), "词".repeat(250)] }),
      result(5, { publishedDate: "not a date" }),
      result(2, { title: "重复" }),
      result(6, { url: "https://exa.ai/search?q=x" }),
      result(7, { url: "https://docs.exa.ai/x" }),
      result(8, { highlights: undefined }),
      result(9, { highlights: "不是数组" }),
      result(10, { title: 12, highlights: [1, "可用", null] }),
      "not an object",
      result(11),
      result(12),
    ];
    const got = await harness(() => json(answer(results))).engine.searchWeb(QUERY, never);
    if (!("results" in got)) throw new Error("expected results");
    expect(got.results.map((r) => r.url)).toEqual([2, 4, 5, 8, 9, 10].map((i) => `https://news.example.com/${i}`));
    // Joined with " … ", then cleaned as every snippet is (NFKC: the ellipsis reads "...").
    expect(got.results[0]).toEqual({ url: "https://news.example.com/2", title: "标题见", snippet: "要点 2 甲 ... 要点 2 乙", age: "2026-11-20T08:00:00.000Z" });
    expect(Array.from(got.results[1]!.snippet).length).toBeLessThanOrEqual(300);
    expect(got.results[1]!.snippet.startsWith("字")).toBe(true);
    expect(got.results[2]!.age).toBeUndefined();
    expect(got.results[3]!.snippet).toBe("");
    expect(got.results[4]!.snippet).toBe("");
    expect(got.results[5]).toMatchObject({ title: "", snippet: "可用" });
    expect(JSON.stringify(got.results)).not.toMatch(/作者|全文/);
  });

  it("a huge array: only the first entries are read; with none usable among them, no results", async () => {
    const bad = Array.from({ length: EXA_RESULTS_READ }, (_, i) => result(i, { url: `http://plain.example.com/${i}` }));
    expect(await harness(() => json(answer([...bad, result(1000)]))).engine.searchWeb(QUERY, never)).toMatchObject({ error: "no_results" });
    expect(await harness(() => json(answer([]))).engine.searchWeb(QUERY, never)).toMatchObject({ error: "no_results" });
    expect(await harness(() => json(answer("nope"))).engine.searchWeb(QUERY, never)).toMatchObject({ error: "unavailable" });
    expect(await harness(() => json([1, 2])).engine.searchWeb(QUERY, never)).toEqual({ error: "unavailable" });
  });

  it("what a call cost: costDollars as a number or as an object with a total, in micro-USD; absent or odd, nothing said", async () => {
    expect([0.013, { total: 0.007 }, { total: "0.01" }, undefined, null, -1, Number.NaN, { search: 1 }, 5000].map(exaCostOf)).toEqual([13_000n, 7000n, null, null, null, null, null, null, null]);
    expect(await harness(() => json(answer([result(1)], { costDollars: 0.0081 }))).engine.searchWeb(QUERY, never)).toMatchObject({ costMicroUsd: 8100n });
    expect(await harness(() => json(answer([result(1)]))).engine.searchWeb(QUERY, never)).toMatchObject({ costMicroUsd: 13_000n });
    expect(await harness(() => json(answer([]))).engine.searchWeb(QUERY, never)).toEqual({ error: "no_results", costMicroUsd: 13_000n });
    const none = await harness(() => json(answer([result(1)], { costDollars: undefined }))).engine.searchWeb(QUERY, never);
    expect(none).not.toHaveProperty("costMicroUsd");
  });

  it("each error status by its kind (400, 401, 402, 403, 429, 500, 503); bad JSON, a body over 1 MB, a network failure: unavailable; never a throw", async () => {
    const kinds: Record<number, string> = { 400: "engine_failed", 401: "engine_refused", 402: "engine_refused", 403: "engine_refused", 429: "engine_busy", 500: "engine_failed", 503: "engine_busy" };
    for (const [status, kind] of Object.entries(kinds)) {
      expect(statusError(Number(status))).toBe(kind);
      expect(await harness(() => json({ error: `bad ${QUERY}` }, Number(status))).engine.searchWeb(QUERY, never)).toEqual({ error: kind });
    }
    expect(await harness(() => new Response("{not json", { status: 200 })).engine.searchWeb(QUERY, never)).toEqual({ error: "unavailable" });
    expect(await harness(() => new Response("x".repeat(RESPONSE_MAX_BYTES + 1), { status: 200 })).engine.searchWeb(QUERY, never)).toEqual({ error: "unavailable" });
    expect(
      await harness(() => {
        throw new TypeError("fetch failed");
      }).engine.searchWeb(QUERY, never),
    ).toEqual({ error: "unavailable" });
  });

  it("the site's key or account refused (402: out of credits): a metric line each time, one WARN an hour at most, naming the status only", async () => {
    const h = harness(() => json({ error: `no credits for ${QUERY}` }, 402));
    for (let i = 0; i < 3; i++) await h.engine.searchWeb(QUERY, never);
    const warns = () => h.lines.filter((l) => l.level === "warn");
    expect(warns()).toHaveLength(1);
    expect(warns()[0]!.details).toEqual({ metric: "web_engine_refused", engine: "exa_search", http: 402 });
    expect(h.lines.filter((l) => l.level === "info" && l.details.metric === "web_engine_refused")).toHaveLength(3);
    h.at.now += REFUSED_WARN_EVERY_MS - 1;
    await h.engine.searchWeb(QUERY, never);
    expect(warns()).toHaveLength(1);
    h.at.now += 1;
    await h.engine.searchWeb(QUERY, never);
    expect(warns()).toHaveLength(2);
    for (const line of h.lines.map((l) => JSON.stringify(l))) for (const secret of ["秘密", "exa search", "no credits", "exa-test"]) expect([secret, line.includes(secret)]).toEqual([secret, false]);
  });

  it("past its time limit: timeout; the run's signal aborting ends the call too", async () => {
    const hang = (_: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }));
    const opts = { baseUrl: "https://api.exa.test", apiKey: "k", type: "auto" as const, maxResults: 6, fetch: hang as typeof globalThis.fetch, log: { info: () => {}, warn: () => {} } };
    expect(await exaEngine({ ...opts, timeoutMs: 50 }).searchWeb(QUERY, never)).toEqual({ error: "timeout" });
    const stopped = new AbortController();
    const going = exaEngine({ ...opts, timeoutMs: 15_000 }).searchWeb(QUERY, { signal: stopped.signal });
    stopped.abort(new Error("stop"));
    expect(await going).toEqual({ error: "unavailable" });
  });

  it("logs the engine, the status class, the time and how many results — never the query, an address, a title, a highlight or a body", async () => {
    for (const respond of [() => json(answer([result(1), result(2)])), () => json({ error: `bad ${QUERY}` }, 400)]) {
      const { engine, lines } = harness(respond);
      await engine.searchWeb(QUERY, never);
      expect(lines).toHaveLength(1);
      const line = JSON.stringify(lines[0]);
      for (const secret of ["秘密", "exa search", "news.example.com", "标题", "要点", "exa-test", "bad "]) expect([secret, line.includes(secret)]).toEqual([secret, false]);
      expect(lines[0]!.details).toMatchObject({ metric: "web_search", engine: "exa_search", ms: expect.any(Number) });
    }
  });
});
