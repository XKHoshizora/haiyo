import React from "react";
import { formatSize } from "../data/viewmodel.js";
import { Download, File, FileArchive, FileAudio, FileCode, FileImage, FileSpreadsheet, FileText, FileVideo, Presentation } from "../icons.js";
import { fileKind, splitFileName } from "./fileKind.js";

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

/**
 * A file's name with its middle left out when the card is too narrow for it: the head gives way with "…", the tail —
 * the extension and a little before it — stays. The two parts read as one name (`title` has all of it).
 */
export function FileName({ name }) {
  const { head, tail } = splitFileName(name);
  return (
    <strong className="file-name" title={name}>
      <span className="file-name-head">{head}</span>
      <span className="file-name-tail">{tail}</span>
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
        <p className="muted">{formatSize(size)} · 仅本会话可见</p>
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
