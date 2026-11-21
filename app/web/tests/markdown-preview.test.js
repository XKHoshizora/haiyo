// The chat list's one-line preview of an Agent's message (src/ui/markdownPreview.js): its Markdown markers are taken
// out by a small function over a bounded piece of the text — no Markdown library on the page's main thread.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PREVIEW_CHARS, PREVIEW_SOURCE_CHARS, previewOfMarkdown } from "../src/ui/markdownPreview.js";

describe("previewOfMarkdown", () => {
  it.each([
    ["a heading", "# 三日行程", "三日行程"],
    ["a deeper heading, closed", "### 小结 ###", "小结"],
    ["a quote", "> 引用的话\n> 第二行", "引用的话 第二行"],
    ["a nested quote and list", "> - 一\n> - 二", "一 二"],
    ["a list", "- 一\n* 二\n+ 三", "一 二 三"],
    ["an ordered list", "1. 一\n2) 二", "一 二"],
    ["a task list", "- [ ] 没做\n- [x] 做了", "没做 做了"],
    ["bold and italic", "**粗** 和 *斜* 和 __粗__ 和 _斜_", "粗 和 斜 和 粗 和 斜"],
    ["struck through", "~~不要~~ 要", "不要 要"],
    ["a code span", "运行 `npm test` 看看", "运行 npm test 看看"],
    ["a link", "看 [文档](https://example.com/a) 吧", "看 文档 吧"],
    ["a link with a title", '[文档](https://example.com/a "标题")', "文档"],
    ["an image", "![西湖风景](https://example.com/p.png)", "西湖风景"],
    ["a reference link", "见 [文档][1]\n\n[1]: https://example.com/a", "见 文档"],
    ["an autolink in angle brackets", "见 <https://example.com/a>", "见 https://example.com/a"],
    ["a fence: its first line of code", "```js\nconst a = 1;\nconst b = 2;\n```\n之后", "const a = 1; 之后"],
    ["a tilde fence", "~~~\nprint(1)\n~~~", "print(1)"],
    ["an empty fence: nothing", "之前\n\n```\n```\n之后", "之前 之后"],
    ["a fence still open at the end", "看：\n```python\nprint(1)\nprint(2)", "看： print(1)"],
    ["code is not stripped of its own characters", "```\na * b * c # 注释\n```", "a * b * c # 注释"],
    ["a thematic break", "上\n\n---\n\n下", "上 下"],
    ["a setext heading", "标题\n===\n正文", "标题 正文"],
    ["a table", "| 城市 | 天数 |\n| --- | :-: |\n| 杭州 | 2 |", "城市 天数 杭州 2"],
    ["display maths markers", "$$E = mc^2$$", "E = mc^2"],
    ["several lines become one", "第一行\n\n\n第二行  \n第三行", "第一行 第二行 第三行"],
    ["plain text stays", "好的，收到。", "好的，收到。"],
    ["a snake_case name keeps its underscores", "调用 get_user_name 即可", "调用 get_user_name 即可"],
    ["arithmetic keeps its stars inside words", "2*3 是 6", "2*3 是 6"],
    ["a hash that is not a heading", "C# 和 #标签", "C# 和 #标签"],
    ["a number that is not a list", "2024.5 是版本", "2024.5 是版本"],
    ["what looks like a citation is text (a reply's citations are beside its text, never in it)", "饺子馆在河边〔m1〕，菜单见〔f2·k7q2〕。", "饺子馆在河边〔m1〕，菜单见〔f2·k7q2〕。"],
  ])("%s", (_label, text, preview) => {
    expect(previewOfMarkdown(text)).toBe(preview);
  });

  it("only markers: the text as it was written, on one line", () => {
    expect(previewOfMarkdown("***")).toBe("***");
    expect(previewOfMarkdown("```\n```")).toBe("``` ```");
    expect(previewOfMarkdown("")).toBe("");
  });

  it("takes bidirectional controls out", () => {
    const rlo = String.fromCharCode(0x202e);
    expect(previewOfMarkdown(`**${rlo}倒过来**`)).toBe("倒过来");
  });

  it(`is at most ${PREVIEW_CHARS} characters, from the first ${PREVIEW_SOURCE_CHARS} of the text`, () => {
    const long = `# ${"长".repeat(5000)}`;
    expect(previewOfMarkdown(long)).toBe("长".repeat(PREVIEW_CHARS));
    expect(previewOfMarkdown(`${"\n".repeat(PREVIEW_SOURCE_CHARS)}# 远处`)).toBe("");
  });

  it("is quick on the texts the parser was slow on (it reads a bounded piece)", () => {
    const hostile = ["[".repeat(50000), "![](".repeat(12000), "*_~`".repeat(12000), "a\n=\n".repeat(12000), "> ".repeat(25000), `${"[a](".repeat(10000)}`, "<?".repeat(25000)];
    const started = performance.now();
    for (const text of hostile) for (let i = 0; i < 20; i += 1) previewOfMarkdown(text);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("imports nothing: no Markdown library reaches the main thread through it", () => {
    expect(readFileSync("src/ui/markdownPreview.js", "utf8")).not.toMatch(/^\s*import\s[^;]*from\s+["'](?!\.\/markdownRules\.js)/m);
  });
});
