-- Up Migration
-- Web search, first version (src/agents/tools/web/; the site switch `TOOLS.web.enabled` is off by default).
-- `agents.web_search`: the owner's per-Agent switch (联网搜索), on by default; it matters only while the site offers web
-- search. `agent_runs.web_searches` / `web_micro`: the searches a reply's run made and their fixed price in micro-points,
-- recorded by the tool's pre-hold before the engine is called (the hold is raised by the same amount); settlement charges
-- them outside the model's clip. `usage_records.web_searches` / `web_micro`: the same, kept with the reply's usage record.
-- `web_search_days`: searches counted at call time per site day — one row per owner (`scope` = the owner's id) and one for
-- the whole site (`scope` = 'site') — under the per-owner and site caps. No foreign key: rows are counts only, and an old
-- day's rows mean nothing.
alter table agents add column web_search boolean not null default true;
alter table agent_runs add column web_searches integer not null default 0, add column web_micro bigint not null default 0;
alter table usage_records add column web_searches integer not null default 0, add column web_micro bigint not null default 0;
create table web_search_days (
  scope text not null,
  day date not null,
  searches integer not null check (searches >= 0),
  primary key (scope, day)
);

-- Down Migration
drop table web_search_days;
alter table usage_records drop column web_micro, drop column web_searches;
alter table agent_runs drop column web_micro, drop column web_searches;
alter table agents drop column web_search;
