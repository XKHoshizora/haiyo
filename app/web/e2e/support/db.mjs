// Direct changes to the local suite's own database (E2E_DATABASE, af_e2e by default) for what no person can do in the
// app, such as a message sent yesterday. Local mode only; the connection is refused unless it really is that database.
import { createRequire } from "node:module";
import path from "node:path";
import { E2E_DATABASE, REMOTE, SERVICE_DIR, e2eDatabaseUrl } from "./env.mjs";

/** Runs `work(client)` on a connection to the suite's database; resolves with what it returns. */
async function withDatabase(work) {
  if (REMOTE) throw new Error("the database is reachable only in the local suite");
  const pg = createRequire(path.join(SERVICE_DIR, "package.json"))("pg");
  const client = new pg.Client({ connectionString: e2eDatabaseUrl() });
  await client.connect();
  try {
    const { rows } = await client.query("select current_database() as name");
    if (rows[0].name !== E2E_DATABASE) throw new Error(`refusing to change database ${rows[0].name}`);
    return await work(client);
  } finally {
    await client.end();
  }
}

/**
 * Records that others' use of `ownerId`'s Agent `agentId` (its own conversation `conversationId`) was charged `micro` micro-points today:
 * a finished reply of lane `others` with its usage record — what reaching the owner's one number takes, without a model call per point.
 */
export function chargeOthersToday(ownerId, agentId, conversationId, micro) {
  if (!Number.isSafeInteger(micro) || micro < 1) throw new Error("a whole number of micro-points");
  return withDatabase(async (client) => {
    const { rows } = await client.query(
      "insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, finished_at, lane) values ('reply', $1, $2, $3, 'done', 0, now(), 'others') returning id",
      [conversationId, agentId, ownerId],
    );
    await client.query(
      "insert into usage_records (owner_id, agent_id, run_id, purpose, source, model, cost_micro, balance_micro, outcome) values ($1, $2, $3, 'reply', 'site', 'e2e', $4, $4, 'done')",
      [ownerId, agentId, rows[0].id, String(micro)],
    );
  });
}

/**
 * Moves message `seq` of conversation `conversationId` `days` whole days into the past (as if it had been sent then);
 * resolves with its new time (an ISO string).
 */
export function backdateMessage(conversationId, seq, days) {
  if (!Number.isSafeInteger(seq) || !Number.isSafeInteger(days) || days < 1) throw new Error("a message seq and a whole number of days");
  return withDatabase(async (client) => {
    const { rows } = await client.query(
      "update messages set created_at = created_at - make_interval(days => $3) where conversation_id = $1 and seq = $2 returning created_at",
      [conversationId, seq, days],
    );
    if (rows.length !== 1) throw new Error("no such message");
    return rows[0].created_at.toISOString();
  });
}

/**
 * Forgets what person `principalId` accepted (the service's `terms_acceptances`), as for an account made before the terms:
 * their next sign-in asks again. Resolves with how many acceptances there were.
 */
export function forgetTermsAcceptance(principalId) {
  return withDatabase(async (client) => (await client.query("delete from terms_acceptances where principal_id = $1", [principalId])).rowCount);
}

/**
 * Gives an Agent's stored reply `seq` of `conversationId` what a reply whose run searched the web keeps beside its text
 * (`webSources`, `webCites`; the service's agents/tools/web), straight in its body: how a spec shows such a reply without
 * turning the web search on for the shared service (and without any engine). `more`: other keys of its body to set (its
 * search words, `queries`). Resolves once it is written.
 */
export function addWebSources(conversationId, seq, webSources, webCites = [], more = {}) {
  if (!Number.isSafeInteger(seq) || !Array.isArray(webSources)) throw new Error("a message seq and a list of sources");
  return withDatabase(async (client) => {
    const { rowCount } = await client.query(
      "update messages set body = body || jsonb_build_object('webSources', $3::jsonb, 'webCites', $4::jsonb, 'lookups', '{\"web\": 1}'::jsonb) || $5::jsonb where conversation_id = $1 and seq = $2",
      [conversationId, seq, JSON.stringify(webSources), JSON.stringify(webCites), JSON.stringify(more)],
    );
    if (rowCount !== 1) throw new Error("no such message");
  });
}
/** The phones bound to person `principalId` (`push_devices`: token, env, app_version), newest first. */
export function pushDevicesOf(principalId) {
  return withDatabase(async (client) => {
    const { rows } = await client.query("select token, env, app_version from push_devices where principal_id = $1 order by created_at desc", [principalId]);
    return rows;
  });
}

/**
 * Makes `principalId`'s account, and their Agents, as old as ones from before migration 074 and not yet told of the change: the one-time notice about others'
 * use is then theirs to see (a new account never sees it). Resolves with how many rows changed (0: the person has no account row yet).
 */
export function accountFromBeforeStepL(principalId) {
  return withDatabase(async (client) => {
    const { rowCount } = await client.query("update accounts set created_at = '2020-01-01T00:00:00Z', others_notice_seen_at = null where principal_id = $1", [principalId]);
    // (The notice is for an owner who had an Agent then: their Agents are from before it too.)
    await client.query("update agents set created_at = '2020-01-02T00:00:00Z' where principal_id in (select id from principals where owner_id = $1)", [principalId]);
    return rowCount;
  });
}

/** Moves `setterId`'s 停止往来 of `otherId` `days` whole days into the past (a stop made then); resolves with its new time (an ISO string). */
export function backdateStop(setterId, otherId, days) {
  if (!Number.isSafeInteger(days) || days < 1) throw new Error("a whole number of days");
  return withDatabase(async (client) => {
    const { rows } = await client.query(
      "update access_bars set since = since - make_interval(days => $3) where setter_id = $1 and other_id = $2 and kind = 'stop' returning since",
      [setterId, otherId, days],
    );
    if (rows.length !== 1) throw new Error("no such stop");
    return rows[0].since.toISOString();
  });
}
