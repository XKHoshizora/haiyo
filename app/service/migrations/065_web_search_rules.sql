-- Up Migration
-- The web search under the product owner's rules (lane websearch2; src/agents/tools/web/hold.ts).
-- 1. A reply on a provider's model (the owner's own key) pays for its web searches from the owner's points: its first
--    search picks the source — today's free allowance, else the balance — and its `charge_to` is that source, its
--    `hold_micro` the searches' prices; settlement then charges exactly `web_micro` there. So a provider run may now carry
--    a `charge_to`, only with searches (`web_searches > 0`; a price of 0 is a search too): the run's model still costs
--    nothing. Added `not valid` and validated after, so the exclusive lock is not held through the table's scan (the old
--    check implies the new one: it cannot fail).
-- 2. No count per owner any more (the points are the bound): the owners' counter rows of the first version go.
-- 3. The site's money fuse counts money: `spent_micro_usd`, what the day's searches cost the site in micro-USD — the
--    estimate held at call time, replaced by what the engine said the call cost when it says so — and `warned_80`, set
--    once the day's money has reached 80 % of the fuse (the operator's metric line, once a site day).
alter table agent_runs drop constraint agent_runs_charge_with_site;
alter table agent_runs add constraint agent_runs_charge_with_site check (
  (charge_to is not null) = (source is not distinct from 'site')
  or (source = 'provider' and charge_to in ('free', 'balance') and web_searches > 0)
) not valid;
alter table agent_runs validate constraint agent_runs_charge_with_site;
delete from web_search_days where scope <> 'site';
alter table web_search_days add column spent_micro_usd bigint not null default 0 check (spent_micro_usd >= 0);
alter table web_search_days add column warned_80 boolean not null default false;

-- Down Migration
-- A provider run's charge for its searches is forgotten on the run (its usage record, already written, keeps it); the
-- owners' counts are not brought back (they counted days that are over).
alter table web_search_days drop column warned_80;
alter table web_search_days drop column spent_micro_usd;
update agent_runs set charge_to = null where source = 'provider' and charge_to is not null;
alter table agent_runs drop constraint agent_runs_charge_with_site;
alter table agent_runs add constraint agent_runs_charge_with_site check ((charge_to is not null) = (source is not distinct from 'site'));
