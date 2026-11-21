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

-- Down Migration
delete from conversation_summaries where text is null;
alter table conversation_summaries drop constraint conversation_summaries_items_shape;
alter table conversation_summaries drop constraint conversation_summaries_items_or_text;
alter table conversation_summaries alter column text set not null;
alter table conversation_summaries drop column items;
