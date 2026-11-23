import { statSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance, FastifyReply } from "fastify";
import { notFound } from "./errors.ts";

declare module "fastify" {
  interface FastifyContextConfig {
    /** Set on the routes that serve the site's files, not the API (the web client's, src/app-links.ts), so `app.routeList` (the API) can leave them out. */
    webClient?: boolean;
  }
}

const CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** Vite writes its bundles, and copies everything from `public/assets/`, into this directory. */
const ASSETS_DIR = "assets";
/**
 * What Vite 8 adds to a bundle's name: `-` and 8 base64url characters (`index-CdhHuwFq.js`). A hand-named
 * file can look the same (`brand-v2-notes.md`), so the 8 characters must also contain a capital letter,
 * which real names do not; the ~1.5% of hashes without one are merely revalidated (safe, never wrong).
 */
const CONTENT_HASH = /-(?=[a-z0-9_-]{0,7}[A-Z])[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/;
/** A last path segment with an extension: a request for a file, never for a client page. */
const HAS_EXTENSION = /\.[^./]+$/;

function pageHeaders(appOrigin: string): Record<string, string> {
  const origin = new URL(appOrigin);
  // `'self'` should cover the same-host WebSocket (CSP level 3) but older Safari does not match it: name it.
  const socket = `${origin.protocol === "https:" ? "wss:" : "ws:"}//${origin.host}`;
  return {
    "content-security-policy": CSP.replace("connect-src 'self'", `connect-src 'self' ${socket}`),
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
    "x-frame-options": "DENY",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    ...(new URL(appOrigin).protocol === "https:" ? { "strict-transport-security": "max-age=15552000" } : {}),
  };
}

/**
 * The path the request names, relative to the web root, as clean segments: empty and `.` segments dropped,
 * and null for anything that could leave the root or reach a dotfile (`..`, a name starting with `.`, a
 * backslash, a NUL). Null and "no such file" are answered alike.
 */
function segmentsOf(wildcard: string): string[] | null {
  const segments: string[] = [];
  for (const s of wildcard.split("/")) {
    if (s === "" || s === ".") continue;
    if (s.startsWith(".") || s.includes("\\") || s.includes("\0")) return null;
    segments.push(s);
  }
  return segments;
}

/**
 * Serves the built web client (`WEB_DIST`) from the same origin as the API: files from the directory, and
 * `index.html` for any other extensionless GET/HEAD outside `/api/` and `/assets/` so the client's own router can take the path. Nothing
 * under `/api/` ever falls back: an unknown API route stays a JSON 404. The route is one wildcard, not a
 * route per file, and is kept out of `app.routeList`, which lists the API (README and fuzz suites walk it).
 */
export async function registerWebClient(app: FastifyInstance): Promise<void> {
  const root = app.deps.config.webDist;
  if (root === undefined) return;
  let hasIndex = false;
  try {
    hasIndex = statSync(path.join(root, "index.html")).isFile();
  } catch {
    // reported below
  }
  if (!hasIndex) throw new Error(`Invalid configuration: WEB_DIST (${root}) must be a directory containing index.html`);

  const headers = pageHeaders(app.deps.config.appOrigin);
  // serve:false: only `reply.sendFile` (ranges, ETag, HEAD, content types); the route below decides what is sent.
  // dotfiles: the plugin's default is to serve them; Cache-Control is set here, not by the plugin.
  await app.register(fastifyStatic, { root, serve: false, dotfiles: "ignore", cacheControl: false, index: false });

  const sendPage = (reply: FastifyReply, file: string) => {
    // Only a name that carries a content hash can never change; unhashed files (index.html, copies of public/) revalidate.
    const hashed = file.startsWith(`${ASSETS_DIR}/`) && CONTENT_HASH.test(file);
    void reply.headers({ ...headers, "cache-control": hashed ? "public, max-age=31536000, immutable" : "no-cache" });
    return reply.sendFile(file);
  };

  app.route<{ Params: { "*": string } }>({
    method: "GET", // Fastify derives the HEAD
    url: "/*",
    config: { webClient: true },
    handler: async (req, reply) => {
      const wildcard = req.params["*"];
      // Decided on the first real segment, before any other rule: `/api/..`, `/api/.x` are API paths too.
      if (wildcard.split("/").find((s) => s !== "" && s !== ".") === "api") throw notFound();
      const segments = segmentsOf(wildcard);
      if (segments !== null && segments.length > 0) {
        const info = await stat(path.join(root, ...segments)).catch(() => null);
        if (info?.isFile()) return sendPage(reply, segments.join("/"));
      }
      // A missing file is a 404, not a page: a stale tab's import() of an old chunk must fail plainly, and no
      // proxy may keep 200 HTML under a .js URL. Only extensionless paths are client routes.
      const last = wildcard.split("/").filter((x) => x !== "").at(-1) ?? "";
      const firstSegment = wildcard.split("/").find((x) => x !== "" && x !== ".");
      if (firstSegment === ASSETS_DIR || HAS_EXTENSION.test(last)) {
        return reply.code(404).header("cache-control", "no-store").send({ error: "not_found" });
      }
      return sendPage(reply, "index.html");
    },
  });
}
