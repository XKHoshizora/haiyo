// @vitest-environment jsdom
// While a modal layer is open the page behind it does not scroll, by touch or wheel (iOS ignores `inert` for scrolling, and a list with
// little or nothing to scroll hands its gesture on). One guard in the one primitive (src/ui/layers.js): a move that starts outside the
// top layer, or inside it where nothing can scroll the way it goes, is stopped; the document is locked and put back as it was.
import React, { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Modal } from "../src/ui/primitives.jsx";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** A box that scrolls: `over` px of overflow, at `top`. (jsdom has no layout.) */
function scrolls(el, { over, top = 0 }) {
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: 300 + over });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: 300 });
  el.scrollTop = top;
  el.style.overflowY = "auto";
}

function Page() {
  const [open, setOpen] = useState(true);
  const [inner, setInner] = useState(false);
  return (
    <main>
      <div data-testid="page-scroller" style={{ overflowY: "auto" }}>
        <button type="button">页面上的按钮</button>
      </div>
      {open && (
        <Modal title="测试" onClose={() => setOpen(false)} footer={<button type="button">完成</button>}>
          <div data-testid="list">行</div>
          <div data-testid="short">无处可滚</div>
          <input type="range" aria-label="缩放" />
          <input type="text" aria-label="名称" />
          <button type="button" onClick={() => setInner(true)}>再开一个</button>
          {inner && (
            <Modal title="上面的" onClose={() => setInner(false)}>
              <div data-testid="upper-list">行</div>
            </Modal>
          )}
        </Modal>
      )}
    </main>
  );
}

/** A drag by `dy` (a finger moving UP, dy < 0, scrolls the content down); true when the move was let through (not prevented). */
const letThrough = (el, dy) => {
  fireEvent.touchStart(el, { touches: [{ clientX: 50, clientY: 200 }] });
  return fireEvent.touchMove(el, { touches: [{ clientX: 50, clientY: 200 + dy }] });
};

describe("the page behind an open layer", () => {
  it("is locked at the document while the layer is open, and free again after", () => {
    render(<Page />);
    expect(document.documentElement.hasAttribute("data-layer-open")).toBe(true);
    cleanup();
    expect(document.documentElement.hasAttribute("data-layer-open")).toBe(false);
  });

  it("a drag that starts on the page behind is stopped", () => {
    render(<Page />);
    expect(letThrough(screen.getByTestId("page-scroller"), -80)).toBe(false);
    expect(letThrough(screen.getByRole("button", { name: "页面上的按钮", hidden: true }), 80)).toBe(false);
  });

  it("a drag on the layer's parts that scroll nothing (its footer, its backdrop, a short block) is stopped", () => {
    render(<Page />);
    expect(letThrough(screen.getByRole("button", { name: "完成" }), -80)).toBe(false);
    expect(letThrough(screen.getByRole("dialog"), -80)).toBe(false);
    expect(letThrough(screen.getByTestId("short"), 80)).toBe(false);
  });

  it("a drag on the layer's own scroller goes through while it can scroll that way, and is stopped at its ends, with 39px of overflow or with none", () => {
    render(<Page />);
    const list = screen.getByTestId("list");
    scrolls(list, { over: 100, top: 40 });
    expect(letThrough(list, -50)).toBe(true);
    expect(letThrough(list, 50)).toBe(true);
    scrolls(list, { over: 100, top: 100 });
    expect(letThrough(list, -50)).toBe(false);
    scrolls(list, { over: 100, top: 0 });
    expect(letThrough(list, 50)).toBe(false);
    scrolls(list, { over: 0, top: 0 });
    expect(letThrough(list, -50)).toBe(false);
  });

  it("the wheel is treated the same way", () => {
    render(<Page />);
    expect(fireEvent.wheel(screen.getByTestId("page-scroller"), { deltaY: 100 })).toBe(false);
    const list = screen.getByTestId("list");
    scrolls(list, { over: 100, top: 0 });
    expect(fireEvent.wheel(list, { deltaY: 60 })).toBe(true);
    expect(fireEvent.wheel(list, { deltaY: -60 })).toBe(false);
  });

  it("two layers: only the top one's scrollers take a drag; the one under it is part of the page", () => {
    render(<Page />);
    fireEvent.click(screen.getByRole("button", { name: "再开一个" }));
    const under = screen.getByTestId("list");
    scrolls(under, { over: 100, top: 40 });
    expect(letThrough(under, -50)).toBe(false);
    const upper = screen.getByTestId("upper-list");
    scrolls(upper, { over: 100, top: 40 });
    expect(letThrough(upper, -50)).toBe(true);
  });

  it("a two-finger move (a pinch) is left alone", () => {
    render(<Page />);
    const target = screen.getByTestId("page-scroller");
    fireEvent.touchStart(target, { touches: [{ clientX: 10, clientY: 10 }, { clientX: 90, clientY: 90 }] });
    expect(fireEvent.touchMove(target, { touches: [{ clientX: 5, clientY: 5 }, { clientX: 95, clientY: 95 }] })).toBe(true);
  });

  it("after the layer closes nothing is stopped any more, and the document is exactly where it was", () => {
    const to = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    Object.defineProperty(window, "scrollY", { configurable: true, value: 120 });
    Object.defineProperty(window, "scrollX", { configurable: true, value: 0 });
    const view = render(<Page />);
    Object.defineProperty(window, "scrollY", { configurable: true, value: 0 }); // (something moved it while the layer was open)
    view.unmount();
    const scroller = document.createElement("div");
    document.body.append(scroller);
    expect(letThrough(scroller, -80)).toBe(true);
    expect(to).toHaveBeenLastCalledWith(0, 120);
    Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
  });

  // The decision is by what can follow the move, not by which axis is larger: on iOS a prevented first move ends the whole gesture, and a thumb starts slanted.
  for (const degrees of [10, 30, 45, 60, 80]) {
    it(`a drag slanted ${degrees} degrees from the vertical on a list that scrolls vertically goes through; on a part that scrolls nothing it is stopped`, () => {
      render(<Page />);
      const list = screen.getByTestId("list");
      scrolls(list, { over: 100, top: 40 });
      const dx = Math.round(50 * Math.tan((degrees * Math.PI) / 180));
      const slanted = (el) => {
        fireEvent.touchStart(el, { touches: [{ clientX: 50, clientY: 200 }] });
        return fireEvent.touchMove(el, { touches: [{ clientX: 50 + dx, clientY: 150 }] });
      };
      expect(slanted(list)).toBe(true);
      expect(slanted(screen.getByTestId("short"))).toBe(false);
    });
  }

  it("a drag that is sideways only, on a list that scrolls only vertically, is stopped (nothing can follow it)", () => {
    render(<Page />);
    const list = screen.getByTestId("list");
    scrolls(list, { over: 100, top: 40 });
    fireEvent.touchStart(list, { touches: [{ clientX: 50, clientY: 200 }] });
    expect(fireEvent.touchMove(list, { touches: [{ clientX: 100, clientY: 200 }] })).toBe(false);
  });

  it("a drag on a range input or in a text field is never stopped (the thumb and the text move by the browser's own handling)", () => {
    render(<Page />);
    expect(letThrough(screen.getByLabelText("缩放"), 0)).toBe(true);
    fireEvent.touchStart(screen.getByLabelText("缩放"), { touches: [{ clientX: 50, clientY: 200 }] });
    expect(fireEvent.touchMove(screen.getByLabelText("缩放"), { touches: [{ clientX: 120, clientY: 202 }] })).toBe(true);
    fireEvent.touchStart(screen.getByLabelText("名称"), { touches: [{ clientX: 50, clientY: 200 }] });
    expect(fireEvent.touchMove(screen.getByLabelText("名称"), { touches: [{ clientX: 90, clientY: 200 }] })).toBe(true);
  });

  it("two fingers inside the layer (a pinch in the viewer) are never stopped, and after one lifts the other is judged again", () => {
    render(<Page />);
    const short = screen.getByTestId("short");
    fireEvent.touchStart(short, { touches: [{ clientX: 10, clientY: 10 }, { clientX: 90, clientY: 90 }] });
    expect(fireEvent.touchMove(short, { touches: [{ clientX: 5, clientY: 5 }, { clientX: 95, clientY: 95 }] })).toBe(true);
    fireEvent.touchEnd(short, { touches: [{ clientX: 95, clientY: 95 }] });
    expect(fireEvent.touchMove(short, { touches: [{ clientX: 95, clientY: 60 }] })).toBe(false);
  });

  it("at the list's top edge dragging down and at its bottom edge dragging up is stopped, so the page behind never takes it", () => {
    render(<Page />);
    const list = screen.getByTestId("list");
    scrolls(list, { over: 100, top: 0 });
    expect(letThrough(list, 60)).toBe(false);
    scrolls(list, { over: 100, top: 100 });
    expect(letThrough(list, -60)).toBe(false);
    // ...and with the sideways part of a slanted drag the list still cannot follow either way.
    fireEvent.touchStart(list, { touches: [{ clientX: 50, clientY: 200 }] });
    expect(fireEvent.touchMove(list, { touches: [{ clientX: 70, clientY: 150 }] })).toBe(false);
  });

  it("shift+wheel on a box that scrolls only vertically is stopped (it means sideways)", () => {
    render(<Page />);
    const list = screen.getByTestId("list");
    scrolls(list, { over: 100, top: 40 });
    expect(fireEvent.wheel(list, { deltaY: 60, shiftKey: true })).toBe(false);
    expect(fireEvent.wheel(list, { deltaY: 60 })).toBe(true);
  });
});
