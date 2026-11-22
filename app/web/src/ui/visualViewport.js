// A layer that must cover what the person sees (the image viewer) is `position: fixed` against the LAYOUT viewport; when the
// page is pinch-zoomed (or Safari's toolbar or the keyboard moves the visible part) that is not the part on screen, and the
// layer's bar ends up outside it. `boxFor` gives the style that puts the layer on the visible part at its normal size.
import { useEffect, useState } from "react";

/**
 * The style of a fixed layer so that it covers exactly the visual viewport `vv` ({scale, offsetLeft, offsetTop, width, height},
 * as `window.visualViewport` has them): placed at the visible part's corner, as large as the layout viewport, then shrunk by the
 * zoom so that on screen it is as large as the visible part. `null` when the page is not zoomed and not moved: `inset: 0` is right.
 */
export function boxFor(vv) {
  if (!vv) return null;
  const { scale, offsetLeft, offsetTop, width, height } = vv;
  if (Math.abs(scale - 1) < 0.01 && Math.abs(offsetLeft) < 0.5 && Math.abs(offsetTop) < 0.5) return null;
  const round = (n) => Math.round(n * 100) / 100;
  const k = Math.abs(scale - 1) < 0.01 ? 1 : scale;
  return {
    position: "fixed",
    inset: "auto",
    left: round(offsetLeft),
    top: round(offsetTop),
    width: round(width * k),
    height: round(height * k),
    transform: `scale(${round(1 / k)})`,
    transformOrigin: "0 0",
  };
}

/**
 * The style of a fixed layer that is exactly the visible part's size and place when the visible part is smaller than the window — the keyboard is
 * up (the layout viewport keeps its height, the visual one shrinks) or the browser panned it. `null` while it is the whole window. Not for a zoomed page.
 */
export function frameFor(vv, windowHeight) {
  if (!vv) return null;
  const { offsetLeft, offsetTop, width, height } = vv;
  if (Math.abs(height - windowHeight) < 1 && Math.abs(offsetLeft) < 0.5 && Math.abs(offsetTop) < 0.5) return null;
  const round = (n) => Math.round(n * 100) / 100;
  return { position: "fixed", inset: "auto", left: round(offsetLeft), top: round(offsetTop), width: round(width), height: round(height) };
}

/** The style of a layer that covers the visible part: the zoom-aware box when the page is pinch-zoomed, else the keyboard's frame; null when it is the whole window. */
export function layerStyleFor(vv, windowHeight) {
  if (!vv) return null;
  return Math.abs(vv.scale - 1) >= 0.01 ? boxFor(vv) : frameFor(vv, windowHeight);
}

const LAYER_PROPERTIES = ["position", "inset", "left", "top", "width", "height", "transform", "transformOrigin"];

/**
 * Keeps the element `ref` points at on the visible part: its style is written directly at each visual-viewport `resize` and `scroll` (not through
 * React state: a state update per scroll event renders a frame late on iOS, where the viewport moves while the person drags), `data-frame` marks it
 * while it differs from the window, and the properties go again when the visible part is the whole window.
 */
export function useVisibleLayer(ref) {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return undefined;
    const apply = () => {
      const el = ref.current;
      if (!el) return;
      const style = layerStyleFor(vv, window.innerHeight);
      for (const key of LAYER_PROPERTIES) el.style[key] = style && key in style ? (typeof style[key] === "number" ? `${style[key]}px` : style[key]) : "";
      if (style) el.setAttribute("data-frame", "");
      else el.removeAttribute("data-frame");
    };
    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    // A rotation changes the window itself: its own events recompute too (the visual viewport's may come after, or not at all).
    window.addEventListener("resize", apply);
    window.addEventListener("orientationchange", apply);
    return () => {
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
      window.removeEventListener("resize", apply);
      window.removeEventListener("orientationchange", apply);
    };
  }, [ref]);
}

/** `boxFor` of the window's visual viewport, kept current while the person pinches or scrolls it. */
export function useVisualViewportBox() {
  const [box, setBox] = useState(() => boxFor(typeof window === "undefined" ? null : window.visualViewport));
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return undefined;
    const update = () => setBox(boxFor(vv));
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);
  return box;
}
