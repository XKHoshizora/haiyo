// @vitest-environment jsdom
// Settings (profile, avatar, blocked people), avatars on screen, the Agent empty state, the lazy application shell.
import { PRODUCT_NAME } from "../src/brand.js";
import React from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ANN, BO, D1, G1, ME, ME_ID, apiError, deferred, direct, emptySocial, fakeFile, group, syncOf, wire } from "./fixtures.js";
import { decodeAvatar, fake, resetFake } from "./avatar-fake.js";
import { DORA, NOW, PEOPLE, button, click, dialog, flush, goContacts, inMain, installBrowser, mainText, openApp, toastText } from "./harness.jsx";

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

const baseSync = () => syncOf([direct(D1, ANN, { lastSeq: 1, readSeq: 1 })], [wire(D1, 1, ANN, "早")]);
const rail = (name) => within(screen.getByRole("navigation", { name: "主导航" })).getByRole("button", { name });
const goSettings = async () => {
  fireEvent.click(rail(/^设置/));
  await flush();
};
const settingsRow = (name) => screen.getByText(name, { selector: ".list-col .row-name" });
const dialogButton = (name) => within(dialog()).getByRole("button", { name });
const nameBox = () => screen.getByLabelText("昵称");
const fileBox = () => screen.getByLabelText("选择头像图片");
const choose = async (file) => {
  fireEvent.change(fileBox(), { target: { files: [file] } });
  await flush();
};
const source = (file) => readFileSync(path.join(import.meta.dirname, "..", file), "utf8");
const png = (size = 1000) => fakeFile("me.png", size, "image/png");

describe("settings list", () => {
  it("offers the profile, model providers, usage, the memory palace, blocked people; no Agent, device or demo entries", async () => {
    await openApp({ sync: baseSync });
    await goSettings();
    expect([...document.querySelectorAll(".list-col .row-name")].map((x) => x.textContent)).toEqual(["我的资料", "模型供应商", "用量与余额", "记忆宫殿", "拉黑"]);
    const text = (document.querySelector(".list-col").textContent + mainText()).replaceAll(PRODUCT_NAME, "");
    for (const word of ["Agent", "设备", "演示", "重置", "示例数据"]) expect(text).not.toContain(word);
    expect(document.querySelector(".list-col .settings-me").textContent).toContain("Mei");
  });
});

describe("profile page", () => {
  it("shows the account name and the e-mail as text, not as fields", async () => {
    await openApp({ sync: baseSync });
    await goSettings();
    const kv = document.querySelector(".kv");
    expect(kv.textContent).not.toContain("me_one");
    expect(kv.textContent).toContain("me@example.test");
    expect(document.querySelector(".profile-head").textContent).toContain("@me_one");
    expect(inMain().queryByDisplayValue("me@example.test")).toBeNull();
    expect(inMain().queryByDisplayValue("@me_one")).toBeNull();
    expect(nameBox().value).toBe("Mei");
  });

  it("keeps the sign-out button, in an action row spaced like the avatar's (not stuck to the hint above it)", async () => {
    await openApp({ sync: baseSync });
    await goSettings();
    const signOut = inMain().getByRole("button", { name: "退出登录" });
    const avatarRow = inMain().getByRole("button", { name: "更换头像" }).parentElement;
    expect(signOut.parentElement.className).toBe(avatarRow.className);
    expect(signOut.parentElement.classList.contains("row-actions")).toBe(true);
  });
});

describe("display name", () => {
  const saveName = async (value) => {
    fireEvent.change(nameBox(), { target: { value } });
    await click(button("保存"));
  };

  it("is saved trimmed, then shows everywhere", async () => {
    const updateMe = vi.fn(async (displayName) => ({ id: ME_ID, handle: "me_one", displayName }));
    await openApp({ sync: baseSync, api: { updateMe } });
    await goSettings();
    expect(button("保存").disabled).toBe(true);
    await saveName("  新昵称 ");
    expect(updateMe).toHaveBeenCalledWith("新昵称");
    expect(toastText()).toBe("昵称已更新");
    expect(document.querySelector(".profile-head .muted").textContent).toContain("新昵称");
    expect(document.querySelector(".settings-me").textContent).toContain("新昵称");
    expect(button("保存").disabled).toBe(true);
  });

  it("is checked before any request: empty, only spaces, a line break, over 40 characters", async () => {
    const updateMe = vi.fn(async (displayName) => ({ displayName }));
    await openApp({ sync: baseSync, api: { updateMe } });
    await goSettings();
    await saveName("   ");
    expect(screen.getByText("请输入昵称")).toBeTruthy();
    await saveName("名".repeat(41));
    expect(screen.getByText("昵称最多 40 个字")).toBeTruthy();
    expect(updateMe).not.toHaveBeenCalled();
    await saveName("😀".repeat(40));
    expect(updateMe).toHaveBeenCalledTimes(1);
  });

  it("shows a pending state and says why a refusal happened", async () => {
    const pending = deferred();
    const updateMe = vi.fn(() => pending.promise);
    await openApp({ sync: baseSync, api: { updateMe } });
    await goSettings();
    await saveName("新昵称");
    expect(button("保存中…").disabled).toBe(true);
    await act(async () => pending.reject(apiError(400, "invalid_request")));
    await flush();
    expect(toastText()).toBe("昵称需要 1–40 个字，且只能一行。");
    expect(nameBox().value).toBe("新昵称");
    expect(document.querySelector(".profile-head .muted").textContent).toContain("Mei");
    updateMe.mockImplementation(async () => {
      throw apiError(429, "rate_limited");
    });
    await click(button("保存"));
    expect(toastText()).toBe("操作太频繁了，请稍等一分钟再试。");
  });
});

describe("account name (账号名, Task N)", () => {
  const handleBox = () => screen.getByLabelText("账号名");
  const changeButton = () => inMain().getByRole("button", { name: /^修改账号名$|^保存中…$/ });
  const handleField = () => handleBox().closest(".field");
  /** A local day's midnight, as the service would send an instant; `hour` later that day shows as the next day (M7). */
  const dayAt = (y, m, d, hour = 0) => new Date(y, m - 1, d, hour, 0).toISOString();

  it("says it can change once a year; while it may change now there is no date", async () => {
    const getMe = vi.fn(async () => ({ ...ME, handleChangeAvailableAt: null }));
    await openApp({ sync: baseSync, api: { getMe } });
    await goSettings();
    expect(handleBox().value).toBe("me_one");
    expect(handleField().textContent).toContain("一年可以改一次");
    expect(handleField().textContent).not.toContain("起可以再改");
    expect(changeButton().disabled).toBe(true);
  });

  it("within the year shows the next date it may change, and the box stays as it is", async () => {
    const getMe = vi.fn(async () => ({ ...ME, handleChangeAvailableAt: dayAt(2027, 11, 20, 15) }));
    const updateHandle = vi.fn();
    await openApp({ sync: baseSync, api: { getMe, updateHandle } });
    await goSettings();
    expect(handleField().textContent).toContain("一年可以改一次，2027年11月21日起可以再改");
    expect(handleBox().disabled).toBe(true);
    expect(changeButton().disabled).toBe(true);
    expect(updateHandle).not.toHaveBeenCalled();
  });

  it("changes it: checked first, sent, shown everywhere at once, with the next date", async () => {
    let changed = null;
    const getMe = vi.fn(async () => ({ ...ME, handle: changed ?? ME.handle, handleChangeAvailableAt: changed ? dayAt(2027, 11, 21) : null }));
    const updateHandle = vi.fn(async (handle) => {
      changed = handle;
      return { id: ME_ID, handle, displayName: "Mei", avatarVersion: 0 };
    });
    await openApp({ sync: baseSync, api: { getMe, updateHandle } });
    await goSettings();
    fireEvent.change(handleBox(), { target: { value: "Mei.2" } });
    await click(changeButton());
    expect(handleField().textContent).toContain("账号名为 3 到 24 位小写字母、数字或下划线");
    expect(updateHandle).not.toHaveBeenCalled();
    fireEvent.change(handleBox(), { target: { value: "mei_2" } });
    await click(changeButton());
    expect(updateHandle).toHaveBeenCalledWith("mei_2");
    expect(toastText()).toBe("账号名已更新");
    expect(document.querySelector(".profile-head").textContent).toContain("@mei_2");
    expect(document.querySelector(".settings-me").textContent).toContain("mei_2");
    expect(handleField().textContent).toContain("2027年11月21日起可以再改");
  });

  it("says why a change was refused: the name is taken, or the year has not passed", async () => {
    const getMe = vi.fn(async () => ({ ...ME, handleChangeAvailableAt: null }));
    const updateHandle = vi.fn(async () => {
      throw apiError(409, "handle_taken");
    });
    await openApp({ sync: baseSync, api: { getMe, updateHandle } });
    await goSettings();
    fireEvent.change(handleBox(), { target: { value: "ann" } });
    await click(changeButton());
    expect(handleField().textContent).toContain("这个名字已经有人用了");
    expect(handleBox().getAttribute("aria-invalid")).toBe("true");
    expect(toastText()).toBeNull();
    updateHandle.mockImplementation(async () => {
      throw apiError(429, "handle_change_too_soon", null, { availableAt: dayAt(2027, 3, 5) });
    });
    fireEvent.change(handleBox(), { target: { value: "mei_3" } });
    await click(changeButton());
    expect(handleField().textContent).toContain("离上次改名还不到一年，2027年3月5日起可以再改");
    expect(handleBox().disabled).toBe(true);
    expect(document.querySelector(".profile-head").textContent).toContain("@me_one");
  });
});

describe("avatar", () => {
  const dialogOf = () => screen.queryByRole("dialog", { name: "调整头像" });
  const saveInDialog = async () => {
    await click(dialogButton("保存"));
    await flush();
  };

  it("refuses a file that is not PNG, JPEG or WebP, or is over 20 MB, without a dialog or a request", async () => {
    const uploadAvatar = vi.fn(async () => ({ ok: true }));
    await openApp({ sync: baseSync, api: { uploadAvatar } });
    await goSettings();
    await choose(fakeFile("a.gif", 100, "image/gif"));
    expect(screen.getByText("头像需要是 PNG、JPEG 或 WebP 格式的图片。")).toBeTruthy();
    await choose(fakeFile("a.svg", 100, "image/svg+xml"));
    expect(screen.getByText("头像需要是 PNG、JPEG 或 WebP 格式的图片。")).toBeTruthy();
    await choose(fakeFile("big.png", 20 * 1024 * 1024 + 1, "image/png"));
    expect(screen.getByText("图片不能超过 20 MB。")).toBeTruthy();
    expect(dialogOf()).toBeNull();
    expect(decodeAvatar).not.toHaveBeenCalled();
    expect(uploadAvatar).not.toHaveBeenCalled();
  });

  it("opens the adjust dialog for PNG, JPEG and WebP up to exactly 20 MB, and a file whose type is unknown but whose name says so", async () => {
    await openApp({ sync: baseSync, api: { uploadAvatar: vi.fn() } });
    await goSettings();
    for (const file of [png(20 * 1024 * 1024), fakeFile("a.jpg", 10, "image/jpeg"), fakeFile("a.webp", 10, "image/webp"), fakeFile("a.JPEG", 10, "")]) {
      await choose(file);
      expect(dialogOf()).toBeTruthy();
      await click(dialogButton("取消"));
      expect(dialogOf()).toBeNull();
    }
    expect(decodeAvatar).toHaveBeenCalledTimes(4);
  });

  it("uploads what the dialog saved, never the picked file, and gives my avatar a new version", async () => {
    const uploadAvatar = vi.fn(async () => ({ ok: true }));
    await openApp({ sync: baseSync, api: { uploadAvatar } });
    await goSettings();
    const mine = () => [...document.querySelectorAll(".rail-me img, .settings-me img, .avatar-editor img")].map((i) => i.getAttribute("src"));
    expect(mine().every((src) => src === `/api/principals/${ME_ID}/avatar`)).toBe(true);
    const file = png(15 * 1024 * 1024);
    await choose(file);
    expect(uploadAvatar).not.toHaveBeenCalled();
    await saveInDialog();
    expect(uploadAvatar).toHaveBeenCalledTimes(1);
    const sent = uploadAvatar.mock.calls[0][0];
    expect(sent).not.toBe(file);
    expect(sent.type).toBe("image/webp");
    expect(sent.name).toBe("avatar.webp");
    expect(await sent.text()).toBe("cropped-bytes");
    expect(dialogOf()).toBeNull();
    expect(toastText()).toBe("头像已更新");
    const versioned = `/api/principals/${ME_ID}/avatar?v=${NOW}`;
    expect(mine().length).toBeGreaterThanOrEqual(3);
    expect(mine().every((src) => src === versioned)).toBe(true);
  });

  it("a person's avatar elsewhere does not change", async () => {
    await openApp({ sync: baseSync, api: { uploadAvatar: vi.fn(async () => ({ ok: true })) } });
    await goSettings();
    await choose(png());
    await saveInDialog();
    await click(rail(/^消息/));
    const src = document.querySelector(".list-col .row img").getAttribute("src");
    expect(src).toBe(`/api/principals/${ANN}/avatar`);
  });

  it("cancelling leaves everything as it was: nothing is uploaded, the avatar and its version stay, and focus returns to the button", async () => {
    const uploadAvatar = vi.fn(async () => ({ ok: true }));
    await openApp({ sync: baseSync, api: { uploadAvatar } });
    await goSettings();
    const opener = button("更换头像");
    opener.focus();
    await choose(png());
    await click(dialogButton("取消"));
    expect(uploadAvatar).not.toHaveBeenCalled();
    expect(toastText()).toBeNull();
    expect(document.querySelector(".rail-me img").getAttribute("src")).toBe(`/api/principals/${ME_ID}/avatar`);
    expect(document.activeElement).toBe(opener);
    // Esc does the same.
    await choose(png());
    fireEvent.keyDown(dialog(), { key: "Escape" });
    await flush();
    expect(dialogOf()).toBeNull();
    expect(uploadAvatar).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(opener);
    expect(fake.images.every((image) => image.close.mock.calls.length === 1)).toBe(true);
  });

  it("a refusal says why in the dialog, which stays; saving again works once the service accepts", async () => {
    const uploadAvatar = vi.fn(async () => {
      throw apiError(413, "too_large");
    });
    await openApp({ sync: baseSync, api: { uploadAvatar } });
    await goSettings();
    await choose(png());
    await saveInDialog();
    expect(within(dialog()).getByRole("alert").textContent).toBe("头像不能超过 2 MB。");
    uploadAvatar.mockImplementation(async () => {
      throw apiError(400, "invalid_request");
    });
    await saveInDialog();
    expect(within(dialog()).getByRole("alert").textContent).toBe("头像需要是 PNG、JPEG 或 WebP 格式的图片。");
    expect(document.querySelector(".rail-me img").getAttribute("src")).toBe(`/api/principals/${ME_ID}/avatar`);
    uploadAvatar.mockImplementation(async () => ({ ok: true }));
    await saveInDialog();
    expect(dialogOf()).toBeNull();
    expect(toastText()).toBe("头像已更新");
  });

  it("shows a pending state while uploading, and Esc does not drop a save under way", async () => {
    const pending = deferred();
    await openApp({ sync: baseSync, api: { uploadAvatar: vi.fn(() => pending.promise) } });
    await goSettings();
    await choose(png());
    await saveInDialog();
    expect(dialogButton("保存中…").disabled).toBe(true);
    expect(dialogButton("取消").disabled).toBe(true);
    fireEvent.keyDown(dialog(), { key: "Escape" });
    await flush();
    expect(dialogOf()).toBeTruthy();
    await act(async () => pending.resolve({ ok: true }));
    await flush();
    expect(dialogOf()).toBeNull();
  });

  it("a picture that cannot be decoded gets a clear message, not a broken dialog", async () => {
    const uploadAvatar = vi.fn();
    await openApp({ sync: baseSync, api: { uploadAvatar } });
    await goSettings();
    fake.fail = "这张图片无法读取，请换一张。";
    await choose(png());
    expect(within(dialog()).getByRole("alert").textContent).toBe("这张图片无法读取，请换一张。");
    expect(within(dialog()).queryByRole("button", { name: "保存" })).toBeNull();
    await click(dialogButton("知道了"));
    expect(dialogOf()).toBeNull();
    expect(uploadAvatar).not.toHaveBeenCalled();
  });
});

describe("avatars on screen", () => {
  const sync = () =>
    syncOf(
      [direct(D1, ANN, { lastSeq: 2, readSeq: 2 }), group(G1, { lastSeq: 2, readSeq: 2 })],
      [wire(D1, 1, ANN, "早"), wire(D1, 2, ME_ID, "早啊"), wire(G1, 1, BO, "大家好"), wire(G1, 2, ANN, "你好")],
    );

  it("every person is a picture from the service, lazy, over an initial", async () => {
    await openApp({ sync });
    const rowImg = document.querySelector(".list-col .row img");
    expect(rowImg.getAttribute("loading")).toBe("lazy");
    await click(screen.getByText("小安", { selector: ".list-col .row-name" }));
    const urls = [...document.querySelectorAll(".main-col .msg img")].map((i) => i.getAttribute("src"));
    expect(urls).toEqual([`/api/principals/${ANN}/avatar`, `/api/principals/${ME_ID}/avatar`]);
    expect(document.querySelector(".msg .avatar-fallback").textContent.startsWith("小")).toBe(true);
    expect(document.querySelector(".msg.mine .avatar-fallback").textContent.startsWith("M")).toBe(true);
  });

  it("an image that fails to load leaves the initial", async () => {
    await openApp({ sync });
    await click(screen.getByText("小安", { selector: ".list-col .row-name" }));
    const avatar = document.querySelector(".main-col .msg .avatar");
    fireEvent.error(avatar.querySelector("img"));
    expect(avatar.querySelector("img")).toBeNull();
    expect(avatar.textContent).toBe("小");
  });

  it("a group keeps the prototype's composite of member avatars", async () => {
    await openApp({ sync });
    const composite = document.querySelector(".group-avatar");
    expect(composite.classList.contains("n3")).toBe(true);
    expect(composite.querySelectorAll("img")).toHaveLength(3);
  });

  it("a member nobody names here still has an avatar (the service makes one)", async () => {
    const ghost = "00000000-0000-4000-8000-0000000000b9";
    await openApp({ sync: () => syncOf([group(G1, { lastSeq: 1, readSeq: 1 })], [wire(G1, 1, ghost, "我走了")]) });
    await click(screen.getByText("周末小组", { selector: ".list-col .row-name" }));
    expect(document.querySelector(".main-col .msg img").getAttribute("src")).toBe(`/api/principals/${ghost}/avatar`);
  });

  it("the prototype's avatar atlas is not used for people", () => {
    expect(source("src/ui/primitives.jsx")).not.toContain("identities.png");
    expect(source("src/data/identities.js")).not.toContain("CELL");
  });
});

describe("blocked people", () => {
  const social = () => ({ ...emptySocial(), blocked: [PEOPLE[DORA], PEOPLE[ANN]], blockedBy: [PEOPLE[BO]] });

  it("lists the people I blocked (not those who blocked me), each with 解除拉黑", async () => {
    await openApp({ sync: baseSync, social: social() });
    await goSettings();
    await click(settingsRow("拉黑"));
    const names = [...inMain().getAllByRole("listitem")].map((li) => li.querySelector("strong").textContent);
    expect(names.sort()).toEqual(["小安", "朵拉"].sort());
    expect(inMain().getAllByRole("button", { name: "解除拉黑" })).toHaveLength(2);
    expect(mainText()).not.toContain("阿波");
  });

  it("asks first; cancel changes nothing; confirming lifts only that block", async () => {
    let current = social();
    const unblockPrincipal = vi.fn(async (id) => {
      current = { ...current, blocked: current.blocked.filter((p) => p.id !== id) };
      return { ok: true };
    });
    const app = await openApp({ sync: baseSync, social: social(), api: { unblockPrincipal } });
    app.env.social = current;
    await goSettings();
    await click(settingsRow("拉黑"));
    const row = inMain().getByText("朵拉", { selector: "strong" }).closest("li");
    await click(within(row).getByRole("button", { name: "解除拉黑" }));
    expect(dialog().textContent).toContain("解除对朵拉的拉黑");
    await click(dialogButton("取消"));
    expect(unblockPrincipal).not.toHaveBeenCalled();
    await click(within(row).getByRole("button", { name: "解除拉黑" }));
    app.env.social = { ...emptySocial(), blocked: [PEOPLE[ANN]] };
    await click(dialogButton("解除我的拉黑"));
    expect(unblockPrincipal).toHaveBeenCalledWith(DORA);
    expect(dialog()).toBeNull();
    expect([...inMain().getAllByRole("listitem")].map((li) => li.querySelector("strong").textContent)).toEqual(["小安"]);
  });

  it("says so when nobody is blocked", async () => {
    await openApp({ sync: baseSync });
    await goSettings();
    await click(settingsRow("拉黑"));
    expect(mainText()).toContain("你没有拉黑任何人。");
  });
});

describe("the Agent entry", () => {
  it("opens my Agent list; without any it says how to start", async () => {
    await openApp({ sync: baseSync });
    fireEvent.click(rail(/^Agent/));
    await flush();
    expect(document.querySelector(".list-col h1").textContent).toBe("我的 Agent");
    expect(document.querySelector(".list-col .rows-empty").textContent).toBe("还没有 Agent，点右上角的“+”创建一个");
    expect(document.querySelector(".main-col .empty-main").textContent).toBe("选择一个 Agent");
    expect(document.querySelectorAll(".list-col .row")).toHaveLength(0);
  });
});

describe("empty states", () => {
  it("a list without any conversation says how to start one", async () => {
    await openApp({ sync: () => syncOf([]) });
    expect(document.querySelector(".list-col .rows-empty").textContent).toBe("还没有会话，点右上角的“+”添加好友或发起群聊");
  });
});

describe("carried fixes", () => {
  it("the add-friend dialog opens with the account-name field focused", async () => {
    await openApp({ sync: baseSync });
    await goContacts();
    await click(button("添加好友"));
    expect(document.activeElement).toBe(within(dialog()).getByLabelText("对方的账号名"));
  });

  it("the add-member dialog opens with the search field focused", async () => {
    const sync = () => syncOf([group(G1, { lastSeq: 1, readSeq: 1 })], [wire(G1, 1, ANN, "大家好")]);
    await openApp({ sync, social: { ...emptySocial(), friends: [PEOPLE[ANN], PEOPLE[BO], PEOPLE[DORA]] } });
    await click(screen.getByText("周末小组", { selector: ".list-col .row-name" }));
    fireEvent.click(button("会话资料"));
    await flush();
    await click(within(document.querySelector(".side-col")).getByRole("button", { name: "打开群资料" }));
    await click(button("添加成员"));
    expect(document.activeElement).toBe(within(dialog()).getByLabelText("搜索好友或我的 Agent"));
  });

  it("lifting my block says what has to be true for sending to work again", async () => {
    const sync = () => syncOf([direct(D1, ANN, { lastSeq: 1, readSeq: 1, canSend: { ok: false, reason: "blocked" } })], [wire(D1, 1, ANN, "早")]);
    await openApp({ sync, social: { ...emptySocial(), blocked: [PEOPLE[ANN]] } });
    await click(screen.getByText("小安", { selector: ".list-col .row-name" }));
    fireEvent.click(button("会话资料"));
    await flush();
    await click(within(document.querySelector(".side-col")).getByRole("button", { name: "解除我的拉黑" }));
    expect(dialog().textContent).toContain("否则需要重新成为好友，或等对方解除拉黑。");
    expect(dialog().textContent).not.toContain("仍需对方解除");
  });
});

describe("the application chunk", () => {
  it("is imported lazily: nothing in App.jsx loads the pages up front", () => {
    const app = source("src/App.jsx");
    expect(app).not.toMatch(/from "\.\/(AppShell|pages\/)/);
    expect(app).toContain('import("./AppShell.jsx")');
  });

  it("index.html carries no inline script (the page runs under script-src 'self')", () => {
    const html = source("index.html");
    for (const tag of html.match(/<script[^>]*>/g) ?? []) expect(tag).toContain("src=");
    expect(html).not.toMatch(/<script[^>]*>\s*[^<\s]/);
  });
});

describe("the adjust dialog and the page it belongs to", () => {
  it("is closed when the layout stops drawing the page (a wide window narrowed while it was open)", async () => {
    await openApp({ sync: baseSync });
    await goSettings();
    await choose(png());
    expect(dialog()).not.toBeNull();
    const rects = vi.spyOn(Element.prototype, "getClientRects");
    rects.mockReturnValue([]); // the page beside the list is no longer drawn
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(dialog()).toBeNull();
  });
});
