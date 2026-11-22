// @vitest-environment jsdom
// A video or an audio file plays where it was sent (item Q): decided from the stored content type against what the browser says it can play
// (`canPlayType`), never from the file name; no autoplay, `playsinline`, `preload="metadata"`; the box follows the thumbnail rule; a file that cannot
// play (or fails to) is the card, and the card stays reachable for download.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MediaBody, playableKind } from "../src/ui/MediaBody.jsx";
import { FileCard } from "../src/ui/FileCard.jsx";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** What the browser says: a table type -> "probably" / "maybe" / "". */
const canPlay = (table) => vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockImplementation((type) => table[type] ?? "");
const msg = (attachment, extra = {}) => ({ id: "m1", text: attachment.name, upload: null, attachment: { id: "a1", size: 1_234_567, url: "/api/attachments/a1", inline: false, ...attachment }, ...extra });

describe("playableKind", () => {
  it("is video or audio only when the stored type says so AND the browser says it can play it", () => {
    canPlay({ "video/mp4": "maybe", "audio/mpeg": "probably", "video/quicktime": "" });
    expect(playableKind("video/mp4")).toBe("video");
    expect(playableKind("audio/mpeg")).toBe("audio");
    expect(playableKind("video/quicktime")).toBeNull(); // (this browser does not claim it: the card)
    expect(playableKind("application/pdf")).toBeNull();
    expect(playableKind(null)).toBeNull();
    expect(playableKind(undefined)).toBeNull(); // (a message sent before the type was kept)
  });

  it("known aliases of a type are tried (what the sniffing calls a WAV or an M4A is what a browser calls audio/wav, audio/mp4)", () => {
    canPlay({ "audio/wav": "probably", "audio/mp4": "maybe" });
    expect(playableKind("audio/vnd.wave")).toBe("audio");
    expect(playableKind("audio/x-m4a")).toBe("audio");
  });
});

describe("MediaBody", () => {
  beforeEach(() => canPlay({ "video/mp4": "maybe", "video/webm": "probably", "audio/mpeg": "probably" }));

  it("a playable video is a video element: native controls, no autoplay, plays inline, loads only its metadata, with the file's address and a download link under it", () => {
    const { container } = render(<MediaBody msg={msg({ name: "clip.mp4", mime: "video/mp4" })} />);
    const video = container.querySelector("video");
    expect(video).not.toBeNull();
    expect(video.hasAttribute("controls")).toBe(true);
    expect(video.hasAttribute("autoplay")).toBe(false);
    expect(video.hasAttribute("playsinline")).toBe(true);
    expect(video.getAttribute("preload")).toBe("metadata");
    expect(video.getAttribute("src")).toMatch(/^\/api\/attachments\/a1(#t=0\.001)?$/); // (the fragment makes Safari draw the first frame)
    expect(video.getAttribute("aria-label")).toBe("clip.mp4");
    const save = screen.getByRole("link", { name: /下载 clip\.mp4/ });
    expect(save.getAttribute("href")).toBe("/api/attachments/a1");
    expect(save.hasAttribute("download")).toBe(true);
  });

  it("an audio file is an audio element (no autoplay, metadata only) with the same download link", () => {
    const { container } = render(<MediaBody msg={msg({ name: "memo.mp3", mime: "audio/mpeg" })} />);
    const audio = container.querySelector("audio");
    expect(audio.hasAttribute("controls")).toBe(true);
    expect(audio.hasAttribute("autoplay")).toBe(false);
    expect(audio.getAttribute("preload")).toBe("metadata");
    expect(container.querySelector("video")).toBeNull();
    expect(screen.getByRole("link", { name: /下载 memo\.mp3/ })).toBeTruthy();
  });

  it("is decided by the stored type, never by the name: an .mp4 whose type is not a video, and a message with no type at all, are the card", () => {
    const named = render(<MediaBody msg={msg({ name: "fake.mp4", mime: "application/octet-stream" })} />);
    expect(named.container.querySelector("video")).toBeNull();
    expect(named.container.querySelector(".file-card")).not.toBeNull();
    cleanup();
    const old = render(<MediaBody msg={msg({ name: "old.mp4" })} />);
    expect(old.container.querySelector("video")).toBeNull();
    expect(old.container.querySelector(".file-card")).not.toBeNull();
  });

  it("a type this browser cannot play is the card (an iOS-only .mov in Chrome, a .webm in an old Safari)", () => {
    canPlay({});
    const { container } = render(<MediaBody msg={msg({ name: "a.mov", mime: "video/quicktime" })} />);
    expect(container.querySelector("video")).toBeNull();
    expect(screen.getByRole("link", { name: /下载 a\.mov/ })).toBeTruthy();
  });

  it("a file the browser then fails to decode (its error event) falls back to the card, with its download", () => {
    const { container } = render(<MediaBody msg={msg({ name: "hevc.mp4", mime: "video/mp4" })} />);
    fireEvent.error(container.querySelector("video"));
    expect(container.querySelector("video")).toBeNull();
    expect(container.querySelector(".file-card")).not.toBeNull();
  });

  it("while it is still being sent there is no address to play from: the card with its progress", () => {
    const { container } = render(<MediaBody msg={msg({ name: "clip.mp4", mime: "video/mp4", url: null }, { upload: { progress: 0.4 } })} />);
    expect(container.querySelector("video")).toBeNull();
    expect(container.querySelector("progress")).not.toBeNull();
  });

  it("the box follows the thumbnail rule once the dimensions are known: its own ratio inside 280×320 (a landscape video is wide, a portrait one tall); before that a 16:9 placeholder", () => {
    const { container } = render(<MediaBody msg={msg({ name: "clip.mp4", mime: "video/mp4" })} />);
    const figure = container.querySelector("figure.attachment-media");
    expect(figure.hasAttribute("data-sized")).toBe(false);
    const video = container.querySelector("video");
    Object.defineProperty(video, "videoWidth", { configurable: true, value: 1920 });
    Object.defineProperty(video, "videoHeight", { configurable: true, value: 1080 });
    fireEvent.loadedMetadata(video);
    expect(figure.hasAttribute("data-sized")).toBe(true);
    const frame = container.querySelector(".media-frame");
    expect(figure.style.width).toBe("280px");
    expect(frame.style.aspectRatio.replace(/\s/g, "")).toBe("280/158");
    Object.defineProperty(video, "videoWidth", { configurable: true, value: 1080 });
    Object.defineProperty(video, "videoHeight", { configurable: true, value: 1920 });
    fireEvent.loadedMetadata(video);
    expect(frame.style.aspectRatio.replace(/\s/g, "")).toBe("180/320");
  });
});

describe("FileCard meta line", () => {
  it("the size and 「仅本会话可见」 are two units that wrap whole, never one character onto a third line; the text still reads as one line", () => {
    const { container } = render(<FileCard name="sd179.mp4" size={1_234_567} url="/x" />);
    const meta = container.querySelector(".file-card-meta");
    expect(meta.textContent).toBe("1.2 MB · 仅本会话可见");
    expect([...meta.children].map((c) => c.tagName)).toEqual(["SPAN", "SPAN"]);
  });
});
