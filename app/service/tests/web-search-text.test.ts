import { describe, expect, it } from "vitest";
import { cleanSnippet, cleanTitle, guardQuery, queryForm, withoutAddresses } from "../src/agents/tools/web/text.ts";
import { webUrlOf } from "../src/messages/lookups.ts";

/**
 * What the web search lets out and lets in (agents/tools/web/text.ts; lane websearch): the query's one normal form and
 * the structural guard run on it before anything leaves the service; what of a result's title and snippet the model is
 * shown (no address, no mention); which addresses may be stored and shown. Pure: no database.
 */

describe("the query's one form", () => {
  it("NFKC, case-folded, every run of white space one space, trimmed", () => {
    expect(queryForm("  ＤｅｅｐＳｅｅｋ   V4　发布 ")).toBe("deepseek v4 发布");
    expect(queryForm("x")).toBe(queryForm("x "));
    expect(queryForm("ABC​")).toBe("abc");
  });
});

describe("the query guard (before anything leaves the service)", () => {
  const note = "主人住在北京市海淀区中关村南大街五号，每周三去游泳";
  const ctx = (over: Partial<Parameters<typeof guardQuery>[1]> = {}) => ({ shown: [note], ownerSaid: null, names: [], ...over });
  const refused = (q: string, c = ctx()) => guardQuery(q, c) === "private";

  it("6 CJK characters in a row from a note this run was shown: refused; 5: not", () => {
    expect(refused("海淀区中关村南")).toBe(true);
    expect(refused("海淀区中关村")).toBe(true);
    expect(refused("海淀区中关")).toBe(false);
    expect(refused("中关村 天气")).toBe(false);
  });

  it("spaces put between the characters change nothing", () => {
    expect(refused("海 淀 区 中 关 村")).toBe(true);
  });

  it("3 Latin words in a row from a note: refused; 2: not; case, width and spacing aside", () => {
    const latin = ctx({ shown: ["Owner lives at 221B Baker Street London"] });
    expect(refused("221b baker street", latin)).toBe(true);
    expect(refused("２２１Ｂ  BAKER\tStreet", latin)).toBe(true);
    expect(refused("baker street", latin)).toBe(false);
    expect(refused("baker street museum hours", latin)).toBe(false);
  });

  it("hearsay is shown text too", () => {
    expect(refused("小王下个月要离职跳槽", ctx({ shown: ["听说小王下个月要离职跳槽去别家"] }))).toBe(true);
  });

  it("what the owner typed in their latest message is theirs to search, even when a note holds it — only that run of it", () => {
    const typed = "帮我查查海淀区中关村南大街附近的咖啡店";
    expect(refused("海淀区中关村南大街", ctx({ ownerSaid: typed }))).toBe(false);
    expect(refused("每周三去游泳馆", ctx({ ownerSaid: typed }))).toBe(true);
    expect(refused("海淀区中关村南大街 每周三去游泳", ctx({ ownerSaid: typed }))).toBe(true);
    expect(refused("周三去游泳池", ctx({ ownerSaid: "游泳" }))).toBe(false);
    expect(refused("每周三去游泳", ctx({ ownerSaid: "游泳" }))).toBe(true);
  });

  it("in a group: a member's or the owner's display name or handle (2 characters or more) refuses; one character does not", () => {
    const group = ctx({ names: ["李雷", "hanmeimei", "Q"] });
    expect(refused("李雷 公司 地址", group)).toBe(true);
    expect(refused("ＨａｎＭｅｉＭｅｉ instagram", group)).toBe(true);
    expect(refused("q3 财报", group)).toBe(false);
    expect(refused("北京天气", group)).toBe(false);
  });

  it("the query must be 2 to 120 characters once cleaned", () => {
    expect(guardQuery("a", ctx())).toBe("length");
    expect(guardQuery(" a ", ctx())).toBe("length");
    expect(guardQuery("ab", ctx())).toBe("ok");
    expect(guardQuery("字".repeat(120), ctx())).toBe("ok");
    expect(guardQuery("字".repeat(121), ctx())).toBe("length");
  });
});

describe("what a result shows the model", () => {
  it("every address and every mention is taken out of a title and a snippet", () => {
    const said = "详情见 https://evil.example/?d=1 或 www.evil.example/x 或 evil.com/path 或 mail me@evil.example，@alice 和 ＠bob 都在 github.com 上";
    const out = withoutAddresses(said);
    expect(out).not.toMatch(/https?:|www\.|evil|\.com|@|＠/);
    expect(out).toContain("详情见");
    expect(out).toContain("都在");
  });

  it("names that only look like a domain stay (Node.js, 3.5)", () => {
    expect(withoutAddresses("Node.js 3.5 发布")).toBe("Node.js 3.5 发布");
  });

  it("a title: one line, no bidirectional control, at most 200 characters (then an ellipsis)", () => {
    expect(cleanTitle("新闻\u202e标题\n第二行")).toBe("新闻标题 第二行");
    const long = cleanTitle("长".repeat(250));
    expect(Array.from(long)).toHaveLength(201);
    expect(long.endsWith("…")).toBe(true);
  });

  it("a snippet: cut to 300 characters", () => {
    expect(Array.from(cleanSnippet("字".repeat(400))).length).toBeLessThanOrEqual(301);
    expect(cleanSnippet("见 https://a.example/x 的说明")).toBe("见 的说明");
  });
});

describe("which address a web source may have", () => {
  it("https only, no credentials, no white space, at most 2048 characters; the punycode host in ASCII", () => {
    expect(webUrlOf("https://news.example.com/a?b=1")).toBe("https://news.example.com/a?b=1");
    expect(webUrlOf("http://news.example.com/")).toBeNull();
    expect(webUrlOf("javascript:alert(1)")).toBeNull();
    expect(webUrlOf("https://user:pw@news.example.com/")).toBeNull();
    expect(webUrlOf("https://user@news.example.com/")).toBeNull();
    expect(webUrlOf("https:///path")).toBeNull();
    expect(webUrlOf("https://a.example/ x")).toBeNull();
    const base = "https://a.example/";
    expect(webUrlOf(base + "x".repeat(2048 - base.length))).toBe(base + "x".repeat(2048 - base.length));
    expect(webUrlOf(base + "x".repeat(2049 - base.length))).toBeNull();
    expect(webUrlOf("https://bücher.example/")).toBe("https://xn--bcher-kva.example/");
  });
});
