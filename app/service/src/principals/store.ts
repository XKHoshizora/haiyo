import type { Queryable } from "../db.ts";
import { AppError } from "../errors.ts";

/**
 * SQL: the handle of principal `p` (a `principals` alias) as everyone is shown it: a person's own; an Agent's its owner's
 * handle, a dot and its name part (`principals.handle` of an Agent, migration 048), e.g. `xiaolin.jarvis` — read now, so it
 * follows the owner's rename. The one place an Agent's full handle is put together in SQL; every read of a handle that
 * may be an Agent's goes through it, and so does every handle a model is told.
 */
export const handleOf = (p: string): string =>
  `(case when ${p}.kind = 'agent' then (select ho.handle::text from principals ho where ho.id = ${p}.owner_id) || '.' || ${p}.handle::text else ${p}.handle::text end)`;

/** The most characters a person's handle has, and an Agent's name part. */
export const HANDLE_MAX = 24;
/** The shape of a person's handle (registration, a change, a lookup): 3 to `HANDLE_MAX` of `a-z0-9_`. */
export const HANDLE_PATTERN = new RegExp(`^[a-z0-9_]{3,${HANDLE_MAX}}$`);
/** The shape of an Agent's name part: 2 to `HANDLE_MAX` of `a-z0-9_`. Its handle is `<owner's handle>.<name part>`. */
export const NAME_PART_PATTERN = new RegExp(`^[a-z0-9_]{2,${HANDLE_MAX}}$`);

/**
 * Whether `handle` is free for `principalId` (null: a registration) to take: no person holds it now and no person gave it
 * up (`reserved_handles`) — unless it is theirs. One statement, so it reads both in one snapshot: a handle given up while
 * this runs is seen held or seen reserved, never neither. A concurrent taker of the same free handle meets the unique index.
 */
export async function handleFree(q: Queryable, handle: string, principalId: string | null): Promise<boolean> {
  const { rows } = await q.query<{ principal_id: string }>(
    `select id as principal_id from principals where kind = 'human' and handle = $1
     union all select principal_id from reserved_handles where handle = $1`,
    [handle],
  );
  return rows.every((r) => r.principal_id === principalId);
}

/** How long a person waits between two changes of their handle. */
export const HANDLE_CHANGE_DAYS = 365;

/** When `principalId` may next change their handle; null when they may now (never changed, or the year has passed). */
export async function handleChangeAvailableAt(q: Queryable, principalId: string): Promise<Date | null> {
  const { rows } = await q.query<{ at: Date | null }>(
    `select case when handle_changed_at > now() - make_interval(days => $2) then handle_changed_at + make_interval(days => $2) end as at
       from principals where id = $1`,
    [principalId, HANDLE_CHANGE_DAYS],
  );
  return rows[0]?.at ?? null;
}

const UNIQUE_VIOLATION = "23505";

/**
 * Changes person `principalId`'s handle to `handle`, in the caller's transaction: their row locked first, so two changes
 * of theirs take turns — `for no key update`, as the update itself locks it (the handle is no key: its unique index is
 * partial, and no foreign key points at it), so no foreign key's check on the row (a send of theirs, a settlement, a run
 * queued for them, all `for key share`) ever waits for a rename, whatever the same transaction locks next (round 2, N-2). Their current handle: nothing changes (no year starts). Otherwise 429 `handle_change_too_soon`
 * (with `availableAt`) within `HANDLE_CHANGE_DAYS` of their last change — said before whether the handle is free — then
 * 409 `handle_taken` when it is not free (`handleFree`; a person who takes it meanwhile meets the unique index: the same
 * 409). The handle they leave is theirs for good (`reserved_handles`). False when nothing changed.
 */
export async function changeHandle(q: Queryable, principalId: string, handle: string): Promise<boolean> {
  const { rows } = await q.query<{ handle: string }>("select handle::text as handle from principals where id = $1 and kind = 'human' for no key update", [principalId]);
  const current = rows[0]?.handle;
  if (current === undefined || current === handle) return false;
  const available = await handleChangeAvailableAt(q, principalId);
  if (available !== null) throw new AppError(429, "handle_change_too_soon", { availableAt: available.toISOString() });
  if (!(await handleFree(q, handle, principalId))) throw new AppError(409, "handle_taken");
  await q.query("insert into reserved_handles (handle, principal_id) values ($1, $2) on conflict (handle) do nothing", [current, principalId]);
  try {
    await q.query("update principals set handle = $2, handle_changed_at = now() where id = $1", [principalId, handle]);
  } catch (err) {
    if ((err as { code?: string }).code === UNIQUE_VIOLATION) throw new AppError(409, "handle_taken");
    throw err;
  }
  return true;
}

export interface PublicPrincipal {
  id: string;
  handle: string;
  displayName: string;
  /** Changes with every avatar change; clients put it in the avatar URL (`?v=`). */
  avatarVersion: number;
}

/**
 * A person by exact handle. An Agent's handle finds nothing, for everyone including its owner: Agents are
 * reached through the owner's Agent routes only, and cannot be looked up or befriended.
 */
export async function findByHandle(db: Queryable, handle: string): Promise<PublicPrincipal | null> {
  const { rows } = await db.query<{ id: string; handle: string; display_name: string; avatar_version: number }>(
    "select id, handle::text as handle, display_name, avatar_version from principals where handle = $1 and kind = 'human'",
    [handle],
  );
  const r = rows[0];
  return r ? { id: r.id, handle: r.handle, displayName: r.display_name, avatarVersion: r.avatar_version } : null;
}

/**
 * Whose avatar `viewerId` may load by id: any person's, and an Agent's only when the viewer owns it or shares a
 * conversation with it now (both are current members of it: `left_seq is null` for both). For anybody else — a
 * stranger, or someone whose shared membership (theirs or the Agent's) has ended — an Agent's id finds nothing, exactly
 * as an id that is no principal (an Agent is invisible to everyone but its owner and, while they share a group, its
 * fellow members).
 */
export async function findAvatarSubject(
  db: Queryable,
  id: string,
  viewerId: string,
): Promise<{ id: string; displayName: string; avatarKey: string | null } | null> {
  const { rows } = await db.query<{ id: string; display_name: string; avatar_key: string | null }>(
    `select p.id, p.display_name, p.avatar_key from principals p
      where p.id = $1
        and (p.kind = 'human' or p.owner_id = $2
             or exists (select 1 from memberships them
                          join memberships me on me.conversation_id = them.conversation_id
                                             and me.principal_id = $2 and me.left_seq is null
                         where them.principal_id = p.id and them.left_seq is null))`,
    [id, viewerId],
  );
  const r = rows[0];
  return r ? { id: r.id, displayName: r.display_name, avatarKey: r.avatar_key } : null;
}

export async function updateDisplayName(db: Queryable, id: string, displayName: string): Promise<void> {
  await db.query("update principals set display_name = $2 where id = $1", [id, displayName]);
}

/**
 * Locks the row, swaps the key (every change counts in `avatar_version`), and returns the previous key
 * (to hold in the same transaction and delete after commit).
 */
export async function swapAvatarKey(db: Queryable, id: string, newKey: string): Promise<string | null> {
  const { rows } = await db.query<{ avatar_key: string | null }>(
    "select avatar_key from principals where id = $1 for update",
    [id],
  );
  await db.query("update principals set avatar_key = $2, avatar_version = avatar_version + 1 where id = $1", [id, newKey]);
  return rows[0]?.avatar_key ?? null;
}
