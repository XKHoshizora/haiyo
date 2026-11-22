-- Up Migration
-- What each account accepted, and when (src/legal.ts; README "Accounts and sessions", Terms): at registration, and again at a
-- sign-in after the terms or the privacy policy got a new version. One row per account and pair of versions, never updated:
-- the history is the proof. `adult_declared_at`: when the person declared, with this acceptance, that they are 18 or older
-- (self-declared; no date of birth is asked or kept). Goes with the account (cascade), as its sessions do.
create table terms_acceptances (
  principal_id uuid not null references principals (id) on delete cascade,
  terms_version text not null check (char_length(terms_version) between 1 and 40),
  privacy_version text not null check (char_length(privacy_version) between 1 and 40),
  accepted_at timestamptz not null default now(),
  adult_declared_at timestamptz not null,
  primary key (principal_id, terms_version, privacy_version)
);

-- The accounts `demo:seed` made for App Review (src/demo.ts): the reviewer's account and the two people it is seated with.
-- The command only ever touches a principal listed here; any other account with the same e-mail or handle stops it.
create table demo_principals (
  principal_id uuid primary key references principals (id) on delete cascade,
  role text not null check (role in ('reviewer', 'member')),
  created_at timestamptz not null default now()
);

-- Down Migration
drop table demo_principals;
drop table terms_acceptances;
