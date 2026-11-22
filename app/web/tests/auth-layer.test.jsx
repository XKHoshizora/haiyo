// @vitest-environment jsdom
// The sign-in layer over exactly what is visible: AuthPage follows window.visualViewport by writing the layer's style directly (no React state per
// event), for the keyboard (a visual viewport shorter than the window, panned by the browser) and for a pinch-zoomed page; every screen that uses
// `.auth-page` (the cards, Loading, the crash fallback) has the same layer.
import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthPage } from "../src/ui/AuthPage.jsx";
import { ChunkBoundary } from "../src/ui/ChunkBoundary.jsx";
import { Loading } from "../src/auth/screens.jsx";
import { layerStyleFor } from "../src/ui/visualViewport.js";

let vv;
const listeners = {};
beforeEach(() => {
  for (const key of Object.keys(listeners)) delete listeners[key];
  vv = {
    scale: 1,
    offsetLeft: 0,
    offsetTop: 0,
    width: 402,
    height: 874,
    addEventListener: (type, fn) => (listeners[type] ??= new Set()).add(fn),
    removeEventListener: (type, fn) => listeners[type]?.delete(fn),
  };
  Object.defineProperty(window, "visualViewport", { configurable: true, value: vv });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 874 });
});
afterEach(() => {
  cleanup();
  delete window.visualViewport;
});
const fire = (type) => act(() => listeners[type]?.forEach((fn) => fn()));
const layer = () => document.querySelector(".auth-page");

describe("layerStyleFor", () => {
  it("is nothing when the visible part is the whole window (the stylesheet's inset 0)", () => {
    expect(layerStyleFor(vv, 874)).toBeNull();
  });
  it("the keyboard: as high as what is left, where the visible part starts", () => {
    expect(layerStyleFor({ ...vv, height: 420 }, 874)).toMatchObject({ position: "fixed", top: 0, height: 420 });
    expect(layerStyleFor({ ...vv, height: 420, offsetTop: 120 }, 874)).toMatchObject({ top: 120, height: 420 });
  });
  it("a pinch-zoomed page: the zoom-aware box (shrunk back by the scale), never the keyboard's frame", () => {
    const zoomed = layerStyleFor({ ...vv, scale: 2, offsetLeft: 100, offsetTop: 200, width: 201, height: 437 }, 874);
    expect(zoomed).toMatchObject({ left: 100, top: 200, transform: "scale(0.5)" });
  });
});

describe("AuthPage on a faked visualViewport", () => {
  it("with the keyboard up its box is the visible part; resize and scroll events move it, and it returns to the full window when the keyboard goes", () => {
    let renders = 0;
    const Counted = () => {
      renders += 1;
      return <p>内容</p>;
    };
    render(
      <AuthPage>
        <Counted />
      </AuthPage>,
    );
    expect(layer().style.height).toBe("");
    const before = renders;
    vv.height = 420;
    fire("resize");
    expect(layer().style.position).toBe("fixed");
    expect(layer().style.height).toBe("420px");
    expect(layer().style.top).toBe("0px");
    expect(layer().hasAttribute("data-frame")).toBe(true);
    vv.offsetTop = 120;
    fire("scroll");
    expect(layer().style.top).toBe("120px");
    vv.height = 874;
    vv.offsetTop = 0;
    fire("resize");
    expect(layer().style.height).toBe("");
    expect(layer().style.top).toBe("");
    expect(layer().hasAttribute("data-frame")).toBe(false);
    // The events wrote the style directly: the page below was not rendered again for any of them.
    expect(renders).toBe(before);
  });

  it("a rotation (window resize, orientationchange) recomputes it: a stale frame cannot survive it", () => {
    render(<AuthPage>x</AuthPage>);
    vv.height = 300;
    fire("resize");
    expect(layer().style.height).toBe("300px");
    // Rotated: the window's own size changes and the visual viewport is the whole window again — its events may not come before the window's.
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 402 });
    Object.assign(vv, { width: 874, height: 402 });
    act(() => void window.dispatchEvent(new Event("orientationchange")));
    expect(layer().style.height).toBe("");
    expect(layer().hasAttribute("data-frame")).toBe(false);
    vv.height = 200;
    act(() => void window.dispatchEvent(new Event("resize")));
    expect(layer().style.height).toBe("200px");
  });

  it("a pinch-zoomed page gets the zoom-aware box; the listeners go with the page", () => {
    render(<AuthPage>x</AuthPage>);
    Object.assign(vv, { scale: 2, offsetLeft: 100, offsetTop: 200, width: 201, height: 437 });
    fire("resize");
    expect(layer().style.transform).toBe("scale(0.5)");
    expect(layer().style.left).toBe("100px");
    cleanup();
    expect(listeners.resize?.size ?? 0).toBe(0);
    expect(listeners.scroll?.size ?? 0).toBe(0);
    const removed = vi.spyOn(window, "removeEventListener");
    render(<AuthPage>y</AuthPage>);
    cleanup();
    expect(removed.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining(["resize", "orientationchange"]));
  });
});

describe("every screen on the layer", () => {
  it("the loading line and the crash fallback are on the same layer, each a single centred child (the stylesheet centres whatever single child it has)", () => {
    render(<Loading />);
    expect(layer().tagName).toBe("MAIN");
    expect(layer().children).toHaveLength(1);
    cleanup();
    const Boom = () => {
      throw new Error("boom");
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ChunkBoundary reload={() => {}}>
        <Boom />
      </ChunkBoundary>,
    );
    expect(layer().children).toHaveLength(1);
    expect(layer().firstElementChild.classList.contains("auth-stack")).toBe(true);
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: "刷新页面" })).toBeTruthy();
    expect(layer().firstElementChild.contains(screen.getByRole("button", { name: "刷新页面" }))).toBe(true);
  });
});
