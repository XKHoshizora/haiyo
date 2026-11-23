-- Up Migration
-- Agent social, ring 1a, lane A (design §1.1, §4's persona aid; plan A0, A8b). Deploys with lane A's code (Controller ruling 2026-11-24
-- (attack), C1), together with lane B's 074 (Controller ruling 2026-11-24 (verification), E1/N1).
-- Bars are directional and one row per decision (A-3 review C1): a row is "setter has barred other", of one kind, lifted only by its
-- setter through its own act (a stop by 恢复往来, a block by the unblock). A pair is barred iff any row exists in either direction.
create table access_bars (
  setter_id uuid not null references principals (id) on delete cascade,
  other_id uuid not null references principals (id) on delete cascade,
  kind text not null check (kind in ('stop', 'block')),
  since timestamptz not null default now(),
  primary key (setter_id, other_id, kind),
  check (setter_id <> other_id)
);
create index access_bars_other_idx on access_bars (other_id, setter_id);
-- bars from blocks begin
insert into access_bars (setter_id, other_id, kind, since)
select b.blocker_id, b.blocked_id, 'block', b.created_at
  from blocks b
  join principals pa on pa.id = b.blocker_id and pa.kind = 'human'
  join principals pb on pb.id = b.blocked_id and pb.kind = 'human';
-- bars from blocks end
alter table agents
  add column contact_policy text not null default 'ask' check (contact_policy in ('ask', 'contacts', 'none')),
  add column contact_picked boolean not null default false,
  add column disabled_at timestamptz;
create table agent_contact_picks (
  agent_id uuid not null references principals (id) on delete cascade,
  person_id uuid not null references principals (id) on delete cascade,
  primary key (agent_id, person_id)
);
create table agent_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references principals (id) on delete cascade,
  target_kind text not null constraint agent_reports_target_kind_check check (target_kind in ('agent')),
  agent_id uuid references principals (id) on delete restrict,
  conversation_id uuid references conversations (id) on delete set null,
  message_id bigint references messages (id) on delete set null,
  reason text not null check (reason in ('spam', 'harassment', 'privacy', 'other')),
  note text check (char_length(note) <= 500),
  created_at timestamptz not null default now(),
  handled_at timestamptz,
  outcome text check (outcome in ('disabled', 'dismissed')),
  constraint agent_reports_agent_shape check (target_kind <> 'agent' or agent_id is not null)
);
create index agent_reports_open_idx on agent_reports (created_at) where handled_at is null;
-- The persona aid (plan A8b). A persona saved before it counts as checked: no burst at deploy (attack M11).
alter table agents add column persona_checked_version integer not null default 0;
update agents set persona_checked_version = persona_version;
-- One answer per owner card (persona_fact now; note_withheld in ring 1b): the card's own message (attack M7).
create table social_card_answers (
  message_id bigint primary key references messages (id) on delete cascade,
  answer text not null check (answer in ('yes', 'no', 'moved', 'kept')),
  answered_at timestamptz not null default now()
);
-- Down Migration
drop table social_card_answers;
alter table agents drop column persona_checked_version;
drop table agent_reports; drop table agent_contact_picks;
alter table agents drop column disabled_at, drop column contact_picked, drop column contact_policy;
drop table access_bars;
