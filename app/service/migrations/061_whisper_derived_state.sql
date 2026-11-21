-- Up Migration
-- Redesign D (src/whispers/store.ts, src/agents/tools/elsewhere.ts): the state of a `found_elsewhere` whisper is derived, and
-- its hits are references. It is told only because a posted message of a told reply of it exists (the message whose
-- client_txn is that run's id), telling while a told reply of it is queued or running; nothing stores `accepted` for it any
-- more (stored: open, declined, expired). Its hits are kept as the conversation and seq of each message found, read under
-- its owner's access whenever it is shown or told (none left: it reads expired). `whispers.revision` (057) is no longer
-- written: what orders two copies is computed from that state when it is read.
--
-- What was stored before: a told one (answered `accepted`, a told reply of it posted) keeps nothing more — stored open, it
-- reads told from that message. Every other open or `accepted` one is expired: its hits are copies of text, with no
-- reference to read, so it could be neither shown nor told under the new rule (converting them is not worth it: a
-- `found_elsewhere` whisper expires a day after it was made).
update whispers w set status = 'open', resolved_at = null
 where w.kind = 'found_elsewhere' and w.status = 'accepted'
   and exists (select 1 from agent_runs r join messages m on m.conversation_id = r.conversation_id and m.sender_id = r.agent_id and m.client_txn = r.id::text
                where r.whisper_id = w.id and r.owner_id = w.owner_id);
update whispers w set status = 'expired', resolved_at = now()
 where w.kind = 'found_elsewhere' and w.status in ('open', 'accepted')
   and not exists (select 1 from agent_runs r join messages m on m.conversation_id = r.conversation_id and m.sender_id = r.agent_id and m.client_txn = r.id::text
                    where r.whisper_id = w.id and r.owner_id = w.owner_id);
alter table whispers add constraint whispers_found_elsewhere_status_check check (kind <> 'found_elsewhere' or status in ('open', 'declined', 'expired'));
-- A whisper's told replies: what its state is read from, on every sync and push of it.
create index agent_runs_whisper_idx on agent_runs (whisper_id) where whisper_id is not null;

-- Down Migration
drop index agent_runs_whisper_idx;
alter table whispers drop constraint whispers_found_elsewhere_status_check;
update whispers w set status = 'accepted', resolved_at = coalesce(w.resolved_at, now())
 where w.kind = 'found_elsewhere' and w.status = 'open'
   and exists (select 1 from agent_runs r join messages m on m.conversation_id = r.conversation_id and m.sender_id = r.agent_id and m.client_txn = r.id::text
                where r.whisper_id = w.id and r.owner_id = w.owner_id);
