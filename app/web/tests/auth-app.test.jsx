// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ApiError, bumpSessionEpoch, request, setUnauthenticatedHandler } from "../src/api/http.js";
import { deferred, fakeTimers, fakeTransport, settle, syncOf } from "./fixtures.js";
import { AuthRoot, useSession } from "../src/auth/AuthRoot.jsx";
import { RETURN_KEY, clearResetToken, takeReturn } from "../src/auth/router.js";
import { LEGAL_VERSIONS } from "../src/legal/versions.js";
import { draftKeys, peekDraft, saveDraft } from "../src/data/drafts.js";
import { StoreProvider, createDataLayer, emptyState } from "../src/data/store.jsx";
import { SettingsList, SettingsMain } from "../src/pages/Settings.jsx";
import { PHONE_QUERY } from "../src/ui/pointer.js";

// The screens here load lazily (the app's chunk, the account screens): on a busy machine that takes longer than
// Testing Library's default 1 s wait for findBy… / waitFor, which then failed for nothing. Each wait may now take 5 s
// (and a test 15 s); it still ends as soon as what it waits for is there.
configure({ asyncUtilTimeout: 5_000 });
vi.setConfig({ testTimeout: 15_000 });

const ANN = { id: "p-ann", handle: "ann", displayName: "小安", email: "ann@x.com" };
const BO = { id: "p-bo", handle: "bo", displayName: "阿波", email: "bo@x.com" };
const SIGNED_OUT = () => new ApiError(401, "unauthenticated");
const EXPIRED_NOTICE = "登录已失效，请重新登录。";

function fakeLayer() {
  const handlers = new Set();
  const accounts = new Set();
  let retired = false;
  return {
    start: vi.fn(),
    stop: vi.fn(),
    retire: vi.fn(() => {
      retired = true;
    }),
    isRetired: () => retired,
    onSignedOut: (fn) => {
      handlers.add(fn);
      return () => handlers.delete(fn);
    },
    onAccountChanged: (fn) => {
      accounts.add(fn);
      return () => accounts.delete(fn);
    },
    closeWith4001: () => [...handlers].forEach((fn) => fn()),
    /** A sync of the layer answered for `me`, another account (someone else signed in in this browser). */
    answeredFor: (me) => [...accounts].forEach((fn) => fn(me)),
  };
}

function fakeApi(over = {}) {
  return {
    getMe: vi.fn(async () => ANN),
    signIn: vi.fn(async () => ({})),
    signOut: vi.fn(async () => ({ success: true })),
    register: vi.fn(async () => ({ ok: true })),
    requestPasswordReset: vi.fn(async () => ({ status: true })),
    resetPassword: vi.fn(async () => ({ status: true })),
    // A site that sends mail and requires the terms (`GET /api/site`), unless a test says otherwise.
    getSite: vi.fn(async () => ({ mailDelivered: true, termsRequired: true })),
    ...over,
  };
}

// The app is on screen a moment before AuthRoot's effect has registered the layer's sign-out handler (React runs passive effects
// in a task of its own, and a slow machine lets Testing Library see the DOM first): a close sent then reaches nobody. The layer
// is started in that same effect, so once `start` was called the handler is there.
const closeWith4001 = async (layer) => {
  await waitFor(() => expect(layer.start).toHaveBeenCalled());
  act(() => layer.closeWith4001());
};

const outApi = (over) => fakeApi({ getMe: vi.fn(async () => Promise.reject(SIGNED_OUT())), ...over });
const at = (path) => history.replaceState(null, "", path);
const place = () => location.pathname + location.search;

let layers;
const createLayer = () => {
  const layer = fakeLayer();
  layers.push(layer);
  return layer;
};

function mount(api, children) {
  return render(
    <AuthRoot api={api} createLayer={createLayer}>
      {children ?? ((layer, key) => <div data-testid="app" data-key={key} />)}
    </AuthRoot>,
  );
}

const typeInto = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const submit = (name) => fireEvent.click(screen.getByRole("button", { name }));

// The acceptance (src/legal/; the service records it, app/service/src/legal.ts): the two boxes and what is sent.
const ADULT_LABEL = "我已年满 18 岁";
const AGREE_LABEL = "我已阅读并同意《服务条款》和《隐私政策》";
const ADULT_MISSING = "请确认你已年满 18 岁";
const AGREE_MISSING = "请先阅读并同意服务条款和隐私政策";
const ACCEPTANCE = { termsVersion: LEGAL_VERSIONS.terms, privacyVersion: LEGAL_VERSIONS.privacy, adult: true };
const tickAcceptance = () => {
  fireEvent.click(screen.getByRole("checkbox", { name: ADULT_LABEL }));
  fireEvent.click(screen.getByRole("checkbox", { name: AGREE_LABEL }));
};
/** The three public pages, linked from a screen: each the shared text link, opening in a new tab (a form keeps what was typed). */
function expectLegalLinks() {
  const nav = screen.getByRole("navigation", { name: "条款与联系" });
  for (const [name, href] of [["服务条款", "/terms"], ["隐私政策", "/privacy"], ["联系我们", "/contact"]]) {
    const link = within(nav).getByRole("link", { name });
    expect([name, link.getAttribute("href"), link.getAttribute("target"), link.getAttribute("rel"), link.classList.contains("text-link")]).toEqual([name, href, "_blank", "noopener", true]);
  }
}
const me = { id: "me", kind: "person", name: "你", handle: "@ann", cell: [0, 0] };

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
});
beforeEach(() => {
  layers = [];
  at("/");
});
afterEach(() => {
  cleanup();
  clearResetToken();
  setUnauthenticatedHandler(null);
  vi.unstubAllGlobals();
});

describe("start-up", () => {
  it("shows neither screen while GET /api/me is pending, then the app for a signed-in user (me asked once)", async () => {
    let answer;
    const api = fakeApi({ getMe: vi.fn(() => new Promise((resolve) => (answer = resolve))) });
    mount(api);
    expect(screen.getByRole("status").textContent).toBe("正在加载…");
    expect(screen.queryByTestId("app")).toBeNull();
    expect(screen.queryByRole("button", { name: "登录" })).toBeNull();
    await act(async () => answer(ANN));
    expect(screen.getByTestId("app")).toBeTruthy();
    expect(api.getMe).toHaveBeenCalledTimes(1);
    expect(layers[0].start).toHaveBeenCalledTimes(1);
  });

  it("a signed-out visitor of the app lands on /signin, never seeing the app", async () => {
    mount(outApi());
    await screen.findByRole("button", { name: "登录" });
    expect(place()).toBe("/signin");
    expect(screen.queryByTestId("app")).toBeNull();
    expect(layers[0].start).not.toHaveBeenCalled();
    expect(screen.queryByText(EXPIRED_NOTICE)).toBeNull();
  });

  it("a signed-in user on /signin is sent to the app", async () => {
    at("/signin");
    mount(fakeApi());
    await screen.findByTestId("app");
    expect(place()).toBe("/");
  });

  it("when the service cannot be reached it says so and retries on request", async () => {
    const getMe = vi.fn().mockRejectedValueOnce(new ApiError(0, "network_error")).mockResolvedValue(ANN);
    mount(fakeApi({ getMe }));
    await screen.findByText("连不上服务，请检查网络后重试。");
    submit("重试");
    await screen.findByTestId("app");
    expect(getMe).toHaveBeenCalledTimes(2);
  });
});

describe("sign-in", () => {
  const signInApi = (over) => fakeApi({ getMe: vi.fn().mockRejectedValueOnce(SIGNED_OUT()).mockResolvedValue(ANN), ...over });
  async function signedOutAt(api) {
    at("/signin");
    mount(api);
    await screen.findByRole("button", { name: "登录" });
  }

  it("names the product Haiyo in the heading and on the mark", async () => {
    await signedOutAt(signInApi());
    expect(screen.getByRole("heading", { name: "登录 Haiyo" })).toBeTruthy();
    expect(screen.getByAltText("Haiyo")).toBeTruthy();
    expect(document.body.textContent).not.toContain("Agent Family");
  });

  it("its secondary links are the shared text link, not a raw anchor", async () => {
    await signedOutAt(signInApi());
    for (const name of ["忘记密码", "注册新账号"]) {
      const link = screen.getByRole("link", { name });
      expect([name, link.classList.contains("text-link"), link.classList.contains("btn")]).toEqual([name, true, false]);
    }
  });

  it("links the terms, the privacy policy and the contact page", async () => {
    await signedOutAt(signInApi());
    expectLegalLinks();
  });

  it("sets the right autocomplete attributes", async () => {
    await signedOutAt(signInApi());
    expect(screen.getByLabelText("邮箱").getAttribute("autocomplete")).toBe("email");
    expect(screen.getByLabelText("密码").getAttribute("autocomplete")).toBe("current-password");
  });

  it("invalid fields show inline errors and the first one is focused, with no request", async () => {
    const api = signInApi();
    await signedOutAt(api);
    submit("登录");
    await screen.findByText("请输入邮箱");
    expect(screen.getByText("请输入密码")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("邮箱")));
    expect(api.signIn).not.toHaveBeenCalled();
  });

  it("signs in, confirms the session with /api/me, starts the data layer and goes to the app", async () => {
    const api = signInApi();
    await signedOutAt(api);
    typeInto("邮箱", " ann@x.com ");
    typeInto("密码", "correct horse");
    submit("登录");
    await screen.findByTestId("app");
    expect(api.signIn).toHaveBeenCalledWith({ email: "ann@x.com", password: "correct horse", callbackURL: "/verify" });
    expect(place()).toBe("/");
    await waitFor(() => expect(layers[0].start).toHaveBeenCalledTimes(1));
  });

  it("a link to a page of the app, opened signed out, is that page after signing in (not the list)", async () => {
    const api = signInApi();
    at("/chat/00000000-0000-4000-8000-0000000000c1");
    mount(api);
    await screen.findByRole("button", { name: "登录" });
    expect(place()).toBe("/signin");
    typeInto("邮箱", "ann@x.com");
    typeInto("密码", "correct horse");
    submit("登录");
    await screen.findByTestId("app");
    expect(place()).toBe("/chat/00000000-0000-4000-8000-0000000000c1");
  });

  it.each([
    ["invalid_email_or_password", 401, "邮箱或密码不对，请再试一次。"],
    ["email_not_verified", 403, "这个邮箱还没有验证。我们刚刚又发了一封验证邮件，请查收后再登录。"],
    ["rate_limited", 429, "操作太频繁了，请稍等一分钟再试。"],
    ["network_error", 0, "连不上服务，请检查网络后重试。"],
  ])("%s is shown on the form", async (code, status, text) => {
    const api = signInApi({ signIn: vi.fn(async () => Promise.reject(new ApiError(status, code))) });
    await signedOutAt(api);
    typeInto("邮箱", "ann@x.com");
    typeInto("密码", "wrong");
    submit("登录");
    await screen.findByText(text);
    expect(screen.queryByTestId("app")).toBeNull();
    expect(place()).toBe("/signin");
  });
});

describe("register", () => {
  /** Fills the form; ticks the 18+ declaration and the agreement unless `ticked` says otherwise. */
  const fill = (over = {}, ticked = true) => {
    const values = { 邀请码: "inv-1", 邮箱: "ann@x.com", 密码: "0123456789", 昵称: "小安", 账号名: "ann_1", ...over };
    for (const [label, value] of Object.entries(values)) typeInto(label, value);
    if (ticked) tickAcceptance();
  };
  async function open(api = outApi()) {
    at("/register");
    mount(api);
    await screen.findByRole("button", { name: "注册" });
    await act(async () => {}); // the site's answer (GET /api/site) is in
    return api;
  }

  it("always carries the line that points a registered person to sign-in (it never depends on the address)", async () => {
    await open(outApi({ register: vi.fn(async () => Promise.reject(new ApiError(400, "invalid_invite"))) }));
    expect(screen.getByText("已经注册过？直接登录就行。")).toBeTruthy();
    fill();
    submit("注册");
    await screen.findByText("邀请码无效、已过期或已用完，请向邀请你的人确认。");
    expect(screen.getAllByText("已经注册过？直接登录就行。")).toHaveLength(1);
  });

  it("links the terms, the privacy policy and the contact page", async () => {
    await open();
    expectLegalLinks();
  });

  it("the check-your-mailbox page tells what to do when nothing arrives", async () => {
    await open();
    fill();
    submit("注册");
    await screen.findByText(/已向 ann@x.com 发送了一封验证邮件/);
    expect(screen.getByText("没收到？看看垃圾邮件箱；还没验证时用注册的邮箱和密码登录，我们会再发一封。")).toBeTruthy();
  });

  it("its sign-in link and the one on the check-your-mailbox page are the shared text link", async () => {
    await open();
    expect(screen.getByRole("link", { name: "已有账号？去登录" }).classList.contains("text-link")).toBe(true);
    fill();
    submit("注册");
    await screen.findByText(/已向 ann@x.com 发送了一封验证邮件/);
    expect(screen.getByRole("link", { name: "去登录" }).classList.contains("text-link")).toBe(true);
  });

  it("sets autocomplete for the new password and e-mail", async () => {
    await open();
    expect(screen.getByLabelText("密码").getAttribute("autocomplete")).toBe("new-password");
    expect(screen.getByLabelText("邮箱").getAttribute("autocomplete")).toBe("email");
  });

  it("validates every field and focuses the first invalid one", async () => {
    await open();
    fill({ 密码: "short", 账号名: "Bad Name" });
    submit("注册");
    await screen.findByText("密码至少 10 位");
    expect(screen.getByText("账号名为 3 到 24 位小写字母、数字或下划线")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("密码")));
  });

  it("sends the trimmed values and then asks to check the mailbox", async () => {
    const api = await open();
    fill({ 邀请码: " inv-1 ", 昵称: " 小安 " });
    submit("注册");
    await screen.findByText(/已向 ann@x.com 发送了一封验证邮件/);
    expect(api.register).toHaveBeenCalledWith({ inviteCode: "inv-1", email: "ann@x.com", password: "0123456789", displayName: "小安", handle: "ann_1", ...ACCEPTANCE });
  });

  it("without the 18+ declaration and the agreement nothing is sent; each box says what it needs and the first is focused", async () => {
    const api = await open();
    fill({}, false);
    submit("注册");
    await screen.findByText(ADULT_MISSING);
    expect(screen.getByText(AGREE_MISSING)).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("checkbox", { name: ADULT_LABEL })));
    expect(api.register).not.toHaveBeenCalled();
    // One of the two is not enough.
    fireEvent.click(screen.getByRole("checkbox", { name: ADULT_LABEL }));
    submit("注册");
    await screen.findByText(AGREE_MISSING);
    expect(screen.queryByText(ADULT_MISSING)).toBeNull();
    expect(api.register).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox", { name: AGREE_LABEL }));
    submit("注册");
    await screen.findByText(/已向 ann@x.com 发送了一封验证邮件/);
    expect(api.register).toHaveBeenCalledTimes(1);
  });

  it("says Haiyo is for people 18 and older, and links the terms and the policy from the agreement, in a new tab", async () => {
    await open();
    expect(screen.getByText("Haiyo 只给 18 岁以上的人使用。")).toBeTruthy();
    const agree = screen.getByRole("checkbox", { name: AGREE_LABEL }).closest("label");
    for (const [name, href] of [["服务条款", "/terms"], ["隐私政策", "/privacy"]]) {
      const link = within(agree).getByRole("link", { name });
      expect([name, link.getAttribute("href"), link.getAttribute("target"), link.getAttribute("rel"), link.classList.contains("text-link")]).toEqual([name, href, "_blank", "noopener", true]);
    }
  });

  it("terms_outdated (the page is older than the documents) asks for a reload", async () => {
    await open(outApi({ register: vi.fn(async () => Promise.reject(new ApiError(409, "terms_outdated"))) }));
    fill();
    submit("注册");
    await screen.findByText("条款刚刚更新了，请刷新页面后再试。");
  });

  it.each([
    ["invalid_invite", 400, "邀请码", "邀请码无效、已过期或已用完，请向邀请你的人确认。"],
    ["handle_taken", 409, "账号名", "这个账号名已被占用，换一个试试。"],
  ])("%s lands on its own field, focused", async (code, status, label, text) => {
    await open(outApi({ register: vi.fn(async () => Promise.reject(new ApiError(status, code))) }));
    fill();
    submit("注册");
    await screen.findByText(text);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText(label)));
  });

  it("rate_limited is shown on the form", async () => {
    await open(outApi({ register: vi.fn(async () => Promise.reject(new ApiError(429, "rate_limited"))) }));
    fill();
    submit("注册");
    await screen.findByText("操作太频繁了，请稍等一分钟再试。");
  });

  it("on a site that sends no mail (GET /api/site), the page after registering says so instead of a mail sent", async () => {
    const api = await open(outApi({ getSite: vi.fn(async () => ({ mailDelivered: false, termsRequired: true })) }));
    fill();
    submit("注册");
    await screen.findByText("这个站点不发送邮件。请向管理员索取验证链接。");
    expect(document.body.textContent).not.toMatch(/发送了一封|查收|垃圾邮件|重置链接/);
    expect(screen.getByRole("link", { name: "去登录" }).classList.contains("text-link")).toBe(true);
    expect(api.getSite).toHaveBeenCalledTimes(1);
  });

  it("on a site that sends mail the page is as it was", async () => {
    await open(outApi({ getSite: vi.fn(async () => ({ mailDelivered: true, termsRequired: true })) }));
    fill();
    submit("注册");
    await screen.findByText(/已向 ann@x.com 发送了一封验证邮件/);
    expect(screen.queryByText("这个站点不发送邮件。请向管理员索取验证链接。")).toBeNull();
  });
});

describe("a site that does not require the terms yet (LEGAL off: GET /api/site and GET /api/me say termsRequired false)", () => {
  const OFF_SITE = { mailDelivered: false, termsRequired: false };

  it("registration shows no boxes and sends no acceptance", async () => {
    const api = outApi({ getSite: vi.fn(async () => OFF_SITE) });
    at("/register");
    mount(api);
    await screen.findByRole("button", { name: "注册" });
    await waitFor(() => expect(api.getSite).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByText("Haiyo 只给 18 岁以上的人使用。")).toBeNull();
    for (const [label, value] of Object.entries({ 邀请码: "inv-1", 邮箱: "ann@x.com", 密码: "0123456789", 昵称: "小安", 账号名: "ann_1" })) typeInto(label, value);
    submit("注册");
    await screen.findByText("这个站点不发送邮件。请向管理员索取验证链接。");
    expect(api.register).toHaveBeenCalledWith({ inviteCode: "inv-1", email: "ann@x.com", password: "0123456789", displayName: "小安", handle: "ann_1" });
    // The three pages are still linked.
    expectLegalLinks();
  });

  it("when GET /api/site fails, shows no boxes and the sign-up goes through (the service decides)", async () => {
    const api = outApi({ getSite: vi.fn(async () => Promise.reject(new ApiError(0, "network_error"))) });
    at("/register");
    mount(api);
    await screen.findByRole("button", { name: "注册" });
    await act(async () => {});
    expect(screen.queryByRole("checkbox")).toBeNull();
    for (const [label, value] of Object.entries({ 邀请码: "inv-1", 邮箱: "ann@x.com", 密码: "0123456789", 昵称: "小安", 账号名: "ann_1" })) typeInto(label, value);
    submit("注册");
    await screen.findByText(/已向 ann@x.com 发送了一封验证邮件/);
    expect(api.register).toHaveBeenCalledWith({ inviteCode: "inv-1", email: "ann@x.com", password: "0123456789", displayName: "小安", handle: "ann_1" });
  });

  it("on a site that requires them but has not said so yet, the refusal (400 terms_required) shows the boxes and keeps what was typed", async () => {
    const register = vi.fn().mockRejectedValueOnce(new ApiError(400, "terms_required")).mockResolvedValue({ ok: true });
    const api = outApi({ getSite: vi.fn(() => new Promise(() => {})), register });
    at("/register");
    mount(api);
    await screen.findByRole("button", { name: "注册" });
    expect(screen.queryByRole("checkbox")).toBeNull();
    for (const [label, value] of Object.entries({ 邀请码: "inv-1", 邮箱: "ann@x.com", 密码: "0123456789", 昵称: "小安", 账号名: "ann_1" })) typeInto(label, value);
    submit("注册");
    await screen.findByText("请先勾选下面两项，再注册。");
    expect(screen.getByRole("checkbox", { name: ADULT_LABEL })).toBeTruthy();
    expect(screen.getByLabelText("邮箱").value).toBe("ann@x.com");
    expect(screen.getByLabelText("账号名").value).toBe("ann_1");
    // Sent again without them: the boxes say what they need, and nothing is sent.
    submit("注册");
    await screen.findByText(ADULT_MISSING);
    expect(register).toHaveBeenCalledTimes(1);
    tickAcceptance();
    submit("注册");
    await screen.findByText(/已向 ann@x.com 发送了一封验证邮件/);
    expect(register).toHaveBeenLastCalledWith({ inviteCode: "inv-1", email: "ann@x.com", password: "0123456789", displayName: "小安", handle: "ann_1", ...ACCEPTANCE });
  });

  it("shows no boxes while it is not yet known whether the site requires them", async () => {
    at("/register");
    mount(outApi({ getSite: vi.fn(() => new Promise(() => {})) }));
    await screen.findByRole("button", { name: "注册" });
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("an account that has accepted nothing goes straight to the app: no question", async () => {
    mount(fakeApi({ getMe: vi.fn(async () => ({ ...ANN, termsRequired: false, termsAccepted: false })) }));
    await screen.findByTestId("app");
    expect(screen.queryByRole("heading", { name: "请确认条款" })).toBeNull();
    // (The layer starts in an effect, which may run a moment after the app is on screen: `closeWith4001`.)
    await waitFor(() => expect(layers[0].start).toHaveBeenCalledTimes(1));
  });

  it("a site that requires them says so, and the boxes are there", async () => {
    at("/register");
    mount(outApi({ getSite: vi.fn(async () => ({ mailDelivered: false, termsRequired: true })) }));
    expect(await screen.findByRole("checkbox", { name: ADULT_LABEL })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: AGREE_LABEL })).toBeTruthy();
  });
});
describe("an account asked to accept again (GET /api/me termsAccepted false)", () => {
  const NOT_ACCEPTED = { ...ANN, termsAccepted: false };
  const GATE = "请确认条款";
  async function gate(over = {}) {
    const api = fakeApi({ getMe: vi.fn(async () => NOT_ACCEPTED), acceptTerms: vi.fn(async () => ({ termsAccepted: true })), ...over });
    mount(api);
    await screen.findByRole("heading", { name: GATE });
    return api;
  }

  it("is asked before anything else: no app, no data layer, with the same two boxes and the three links", async () => {
    at("/chat/00000000-0000-4000-8000-0000000000c1");
    await gate();
    expect(screen.queryByTestId("app")).toBeNull();
    expect(layers[0].start).not.toHaveBeenCalled();
    expect(screen.getByRole("checkbox", { name: ADULT_LABEL })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: AGREE_LABEL })).toBeTruthy();
    expectLegalLinks();
    // The page asked for stays the address, to open once accepted.
    expect(place()).toBe("/chat/00000000-0000-4000-8000-0000000000c1");
  });

  it("sends nothing until both are ticked; then records them and opens the app", async () => {
    const api = await gate();
    submit("同意并继续");
    await screen.findByText(ADULT_MISSING);
    expect(screen.getByText(AGREE_MISSING)).toBeTruthy();
    expect(api.acceptTerms).not.toHaveBeenCalled();
    tickAcceptance();
    submit("同意并继续");
    await screen.findByTestId("app");
    expect(api.acceptTerms).toHaveBeenCalledWith(ACCEPTANCE);
    await waitFor(() => expect(layers[0].start).toHaveBeenCalledTimes(1));
  });

  it("a refusal is shown on the form and the app stays closed", async () => {
    await gate({ acceptTerms: vi.fn(async () => Promise.reject(new ApiError(409, "terms_outdated"))) });
    tickAcceptance();
    submit("同意并继续");
    await screen.findByText("条款刚刚更新了，请刷新页面后再试。");
    expect(screen.queryByTestId("app")).toBeNull();
  });

  it("whoever does not want to accept can sign out from there", async () => {
    const api = await gate();
    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
    await screen.findByRole("button", { name: "登录" });
    expect(api.signOut).toHaveBeenCalledTimes(1);
    expect(place()).toBe("/signin");
  });

  it("signing in to such an account asks first, then opens the page that was asked for", async () => {
    const api = fakeApi({
      getMe: vi.fn().mockRejectedValueOnce(SIGNED_OUT()).mockResolvedValue(NOT_ACCEPTED),
      acceptTerms: vi.fn(async () => ({ termsAccepted: true })),
    });
    at("/chat/00000000-0000-4000-8000-0000000000c2");
    mount(api);
    await screen.findByRole("button", { name: "登录" });
    typeInto("邮箱", "ann@x.com");
    typeInto("密码", "correct horse");
    submit("登录");
    await screen.findByRole("heading", { name: GATE });
    tickAcceptance();
    submit("同意并继续");
    await screen.findByTestId("app");
    expect(place()).toBe("/chat/00000000-0000-4000-8000-0000000000c2");
  });
});

describe("verification landing", () => {
  it("/verify without an error is the success page with a sign-in button, and keeps the address clean", async () => {
    at("/verify");
    mount(outApi());
    await screen.findByText("邮箱已验证，现在可以登录了。");
    expect(place()).toBe("/verify");
    fireEvent.click(screen.getByRole("link", { name: "去登录" }));
    await screen.findByRole("button", { name: "登录" });
    expect(place()).toBe("/signin");
  });

  it("/verify without an error, for a signed-in visitor, goes to the app", async () => {
    at("/verify");
    mount(fakeApi());
    await screen.findByTestId("app");
    expect(place()).toBe("/");
  });

  it("/?error=TOKEN_EXPIRED (where the service redirects a bad link) shows the failure and moves to /verify", async () => {
    at("/?error=TOKEN_EXPIRED");
    mount(outApi());
    const text = "验证链接已过期。请直接登录，我们会重新发送一封验证邮件。";
    await screen.findByText(text);
    await waitFor(() => expect(place()).toBe("/verify"));
    expect(screen.getByText(text)).toBeTruthy();
  });

  it("/verify?error=INVALID_TOKEN shows the shared failure text", async () => {
    at("/verify?error=INVALID_TOKEN");
    mount(outApi());
    await screen.findByText(/验证链接无效或已被使用/);
  });
});

describe("what every account form's fields declare to the keyboard and to AutoFill", () => {
  // `username` made iOS withhold third-party keyboards on the e-mail field (WebKit reports it as a credential field): the e-mail fields say `email`.
  const SCREENS = [
    ["/signin", "登录", [["email", "email", "email", "email"], ["password", "password", "current-password", null]]],
    ["/forgot", "发送重置邮件", [["email", "email", "email", "email"]]],
    ["/register", "注册", [["inviteCode", "text", "off", null], ["email", "email", "email", "email"], ["password", "password", "new-password", null], ["displayName", "text", "nickname", null], ["handle", "text", "off", null]]],
    ["/reset-password?token=t0", "重置密码", [["password", "password", "new-password", null]]],
  ];
  for (const [path, button, expected] of SCREENS) {
    it(`${path}: type, autocomplete and inputmode of each field`, async () => {
      at(path);
      mount(outApi());
      await screen.findByRole("button", { name: button });
      const inputs = [...document.querySelectorAll("form input:not([type=checkbox])")];
      expect(inputs.map((el) => [el.name, el.type, el.getAttribute("autocomplete"), el.getAttribute("inputmode")])).toEqual(expected);
      for (const el of inputs) expect(el.getAttribute("autocomplete")).not.toBe("username");
    });
  }
});

describe("forgot and reset password", () => {
  it("forgot: validates the e-mail, then always shows the same confirmation", async () => {
    const api = outApi();
    at("/forgot");
    mount(api);
    await screen.findByRole("button", { name: "发送重置邮件" });
    submit("发送重置邮件");
    await screen.findByText("请输入邮箱");
    typeInto("邮箱", "nobody@x.com");
    submit("发送重置邮件");
    await screen.findByText("如果这个邮箱已注册，我们会发送一封重置密码的邮件。链接 1 小时内有效。");
    expect(api.requestPasswordReset).toHaveBeenCalledWith({ email: "nobody@x.com" });
  });

  it("forgot: on a site that sends no mail the confirmation says so, the same for every address", async () => {
    const api = outApi({ getSite: vi.fn(async () => ({ mailDelivered: false })) });
    at("/forgot");
    mount(api);
    await screen.findByRole("button", { name: "发送重置邮件" });
    typeInto("邮箱", "nobody@x.com");
    submit("发送重置邮件");
    // A reset asks the administrator for a reset link, not a verification link (the forgot form's lead says the same).
    await screen.findByText("这个站点不发送邮件。请向管理员索取重置链接。");
    expect(document.body.textContent).not.toMatch(/我们会发送|查收|验证链接/);
    expect(api.requestPasswordReset).toHaveBeenCalledWith({ email: "nobody@x.com" });
  });

  it("on a site that sends no mail: sign-in's not-verified error, a bad verification link and the forgot form's lead promise no mail", async () => {
    const noMail = { getSite: vi.fn(async () => ({ mailDelivered: false })) };
    at("/signin");
    mount(outApi({ ...noMail, signIn: vi.fn(async () => Promise.reject(new ApiError(403, "email_not_verified"))) }));
    await screen.findByRole("button", { name: "登录" });
    typeInto("邮箱", "ann@x.com");
    typeInto("密码", "0123456789");
    submit("登录");
    await screen.findByText("这个邮箱还没有验证。这个站点不发送邮件，请向管理员索取验证链接。");
    cleanup();
    at("/verify?error=TOKEN_EXPIRED");
    mount(outApi(noMail));
    await screen.findByText("验证链接已过期或无效。这个站点不发送邮件，请向管理员索取新的验证链接。");
    expect(document.body.textContent).not.toContain("重新发送");
    cleanup();
    at("/forgot");
    mount(outApi(noMail));
    await screen.findByText("输入注册时用的邮箱。这个站点不发送邮件，提交后请向管理员索取重置链接。");
  });

  it("forgot: rate_limited is shown instead", async () => {
    at("/forgot");
    mount(outApi({ requestPasswordReset: vi.fn(async () => Promise.reject(new ApiError(429, "rate_limited"))) }));
    await screen.findByRole("button", { name: "发送重置邮件" });
    typeInto("邮箱", "a@x.com");
    submit("发送重置邮件");
    await screen.findByText("操作太频繁了，请稍等一分钟再试。");
  });

  it("reset: the token is out of the address bar before any request, and is sent with the new password", async () => {
    let addressWhenMeAsked = null;
    const api = outApi({
      getMe: vi.fn(async () => {
        addressWhenMeAsked = place();
        throw SIGNED_OUT();
      }),
    });
    at("/reset-password?token=tok-123");
    mount(api);
    await screen.findByRole("button", { name: "重置密码" });
    expect(addressWhenMeAsked).toBe("/reset-password");
    expect(place()).toBe("/reset-password");
    expect(screen.getByLabelText("新密码").getAttribute("autocomplete")).toBe("new-password");

    typeInto("新密码", "short");
    submit("重置密码");
    await screen.findByText("密码至少 10 位");
    expect(api.resetPassword).not.toHaveBeenCalled();

    typeInto("新密码", "a-long-new-password");
    submit("重置密码");
    await screen.findByText("密码已重置，请用新密码登录。");
    expect(api.resetPassword).toHaveBeenCalledWith({ newPassword: "a-long-new-password", token: "tok-123" });
    expect(place()).toBe("/reset-password");
  });

  it("reset: invalid_token from the service is shown on the form", async () => {
    at("/reset-password?token=spent");
    mount(outApi({ resetPassword: vi.fn(async () => Promise.reject(new ApiError(400, "invalid_token"))) }));
    await screen.findByRole("button", { name: "重置密码" });
    typeInto("新密码", "a-long-new-password");
    submit("重置密码");
    await screen.findByText("链接无效或已过期，请重新申请。");
  });

  it("reset: with no token there is no form, only a way to ask again", async () => {
    at("/reset-password");
    mount(outApi());
    await screen.findByText("链接无效或已过期，请重新申请。");
    expect(screen.queryByLabelText("新密码")).toBeNull();
    expect(screen.getByRole("link", { name: "重新申请" }).getAttribute("href")).toBe("/forgot");
  });
});

describe("session lifecycle", () => {
  function SignOutProbe() {
    const session = useSession();
    return <button type="button" onClick={() => session.signOut()}>probe-sign-out</button>;
  }
  const stubFetch = (status, error) => vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error }), { status }));

  it("signing out calls the service, stops the data layer and shows /signin", async () => {
    const api = fakeApi();
    mount(api, () => <SignOutProbe />);
    fireEvent.click(await screen.findByText("probe-sign-out"));
    await screen.findByRole("button", { name: "登录" });
    expect(api.signOut).toHaveBeenCalledTimes(1);
    expect(layers[0].stop).toHaveBeenCalledTimes(1);
    expect(place()).toBe("/signin");
    expect(screen.queryByText(EXPIRED_NOTICE)).toBeNull();
  });

  it("sign-out forgets what was typed in a form (a provider's API key) at once: no draft, no reference, until the next shell", async () => {
    saveDraft("new", { f: { name: "x" }, models: [], keyText: "sk-secret-1234567890" });
    const api = fakeApi();
    mount(api, () => <SignOutProbe />);
    fireEvent.click(await screen.findByText("probe-sign-out"));
    await screen.findByRole("button", { name: "登录" });
    expect(draftKeys()).toEqual([]);
    expect(peekDraft("new")).toBeNull();
  });

  it("a sign-out does not hand this account's page to whoever signs in next", async () => {
    at("/chat/00000000-0000-4000-8000-0000000000c1");
    const api = fakeApi();
    mount(api, () => <SignOutProbe />);
    fireEvent.click(await screen.findByText("probe-sign-out"));
    await screen.findByRole("button", { name: "登录" });
    expect(takeReturn()).toBeNull();
  });

  it("the 4001 close the service sends on sign-out, arriving before the answer, is not an expiry", async () => {
    let answer;
    const api = fakeApi({ signOut: vi.fn(() => new Promise((resolve) => (answer = resolve))) });
    mount(api, () => <SignOutProbe />);
    fireEvent.click(await screen.findByText("probe-sign-out"));
    await waitFor(() => expect(api.signOut).toHaveBeenCalled());
    act(() => layers[0].closeWith4001());
    await act(async () => answer({ success: true }));
    await screen.findByRole("button", { name: "登录" });
    expect(screen.queryByText(EXPIRED_NOTICE)).toBeNull();
    expect(layers[0].stop).toHaveBeenCalledTimes(1);
  });

  it("a failed sign-out clears the flag: a later 4001 is an expiry again", async () => {
    const api = fakeApi({ signOut: vi.fn(async () => Promise.reject(new ApiError(0, "network_error"))) });
    mount(api, () => <SignOutProbe />);
    fireEvent.click(await screen.findByText("probe-sign-out"));
    await waitFor(() => expect(api.signOut).toHaveBeenCalled());
    await act(async () => {});
    act(() => layers[0].closeWith4001());
    await screen.findByText(EXPIRED_NOTICE);
  });

  it("a 401 answered after the session ended and a new one began does not end the new one", async () => {
    const getMe = vi.fn().mockResolvedValueOnce(ANN);
    mount(fakeApi({ getMe }));
    await screen.findByTestId("app");
    let release;
    vi.stubGlobal("fetch", () => new Promise((resolve) => (release = () => resolve(new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 })))));
    const stale = request("GET", "/api/sync").catch(() => {});
    await closeWith4001(layers[0]);
    await screen.findByRole("button", { name: "登录" });
    getMe.mockResolvedValueOnce(ANN);
    typeInto("邮箱", "ann@x.com");
    typeInto("密码", "correct horse");
    submit("登录");
    await screen.findByTestId("app");
    await act(async () => {
      release();
      await stale;
    });
    expect(screen.getByTestId("app")).toBeTruthy();
    expect(layers[0].stop).toHaveBeenCalledTimes(1);
  });

  it("the sign-out button in Settings does the same", async () => {
    const api = fakeApi();
    mount(api, () => (
      <StoreProvider initialState={emptyState(me)}>
        <SettingsMain />
      </StoreProvider>
    ));
    fireEvent.click(await screen.findByRole("button", { name: "退出登录" }));
    await screen.findByRole("button", { name: "登录" });
    expect(api.signOut).toHaveBeenCalledTimes(1);
    expect(layers[0].stop).toHaveBeenCalledTimes(1);
  });

  it("on a phone the Settings list itself has 退出登录 (the profile page is not where one looks); a wide screen has it on the profile page only", async () => {
    const api = fakeApi();
    window.matchMedia = (query) => ({ matches: query === PHONE_QUERY, media: query, addEventListener() {}, removeEventListener() {} });
    try {
      mount(api, () => (
        <StoreProvider initialState={emptyState(me)}>
          <SettingsList />
        </StoreProvider>
      ));
      fireEvent.click(await screen.findByRole("button", { name: "退出登录" }));
      await screen.findByRole("button", { name: "登录" });
      expect(api.signOut).toHaveBeenCalledTimes(1);
    } finally {
      delete window.matchMedia;
    }
    cleanup();
    mount(fakeApi(), () => (
      <StoreProvider initialState={emptyState(me)}>
        <SettingsList />
      </StoreProvider>
    ));
    await screen.findByText("设置");
    expect(screen.queryByRole("button", { name: "退出登录" })).toBeNull();
  });

  it("Settings shows no sign-out button outside the sign-in gate", () => {
    render(
      <StoreProvider initialState={emptyState(me)}>
        <SettingsMain />
      </StoreProvider>,
    );
    expect(screen.queryByRole("button", { name: "退出登录" })).toBeNull();
  });

  it("a failed sign-out request (network) keeps the session and the data layer", async () => {
    const api = fakeApi({ signOut: vi.fn(async () => Promise.reject(new ApiError(0, "network_error"))) });
    mount(api, () => <SignOutProbe />);
    fireEvent.click(await screen.findByText("probe-sign-out"));
    await waitFor(() => expect(api.signOut).toHaveBeenCalled());
    expect(screen.getByText("probe-sign-out")).toBeTruthy();
    expect(layers[0].stop).not.toHaveBeenCalled();
  });

  it("a 401 from a non-auth request stops the layer and shows /signin once, with a notice", async () => {
    mount(fakeApi());
    await screen.findByTestId("app");
    stubFetch(401, "unauthenticated");
    await act(async () => {
      await request("GET", "/api/sync").catch(() => {});
    });
    await screen.findByRole("button", { name: "登录" });
    expect(layers[0].stop).toHaveBeenCalledTimes(1);
    expect(place()).toBe("/signin");
    expect(screen.getByText(EXPIRED_NOTICE)).toBeTruthy();
  });

  it("a 403 terms_required from any request (a tab open when a new version came in) stops the app and asks; accepting brings it back", async () => {
    const api = fakeApi({ acceptTerms: vi.fn(async () => ({ termsAccepted: true })) });
    mount(api);
    await screen.findByTestId("app");
    at("/chat/00000000-0000-4000-8000-0000000000c3");
    stubFetch(403, "terms_required");
    await act(async () => {
      await request("POST", "/api/ws-ticket").catch(() => {});
    });
    await screen.findByRole("heading", { name: "请确认条款" });
    expect(screen.queryByTestId("app")).toBeNull();
    expect(layers[0].stop).toHaveBeenCalledTimes(1);
    // Still signed in, on the same page: nothing about an expired session.
    expect(screen.queryByText(EXPIRED_NOTICE)).toBeNull();
    expect(place()).toBe("/chat/00000000-0000-4000-8000-0000000000c3");
    tickAcceptance();
    submit("同意并继续");
    await screen.findByTestId("app");
    expect(api.acceptTerms).toHaveBeenCalledWith(ACCEPTANCE);
    expect(layers[0].start).toHaveBeenCalledTimes(2);
  });

  it("a 403 terms_required of a session that has already ended is not a question", async () => {
    mount(fakeApi());
    await screen.findByTestId("app");
    stubFetch(403, "terms_required");
    let pending;
    await act(async () => {
      pending = request("GET", "/api/sync");
      bumpSessionEpoch();
      await pending.catch(() => {});
    });
    expect(screen.getByTestId("app")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "请确认条款" })).toBeNull();
  });

  it("a wrong password (401 from /api/auth/*) does not end anything", async () => {
    at("/signin");
    mount(outApi());
    await screen.findByRole("button", { name: "登录" });
    stubFetch(401, "invalid_email_or_password");
    await act(async () => {
      await request("POST", "/api/auth/sign-in/email", {}).catch(() => {});
    });
    expect(screen.queryByText(EXPIRED_NOTICE)).toBeNull();
    expect(screen.getByRole("button", { name: "登录" })).toBeTruthy();
  });

  it("a socket close 4001 (the layer's onSignedOut) stops the layer and shows /signin with the notice", async () => {
    mount(fakeApi());
    await screen.findByTestId("app");
    await closeWith4001(layers[0]);
    await screen.findByRole("button", { name: "登录" });
    expect(layers[0].stop).toHaveBeenCalledTimes(1);
    expect(place()).toBe("/signin");
    expect(screen.getByText(EXPIRED_NOTICE)).toBeTruthy();
  });

  it("a sync for another account than the layer runs for (T2 fix 2, R4): that account gets a layer of its own — the app mounted again, nothing typed in a form kept", async () => {
    mount(fakeApi());
    await screen.findByTestId("app");
    await waitFor(() => expect(layers[0].start).toHaveBeenCalled());
    // The layer runs for the account the gate confirmed.
    expect(layers[0].start.mock.calls[0][0]).toMatchObject({ accountId: ANN.id });
    saveDraft("provider:new", { apiKey: "sk-of-ann" });
    act(() => layers[0].answeredFor(BO));
    await waitFor(() => expect(screen.getByTestId("app").dataset.key).toBe("1"));
    expect(layers[0].stop).toHaveBeenCalledTimes(1);
    expect(layers).toHaveLength(2);
    expect(layers[1].start.mock.calls[0][0]).toMatchObject({ accountId: BO.id });
    expect(peekDraft("provider:new")).toBeNull();
  });

  /** AuthRoot over real data layers (fake transports whose sync answers for `me`), with `getMe` its reading of who is signed in. */
  async function withRealLayers(getMe) {
    const made = [];
    const createReal = () => {
      const layer = createDataLayer({ transport: fakeTransport({ sync: () => ({ ...syncOf([]), me: ANN }) }), api: {}, timers: fakeTimers(), random: () => 0.5 });
      made.push(layer);
      return layer;
    };
    render(
      <AuthRoot api={fakeApi({ getMe })} createLayer={createReal}>
        {(layer, key) => <div data-testid="app" data-key={key} />}
      </AuthRoot>,
    );
    await screen.findByTestId("app");
    await act(async () => {
      await settle();
    });
    expect(made[0].getSnapshot().connection).toBe("live");
    return made;
  }
  /** One of the layer's requests, refused by the service for the account it names (409 account_changed): it never settles. */
  function refusedForTheAccount() {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "account_changed" }), { status: 409, headers: { "content-type": "application/json" } })));
    request("GET", "/api/agents").catch(() => {});
  }

  it("a retired layer is never used again: 409, the gate shows it is loading, who is signed in reads 401, the same account signs in again — a fresh layer, live (T2 fix 4, U1)", async () => {
    const reading = deferred();
    const getMe = vi.fn().mockResolvedValueOnce(ANN).mockReturnValueOnce(reading.promise).mockResolvedValueOnce(ANN);
    const made = await withRealLayers(getMe);
    try {
      refusedForTheAccount();
      // Retired: not the old account's screen any more, but the gate's loading.
      await waitFor(() => expect(screen.getByRole("status").textContent).toBe("正在加载…"));
      expect(screen.queryByTestId("app")).toBeNull();
      await act(async () => reading.reject(new ApiError(401, "unauthenticated")));
      await screen.findByRole("button", { name: "登录" });
      typeInto("邮箱", ANN.email);
      typeInto("密码", "correct horse");
      submit("登录");
      await screen.findByTestId("app");
      await act(async () => {
        await settle();
      });
      expect(made).toHaveLength(2);
      expect(made[1].getSnapshot().connection).toBe("live");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a retired layer is never used again: 409, who is signed in cannot be read, 重试 — the same account, a fresh layer, live (T2 fix 4, U1)", async () => {
    const getMe = vi.fn().mockResolvedValueOnce(ANN).mockRejectedValueOnce(new ApiError(0, "network_error")).mockResolvedValueOnce(ANN);
    const made = await withRealLayers(getMe);
    try {
      refusedForTheAccount();
      fireEvent.click(await screen.findByRole("button", { name: "重试" }));
      await screen.findByTestId("app");
      await act(async () => {
        await settle();
      });
      expect(made).toHaveLength(2);
      expect(made[1].getSnapshot().connection).toBe("live");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("the terms form is the session's: a 409 account_changed on its submit, then another account confirmed with the terms still to accept, gives that account a fresh form (T2 fix 4, U2)", async () => {
    const NOT_YET = { termsAccepted: false, termsRequired: true };
    const getMe = vi.fn().mockResolvedValueOnce({ ...ANN, ...NOT_YET }).mockResolvedValueOnce({ ...BO, ...NOT_YET });
    // The acceptance goes out as ann's, while the browser now sends bo's cookie: the service refuses it for the account it names.
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "account_changed" }), { status: 409, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      mount(fakeApi({ getMe, acceptTerms: (body) => request("POST", "/api/me/terms", body) }));
      expect(await screen.findByRole("heading", { name: "请确认条款" })).toBeTruthy();
      tickAcceptance();
      submit("同意并继续");
      await waitFor(() => expect(getMe).toHaveBeenCalledTimes(2));
      // bo's own form: nothing ticked, nothing being sent.
      const button = await screen.findByRole("button", { name: "同意并继续" });
      expect(button.disabled).toBe(false);
      expect(screen.getByRole("checkbox", { name: ADULT_LABEL }).checked).toBe(false);
      expect(screen.getByRole("checkbox", { name: AGREE_LABEL }).checked).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("an answer for another account anywhere (409 account_changed: the memory settings' GET /api/me among them) retires the layer at once and confirms who is signed in: their own layer, the app mounted again (T2 fix 3, S1)", async () => {
    const getMe = vi.fn().mockResolvedValueOnce(ANN).mockResolvedValueOnce(BO);
    mount(fakeApi({ getMe }));
    await screen.findByTestId("app");
    await waitFor(() => expect(layers[0].start).toHaveBeenCalled());
    // The layer's own request, as the browser now sends someone else's cookie: the service refuses it for the account it names.
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "account_changed" }), { status: 409, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      let settled = false;
      request("GET", "/api/me").then(
        () => (settled = true),
        () => (settled = true),
      );
      await waitFor(() => expect(screen.getByTestId("app").dataset.key).toBe("1"));
      expect(fetchMock.mock.calls[0][1].headers["X-Account"]).toBe(ANN.id);
      // Retired before who is signed in was asked (nothing of it is applied, nobody is signed out by it from then on).
      expect(layers[0].retire.mock.invocationCallOrder[0]).toBeLessThan(getMe.mock.invocationCallOrder[1]);
      expect(getMe).toHaveBeenLastCalledWith({ anyAccount: true });
      expect(layers[1].start.mock.calls[0][0]).toMatchObject({ accountId: BO.id });
      expect(settled).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("with real data layers: A's layer hears a sync for B, B gets a layer of its own whose catalogue is asked for, and A's late 401 signs nobody out (T2 fix 3, S1)", async () => {
    let as = ANN.id;
    const transports = [];
    const clocks = [];
    const pendingMe = deferred();
    const realLayer = () => {
      const t = fakeTransport({ sync: () => ({ ...syncOf([]), me: as === ANN.id ? ANN : BO }) });
      const timers = fakeTimers();
      transports.push(t);
      clocks.push(timers);
      return createDataLayer({ transport: t, api: { getMe: () => pendingMe.promise }, timers, random: () => 0.5 });
    };
    const made = [];
    render(
      <AuthRoot api={fakeApi()} createLayer={() => (made.push(realLayer()), made.at(-1))}>
        {(layer, key) => <div data-testid="app" data-key={key} />}
      </AuthRoot>,
    );
    await screen.findByTestId("app");
    await act(async () => {
      await settle();
    });
    expect(made[0].getSnapshot().connection).toBe("live");
    let settings;
    act(() => {
      settings = made[0].actions.loadMemorySettings();
    });
    as = BO.id;
    await act(async () => {
      transports[0].socket.drop(1006);
      clocks[0].advance(clocks[0].delays()[0]);
      await settle();
    });
    await waitFor(() => expect(screen.getByTestId("app").dataset.key).toBe("1"));
    await act(async () => {
      await settle();
    });
    expect(transports[1].agentLog).toContain("models");
    await act(async () => {
      pendingMe.reject(new ApiError(401, "unauthenticated"));
      await settings;
      await settle();
    });
    expect(screen.getByTestId("app").dataset.key).toBe("1");
    expect(made[1].getSnapshot().connection).toBe("live");
  });

  it("the same account signing in again keeps the data layer (its drafts); another account gets a fresh one", async () => {

    const getMe = vi.fn().mockResolvedValueOnce(ANN);
    mount(fakeApi({ getMe }));
    await screen.findByTestId("app");
    expect(screen.getByTestId("app").dataset.key).toBe("0");

    const signInAs = async (who) => {
      await closeWith4001(layers[layers.length - 1]);
      await screen.findByRole("button", { name: "登录" });
      getMe.mockResolvedValueOnce(who);
      typeInto("邮箱", who.email);
      typeInto("密码", "correct horse");
      submit("登录");
      await screen.findByTestId("app");
    };

    await signInAs(ANN);
    expect(layers).toHaveLength(1);
    expect(layers[0].start).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("app").dataset.key).toBe("0");

    await signInAs(BO);
    expect(layers.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByTestId("app").dataset.key).toBe("1");
    expect(layers[0].stop).toHaveBeenCalledTimes(2);
    expect(layers[layers.length - 1].start).toHaveBeenCalledTimes(1);
  });
});

describe("a share link opened signed out (find-agent D3): its page after the sign-in, the sign-up and the terms", () => {
  const LINK = "/a/00000000-0000-4000-8000-0000000000b6";
  const signInApi = (over) => fakeApi({ getMe: vi.fn().mockRejectedValueOnce(SIGNED_OUT()).mockResolvedValue(ANN), ...over });
  const signIn = async () => {
    typeInto("邮箱", "ann@x.com");
    typeInto("密码", "correct horse");
    submit("登录");
    await screen.findByTestId("app");
  };
  /** A signed-out visit of the link: the sign-in page, the link kept. Then the tab is gone (a reload, or the mail opened another). */
  const visitedSignedOut = async () => {
    at(LINK);
    mount(outApi());
    await screen.findByRole("button", { name: "登录" });
    expect(place()).toBe("/signin");
    // (Kept where another tab of this browser finds it: the page of the verification mail is one.)
    expect(JSON.parse(localStorage.getItem(RETURN_KEY) ?? "null")?.path).toBe(LINK);
    cleanup();
  };
  afterEach(() => localStorage.clear());

  it("signed in from another tab (the sign-in page reloaded): the link's page", async () => {
    await visitedSignedOut();
    at("/signin");
    mount(signInApi());
    await screen.findByRole("button", { name: "登录" });
    await signIn();
    expect(place()).toBe(LINK);
  });

  it("after registering: the verification mail's page, 去登录, then the link's page", async () => {
    await visitedSignedOut();
    at("/verify");
    mount(signInApi());
    await screen.findByText("邮箱已验证，现在可以登录了。");
    fireEvent.click(screen.getByRole("link", { name: "去登录" }));
    await screen.findByRole("button", { name: "登录" });
    await signIn();
    expect(place()).toBe(LINK);
  });

  it("an account asked to accept the terms first: the question, then the link's page", async () => {
    await visitedSignedOut();
    at("/signin");
    mount(fakeApi({ getMe: vi.fn().mockRejectedValueOnce(SIGNED_OUT()).mockResolvedValue({ ...ANN, termsAccepted: false }), acceptTerms: vi.fn(async () => ({ termsAccepted: true })) }));
    await screen.findByRole("button", { name: "登录" });
    typeInto("邮箱", "ann@x.com");
    typeInto("密码", "correct horse");
    submit("登录");
    await screen.findByRole("heading", { name: "请确认条款" });
    tickAcceptance();
    submit("同意并继续");
    await screen.findByTestId("app");
    expect(place()).toBe(LINK);
  });

  it("taken once: the next sign-in is the list", async () => {
    await visitedSignedOut();
    at("/signin");
    mount(signInApi());
    await screen.findByRole("button", { name: "登录" });
    await signIn();
    cleanup();
    at("/signin");
    mount(signInApi());
    await screen.findByRole("button", { name: "登录" });
    await signIn();
    expect(place()).toBe("/");
  });

  it.each([
    ["another site", { path: "//evil.example/a/00000000-0000-4000-8000-0000000000b6", at: Date.now() }],
    ["a page that is not a share link", { path: "/settings/providers", at: Date.now() }],
    ["a link kept more than a day ago", { path: LINK, at: Date.now() - 25 * 60 * 60 * 1000 }],
    ["not what this page writes", "/a/00000000-0000-4000-8000-0000000000b6"],
  ])("what is kept is checked when it is read: %s is not followed", async (_label, stored) => {
    localStorage.setItem(RETURN_KEY, typeof stored === "string" ? stored : JSON.stringify(stored));
    at("/signin");
    mount(signInApi());
    await screen.findByRole("button", { name: "登录" });
    await signIn();
    expect(place()).toBe("/");
  });

  it("a sign-out keeps nothing of it", async () => {
    at(LINK);
    mount(fakeApi(), () => <SignOutProbe />);
    fireEvent.click(await screen.findByText("probe-sign-out"));
    await screen.findByRole("button", { name: "登录" });
    expect(localStorage.getItem(RETURN_KEY)).toBeNull();
    expect(takeReturn()).toBeNull();
  });

  function SignOutProbe() {
    const session = useSession();
    return <button type="button" onClick={() => session.signOut()}>probe-sign-out</button>;
  }
});
