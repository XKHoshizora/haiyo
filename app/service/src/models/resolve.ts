import type { AgentRow } from "../agents/store.ts";
import { REASONING_LEVELS, type Config, type ReasoningAllowance, type ReasoningLevel, type SiteModel } from "../config.ts";
import type { Queryable } from "../db.ts";
import { listProviders, loadProviderForCall } from "../providers/store.ts";
import type { ModelCall } from "./gateway.ts";

/** An Agent's model, ready to call: where and how, what it can take, and (site models) what it costs. */
export interface Resolved {
  source: "site" | "provider";
  /** What usage records (and `GET /api/usage`) call the model: a site model's id, a provider model's name. */
  name: string;
  /**
   * Everything of a `ModelCall` that comes from the model, the key in plaintext included: hand it to the gateway only.
   * Its `maxOutputTokens` is `outputLimit` at `reasoning`: what the call is sent, and what admission holds for.
   */
  call: Omit<ModelCall, "system" | "messages" | "signal" | "reasoning">;
  contextTokens: number;
  vision: boolean;
  pdf: boolean;
  /** The levels the model lists, `none` always among them (a provider model's `reasoningLevels`; every level when it lists none). */
  reasoningAllowed: readonly ReasoningLevel[];
  /** The Agent's effective level (`callLevel`): what the call is sent at and its output limit is sized for. */
  reasoning: ReasoningLevel;
  /** The reply's own output limit, without any level's thinking allowance (`outputLimit`'s `replyLimit`): what a reply for others re-sizes from (metering/others.ts `boundedForOthers`). */
  replyLimit?: number;
  /** Site models only. */
  price?: { inputMicroPerToken: number; outputMicroPerToken: number };
  tier?: "free" | "paid";
  /** Provider models only (always set for them): the `providers` row the model is on — what its learned ratio is kept under (metering/tokens.ts `ratioKey`). */
  providerId?: string;
  /**
   * Whether its replies may be offered tools (agents/port-impl.ts `begin`): a site model's `tools` (configuration, the
   * operator's); a provider model's unless its entry says `tools: false` (absent: not known yet — offered until a reply
   * finds it unable, `markToolsOff`).
   */
  tools: boolean;
  /** Provider models only: its entry says nothing of tools yet — what a reply whose tool call ran may store (`markToolsOn`). */
  toolsUnknown?: boolean;
}

/**
 * The site model `id` as it can be called: configured, with the variable its `apiKeyEnv` names set (read now), and that
 * key; null when it cannot be. The one statement of a site model's being there (`resolveModel`, `modelsUsable`).
 */
function siteCallable(config: Pick<Config, "siteModels">, id: string): { site: SiteModel; apiKey: string } | null {
  const site = config.siteModels.find((m) => m.id === id);
  const apiKey = site ? process.env[site.apiKeyEnv] : undefined;
  return site && apiKey !== undefined && apiKey !== "" ? { site, apiKey } : null;
}

/** The model `name` on a provider's list, or undefined: the one statement of a provider model's being there (as above). */
const listedOn = <M extends { name: string }>(models: readonly M[], name: string): M | undefined => models.find((m) => m.name === name);

/**
 * Whether each of `models` (models of `ownerId`'s Agents) is there to call, by what `resolveModel` needs besides opening
 * the key (`siteCallable`, `listedOn`): a site model still configured with its key variable set, a model still on the
 * list of a provider of the owner's. False with no model chosen: nothing can be called, as `resolveModel` finds too. The
 * owner's view of an Agent (`modelUsable`), whether its failed replies may be tried again (runs.ts `retryable`) and
 * whether it is offered for a reply nobody asked for (proactive/candidates.ts); a reply on a model that is not fails
 * `model_gone`. A provider's saved key that cannot be opened is not looked at (no key is opened here): such an Agent says
 * usable, and its replies fail `provider_rejected` until the key is saved again. One read of the owner's providers when
 * any model is a provider's.
 */
export async function modelsUsable(q: Queryable, config: Pick<Config, "siteModels">, ownerId: string, models: ReadonlyArray<AgentRow["model"]>): Promise<boolean[]> {
  const providers = models.some((m) => m?.source === "provider") ? await listProviders(q, ownerId) : [];
  return models.map((m) => {
    if (m === null) return false;
    if (m.source === "site") return siteCallable(config, m.id) !== null;
    return providers.some((p) => p.id === m.providerId && listedOn(p.models, m.model) !== undefined);
  });
}

/** `modelsUsable` of one Agent's model. */
export async function modelUsable(q: Queryable, config: Pick<Config, "siteModels">, agent: Pick<AgentRow, "model" | "ownerId">): Promise<boolean> {
  return (await modelsUsable(q, config, agent.ownerId, [agent.model]))[0]!;
}

/**
 * An Agent's effective level, the one a call is made at: `wanted` (its saved level) when the model lists it, else the
 * nearest listed level below it in `REASONING_LEVELS` order, `none` when none is — `none` is always there. The one rule,
 * for site and provider models alike; the web shows the same (app/web/src/pages/ModelPicker.jsx `effectiveLevel`). The saved
 * level is never rewritten by it.
 */
export function callLevel(allowed: readonly ReasoningLevel[], wanted: ReasoningLevel): ReasoningLevel {
  for (let i = REASONING_LEVELS.indexOf(wanted); i > 0; i -= 1) if (allowed.includes(REASONING_LEVELS[i]!)) return REASONING_LEVELS[i]!;
  return "none";
}

/**
 * The output limit a call at `level` is sent and held for: the reply's own limit (`replyLimit`: a site model's
 * `maxOutputTokens`, `PROVIDER_DEFAULT_MAX_OUTPUT_TOKENS` for a provider model), and at any level but `none` the
 * level's thinking allowance on top (`REASONING_ALLOWANCE_TOKENS`) — upstreams count thinking inside the output limit.
 * The allowance is at most half of what the context leaves beside the reply's limit, so the sum stays below the
 * context (`contextTokens − 1` at most) and the conversation, which gets the context less this limit, keeps at least
 * half of the room it has at `none`. A context no larger than the reply's limit gets no allowance.
 */
export function outputLimit(replyLimit: number, contextTokens: number, level: ReasoningLevel, allowance: ReasoningAllowance): number {
  if (level === "none") return replyLimit;
  const room = Math.max(0, Math.floor((contextTokens - replyLimit) / 2));
  return replyLimit + Math.min(allowance[level], room);
}

/**
 * The Agent's model (or, for a persona draft, the model its owner chose) as something to call, or null when there is
 * none to call: no model chosen, a site model that is
 * no longer configured or whose key variable is unset, a provider that is not (or no longer) the owner's, or a model
 * no longer on its list. A site model's upstream key is read from `process.env[apiKeyEnv]` now (configuration never
 * holds it); a provider's key is opened from the database (`loadProviderForCall`, which throws `KeyUnreadableError`
 * when `PROVIDER_KEY_SECRET` changed). Site and provider models share everything after this.
 *
 * The call is sized for the Agent's `reasoning` level (absent, as for a persona draft: `none`): its output limit is
 * `outputLimit` at `callLevel`. It sends the thinking switch (Chat Completions only, src/models/gateway.ts) for a site
 * model whose configuration sets `thinkingSwitch`, and for a provider model its owner marked as one that reasons; and it
 * names its upstream (`site:<id>`; `provider:<id>@<baseUrl>`, so a provider's new address is a new upstream), under
 * which the gateway remembers what that upstream refused.
 */
export async function resolveModel(
  q: Queryable,
  config: Pick<Config, "siteModels" | "providerKeySecret" | "providerDefaultMaxOutputTokens" | "reasoningAllowanceTokens">,
  agent: Pick<AgentRow, "model" | "ownerId"> & { reasoning?: ReasoningLevel },
): Promise<Resolved | null> {
  const choice = agent.model;
  if (choice === null) return null;
  const wanted = agent.reasoning ?? "none";

  if (choice.source === "site") {
    const callable = siteCallable(config, choice.id);
    if (!callable) return null;
    const { site, apiKey } = callable;
    const reasoningAllowed = REASONING_LEVELS.filter((level) => level === "none" || site.reasoning.includes(level));
    const reasoning = callLevel(reasoningAllowed, wanted);
    return {
      source: "site",
      name: site.id,
      call: {
        protocol: site.protocol,
        baseUrl: site.baseUrl,
        apiKey,
        model: site.model,
        maxOutputTokens: outputLimit(site.maxOutputTokens, site.contextTokens, reasoning, config.reasoningAllowanceTokens),
        thinkingSwitch: site.thinkingSwitch === true,
        upstreamId: `site:${site.id}`,
      },
      contextTokens: site.contextTokens,
      vision: site.vision,
      pdf: site.pdf,
      reasoningAllowed,
      reasoning,
      replyLimit: site.maxOutputTokens,
      price: { inputMicroPerToken: site.inputMicroPerToken, outputMicroPerToken: site.outputMicroPerToken },
      tier: site.tier,
      tools: site.tools,
    };
  }

  const provider = await loadProviderForCall(q, agent.ownerId, choice.providerId, config.providerKeySecret);
  const listed = provider ? listedOn(provider.models, choice.model) : undefined;
  if (!provider || !listed) return null;
  // The levels it lists (every level when it lists none), `none` always among them; a model that does not reason has `none` alone.
  const lists: readonly ReasoningLevel[] | undefined = listed.reasoningLevels;
  const reasoningAllowed: readonly ReasoningLevel[] = !listed.reasoning ? ["none"] : REASONING_LEVELS.filter((level) => level === "none" || !lists || lists.includes(level));
  const reasoning = callLevel(reasoningAllowed, wanted);
  return {
    source: "provider",
    name: listed.name,
    call: {
      protocol: provider.protocol,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: listed.name,
      maxOutputTokens: outputLimit(config.providerDefaultMaxOutputTokens, listed.contextTokens, reasoning, config.reasoningAllowanceTokens),
      thinkingSwitch: listed.reasoning,
      // Its address too: what an upstream refused is forgotten when the provider is pointed elsewhere.
      upstreamId: `provider:${choice.providerId}@${provider.baseUrl}`,
    },
    contextTokens: listed.contextTokens,
    vision: listed.vision,
    pdf: listed.pdf,
    reasoningAllowed,
    reasoning,
    replyLimit: config.providerDefaultMaxOutputTokens,
    providerId: choice.providerId,
    tools: listed.tools !== false,
    toolsUnknown: listed.tools === undefined,
  };
}
