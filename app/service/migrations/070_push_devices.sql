-- Up Migration
-- The phones that take pushes (src/push/, README "Push notifications"): one row per signed-in session of the iOS app.
-- A row belongs to its session: signing out or a revoked session deletes the session row, and with it this one; so does
-- deleting the person. The token names the phone, not the person: registered from another account (or another session),
-- the row moves there (src/push/devices.ts `registerDevice`). A token APNs says is dead (410, BadDeviceToken) is deleted.
create table push_devices (
  id uuid primary key default gen_random_uuid(),
  principal_id uuid not null references principals (id) on delete cascade,
  session_id text not null unique references "session" (id) on delete cascade,
  -- The APNs device token, hex, lower-case (Apple gives 32 bytes today and says it may change: 32 to 100 bytes here).
  token text not null unique check (token ~ '^([0-9a-f]{2}){32,100}$'),
  -- Which APNs the token is for: a development build's is the sandbox's.
  env text not null check (env in ('sandbox', 'production')),
  app_version text check (app_version is null or length(app_version) between 1 and 32),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index push_devices_principal on push_devices (principal_id);

-- Down Migration
drop table push_devices;
