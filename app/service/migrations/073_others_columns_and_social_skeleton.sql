-- Up Migration
-- Columns for others' use (design §5; plan B1–B4) and the empty skeleton of Agent social both lanes compile against (plan D1).
-- Completely inert (Controller ruling 2026-11-24 (verification), E1/N1): no existing row or default changes, nothing reads it before
-- the lanes. The step-L raise is lane B's 074; lane A's schema is 075.
alter table accounts
  add column others_answers integer check (others_answers between 1 and 1000),
  add column others_points_micro bigint check (others_points_micro between 1000000 and 100000000000),
  add column others_notice_seen_at timestamptz;
alter table agents add column others_answers integer check (others_answers between 1 and 1000);
-- When admission admitted the run (admitRun): what one answer is counted by (claim time is reset by a hold-back; attack M2).
alter table agent_runs add column admitted_at timestamptz;
create index agent_runs_others_day_idx on agent_runs (owner_id, admitted_at) where purpose = 'reply' and lane <> 'own' and admitted_at is not null;
-- The skeleton: created empty, unused until lane A's code.
alter table conversations drop constraint conversations_type_check;
alter table conversations add constraint conversations_type_check check (type in ('direct', 'group', 'agent', 'agent_social'));
create table social_pairs (
  conversation_id uuid primary key references conversations (id) on delete restrict,
  a_id uuid not null references principals (id) on delete restrict,
  b_id uuid not null references principals (id) on delete restrict,
  unique (a_id, b_id),
  check (a_id < b_id)
);
create table agent_contacts (
  agent_id uuid not null references principals (id) on delete cascade,
  subject_id uuid not null references principals (id) on delete cascade,
  person_id uuid not null references principals (id) on delete cascade,
  state text not null check (state in ('requested', 'live', 'ended')),
  basis text check (basis in ('approved', 'contacts')),
  since timestamptz not null default now(),
  until timestamptz,
  end_reason text check (end_reason in ('declined', 'expired', 'left', 'narrowed', 'removed', 'barred')),
  primary key (agent_id, subject_id),
  check (agent_id <> subject_id),
  check ((state = 'ended') = (end_reason is not null)),
  check (state <> 'live' or basis is not null),
  check (state <> 'requested' or until is not null)
);
create index agent_contacts_person_idx on agent_contacts (person_id, agent_id);
create index agent_contacts_waiting_idx on agent_contacts (agent_id, since) where state = 'requested';
alter table agent_runs drop constraint agent_runs_interrupted_check;
alter table agent_runs add constraint agent_runs_interrupted_check
  check (interrupted in ('agent_paused', 'agent_deleted', 'agent_removed', 'halted', 'owner_spoke', 'access_ended', 'notes_changed', 'errand_ended'));
alter table agent_runs add column shown_notes jsonb, add column withheld_notes jsonb;

-- Down Migration
-- (only while no agent_social conversation exists)
alter table agent_runs drop column withheld_notes, drop column shown_notes;
alter table agent_runs drop constraint agent_runs_interrupted_check;
alter table agent_runs add constraint agent_runs_interrupted_check check (interrupted in ('agent_paused', 'agent_deleted', 'agent_removed', 'halted'));
drop table agent_contacts; drop table social_pairs;
alter table conversations drop constraint conversations_type_check;
alter table conversations add constraint conversations_type_check check (type in ('direct', 'group', 'agent'));
drop index agent_runs_others_day_idx;
alter table agent_runs drop column admitted_at;
alter table agents drop column others_answers;
alter table accounts drop column others_notice_seen_at, drop column others_points_micro, drop column others_answers;
