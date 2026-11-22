import React, { useLayoutEffect, useRef, useState } from "react";
import { formatSize } from "../data/viewmodel.js";
import { Download, File, FileArchive, FileAudio, FileCode, FileImage, FileSpreadsheet, FileText, FileVideo, Presentation } from "../icons.js";
import { elideHead, fileKind, splitFileName } from "./fileKind.js";

/** The icon of each kind of file (ui/fileKind.js), each in its own colour from the app's variables (styles.css `.file-icon-*`). */
const ICONS = {
  pdf: FileText,
  document: FileText,
  spreadsheet: FileSpreadsheet,
  slides: Presentation,
  archive: FileArchive,
  audio: FileAudio,
  video: FileVideo,
  code: FileCode,
  image: FileImage,
  other: File,
};

/** The width of `text` in the font of `node`, by a canvas (null where there is none, so nothing is measured). */
let measuring;
function textMeter(node) {
  // (One canvas for every card and every resize.)
  measuring ??= document.createElement("canvas").getContext?.("2d") ?? false;
  const context = measuring;
  if (!context) return null;
  const style = getComputedStyle(node);
  context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  return (text) => context.measureText(text).width;
}

/**
 * A file's name with its middle left out when the card is too narrow for it: the head gives way with "…", the tail —
 * the extension and a few characters before it — stays. The head is cut where the box ends (measured, `elideHead`), so the
 * "…" stands against the tail with no gap; the stylesheet's own cut is what remains where nothing can be measured. The two
 * parts read as one name (`title` has all of it).
 */
export function FileName({ name }) {
  const { head, tail } = splitFileName(name);
  const box = useRef(null);
  const [shown, setShown] = useState(null);
  useLayoutEffect(() => {
    const node = box.current;
    if (!node || typeof ResizeObserver !== "function") return undefined;
    const fit = () => {
      const measure = textMeter(node);
      const width = node.getBoundingClientRect().width;
      setShown(measure && width > 0 ? elideHead({ head, tail, width: width - 1, measure }) : null);
    };
    fit();
    const watch = new ResizeObserver(fit);
    watch.observe(node);
    return () => watch.disconnect();
  }, [head, tail]);
  // Cut short on screen: the drawn parts are for the eye, and the whole name stays in the page for a screen reader, a search and a copy.
  const cut = shown !== null && shown !== head;
  return (
    <strong className="file-name" title={name} ref={box}>
      <span className="file-name-head" aria-hidden={cut || undefined}>{cut ? shown : head}</span>
      <span className="file-name-tail" aria-hidden={cut || undefined}>{tail}</span>
      {cut && <span className="sr-only">{name}</span>}
    </strong>
  );
}

/**
 * A file that is not a picture, as a card: an icon of its kind, its name, its size and who can see it, and — once it can
 * be fetched (`url`) — the whole card is the one link that downloads it (one tab stop; the download button is its look,
 * not a second stop). While it is being sent (`upload`) the card shows the progress and is not a link. `mime`: its
 * type, when it is known (the wire carries none; the extension decides then).
 */
export function FileCard({ name, size, mime = null, url = null, upload = null }) {
  const kind = fileKind({ mime, name });
  const Icon = ICONS[kind];
  const content = (
    <>
      <Icon size={28} aria-hidden="true" className={`file-icon file-icon-${kind}`} />
      <div className="file-card-text">
        <FileName name={name} />
        <p className="muted file-card-meta">
          <span>{formatSize(size)} ·</span> <span>仅本会话可见</span>
        </p>
        {upload && <progress className="upload-progress" max={100} value={Math.round(upload.progress * 100)} aria-label="上传进度" />}
      </div>
      {url && (
        <span className="btn btn-ghost btn-sm" aria-hidden="true">
          <Download size={14} /> 下载
        </span>
      )}
    </>
  );
  if (!url) return <div className="card file-card" data-kind={kind}>{content}</div>;
  return (
    <a className="card file-card file-card-link" data-kind={kind} href={url} download={name} aria-label={`下载 ${name}，${formatSize(size)}`}>
      {content}
    </a>
  );
}
