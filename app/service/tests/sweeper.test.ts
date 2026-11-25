import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newBlobKey } from "../src/attachments/blob.ts";
import { holdBlob } from "../src/attachments/pending.ts";
import { INITIAL_SWEEP_DELAY_MS, startSweeper, type SweepCounts } from "../src/attachments/sweeper.ts";
import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { befriend, signUp } from "./helpers/actors.ts";
import { useProbeBlobs } from "./helpers/blobs.ts";
import { useApp } from "./helpers/harness.ts";
import { MULTIPART, multipart } from "./helpers/multipart.ts";

const MINUTE = 60_000;
const NOTHING: SweepCounts = { unsent: 0, abandoned: 0 };

function fakeLog() {
  const lines: { level: "info" | "warn"; obj: Record<string, unknown>; msg: string }[] = [];
  return {
    lines,
    log: {
      info: (obj: Record<string, unknown>, msg: string) => void lines.push({ level: "info", obj, msg }),
      warn: (obj: Record<string, unknown>, msg: string) => void lines.push({ level: "warn", obj, msg }),
    },
  };
}

describe("config", () => {
  const base = { DATABASE_URL: "postgres://x/y", APP_ORIGIN: "http://localhost:5173", AUTH_SECRET: "x".repeat(32), PROVIDER_KEY_SECRET: "p".repeat(32) };
  it("SWEEP_INTERVAL_MINUTES defaults to 15, 0 disables, anything but a whole number >= 0 is refused", () => {
    expect(loadConfig(base).sweepIntervalMinutes).toBe(15);
    expect(loadConfig({ ...base, SWEEP_INTERVAL_MINUTES: "0" }).sweepIntervalMinutes).toBe(0);
    expect(loadConfig({ ...base, SWEEP_INTERVAL_MINUTES: "5" }).sweepIntervalMinutes).toBe(5);
    expect(loadConfig({ ...base, SWEEP_INTERVAL_MINUTES: "" }).sweepIntervalMinutes).toBe(15);
    expect(loadConfig({ ...base, SWEEP_INTERVAL_MINUTES: "1440" }).sweepIntervalMinutes).toBe(1440);
    for (const bad of ["-1", "1.5", "abc", "1441", "40000", "9999999"]) {
      expect(() => loadConfig({ ...base, SWEEP_INTERVAL_MINUTES: bad })).toThrow(/SWEEP_INTERVAL_MINUTES/);
    }
  });
});

describe("config HOST", () => {
  const base = { DATABASE_URL: "postgres://x/y", APP_ORIGIN: "http://localhost:5173", AUTH_SECRET: "x".repeat(32), PROVIDER_KEY_SECRET: "p".repeat(32) };
  it("defaults to 0.0.0.0; takes an IP address or localhost; anything else is refused", () => {
    expect(loadConfig(base).host).toBe("0.0.0.0");
    expect(loadConfig({ ...base, HOST: "" }).host).toBe("0.0.0.0");
    for (const ok of ["127.0.0.1", "::1", "::", "192.168.1.20", "localhost"]) expect(loadConfig({ ...base, HOST: ok }).host).toBe(ok);
    for (const bad of ["example.com", "999.1.1.1", "0.0.0", "127.0.0.1:8787", "LOCALHOST ", "http://localhost"]) {
      expect(() => loadConfig({ ...base, HOST: bad })).toThrow(/HOST/);
    }
  });
});

describe("startSweeper (fake timers)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("interval 0: no timer at all", () => {
    const { log } = fakeLog();
    const s = startSweeper({ run: async () => NOTHING, intervalMinutes: 0, log });
    expect(vi.getTimerCount()).toBe(0);
    expect(s).toBeUndefined();
  });

  it("runs once after the initial delay, then every interval", async () => {
    const { log } = fakeLog();
    const run = vi.fn(async () => NOTHING);
    const s = startSweeper({ run, intervalMinutes: 15, log })!;
    await vi.advanceTimersByTimeAsync(INITIAL_SWEEP_DELAY_MS - 1);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15 * MINUTE - 1);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(15 * MINUTE);
    expect(run).toHaveBeenCalledTimes(3);
    await s.stop();
  });

  it("skips a tick while the previous run is still going", async () => {
    const { log } = fakeLog();
    let release!: () => void;
    const run = vi.fn(() => new Promise<SweepCounts>((resolve) => (release = () => resolve(NOTHING))));
    const s = startSweeper({ run, intervalMinutes: 1, log })!;
    await vi.advanceTimersByTimeAsync(INITIAL_SWEEP_DELAY_MS);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(run).toHaveBeenCalledTimes(2);
    release();
    await s.stop();
  });

  it("logs a failing run at warn with the error and keeps running", async () => {
    const { log, lines } = fakeLog();
    const boom = new Error("db down");
    const run = vi.fn<() => Promise<SweepCounts>>().mockRejectedValueOnce(boom).mockResolvedValue(NOTHING);
    const s = startSweeper({ run, intervalMinutes: 1, log })!;
    await vi.advanceTimersByTimeAsync(INITIAL_SWEEP_DELAY_MS);
    expect(lines).toEqual([{ level: "warn", obj: { err: boom }, msg: expect.stringContaining("sweep") }]);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(run).toHaveBeenCalledTimes(2);
    expect(lines).toHaveLength(1);
    await s.stop();
  });

  it("logs one info line per run that swept something, none otherwise", async () => {
    const { log, lines } = fakeLog();
    const run = vi
      .fn<() => Promise<SweepCounts>>()
      .mockResolvedValueOnce(NOTHING)
      .mockResolvedValueOnce({ unsent: 2, abandoned: 1 })
      .mockResolvedValue(NOTHING);
    const s = startSweeper({ run, intervalMinutes: 1, log })!;
    await vi.advanceTimersByTimeAsync(INITIAL_SWEEP_DELAY_MS);
    expect(lines).toEqual([]);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(lines).toEqual([{ level: "info", obj: { unsent: 2, abandoned: 1 }, msg: expect.stringContaining("sweep") }]);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(lines).toHaveLength(1);
    await s.stop();
  });

  it("stop() clears the timers and waits for a run in flight; nothing runs afterwards", async () => {
    const { log } = fakeLog();
    let release!: () => void;
    let finished = false;
    const run = vi.fn(
      () =>
        new Promise<SweepCounts>((resolve) => {
          release = () => {
            finished = true;
            resolve(NOTHING);
          };
        }),
    );
    const s = startSweeper({ run, intervalMinutes: 1, log })!;
    await vi.advanceTimersByTimeAsync(INITIAL_SWEEP_DELAY_MS);
    const stopped = s.stop();
    expect(vi.getTimerCount()).toBe(0);
    release();
    await stopped;
    expect(finished).toBe(true);
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("the timers are unref'd", async () => {
    const { log } = fakeLog();
    const unrefs: ReturnType<typeof vi.fn>[] = [];
    for (const name of ["setTimeout", "setInterval"] as const) {
      const real = globalThis[name] as unknown as (...a: unknown[]) => { unref(): unknown };
      vi.spyOn(globalThis, name).mockImplementation(((...a: unknown[]) => {
        const t = real(...a);
        const unref = vi.fn(t.unref.bind(t));
        t.unref = unref;
        unrefs.push(unref);
        return t;
      }) as never);
    }
    const s = startSweeper({ run: async () => NOTHING, intervalMinutes: 1, log })!;
    await vi.advanceTimersByTimeAsync(INITIAL_SWEEP_DELAY_MS); // the interval exists now too
    expect(unrefs).toHaveLength(2);
    for (const unref of unrefs) expect(unref).toHaveBeenCalled();
    await s.stop();
  });
});

describe("inside the app", () => {
  const { blobs, files } = useProbeBlobs("af-sweeper-");
  const { app, db } = useApp({ blobs });

  async function unsentUpload(): Promise<void> {
    const a = await signUp(app, "alice");
    const b = await signUp(app, "bob");
    const { conversationId } = await befriend(app, a, b);
    const res = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/attachments`,
      headers: { cookie: a.cookie, "content-type": MULTIPART },
      payload: multipart([{ name: "file", filename: "a.bin", type: "application/octet-stream", data: Buffer.from("hello") }]),
    });
    expect(res.statusCode).toBe(201);
  }

  it("the test harness starts no sweeper", () => {
    expect(app.deps.config.sweepIntervalMinutes).toBe(0);
  });

  it("a scheduled run removes an unsent upload older than the threshold and an abandoned blob", async () => {
    await unsentUpload();
    await db.query("update attachments set created_at = now() - interval '61 minutes'");
    const lost = newBlobKey("att");
    await holdBlob(db, lost);
    await blobs.put(lost, Buffer.from("x"));
    await db.query("update pending_blobs set created_at = now() - interval '62 minutes' where key = $1", [lost]);
    expect(files()).toHaveLength(2);

    const lines: string[] = [];
    const sweeping = await buildApp(
      { config: { ...app.deps.config, sweepIntervalMinutes: 15 }, db, blobs },
      { logStream: { write: (l) => void lines.push(l) }, sweepInitialDelayMs: 20 },
    );
    try {
      await sweeping.ready();
      await vi.waitFor(async () => expect((await db.query("select 1 from attachments")).rowCount).toBe(0), { timeout: 5000 });
      // The run's line is written once the whole run is done: the unsent uploads first, the abandoned blobs after them.
      await vi.waitFor(() => expect(lines.some((l) => l.includes('"unsent":1') && l.includes('"abandoned":1'))).toBe(true));
      expect(files()).toEqual([]);
    } finally {
      await sweeping.close();
    }
  });

  it("a run that is still waiting when the app closes never happens", async () => {
    await unsentUpload();
    await db.query("update attachments set created_at = now() - interval '61 minutes'");
    // (The first sweep waits long enough for the app to be ready and closed on a busy machine; then the wait is outlived: review 2, n6.)
    const sweeping = await buildApp({ config: { ...app.deps.config, sweepIntervalMinutes: 15 }, db, blobs }, { sweepInitialDelayMs: 2500 });
    await sweeping.ready();
    await sweeping.close();
    await new Promise((r) => setTimeout(r, 3000));
    expect((await db.query("select 1 from attachments")).rowCount).toBe(1);
  });
});
