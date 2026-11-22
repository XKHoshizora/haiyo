// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bumpSessionEpoch, request, setUnauthenticatedHandler } from "../src/api/http.js";
import { FALLBACK_MESSAGE, VERIFY_FALLBACK, fieldOf, messageFor, verifyMessage } from "../src/auth/errors.js";
import { captureResetToken, clearResetToken, decide, parseRoute, takeResetToken } from "../src/auth/router.js";
import * as v from "../src/auth/validation.js";

describe("field rules", () => {
  it("email: required, one @, a dot after it, at most 254, surrounding spaces ignored", () => {
    expect(v.email("")).toBe("请输入邮箱");
    expect(v.email("   ")).toBe("请输入邮箱");
    expect(v.email("ann")).toBe("邮箱格式不正确");
    expect(v.email("ann@host")).toBe("邮箱格式不正确");
    expect(v.email("a b@host.com")).toBe("邮箱格式不正确");
    expect(v.email(`${"a".repeat(250)}@x.com`)).toBe("邮箱格式不正确");
    expect(v.email("  ann@host.com ")).toBe("");
  });

  it("new password: 10 to 128 characters, spaces count", () => {
    expect(v.newPassword("a".repeat(9))).toBe("密码至少 10 位");
    expect(v.newPassword("a".repeat(10))).toBe("");
    expect(v.newPassword("a".repeat(128))).toBe("");
    expect(v.newPassword("a".repeat(129))).toBe("密码最多 128 位");
    expect(v.newPassword("          ")).toBe("");
  });

  it("sign-in password: only required (the service judges it)", () => {
    expect(v.currentPassword("")).toBe("请输入密码");
    expect(v.currentPassword("x")).toBe("");
  });

  it("invite code: required, at most 100", () => {
    expect(v.inviteCode(" ")).toBe("请输入邀请码");
    expect(v.inviteCode("a".repeat(101))).toBe("邀请码太长了");
    expect(v.inviteCode("abc")).toBe("");
  });

  it("display name: 1 to 40 characters after trimming, one line", () => {
    expect(v.displayName("  ")).toBe("请输入昵称");
    expect(v.displayName("你".repeat(41))).toBe("昵称最多 40 个字");
    expect(v.displayName("你".repeat(40))).toBe("");
    expect(v.displayName("a\nb")).toBe("昵称只能是一行");
    // code points, not UTF-16 units; invisible format characters do not count and do not make a name
    expect(v.displayName("😀".repeat(40))).toBe("");
    expect(v.displayName("😀".repeat(41))).toBe("昵称最多 40 个字");
    expect(v.displayName("\u200b\u200d\ufeff")).toBe("昵称需要包含看得见的文字");
    expect(v.displayName(`${"a".repeat(40)}\u200b`)).toBe("");
    expect(v.displayName(" 小安 ")).toBe("");
  });

  it("group title: the display-name rule with 60 — format characters but the joiners removed, something visible, one line", () => {
    expect(v.groupTitle("  ")).toBe("请输入群名称");
    // Nothing but invisible characters: a blank group name for everyone else.
    for (const invisible of ["\u200B", "\u200B\u2060\uFEFF", "\u202E", "\u200D\u200C", " \u00AD "]) {
      expect(v.groupTitle(invisible), JSON.stringify(invisible)).toBe("群名称需要包含看得见的文字");
    }
    // A bidi override is allowed (the service removes it); length is counted without it.
    expect(v.groupTitle("safe\u202Eelif.exe")).toBe("");
    expect(v.groupTitle(`${"字".repeat(60)}\u200B\u202E`)).toBe("");
    expect(v.groupTitle("字".repeat(61))).toBe("群名称最多 60 个字");
    expect(v.groupTitle("a\nb")).toBe("群名称只能是一行");
    expect(v.groupTitle("a\u2028b")).toBe("群名称只能是一行");
    expect(v.groupTitle("👩\u200D💻 小组")).toBe("");
    expect(v.groupTitle("😀".repeat(60))).toBe("");
  });

  it("message text: stored without bidi overrides and isolates, trimmed; it needs something visible", () => {
    expect(v.messageText("  safe\u202Eelif.exe\u2066 ")).toBe("safeelif.exe");
    expect(v.messageText("\u202A\u202B\u202C\u202D\u2067\u2068\u2069")).toBe("");
    expect(v.messageText("👩\u200D💻\u200B")).toBe("👩\u200D💻\u200B"); // only bidi controls go
    expect(v.hasVisibleText("\u200B\u2060\uFEFF")).toBe(false);
    expect(v.hasVisibleText(" \n\t　")).toBe(false);
    expect(v.hasVisibleText("\u200Ba")).toBe(true);
    expect(v.hasVisibleText("。")).toBe(true);
  });

  // Characters that show nothing although they are not format characters (Hangul fillers, the Braille blank,
  // variation selectors without a base, the combining grapheme joiner), and controls.
  const BLANKS = ["\u{3164}", "\u{115F}\u{1160}", "\u{FFA0}", "\u{2800}", "\u{FE0F}", "\u{E0100}", "\u{34F}", "\u{3164} \u{2800}"];
  const LIVELY = ["\u{1F469}\u{200D}\u{1F4BB}", "1\u{FE0F}\u{20E3}", "\u{1F1EF}\u{1F1F5}", "\u{1F44D}\u{1F3FD}", "\u{2764}\u{FE0F}", "\u{5E9}\u{5DC}\u{5D5}\u{5DD}"];

  it("nothing visible also means characters that show nothing; emoji and right-to-left text are visible", () => {
    for (const blank of BLANKS) {
      expect([blank, v.hasVisibleText(blank)]).toEqual([blank, false]);
      expect([blank, v.groupTitle(blank)]).toEqual([blank, "群名称需要包含看得见的文字"]);
      expect([blank, v.displayName(blank)]).toEqual([blank, "昵称需要包含看得见的文字"]);
    }
    expect(v.hasVisibleText("\u{7}\u{1F}")).toBe(false);
    for (const lively of LIVELY) {
      expect([lively, v.hasVisibleText(lively), v.groupTitle(lively), v.displayName(lively)]).toEqual([lively, true, "", ""]);
    }
  });

  it("message text: controls other than tab, line feed and carriage return are dropped, as the service would refuse them", () => {
    expect(v.messageText("a\u{7}b\tc\r\nd\u{85}e\u{0}")).toBe("ab\tc\r\nde");
    expect(v.displayName("bad\u{7}name")).toBe("昵称只能是一行");
  });

  it("handle: ^[a-z0-9_]{3,24}$", () => {
    expect(v.handle("")).toBe("请输入账号名");
    for (const bad of ["ab", "a".repeat(25), "Ann_1", "ann-1", "小安小安", "ann 1"]) {
      expect(v.handle(bad), bad).toBe("账号名为 3 到 24 位小写字母、数字或下划线");
    }
    for (const good of ["abc", "a_1", "a".repeat(24), "_x_"]) expect(v.handle(good), good).toBe("");
  });

  it("validate returns the failing fields in the order of the rules", () => {
    const errors = v.validate({ email: "x", password: "" }, { email: v.email, password: v.currentPassword });
    expect(Object.keys(errors)).toEqual(["email", "password"]);
    expect(v.validate({ email: "a@b.cc" }, { email: v.email })).toEqual({});
  });
});

describe("error codes", () => {
  const table = {
    invalid_email_or_password: "邮箱或密码不对，请再试一次。",
    email_not_verified: "这个邮箱还没有验证。我们刚刚又发了一封验证邮件，请查收后再登录。",
    invalid_invite: "邀请码无效、已过期或已用完，请向邀请你的人确认。",
    handle_taken: "这个账号名已被占用，换一个试试。",
    rate_limited: "操作太频繁了，请稍等一分钟再试。",
    invalid_token: "链接无效或已过期，请重新申请。",
    invalid_email: "邮箱格式不正确",
    password_too_short: "密码至少 10 位",
    password_too_long: "密码最多 128 位",
    invalid_request: "填写的内容有误，请检查后再试。",
    network_error: "连不上服务，请检查网络后重试。",
    busy: "服务现在有点忙，请稍后再试。",
  };
  it.each(Object.entries(table))("%s", (code, text) => {
    expect(messageFor(code)).toBe(text);
  });

  it("an unknown code, or none, gets the fallback", () => {
    expect(messageFor("something_new")).toBe(FALLBACK_MESSAGE);
    expect(messageFor(undefined)).toBe(FALLBACK_MESSAGE);
  });

  it("the unverified-e-mail text says a new mail was sent", () => {
    expect(messageFor("email_not_verified")).toContain("又发了一封验证邮件");
  });

  it("codes about one field map to it, others to the form", () => {
    expect(fieldOf("invalid_invite")).toBe("inviteCode");
    expect(fieldOf("handle_taken")).toBe("handle");
    expect(fieldOf("password_too_short")).toBe("password");
    expect(fieldOf("invalid_email")).toBe("email");
    for (const code of ["invalid_email_or_password", "email_not_verified", "rate_limited", "invalid_token", "network_error"]) {
      expect(fieldOf(code)).toBeNull();
    }
  });

  it("verification failures: expired has its own text, the others share one", () => {
    expect(verifyMessage("TOKEN_EXPIRED")).toBe("验证链接已过期。请直接登录，我们会重新发送一封验证邮件。");
    for (const code of ["INVALID_TOKEN", "USER_NOT_FOUND", "INVALID_USER", "x"]) expect(verifyMessage(code)).toBe(VERIFY_FALLBACK);
  });
});

describe("router decisions", () => {
  const route = (pathname, search = "") => parseRoute({ pathname, search });

  it("parses the account screens, tolerates a trailing slash, and calls everything else the app", () => {
    expect(route("/signin").name).toBe("signin");
    expect(route("/register/").name).toBe("register");
    expect(route("/forgot").name).toBe("forgot");
    expect(route("/reset-password", "?token=x").name).toBe("reset");
    expect(route("/").name).toBe("app");
    expect(route("/chat/abc").name).toBe("app");
    expect(route("/signin/extra").name).toBe("app");
  });

  it("the verification landing: /verify, or / with one of the service's error codes", () => {
    expect(route("/verify")).toEqual({ name: "verify", error: null });
    expect(route("/verify", "?error=TOKEN_EXPIRED")).toEqual({ name: "verify", error: "TOKEN_EXPIRED" });
    expect(route("/", "?error=INVALID_TOKEN")).toEqual({ name: "verify", error: "INVALID_TOKEN" });
    expect(route("/", "?error=whatever").name).toBe("app");
  });

  it("decides nothing while loading", () => {
    for (const p of ["/", "/signin", "/verify"]) expect(decide(route(p), "loading")).toEqual({ view: "loading" });
  });

  it("signed out: the app goes to /signin, the account screens show", () => {
    expect(decide(route("/"), "out")).toEqual({ redirect: "/signin" });
    expect(decide(route("/chat/abc"), "out")).toEqual({ redirect: "/signin" });
    for (const [p, view] of [["/signin", "signin"], ["/register", "register"], ["/forgot", "forgot"], ["/verify", "verify"], ["/reset-password", "reset"]]) {
      expect(decide(route(p), "out")).toEqual({ view });
    }
  });

  it("signed in: the app shows, sign-in, register and forgot go to the app, verify and reset still show", () => {
    expect(decide(route("/"), "in")).toEqual({ view: "app" });
    for (const p of ["/signin", "/register", "/forgot"]) expect(decide(route(p), "in")).toEqual({ redirect: "/" });
    expect(decide(route("/verify"), "in")).toEqual({ redirect: "/" });
    expect(decide(route("/verify", "?error=INVALID_TOKEN"), "in")).toEqual({ view: "verify" });
    expect(decide(route("/reset-password"), "in")).toEqual({ view: "reset" });
  });
});

describe("the reset token", () => {
  afterEach(() => {
    clearResetToken();
    history.replaceState(null, "", "/");
  });

  it("is taken from the address and the query is gone at once", () => {
    history.replaceState(null, "", "/reset-password?token=abc123");
    expect(captureResetToken()).toBe("abc123");
    expect(location.pathname).toBe("/reset-password");
    expect(location.search).toBe("");
    expect(location.href).not.toContain("abc123");
    expect(takeResetToken()).toBe("abc123");
  });

  it("a second call after the address is clean (React renders twice) still returns it", () => {
    history.replaceState(null, "", "/reset-password?token=abc123");
    captureResetToken();
    expect(captureResetToken()).toBe("abc123");
  });

  it("drops any other query on that path too, and leaves other paths alone", () => {
    history.replaceState(null, "", "/reset-password?x=1");
    expect(captureResetToken()).toBeNull();
    expect(location.search).toBe("");
    history.replaceState(null, "", "/signin?token=nope");
    expect(captureResetToken()).toBeNull();
    expect(location.search).toBe("?token=nope");
  });

  it("clearing forgets it", () => {
    history.replaceState(null, "", "/reset-password?token=abc123");
    captureResetToken();
    clearResetToken();
    expect(takeResetToken()).toBeNull();
  });
});

describe("401 handler", () => {
  const fetchMock = vi.fn();
  const handler = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    handler.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: "invalid_email_or_password" }), { status: 401 }));
    setUnauthenticatedHandler(handler);
  });
  afterEach(() => {
    setUnauthenticatedHandler(null);
    vi.unstubAllGlobals();
  });

  it("ignores a 401 from /api/auth/* (a wrong password is not an ended session) but still throws it", async () => {
    await expect(request("POST", "/api/auth/sign-in/email", { email: "a", password: "b" })).rejects.toMatchObject({ status: 401, code: "invalid_email_or_password" });
    await expect(request("POST", "/api/auth/sign-out")).rejects.toMatchObject({ status: 401 });
    await expect(request("POST", "/api/auth/reset-password", {})).rejects.toMatchObject({ status: 401 });
    expect(handler).not.toHaveBeenCalled();
  });

  it("ignores a 401 for a request that started before the session changed (epoch bumped)", async () => {
    let release;
    fetchMock.mockImplementation(() => new Promise((resolve) => (release = () => resolve(new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 })))));
    const pending = request("GET", "/api/sync").catch((e) => e);
    bumpSessionEpoch();
    release();
    expect(await pending).toMatchObject({ status: 401 });
    expect(handler).not.toHaveBeenCalled();
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 }));
    await request("GET", "/api/sync").catch(() => {});
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("is called for a 401 from any other request", async () => {
    await expect(request("GET", "/api/sync")).rejects.toMatchObject({ status: 401 });
    await expect(request("POST", "/api/register", {})).rejects.toMatchObject({ status: 401 });
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
