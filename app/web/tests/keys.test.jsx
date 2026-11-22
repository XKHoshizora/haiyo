// @vitest-environment jsdom
// Enter and Esc that an input method uses — Enter confirming a Pinyin or kana–kanji candidate, Esc cancelling one — belong to
// the input method, never to the app: ONE helper (src/ui/keys.js) answers for every handler, and the source is held to it.
// Composition is driven the way the browsers send it: keydown with isComposing while it is open (Chrome, Firefox), and
// keyCode 229 on the keydown that comes right after compositionend (Safari ends the composition first).
import React, { useState } from "react";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { composing, isEnter, isEscape } from "../src/ui/keys.js";
import { Modal } from "../src/ui/primitives.jsx";
import { ModelSelect } from "../src/pages/ModelSelect.jsx";
import { G1, MODELS, group, providerOf, syncOf } from "./fixtures.js";
import { click, flush, inMain, installBrowser, openApp } from "./harness.jsx";

const SRC = path.join(import.meta.dirname, "..", "src");
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
/** A native keydown as a browser makes it (keyCode is not in KeyboardEventInit: it is set on the event). */
const native = (init, keyCode) => {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  if (keyCode !== undefined) Object.defineProperty(event, "keyCode", { value: keyCode });
  return event;
};
/** The three keydowns of one Esc that cancels a candidate, then the Esc of the person (fireEvent sets keyCode itself). */
const IME_ESC = [
  { key: "Escape", isComposing: true, keyCode: 229 },
  { key: "Escape", keyCode: 229 },
];

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the one key helper", () => {
  it("a key of a composition (isComposing, or keyCode 229) is neither Enter nor Esc; any other is", () => {
    expect(isEnter(native({ key: "Enter" }))).toBe(true);
    expect(isEnter(native({ key: "Enter", isComposing: true }))).toBe(false);
    expect(isEnter(native({ key: "Enter" }, 229))).toBe(false);
    expect(isEscape(native({ key: "Escape" }))).toBe(true);
    expect(isEscape(native({ key: "Escape", isComposing: true }))).toBe(false);
    expect(isEscape(native({ key: "Escape" }, 229))).toBe(false);
    expect(isEscape(native({ key: "Enter" }))).toBe(false);
    // React's event answers from its native event.
    expect(composing({ key: "Enter", keyCode: 13, nativeEvent: native({ key: "Enter", isComposing: true }) })).toBe(true);
    expect(isEnter({ key: "Enter", keyCode: 13, nativeEvent: native({ key: "Enter" }) })).toBe(true);
  });

  it("no handler names Enter or Escape by itself: the key names are in src/ui/keys.js only", () => {
    const own = path.join(SRC, "ui", "keys.js");
    const offenders = walk(SRC)
      .filter((file) => /\.(jsx?|mjs)$/.test(file) && file !== own)
      .filter((file) => /["'`](Enter|Escape|Esc)["'`]/.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(SRC, file));
    expect(offenders).toEqual([]);
  });
});

describe("Esc of an input method in a dialog", () => {
  it("cancels the candidate only: the dialog stays open and what was typed stays; the person's own Esc then closes it", () => {
    const close = vi.fn();
    function Host() {
      const [text, setText] = useState("");
      return (
        <Modal title="发起群聊" onClose={close}>
          <input aria-label="群名称" value={text} onChange={(e) => setText(e.target.value)} />
        </Modal>
      );
    }
    render(<Host />);
    const box = screen.getByLabelText("群名称");
    fireEvent.compositionStart(box);
    fireEvent.change(box, { target: { value: "zhou" } });
    fireEvent.keyDown(box, IME_ESC[0]);
    fireEvent.compositionEnd(box);
    fireEvent.keyDown(box, IME_ESC[1]);
    expect(close).not.toHaveBeenCalled();
    expect(box.value).toBe("zhou");
    fireEvent.keyDown(box, { key: "Escape" });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("in the model picker's search: the list stays open while a candidate is cancelled", () => {
    render(<ModelSelect label="模型" lead={[{ key: "a", name: "甲" }, { key: "b", name: "乙" }]} onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "模型" }));
    const search = screen.getByRole("combobox", { name: "搜索模型" });
    fireEvent.compositionStart(search);
    for (const init of IME_ESC) fireEvent.keyDown(search, init);
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.keyDown(search, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

describe("Enter and Esc of an input method on the pages", () => {
  beforeEach(() => installBrowser());

  it("the provider form's 模型名称: Enter that confirms a candidate adds nothing; the person's Enter adds the name", async () => {
    const providers = [providerOf()];
    await openApp({
      sync: () => syncOf([]),
      api: { listProviders: vi.fn(async () => ({ providers: structuredClone(providers) })) },
      handlers: { models: () => MODELS },
    });
    fireEvent.click(within(screen.getByRole("navigation", { name: "主导航" })).getByRole("button", { name: /^设置/ }));
    await flush();
    await click(screen.getByText("模型供应商", { selector: ".list-col .row-name" }));
    await click(within(inMain().getByText("我的 OpenAI", { selector: ".member-body strong" }).closest("li")).getByRole("button", { name: "编辑" }));
    const box = inMain().getByLabelText("模型名称");
    const names = () => [...within(inMain().getByRole("list", { name: "模型列表" })).queryAllByRole("listitem")].map((li) => li.querySelector("strong").textContent);
    fireEvent.compositionStart(box);
    fireEvent.change(box, { target: { value: "通义" } });
    fireEvent.keyDown(box, { key: "Enter", isComposing: true, keyCode: 229 });
    fireEvent.compositionEnd(box);
    fireEvent.keyDown(box, { key: "Enter", keyCode: 229 });
    await flush();
    expect(names()).not.toContain("通义");
    expect(box.value).toBe("通义");
    fireEvent.keyDown(box, { key: "Enter" });
    await flush();
    expect(names()).toContain("通义");
  });

  it("the composer: Esc of a candidate keeps the @ list open; the in-chat search keeps its words", async () => {
    await openApp({ sync: () => syncOf([group(G1)]) });
    await click(screen.getByText("周末小组", { selector: ".list-col .row-name" }));
    const input = screen.getByLabelText("消息内容");
    fireEvent.change(input, { target: { value: "@", selectionStart: 1, selectionEnd: 1 } });
    expect(document.querySelector(".mention-picker")).toBeTruthy();
    fireEvent.compositionStart(input);
    for (const init of IME_ESC) fireEvent.keyDown(input, init);
    expect(document.querySelector(".mention-picker")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(document.querySelector(".mention-picker")).toBeNull();

    await click(screen.getByRole("button", { name: "搜索本会话" }));
    const search = screen.getByLabelText("在本会话中搜索");
    fireEvent.compositionStart(search);
    fireEvent.change(search, { target: { value: "zhoumo" } });
    for (const init of IME_ESC) fireEvent.keyDown(search, init);
    expect(screen.getByLabelText("在本会话中搜索").value).toBe("zhoumo");
    fireEvent.keyDown(search, { key: "Escape" });
    expect(screen.queryByLabelText("在本会话中搜索")).toBeNull();
  });
});
