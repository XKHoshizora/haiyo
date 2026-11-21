-- Up Migration
-- A rolling summary's transient failures (src/agents/summary/job.ts `afterFailure`; README "The rolling summary"): a call
-- that failed for a reason that clears by itself — the provider's 5xx, 408 or 429, a network failure, a timeout — never
-- halves its window and never sets it aside, and waits at most an hour; only once the same window has been failing so for
-- a day IN A ROW is it treated as the window's own failure (so that one input a provider always answers with a 500 cannot
-- hold the pair back for good). The window's run of them: `transient_last`, when its latest one came (null: no run);
-- `transient_ms`, how long it has been failing — each gap between two of them counting at most two hours (a quiet pair is
-- no evidence of an outage), at most a day. It goes with the attempt state; a write, a new window or a failure of the
-- window's own ends it.
alter table conversation_summary_attempts
  add column transient_last timestamptz,
  add column transient_ms integer not null default 0 check (transient_ms >= 0 and transient_ms <= 86400000);

-- Down Migration
alter table conversation_summary_attempts drop column transient_ms, drop column transient_last;
