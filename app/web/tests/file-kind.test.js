// What a file card shows of a file: its kind (an icon) from the type, the extension as the fallback; its name with the
// middle left out and the end kept.
import { describe, expect, it } from "vitest";
import { FILE_KINDS, fileKind, splitFileName } from "../src/ui/fileKind.js";

describe("fileKind: the icon's kind", () => {
  it.each([
    ["application/pdf", "报告.pdf", "pdf"],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "a.docx", "document"],
    ["application/msword", "a", "document"],
    ["application/rtf", "a", "document"],
    ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "a.xlsx", "spreadsheet"],
    ["text/csv", "数据.csv", "spreadsheet"],
    ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "a.pptx", "slides"],
    ["application/vnd.ms-powerpoint", "a", "slides"],
    ["application/zip", "a.zip", "archive"],
    ["application/x-7z-compressed", "a", "archive"],
    ["application/gzip", "a", "archive"],
    ["audio/mpeg", "a.mp3", "audio"],
    ["video/mp4", "a.mp4", "video"],
    ["text/plain", "a.txt", "code"],
    ["application/json", "a.json", "code"],
    ["text/x-python", "a.py", "code"],
    ["image/svg+xml", "a.svg", "image"],
    ["image/heic", "a.heic", "image"],
    ["application/x-something", "a.unknown", "other"],
  ])("%s (%s) is %s", (mime, name, kind) => expect(fileKind({ mime, name })).toBe(kind));

  it.each([
    ["", "年度报告.PDF", "pdf"],
    ["application/octet-stream", "a.docx", "document"],
    [undefined, "表.XLSX", "spreadsheet"],
    [null, "a.key", "slides"],
    [undefined, "a.tar.gz", "archive"],
    [undefined, "歌.flac", "audio"],
    [undefined, "a.mkv", "video"],
    [undefined, "main.rs", "code"],
    [undefined, "readme.md", "code"],
    [undefined, "photo.bmp", "image"],
    [undefined, "noext", "other"],
    [undefined, ".bashrc", "other"],
    [undefined, "a.exe", "other"],
  ])("no usable type (%s): %s is %s from its extension", (mime, name, kind) => expect(fileKind({ mime, name })).toBe(kind));

  it("a known extension wins over the type (a browser's type can be wrong), the type decides when the extension is unknown", () => {
    expect(fileKind({ mime: "video/mp2t", name: "main.ts" })).toBe("code");
    expect(fileKind({ mime: "application/pdf", name: "x.txt" })).toBe("code");
    expect(fileKind({ mime: "application/pdf", name: "报告.unknownext" })).toBe("pdf");
    expect(fileKind({ mime: "application/pdf", name: "noext" })).toBe("pdf");
    expect(fileKind({ mime: "audio/x-weird", name: ".hidden" })).toBe("audio");
  });

  it("every kind has its icon colour in the stylesheet and its class in the app's class list", async () => {
    const { readFileSync } = await import("node:fs");
    const { APP_CLASSES } = await import("../src/ui/markdownRules.js");
    const css = readFileSync("src/styles.css", "utf8");
    for (const kind of FILE_KINDS) {
      expect(css, kind).toMatch(new RegExp(String.raw`\.file-icon-${kind}\b[^{]*\{`));
      expect(APP_CLASSES.has(`file-icon-${kind}`), kind).toBe(true);
    }
  });

  it("every kind the function gives is in the list the icons are drawn for", () => {
    expect([...FILE_KINDS].sort()).toEqual(["archive", "audio", "code", "document", "image", "other", "pdf", "slides", "spreadsheet", "video"]);
  });
});

describe("splitFileName: the middle goes, the end stays", () => {
  const whole = (name) => {
    const { head, tail } = splitFileName(name);
    expect(head + tail).toBe(name);
    return { head, tail };
  };

  it("a short name is all tail: it never gives way", () => {
    expect(whole("海边.png")).toEqual({ head: "", tail: "海边.png" });
  });

  it("a long name keeps its extension and a little before it", () => {
    const { head, tail } = whole("2026年第三季度销售数据汇总报告（最终修订版）.xlsx");
    expect(tail.endsWith(".xlsx")).toBe(true);
    expect(tail).toBe("最终修订版）.xlsx".slice(-9));
    expect([...tail]).toHaveLength(9);
    expect(head.startsWith("2026年")).toBe(true);
  });

  it("works on code points: a character outside the BMP is never cut in two", () => {
    const name = `${"😀".repeat(30)}.txt`;
    const { head, tail } = whole(name);
    expect([...tail]).toHaveLength(8);
    expect(head).toBe("😀".repeat(26));
    expect(/[\ud800-\udbff]$/.test(head)).toBe(false);
  });

  it("a long extension stays whole", () => {
    const name = `${"a".repeat(40)}.abcdefghijklmno`;
    const { tail } = whole(name);
    expect(tail.endsWith(".abcdefghijklmno")).toBe(true);
  });

  it("an extension too long to be one, and a name that is only a dot-word: the last characters", () => {
    expect([...whole(`${"b".repeat(30)}.${"c".repeat(30)}`).tail]).toHaveLength(6);
    expect(whole(".gitignore").tail).toBe("ignore");
  });

  it("a name with several dots keeps the last extension", () => {
    expect(whole(`${"x".repeat(40)}.tar.gz`).tail).toBe(".tar.gz");
  });

  it("an empty or missing name gives nothing", () => {
    expect(splitFileName("")).toEqual({ head: "", tail: "" });
    expect(splitFileName(undefined)).toEqual({ head: "", tail: "" });
  });
});
