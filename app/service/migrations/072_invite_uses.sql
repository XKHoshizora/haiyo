-- Up Migration
-- An invite code that admits several people (the owner posts one code to a group). `max_uses` is how many accounts the
-- code admits (1 = the single-use code of before), `uses` how many it has admitted; `used_by` / `used_at` stay as the
-- latest use (for a single-use code: its one). `revoked_at`: the operator closed it; accounts already made are untouched.
-- A use is taken when an account becomes real, at e-mail verification, not at sign-up: a sign-up that creates nothing,
-- is replaced or is never verified costs the code nothing. Until then `pending_invites` remembers which code an
-- unverified account came with (it goes with the account when that is replaced or removed).
-- Who came in through a code is `invite_uses`: one row per use, its account. Both references to an account
-- (`invites.used_by`, `invite_uses.principal_id`) are `on delete set null`: deleting an account never depends on
-- knowing about invites, the use stays counted, and the identity goes with the account.
alter table invites add column max_uses integer not null default 1;
alter table invites add column uses integer not null default 0;
alter table invites add column revoked_at timestamptz;
alter table invites add column created_at timestamptz not null default now();
alter table invites add constraint invites_uses_bounds check (max_uses between 1 and 1000 and uses between 0 and max_uses);
-- A code used before this migration was used once (safe to run again: only rows still at 0).
update invites set uses = 1 where used_at is not null and uses = 0;
alter table invites drop constraint invites_used_by_fkey;
alter table invites add constraint invites_used_by_fkey foreign key (used_by) references principals (id) on delete set null;

create table invite_uses (
  id bigserial primary key,
  code_hash text not null references invites (code_hash) on delete cascade,
  principal_id uuid references principals (id) on delete set null,
  used_at timestamptz not null default now(),
  unique (code_hash, principal_id)
);
create index invite_uses_principal_idx on invite_uses (principal_id) where principal_id is not null;

create table pending_invites (
  principal_id uuid primary key references principals (id) on delete cascade,
  code_hash text not null references invites (code_hash) on delete cascade,
  -- A sign-up is live for as long as its verification link works (24 h, auth.ts); then the sweep removes it.
  created_at timestamptz not null default now()
);
create index pending_invites_code_idx on pending_invites (code_hash, created_at);
create index pending_invites_old_idx on pending_invites (created_at);

-- Down Migration
drop table pending_invites;
drop table invite_uses;
alter table invites drop constraint invites_used_by_fkey;
alter table invites add constraint invites_used_by_fkey foreign key (used_by) references principals (id) on delete restrict;
alter table invites drop constraint invites_uses_bounds;
alter table invites drop column created_at;
alter table invites drop column revoked_at;
alter table invites drop column uses;
alter table invites drop column max_uses;
