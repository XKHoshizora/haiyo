import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DOWN_REMOVES, undoMigration } from "../src/migrate.ts";
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
