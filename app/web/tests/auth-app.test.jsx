// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, configure, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiError, request, setUnauthenticatedHandler } from "../src/api/http.js";
import { AuthRoot, useSession } from "../src/auth/AuthRoot.jsx";
import { clearResetToken, takeReturn } from "../src/auth/router.js";
import { draftKeys, peekDraft, saveDraft } from "../src/data/drafts.js";
import { StoreProvider, emptyState } from "../src/data/store.jsx";
import { SettingsMain } from "../src/pages/Settings.jsx";

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
  return {
    start: vi.fn(),
    stop: vi.fn(),
    onSignedOut: (fn) => {
      handlers.add(fn);
      return () => handlers.delete(fn);
    },
    closeWith4001: () => [...handlers].forEach((fn) => fn()),
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
    ...over,
  };
}

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

  it("sets the right autocomplete attributes", async () => {
    await signedOutAt(signInApi());
    expect(screen.getByLabelText("邮箱").getAttribute("autocomplete")).toBe("username");
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
    expect(layers[0].start).toHaveBeenCalledTimes(1);
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
  const fill = (over = {}) => {
    const values = { 邀请码: "inv-1", 邮箱: "ann@x.com", 密码: "0123456789", 昵称: "小安", 账号名: "ann_1", ...over };
    for (const [label, value] of Object.entries(values)) typeInto(label, value);
  };
  async function open(api = outApi()) {
    at("/register");
    mount(api);
    await screen.findByRole("button", { name: "注册" });
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
    expect(api.register).toHaveBeenCalledWith({ inviteCode: "inv-1", email: "ann@x.com", password: "0123456789", displayName: "小安", handle: "ann_1" });
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
    const api = await open(outApi({ getSite: vi.fn(async () => ({ mailDelivered: false })) }));
    fill();
    submit("注册");
    await screen.findByText("这个站点不发送邮件。请向管理员索取验证链接。");
    expect(document.body.textContent).not.toMatch(/发送了一封|查收|垃圾邮件|重置链接/);
    expect(screen.getByRole("link", { name: "去登录" }).classList.contains("text-link")).toBe(true);
    expect(api.getSite).toHaveBeenCalledTimes(1);
  });

  it("on a site that sends mail the page is as it was", async () => {
    await open(outApi({ getSite: vi.fn(async () => ({ mailDelivered: true })) }));
    fill();
    submit("注册");
    await screen.findByText(/已向 ann@x.com 发送了一封验证邮件/);
    expect(screen.queryByText("这个站点不发送邮件。请向管理员索取验证链接。")).toBeNull();
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
    act(() => layers[0].closeWith4001());
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
    act(() => layers[0].closeWith4001());
    await screen.findByRole("button", { name: "登录" });
    expect(layers[0].stop).toHaveBeenCalledTimes(1);
    expect(place()).toBe("/signin");
    expect(screen.getByText(EXPIRED_NOTICE)).toBeTruthy();
  });

  it("the same account signing in again keeps the data layer (its drafts); another account gets a fresh one", async () => {
    const getMe = vi.fn().mockResolvedValueOnce(ANN);
    mount(fakeApi({ getMe }));
    await screen.findByTestId("app");
    expect(screen.getByTestId("app").dataset.key).toBe("0");

    const signInAs = async (who) => {
      act(() => layers[layers.length - 1].closeWith4001());
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
