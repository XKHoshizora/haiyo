// What a file card shows of a file besides its size: which icon (its kind), and its name cut for a narrow card.

/** The kinds a file card has an icon for (ui/FileIcon.jsx draws one each). */
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
 * The kind of a file: from its type when that says something (`mime`), else from its extension, else "other". The wire
 * carries no type for an attachment, so in a chat this is mostly the extension; a file still being sent has its own.
 */
export function fileKind({ mime, name }) {
  const type = String(mime ?? "").toLowerCase();
  for (const [kind, pattern] of BY_MIME) if (pattern.test(type)) return kind;
  return BY_EXTENSION.get(extensionOf(name)) ?? "other";
}

/** An extension longer than this is not taken for one. */
const EXTENSION_MAX = 16;
/** How much of the name before the extension stays beside it (code points), and how much of a name without one. */
const BEFORE_EXTENSION = 4;
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
