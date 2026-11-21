// The browser side of the avatar adjust dialog: decoding the picked file (with its EXIF orientation) and cutting the chosen
// square out of it. Everything it computes is in avatarCrop.js; this file only talks to the DOM, so tests replace it whole.
import {
  MAX_AVATAR_BYTES,
  OUTPUT_SIZE,
  QUALITY_STEPS,
  cropTransform,
  exifOrientation,
  orientedSize,
  sizeProblem,
  sourceRect,
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

async function bitmapOf(file) {
  // Stored pixels as they are: the orientation is applied by `cropTransform`, the same way for the stage and the result.
  try {
    return await createImageBitmap(file, { imageOrientation: "none" });
  } catch {
    throw new AvatarProblem("这张图片无法读取，请换一张。");
  }
}

/**
 * Decodes the picked file. Resolves `{width, height, paint(canvas), crop(view), close()}`: `width`, `height` are the
 * picture's size once its orientation is applied; `paint` draws it into the stage's canvas; `crop(view)` resolves the saved
 * `File` (512 × 512, WebP — JPEG where WebP cannot be encoded — under the service's limit). Rejects with an `AvatarProblem`.
 */
export async function decodeAvatar(file) {
  const head = new Uint8Array(await file.slice(0, 128 * 1024).arrayBuffer());
  const orientation = exifOrientation(head);
  const bitmap = await bitmapOf(file);
  const stored = { width: bitmap.width, height: bitmap.height };
  const size = orientedSize(stored.width, stored.height, orientation);
  const problem = sizeProblem(size.width, size.height) || sizeProblem(stored.width, stored.height);
  if (problem) {
    bitmap.close?.();
    throw new AvatarProblem(problem);
  }

  const draw = (canvas, rect, out, quality) => {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new AvatarProblem("这个浏览器不能处理图片。");
    canvas.width = out;
    canvas.height = out;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = quality;
    ctx.setTransform(...cropTransform(rect, out, orientation, stored.width, stored.height));
    ctx.drawImage(bitmap, 0, 0);
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
      ctx.setTransform(...cropTransform({ x: 0, y: 0, size: size.width }, size.width * k, orientation, stored.width, stored.height));
      ctx.drawImage(bitmap, 0, 0);
    },
    /** The saved picture of the square `view` shows. */
    async crop(view) {
      const canvas = document.createElement("canvas");
      draw(canvas, sourceRect(view, size.width, size.height), OUTPUT_SIZE, "high");
      for (const type of ["image/webp", "image/jpeg"]) {
        for (const quality of QUALITY_STEPS) {
          const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, quality));
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
