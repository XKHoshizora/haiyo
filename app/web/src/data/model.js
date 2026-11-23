// The client's copy of what the service said, as pure functions of (state, input) → state.
// Ids are the service's real ids (no "me" alias here; see viewmodel.js). Contract: app/service/README.md.
//
// Per conversation, `position` is the last seq applied by the seq rule (sync, catch-up, pushes): every
// visible message up to it is held. `messages[id]` is sorted by seq without duplicates; it may also hold
// my own sent messages beyond the position (an HTTP answer that overtook the pushes before it).
// `readSeq` is the read marker shown; `serverReadSeq` the one the service confirmed; `readsInFlight` the
// read requests not answered yet (only while there are some may `readSeq` run ahead of the service).
// `stays[id]` counts my departures from a conversation: an answer to a request made in an earlier stay
// must not reach the current one.
//
// `windows[id]` is a detached window: the messages around a search hit that lies outside what is held. The held
// list (`messages[id]`) keeps following the pushes untouched, so nothing arriving meanwhile is lost or misplaced;
// the window is only what the screen shows while it exists, and it never moves the position or the read marker.
// It is dropped when the person goes back to the newest messages, and absorbed into the held list as soon as it
// reaches it (see `settleWindow`).
//
// Agents (batch 2A). `runs[conversationId]` is the latest reply of the Agent of that conversation: the service's Run plus
// what the client knows of it —
//   `since`   the conversation's lastSeq when a push of this connection first named the run: its reply is the first
//             message of the Agent after it (pushes are in order with the conversation's messages);
//   `joined`  known only from an answer (`GET .../run`) or from before this connection, not in order with the pushes: it
//             is never streamed (its text so far is not sent again, and its reply may already be held);
//   `posted`  its reply (the stored message) is held;
//   `unknown` its state could not be fetched (a queued or running run that may long have ended): not shown.
// `streams[runId]` is the text and reasoning streamed so far (`delta` pushes) of a run that is running, in order and not
// posted: transient, never a message, never in search, unread or the preview, and gone when the message, a terminal
// `run`, a `gone` or a reconnect arrives. `dismissed[conversationId]` is the failed run I closed: an answer that still
// carries it does not bring it back. `avatarVersions[id]` is the version put in a principal's avatar URL: set by
// /api/sync and `principal` pushes, raised by every other answer that names one, and for my own avatar also a newer
// cache-buster the moment I change it (`bumpAvatar`).
//
// Agents in a group (batch 2C; an Agent's dedicated conversation keeps `runs` and `streams` as above).
// `groupRuns[conversationId][agentId]` is the latest reply of each Agent member of a group, as this reader may know
// it: for one of my Agents its Run (`{run, …}`: the `run` push to its owner), for anyone else's
// only its state (`{state: "replying" | "unavailable" | null, …}`: the reduced push every other member gets — whatever
// else such a push carries is never read). Nothing streams in a group. The flags are those of `runs`: `since` (the
// group's lastSeq when a push of this connection first named it), `joined` (known from an answer, `GET …/runs`, or from
// before this connection), `posted` (its reply is held: the Agent's next message after `since`, or any of its pushed
// messages), `unknown` (could not be fetched), and `dismissed` (the failed run I closed). A slot goes with its Agent:
// a pushed leave or removal notice of the Agent, or a member list without it, drops it (an owner's run that ended because
// the Agent was taken out stays until closed: it says so).
//
// Whispers (悄悄话, app/service/README.md "Whispers"). `whispers[conversationId][whisperId]` is a note only I see, about my
// Agent there, as the service sent it: never a message (it takes no seq, so nothing here counts it as one — position,
// unread, lastSeq), shown after the message it follows (`afterSeq`). An open one comes with /api/sync, catch-up, a `whisper`
// push or the list route; an answered or expired one stays as history. A `found_elsewhere` one's status is the service's to
// derive (its Redesign D): `telling` while its told reply is queued or running, `told` once that posted, `open` again — with
// `lastTellFailed` — when it ended without posting. Of two copies the one with the higher `revision` (the service computes
// it from that state: never lower for a later one) is kept, so an older copy never undoes a change — a copy saying open
// never reopens an answered or told one —, while open again after a failed tell is a later copy. A sync's list of open
// ones replaces the open ones held; a conversation that goes takes its whispers along. Two moments the service sends are
// kept as sent, for the view to keep (viewmodel.js `deadlinesOf`): an open `found_elsewhere` one's `openUntil` (it reads
// expired from then) and a told reply's run's `retryableUntil` (重试 is not offered from then).

import { isMemoryLanguage } from "./memoryLanguages.js";
import { mentionsIn } from "./mentions.js";

/** How many of its newest messages `GET /api/sync` returns per conversation (service: SYNC_MESSAGES_PER_CONVERSATION). */
export const SYNC_WINDOW = 30;

export function initial() {
  return {
    /** The signed-in principal from /api/sync: {id, handle, displayName, avatarVersion, email}. */
    me: null,
    /** Whose drafts and unsent messages these are; survives `resetKeepingDrafts`. */
    owner: null,
    synced: false,
    /**
     * id → {id, handle, displayName, kind, avatarVersion}; an Agent's also `ownerId`, `intro`, `field` (what a co-member
     * of a group is told of it). An Agent's owner never changes: once known it is kept (`withOwner`).
     */
    principals: {},
    conversations: {},
    /** conversation id → WireMessage[] (plus `clientTxn`, and `notCalled` when there was some, on my messages confirmed over HTTP). */
    messages: {},
    /** clientTxn → unsent message: {clientTxn, conversationId, text, replyToSeq, attachment, file, upload, at, afterSeq, status, error}. */
    pending: {},
    /** conversation id → composer text not sent yet. */
    drafts: {},
    /**
     * conversation id → a refused message's text and mentions to put back in its composer (`{n, text, mentions}`,
     * `refillComposer`), until the composer takes it (`takeRefill`).
     */
    refills: {},
    /** The last /api/social answer. */
    social: null,
    /** The site's Agent social switch, as the last sync said (`sync.social.enabled`); false until it says true. (Not `social`: that is /api/social's.) */
    socialOn: false,
    /** conversation id → how many times I left it (see `stayOf`). */
    stays: {},
    /** conversation id → detached window {n, messages, hasOlder, focusSeq} (see the header). */
    windows: {},
    /** principal id → the version in its avatar URL (see the header). */
    avatarVersions: {},
    /** agent id → my Agent as the service answers it (deleted ones included). */
    agents: {},
    /** provider id → my model provider: {id, name, protocol, baseUrl, keyLast4, models}. Never an API key. */
    providers: {},
    /** The last `GET /api/usage` answer (points are decimal strings), or null before it. */
    usage: null,
    /** The site's models from `GET /api/models`: [{id, label, tier, vision, pdf, reasoning, contextTokens}]. */
    siteModels: [],
    /**
     * Whether the site has a judgement model, so proactive replies can be turned on (`GET /api/models`); null until that
     * has answered (not known yet).
     */
    proactiveAvailable: null,
    /** What a provider model gets when its entry says nothing: {contextTokens, maxOutputTokens}, or null before it. */
    providerDefaults: null,
    /**
     * How far back turning an Agent's memory on again may look (`GET /api/models` `memoryCatchUp`): {days, lines}, or null
     * before it, or when the service does not say.
     */
    memoryCatchUp: null,
    /** conversation id → its latest run (see the header), or null when there is none to show. */
    runs: {},
    /** conversation id → the id of the failed run I dismissed (see the header). */
    dismissed: {},
    /** run id → {text, reasoning, cut?, reasoningCut?} streamed so far, each up to STREAM_CHARS (see the header). */
    streams: {},
    /** group id → Agent id → its latest reply there, as this reader may know it (see the header). */
    groupRuns: {},
    /** conversation id → whisper id → my whisper there (see the header). */
    whispers: {},
  };
}

/** Which of my stays in a conversation this is; changes whenever I leave it (or am found to have left). */
export const stayOf = (state, conversationId) => state.stays[conversationId] ?? 0;

const bumpStays = (stays, ids) => {
  if (ids.length === 0) return stays;
  const next = { ...stays };
  for (const id of ids) next[id] = (next[id] ?? 0) + 1;
  return next;
};

/**
 * A new stay in a conversation that is kept (re-added while away). Answers to requests of the earlier stay
 * are dropped (see `stayOf`), so nothing may wait for them: read requests stop counting and the marker
 * falls back to the confirmed one; unsent messages still sending become failed, keeping their clientTxn.
 * (Where the conversation itself is dropped — gone, sync, 404 — its counters and unsent messages go with it.)
 */
function startNewStay(state, conversationId) {
  let next = {
    ...state,
    stays: bumpStays(state.stays, [conversationId]),
    windows: without(state.windows, conversationId),
    whispers: without(state.whispers ?? {}, conversationId),
  };
  const conv = next.conversations[conversationId];
  if (conv) next = putConversation(next, backToConfirmedRead({ ...conv, readsInFlight: 0 }, next.messages[conversationId] ?? [], next.me?.id));
  const sending = Object.values(next.pending).filter((p) => p.conversationId === conversationId && p.status === "sending");
  if (sending.length === 0) return next;
  const pending = { ...next.pending };
  for (const p of sending) pending[p.clientTxn] = failedEntry(p, { code: "stale" });
  return { ...next, pending };
}

// ───────── helpers

/** An unsent entry that failed: no longer sending or uploading; its attachment (if the upload finished) stays. */
const failedEntry = (p, error) => ({
  ...p,
  status: "failed",
  upload: null,
  error: { code: error?.code ?? "unknown", reason: error?.reason ?? null },
});

const without = (obj, key) => {
  if (!(key in obj)) return obj;
  const { [key]: _gone, ...rest } = obj;
  return rest;
};

function filterValues(obj, keep) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (keep(v, k)) out[k] = v;
  return out;
}

/** What this page alone knows of a message of mine its send's answer returned (`markSent`), kept on its held copy. */
const LOCAL_KEYS = ["clientTxn", "notCalled"];

/** Merges ascending, seq-unique lists; on equal seqs the incoming copy wins but keeps what this page knows (`LOCAL_KEYS`). */
function mergeBySeq(held, incoming) {
  if (incoming.length === 0) return held;
  if (held.length === 0) return [...incoming].sort((a, b) => a.seq - b.seq);
  const bySeq = new Map(held.map((m) => [m.seq, m]));
  for (const m of incoming) {
    const old = bySeq.get(m.seq);
    const kept = old ? LOCAL_KEYS.filter((key) => m[key] == null && old[key] != null) : [];
    bySeq.set(m.seq, kept.length > 0 ? { ...m, ...Object.fromEntries(kept.map((key) => [key, old[key]])) } : m);
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/**
 * `wires` as this reader may keep them: in a group, a message of someone else's Agent (its owner is known and is not me)
 * loses its `reasoning` and its `via` (which model and level the reply used, what it cost) — the service sends them only
 * to the owner, and the store never holds more. While the sender's principal has not arrived the fields stay (the view
 * hides them), so my own Agent's are not lost when principals come late. `state` supplies `me`, `principals`, `agents`
 * and `conversations`.
 */
function withoutOthersPrivate(state, type, wires) {
  if (type !== "group" || !Array.isArray(wires)) return wires;
  let out = wires;
  wires.forEach((m, i) => {
    if (!m || (m.reasoning === undefined && m.via === undefined) || typeof m.senderId !== "string") return;
    if (typeof state.principals[m.senderId]?.ownerId !== "string" || ownsAgent(state, m.senderId)) return;
    if (out === wires) out = [...wires];
    const { reasoning: _thinking, via: _via, ...rest } = m;
    out[i] = rest;
  });
  return out;
}

/** The highest seq reachable from `seq` through consecutive held messages. */
function advance(list, seq) {
  let position = seq;
  const seqs = new Set(list.map((m) => m.seq));
  while (seqs.has(position + 1)) position += 1;
  return position;
}

/**
 * Counts towards unread: a visible message from someone else that is not a system notice, nor an Agent's acknowledgement
 * (`ack`: what its reply said before it looked something up — the answer after it counts).
 */
const countsAsUnread = (m, meId) => m.kind !== "system" && m.ack !== true && m.senderId !== null && m.senderId !== meId;

function unreadAfterReading(conv, list, meId, oldRead, newRead) {
  if (newRead >= conv.position) return 0;
  const nowRead = list.filter((m) => m.seq > oldRead && m.seq <= newRead && countsAsUnread(m, meId)).length;
  return Math.max(0, conv.unread - nowRead);
}

function metadata(entry) {
  const isGroup = entry.type === "group";
  const isAgent = entry.type === "agent";
  return {
    id: entry.id,
    type: entry.type,
    title: entry.title ?? null,
    // A direct chat has no creator role, whatever the entry says.
    creatorId: isGroup ? entry.creatorId ?? null : null,
    // A group's avatar: its change counter, or null for a group without one (the service sends it only when there is one).
    avatarVersion: isGroup && isVersion(entry.avatarVersion) ? entry.avatarVersion : null,
    myRole: entry.myRole,
    closed: Boolean(entry.closed),
    peerId: isGroup || isAgent ? null : entry.peerId ?? null,
    // An Agent's conversation: the Agent, and whether it is paused or deleted.
    agentId: isAgent ? entry.agentId ?? null : null,
    agent: isAgent ? { paused: Boolean(entry.agent?.paused), deleted: Boolean(entry.agent?.deleted) } : null,
    canSend: entry.canSend ?? { ok: false, reason: "closed" },
    members: entry.members ?? [],
    createdAt: entry.createdAt ?? null,
    // A social conversation: its participants and their Agents (`agent_social` only; nothing owner-only).
    ...(entry.type === "agent_social" ? { social: entry.social ?? null } : {}),
  };
}

// ───────── avatar versions

const isVersion = (v) => Number.isSafeInteger(v) && v >= 0;

/** Raises `id`'s version to `version` (never lowers it): an answer may be older than a push already applied. */
function raiseVersion(versions, id, version) {
  if (typeof id !== "string" || !isVersion(version) || (versions[id] ?? -1) >= version) return versions;
  return { ...versions, [id]: version };
}

function raiseVersionsOf(versions, principals) {
  let next = versions;
  for (const p of principals) if (p && typeof p.id === "string") next = raiseVersion(next, p.id, p.avatarVersion);
  return next;
}

/**
 * A `principal` push's `handle` (a rename; an Agent's full handle follows its owner's): the latest word, set wherever the
 * principal is held — its entry, my Agent's record, me. Not a string: no change.
 */
export function setPrincipalHandle(state, principalId, handle) {
  if (typeof principalId !== "string" || typeof handle !== "string" || handle === "") return state;
  let next = state;
  const entry = next.principals[principalId];
  if (entry && entry.handle !== handle) next = { ...next, principals: { ...next.principals, [principalId]: { ...entry, handle } } };
  const agent = next.agents?.[principalId];
  if (agent && agent.handle !== handle) next = { ...next, agents: { ...next.agents, [principalId]: { ...agent, handle } } };
  if (next.me?.id === principalId && next.me.handle !== handle) next = { ...next, me: { ...next.me, handle } };
  return next;
}

/**
 * My handle, changed (`PATCH /api/me`): me, my entry, and my Agents' full handles (`<my handle>.<name part>`), at once —
 * the pushes that follow say the same.
 */
export function applyMyHandle(state, handle) {
  if (!state.me || typeof handle !== "string" || handle === "") return state;
  const old = state.me.handle;
  let next = setPrincipalHandle(state, state.me.id, handle);
  const mine = (h) => typeof h === "string" && h.startsWith(`${old}.`);
  for (const [id, p] of Object.entries(next.principals)) {
    if (p?.kind === "agent" && p.ownerId === state.me.id && mine(p.handle)) next = setPrincipalHandle(next, id, `${handle}.${p.handle.slice(old.length + 1)}`);
  }
  for (const [id, a] of Object.entries(next.agents ?? {})) {
    if (mine(a?.handle)) next = setPrincipalHandle(next, id, `${handle}.${a.handle.slice(old.length + 1)}`);
  }
  return next;
}

/** A `principal` push: someone's avatar changed. The push is the latest word, so it sets the version. */
export function setAvatarVersion(state, principalId, version) {
  if (typeof principalId !== "string" || !isVersion(version) || state.avatarVersions[principalId] === version) return state;
  return { ...state, avatarVersions: { ...state.avatarVersions, [principalId]: version } };
}

// ───────── a reply in progress (runs and their streams)

/** Whether `m` is a message of the conversation's Agent (its reply), not a notice. */
const fromAgent = (conv, m) => conv.type === "agent" && Boolean(conv.agentId) && m.senderId === conv.agentId && m.kind !== "system";

/**
 * Messages arrived while the conversation's run is running; is one of them its reply (one run at a time, posted before
 * the run ends)? Then its stream is dropped and the run is marked posted, so no later delta brings the bubble back.
 * A pushed message (`pushed`: a push, also a duplicate of one already held) is in order with the run's push: any
 * message of the Agent after it is the reply. Messages from a snapshot or a page (sync, catch-up, history) are not in
 * that order: there the reply is a message of the Agent after the run's `since`. An acknowledgement (`ack`: what the
 * Agent said before it looked something up, posted as its own message while the reply goes on) is never the reply: a
 * pushed one only takes the place of what was streamed so far, and the run goes on being written.
 */
function notePosted(state, conversationId, arrived, pushed) {
  return noteGroupPosted(noteRunPosted(state, conversationId, arrived, pushed), conversationId, arrived, pushed);
}

function noteRunPosted(state, conversationId, arrived, pushed) {
  const conv = state.conversations[conversationId];
  const run = state.runs[conversationId];
  if (!conv || !run || run.status !== "running" || run.posted) return state;
  const said = arrived.filter((m) => fromAgent(conv, m));
  const replies = said.filter((m) => m.ack !== true);
  const isReply = pushed ? replies.length > 0 : typeof run.since === "number" && replies.some((m) => m.seq > run.since);
  if (!isReply) return pushed && said.length > 0 ? { ...state, streams: without(state.streams, run.id) } : state;
  return { ...state, runs: { ...state.runs, [conversationId]: { ...run, posted: true } }, streams: without(state.streams, run.id) };
}

/** Whether a group slot is a reply being written: my Agent's run queued or running, or someone else's `replying`. */
const replyingSlot = (slot) => ("run" in slot ? Boolean(slot.run) && isActive(slot.run.status) : slot.state === "replying");

/** The same rule in a group, for each Agent whose reply is being written: a message of that Agent is its reply. */
function noteGroupPosted(state, conversationId, arrived, pushed) {
  const slots = state.groupRuns[conversationId];
  if (!slots || arrived.length === 0) return state;
  let next = null;
  for (const [agentId, slot] of Object.entries(slots)) {
    if (!replyingSlot(slot) || slot.posted) continue;
    const replies = arrived.filter((m) => m.senderId === agentId && m.kind !== "system" && m.ack !== true);
    const isReply = pushed ? replies.length > 0 : typeof slot.since === "number" && replies.some((m) => m.seq > slot.since);
    if (!isReply) continue;
    next ??= { ...slots };
    next[agentId] = { ...slot, posted: true };
  }
  return next ? { ...state, groupRuns: { ...state.groupRuns, [conversationId]: next } } : state;
}

/** The slots of a group, `slots` (an empty map: none at all). */
function putGroupSlots(state, conversationId, slots) {
  const groupRuns = Object.keys(slots).length > 0 ? { ...state.groupRuns, [conversationId]: slots } : without(state.groupRuns, conversationId);
  return { ...state, groupRuns };
}

/** A pushed notice that an Agent left the group, or was taken out of it: its slot goes. */
function dropLeaver(state, conversationId, wire) {
  const event = wire.kind === "system" ? wire.system?.event : null;
  if (event !== "member_left" && event !== "member_removed") return state;
  const slots = state.groupRuns[conversationId];
  const who = wire.system.principalId;
  if (!slots || typeof who !== "string" || !(who in slots)) return state;
  return putGroupSlots(state, conversationId, without(slots, who));
}

/** An owner's run that ended because its Agent was taken out of the group: it stays, saying so, until closed. */
const REMOVED = "agent_removed";

/** Slots of Agents that are not members of the group (as its member list now says) go. */
function pruneGroupSlots(state, conversationId) {
  const slots = state.groupRuns[conversationId];
  const conv = state.conversations[conversationId];
  if (!slots || !conv) return state;
  const members = new Set(conv.members.map((m) => m.id));
  const kept = filterValues(slots, (slot, agentId) => members.has(agentId) || slot.run?.error === REMOVED);
  return Object.keys(kept).length === Object.keys(slots).length ? state : putGroupSlots(state, conversationId, kept);
}

/** A principal entry as an answer names it, keeping the owner known of an Agent when the answer does not say it. */
const withOwner = (held, p) => (typeof p.ownerId !== "string" && typeof held?.ownerId === "string" ? { ...p, ownerId: held.ownerId } : p);

function putConversation(state, conv, list) {
  return {
    ...state,
    conversations: { ...state.conversations, [conv.id]: conv },
    messages: list === undefined ? state.messages : { ...state.messages, [conv.id]: list },
  };
}

// ───────── sync, catch-up, pushes

/**
 * Applies `GET /api/sync`. Conversations it does not list are dropped. A window of fewer than
 * SYNC_WINDOW messages is everything visible, so it replaces what is held; a full window is merged when
 * it joins up with the held messages and otherwise replaces them (no hole is kept). My own messages
 * confirmed over HTTP after the snapshot are kept either way. Drafts and unsent messages of another
 * account are dropped.
 */
export function applySync(state, sync) {
  const meId = sync.me.id;
  const sameOwner = state.owner === null || state.owner === meId;
  const windows = new Map();
  for (const m of sync.messages) {
    const list = windows.get(m.conversationId) ?? [];
    list.push(m);
    windows.set(m.conversationId, list);
  }

  const principals = { ...state.principals };
  const avatarVersions = { ...state.avatarVersions };
  for (const p of sync.principals) {
    principals[p.id] = withOwner(principals[p.id], p);
    if (isVersion(p.avatarVersion)) avatarVersions[p.id] = p.avatarVersion;
  }
  if (isVersion(sync.me.avatarVersion)) avatarVersions[meId] = sync.me.avatarVersion;
  const viewer = { ...state, me: sync.me, principals };

  const conversations = {};
  const messages = {};
  sync.conversations.forEach((entry, index) => {
    const prev = state.conversations[entry.id];
    const held = prev ? state.messages[entry.id] ?? [] : [];
    const incoming = withoutOthersPrivate(viewer, entry.type, (windows.get(entry.id) ?? []).sort((a, b) => a.seq - b.seq));
    const inWindow = new Set(incoming.map((m) => m.seq));
    const complete = incoming.length < SYNC_WINDOW;
    const joins = Boolean(prev) && !complete && incoming[0].seq <= prev.position + 1;
    const kept = joins ? held : held.filter((m) => inWindow.has(m.seq) || m.seq > entry.lastSeq);
    const list = mergeBySeq(kept, incoming);
    let hasOlder;
    if (complete) hasOlder = false;
    else if (joins && held.length > 0 && held[0].seq < incoming[0].seq) hasOlder = prev.hasOlder;
    else hasOlder = list.length > 0 && list[0].seq > 1;

    const position = advance(list, joins || complete ? Math.max(prev?.position ?? 0, entry.lastSeq) : entry.lastSeq);
    const readsInFlight = prev?.readsInFlight ?? 0;
    const conv = {
      ...metadata(entry),
      lastSeq: entry.lastSeq,
      readSeq: entry.readSeq,
      serverReadSeq: entry.readSeq,
      readsInFlight,
      unread: entry.unread,
      peerReadSeq: entry.peerReadSeq ?? null,
      position,
      hasOlder,
      syncIndex: index,
    };
    if (readsInFlight > 0 && prev.readSeq > entry.readSeq) {
      // My read request is not answered yet: keep showing its marker until it is (markReadDone).
      conv.readSeq = prev.readSeq;
      conv.unread = unreadAfterReading(conv, list, meId, entry.readSeq, prev.readSeq);
    }
    if (prev?.peerReadSeq != null && (conv.peerReadSeq === null || prev.peerReadSeq > conv.peerReadSeq)) conv.peerReadSeq = prev.peerReadSeq;
    conversations[entry.id] = conv;
    messages[entry.id] = list;
  });

  const dropped = Object.keys(state.conversations).filter((id) => !(id in conversations));
  const pending = sameOwner ? filterValues(state.pending, (p) => p.conversationId in conversations) : {};
  const drafts = sameOwner ? filterValues(state.drafts, (_text, id) => id in conversations) : {};
  const detached = filterValues(state.windows, (_w, id) => id in conversations);
  // A conversation that is gone takes its run, stream and dismissed run with it.
  const runs = filterValues(state.runs, (_run, id) => id in conversations);
  const runIds = new Set(Object.values(runs).map((r) => r?.id));
  const streams = filterValues(state.streams, (_s, runId) => runIds.has(runId));
  let next = {
    ...state,
    me: sync.me,
    owner: meId,
    synced: true,
    socialOn: sync.social?.enabled === true,
    principals,
    avatarVersions,
    conversations,
    messages,
    pending,
    drafts,
    windows: detached,
    stays: bumpStays(state.stays, dropped),
    runs,
    streams,
    dismissed: filterValues(state.dismissed, (_runId, id) => id in conversations),
    // A group that is gone takes its Agents' replies with it; so does an Agent no longer among its members.
    groupRuns: filterValues(state.groupRuns, (_slots, id) => conversations[id]?.type === "group"),
    // My whispers: the answered and expired ones of the conversations kept stay; the open ones are this snapshot's.
    whispers: answeredWhispers(state.whispers ?? {}, conversations),
  };
  next = putWhispers(next, sync.whispers);
  for (const id of Object.keys(next.groupRuns)) next = pruneGroupSlots(next, id);
  // The Agent's reply may have come with this snapshot (its push then reads as a duplicate).
  for (const id of new Set([...Object.keys(runs), ...Object.keys(next.groupRuns)])) next = notePosted(next, id, windows.get(id) ?? [], false);
  return next;
}

/**
 * Applies one pushed message by the seq rule: `seq <= position` is a duplicate; `position + 1` is
 * appended; beyond that is a gap to repair with catch-up from the position (nothing is appended).
 * A duplicate still counts as the Agent's reply in push order (its copy came with a snapshot first); and a pushed
 * duplicate that carries a `via` I may keep — my Agent's reply pushed again once its run is charged — replaces the copy
 * held (`chargedCopy`).
 * `pushed: false` for a message of a catch-up page (not in push order).
 * @returns {{state, gap?: {conversationId: string, from: number}, unknown?: string}}
 */
export function applyMessage(state, wire, { pushed = true } = {}) {
  const id = wire.conversationId;
  const conv = state.conversations[id];
  if (!conv) return { state, unknown: id };
  if (wire.seq <= conv.position) return { state: pushed ? notePosted(chargedCopy(state, conv, wire), id, [wire], true) : state };
  if (wire.seq > conv.position + 1) return { state, gap: { conversationId: id, from: conv.position } };
  const list = mergeBySeq(state.messages[id] ?? [], withoutOthersPrivate(state, conv.type, [wire]));
  const position = advance(list, wire.seq);
  const unread = conv.unread + (wire.seq > conv.readSeq && countsAsUnread(wire, state.me?.id) ? 1 : 0);
  const next = notePosted(putConversation(state, { ...conv, position, lastSeq: Math.max(conv.lastSeq, position), unread }, list), id, [wire], pushed);
  // (Only a push is in order with the run pushes: a catch-up page may hold a leave from before the Agent came back.)
  return { state: pushed ? dropLeaver(next, id, wire) : next };
}

/**
 * Applies a `POST /api/sync/catchup` answer: drops the `gone` conversations and appends each
 * conversation's continuation, advancing the position message by message. Within one stay the
 * continuation starts at position + 1; a later start means I was removed and added again while away,
 * so what is held from before it belongs to the earlier stay and is dropped.
 */
export function applyCatchup(state, response) {
  let next = state;
  for (const id of response.gone ?? []) next = applyGone(next, id);
  for (const wire of response.messages ?? []) {
    const conv = next.conversations[wire.conversationId];
    if (!conv || wire.seq <= conv.position) continue;
    if (wire.seq > conv.position + 1) {
      const later = (next.messages[conv.id] ?? []).filter((m) => m.seq >= wire.seq);
      next = startNewStay(putConversation(next, { ...conv, position: wire.seq - 1, hasOlder: false }, later), conv.id);
    }
    next = applyMessage(next, wire, { pushed: false }).state;
  }
  // My whispers there: the open ones, and those made or answered since the position.
  return { state: putWhispers(next, response.whispers) };
}

/**
 * "Not a member now": the conversation, its messages, unsent messages, draft, run and stream (a group: its Agents'
 * replies) go; a new stay starts.
 * Idempotent.
 */
export function applyGone(state, conversationId) {
  if (!(conversationId in state.conversations)) return state;
  const run = state.runs[conversationId];
  return {
    ...state,
    conversations: without(state.conversations, conversationId),
    messages: without(state.messages, conversationId),
    pending: filterValues(state.pending, (p) => p.conversationId !== conversationId),
    drafts: without(state.drafts, conversationId),
    windows: without(state.windows, conversationId),
    stays: bumpStays(state.stays, [conversationId]),
    runs: without(state.runs, conversationId),
    streams: run ? without(state.streams, run.id) : state.streams,
    dismissed: without(state.dismissed, conversationId),
    groupRuns: without(state.groupRuns, conversationId),
    whispers: without(state.whispers ?? {}, conversationId),
  };
}

/**
 * Refreshes one held conversation's metadata (from `GET /api/conversations/:id`). Position, unread and
 * held messages stay: the pushes are the authority on those. Read markers only move forward.
 */
export function applyConversation(state, entry) {
  const prev = state.conversations[entry.id];
  if (!prev) return state;
  const readSeq = Math.max(prev.readSeq, entry.readSeq ?? 0);
  const list = state.messages[entry.id] ?? [];
  const peerReadSeq = entry.peerReadSeq == null ? prev.peerReadSeq : Math.max(prev.peerReadSeq ?? 0, entry.peerReadSeq);
  const next = putConversation(state, {
    ...prev,
    ...metadata(entry),
    createdAt: entry.createdAt ?? prev.createdAt,
    lastSeq: Math.max(prev.lastSeq, entry.lastSeq ?? 0),
    readSeq,
    serverReadSeq: Math.max(prev.serverReadSeq, entry.readSeq ?? 0),
    unread: readSeq > prev.readSeq ? unreadAfterReading(prev, list, state.me?.id, prev.readSeq, readSeq) : prev.unread,
    peerReadSeq,
  });
  // An Agent no longer among the members has no reply here any more.
  return pruneGroupSlots(next, entry.id);
}

/** Member ids of a held conversation that no principal entry names. */
export function unknownMembers(state, conversationId) {
  const conv = state.conversations[conversationId];
  return conv ? conv.members.map((m) => m.id).filter((id) => !(id in state.principals)) : [];
}

export function applySocial(state, social) {
  const named = social ? [...(social.friends ?? []), ...(social.blocked ?? []), ...(social.blockedBy ?? [])] : [];
  for (const r of [...(social?.incoming ?? []), ...(social?.outgoing ?? [])]) named.push(r?.principal);
  return { ...state, social, avatarVersions: raiseVersionsOf(state.avatarVersions, named) };
}

/**
 * Adds the people a message read names: the `principals` of history, single-message and search answers (a map
 * by id, the same public shape as in /api/sync; an array is accepted too). Absent or malformed: no change.
 */
export function applyPrincipals(state, principals) {
  const list = Array.isArray(principals) ? principals : principals && typeof principals === "object" ? Object.values(principals) : [];
  const valid = list.filter((p) => p && typeof p.id === "string" && typeof p.handle === "string" && typeof p.displayName === "string");
  if (valid.length === 0) return state;
  const next = { ...state.principals };
  for (const p of valid) next[p.id] = withOwner(next[p.id], p);
  return { ...state, principals: next, avatarVersions: raiseVersionsOf(state.avatarVersions, valid) };
}

/** Prepends an older page (`GET /api/conversations/:id/messages?before=`) and the people it names. */
export function applyOlder(state, conversationId, page) {
  const conv = state.conversations[conversationId];
  if (!conv) return state;
  const named = applyPrincipals(state, page.principals);
  const list = mergeBySeq(state.messages[conversationId] ?? [], withoutOthersPrivate(named, conv.type, page.messages ?? []));
  const next = putConversation(named, { ...conv, hasOlder: page.nextBefore !== null && page.nextBefore !== undefined }, list);
  return notePosted(next, conversationId, page.messages ?? [], false);
}

// ───────── the detached window around a search hit

/** The window reaches the held messages (or, with none held, the position): nothing lies between them to load. */
function touchesHeld(state, conv, list) {
  if (list.length === 0) return false;
  const newest = list[list.length - 1].seq;
  const held = state.messages[conv.id] ?? [];
  return held.length > 0 ? newest + 1 >= held[0].seq : newest >= conv.position;
}

/** The window joins the held list: its messages are merged in and it is gone; the older edge is the window's. */
function attachWindow(state, conv, win) {
  const held = state.messages[conv.id] ?? [];
  const list = mergeBySeq(held, win.messages);
  const position = advance(list, conv.position);
  const reachesOlder = held.length === 0 || (win.messages[0] && win.messages[0].seq <= held[0].seq);
  const next = putConversation(
    state,
    { ...conv, position, lastSeq: Math.max(conv.lastSeq, position), hasOlder: reachesOlder ? win.hasOlder : conv.hasOlder },
    list,
  );
  return { ...next, windows: without(next.windows, conv.id) };
}

/** Keeps the window apart while it does not reach the held messages; absorbs it when it does. */
function settleWindow(state, conv, win) {
  if (touchesHeld(state, conv, win.messages)) return attachWindow(state, conv, win);
  return { ...state, windows: { ...state.windows, [conv.id]: win } };
}

/**
 * Shows the window around `focusSeq` (a `GET .../messages?before=` page): the people it names are added. `n` numbers
 * the window, so answers of an older one are told apart. A page that reaches the held messages joins them instead.
 */
export function openWindow(state, conversationId, page, { focusSeq, n }) {
  const conv = state.conversations[conversationId];
  if (!conv) return state;
  const named = applyPrincipals(state, page.principals);
  const messages = mergeBySeq([], withoutOthersPrivate(named, conv.type, page.messages ?? []));
  const next = settleWindow(named, conv, { n, messages, hasOlder: page.nextBefore !== null && page.nextBefore !== undefined, focusSeq });
  return notePosted(next, conversationId, messages, false);
}

/** An older page for window `n`: prepended to it. An answer for another window, or none, changes nothing. */
export function applyOlderInWindow(state, conversationId, page, n) {
  const win = state.windows[conversationId];
  if (!win || win.n !== n) return state;
  const named = applyPrincipals(state, page.principals);
  const messages = mergeBySeq(win.messages, withoutOthersPrivate(named, state.conversations[conversationId]?.type, page.messages ?? []));
  const hasOlder = page.nextBefore !== null && page.nextBefore !== undefined;
  const next = { ...named, windows: { ...named.windows, [conversationId]: { ...win, messages, hasOlder } } };
  return notePosted(next, conversationId, page.messages ?? [], false);
}

/**
 * A newer page for window `n` (the messages after its newest one). The window joins the held messages once it reaches
 * them, or when the page holds nothing new (what lies between is then not visible to me).
 */
export function applyNewerInWindow(state, conversationId, page, n) {
  const win = state.windows[conversationId];
  const conv = state.conversations[conversationId];
  if (!win || !conv || win.n !== n) return state;
  const named = applyPrincipals(state, page.principals);
  const messages = mergeBySeq(win.messages, withoutOthersPrivate(named, conv.type, page.messages ?? []));
  const next = { ...win, messages };
  const settled = messages.length > win.messages.length ? settleWindow(named, conv, next) : attachWindow(named, conv, next);
  return notePosted(settled, conversationId, page.messages ?? [], false);
}

/** Back to the newest messages: the window is dropped. */
export function closeWindow(state, conversationId) {
  return conversationId in state.windows ? { ...state, windows: without(state.windows, conversationId) } : state;
}

/** `{conversationId: position}` for the held ones among `ids`. */
export function positionsOf(state, ids) {
  const out = {};
  for (const id of ids) if (state.conversations[id]) out[id] = state.conversations[id].position;
  return out;
}

// ───────── optimistic sends, keyed by clientTxn

/** A new unsent message, or a retry of one (it keeps its clientTxn, time and place). */
export function markSending(state, { clientTxn, conversationId, text = "", replyToSeq = null, attachment = null, mentions = [], at }) {
  const conv = state.conversations[conversationId];
  const old = state.pending[clientTxn];
  const entry = old
    ? { ...old, status: "sending", error: null }
    : { clientTxn, conversationId, text, replyToSeq, attachment, mentions, at, afterSeq: conv ? conv.position : 0, status: "sending", error: null };
  return { ...state, pending: { ...state.pending, [clientTxn]: entry } };
}

/**
 * The service stored it (`duplicate` or not): the unsent entry becomes the server's message, with what the answer told
 * me alone (`notCalled`): the Agents my own calls a minute on other people's Agents kept it from reaching, by id — held
 * with my copy while this page holds it, never stored or sent anywhere.
 */
export function markSent(state, clientTxn, wire, notCalled = null) {
  const ids = Array.isArray(notCalled) ? notCalled.filter((n) => n?.reason === "caller_rate_limited" && typeof n.agentId === "string").map((n) => n.agentId) : [];
  return applyPosted({ ...state, pending: without(state.pending, clientTxn) }, { ...wire, clientTxn, ...(ids.length > 0 ? { notCalled: ids } : {}) });
}

/**
 * A message of mine that an HTTP answer returned (a send, the new-topic notice): held at once, also beyond a gap (the
 * pushes before it follow); the position advances only when it is next.
 */
export function applyPosted(state, wire) {
  const conv = state.conversations[wire.conversationId];
  if (!conv) return state;
  const list = mergeBySeq(state.messages[wire.conversationId] ?? [], withoutOthersPrivate(state, conv.type, [wire]));
  const position = wire.seq === conv.position + 1 ? advance(list, wire.seq) : conv.position;
  return putConversation(state, { ...conv, position, lastSeq: Math.max(conv.lastSeq, wire.seq) }, list);
}

export function markFailed(state, clientTxn, error) {
  const p = state.pending[clientTxn];
  if (!p) return state;
  return { ...state, pending: { ...state.pending, [clientTxn]: failedEntry(p, error) } };
}

/**
 * A file picked for sending, not uploaded yet (or an upload being retried: the entry keeps its clientTxn, time and
 * place). `file` is {name, size}; `upload` is {phase: "queued" | "uploading", progress: 0..1} while the upload lasts.
 */
export function markUploading(state, { clientTxn, conversationId, text = "", replyToSeq = null, file, at }) {
  const conv = state.conversations[conversationId];
  const old = state.pending[clientTxn];
  const upload = { phase: "queued", progress: 0 };
  const entry = old
    ? { ...old, status: "sending", error: null, attachment: null, upload }
    : { clientTxn, conversationId, text, replyToSeq, attachment: null, file, at, afterSeq: conv ? conv.position : 0, status: "sending", error: null, upload };
  return { ...state, pending: { ...state.pending, [clientTxn]: entry } };
}

/** The upload started (progress omitted) or reached `progress` (0..1). */
export function setUploadProgress(state, clientTxn, progress) {
  const p = state.pending[clientTxn];
  if (!p?.upload) return state;
  const next = { phase: "uploading", progress: progress ?? p.upload.progress };
  if (next.phase === p.upload.phase && next.progress === p.upload.progress) return state;
  return { ...state, pending: { ...state.pending, [clientTxn]: { ...p, upload: next } } };
}

/** The upload finished: the entry now carries the attachment `{id, name, size, inline}` and is ready to be sent. */
export function setUploaded(state, clientTxn, attachment) {
  const p = state.pending[clientTxn];
  if (!p) return state;
  const { id, name, size, inline } = attachment;
  return { ...state, pending: { ...state.pending, [clientTxn]: { ...p, attachment: { id, name, size, inline: Boolean(inline) }, upload: null } } };
}

/** Removes an unsent entry (a cancelled upload). */
export function discardPending(state, clientTxn) {
  return clientTxn in state.pending ? { ...state, pending: without(state.pending, clientTxn) } : state;
}

/**
 * A failed text message goes back to its composer: its text and mentions are put there (`refills`, which the composer
 * takes, Composer.jsx) and the unsent entry goes. Fix round 1, I-2: a message the service refused for a stale mention
 * is never sent again as it is, nor without its mentions.
 */
export function refillComposer(state, clientTxn) {
  const p = state.pending[clientTxn];
  if (!p || p.status !== "failed" || p.file || p.attachment) return state;
  const n = (state.refills?.[p.conversationId]?.n ?? 0) + 1;
  return {
    ...discardPending(state, clientTxn),
    refills: { ...(state.refills ?? {}), [p.conversationId]: { n, text: p.text ?? "", mentions: Array.isArray(p.mentions) ? p.mentions : [] } },
  };
}

/** The composer of `conversationId` took what was put back for it (`refillComposer`). */
export function takeRefill(state, conversationId) {
  return state.refills?.[conversationId] ? { ...state, refills: without(state.refills, conversationId) } : state;
}

/** The service's verdict on sending here, e.g. from a `cannot_send` refusal. */
export function setCanSend(state, conversationId, canSend) {
  const conv = state.conversations[conversationId];
  return conv ? putConversation(state, { ...conv, canSend }) : state;
}

// ───────── read markers and drafts

/** Moves the shown marker forward to `seq` (never back) and recomputes unread. */
function showRead(state, conv, seq, fields = {}) {
  const forward = seq > conv.readSeq;
  const unread = forward ? unreadAfterReading(conv, state.messages[conv.id] ?? [], state.me?.id, conv.readSeq, seq) : conv.unread;
  return putConversation(state, { ...conv, ...fields, readSeq: forward ? seq : conv.readSeq, unread });
}

/** My read marker as the service confirmed it (a `read` push or the answer to my request): only forward. */
export function setRead(state, conversationId, seq) {
  const conv = state.conversations[conversationId];
  if (!conv || (seq <= conv.readSeq && seq <= conv.serverReadSeq)) return state;
  return showRead(state, conv, seq, { serverReadSeq: Math.max(conv.serverReadSeq, seq) });
}

/** A read request was sent: its marker shows at once, and stays while the request is unanswered. */
export function markReading(state, conversationId, seq) {
  const conv = state.conversations[conversationId];
  if (!conv) return state;
  return showRead(state, conv, seq, { readsInFlight: conv.readsInFlight + 1 });
}

/**
 * A read request was answered: `confirmed` is the service's marker, or null when it failed. Once no
 * request is left unanswered, the marker shown falls back to the confirmed one (unread comes back).
 */
export function markReadDone(state, conversationId, confirmed) {
  const conv = state.conversations[conversationId];
  if (!conv) return state;
  const readsInFlight = Math.max(0, conv.readsInFlight - 1);
  if (Number.isSafeInteger(confirmed)) {
    return showRead(state, conv, confirmed, { readsInFlight, serverReadSeq: Math.max(conv.serverReadSeq, confirmed) });
  }
  if (readsInFlight > 0) return putConversation(state, { ...conv, readsInFlight });
  return putConversation(state, backToConfirmedRead({ ...conv, readsInFlight }, state.messages[conversationId] ?? [], state.me?.id));
}

/** The shown read marker falls back to the one the service confirmed; what it covered counts as unread again. */
function backToConfirmedRead(conv, list, meId) {
  if (conv.readSeq <= conv.serverReadSeq) return conv;
  const unreadAgain = list.filter((m) => m.seq > conv.serverReadSeq && m.seq <= conv.readSeq && countsAsUnread(m, meId)).length;
  return { ...conv, readSeq: conv.serverReadSeq, unread: conv.unread + unreadAgain };
}

/** The other side's read marker in a direct chat: max(current, seq). */
export function setPeerRead(state, conversationId, seq) {
  const conv = state.conversations[conversationId];
  if (!conv || (conv.peerReadSeq !== null && seq <= conv.peerReadSeq)) return state;
  return putConversation(state, { ...conv, peerReadSeq: seq });
}

/**
 * A conversation's draft: its text, or — while it holds mentions picked from the @ list — `{text, mentions}` (the
 * mentions' ranges in that text, data/mentions.js), so a draft keeps its tags. Nothing for an empty draft.
 */
export function setDraft(state, conversationId, text, mentions = []) {
  const draft = Array.isArray(mentions) && mentions.length > 0 && text ? { text, mentions: mentions.map(({ id, start, length }) => ({ id, start, length })) } : text;
  if (JSON.stringify(state.drafts[conversationId] ?? "") === JSON.stringify(draft)) return state;
  return { ...state, drafts: draft ? { ...state.drafts, [conversationId]: draft } : without(state.drafts, conversationId) };
}

/**
 * Forgets everything the service said (on stop / sign-out) but keeps this account's drafts and unsent
 * messages; one still in flight becomes failed (a retry reuses its clientTxn, so it cannot double).
 */
export function resetKeepingDrafts(state) {
  const pending = {};
  for (const [k, p] of Object.entries(state.pending)) pending[k] = p.status === "sending" ? failedEntry(p, { code: "network_error" }) : p;
  return { ...initial(), owner: state.owner, drafts: state.drafts, pending };
}

// ───────── my profile

/** `PATCH /api/me` answered: my name as stored, in `me` and in my principal entry (message senders read it). */
export function applyMyName(state, displayName) {
  if (!state.me) return state;
  const me = { ...state.me, displayName };
  const entry = state.principals[me.id];
  return { ...state, me, principals: entry ? { ...state.principals, [me.id]: { ...entry, displayName } } : state.principals };
}

/**
 * An avatar I just changed (mine by default, or one of my Agents'): every URL of it gets a new version at once, so the
 * browser fetches it again; `version` when it is newer than the one held, else the next one. The push that follows
 * sets the service's own number.
 */
export function bumpAvatar(state, version, principalId = state.me?.id) {
  if (typeof principalId !== "string") return state;
  const current = state.avatarVersions[principalId] ?? 0;
  return { ...state, avatarVersions: { ...state.avatarVersions, [principalId]: version > current ? version : current + 1 } };
}

// ───────── my Agents

const isAgentRecord = (a) => a && typeof a.id === "string" && typeof a.handle === "string" && typeof a.name === "string";

/** The Agent's principal entry follows the Agent (its name now, for notices and senders); its avatar version only rises. */
function nameAgent(state, agent) {
  const entry = { ...(state.principals[agent.id] ?? {}), id: agent.id, handle: agent.handle, displayName: agent.name, kind: "agent" };
  return {
    ...state,
    principals: { ...state.principals, [agent.id]: entry },
    avatarVersions: raiseVersion(state.avatarVersions, agent.id, agent.avatarVersion),
  };
}

/** `GET /api/agents`: the whole list (deleted ones included) replaces what is held. */
export function applyAgents(state, list) {
  const valid = (Array.isArray(list) ? list : []).filter(isAgentRecord);
  const agents = {};
  for (const a of valid) agents[a.id] = a;
  let next = { ...state, agents };
  for (const a of valid) next = nameAgent(next, a);
  return next;
}

/** One Agent as an answer (`GET`, create, edit, pause, resume, delete, confirm) returned it. */
export function applyAgent(state, agent) {
  if (!isAgentRecord(agent)) return state;
  return nameAgent({ ...state, agents: { ...state.agents, [agent.id]: agent } }, agent);
}

/** An Agent the service no longer knows as mine. */
export function dropAgent(state, agentId) {
  return agentId in state.agents ? { ...state, agents: without(state.agents, agentId) } : state;
}

// ───────── the memory palace (rooms are held by the pages that show them, not in the model: they are read when opened)

const isNote = (n) =>
  n && typeof n.id === "string" && typeof n.text === "string" && typeof n.createdAt === "string" && n.source && typeof n.source === "object";
const isHeard = (h) => h && typeof h.id === "string" && typeof h.text === "string" && typeof h.speakerName === "string";
const count = (n) => (Number.isFinite(n) && n >= 0 ? n : 0);

/**
 * A room as `GET /api/memory/notes` or `GET /api/agents/:id/memory` answers it, with only what the pages read: the notes
 * (vault flag and `unsure` as booleans), the characters used and the room's limit (code points), and for an Agent what it
 * heard with its own count, and whether the Agent's model carries the whole palace (`fits`, true unless the service says false). A malformed answer is no room (null).
 */
export function memoryRoomOf(answer) {
  if (!answer || !Array.isArray(answer.notes) || !Number.isFinite(answer.limit)) return null;
  const notes = answer.notes.filter(isNote).map((n) => ({ ...n, vault: n.vault === true, unsure: n.unsure === true }));
  const room = { notes, used: count(answer.used), limit: answer.limit, maxNotes: Number.isFinite(answer.maxNotes) && answer.maxNotes > 0 ? answer.maxNotes : undefined, fits: answer.fits !== false, hearsay: null, hearsayUsed: 0, hearsayLimit: 0 };
  if (Array.isArray(answer.hearsay)) {
    room.hearsay = answer.hearsay.filter(isHeard).map((h) => ({ ...h, group: h.group && typeof h.group === "object" ? h.group : null }));
    room.hearsayUsed = count(answer.hearsayUsed);
    room.hearsayLimit = count(answer.hearsayLimit);
  }
  return room;
}

/** How my new notes are sorted, as `GET /api/me` says it: "auto" (the default), "vault" or "open". */
export const newNotesOf = (me) => (me?.newNotes === "vault" || me?.newNotes === "open" ? me.newNotes : "auto");

/** The model I chose to tidy my memory, as `GET /api/me` says it: a site or a provider model, else null (the site's). */
export const memoryModelOf = (me) => {
  const m = me?.memoryModel;
  if (m?.source === "site" && typeof m.id === "string") return { source: "site", id: m.id };
  if (m?.source === "provider" && typeof m.providerId === "string" && typeof m.model === "string") return { source: "provider", providerId: m.providerId, model: m.model };
  return null;
};

/** The one language my notes are written in, as `GET /api/me` says it: one of the codes, else null (automatic). */
export const memoryLanguageOf = (me) => (isMemoryLanguage(me?.memoryLanguage) ? me.memoryLanguage : null);

/** What the memory settings of `GET /api/me` hold: how new notes are sorted, whether they are tidied while I rest (`dream`; absent: off), the language they are written in, and the model that tidies them (and whether it can be used now). */
export const memorySettingsOf = (me) => ({
  newNotes: newNotesOf(me),
  dream: me?.dream === true,
  memoryLanguage: memoryLanguageOf(me),
  memoryModel: memoryModelOf(me),
  memoryModelUsable: me?.memoryModelUsable !== false,
});

// ───────── persona proposal cards

/** Whether `m` is a memory-change notice (`memory_changed`) still waiting for the owner's decision. */
const pendingMemoryChange = (m) => m.system?.event === "memory_changed" && m.system.status === "pending";

/**
 * The conversation of `agentId` (held) and the seqs of its messages, held or in a window, whose proposal is still open
 * or whose memory-change card still waits for a decision (both are cards that may be decided elsewhere).
 */
export function openProposals(state, agentId) {
  const conversationId =
    state.agents[agentId]?.conversationId ?? Object.values(state.conversations).find((c) => c.agentId === agentId)?.id ?? null;
  if (!conversationId || !state.conversations[conversationId]) return { conversationId: null, seqs: [] };
  const seqs = new Set();
  const shown = [...(state.messages[conversationId] ?? []), ...(state.windows[conversationId]?.messages ?? [])];
  for (const m of shown) if (m.proposal?.status === "open" || pendingMemoryChange(m)) seqs.add(m.seq);
  return { conversationId, seqs: [...seqs].sort((a, b) => a - b) };
}

/** Replaces `list`'s message with `wire`'s seq (keeping a known clientTxn); the same list when there is none. */
function replaceBySeq(list, wire) {
  const at = list.findIndex((m) => m.seq === wire.seq);
  if (at < 0) return list;
  const next = [...list];
  next[at] = list[at].clientTxn ? { ...wire, clientTxn: list[at].clientTxn } : wire;
  return next;
}

/**
 * A pushed duplicate of a message held (`applyMessage`): when it brings a `via` (my Agent's reply pushed again once its
 * run is charged; someone else's Agent's loses it first) it replaces the copy held and a window's (`applyMessageUpdate`);
 * otherwise nothing changes.
 */
function chargedCopy(state, conv, wire) {
  const [kept] = withoutOthersPrivate(state, conv.type, [wire]);
  // (A memory-change notice is pushed again when its status changes: undone, confirmed, discarded.)
  return kept?.via === undefined && kept?.system?.event !== "memory_changed" ? state : applyMessageUpdate(state, kept);
}

/**
 * A message fetched again (`GET /api/conversations/:id/messages/:seq`, a proposal card after an `agent` push): the copy
 * held, and the one in a detached window, are replaced. Nothing is added and no position moves.
 */
export function applyMessageUpdate(state, wire) {
  const id = wire?.conversationId;
  if (!state.conversations[id] || !Number.isSafeInteger(wire.seq)) return state;
  const held = state.messages[id] ?? [];
  const [kept] = withoutOthersPrivate(state, state.conversations[id].type, [wire]);
  const list = replaceBySeq(held, kept);
  const win = state.windows[id];
  const shown = win ? replaceBySeq(win.messages, kept) : null;
  let next = state;
  if (list !== held) next = { ...next, messages: { ...next.messages, [id]: list } };
  if (win && shown !== win.messages) next = { ...next, windows: { ...next.windows, [id]: { ...win, messages: shown } } };
  return next;
}

/** My confirmation or discard was answered: the card says so at once (the `agent` push refetches the others). */
export function setProposalStatus(state, conversationId, proposalId, status) {
  const mark = (list) => list.map((m) => (m.proposal?.id === proposalId ? { ...m, proposal: { ...m.proposal, status } } : m));
  if (!state.conversations[conversationId]) return state;
  const win = state.windows[conversationId];
  return {
    ...state,
    messages: { ...state.messages, [conversationId]: mark(state.messages[conversationId] ?? []) },
    windows: win ? { ...state.windows, [conversationId]: { ...win, messages: mark(win.messages) } } : state.windows,
  };
}

/**
 * My undo, confirmation or discard of a memory change was answered with its new `status`: the notice says so at once (the
 * service pushes it again with the same status). Nothing changes for a change not held.
 */
export function setMemoryChangeStatus(state, conversationId, changeId, status) {
  const mark = (list) =>
    list.map((m) => (m.system?.event === "memory_changed" && m.system.changeId === changeId ? { ...m, system: { ...m.system, status, pending: status === "pending" } } : m));
  if (!state.conversations[conversationId]) return state;
  const win = state.windows[conversationId];
  return {
    ...state,
    messages: { ...state.messages, [conversationId]: mark(state.messages[conversationId] ?? []) },
    windows: win ? { ...state.windows, [conversationId]: { ...win, messages: mark(win.messages) } } : state.windows,
  };
}

// ───────── whispers (see the header)

const WHISPER_STATUSES = new Set(["open", "telling", "told", "accepted", "declined", "expired"]);
const WHISPER_ACTIONS = new Set(["tell", "dismiss"]);

/** At most this many hits of a `found_elsewhere` whisper are kept (the service sends at most 5). */
const WHISPER_HITS_MAX = 5;
const HIT_KEYS = ["where", "who", "when", "text"];

/**
 * What a `found_elsewhere` whisper found (its `detail.hits`, sent to me alone: README "Whispers"): each hit with its four
 * strings, at most WHISPER_HITS_MAX; a hit that is not one is left out.
 */
function hitsOf(w) {
  const hits = w.kind === "found_elsewhere" ? w.detail?.hits : null;
  if (!Array.isArray(hits)) return [];
  return hits
    .filter((h) => h && typeof h === "object" && HIT_KEYS.every((k) => typeof h[k] === "string"))
    .slice(0, WHISPER_HITS_MAX)
    // (Its message's mentions that fit the text shown, ids as sent: drawn by the one drawn-text function.)
    .map(({ where, who, when, text, mentions }) => ({ where, who, when, text, mentions: mentionsIn(text, mentions) }));
}

/** A moment the service sent (an ISO instant). */
const isMoment = (value) => typeof value === "string" && !Number.isNaN(Date.parse(value));

/** A whisper as the service sends it (README "Whispers"), only the fields shown; null when it is not one. */
function whisperOf(w) {
  if (!w || typeof w !== "object" || typeof w.id !== "string" || typeof w.conversationId !== "string") return null;
  if (!Number.isSafeInteger(w.afterSeq) || w.afterSeq < 0 || typeof w.text !== "string" || !WHISPER_STATUSES.has(w.status)) return null;
  const hits = hitsOf(w);
  return {
    id: w.id,
    conversationId: w.conversationId,
    agentId: typeof w.agentId === "string" ? w.agentId : null,
    afterSeq: w.afterSeq,
    kind: typeof w.kind === "string" ? w.kind : null,
    text: w.text,
    actions: Array.isArray(w.actions) ? [...new Set(w.actions.filter((a) => WHISPER_ACTIONS.has(a)))] : [],
    status: w.status,
    createdAt: typeof w.createdAt === "string" ? w.createdAt : null,
    revision: Number.isSafeInteger(w.revision) ? w.revision : 0,
    ...(w.lastTellFailed === true ? { lastTellFailed: true } : {}),
    // An open found_elsewhere one reads expired from then (its day): the view says so at that moment (viewmodel.js).
    ...(isMoment(w.openUntil) ? { openUntil: w.openUntil } : {}),
    ...(hits.length > 0 ? { hits } : {}),
  };
}

/** The answered and expired whispers held of the conversations in `kept` (an open one's state is the next snapshot's). */
function answeredWhispers(held, kept) {
  const out = {};
  for (const [id, byId] of Object.entries(held)) {
    if (!(id in kept)) continue;
    const answered = filterValues(byId, (w) => w.status !== "open");
    if (Object.keys(answered).length > 0) out[id] = answered;
  }
  return out;
}

/**
 * `list` put into the held whispers of their conversations (one not held keeps none). A copy of a lower `revision` than the
 * one held never replaces it; of the same revision, an answer is never undone by a copy saying open (the order before
 * revisions were sent).
 */
function putWhispers(state, list) {
  if (!Array.isArray(list) || list.length === 0) return state;
  const before = state.whispers ?? {};
  let whispers = before;
  for (const raw of list) {
    const w = whisperOf(raw);
    if (!w || !state.conversations[w.conversationId]) continue;
    const held = whispers[w.conversationId]?.[w.id];
    if (held && (w.revision < held.revision || (w.revision === held.revision && held.status !== "open" && w.status === "open"))) continue;
    whispers = { ...whispers, [w.conversationId]: { ...(whispers[w.conversationId] ?? {}), [w.id]: w } };
  }
  return whispers === before ? state : { ...state, whispers };
}

/** A whisper pushed (`whisper`), or answered by my own request: put in, or replacing the copy held. */
export const applyWhisper = (state, wire) => putWhispers(state, [wire]);
/** A page of the list route (`GET /api/conversations/:id/whispers`): merged into the held ones. */
export const applyWhispers = (state, list) => putWhispers(state, list);
/** A whisper the service no longer has (404): gone from the held ones. */
export function dropWhisper(state, conversationId, whisperId) {
  const held = state.whispers?.[conversationId];
  if (!held || !(whisperId in held)) return state;
  const rest = without(held, whisperId);
  return { ...state, whispers: Object.keys(rest).length > 0 ? { ...state.whispers, [conversationId]: rest } : without(state.whispers, conversationId) };
}
/** Whether I may have whispers in a held conversation: my Agent's own, one with an Agent of mine among its members, or one I hold whispers of. */
export function mayWhisper(state, conversationId) {
  const conv = state.conversations[conversationId];
  if (!conv) return false;
  if (conv.type === "agent" || Object.keys(state.whispers?.[conversationId] ?? {}).length > 0) return true;
  return conv.members.some((m) => m.id !== state.me?.id && ownsAgent(state, m.id));
}

// ───────── runs and streams

const RUN_RANK = { queued: 0, running: 1 };
const runRank = (status) => RUN_RANK[status] ?? 2;

function wireRun(run) {
  const out = { id: run.id, status: run.status, retryable: Boolean(run.retryable) };
  if (typeof run.error === "string") out.error = run.error;
  if (typeof run.resetsAt === "string") out.resetsAt = run.resetsAt;
  // A told reply's 重试 is offered until then (its whisper's day): the view stops offering it at that moment (viewmodel.js).
  if (isMoment(run.retryableUntil)) out.retryableUntil = run.retryableUntil;
  return out;
}

const isActive = (status) => status === "queued" || status === "running";

/** The kinds of a tool's work a running reply's status may say (a `run` push's `activity`); anything else is none. */
const ACTIVITIES = new Set(["search", "file", "time", "web"]);
const isActivity = (value) => typeof value === "string" && ACTIVITIES.has(value);

/** Whether a message of the conversation's Agent after `since` is held (or shown in a detached window). */
function heldReplyAfter(state, conversationId, since) {
  const conv = state.conversations[conversationId];
  const shown = [...(state.messages[conversationId] ?? []), ...(state.windows[conversationId]?.messages ?? [])];
  return shown.some((m) => m.seq > since && fromAgent(conv, m));
}

/**
 * The latest run of a held conversation, or null for none. `ordered`: it comes in order with this connection's pushes
 * (a `run` push; the answer of my own retry that replaces the failed run it retried). Otherwise it is an answer
 * (`GET .../run`) that may be older than the pushes already applied, so:
 * - it never replaces a run named by a push of this connection with another run or with none (a `null` read before
 *   that run existed would hide it; a failure dismissed in another tab stays here until dismissed here or reconnected);
 * - the run it brings is `joined` (never streamed: its text so far is not sent again, its reply may already be held).
 * An ordered run gets its `since`: the conversation's lastSeq now, or for a push that waited while a snapshot was
 * fetched (`since` given) the lastSeq from before that snapshot; a message of the Agent already held after it is the
 * run's reply (the snapshot brought it), so the run is posted at once.
 * Either way the same run's status only moves forward and it keeps what is known of it (`posted`, `since`); a failed
 * run I dismissed does not come back; a run that is not running, or not in order, has no stream; a newer run ends the
 * older one's stream. `activity`: what the push says its tool is doing now (`search`, `file`, `time`), kept on a run
 * that is running and in order only; every push says it anew (one without it: nothing is being looked at).
 */
export function applyRun(state, conversationId, run, { ordered = true, since, activity } = {}) {
  const conv = state.conversations[conversationId];
  if (!conv) return state;
  if (run !== null && !(run && typeof run.id === "string" && typeof run.status === "string")) return state;
  const prev = state.runs[conversationId] ?? null;
  let next = run === null ? null : wireRun(run);
  if (next && next.status === "failed" && state.dismissed[conversationId] === next.id) next = null;
  if (!ordered && prev && !prev.joined && (next === null || next.id !== prev.id)) return state;
  const from = typeof since === "number" ? since : conv.lastSeq;
  let placed = false;
  if (next && prev && prev.id === next.id) {
    if (runRank(next.status) < runRank(prev.status)) return state;
    if (prev.posted) next.posted = true;
    if (ordered && prev.joined) placed = true; // from now on in order with the pushes
    else if (prev.joined) next.joined = true;
    else next.since = prev.since;
  } else if (next) {
    if (ordered) placed = true;
    else next.joined = true;
  }
  if (placed) {
    next.since = from;
    if (!next.posted && heldReplyAfter(state, conversationId, from)) next.posted = true;
  }
  if (next && ordered && !next.joined && next.status === "running" && isActivity(activity)) next.activity = activity;
  let streams = state.streams;
  if (prev && prev.id !== next?.id) streams = without(streams, prev.id);
  if (next && (next.status !== "running" || next.joined)) streams = without(streams, next.id);
  return { ...state, runs: { ...state.runs, [conversationId]: next }, streams };
}

/**
 * The most characters kept (and shown) of a reply being written, and of its thinking: what a run streams beyond them is
 * dropped. The bubble lays out its whole text on every piece, so its text has an end; the stored message, when it
 * arrives, replaces the bubble whatever was kept here.
 */
export const STREAM_CHARS = 20000;

/**
 * `kept` with `added` after it: `[text, cut]`. Up to STREAM_CHARS, never ending in half a surrogate pair; `cut` when
 * something of `added` was dropped. Once `wasCut`, nothing is added any more (not even where the cut left room for
 * one more unit: the text would go on after a gap).
 */
function streamedUpTo(kept, added, wasCut) {
  if (wasCut) return [kept, true];
  if (!added) return [kept, false];
  const room = STREAM_CHARS - kept.length;
  if (added.length <= room) return [kept + added, false];
  let take = added.slice(0, room);
  const last = take.charCodeAt(take.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) take = take.slice(0, -1);
  return [kept + take, true];
}

/**
 * A `delta` push: appended to the stream of the conversation's run only while that run is running, in order with this
 * connection's pushes, and its message has not arrived; anything else (an unknown, joined or finished run, another
 * conversation's) is ignored. The stream keeps the first STREAM_CHARS characters of the text and of the thinking;
 * `cut` / `reasoningCut` (only when true) say that more came and was dropped. A delta that changes nothing that is
 * kept returns the same state.
 */
export function applyDelta(state, { conversationId, runId, text, reasoning } = {}) {
  const run = state.runs[conversationId];
  if (!run || run.id !== runId || run.status !== "running" || run.posted || run.joined || run.unknown) return state;
  const addText = typeof text === "string" ? text : "";
  const addReasoning = typeof reasoning === "string" ? reasoning : "";
  if (!addText && !addReasoning) return state;
  const prev = state.streams[runId] ?? { text: "", reasoning: "" };
  const [nextText, cut] = streamedUpTo(prev.text, addText, Boolean(prev.cut));
  const [nextReasoning, reasoningCut] = streamedUpTo(prev.reasoning, addReasoning, Boolean(prev.reasoningCut));
  const next = { text: nextText, reasoning: nextReasoning };
  if (cut) next.cut = true;
  if (reasoningCut) next.reasoningCut = true;
  if (next.text === prev.text && next.reasoning === prev.reasoning && next.cut === prev.cut && next.reasoningCut === prev.reasoningCut) return state;
  return { ...state, streams: { ...state.streams, [runId]: next } };
}

/**
 * A new connection: what was streamed before it is not sent again, so every stream goes; and every run held — in an
 * Agent's conversation or in a group — is known only from before it (`joined`) until a push of this connection names it
 * again, and what its tool was doing then (`activity`) is not shown any more. (A group slot that then says nothing at
 * all is forgotten.)
 */
export function clearStreams(state) {
  const settled = Object.values(state.runs).every((r) => !r || r.joined);
  const groupsSettled = Object.values(state.groupRuns).every((slots) => Object.values(slots).every((slot) => slot.joined));
  if (settled && groupsSettled && Object.keys(state.streams).length === 0) return state;
  const runs = {};
  for (const [id, r] of Object.entries(state.runs)) {
    if (!r || r.joined) runs[id] = r;
    else {
      const { since: _since, activity: _activity, ...rest } = r;
      runs[id] = { ...rest, joined: true };
    }
  }
  const groupRuns = {};
  for (const [id, slots] of Object.entries(state.groupRuns)) {
    const kept = {};
    for (const [agentId, slot] of Object.entries(slots)) {
      const { since: _since, activity: _activity, ...rest } = slot;
      const known = { ...rest, joined: true };
      if (!emptySlot(known)) kept[agentId] = known;
    }
    if (Object.keys(kept).length > 0) groupRuns[id] = kept;
  }
  return { ...state, runs, streams: {}, groupRuns };
}

/**
 * The run of a conversation could not be fetched: a queued or running run held from before may long have ended, so
 * it is not shown as replying any more (`unknown`) until a push or an answer says what it is.
 */
export function markRunUnknown(state, conversationId) {
  const run = state.runs[conversationId];
  if (!run || !isActive(run.status) || run.unknown) return state;
  return { ...state, runs: { ...state.runs, [conversationId]: { ...run, unknown: true } }, streams: without(state.streams, run.id) };
}

/** I closed the failure notice of `runId`: it is not shown again, also when a late answer still carries it. */
export function dismissRunOf(state, conversationId, runId) {
  if (!state.conversations[conversationId] || typeof runId !== "string") return state;
  const held = state.runs[conversationId];
  return {
    ...state,
    dismissed: { ...state.dismissed, [conversationId]: runId },
    runs: held?.id === runId ? { ...state.runs, [conversationId]: null } : state.runs,
  };
}

// ───────── an Agent's reply in a group (see the header)

const GROUP_STATES = new Set(["replying", "unavailable"]);
const isGroupState = (value) => value === null || GROUP_STATES.has(value);
const isRun = (run) => Boolean(run) && typeof run.id === "string" && typeof run.status === "string";

/**
 * Whether `agentId` is one of my Agents: its record is mine (`GET /api/agents`), its principal names me as its owner,
 * or — naming no owner — I hold its conversation (only its owner has one). Anyone else's otherwise (the safe side).
 */
export function ownsAgent(state, agentId) {
  if (state.agents[agentId]) return true;
  const owner = state.principals[agentId]?.ownerId;
  if (typeof owner === "string") return owner === state.me?.id;
  return Object.values(state.conversations).some((c) => c.type === "agent" && c.agentId === agentId);
}

/**
 * What a push or an answer's entry says of an Agent's latest reply in a group, as this reader may keep it: the Run for
 * the owner (`{run}`), only the state for anyone else (`{state}`); null when it says nothing usable. For someone else's
 * Agent nothing but `state` is ever read, whatever else the entry carries.
 */
function slotValue(state, agentId, entry) {
  // What its tool is doing now (a push's `activity`), for either: a kind, never more.
  const activity = isActivity(entry.activity) ? { activity: entry.activity } : {};
  if (ownsAgent(state, agentId) && isRun(entry.run)) return { run: wireRun(entry.run), ...activity };
  if ("state" in entry && isGroupState(entry.state)) return { state: entry.state, ...activity };
  return null;
}

/** A slot that says nothing and guards nothing: known only from an answer or from before, no run, no closed failure. */
const emptySlot = (slot) => Boolean(slot.joined) && !slot.dismissed && ("run" in slot ? slot.run === null : slot.state === null);

/** Whether a message of `agentId` after `since` is held in the group (or shown in a detached window). */
function heldMessageOf(state, conversationId, agentId, since) {
  const shown = [...(state.messages[conversationId] ?? []), ...(state.windows[conversationId]?.messages ?? [])];
  return shown.some((m) => m.seq > since && m.senderId === agentId && m.kind !== "system");
}

/** My Agent's slot after `run` (or none): `applyRun`'s rules, for one Agent of the group (`activity` likewise). */
function ownerSlot(prev, run, ordered, from, heldReply, activity) {
  const prevRun = prev && "run" in prev ? prev.run : null;
  let next = run;
  if (next && next.status === "failed" && prev?.dismissed === next.id) next = null;
  // An answer never replaces what a push of this connection named with another run, or with none.
  if (!ordered && prev && !prev.joined && !prev.unknown && (next === null || next.id !== prevRun?.id)) return prev;
  // Nor does a push naming another run that has ended while the one held is queued or running: an Agent has at most one
  // reply queued or running in a conversation, and none ends while another is active, so that frame is older than what is
  // held (a failed told reply's slot pushed again late, say). One held but not known for sure (`unknown`) gives way.
  if (ordered && next && prevRun && !prev.unknown && next.id !== prevRun.id && isActive(prevRun.status) && !isActive(next.status)) return prev;
  const slot = { run: next };
  if (prev?.dismissed) slot.dismissed = prev.dismissed;
  let placed = false;
  if (next && prevRun && prevRun.id === next.id) {
    if (runRank(next.status) < runRank(prevRun.status)) return prev;
    if (prev.posted) slot.posted = true;
    if (ordered && prev.joined) placed = true;
    else if (prev.joined) slot.joined = true;
    else slot.since = prev.since;
  } else if (next) {
    if (ordered) placed = true;
    else slot.joined = true;
  } else if (!ordered) slot.joined = true;
  if (placed) {
    slot.since = from;
    if (!slot.posted && heldReply(from)) slot.posted = true;
  }
  if (ordered && !slot.joined && next?.status === "running" && activity) slot.activity = activity;
  return slot;
}

/**
 * Someone else's Agent's slot after `value` (there is no run id to tell runs apart: a push is the latest word), and what
 * its tool is doing while it is replying (`activity`, a push's).
 */
function memberSlot(prev, value, ordered, from, heldReply, activity) {
  if (!ordered && prev && !prev.joined && !prev.unknown) return prev;
  const slot = { state: value };
  if (!ordered) slot.joined = true;
  else {
    slot.since = from;
    if (value === "replying" && heldReply(from)) slot.posted = true;
    if (value === "replying" && activity) slot.activity = activity;
  }
  return slot;
}

function putGroupSlot(state, conversationId, agentId, value, { ordered, since }) {
  const conv = state.conversations[conversationId];
  const slots = state.groupRuns[conversationId] ?? {};
  const prev = slots[agentId] ?? null;
  const from = typeof since === "number" ? since : conv.lastSeq;
  const heldReply = (after) => heldMessageOf(state, conversationId, agentId, after);
  const next =
    "run" in value ? ownerSlot(prev, value.run, ordered, from, heldReply, value.activity) : memberSlot(prev, value.state, ordered, from, heldReply, value.activity);
  if (next === prev) return state;
  return putGroupSlots(state, conversationId, emptySlot(next) ? without(slots, agentId) : { ...slots, [agentId]: next });
}

/**
 * A `run` push of a group (`{conversationId, agentId, run}` to the Agent's owner, `{conversationId, agentId, state}` to
 * everyone else), or my own retry's answer (`{run}`, in order). `ordered`, `since`: as for `applyRun`. A push that names
 * no Agent, no usable run or state, or a conversation that is not a held group changes nothing.
 */
export function applyGroupRun(state, conversationId, agentId, push, { ordered = true, since } = {}) {
  const conv = state.conversations[conversationId];
  if (!conv || conv.type !== "group" || typeof agentId !== "string" || !push || typeof push !== "object") return state;
  const value = slotValue(state, agentId, push);
  return value ? putGroupSlot(state, conversationId, agentId, value, { ordered, since }) : state;
}

/**
 * `GET /api/conversations/:id/runs` (`{runs: [{agentId, state, run?}]}`): an answer, applied by the rules that make a
 * late one harmless. An Agent it does not list has nothing to show (unless a push of this connection said otherwise).
 * A malformed answer changes nothing.
 */
export function applyGroupRuns(state, conversationId, answer) {
  const conv = state.conversations[conversationId];
  if (!conv || conv.type !== "group" || !Array.isArray(answer?.runs)) return state;
  if (!answer.runs.every((e) => e && typeof e === "object" && typeof e.agentId === "string")) return state;
  let next = state;
  const listed = new Set();
  for (const entry of answer.runs) {
    listed.add(entry.agentId);
    const value = slotValue(next, entry.agentId, entry);
    if (value) next = putGroupSlot(next, conversationId, entry.agentId, value, { ordered: false });
  }
  for (const [agentId, slot] of Object.entries(next.groupRuns[conversationId] ?? {})) {
    if (!listed.has(agentId)) next = putGroupSlot(next, conversationId, agentId, "run" in slot ? { run: null } : { state: null }, { ordered: false });
  }
  return next;
}

/** I closed the failure notice of my Agent's `runId` in the group: as `dismissRunOf`. */
export function dismissGroupRunOf(state, conversationId, agentId, runId) {
  if (state.conversations[conversationId]?.type !== "group" || typeof agentId !== "string" || typeof runId !== "string") return state;
  const slots = state.groupRuns[conversationId] ?? {};
  const held = slots[agentId];
  const slot = held && "run" in held && held.run?.id !== runId ? { ...held, dismissed: runId } : { run: null, joined: true, dismissed: runId };
  return putGroupSlots(state, conversationId, { ...slots, [agentId]: slot });
}

/** The runs of a group could not be fetched: a reply held as being written may long have ended, so it is not shown. */
export function markGroupRunsUnknown(state, conversationId) {
  const slots = state.groupRuns[conversationId];
  if (!slots) return state;
  let next = null;
  for (const [agentId, slot] of Object.entries(slots)) {
    if (!replyingSlot(slot) || slot.unknown) continue;
    next ??= { ...slots };
    next[agentId] = { ...slot, unknown: true };
  }
  return next ? putGroupSlots(state, conversationId, next) : state;
}

// ───────── providers, usage, the site's models

/** A provider's public fields, and nothing else: whatever an answer carries, no key is ever kept (or passed on). */
export function publicProvider(answer) {
  const p = answer ?? {};
  return {
    id: p.id,
    name: p.name,
    protocol: p.protocol,
    baseUrl: p.baseUrl,
    keyLast4: p.keyLast4,
    models: (Array.isArray(p.models) ? p.models : []).map((m) => {
      const levels = modelLevels(m.reasoningLevels);
      const reported = m.reasoning ? modelLevels(m.reportedLevels) : null;
      return {
        name: m.name,
        vision: Boolean(m.vision),
        pdf: Boolean(m.pdf),
        reasoning: Boolean(m.reasoning),
        contextTokens: m.contextTokens,
        ...(levels ? { reasoningLevels: levels } : {}),
        // What the catalogue lists for it (the service, read only): where the choice between those levels and every level goes back to.
        ...(reported ? { reportedLevels: reported } : {}),
        // Whether its replies may be offered tools, only when its entry says it (absent: not known yet, so they are).
        ...(typeof m.tools === "boolean" ? { tools: m.tools } : {}),
      };
    }),
  };
}

/** The thinking levels a provider model may list as the ones it supports, in the service's order. */
export const MODEL_LEVELS = ["low", "medium", "high", "xhigh", "max"];
/** A model's `reasoningLevels` as the service gives them: the known levels, in order; null when there are none (every level). */
export function modelLevels(value) {
  if (!Array.isArray(value)) return null;
  const levels = MODEL_LEVELS.filter((level) => value.includes(level));
  return levels.length > 0 ? levels : null;
}

const isProvider = (p) => p && typeof p.id === "string";

/** `GET /api/providers`: the whole list replaces what is held (oldest first). */
export function applyProviders(state, list) {
  const providers = {};
  for (const p of (Array.isArray(list) ? list : []).filter(isProvider)) providers[p.id] = publicProvider(p);
  return { ...state, providers };
}

/** One provider as an answer returned it (create, edit, refresh). */
export function applyProvider(state, provider) {
  if (!isProvider(provider)) return state;
  return { ...state, providers: { ...state.providers, [provider.id]: publicProvider(provider) } };
}

export function removeProvider(state, providerId) {
  return providerId in state.providers ? { ...state, providers: without(state.providers, providerId) } : state;
}

/** `GET /api/usage` (points stay the service's decimal strings). */
export function applyUsage(state, usage) {
  return usage && typeof usage === "object" ? { ...state, usage } : state;
}

/** `GET /api/models`: the site's models and what a provider model gets by default. */
export function applyModels(state, answer) {
  if (!answer || !Array.isArray(answer.siteModels)) return state;
  const siteModels = answer.siteModels
    .filter((m) => m && typeof m.id === "string")
    .map((m) => ({
      id: m.id,
      label: m.label,
      tier: m.tier,
      vision: Boolean(m.vision),
      pdf: Boolean(m.pdf),
      reasoning: Array.isArray(m.reasoning) ? m.reasoning : [],
      contextTokens: m.contextTokens,
      // Whether its replies may be offered tools (the service says it; absent: not said, so they are).
      ...(typeof m.tools === "boolean" ? { tools: m.tools } : {}),
    }));
  const d = answer.providerDefaults;
  const providerDefaults = d && typeof d === "object" ? { contextTokens: d.contextTokens, maxOutputTokens: d.maxOutputTokens } : state.providerDefaults;
  const c = answer.memoryCatchUp;
  const whole = (n) => Number.isSafeInteger(n) && n > 0;
  const memoryCatchUp = c && typeof c === "object" && whole(c.days) && whole(c.lines) ? { days: c.days, lines: c.lines } : null;
  // About what one web search costs (`webSearchPoints`: a number of points, one decimal at most), with the site's web search.
  const webSearchPoints = typeof answer.webSearchPoints === "string" && /^\d{1,9}(\.\d)?$/.test(answer.webSearchPoints) ? answer.webSearchPoints : null;
  return { ...state, siteModels, providerDefaults, proactiveAvailable: answer.proactiveAvailable === true, memoryCatchUp, webSearchAvailable: answer.webSearchAvailable === true, webSearchPoints };
}
