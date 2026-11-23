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
 * turning the web search on for the shared service (and without any engine). Resolves once it is written.
 */
export function addWebSources(conversationId, seq, webSources, webCites = []) {
  if (!Number.isSafeInteger(seq) || !Array.isArray(webSources)) throw new Error("a message seq and a list of sources");
  return withDatabase(async (client) => {
    const { rowCount } = await client.query(
      "update messages set body = body || jsonb_build_object('webSources', $3::jsonb, 'webCites', $4::jsonb, 'lookups', '{\"web\": 1}'::jsonb) where conversation_id = $1 and seq = $2",
      [conversationId, seq, JSON.stringify(webSources), JSON.stringify(webCites)],
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
