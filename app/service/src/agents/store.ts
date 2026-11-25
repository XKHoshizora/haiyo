import type { Config } from "../config.ts";
import { REASONING_LEVELS, type ProactiveLevel, type Protocol, type ReasoningLevel } from "../config.ts";
import { lockConversation } from "../conversations/store.ts";
import type { Queryable, Tx } from "../db.ts";
import { AppError, notFound } from "../errors.ts";
import { handleOf } from "../principals/store.ts";
import { sendableLevels } from "../models/resolve.ts";
import { lockProviderModels } from "../providers/store.ts";
import { forgetSummaries } from "./summary/store.ts";

export type ReplyMode = "always" | "mention";

export const GROUP_MENTIONS = ["members", "owner"] as const;
/** Who may call the Agent with `@` in a group it is in: every member, or its owner only. The owner's setting. */
export type GroupMentions = (typeof GROUP_MENTIONS)[number];

/** What the Agent answers with; `null` until the owner has chosen. */
export type AgentModel = { source: "site"; id: string } | { source: "provider"; providerId: string; model: string } | null;

export interface AgentRow {
  id: string;
  ownerId: string;
  /** Its full handle, `<owner's handle>.<name part>` (`handleOf`), read now. */
  handle: string;
  /** Its name part (`principals.handle` of an Agent): unique among its owner's Agents that are not deleted. */
  namePart: string;
  /** `principals.display_name`. */
  name: string;
  /** `principals.avatar_version`. */
  avatarVersion: number;
  intro: string;
  field: string;
  persona: string;
  personaVersion: number;
  replyMode: ReplyMode;
  groupMentions: GroupMentions;
  /**
   * The most its owner pays, in micro-points, for its replies in a group that other Agents' messages called for between
   * two messages from people (`chainBudget`, runs.ts `triggerFromAgent`). The owner's setting.
   */
  chainBudgetMicro: bigint;
  /**
   * The most its owner pays, in micro-points, in a site day for its replies that people other than its owner called for
   * (lane `others`; `othersLimit.points`): a sub-limit inside the owner's own numbers, held to at admission with the hold
   * (metering/others.ts `othersFits`); null for none of its own (a new Agent has none: 074). The owner's setting.
   */
  othersBudgetMicro: bigint | null;
  /** The most answers a site day it may give people other than its owner (`othersLimit.answers`), both lanes; null for none of its own. The owner's setting. */
  othersAnswers: number | null;
  /** Whether it may answer in a group without being called, when the judgement model picks it. The owner's setting. */
  proactive: boolean;
  /** How readily it does (`less`, `normal`, `more`). The owner's setting. */
  proactiveLevel: ProactiveLevel;
  /** The most its owner pays, in micro-points, in a site day for such replies (lane `proactive`). The owner's setting. */
  proactiveBudgetMicro: bigint;
  /** Whether it keeps notes (memory.ts); off: it remembers nothing and is shown no notes. The owner's setting. */
  memory: boolean;
  /** Whether a change of its notes waits for its owner's yes. The owner's setting. */
  memoryAsk: boolean;
  /** Whether it uses the notes about its owner that all their Agents share. The owner's setting. */
  sharedNotes: boolean;
  /**
   * Whether, when a search of its reply in a group finds nothing there, it looks in its other conversations and whispers
   * what it finds to its owner (群里没找到时悄悄告诉我, Task 8: tools/elsewhere.ts). The owner's setting; on by default.
   */
  whisperElsewhere: boolean;
  /**
   * Whether its replies may search the web (联网搜索, lane websearch: tools/web/), while the site offers web search. The owner's
   * setting; on by default.
   */
  webSearch: boolean;
  /** What it calls its owner (1–20 characters, one line); null: by name. The owner's setting. */
  ownerAppellation: string | null;
  reasoning: ReasoningLevel;
  /**
   * The level a reply somebody other than its owner called for is made at (a co-member's @, a visitor's message), and the level of a
   * reply nobody asked for (Owner decision 2026-11-26; migration 076). The owner's settings, `none` by default; a run is made at each
   * one's effective level on the model (models/resolve.ts `callLevel`), and the others' numbers hold for that level.
   */
  othersReasoning: ReasoningLevel;
  proactiveReasoning: ReasoningLevel;
  model: AgentModel;
  paused: boolean;
  deleted: boolean;
  /** The site's operator turned it off (`agents.disabled_at`): to everyone but its owner it is gone. */
  operatorDisabled: boolean;
  /** The Agent's dedicated conversation with its owner (`agent_conversations`). */
  conversationId: string;
  createdAt: Date;
}

interface AgentDbRow {
  id: string;
  owner_id: string;
  handle: string;
  name_part: string;
  name: string;
  avatar_version: number;
  intro: string;
  field: string;
  persona: string;
  persona_version: number;
  reply_mode: ReplyMode;
  group_mentions: GroupMentions;
  chain_budget_micro: string;
  others_budget_micro: string | null;
  others_answers: number | null;
  proactive: boolean;
  proactive_level: ProactiveLevel;
  proactive_budget_micro: string;
  memory: boolean;
  memory_ask: boolean;
  shared_notes: boolean;
  whisper_elsewhere: boolean;
  web_search: boolean;
  owner_appellation: string | null;
  reasoning: ReasoningLevel;
  others_reasoning: ReasoningLevel;
  proactive_reasoning: ReasoningLevel;
  model_source: "site" | "provider" | null;
  site_model_id: string | null;
  provider_id: string | null;
  provider_model: string | null;
  paused: boolean;
  deleted: boolean;
  operator_disabled: boolean;
  conversation_id: string;
  created_at: Date;
}

const SELECT = `select p.id, p.owner_id, ${handleOf("p")} as handle, p.handle::text as name_part, p.display_name as name, p.avatar_version, a.intro, a.field, a.persona,
       a.persona_version, a.reply_mode, a.group_mentions, a.chain_budget_micro::text,
       a.others_budget_micro::text, a.others_answers, a.proactive, a.proactive_level, a.proactive_budget_micro::text, a.memory, a.memory_ask, a.shared_notes, a.whisper_elsewhere, a.web_search, a.owner_appellation, a.reasoning, a.others_reasoning, a.proactive_reasoning, a.model_source, a.site_model_id, a.provider_id, a.provider_model,
       a.paused, a.deleted_at is not null as deleted, a.disabled_at is not null as operator_disabled, ac.conversation_id, a.created_at
  from agents a
  join principals p on p.id = a.principal_id
  join agent_conversations ac on ac.agent_id = a.principal_id`;

/** An Agent's model from its `agents` columns (any query that reads them: `model_source`, `site_model_id`, `provider_id`, `provider_model`). */
export const agentModelOf = (r: {
  model_source: "site" | "provider" | null;
  site_model_id: string | null;
  provider_id: string | null;
  provider_model: string | null;
}): AgentModel =>
  r.model_source === "site"
    ? { source: "site", id: r.site_model_id! }
    : r.model_source === "provider"
      ? { source: "provider", providerId: r.provider_id!, model: r.provider_model! }
      : null;

function toAgent(r: AgentDbRow): AgentRow {
  const model = agentModelOf(r);
  return {
    id: r.id,
    ownerId: r.owner_id,
    handle: r.handle,
    namePart: r.name_part,
    name: r.name,
    avatarVersion: r.avatar_version,
    intro: r.intro,
    field: r.field,
    persona: r.persona,
    personaVersion: r.persona_version,
    replyMode: r.reply_mode,
    groupMentions: r.group_mentions,
    chainBudgetMicro: BigInt(r.chain_budget_micro),
    othersBudgetMicro: r.others_budget_micro === null ? null : BigInt(r.others_budget_micro),
    othersAnswers: r.others_answers,
    proactive: r.proactive,
    proactiveLevel: r.proactive_level,
    proactiveBudgetMicro: BigInt(r.proactive_budget_micro),
    memory: r.memory,
    memoryAsk: r.memory_ask,
    sharedNotes: r.shared_notes,
    whisperElsewhere: r.whisper_elsewhere,
    webSearch: r.web_search,
    ownerAppellation: r.owner_appellation,
    reasoning: r.reasoning,
    othersReasoning: r.others_reasoning,
    proactiveReasoning: r.proactive_reasoning,
    model,
    paused: r.paused,
    deleted: r.deleted,
    operatorDisabled: r.operator_disabled,
    conversationId: r.conversation_id,
    createdAt: r.created_at,
  };
}

/** The `agents` columns that say which model, in the order of `modelParams`. */
export function modelParams(model: AgentModel): [string | null, string | null, string | null, string | null] {
  if (model === null) return [null, null, null, null];
  return model.source === "site" ? ["site", model.id, null, null] : ["provider", null, model.providerId, model.model];
}

/**
 * Locks one conversation row, then the Agent's `agents` row (`for update`): the order every writer uses (pair lock →
 * one conversation → agents → run rows → accounts). One conversation is taken `for update`; a writer that also writes rows
 * pointing at other conversations (groups) takes those rows `for key share` before all of it, in id order, in one statement
 * (conversations/store.ts `lockConversationKeys`, memory/pipeline.ts `lockSwitchGroups`: the memory switch, a group's review or
 * hearsay, a dream's split, undo and confirm of a memory change, the hearsay confirm). Key share never waits for key share, and
 * the one row taken `for update` comes after, so several conversation rows are held then without breaking the order: do not
 * "fix" them into it. The conversation is the one the caller acts in — whatever acts for
 * a run passes the run's own (`agent_runs.conversation_id`) — and by default the Agent's dedicated conversation, which
 * the owner's routes on the Agent itself (edit, pause, resume, delete, avatar, proposals) take. Pause, resume, delete
 * and `postAsAgent` go through it, so the row it returns cannot change until the transaction ends. 404 for an unknown
 * Agent (or conversation). Whose Agent it is is not checked here: `lockOwnedAgent` does that for the owner's routes;
 * nor whether the Agent is in that conversation: its caller knows why it acts there.
 */
export async function lockAgent(t: Tx, agentId: string, conversationId?: string): Promise<AgentRow> {
  let target = conversationId;
  if (target === undefined) {
    const found = await t.query<{ conversation_id: string }>("select conversation_id from agent_conversations where agent_id = $1", [agentId]);
    if (!found.rows[0]) throw notFound();
    target = found.rows[0].conversation_id;
  }
  if (!(await lockConversation(t, target))) throw notFound();
  const { rows } = await t.query<AgentDbRow>(`${SELECT} where a.principal_id = $1 for update of a`, [agentId]);
  if (!rows[0]) throw notFound();
  return toAgent(rows[0]);
}

/** `lockAgent` for its owner's routes: 404, exactly as for an unknown id, when it is anybody else's. */
export async function lockOwnedAgent(t: Tx, ownerId: string, agentId: string): Promise<AgentRow> {
  const owned = await readOwnedAgent(t, ownerId, agentId);
  if (!owned) throw notFound();
  return lockAgent(t, agentId);
}

/** Agent `agentId` when it is neither paused nor deleted (whoever owns it: background work reads it so); else null. */
export async function liveAgent(q: Queryable, agentId: string): Promise<AgentRow | null> {
  const owner = await q.query<{ owner_id: string }>("select owner_id from principals where id = $1", [agentId]);
  if (!owner.rows[0]) return null;
  const agent = await readOwnedAgent(q, owner.rows[0].owner_id, agentId);
  return agent && !agent.paused && !agent.deleted ? agent : null;
}

export async function readOwnedAgent(q: Queryable, ownerId: string, agentId: string): Promise<AgentRow | null> {
  const { rows } = await q.query<AgentDbRow>(`${SELECT} where a.principal_id = $2 and p.owner_id = $1`, [ownerId, agentId]);
  return rows[0] ? toAgent(rows[0]) : null;
}

/** The owner's Agents, deleted ones included (flagged), oldest first. */
export async function listOwnedAgents(q: Queryable, ownerId: string): Promise<AgentRow[]> {
  const { rows } = await q.query<AgentDbRow>(`${SELECT} where p.owner_id = $1 order by a.created_at, p.id`, [ownerId]);
  return rows.map(toAgent);
}

/**
 * How many Agents an account of `tier` may have that are not deleted: what `AGENT_TIERS` gives it, and for a tier the
 * configuration does not name (an own key of it, so no name an object inherits counts) the `free` number. The one
 * definition: Agent creation and `GET /api/usage` both use it.
 */
export function agentLimit(config: Pick<Config, "agentTiers">, tier: string): number {
  return Object.hasOwn(config.agentTiers, tier) ? config.agentTiers[tier]! : config.agentTiers.free!;
}

/**
 * How many Agents the owner has that are not deleted: what counts against `agentLimit`. In a transaction (creation
 * counts under the owner's account lock) or on the pool (`GET /api/usage`).
 */
export async function countLiveAgents(q: Queryable, ownerId: string): Promise<number> {
  const { rows } = await q.query<{ n: number }>(
    `select count(*)::int as n from agents a join principals p on p.id = a.principal_id where p.owner_id = $1 and a.deleted_at is null`,
    [ownerId],
  );
  return rows[0]!.n;
}

/**
 * 400 `invalid_request` unless the model exists for this owner and the reasoning level suits it: a site model
 * must be in `config.siteModels` and allows `none` plus its own `reasoning` levels; a provider model must be
 * listed by a provider of this owner (providers/store.ts; a malformed `models` value lists nothing), with a context
 * larger than the output limit its calls get (`providerDefaultMaxOutputTokens`; a site model's is checked when the
 * configuration loads), and allows `none` only, unless its `reasoning` flag is set: then `none` and its
 * `reasoningLevels` (every level when it lists none). With no model chosen yet any level is accepted (it is checked when
 * a model is chosen). A run does not check again and never fails for it: it is made at the Agent's effective level
 * (models/resolve.ts `callLevel`) — the saved one when the model still lists it, else the nearest listed level below it.
 *
 * The levels a save accepts are EXACTLY the ones the picker offers (fix round 4, F4): `none` and the levels the model can RUN at
 * (models/resolve.ts `sendableLevels`: each level it lists as its protocol sends it — a Chat Completions or Gemini model that
 * lists `max` offers `xhigh`, and `max` itself is no choice). Each of `levels` is held to that: the Agent's own level and its two
 * levels for others (`othersReasoning`, `proactiveReasoning`). One exception, so that nothing saved before stops being saveable:
 * a level sent back UNCHANGED for an Agent whose model is unchanged (`saved`) is accepted as it stands — the Agent's own when the
 * model's own list has it (`max` there: it runs as `xhigh`), a level for others always (they were not held to the model before).
 */
export async function assertModelChoice(
  q: Queryable,
  ownerId: string,
  model: AgentModel,
  levels: ReasoningLevel | readonly LevelAsked[],
  config: Pick<Config, "siteModels" | "providerDefaultMaxOutputTokens">,
): Promise<void> {
  if (model === null) return;
  let listed: readonly ReasoningLevel[];
  let protocol: Protocol;
  if (model.source === "site") {
    const site = config.siteModels.find((m) => m.id === model.id);
    if (!site) throw new AppError(400, "invalid_request");
    listed = site.reasoning;
    protocol = site.protocol;
  } else {
    // Locked `for key share` (in the caller's transaction): a concurrent delete of the provider waits or has happened.
    const provider = await lockProviderModels(q, ownerId, model.providerId);
    const entry = provider?.models.find((m) => m.name === model.model);
    if (!provider || !entry || entry.contextTokens <= config.providerDefaultMaxOutputTokens) throw new AppError(400, "invalid_request");
    listed = entry.reasoning ? (entry.reasoningLevels ?? REASONING_LEVELS) : [];
    protocol = provider.protocol;
  }
  const offered = sendableLevels(protocol, listed);
  for (const asked of typeof levels === "string" ? [{ level: levels } as LevelAsked] : levels) {
    if (offered.includes(asked.level)) continue;
    if (asked.saved === asked.level && (asked.forOthers === true || listed.includes(asked.level))) continue;
    throw new AppError(400, "invalid_request");
  }
}

/** A level a save names (`assertModelChoice`). */
export interface LevelAsked {
  level: ReasoningLevel;
  /** The level stored now, for an Agent whose model this save does not change: sent back unchanged it is accepted. */
  saved?: ReasoningLevel;
  /** One of the two levels for others (accepted unchanged whatever the model lists). */
  forOthers?: boolean;
}

export interface AgentPatch {
  name?: string;
  intro?: string;
  field?: string;
  persona?: string;
  replyMode?: ReplyMode;
  groupMentions?: GroupMentions;
  chainBudgetMicro?: bigint;
  othersBudgetMicro?: bigint | null;
  othersAnswers?: number | null;
  proactive?: boolean;
  proactiveLevel?: ProactiveLevel;
  proactiveBudgetMicro?: bigint;
  memory?: boolean;
  memoryAsk?: boolean;
  sharedNotes?: boolean;
  whisperElsewhere?: boolean;
  webSearch?: boolean;
  ownerAppellation?: string | null;
  reasoning?: ReasoningLevel;
  othersReasoning?: ReasoningLevel;
  proactiveReasoning?: ReasoningLevel;
  model?: AgentModel;
}

/** Applies an edit to a locked, undeleted Agent; a persona that differs from the stored one is a new version. */
export async function updateAgent(t: Tx, current: AgentRow, patch: AgentPatch): Promise<AgentRow> {
  const next = { ...current, ...patch };
  const personaVersion = next.persona === current.persona ? current.personaVersion : current.personaVersion + 1;
  await t.query(
    `update agents set intro = $2, field = $3, persona = $4, persona_version = $5, reply_mode = $6, group_mentions = $7,
            reasoning = $8, model_source = $9, site_model_id = $10, provider_id = $11, provider_model = $12, chain_budget_micro = $13,
            others_budget_micro = $14, owner_appellation = $15, proactive = $16, proactive_level = $17,
            proactive_budget_micro = $18, memory = $19, memory_ask = $20, shared_notes = $21, whisper_elsewhere = $22, web_search = $23,
            others_answers = $24, others_reasoning = $25, proactive_reasoning = $26
      where principal_id = $1`,
    [
      current.id,
      next.intro,
      next.field,
      next.persona,
      personaVersion,
      next.replyMode,
      next.groupMentions,
      next.reasoning,
      ...modelParams(next.model),
      next.chainBudgetMicro.toString(),
      next.othersBudgetMicro === null ? null : next.othersBudgetMicro.toString(),
      next.ownerAppellation,
      next.proactive,
      next.proactiveLevel,
      next.proactiveBudgetMicro.toString(),
      next.memory,
      next.memoryAsk,
      next.sharedNotes,
      next.whisperElsewhere,
      next.webSearch,
      next.othersAnswers,
      next.othersReasoning,
      next.proactiveReasoning,
    ],
  );
  if (next.name !== current.name) await t.query("update principals set display_name = $2 where id = $1", [current.id, next.name]);
  return { ...next, personaVersion };
}

/**
 * Sets `paused` or deletes (`deleted_at`, irreversible) on a locked Agent; true when something changed. A delete also deletes
 * its rolling summary of its own conversation (agents/summary/; its groups' go as it leaves them, group-leave.ts).
 */
export async function setAgentState(t: Tx, agent: AgentRow, change: { paused: boolean } | { deleted: true }): Promise<boolean> {
  if ("deleted" in change) {
    if (agent.deleted) return false;
    await t.query("update agents set deleted_at = now() where principal_id = $1", [agent.id]);
    await forgetSummaries(t, agent.conversationId, [agent.id]);
    return true;
  }
  if (agent.paused === change.paused) return false;
  await t.query("update agents set paused = $2 where principal_id = $1", [agent.id, change.paused]);
  return true;
}

/** How many people and Agents one Agent may have an appellation for. */
export const MAX_APPELLATIONS = 100;

/**
 * SQL: principal `target` and Agent `agent` (expressions) are both current members of one open group now — one of the
 * ways a target may be named (`setAppellation`), and the only way an Agent's is shown (`appellationEntriesOf`).
 */
const inAGroupWith = (target: string, agent: string): string =>
  `exists (select 1 from memberships tm
             join memberships am on am.conversation_id = tm.conversation_id
             join conversations c on c.id = tm.conversation_id
            where tm.principal_id = ${target} and tm.left_seq is null and am.principal_id = ${agent} and am.left_seq is null
              and c.type = 'group' and c.closed_at is null)`;

/**
 * An appellation as the owner's view lists it: its target as they are now. A deleted Agent's name and handle are null;
 * so are those of someone else's Agent (its owner's to change) while it is in no group with this Agent. A person, and
 * the owner's own other Agents, are always shown. A row stays when blanked, and can be removed.
 */
export interface AppellationEntry {
  principalId: string;
  kind: "human" | "agent";
  handle: string | null;
  name: string | null;
  appellation: string;
}

/**
 * The appellations of each of `agentIds`, by target handle (every row: a target that no longer qualifies stays listed;
 * an Agent's shown as `AppellationEntry` says); an Agent without any has an empty list. Memberships are read only when
 * someone else's Agent (not deleted) is among the targets — most views name none, and an Agent's view never waits on
 * the group tables for nothing.
 */
export async function appellationEntriesOf(q: Queryable, agentIds: readonly string[]): Promise<Map<string, AppellationEntry[]>> {
  const found = new Map<string, AppellationEntry[]>(agentIds.map((id) => [id, []]));
  if (agentIds.length === 0) return found;
  const { rows } = await q.query<AppellationEntry & { agent_id: string; gone: boolean; theirs: boolean }>(
    `select aa.agent_id, p.id as "principalId", p.kind, ${handleOf("p")} as handle, p.display_name as name, aa.appellation,
            ta.deleted_at is not null as gone, p.kind = 'agent' and p.owner_id <> a.owner_id as theirs
       from agent_appellations aa
       join principals p on p.id = aa.principal_id
       join principals a on a.id = aa.agent_id
       left join agents ta on ta.principal_id = p.id
      where aa.agent_id = any($1::uuid[])
      order by handle, p.id`,
    [agentIds],
  );
  // Someone else's Agent is shown only while it is in a group with this one.
  const toCheck = rows.filter((r) => r.theirs && !r.gone);
  const together = new Set<string>();
  if (toCheck.length > 0) {
    const met = await q.query<{ agent_id: string; principal_id: string }>(
      `select aa.agent_id, aa.principal_id from agent_appellations aa
        where aa.agent_id = any($1::uuid[]) and aa.principal_id = any($2::uuid[]) and ${inAGroupWith("aa.principal_id", "aa.agent_id")}`,
      [agentIds, toCheck.map((r) => r.principalId)],
    );
    for (const r of met.rows) together.add(`${r.agent_id} ${r.principal_id}`);
  }
  for (const { agent_id, gone, theirs, ...entry } of rows) {
    const hidden = gone || (theirs && !together.has(`${agent_id} ${entry.principalId}`));
    found.get(agent_id)?.push(hidden ? { ...entry, handle: null, name: null } : entry);
  }
  return found;
}

/**
 * Sets (or replaces) what the locked, undeleted `agent` calls `targetId`. The target is a person or an Agent that is
 * neither the Agent nor its owner and is the owner's friend or a current member of a group (not closed) the Agent is
 * in; anything else, a principal that does not exist included, is 404 `not_found`. 409 `too_many` for a target that
 * would be the 101st; replacing one of the 100 is fine. False when it was called so already: nothing changed.
 */
export async function setAppellation(t: Tx, agent: AgentRow, targetId: string, appellation: string): Promise<boolean> {
  const qualifies = await t.query(
    `select 1 from principals p
      where p.id = $1 and p.id <> $2 and p.id <> $3
        and (exists (select 1 from friendships f where f.a_id = least($3::uuid, p.id) and f.b_id = greatest($3::uuid, p.id))
             or ${inAGroupWith("p.id", "$2")})`,
    [targetId, agent.id, agent.ownerId],
  );
  if (!qualifies.rowCount) throw notFound();
  const { rows } = await t.query<{ n: number; has: boolean }>(
    "select count(*)::int as n, coalesce(bool_or(principal_id = $2), false) as has from agent_appellations where agent_id = $1",
    [agent.id, targetId],
  );
  if (!rows[0]!.has && rows[0]!.n >= MAX_APPELLATIONS) throw new AppError(409, "too_many");
  const { rowCount } = await t.query(
    `insert into agent_appellations (agent_id, principal_id, appellation) values ($1, $2, $3)
     on conflict (agent_id, principal_id) do update set appellation = excluded.appellation
       where agent_appellations.appellation <> excluded.appellation`,
    [agent.id, targetId, appellation],
  );
  return (rowCount ?? 0) > 0;
}

/** Removes what `agentId` calls `targetId`; false when there was no such row. */
export async function removeAppellation(t: Tx, agentId: string, targetId: string): Promise<boolean> {
  const { rowCount } = await t.query("delete from agent_appellations where agent_id = $1 and principal_id = $2", [agentId, targetId]);
  return (rowCount ?? 0) > 0;
}
