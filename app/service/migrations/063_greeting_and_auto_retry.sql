-- Up Migration
-- A new Agent's first message is its model's own (src/agents/conversation.ts `createAgent`: principle P2, no fixed
-- greeting): the reply queued at creation that greets its owner is marked so (`greets`), and its run is told to greet
-- (src/agents/port-impl.ts `begin`). False for every other run.
alter table agent_runs add column greets boolean not null default false;

-- A reply that failed for a passing reason is tried again by the system (src/agents/runs.ts `scheduleAutoRetry`): the
-- retry is an ordinary queued run that is not claimed before `not_before` (the backoff), names the run of the original call
-- (`retry_of`: null for an original) and how many automatic attempts came before it (`auto_attempt`: 0 for an original;
-- 1, 2 for the system's retries). Null `not_before`: claimed as soon as there is room, as ever.
alter table agent_runs add column retry_of uuid references agent_runs (id) on delete restrict;
alter table agent_runs add column auto_attempt smallint not null default 0 check (auto_attempt >= 0);
alter table agent_runs add column not_before timestamptz;
alter table agent_runs add constraint agent_runs_retry_attempt check ((retry_of is null) = (auto_attempt = 0));

-- Down Migration
alter table agent_runs drop constraint agent_runs_retry_attempt;
alter table agent_runs drop column not_before;
alter table agent_runs drop column auto_attempt;
alter table agent_runs drop column retry_of;
alter table agent_runs drop column greets;
