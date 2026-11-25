import { runner } from "node-pg-migrate";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

/**
 * Applies every pending migration, ALL IN ONE TRANSACTION (`singleTransaction`): the migrations one deploy brings commit together or
 * not at all. So a deploy whose later migration fails leaves the database exactly as the code that is still serving knows it (074
 * without 075 cannot exist: README, Deployment). No migration here does what a transaction cannot hold (no `create index
 * concurrently`, no enum value added and used, no `vacuum`); one that ever must has to be deployed alone. A fresh database (a test
 * database, a new site) applies the whole chain in one transaction.
 */
export async function runMigrations(databaseUrl: string, opts: { quiet?: boolean } = {}): Promise<void> {
  const quiet = opts.quiet ?? false;
  await runner({
    databaseUrl,
    dir: MIGRATIONS_DIR,
    direction: "up",
    migrationsTable: "pgmigrations",
    count: Infinity,
    singleTransaction: true,
    log: quiet ? () => {} : (msg: string) => console.log(msg),
  });
}

/**
 * What a migration's Down removes, in words an operator can weigh before running it (`migrate:down` prints it). Declared for the
 * migrations a deploy may have to take back (ring 1a's three, 074 to 076, deploy together, and 073 under them); for any other the operator is told to read the file's Down.
 */
export const DOWN_REMOVES: Readonly<Record<string, string>> = {
  "073_others_columns_and_social_skeleton":
    "073's Down drops the tables social_pairs and agent_contacts (every Agent contact and request) and the columns accounts.others_answers, others_points_micro, others_notice_seen_at (every owner's own daily numbers, and who has seen the notice), agents.others_answers, agent_runs.admitted_at, shown_notes, withheld_notes. Only when 074 and 075 are already undone.",
  "074_others_step_l":
    "074's Down writes 20 points on EVERY Agent that has no others' number of its own (also one whose owner chose no limit before), puts a proactive budget at exactly 70 back to 20 (also one an owner set to 70), and restores both column defaults (20). No row is deleted. It is the state the code from before 074 needs.",
  "075_agent_social_access":
    "075's Down DELETES, for good: every 停止往来 (the stop rows of access_bars) and the bars made from blocks, every report of an Agent (agent_reports), every Agent's contact policy and picks (agents.contact_policy, contact_picked, agent_contact_picks), every operator's disable (agents.disabled_at), every answer to a persona card (social_card_answers), whose bar ended an access (agent_contacts.barred_by) and which personas were read (agents.persona_checked_version). People who were stopped can reach those Agents again, and a later Up brings back only the bars that come from blocks.",
  "076_others_reasoning":
    "076's Down drops agents.others_reasoning and agents.proactive_reasoning: every Agent's thinking level for replies to other people and for proactive replies, the ones 076 copied from each Agent's own level and every one an owner chose since (and the index that keeps one open report per reporter and Agent). No other row changes. The code before 074 makes such replies at the Agent's own level again. It must be undone before 075 and 074 can be.",
};

/** The session lock `undoMigration` holds from its check to the end of its Down (its own key: the runner's lock is taken inside it). */
const UNDO_LOCK = 7_076_075_074;

export const CONFIRM_FLAG = "--i-understand-this-deletes-data";
export const PRODUCTION_FLAG = "--in-production";

/**
 * Undoes ONE migration, the last one applied, and only when it is the one named (its file name without `.sql`): the Down of that file,
 * through the same runner as `runMigrations`. For the operator, when a deploy must be taken back (README, Deployment): never run on its
 * own by the service. Safe by default, in this order, and nothing is undone when it throws:
 *  - the last migration applied is another one (or none is applied);
 *  - the operator has not confirmed the loss (`confirmed`: the command's `--i-understand-this-deletes-data`);
 *  - the process runs with `NODE_ENV=production` (`nodeEnv`) and the operator has not said so too (`inProduction`: `--in-production`).
 */
export async function undoMigration(
  databaseUrl: string,
  name: string,
  opts: { quiet?: boolean; confirmed?: boolean; nodeEnv?: string | undefined; inProduction?: boolean } = {},
): Promise<void> {
  const quiet = opts.quiet ?? false;
  const { Client } = await import("pg");
  // ONE connection for the check and the Down, under a lock of this command's own that the session holds from before the check
  // until after the Down (fix round 3, point 5): two operators who both name the last migration take turns, and the second one's
  // check is made after the first one's Down, so it finds another migration last and undoes nothing. (The check used to be made on a
  // connection of its own and closed before the Down began: a second Down could then remove the migration UNDER the one named.)
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [UNDO_LOCK]);
    try {
      const last = (await client.query<{ name: string }>("select name from pgmigrations order by run_on desc, id desc limit 1")).rows[0]?.name ?? null;
      if (last !== name) throw new Error(`the last migration applied is ${last ?? "none"}, not ${name}: nothing was undone`);
      if (opts.confirmed !== true) throw new Error(`a Down removes data: nothing was undone. Read what it removes (above) and, if that is what you mean, run it again with ${CONFIRM_FLAG}`);
      if (opts.nodeEnv === "production" && opts.inProduction !== true) {
        throw new Error(`this is a production environment (NODE_ENV=production): nothing was undone. If you mean to undo ${name} here, add ${PRODUCTION_FLAG}`);
      }
      await runner({
        dbClient: client,
        dir: MIGRATIONS_DIR,
        direction: "down",
        migrationsTable: "pgmigrations",
        count: 1,
        log: quiet ? () => {} : (msg: string) => console.log(msg),
      });
    } finally {
      await client.query("select pg_advisory_unlock($1)", [UNDO_LOCK]).catch(() => {});
    }
  } finally {
    await client.end();
  }
}
