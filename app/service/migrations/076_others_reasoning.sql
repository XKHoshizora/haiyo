-- Up Migration
-- Owner decision 2026-11-26 (ring 1a, fix round 2): the thinking level of a reply made for somebody other than the Agent's owner, and
-- of a reply nobody asked for, is the owner's setting per Agent. Two columns, `none` by default for a NEW Agent. The level a run is
-- made at is the setting's EFFECTIVE level on the Agent's model (models/resolve.ts `callLevel`); the others' numbers hold for the level
-- actually run.
alter table agents
  add column others_reasoning text not null default 'none' check (others_reasoning in ('none', 'low', 'medium', 'high', 'xhigh', 'max')),
  add column proactive_reasoning text not null default 'none' check (proactive_reasoning in ('none', 'low', 'medium', 'high', 'xhigh', 'max'));
-- Controller ruling (fix round 3, point 6): the upgrade changes nobody's replies silently. The code deployed before ring 1a (before
-- 074) makes a co-member's call and a reply nobody asked for at the Agent's OWN level (`agents.reasoning`): every EXISTING Agent keeps
-- that, for both. (An owner who wants such replies cheaper sets them lower; they are priced at this level against the owner's daily
-- numbers and the proactive budget.)
update agents set others_reasoning = reasoning, proactive_reasoning = reasoning where reasoning <> 'none';
-- One open report per reporter and Agent, decided by the table (review 2, n4): the service reads before it inserts, and two requests at
-- the same moment could both find none. (`agent_reports` is 075's and is empty wherever 076 is applied with it.)
create unique index agent_reports_one_open_idx on agent_reports (reporter_id, agent_id) where handled_at is null;
-- Fix round 4 (R1): `owner_call_seqs`, the calls of a run accepted as its owner's own. Since 078 (the limits redesign, Part 2) a run's
-- lane and caller are fixed when it is made, and nothing reads or writes this column any more; it stays, empty, until a later cleanup
-- migration drops it. (Nothing is inferred into it for the rows from before it.)
alter table agent_runs add column owner_call_seqs bigint[] not null default '{}';
-- Down Migration
alter table agent_runs drop column owner_call_seqs;
drop index agent_reports_one_open_idx;
-- (Every owner's two choices are lost; the code before 076 runs such replies at `none`.)
alter table agents
  drop column proactive_reasoning,
  drop column others_reasoning;
