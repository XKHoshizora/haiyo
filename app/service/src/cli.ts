import { config as loadDotenv } from "dotenv";
import { createBlobStore } from "./attachments/blob.ts";
import { applyConnectTuning } from "./net-tuning.ts";
import { DEFAULT_UNSENT_AFTER_MINUTES, runSweep } from "./attachments/sweeper.ts";
import { applyLedger, ensureAccount, formatPoints, lockAccount, parsePoints } from "./accounts/store.ts";
import { mailCounts } from "./auth/mail-sender.ts";
import { MAX_INVITE_USES, createInvite, listInvites, revokeInvite } from "./auth/invites.ts";
import { loadConfig } from "./config.ts";
import { createDb, type Db } from "./db.ts";
import { configureStats, formatStats, readStats } from "./memory/stats.ts";
import { CHANGE_KEEP_DAYS, sweepMemoryChanges } from "./memory/sweep.ts";
import { expireWhispers, removeOldWhispers, WHISPER_KEEP_DAYS, WHISPER_OPEN_DAYS } from "./whispers/store.ts";
import { deliverReminders } from "./metering/reminders.ts";
import { askHidden } from "./prompt.ts";
import { CONFIRM_FLAG, DOWN_REMOVES, PRODUCTION_FLAG, runMigrations, undoMigration } from "./migrate.ts";

loadDotenv({ quiet: true });
applyConnectTuning(); // the sweep reaches an S3 endpoint and every command a database: the same allowance as the service

const USAGE =
  "usage: cli.ts migrate | migrate:down --name <the last migration applied> [--i-understand-this-deletes-data] [--in-production] (the take-back of a deploy: README, Deployment) | invite:create [--ttl-hours <n>] [--uses <n>] | invite:list | invite:revoke --prefix <hash prefix> | inbox:list [--to <email>] | mail:status | attachments:sweep [--older-than <minutes>] | " +
  "credits:grant --handle <h> --points <n> [--note <text>] | credits:show --handle <h> | tier:set --handle <h> --tier <name> | models:list | memory:stats [--days <n>] | " +
  "demo:seed --email <address> [--handle <h>] [--name <text>] (password from DEMO_PASSWORD or asked) | " +
  "agent:disable <full handle> | agent:enable <full handle> | reports:list [--open] | reports:close <id prefix> --outcome disabled|dismissed (disabled also disables the Agent, as agent:disable)";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return url;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}

/**
 * The person (never an Agent: accounts belong to humans) whose handle is given. An Agent's handle is its owner's, a dot
 * and its name part (`owner.name`): found as an Agent, and refused.
 */
async function humanByHandle(db: Db, handle: string): Promise<{ id: string; handle: string }> {
  const [person, namePart] = handle.split(".", 2) as [string, string | undefined];
  const { rows } = await db.query<{ id: string; handle: string; kind: string }>(
    namePart === undefined
      ? "select id, handle::text as handle, kind from principals where kind = 'human' and handle = $1"
      : `select p.id, o.handle::text || '.' || p.handle::text as handle, p.kind from principals o join principals p on p.owner_id = o.id and p.kind = 'agent'
          where o.kind = 'human' and o.handle = $1 and p.handle = $2`,
    namePart === undefined ? [person] : [person, namePart],
  );
  const row = rows[0];
  if (!row) throw new Error(`no such handle: ${handle}`);
  if (row.kind !== "human") throw new Error(`${row.handle} is an Agent; accounts belong to people`);
  return row;
}

function requiredFlag(args: string[], name: string): string {
  const value = flag(args, name);
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
}

const [command, ...args] = process.argv.slice(2);

if (command === "migrate") {
  await runMigrations(databaseUrl());
} else if (command === "migrate:down") {
  // The operator's way back from a deploy that went wrong (README, Deployment): one migration, the last, and only the one named.
  const name = flag(args, "--name");
  if (!name || !/^[0-9]{3}_[a-z0-9_]+$/.test(name)) throw new Error("--name must be a migration's name, such as 074_others_step_l");
  // What it removes is said first, whatever follows; without the operator's confirmation nothing is undone (and in production, without a second one).
  console.log(DOWN_REMOVES[name] ?? `what ${name}'s Down removes is not declared here: read the Down part of migrations/${name}.sql before going on`);
  await undoMigration(databaseUrl(), name, { confirmed: args.includes(CONFIRM_FLAG), nodeEnv: process.env.NODE_ENV, inProduction: args.includes(PRODUCTION_FLAG) });
  console.log(`undone: ${name}`);
} else if (command === "invite:create") {
  const ttlHours = Number(flag(args, "--ttl-hours") ?? 72);
  if (!Number.isFinite(ttlHours) || ttlHours <= 0) throw new Error("--ttl-hours must be a positive number");
  const usesText = flag(args, "--uses") ?? "1";
  const uses = /^[0-9]+$/.test(usesText) ? Number(usesText) : Number.NaN;
  if (!Number.isInteger(uses) || uses < 1 || uses > MAX_INVITE_USES) {
    throw new Error(`--uses must be a whole number from 1 to ${MAX_INVITE_USES}`);
  }
  const db = createDb(databaseUrl());
  try {
    console.log(await createInvite(db, { ttlHours, uses }));
  } finally {
    await db.close();
  }
} else if (command === "invite:list") {
  const db = createDb(databaseUrl());
  try {
    // Hash prefixes only, never a code (a code is shown once, when it is made).
    const rows = await listInvites(db);
    console.log("hash\tuses\texpires\tcreated\tstate");
    const now = Date.now();
    for (const r of rows) {
      const state = r.revoked ? "revoked" : r.expiresAt.getTime() <= now ? "expired" : r.uses >= r.maxUses ? "used up" : "open";
      console.log([r.hashPrefix, `${r.uses}/${r.maxUses}`, r.expiresAt.toISOString(), r.createdAt.toISOString(), state].join("\t"));
    }
  } finally {
    await db.close();
  }
} else if (command === "invite:revoke") {
  const prefix = requiredFlag(args, "--prefix").toLowerCase();
  const db = createDb(databaseUrl());
  try {
    const result = await revokeInvite(db, prefix);
    if (!result.ok) {
      throw new Error(
        result.reason === "ambiguous" ? "more than one code starts with that prefix; give more of it"
        : result.reason === "not_found" ? "no code starts with that prefix"
        : "--prefix must be at least 6 hex characters (see invite:list)",
      );
    }
    console.log(`revoked ${result.hashPrefix}: no more sign-ups; accounts already made are untouched`);
  } finally {
    await db.close();
  }
} else if (command === "inbox:list") {
  const to = flag(args, "--to");
  const db = createDb(databaseUrl());
  try {
    const { rows } = await db.query<{ id: string; created_at: Date; recipient: string; kind: string; subject: string; body: string }>(
      `select id, created_at, recipient, kind, subject, body from mail_outbox
        where ($1::text is null or recipient = lower($1::text)) order by id`,
      [to ?? null],
    );
    for (const m of rows) {
      console.log(`#${m.id} ${m.created_at.toISOString()} to=${m.recipient} kind=${m.kind}\n  ${m.subject}\n${m.body.split("\n").map((line) => `  ${line}`).join("\n")}\n`);
    }
  } finally {
    await db.close();
  }
} else if (command === "mail:status") {
  // Counts only (no address, no text): how many mails wait for the sender, were sent, or failed (README "Mail").
  const db = createDb(databaseUrl());
  try {
    const c = await mailCounts(db);
    console.log("day         queued  sent  failed  expired  capped  retries");
    for (const d of c.days) {
      console.log(`${d.day}  ${String(d.queued).padStart(6)}  ${String(d.sent).padStart(4)}  ${String(d.failed).padStart(6)}  ${String(d.expired).padStart(7)}  ${String(d.capped).padStart(6)}  ${String(d.retries).padStart(7)}`);
    }
    if (c.days.length === 0) console.log("(no mail was to be delivered in the last 7 days)");
    console.log(`rows written in outbox mode, never to be sent: ${c.outboxOnly}`);
    if (c.refused > 0) console.log(`THE PROVIDER REFUSES OUR KEY OR SENDER: ${c.refused} mail(s) wait on a 401/403 answer; the sender is paused and probes every 5 minutes (check RESEND_API_KEY, MAIL_FROM and the domain)`);
  } finally {
    await db.close();
  }
} else if (command === "attachments:sweep") {
  // The server runs this on a timer itself (SWEEP_INTERVAL_MINUTES); this is for running it by hand.
  const raw = flag(args, "--older-than") ?? String(DEFAULT_UNSENT_AFTER_MINUTES);
  if (!/^\d+$/.test(raw)) throw new Error("--older-than must be a whole number of minutes");
  const olderThan = Number(raw);
  const config = loadConfig(); // the blob store settings, as the server uses them
  const db = createDb(config.databaseUrl, { statementTimeoutMs: config.dbStatementTimeoutMs, acquireTimeoutMs: config.dbAcquireTimeoutMs });
  // What it counts (the cards it discards, `card_expired`) is counted on the site's day, as the server counts it.
  configureStats({ siteTimezone: config.siteTimezone, log: null });
  try {
    const log = {
      error: ({ err, ...what }: Record<string, unknown>, msg: string) =>
        console.error(`${msg} (${Object.entries(what).map(([k, v]) => `${k} ${String(v)}`).join(", ")}): ${String(err)}`),
    };
    const { unsent, abandoned } = await runSweep({ db, blobs: createBlobStore(config) }, config, log, olderThan);
    console.log(`swept ${unsent} unsent attachment(s) older than ${olderThan} minutes and ${abandoned} abandoned blob(s)`);
    // The record of what memory changed too (kept 30 days): the server does this on its own timer as well.
    const changes = await sweepMemoryChanges(db);
    console.log(`swept ${changes.deleted} memory change record(s) older than ${CHANGE_KEEP_DAYS} days and discarded ${changes.discarded} that nobody answered`);
    // And the whispers left open (the server does this on the same timer; their owners are told at their next sync), and the old answered ones.
    const whispers = await expireWhispers(db, new Date(), { elsewhereTtlHours: config.whispers.elsewhereTtlHours });
    console.log(`expired ${whispers.length} whisper(s) left open ${WHISPER_OPEN_DAYS} days (a found-elsewhere one ${config.whispers.elsewhereTtlHours} hours)`);
    const removed = await removeOldWhispers(db);
    console.log(`deleted ${removed} answered or expired whisper(s) made ${WHISPER_KEEP_DAYS} days ago`);
    // And the reminders about money a settlement recorded but whose whisper was never made (their owners see them at their next sync).
    const reminded = await deliverReminders(db, config, { warn: (what, msg) => console.error(`${msg} (code ${String(what.code)})`) });
    console.log(`made ${reminded.filter((r) => r.whisper).length} reminder(s) about money left undelivered (${reminded.filter((r) => !r.whisper).length} of owners with no Agent left)`);
  } finally {
    await db.close();
  }
} else if (command === "credits:grant" || command === "credits:show" || command === "tier:set") {
  const handle = requiredFlag(args, "--handle");
  // Every argument is checked before the database is touched.
  let micro = 0n;
  if (command === "credits:grant") {
    const parsed = parsePoints(requiredFlag(args, "--points"));
    if (parsed === null || parsed === 0n) {
      throw new Error("--points must be a non-zero decimal number with at most 6 fraction digits (negative takes points back)");
    }
    micro = parsed;
  }
  let tier = "";
  if (command === "tier:set") {
    tier = requiredFlag(args, "--tier");
    const known = Object.keys(loadConfig().agentTiers);
    if (!known.includes(tier)) throw new Error(`unknown tier "${tier}"; AGENT_TIERS has: ${known.join(", ")}`);
  }
  const db = createDb(databaseUrl());
  try {
    const person = await humanByHandle(db, handle);
    if (command === "credits:grant") {
      const note = flag(args, "--note") ?? null;
      const balance = await db.tx(async (t) => {
        await lockAccount(t, person.id);
        // Taking points back is an adjustment, not a grant.
        return applyLedger(t, person.id, micro, micro < 0n ? "adjust" : "grant", note);
      });
      console.log(formatPoints(balance));
    } else if (command === "tier:set") {
      await db.tx(async (t) => {
        await ensureAccount(t, person.id);
        await t.query("update accounts set tier = $2 where principal_id = $1", [person.id, tier]);
      });
      console.log(`${person.handle} is now on tier ${tier}`);
    } else {
      const { rows } = await db.query<{ tier: string; balance_micro: string }>(
        "select tier, balance_micro::text from accounts where principal_id = $1",
        [person.id],
      );
      const row = rows[0];
      console.log(`${person.handle}\ntier ${row?.tier ?? "free"}\nbalance ${formatPoints(BigInt(row?.balance_micro ?? "0"))}`);
    }
  } finally {
    await db.close();
  }
} else if (command === "models:list") {
  // Prices are micro-points per token. The upstream key (apiKeyEnv) is deliberately never read or printed.
  for (const m of loadConfig().siteModels) {
    console.log(`${m.id}  "${m.label}"  tier ${m.tier}  protocol ${m.protocol}  in ${m.inputMicroPerToken}  out ${m.outputMicroPerToken}  (micro-points per token)`);
  }
} else if (command === "demo:seed") {
  // The App Review account (src/demo.ts): made, or put back. The password comes from the operator and is never printed.
  const email = requiredFlag(args, "--email");
  const handle = flag(args, "--handle");
  const name = flag(args, "--name");
  const password = process.env.DEMO_PASSWORD || (process.stdin.isTTY ? await askHidden("Password for the demo account (not shown): ") : "");
  if (!password) {
    console.error("demo:seed needs the demo account's password: set DEMO_PASSWORD, or run it in a terminal to be asked (it is never printed)");
    process.exit(1);
  }
  // Loaded here only: the other commands never load Better Auth or the Agents' code.
  const { createAuth, createSessionEvents } = await import("./auth/auth.ts");
  const { DemoRefused, seedDemo } = await import("./demo.ts");
  const config = loadConfig();
  const db = createDb(config.databaseUrl, { statementTimeoutMs: config.dbStatementTimeoutMs, acquireTimeoutMs: config.dbAcquireTimeoutMs });
  // Better Auth's own errors, by their message only (it logs no secret; there is no request log here).
  const auth = createAuth(config, db, createSessionEvents(), { error: ((what: unknown, msg?: string) => console.error(msg ?? String(what))) as never });
  try {
    const r = await seedDemo(db, config, auth, { email, password, ...(handle === undefined ? {} : { handle }), ...(name === undefined ? {} : { name }) });
    console.log(`${r.created ? "made" : "put back"} the demo account ${r.email} (@${r.handle}): Agent @${r.agentHandle}, group "${r.groupTitle}"`);
    if (r.model === null) console.log("warning: the site has no models (SITE_MODELS), so the demo Agent cannot reply");
  } catch (err) {
    if (!(err instanceof DemoRefused)) throw err;
    console.error(`demo:seed refused: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await db.close();
  }
} else if (command === "agent:disable" || command === "agent:enable") {
  // The operator's switch on one Agent (README "Agent social"): by its full handle `<owner>.<name>`. Prints an id prefix and counts, nothing anyone wrote.
  const handle = args[0];
  if (handle === undefined || handle.startsWith("--")) throw new Error(`${command} needs the Agent's full handle (<owner>.<name>)`);
  const { disableAgent, enableAgent } = await import("./social/reports.ts");
  const db = createDb(databaseUrl());
  try {
    if (command === "agent:disable") {
      const r = await disableAgent(db, handle);
      if (r === null) throw new Error(`no such Agent: ${handle}`);
      console.log(`disabled agent ${r.agentId.slice(0, 8)}: ${r.ended.cancelled.length} queued replies cancelled, ${r.ended.running.length} running replies interrupted; its rows are untouched; it is gone to everyone but its owner through the one access decision (refusedSql), in groups too`);
    } else {
      const r = await enableAgent(db, handle);
      if (r === null) throw new Error(`no such Agent: ${handle}`);
      console.log(`enabled agent ${r.agentId.slice(0, 8)}`);
    }
  } finally {
    await db.close();
  }
} else if (command === "reports:list") {
  // One line per report: the id's prefix, never the note, a message or the reporter's name (their id's prefix only).
  const { listReports, REPORT_PREFIX_MIN } = await import("./social/reports.ts");
  const db = createDb(databaseUrl());
  try {
    console.log("id	created	agent	reason	reporter	note	conversation	state");
    for (const r of await listReports(db, { open: args.includes("--open") })) {
      console.log(
        [r.id.slice(0, REPORT_PREFIX_MIN), r.createdAt.toISOString(), r.agentHandle, r.reason, r.reporterId.slice(0, 8), r.hasNote ? "yes" : "no", r.hasConversation ? "yes" : "no", r.outcome ?? "open"].join("	"),
      );
    }
  } finally {
    await db.close();
  }
} else if (command === "reports:close") {
  const prefix = args[0];
  if (prefix === undefined || prefix.startsWith("--")) throw new Error("reports:close needs the report's id (the prefix reports:list prints)");
  const outcome = requiredFlag(args, "--outcome");
  if (outcome !== "disabled" && outcome !== "dismissed") throw new Error("--outcome must be disabled or dismissed");
  const { closeReport } = await import("./social/reports.ts");
  const db = createDb(databaseUrl());
  try {
    const r = await closeReport(db, prefix, outcome);
    if ("refused" in r) {
      throw new Error(
        r.refused === "short" ? "give at least 8 characters of the report's id (see reports:list)"
        : r.refused === "not_found" ? "no report starts with that"
        : r.refused === "ambiguous" ? "more than one report starts with that; give more of it"
        : "that report is closed already",
      );
    }
    console.log(
      r.disabled
        ? `closed ${r.closed.slice(0, 8)}: ${outcome}; disabled agent ${r.disabled.agentId.slice(0, 8)}: ${r.disabled.ended.cancelled.length} queued replies cancelled, ${r.disabled.ended.running.length} running replies interrupted`
        : `closed ${r.closed.slice(0, 8)}: ${outcome}`,
    );
  } finally {
    await db.close();
  }
} else if (command === "memory:stats") {
  // The memory counters (README "Memory counters"): counts only, no owner, conversation or text; days as columns.
  const days = Number(flag(args, "--days") ?? "7");
  if (!Number.isInteger(days) || days < 1 || days > 366) throw new Error("--days needs a whole number from 1 to 366");
  const db = createDb(databaseUrl());
  try {
    console.log(formatStats(await readStats(db, days), days));
  } finally {
    await db.close();
  }
} else {
  console.error(USAGE);
  process.exit(1);
}
