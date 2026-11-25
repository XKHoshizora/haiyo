import { randomUUID } from "node:crypto";
import { z } from "zod";
import { lockAccount } from "../accounts/store.ts";
import type { Protocol, ReasoningLevel } from "../config.ts";
import type { Queryable, Tx } from "../db.ts";
import { AppError, notFound } from "../errors.ts";
import { forgetProviderRatios } from "../metering/tokens.ts";
import { userText } from "../schemas.ts";
import { openKey, sealKey } from "./crypto.ts";

/** Providers one person may have. */
export const MAX_PROVIDERS = 10;
/** Models one provider may list. */
export const MAX_MODELS = 100;

/** A model's name: what the provider calls it, 1–100 characters, one line. */
export const modelName = userText(1, 100, { singleLine: true });
export const CONTEXT_TOKENS = { min: 1_000, max: 2_000_000 } as const;

/** The thinking levels a model may list as the ones it supports: every level above `none`, in this order. */
export const MODEL_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const satisfies readonly ReasoningLevel[];
export type ModelLevel = (typeof MODEL_LEVELS)[number];
/** A model's supported levels: 1–5 distinct ones, in `MODEL_LEVELS` order. */
export const modelLevels = z
  .array(z.enum(MODEL_LEVELS))
  .min(1)
  .max(MODEL_LEVELS.length)
  .refine((list) => list.every((level, i) => i === 0 || MODEL_LEVELS.indexOf(level) > MODEL_LEVELS.indexOf(list[i - 1]!)), "distinct levels, in order");

/** What a provider's model can do. Stored as this JSON in `providers.models`, and shown as it is. */
export interface ProviderModel {
  name: string;
  vision: boolean;
  pdf: boolean;
  reasoning: boolean;
  contextTokens: number;
  /** The thinking levels it supports (only with `reasoning`); absent: every level. */
  reasoningLevels?: ModelLevel[];
  /**
   * Whether its replies may be offered tools: `false` once it was found unable to use them (`markToolsOff`) or its owner
   * said so; `true` when its owner turned them on, or once a reply's tool call ran while nothing was said
   * (`markToolsOn`); absent: not known yet, so offered (README "Model providers").
   */
  tools?: boolean;
}

const storedModel = z
  .strictObject({
    name: modelName,
    vision: z.boolean(),
    pdf: z.boolean(),
    reasoning: z.boolean(),
    contextTokens: z.number().int().min(CONTEXT_TOKENS.min).max(CONTEXT_TOKENS.max),
    reasoningLevels: modelLevels.optional(),
    tools: z.boolean().optional(),
  })
  .refine((m) => m.reasoning || m.reasoningLevels === undefined);

/**
 * The stored `models` value as a list. Something malformed reads as no models: a value that is not an array is
 * none, and an entry that is not a whole, valid model is left out (as is a second entry of the same name).
 */
export function parseModels(raw: unknown): ProviderModel[] {
  if (!Array.isArray(raw)) return [];
  const out: ProviderModel[] = [];
  for (const entry of raw) {
    const parsed = storedModel.safeParse(entry);
    if (parsed.success && !out.some((m) => m.name === parsed.data.name)) out.push(parsed.data);
  }
  return out;
}

/** A provider as its owner sees it: never the key, only its last four characters. */
export interface ProviderRow {
  id: string;
  name: string;
  protocol: Protocol;
  baseUrl: string;
  keyLast4: string;
  models: ProviderModel[];
}

interface ProviderDbRow {
  id: string;
  name: string;
  protocol: Protocol;
  base_url: string;
  key_last4: string;
  models: unknown;
}

/** The columns of `ProviderRow`. `key_cipher` is read by `loadProviderForCall` alone. */
const COLUMNS = "id, name, protocol, base_url, key_last4, models";

const toRow = (r: ProviderDbRow): ProviderRow => ({
  id: r.id,
  name: r.name,
  protocol: r.protocol,
  baseUrl: r.base_url,
  keyLast4: r.key_last4,
  models: parseModels(r.models),
});

/** The last four characters (code points) of a key: all that is ever shown of it. */
const lastFour = (key: string): string => [...key].slice(-4).join("");

const UNIQUE_VIOLATION = "23505";
const nameTaken = () => new AppError(409, "name_taken");

/** Runs an insert or update of `providers`, turning the per-owner name uniqueness into 409 `name_taken`. */
async function uniqueName<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (err) {
    if ((err as { code?: string }).code === UNIQUE_VIOLATION) throw nameTaken();
    throw err;
  }
}

/** The owner's providers, oldest first. */
export async function listProviders(q: Queryable, ownerId: string): Promise<ProviderRow[]> {
  const { rows } = await q.query<ProviderDbRow>(`select ${COLUMNS} from providers where owner_id = $1 order by created_at, id`, [ownerId]);
  return rows.map(toRow);
}

export interface NewProvider {
  name: string;
  protocol: Protocol;
  /** Already as stored (base-url.ts `providerBaseUrl`). */
  baseUrl: string;
  apiKey: string;
  models: ProviderModel[];
}

/**
 * Creates a provider with its key sealed under `secret` for the new row (its id is made first: the key is bound to it).
 * The owner's account lock serialises the count, so concurrent creates cannot pass `MAX_PROVIDERS` (400
 * `provider_limit`). 409 `name_taken`.
 */
export async function createProvider(t: Tx, ownerId: string, input: NewProvider, secret: string): Promise<ProviderRow> {
  await lockAccount(t, ownerId);
  const { rows: count } = await t.query<{ n: number }>("select count(*)::int as n from providers where owner_id = $1", [ownerId]);
  if (count[0]!.n >= MAX_PROVIDERS) throw new AppError(400, "provider_limit");
  const id = randomUUID();
  const sealed = sealKey(input.apiKey, secret, { ownerId, providerId: id });
  const { rows } = await uniqueName(() =>
    t.query<ProviderDbRow>(
      `insert into providers (id, owner_id, name, protocol, base_url, key_cipher, key_last4, models)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) returning ${COLUMNS}`,
      [id, ownerId, input.name, input.protocol, input.baseUrl, sealed, lastFour(input.apiKey), JSON.stringify(input.models)],
    ),
  );
  return toRow(rows[0]!);
}

/**
 * Locks the owner's provider row (`for no key update`: an Agent may still take it meanwhile, a delete may not) and
 * returns it; 404 when there is none, or it is someone else's.
 */
async function lockOwnedProvider(t: Tx, ownerId: string, id: string): Promise<ProviderRow> {
  const { rows } = await t.query<ProviderDbRow>(`select ${COLUMNS} from providers where id = $1 and owner_id = $2 for no key update`, [id, ownerId]);
  if (!rows[0]) throw notFound();
  return toRow(rows[0]);
}

export interface ProviderPatch {
  name?: string;
  /**
   * The new address as stored, given the provider's protocol (which never changes): what the owner typed, through
   * base-url.ts `providerBaseUrl`.
   */
  baseUrl?: (protocol: Protocol) => string;
  /** A new key, sealed again; absent: the stored one stays. */
  apiKey?: string;
  /**
   * Replaces the list. A model given without `tools` keeps what is stored for its name: whether it can use tools is
   * found out by the service (`markToolsOff`) and changed by its owner only by saying so.
   */
  models?: ProviderModel[];
}

/** A base URL's origin (scheme, host and port); null when it does not parse (then it counts as another origin). */
function originOf(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return null;
  }
}

/**
 * Edits the owner's provider; the protocol never changes. 404 when it is not theirs, 409 `name_taken`. A `baseUrl` on
 * another origin (scheme, host or port) than the stored one is 400 `invalid_request` unless the same edit carries the
 * key: the stored key is never sent to an address its owner did not save it for. A path change keeps it.
 */
export async function updateProvider(t: Tx, ownerId: string, id: string, patch: ProviderPatch, secret: string): Promise<ProviderRow> {
  const current = await lockOwnedProvider(t, ownerId, id);
  const nextBaseUrl = patch.baseUrl?.(current.protocol);
  if (nextBaseUrl !== undefined && patch.apiKey === undefined) {
    const next = originOf(nextBaseUrl);
    if (next === null || next !== originOf(current.baseUrl)) throw new AppError(400, "invalid_request");
  }
  const name = patch.name ?? current.name;
  const baseUrl = nextBaseUrl ?? current.baseUrl;
  const models =
    patch.models?.map((m) => {
      const stored = m.tools === undefined ? current.models.find((c) => c.name === m.name)?.tools : undefined;
      return stored === undefined ? m : { ...m, tools: stored };
    }) ?? current.models;
  const { rows } = await uniqueName(() =>
    patch.apiKey === undefined
      ? t.query<ProviderDbRow>(`update providers set name = $2, base_url = $3, models = $4::jsonb where id = $1 returning ${COLUMNS}`, [
          id,
          name,
          baseUrl,
          JSON.stringify(models),
        ])
      : t.query<ProviderDbRow>(
          `update providers set name = $2, base_url = $3, models = $4::jsonb, key_cipher = $5, key_last4 = $6 where id = $1 returning ${COLUMNS}`,
          [id, name, baseUrl, JSON.stringify(models), sealKey(patch.apiKey, secret, { ownerId, providerId: current.id }), lastFour(patch.apiKey)],
        ),
  );
  return toRow(rows[0]!);
}

/**
 * Adds the names a provider listed to its models (new ones with conservative defaults: no vision, no PDF, no
 * reasoning, `defaultContextTokens`, nothing said of tools), keeping every model already there with its flags — `tools`
 * too —, up to `MAX_MODELS`.
 */
export async function mergeListedModels(t: Tx, ownerId: string, id: string, names: string[], defaultContextTokens: number): Promise<ProviderRow> {
  const current = await lockOwnedProvider(t, ownerId, id);
  const models = [...current.models];
  const known = new Set(models.map((m) => m.name));
  for (const name of names) {
    if (models.length >= MAX_MODELS) break;
    if (known.has(name)) continue;
    known.add(name);
    models.push({ name, vision: false, pdf: false, reasoning: false, contextTokens: defaultContextTokens });
  }
  const { rows } = await t.query<ProviderDbRow>(`update providers set models = $2::jsonb where id = $1 returning ${COLUMNS}`, [id, JSON.stringify(models)]);
  return toRow(rows[0]!);
}

/**
 * Marks the owner's provider model `model` as one its replies are offered no tools (`tools: false`; agents/port-impl.ts
 * `toolsUnusable`, once a reply found it unable to use them): only when the provider is theirs, the model is on its list,
 * and its entry does not say `false` already (absent or `true`). True when this wrote it — then only that entry changed,
 * as stored —, false when there was nothing to write. Under the provider's row (`for no key update`, the lock an edit of
 * it takes), so of two replies finding it out at the same moment one writes and the other, waiting for it, finds it
 * written. Nothing that holds a conversation's or an Agent's row then takes a provider's other than `for key share`
 * (`lockProviderModels`), which this does not wait for: it may come first in a transaction.
 */
export function markToolsOff(t: Tx, ownerId: string, providerId: string, model: string): Promise<boolean> {
  return markTools(t, ownerId, providerId, model, false, (stored) => stored !== false);
}

/**
 * The other half: stores `tools: true` on the owner's provider model `model` after a reply in which it made a tool call
 * that ran (agents/port-impl.ts `toolsWorked`) — only when its entry says nothing of tools. An entry that says `false`
 * (its owner's word, or a failure found) or `true` is never written: what was said or learned wins. Otherwise as
 * `markToolsOff`: theirs, on the list, under the provider's row, true when this wrote it.
 */
export function markToolsOn(t: Tx, ownerId: string, providerId: string, model: string): Promise<boolean> {
  return markTools(t, ownerId, providerId, model, true, (stored) => stored === undefined);
}

/** Writes `tools: value` on that model's entry when `writable` says so of what it stores (`markToolsOff`, `markToolsOn`). */
async function markTools(t: Tx, ownerId: string, providerId: string, model: string, value: boolean, writable: (stored: boolean | undefined) => boolean): Promise<boolean> {
  const { rows } = await t.query<{ models: unknown }>("select models from providers where id = $1 and owner_id = $2 for no key update", [providerId, ownerId]);
  const stored = rows[0]?.models;
  if (!Array.isArray(stored)) return false;
  // The entry `parseModels` reads for that name: the first whole, valid one.
  for (const [i, entry] of stored.entries()) {
    const parsed = storedModel.safeParse(entry);
    if (!parsed.success || parsed.data.name !== model) continue;
    if (!writable(parsed.data.tools)) return false;
    const models = stored.map((e, j) => (j === i ? { ...(e as Record<string, unknown>), tools: value } : e));
    await t.query("update providers set models = $2::jsonb where id = $1", [providerId, JSON.stringify(models)]);
    return true;
  }
  return false;
}

/**
 * Deletes the owner's provider. Refused (409 `provider_in_use`, with the Agents) while an Agent that is not deleted
 * uses it; deleted Agents that still name it lose their model. The row is locked `for update` first, so an Agent
 * cannot take it meanwhile (`lockProviderModels` waits, then finds nothing). Its models' learned token ratios are
 * deleted with it (`forgetProviderRatios`), in the same transaction. 404 when it is not theirs.
 */
export async function deleteProvider(t: Tx, ownerId: string, id: string): Promise<void> {
  const { rows: found } = await t.query("select 1 from providers where id = $1 and owner_id = $2 for update", [id, ownerId]);
  if (found.length === 0) throw notFound();
  const { rows: users } = await t.query<{ id: string; name: string }>(
    `select p.id, p.display_name as name
       from agents a join principals p on p.id = a.principal_id
      where a.provider_id = $1 and a.deleted_at is null
      order by a.created_at, p.id`,
    [id],
  );
  if (users.length > 0) throw new AppError(409, "provider_in_use", { agents: users.map((u) => ({ id: u.id, name: u.name })) });
  await t.query(
    "update agents set model_source = null, provider_id = null, provider_model = null where provider_id = $1 and deleted_at is not null",
    [id],
  );
  await t.query("delete from providers where id = $1", [id]);
  // What its models' replies taught is that provider's own (metering/tokens.ts `ratioKey`): it goes with it.
  await forgetProviderRatios(t, id);
}

/**
 * The models of the owner's provider and the protocol it speaks, or null when there is no such provider of theirs. Takes a `for key share`
 * lock: inside a transaction that is about to point an Agent at it, a concurrent delete waits until it is done (and
 * is then refused), or has already removed it (and this finds nothing).
 */
export async function lockProviderModels(q: Queryable, ownerId: string, providerId: string): Promise<{ models: ProviderModel[]; protocol: Protocol } | null> {
  const { rows } = await q.query<{ models: unknown; protocol: Protocol }>("select models, protocol from providers where id = $1 and owner_id = $2 for key share", [providerId, ownerId]);
  return rows[0] ? { models: parseModels(rows[0].models), protocol: rows[0].protocol } : null;
}

/**
 * What calling the owner's provider takes, its key in plaintext; null when there is no such provider of theirs.
 * The one reader of a key outside crypto.ts: it goes straight to the upstream call and nowhere else. A key that
 * cannot be opened — another `PROVIDER_KEY_SECRET`, or a value sealed for another row (it is opened as this row's,
 * by the owner and id stored on it) — throws `KeyUnreadableError`.
 */
export async function loadProviderForCall(
  q: Queryable,
  ownerId: string,
  providerId: string,
  secret: string,
): Promise<{ protocol: Protocol; baseUrl: string; apiKey: string; models: ProviderModel[] } | null> {
  const { rows } = await q.query<{ id: string; owner_id: string; protocol: Protocol; base_url: string; key_cipher: Buffer; models: unknown }>(
    "select id, owner_id, protocol, base_url, key_cipher, models from providers where id = $1 and owner_id = $2",
    [providerId, ownerId],
  );
  const r = rows[0];
  if (!r) return null;
  const apiKey = openKey(r.key_cipher, secret, { ownerId: r.owner_id, providerId: r.id });
  return { protocol: r.protocol, baseUrl: r.base_url, apiKey, models: parseModels(r.models) };
}
