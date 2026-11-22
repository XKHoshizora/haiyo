// @vitest-environment jsdom
// Every modal surface is one primitive (src/ui/layers.js): while it is open the page behind is inert, the focus goes in and
// stays in, Esc closes it (only the top one; never an Esc a control inside spent, nor one that cancels an input method's
// candidate), the focus goes back to its opener, and Back closes it WITHOUT moving the page under it — it owns one history
// entry at the same address (state/appHistory.js), so a navigation still carries its own intent. On jsdom's own history.
import React, { useState } from "react";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { addressOf, navOfAddress } from "../src/state/location.js";
import { useAppHistory } from "../src/state/appHistory.js";
import { Modal } from "../src/ui/primitives.jsx";
import { Select } from "../src/ui/Select.jsx";

const C1 = "00000000-0000-4000-8000-0000000000c1";
const C2 = "00000000-0000-4000-8000-0000000000c2";
const BASE = { section: "chat", pane: "list", convId: null, view: "chat", contactId: null, agentId: null, agentView: "detail", settingsPage: "profile", providerId: null, detailsOpen: false, agentTab: "profile", profileTab: "members", opening: null };
const chatOf = (id) => ({ section: "chat", pane: "main", convId: id, view: "chat" });

let drive;
/**
 * The page at the browser's address with the app's history on it, a button that opens a dialog, and what the dialog does: `locked` (it may not
 * be left: a save under way), `inner` (more inside it), `onDone(drive, close)` for its 完成 button (a navigation from inside).
 */
function Page({ locked = false, inner = null, onDone = null, second = false }) {
  // (Drawn from the address the test put the browser at, as a cold start is.)
  const [nav, setNav] = useState(() => ({ ...BASE, ...navOfAddress({ path: window.location.pathname }) }));
  const dispatch = (action) => {
    const navIntent = action.intent === "none" ? "none" : action.replace === true ? "replace" : "push";
    if (action.patch) setNav((n) => ({ ...n, ...action.patch, navIntent }));
  };
  const [open, setOpen] = useState(false);
  const [top, setTop] = useState(false);
  drive = { dispatch, open: setOpen };
  useAppHistory({ nav, dispatch });
  const close = () => setOpen(false);
  return (
    <main>
      <output data-path={addressOf(nav).path} />
      <button type="button" onClick={() => setOpen(true)}>打开</button>
      <button type="button">页面上的按钮</button>
      {open && (
        <Modal title="测试对话框" onClose={close} locked={locked} footer={<button type="button" onClick={() => (onDone ? onDone(drive, close) : close())}>完成</button>}>
          <input aria-label="名称" data-autofocus />
          {inner}
          {second && <button type="button" onClick={() => setTop(true)}>再打开一个</button>}
          {top && (
            <Modal title="上面的对话框" onClose={() => setTop(false)}>
              <button type="button">里面</button>
            </Modal>
          )}
        </Modal>
      )}
    </main>
  );
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
const back = async () => {
  act(() => window.history.back());
  await settle();
};
const drawnPath = () => document.querySelector("output").dataset.path;
const dialogs = () => screen.queryAllByRole("dialog");
const page = () => document.querySelector("main").closest("body > *");
const openIt = async () => {
  const opener = screen.getByRole("button", { name: "打开" });
  opener.focus();
  fireEvent.click(opener);
  await settle();
  return opener;
};

beforeEach(() => {
  window.history.replaceState(null, "", `/chat/${C1}`);
  // (jsdom lays nothing out: every element is drawn here, as the app's tests have it — the focus goes back only to what is shown.)
  vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([{ top: 0 }]);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete window.matchMedia;
});

describe("the primitive", () => {
  it("the page behind is inert while it is open, the focus goes in, Tab goes round inside it; Esc closes it, the focus goes back, nothing stays inert", async () => {
    render(<Page />);
    await settle();
    const opener = await openIt();
    const box = screen.getByRole("dialog", { name: "测试对话框" });
    expect(box.getAttribute("aria-modal")).toBe("true");
    expect(page().hasAttribute("inert")).toBe(true);
    expect(box.closest("[inert]")).toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText("名称"));
    const stops = [...box.querySelectorAll("button, input")];
    stops.at(-1).focus();
    fireEvent.keyDown(stops.at(-1), { key: "Tab" });
    expect(document.activeElement).toBe(stops[0]);
    fireEvent.keyDown(stops[0], { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(stops.at(-1));
    fireEvent.keyDown(document.activeElement, { key: "Escape" });
    await settle();
    expect(dialogs()).toEqual([]);
    expect(document.activeElement).toBe(opener);
    expect(document.querySelectorAll("[inert]").length).toBe(0);
  });

  it("Back closes the dialog only: the page and its address stay, and the stack is the page's again", async () => {
    render(<Page />);
    await settle();
    const before = window.history.state;
    await openIt();
    // One entry pushed for it, at the same address, over the page's.
    expect(window.history.state).toMatchObject({ index: before.index + 1, prev: `/chat/${C1}#`, path: `/chat/${C1}`, layers: [expect.any(String)] });
    expect(window.location.pathname).toBe(`/chat/${C1}`);
    await back();
    expect(dialogs()).toEqual([]);
    expect(window.location.pathname).toBe(`/chat/${C1}`);
    expect(drawnPath()).toBe(`/chat/${C1}`);
    expect(window.history.state).toEqual(before);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "打开" }));
  });

  it("closed by its own button (or Esc, or the backdrop), its entry goes too: the next Back is the page before, never a dead press", async () => {
    render(<Page />);
    await settle();
    act(() => drive.dispatch({ type: "nav", patch: chatOf(C2) }));
    await settle();
    for (const close of [
      () => fireEvent.click(screen.getByRole("button", { name: "完成" })),
      () => fireEvent.keyDown(screen.getByLabelText("名称"), { key: "Escape" }),
      () => fireEvent.mouseDown(document.querySelector(".modal-backdrop")),
    ]) {
      await openIt();
      act(close);
      await settle();
      expect(dialogs()).toEqual([]);
      expect(window.location.pathname).toBe(`/chat/${C2}`);
      expect(window.history.state.layers ?? []).toEqual([]);
    }
    await back();
    expect(drawnPath()).toBe(`/chat/${C1}`);
  });

  it("a navigation from inside the dialog carries its own intent: a push lands over the page under the dialog, a replace replaces that page", async () => {
    render(<Page onDone={(d, close) => (d.dispatch({ type: "nav", patch: chatOf(C2) }), close())} />);
    await settle();
    await openIt();
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    await settle();
    expect(window.location.pathname).toBe(`/chat/${C2}`);
    expect(drawnPath()).toBe(`/chat/${C2}`);
    await back();
    expect(drawnPath()).toBe(`/chat/${C1}`);
    cleanup();

    window.history.replaceState(null, "", "/");
    render(<Page onDone={(d, close) => (close(), d.dispatch({ type: "nav", replace: true, patch: { convId: null, pane: "list" } }))} />);
    await settle();
    act(() => drive.dispatch({ type: "nav", patch: chatOf(C1) }));
    await settle();
    const length = window.history.length;
    await openIt();
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    await settle();
    expect(window.location.pathname).toBe("/");
    // The conversation's entry became the list: the dialog's entry left nothing behind it to come back to.
    expect(window.history.state.index).toBe(1);
    expect(window.history.length).toBeLessThanOrEqual(length + 1);
  });

  it("a dialog over a dialog: Esc and Back each close the top one only", async () => {
    render(<Page second />);
    await settle();
    await openIt();
    fireEvent.click(screen.getByRole("button", { name: "再打开一个" }));
    await settle();
    expect(dialogs().length).toBe(2);
    const lower = screen.getByRole("dialog", { name: "测试对话框" });
    expect(lower.closest("[inert]")).toBe(lower.closest("body > *"));
    fireEvent.keyDown(screen.getByRole("button", { name: "里面" }), { key: "Escape" });
    await settle();
    expect(dialogs().map((d) => d.getAttribute("aria-labelledby") && d.querySelector("h2").textContent)).toEqual(["测试对话框"]);
    expect(lower.closest("[inert]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "再打开一个" }));
    await settle();
    await back();
    expect(dialogs().map((d) => d.querySelector("h2").textContent)).toEqual(["测试对话框"]);
    await back();
    expect(dialogs()).toEqual([]);
    expect(drawnPath()).toBe(`/chat/${C1}`);
  });

  it("while it may not be left (a save under way) Esc and Back leave it open, and Back still closes it afterwards", async () => {
    const { rerender } = render(<Page locked />);
    await settle();
    await openIt();
    const own = window.history.state;
    fireEvent.keyDown(screen.getByLabelText("名称"), { key: "Escape" });
    // Back while it may not be left: the browser is taken forward onto the dialog's own entry again — no new entry is added (one
    // added without a gesture may be skipped by a later Back in Chrome: the audit's original bug).
    const pushed = vi.spyOn(window.history, "pushState");
    await back();
    // (Two steps of the browser's, Back and the step forward: on a busy machine the second may come after the first wait.)
    await waitFor(() => expect(window.history.state).toEqual(own));
    expect(pushed).not.toHaveBeenCalled();
    pushed.mockRestore();
    expect(dialogs().length).toBe(1);
    expect(window.location.pathname).toBe(`/chat/${C1}`);
    rerender(<Page locked={false} />);
    await back();
    expect(dialogs()).toEqual([]);
    expect(drawnPath()).toBe(`/chat/${C1}`);
  });

  it("an Esc a control inside spends is not the dialog's: a list closes first; a search box with words is emptied first", async () => {
    function Searching() {
      const [q, setQ] = useState("");
      return <input type="search" aria-label="搜索好友" value={q} onChange={(e) => setQ(e.target.value)} />;
    }
    render(<Page inner={<><Select aria-label="分类" value="a" options={[{ value: "a", label: "甲" }, { value: "b", label: "乙" }]} onChange={() => {}} /><Searching /></>} />);
    await settle();
    await openIt();
    const trigger = screen.getByRole("combobox", { name: "分类" });
    fireEvent.click(trigger);
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(dialogs().length).toBe(1);
    const search = screen.getByLabelText("搜索好友");
    fireEvent.change(search, { target: { value: "小安" } });
    fireEvent.keyDown(search, { key: "Escape" });
    expect(search.value).toBe("");
    expect(dialogs().length).toBe(1);
    fireEvent.keyDown(search, { key: "Escape" });
    await settle();
    expect(dialogs()).toEqual([]);
  });

  it("a dialog that opens together with a navigation is on the new page, and Back closes it there", async () => {
    function Along() {
      const [nav, setNav] = useState({ ...BASE, ...navOfAddress({ path: window.location.pathname }) });
      const dispatch = (action) => action.patch && setNav((n) => ({ ...n, ...action.patch, navIntent: "push" }));
      useAppHistory({ nav, dispatch });
      return (
        <main>
          <output data-path={addressOf(nav).path} />
          <button type="button" onClick={() => dispatch({ type: "nav", patch: { section: "contacts", pane: "list", addFriend: true } })}>添加好友</button>
          {nav.section === "contacts" && nav.addFriend && <Modal title="添加好友" onClose={() => setNav((n) => ({ ...n, addFriend: false, navIntent: "push" }))}>x</Modal>}
        </main>
      );
    }
    render(<Along />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "添加好友" }));
    await settle();
    expect(dialogs().length).toBe(1);
    expect(window.location.pathname).toBe("/contacts");
    await back();
    expect(dialogs()).toEqual([]);
    expect(drawnPath()).toBe("/contacts");
  });
});

// A layer's entry is never left without its layer (fix round 1, I3): wherever the app finds itself on an entry marked with layers
// none of which is open — Forward onto a closed dialog, a reload or a restored tab with a dialog open — it steps back to the page's
// own entry at once, quietly, without opening the dialog again. Back never does nothing; Forward onto a closed dialog stays on the page.
describe("an entry of a layer that is not open", () => {
  const forward = async () => {
    act(() => window.history.forward());
    await settle();
  };
  /** At /chat/C2 pushed over /chat/C1. */
  const atSecond = async (props = {}) => {
    const view = render(<Page {...props} />);
    await settle();
    act(() => drive.dispatch({ type: "nav", patch: chatOf(C2) }));
    await settle();
    return view;
  };

  it("Forward onto a dialog that was closed stays on the page, and the next Back is the page before", async () => {
    await atSecond();
    const page = window.history.state;
    await openIt();
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    await settle();
    expect(window.history.state).toEqual(page);
    await forward();
    expect(dialogs()).toEqual([]);
    expect(drawnPath()).toBe(`/chat/${C2}`);
    expect(window.history.state).toEqual(page);
    await back();
    expect(drawnPath()).toBe(`/chat/${C1}`);
  });

  it("a reload (or a restored tab) on a dialog's entry steps back to the page's own entry without opening it; one Back is the page before", async () => {
    const view = await atSecond();
    const page = window.history.state;
    await openIt();
    expect(window.history.state.layers).toHaveLength(1);
    // The page goes away with its dialog open (a reload, a discarded tab): the entry it was on keeps its marker.
    view.unmount();
    await settle();
    expect(window.history.state.layers).toHaveLength(1);
    render(<Page />);
    await settle();
    expect(dialogs()).toEqual([]);
    expect(window.history.state).toEqual(page);
    expect(drawnPath()).toBe(`/chat/${C2}`);
    await back();
    expect(drawnPath()).toBe(`/chat/${C1}`);
  });

  it("an entry marked with a layer this page never had (restored from elsewhere) is left the same way", async () => {
    await atSecond();
    const page = window.history.state;
    cleanup();
    window.history.pushState({ ...page, index: page.index + 1, prev: `/chat/${C2}#`, layers: ["layer-from-before"] }, "", `/chat/${C2}`);
    render(<Page />);
    await settle();
    expect(window.history.state).toEqual(page);
    await back();
    expect(drawnPath()).toBe(`/chat/${C1}`);
  });

  it("a picker's sheet inside a dialog: each Back closes one, the sheet first", async () => {
    window.matchMedia = (query) => ({ matches: query === "(max-width: 480px)", media: query, addEventListener() {}, removeEventListener() {} });
    await atSecond({ inner: <Select aria-label="分类" value="a" options={[{ value: "a", label: "甲" }, { value: "b", label: "乙" }]} onChange={() => {}} /> });
    await openIt();
    fireEvent.click(screen.getByRole("combobox", { name: "分类" }));
    await settle();
    expect(screen.getByRole("listbox")).toBeTruthy();
    expect(window.history.state.layers).toHaveLength(2);
    await back();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(dialogs().length).toBe(1);
    await back();
    expect(dialogs()).toEqual([]);
    expect(drawnPath()).toBe(`/chat/${C2}`);
    await back();
    expect(drawnPath()).toBe(`/chat/${C1}`);
  });

  it("the tab's first entry replaced from a dialog (a deep link, then 退出群聊): the address and the screen agree, and that entry is the page's own", async () => {
    // (The app's first entry: a cold start on /chat/C1, index 0, nothing of the app below it.)
    render(<Page onDone={(d, close) => (close(), d.dispatch({ type: "nav", replace: true, patch: { convId: null, pane: "list" } }))} />);
    await settle();
    expect(window.history.state).toMatchObject({ index: 0, path: `/chat/${C1}` });
    await openIt();
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    await settle();
    expect(window.location.pathname).toBe("/");
    expect(drawnPath()).toBe("/");
    // The first entry itself became the list: nothing superseded is left below to step over (there is nothing below).
    expect(window.history.state).toMatchObject({ index: 0, path: "/", layers: [] });
    expect(window.history.state.supersedes).toBeUndefined();
  });

  it("a jump onto a page that a dialog's replace superseded (not over it step by step) is stepped over, never drawn", async () => {
    await atSecond({ onDone: (d, close) => (close(), d.dispatch({ type: "nav", replace: true, patch: { convId: null, pane: "list" } })) });
    await openIt();
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    await settle();
    expect(drawnPath()).toBe("/");
    act(() => drive.dispatch({ type: "nav", patch: chatOf(C2) }));
    await settle();
    // Two entries back in one go: past the list onto the superseded /chat/C2 — it is stepped over to /chat/C1.
    const drawn = [];
    const watch = new MutationObserver(() => drawn.push(drawnPath()));
    watch.observe(document.querySelector("output"), { attributes: true });
    act(() => window.history.go(-2));
    await settle();
    await settle();
    watch.disconnect();
    expect(drawnPath()).toBe(`/chat/${C1}`);
    expect(drawn).not.toContain(`/chat/${C2}`);
  });

  it("a navigation from inside a dialog is written in place of the dialog's entry: the app takes no history step of its own to race a Back", async () => {
    render(<Page onDone={(d, close) => (d.dispatch({ type: "nav", patch: chatOf(C2) }), close())} />);
    await settle();
    await openIt();
    const steps = ["back", "forward", "go"].map((name) => vi.spyOn(window.history, name));
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    await settle();
    for (const step of steps) expect(step).not.toHaveBeenCalled();
    expect(window.history.state).toMatchObject({ path: `/chat/${C2}`, prev: `/chat/${C1}#`, layers: [] });
    for (const step of steps) step.mockRestore();
    await back();
    expect(drawnPath()).toBe(`/chat/${C1}`);
  });
});

describe("the other modal surfaces are the same primitive", () => {
  const SRC = path.join(import.meta.dirname, "..", "src");
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const sources = walk(SRC).filter((f) => /\.jsx?$/.test(f));

  it("aria-modal is drawn by two files only, and both take the layer (no hand-made trap, Esc or inert anywhere else)", () => {
    const modal = sources.filter((f) => /aria-modal/.test(readFileSync(f, "utf8"))).map((f) => path.relative(SRC, f));
    expect(modal.sort()).toEqual([path.join("ui", "ImageViewer.jsx"), path.join("ui", "primitives.jsx")].sort());
    for (const file of modal) expect(readFileSync(path.join(SRC, file), "utf8"), file).toMatch(/useLayer\(/);
    const inert = sources.filter((f) => /setAttribute\("inert"|\.inert\s*=/.test(readFileSync(f, "utf8"))).map((f) => path.relative(SRC, f));
    expect(inert).toEqual([path.join("ui", "layers.js")]);
    expect(sources.some((f) => /dialogFocus/.test(readFileSync(f, "utf8")))).toBe(false);
  });

  it("a picker's sheet on a phone is a modal layer: the page inert, the focus on its list, Back closes the sheet only, and the focus goes back to its button", async () => {
    window.matchMedia = (query) => ({ matches: query === "(max-width: 480px)", media: query, addEventListener() {}, removeEventListener() {} });
    function Picker() {
      const [nav, setNav] = useState({ ...BASE, ...navOfAddress({ path: window.location.pathname }) });
      useAppHistory({ nav, dispatch: (a) => a.patch && setNav((n) => ({ ...n, ...a.patch })) });
      return (
        <main>
          <output data-path={addressOf(nav).path} />
          <Select aria-label="作息" value="a" options={[{ value: "a", label: "早睡" }, { value: "b", label: "晚睡" }]} onChange={() => {}} />
        </main>
      );
    }
    render(<Picker />);
    await settle();
    const trigger = screen.getByRole("combobox", { name: "作息" });
    trigger.focus();
    fireEvent.click(trigger);
    await settle();
    const list = screen.getByRole("listbox");
    expect(page().hasAttribute("inert")).toBe(true);
    expect(list.closest("[inert]")).toBeNull();
    expect(document.activeElement).toBe(list);
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(list.getAttribute("aria-activedescendant")).toBe(list.querySelectorAll('[role="option"]')[1].id);
    await back();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(drawnPath()).toBe(`/chat/${C1}`);
    expect(document.activeElement).toBe(trigger);
    expect(document.querySelectorAll("[inert]").length).toBe(0);
  });
});
