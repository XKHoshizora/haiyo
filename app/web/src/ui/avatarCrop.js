// The arithmetic of the avatar adjust dialog. Pure: no DOM, no canvas (those are in avatarImage.js), so every rule is a test.
//
// The picture is placed in a square stage of `STAGE` units (the circle is its inscribed circle; the saved crop is the whole
// square, so what the circle shows is always inside it). A `view` is `{zoom, cx, cy}`: `zoom` 1 is "the short side fills the
// stage" (the picture is never smaller than that), and `(cx, cy)` is the picture point (in pixels of the picture, after its
// EXIF orientation is applied) that sits at the stage's centre. A view that is valid shows no empty space anywhere in the square.

/** The stage's side in the units the math uses; the screen scales it. */
export const STAGE = 280;
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 5;
/** The saved picture: this many pixels square. */
export const OUTPUT_SIZE = 512;
/** Encoder qualities tried one after the other until the result fits the service's limit. */
export const QUALITY_STEPS = [0.92, 0.85, 0.78, 0.7, 0.6, 0.5, 0.4, 0.3];
/**
 * What the client accepts to start from: any picture this browser can decode, up to 20 MB. The file picker is offered every picture
 * (`PICK_ACCEPT`): a phone's photos are HEIC as often as JPEG, and whether one can be read is the decoder's answer (avatarImage.js),
 * not a list's — the original never leaves the device, only the 512 × 512 crop made from it. No side is too long: a large photo is
 * decoded at a working size (`decodeResize`). The one size refused is a picture of more pixels than any camera makes
 * (`MAX_PICK_PIXELS`), which a 20 MB file can still claim and no device could hold.
 */
export const PICK_ACCEPT = "image/*";
/** The names of pictures, for a file the browser gives no type for (or types as plain bytes). */
const PICTURE_NAME = /\.(png|jpe?g|webp|heic|heif|avif|gif|bmp|tiff?)$/i;
/** The types that say nothing of what the file is: the name is asked then. */
const NO_TYPE = ["", "application/octet-stream"];
export const MAX_PICK_BYTES = 20 * 1024 * 1024;
/** More pixels than this are not decoded (a phone's largest photo is 200 megapixels). */
export const MAX_PICK_PIXELS = 300_000_000;
/** What the service accepts as an avatar (it decides by the bytes): the saved result must fit. */
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** The reason a picked file cannot be started from, or "" when it may be tried. */
export function pickProblem(file) {
  const picture = /^image\//.test(file.type) || (NO_TYPE.includes(file.type) && PICTURE_NAME.test(file.name));
  if (!picture) return "这个文件不是图片，请换一张。";
  if (file.size > MAX_PICK_BYTES) return "图片不能超过 20 MB。";
  return "";
}

/** Whether a file is of a kind some browsers cannot open (HEIC, HEIF, AVIF, TIFF), by its type or its name: what a failed decode says depends on it. */
export const mayBeUnknownFormat = (file) => /^image\/(hei[cf]|avif|tiff)/i.test(file.type ?? "") || /\.(heic|heif|avif|tiff?)$/i.test(file.name ?? "");

/** The reason a picture of `width` × `height` pixels cannot be worked with, or "". */
export function sizeProblem(width, height) {
  if (!(width >= 1 && height >= 1)) return "这张图片无法读取，请换一张。";
  if (width * height > MAX_PICK_PIXELS) return "图片太大（超过 3 亿像素），请换一张。";
  return "";
}

/** Pixels of the picture → stage units, for `zoom` 1: the short side fills the stage. */
export const coverScale = (width, height) => STAGE / Math.min(width, height);
export const scaleOf = (view, width, height) => coverScale(width, height) * view.zoom;

/** The view a picture starts in: centred, short side filling the stage. */
export const initialView = (width, height) => ({ zoom: MIN_ZOOM, cx: width / 2, cy: height / 2 });

/** The nearest valid view: zoom within its limits and the picture covering the whole stage. */
export function clampView(view, width, height) {
  const zoom = clamp(Number.isFinite(view.zoom) ? view.zoom : MIN_ZOOM, MIN_ZOOM, MAX_ZOOM);
  const half = Math.min(width, height) / (2 * zoom); // half the stage, in picture pixels (exactly, not by the scale)
  // The short side is never shorter than the stage, so `half` never exceeds half of either side.
  const cx = clamp(Number.isFinite(view.cx) ? view.cx : width / 2, half, width - half);
  const cy = clamp(Number.isFinite(view.cy) ? view.cy : height / 2, half, height - half);
  return { zoom, cx, cy };
}

/** Moves the picture by `dx`, `dy` stage units (a drag: the picture follows the pointer). */
export function panBy(view, dx, dy, width, height) {
  const s = scaleOf(view, width, height);
  return clampView({ zoom: view.zoom, cx: view.cx - dx / s, cy: view.cy - dy / s }, width, height);
}

/** Zooms to `zoom` keeping the picture point under the stage point (`px`, `py`) where it is (the stage's centre by default). */
export function zoomAbout(view, zoom, width, height, px = STAGE / 2, py = STAGE / 2) {
  const next = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
  const before = scaleOf(view, width, height);
  const after = coverScale(width, height) * next;
  const ix = view.cx + (px - STAGE / 2) / before;
  const iy = view.cy + (py - STAGE / 2) / before;
  return clampView({ zoom: next, cx: ix - (px - STAGE / 2) / after, cy: iy - (py - STAGE / 2) / after }, width, height);
}

/** The zoom a wheel turn of `deltaY` (as the browser reports it, in pixels) makes of `zoom`: smooth, the same both ways. */
export const wheelZoom = (zoom, deltaY) => clamp(zoom * Math.exp(-deltaY * 0.0015), MIN_ZOOM, MAX_ZOOM);

/** The next zoom of a `+` / `-` press or button: 15% a step. */
export const stepZoom = (zoom, direction) => clamp(direction > 0 ? zoom * 1.15 : zoom / 1.15, MIN_ZOOM, MAX_ZOOM);

/**
 * A pinch: `start` is `{view, distance, mid: {x, y}}` when the second finger went down; `now` is `{distance, mid}`. The
 * picture is scaled by the change of distance about the start midpoint, and moved with the midpoint.
 */
export function pinch(start, now, width, height) {
  if (!(start.distance > 0) || !(now.distance > 0)) return start.view;
  const zoomed = zoomAbout(start.view, start.view.zoom * (now.distance / start.distance), width, height, start.mid.x, start.mid.y);
  return panBy(zoomed, now.mid.x - start.mid.x, now.mid.y - start.mid.y, width, height);
}

/** Where the picture sits in the stage, as fractions of the stage (for CSS percentages): left, top, width, height. */
export function placement(view, width, height) {
  const s = scaleOf(view, width, height);
  return {
    left: (STAGE / 2 - view.cx * s) / STAGE,
    top: (STAGE / 2 - view.cy * s) / STAGE,
    width: (width * s) / STAGE,
    height: (height * s) / STAGE,
  };
}

/** The square of the picture the stage shows, in picture pixels: `{x, y, size}`. */
export function sourceRect(view, width, height) {
  const size = STAGE / scaleOf(view, width, height);
  return { x: view.cx - size / 2, y: view.cy - size / 2, size };
}

// ───────── EXIF orientation

/**
 * The EXIF orientation (1–8) of a JPEG given its first bytes (a `Uint8Array`), or 1 for anything else: a PNG or WebP, a
 * JPEG without the tag, a damaged one. Only the APP1 segment is read, and never past the end.
 */
export function exifOrientation(bytes) {
  const n = bytes.length;
  if (n < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return 1;
  let p = 2;
  while (p + 4 <= n) {
    if (bytes[p] !== 0xff) return 1;
    const marker = bytes[p + 1];
    if (marker === 0xff) {
      p += 1;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return 1; // the picture itself starts: no EXIF came before it
    const length = (bytes[p + 2] << 8) | bytes[p + 3];
    if (length < 2) return 1;
    if (marker === 0xe1 && p + 4 + 6 <= n && bytes[p + 4] === 0x45 && bytes[p + 5] === 0x78 && bytes[p + 6] === 0x69 && bytes[p + 7] === 0x66) {
      return orientationOfTiff(bytes, p + 10, Math.min(n, p + 2 + length));
    }
    p += 2 + length;
  }
  return 1;
}

function orientationOfTiff(bytes, start, end) {
  if (start + 8 > end) return 1;
  const little = bytes[start] === 0x49 && bytes[start + 1] === 0x49;
  if (!little && !(bytes[start] === 0x4d && bytes[start + 1] === 0x4d)) return 1;
  const u16 = (at) => (at + 2 > end ? -1 : little ? bytes[at] | (bytes[at + 1] << 8) : (bytes[at] << 8) | bytes[at + 1]);
  const u32 = (at) => (at + 4 > end ? -1 : little ? (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0 : ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0);
  if (u16(start + 2) !== 42) return 1;
  const offset = u32(start + 4);
  if (offset < 0) return 1;
  const ifd = start + offset;
  const count = u16(ifd);
  if (count < 0) return 1;
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

/**
 * The bytes of a JPEG with an EXIF segment that says `orientation` (1–8) put right after its start (any EXIF it had is left
 * where it is: the first one a reader meets wins, as in `exifOrientation`). The browser side makes a 2 × 1 picture of this to
 * learn whether the browser turns a picture by itself (avatarImage.js).
 */
export function withExifOrientation(jpeg, orientation) {
  const tiff = [0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, orientation, 0, 0, 0, 0, 0, 0, 0];
  const exif = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const segment = [0xff, 0xe1, 0, exif.length + 2, ...exif];
  return Uint8Array.from([...jpeg.subarray(0, 2), ...segment, ...jpeg.subarray(2)]);
}

/** The size of a picture of `width` × `height` stored pixels once its orientation is applied (5–8 turn it on its side). */
export const orientedSize = (width, height, orientation) => (orientation >= 5 && orientation <= 8 ? { width: height, height: width } : { width, height });

/**
 * The transform `[a, b, c, d, e, f]` (canvas `setTransform`) that takes a stored pixel to its place in the oriented
 * picture, for a stored picture of `width` × `height`.
 */
export function orientationMatrix(orientation, width, height) {
  switch (orientation) {
    case 2: return [-1, 0, 0, 1, width, 0]; // mirrored
    case 3: return [-1, 0, 0, -1, width, height]; // upside down
    case 4: return [1, 0, 0, -1, 0, height]; // mirrored upside down
    case 5: return [0, 1, 1, 0, 0, 0]; // transposed
    case 6: return [0, 1, -1, 0, height, 0]; // a quarter turn clockwise
    case 7: return [0, -1, -1, 0, height, width]; // transversed
    case 8: return [0, -1, 1, 0, 0, width]; // a quarter turn counter-clockwise
    default: return [1, 0, 0, 1, 0, 0];
  }
}

/**
 * The canvas transform that paints the stored picture so that the `rect` of the oriented picture fills an output of
 * `out` pixels square: orientation first, then the crop moves to the origin and is scaled.
 */
export function cropTransform(rect, out, orientation, width, height) {
  const [a, b, c, d, e, f] = orientationMatrix(orientation, width, height);
  const k = out / rect.size;
  return [a * k, b * k, c * k, d * k, (e - rect.x) * k, (f - rect.y) * k];
}

// ───────── size from the header

/**
 * The size `{width, height}` of the largest picture in an ISO container (HEIC, HEIF, AVIF: what a phone's camera saves) read from its
 * first bytes, or null when the bytes are not one or say no size. It is the size BEFORE the turn the file asks for (`irot`), and
 * a grid's tiles and a thumbnail have sizes of their own there (the whole picture is the largest): good for the pixel bound and as
 * the two shapes to try a working-size decode with (as stated, and turned: avatarImage.js `decodeContainer`) — `imageSize`, whose
 * answer the decode trusts as the picture's stored shape, says null.
 */
export function containerSize(bytes) {
  const n = bytes.length;
  const ascii = (at, text) => at + text.length <= n && [...text].every((c, i) => bytes[at + i] === c.charCodeAt(0));
  const be32 = (at) => ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
  if (!ascii(4, "ftyp")) return null;
  let best = null;
  // Every `ispe` property (its type, four bytes of version and flags, then width and height as 32-bit big-endian numbers).
  for (let at = 8; at + 16 <= n; at += 1) {
    if (bytes[at] !== 0x69 || !ascii(at, "ispe")) continue;
    const width = be32(at + 8);
    const height = be32(at + 12);
    if (width > 0 && height > 0 && (!best || width * height > best.width * best.height)) best = { width, height };
  }
  return best;
}

/**
 * The stored size `{width, height}` of a PNG, JPEG or WebP read from its first bytes, without decoding it, or null when the
 * header is not there (a format not known, cut off, damaged, a JPEG whose frame header lies beyond the bytes given). The
 * decode is sized by it (`decodeResize`), and the pixel bound is checked on it before a picture is decoded: a 20 MB file can
 * claim a far larger picture than a device can hold.
 */
export function imageSize(bytes) {
  const n = bytes.length;
  const be16 = (at) => (bytes[at] << 8) | bytes[at + 1];
  const le16 = (at) => bytes[at] | (bytes[at + 1] << 8);
  const le24 = (at) => bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16);
  const ascii = (at, text) => at + text.length <= n && [...text].every((c, i) => bytes[at + i] === c.charCodeAt(0));
  // PNG: the signature, then IHDR first: width and height as 32-bit big-endian numbers.
  if (n >= 24 && bytes[0] === 0x89 && ascii(1, "PNG") && ascii(12, "IHDR")) {
    const w = ((bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19]) >>> 0;
    const h = ((bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23]) >>> 0;
    return w > 0 && h > 0 ? { width: w, height: h } : null;
  }
  // JPEG: walk the segments to the first frame header (any SOFn but DHT, JPG and DAC), whatever came before it.
  if (n >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let p = 2;
    while (p + 4 <= n) {
      if (bytes[p] !== 0xff) return null;
      const marker = bytes[p + 1];
      if (marker === 0xff) {
        p += 1;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        p += 2; // markers without a length
        continue;
      }
      if (marker === 0xda || marker === 0xd9) return null;
      const length = be16(p + 2);
      if (length < 2) return null;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        if (p + 9 > n) return null;
        const h = be16(p + 5);
        const w = be16(p + 7);
        return w > 0 && h > 0 ? { width: w, height: h } : null;
      }
      p += 2 + length;
    }
    return null;
  }
  // WebP: RIFF, the size, "WEBP", then the first chunk: VP8 (lossy), VP8L (lossless) or VP8X (extended).
  if (n >= 25 && ascii(0, "RIFF") && ascii(8, "WEBP")) {
    if (n >= 30 && ascii(12, "VP8X")) return { width: le24(24) + 1, height: le24(27) + 1 };
    if (ascii(12, "VP8L") && bytes[20] === 0x2f) {
      const b = [bytes[21], bytes[22], bytes[23], bytes[24]];
      return { width: 1 + (((b[1] & 0x3f) << 8) | b[0]), height: 1 + (((b[3] & 0x0f) << 10) | (b[2] << 2) | ((b[1] & 0xc0) >> 6)) };
    }
    if (n >= 30 && ascii(12, "VP8 ") && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      const w = le16(26) & 0x3fff;
      const h = le16(28) & 0x3fff;
      return w > 0 && h > 0 ? { width: w, height: h } : null;
    }
  }
  return null;
}

/** The short side a decode needs at most: 512 pixels at the highest zoom. More is never seen in the saved picture. */
export const DECODE_SHORT_SIDE = OUTPUT_SIZE * MAX_ZOOM;

/** The pixels a working picture has at most: four squares of that short side (a 4 : 1 picture at full sharpness; a longer one is kept smaller). */
export const MAX_WORK_PIXELS = DECODE_SHORT_SIDE * DECODE_SHORT_SIDE * 4;

/**
 * How to decode a picture of `width` × `height` (as it will be upright) at a size that costs little — the working picture, which
 * stands in for the original (the crop is still reckoned in the original's pixels): the one resize option that brings its short side
 * to `DECODE_SHORT_SIDE`, or lower for a very long picture so that the whole stays within `MAX_WORK_PIXELS` (the other side follows
 * by the aspect ratio), or null when it is small enough as it is.
 */
export function decodeResize(width, height) {
  const short = Math.min(width, height);
  const k = Math.min(1, DECODE_SHORT_SIDE / short, Math.sqrt(MAX_WORK_PIXELS / (width * height)));
  if (!(k < 1)) return null;
  const side = Math.max(1, Math.round(short * k));
  return width <= height ? { resizeWidth: side } : { resizeHeight: side };
}
