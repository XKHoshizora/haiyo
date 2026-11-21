// @vitest-environment jsdom
// The 调整头像 dialog on its own: keyboard, wheel, slider, drag and pinch, the clamp, reset, cancel, the saved crop, focus.
// The picture is decoded by the stand-in of tests/avatar-fake.js; the arithmetic itself is tested in avatar-crop.test.js.
import React, { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { AvatarDialog } from "../src/pages/AvatarDialog.jsx";
import { MAX_ZOOM, STAGE, initialView } from "../src/ui/avatarCrop.js";
import { fake, resetFake } from "./avatar-fake.js";

beforeEach(() => resetFake());
afterEach(cleanup);

const flush = () => act(async () => {});
const file = () => new File(["x"], "me.png", { type: "image/png" });
const stage = () => screen.getByRole("group", { name: "头像取景框" });
const slider = () => screen.getByRole("slider", { name: "缩放" });
const button = (name) => screen.getByRole("button", { name });

async function open({ onSave = async () => "", onCancel = vi.fn() } = {}) {
  const view = render(<AvatarDialog file={file()} onCancel={onCancel} onSave={onSave} />);
  await flush();
  return { ...view, onCancel, image: fake.images[0] };
}
/** The view the dialog would save now: what `crop` is asked to cut. */
async function viewNow() {
  const image = fake.images[0];
  image.crop.mockClear();
  await act(async () => fireEvent.click(button("保存")));
  return image.crop.mock.calls[0][0];
}
const press = (key, extra = {}) => fireEvent.keyDown(stage(), { key, ...extra });

describe("opening", () => {
  it("is a labelled dialog with one line of help, a circular frame, a labelled slider, and the stage has the focus", async () => {
    await open();
    const dlg = screen.getByRole("dialog", { name: "调整头像" });
    expect(within(dlg).getByText("拖动调整位置，滑块或滚轮缩放。")).toBeTruthy();
    expect(stage().getAttribute("aria-describedby")).toBe(within(dlg).getByText("拖动调整位置，滑块或滚轮缩放。").id);
    expect(dlg.querySelector(".avatar-frame")).toBeTruthy();
    expect(slider().getAttribute("aria-valuetext")).toBe("100%");
    expect(document.activeElement).toBe(stage());
    expect(fake.images[0].paint).toHaveBeenCalledTimes(1);
    for (const name of ["重置", "取消", "保存", "缩小", "放大"]) expect(button(name)).toBeTruthy();
  });

  it("starts centred with the short side filling the stage; the picture can be neither smaller nor moved off at first", async () => {
    fake.size = { width: 2000, height: 1000 };
    await open();
    expect(await viewNow()).toEqual(initialView(2000, 1000));
    expect(button("缩小").disabled).toBe(true);
  });

  it("a picture that cannot be decoded: the message, no stage and no 保存, and 知道了 closes", async () => {
    fake.fail = "图片的边不能超过 8000 像素。";
    const onSave = vi.fn();
    const { onCancel } = await open({ onSave });
    expect(screen.getByRole("alert").textContent).toBe("图片的边不能超过 8000 像素。");
    expect(screen.queryByRole("group", { name: "头像取景框" })).toBeNull();
    expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
    fireEvent.click(button("知道了"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe("keyboard alone", () => {
  it("the arrow keys move the picture (Shift: four times as far) and never past its edge", async () => {
    fake.size = { width: 2000, height: 1000 };
    await open();
    const step = 10 / (STAGE / 1000); // 10 stage units, in picture pixels
    expect((await viewNow()).cx).toBe(1000);
    press("ArrowRight"); // the picture follows the arrow: the view looks further left
    expect((await viewNow()).cx).toBeCloseTo(1000 - step, 6);
    press("ArrowLeft", { shiftKey: true });
    expect((await viewNow()).cx).toBeCloseTo(1000 - step + 4 * step, 6);
    for (let i = 0; i < 100; i++) press("ArrowLeft", { shiftKey: true });
    expect((await viewNow()).cx).toBe(1500); // the right edge of a 2000-wide picture under a 1000-wide view
    for (let i = 0; i < 100; i++) press("ArrowRight", { shiftKey: true });
    expect((await viewNow()).cx).toBe(500);
    press("ArrowUp");
    press("ArrowDown", { shiftKey: true });
    expect((await viewNow()).cy).toBe(500); // zoom 1: nothing to move vertically
  });

  it("+ and - zoom, within 100% and 500%; = and _ count as + and -", async () => {
    await open();
    press("+");
    const once = (await viewNow()).zoom;
    expect(once).toBeGreaterThan(1);
    expect(slider().getAttribute("aria-valuetext")).toBe(`${Math.round(once * 100)}%`);
    press("-");
    expect((await viewNow()).zoom).toBeCloseTo(1, 6);
    press("-");
    expect((await viewNow()).zoom).toBe(1);
    for (let i = 0; i < 40; i++) press("=");
    expect((await viewNow()).zoom).toBe(MAX_ZOOM);
    press("_");
    expect((await viewNow()).zoom).toBeLessThan(MAX_ZOOM);
  });

  it("zoomed in, every direction can be moved and the edges still hold", async () => {
    fake.size = { width: 1000, height: 1000 };
    await open();
    fireEvent.change(slider(), { target: { value: "3" } });
    for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
      for (let i = 0; i < 200; i++) press(key, { shiftKey: true });
      const v = await viewNow();
      const half = 1000 / (2 * v.zoom);
      expect(v.cx).toBeGreaterThanOrEqual(half - 1e-9);
      expect(v.cx).toBeLessThanOrEqual(1000 - half + 1e-9);
      expect(v.cy).toBeGreaterThanOrEqual(half - 1e-9);
      expect(v.cy).toBeLessThanOrEqual(1000 - half + 1e-9);
    }
  });
});

describe("slider, buttons and wheel", () => {
  it("the slider zooms and is bounded; − and + step it and are disabled at the ends", async () => {
    await open();
    expect(slider().min).toBe("1");
    expect(slider().max).toBe(String(MAX_ZOOM));
    fireEvent.change(slider(), { target: { value: "2.5" } });
    expect((await viewNow()).zoom).toBe(2.5);
    fireEvent.change(slider(), { target: { value: "99" } });
    expect((await viewNow()).zoom).toBe(MAX_ZOOM);
    expect(button("放大").disabled).toBe(true);
    fireEvent.click(button("缩小"));
    expect((await viewNow()).zoom).toBeLessThan(MAX_ZOOM);
    fireEvent.change(slider(), { target: { value: "0" } });
    expect((await viewNow()).zoom).toBe(1);
    expect(button("缩小").disabled).toBe(true);
    fireEvent.click(button("放大"));
    expect((await viewNow()).zoom).toBeGreaterThan(1);
  });

  it("the wheel zooms about the pointer and does not scroll the page; it stops at both limits", async () => {
    await open();
    const up = fireEvent.wheel(stage(), { deltaY: -120 });
    expect(up).toBe(false); // preventDefault was called
    expect((await viewNow()).zoom).toBeGreaterThan(1);
    for (let i = 0; i < 100; i++) fireEvent.wheel(stage(), { deltaY: -400 });
    expect((await viewNow()).zoom).toBe(MAX_ZOOM);
    for (let i = 0; i < 100; i++) fireEvent.wheel(stage(), { deltaY: 400 });
    expect((await viewNow()).zoom).toBe(1);
  });

  it("重置 puts the picture back as it started", async () => {
    fake.size = { width: 1600, height: 900 };
    await open();
    fireEvent.change(slider(), { target: { value: "3" } });
    press("ArrowLeft", { shiftKey: true });
    press("ArrowDown", { shiftKey: true });
    expect(await viewNow()).not.toEqual(initialView(1600, 900));
    fireEvent.click(button("重置"));
    expect(await viewNow()).toEqual(initialView(1600, 900));
  });
});

describe("pointers", () => {
  const pointer = (type, id, x, y) => {
    const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y });
    Object.defineProperty(event, "pointerId", { value: id });
    fireEvent(stage(), event);
  };
  beforeEach(() => {
    // jsdom has no layout: the stage is 280 px wide here, one pixel per stage unit.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: STAGE, height: STAGE, right: STAGE, bottom: STAGE, x: 0, y: 0 });
  });

  it("a drag moves the picture with the pointer and stops at the edge", async () => {
    fake.size = { width: 1000, height: 1000 };
    await open();
    fireEvent.change(slider(), { target: { value: "2" } });
    const before = await viewNow();
    pointer("pointerdown", 1, 100, 100);
    pointer("pointermove", 1, 130, 90);
    pointer("pointerup", 1, 130, 90);
    const after = await viewNow();
    const scale = (STAGE / 1000) * 2;
    expect(after.cx).toBeCloseTo(before.cx - 30 / scale, 6);
    expect(after.cy).toBeCloseTo(before.cy + 10 / scale, 6);
    pointer("pointerdown", 1, 0, 0);
    pointer("pointermove", 1, 9000, 9000);
    pointer("pointerup", 1, 9000, 9000);
    const edge = await viewNow();
    expect(edge.cx).toBe(250);
    expect(edge.cy).toBe(250);
  });

  it("moving a pointer that went up does nothing", async () => {
    fake.size = { width: 1000, height: 1000 };
    await open();
    fireEvent.change(slider(), { target: { value: "2" } });
    const before = await viewNow();
    pointer("pointermove", 1, 50, 50);
    expect(await viewNow()).toEqual(before);
  });

  it("two fingers pinch: spreading zooms in, the limits hold, and one finger left carries on as a drag", async () => {
    fake.size = { width: 1000, height: 1000 };
    await open();
    pointer("pointerdown", 1, 100, 140);
    pointer("pointerdown", 2, 180, 140);
    pointer("pointermove", 2, 260, 140); // the distance doubles
    expect((await viewNow()).zoom).toBeCloseTo(2, 6);
    pointer("pointermove", 2, 9000, 140);
    expect((await viewNow()).zoom).toBe(MAX_ZOOM);
    pointer("pointerup", 2, 9000, 140);
    const held = await viewNow();
    pointer("pointermove", 1, 90, 140);
    expect((await viewNow()).cx).toBeGreaterThan(held.cx);
  });
});

describe("saving, cancelling, focus", () => {
  it("保存 hands over the crop the view makes, and the dialog is left to its owner to close", async () => {
    const onSave = vi.fn(async () => "");
    await open({ onSave });
    fireEvent.change(slider(), { target: { value: "2" } });
    await act(async () => fireEvent.click(button("保存")));
    expect(fake.images[0].crop).toHaveBeenCalledWith(expect.objectContaining({ zoom: 2 }));
    expect(onSave).toHaveBeenCalledTimes(1);
    const sent = onSave.mock.calls[0][0];
    expect(sent.name).toBe("avatar.webp");
    expect(await sent.text()).toBe("cropped-bytes");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("while saving: 保存中…, every control off, and neither Esc, 取消 nor the backdrop leaves", async () => {
    let finish;
    const onSave = vi.fn(() => new Promise((r) => (finish = r)));
    const { onCancel } = await open({ onSave });
    await act(async () => fireEvent.click(button("保存")));
    expect(button("保存中…").disabled).toBe(true);
    for (const name of ["重置", "取消", "缩小", "放大"]) expect(button(name).disabled).toBe(true);
    expect(slider().disabled).toBe(true);
    press("ArrowLeft");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    fireEvent.mouseDown(document.querySelector(".modal-backdrop"));
    expect(onCancel).not.toHaveBeenCalled();
    await act(async () => finish(""));
    expect(button("保存").disabled).toBe(false);
  });

  it("a refusal from the owner is shown in the dialog, which stays with the picture where it was", async () => {
    const onSave = vi.fn(async () => "头像不能超过 2 MB。");
    await open({ onSave });
    fireEvent.change(slider(), { target: { value: "3" } });
    await act(async () => fireEvent.click(button("保存")));
    expect(screen.getByRole("alert").textContent).toBe("头像不能超过 2 MB。");
    expect(slider().value).toBe("3");
    await act(async () => fireEvent.click(button("保存")));
    expect(onSave).toHaveBeenCalledTimes(2);
  });

  it("a crop that cannot be made says so in the dialog", async () => {
    await open();
    fake.images[0].crop.mockRejectedValueOnce(Object.assign(new Error("x"), { text: "头像处理失败，请换一张图片。" }));
    await act(async () => fireEvent.click(button("保存")));
    expect(screen.getByRole("alert").textContent).toBe("头像处理失败，请换一张图片。");
    expect(button("保存").disabled).toBe(false);
  });

  it("取消 and Esc leave through onCancel without saving; the decoded picture is released when the dialog goes", async () => {
    const onSave = vi.fn();
    const { onCancel, image, unmount } = await open({ onSave });
    fireEvent.click(button("取消"));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onSave).not.toHaveBeenCalled();
    unmount();
    expect(image.close).toHaveBeenCalledTimes(1);
  });

  it("Tab stays inside the dialog (stage → slider → buttons and round again) and focus returns to what opened it", async () => {
    function Host() {
      const [shown, setShown] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setShown(true)}>更换头像</button>
          {shown && <AvatarDialog file={file()} onCancel={() => setShown(false)} onSave={async () => ""} />}
        </>
      );
    }
    render(<Host />);
    const opener = screen.getByRole("button", { name: "更换头像" });
    opener.focus();
    fireEvent.click(opener);
    await flush();
    const dlg = screen.getByRole("dialog");
    const inside = [...dlg.querySelectorAll("button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])")];
    expect(inside.length).toBeGreaterThanOrEqual(7);
    inside[inside.length - 1].focus();
    fireEvent.keyDown(dlg, { key: "Tab" });
    expect(document.activeElement).toBe(inside[0]);
    inside[0].focus();
    fireEvent.keyDown(dlg, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(inside[inside.length - 1]);
    fireEvent.keyDown(dlg, { key: "Escape" });
    await flush();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("a dialog closed before its picture was decoded releases the late answer unused", async () => {
    const { decodeAvatar } = await import("./avatar-fake.js");
    let answer;
    decodeAvatar.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const { unmount } = render(<AvatarDialog file={file()} onCancel={() => {}} onSave={async () => ""} />);
    unmount();
    const late = { width: 10, height: 10, paint: vi.fn(), crop: vi.fn(), close: vi.fn() };
    await act(async () => answer(late));
    expect(late.close).toHaveBeenCalledTimes(1);
    expect(late.paint).not.toHaveBeenCalled();
  });
});
