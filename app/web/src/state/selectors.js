import { ME } from "../data/identities.js";
import { previewOfMarkdown } from "../ui/markdownPreview.js";
import { drawnText } from "../ui/drawnText.js";
import { PROPOSAL_ONLY } from "../data/viewmodel.js";
import { iBlocked, isObserved, socialEnds } from "./social.js";

export const entity = (state, id) => state.people[id] || state.agents[id] || null;
/** Any Agent: mine, or someone else's in a group I am in. */
export const isAgent = (state, id) => Boolean(state.agents[id]);

/** One of my own Agents (never someone else's). */
export const isMyAgent = (state, id) => Boolean(state.agents[id]?.mine);
/** An Agent's owner ("me" for mine; null when nobody said), anyone else themselves. Unknown by name: nameOf says 未知. */
export const ownerOf = (state, id) => (state.agents[id] ? state.agents[id].ownerId ?? null : id);

const createdAtOf = (agent) => {
  const ms = Date.parse(agent.createdAt ?? "");
  return Number.isFinite(ms) ? ms : Number.MAX_SAFE_INTEGER;
};

/** My Agents (only mine: someone else's in a group never), in the list's order: oldest first, the deleted ones last. */
export function myAgents(state) {
  return Object.values(state.agents)
    .filter((a) => a.mine)
    .sort((a, b) => Number(a.deleted) - Number(b.deleted) || createdAtOf(a) - createdAtOf(b));
}

export const nameOf = (state, id) => entity(state, id)?.name || "未知";
// A message's sender (or a quote's) whom nobody has named here: they left before this client saw them.
export const senderName = (state, id) => entity(state, id)?.name || "已退出的成员";
export const TYPE_LABEL = { human: "私聊", agent: "私聊", group: "群聊", social: "Agent 对话" };

export function otherMember(conv) {
  return conv.members.find((id) => id !== ME);
}

export function convTitle(state, conv) {
  if (conv.title) return conv.title;
  // A social conversation: the Agent I talk to (a visitor's), or the two ends I watch (an observing owner's).
  if (conv.type === "social") {
    const { agentId, otherId } = socialEnds(state, conv);
    if (conv.myRole === "observer") return `${nameOf(state, agentId)}和${nameOf(state, otherId)}`;
    return nameOf(state, agentId ?? otherId);
  }
  return nameOf(state, otherMember(conv));
}

/** The chat header's line: an Agent conversation says what it is; any other has none (null). */
export function convSubtitle(state, conv) {
  // (A deleted Agent's line says what the conversation is now — read only — and no model: it can no longer reply, so its model is of no use there.)
  if (conv.type === "agent") return agentDeleted(state, conv) ? "你的 Agent · 已删除，只能查看" : "你的 Agent · 专属会话";
  if (conv.type === "social") return conv.myRole === "observer" ? "旁观的对话" : "Agent 对话";
  // (Nobody is labelled a person: a direct chat has no line, a group has its counts, `groupCounts`.)
  return null;
}

/** A group's people and Agents, counted for the header (`HeadCounts`): `{people, agents}`; null for any other conversation. */
export function groupCounts(state, conv) {
  if (conv.type !== "group") return null;
  const agents = conv.members.filter((id) => isAgent(state, id)).length;
  return { people: conv.members.length - agents, agents };
}

/** A deleted Agent's conversation: read only, said in the frozen-conversation style. */
export const AGENT_DELETED_TEXT = "这个 Agent 已删除，聊天记录仍可查看。";

/** Whether the Agent of an Agent conversation is deleted (by its record, the conversation's flags or the service's hold). */
export const agentDeleted = (state, conv) =>
  conv.type === "agent" && Boolean(conv.hold?.kind === "agentDeleted" || conv.agent?.deleted || state.agents[conv.agentId]?.deleted);

// null when publishing is allowed, otherwise the user-facing reason (the service's verdict, see viewmodel.js `hold`).
// A deleted Agent's conversation reads as such as soon as anything here knows it (its record may arrive first).
export function publishBlock(state, conv) {
  // A social conversation says why it cannot be written in by the reason the service gave, once (the shared `hold` is for the others).
  if (conv.type === "social") return socialBlock(state, conv);
  if (agentDeleted(state, conv)) return { kind: "agentDeleted", reason: "agent_deleted", text: AGENT_DELETED_TEXT, pending: [], canRestore: false };
  return conv.hold ?? null;
}

/** Who an id means in text the wire gives (a message, a quote, a whisper hit: ids as the service sends them, mine included): the entity, as the page knows it. */
const knownByWire = (state) => (id) => entity(state, id === state.account?.id ? ME : id);

/**
 * A message's words in the form they are drawn (ui/drawnText.js): the one function of the quote under a reply, the reply chip, the chat
 * list's line, the copied text and a whisper's hit. `msg`: `{text, mentions, from}` (a quote's own `from` is the sender too); a text
 * that is not a message (a hit, what a model found) has no `from` and sets `agentText: true` to be drawn as an Agent's is.
 */
export const drawnTextOf = (state, msg) =>
  drawnText({ text: msg.text, mentions: msg.mentions, fromAgent: msg.agentText === true || (msg.from !== ME && isAgent(state, msg.from)), known: knownByWire(state) });

/**
 * The chat list's one line for a conversation: its newest message — never an Agent's acknowledgement (`ack`: the answer
 * after it is). An Agent's text is Markdown: its markers are taken out (ui/markdownPreview.js); a person's text is shown
 * as written.
 */
export function lastPreview(state, conv) {
  // (A notice of an event this client does not know shows nothing: it is never the preview either.)
  const shown = conv.messages.filter((x) => !x.hidden && !x.ack);
  // (One notice is the line while it is the newest thing there: the persona aid's card still waiting for my answer, a question to me.)
  const newest = shown[shown.length - 1];
  const waitingCard = newest?.kind === "system" && newest.system?.event === "persona_fact" && newest.system.card?.answer == null && newest.system.card?.expired !== true;
  const last = waitingCard ? newest : [...shown].reverse().find((x) => x.kind !== "system") || newest;
  if (!last) return "暂无消息";
  // (Its words as drawn, a mention as @name; an Agent's text is Markdown: its markers are taken out too.)
  const drawn = last.kind !== "system" && typeof last.text === "string" ? drawnTextOf(state, last) : last.text;
  let body = last.kind !== "system" && isAgent(state, last.from) && typeof drawn === "string" ? previewOfMarkdown(drawn) : drawn;
  if (last.kind === "image") body = "[图片]";
  if (last.kind === "file") body = "[文件]";
  // A reply that is only a persona proposal has no text of its own.
  if (last.kind === "text" && last.proposal && !body) body = PROPOSAL_ONLY;
  const group = conv.type === "group" || conv.type === "social";
  if (group && last.from === ME) return `你：${body}`;
  if (group && last.from) return `${senderName(state, last.from)}：${body}`;
  return body;
}

/**
 * A conversation that asks for no attention: one that can no longer receive messages — a deleted Agent's (its history stays readable). Read from
 * the conversation's own sync entry (`agent.deleted`, or the hold the service sends), never from the Agent's record, which arrives later: the display and the
 * tab bar's number are the same at first paint and after the Agents load. (A reply that arrived just before the deletion is no longer signalled in the list
 * or the number; it still reads as new inside the chat. Said to the owner in the lane report.)
 */
export const quiet = (state, conv) => conv.type === "agent" && (conv.hold?.kind === "agentDeleted" || conv.agent?.deleted === true);

/** What waits for me in the tab bar's number: every conversation but the quiet ones. */
export function unreadTotal(state) {
  return state.order.reduce((n, id) => n + (state.convs[id] && !quiet(state, state.convs[id]) && !isObserved(state.convs[id]) ? state.convs[id].unread || 0 : 0), 0);
}

/** The conversations of the main list, in order: the ones I watch as my Agents' supervisor (Agent social) are in the Agent's 「别人」 tab, never here. */
export const listedConvs = (state) => state.order.map((id) => state.convs[id]).filter((c) => c && !isObserved(c));

/** Why a social conversation cannot be written in, by the service's reason (the plan's error texts); null when it can. */
function socialBlock(state, conv) {
  if (conv.canSend?.ok !== false) return null;
  const reason = conv.canSend.reason;
  const watching = conv.myRole === "observer";
  const text =
    reason === "agent_deleted" ? AGENT_DELETED_TEXT
    : reason === "agent_unavailable" ? "这个 Agent 现在不可用。"
    : reason === "blocked" && !watching && iBlocked(state, socialEnds(state, conv).agentId) ? "你拉黑了它。解除拉黑后才能再聊。"
    : watching ? "这段对话已结束，不能再发送消息。"
    : "你现在不能和它聊天了。";
  return { kind: "social", reason, text, pending: [], canRestore: false };
}
