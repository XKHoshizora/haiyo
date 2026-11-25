import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { runMigrations, DOWN_REMOVES, undoMigration } from "../src/migrate.ts";
import { testDatabaseUrl } from "./helpers/env.ts";
import { useApp } from "./helpers/harness.ts";

/**
 * Fix round 1, I5: `migrate:down --name` is safe by default. It undoes only the LAST migration applied (the name must be it), says
 * what that migration's Down removes, and refuses unless the operator confirms the loss (`--i-understand-this-deletes-data`); with
 * `NODE_ENV=production` it wants one flag more (`--in-production`). Every case here is a refusal: nothing is undone on this database
 * (what a confirmed Down does is tests/ring1a-migrations.test.ts).
 */
const { db } = useApp({ agentWorker: false });
const url = testDatabaseUrl();
const cwd = fileURLToPath(new URL("..", import.meta.url));
const tsx = createRequire(import.meta.url).resolve("tsx/cli");
async function cli(args: string[], extra: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = { ...process.env, DATABASE_URL: url, ...extra };
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [tsx, "src/cli.ts", ...args], { cwd, env });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}
const last = async () => (await db.query<{ name: string }>("select name from pgmigrations order by run_on desc, id desc limit 1")).rows[0]!.name;
const LAST = "076_others_reasoning";
const ACCESS = "075_agent_social_access";

describe("what a Down removes is declared", () => {
  it("for 073 to 076, in words an operator can weigh: 075's names the stops, the reports and the policies, 076's the two thinking levels", () => {
    for (const name of ["073_others_columns_and_social_skeleton", "074_others_step_l", ACCESS, LAST]) expect(DOWN_REMOVES[name]?.length ?? 0, name).toBeGreaterThan(40);
    expect(DOWN_REMOVES[ACCESS]).toMatch(/停止往来|stop/);
    expect(DOWN_REMOVES[ACCESS]).toMatch(/report/);
    expect(DOWN_REMOVES[ACCESS]).toMatch(/polic/);
    expect(DOWN_REMOVES[LAST]).toMatch(/thinking level/);
    expect(DOWN_REMOVES["074_others_step_l"]).toMatch(/20/);
  });
});

describe("undoMigration refuses by default", () => {
  it("without the confirmation; in production without the second word; for a name that is not the last applied: nothing is undone", async () => {
    expect(await last()).toBe(LAST);
    await expect(undoMigration(url, LAST, { quiet: true })).rejects.toThrow(/--i-understand-this-deletes-data/);
    await expect(undoMigration(url, LAST, { quiet: true, confirmed: true, nodeEnv: "production" })).rejects.toThrow(/--in-production/);
    await expect(undoMigration(url, "074_others_step_l", { quiet: true, confirmed: true })).rejects.toThrow(/last migration applied is 076_others_reasoning/);
    await expect(undoMigration(url, ACCESS, { quiet: true, confirmed: true })).rejects.toThrow(/last migration applied is 076_others_reasoning/);
    await expect(undoMigration(url, "074_others_step_l", { quiet: true, confirmed: true, nodeEnv: "production", inProduction: true })).rejects.toThrow(/last migration applied/);
    expect(await last()).toBe(LAST);
    expect((await db.query<{ t: string | null }>("select to_regclass('public.access_bars')::text as t")).rows[0]!.t).toBe("access_bars");
  });
});

describe("the command", () => {
  it("prints what the Down removes and refuses without the flag (exit 1, nothing undone); in production it names the further flag; a name that is not the last is refused before anything", async () => {
    const bare = await cli(["migrate:down", "--name", LAST]);
    expect(bare.code).not.toBe(0);
    expect(bare.stdout).toContain(DOWN_REMOVES[LAST]!);
    expect(bare.stderr).toContain("--i-understand-this-deletes-data");
    expect(bare.stdout).not.toContain("undone:");
    const prod = await cli(["migrate:down", "--name", LAST, "--i-understand-this-deletes-data"], { NODE_ENV: "production", APP_ORIGIN: "https://example.test", AUTH_SECRET: "test-secret-test-secret-test-secret-0000", PROVIDER_KEY_SECRET: "test-provider-key-secret-0000000000" });
    expect(prod.code).not.toBe(0);
    expect(prod.stderr).toContain("--in-production");
    const wrong = await cli(["migrate:down", "--name", "074_others_step_l", "--i-understand-this-deletes-data"]);
    expect(wrong.code).not.toBe(0);
    expect(wrong.stderr).toContain("the last migration applied is 076_others_reasoning");
    expect(await last()).toBe(LAST);
  }, 120_000);
});

/**
 * Holds the FIRST `undoMigration` that makes its name check right after that check has answered — between its check and its Down —
 * until `release`. (Its check is the one statement that reads the last migration's name; every other statement passes through.)
 */
async function pausedAfterCheck() {
  const pg = await import("pg");
  const query = pg.default.Client.prototype.query;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  let checks = 0;
  const spy = vi.spyOn(pg.default.Client.prototype, "query").mockImplementation(function (this: unknown, ...args: unknown[]) {
    const result = (query as (...a: unknown[]) => unknown).apply(this, args);
    if (typeof args[0] !== "string" || !args[0].startsWith("select name from pgmigrations") || ++checks !== 1) return result;
    return (result as Promise<unknown>).then(async (rows) => (await gate, rows));
  } as never);
  return { release: () => release(), checked: () => checks, restore: () => spy.mockRestore() };
}
const settledWithin = (p: Promise<unknown>, ms: number) => Promise.race([p.then(() => true, () => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);

describe("two operators at once (fix round 3, point 5)", () => {
  it("both name the last migration and both confirm: exactly one Down runs, the other is refused once its turn comes, and the migration under it is still applied", async () => {
    expect(await last()).toBe(LAST);
    // The interleaving that matters: the first operator has made its check ("076 is the last") and has NOT begun its Down when the
    // second one starts. Without a lock held from the check to the end of the Down, the second one would check, undo 076 and
    // return, and the first would then undo 075 under it (fix round 4: the pause is between the check and the Down, under the lock).
    const pause = await pausedAfterCheck();
    const first = undoMigration(url, LAST, { quiet: true, confirmed: true });
    first.catch(() => {});
    for (let i = 0; i < 200 && pause.checked() === 0; i++) await new Promise((r) => setTimeout(r, 25));
    expect(pause.checked()).toBe(1);
    const second = undoMigration(url, LAST, { quiet: true, confirmed: true });
    second.catch(() => {});
    // The second one waits for the first one's lock: it neither checks nor undoes anything meanwhile.
    expect(await settledWithin(second, 2000)).toBe(false);
    expect(pause.checked()).toBe(1);
    expect(await last()).toBe(LAST);
    pause.release();
    const both = await Promise.allSettled([first, second]);
    pause.restore();
    try {
      expect(both.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
      expect(String((both[1] as PromiseRejectedResult).reason)).toMatch(/last migration applied is 075_agent_social_access, not 076_others_reasoning/);
      expect(await last()).toBe(ACCESS);
      expect((await db.query<{ t: string | null }>("select to_regclass('public.access_bars')::text as t")).rows[0]!.t).toBe("access_bars");
    } finally {
      await runMigrations(url, { quiet: true });
    }
    expect(await last()).toBe(LAST);
  }, 120_000);
});

describe("a Down and a deploy's Up at once (fix round 4, F6)", () => {
  it("the Down has checked that 075 is the last and has not begun; a deploy's Up (076) starts: it is refused, not interleaved — the Down undoes 075, the one it named, never the 076 an Up slipped under it", async () => {
    await undoMigration(url, LAST, { quiet: true, confirmed: true });
    expect(await last()).toBe(ACCESS);
    const pause = await pausedAfterCheck();
    let down: Promise<void> = Promise.resolve();
    try {
      down = undoMigration(url, ACCESS, { quiet: true, confirmed: true });
      down.catch(() => {});
      for (let i = 0; i < 200 && pause.checked() === 0; i++) await new Promise((r) => setTimeout(r, 25));
      expect(pause.checked()).toBe(1);
      // The deploy: it finds a migration command at work (the runner's own lock, which the Down holds) and applies nothing.
      await expect(runMigrations(url, { quiet: true })).rejects.toThrow(/Another migration is already running/);
      expect(await last()).toBe(ACCESS);
      pause.release();
      await down;
      expect(await last()).toBe("074_others_step_l");
      expect((await db.query<{ t: string | null }>("select to_regclass('public.access_bars')::text as t")).rows[0]!.t).toBeNull();
    } finally {
      pause.release();
      await down.catch(() => {});
      pause.restore();
      await runMigrations(url, { quiet: true });
    }
    expect(await last()).toBe(LAST);
  }, 120_000);
});
