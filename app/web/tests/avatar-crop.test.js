// The arithmetic of the avatar adjust dialog (src/ui/avatarCrop.js): limits, clamping, zoom about a point, orientation.
import { describe, expect, it } from "vitest";
import {
  MAX_PICK_BYTES,
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

  it("PNG, JPEG and WebP up to exactly 20 MB; a file of unknown type by its name; nothing else", () => {
    expect(pickProblem(file("a.png", MAX_PICK_BYTES, "image/png"))).toBe("");
    expect(pickProblem(file("a.jpg", 5, "image/jpeg"))).toBe("");
    expect(pickProblem(file("a.webp", 5, "image/webp"))).toBe("");
    expect(pickProblem(file("a.JPEG", 5, ""))).toBe("");
    expect(pickProblem(file("a.gif", 5, "image/gif"))).toBe("头像需要是 PNG、JPEG 或 WebP 格式的图片。");
    expect(pickProblem(file("a.svg", 5, "image/svg+xml"))).toBe("头像需要是 PNG、JPEG 或 WebP 格式的图片。");
    expect(pickProblem(file("a.txt", 5, ""))).toBe("头像需要是 PNG、JPEG 或 WebP 格式的图片。");
    expect(pickProblem(file("big.png", MAX_PICK_BYTES + 1, "image/png"))).toBe("图片不能超过 20 MB。");
  });

  it("up to 8000 pixels a side, with a clear message beyond that or for nothing readable", () => {
    expect(sizeProblem(8000, 8000)).toBe("");
    expect(sizeProblem(1, 1)).toBe("");
    expect(sizeProblem(8001, 100)).toBe("图片的边不能超过 8000 像素。");
    expect(sizeProblem(100, 9000)).toBe("图片的边不能超过 8000 像素。");
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
  });
});
