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
  mayBeUnknownFormat,
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

/** The whole picture, decoded as it is. A decode the browser gives up on says why as far as it can be known (`mayBeUnknownFormat`). */
async function bitmapOf(file) {
  try {
    return await createImageBitmap(file);
  } catch {
    throw new AvatarProblem(mayBeUnknownFormat(file) ? "这个浏览器打不开这张图片，请换成 JPG 或 PNG 格式。" : "这张图片无法读取，请换一张。");
  }
}

/** How much of the file's start is read for the header: the size, and the EXIF tag (a JPEG's may come after a large segment). */
const HEAD_BYTES = 256 * 1024;

/** Whether a bitmap has the shape of a picture of `full` size (the browser resized one side; the other followed). */
const sameShape = (bitmap, full) => Math.abs(bitmap.width / bitmap.height / (full.width / full.height) - 1) < 0.02;

/**
 * The picture decoded at its working size (`decodeResize`) when its size `full` is known and large, else — also where this browser
 * has no resize options, or gives another shape than the picture's — null: the caller decodes the whole picture.
 */
async function workingBitmap(file, full) {
  const resize = decodeResize(full.width, full.height);
  if (!resize) return null;
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { ...resize, resizeQuality: "high" });
  } catch {
    return null; // no resize options here
  }
  // Which side the browser resized is told by the shape it got: a different shape than the picture's is a wrong turn.
  return sameShape(bitmap, full) ? bitmap : { wrong: bitmap };
}

/** A picture whose stored size is known (PNG, JPEG, WebP): at its working size, or whole. `full` is its size as the bitmap has it. */
async function decodeKnown(file, full) {
  const made = await workingBitmap(file, full);
  if (made && !made.wrong) return made;
  made?.wrong.close?.();
  return bitmapOf(file);
}

/**
 * A picture in a container (HEIC, HEIF, AVIF), whose header says its size before the turn the file asks for — which the browser
 * applies. So the working-size decode is tried for the stated shape and, when the bitmap that comes back is the other way up, for
 * the turned one (the first try is released). Resolves `{bitmap, full}`: `full` the upright picture's own size; the whole picture
 * when it is small, or when neither try fits (no resize options here, or a size that was not the whole picture's).
 */
async function decodeContainer(file, stated) {
  const turned = { width: stated.height, height: stated.width };
  for (const full of [stated, turned]) {
    const made = await workingBitmap(file, full);
    if (!made) break;
    if (!made.wrong) return { bitmap: made, full };
    const other = full === stated && sameShape(made.wrong, turned);
    made.wrong.close?.();
    if (!other) break;
  }
  const bitmap = await bitmapOf(file);
  return { bitmap, full: { width: bitmap.width, height: bitmap.height } };
}

/**
 * Decodes the picked file. Resolves `{width, height, paint(canvas), crop(view), close()}`: `width`, `height` are the
 * picture's size once its orientation is applied (in the pixels of the original, however small the decode is kept); `paint`
 * draws it into the stage's canvas; `crop(view)` resolves the saved `File` (512 × 512, WebP — JPEG where WebP cannot be
 * encoded — under the service's limit).
 * A large picture is never refused for its sides: it is decoded at a working size (`decodeResize`: the saved picture is 512 × 512,
 * so a short side of 2560 is all that can ever be seen), and everything after — the view, the crop — is still reckoned in the
 * original's pixels: the working bitmap is drawn over the original's size (`draw`). The size is read from the file's header: a
 * PNG's, a JPEG's, a WebP's (`imageSize`), and a HEIC's, HEIF's or AVIF's (`containerSize`: a phone's photo). A format whose
 * header is not read (a GIF, a BMP) is decoded whole. What is refused: more pixels than any camera makes (`sizeProblem`, from the
 * header, before anything is decoded), and a decode the browser gives up on (too large for this device, damaged, or a format it
 * does not know).
 * The picture's turn: a JPEG's EXIF orientation is read here and applied unless the browser already did (`browserTurnsPictures`);
 * any other format is decoded by `createImageBitmap` with its default (`imageOrientation: "from-image"`), so the browser turns it.
 * Rejects with an `AvatarProblem`.
 */
export async function decodeAvatar(file) {
  const head = new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer());
  const header = imageSize(head);
  const container = header ? null : containerSize(head);
  const stated = header ?? container;
  const early = stated ? sizeProblem(stated.width, stated.height) : "";
  if (early) throw new AvatarProblem(early);

  // A browser that already turned the picture needs no turn of ours: its bitmap is upright (orientation 1 from here on).
  const tagged = exifOrientation(head);
  const turns = tagged !== 1 && (await browserTurnsPictures());
  const orientation = turns ? 1 : tagged;
  let bitmap;
  let full;
  if (header) {
    // The picture's own size in the convention of the bitmap (upright when the browser turned it, as stored when not).
    full = turns ? orientedSize(header.width, header.height, tagged) : header;
    bitmap = await decodeKnown(file, full);
  } else if (container) {
    ({ bitmap, full } = await decodeContainer(file, container));
  } else {
    bitmap = await bitmapOf(file);
    full = { width: bitmap.width, height: bitmap.height };
  }
  const size = orientedSize(full.width, full.height, orientation);
  const problem = sizeProblem(size.width, size.height);
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
