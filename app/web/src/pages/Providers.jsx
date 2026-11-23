import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { useStore } from "../data/store.jsx";
import { modelLevels } from "../data/model.js";
import { Btn, Field, Modal, Notice, Reason, Tag, focusInvalid } from "../ui/primitives.jsx";
import { isEnter } from "../ui/keys.js";
import { ChevronDown, ChevronLeft, Lock, Plus, Search } from "../icons.js";
import { refusalText, settled, useAction } from "./useAction.js";
import { forgetDraft, peekDraft, saveDraft } from "../data/drafts.js";
import { useUp } from "../state/appHistory.js";
import { levelLabel } from "./ModelPicker.jsx";
import { LabLogo, labOfModel } from "../ui/LabLogo.jsx";
import { noModelList } from "../data/errorTexts.js";

/** The four interface types (the service's `protocol`), by the names people know them by. Fixed once created. */
export const PROTOCOLS = [
  ["openai_chat", "OpenAI Chat Completions"],
  ["openai_responses", "OpenAI Responses"],
  ["anthropic", "Anthropic Messages"],
  ["gemini", "Gemini API"],
];
export const protocolLabel = (protocol) => PROTOCOLS.find(([id]) => id === protocol)?.[1] ?? protocol;
/** The vendors' own addresses for each type (app/service/README.md, "Calling a model"): the address field's example. */
const EXAMPLE_ADDRESS = {
  openai_chat: "https://api.openai.com/v1",
  openai_responses: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
};

/** A path segment that names an API version (`v1`, `v4`, `v1beta`, `v1beta1`…): the whole segment. */
const VERSION_SEGMENT = /^v\d+(?:[a-z]+\d*)?$/;
/** The version the service appends to an address that names none, per type. */
const DEFAULT_VERSION = { openai_chat: "v1", openai_responses: "v1", anthropic: "v1", gemini: "v1beta" };
/** A plain DNS name as the URL parser leaves it (lower case, punycode): the service's rule for a host. */
const DNS_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
/** What each type adds to the stored address for a reply (README "Calling a model", "Where it goes"). */
const REQUEST_PATH = {
  openai_chat: "/chat/completions",
  openai_responses: "/responses",
  anthropic: "/messages",
  gemini: "/models/<模型>:streamGenerateContent",
};

/**
 * The address the service will store for what was typed (app/service/src/providers/base-url.ts `providerBaseUrl`, the
 * same rule; both test files share one table of cases), or null when the service would refuse it: trimmed; https, no
 * user name or password, a plain host; host lower-cased, default port, query, fragment and trailing `/` dropped. Typed
 * with a trailing `#`, the address is used as typed (no version added); else, unless a segment of its path names a
 * version, the type's version is appended (`/v1`; `/v1beta` for Gemini).
 */
export function storedBaseUrl(protocol, typed) {
  const raw = String(typed ?? "").trim();
  const asTyped = raw.endsWith("#");
  const text = (asTyped ? raw.slice(0, -1) : raw).trim();
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  // `https://@host` parses with empty credentials: an `@` anywhere before the host is refused too.
  if ((/^[a-z][a-z0-9+.-]*:[\\/]*([^\\/?#]*)/i.exec(text)?.[1] ?? "").includes("@")) return null;
  if (!url.hostname.startsWith("[") && !DNS_NAME.test(url.hostname)) return null;
  if (url.port !== "" && Number(url.port) < 1) return null;
  const base = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  if (asTyped) return base;
  return url.pathname.split("/").some((s) => VERSION_SEGMENT.test(s)) ? base : `${base}/${DEFAULT_VERSION[protocol] ?? "v1"}`;
}

// The service's limits (app/service/README.md, "Model providers").
const MAX_PROVIDERS = 10;
const MAX_MODELS = 100;
const CONTEXT_MIN = 1000;
const CONTEXT_MAX = 2000000;

/** Spec §6.8: what is said wherever a model source is chosen or added. */
const PRIVACY_TEXT = "选用这个供应商模型的 Agent，你与它的对话内容，包括发给它的图片和文件，会发送给这个供应商。";
/** The service never sends a saved key to another origin than the one it was saved for. */
const KEY_AGAIN = "接口地址换了域名，需要重新填写密钥。";
const KEY_CLEARED = "为了安全，刚才填写的密钥已经清空，请重新填写。";
/** Editing, after a refused save that carried a new key: saving again must not quietly keep the old one. */
const KEY_NOT_SAVED = "上次填写的密钥没有保存，请重新填写；如果不想更换，点“保留原密钥”。";
/** Saving after 保留原密钥 with nothing else changed: nothing is sent, and the owner is told the key stayed. */
const KEY_KEPT = "没有改动，原来的密钥保持不变";
/** Create mode shows no model section: this one line says what comes next. */
const CREATE_MODELS_HINT = "保存后从供应商的模型列表里挑选模型。";
/** In the 同步模型 dialog, after a list request that failed (the sentence of the edit form's hint). */
const FAILED_BY_HAND = "有的供应商不提供模型列表。关闭这个窗口后，可以在下面手动添加模型。";
/** In the 同步模型 dialog: the list came from another address of the same provider, which the chat address may not serve. */
const FROM_SIBLING = "这些模型来自供应商的另一个地址，当前接口不一定都能用。添加后用测试连接确认。";
/** In the 同步模型 dialog: the address has no model list, so these come from the public catalogue (models.dev). */
const FROM_CATALOGUE = "这个接口没有模型列表，以下来自公开的模型目录，请只添加你确实能用的模型。";
/** Under the address field. */
const AS_TYPED_HINT = "地址末尾加 # 表示原样使用，不自动补全版本号。";

const chars = (text) => [...text].length;
const grouped = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
/** What the service refuses in a one-line name: control characters, line breaks included. */
const CONTROL = /\p{Cc}/u;

function nameProblem(text) {
  const name = text.trim();
  if (!name) return "请填写名称";
  if (CONTROL.test(name)) return "名称只能是一行";
  if (chars(name) > 40) return "名称不超过 40 个字";
  return "";
}

function modelNameProblem(name, models) {
  if (!name) return "请填写模型名称";
  if (CONTROL.test(name)) return "模型名称只能是一行";
  if (chars(name) > 100) return "模型名称不超过 100 个字";
  if (models.some((m) => m.name === name)) return "列表里已经有这个模型了";
  if (models.length >= MAX_MODELS) return `最多 ${MAX_MODELS} 个模型`;
  return "";
}

function addressProblem(text) {
  const value = text.trim();
  if (!value) return "请填写接口地址";
  if (chars(value) > 1000) return "接口地址不超过 1000 个字符";
  let url;
  try {
    url = new URL(value);
  } catch {
    return "接口地址的格式不对，例如 https://api.openai.com/v1";
  }
  if (url.protocol !== "https:") return "接口地址需要以 https:// 开头";
  if (url.username || url.password) return "接口地址里不能包含用户名或密码";
  // (Whether the service takes it does not depend on the interface type.)
  if (storedBaseUrl("openai_chat", value) === null) return "接口地址的格式不对，例如 https://api.openai.com/v1";
  return "";
}

/** The service's rule for a key, after trimming: 8–1000 printable ASCII characters, no spaces. */
const keyFormatProblem = (value) => (/^[\x21-\x7e]{8,1000}$/.test(value.trim()) ? "" : "密钥需要是 8 到 1000 个字符，只能有英文字母、数字和符号，不能有空格。");

/** Scheme, host and port, as the service compares them; null when the address does not parse. */
function originOf(address) {
  try {
    return new URL(address.trim()).origin;
  } catch {
    return null;
  }
}

/** A context as typed ("128,000" is fine): the number, or null when it is empty or not one. */
const contextNumber = (text) => {
  const digits = text.replace(/[\s,_]/g, "");
  return /^\d+$/.test(digits) ? Number(digits) : null;
};
const contextProblem = (text) => {
  if (!text.trim()) return "";
  const n = contextNumber(text);
  return n !== null && n >= CONTEXT_MIN && n <= CONTEXT_MAX ? "" : `上下文容量需要是 ${CONTEXT_MIN} 到 ${CONTEXT_MAX} 之间的整数`;
};

/**
 * A model of the provider as the form holds it: the context as text ("" means the service's default), `levels` the
 * thinking levels it is offered with (null: every level), `reported` the levels the catalogue lists for it (what `levels` goes back to: the service
 * reads them beside the stored `levels`, `reportedLevels`, so the way back is there after a save too), and `tools` whether its replies may be offered tools as its entry says it
 * (undefined: it says nothing — not known yet, so they are; the service may set it false when the model turns out unable).
 */
const formModel = (m) => ({
  name: m.name,
  vision: Boolean(m.vision),
  pdf: Boolean(m.pdf),
  reasoning: Boolean(m.reasoning),
  context: Number.isFinite(m.contextTokens) ? String(m.contextTokens) : "",
  levels: m.reasoning ? modelLevels(m.reasoningLevels) : null,
  reported: m.reasoning ? (modelLevels(m.reportedLevels) ?? modelLevels(m.reasoningLevels)) : null,
  ...(typeof m.tools === "boolean" ? { tools: m.tools } : {}),
});
/**
 * As it is sent: the flags always, the context only when one is given, the levels only on a model that reasons, `tools`
 * only when the entry says it or its owner ticked or unticked it (left out, the service keeps what it has).
 */
const wireModel = (m) => {
  const n = contextNumber(m.context);
  return {
    name: m.name,
    vision: m.vision,
    pdf: m.pdf,
    reasoning: m.reasoning,
    ...(n === null ? {} : { contextTokens: n }),
    ...(m.reasoning && m.levels ? { reasoningLevels: m.levels } : {}),
    ...(typeof m.tools === "boolean" ? { tools: m.tools } : {}),
  };
};
const modelsKey = (list) =>
  JSON.stringify(list.map((m) => [m.name, m.vision, m.pdf, m.reasoning, m.contextTokens ?? null, m.reasoningLevels ?? null, m.tools ?? null]));
/** A model from the provider's own list (同步模型) as the form adds it: its hints as flags, a known model's context and levels. */
const syncedModel = (m) => ({
  name: m.name,
  vision: m.vision,
  pdf: m.pdf,
  reasoning: m.reasoning,
  // The catalogue's context, within what the form accepts for it.
  context: Number.isInteger(m.contextTokens) ? String(Math.min(CONTEXT_MAX, Math.max(CONTEXT_MIN, m.contextTokens))) : "",
  levels: m.reasoning ? (m.reasoningLevels ?? null) : null,
  reported: m.reasoning ? (m.reasoningLevels ?? null) : null,
});

/**
 * What the provider itself said about a failed call (its status and its own text), folded under 详情. Only plain text:
 * React writes it as text, never as Markdown or HTML.
 */
function UpstreamDetails({ detail }) {
  if (!detail) return null;
  return (
    <details className="upstream-detail">
      <summary>详情</summary>
      {detail.upstreamStatus && <p className="muted">状态码：{detail.upstreamStatus}</p>}
      {detail.message && (
        <p className="muted" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          供应商的回复：{detail.message}
        </p>
      )}
      {detail.redacted && <p className="muted">供应商的回复里有密钥的一部分，为了安全没有显示。</p>}
    </details>
  );
}

/** Seconds, one decimal: 812 → "0.8". */
const seconds = (ms) => (ms / 1000).toFixed(1);

/**
 * The outcome of 测试连接: success (with a model: which one, and how long it took), a 404/405 of the model list (no model
 * list: said plainly, not as an error) or the sentence for the error, and under it what the provider said.
 */
function TestResult({ result }) {
  if (!result) return null;
  if (result.ok) {
    const text =
      result.mode === "chat" && result.model
        ? `用 ${result.model} 发了一句话${Number.isFinite(result.latencyMs) ? `，用时 ${seconds(result.latencyMs)} 秒` : ""}`
        : "连接成功，供应商正常回应。";
    return <p className="field-hint" role="status">{text}</p>;
  }
  const noList = !result.chat && noModelList(result.error);
  return (
    <>
      {noList ? <p className="field-hint" role="status">{result.text}</p> : <p className="field-msg" role="alert">{result.text}</p>}
      <UpstreamDetails detail={result.error?.detail} />
    </>
  );
}

/**
 * 测试连接 of a saved provider (its saved address and key), through the caller's `run` so it waits for the other actions:
 * with `model` (its first saved model) one tiny real call to it, else its model list is asked for. `clear()` drops the
 * result (and the answer of a test still on its way), once it may no longer be about what is shown.
 */
function useConnectionTest(providerId, model, run) {
  const { actions } = useStore();
  const [result, setResult] = useState(null);
  const generation = useRef(0);
  const clear = () => {
    generation.current += 1;
    setResult(null);
  };
  const test = async () => {
    clear();
    const mine = generation.current;
    const chat = typeof model === "string" && model !== "";
    const res = await run("test", () => settled(actions.testProvider(providerId, chat ? model : undefined)), () => "");
    if (generation.current !== mine) return;
    if (res.ok) setResult({ ok: true, mode: res.value?.mode === "chat" ? "chat" : "list", model: chat ? model : null, latencyMs: res.value?.latencyMs });
    else if (res.error?.code !== "busy_here") setResult({ ok: false, chat, error: res.error?.error ?? null, text: refusalText(res.error) });
  };
  return { result, test, clear };
}

function ProviderRow({ provider, onEdit, onDelete }) {
  const { busy, run } = useAction();
  const { result, test } = useConnectionTest(provider.id, provider.models[0]?.name, run);
  const count = provider.models.length;
  return (
    <li>
      <div className="member-body">
        <strong>{provider.name}</strong>
        <p>
          {protocolLabel(provider.protocol)} · {provider.baseUrl}
        </p>
        <p>
          密钥 …{provider.keyLast4} · {count > 0 ? `${count} 个模型` : "还没有模型"}
        </p>
        <TestResult result={result} />
      </div>
      <div className="member-actions">
        <Btn small disabled={busy !== null} onClick={test}>
          {busy === "test" ? "测试中…" : "测试连接"}
        </Btn>
        <Btn small onClick={onEdit}>编辑</Btn>
        <Btn small variant="danger" onClick={onDelete}>删除</Btn>
      </div>
    </li>
  );
}

function DeleteModal({ provider, onClose }) {
  const { actions, dispatch } = useStore();
  const { busy, run } = useAction();
  /** The last refusal: {code, agents, text}. */
  const [refusal, setRefusal] = useState(null);
  const confirm = async () => {
    setRefusal(null);
    const res = await run("delete", () => settled(actions.deleteProvider(provider.id)), () => "");
    if (res.ok) {
      dispatch({ type: "toast", text: `已删除「${provider.name}」` });
      onClose();
      return;
    }
    if (res.error?.code === "busy_here") return;
    const error = res.error?.error ?? {};
    setRefusal({ code: error.code, agents: Array.isArray(error.agents) ? error.agents : [], text: refusalText(res.error) });
  };
  const inUse = refusal?.code === "provider_in_use" && refusal.agents.length > 0;
  return (
    <Modal
      title={`删除「${provider.name}」`}
      onClose={onClose}
      footer={
        <>
          <Btn data-autofocus onClick={onClose}>取消</Btn>
          <Btn variant="danger" disabled={busy !== null} onClick={confirm}>
            {busy !== null ? "删除中…" : "确认删除"}
          </Btn>
        </>
      }
    >
      <p>删除后，它保存的密钥和模型列表会一起删除，不可恢复。</p>
      {inUse ? (
        <Notice tone="warn">
          还有 Agent 在使用这个供应商，请先给它们换一个模型，再删除：
          <ul className="plain-list" aria-label="正在使用它的 Agent">
            {refusal.agents.map((a) => (
              <li key={a.id}>{a.name}</li>
            ))}
          </ul>
        </Notice>
      ) : (
        refusal && <Notice tone="warn">{refusal.text}</Notice>
      )}
    </Modal>
  );
}

/** Whether the levels in use are the reported ones (the first option is checked only then; otherwise neither is, and a tap on either decides). */
const sameLevels = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((level, i) => level === b[i]);

/** One model of the form: what it can do, its context, and the 高级 disclosure to change them. */
function ModelRow({ model, open, error, defaults, onToggle, onChange, onRemove }) {
  const panelId = useId();
  const context = contextNumber(model.context);
  const shownContext = context ?? defaults?.contextTokens ?? null;
  const limit = defaults?.maxOutputTokens ?? null;
  const tooSmall = shownContext !== null && limit !== null && shownContext <= limit;
  const summary = [model.vision && "能看图片", model.pdf && "能直接读 PDF"].filter(Boolean);
  const after = shownContext !== null ? [`上下文 ${grouped(shownContext)}${context === null ? "（默认）" : ""}`] : [];
  const thinking = model.reasoning ? (model.reported ? `支持思考（${model.levels ? model.levels.map(levelLabel).join("、") : "全部档位"}）` : "支持思考") : null;
  // A model the catalogue lists thinking levels for: the choice between those and every level, both ways open until it is saved.
  const levelChoice =
    model.reasoning && model.reported ? (
      <fieldset className="checks" role="radiogroup" aria-label={`思考档位：${model.name}`} aria-describedby={`${panelId}-levels-hint`}>
        <legend>思考档位</legend>
        <label>
          <input type="radio" name={`levels-${panelId}`} checked={sameLevels(model.levels, model.reported)} onChange={() => onChange({ ...model, levels: model.reported })} onClick={() => !sameLevels(model.levels, model.reported) && onChange({ ...model, levels: model.reported })} />
          <span>这个模型支持的档位（{model.reported.map(levelLabel).join("、")}）</span>
        </label>
        <label>
          <input type="radio" name={`levels-${panelId}`} checked={model.levels === null} onChange={() => onChange({ ...model, levels: null })} />
          <span>全部档位</span>
        </label>
        <small id={`${panelId}-levels-hint`} className="muted">档位不对或不全时，选全部档位。</small>
      </fieldset>
    ) : null;
  const parts = [...summary, thinking, ...after].filter(Boolean);
  const contextHint = [
    `模型一次能读的内容，以 token 计，${grouped(CONTEXT_MIN)} 到 ${grouped(CONTEXT_MAX)}。`,
    defaults ? `留空时用默认的 ${grouped(defaults.contextTokens)}。` : "留空时用默认值。",
    limit !== null ? `需要大于每次回复的输出上限 ${grouped(limit)}，Agent 才能使用这个模型。` : "需要大于每次回复的输出上限，Agent 才能使用这个模型。",
  ].join("");
  // Not reasoning any more: the levels it listed go too.
  const flag = (key) => (event) => onChange({ ...model, [key]: event.target.checked, ...(key === "reasoning" && !event.target.checked ? { levels: null } : {}) });
  return (
    <li>
      <div className="member-body">
        <strong><LabLogo lab={labOfModel(model.name)} size={16} />{model.name}</strong>
        <p>
          {parts.map((part, i) => (
            <React.Fragment key={i}>
              {i > 0 && " · "}
              {part}
            </React.Fragment>
          ))}
          {tooSmall && " · 上下文太小，Agent 不能使用"}
        </p>
        {open && (
          <div id={panelId} className="model-panel">
            <fieldset className="checks">
              <legend className="sr-only">{model.name} 能做什么</legend>
              <label>
                <input type="checkbox" checked={model.vision} onChange={flag("vision")} />
                <span>能看图片 <small>发给它的图片会交给模型，否则只告诉它文件名</small></span>
              </label>
              <label>
                <input type="checkbox" checked={model.pdf} onChange={flag("pdf")} />
                <span>能直接读 PDF <small>PDF 会原样交给模型，否则只告诉它文件名</small></span>
              </label>
              <label>
                <input type="checkbox" checked={model.reasoning} onChange={flag("reasoning")} />
                <span>支持思考 <small>用它的 Agent 可以选择思考程度</small></span>
              </label>
              <label>
                {/* Ticked unless its entry says false (the service sets that when the model turns out unable to use them). */}
                <input type="checkbox" checked={model.tools !== false} onChange={flag("tools")} />
                <span>会用工具（查聊天记录、看文件）</span>
              </label>
            </fieldset>
            {levelChoice}
            <Field label="上下文容量" hint={contextHint} error={error}>
              <input
                value={model.context}
                onChange={(e) => onChange({ ...model, context: e.target.value })}
                inputMode="numeric"
                autoComplete="off"
                placeholder={defaults ? String(defaults.contextTokens) : ""}
              />
            </Field>
          </div>
        )}
      </div>
      <div className="member-actions">
        <Btn small aria-label={open ? `收起：${model.name}` : `高级设置：${model.name}`} aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={onToggle}>
          {open ? "收起" : "高级"}
          <ChevronDown size={14} aria-hidden="true" style={open ? { transform: "rotate(180deg)" } : undefined} />
        </Btn>
        <Btn small aria-label={`移除：${model.name}`} onClick={onRemove}>移除</Btn>
      </div>
    </li>
  );
}

/** At most this many rows of the provider's list are drawn at a time: past them the owner searches. */
const SHOWN_ROWS = 200;
const ADDED_AT_LIMIT = (n) => `已添加 ${n} 个模型。每个供应商最多 ${MAX_MODELS} 个模型，其余的没有添加。`;

/** One model of the provider's own list: its name (and the catalogue's), its hints as tags, and 添加 or 已添加 · 移除. */
function SyncRow({ model, added, full, onAdd, onRemove }) {
  const label = model.label && model.label.toLowerCase() !== model.name.toLowerCase() ? model.label : null;
  const tags = [model.vision && "看图", model.reasoning && "思考", model.pdf && "PDF", !model.known && "未收录"].filter(Boolean);
  return (
    <li>
      <div className="member-body">
        <span className="sync-name">
          <strong><LabLogo lab={labOfModel(model.name)} size={16} />{model.name}</strong>
          {label && <span className="muted"> · {label}</span>}
        </span>
        {tags.length > 0 && (
          <span className="sync-tags">
            {tags.map((t) => (
              <Tag key={t} tone="muted">{t}</Tag>
            ))}
          </span>
        )}
      </div>
      <div className="member-actions">
        {added ? (
          <>
            <span className="muted sync-added">已添加</span>
            <Btn small aria-label={`移除：${model.name}`} onClick={() => onRemove(model.name)}>移除</Btn>
          </>
        ) : (
          <Btn small aria-label={`添加：${model.name}`} disabled={full} reason={`最多 ${MAX_MODELS} 个模型`} onClick={() => onAdd([model])}>添加</Btn>
        )}
      </div>
    </li>
  );
}

/**
 * 同步模型: the provider's own model list (`listProviderModels`, its saved address and key), to search and add from.
 * Adding and removing edit the form's list (`models`, through `onAdd` / `onRemove`); `onDone` is 完成 (the form decides
 * whether that saves), `onClose` closes it as it is. `saving` and `saveError` are 完成's.
 */
function SyncDialog({ provider, models, onAdd, onRemove, onDone, onClose, saving, saveError }) {
  const { actions } = useStore();
  /** {status: "loading"} | {status: "ok", listed} | {status: "failed", text, noList} */
  const [load, setLoad] = useState({ status: "loading" });
  const [query, setQuery] = useState("");
  const [othersOpen, setOthersOpen] = useState(false);
  const [note, setNote] = useState(null);
  const generation = useRef(0);

  const fetchList = useCallback(async () => {
    generation.current += 1;
    const mine = generation.current;
    setLoad({ status: "loading" });
    const res = await actions.listProviderModels(provider.id);
    if (generation.current !== mine) return;
    if (res.ok) setLoad({ status: "ok", listed: res.value.listed, catalogue: res.value.source === "catalogue", sibling: res.value.source === "sibling" });
    else setLoad({ status: "failed", text: res.text, noList: noModelList(res.error), detail: res.error?.detail ?? null });
  }, [actions, provider.id]);
  useEffect(() => {
    fetchList();
    return () => {
      generation.current += 1;
    };
  }, [fetchList]);

  const have = new Set(models.map((m) => m.name));
  const full = models.length >= MAX_MODELS;
  const listed = load.status === "ok" ? load.listed : [];
  const needle = query.trim().toLowerCase();
  const matches = (m) => !needle || m.name.toLowerCase().includes(needle) || (m.label ?? "").toLowerCase().includes(needle);
  const chat = listed.filter((m) => m.chat && matches(m));
  const others = listed.filter((m) => !m.chat && matches(m));
  // One budget of rows for both groups, the chat models first.
  const chatShown = chat.slice(0, SHOWN_ROWS);
  const othersShown = othersOpen ? others.slice(0, SHOWN_ROWS - chatShown.length) : [];
  // With text in the search box only the chat models it lists are added; with none, every chat model.
  const toAdd = listed.filter((m) => m.chat && !have.has(m.name) && matches(m));

  const addAll = () => {
    const room = MAX_MODELS - models.length;
    const taken = toAdd.slice(0, Math.max(0, room));
    onAdd(taken);
    setNote(taken.length < toAdd.length ? ADDED_AT_LIMIT(taken.length) : null);
  };
  const rows = (list) =>
    list.map((m) => <SyncRow key={m.name} model={m} added={have.has(m.name)} full={full} onAdd={onAdd} onRemove={onRemove} />);
  const more = (n) => n > 0 && <p className="muted">还有 {n} 个，请用搜索缩小范围</p>;

  return (
    <Modal
      wide
      title={`${provider.name} 的模型${load.status === "ok" ? `（${listed.length}）` : ""}`}
      onClose={onClose}
      footer={
        <Btn variant="primary" disabled={saving} onClick={onDone}>
          {saving ? "保存中…" : "完成"}
        </Btn>
      }
    >
      {load.status === "loading" && <p className="muted">正在读取供应商的模型列表…</p>}
      {load.status === "failed" &&
        (load.noList ? (
          <>
            <p className="field-hint" role="status">{load.text}</p>
            <UpstreamDetails detail={load.detail} />
          </>
        ) : (
          <div className="sync-failed">
            <p className="field-msg" role="alert">{load.text}</p>
            <UpstreamDetails detail={load.detail} />
            <Btn small onClick={fetchList}>重试</Btn>
            <p className="muted">{FAILED_BY_HAND}</p>
          </div>
        ))}
      {load.status === "ok" && listed.length === 0 && <p className="field-hint" role="status">供应商没有列出任何模型，可以手动添加。</p>}
      {load.status === "ok" && listed.length > 0 && (
        <>
          {load.catalogue && <p className="muted">{FROM_CATALOGUE}</p>}
          {load.sibling && <p className="muted">{FROM_SIBLING}</p>}
          <div className="sync-tools">
            <label className="search">
              <Search size={18} aria-hidden="true" />
              <input type="search" maxLength={100} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索模型" aria-label="搜索模型" />
            </label>
            <Btn small disabled={full || toAdd.length === 0} onClick={addAll}>{needle ? "添加全部匹配项" : "添加全部"}</Btn>
          </div>
          {note && <p className="field-hint" role="status">{note}</p>}
          <ul className="member-rows sync-rows" aria-label="供应商的模型">{rows(chatShown)}</ul>
          {more(chat.length - chatShown.length)}
          {chat.length === 0 && <p className="muted">{needle ? "没有找到匹配的对话模型。" : "供应商列出的都可能不是对话模型。"}</p>}
          {others.length > 0 && (
            <div className="sync-others">
              <Btn small variant="text" aria-expanded={othersOpen} aria-controls="sync-others-list" onClick={() => setOthersOpen(!othersOpen)}>
                可能不是对话模型（{others.length}）
              </Btn>
              {othersOpen && (
                <>
                  <ul id="sync-others-list" className="member-rows sync-rows" aria-label="可能不是对话模型">{rows(othersShown)}</ul>
                  {more(others.length - othersShown.length)}
                </>
              )}
            </div>
          )}
        </>
      )}
      {saveError && <p className="field-msg" role="alert">{saveError}</p>}
    </Modal>
  );
}

/**
 * Add (no `provider`) or edit one of my providers. The key is typed into an uncontrolled password field: it is never
 * held in React state, never written back into the page, read once when the request is built, and the field is emptied
 * as soon as that request is sent (whatever its answer). Editing sends only what changed; an empty key keeps the saved one.
 */
function ProviderForm({ provider = null, created = false, draftKey, onBack, onCreated }) {
  const { state, dispatch, actions } = useStore();
  // From `GET /api/models`: a model's context when none is given, and the output limit of every call (null while unknown).
  const defaults = state.providerDefaults;
  const { busy, run } = useAction();
  const formRef = useRef(null);
  const keyRef = useRef(null);
  // What was typed here before (an accidental Back, a way out and in again): in memory only, keyed by the page's address.
  const draft = useRef(peekDraft(draftKey)).current;
  /** The page's address (from the page, not from the browser: the form is drawn before the address is written): a close or a move after an await is made only if the person is still here. */
  const at = `/settings/providers/${draftKey}`;
  const [f, setF] = useState(() => draft?.f ?? { name: provider?.name ?? "", protocol: provider?.protocol ?? PROTOCOLS[0][0], baseUrl: provider?.baseUrl ?? "" });
  const [models, setModels] = useState(() => draft?.models ?? (provider?.models ?? []).map(formModel));
  const latestModels = useRef(models);
  latestModels.current = models;
  const latestForm = useRef(f);
  latestForm.current = f;
  /** Whether something is typed in the key field, and what is wrong with it: never the key itself. */
  const [key, setKey] = useState(() => {
    const typed = draft?.keyText ?? "";
    return { given: typed.trim() !== "", problem: typed.trim() ? keyFormatProblem(typed) : "" };
  });
  /**
   * A request carried the key and was refused: the field was emptied, so it says to fill it in again. When editing,
   * saving stays blocked until a key is typed or the owner chooses 保留原密钥 (never a silent "saved" without the key).
   */
  const [keyCleared, setKeyCleared] = useState(false);
  /** The owner chose 保留原密钥 (and has not typed a key since): a save that then changes nothing says the key was kept. */
  const keptKey = useRef(false);
  const [touched, setTouched] = useState(false);
  const [refusal, setRefusal] = useState(null);
  const [newModel, setNewModel] = useState("");
  const [newModelError, setNewModelError] = useState("");
  /** Names of the models whose 高级 is open. */
  const [open, setOpen] = useState(() => new Set());
  /**
   * The 同步模型 dialog while open: `{dirtyBefore}`, whether the model list already differed from the saved one when it
   * opened. A provider just added without models opens it at once (this form is new for it, so only once).
   */
  const [sync, setSync] = useState(() => (created && provider !== null && provider.models.length === 0 ? { dirtyBefore: false } : null));
  const [syncError, setSyncError] = useState(null);
  // 测试连接 says hi to the first saved model (not one only added in this form: it is not saved yet).
  const { result: testResult, test, clear: clearTest } = useConnectionTest(provider?.id ?? null, provider?.models[0]?.name, run);

  const editing = provider !== null;
  const address = f.baseUrl.trim();
  const addressChanged = editing && address !== provider.baseUrl;
  const originChanged = addressChanged && originOf(address) !== originOf(provider.baseUrl);
  // 测试连接 and 同步模型 use the saved address and key: not while new ones wait to be saved.
  const unsaved = addressChanged || key.given;
  // Where a reply will go: the saved address as it is stored (never rewritten), or what the service will store for the
  // one typed, with the type's own path; nothing while it is not an address the service takes.
  const protocol = editing ? provider.protocol : f.protocol;
  const base = editing && !addressChanged ? provider.baseUrl : storedBaseUrl(protocol, address);
  const requestUrl = base ? `${base}${REQUEST_PATH[protocol] ?? ""}` : null;

  // Adding needs a key. Editing keeps the saved one, unless the address moved to another origin, or a new key was
  // refused and the owner has not yet said whether to type it again or keep the saved one.
  const keyError = key.given
    ? key.problem
    : editing
      ? originChanged
        ? KEY_AGAIN
        : keyCleared
          ? KEY_NOT_SAVED
          : ""
      : keyCleared
        ? KEY_CLEARED
        : "请填写密钥";
  const offerKeep = editing && keyCleared && !key.given && !originChanged;
  const contextErrors = Object.fromEntries(models.map((m) => [m.name, contextProblem(m.context)]));
  const errors = { name: nameProblem(f.name), baseUrl: addressProblem(f.baseUrl), key: keyError };
  const invalid = Object.values(errors).some(Boolean) || Object.values(contextErrors).some(Boolean);
  const shown = (field) => (touched ? errors[field] : "");
  const nameError = shown("name") || (refusal?.code === "name_taken" ? refusal.text : "");

  const keyHint = keyCleared
    ? KEY_CLEARED
    : !editing
      ? "保存后不会再显示，之后只显示最后 4 位。"
      : originChanged
        ? KEY_AGAIN
        : `已保存的密钥：…${provider.keyLast4}。留空则保持不变，填写则替换它。`;

  const set = (field) => (event) => {
    const value = event.target.value;
    setF((cur) => ({ ...cur, [field]: value }));
    if (field === "name" && refusal?.code === "name_taken") setRefusal(null);
    if (field === "baseUrl") clearTest();
  };
  /** The page's own 返回 and 取消: what was typed (a key among it) is forgotten at once; only the browser's Back and Forward keep it. */
  const cancel = () => {
    forgetDraft(draftKey);
    onBack(at);
  };
  const remember = (keyText) => saveDraft(draftKey, { f: latestForm.current, models: latestModels.current, keyText });
  useEffect(() => {
    remember(keyRef.current?.value ?? "");
  }, [f, models]);
  const onKey = (event) => {
    const value = event.target.value;
    remember(value);
    setKey({ given: value.trim() !== "", problem: value.trim() ? keyFormatProblem(value) : "" });
    setKeyCleared(false);
    keptKey.current = false;
    clearTest();
  };
  /** The owner does not want to change the key after all: the saved one stays, and saving is possible again. */
  const keepSavedKey = () => {
    setKeyCleared(false);
    keptKey.current = true;
    keyRef.current?.focus();
  };
  /** The key leaves the page: the field is emptied (the request already holds it). */
  const dropKey = () => {
    if (keyRef.current) keyRef.current.value = "";
    remember("");
    setKey({ given: false, problem: "" });
  };

  const addModel = () => {
    const name = newModel.trim();
    const problem = modelNameProblem(name, models);
    setNewModelError(problem);
    if (problem) return;
    setModels((cur) => [...cur, { name, vision: false, pdf: false, reasoning: false, context: "", levels: null }]);
    setNewModel("");
  };
  /** 同步模型's 添加 and 添加全部: the models not in the list yet, as far as there is room. */
  const addSynced = (list) =>
    setModels((cur) => {
      const have = new Set(cur.map((m) => m.name));
      const fresh = list.filter((m) => !have.has(m.name)).slice(0, Math.max(0, MAX_MODELS - cur.length));
      return [...cur, ...fresh.map(syncedModel)];
    });
  const changeModel = (name, next) => setModels((cur) => cur.map((m) => (m.name === name ? next : m)));
  const removeModel = (name) => {
    setModels((cur) => cur.filter((m) => m.name !== name));
    setOpen((cur) => new Set([...cur].filter((n) => n !== name)));
  };
  const toggle = (name) => setOpen((cur) => (cur.has(name) ? new Set([...cur].filter((n) => n !== name)) : new Set([...cur, name])));

  const refused = (error, sentKey) => {
    if (sentKey) setKeyCleared(true);
    if (error?.code === "busy_here") return;
    const code = error?.error?.code ?? "unknown";
    const text = refusalText(error);
    setRefusal({ code, text });
    // Gone meanwhile: the page goes back to the list, where this form's notice would not be seen.
    if (code === "not_found") dispatch({ type: "toast", text });
    if (code === "name_taken") focusInvalid(formRef.current);
  };

  const create = async () => {
    const body = { name: f.name.trim(), protocol: f.protocol, baseUrl: address, apiKey: keyRef.current.value.trim() };
    const pending = run("save", () => settled(actions.createProvider(body)), () => "");
    dropKey();
    const res = await pending;
    if (!res.ok) return refused(res.error, true);
    forgetDraft(draftKey);
    if (res.value?.id) onCreated(res.value.id, at);
    else onBack(at);
  };

  const save = async () => {
    const patch = {};
    const name = f.name.trim();
    if (name !== provider.name) patch.name = name;
    if (addressChanged) patch.baseUrl = address;
    const list = models.map(wireModel);
    if (modelsKey(list) !== modelsKey(provider.models)) patch.models = list;
    const apiKey = keyRef.current.value.trim();
    if (apiKey) patch.apiKey = apiKey;
    if (Object.keys(patch).length === 0) {
      // (After 保留原密钥 the owner made a choice: it is confirmed, quietly, rather than met with nothing.)
      if (keptKey.current) dispatch({ type: "toast", text: KEY_KEPT });
      forgetDraft(draftKey);
      onBack(at);
      return;
    }
    const pending = run("save", () => settled(actions.patchProvider(provider.id, patch)), () => "");
    dropKey();
    clearTest();
    const res = await pending;
    if (!res.ok) return refused(res.error, Boolean(apiKey));
    dispatch({ type: "toast", text: "供应商已保存" });
    forgetDraft(draftKey);
    onBack(at);
  };

  const submit = async (event) => {
    event.preventDefault();
    if (busy !== null) return;
    setTouched(true);
    setRefusal(null);
    if (invalid) {
      // A model whose context is wrong shows its 高级, so the field can be seen and focused.
      const wrong = models.filter((m) => contextErrors[m.name]).map((m) => m.name);
      if (wrong.length > 0) setOpen((cur) => new Set([...cur, ...wrong]));
      focusInvalid(formRef.current);
      return;
    }
    if (editing) await save();
    else await create();
  };

  const openSync = () => {
    setSyncError(null);
    setSync({ dirtyBefore: modelsKey(latestModels.current.map(wireModel)) !== modelsKey(provider.models) });
  };
  const closeSync = () => {
    setSync(null);
    setSyncError(null);
  };
  /**
   * 完成: what the dialog changed is in the form's list. With nothing else unsaved in the form (name, address, key, a
   * model list already changed before the dialog opened), that list is saved at once; otherwise it waits for 保存.
   */
  const finishSync = async () => {
    const list = latestModels.current.map(wireModel);
    const changed = modelsKey(list) !== modelsKey(provider.models);
    const otherChanges = sync.dirtyBefore || f.name.trim() !== provider.name || unsaved || keyCleared;
    if (!changed || otherChanges) return closeSync();
    setSyncError(null);
    const res = await run("sync", () => settled(actions.patchProvider(provider.id, { models: list })), () => "");
    if (!res.ok) {
      if (res.error?.code === "busy_here") return;
      // Gone meanwhile: the page goes back to the list; the reason is said there.
      if (res.error?.error?.code === "not_found") return dispatch({ type: "toast", text: refusalText(res.error) });
      setSyncError(refusalText(res.error));
      return;
    }
    // The form holds the list as saved now (a model without a context has the default one there).
    if (Array.isArray(res.value?.models)) setModels(res.value.models.map(formModel));
    dispatch({ type: "toast", text: `已保存 ${res.value?.models?.length ?? list.length} 个模型` });
    closeSync();
  };

  const syncButton = (
    <Btn small disabled={busy !== null || unsaved} reason="新的接口地址或密钥还没保存" onClick={openSync}>
      同步模型
    </Btn>
  );

  const onNewModelKey = (event) => {
    if (!isEnter(event)) return;
    event.preventDefault();
    addModel();
  };

  return (
    <section className="page" aria-label={editing ? "编辑模型供应商" : "添加模型供应商"}>
      <button type="button" className="back" onClick={cancel}>
        <ChevronLeft size={20} aria-hidden="true" /> 返回
      </button>
      <header className="profile-head">
        <div>
          <p className="eyebrow">模型供应商</p>
          <h2>{editing ? `编辑 ${provider.name}` : "添加供应商"}</h2>
        </div>
      </header>
      <form ref={formRef} className="page-body form" onSubmit={submit} noValidate>
        {created && <Notice tone="ok">已添加。请选择要使用的模型。</Notice>}
        <Field label="名称" hint="只给你自己看，用来区分不同的供应商。" error={nameError}>
          <input value={f.name} onChange={set("name")} autoComplete="off" placeholder="例如：我的 OpenAI" />
        </Field>
        {editing ? (
          <div className="field">
            <span className="field-label">接口类型</span>
            <p className="readonly"><Lock size={14} aria-hidden="true" /> {protocolLabel(provider.protocol)}（创建后不可修改）</p>
          </div>
        ) : (
          <Field label="接口类型" hint="供应商的接口和哪一种一样，就选哪一种。创建后不可修改。">
            <select value={f.protocol} onChange={set("protocol")}>
              {PROTOCOLS.map(([id, label]) => (
                <option key={id} value={id}>{label}</option>
              ))}
            </select>
          </Field>
        )}
        <Field label="接口地址" hint={`需要以 https:// 开头，例如 ${EXAMPLE_ADDRESS[editing ? provider.protocol : f.protocol] ?? EXAMPLE_ADDRESS.openai_chat}`} error={shown("baseUrl")}>
          <input value={f.baseUrl} onChange={set("baseUrl")} autoComplete="off" autoCapitalize="none" spellCheck={false} inputMode="url" placeholder={EXAMPLE_ADDRESS[f.protocol]} />
        </Field>
        <div className="address-preview">
          {requestUrl && (
            <p className="field-hint" style={{ overflowWrap: "anywhere" }}>
              实际请求地址：{requestUrl}
            </p>
          )}
          <p className="muted">{AS_TYPED_HINT}</p>
        </div>
        <Field label="密钥" hint={keyHint} error={shown("key")}>
          <input ref={keyRef} type="password" defaultValue={draft?.keyText ?? ""} onChange={onKey} autoComplete="new-password" autoCapitalize="none" spellCheck={false} />
        </Field>
        {offerKeep && (
          <div className="member-actions">
            <Btn small onClick={keepSavedKey}>保留原密钥</Btn>
          </div>
        )}
        {editing && (
          <div className="field">
            <div className="member-actions">
              <Btn small disabled={busy !== null || unsaved} reason="新的接口地址或密钥还没保存" onClick={test}>
                {busy === "test" ? "测试中…" : "测试连接"}
              </Btn>
            </div>
            <TestResult result={testResult} />
          </div>
        )}

        {!editing && <p className="muted">{CREATE_MODELS_HINT}</p>}
        {editing && (
          <>
            <h3>模型</h3>
            <p className="muted">Agent 只能使用列在这里的模型。名称要和供应商那边的模型名完全一致。</p>
            {models.length === 0 ? (
              <div className="member-actions">
                <p className="muted">还没有模型。Agent 需要至少一个模型才能使用这个供应商。</p>
                {syncButton}
              </div>
            ) : (
              <ul className="member-rows" aria-label="模型列表">
                {models.map((m) => (
                  <ModelRow
                    key={m.name}
                    model={m}
                    open={open.has(m.name)}
                    error={touched ? contextErrors[m.name] : ""}
                    defaults={defaults}
                    onToggle={() => toggle(m.name)}
                    onChange={(next) => changeModel(m.name, next)}
                    onRemove={() => removeModel(m.name)}
                  />
                ))}
              </ul>
            )}
            <Field label="模型名称" hint={`最多 ${MAX_MODELS} 个模型。`} error={newModelError}>
              <input value={newModel} onChange={(e) => setNewModel(e.target.value)} onKeyDown={onNewModelKey} autoComplete="off" autoCapitalize="none" spellCheck={false} />
            </Field>
            <div className="member-actions">
              <Btn small onClick={addModel}>添加模型</Btn>
              {models.length > 0 && syncButton}
            </div>
            <p className="field-hint">同步模型会用已保存的地址和密钥。有的供应商不提供模型列表，这时请手动添加。</p>
            {unsaved && <Reason>请先保存新的接口地址或密钥，再测试连接或同步模型。</Reason>}
          </>
        )}

        <Notice tone="info">{PRIVACY_TEXT}</Notice>
        {refusal && refusal.code !== "name_taken" && <Notice tone="warn">{refusal.text}</Notice>}
        <div className="form-actions">
          <Btn onClick={cancel}>取消</Btn>
          <Btn variant="primary" type="submit" disabled={busy !== null}>
            {busy === "save" ? "保存中…" : editing ? "保存" : "保存并选择模型"}
          </Btn>
        </div>
      </form>
      {editing && sync && (
        <SyncDialog
          provider={provider}
          models={models}
          onAdd={addSynced}
          onRemove={removeModel}
          onDone={finishSync}
          onClose={closeSync}
          saving={busy === "sync"}
          saveError={syncError}
        />
      )}
    </section>
  );
}

/**
 * Settings › 模型供应商: my providers (read again whenever the section opens), and the form to add or edit one.
 * `back`: the settings back button (to the settings list on a phone).
 */
export function ProvidersPage({ back }) {
  const { state, dispatch, actions } = useStore();
  const up = useUp();
  // The form is a page of its own, and an address (/settings/providers/new, /settings/providers/<id>): Back is the list.
  const { providerId } = state.nav;
  const open = (id, created = false, replace = false) => dispatch({ type: "nav", replace, patch: { providerId: id, providerCreated: created } });
  const [load, setLoad] = useState("loading");
  const [removing, setRemoving] = useState(null);
  const reload = useCallback(async () => {
    setLoad("loading");
    const res = await actions.loadProviders();
    setLoad(res.ok ? "ok" : "failed");
  }, [actions]);
  useEffect(() => {
    reload();
  }, [reload]);
  // The limits shown with a model's context (normally loaded with the connection).
  const defaultsKnown = state.providerDefaults !== null;
  useEffect(() => {
    if (!defaultsKnown) actions.loadModels();
  }, [actions, defaultsKnown]);

  const providers = Object.values(state.providers);
  const editing = providerId && providerId !== "new" ? state.providers[providerId] ?? null : null;
  // An address of a provider that is not here (gone, never mine): the list, with a notice, and the entry is made the list.
  const gone = load === "ok" && providerId && providerId !== "new" && !state.providers[providerId];
  useEffect(() => {
    if (!gone) return;
    dispatch({ type: "nav", replace: true, patch: { providerId: null, providerCreated: false } });
    dispatch({ type: "toast", text: "找不到这个模型供应商" });
  }, [gone, dispatch]);

  if (providerId === "new") {
    return (
      <ProviderForm
        key="new"
        draftKey="new"
        onBack={up}
        onCreated={(id, at) => {
          // (The form ends in what it made: its entry becomes the new provider's page, if the person is still on the form.)
          if (window.location.pathname === at) open(id, true, true);
        }}
      />
    );
  }
  if (editing) return <ProviderForm key={editing.id} draftKey={editing.id} provider={editing} created={state.nav.providerCreated} onBack={up} />;

  const full = providers.length >= MAX_PROVIDERS;
  return (
    <section className="page" aria-label="模型供应商">
      {back}
      <header className="profile-head">
        <div className="grow">
          <h2>模型供应商</h2>
          <p className="muted">
            在模型服务商那里有账号的话，把它的接口地址和密钥填在这里，你的 Agent 就可以用它的模型回复。
            {state.webSearchAvailable === true ? "用自己的供应商时，模型本身不扣本站的点数，但联网搜索照样扣点。" : "用自己的供应商不扣本站的点数。"}
          </p>
        </div>
        <div className="head-actions">
          <Btn variant="primary" disabled={full} reason="最多只能添加 10 个模型供应商" onClick={() => {
              forgetDraft("new"); // (A fresh form: Back and Forward bring a typed one back, an Add does not.)
              open("new");
            }}>
            <Plus size={16} aria-hidden="true" /> 添加供应商
          </Btn>
        </div>
      </header>
      <div className="page-body">
        {full && <Reason>最多只能添加 10 个模型供应商。删除不用的之后可以再添加。</Reason>}
        {load === "failed" && (
          <Reason>
            没能读取你的模型供应商，请重试。 <Btn small onClick={reload}>重试</Btn>
          </Reason>
        )}
        {providers.length > 0 ? (
          <ul className="member-rows" aria-label="我的模型供应商">
            {providers.map((p) => (
              <ProviderRow key={p.id} provider={p} onEdit={() => {
                forgetDraft(p.id); // (An edit starts from the stored provider, never from a draft of an edit that was cancelled.)
                open(p.id);
              }} onDelete={() => setRemoving(p)} />
            ))}
          </ul>
        ) : load === "loading" ? (
          <p className="muted">正在读取…</p>
        ) : load === "ok" ? (
          <p className="muted">还没有添加模型供应商。</p>
        ) : null}
      </div>
      {removing && <DeleteModal provider={removing} onClose={() => setRemoving(null)} />}
    </section>
  );
}
