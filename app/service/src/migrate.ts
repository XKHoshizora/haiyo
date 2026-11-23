import { runner } from "node-pg-migrate";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

export async function runMigrations(databaseUrl: string, opts: { quiet?: boolean } = {}): Promise<void> {
  const quiet = opts.quiet ?? false;
  await runner({
    databaseUrl,
    dir: MIGRATIONS_DIR,
    direction: "up",
    migrationsTable: "pgmigrations",
    count: Infinity,
    log: quiet ? () => {} : (msg: string) => console.log(msg),
  });
}

/**
 * Undoes ONE migration, the last one applied, and only when it is the one named (its file name without `.sql`): the Down of that file,
 * through the same runner as `runMigrations`. For the operator, when a deploy must be taken back (README, Deployment): never run on its
 * own by the service. Throws when the last migration applied is another one (nothing is undone then), or when none is applied.
 */
export async function undoMigration(databaseUrl: string, name: string, opts: { quiet?: boolean } = {}): Promise<void> {
  const quiet = opts.quiet ?? false;
  const { Client } = await import("pg");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  let last: string | null;
  try {
    last = (await client.query<{ name: string }>("select name from pgmigrations order by run_on desc, id desc limit 1")).rows[0]?.name ?? null;
  } finally {
    await client.end();
  }
  if (last !== name) throw new Error(`the last migration applied is ${last ?? "none"}, not ${name}: nothing was undone`);
  await runner({
    databaseUrl,
    dir: MIGRATIONS_DIR,
    direction: "down",
    migrationsTable: "pgmigrations",
    count: 1,
    log: quiet ? () => {} : (msg: string) => console.log(msg),
  });
}
