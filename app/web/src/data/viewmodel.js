// Model → the state shape the prototype's pages and selectors read (people, agents, convs, order,
// relations, blocks). The signed-in user appears as the alias id "me"; every other id is the real one.
// Every avatar URL carries its principal's version (`avatarUrl(id, version)`), so a changed avatar shows at once.
import { attachmentUrl, avatarUrl } from "../api/routes.js";
import { ME } from "./identities.js";
import { mentionsIn } from "./mentions.js";
import { ownsAgent } from "./model.js";

const pad = (n) => String(n).padStart(2, "0");

/** The prototype's time labels: today "HH:MM", yesterday "昨天", this year "M月D日", else "YYYY/M/D". */
export function formatAt(ms, now) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const n = new Date(now);
  const today = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
  const yesterday = new Date(n.getFullYear(), n.getMonth(), n.getDate() - 1).getTime();
  if (ms >= today) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (ms >= yesterday) return "昨天";
  if (d.getFullYear() === n.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
const clock = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/**
 * A message bubble's time, local, 24-hour, no seconds: today "23:05", yesterday "昨天 23:05", this year
 * "11月15日 23:05", an earlier year "2025年11月15日 23:05". (The conversation list keeps `formatAt`.)
 */
export function formatMessageAt(ms, now) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const n = new Date(now);
  const today = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
  const yesterday = new Date(n.getFullYear(), n.getMonth(), n.getDate() - 1).getTime();
  if (ms >= today) return clock(d);
  if (ms >= yesterday) return `昨天 ${clock(d)}`;
  const day = `${d.getMonth() + 1}月${d.getDate()}日 ${clock(d)}`;
  return d.getFullYear() === n.getFullYear() ? day : `${d.getFullYear()}年${day}`;
}

/** A message bubble's tooltip, the full form: "2026年11月17日 星期二 23:05". */
export function formatMessageTitle(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "";
  const d = new Date(ms);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 星期${WEEKDAYS[d.getDay()]} ${clock(d)}`;
}

const timeOf = (iso) => {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
};

function quoteView(replyTo, alias) {
  if (!replyTo) return null;
  if (!replyTo.visible) return { seq: replyTo.seq, visible: false };
  return {
    seq: replyTo.seq,
    visible: true,
    from: alias(replyTo.senderId),
    text: replyTo.text ?? "",
    kind: replyTo.kind ?? "text",
    attachmentName: replyTo.attachmentName ?? null,
    // Whether a person or an Agent wrote it, as the service says (also for an Agent no longer held here).
    senderKind: replyTo.senderKind === "agent" || replyTo.senderKind === "human" ? replyTo.senderKind : null,
  };
}

function attachmentView(a) {
  return a ? { id: a.id, name: a.name, size: a.size, inline: Boolean(a.inline), url: attachmentUrl(a.id) } : null;
}

function systemView(system, alias) {
  if (!system) return null;
  const out = { ...system };
  for (const key of ["actorId", "principalId", "newCreatorId"]) if (typeof out[key] === "string") out[key] = alias(out[key]);
  if (Array.isArray(out.memberIds)) out.memberIds = out.memberIds.map(alias);
  if (out.event === "memory_changed") return memoryChangeView(out);
  return out;
}

const MEMORY_STATUSES = new Set(["applied", "undone", "pending", "discarded", "expired"]);

/**
 * A `memory_changed` event as the chip and the cards read it: `lines` (strings only), `vaultLines` and `sourceLines` (which lines are
 * notes a merge joined) the same length (absent or malformed: all false), the three flags as booleans, and a known `status` (else the
 * flag `pending` says it); `phase` "rest" (absent or unknown) or "dream"; `count` the number the sentence says (absent: the number of lines).
 */
function memoryChangeView(event) {
  const lines = Array.isArray(event.lines) ? event.lines.filter((l) => typeof l === "string") : [];
  // One mark per kept line; an array of marks of another length is not trusted.
  const marks = (list) => {
    const trusted = Array.isArray(list) && list.length === event.lines?.length;
    return (Array.isArray(event.lines) ? event.lines : []).flatMap((l, i) => (typeof l === "string" ? [trusted && list[i] === true] : []));
  };
  const pending = event.pending === true;
  return {
    ...event,
    lines,
    vaultLines: marks(event.vaultLines),
    sourceLines: marks(event.sourceLines),
    pending,
    unlock: event.unlock === true,
    full: event.full === true,
    phase: event.phase === "dream" ? "dream" : "rest",
    count: Number.isInteger(event.count) && event.count >= 0 ? event.count : lines.length,
    status: MEMORY_STATUSES.has(event.status) ? event.status : pending ? "pending" : "applied",
  };
}

/** How many invited members `group_created` names before "等N人" (as the service writes it). */
const LISTED_NAMES = 10;
const CANNOT_SEND_ANY_MORE = "双方不能再发送新消息，已有历史不受影响";

/**
 * A system notice's sentence, rendered from its event (`system`, ids aliased) with the names known now ("你"
 * for me) in the service's wording. The service's own sentence (`fallback`, names of that moment) is shown for
 * a malformed event, or when someone it names is not known here; an event this client does not know is null (the
 * notice shows nothing).
 * @param {(id: string) => string | null} nameOf
 * @param {{agentId?: string | null}} [where] the conversation's Agent, for a notice that names it (`topic_reset`)
 */
export function noticeText(system, fallback, nameOf, where = {}) {
  if (!system || typeof system.event !== "string") return fallback;
  let missing = false;
  const n = (id) => {
    const name = typeof id === "string" ? nameOf(id) : null;
    if (!name) missing = true;
    return name ?? "";
  };
  const title = typeof system.title === "string" && system.title ? system.title : null;
  let text;
  switch (system.event) {
    case "group_created": {
      if (!title || !Array.isArray(system.memberIds)) return fallback;
      const listed = system.memberIds.slice(0, LISTED_NAMES).map(n).join("、");
      const more = system.memberIds.length > LISTED_NAMES ? `等${system.memberIds.length}人` : "";
      text = `${n(system.actorId)}创建了群聊「${title}」，并邀请${listed}${more}加入`;
      break;
    }
    case "member_joined":
      text = `${n(system.actorId)}邀请${n(system.principalId)}加入了群聊`;
      break;
    case "member_left":
      text = `${n(system.principalId)}退出了群聊${system.newCreatorId ? `，${n(system.newCreatorId)}成为新的创建者` : ""}`;
      break;
    case "member_removed":
      text = `${n(system.actorId)}将${n(system.principalId)}移出了群聊`;
      break;
    case "group_renamed":
      if (!title) return fallback;
      text = `${n(system.actorId)}将群名改为「${title}」`;
      break;
    case "friendship_ended":
      text = `${n(system.actorId)}解除了与${n(system.principalId)}的好友关系，${CANNOT_SEND_ANY_MORE}`;
      break;
    case "friendship_restored":
      text = `${n(system.actorId)}和${n(system.principalId)}重新成为好友，可以继续发送消息`;
      break;
    case "blocked":
      // "只能由对方解除" is said to the one who was blocked; the one who blocked can lift it themselves.
      text =
        system.actorId === ME
          ? `${n(system.actorId)}拉黑了${n(system.principalId)}。${CANNOT_SEND_ANY_MORE}`
          : `${n(system.actorId)}拉黑了${n(system.principalId)}，只能由对方解除。${CANNOT_SEND_ANY_MORE}`;
      break;
    case "unblocked":
      text = `${n(system.actorId)}解除了对${n(system.principalId)}的拉黑`;
      break;
    case "memory_changed":
      // Only the owner's own conversation with the Agent shows it (the chip), never a group; the lines travel in the event.
      if (!where.agentId || !Array.isArray(system.lines)) return null;
      text = "记忆已更新";
      break;
    case "topic_reset":
      if (!where.agentId) return fallback;
      text = `${n(system.actorId)}开始了新话题，之前的对话不再发给${n(where.agentId)}`;
      break;
    // Agents talking to each other in a group (batch 2C): the sentences of the wire contract.
    case "agent_chain_paused":
      if (!Number.isSafeInteger(system.limit) || system.limit < 1) return fallback;
      text = `Agent 已连续对话 ${system.limit} 条，已暂停互相接话，有人发言后继续。`;
      break;
    case "agents_halted":
      text = `${n(system.actorId)}让 Agent 停止了接话`;
      break;
    case "agent_budget_reached":
      text = `${n(system.agentId)}已达到本次接话的点数上限，有人发言后继续。`;
      break;
    case "agent_daily_budget_reached":
      text = `「${n(system.agentId)}」今天的额度已用完`;
      break;
    case "agent_quieted":
      text = `「${n(system.agentId)}」暂时不主动发言，需要时可以 @ 它`;
      break;
    default:
      return null;
  }
  return missing ? fallback : text;
}

/**
 * Whether a message names the Agent `agentId` (its stored mentions, `msg.mentions`, decided by the service when it was
 * sent: a mention picked from the @ list, or one typed and read there once): the service's rule for a message in the
 * Agent's own conversation when its reply mode is 仅在我点名时回复. The text is never read for it.
 */
export function namesAgent(msg, agentId) {
  return Array.isArray(msg?.mentions) && msg.mentions.some((m) => m.id === agentId);
}

/**
 * Points (a decimal string from the service) for display: digits grouped in threes, every digit of the string kept
 * (no float maths, no rounding), trailing zeros after the point trimmed. What is not a decimal string is shown as it is.
 */
export function formatPoints(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  const parts = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!parts) return text;
  const [, sign, whole, decimals = ""] = parts;
  const fraction = decimals.replace(/0+$/, "");
  const zero = /^0+$/.test(whole) && fraction === "";
  return `${sign && !zero ? "-" : ""}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${fraction ? `.${fraction}` : ""}`;
}

/**
 * What one reply cost (`via.points`, a decimal string of points from the service), for the line under it: at most 4
 * decimals, rounded half up on the string's own digits (no float maths), trailing zeros trimmed, digits grouped
 * (`formatPoints`); "" for anything that is not a non-negative decimal string.
 */
export function replyPoints(value) {
  const micro = microPoints(value);
  if (micro === null) return "";
  // In ten-thousandths, rounded half up on the fifth decimal.
  const digits = ((micro + 50n) / 100n).toString().padStart(5, "0");
  return formatPoints(`${digits.slice(0, -4)}.${digits.slice(-4)}`);
}

/**
 * A decimal string of points in micro-points (its first six decimals, no float maths), or null when it is not a
 * non-negative decimal string.
 */
function microPoints(value) {
  const parts = typeof value === "string" ? /^(\d+)(?:\.(\d+))?$/.exec(value) : null;
  if (!parts) return null;
  const [, whole, decimals = ""] = parts;
  return BigInt(whole + (decimals + "000000").slice(0, 6));
}

/** Whether `spent` has reached `budget` (both decimal strings of points), compared on the digits (no float maths). */
export function pointsReached(spent, budget) {
  const a = microPoints(spent);
  const b = microPoints(budget);
  return a !== null && b !== null && a >= b;
}

const VIA_LEVELS = new Set(["none", "low", "medium", "high", "xhigh", "max"]);
const isText = (v) => typeof v === "string" && v.length > 0;

/**
 * A reply's `via` as the service sends it to the Agent's owner (which model and level its run used, what it cost), or
 * null when it is not exactly that shape: `{model: {source: "site", id, label} | {source: "provider", model}, reasoning,
 * points, proactive?: true}`.
 */
function viaView(via) {
  if (!via || typeof via !== "object" || !VIA_LEVELS.has(via.reasoning) || typeof via.points !== "string") return null;
  const m = via.model;
  let model = null;
  if (m?.source === "site" && isText(m.id) && isText(m.label)) model = { source: "site", id: m.id, label: m.label };
  else if (m?.source === "provider" && isText(m.model)) model = { source: "provider", model: m.model };
  if (!model) return null;
  // `proactive` is there only when the reply was spoken unasked; anything but `true` is no key.
  return { model, reasoning: via.reasoning, points: via.points, ...(via.proactive === true ? { proactive: true } : {}) };
}

const LOOKUP_KINDS = ["search", "file", "time"];
const isCountAbove0 = (n) => Number.isSafeInteger(n) && n > 0;

/** A reply's `lookups` (how many calls of each kind its tools ran), only the counts that are whole numbers above 0; null when none is. */
function lookupsView(lookups) {
  if (!lookups || typeof lookups !== "object") return null;
  const out = {};
  for (const kind of LOOKUP_KINDS) if (Object.hasOwn(lookups, kind) && isCountAbove0(lookups[kind])) out[kind] = lookups[kind];
  return Object.keys(out).length > 0 ? out : null;
}

/** A reply's `found` (the messages its tools found that I can see), as {conversationId, seq}; [] for anything else. */
function foundView(found) {
  if (!Array.isArray(found)) return [];
  return found.filter((f) => f && typeof f.conversationId === "string" && isCountAbove0(f.seq)).map((f) => ({ conversationId: f.conversationId, seq: f.seq }));
}

/** The numbers of a citation as a reply writes it (〔m3〕). */
const CITE_NUMBER = /^m[1-9][0-9]{0,5}$/;

/**
 * A reply's `cites` (of what its text cites, the messages I can see, by number) as `{m3: {conversationId, seq}}`; null
 * when there is none. A number it does not name is plain text in the reply.
 */
function citesView(cites) {
  if (!cites || typeof cites !== "object" || Array.isArray(cites)) return null;
  const out = {};
  for (const [n, at] of Object.entries(cites)) {
    if (CITE_NUMBER.test(n) && at && typeof at.conversationId === "string" && isCountAbove0(at.seq)) out[n] = { conversationId: at.conversationId, seq: at.seq };
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * The quiet line under a reply that looked things up: 查了 n 次聊天记录 and 看了 n 个文件, joined with ，; time lookups are
 * never in it. Null when there is nothing to say (no lookups, or only at the time).
 */
export function lookupLine(lookups) {
  const parts = [];
  if (lookups?.search > 0) parts.push(`查了 ${lookups.search} 次聊天记录`);
  if (lookups?.file > 0) parts.push(`看了 ${lookups.file} 个文件`);
  return parts.length > 0 ? parts.join("，") : null;
}

/** A byte count for people: "932 B", "1.4 KB", "12 MB" (one decimal below 10, base 1024). */
export function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = unit === 0 || value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
  return `${text} ${units[unit]}`;
}

/** kind: "image" for a file the service marked inline, "file", "system", else "text". */
function kindOf(kind, attachment) {
  if (kind === "system") return "system";
  if (attachment) return attachment.inline ? "image" : "file";
  return "text";
}

/**
 * The line under my message some of whose calls on other people's Agents my own calls a minute stopped (`agentIds`):
 * their names joined with 、 in 「」, or 有的 Agent (no 「」: they are for real names) while a name is not known.
 */
function notCalledText(agentIds, nameOf) {
  const names = agentIds.map(nameOf);
  const who = names.every((name) => typeof name === "string" && name !== "") ? `「${names.join("、")}」` : "有的 Agent ";
  return `你 @ 得太频繁了，${who}这次没有收到，稍后再试。`;
}

function messageView(m, { alias, meId, pair, peerReadSeq, now, nameOf, agentId, keepsOwners }) {
  const attachment = m.kind === "file" ? attachmentView(m.attachment) : null;
  const kind = kindOf(m.kind, attachment);
  const system = systemView(m.system, alias);
  let text = m.text ?? "";
  let hidden = false;
  // As in the prototype, a file or image message's `text` is its file name; the caption is separate.
  if (attachment) text = attachment.name;
  else if (kind === "system") {
    // A notice of an event this client does not know shows nothing (it stays in the list, so seqs and reads are kept).
    const said = noticeText(system, text, nameOf, { agentId });
    hidden = said === null;
    text = said ?? "";
  }
  const view = {
    id: `m${m.seq}`,
    seq: m.seq,
    from: m.senderId === null || m.senderId === undefined ? null : alias(m.senderId),
    kind,
    text,
    caption: attachment ? m.text ?? "" : null,
    at: formatMessageAt(timeOf(m.createdAt), now),
    atTitle: formatMessageTitle(timeOf(m.createdAt)),
    createdAt: m.createdAt,
    // Read by the other side: the peer of a direct chat, or the Agent of its conversation.
    status: m.senderId === meId && pair && peerReadSeq !== null && m.seq <= peerReadSeq ? "read" : "sent",
    replyTo: m.replyTo ? `m${m.replyTo.seq}` : null,
    quote: quoteView(m.replyTo, alias),
    attachment,
    system,
    // An Agent's reply: its reasoning (shown folded) and which model and level it used (`via`), only when it is mine
    // to read (`keepsOwners`); whether it was stopped or cut, and the persona it proposes.
    reasoning: typeof m.reasoning === "string" && m.reasoning && keepsOwners(m.senderId) ? m.reasoning : null,
    via: m.via !== undefined && keepsOwners(m.senderId) ? viaView(m.via) : null,
    stopped: Boolean(m.stopped),
    truncated: Boolean(m.truncated),
    proposal: m.proposal ?? null,
    // What its tools looked up (an Agent's reply): the counts, the messages found that I can see (the service sends no
    // more), and the words searched for — only in my Agent's own conversation, whatever a message carries elsewhere.
    lookups: m.kind === "text" ? lookupsView(m.lookups) : null,
    found: m.kind === "text" ? foundView(m.found) : [],
    // Who its mentions mean, as stored when it was sent (data/mentions.js `mentionsIn`: only those that fit its text —
    // a file's caption): shown as tags over their ranges. Never read from the text.
    mentions: kind === "system" ? [] : mentionsIn(m.text ?? "", m.mentions).map((x) => ({ ...x, id: alias(x.id) })),
    // What its text cites (〔m3〕), of the messages I can see.
    cites: m.kind === "text" ? citesView(m.cites) : null,
    queries:
      m.kind === "text" && typeof agentId === "string" && m.senderId === agentId && Array.isArray(m.queries)
        ? m.queries.filter((q) => typeof q === "string" && q.trim() !== "")
        : [],
    // Under my own message only: the Agents my own calls a minute kept it from (what its send answered, model.js `markSent`).
    notCalled: m.senderId === meId && Array.isArray(m.notCalled) && m.notCalled.length > 0 ? notCalledText(m.notCalled, nameOf) : null,
  };
  if (hidden) view.hidden = true;
  // An Agent's acknowledgement: shown as any message, but never the chat list's preview (state/selectors.js).
  if (m.ack === true) view.ack = true;
  if (kind === "image") view.src = attachment.url;
  return view;
}

/** Whether a run is queued or running. */
const runActive = (status) => status === "queued" || status === "running";
/** How a reply in a group ended that its owner is told of, though it did not fail: halted, or its Agent taken out. */
const ENDED_IN_GROUP = new Set(["halted", "agent_removed"]);

/**
 * One row of a group's Agent replies (model.js `groupRuns`), or null when there is nothing to show:
 * - `replying`: being written (its owner gets `run`, to stop it), and `activity` while its tool runs (what it looks at);
 * - `status`: my Agent's reply failed, was halted, or its Agent was taken out — the status line, with `run`;
 * - `unavailable`: someone else's Agent could not reply (no reason is known, nor shown).
 */
function groupRunRow(agentId, slot, offersAt) {
  // A reply being written that runs a tool now: what kind of thing it looks at (its status line); no key otherwise.
  const activity = slot.activity ? { activity: slot.activity } : {};
  if ("run" in slot) {
    const run = offerAsOf(slot.run, offersAt);
    if (!run) return null;
    if (runActive(run.status)) return slot.posted || slot.unknown ? null : { agentId, mine: true, kind: "replying", run, ...activity };
    if (run.status === "failed" || (run.status === "cancelled" && ENDED_IN_GROUP.has(run.error))) return { agentId, mine: true, kind: "status", run };
    return null;
  }
  if (slot.state === "replying") return slot.posted || slot.unknown ? null : { agentId, mine: false, kind: "replying", ...activity };
  if (slot.state === "unavailable") return { agentId, mine: false, kind: "unavailable" };
  return null;
}

// ───────── moments the service sent, kept by the view (fix round 3)
//
// An offer the service will refuse from a known moment on ends on screen at that moment, with no frame: a failed told
// reply's 重试 at its `retryableUntil`, an open found_elsewhere whisper (its buttons, its dot) at its `openUntil` (both:
// the whisper's day, the same rule the service keeps). `toView` judges them as of `offersAt` (the wall clock, as the
// service's moments are; `now`, by default: the clock its times are written with); the store (store.jsx) reads it again
// at the nearest such moment ahead (`deadlinesOf`: one timer) and whenever it renders or the tab wakes, so a tab that
// slept past one is right at once. The service's own answer to a press in a race stays the word (409).

/** Whether the moment `iso` (if any) has come by `now`. */
const hasCome = (iso, now) => typeof iso === "string" && Date.parse(iso) <= now;
/** A run as of `now`: past its `retryableUntil`, no longer offered 重试. */
const offerAsOf = (run, now) => (run && run.retryable && hasCome(run.retryableUntil, now) ? { ...run, retryable: false } : run);
/** A whisper as of `now`: an open one past its `openUntil` reads expired (its buttons and its dot go). */
const whisperAsOf = (w, now) => (w.status === "open" && hasCome(w.openUntil, now) ? { ...w, status: "expired" } : w);

/** Every such moment the held model knows of, as ms (offers still made), for the store's one timer. */
export function deadlinesOf(model) {
  const out = [];
  for (const byId of Object.values(model.whispers ?? {})) for (const w of Object.values(byId)) if (w.status === "open" && w.openUntil) out.push(Date.parse(w.openUntil));
  const runs = [...Object.values(model.runs ?? {}), ...Object.values(model.groupRuns ?? {}).flatMap((slots) => Object.values(slots).map((slot) => slot?.run))];
  for (const run of runs) if (run?.retryable && run.retryableUntil) out.push(Date.parse(run.retryableUntil));
  return out.filter((ms) => Number.isFinite(ms));
}

/** A group's rows, one per Agent with something to show, in the group's member order (then by id). */
function groupRunRows(conv, slots, offersAt) {
  const at = new Map(conv.members.map((m, i) => [m.id, i]));
  const place = (id) => at.get(id) ?? Number.MAX_SAFE_INTEGER;
  return Object.entries(slots ?? {})
    .map(([agentId, slot]) => groupRunRow(agentId, slot, offersAt))
    .filter(Boolean)
    .sort((a, b) => place(a.agentId) - place(b.agentId) || (a.agentId < b.agentId ? -1 : 1));
}

/**
 * Whether Agents of the group are answering each other (not a reply a person asked for): the newest message is an
 * Agent's (not a notice) and either its stored mentions (decided by the service when it was posted) mean another Agent
 * that is a member of the group now, or an Agent's reply is being written. An acknowledgement never decides it — it calls
 * nobody, and the reply it belongs to answers whatever came before it —: the newest message but acknowledgements is the
 * one read. It shows 让 Agent 停下. Its text is never read for it.
 */
function agentsTalking(model, conv, held, rows) {
  const last = [...held].reverse().find((m) => m.ack !== true);
  if (!last || last.kind === "system" || model.principals[last.senderId]?.kind !== "agent") return false;
  if (rows.some((r) => r.kind === "replying")) return true;
  const members = new Set(conv.members.map((m) => m.id));
  return mentionsIn(last.text ?? "", last.mentions).some((m) => m.id !== last.senderId && members.has(m.id) && model.principals[m.id]?.kind === "agent");
}

function pendingView(p, { held, alias, now }) {
  // An unsent file is never shown as an image: the service serves its bytes only once a message carries it.
  const file = p.attachment ?? p.file ?? null;
  const attachment = file ? { id: p.attachment?.id ?? null, name: file.name, size: file.size, inline: false, url: null } : null;
  const quoted = p.replyToSeq !== null && p.replyToSeq !== undefined ? held.find((m) => m.seq === p.replyToSeq) : null;
  return {
    id: `tx:${p.clientTxn}`,
    seq: null,
    from: ME,
    kind: attachment ? "file" : "text",
    text: attachment ? attachment.name : p.text,
    caption: attachment ? p.text : null,
    at: formatMessageAt(p.at, now),
    atTitle: formatMessageTitle(p.at),
    createdAt: Number.isFinite(p.at) ? new Date(p.at).toISOString() : null,
    status: p.status,
    clientTxn: p.clientTxn,
    error: p.error,
    /** While the file is queued or uploading: {phase: "queued" | "uploading", progress: 0..1}; else null. */
    upload: p.upload ?? null,
    replyTo: p.replyToSeq !== null && p.replyToSeq !== undefined ? `m${p.replyToSeq}` : null,
    quote: quoted
      ? {
          seq: quoted.seq,
          visible: true,
          from: alias(quoted.senderId),
          text: quoted.text ?? "",
          kind: quoted.kind === "file" ? "file" : "text",
          attachmentName: quoted.attachment?.name ?? null,
        }
      : null,
    attachment,
    system: null,
    // The mentions picked when it was written (ranges of its text as sent), shown while it is sent.
    mentions: mentionsIn(p.text ?? "", p.mentions).map((x) => ({ ...x, id: alias(x.id) })),
  };
}

/** The held server message an unsent one turned into, before the HTTP answer said so. */
function sameContent(m, p) {
  if (p.attachment) return m.attachment?.id === p.attachment.id;
  if (p.file) return false;
  return m.kind === "text" && m.text === p.text && (m.replyTo?.seq ?? null) === (p.replyToSeq ?? null);
}

/** "Cannot send here" with the service's reason, in the shape `publishBlock` returns. */
function holdOf(conv, social, people) {
  if (conv.canSend?.ok !== false) return null;
  const reason = conv.canSend.reason ?? "not_friends";
  if (reason === "closed") return { kind: "closed", reason, text: "本会话已暂停发布。", pending: [], canRestore: false };
  if (reason === "agent_deleted") {
    return { kind: "agentDeleted", reason, text: "这个 Agent 已删除，会话只能查看，不能再发送消息。", pending: [], canRestore: false };
  }
  if (reason === "blocked") {
    const name = people[conv.peerId]?.name ?? "对方";
    const lines = [];
    if (social?.blocked.some((p) => p.id === conv.peerId)) lines.push(`你已拉黑 ${name}`);
    if (social?.blockedBy.some((p) => p.id === conv.peerId)) lines.push(`${name}拉黑了你，只能由对方解除`);
    if (lines.length === 0) lines.push("存在拉黑，只能由拉黑的一方解除");
    return { kind: "block", reason, text: `${lines.join("；")}。双方不能再发送新消息，已有历史不受影响。`, pending: lines, canRestore: false };
  }
  return {
    kind: "relation",
    reason,
    text: "对方已不是你的好友，无法发送新的私聊。已有历史仍可查看。",
    pending: ["对方已不是你的好友，需重新申请并由对方确认"],
    canRestore: false,
  };
}

function personView(p, version) {
  return {
    id: p.id,
    kind: "person",
    name: p.displayName,
    handle: `@${p.handle}`,
    displayName: p.displayName,
    avatar: avatarUrl(p.id, version),
  };
}

/** 话多话少 by the service's `proactiveLevel`, with their labels (the second is the default). */
export const PROACTIVE_LEVELS = [
  ["less", "少说"],
  ["normal", "适中"],
  ["more", "多说"],
];
/** Whether `id` is one of the levels (`PROACTIVE_LEVELS`). */
export const isProactiveLevel = (id) => PROACTIVE_LEVELS.some(([level]) => level === id);
/** The label of level `id`; the default's (适中) for anything else. */
export const proactiveLevelLabel = (id) => (PROACTIVE_LEVELS.find(([level]) => level === id) ?? PROACTIVE_LEVELS[1])[1];

/** The prototype's two private-reply choices, by the service's `replyMode`. */
const PRIVATE_REPLY = { always: "收到消息时回复", mention: "仅在我点名时回复" };

/**
 * My Agent in the shape the prototype's Agents page reads (`role` is the persona), plus the service's own fields.
 * `loaded` is false for an Agent known only by its principal entry (its record not fetched yet): nothing of it may be
 * edited then, since its persona and model are not known.
 */
function agentView(a, version, loaded) {
  return {
    id: a.id,
    kind: "agent",
    name: a.name,
    displayName: a.name,
    handle: `@${a.handle}`,
    intro: a.intro ?? "",
    field: a.field ?? "",
    role: a.persona ?? "",
    persona: a.persona ?? "",
    personaVersion: a.personaVersion ?? 0,
    privateReply: PRIVATE_REPLY[a.replyMode] ?? PRIVATE_REPLY.always,
    replyMode: a.replyMode ?? "always",
    groupMentions: a.groupMentions === "owner" ? "owner" : "members",
    /** 一次接话最多花费: decimal points as the service says them (its default when it says nothing). */
    chainBudget: typeof a.chainBudget === "string" ? a.chainBudget : "50",
    /** 别人 @ 每天最多花 (decimal points, null = unlimited) and what they spent today: only when the service says them. */
    ...(a.othersBudget === null || typeof a.othersBudget === "string" ? { othersBudget: a.othersBudget } : {}),
    ...(typeof a.othersSpentToday === "string" ? { othersSpentToday: a.othersSpentToday } : {}),
    /** 主动参与群聊 with its level, daily budget and today's spend (decimal points): only the owner's view has these. */
    ...(typeof a.proactive === "boolean" ? { proactive: a.proactive } : {}),
    ...(isProactiveLevel(a.proactiveLevel) ? { proactiveLevel: a.proactiveLevel } : {}),
    ...(typeof a.proactiveBudget === "string" ? { proactiveBudget: a.proactiveBudget } : {}),
    ...(typeof a.proactiveSpentToday === "string" ? { proactiveSpentToday: a.proactiveSpentToday } : {}),
    /** How it addresses me and the others: only the owner's view has these (absent, never defaulted, otherwise). */
    ...(typeof a.ownerAppellation === "string" || a.ownerAppellation === null ? { ownerAppellation: a.ownerAppellation } : {}),
    ...(Array.isArray(a.appellations) ? { appellations: a.appellations } : {}),
    /** 记忆 and its two sub-switches (先问我再记, 使用共用的“关于我”): only the owner's view has these. */
    ...(typeof a.memory === "boolean" ? { memory: a.memory } : {}),
    ...(typeof a.memoryAsk === "boolean" ? { memoryAsk: a.memoryAsk } : {}),
    ...(typeof a.sharedNotes === "boolean" ? { sharedNotes: a.sharedNotes } : {}),
    /** 群里没找到时悄悄告诉我: only the owner's view has it. */
    ...(typeof a.whisperElsewhere === "boolean" ? { whisperElsewhere: a.whisperElsewhere } : {}),
    model: a.model ?? null,
    /** False when the service says its model is not there to call any more (then MODEL_GONE's words, errorTexts.js); true otherwise. */
    modelUsable: a.modelUsable !== false,
    reasoning: a.reasoning ?? "none",
    paused: Boolean(a.paused),
    deleted: Boolean(a.deleted),
    ownerId: ME,
    mine: true,
    conversationId: a.conversationId ?? null,
    createdAt: a.createdAt ?? null,
    avatar: avatarUrl(a.id, version),
    loaded,
  };
}

/**
 * Someone else's Agent (a co-member of a group): what its principal entry tells a co-member — name, account name,
 * avatar, intro, field and its owner (`ownerId`: their real id, null when not said) — and nothing else. What only its
 * owner knows (persona, model, paused, its conversation…) is absent, not defaulted.
 */
function othersAgentView(p, version, ownerId) {
  return {
    id: p.id,
    kind: "agent",
    name: p.displayName,
    displayName: p.displayName,
    handle: `@${p.handle}`,
    intro: typeof p.intro === "string" ? p.intro : "",
    field: typeof p.field === "string" ? p.field : "",
    ownerId,
    mine: false,
    avatar: avatarUrl(p.id, version),
    loaded: false,
  };
}

/** Usage with every amount of points also as display text (`formatPoints`). */
function usageView(u) {
  if (!u) return null;
  return {
    ...u,
    balanceText: formatPoints(u.balance),
    free: u.free ? { ...u.free, allowanceText: formatPoints(u.free.allowance), usedText: formatPoints(u.free.used) } : null,
    memory: u.memory ? { ...u.memory, allowanceText: formatPoints(u.memory.allowance), usedText: formatPoints(u.memory.used) } : null,
    recent: (Array.isArray(u.recent) ? u.recent : []).map((r) => ({ ...r, pointsText: formatPoints(r.points) })),
  };
}

/**
 * @returns {{people, agents, convs, order, relations, blocks, drafts, account, loaded, providers, usage, siteModels,
 *   providerDefaults, proactiveAvailable, avatarVersions}} — merged by the store with the UI state (nav, toast) and `connection`.
 */
export function toView(model, { now = Date.now(), offersAt = now } = {}) {
  const meId = model.me?.id ?? null;
  const alias = (id) => (id === null || id === undefined ? null : id === meId ? ME : id);
  const social = model.social;
  const versions = model.avatarVersions ?? {};

  const people = {};
  // An Agent is never a person: it is listed under `agents` (mine, and anyone else's I share a group with).
  for (const p of Object.values(model.principals)) if (p.id !== meId && p.kind !== "agent") people[p.id] = personView(p, versions[p.id]);
  if (social) {
    const named = [...social.friends, ...social.blocked, ...social.blockedBy, ...social.incoming.map((r) => r.principal), ...social.outgoing.map((r) => r.principal)];
    for (const p of named) if (p.id !== meId && !people[p.id]) people[p.id] = personView(p, versions[p.id]);
  }
  if (model.me) {
    people[ME] = {
      id: ME,
      kind: "person",
      name: "你",
      handle: `@${model.me.handle}`,
      displayName: model.me.displayName,
      principalId: meId,
      avatar: avatarUrl(meId, versions[meId]),
    };
  }

  // My Agents are those of `model.agents` (`GET /api/agents`), and an Agent a principal entry names is mine when it
  // says I own it or, saying no owner, when I hold its conversation (only its owner has one). Any other is someone else's.
  const agents = {};
  for (const a of Object.values(model.agents ?? {})) agents[a.id] = agentView(a, versions[a.id], true);
  for (const p of Object.values(model.principals)) {
    if (p.kind !== "agent" || agents[p.id]) continue;
    const owner = typeof p.ownerId === "string" ? p.ownerId : null;
    const conv = Object.values(model.conversations).find((c) => c.agentId === p.id);
    const mine = ownsAgent(model, p.id);
    if (!mine) {
      agents[p.id] = othersAgentView(p, versions[p.id], owner);
      continue;
    }
    const known = {
      id: p.id,
      handle: p.handle,
      name: p.displayName,
      intro: p.intro,
      field: p.field,
      conversationId: conv?.id ?? null,
      paused: conv?.agent?.paused,
      deleted: conv?.agent?.deleted,
    };
    agents[p.id] = agentView(known, versions[p.id], false);
  }
  const nameOf = (id) => people[id]?.name ?? agents[id]?.name ?? null;

  const pendingByConv = new Map();
  for (const p of Object.values(model.pending).sort((a, b) => a.at - b.at)) {
    const list = pendingByConv.get(p.conversationId) ?? [];
    list.push(p);
    pendingByConv.set(p.conversationId, list);
  }

  const convs = {};
  const ranking = [];
  for (const conv of Object.values(model.conversations)) {
    const direct = conv.type === "direct";
    const agentChat = conv.type === "agent";
    const held = model.messages[conv.id] ?? [];
    let members = conv.members.map((m) => alias(m.id));
    if (direct) members = [ME, conv.peerId ?? members.find((id) => id !== ME)].filter(Boolean);
    else if (agentChat) members = [ME, conv.agentId ?? members.find((id) => id !== ME)].filter(Boolean);
    else if (!members.includes(ME)) members.unshift(ME);

    // Whose replies' thinking and `via` are kept (the service sends them only to their owner; whatever a message
    // carries, nothing else is): in my Agent's own conversation that Agent's; in a group my own Agents', never someone
    // else's Agent's.
    const keepsOwners = (senderId) =>
      typeof senderId === "string" && (agentChat ? senderId === conv.agentId : conv.type === "group" && ownsAgent(model, senderId));
    const viewOf = (m) =>
      messageView(m, { alias, meId, pair: direct || agentChat, peerReadSeq: conv.peerReadSeq, now, nameOf, agentId: conv.agentId, keepsOwners });
    const messages = held.map(viewOf);
    const win = model.windows?.[conv.id] ?? null;
    const claimed = new Set();
    let lastPendingAt = null;
    for (const p of pendingByConv.get(conv.id) ?? []) {
      if (p.status === "sending") {
        const twin = held.find((m) => !claimed.has(m.seq) && m.senderId === meId && !m.clientTxn && m.seq > p.afterSeq && sameContent(m, p));
        if (twin) {
          claimed.add(twin.seq);
          continue;
        }
      }
      messages.push(pendingView(p, { held, alias, now }));
      lastPendingAt = p.at;
    }

    // (A notice this client does not know is hidden: it is no activity, as it is no preview.)
    let lastShown = held.length - 1;
    while (lastShown >= 0 && messages[lastShown].hidden) lastShown--;
    const lastHeld = lastShown >= 0 ? timeOf(held[lastShown].createdAt) : null;
    const activity = Math.max(lastHeld ?? 0, lastPendingAt ?? 0) || timeOf(conv.createdAt) || 0;
    ranking.push({ id: conv.id, activity, index: conv.syncIndex ?? 0 });
    // The reply in progress: its run (none while its state is unknown), and its streamed text as one bubble while it
    // runs in order with the pushes and its message has not come (never both: the stored message replaces the bubble).
    const heldRun = model.runs?.[conv.id] ?? null;
    const run = heldRun && !heldRun.unknown ? offerAsOf(heldRun, offersAt) : null;
    const streamed = run && run.status === "running" && !run.posted && !run.joined ? model.streams?.[run.id] : null;
    // A group: each Agent's reply in progress or failed (never streamed), and whether its Agents are talking.
    const agentRuns = conv.type === "group" ? groupRunRows(conv, model.groupRuns?.[conv.id], offersAt) : [];
    // My whispers here, where they sit (`placeWhispers` interleaves them with the messages shown); an open one past its
    // `openUntil` reads expired (`whisperAsOf`).
    const whispers = Object.values(model.whispers?.[conv.id] ?? {})
      .sort(byPlace)
      .map((w) => ({ ...whisperAsOf(w, offersAt), agentId: alias(w.agentId) }));
    convs[conv.id] = {
      id: conv.id,
      type: direct ? "human" : agentChat ? "agent" : "group",
      agentId: conv.agentId ?? null,
      agent: conv.agent ?? null,
      run,
      // (`cut`, `reasoningCut`: the run streamed more than is kept of its text, of its thinking.)
      stream: streamed
        ? { runId: run.id, text: streamed.text, reasoning: streamed.reasoning, cut: Boolean(streamed.cut), reasoningCut: Boolean(streamed.reasoningCut) }
        : null,
      /** [{agentId, mine, kind: "replying" | "status" | "unavailable", run?, activity?}] (`groupRunRow`); empty but in a group. */
      agentRuns: agentRuns.map((row) => ({ ...row, agentId: alias(row.agentId) })),
      agentsTalking: conv.type === "group" && agentsTalking(model, conv, held, agentRuns),
      /** My whispers here (悄悄话), ascending by where they sit: [{id, afterSeq, kind, text, actions, status, createdAt, agentId}]. */
      whispers,
      /** How many of them wait for my answer: open, offering a button (the chat list's mark; one offering none only tells). */
      openWhispers: whispers.filter((w) => w.status === "open" && w.actions.length > 0).length,
      title: direct ? null : conv.title,
      members,
      memberRoles: conv.members.map((m) => ({ id: alias(m.id), role: m.role, isCreator: Boolean(m.isCreator) })),
      admin: direct ? null : alias(conv.creatorId),
      creatorId: direct ? null : alias(conv.creatorId),
      peerId: conv.peerId,
      myRole: conv.myRole,
      closed: conv.closed,
      canSend: conv.canSend,
      hold: holdOf(conv, social, people),
      unread: conv.unread,
      readSeq: conv.readSeq,
      lastSeq: conv.lastSeq,
      peerReadSeq: conv.peerReadSeq,
      hasOlder: conv.hasOlder,
      /** A detached window around a search hit, shown instead of `messages` (the newest ones) while it exists: {messages, hasOlder, focusSeq} or null. */
      window: win ? { messages: win.messages.map(viewOf), hasOlder: win.hasOlder, focusSeq: win.focusSeq } : null,
      detached: Boolean(win),
      at: formatAt(activity || null, now),
      lastActivity: activity,
      cutoffs: {},
      messages,
    };
  }
  const order = ranking.sort((a, b) => b.activity - a.activity || b.index - a.index || (a.id < b.id ? -1 : 1)).map((r) => r.id);

  const relations = {};
  const blocks = [];
  if (social) {
    const request = (r, status) => ({ status, at: formatAt(timeOf(r.createdAt), now), requestId: r.id, createdAt: r.createdAt, expiresAt: r.expiresAt });
    for (const f of social.friends) relations[`${ME}|${f.id}`] = { status: "established" };
    for (const r of social.outgoing) relations[`${ME}|${r.principal.id}`] = request(r, "pending");
    for (const r of social.incoming) relations[`${r.principal.id}|${ME}`] = request(r, "incoming");
    for (const p of social.blocked) blocks.push({ by: ME, target: p.id });
    for (const p of social.blockedBy) blocks.push({ by: p.id, target: ME });
  }

  return {
    people,
    agents,
    convs,
    order,
    relations,
    blocks,
    drafts: model.drafts,
    refills: model.refills ?? {},
    account: model.me,
    loaded: model.synced,
    providers: model.providers ?? {},
    usage: usageView(model.usage),
    siteModels: model.siteModels ?? [],
    providerDefaults: model.providerDefaults ?? null,
    /** true or false once the site's models have answered; null before (not known yet). */
    proactiveAvailable: typeof model.proactiveAvailable === "boolean" ? model.proactiveAvailable : null,
    /** principal id (the real one, mine too) → the version in its avatar URL; for an avatar of someone nobody names. */
    avatarVersions: versions,
  };
}

/** Where a whisper sits: after the message it follows, several there by when they were made. */
function byPlace(a, b) {
  if (a.afterSeq !== b.afterSeq) return a.afterSeq - b.afterSeq;
  const at = (timeOf(a.createdAt) ?? 0) - (timeOf(b.createdAt) ?? 0);
  return at !== 0 ? at : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** By when they were made (then by id): the order of open whispers whose place is not loaded. */
function byMade(a, b) {
  const at = (timeOf(a.createdAt) ?? 0) - (timeOf(b.createdAt) ?? 0);
  return at !== 0 ? at : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The rows of a message list with my whispers (`whispers`, ascending by place) among its messages: each after the message
 * it follows (`afterSeq`: after every message up to that seq, before the next), and before what I am still sending (no seq
 * yet). One that follows a message before the first one shown is at its place only when the list holds everything from the
 * start (`complete`: no older page); until then an open one is at the top, before the first message (several: by when they
 * were made), so the chat list's mark never points at nothing, and an answered one waits for its page. One after the last
 * message shown appears only when the list reaches the newest (`toEnd`: not a detached window). `bubble`: the reply being
 * written, a row at the end (`true`), or, while it finishes, the row in place of its stored message (that message's id),
 * so a whisper after that message is below it and stays there once the message replaces it. → [{msg} | {whisper} | {bubble}].
 */
export function placeWhispers(messages, whispers, { complete, toEnd, bubble = null }) {
  const seqs = messages.filter((m) => Number.isSafeInteger(m.seq));
  const first = seqs[0]?.seq ?? null;
  const last = seqs[seqs.length - 1]?.seq ?? null;
  const above = (w) => !complete && (first === null || w.afterSeq < first);
  const top = whispers.filter((w) => above(w) && w.status === "open").sort(byMade);
  const shown = whispers.filter((w) => !above(w) && (toEnd || (last !== null && w.afterSeq <= last)));
  const rows = top.map((whisper) => ({ whisper }));
  let i = 0;
  for (const msg of messages) {
    const limit = Number.isSafeInteger(msg.seq) ? msg.seq : Infinity;
    while (i < shown.length && shown[i].afterSeq < limit) rows.push({ whisper: shown[i++] });
    rows.push(bubble !== null && bubble !== true && msg.id === bubble ? { bubble: true } : { msg });
  }
  while (i < shown.length) rows.push({ whisper: shown[i++] });
  if (bubble === true) rows.push({ bubble: true });
  return rows;
}

/**
 * One search hit (a WireMessage from either search) for the list: `from` is "me" for my own, the real id otherwise,
 * `text` what the match is looked for in (a file message: its name, then its caption).
 */
export function searchHitView(m, { meId, now }) {
  const attachment = m.kind === "file" ? m.attachment : null;
  const text = attachment ? [attachment.name, m.text].filter(Boolean).join(" · ") : m.text ?? "";
  return {
    key: `${m.conversationId}:${m.seq}`,
    conversationId: m.conversationId,
    seq: m.seq,
    from: m.senderId === null || m.senderId === undefined ? null : m.senderId === meId ? ME : m.senderId,
    file: Boolean(attachment),
    text,
    at: formatAt(timeOf(m.createdAt), now),
  };
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * How long a friend request stays valid, rounded up: "24 小时内有效", "35 分钟内有效", "已过期".
 * `expiresAt` is the service's ISO time; empty when it is missing or unreadable.
 */
export function expiryText(expiresAt, now) {
  const ms = timeOf(expiresAt);
  if (ms === null) return "";
  const left = ms - now;
  if (left <= 0) return "已过期";
  if (left <= HOUR_MS) return `${Math.max(1, Math.ceil(left / MINUTE_MS))} 分钟内有效`;
  return `${Math.ceil(left / HOUR_MS)} 小时内有效`;
}
