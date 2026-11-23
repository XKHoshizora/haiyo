// Why an action was refused (friends, blocks, groups, search, my profile; Agents, replies, providers), in Chinese.
// Input: the route's ApiError ({code, status, reason, resetsAt, agents}) or the actions' error object of the same
// fields. Each route lists the codes the service documents for it (app/service/README.md); anything else is generic.

import { APPELLATION_WRONG } from "../auth/validation.js";

const GENERIC = "操作没有成功，请稍后再试。";

/** Codes any route can answer. */
const COMMON = {
  rate_limited: "操作太频繁了，请稍等一分钟再试。",
  busy: "服务现在有点忙，请稍后再试。",
  network_error: "连不上服务，请检查网络后重试。",
  invalid_request: "填写的内容有误，请检查后再试。",
};

const FRIENDS = {
  lookup: {
    not_found: "没有找到这个账号。",
    invalid_request: "账号名由 3–24 位小写字母、数字或下划线组成。",
  },
  sendRequest: {
    not_found: "没有找到这个账号。",
    invalid_request: "不能添加自己为好友。",
    blocked: "你们之间存在拉黑，无法发送好友申请。",
    already_friends: "你们已经是好友了。",
    request_pending: "你们之间已有一条待处理的申请。",
  },
  accept: {
    not_found: "这条申请已经不存在了。",
    request_not_pending: "这条申请已经处理过了。",
    request_expired: "这条申请已过期，请让对方重新发送。",
    blocked: "你们之间存在拉黑，无法同意这条申请。",
  },
  reject: {
    not_found: "这条申请已经不存在了。",
    request_not_pending: "这条申请已经处理过了。",
    request_expired: "这条申请已过期。",
  },
  withdraw: {
    not_found: "这条申请已经不存在了。",
    request_not_pending: "这条申请已经处理过了。",
    request_expired: "这条申请已过期。",
  },
  unfriend: {
    not_found: "你们已经不是好友了。",
  },
  block: {
    invalid_request: "不能拉黑自己。",
    not_found: "找不到这个用户。",
  },
  unblock: {},
};

const GROUPS = {
  create: {
    invalid_request: "群名称需要 1–60 个字，并至少选择 2 位好友。",
    forbidden: "没能创建群聊：有人已不是你的好友、与你存在拉黑，或群成员超过 500 人。",
  },
  rename: {
    forbidden: "只有群的创建者可以修改群名称。",
    not_found: "你已不在这个群聊中。",
    invalid_request: "群名称需要 1–60 个字，且只能一行。",
  },
  add: {
    not_found: "你已不在这个群聊中。",
    already_member: "对方已经在群里了。",
    forbidden: "没能添加：对方已不是你的好友、与你存在拉黑，或本群已满 500 人。",
  },
  // The avatar of a group (upload and removal): the creator only.
  avatar: {
    forbidden: "只有群的创建者可以修改群头像。",
    not_found: "你已不在这个群聊中。",
    invalid_request: "头像需要是 PNG、JPEG 或 WebP 格式的图片。",
    too_large: "头像不能超过 2 MB。",
    rate_limited: "头像改得太频繁了，请稍等一分钟再试。",
  },
  remove: {
    forbidden: "只有群的创建者可以移除成员。",
    not_found: "这位成员已经不在群里了。",
  },
  leave: {
    not_found: "你已不在这个群聊中。",
  },
  // The same routes when the member is one of my Agents (batch 2C): no friendship is involved.
  addAgent: {
    not_found: "你已不在这个群聊中。",
    already_member: "它已经在群里了。",
    forbidden: "没能添加：这个 Agent 可能已删除，或本群已满 500 人。",
  },
  removeAgent: {
    forbidden: "只有群的创建者和它的主人可以把它移出群聊。",
    not_found: "它已经不在群里了。",
  },
};

const pick = (table, action, error) => {
  const code = error?.code;
  return table[action]?.[code] ?? COMMON[code] ?? GENERIC;
};

/** For a route that has no codes of its own (loading a list): the shared sentences, else the generic one. */
export const commonErrorText = (error) => pick({}, null, error);

const WHISPER = {
  answer: {
    stale_whisper: "这条悄悄话已经处理过了。",
    not_found: "这条悄悄话已经不在了。",
    // 告诉他们 refused for the reply it would start (README "Whispers": as the owner's retry); the whisper stays open.
    busy_run: "它正在回复，说完再点。",
    agent_paused: "这个 Agent 已暂停，恢复后才能重试。",
    invalid_request: "这个 Agent 还没有选择模型。",
    rate_limited: "回复太频繁了，请稍等一分钟再试。",
  },
};
/** Why my answer to a whisper (告诉他们, 不用) was refused. */
export const whisperErrorText = (error) => pick(WHISPER, "answer", error);

/**
 * Why an Agent social action was refused (adding an Agent, an owner's decision, a message or a card answer): the codes of the routes of
 * app/service/README.md "Agent social", for every action alike. `cooldown` says the day it may be tried again (`availableAt`).
 */
const SOCIAL_CODES = {
  is_yours: "这是你自己的 Agent。",
  not_requested: "这个申请已经处理过了。",
  no_access: "你已不能再和它聊天。",
  agent_unavailable: "这个 Agent 现在不可用。",
  answered: "这件事已经回答过了。",
  expired: "这张卡片已经过期了。",
};
export function socialErrorText(error) {
  if (error?.code === "cooldown") {
    const day = dayText(error.availableAt);
    return day ? `现在还不能再申请，${day} 以后可以。` : "现在还不能再申请，稍后再试。";
  }
  return SOCIAL_CODES[error?.code] ?? COMMON[error?.code] ?? GENERIC;
}

/** action: lookup | sendRequest | accept | reject | withdraw | unfriend | block | unblock */
export const friendErrorText = (action, error) => pick(FRIENDS, action, error);
/** action: create | rename | avatar | add | remove | leave, and addAgent | removeAgent (the member is an Agent) */
export const groupErrorText = (action, error) => pick(GROUPS, action, error);

const SEARCH = {
  search: {
    rate_limited: "搜索太频繁了，请稍等一会儿再试。",
    not_found: "你已不在这个会话中。",
  },
};
/** Why a message search did not answer: a quiet one-line note beside a retry button. */
export const searchErrorText = (error) => pick(SEARCH, "search", error);

/**
 * The first local day on which instant `iso` has passed, as the settings page shows it ("2027年11月21日"): the day itself
 * when it is that day's midnight, else the next one — so a change tried on the day shown is never refused for the hour.
 * The one helper for when the account name may change again (the hint and the refusal). Null for what is not a time.
 */
export function dayText(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const at = new Date(ms);
  const midnight = new Date(at.getFullYear(), at.getMonth(), at.getDate());
  const day = midnight.getTime() === ms ? midnight : new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1);
  return `${day.getFullYear()}年${day.getMonth() + 1}月${day.getDate()}日`;
}

const PROFILE = {
  name: {
    invalid_request: "昵称需要 1–40 个字，且只能一行。",
  },
  handle: {
    handle_taken: "这个名字已经有人用了",
    invalid_request: "账号名为 3 到 24 位小写字母、数字或下划线",
  },
  avatar: {
    invalid_request: "头像需要是 PNG、JPEG 或 WebP 格式的图片。",
    too_large: "头像不能超过 2 MB。",
  },
};
/** action: name | handle | avatar */
export function profileErrorText(action, error) {
  if (action === "handle" && error?.code === "handle_change_too_soon") {
    const day = dayText(error.availableAt);
    return day ? `离上次改名还不到一年，${day}起可以再改` : "离上次改名还不到一年，暂时不能再改";
  }
  return pick(PROFILE, action, error);
}

// ───────── Agents, replies, providers (batch 2A)

const pad = (n) => String(n).padStart(2, "0");

/** When the free allowance comes back, in local time: "今天 16:00", "明天 00:00", else "11月20日 08:05". */
function resetTimeText(resetsAt, now) {
  const ms = Date.parse(resetsAt);
  if (!Number.isFinite(ms)) return null;
  const at = new Date(ms);
  const day = new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
  const n = new Date(now);
  const today = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
  const tomorrow = new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1).getTime();
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  if (day === today) return `今天 ${time}`;
  if (day === tomorrow) return `明天 ${time}`;
  return `${at.getMonth() + 1}月${at.getDate()}日 ${time}`;
}

/**
 * Why a site-model call could not start (`no_quota`): the free allowance and the balance are both used up (a free-tier
 * model; `resetsAt` says when the allowance comes back), or there is no balance (a paid-tier model).
 * @param {{reason?: string|null, resetsAt?: string|null}} details the error's (an HTTP 402) or the run's
 */
export function noQuotaText(details, now = Date.now()) {
  const free = details?.reason === "free_and_balance" || (details?.reason !== "balance" && Boolean(details?.resetsAt));
  if (!free) return "余额不足：这个模型需要余额才能使用。";
  const when = details?.resetsAt ? resetTimeText(details.resetsAt, now) : null;
  if (!when) return "今天的免费额度和余额都已用完，免费额度会在每天零点重置。";
  // A date (it starts with a digit) is set apart from the words before it, as a time is.
  return `今天的免费额度和余额都已用完，免费额度将在${/^\d/.test(when) ? " " : ""}${when} 重置。`;
}

const AGENT_DELETED = "这个 Agent 已删除。";
const AGENT_NOT_FOUND = "找不到这个 Agent。";
const PROACTIVE_UNAVAILABLE = "现在还不能打开主动参与：站点没有配置判断模型。";
const MODEL_FAILED = {
  provider_rejected: "供应商拒绝了这个密钥，请检查密钥是否正确。",
  provider_unavailable: "暂时连不上供应商，或它没有给出可用的回答，请稍后再试。",
  address_not_allowed: "这个接口地址不被允许：需要是 https 开头的公网地址。",
};

const MEMORY_CHANGE = {
  stale_change: "这条改动已经过时了：记忆后来又变过。",
  agent_deleted: AGENT_DELETED,
  not_found: "这条记忆变更已经不存在了。",
};

/** The sentence of a 409 `room_full` that refused for the number of notes (`max`: the room's limit, when the page knows it). */
export const roomCountFullText = (max) =>
  Number.isFinite(max) && max > 0 ? `这个房间的笔记条数到上限了（最多 ${max} 条），先删掉或合并几条。` : MEMORY_NOTE.room_full;

// A note of the memory palace (add, edit, lock, delete, confirm what it heard): the room is full, or the text cannot be remembered.
const MEMORY_NOTE = {
  room_full: "这个房间装不下了，先删掉或合并几条。",
  note_refused: "这条内容不能记：看起来像指令、链接或密钥。",
  agent_deleted: AGENT_DELETED,
  not_found: "这条已经不存在了，已刷新。",
};

const AGENT = {
  create: {
    handle_taken: "你已经有一个用这个账号名的 Agent 了，请换一个。",
    agent_limit: "你的 Agent 数量已达到当前档位的上限。",
    proactive_unavailable: PROACTIVE_UNAVAILABLE,
    invalid_request: "填写的内容有误：账号名需 2–24 位小写字母、数字或下划线，名称 1–20 个字；所选模型或思考程度也可能不可用。",
  },
  edit: {
    agent_deleted: AGENT_DELETED,
    not_found: AGENT_NOT_FOUND,
    proactive_unavailable: PROACTIVE_UNAVAILABLE,
    invalid_request: "填写的内容有误，或所选模型、思考程度不可用。",
  },
  // The Agent's appellations of others (a 404 of a setting is the target, who cannot be named now: not a friend nor in a
  // group it is in; a removal's 404 is no refusal, actions.js `removeAppellation` takes it as done).
  appellation: {
    invalid_request: APPELLATION_WRONG,
    not_found: "现在不能给这个人设称呼：对方需要是你的好友，或者和它在同一个群里。",
    too_many: "一个 Agent 最多设 100 个称呼。",
    agent_deleted: AGENT_DELETED,
  },
  pause: { agent_deleted: AGENT_DELETED, not_found: AGENT_NOT_FOUND },
  resume: { agent_deleted: AGENT_DELETED, not_found: AGENT_NOT_FOUND },
  delete: { not_found: AGENT_NOT_FOUND },
  avatar: {
    invalid_request: "头像需要是 PNG、JPEG 或 WebP 格式的图片。",
    too_large: "头像不能超过 2 MB。",
    agent_deleted: AGENT_DELETED,
    not_found: AGENT_NOT_FOUND,
  },
  draft: {
    ...MODEL_FAILED,
    invalid_request: "所选模型不可用，请换一个模型。",
    context_too_small: "所选模型的上下文太小，放不下起草所需的内容，请换一个模型。",
    thinking_exhausted: "模型把输出额度都用在了思考上，没有写出内容。可以再试一次，或把思考程度调低。",
    rate_limited: "起草太频繁，或正在进行的回复太多，请稍后再试。",
  },
  confirm: {
    stale_proposal: "这份提议已失效，请让它重新生成提议。",
    agent_deleted: AGENT_DELETED,
    not_found: "这份提议已经不存在了。",
    invalid_request: "人格文档需要 1–20000 个字，简介不超过 40 个字，擅长领域不超过 20 个字。",
  },
  discard: {
    stale_proposal: "这份提议已失效，请让它重新生成提议。",
    agent_deleted: AGENT_DELETED,
    not_found: "这份提议已经不存在了。",
  },
  // A memory change (the chip's 撤销, the cards' 记住 / 取出 / 不用): stale is worded as a proposal's.
  memoryUndo: MEMORY_CHANGE,
  memoryConfirm: MEMORY_CHANGE,
  memoryDiscard: MEMORY_CHANGE,
  memoryNote: MEMORY_NOTE,
};

/**
 * Why an Agent action was refused. action: create | edit | appellation | pause | resume | delete | avatar | draft | confirm | discard | memoryUndo | memoryConfirm | memoryDiscard | memoryNote.
 * `now` places a `no_quota` reset time.
 */
export function agentErrorText(action, error, now = Date.now()) {
  if (error?.code === "no_quota" && action in AGENT) return noQuotaText(error, now);
  return pick(AGENT, action, error);
}

// A 404 on a conversation's reply routes: not mine, not an Agent's conversation, or a run of another conversation.
const NOT_FOUND = "找不到要操作的内容，它可能已经不存在了。";
const REPLY = {
  stop: {
    not_found: NOT_FOUND,
    // Not the service's: nothing was queued or running here, so nothing was sent.
    no_run: "现在没有正在进行的回复。",
  },
  retry: {
    busy_run: "它正在回复，请等这次回复结束。",
    agent_paused: "这个 Agent 已暂停，恢复后才能重试。",
    agent_deleted: AGENT_DELETED,
    invalid_request: "现在没有可以重试的回复，或这个 Agent 还没有选择模型。",
    not_found: NOT_FOUND,
    rate_limited: "回复太频繁了，请稍等一分钟再试。",
    // A told reply (告诉他们) whose whisper no longer reads open: said as the whisper itself says it.
    stale_whisper: "这条悄悄话已经处理过了。",
  },
  dismiss: { not_found: NOT_FOUND },
  topic: {
    cannot_send: "这个 Agent 已删除，不能再开始新话题。",
    not_found: NOT_FOUND,
  },
  // 让 Agent 停下 in a group (batch 2C)
  halt: {
    not_found: "你已不在这个群聊中。",
    forbidden: "只有群里的人可以让 Agent 停下。",
    rate_limited: "叫停太频繁了，请稍等一会儿再试。",
  },
};
/** Why a reply action was refused. action: stop | retry | dismiss | topic | halt */
export const replyErrorText = (action, error) => pick(REPLY, action, error);

const PROVIDER_NOT_FOUND = "找不到这个供应商。";
/** A call to my provider: as for any model call, except that a saved key that can no longer be opened reads as refused too. */
const PROVIDER_CALL = {
  ...MODEL_FAILED,
  provider_rejected: "供应商拒绝了这个密钥，或已保存的密钥无法再使用。请重新填写密钥并保存，然后再试。",
  not_found: PROVIDER_NOT_FOUND,
};
const PROVIDER = {
  create: {
    provider_limit: "最多只能添加 10 个模型供应商。",
    name_taken: "你已经有一个同名的供应商了，请换个名称。",
    invalid_request: "填写的内容有误：请检查名称、https 接口地址和密钥。",
  },
  edit: {
    name_taken: "你已经有一个同名的供应商了，请换个名称。",
    not_found: PROVIDER_NOT_FOUND,
    invalid_request: "填写的内容有误。换到另一个地址时，需要同时重新填写密钥。",
  },
  delete: { not_found: PROVIDER_NOT_FOUND },
  test: PROVIDER_CALL,
  list: PROVIDER_CALL,
};
/** The provider calls whose answer can carry the provider's own HTTP status. */
const WITH_STATUS = new Set(["test", "list"]);
/** 测试连接 with one of the provider's models (batch 2C): as a call to it, and the model may be gone from its list meanwhile. */
const PROVIDER_CHAT = {
  ...PROVIDER_CALL,
  invalid_request: "这个模型已经不在供应商的模型列表里了，请刷新页面后再试。",
};

/**
 * Why a provider action was refused. action: create | edit | delete | test | list (同步模型's model list). For `test` and
 * `list`, `error.upstreamStatus` (the provider's HTTP status, a string) is added to the sentence; a 404 or 405 means the
 * provider has no model list there.
 */
export function providerErrorText(action, error) {
  // 测试连接 with a model (`chat`): a real call to it, so a 404 there is no missing model list, only a status.
  if (action === "chat") {
    const text = pick({ chat: PROVIDER_CHAT }, "chat", error);
    return /^\d{3}$/.test(error?.upstreamStatus ?? "") ? `${text}（供应商返回的状态码：${error.upstreamStatus}）` : text;
  }
  if (error?.code === "provider_in_use" && action in PROVIDER) {
    const names = Array.isArray(error.agents) ? error.agents.map((a) => a?.name).filter(Boolean) : [];
    return names.length > 0
      ? `还有 Agent 在使用这个供应商：${names.join("、")}。请先给它们换一个模型。`
      : "还有 Agent 在使用这个供应商，请先给它们换一个模型。";
  }
  const text = pick(PROVIDER, action, error);
  // The sentence only ever names a status number; what else the provider said is shown apart, as 详情 (the `detail` of the answer, Providers.jsx).
  const status = WITH_STATUS.has(action) && /^\d{3}$/.test(error?.upstreamStatus ?? "") ? error.upstreamStatus : null;
  if (!status) return text;
  if (error.code === "provider_unavailable" && (status === "404" || status === "405")) {
    return `这个供应商没有提供模型列表（状态码 ${status}），所以没能确认密钥是否可用。对话可能仍然可以使用，模型名称需要手动添加。`;
  }
  return `${text}（供应商返回的状态码：${status}）`;
}

/**
 * The one wording of my Agent whose model is not there to call any more (the service's `modelUsable: false`; a reply then
 * fails `model_gone`): `tag` on its status tag and its model picker's button, `action` on what opens where its model is
 * chosen, `sentence` where a sentence is needed (its page's 模型 row, that reply's status line).
 */
export const MODEL_GONE = Object.freeze({ tag: "模型不可用", action: "换一个模型", sentence: "这个模型不可用，换一个模型。" });

const RUN_FAILED = {
  provider_rejected: "供应商拒绝了密钥，这次没有回复。请到设置里检查密钥。",
  provider_unavailable: "暂时连不上模型服务，这次没有回复。可以重试。",
  address_not_allowed: "模型的接口地址不被允许，这次没有回复。请到设置里检查地址。",
  context_too_small: "人格文档太长或模型的上下文太小，放不下你的消息。请缩短人格文档或换一个模型。",
  thinking_exhausted: "模型把这次的输出额度都用在了思考上，没有写出回答。可以重试，或把思考程度调低。",
  busy: "服务出了点问题，这次没有回复，也没有扣费。可以重试。",
  rate_limited: "发得太快了，请稍后重试。",
  agent_paused: "它已暂停，这次没有回复。",
  agent_deleted: "它已删除，这次没有回复。",
  // Its model is not there to call any more (off its provider's list, no longer on the site): only another one helps.
  model_gone: MODEL_GONE.sentence,
};
/** How a reply in a group ends that is not a failure of the owner's to fix: neither is retried (batch 2C). */
const RUN_ENDED_IN_GROUP = {
  halted: "已被群成员叫停。",
  agent_removed: "它已不在这个群里，这条回复没有发出。",
};
/** A site model's key and address are the site's: the owner can only wait or choose another model. */
const SITE_MODEL_FAILED = "站点提供的这个模型暂时用不了，请稍后重试，或换一个模型。";
const SITE_MODEL_CODES = ["provider_rejected", "provider_unavailable", "address_not_allowed"];
const RUN_CANCELLED = {
  agent_paused: "它已暂停，这次回复已取消。",
  agent_deleted: "它已删除，这次回复已取消。",
};

/**
 * The status line of a reply that failed or was cancelled (`Run`): why, in Chinese; "" when nothing went wrong (done,
 * stopped, running, or cancelled with no reason: a new topic left it nothing to answer, or the Agent's others' daily
 * budget was spent by the time a reply someone else called for was to start). `source` is where the Agent's model
 * comes from ("site" | "provider"; unknown: as for a provider): a site model's key or address is not the owner's to fix.
 */
export function runFailureText(run, now = Date.now(), source = null) {
  if (!run) return "";
  if ((run.status === "failed" || run.status === "cancelled") && Object.hasOwn(RUN_ENDED_IN_GROUP, run.error ?? "")) return RUN_ENDED_IN_GROUP[run.error];
  if (run.status === "failed") {
    if (run.error === "no_quota") return noQuotaText({ resetsAt: run.resetsAt ?? null }, now);
    if (source === "site" && SITE_MODEL_CODES.includes(run.error)) return SITE_MODEL_FAILED;
    return RUN_FAILED[run.error] ?? "这次没有回复成功。";
  }
  if (run.status === "cancelled") return RUN_CANCELLED[run.error] ?? "";
  return "";
}
