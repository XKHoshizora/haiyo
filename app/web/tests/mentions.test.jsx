// @vitest-environment jsdom
// A mention carries who it means (Task M). The composer keeps each mention picked from the @ list as a tag — its range
// of the box's text and the id picked — through every edit, and sends it with the message (`mentions`); a stored
// message shows its mentions as tags over their ranges. The web never reads mention text to decide who is meant.
import React from "react";
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { App } from "../src/App.jsx";
import { createDataLayer } from "../src/data/store.jsx";
import { ADDRESS_PATTERN, addressRanges, afterEdit, capped, cleanWithMentions, editOf, inAddress, mentionSegments, mentionsIn, retag, settleEdits, withoutAddressed, withoutStale } from "../src/data/mentions.js";
import { markMentions } from "../src/ui/mentionMarks.js";
import { messageText } from "../src/auth/validation.js";
import { MentionText } from "../src/ui/MentionText.jsx";
import { ANN, BO, D1, G1, ME, ME_ID, PRINCIPALS, apiError, direct, emptySocial, fakeTimers, fakeTransport, group, principal, syncOf, wire } from "./fixtures.js";

const NOW = new Date(2026, 10, 16, 12, 0).getTime();

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
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

/** D1 with 小安; G1 with 小安 and 阿波 (or the `principals` given), each with `messages`; `api`: replaces calls. */
async function openApp({ principals = PRINCIPALS, messages = [], api: over = {} } = {}) {
  const lastSeq = (conv) => messages.filter((m) => m.conversationId === conv).reduce((max, m) => Math.max(max, m.seq), 0);
  const sync = () => syncOf([direct(D1, ANN, { lastSeq: lastSeq(D1), readSeq: lastSeq(D1) }), group(G1, { lastSeq: lastSeq(G1), readSeq: lastSeq(G1) })], messages, principals);
  const transport = fakeTransport({ sync, social: emptySocial });
  const api = {
    sendMessage: vi.fn(() => new Promise(() => {})),
    markRead: vi.fn(async (_id, seq) => ({ readSeq: seq })),
    listMessages: vi.fn(async () => ({ messages: [], nextBefore: null })),
    ...over,
  };
  let n = 0;
  const layer = createDataLayer({ transport, api, timers: fakeTimers(), now: () => NOW, random: () => 0.5, uuid: () => `tx-${++n}` });
  render(<App api={{ getMe: async () => ME }} createLayer={() => layer} />);
  await flush();
  return { layer, api, transport };
}
const openChat = async (name) => {
  fireEvent.click(screen.getByText(name, { selector: ".list-col .row-name" }));
  await flush();
};
const input = () => screen.getByLabelText("消息内容");
/** The box's text becomes `value`, the caret at `caret` (its end by default) — as the browser leaves it after an edit. */
const edit = (value, caret = value.length, init = {}) => fireEvent.change(input(), { target: { value, selectionStart: caret, selectionEnd: caret }, ...init });
/** Puts the caret (or a selection) in the box without changing its text, as a click there does. */
const caretAt = (start, end = start) => {
  input().setSelectionRange(start, end);
  fireEvent.click(input());
};
const press = (key, init = {}) => fireEvent.keyDown(input(), { key, ...init });
/** Types "@" at the caret's end of `before` and picks the member named `name` (the `nth` of that name). */
function pick(before, name, nth = 0) {
  edit(`${before}@`);
  fireEvent.click(screen.getAllByRole("option").filter((o) => o.querySelector("strong").textContent === name)[nth]);
}
/** The tags the composer shows (its mirror), as their text. */
const chips = () => [...document.querySelectorAll(".composer-mirror .mention-chip")].map((c) => c.textContent);
/** What the composer tells a screen reader it mentions. */
const spoken = () => {
  const id = input().getAttribute("aria-describedby");
  return id ? [...document.getElementById(id).querySelectorAll("li")].map((li) => li.textContent) : [];
};
const sentBody = (api) => api.sendMessage.mock.calls.at(-1)?.[1];

describe("the composer: a mention picked from the @ list is a tag meaning the one picked", () => {
  it("picking a member inserts a tag of their name; it is sent with their id and its range", async () => {
    const { api } = await openApp();
    await openChat("周末小组");
    pick("你好 ", "阿波");
    expect(input().value).toBe("你好 @阿波 ");
    expect(chips()).toEqual(["@阿波"]);
    expect(spoken()).toEqual(["提到 阿波"]);
    press("Enter");
    expect(sentBody(api)).toEqual({ clientTxn: "tx-1", text: "你好 @阿波", mentions: [{ id: BO, start: 3, length: 3 }] });
  });

  it("deletes as a unit: Backspace at its end or Delete at its start selects all of it for the deletion; a deletion that takes part of it takes it all", async () => {
    const { api } = await openApp();
    await openChat("周末小组");
    pick("", "阿波");
    edit("@阿波", 3);
    caretAt(3);
    press("Backspace");
    expect([input().selectionStart, input().selectionEnd]).toEqual([0, 3]);
    edit("", 0);
    expect(chips()).toEqual([]);
    pick("", "阿波");
    caretAt(0);
    press("Delete");
    expect([input().selectionStart, input().selectionEnd]).toEqual([0, 3]);
    // A keyboard that sends no key (a phone's): its one-character deletion at the tag's end takes the whole tag.
    edit("@阿 ", 2);
    expect(input().value).toBe(" ");
    expect(chips()).toEqual([]);
    edit("好 ", 1);
    press("Enter");
    expect(sentBody(api)).toEqual({ clientTxn: "tx-1", text: "好" });
  });

  it("tags are atomic (fix round 1, M-3): the caret cannot rest inside one; an edit that lands inside one takes the whole tag", async () => {
    const { api } = await openApp();
    await openChat("周末小组");
    pick("你好 ", "阿波");
    // A click inside the tag puts the caret at its nearer edge.
    caretAt(4);
    expect([input().selectionStart, input().selectionEnd]).toEqual([3, 3]);
    caretAt(5);
    expect([input().selectionStart, input().selectionEnd]).toEqual([6, 6]);
    // Moving with the keys: from its end into it goes to its start, from its start into it to its end.
    press("ArrowLeft");
    input().setSelectionRange(5, 5);
    fireEvent.keyUp(input(), { key: "ArrowLeft" });
    expect(input().selectionStart).toBe(3);
    press("ArrowRight");
    input().setSelectionRange(4, 4);
    fireEvent.keyUp(input(), { key: "ArrowRight" });
    expect(input().selectionStart).toBe(6);
    // A paste (or any change) that lands inside it takes all of it and keeps what was pasted.
    edit("你好 @阿x波 ", 6);
    expect(input().value).toBe("你好 x ");
    expect(chips()).toEqual([]);
    expect([input().selectionStart, input().selectionEnd]).toEqual([4, 4]);
    press("Enter");
    expect(sentBody(api)).toEqual({ clientTxn: "tx-1", text: "你好 x" });
  });

  it("the browser's own undo of a pick is kept as the browser made it (the @ typed before stays), and its redo brings the tag back", async () => {
    await openApp();
    await openChat("周末小组");
    pick("你好 ", "阿波");
    fireEvent.input(input(), { target: { value: "你好 @", selectionStart: 4, selectionEnd: 4 }, inputType: "historyUndo" });
    expect(input().value).toBe("你好 @");
    expect(chips()).toEqual([]);
    fireEvent.input(input(), { target: { value: "你好 @阿波 ", selectionStart: 7, selectionEnd: 7 }, inputType: "historyRedo" });
    expect(input().value).toBe("你好 @阿波 ");
    expect(chips()).toEqual(["@阿波"]);
  });

  it("a deletion during IME composition that cuts into a tag takes all of it once the composition ends", async () => {
    await openApp();
    await openChat("周末小组");
    pick("", "阿波");
    fireEvent.compositionStart(input());
    edit("@阿 ", 2);
    expect(chips()).toEqual([]);
    expect(input().value).toBe("@阿 ");
    fireEvent.compositionEnd(input());
    expect(input().value).toBe(" ");
  });

  it("its range stays right through typing before and after it, a paste, a cut, line breaks and an emoji before it", async () => {
    const { api } = await openApp();
    await openChat("周末小组");
    pick("", "阿波");
    edit("@阿波 你好", 6);
    caretAt(0);
    edit("嗨@阿波 你好", 1);
    edit("😀嗨@阿波 你好", 2);
    edit("😀嗨\n@阿波 你好", 4);
    caretAt(0);
    edit("粘贴进来的😀嗨\n@阿波 你好", 5);
    caretAt(0, 2);
    edit("进来的😀嗨\n@阿波 你好", 0);
    edit("进来的😀嗨\n@阿波 你好\n第二行", 15);
    expect(chips()).toEqual(["@阿波"]);
    press("Enter");
    expect(sentBody(api)).toEqual({ clientTxn: "tx-1", text: "进来的😀嗨\n@阿波 你好\n第二行", mentions: [{ id: BO, start: 7, length: 3 }] });
  });

  it("undo brings a deleted tag back as the tag it was; redo takes it again", async () => {
    const { api } = await openApp();
    await openChat("周末小组");
    pick("", "阿波");
    caretAt(3);
    press("Backspace");
    edit(" ", 0, { inputType: "deleteContentBackward" });
    expect(chips()).toEqual([]);
    edit("@阿波 ", 3, { inputType: "historyUndo" });
    expect(chips()).toEqual(["@阿波"]);
    edit(" ", 0, { inputType: "historyRedo" });
    expect(chips()).toEqual([]);
    edit("@阿波 ", 3, { inputType: "historyUndo" });
    edit("@阿波 好", 5);
    press("Enter");
    expect(sentBody(api)).toEqual({ clientTxn: "tx-1", text: "@阿波 好", mentions: [{ id: BO, start: 0, length: 3 }] });
  });

  it("IME composition before, right after and right next to a tag keeps its range and duplicates nothing", async () => {
    const { api } = await openApp();
    await openChat("周末小组");
    pick("", "阿波");
    edit("@阿波", 3);
    // Composing right after it (its end, no space between).
    fireEvent.compositionStart(input());
    edit("@阿波h", 4);
    edit("@阿波hao", 6);
    // The IME's own Backspace while composing touches no tag.
    caretAt(6);
    fireEvent.keyDown(input(), { key: "Backspace", isComposing: true, keyCode: 229 });
    expect([input().selectionStart, input().selectionEnd]).toEqual([6, 6]);
    edit("@阿波好", 4);
    fireEvent.compositionEnd(input());
    // Composing before it, at the very start.
    caretAt(0);
    fireEvent.compositionStart(input());
    edit("n@阿波好", 1);
    edit("ni@阿波好", 2);
    edit("你@阿波好", 1);
    fireEvent.compositionEnd(input());
    // And right before it, between 你 and the tag.
    fireEvent.compositionStart(input());
    edit("你m@阿波好", 2);
    edit("你们@阿波好", 2);
    fireEvent.compositionEnd(input());
    expect(input().value).toBe("你们@阿波好");
    expect(chips()).toEqual(["@阿波"]);
    press("Enter");
    expect(sentBody(api)).toEqual({ clientTxn: "tx-1", text: "你们@阿波好", mentions: [{ id: BO, start: 2, length: 3 }] });
  });

  it("two people of the same name: each tag means its own person", async () => {
    const { api } = await openApp({ principals: [principal(ME_ID, "me_one", "Mei"), principal(ANN, "ann", "阿波"), principal(BO, "bo", "阿波")] });
    await openChat("周末小组");
    pick("", "阿波", 0);
    pick("@阿波 ", "阿波", 1);
    expect(chips()).toEqual(["@阿波", "@阿波"]);
    press("Enter");
    expect(sentBody(api).mentions).toEqual([
      { id: ANN, start: 0, length: 3 },
      { id: BO, start: 4, length: 3 },
    ]);
  });

  it("a name of more than one word (「Jarvis Lee」) is one tag meaning that person", async () => {
    const { api } = await openApp({ principals: [principal(ME_ID, "me_one", "Mei"), principal(ANN, "ann", "小安"), principal(BO, "bo", "Jarvis Lee")] });
    await openChat("周末小组");
    pick("", "Jarvis Lee");
    expect(chips()).toEqual(["@Jarvis Lee"]);
    expect(spoken()).toEqual(["提到 Jarvis Lee"]);
    press("Enter");
    expect(sentBody(api)).toEqual({ clientTxn: "tx-1", text: "@Jarvis Lee", mentions: [{ id: BO, start: 0, length: 11 }] });
  });

  it("a draft keeps its tags; another conversation's composer shows none of them", async () => {
    const { layer, api } = await openApp();
    await openChat("周末小组");
    pick("你好 ", "阿波");
    await openChat("小安");
    expect(input().value).toBe("");
    expect(chips()).toEqual([]);
    expect(spoken()).toEqual([]);
    edit("私聊的草稿");
    await openChat("周末小组");
    expect(input().value).toBe("你好 @阿波 ");
    expect(chips()).toEqual(["@阿波"]);
    expect(layer.getSnapshot().model.drafts[G1]).toEqual({ text: "你好 @阿波 ", mentions: [{ id: BO, start: 3, length: 3 }] });
    expect(layer.getSnapshot().model.drafts[D1]).toBe("私聊的草稿");
    press("Enter");
    expect(sentBody(api).mentions).toEqual([{ id: BO, start: 3, length: 3 }]);
  });

  it("an @ typed and not picked is sent as plain text (the service reads it once)", async () => {
    const { api } = await openApp();
    await openChat("周末小组");
    edit("@bo 你好");
    press("Enter");
    expect(sentBody(api)).toEqual({ clientTxn: "tx-1", text: "@bo 你好" });
  });

  it("a picked member who left: the tag turns into plain text without its @, and a line says so (fix round 1, I-2)", async () => {
    const { api, transport } = await openApp();
    await openChat("周末小组");
    pick("你好 ", "阿波");
    transport.handlers.conversation = () =>
      group(G1, { members: [{ id: ME_ID, role: "speaker", isCreator: true }, { id: ANN, role: "speaker", isCreator: false }] });
    await act(async () => transport.socket.emit({ type: "conversation", id: G1 }));
    await flush();
    expect(input().value).toBe("你好 阿波 ");
    expect(chips()).toEqual([]);
    expect(document.querySelector(".composer").textContent).toContain("@阿波 已不在这个群，已改成普通文字。");
    press("Enter");
    expect(sentBody(api)).toEqual({ clientTxn: "tx-1", text: "你好 阿波" });
  });

  it("a refusal for a mention that went stale (bad_mentions): no 重试; 改一下 puts the text and its tags back in the box (fix round 1, I-2)", async () => {
    const sendMessage = vi.fn(async () => Promise.reject(apiError(400, "bad_mentions")));
    const { api } = await openApp({ api: { sendMessage } });
    await openChat("周末小组");
    pick("你好 ", "阿波");
    press("Enter");
    await flush();
    const failed = document.querySelector("li.msg.mine");
    expect(failed.textContent).toContain("有一个 @ 的对象已经不在这里了，改一下再发。");
    expect([...failed.querySelectorAll("button")].map((b) => b.textContent.trim())).not.toContain("重试");
    expect(input().value).toBe("");
    fireEvent.click([...failed.querySelectorAll("button")].find((b) => b.textContent.trim() === "改一下"));
    await flush();
    expect(document.querySelector("li.msg.mine")).toBeNull();
    expect(input().value).toBe("你好 @阿波");
    expect(chips()).toEqual(["@阿波"]);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("改一下 into a box that already holds text and tags: the refused message follows on a new line, its tags moved with it (fix round 2, M-5)", async () => {
    const sendMessage = vi.fn(async () => Promise.reject(apiError(400, "bad_mentions")));
    await openApp({ api: { sendMessage } });
    await openChat("周末小组");
    pick("你好 ", "阿波");
    press("Enter");
    await flush();
    pick("新的 ", "小安");
    fireEvent.click([...document.querySelectorAll("li.msg.mine button")].find((b) => b.textContent.trim() === "改一下"));
    await flush();
    expect(input().value).toBe("新的 @小安 \n你好 @阿波");
    expect(chips()).toEqual(["@小安", "@阿波"]);
    expect(spoken()).toEqual(["提到 小安", "提到 阿波"]);
  });

  it("the 20 cap holds when a cut tag comes back where it was (as an undo brings it back): the one over loses its @ (fix round 2, M-7)", async () => {
    const { api } = await openApp();
    await openChat("周末小组");
    for (let i = 0; i < 20; i += 1) pick(input().value, i % 2 ? "小安" : "阿波");
    expect(chips()).toHaveLength(20);
    // The first tag cut (19), one more picked at the end (20), the cut text put back at its place: its tag comes back.
    edit(input().value.slice(3), 0);
    expect(chips()).toHaveLength(19);
    pick(input().value, "小安");
    expect(chips()).toHaveLength(20);
    edit(`@阿波${input().value}`, 3);
    expect(chips()).toHaveLength(20);
    expect(chips()[0]).toBe("@阿波");
    expect(input().value.endsWith(" 小安 ")).toBe(true);
    expect(document.querySelector(".composer").textContent).toContain("一条消息最多 @ 20 个，多出的已改成普通文字。");
    press("Enter");
    expect(sentBody(api).mentions).toHaveLength(20);
  });

  it("the 20 cap holds through 改一下: what is over it turns into plain text without its @, and a line says so (fix round 2, M-7)", async () => {
    const sendMessage = vi.fn(async () => Promise.reject(apiError(400, "bad_mentions")));
    await openApp({ api: { sendMessage } });
    await openChat("周末小组");
    pick("", "阿波");
    press("Enter");
    await flush();
    for (let i = 0; i < 20; i += 1) pick(input().value, i % 2 ? "小安" : "阿波");
    fireEvent.click([...document.querySelectorAll("li.msg.mine button")].find((b) => b.textContent.trim() === "改一下"));
    await flush();
    expect(chips()).toHaveLength(20);
    expect(input().value.endsWith("\n阿波")).toBe(true);
    expect(document.querySelector(".composer").textContent).toContain("一条消息最多 @ 20 个，多出的已改成普通文字。");
  });

  it("a tag that comes to sit in an address (right after a / or inside a URL) turns into plain text, and a line says so (fix round 2, M-1)", async () => {
    const { api } = await openApp();
    await openChat("周末小组");
    pick("", "阿波");
    caretAt(0);
    edit("https://x.example/@阿波 ", 18);
    expect(chips()).toEqual([]);
    expect(input().value).toBe("https://x.example/@阿波 ");
    expect(document.querySelector(".composer").textContent).toContain("@阿波 在网址里，已改成普通文字。");
    press("Enter");
    expect(sentBody(api)).toEqual({ clientTxn: "tx-1", text: "https://x.example/@阿波" });
  });

  it("a member whose name looks like an address (www.anna) is picked like anyone: the tag stays, no line, sent with its id (tidy round, m-6)", async () => {
    const { api } = await openApp({ principals: [principal(ME_ID, "me_one", "Mei"), principal(ANN, "ann", "小安"), principal(BO, "bo", "www.anna")] });
    await openChat("周末小组");
    pick("你好 ", "www.anna");
    expect(chips()).toEqual(["@www.anna"]);
    expect(document.querySelector(".composer").textContent).not.toContain("在网址里");
    press("Enter");
    expect(sentBody(api)).toEqual({ clientTxn: "tx-1", text: "你好 @www.anna", mentions: [{ id: BO, start: 3, length: 9 }] });
  });

  it("the box losing focus ends an IME composition the browser never ended: what is left of a tag it cut into goes (tidy round, m-9)", async () => {
    await openApp();
    await openChat("周末小组");
    pick("你好 ", "阿波");
    fireEvent.compositionStart(input());
    edit("你好 @阿哈波 ", 6);
    expect(input().value).toBe("你好 @阿哈波 ");
    fireEvent.blur(input());
    expect(input().value).toBe("你好 哈 ");
    // No composition any more: an edit inside a tag takes it whole at once.
    pick(input().value, "小安");
    edit("你好 哈 @小x安 ", 9);
    expect(input().value).toBe("你好 哈 x ");
  });

  it("a send clears an IME composition the browser never ended: the next edit inside a tag takes it whole (tidy round, m-9)", async () => {
    const { api } = await openApp();
    await openChat("周末小组");
    pick("你好 ", "阿波");
    fireEvent.compositionStart(input());
    edit("你好 @阿哈波 ", 6);
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(sentBody(api)).toEqual({ clientTxn: "tx-1", text: "你好 哈" });
    pick("", "小安");
    edit("@小x安 ", 3);
    expect(input().value).toBe("x ");
  });

  it("send with an IME composition open (a tap on 发送): what is left of a tag it cut into is cut first, the composed text kept (fix round 2, M-3)", async () => {
    const { api } = await openApp();
    await openChat("周末小组");
    pick("你好 ", "阿波");
    fireEvent.compositionStart(input());
    edit("你好 @阿哈波 ", 6);
    expect(chips()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(sentBody(api)).toEqual({ clientTxn: "tx-1", text: "你好 哈" });
  });

  it("a 21st mention cannot be picked: the list says so and nothing is inserted (fix round 1, M-4)", async () => {
    await openApp();
    await openChat("周末小组");
    for (let i = 0; i < 20; i += 1) pick(input().value, i % 2 ? "小安" : "阿波");
    expect(chips()).toHaveLength(20);
    const before = input().value;
    edit(`${before}@`);
    const list = document.querySelector(".mention-picker");
    expect(list.textContent).toContain("一条消息最多 @ 20 个。");
    expect(list.querySelectorAll('[role="option"]')).toHaveLength(0);
    expect(input().value).toBe(`${before}@`);
    expect(chips()).toHaveLength(20);
  });

  it("the browser's own insertion (execCommand insertText, as real browsers take it) makes the same tag (fix round 1, M-7)", async () => {
    const { api } = await openApp();
    await openChat("周末小组");
    document.execCommand = vi.fn((command, _ui, value) => {
      const el = document.activeElement;
      if (command !== "insertText" || !el) return false;
      el.setRangeText(value, el.selectionStart, el.selectionEnd, "end");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    });
    try {
      edit("你好 @", 4);
      fireEvent.click(screen.getAllByRole("option").find((o) => o.querySelector("strong").textContent === "阿波"));
      expect(document.execCommand).toHaveBeenCalledWith("insertText", false, "@阿波 ");
      expect(input().value).toBe("你好 @阿波 ");
      expect(chips()).toEqual(["@阿波"]);
      expect([input().selectionStart, input().selectionEnd]).toEqual([7, 7]);
      press("Enter");
      expect(sentBody(api)).toEqual({ clientTxn: "tx-1", text: "你好 @阿波", mentions: [{ id: BO, start: 3, length: 3 }] });
    } finally {
      delete document.execCommand;
    }
  });

  it("phone width: the tags' layer follows the box's own type and padding there", () => {
    const css = readFileSync("src/styles.css", "utf8");
    const mobile = css.slice(css.indexOf("@media (max-width: 860px)"));
    expect(mobile).toMatch(/\.composer textarea,\s*\.composer-mirror\s*\{[^}]*font-size: 14px;[^}]*padding: 12px;/);
    expect(css).toMatch(/\.composer textarea,\s*\.composer-mirror\s*\{/);
  });
});

describe("a stored message shows its mentions as tags", () => {
  it("over their ranges, each read as 提到 and the name; without mentions it is plain text; mentions that do not fit are left out", async () => {
    const messages = [
      wire(G1, 1, ANN, "@阿波 你好 @Mei", { mentions: [{ id: BO, start: 0, length: 3 }, { id: ME_ID, start: 7, length: 4 }] }),
      wire(G1, 2, ANN, "@阿波 没有存提到"),
      wire(G1, 3, ANN, "坏的 @阿波", { mentions: [{ id: BO, start: 0, length: 3 }, { id: BO, start: 3, length: 9 }] }),
    ];
    await openApp({ messages });
    await openChat("周末小组");
    const bubble = (seq) => document.querySelector(`li[data-msg="m${seq}"] .bubble`);
    const tags = (seq) => [...bubble(seq).querySelectorAll(".mention")].map((t) => [t.querySelector(".sr-only").textContent, t.querySelector('[aria-hidden="true"]').textContent]);
    expect(tags(1)).toEqual([
      ["提到 阿波", "@阿波"],
      // (Me, by the name the app gives me.)
      ["提到 你", "@Mei"],
    ]);
    expect(bubble(1).querySelector(".mention").dataset.mention).toBe(BO);
    expect(tags(2)).toEqual([]);
    expect(bubble(2).textContent).toBe("@阿波 没有存提到");
    expect(tags(3)).toEqual([]);
  });

  it("a tag shows its principal's current name, not the one it was sent with, and is read as 提到 and that name (fix round 1, M-2)", async () => {
    const messages = [wire(G1, 1, ANN, "@旧名字 你好", { mentions: [{ id: BO, start: 0, length: 4 }] })];
    await openApp({ messages });
    await openChat("周末小组");
    const tag = document.querySelector('li[data-msg="m1"] .mention');
    expect(tag.querySelector(".sr-only").textContent).toBe("提到 阿波");
    expect(tag.querySelector('[aria-hidden="true"]').textContent).toBe("@阿波");
    expect(tag.getAttribute("title")).toBeNull();
  });

  it("MentionText: the text as sent, cut at its mentions", () => {
    const { container } = render(<p><MentionText text="嗨 @Jarvis Lee！" mentions={[{ id: BO, start: 2, length: 11 }]} /></p>);
    expect(container.querySelector(".mention .sr-only").textContent).toBe("提到 Jarvis Lee");
    expect(container.querySelector('.mention [aria-hidden="true"]').textContent).toBe("@Jarvis Lee");
    expect(mentionSegments("嗨 @Jarvis Lee！", [{ id: BO, start: 2, length: 11 }]).map((p) => p.text)).toEqual(["嗨 ", "@Jarvis Lee", "！"]);
  });
});

describe("the web's mention functions are linear in the text (fix round 2, I-4; tidy round, m-7)", () => {
  // A text of 8 000 code points holds up to 16 000 UTF-16 code units, what these functions work on: 4 000 against
  // 16 000, twenty tags first, then one shape of text.
  const shapes = [
    ["@ and a run of letters", (n) => `@${"a".repeat(n)}`],
    ["letters, dots and dashes", (n) => "a.b-c+".repeat(n / 6)],
    ["www. again and again", (n) => "www.".repeat(n / 4)],
    ["schemes without //", (n) => "http:".repeat(n / 5)],
    ["link targets", (n) => "](".repeat(n / 2)],
    ["URLs between spaces", (n) => "http://x/@y ".repeat(n / 12)],
    ["mentions after slashes", (n) => "/@ab ".repeat(n / 5)],
    ["Chinese, @ and URLs", (n) => "你好@x https://a.b/@c ".repeat(n / 20)],
  ];
  const head = Array.from({ length: 20 }, () => "@阿波 ").join("");
  const tags = Array.from({ length: 20 }, (_, i) => ({ id: BO, start: i * 4, length: 3 }));
  const make = (fill, n) => (head + fill(n)).slice(0, n);
  // One call's time over a burst (the call repeated for at least 20 ms); per call the shortest of three bursts (a busy
  // machine only adds time); the ratio, after a warm-up, the median of five, the two sizes measured one after the other.
  const burst = (work) => {
    let calls = 0;
    const started = performance.now();
    let spent = 0;
    do {
      work();
      calls += 1;
      spent = performance.now() - started;
    } while (spent < 20);
    return spent / calls;
  };
  const perCall = (work) => Math.min(burst(work), burst(work), burst(work));
  const expectLinear = (name, run) => {
    for (const [shape, fill] of shapes) {
      const [small, large] = [make(fill, 4000), make(fill, 16000)];
      expect(large.length, shape).toBeGreaterThan(15900);
      const [inLarge, inSmall] = [() => run(large), () => run(small)];
      burst(inLarge);
      burst(inSmall);
      const ratio = Array.from({ length: 5 }, () => perCall(inLarge) / perCall(inSmall)).sort((a, b) => a - b)[2];
      expect(ratio, `${name}, ${shape}: 4× the text took ${ratio.toFixed(1)}× the time`).toBeLessThan(8);
    }
  };

  it("markMentions (20 mentions)", () => expectLinear("markMentions", (text) => markMentions(text, tags)), 60_000);
  it("withoutAddressed (20 tags)", () => expectLinear("withoutAddressed", (text) => withoutAddressed({ text, tags, removals: [] })), 60_000);
  it("cleanWithMentions (20 tags)", () => expectLinear("cleanWithMentions", (text) => cleanWithMentions(text, tags)), 60_000);
  it("afterEdit (20 tags, a character typed at the end)", () =>
    expectLinear("afterEdit", (text) => afterEdit({ text, tags, removals: [] }, `${text}x`, { hint: { start: text.length, end: text.length } })), 60_000);
});

describe("data/mentions.js", () => {
  it("mentionsIn keeps what fits its text: in bounds, at an @, in order, not overlapping, at most 20", () => {
    const text = "@a @b @c";
    expect(mentionsIn(text, [{ id: "x", start: 0, length: 2 }, { id: "y", start: 3, length: 2 }])).toEqual([{ id: "x", start: 0, length: 2 }, { id: "y", start: 3, length: 2 }]);
    expect(mentionsIn(text, [{ id: "x", start: 1, length: 2 }])).toEqual([]);
    expect(mentionsIn(text, [{ id: "x", start: 6, length: 3 }])).toEqual([]);
    expect(mentionsIn(text, [{ id: "x", start: 3, length: 2 }, { id: "y", start: 0, length: 2 }])).toEqual([{ id: "x", start: 3, length: 2 }]);
    expect(mentionsIn(text, null)).toEqual([]);
    expect(mentionsIn("@x ".repeat(30), Array.from({ length: 30 }, (_, i) => ({ id: "x", start: i * 3, length: 2 })))).toHaveLength(20);
  });

  it("editOf takes the change at the caret when several are as small; retag keeps, moves, removes or breaks each tag", () => {
    expect(editOf("@Ann", "@Annn")).toEqual({ start: 4, end: 4, inserted: "n" });
    expect(editOf("@Ann", "@Annn", { start: 3, end: 3 })).toEqual({ start: 3, end: 3, inserted: "n" });
    expect(editOf("@Annn", "@Ann", { start: 5, end: 5 })).toEqual({ start: 4, end: 5, inserted: "" });
    const tags = [{ id: "a", start: 1, length: 4 }];
    expect(retag(tags, { start: 0, end: 0, inserted: "xy" }).kept).toEqual([{ id: "a", start: 3, length: 4 }]);
    expect(retag(tags, { start: 5, end: 5, inserted: "z" }).kept).toEqual(tags);
    expect(retag(tags, { start: 0, end: 6, inserted: "" }).removed).toEqual(tags);
    expect(retag(tags, { start: 3, end: 3, inserted: "q" }).broken).toEqual(tags);
    // A deletion that takes part of a tag takes all of it (afterEdit; a phone keyboard's Backspace sends no key).
    expect(afterEdit({ text: "x@abcd", tags: [{ id: "a", start: 1, length: 5 }], removals: [] }, "x@abc", { hint: { start: 6, end: 6 } })).toMatchObject({
      text: "x",
      tags: [],
      caret: 1,
    });
  });

  it("afterEdit: an edit inside a tag takes the whole tag; while composing it is cut once the composition ends (settleEdits)", () => {
    const state = { text: "嗨 @阿波 好", tags: [{ id: BO, start: 2, length: 3 }], removals: [] };
    const typed = afterEdit(state, "嗨 @阿x波 好", { hint: { start: 4, end: 4 } });
    expect([typed.text, typed.tags, typed.caret]).toEqual(["嗨 x 好", [], 3]);
    const composing = afterEdit(state, "嗨 @阿 好", { hint: { start: 5, end: 5 }, composing: true });
    expect([composing.text, composing.tags.map((t) => [t.start, t.length, Boolean(t.broken)])]).toEqual(["嗨 @阿 好", [[2, 2, true]]]);
    expect(settleEdits(composing)).toMatchObject({ text: "嗨  好", tags: [], caret: 2 });
    const picked = afterEdit({ text: "@", tags: [], removals: [] }, "@阿波 ", { hint: { start: 0, end: 1 }, picking: { id: BO, start: 0, length: 3, text: "@阿波" } });
    expect(picked.tags).toEqual([{ id: BO, start: 0, length: 3 }]);
  });

  it("afterEdit: the browser's own undo and redo are never rewritten — an undo that cuts into a tag drops it, the redo brings it back (real-browser check)", () => {
    const picked = { text: "你好 @阿波 ", tags: [{ id: BO, start: 3, length: 3 }], removals: [] };
    const undone = afterEdit(picked, "你好 @", { hint: { start: 7, end: 7 }, history: true });
    expect([undone.text, undone.tags, undone.caret]).toEqual(["你好 @", [], null]);
    const redone = afterEdit(undone, "你好 @阿波 ", { hint: { start: 4, end: 4 }, history: true });
    expect([redone.text, redone.tags]).toEqual(["你好 @阿波 ", [{ id: BO, start: 3, length: 3 }]]);
    // Typing the same text by hand is no redo: it stays plain.
    expect(afterEdit(undone, "你好 @阿波 ", { hint: { start: 4, end: 4 } }).tags).toEqual([]);
  });

  it("afterEdit while composing keeps the composed text: only what is left of the tag is cut (fix round 2, M-3)", () => {
    const state = { text: "嗨 @阿波 好", tags: [{ id: BO, start: 2, length: 3 }], removals: [] };
    const composing = afterEdit(state, "嗨 @阿x波 好", { hint: { start: 4, end: 4 }, composing: true });
    expect(composing.tags.map((t) => [t.start, t.length, Boolean(t.broken)])).toEqual([
      [2, 2, true],
      [5, 1, true],
    ]);
    expect(settleEdits(composing, 5)).toMatchObject({ text: "嗨 x 好", tags: [], caret: 3 });
  });

  it("withoutStale: a @ right before the tag is kept from making a new mention (fix round 2, M-9)", () => {
    const state = { text: "@@阿波 好", tags: [{ id: BO, start: 1, length: 3 }], removals: [] };
    expect(withoutStale(state, () => false)).toMatchObject({ text: "@ 阿波 好", tags: [], stale: ["@阿波"] });
  });

  it("withoutAddressed and capped: a tag in an address stays as text without its tag; over 20, the last ones lose their @", () => {
    const addressed = withoutAddressed({ text: "x.example/@阿波 和 @小安", tags: [{ id: BO, start: 10, length: 3 }, { id: ANN, start: 16, length: 3 }], removals: [] });
    expect([addressed.text, addressed.tags, addressed.addressed]).toEqual(["x.example/@阿波 和 @小安", [{ id: ANN, start: 16, length: 3 }], ["@阿波"]]);
    const many = { text: "@x ".repeat(21).trim(), tags: Array.from({ length: 21 }, (_, i) => ({ id: BO, start: i * 3, length: 2 })), removals: [] };
    const cut = capped(many);
    expect(cut.tags).toHaveLength(20);
    expect(cut.text.endsWith("@x x")).toBe(true);
    expect(cut.over).toEqual(["@x"]);
  });

  it("cleanWithMentions sends no tag that sits in an address (the service would refuse it)", () => {
    expect(cleanWithMentions("x.example/@阿波", [{ id: BO, start: 10, length: 3 }])).toEqual({ text: "x.example/@阿波", mentions: [] });
  });

  it("the address rule is the shared table's (app/shared/address-cases.json, which the service's tests assert too): the pattern, the addresses, a picked tag's own text never an address, in an address or not (tidy round, m-6, m-7)", () => {
    // (A path from the web package's folder, where its tests run.)
    const table = JSON.parse(readFileSync("../shared/address-cases.json", "utf8"));
    expect(ADDRESS_PATTERN.source).toBe(table.pattern);
    expect(table.cases.length).toBeGreaterThan(10);
    for (const c of table.cases) {
      const found = addressRanges(c.text, c.taken);
      expect([c.note, found]).toEqual([c.note, c.addresses]);
      for (const [start, length, expected] of c.checks) expect([c.note, start, inAddress(c.text, start, length, found)]).toEqual([c.note, start, expected]);
    }
  });

  it("withoutStale: a tag whose principal is gone loses its @ and its mention; the others move with it", () => {
    const state = { text: "@阿波 和 @小安", tags: [{ id: BO, start: 0, length: 3 }, { id: ANN, start: 6, length: 3 }], removals: [] };
    const after = withoutStale(state, (id) => id === ANN);
    expect([after.text, after.tags, after.stale]).toEqual(["阿波 和 @小安", [{ id: ANN, start: 5, length: 3 }], ["@阿波"]]);
    expect(withoutStale(state, () => true)).toBe(state);
  });

  it("the composer and the send keep to one set of cleaning rules (validation.js messageText)", () => {
    for (const text of ["  \u202E嗨 @阿波\u0007 ", "a\u0000b\u0085c", "\u2066x\u2069 @y\t\n", "\uD800 lone", "ok"]) {
      expect(cleanWithMentions(text).text).toBe(messageText(text.toWellFormed()));
    }
  });

  it("cleanWithMentions maps the tags onto the text as sent: trimmed, controls and bidi overrides removed, lone surrogates replaced", () => {
    expect(cleanWithMentions("  \u202E嗨 @阿波\u0007 ", [{ id: BO, start: 5, length: 3 }])).toEqual({ text: "嗨 @阿波", mentions: [{ id: BO, start: 2, length: 3 }] });
    expect(cleanWithMentions("\uD800 @阿波", [{ id: BO, start: 2, length: 3 }])).toEqual({ text: "\uFFFD @阿波", mentions: [{ id: BO, start: 2, length: 3 }] });
    expect(cleanWithMentions("@阿波", [{ id: BO, start: 1, length: 2 }])).toEqual({ text: "@阿波", mentions: [] });
  });
});
