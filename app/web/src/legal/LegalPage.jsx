// The terms (/terms), the privacy policy (/privacy) and the contact page (/contact): public pages, shown with or without a
// session (App Review opens them from the store page; the app's screens link them in a new tab). Their own chunk; each text is
// a file of ./texts/ loaded when it is shown. The app has no language setting, so these pages carry their own switch between
// the three languages they are written in (docs.js `pickLanguage` chooses the first).
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { PRODUCT_NAME, titled } from "../brand.js";
import { navigate } from "../auth/router.js";
import { BrandMark, TextLink } from "../ui/primitives.jsx";
import { focusOn, lost } from "../ui/focusRules.js";
import { LEGAL_DOCS, LEGAL_LANGS, LEGAL_PATHS, pickLanguage } from "./docs.js";
import { parseLegal } from "./legalText.js";
import { LEGAL_VERSIONS } from "./versions.js";

const TEXTS = import.meta.glob("./texts/*.md", { query: "?raw", import: "default" });

/** What the page itself says around the text, in each language. */
const CHROME = {
  zh: { names: { terms: "服务条款", privacy: "隐私政策", contact: "联系我们" }, version: "生效版本", others: "其他页面", loading: "正在加载…", failed: "没能读取这一页，请刷新再试。" },
  en: { names: { terms: "Terms of Service", privacy: "Privacy Policy", contact: "Contact" }, version: "Version in effect", others: "Other pages", loading: "Loading…", failed: "This page could not be read. Please reload." },
  ja: { names: { terms: "利用規約", privacy: "プライバシーポリシー", contact: "お問い合わせ" }, version: "適用バージョン", others: "ほかのページ", loading: "読み込み中…", failed: "このページを読み込めませんでした。再読み込みしてください。" },
};
const LANG_NAMES = { zh: "中文", en: "English", ja: "日本語" };
const HTML_LANG = { zh: "zh-CN", en: "en", ja: "ja" };

/** A left click on a link of this site moves within the page (no reload); anything else is the browser's. */
function inSite(event, to) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate(to);
}

function Parts({ parts }) {
  return parts.map((part, i) => {
    if (part.type === "strong") return <strong key={i}>{part.text}</strong>;
    if (part.type === "todo") return <mark key={i} className="legal-todo">{part.text}</mark>;
    if (part.type !== "link") return <React.Fragment key={i}>{part.text}</React.Fragment>;
    if (part.href.startsWith("/")) {
      return (
        <a key={i} className="legal-link" href={part.href} onClick={(e) => inSite(e, part.href)}>
          {part.text}
        </a>
      );
    }
    const outside = part.href.startsWith("https:");
    return (
      <a key={i} className="legal-link" href={part.href} {...(outside ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
        {part.text}
      </a>
    );
  });
}

function Block({ block }) {
  switch (block.type) {
    case "h2":
      return <h2><Parts parts={block.parts} /></h2>;
    case "h3":
      return <h3><Parts parts={block.parts} /></h3>;
    case "ul":
      return (
        <ul>
          {block.items.map((parts, i) => (
            <li key={i}><Parts parts={parts} /></li>
          ))}
        </ul>
      );
    default:
      return <p><Parts parts={block.parts} /></p>;
  }
}

/** `doc`: "terms" | "privacy" | "contact". */
export default function LegalPage({ doc }) {
  const [lang, setLang] = useState(() => pickLanguage(globalThis.location?.search, globalThis.navigator?.languages ?? [globalThis.navigator?.language]));
  const key = `${doc}.${lang}`;
  const [loaded, setLoaded] = useState({ key: null, text: null, failed: false });
  useEffect(() => {
    let alive = true;
    const load = TEXTS[`./texts/${key}.md`];
    (load ? load() : Promise.reject(new Error(`no text ${key}`))).then(
      (text) => alive && setLoaded({ key, text, failed: false }),
      () => alive && setLoaded({ key, text: null, failed: true }),
    );
    return () => {
      alive = false;
    };
  }, [key]);

  const chrome = CHROME[lang];
  const parsed = loaded.key === key && loaded.text !== null ? parseLegal(loaded.text) : null;
  const title = parsed?.title || chrome.names[doc];
  // The tab's title, made as every page's is (brand.js `titled`; the signed-in pages' state/pageTitle.js, the account screens').
  useEffect(() => {
    document.title = titled(title);
  }, [title]);
  // Another of the three pages, opened from this one: the link pressed went with the old page, so the focus goes to the new
  // page's heading, which names it (the rule of ui/routeFocus.js, by its helpers in ui/focusRules.js). The first page of a
  // visit, and a focus still on something shown (the language switch), are left alone.
  const heading = useRef(null);
  const shownDoc = useRef(doc);
  useLayoutEffect(() => {
    if (shownDoc.current === doc) return;
    shownDoc.current = doc;
    if (lost()) focusOn(heading.current);
  }, [doc]);

  const choose = (next) => {
    setLang(next);
    // The address says the language, so a link copied from here opens in it.
    globalThis.history.replaceState(globalThis.history.state, "", `${globalThis.location.pathname}?lang=${next}`);
  };

  return (
    <main className="legal-page">
      <header className="legal-top">
        <a className="legal-brand" href="/" onClick={(e) => inSite(e, "/")}>
          <span aria-hidden="true">
            <BrandMark size={28} />
          </span>
          <span>{PRODUCT_NAME}</span>
        </a>
        <div className="legal-lang" role="group" aria-label="语言 · Language · 言語">
          {LEGAL_LANGS.map((l) => (
            <button key={l} type="button" lang={HTML_LANG[l]} aria-pressed={l === lang} onClick={() => choose(l)}>
              {LANG_NAMES[l]}
            </button>
          ))}
        </div>
      </header>
      <article className="legal-doc" lang={HTML_LANG[lang]}>
        <h1 ref={heading}>{title}</h1>
        {doc !== "contact" && <p className="legal-version">{`${chrome.version} ${LEGAL_VERSIONS[doc]}`}</p>}
        {parsed ? (
          parsed.blocks.map((block, i) => <Block key={i} block={block} />)
        ) : loaded.key === key && loaded.failed ? (
          <p role="alert">{chrome.failed}</p>
        ) : (
          <p className="muted" role="status">{chrome.loading}</p>
        )}
      </article>
      <nav className="legal-nav" aria-label={chrome.others} lang={HTML_LANG[lang]}>
        {LEGAL_DOCS.filter((d) => d !== doc).map((d) => {
          const to = `${LEGAL_PATHS[d]}?lang=${lang}`;
          return (
            <TextLink key={d} href={to} onClick={(e) => inSite(e, to)}>
              {chrome.names[d]}
            </TextLink>
          );
        })}
      </nav>
    </main>
  );
}
