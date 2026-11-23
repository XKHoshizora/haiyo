// The arithmetic of the avatar adjust dialog (src/ui/avatarCrop.js): limits, clamping, zoom about a point, orientation.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_PICK_BYTES,
  MAX_PICK_PIXELS,
  MAX_WORK_PIXELS,
  MAX_ZOOM,
  MIN_ZOOM,
  OUTPUT_SIZE,
  STAGE,
  clampView,
  coverScale,
  cropTransform,
  DECODE_SHORT_SIDE,
  decodeResize,
  exifOrientation,
  PICK_ACCEPT,
  containerSize,
  imageSize,
  initialView,
  orientationMatrix,
  orientedSize,
  panBy,
  pickProblem,
  pinch,
  placement,
  scaleOf,
  sizeProblem,
  sourceRect,
  stepZoom,
  wheelZoom,
  withExifOrientation,
  zoomAbout,
} from "../src/ui/avatarCrop.js";

const near = (a, b, digits = 6) => expect(a).toBeCloseTo(b, digits);

/** Whether the view shows no empty space: the shown square lies inside the picture. */
function covers(view, w, h) {
  const r = sourceRect(view, w, h);
  return r.x >= -1e-9 && r.y >= -1e-9 && r.x + r.size <= w + 1e-9 && r.y + r.size <= h + 1e-9;
}

describe("what may be picked", () => {
  const file = (name, size, type) => ({ name, size, type });

  it("any picture up to exactly 20 MB — an iPhone's HEIC as well as PNG, JPEG and WebP; a file of unknown type by its name; a file that is no picture is refused", () => {
    expect(PICK_ACCEPT).toBe("image/*");
    expect(pickProblem(file("a.png", MAX_PICK_BYTES, "image/png"))).toBe("");
    for (const type of ["image/jpeg", "image/webp", "image/heic", "image/heif", "image/heic-sequence", "image/avif", "image/gif", "image/bmp", "image/tiff"]) expect(pickProblem(file("IMG_0101", 5, type)), type).toBe("");
    // (A browser that does not know the type gives none: the name says it.)
    for (const name of ["a.JPEG", "a.jpg", "a.png", "a.webp", "IMG_0101.HEIC", "IMG_0102.heif", "a.avif", "a.gif", "a.bmp"]) expect(pickProblem(file(name, 5, "")), name).toBe("");
    // (Some pickers type a file they do not know as plain bytes: the name says it then too.)
    for (const name of ["IMG_0101.HEIC", "a.jpg", "a.avif"]) expect(pickProblem(file(name, 5, "application/octet-stream")), name).toBe("");
    for (const [name, type] of [["a.txt", ""], ["a", ""], ["heic", ""], ["a.pdf", "application/pdf"], ["a.mov", "video/quicktime"], ["a.png", "text/plain"], ["a.heic.zip", ""], ["a.bin", "application/octet-stream"], ["a.zip", "application/octet-stream"]]) expect(pickProblem(file(name, 5, type)), `${name} ${type}`).toBe("这个文件不是图片，请换一张。");
    expect(pickProblem(file("big.png", MAX_PICK_BYTES + 1, "image/png"))).toBe("图片不能超过 20 MB。");
    expect(pickProblem(file("IMG_0101.HEIC", MAX_PICK_BYTES + 1, "image/heic"))).toBe("图片不能超过 20 MB。");
  });

  it("no side is too long — a phone's 48 and 200 megapixel photos, a panorama; only a picture of more pixels than any camera makes is refused, and one with no size", () => {
    expect(MAX_PICK_PIXELS).toBe(300_000_000);
    for (const [w, h] of [[1, 1], [8000, 8000], [8064, 6048], [6048, 8064], [12000, 9000], [16320, 12240], [30000, 2000], [15000, 20000]]) expect(sizeProblem(w, h), `${w}x${h}`).toBe("");
    for (const [w, h] of [[20000, 15001], [17321, 17321], [65535, 65535]]) expect(sizeProblem(w, h), `${w}x${h}`).toBe("图片太大（超过 3 亿像素），请换一张。");
    expect(sizeProblem(0, 100)).toBe("这张图片无法读取，请换一张。");
    expect(sizeProblem(NaN, 100)).toBe("这张图片无法读取，请换一张。");
  });
});

describe("the view", () => {
  it("starts centred with the short side filling the stage, for a wide, a tall and a square picture", () => {
    for (const [w, h] of [[2000, 1000], [1000, 2000], [640, 640], [300, 300]]) {
      const v = initialView(w, h);
      expect(v).toEqual({ zoom: MIN_ZOOM, cx: w / 2, cy: h / 2 });
      near(scaleOf(v, w, h) * Math.min(w, h), STAGE);
      expect(covers(v, w, h)).toBe(true);
    }
  });

  it("clamps the zoom to its limits and the centre so that no empty space shows, at every zoom", () => {
    const [w, h] = [2000, 1000];
    expect(clampView({ zoom: 0.2, cx: 1000, cy: 500 }, w, h).zoom).toBe(MIN_ZOOM);
    expect(clampView({ zoom: 99, cx: 1000, cy: 500 }, w, h).zoom).toBe(MAX_ZOOM);
    for (const zoom of [1, 1.5, 2.5, MAX_ZOOM]) {
      for (const [cx, cy] of [[-500, -500], [0, 0], [1000, 500], [5000, 5000], [1999, 1], [NaN, NaN]]) {
        const v = clampView({ zoom, cx, cy }, w, h);
        expect(covers(v, w, h), JSON.stringify({ zoom, cx, cy })).toBe(true);
      }
    }
    // At zoom 1 the short side fills the stage: a wide picture can move sideways only, a tall one up and down only.
    expect(clampView({ zoom: 1, cx: 0, cy: 0 }, w, h)).toEqual({ zoom: 1, cx: 500, cy: 500 });
    expect(clampView({ zoom: 1, cx: 9999, cy: 9999 }, w, h)).toEqual({ zoom: 1, cx: 1500, cy: 500 });
    expect(clampView({ zoom: 1, cx: 0, cy: 0 }, 1000, 2000)).toEqual({ zoom: 1, cx: 500, cy: 500 });
  });

  it("a picture smaller than the stage is still scaled up to fill it; the zoom is relative to that", () => {
    const v = initialView(100, 100);
    near(coverScale(100, 100), 2.8);
    near(placement(v, 100, 100).width, 1);
    expect(covers(zoomAbout(v, 3, 100, 100), 100, 100)).toBe(true);
  });

  it("a drag moves the picture with the pointer, as far as the edge and no further", () => {
    const [w, h] = [2000, 1000];
    const zoomed = zoomAbout(initialView(w, h), 2, w, h);
    const s = scaleOf(zoomed, w, h);
    const moved = panBy(zoomed, 10, -20, w, h);
    near(moved.cx, zoomed.cx - 10 / s);
    near(moved.cy, zoomed.cy + 20 / s);
    expect(panBy(zoomed, 1e6, 1e6, w, h)).toEqual({ zoom: 2, cx: expect.closeTo(STAGE / 2 / (s), 6), cy: expect.closeTo(STAGE / 2 / s, 6) });
    expect(covers(panBy(zoomed, -1e6, -1e6, w, h), w, h)).toBe(true);
    // Zoom 1 on a wide picture: a vertical drag changes nothing.
    const flat = panBy(initialView(w, h), 0, 50, w, h);
    expect(flat.cy).toBe(500);
  });
});

describe("zoom about a point", () => {
  it("keeps the picture point under the chosen stage point where it was, while there is room", () => {
    const [w, h] = [3000, 2000];
    const start = panBy(zoomAbout(initialView(w, h), 2, w, h), 30, 0, w, h);
    const [px, py] = [200, 90];
    const pictureAt = (v) => [v.cx + (px - STAGE / 2) / scaleOf(v, w, h), v.cy + (py - STAGE / 2) / scaleOf(v, w, h)];
    const after = zoomAbout(start, 3, w, h, px, py);
    near(pictureAt(after)[0], pictureAt(start)[0], 4);
    near(pictureAt(after)[1], pictureAt(start)[1], 4);
    expect(after.zoom).toBe(3);
  });

  it("zooming out to the floor re-centres what the edges forbid; the limits hold for any point", () => {
    const [w, h] = [2000, 1000];
    const start = panBy(zoomAbout(initialView(w, h), 4, w, h), -5000, 0, w, h);
    for (const zoom of [3, 2, 1.2, 1, 0.5]) {
      const v = zoomAbout(start, zoom, w, h, 0, 280);
      expect(covers(v, w, h)).toBe(true);
      expect(v.zoom).toBeGreaterThanOrEqual(MIN_ZOOM);
    }
    expect(zoomAbout(initialView(w, h), 50, w, h).zoom).toBe(MAX_ZOOM);
    expect(zoomAbout(initialView(w, h), 0, w, h).zoom).toBe(MIN_ZOOM);
  });

  it("a wheel turn and a step zoom by a smooth factor, the same both ways, inside the limits", () => {
    expect(wheelZoom(2, -100)).toBeGreaterThan(2);
    expect(wheelZoom(2, 100)).toBeLessThan(2);
    near(wheelZoom(wheelZoom(2, -120), 120), 2);
    expect(wheelZoom(MAX_ZOOM, -1000)).toBe(MAX_ZOOM);
    expect(wheelZoom(MIN_ZOOM, 1000)).toBe(MIN_ZOOM);
    near(stepZoom(stepZoom(2, 1), -1), 2);
    expect(stepZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
    expect(stepZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
  });

  it("a pinch scales by the change of the fingers' distance about where they started, and follows their midpoint", () => {
    const [w, h] = [4000, 4000];
    const view = zoomAbout(initialView(w, h), 2, w, h);
    const start = { view, distance: 100, mid: { x: 140, y: 140 } };
    const doubled = pinch(start, { distance: 200, mid: { x: 140, y: 140 } }, w, h);
    near(doubled.zoom, 4);
    near(doubled.cx, view.cx);
    const moved = pinch(start, { distance: 100, mid: { x: 160, y: 140 } }, w, h);
    near(moved.cx, view.cx - 20 / scaleOf(view, w, h));
    expect(pinch(start, { distance: 100000, mid: start.mid }, w, h).zoom).toBe(MAX_ZOOM);
    expect(pinch({ ...start, distance: 0 }, { distance: 50, mid: start.mid }, w, h)).toBe(view);
  });
});

describe("what is shown and what is saved", () => {
  it("places the picture in the stage and the saved square is what the stage shows", () => {
    const [w, h] = [2000, 1000];
    const v = zoomAbout(initialView(w, h), 2, w, h);
    const p = placement(v, w, h);
    near(p.width / p.height, w / h);
    // The stage centre is the view centre: left + width * cx / w = 1/2.
    near(p.left + (p.width * v.cx) / w, 0.5);
    near(p.top + (p.height * v.cy) / h, 0.5);
    const r = sourceRect(v, w, h);
    near(r.size, h / 2); // zoom 2 of "short side fills it": half the short side
    near(r.x + r.size / 2, v.cx);
    near(r.y + r.size / 2, v.cy);
    expect(OUTPUT_SIZE).toBe(512);
  });
});

describe("orientation", () => {
  /** A JPEG's first bytes: SOI, then an APP1 Exif segment with one IFD entry (orientation), in either byte order. */
  function jpegWith(orientation, { little = true, extraBefore = [] } = {}) {
    const u16 = (n) => (little ? [n & 255, n >> 8] : [n >> 8, n & 255]);
    const u32 = (n) => (little ? [n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24] : [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255]);
    const tiff = [...(little ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(8), ...u16(1), ...u16(0x0112), ...u16(3), ...u32(1), ...u16(orientation), 0, 0, ...u32(0)];
    const exif = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
    const len = exif.length + 2;
    return Uint8Array.from([0xff, 0xd8, ...extraBefore, 0xff, 0xe1, len >> 8, len & 255, ...exif, 0xff, 0xda, 0, 2]);
  }

  it("reads the tag of a JPEG in either byte order, after another segment too", () => {
    for (const o of [1, 2, 3, 4, 5, 6, 7, 8]) {
      expect(exifOrientation(jpegWith(o, { little: true })), `little ${o}`).toBe(o);
      expect(exifOrientation(jpegWith(o, { little: false })), `big ${o}`).toBe(o);
    }
    const app0 = [0xff, 0xe0, 0, 4, 0x4a, 0x46];
    expect(exifOrientation(jpegWith(6, { extraBefore: app0 }))).toBe(6);
  });

  it("is 1 for anything else: not a JPEG, no tag, a value out of range, a damaged or cut-off segment", () => {
    expect(exifOrientation(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))).toBe(1);
    expect(exifOrientation(new Uint8Array(0))).toBe(1);
    expect(exifOrientation(Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0, 2]))).toBe(1);
    expect(exifOrientation(jpegWith(9))).toBe(1);
    expect(exifOrientation(jpegWith(0))).toBe(1);
    const whole = jpegWith(6);
    for (let cut = 0; cut < whole.length; cut++) {
      const o = exifOrientation(whole.subarray(0, cut));
      expect(o === 1 || o === 6).toBe(true); // never throws, never reads past the end
    }
    const garbage = Uint8Array.from({ length: 300 }, (_, i) => (i * 37 + 11) & 255);
    garbage[0] = 0xff;
    garbage[1] = 0xd8;
    expect(() => exifOrientation(garbage)).not.toThrow();
  });

  it("marks a JPEG with an orientation that exifOrientation reads back, keeping the rest of the file", () => {
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xdb, 0, 4, 1, 2, 0xff, 0xd9]);
    for (let o = 1; o <= 8; o++) {
      const marked = withExifOrientation(jpeg, o);
      expect(exifOrientation(marked)).toBe(o);
      expect([...marked.subarray(0, 2)]).toEqual([0xff, 0xd8]);
      expect([...marked.subarray(marked.length - jpeg.length + 2)]).toEqual([...jpeg.subarray(2)]);
    }
  });

  it("turns the size on its side for 5 to 8 only", () => {
    for (const o of [1, 2, 3, 4]) expect(orientedSize(300, 200, o)).toEqual({ width: 300, height: 200 });
    for (const o of [5, 6, 7, 8]) expect(orientedSize(300, 200, o)).toEqual({ width: 200, height: 300 });
  });

  it("each orientation's transform takes the stored corners to the corners of the oriented picture, and keeps the picture whole", () => {
    const [w, h] = [300, 200];
    for (let o = 1; o <= 8; o++) {
      const [a, b, c, d, e, f] = orientationMatrix(o, w, h);
      const size = orientedSize(w, h, o);
      for (const [x, y] of [[0, 0], [w, 0], [0, h], [w, h]]) {
        const X = a * x + c * y + e;
        const Y = b * x + d * y + f;
        expect([X === 0 || Math.abs(X - size.width) < 1e-9, Y === 0 || Math.abs(Y - size.height) < 1e-9], `${o} (${x},${y})`).toEqual([true, true]);
      }
      expect(Math.abs(a * d - b * c)).toBe(1); // a turn or a mirror: nothing is stretched
    }
    // Where the stored top-left corner (0,0) and top-right corner (w,0) land, per orientation: the eight are told apart.
    const landing = (o, x, y) => {
      const [a, b, c, d, e, f] = orientationMatrix(o, w, h);
      return [a * x + c * y + e, b * x + d * y + f];
    };
    const expected = {
      1: [[0, 0], [w, 0]],
      2: [[w, 0], [0, 0]],
      3: [[w, h], [0, h]],
      4: [[0, h], [w, h]],
      5: [[0, 0], [0, w]],
      6: [[h, 0], [h, w]],
      7: [[h, w], [h, 0]],
      8: [[0, w], [0, 0]],
    };
    for (let o = 1; o <= 8; o++) expect([landing(o, 0, 0), landing(o, w, 0)], `orientation ${o}`).toEqual(expected[o]);
    // 6: a quarter turn clockwise — the stored top-left corner ends top-right, the stored top-right bottom-right.
    const [a, b, c, d, e, f] = orientationMatrix(6, w, h);
    expect([a * 0 + c * 0 + e, b * 0 + d * 0 + f]).toEqual([h, 0]);
    expect([a * w + c * 0 + e, b * w + d * 0 + f]).toEqual([h, w]);
  });

  it("the crop's transform puts the chosen square of the oriented picture on the whole output", () => {
    const [w, h] = [300, 200];
    for (let o = 1; o <= 8; o++) {
      const size = orientedSize(w, h, o);
      const rect = { x: size.width / 4, y: size.height / 8, size: size.height / 2 };
      const [a, b, c, d, e, f] = cropTransform(rect, OUTPUT_SIZE, o, w, h);
      const [m1, m2, m3, m4, m5, m6] = orientationMatrix(o, w, h);
      // Take the two opposite corners of the rect in the oriented picture back to stored pixels, then forward again.
      const det = m1 * m4 - m2 * m3;
      const back = (X, Y) => [(m4 * (X - m5) - m3 * (Y - m6)) / det, (-m2 * (X - m5) + m1 * (Y - m6)) / det];
      for (const [X, Y, ex, ey] of [[rect.x, rect.y, 0, 0], [rect.x + rect.size, rect.y + rect.size, OUTPUT_SIZE, OUTPUT_SIZE]]) {
        const [sx, sy] = back(X, Y);
        near(a * sx + c * sy + e, ex, 6);
        near(b * sx + d * sy + f, ey, 6);
      }
    }
  });
});

describe("the size, from the header bytes", () => {
  const be32 = (n) => [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255];
  const be16 = (n) => [n >> 8, n & 255];
  const le16 = (n) => [n & 255, n >> 8];
  const le24 = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255];
  const text = (s) => [...s].map((c) => c.charCodeAt(0));
  const png = (w, h) => Uint8Array.from([0x89, ...text("PNG"), 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, ...text("IHDR"), ...be32(w), ...be32(h), 8, 2, 0, 0, 0]);
  const segment = (marker, body) => [0xff, marker, ...be16(body.length + 2), ...body];
  const jpeg = (w, h, { sof = 0xc0, before = [] } = {}) =>
    Uint8Array.from([0xff, 0xd8, ...before, ...segment(sof, [8, ...be16(h), ...be16(w), 3, 1, 0x22, 0]), 0xff, 0xda, 0, 2]);
  const webpHead = (chunk, body) => Uint8Array.from([...text("RIFF"), 0, 0, 0, 0, ...text("WEBP"), ...text(chunk), 0, 0, 0, 0, ...body]);
  const webpLossy = (w, h) => webpHead("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(w), ...le16(h)]);
  const webpLossless = (w, h) => {
    const v = (w - 1) | ((h - 1) << 14);
    return webpHead("VP8L", [0x2f, v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255]);
  };
  const webpExtended = (w, h) => webpHead("VP8X", [0, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)]);
  const SIZES = [[1, 1], [9, 10], [99, 100], [101, 99], [640, 480], [8000, 8000], [8001, 100], [100, 8001], [12000, 9000], [16383, 16383]];

  it("PNG, JPEG (baseline and progressive), WebP lossy, lossless and extended: the stored size, at sizes around 10, 100 and 8000", () => {
    for (const [w, h] of SIZES) {
      expect(imageSize(png(w, h)), `png ${w}x${h}`).toEqual({ width: w, height: h });
      if (w <= 65535) {
        expect(imageSize(jpeg(w, h)), `jpeg ${w}x${h}`).toEqual({ width: w, height: h });
        expect(imageSize(jpeg(w, h, { sof: 0xc2 })), `progressive ${w}x${h}`).toEqual({ width: w, height: h });
      }
      expect(imageSize(webpLossless(w, h)), `lossless ${w}x${h}`).toEqual({ width: w, height: h });
      expect(imageSize(webpExtended(w, h)), `extended ${w}x${h}`).toEqual({ width: w, height: h });
      if (w <= 16383 && h <= 16383) expect(imageSize(webpLossy(w, h)), `lossy ${w}x${h}`).toEqual({ width: w, height: h });
    }
  });

  it("a JPEG whose frame header comes after a large EXIF segment, a thumbnail's own header included, is read from the right one", () => {
    const thumb = jpeg(160, 120); // the EXIF thumbnail is a whole JPEG with a frame header of its own
    const bigApp1 = segment(0xe1, [...text("Exif"), 0, 0, ...thumb, ...new Array(60000).fill(7)]);
    const jfif = segment(0xe0, [...text("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
    const file = jpeg(8001, 6000, { before: [...jfif, ...bigApp1] });
    expect(file.length).toBeGreaterThan(60000);
    expect(imageSize(file)).toEqual({ width: 8001, height: 6000 });
    // A table segment, a comment, and a marker without a length before it do not matter.
    const dht = segment(0xc4, [0, ...new Array(16).fill(0)]);
    const comment = segment(0xfe, text("hello"));
    expect(imageSize(jpeg(300, 200, { before: [...dht, ...comment, 0xff, 0xd0] }))).toEqual({ width: 300, height: 200 });
  });

  it("null for anything not readable: unknown formats, empty, cut off anywhere, a frame header beyond the bytes, zero sizes", () => {
    expect(imageSize(new Uint8Array(0))).toBeNull();
    expect(imageSize(Uint8Array.from(text("GIF89a\x01\x00\x01\x00")))).toBeNull();
    expect(imageSize(png(0, 5))).toBeNull();
    expect(imageSize(jpeg(0, 5))).toBeNull();
    const beyond = Uint8Array.from([0xff, 0xd8, ...segment(0xe1, new Array(70000).fill(0))].slice(0, 70000));
    expect(imageSize(beyond)).toBeNull();
    for (const whole of [png(640, 480), jpeg(640, 480, { before: segment(0xe0, [1, 2, 3]) }), webpLossy(640, 480), webpLossless(640, 480), webpExtended(640, 480)]) {
      for (let cut = 0; cut < whole.length; cut++) {
        const got = imageSize(whole.subarray(0, cut));
        expect(got === null || (got.width === 640 && got.height === 480), `cut ${cut}`).toBe(true);
      }
    }
    const noise = Uint8Array.from({ length: 400 }, (_, i) => (i * 131 + 17) & 255);
    noise[0] = 0xff;
    noise[1] = 0xd8;
    expect(() => imageSize(noise)).not.toThrow();
  });

  it("a decode needs at most 512 × the highest zoom on the short side, by the one option that gets it, and nothing when small", () => {
    expect(DECODE_SHORT_SIDE).toBe(512 * MAX_ZOOM);
    expect(decodeResize(8000, 8000)).toEqual({ resizeWidth: DECODE_SHORT_SIDE });
    expect(decodeResize(12000, 9000)).toEqual({ resizeHeight: DECODE_SHORT_SIDE });
    expect(decodeResize(9000, 3000)).toEqual({ resizeHeight: DECODE_SHORT_SIDE });
    expect(decodeResize(3000, 9000)).toEqual({ resizeWidth: DECODE_SHORT_SIDE });
    expect(decodeResize(DECODE_SHORT_SIDE, 8000)).toBeNull();
    expect(decodeResize(DECODE_SHORT_SIDE + 1, 8000)).toEqual({ resizeWidth: DECODE_SHORT_SIDE });
    expect(decodeResize(99, 100)).toBeNull();
    // A phone's largest photos, either way up.
    expect(decodeResize(8064, 6048)).toEqual({ resizeHeight: DECODE_SHORT_SIDE });
    expect(decodeResize(6048, 8064)).toEqual({ resizeWidth: DECODE_SHORT_SIDE });
    expect(decodeResize(16320, 12240)).toEqual({ resizeHeight: DECODE_SHORT_SIDE });
  });

  it("a very long picture (a panorama) is also kept to a working size: never more pixels than four squares of that short side", () => {
    expect(MAX_WORK_PIXELS).toBe(DECODE_SHORT_SIDE * DECODE_SHORT_SIDE * 4);
    // Up to 4 : 1 the short side alone decides.
    expect(decodeResize(DECODE_SHORT_SIDE * 8, DECODE_SHORT_SIDE * 2)).toEqual({ resizeHeight: DECODE_SHORT_SIDE });
    // Longer than that: the short side shrinks so that the whole stays within the bound.
    for (const [w, h] of [[30000, 2000], [2000, 30000], [60000, 4000], [20000, 2560], [65535, 1000]]) {
      const resize = decodeResize(w, h);
      const short = resize.resizeWidth ?? resize.resizeHeight;
      expect(Object.keys(resize), `${w}x${h}`).toEqual([w <= h ? "resizeWidth" : "resizeHeight"]);
      expect(Number.isInteger(short) && short >= 1 && short <= DECODE_SHORT_SIDE, `${w}x${h}`).toBe(true);
      const long = (short * Math.max(w, h)) / Math.min(w, h);
      expect(short * long, `${w}x${h}`).toBeLessThanOrEqual(MAX_WORK_PIXELS * 1.01);
      expect(short * long, `${w}x${h}`).toBeGreaterThan(MAX_WORK_PIXELS * 0.9);
    }
    // A long picture that is small anyway is left alone.
    expect(decodeResize(20000, 1000)).toBeNull();
  });
});

// ───────── a picture in an ISO container (HEIC, HEIF, AVIF: an iPhone's photo): its size for the size rule, before it is decoded
const be32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const chars = (t) => [...t].map((c) => c.charCodeAt(0));
const box = (type, body) => [...be32(8 + body.length), ...chars(type), ...body];
const ispe = (w, h) => box("ispe", [0, 0, 0, 0, ...be32(w), ...be32(h)]);
/** The start of such a file: `ftyp` with `brand`, then the item properties (a size per item: the tiles of a grid, the whole picture, a thumbnail). */
const heic = (sizes, brand = "heic") =>
  Uint8Array.from([...box("ftyp", [...chars(brand), 0, 0, 0, 0, ...chars("mif1")]), ...box("meta", [0, 0, 0, 0, ...box("iprp", box("ipco", sizes.flatMap(([w, h]) => ispe(w, h))))])]);

describe("the size of a HEIC, HEIF or AVIF read from its header", () => {
  it("the largest picture in it (the whole one, not a tile of its grid nor its thumbnail), at sizes around 10, 100 and 8000", () => {
    for (const [w, h] of [[9, 10], [99, 101], [4032, 3024], [8000, 8000], [8001, 100], [100, 8001], [12000, 9000]]) {
      expect(containerSize(heic([[8, 8], [w, h], [4, 4]])), `${w}x${h}`).toEqual({ width: w, height: h });
      expect(containerSize(heic([[w, h]], "avif")), `avif ${w}x${h}`).toEqual({ width: w, height: h });
    }
    expect(containerSize(heic([[320, 240], [5712, 4284], [512, 512]], "heix"))).toEqual({ width: 5712, height: 4284 });
  });

  it("null for anything else: no container, no size in the bytes given, a size cut off, a zero size", () => {
    expect(containerSize(new Uint8Array(0))).toBeNull();
    expect(containerSize(Uint8Array.from([0x89, ...chars("PNG"), 13, 10, 26, 10, 0, 0, 0, 13, ...chars("IHDR"), ...ispe(100, 100)]))).toBeNull();
    expect(containerSize(heic([]))).toBeNull();
    expect(containerSize(heic([[0, 10]]))).toBeNull();
    const whole = heic([[640, 480]]);
    for (let cut = 0; cut < whole.length; cut += 1) expect(containerSize(whole.slice(0, cut)), `cut at ${cut}`).toBeNull();
    // (imageSize, which the decode trusts for the picture's shape, does not answer for it: its size here is before any turn.)
    expect(imageSize(whole)).toBeNull();
  });
});

describe("decoding a picked picture (the real src/ui/avatarImage.js, with the browser's decoder stood in)", () => {
  const heicFile = (w, h) => new File([heic([[w, h]]), new Uint8Array(64)], "IMG_0101.HEIC", { type: "image/heic" });
  let decodeAvatar;
  let decoder;
  beforeEach(async () => {
    ({ decodeAvatar } = await vi.importActual("../src/ui/avatarImage.js"));
    decoder = vi.fn();
    vi.stubGlobal("createImageBitmap", decoder);
  });
  afterEach(() => vi.unstubAllGlobals());
  const bitmap = (width, height) => ({ width, height, close: vi.fn() });

  const be16 = (v) => [(v >> 8) & 255, v & 255];
  /** A JPEG's start with its frame header (no EXIF), then padding: enough for the size to be read. */
  const jpegFile = (w, h) => new File([Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, ...be16(h), ...be16(w), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xda, 0, 2]), new Uint8Array(64)], "IMG_0202.JPG", { type: "image/jpeg" });
  const pngFile = (w, h) => new File([Uint8Array.from([0x89, ...chars("PNG"), 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, ...chars("IHDR"), ...be32(w), ...be32(h), 8, 2, 0, 0, 0])], "a.png", { type: "image/png" });
  const SMALL = { resizeQuality: "high" };
  /** A canvas that records what is drawn into it (this file runs without a DOM), put where the crop makes its own. */
  const fakeCanvas = () => {
    const ctx = { setTransform: vi.fn(), drawImage: vi.fn(), fillRect: vi.fn() };
    const canvas = { width: 0, height: 0, getContext: () => ctx, toBlob: (done, type) => done(new Blob(["crop"], { type })) };
    vi.stubGlobal("document", { createElement: () => canvas });
    return { canvas, ctx };
  };

  it("an iPhone's 48 megapixel photo (8064 × 6048) and a 12000 × 9000 one, JPEG: decoded once at a working size, and the picture keeps the original's size", async () => {
    for (const [w, h] of [[8064, 6048], [12000, 9000]]) {
      decoder.mockReset();
      const small = bitmap(Math.round((w * 2560) / h), 2560);
      decoder.mockResolvedValue(small);
      const file = jpegFile(w, h);
      const image = await decodeAvatar(file);
      expect({ width: image.width, height: image.height }, `${w}x${h}`).toEqual({ width: w, height: h });
      expect(decoder.mock.calls).toEqual([[file, { resizeHeight: 2560, ...SMALL }]]);
      expect(small.close).not.toHaveBeenCalled();
    }
  });

  it("the crop of a large photo is cut from the working picture by the original's coordinates: the working bitmap is laid over the original's size, then the square is taken", async () => {
    const small = bitmap(3413, 2560);
    decoder.mockResolvedValue(small);
    const image = await decodeAvatar(jpegFile(12000, 9000));
    const { ctx, canvas } = fakeCanvas();
    // Zoomed in twice on a point right of the centre: a square of 4500 original pixels around (7000, 4500).
    const view = { zoom: 2, cx: 7000, cy: 4500 };
    const saved = await image.crop(view);
    expect(sourceRect(view, 12000, 9000)).toEqual({ x: 4750, y: 2250, size: 4500 });
    expect(ctx.setTransform).toHaveBeenCalledWith(...cropTransform({ x: 4750, y: 2250, size: 4500 }, OUTPUT_SIZE, 1, 12000, 9000));
    expect(ctx.drawImage).toHaveBeenCalledWith(small, 0, 0, 3413, 2560, 0, 0, 12000, 9000);
    expect([canvas.width, canvas.height]).toEqual([OUTPUT_SIZE, OUTPUT_SIZE]);
    expect([saved.name, saved.type]).toEqual(["avatar.webp", "image/webp"]);
    // Where a point of the working bitmap lands: the original's (7000, 4500) is the output's centre.
    const [a, , , d, e, f] = ctx.setTransform.mock.calls[0];
    near(a * 7000 + e, OUTPUT_SIZE / 2);
    near(d * 4500 + f, OUTPUT_SIZE / 2);
  });

  it("a HEIC of 8064 × 6048 and of 12000 × 9000 stored upright: decoded once at a working size (nothing is refused for its size)", async () => {
    for (const [w, h] of [[8064, 6048], [12000, 9000]]) {
      decoder.mockReset();
      decoder.mockResolvedValue(bitmap(3413, 2560));
      const file = heicFile(w, h);
      const image = await decodeAvatar(file);
      expect({ width: image.width, height: image.height }, `${w}x${h}`).toEqual({ width: w, height: h });
      expect(decoder.mock.calls).toEqual([[file, { resizeHeight: 2560, ...SMALL }]]);
    }
  });

  it("a HEIC the file turns on its side (a portrait photo: the header's size is before the turn): the first try shows the turn, the second is decoded for it, upright and at the working size", async () => {
    // The browser applies the file's turn: the picture is 6048 × 8064 whatever the header's 8064 × 6048 says.
    const tries = [];
    decoder.mockImplementation(async (_file, options) => {
      const made = options.resizeHeight ? bitmap(Math.round((6048 * options.resizeHeight) / 8064), options.resizeHeight) : bitmap(options.resizeWidth, Math.round((8064 * options.resizeWidth) / 6048));
      tries.push(made);
      return made;
    });
    const file = heicFile(8064, 6048);
    const image = await decodeAvatar(file);
    expect({ width: image.width, height: image.height }).toEqual({ width: 6048, height: 8064 });
    expect(decoder.mock.calls).toEqual([[file, { resizeHeight: 2560, ...SMALL }], [file, { resizeWidth: 2560, ...SMALL }]]);
    expect([tries[0].width, tries[0].height]).toEqual([1920, 2560]);
    expect(tries[0].close).toHaveBeenCalledTimes(1); // the first try is released
    expect([tries[1].width, tries[1].height]).toEqual([2560, 3413]);
    expect(tries[1].close).not.toHaveBeenCalled();
    const { ctx } = fakeCanvas();
    await image.crop({ zoom: 1, cx: 3024, cy: 4032 });
    expect(ctx.drawImage).toHaveBeenCalledWith(tries[1], 0, 0, 2560, 3413, 0, 0, 6048, 8064);
  });

  it("a small HEIC is decoded whole, and its size and shape are the decoded picture's", async () => {
    decoder.mockResolvedValue(bitmap(900, 1200));
    const file = heicFile(1200, 900);
    const image = await decodeAvatar(file);
    expect({ width: image.width, height: image.height }).toEqual({ width: 900, height: 1200 });
    expect(decoder.mock.calls).toEqual([[file]]);
  });

  it("a browser without the resize options: the whole picture is decoded instead, JPEG and HEIC alike, and still nothing is refused for its size", async () => {
    for (const file of [jpegFile(8064, 6048), heicFile(8064, 6048)]) {
      decoder.mockReset();
      const whole = bitmap(8064, 6048);
      decoder.mockImplementation(async (_file, options) => {
        if (options) throw new TypeError("no options here");
        return whole;
      });
      const image = await decodeAvatar(file);
      expect({ width: image.width, height: image.height }, file.name).toEqual({ width: 8064, height: 6048 });
      expect(decoder.mock.calls.at(-1)).toEqual([file]);
      const { ctx } = fakeCanvas();
      await image.crop({ zoom: 1, cx: 4032, cy: 3024 });
      expect(ctx.drawImage).toHaveBeenCalledWith(whole, 0, 0, 8064, 6048, 0, 0, 8064, 6048);
    }
  });

  it("a picture whose header is not read (a BMP, a GIF) is decoded whole, however long a side is", async () => {
    const wide = bitmap(9000, 100);
    decoder.mockResolvedValue(wide);
    const file = new File([new Uint8Array(40)], "a.bmp", { type: "image/bmp" });
    const image = await decodeAvatar(file);
    expect({ width: image.width, height: image.height }).toEqual({ width: 9000, height: 100 });
    expect(decoder.mock.calls).toEqual([[file]]);
    expect(wide.close).not.toHaveBeenCalled();
  });

  it("a picture of more pixels than any camera makes is refused from its header, PNG and HEIC: nothing is decoded", async () => {
    for (const file of [pngFile(20000, 15001), heicFile(20000, 15001), pngFile(60000, 60000)]) await expect(decodeAvatar(file), file.name).rejects.toMatchObject({ text: "图片太大（超过 3 亿像素），请换一张。" });
    expect(decoder).not.toHaveBeenCalled();
  });

  it("a picture this browser cannot decode: a format it may not know (HEIC, HEIF, AVIF, TIFF, by type or by name) says to use JPG or PNG; any other, that it cannot be read", async () => {
    decoder.mockRejectedValue(new Error("InvalidStateError"));
    const other = "这个浏览器打不开这张图片，请换成 JPG 或 PNG 格式。";
    await expect(decodeAvatar(heicFile(4032, 3024))).rejects.toMatchObject({ text: other });
    await expect(decodeAvatar(heicFile(1200, 900))).rejects.toMatchObject({ text: other });
    for (const [name, type] of [["a.heif", "image/heif"], ["a.avif", "image/avif"], ["a.tiff", "image/tiff"], ["IMG_1.HEIC", ""], ["IMG_1.HEIC", "application/octet-stream"], ["scan.TIF", ""]]) {
      await expect(decodeAvatar(new File([new Uint8Array(40)], name, { type })), `${name} ${type}`).rejects.toMatchObject({ text: other });
    }
    for (const file of [jpegFile(640, 480), jpegFile(8064, 6048), pngFile(640, 480), new File([new Uint8Array(40)], "a.gif", { type: "image/gif" })]) {
      await expect(decodeAvatar(file), file.name).rejects.toMatchObject({ text: "这张图片无法读取，请换一张。" });
    }
  });
});
