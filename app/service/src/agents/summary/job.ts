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
 * store.ts `AttemptState`): when it may be asked again (`not_before`), its failures in a row, the most messages its next
 * window takes. One function decides from it and the weighed window (`shouldCall`), and the window is claimed under the
 * pair's lock before the call is made: neither another process nor this one after a restart pays for it again meanwhile.
 * Nothing in process memory decides.
 *
 * Fail closed: a call that could not be made, failed, was abandoned, or answered nothing in the asked shape changes no
 * summary, nor does one that arrives once the pair has moved on (a new topic, the Agent out of the group or added back,
 * another write). An answer of the four lists, all empty, is no failure: nothing in the window was worth keeping, and what
 * the summary covers moves past it, its items as they were. Nothing of any text is logged: counters only (memory/stats.ts).
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
 * What came of a call that wrote nothing, for the pair's state: `unchanged` — it could not start for a reason that clears by
 * itself (the memory allowance spent, the owner's calls running at once): nothing changes, the next job looks again;
 * `no_model` — it could not start for want of a model (none configured, a choice not allowed, a saved key that cannot be
 * opened); `too_big` — its input does not fit the model's context; `unusable` — the model answered, and not in the asked
 * shape (no JSON object of the four lists, no item that can be kept, nothing, or cut at its limit); `failed` — the call
 * failed, or could not start for an error of the service's own.
 */
type Outcome = "unchanged" | "no_model" | "too_big" | "unusable" | "failed";

function outcomeOf(report: MemoryCallReport, answer: string | null): Outcome {
  if (report.refused === true || report.capped === true) return "unchanged";
  if (report.unstartable !== undefined) return report.unstartable;
  return report.answered || answer !== null ? "unusable" : "failed";
}

/**
 * The job: what to read, whether to call, the call, what to keep. The window is the pair's messages placed after what its
 * summary covers (or, with none, after where the Agent may be shown the conversation from: `summaryBase`) and up to
 * `job.upTo`, at most `SUMMARY_MAX_MESSAGES` of them — or the fewer its state allows after a window that could not be
 * summarised whole — and at most what a review is shown in weight (`reviewMessages` × `reviewMessageWeight`, each cut at
 * `reviewMessageWeight`), cut between places, so that an exchange is never split; the rest waits for the next job. A
 * summary written before migration 059 (text only) is none to build on: the window starts where a first summary's would.
 *
 * Before the window is read, two cheap looks: the pair's state (one row: not due, nothing else is read, however many
 * replies come meanwhile), then whether a call could start now (the memory allowance, the owner's calls running at once;
 * either refusing changes nothing). Then `shouldCall` decides, and the claim takes the window. After the call:
 * - a summary written (or the window folded with nothing to add): failures start over, the next window is whole, and the
 *   pair is not asked again for `summaryMinIntervalMs`;
 * - a call that wrote nothing — failed, unusable, no model, too big — one failure more, and the pair waits `backoffMs`; an
 *   unusable answer for a full window, or an input too big, halves the next window (`nextWindow`).
 * No message is ever skipped: what a summary covers moves only when it is written.
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
  const state = await readAttempt(db, job.conversationId, agent.id);
  if (!due(state, now())) return;
  // A call could not start now, for a reason that clears by itself: nothing changes; the next reply's job looks again.
  if (await allowanceRefuses(db, config, agent.ownerId, new Date(now()))) {
    count(db, "memory_refused_allowance");
    return;
  }
  if (await callsAtCap(db, config, agent.ownerId)) return;

  const limit = Math.min(SUMMARY_MAX_MESSAGES, state?.windowMessages ?? SUMMARY_MAX_MESSAGES);
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

  // The claim, under the pair's lock (the conversation's row, then the Agent's: the order a reply takes them in): the state
  // read again and, still due and as the window was read under, the window claimed until the call's deadline and a minute.
  let claim: { lease: AttemptState; before: AttemptState | null } | null;
  try {
    claim = await db.tx(async (t) => {
      const locked = await lockAgent(t, agent.id, job.conversationId);
      if (locked.deleted || (await summaryBase(t, agent.id, job.conversationId)) !== base) return null;
      if (!sameSummary(await readSummary(t, job.conversationId, agent.id), stored)) return null;
      const before = await readAttempt(t, job.conversationId, agent.id);
      if (!due(before, now()) || (before?.windowMessages ?? null) !== (state?.windowMessages ?? null)) return null;
      const lease: AttemptState = { attemptUpto: upto, failures: before?.failures ?? 0, notBefore: now() + claimMs(config), windowMessages: before?.windowMessages ?? null };
      await writeAttempt(t, job.conversationId, agent.id, lease);
      return { lease, before };
    });
  } catch (err) {
    if (err instanceof AppError && err.status === 404) return;
    throw err;
  }
  if (claim === null) return;
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
  const items = answered !== null && hasItems(answered) ? answered : parsed?.empty === true ? (old?.items ?? noItems()) : null;

  if (items === null) {
    const outcome = outcomeOf(report, answer);
    if (outcome === "unchanged") {
      // It clears by itself: the claim is given back as if the job had not run.
      await settleAttempt(db, job.conversationId, agent.id, claim.lease, claim.before);
      return;
    }
    if (outcome === "no_model") {
      count(db, "summary_no_model");
      // Once a backoff step at most: the next try is that far off.
      log.warn({ agentId: agent.id, conversationId: job.conversationId }, "summary: no memory model to call; asked again after a backoff");
    } else count(db, outcome === "too_big" ? "summary_too_big" : "summary_failed");
    const failures = claim.lease.failures + 1;
    const halve = outcome === "too_big" || (outcome === "unusable" && full);
    await settleAttempt(db, job.conversationId, agent.id, claim.lease, {
      attemptUpto: upto,
      failures,
      notBefore: now() + backoffMs(failures),
      windowMessages: halve ? nextWindow(n) : claim.lease.windowMessages,
    });
    return;
  }

  let written: boolean;
  try {
    written = await db.tx(async (t) => {
      // The conversation's row, then the Agent's (the order a reply's run takes them in): no reply reads a half-written state.
      const locked = await lockAgent(t, agent.id, job.conversationId);
      if (locked.deleted) return false;
      const base2 = await summaryBase(t, agent.id, job.conversationId);
      if (base2 === null || next.fromSeq <= base2) return false;
      if (!sameSummary(await readSummary(t, job.conversationId, agent.id), stored)) return false;
      await writeSummary(t, job.conversationId, agent.id, { ...next, items });
      // Written: the failures start over, the next window is whole, and the pair waits the minimum interval.
      await writeAttempt(t, job.conversationId, agent.id, { attemptUpto: upto, failures: 0, notBefore: now() + memory.summaryMinIntervalMs, windowMessages: null });
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
  count(db, items === answered ? "summary_written" : "summary_nothing_new");
}

const sameSummary = (a: Summary | null, b: Summary | null): boolean =>
  a === null || b === null ? a === b : a.fromSeq === b.fromSeq && a.uptoSeq === b.uptoSeq && JSON.stringify(a.items) === JSON.stringify(b.items);
