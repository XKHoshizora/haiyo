-- Up Migration
-- Limits redesign, Part 2 ("one identity per reply"): a reply's lane and caller are fixed when its run row is made and never change.
-- A call on an Agent that already has a reply queued or running in that conversation is no longer folded into it or noted on it
-- (`agent_runs.pending_seq`, the follow-up): it waits here, one row per call, until that reply ends. The transaction that ends it takes
-- the oldest call here and the calls right after it of the same identity (lane and caller) as ONE assignment, and queues its reply
-- (src/agents/runs.ts `takeDeferred`). Written under the call's conversation row, as every writer of the Agent's runs there.
create table deferred_calls (
  agent_id uuid not null references principals (id) on delete cascade,
  conversation_id uuid not null,
  message_seq bigint not null,
  -- The Agent's owner as the call was accepted (the owner's minute for others' calls counts by it).
  owner_id uuid not null references principals (id) on delete cascade,
  -- Whose call it is, decided once as it was accepted: the owner's own (`own`), or someone else's (`others`, `caller_id` that person,
  -- null for a call relayed from a reply nobody called for). A reply nobody asked for is never a call.
  lane text not null check (lane in ('own', 'others')),
  caller_id uuid references principals (id) on delete cascade,
  -- Whose message made it: a person's, or an Agent's (a relay).
  triggered_by text not null check (triggered_by in ('human', 'agent')),
  -- Whose questions it carries (agents/runs.ts `Askers`; null: not known).
  asker_ids uuid[],
  accepted_at timestamptz not null default now(),
  primary key (agent_id, conversation_id, message_seq),
  foreign key (conversation_id, message_seq) references messages (conversation_id, seq) on delete cascade
);
-- One person's calls on other people's Agents a minute, and one owner's others' calls a minute (`accepted_at`).
create index deferred_calls_caller_idx on deferred_calls (caller_id, accepted_at) where lane = 'others';
create index deferred_calls_owner_idx on deferred_calls (owner_id, accepted_at) where lane = 'others';

-- The cutover drains instead of inferring (deploy only while the site is idle): no reply that began under the old rules goes on. A
-- queued reply ends `cancelled` now (it never reached a model); a running one is marked so that start-up recovery, before the worker
-- starts, ends it `cancelled` without posting and settles what was admitted (src/agents/port-impl.ts `recoverRun`; a group reply ends
-- with no error, a social one `access_ended`); and nothing noted on any run (`pending_seq`) is followed up by anything.
update agent_runs set status = 'cancelled', finished_at = now()
 where purpose = 'reply' and status = 'queued';
update agent_runs set interrupted = coalesce(interrupted, 'access_ended')
 where purpose = 'reply' and status = 'running';
update agent_runs set pending_seq = null where pending_seq is not null;

-- Down Migration
-- (The calls waiting here are lost: the code before 078 never answers them. Nothing else changes back.)
drop table deferred_calls;
