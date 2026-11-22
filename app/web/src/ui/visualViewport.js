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
