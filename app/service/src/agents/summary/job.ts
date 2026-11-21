import { AppError } from "../../errors.ts";
import { weight } from "../../metering/tokens.ts";
import { memoryCall, type MemoryCallDeps, type MemoryCallReport } from "../../memory/call.ts";
import { shown } from "../../memory/review.ts";
import { count } from "../../memory/stats.ts";
import { attachmentLabel } from "../runtime/context.ts";
import { SELF_WORD } from "../runtime/prompt.ts";
import { liveAgent, lockAgent } from "../store.ts";
import { withoutCitations } from "../tools/refs.ts";
import { mapItems, parseSummary, summaryInput, summarySystem, summaryWeight, whoIn } from "./prompt.ts";
import { countPlaced, peopleNow, readPlaced, readSummary, summaryBase, writeSummary, type PlacedMessage, type PlacedReader, type Summary } from "./store.ts";

/**
 * One rolling-summary job (README "The rolling summary"; queued after a reply by agents/port-impl.ts `finish`, run by the
 * memory reviewer's scheduler, memory/reviewer.ts, one job per Agent at a time within its cap): the messages of the pair
 * that a reply's context left out are folded, by ONE memory call (memory/call.ts `memoryCall`: its own `agent_runs` row of
 * purpose `memory`, held and settled on the memory allowance the site pays — or, on a model of the owner's own provider,
 * nothing), into the pair's summary, updated in place. Who said what is never text: the call names each speaker by a key
 * of the roster it is given, and what is stored is the account each key stands for (prompt.ts).
 *
 * Fail closed: a call that could not be made, failed, was abandoned, or answered nothing usable changes nothing — nor does
 * an answer with no item where the old summary said something; so does an answer that is not shorter than what it would
 * replace (the old summary and the messages it now covers, in weight), and so does one that arrives once the pair has moved
 * on (a new topic, the Agent out of the group or added back, another write). Nothing of any text is logged: counters only
 * (memory/stats.ts).
 */

export interface SummaryJob {
  kind: "summary";
  agentId: string;
  conversationId: string;
  /** The last place (agents/summary/store.ts) the reply's context left out: what is to be covered up to. */
  upTo: number;
}

export interface SummaryContext {
  /** The service is stopping: a call under way is abandoned, and nothing is written. */
  closing: AbortSignal;
  /** The place the pair's last attempt that wrote nothing was to cover up to (in this process); null when none. */
  summaryTried: number | null;
  /** After an attempt: the place it was to cover up to when it wrote nothing, null when it wrote a summary. */
  summaryAttempted(upTo: number | null): void;
}

export type SummaryDeps = MemoryCallDeps;

/** The most messages one job reads; the rest waits for the next job. */
export const SUMMARY_MAX_MESSAGES = 200;

/** A message's text as the call is shown it: its attachment's label and its text, cleaned and cut at `maxWeight`. */
function lineText(m: PlacedMessage, maxWeight: number): string {
  const label = m.attachment ? attachmentLabel({ name: m.attachment.name, image: m.attachment.inline === true }) : "";
  // No number a reply's tools gave (`〔m3〕`) means anything to this call or to the summary it writes (tools/refs.ts `withoutCitations`).
  return shown([label, withoutCitations(m.text)].filter((s) => s !== "").join(" "), maxWeight);
}

/**
 * The job: what to read, the call, what to keep. The window is the pair's messages placed after what its summary covers
 * (or, with none, after where the Agent may be shown the conversation from: `summaryBase`) and up to `job.upTo`, at most
 * `SUMMARY_MAX_MESSAGES` of them and at most what a review is shown in weight (`reviewMessages` × `reviewMessageWeight`, each
 * cut at `reviewMessageWeight`), cut between places — so an exchange is never split; the rest waits for the next job. No
 * call is made while fewer than `summaryMinMessages` messages lie past what the summary covers (whatever the reply's context
 * counted from its own line), and a pair whose last attempt wrote nothing is not asked again until `summaryMinMessages` more
 * lie past that attempt — but for a call that could not start because the owner had as many calls running as they may.
 * A summary written before migration 059 (text only) is none to build on: the window starts where a first summary's would.
 */
export async function runSummary(deps: SummaryDeps, job: SummaryJob, ctx: SummaryContext): Promise<void> {
  const { db, config } = deps;
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
  if ((await countPlaced(db, reader, start, job.upTo)) < config.memory.summaryMinMessages) return;
  const tried = ctx.summaryTried;
  if (tried !== null && tried >= start && (await countPlaced(db, reader, tried, job.upTo)) < config.memory.summaryMinMessages) return;

  const { memory } = config;
  // What the call is shown, read in ONE snapshot (round 2, N-5): the messages, and the label of now of everyone they and the
  // old summary name — so that a rename while the call runs changes nothing it was shown (and what is stored is by account).
  const { read, people } = await db.tx(async (t) => {
    await t.query("set transaction isolation level repeatable read, read only");
    const read = await readPlaced(t, reader, start, job.upTo, SUMMARY_MAX_MESSAGES + 1);
    return { read, people: await peopleNow(t, reader, [...new Set([...(old === null ? [] : whoIn(old.items)), ...read.map((m) => m.senderId)])], SELF_WORD) };
  });
  const texts = read.map((m) => lineText(m, memory.reviewMessageWeight));
  let n = Math.min(read.length, SUMMARY_MAX_MESSAGES);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const w = weight(texts[i]!);
    if (i > 0 && total + w > memory.reviewMessages * memory.reviewMessageWeight) {
      n = i;
      break;
    }
    total += w;
  }
  const cut = n < read.length;
  // Cut between places: when the first message left for later shares its place with the last one taken, that place waits whole.
  if (cut && n > 0 && read[n]!.at === read[n - 1]!.at) {
    const at = read[n - 1]!.at;
    while (n > 0 && read[n - 1]!.at === at) n--;
  }
  if (n === 0) return;
  const upto = cut ? read[n - 1]!.at : job.upTo;
  const taken = read.slice(0, n).flatMap((m, i) => (texts[i] === "" ? [] : [{ sender: m.senderId, text: texts[i]! }]));
  // Messages with nothing left of them once cleaned do not count toward the minimum (a window cut for its size holds at
  // least `reviewMessages` of them, which the configuration holds to at least `summaryMinMessages`: it is not asked again).
  if (!cut && taken.length < memory.summaryMinMessages) return;
  const next: Omit<Summary, "items"> = { fromSeq: old?.fromSeq ?? read[0]!.at, uptoSeq: upto };

  // The call's roster: a key for everyone it is shown, for this call only, the old summary's people first.
  const accounts = [...new Set([...(old === null ? [] : whoIn(old.items)), ...taken.map((l) => l.sender)])];
  const keyOf = new Map(accounts.map((id, i) => [id, `p${i + 1}`]));
  const accountOf = new Map(accounts.map((id, i) => [`p${i + 1}`, id]));
  // The old summary as it is built on: under the keys, without citations (as a reply is shown it, store.ts `shownSummary`).
  const before = old === null ? null : mapItems(old.items, (id) => keyOf.get(id)!, withoutCitations);
  const itemMax = Math.min(memory.modelEntryMax, memory.summaryMaxWeight);

  count(db, "summary_run");
  const report: MemoryCallReport = { answered: false };
  const answer = await memoryCall(
    deps,
    agent.ownerId,
    {
      system: summarySystem(reader.group, memory.summaryMaxWeight, itemMax),
      user: summaryInput(
        Object.fromEntries(accounts.map((id) => [keyOf.get(id)!, people.get(id)!])),
        before,
        taken.map((l) => ({ who: keyOf.get(l.sender)!, text: l.text })),
      ),
      // The answer is JSON: its keys and a `who` an item cost about as much again as its texts.
      maxOutputTokens: Math.max(memory.reviewMaxOutputTokens, 3 * memory.summaryMaxWeight),
    },
    ctx.closing,
    report,
  );
  if (ctx.closing.aborted) return;
  // Held to its shape (prompt.ts `parseSummary`): an item whose `who` is no key it was given goes, counted.
  const parsed = answer === null ? { sections: null, unknown: 0 } : parseSummary(answer, new Set(accountOf.keys()), memory.summaryMaxWeight, itemMax);
  count(db, "summary_who_unknown", parsed.unknown);
  if (parsed.sections === null) {
    // A refusal for the allowance is counted where it is decided (`memory_refused_allowance`).
    if (!report.refused) count(db, "summary_failed");
    // A call that could not start for the owner's calls running at once may be asked again after the next reply.
    if (!report.capped) ctx.summaryAttempted(job.upTo);
    return;
  }
  // Each key back to the account it stands for: what is stored.
  const items = mapItems(parsed.sections, (key) => accountOf.get(key)!);
  // Shorter than what it replaces — the old summary and the messages it now covers — or not at all.
  if (summaryWeight(items) >= (before === null ? 0 : summaryWeight(before)) + taken.reduce((sum, l) => sum + weight(l.text), 0)) {
    count(db, "summary_not_shorter");
    ctx.summaryAttempted(job.upTo);
    return;
  }

  let written: boolean;
  try {
    written = await db.tx(async (t) => {
      // The conversation's row, then the Agent's (the order a reply's run takes them in): no reply reads a half-written state.
      const locked = await lockAgent(t, agent.id, job.conversationId);
      if (locked.deleted) return false;
      const now = await summaryBase(t, agent.id, job.conversationId);
      if (now === null || next.fromSeq <= now) return false;
      const current = await readSummary(t, job.conversationId, agent.id);
      if (!sameSummary(current, stored)) return false;
      await writeSummary(t, job.conversationId, agent.id, { ...next, items });
      return true;
    });
  } catch (err) {
    if (err instanceof AppError && err.status === 404) written = false;
    else throw err;
  }
  if (!written) {
    count(db, "summary_dropped");
    return;
  }
  count(db, "summary_written");
  ctx.summaryAttempted(null);
}

const sameSummary = (a: Summary | null, b: Summary | null): boolean =>
  a === null || b === null ? a === b : a.fromSeq === b.fromSeq && a.uptoSeq === b.uptoSeq && JSON.stringify(a.items) === JSON.stringify(b.items);
