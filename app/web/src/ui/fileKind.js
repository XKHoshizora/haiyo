// What a file card shows of a file besides its size: which icon (its kind), and its name cut for a narrow card.

/** The kinds a file card has an icon for (ui/FileCard.jsx draws one each). */
export const FILE_KINDS = ["pdf", "document", "spreadsheet", "slides", "archive", "audio", "video", "code", "image", "other"];

/** By type, first match wins: a specific type before a family (text/csv is a sheet before text/* is text). */
const BY_MIME = [
  ["pdf", /^application\/pdf$/],
  ["document", /^application\/(msword|rtf|vnd\.openxmlformats-officedocument\.wordprocessingml|vnd\.oasis\.opendocument\.text|vnd\.ms-word)/],
  ["spreadsheet", /^(text\/(csv|tab-separated-values)|application\/(vnd\.ms-excel|vnd\.openxmlformats-officedocument\.spreadsheetml|vnd\.oasis\.opendocument\.spreadsheet))/],
  ["slides", /^application\/(vnd\.ms-powerpoint|vnd\.openxmlformats-officedocument\.presentationml|vnd\.oasis\.opendocument\.presentation)/],
  ["archive", /^application\/(zip|x-zip|gzip|x-gzip|x-tar|x-7z-compressed|x-rar-compressed|vnd\.rar|x-bzip2?|x-xz|zstd)/],
  ["audio", /^audio\//],
  ["video", /^video\//],
  ["image", /^image\//],
  ["code", /^(text\/|application\/(json|xml|javascript|x-javascript|typescript|x-sh|x-yaml|yaml|sql|toml))/],
];

const EXTENSIONS = {
  pdf: "pdf",
  document: "doc docx odt rtf pages wps",
  spreadsheet: "xls xlsx ods csv tsv numbers",
  slides: "ppt pptx odp key",
  archive: "zip rar 7z tar gz tgz bz2 xz zst",
  audio: "mp3 wav flac aac ogg oga m4a opus wma aiff",
  video: "mp4 m4v mov mkv avi webm wmv flv mpg mpeg",
  code: "txt md markdown log json xml html htm css scss js mjs cjs jsx ts tsx py rb php java kt c h cc cpp hpp cs go rs swift sh bash zsh ps1 bat sql yaml yml toml ini conf cfg lua r pl vue svelte",
  image: "png jpg jpeg gif webp bmp svg heic heif tif tiff ico avif",
};
const BY_EXTENSION = new Map(Object.entries(EXTENSIONS).flatMap(([kind, list]) => list.split(" ").map((ext) => [ext, kind])));

/** The extension after the last dot, lower case: "" for none (a name that only starts with a dot has none). */
function extensionOf(name) {
  const dot = String(name ?? "").lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * The kind of a file: from its extension when that is a known one, else from its type (`mime`), else "other". The
 * extension goes first because a browser's type can be wrong (a .ts file is video/mp2t on Windows) and because the wire
 * carries no type for a stored attachment: the same file shows the same icon while it is being sent and after.
 */
export function fileKind({ mime, name }) {
  const byName = BY_EXTENSION.get(extensionOf(name));
  if (byName) return byName;
  const type = String(mime ?? "").toLowerCase();
  for (const [kind, pattern] of BY_MIME) if (pattern.test(type)) return kind;
  return "other";
}

/** An extension longer than this is not taken for one. */
const EXTENSION_MAX = 16;
/** How much of the name before the extension stays beside it (code points), and how much of a name without one. */
const BEFORE_EXTENSION = 6;
const NO_EXTENSION = 6;

/**
 * A file name in two parts for a card too narrow for it: the head, which the card cuts with "…" in its middle, and the
 * tail, which stays whole — the extension and a little before it, so what the file is shows. Counted in code points (a
 * Chinese name or an emoji is never cut in two); `head + tail` is always the name. A short name is all tail.
 */
export function splitFileName(name) {
  const chars = Array.from(String(name ?? ""));
  const dot = chars.lastIndexOf(".");
  const extension = dot > 0 && chars.length - dot <= EXTENSION_MAX ? chars.length - dot : 0;
  const keep = Math.min(chars.length, extension ? extension + BEFORE_EXTENSION : NO_EXTENSION);
  const cut = chars.length - keep;
  return { head: chars.slice(0, cut).join(""), tail: chars.slice(cut).join("") };
}

/**
 * The head of a name as it is shown in a box `width` wide (in the unit `measure` counts): all of it when head and tail fit,
 * else the longest start of it whose text, "…" and the tail fit — so the ellipsis stands against the tail with no gap, which
 * a box clipped by CSS (`text-overflow`) leaves (up to a character's width). `measure(text)` is the text's width in the same
 * unit. Counted in code points, so no character is cut in two. Nothing is elided where there is nothing to measure (`width` 0).
 */
export function elideHead({ head, tail, width, measure }) {
  if (!head || !(width > 0) || measure(head + tail) <= width) return head;
  const chars = Array.from(head);
  let low = 0;
  let high = chars.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (measure(`${chars.slice(0, mid).join("")}…${tail}`) <= width) low = mid;
    else high = mid - 1;
  }
  return `${chars.slice(0, low).join("")}…`;
}
