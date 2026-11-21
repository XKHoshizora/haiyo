// @vitest-environment jsdom
// The file card (src/ui/FileCard.jsx): an icon by kind, the name with its middle elided and its end kept, the size and the
// visibility line, one link for the whole card.
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { FileCard, FileName } from "../src/ui/FileCard.jsx";

afterEach(cleanup);

const URL_OF = "/api/attachments/00000000-0000-4000-8000-0000000000aa";

describe("the card", () => {
  it("is one link that downloads: the name, the size, the visibility line, the secondary button as its look, one tab stop", () => {
    const { container } = render(<FileCard name="季度报告.pdf" size={2048} url={URL_OF} />);
    const card = container.firstElementChild;
    expect(card.tagName).toBe("A");
    expect(card.getAttribute("href")).toBe(URL_OF);
    expect(card.getAttribute("download")).toBe("季度报告.pdf");
    expect(card.getAttribute("aria-label")).toBe("下载 季度报告.pdf，2 KB");
    expect(card.querySelector("strong").textContent).toBe("季度报告.pdf");
    expect(card.textContent).toContain("2 KB · 仅本会话可见");
    const look = card.querySelector(".btn.btn-ghost.btn-sm");
    expect(look.tagName).toBe("SPAN");
    expect(look.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelectorAll("a, button, input, [tabindex]")).toHaveLength(1);
    expect(card.querySelector("svg").getAttribute("aria-hidden")).toBe("true");
  });

  it("while it is being sent it is not a link: the progress, no download", () => {
    const { container } = render(<FileCard name="a.zip" size={10} upload={{ progress: 0.37 }} />);
    const card = container.firstElementChild;
    expect(card.tagName).toBe("DIV");
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector(".btn")).toBeNull();
    expect(container.querySelector("progress").value).toBe(37);
  });

  it.each([
    ["报告.pdf", null, "pdf"],
    ["a.docx", null, "document"],
    ["表.xlsx", null, "spreadsheet"],
    ["a.pptx", null, "slides"],
    ["a.zip", null, "archive"],
    ["歌.mp3", null, "audio"],
    ["a.mp4", null, "video"],
    ["main.py", null, "code"],
    ["photo.heic", null, "image"],
    ["a.exe", null, "other"],
    ["noext", "application/pdf", "pdf"],
    ["x", "image/svg+xml", "image"],
  ])("%s (%s) gets the %s icon", (name, mime, kind) => {
    const { container } = render(<FileCard name={name} size={1} mime={mime} url={URL_OF} />);
    expect(container.firstElementChild.dataset.kind).toBe(kind);
    expect(container.querySelector(`svg.file-icon-${kind}`)).not.toBeNull();
  });
});

describe("the name", () => {
  it("is two parts that read as one name, the whole of it in the title; the tail keeps the extension", () => {
    const name = "第三季度销售数据汇总报告（含各区域明细和同比环比分析）最终修订版.xlsx";
    const { container } = render(<FileName name={name} />);
    const strong = container.querySelector("strong");
    expect(strong.textContent).toBe(name);
    expect(strong.getAttribute("title")).toBe(name);
    const [head, tail] = [...strong.children];
    expect(head.className).toBe("file-name-head");
    expect(tail.className).toBe("file-name-tail");
    expect(tail.textContent.endsWith(".xlsx")).toBe(true);
    expect(head.textContent + tail.textContent).toBe(name);
    expect(head.textContent.startsWith("第三季度")).toBe(true);
  });

  it("is only text: markup in a name stays text", () => {
    const { container } = render(<FileName name="<img src=x onerror=alert(1)>.txt" />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("strong").textContent).toBe("<img src=x onerror=alert(1)>.txt");
  });

  it("the stylesheet cuts the head with an ellipsis and never the tail", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync("src/styles.css", "utf8");
    expect(css).toMatch(/\.file-name-head \{[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/);
    expect(css).toMatch(/\.file-name-tail \{[^}]*flex: none;/);
  });
});
