-- Up Migration
-- A rolling summary is structured (redesign B; src/agents/summary/): who said something is a reference, never text.
-- `items` is `{"人物与称呼": [...], "说过的事": [...], "定下的事": [...], "还没解决的": [...]}`, each item `{"said_by": <the
-- principal id of whoever said or settled it, or null for nobody in particular>, "text": <the thing, on one line>}`. The
-- model that writes it names a speaker only by a key of the roster its call was given, which the job turns into the
-- account; a reply is shown who said each item by account, with the name of the moment (store.ts `shownSummary`). `text`
-- stays for a row written before this, which holds text only and is shown to no reply until a job writes it anew (then
-- `text` is null); the 056 `speakers` stays, unused. A row holds one or the other, never neither; its items are an
-- object, at most 256 KiB as text (well above what the caps allow: at most 40 items, held as shown to `summaryMaxWeight`,
-- at most 2000). Never on the wire.
alter table conversation_summaries add column items jsonb;
alter table conversation_summaries alter column text drop not null;
alter table conversation_summaries add constraint conversation_summaries_items_or_text check (items is not null or text is not null);
alter table conversation_summaries add constraint conversation_summaries_items_shape
  check (items is null or (jsonb_typeof(items) = 'object' and octet_length(items::text) <= 262144));

-- A pair's attempt state (src/agents/summary/store.ts `AttemptState`; README "The rolling summary"): when its summary job
-- may call again and what after a call that wrote nothing, kept here so that neither a restart nor a second process pays
-- for the same window twice, and every window gets through or is set aside by rule. `failed_upto`: how far the window
-- that failed reaches, while its failure streak runs (null: none); `failures`: the calls in a row that wrote nothing;
-- `floor_failures`: those made at the smallest window; `empty_answer`: the last of them was a long window answered with
-- nothing; `not_before`: when the pair may be asked again (the minimum interval after a write, the backoff after a call
-- that wrote nothing, a claim's lapse while a call is under way); `window_messages`: the most messages the next window
-- takes, halved after failures (null: the most a job reads); `skipped_messages`: how many messages were ever set aside for
-- the pair (a window that kept failing at the smallest size: in no summary). A row may exist with no summary yet; it goes
-- with the pair's summary (a new topic, the end of a stay), its conversation or its Agent. Never on the wire.
create table conversation_summary_attempts (
  conversation_id uuid not null references conversations (id) on delete cascade,
  agent_id uuid not null references agents (principal_id) on delete cascade,
  failed_upto bigint,
  failures integer not null default 0 check (failures >= 0),
  floor_failures integer not null default 0 check (floor_failures >= 0),
  empty_answer boolean not null default false,
  not_before timestamptz,
  window_messages integer check (window_messages > 0),
  skipped_messages integer not null default 0 check (skipped_messages >= 0),
  primary key (conversation_id, agent_id)
);

-- Down Migration
drop table conversation_summary_attempts;
delete from conversation_summaries where text is null;
alter table conversation_summaries drop constraint conversation_summaries_items_shape;
alter table conversation_summaries drop constraint conversation_summaries_items_or_text;
alter table conversation_summaries alter column text set not null;
alter table conversation_summaries drop column items;
