// @vitest-environment jsdom
// A group's avatar: shown wherever the group's picture is, changed only by the creator, with the controls by role.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { ANN, BO, D1, G1, ME_ID, apiError, direct, fakeFile, group, syncOf, wire } from "./fixtures.js";
import { button, click, dialog, flush, installBrowser, openApp, push, toastText } from "./harness.jsx";
import { resetFake } from "./avatar-fake.js";

beforeEach(() => {
  resetFake();
  installBrowser();
  let n = 0;
  URL.createObjectURL = vi.fn(() => `blob:preview-${++n}`);
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const MEMBER = (id, isCreator = false) => ({ id, role: "speaker", isCreator });
const mine = (fields = {}) =>
  syncOf(
    [direct(D1, ANN, { lastSeq: 1, readSeq: 1 }), group(G1, { lastSeq: 1, readSeq: 1, ...fields })],
    [wire(D1, 1, ANN, "早"), wire(G1, 1, ANN, "大家好")],
  );
/** A group somebody else created: 小安 is the creator. */
const others = (fields = {}) => mine({ creatorId: ANN, members: [MEMBER(ANN, true), MEMBER(ME_ID), MEMBER(BO)], ...fields });

const openProfile = async (tab = "群设置") => {
  await click(screen.getByText("周末小组", { selector: ".list-col .row-name" }));
  fireEvent.click(button("会话资料"));
  await flush();
  await click(within(document.querySelector(".side-col")).getByRole("button", { name: "打开群资料" }));
  await click(screen.getByRole("tab", { name: tab }));
};
const URL_OF = (v) => `/api/conversations/${G1}/avatar?v=${v}`;
const picturesOf = (root) => [...root.querySelectorAll(".group-picture img")].map((i) => i.getAttribute("src"));

describe("where it shows", () => {
  it("a group without an avatar looks exactly as it always did: the composite of its members, in the list, the header and the group's page", async () => {
    await openApp({ sync: () => mine() });
    expect(document.querySelector(".list-col .group-avatar")).toBeTruthy();
    expect(document.querySelector(".group-picture")).toBeNull();
    await openProfile();
    expect(document.querySelector(".profile-head .group-avatar")).toBeTruthy();
    expect(document.querySelector(".group-picture")).toBeNull();
  });

  it("a group with one shows it, versioned, in the list, the chat header, the side panel and the group's page; others' groups too", async () => {
    await openApp({ sync: () => mine({ avatarVersion: 3 }) });
    await click(screen.getByText("周末小组", { selector: ".list-col .row-name" }));
    expect(picturesOf(document.querySelector(".list-col"))).toEqual([URL_OF(3)]);
    expect(picturesOf(document.querySelector(".main-col"))).toEqual([URL_OF(3)]);
    fireEvent.click(button("会话资料"));
    await flush();
    expect(picturesOf(document.querySelector(".side-col"))).toEqual([URL_OF(3)]);
    await click(within(document.querySelector(".side-col")).getByRole("button", { name: "打开群资料" }));
    expect(picturesOf(document.querySelector(".profile-head"))).toEqual([URL_OF(3)]);
    expect(document.querySelector(".group-avatar")).toBeNull();
  });

  it("a picture that fails to load gives way to the composite", async () => {
    await openApp({ sync: () => others({ avatarVersion: 1 }) });
    const img = document.querySelector(".list-col .group-picture img");
    fireEvent.error(img);
    expect(document.querySelector(".list-col .group-picture")).toBeNull();
    expect(document.querySelector(".list-col .group-avatar")).toBeTruthy();
  });

  it("a push that the group changed fetches it again, and the new version is a new URL (also when it was removed and set again)", async () => {
    const { env, transport } = await openApp({ sync: () => mine({ avatarVersion: 1 }) });
    expect(picturesOf(document.querySelector(".list-col"))).toEqual([URL_OF(1)]);
    env.sync = () => mine({ avatarVersion: 2 });
    await push(transport, { type: "conversation", id: G1 });
    await flush();
    expect(picturesOf(document.querySelector(".list-col"))).toEqual([URL_OF(2)]);
    env.sync = () => mine();
    await push(transport, { type: "conversation", id: G1 });
    await flush();
    expect(picturesOf(document.querySelector(".list-col"))).toEqual([]);
    expect(document.querySelector(".list-col .group-avatar")).toBeTruthy();
    env.sync = () => mine({ avatarVersion: 3 });
    await push(transport, { type: "conversation", id: G1 });
    await flush();
    expect(picturesOf(document.querySelector(".list-col"))).toEqual([URL_OF(3)]);
  });
});

describe("the controls, by role", () => {
  it("the creator sees 更换头像 (and 移除头像 once there is one) in the group's settings; nobody else sees any control", async () => {
    await openApp({ sync: () => mine() });
    await openProfile();
    expect(screen.getByRole("heading", { name: "群头像" })).toBeTruthy();
    expect(button("更换头像")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "移除头像" })).toBeNull();
    cleanup();

    await openApp({ sync: () => mine({ avatarVersion: 2 }) });
    await openProfile();
    expect(button("更换头像")).toBeTruthy();
    expect(button("移除头像")).toBeTruthy();
    cleanup();

    await openApp({ sync: () => others({ avatarVersion: 2 }) });
    await openProfile();
    expect(screen.queryByRole("heading", { name: "群头像" })).toBeNull();
    expect(screen.queryByRole("button", { name: "更换头像" })).toBeNull();
    expect(screen.queryByRole("button", { name: "移除头像" })).toBeNull();
    expect(screen.queryByLabelText("选择头像图片")).toBeNull();
    expect(picturesOf(document.querySelector(".profile-head"))).toEqual([URL_OF(2)]);
  });
});

describe("changing it", () => {
  it("pick, adjust, 保存: the cropped file is uploaded for this group, the group is read again, and its new picture shows", async () => {
    const uploadGroupAvatar = vi.fn(async () => {
      env.sync = () => mine({ avatarVersion: 1, lastSeq: 1, readSeq: 1 });
      return { ok: true };
    });
    const { env } = await openApp({ sync: () => mine(), api: { uploadGroupAvatar } });
    await openProfile();
    const original = fakeFile("team.png", 9 * 1024 * 1024, "image/png");
    fireEvent.change(screen.getByLabelText("选择头像图片"), { target: { files: [original] } });
    await flush();
    expect(uploadGroupAvatar).not.toHaveBeenCalled();
    await click(within(dialog()).getByRole("button", { name: "保存" }));
    await flush();
    expect(uploadGroupAvatar).toHaveBeenCalledTimes(1);
    const [id, sent] = uploadGroupAvatar.mock.calls[0];
    expect(id).toBe(G1);
    expect(sent).not.toBe(original);
    expect(sent.name).toBe("avatar.webp");
    expect(toastText()).toBe("群头像已更新");
    expect(dialog()).toBeNull();
    expect(picturesOf(document.querySelector(".profile-head"))).toEqual([URL_OF(1)]);
    expect(button("移除头像")).toBeTruthy();
  });

  it("cancelling the dialog uploads nothing and leaves the group as it was", async () => {
    const uploadGroupAvatar = vi.fn();
    await openApp({ sync: () => mine(), api: { uploadGroupAvatar } });
    await openProfile();
    fireEvent.change(screen.getByLabelText("选择头像图片"), { target: { files: [fakeFile("team.png", 100, "image/png")] } });
    await flush();
    await click(within(dialog()).getByRole("button", { name: "取消" }));
    expect(uploadGroupAvatar).not.toHaveBeenCalled();
    expect(document.querySelector(".profile-head .group-avatar")).toBeTruthy();
  });

  it.each([
    ["forbidden", 403, "只有群的创建者可以修改群头像。"],
    ["not_found", 404, "你已不在这个群聊中。"],
    ["invalid_request", 400, "头像需要是 PNG、JPEG 或 WebP 格式的图片。"],
    ["rate_limited", 429, "头像改得太频繁了，请稍等一分钟再试。"],
  ])("a refusal (%s) is said in the dialog, which stays", async (code, status, text) => {
    await openApp({ sync: () => mine(), api: { uploadGroupAvatar: vi.fn(async () => Promise.reject(apiError(status, code))) } });
    await openProfile();
    fireEvent.change(screen.getByLabelText("选择头像图片"), { target: { files: [fakeFile("team.png", 100, "image/png")] } });
    await flush();
    await click(within(dialog()).getByRole("button", { name: "保存" }));
    await flush();
    expect(within(dialog()).getByRole("alert").textContent).toBe(text);
  });

  it("移除头像 takes it away at once: the request is for this group, a toast says so, and the composite is back", async () => {
    const removeGroupAvatar = vi.fn(async () => {
      env.sync = () => mine();
      return { ok: true };
    });
    const { env } = await openApp({ sync: () => mine({ avatarVersion: 4 }), api: { removeGroupAvatar } });
    await openProfile();
    await click(button("移除头像"));
    await flush();
    expect(removeGroupAvatar).toHaveBeenCalledWith(G1);
    expect(toastText()).toBe("群头像已移除");
    expect(document.querySelector(".profile-head .group-avatar")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "移除头像" })).toBeNull();
    expect(document.activeElement).toBe(button("更换头像")); // the pressed button is gone: focus goes to the first one
  });

  it("a refused removal says why", async () => {
    await openApp({ sync: () => mine({ avatarVersion: 4 }), api: { removeGroupAvatar: vi.fn(async () => Promise.reject(apiError(403, "forbidden"))) } });
    await openProfile();
    await click(button("移除头像"));
    await flush();
    expect(toastText()).toBe("只有群的创建者可以修改群头像。");
    expect(button("移除头像")).toBeTruthy();
  });
});
