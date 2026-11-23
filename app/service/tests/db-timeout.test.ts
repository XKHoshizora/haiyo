import { afterEach, describe, expect, it } from "vitest";
import { abandonedAfterMs, holdBlob, sweepPendingBlobs } from "../src/attachments/pending.ts";
import { sweepOrphans } from "../src/attachments/store.ts";
import { createInvite } from "../src/auth/invites.ts";
import { loadConfig } from "../src/config.ts";
import { api, befriend, signUp, TERMS } from "./helpers/actors.ts";
import { useProbeBlobs } from "./helpers/blobs.ts";
import { useApp } from "./helpers/harness.ts";
import { CLOSING, destroyOpenRequests, multipart, MULTIPART, openRequest, partHead } from "./helpers/multipart.ts";

const POOL_MS = 1000;
const { blobs, files: blobFiles, putStarted } = useProbeBlobs("af-dbtimeout-");
const { app, db } = useApp({ blobs, env: { DB_STATEMENT_TIMEOUT_MS: String(POOL_MS) } });
afterEach(destroyOpenRequests);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the pool's statement timeout (DB_STATEMENT_TIMEOUT_MS)", () => {
  it("defaults to 30 s, is set on every pool connection, and cuts off a statement that runs longer", async () => {
    const base = { DATABASE_URL: "postgres://x", APP_ORIGIN: "http://localhost:5173", AUTH_SECRET: "x".repeat(32), PROVIDER_KEY_SECRET: "p".repeat(32) };
    expect(loadConfig(base)).toMatchObject({ dbStatementTimeoutMs: 30_000, searchStatementTimeoutMs: 3_000 });
    expect(() => loadConfig({ ...base, DB_STATEMENT_TIMEOUT_MS: "0" })).toThrow(/DB_STATEMENT_TIMEOUT_MS/);
    expect(() => loadConfig({ ...base, SEARCH_STATEMENT_TIMEOUT_MS: "-1" })).toThrow(/SEARCH_STATEMENT_TIMEOUT_MS/);

    // Every connection of the pool, not just the first one handed out.
    const clients = await Promise.all(Array.from({ length: 5 }, () => db.pool.connect()));
    try {
      for (const c of clients) expect((await c.query<{ t: string }>("select setting t from pg_settings where name = 'statement_timeout'")).rows[0]!.t).toBe(String(POOL_MS));
    } finally {
      for (const c of clients) c.release();
    }
    await expect(db.query("select pg_sleep($1)", [(POOL_MS + 300) / 1000])).rejects.toMatchObject({ code: "57014" });
  });

  it("a route whose statement runs over it answers 503 busy, and the next request is served", async () => {
    const a = await signUp(app, "alice");
    const blocker = await db.pool.connect();
    try {
      await blocker.query("begin");
      await blocker.query("lock table principals in access exclusive mode");
      expect(await api(app, a, "GET", "/api/me")).toEqual({ status: 503, json: { error: "busy" } });
    } finally {
      await blocker.query("rollback");
      blocker.release();
    }
    expect((await api(app, a, "GET", "/api/me")).status).toBe(200);
  });

  /** Holds `lock table <table> in <mode> mode` until the returned function is called. */
  async function lockTable(table: string, mode: string): Promise<() => Promise<void>> {
    const blocker = await db.pool.connect();
    await blocker.query("begin");
    await blocker.query(`lock table ${table} in ${mode} mode`);
    return async () => {
      await blocker.query("rollback");
      blocker.release();
    };
  }
  const BUSY = { status: 503, json: { error: "busy" } };

  it("Better Auth's statements too: looking up the session and signing in answer 503 busy", async () => {
    const a = await signUp(app, "alice");
    let unlock = await lockTable(`"session"`, "access exclusive");
    try {
      expect(await api(app, a, "GET", "/api/me")).toEqual(BUSY);
    } finally {
      await unlock();
    }
    unlock = await lockTable(`"user"`, "access exclusive");
    try {
      expect(await api(app, null, "POST", "/api/auth/sign-in/email", { email: a.email, password: a.password })).toEqual(BUSY);
    } finally {
      await unlock();
    }
    expect((await api(app, null, "POST", "/api/auth/sign-in/email", { email: a.email, password: a.password })).status).toBe(200);
  });

  it("a registration whose account insert times out is 503 busy (not a 4xx), writes nothing and keeps the invite", async () => {
    const inviteCode = await createInvite(db, { ttlHours: 1 });
    const body = { inviteCode, email: "late@example.test", password: "a good password", displayName: "Late", handle: "late_one", ...TERMS };
    // Reads of "user" go on (the e-mail check); Better Auth's insert waits on the lock until it times out.
    const unlock = await lockTable(`"user"`, "share");
    try {
      expect(await api(app, null, "POST", "/api/register", body)).toEqual(BUSY);
    } finally {
      await unlock();
    }
    const count = async (sql: string) => Number((await db.query<{ n: string }>(sql)).rows[0]!.n);
    expect(await count(`select count(*) n from "user"`)).toBe(0);
    expect(await count("select count(*) n from principals")).toBe(0);
    expect(await count("select count(*) n from mail_outbox")).toBe(0);
    expect(await count("select count(*) n from invites where used_at is null")).toBe(1);
    expect((await api(app, null, "POST", "/api/register", body)).status).toBe(201);
  });

  it("does not cut off an upload that takes longer: no statement spans the body", async () => {
    const [a, b] = [await signUp(app, "alice"), await signUp(app, "bob")];
    const { conversationId: dm } = await befriend(app, a, b);
    const started = putStarted();
    const open = await openRequest(app, { path: `/api/conversations/${dm}/attachments`, cookie: a.cookie });
    await open.write(partHead({ name: "file", filename: "slow.bin", type: "application/octet-stream" }));
    await open.fill(16 * 1024);
    await started;
    const t0 = performance.now();
    for (let i = 0; i < 6; i++) {
      await sleep(POOL_MS / 3);
      await open.fill(16 * 1024);
    }
    await open.write(CLOSING);
    await open.end();
    const res = await open.response;
    expect(performance.now() - t0).toBeGreaterThan(POOL_MS * 1.5);
    expect(res.status).toBe(201);
    expect(JSON.parse(res.body).size).toBe(7 * 16 * 1024);
  });

  it("leaves both sweeps working", async () => {
    const [a, b] = [await signUp(app, "alice"), await signUp(app, "bob")];
    const { conversationId: dm } = await befriend(app, a, b);
    const up = await app.inject({
      method: "POST",
      url: `/api/conversations/${dm}/attachments`,
      headers: { cookie: a.cookie, "content-type": MULTIPART },
      payload: multipart([{ name: "file", filename: "never-sent.bin", type: "application/octet-stream", data: "x" }]),
    });
    expect(up.statusCode).toBe(201);
    await db.query("update attachments set created_at = now() - interval '2 hours'");
    await holdBlob(db, "att-abandoned");
    await db.query("update pending_blobs set created_at = now() - interval '1 day'");
    expect(await sweepOrphans({ db, blobs }, 60)).toBe(1);
    expect(await sweepPendingBlobs({ db, blobs }, abandonedAfterMs(app.deps.config))).toBe(1);
    expect(blobFiles()).toEqual([]);
  });
});
