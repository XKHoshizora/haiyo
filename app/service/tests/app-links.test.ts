import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { loadConfig } from "../src/config.ts";
import { useApp } from "./helpers/harness.ts";

/**
 * The universal-links file (src/app-links.ts): `GET /.well-known/apple-app-site-association`, built from `APPLE_TEAM_ID`
 * and `APPLE_BUNDLE_ID`, as `application/json`, never a redirect and never the web client's page — before this lane the
 * web client's wildcard answered it with index.html (its `.well-known` segment is refused as a dotfile, and the last
 * segment has no extension, so it fell back to the page).
 */

const INDEX = '<!doctype html><html><body><div id="root"></div></body></html>';
const outer = mkdtempSync(path.join(tmpdir(), "af-links-"));
const dist = path.join(outer, "dist");
mkdirSync(path.join(dist, "assets"), { recursive: true });
writeFileSync(path.join(dist, "index.html"), INDEX);
afterAll(() => rmSync(outer, { recursive: true, force: true }));

const URL_PATH = "/.well-known/apple-app-site-association";
const APPLE = { APPLE_TEAM_ID: "ABCDE12345", APPLE_BUNDLE_ID: "org.haiyo.app" };
/** Exactly the paths the plan lists (docs/design/2026-11-24-store-app-draft.md, S1): `/chat/*`, `/reset-password*`, and `/api/*` excluded. */
const EXPECTED = {
  applinks: {
    details: [
      {
        appIDs: ["ABCDE12345.org.haiyo.app"],
        components: [
          { "/": "/api/*", exclude: true },
          { "/": "/chat/*" },
          { "/": "/reset-password*" },
        ],
      },
    ],
  },
};

describe("configured, with the web client served", () => {
  const { app } = useApp({ env: { WEB_DIST: dist, ...APPLE } });

  test("GET answers 200 application/json with the file, no redirect and no page", async () => {
    const r = await app.inject({ method: "GET", url: URL_PATH });
    expect(r.statusCode).toBe(200);
    expect(r.headers.location).toBeUndefined();
    expect(r.headers["content-type"]).toBe("application/json");
    expect(r.body).not.toContain("<html");
    expect(JSON.parse(r.body)).toEqual(EXPECTED);
  });

  test("HEAD answers the same status and type, without a body", async () => {
    const r = await app.inject({ method: "HEAD", url: URL_PATH });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe("application/json");
    expect(r.body).toBe("");
  });

  test("the client's own paths are still the page (the file names only them)", async () => {
    for (const url of ["/chat/0b6c6d5e-0000-4000-8000-000000000001", "/reset-password?token=abc"]) {
      const r = await app.inject({ method: "GET", url });
      expect([url, r.statusCode, r.body]).toEqual([url, 200, INDEX]);
    }
  });

  test("it is not an API route (app.routeList lists the API; the README and fuzz suites walk it)", () => {
    expect(app.routeList.filter((r) => r.url.includes("well-known"))).toEqual([]);
  });
});

describe("unconfigured, with the web client served", () => {
  const { app } = useApp({ env: { WEB_DIST: dist } });

  test("GET and HEAD are a JSON 404, never the page", async () => {
    const r = await app.inject({ method: "GET", url: URL_PATH });
    expect(r.statusCode).toBe(404);
    expect(r.headers["content-type"]).toMatch(/^application\/json/);
    expect(r.body).not.toContain("<html");
    expect(JSON.parse(r.body)).toEqual({ error: "not_found" });
    const head = await app.inject({ method: "HEAD", url: URL_PATH });
    expect(head.statusCode).toBe(404);
  });
});

describe("configured, without the web client", () => {
  const { app } = useApp({ env: APPLE });

  test("the file is served all the same: it belongs to the domain, not to the web build", async () => {
    const r = await app.inject({ method: "GET", url: URL_PATH });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual(EXPECTED);
  });
});

describe("configuration", () => {
  const base = { DATABASE_URL: "postgres://x/y", APP_ORIGIN: "https://haiyo.example", AUTH_SECRET: "x".repeat(32), PROVIDER_KEY_SECRET: "p".repeat(32) };

  test("both identifiers set: the app; neither: none; one alone: none, and the other is named as missing", () => {
    expect(loadConfig({ ...base, ...APPLE }).apple.app).toEqual({ teamId: "ABCDE12345", bundleId: "org.haiyo.app" });
    expect(loadConfig(base).apple.app).toBeNull();
    expect(loadConfig(base).apple.missing).toEqual([]);
    const half = loadConfig({ ...base, APPLE_TEAM_ID: "ABCDE12345" });
    expect(half.apple.app).toBeNull();
    expect(half.apple.missing).toContain("APPLE_BUNDLE_ID");
  });

  test("a malformed identifier stops the start, naming the variable", () => {
    for (const [name, bad] of [
      ["APPLE_TEAM_ID", "abcde12345"],
      ["APPLE_TEAM_ID", "ABCDE1234"],
      ["APPLE_TEAM_ID", "ABCDE12345\n"],
      ["APPLE_BUNDLE_ID", "haiyo"],
      ["APPLE_BUNDLE_ID", "org.haiyo.app/x"],
      ["APPLE_BUNDLE_ID", "org..haiyo"],
    ] as const) {
      expect(() => loadConfig({ ...base, ...APPLE, [name]: bad }), `${name}=${bad}`).toThrow(new RegExp(name));
    }
  });
});
