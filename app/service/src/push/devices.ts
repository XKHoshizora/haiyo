import type { Db, Queryable } from "../db.ts";
import { AppError } from "../errors.ts";

/** Which APNs a token is for: a development build's is the sandbox's. */
export type PushEnv = "sandbox" | "production";

/** A phone that takes pushes (`push_devices`): one per signed-in session of the iOS app. */
export interface PushDevice {
  id: string;
  principalId: string;
  sessionId: string;
  /** The APNs device token, hex, lower-case. A secret of sorts: never logged. */
  token: string;
  env: PushEnv;
}

/**
 * Binds `token` to the caller's session (`POST /api/push/devices`). One row per session — a new token from the same session
 * replaces its old one (the phone's token changed) — and one per token: a token registered from another session, of this
 * account or another, moves here (the token names the phone, not the person). Under the session row's lock, so two
 * registrations of one session cannot both insert; a session gone meanwhile is 401, as everywhere.
 */
export async function registerDevice(
  db: Db,
  d: { principalId: string; sessionId: string; token: string; env: PushEnv; appVersion: string | null },
): Promise<void> {
  await db.tx(async (t) => {
    const live = await t.query(`select 1 from "session" where id = $1 and "expiresAt" > now() for no key update`, [d.sessionId]);
    if (live.rowCount === 0) throw new AppError(401, "unauthenticated");
    await t.query("delete from push_devices where session_id = $1 and token <> $2", [d.sessionId, d.token]);
    await t.query(
      `insert into push_devices (principal_id, session_id, token, env, app_version) values ($1, $2, $3, $4, $5)
       on conflict (token) do update
         set principal_id = excluded.principal_id, session_id = excluded.session_id, env = excluded.env,
             app_version = excluded.app_version, last_seen_at = now()`,
      [d.principalId, d.sessionId, d.token, d.env, d.appVersion],
    );
  });
}

/** Unbinds the caller's session's phone (`DELETE /api/push/devices/current`); none is no error. */
export async function removeSessionDevice(q: Queryable, sessionId: string): Promise<void> {
  await q.query("delete from push_devices where session_id = $1", [sessionId]);
}

/**
 * A token APNs said is dead: its row goes — unless the phone registered it again after the push was decided (`seenAt`,
 * `last_seen_at` as text then, to the microsecond): Apple says a dead token may be pushed again once the app retrieves it
 * again, and a registration is the app saying so.
 */
export async function removeDeadDevice(q: Queryable, device: Pick<PushDevice, "id" | "token"> & { seenAt: string }): Promise<boolean> {
  const { rowCount } = await q.query("delete from push_devices where id = $1 and token = $2 and last_seen_at = $3::timestamptz", [device.id, device.token, device.seenAt]);
  return (rowCount ?? 0) > 0;
}
