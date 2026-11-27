// The async actions pages call. Sends are optimistic and keyed by clientTxn (reused on retry); the social
// and group wrappers call their route and then ask the sync engine for fresh state (pushes do the same).
// Principal ids may be given as the view model's "me" alias; they are mapped to the real id here.
//
// The Agent, proposal, reply, provider, usage and model actions (batch 2A) never throw: each resolves
// `{ok: true, value}` or `{ok: false, error: {code, reason, status, resetsAt?, agents?}, text}`, `text` being the Chinese
// sentence for the refusal (errorTexts.js). A provider's API key goes into its request body and nowhere else.
import * as routes from "../api/routes.js";
import { hasVisibleText, messageText } from "../auth/validation.js";
import { ME } from "./identities.js";
import { cleanWithMentions } from "./mentions.js";
import { reportedOf } from "./reported.js";
import { agentErrorText, commonErrorText, profileErrorText, providerErrorText, replyErrorText, whisperErrorText } from "./errorTexts.js";
import {
  applyAgent,
  applyAgents,
  applyGone,
  applyGroupRun,
  applyModels,
  applyMyHandle,
  applyMyName,
  applyNewerInWindow,
  applyOlder,
  applyOlderInWindow,
  applyPosted,
  applyPrincipals,
  applyProvider,
  applyProviders,
  applyRun,
  applyUsage,
  applyWhisper,
  applyWhispers,
  bumpAvatar,
  closeWindow,
  discardPending,
  refillComposer,
  takeRefill,
  dismissGroupRunOf,
  dismissRunOf,
  dropWhisper,
  forgetShownNote,
  markFailed,
  markReadDone,
  markReading,
  markSending,
  markSent,
  markUploading,
  mayWhisper,
  modelLevels,
  openWindow,
  publicProvider,
  removeProvider,
  setCanSend,
  setDraft,
  setMemoryChangeStatus,
  memoryRoomOf,
  memorySettingsOf,
  setProposalStatus,
  setUploaded,
  setUploadProgress,
  stayOf,
} from "./model.js";

/** The service refuses a file over this (413 `too_large`); the client does not even try. */
export const MAX_FILE_BYTES = 1024 * 1024 * 1024;
/** Hits per page of either search (the service's default). */
export const SEARCH_PAGE = 20;
/** A hit is shown in a window of this many messages (at most), the hit being near its middle. */
export const JUMP_WINDOW = 50;
/** The window ends this far after the hit: `before = seq + JUMP_AFTER`. */
export const JUMP_AFTER = 25;

/** Uploads in flight at once across the app (the service allows 3 per person); the rest wait in order. */
export const MAX_UPLOADS = 3;
/** My whispers are asked for this many at a time (the service's most), at most `WHISPER_PAGES` pages for one page of messages. */
export const WHISPER_PAGE = 100;
export const WHISPER_PAGES = 3;
/** A page of them refused for going too fast (429) is asked for once more, this long after. */
export const WHISPER_RETRY_MS = 1000;

/** Lone surrogates → U+FFFD (`String.prototype.toWellFormed`, by hand where a browser lacks it). */
function wellFormed(text) {
  if (typeof text.toWellFormed === "function") return text.toWellFormed();
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    const next = text.charCodeAt(i + 1);
    if (unit >= 0xd800 && unit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      out += text[i] + text[i + 1];
      i += 1;
    } else if (unit >= 0xd800 && unit <= 0xdfff) out += "\uFFFD";
    else out += text[i];
  }
  return out;
}

const errorOf = (err) => ({ code: err?.code ?? "unknown", reason: err?.reason ?? null, status: err?.status ?? 0 });
const refused = (code, clientTxn = null) => Promise.resolve({ ok: false, clientTxn, error: { code, reason: null, status: 0 } });
const dropped = (code) => ({ code, reason: null, status: 0 });

/**
 * @param {object} deps
 * @param {() => object} deps.getModel
 * @param {(model: object) => void} deps.setModel
 * @param {object} [deps.api] the routes module (or a fake with the same functions)
 * @param {() => string} deps.uuid clientTxn generator
 * @param {() => number} deps.now
 * @param {() => number} deps.epoch changes on every stop(); answers to older requests are dropped
 * @param {(needs: {sync?: boolean, social?: boolean, conversation?: string}) => void} deps.request
 * @param {() => void} deps.signedOut called on a 401
 * @returns {{actions: object, reset: () => void}} `reset()` forgets requests in flight (call it on stop).
 */
export function createActions({ getModel, setModel, api = routes, uuid, now, epoch, request, signedOut }) {
  const realId = (id) => (id === ME ? getModel().me?.id ?? id : id);
  const peerConversation = (principalId) =>
    Object.values(getModel().conversations).find((c) => c.type === "direct" && c.peerId === principalId)?.id ?? null;

  /** When a request about a conversation was made: its answer counts only in the same run and the same stay. */
  const tokenFor = (conversationId) => ({ epoch: epoch(), stay: stayOf(getModel(), conversationId), conversationId });
  /** "stopped" (stop() since), "stale" (I left the conversation since, maybe to come back), or null. */
  const staleness = (token) =>
    token.epoch !== epoch() ? "stopped" : token.stay !== stayOf(getModel(), token.conversationId) ? "stale" : null;

  async function deliver(clientTxn) {
    const p = getModel().pending[clientTxn];
    const token = tokenFor(p.conversationId);
    const body = { clientTxn };
    if (p.attachment) body.attachmentId = p.attachment.id;
    if (p.text) body.text = p.text;
    if (p.replyToSeq !== null && p.replyToSeq !== undefined) body.replyToSeq = p.replyToSeq;
    // The mentions picked from the @ list: who each means, and its range of the text sent (Task M).
    if (Array.isArray(p.mentions) && p.mentions.length > 0) body.mentions = p.mentions;
    try {
      const res = await api.sendMessage(p.conversationId, body);
      const why = staleness(token);
      if (why) return { ok: false, clientTxn, error: dropped(why) };
      setModel(markSent(getModel(), clientTxn, res.message));
      return { ok: true, clientTxn, duplicate: Boolean(res.duplicate) };
    } catch (err) {
      return failed(clientTxn, p.conversationId, token, errorOf(err));
    }
  }

  /** A send or an upload was refused or failed: the unsent entry fails (unless it is of an earlier stay). */
  function failed(clientTxn, conversationId, token, error) {
    if (token.epoch === epoch() && error.status === 401) signedOut();
    if (staleness(token)) return { ok: false, clientTxn, error };
    setModel(markFailed(getModel(), clientTxn, error));
    if (error.code === "cannot_send") {
      setModel(setCanSend(getModel(), conversationId, { ok: false, reason: error.reason ?? "not_friends" }));
      request({ social: true, conversation: conversationId });
    } else if (error.status === 404) request({ conversation: conversationId });
    return { ok: false, clientTxn, error };
  }

  /** What I send goes to the end of the conversation: a detached window is left first. */
  const toNewest = (conversationId) => setModel(closeWindow(getModel(), conversationId));

  function send(conversationId, { text = "", replyToSeq = null, attachment = null, mentions = [] }) {
    if (!getModel().conversations[conversationId]) return refused("not_found");
    toNewest(conversationId);
    const clientTxn = uuid();
    setModel(markSending(getModel(), { clientTxn, conversationId, text, replyToSeq, attachment, mentions, at: now() }));
    return deliver(clientTxn);
  }

  /**
   * Sends text as the service stores it (bidi overrides and isolates removed, trimmed; NUL dropped and lone
   * surrogates replaced, which the service refuses); text with nothing visible is refused without a request.
   * `mentions`: those picked from the @ list (`{id, start, length}` in `text` as given), sent as ranges of the text as
   * it is sent (data/mentions.js `cleanWithMentions`, the same rules). Resolves {ok, clientTxn, duplicate?, error?}.
   */
  function sendText(conversationId, text, { replyToSeq = null, mentions = [] } = {}) {
    const cleaned = typeof text === "string" ? cleanWithMentions(text, mentions) : { text: "", mentions: [] };
    const body = messageText(wellFormed(cleaned.text));
    if (!hasVisibleText(body)) return refused("invalid_request");
    return send(conversationId, { text: body, replyToSeq, mentions: body === cleaned.text ? cleaned.mentions : [] });
  }

  // ───────── file messages: upload (at most MAX_UPLOADS at once, the rest wait in order), then send

  /** clientTxn → the File being sent; kept until the message is sent or discarded, so a failed upload can retry. */
  const files = new Map();
  /** clientTxn → {resolve, token, controller, counted, cancelled}: the upload job of an entry that is queued or uploading. */
  const jobs = new Map();
  const waiting = [];
  let uploading = 0;

  /** The job no longer uploads: its slot (if it held one) is free for the next waiting file. */
  const releaseSlot = (job) => {
    if (!job.counted) return;
    job.counted = false;
    uploading -= 1;
    pump();
  };
  const endJob = (clientTxn, job, result) => {
    if (jobs.get(clientTxn) === job) jobs.delete(clientTxn);
    if (job.counted) {
      job.counted = false;
      uploading -= 1;
    }
    job.resolve(result);
    pump();
  };
  /** Stops the job of an entry (running or waiting), if there is one, and frees its slot. */
  const dropJob = (clientTxn, error) => {
    const job = jobs.get(clientTxn);
    if (!job) return;
    job.cancelled = true;
    job.controller?.abort();
    const at = waiting.indexOf(clientTxn);
    if (at >= 0) waiting.splice(at, 1);
    endJob(clientTxn, job, { ok: false, clientTxn, error: dropped(error) });
  };

  function pump() {
    while (uploading < MAX_UPLOADS && waiting.length > 0) {
      const clientTxn = waiting.shift();
      const job = jobs.get(clientTxn);
      if (!job) continue;
      const p = getModel().pending[clientTxn];
      const why = staleness(job.token);
      // Gone, or failed meanwhile (stop, or I left the conversation and came back): not uploaded.
      if (!p || p.status !== "sending" || why) {
        endJob(clientTxn, job, { ok: false, clientTxn, error: dropped(why ?? "stale") });
        continue;
      }
      job.counted = true;
      uploading += 1;
      runUpload(clientTxn, job, p);
    }
  }

  async function runUpload(clientTxn, job, p) {
    job.controller = new AbortController();
    setModel(setUploadProgress(getModel(), clientTxn));
    let percent = 0;
    const onProgress = (fraction) => {
      const next = Math.floor(fraction * 100);
      if (job.cancelled || next === percent || staleness(job.token)) return;
      percent = next;
      setModel(setUploadProgress(getModel(), clientTxn, next / 100));
    };
    let attachment;
    try {
      attachment = await api.uploadAttachment(p.conversationId, files.get(clientTxn), { onProgress, signal: job.controller.signal });
    } catch (err) {
      if (job.cancelled || jobs.get(clientTxn) !== job) return releaseSlot(job); // cancelled, replaced or stopped
      const error = errorOf(err);
      endJob(clientTxn, job, failed(clientTxn, p.conversationId, job.token, error));
      return;
    }
    if (job.cancelled || jobs.get(clientTxn) !== job) return releaseSlot(job);
    const why = staleness(job.token);
    if (why) {
      // The upload belongs to an earlier stay: it is not posted into this one (the entry, if kept, failed already).
      endJob(clientTxn, job, { ok: false, clientTxn, error: dropped(why) });
      return;
    }
    setModel(setUploaded(getModel(), clientTxn, attachment));
    // Uploading is over (the next waiting file may start); the message send below is not limited.
    releaseSlot(job);
    const result = await deliver(clientTxn);
    if (result.ok) files.delete(clientTxn);
    endJob(clientTxn, job, result);
  }

  function queueUpload(clientTxn, conversationId) {
    // An earlier job of this entry (a stay that ended while it ran) must not outlive it: it would hold a slot or upload twice.
    dropJob(clientTxn, "stale");
    return new Promise((resolve) => {
      jobs.set(clientTxn, { resolve, token: tokenFor(conversationId), controller: null, counted: false, cancelled: false });
      waiting.push(clientTxn);
      pump();
    });
  }

  /**
   * Sends a picked file as a message: shown as unsent at once (with progress), uploaded when one of the
   * MAX_UPLOADS slots is free, then sent with the same clientTxn. A file over MAX_FILE_BYTES is refused without a
   * request or an entry. `text` is an optional caption. Resolves {ok, clientTxn, error?} when it was sent or failed.
   */
  function sendFile(conversationId, file, { text = "", replyToSeq = null } = {}) {
    if (!getModel().conversations[conversationId]) return refused("not_found");
    if (!file || !Number.isFinite(file.size)) return refused("invalid_request");
    if (file.size > MAX_FILE_BYTES) return refused("too_large");
    const clientTxn = uuid();
    const caption = typeof text === "string" ? messageText(wellFormed(text.replaceAll("\u0000", ""))) : "";
    // Forget files of entries that are gone (another account signed in, the conversation was left).
    for (const key of files.keys()) if (!getModel().pending[key]) files.delete(key);
    files.set(clientTxn, file);
    toNewest(conversationId);
    setModel(markUploading(getModel(), { clientTxn, conversationId, text: caption, replyToSeq, file: { name: file.name, size: file.size }, at: now() }));
    return queueUpload(clientTxn, conversationId);
  }

  /**
   * Stops an upload that is queued or running, or removes a failed one, and removes its message. Not possible
   * once the file is uploaded (the message is being sent, or waits for a retry). Returns {ok} or {ok: false, error}.
   */
  function cancelUpload(clientTxn) {
    const p = getModel().pending[clientTxn];
    if (!p || p.attachment || !p.file) return { ok: false, error: dropped("not_found") };
    dropJob(clientTxn, "cancelled");
    files.delete(clientTxn);
    setModel(discardPending(getModel(), clientTxn));
    return { ok: true };
  }

  /**
   * Sends a failed message again with the same clientTxn. A file whose upload failed is uploaded again (queued like
   * any other); one that was uploaded is only sent again, never uploaded twice. A message refused for a stale mention
   * (`bad_mentions`) is not sent again as it is: it goes back to its composer instead (`reviseFailed`).
   */
  function retrySend(clientTxn) {
    const p = getModel().pending[clientTxn];
    if (!p || p.status !== "failed") return refused("not_found", clientTxn);
    if (p.error?.code === "bad_mentions") return refused("bad_mentions", clientTxn);
    // (An upload of an earlier stay is not reused either: it is uploaded again into this one.)
    if (p.file && (!p.attachment || p.error?.code === "stale")) {
      if (!files.has(clientTxn)) return refused("not_found", clientTxn);
      setModel(markUploading(getModel(), { clientTxn, conversationId: p.conversationId }));
      return queueUpload(clientTxn, p.conversationId);
    }
    setModel(markSending(getModel(), { clientTxn, conversationId: p.conversationId }));
    return p.file ? deliverFile(clientTxn) : deliver(clientTxn);
  }

  /** Sending an uploaded file again: as `deliver`, and the file is let go once it is sent. */
  async function deliverFile(clientTxn) {
    const result = await deliver(clientTxn);
    if (result.ok) files.delete(clientTxn);
    return result;
  }

  /**
   * Marks read up to `seq` (default: the newest held message). Only forward; shown at once. If the request
   * fails, the marker goes back to the one the service confirmed, so the next call sends it again.
   */
  async function markRead(conversationId, seq) {
    const conv = getModel().conversations[conversationId];
    if (!conv) return { ok: false, error: { code: "not_found", reason: null, status: 0 } };
    // A detached window is not the newest messages: nothing there says the newest were seen.
    if (getModel().windows[conversationId]) return { ok: true, readSeq: conv.readSeq };
    const target = seq ?? conv.position;
    if (!Number.isSafeInteger(target) || target < 1 || target <= conv.readSeq) return { ok: true, readSeq: conv.readSeq };
    const token = tokenFor(conversationId);
    setModel(markReading(getModel(), conversationId, target));
    try {
      const res = await api.markRead(conversationId, target);
      const confirmed = Number.isSafeInteger(res?.readSeq) ? res.readSeq : target;
      if (!staleness(token)) setModel(markReadDone(getModel(), conversationId, confirmed));
      return { ok: true, readSeq: confirmed };
    } catch (err) {
      const error = errorOf(err);
      if (token.epoch === epoch() && error.status === 401) signedOut();
      if (!staleness(token)) {
        setModel(markReadDone(getModel(), conversationId, null));
        if (error.status === 404) request({ conversation: conversationId });
      }
      return { ok: false, error };
    }
  }

  /** `conversation id#window number` → {promise} of the older-history request in flight (window 0: the held messages). */
  const olderInFlight = new Map();
  /** Loads the page before the oldest message shown (the window's, when one is open); one request at a time per list. */
  function loadOlder(conversationId, { limit = 50 } = {}) {
    const win = getModel().windows[conversationId] ?? null;
    const key = `${conversationId}#${win?.n ?? 0}`;
    const inFlight = olderInFlight.get(key);
    if (inFlight) return inFlight.promise;
    const conv = getModel().conversations[conversationId];
    if (!conv || !(win ? win.hasOlder : conv.hasOlder)) return Promise.resolve({ ok: true, loaded: 0, hasOlder: false });
    const held = win ? win.messages : getModel().messages[conversationId] ?? [];
    const before = held.length > 0 ? held[0].seq : conv.position + 1;
    const token = tokenFor(conversationId);
    const entry = { promise: null };
    olderInFlight.set(key, entry);
    entry.promise = (async () => {
      try {
        const page = await api.listMessages(conversationId, { before, limit });
        // My whispers that follow these messages come with them (one update: nothing moves under the place kept).
        const whispers = staleness(token) ? [] : await whispersBefore(conversationId, before, page.messages?.[0]?.seq ?? 0, token);
        const why = staleness(token);
        if (why) return { ok: false, error: dropped(why) };
        if ((getModel().windows[conversationId]?.n ?? 0) !== (win?.n ?? 0)) return { ok: false, error: dropped("stale") };
        const next = win ? applyOlderInWindow(getModel(), conversationId, page, win.n) : applyOlder(getModel(), conversationId, page);
        setModel(applyWhispers(next, whispers));
        return { ok: true, loaded: page.messages.length, hasOlder: page.nextBefore !== null };
      } catch (err) {
        const error = errorOf(err);
        if (token.epoch === epoch() && error.status === 401) signedOut();
        if (!staleness(token) && error.status === 404) request({ conversation: conversationId });
        return { ok: false, error };
      } finally {
        if (olderInFlight.get(key) === entry) olderInFlight.delete(key);
      }
    })();
    return entry.promise;
  }

  /** `conversation id#window number` → {promise} of the newer-messages request in flight. */
  const newerInFlight = new Map();
  /**
   * Loads the messages after the newest one of the detached window. Once the window reaches the held messages it is
   * absorbed (`attached: true`) and the conversation shows its newest messages again. No window: nothing to load.
   */
  function loadNewer(conversationId, { limit = 50 } = {}) {
    const win = getModel().windows[conversationId] ?? null;
    if (!win) return Promise.resolve({ ok: true, loaded: 0, attached: true });
    const key = `${conversationId}#${win.n}`;
    const inFlight = newerInFlight.get(key);
    if (inFlight) return inFlight.promise;
    const newest = win.messages.length > 0 ? win.messages[win.messages.length - 1].seq : win.focusSeq;
    const token = tokenFor(conversationId);
    const entry = { promise: null };
    newerInFlight.set(key, entry);
    entry.promise = (async () => {
      try {
        // The service pages backwards only: the page below `newest + 1 + limit` holds the messages after `newest`.
        const page = await api.listMessages(conversationId, { before: newest + 1 + limit, limit });
        const whispers = staleness(token) ? [] : await whispersBefore(conversationId, newest + 1 + limit, page.messages?.[0]?.seq ?? 0, token);
        const why = staleness(token);
        if (why) return { ok: false, error: dropped(why) };
        if (getModel().windows[conversationId]?.n !== win.n) return { ok: false, error: dropped("stale") };
        const had = getModel().windows[conversationId].messages.length;
        setModel(applyWhispers(applyNewerInWindow(getModel(), conversationId, page, win.n), whispers));
        const now = getModel().windows[conversationId];
        return { ok: true, loaded: now ? now.messages.length - had : page.messages.length, attached: !now };
      } catch (err) {
        const error = errorOf(err);
        if (token.epoch === epoch() && error.status === 401) signedOut();
        if (!staleness(token) && error.status === 404) request({ conversation: conversationId });
        return { ok: false, error };
      } finally {
        if (newerInFlight.get(key) === entry) newerInFlight.delete(key);
      }
    })();
    return entry.promise;
  }

  /**
   * My whispers (README "Whispers") before `before` — an afterSeq: the `before` of the page of messages loaded with them —
   * down to `from` (the oldest seq of that page), newest first, a page of WHISPER_PAGE at a time (at most WHISPER_PAGES).
   * Only where I may have some (model.js `mayWhisper`: elsewhere the route is a 404 anyway). Never fails: a refusal or an
   * error is no more whispers (an open one comes with the next sync), but a page refused for going too fast (429) is asked
   * for once more, WHISPER_RETRY_MS later — unless the request it was for is stale by then (`token`: signed out, the layer
   * stopped, or I left the conversation), when nothing more is asked.
   */
  async function whispersBefore(conversationId, before, from, token) {
    if (!mayWhisper(getModel(), conversationId)) return [];
    const found = [];
    let next = before;
    let retried = false;
    const ask = (b) => api.listWhispers(conversationId, { before: b, limit: WHISPER_PAGE });
    for (let i = 0; i < WHISPER_PAGES && next !== null; i += 1) {
      let page;
      try {
        page = await ask(next);
      } catch (err) {
        if (retried || errorOf(err).status !== 429) break;
        retried = true;
        await new Promise((resolve) => setTimeout(resolve, WHISPER_RETRY_MS));
        if (staleness(token)) break;
        try {
          page = await ask(next);
        } catch {
          break;
        }
      }
      if (Array.isArray(page?.whispers)) found.push(...page.whispers);
      next = Number.isSafeInteger(page?.nextBefore) && page.nextBefore > from ? page.nextBefore : null;
    }
    return found;
  }

  /** A whisper held is not what the service has (an answer was refused as stale): the page around it is read again. */
  async function refreshWhisper(conversationId, whisperId) {
    const held = getModel().whispers?.[conversationId]?.[whisperId];
    if (!held) return;
    const token = tokenFor(conversationId);
    const found = await whispersBefore(conversationId, held.afterSeq + 1, held.afterSeq, token);
    if (!staleness(token)) setModel(applyWhispers(getModel(), found));
  }

  /** Back to the newest messages: the detached window (if any) is dropped. */
  function closeWindowOf(conversationId) {
    setModel(closeWindow(getModel(), conversationId));
  }

  /** conversation id → number of the latest jump asked for: an answer of an earlier one is dropped. */
  const jumps = new Map();
  let windowCounter = 0;
  /**
   * Makes message `seq` of a conversation shown: it is already held (the detached window, if any, is dropped), or
   * it is already in the open window, or the window around it is loaded (`before = seq + JUMP_AFTER`, `JUMP_WINDOW`
   * messages) and replaces what is shown, detached from the newest messages. Resolves {ok: true} or {ok: false,
   * error}: `not_found` when the message is no longer visible to me (the service says so, or the page lacks it).
   */
  async function jumpToMessage(conversationId, seq) {
    const model = getModel();
    if (!model.conversations[conversationId]) return { ok: false, error: dropped("not_found") };
    if (!Number.isSafeInteger(seq) || seq < 1) return { ok: false, error: dropped("invalid_request") };
    // Whatever way this jump goes, it is the latest: a far jump still loading must not replace it afterwards.
    const n = ++windowCounter;
    jumps.set(conversationId, n);
    if ((model.messages[conversationId] ?? []).some((m) => m.seq === seq)) {
      closeWindowOf(conversationId);
      return { ok: true };
    }
    if (model.windows[conversationId]?.messages.some((m) => m.seq === seq)) return { ok: true };
    const token = tokenFor(conversationId);
    try {
      const page = await api.listMessages(conversationId, { before: seq + JUMP_AFTER, limit: JUMP_WINDOW });
      const found = !staleness(token) && (page.messages ?? []).some((m) => m.seq === seq);
      const whispers = found ? await whispersBefore(conversationId, seq + JUMP_AFTER, page.messages[0].seq, token) : [];
      const why = staleness(token);
      if (why) return { ok: false, error: dropped(why) };
      if (jumps.get(conversationId) !== n) return { ok: false, error: dropped("superseded") };
      if (!(page.messages ?? []).some((m) => m.seq === seq)) return { ok: false, error: { code: "not_found", reason: null, status: 404 } };
      setModel(applyWhispers(openWindow(getModel(), conversationId, page, { focusSeq: seq, n }), whispers));
      return { ok: true };
    } catch (err) {
      const error = errorOf(err);
      if (token.epoch === epoch() && error.status === 401) signedOut();
      if (!staleness(token) && error.status === 404) request({ conversation: conversationId });
      return { ok: false, error };
    }
  }

  /**
   * One message a reply's tools found (`GET /api/conversations/:id/messages/:seq`), for the list under the reply: the
   * people it names join the model (its sender's name and avatar); the message itself is not kept here (it may lie far
   * from the loaded ones). Resolves {ok: true, message} or {ok: false, error} (404: I cannot see it now).
   */
  async function foundMessage(conversationId, seq) {
    const token = epoch();
    try {
      const res = await api.getMessage(conversationId, seq);
      if (token !== epoch()) return { ok: false, error: dropped("stopped") };
      setModel(applyPrincipals(getModel(), res?.principals));
      return res?.message ? { ok: true, message: res.message } : { ok: false, error: dropped("not_found") };
    } catch (err) {
      const error = errorOf(err);
      if (token === epoch() && error.status === 401) signedOut();
      return { ok: false, error };
    }
  }

  /**
   * One search request: the people it names join the model (so hits show names and avatars); the hits themselves are
   * not kept here (they may lie far from the loaded messages). Resolves {ok, hits, nextBefore} or {ok: false, error}.
   */
  async function runSearch(run, conversationId = null) {
    const token = epoch();
    try {
      const page = await run();
      if (token !== epoch()) return { ok: false, error: dropped("stopped") };
      setModel(applyPrincipals(getModel(), page.principals));
      return { ok: true, hits: page.messages ?? [], nextBefore: page.nextBefore ?? null };
    } catch (err) {
      const error = errorOf(err);
      if (token === epoch()) {
        if (error.status === 401) signedOut();
        else if (error.status === 404 && conversationId) request({ conversation: conversationId });
      }
      return { ok: false, error };
    }
  }

  /**
   * Composer text kept in the store (survives stop() for the same account). Not kept for a conversation I am
   * no longer in (a composer saving on its way out after I was removed); while stopped every draft is kept.
   */
  function saveDraft(conversationId, text, mentions = []) {
    const model = getModel();
    if (model.synced && !model.conversations[conversationId]) return;
    setModel(setDraft(model, conversationId, typeof text === "string" ? text : "", mentions));
  }

  /**
   * Runs a route; on success `after(result)`, on failure `onFail(error)` (to refresh what the refusal shows is stale);
   * a 401 signs out; errors reach the caller unchanged.
   */
  async function call(run, after, onFail) {
    const token = epoch();
    try {
      const res = await run();
      if (token === epoch()) after?.(res);
      return res;
    } catch (err) {
      if (token === epoch()) {
        if (err?.status === 401) signedOut();
        else onFail?.(err);
      }
      throw err;
    }
  }
  /** A refusal that says the other side or the request is not what the screen showed: fetch the real state. */
  const staleSocial = (err) => {
    if (err?.status === 404 || err?.status === 409 || err?.status === 403) request({ social: true });
  };
  const staleConversation = (conversationId) => (err) => {
    if (err?.status === 404 || err?.status === 409 || err?.status === 403) request({ conversation: conversationId });
  };
  const socialChanged = (principalId) => () => request({ social: true, conversation: principalId ? peerConversation(principalId) : null });

  function removeMember(conversationId, principalId) {
    const target = realId(principalId);
    const leaving = target === getModel().me?.id;
    const token = tokenFor(conversationId);
    return call(
      () => api.removeMember(conversationId, target),
      () => {
        if (!leaving) request({ conversation: conversationId });
        else if (!staleness(token)) setModel(applyGone(getModel(), conversationId));
      },
      staleConversation(conversationId),
    );
  }

  // ───────── Agents, proposals, replies, providers, usage, models (batch 2A)

  /** The error an action resolves with: the code and what the service said with it. */
  const failureOf = (err) => {
    const error = errorOf(err);
    if (err?.resetsAt) error.resetsAt = err.resetsAt;
    if (err?.agents) error.agents = err.agents;
    if (Number.isFinite(err?.left)) error.left = err.left;
    if (err?.count === true) error.count = true;
    if (err?.availableAt) error.availableAt = err.availableAt;
    return error;
  };
  const failure = (error, text) => ({ ok: false, error, text });

  /**
   * Runs a route. Only the request decides the outcome:
   * - it failed: a 401 signs out, `onFail(error)` may fetch what the refusal shows is stale, and the action resolves
   *   `{ok: false, error, text: text(error)}`;
   * - it succeeded: the action resolves `{ok: true, value}`, `value` being `map(answer)` (null if mapping fails). The
   *   service has made the change, so a failure while keeping its answer (`map`, `after`: a malformed answer, a bug)
   *   does not make it a failure: `refetch()` asks for that state again instead.
   * Nothing is kept from an answer that arrives after stop().
   */
  async function attempt(send, { map = (answer) => answer, after, refetch, text, onFail } = {}) {
    const token = epoch();
    let answer;
    try {
      answer = await send();
    } catch (err) {
      const error = failureOf(err);
      if (token === epoch()) {
        if (error.status === 401) signedOut();
        else onFail?.(error);
      }
      return failure(error, text(error));
    }
    let value = null;
    try {
      value = map(answer);
      if (token === epoch()) after?.(value);
    } catch {
      if (token === epoch()) refetch?.();
    }
    return { ok: true, value };
  }

  const agentText = (action) => (error) => agentErrorText(action, error, now());
  const replyText = (action) => (error) => replyErrorText(action, error);
  const providerText = (action) => (error) => providerErrorText(action, error);
  const isStale = (error) => error.status === 400 || error.status === 404 || error.status === 409;

  /** The conversation of one of my Agents. */
  const conversationOfAgent = (agentId) =>
    getModel().agents[agentId]?.conversationId ?? Object.values(getModel().conversations).find((c) => c.agentId === agentId)?.id ?? null;
  /** That Agent (and its open proposal cards) again, and its conversation's flags (paused, deleted, canSend). */
  const refetchAgent = (agentId) => () => request({ agent: agentId, conversation: conversationOfAgent(agentId) });
  /** A refusal says my picture of the Agent is out of date (deleted elsewhere, not mine): fetch it and its cards again. */
  const staleAgent = (agentId) => (error) => {
    if (isStale(error)) request({ agent: agentId });
  };
  /** A refusal says the reply (in a group: the group's replies) or the conversation is not what the screen shows: fetch both. */
  const staleReply = (conversationId, agentId = null) => (error) => {
    if (isStale(error)) request(agentId ? { groupRuns: conversationId, conversation: conversationId } : { run: conversationId, conversation: conversationId });
  };
  /** The run held of `agentId` in a group (mine: only my Agents' runs are ever held), or of an Agent's conversation. */
  const heldRun = (conversationId, agentId) =>
    agentId ? getModel().groupRuns[conversationId]?.[agentId]?.run ?? null : getModel().runs[conversationId] ?? null;
  /** An Agent changed by my own request: kept at once, and its conversation's flags (paused, deleted, canSend) refreshed. */
  const agentChanged = (agent) => {
    setModel(applyAgent(getModel(), agent));
    if (agent?.conversationId) request({ conversation: agent.conversationId });
  };
  const agentWrite = (action, agentId, after) => ({ after, refetch: refetchAgent(agentId), text: agentText(action), onFail: staleAgent(agentId) });
  /** An appellation write: its 400 and 404 are about the person named, so only an Agent deleted elsewhere makes the picture stale. */
  const appellationWrite = (agentId) => ({
    ...agentWrite("appellation", agentId, (agent) => setModel(applyAgent(getModel(), agent))),
    onFail: (error) => {
      if (error.code === "agent_deleted") request({ agent: agentId });
    },
  });
  const providerWrite = (action, after, onFail) => ({ after, refetch: () => agentActions.loadProviders(), text: providerText(action), onFail });
  const forgetProvider = (providerId) => (error) => {
    if (error.status === 404) setModel(removeProvider(getModel(), providerId));
  };
  /** One entry of a provider's model list as `/models/list` gives it, with only what it should hold. */
  const listedModel = (m) => {
    const known = m.known === true;
    const levels = known ? modelLevels(m.reasoningLevels) : null;
    return {
      name: m.name,
      vision: m.vision === true,
      pdf: m.pdf === true,
      reasoning: m.reasoning === true,
      chat: m.chat !== false,
      known,
      ...(known && typeof m.label === "string" && m.label !== "" ? { label: m.label } : {}),
      ...(known && Number.isInteger(m.contextTokens) && m.contextTokens > 0 ? { contextTokens: m.contextTokens } : {}),
      ...(levels ? { reasoningLevels: levels } : {}),
      // What the catalogue reports of a model it knows (`reportedTools`, what it takes and answers with), each only as true: for the row's marks.
      ...(known ? reportedOf(m) : {}),
      added: m.added === true,
    };
  };
  /**
   * A call to my provider (`action`: test | list): the service answers 200 either way, `{ok: false, error,
   * upstreamStatus?}` when the provider failed. That failure resolves as a refused action's, with the provider's own
   * HTTP status as `upstreamStatus` when it answered with one (a 404 or 405: it has no model list).
   */
  const providerCall = async (action, sent) => {
    const result = await attempt(() => sent, { text: providerText(action) });
    if (!result.ok || result.value?.ok !== false) return result;
    const error = { code: typeof result.value.error === "string" ? result.value.error : "unknown", reason: null, status: 200 };
    if (typeof result.value.upstreamStatus === "string") error.upstreamStatus = result.value.upstreamStatus;
    const detail = upstreamDetail(result.value.detail);
    if (detail) error.detail = detail;
    return failure(error, providerErrorText(action, error));
  };
  /**
   * What the provider itself said about a failed call (its owner's only, batch 2C): its status (three digits) and its
   * own text, at most 300 characters, as plain strings; `redacted` when the service dropped a text that held a piece of
   * the key. Null when there is nothing of that.
   */
  const upstreamDetail = (d) => {
    if (!d || typeof d !== "object") return null;
    const out = {};
    if (typeof d.upstreamStatus === "string" && /^\d{3}$/.test(d.upstreamStatus)) out.upstreamStatus = d.upstreamStatus;
    if (typeof d.message === "string" && d.message.trim() !== "") out.message = [...d.message].slice(0, 300).join("");
    if (d.redacted === true) out.redacted = true;
    return Object.keys(out).length > 0 ? out : null;
  };

  const memoryDecision = (action, agentId, changeId, route) =>
    attempt(() => route(agentId, changeId), {
      map: (answer) => (typeof answer?.status === "string" ? { status: answer.status, dropped: Number(answer.dropped) || 0 } : null),
      after: (decided) => {
        if (decided !== null) setModel(setMemoryChangeStatus(getModel(), conversationOfAgent(agentId), changeId, decided.status));
      },
      refetch: refetchAgent(agentId),
      text: agentText(action),
      onFail: staleAgent(agentId),
    });

  /** A write in the memory palace: `agentId` is the Agent whose room it is (null: 关于我). An Agent deleted elsewhere makes its record stale. */
  const memoryWrite = (agentId) => ({
    text: agentText("memoryNote"),
    onFail: (error) => {
      if (agentId && error.code === "agent_deleted") request({ agent: agentId });
    },
  });

  const agentActions = {
    loadAgents: () => attempt(() => api.listAgents(), { after: (res) => setModel(applyAgents(getModel(), res?.agents)), text: commonErrorText }),
    /**
     * body: {handle, name, intro?, field?, persona?, replyMode?, groupMentions?, reasoning?, model?} → value: the Agent. Its
     * conversation follows by sync.
     */
    createAgent: (body) =>
      attempt(() => api.createAgent(body), {
        after: (agent) => {
          setModel(applyAgent(getModel(), agent));
          request({ sync: true });
        },
        refetch: () => request({ agents: true, sync: true }),
        text: agentText("create"),
      }),
    patchAgent: (agentId, patch) =>
      attempt(() => api.patchAgent(agentId, patch), agentWrite("edit", agentId, (agent) => setModel(applyAgent(getModel(), agent)))),
    pauseAgent: (agentId) => attempt(() => api.pauseAgent(agentId), agentWrite("pause", agentId, agentChanged)),
    resumeAgent: (agentId) => attempt(() => api.resumeAgent(agentId), agentWrite("resume", agentId, agentChanged)),
    deleteAgent: (agentId) => attempt(() => api.deleteAgent(agentId), agentWrite("delete", agentId, agentChanged)),
    /** How the Agent addresses `principalId` (set, or removed): the Agent's view as the service answers it is kept. */
    setAppellation: (agentId, principalId, appellation) =>
      attempt(() => api.putAppellation(agentId, principalId, { appellation }), appellationWrite(agentId)),
    /**
     * Takes it back. A 404 says it is gone already (taken back elsewhere): what was asked is so, and nothing is said —
     * the Agent is fetched again, so its row goes too.
     */
    removeAppellation: async (agentId, principalId) => {
      const res = await attempt(() => api.deleteAppellation(agentId, principalId), appellationWrite(agentId));
      if (res.ok || res.error.status !== 404) return res;
      request({ agent: agentId });
      return { ok: true, value: null };
    },
    /** Uploads the Agent's new avatar; on success its URL gets the next version at once. */
    uploadAgentAvatar: (agentId, file) =>
      attempt(() => api.uploadAgentAvatar(agentId, file), agentWrite("avatar", agentId, () => setModel(bumpAvatar(getModel(), 0, agentId)))),
    /** body: {name, intro?, field?, model} → value: {persona}, for the persona box (nothing is stored). */
    draftPersona: (body) => attempt(() => api.draftPersona(body), { text: agentText("draft") }),
    /** edits: optional {persona?, intro?, field?}. On success the Agent is kept and the card reads confirmed. */
    confirmProposal: (agentId, proposalId, edits) =>
      attempt(
        () => api.confirmProposal(agentId, proposalId, edits),
        agentWrite("confirm", agentId, (agent) => {
          setModel(applyAgent(getModel(), agent));
          setModel(setProposalStatus(getModel(), conversationOfAgent(agentId), proposalId, "confirmed"));
        }),
      ),
    /**
     * Undoes, confirms or discards one change of my Agent's memory (the chip and the cards) → value `{status, dropped}`: the answer's
     * `status` is kept on the notice at once; `dropped` (a confirmation, else 0) is how many of its in-place ops were left out because
     * their note changed since. A refusal (stale: something changed since) fetches the Agent and its open cards again.
     */
    undoMemoryChange: (agentId, changeId) => memoryDecision("memoryUndo", agentId, changeId, api.undoMemoryChange),
    confirmMemoryChange: (agentId, changeId) => memoryDecision("memoryConfirm", agentId, changeId, api.confirmMemoryChange),
    discardMemoryChange: (agentId, changeId) => memoryDecision("memoryDiscard", agentId, changeId, api.discardMemoryChange),

    // ───────── the memory palace. `agentId` null is 关于我 (mine, shared by my Agents); an Agent's id is its own room. The rooms
    // are not held in the model: the page that shows one reads it when it opens and again after every write.
    /** → value: the room (`memoryRoomOf`), or null when the answer was not one. */
    loadMemoryRoom: (agentId) =>
      attempt(() => (agentId ? api.getAgentMemory(agentId) : api.listMemoryNotes()), { map: memoryRoomOf, text: commonErrorText }),
    /** body: {text, vault?} → value: the note. 409 room_full, 422 note_refused. */
    addMemoryNote: (agentId, body) => attempt(() => (agentId ? api.addAgentMemoryNote(agentId, body) : api.addMemoryNote(body)), memoryWrite(agentId)),
    /** patch: {text?, vault?} → value: the note. */
    patchMemoryNote: (agentId, noteId, patch) =>
      attempt(() => (agentId ? api.patchAgentMemoryNote(agentId, noteId, patch) : api.patchMemoryNote(noteId, patch)), memoryWrite(agentId)),
    deleteMemoryNote: (agentId, noteId) =>
      attempt(() => (agentId ? api.deleteAgentMemoryNote(agentId, noteId) : api.deleteMemoryNote(noteId)), memoryWrite(agentId)),
    /**
     * 以后别说 under a social reply (ring 1b): the note (`agentId` null: one about me; else that Agent's own) goes into the vault, held to the
     * reply it was pressed under (`from`: `{conversationId, seq}`) → value: the note. 409 `note_changed`: it is not as that reply was shown
     * it any more (nothing was written). Either way the note is not as any reply was shown it now: every reply held that lists it reads
     * it text-free (`forgetShownNote`, fix round 1, F3).
     */
    vaultFromReply: (agentId, noteId, from) => {
      const forget = () => setModel(forgetShownNote(getModel(), agentId ? "self" : "owner", noteId));
      const write = memoryWrite(agentId);
      return attempt(() => (agentId ? api.patchAgentMemoryNote(agentId, noteId, { vault: true, from }) : api.patchMemoryNote(noteId, { vault: true, from })), {
        ...write,
        after: forget,
        onFail: (error) => {
          write.onFail(error);
          if (error.code === "note_changed") forget();
        },
      });
    },
    /** What the Agent heard: forgotten, or taken as true (it becomes one of its own notes). */
    deleteHearsay: (agentId, hearsayId) => attempt(() => api.deleteHearsay(agentId, hearsayId), memoryWrite(agentId)),
    confirmHearsay: (agentId, hearsayId) => attempt(() => api.confirmHearsay(agentId, hearsayId), memoryWrite(agentId)),
    /** value: `{newNotes: "auto" | "vault" | "open", dream, memoryLanguage, memoryModel, memoryModelUsable}`, my memory settings (`GET /api/me`). */
    loadMemorySettings: () => attempt(() => api.getMe(), { map: memorySettingsOf, text: commonErrorText }),
    /** value: the setting as sent (the answer does not echo it). */
    setNewNotes: (newNotes) => attempt(() => api.updateNewNotes(newNotes), { map: () => newNotes, text: commonErrorText }),
    /** value: the setting as sent (the answer does not echo it). */
    setDream: (dream) => attempt(() => api.updateDream(dream), { map: () => dream, text: commonErrorText }),
    /** value: the language code as sent, or null (automatic). */
    setMemoryLanguage: (memoryLanguage) => attempt(() => api.updateMemoryLanguage(memoryLanguage), { map: () => memoryLanguage, text: commonErrorText }),
    /** Starts restating my existing notes in the chosen language; value: true (how it stands is `loadMemoryConversion`'s). */
    convertMemoryLanguage: () => attempt(() => api.convertMemoryLanguage(), { map: () => true, text: commonErrorText }),
    /**
     * value: `{state: "idle" | "running" | "done", result, unavailable}`, how my latest conversion stands: once `done`, `result` is
     * `{rooms, converted, kept, noRoom, failedRooms}` (what could not be done is counted), and `unavailable` is true when nothing could be done at all.
     */
    loadMemoryConversion: () =>
      attempt(() => api.getMemoryConversion(), {
        map: (answer) => ({
          state: answer?.state === "running" || answer?.state === "done" ? answer.state : "idle",
          result: {
            rooms: Number(answer?.result?.rooms) || 0,
            converted: Number(answer?.result?.converted) || 0,
            kept: Number(answer?.result?.kept) || 0,
            noRoom: Number(answer?.result?.noRoom) || 0,
            failedRooms: Number(answer?.result?.failedRooms) || 0,
          },
          unavailable: answer?.unavailable === true,
        }),
        text: commonErrorText,
      }),
    /** value: the model as sent, or null (the site's). */
    setMemoryModel: (memoryModel) => attempt(() => api.updateMemoryModel(memoryModel), { map: () => memoryModel, text: commonErrorText }),
    discardProposal: (agentId, proposalId) =>
      attempt(
        () => api.discardProposal(agentId, proposalId),
        agentWrite("discard", agentId, () => setModel(setProposalStatus(getModel(), conversationOfAgent(agentId), proposalId, "discarded"))),
      ),

    /**
     * Stops the reply in progress in an Agent conversation, or (`agentId`) of my Agent in a group — by its run either
     * way (the `run` push says when it has stopped). Someone else's Agent's reply is not mine to stop: nothing is sent.
     */
    stopRun: (conversationId, agentId = null) => {
      const run = heldRun(conversationId, agentId);
      if (!run || (run.status !== "queued" && run.status !== "running")) {
        const error = dropped("no_run");
        return Promise.resolve(failure(error, replyErrorText("stop", error)));
      }
      return attempt(() => api.stopRun(conversationId, run.id), { text: replyText("stop"), onFail: staleReply(conversationId, agentId) });
    },
    /**
     * Tries the failed reply again (in a group: of my Agent `agentId`) — the failure shown, named by its id (`runId`: the one the
     * line rendered; else the one held), so a later failure pushed meanwhile is never the one answered: the new run replaces the
     * failed one (unless a newer one was pushed meanwhile). Nothing left of it to answer (409 `nothing_to_retry`: its calls refused
     * since, or a later reply took it on) ends quietly: that failure is closed here, as a dismissal closes it, and the reply's state
     * fetched again.
     */
    retryRun: (conversationId, agentId = null, runId = null) => {
      const failed = runId ?? heldRun(conversationId, agentId)?.id ?? null;
      // No run held (in a group someone else's is a bare state): nothing to try again, nothing is sent.
      if (failed === null) {
        const error = dropped("no_run");
        return Promise.resolve(failure(error, replyErrorText("retry", error)));
      }
      const keep = (run) =>
        setModel(agentId ? applyGroupRun(getModel(), conversationId, agentId, { run }, { ordered: true }) : applyRun(getModel(), conversationId, run, { ordered: true }));
      return attempt(() => api.retryRun(conversationId, failed), {
        after: (res) => {
          // In order: nothing of this reply's runs happened between the failed run and its retry.
          if ((heldRun(conversationId, agentId)?.id ?? null) === failed && res?.run) keep(res.run);
        },
        refetch: () => request(agentId ? { groupRuns: conversationId } : { run: conversationId }),
        text: replyText("retry"),
        onFail: (error) => {
          if (error.code === "nothing_to_retry") {
            setModel(agentId ? dismissGroupRunOf(getModel(), conversationId, agentId, failed) : dismissRunOf(getModel(), conversationId, failed));
          }
          staleReply(conversationId, agentId)(error);
        },
      });
    },
    /**
     * Closes the failure notice (in a group: of my Agent `agentId`, which the request names): the failed run is shown no
     * more, not even by an answer already on its way.
     */
    dismissRun: (conversationId, agentId = null) => {
      const held = heldRun(conversationId, agentId);
      const failed = held?.id ?? null;
      if (agentId && failed === null) {
        const error = dropped("no_run");
        return Promise.resolve(failure(error, replyErrorText("dismiss", error)));
      }
      // A group's reply that ended without failing (halted, its Agent taken out): the service keeps nothing to dismiss
      // (and the Agent may be gone from the group), so the line is closed here only.
      if (agentId && held && held.status !== "failed") {
        setModel(dismissGroupRunOf(getModel(), conversationId, agentId, held.id));
        return Promise.resolve({ ok: true, value: null });
      }
      return attempt(() => (agentId ? api.dismissRun(conversationId, agentId) : api.dismissRun(conversationId)), {
        after: () => {
          if (failed === null) return;
          setModel(agentId ? dismissGroupRunOf(getModel(), conversationId, agentId, failed) : dismissRunOf(getModel(), conversationId, failed));
        },
        refetch: () => request(agentId ? { groupRuns: conversationId } : { run: conversationId }),
        text: replyText("dismiss"),
        onFail: staleReply(conversationId, agentId),
      });
    },
    /** A group's Agent replies again (`GET …/runs`, in the background): the group was opened, or the connection came back. */
    loadGroupRuns: (conversationId) => request({ groupRuns: conversationId }),
    /** 让 Agent 停下: the group's Agents stop calling each other until a person speaks (its notice and runs are pushed). */
    haltAgents: (conversationId) =>
      attempt(() => api.haltAgents(conversationId), {
        text: replyText("halt"),
        onFail: (error) => {
          if (error.status === 404) request({ conversation: conversationId });
        },
      }),
    /** Starts a new topic: the notice shows at once (it is pushed too). */
    resetTopic: (conversationId) =>
      attempt(() => api.resetTopic(conversationId), {
        after: (res) => {
          if (res?.message?.conversationId === conversationId) setModel(applyPosted(getModel(), res.message));
        },
        refetch: () => request({ conversation: conversationId }),
        text: replyText("topic"),
        onFail: (error) => {
          if (error.code === "cannot_send") setModel(setCanSend(getModel(), conversationId, { ok: false, reason: error.reason ?? "agent_deleted" }));
          if (error.code === "cannot_send" || error.status === 404) request({ conversation: conversationId });
        },
      }),

    loadProviders: () => attempt(() => api.listProviders(), { after: (res) => setModel(applyProviders(getModel(), res?.providers)), text: commonErrorText }),
    /**
     * body: {name, protocol, baseUrl, apiKey, models?}. The key is sent once and kept nowhere: neither the model nor the
     * value resolved holds it (value: the provider's public fields, `keyLast4` only).
     */
    createProvider: (body) =>
      attempt(() => api.createProvider(body), { map: publicProvider, ...providerWrite("create", (p) => setModel(applyProvider(getModel(), p))) }),
    /** patch: any of {name, baseUrl, apiKey, models}; the same as createProvider for a new key. */
    patchProvider: (providerId, patch) =>
      attempt(() => api.patchProvider(providerId, patch), {
        map: publicProvider,
        ...providerWrite("edit", (p) => setModel(applyProvider(getModel(), p)), forgetProvider(providerId)),
      }),
    /** Refused with `provider_in_use` while Agents use it: the text names them. */
    deleteProvider: (providerId) =>
      attempt(() => api.deleteProvider(providerId), providerWrite("delete", () => setModel(removeProvider(getModel(), providerId)), forgetProvider(providerId))),
    /**
     * One call to the provider: with `model` one tiny real call to that model, else its model list is asked for →
     * value {ok: true, mode: "chat" | "list", latencyMs}, or the reason it failed (the service answers 200 either way),
     * with the provider's own HTTP status as `upstreamStatus` when it answered with one (without a model, a 404 or 405:
     * it has no model list) and `detail`, what it said (`upstreamDetail`).
     */
    testProvider: (providerId, model) => providerCall(model === undefined ? "test" : "chat", api.testProvider(providerId, model)),
    /**
     * The provider's own model list, for its owner to choose from (nothing is stored, nothing kept here) → value:
     * {listed: [{name, vision, pdf, reasoning, chat, known, label?, contextTokens?, reasoningLevels?, added}]}: hints,
     * the catalogue's when `known` (with its display name, context and levels), else guesses from the name; a failure
     * as testProvider's.
     */
    listProviderModels: async (providerId) => {
      const result = await providerCall("list", api.listProviderModels(providerId));
      if (!result.ok) return result;
      const listed = Array.isArray(result.value?.listed) ? result.value.listed : [];
      // `source: "catalogue"`: the provider has no model list there, these are the public catalogue's models at its host.
      // `source: "sibling"`: the list came from another address of the same provider (the service's listing-siblings table).
      const source = result.value?.source === "catalogue" || result.value?.source === "sibling" ? { source: result.value.source } : {};
      return { ok: true, value: { listed: listed.filter((m) => typeof m?.name === "string").map(listedModel), ...source } };
    },

    loadUsage: () => attempt(() => api.getUsage(), { after: (usage) => setModel(applyUsage(getModel(), usage)), text: commonErrorText }),
    /**
     * My answer to my whisper `whisperId` in `conversationId`: `accept` (告诉他们) or `decline` (不用) → value: the whisper as
     * it is now, kept at once (the service pushes it to my other tabs too). Refused as stale (answered or expired meanwhile):
     * the whisper is read again; gone (404): it goes.
     */
    answerWhisper: (conversationId, whisperId, answer) =>
      attempt(() => (answer === "accept" ? api.acceptWhisper(whisperId) : api.declineWhisper(whisperId)), {
        after: (whisper) => setModel(applyWhisper(getModel(), whisper)),
        text: whisperErrorText,
        onFail: (error) => {
          if (error.status === 404) setModel(dropWhisper(getModel(), conversationId, whisperId));
          // Only a stale answer means the whisper changed; a refusal of the reply 告诉他们 would start leaves it open.
          else if (error.code === "stale_whisper") void refreshWhisper(conversationId, whisperId);
        },
      }),
    /** The site's models again (Settings and the Agent form open). */
    loadModels: () => attempt(() => api.getModels(), { after: (res) => setModel(applyModels(getModel(), res)), text: commonErrorText }),
  };

  const actions = {
    ...agentActions,
    sendText,
    sendFile,
    cancelUpload,
    retrySend,
    retryFile: retrySend,
    markRead,
    loadOlder,
    loadNewer,
    jumpToMessage,
    foundMessage,
    closeWindow: closeWindowOf,
    /** `before`: the previous page's `nextBefore` (a seq here). */
    searchConversation: (conversationId, { q, before } = {}) =>
      runSearch(() => api.searchConversation(conversationId, { q, before, limit: SEARCH_PAGE }), conversationId),
    /** `before`: the previous page's `nextBefore` (an opaque cursor). */
    searchAll: ({ q, before } = {}) => runSearch(() => api.searchAll({ q, before, limit: SEARCH_PAGE })),
    setDraft: saveDraft,
    /** A failed text message back into its composer, text and mentions (model.js `refillComposer`; 改一下). */
    reviseFailed: (clientTxn) => setModel(refillComposer(getModel(), clientTxn)),
    /** The composer of `conversationId` took what was put back for it. */
    takeRefill: (conversationId) => setModel(takeRefill(getModel(), conversationId)),
    // my profile
    /** Resolves the name as stored; throws the route's error (a 401 signs out). */
    updateDisplayName: (displayName) =>
      call(() => api.updateMe(displayName), (res) => setModel(applyMyName(getModel(), res?.displayName ?? displayName))),
    /**
     * My handle, once a year: value the handle as stored; me, my entry and my Agents' full handles change at once. A
     * refusal's text is `profileErrorText("handle")`'s (`handle_taken`, `handle_change_too_soon` with its date).
     */
    changeHandle: (handle) =>
      attempt(() => api.updateHandle(handle), {
        map: (res) => (typeof res?.handle === "string" ? res.handle : handle),
        after: (stored) => setModel(applyMyHandle(getModel(), stored)),
        text: (error) => profileErrorText("handle", error),
      }),
    /** value: when my handle may change again (an ISO time), or null when it may now (`GET /api/me`). */
    loadHandleChange: () =>
      attempt(() => api.getMe(), { map: (me) => (typeof me?.handleChangeAvailableAt === "string" ? me.handleChangeAvailableAt : null), text: commonErrorText }),
    /** Uploads my new avatar; on success every URL of it gets a new version. */
    uploadAvatar: (file) => call(() => api.uploadAvatar(file), () => setModel(bumpAvatar(getModel(), now()))),
    // social
    lookupPrincipal: (handle) => call(() => api.lookupPrincipal(handle)),
    sendFriendRequest: (handle) => call(() => api.sendFriendRequest(handle), () => request({ social: true }), staleSocial),
    acceptFriendRequest: (requestId) =>
      call(
        () => api.acceptFriendRequest(requestId),
        (res) => request({ social: true, conversation: res?.conversationId ?? null }),
        staleSocial,
      ),
    rejectFriendRequest: (requestId) => call(() => api.rejectFriendRequest(requestId), () => request({ social: true }), staleSocial),
    withdrawFriendRequest: (requestId) => call(() => api.withdrawFriendRequest(requestId), () => request({ social: true }), staleSocial),
    removeFriend: (principalId) => call(() => api.removeFriend(realId(principalId)), socialChanged(realId(principalId)), staleSocial),
    blockPrincipal: (principalId) => call(() => api.blockPrincipal(realId(principalId)), socialChanged(realId(principalId)), staleSocial),
    unblockPrincipal: (principalId) => call(() => api.unblockPrincipal(realId(principalId)), socialChanged(realId(principalId)), staleSocial),
    // Agent social (lane A, lane B): thin on purpose: the route's answer, or its error as it came (a 401 signs out). What a page
    // keeps of it is the page's: nothing is held here, and none is called while the site's switch is off (state.social.enabled).
    listAgentContacts: () => call(() => api.listAgentContacts()),
    // (What these change reaches the held `agentContacts` through the `social` fetch they ask for: nothing is kept here.)
    addAgentContact: (agentId) => call(() => api.addAgentContact(agentId), () => request({ social: true, sync: true })),
    approveAgentContact: (agentId, subjectId) => call(() => api.approveAgentContact(agentId, subjectId), () => request({ social: true, sync: true })),
    declineAgentContact: (agentId, subjectId) => call(() => api.declineAgentContact(agentId, subjectId), () => request({ social: true })),
    removeAgentContact: (agentId, subjectId) => call(() => api.removeAgentContact(agentId, subjectId), () => request({ social: true, sync: true })),
    getAgentContacts: (agentId) => call(() => api.getAgentContacts(agentId)),
    putContactPolicy: (agentId, body) => call(() => api.putContactPolicy(agentId, body)),
    putBar: (personId) => call(() => api.putBar(realId(personId)), () => request({ social: true, sync: true })),
    deleteBar: (personId) => call(() => api.deleteBar(realId(personId)), () => request({ social: true })),
    reportAgent: (body) => call(() => api.reportAgent(body)),
    answerPersonaFact: (agentId, seq, move) => call(() => api.answerPersonaFact(agentId, seq, move)),
    // The people it names (who used my Agents today, whom I stopped) join the model: each is then a person the pages can draw by id,
    // a friend or not (the use page links to their profile, where 停止往来 lives).
    getOthersUse: () =>
      call(
        () => api.getOthersUse(),
        (use) => {
          // (Both lists hold people only; one the model already holds is left as the sync said it.)
          const held = getModel().principals;
          const named = [...(Array.isArray(use?.byPerson) ? use.byPerson : []), ...(Array.isArray(use?.stopped) ? use.stopped : [])]
            .map((row) => row?.person)
            .filter((p) => p && typeof p.id === "string" && !held[p.id])
            .map((p) => ({ ...p, kind: "human" }));
          if (named.length > 0) setModel(applyPrincipals(getModel(), named));
        },
      ),
    putOthersLimits: (body) => call(() => api.putOthersLimits(body)),
    seenOthersNotice: () => call(() => api.seenOthersNotice()),
    /** Asks for a full refresh (a conversation the screen expects is not held yet). */
    syncNow: () => request({ sync: true }),
    /** 立即重试: the connection is tried again now instead of after its back-off. */
    retryNow: () => request({ retryNow: true, sync: true }),
    // groups
    createGroup: (title, memberIds) =>
      call(() => api.createGroup({ title, memberIds: memberIds.map(realId) }), () => request({ sync: true })),
    renameGroup: (conversationId, title) =>
      call(() => api.renameGroup(conversationId, title), () => request({ conversation: conversationId }), staleConversation(conversationId)),
    /** The group's new avatar (the creator): the conversation is fetched again, with its new avatar version. */
    uploadGroupAvatar: (conversationId, file) =>
      call(() => api.uploadGroupAvatar(conversationId, file), () => request({ conversation: conversationId }), staleConversation(conversationId)),
    removeGroupAvatar: (conversationId) =>
      call(() => api.removeGroupAvatar(conversationId), () => request({ conversation: conversationId }), staleConversation(conversationId)),
    addMember: (conversationId, principalId) =>
      call(
        () => api.addMember(conversationId, realId(principalId)),
        () => request({ conversation: conversationId }),
        staleConversation(conversationId),
      ),
    removeMember,
    leaveGroup: (conversationId) => removeMember(conversationId, ME),
  };
  return {
    actions,
    reset() {
      olderInFlight.clear();
      newerInFlight.clear();
      jumps.clear();
      // Uploads stop; their entries become failed (the model's reset) and can be retried from the files kept here.
      for (const [clientTxn, job] of jobs) {
        job.counted = false;
        job.controller?.abort();
        job.resolve({ ok: false, clientTxn, error: dropped("stopped") });
      }
      jobs.clear();
      waiting.length = 0;
      uploading = 0;
    },
  };
}
