import type { Config } from "../../config.ts";
import { AppError } from "../../errors.ts";
import { weight } from "../../metering/tokens.ts";
import { allowanceRefuses, callsAtCap, memoryCall, type MemoryCallDeps, type MemoryCallReport } from "../../memory/call.ts";
import { shown } from "../../memory/review.ts";
import { count } from "../../memory/stats.ts";
import { labelledEntry, toAttachment } from "../context.ts";
import { attachmentLabel, entryText, minimalTokens } from "../runtime/context.ts";
import { drawMark, speakerRole } from "../runtime/prompt.ts";
import { liveAgent, lockAgent } from "../store.ts";
import { withoutCitations } from "../tools/refs.ts";
import { atLongest, callPerson, capped, hasItems, mapItems, noItems, parseSummary, shownForm, summaryInput, summarySystem, whoIn, type Sections } from "./prompt.ts";
import {
  peopleNow,
  readAttempt,
  readPlaced,
  readSummary,
  settleAttempt,
  summaryBase,
  writeAttempt,
  writeSummary,
  type AttemptState,
  type PlacedMessage,
  type PlacedReader,
  type Summary,
} from "./store.ts";

/**
 * One rolling-summary job (README "The rolling summary"; queued after a reply by agents/port-impl.ts `finish`, run by the
 * memory reviewer's scheduler, memory/reviewer.ts, one job per Agent at a time within its cap): the messages of the pair
 * that a reply's context left out are folded, by ONE memory call (memory/call.ts `memoryCall`: its own `agent_runs` row of
 * purpose `memory`, held and settled on the memory allowance the site pays — or, on a model of the owner's own provider,
 * nothing), into the pair's summary, updated in place. Who said what is never text: the call names each speaker by a key
 * of the roster it is given (keys only for the senders of its messages and the speakers of the old summary it is given
 * back), and what is stored is the account each key stands for (prompt.ts), held to the cap as a reply would be shown it.
 *
 * When to call, and what after a call that wrote nothing, is the pair's attempt state, kept in the database (migration 059,
 * store.ts `AttemptState`): when it may be asked again (`not_before`), its failures in a row and how far the window that
 * failed reaches, the most messages its next window takes. One function decides whether to call (`shouldCall`), one what
 * a call that wrote nothing leaves (`afterFailure`), one what a write leaves (`afterWrite`); the window is claimed under the
 * pair's lock before the call is made: neither another process nor this one after a restart pays for it again meanwhile.
 * Nothing in process memory decides. Every window gets through or is set aside by rule: a failure that keeps coming back
 * halves the window down to `SUMMARY_MIN_WINDOW` messages, and one of those that fails three more times is set aside.
 *
 * Fail closed: a call that could not be made, failed, was abandoned, or answered nothing in the asked shape changes no
 * summary, nor does one that arrives once the pair has moved on (a new topic, the Agent out of the group or added back,
 * another write). An answer of the four lists, all empty, is no failure: nothing in the window was worth keeping, and what
 * the summary covers moves past it, its items as they were (for a long window, only when it says so twice in a row). Nothing
 * of any text is logged: counters only (memory/stats.ts).
 */

export interface SummaryJob {
  kind: "summary";
  agentId: string;
  conversationId: string;
  /** The last place (agents/summary/store.ts) the reply's context left out: what is to be covered up to. */
  upTo: number;
}

export interface SummaryContext {
  /** The service is stopping: a call under way is abandoned and nothing is written (its claim lapses by itself). */
  closing: AbortSignal;
}

/** A memory call's dependencies, and the clock the job decides by (the wall clock unless given). */
export type SummaryDeps = MemoryCallDeps & { now?: () => number };

/** The most messages one job reads; the rest waits for the next job. */
export const SUMMARY_MAX_MESSAGES = 200;
/** The fewest messages a halved window takes (`nextWindow`). */
export const SUMMARY_MIN_WINDOW = 10;

/** The wait after the `failures`-th call in a row that wrote nothing: five minutes, doubling each time, at most a day. */
export const backoffMs = (failures: number): number => Math.min(5 * 60_000 * 2 ** Math.max(0, failures - 1), 24 * 60 * 60_000);

/** The most messages the window after one of `tried` messages that could not be summarised whole takes: half, at least `SUMMARY_MIN_WINDOW`. */
export const nextWindow = (tried: number): number => Math.max(SUMMARY_MIN_WINDOW, Math.floor(tried / 2));

/** How long a claim holds its window: the call's own deadline and a minute. A process that dies mid-call gives it back then. */
const claimMs = (config: Pick<Config, "agentRunTimeoutMs">): number => config.agentRunTimeoutMs + 60_000;

/** Whether the pair's attempt state lets it be asked at `now` (none: yes). */
export const due = (state: AttemptState | null, now: number): boolean => state === null || state.notBefore === null || now >= state.notBefore;

/**
 * THE decision: whether the job calls now — the pair is due (`due`: `now` is at or past its `not_before`), and the window is
 * worth a call: what it folds in weighs, as a reply would show it, at least `minFoldWeight`, or it is full (cut at its size,
 * so that a long run of one-word lines cannot hold back what comes after it).
 */
export const shouldCall = (state: AttemptState | null, now: number, window: { material: number; full: boolean }, minFoldWeight: number): boolean =>
  due(state, now) && (window.full || window.material >= minFoldWeight);

/** Failures in a row before each next one halves the window; failures at the floor before the window is set aside. */
export const FAILURES_BEFORE_HALVING = 3;
export const FAILURES_AT_FLOOR = 3;

/**
 * Whether `state`'s failure streak is that of the window starting at `start`: a window failed reaching up to `failedUpto`,
 * and `start` is before it — the same window, or the rest of it once a halved part of it got through. A window that starts
 * at or past it is a new one: its streak starts over (`carried`). The end of a window is no mark of it: a window that is not
 * full grows with every message posted, and what keeps failing in it is still there.
 */
const inStreak = (state: AttemptState | null, start: number): boolean => state !== null && state.failedUpto !== null && start < state.failedUpto;

/** `state` as the window starting at `start` carries it: whole in its streak; else only when it is due and what was ever set aside. */
const carried = (state: AttemptState | null, start: number): AttemptState =>
  inStreak(state, start)
    ? state!
    : { failedUpto: null, failures: 0, floorFailures: 0, emptyAnswer: false, notBefore: state?.notBefore ?? null, windowMessages: null, skippedMessages: state?.skippedMessages ?? 0 };

/**
 * Why a call wrote nothing, for the rule (`afterFailure`): the window's own — `failed` (the call failed: an outage, a
 * timeout, or the provider refusing the input once the call started, as a moderation refusal comes: they cannot be told
 * apart), `unusable` (answered, not in the asked shape, or cut at its limit), `too_big` (the input does not fit the
 * model), `empty` (a long window answered with nothing, doubted once) — or `no_model`, no fault of the window: nothing to
 * call it on (none configured, a choice not allowed, a saved key that cannot be opened, a key or an address the provider
 * or the guard refused).
 */
export type FailureKind = "failed" | "unusable" | "too_big" | "empty" | "no_model";

/**
 * THE failure rule: what the pair's state becomes after the call of the claim `lease` wrote nothing on a window of `n`
 * messages ending at `upto` (`full`: cut at its size), at `now` — and whether that window is set aside:
 * - every failure is one more in a row, and the pair waits `backoffMs` of them;
 * - the window's own: from the `FAILURES_BEFORE_HALVING`-th in a row each halves the next window (`nextWindow`, down to
 *   `SUMMARY_MIN_WINDOW`); an input too big, or an unusable answer for a full window, halves it at once; a failure made at
 *   the floor counts there too, and the `FAILURES_AT_FLOOR`-th of those sets the window aside;
 * - `no_model`: the backoff only — it never halves and never sets anything aside;
 * - the window that failed reaches as far as the furthest that did (`failedUpto`), and the streak lasts until a write
 *   passes it (`afterWrite`).
 * Pure.
 */
export function afterFailure(lease: AttemptState, failed: { kind: FailureKind; n: number; full: boolean; upto: number }, now: number): { next: AttemptState; setAside: boolean } {
  const failures = lease.failures + 1;
  const ours = failed.kind !== "no_model";
  const atFloor = lease.windowMessages !== null && lease.windowMessages <= SUMMARY_MIN_WINDOW;
  const floorFailures = ours && atFloor ? lease.floorFailures + 1 : lease.floorFailures;
  const halve = ours && (failed.kind === "too_big" || (failed.kind === "unusable" && failed.full) || failures >= FAILURES_BEFORE_HALVING);
  return {
    next: {
      failedUpto: Math.max(lease.failedUpto ?? failed.upto, failed.upto),
      failures,
      floorFailures,
      emptyAnswer: failed.kind === "empty",
      notBefore: now + backoffMs(failures),
      windowMessages: halve ? nextWindow(failed.n) : lease.windowMessages,
      skippedMessages: lease.skippedMessages,
    },
    setAside: ours && floorFailures >= FAILURES_AT_FLOOR,
  };
}

/**
 * What the pair's state becomes after a write ending at `upto` (a summary, a window folded with nothing to add, or one set
 * aside: `skipped` its messages), from the claim's `lease`, at `now`: the pair waits `intervalMs`. Inside the window that
 * failed (`failedUpto` past `upto`, and nothing set aside) the streak goes on — the rest of that window is taken at its
 * halved size, and a failure there halves again at once, so that what fails is cornered rather than met afresh —; past it,
 * or after a set-aside, it starts over: the next window is whole. Pure.
 */
export function afterWrite(lease: AttemptState, upto: number, now: number, intervalMs: number, skipped = 0): AttemptState {
  const fresh = { failedUpto: null, failures: 0, floorFailures: 0, emptyAnswer: false, windowMessages: null };
  const inside = skipped === 0 && lease.failedUpto !== null && upto < lease.failedUpto;
  return { ...(inside ? { ...lease, floorFailures: 0, emptyAnswer: false } : fresh), notBefore: now + intervalMs, skippedMessages: lease.skippedMessages + skipped };
}

/**
 * What `m` weighs as a reply would show it, by the context's own rules (agents/context.ts `labelledEntry`, runtime/context.ts
 * `entryText`, `minimalTokens`): its text and its attachment's name — in a group, one of someone else's with its label
 * (`mark`: any mark, every mark is as long). Its quote is not read here: what is measured only errs on the light side.
 */
function shownWeight(m: PlacedMessage, reader: PlacedReader, mark: string | null): number {
  const entry = { role: m.senderId === reader.agentId ? ("assistant" as const) : ("user" as const), text: entryText(withoutCitations(m.text), null), attachment: m.attachment ? toAttachment(m.attachment) : null };
  const speaker = reader.group && m.senderId !== reader.agentId ? { name: m.name, handle: m.handle, role: speakerRole(m.senderId, m.kind, reader.ownerId), quoted: false } : null;
  return minimalTokens(labelledEntry(entry, speaker, mark));
}

/** A message's text as the call is shown it: its attachment's label and its text, cleaned and cut at `maxWeight`. */
function lineText(m: PlacedMessage, maxWeight: number): string {
  const label = m.attachment ? attachmentLabel({ name: m.attachment.name, image: m.attachment.inline === true }) : "";
  // No number a reply's tools gave (`〔m3〕`) means anything to this call or to the summary it writes (tools/refs.ts `withoutCitations`).
  return shown([label, withoutCitations(m.text)].filter((s) => s !== "").join(" "), maxWeight);
}

/**
 * Why a call wrote nothing: `unchanged` — it could not start for a reason that clears by itself (the memory allowance
 * spent, the owner's calls running at once): nothing changes, the next job looks again; else a `FailureKind` for the rule.
 * A started call that failed for its key or its address (`provider_rejected`, `address_not_allowed`) is `no_model`.
 */
function outcomeOf(report: MemoryCallReport, answer: string | null): "unchanged" | FailureKind {
  if (report.refused === true || report.capped === true) return "unchanged";
  if (report.unstartable !== undefined) return report.unstartable;
  if (report.failure === "provider_rejected" || report.failure === "address_not_allowed") return "no_model";
  return report.answered || answer !== null ? "unusable" : "failed";
}

/**
 * The job: what to read, whether to call, the call, what to keep. The window is the pair's messages placed after what its
 * summary covers (or, with none, after where the Agent may be shown the conversation from: `summaryBase`) and up to
 * `job.upTo`, at most `SUMMARY_MAX_MESSAGES` of them — or the fewer its streak allows — and at most what a review is shown
 * in weight (`reviewMessages` × `reviewMessageWeight`, each cut at `reviewMessageWeight`), cut between places, so that an
 * exchange is never split; the rest waits for the next job. A summary written before migration 059 (text only) is none to
 * build on: the window starts where a first summary's would.
 *
 * Before the window is read, the pair's state (one row: not due, nothing else is read, however many replies come
 * meanwhile). Then the window is weighed and `shouldCall` decides; then whether a call could start now (the memory
 * allowance, counted when spent; the owner's calls running at once: either refusing changes nothing); then the claim.
 * After the call: a summary written (or the window folded with nothing to add) — `afterWrite`; a call that wrote nothing —
 * `afterFailure`, and a window it sets aside is written as passed, its messages in no summary, counted.
 */
export async function runSummary(deps: SummaryDeps, job: SummaryJob, ctx: SummaryContext): Promise<void> {
  const { db, config, log } = deps;
  const now = (): number => (deps.now ?? Date.now)();
  if (ctx.closing.aborted) return;
  const agent = await liveAgent(db, job.agentId);
  if (!agent) return;
  const reader: PlacedReader = { agentId: agent.id, ownerId: agent.ownerId, conversationId: job.conversationId, group: job.conversationId !== agent.conversationId };

  const base = await summaryBase(db, agent.id, job.conversationId);
  if (base === null) return;
  const stored = await readSummary(db, job.conversationId, agent.id);
  // A summary from before where the Agent may be shown the conversation from now (a new topic, a new stay) is no summary;
  // nor, to build on, is one of text only (written before migration 059: its speakers were text).
  const old = stored !== null && stored.fromSeq > base && stored.items !== null ? { fromSeq: stored.fromSeq, uptoSeq: stored.uptoSeq, items: stored.items } : null;
  const start = old?.uptoSeq ?? base;
  if (job.upTo <= start) return;

  const { memory } = config;
  // Not due: one row read, nothing else.
  const state = await readAttempt(db, job.conversationId, agent.id);
  if (!due(state, now())) return;

  const limit = Math.min(SUMMARY_MAX_MESSAGES, carried(state, start).windowMessages ?? SUMMARY_MAX_MESSAGES);
  // What the call is shown, read in ONE snapshot (round 2, N-5): the messages, and who everyone they and the old summary
  // name is now — so that a rename while the call runs changes nothing it was shown (and what is stored is by account).
  const { read, people } = await db.tx(async (t) => {
    await t.query("set transaction isolation level repeatable read, read only");
    const read = await readPlaced(t, reader, start, job.upTo, limit + 1);
    return { read, people: await peopleNow(t, reader, [...new Set([...(old === null ? [] : whoIn(old.items)), ...read.map((m) => m.senderId)])]) };
  });
  const texts = read.map((m) => lineText(m, memory.reviewMessageWeight));
  let n = Math.min(read.length, limit);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const w = weight(texts[i]!);
    if (i > 0 && total + w > memory.reviewMessages * memory.reviewMessageWeight) {
      n = i;
      break;
    }
    total += w;
  }
  const full = n < read.length;
  // Cut between places: when the first message left for later shares its place with the last one taken, that place waits whole.
  if (full && n > 0 && read[n]!.at === read[n - 1]!.at) {
    const at = read[n - 1]!.at;
    while (n > 0 && read[n - 1]!.at === at) n--;
  }
  if (n === 0) return;
  const upto = full ? read[n - 1]!.at : job.upTo;
  // What is folded in: the messages with something left once cleaned, each weighed as a reply would show it.
  const mark = reader.group ? drawMark() : null;
  const taken = read.slice(0, n).flatMap((m, i) => (texts[i] === "" ? [] : [{ sender: m.senderId, text: texts[i]!, weight: shownWeight(m, reader, mark) }]));
  const material = taken.reduce((sum, l) => sum + l.weight, 0);
  if (taken.length === 0 || !shouldCall(state, now(), { material, full }, memory.summaryMinFoldWeight)) return;
  // A call worth making that could not start now, for a reason that clears by itself: nothing changes; the next reply's
  // job looks again.
  if (await allowanceRefuses(db, config, agent.ownerId, new Date(now()))) {
    count(db, "memory_refused_allowance");
    return;
  }
  if (await callsAtCap(db, config, agent.ownerId)) return;

  // The claim, under the pair's lock (the conversation's row, then the Agent's: the order a reply takes them in): the state
  // read again and, still due and as the window was read under, the window claimed until the call's deadline and a minute.
  let claim: { lease: AttemptState; before: AttemptState | null } | null;
  try {
    claim = await db.tx(async (t) => {
      const locked = await lockAgent(t, agent.id, job.conversationId);
      if (locked.deleted || (await summaryBase(t, agent.id, job.conversationId)) !== base) return null;
      if (!sameSummary(await readSummary(t, job.conversationId, agent.id), stored)) return null;
      const before = await readAttempt(t, job.conversationId, agent.id);
      if (!due(before, now()) || carried(before, start).windowMessages !== carried(state, start).windowMessages) return null;
      const lease: AttemptState = { ...carried(before, start), notBefore: now() + claimMs(config) };
      await writeAttempt(t, job.conversationId, agent.id, lease);
      return { lease, before };
    });
  } catch (err) {
    if (err instanceof AppError && err.status === 404) return;
    throw err;
  }
  if (claim === null) return;
  const lease = claim.lease;
  const next: Omit<Summary, "items"> = { fromSeq: old?.fromSeq ?? read[0]!.at, uptoSeq: upto };

  // The call's roster: a key for everyone it is shown — the old summary's speakers first, then the senders of its
  // messages, and nobody else —, for this call only.
  const accounts = [...new Set([...(old === null ? [] : whoIn(old.items)), ...taken.map((l) => l.sender)])];
  const keyOf = new Map(accounts.map((id, i) => [id, `p${i + 1}`]));
  const accountOf = new Map(accounts.map((id, i) => [`p${i + 1}`, id]));
  // The old summary as it is built on: under the keys, without citations (as a reply is shown it, store.ts `shownSummary`);
  // one with no item (a window folded with nothing to add) is none.
  const before = old === null || !hasItems(old.items) ? null : mapItems(old.items, (id) => keyOf.get(id)!, withoutCitations);
  const itemMax = Math.min(memory.modelEntryMax, memory.summaryMaxWeight);
  // What is stored is held to the cap as a reply would be shown it with the names of now and every account at its
  // longest (prompt.ts `atLongest`, `capped`): a rename since can then only cost names, which a reply's passage shortens
  // before it drops any item (prompt.ts `fitted`).
  const longest = new Map([...people].map(([id, p]) => [id, atLongest(p)]));
  const asStored = (s: Sections): Sections => capped(s, memory.summaryMaxWeight, (x) => JSON.stringify(shownForm(x, longest)));

  count(db, "summary_run");
  const report: MemoryCallReport = { answered: false };
  const answer = await memoryCall(
    deps,
    agent.ownerId,
    {
      system: summarySystem(reader.group, memory.summaryMaxWeight, itemMax),
      user: summaryInput(
        Object.fromEntries(accounts.map((id) => [keyOf.get(id)!, callPerson(people.get(id)!)])),
        before,
        taken.map((l) => ({ said_by: keyOf.get(l.sender)!, text: l.text })),
      ),
      // The answer names speakers by short keys: it is no bigger than the passage it becomes, which is held to the cap;
      // twice the cap leaves room for an answer that overshoots (it is then cut).
      maxOutputTokens: Math.max(memory.reviewMaxOutputTokens, 2 * memory.summaryMaxWeight),
    },
    ctx.closing,
    report,
  );
  // The service is stopping: nothing is written; the claim lapses by itself.
  if (ctx.closing.aborted) return;
  // Held to its shape (prompt.ts `parseSummary`): an item whose `said_by` is absent or no key it was given goes, counted;
  // each key back to the account it stands for; then held to the cap. Valid and within the cap is all it has to be.
  const parsed = answer === null ? null : parseSummary(answer, new Set(accountOf.keys()), itemMax);
  count(db, "summary_who_unknown", parsed?.unknown ?? 0);
  const answered = parsed?.sections ? asStored(mapItems(parsed.sections, (key) => accountOf.get(key)!)) : null;
  // The four lists, all empty: nothing worth keeping — the summary's items stay as they are, and what it covers moves on.
  // For a window that weighs twice the threshold or more, only when it is the second such answer in a row (N4-m1): the
  // first is doubted, and asked again by the failure rule.
  const doubted = parsed?.empty === true && material >= 2 * memory.summaryMinFoldWeight && !lease.emptyAnswer;
  const items = answered !== null && hasItems(answered) ? answered : parsed?.empty === true && !doubted ? (old?.items ?? noItems()) : null;

  let skipped = 0;
  if (items === null) {
    const outcome = doubted ? "empty" : outcomeOf(report, answer);
    if (outcome === "unchanged") {
      // It clears by itself: the claim is given back as if the job had not run.
      await settleAttempt(db, job.conversationId, agent.id, lease, claim.before);
      return;
    }
    if (outcome === "no_model") {
      count(db, "summary_no_model");
      // Once a backoff step at most: the next try is that far off.
      log.warn({ agentId: agent.id, conversationId: job.conversationId }, "summary: no memory model to call (none, a choice not allowed, or its key or address refused); asked again after a backoff");
    } else count(db, outcome === "too_big" ? "summary_too_big" : outcome === "empty" ? "summary_empty_retried" : "summary_failed");
    const after = afterFailure(lease, { kind: outcome, n, full, upto }, now());
    if (!after.setAside) {
      await settleAttempt(db, job.conversationId, agent.id, lease, after.next);
      return;
    }
    // Set aside: the window is written as passed — the summary's items as they were — and its messages are in no summary.
    skipped = n;
  }

  const kept = items ?? old?.items ?? noItems();
  let written: boolean;
  try {
    written = await db.tx(async (t) => {
      // The conversation's row, then the Agent's (the order a reply's run takes them in): no reply reads a half-written state.
      const locked = await lockAgent(t, agent.id, job.conversationId);
      if (locked.deleted) return false;
      const base2 = await summaryBase(t, agent.id, job.conversationId);
      if (base2 === null || next.fromSeq <= base2) return false;
      if (!sameSummary(await readSummary(t, job.conversationId, agent.id), stored)) return false;
      await writeSummary(t, job.conversationId, agent.id, { ...next, items: kept });
      await writeAttempt(t, job.conversationId, agent.id, afterWrite(lease, upto, now(), memory.summaryMinIntervalMs, skipped));
      return true;
    });
  } catch (err) {
    if (err instanceof AppError && err.status === 404) written = false;
    else throw err;
  }
  // The pair moved on meanwhile (a new topic, the Agent out of the group or added back, another write): its claim lapses.
  if (!written) {
    count(db, "summary_dropped");
    return;
  }
  count(db, skipped > 0 ? "summary_skipped" : kept === answered ? "summary_written" : "summary_nothing_new");
}

const sameSummary = (a: Summary | null, b: Summary | null): boolean =>
  a === null || b === null ? a === b : a.fromSeq === b.fromSeq && a.uptoSeq === b.uptoSeq && JSON.stringify(a.items) === JSON.stringify(b.items);
