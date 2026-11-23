// The browser side of the avatar adjust dialog: decoding the picked file (with its EXIF orientation) and cutting the chosen
// square out of it. Everything it computes is in avatarCrop.js; this file only talks to the DOM, so tests replace it whole.
import {
  MAX_AVATAR_BYTES,
  OUTPUT_SIZE,
  QUALITY_STEPS,
  containerSize,
  cropTransform,
  decodeResize,
  exifOrientation,
  imageSize,
  orientedSize,
  sizeProblem,
  sourceRect,
  withExifOrientation,
} from "./avatarCrop.js";

/** What went wrong in a way the person can read: `text` is the sentence. */
export class AvatarProblem extends Error {
  constructor(text) {
    super(text);
    this.text = text;
  }
}

/** The longest side of the picture the stage paints (a copy of the oriented picture; the saved crop is cut from the original). */
const PREVIEW_SIDE = 1600;

let engineTurns = null;

/**
 * Whether this browser turns a picture by its EXIF orientation when it decodes it (every current one does, and `imageOrientation:
 * "none"` is not honoured by all of them, so it is asked once with a 2 × 1 picture marked as turned a quarter). When it cannot
 * be found out, the browser is trusted: a picture is never turned twice.
 */
function browserTurnsPictures() {
  engineTurns ??= (async () => {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 2;
      canvas.height = 1;
      canvas.getContext("2d").fillRect(0, 0, 2, 1);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg"));
      const marked = withExifOrientation(new Uint8Array(await blob.arrayBuffer()), 6);
      const bitmap = await createImageBitmap(new Blob([marked], { type: "image/jpeg" }));
      const turned = bitmap.width === 1 && bitmap.height === 2;
      bitmap.close?.();
      return turned;
    } catch {
      return true;
    }
  })();
  return engineTurns;
}

async function bitmapOf(file) {
  try {
    return await createImageBitmap(file);
  } catch {
    throw new AvatarProblem("这张图片无法读取，请换一张。");
  }
}

/** How much of the file's start is read for the header: the size, and the EXIF tag (a JPEG's may come after a large segment). */
const HEAD_BYTES = 256 * 1024;

/** A decode at a reduced size, or the whole picture when that is not asked for or this browser cannot (or does it wrongly). */
async function decodeSmall(file, full) {
  const resize = full ? decodeResize(full.width, full.height) : null;
  if (!resize) return bitmapOf(file);
  try {
    const bitmap = await createImageBitmap(file, { ...resize, resizeQuality: "high" });
    // Which side the browser resized is told by the shape it got: a different shape than the picture's is a wrong turn.
    if (Math.abs(bitmap.width / bitmap.height / (full.width / full.height) - 1) < 0.02) return bitmap;
    bitmap.close?.();
  } catch {
    /* no resize options here: the whole picture, below */
  }
  return bitmapOf(file);
}

/**
 * Decodes the picked file. Resolves `{width, height, paint(canvas), crop(view), close()}`: `width`, `height` are the
 * picture's size once its orientation is applied (in the pixels of the original, however small the decode is kept); `paint`
 * draws it into the stage's canvas; `crop(view)` resolves the saved `File` (512 × 512, WebP — JPEG where WebP cannot be
 * encoded — under the service's limit). The size rule is checked on the file's header, before anything is decoded: a PNG's, a
 * JPEG's, a WebP's, and a HEIC's, HEIF's or AVIF's (`containerSize`: a phone's photo). A format whose header is not read is decoded
 * whole and checked after; a decode the browser gives up on (too large for it, or a format it does not know) is the 无法读取 sentence.
 * The picture's turn: a JPEG's EXIF orientation is read here and applied unless the browser already did (`browserTurnsPictures`);
 * any other format is decoded by `createImageBitmap` with its default (`imageOrientation: "from-image"`), so the browser turns it.
 * Rejects with an `AvatarProblem`.
 */
export async function decodeAvatar(file) {
  const head = new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer());
  const header = imageSize(head);
  // (A HEIC's size is used for this refusal only: it is the size before the file's own turn, so not the shape the decode gives.)
  const stated = header ?? containerSize(head);
  const early = stated ? sizeProblem(stated.width, stated.height) : "";
  if (early) throw new AvatarProblem(early);

  // A browser that already turned the picture needs no turn of ours: its bitmap is upright (orientation 1 from here on).
  const tagged = exifOrientation(head);
  const turns = tagged !== 1 && (await browserTurnsPictures());
  const orientation = turns ? 1 : tagged;
  // The picture's own size in the convention of the bitmap (upright when the browser turned it, as stored when not).
  const known = header ? (turns ? orientedSize(header.width, header.height, tagged) : header) : null;
  const bitmap = await decodeSmall(file, known);
  const full = known ?? { width: bitmap.width, height: bitmap.height };
  const size = orientedSize(full.width, full.height, orientation);
  const problem = sizeProblem(size.width, size.height) || sizeProblem(full.width, full.height);
  if (problem) {
    bitmap.close?.();
    throw new AvatarProblem(problem);
  }

  /** Paints the bitmap, as large as the original, through the transform of `rect` into `canvas` of `out` pixels. */
  const draw = (canvas, rect, out, quality) => {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new AvatarProblem("这个浏览器不能处理图片。");
    canvas.width = out;
    canvas.height = out;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = quality;
    ctx.setTransform(...cropTransform(rect, out, orientation, full.width, full.height));
    ctx.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, 0, 0, full.width, full.height);
  };
  /** A copy on white: a JPEG has no transparency, and a transparent picture would come out black. */
  const onWhite = (canvas) => {
    const flat = document.createElement("canvas");
    flat.width = canvas.width;
    flat.height = canvas.height;
    const ctx = flat.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, flat.width, flat.height);
    ctx.drawImage(canvas, 0, 0);
    return flat;
  };

  return {
    width: size.width,
    height: size.height,
    /** The whole oriented picture into `canvas`, at most `PREVIEW_SIDE` on its long side. */
    paint(canvas) {
      const k = Math.min(1, PREVIEW_SIDE / Math.max(size.width, size.height));
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      canvas.width = Math.max(1, Math.round(size.width * k));
      canvas.height = Math.max(1, Math.round(size.height * k));
      ctx.imageSmoothingQuality = "high";
      ctx.setTransform(...cropTransform({ x: 0, y: 0, size: size.width }, size.width * k, orientation, full.width, full.height));
      ctx.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, 0, 0, full.width, full.height);
    },
    /** The saved picture of the square `view` shows. */
    async crop(view) {
      const canvas = document.createElement("canvas");
      draw(canvas, sourceRect(view, size.width, size.height), OUTPUT_SIZE, "high");
      let flat = null;
      for (const type of ["image/webp", "image/jpeg"]) {
        const source = type === "image/jpeg" ? (flat ??= onWhite(canvas)) : canvas;
        for (const quality of QUALITY_STEPS) {
          const blob = await new Promise((resolve) => source.toBlob(resolve, type, quality));
          if (!blob || blob.type !== type) break; // this browser cannot encode this type: the next one
          if (blob.size <= MAX_AVATAR_BYTES) return new File([blob], type === "image/webp" ? "avatar.webp" : "avatar.jpg", { type });
        }
      }
      throw new AvatarProblem("头像处理失败，请换一张图片。");
    },
    close() {
      bitmap.close?.();
    },
  };
}
