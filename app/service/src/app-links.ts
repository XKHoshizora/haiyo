import type { FastifyInstance } from "fastify";
import type { AppleConfig } from "./config.ts";
import { notFound } from "./errors.ts";

/**
 * Where Apple reads which of the site's links open in the iOS app (universal links). Apple's documentation names this URL
 * only — "place it in your site's .well-known directory", `https://<fully qualified domain>/.well-known/apple-app-site-association`,
 * "using https:// with a valid certificate and with no redirects" — and since iOS 14 devices ask Apple's CDN for it, not
 * the site (developer.apple.com/documentation/xcode/supporting-associated-domains, read 2026-11-23). So the root path is
 * not served.
 */
export const APP_LINKS_PATH = "/.well-known/apple-app-site-association";

/**
 * The file's JSON for the app: the paths the iOS app takes (docs/design/2026-11-24-store-app-draft.md, S1) — a
 * conversation (`/chat/<id>`, the web client's own path for it) and a password reset link (`/reset-password?token=…`);
 * nothing under `/api/` (an e-mail verification link goes there and stays in the browser). The exclusion comes first:
 * the system takes the first pattern that matches.
 */
export function appLinksFile(app: NonNullable<AppleConfig["app"]>): string {
  return JSON.stringify({
    applinks: {
      details: [
        {
          appIDs: [`${app.teamId}.${app.bundleId}`],
          components: [{ "/": "/api/*", exclude: true }, { "/": "/chat/*" }, { "/": "/reset-password*" }],
        },
      ],
    },
  });
}

/**
 * `GET /.well-known/apple-app-site-association` (and its HEAD): the file as `application/json` when `APPLE_TEAM_ID` and
 * `APPLE_BUNDLE_ID` are set, else the JSON 404 — never the web client's page, which its wildcard (src/web.ts) would
 * otherwise send for this extensionless path. Registered whether or not the web client is served: the file belongs to
 * the domain. Not an API route: kept out of `app.routeList`, as the web client's wildcard is.
 */
export function registerAppLinks(app: FastifyInstance): void {
  const configured = app.deps.config.apple.app;
  // Bytes, so the type goes out exactly as `application/json` (Fastify adds a charset to a string's).
  const body = configured ? Buffer.from(appLinksFile(configured)) : null;
  app.route({
    method: "GET", // Fastify derives the HEAD
    url: APP_LINKS_PATH,
    config: { webClient: true },
    handler: async (_req, reply) => {
      if (body === null) throw notFound();
      // Chosen, not the API's `no-store`: the file changes only with a deploy, and Apple's CDN fetches it about daily anyway.
      return reply.headers({ "content-type": "application/json", "cache-control": "public, max-age=3600" }).send(body);
    },
  });
}
