// What an Agent's rendered text may contain: the allow-list that both sides apply. The worker (markdownPipeline.js)
// rebuilds its tree from it; the main thread (markdownTree.js) checks the tree that comes back against it again before
// React sees anything. Plain data and two small functions, no dependencies: both bundles carry a copy.

/** An absolute http(s) URL without a user name or password as the link's href, or null: the link is then its text. */
export function safeHref(value) {
  if (typeof value !== "string") return null;
  let url;
  try {
    url = new URL(value.trim()); // no base: a relative or protocol-relative URL is not a link here
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.username || url.password ? null : url.href;
}

/**
 * Bidirectional controls (embeddings, overrides, isolates, marks): removed from an Agent's text before anything shows
 * it, so that nothing it writes can reorder what surrounds it (a link's host note, the page's own text). From the
 * source, and again from every string of the tree made from it (a control can be written as a character reference,
 * which only the parser turns into the character), in the worker and in the main thread's check. Written with escapes:
 * never the invisible characters themselves.
 */
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/g;
export const withoutBidiControls = (text) => (typeof text === "string" ? text.replace(BIDI_CONTROLS, "") : "");
const BIDI_CONTROL = new RegExp(BIDI_CONTROLS.source);
export const hasBidiControls = (text) => BIDI_CONTROL.test(text);

/** The most characters of a link's text that are shown; a longer one ends with an ellipsis. */
export const LINK_TEXT_MAX = 200;
/** White space and separators of every kind (no-break and wide spaces, line and paragraph separators, line ends). */
const SPACES = /[\s\p{Z}]+/gu;
/**
 * A link's text as it is shown, whoever made it: on one line, without bidirectional controls, every run of white
 * space and separators as one space, trimmed, at most LINK_TEXT_MAX characters (then an ellipsis). Applied by the
 * worker to what it flattens out of a link, and again by the main thread to the text it is given: nothing in a link's
 * text can push its host note away from it. Doing it twice changes nothing.
 */
export function linkTextShown(text) {
  const line = withoutBidiControls(text).replace(SPACES, " ").trim();
  if (line.length <= LINK_TEXT_MAX) return line;
  const characters = Array.from(line.slice(0, 2 * LINK_TEXT_MAX + 2));
  return characters.length > LINK_TEXT_MAX ? `${characters.slice(0, LINK_TEXT_MAX).join("")}…` : line;
}

/** The most one text's tree may have: elements and their depth (beyond: the text is shown plain, with the note). */
export const TREE_ELEMENTS = 3000;
export const TREE_DEPTH = 60;

/** The elements the Markdown pipeline makes, outside KaTeX, and the props each keeps (beyond `className`). */
export const ELEMENTS = new Map(
  Object.entries({
    p: [], h1: [], h2: [], h3: [], h4: [], h5: [], h6: [], ul: [], ol: ["start"], li: [], blockquote: [], hr: [], br: [],
    pre: [], code: [], em: [], strong: [], del: [], sup: [], span: [], section: [],
    table: [], thead: [], tbody: [], tr: [], th: ["align"], td: ["align"], a: ["href"],
  }),
);
/** Classes kept outside KaTeX: the highlighter's, a code block's language, the task-list and footnote ones, ours. */
export const CLASS = /^(hljs[\w-]*|[a-z]+_+|language-[\w#+.-]{1,40}|contains-task-list|task-list-item|footnotes|sr-only|md-plain)$/;
export const ALIGN = new Set(["left", "right", "center"]);

/** KaTeX's own output: its HTML, its MathML and the few SVG shapes it draws (a root, an arrow, a hat). */
export const KATEX_ELEMENTS = new Set([
  "span", "math", "semantics", "annotation", "mrow", "mi", "mn", "mo", "mtext", "mspace", "msup", "msub", "msubsup",
  "mfrac", "msqrt", "mroot", "mover", "munder", "munderover", "mtable", "mtr", "mtd", "mstyle", "mpadded", "mphantom",
  "menclose", "svg", "path", "line",
]);
/** KaTeX's attributes, by their name in the parsed HTML (hast) and as React takes them. */
export const KATEX_PROPS = new Map([
  ["ariaHidden", "aria-hidden"],
  ...[
    "xmlns", "display", "encoding", "mathvariant", "stretchy", "fence", "separator", "minsize", "maxsize", "lspace", "rspace",
    "accent", "accentunder", "mathcolor", "mathbackground", "scriptlevel", "displaystyle", "width", "height", "depth",
    "voffset", "notation", "rowspacing", "rowalign", "columnalign", "columnspacing", "columnlines", "rowlines", "frame",
    "linethickness", "movablelimits", "largeop", "symmetric", "mathsize", "viewBox", "preserveAspectRatio", "d", "x1",
    "y1", "x2", "y2", "strokeWidth",
  ].map((name) => [name, name]),
]);
/** The React names of KaTeX's attributes (the props the main thread accepts inside KaTeX's output). */
export const KATEX_REACT_PROPS = new Set(KATEX_PROPS.values());
/** The CSS properties KaTeX's inline layout uses (React's names); any other declaration is dropped. */
export const KATEX_STYLE = new Set([
  "height", "verticalAlign", "top", "bottom", "left", "right", "position", "width", "minWidth", "margin", "marginLeft",
  "marginRight", "marginTop", "marginBottom", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom", "border",
  "borderWidth", "borderStyle", "borderColor", "borderTopWidth", "borderBottomWidth", "borderRightWidth",
  "borderLeftWidth", "borderRightStyle", "color", "backgroundColor", "textShadow",
]);
/** `position` keeps KaTeX inside its box: never fixed or sticky. */
export const POSITIONS = new Set(["relative", "absolute"]);
/** A style value that could fetch or run something, or leave its declaration: dropped (KaTeX's own never does). */
export const UNSAFE_STYLE = /url\s*\(|image|expression|@|\\|src\s*\(|[;:"'<>{}/*!]/i;
/** What a KaTeX style value is made of (lengths, colours, keywords). */
export const STYLE_VALUE = /^[-\w.%#, ()]{1,100}$/;
/** Whether a declaration of KaTeX's inline layout may be kept (React's property name, its value). */
export const styleAllowed = (name, value) =>
  KATEX_STYLE.has(name) && typeof value === "string" && STYLE_VALUE.test(value) && !UNSAFE_STYLE.test(value) && (name !== "position" || POSITIONS.has(value));
/** A class name in KaTeX's output (its own are short words and dashes). */
export const KATEX_CLASS = /^[A-Za-z][\w-]{0,40}$/;
export const isKatexRootClass = (name) => name === "katex" || name === "katex-display" || name === "katex-error";

/**
 * The classes the app's own stylesheet (styles.css) styles: one in KaTeX's output would take the app's look (KaTeX's
 * `\tag` made a `tag`). Dropped there. tests/markdown.test.jsx checks this list against styles.css.
 */
export const APP_CLASSES = new Set(
  `active app appellation-rows apply-box approvals attachment-image auth-card auth-foot auth-form auth-head auth-page auth-submit avatar
  avatar-dot avatar-editor avatar-fallback avatar-img back badge blocker boxed brand-mark brand-name btn btn-danger cite
  btn-primary btn-sm btn-text bubble card card-actions card-head card-title chat chat-head chat-head-actions chat-search
  chat-title check checks compact composer composer-hint composer-input composer-resize composer-row composer-tools
  current device-rows device-static disc-actions disc-bar disc-text document-address document-label document-preview
  document-tools done dots dropping emoji-grid emoji-heading emoji-picker emoji-tabs empty-main exp-block exp-candidate
  exp-footer exp-meta exp-new eyebrow failed field field-error field-hint field-label field-msg file-card flash footnotes
  form-actions form-section group-avatar grow head-actions head-model human-input icon-btn identity-line info-lines inline kv kv-row lab-logo lead
  list-col list-head list-note list-title lookup-rows lookup-words main-col md md-code md-copy md-host md-link md-note md-plain md-table md-text
  member-actions member-body member-rows mention-empty mention-heading mention-picker menu menu-anchor messages mine
  mini-kv modal modal-backdrop modal-body modal-foot modal-head modal-wide model-panel msg msg-action msg-divider msg-foot msg-lookups msg-main msg-meta msg-via
  msg-system muted n2 n3 n4 notice notice-actions notice-body notice-ok notice-pause notice-sub notice-warn only-mobile
  order-list owner pad page page-body pills plain-list profile-head proposal-persona quick-bar radio-cards rail
  rail-bottom rail-icon rail-item rail-me rail-nav readonly reason receipt rel-rows reply-chip reply-points row row-actions row-body
  row-name row-preview row-sub row-top rows rows-empty rows-label screen screen-bar screen-body screen-human search send
  settings-me share-items side side-body side-col side-head side-hero side-list slim spacer sr-only stack-actions steps
  sync-added sync-failed sync-name sync-others sync-rows sync-tags sync-tools
  tag tag-human tag-muted tag-ok tag-pending tag-row tag-solid tag-warn task-controls task-list-item text-link theirs thinking
  thinking-text toast typed up upload-progress vis-banner
  memory-card memory-chip memory-detail memory-foot memory-hint memory-lines memory-merged msg-memory
  msg-whisper whisper whisper-head whisper-text whisper-actions whisper-done whisper-dot whisper-hits whisper-hit whisper-hit-meta whisper-hit-text whisper-hit-more folded
  whisper-folded whisper-summary whisper-top whisper-fold whisper-failed whisper-open
  memory-room memory-head memory-add memory-add-line memory-add-vault memory-rows memory-row memory-body memory-text memory-source memory-actions memory-open memory-stale memory-switches memory-catch-up memory-vault
  model-brand model-trigger model-name model-chevron model-pop model-scrim model-search model-list model-group-label model-option
  model-note model-check model-reason model-marks model-mark model-mark-free model-mark-paid model-empty model-foot model-scope side-model
  select-trigger select-label select-pop select-list select-option
  handle-input handle-prefix
  composer-field composer-field-off composer-mirror mention mention-agent mention-chip
  cite-web web-sources web-source-n web-source-title web-source-host md-link-plain`.split(/\s+/),
);
