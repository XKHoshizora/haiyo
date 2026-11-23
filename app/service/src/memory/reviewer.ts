import type { FastifyBaseLogger } from "fastify";
import type { SummaryContext, SummaryJob } from "../agents/summary/job.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db.ts";
import type { CatchUpContext, CatchUpJob } from "./catchup.ts";
import { notAcknowledgement } from "../messages/model.ts";
import { socialPlaceSql } from "../social/place.ts";
import { liveAgents, newDreamState, SWEEP_JOB, type DreamContext, type DreamJob, type NapJob, type SweepJob } from "./dream.ts";
import type { FlagsContext, FlagsJob } from "./hearsay.ts";
import type { ConversionState, ConvertJob, ConvertResult, MemoryLanguage } from "./language.ts";
import { errInfo, inSocial, reviewableAgent, reviewedSeq, type ReviewJob } from "./pipeline.ts";
import { countDroppedFlags } from "./stats.ts";
import { EXPLICIT } from "./review.ts";

/** The kinds of job that name no conversation: memory's own housekeeping, which `pump` lets through whatever a conversation is. Every other kind is asked whether its conversation is a social one. */
const NO_CONVERSATION_KINDS: ReadonlySet<string> = new Set(["dream", "nap", "convert", "sweep"]);

/**
 * When a review runs (what it does is pipeline.ts): after an Agent's reply, once the conversation has been quiet
 * `MEMORY.quietMs`, at once after `maxReplies` replies since the last review or when the owner's latest message asks for
 * something to be remembered, forgotten or locked, and at once when the owner starts a new topic. A trigger never fires
 * unless the owner said something after what the last attempt looked at, so a review that failed is not asked again for the
 * same words — except one whose call could not start because the owner had as many calls running as they may: it is run once
 * more `RETRY_MS` later (once only). One job per Agent at a time (a trigger meanwhile waits and runs once after it), at most
 * `MAX_REVIEWS_AT_ONCE` overall. A review never reaches across a new topic (review.ts): one that left the owner's words of a later
 * topic asks (`more`) for another review of the pair, queued at once and run after it.
 *
 * A flagged group message (`flagged`, after the judgement wrote its `memory_flags` row) waits for the group's quiet too:
 * the pair's wake-up (hearsay.ts `runFlags`: the owner's own remarks reviewed, then the hearsay) runs `MEMORY.groupQuietMs`
 * after the pair's latest flag, or `MEMORY.groupMaxWaitMs` after the first of the batch, whichever comes first. A wake-up
 * that could not ask its model keeps the flags for one more try and asks to be woken again after the quiet time (`again`);
 * how often a flag has been tried is stored with it (hearsay.ts).
 *
 * In memory, in this one process, as the proactive scheduler is: it never throws and never rejects (what goes wrong is
 * logged with ids, never a note or an answer). `close()` cancels every timer and waiting job and abandons calls under way.
 * The job type is open (`kind`) for the jobs a later batch adds. Timers come from the caller, so tests never sleep.
 *
 * 入梦 (dream.ts): a sweep timer, armed once when the reviewer starts (`resume`) and again after each sweep, every
 * `MEMORY.dreamSweepMs`, runs a `sweep` job that finds the owners who dream and asks, for each, for a `dream` job (one owner's
 * rooms, one after another: two dream jobs of one owner never run together). After a change was applied (`changed`) a `nap`
 * job looks at whether a room is nearly full. The sweep's jobs run through the same runner, so they have the clock the
 * pipeline has; what they remember between runs is `DreamState`, here.
 *
 * 也回顾一下 in a group (catchup.ts): memory switched on with catchUp queues a `catchup` job for every group whose catch-up the switch
 * stored (`memory_catchups`), and `resume` queues every one a restart left unfinished; they run as any job of the Agent (one at a time).
 * The rolling summary (agents/summary/job.ts) runs here too: after a reply whose context left out enough (`summarise`), a
 * `summary` job — one per pair at a time (one job per Agent at a time, as every job), within `MAX_REVIEWS_AT_ONCE`; a second
 * request while one waits only moves what it is to cover up to. Nothing of when a pair may be asked again is kept here: that
 * is the pair's attempt state, in the database (agents/summary/store.ts `AttemptState`).
 */

export const MAX_REVIEWS_AT_ONCE = 4;

export type SetTimer = (fn: () => void, ms: number) => { clear(): void };

/** `setTimeout` that never holds the process open. */
export const realTimer: SetTimer = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  timer.unref();
  return { clear: () => clearTimeout(timer) };
};

export type Job = ReviewJob | FlagsJob | DreamJob | NapJob | SweepJob | ConvertJob | CatchUpJob | SummaryJob;

/** What a job is handed: the context of every kind (each job uses what its kind needs). */
export type JobContext = FlagsContext & DreamContext & CatchUpContext & SummaryContext;

export interface ReviewerDeps {
  db: Db;
  config: Pick<Config, "memory">;
  log: Pick<FastifyBaseLogger, "error" | "warn" | "info">;
  /** The service is stopping: a job under way is told (its `closing`). `close()` ends them too. */
  closing?: AbortSignal;
  setTimer: SetTimer;
  /** Does one job (pipeline.ts `runReview`, hearsay.ts `runFlags`, dream.ts `runDreamJob`, agents/summary/job.ts `runSummary`, by `kind`); may reject: it is logged. */
  run(job: Job, ctx: JobContext): Promise<unknown>;
}

export interface Reviewer {
  /** After commit: Agent `agentId` posted a reply in `conversationId` (its own, or a group). */
  noted(agentId: string, conversationId: string): void;
  /** After commit: the owner started a new topic in the Agent's own conversation. */
  topicReset(agentId: string, conversationId: string): void;
  /**
   * After a reply of Agent `agentId` in `conversationId` was posted, whose context left out messages, the last of them placed
   * at `upTo` (agents/port-impl.ts `finish`): a `summary` job is queued for the pair (it makes a call only when what waits is
   * worth it, agents/summary/job.ts).
   */
  summarise(agentId: string, conversationId: string, upTo: number): void;
  /** After the row is written: a message of `conversationId` was flagged for the Agent (hearsay, or the owner's own remark). */
  flagged(agentId: string, conversationId: string, kind: "hearsay" | "own"): void;
  /** After commit: a change was applied (or confirmed) in the notes of this Agent's owner, which may have left a room nearly full. */
  changed(agentId: string): void;
  /**
   * After commit: Agent `agentId`'s `memory` was switched off or on (pipeline.ts `memorySwitched`). What was waiting for it is dropped —
   * its quiet timers, its flags' wake-ups, its retry, its queued reviews (one under way applies nothing once memory is off, nor once it
   * is on again: pipeline.ts `runReview`), and its waiting catch-ups. `lookBack` (turned on with `catchUp`): one review of its own
   * conversation `conversationId` is queued, as after a quiet time, and a catch-up for every group the switch stored one for.
   */
  switched(agentId: string, conversationId: string, lookBack: boolean): void;
  /**
   * The owner asked for their notes to be restated in `language` (dream.ts `ConvertJob`): "started" once the job is queued (it runs
   * on its own; `conversion` says how it stands); "busy" when a dream or a conversion of theirs is already under way or waiting; null
   * when the service is stopping.
   */
  convert(ownerId: string, language: MemoryLanguage): Promise<"started" | "busy" | null>;
  /**
   * Where the owner's latest conversion stands, in this process's memory: `running` from `convert` until its job ends, then `done`
   * with what it did until the next conversion (or a restart: `idle`); `idle` too when the job did not run (the service stopping).
   */
  conversion(ownerId: string): ConversionState;
  /** How many pairs the scheduler remembers an attempt for (for tests: it must not grow with the pairs reviewed). */
  remembered(): number;
  /**
   * At start: arms a quiet timer for every pair whose Agent replied in the last day and has replies after `reviewed_seq`,
   * and a wake-up for every pair with flags left over from the last day (older flags are deleted); queues every catch-up left
   * unfinished; how many pairs. Also arms the dream sweep (one timer: arming it again moves it).
   */
  resume(): Promise<number>;
  close(): void;
  /** Resolves once nothing is being looked at, nothing waits and no job is under way (timers do not count). */
  idle(): Promise<void>;
}

/** How long a review whose call met the owner's cap of calls running waits for its one retry. */
export const RETRY_MS = 60_000;

/** How far back a restart looks for replies nobody reviewed. */
const RESUME_WINDOW = "24 hours";

const keyOf = (agentId: string, conversationId: string): string => `${agentId}|${conversationId}`;

export function createReviewer(deps: ReviewerDeps): Reviewer {
  const { db, config, log } = deps;
  const stop = new AbortController();
  const closing = deps.closing ? AbortSignal.any([deps.closing, stop.signal]) : stop.signal;
  const timers = new Map<string, { clear(): void }>();
  /** The waiting wake-ups of pairs with flags: the quiet timer (moved by every flag) and the one from the batch's first flag. */
  const flagTimers = new Map<string, Array<{ clear(): void }>>();
  /** When each pair's paid hearsay calls were made, for the hour's cap (`FlagsContext.hearsayCalls`), by pair. */
  const hearsayCalls = new Map<string, number[]>();
  /** The newest seq the last attempt of each pair looked at (a failed call is not asked again for the same words). */
  const attempted = new Map<string, number>();
  /** The pairs whose review waits `RETRY_MS` for its one retry (its call met the owner's cap of calls running). */
  const retries = new Map<string, { clear(): void }>();
  const dream = newDreamState();
  let sweepTimer: { clear(): void } | null = null;
  /** The owners with a dream job under way: the rooms of one owner are never consolidated in parallel. */
  const dreaming = new Set<string>();
  /** Each owner's latest conversion: under way, or what it did (until the next one; a restart forgets them all). */
  const conversions = new Map<string, { state: "running" } | { state: "done"; result: ConvertResult }>();
  let waiting: Job[] = [];
  const running = new Set<string>();
  /** Evaluations of a trigger under way (they read the database before deciding). */
  let looking = 0;
  const idlers: Array<() => void> = [];
  let closed = false;

  const settleIdle = (): void => {
    if (looking === 0 && running.size === 0 && waiting.length === 0) for (const done of idlers.splice(0)) done();
  };

  /** An attempt is remembered only until `reviewed_seq` has caught up with it (then `reviewed_seq` says the same). */
  const forgetReached = async (job: Job): Promise<void> => {
    const key = keyOf(job.agentId, job.conversationId);
    const tried = attempted.get(key);
    if (tried === undefined) return;
    try {
      if ((await reviewedSeq(db, job.agentId, job.conversationId)) >= tried && attempted.get(key) === tried) attempted.delete(key);
    } catch {
      // Kept: the next trigger reads the database again.
    }
  };

  const pump = (): void => {
    if (closed) return;
    for (const job of [...waiting]) {
      if (running.size >= MAX_REVIEWS_AT_ONCE) return;
      if (running.has(job.agentId) || (alone(job) && dreaming.has(job.ownerId))) continue;
      waiting = waiting.filter((j) => j !== job);
      running.add(job.agentId);
      if (alone(job)) dreaming.add(job.ownerId);
      const key = keyOf(job.agentId, job.conversationId);
      const ctx: JobContext = {
        closing,
        attempted: (seq) => attempted.set(key, Math.max(seq, attempted.get(key) ?? 0)),
        again: (afterMs) => void (job.kind === "flags" && armFlags(job, afterMs)),
        // Queued now, it runs once this job is done (one job per Agent at a time).
        more: () => void (job.kind === "review" && enqueueIfNew(job)),
        retry: () => void (job.kind === "review" && !job.retried && armRetry(job)),
        hearsayCalls: hearsayCalls.get(key) ?? [],
        changed: (agentId) => api.changed(agentId),
        dream,
        enqueue: (next) => enqueue(next),
        flagged: (agentId, conversationId, kind) => api.flagged(agentId, conversationId, kind),
      };
      if (job.kind === "flags") hearsayCalls.set(key, ctx.hearsayCalls);
      void Promise.resolve()
        .then(async () => {
          // Memory never works in a social conversation (plan A9): the one place every kind of job that names a conversation passes.
          if (!NO_CONVERSATION_KINDS.has(job.kind) && (await inSocial(db, job.conversationId))) return;
          return deps.run(job, ctx);
        })
        .catch((err: unknown) => log.error({ ...errInfo(err), agentId: job.agentId, conversationId: job.conversationId }, "a memory review failed; nothing was changed"))
        .then(() => forgetReached(job))
        .finally(() => {
          if (ctx.hearsayCalls.length === 0) hearsayCalls.delete(key);
          running.delete(job.agentId);
          if (alone(job)) dreaming.delete(job.ownerId);
          if (job.kind === "convert") job.settle(null);
          if (job.kind === "sweep") armSweep();
          pump();
          settleIdle();
        })
        .catch(() => {});
    }
    settleIdle();
  };

  /** A job that takes the whole of an owner's notes: two of them never run together (`dreaming`). */
  const alone = (job: Job): job is DreamJob | ConvertJob => job.kind === "dream" || job.kind === "convert";

  const sameJob = (a: Job, b: Job): boolean =>
    a.kind === b.kind && a.agentId === b.agentId && a.conversationId === b.conversationId && (a.kind !== "dream" || (b.kind === "dream" && a.scope === b.scope));

  const enqueue = (job: Job): void => {
    if (closed) return;
    const queued = waiting.find((j) => sameJob(j, job));
    // A summary waiting already covers up to the later of the two places.
    if (queued === undefined) waiting.push(job);
    else if (queued.kind === "summary" && job.kind === "summary") queued.upTo = Math.max(queued.upTo, job.upTo);
    pump();
  };

  /** (Re)arms the one sweep timer; it fires a `sweep` job, which arms the next when it is done. */
  const armSweep = (): void => {
    if (closed) return;
    sweepTimer?.clear();
    sweepTimer = deps.setTimer(() => {
      sweepTimer = null;
      enqueue(SWEEP_JOB);
    }, config.memory.dreamSweepMs);
  };

  const track = async (work: () => Promise<void>): Promise<void> => {
    looking++;
    try {
      await work();
    } catch (err) {
      log.error(errInfo(err), "a memory trigger could not be read; it is dropped");
    } finally {
      looking--;
      settleIdle();
    }
  };

  /** The owner's latest message after what was reviewed or attempted; null when there is none. */
  const ownerSince = async (agentId: string, conversationId: string, after: number): Promise<{ seq: number; text: string } | null> => {
    const { rows } = await db.query<{ seq: string; text: string | null }>(
      `select m.seq::text, m.body ->> 'text' as text from messages m
        where m.conversation_id = $1 and m.kind in ('text', 'file') and m.seq > $3
          and m.sender_id = (select owner_id from principals where id = $2)
        order by m.seq desc limit 1`,
      [conversationId, agentId, after],
    );
    return rows[0] ? { seq: Number(rows[0].seq), text: rows[0].text ?? "" } : null;
  };

  /** The seq below which nothing is asked again: reviewed, or attempted. */
  const floorOf = async (agentId: string, conversationId: string): Promise<number> =>
    Math.max(await reviewedSeq(db, agentId, conversationId), attempted.get(keyOf(agentId, conversationId)) ?? 0);

  /** A job to run now, unless the owner said nothing since the last attempt. */
  const enqueueIfNew = (job: Job): Promise<void> =>
    track(async () => {
      if (closed || (await inSocial(db, job.conversationId)) || (await ownerSince(job.agentId, job.conversationId, await floorOf(job.agentId, job.conversationId))) === null) return;
      enqueue(job);
    });

  /** Arms the pair's quiet timer; false when the reviewer is closed and nothing was armed. */
  const arm = (job: Job): boolean => {
    if (closed) return false;
    const key = keyOf(job.agentId, job.conversationId);
    timers.get(key)?.clear();
    timers.set(
      key,
      deps.setTimer(() => {
        timers.delete(key);
        void enqueueIfNew(job);
      }, config.memory.quietMs),
    );
    return true;
  };

  /**
   * (Re)arms the pair's flag wake-up: the quiet timer starts over, the maximum one starts only with the batch's first flag.
   * `afterMs` (a wake-up that must wait for something, the hour's cap) is the time to wait instead of the quiet time, and
   * the maximum wait does not cut it short. False when the reviewer is closed and nothing was armed.
   */
  const armFlags = (job: FlagsJob, afterMs: number = config.memory.groupQuietMs): boolean => {
    if (closed) return false;
    const key = keyOf(job.agentId, job.conversationId);
    const [quiet, max] = flagTimers.get(key) ?? [];
    quiet?.clear();
    const wake = (): void => {
      for (const timer of flagTimers.get(key) ?? []) timer.clear();
      flagTimers.delete(key);
      enqueue(job);
    };
    flagTimers.set(key, [deps.setTimer(wake, afterMs), max ?? deps.setTimer(wake, Math.max(afterMs, config.memory.groupMaxWaitMs))]);
    return true;
  };

  /** The one retry of a review whose call met the owner's cap: queued `RETRY_MS` later, the same words (it is not asked whether the owner said more). */
  const armRetry = (job: ReviewJob): void => {
    if (closed) return;
    const key = keyOf(job.agentId, job.conversationId);
    retries.get(key)?.clear();
    retries.set(
      key,
      deps.setTimer(() => {
        retries.delete(key);
        enqueue({ ...job, retried: true });
      }, RETRY_MS),
    );
  };

  const disarm = (job: Job): void => {
    const key = keyOf(job.agentId, job.conversationId);
    timers.get(key)?.clear();
    timers.delete(key);
  };

  /**
   * Queues a `catchup` job for every unfinished catch-up of the Agent (`agentId`), or of every Agent with memory on (none given); how
   * many. A paused or deleted Agent's too: its job ends it (catchup.ts), so a pause is handled one way wherever it falls.
   */
  async function queueCatchUps(agentId?: string): Promise<number> {
    const { rows } = await db.query<{ agent_id: string; conversation_id: string }>(
      `select c.agent_id, c.conversation_id from memory_catchups c
         join agents a on a.principal_id = c.agent_id and a.memory
          join conversations cc on cc.id = c.conversation_id and not ${socialPlaceSql("cc")}
        where c.next_seq <= c.to_seq and ($1::uuid is null or c.agent_id = $1)
        order by c.created_at, c.conversation_id`,
      [agentId ?? null],
    );
    for (const r of rows) enqueue({ kind: "catchup", agentId: r.agent_id, conversationId: r.conversation_id });
    return closed ? 0 : rows.length;
  }

  /** Decides what a reply means for the pair: review at once, or (re)arm its quiet timer. */
  async function considerReply(agentId: string, conversationId: string): Promise<void> {
    if (closed || (await reviewableAgent(db, agentId)) === null || (await inSocial(db, conversationId))) return;
    const job: Job = { kind: "review", agentId, conversationId };
    const reviewed = await reviewedSeq(db, agentId, conversationId);
    const fresh = await ownerSince(agentId, conversationId, Math.max(reviewed, attempted.get(keyOf(agentId, conversationId)) ?? 0));
    // The replies since the last review: those after the owner's first line it has not looked at (a review stops at the owner's last
    // line, so the Agent's reply to it comes after `reviewed` but answers what was reviewed). An acknowledgement is no reply.
    const { rows } = await db.query<{ replies: number }>(
      `select count(*)::int as replies from messages m
        where m.conversation_id = $1 and m.sender_id = $2 and m.kind = 'text' and m.seq > $3 and (m.body -> 'fixed') is distinct from 'true'::jsonb
          and ${notAcknowledgement("m")}
          and m.seq > coalesce((select min(o.seq) from messages o
                                 where o.conversation_id = $1 and o.kind in ('text', 'file') and o.seq > $3
                                   and o.sender_id = (select owner_id from principals where id = $2)), 9223372036854775807)`,
      [conversationId, agentId, reviewed],
    );
    if (fresh !== null && ((rows[0]?.replies ?? 0) >= config.memory.maxReplies || EXPLICIT.test(fresh.text))) {
      disarm(job);
      enqueue(job);
    } else {
      arm(job);
    }
  }

  const api: Reviewer = {
    noted(agentId, conversationId) {
      if (closed) return;
      void track(() => considerReply(agentId, conversationId));
    },
    topicReset(agentId, conversationId) {
      if (closed) return;
      const job: Job = { kind: "review", agentId, conversationId };
      disarm(job);
      void enqueueIfNew(job);
    },
    summarise(agentId, conversationId, upTo) {
      enqueue({ kind: "summary", agentId, conversationId, upTo });
    },
    flagged(agentId, conversationId) {
      armFlags({ kind: "flags", agentId, conversationId });
    },
    changed(agentId) {
      enqueue({ kind: "nap", agentId, conversationId: "nap" });
    },
    switched(agentId, conversationId, lookBack) {
      if (closed) return;
      const its = (key: string): boolean => key.startsWith(`${agentId}|`);
      for (const armed of [timers, retries]) {
        for (const [key, timer] of armed) {
          if (!its(key)) continue;
          timer.clear();
          armed.delete(key);
        }
      }
      for (const [key, pair] of flagTimers) {
        if (!its(key)) continue;
        for (const timer of pair) timer.clear();
        flagTimers.delete(key);
      }
      waiting = waiting.filter((j) => j.agentId !== agentId || (j.kind !== "review" && j.kind !== "flags" && j.kind !== "catchup"));
      if (lookBack) {
        void enqueueIfNew({ kind: "review", agentId, conversationId });
        void track(async () => void (await queueCatchUps(agentId)));
      }
      settleIdle();
    },
    async convert(ownerId, language) {
      if (closed) return null;
      const agents = await liveAgents(db, ownerId);
      // Decided and queued with nothing awaited in between: two requests never both get in.
      if (closed) return null;
      if (dreaming.has(ownerId) || waiting.some((j) => alone(j) && j.ownerId === ownerId)) return "busy";
      if (agents.length === 0) {
        conversions.set(ownerId, { state: "done", result: { rooms: 0, converted: 0, kept: 0, noRoom: 0, failedRooms: 0 } });
        return "started";
      }
      conversions.set(ownerId, { state: "running" });
      // Told once: what the job did, or null (it did not run) when the scheduler ends it without a tally.
      let settled = false;
      const settle = (result: ConvertResult | null): void => {
        if (settled) return;
        settled = true;
        if (result === null) conversions.delete(ownerId);
        else conversions.set(ownerId, { state: "done", result });
      };
      enqueue({ kind: "convert", agentId: agents[0]!.id, conversationId: "convert", ownerId, language, settle });
      return "started";
    },
    conversion: (ownerId) => conversions.get(ownerId) ?? { state: "idle" },
    remembered: () => attempted.size,
    async resume() {
      armSweep();
      let armed = 0;
      await track(async () => {
        const { rows } = await db.query<{ agent_id: string; conversation_id: string }>(
          `select distinct m.sender_id as agent_id, m.conversation_id
             from messages m
             join conversations rc on rc.id = m.conversation_id and not ${socialPlaceSql("rc")}
             join agents a on a.principal_id = m.sender_id and a.memory and not a.paused and a.deleted_at is null
             left join memory_review_state s on s.agent_id = m.sender_id and s.conversation_id = m.conversation_id
            where m.kind = 'text' and m.created_at > now() - interval '${RESUME_WINDOW}' and (m.body -> 'fixed') is distinct from 'true'::jsonb
              and ${notAcknowledgement("m")}
              and m.seq > coalesce(s.reviewed_seq, 0)
              and exists (select 1 from messages o
                           where o.conversation_id = m.conversation_id and o.kind in ('text', 'file') and o.seq > coalesce(s.reviewed_seq, 0) and o.seq < m.seq
                             and o.sender_id = (select owner_id from principals where id = m.sender_id))`,
        );
        for (const r of rows) {
          if (arm({ kind: "review", agentId: r.agent_id, conversationId: r.conversation_id })) armed++;
        }
        // Flags a restart left: a day's worth is acted on after the quiet; older ones are no longer worth a call.
        const dropped = await db.query<{ tries: boolean }>(`delete from memory_flags where created_at < now() - interval '${RESUME_WINDOW}' or tries >= 2 returning (tries >= 2) as tries`);
        countDroppedFlags(db, dropped.rows);
        const flags = await db.query<{ agent_id: string; conversation_id: string }>(
          `select distinct f.agent_id, f.conversation_id from memory_flags f
             join conversations fc on fc.id = f.conversation_id and not ${socialPlaceSql("fc")}
             join agents a on a.principal_id = f.agent_id and a.memory and not a.paused and a.deleted_at is null`,
        );
        for (const r of flags.rows) {
          if (armFlags({ kind: "flags", agentId: r.agent_id, conversationId: r.conversation_id })) armed++;
        }
        // Catch-ups a restart left unfinished (or whose job never ran) go on where they stopped.
        armed += await queueCatchUps();
      });
      return armed;
    },
    close() {
      closed = true;
      for (const timer of timers.values()) timer.clear();
      timers.clear();
      for (const pair of flagTimers.values()) for (const timer of pair) timer.clear();
      flagTimers.clear();
      sweepTimer?.clear();
      sweepTimer = null;
      for (const timer of retries.values()) timer.clear();
      retries.clear();
      hearsayCalls.clear();
      attempted.clear();
      for (const job of waiting) if (job.kind === "convert") job.settle(null);
      waiting = [];
      stop.abort();
      settleIdle();
    },
    idle() {
      return looking === 0 && running.size === 0 && waiting.length === 0 ? Promise.resolve() : new Promise((done) => idlers.push(done));
    },
  };
  return api;
}
