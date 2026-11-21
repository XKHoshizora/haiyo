import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { buildApp, type BuildOptions, type Deps } from "../../src/app.ts";
import { loadConfig, type Config } from "../../src/config.ts";
import { createDb, type Db } from "../../src/db.ts";
import { settled as memoryCountsSettled } from "../../src/memory/stats.ts";
import { testDatabaseUrl } from "./env.ts";

const MIGRATIONS_TABLE = "pgmigrations";

/**
 * The clock the reviewer's timers run on in tests (`memory: true`): nothing sleeps. `advance(ms)` moves `now()` and
 * fires, in order of due time, every timer that has come due. `reset()` forgets every timer and puts the clock back on
 * the wall clock.
 */
export interface TestClock {
  now(): number;
  setTimer(fn: () => void, ms: number): { clear(): void };
  advance(ms: number): void;
  /** Timers waiting. */
  timers(): number;
  reset(): void;
}

export function testClock(): TestClock {
  let offset = 0;
  const waiting = new Set<{ at: number; fn: () => void }>();
  const now = (): number => Date.now() + offset;
  return {
    now,
    setTimer(fn, ms) {
      const timer = { at: now() + ms, fn };
      waiting.add(timer);
      return { clear: () => void waiting.delete(timer) };
    },
    advance(ms) {
      offset += ms;
      for (;;) {
        const due = [...waiting].filter((t) => t.at <= now()).sort((a, b) => a.at - b.at)[0];
        if (!due) return;
        waiting.delete(due);
        due.fn();
      }
    },
    timers: () => waiting.size,
    reset() {
      waiting.clear();
      offset = 0;
    },
  };
}

/**
 * The harness's own statements do not run under the app's `statement_timeout`: a file that sets it to a second to test
 * it (db-timeout, search-limits) must not have the clean-up between its tests cut off by it. And a truncate of the
 * ~60 tables is not quick on a busy machine: each table's file is synced to disk (`DataFileImmediateSync`), and with
 * other test runs writing too one truncate was seen to take 5 to 8 seconds, and over 25 on a machine at its limit. They
 * have a limit of their own that leaves room for that (below `hookTimeout`, vitest.config.ts), so that a lock nobody
 * releases still fails the hook rather than hangs it.
 */
const HARNESS_STATEMENT_TIMEOUT = "110s";

/** Empties every table but the migrations', taking them in name order (a known order: tests/harness.test.ts). */
async function truncateAll(db: Db): Promise<void> {
  await db.tx(async (c) => {
    await c.query(`set local statement_timeout = '${HARNESS_STATEMENT_TIMEOUT}'`);
    const { rows } = await c.query<{ t: string }>(
      `select format('%I.%I', schemaname, tablename) as t
         from pg_tables
        where schemaname = 'public' and tablename <> $1
        order by tablename`,
      [MIGRATIONS_TABLE],
    );
    if (rows.length === 0) return;
    await c.query(`truncate ${rows.map((r) => r.t).join(", ")} restart identity cascade`);
  });
}

/** How long `untilIdle` waits for the app's own work to end before it gives up and lets the truncate go on. */
const IDLE_WAIT_MS = 10_000;

/** Whether `idle()` (a promise that resolves when a component has nothing under way) has resolved already. */
const idleNow = async (idle: (() => Promise<void>) | undefined): Promise<boolean> =>
  idle === undefined ? true : Promise.race([idle().then(() => true), new Promise<boolean>((r) => setImmediate(() => r(false)))]);

/**
 * Waits until the app has nothing of its own under way — what a test leaves behind when it ends: a reply the worker's
 * loop claimed or is about to claim, the memory reviewer's and proactive scheduler's jobs, the memory counters written
 * without anyone waiting (`memory/stats.ts`), the realtime hub's deliveries, and (what none of those names) any
 * transaction of this database still open on another connection — one running a statement, and one between two
 * statements (`idle in transaction`) alike: a transaction that has read one table and is about to read another holds the
 * first while it waits for the second. A truncate that starts while any of those is still at work takes its table locks
 * one by one against theirs, and Postgres ends the cycle with `deadlock detected` (tests/harness.test.ts).
 * Nothing here retries: it only does not start the truncate until the work is over. It looks until two looks in a row
 * find everything quiet (work can start work: a reply's follow-up, a delivery's next step), and gives up after
 * `IDLE_WAIT_MS` (something a test leaves running on purpose then costs that, once, as it always did the truncate).
 */
async function untilIdle(app: FastifyInstance, db: Db, backgroundWorker: boolean): Promise<void> {
  const deadline = Date.now() + IDLE_WAIT_MS;
  let quiet = 0;
  while (quiet < 2 && Date.now() < deadline) {
    await memoryCountsSettled();
    let busy = !(await idleNow(app.deps.memory?.idle.bind(app.deps.memory))) || !(await idleNow(app.deps.proactive?.idle.bind(app.deps.proactive)));
    busy ||= !(await idleNow(app.hasDecorator("realtime") ? () => app.realtime.idle() : undefined));
    if (backgroundWorker) {
      // What the loop has not yet claimed is run now (by this hook, in the loop's place); what it has claimed is waited for.
      if ((await app.agentWorker.drain()) > 0) busy = true;
      if (!(await idleNow(() => app.agentWorker.idle()))) busy = true;
    }
    const open = await db.query<{ n: number }>(
      `select count(*)::int as n from pg_stat_activity
        where datname = current_database() and pid <> pg_backend_pid() and backend_type = 'client backend'
          and (state = 'active' or state like 'idle in transaction%')`,
    );
    if (open.rows[0]!.n > 0) busy = true;
    if (busy) {
      quiet = 0;
      await new Promise((r) => setTimeout(r, 5));
    } else {
      quiet++;
      await new Promise((r) => setImmediate(r));
    }
  }
}

/**
 * What runs between two tests: the database emptied once the app is quiet (`untilIdle`), with nothing started by a timer
 * meanwhile — the reply worker's loop is held from before the first look until the truncate has ended (its poll and its
 * wake-ups wait; what they asked for is claimed once released), the hub's heartbeat has no timer under the harness
 * (`BuildOptions.heartbeat`), and the sweeps none unless a file asks for one (`useApp`); the proactive scheduler's and the
 * memory reviewer's timers are part of their `idle()`.
 */
export async function betweenTests(app: FastifyInstance, db: Db, backgroundWorker: boolean): Promise<void> {
  const release = app.agentWorker.hold();
  try {
    await untilIdle(app, db, backgroundWorker);
    await truncateAll(db);
  } finally {
    release();
  }
}

/**
 * No answer floor (`BuildOptions.answerFloor`): registrations and reset requests answer as soon as they are done.
 * What `useApp()` uses unless a test asks for a floor; pass it to an app a test builds itself.
 */
export const NO_ANSWER_FLOOR = { ms: 0, jitterMs: 0 } as const;

/**
 * Builds the app once per test file (against TEST_DATABASE_URL, with rate limits
 * raised and no answer floor) and truncates every table except the migrations table before each test.
 * `env` is the app's configuration and, while the file runs, also set in `process.env` (restored after), as it would
 * be in production: what is read when used rather than at start-up (a site model's key, `resolveModel`) sees it too.
 * `allowInsecureLocal` lets the app's providers reach a local stub over plain HTTP (src/providers/guard.ts).
 * `models` replaces the model gateway (a `scriptedGateway()` from helpers/models.ts), `providerProbe` how the provider
 * routes reach a provider, `judge` the judgement model (`scriptedJudge()` from helpers/judge.ts). `agentWorker: false` turns the
 * reply worker's background loop off: the test then runs replies itself with `app.agentWorker.runOnce()`. The stale-run
 * sweep's timer is off unless `staleRunSweep` asks for it (`app.staleRunSweep.run()` sweeps by hand). So is the
 * proactive scheduler unless `proactive` asks for it (`{}`, or `{ delayMs }` for a shorter wait; built only when the
 * judgement model is configured, `config.judge`): `app.deps.proactive` is null otherwise. So are the tools replies may be
 * offered unless `tools` asks for them (the app's own port then has the real toolbox; without it every reply is one call,
 * as before tools).
 * `config` replaces fields of the loaded configuration, past `loadConfig`'s rules (a file that needs a value they
 * refuse, such as a connection timeout of under a second, for what it tests; nothing else is affected).
 * `app` is a stable handle that forwards to the instance built in beforeAll.
 * Before each truncate the harness waits for the app's own background work to be over (`untilIdle`), and the truncate
 * runs outside the app's statement timeout.
 */
export function useApp(
  extra: Partial<Pick<Deps, "blobs" | "uploads" | "models" | "providerProbe" | "judge">> & { env?: Record<string, string>; config?: Partial<Config> } & Omit<BuildOptions, "memory" | "tools" | "heartbeat" | "greeting"> & {
      memory?: boolean;
      tools?: boolean;
      greeting?: boolean;
    } = {},
): { app: FastifyInstance; db: Db; clock: TestClock } {
  const { env, config: configured, logStream, sweepInitialDelayMs, answerFloor = NO_ANSWER_FLOOR, allowInsecureLocal, agentWorker, staleRunSweep = false, proactive = false, memory = false, tools = false, greeting = false, mail, ...overrides } =
    extra;
  const clock = testClock();
  const options: BuildOptions = {
    answerFloor,
    staleRunSweep,
    proactive,
    memory: memory ? { now: clock.now, setTimer: clock.setTimer } : false,
    ...(tools ? {} : { tools: false as const }),
    // A new Agent's greeting reply is queued only when a file asks for it: a test's first reply is the one it scripts.
    ...(greeting ? {} : { greeting: false as const }),
    ...(logStream ? { logStream } : {}),
    ...(sweepInitialDelayMs === undefined ? {} : { sweepInitialDelayMs }),
    ...(allowInsecureLocal ? { allowInsecureLocal } : {}),
    ...(agentWorker === false ? { agentWorker } : {}),
    // The mail sender's timer is off in tests unless a file asks for it (`app.mailSender.runOnce()` delivers by hand).
    mail: { sender: false, ...mail },
    // Nor does the hub's heartbeat run on a timer (`app.realtime.tick()` beats by hand): see `betweenTests`.
    heartbeat: false,
  };
  let instance: FastifyInstance | undefined;
  let database: Db | undefined;
  const current = <T>(v: T | undefined): T => {
    if (!v) throw new Error("useApp(): app is only available inside tests and hooks");
    return v;
  };
  const forward = <T extends object>(get: () => T): T =>
    new Proxy({} as T, {
      get(_t, prop) {
        const target = get();
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

  const previous = new Map<string, string | undefined>();
  beforeAll(async () => {
    for (const [name, value] of Object.entries(env ?? {})) {
      previous.set(name, process.env[name]);
      process.env[name] = value;
    }
    const loaded = {
      ...loadConfig({
        ...process.env,
        DATABASE_URL: testDatabaseUrl(),
        AUTH_SECRET: "test-secret-test-secret-test-secret-0000",
        PROVIDER_KEY_SECRET: "test-provider-key-secret-0000000000",
        APP_ORIGIN: "http://localhost:5173",
        RATE_LIMIT_SCALE: "1000",
        SWEEP_INTERVAL_MINUTES: "0", // no background timer unless a test asks for one
        ...env,
      }),
      ...configured,
    };
    // Nor the memory-change sweep's own timer, unless the file's MEMORY names `changesSweepMs`.
    const asked = (env?.MEMORY ?? "").includes("changesSweepMs") || configured?.memory?.changesSweepMs !== undefined;
    const swept = asked ? loaded : { ...loaded, memory: { ...loaded.memory, changesSweepMs: 0 } };
    // Nor does the system retry a failed reply by itself (src/agents/runs.ts `scheduleAutoRetry`), unless the file's env
    // names AGENTS or its config `agents`: a test that scripts a failure sees the failure.
    const config = env?.AGENTS !== undefined || configured?.agents !== undefined ? swept : { ...swept, agents: { autoRetryDelaysMs: [] } };
    database = createDb(config.databaseUrl, { statementTimeoutMs: config.dbStatementTimeoutMs, acquireTimeoutMs: config.dbAcquireTimeoutMs });
    instance = await buildApp({ config, db: database, ...overrides }, options);
    await instance.ready();
  });

  beforeEach(async () => {
    // Before the truncate, what the previous test left running is over, and nothing starts meanwhile (`betweenTests`).
    await betweenTests(current(instance), current(database), agentWorker !== false);
  });

  afterAll(async () => {
    await instance?.close();
    await database?.close();
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  return { app: forward(() => current(instance)), db: forward(() => current(database)), clock };
}
