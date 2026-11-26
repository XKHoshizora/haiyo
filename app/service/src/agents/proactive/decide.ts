import type { FastifyBaseLogger } from "fastify";
import { siteDay } from "../../accounts/store.ts";
import type { Config } from "../../config.ts";
import { lockConversation } from "../../conversations/store.ts";
import { appendSystem } from "../../conversations/system.ts";
import type { Db, Queryable, Tx } from "../../db.ts";
import { AppError } from "../../errors.ts";
import { JudgeError, type Answer, type Judge } from "../../judge/client.ts";
import type { StoredMessage } from "../../messages/model.ts";
import { count } from "../../memory/stats.ts";
import { othersAdmissible, othersReached } from "../../metering/others.ts";
import { noneTriggered, overLaneLimit, queueRun, toldSince, type RunLimits, type Triggered } from "../runs.ts";
import { lockAgent, type AgentRow } from "../store.ts";
import { judgeable, judgedAgentIds, mayAnswerUnasked, NOBODY, optionsFor, PICK, quietKey, requestFor, type Flaggable, type JudgeRequest, type Option } from "./candidates.ts";
import { listenersFor, writeFlags, type MemoryFlag } from "./listeners.ts";
import { decidedAlready, lockStates, othersSinceSurcharge, saveState, stampJudged } from "./state.ts";
import { afterProactive, afterQuiet, thresholdNow, type GroupState } from "./threshold.ts";

/**
 * Whether one Agent replies unasked to a person's message in a group (batch 2D, design rules 3–15), in three phases:
 * 1. read, without locks: the message is still one to judge and has led to no proactive reply yet, the Agents that may
 *    answer it, the site's judgements today
 *    under its daily limit (`judge_usage`), the transcript and questions (candidates.ts);
 * 2. ask the judgement model once, outside any transaction (bounded by its time limit), then count the call and stamp the
 *    options as judged, each in a statement of its own;
 * 3. unless nothing can come of the answers (the winner under the lowest threshold there is, no quiet answer raising
 *    anyone: nothing is locked), in one transaction holding the group's row (as a send does): if anything was written in
 *    the group since — a message of anyone's, a halt — nothing is done; else each Agent this touches is locked
 *    (`lockAgent`, id order) and read again, then its `agent_group_state` row (id order: state.ts), the quiet answers
 *    are applied (`afterQuiet`; a sure one tells the group once an hour, `agent_quieted`), and the winner — the Agent
 *    option with the highest pick probability, ties to the lowest id — replies when the message has led to no proactive
 *    reply yet, its probability reaches its threshold (`thresholdNow`), the new messages did not ask it to be quiet (the hush
 *    rule) and it can speak now (no reply of it there under way and no call waiting for one: nothing passes the head); when it
 *    cannot, nobody does (there is no second choice). Its reply is queued in lane `proactive`, called for by nobody, and stays so
 *    (a call meanwhile waits behind it, and it ends quietly as it begins when one does; a halt ends it, runs.ts), and its
 *    surcharge rises at once (`afterProactive`).
 * The same request also carries the listener questions of the Agents with memory on (listeners.ts, the memory plan's
 * Task 8): per owner whether someone else just said something lasting about them (`hearsay`), and whether they did
 * (`own`). The answers raise rows of `memory_flags`, written right after the answer (a failed write drops the flags only,
 * never the pick) and returned as `flags` when any were new. A judgement with no proactive Agent, only listeners, asks no
 * pick and can trigger nothing; it is skipped once the day's judgements have reached `memory.listenShare` of the limit,
 * so that listening never uses up what unasked replies need. The transcript starts after the latest join among the
 * options (among the listeners when there are none): a listener never narrows what the options are shown, and what it
 * is asked about and flagged is only what came after its own join.
 * Every failure of the judgement — none configured, over the daily limit, an error, no answer in time, an answer missing
 * any option asked — means nobody replies. What it decides is returned, to act on after commit as a send does
 * (`actOnTriggered`, the notices published). Nothing of it reaches a wire shape; the log carries ids and reasons only.
 */

export interface DecideDeps {
  db: Db;
  judge: Judge | null;
  config: RunLimits & Pick<Config, "judge" | "proactive" | "memory" | "siteModels" | "reasoningAllowanceTokens">;
  log: Pick<FastifyBaseLogger, "info" | "debug">;
  /** Called as the judgement model is asked, once (the scheduler counts its hourly caps by it); not when it is not. */
  onAsk?: () => void;
}

/** Why the winner did not reply (`proactive_skipped`). */
type Skipped = "already_decided" | "hushed" | "under_threshold" | "active_run" | "fuse" | "budget" | "owner_minute";

/** How often a group is told at most that an Agent keeps quiet (`agent_quieted`): once an hour. */
const QUIETED_NOTICE_EVERY_MS = 3_600_000;

/** The site day the daily limit was last logged on: once per process and day. */
let limitLoggedOn: string | null = null;

/**
 * What a decision comes to: what `Triggered` says, and — only when the judgement raised any — the memory flags it wrote
 * (listeners.ts, Task 8), for the caller to tell the reviewer of.
 */
export type Decided = Triggered & { flags?: MemoryFlag[] };

export async function decideProactive(deps: DecideDeps, conversationId: string, seq: number): Promise<Decided> {
  const { db, judge, config, log } = deps;
  if (judge === null || config.judge === null) return noneTriggered();

  const message = await judgeable(db, conversationId, seq);
  if (message === null || (await decidedAlready(db, conversationId, seq))) return noneTriggered();
  const options = await affordable(db, await optionsFor(db, conversationId, seq, message.senderId, config), config, new Date());
  const listeners = await listenersFor(db, conversationId, seq);
  if (options.length === 0 && listeners.length === 0) return noneTriggered();
  const day = siteDay(new Date(), config.siteTimezone);
  if (options.length === 0 ? !(await mayListen(db, day, config, log)) : await atDailyLimit(db, day, config.judge.dailyLimit, log)) return noneTriggered();
  const request = await requestFor(db, conversationId, seq, options, config.proactive, listeners);
  if (request === null) return noneTriggered();
  const { questions, flaggable } = request;

  const answers = await askJudgement(deps, request, conversationId, day);
  // Whatever came of it, each option judged now — up to this message when it was answered.
  await stampJudged(db, conversationId, judgedAgentIds(options, listeners), answers === null ? null : seq);
  if (answers === null) return noneTriggered();

  const P = config.proactive;
  const asked = new Set(questions.map((q) => q.key));
  // A flag that cannot be written costs the flag only: the pick that was answered is still acted on.
  const flags = await writeFlags(db, flagged(flaggable, answers, config.memory, conversationId)).catch((err: unknown) => {
    log.info({ metric: "memory_flags_failed", conversationId, reason: err instanceof Error ? err.name : "error" }, "the memory flags could not be written: none are");
    return [];
  });
  count(db, "flag_hearsay", flags.filter((x) => x.kind === "hearsay").length);
  count(db, "flag_own", flags.filter((x) => x.kind === "own").length);
  const done = <T extends Triggered>(t: T): T & Pick<Decided, "flags"> => (flags.length === 0 ? t : { ...t, flags });
  // Nobody can reply when no Agent was offered: the listeners' questions only flag.
  if (options.length === 0) return done(noneTriggered());
  const { winner, quiet, partial } = answered(options, answers, asked);
  if (partial) log.info({ metric: "judge_partial", conversationId }, "the judgement model's pick was missing, partial or did not add up: no Agent replies unasked");
  // No threshold is below the lowest base (or the cap): a winner under that cannot reply, whatever its state, and when
  // no quiet answer raises anyone either, the group's row and the Agents' are not locked at all (the usual case).
  const contender = winner !== null && winner.p >= Math.min(P.cap, P.base.less, P.base.normal, P.base.more) ? winner : null;
  if (winner !== null && contender === null) logSkipped(log, "under_threshold", winner.option.agentId, conversationId);
  if (contender === null && !options.some((o) => (quiet.get(o.agentId) ?? 0) >= P.quietSmall.at)) return done(noneTriggered());
  return done(await db.tx((t) => settle(t, { conversationId, seq, options, config, log, winner: contender, quiet })));
}

/**
 * Whether a judgement that only listens (no Agent to pick: the listener questions alone, or a catch-up, memory/catchup.ts) may be
 * asked on site day `day`: under the day's limit, and — so that listening never uses up what unasked replies need — under
 * `listenShare` of it (past it: counted `judge_memory_skipped_share`).
 */
export async function mayListen(db: Queryable, day: string, config: Pick<DecideDeps["config"], "judge" | "memory">, log: DecideDeps["log"]): Promise<boolean> {
  if (config.judge === null || (await atDailyLimit(db, day, config.judge.dailyLimit, log))) return false;
  if ((await judgementsOn(db, day)) >= config.memory.listenShare * config.judge.dailyLimit) {
    count(db, "judge_memory_skipped_share");
    return false;
  }
  return true;
}

/**
 * Asks the judgement model `request` once, each channel for at most `timeoutMs` and nothing longer than all of them together, and
 * counts one more of the site's judgements of `day` whatever came of it. The answers, or null when there were none (logged, why
 * coarsely: `judge_failed`).
 */
export async function askJudgement(deps: Pick<DecideDeps, "db" | "judge" | "config" | "log" | "onAsk">, request: JudgeRequest, conversationId: string, day: string): Promise<Map<string, Answer> | null> {
  const { db, judge, config, log } = deps;
  if (judge === null || config.judge === null) return null;
  let answers: Map<string, Answer> | null = null;
  const deadline = AbortSignal.timeout(config.judge.timeoutMs * Math.max(1, config.judge.channels.length));
  deps.onAsk?.();
  try {
    answers = await judge.ask(request.state, request.questions, deadline);
  } catch (err) {
    // Why, coarsely (`JudgeError.reason`; out of all the channels' time together: `timeout`).
    const reason = err instanceof JudgeError ? err.reason : deadline.aborted ? "timeout" : "network";
    log.info({ metric: "judge_failed", reason, conversationId }, "the judgement model gave no answer: nothing comes of this judgement");
  }
  await countJudgement(db, day);
  return answers;
}

/**
 * The flags the answers raise: a hearsay question answered at `hearsayAt` or more flags each message it was asked of for
 * every Agent of that owner that listens; an own question at `ownAt` or more, for the owner's reviewing Agent alone. A
 * question left unanswered, or answered with a choice, raises nothing. Of these, `writeFlags` writes only what each Agent may
 * hear (above its `heard_from_seq`).
 */
export function flagged(flaggable: readonly Flaggable[], answers: ReadonlyMap<string, Answer>, M: Pick<Config["memory"], "hearsayAt" | "ownAt">, conversationId: string): MemoryFlag[] {
  const out: MemoryFlag[] = [];
  for (const f of flaggable) {
    const a = answers.get(f.key);
    if (a?.type !== "noul" || a.p < (f.kind === "hearsay" ? M.hearsayAt : M.ownAt)) continue;
    const agents = f.kind === "hearsay" ? f.listener.agentIds : f.listener.reviewerId === null ? [] : [f.listener.reviewerId];
    for (const agentId of agents) for (const seq of f.seqs) out.push({ agentId, conversationId, seq, kind: f.kind });
  }
  return out;
}

/**
 * One line for a winner that does not reply: at debug when its threshold stopped it (the usual case) or the message was
 * decided already, else at info.
 */
function logSkipped(log: DecideDeps["log"], reason: Skipped, agentId: string, conversationId: string): void {
  const line = { metric: "proactive_skipped", reason, agentId, conversationId };
  if (reason === "under_threshold" || reason === "already_decided") log.debug(line, "the winner does not reply: the usual case");
  else log.info(line, "the Agent the judgement picked cannot speak now: no Agent replies unasked");
}

/** Whether the site's judgements of site day `day` have reached `limit`; logged once a day when they have. */
export async function atDailyLimit(q: Queryable, day: string, limit: number, log: DecideDeps["log"]): Promise<boolean> {
  if ((await judgementsOn(q, day)) < limit) return false;
  if (limitLoggedOn !== day) {
    limitLoggedOn = day;
    log.info({ metric: "judge_daily_limit" }, "the site's judgements of the day are used up: no Agent replies unasked until the next site day");
  }
  return true;
}

/** The site's judgements of site day `day` so far (`judge_usage`). */
export async function judgementsOn(q: Queryable, day: string): Promise<number> {
  const { rows } = await q.query<{ calls: number }>("select calls from judge_usage where day = $1::date", [day]);
  return rows[0]?.calls ?? 0;
}

/** One more of the site's judgements of site day `day` (`judge_usage`), whatever came of it. */
export async function countJudgement(db: Db, day: string): Promise<void> {
  await db.query("insert into judge_usage (day, calls) values ($1::date, 1) on conflict (day) do update set calls = judge_usage.calls + 1", [day]);
}

/**
 * What the probabilities of a pick over the options asked add up to, at least and at most, to count: a choice's sum to 1,
 * and an answer far from that is no answer.
 */
const PICK_SUM = { min: 0.9, max: 1.1 } as const;

/** What the judgement said that counts: the winner of the pick, if any, and each quiet answer by Agent. */
interface Answered {
  winner: { option: Option; p: number } | null;
  quiet: Map<string, number>;
}

/**
 * The answers to what was `asked`, nothing else. The winner: the Agent option with the highest pick probability (ties:
 * the lowest id — options are in id order); none unless every option asked, `nobody` too, has a probability — a maximum
 * over part of them is no answer — and they sum to about 1 (`PICK_SUM`) (`partial`: the pick missing, part of it, or
 * not a choice's probabilities).
 */
function answered(options: readonly Option[], answers: ReadonlyMap<string, Answer>, asked: ReadonlySet<string>): Answered & { partial: boolean } {
  const quiet = new Map<string, number>();
  for (const o of options) {
    const a = asked.has(quietKey(o)) ? answers.get(quietKey(o)) : undefined;
    if (a?.type === "noul") quiet.set(o.agentId, a.p);
  }
  const pick = answers.get(PICK);
  if (pick?.type !== "choice") return { winner: null, quiet, partial: true };
  const p = pick.probabilities;
  if (!p.has(NOBODY) || options.some((o) => !p.has(o.key))) return { winner: null, quiet, partial: true };
  const sum = options.reduce((total, o) => total + p.get(o.key)!, p.get(NOBODY)!);
  if (!(sum >= PICK_SUM.min && sum <= PICK_SUM.max)) return { winner: null, quiet, partial: true };
  let winner: Answered["winner"] = null;
  for (const option of options) {
    const probability = p.get(option.key)!;
    if (winner === null || probability > winner.p) winner = { option, p: probability };
  }
  return { winner, quiet, partial: false };
}

interface Judged extends Answered {
  conversationId: string;
  seq: number;
  options: readonly Option[];
  config: DecideDeps["config"];
  log: DecideDeps["log"];
}

/** Phase 3 (see the top): under the group's row, apply what the judgement said, if the group is as it was. */
async function settle(t: Tx, j: Judged): Promise<Triggered> {
  const { conversationId, seq, config, log } = j;
  const P = config.proactive;
  if (!(await lockConversation(t, conversationId))) return noneTriggered();
  const still = await judgeable(t, conversationId, seq);
  if (still === null) return noneTriggered();
  const now = new Date();

  // Touched: the Agents a quiet answer raises (`afterQuiet` does from `quietSmall.at` on), and the winner.
  const raised = j.options.filter((o) => (j.quiet.get(o.agentId) ?? 0) >= P.quietSmall.at).map((o) => o.agentId);
  const touched = [...new Set([...raised, ...(j.winner ? [j.winner.option.agentId] : [])])].sort();
  const agents = await lockOptions(t, conversationId, seq, touched, still.senderId);
  const states = await lockStates(t, conversationId, [...agents.keys()]);

  const notices: StoredMessage[] = [];
  for (const id of agents.keys()) {
    const q = j.quiet.get(id);
    const stored = states.get(id)!;
    const raise = q === undefined ? null : afterQuiet(stored.state, q, now, P);
    if (raise === null) continue;
    stored.state = raise.state;
    await saveState(t, id, conversationId, stored);
    if (raise.big && !(await toldSince(t, conversationId, new Date(now.getTime() - QUIETED_NOTICE_EVERY_MS), "agent_quieted", id))) {
      notices.push(await appendSystem(t, conversationId, { event: "agent_quieted", actorId: id, agentId: id }));
    }
  }
  const told: Triggered = { ...noneTriggered(), notices };

  const agent = j.winner ? agents.get(j.winner.option.agentId) : undefined;
  if (!j.winner || !agent) return told;
  const stored = states.get(agent.id)!;
  // Others' messages since its surcharge was stamped: what its threshold now, and its surcharge stamped again, decay by.
  stored.state = { ...stored.state, othersSince: await othersSinceSurcharge(t, conversationId, agent.id, stored, seq, P.surchargeHalfMessages) };
  const skipped = await whyNot(t, agent, conversationId, seq, j.winner.p, j.quiet.get(agent.id), stored.state, now, config);
  if (skipped !== null) {
    logSkipped(log, skipped, agent.id, conversationId);
    return told;
  }
  // Nobody called it, but it answers the message's sender (Task 10b): what it is shown starts no earlier than their joining.
  const run = await queueRun(t, agent, conversationId, seq, "human", { id: null, lane: "proactive" }, [still.senderId]);
  await saveState(t, agent.id, conversationId, { state: afterProactive(stored.state, now, P), surchargeSeq: seq });
  return { ...told, runs: [run] };
}

/**
 * Each of `ids` (in id order) locked (`lockAgent`; the caller holds the group's row), kept while it may still answer the
 * message at `seq` from `senderId` unasked (`mayAnswerUnasked`, read now that it is locked). One no longer found at all
 * (`lockAgent`'s 404, a query that failed nothing) is gone: no option.
 */
async function lockOptions(t: Tx, conversationId: string, seq: number, ids: readonly string[], senderId: string): Promise<Map<string, AgentRow>> {
  if (ids.length === 0) return new Map();
  const locked: AgentRow[] = [];
  for (const id of ids) {
    try {
      locked.push(await lockAgent(t, id, conversationId));
    } catch (err) {
      if (!(err instanceof AppError && err.status === 404)) throw err;
    }
  }
  const { rows } = await t.query<{ id: string }>(
    `select p.id from memberships m join principals p on p.id = m.principal_id join agents a on a.principal_id = p.id
      where m.conversation_id = $1 and p.id = any($2::uuid[]) and ${mayAnswerUnasked("$4", "$3::uuid")}`,
    [conversationId, ids, senderId, seq],
  );
  const options = new Set(rows.map((r) => r.id));
  return new Map(locked.filter((a) => options.has(a.id)).map((a) => [a.id, a]));
}

/**
 * `options` less the Agents whose proactive replies could not be admitted now, before the judgement is asked: those whose owner's one
 * number for others' use is reached today (metering/others.ts `othersReached`, the measure admission decides by), read without a lock,
 * so that decide opens no transaction before the judge. A candidate that fails spends no judgement and leaves no run. It is asked again
 * under the locks where the pick is acted on (`whyNot`, `othersAdmissible`), which only refuses.
 */
async function affordable(db: Db, options: Option[], config: DecideDeps["config"], now: Date): Promise<Option[]> {
  const kept: Option[] = [];
  for (const option of options) {
    const owner = await db.query<{ owner_id: string }>("select owner_id from principals where id = $1", [option.agentId]);
    // One that cannot be read now is left to the locked check where the pick is acted on.
    if (!owner.rows[0] || !(await othersReached(db, config, owner.rows[0].owner_id, now))) kept.push(option);
  }
  return kept;
}

/**
 * Why the winner `agent` (pick probability `p`, quiet probability `quiet` for the new messages, its threshold's `state` with
 * the others' messages since its surcharge) does not reply, or null when it does: the message at `seq` already led to a
 * proactive reply here — of any Agent: a surcharge was stamped after it (`already_decided`; at most one reply per
 * message, however often it is decided; the stamp stays when a call takes the reply over); this message asked it to be
 * quiet, if only a little (`hushed`: the judgement tends to pick the very Agent a mild complaint is about); `p` is under
 * its threshold now (`under_threshold`); a reply of it is queued or running in the group (`active_run`: a proactive reply
 * is never folded into one); the fuse — a proactive reply of it in the group within `fuse.perSeconds`, or `fuse.perHour`
 * of them within the hour (`fuse`); its owner has started the others' replies a minute (`owner_minute`, the others' lane's own
 * check, which locks the owner's `accounts` row: the lock order's last step); its owner's one number for others' use is reached
 * (`budget`: `othersAdmissible` under that lock; only a refusal the unlocked check before the judgement (`affordable`) did not
 * make: something changed since).
 */
async function whyNot(
  t: Tx,
  agent: AgentRow,
  conversationId: string,
  seq: number,
  p: number,
  quiet: number | undefined,
  state: GroupState,
  now: Date,
  config: DecideDeps["config"],
): Promise<Skipped | null> {
  const P = config.proactive;
  // Read again here, where it is certain: every writer of `surcharge_seq` holds the group's row, as this does.
  if (await decidedAlready(t, conversationId, seq)) return "already_decided";
  if (quiet !== undefined && quiet >= P.quietSmall.at) return "hushed";
  if (p < thresholdNow(agent.proactiveLevel, state, now, P)) return "under_threshold";
  // A reply under way, or calls waiting for one (`deferred_calls`): nothing passes the head (limits redesign, Part 2).
  const active = await t.query(
    `select 1 from agent_runs where agent_id = $1 and conversation_id = $2 and status in ('queued', 'running')
     union all select 1 from deferred_calls where agent_id = $1 and conversation_id = $2 limit 1`,
    [agent.id, conversationId],
  );
  if (active.rowCount) return "active_run";

  const fuse = await t.query<{ recent: number; hour: number }>(
    `select count(*) filter (where created_at > now() - make_interval(secs => $3))::int as recent, count(*)::int as hour
       from agent_runs
      where agent_id = $1 and conversation_id = $2 and purpose = 'reply' and lane = 'proactive' and created_at > now() - interval '1 hour'`,
    [agent.id, conversationId, P.fuse.perSeconds],
  );
  if (fuse.rows[0]!.recent > 0 || fuse.rows[0]!.hour >= P.fuse.perHour) return "fuse";
  if (await overLaneLimit(t, agent.ownerId, "proactive", config)) return "owner_minute";
  // Its owner's number, asked as admission asks it: under the owner's account lock, after the one above (the lock order's last step).
  if (!(await othersAdmissible(t, config, agent.ownerId, now))) return "budget";
  return null;
}
