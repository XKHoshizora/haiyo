// An Agent's rendered text, shown: its own chunk (with KaTeX's stylesheet and fonts), loaded the first time an Agent's
// text has a tree to show (AgentChatBits.jsx). The tree was made by the Markdown worker (markdownPipeline.js) and has
// been checked on this thread (markdownTree.js) before it gets here; this only turns it into React elements — a walk
// as deep as the tree, which is at most TREE_DEPTH — with the app's own parts:
//   - every link opens a new tab, with rel="noopener noreferrer nofollow", its real address as its tooltip, and its real
//     host after its text (always: also when the text is that address), both isolated from the text around them;
//   - a code block has 复制, a table scrolls sideways inside the bubble.
import React, { createElement, memo, useContext, useEffect, useRef, useState } from "react";
import { Cite, CitesContext } from "./cites.jsx";
import { linkTextShown, safeHref, withoutBidiControls } from "./markdownRules.js";
import { mentionParts, withoutMarks } from "./mentionMarks.js";
import { MentionTag } from "./MentionText.jsx";
import { shownHost } from "./markdownTree.js";
import "katex/dist/katex.min.css";

/**
 * A link: its text (one plain text, by the tree's check; put on one short line once more here), then where it really
 * goes, always: one space and the real host in ASCII brackets, `文档 (docs.example)` — no mark of any one language (the
 * text is trimmed, so the space is the only one). The link, the space and the note are one isolated wrapper. Without a
 * safe address it is its text alone.
 */
function Link({ href, text, plain = false }) {
  const safe = safeHref(href);
  const cleaned = linkTextShown(withoutMarks(text));
  if (!safe) return cleaned;
  const host = (
    <span className="md-host" dir="auto">
      ({withoutBidiControls(shownHost(safe))})
    </span>
  );
  // A reply whose run searched the web: its text and real host as plain text, nothing to open (its sources list is).
  if (plain) {
    return (
      <span className="md-link md-link-plain" dir="auto">
        {cleaned || safe} {host}
      </span>
    );
  }
  return (
    <span className="md-link" dir="auto">
      <a href={safe} title={safe} target="_blank" rel="noopener noreferrer nofollow" dir="auto">
        {cleaned || safe}
      </a>{" "}
      {host}
    </span>
  );
}

/** A table scrolls sideways inside the bubble. */
function Table({ children }) {
  return (
    <div className="md-table">
      <table>{children}</table>
    </div>
  );
}

/** A code block: scrolls sideways inside the bubble, with 复制 (a refused clipboard fails quietly). */
function CodeBlock({ children }) {
  const pre = useRef(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(pre.current?.textContent ?? "");
      setCopied(true);
    } catch {
      /* no clipboard here, or refused: nothing to say */
    }
  };
  return (
    <div className="md-code">
      <pre ref={pre}>{children}</pre>
      <button type="button" className="btn btn-sm md-copy" onClick={copy}>
        {copied ? "已复制" : "复制"}
      </button>
    </div>
  );
}

/** A link's text: its one child (anything else the check has refused; shown as nothing here). */
const linkText = (node) => (node.children?.length === 1 && typeof node.children[0] === "string" ? node.children[0] : "");
const isKatexRoot = (node) => node.tag === "span" && (node.props?.className ?? []).some((name) => name === "katex" || name === "katex-display" || name === "katex-error");

/**
 * A text of the tree: its mentions (between the marks the text was sent with, mentionMarks.js) as tags meaning the id of
 * their index in `ids`, and its citations' marks as the links of their index in `cites.list` (cites.jsx, jumping by
 * `cites.onJump`); inside code or maths (`plain`) the marks are only taken out — a mention there is plain text, and a
 * citation there is not shown.
 */
const texts = (text, plain, ids, cites, key) =>
  plain
    ? [withoutMarks(text)]
    : mentionParts(text).flatMap((part, j) => {
        if (typeof part === "string") return [part];
        if (part.cite === undefined) return [createElement(MentionTag, { text: part.text, id: ids[part.index] ?? null })];
        const cite = cites?.list[part.cite];
        return cite ? [createElement(Cite, { key: `${key}-${j}`, cite, onJump: cites.onJump })] : [];
      });

/**
 * One checked element as React's: the app's parts for links, code blocks and tables; classes joined; a cell's alignment;
 * in its text (not in code or a formula) its mentions as tags and what the message cites as links.
 */
function toElement(node, katex, ids, code = false, cites = null, plainLinks = false) {
  const inKatex = katex || isKatexRoot(node);
  const inCode = code || node.tag === "code" || node.tag === "pre";
  const { className, align, ...rest } = node.props ?? {};
  if (!inKatex && node.tag === "a") return createElement(Link, { href: rest.href, text: linkText(node), plain: plainLinks });
  const children = (node.children ?? []).flatMap((child, i) =>
    typeof child === "string" ? texts(child, inKatex || inCode, ids, cites, `c${i}`) : [toElement(child, inKatex, ids, inCode, cites, plainLinks)],
  );
  if (!inKatex && node.tag === "pre") return createElement(CodeBlock, null, ...children);
  if (!inKatex && node.tag === "table") return createElement(Table, null, ...children);
  const props = { ...rest };
  if (className) props.className = className.join(" ");
  if (align) props.style = { textAlign: align };
  if (rest.style) props.style = { ...rest.style };
  return createElement(node.tag, props, ...children);
}

/**
 * A checked tree (markdownTree.js `validateTree`), shown; made again only when the tree, or what its message cites,
 * changes. `mentionIds`: who each marked mention means, by its index; `citeList`: each marked citation, by its index
 * (numbered, cites.jsx `numberedCites`), whose links jump as the message's `CitesContext` says.
 */
export const RichTree = memo(function RichTree({ tree, mentionIds = [], citeList = [] }) {
  const value = useContext(CitesContext);
  const cites = citeList.length > 0 ? { list: citeList, onJump: value?.onJump ?? null } : null;
  // A reply whose run searched the web (`CitesContext.plainLinks`): no link of its text opens anything.
  const plainLinks = value?.plainLinks === true;
  return createElement(
    "div",
    { className: "md" },
    ...tree.flatMap((node, i) => (typeof node === "string" ? texts(node, false, mentionIds, cites, `c${i}`) : [toElement(node, false, mentionIds, false, cites, plainLinks)])),
  );
});
