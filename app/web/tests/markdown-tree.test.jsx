// @vitest-environment jsdom
// The main thread treats the worker's tree as untrusted data: it is checked against the allow-list in one iterative
// walk over a capped size before React sees any of it (src/ui/markdownTree.js). A hand-made hostile tree renders
// nothing of itself and cannot overflow the stack, however big or deep.
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { AgentText, loadMarkdown } from "../src/ui/AgentText.jsx";
import { RichTree } from "../src/ui/Markdown.jsx";
import { renderToTree } from "../src/ui/markdownPipeline.js";
import { TREE_ELEMENTS } from "../src/ui/markdownRules.js";
import { shownHost, validateTree } from "../src/ui/markdownTree.js";
import { SLOW_TEXT_NOTE } from "../src/ui/slowTexts.jsx";
import { SilentWorker, settle, useWorkers } from "./markdown-worker.js";

await loadMarkdown();

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const p = (...children) => ({ tag: "p", children });
/** A chain of `depth` nested elements, made without recursion. */
function deep(depth, tag = "span") {
  let node = "x";
  for (let i = 0; i < depth; i += 1) node = { tag, children: [node] };
  return [node];
}

describe("validateTree", () => {
  it("accepts what the pipeline makes, and counts what the page will have", () => {
    const { tree, elements } = renderToTree("# 标题\n\n**粗** [链接](https://a.example/)\n\n```js\nlet a = 1;\n```\n\n| a |\n|---|\n| 1 |\n\n$$x^2$$", { now: () => 0 });
    const checked = validateTree(structuredClone(tree));
    expect(checked.ok).toBe(true);
    expect(checked.elements).toBe(elements);
    // + the link's wrapper and host note, the code block's frame and 复制, the table's frame, and the `.md` root
    expect(checked.rendered).toBe(elements + 2 + 2 + 1 + 1);
  });

  it.each([
    ["a script element", [{ tag: "script", children: ["alert(1)"] }]],
    ["an iframe", [{ tag: "iframe", props: { src: "https://evil.example/" } }]],
    ["an img", [p({ tag: "img", props: { src: "https://evil.example/p.png" } })]],
    ["an event handler", [{ tag: "p", props: { onClick: "alert(1)" }, children: ["x"] }]],
    ["an onerror attribute string", [{ tag: "span", props: { onerror: "alert(1)" }, children: ["x"] }]],
    ["a javascript: href", [p({ tag: "a", props: { href: "javascript:alert(1)" }, children: ["x"] })]],
    ["a data: href", [p({ tag: "a", props: { href: "data:text/html,x" }, children: ["x"] })]],
    ["an href not in its normal form", [p({ tag: "a", props: { href: " https://a.example/" }, children: ["x"] })]],
    ["an href with a user name", [p({ tag: "a", props: { href: "https://bank.example@evil.example/" }, children: ["x"] })]],
    ["a link in a link", [p({ tag: "a", props: { href: "https://a.example/" }, children: [{ tag: "a", props: { href: "https://b.example/" }, children: ["x"] }] })]],
    ["an id", [{ tag: "h1", props: { id: "root" }, children: ["x"] }]],
    ["a name", [{ tag: "a", props: { href: "https://a.example/", name: "root" }, children: ["x"] }]],
    ["a style outside KaTeX", [{ tag: "p", props: { style: { color: "red" } }, children: ["x"] }]],
    ["innerHTML", [{ tag: "p", props: { dangerouslySetInnerHTML: { __html: "<img src=x onerror=alert(1)>" } } }]],
    ["an app class outside KaTeX", [{ tag: "p", props: { className: ["toast"] }, children: ["x"] }]],
    ["an app class inside KaTeX", [{ tag: "span", props: { className: ["katex"] }, children: [{ tag: "span", props: { className: ["bubble"] }, children: ["x"] }] }]],
    ["a fetching style inside KaTeX", [{ tag: "span", props: { className: ["katex"] }, children: [{ tag: "span", props: { style: { backgroundImage: "url(https://evil.example/)" } } }] }]],
    ["a url() value inside KaTeX", [{ tag: "span", props: { className: ["katex"] }, children: [{ tag: "span", props: { style: { color: "url(x)" } } }] }]],
    ["a fixed position inside KaTeX", [{ tag: "span", props: { className: ["katex"] }, children: [{ tag: "span", props: { style: { position: "fixed" } } }] }]],
    ["a link inside KaTeX", [{ tag: "span", props: { className: ["katex"] }, children: [{ tag: "a", props: { href: "https://a.example/" } }] }]],
    ["an href on a KaTeX element", [{ tag: "span", props: { className: ["katex"] }, children: [{ tag: "svg", props: { href: "https://a.example/" } }] }]],
    ["a foreignObject in KaTeX's svg", [{ tag: "span", props: { className: ["katex"] }, children: [{ tag: "svg", children: [{ tag: "foreignObject", children: ["x"] }] }] }]],
    ["a key it does not know", [{ tag: "p", children: ["x"], ref: "x" }]],
    ["an own __proto__ prop", JSON.parse('[{"tag":"p","props":{"__proto__":{"onClick":"x"}},"children":["x"]}]')],
    ["a non-plain object", [Object.assign(Object.create({ tag: "p" }), { children: ["x"] })]],
    ["a number for a text", [p(42)]],
    ["an empty children list", [{ tag: "p", children: [] }]],
    ["start that is not an integer", [{ tag: "ol", props: { start: "1; x" }, children: [{ tag: "li", children: ["x"] }] }]],
    ["an alignment it does not know", [{ tag: "td", props: { align: "justify" }, children: ["x"] }]],
    ["not a list", { tag: "p", children: ["x"] }],
  ])("refuses %s", (_, tree) => {
    expect(validateTree(tree).ok).toBe(false);
  });

  it(`refuses more than ${TREE_ELEMENTS} elements and 100 000 nodes, quickly`, () => {
    const many = Array.from({ length: 100000 }, () => ({ tag: "br" }));
    const started = performance.now();
    expect(validateTree(many).ok).toBe(false);
    expect(validateTree(Array.from({ length: TREE_ELEMENTS + 1 }, () => ({ tag: "br" }))).ok).toBe(false);
    expect(validateTree(Array.from({ length: TREE_ELEMENTS }, () => ({ tag: "br" }))).ok).toBe(true);
    expect(validateTree([{ tag: "p", children: Array.from({ length: 100000 }, () => "x") }]).ok).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("counts an element's props, a style's declarations and a node's keys before reading any of them", () => {
    let reads = 0;
    const counted = (n, value) => {
      const object = {};
      for (let i = 0; i < n; i += 1) {
        Object.defineProperty(object, `k${i}`, {
          enumerable: true,
          get() {
            reads += 1;
            return value;
          },
        });
      }
      return object;
    };
    expect(validateTree([{ tag: "span", props: counted(51, "x"), children: ["x"] }]).ok).toBe(false);
    expect(validateTree([{ tag: "span", props: { className: ["katex"], style: counted(21, "1em") } }]).ok).toBe(false);
    expect(validateTree([Object.assign(counted(4, "x"), { tag: "p" })]).ok).toBe(false);
    expect(reads).toBe(0);
    const many = [{ tag: "p", props: Object.fromEntries(Array.from({ length: 200000 }, (_, i) => [`k${i}`, "x"])) }];
    expect(validateTree(many).ok).toBe(false);
  });

  it("refuses a tree 10 000 deep without overflowing the stack; 60 deep is fine, 61 is not", () => {
    expect(validateTree(deep(10000)).ok).toBe(false);
    expect(validateTree(deep(60)).ok).toBe(true);
    expect(validateTree(deep(61)).ok).toBe(false);
  });
});

describe("a hostile tree from the worker, on the page", () => {
  /** Shows a text whose worker answers with `tree` (as delivered, no structured clone: it may be too deep for one). */
  async function shownWith(tree) {
    const workers = [];
    useWorkers(() => workers[workers.push(new SilentWorker()) - 1]);
    const { container } = render(
      <div className="bubble">
        <AgentText text="无害的文字" />
      </div>,
    );
    await settle();
    workers[0].onmessage?.({ data: { id: workers[0].sent[0].id, tree, elements: 1 } });
    await settle();
    return container;
  }

  it.each([
    ["a script, a handler and a javascript: link", [{ tag: "script", children: ["window.__xss=1"] }, p({ tag: "a", props: { href: "javascript:alert(1)", onClick: "x" }, children: ["点"] })]],
    ["100 000 nodes", Array.from({ length: 100000 }, () => ({ tag: "span", children: ["x"] }))],
    ["a tree 10 000 deep", deep(10000)],
  ])("%s: none of it is rendered; the text is plain with the note", async (_, tree) => {
    const container = await shownWith(tree);
    expect(container.querySelector(".md, script, a, span:not(.md-note)")).toBeNull();
    expect(container.textContent).toBe(`无害的文字${SLOW_TEXT_NOTE}`);
  });
});

describe("RichTree", () => {
  it("renders a checked tree with the app's parts, cell alignment as a style, KaTeX's styles as they were checked", () => {
    const tree = [
      p("看 ", { tag: "a", props: { href: "https://docs.example/a" }, children: ["文档"] }),
      { tag: "table", children: [{ tag: "tbody", children: [{ tag: "tr", children: [{ tag: "td", props: { align: "right" }, children: ["1"] }] }] }] },
      { tag: "span", props: { className: ["katex"] }, children: [{ tag: "span", props: { className: ["mord"], style: { height: "1em", verticalAlign: "-0.2em" } }, children: ["x"] }] },
    ];
    expect(validateTree(tree).ok).toBe(true);
    const { container } = render(<RichTree tree={tree} />);
    expect(container.querySelector(".md > p > .md-link > a").getAttribute("title")).toBe("https://docs.example/a");
    expect(container.querySelector(".md-host").textContent).toBe("(docs.example)");
    expect(container.querySelector(".md-table td").getAttribute("style")).toBe("text-align: right;");
    expect(container.querySelector(".katex .mord").getAttribute("style")).toBe("height: 1em; vertical-align: -0.2em;");
  });
});

describe("shownHost", () => {
  it("a host over 40 characters keeps its last 39", () => {
    const host = `${"a".repeat(50)}.example`;
    expect(shownHost(`https://${host}/`)).toBe(`…${host.slice(-39)}`);
    expect(shownHost("https://www.short.example/")).toBe("short.example");
  });
});
