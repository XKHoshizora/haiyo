// A video or an audio file plays where it was sent, as the mainstream chat apps do: a player in the bubble (the first frame, native controls with the
// play button, full screen from the controls), the file card's download kept under it as a secondary action. What plays is decided from the stored
// content type (`attachment.mime`, the type the service decided from the bytes) against what this browser says it can play (`canPlayType`) — never
// from the file name; no autoplay; `playsinline` so iOS plays in the bubble; `preload="metadata"` so the preview does not fetch the file. A file that
// cannot play here, or fails when it is asked to, is the card (ui/FileCard.jsx) as before. No transcoding, no thumbnail made anywhere: the first frame is
// the browser's own.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { formatSize } from "../data/viewmodel.js";
import { Download } from "../icons.js";
import { FileCard } from "./FileCard.jsx";
import { thumbMaxWidth, thumbSize } from "./thumbSize.js";
import { useGrowOnSize } from "./useGrowOnSize.js";

/** What a sniffed type is called by a browser, where the two differ. */
const ALIASES = {
  "audio/vnd.wave": ["audio/wav"],
  "audio/x-wav": ["audio/wav"],
  "audio/x-m4a": ["audio/mp4", "audio/x-m4a"],
  "audio/aac": ["audio/aac", "audio/mp4"],
  "audio/x-flac": ["audio/flac"],
  "video/x-m4v": ["video/mp4"],
};

/** "video", "audio" or null: the stored type is one of those and this browser says it can play it (some answer, "maybe" or "probably"). */
export function playableKind(mime) {
  if (typeof mime !== "string") return null;
  const kind = /^(video|audio)\//.exec(mime)?.[1];
  if (!kind) return null;
  const probe = document.createElement(kind);
  return [mime, ...(ALIASES[mime] ?? [])].some((type) => probe.canPlayType(type) !== "") ? kind : null;
}

/** The card replaces the player only when nothing was ever loaded (a format or a codec this browser cannot play); a drop in the network while it plays keeps it. */
const unplayable = (node, setFailed) => node.readyState === 0 && setFailed(true);

export function MediaBody({ msg }) {
  const { upload, attachment } = msg;
  const [failed, setFailed] = useState(false);
  const [box, setBox] = useState(null);
  const figure = useRef(null);
  // Far from the screen a player loads nothing (a chat full of clips would start a request for each at once); it starts its metadata when it comes
  // near. Where there is no IntersectionObserver it starts at once.
  const [near, setNear] = useState(typeof IntersectionObserver === "undefined");
  const kind = useMemo(() => (attachment.url && !upload ? playableKind(attachment.mime) : null), [attachment.url, attachment.mime, upload]);
  useEffect(() => {
    if (near || !figure.current || typeof IntersectionObserver === "undefined") return undefined;
    const watcher = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setNear(true), { rootMargin: "400px 0px" });
    watcher.observe(figure.current);
    return () => watcher.disconnect();
  }, [near, kind, failed]);
  // The box changed from the placeholder to the media's own shape: a list at its newest message stays there (the same path as a picture).
  useGrowOnSize(box?.width, box?.height);
  if (!kind || failed) return <FileCard name={msg.text} size={attachment.size} mime={attachment.mime} url={attachment.url} upload={upload} />;
  const measure = (node) => setBox(thumbSize({ width: node.videoWidth, height: node.videoHeight }, { maxWidth: thumbMaxWidth(window.innerWidth) }));
  return (
    <figure
      ref={figure}
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
          preload={near ? "metadata" : "none"}
          aria-label={msg.text}
          onLoadedMetadata={(e) => measure(e.currentTarget)}
          onError={(e) => unplayable(e.currentTarget, setFailed)}
        />
      ) : (
        <audio src={attachment.url} controls preload={near ? "metadata" : "none"} aria-label={msg.text} onError={(e) => unplayable(e.currentTarget, setFailed)} />
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
