// How large a picture in a bubble is drawn: in its own shape, fitted inside a box, as the mainstream chat apps do. Only an
// extreme shape (wider than 2.5:1, taller than 1:2.5) is cut: to that ratio, from the middle (the image's `object-fit: cover`),
// so a panorama or a long screenshot is neither a sliver nor a whole screen.

import { ONE_COLUMN_MAX } from "./breakpoints.js";

export const THUMB = { maxWidth: 280, maxHeight: 320, minSide: 96, extreme: 2.5 };

/** The widest picture box (px) for a window `viewportWidth` wide: 280 where there are several columns; on a phone 70% of the bubble column (82% of the list, which has 12px of padding a side). */
export function thumbMaxWidth(viewportWidth) {
  if (!(viewportWidth <= ONE_COLUMN_MAX)) return THUMB.maxWidth;
  return Math.max(THUMB.minSide, Math.min(THUMB.maxWidth, Math.round(0.7 * 0.82 * (viewportWidth - 24))));
}

const valid = (n) => typeof n === "number" && Number.isFinite(n) && n > 0;

/**
 * The box `{width, height, cropped}` (whole px) for a picture of `width` × `height` pixels: its own ratio (clamped to 2.5:1 to
 * 1:2.5; `cropped` says it was) scaled to the largest size inside `maxWidth` × `maxHeight`, never larger than the picture itself,
 * and raised until its short side is `minSide` (still inside the bounds). `null` for dimensions that are missing or not numbers.
 */
export function thumbSize(natural, { maxWidth = THUMB.maxWidth, maxHeight = THUMB.maxHeight, minSide = THUMB.minSide } = {}) {
  if (!natural || !valid(natural.width) || !valid(natural.height)) return null;
  let { width, height } = natural;
  let cropped = false;
  if (width / height > THUMB.extreme) {
    width = height * THUMB.extreme;
    cropped = true;
  } else if (height / width > THUMB.extreme) {
    height = width * THUMB.extreme;
    cropped = true;
  }
  const fit = Math.min(maxWidth / width, maxHeight / height);
  let scale = Math.min(1, fit);
  if (Math.min(width, height) * scale < minSide) scale = Math.min(fit, minSide / Math.min(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale), cropped };
}
