-- Up Migration
-- Limits redesign, Part 1 ("nothing is silent"): a call of a person's message on an Agent that a LIMIT refused — the Agent's owner's one
-- daily number for others' use reached, or too often (the caller's calls a minute, the owner's others' replies a minute) — is recorded,
-- one row per (message, Agent), for the message's sender alone: their copy of the message carries it (`refused`, messages/read.ts) and
-- shows it as a small line under it. Written where the refusal is decided, at the call or at admission (src/agents/runs.ts
-- `recordRefusal`). A refusal for access (a block, a stop, removed, owner-only, paused) is never recorded: it stays quiet.
create table call_refusals (
  conversation_id uuid not null,
  seq bigint not null,
  agent_id uuid not null references principals (id) on delete cascade,
  sender_id uuid not null references principals (id) on delete cascade,
  reason text not null check (reason in ('others_limit', 'too_often')),
  created_at timestamptz not null default now(),
  primary key (conversation_id, seq, agent_id),
  foreign key (conversation_id, seq) references messages (conversation_id, seq) on delete cascade
);
-- A reader's own refusals, read with the messages they are sent (`toWireForReaders`).
create index call_refusals_sender_idx on call_refusals (sender_id, conversation_id, seq);

-- Down Migration
-- (The lines under senders' messages are lost; nothing else reads the table.)
drop table call_refusals;
