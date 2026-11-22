// @vitest-environment jsdom
// Attachments in the chat pages: picking, paste, drop, progress, cancel, failures, retry, and how files and images are shown.
import React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { App } from "../src/App.jsx";
import { createDataLayer } from "../src/data/store.jsx";
import { ANN, ATT, D1, G1, ME, ME_ID, apiError, direct, emptySocial, fakeFile, fakeTimers, fakeTransport, fakeUploads, group, range, syncOf, wire } from "./fixtures.js";

const NOW = new Date(2026, 10, 16, 12, 0).getTime();
const IMG_ID = "00000000-0000-4000-8000-00000000e001";
const FILE_ID = "00000000-0000-4000-8000-00000000e002";
const EVIL = "<img src=x onerror=alert(1)>.txt";

const baseSync = () =>
  syncOf(
    [direct(D1, ANN, { lastSeq: 3, readSeq: 3 }), group(G1, { lastSeq: 40, readSeq: 40 })],
    [
      ...range(D1, 1, 2),
      wire(D1, 3, ANN, "看看这个", { kind: "file", attachment: { id: IMG_ID, name: "咖啡馆.png", size: 245760, inline: true } }),
      ...range(G1, 11, 38, [ANN]),
      wire(G1, 39, ANN, "", { kind: "file", attachment: { id: FILE_ID, name: EVIL, size: 1536, inline: false } }),
      wire(G1, 40, ANN, "收到"),
    ],
  );

let uploads;
function chatApi(over = {}) {
  uploads = fakeUploads();
  return {
    sendMessage: vi.fn(() => new Promise(() => {})),
    markRead: vi.fn(async (_id, seq) => ({ readSeq: seq })),
    listMessages: vi.fn(async () => ({ messages: [], nextBefore: null })),
    uploadAttachment: uploads.uploadAttachment,
    ...over,
  };
}

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(Element.prototype, "getClientRects").mockImplementation(() => [{ top: 0 }]);
  history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const flush = () =>
  act(async () => {
    for (let i = 0; i < 6; i += 1) await vi.advanceTimersByTimeAsync(0);
  });
const toastText = () => document.querySelector(".toast")?.textContent ?? null;

async function openApp({ sync = baseSync, api = {} } = {}) {
  const transport = fakeTransport({ sync, social: emptySocial });
  const calls = chatApi(api);
  let n = 0;
  const layer = createDataLayer({ transport, api: calls, timers: fakeTimers(), now: () => NOW, random: () => 0.5, uuid: () => `tx-${++n}` });
  render(<App api={{ getMe: async () => ME }} createLayer={() => layer} />);
  await flush();
  return { layer, transport, api: calls };
}
const openChat = async (name) => {
  fireEvent.click(screen.getByText(name, { selector: ".list-col .row-name" }));
  await flush();
};
const pickFiles = async (files, label = "选择文件") => {
  fireEvent.change(screen.getByLabelText(label), { target: { files } });
  await flush();
};
const timeline = () => document.querySelector("ol.messages");
const items = () => [...timeline().querySelectorAll("li.msg")];
const mine = () => items().filter((li) => li.classList.contains("mine"));

describe("picking files", () => {
  it("the image and file buttons open their pickers (images only for the first)", async () => {
    await openApp();
    await openChat("小安");
    const image = screen.getByLabelText("选择图片");
    const file = screen.getByLabelText("选择文件");
    expect(image.getAttribute("accept")).toBe("image/*");
    expect(file.getAttribute("accept")).toBeNull();
    const clicked = [];
    image.click = () => clicked.push("image");
    file.click = () => clicked.push("file");
    fireEvent.click(screen.getByRole("button", { name: "发送图片" }));
    fireEvent.click(screen.getByRole("button", { name: "发送文件" }));
    expect(clicked).toEqual(["image", "file"]);
  });

  it("each picked file becomes its own message, in order; 4 files: 3 uploads in flight, the 4th waits", async () => {
    await openApp();
    await openChat("小安");
    await pickFiles([fakeFile("一.txt", 100), fakeFile("二.txt", 100), fakeFile("三.txt", 100), fakeFile("四.txt", 100)]);
    expect(uploads.calls.map((c) => c.file.name)).toEqual(["一.txt", "二.txt", "三.txt"]);
    expect(mine().map((li) => li.querySelector(".file-card strong").textContent)).toEqual(["一.txt", "二.txt", "三.txt", "四.txt"]);
    expect(within(mine()[3]).getByText("等待上传…")).toBeTruthy();
    expect(within(mine()[0]).getByText("上传中 0%")).toBeTruthy();
    await act(async () => uploads.finish(1));
    await flush();
    expect(uploads.calls.map((c) => c.file.name)).toEqual(["一.txt", "二.txt", "三.txt", "四.txt"]);
    expect(within(mine()[3]).getByText("上传中 0%")).toBeTruthy();
  });

  it("progress is shown and updated, with a progress bar and the size", async () => {
    await openApp();
    await openChat("小安");
    await pickFiles([fakeFile("报告.pdf", 3 * 1024 * 1024)]);
    const card = () => mine()[0];
    expect(card().querySelector(".file-card-meta").textContent).toBe("3 MB · 仅本会话可见");
    act(() => uploads.progress(0, 0.37));
    expect(within(card()).getByText("上传中 37%")).toBeTruthy();
    expect(card().querySelector("progress").value).toBe(37);
    act(() => uploads.progress(0, 0.9));
    expect(within(card()).getByText("上传中 90%")).toBeTruthy();
  });

  it("after the upload the message shows 发送中… and, once sent, a download link", async () => {
    const answer = ATT(1, { name: "报告.pdf", size: 2048 });
    const { api } = await openApp({ api: { sendMessage: vi.fn(async () => ({ message: wire(D1, 4, ME_ID, "", { kind: "file", attachment: answer }), duplicate: false })) } });
    await openChat("小安");
    await pickFiles([fakeFile("报告.pdf", 2048)]);
    await act(async () => uploads.finish(0, answer));
    await flush();
    expect(api.sendMessage).toHaveBeenCalledWith(D1, { clientTxn: "tx-1", attachmentId: answer.id });
    const card = mine()[0].querySelector(".file-card");
    const link = card.closest("a");
    expect(link.getAttribute("href")).toBe(`/api/attachments/${answer.id}`);
    expect(link.getAttribute("download")).toBe("报告.pdf");
    expect(within(mine()[0]).getByText("已发送")).toBeTruthy();
  });

  it("cancel aborts the upload and removes the message", async () => {
    await openApp();
    await openChat("小安");
    await pickFiles([fakeFile("a.txt", 5)]);
    expect(mine()).toHaveLength(1);
    fireEvent.click(within(mine()[0]).getByRole("button", { name: "取消" }));
    await flush();
    expect(uploads.calls[0].signal.aborted).toBe(true);
    expect(mine()).toHaveLength(0);
  });

  it("an upload goes on while another conversation is open, and its progress is there when I come back", async () => {
    await openApp();
    await openChat("小安");
    await pickFiles([fakeFile("a.txt", 5)]);
    await openChat("周末小组");
    act(() => uploads.progress(0, 0.5));
    await openChat("小安");
    expect(within(mine()[0]).getByText("上传中 50%")).toBeTruthy();
  });

  it("a file over 1 GB is refused before any request, with a toast and no message; 1 GB itself goes", async () => {
    await openApp();
    await openChat("小安");
    await pickFiles([fakeFile("巨大.iso", 1024 * 1024 * 1024 + 1)]);
    expect(uploads.uploadAttachment).not.toHaveBeenCalled();
    expect(toastText()).toBe("「巨大.iso」超过 1 GB，无法发送");
    expect(mine()).toHaveLength(0);
    await pickFiles([fakeFile("刚好.bin", 1024 * 1024 * 1024)]);
    expect(uploads.uploadAttachment).toHaveBeenCalledTimes(1);
  });

  it("a picked image goes through the same queue (the image picker)", async () => {
    await openApp();
    await openChat("小安");
    await pickFiles([fakeFile("a.png", 5, "image/png")], "选择图片");
    expect(uploads.calls[0].file.name).toBe("a.png");
  });
});

describe("paste and drop", () => {
  it("pasting images from the clipboard uploads them; pasted text is left alone", async () => {
    await openApp();
    await openChat("小安");
    const box = screen.getByLabelText("消息内容");
    const text = fireEvent.paste(box, { clipboardData: { files: [], getData: () => "纯文字" } });
    expect(text).toBe(true); // not prevented: the browser pastes the text
    expect(uploads.uploadAttachment).not.toHaveBeenCalled();
    const notPrevented = fireEvent.paste(box, { clipboardData: { files: [fakeFile("image.png", 5, "image/png"), fakeFile("note.txt", 5, "text/plain")] } });
    expect(notPrevented).toBe(false);
    expect(uploads.calls.map((c) => c.file.name)).toEqual(["image.png"]);
  });

  it("dropping files on the chat uploads each, in order", async () => {
    await openApp();
    await openChat("小安");
    const chat = document.querySelector("section.chat");
    fireEvent.dragOver(chat, { dataTransfer: { types: ["Files"] } });
    expect(chat.classList.contains("dropping")).toBe(true);
    fireEvent.drop(chat, { dataTransfer: { types: ["Files"], files: [fakeFile("a.txt", 5), fakeFile("b.txt", 5)] } });
    await flush();
    expect(chat.classList.contains("dropping")).toBe(false);
    expect(uploads.calls.map((c) => c.file.name)).toEqual(["a.txt", "b.txt"]);
  });

  it("dropped folders are skipped, with or without the browser saying what each item is", async () => {
    await openApp();
    await openChat("小安");
    const chat = document.querySelector("section.chat");
    const folder = fakeFile("相册", 0, "");
    const real = fakeFile("a.txt", 5, "text/plain");
    const entry = (isDirectory) => ({ kind: "file", webkitGetAsEntry: () => ({ isDirectory }) });
    fireEvent.drop(chat, { dataTransfer: { types: ["Files"], files: [folder, real], items: [entry(true), entry(false)] } });
    await flush();
    expect(uploads.calls.map((c) => c.file.name)).toEqual(["a.txt"]);
    fireEvent.drop(chat, { dataTransfer: { types: ["Files"], files: [fakeFile("文件夹", 0, ""), fakeFile("b.txt", 5, "text/plain")] } });
    await flush();
    expect(uploads.calls.map((c) => c.file.name)).toEqual(["a.txt", "b.txt"]);
    expect(mine()).toHaveLength(2);
  });

  it("a chat that cannot send shows no drop outline while files are dragged over it", async () => {
    const sync = () => syncOf([direct(D1, ANN, { lastSeq: 1, canSend: { ok: false, reason: "not_friends" } })], range(D1, 1, 1));
    await openApp({ sync });
    await openChat("小安");
    const chat = document.querySelector("section.chat");
    fireEvent.dragOver(chat, { dataTransfer: { types: ["Files"] } });
    expect(chat.classList.contains("dropping")).toBe(false);
  });

  it("pasting an image together with text uploads the image and lets the text paste", async () => {
    await openApp();
    await openChat("小安");
    const pasted = fireEvent.paste(screen.getByLabelText("消息内容"), { clipboardData: { files: [fakeFile("image.png", 5, "image/png")], getData: () => "网页上的文字" } });
    expect(pasted).toBe(true); // not prevented
    expect(uploads.calls.map((c) => c.file.name)).toEqual(["image.png"]);
  });

  it("dropping something that is not a file does nothing", async () => {
    await openApp();
    await openChat("小安");
    const chat = document.querySelector("section.chat");
    const notPrevented = fireEvent.drop(chat, { dataTransfer: { types: ["text/plain"], files: [] } });
    expect(notPrevented).toBe(true);
    expect(uploads.uploadAttachment).not.toHaveBeenCalled();
  });

  it("dropping onto a conversation where sending is held shows the hold notice and uploads nothing", async () => {
    const sync = () => syncOf([direct(D1, ANN, { lastSeq: 1, canSend: { ok: false, reason: "not_friends" } })], range(D1, 1, 1));
    await openApp({ sync });
    await openChat("小安");
    fireEvent.drop(document.querySelector("section.chat"), { dataTransfer: { types: ["Files"], files: [fakeFile("a.txt", 5)] } });
    await flush();
    expect(uploads.uploadAttachment).not.toHaveBeenCalled();
    expect(toastText()).toContain("对方已不是你的好友");
    expect(mine()).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "发送图片" })).toBeNull();
    expect(screen.queryByRole("button", { name: "发送文件" })).toBeNull();
  });
});

describe("failures", () => {
  const failWith = async (error) => {
    await openApp();
    await openChat("小安");
    await pickFiles([fakeFile("a.txt", 5)]);
    await act(async () => uploads.fail(0, error));
    await flush();
    return mine()[0];
  };

  it("too_large: 文件超过 1 GB; no retry (it would fail the same way), cancel stays", async () => {
    const li = await failWith(apiError(413, "too_large"));
    expect(within(li).getByText(/发送失败，未发布/)).toBeTruthy();
    expect(within(li).getByText("文件超过 1 GB，无法发送")).toBeTruthy();
    expect(within(li).queryByRole("button", { name: /重试/ })).toBeNull();
    expect(within(li).getByRole("button", { name: "取消" })).toBeTruthy();
  });

  it("too_large with reason quota: the storage is full", async () => {
    const li = await failWith(apiError(413, "too_large", "quota"));
    expect(within(li).getByText("你的附件空间已用完，无法再发送文件")).toBeTruthy();
    expect(within(li).queryByRole("button", { name: /重试/ })).toBeNull();
  });

  it("rate_limited: too often, retry offered", async () => {
    const li = await failWith(apiError(429, "rate_limited"));
    expect(within(li).getByText("上传太频繁，请稍后再试")).toBeTruthy();
    expect(within(li).getByRole("button", { name: /重试/ })).toBeTruthy();
  });

  it("cannot_send: cannot send here, and the hold notice appears", async () => {
    const { transport } = await openApp();
    transport.handlers.conversation = (id) => direct(id, ANN, { lastSeq: 3, canSend: { ok: false, reason: "not_friends" } });
    await openChat("小安");
    await pickFiles([fakeFile("a.txt", 5)]);
    await act(async () => uploads.fail(0, apiError(403, "cannot_send", "not_friends")));
    await flush();
    expect(within(mine()[0]).getByText("当前无法在这个会话发送新消息")).toBeTruthy();
    expect(document.querySelector(".notice, [class*=notice]").textContent).toContain("对方已不是你的好友");
  });

  it("a network failure of the upload: retry uploads again; cancel removes it", async () => {
    const li = await failWith(apiError(0, "network_error"));
    expect(within(li).getByText("网络连接失败，请检查网络后重试")).toBeTruthy();
    fireEvent.click(within(li).getByRole("button", { name: /重试/ }));
    await flush();
    expect(uploads.uploadAttachment).toHaveBeenCalledTimes(2);
    expect(within(mine()[0]).getByText("上传中 0%")).toBeTruthy();
    await act(async () => uploads.fail(1, apiError(0, "network_error")));
    await flush();
    fireEvent.click(within(mine()[0]).getByRole("button", { name: "取消" }));
    await flush();
    expect(mine()).toHaveLength(0);
  });

  it("upload ok but send failed: 重试 sends again with the same clientTxn and does not upload again", async () => {
    const answer = ATT(1, { name: "a.txt", size: 5 });
    const sendMessage = vi.fn().mockRejectedValueOnce(apiError(0, "network_error")).mockResolvedValueOnce({ message: wire(D1, 4, ME_ID, "", { kind: "file", attachment: answer }), duplicate: false });
    await openApp({ api: { sendMessage } });
    await openChat("小安");
    await pickFiles([fakeFile("a.txt", 5)]);
    await act(async () => uploads.finish(0, answer));
    await flush();
    const li = mine()[0];
    expect(within(li).getByText(/发送失败，未发布/)).toBeTruthy();
    expect(within(li).queryByRole("button", { name: "取消" })).toBeNull();
    fireEvent.click(within(li).getByRole("button", { name: /重试/ }));
    await flush();
    expect(uploads.uploadAttachment).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls.map((c) => c[1])).toEqual([
      { clientTxn: "tx-1", attachmentId: answer.id },
      { clientTxn: "tx-1", attachmentId: answer.id },
    ]);
    expect(mine()[0].querySelector(".file-card")).toBeTruthy();
    expect(within(mine()[0]).getByText("已发送")).toBeTruthy();
  });
});

describe("showing attachments", () => {
  it("an inline attachment is only its picture: the same-origin URL, lazy, its file name as the accessible name, no caption, a button that opens the viewer", async () => {
    await openApp();
    await openChat("小安");
    const figure = timeline().querySelector("figure.attachment-image");
    const img = figure.querySelector("img");
    expect(img.getAttribute("src")).toBe(`/api/attachments/${IMG_ID}`);
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.getAttribute("alt")).toBe("咖啡馆.png");
    expect(figure.querySelector("figcaption")).toBeNull();
    expect(figure.textContent).toBe("");
    expect(figure.querySelector("a")).toBeNull();
    const open = within(figure).getByRole("button", { name: "咖啡馆.png" });
    expect(open.getAttribute("aria-haspopup")).toBe("dialog");
    expect(within(img.closest("li")).getByText("看看这个", { selector: ".bubble" })).toBeTruthy();
  });

  it("a picture is drawn in its own shape: the box is reserved from its natural size once it is known, and a panorama is cut to 2.5:1", async () => {
    await openApp();
    await openChat("小安");
    const figure = () => timeline().querySelector("figure.attachment-image");
    const img = figure().querySelector("img");
    // Before it is known: the placeholder (no size set).
    expect(figure().style.width).toBe("");
    expect(figure().dataset.sized).toBeUndefined();
    Object.defineProperty(img, "naturalWidth", { configurable: true, value: 3000 });
    Object.defineProperty(img, "naturalHeight", { configurable: true, value: 4000 });
    fireEvent.load(img);
    expect(figure().style.width).toBe("240px");
    expect(figure().querySelector("button").style.aspectRatio).toBe("240 / 320");
    expect(figure().dataset.sized).toBe("");
    Object.defineProperty(img, "naturalWidth", { configurable: true, value: 8000 });
    Object.defineProperty(img, "naturalHeight", { configurable: true, value: 1000 });
    fireEvent.load(img);
    expect(figure().style.width).toBe("280px");
    expect(figure().querySelector("button").style.aspectRatio).toBe("280 / 112");
  });

  describe("a picture that grows when it has loaded", () => {
    const measured = (list) => {
      let top = 0;
      Object.defineProperty(list, "scrollHeight", { configurable: true, get: () => 1000 });
      Object.defineProperty(list, "clientHeight", { configurable: true, get: () => 400 });
      Object.defineProperty(list, "scrollTop", { configurable: true, get: () => top, set: (v) => (top = v) });
      return { get top() { return top; }, set top(v) { top = v; } };
    };
    const loadIt = (img, w, h) => {
      Object.defineProperty(img, "naturalWidth", { configurable: true, value: w });
      Object.defineProperty(img, "naturalHeight", { configurable: true, value: h });
      fireEvent.load(img);
    };

    it("a chat at its newest message stays there (the list is taken to its end after the growth)", async () => {
      await openApp();
      await openChat("小安");
      const list = timeline();
      const scroll = measured(list);
      loadIt(list.querySelector("figure.attachment-image img"), 3000, 4000);
      expect(scroll.top).toBe(1000);
    });

    it("a chat scrolled up does not jump", async () => {
      await openApp();
      await openChat("小安");
      const list = timeline();
      const scroll = measured(list);
      scroll.top = 900;
      fireEvent.scroll(list);
      scroll.top = 100;
      fireEvent.scroll(list);
      loadIt(list.querySelector("figure.attachment-image img"), 3000, 4000);
      expect(scroll.top).toBe(100);
    });
  });

  it("an image that fails to load becomes the neutral 文件不可用 card", async () => {
    await openApp();
    await openChat("小安");
    fireEvent.error(timeline().querySelector("figure.attachment-image img"));
    expect(timeline().querySelector("figure.attachment-image")).toBeNull();
    const li = [...timeline().querySelectorAll("li.msg")].find((x) => x.textContent.includes("文件不可用"));
    expect(within(li).getByText("咖啡馆.png")).toBeTruthy();
    expect(li.querySelector("a")).toBeNull();
  });

  it("a file is a card with its name as text, a human size and a download link; no markup from the name", async () => {
    await openApp();
    await openChat("周末小组");
    const card = [...timeline().querySelectorAll(".file-card")].find((c) => c.textContent.includes("1.5 KB"));
    expect(card.querySelector("strong").textContent).toBe(EVIL);
    expect(card.querySelector("img")).toBeNull();
    expect(timeline().querySelector("img[src=x]")).toBeNull();
    expect(card.textContent).toContain("1.5 KB · 仅本会话可见");
    // The whole card is the one link that downloads; the button in it is its look, not a second tab stop.
    expect(card.tagName).toBe("A");
    expect(card.getAttribute("href")).toBe(`/api/attachments/${FILE_ID}`);
    expect(card.getAttribute("download")).toBe(EVIL);
    expect(card.getAttribute("aria-label")).toBe(`下载 ${EVIL}，1.5 KB`);
    expect(card.querySelectorAll("a, button, [tabindex]")).toHaveLength(0);
    const look = card.querySelector(".btn.btn-ghost.btn-sm");
    expect(look.textContent).toContain("下载");
    expect(look.getAttribute("aria-hidden")).toBe("true");
    expect(card.classList.contains("text-link")).toBe(false);
  });

  it("a pushed image message from the other side is shown as an image", async () => {
    const { transport } = await openApp();
    await openChat("小安");
    await act(async () => transport.socket.emit({ type: "message", message: wire(D1, 4, ANN, "", { kind: "file", attachment: { id: "00000000-0000-4000-8000-00000000e003", name: "新图.jpg", size: 9, inline: true } }) }));
    await flush();
    const imgs = [...timeline().querySelectorAll("figure.attachment-image img")].map((i) => i.getAttribute("src"));
    expect(imgs).toContain("/api/attachments/00000000-0000-4000-8000-00000000e003");
  });
});
