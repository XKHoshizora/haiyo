// The viewer's zoom and pan arithmetic (ui/ImageViewer.jsx). A view is `{scale, x, y}`: the picture, laid out to fit the
// window at 1x, is scaled about its centre and moved by (x, y) pixels. Points are measured from the window's centre.

export const MIN_SCALE = 1;
export const MAX_SCALE = 4;
/** A double click or tap zooms to this. */
const DOUBLE_SCALE = 2;
/** One press of + or -. */
const KEY_STEP = 1.25;
/** A swipe at 1x: this far down closes, this far sideways (and mostly sideways) goes to the neighbour. */
const SWIPE_MIN = 60;
const SWIPE_CLOSE_MIN = 80;
const SWIPE_SLANT = 1.5;

/** A picture not zoomed. */
export const FIT = Object.freeze({ scale: 1, x: 0, y: 0 });

export const clampScale = (scale) => (Number.isFinite(scale) ? Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale)) : MIN_SCALE);

const room = (shown, window) => Math.max(0, (shown - window) / 2);

/** The pan held so that the picture's edge never goes in past the window's edge; a picture that fits on an axis stays centred there. */
export function clampPan({ x, y }, scale, stage, image) {
  const mx = room(image.w * scale, stage.w);
  const my = room(image.h * scale, stage.h);
  return { x: Math.min(mx, Math.max(-mx, x)) || 0, y: Math.min(my, Math.max(-my, y)) || 0 };
}

/** The view at `scale` (held to its limits) with the point `at` of the window still over the same point of the picture. */
export function zoomAt(view, scale, at, stage, image) {
  const next = clampScale(scale);
  if (next === MIN_SCALE) return { ...FIT };
  const k = next / view.scale;
  return { scale: next, ...clampPan({ x: at.x - (at.x - view.x) * k, y: at.y - (at.y - view.y) * k }, next, stage, image) };
}

/** Double click or tap: from fit to 2x at the point; from any zoom back to fit. */
export const toggleZoom = (view, at, stage, image) => (view.scale > MIN_SCALE ? { ...FIT } : zoomAt(view, DOUBLE_SCALE, at, stage, image));

/** How much one wheel event zooms: a trackpad's pinch arrives as a wheel with ctrl held, finer and faster. */
export function wheelFactor({ deltaY, deltaMode, ctrlKey }) {
  const pixels = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 100 : deltaY;
  return Math.exp(-pixels * (ctrlKey ? 0.01 : 0.002));
}

/** The view after a zoom key (`+`, `=`, `-`, `0`) about the window's centre; null for any other key. */
export function keyZoom(key, view, stage, image) {
  const middle = { x: 0, y: 0 };
  if (key === "+" || key === "=") return zoomAt(view, view.scale * KEY_STEP, middle, stage, image);
  if (key === "-" || key === "_") return zoomAt(view, view.scale / KEY_STEP, middle, stage, image);
  if (key === "0") return { ...FIT };
  return null;
}

/** What a finger's travel (dx, dy) at 1x asks: "close" (down), "next" (left), "previous" (right) or null. */
export function swipeOf(dx, dy) {
  if (dy >= SWIPE_CLOSE_MIN && dy > Math.abs(dx) * SWIPE_SLANT) return "close";
  if (Math.abs(dx) >= SWIPE_MIN && Math.abs(dx) > Math.abs(dy) * SWIPE_SLANT) return dx < 0 ? "next" : "previous";
  return null;
}
