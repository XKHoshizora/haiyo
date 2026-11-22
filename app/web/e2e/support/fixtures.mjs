// `test` with a `people` fixture: every person is a browser context of their own (isolated cookies). Every page the
// fixture opens is watched for Content-Security-Policy violations, uncaught errors and the XSS probe
// (`window.__xss`, an `<img src="x">` in the DOM); the test fails if any shows up.
import { test as base, expect } from "@playwright/test";
import { befriend, newIdentity, registerVerified, signInApi } from "./accounts.mjs";
import { rail } from "./app.mjs";

/** The probe the hostile strings try to trigger: `<img src=x onerror=window.__xss=1>`. */
export const HOSTILE = "<img src=x onerror=window.__xss=1>";

/** Runs in every document before the app: records an XSS hit and CSP violations on the console. */
function guardScript() {
  let fired;
  Object.defineProperty(window, "__xss", {
    configurable: false,
    get: () => fired,
    set: (value) => {
      fired = value;
      console.error("[e2e] window.__xss was set");
    },
  });
  document.addEventListener("securitypolicyviolation", (e) => {
    console.error(`[e2e] Content Security Policy violation: ${e.violatedDirective} ${e.blockedURI}`);
  });
}

class People {
  constructor(browser) {
    this.browser = browser;
    this.contexts = [];
    this.watched = [];
  }

  async newContext(options = {}) {
    const context = await this.browser.newContext(options);
    await context.addInitScript(guardScript);
    this.contexts.push(context);
    return context;
  }

  /** A page of `context` that the guards watch. */
  async watchedPage(context, name) {
    const page = await context.newPage();
    const record = { name, page, problems: [] };
    page.on("console", (msg) => {
      const text = msg.text();
      if (/Content Security Policy|window\.__xss/.test(text)) record.problems.push(`console: ${text}`);
    });
    page.on("pageerror", (err) => record.problems.push(`uncaught: ${err.message}`));
    this.watched.push(record);
    return page;
  }

  /** Someone without an account yet: a context and a page (nothing opened). */
  async stranger(label) {
    const context = await this.newContext();
    const page = await this.watchedPage(context, label);
    return { label, context, page, request: context.request };
  }

  /**
   * A verified account made through the API, signed in (cookie in its context), its app open on `/` unless
   * `open: false`. `displayName` replaces the generated one.
   */
  async member(label, { displayName, open = true, contextOptions } = {}) {
    const identity = newIdentity(label, { displayName });
    const context = await this.newContext(contextOptions);
    await registerVerified(context.request, identity);
    const me = await signInApi(context.request, identity);
    const person = { ...identity, id: me.id, context, request: context.request, page: null };
    if (open) person.page = await this.openApp(person);
    return person;
  }

  /** A new tab of the person's context with the app loaded. */
  async openApp(person, path = "/") {
    const page = await this.watchedPage(person.context, `${person.label}#${this.watched.length}`);
    await page.goto(path);
    await expect(rail(page)).toBeVisible();
    return page;
  }

  /** One member per label, each a friend of the first; in label order. */
  async friendsOf(labels) {
    const crowd = [];
    for (const label of labels) crowd.push(await this.member(label));
    for (const other of crowd.slice(1)) await befriend(crowd[0], other);
    return crowd;
  }

  async finish() {
    for (const record of this.watched) {
      if (record.page.isClosed()) continue;
      const probe = await record.page
        .evaluate(() => ({ xss: window.__xss, injected: document.querySelectorAll('img[src="x"]').length }))
        .catch(() => null);
      if (probe?.xss !== undefined) record.problems.push(`window.__xss = ${String(probe.xss)}`);
      if (probe?.injected) record.problems.push(`${probe.injected} <img src="x"> element(s) in the page`);
    }
    const problems = this.watched.flatMap((r) => r.problems.map((p) => `${r.name}: ${p}`));
    await Promise.all(this.contexts.map((c) => c.close().catch(() => {})));
    expect(problems, "no CSP violation, uncaught error or injected markup on any page").toEqual([]);
  }
}

export const test = base.extend({
  people: async ({ browser }, use) => {
    const people = new People(browser);
    await use(people);
    await people.finish();
  },
});

export { expect };
