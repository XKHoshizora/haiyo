import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { api, signUp } from "./helpers/actors.ts";
import { useApp } from "./helpers/harness.ts";
import { closeAllSockets, connect } from "./helpers/ws.ts";

const INDEX = '<!doctype html><html><body><div id="root"></div><script type="module" src="/assets/index-Ab12_xYz.js"></script></body></html>';
const SECRET = "SECRET-OUTSIDE-THE-WEB-DIST";

// <tmp>/outside.json sits beside the served directory: traversal would reach it.
const outer = mkdtempSync(path.join(tmpdir(), "af-web-"));
const dist = path.join(outer, "dist");
mkdirSync(path.join(dist, "assets"), { recursive: true });
mkdirSync(path.join(dist, "empty-dir"));
writeFileSync(path.join(dist, "index.html"), INDEX);
writeFileSync(path.join(dist, "favicon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
writeFileSync(path.join(dist, ".env"), SECRET);
writeFileSync(path.join(dist, "assets", "index-Ab12_xYz.js"), "console.log('hi');");
writeFileSync(path.join(dist, "assets", "index-Ab12_xYz.css"), "body{margin:0}");
writeFileSync(path.join(dist, "assets", "agent-family-mark-v2.png"), "png");
writeFileSync(path.join(dist, "assets", "brand-v2-notes.md"), "notes");
writeFileSync(path.join(outer, "outside.json"), SECRET);
afterAll(() => rmSync(outer, { recursive: true, force: true }));

const csp = (socket: string) =>
  `default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ${socket}; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`;
const CSP = csp("ws://localhost:5173");

function expectSecurityHeaders(h: Record<string, unknown>, hsts = false, policy = CSP) {
  expect(h["content-security-policy"]).toBe(policy);
  expect(h["x-content-type-options"]).toBe("nosniff");
  expect(h["referrer-policy"]).toBe("same-origin");
  expect(h["x-frame-options"]).toBe("DENY");
  expect(h["permissions-policy"]).toBe("camera=(), microphone=(), geolocation=()");
  if (hsts) expect(h["strict-transport-security"]).toBe("max-age=15552000");
  else expect(h["strict-transport-security"]).toBeUndefined();
}

afterEach(closeAllSockets);

describe("web client served from WEB_DIST", () => {
  const { app } = useApp({ env: { WEB_DIST: dist } });
  const get = (url: string, method: "GET" | "HEAD" = "GET") => app.inject({ method, url });

  test("a file is served with its type, the security headers and no-cache", async () => {
    const r = await get("/favicon.svg");
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toMatch(/^image\/svg\+xml/);
    expect(r.headers["cache-control"]).toBe("no-cache");
    expectSecurityHeaders(r.headers);
  });

  test("hashed files under /assets/ are cached for a year, immutable", async () => {
    for (const [url, type] of [
      ["/assets/index-Ab12_xYz.js", /javascript/],
      ["/assets/index-Ab12_xYz.css", /css/],
    ] as const) {
      const r = await get(url);
      expect([url, r.statusCode]).toEqual([url, 200]);
      expect(r.headers["content-type"]).toMatch(type);
      expect(r.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
      expectSecurityHeaders(r.headers);
    }
  });

  test("/, /index.html and the fallback are index.html with no-cache and the security headers", async () => {
    // `/a/<Agent id>` is an Agent's share link (find-agent design, D2, D3): the client's page, which takes the path.
    for (const url of ["/", "/index.html", "/signin", "/some/deep/path", "/chat/12?x=1", "/reset-password?token=abc", "/a/6a0d4c2e-1b3f-4a5e-9c7d-8e9f0a1b2c3d", "/a/6A0D4C2E-1B3F-4A5E-9C7D-8E9F0A1B2C3D"]) {
      const r = await get(url);
      expect([url, r.statusCode, r.body]).toEqual([url, 200, INDEX]);
      expect(r.headers["content-type"]).toMatch(/^text\/html/);
      expect(r.headers["cache-control"]).toBe("no-cache");
      expectSecurityHeaders(r.headers);
    }
  });

  test("only content-hashed files are immutable; other files under /assets/ revalidate", async () => {
    for (const url of ["/assets/agent-family-mark-v2.png", "/assets/brand-v2-notes.md"]) {
      const r = await get(url);
      expect([url, r.statusCode, r.headers["cache-control"]]).toEqual([url, 200, "no-cache"]);
    }
  });

  test("a missing file is a plain JSON 404 (no-store), never the page: under /assets/ or with an extension", async () => {
    for (const url of ["/assets/index-OLDHASH1.js", "/assets/x/y.js", "/assets/", "/assets", "/no-such.file", "/a/b/missing.css", "/sw.js", "/favicon.ico"]) {
      for (const method of ["GET", "HEAD"] as const) {
        const r = await get(url, method);
        expect([url, method, r.statusCode, r.headers["cache-control"], r.headers["content-type"]]).toEqual([
          url,
          method,
          404,
          "no-store",
          "application/json; charset=utf-8",
        ]);
        if (method === "GET") expect(r.json()).toEqual({ error: "not_found" });
        expect(r.headers["content-security-policy"]).toBeUndefined();
      }
    }
  });

  test("HEAD answers like GET without a body", async () => {
    for (const url of ["/", "/signin", "/favicon.svg", "/assets/index-Ab12_xYz.js"]) {
      const g = await get(url);
      const h = await get(url, "HEAD");
      expect([url, h.statusCode, h.body]).toEqual([url, 200, ""]);
      expect(h.headers["cache-control"]).toBe(g.headers["cache-control"]);
      expect(h.headers["content-type"]).toBe(g.headers["content-type"]);
      expect(h.headers["content-security-policy"]).toBe(CSP);
    }
  });

  test("unknown /api/ routes are JSON 404s, never the fallback; real API routes are untouched", async () => {
    for (const url of ["/api/nope", "/api/", "/api", "/api/conversations/x/nothing"]) {
      const r = await get(url);
      expect([url, r.statusCode, r.json()]).toEqual([url, 404, { error: "not_found" }]);
      expect(r.headers["content-security-policy"]).toBeUndefined();
    }
    const health = await get("/api/health");
    expect([health.statusCode, health.json()]).toEqual([200, { ok: true }]);
    expect((await get("/api/me")).statusCode).toBe(401);
  });

  test("other methods outside /api/ are JSON 404s", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const r = await app.inject({ method, url: "/signin", payload: method === "DELETE" ? undefined : {} });
      expect([method, r.statusCode, r.json()]).toEqual([method, 404, { error: "not_found" }]);
    }
  });

  test("no traversal out of WEB_DIST, no dotfiles, no directory listings", async () => {
    for (const url of [
      "/..%2f..%2fpackage.json",
      "/..%2foutside.json",
      "/%2e%2e/outside.json",
      "/%2e%2e/",
      "/assets/..%2f..%2foutside.json",
      "/assets/%2e%2e%2f%2e%2e%2foutside.json",
      "/%2e%2e%5coutside.json",
      "/../outside.json",
      "/.env",
      "/%2eenv",
      "/assets/../.env",
      "/empty-dir/",
      "/empty-dir",
      "/assets/",
      "/assets",
      "/index.html%00",
    ]) {
      const r = await get(url);
      expect([url, r.body.includes(SECRET), r.body.includes("agent-family-service")]).toEqual([url, false, false]);
      expect([url, r.statusCode < 500]).toEqual([url, true]);
      // matches no file: the client's page, not a listing
      if (r.statusCode === 200) expect([url, r.body]).toEqual([url, INDEX]);
    }
  });

  test("the origin check and sessions still apply (static routes do not shadow the API)", async () => {
    const cross = await app.inject({ method: "POST", url: "/api/register", headers: { origin: "https://evil.example.test" }, payload: {} });
    expect([cross.statusCode, cross.json()]).toEqual([403, { error: "forbidden" }]);
    const a = await signUp(app, "web_user");
    expect((await api(app, a, "GET", "/api/me")).status).toBe(200);
  });

  test("API JSON gets nosniff and no-store; routes with their own cache header keep it", async () => {
    const h = await get("/api/health");
    expect(h.headers["x-content-type-options"]).toBe("nosniff");
    expect(h.headers["cache-control"]).toBe("no-store");
    const nf = await get("/api/nope");
    expect([nf.headers["x-content-type-options"], nf.headers["cache-control"]]).toEqual(["nosniff", "no-store"]);
    // a route that sets its own header keeps it (the attachment routes: private, no-store; avatars: private, max-age=60)
    const a = await signUp(app, "avatar_user");
    const avatar = await app.inject({ method: "GET", url: `/api/principals/${a.id}/avatar`, headers: { cookie: a.cookie } });
    expect([avatar.statusCode, avatar.headers["cache-control"], avatar.headers["x-content-type-options"]]).toEqual([
      200,
      "private, max-age=60",
      "nosniff",
    ]);
  });

  test("a WebSocket still upgrades on /api/ws, and a plain GET there is not the page", async () => {
    const a = await signUp(app, "ws_user");
    const socket = await connect(app, a);
    expect(socket.isClosed).toBe(false);
    socket.close();
    expect((await socket.closed).code).toBeGreaterThan(0);
    const plain = await get("/api/ws");
    expect([plain.statusCode < 500, plain.body.includes("<!doctype")]).toEqual([true, false]);
    expect(plain.headers["content-security-policy"]).toBeUndefined();
  });

  test("the static routes are not part of app.routeList (it lists the API; README and fuzz suites walk it)", () => {
    expect(app.routeList.filter((r) => !r.url.startsWith("/api/"))).toEqual([]);
  });
});

describe("HSTS follows APP_ORIGIN", () => {
  const { app } = useApp({ env: { WEB_DIST: dist, APP_ORIGIN: "https://family.example.test" } });
  test("https adds Strict-Transport-Security, and the CSP names the wss origin", async () => {
    const r = await app.inject({ method: "GET", url: "/signin" });
    expectSecurityHeaders(r.headers, true, csp("wss://family.example.test"));
  });
});

describe("WEB_DIST unset", () => {
  const { app } = useApp();
  test("nothing is served: JSON 404 everywhere outside the API, no page headers", async () => {
    for (const url of ["/", "/signin", "/index.html", "/favicon.svg"]) {
      const r = await app.inject({ method: "GET", url });
      expect([url, r.statusCode, r.json()]).toEqual([url, 404, { error: "not_found" }]);
      expect(r.headers["content-security-policy"]).toBeUndefined();
    }
    expect((await app.inject({ method: "GET", url: "/api/health" })).json()).toEqual({ ok: true });
  });
  test("API responses still carry nosniff and no-store", async () => {
    const r = await app.inject({ method: "GET", url: "/api/health" });
    expect([r.headers["x-content-type-options"], r.headers["cache-control"]]).toEqual(["nosniff", "no-store"]);
  });
});

describe("WEB_DIST configuration", () => {
  const base = { DATABASE_URL: "postgres://x/y", APP_ORIGIN: "http://localhost:5173", AUTH_SECRET: "x".repeat(32), PROVIDER_KEY_SECRET: "p".repeat(32) };
  test("unset or empty means off; a value is resolved to an absolute path", () => {
    expect(loadConfig({ ...base }).webDist).toBeUndefined();
    expect(loadConfig({ ...base, WEB_DIST: "" }).webDist).toBeUndefined();
    expect(path.isAbsolute(loadConfig({ ...base, WEB_DIST: "./some/dist" }).webDist!)).toBe(true);
  });
  const { app } = useApp();
  test("a missing directory, or one without index.html, stops start-up with a message naming WEB_DIST", async () => {
    for (const bad of [path.join(outer, "nope"), path.join(dist, "empty-dir")]) {
      const config = { ...app.deps.config, webDist: bad };
      await expect(buildApp({ config, db: app.deps.db })).rejects.toThrow(/WEB_DIST/);
    }
  });
});
