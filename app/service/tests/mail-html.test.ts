import { describe, expect, test } from "vitest";
import { PRODUCT_NAME } from "../src/brand.ts";
import { registrationAttemptMail, resetPasswordMail, verifyEmailMail } from "../src/auth/mail-copy.ts";
import { escapeHtml, safeHref } from "../src/auth/mail-html.ts";

const URL_OK = "https://test.haiyo.org/verify?token=EXAMPLE&callbackURL=%2Fverify";
const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

/** The three mails, as functions of their (main) link. */
const mails = {
  verify: (u: string) => verifyEmailMail(u),
  reset: (u: string) => resetPasswordMail(u),
  notice: (u: string) => registrationAttemptMail(u, "https://test.haiyo.org/forgot"),
};

describe("the public name", () => {
  test("is Haiyo, in the subjects and in both bodies of every mail", () => {
    expect(PRODUCT_NAME).toBe("Haiyo");
    for (const [name, make] of Object.entries(mails)) {
      const m = make(URL_OK);
      expect([name, m.subject.includes("Haiyo"), m.body.includes("Haiyo"), m.html.includes("Haiyo")]).toEqual([name, true, true, true]);
      expect([name, `${m.subject}${m.body}${m.html}`.includes("Agent Family")]).toEqual([name, false]);
    }
  });
});

describe("mail HTML", () => {
  test("every mail has both parts: the plain text as before and an HTML document", () => {
    for (const make of Object.values(mails)) {
      const m = make(URL_OK);
      expect(m.body).toContain(URL_OK);
      expect(m.html.startsWith("<!doctype html>")).toBe(true);
      expect(m.html).toContain('<html lang="zh-CN"');
      expect(m.html).toContain(`<title>${escapeHtml(m.subject)}</title>`);
      expect(m.html).toContain('<meta name="color-scheme" content="light dark">');
    }
  });

  test("restrictive-client rules: tables with role=presentation, inline styles only, no style block, script, remote image or web font, 480px wide", () => {
    for (const make of Object.values(mails)) {
      const { html } = make(URL_OK);
      expect(html).not.toMatch(/<style|<script|<img|<link|@import|@font-face|url\(|<svg|<iframe|<form/i);
      for (const table of html.match(/<table\b[^>]*>/g) ?? []) expect(table).toContain('role="presentation"');
      expect(html).toContain("max-width:480px");
      expect(html).toContain("margin:0 auto");
      expect(html).toContain("font-family:");
      expect(html).toContain(">Haiyo<"); // the text wordmark is the header
    }
  });

  test("the verification mail: heading, one button, the link once in href and once as text, lifetime and the not-you line", () => {
    const m = verifyEmailMail(URL_OK);
    const escaped = escapeHtml(URL_OK);
    expect(m.html).toContain("验证你的邮箱");
    expect(count(m.html, `href="${escaped}"`)).toBe(1);
    expect(count(m.html, `>${escaped}<`)).toBe(1);
    expect(count(m.html, "href=")).toBe(1);
    expect(m.html).toContain(">验证邮箱<");
    expect(m.html).toMatch(/<a [^>]*background-color:#5b4fd6[^>]*color:#ffffff[^>]*border-radius:8px[^>]*>验证邮箱<\/a>/);
    expect(m.html).toMatch(/padding:\d+px \d+px/);
    expect(m.html).toContain("24 小时");
    expect(m.html).toContain("打不开按钮？把下面的地址复制到浏览器：");
    expect(m.html).toContain("如果你没有注册 Haiyo，请不要点击链接，直接忽略这封邮件。");
  });

  test("the reset mail: its heading, button and the hour", () => {
    const m = resetPasswordMail(URL_OK);
    const escaped = escapeHtml(URL_OK);
    expect(m.html).toContain("重置你的密码");
    expect(m.html).toContain(">设置新密码<");
    expect(count(m.html, `href="${escaped}"`)).toBe(1);
    expect(count(m.html, `>${escaped}<`)).toBe(1);
    expect(m.html).toContain("1 小时");
    expect(m.html).toContain("如果这不是你本人的操作，请忽略这封邮件。");
  });

  test("the registration notice: its heading; sign-in and reset links each once in href and once as text; one button", () => {
    const signIn = "https://test.haiyo.org/signin";
    const reset = "https://test.haiyo.org/forgot";
    const m = registrationAttemptMail(signIn, reset);
    expect(m.html).toContain("有人尝试用你的邮箱注册");
    for (const link of [signIn, reset]) {
      expect([link, count(m.html, `href="${link}"`)]).toEqual([link, 1]);
      expect([link, count(m.html, `>${link}<`)]).toEqual([link, 1]);
    }
    expect(count(m.html, "background-color:#5b4fd6")).toBe(2); // the cell and the link of the one button
    expect(m.html).toContain("如果这不是你本人的操作，请忽略这封邮件。");
  });

  test("a preheader: hidden, before the heading, and it is the first sentence", () => {
    const m = verifyEmailMail(URL_OK);
    const pre = /<div style="display:none[^"]*">([^<]*)<\/div>/.exec(m.html);
    expect(pre).not.toBeNull();
    expect(m.html.indexOf(pre![0])).toBeLessThan(m.html.indexOf("验证你的邮箱"));
    expect(pre![1]).toContain("欢迎来到 Haiyo。");
  });

  test("the palette is light and dark friendly: white text only on the button, no pure black text", () => {
    const { html } = verifyEmailMail(URL_OK);
    for (const m of html.matchAll(/[^-]color:#ffffff/gi)) {
      const around = html.slice(Math.max(0, m.index! - 120), m.index! + 60);
      expect(around).toContain("background-color:#5b4fd6");
    }
    expect(html).not.toMatch(/[^-]color:#000(000)?\b/i);
    expect(html).toContain('<meta name="supported-color-schemes" content="light dark">');
  });

  describe("escaping", () => {
    const hostile = "https://x.test/a?b=\"><script>alert(1)</script>&c='d'";

    test("escapeHtml covers & < > \" '", () => {
      expect(escapeHtml(`a&b<c>d"e'f`)).toBe("a&amp;b&lt;c&gt;d&quot;e&#39;f");
    });

    test("a URL with a quote, angle brackets and an ampersand breaks out of nothing, in href or in the text", () => {
      const known = ["html", "head", "meta", "title", "body", "table", "tr", "td", "div", "h1", "p", "a", "span", "br"];
      for (const make of Object.values(mails)) {
        const m = make(hostile);
        expect(m.html).not.toContain("<script>alert");
        expect(m.html).not.toContain("\"><script");
        expect(m.html).toContain(`href="${escapeHtml(hostile)}"`);
        // Every tag opened in the document is one of the template's own.
        expect([...m.html.matchAll(/<([a-z0-9]+)/gi)].map((t) => t[1]!.toLowerCase()).filter((t) => !known.includes(t))).toEqual([]);
        // The plain text is not escaped: it is text.
        expect(m.body).toContain(hostile);
      }
    });

    test("only http(s) links are ever put in href: any other scheme gives no button and no anchor, text only", () => {
      const bad = ["javascript:alert(1)", "JaVaScRiPt:alert(1)", " javascript:alert(1)", "data:text/html,<b>x</b>", "vbscript:x", "//evil.test/x", "/relative", "mailto:a@b.test", "ftp://x.test/f", ""];
      for (const url of bad) {
        for (const make of [mails.verify, mails.reset]) {
          const { html } = make(url);
          expect([url, html.includes("href=")]).toEqual([url, false]);
          expect([url, html.includes(">验证邮箱<") || html.includes(">设置新密码<")]).toEqual([url, false]);
        }
        const notice = registrationAttemptMail(url, "https://test.haiyo.org/forgot");
        expect([url, count(notice.html, "href=")]).toEqual([url, 1]); // only the reset link
        expect([url, notice.html.includes(">去登录<")]).toEqual([url, false]);
      }
      expect(safeHref("https://a.test/x?y=1&z=2")).toBe("https://a.test/x?y=1&amp;z=2");
      expect(safeHref("HTTP://a.test/")).toBe("HTTP://a.test/");
      expect(safeHref('javascript:"')).toBeUndefined();
    });
  });
});
