// A stand-in for src/ui/avatarImage.js in the jsdom tests (it has no canvas or image decoder): a test file says
// `vi.mock("../src/ui/avatarImage.js", () => import("./avatar-fake.js"))`. The real arithmetic is tested in avatar-crop.test.js.
import { vi } from "vitest";

export class AvatarProblem extends Error {
  constructor(text) {
    super(text);
    this.text = text;
  }
}

/** What the next `decodeAvatar` resolves with, per picked file name; a test sets `size` or `fail` before picking. */
export const fake = {
  size: { width: 800, height: 600 },
  /** A sentence: the next decode rejects with it. */
  fail: null,
  /** Every decoded picture, in order. */
  images: [],
  /** The bytes `crop` resolves a file of. */
  cropped: "cropped-bytes",
};

export const decodeAvatar = vi.fn(async (file) => {
  if (fake.fail) throw new AvatarProblem(fake.fail);
  const image = {
    file,
    width: fake.size.width,
    height: fake.size.height,
    paint: vi.fn(),
    crop: vi.fn(async () => new File([fake.cropped], "avatar.webp", { type: "image/webp" })),
    close: vi.fn(),
  };
  fake.images.push(image);
  return image;
});

export const resetFake = () => {
  fake.size = { width: 800, height: 600 };
  fake.fail = null;
  fake.images.length = 0;
  fake.cropped = "cropped-bytes";
  decodeAvatar.mockClear();
};
