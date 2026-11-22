// The image viewer: a picture of the conversation opened in the same window, built by hand. A dialog over a dark
// backdrop; the picture fitted to the window; a bar with who sent it, when and its file name, and the buttons (close,
// download, open the original in a new tab); the conversation's other pictures one step away (keys, buttons, a swipe);
// zoom by wheel, pinch, double click or tap, and `+` `-` `0`. Its pieces: the arithmetic is ui/imageZoom.js, the
// dialog itself (inert page, focus, Esc) is the one modal layer of ui/layers.js; its history entry is the viewer key of state/appHistory.js.
import React, { createContext, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../data/store.jsx";
import { senderName } from "../state/selectors.js";
import { ChevronLeft, ChevronRight, Download, ExternalLink, ImageOff, RotateCw, X } from "../icons.js";
import { IconBtn, Btn } from "./primitives.jsx";
import { useLayer } from "./layers.js";
import { useVisualViewportBox } from "./visualViewport.js";
import { closeViewerEntry, dropViewerKey, openViewerEntry, stepViewerEntry, useViewerId } from "../state/appHistory.js";
import { FIT, clampPan, keyZoom, swipeOf, toggleZoom, wheelFactor, zoomAt } from "./imageZoom.js";

const ViewerContext = createContext(null);
/** `() => void` that the list of a conversation gives: a picture that grew (it is measured when it has loaded) asks it to keep the newest message in view. */
export const GrowContext = createContext(null);
const NOTHING = { open() {} };

/** `{open(messageId, opener)}`: what an image in a bubble calls to open the viewer; a no-op outside a provider. */
export const useImageViewer = () => useContext(ViewerContext) ?? NOTHING;

/** Two taps this close (ms, px) are a double tap. */
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_PX = 30;
/** A press that travels less than this (px) is a tap, not a drag. */
const TAP_SLOP = 6;

const sizeOf = (stage, img) => ({ stage: { w: stage?.clientWidth ?? 0, h: stage?.clientHeight ?? 0 }, image: { w: img?.offsetWidth ?? 0, h: img?.offsetHeight ?? 0 } });
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Wraps the part of the page that shows a conversation's messages: the pictures among `messages` (those loaded, in
 * message order) are what the viewer steps through. The viewer is drawn in `document.body`, outside any scroll box.
 */
export function ImageViewerProvider({ messages, children }) {
  const images = useMemo(() => messages.filter((m) => m.kind === "image" && m.src && !m.hidden), [messages]);
  // The open viewer is a key of the conversation's history entry (and one entry pushed with it): drawn from the entry, so Back
  // closes it and nothing else (state/appHistory.js). The opener node is only for the focus's return.
  const viewerId = useViewerId();
  const opened = useRef(null);
  const api = useMemo(
    () => ({
      open: (id, opener) => {
        opened.current = { id, opener };
        openViewerEntry(id);
      },
    }),
    [],
  );
  const index = viewerId ? images.findIndex((m) => m.id === viewerId) : -1;
  // The picture is not among the messages (another list, or a Forward to a viewer whose picture is gone): once the messages are
  // there, the viewer is closed (the entry loses its key).
  useEffect(() => {
    if (viewerId && index < 0 && messages.length > 0) dropViewerKey();
  }, [viewerId, index, messages.length]);
  return (
    <ViewerContext.Provider value={api}>
      {children}
      {viewerId && index >= 0 && createPortal(<Viewer images={images} index={index} opener={opened.current?.opener} openedId={opened.current?.id ?? viewerId} onShow={(i) => stepViewerEntry(images[i].id)} onClose={closeViewerEntry} />, document.body)}
    </ViewerContext.Provider>
  );
}

function Viewer({ images, index, opener, openedId, onShow, onClose }) {
  const { state } = useStore();
  const msg = images[index];
  const box = useRef(null);
  const stageRef = useRef(null);
  const imgRef = useRef(null);
  const nameId = useId();
  // Pinch-zoomed or moved by Safari's toolbar: the viewer follows what is on screen, so its bar is never off it.
  const visible = useVisualViewportBox();
  const [view, setView] = useState(FIT);
  const [phase, setPhase] = useState("loading");
  const [attempt, setAttempt] = useState(0);
  const [seen, setSeen] = useState(msg.id);
  // Another picture starts fresh: fit, loading.
  if (seen !== msg.id) {
    setSeen(msg.id);
    setView(FIT);
    setPhase("loading");
    setAttempt(0);
  }
  const last = images.length - 1;
  const go = (to) => to >= 0 && to <= last && onShow(to);

  // Back to the picture that opened it: the very node, or — when the list drew it again meanwhile — its new one.
  useLayer(box, { onClose, history: false, returnTo: () => (opener?.isConnected ? opener : document.querySelector(`[data-image="${CSS.escape(openedId)}"]`)) });

  // A button that went away (the end of the list, Retry) leaves the focus in the dialog, on an arrow or the close button.
  useEffect(() => {
    const node = box.current;
    if (node && !node.contains(document.activeElement)) (node.querySelector("[data-viewer-nav]") ?? node.querySelector("[data-autofocus]"))?.focus();
  }, [index, phase, attempt]);

  const sizes = () => sizeOf(stageRef.current, imgRef.current);
  const fromCentre = (clientX, clientY) => {
    const r = stageRef.current.getBoundingClientRect();
    return { x: clientX - (r.left + r.width / 2), y: clientY - (r.top + r.height / 2) };
  };

  // The wheel (a trackpad's pinch too) zooms about the pointer; a listener of its own, since React's is passive.
  useEffect(() => {
    const stage = stageRef.current;
    const onWheel = (e) => {
      e.preventDefault();
      const at = fromCentre(e.clientX, e.clientY);
      const { stage: s, image } = sizeOf(stage, imgRef.current);
      setView((v) => zoomAt(v, v.scale * wheelFactor(e), at, s, image));
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, []);

  // Pointers on the stage: one finger or button drags (pans when zoomed, a swipe at 1x), two pinch, two quick taps toggle.
  const pointers = useRef(new Map());
  const gesture = useRef(null);
  const lastTap = useRef(null);
  const lastType = useRef("mouse");
  const dragged = useRef(false);
  const onPointerDown = (e) => {
    if (e.target.closest("button")) return;
    lastType.current = e.pointerType;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) dragged.current = false;
    const [a, b] = [...pointers.current.values()];
    if (pointers.current.size === 2) {
      dragged.current = true;
      gesture.current = { pinch: true, dist: distance(a, b), mid: fromCentre((a.x + b.x) / 2, (a.y + b.y) / 2), view };
    } else if (pointers.current.size === 1) {
      gesture.current = { x: e.clientX, y: e.clientY, view, type: e.pointerType, at: Date.now() };
    }
  };
  const onPointerMove = (e) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (!g) return;
    const { stage, image } = sizes();
    if (g.pinch) {
      const [a, b] = [...pointers.current.values()];
      const now = fromCentre((a.x + b.x) / 2, (a.y + b.y) / 2);
      const zoomed = zoomAt(g.view, g.view.scale * (distance(a, b) / g.dist), g.mid, stage, image);
      setView({ scale: zoomed.scale, ...clampPan({ x: zoomed.x + now.x - g.mid.x, y: zoomed.y + now.y - g.mid.y }, zoomed.scale, stage, image) });
      return;
    }
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (Math.abs(dx) + Math.abs(dy) > TAP_SLOP) {
      dragged.current = true;
      // A drag of a zoomed picture goes on over the bar or outside the window: the stage keeps the pointer.
      if (g.view.scale > 1 && !g.captured) {
        g.captured = true;
        e.currentTarget.setPointerCapture?.(e.pointerId);
      }
    }
    if (g.view.scale > 1) setView({ scale: g.view.scale, ...clampPan({ x: g.view.x + dx, y: g.view.y + dy }, g.view.scale, stage, image) });
  };
  const onPointerUp = (e) => {
    const had = pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (!had || !g) return;
    if (g.pinch) {
      // A finger left: what is left of the gesture is over; the other finger starts nothing new.
      gesture.current = null;
      return;
    }
    gesture.current = null;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (g.type !== "mouse" && g.view.scale === 1) {
      const swipe = swipeOf(dx, dy);
      if (swipe === "close") return onClose();
      if (swipe) return go(swipe === "next" ? index + 1 : index - 1);
    }
    if (dragged.current || g.type === "mouse") return;
    // A tap by touch or pen: two in a row are a double tap.
    const prev = lastTap.current;
    if (prev && Date.now() - prev.at < DOUBLE_TAP_MS && distance(prev, { x: e.clientX, y: e.clientY }) < DOUBLE_TAP_PX && e.target !== e.currentTarget) {
      lastTap.current = null;
      const { stage, image } = sizes();
      setView((v) => toggleZoom(v, fromCentre(e.clientX, e.clientY), stage, image));
    } else {
      lastTap.current = { x: e.clientX, y: e.clientY, at: Date.now() };
    }
  };
  const onPointerCancel = (e) => {
    pointers.current.delete(e.pointerId);
    gesture.current = null;
  };
  const onDoubleClick = (e) => {
    if (lastType.current !== "mouse" || e.target === e.currentTarget || e.target.closest("button")) return;
    const { stage, image } = sizes();
    setView((v) => toggleZoom(v, fromCentre(e.clientX, e.clientY), stage, image));
  };
  // A click on the backdrop (not the picture, not the end of a drag) closes.
  const onStageClick = (e) => {
    if (e.target === e.currentTarget && !dragged.current) onClose();
  };

  // A press on the picture or the backdrop would leave the focus on the page behind (nothing there can take it): the
  // dialog takes it, so the keys and the Tab trap keep working. A press on a control leaves the focus to the control.
  const keepFocus = (e) => {
    if (!e.target.closest("button, a[href]")) box.current.focus({ preventScroll: true });
  };
  const onKeyDown = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      go(e.key === "ArrowRight" ? index + 1 : index - 1);
      return;
    }
    const { stage, image } = sizes();
    const zoomed = keyZoom(e.key, view, stage, image);
    if (zoomed) {
      e.preventDefault();
      setView(zoomed);
    }
  };

  const who = senderName(state, msg.from);
  return (
    <div className="viewer" style={visible ?? undefined} role="dialog" aria-modal="true" aria-labelledby={nameId} tabIndex={-1} ref={box} onKeyDown={onKeyDown} onPointerDown={keepFocus}>
      <header className="viewer-bar" onClick={(e) => e.target === e.currentTarget && onClose()}>
        <div className="viewer-meta">
          <strong className="viewer-who">{who}</strong>
          <time dateTime={msg.createdAt ?? undefined} title={msg.atTitle || undefined}>
            {msg.at}
          </time>
          <span id={nameId} className="viewer-name">
            {msg.text}
          </span>
        </div>
        {images.length > 1 && (
          <span className="viewer-count" aria-live="polite">
            {index + 1} / {images.length}
          </span>
        )}
        <div className="viewer-actions">
          <a className="icon-btn viewer-btn" href={msg.src} download={msg.text} aria-label={`下载 ${msg.text}`} title="下载">
            <Download size={20} aria-hidden="true" />
          </a>
          <a className="icon-btn viewer-btn" href={`${msg.src}/${encodeURIComponent(msg.text)}`} target="_blank" rel="noopener noreferrer" aria-label="在新标签页打开原图" title="在新标签页打开原图">
            <ExternalLink size={20} aria-hidden="true" />
          </a>
          <IconBtn label="关闭" className="viewer-btn" data-autofocus="" onClick={onClose}>
            <X size={22} aria-hidden="true" />
          </IconBtn>
        </div>
      </header>
      <div
        className="viewer-stage"
        ref={stageRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onDoubleClick={onDoubleClick}
        onClick={onStageClick}
      >
        {phase !== "error" && (
          <img
            key={`${msg.id}:${attempt}`}
            ref={imgRef}
            className="viewer-img"
            src={msg.src}
            alt={msg.text}
            draggable={false}
            data-phase={phase}
            data-scale={view.scale}
            style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
            onLoad={() => setPhase("loaded")}
            onError={() => setPhase("error")}
          />
        )}
        {phase === "loading" && (
          <p className="viewer-state" role="status">
            <span className="viewer-spinner" aria-hidden="true" />
            加载中…
          </p>
        )}
        {phase === "error" && (
          <div className="viewer-state" role="alert">
            <ImageOff size={32} aria-hidden="true" />
            <p>这张图片现在无法显示</p>
            <Btn
              small
              onClick={() => {
                setPhase("loading");
                setAttempt((n) => n + 1);
              }}
            >
              <RotateCw size={14} aria-hidden="true" /> 重试
            </Btn>
          </div>
        )}
        {index > 0 && (
          <IconBtn label="上一张" className="viewer-btn viewer-nav viewer-prev" data-viewer-nav="" onClick={() => go(index - 1)}>
            <ChevronLeft size={26} aria-hidden="true" />
          </IconBtn>
        )}
        {index < last && (
          <IconBtn label="下一张" className="viewer-btn viewer-nav viewer-next" data-viewer-nav="" onClick={() => go(index + 1)}>
            <ChevronRight size={26} aria-hidden="true" />
          </IconBtn>
        )}
      </div>
    </div>
  );
}
