// One function per service endpoint (see app/service/README.md and the route files under app/service/src).
// Paths are built here and nowhere else.
import { request, requestBytes, upload } from "./http.js";

const seg = (value) => encodeURIComponent(String(value));

function withQuery(path, query = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

// ───────── auth
export const register = (body) => request("POST", "/api/register", body); // {inviteCode?, email, password, displayName, handle}
export const signIn = (body) => request("POST", "/api/auth/sign-in/email", body); // {email, password, rememberMe?}
export const signOut = () => request("POST", "/api/auth/sign-out");
export const verifyEmail = (token) => request("GET", withQuery("/api/auth/verify-email", { token }));
export const requestPasswordReset = (body) => request("POST", "/api/auth/request-password-reset", body); // {email, redirectTo?}
export const resetPassword = (body) => request("POST", "/api/auth/reset-password", body); // {newPassword, token}

// ───────── me and principals
export const getMe = () => request("GET", "/api/me");
export const updateMe = (displayName) => request("PATCH", "/api/me", { displayName });
/** My handle, once a year (409 handle_taken, 429 handle_change_too_soon with availableAt) → {id, handle, displayName, avatarVersion}. */
export const updateHandle = (handle) => request("PATCH", "/api/me", { handle });
/** How a new note is sorted for the vault: "auto" (judged), "vault" (all in) or "open" (none in). The answer does not echo it. */
/** Whether my Agents tidy the day's notes while I rest (入梦). */
export const updateDream = (dream) => request("PATCH", "/api/me", { dream });
export const updateNewNotes = (newNotes) => request("PATCH", "/api/me", { newNotes });
/** The one language my notes are written in: a code of the list, or null for automatic. The answer does not echo it. */
export const updateMemoryLanguage = (memoryLanguage) => request("PATCH", "/api/me", { memoryLanguage });
/** Starts restating my existing notes in that language → 202 `{started: true}`. 409 no_language | busy; 503 unavailable. */
export const convertMemoryLanguage = () => request("POST", "/api/memory/language/convert");
/** How my latest conversion stands → `{state: "idle" | "running" | "done", result?: {rooms, converted, kept, noRoom, failedRooms}, unavailable?: true}`. */
export const getMemoryConversion = () => request("GET", "/api/memory/language/convert");
/** The model that tidies my memory: a model as an Agent's is written, or null for the site's. The answer does not echo it. */
export const updateMemoryModel = (memoryModel) => request("PATCH", "/api/me", { memoryModel });
export const lookupPrincipal = (handle) => request("GET", withQuery("/api/principals/lookup", { handle }));

// ───────── social
export const getSocial = () => request("GET", "/api/social");
export const sendFriendRequest = (handle) => request("POST", "/api/friend-requests", { handle });
export const getFriendRequest = (id) => request("GET", `/api/friend-requests/${seg(id)}`);
export const acceptFriendRequest = (id) => request("POST", `/api/friend-requests/${seg(id)}/accept`);
export const rejectFriendRequest = (id) => request("POST", `/api/friend-requests/${seg(id)}/reject`);
export const withdrawFriendRequest = (id) => request("POST", `/api/friend-requests/${seg(id)}/withdraw`);
export const removeFriend = (principalId) => request("DELETE", `/api/friends/${seg(principalId)}`);
export const blockPrincipal = (principalId) => request("PUT", `/api/blocks/${seg(principalId)}`);
export const unblockPrincipal = (principalId) => request("DELETE", `/api/blocks/${seg(principalId)}`);

// ───────── conversations
export const createGroup = ({ title, memberIds }) => request("POST", "/api/conversations", { title, memberIds });
/** One conversation in the shape of a `/api/sync` entry (404 when you are not a member now). */
export const getConversation = (conversationId) => request("GET", `/api/conversations/${seg(conversationId)}`);
export const renameGroup = (conversationId, title) => request("PATCH", `/api/conversations/${seg(conversationId)}`, { title });
export const listMembers = (conversationId) => request("GET", `/api/conversations/${seg(conversationId)}/members`);
export const addMember = (conversationId, principalId) => request("POST", `/api/conversations/${seg(conversationId)}/members`, { principalId });
export const removeMember = (conversationId, principalId) =>
  request("DELETE", `/api/conversations/${seg(conversationId)}/members/${seg(principalId)}`);

// ───────── messages
/**
 * body: {clientTxn, text?, attachmentId?, replyToSeq?}; reuse the same clientTxn when retrying. → {message, duplicate,
 * notCalled?: [{agentId, reason: "caller_rate_limited"}]} (only for me: calls my own limit kept from someone else's Agent)
 */
export const sendMessage = (conversationId, body) => request("POST", `/api/conversations/${seg(conversationId)}/messages`, body);
export const listMessages = (conversationId, { before, limit } = {}) =>
  request("GET", withQuery(`/api/conversations/${seg(conversationId)}/messages`, { before, limit }));
export const getMessage = (conversationId, seq) => request("GET", `/api/conversations/${seg(conversationId)}/messages/${seg(seq)}`);
export const markRead = (conversationId, seq) => request("POST", `/api/conversations/${seg(conversationId)}/read`, { seq });

// ───────── sync, catch-up and the socket
export const getSync = () => request("GET", "/api/sync");
/** positions: {[conversationId]: last seq held}. */
export const catchUp = (positions) => request("POST", "/api/sync/catchup", { positions });
export const requestWsTicket = () => request("POST", "/api/ws-ticket");

/** The WebSocket URL for a ticket: same origin as the page, ws: or wss: following its protocol. */
export function socketUrl(ticket) {
  const { protocol, host } = globalThis.location;
  return `${protocol === "https:" ? "wss:" : "ws:"}//${host}/api/ws?ticket=${seg(ticket)}`;
}

// ───────── Agents (owner only; app/service/README.md "Agents")
export const listAgents = () => request("GET", "/api/agents"); // → {agents: [Agent]}, oldest first, deleted ones included
/** body: {namePart (its handle is `<my handle>.<namePart>`), name, intro?, field?, persona?, replyMode?, groupMentions?, chainBudget?, othersBudget?, ownerAppellation?, reasoning?, model?} → Agent */
export const createAgent = (body) => request("POST", "/api/agents", body);
export const getAgent = (agentId) => request("GET", `/api/agents/${seg(agentId)}`);
/**
 * patch: any of {name, intro, field, persona, replyMode, groupMentions, chainBudget, othersBudget, ownerAppellation, reasoning,
 * model} (`model: null` clears it; `chainBudget` is a decimal string of points; `othersBudget` too, or `null` for unlimited;
 * `ownerAppellation` 1–20 characters, or `null` to clear) → Agent
 */
export const patchAgent = (agentId, patch) => request("PATCH", `/api/agents/${seg(agentId)}`, patch);
export const pauseAgent = (agentId) => request("POST", `/api/agents/${seg(agentId)}/pause`);
export const resumeAgent = (agentId) => request("POST", `/api/agents/${seg(agentId)}/resume`);
export const deleteAgent = (agentId) => request("DELETE", `/api/agents/${seg(agentId)}`);
/** How the Agent addresses another person or Agent (a friend of mine, or in a group it is in). body: {appellation} (1–20 characters) → Agent */
export const putAppellation = (agentId, principalId, body) => request("PUT", `/api/agents/${seg(agentId)}/appellations/${seg(principalId)}`, body);
export const deleteAppellation = (agentId, principalId) => request("DELETE", `/api/agents/${seg(agentId)}/appellations/${seg(principalId)}`);
/** Replaces the Agent's avatar with the image file (the rules of my own avatar) → {ok: true} */
export const uploadAgentAvatar = (agentId, file) =>
  requestBytes("PUT", `/api/agents/${seg(agentId)}/avatar`, file, file.type && file.type.startsWith("image/") ? file.type : "application/octet-stream");
/** body: {name, intro?, field?, model} → {persona} (returned, never stored) */
export const draftPersona = (body) => request("POST", "/api/agents/draft-persona", body);

// ───────── persona proposals
/** edits: optional {persona?, intro?, field?} to confirm instead of the proposal's own → Agent */
export const confirmProposal = (agentId, proposalId, edits) =>
  request("POST", `/api/agents/${seg(agentId)}/proposals/${seg(proposalId)}/confirm`, edits);
export const discardProposal = (agentId, proposalId) => request("POST", `/api/agents/${seg(agentId)}/proposals/${seg(proposalId)}/discard`);

// ───────── memory changes (the chip and the confirmation cards) → { status }
export const undoMemoryChange = (agentId, changeId) => request("POST", `/api/agents/${seg(agentId)}/memory/changes/${seg(changeId)}/undo`);
export const confirmMemoryChange = (agentId, changeId) => request("POST", `/api/agents/${seg(agentId)}/memory/changes/${seg(changeId)}/confirm`);
export const discardMemoryChange = (agentId, changeId) => request("POST", `/api/agents/${seg(agentId)}/memory/changes/${seg(changeId)}/discard`);

// ───────── whispers (悄悄话: notes in a conversation only I see, about my Agent there; app/service/README.md "Whispers")
/** → {whispers: WireWhisper[] (newest first), nextBefore}: mine there, before `before` (an afterSeq); 404 where I can have none. */
export const listWhispers = (conversationId, { before, limit } = {}) =>
  request("GET", withQuery(`/api/conversations/${seg(conversationId)}/whispers`, { before, limit }));
/**
 * 告诉他们 → the whisper as it is now (`accepted`; a found_elsewhere one `telling`). 409 stale_whisper when it is not open
 * (or offers no 告诉他们), 409 busy_run while a found_elsewhere one's told reply is under way.
 */
export const acceptWhisper = (whisperId) => request("POST", `/api/whispers/${seg(whisperId)}/accept`);
/** 不用 → the whisper, `declined`. */
export const declineWhisper = (whisperId) => request("POST", `/api/whispers/${seg(whisperId)}/decline`);

// ───────── the memory palace: 关于我 (mine, shared by my Agents) and an Agent's own notes and hearsay
// Note: {id, text, vault, unsure, origin: "review"|"owner"|"hearsay", source: {kind: "agent"|"group"|"manual", title}, createdAt, updatedAt};
// a room's counts are code points: {notes, used, limit}. Refusals: 422 note_refused, 409 room_full.
export const listMemoryNotes = () => request("GET", "/api/memory/notes");
/** body: {text, vault?} → Note */
export const addMemoryNote = (body) => request("POST", "/api/memory/notes", body);
/** patch: {text?, vault?} → Note */
export const patchMemoryNote = (noteId, patch) => request("PATCH", `/api/memory/notes/${seg(noteId)}`, patch);
export const deleteMemoryNote = (noteId) => request("DELETE", `/api/memory/notes/${seg(noteId)}`);
/** → {notes, used, limit, hearsay: [{id, text, speakerName, speakerHandle: string | null, group: {id, title} | null, saidAt}], hearsayUsed, hearsayLimit} */
export const getAgentMemory = (agentId) => request("GET", `/api/agents/${seg(agentId)}/memory`);
export const addAgentMemoryNote = (agentId, body) => request("POST", `/api/agents/${seg(agentId)}/memory/notes`, body);
export const patchAgentMemoryNote = (agentId, noteId, patch) => request("PATCH", `/api/agents/${seg(agentId)}/memory/notes/${seg(noteId)}`, patch);
export const deleteAgentMemoryNote = (agentId, noteId) => request("DELETE", `/api/agents/${seg(agentId)}/memory/notes/${seg(noteId)}`);
export const deleteHearsay = (agentId, hearsayId) => request("DELETE", `/api/agents/${seg(agentId)}/memory/hearsay/${seg(hearsayId)}`);
export const confirmHearsay = (agentId, hearsayId) => request("POST", `/api/agents/${seg(agentId)}/memory/hearsay/${seg(hearsayId)}/confirm`);

// ───────── an Agent's replies (runs) and new topics, by its conversation; in a group, by the group and the Agent
export const getRun = (conversationId) => request("GET", `/api/conversations/${seg(conversationId)}/run`); // → {run: Run | null}
/** A group's Agent replies → {runs: [{agentId, state: "replying" | "unavailable", run?}]} (`run` only for my Agents) */
export const getGroupRuns = (conversationId) => request("GET", `/api/conversations/${seg(conversationId)}/runs`);
export const stopRun = (conversationId, runId) => request("POST", `/api/conversations/${seg(conversationId)}/runs/${seg(runId)}/stop`);
/** In a group, `agentId` names which of my Agents' reply (sent as `{agentId}`); none in an Agent's conversation. → {run} */
export const retryRun = (conversationId, agentId) =>
  request("POST", `/api/conversations/${seg(conversationId)}/runs/retry`, agentId ? { agentId } : undefined);
export const dismissRun = (conversationId, agentId) =>
  request("POST", `/api/conversations/${seg(conversationId)}/runs/dismiss`, agentId ? { agentId } : undefined);
export const resetTopic = (conversationId) => request("POST", `/api/conversations/${seg(conversationId)}/topic`); // → {message}
/** 让 Agent 停下: the group's Agents stop calling each other (any person in the group) → {ok: true} */
export const haltAgents = (conversationId) => request("POST", `/api/conversations/${seg(conversationId)}/agents/halt`);

// ───────── model providers (the API key is sent in a body and never comes back: `keyLast4` only)
export const listProviders = () => request("GET", "/api/providers"); // → {providers: [Provider]}
/** body: {name, protocol, baseUrl, apiKey, models?} → Provider */
export const createProvider = (body) => request("POST", "/api/providers", body);
/** patch: any of {name, baseUrl, apiKey, models} → Provider */
export const patchProvider = (providerId, patch) => request("PATCH", `/api/providers/${seg(providerId)}`, patch);
export const deleteProvider = (providerId) => request("DELETE", `/api/providers/${seg(providerId)}`);
/**
 * With `model`: one tiny real call to that model; without: the model list is asked for. → {ok: true, mode: "chat" |
 * "list", latencyMs} or {ok: false, error: "provider_rejected" | "provider_unavailable" | "address_not_allowed",
 * upstreamStatus?, detail?: {upstreamStatus?, message?, redacted?}} (a 200 either way)
 */
export const testProvider = (providerId, model) =>
  request("POST", `/api/providers/${seg(providerId)}/test`, model === undefined ? undefined : { model });
/**
 * The provider's model list, nothing stored → {ok: true, listed: [{name, vision, pdf, reasoning, chat, added}], source:
 * "upstream" | "catalogue"} or a failure as testProvider's
 */
export const listProviderModels = (providerId) => request("POST", `/api/providers/${seg(providerId)}/models/list`);

// ───────── usage, points and the site's models
export const getUsage = () => request("GET", "/api/usage");
/** → {siteModels: [{id, label, tier, vision, pdf, reasoning, contextTokens}], providerDefaults: {contextTokens, maxOutputTokens}} */
export const getModels = () => request("GET", "/api/models");

// ───────── search
export const searchConversation = (conversationId, { q, before, limit }) =>
  request("GET", withQuery(`/api/conversations/${seg(conversationId)}/search`, { q, before, limit }));
export const searchAll = ({ q, before, limit }) => request("GET", withQuery("/api/search", { q, before, limit }));

// ───────── attachment and avatar URLs (uploads and image/file bytes are not JSON, so no request() here)
export const attachmentUploadUrl = (conversationId) => `/api/conversations/${seg(conversationId)}/attachments`;
/**
 * Uploads one file (multipart field `file`) → {id, name, size, inline}; send it with `sendMessage({attachmentId, …})`.
 * options: {onProgress(fraction 0..1), signal}. Aborting rejects with ApiError code "aborted".
 */
export function uploadAttachment(conversationId, file, options) {
  const form = new FormData();
  form.append("file", file, file.name);
  return upload(attachmentUploadUrl(conversationId), form, options);
}
export const attachmentUrl = (attachmentId) => `/api/attachments/${seg(attachmentId)}`;
/**
 * A principal's avatar. `version` is its `avatarVersion` (or, for my own avatar just after I changed it, a newer
 * cache-buster): a changed avatar is a new URL, fetched again at once. The service ignores it.
 */
export const avatarUrl = (principalId, version = 0) =>
  `/api/principals/${seg(principalId)}/avatar${version ? `?v=${encodeURIComponent(String(version))}` : ""}`;
export const myAvatarUploadUrl = () => "/api/me/avatar";
/** Replaces my avatar with the image file (PNG, JPEG or WebP, at most 2 MiB; the service decides by the bytes). → {ok: true} */
export const uploadAvatar = (file) => requestBytes("PUT", myAvatarUploadUrl(), file, file.type && file.type.startsWith("image/") ? file.type : "application/octet-stream");
