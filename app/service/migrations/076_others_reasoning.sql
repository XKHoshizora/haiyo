-- Up Migration
-- Owner decision 2026-11-26 (ring 1a, fix round 2): the thinking level of a reply made for somebody other than the Agent's owner, and
-- of a reply nobody asked for, is the owner's setting per Agent, not a fixed `none`. Two columns, both `none` by default: what such
-- replies ran at before this migration (step L, 074), so no reply changes until an owner picks a level. The level a run is made at is the
-- setting's EFFECTIVE level on the Agent's model (models/resolve.ts `callLevel`); the others' numbers hold for the level actually run.
alter table agents
  add column others_reasoning text not null default 'none' check (others_reasoning in ('none', 'low', 'medium', 'high', 'xhigh', 'max')),
  add column proactive_reasoning text not null default 'none' check (proactive_reasoning in ('none', 'low', 'medium', 'high', 'xhigh', 'max'));
-- One open report per reporter and Agent, decided by the table (review 2, n4): the service reads before it inserts, and two requests at
-- the same moment could both find none. (`agent_reports` is 075's and is empty wherever 076 is applied with it.)
create unique index agent_reports_one_open_idx on agent_reports (reporter_id, agent_id) where handled_at is null;
-- Down Migration
drop index agent_reports_one_open_idx;
-- (Every owner's two choices are lost; the code before 076 runs such replies at `none`.)
alter table agents
  drop column proactive_reasoning,
  drop column others_reasoning;
