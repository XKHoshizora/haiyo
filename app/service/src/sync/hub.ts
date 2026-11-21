import type { WebSocket } from "@fastify/websocket";
import type { FastifyBaseLogger } from "fastify";
import { runAudience, type GroupRunState, type RunAudience, type WireRun } from "../agents/runs.ts";
import type { Activity } from "../agents/runtime/port.ts";
import type { Config } from "../config.ts";
import type { ConversationEvents } from "../conversations/events.ts";
import { currentMemberIds, peekConversation } from "../conversations/store.ts";
import type { Queryable } from "../db.ts";
import { MESSAGE_COLUMNS, toStored, type MessageRow, type StoredMessage, type WireMessage } from "../messages/model.ts";
import { toWireForReaders, type ReadEvents, type ReadMarker } from "../messages/read.ts";
import { handleOf } from "../principals/store.ts";
import { liveSessions } from "../session.ts";
import type { SocialEvents } from "../social/events.ts";
import { readWhispers } from "../whispers/store.ts";
import { wireWhispers, type WireWhisper } from "../whispers/wire.ts";
import type { TicketOwner } from "./tickets.ts";

/** The key of a principal's own queue of whisper pushes (`pushWhisper`), beside the conversations' (a uuid never starts so). */
const WHISPER_QUEUE = "whispers:";
/** A principal's 6th socket closes its oldest. */
export const MAX_SOCKETS_PER_PRINCIPAL = 5;
/** WebSocket-level ping interval; a socket that has not answered the previous ping by the next one is dropped. */
export const HEARTBEAT_MS = 30_000;
/** A socket with this much unsent data cannot keep up; it is closed and its client catches up instead. */
export const MAX_BUFFERED_BYTES = 1024 * 1024;
/** At most this many messages of one conversation go out in one fan-out step; older ones are left to catch-up. */
const FANOUT_MAX_RANGE = 200;
/** How many conversations' "last pushed seq" are remembered (least recently active forgotten first). */
const REMEMBERED_CONVERSATIONS = 10_000;

export const CLOSE_CODES = {
  /** Sign-out, password reset, or the session expired. */
  sessionEnded: 4001,
  /** The principal opened a sixth socket; this was the oldest. */
  replaced: 4002,
  /** The client did not read its pushes fast enough. */
  tooSlow: 4003,
  /** A binary frame (the protocol is JSON text). */
  unsupportedData: 1003,
  /** The server could not confirm the session. */
  internalError: 1011,
} as const;

/** Everything the server ever sends on a socket. */
export type PushEvent =
  | { type: "message"; message: WireMessage }
  | { type: "conversation"; id: string }
  | { type: "gone"; id: string }
  | { type: "social" }
  | { type: "agent"; id: string }
  | { type: "principal"; id: string; avatarVersion: number; handle: string }
  // An Agent's own conversation: to its owner. `activity`: what its running reply's tool is doing (`pushActivity`).
  | { type: "run"; conversationId: string; run: WireRun; activity?: Activity | null }
  // A group: to the Agent's owner, and what every other current member is told of it.
  | { type: "run"; conversationId: string; agentId: string; run: WireRun; activity?: Activity | null }
  | { type: "run"; conversationId: string; agentId: string; state: GroupRunState; activity?: Activity | null }
  | { type: "delta"; conversationId: string; runId: string; text?: string; reasoning?: string }
  | { type: "read"; conversationId: string; principalId: string; seq: number }
  // A whisper of yours, made or changed (answered, expired): to its owner only.
  | { type: "whisper"; whisper: WireWhisper }
  | { type: "pong" };

export interface Connection {
  readonly ws: WebSocket;
  readonly principalId: string;
  readonly sessionId: string;
  /** Answered the last WebSocket ping. */
  alive: boolean;
}

/** One unit of delivery work for a conversation; a conversation's tasks run strictly one after another. */
type Task =
  | { kind: "messages"; fromSeq: number; toSeq: number }
  | { kind: "membership"; principalIds: string[] }
  | { kind: "read"; marker: ReadMarker }
  | { kind: "push"; principalId: string; event: PushEvent; wanted?: () => boolean }
  /** The Agent's reply at `seq`, again, to `principalId` (its run's owner) once its run is charged. */
  | { kind: "charged"; principalId: string; seq: number }
  /** Whisper `whisperId` of `principalId`'s, as it is when delivered (`pushWhisper`). */
  | { kind: "whisper"; principalId: string; whisperId: string }
  /**
   * Run `runId` of the conversation: `run` to the owner its row names (none: the owner is not told), its state to a
   * group's others. `activity` (`pushActivity`): what its tool is doing, with both — dropped if `wanted` says no by then.
   */
  | { kind: "run"; conversationId: string; runId: string; run: WireRun | null; activity?: Activity | null; wanted?: () => boolean; ownerOnly?: true };

interface Queue {
  tasks: Task[];
  running: boolean;
}

export interface HubDeps {
  db: Queryable;
  /** The site models' labels, read when a message is rendered (`via`); the site's time zone, a whisper's hits' times. */
  config: Pick<Config, "siteModels" | "siteTimezone">;
  conversations: ConversationEvents;
  social: SocialEvents;
  reads: ReadEvents;
  log: Pick<FastifyBaseLogger, "error">;
}

/**
 * The in-process registry of open sockets and the delivery of push events to them. Single instance only:
 * a second process would neither see these sockets nor receive these events (see README).
 *
 * Every conversation event is delivered through that conversation's queue, so each socket receives one
 * conversation's events in commit order. Every decision about who receives what is made against the
 * database when the event is delivered, never from a cached member list:
 * - messages: rendered per reader with `toWireForReaders`, which shows a message (and its quote) only to
 *   readers who can see it now, and an Agent's reasoning in a group, and `via`, only to that Agent's owner; an Agent's
 *   reply goes once more to its run's owner when that run has been charged (`pushChargedReply`), so that it carries its
 *   `via`;
 * - membership changes: `conversation` to the affected principals who are current members now, `gone`
 *   to those who are not (more than once, when a change announced before they left is delivered after
 *   it) — so after `gone` nothing more of that conversation reaches them until they are added again, except
 *   the `run` of a reply of their own Agent there (below), so that its end reaches them;
 * - read markers: only in direct chats and Agent conversations, to its current members;
 * - a reply's progress (`run`, `delta`), in order with the conversation's messages: `delta` to the Agent's owner only;
 *   `run` to the owner the run's row names (also after they left a group), and in a group also its state
 *   (`replying` / `unavailable` / null) to every other current member, read once per delivery whatever their number
 *   (`announceRun`); what its tool is doing (`pushActivity`) with both, as a kind only;
 * - a whisper (`pushWhisper`): to its owner only, as it is when delivered (whispers/wire.ts `wireWhispers`: a
 *   `found_elsewhere` one's state derived then, its hits read as she may read them then), on a queue of that owner's
 *   whispers alone; and, after each delivery of a run that tells one (`告诉他们`'s told reply, `agent_runs.whisper_id`),
 *   that whisper too — so every change of a told reply (queued, running, ended, posted or not) reaches its owner's view of
 *   the whisper, without anything being written to the whisper itself.
 */
export class Hub {
  /** Open connections per principal, oldest first. */
  private readonly byPrincipal = new Map<string, Connection[]>();
  private readonly bySession = new Map<string, Set<Connection>>();
  private readonly queues = new Map<string, Queue>();
  /** The last seq fanned out per conversation. */
  private readonly fanned = new Map<string, number>();
  private readonly unsubscribe: Array<() => void> = [];
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly deps: HubDeps) {}

  /** Subscribes to the event registries and starts the heartbeat. */
  start(): void {
    const { conversations, social, reads, log } = this.deps;
    this.unsubscribe.push(
      conversations.onMessages((messages) => this.onMessages(messages)),
      conversations.onMembershipChanged((id, principalIds) => this.enqueue(id, { kind: "membership", principalIds })),
      reads.onRead((marker) => this.enqueue(marker.conversationId, { kind: "read", marker })),
      social.on((principalIds) => {
        for (const id of new Set(principalIds)) this.push(id, { type: "social" });
      }),
    );
    this.timer = setInterval(() => void this.tick().catch((err) => log.error({ err }, "realtime heartbeat failed")), HEARTBEAT_MS);
    this.timer.unref();
  }

  /** Resolves once no delivery is queued or under way (for tests: what a finished test leaves running). */
  async idle(): Promise<void> {
    while (!this.stopped && this.queues.size > 0) await new Promise<void>((r) => setImmediate(r));
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const off of this.unsubscribe.splice(0)) off();
  }

  /** Tells `principalId`'s sockets that Agent `agentId` changed (config, pause, delete, avatar): refetch it. */
  pushAgentChanged(principalId: string, agentId: string): void {
    this.push(principalId, { type: "agent", id: agentId });
  }

  /**
   * After a committed avatar or handle change of `principalId`: tells everyone who can see that principal (they themselves,
   * whoever shares a conversation with them now, their friends, and an Agent's owner) the new `avatarVersion` and `handle`
   * (an Agent's full one, `handleOf`), so their clients load the image again and show the handle. Recipients and version are read in one query, so nobody who shares nothing with them hears of it.
   * Never throws: the change is already committed, and a client that missed the push learns the version at its next sync.
   */
  async pushPrincipalChanged(principalId: string): Promise<void> {
    if (this.stopped || this.byPrincipal.size === 0) return;
    try {
      const { rows } = await this.deps.db.query<{ version: number | null; handle: string; recipients: string[] }>(
        `with seen as (
           select $1::uuid as id
           union select m2.principal_id
                   from memberships m1
                   join memberships m2 on m2.conversation_id = m1.conversation_id and m2.left_seq is null
                  where m1.principal_id = $1 and m1.left_seq is null
           union select case when f.a_id = $1 then f.b_id else f.a_id end from friendships f where f.a_id = $1 or f.b_id = $1
           union select owner_id from principals where id = $1 and owner_id is not null
         )
         select p.avatar_version as version, ${handleOf("p")} as handle, array(select id from seen) as recipients from principals p where p.id = $1`,
        [principalId],
      );
      const version = rows[0]?.version;
      if (version === null || version === undefined) return;
      for (const id of this.connectedAmong(rows[0]!.recipients)) {
        this.push(id, { type: "principal", id: principalId.toLowerCase(), avatarVersion: version, handle: rows[0]!.handle });
      }
    } catch (err) {
      this.deps.log.error({ err, principalId }, "avatar announcement failed");
    }
  }

  /**
   * Tells the run's owner — the one its row names, read at delivery — how a reply of their Agent stands, and in a group
   * every other current member what they may know of it (`announceRun`). Through the conversation's queue, so it
   * reaches them in order with that conversation's messages (`running` after the message it answers, `done` after the
   * reply). Not stored, not replayed: a client that reconnects asks `GET /api/conversations/:id/run` (an Agent's own
   * conversation) or `…/runs` (a group).
   */
  pushRun(conversationId: string, run: WireRun): void {
    this.enqueue(conversationId, { kind: "run", conversationId, runId: run.id, run });
  }

  /**
   * `pushRun` to the run's owner alone: a reply held back at its admission, queued again or claimed again (agents/port-impl.ts)
   * — the other members of a group, told it is replying, are told nothing more, so its going back and forth says nothing
   * about its owner's money.
   */
  pushRunToOwner(conversationId: string, run: WireRun): void {
    this.enqueue(conversationId, { kind: "run", conversationId, runId: run.id, run, ownerOnly: true });
  }

  /**
   * In a group, after the run's owner dismissed its failure: the other current members are told the Agent's state there
   * again (null now, unless a newer run of it says otherwise). The owner, who closed it, is told nothing.
   */
  pushRunState(conversationId: string, runId: string): void {
    this.enqueue(conversationId, { kind: "run", conversationId, runId, run: null });
  }

  /**
   * What the tool of running reply `runId` is doing now — the kind of its work, or null once the model writes again —
   * for its status line: delivered as the run is (`announceRun`), the run, still `running`, to its owner with `activity`,
   * and in a group `activity` with the Agent's state to every other current member while that state is `replying`;
   * nothing of the tool itself (its name, input or output) to anyone. Through the conversation's queue, in order with
   * the reply's other pushes; dropped if `wanted` says no by the time it is delivered (the reply was interrupted).
   */
  pushActivity(conversationId: string, runId: string, activity: Activity | null, wanted?: () => boolean): void {
    const run: WireRun = { id: runId, status: "running", retryable: false };
    this.enqueue(conversationId, { kind: "run", conversationId, runId, run, activity, ...(wanted ? { wanted } : {}) });
  }

  /**
   * A piece of a reply being generated, to `ownerId`'s sockets only, in order with the run's other pushes; dropped if
   * `wanted` says no by the time it is delivered (the reply was interrupted meanwhile).
   */
  pushDelta(
    ownerId: string,
    conversationId: string,
    runId: string,
    delta: { text?: string; reasoning?: string },
    wanted?: () => boolean,
  ): void {
    const event: PushEvent = { type: "delta", conversationId, runId, ...delta };
    this.enqueue(conversationId, { kind: "push", principalId: ownerId, event, ...(wanted ? { wanted } : {}) });
  }

  /**
   * Once the run that posted an Agent's reply has been charged (`DbAgentPort.finish`, or the release of a run whose reply
   * had been posted): the reply at `seq` once more, to `ownerId`'s sockets only, rendered for them when it is delivered
   * like every message, so that it now carries its `via` — what that needs (the run's usage record) is written when the
   * run ends, after the reply's first push was announced, which may have been rendered before it. Pushed only when the
   * rendering carries `via` (the owner can still see the reply and still owns its Agent). Through the conversation's
   * queue, in order with its other pushes (before the run's end); nobody else is pushed anything.
   */
  pushChargedReply(conversationId: string, ownerId: string, seq: number): void {
    this.enqueue(conversationId, { kind: "charged", principalId: ownerId, seq });
  }

  /**
   * A memory notice of the owner's whose status changed, pushed to them again as they may read it now (`toWireForReaders`
   * sends it to its owner only); nobody else is pushed anything.
   */
  pushNoticeAgain(conversationId: string, ownerId: string, seq: number): void {
    this.enqueue(conversationId, { kind: "charged", principalId: ownerId, seq });
  }

  /**
   * A whisper of its owner's (src/whispers/), made or changed — answered, expired, its told reply moved on —, to their
   * sockets only: nobody else is pushed anything of it, ever. Read when it is delivered, so it goes as it is then (each
   * push carries the state at its delivery, and its revision). Through a queue of its owner's whispers, never its
   * conversation's: what is read for it delays nothing any other member is sent (no timing of theirs depends on it); a
   * client places it by `afterSeq` whenever it comes. Not replayed: `GET /api/sync` and catch-up carry the owner's whispers.
   */
  pushWhisper(whisper: { id: string; ownerId: string }): void {
    const ownerId = whisper.ownerId.toLowerCase();
    this.enqueue(`${WHISPER_QUEUE}${ownerId}`, { kind: "whisper", principalId: ownerId, whisperId: whisper.id });
  }

  /** Registers an upgraded socket; closes the principal's oldest socket if this is one too many. */
  attach(ws: WebSocket, owner: TicketOwner): Connection {
    const principalId = owner.principalId.toLowerCase();
    const conn: Connection = { ws, principalId, sessionId: owner.sessionId, alive: true };
    for (;;) {
      const existing = this.byPrincipal.get(principalId);
      if (!existing || existing.length < MAX_SOCKETS_PER_PRINCIPAL) break;
      this.drop(existing[0]!, CLOSE_CODES.replaced, "replaced");
    }
    const list = this.byPrincipal.get(principalId) ?? [];
    list.push(conn);
    this.byPrincipal.set(principalId, list);
    const sessions = this.bySession.get(conn.sessionId) ?? new Set();
    sessions.add(conn);
    this.bySession.set(conn.sessionId, sessions);

    ws.on("pong", () => {
      conn.alive = true;
    });
    ws.on("close", () => this.forget(conn));
    return conn;
  }

  /**
   * Closes the socket if its session no longer exists. Called right after `attach`: a session that ended
   * before the socket was registered is caught here, one that ends later by `endSession`.
   */
  async confirmSession(conn: Connection): Promise<void> {
    const live = await liveSessions(this.deps.db, [conn.sessionId]);
    if (!live.has(conn.sessionId)) this.drop(conn, CLOSE_CODES.sessionEnded, "session_ended");
  }

  /** Closes every socket opened with this session (sign-out; password reset ends each session in turn). */
  endSession(sessionId: string): void {
    for (const conn of [...(this.bySession.get(sessionId) ?? [])]) this.drop(conn, CLOSE_CODES.sessionEnded, "session_ended");
  }

  /** Stops delivering to the socket at once and starts the closing handshake. */
  drop(conn: Connection, code: number, reason: string): void {
    this.forget(conn);
    if (conn.ws.readyState === conn.ws.OPEN) conn.ws.close(code, reason);
  }

  send(conn: Connection, event: PushEvent): void {
    this.sendRaw(conn, JSON.stringify(event));
  }

  /**
   * One heartbeat: drops sockets that did not answer the previous ping, pings the rest, and closes the
   * sockets of sessions that expired (expiry announces nothing, so it is checked here every 30 s).
   */
  async tick(): Promise<void> {
    for (const conns of [...this.byPrincipal.values()]) {
      for (const conn of [...conns]) {
        if (!conn.alive) {
          this.forget(conn);
          conn.ws.terminate();
          continue;
        }
        conn.alive = false;
        conn.ws.ping();
      }
    }
    const sessions = [...this.bySession.keys()];
    if (sessions.length === 0) return;
    const live = await liveSessions(this.deps.db, sessions);
    for (const id of sessions) if (!live.has(id)) this.endSession(id);
  }

  // --- delivery ---------------------------------------------------------------------------

  private onMessages(messages: StoredMessage[]): void {
    const ranges = new Map<string, { fromSeq: number; toSeq: number }>();
    for (const m of messages) {
      const r = ranges.get(m.conversationId);
      ranges.set(m.conversationId, { fromSeq: Math.min(r?.fromSeq ?? m.seq, m.seq), toSeq: Math.max(r?.toSeq ?? m.seq, m.seq) });
    }
    for (const [conversationId, range] of ranges) this.enqueue(conversationId, { kind: "messages", ...range });
  }

  private enqueue(conversationId: string, task: Task): void {
    if (this.stopped) return;
    const id = conversationId.toLowerCase();
    let queue = this.queues.get(id);
    if (!queue) {
      queue = { tasks: [], running: false };
      this.queues.set(id, queue);
    }
    // Consecutive message announcements merge: one step pushes the whole range in seq order.
    const last = queue.tasks.at(-1);
    if (task.kind === "messages" && last?.kind === "messages") {
      last.fromSeq = Math.min(last.fromSeq, task.fromSeq);
      last.toSeq = Math.max(last.toSeq, task.toSeq);
    } else {
      queue.tasks.push(task);
    }
    if (!queue.running) void this.drain(id, queue);
  }

  private async drain(conversationId: string, queue: Queue): Promise<void> {
    queue.running = true;
    while (!this.stopped && queue.tasks.length > 0) {
      const task = queue.tasks.shift()!;
      try {
        await this.run(conversationId, task);
      } catch (err) {
        this.deps.log.error({ err, conversationId }, "realtime delivery failed");
      }
    }
    queue.running = false;
    if (queue.tasks.length === 0) this.queues.delete(conversationId);
  }

  private run(conversationId: string, task: Task): Promise<void> {
    switch (task.kind) {
      case "messages":
        return this.fanOut(conversationId, task.fromSeq, task.toSeq);
      case "membership":
        return this.announceMembership(conversationId, task.principalIds);
      case "read":
        return this.announceRead(conversationId, task.marker);
      case "push":
        if (task.wanted?.() !== false) this.push(task.principalId, task.event);
        return Promise.resolve();
      case "run":
        if (task.wanted?.() === false) return Promise.resolve();
        return this.announceRun(task);
      case "charged":
        return this.pushCharged(conversationId, task.principalId, task.seq);
      case "whisper":
        return this.pushWhisperNow(task.principalId, task.whisperId);
    }
  }

  /** `pushWhisper`'s delivery: the whisper as its owner (`principalId`) may read it now, when they are connected. */
  private async pushWhisperNow(principalId: string, whisperId: string): Promise<void> {
    const [owner] = this.connectedAmong([principalId]);
    if (!owner) return;
    const found = await readWhispers(this.deps.db, owner, [whisperId]);
    if (found.length === 0) return;
    const [whisper] = await wireWhispers(this.deps.db, found, this.deps.config.siteTimezone);
    this.push(owner, { type: "whisper", whisper: whisper! });
  }

  /** `pushChargedReply`'s delivery: the reply as `principalId` may read it now, when that carries `via`. */
  private async pushCharged(conversationId: string, principalId: string, seq: number): Promise<void> {
    const [reader] = this.connectedAmong([principalId]);
    if (!reader) return;
    const { rows } = await this.deps.db.query<MessageRow>(
      // A raw row: it leaves this function only through toWireForReaders, which applies the visibility rule.
      `select ${MESSAGE_COLUMNS} from messages m where m.conversation_id = $1 and m.seq = $2`,
      [conversationId, seq],
    );
    if (!rows[0]) return;
    const [message] = (await toWireForReaders(this.deps.db, [reader], [toStored(rows[0])], this.deps.config)).get(reader) ?? [];
    if (message?.via || message?.system?.event === "memory_changed") this.push(reader, { type: "message", message });
  }

  /**
   * One delivery of a run, decided against the database now, with one statement however many members the conversation
   * has (`runAudience`): so announcing an unchanged run again (an Agent's one `rate_limited` run in a group, at every
   * mention over its owner's limit) costs one read and repeats the same state, which a client applies as a state. The
   * run itself goes to its owner as its row names it — whoever announced it. That read is tried once more when it
   * fails; failing again, this delivery is dropped (logged) and the conversation's queue goes on: a client learns the
   * state from the next delivery or `GET …/run` / `…/runs`.
   * - An Agent's own conversation: `{type, conversationId, run}` to its owner, as it always was.
   * - A group: `{…, agentId, run}` to the Agent's owner — also when they have just left the group with it, so its last
   *   run there ends what their client showed —; `{…, agentId, state}` to every other current member, the Agent's state
   *   there now (wire contract "Run state": never the run, its id, `error`, `retryable` or `resetsAt`); nobody else.
   * - What a running reply's tool is doing (`pushActivity`): `activity` with each of those, the kind only; to the others
   *   only while the Agent's state there is `replying` (it is that reply's, then).
   */
  private async announceRun(task: Extract<Task, { kind: "run" }>): Promise<void> {
    if (this.byPrincipal.size === 0) return;
    const { conversationId, runId, run } = task;
    const tool = task.activity === undefined ? {} : { activity: task.activity };
    let audience: RunAudience | null;
    try {
      audience = await runAudience(this.deps.db, conversationId, runId);
    } catch {
      try {
        audience = await runAudience(this.deps.db, conversationId, runId);
      } catch (err) {
        this.deps.log.error({ err, conversationId, runId }, "realtime: a run push was dropped: who is told what could not be read (twice)");
        return;
      }
    }
    if (!audience) return;
    const ownerId = audience.ownerId.toLowerCase();
    if (audience.type !== "group") {
      if (run) this.push(ownerId, { type: "run", conversationId, run, ...tool });
      return;
    }
    const { agentId, state } = audience;
    if (run) this.push(ownerId, { type: "run", conversationId, agentId, run, ...tool });
    // A told reply (`告诉他们`): its whisper as its owner reads it then — telling, told, or open again —, to them alone, on
    // their whispers' own queue (nothing is read for it here, before what the others are told).
    if (run && audience.whisperId !== null) this.pushWhisper({ id: audience.whisperId, ownerId });
    if (task.ownerOnly) return;
    if (task.activity !== undefined && state !== "replying") return;
    for (const id of this.connectedAmong(audience.memberIds)) {
      if (id !== ownerId) this.push(id, { type: "run", conversationId, agentId, state, ...tool });
    }
  }

  /**
   * Pushes the conversation's messages up to `toSeq` that have not gone out yet, read from the table in
   * seq order (every seq up to `toSeq` is committed: seqs are assigned under the row lock). Transactions
   * can announce out of commit order; reading the range instead of the announced messages keeps each
   * socket's stream ascending. Each reader gets only what they can see now, quotes resolved for them.
   */
  private async fanOut(conversationId: string, fromSeq: number, toSeq: number): Promise<void> {
    const after = Math.max(this.fanned.get(conversationId) ?? fromSeq - 1, toSeq - FANOUT_MAX_RANGE);
    if (toSeq <= after) return;
    const readers = this.connectedAmong(await currentMemberIds(this.deps.db, conversationId));
    if (readers.length > 0) {
      const { rows } = await this.deps.db.query<MessageRow>(
        // Raw rows: they leave this function only through toWireForReaders, which applies the visibility rule.
        `select ${MESSAGE_COLUMNS} from messages m
          where m.conversation_id = $1 and m.seq > $2 and m.seq <= $3 order by m.seq`,
        [conversationId, after, toSeq],
      );
      const perReader = await toWireForReaders(this.deps.db, readers, rows.map(toStored), this.deps.config);
      for (const [reader, messages] of perReader) for (const message of messages) this.push(reader, { type: "message", message });
    }
    this.fanned.delete(conversationId);
    this.fanned.set(conversationId, toSeq);
    if (this.fanned.size > REMEMBERED_CONVERSATIONS) this.fanned.delete(this.fanned.keys().next().value!);
  }

  private async announceMembership(conversationId: string, principalIds: string[]): Promise<void> {
    const affected = this.connectedAmong(principalIds);
    if (affected.length === 0) return;
    const current = new Set(await currentMemberIds(this.deps.db, conversationId));
    for (const id of affected) {
      this.push(id, current.has(id) ? { type: "conversation", id: conversationId } : { type: "gone", id: conversationId });
    }
  }

  private async announceRead(conversationId: string, marker: ReadMarker): Promise<void> {
    const peek = await peekConversation(this.deps.db, conversationId);
    // Read positions are shown in direct chats and, for the Agent's, in its owner's conversation with it; not in groups.
    if (peek?.type === "direct" ? !peek.pair || this.connectedAmong(peek.pair).length === 0 : peek?.type !== "agent") return;
    const readers = this.connectedAmong(await currentMemberIds(this.deps.db, conversationId));
    for (const id of readers) {
      this.push(id, { type: "read", conversationId, principalId: marker.principalId.toLowerCase(), seq: marker.seq });
    }
  }

  // --- sockets ----------------------------------------------------------------------------

  /** The distinct (lower-cased) ids among `ids` that have a socket here. */
  private connectedAmong(ids: readonly string[]): string[] {
    return [...new Set(ids.map((id) => id.toLowerCase()))].filter((id) => this.byPrincipal.has(id));
  }

  private push(principalId: string, event: PushEvent): void {
    const conns = this.byPrincipal.get(principalId.toLowerCase());
    if (!conns) return;
    const data = JSON.stringify(event);
    for (const conn of [...conns]) this.sendRaw(conn, data);
  }

  private sendRaw(conn: Connection, data: string): void {
    if (conn.ws.readyState !== conn.ws.OPEN) return;
    if (conn.ws.bufferedAmount > MAX_BUFFERED_BYTES) return this.drop(conn, CLOSE_CODES.tooSlow, "too_slow");
    conn.ws.send(data);
  }

  private forget(conn: Connection): void {
    const list = this.byPrincipal.get(conn.principalId);
    if (list) {
      const i = list.indexOf(conn);
      if (i >= 0) list.splice(i, 1);
      if (list.length === 0) this.byPrincipal.delete(conn.principalId);
    }
    const sessions = this.bySession.get(conn.sessionId);
    if (sessions) {
      sessions.delete(conn);
      if (sessions.size === 0) this.bySession.delete(conn.sessionId);
    }
  }
}
