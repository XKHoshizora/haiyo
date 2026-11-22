// A video or an audio file plays where it was sent, as the mainstream chat apps do: a player in the bubble (the first frame, native controls with the
// play button, full screen from the controls), the file card's download kept under it as a secondary action. What plays is decided from the stored
// content type (`attachment.mime`, the type the service decided from the bytes) against what this browser says it can play (`canPlayType`) — never
// from the file name; no autoplay; `playsinline` so iOS plays in the bubble; `preload="metadata"` so the preview does not fetch the file. A file that
// cannot play here, or fails when it is asked to, is the card (ui/FileCard.jsx) as before. No transcoding, no thumbnail made anywhere: the first frame is
// the browser's own.
import React, { useState } from "react";
import { formatSize } from "../data/viewmodel.js";
import { Download } from "../icons.js";
import { FileCard } from "./FileCard.jsx";
import { thumbMaxWidth, thumbSize } from "./thumbSize.js";

/** What a sniffed type is called by a browser, where the two differ. */
const ALIASES = { "audio/vnd.wave": ["audio/wav"], "audio/x-wav": ["audio/wav"], "audio/x-m4a": ["audio/mp4", "audio/x-m4a"], "audio/aac": ["audio/aac", "audio/mp4"], "video/x-m4v": ["video/mp4"] };

/** "video", "audio" or null: the stored type is one of those and this browser says it can play it (some answer, "maybe" or "probably"). */
export function playableKind(mime) {
  if (typeof mime !== "string") return null;
  const kind = /^(video|audio)\//.exec(mime)?.[1];
  if (!kind) return null;
  const probe = document.createElement(kind);
  return [mime, ...(ALIASES[mime] ?? [])].some((type) => probe.canPlayType(type) !== "") ? kind : null;
}

export function MediaBody({ msg }) {
  const { upload, attachment } = msg;
  const [failed, setFailed] = useState(false);
  const [box, setBox] = useState(null);
  const kind = attachment.url && !upload ? playableKind(attachment.mime) : null;
  if (!kind || failed) return <FileCard name={msg.text} size={attachment.size} mime={attachment.mime} url={attachment.url} upload={upload} />;
  const measure = (node) => setBox(thumbSize({ width: node.videoWidth, height: node.videoHeight }, { maxWidth: thumbMaxWidth(window.innerWidth) }));
  return (
    <figure
      className={`attachment-media attachment-${kind}`}
      data-sized={box ? "" : undefined}
      style={box ? { width: box.width } : undefined}
    >
      <div className="media-frame" style={box ? { aspectRatio: `${box.width} / ${box.height}` } : undefined}>
      {kind === "video" ? (
        <video
          // (The fragment makes Safari draw the first frame of a file it has only the metadata of.)
          src={`${attachment.url}#t=0.001`}
          controls
          playsInline
          preload="metadata"
          aria-label={msg.text}
          onLoadedMetadata={(e) => measure(e.currentTarget)}
          onError={() => setFailed(true)}
        />
      ) : (
        <audio src={attachment.url} controls preload="metadata" aria-label={msg.text} onError={() => setFailed(true)} />
      )}
      </div>
      <p className="media-meta muted">
        <span className="media-name">{msg.text}</span>
        <a className="media-save" href={attachment.url} download={msg.text} aria-label={`下载 ${msg.text}，${formatSize(attachment.size)}`}>
          <Download size={14} aria-hidden="true" /> 下载
        </a>
      </p>
    </figure>
  );
}
