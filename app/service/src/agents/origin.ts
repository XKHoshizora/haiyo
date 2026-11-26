/**
 * A zero-call run whose origin is what it covers (`covers_seq`; T2 fix 1, F10): a reply nobody asked for (its seed, the message it was
 * decided on: agents/proactive/decide.ts), or its owner's 重试 of one (runs.ts `retryRun`) — not a told reply (its whisper is its origin) nor a
 * greeting. It answers no call: nothing is refused for its origin (`begin` holds no call of it to the access decision, its post none),
 * no line names calls, and its context shows the origin as a call's message is shown (context.ts `callsSeen`). `r`: an `agent_runs`
 * alias.
 */
export const originOnlySql = (r: string): string => `(cardinality(coalesce(${r}.call_seqs, array[${r}.covers_seq])) = 0 and ${r}.whisper_id is null and not ${r}.greets)`;

/** `originOnlySql` of a run as `begin` reads it. */
export const originOnly = (run: { call_seqs: readonly unknown[] | null; told: boolean; greets: boolean }): boolean =>
  run.call_seqs !== null && run.call_seqs.length === 0 && !run.told && !run.greets;
