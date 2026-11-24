import React, { useCallback, useEffect, useId, useState } from "react";
import { useStore } from "../data/store.jsx";
import { MODEL_GONE } from "../data/errorTexts.js";
import { Btn, Notice, Reason } from "../ui/primitives.jsx";
import { ModelBrand } from "../ui/ModelBrand.jsx";
import { abilityMarks, reportedOf } from "../ui/ModelMarks.jsx";
import { brandOf } from "../ui/modelBrands.js";
import { ModelSelect } from "./ModelSelect.jsx";
import { refusalText, settled, useAction } from "./useAction.js";

/** The reasoning levels in the service's order, and how the form says them. */
export const LEVELS = [
  ["none", "不思考"],
  ["low", "低"],
  ["medium", "中"],
  ["high", "高"],
  ["xhigh", "很高"],
  ["max", "最高"],
];
const ALL_LEVELS = LEVELS.map(([id]) => id);
export const levelLabel = (level) => LEVELS.find(([id]) => id === level)?.[1] ?? level;

/**
 * An Agent's effective level on a model that lists `levels`: `wanted` (its saved level) when listed, else the nearest listed
 * level below it, 不思考 when none is. The service's rule (app/service/src/models/resolve.ts `callLevel`: what a reply runs at),
 * said once here for everything that shows or carries a level: the Agent's page, its form, and a model switched in a chat.
 */
export function effectiveLevel(levels, wanted) {
  for (let i = ALL_LEVELS.indexOf(wanted); i > 0; i -= 1) if (levels.includes(ALL_LEVELS[i])) return ALL_LEVELS[i];
  return "none";
}

export const PRIVACY_TEXT = "你与它的对话内容，包括发给它的图片和文件，会发送给所选模型的服务商。";

/** A model choice as a `<select>` value: the same choice always gives the same key ("" for none). */
export const modelKey = (model) =>
  !model ? "" : JSON.stringify(model.source === "site" ? ["site", model.id] : ["provider", model.providerId, model.model]);

/** What a model is called on screen: a site model's label, a provider model's name (after its provider's, when known). */
export function modelLabel(state, model) {
  if (!model) return null;
  if (model.source === "site") return state.siteModels.find((m) => m.id === model.id)?.label ?? model.id;
  const provider = state.providers[model.providerId];
  return provider ? `${provider.name} · ${model.model}` : model.model;
}

/** The brand of a chosen model, for its mark: a site model by its id, then its label; a provider model by its name; else null. */
export function modelLab(state, model) {
  if (!model) return null;
  if (model.source === "site") {
    const site = state.siteModels.find((m) => m.id === model.id);
    return brandOf(model.id) ?? brandOf(site?.label);
  }
  return brandOf(model.model);
}

/** What a model is called where it is switched (the header, the details panel): a site model's label, a provider model's name. */
export function modelName(state, model) {
  if (model?.source === "site") return state.siteModels.find((m) => m.id === model.id)?.label ?? model.id;
  if (model?.source === "provider") return model.model;
  return null;
}

/**
 * The level an Agent runs at, for its page: `effectiveLevel` on what its model lists as far as this client holds (the site's
 * models; my providers once read) — its saved level while that is not known (a model that is gone, providers not read yet).
 */
export function agentLevel(state, agent) {
  const { site, providers } = modelChoices(state);
  const key = modelKey(agent.model);
  const listed = key === "" ? null : [...site, ...providers.flatMap((p) => p.models)].find((c) => c.key === key);
  return listed ? effectiveLevel(listed.levels, agent.reasoning) : agent.reasoning;
}

const lower = (text) => String(text ?? "").toLowerCase();

/**
 * What can be chosen now: the site's models and each of my providers with its models. Each choice is
 * `{key, model, label, paid, levels, usable}`: `levels` the reasoning levels it allows (`none` first); a provider model whose
 * context is not larger than the output limit its calls get cannot be used (the service refuses it). For the picker's
 * row each also has `name`, `brand`, `marks` (免费 / 需余额 for a site model by its tier, then what the service reports (src/ui/ModelMarks.jsx):
 * 看图 `vision`, 思考 when it can think, 工具 by the table's one rule — a site model's own `tools`; a provider model's stored `tools`, else what the catalogue reports), `terms` (what a search finds it by: its name, its id or its provider's name) and,
 * when it cannot be used, `reason`.
 */
export function modelChoices(state) {
  const limit = state.providerDefaults?.maxOutputTokens ?? 0;
  const site = state.siteModels.map((m) => {
    const model = { source: "site", id: m.id };
    const paid = m.tier === "paid";
    const name = m.label ?? m.id;
    const marks = [paid ? "paid" : "free", ...abilityMarks({ ...reportedOf(m), reportedTools: undefined, vision: m.vision, pdf: m.pdf, reasoning: m.reasoning.length > 0, tools: m.tools })];
    return {
      key: modelKey(model),
      model,
      label: `${m.label} · ${paid ? "需余额" : "免费"}`,
      name,
      brand: brandOf(m.id) ?? brandOf(m.label),
      marks,
      terms: [lower(name), lower(m.id)],
      paid,
      levels: ALL_LEVELS.filter((l) => l === "none" || m.reasoning.includes(l)),
      usable: true,
    };
  });
  const providers = Object.values(state.providers).map((p) => ({
    id: p.id,
    name: p.name,
    models: p.models.map((m) => {
      const model = { source: "provider", providerId: p.id, model: m.name };
      const tooSmall = Number.isFinite(m.contextTokens) && m.contextTokens <= limit;
      // A model that lists the levels it supports offers those (as a site model does), else every level when it reasons.
      const levels = !m.reasoning ? ["none"] : m.reasoningLevels ? ALL_LEVELS.filter((l) => l === "none" || m.reasoningLevels.includes(l)) : ALL_LEVELS;
      const marks = abilityMarks({ ...reportedOf(m), vision: m.vision, pdf: m.pdf, reasoning: m.reasoning, tools: m.tools });
      return {
        key: modelKey(model),
        model,
        label: tooSmall ? `${m.name}（上下文太小）` : m.name,
        name: m.name,
        brand: brandOf(m.name),
        marks,
        terms: [lower(m.name), lower(p.name)],
        ...(tooSmall ? { reason: "上下文太小" } : {}),
        paid: false,
        levels,
        usable: !tooSmall,
      };
    }),
  }));
  const any = site.length > 0 || providers.some((p) => p.models.some((m) => m.usable));
  return { site, providers, any };
}

/** A choice as a row of the picker (`ModelSelect`). A current model that is no longer offered reads as its `label` says. */
const rowOfChoice = (choice) => ({
  key: choice.key,
  name: choice.stale ? choice.label : choice.name,
  brand: choice.brand,
  marks: choice.stale ? [] : choice.marks,
  terms: choice.terms ?? [lower(choice.label)],
  disabled: !choice.usable,
  reason: choice.reason ?? null,
});

/**
 * The picker's groups in the order and with the words the Agent form always had: 站点提供 (or what it says when the
 * site's models cannot be read or are none), then one group per provider, 我的供应商 · <name> (or one 我的供应商 saying
 * there is none, or that they cannot be read). `sources`: `useModelSources()` (its `choices.site` may be narrowed).
 */
export function pickerGroups(sources) {
  const { site, providers } = sources.choices;
  const siteGroup = { id: "site", label: "站点提供", empty: sources.modelsKnown ? "尚未开放" : "暂时读取不到", options: sources.modelsKnown ? site.map(rowOfChoice) : [] };
  if (!sources.providersKnown || providers.length === 0) {
    return [siteGroup, { id: "providers", label: "我的供应商", empty: sources.providersKnown ? "还没有添加供应商" : "暂时读取不到", options: [] }];
  }
  return [siteGroup, ...providers.map((p) => ({ id: `provider:${p.id}`, label: `我的供应商 · ${p.name}`, empty: "没有可选的模型", options: p.models.map(rowOfChoice) }))];
}

/** The rows the picker leads with: the current model when it is no longer offered (`choiceList`'s `stale` one). */
export const staleRows = (options) => options.filter((o) => o.stale).map(rowOfChoice);

/**
 * The choices of a form as one list: what can be chosen, and before it the Agent's current model when it cannot be
 * chosen any more (no longer offered, or too small), so that keeping it is still possible (`stale: true`).
 */
export function choiceList(sources, current = null, currentReasoning = "none") {
  const offered = [...sources.choices.site, ...sources.choices.providers.flatMap((p) => p.models)];
  const key = modelKey(current);
  if (!current || offered.some((c) => c.key === key && c.usable)) return offered.filter((c) => c.usable);
  const levels = ALL_LEVELS.filter((l) => l === "none" || l === currentReasoning);
  const label = `${sources.labelOf(current)}（当前，已不可用）`;
  return [{ key, model: current, label, brand: sources.brandOf(current), terms: [lower(label)], paid: false, levels, usable: true, stale: true }, ...offered.filter((c) => c.usable)];
}

/**
 * Loads what the picker offers (the site's models, my providers, my usage for the balance) when a form opens — or, with
 * `load: false`, once `load` turns true (a picker that reads them only when it is first opened) — and says how far that
 * got: `status` "loading" | "ready"; `nothing` once it is known that no model at all can be chosen.
 */
export function useModelSources({ load = true } = {}) {
  const { state, actions } = useStore();
  const [providers, setProviders] = useState("loading");
  const [models, setModels] = useState("loading");
  const loadProviders = useCallback(async () => {
    setProviders("loading");
    const res = await actions.loadProviders();
    setProviders(res.ok ? "ok" : "failed");
  }, [actions]);
  const loadModels = useCallback(async () => {
    setModels("loading");
    const res = await actions.loadModels();
    setModels(res.ok ? "ok" : "failed");
  }, [actions]);
  useEffect(() => {
    if (!load) return;
    loadProviders();
    loadModels();
    actions.loadUsage();
  }, [load, actions, loadProviders, loadModels]);

  // The site's models are known once any load of them succeeded (the connection loads them too).
  const modelsKnown = state.providerDefaults !== null || models === "ok";
  const choices = modelChoices(state);
  const loading = providers === "loading" || (!modelsKnown && models === "loading");
  return {
    status: loading ? "loading" : "ready",
    providersKnown: providers === "ok",
    modelsKnown,
    nothing: !loading && providers === "ok" && modelsKnown && !choices.any,
    failed: loading ? null : providers === "failed" ? "providers" : !modelsKnown ? "models" : null,
    retry: () => {
      if (providers === "failed") loadProviders();
      if (!modelsKnown) loadModels();
    },
    choices,
    usage: state.usage,
    labelOf: (model) => modelLabel(state, model),
    brandOf: (model) => modelLab(state, model),
  };
}

/** Whether a balance (the service's decimal string) is above zero, read without arithmetic. */
const positive = (balance) => typeof balance === "string" && !balance.trim().startsWith("-") && /[1-9]/.test(balance);

function paidText(usage) {
  if (!usage || typeof usage.balance !== "string") return "需要余额：这个模型按用量从余额扣点，余额用完后它不会回复；最后一次回复可能把余额扣成负数。";
  if (positive(usage.balance)) return `这个模型按用量从余额扣点，你现在的余额是 ${usage.balanceText} 点。`;
  return `需要余额：这个模型按用量从余额扣点，你现在的余额是 ${usage.balanceText} 点，余额用完后它不会回复；最后一次回复可能把余额扣成负数。`;
}

/** Settings › 模型供应商, where models come from (the existing way there). */
export const PROVIDERS_PAGE = { section: "settings", settingsPage: "providers", pane: "main" };

/**
 * The model field of the Agent form: the picker (`ModelSelect`) with its two groups, 站点提供 (each model 免费 or 需余额)
 * and 我的供应商 (provider → its models); a notice leading to Settings › 模型供应商 when nothing at all can be chosen; the
 * privacy notice beside it. `options`: `choiceList(sources, …)`; `value`: the chosen key; `onChange(key)`. (No
 * 管理供应商 under its list: leaving for it would drop what the form holds.) `focus`: the picker takes the focus once it
 * is shown (`openModelChoice` sent me here), then `onFocused()` — called too when what can be chosen is read and no picker
 * is shown (nothing to choose), so the asked focus never waits for a later form.
 */
export function ModelPicker({ sources, options, value, onChange, focus = false, onFocused }) {
  const { dispatch } = useStore();
  const id = useId();
  const chosen = options.find((o) => o.key === value) ?? null;
  const showSelect = sources.status === "ready" && !sources.nothing;
  useEffect(() => {
    if (!focus || sources.status !== "ready") return;
    // Once what can be chosen is read: the picker takes the focus — or, with none shown, the asked focus is dropped.
    if (showSelect) document.getElementById(id)?.focus();
    onFocused?.();
  }, [focus, showSelect, sources.status]);
  const addProvider = () => dispatch({ type: "nav", patch: PROVIDERS_PAGE });

  let control;
  if (sources.status === "loading") control = <p className="muted">正在读取可用的模型…</p>;
  else if (sources.nothing) {
    control = (
      <Notice tone="info" action={<Btn small onClick={addProvider}>添加模型供应商</Btn>}>
        还没有可用的模型：本站的模型尚未开放，你也还没有可用的模型供应商。添加一个供应商并填好它的模型后，就可以给 Agent 选择模型了。
      </Notice>
    );
  } else {
    const shown = chosen && rowOfChoice(chosen);
    control = (
      <ModelSelect
        id={id}
        labelledBy={`${id}-label`}
        describedBy={chosen?.paid ? `${id}-paid` : undefined}
        value={chosen ? value : null}
        current={shown && { name: shown.name, brand: shown.brand }}
        placeholder="请选择模型"
        lead={staleRows(options)}
        groups={pickerGroups(sources)}
        onChange={onChange}
      />
    );
  }

  return (
    <div>
      <div className="field">
        {showSelect ? <label id={`${id}-label`} htmlFor={id}>模型</label> : <span className="field-label">模型</span>}
        {control}
        {sources.failed && (
          <Reason>
            {sources.failed === "providers" ? "没能读取你的模型供应商，请重试。" : "没能读取本站的模型，请重试。"}{" "}
            <Btn small onClick={sources.retry}>重试</Btn>
          </Reason>
        )}
        {chosen?.paid && <p id={`${id}-paid`} className="field-hint">{paidText(sources.usage)}</p>}
      </div>
      <Notice tone="info">{PRIVACY_TEXT}</Notice>
    </div>
  );
}

/**
 * The quick model switches on screen (`AgentModelSwitch`), by Agent: each one's opener, and whether it says a reply's
 * model (`shown`) rather than the Agent's.
 */
const quickSwitches = new Map();

/**
 * Opens where my Agent `agentId`'s model is chosen: a quick model switch for it on this screen (`AgentModelSwitch`: the
 * conversation's header or details panel first, else a reply's line), else its edit form, focused on its model field. The
 * one way the 模型不可用 tag (Agents.jsx `ModelGoneTag`) and a `model_gone` status line (AgentChatBits.jsx) send its owner to
 * choose another model.
 */
export function openModelChoice(dispatch, agentId) {
  const here = [...(quickSwitches.get(agentId) ?? [])];
  const quick = here.find((s) => !s.shown) ?? here[0];
  if (quick) return quick.open();
  dispatch({ type: "nav", patch: { section: "agents", agentId, agentView: "edit", agentFocus: "model", pane: "main" } });
}

/** Under the picker's search where it is opened from a group: the model is the Agent's, wherever it talks. */
export const EVERYWHERE_NOTE = "换了以后，它在所有会话里都用这个模型";

/**
 * The model of one of my Agents, switched where I am (its own conversation's header and details panel; in a group, its row
 * of the details panel and the line under its reply): the compact picker, which reads what can be chosen only once it is
 * first opened (and again when that failed), and saves a choice with the Agent's one update — the model with its
 * thinking level, kept when the new model takes it, else 不思考, as the Agent form sends them. While that is saved the
 * button shows the choice (unless it says something else: `shown`) and does nothing; a refusal is toasted in the update's
 * own words and the button shows the stored model again. Nothing for an Agent not mine or not loaded; a deleted one's
 * model is a plain label.
 * `shown`: {name, brand} the button always says (a reply's line: the model that reply used), not the Agent's model;
 * `note`: the quiet line at the top of its list (`EVERYWHERE_NOTE` in a group).
 */
export function AgentModelSwitch({ agentId, shown = null, note = null }) {
  const { state, dispatch, actions } = useStore();
  const agent = state.agents[agentId];
  const [opened, setOpened] = useState(false);
  const sources = useModelSources({ load: opened });
  const { busy, run } = useAction();
  const [saving, setSaving] = useState(null);
  const switchId = useId();
  // While it is shown it is where `openModelChoice` opens this Agent's model choice.
  const live = Boolean(agent?.mine && agent.loaded && !agent.deleted);
  useEffect(() => {
    if (!live) return;
    const open = () => {
      const button = document.getElementById(switchId);
      if (button?.getAttribute("aria-expanded") !== "true") button?.click();
    };
    const entry = { shown: shown !== null, open };
    const set = quickSwitches.get(agentId) ?? new Set();
    quickSwitches.set(agentId, set.add(entry));
    return () => {
      set.delete(entry);
      if (set.size === 0) quickSwitches.delete(agentId);
    };
  }, [live, agentId, switchId, shown !== null]);
  if (!agent?.mine || !agent.loaded) return null;

  const model = saving ?? agent.model;
  const name = shown ? shown.name : modelName(state, model);
  // Its model is not there to call any more (the service's `modelUsable`): the button says so, not the model's name.
  const gone = !shown && saving === null && model !== null && agent.modelUsable === false;
  const current = shown ?? (model ? { name: gone ? MODEL_GONE.tag : name, brand: modelLab(state, model) } : null);
  if (agent.deleted) {
    return (
      <span className="head-model">
        {current && <ModelBrand brand={current.brand} size={14} />}
        {name ?? "未选模型"}
      </span>
    );
  }

  const options = choiceList(sources, agent.model, agent.reasoning);
  const choose = async (key) => {
    const next = options.find((o) => o.key === key && !o.stale);
    if (!next) return;
    const reasoning = effectiveLevel(next.levels, agent.reasoning);
    setSaving(next.model);
    await run("model", () => settled(actions.patchAgent(agentId, { model: next.model, reasoning })), refusalText);
    setSaving(null);
  };
  const open = () => {
    setOpened(true);
    if (sources.failed) sources.retry();
  };
  return (
    <ModelSelect
      compact
      id={switchId}
      label={`模型：${name ?? "未选模型"}${gone ? `（${MODEL_GONE.tag}）` : ""}，点击更改`}
      value={modelKey(agent.model)}
      current={current}
      placeholder="未选模型"
      lead={staleRows(options)}
      groups={pickerGroups(sources)}
      status={opened && sources.status === "loading" ? "正在读取可用的模型…" : null}
      note={note}
      busy={busy !== null}
      footer={<Btn small variant="text" onClick={() => dispatch({ type: "nav", patch: PROVIDERS_PAGE })}>管理供应商</Btn>}
      onOpen={open}
      onChange={choose}
    />
  );
}
