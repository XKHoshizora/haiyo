import React, { useEffect, useId, useRef, useState } from "react";
import { useUp } from "../state/appHistory.js";
import { useStore } from "../data/store.jsx";
import { commonErrorText } from "../data/errorTexts.js";
import { NAME_PART_PATTERN, agentName as agentNameProblem, appellation as appellationProblem, namePart as namePartProblem } from "../auth/validation.js";
import { PROACTIVE_LEVELS, isProactiveLevel } from "../data/viewmodel.js";
import { Btn, Field, Modal, Notice, Reason, Switch, focusInvalid } from "../ui/primitives.jsx";
import { Select } from "../ui/Select.jsx";
import { ChevronLeft, Lock } from "../icons.js";
import { AgentAppellations } from "./AgentAppellations.jsx";
import { AvatarEditor } from "./AvatarEditor.jsx";
import { useDecision } from "./AgentChatBits.jsx";
import { LEVELS, ModelPicker, choiceList, modelKey, useModelSources } from "./ModelPicker.jsx";
import { refusalText, settled, useAction } from "./useAction.js";

/** The prototype's two private-reply choices, by the service's `replyMode`. */
export const REPLY_MODES = [
  ["always", "收到消息时回复"],
  ["mention", "仅在我点名时回复"],
];
/** Who may call it with @ in a group it is in, by the service's `groupMentions` (the first is the default). */
export const GROUP_MENTIONS = [
  ["members", "所有群成员"],
  ["owner", "仅我"],
];
const PERSONA_MAX = 20000;
const chars = (text) => [...text].length;

/** 一次接话最多花费 when nothing else is said, in points (the service's default). */
export const CHAIN_BUDGET_DEFAULT = "50";
/** 别人 @ 每天最多花 when nothing else is said, in points (the service's default). */
export const OTHERS_BUDGET_DEFAULT = "20";
/** 主动回复每天最多花 when nothing else is said, in points (the service's default); its amount is a budget like the others. */
const PROACTIVE_BUDGET_DEFAULT = "20";
/** The 记忆 switches: the form key, its label and what it says; the last two only matter while the first is on. */
const MEMORY_HELPER = "它会记住关于你的事和自己学到的事。记忆每天有自己的额度，不占用你聊天的额度。";
const MEMORY_SWITCHES = [
  ["memoryAsk", "先问我再记", "记之前先在会话里问你，你同意了才记。"],
  ["sharedNotes", "使用共用的“关于我”", "和你名下其他开着这一项的 Agent 共用同一份。"],
];
/** Asked, under 记忆, when it is turned back on for an Agent that has had it off: the answer is sent at once (`catchUp`). */
const CATCH_UP_QUESTION = "关掉期间聊过的内容，要不要也让它回顾一下？";
/** Under the question: how far back it looks, from the site's own numbers (`GET /api/models` `memoryCatchUp`). */
const catchUpBounds = ({ days, lines }) => `最多回看最近 ${days} 天、每个群最近 ${lines} 条。`;
/** What the service takes when a switch is not said (the form's defaults, `recordFields`). */
const MEMORY_DEFAULTS = { memory: true, memoryAsk: false, sharedNotes: true };
const MEMORY_KEYS = Object.keys(MEMORY_DEFAULTS);
/** Under 主动参与群聊: what it does, or — the site having no judgement model — why it does nothing now. */
const PROACTIVE_HELPER = "打开后，群里有人说到它擅长的事，没 @ 它它也可能回复。花的是你的点。";
const PROACTIVE_LOST = "站点现在没有配置判断模型，主动参与不会生效。可以先关掉。";
/**
 * 群里没找到时悄悄告诉我 (`whisperElsewhere`, on unless the record says off): when a search in a group finds nothing there but
 * it has it elsewhere, it whispers to me first (only I see it) and asks whether to tell the group.
 */
const ELSEWHERE_LABEL = "群里没找到时悄悄告诉我";
const ELSEWHERE_HELPER = "它在别处查到了，会先悄悄问你要不要告诉大家。";
/** 联网搜索 (`webSearch`, on unless the record says off): shown only while the site offers web search (`webSearchAvailable`). */
const WEB_LABEL = "联网搜索";
const WEB_WORDS = "搜索词会发给外部的搜索服务。";
/** The line under 联网搜索 (the product owner's words): the price the service gives (`webSearchPoints`), then where the words go. */
const webHelper = (points) =>
  typeof points === "string" && /^\d{1,9}(\.\d)?$/.test(points) && points !== "0" ? `联网搜索由站点提供，每次约 ${points} 点，先用每日免费额度。${WEB_WORDS}` : WEB_WORDS;

/**
 * The money hints of the budgets (fix round 1, I2): while the site offers web search, an Agent on its owner's own provider's
 * model still costs nothing for its model, but its web searches are charged — and these budgets bound them; while it
 * offers none, the words as before.
 */
const BUDGET_HINTS = {
  chain: {
    off: "两次真人发言之间，它被其他 Agent 叫动所花的点数到了这个数就不再接话。真人 @ 它不受限制。用你自己供应商模型的 Agent 不扣点，这个上限对它不起作用。",
    web: "两次真人发言之间，它被其他 Agent 叫动所花的点数到了这个数就不再接话。真人 @ 它不受限制。用你自己供应商模型的 Agent，模型本身不扣点，但联网搜索扣点，这个上限也管它的联网搜索。",
  },
  others: {
    off: "群里别人 @ 它所花的点数，每天到了这个数就不再回复他们。你自己 @ 它不受限制。用你自己供应商模型的 Agent 不扣点，这个上限对它不起作用。",
    web: "群里别人 @ 它所花的点数，每天到了这个数就不再回复他们。你自己 @ 它不受限制。用你自己供应商模型的 Agent，模型本身不扣点，但联网搜索扣点，这个上限也管它的联网搜索。",
  },
  proactive: {
    off: "每天零点（站点时间）重新计算；用完后它当天不再主动接话，被 @ 时照常回复。只对站点的模型有效，用你自己的密钥时不受限。",
    web: "每天零点（站点时间）重新计算；用完后它当天不再主动接话，被 @ 时照常回复。用你自己的密钥时，模型本身不扣点，但联网搜索扣点，这个上限也管它的联网搜索。",
  },
};
// A budget's amount, either of them, as the service takes it.
const BUDGET_MIN = 1;
const BUDGET_MAX = 100000;
/** Points as the service counts them: whole points, and at most six decimals (micro-points). */
const POINTS = /^\d+(?:\.\d{1,6})?$/;
const BUDGET_WRONG = `请填写 ${BUDGET_MIN} 到 ${BUDGET_MAX} 之间的点数（最多 6 位小数）`;

/**
 * A budget's amount (一次接话最多花费, or 别人 @ 每天最多花's 自己填) as typed, as the decimal string sent (" 012.50 " →
 * "12.5"); null when it is not 1–100000 points with at most six decimals.
 */
export function budgetOf(text) {
  const typed = typeof text === "string" ? text.trim() : "";
  if (!POINTS.test(typed)) return null;
  const value = Number(typed);
  if (!(value >= BUDGET_MIN && value <= BUDGET_MAX)) return null;
  const [whole, fraction = ""] = typed.split(".");
  const kept = fraction.replace(/0+$/, "");
  const points = whole.replace(/^0+(?=\d)/, "");
  return kept ? `${points}.${kept}` : points;
}

/** What is wrong with a budget's amount as typed (`budgetOf`): the sentence shown under it, or "". */
const budgetProblem = (text) => (budgetOf(text) === null ? BUDGET_WRONG : "");

/**
 * The sent value of 别人 @ 每天最多花 for the form's fields: the default, the amount typed, or null for 不限 — and
 * undefined, nothing to send, for an amount typed that is not one: never null, which the service reads as no limit.
 */
export const othersBudgetSent = (f) =>
  f.othersChoice === "unlimited" ? null : f.othersChoice === "custom" ? budgetOf(f.othersAmount) ?? undefined : OTHERS_BUDGET_DEFAULT;

/** What a create or a save sends of 别人 @ 每天最多花 (`othersBudgetSent`): nothing (undefined) unless group members may call it. */
const othersBudgetToSend = (f) => (f.groupMentions === "members" ? othersBudgetSent(f) : undefined);

/** Opens an Agent's conversation, or waits for it to arrive when this client does not hold it yet. */
export function openAgentChat(state, dispatch, actions, conversationId, { replace = false } = {}) {
  if (!conversationId) {
    dispatch({ type: "toast", text: "会话还没有同步下来，请稍后在消息列表里查看" });
    return;
  }
  if (state.convs[conversationId]) {
    dispatch({ type: "nav/openConv", convId: conversationId, replace });
    return;
  }
  dispatch({ type: "nav", patch: { opening: { convId: conversationId } } });
  actions.syncNow();
}

const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";
const randomPart = () => Array.from({ length: 6 }, () => BASE36[Math.floor(Math.random() * 36)]).join("");

/**
 * The name part suggested for `name` (the account name is `<my handle>.<name part>`): the name itself when it makes one
 * (spaces as "_"), else agent_ + `random`.
 */
export function suggestHandle(name, random) {
  const ascii = name.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return NAME_PART_PATTERN.test(ascii) ? ascii : `agent_${random}`;
}

/** The name part's box, after my handle and the dot shown as a fixed prefix (`id` and `aria-*` come from `Field`). */
function NamePartInput({ prefix, ...input }) {
  return (
    <span className="handle-input">
      <span className="handle-prefix">{prefix}</span>
      <input {...input} />
    </span>
  );
}

/** The persona as it is sent: NUL dropped (the service refuses it), trimmed (the service stores it trimmed). */
const personaOf = (text) => text.replaceAll("\u0000", "").trim();

/** The editable fields of a record (an Agent of the view model, or none), as the form holds them. */
const recordFields = (a) => ({
  name: a?.name ?? "",
  intro: a?.intro ?? "",
  field: a?.field ?? "",
  persona: a?.persona ?? "",
  replyMode: a?.replyMode ?? "always",
  groupMentions: a?.groupMentions ?? "members",
  chainBudget: budgetOf(a?.chainBudget) ?? CHAIN_BUDGET_DEFAULT,
  // The service's value as a choice and an amount: "20" (or nothing) is the default, null is 不限, anything else 自己填.
  othersChoice: a?.othersBudget === null ? "unlimited" : typeof a?.othersBudget === "string" && a.othersBudget !== OTHERS_BUDGET_DEFAULT ? "custom" : "default",
  othersAmount: typeof a?.othersBudget === "string" ? a.othersBudget : OTHERS_BUDGET_DEFAULT,
  proactive: a?.proactive === true,
  proactiveLevel: isProactiveLevel(a?.proactiveLevel) ? a.proactiveLevel : "normal",
  proactiveBudget: budgetOf(a?.proactiveBudget) ?? PROACTIVE_BUDGET_DEFAULT,
  whisperElsewhere: a?.whisperElsewhere !== false,
  webSearch: a?.webSearch !== false,
  ownerAppellation: a?.ownerAppellation ?? "",
  // The service's defaults when the record says nothing: remembers, tells me nothing first, uses the shared 关于我.
  memory: a?.memory !== false,
  memoryAsk: a?.memoryAsk === true,
  sharedNotes: a?.sharedNotes !== false,
  reasoning: a?.reasoning ?? "none",
  model: modelKey(a?.model ?? null),
});

/**
 * What the form edits of a record, setting by setting: each setting is the form key of its name, but 别人 @ 每天最多花
 * (`othersBudget`), which the form holds as a choice and an amount. Whether I changed a setting, whether it changed
 * elsewhere and whether it is sent are decided per setting, never per key.
 */
const OTHERS_KEYS = ["othersChoice", "othersAmount"];
const settingOf = (key) => (OTHERS_KEYS.includes(key) ? "othersBudget" : key);
const keysOf = (setting) => (setting === "othersBudget" ? OTHERS_KEYS : [setting]);

/** A setting as it would be stored (the text fields trimmed, points as sent), to compare with the record's. */
const storedValue = (setting, f) => {
  if (setting === "persona") return personaOf(f.persona);
  if (setting === "name" || setting === "intro" || setting === "field" || setting === "ownerAppellation") return f[setting].trim();
  if (setting === "chainBudget" || setting === "proactiveBudget") return budgetOf(f[setting]) ?? f[setting].trim();
  if (setting === "othersBudget") return othersBudgetSent(f);
  return f[setting];
};

/**
 * Create (no `agent`) or edit one of my Agents: the prototype's form with the avatar, the account name, the model and
 * its reasoning level, and the persona (with 帮我起草) in place of the role. Refusals are shown in the form, never toasted.
 *
 * Editing sends only the fields the owner changed. While the form is open the record may change elsewhere (another
 * device, a confirmed persona proposal): a setting the owner has not touched then shows the new value; a setting they
 * have touched keeps their text, and a notice says that saving overwrites it.
 */
export function AgentForm({ agent = null }) {
  const { state, dispatch, actions } = useStore();
  const { busy, run } = useAction();
  const sources = useModelSources();
  const formRef = useRef(null);
  const personaId = useId();
  const [random] = useState(randomPart);
  const [f, setF] = useState(() => ({ ...recordFields(agent), handle: agent ? "" : suggestHandle("", random) }));
  const [handleTyped, setHandleTyped] = useState(false);
  const [touched, setTouched] = useState(false);
  /** The avatar picked and not sent yet (sent after the create, or with the save). */
  const [avatarFile, setAvatarFile] = useState(null);
  /** Why the avatar of the last save did not upload (the rest was saved). */
  const [avatarError, setAvatarError] = useState("");
  /** The service's refusal of the last create or save: {code, text}. */
  const [refusal, setRefusal] = useState(null);
  /** The outcome of the last 帮我起草: {done: true} or {error: text}. */
  const [draftNote, setDraftNote] = useState(null);
  const [confirmDraft, setConfirmDraft] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  /** The settings the owner changed (typed, chosen, drafted: `settingOf`); only these are ever sent when editing. */
  const edited = useRef(new Set());
  /** The record's fields as this form last saw them, to tell what changed elsewhere. */
  const record = recordFields(agent);
  const recordKey = JSON.stringify(record);
  const seen = useRef(record);
  const current = useRef(f);
  current.current = f;
  const [changedElsewhere, setChangedElsewhere] = useState(false);
  const editing = agent !== null;
  /** 记忆 turned back on for an Agent that has had it off: the question whether to look back is open (nothing is on until it is answered). */
  const [askCatchUp, setAskCatchUp] = useState(false);
  const catchUpRef = useRef(null);
  const catchUp = useDecision();

  // Esc, or a press anywhere else, closes the question and leaves 记忆 off (not while its answer is being sent).
  useEffect(() => {
    if (!askCatchUp || catchUp.busy !== null) return undefined;
    const outside = (event) => {
      if (!catchUpRef.current?.contains(event.target)) setAskCatchUp(false);
    };
    const escape = (event) => {
      if (event.key === "Escape") setAskCatchUp(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [askCatchUp, catchUp.busy]);

  // Memory turned out to be on already (turned on elsewhere, another tab): there is nothing left to ask.
  useEffect(() => {
    if (record.memory) setAskCatchUp(false);
  }, [record.memory]);

  // Keyed by the record's values (the view model makes a new Agent object whenever anything changes).
  useEffect(() => {
    if (!editing) return;
    const now = JSON.parse(recordKey);
    const before = seen.current;
    seen.current = now;
    const changed = [...new Set(Object.keys(now).map(settingOf))].filter((setting) => storedValue(setting, now) !== storedValue(setting, before));
    const theirs = changed.filter((setting) => !edited.current.has(setting));
    if (theirs.length > 0) {
      setF((cur) => {
        const next = { ...cur };
        for (const setting of theirs) for (const key of keysOf(setting)) next[key] = now[key];
        return next;
      });
    }
    // A setting I changed that now differs from the record (my own save brings back what I typed: no notice).
    if (changed.some((setting) => edited.current.has(setting) && storedValue(setting, current.current) !== storedValue(setting, now))) setChangedElsewhere(true);
  }, [recordKey, editing]);

  const options = choiceList(sources, agent?.model ?? null, agent?.reasoning ?? "none");
  const choice = sources.status === "ready" ? options.find((o) => o.key === f.model) ?? null : null;
  const levels = choice?.levels ?? ["none"];
  const reasoning = levels.includes(f.reasoning) ? f.reasoning : "none";

  // 主动参与群聊 is offered (and sent) only while the site has a judgement model; its level and amount only while it is on.
  // Without one, an Agent that has it on still shows the switch alone, saying why, so that it can be turned off: never on.
  // Before the site's models have answered (null) neither is shown.
  const proactiveOffered = state.proactiveAvailable === true;
  // 联网搜索: only while the site offers web search; otherwise neither shown nor sent.
  const webOffered = state.webSearchAvailable === true;
  const proactiveOffOnly = state.proactiveAvailable === false && record.proactive;
  const proactiveAsked = proactiveOffered && f.proactive;

  const name = f.name.trim();
  const intro = f.intro.trim();
  const field = f.field.trim();
  const persona = personaOf(f.persona);
  const ownerAppellation = f.ownerAppellation.trim();
  const errors = {
    name: agentNameProblem(f.name),
    handle: agent ? "" : namePartProblem(f.handle),
    intro: chars(intro) > 40 ? "简介不超过 40 个字" : "",
    field: chars(field) > 20 ? "擅长领域不超过 20 个字" : "",
    persona: chars(persona) > PERSONA_MAX ? `人格文档不超过 ${PERSONA_MAX} 个字` : "",
    chainBudget: budgetProblem(f.chainBudget),
    ownerAppellation: appellationProblem(f.ownerAppellation),
    // Only while it is asked for (calls from members, 自己填).
    othersAmount: f.groupMentions === "members" && f.othersChoice === "custom" ? budgetProblem(f.othersAmount) : "",
    // Only while the site can judge and the switch is on.
    proactiveBudget: proactiveAsked ? budgetProblem(f.proactiveBudget) : "",
  };
  const invalid = Object.values(errors).some(Boolean);
  const shown = (key) => (touched ? errors[key] : "");
  const handleError = shown("handle") || (refusal?.code === "handle_taken" ? refusal.text : "");

  const blockReason =
    sources.status === "loading"
      ? "正在读取可用的模型…"
      : choice
        ? ""
        : sources.nothing
          ? "还没有可用的模型，需要先添加模型供应商"
          : "请先选择一个模型，否则它不会回复";
  const canDraft = !errors.name && !errors.intro && !errors.field && Boolean(choice) && !choice.stale;

  /** A setting chosen (a Select's value) or typed (`set`: an input's change). */
  const setValue = (key) => (value) => {
    edited.current.add(settingOf(key));
    setF((cur) => ({ ...cur, [key]: value }));
  };
  const set = (key) => (event) => setValue(key)(event.target.value);
  /** The box a budget's amount is typed in (`budgetOf`). */
  const budgetBox = (key) => <input value={f[key]} onChange={set(key)} inputMode="decimal" autoComplete="off" />;
  const setProactive = (event) => {
    const value = event.target.checked;
    edited.current.add("proactive");
    setF((cur) => ({ ...cur, proactive: value }));
  };
  const setSwitch = (key) => (event) => {
    const value = event.target.checked;
    edited.current.add(key);
    setF((cur) => ({ ...cur, [key]: value }));
  };
  /**
   * 记忆: turned back on for an Agent that has had it off (not the create form), it is not just flipped — the question under it asks
   * whether what was said while it was off is to be looked back at, and its answer turns it on at once (`answerCatchUp`). Off is one click.
   */
  const setMemory = (event) => {
    if (editing && event.target.checked && !record.memory && !f.memory) {
      // The form's 记忆 equals the record's (off) again: an earlier change of it in this form is no change any more, so 保存 never
      // sends it, and the record (turned on by the answer, or elsewhere) is what the switch shows.
      edited.current.delete("memory");
      setAskCatchUp(true);
      return;
    }
    setAskCatchUp(false);
    setSwitch("memory")(event);
  };
  const answerCatchUp = async (lookBack) => {
    const res = await catchUp.decide(lookBack ? "back" : "later", actions.patchAgent(agent.id, { memory: true, catchUp: lookBack }));
    // On: the record says so, and the switch shows it (a setting this form did not change follows the record).
    if (res.ok && catchUp.mounted.current) setAskCatchUp(false);
  };
  const setName = (event) => {
    const value = event.target.value;
    edited.current.add("name");
    setF((cur) => ({ ...cur, name: value, handle: agent || handleTyped ? cur.handle : suggestHandle(value, random) }));
  };
  const setHandle = (event) => {
    const value = event.target.value;
    setHandleTyped(true);
    setF((cur) => ({ ...cur, handle: value }));
    if (refusal?.code === "handle_taken") setRefusal(null);
  };
  const setModel = (key) => {
    const next = options.find((o) => o.key === key);
    const level = next?.levels.includes(f.reasoning) ? f.reasoning : "none";
    edited.current.add("model");
    // A level the new model does not take is reset, and that is a change of mine too.
    if (level !== f.reasoning) edited.current.add("reasoning");
    setF((cur) => ({ ...cur, model: key, reasoning: level }));
  };
  const setPersona = (event) => {
    const value = event.target.value;
    edited.current.add("persona");
    setF((cur) => ({ ...cur, persona: value }));
    // Whatever the last draft said is about text that is no longer there.
    if (draftNote) setDraftNote(null);
  };
  const pickAvatar = (file) => {
    setAvatarFile(file);
    setAvatarError("");
  };

  const up = useUp();
  const back = up;
  // Editing: an avatar picked and not saved is not dropped without asking.
  const leave = () => (agent && avatarFile ? setConfirmLeave(true) : back());

  /** A refusal to show in the form (`busy_here`: another action of this form is running, nothing to say). */
  const refused = (error) => {
    if (error?.code === "busy_here") return;
    const code = error?.error?.code ?? "unknown";
    setRefusal({ code, text: refusalText(error) });
    if (code === "agent_limit") actions.loadUsage();
    if (code === "handle_taken") focusInvalid(formRef.current);
  };

  const create = async () => {
    const body = { namePart: f.handle, name };
    if (intro) body.intro = intro;
    if (field) body.field = field;
    if (persona) body.persona = persona;
    body.replyMode = f.replyMode;
    body.groupMentions = f.groupMentions;
    body.chainBudget = budgetOf(f.chainBudget);
    // Said only when others may call it (otherwise the service keeps its default), and never for a wrong amount.
    const othersBudget = othersBudgetToSend(f);
    if (othersBudget !== undefined) body.othersBudget = othersBudget;
    // Said only when it is on (off is the service's default).
    if (proactiveAsked) Object.assign(body, { proactive: true, proactiveLevel: f.proactiveLevel, proactiveBudget: budgetOf(f.proactiveBudget) });
    if (ownerAppellation) body.ownerAppellation = ownerAppellation;
    // Said only when it is off (on is the service's default).
    if (!f.whisperElsewhere) body.whisperElsewhere = false;
    if (webOffered && !f.webSearch) body.webSearch = false;
    // Said only when it is not the service's default.
    for (const key of MEMORY_KEYS) if (f[key] !== MEMORY_DEFAULTS[key]) body[key] = f[key];
    body.reasoning = reasoning;
    body.model = choice.model;
    const res = await run(
      "save",
      async () => {
        const created = await settled(actions.createAgent(body));
        // The avatar can only be sent once the Agent exists; if it fails, the Agent stays created.
        let avatarText = null;
        if (avatarFile && created?.id) {
          const upload = await actions.uploadAgentAvatar(created.id, avatarFile);
          if (!upload.ok) avatarText = upload.text;
        }
        return { created, avatarText };
      },
      () => "",
    );
    if (!res.ok) return refused(res.error);
    const { created, avatarText } = res.value;
    if (!created?.id) {
      dispatch({ type: "nav", replace: true, patch: { agentView: "detail", agentId: null, pane: "list" } });
      return;
    }
    // (The form ends in what it made: its entry becomes the Agent's page or its chat, so Back does not return to an empty form.)
    const detail = { agentView: "detail", agentId: created.id, agentTab: "profile", pane: "main" };
    if (avatarText) {
      const text = `Agent 已创建，但头像没有上传成功：${avatarText}可以在「编辑」里重新上传。`;
      dispatch({ type: "nav", replace: true, patch: { ...detail, agentNote: { agentId: created.id, text } } });
      return;
    }
    dispatch({ type: "nav", replace: true, patch: detail });
    openAgentChat(state, dispatch, actions, created.conversationId, { replace: true });
  };

  const save = async () => {
    // Only what I changed, and only where it differs from the record as it is now: a field I did not touch is never
    // sent, so a change made elsewhere meanwhile is not overwritten by the value this form opened with.
    const mine = (setting) => edited.current.has(setting) && storedValue(setting, f) !== storedValue(setting, record);
    const patch = {};
    for (const key of ["name", "intro", "field", "persona", "replyMode", "groupMentions", "chainBudget"]) if (mine(key)) patch[key] = storedValue(key, f);
    // 别人 @ 每天最多花: only while others may call it, never a wrong amount (`othersBudgetToSend`).
    const othersBudget = othersBudgetToSend(f);
    if (mine("othersBudget") && othersBudget !== undefined) patch.othersBudget = othersBudget;
    // 主动参与群聊: while the site can judge, or (only off, then) while it is on without a judgement model; its level and
    // amount only while it is on and can be.
    if (proactiveOffered || proactiveOffOnly) {
      if (mine("proactive")) patch.proactive = f.proactive;
      if (proactiveAsked) for (const key of ["proactiveLevel", "proactiveBudget"]) if (mine(key)) patch[key] = storedValue(key, f);
    }
    if (mine("whisperElsewhere")) patch.whisperElsewhere = f.whisperElsewhere;
    if (webOffered && mine("webSearch")) patch.webSearch = f.webSearch;
    // 它怎么称呼你: cleared (emptied) is null, which the service reads as none.
    if (mine("ownerAppellation")) patch.ownerAppellation = ownerAppellation || null;
    for (const key of MEMORY_KEYS) if (mine(key)) patch[key] = f[key];
    // The service checks the model and the reasoning level together: a new model goes with its level. The level alone
    // is sent only when I changed it (a stored level the model no longer takes is not reset behind my back).
    const modelChanged = mine("model") && !choice.stale;
    if (modelChanged) patch.model = choice.model;
    if (modelChanged || (edited.current.has("reasoning") && reasoning !== record.reasoning)) patch.reasoning = reasoning;
    const changes = Object.keys(patch).length > 0;
    if (!changes && !avatarFile) {
      back();
      return;
    }
    setAvatarError("");
    const formPath = window.location.pathname;
    const res = await run(
      "save",
      async () => {
        if (changes) await settled(actions.patchAgent(agent.id, patch));
        if (!avatarFile) return null;
        const upload = await actions.uploadAgentAvatar(agent.id, avatarFile);
        return upload.ok ? null : upload.text;
      },
      () => "",
    );
    if (!res.ok) return refused(res.error);
    if (res.value) {
      // The rest is saved (my fields now equal the record): saving again sends the avatar alone.
      setAvatarError(changes ? `其他修改已保存，但头像没有上传成功：${res.value}` : `头像没有上传成功：${res.value}`);
      return;
    }
    // Saved: the form is closed like its own back button does (the Agent page is the entry below it), so no entry points back into the form just saved;
    // only if the person is still on the form (they may have left while it saved).
    up(formPath);
  };

  const submit = async (event) => {
    event.preventDefault();
    if (busy !== null || blockReason) return;
    setTouched(true);
    setRefusal(null);
    if (invalid) {
      focusInvalid(event.currentTarget);
      return;
    }
    if (agent) await save();
    else await create();
  };

  const draft = async () => {
    setConfirmDraft(false);
    setDraftNote(null);
    const body = { name };
    if (intro) body.intro = intro;
    if (field) body.field = field;
    body.model = choice.model;
    const res = await run("draft", () => settled(actions.draftPersona(body)), () => "");
    if (!res.ok) {
      if (res.error?.code !== "busy_here") setDraftNote({ error: refusalText(res.error) });
      return;
    }
    if (typeof res.value?.persona !== "string") {
      setDraftNote({ error: commonErrorText(null) });
      return;
    }
    edited.current.add("persona");
    setF((cur) => ({ ...cur, persona: res.value.persona }));
    setDraftNote({ done: true });
  };
  // Drafting never replaces what was written without asking.
  const askDraft = () => (f.persona.trim() ? setConfirmDraft(true) : draft());

  const personaError = shown("persona");
  const describedBy = [`${personaId}-count`, personaError && `${personaId}-error`, draftNote?.error && `${personaId}-draft`, `${personaId}-hint`]
    .filter(Boolean)
    .join(" ");
  const limitText =
    refusal?.code === "agent_limit" && Number.isFinite(state.usage?.agentLimit)
      ? `你的 Agent 数量已达到当前档位的上限（最多 ${state.usage.agentLimit} 个）。删除不用的 Agent 后可以再创建。`
      : refusal?.text;

  return (
    <section className="page" aria-label={agent ? "编辑 Agent" : "创建 Agent"}>
      <button type="button" className="back" onClick={leave}>
        <ChevronLeft size={20} aria-hidden="true" /> 返回
      </button>
      <header className="profile-head">
        <div>
          <p className="eyebrow">我的 Agent</p>
          <h2>{agent ? `编辑 ${agent.name}` : "创建 Agent"}</h2>
        </div>
      </header>
      <form ref={formRef} className="page-body form" onSubmit={submit} noValidate>
        {changedElsewhere && <Notice tone="warn">这个 Agent 的配置刚刚在别处有改动，保存会用你这里的内容覆盖你改过的几项。</Notice>}
        <div className="field">
          <span className="field-label">头像</span>
          {/* Held until the form is saved (after the Agent is created, or with the other changes). */}
          <AvatarEditor
            id={agent ? agent.id : null}
            onPick={pickAvatar}
            disabled={busy !== null}
            hint={agent ? "支持 PNG、JPEG、WebP，不超过 20 MB；选好后可以拖动和缩放，保存后生效。" : undefined}
          />
          {avatarError && <p className="field-msg" role="alert">{avatarError}</p>}
        </div>
        <Field label="名称" error={shown("name")}>
          <input value={f.name} onChange={setName} autoComplete="off" placeholder="例如：我的美食助手" />
        </Field>
        {agent ? (
          <div className="field">
            <span className="field-label">账号名</span>
            <p className="readonly"><Lock size={14} aria-hidden="true" /> {agent.handle}（名字部分创建后不可修改，前面跟随你的账号名）</p>
          </div>
        ) : (
          <Field label="账号名" hint="2 到 24 位小写字母、数字或下划线，接在你的账号名后面，创建后不可修改" error={handleError}>
            <NamePartInput prefix={`${state.account?.handle ?? ""}.`} value={f.handle} onChange={setHandle} autoComplete="off" autoCapitalize="none" spellCheck={false} />
          </Field>
        )}
        <div className="field">
          <span className="field-label">主人</span>
          <p className="readonly"><Lock size={14} aria-hidden="true" /> 你（不可修改）</p>
        </div>
        <Field label="简介" error={shown("intro")}>
          <input value={f.intro} onChange={set("intro")} autoComplete="off" placeholder="一句话介绍它能做什么" />
        </Field>
        <Field label="擅长领域" error={shown("field")}>
          <input value={f.field} onChange={set("field")} autoComplete="off" placeholder="例如：旅行规划" />
        </Field>
        <ModelPicker
          sources={sources}
          options={options}
          value={f.model}
          onChange={setModel}
          focus={state.nav.agentFocus === "model"}
          onFocused={() => dispatch({ type: "nav", patch: { agentFocus: null } })}
        />
        {choice && levels.length > 1 && (
          <Field label="思考程度" hint="思考越多，回复越慢，用量也越多。">
            <Select
              value={reasoning}
              onChange={setValue("reasoning")}
              listLabel="思考程度"
              options={LEVELS.filter(([id]) => levels.includes(id)).map(([id, label]) => ({ value: id, label }))}
            />
          </Field>
        )}
        <div className={`field ${personaError ? "field-error" : ""}`}>
          <label htmlFor={personaId}>人格文档</label>
          <textarea
            id={personaId}
            rows={10}
            value={f.persona}
            onChange={setPersona}
            readOnly={busy === "draft"}
            aria-invalid={personaError ? true : undefined}
            aria-describedby={describedBy}
          />
          <div className="member-actions">
            <Btn small disabled={!canDraft || busy !== null} reason="填写名称并选择模型后可以让它起草" onClick={askDraft}>
              {busy === "draft" ? "起草中…" : "帮我起草"}
            </Btn>
            <span id={`${personaId}-count`} className="field-hint">{chars(persona)} / {PERSONA_MAX}</span>
          </div>
          {personaError && <p id={`${personaId}-error`} className="field-msg" role="alert">{personaError}</p>}
          {draftNote?.error && <p id={`${personaId}-draft`} className="field-msg" role="alert">{draftNote.error}</p>}
          {draftNote?.done && <p className="field-hint" role="status">{agent ? "已填入起草的内容，保存后才会生效。" : "已填入起草的内容，创建后才会生效。"}</p>}
          <p id={`${personaId}-hint`} className="field-hint">
            决定它是谁、怎么说话、擅长什么。只影响它如何回复，不授予任何权限。{!canDraft && "填写名称并选择模型后，可以让它帮你起草。"}留空时，它会先在会话里问你几个问题。
          </p>
        </div>
        <Field label="私聊回复方式" hint="“点名”就是在消息里 @ 它。">
          <Select value={f.replyMode} onChange={setValue("replyMode")} listLabel="私聊回复方式" options={REPLY_MODES.map(([id, label]) => ({ value: id, label }))} />
        </Field>
        <Field label="群里谁可以叫它" hint="被叫到时它会在群里回复，费用算你的。">
          <Select value={f.groupMentions} onChange={setValue("groupMentions")} listLabel="群里谁可以叫它" options={GROUP_MENTIONS.map(([id, label]) => ({ value: id, label }))} />
        </Field>
        <Field
          label="一次接话最多花费（点）"
          hint={BUDGET_HINTS.chain[webOffered ? "web" : "off"]}
          error={shown("chainBudget")}
        >
          {budgetBox("chainBudget")}
        </Field>
        {f.groupMentions === "members" && (
          <>
            <Field
              label="别人 @ 每天最多花"
              hint={BUDGET_HINTS.others[webOffered ? "web" : "off"]}
            >
              <Select
                value={f.othersChoice}
                onChange={setValue("othersChoice")}
                listLabel="别人 @ 每天最多花"
                options={[
                  { value: "default", label: `${OTHERS_BUDGET_DEFAULT} 点（默认）` },
                  { value: "custom", label: "自己填" },
                  { value: "unlimited", label: "不限" },
                ]}
              />
            </Field>
            {f.othersChoice === "custom" && (
              <Field label="每天最多花（点）" error={shown("othersAmount")}>
                {budgetBox("othersAmount")}
              </Field>
            )}
            {f.othersChoice === "unlimited" && <Notice tone="warn">群里任何人都能让它回复，花的是你的点。</Notice>}
          </>
        )}
        {(proactiveOffered || proactiveOffOnly) && (
          <>
            <div className="field">
              <Switch checked={f.proactive} onChange={setProactive} label="主动参与群聊" hint={proactiveOffered ? PROACTIVE_HELPER : PROACTIVE_LOST} hintClass="field-hint" />
            </div>
            {proactiveAsked && (
              <>
                <Field label="话多话少">
                  <Select value={f.proactiveLevel} onChange={setValue("proactiveLevel")} listLabel="话多话少" options={PROACTIVE_LEVELS.map(([id, label]) => ({ value: id, label }))} />
                </Field>
                <Field
                  label="主动回复每天最多花"
                  hint={BUDGET_HINTS.proactive[webOffered ? "web" : "off"]}
                  error={shown("proactiveBudget")}
                >
                  {budgetBox("proactiveBudget")}
                </Field>
              </>
            )}
          </>
        )}
        <div className="field">
          <Switch checked={f.whisperElsewhere} onChange={setSwitch("whisperElsewhere")} label={ELSEWHERE_LABEL} hint={ELSEWHERE_HELPER} hintClass="field-hint" />
        </div>
        {webOffered && (
          <div className="field">
            <Switch checked={f.webSearch} onChange={setSwitch("webSearch")} label={WEB_LABEL} hint={webHelper(state.webSearchPoints)} hintClass="field-hint" />
          </div>
        )}
        <fieldset className="form-section">
          <legend>称呼</legend>
          <Field label="它怎么称呼你" hint="最多 20 个字。只影响它怎么叫你，不影响它把谁当主人。" error={shown("ownerAppellation")}>
            <input value={f.ownerAppellation} onChange={set("ownerAppellation")} autoComplete="off" placeholder="留空就用你的名字" />
          </Field>
          {/* An Agent must exist to name others for it. */}
          {agent && <AgentAppellations agent={agent} />}
        </fieldset>
        <fieldset className="form-section">
          <legend>记忆</legend>
          <div className="field">
            <Switch checked={f.memory} onChange={setMemory} label="记忆" hint={MEMORY_HELPER} hintClass="field-hint" />
          </div>
          {editing && (
            <div className={askCatchUp ? "memory-catch-up" : undefined} ref={catchUpRef}>
              {/* Announced: the switch itself stays off until it is answered, so a screen reader is told the question. Its live region is
                  there all along, empty and unseen, and the question is put into it (one that arrives with its text inside is often not
                  announced); emptied again when the question closes. */}
              <p role="status" className={askCatchUp ? undefined : "sr-only"}>
                {askCatchUp ? CATCH_UP_QUESTION : ""}
              </p>
              {askCatchUp && (
                <>
                  {state.memoryCatchUp && <p className="field-hint">{catchUpBounds(state.memoryCatchUp)}</p>}
                  <div className="card-actions">
                    <Btn variant="primary" disabled={catchUp.busy !== null} onClick={() => answerCatchUp(false)}>
                      {catchUp.busy === "later" ? "处理中…" : "只记以后的"}
                    </Btn>
                    <Btn disabled={catchUp.busy !== null} onClick={() => answerCatchUp(true)}>
                      {catchUp.busy === "back" ? "处理中…" : "也回顾一下"}
                    </Btn>
                  </div>
                  {catchUp.refusal && (
                    <p className="field-msg" role="alert">
                      {catchUp.refusal}
                    </p>
                  )}
                </>
              )}
            </div>
          )}
          {/* A disabled fieldset turns off every switch inside it: with 记忆 off the other two do nothing. */}
          <fieldset className="memory-switches" disabled={!f.memory}>
            {MEMORY_SWITCHES.map(([key, label, hint]) => (
              <div className="field" key={key}>
                <Switch checked={f[key]} onChange={setSwitch(key)} label={label} hint={hint} hintClass="field-hint" />
              </div>
            ))}
          </fieldset>
        </fieldset>
        <Notice tone="info">
          {agent
            ? "修改从它的下一次回复起生效。"
            : "创建后会生成一个你和它的专属会话。它没有工具、文件或电脑权限。它会在专属会话里回复你；你也可以把它拉进你所在的群。"}
        </Notice>
        {refusal && refusal.code !== "handle_taken" && <Notice tone="warn">{limitText}</Notice>}
        <div className="form-actions">
          <Reason>{blockReason}</Reason>
          <Btn onClick={leave}>取消</Btn>
          <Btn variant="primary" type="submit" disabled={Boolean(blockReason) || busy !== null} reason={blockReason}>
            {busy === "save" ? (agent ? "保存中…" : "创建中…") : agent ? "保存" : "创建 Agent"}
          </Btn>
        </div>
      </form>
      {confirmDraft && (
        <Modal
          title="替换已写的人格文档？"
          onClose={() => setConfirmDraft(false)}
          footer={
            <>
              <Btn data-autofocus onClick={() => setConfirmDraft(false)}>取消</Btn>
              <Btn variant="primary" onClick={draft}>起草并替换</Btn>
            </>
          }
        >
          <p>起草的内容会替换人格文档里现有的文字。</p>
        </Modal>
      )}
      {confirmLeave && (
        <Modal
          title="放弃新头像？"
          onClose={() => setConfirmLeave(false)}
          footer={
            <>
              <Btn data-autofocus onClick={() => setConfirmLeave(false)}>继续编辑</Btn>
              <Btn variant="danger" onClick={back}>放弃</Btn>
            </>
          }
        >
          <p>头像还没有保存，确定放弃吗？</p>
        </Modal>
      )}
    </section>
  );
}
