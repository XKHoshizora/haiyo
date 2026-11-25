// Where the suite runs and what it talks to. Local mode (the default) runs the real service on a port of its
// own; remote mode (E2E_BASE_URL set) talks to a deployed environment and starts nothing.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

export const E2E_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const WEB_DIR = path.resolve(E2E_DIR, "..");
export const SERVICE_DIR = path.resolve(WEB_DIR, "..", "service");
/** Playwright's output directory (git-ignored); the local service writes its log here. */
export const OUTPUT_DIR = path.join(E2E_DIR, "test-results");

const remoteBase = (process.env.E2E_BASE_URL ?? "").trim().replace(/\/+$/, "");

/** True when the suite runs against a deployed environment (E2E_BASE_URL). */
export const REMOTE = remoteBase !== "";
/** The local service's port (8787 and 5273 belong to the developer's servers). */
export const PORT = Number(process.env.E2E_PORT ?? 8911);
/** The one origin the browsers talk to: pages, API and WebSocket. */
export const BASE_URL = REMOTE ? remoteBase : `http://127.0.0.1:${PORT}`;
/**
 * The database the local suite owns: `af_e2e`, or the name in `E2E_DATABASE` (a second run beside another, with its own
 * `E2E_PORT`): lower-case, ending in `_e2e` (the e2e service starts on no other, e2e-server.ts), so never af_dev or
 * af_test, and at most 63 bytes (Postgres would cut a longer name on `create` and then find no database by the whole
 * one). Created on the server of TEST_DATABASE_URL when it does not exist yet; an existing one is migrated and emptied
 * (system.mjs `freshDatabase`, README).
 */
export const E2E_DATABASE = (() => {
  const name = (process.env.E2E_DATABASE ?? "af_e2e").trim();
  if (!/^[a-z0-9_]+_e2e$/.test(name)) throw new Error("E2E_DATABASE must be a lower-case database name ending in _e2e");
  if (name.length > 63) throw new Error("E2E_DATABASE must be at most 63 characters (Postgres's limit for a name)");
  return name;
})();

/**
 * The local suite's database URL: the server, role and password of TEST_DATABASE_URL (the environment, else
 * app/service/.env) with the database name replaced by E2E_DATABASE (af_e2e by default). Never printed. `name`: another database of
 * that server (the maintenance database `postgres`, to create the suite's own).
 */
export function e2eDatabaseUrl(name = E2E_DATABASE) {
  let source = process.env.TEST_DATABASE_URL;
  if (!source) {
    let text;
    try {
      text = readFileSync(path.join(SERVICE_DIR, ".env"), "utf8");
    } catch {
      throw new Error("TEST_DATABASE_URL is not set and app/service/.env cannot be read");
    }
    source = parseEnv(text).TEST_DATABASE_URL;
  }
  if (!source) throw new Error("TEST_DATABASE_URL is missing from app/service/.env");
  const url = new URL(source);
  url.pathname = `/${name}`;
  return url.toString();
}

/** Service configuration variables a developer's shell might carry; the suite sets its own or none. */
const SERVICE_KEYS = [
  "DATABASE_URL",
  "TEST_DATABASE_URL",
  "APP_ORIGIN",
  "AUTH_SECRET",
  "BLOB_DIR",
  "WEB_DIST",
  "PORT",
  "HOST",
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "REGISTRATION_MODE",
  "MAIL_MODE",
  "RATE_LIMIT_SCALE",
  "CLIENT_IP_HEADER",
  "TRUST_PROXY",
  "ATTACHMENT_QUOTA_BYTES",
  "UPLOAD_IDLE_TIMEOUT_MS",
  "UPLOAD_TOTAL_TIMEOUT_MS",
  "HTTP_CONNECTION_TIMEOUT_MS",
  "HTTP_REQUEST_TIMEOUT_MS",
  "HTTP_KEEP_ALIVE_TIMEOUT_MS",
  "DB_STATEMENT_TIMEOUT_MS",
  "DB_ACQUIRE_TIMEOUT_MS",
  "SEARCH_STATEMENT_TIMEOUT_MS",
  "SWEEP_INTERVAL_MINUTES",
  "HTTP_BODY_TIMEOUT_MS",
  "PROVIDER_KEY_SECRET",
  "SITE_MODELS",
  "JUDGE",
  "PROACTIVE",
  "TOOLS",
  "HOLDS",
  "ALLOWANCE",
  "WHISPERS",
  "SOCIAL",
  "OTHERS",
  "AGENTS",
  "LEGAL",
  "FREE_DAILY_POINTS",
  "SITE_TIMEZONE",
  "AGENT_TIERS",
  "AGENT_MAX_CONCURRENT_RUNS",
  "AGENT_MAX_CONCURRENT_OTHERS_RUNS",
  "AGENT_RUNS_PER_MINUTE",
  "AGENT_OTHERS_RUNS_PER_MINUTE",
  "AGENT_CALLER_RUNS_PER_MINUTE",
  "AGENT_RUN_TIMEOUT_MS",
  "MODEL_CALL_CEILING_MS",
  "PROVIDER_DEFAULT_CONTEXT_TOKENS",
  "PROVIDER_DEFAULT_MAX_OUTPUT_TOKENS",
  "PROVIDER_MAX_CONCURRENT_CALLS",
  "AGENT_MAX_RUNS_IN_FLIGHT",
  "AGENT_CHAIN_LIMIT",
  "AGENT_GROUP_CONTEXT_TOKENS",
  "REASONING_ALLOWANCE_TOKENS",
  "ATTACHMENT_MAX_BYTES",
  "APPLE_TEAM_ID",
  "APPLE_BUNDLE_ID",
  "APNS_KEY_ID",
  "APNS_KEY_P8",
];

/**
 * A fixed, obviously fake secret for the local suite's provider keys at rest (the service refuses to start without
 * one of at least 32 characters). The suite's provider keys are fake too; nothing real is ever sealed with it.
 */
export const E2E_PROVIDER_KEY_SECRET = "e2e-provider-key-secret-not-a-real-one-0000";

/** The process environment without any service configuration or suite variable, plus `extra`. */
export function serviceEnv(extra) {
  const env = { ...process.env };
  for (const key of SERVICE_KEYS) delete env[key];
  for (const key of Object.keys(env)) if (key.startsWith("E2E_")) delete env[key];
  return { ...env, ...extra };
}

/** Environment for the service's CLI (migrate, invite:create, inbox:list, credits:grant) against the suite's database. */
export const cliEnv = () => serviceEnv({ DATABASE_URL: e2eDatabaseUrl() });
