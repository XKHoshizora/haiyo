import { AppError } from "../../errors.ts";
import { weight } from "../../metering/tokens.ts";
import { memoryCall, type MemoryCallDeps, type MemoryCallReport } from "../../memory/call.ts";
import { shown } from "../../memory/review.ts";
import { count } from "../../memory/stats.ts";
import { labelledEntry, toAttachment } from "../context.ts";
import { attachmentLabel, entryText, minimalTokens } from "../runtime/context.ts";
import { drawMark, speakerRole } from "../runtime/prompt.ts";
import { liveAgent, lockAgent } from "../store.ts";
import { withoutCitations } from "../tools/refs.ts";
import { atLongest, callPerson, capped, hasItems, mapItems, parseSummary, shownForm, summaryInput, summarySystem, whoIn, type Sections } from "./prompt.ts";
import { peopleNow, readPlaced, readSummary, summaryBase, writeSummary, type PlacedMessage, type PlacedReader, type Summary } from "./store.ts";

/**
 * One rolling-summary job (README "The rolling summary"; queued after a reply by agents/port-impl.ts `finish`, run by the
 * memory reviewer's scheduler, memory/reviewer.ts, one job per Agent at a time within its cap): the messages of the pair
 * that a reply's context left out are folded, by ONE memory call (memory/call.ts `memoryCall`: its own `agent_runs` row of
 * purpose `memory`, held and settled on the memory allowance the site pays — or, on a model of the owner's own provider,
 * nothing), into the pair's summary, updated in place. Who said what is never text: the call names each speaker by a key
 * of the roster it is given (keys only for the senders of its messages and the speakers of the old summary it is given
 * back), and what is stored is the account each key stands for (prompt.ts), held to the cap as a reply would be shown it.
 * Whether a call is worth paying for is decided before it is made (`runSummary`): nothing is paid for and then thrown away.
 *
 * Fail closed: a call that could not be made, failed, was abandoned, or answered nothing usable changes nothing — nor does
 * an answer with no item (or none that fits) where the old summary said something; and nor does one that arrives once
 * the pair has moved on (a new topic, the Agent out of the group or added back, another write). Nothing of any text is
 * logged: counters only (memory/stats.ts).
 */

export interface SummaryJob {
  kind: "summary";
  agentId: string;
  conversationId: string;
  /** The last place (agents/summary/store.ts) the reply's context left out: what is to be covered up to. */
  upTo: number;
}

/** A job's window: the messages placed after `from` and up to and with `upto`. */
export interface SummaryWindow {
  from: number;
  upto: number;
}

export interface SummaryContext {
  /** The service is stopping: a call under way is abandoned, and nothing is written. */
  closing: AbortSignal;
  /** The window of the pair's last call that wrote nothing (in this process); null when none. */
  summaryTried: SummaryWindow | null;
  /** After a call: its window when it wrote nothing, null when it wrote a summary. */
  summaryAttempted(window: SummaryWindow | null): void;
}

export type SummaryDeps = MemoryCallDeps;

/** The most messages one job reads; the rest waits for the next job. */
export const SUMMARY_MAX_MESSAGES = 200;

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
 * The job: what to read, the call, what to keep. The window is the pair's messages placed after what its summary covers
 * (or, with none, after where the Agent may be shown the conversation from: `summaryBase`) and up to `job.upTo`, at most
 * `SUMMARY_MAX_MESSAGES` of them and at most what a review is shown in weight (`reviewMessages` × `reviewMessageWeight`, each
 * cut at `reviewMessageWeight`), cut between places — so an exchange is never split; the rest waits for the next job.
 * A call is made only when it is worth paying for, decided before it is made: the window's messages that have something
 * to fold in weigh, as a reply would show them (`shownWeight`), at least `summaryMinFoldWeight` — or the window is full (cut
 * at its size: a long run of one-word lines can then not hold back what comes after it). A pair whose last call wrote
 * nothing is not asked again for that window, nor until what lies past it weighs `summaryMinFoldWeight` (in this process).
 * A call that was not made (no model, the allowance spent, too many calls running) holds nothing back. A summary written
 * before migration 059 (text only) is none to build on: the window starts where a first summary's would.
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

  const { memory } = config;
  // What the call is shown, read in ONE snapshot (round 2, N-5): the messages, and who everyone they and the old summary
  // name is now — so that a rename while the call runs changes nothing it was shown (and what is stored is by account).
  const { read, people } = await db.tx(async (t) => {
    await t.query("set transaction isolation level repeatable read, read only");
    const read = await readPlaced(t, reader, start, job.upTo, SUMMARY_MAX_MESSAGES + 1);
    return { read, people: await peopleNow(t, reader, [...new Set([...(old === null ? [] : whoIn(old.items)), ...read.map((m) => m.senderId)])]) };
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
  // What is folded in: the messages with something left once cleaned, each weighed as a reply would show it.
  const mark = reader.group ? drawMark() : null;
  const taken = read.slice(0, n).flatMap((m, i) => (texts[i] === "" ? [] : [{ at: m.at, sender: m.senderId, text: texts[i]!, weight: shownWeight(m, reader, mark) }]));
  const material = (after: number): number => taken.reduce((sum, l) => sum + (l.at > after ? l.weight : 0), 0);
  // Worth a call? Decided now, before anything is paid: enough to fold in, or a full window.
  if (taken.length === 0 || (!cut && material(start) < memory.summaryMinFoldWeight)) return;
  // Not the same window again, nor one with too little past it, after a call that wrote nothing.
  const tried = ctx.summaryTried;
  if (tried !== null && tried.from === start && material(tried.upto) < memory.summaryMinFoldWeight) return;
  const window = { from: start, upto };
  const next: Omit<Summary, "items"> = { fromSeq: old?.fromSeq ?? read[0]!.at, uptoSeq: upto };

  // The call's roster: a key for everyone it is shown — the old summary's speakers first, then the senders of its
  // messages, and nobody else —, for this call only.
  const accounts = [...new Set([...(old === null ? [] : whoIn(old.items)), ...taken.map((l) => l.sender)])];
  const keyOf = new Map(accounts.map((id, i) => [id, `p${i + 1}`]));
  const accountOf = new Map(accounts.map((id, i) => [`p${i + 1}`, id]));
  // The old summary as it is built on: under the keys, without citations (as a reply is shown it, store.ts `shownSummary`).
  const before = old === null ? null : mapItems(old.items, (id) => keyOf.get(id)!, withoutCitations);
  const itemMax = Math.min(memory.modelEntryMax, memory.summaryMaxWeight);
  // What is stored is held to the cap as a reply would be shown it with every name and account at its longest (prompt.ts
  // `atLongest`, `capped`): no rename since can take what a reply is shown past the cap (the show-time cut, store.ts
  // `shownSummary`, stays as the safety net).
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
  if (ctx.closing.aborted) return;
  // Held to its shape (prompt.ts `parseSummary`): an item whose `said_by` is absent or no key it was given goes, counted;
  // each key back to the account it stands for; then held to the cap. Valid and within the cap is all it has to be.
  const parsed = answer === null ? { sections: null, unknown: 0 } : parseSummary(answer, new Set(accountOf.keys()), itemMax);
  count(db, "summary_who_unknown", parsed.unknown);
  const items = parsed.sections === null ? null : asStored(mapItems(parsed.sections, (key) => accountOf.get(key)!));
  if (items === null || !hasItems(items)) {
    // A refusal for the allowance is counted where it is decided (`memory_refused_allowance`).
    if (!report.refused) count(db, "summary_failed");
    // A call that was made is not made again for this window; one that was not (no model, the allowance, too many calls
    // running) holds nothing back.
    if (report.started === true) ctx.summaryAttempted(window);
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
