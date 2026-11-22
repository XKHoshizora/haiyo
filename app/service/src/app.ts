import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyRequest, type FastifySchema } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { z } from "zod";
import { loadConfig, type Config } from "./config.ts";
import { createDb, type Db } from "./db.ts";
import { ANSWER_FLOOR, type AnswerFloor } from "./auth/answer-floor.ts";
import { createAuth, createSessionEvents, registerAuthRoutes, type Auth, type SessionEvents } from "./auth/auth.ts";
import { registerRegistrationRoutes } from "./auth/register.ts";
import { AppError, frameworkErrors, registerErrorHandling } from "./errors.ts";
import { registerSessionRoutes } from "./session.ts";
import { createBlobStore, type BlobStore } from "./attachments/blob.ts";
import { registerBodyDeadline } from "./body-deadline.ts";
import { runSweep, startSweeper } from "./attachments/sweeper.ts";
import { configureStats } from "./memory/stats.ts";
import { sweepMemoryChanges } from "./memory/sweep.ts";
import { registerAttachmentRoutes } from "./attachments/routes.ts";
import { createUploadSlots, type UploadSlots } from "./attachments/slots.ts";
import { registerAccountRoutes } from "./accounts/routes.ts";
import { leaveGroupsOfDeleted } from "./agents/group-leave.ts";
import { endMemoryCalls } from "./memory/call.ts";
import { runSummary } from "./agents/summary/job.ts";
import { runDreamJob } from "./memory/dream.ts";
import { runCatchUp } from "./memory/catchup.ts";
import { runFlags } from "./memory/hearsay.ts";
import { runReview } from "./memory/pipeline.ts";
import { setModelEntryMax } from "./memory/clean.ts";
import { createReviewer, realTimer, type Reviewer, type SetTimer } from "./memory/reviewer.ts";
import { createAgentPort, recoverRuns, startStaleRunSweep, sweepStaleRuns, type DbAgentPort } from "./agents/port-impl.ts";
import { createElsewhere } from "./agents/tools/elsewhere.ts";
import { createToolbox } from "./agents/tools/index.ts";
import { deepseekEngine, exaEngine, type WebEngine } from "./agents/tools/web/engine.ts";
import { sweepSearchDays } from "./agents/tools/web/hold.ts";
import { decideProactive } from "./agents/proactive/decide.ts";
import { createProactiveScheduler, type ProactiveScheduler } from "./agents/proactive/scheduler.ts";
import { actOnTriggered } from "./agents/runs.ts";
import { registerRunRoutes } from "./agents/run-routes.ts";
import { registerAgentRoutes } from "./agents/routes.ts";
import { registerMemoryRoutes } from "./memory/routes.ts";
import { createAgentWorker, SHUTDOWN_GRACE_MS, within, type AgentWorker } from "./agents/runtime/worker.ts";
import { registerPrincipalRoutes } from "./principals/routes.ts";
import { createJudge, type Judge } from "./judge/client.ts";
import { createMailSender, type MailSender } from "./auth/mail-sender.ts";
import { createModelGateway, type ModelGateway } from "./models/gateway.ts";
import { registerModelRoutes } from "./models/routes.ts";
import { guardedFetch } from "./providers/guard.ts";
import { createProviderProbe, PROBE_GUARD, type ProviderProbe } from "./providers/probe.ts";
import { registerProviderRoutes } from "./providers/routes.ts";
import { createSocialEvents, type SocialEvents } from "./social/events.ts";
import { registerSocialRoutes } from "./social/routes.ts";
import { createConversationEvents, type ConversationEvents } from "./conversations/events.ts";
import { registerConversationRoutes } from "./conversations/routes.ts";
import { createReadEvents, type ReadEvents } from "./messages/read.ts";
import { registerMessageRoutes } from "./messages/routes.ts";
import { MAX_CONCURRENT_SEARCHES, MAX_SEARCHES_IN_FLIGHT } from "./messages/search.ts";
import { clientIp, perPrincipalLimit } from "./limits.ts";
import { appOriginCheck } from "./origin.ts";
import { createSlots, type Slots } from "./slots.ts";
import type { Hub } from "./sync/hub.ts";
import { registerSync } from "./sync/routes.ts";
import { registerWebClient } from "./web.ts";
import { pushWhispers, registerWhisperRoutes } from "./whispers/routes.ts";
import { expireWhispers, removeOldWhispers } from "./whispers/store.ts";
import { deliverReminders } from "./metering/reminders.ts";

/** Everything the app needs from outside; tests override pieces (e.g. raised rate limits). */
export interface Deps {
  config: Config;
  db: Db;
  /** Where avatars and attachments live; tests inject a temp-dir store. */
  blobs: BlobStore;
  /** Per-app registry of "friendships/blocks changed" listeners; fired after commit. */
  social: SocialEvents;
  /** Per-app registry of "messages stored" / "membership changed" listeners; fired after commit. */
  conversations: ConversationEvents;
  /** Per-app registry of "a direct-chat read marker moved" listeners; fired after the update. */
  reads: ReadEvents;
  /** Per-app registry of "a session was deleted" listeners (sign-out, password reset, expiry cleanup). */
  sessions: SessionEvents;
  /** Uploads in progress per principal (at most 3 each). */
  uploads: UploadSlots;
  /** Searches in progress per principal (at most 2 each, 4 for everyone together). */
  searches: Slots;
  /** How `POST /api/providers/:id/test` and `…/models/refresh` reach a provider (default: a GET of its model list through `guardedFetch`). */
  providerProbe: ProviderProbe;
  /** How the service talks to a language model (default: the AI SDK through `guardedFetch`); tests inject a scripted one. */
  models: ModelGateway;
  /** The judgement model (src/judge/client.ts); null when `JUDGE` is not configured. Tests inject a scripted one. */
  judge: Judge | null;
  /**
   * When a person's message in a group is judged for an unasked reply (src/agents/proactive/scheduler.ts); built with the
   * reply worker's port, and null without a judgement model (and in tests unless they ask, `BuildOptions.proactive`).
   */
  proactive: ProactiveScheduler | null;
  /**
   * What an Agent remembers, decided in the background (src/memory/reviewer.ts); built with the reply worker's port, and
   * null in tests unless they ask (`BuildOptions.memory`).
   */
  memory: Reviewer | null;
  /**
   * The web search's engine (src/agents/tools/web/engine.ts): built when `TOOLS.web.enabled` and the variable its
   * `apiKeyEnv` names holds a key; null otherwise (the default) — then no reply is offered web search and nothing shows
   * it (`GET /api/models` has no `webSearchAvailable`). Tests inject a fake one; none ever calls a real engine.
   */
  webEngine: WebEngine | null;
}

/** One registered route (a GET also yields its HEAD), as declared: method, URL pattern and schema. */
export interface RouteEntry {
  method: string;
  url: string;
  schema: FastifySchema | undefined;
  websocket: boolean;
  /** A HEAD Fastify derived from the GET of the same URL (same handler, no body sent). */
  derived: boolean;
}

declare module "fastify" {
  interface FastifyInstance {
    deps: Deps;
    auth: Auth;
    /** The in-process socket registry and push delivery (src/sync/hub.ts). */
    realtime: Hub;
    /** Every route the app serves, in registration order (diagnostics; the fuzz suite walks it). */
    routeList: readonly RouteEntry[];
    /** The reply worker's port (src/agents/port-impl.ts): routes announce runs and reach a run in flight through it. */
    agentPort: DbAgentPort;
    /** The reply worker (src/agents/runtime/worker.ts); with `agentWorker: false` tests run replies with `runOnce()`. */
    agentWorker: AgentWorker;
    /** The stale-run sweep (src/agents/port-impl.ts `sweepStaleRuns`): `run()` sweeps now; the timer does it every minute. */
    staleRunSweep: { run(): Promise<number> };
    /** Delivers queued mail in `resend` mode (src/auth/mail-sender.ts); in `outbox` mode `runOnce()` does nothing. */
    mailSender: MailSender;
  }
}

const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** What is not a dependency of the routes: where the log goes. */
export interface BuildOptions {
  /** JSON log lines at info level go here (tests capture them). Default: stdout, and nothing under test. */
  logStream?: { write(line: string): void };
  /** Delay before the first scheduled attachment sweep (default one minute); tests shorten it. */
  sweepInitialDelayMs?: number;
  /** The least time a registration's or reset request's success takes (default `ANSWER_FLOOR`); tests shorten it. */
  answerFloor?: AnswerFloor;
  /**
   * Tests only, and deliberately not configuration (no variable can set it): providers may then be reached at
   * loopback addresses, and over plain `http:` there, so tests can stand up a local stub (src/providers/guard.ts).
   */
  allowInsecureLocal?: boolean;
  /**
   * Tests only: `false` turns the reply worker's background loop off (no polling, no wake-ups); replies then run only
   * when the test calls `app.agentWorker.runOnce()` or `drain()`.
   */
  agentWorker?: false;
  /**
   * The stale-run sweep's timer (default: first a minute after start, then every minute). Tests: `false` turns it off
   * (`app.staleRunSweep.run()` still sweeps by hand), or shorter delays.
   */
  staleRunSweep?: false | { initialDelayMs?: number; intervalMs?: number };
  /**
   * The proactive scheduler (`Deps.proactive`), built when the judgement model is configured, waiting
   * `PROACTIVE.debounceMs`. Tests: `false` builds none, `{ delayMs }` a shorter wait.
   */
  proactive?: false | { delayMs?: number };
  /**
   * The reviewer (`Deps.memory`), built always: whose model a call uses (the owner's own choice, else the site's) is decided per call (`memoryCall`), and one with none to call does nothing. Tests: `false` builds none, and
   * `{ now, setTimer }` run its quiet timers on their own clock (tests/helpers/harness.ts `testClock`).
   */
  memory?: false | { now?: () => number; setTimer?: SetTimer };
  /**
   * Tests only: `apiUrl` points the mail sender at a local stand-in for the provider (no variable can set it), `sender: false` turns its
   * timer off (`app.mailSender.runOnce()` delivers by hand), `{ intervalMs }` shortens it. Used only in `MAIL_MODE=resend`.
   */
  mail?: { apiUrl?: string; callTimeoutMs?: number; refusedPauseMs?: number; sender?: false | { intervalMs?: number } };
  /**
   * The tools replies may be offered (src/agents/tools/index.ts `createToolbox`; whether a reply is offered them is
   * `begin`'s: `TOOLS.enabled`, its model), built always. Tests: `false` builds none, so every reply is the one call it
   * was before tools (tests/helpers/harness.ts builds none unless a test asks).
   */
  tools?: false;
  /**
   * A new Agent's first reply, which greets its owner (src/agents/conversation.ts `createAgent`), queued at creation:
   * default on. Tests: `false` queues none (tests/helpers/harness.ts queues none unless a test asks), so a test's first
   * reply is the one it scripts.
   */
  greeting?: false;
  /**
   * The realtime hub's heartbeat timer (src/sync/hub.ts `tick`: pings, and closes the sockets of expired sessions; default
   * every `HEARTBEAT_MS`). Tests: `false` turns the timer off (`app.realtime.tick()` beats by hand), as the harness does, so
   * that no timer starts a statement while it empties the database between two tests.
   */
  heartbeat?: false;
}

/**
 * A URL as it may be logged: without its query string, which carries WebSocket tickets, e-mail
 * verification tokens and search terms. Only `?[redacted]` shows that there was one.
 */
/**
 * One run of the sweep on the memory changes' timer (`MEMORY.changesSweepMs`). Each step's failure is logged (a code, never a
 * note or a whisper) and the next goes on:
 * - the record of what memory changed, kept 30 days (memory/sweep.ts);
 * - whispers left open 7 days expire — a `found_elsewhere` one a day (`WHISPERS.elsewhereTtlHours`) — (whispers/store.ts),
 *   each pushed to its owner (never logged; a failed told reply's slot follows its push, sync/hub.ts); answered and
 *   expired ones made 30 days ago are deleted;
 * - reminders about money recorded by a settlement whose whisper was never made (the service stopped between the two) are
 *   made, pushed and counted (metering/reminders.ts `deliverReminders`);
 * - the web search's counts of site days more than a week old are deleted (agents/tools/web/hold.ts `sweepSearchDays`).
 * `hub` null: nobody to tell yet.
 */
export async function changeSweep(deps: Pick<Deps, "db">, config: Config, log: FastifyBaseLogger, hub: Pick<Hub, "pushWhisper"> | null): Promise<{ unsent: number; abandoned: number }> {
  await sweepMemoryChanges(deps.db).catch((err: unknown) => log.warn({ code: (err as { code?: string }).code }, "memory change sweep failed; trying again next interval"));
  const expired = await expireWhispers(deps.db, new Date(), { elsewhereTtlHours: config.whispers.elsewhereTtlHours }).catch((err: unknown) => {
    log.warn({ code: (err as { code?: string }).code }, "whisper sweep failed; trying again next interval");
    return [];
  });
  await removeOldWhispers(deps.db).catch((err: unknown) => log.warn({ code: (err as { code?: string }).code }, "whisper clean-up failed; trying again next interval"));
  const reminded = await deliverReminders(deps.db, config, log).catch((err: unknown) => {
    log.warn({ code: (err as { code?: string }).code }, "reminder sweep failed; trying again next interval");
    return [];
  });
  for (const r of reminded) log.info({ metric: r.metric }, "a reminder about money was made for its owner");
  await sweepSearchDays(deps.db, new Date(), config.siteTimezone).catch((err: unknown) => log.warn({ code: (err as { code?: string }).code }, "web search count sweep failed; trying again next interval"));
  if (hub) pushWhispers(hub, [...expired, ...reminded.flatMap((r) => (r.whisper ? [r.whisper] : []))]);
  return { unsent: 0, abandoned: 0 };
}

/**
 * The web search's engine for `config` (src/agents/tools/web/engine.ts; `TOOLS.web.engine`, Exa by default): none while `TOOLS.web.enabled` is false (the
 * default: nothing is logged); with it on but no key in the variable its `apiKeyEnv` names, none either, and one line at
 * start says so (the variable's name, never a value) — the search is simply not offered; nor with a fuse of 0
 * (`siteUsdPerDay`), which would refuse every search. The key is read once, here.
 */
export function webEngineOf(
  config: Config,
  log: { info(details: Record<string, unknown>, msg: string): void; warn(details: Record<string, unknown>, msg: string): void },
): WebEngine | null {
  const web = config.tools.web;
  if (!web.enabled) return null;
  // A fuse of nothing would refuse every search: not offered at all, and said once (review M1).
  if (web.siteUsdPerDay === 0) {
    log.warn({ metric: "web_search_off", siteUsdPerDay: 0 }, "web search: TOOLS.web.siteUsdPerDay is 0, so every search would be refused; it is not offered");
    return null;
  }
  const apiKey = process.env[web.apiKeyEnv];
  if (apiKey === undefined || apiKey.trim() === "") {
    log.warn({ metric: "web_search_off", apiKeyEnv: web.apiKeyEnv }, "web search: TOOLS.web.enabled is on but its key variable is not set; it is not offered");
    return null;
  }
  const common = { baseUrl: web.baseUrl, apiKey: apiKey.trim(), timeoutMs: web.timeoutMs, maxResults: web.maxResults, log };
  // `TOOLS.web.engine`: Exa's search (the default) or DeepSeek's.
  return web.engine === "exa_search" ? exaEngine({ ...common, type: web.exaType }) : deepseekEngine({ ...common, model: web.model, timeZone: config.siteTimezone });
}

export function redactQuery(url: string): string {
  const q = url.indexOf("?");
  return q < 0 ? url : `${url.slice(0, q)}?[redacted]`;
}

/**
 * A request's address for the log: without its query, and without a file name. `/api/attachments/:id/:name` carries the
 * attachment's name (user content) in its path, so it is logged as its pattern. (Every other route with a path parameter has an
 * id or a number there: tests/logging.test.ts.)
 */
export function redactUrl(url: string): string {
  return redactQuery(url).replace(/^(\/api\/attachments\/[^/?]+)\/[^?]*/, "$1/[name]");
}

/** Fastify's default request serializer, minus the query string and a file name. */
const logSerializers = {
  req: (req: FastifyRequest) => ({
    method: req.method,
    url: redactUrl(req.url),
    host: req.host,
    remoteAddress: clientIp(req),
    remotePort: req.socket?.remotePort,
  }),
};

export async function buildApp(overrides: Partial<Deps> = {}, options: BuildOptions = {}): Promise<FastifyInstance> {
  const config = overrides.config ?? loadConfig();
  // The longest note a model may write is a number of the configuration that a pure function (`modelNote`) reads.
  setModelEntryMax(config.memory.modelEntryMax);
  const ownsDb = overrides.db === undefined;
  const insecureLocal = options.allowInsecureLocal === true ? { allowInsecureLocal: true } : {};
  // One count of the calls to providers and site models in flight, for every guard the app builds.
  const providerCalls = createSlots(config.providerMaxConcurrentCalls);
  const deps: Deps = {
    config,
    db:
      overrides.db ??
      createDb(config.databaseUrl, { statementTimeoutMs: config.dbStatementTimeoutMs, acquireTimeoutMs: config.dbAcquireTimeoutMs }),
    blobs: overrides.blobs ?? createBlobStore(config),
    social: overrides.social ?? createSocialEvents(),
    conversations: overrides.conversations ?? createConversationEvents(),
    reads: overrides.reads ?? createReadEvents(),
    sessions: overrides.sessions ?? createSessionEvents(),
    uploads: overrides.uploads ?? createUploadSlots(),
    searches: overrides.searches ?? createSlots(MAX_CONCURRENT_SEARCHES, MAX_SEARCHES_IN_FLIGHT),
    providerProbe: overrides.providerProbe ?? createProviderProbe(guardedFetch({ ...PROBE_GUARD, ...insecureLocal, calls: providerCalls })),
    models: overrides.models ?? createModelGateway({ ...insecureLocal, calls: providerCalls }),
    judge: overrides.judge !== undefined ? overrides.judge : config.judge ? createJudge(config.judge, insecureLocal) : null,
    // Built with the reply worker's port, below.
    proactive: null,
    memory: null,
    // Built once the app's log is there, below (its log line, and the line saying why there is none).
    webEngine: overrides.webEngine ?? null,
  };

  const underTest = process.env.NODE_ENV === "test" || Boolean(process.env.VITEST);
  const app = Fastify({
    logger: options.logStream
      ? { level: "info", stream: options.logStream, serializers: logSerializers }
      : underTest
        ? false
        : { level: "info", serializers: logSerializers },
    trustProxy: config.trustProxy,
    // Server-wide limits (WebSockets are exempt: `ws` clears the socket timeout on upgrade, and an upgraded
    // connection is no longer a request). Uploads run under their own, tighter deadlines (attachments/routes.ts);
    // everything else under the much shorter body deadline (body-deadline.ts), so `requestTimeout` is only the
    // uploads' backstop.
    connectionTimeout: config.httpConnectionTimeoutMs,
    requestTimeout: config.httpRequestTimeoutMs,
    keepAliveTimeout: config.httpKeepAliveTimeoutMs,
    frameworkErrors,
  });
  // Fastify refuses `content-type: application/json` with an empty body (400) before any route runs, but a
  // client that has no fields to send may well say "JSON" and send nothing. An empty body is "no body" (what a
  // request without a content type already is); anything else parses exactly as before, and a route that needs
  // fields still fails its own schema. Routes that declare their own parsers (avatar upload) are unaffected.
  // JSON is UTF-8 (RFC 8259): a body that says it is in another charset is refused (415) rather than read as UTF-8.
  const parseJson = app.getDefaultJsonParser("error", "error");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    const charset = /;\s*charset\s*=\s*"?([^";\s]*)"?/i.exec(req.headers["content-type"] ?? "")?.[1]?.toLowerCase();
    if (charset !== undefined && charset !== "utf-8" && charset !== "utf8") return done(new AppError(415, "invalid_request"), undefined);
    if (body === "") return done(null, undefined);
    parseJson(req, body as string, done);
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandling(app);
  // The web search's engine, unless a test gave one: only with the site switch on and its key there (else one line says so).
  if (overrides.webEngine === undefined) deps.webEngine = webEngineOf(config, app.log);

  // Before any route: an onRoute hook only sees routes registered after it.
  const routeList: RouteEntry[] = [];
  const getHandlers = new Map<string, unknown>();
  app.addHook("onRoute", (r) => {
    // The web client's wildcard (src/web.ts) is not an API route: the README and the fuzz suite walk this list.
    if (r.config?.webClient) return;
    for (const method of [r.method].flat()) {
      if (method === "GET") getHandlers.set(r.url, r.handler);
      const derived = method === "HEAD" && getHandlers.get(r.url) === r.handler;
      routeList.push({ method, url: r.url, schema: r.schema, websocket: Boolean((r as { websocket?: boolean }).websocket), derived });
    }
  });
  app.decorate("routeList", routeList);

  // Every response: no content sniffing. API JSON is also never cached (a route that sets its own
  // Cache-Control, like attachments and avatars, keeps it). The web client's files set theirs in src/web.ts.
  app.addHook("onSend", async (req, reply, payload) => {
    void reply.header("x-content-type-options", "nosniff");
    const isApi = req.routeOptions.url?.startsWith("/api/") === true;
    const isJson = String(reply.getHeader("content-type") ?? "").startsWith("application/json");
    if ((isApi || isJson) && reply.getHeader("cache-control") === undefined) void reply.header("cache-control", "no-store");
    return payload;
  });

  // Cross-site request forgery: a browser names the page that sent a request in `Origin`. Every
  // state-changing request from any other origin is refused before body parsing or any handler. It
  // deliberately looks at the method only, never at the path: the router decodes the path (`/%61pi/…`
  // reaches `/api/…`), so any decision by the raw URL could be sidestepped. Requests without `Origin`
  // (non-browser clients, same-origin GETs) pass.
  const fromApp = appOriginCheck(config.appOrigin);
  app.addHook("onRequest", async (req) => {
    if (!STATE_CHANGING.has(req.method)) return;
    const origin = req.headers.origin;
    if (origin !== undefined && !fromApp(origin)) throw new AppError(403, "forbidden");
  });

  // Slow bodies: a request must have arrived whole within HTTP_BODY_TIMEOUT_MS, unless it is an upload let in.
  // Armed on the server's `request` event, so it also covers requests refused above or by the router.
  registerBodyDeadline(app, config.httpBodyTimeoutMs);

  app.decorate("deps", deps);
  app.decorate("auth", createAuth(config, deps.db, deps.sessions, app.log));
  if (ownsDb) app.addHook("onClose", async () => deps.db.close());

  // The service is one process by design, so it sweeps unsent uploads and abandoned blobs itself.
  // Registered after the db's close hook: hooks run last-in first-out, so the timer stops (and a run in
  // flight finishes) before the pool closes.
  const sweeper = startSweeper({
    run: () => runSweep(deps, config, app.log),
    intervalMinutes: config.sweepIntervalMinutes,
    ...(options.sweepInitialDelayMs === undefined ? {} : { initialDelayMs: options.sweepInitialDelayMs }),
    log: app.log,
  });
  if (sweeper) app.addHook("onClose", async () => sweeper.stop());
  // The record of what memory changed is kept 30 days (memory/sweep.ts): its own timer, every `MEMORY.changesSweepMs` (0: none), so that it
  // runs whether or not the attachment sweep is switched off and whatever that sweep does (`changeSweep`).
  const changeSweeper = startSweeper({
    // (The hub is decorated once the app is built; a run before that has nobody to tell.)
    run: () => changeSweep(deps, config, app.log, app.hasDecorator("realtime") ? app.realtime : null),
    intervalMinutes: config.memory.changesSweepMs / 60_000,
    ...(options.sweepInitialDelayMs === undefined ? {} : { initialDelayMs: options.sweepInitialDelayMs }),
    log: app.log,
  });
  if (changeSweeper) app.addHook("onClose", async () => changeSweeper.stop());

  // The single source of throttling (Better Auth's own limiter is off). Routes that declare
  // `config.rateLimit` are counted per client address (`clientIp`); the rest use limits.ts / createRateLimit.
  await app.register(rateLimit, {
    global: false,
    keyGenerator: clientIp,
    errorResponseBuilder: () => new AppError(429, "rate_limited"),
  });
  const perMinute = { max: Math.max(1, Math.round(10 * config.rateLimitScale)), timeWindow: "1 minute" };

  // First among the routes: it registers the WebSocket plugin, whose route wrapper must see every route
  // (an upgrade request to any other route is then refused instead of answered over the raw socket).
  await registerSync(app, { heartbeat: options.heartbeat !== false });

  // The reply worker runs in this process (one instance, like the hub). Once the app is ready, the runs the previous
  // process left running are recovered and then the worker starts. It stops when the app starts closing, before the hub
  // and the database: calls in flight are abandoned and their runs ended here as recovery would end them, within
  // SHUTDOWN_GRACE_MS (what could not be written by then is left running, for the stale-run sweep or the next start).
  //
  // Proactive replies (batch 2D): once people in a group stop writing, the scheduler has the group's latest message
  // judged (`decideProactive`) and acts on the outcome as the send route does on a mention's — notices published, runs
  // announced (a queued one wakes the worker). Only with a judgement model. It is closed as the stop begins, with the
  // worker (below): nothing more is judged, and what a decision in flight then decides is dropped.
  const proactiveAsked = options.proactive === false ? null : (options.proactive ?? {});
  deps.proactive =
    overrides.proactive !== undefined
      ? overrides.proactive
      : proactiveAsked === null || deps.judge === null || config.judge === null
        ? null
        : createProactiveScheduler({
            decide: async (conversationId, seq, asked) => {
              const decided = await decideProactive({ db: deps.db, judge: deps.judge, config, log: app.log, onAsk: asked }, conversationId, seq);
              // The flags the judgement wrote are in the database: the reviewer acts on them once the group has been quiet.
              for (const f of decided.flags ?? []) deps.memory?.flagged(f.agentId, f.conversationId, f.kind);
              return decided;
            },
            // `agentPort` is declared below: the port takes the scheduler (an Agent's post cancels a wait) and this takes
            // the port. Both exist before any message is noted, so before any debounce can end and call this.
            act: (_conversationId, triggered) => {
              if (triggered.notices.length > 0) deps.conversations.publish({ messages: triggered.notices, conversations: [] }, app.log);
              actOnTriggered(triggered, { announce: (run) => agentPort.announce(run), log: app.log, realtime: app.realtime });
            },
            delayMs: proactiveAsked.delayMs ?? config.proactive.debounceMs,
            perGroupHour: config.proactive.perGroupHour,
            perSenderHour: config.proactive.perSenderHour,
            log: app.log,
          });
  const proactive = deps.proactive;
  // The memory counters (memory/stats.ts) count on the site's day and log through the app's logger.
  configureStats({ siteTimezone: config.siteTimezone, log: app.log });
  // The run ids of the memory calls this process is working on (memory/call.ts `memoryCall`'s `inFlight`): the stale-run sweep leaves them alone too.
  const memoryRuns = new Set<string>();
  // Aborted as the stop begins, before the calls are waited for: a call under way is abandoned, not finished.
  const memoryClosing = new AbortController();
  const memoryAsked = options.memory === false ? null : (options.memory ?? {});
  deps.memory =
    overrides.memory !== undefined
      ? overrides.memory
      : memoryAsked === null
        ? null
        : createReviewer({
            db: deps.db,
            config,
            log: app.log,
            closing: memoryClosing.signal,
            setTimer: memoryAsked.setTimer ?? realTimer,
            run: (job, ctx) => {
              const pipeline = { db: deps.db, config, models: deps.models, judge: deps.judge, log: app.log, inFlight: memoryRuns, conversations: deps.conversations, now: memoryAsked.now ?? Date.now };
              switch (job.kind) {
                case "review":
                  return runReview(pipeline, job, ctx);
                case "flags":
                  return runFlags(pipeline, job, ctx);
                case "catchup":
                  return runCatchUp(pipeline, job, ctx);
                case "summary":
                  return runSummary(pipeline, job, ctx);
                default:
                  return runDreamJob(pipeline, job, ctx);
              }
            },
          });
  const memory = deps.memory;
  const agentPort = createAgentPort({
    db: deps.db,
    config,
    blobs: deps.blobs,
    realtime: app.realtime,
    conversations: deps.conversations,
    reads: deps.reads,
    log: app.log,
    proactive,
    memory,
    toolbox:
      options.tools === false
        ? null
        : createToolbox({
            db: deps.db,
            blobs: deps.blobs,
            searches: deps.searches,
            config,
            log: app.log,
            // In a group, a search that found nothing there: not here, but elsewhere (Task 8).
            elsewhere: createElsewhere({ db: deps.db, config, realtime: app.realtime, log: app.log }),
            webEngine: deps.webEngine,
          }),
  });
  const agentWorker = createAgentWorker({
    port: agentPort,
    models: deps.models,
    runTimeoutMs: config.agentRunTimeoutMs,
    maxRunsInFlight: config.agentMaxRunsInFlight,
    background: options.agentWorker !== false,
    log: app.log,
    tools: config.tools,
  });
  agentPort.onQueued(() => agentWorker.wake());
  app.decorate("agentPort", agentPort);
  app.decorate("agentWorker", agentWorker);
  // The persona drafts this process is working on, by run id: the stale-run sweep leaves them alone, as it does the
  // worker's runs.
  const draftRuns = new Set<string>();
  const staleRunSweep = {
    run: (): Promise<number> => sweepStaleRuns(agentPort, deps.db, config, app.log, (id) => agentWorker.isWorking(id) || draftRuns.has(id) || memoryRuns.has(id)),
  };
  app.decorate("staleRunSweep", staleRunSweep);
  let staleTimer: { stop(): Promise<void> } | undefined;
  app.addHook("onReady", async () => {
    const recovered = await recoverRuns(deps.db, config, app.log);
    if (recovered > 0) app.log.info({ recovered }, "agent runs left running by the previous start were recovered");
    // Conversations with replies nobody has reviewed yet, and groups with flags nobody has acted on (a restart delays a review, never loses it), wait for their quiet again.
    const armed = (await memory?.resume()) ?? 0;
    if (armed > 0) app.log.info({ armed }, "conversations with replies or flags still to act on were armed");
    // A deleted Agent still in a group (its delete committed, its leaving did not happen) leaves it now.
    const left = await leaveGroupsOfDeleted({ db: deps.db, conversations: deps.conversations, log: app.log, realtime: app.realtime });
    if (left > 0) app.log.info({ left }, "deleted Agents left the groups they were still in");
    agentWorker.start();
    if (options.staleRunSweep !== false) staleTimer = startStaleRunSweep(() => staleRunSweep.run(), app.log, options.staleRunSweep ?? {});
  });
  app.addHook("onClose", async () => staleTimer?.stop());

  // Mail in `resend` mode: the rows are written with the work that causes them; this delivers them afterwards, outside every request.
  const mailSender = createMailSender({
    db: deps.db,
    settings: config.mailMode === "resend" ? config.mail : undefined,
    ...(options.mail?.apiUrl === undefined ? {} : { apiUrl: options.mail.apiUrl }),
    ...(options.mail?.callTimeoutMs === undefined ? {} : { callTimeoutMs: options.mail.callTimeoutMs }),
    ...(options.mail?.refusedPauseMs === undefined ? {} : { refusedPauseMs: options.mail.refusedPauseMs }),
    log: app.log,
  });
  app.decorate("mailSender", mailSender);
  app.addHook("onReady", async () => {
    if (options.mail?.sender !== false) mailSender.start(options.mail?.sender?.intervalMs);
  });
  app.addHook("onClose", async () => mailSender.stop());

  const answerFloor = options.answerFloor ?? ANSWER_FLOOR;
  registerRegistrationRoutes(app, perMinute, answerFloor);
  registerAuthRoutes(app, config.rateLimitScale, answerFloor);
  registerSessionRoutes(app);
  registerPrincipalRoutes(app);
  registerSocialRoutes(app);
  registerConversationRoutes(app);
  registerMessageRoutes(app);
  registerAttachmentRoutes(app);
  registerAccountRoutes(app);
  // One budget for an owner's reads of their Agents, providers and replies (GET /api/agents, /api/agents/:id,
  // /api/providers, /api/conversations/:id/run, and a group's /api/conversations/:id/runs): 120 a minute together.
  const ownReads = perPrincipalLimit(app, 120);
  const { endDrafts } = registerAgentRoutes(app, { draftRuns, readLimit: ownReads, greeting: options.greeting !== false });
  registerMemoryRoutes(app, { readLimit: ownReads });
  registerWhisperRoutes(app);
  // The service's stop ends what this process was working on — the worker's replies and the persona drafts under way —
  // together, within SHUTDOWN_GRACE_MS (agentWorker.stop bounds itself). First of all the proactive scheduler is closed,
  // so that no debounce ends in a judgement once the stop has begun; a decision in flight is waited for as long (what it
  // decides is dropped; a run it queued stays queued for the next start).
  app.addHook("preClose", async () => {
    proactive?.close();
    // No review starts from here on, and a call under way is told it is abandoned before it is waited for.
    memory?.close();
    memoryClosing.abort();
    await Promise.all([
      within(endDrafts(), SHUTDOWN_GRACE_MS).then((ended) => {
        if (!ended) app.log.warn(`persona drafts not ended within ${SHUTDOWN_GRACE_MS} ms of the stop; their runs stay running until the stale-run sweep or the next start releases them`);
      }),
      agentWorker.stop(),
      memory ? within(memory.idle(), SHUTDOWN_GRACE_MS) : undefined,
      within(endMemoryCalls(), SHUTDOWN_GRACE_MS).then((ended) => {
        if (!ended) app.log.warn(`memory calls not ended within ${SHUTDOWN_GRACE_MS} ms of the stop; their runs stay running until the stale-run sweep or the next start releases them`);
      }),
      proactive
        ? within(proactive.idle(), SHUTDOWN_GRACE_MS).then((ended) => {
            if (!ended) app.log.warn(`a proactive judgement was still in flight ${SHUTDOWN_GRACE_MS} ms after the stop; what it decides is dropped`);
          })
        : undefined,
    ]);
  });
  registerRunRoutes(app, { readLimit: ownReads });
  registerProviderRoutes(app, { allowInsecureLocal: options.allowInsecureLocal === true, readLimit: ownReads });
  registerModelRoutes(app);

  const api = app.withTypeProvider<ZodTypeProvider>();

  api.get(
    "/api/health",
    {
      schema: {
        params: z.object({}),
        querystring: z.object({}),
        response: { 200: z.object({ ok: z.literal(true) }) },
      },
    },
    async () => {
      await deps.db.query("select 1");
      return { ok: true as const };
    },
  );

  // What a page shown before sign-in needs of the site's setup (README "Site"): whether mail is really delivered, so the
  // pages that would say "we sent you a mail" tell the truth. One boolean, the same for every caller; nothing else of the
  // mail setup.
  api.get(
    "/api/site",
    {
      schema: {
        params: z.object({}),
        querystring: z.object({}),
        response: { 200: z.object({ mailDelivered: z.boolean() }) },
      },
    },
    async () => ({ mailDelivered: config.mailMode === "resend" }),
  );

  // Last: the wildcard must never get ahead of an API route (a more specific route always wins, but be explicit).
  await registerWebClient(app);

  return app;
}
