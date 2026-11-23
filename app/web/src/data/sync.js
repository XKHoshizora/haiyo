// First load, pushes, gap repair and the reconnect procedure (app/service/README.md, "Client contract").
//
// Every connection: get a ticket and open the socket, buffering its pushes; then (if something is held
// already) catch up every held position while `more`, then GET /api/sync and /api/social; then apply the
// buffered pushes. While live, a gap, an unknown conversation, a `conversation` or `social` push starts
// the same kind of repair, and pushes are buffered again until it is done.
//
// Agents (README "Agents and runs", "Replies"). Nothing about Agents delays or breaks the connection: its critical
// path (above) and the moment it goes live are batch 1's. Every connection drops what was streamed before it (deltas
// are not sent again) as the socket opens. Once live it loads, in the background and each on its own: my Agents (then
// single Agents after `agent` pushes, and the proposal cards still open — on a reconnect all of them, since `agent`
// pushes are not replayed either), the run of every Agent conversation (`GET .../run`, a few at a time; one that
// fails is tried once more, then shown as unknown), and on the first connection that manages it the site's models.
// A failure there is isolated: what it was to load is loaded again by the next connection. These answers arrive while
// pushes are applied live, so they are applied by the rules that make a late answer harmless (model.js `applyRun`).
// `principal`, `run`, `delta` and `whisper` pushes are applied as they come.
//
// Agents in a group (batch 2C): a `run` push of a group is kept by (group, Agent) (model.js `applyGroupRun`); a group's
// replies (`GET …/runs`) are loaded when asked (`request({groupRuns})`: the group was opened, or the connection came
// back while it is open), and on a reconnect for every group holding any — on the same few lanes as the runs above, once
// at a time per group; one that fails is tried once more, then its replies being written are shown as unknown.
import * as routes from "../api/routes.js";
import { openSocket } from "../api/socket.js";
import {
  applyAgent,
  applyAgents,
  applyCatchup,
  applyConversation,
  applyDelta,
  applyGone,
  applyGroupRun,
  applyGroupRuns,
  applyMessage,
  applyMessageUpdate,
  applyModels,
  applyPrincipals,
  applyRun,
  applySocial,
  applySync,
  applyWhisper,
  clearStreams,
  dropAgent,
  markGroupRunsUnknown,
  markRunUnknown,
  openProposals,
  positionsOf,
  setAvatarVersion,
  setPeerRead,
  setPrincipalHandle,
  setRead,
  unknownMembers,
} from "./model.js";

export const BACKOFF_MIN_MS = 1000;
export const BACKOFF_MAX_MS = 30_000;
/** A connection that stayed up this long resets the backoff. */
export const STABLE_MS = 30_000;
/** At most this many conversation ids per catch-up request (service: CATCHUP_MAX_POSITIONS). */
export const CATCHUP_MAX_POSITIONS = 500;
/** Close code: the session ended. Sign in again; never reconnect. */
export const CLOSE_SESSION_ENDED = 4001;
/** Close code: a newer socket of mine (another tab) took this one's place; at most 5 are allowed. */
export const CLOSE_REPLACED = 4002;
/** After CLOSE_REPLACED wait this long (plus up to REPLACED_JITTER_MS) so tabs do not keep displacing each other. */
export const REPLACED_DELAY_MS = 60_000;
export const REPLACED_JITTER_MS = 30_000;
/** At most this many `GET .../run` requests of one connection in flight at once. */
export const RUN_FETCHES = 3;
/** A run that could not be fetched is tried once more after this long. */
export const RUN_RETRY_MS = 3000;

const defaultTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (id) => globalThis.clearInterval(id),
};

/** conversation id → its lastSeq, for the conversations held. */
function lastSeqsOf(model) {
  return new Map(Object.values(model.conversations).map((c) => [c.id, c.lastSeq]));
}

/** Delay before reconnect attempt `attempt` (0-based): between 1 s and 30 s, doubling, with jitter. */
export function backoffDelay(attempt, random = Math.random) {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** (attempt + 1));
  return Math.round(base / 2 + (random() * base) / 2);
}

/** The real transport: the service's routes and a ticketed WebSocket on the page's origin. */
export function httpTransport({ timers, WebSocketImpl } = {}) {
  return {
    connect: ({ onEvent, onClose }) =>
      openSocket({ requestTicket: routes.requestWsTicket, urlFor: routes.socketUrl, WebSocketImpl, timers, onEvent, onClose }),
    getSync: routes.getSync,
    catchUp: routes.catchUp,
    getConversation: routes.getConversation,
    getSocial: routes.getSocial,
    listAgents: routes.listAgents,
    getAgent: routes.getAgent,
    getMessage: routes.getMessage,
    getRun: routes.getRun,
    getGroupRuns: routes.getGroupRuns,
    getModels: routes.getModels,
  };
}

const isSignedOut = (err) => err?.status === 401 || err?.code === CLOSE_SESSION_ENDED;

function safeClose(socket) {
  try {
    socket?.close();
  } catch {
    /* already closed */
  }
}

/**
 * Starts keeping the model in step with the service. Returns a handle:
 * `stop()` (closes the socket, cancels timers; late answers are ignored), `pause()` / `resume()` (the iOS shell's
 * `haiyo:pause` / `haiyo:resume`: let the socket go quietly, and come back through the ordinary reconnect procedure below;
 * `paused: true` in the options starts without connecting, for a page that loads in the background) and `request({sync, social,
 * conversation, agents, agent, run, groupRuns})` (ask for fresh state after an action).
 *
 * @param transport {connect({onEvent, onClose}) → Promise<{close()}>, getSync(), catchUp(positions),
 *   getConversation(id), getSocial(), listAgents(), getAgent(id), getMessage(conversationId, seq),
 *   getRun(conversationId), getGroupRuns(conversationId), getModels()}
 */
export function start(
  transport,
  { getModel, setModel, timers = defaultTimers, now = () => Date.now(), random = Math.random, onSignedOut = () => {}, onStatus = () => {}, paused: startPaused = false },
) {
  let alive = true;
  /** The page is in the background (the shell's pause): no socket, no attempt planned, until `resume()`. */
  let paused = startPaused;
  /** Incremented per connection; an async step whose connection is no longer current does nothing. */
  let conn = 0;
  let socket = null;
  let retryTimer = null;
  let attempt = 0;
  let liveSince = null;
  let buffering = true;
  let buffer = [];
  /**
   * Each held conversation's lastSeq when buffering began: a buffered push may be older than the snapshot or catch-up
   * applied before it, and a run it names may have its reply in that snapshot already (`applyRun`'s `since`).
   */
  let floors = new Map();
  let working = false;
  let need = freshNeeds();
  let status = null;
  /** The Agent work of the current connection (`freshAgentNeeds`), and its background loaders (`lanes`). */
  let agentNeed = freshAgentNeeds();
  let lanes = null;
  /** The site's models were loaded since start(). */
  let modelsLoaded = false;
  /** Pending retries of a failed run fetch. */
  const runRetries = new Set();

  function freshNeeds() {
    return { catchupAll: false, catchup: new Set(), sync: false, convs: new Set(), social: false };
  }
  function freshAgentNeeds() {
    return {
      // My Agents: the whole list, single Agents (by id), and the open proposal cards of an Agent (by Agent id).
      agents: false,
      agentIds: new Set(),
      cards: new Set(),
      // Once this connection's /api/sync is in: the run of every Agent conversation (`runAll`), and on a reconnect
      // the open cards of every Agent (`cardsAll`). `runs`: the conversations whose run to fetch; `runTries`: how
      // often a conversation's run fetch failed on this connection.
      runAll: false,
      cardsAll: false,
      runs: new Set(),
      runTries: new Map(),
      // A group's Agent replies: the groups to fetch (`groupRunsHeld`: on this connection's first sync, every group
      // holding any), those being fetched now, and how often a group's fetch failed on this connection.
      groupRunsHeld: false,
      groupRuns: new Set(),
      groupRunsFetching: new Set(),
      groupRunTries: new Map(),
      models: false,
    };
  }
  const hasNeeds = () => need.catchupAll || need.catchup.size > 0 || need.sync || need.convs.size > 0 || need.social;
  const setStatus = (s) => {
    if (s === status) return;
    status = s;
    onStatus(s);
  };

  /** `back`: a return from the background (the shell's resume), which is no failed connection and is not shown as one. */
  async function connect(back = false) {
    retryTimer = null;
    if (!alive || paused) return;
    const my = ++conn;
    working = false;
    buffering = true;
    buffer = [];
    floors = lastSeqsOf(getModel());
    need = freshNeeds();
    const fresh = !getModel().synced;
    // Reconnect: catch up what is held first; sync and social are refetched every time (their pushes are not replayed).
    need.catchupAll = !fresh;
    need.sync = true;
    need.social = true;
    // Nor are `agent`, `run` and `delta`: once live, the Agents, every run and (on a reconnect) the open cards are
    // fetched again, and nothing streamed before this connection is shown any more.
    clearRunRetries();
    agentNeed = freshAgentNeeds();
    agentNeed.agents = true;
    agentNeed.runAll = true;
    agentNeed.groupRunsHeld = true;
    agentNeed.cardsAll = !fresh;
    agentNeed.models = !modelsLoaded;
    lanes = { conn: my, live: false, agents: false, runs: 0, models: false };
    setModel(clearStreams(getModel()));
    setStatus(fresh || back === true ? "connecting" : "reconnecting");
    let s;
    try {
      s = await transport.connect({
        onEvent: (event) => {
          if (my === conn) onEvent(event);
        },
        onClose: (code) => {
          if (my === conn) onSocketClose(code);
        },
      });
    } catch (err) {
      if (my !== conn || !alive) return;
      if (isSignedOut(err)) signedOut();
      else retry();
      return;
    }
    if (my !== conn || !alive) {
      safeClose(s);
      return;
    }
    socket = s;
    await work();
  }

  /** Runs the repairs that are needed, then applies the buffered pushes; repeats until nothing is left. */
  async function work() {
    if (working || !alive || !socket) return;
    const my = conn;
    working = true;
    if (!buffering) floors = lastSeqsOf(getModel());
    buffering = true;
    try {
      for (;;) {
        if (my !== conn) return;
        if (need.catchupAll || need.catchup.size > 0) await catchUp(my);
        else if (need.sync) await sync(my);
        else if (need.convs.size > 0) await refreshConversation(my);
        else if (need.social) await social(my);
        else if (buffer.length > 0) flush();
        else break;
      }
      buffering = false;
      if (liveSince === null) liveSince = now();
      setStatus("live");
      if (lanes?.conn === my) lanes.live = true;
      pumpAgents();
    } catch (err) {
      if (my !== conn || !alive) return;
      if (isSignedOut(err)) signedOut();
      else fail();
    } finally {
      if (my === conn) working = false;
    }
  }

  async function catchUp(my) {
    const ids = need.catchupAll ? Object.keys(getModel().conversations) : [...need.catchup];
    need.catchupAll = false;
    need.catchup.clear();
    for (let i = 0; i < ids.length; i += CATCHUP_MAX_POSITIONS) {
      let chunk = ids.slice(i, i + CATCHUP_MAX_POSITIONS);
      for (;;) {
        const positions = positionsOf(getModel(), chunk);
        if (Object.keys(positions).length === 0) break;
        const res = await transport.catchUp(positions);
        if (my !== conn) return;
        setModel(applyCatchup(getModel(), res).state);
        if (!res.more || !res.messages?.length) break; // `more` always comes with progress; never spin without it
        chunk = chunk.filter((id) => getModel().conversations[id]);
      }
    }
  }

  async function sync(my) {
    need.sync = false;
    need.convs.clear(); // a full sync refreshes every conversation
    const res = await transport.getSync();
    if (my !== conn) return;
    const before = getModel();
    setModel(applySync(before, res));
    // Agent conversations: the run of each new one (of every one, the first time on this connection), the Agent of
    // one not known yet (made in another tab), and on a reconnect the cards still open.
    // (Only noted here; they are loaded once the connection is live, see `pumpAgents`.)
    const after = getModel();
    for (const conv of Object.values(after.conversations)) {
      if (conv.type !== "agent") continue;
      if (agentNeed.runAll || !before.conversations[conv.id]) agentNeed.runs.add(conv.id);
      if (conv.agentId && agentNeed.cardsAll) agentNeed.cards.add(conv.agentId);
      if (conv.agentId && !after.agents[conv.agentId]) agentNeed.agents = true;
    }
    // Groups holding Agent replies from before this connection: what became of them is fetched (the open group asks
    // for itself too).
    if (agentNeed.groupRunsHeld) for (const id of Object.keys(after.groupRuns)) agentNeed.groupRuns.add(id);
    agentNeed.runAll = false;
    agentNeed.cardsAll = false;
    agentNeed.groupRunsHeld = false;
  }

  /**
   * Refetches one held conversation (`GET /api/conversations/:id`: its /api/sync entry). 404: not a member
   * now — drop it (a `gone` follows). Any other error falls back to a full sync, and so does a member
   * nobody has named yet (the full sync lists principals).
   */
  async function refreshConversation(my) {
    const [id] = need.convs;
    need.convs.delete(id);
    if (!getModel().conversations[id]) return; // dropped meanwhile
    let entry;
    try {
      entry = await transport.getConversation(id);
    } catch (err) {
      if (my !== conn) return;
      if (isSignedOut(err)) throw err;
      if (err?.status === 404) setModel(applyGone(getModel(), id));
      else need.sync = true;
      return;
    }
    if (my !== conn) return;
    if (entry?.id !== id) {
      need.sync = true;
      return;
    }
    setModel(applyConversation(getModel(), entry));
    if (unknownMembers(getModel(), id).length > 0) need.sync = true;
  }

  async function social(my) {
    need.social = false;
    const res = await transport.getSocial();
    if (my !== conn) return;
    setModel(applySocial(getModel(), res));
  }

  // ───────── Agent work, in the background once the connection is live (see the header)

  /**
   * Starts the loaders that have work and are idle: one for my Agents and their cards, up to RUN_FETCHES for runs, one
   * for the site's models. Nothing before the connection first went live.
   */
  function pumpAgents() {
    const lane = lanes;
    if (!alive || !lane || !lane.live || lane.conn !== conn) return;
    const n = agentNeed;
    if (!lane.agents && (n.agents || n.agentIds.size > 0 || n.cards.size > 0)) agentLane(lane);
    // (A group already being fetched is not asked again meanwhile: its answer is on its way.)
    for (const id of n.groupRuns) if (n.groupRunsFetching.has(id)) n.groupRuns.delete(id);
    while (lane.runs < RUN_FETCHES && (n.runs.size > 0 || n.groupRuns.size > 0)) runLane(lane);
    if (!lane.models && n.models) modelsLane(lane);
  }

  /** A 401 in a loader ends the session; any other failure stays in that loader. */
  function laneFailed(lane, err) {
    if (lane.conn === conn && alive && isSignedOut(err)) signedOut();
  }

  async function agentLane(lane) {
    lane.agents = true;
    const my = lane.conn;
    try {
      for (;;) {
        if (my !== conn) return;
        if (agentNeed.agents) await agents(my);
        else if (agentNeed.agentIds.size > 0) await refreshAgent(my);
        else if (agentNeed.cards.size > 0) await refreshCards(my);
        else return;
      }
    } catch (err) {
      // The list could not be loaded: the next connection loads it again (single Agents and cards asked for meanwhile
      // wait for the next push or request that wakes this loader).
      laneFailed(lane, err);
    } finally {
      lane.agents = false;
    }
  }

  /** One fetch: an Agent conversation's run first, else a group's Agent replies. */
  async function runLane(lane) {
    const n = agentNeed;
    const group = n.runs.size === 0;
    const [id] = group ? n.groupRuns : n.runs;
    (group ? n.groupRuns : n.runs).delete(id);
    if (group) n.groupRunsFetching.add(id);
    lane.runs += 1;
    try {
      await (group ? refreshGroupRuns(lane.conn, id) : refreshRun(lane.conn, id));
    } catch (err) {
      laneFailed(lane, err);
    } finally {
      if (group) n.groupRunsFetching.delete(id);
      lane.runs -= 1;
      pumpAgents();
    }
  }

  async function modelsLane(lane) {
    lane.models = true;
    agentNeed.models = false;
    try {
      const res = await transport.getModels();
      if (lane.conn !== conn) return;
      setModel(applyModels(getModel(), res));
      modelsLoaded = true;
    } catch (err) {
      // The list stays as it is; the next connection (and Settings, the Agent form) ask again.
      laneFailed(lane, err);
    } finally {
      lane.models = false;
    }
  }

  /** `GET /api/agents`: the whole list. A single Agent asked for while it is on its way is fetched after it. */
  async function agents(my) {
    agentNeed.agents = false;
    agentNeed.agentIds.clear();
    const res = await transport.listAgents();
    if (my !== conn) return;
    setModel(applyAgents(getModel(), res?.agents));
  }

  /** One Agent after an `agent` push. 404: not mine any more (dropped); another failure: the whole list instead. */
  async function refreshAgent(my) {
    const [id] = agentNeed.agentIds;
    agentNeed.agentIds.delete(id);
    let agent;
    try {
      agent = await transport.getAgent(id);
    } catch (err) {
      if (my !== conn) return;
      if (isSignedOut(err)) throw err;
      if (err?.status === 404) setModel(dropAgent(getModel(), id));
      else agentNeed.agents = true;
      return;
    }
    if (my !== conn) return;
    const before = getModel().agents[id];
    setModel(applyAgent(getModel(), agent));
    // Its model became usable or unusable (a provider edit, say): whether its failed replies can be tried again changed
    // with it, so the runs held for it — its own conversation's and its lines in groups — are asked for again.
    if (before && agent && before.modelUsable !== agent.modelUsable) {
      const model = getModel();
      if (typeof agent.conversationId === "string") agentNeed.runs.add(agent.conversationId);
      for (const [groupId, slots] of Object.entries(model.groupRuns)) if (slots && id in slots) agentNeed.groupRuns.add(groupId);
      pumpAgents();
    }
  }

  /**
   * The proposal cards of an Agent that are still open (`GET /api/conversations/:id/messages/:seq` each): one may have
   * been confirmed, discarded, superseded or gone stale. Cards in another state cannot change any more. A card that
   * cannot be fetched now keeps what it shows (confirming or discarding it fetches it again).
   */
  async function refreshCards(my) {
    const [agentId] = agentNeed.cards;
    agentNeed.cards.delete(agentId);
    const { conversationId, seqs } = openProposals(getModel(), agentId);
    for (const seq of seqs) {
      let res;
      try {
        res = await transport.getMessage(conversationId, seq);
      } catch (err) {
        if (my !== conn) return;
        if (isSignedOut(err)) throw err;
        continue;
      }
      if (my !== conn) return;
      if (res?.message?.conversationId === conversationId) setModel(applyMessageUpdate(applyPrincipals(getModel(), res.principals), res.message));
    }
  }

  /**
   * The latest run of an Agent conversation (`GET /api/conversations/:id/run`), an answer that may be older than the
   * pushes applied meanwhile (`applyRun`, not ordered). 404: not a member now (the conversation is checked). Another
   * failure: tried once more after RUN_RETRY_MS; failing again, a run held as queued or running is shown as unknown.
   */
  async function refreshRun(my, id) {
    if (!getModel().conversations[id]) return;
    let res;
    try {
      res = await transport.getRun(id);
    } catch (err) {
      if (my !== conn) return;
      if (isSignedOut(err)) throw err;
      if (err?.status === 404) {
        need.convs.add(id);
        work();
        return;
      }
      const tries = (agentNeed.runTries.get(id) ?? 0) + 1;
      agentNeed.runTries.set(id, tries);
      if (tries < 2) retryRunLater(my, id);
      else setModel(markRunUnknown(getModel(), id));
      return;
    }
    if (my !== conn) return;
    agentNeed.runTries.delete(id);
    if (res && "run" in res) setModel(applyRun(getModel(), id, res.run, { ordered: false }));
  }

  function retryRunLater(my, id, group = false) {
    const timer = timers.setTimeout(() => {
      runRetries.delete(timer);
      if (my !== conn || !alive) return;
      (group ? agentNeed.groupRuns : agentNeed.runs).add(id);
      pumpAgents();
    }, RUN_RETRY_MS);
    runRetries.add(timer);
  }

  /**
   * A group's Agent replies (`GET /api/conversations/:id/runs`), an answer applied by the rules that make a late one
   * harmless (`applyGroupRuns`). 404: not a member now (the conversation is checked). Another failure: tried once more
   * after RUN_RETRY_MS; failing again, its replies held as being written are shown as unknown.
   */
  async function refreshGroupRuns(my, id) {
    if (getModel().conversations[id]?.type !== "group") return;
    let res;
    try {
      res = await transport.getGroupRuns(id);
    } catch (err) {
      if (my !== conn) return;
      if (isSignedOut(err)) throw err;
      if (err?.status === 404) {
        need.convs.add(id);
        work();
        return;
      }
      const tries = (agentNeed.groupRunTries.get(id) ?? 0) + 1;
      agentNeed.groupRunTries.set(id, tries);
      if (tries < 2) retryRunLater(my, id, true);
      else setModel(markGroupRunsUnknown(getModel(), id));
      return;
    }
    if (my !== conn) return;
    agentNeed.groupRunTries.delete(id);
    setModel(applyGroupRuns(getModel(), id, res));
  }

  function clearRunRetries() {
    for (const timer of runRetries) timers.clearTimeout(timer);
    runRetries.clear();
  }

  function flush() {
    const events = buffer;
    buffer = [];
    for (const event of events) handle(event, floors);
  }

  function onEvent(event) {
    if (buffering) {
      buffer.push(event);
      return;
    }
    handle(event);
    if (hasNeeds()) work();
    pumpAgents();
  }

  /** Applies one push; `buffered`: the floors of the buffering it waited through (see `floors`), else null. */
  function handle(event, buffered = null) {
    const model = getModel();
    switch (event.type) {
      case "message": {
        const message = event.message;
        if (!message || typeof message.conversationId !== "string" || !Number.isSafeInteger(message.seq)) return;
        const r = applyMessage(model, message);
        if (r.state !== model) setModel(r.state);
        if (r.unknown) need.sync = true; // I was just added
        else if (r.gap) need.catchup.add(r.gap.conversationId);
        else if (message.senderId && !(message.senderId in r.state.principals)) need.convs.add(message.conversationId);
        return;
      }
      case "conversation":
        if (model.conversations[event.id]) need.convs.add(event.id);
        else need.sync = true; // added (again)
        return;
      case "gone":
        setModel(applyGone(model, event.id));
        need.catchup.delete(event.id);
        need.convs.delete(event.id);
        agentNeed.runs.delete(event.id);
        agentNeed.groupRuns.delete(event.id);
        return;
      case "social":
        need.social = true;
        return;
      case "read": {
        if (!Number.isSafeInteger(event.seq)) return;
        const mine = event.principalId === model.me?.id;
        const next = mine ? setRead(model, event.conversationId, event.seq) : setPeerRead(model, event.conversationId, event.seq);
        if (next !== model) setModel(next);
        return;
      }
      case "agent":
        // One of my Agents changed, or one of its proposals was made, confirmed or discarded.
        if (typeof event.id !== "string") return;
        agentNeed.agentIds.add(event.id);
        agentNeed.cards.add(event.id);
        return;
      case "principal":
        // Its avatar or its handle changed (a rename: an owner's also changes their Agents' full handles).
        setModel(setPrincipalHandle(setAvatarVersion(model, event.id, event.avatarVersion), event.id, event.handle));
        return;
      case "run": {
        if (typeof event.conversationId !== "string") return;
        // A conversation not held when buffering began has no floor: anything of the Agent held counts (no bubble).
        const since = buffered ? buffered.get(event.conversationId) ?? 0 : undefined;
        // A group's: one Agent's reply, the owner's run or anyone else's state (only that is read of it).
        if (model.conversations[event.conversationId]?.type === "group") {
          setModel(applyGroupRun(model, event.conversationId, event.agentId, event, { since }));
          return;
        }
        if (!event.run) return;
        // (`activity`: what its tool is doing now, while it runs tools; only a kind.)
        setModel(applyRun(model, event.conversationId, event.run, { since, activity: event.activity }));
        return;
      }
      case "delta":
        setModel(applyDelta(model, event));
        return;
      case "whisper":
        // A whisper of mine made, answered or expired (one of a conversation not held is left to the sync that brings it).
        setModel(applyWhisper(model, event.whisper));
        return;
      default:
        return;
    }
  }

  function onSocketClose(code) {
    socket = null;
    if (code === CLOSE_SESSION_ENDED) signedOut();
    else if (code === CLOSE_REPLACED) fail(REPLACED_DELAY_MS + Math.round(random() * REPLACED_JITTER_MS));
    else fail();
  }

  /** Gives up this connection and schedules the next one (after `delay` ms, else the backoff). */
  function fail(delay = null) {
    conn += 1;
    safeClose(socket);
    socket = null;
    retry(delay);
  }

  function retry(delay = null) {
    if (!alive || paused) return;
    if (liveSince !== null && now() - liveSince >= STABLE_MS) attempt = 0;
    liveSince = null;
    setStatus("reconnecting");
    let wait = delay;
    if (wait === null) {
      wait = backoffDelay(attempt, random);
      attempt += 1;
    }
    retryTimer = timers.setTimeout(connect, wait);
  }

  function halt() {
    alive = false;
    conn += 1;
    if (retryTimer !== null) timers.clearTimeout(retryTimer);
    retryTimer = null;
    safeClose(socket);
    socket = null;
    buffer = [];
    need = freshNeeds();
    agentNeed = freshAgentNeeds();
    lanes = null;
    clearRunRetries();
    working = false;
  }

  /** Lets the socket go and plans nothing: the same as `halt` except that `resume()` can start again. */
  function pause() {
    if (!alive || paused) return;
    paused = true;
    conn += 1;
    if (retryTimer !== null) timers.clearTimeout(retryTimer);
    retryTimer = null;
    safeClose(socket);
    socket = null;
    buffer = [];
    need = freshNeeds();
    agentNeed = freshAgentNeeds();
    lanes = null;
    clearRunRetries();
    working = false;
    liveSince = null;
    setStatus("idle");
  }

  /** The ordinary reconnect (`connect`): catch-up from what is held, then sync and social. The back-off starts over. */
  function resume() {
    if (!alive || !paused) return;
    paused = false;
    attempt = 0;
    connect(true);
  }

  function signedOut() {
    if (!alive) return;
    halt();
    setStatus("signedOut");
    onSignedOut();
  }

  connect();

  return {
    pause,
    resume,
    stop() {
      if (!alive) return;
      halt();
      setStatus("idle");
    },
    /**
     * Asks for fresh state after an action; done right away when live, else on the next connection. `agents`: my
     * Agents again; `agent`: one Agent and its open proposal cards (as an `agent` push does); `run`: a conversation's
     * run; `groupRuns`: a group's Agent replies (these four in the background, see the header).
     */
    request({ sync = false, social = false, conversation = null, agents = false, agent = null, run = null, groupRuns = null, retryNow = false } = {}) {
      if (!alive) return;
      // 立即重试: the wait before the next attempt is over now (there is no socket and an attempt is only waiting for its back-off).
      if (retryNow && socket === null && retryTimer !== null) {
        timers.clearTimeout(retryTimer);
        retryTimer = null;
        connect();
      }
      if (sync) need.sync = true;
      if (social) need.social = true;
      if (conversation) {
        if (getModel().conversations[conversation]) need.convs.add(conversation);
        else need.sync = true;
      }
      if (agents) agentNeed.agents = true;
      if (agent) {
        agentNeed.agentIds.add(agent);
        agentNeed.cards.add(agent);
      }
      if (run) agentNeed.runs.add(run);
      if (groupRuns) agentNeed.groupRuns.add(groupRuns);
      if (!buffering) work();
      pumpAgents();
    },
    /** Called when a request of the data layer got a 401. */
    signedOut,
  };
}
