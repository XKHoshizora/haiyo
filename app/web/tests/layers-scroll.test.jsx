// @vitest-environment jsdom
// While a modal layer is open the page behind it does not scroll. Root, by structure (src/ui/layers.js, styles.css): the document is locked and every
// scroller behind the layer is `overflow: hidden` on a touch screen (the CSS test below); there is NO touchmove or wheel handler, so nothing is
// judged or prevented — text fields, sliders, pinch, the edge-swipe Back and selection behave natively. What jsdom cannot show (iOS latching a touch onto a
// scroller under an overlay) is on the owner's phone checklist; the e2e shows what Chromium can.
import React, { useState } from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Modal } from "../src/ui/primitives.jsx";
import { parseCss } from "./css-rules.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Page({ second = false }) {
  const [open, setOpen] = useState(true);
  const [inner, setInner] = useState(false);
  return (
    <main>
      <div data-testid="page-scroller">
        <button type="button">页面上的按钮</button>
      </div>
      {open && (
        <Modal title="测试" onClose={() => setOpen(false)} footer={<button type="button">完成</button>}>
          <input type="text" aria-label="名称" />
          <input type="range" aria-label="缩放" />
          {second && <button type="button" onClick={() => setInner(true)}>再开一个</button>}
          {inner && (
            <Modal title="上面的" onClose={() => setInner(false)}>
              <div data-testid="upper">里面</div>
            </Modal>
          )}
        </Modal>
      )}
    </main>
  );
}

const locked = () => document.documentElement.hasAttribute("data-layer-open");

describe("the document lock", () => {
  it("is on while a layer is open and off after", () => {
    render(<Page />);
    expect(locked()).toBe(true);
    cleanup();
    expect(locked()).toBe(false);
  });

  it("two layers: the lock stays until the last one closes", () => {
    render(<Page second />);
    fireEvent.click(screen.getByRole("button", { name: "再开一个" }));
    expect(locked()).toBe(true);
    fireEvent.click(screen.getAllByRole("button", { name: "关闭" }).at(-1));
    expect(locked()).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(locked()).toBe(false);
  });

  it("an error while rendering leaves no lock", () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    class Boundary extends React.Component {
      state = { failed: false };
      static getDerivedStateFromError() {
        return { failed: true };
      }
      render() {
        return this.state.failed ? <p>出错了</p> : this.props.children;
      }
    }
    function Breaks() {
      const [broken, setBroken] = useState(false);
      if (broken) throw new Error("render failed");
      return (
        <Modal title="测试" onClose={() => {}}>
          <button type="button" onClick={() => setBroken(true)}>坏掉</button>
        </Modal>
      );
    }
    render(
      <Boundary>
        <Breaks />
      </Boundary>,
    );
    expect(locked()).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "坏掉" }));
    expect(screen.getByText("出错了")).toBeTruthy();
    expect(locked()).toBe(false);
    quiet.mockRestore();
  });

  it("puts the document's scroll position back exactly, on the page it was taken on", () => {
    const to = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    Object.defineProperty(window, "scrollY", { configurable: true, value: 120 });
    Object.defineProperty(window, "scrollX", { configurable: true, value: 0 });
    const view = render(<Page />);
    Object.defineProperty(window, "scrollY", { configurable: true, value: 0 }); // (something moved it while the layer was open)
    view.unmount();
    expect(to).toHaveBeenLastCalledWith(0, 120);
    Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
  });
});

describe("no gesture is judged or prevented", () => {
  it("a touch move or a wheel anywhere, on a text field, a slider, the footer, the backdrop and the page behind, is never prevented", () => {
    render(<Page />);
    const targets = [screen.getByLabelText("名称"), screen.getByLabelText("缩放"), screen.getByRole("button", { name: "完成" }), screen.getByRole("dialog"), screen.getByTestId("page-scroller")];
    for (const target of targets) {
      fireEvent.touchStart(target, { touches: [{ clientX: 50, clientY: 200 }] });
      expect(fireEvent.touchMove(target, { touches: [{ clientX: 52, clientY: 150 }] })).toBe(true);
      expect(fireEvent.wheel(target, { deltaY: 80 })).toBe(true);
    }
    fireEvent.touchStart(targets[0], { touches: [{ clientX: 10, clientY: 10 }, { clientX: 90, clientY: 90 }] });
    expect(fireEvent.touchMove(targets[0], { touches: [{ clientX: 5, clientY: 5 }, { clientX: 95, clientY: 95 }] })).toBe(true);
  });

  it("layers.js has no touch or wheel listener and never calls preventDefault on one", () => {
    const code = readFileSync(path.join(import.meta.dirname, "..", "src", "ui", "layers.js"), "utf8").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/touchmove|touchstart|wheel/);
  });
});

describe("the scrollers behind a layer (styles.css)", () => {
  const root = path.join(import.meta.dirname, "..", "src");
  const FILES = ["styles.css", "styles/social.css", "styles/others.css"];
  const sheets = FILES.map((file) => readFileSync(path.join(root, file), "utf8"));
  const rules = sheets.flatMap((css) => parseCss(css));
  const locks = rules.filter((r) => r.selectors.some((s) => s.startsWith("body > [inert] :is(")));

  it("the rules in the stylesheets: on a coarse hover-less pointer and on any WebKit on iOS or iPadOS, keyed on what the layers make inert, they hide overflow", () => {
    expect(locks.map((r) => r.conditions.join()).sort()).toEqual(["(-webkit-touch-callout: none)", "(hover: none) and (pointer: coarse)"]);
    for (const lock of locks) expect(lock.decl.overflow).toBe("hidden");
  });

  it("they name every box of the stylesheets that scrolls (a rule that gives a selector overflow auto or scroll is in the list), and textarea, which scrolls by default", () => {
    const scrollers = new Set(["textarea"]);
    for (const r of rules) {
      const values = [r.decl.overflow, r.decl["overflow-y"], r.decl["overflow-x"]].filter(Boolean).join(" ");
      if (/\b(auto|scroll)\b/.test(values)) for (const s of r.selectors) scrollers.add(s);
    }
    expect(scrollers.size).toBeGreaterThan(10);
    for (const lock of locks) {
      const named = new Set(/:is\(([^)]*)\)/.exec(lock.selectors[0])[1].split(",").map((s) => s.trim()));
      for (const s of scrollers) expect(named.has(s), `${lock.conditions}: ${s}`).toBe(true);
    }
  });

  it("the document lock does not reserve a scrollbar's room (the shell has no document scrollbar; a gutter would narrow the app while a dialog is open)", () => {
    const lockRule = rules.find((r) => r.selectors.includes("html[data-layer-open]"));
    expect(lockRule.decl.overflow).toBe("hidden");
    expect(lockRule.decl).not.toHaveProperty("scrollbar-gutter");
  });
});

describe("touch-action: the only gesture the browser starts inside a layer is scrolling the layer's own scroller (styles.css)", () => {
  const rules = ["styles.css", "styles/social.css", "styles/others.css"].flatMap((file) => parseCss(readFileSync(path.join(import.meta.dirname, "..", "src", file), "utf8")));
  const of = (selector) => rules.filter((r) => r.selectors.includes(selector) && r.decl["touch-action"]).map((r) => r.decl["touch-action"]).at(-1) ?? null;
  const viaList = (selector) => rules.filter((r) => r.selectors.includes(selector) && r.decl["touch-action"]).at(-1)?.decl["touch-action"] ?? null;

  it("the hosts and the parts that do not scroll (backdrop, dialog, its head and foot, the sheet, its search row, note, empty line and footer, the viewer) take no gesture", () => {
    for (const selector of [".modal-backdrop", ".modal", ".modal-head", ".modal-foot", ".model-scrim", ".model-pop", ".select-pop", ".model-search", ".model-scope", ".model-empty", ".model-foot", ".viewer"]) {
      expect(viaList(selector) ?? of(selector), selector).toBe("none");
    }
  });

  it("the layer's own scrollers take the vertical pan only (a slider or a horizontal drag inside is still delivered to the control)", () => {
    for (const selector of [".modal-body", ".model-list", ".select-list"]) expect(of(selector), selector).toBe("pan-y");
  });

  it("the image viewer's stage and the avatar stage keep their own gestures (pointer-driven pinch and drag), not the browser's", () => {
    expect(of(".viewer-stage")).toBe("none");
    expect(of(".avatar-stage") ?? "none").toBe("none");
  });
});
