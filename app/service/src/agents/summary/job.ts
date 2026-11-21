import { AppError } from "../../errors.ts";
import { weight } from "../../metering/tokens.ts";
import { memoryCall, type MemoryCallDeps, type MemoryCallReport } from "../../memory/call.ts";
import { shown } from "../../memory/review.ts";
import { count } from "../../memory/stats.ts";
import { attachmentLabel } from "../runtime/context.ts";
import { personLabel, speakerRole } from "../runtime/prompt.ts";
import { liveAgent, lockAgent } from "../store.ts";
import { cleanSummary, hasContent, keepLabelled, OWNER, SELF, speakersIn, summaryInput, summarySystem, type SummaryLine } from "./prompt.ts";
import { countPlaced, legacySummary, readPlaced, readSummary, shownSummary, speakerLabels, summaryBase, writeSummary, type PlacedMessage, type PlacedReader, type Summary } from "./store.ts";

/**
 * One rolling-summary job (README "The rolling summary"; queued after a reply by agents/port-impl.ts `finish`, run by the
 * memory reviewer's scheduler, memory/reviewer.ts, one job per Agent at a time within its cap): the messages of the pair
 * that a reply's context left out are folded, by ONE memory call (memory/call.ts `memoryCall`: its own `agent_runs` row of
 * purpose `memory`, held and settled on the memory allowance the site pays — or, on a model of the owner's own provider,
 * nothing), into the pair's summary, updated in place.
 *
 * Fail closed: a call that could not be made, failed, was abandoned, or answered nothing usable changes nothing — nor does
 * an answer of section headings only where the old summary said something; so does an answer that is not shorter than what
 * it would replace (the old summary and the messages it now covers, in weight), and so does one that arrives once the pair
 * has moved on (a new topic, the Agent out of the group or added back, another write). Nothing of any text is logged:
 * counters only (memory/stats.ts).
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

/**
 * A message as the call is shown it (prompt.ts `SummaryLine`): in a group, who said it by a label no one else has
 * (runtime/prompt.ts `personLabel`, the roster's: the name and the handle, the owner's as `主人（…）` by account) and who they are to the Agent by account
 * (`speakerRole`, the labels' own mapping).
 */
function lineOf(m: PlacedMessage, reader: PlacedReader, maxWeight: number): SummaryLine {
  const label = m.attachment ? attachmentLabel({ name: m.attachment.name, image: m.attachment.inline === true }) : "";
  const text = shown([label, m.text].filter((s) => s !== "").join(" "), maxWeight);
  if (m.senderId === reader.agentId) return { who: SELF, text };
  if (!reader.group) return { who: OWNER, text };
  const role = speakerRole(m.senderId, m.kind, reader.ownerId);
  return { who: personLabel(m.name, m.handle, role === "你的主人"), role: role === "你的主人" ? "主人" : role, text };
}

/**
 * The job: what to read, the call, what to keep. The window is the pair's messages placed after what its summary covers
 * (or, with none, after where the Agent may be shown the conversation from: `summaryBase`) and up to `job.upTo`, at most
 * `SUMMARY_MAX_MESSAGES` of them and at most what a review is shown in weight (`reviewMessages` × `reviewMessageWeight`, each
 * cut at `reviewMessageWeight`), cut between places — so an exchange is never split; the rest waits for the next job. No
 * call is made while fewer than `summaryMinMessages` messages lie past what the summary covers (whatever the reply's context
 * counted from its own line), and a pair whose last attempt wrote nothing is not asked again until `summaryMinMessages` more
 * lie past that attempt — but for a call that could not start because the owner had as many calls running as they may.
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
  // A summary from before where the Agent may be shown the conversation from now (a new topic, a new stay) is no summary.
  const old = stored !== null && stored.fromSeq > base ? stored : null;
  const start = old?.uptoSeq ?? base;
  if (job.upTo <= start) return;
  if ((await countPlaced(db, reader, start, job.upTo)) < config.memory.summaryMinMessages) return;
  const tried = ctx.summaryTried;
  if (tried !== null && tried >= start && (await countPlaced(db, reader, tried, job.upTo)) < config.memory.summaryMinMessages) return;

  const { memory } = config;
  // What the call is shown and the labels its answer may hold, read in ONE snapshot (round 2, N-5): the messages, each
  // speaker's label as the input writes it (`lineOf`), the old summary as it is built on, and the labels the answer is held
  // to — so that a rename while the call runs changes none of them (whose each label is is recorded with the answer, and a
  // reply shows it as that account is labelled then). The old summary as a reply is shown it (store.ts `shownSummary`), or,
  // for a group's row from before migration 056, as the labels of now allow (`legacySummary`).
  const { read, before, labels } = await db.tx(async (t) => {
    await t.query("set transaction isolation level repeatable read, read only");
    return {
      read: await readPlaced(t, reader, start, job.upTo, SUMMARY_MAX_MESSAGES + 1),
      before: old === null ? null : ((await shownSummary(t, reader, old)) ?? (await legacySummary(t, reader, base, old))),
      labels: reader.group ? await speakerLabels(t, reader, base, job.upTo) : null,
    };
  });
  const lines = read.map((m) => lineOf(m, reader, memory.reviewMessageWeight));
  let n = Math.min(read.length, SUMMARY_MAX_MESSAGES);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const w = weight(lines[i]!.text);
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
  const taken = lines.slice(0, n).filter((l) => l.text !== "");
  // Messages with nothing left of them once cleaned do not count toward the minimum (a window cut for its size holds at
  // least `reviewMessages` of them, which the configuration holds to at least `summaryMinMessages`: it is not asked again).
  if (!cut && taken.length < memory.summaryMinMessages) return;
  const next: Omit<Summary, "text" | "speakers"> = { fromSeq: old?.fromSeq ?? read[0]!.at, uptoSeq: upto };

  count(db, "summary_run");
  const report: MemoryCallReport = { answered: false };
  const answer = await memoryCall(
    deps,
    agent.ownerId,
    {
      system: summarySystem(reader.group, memory.summaryMaxWeight),
      user: summaryInput(before, taken),
      maxOutputTokens: Math.max(memory.reviewMaxOutputTokens, 2 * memory.summaryMaxWeight),
    },
    ctx.closing,
    report,
  );
  if (ctx.closing.aborted) return;
  // Cleaned, and without any citation, before its labels are looked at (prompt.ts `cleanSummary`).
  const cleaned = answer === null ? null : cleanSummary(answer, memory.summaryMaxWeight);
  // In a group every speaker label must be one the system wrote — as the input wrote it (`labels`, read with it): a line with
  // any other goes (counted); whose each label kept is, is stored with it (`speakers`), so that a rename since changes its
  // label, not whose it is (store.ts `shownSummary`).
  let labelled = cleaned;
  let speakers: Summary["speakers"] = null;
  if (cleaned !== null && labels !== null) {
    const kept = keepLabelled(cleaned, labels);
    count(db, "summary_label_dropped", kept.dropped);
    labelled = kept.text;
    speakers = speakersIn(labelled, labels.ids);
  }
  // Headings and nothing else are no summary: never stored, and the messages are not swallowed.
  const text = labelled !== null && hasContent(labelled) ? labelled : null;
  if (text === null) {
    // A refusal for the allowance is counted where it is decided (`memory_refused_allowance`).
    if (!report.refused) count(db, "summary_failed");
    // A call that could not start for the owner's calls running at once may be asked again after the next reply.
    if (!report.capped) ctx.summaryAttempted(job.upTo);
    return;
  }
  // Shorter than what it replaces — the old summary and the messages it now covers — or not at all.
  if (weight(text) >= weight(before ?? "") + taken.reduce((sum, l) => sum + weight(l.text), 0)) {
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
      await writeSummary(t, job.conversationId, agent.id, { ...next, text, speakers });
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
  a === null || b === null ? a === b : a.fromSeq === b.fromSeq && a.uptoSeq === b.uptoSeq && a.text === b.text;
