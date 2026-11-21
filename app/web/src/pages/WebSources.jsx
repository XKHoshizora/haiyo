// The web pages an Agent's reply was handed by its web search (the service's `webSources`; lane websearch), under the
// reply's lookup line (查了 1 次网页): a quiet numbered list, for whoever reads the reply. Each row is the page's title and
// the real host of its address (`new URL(url).hostname`, a punycode host in its ASCII form — never the engine's site
// name), and opens the page in a new tab (`rel="noopener noreferrer nofollow"`). The numbers are the ones the reply's
// chips say (ui/cites.jsx). In such a reply nothing else opens: its Markdown links show as plain text (Markdown.jsx).
import React from "react";
import { TextLink } from "../ui/primitives.jsx";
import { withoutBidiControls } from "../ui/markdownRules.js";

/**
 * What an Agent's message hands its text (ui/cites.jsx `CitesContext`), or null for nothing: its message citations when
 * they can jump (`onJump`), its web chips (`msg.webCites`), in the order of their places (a message's first where both
 * stand), and `plainLinks` when its run was handed web pages (`msg.webSources`).
 */
export function citingOf(msg, onJump) {
  const web = Array.isArray(msg.webCites) ? msg.webCites : [];
  const plainLinks = Array.isArray(msg.webSources) && msg.webSources.length > 0;
  const own = onJump && Array.isArray(msg.cites) ? msg.cites : [];
  const cites = web.length === 0 ? own : [...own, ...web].sort((a, b) => a.at - b.at);
  if (cites.length === 0 && !plainLinks) return null;
  return { cites, onJump, ...(plainLinks ? { plainLinks: true } : {}) };
}

/** `sources` (a view message's `webSources`: `[{n, shown, url, host, title}]`) as the list, or nothing when there are none. */
export function WebSources({ sources }) {
  if (!Array.isArray(sources) || sources.length === 0) return null;
  return (
    <ol className="web-sources" aria-label="网页来源">
      {sources.map((s) => {
        const title = withoutBidiControls(s.title).trim();
        return (
          <li key={s.n}>
            <span className="web-source-n" aria-hidden="true">
              {s.shown}
            </span>
            <TextLink href={s.url} target="_blank" rel="noopener noreferrer nofollow" title={s.url} aria-label={`来源 ${s.shown}：${title || s.host}（${s.host}）`}>
              <span className="web-source-title" dir="auto">
                {title || s.host}
              </span>
              <span className="web-source-host" dir="auto">
                {s.host}
              </span>
            </TextLink>
          </li>
        );
      })}
    </ol>
  );
}
