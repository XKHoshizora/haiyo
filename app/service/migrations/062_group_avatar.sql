-- Up Migration
-- A group can have an avatar, as a person or an Agent can (principals.avatar_key / avatar_version): the blob's key, and a
-- counter of changes that a client puts in the avatar URL. A group without one (the key is null) shows what it always showed.
alter table conversations
  add column avatar_key text,
  add column avatar_version integer not null default 0;

-- Down Migration
alter table conversations
  drop column avatar_version,
  drop column avatar_key;
