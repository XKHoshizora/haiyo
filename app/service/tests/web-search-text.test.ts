import { describe, expect, it } from "vitest";
import { cleanSnippet, cleanTitle, guardQuery, queryForm, withoutAddresses } from "../src/agents/tools/web/text.ts";
import { webSourcesOf, webTitleOf, webUrlOf } from "../src/messages/lookups.ts";

/** A right-to-left override, written as a code point (the source holds no bidi control: source-bidi.test.ts). */
const RLO = String.fromCodePoint(0x202e);

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

  it("one comparison form for every rule: white space, punctuation, symbols, zero-width and bidi characters do not split a run or a name", () => {
    const ZWJ = String.fromCodePoint(0x200d);
    const ZWSP = String.fromCodePoint(0x200b);
    const LRI = String.fromCodePoint(0x2066);
    const people = ctx({ names: ["李雷", "guardb_mia", `韩${ZWJ}梅梅`] });
    const table: Array<[string, string, Parameters<typeof guardQuery>[1], boolean]> = [
      ["a spaced name", "李 雷 公司", people, true],
      ["a name with a comma", "李，雷 公司", people, true],
      ["a name with a middle dot", "李·雷", people, true],
      ["a handle spaced instead of its underscore", "guardb mia instagram", people, true],
      ["a zero-width joiner inside the stored name", "韩梅梅 电话", people, true],
      ["a zero-width space inside the query's name", `李${ZWSP}雷`, people, true],
      ["a bidi isolate inside the query's name", `李${LRI}雷`, people, true],
      ["a note with ，、· between its characters", "北京四中读初二", ctx({ shown: ["孩子在北，京、四·中读初二"] }), true],
      ["a query with punctuation the note has not", "北京，四中、读·初二", ctx({ shown: ["孩子在北京四中读初二"] }), true],
      ["a katakana word whose long vowels are Common (Script_Extensions)", "スーパーマーケット", ctx({ shown: ["近くのスーパーマーケットで買った"] }), true],
      ["5 CJK characters across punctuation stay too few", "北，京四中读", ctx({ shown: ["在北京四中读书"] }), false],
    ];
    for (const [label, query, c, want] of table) expect([label, refused(query, c)]).toEqual([label, want]);
  });

  it("7 digits in a row shared with a note (a phone, an ID, a card number) are a match, whatever separates them; 6 are not; the owner's own number is theirs", () => {
    const phone = ctx({ shown: ["主人的电话是 138-1234-5678"] });
    const bare = ctx({ shown: ["主人的电话是13812345678"] });
    const table: Array<[string, string, Parameters<typeof guardQuery>[1], boolean]> = [
      ["no separators in the query", "13812345678 归属地", phone, true],
      ["separators in the query, none in the note", "138 1234 5678", bare, true],
      ["full-width digits", "１３８１２３４５６７８", bare, true],
      ["7 of them", "电话 2345678", bare, true],
      ["6 of them", "电话 234567", bare, false],
      ["the owner typed it", "13812345678 归属地", ctx({ shown: ["主人的电话是13812345678"], ownerSaid: "查查13812345678是哪里的号码" }), false],
    ];
    for (const [label, query, c, want] of table) expect([label, refused(query, c)]).toEqual([label, want]);
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

  it("a title: one line, no bidirectional control, at most 200 characters, the ellipsis among them (one length rule, write and read)", () => {
    expect(cleanTitle(`新闻${RLO}标题\n第二行`)).toBe("新闻标题 第二行");
    for (const n of [199, 200]) expect(cleanTitle("长".repeat(n))).toBe("长".repeat(n));
    for (const n of [201, 400]) {
      const long = cleanTitle("长".repeat(n));
      expect(Array.from(long)).toHaveLength(200);
      expect(long).toBe(`${"长".repeat(199)}…`);
    }
    // A surrogate pair where the cut falls is kept whole, never split.
    const astral = cleanTitle(`${"长".repeat(198)}😀😀${"长".repeat(10)}`);
    expect(Array.from(astral)).toHaveLength(200);
    expect(astral).toBe(`${"长".repeat(198)}😀…`);
    // The read path cuts by the same rule: what was written is read back as it is, a longer stored title is cut, never dropped.
    expect(webTitleOf(astral)).toBe(astral);
    expect(webTitleOf("长".repeat(250))).toBe(cleanTitle("长".repeat(250)));
    const read = webSourcesOf([{ n: 1, url: "https://news.example.com/a", title: "长".repeat(400) }]);
    expect(read).toEqual([{ n: 1, url: "https://news.example.com/a", title: `${"长".repeat(199)}…` }]);
  });

  it("a snippet: at most 300 characters, the ellipsis among them", () => {
    expect(Array.from(cleanSnippet("字".repeat(400)))).toHaveLength(300);
    expect(cleanSnippet("字".repeat(300))).toBe("字".repeat(300));
    expect(cleanSnippet("见 https://a.example/x 的说明")).toBe("见 的说明");
  });

  it("full-width and look-alike dots do not hide an address; more top-level domains are read as one", () => {
    for (const said of ["见 ｅｖｉｌ．ｃｏｍ 吧", "见 https：//evil.example/x 吧", "见 evil。com 吧", "见 evil[.]com 吧", "见 evil.click 吧", "见 evil.lol/x 吧"]) {
      expect([said, withoutAddresses(said)]).toEqual([said, "见 吧"]);
    }
    expect(withoutAddresses("Node.js 3.5 发布。下一句")).toBe("Node.js 3.5 发布。下一句");
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
