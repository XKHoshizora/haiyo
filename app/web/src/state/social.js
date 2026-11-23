// Humans-only reads of the social state (people, relations, blocks) the contact and group pages share.
import { ME } from "../data/identities.js";
import { nameOf } from "./selectors.js";

const FROM_ME = `${ME}|`;
const TO_ME = `|${ME}`;

const withStatus = (state, status, mine) =>
  Object.entries(state.relations)
    .filter(([key, rel]) => rel.status === status && (mine ? key.startsWith(FROM_ME) : key.endsWith(TO_ME)))
    .map(([key, rel]) => ({ id: mine ? key.slice(FROM_ME.length) : key.slice(0, -TO_ME.length), ...rel }));

/** Ids of my friends, in the service's order (by account name). */
export const friendIds = (state) => withStatus(state, "established", true).map((f) => f.id);
/** Requests sent to me: {id (the sender), requestId, createdAt, expiresAt, at}. */
export const incomingRequests = (state) => withStatus(state, "incoming", false);
/** Requests I sent: {id (the recipient), requestId, createdAt, expiresAt, at}. */
export const outgoingRequests = (state) => withStatus(state, "pending", true);

/** "friend" | "incoming" | "outgoing" | null: how the person stands to me. */
export function relationOf(state, id) {
  const mine = state.relations[`${ME}|${id}`];
  if (mine) return mine.status === "established" ? "friend" : "outgoing";
  return state.relations[`${id}|${ME}`] ? "incoming" : null;
}
export const requestWith = (state, id) => state.relations[`${ME}|${id}`] ?? state.relations[`${id}|${ME}`] ?? null;

export const iBlocked = (state, id) => state.blocks.some((b) => b.by === ME && b.target === id);
export const blockedMe = (state, id) => state.blocks.some((b) => b.by === id && b.target === ME);
export const blockBetween = (state, id) => iBlocked(state, id) || blockedMe(state, id);

/** The direct conversation with a friend (it exists once you are friends), or undefined. */
export const directConvWith = (state, id) => Object.values(state.convs).find((c) => c.type === "human" && c.peerId === id);

/** My friends who can be put in a group: known by name, no block in either direction, not in `exclude`. */
export const eligibleFriends = (state, exclude = []) =>
  friendIds(state).filter((id) => state.people[id] && !blockBetween(state, id) && !exclude.includes(id));

/** Local filter by name or account name (@handle). */
export const matchesPerson = (person, query) => {
  const q = query.trim().toLowerCase().replace(/^@/, "");
  return !q || person.name.toLowerCase().includes(q) || person.handle.toLowerCase().includes(q);
};

// ── Agent social (ring 1): every read below is of what the service said; none shows anything while the site's switch is off.

/** Whether the site's Agent social switch is on (nothing of it is drawn, and no route of it called, otherwise). */
export const socialOn = (state) => state.social?.enabled === true;

/** `GET /api/agent-contacts` as held: `{mine, waiting}` (empty before it came, or while the switch is off). */
export function agentContactsOf(state) {
  if (!socialOn(state) || !state.agentContacts) return { mine: [], waiting: [] };
  return { mine: state.agentContacts.mine ?? [], waiting: state.agentContacts.waiting ?? [] };
}

/** A conversation of the social kind (an Agent and one other person, or two Agents), whoever is looking. */
export const isSocialConv = (conv) => conv?.type === "social";
/** One I only watch: it is my Agent's with someone else (a supervising owner's membership). */
export const isObserved = (conv) => conv?.type === "social" && conv.myRole === "observer";

const aliasOf = (state, id) => (id === state.account?.id ? ME : id);

/** The owners whose Agents are in a social conversation, as ids the page knows (mine as "me"), in the service's order, each once. */
export function socialOwners(state, conv) {
  const owners = (conv.social?.agents ?? []).map((a) => aliasOf(state, a.ownerId));
  return owners.filter((id, i) => owners.indexOf(id) === i);
}

/** The disclosure, word for word (plan "Exact copy"): two owners' names joined by 「、」. */
export const disclosureText = (names) => `这是${names.join("、")}的 Agent。${names.join("、")}能看到你们的对话，也可能插话。`;

/** The disclosure of a social conversation I speak in, or "" (an observer's line is `supervisionText`). */
export function disclosureOf(state, conv) {
  if (!isSocialConv(conv) || isObserved(conv)) return "";
  const names = socialOwners(state, conv).map((id) => nameOf(state, id));
  return names.length === 0 ? "" : disclosureText(names);
}

/** The ends of a social conversation as the page names them: my Agent (when I watch) and the other end; else the Agent I talk to. */
export function socialEnds(state, conv) {
  const parts = (conv.social?.participants ?? []).map((id) => aliasOf(state, id));
  const agents = new Set((conv.social?.agents ?? []).map((a) => aliasOf(state, a.id)));
  const mine = (conv.social?.agents ?? []).find((a) => aliasOf(state, a.ownerId) === ME);
  if (isObserved(conv) && mine) {
    const agentId = aliasOf(state, mine.id);
    return { agentId, otherId: parts.find((id) => id !== agentId) ?? null };
  }
  const otherId = parts.find((id) => id !== ME) ?? null;
  return { agentId: agents.has(otherId) ? otherId : [...agents][0] ?? null, otherId };
}

/** The line an observing owner reads in the header (plan "A12a"). */
export function supervisionText(state, conv) {
  const { agentId, otherId } = socialEnds(state, conv);
  return `你在旁观${nameOf(state, agentId)}和${nameOf(state, otherId)}的对话。你发言时，对方会看到你是主人。`;
}

/** The label of a speaker who is a supervising owner here (decided by the membership role alone), or null: 「主人」, with two owners 「{A}的主人」. */
export function supervisorLabel(state, conv, id) {
  if (!isSocialConv(conv)) return null;
  const roles = conv.memberRoles ?? [];
  if (roles.find((m) => m.id === id)?.role !== "observer") return null;
  if (roles.filter((m) => m.role === "observer").length <= 1) return "主人";
  // Two owners: 「{A}的主人」 names the Agent whose owner this is (never the owner's own name).
  const agent = (conv.social?.agents ?? []).find((a) => aliasOf(state, a.ownerId) === id);
  return agent ? `${nameOf(state, aliasOf(state, agent.id))}的主人` : "主人";
}

/** The conversation as its picture is drawn: a social one by its Agent (the one I talk to, or my own that I watch), never a composite with an owner's face. */
export function pictureConv(state, conv) {
  if (!isSocialConv(conv)) return conv;
  const { agentId, otherId } = socialEnds(state, conv);
  return { ...conv, type: "agent", members: [ME, agentId ?? otherId].filter(Boolean) };
}
