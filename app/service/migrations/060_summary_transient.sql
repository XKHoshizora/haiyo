-- Up Migration
-- A rolling summary's transient failures (src/agents/summary/job.ts `afterFailure`; README "The rolling summary"): a call
-- that failed for a reason that clears by itself — the provider's 5xx, 408 or 429, a network failure, a timeout — never
-- halves its window and never sets it aside, and waits at most an hour; only once the same window has failed so for a day
-- in a row is it treated as the window's own failure (so that one input a provider always answers with a 500 cannot hold
-- the pair back for good). `transient_since`: when the window's unbroken run of such failures began (null: none). It goes
-- with the attempt state.
alter table conversation_summary_attempts add column transient_since timestamptz;

-- Down Migration
alter table conversation_summary_attempts drop column transient_since;
