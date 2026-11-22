-- Up Migration
-- An invite code that admits several people (the owner posts one code to a group). `max_uses` is how many accounts the
-- code admits (1 = the single-use code of before), `uses` how many it has admitted; `used_by` / `used_at` stay as the
-- latest use (for a single-use code: its one). `revoked_at`: the operator closed it; accounts already made are untouched.
-- Who came in through a code is `invite_uses`: one row per use, its account (null when the registration made none — the
-- e-mail already had a verified account — or the account was later replaced or removed).
alter table invites add column max_uses integer not null default 1;
alter table invites add column uses integer not null default 0;
alter table invites add column revoked_at timestamptz;
alter table invites add column created_at timestamptz not null default now();
alter table invites add constraint invites_uses_bounds check (max_uses between 1 and 1000 and uses between 0 and max_uses);
-- A code used before this migration was used once.
update invites set uses = 1 where used_at is not null;

create table invite_uses (
  id bigserial primary key,
  code_hash text not null references invites (code_hash) on delete cascade,
  principal_id uuid references principals (id) on delete set null,
  used_at timestamptz not null default now()
);
create index invite_uses_code_idx on invite_uses (code_hash, id);
create index invite_uses_principal_idx on invite_uses (principal_id) where principal_id is not null;

-- Down Migration
drop table invite_uses;
alter table invites drop constraint invites_uses_bounds;
alter table invites drop column created_at;
alter table invites drop column revoked_at;
alter table invites drop column uses;
alter table invites drop column max_uses;
