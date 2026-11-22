import { ME } from "../data/identities.js";
import { previewOfMarkdown } from "../ui/markdownPreview.js";
import { drawnText } from "../ui/drawnText.js";
import { PROPOSAL_ONLY } from "../data/viewmodel.js";

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
export const TYPE_LABEL = { human: "私聊", agent: "私聊", group: "群聊" };

export function otherMember(conv) {
  return conv.members.find((id) => id !== ME);
}

export function convTitle(state, conv) {
  if (conv.title) return conv.title;
  return nameOf(state, otherMember(conv));
}

/** The chat header's line: a group counts its people, and its Agents when it has any. */
export function convSubtitle(state, conv) {
  if (conv.type === "agent") return "你的 Agent · 专属会话";
  if (conv.type !== "group") return "真人私聊";
  const agents = conv.members.filter((id) => isAgent(state, id)).length;
  const people = `${conv.members.length - agents} 位真人`;
  return agents > 0 ? `${people} · ${agents} 个 Agent` : people;
}

/** A deleted Agent's conversation: read only, said in the frozen-conversation style. */
export const AGENT_DELETED_TEXT = "这个 Agent 已删除，聊天记录仍可查看";

/** Whether the Agent of an Agent conversation is deleted (by its record, the conversation's flags or the service's hold). */
export const agentDeleted = (state, conv) =>
  conv.type === "agent" && Boolean(conv.hold?.kind === "agentDeleted" || conv.agent?.deleted || state.agents[conv.agentId]?.deleted);

// null when publishing is allowed, otherwise the user-facing reason (the service's verdict, see viewmodel.js `hold`).
// A deleted Agent's conversation reads as such as soon as anything here knows it (its record may arrive first).
export function publishBlock(state, conv) {
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
  const last = [...shown].reverse().find((x) => x.kind !== "system") || shown[shown.length - 1];
  if (!last) return "暂无消息";
  // (Its words as drawn, a mention as @name; an Agent's text is Markdown: its markers are taken out too.)
  const drawn = last.kind !== "system" && typeof last.text === "string" ? drawnTextOf(state, last) : last.text;
  let body = last.kind !== "system" && isAgent(state, last.from) && typeof drawn === "string" ? previewOfMarkdown(drawn) : drawn;
  if (last.kind === "image") body = "[图片]";
  if (last.kind === "file") body = "[文件]";
  // A reply that is only a persona proposal has no text of its own.
  if (last.kind === "text" && last.proposal && !body) body = PROPOSAL_ONLY;
  const group = conv.type === "group";
  if (group && last.from === ME) return `你：${body}`;
  if (group && last.from) return `${senderName(state, last.from)}：${body}`;
  return body;
}

/** A conversation that asks for no attention: a deleted Agent's (its history stays readable; nothing new can come of it). */
export const quiet = (state, conv) => agentDeleted(state, conv);

/** What waits for me in the tab bar's number: every conversation but the quiet ones. */
export function unreadTotal(state) {
  return state.order.reduce((n, id) => n + (state.convs[id] && !quiet(state, state.convs[id]) ? state.convs[id].unread || 0 : 0), 0);
}
