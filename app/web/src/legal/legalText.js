// The text files of the terms, the privacy policy and the contact page (./texts/) as the page shows them. They are plain text a
// person edits, in a small part of Markdown, one paragraph per line:
//   # Title          (the first one is the page's one title)
//   ## Part, ### Small part
//   - an item        (lines in a row make one list)
//   any other line   (a paragraph; a blank line only separates)
// Inside a line: **bold**, [text](address) (an https address, a mailto: or a path of this site; any other is shown as its
// text), an e-mail address (a mail link), and {{…}} (the owner's blank to fill in, marked on the page). Nothing else is read.

const INLINE = /\*\*(.+?)\*\*|\[([^\]]+)\]\(([^)\s]+)\)|\{\{(.+?)\}\}|([A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;

/** An address a link of these pages may go to. */
const safeHref = (href) => /^https:\/\/[^\s]+$/.test(href) || /^mailto:[^\s]+$/.test(href) || /^\/(?![/\\])[^\s]*$/.test(href);

/** A line's text as parts: `{type: "text" | "strong" | "todo", text}` and `{type: "link", text, href}`. */
export function inlineParts(line) {
  const parts = [];
  let at = 0;
  for (const m of line.matchAll(INLINE)) {
    if (m.index > at) parts.push({ type: "text", text: line.slice(at, m.index) });
    if (m[1] !== undefined) parts.push({ type: "strong", text: m[1] });
    else if (m[2] !== undefined) parts.push(safeHref(m[3]) ? { type: "link", text: m[2], href: m[3] } : { type: "text", text: m[2] });
    else if (m[4] !== undefined) parts.push({ type: "todo", text: m[4] });
    else parts.push({ type: "link", text: m[5], href: `mailto:${m[5]}` });
    at = m.index + m[0].length;
  }
  if (at < line.length) parts.push({ type: "text", text: line.slice(at) });
  return parts;
}

/**
 * `{title, blocks}`: the first `# ` line's text, and every other line as `{type: "h2" | "h3" | "p", parts}` or, for items
 * in a row, `{type: "ul", items: [parts]}`.
 */
export function parseLegal(text) {
  let title = "";
  const blocks = [];
  let list = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("- ")) {
      if (!list) blocks.push((list = { type: "ul", items: [] }));
      list.items.push(inlineParts(line.slice(2).trim()));
      continue;
    }
    list = null;
    if (!line) continue;
    if (line.startsWith("# ") && !title) title = line.slice(2).trim();
    else if (line.startsWith("### ")) blocks.push({ type: "h3", parts: inlineParts(line.slice(4).trim()) });
    else if (line.startsWith("## ")) blocks.push({ type: "h2", parts: inlineParts(line.slice(3).trim()) });
    else if (line.startsWith("# ")) blocks.push({ type: "h2", parts: inlineParts(line.slice(2).trim()) });
    else blocks.push({ type: "p", parts: inlineParts(line) });
  }
  return { title, blocks };
}
