// @vitest-environment jsdom
// Where a link goes is always shown. Every link is followed by its real host (taken from the parsed target only), with
// no exception: not even a link whose text is exactly its address (two such links glued together read as one trusted
// address). Nothing is compared, normalised, decoded or detected, so nothing can be forged: the third review's
// forgeries (hostile-links.js LINK_CASES), the fourth's (R4_LINK_CASES) and the fifth's glued links. A link's content is one plain text (no maths, no element, no line
// break, at most 200 characters), and bidirectional controls are gone from everything shown, however they were written.
import "./markdown-ready.js";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { AgentText } from "../src/pages/AgentChatBits.jsx";
import { RichTree } from "../src/ui/Markdown.jsx";
import { renderToTree } from "../src/ui/markdownPipeline.js";
import { shownHost, validateTree } from "../src/ui/markdownTree.js";
import { SLOW_TEXT_NOTE } from "../src/ui/slowTexts.jsx";
import { LINK_CASES, R4_LINK_CASES, R5_LINK_CASES } from "./hostile-links.js";
import { SilentWorker, settle, useWorkers } from "./markdown-worker.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useWorkers();
});

const BIDI = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/;
const RLO = "\u202E";

async function show(text) {
  const { container } = render(
    <div className="bubble">
      <AgentText text={text} />
    </div>,
  );
  await settle();
  return container.firstChild;
}

/** Every `a` of a tree, and every string in it (texts and prop values). */
function partsOf(tree) {
  const links = [];
  const strings = [];
  const stack = [...tree];
  while (stack.length > 0) {
    const node = stack.pop();
    if (typeof node === "string") {
      strings.push(node);
      continue;
    }
    if (node.tag === "a") links.push(node);
    for (const value of Object.values(node.props ?? {})) strings.push(...[value].flat().filter((v) => typeof v === "string"));
    stack.push(...(node.children ?? []));
  }
  return { links, strings };
}

describe("every link shows its real host, whatever its text says", () => {
  it.each([...LINK_CASES, ...R4_LINK_CASES, ...R5_LINK_CASES])("%s", async (label, text) => {
    const errors = vi.spyOn(console, "error");
    const bubble = await show(text);
    const links = [...bubble.querySelectorAll("a")];
    expect(links.length).toBeGreaterThan(0);
    for (const a of links) {
      const href = a.getAttribute("href");
      const host = a.nextElementSibling?.matches(".md-host") ? a.nextElementSibling.textContent : null;
      // (The review's 1 (i), its override gone, shows exactly the address it opens: it has its note like any link.)
      if (label.startsWith("(i) a bidi override as a character reference")) expect(a.textContent).toBe(href);
      expect(host, `${a.textContent} → ${href}`).toBe(`(${shownHost(href)})`);
      // The host shown is the parsed target's, Punycode, never more than 40 characters.
      expect(host.length).toBeLessThanOrEqual(42);
      expect(a.getAttribute("title")).toBe(href);
      expect(a.closest(".md-link").getAttribute("dir")).toBe("auto");
      // The link's content is one plain text on one line: no element, no line break, no run of spaces.
      expect(a.children).toHaveLength(0);
      expect(a.textContent).not.toMatch(/[\n\r\t\u00A0\u2003\u2028\u2029]| {2}/);
    }
    expect(bubble.textContent).not.toMatch(BIDI);
    expect(bubble.innerHTML).not.toMatch(BIDI);
    expect(errors).not.toHaveBeenCalled();
  });

  it("the homograph cases show the target's Punycode host", async () => {
    const bubble = await show("[bank.example](https://bаnk.example/) https://аррlе.com/login");
    const punycode = ["https://bаnk.example/", "https://аррlе.com/"].map((url) => new URL(url).host);
    expect(punycode.every((host) => host.startsWith("xn--"))).toBe(true);
    expect([...bubble.querySelectorAll(".md-host")].map((el) => el.textContent)).toEqual(punycode.map((host) => `(${host})`));
  });

  it("a long target host shows its end, where its registrable part is", async () => {
    const host = "bank.example.secure-login.account-verify.session-0123456789.evil.example";
    const bubble = await show(`[bank.example](https://${host}/)`);
    expect(bubble.querySelector(".md-host").textContent).toBe(`(…${host.slice(-39)})`);
    expect(host.slice(-39)).toMatch(/evil\.example$/);
  });
});

describe("no exception: a link whose text is exactly its address has its host after it too", () => {
  it.each([
    ["a bare autolink", "看 https://example.com/a/b?c=1#d 吧", "https://example.com/a/b?c=1#d"],
    ["the address without its final slash", "[https://example.com](https://example.com/)", "https://example.com"],
    ["the address itself", "[https://example.com/a](https://example.com/a)", "https://example.com/a"],
    ["the host alone", "[example.com](https://example.com)", "example.com"],
    ["a text in another script", "[文档](https://example.com/a)", "文档"],
    ["www. before the host", "[www.example.com](https://example.com/a)", "www.example.com"],
    ["an autolink the browser writes differently", "http://EXAMPLE.com/a", "http://EXAMPLE.com/a"],
  ])("%s", async (_label, text, shown) => {
    const bubble = await show(text);
    expect(bubble.querySelector("a").textContent).toBe(shown);
    expect(bubble.querySelector(".md-host").textContent).toBe("(example.com)");
  });

  it("two exact links glued together: each is followed by its own host, so the run cannot read as one address", async () => {
    const bubble = await show("https://accounts.google.com/signin?continue=<https://evil.example/>");
    expect(bubble.textContent).toBe("https://accounts.google.com/signin?continue= (accounts.google.com)https://evil.example/ (evil.example)");
    expect([...bubble.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(["https://accounts.google.com/signin?continue=", "https://evil.example/"]);
  });

  it("plain text or a code span directly in front of an exact link: the link's host follows it", async () => {
    const plain = await show("accounts.google.com/signin?continue=https://evil.example/");
    expect(plain.textContent).toBe("accounts.google.com/signin?continue=https://evil.example/ (evil.example)");
    cleanup();
    const code = await show("`https://accounts.google.com/`https://evil.example/");
    expect(code.textContent).toBe("https://accounts.google.com/https://evil.example/ (evil.example)");
    expect(code.querySelectorAll("a")).toHaveLength(1);
  });
});

describe("a link's content is one plain text", () => {
  it("emphasis and code give their text, a formula its source, an image its alt text; nothing is typeset inside a link", () => {
    const { tree } = renderToTree("[**粗** `码` *斜* $$x^2$$ ![图](https://img.example/a.png) 完](https://a.example/)", { now: () => 0 });
    const { links } = partsOf(tree);
    expect(links).toHaveLength(1);
    expect(links[0].children).toEqual(["粗 码 斜 x^2 图 完"]);
    expect(JSON.stringify(tree)).not.toContain("katex");
  });

  it("every run of white space and separators is one space; the ends are trimmed", () => {
    const text = `[ \u00A0一\u00A0\u00A0二\u2028三\u2029四\u3000\t五\\\n六\n七 ](https://a.example/)`;
    expect(partsOf(renderToTree(text).tree).links[0].children).toEqual(["一 二 三 四 五 六 七"]);
  });

  it("a text of 5 000 characters is cut at 200, with an ellipsis; its host is shown", async () => {
    const long = `https://a.example/${"长".repeat(5000)}`;
    for (const text of [long, `[${"字".repeat(5000)}](https://a.example/)`]) {
      const { tree } = renderToTree(text);
      const [a] = partsOf(tree).links;
      expect(a.children).toHaveLength(1);
      expect([...a.children[0]]).toHaveLength(201);
      expect(a.children[0].endsWith("…")).toBe(true);
    }
    const bubble = await show(long);
    expect([...bubble.querySelector("a").textContent]).toHaveLength(201);
    expect(bubble.querySelector(".md-host").textContent).toBe("(a.example)");
  });

  it("a text that shows nothing is the address itself", () => {
    for (const text of ["[\u200B](https://a.example/x)", "[&#x202E;](https://a.example/x)", "[&#32;](https://a.example/x)"]) {
      expect(partsOf(renderToTree(text).tree).links[0].children, text).toEqual(["https://a.example/x"]);
    }
  });

  it("a link with no safe address is its text, and maths in it is not typeset either", () => {
    const { tree } = renderToTree("[点 $$x^2$$](javascript:alert(1))");
    expect(partsOf(tree).links).toHaveLength(0);
    expect(JSON.stringify(tree)).not.toContain("katex");
  });
});

describe("bidirectional controls are removed from what is shown, not only from the source", () => {
  it.each([
    ["in a paragraph", "abc &#x202E;def"],
    ["decimal, in a heading", "# 标题 &#8238;题标"],
    ["in code", "`a &#x202E; b`\n\n```\n&#x202E;\u2067x\n```"],
    ["in a table", "| a&#x202E; |\n|---|\n| &#x2066;b |"],
    ["in maths", '$$a\\char"202E b\\text{\\char"2067 c}$$'],
    ["every one of them", "x&#x202A;&#x202B;&#x202C;&#x202D;&#x202E;&#x2066;&#x2067;&#x2068;&#x2069;&#x200E;&#x200F;&#x061C;y"],
  ])("%s", async (_label, text) => {
    const { tree } = renderToTree(text, { now: () => 0 });
    for (const string of partsOf(tree).strings) expect(string).not.toMatch(BIDI);
    const bubble = await show(text);
    expect(bubble.querySelector(".md")).not.toBeNull();
    expect(bubble.innerHTML).not.toMatch(BIDI);
  });

  it("a character reference in a text shown plain stays the characters that were written", async () => {
    useWorkers(() => {
      throw new Error("no worker");
    });
    const bubble = await show(`abc &#x202E;def ${RLO}ghi`);
    expect(bubble.textContent).toBe("abc &#x202E;def ghi");
  });
});

describe("the main thread's check of a link", () => {
  const a = (...children) => [{ tag: "p", children: [{ tag: "a", props: { href: "https://a.example/" }, children }] }];

  it.each([
    ["a nested element", a({ tag: "strong", children: ["x"] })],
    ["a text and an element", a("x", { tag: "br" })],
    ["KaTeX's output", a({ tag: "span", props: { className: ["katex"] }, children: ["x"] })],
    ["two texts", a("x", "y")],
    ["no content", [{ tag: "p", children: [{ tag: "a", props: { href: "https://a.example/" } }] }]],
  ])("refuses an `a` holding %s", (_label, tree) => {
    expect(validateTree(tree).ok).toBe(false);
  });

  it("accepts an `a` holding one text", () => {
    expect(validateTree(a("x")).ok).toBe(true);
  });

  it("cleans a bidirectional control out of any string it is given: texts, a link's text, KaTeX's props", () => {
    const tree = [
      `a${RLO}b`,
      { tag: "p", children: [`c\u2066d`, { tag: "a", props: { href: "https://evil.example/moc.elgoog" }, children: [`https://${RLO}evil.example/moc.elgoog`] }] },
      { tag: "span", props: { className: ["katex"] }, children: [{ tag: "svg", props: { width: `1${RLO}em` }, children: [{ tag: "path", props: { d: "M0 0\u200F" } }] }] },
    ];
    const checked = validateTree(tree);
    expect(checked.ok).toBe(true);
    for (const string of partsOf(tree).strings) expect(string).not.toMatch(BIDI);
    const { container } = render(<RichTree tree={tree} />);
    expect(container.innerHTML).not.toMatch(BIDI);
    expect(container.querySelector("a").textContent).toBe("https://evil.example/moc.elgoog");
    expect(container.querySelector(".md-host").textContent).toBe("(evil.example)");
  });

  it("repeats the worker's rule on a link's text: separators collapsed, trimmed, cut at 200 characters", () => {
    const nbsp = String.fromCharCode(0xa0);
    const wide = String.fromCharCode(0x2003);
    const lineSeparator = String.fromCharCode(0x2028);
    const spaced = a(` https://accounts.google.com${nbsp.repeat(300)}${wide}${lineSeparator}\n\t.evil.example/ `);
    expect(validateTree(spaced).ok).toBe(true);
    expect(spaced[0].children[0].children).toEqual(["https://accounts.google.com .evil.example/"]);
    const long = a(`https://accounts.google.com/${"长".repeat(5000)}`);
    expect(validateTree(long).ok).toBe(true);
    expect([...long[0].children[0].children[0]]).toHaveLength(201);
    expect(long[0].children[0].children[0].endsWith("…")).toBe(true);
    const exact = a("字".repeat(200));
    expect(validateTree(exact).ok).toBe(true);
    expect(exact[0].children[0].children).toEqual(["字".repeat(200)]);
    // Shown the same way even from a tree that was never checked.
    const { container } = render(<RichTree tree={a(`甲${nbsp.repeat(300)}乙${"丙".repeat(400)}`)} />);
    expect(container.querySelector("a").textContent).toBe(`甲 乙${"丙".repeat(197)}…`);
    expect(container.querySelector(".md-host").textContent).toBe("(a.example)");
  });

  it("a worker's tree with a link holding elements is shown plain with the note, none of it rendered", async () => {
    const workers = [];
    useWorkers(() => workers[workers.push(new SilentWorker()) - 1]);
    const { container } = render(<AgentText text="看似无害" />);
    await settle();
    workers[0].emit({ id: workers[0].sent[0].id, tree: a("https://google.com", { tag: "br" }, ".evil.example"), elements: 3 });
    await settle();
    expect(container.querySelector("a, .md")).toBeNull();
    expect(container.textContent).toBe(`看似无害${SLOW_TEXT_NOTE}`);
  });
});
