import React, { useEffect, useId, useRef, useState } from "react";
import { Minus, Plus } from "../icons.js";
import { Btn, IconBtn, Modal } from "../ui/primitives.jsx";
import { useCoarsePointer } from "../ui/pointer.js";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  STAGE,
  clampView,
  initialView,
  panBy,
  pinch,
  placement,
  stepZoom,
  wheelZoom,
  zoomAbout,
} from "../ui/avatarCrop.js";
import { decodeAvatar } from "../ui/avatarImage.js";

const KEY_STEP = 10;
const KEY_STEP_BIG = 40;

/**
 * 调整头像: the picked picture in a square stage with a circular frame; it is moved and zoomed until the circle shows what
 * should be the avatar, and 保存 cuts that out (512 × 512, small enough for the service) and hands it to `onSave(file)`,
 * which resolves "" when it took it (the caller then closes the dialog) or a sentence to show here (the dialog stays, so
 * nothing is lost). The original file never goes anywhere. Everything is by keyboard as well: the arrow keys move
 * (Shift: bigger steps), `+` and `-` zoom, and the slider and its two buttons zoom.
 */
export function AvatarDialog({ file, onCancel, onSave }) {
  const touch = useCoarsePointer();
  const [load, setLoad] = useState({ kind: "loading" }); // | {kind: "error", text} | {kind: "ready", image}
  const [view, setView] = useState(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const stage = useRef(null);
  const canvas = useRef(null);
  const pointers = useRef(new Map());
  const pinching = useRef(null);
  const busyRef = useRef(false);
  const okButton = useRef(null);
  const helpId = useId();

  useEffect(() => {
    let alive = true;
    let opened = null;
    decodeAvatar(file).then(
      (image) => {
        if (!alive) return image.close();
        opened = image;
        setView(initialView(image.width, image.height));
        setLoad({ kind: "ready", image });
      },
      (error) => alive && setLoad({ kind: "error", text: error?.text ?? "这张图片无法读取，请换一张。" }),
    );
    return () => {
      alive = false;
      opened?.close();
    };
  }, [file]);

  // The stage that had the focus is gone when the picture cannot be read: the one button that is left takes it.
  useEffect(() => {
    if (load.kind === "error") okButton.current?.focus();
  }, [load.kind]);

  const image = load.kind === "ready" ? load.image : null;
  useEffect(() => {
    if (image && canvas.current) image.paint(canvas.current);
  }, [image]);

  // A change of the view always goes through the clamp: no way to show empty space.
  const change = (next) => image && setView((v) => clampView(next(v, image.width, image.height), image.width, image.height));
  const zoomTo = (zoom, at) => change((v, w, h) => zoomAbout(v, zoom, w, h, at?.x, at?.y));

  /** A pointer or wheel position as a point of the stage (in its own units); the centre when the stage has no size. */
  const stagePoint = (clientX, clientY) => {
    const box = stage.current?.getBoundingClientRect();
    if (!box || !(box.width > 0) || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return { x: STAGE / 2, y: STAGE / 2 };
    const k = STAGE / box.width;
    return { x: (clientX - box.left) * k, y: (clientY - box.top) * k };
  };

  useEffect(() => {
    const node = stage.current;
    if (!node || !image) return undefined;
    const onWheel = (e) => {
      e.preventDefault();
      if (busyRef.current) return;
      const at = stagePoint(e.clientX, e.clientY);
      const lines = e.deltaMode === 1 ? 16 : 1;
      setView((v) => zoomAbout(v, wheelZoom(v.zoom, e.deltaY * lines), image.width, image.height, at.x, at.y));
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [image]);

  const down = (e) => {
    if (!image || busyRef.current || (e.pointerType === "mouse" && e.button !== 0)) return;
    stage.current?.setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, stagePoint(e.clientX, e.clientY));
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinching.current = { view, distance: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
    }
  };
  const move = (e) => {
    const before = pointers.current.get(e.pointerId);
    if (!before || !image) return;
    const now = stagePoint(e.clientX, e.clientY);
    pointers.current.set(e.pointerId, now);
    if (pointers.current.size >= 2 && pinching.current) {
      const [a, b] = [...pointers.current.values()];
      const current = { distance: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
      setView(clampView(pinch(pinching.current, current, image.width, image.height), image.width, image.height));
    } else if (pointers.current.size === 1) {
      change((v, w, h) => panBy(v, now.x - before.x, now.y - before.y, w, h));
    }
  };
  const up = (e) => {
    pointers.current.delete(e.pointerId);
    // Two fingers left (of three): a new pinch from where they are; one: it carries on as a drag from where it is.
    if (pointers.current.size === 2 && view) {
      const [a, b] = [...pointers.current.values()];
      pinching.current = { view, distance: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
    } else {
      pinching.current = null;
    }
  };

  const keys = (e) => {
    if (!image || busyRef.current) return;
    const step = e.shiftKey ? KEY_STEP_BIG : KEY_STEP;
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (delta) {
      e.preventDefault();
      change((v, w, h) => panBy(v, delta[0], delta[1], w, h));
    } else if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      change((v, w, h) => zoomAbout(v, stepZoom(v.zoom, 1), w, h));
    } else if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      change((v, w, h) => zoomAbout(v, stepZoom(v.zoom, -1), w, h));
    }
  };

  const save = async () => {
    if (!image || busyRef.current) return;
    busyRef.current = true;
    // The button about to be disabled has the focus: it goes to the stage, so Esc and Tab keep working in the dialog.
    stage.current?.focus();
    setBusy(true);
    setProblem("");
    try {
      const cropped = await image.crop(view);
      const text = await onSave(cropped);
      if (text) setProblem(text);
    } catch (error) {
      setProblem(error?.text ?? "头像处理失败，请再试一次。");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  // The dialog's own Esc, close button and backdrop go through here: not while a save is under way.
  const close = () => {
    if (!busyRef.current) onCancel();
  };

  const ready = image && view;
  const place = ready ? placement(view, image.width, image.height) : null;
  return (
    <Modal
      title="调整头像"
      onClose={close}
      locked={busy}
      footer={
        load.kind === "error" ? (
          <Btn ref={okButton} variant="primary" onClick={onCancel}>知道了</Btn>
        ) : (
          <>
            <Btn disabled={!ready || busy} onClick={() => image && setView(initialView(image.width, image.height))}>重置</Btn>
            <Btn disabled={busy} onClick={close}>取消</Btn>
            <Btn variant="primary" className="btn-save" disabled={!ready || busy} onClick={save}>{busy ? "保存中…" : "保存"}</Btn>
          </>
        )
      }
    >
      {load.kind === "error" ? (
        <p className="field-msg" role="alert">{load.text}</p>
      ) : (
        <div className="avatar-adjust">
          <p id={helpId} className="field-hint">{touch ? "拖动调整位置，双指或滑块缩放。" : "拖动调整位置，滑块或滚轮缩放。"}</p>
          <div
            ref={stage}
            className="avatar-stage"
            tabIndex={ready ? 0 : -1}
            role="group"
            aria-label="头像取景框"
            aria-describedby={helpId}
            aria-busy={!ready}
            data-autofocus
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={up}
            onKeyDown={keys}
          >
            {ready ? (
              <canvas
                ref={canvas}
                className="avatar-stage-picture"
                aria-hidden="true"
                style={{ left: `${place.left * 100}%`, top: `${place.top * 100}%`, width: `${place.width * 100}%`, height: `${place.height * 100}%` }}
              />
            ) : (
              <span className="avatar-stage-note">正在读取图片…</span>
            )}
            <span className="avatar-frame" aria-hidden="true" />
          </div>
          <div className="avatar-zoom">
            <IconBtn label="缩小" disabled={!ready || busy || view.zoom <= MIN_ZOOM} onClick={() => change((v, w, h) => zoomAbout(v, stepZoom(v.zoom, -1), w, h))}>
              <Minus size={18} aria-hidden="true" />
            </IconBtn>
            <input
              type="range"
              aria-label="缩放"
              aria-valuetext={ready ? `${Math.round(view.zoom * 100)}%` : undefined}
              min={MIN_ZOOM}
              max={MAX_ZOOM}
              step={0.01}
              value={ready ? view.zoom : MIN_ZOOM}
              disabled={!ready || busy}
              onChange={(e) => zoomTo(Number(e.target.value))}
            />
            <IconBtn label="放大" disabled={!ready || busy || view.zoom >= MAX_ZOOM} onClick={() => change((v, w, h) => zoomAbout(v, stepZoom(v.zoom, 1), w, h))}>
              <Plus size={18} aria-hidden="true" />
            </IconBtn>
          </div>
          {problem && <p className="field-msg" role="alert">{problem}</p>}
        </div>
      )}
    </Modal>
  );
}
