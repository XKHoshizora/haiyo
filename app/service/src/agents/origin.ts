/**
 * A zero-call run made from a message, its origin (`agent_runs.origin_seq`; T2 fix 2, R1): a reply nobody asked for (its seed, the
 * message it was decided on: agents/proactive/decide.ts; runs.ts `queueRun` states it for every lane `proactive` row), or its owner's
 * 重试 of one (runs.ts `retryRun`, which copies it). STATED on the row as it is made, never inferred from its shape: a call reply with
 * every call refused is no origin run (and is never queued: runs.ts `scheduleAutoRetry`, `retryRun`). It answers no call: nothing is
 * refused for its origin (`begin` holds no call of it to the access decision, its post none), its system text is an unasked reply's
 * (no line about calls, no instruction to answer whoever wrote @ it), its post quotes nothing, and its context shows the origin as a
 * call's message is shown (context.ts `callsSeen`). `r`: an `agent_runs` alias.
 */
export const originOnlySql = (r: string): string => `(${r}.origin_seq is not null)`;

/** `originOnlySql` of a run as it is read (`origin_seq`). */
export const originOnly = (run: { origin_seq: string | number | null }): boolean => run.origin_seq !== null;
