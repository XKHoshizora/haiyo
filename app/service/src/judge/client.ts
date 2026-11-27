import type { Config } from "../config.ts";
import { guardedFetch, GuardGaveUp } from "../providers/guard.ts";
import { keyRefused } from "../providers/probe.ts";
import { createSlots } from "../slots.ts";

/**
 * The judgement model: a small upstream that answers typed questions about a piece of text with probabilities. The
 * request is `POST <url>` with `{ model, state, questions }` and the answer `{ answers }` (see `Question`). Nothing
 * here logs, and no error carries the key, the path, the state, a question or an answer.
 */

/** A question about the state: a yes/no probability (`noul`), or a probability for each of a few named options. */
export type Question =
  | { key: string; type: "noul"; instructions: string }
  | { key: string; type: "choice"; instructions: string; options: Readonly<Record<string, string>> };

/** What a question was answered. A probability is always a finite number in [0, 1]. */
export type Answer = { type: "noul"; p: number } | { type: "choice"; probabilities: ReadonlyMap<string, number> };

/**
 * Why a channel gave no answer, coarsely (to count, never with any text of it): the upstream refused the key (401, 403:
 * `auth`) or answered another status (`status`); no answer in time (`timeout`); an answer over the size cap
 * (`oversize`) or not of the protocol's shape (`shape`); the key's variable not set (`key_unset`); no place among the calls
 * in flight (`busy`: nothing was sent, and a moment later there may be one); anything else on the way — the connection, the
 * address (`network`).
 */
export type JudgeFailure = "auth" | "status" | "timeout" | "oversize" | "shape" | "key_unset" | "busy" | "network";

/**
 * No channel gave an answer; `reason` is why the last one tried did not. `sent`: whether any channel's request went out — every
 * failure but a key unset (`key_unset`) and no place among the calls in flight (`busy`) is one that tried to reach the upstream.
 * `busy`: whether any channel found no place, whatever the last one's reason. Made by hand (a test's script), both follow the reason
 * unless given.
 */
export class JudgeError extends Error {
  constructor(
    readonly reason: JudgeFailure,
    readonly sent: boolean = reason !== "busy" && reason !== "key_unset",
    readonly busy: boolean = reason === "busy",
  ) {
    super("the judgement model gave no answer");
    this.name = "JudgeError";
  }
}

export interface Judge {
  /**
   * Asks `questions` about `state` in one call. A key whose answer is missing or malformed is left out of the map (the
   * caller reads that as "no answer"); so is a question that cannot be sent (`askable`), and a key asked again after the
   * first. Rejects with a `JudgeError` when every channel failed, and with the signal's reason when `signal` aborts.
   */
  ask(state: string, questions: readonly Question[], signal?: AbortSignal): Promise<Map<string, Answer>>;
}

/** The most options one choice question is sent with; one with more is not sent (`askable`). */
export const MAX_CHOICE_OPTIONS = 254;
/** An answer is a few numbers; this is plenty. */
const MAX_RESPONSE_BYTES = 64 * 1024;
/** Calls in flight at once, for the judgement alone. */
const MAX_CALLS = 32;

const isProbability = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Whether `q` can be sent at all: a choice needs 1 to `MAX_CHOICE_OPTIONS` options, each with a name. */
export function askable(q: Question): boolean {
  if (q.type === "noul") return true;
  const names = Object.keys(q.options);
  return names.length > 0 && names.length <= MAX_CHOICE_OPTIONS && names.every((n) => n !== "");
}

/** The request's body: each question under its key, in an object with no prototype (a key is only ever a key). */
function bodyOf(model: string, state: string, questions: readonly Question[]): string {
  const sent: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const q of questions) {
    sent[q.key] =
      q.type === "noul"
        ? { type: "noul", instructions: q.instructions }
        : { type: "choice", instructions: q.instructions, criteria: q.options };
  }
  return JSON.stringify({ model, state, questions: sent });
}

/** The answers of a good response; null when the body is not `{ "answers": { … } }`. */
function parse(text: string, questions: readonly Question[]): Map<string, Answer> | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(json) || !isRecord(json.answers)) return null;
  const answers = json.answers;
  const out = new Map<string, Answer>();
  for (const q of questions) {
    const a = Object.hasOwn(answers, q.key) ? answers[q.key] : undefined;
    if (!isRecord(a)) continue;
    if (q.type === "noul") {
      if (isProbability(a.noul)) out.set(q.key, { type: "noul", p: a.noul });
      continue;
    }
    if (!isRecord(a.probabilities)) continue;
    const probabilities = new Map<string, number>();
    for (const name of Object.keys(q.options)) {
      const p = Object.hasOwn(a.probabilities, name) ? a.probabilities[name] : undefined;
      if (isProbability(p)) probabilities.set(name, p);
    }
    if (probabilities.size > 0) out.set(q.key, { type: "choice", probabilities });
  }
  return out;
}

export function createJudge(
  config: NonNullable<Config["judge"]>,
  opts: { allowInsecureLocal?: boolean; env?: NodeJS.ProcessEnv } = {},
): Judge {
  const env = opts.env ?? process.env;
  const fetch = guardedFetch({
    maxResponseBytes: MAX_RESPONSE_BYTES,
    timeoutMs: config.timeoutMs,
    calls: createSlots(MAX_CALLS),
    ...(opts.allowInsecureLocal === true ? { allowInsecureLocal: true } : {}),
  });

  /** One attempt at one channel: the answers, or why there are none. */
  async function attempt(
    channel: { url: string; apiKeyEnv: string },
    body: string,
    questions: readonly Question[],
    signal?: AbortSignal,
  ): Promise<Map<string, Answer> | JudgeFailure> {
    // The key is read now, as a site model's is, and never kept.
    const key = env[channel.apiKeyEnv];
    if (key === undefined || key === "") return "key_unset";
    const bound = AbortSignal.timeout(config.timeoutMs);
    try {
      const res = await fetch(channel.url, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json; charset=utf-8" },
        body,
        signal: signal ? AbortSignal.any([signal, bound]) : bound,
      });
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => {});
        return keyRefused(res.status) ? "auth" : "status";
      }
      return parse(await res.text(), questions) ?? "shape";
    } catch (err) {
      // This attempt's time, or the guard's wait for progress, ran out; or the guard's size cap, or no place among its calls; or anything else.
      if (bound.aborted || (err instanceof GuardGaveUp && err.gaveUp === "stalled")) return "timeout";
      if (err instanceof GuardGaveUp) return err.gaveUp === "busy" ? "busy" : "oversize";
      return "network";
    }
  }

  return {
    async ask(state, questions, signal) {
      signal?.throwIfAborted();
      // What can be sent, each key once (the first question asked under it).
      const keys = new Set<string>();
      const sendable = questions.filter((q) => {
        if (!askable(q) || keys.has(q.key)) return false;
        keys.add(q.key);
        return true;
      });
      if (sendable.length === 0) return new Map();
      const body = bodyOf(config.model, state, sendable);
      let failure: JudgeFailure = "network";
      let sent = false;
      let busy = false;
      for (const channel of config.channels) {
        const answers = await attempt(channel, body, sendable, signal);
        // The caller gave up: that is its abort, not a channel's failure, and no other channel is tried.
        signal?.throwIfAborted();
        if (typeof answers !== "string") return answers;
        failure = answers;
        if (answers === "busy") busy = true;
        else if (answers !== "key_unset") sent = true;
      }
      throw new JudgeError(failure, sent, busy);
    },
  };
}
