// @vitest-environment jsdom
// The terms, the privacy policy and the contact page (src/legal/): public pages that open without a session (App Review opens
// them from the store page), in Simplified Chinese, English and Japanese, from text files a non-engineer edits; their versions
// are the service's (app/service/src/legal.ts).
import React from "react";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, configure, fireEvent, render, screen, within } from "@testing-library/react";
import { ApiError } from "../src/api/http.js";
import { AuthRoot } from "../src/auth/AuthRoot.jsx";
import { LEGAL_VERSIONS } from "../src/legal/versions.js";
import { parseLegal } from "../src/legal/legalText.js";
import { pickLanguage } from "../src/legal/docs.js";

configure({ asyncUtilTimeout: 5_000 });
vi.setConfig({ testTimeout: 15_000 });

const TEXTS = path.join(import.meta.dirname, "..", "src", "legal", "texts");
const DOCS = ["terms", "privacy", "contact"];
const LANGS = ["zh", "en", "ja"];
const TITLES = {
  terms: { zh: "服务条款", en: "Terms of Service", ja: "利用規約" },
  privacy: { zh: "隐私政策", en: "Privacy Policy", ja: "プライバシーポリシー" },
  contact: { zh: "联系我们", en: "Contact", ja: "お問い合わせ" },
};
const ANN = { id: "p-ann", handle: "ann", displayName: "小安", email: "ann@x.com", termsAccepted: true };

let layers;
const createLayer = () => {
  const layer = { start: vi.fn(), stop: vi.fn(), onSignedOut: () => () => {} };
  layers.push(layer);
  return layer;
};
const at = (p) => history.replaceState(null, "", p);
const mount = (api) =>
  render(
    <AuthRoot api={api} createLayer={createLayer}>
      {() => <div data-testid="app" />}
    </AuthRoot>,
  );
const pending = () => ({ getMe: vi.fn(() => new Promise(() => {})) });
const languages = (list) => vi.spyOn(navigator, "languages", "get").mockReturnValue(list);

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
});
beforeEach(() => {
  layers = [];
  at("/");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the documents' versions", () => {
  it("are the service's: what the web sends is what the service holds in force", () => {
    const source = readFileSync(path.join(import.meta.dirname, "..", "..", "service", "src", "legal.ts"), "utf8");
    const found = /LEGAL_VERSIONS = \{ terms: "([^"]+)", privacy: "([^"]+)" \}/.exec(source);
    expect(found, "app/service/src/legal.ts names LEGAL_VERSIONS").not.toBeNull();
    expect(LEGAL_VERSIONS).toEqual({ terms: found[1], privacy: found[2] });
  });
});

describe("the texts", () => {
  it("are one file per document and language, each titled, each giving the contact address", () => {
    expect(readdirSync(TEXTS).sort()).toEqual(DOCS.flatMap((d) => LANGS.map((l) => `${d}.${l}.md`)).sort());
    for (const doc of DOCS) {
      for (const lang of LANGS) {
        const text = readFileSync(path.join(TEXTS, `${doc}.${lang}.md`), "utf8");
        const parsed = parseLegal(text);
        expect([doc, lang, parsed.title]).toEqual([doc, lang, TITLES[doc][lang]]);
        expect([doc, lang, text.includes("support@haiyo.org")]).toEqual([doc, lang, true]);
        // Plain text a person edits: no HTML in it.
        expect([doc, lang, /<[a-z/!]/i.test(text)]).toEqual([doc, lang, false]);
      }
    }
  });

  it("the terms and the privacy policy say 18 in every language; the account deletion line is one marked TODO per language", () => {
    for (const lang of LANGS) {
      for (const doc of ["terms", "privacy"]) expect([doc, lang, readFileSync(path.join(TEXTS, `${doc}.${lang}.md`), "utf8").includes("18")]).toEqual([doc, lang, true]);
      const all = DOCS.map((doc) => readFileSync(path.join(TEXTS, `${doc}.${lang}.md`), "utf8")).join("\n");
      expect([lang, all.match(/\{\{TODO/g)?.length ?? 0]).toEqual([lang, 1]);
    }
  });

  it("parses headings, paragraphs, lists, bold, links, addresses and the owner's placeholders, and nothing else", () => {
    const parsed = parseLegal(
      [
        "# Title",
        "",
        "{{Owner to fill in}}",
        "A line with **bold**, [a page](/privacy), [a site](https://example.com/x) and mail@example.com.",
        "## Part",
        "- one",
        "- two [bad](javascript:alert)",
        "### Small",
        "Last",
      ].join("\n"),
    );
    expect(parsed.title).toBe("Title");
    expect(parsed.blocks).toEqual([
      { type: "p", parts: [{ type: "todo", text: "Owner to fill in" }] },
      {
        type: "p",
        parts: [
          { type: "text", text: "A line with " },
          { type: "strong", text: "bold" },
          { type: "text", text: ", " },
          { type: "link", text: "a page", href: "/privacy" },
          { type: "text", text: ", " },
          { type: "link", text: "a site", href: "https://example.com/x" },
          { type: "text", text: " and " },
          { type: "link", text: "mail@example.com", href: "mailto:mail@example.com" },
          { type: "text", text: "." },
        ],
      },
      { type: "h2", parts: [{ type: "text", text: "Part" }] },
      { type: "ul", items: [[{ type: "text", text: "one" }], [{ type: "text", text: "two " }, { type: "text", text: "bad" }]] },
      { type: "h3", parts: [{ type: "text", text: "Small" }] },
      { type: "p", parts: [{ type: "text", text: "Last" }] },
    ]);
  });

  it("picks the language: ?lang= first, then the browser's languages, English for any other", () => {
    expect(pickLanguage("?lang=ja", ["zh-CN"])).toBe("ja");
    expect(pickLanguage("?lang=xx", ["zh-CN"])).toBe("zh");
    expect(pickLanguage("", ["zh-TW", "en"])).toBe("zh");
    expect(pickLanguage("", ["ja-JP"])).toBe("ja");
    expect(pickLanguage("", ["fr-FR", "ja"])).toBe("ja");
    expect(pickLanguage("", ["fr-FR"])).toBe("en");
    expect(pickLanguage("", [])).toBe("en");
  });
});

describe("the public pages", () => {
  it.each(DOCS)("/%s opens without a session and without waiting for one", async (doc) => {
    languages(["zh-CN"]);
    at(`/${doc}`);
    const api = pending();
    mount(api);
    expect(await screen.findByRole("heading", { level: 1, name: TITLES[doc].zh })).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.queryByTestId("app")).toBeNull();
    expect(location.pathname).toBe(`/${doc}`);
    expect(document.title).toBe(`${TITLES[doc].zh} · Haiyo`);
  });

  it("opens when the service cannot be reached, and for a signed-out visitor stays where it is", async () => {
    at("/privacy");
    mount({ getMe: vi.fn(async () => Promise.reject(new ApiError(0, "network_error"))) });
    expect(await screen.findByRole("heading", { level: 1, name: "Privacy Policy" })).toBeTruthy();
    expect(screen.queryByText("连不上服务，请检查网络后重试。")).toBeNull();
    cleanup();
    at("/terms");
    mount({ getMe: vi.fn(async () => Promise.reject(new ApiError(401, "unauthenticated"))) });
    expect(await screen.findByRole("heading", { level: 1, name: "Terms of Service" })).toBeTruthy();
    expect(location.pathname).toBe("/terms");
  });

  it("for a signed-in visitor is the page too, and starts no data layer (no socket for a tab that only reads the terms)", async () => {
    at("/contact");
    const getMe = vi.fn(async () => ANN);
    mount({ getMe });
    await screen.findByRole("heading", { level: 1, name: "Contact" });
    await act(async () => {});
    expect(getMe).toHaveBeenCalled();
    expect(layers.every((l) => l.start.mock.calls.length === 0)).toBe(true);
    expect(screen.queryByTestId("app")).toBeNull();
  });

  it("switches between the three languages with one plain switch, and says which is on", async () => {
    languages(["en-US"]);
    at("/terms");
    mount(pending());
    await screen.findByRole("heading", { level: 1, name: "Terms of Service" });
    const group = screen.getByRole("group", { name: /Language/ });
    const button = (name) => within(group).getByRole("button", { name });
    expect(button("English").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(button("日本語"));
    expect(await screen.findByRole("heading", { level: 1, name: "利用規約" })).toBeTruthy();
    expect(button("日本語").getAttribute("aria-pressed")).toBe("true");
    expect(button("English").getAttribute("aria-pressed")).toBe("false");
    expect(document.querySelector("article").getAttribute("lang")).toBe("ja");
    expect(location.search).toBe("?lang=ja");
    fireEvent.click(button("中文"));
    expect(await screen.findByRole("heading", { level: 1, name: "服务条款" })).toBeTruthy();
    expect(document.querySelector("article").getAttribute("lang")).toBe("zh-CN");
  });

  it("?lang= chooses the language a link was made for", async () => {
    languages(["zh-CN"]);
    at("/privacy?lang=ja");
    mount(pending());
    expect(await screen.findByRole("heading", { level: 1, name: "プライバシーポリシー" })).toBeTruthy();
  });

  it("shows the version of the terms and of the policy, gives the address as a mail link and links the other two pages", async () => {
    languages(["zh-CN"]);
    at("/privacy");
    mount(pending());
    await screen.findByRole("heading", { level: 1, name: "隐私政策" });
    expect(document.body.textContent).toContain(`版本 ${LEGAL_VERSIONS.privacy}`);
    // (The title is there at once; the text comes with its file.)
    const mail = (await screen.findAllByRole("link", { name: "support@haiyo.org" }))[0];
    expect(mail.getAttribute("href")).toBe("mailto:support@haiyo.org");
    const nav = screen.getByRole("navigation", { name: "其他页面" });
    expect(within(nav).getByRole("link", { name: "服务条款" }).getAttribute("href")).toBe("/terms?lang=zh");
    expect(within(nav).getByRole("link", { name: "联系我们" }).getAttribute("href")).toBe("/contact?lang=zh");
    // The owner's blanks stand out on the page, so none is missed.
    expect(document.querySelectorAll("mark.legal-todo").length).toBeGreaterThan(0);
    cleanup();
    at("/contact");
    mount(pending());
    await screen.findByRole("heading", { level: 1, name: "联系我们" });
    await screen.findByText(/24 小时内处理/);
    expect(document.body.textContent).not.toContain("版本");
  });

  it("its link to the product goes to the app", async () => {
    languages(["zh-CN"]);
    at("/terms");
    mount(pending());
    await screen.findByRole("heading", { level: 1, name: "服务条款" });
    expect(screen.getByRole("link", { name: "Haiyo" }).getAttribute("href")).toBe("/");
  });
});
