import { AsyncLocalStorage } from "node:async_hooks";
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { betterAuth } from "better-auth";
import { verifyJWT } from "better-auth/crypto";
import { fromNodeHeaders } from "better-auth/node";
import type pg from "pg";
import { z } from "zod";
import type { Config } from "../config.ts";
import type { Db, Queryable, Tx } from "../db.ts";
import { AppError, isBusy } from "../errors.ts";
import { clientIp } from "../limits.ts";
import { lockAccountEmail } from "./accounts.ts";
import { holdUntilFloor, startAnswerClock, type AnswerFloor } from "./answer-floor.ts";
import { PRODUCT_NAME } from "../brand.ts";
import { RESET_PASSWORD_TTL_SECONDS, VERIFY_EMAIL_TTL_SECONDS, resetPasswordMail, verifyEmailMail } from "./mail-copy.ts";
import { mailPolicy, sendMail } from "./mailer.ts";

export const AUTH_BASE_PATH = "/api/auth";
const SESSION_LIFETIME_SECONDS = 7 * 24 * 60 * 60;

// --- joining Better Auth's writes to an outer transaction -------------------------------
//
// Better Auth talks to Postgres through its own (Kysely) connection handling and cannot be
// handed a transaction. Registration must create the auth user and the `principals` row
// atomically, so the pool given to Better Auth is a thin wrapper: inside `runInTransaction`
// it hands out the caller's transaction client instead of a pooled one, and turns Better
// Auth's own begin/commit/rollback into a savepoint so they nest inside the outer
// transaction instead of ending it. Outside `runInTransaction` it is a plain pool.
//
// The caller's client goes back to the pool when its transaction ends, and may then be serving
// someone else. So everything handed out inside `runInTransaction` stops working the moment its
// callback settles (and a handed-out connection once it is released): a late query throws instead
// of running on a client that is no longer ours.

interface OuterTransaction {
  client: pg.PoolClient;
  /** False once the `runInTransaction` callback has settled. */
  open: boolean;
  /**
   * Announcements to make once the transaction has committed (dropped if it rolls back), when whoever opened it
   * runs them (`answerInTransaction`); without it they are made at once.
   */
  afterCommit?: Array<() => void>;
}

/** Runs `announce` once the transaction of ours it happens in has committed, or at once outside one. */
function whenCommitted(announce: () => void): void {
  const queue = outerTx.getStore()?.afterCommit;
  if (queue) queue.push(announce);
  else announce();
}

const outerTx = new AsyncLocalStorage<OuterTransaction>();

const SAVEPOINT = "better_auth_nested";

function nestedSql(text: string): string {
  const t = text.trim().toLowerCase();
  if (t === "begin" || t.startsWith("start transaction")) return `savepoint ${SAVEPOINT}`;
  if (t === "commit") return `release savepoint ${SAVEPOINT}`;
  if (t === "rollback") return `rollback to savepoint ${SAVEPOINT}`;
  return text;
}

// --- what Better Auth's database work ran into ------------------------------------------------
//
// Better Auth turns some database failures into its own answers: a statement timeout while creating the
// user becomes 422 FAILED_TO_CREATE_USER, one while reading a session a 500 without the cause. Whether
// the database was merely busy (errors.ts `isBusy`: 503, try again) is only visible where its queries
// run, in the pool below; each call into Better Auth that should know is run under a watch.

interface Watch {
  /** The first failure of Better Auth's database work during the call that means "busy". */
  busy?: unknown;
  /** The first error Better Auth's router answered with (`onAPIError`), for the log. */
  failure?: unknown;
}

const watches = new AsyncLocalStorage<Watch>();

function noteDatabaseError(err: unknown): void {
  const watch = watches.getStore();
  if (watch && watch.busy === undefined && isBusy(err)) watch.busy = err;
}

/** `query`, noting a busy failure for the watch it runs under. */
async function watched<R>(query: () => Promise<R>): Promise<R> {
  try {
    return await query();
  } catch (err) {
    noteDatabaseError(err);
    throw err;
  }
}

/**
 * Runs a direct call into Better Auth (`auth.api.*`). If it fails after any of its database work was busy,
 * that database error is thrown instead of whatever Better Auth made of it, so the caller answers 503.
 */
export async function authCall<T>(fn: () => Promise<T>): Promise<T> {
  const watch: Watch = {};
  try {
    return await watches.run(watch, fn);
  } catch (err) {
    throw watch.busy ?? err;
  }
}

/** Queries on the outer transaction's client while it is ours (and `usable()` holds); a rejection after. */
function onOuter(outer: OuterTransaction, usable: () => boolean = () => true) {
  return async (text: string, values?: unknown[]) => {
    if (!outer.open) throw new Error("Better Auth used a transaction of ours after it ended");
    if (!usable()) throw new Error("Better Auth used a connection after releasing it");
    return watched(() => outer.client.query(nestedSql(text), values));
  };
}

/** The pool Better Auth is given (exported for tests). */
export function switchablePool(pool: pg.Pool) {
  return {
    async connect() {
      const outer = outerTx.getStore();
      if (outer) {
        let released = false;
        return {
          query: onOuter(outer, () => !released),
          release: () => {
            released = true;
          },
        };
      }
      const client = await watched(() => pool.connect());
      return {
        // What Kysely (Better Auth's query layer) uses of a pg client: query(text, values) and release().
        query: (text: string, values?: unknown[]) => watched(() => client.query(text, values)),
        release: (destroy?: boolean | Error) => client.release(destroy),
      };
    },
    end: async () => {},
  };
}

/**
 * Runs `fn` so that every Better Auth call inside it executes on `client`'s transaction. What Better
 * Auth got hold of inside refuses to run once `fn` has settled.
 */
async function joinTransaction<T>(client: pg.PoolClient, fn: () => Promise<T>, afterCommit?: Array<() => void>): Promise<T> {
  const outer: OuterTransaction = { client, open: true, ...(afterCommit ? { afterCommit } : {}) };
  try {
    return await outerTx.run(outer, fn);
  } finally {
    outer.open = false;
  }
}

/** `joinTransaction`, watched like `authCall`: for direct calls into Better Auth (`auth.api.*`). */
export async function runInTransaction<T>(client: pg.PoolClient, fn: () => Promise<T>): Promise<T> {
  return authCall(() => joinTransaction(client, fn));
}

/** Where Better Auth's hooks read and write: the transaction of ours they run in, if any, else the pool. */
function currentDb(db: Queryable): Queryable {
  const outer = outerTx.getStore();
  return outer ? ({ query: onOuter(outer) } as unknown as Queryable) : db;
}

// --- session-ended notifications ------------------------------------------------------

export type SessionEndedListener = (principalId: string, sessionId: string) => void | Promise<void>;

/** Per-app registry (on `Deps.sessions`) of "a session ended" listeners, in the style of `SocialEvents`. */
export interface SessionEvents {
  on(fn: SessionEndedListener): () => void;
  /** Never throws; a listener that throws or rejects is logged. */
  emit(principalId: string, sessionId: string, log: Pick<FastifyBaseLogger, "error">): void;
}

export function createSessionEvents(): SessionEvents {
  const listeners = new Set<SessionEndedListener>();
  return {
    on(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    emit(principalId, sessionId, log) {
      for (const fn of [...listeners]) {
        try {
          Promise.resolve(fn(principalId, sessionId)).catch((err) => log.error({ err }, "session-ended listener failed"));
        } catch (err) {
          log.error({ err }, "session-ended listener failed");
        }
      }
    },
  };
}

/**
 * Subscribe to "a session was deleted" (sign-out, password reset — once per session —, expiry cleanup) of
 * this app. Returns unsubscribe.
 */
export function onSessionEnded(app: FastifyInstance, fn: SessionEndedListener): () => void {
  return app.deps.sessions.on(fn);
}

/** Never throws: a failure here must not turn a completed sign-out or password reset into an error. */
async function announceSessionEnded(
  db: Queryable,
  sessions: SessionEvents,
  log: Pick<FastifyBaseLogger, "error">,
  session: { id: string; userId: string },
): Promise<void> {
  try {
    const { rows } = await db.query<{ id: string }>("select id from principals where auth_user_id = $1", [session.userId]);
    const principalId = rows[0]?.id;
    // Inside a reset's transaction: only once it has committed, so nobody is told before the session is really gone.
    if (principalId) whenCommitted(() => sessions.emit(principalId, session.id, log));
  } catch (err) {
    // Its sockets are still closed by the heartbeat's session check (sync/hub.ts) within 30 s.
    log.error({ err }, "could not announce an ended session");
  }
}

// --- the Better Auth instance -------------------------------------------------------------

export function createAuth(config: Config, db: Db, sessions: SessionEvents, log: Pick<FastifyBaseLogger, "error">) {
  // Mail caused by a registration commits with it (and cannot be written once that transaction is
  // over); everything else writes straight to the pool.
  const mailDb = (): Queryable => currentDb(db);
  const policy = mailPolicy(config);
  const isHttps = new URL(config.appOrigin).protocol === "https:";

  return betterAuth({
    appName: PRODUCT_NAME,
    baseURL: config.appOrigin,
    basePath: AUTH_BASE_PATH,
    secret: config.authSecret,
    trustedOrigins: [config.appOrigin],
    database: switchablePool(db.pool),
    telemetry: { enabled: false },
    // Into the app's log (JSON lines on stdout; nothing under test) instead of the console.
    logger: {
      level: "error",
      log: (_level, message, ...args) => log.error({ err: args.find((a) => a instanceof Error) }, `better-auth: ${message}`),
    },
    // What the mount answered with goes to the watch: a busy database becomes 503, anything else that made
    // it answer 5xx is logged with the request (registerAuthRoutes). Better Auth then logs nothing itself.
    onAPIError: {
      onError: (err) => {
        const watch = watches.getStore();
        if (!watch) return;
        watch.failure ??= err;
        noteDatabaseError(err);
        noteDatabaseError((err as { cause?: unknown } | null)?.cause);
      },
    },
    // One source of truth for throttling: @fastify/rate-limit in app.ts.
    rateLimit: { enabled: false },
    advanced: {
      // Better Auth reads no client address (it would trust X-Forwarded-For) and stores none on sessions;
      // the limiters in front of it key on `clientIp` (src/limits.ts).
      ipAddress: { disableIpTracking: true },
      // Stated, not inherited from a library default: no cross-site POST carries the session (CSRF is
      // also refused by the Origin check in app.ts), scripts cannot read it, and https deployments
      // send it over TLS only (with the __Secure- name prefix).
      useSecureCookies: isHttps,
      defaultCookieAttributes: { sameSite: "lax", httpOnly: true, secure: isHttps },
    },
    session: { expiresIn: SESSION_LIFETIME_SECONDS },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      autoSignIn: false,
      minPasswordLength: 10,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: RESET_PASSWORD_TTL_SECONDS,
      sendResetPassword: async ({ user, token }) => {
        const link = `${config.appOrigin}/reset-password?token=${encodeURIComponent(token)}`;
        const mail = resetPasswordMail(link);
        await sendMail(mailDb(), "reset_password", user.email, mail.subject, mail.body, policy, mail.html);
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: false,
      expiresIn: VERIFY_EMAIL_TTL_SECONDS,
      // After a correct password only, so it reveals nothing about which accounts exist; this is the resend path.
      sendOnSignIn: true,
      sendVerificationEmail: async ({ user, url }) => {
        const mail = verifyEmailMail(url);
        await sendMail(mailDb(), "verify_email", user.email, mail.subject, mail.body, policy, mail.html);
      },
    },
    databaseHooks: {
      session: {
        // On the transaction a reset runs in (registerAuthRoutes), so it needs no second pool connection.
        delete: { after: async (session) => announceSessionEnded(currentDb(db), sessions, log, session) },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

// --- HTTP mount (Better Auth's Fastify integration: forward the request to `auth.handler`) -----

type Limiter = (req: FastifyRequest) => Promise<void>;

/** Lower-cased, trimmed e-mail, or undefined when not a string or not of a plausible length. */
function normalisedEmail(email: unknown): string | undefined {
  if (typeof email !== "string") return undefined;
  const normalised = email.trim().toLowerCase();
  return normalised.length > 0 && normalised.length <= 254 ? normalised : undefined;
}

/** The e-mail of a request body (sign-in, reset request). */
const bodyEmail = (req: FastifyRequest): string | undefined =>
  normalisedEmail((req.body as { email?: unknown } | null | undefined)?.email);

/** The e-mail a verification link names (its token's payload, unchecked: only a limiter key). */
const linkEmail = (req: FastifyRequest): string | undefined => {
  const token = (req.query as { token?: unknown } | undefined)?.token;
  return typeof token === "string" ? normalisedEmail(verificationTokenEmail(token)) : undefined;
};

/**
 * Two counters per request: 10/min per client address + e-mail (so hammering one account never locks out
 * another), and a looser 60/min per address (so one address cannot spray many accounts). Both times `scale`.
 * A missing or malformed e-mail falls back to the address-only key. The address is `clientIp`'s: Better Auth
 * itself never sees one (`disableIpTracking`, its own limiter off). `emailOf` finds the request's e-mail.
 */
function accountAndIpLimiter(app: FastifyInstance, scale: number, emailOf: (req: FastifyRequest) => string | undefined = bodyEmail): Limiter {
  const per = (n: number) => ({ max: Math.max(1, Math.round(n * scale)), timeWindow: "1 minute" });
  const perAccount = app.createRateLimit({ ...per(10), keyGenerator: (req: FastifyRequest) => `${clientIp(req)}|${emailOf(req) ?? ""}` });
  const perIp = app.createRateLimit({ ...per(60), keyGenerator: clientIp });
  return async (req) => {
    const results = [await perAccount(req), await perIp(req)];
    if (results.some((r) => "isExceeded" in r && r.isExceeded)) throw new AppError(429, "rate_limited");
  };
}

/**
 * A Better Auth JSON body without any `token` field, at any depth. Sign-in returns the session token
 * in its body; the HttpOnly cookie already carries the session, and a script must never see it.
 */
function withoutTokens(json: string): string {
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).filter(([k]) => k !== "token").map(([k, x]) => [k, strip(x)]));
    }
    return v;
  };
  try {
    return JSON.stringify(strip(JSON.parse(json)));
  } catch {
    return json;
  }
}

const STATUS_CODES: Record<number, string> = { 401: "unauthenticated", 403: "forbidden", 404: "not_found", 429: "rate_limited" };

/** Better Auth's error code ("INVALID_EMAIL_OR_PASSWORD") as our snake_case; its message text is never forwarded. */
function errorCodeOf(status: number, body: string): string {
  try {
    const code = (JSON.parse(body) as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Za-z][A-Za-z0-9_]*$/.test(code)) return code.toLowerCase();
  } catch {
    // not JSON: fall through to the status
  }
  return STATUS_CODES[status] ?? "invalid_request";
}

/** Text Postgres can store and a URL can carry: no NUL, no lone surrogate. */
const storableText = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => !s.includes("\u0000") && !/\p{Cs}/u.test(s), "not storable");

/**
 * Where Better Auth may send the browser afterwards: a path on this site (not `//host` or `/\host`, which
 * browsers read as another host) or a URL on the app's own origin. Better Auth would refuse other origins
 * too, but answers some malformed values with a 500.
 */
function appRedirect(appOrigin: string) {
  const own = new URL(appOrigin).origin;
  return storableText(2048).refine((s) => {
    if (/[\\\p{Cc}]/u.test(s)) return false;
    if (s.startsWith("/")) return !s.startsWith("//");
    try {
      return new URL(s).origin === own;
    } catch {
      return false;
    }
  }, "not a redirect on this site");
}

/**
 * The Better Auth endpoints reachable under `/api/auth` (method and path below it); every other path there is
 * 404 `not_found`. Notably absent: `/sign-up/email`, which would bypass invites and principal creation.
 */
export const AUTH_ENDPOINTS = [
  "POST /sign-in/email",
  "POST /sign-out",
  "GET /verify-email",
  "POST /request-password-reset",
  "POST /reset-password",
] as const;
type AuthEndpoint = (typeof AUTH_ENDPOINTS)[number];

interface Endpoint {
  limit: Limiter | null;
  /** The query string, exactly (it is forwarded as sent, so nothing undeclared may be in it). */
  query: z.ZodType;
  /** The JSON body; what it parses to is what Better Auth receives (undeclared fields are dropped). */
  body: z.ZodType;
  /** Its success is the same for every e-mail and must take as long for each: held back to the answer floor. */
  floor?: true;
  /**
   * Decides, before any transaction is opened, whether Better Auth's handling of this request runs inside one of
   * ours: the work to wrap it in (what to lock before `handle`, what to write after it), or null to just hand the
   * request on. Only an answer below 400 commits.
   */
  transaction?: (req: FastifyRequest) => Promise<TransactionWork | null>;
}

/** Better Auth's handling (`handle`) inside a transaction of ours, which its queries join. */
type TransactionWork = (t: Tx, handle: () => Promise<Response>) => Promise<Response>;

/** Thrown to roll back an `answerInTransaction` whose answer is a failure, carrying that answer out. */
class Unsuccessful extends Error {
  constructor(readonly response: Response) {
    super("unsuccessful answer");
  }
}

/** Runs `fn` in a transaction of ours that Better Auth's queries join; commits only an answer below 400. */
async function answerInTransaction(db: Db, fn: (t: Tx) => Promise<Response>): Promise<Response> {
  // Announcements made inside (ended sessions) wait for the commit; a rollback drops them.
  const afterCommit: Array<() => void> = [];
  let response: Response;
  try {
    response = await db.tx((t) =>
      joinTransaction(
        t,
        async () => {
          const answer = await fn(t);
          if (answer.status >= 400) throw new Unsuccessful(answer);
          return answer;
        },
        afterCommit,
      ),
    );
  } catch (err) {
    if (err instanceof Unsuccessful) return err.response;
    throw err;
  }
  for (const announce of afterCommit) announce();
  return response;
}

/**
 * The user a reset link (Better Auth's `reset-password:<token>` verification row) belongs to, with that user's row
 * locked for the rest of the transaction; null for a link that does not exist.
 */
async function lockResetLinkOwner(t: Tx, token: string): Promise<string | null> {
  const { rows } = await t.query<{ userId: string }>(
    `select u.id as "userId" from verification v join "user" u on u.id = v.value
      where v.identifier = $1
        for no key update of u`,
    [`reset-password:${token}`],
  );
  return rows[0]?.userId ?? null;
}

/**
 * The e-mail a verification link's token names: its JWT payload, read without checking the signature (Better Auth
 * checks it and refuses the link if it is wrong). Null when it names none.
 */
function verificationTokenEmail(token: string): string | null {
  try {
    const payload: unknown = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    const email = (payload as { email?: unknown } | null)?.email;
    return typeof email === "string" ? email : null;
  } catch {
    return null;
  }
}

/** Mounts Better Auth at `/api/auth/*` for `AUTH_ENDPOINTS` only (registration is POST /api/register). */
export function registerAuthRoutes(app: FastifyInstance, rateLimitScale: number, answerFloor: AnswerFloor): void {
  const signIn = accountAndIpLimiter(app, rateLimitScale);
  const resetRequest = accountAndIpLimiter(app, rateLimitScale);
  const verifyLink = accountAndIpLimiter(app, rateLimitScale, linkEmail);
  const redirect = appRedirect(app.deps.config.appOrigin);
  // Better Auth validates the values itself (e-mail format, password length, token); these schemas bound
  // the shape and keep out what it would choke on. Passwords are only hashed, never stored, so any text goes.
  const password = z.string().max(1024);
  const noQuery = z.strictObject({});
  const noBody = z.object({}).nullish();
  const endpoints: Record<AuthEndpoint, Endpoint> = {
    "POST /sign-in/email": {
      limit: signIn,
      query: noQuery,
      body: z.object({ email: storableText(254), password, callbackURL: redirect.optional(), rememberMe: z.boolean().optional() }),
    },
    "POST /sign-out": { limit: null, query: noQuery, body: noBody },
    "GET /verify-email": {
      // Like sign-in, per client address + the e-mail the link names, and per address.
      limit: verifyLink,
      query: z.strictObject({ token: storableText(4096), callbackURL: redirect.optional() }),
      body: noBody,
      // Better Auth checks the link's account by e-mail and then marks whatever account has that e-mail verified.
      // A registration replacing an unverified account holds the address's lock (accounts.ts), so a link to the
      // replaced account can never verify its replacement in between. Only a link Better Auth will accept is worth
      // a transaction and that lock: its signature and expiry are checked first (the same check Better Auth makes),
      // so a forged or stale link costs no connection and never queues in front of a registration.
      transaction: async (req) => {
        const payload = await verifyJWT((req.query as { token: string }).token, app.deps.config.authSecret);
        const email = typeof payload?.email === "string" ? payload.email : null;
        if (email === null) return null;
        return async (t, handle) => {
          await lockAccountEmail(t, email);
          return handle();
        };
      },
    },
    "POST /request-password-reset": {
      limit: resetRequest,
      query: noQuery,
      body: z.object({ email: storableText(254), redirectTo: redirect.optional() }),
      floor: true,
    },
    "POST /reset-password": {
      limit: null,
      query: noQuery,
      body: z.object({ newPassword: password, token: storableText(512) }),
      // Better Auth keeps one row per reset request and spends only the link used: a reset ends all the others of
      // that account too. One reset per account at a time (its user row is locked first), so of two links used at
      // once the second finds itself already gone.
      transaction: async (req) => async (t, handle) => {
        const userId = await lockResetLinkOwner(t, (req.body as { token: string }).token);
        const response = await handle();
        if (response.ok && userId !== null) {
          await t.query(`delete from verification where value = $1 and identifier like 'reset-password:%'`, [userId]);
        }
        return response;
      },
    },
  };
  const exposed = new Map<string, Endpoint>(Object.entries(endpoints));
  const endpointOf = (req: FastifyRequest): string => {
    const path = (req.url.split("?")[0] ?? "").replace(/\/{2,}/g, "/").replace(/\/+$/, "").toLowerCase();
    return `${req.method} ${path.startsWith(AUTH_BASE_PATH) ? path.slice(AUTH_BASE_PATH.length) : path}`;
  };

  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const request = new Request(url, {
      method: req.method,
      headers: fromNodeHeaders(req.headers),
      ...(req.body === undefined || req.body === null ? {} : { body: JSON.stringify(req.body) }),
    });
    const endpoint = exposed.get(endpointOf(req))!; // preHandler: it exists
    const handle = () => app.auth.handler(request);
    const watch: Watch = {};
    const response = await watches.run(watch, async () => {
      const work = endpoint.transaction ? await endpoint.transaction(req) : null;
      return work ? answerInTransaction(app.deps.db, (t) => work(t, handle)) : handle();
    });
    if (response.status >= 400) {
      const body = await response.text();
      // To the error handler (errors.ts): a busy database is 503 `busy`, anything else a logged 500 `internal`.
      if (watch.busy !== undefined) throw watch.busy;
      if (response.status >= 500) {
        throw new Error(`Better Auth answered ${response.status} ${body.slice(0, 200)}`, { cause: watch.failure });
      }
      return reply.code(response.status).send({ error: errorCodeOf(response.status, body) });
    }
    if (endpoint.floor) await holdUntilFloor(req, answerFloor);
    reply.status(response.status);
    response.headers.forEach((value, key) => {
      // The body may be rewritten below, so its length is Fastify's to state.
      if (!["set-cookie", "content-length"].includes(key.toLowerCase())) reply.header(key, value);
    });
    for (const cookie of response.headers.getSetCookie()) reply.header("set-cookie", cookie);
    if (!response.body) return reply.send(null);
    const text = await response.text();
    return reply.send(/json/i.test(response.headers.get("content-type") ?? "") ? withoutTokens(text) : text);
  };
  const onRequest = async (req: FastifyRequest) => {
    if (!exposed.has(endpointOf(req))) throw new AppError(404, "not_found");
  };
  // After body parsing, because the limiter keys on the e-mail in the body. The limiter counts malformed
  // requests too; then the endpoint's own schemas decide (400 before Better Auth sees anything).
  const preHandler = async (req: FastifyRequest) => {
    // The body is in: an answer floor counts from here, however late the client sent it.
    await startAnswerClock(req);
    const endpoint = exposed.get(endpointOf(req));
    if (!endpoint) throw new AppError(404, "not_found");
    await endpoint.limit?.(req);
    const query = endpoint.query.safeParse(req.query);
    const body = endpoint.body.safeParse(req.body ?? undefined);
    if (!query.success || !body.success) throw new AppError(400, "invalid_request");
    req.body = body.data;
  };
  // The mount's own schemas only bound the shape; each endpoint's schemas above are checked in preHandler.
  const schema = {
    params: z.object({ "*": z.string() }),
    querystring: z.object({}).catchall(z.union([z.string(), z.array(z.string())])),
  };
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.get(`${AUTH_BASE_PATH}/*`, { schema, onRequest, preHandler }, handler);
  typed.post(
    `${AUTH_BASE_PATH}/*`,
    { schema: { ...schema, body: z.record(z.string(), z.unknown()).nullish() }, onRequest, preHandler },
    handler,
  );
}
